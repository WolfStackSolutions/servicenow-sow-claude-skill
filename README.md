<div align="center">
  <img src="images/readmeimage.png" alt="ServiceNow SOW Bookmarklet Skill" />
</div>

# ServiceNow SOW Bookmarklet Skill

An AI skill for building browser-side tools that inject into ServiceNow's Service Operations Workspace (SOW). Teaches AI assistants (Claude, etc.) the exact patterns needed to build SOW bookmarklets from scratch, without reverse-engineering anything.

## What's in it

Everything an AI needs to build SOW bookmarklet tools:

**SKILL.md** -- the main skill document. Covers the bookmarklet + HTML loader delivery pattern, CSRF authentication, API overview, rate limiting, DOM injection, and links to the reference docs.

**references/** -- deep documentation on each subsystem:

- `api.md` -- Table API (GET/PATCH), Service Catalog order_now, Attachment API, current user resolution, ticket number resolution, caller resolution, field value helpers, rate limit budget tracker with fetch observer
- `dom-structure.md` -- SOW's web component tree, shadow DOM paths to the tab strip / header / contact cards / content area, tab and screen pool configuration patching
- `injection.md` -- Shadow DOM traversal, MutationObserver patterns (single root, auto-discover, cross-shadow click handlers), SPA navigation via pushState/popstate, DOM interception (blocking now-alert, hooking fetch), tool lifecycle with cleanup functions, visibility-aware polling
- `amb.md` -- AMB/CometD real-time push, notification interception via dispatch hook, delta polling with snapshot-diff as the portable alternative to direct channel subscription, high-water mark optimization, direct AMB subscription (advanced)
- `genesys.md` -- Genesys Cloud softphone_connector postMessage schema, status changes, call lifecycle (alerting/connected/disconnected/acw), building a call timer
- `ui-patterns.md` -- Panel + FAB, header widget injection, toast notifications, confirmation modals, draggable panels, animation with prefers-reduced-motion
- `settings.md` -- File System Access API + IndexedDB handle cache for environments that block localStorage
- `comments.md` -- Journal parsing (sys_journal_field and inline fallback), content-addressed dedup, snapshot-diff engine for change detection, closed state codes
- `gotchas.md` -- Every non-obvious pitfall: sysparm_display_value, reference field objects, shadow DOM event bubbling, now-alert focus stealing, IMS caller field, journal ACLs, rate limit headers, CSP restrictions, localStorage blocking, config rewrites, and more
- `installer-template.md` -- Complete copy-paste HTML template for bookmarklet installer pages, with drag-to-install UX, copy fallback, module listing, standard URI-encode approach, and base64 approach for large payloads

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
