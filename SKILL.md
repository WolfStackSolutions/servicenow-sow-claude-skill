---
name: servicenow-sow-bookmarklet
description: >
  Build ServiceNow SOW bookmarklets and injected browser tools. Use for SOW/SWP
  portal tools, g_ck, X-UserToken, Table API, shadow DOM injection, AMB watchers,
  or Genesys softphone hooks.
license: MIT
---

# ServiceNow SOW Bookmarklet Skill

Build browser-side tools that inject into ServiceNow's Service Operations Workspace.
Everything here was reverse-engineered from production SOW instances and verified
against working tools running on a live instance.

Specific values — macroponent ids, state codes, ticket prefixes, rate limits,
Genesys status names — come from observed instances and are configurable per org.
Prefer the discovery patterns each reference describes over the literal values, and
verify constants before relying on them.

## File map

Load these on demand. Do not read them all up front.

| File | Read it when |
|------|--------------|
| `references/api.md` | Any HTTP call: auth and `getToken()`, Table API read/PATCH, pagination, Stats (aggregate) and Presence APIs, Service Catalog order_now, Attachment upload, ticket/caller resolution, rate-limit budget tracker |
| `references/gotchas.md` | Before writing any code. Non-obvious traps grouped by API, DOM, storage, bookmarklet, and performance |
| `references/dom-structure.md` | Locating an injection target in SOW's component tree |
| `references/injection.md` | Shadow DOM traversal, MutationObservers, click handling across shadow roots, fetch interception, background-tab throttling, tool lifecycle and cleanup |
| `references/ui-patterns.md` | Building a panel, FAB, toast stack, modal, header widget, or draggable surface; escaping and z-index layering |
| `references/comments.md` | Journal parsing (inline primary, `sys_journal_field` where ACLs allow), dedup, snapshot-diff change detection, closed state codes, interaction linking |
| `references/polling-scheduler.md` | Anything that watches records over time: lanes, high-water marks, jitter, backoff, hidden tabs, AMB coalescing |
| `references/amb.md` | Real-time push via `g_ambClient` record watchers, notification interception |
| `references/postmessage-bridge.md` | Pulling data from another origin's tab into SOW over `postMessage` |
| `references/genesys.md` | Softphone postMessage schema, call lifecycle, call timers |
| `references/settings.md` | Persisting settings where localStorage is blocked (File System Access API plus IndexedDB handle cache) |
| `references/installer-template.md` | Producing the deliverable HTML installer page |
| `examples/minimal-injector.js` | Smallest viable tool: re-entry guard, namespace, draggable panel |
| `examples/table-query.js` | Smallest viable authenticated Table API query |
| `examples/mutation-watcher.js` | Shadow DOM auto-discovery with periodic re-scan and cleanup |
| `examples/menu-system.js` | Multi-tool toolkit: categorised toggle menu, on/off lifecycle, in-session toggle state (see `settings.md` for durable persistence) |


## Architecture: Bookmarklet + HTML Loader

Always deliver as a bookmarklet with a hosted HTML installer page. SOW's CSP blocks
external script loading, so the entire tool must be inlined. Do not propose a browser
extension or an external `<script src>` loader unless the user explicitly asks for one.

SOW bookmarklets use a two-stage delivery model:

1. **Installer page** -- a standalone HTML file the user opens in a browser.
   It contains a draggable `<a>` element whose `href` is a `javascript:void(...)`
   URI containing the entire tool payload. The user drags this to their bookmarks bar.

2. **Bookmarklet payload** -- the `javascript:` URI. Since SOW blocks external
   script loading via CSP, the entire tool must be inlined. The installer page
   wraps a function body, URI-encodes it, and sets it as the link href:

```javascript
// In the installer page <script>:
var toolkitCode = function() {
    'use strict';
    // ... entire tool code here ...
};
var code = toolkitCode.toString();
var body = code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'));
var href = 'javascript:void((function(){' + encodeURIComponent(body) + '})())';
document.getElementById('install-link').href = href;
```

There is no size at which you must switch to base64 — a ~490KB tool works in
Chrome with plain `encodeURIComponent`. Choose based on how the installer is
maintained, and see `references/installer-template.md` for both templates with
measured sizes.

### Re-entry guard and namespace

Bookmarklets get clicked twice. Every tool needs a re-entry guard that toggles
instead of re-initialising, and a namespaced window object so state and cleanup
functions survive a re-run:

```javascript
var existing = document.getElementById('my-tool-panel');
if (existing) {
    existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
    return;
}
if (!window._myToolkit) window._myToolkit = {};
var tk = window._myToolkit;
```

Full lifecycle and cleanup patterns are in `references/injection.md`;
`examples/minimal-injector.js` is the smallest complete version.

## Authentication: CSRF Tokens

Every API call needs the CSRF token in the `X-UserToken` header, plus the session
cookie via `credentials: 'include'`. On a normal SOW page `window.g_ck` is
usually enough, with fallbacks through `NOW.g_ck`, `window.top.g_ck`,
`NOW.csrf_token`, and a `meta[name="X-UserToken"]` tag.

`references/api.md` has the full `getToken()` implementation, the request header
defaults, and the token-rotation retry that long-running pollers need.

## API Reference

See `references/api.md` for full details. Summary of available APIs:

| API | Method | Endpoint | Purpose |
|-----|--------|----------|---------|
| Table API (read) | GET | `/api/now/table/{table}` | Query any table |
| Table API (update) | PATCH | `/api/now/table/{table}/{sys_id}` | Update a record |
| Stats API | GET | `/api/now/stats/{table}` | Grouped counts without fetching rows |
| Attachment API | POST | `/api/now/attachment/file` | Upload file attachments |
| Service Catalog | POST | `/api/sn_sc/servicecatalog/items/{item_id}/order_now` | Order a catalog item |
| Current User | GET | `/api/now/ui/user/current_user` | Logged-in user (sys_id is `user_sys_id`) |
| Presence | GET | `/api/now/ui/presence` | Who is currently online |
| Interaction link | POST | `/api/now/table/interaction_related_record` | Associate a ticket with an IMS |

All requests need `credentials: 'include'` (or `withCredentials = true` for XHR)
and the `X-UserToken` header.

Non-obvious response shapes, both of which fail silently:

- `current_user` returns the sys_id as **`user_sys_id`**, not `sys_id`.
- `order_now` returns the request sys_id as **`result.sys_id`**, not `request_id`.

## Rate Limiting

ServiceNow instances typically enforce rate limits on the Table API:

- **100 requests per user per hour**, reset on the clock hour
- No `x-ratelimit-remaining` header (must be tracked client-side)
- Headers returned when a call counts: `x-ratelimit-limit`, `x-ratelimit-reset`,
  `x-ratelimit-rule`. Absence does not reliably mean the call was free
- A 429 response includes a `retry-after` header — honour it
- The workspace issues its own Table API calls on every tab switch, so never
  assume the full 100 are yours

**Always implement client-side budget tracking**, shared across tools on the page.
See `references/api.md`. Charge your own calls plus anything the server flags;
counting every Table API call on the page instead means the workspace's own
traffic exhausts your budget.

## DOM Injection

See `references/dom-structure.md` for SOW's component tree and injection targets.
See `references/injection.md` for MutationObserver and Shadow DOM patterns.

Key principles:
- SOW is a single-page app. `DOMContentLoaded` fires once, ever. Use MutationObservers.
- SOW uses nested web components with Shadow DOM. You must walk shadow roots.
- Register click handlers in the **capture phase** on each shadow root; events
  retargeted at the host will not reach a bubbling listener intact.
- Use `composedPath()` for click-outside checks, not `contains(e.target)`.
- Discover injection targets by selector or tag name. Hardcoded macroponent ids
  are instance-specific and are the main reason a tool works on one instance and
  does nothing on another.
- Every tool needs a cleanup function. Return it from `on()` and call it from `off()`.

## UI Patterns

See `references/ui-patterns.md` for panel, FAB, toast, modal, and header injection
patterns, plus z-index layering so tools coexist.

Escape ticket data before any `innerHTML`. Short descriptions, comments, user
names and API error messages are all attacker-influenced, and your tool runs with
the user's full session.

## Real-Time and Polling

Anything watching records over time needs a scheduler, not a `setInterval`. See
`references/polling-scheduler.md` for lanes, high-water marks with overlap,
jitter, backoff, and hidden-tab handling.

For push, subscribe through `window.g_ambClient.getRecordWatcherChannel(table,
query)` — see `references/amb.md`. Treat a push as a trigger to run your delta
poll, not as data, and always keep the polling lane alive as the fallback.

To pull data from another origin's tab into SOW, see
`references/postmessage-bridge.md`.

## Genesys Cloud Integration

SOW integrates Genesys Cloud via a softphone iframe that communicates over
`postMessage`. Listen on the **iframe's `contentWindow`** in the capture phase,
not on the host `window`. See `references/genesys.md` for the message schema.

## Settings Persistence

SOW environments often block `localStorage`. Keep live state in memory, persist
durably to a JSON file via the File System Access API, and cache the file handle
in IndexedDB so restores are silent. See `references/settings.md`.

## Common Pitfalls

Read `references/gotchas.md` before building anything. Among the traps that cost
the most time: `sysparm_display_value=all` is essential; reference fields are
objects, not strings; the caller field is different on every table; blocked
journal ACLs return HTTP 200 with zero rows rather than an error; events do not
bubble out of shadow DOM; `now-alert` steals focus; `localStorage` may be blocked
entirely; and the workspace consumes your rate limit.

## Installer Page Design

See `references/installer-template.md` for a complete, copy-paste HTML template
with drag-to-install, copy fallback, module listing, and both the standard
URI-encode and base64 wrapping approaches.

The installer page should:
- Explain what the tool does and how to install (drag to bookmarks bar)
- Mention `Ctrl+Shift+B` to show the bookmarks bar if hidden
- Offer a "Copy bookmarklet code" fallback button
- List all included modules with short descriptions

Use the bookmarklet delivery pattern from this skill, not external script loading.
SOW's CSP blocks fetch/script from external origins.

## Multi-Tool Architecture

For toolkits with multiple features, use the tools-array pattern with on/off
lifecycle management. See `examples/menu-system.js` for a complete implementation
with a categorised toggle menu, state persistence, and cleanup management.
