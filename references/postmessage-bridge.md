# Cross-Origin postMessage Bridge

Sometimes the data you need is not in ServiceNow at all — it lives in another web
app the agent has open (a telephony dashboard, a reporting tool) and has no
usable API, or no API you are allowed to call. If the user is already
authenticated in that tab, a bookmarklet can read what is rendered there and push
it into SOW over `window.postMessage`.

This is browser-local: two tabs, one user, no server, no shared credentials, and
nothing persisted on the source side. It reads only what is already on screen —
no forged requests, no borrowed tokens.

## Shape

Two bookmarklets, one per origin:

- **Source side** reads the rendered DOM, keeps the tab alive, and posts snapshots.
- **SOW side** listens, acknowledges, and merges snapshots into its UI.

Tag every message so unrelated `postMessage` traffic on the page is ignored:

```javascript
var MSG_TAG  = 'MY_BRIDGE_V1';
var WIN_NAME = 'sow_monitor';
```

| kind | direction | payload |
|------|-----------|---------|
| `hello` | source → SOW | `{ tag, kind, from, ts }` |
| `ack` | SOW → source | `{ tag, kind, from, ts }` |
| `snapshot` | source → SOW | `{ tag, kind, rows, stale, ageMs, ts }` |

## Linking the tabs

`window.open` with a **name** both opens the SOW tab and gives you a reusable
handle. The handle goes stale after the target navigates or redirects, so re-grab
it by name rather than caching it:

```javascript
function grabSowWin() {
    // Opening with an empty URL returns the existing window with this name
    // without navigating it.
    var w = window.open('', WIN_NAME);
    return (w && !w.closed) ? w : null;
}

function link(url) {
    var w = window.open(url, WIN_NAME);
    handshake();
    return w;
}
```

## Handshake

The two bookmarklets are clicked in an arbitrary order, so neither side can assume
the other is listening yet. Retry the hello on a timer with a bounded attempt
count, and have the SOW side announce itself to `window.opener` as well:

```javascript
// Source side
var linked = false, tries = 0;

function handshake() {
    var w = grabSowWin();
    if (!w) return;
    w.postMessage({ tag: MSG_TAG, kind: 'hello', from: 'source', ts: Date.now() }, '*');
}

var linkTimer = setInterval(function() {
    if (linked || ++tries > 15) return clearInterval(linkTimer);
    handshake();
}, 2000);

window.addEventListener('message', function(ev) {
    var d = ev.data;
    if (!d || d.tag !== MSG_TAG) return;
    if (d.kind === 'ack') { linked = true; pushNow(); }
});
```

```javascript
// SOW side
window.addEventListener('message', function(ev) {
    var d = ev.data;
    if (!d || d.tag !== MSG_TAG) return;

    if (d.kind === 'hello') {
        (ev.source || window.opener || window).postMessage(
            { tag: MSG_TAG, kind: 'ack', from: 'sow', ts: Date.now() }, '*');
    } else if (d.kind === 'snapshot' && Array.isArray(d.rows)) {
        mergeSnapshot(d);
    }
});

// If SOW was opened by the source tab, announce readiness unprompted.
if (window.opener) {
    var n = 0;
    var ackTimer = setInterval(function() {
        if (++n > 10) return clearInterval(ackTimer);
        window.opener.postMessage(
            { tag: MSG_TAG, kind: 'ack', from: 'sow', ts: Date.now() }, '*');
    }, 1500);
}
```

## Origin validation

The examples above post to `'*'` and filter only on the tag string. That is the
simplest thing that works, and it is acceptable when the payload is display-only
data flowing into a read-only panel.

It is not acceptable if the receiving side acts on the message. `'*'` means any
frame that can reach the window may send a matching envelope, and a tag string is
not a security boundary. Once a message can trigger a write, a record lookup, or
navigation, pin both ends:

```javascript
var SOURCE_ORIGIN = 'https://dashboard.example.com';
var SOW_ORIGIN    = 'https://myinstance.service-now.com';

// Sending
w.postMessage(payload, SOW_ORIGIN);

// Receiving
window.addEventListener('message', function(ev) {
    if (ev.origin !== SOURCE_ORIGIN) return;
    // ...
});
```

## Staleness

A bridge that stops updating looks identical to one reporting "nothing has
changed". Send the age of the data you read and let the receiver decide:

```javascript
w.postMessage({
    tag: MSG_TAG, kind: 'snapshot', from: 'source', ts: Date.now(),
    rows: rows,
    ageMs: Date.now() - lastRenderedAt,
    stale: (Date.now() - lastRenderedAt) > 60000
}, SOW_ORIGIN);
```

On the SOW side, show the snapshot age and mark the panel stale if no snapshot
arrives within a couple of expected intervals. Silent staleness is the main way
this pattern misleads people.

## Keeping the source tab alive

The source tab is usually backgrounded, where browsers throttle timers and many
apps stop refreshing. See the visibility-spoofing and anti-throttle section in
`injection.md`. Apply it to the **source** tab only — never to SOW.

## Teardown

Both sides need a reachable stop, since a re-run otherwise leaves the previous
bridge posting alongside the new one:

```javascript
window.__myBridge = {
    __alive: true,
    stop: function() {
        clearInterval(linkTimer);
        clearInterval(pushTimer);
        window.removeEventListener('message', onMessage);
        if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
        this.__alive = false;
    }
};
```

Guard re-entry on `window.__myBridge && window.__myBridge.__alive` and toggle the
panel instead of starting a second instance.
