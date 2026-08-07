---
name: servicenow-sow-bookmarklet
description: >
  Build bookmarklet-based tools for ServiceNow's Service Operations Workspace (SOW).
  Covers CSRF auth via g_ck and X-UserToken, Table API, Service Catalog API, Attachment
  API, SPA navigation, Shadow DOM traversal, MutationObservers, real-time AMB/CometD
  push, Genesys Cloud softphone hooks, rate-limit budgeting, and the bookmarklet plus
  HTML-installer delivery pattern. Use when the user asks to build a bookmarklet,
  userscript, browser extension, or injected tool targeting SOW or the SWP portal.
  Also use for any ServiceNow Table API, Service Catalog API, or Attachment API work
  that runs client-side in the browser, or when the user mentions SOW, g_ck,
  X-UserToken, or ServiceNow workspace injection.
license: MIT
---

# ServiceNow SOW Bookmarklet Skill

Build browser-side tools that inject into ServiceNow's Service Operations Workspace.
Everything here was reverse-engineered from production SOW instances and represents
working, tested patterns.

## File map

Load these on demand. Do not read them all up front.

| File | Read it when |
|------|--------------|
| `references/api.md` | Any HTTP call: Table API read/PATCH, Service Catalog order_now, Attachment upload, current user, ticket/caller resolution, rate-limit budget tracker |
| `references/gotchas.md` | Before writing any code. 28 non-obvious traps grouped by API, DOM, storage, bookmarklet, and performance |
| `references/dom-structure.md` | Locating an injection target in SOW's component tree |
| `references/injection.md` | Shadow DOM traversal, MutationObservers, SPA nav hooks, fetch interception, tool lifecycle and cleanup |
| `references/ui-patterns.md` | Building a panel, FAB, toast, modal, header widget, or draggable surface |
| `references/comments.md` | Journal parsing (`sys_journal_field` plus inline fallback), content-addressed dedup, snapshot-diff change detection, closed state codes |
| `references/amb.md` | Real-time push, notification interception, delta polling with high-water marks |
| `references/genesys.md` | Softphone postMessage schema, call lifecycle, call timers |
| `references/settings.md` | Persisting settings where localStorage is blocked (File System Access API plus IndexedDB handle cache) |
| `references/installer-template.md` | Producing the deliverable HTML installer page |
| `examples/minimal-injector.js` | Smallest viable tool: re-entry guard, namespace, draggable panel |
| `examples/table-query.js` | Smallest viable authenticated Table API query |
| `examples/mutation-watcher.js` | Shadow DOM auto-discovery with periodic re-scan and cleanup |
| `examples/menu-system.js` | Multi-tool toolkit: categorised toggle menu, on/off lifecycle, state persistence |


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

For very large payloads (>50KB encoded), use a base64 approach:

```javascript
var B64_PAYLOAD = "base64-encoded-utf8-source...";
function b64ToUtf8(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}
document.getElementById('install-link').href =
    'javascript:' + encodeURIComponent(b64ToUtf8(B64_PAYLOAD));
```

### Re-entry guard

Always guard against double-clicks. If the tool creates a visible element, check
for it and toggle visibility instead of re-initializing:

```javascript
var existing = document.getElementById('my-tool-panel');
if (existing) {
    existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
    return;
}
```

### Namespace isolation

Store tool state on a namespaced window object to survive re-runs:

```javascript
if (!window._myToolkit) window._myToolkit = {};
var tk = window._myToolkit;
if (!tk.state) tk.state = {};
```

## Authentication: CSRF Tokens

Every API call to ServiceNow requires a CSRF token sent as the `X-UserToken` header.
The token is available from multiple sources (try in order):

```javascript
function getToken() {
    // Primary: global g_ck variable (always present in SOW)
    if (typeof g_ck !== 'undefined' && g_ck) return g_ck;
    if (window.g_ck) return window.g_ck;
    // Fallback: NOW namespace
    if (window.NOW && window.NOW.csrf_token) return window.NOW.csrf_token;
    if (window.NOW && window.NOW.g_ck) return window.NOW.g_ck;
    // Fallback: cross-frame (may throw in sandboxed iframes)
    try { if (window.top.g_ck) return window.top.g_ck; } catch (e) {}
    // Last resort: meta tag
    try {
        var meta = document.querySelector('meta[name="X-UserToken"]');
        if (meta) return meta.getAttribute('content') || '';
    } catch (e) {}
    return '';
}
```

## API Reference

See `references/api.md` for full details. Summary of available APIs:

| API | Method | Endpoint | Purpose |
|-----|--------|----------|---------|
| Table API (read) | GET | `/api/now/table/{table}` | Query any table |
| Table API (update) | PATCH | `/api/now/table/{table}/{sys_id}` | Update a record |
| Attachment API | POST | `/api/now/attachment/file` | Upload file attachments |
| Service Catalog | POST | `/api/sn_sc/servicecatalog/items/{item_id}/order_now` | Order a catalog item |
| Current User | GET | `/api/now/ui/user/current_user` | Get logged-in user info |

All requests need `credentials: 'include'` (or `withCredentials = true` for XHR)
and the `X-UserToken` header.

## Rate Limiting

ServiceNow instances typically enforce rate limits on the Table API:

- **100 requests per user per hour**, hard reset on the clock hour
- No `x-ratelimit-remaining` header (must be tracked client-side)
- Headers returned: `x-ratelimit-limit`, `x-ratelimit-reset`, `x-ratelimit-rule`
- Header presence is inconsistent (identical calls may or may not include them)
- A 429 response includes a `retry-after` header
- The workspace itself issues ~4 table API calls per ticket switch

**Always implement client-side budget tracking.** See `references/api.md` for the
full budget tracker pattern with localStorage persistence, deduplication, caching,
and a fetch observer that counts every Table API call on the page.

## DOM Injection

See `references/dom-structure.md` for SOW's component tree and injection targets.
See `references/injection.md` for MutationObserver and Shadow DOM patterns.

Key principles:
- SOW is a single-page app. `DOMContentLoaded` fires once, ever. Use MutationObservers.
- SOW uses nested web components with Shadow DOM. You must walk shadow roots.
- Tab switches do not cause page loads. Use `pushState`/`popstate` for SPA navigation.
- Every tool needs a cleanup function. Return it from `on()` and call it from `off()`.

## UI Patterns

See `references/ui-patterns.md` for panel, FAB, toast, modal, and header injection
patterns used by production SOW tools.

## Real-Time: AMB/CometD

ServiceNow uses AMB (Asynchronous Message Bus) over CometD for real-time push.
The channel subscription pattern is documented in `references/amb.md`.

## Genesys Cloud Integration

SOW integrates Genesys Cloud via a softphone iframe that communicates over
`postMessage`. See `references/genesys.md` for the message schema.

## Settings Persistence

SOW environments often block `localStorage`. Use the File System Access API
with an IndexedDB handle cache for durable settings. See `references/settings.md`.

## Common Pitfalls

Read `references/gotchas.md` before building anything. It covers every non-obvious
trap: `sysparm_display_value=all` being essential, reference fields being objects not
strings, events not bubbling out of shadow DOM, `now-alert` focus stealing, IMS using
`opened_for` instead of `caller_id`, localStorage being blocked, the workspace
consuming your rate limit, and many more.

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
