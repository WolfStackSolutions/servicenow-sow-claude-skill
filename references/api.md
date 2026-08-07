# ServiceNow API Reference (Client-Side)

All calls run from the browser inside the SOW session. Authentication uses the
session cookie plus the CSRF token as `X-UserToken`.

## Authentication and CSRF Token

Every example below calls `getToken()`. Define it once per tool. Production tools
use slightly different chains; this is the widest one:

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
    } catch (e) {}
    return '';
}
```

On a normal SOW page `window.g_ck` alone is usually enough. The `window.top`
fallback matters when your code ends up running inside a frame.

Tools that write (PATCH, POST, `order_now`) should **abort** when no token is
found rather than firing requests that will 401:

```javascript
var TOKEN = getToken();
if (!TOKEN) { console.warn('no g_ck token, aborting'); return; }
```

### Request defaults

| Header / option | Value |
|-----------------|-------|
| `Accept` | `application/json` |
| `X-UserToken` | CSRF token (required for writes) |
| `credentials` | `'include'` — `'same-origin'` also works on same-host pages |
| `Content-Type` | `application/json` — only when sending a JSON body |

### Token rotation

On a long-running poller the session token can rotate mid-session. Retry once
with a freshly read token before surfacing a 401:

```javascript
if (r.status === 401) {
    var t2 = getToken();
    if (t2 && t2 !== TOKEN) {
        TOKEN = t2;
        return fetch(url, { credentials: 'include',
            headers: { Accept: 'application/json', 'X-UserToken': TOKEN } });
    }
}
```

## Table API -- Read

```
GET /api/now/table/{table_name}?{params}
```

### Common query parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `sysparm_query` | Encoded query string | `number=INC0060123` |
| `sysparm_fields` | Comma-separated field list | `sys_id,number,state` |
| `sysparm_limit` | Max rows returned | `10` |
| `sysparm_display_value` | Return display values | `all` (returns both raw + display) |
| `sysparm_exclude_reference_link` | Skip ref links | `true` (set on nearly every bulk read) |
| `sysparm_offset` | Pagination offset | `100` (see Pagination below) |
| `sysparm_no_count` | Skip the total-count sub-query | `true` (saves a round-trip on search) |

`sysparm_display_value` has two useful values, and they are not interchangeable:

| Value | Returns | Use for |
|-------|---------|---------|
| `all` | `{ value, display_value }` objects | Anything needing both raw and readable values |
| `true` | display strings directly | Journal text diffing, where nested objects are just noise |

### Query string syntax

ServiceNow query strings use `^` as AND, `^OR` as OR:

```
caller_id=abc123^state!=6^ORDERBYDESCsys_updated_on
```

Operators: `=`, `!=`, `LIKE`, `STARTSWITH`, `ENDSWITH`, `IN` (comma list),
`ISEMPTY`, `ISNOTEMPTY`, `>`, `<`, `>=`, `<=`, `BETWEEN`, `SAMEAS`.

Date operators: `javascript:gs.daysAgoStart(30)` for timezone-safe relative dates.

### Response shape

```json
{
    "result": [
        {
            "sys_id": "abc123...",
            "number": { "value": "INC0060123", "display_value": "INC0060123" },
            "state": { "value": "1", "display_value": "New" }
        }
    ]
}
```

When `sysparm_display_value=all`, each field is an object with `.value` (raw) and
`.display_value` (human-readable). Reference fields also include `.link`.

### Field value helpers

```javascript
// Get display value (human-readable)
function dv(field) {
    if (field == null) return '';
    if (typeof field === 'object' && field.display_value !== undefined)
        return field.display_value || '';
    var s = String(field);
    return (s === 'undefined' || s === 'null') ? '' : s;
}

// Get raw value (sys_id for references, raw state codes, etc.)
function rv(field) {
    if (field == null) return '';
    if (typeof field === 'object') return (field.value || field.display_value || '');
    return String(field);
}
```

### Minimal fetch wrapper

```javascript
var API_BASE = location.origin;

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
        API_BASE + '/api/now/table/' + table + '?' + new URLSearchParams(params),
        { credentials: 'include', headers: headers }
    )
    .then(function(r) {
        if (r.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 });
        if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
        return r.json();
    })
    .then(function(d) { return d.result || []; });
}
```

### Single record by sys_id

`result` is a single **object**, not an array. Forgetting this is a common
source of `undefined` reads:

```javascript
function snGetById(table, sysId, fields) {
    var url = API_BASE + '/api/now/table/' + table + '/' + sysId +
        '?sysparm_fields=' + encodeURIComponent(fields.join(','));
    var headers = { Accept: 'application/json' };
    var token = getToken();
    if (token) headers['X-UserToken'] = token;
    return fetch(url, { credentials: 'include', headers: headers })
        .then(function(r) { return r.json(); })
        .then(function(d) { return d.result || null; });
}
```

### Pagination

ServiceNow caps `sysparm_limit` per request (commonly 1000). To retrieve more,
page with `sysparm_offset` until a short page comes back or you hit a safety cap:

```javascript
function snAll(table, query, fields, maxTotal) {
    maxTotal = maxTotal || 5000;
    var page = 1000, all = [];
    function grab(offset) {
        var params = {
            sysparm_query: query,
            sysparm_limit: String(page),
            sysparm_offset: String(offset),
            sysparm_display_value: 'all',
            sysparm_exclude_reference_link: 'true'
        };
        if (fields && fields.length) params.sysparm_fields = fields.join(',');
        var headers = { Accept: 'application/json' };
        var token = getToken();
        if (token) headers['X-UserToken'] = token;
        return fetch(
            API_BASE + '/api/now/table/' + table + '?' + new URLSearchParams(params),
            { credentials: 'include', headers: headers }
        )
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var rows = d.result || [];
            all = all.concat(rows);
            if (rows.length === page && all.length < maxTotal) return grab(offset + page);
            return all;
        });
    }
    return grab(0);
}
```

Needed for things like 30-day closed-ticket history across a whole team, which
easily exceeds one page.

## Table API -- Update (PATCH)

```
PATCH /api/now/table/{table_name}/{sys_id}?sysparm_fields=sys_id
```

```javascript
function snPatch(table, sysId, body) {
    var headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };
    var token = getToken();
    if (token) headers['X-UserToken'] = token;
    return fetch(
        API_BASE + '/api/now/table/' + table + '/' + sysId + '?sysparm_fields=sys_id',
        {
            method: 'PATCH',
            headers: headers,
            body: JSON.stringify(body),
            credentials: 'include'
        }
    ).then(function(r) {
        if (!r.ok) throw new Error('PATCH failed: HTTP ' + r.status);
        return r.json();
    });
}

// Example: assign a task to yourself
snPatch('sc_task', taskSysId, { assigned_to: mySysId });

// Example: add a work note
snPatch('sc_task', taskSysId, { work_notes: 'Completed the thing.' });

// Example: add a customer-visible comment
snPatch('sc_req_item', ritmSysId, { comments: 'Your request is done.' });
```

## Service Catalog API -- Order Now

```
POST /api/sn_sc/servicecatalog/items/{catalog_item_sys_id}/order_now
```

This places a service catalog order (creates a REQ, RITM, and optionally SCTASKs):

```javascript
function orderCatalogItem(catalogItemId, variables) {
    var headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };
    var token = getToken();
    if (token) headers['X-UserToken'] = token;
    return fetch(
        API_BASE + '/api/sn_sc/servicecatalog/items/' + catalogItemId + '/order_now',
        {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                sysparm_quantity: '1',
                variables: variables
            }),
            credentials: 'include'
        }
    ).then(function(r) {
        if (!r.ok) throw new Error('Order failed: HTTP ' + r.status);
        return r.json();
    });
}
```

The response contains `result.request_number` (the REQ number) and
**`result.sys_id`** (the REQ sys_id). There is no `result.request_id` — reading
that gives `undefined` and every downstream child lookup silently returns
nothing.

```javascript
orderCatalogItem(itemId, variables).then(function(d) {
    var res = d.result || {};
    var reqNumber = res.request_number;   // 'REQ0012345'
    var reqSysId  = res.sys_id;           // sc_request sys_id

    // Find RITM under the request
    return snGet('sc_req_item', 'request=' + reqSysId, ['number', 'sys_id'], 10);
});

// Find SCTASK under the RITM
snGet('sc_task', 'request_item=' + ritmSysId, ['number', 'sys_id'], 1);
```

Real catalog items usually need many variables, not one or two. Send whatever
the item defines (`requested_for`, `opened_by`, `on_behalf_of`, `employee_id`,
`business_service`, `assignment_group_ref`, and so on) — a missing required
variable fails the order rather than defaulting.

### Parse the error envelope on failures

Both `order_now` and PATCH return a JSON error body worth surfacing. Throwing on
status alone hides the reason:

```javascript
.then(function(r) {
    return r.text().then(function(text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) {}
        if (!r.ok) {
            var msg = '';
            if (json && json.error) {
                msg = (json.error.message || '')
                    + (json.error.detail ? ' / ' + json.error.detail : '');
            } else {
                msg = text.slice(0, 200);
            }
            throw Object.assign(new Error('HTTP ' + r.status + (msg ? ': ' + msg : '')),
                { status: r.status });
        }
        return json;
    });
})
```

Give bulk write tools a timeout too, so one hung request cannot stall a queue:

```javascript
var ctrl = new AbortController();
var timer = setTimeout(function() { ctrl.abort(); }, 20000);
fetch(url, { signal: ctrl.signal, /* ... */ })
    .finally(function() { clearTimeout(timer); });
```

## Attachment API

```
POST /api/now/attachment/file?table_name={table}&table_sys_id={sys_id}&file_name={name}
```

```javascript
function uploadFile(file, fileName, table, sysId) {
    var token = getToken();
    var url = '/api/now/attachment/file'
        + '?table_name=' + encodeURIComponent(table)
        + '&table_sys_id=' + sysId
        + '&file_name=' + encodeURIComponent(fileName);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    if (token) xhr.setRequestHeader('X-UserToken', token);
    xhr.withCredentials = true;
    return new Promise(function(resolve, reject) {
        xhr.onload = function() {
            (xhr.status >= 200 && xhr.status < 300) ? resolve(fileName) :
                reject(new Error(fileName + ': HTTP ' + xhr.status));
        };
        xhr.onerror = function() { reject(new Error(fileName + ': network error')); };
        xhr.send(file);
    });
}
```

## Current User

```
GET /api/now/ui/user/current_user
```

The sys_id comes back as **`user_sys_id`**, not `sys_id`. Reading `result.sys_id`
returns `undefined` on every instance:

```json
{
    "result": {
        "user_sys_id": "62826bf03710200044e0bfc8bcbe5df1",
        "user_name": "abel.tuter",
        "user_display_name": "Abel Tuter",
        "user_initials": "AT"
    }
}
```

```javascript
fetch(API_BASE + '/api/now/ui/user/current_user', {
    headers: { Accept: 'application/json', 'X-UserToken': getToken() },
    credentials: 'include'
})
.then(function(r) { return r.json(); })
.then(function(d) {
    var res = d.result || {};
    var mySysId = res.user_sys_id || res.sys_id || res.sysId;
    return snGet('sys_user', 'sys_id=' + mySysId,
        ['sys_id', 'name', 'first_name', 'employee_number', 'user_name'], 1);
});
```

### Preferred: skip the endpoint entirely

`javascript:gs.getUserID()` resolves server-side inside a Table API query, so one
call gets the full user record and there is no response-shape dependency:

```javascript
snGet('sys_user', 'sys_id=javascript:gs.getUserID()',
    ['sys_id', 'name', 'user_name', 'email', 'title'], 1)
.then(function(rows) { var me = rows[0]; });
```

Use `current_user` only when you need session extras such as `user_initials`
or the role list.

## Stats API -- Aggregate Counts

```
GET /api/now/stats/{table}?sysparm_count=true&sysparm_group_by={field}&sysparm_query={query}
```

Far cheaper than fetching rows when you only need counts. One request instead of
paging thousands of records:

```javascript
function snStats(table, query, groupBy) {
    var params = {
        sysparm_count: 'true',
        sysparm_group_by: groupBy,
        sysparm_query: query
    };
    var headers = { Accept: 'application/json' };
    var token = getToken();
    if (token) headers['X-UserToken'] = token;
    return fetch(
        API_BASE + '/api/now/stats/' + table + '?' + new URLSearchParams(params),
        { credentials: 'include', headers: headers }
    )
    .then(function(r) {
        if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
        return r.json();
    })
    .then(function(d) { return d.result || []; });
}

// Count open incidents per assignee
snStats('incident', 'active=true^assigned_toISNOTEMPTY', 'assigned_to');
```

Each result element carries the group-by value plus a `stats.count`. Use this
before reaching for client-side counting — it costs one request against your
hourly budget instead of many.

## Presence API

```
GET /api/now/ui/presence
```

Returns who is currently active. Useful for showing online/idle/offline state
without querying user records:

```javascript
function pollPresence() {
    var headers = { Accept: 'application/json' };
    var token = getToken();
    if (token) headers['X-UserToken'] = token;
    return fetch(API_BASE + '/api/now/ui/presence',
        { credentials: 'include', headers: headers })
    .then(function(r) { return r.json(); })
    .then(function(d) {
        var map = {};
        (d.result || []).forEach(function(u) {
            map[u.user] = u.last_on;   // u.user = sys_id, u.last_on = last activity
        });
        return map;
    });
}
```

No request body. Treat a user absent from the list (or last seen 30+ minutes ago)
as offline, and give recently-seen users an idle grace window rather than
flipping them straight to offline.

## Ticket Number Resolution

Map a ticket number (e.g. INC0060123) to its table and sys_id:

```javascript
var TABLE_MAP = {
    INC: 'incident',
    RITM: 'sc_req_item',
    REQ: 'sc_request',
    CHG: 'change_request',
    PRB: 'problem',
    CTASK: 'change_task',
    SCTASK: 'sc_task',
    STASK: 'sn_si_task',
    TASK: 'task',
    IMS: 'interaction',
    KB: 'kb_knowledge'
};

function resolveRecord(number) {
    var match = number.match(/^(SCTASK|CTASK|STASK|RITM|TASK|INC|IMS|REQ|CHG|PRB|KB)/i);
    if (!match) return Promise.reject(new Error('Unknown prefix'));
    var table = TABLE_MAP[match[1].toUpperCase()];
    return snGet(table, 'number=' + number, ['sys_id'], 1)
        .then(function(rows) {
            if (!rows.length) throw new Error('No record found for ' + number);
            return { table: table, sysId: rv(rows[0].sys_id), number: number };
        });
}
```

## Caller Resolution

The field holding the end user differs per table. There is no single default that
works — see the caller-field table in `gotchas.md` for the full mapping and the
reasoning:

```javascript
var CALLER_FIELDS = {
    interaction: 'opened_for',      // IMS customer
    incident:    'caller_id',
    sc_req_item: 'requested_for',   // RITM beneficiary
    sc_request:  'requested_for',
    sc_task:     'opened_by',       // SCTASK has no caller field
    change_request: 'requested_by'
};

function callerField(table) {
    return CALLER_FIELDS[table] || 'caller_id';
}

function getCallerId(table, sysId) {
    var field = callerField(table);
    return snGet(table, 'sys_id=' + sysId, ['sys_id', field, 'opened_by'], 1)
        .then(function(rows) {
            if (!rows.length) return null;
            // Fall back to opened_by: the primary field is often empty on
            // records raised on someone else's behalf.
            var val = rv(rows[0][field]) || rv(rows[0].opened_by);
            return /^[0-9a-f]{32}$/i.test(val) ? val : null;
        });
}
```

## Rate Limit Budget Tracker

There is no `x-ratelimit-remaining` header, so a shared client-side counter is the
only way several tools on one page can avoid starving each other.

The budget and the fetch hook must live in **one** module. The hook is what
increments the counter; a tracker whose `get()` increments separately will
double-count, and one where neither increments stays at zero forever.

```javascript
var SOWAPI = window.__SOWAPI || (window.__SOWAPI = (function() {
    var CACHE_KEY = 'sow_api_cache_v1';
    var BUDGET_KEY = 'sow_api_budget_v1';
    var TTL = 600000;       // 10 min cache
    var MAX_ENTRIES = 60;   // localStorage is not infinite
    var RESERVE = 10;       // stop short of the cap, other tools need room
    var inflight = {};
    var OURS = false;       // set immediately before our own fetch calls

    function lsGet(k, d) {
        try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
        catch (e) { return d; }
    }
    function lsSet(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    }

    // Budget resets on the clock hour. Note this uses the *client* hour, which
    // can drift from the server's reset boundary — keep RESERVE for that.
    function budget() {
        var b = lsGet(BUDGET_KEY, null);
        var hourWindow = Math.floor(Date.now() / 3600000);
        if (!b || b.w !== hourWindow) {
            b = { w: hourWindow, n: 0, limit: 100, until: 0, strikes: 0 };
            lsSet(BUDGET_KEY, b);
        }
        return b;
    }

    function cacheGet(key) {
        var c = lsGet(CACHE_KEY, {});
        var entry = c[key];
        return (entry && (Date.now() - entry.t) < TTL) ? entry.v : undefined;
    }

    function cacheSet(key, val) {
        var c = lsGet(CACHE_KEY, {});
        c[key] = { t: Date.now(), v: val };
        var keys = Object.keys(c);
        if (keys.length > MAX_ENTRIES) {
            keys.sort(function(a, b) { return c[a].t - c[b].t; });
            keys.slice(0, keys.length - MAX_ENTRIES).forEach(function(k) { delete c[k]; });
        }
        lsSet(CACHE_KEY, c);
    }

    // Records the outcome of one Table API response.
    // `ours` = issued by this toolkit. `governed` = server says it counts.
    function note(r, ours) {
        var b = budget();
        var lim = parseInt(r.headers.get('x-ratelimit-limit') || '', 10);
        var rst = parseInt(r.headers.get('x-ratelimit-reset') || '', 10);
        var governed = lim > 0 || r.status === 429;

        if (ours || governed) b.n++;
        if (lim > 0) b.limit = lim;
        if (rst > 0) b.reset = rst * 1000;

        if (r.status === 429) {
            var ra = parseInt(r.headers.get('retry-after') || '', 10);
            b.strikes = Math.min((b.strikes || 0) + 1, 6);
            b.until = Date.now() + (ra > 0 ? ra * 1000
                : Math.min(60000, 3000 * Math.pow(2, b.strikes - 1)));
        } else {
            b.strikes = 0;
            b.until = 0;
        }
        lsSet(BUDGET_KEY, b);
    }

    (function hookFetch() {
        if (window.__sowFetchHooked) return;
        window.__sowFetchHooked = true;
        var orig = window.fetch;
        if (typeof orig !== 'function') return;
        window.fetch = function(input) {
            var url = '';
            try { url = (typeof input === 'string') ? input : (input && input.url) || ''; }
            catch (e) {}
            if (url.indexOf('/api/now/table/') < 0) return orig.apply(this, arguments);
            var ours = OURS; OURS = false;   // consume the flag
            return orig.apply(this, arguments).then(function(r) {
                try { note(r, ours); } catch (e) {}
                return r;
            });
        };
    })();

    function get(table, query, fields, limit) {
        var key = table + '|' + query + '|' + (fields || []).join(',') + '|' + (limit || 50);
        var hit = cacheGet(key);
        if (hit !== undefined) return Promise.resolve(hit);
        if (inflight[key]) return inflight[key];

        var b = budget();
        if (Date.now() < b.until)
            return Promise.reject(new Error('Paused after rate limit'));
        if (b.n >= b.limit - RESERVE)
            return Promise.reject(new Error('Request budget reached, resets on the hour'));

        OURS = true;   // the fetch hook charges this one to us
        var req = snGet(table, query, fields, limit)
            .then(function(rows) { cacheSet(key, rows); return rows; });
        inflight[key] = req;
        req.catch(function() {}).then(function() { delete inflight[key]; });
        return req;
    }

    return { get: get, budget: budget };
})());
```

### Why the hook charges selectively

ServiceNow only returns `x-ratelimit-*` headers on responses that actually count
against a rule, and header presence proved unreliable as a test on its own. So
charge everything the toolkit issues (`ours`) plus anything the server explicitly
flags (`governed`). Counting every Table API call on the page instead — including
the workspace's own — drains the budget with traffic you do not control.

## Common Tables

| Table Name | Records | Ticket Prefix |
|------------|---------|---------------|
| `incident` | Incidents | INC |
| `sc_req_item` | Requested Items | RITM |
| `sc_request` | Requests | REQ |
| `sc_task` | Catalog Tasks | SCTASK |
| `interaction` | Interactions (IMS) | IMS |
| `change_request` | Changes | CHG |
| `problem` | Problems | PRB |
| `sys_user` | Users | -- |
| `sys_user_group` | Groups | -- |
| `sys_user_grmember` | Group Memberships | -- |
| `cmn_department` | Departments | -- |
| `sys_journal_field` | Journal entries (comments/work notes) | -- |

### Table field notes

- `sys_user.department` is a reference to `cmn_department` (not the department name)
- `cmn_department.id` carries numeric org codes (if used)
- `sys_journal_field` may be ACL-blocked; fall back to inline comment parsing
- Some tables return HTTP 403 to non-admin accounts (check before relying on them)
- `sys_user.last_name` can have leading whitespace from identity feeds
