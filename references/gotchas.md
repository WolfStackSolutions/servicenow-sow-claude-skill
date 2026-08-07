# Gotchas and Pitfalls

Hard-won lessons from production SOW bookmarklets. Read this before building
anything -- each item here has caused real bugs.

## API Gotchas

### Always use `sysparm_display_value=all`

Without `=all`, you do **not** get a reliable human-readable name on reference
fields. The exact shape varies by instance:

```javascript
// WITHOUT sysparm_display_value=all — either of these is common:
{ "assignment_group": "abc123def456..." }                    // raw sys_id string
{ "assignment_group": { "link": "https://…/sys_user_group/…",
                        "value": "abc123def456..." } }       // link object, no name

// WITH sysparm_display_value=all:
{ "assignment_group": {
    "value": "abc123def456...",
    "display_value": "Service Desk Team"
  }
}
```

Always pass `=all` and read names via `dv()`. Never assume a bare string without
it — some instances already return objects (with `.link`) as the default.

### Always include `credentials: 'include'`

Set it explicitly on every `fetch()`. Modern browsers default `credentials` to
`'same-origin'`, so a same-host call may still send cookies if you omit the
option — but cross-origin frames, workers, and older assumptions still 401.
For `XMLHttpRequest`, set `xhr.withCredentials = true`.

```javascript
// Fragile — relies on the browser default for same-origin cookies
fetch('/api/now/table/incident', { headers: { ... } });

// RIGHT — always be explicit
fetch('/api/now/table/incident', { credentials: 'include', headers: { ... } });
```

### Reference fields are objects, not strings

When `sysparm_display_value=all` is set, reference fields come back as objects.
Always use the `dv()` and `rv()` helpers (see api.md), never access fields raw:

```javascript
// WRONG -- may return "[object Object]" or crash
var group = record.assignment_group;

// RIGHT
var groupName = dv(record.assignment_group);  // "Service Desk Team"
var groupId = rv(record.assignment_group);     // "abc123def456..."
```

### The caller field is different on every table

There is no field that works everywhere. `caller_id` only exists on `incident`
and its descendants. Hardcoding it makes lookups return nothing at all on
catalog and interaction records, with no error to tell you why.

```javascript
var CALLER_FIELDS = {
    interaction:    'opened_for',      // IMS customer
    incident:       'caller_id',
    sc_req_item:    'requested_for',   // RITM beneficiary
    sc_request:     'requested_for',
    sc_task:        'opened_by',       // SCTASK has no caller field at all
    change_request: 'requested_by'
};

function callerField(table) {
    return CALLER_FIELDS[table] || 'caller_id';
}
```

Two further traps:

- **`sc_task` genuinely has no caller.** Resolve the person through the parent
  RITM (`request_item`), or accept `opened_by` as an approximation. Which you
  want depends on whether you need "who benefits" or "who raised it".
- **The primary field is often empty** on records raised on someone's behalf.
  Always keep `opened_by` as a fallback:

```javascript
var personSysId = rv(rec[callerField(table)]) || rv(rec.opened_by);
```

### `sc_req_item` shows RITM numbers, `sc_request` shows REQ

These are different tables and it is easy to mislabel them. A `RITM…` number
lives on `sc_req_item`; a `REQ…` number lives on `sc_request`. If you label
`sc_req_item` as "REQ" in a UI, users will look for a REQ record that does not
match what you queried. Associate to `sc_request` when linking a whole request,
and to `sc_req_item` when acting on one line item.

### sys_journal_field may be silently blocked

Some instances ACL-block `sys_journal_field` at the row level. The API returns
HTTP 200 with zero rows instead of 403, making it look like there are no
comments when there really are. Always implement the inline comment parsing
fallback (see comments.md).

### Some tables return 403 to normal accounts

Tables like `sys_dictionary`, `sys_audit`, `cmn_cost_center`, and many
`x_*` scoped tables are read-blocked for non-admin accounts. Always handle
403 gracefully -- do not assume every table is readable.

### Rate limit headers are unreliable

The `x-ratelimit-*` headers appear inconsistently. Two identical requests one
second apart may or may not include them. Never use header presence as a test
for whether a request counted against the limit. Track your own budget
client-side (see api.md).

### The workspace itself consumes your rate limit

SOW issues its own Table API calls every time the user switches tabs (against
`sys_user`, `incident`, `sc_req_item`, `sc_task`) — observed at roughly 4 per
switch, though this is a field observation rather than a documented constant.
They count against the same cap your tools use. Reserve headroom (at least 10
requests) and never assume all 100 are yours.

Do **not** solve this by counting every Table API call on the page. You cannot
control the workspace's traffic, and charging it to your budget makes your tools
stop working during normal navigation. Charge your own calls, plus anything the
server explicitly flags with `x-ratelimit-*` headers or a 429.

### Batch journal and detail reads, or you will trigger 429s

Fanning out one request per tracked ticket looks fine with 5 tickets and takes
down the whole tool at 200. Cap the work per cycle and stop early on the first
429 instead of letting the remaining batches pile on:

```javascript
var MAX_READS = 12;                       // per poll cycle
var BATCH = 4;                            // concurrent within a cycle
var queue = tickets.slice(0, MAX_READS);

function runBatch() {
    if (!queue.length) return Promise.resolve();
    var slice = queue.splice(0, BATCH);
    return Promise.all(slice.map(readOne)).then(function(results) {
        // A 429 anywhere means stop; retry next cycle with backoff.
        if (results.some(function(r) { return r && r.status === 429; })) return;
        return runBatch();
    });
}
```

Anything that could not be read this cycle should be re-queued, not dropped —
otherwise those tickets stay silent forever.

### Serialise multi-table polls with small gaps

Firing all table queries in one `Promise.all` burst is the fastest way to hit a
rate-limit rule. Space them 40-150ms apart. The extra latency is invisible to
users; the 429 is not.

### User records may have leading whitespace

Identity sync feeds (e.g. from directory connectors) can insert leading
spaces in fields like `last_name`. A query for `last_name=Smith` will miss
` Smith` (with a leading space). Trim inputs and consider using `LIKE`
queries for name lookups.

### Dates in queries can be timezone-biased

Raw date strings like `sys_updated_on>=2025-01-15 00:00:00` are interpreted
in the instance's configured timezone, which may not match the user's local
time. Use ServiceNow's relative date functions for timezone-safe queries:

```javascript
// Timezone-safe: "in the last 30 days"
'sys_created_on>=javascript:gs.daysAgoStart(30)'

// Also safe: "today"
'sys_created_on>=javascript:gs.beginningOfToday()'
```

## DOM / Injection Gotchas

### CSP blocks external scripts and fetches

SOW's Content Security Policy blocks `<script src="...">` from external
domains and `fetch()` to external origins. Your entire tool must be inlined
in the bookmarklet. You cannot host your code on a CDN or external server
and load it at runtime.

### Events do not bubble out of Shadow DOM

A click inside a shadow root does NOT bubble to `document`. You must attach
event listeners inside each shadow root separately:

```javascript
// WRONG -- misses clicks inside shadow roots
document.addEventListener('click', handler);

// RIGHT -- attach to each shadow root
function attachToShadows(root) {
    root.addEventListener('click', handler, true);
    root.querySelectorAll('*').forEach(function(el) {
        if (el.shadowRoot) attachToShadows(el.shadowRoot);
    });
}
attachToShadows(document);
```

Use `{ capture: true }` (the `true` argument) to catch events in the capture
phase before they can be stopped.

### `DOMContentLoaded` and `load` are useless

SOW is an SPA. These events fire once on initial page load and never again.
Tab switches, record opens, and navigations are all handled client-side.
Use MutationObservers and polling.

### now-alert elements steal focus

ServiceNow's notification banners (`<now-alert>`) steal keyboard focus from
text inputs when they appear. If your tool has input fields, you need to
either block `now-alert` insertion entirely (see injection.md) or refocus
your input after the alert appears.

### Shadow roots appear lazily

Components mount their shadow roots asynchronously as the user navigates.
A shadow root that does not exist on page load may appear seconds later when
the user opens a ticket. Always use periodic re-scanning (every 2-3 seconds)
alongside MutationObservers.

### `getTabRoot()` may return null

The tab strip component mounts after the initial page load. On first run,
`getTabRoot()` will return null. Always poll until it becomes available:

```javascript
var pollForTabs = setInterval(function() {
    var root = getTabRoot();
    if (root) {
        clearInterval(pollForTabs);
        // Now safe to interact with tabs
        initTabFeature(root);
    }
}, 1000);
```

### Injected elements can be destroyed

SOW's framework occasionally tears down and rebuilds sections of the DOM.
Injected elements may vanish. Use a MutationObserver on `document.body` to
detect when your elements are removed, and re-inject:

```javascript
var reinjObs = new MutationObserver(function() {
    if (!myElement.isConnected) {
        setTimeout(function() { mount(); }, 120);
    }
});
reinjObs.observe(document.body, { childList: true, subtree: true });
```

### The framework rewrites component configs

SOW may rewrite `tabConfig` and `mainConfig` on its components at any time
(e.g. after a framework update push). If you patch these objects (for tab
limits or cache pool size), reassert your patches on a timer:

```javascript
setInterval(function() {
    if (!myPatchApplied()) reapplyPatch();
}, 3000);
```

## Storage Gotchas

### localStorage may be blocked

Some SOW environments block `localStorage` entirely. Any `localStorage` call
will throw. Always wrap in try/catch:

```javascript
function lsGet(key, defaultValue) {
    try { return JSON.parse(localStorage.getItem(key)) || defaultValue; }
    catch(e) { return defaultValue; }
}
```

For durable settings, use the File System Access API pattern (see settings.md).

### IndexedDB may also be blocked

In the most restrictive environments, both `localStorage` and `IndexedDB`
are blocked. Fall back to in-memory state that survives only for the current
session. The tool should still work -- it just won't remember settings across
page reloads.

## Bookmarklet Gotchas

### URI length limits

Chrome's bookmarklet limit is generous — a ~490KB tool encodes to roughly 940KB
of `javascript:` URI and still works. Firefox and Edge are lower, so treat large
payloads as Chrome-only unless you have tested elsewhere.

Size is not the reason to reach for base64. Use it when a giant string literal
would make the installer page unmaintainable, not at any particular byte count.
See `installer-template.md` for measured sizes of real tools.

### `javascript:` URI encoding

The entire function body must be URI-encoded. Use `encodeURIComponent()`,
not `encodeURI()` -- the latter does not encode characters like `#` and `&`
that will break the URI.

### Strict mode

Always use `'use strict';` at the top of your bookmarklet code. Without it,
accidental global variable creation can collide with SOW's own globals.

## Performance Gotchas

### The `agentic_processing` endpoint

Some instances have an endpoint called `agentic_processing` that 400-errors
every ~6 seconds in the background. This is harmless but noisy in the console.
If you hook `fetch()`, you can stub it with an empty 200 response.

Treat this as opt-in, not a default. Faking a 200 for a real platform call hides
genuine failures, so scope the stub to one tool that the user can turn off, keep
a reference to the original `fetch`, and restore it on teardown:

```javascript
var origFetch = window.fetch;
window.fetch = function() { /* stub agentic_processing only */ };
return function cleanup() { window.fetch = origFetch; };
```

### Never render ticket data with `innerHTML` unescaped

Short descriptions, comments, user names and API error messages are all
attacker-influenced. Building HTML from them directly is an injection bug in a
tool that runs with the user's full session.

Use `textContent` for plain strings, and escape before any `innerHTML`:

```javascript
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

row.innerHTML = '<span class="num">' + esc(t.number) + '</span>' +
                '<span class="desc">' + esc(t.short_description) + '</span>';
```

### Confirm before any write

A bookmarklet runs with the user's full permissions and bulk tools can touch
hundreds of records. Gate every PATCH, `order_now`, or association behind an
explicit confirmation, and for bulk actions make the user type the affected count
before the button arms. There is no undo.

### Deep shadow DOM walks are expensive

`querySelectorAll('*')` across 10,000+ DOM nodes with 200+ shadow roots
takes measurable time. For hot-path functions called every 2-3 seconds,
use the `walkAll()` pattern (firstElementChild/nextElementSibling traversal)
instead of querySelectorAll. See injection.md.

### Avoid polling hidden tabs

Check `document.hidden` before making API calls in your polling loop.
Background tabs should not consume rate limit budget:

```javascript
setInterval(function() {
    if (document.hidden) return;
    poll();
}, intervalMs);
```
