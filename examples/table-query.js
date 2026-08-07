// Authenticated ServiceNow Table API query from inside SOW.
// Demonstrates: CSRF token grab, Table API GET, field value helpers.

'use strict';

// CSRF token
function getToken() {
    if (typeof g_ck !== 'undefined' && g_ck) return g_ck;
    if (window.g_ck) return window.g_ck;
    if (window.NOW && window.NOW.g_ck) return window.NOW.g_ck;
    if (window.NOW && window.NOW.csrf_token) return window.NOW.csrf_token;
    try { if (window.top.g_ck) return window.top.g_ck; } catch (e) {}
    return '';
}

// Field helpers
function dv(f) {
    if (f == null) return '';
    if (typeof f === 'object' && f.display_value !== undefined)
        return f.display_value || '';
    var s = String(f);
    return (s === 'undefined' || s === 'null') ? '' : s;
}

function rv(f) {
    if (f == null) return '';
    if (typeof f === 'object') return (f.value || f.display_value || '');
    return String(f);
}

// Table API query
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
        location.origin + '/api/now/table/' + table + '?' + new URLSearchParams(params),
        { credentials: 'include', headers: headers }
    )
    .then(function(r) {
        if (r.status === 429) throw new Error('Rate limited (429)');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    })
    .then(function(d) { return d.result || []; });
}

// Example: look up the current user's recent incidents
snGet('incident', 'opened_by=javascript:gs.getUserID()^ORDERBYDESCsys_updated_on',
    ['number', 'short_description', 'state', 'sys_updated_on'], 10)
.then(function(rows) {
    rows.forEach(function(r) {
        console.log(dv(r.number), '-', dv(r.short_description), '[' + dv(r.state) + ']');
    });
});
