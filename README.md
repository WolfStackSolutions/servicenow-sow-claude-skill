<div align="center">
  <img src="images/readmeimage.png" alt="servicenow sow bookmarklet skill" />
</div>

# ServiceNow SOW Bookmarklet Skill

stuff i wish existed when i first tried building tools on service operations workspace.

sow is complicated to say the least, shadow dom nested like 15 levels deep. the table api returns different shapes depending on the day. journals can 200 with zero rows when acl blocks you. rate limit headers show up sometimes and disappear other times. genesys only talks to you if you listen on the right iframe with capture. none of this is documented properly.

this skill is months of reverse engineering from tools that actually run in production. drop it into claude/cursor and you don't have to rediscover all that crap yourself.

## What's in here

| path | what |
|------|------|
| `SKILL.md` | main skill file, when to load what |
| `references/` | the deep stuff: apis, dom, injection, amb, genesys, polling, gotchas |
| `examples/` | small working bits |
| `demos/` | drag-to-bookmarks html pages you can try |

## The stuff that burns you

csrf is fine once you know the chain. matters more when you're framed:

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

always do `credentials: 'include'` + `X-UserToken`. always use `sysparm_display_value=all` if you want names. without it you might get a raw sys_id string *or* a `{link, value}` object. don't assume:

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

caller fields are different per table. there is no one `caller_id`:

```javascript
var CALLER_FIELD = {
    incident: 'caller_id',
    interaction: 'opened_for',   // ims, not caller_id
    sc_req_item: 'requested_for',
    sc_request: 'requested_for',
    change_request: 'requested_by',
    sc_task: 'opened_by'         // follow request_item up for the ritm
};
```

also `current_user` gives you `user_sys_id`, not `sys_id`. that one cost me an afternoon.

## Finding stuff in the DOM

use stable selectors, not macroponent hash ids. walk shadows:

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

var headerHost = findHostWith('.polaris-header-controls');
```

realtime is `window.g_ambClient`, not `window.amb.getClient()`, even if both are sitting there:

```javascript
var c = window.g_ambClient;
if (c && typeof c.getRecordWatcherChannel === 'function') {
    var ch = c.getRecordWatcherChannel('incident', 'sys_id=' + sysId);
    var sub = ch.subscribe(function () {
        // just a kick, re-fetch, don't trust the push body
        pollDelta();
    });
}
```

## Shipping it

sow's csp blocks external scripts so the whole tool lives in a `javascript:` bookmark. usual pattern is an html page that builds the href:

```javascript
var toolkitCode = function () {
    'use strict';
    // ... entire tool ...
};

var code = toolkitCode.toString();
var body = code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'));
var href = 'javascript:void((function(){' + encodeURIComponent(body) + '})())';
document.getElementById('install-link').href = href;
```

chrome is fine with ~490kb this way. full installer template is in `references/installer-template.md`.

## Install

### Claude.ai

needs a zip. easiest:

1. grab [`servicenow-sow-bookmarklet.zip`](https://github.com/WolfStackSolutions/servicenow-sow-claude-skill/raw/main/packaged/servicenow-sow-bookmarklet.zip)
2. claude.ai → customize → skills → upload skill
3. turn the toggle **on** after upload (upload alone does nothing)
4. paid plan + code execution on

zip has to be folder-wrapped like this:

```
servicenow-sow-bookmarklet.zip
└── servicenow-sow-bookmarklet/
    ├── SKILL.md
    ├── LICENSE
    ├── references/
    └── examples/
```

if you zip the files flat, claude won't find `SKILL.md`.

rebuild yourself with:

```bash
./scripts/pack-for-claude.sh
```

demos aren't in the zip on purpose. claude only needs the skill + references + examples.

### Claude Code / Cursor

```bash
git clone https://github.com/WolfStackSolutions/servicenow-sow-claude-skill.git
```

claude code:

```bash
cp -r servicenow-sow-claude-skill ~/.claude/skills/servicenow-sow-bookmarklet
```

cursor:

```bash
cp -r servicenow-sow-claude-skill ~/.cursor/skills/servicenow-sow-bookmarklet
```

or just open the repo and work from it.

no npx thing yet. clone/copy or the zip is the path.

## Demos

open anything in `demos/` in a browser, drag the button to bookmarks, click it on sow:

- `who-am-i.html` - token + current user
- `my-open-incidents.html` - table api list
- `alert-suppressor.html` - kills `now-alert` banners, logs them in a fab
- `skill-verifier.html` - ~168 read-only checks against the live page (get only, won't touch tickets, stops on 429)

## Talking to the assistant

once it's installed just ask normal stuff like:

- build a bookmarklet that shows the caller's recent tickets on the contact card
- watch work notes and toast when someone else comments
- hook genesys and put a call timer in the header

it'll know how to auth, which endpoints to hit, where to inject, and how to ship it.

## License

mit. use it, fork it, ship stuff with it. if it saves you a few months of pain that's the whole point.
