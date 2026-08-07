# ServiceNow API Reference (Client-Side)

All calls run from the browser inside the SOW session. Authentication uses the
session cookie (`credentials: 'include'`) plus the CSRF token as `X-UserToken`.

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
| `sysparm_exclude_reference_link` | Skip ref links | `true` (saves bandwidth) |
| `sysparm_offset` | Pagination offset | `100` |

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
        sysparm_limit: String(limit || 10),
        sysparm_display_value: 'all'
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

The response contains `result.request_number` (REQ number) and
`result.request_id` (REQ sys_id). To find the RITM and SCTASK:

```javascript
// Find RITM under the request
snGet('sc_req_item', 'request=' + reqSysId, ['number', 'sys_id'], 1);

// Find SCTASK under the RITM
snGet('sc_task', 'request_item=' + ritmSysId, ['number', 'sys_id'], 1);
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

Returns the sys_id of the logged-in user. Then fetch their full record:

```javascript
fetch('/api/now/ui/user/current_user', {
    headers: { Accept: 'application/json', 'X-UserToken': getToken() },
    credentials: 'include'
})
.then(function(r) { return r.json(); })
.then(function(d) {
    var mySysId = d.result.sys_id;
    // Now fetch full user record
    return snGet('sys_user', 'sys_id=' + mySysId,
        ['sys_id', 'name', 'first_name', 'employee_number', 'user_name'], 1);
});
```

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

SOW records have different fields for the caller depending on table:

```javascript
function getCallerId(table, sysId) {
    var field = (table === 'interaction') ? 'opened_for' : 'caller_id';
    return snGet(table, 'sys_id=' + sysId, ['sys_id', field], 1)
        .then(function(rows) {
            if (!rows.length) return null;
            var val = rows[0][field];
            val = (val && typeof val === 'object') ? (val.value || '') : (val || '');
            return /^[0-9a-f]{32}$/i.test(val) ? val : null;
        });
}
```

## Rate Limit Budget Tracker

Track your own usage client-side since the server doesn't send remaining count:

```javascript
var SOWAPI = (function() {
    var CACHE_KEY = 'sow_api_cache_v1';
    var BUDGET_KEY = 'sow_api_budget_v1';
    var TTL = 600000;       // 10 min cache
    var MAX_ENTRIES = 60;
    var RESERVE = 10;       // stop short of the cap
    var inflight = {};

    function lsGet(k, d) {
        try { return JSON.parse(localStorage.getItem(k)) || d; }
        catch(e) { return d; }
    }
    function lsSet(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {}
    }

    function budget() {
        var b = lsGet(BUDGET_KEY, null);
        var window = Math.floor(Date.now() / 3600000);
        if (!b || b.w !== window) {
            b = { w: window, n: 0, limit: 100, until: 0, strikes: 0 };
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

    function get(table, query, fields, limit) {
        var key = table + '|' + query + '|' + (fields || []).join(',') + '|' + (limit || 10);
        var hit = cacheGet(key);
        if (hit !== undefined) return Promise.resolve(hit);
        if (inflight[key]) return inflight[key];

        var b = budget();
        if (Date.now() < b.until)
            return Promise.reject(new Error('Paused after rate limit'));
        if (b.n >= b.limit - RESERVE)
            return Promise.reject(new Error('Budget exhausted, resets on the hour'));

        var req = snGet(table, query, fields, limit)
            .then(function(rows) { cacheSet(key, rows); return rows; });
        inflight[key] = req;
        req.finally(function() { delete inflight[key]; });
        return req;
    }

    return { get: get, budget: budget };
})();
```

### Fetch Observer

Hook `window.fetch` to count every Table API call on the page, including ones
made by the workspace itself:

```javascript
(function hookFetch() {
    if (window.__sowFetchHooked) return;
    window.__sowFetchHooked = true;
    var orig = window.fetch;
    window.fetch = function(input) {
        var url = '';
        try { url = (typeof input === 'string') ? input : (input && input.url) || ''; }
        catch(e) {}
        if (url.indexOf('/api/now/table/') < 0) return orig.apply(this, arguments);
        // Count this request against the budget
        var b = budget();
        b.n++;
        lsSet(BUDGET_KEY, b);
        return orig.apply(this, arguments).then(function(r) {
            if (r.status === 429) {
                var retryAfter = parseInt(r.headers.get('retry-after') || '', 10);
                b.until = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 60000);
                lsSet(BUDGET_KEY, b);
            }
            return r;
        });
    };
})();
```

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
