# Skill demos

Bookmarklets generated with the `servicenow-sow-bookmarklet` skill.

| File | What it proves |
|------|----------------|
| `who-am-i.html` | CSRF (`g_ck` / `X-UserToken`), `current_user` API, `sys_user` Table API, `dv()`, draggable panel, toast |
| `my-open-incidents.html` | Table API query with `sysparm_display_value=all`, `dv()`/`rv()`, FAB + panel, read-only ticket list |
| `skill-verifier.html` | **Full skill claim audit** — 168 read-only probes across auth, APIs, journals, DOM, AMB, Genesys, storage |
| `skill-verifier.js` | Source for the verifier (embedded into the HTML installer) |
| `verification-claims-dom.md` | DOM/global claim inventory used while building the verifier |

## Skill Verifier (recommended for audits)

1. Download `skill-verifier.html` and open it in a normal browser tab.
2. Drag **Skill Verifier** onto your bookmarks bar.
3. Log into Service Operations Workspace (`/now/sow/…`).
4. Click the bookmark — a full-screen UI lists every claim.
5. Click **Run all checks**. Review fails/warns; use **Copy report JSON** for a diffable dump.

**Safety:** GET-only. No PATCH/POST, no `order_now`, no ticket edits, no `tabConfig`/`mainConfig` writes. Stops early on HTTP 429.

## Smaller demos

Same install pattern for `who-am-i.html` and `my-open-incidents.html`.

## Local preview of the installer pages

```bash
cd demos
python3 -m http.server 8765
```

Then open:

- http://localhost:8765/skill-verifier.html
- http://localhost:8765/who-am-i.html
- http://localhost:8765/my-open-incidents.html
