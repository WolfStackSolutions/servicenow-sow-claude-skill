<div align="center">
  <img src="images/readmeimage.png" alt="ServiceNow SOW Bookmarklet Skill" />
</div>

# ServiceNow SOW Bookmarklet Skill

This is the stuff I wish I'd had when I started building tools on ServiceNow's
Service Operations Workspace.

SOW is a shadow-DOM maze. The Table API lies to you about field shapes. Journals
return `200` with zero rows when ACL-blocked. Rate-limit headers appear on some
calls and vanish on others. Genesys softphone events only show up if you listen
on the right iframe with capture phase. None of that is in the docs.

**This skill is months of reverse engineering**, distilled from production
bookmarklets that actually run on a live SOW instance — then checked again with
a read-only verifier against that same instance. Hand it to Claude (or another
assistant) and it can build SOW tools without redoing that archaeology.

## What you get

| Path | What it is |
|------|------------|
| `SKILL.md` | The skill entrypoint — delivery pattern, auth, when to load each reference |
| `references/` | Deep docs: APIs, DOM, injection, AMB, Genesys, polling, gotchas, installer |
| `examples/` | Small working patterns (injector, table query, mutation watcher, menu) |
| `demos/` | Drag-to-bookmarks HTML pages, including a full read-only skill verifier |

## The gotchas that burn people

CSRF isn't a mystery once you've seen it, but the fallback chain matters when
your code ends up framed:

```javascript
function getToken() {
    if (typeof g_ck !== 'undefined' && g_ck) return g_ck;
    if (window.g_ck) return window.g_ck;
    if (window.NOW && window.NOW.g_ck) return window.NOW.g_ck;
    try { if (window.top && window.top.g_ck) return window.top.g_ck; } catch (e) {}
    if (window.NOW && window.NOW.csrf_token) return window.NOW.csrf_token;
    try {
        var meta = document.querySelector('meta[name="X-UserToken"]');
        if (meta) return meta.getAttribute('content') || '';
    } catch (e2) {}
    return '';
}
```

Always send `credentials: 'include'` and `X-UserToken`. Always ask for
`sysparm_display_value=all` if you want human-readable names — without it,
references might be a bare sys_id **or** a `{link, value}` object depending on
the instance. Never assume a string:

```javascript
function snGet(table, query, fields, limit) {
    var params = {
        sysparm_query: query,
        sysparm_limit: String(limit || 50),
        sysparm_display_value: 'all',
        sysparm_exclude_reference_link: 'true'
    };
    if (fields && fields.length) params.sysparm_fields = fields.join(',');

    var headers = { Accept: 'application/json' };
    var token = getToken();
    if (token) headers['X-UserToken'] = token;

    return fetch(
        location.origin + '/api/now/table/' + table + '?' + new URLSearchParams(params),
        { credentials: 'include', headers: headers }
    )
    .then(function (r) {
        if (r.status === 429) throw new Error('Rate limited (429)');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    })
    .then(function (d) { return d.result || []; });
}

// Field helpers — refs are objects under display_value=all
function dv(f) {
    if (f == null) return '';
    if (typeof f === 'object' && f.display_value !== undefined) return f.display_value || '';
    var s = String(f);
    return (s === 'undefined' || s === 'null') ? '' : s;
}
function rv(f) {
    if (f == null) return '';
    if (typeof f === 'object') return (f.value || f.display_value || '');
    return String(f);
}
```

Caller fields are per-table. There is no universal `caller_id`:

```javascript
var CALLER_FIELD = {
    incident: 'caller_id',
    interaction: 'opened_for',   // IMS — not caller_id
    sc_req_item: 'requested_for',
    sc_request: 'requested_for',
    change_request: 'requested_by',
    sc_task: 'opened_by'         // no real "caller"; follow request_item up
};
```

And `current_user` returns `user_sys_id`, not `sys_id`. That one alone wasted
an afternoon.

## Finding anything in SOW's DOM

Stable selectors beat hardcoded macroponent hashes. Walk shadows until you find
the host that owns the node you care about:

```javascript
function findHostWith(selector) {
    var stack = [document.body], seen = 0;
    while (stack.length && seen < 60000) {
        var n = stack.pop(); seen++;
        if (!n) continue;
        if (n.shadowRoot) {
            try {
                if (n.shadowRoot.querySelector(selector)) return n;
            } catch (e) {}
            stack.push(n.shadowRoot);
        }
        var ch = n.children;
        if (ch) for (var i = 0; i < ch.length; i++) stack.push(ch[i]);
    }
    return null;
}

// Header chrome lives in a shadow root
var headerHost = findHostWith('.polaris-header-controls');
```

Real-time updates go through `window.g_ambClient` — not `window.amb.getClient()`,
even when both exist on the page:

```javascript
var c = window.g_ambClient;
if (c && typeof c.getRecordWatcherChannel === 'function') {
    var ch = c.getRecordWatcherChannel('incident', 'sys_id=' + sysId);
    var sub = ch.subscribe(function () {
        // treat as a kick, then re-fetch — don't trust the push payload as truth
        pollDelta();
    });
}
```

## Delivery: bookmarklet + installer HTML

SOW's CSP blocks external scripts, so the whole tool has to ride in a
`javascript:` bookmark. The usual pattern is an HTML page that builds the
href for you:

```javascript
var toolkitCode = function () {
    'use strict';
    // … entire tool …
};

var code = toolkitCode.toString();
var body = code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'));
var href = 'javascript:void((function(){' + encodeURIComponent(body) + '})())';
document.getElementById('install-link').href = href;
```

Chrome happily carries a ~490KB tool this way. See
`references/installer-template.md` for the full installer page.

## Install

```bash
npx @wolfstack/sow-skill
```

```bash
npx @wolfstack/sow-skill --global
```

Or clone it:

```bash
git clone https://github.com/WolfStackSolutions/servicenow-sow-claude-skill.git
cp -r servicenow-sow-claude-skill ~/.claude/skills/servicenow-sow-bookmarklet
```

## Try the demos

Open anything under `demos/` in a normal browser tab, drag the button to your
bookmarks bar, then click it while logged into SOW:

- **Who Am I** — token grab + `current_user` / `sys_user`
- **My Open Incidents** — Table API list with `dv()` / `rv()`
- **Skill Verifier** — ~168 read-only probes against the live page (GET only;
  won't touch tickets; stops on 429)

## How to use it with an assistant

Once the skill is installed, talk normally:

- "Build a bookmarklet that shows the caller's recent tickets on the contact card"
- "Watch work notes and toast when someone else comments"
- "Hook the Genesys softphone and show a call timer in the header"

The skill tells the model how to auth, which endpoints to hit, where to inject,
and how to ship the result as a bookmarklet — including the landmines.

## License

MIT — use it, fork it, ship tools with it. If it saves you a few months of
headaches, that's the point.
