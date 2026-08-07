# Genesys Cloud Softphone Integration

SOW integrates Genesys Cloud (PureCloud) telephony via an embedded iframe. The
iframe communicates with the host page using `window.postMessage`. The message
type is `softphone_connector`.

## Hooking Into Genesys Messages

The messages are not visible on the host `window`. Listen on the softphone
**iframe's own `contentWindow`**, in the capture phase. The iframe is
`iframe#iframe`, nested inside shadow DOM, and it mounts late — so walk shadow
roots to find it and re-scan until it appears:

```javascript
function findFrame(root, depth) {
    if (!root || (depth || 0) > 30) return null;
    try {
        var direct = root.querySelector && root.querySelector('iframe#iframe');
        if (direct) return direct;
        var els = root.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) {
            if (els[i].shadowRoot) {
                var f = findFrame(els[i].shadowRoot, (depth || 0) + 1);
                if (f) return f;
            }
        }
    } catch (e) {}
    return null;
}

function hookGenesys(onMessage) {
    var hooked = new WeakSet();

    function handler(ev) {
        var data = ev.data;
        if (!data || data.type !== 'softphone_connector') return;
        var msg = data.msg;
        if (!msg) return;
        onMessage(msg, data);
    }

    function attach() {
        var frame = findFrame(document, 0);
        if (!frame) return false;
        var win;
        try { win = frame.contentWindow; } catch (e) { return false; }
        if (!win || hooked.has(win)) return true;
        hooked.add(win);
        win.addEventListener('message', handler, true);   // capture phase
        return true;
    }

    attach();
    // The iframe can be replaced on navigation, so keep checking.
    var scanInterval = setInterval(attach, 2000);

    return function unhook() { clearInterval(scanInterval); };
}
```

Note what this does **not** do: there is no `event.origin` check. Any frame that
can reach this window could post a matching `softphone_connector` envelope. That is
acceptable for read-only display (a call timer), but do not drive writes, record
lookups, or anything destructive from these messages without validating the origin
yourself:

```javascript
if (ev.origin !== 'https://apps.mypurecloud.com') return;   // adjust per region
```

## Message Types

### Status Changes

```javascript
// msg.type === 'UserAction' && msg.category === 'status'
{
    type: 'UserAction',
    category: 'status',
    data: {
        status: 'ON_QUEUE',     // see full list below
        sub_status: 'Tea Break' // optional sub-status text
    }
}
```

Observed status values: `ON_QUEUE`, `AVAILABLE`, `BREAK`, `MEAL`, `TRAINING`,
`MEETING`, `BUSY`, `AWAY`, `OFF_QUEUE`, `OUT_OF_OFFICE`. Sub-status strings are
configured per org, so treat them as display text rather than switching on them.

### Routing Status

```javascript
// msg.type === 'UserAction' && msg.category === 'routingStatus'
{
    type: 'UserAction',
    category: 'routingStatus',
    data: 'IDLE'  // or 'OFF_QUEUE'
}
```

`routingStatus` is not a status in its own right — it reports whether the agent is
available for routing. `IDLE` here means "on queue, waiting for a call", so map it
onto `ON_QUEUE` rather than showing the user "Idle". Only let `OFF_QUEUE` set the
displayed status when no real status has arrived yet, or it will overwrite a more
specific value like `MEAL`.

### Call Lifecycle

All call events use `msg.type === 'Interaction'` with different categories:

```javascript
// INCOMING CALL (alerting)
// msg.category === 'add', msg.data.state === 'ALERTING'
{
    type: 'Interaction',
    category: 'add',
    data: {
        state: 'ALERTING',
        id: 'conversation-uuid',
        displayAddress: '+61312345678',
        ani: '+61312345678',
        name: 'Caller Name',
        queueName: 'Service Desk',
        direction: 'inbound',
        calledNumber: '+61398765432',
        totalIvrDurationSeconds: 45
    }
}

// CALL CONNECTED
// msg.category === 'connect' or 'change', data.isConnected === true
{
    type: 'Interaction',
    category: 'connect',
    data: {
        new: {
            state: 'CONNECTED',
            isConnected: true,
            id: 'conversation-uuid',
            connectedTime: '2025-01-15T09:30:00.000Z',
            displayAddress: '+61312345678',
            queueName: 'Service Desk',
            direction: 'inbound',
            totalIvrDurationSeconds: 45
        }
    }
}

// CALL DISCONNECTED (entering wrap-up)
// msg.category === 'disconnect'
//   OR (msg.category === 'change' && data.isDisconnected && !data.isDone)
// ...and data.state === 'DISCONNECTED'
//
// The !isDone guard matters: the 'change' event that completes after-call work
// also reports DISCONNECTED, and without it wrap-up restarts instead of ending.
{
    type: 'Interaction',
    category: 'disconnect',
    data: {
        new: {
            state: 'DISCONNECTED',
            isDisconnected: true,
            id: 'conversation-uuid',
            endTime: '2025-01-15T09:35:00.000Z',
            interactionDurationSeconds: 300,
            totalAcdDurationSeconds: 250,
            totalIvrDurationSeconds: 45
        }
    }
}

// WRAP-UP COMPLETE (after care work done)
// msg.category === 'acw', data.isDone === true
{
    type: 'Interaction',
    category: 'acw',
    data: {
        new: {
            isDone: true,
            dispositionDurationSeconds: 45
        }
    }
}
```

## Building a Call Timer

Track the call phase state machine:

```
hooking -> hooked -> idle -> alerting -> oncall -> wrapup -> idle
```

The two bootstrap phases are worth keeping. Until the iframe is found you cannot
know the agent's state, and showing `idle` in the meantime tells the user
something false. Start in `hooking`, move to `hooked` once the listener attaches,
and only fall through to `idle` after a short grace period (~2s) with no
messages.

```javascript
var phase = { current: 'hooking', anchor: null, callId: null };
var timerEl = document.getElementById('my-genesys-timer');

function handleGenesysMsg(msg) {
    if (msg.type === 'UserAction' && msg.category === 'status') {
        updateStatusDisplay(msg.data.status, msg.data.sub_status);
        return;
    }
    if (msg.type !== 'Interaction') return;

    // Change events wrap the record in `new`; add/connect events do not.
    var d = (msg.data && msg.data.new) ? msg.data.new : msg.data;
    if (!d) return;

    var cat = msg.category;

    if (cat === 'add' && d.state === 'ALERTING') {
        phase.current = 'alerting';
        phase.callId = d.id;
        phase.anchor = Date.now();
    }
    // Check ACW completion before the disconnect branch: the message that ends
    // after-call work also carries state 'DISCONNECTED', so testing disconnect
    // first restarts the wrap-up timer instead of clearing it.
    else if (cat === 'acw' && d.isDone) {
        recordCallStats(phase, d);
        phase.current = 'idle';
        phase.anchor = Date.now();
        phase.callId = null;
    }
    else if ((cat === 'connect' || cat === 'change') &&
             d.isConnected && d.state === 'CONNECTED') {
        phase.current = 'oncall';
        phase.anchor = d.connectedTime
            ? new Date(d.connectedTime).getTime() : Date.now();
    }
    else if ((cat === 'disconnect' ||
             (cat === 'change' && d.isDisconnected && !d.isDone)) &&
             d.state === 'DISCONNECTED') {
        phase.current = 'wrapup';
        phase.anchor = d.endTime
            ? new Date(d.endTime).getTime() : Date.now();
    }

    renderTimer();
}

function renderTimer() {
    if (!timerEl) return;
    if (phase.current === 'idle' || !phase.anchor) {
        timerEl.textContent = '';
        return;
    }
    var elapsed = Math.max(0, (Date.now() - phase.anchor) / 1000);
    var mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    var ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    timerEl.textContent = mm + ':' + ss;
}

// The anchor comes from server timestamps, so tick locally to keep it moving.
var tick = setInterval(renderTimer, 1000);
```

Anchoring on `connectedTime` / `endTime` rather than the message arrival time
keeps the elapsed figure correct even if a message is delayed or your tool starts
mid-call. Clamp with `Math.max(0, ...)` because clock skew between the browser and
Genesys can otherwise briefly produce a negative duration.

Mount the widget in `.polaris-header-controls` (see `dom-structure.md`), falling
back to a fixed-position element if the header slot is not found. Keep call
history on your namespace (`tk.genesys.history`) with a cap, so re-running the
bookmarklet does not lose the day's calls.
