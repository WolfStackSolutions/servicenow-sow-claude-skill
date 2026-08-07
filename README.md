<div align="center">
  <img src="images/readmeimage.png" alt="ServiceNow SOW Bookmarklet Skill" />
</div>

# ServiceNow SOW Bookmarklet Skill

An AI skill for building browser-side tools that inject into ServiceNow's
Service Operations Workspace (SOW). Teaches assistants the exact patterns needed
to ship SOW bookmarklets without reverse-engineering the platform.

Validated against a live SOW instance (auth, Table/Stats/Presence APIs, journals,
DOM/AMB/Genesys selectors) via the included read-only skill verifier.

## What's in it

**SKILL.md** — delivery pattern, CSRF auth, API overview, rate limiting, DOM
injection, and links into the reference set.

**references/** — deep docs per subsystem:

- `api.md` — `getToken()` fallback chain, Table API, pagination, Stats & Presence,
  Catalog `order_now`, attachments, ticket/caller resolution, rate-limit budget
- `dom-structure.md` — web component tree, stable selectors, tab/screen pool config
- `injection.md` — shadow DOM walkers, MutationObserver, click-outside, fetch hooks,
  background-tab strategies, lifecycle/cleanup
- `polling-scheduler.md` — delta/sweep/presence lanes, high-water marks, backoff
- `amb.md` — `g_ambClient` record watchers + notification interception
- `postmessage-bridge.md` — cross-origin tab bridge (handshake, ack, staleness)
- `genesys.md` — softphone `postMessage` schema and call timer patterns
- `ui-patterns.md` — panels, FAB, toasts, modals, z-index, a11y motion
- `settings.md` — File System Access + IndexedDB when `localStorage` is blocked
- `comments.md` — journal parsing, dedup, closed-state helpers, associations
- `gotchas.md` — production pitfalls (display_value, ACLs, rate headers, CSP, …)
- `installer-template.md` — copy-paste bookmarklet installer HTML

**examples/** — minimal injector, table query, mutation watcher, toolkit menu.

**demos/** — ready-to-drag installer pages (Who Am I, My Open Incidents, and the
full read-only Skill Verifier).

## Install

```bash
npx @wolfstack/sow-skill
```

Or globally:

```bash
npx @wolfstack/sow-skill --global
```

Or clone and copy:

```bash
git clone https://github.com/WolfStackSolutions/servicenow-sow-claude-skill.git
cp -r servicenow-sow-claude-skill ~/.claude/skills/servicenow-sow-bookmarklet
```

## Usage

Once installed, ask for SOW tools in plain language, for example:

- "Build a bookmarklet that shows the caller's recent tickets on the contact card"
- "Create a SOW tool that tracks ticket state changes and shows toast notifications"
- "Make a bookmarklet that adds drag-and-drop file attachment to SOW tickets"

## License

MIT
