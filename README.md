<div align="center">
  <img src="images/readmeimage.png" alt="ServiceNow SOW Bookmarklet Skill" />
</div>

# ServiceNow SOW Bookmarklet Skill

An AI skill for building browser-side tools that inject into ServiceNow's Service Operations Workspace (SOW). Teaches AI assistants (Claude, etc.) the exact patterns needed to build SOW bookmarklets from scratch, without reverse-engineering anything.

## What's in it

Everything an AI needs to build SOW bookmarklet tools:

**SKILL.md** -- the main skill document. Covers the bookmarklet + HTML loader delivery pattern, CSRF authentication, API overview, rate limiting, DOM injection, and links to the reference docs.

**references/** -- deep documentation on each subsystem:

- `api.md` -- auth and getToken() with the full fallback chain, Table API (GET/PATCH), pagination via sysparm_offset, Stats (aggregate) and Presence APIs, Service Catalog order_now, Attachment API, current user resolution, ticket number resolution, per-table caller resolution, field value helpers, shared rate limit budget tracker with fetch observer
- `dom-structure.md` -- SOW's web component tree, selector-based discovery over hardcoded macroponent ids, shadow DOM paths to the tab strip / header / contact cards, sub-tab aware ticket detection, tab and screen pool configuration patching
- `injection.md` -- Shadow DOM traversal, MutationObserver patterns, capture-phase click handling across shadow roots, composedPath for click-outside, finding a selector's host, DOM interception (blocking now-alert, capturing the message text, hooking fetch), background-tab throttling strategies, tool lifecycle with cleanup functions
- `polling-scheduler.md` -- Lanes (delta / sweep / summary / presence), high-water marks with overlap, jitter, exponential backoff and Retry-After, hidden-tab parking, AMB push coalescing, teardown
- `amb.md` -- Real-time push via g_ambClient record watchers, notification interception through the dispatch hook, running push and polling lanes together
- `postmessage-bridge.md` -- Pulling data from another origin's tab into SOW: named-window linking, handshake and ack, origin validation, staleness reporting, teardown
- `genesys.md` -- Genesys Cloud softphone_connector postMessage schema, iframe#iframe discovery and capture-phase hooking, status and routingStatus mapping, call lifecycle (alerting/connected/disconnected/acw), building a call timer
- `ui-patterns.md` -- Escaping before innerHTML, z-index layering, panel + FAB, header widget injection, toast stacks, confirmation modals, draggable panels, tabs, animation with prefers-reduced-motion
- `settings.md` -- In-memory state plus File System Access API and an IndexedDB handle cache for environments that block localStorage, quota handling, stale handle recovery
- `comments.md` -- Journal parsing (inline primary, sys_journal_field where ACLs allow), dedup hashing and baselining, snapshot-diff engine for change detection, closed state codes with display fallback, interaction_related_record linking
- `gotchas.md` -- Every non-obvious pitfall: sysparm_display_value, reference field objects, the per-table caller field, journal ACLs returning empty 200s, shadow DOM event bubbling, now-alert focus stealing, rate limit headers and batching, CSP restrictions, localStorage blocking, config rewrites, escaping ticket data, and more
- `installer-template.md` -- Complete copy-paste HTML template for bookmarklet installer pages, with drag-to-install UX, copy fallback, module listing, and both the URI-encode and base64 approaches with measured payload sizes

**examples/** -- working implementations:

- `minimal-injector.js` -- re-entry guard, namespace, draggable panel
- `table-query.js` -- CSRF token grab, authenticated Table API query
- `mutation-watcher.js` -- shadow DOM auto-discovery, periodic re-scan, cleanup
- `menu-system.js` -- multi-tool toolkit with categorised toggle menu, on/off lifecycle, state persistence, auto-start

## Install as a Claude Code skill

```bash
npx @wolfstack/sow-skill
```

Or globally:

```bash
npx @wolfstack/sow-skill --global
```

Or clone and add manually:

```bash
git clone https://github.com/WolfStackSolutions/sow-bookmarklet-skill.git
cp -r sow-bookmarklet-skill .claude/skills/servicenow-sow-bookmarklet
```

## Usage

Once installed, Claude Code will automatically use this skill when you ask it to build ServiceNow SOW tools. For example:

- "Build a bookmarklet that shows the caller's recent tickets on the contact card"
- "Create a SOW tool that tracks ticket state changes and shows toast notifications"
- "Make a bookmarklet that adds drag-and-drop file attachment to SOW tickets"

The skill tells the AI how to authenticate, which APIs to call, how to inject into the DOM, and how to deliver the result as a bookmarklet.

## License

MIT
