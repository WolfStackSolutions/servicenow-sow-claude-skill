# Skill demos

Two tiny bookmarklets generated with the installed `servicenow-sow-bookmarklet` skill.

| File | What it proves |
|------|----------------|
| `who-am-i.html` | CSRF (`g_ck` / `X-UserToken`), `current_user` API, `sys_user` Table API, `dv()`, draggable panel, toast |
| `my-open-incidents.html` | Table API query with `sysparm_display_value=all`, `dv()`/`rv()`, FAB + panel, read-only ticket list |

## How to test on your instance

1. Open either HTML file in a normal browser tab (double-click or `python3 -m http.server` from this folder).
2. Drag the accent button onto your bookmarks bar.
3. Log into Service Operations Workspace on your ServiceNow instance.
4. Click the bookmark.

Clicking again toggles the UI (re-entry guard). Both tools are read-only.

## Local preview of the installer pages

```bash
cd demos
python3 -m http.server 8765
```

Then open:

- http://localhost:8765/who-am-i.html
- http://localhost:8765/my-open-incidents.html
