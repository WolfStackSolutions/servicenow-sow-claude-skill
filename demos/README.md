# Skill demos

Bookmarklet installer pages generated with this skill. Open an HTML file in a
browser, drag the button to your bookmarks bar, then click it on a logged-in
Service Operations Workspace page (`/now/sow/…`).

| File | What it proves |
|------|----------------|
| `who-am-i.html` | CSRF (`g_ck` / `X-UserToken`), `current_user`, `sys_user`, `dv()`, panel + toast |
| `my-open-incidents.html` | Table API + `sysparm_display_value=all`, FAB + read-only ticket list |
| `alert-suppressor.html` | Block SOW `now-alert` banners: `dispatchEvent` hook + `insertBefore`/`appendChild` patch, FAB log |
| `skill-verifier.html` | Full skill claim audit (~168 read-only probes) |
| `skill-verifier.js` | Source embedded by the verifier installer |

## Alert Suppressor

Stops SOW notification banners from stealing focus / covering the page, and
keeps a log of what would have shown.

1. Open `alert-suppressor.html`.
2. Drag **Alert Suppressor** onto your bookmarks bar.
3. Click it on `/now/sow/`.
4. When SOW would show a `now-alert`, it gets blocked; the shield FAB badge
   increments. Open the panel to read the suppressed messages.

**How it works (two layers):**

- Hooks `EventTarget.dispatchEvent` to catch `NOTIFICATIONS_UPDATED` payloads
  and queue the message text.
- Patches `Node.prototype.insertBefore` / `appendChild` so `now-alert` nodes
  never stay in the DOM (hide + remove on the next microtick) — no timer, no
  dismiss animation, no focus steal.

Click the bookmark again to toggle the panel. This is DOM-only (no ticket API
writes).

## Skill Verifier

1. Open `skill-verifier.html`.
2. Drag **Skill Verifier** onto your bookmarks bar.
3. Run it on `/now/sow/` (a record page exercises more DOM checks).
4. Click **Run all checks**, then **Copy report JSON** if you want a dump.

**Safety:** GET-only. No ticket PATCH/POST, no `order_now`, no `tabConfig`
mutation. Stops early on HTTP 429.
