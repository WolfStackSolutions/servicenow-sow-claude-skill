# Skill demos

Bookmarklet installer pages generated with this skill. Open an HTML file in a
browser, drag the button to your bookmarks bar, then click it on a logged-in
Service Operations Workspace page (`/now/sow/…`).

| File | What it proves |
|------|----------------|
| `who-am-i.html` | CSRF (`g_ck` / `X-UserToken`), `current_user`, `sys_user`, `dv()`, panel + toast |
| `my-open-incidents.html` | Table API + `sysparm_display_value=all`, FAB + read-only ticket list |
| `skill-verifier.html` | Full skill claim audit (~168 read-only probes) |
| `skill-verifier.js` | Source embedded by the verifier installer |

## Skill Verifier

1. Open `skill-verifier.html`.
2. Drag **Skill Verifier** onto your bookmarks bar.
3. Run it on `/now/sow/` (a record page exercises more DOM checks).
4. Click **Run all checks**, then **Copy report JSON** if you want a dump.

**Safety:** GET-only. No ticket PATCH/POST, no `order_now`, no `tabConfig`
mutation. Stops early on HTTP 429.
