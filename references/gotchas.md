# Gotchas and Pitfalls

Hard-won lessons from production SOW bookmarklets. Read this before building
anything -- each item here has caused real bugs.

## API Gotchas

### Always use `sysparm_display_value=all`

Without this, reference fields return raw sys_ids (32-char hex) instead of
human-readable names. The `all` mode returns both:

```javascript
// WITHOUT sysparm_display_value=all:
{ "assignment_group": "abc123def456..." }

// WITH sysparm_display_value=all:
{ "assignment_group": {
    "value": "abc123def456...",
    "display_value": "Service Desk Team"
  }
}
```

Every query in this skill uses it. Never omit it.

### Always include `credentials: 'include'`

Without this, the browser does not send the session cookie and every request
returns 401. This applies to `fetch()`. For `XMLHttpRequest`, set
`xhr.withCredentials = true`.

```javascript
// WRONG -- will 401
fetch('/api/now/table/incident', { headers: { ... } });

// RIGHT
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

### IMS uses `opened_for`, not `caller_id`

The `interaction` (IMS) table stores the caller in `opened_for`.
The `incident` table stores it in `caller_id`. Every other table uses
`caller_id`. If you hardcode `caller_id`, IMS lookups silently return nothing.

```javascript
var callerField = (table === 'interaction') ? 'opened_for' : 'caller_id';
```

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

SOW issues approximately 4 Table API calls every time the user switches tabs
(against `sys_user`, `incident`, `sc_req_item`, `sc_task`). These count
against the same 100/hour cap your tools use. Always reserve headroom
(at least 10 requests) and never assume all 100 are yours.

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

Very large bookmarklets (>100KB encoded) may hit browser URI length limits.
Chrome's is ~2MB, but Firefox and Edge are lower. For large tools, use the
base64 approach (see SKILL.md) or split into multiple bookmarklets.

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
If you hook `fetch()`, consider stubbing it with an empty 200 response.

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
