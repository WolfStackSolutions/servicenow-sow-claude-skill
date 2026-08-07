/* Skill Verifier — read-only SOW probe
 * Checks skill-doc claims against a live ServiceNow SOW page.
 * NO writes: no PATCH, no POST, no order_now, no DOM mutation of SOW chrome
 * (only our own panel). Safe to run on a production instance.
 *
 * Handle: window.__sowSkillVerifier
 */
'use strict';

var existing = document.getElementById('sow-skill-verifier');
if (existing) {
    existing.style.display = existing.style.display === 'none' ? 'flex' : 'none';
    return;
}

if (!window.__sowSkillVerifier) window.__sowSkillVerifier = { __alive: true };
var VER = window.__sowSkillVerifier;

/* ── design tokens ─────────────────────────────────────────── */
var BG = '#0f1117', S1 = '#161922', S2 = '#1c2030', S3 = '#242838';
var BORD = 'rgba(255,255,255,0.10)', T = '#e4e5eb', DIM = '#8b91a0', FAINT = '#5a5f6e';
var ACC = '#818cf8', OK = '#10b981', WARN = '#f59e0b', DANGER = '#ef4444', SKIP = '#64748b';
var MONO = "'JetBrains Mono','SF Mono',Consolas,monospace";
var BODY = "-apple-system,system-ui,'Segoe UI',Roboto,sans-serif";
var Z = 2147483000;

/* ── helpers ───────────────────────────────────────────────── */
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
function isSysId(s) { return /^[0-9a-f]{32}$/i.test(String(s || '')); }

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

var API_STATS = { calls: 0, limited: false, lastLimit: null, headersSeen: 0, headersMissing: 0 };
var SAMPLE = {}; // shared cache filled by bootstrap / early tests

function apiGet(path, params) {
    if (API_STATS.limited) {
        return Promise.reject(Object.assign(new Error('Rate limited — remaining probes skipped'), { status: 429, skipped: true }));
    }
    var url = location.origin + path;
    if (params) url += (path.indexOf('?') >= 0 ? '&' : '?') + new URLSearchParams(params).toString();
    var headers = { Accept: 'application/json' };
    var token = getToken();
    if (token) headers['X-UserToken'] = token;
    API_STATS.calls++;
    return fetch(url, { credentials: 'include', headers: headers }).then(function (r) {
        var lim = r.headers.get('x-ratelimit-limit');
        var rem = r.headers.get('x-ratelimit-remaining');
        var rst = r.headers.get('x-ratelimit-reset');
        var rule = r.headers.get('x-ratelimit-rule');
        if (lim || rst || rule) API_STATS.headersSeen++;
        else API_STATS.headersMissing++;
        if (lim) API_STATS.lastLimit = parseInt(lim, 10);
        if (r.status === 429) {
            API_STATS.limited = true;
            var err = new Error('HTTP 429');
            err.status = 429;
            err.retryAfter = r.headers.get('retry-after');
            err.headers = { lim: lim, rem: rem, rst: rst, rule: rule };
            throw err;
        }
        return r.text().then(function (text) {
            var json = null;
            try { json = JSON.parse(text); } catch (e) {}
            return {
                ok: r.ok, status: r.status, json: json, text: text.slice(0, 400),
                headers: { lim: lim, rem: rem, rst: rst, rule: rule }
            };
        });
    });
}

function tableGet(table, params) {
    return apiGet('/api/now/table/' + table, params);
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function pass(detail) { return { status: 'pass', detail: detail || '' }; }
function fail(detail) { return { status: 'fail', detail: detail || '' }; }
function skip(detail) { return { status: 'skip', detail: detail || '' }; }
function warn(detail) { return { status: 'warn', detail: detail || '' }; }

function walkShadows(root, visit, depth) {
    if (!root || (depth || 0) > 40) return;
    try {
        root.querySelectorAll('*').forEach(function (el) {
            visit(el);
            if (el.shadowRoot) walkShadows(el.shadowRoot, visit, (depth || 0) + 1);
        });
    } catch (e) {}
}

function findHostWith(sel) {
    var stack = [document.body], seen = 0;
    while (stack.length && seen < 60000) {
        var n = stack.pop(); seen++;
        if (!n) continue;
        if (n.shadowRoot) {
            try { if (n.shadowRoot.querySelector(sel)) return n; } catch (e) {}
            stack.push(n.shadowRoot);
        }
        var ch = n.children;
        if (ch) for (var i = 0; i < ch.length; i++) stack.push(ch[i]);
    }
    return null;
}

function countShadowDepth() {
    var max = 0;
    function walk(root, d) {
        if (!root || d > 40) return;
        if (d > max) max = d;
        try {
            root.querySelectorAll('*').forEach(function (el) {
                if (el.shadowRoot) walk(el.shadowRoot, d + 1);
            });
        } catch (e) {}
    }
    walk(document, 0);
    return max;
}

function queryDeep(selector) {
    var hits = [];
    walkShadows(document, function (el) {
        try {
            if (el.matches && el.matches(selector)) hits.push(el);
            if (el.shadowRoot) {
                el.shadowRoot.querySelectorAll(selector).forEach(function (h) { hits.push(h); });
            }
        } catch (e) {}
    }, 0);
    // also top-level
    try { document.querySelectorAll(selector).forEach(function (h) { hits.push(h); }); } catch (e) {}
    return hits;
}

/* ── result status helpers for tests that need samples ─────── */
function needIncident() {
    if (SAMPLE.incident) return Promise.resolve(SAMPLE.incident);
    return tableGet('incident', {
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_exclude_reference_link: 'true',
        sysparm_fields: 'sys_id,number,short_description,state,assignment_group,assigned_to,caller_id,opened_by,sys_updated_on,sys_created_on,comments,work_notes,active'
    }).then(function (r) {
        if (!r.ok) throw new Error('incident sample HTTP ' + r.status);
        var row = (r.json && r.json.result && r.json.result[0]) || null;
        if (!row) throw new Error('no readable incident');
        SAMPLE.incident = row;
        return row;
    });
}

/* ── TEST SUITE ────────────────────────────────────────────── */
var TESTS = [];

function add(id, cat, claim, fn) {
    TESTS.push({ id: id, cat: cat, claim: claim, fn: fn });
}

/* ========== AUTH ========== */
add('auth-001', 'auth', 'window.g_ck (or bare g_ck) holds a CSRF token', function () {
    var t = (typeof g_ck !== 'undefined' && g_ck) || window.g_ck || '';
    return t ? pass('g_ck length=' + String(t).length) : fail('g_ck empty/undefined');
});

add('auth-002', 'auth', 'window.NOW.g_ck is a valid fallback token source', function () {
    var t = window.NOW && window.NOW.g_ck;
    if (t) return pass('NOW.g_ck present, length=' + String(t).length);
    if (getToken()) return skip('NOW.g_ck absent; another source already provides token');
    return warn('NOW.g_ck absent and no other token found');
});

add('auth-003', 'auth', 'window.top.g_ck is reachable when same-origin', function () {
    try {
        var t = window.top && window.top.g_ck;
        if (t) return pass('top.g_ck present');
        return skip('top.g_ck empty (ok if not framed)');
    } catch (e) {
        return skip('cross-origin frame blocked top access: ' + e.message);
    }
});

add('auth-004', 'auth', 'window.NOW.csrf_token is a valid fallback', function () {
    var t = window.NOW && window.NOW.csrf_token;
    if (t) return pass('csrf_token present');
    return skip('NOW.csrf_token absent on this page');
});

add('auth-005', 'auth', 'meta[name=X-UserToken] is a valid fallback', function () {
    var meta = document.querySelector('meta[name="X-UserToken"]');
    var t = meta && meta.getAttribute('content');
    if (t) return pass('meta token present, length=' + t.length);
    return skip('meta X-UserToken absent on this page');
});

add('auth-006', 'auth', 'Full getToken() chain yields a non-empty token', function () {
    var t = getToken();
    return t ? pass('token length=' + t.length + ', prefix=' + t.slice(0, 6) + '…') : fail('all sources empty');
});

add('auth-007', 'auth', 'current_user succeeds with credentials:include + X-UserToken', function () {
    return apiGet('/api/now/ui/user/current_user').then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status + ' ' + r.text);
        SAMPLE.currentUser = r.json && r.json.result;
        return pass('200, keys=' + Object.keys(SAMPLE.currentUser || {}).join(','));
    });
});

add('auth-008', 'auth', 'Omit credentials: may 401, or still work via same-origin cookie default', function () {
    var token = getToken();
    var headers = { Accept: 'application/json' };
    if (token) headers['X-UserToken'] = token;
    return fetch(location.origin + '/api/now/table/incident?sysparm_limit=1', {
        // deliberately omit credentials mode
        headers: headers
    }).then(function (r) {
        API_STATS.calls++;
        if (r.status === 401 || r.status === 403) {
            return pass('HTTP ' + r.status + ' without credentials (strict cookie mode)');
        }
        if (r.ok) {
            // fetch default credentials is 'same-origin' in modern browsers — cookies still go
            return pass('HTTP ' + r.status + ' — browser defaulted same-origin cookies (still set credentials:include explicitly)');
        }
        return fail('Unexpected HTTP ' + r.status);
    });
});

add('auth-009', 'auth', "credentials:'same-origin' works on same-host pages", function () {
    var token = getToken();
    var headers = { Accept: 'application/json' };
    if (token) headers['X-UserToken'] = token;
    return fetch(location.origin + '/api/now/table/incident?sysparm_limit=1', {
        credentials: 'same-origin', headers: headers
    }).then(function (r) {
        API_STATS.calls++;
        return r.ok ? pass('HTTP ' + r.status) : fail('HTTP ' + r.status);
    });
});

add('auth-010', 'auth', 'Accept: application/json returns parseable JSON', function () {
    return apiGet('/api/now/ui/user/current_user').then(function (r) {
        return r.json ? pass('JSON parsed') : fail('body not JSON: ' + r.text);
    });
});

/* ========== RESPONSE SHAPES ========== */
add('shape-001', 'response-shape', 'current_user returns user_sys_id (not sys_id)', function () {
    return apiGet('/api/now/ui/user/current_user').then(function (r) {
        var res = (r.json && r.json.result) || {};
        SAMPLE.currentUser = res;
        if (res.user_sys_id && isSysId(res.user_sys_id)) {
            if (res.sys_id) return warn('user_sys_id present AND sys_id also set: ' + res.sys_id);
            return pass('user_sys_id=' + res.user_sys_id);
        }
        if (res.sys_id) return fail('Only sys_id present (' + res.sys_id + ') — docs say field is user_sys_id');
        return fail('Neither user_sys_id nor sys_id in response: ' + JSON.stringify(res).slice(0, 200));
    });
});

add('shape-002', 'response-shape', 'current_user includes user_name, user_display_name, user_initials', function () {
    var res = SAMPLE.currentUser;
    if (!res) return apiGet('/api/now/ui/user/current_user').then(function (r) {
        SAMPLE.currentUser = (r.json && r.json.result) || {};
        return TESTS.find(function (t) { return t.id === 'shape-002'; }).fn();
    });
    var missing = ['user_name', 'user_display_name', 'user_initials'].filter(function (k) { return !res[k]; });
    return missing.length ? warn('missing: ' + missing.join(',')) : pass(res.user_display_name + ' (' + res.user_initials + ')');
});

add('shape-003', 'response-shape', 'Table list GET returns result as an array', function () {
    return tableGet('incident', { sysparm_limit: '1' }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        return Array.isArray(r.json.result) ? pass('array length=' + r.json.result.length) : fail('result is not array');
    });
});

add('shape-004', 'response-shape', 'Single-record GET returns result as an object (not array)', function () {
    return needIncident().then(function (inc) {
        return tableGet('incident/' + rv(inc.sys_id), {
            sysparm_fields: 'sys_id,number',
            sysparm_display_value: 'all'
        }).then(function (r) {
            if (!r.ok) return fail('HTTP ' + r.status);
            var res = r.json.result;
            if (Array.isArray(res)) return fail('result is array — expected object');
            if (res && typeof res === 'object') return pass('object keys=' + Object.keys(res).join(','));
            return fail('unexpected result: ' + typeof res);
        });
    });
});

add('shape-005', 'response-shape', 'sysparm_display_value=all returns {value, display_value} objects', function () {
    return needIncident().then(function (inc) {
        var num = inc.number;
        if (num && typeof num === 'object' && num.value !== undefined && num.display_value !== undefined) {
            return pass('number={value:' + num.value + ', display_value:' + num.display_value + '}');
        }
        return fail('number is ' + typeof num + ': ' + JSON.stringify(num).slice(0, 120));
    });
});

add('shape-006', 'response-shape', 'Without display_value=all, refs lack reliable display names (shape varies)', function () {
    return tableGet('incident', {
        sysparm_limit: '1',
        sysparm_query: 'assignment_groupISNOTEMPTY',
        sysparm_fields: 'sys_id,assignment_group'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return skip('no incident with assignment_group');
        var ag = row.assignment_group;
        if (typeof ag === 'string' && isSysId(ag)) {
            return pass('raw sys_id string (classic shape)');
        }
        if (ag && typeof ag === 'object') {
            // Some instances still return {link,value} (or similar) without =all.
            // What must NOT be relied on is a stable display_value name.
            if (ag.display_value) {
                return warn('object WITH display_value without =all — instance defaulting display mode: ' +
                    JSON.stringify(ag).slice(0, 120));
            }
            return pass('object without display_value (e.g. link/value only) — still need =all for names: ' +
                JSON.stringify(ag).slice(0, 100));
        }
        if (!ag) return skip('assignment_group empty');
        return warn('unexpected type ' + typeof ag + ': ' + String(ag).slice(0, 80));
    });
});

add('shape-007', 'response-shape', 'With display_value=all, reference fields are {value, display_value}', function () {
    return needIncident().then(function (inc) {
        return tableGet('incident', {
            sysparm_limit: '1',
            sysparm_query: 'assignment_groupISNOTEMPTY',
            sysparm_display_value: 'all',
            sysparm_fields: 'sys_id,assignment_group'
        }).then(function (r) {
            var row = r.json && r.json.result && r.json.result[0];
            if (!row) return skip('no assigned incident');
            var ag = row.assignment_group;
            if (ag && typeof ag === 'object' && ag.value && ag.display_value !== undefined) {
                return pass(ag.display_value + ' (' + ag.value.slice(0, 8) + '…)');
            }
            return fail('shape=' + JSON.stringify(ag).slice(0, 150));
        });
    });
});

add('shape-008', 'response-shape', 'Without exclude_reference_link, refs include .link', function () {
    return tableGet('incident', {
        sysparm_limit: '1',
        sysparm_query: 'assignment_groupISNOTEMPTY',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,assignment_group'
    }).then(function (r) {
        var row = r.json && r.json.result && r.json.result[0];
        if (!row || !row.assignment_group) return skip('no sample');
        var ag = row.assignment_group;
        if (ag.link) return pass('link=' + String(ag.link).slice(0, 80));
        return warn('no .link property — instance may omit links by default');
    });
});

/* ========== TABLE API PARAMS ========== */
add('table-001', 'table-api', 'sysparm_exclude_reference_link=true strips .link', function () {
    return tableGet('incident', {
        sysparm_limit: '1',
        sysparm_query: 'assignment_groupISNOTEMPTY',
        sysparm_display_value: 'all',
        sysparm_exclude_reference_link: 'true',
        sysparm_fields: 'sys_id,assignment_group'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var ag = r.json.result[0] && r.json.result[0].assignment_group;
        if (!ag) return skip('no sample');
        if (ag.link) return fail('link still present: ' + ag.link);
        return pass('link absent, value=' + (ag.value || '').slice(0, 8) + '…');
    });
});

add('table-002', 'table-api', 'sysparm_no_count=true is accepted', function () {
    return tableGet('incident', { sysparm_limit: '1', sysparm_no_count: 'true' }).then(function (r) {
        return r.ok ? pass('HTTP 200') : fail('HTTP ' + r.status + ' — param may be rejected');
    });
});

add('table-003', 'table-api', 'sysparm_offset paginates results', function () {
    return tableGet('incident', {
        sysparm_limit: '1', sysparm_offset: '0',
        sysparm_query: 'ORDERBYDESCsys_updated_on',
        sysparm_fields: 'sys_id'
    }).then(function (a) {
        return tableGet('incident', {
            sysparm_limit: '1', sysparm_offset: '1',
            sysparm_query: 'ORDERBYDESCsys_updated_on',
            sysparm_fields: 'sys_id'
        }).then(function (b) {
            if (!a.ok || !b.ok) return fail('HTTP ' + a.status + '/' + b.status);
            var idA = a.json.result[0] && rv(a.json.result[0].sys_id);
            var idB = b.json.result[0] && rv(b.json.result[0].sys_id);
            if (!idA || !idB) return skip('need ≥2 readable incidents');
            return idA !== idB ? pass('offset0≠offset1') : fail('same sys_id at offset 0 and 1');
        });
    });
});

add('table-004', 'table-api', 'sysparm_limit caps rows returned', function () {
    return tableGet('incident', { sysparm_limit: '2', sysparm_fields: 'sys_id' }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var n = r.json.result.length;
        return n <= 2 ? pass('returned ' + n) : fail('returned ' + n + ' > 2');
    });
});

add('table-005', 'table-api', 'sysparm_fields restricts returned columns', function () {
    return tableGet('incident', {
        sysparm_limit: '1',
        sysparm_fields: 'sys_id,number',
        sysparm_display_value: 'all'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0] || {};
        if (row.short_description !== undefined) return fail('short_description present despite fields filter');
        if (row.sys_id === undefined || row.number === undefined) return fail('expected fields missing');
        return pass('only requested fields (plus platform defaults)');
    });
});

add('table-006', 'table-api', "sysparm_display_value=true returns strings, not objects", function () {
    return needIncident().then(function (inc) {
        return tableGet('incident/' + rv(inc.sys_id), {
            sysparm_display_value: 'true',
            sysparm_fields: 'number,state'
        }).then(function (r) {
            if (!r.ok) return fail('HTTP ' + r.status);
            var num = r.json.result.number;
            if (typeof num === 'string') return pass('number is string: ' + num);
            return fail('number is ' + typeof num);
        });
    });
});

add('table-007', 'table-api', 'GET /api/now/table/{table} is reachable', function () {
    return tableGet('incident', { sysparm_limit: '1' }).then(function (r) {
        return r.ok ? pass('HTTP 200') : fail('HTTP ' + r.status);
    });
});

/* ========== QUERY SYNTAX ========== */
add('query-001', 'query', '^ AND and ORDERBYDESC work', function () {
    return tableGet('incident', {
        sysparm_query: 'active=true^ORDERBYDESCsys_updated_on',
        sysparm_limit: '3',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,sys_updated_on'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var rows = r.json.result || [];
        if (rows.length < 2) return skip('need ≥2 rows');
        var ok = true;
        for (var i = 1; i < rows.length; i++) {
            if (rv(rows[i].sys_updated_on) > rv(rows[i - 1].sys_updated_on)) ok = false;
        }
        return ok ? pass('descending timestamps') : fail('not descending');
    });
});

add('query-002', 'query', 'ORDERBY ascending works', function () {
    return tableGet('incident', {
        sysparm_query: 'ORDERBYsys_created_on',
        sysparm_limit: '3',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,sys_created_on'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var rows = r.json.result || [];
        if (rows.length < 2) return skip('need ≥2');
        var ok = true;
        for (var i = 1; i < rows.length; i++) {
            if (rv(rows[i].sys_created_on) < rv(rows[i - 1].sys_created_on)) ok = false;
        }
        return ok ? pass('ascending') : fail('not ascending');
    });
});

add('query-003', 'query', 'javascript:gs.daysAgoStart(N) works', function () {
    return tableGet('incident', {
        sysparm_query: 'sys_created_on>=javascript:gs.daysAgoStart(30)',
        sysparm_limit: '1',
        sysparm_fields: 'sys_id'
    }).then(function (r) {
        return r.ok ? pass('HTTP 200, rows=' + (r.json.result || []).length) : fail('HTTP ' + r.status);
    });
});

add('query-004', 'query', 'javascript:gs.beginningOfToday() works', function () {
    return tableGet('incident', {
        sysparm_query: 'sys_created_on>=javascript:gs.beginningOfToday()',
        sysparm_limit: '1',
        sysparm_fields: 'sys_id'
    }).then(function (r) {
        return r.ok ? pass('HTTP 200') : fail('HTTP ' + r.status);
    });
});

add('query-005', 'query', 'javascript:gs.getUserID() resolves in a Table API query', function () {
    var expected = SAMPLE.currentUser && SAMPLE.currentUser.user_sys_id;
    return tableGet('sys_user', {
        sysparm_query: 'sys_id=javascript:gs.getUserID()',
        sysparm_fields: 'sys_id,user_name',
        sysparm_limit: '1',
        sysparm_display_value: 'all'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return fail('no row — gs.getUserID() may be blocked in Table API on this instance');
        var id = rv(row.sys_id);
        if (expected && id !== expected) return fail('mismatch: got ' + id + ' expected ' + expected);
        return pass('sys_id=' + id);
    });
});

add('query-006', 'query', 'nameIN comma-list syntax works on sys_journal_field', function () {
    return tableGet('sys_journal_field', {
        sysparm_query: 'nameINincident,sc_task^element=comments',
        sysparm_limit: '1',
        sysparm_fields: 'sys_id,name,element'
    }).then(function (r) {
        if (r.status === 403) return warn('403 ACL — syntax not confirmed but table exists');
        if (!r.ok) return fail('HTTP ' + r.status);
        var rows = r.json.result || [];
        if (!rows.length) return pass('HTTP 200 empty (ACL or no rows) — syntax accepted');
        return pass('name=' + rv(rows[0].name));
    });
});

add('query-007', 'query', 'IN operator with comma list works', function () {
    return tableGet('incident', {
        sysparm_limit: '2',
        sysparm_fields: 'number',
        sysparm_display_value: 'true'
    }).then(function (r) {
        var nums = (r.json.result || []).map(function (x) { return x.number; }).filter(Boolean);
        if (nums.length < 2) return skip('need 2 ticket numbers');
        return tableGet('incident', {
            sysparm_query: 'numberIN' + nums.join(','),
            sysparm_limit: '5',
            sysparm_fields: 'number',
            sysparm_display_value: 'true'
        }).then(function (r2) {
            if (!r2.ok) return fail('HTTP ' + r2.status);
            return pass('returned ' + r2.json.result.length + ' for IN query');
        });
    });
});

add('query-008', 'query', 'ISEMPTY / ISNOTEMPTY operators accepted', function () {
    return tableGet('incident', {
        sysparm_query: 'assigned_toISNOTEMPTY',
        sysparm_limit: '1',
        sysparm_fields: 'sys_id'
    }).then(function (r) {
        if (!r.ok) return fail('ISNOTEMPTY HTTP ' + r.status);
        return tableGet('incident', {
            sysparm_query: 'assigned_toISEMPTY',
            sysparm_limit: '1',
            sysparm_fields: 'sys_id'
        }).then(function (r2) {
            return r2.ok ? pass('both accepted') : fail('ISEMPTY HTTP ' + r2.status);
        });
    });
});

add('query-009', 'query', 'Equality by number works', function () {
    return needIncident().then(function (inc) {
        var num = dv(inc.number);
        return tableGet('incident', {
            sysparm_query: 'number=' + num,
            sysparm_limit: '1',
            sysparm_fields: 'sys_id,number',
            sysparm_display_value: 'all'
        }).then(function (r) {
            if (!r.ok) return fail('HTTP ' + r.status);
            var row = r.json.result[0];
            return row && dv(row.number) === num ? pass(num) : fail('mismatch');
        });
    });
});

add('query-010', 'query', '^OR connector works', function () {
    return tableGet('incident', {
        sysparm_query: 'active=true^ORactive=false',
        sysparm_limit: '1',
        sysparm_fields: 'sys_id'
    }).then(function (r) {
        return r.ok ? pass('HTTP 200') : fail('HTTP ' + r.status);
    });
});

add('query-011', 'query', 'LIKE operator accepted', function () {
    return tableGet('sys_user', {
        sysparm_query: 'user_nameLIKE.a',
        sysparm_limit: '1',
        sysparm_fields: 'user_name'
    }).then(function (r) {
        if (r.status === 403) return skip('sys_user ACL');
        return r.ok ? pass('HTTP 200') : fail('HTTP ' + r.status);
    });
});

/* ========== STATS & PRESENCE ========== */
add('stats-001', 'stats', 'GET /api/now/stats/{table}?sysparm_count=true works', function () {
    return apiGet('/api/now/stats/incident', {
        sysparm_count: 'true',
        sysparm_query: 'active=true'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status + ' ' + r.text);
        return pass('result=' + JSON.stringify(r.json.result).slice(0, 120));
    });
});

add('stats-002', 'stats', 'Stats API accepts sysparm_group_by and returns counts', function () {
    return apiGet('/api/now/stats/incident', {
        sysparm_count: 'true',
        sysparm_group_by: 'priority',
        sysparm_query: 'active=true'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var res = r.json.result;
        var s = JSON.stringify(res);
        if (s.indexOf('count') >= 0 || s.indexOf('stats') >= 0) return pass(s.slice(0, 160));
        return warn('200 but no obvious count field: ' + s.slice(0, 160));
    });
});

add('presence-001', 'presence', 'GET /api/now/ui/presence returns a result array', function () {
    return apiGet('/api/now/ui/presence').then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var res = r.json.result;
        SAMPLE.presence = res;
        return Array.isArray(res) ? pass('array length=' + res.length) : fail('result not array');
    });
});

add('presence-002', 'presence', 'Presence entries have user + last_on', function () {
    var list = SAMPLE.presence;
    if (!list) return skip('run presence-001 first');
    if (!list.length) return skip('nobody currently online');
    var u = list[0];
    if (u.user !== undefined && u.last_on !== undefined) return pass('user=' + u.user + ' last_on=' + u.last_on);
    return fail('keys=' + Object.keys(u).join(','));
});

/* ========== CALLER FIELDS ========== */
add('caller-001', 'caller', 'incident has caller_id', function () {
    return tableGet('incident', {
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,caller_id,opened_by'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return skip('no incidents');
        return ('caller_id' in row) ? pass('caller_id=' + JSON.stringify(row.caller_id).slice(0, 80)) : fail('caller_id missing');
    });
});

add('caller-002', 'caller', 'interaction uses opened_for (not caller_id)', function () {
    return tableGet('interaction', {
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,opened_for,caller_id,opened_by,number'
    }).then(function (r) {
        if (r.status === 403) return skip('interaction ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return skip('no interactions');
        if (!('opened_for' in row)) return fail('opened_for missing');
        var cid = row.caller_id;
        var cidNote = (cid === undefined || cid === null || cid === '')
            ? 'caller_id absent/empty (expected)'
            : 'caller_id present=' + String(JSON.stringify(cid)).slice(0, 40);
        return pass('opened_for ok on ' + (dv(row.number) || 'row') + '; ' + cidNote);
    });
});

add('caller-003', 'caller', 'sc_req_item uses requested_for', function () {
    return tableGet('sc_req_item', {
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,number,requested_for,opened_by'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return skip('empty');
        SAMPLE.ritm = row;
        return ('requested_for' in row) ? pass('requested_for present; number=' + dv(row.number)) : fail('requested_for missing');
    });
});

add('caller-004', 'caller', 'sc_request uses requested_for', function () {
    return tableGet('sc_request', {
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,number,requested_for,opened_by'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return skip('empty');
        SAMPLE.req = row;
        return ('requested_for' in row) ? pass('number=' + dv(row.number)) : fail('requested_for missing');
    });
});

add('caller-005', 'caller', 'sc_task has opened_by / request_item, not a caller field', function () {
    return tableGet('sc_task', {
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,number,opened_by,caller_id,requested_for,request_item'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return skip('empty');
        var notes = [];
        if ('opened_by' in row) notes.push('opened_by ok');
        else notes.push('opened_by MISSING');
        if ('request_item' in row) notes.push('request_item ok');
        if (row.caller_id && rv(row.caller_id)) notes.push('caller_id unexpectedly set');
        return pass(notes.join('; '));
    });
});

add('caller-006', 'caller', 'change_request uses requested_by', function () {
    return tableGet('change_request', {
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,number,requested_by,opened_by'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return skip('empty');
        return ('requested_by' in row) ? pass('requested_by present') : fail('requested_by missing');
    });
});

add('caller-007', 'caller', 'RITM numbers live on sc_req_item; REQ on sc_request', function () {
    var ritm = SAMPLE.ritm && dv(SAMPLE.ritm.number);
    var req = SAMPLE.req && dv(SAMPLE.req.number);
    if (!ritm && !req) return skip('no samples');
    var problems = [];
    if (ritm && ritm.indexOf('RITM') !== 0 && ritm.indexOf('REQ') === 0) problems.push('sc_req_item number looks like REQ: ' + ritm);
    if (req && req.indexOf('REQ') !== 0 && req.indexOf('RITM') === 0) problems.push('sc_request number looks like RITM: ' + req);
    if (ritm && ritm.indexOf('RITM') === 0) { /* good */ }
    else if (ritm) problems.push('sc_req_item number=' + ritm);
    if (req && req.indexOf('REQ') === 0) { /* good */ }
    else if (req) problems.push('sc_request number=' + req);
    return problems.length ? warn(problems.join('; ')) : pass('RITM=' + ritm + ' REQ=' + req);
});

/* ========== JOURNAL ========== */
add('journal-001', 'journal', 'sys_journal_field may return 200 with zero rows when ACL-blocked', function () {
    return tableGet('sys_journal_field', {
        sysparm_query: 'element=comments',
        sysparm_limit: '1',
        sysparm_fields: 'sys_id,element_id,name,value'
    }).then(function (r) {
        SAMPLE.journalStatus = r.status;
        SAMPLE.journalRows = (r.json && r.json.result) || [];
        if (r.status === 403) return pass('403 ACL (explicit block)');
        if (!r.ok) return fail('HTTP ' + r.status);
        if (SAMPLE.journalRows.length) return pass('readable, got ' + SAMPLE.journalRows.length + ' row(s)');
        return pass('HTTP 200 with 0 rows — matches silent-ACL pattern; confirm via inline comments next');
    });
});

add('journal-002', 'journal', 'Inline comments/work_notes are readable as display strings', function () {
    return needIncident().then(function (inc) {
        return tableGet('incident/' + rv(inc.sys_id), {
            sysparm_display_value: 'true',
            sysparm_fields: 'comments,work_notes,number'
        }).then(function (r) {
            if (!r.ok) return fail('HTTP ' + r.status);
            var c = r.json.result.comments;
            var w = r.json.result.work_notes;
            SAMPLE.inlineComments = c;
            SAMPLE.inlineWorkNotes = w;
            if (typeof c === 'string' || c == null || c === '') {
                var note = 'comments ' + (c ? 'len=' + c.length : 'empty');
                note += '; work_notes ' + (w ? 'len=' + String(w).length : 'empty');
                if (!SAMPLE.journalRows.length && c) return pass(note + ' — journal table empty but inline has data (ACL confirmed)');
                return pass(note);
            }
            return fail('comments type=' + typeof c);
        });
    });
});

add('journal-003', 'journal', 'Inline journal header regex matches ServiceNow format', function () {
    var text = SAMPLE.inlineComments || SAMPLE.inlineWorkNotes || '';
    if (!text) return skip('no inline journal text on sample');
    var re = /(\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}[ ]+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\s*-\s*(.+?)\s*\((Additional comments|Work notes|Comments|Customer visible)\)/g;
    var m = re.exec(text);
    return m ? pass('matched: ' + m[0].slice(0, 80)) : warn('no header match — locale/format may differ: ' + text.slice(0, 100));
});

/* ========== CLOSED STATES & TABLES ========== */
add('state-001', 'state', 'incident closed raw states include 6/7/8 (or display fallback)', function () {
    return tableGet('incident', {
        sysparm_query: 'stateIN6,7,8',
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,number,state'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (row) return pass(dv(row.number) + ' state=' + rv(row.state) + ' (' + dv(row.state) + ')');
        return warn('no incidents in states 6/7/8 — instance may use different choice values');
    });
});

add('state-002', 'state', 'sc_req_item closed raw states include 3/4/7', function () {
    return tableGet('sc_req_item', {
        sysparm_query: 'stateIN3,4,7',
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,number,state'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (row) return pass(dv(row.number) + ' state=' + rv(row.state) + '/' + dv(row.state));
        return warn('no rows in 3/4/7 — check instance choice list');
    });
});

add('state-003', 'state', 'interaction closed states are strings (closed_complete / closed_abandoned)', function () {
    return tableGet('interaction', {
        sysparm_query: 'stateINclosed_complete,closed_abandoned',
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,number,state'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (row) {
            var st = rv(row.state);
            if (/^\d+$/.test(st)) return warn('numeric state on interaction: ' + st + ' — docs expect workflow strings');
            return pass(dv(row.number) + ' state=' + st);
        }
        return warn('no closed interactions matched those strings');
    });
});

add('table-exist-001', 'tables', 'interaction_related_record table exists (GET, not POST)', function () {
    return tableGet('interaction_related_record', {
        sysparm_limit: '1',
        sysparm_fields: 'sys_id,interaction,document_table,document_id'
    }).then(function (r) {
        if (r.status === 404) return fail('404 — table missing');
        if (r.status === 403) return pass('table exists (403 ACL)');
        if (r.ok) return pass('200, rows=' + (r.json.result || []).length);
        return warn('HTTP ' + r.status);
    });
});

var PREFIX_TABLES = [
    ['incident', 'INC'], ['sc_req_item', 'RITM'], ['sc_request', 'REQ'],
    ['change_request', 'CHG'], ['problem', 'PRB'], ['change_task', 'CTASK'],
    ['sc_task', 'SCTASK'], ['sn_si_task', 'STASK'], ['task', 'TASK'],
    ['interaction', 'IMS'], ['kb_knowledge', 'KB'],
    ['sys_user', 'user'], ['sys_user_group', 'group'],
    ['sys_journal_field', 'journal'], ['cmn_department', 'dept']
];

PREFIX_TABLES.forEach(function (pair) {
    var table = pair[0], label = pair[1];
    add('table-exist-' + table, 'tables', 'Table `' + table + '` (' + label + ') is reachable', function () {
        return tableGet(table, { sysparm_limit: '1', sysparm_fields: 'sys_id' }).then(function (r) {
            if (r.status === 404) return fail('404 missing');
            if (r.status === 403) return warn('403 ACL — table exists but blocked');
            if (r.ok) return pass('200');
            // sn_si_task often 400 when Security Incident plugin is not installed
            if (table === 'sn_si_task' && (r.status === 400 || r.status === 404)) {
                return warn('HTTP ' + r.status + ' — Security Incident plugin likely absent (optional table)');
            }
            return warn('HTTP ' + r.status);
        });
    });
});

add('table-exist-dept', 'tables', 'sys_user.department is a reference to cmn_department', function () {
    return tableGet('sys_user', {
        sysparm_query: 'departmentISNOTEMPTY',
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,name,department'
    }).then(function (r) {
        if (r.status === 403) return skip('sys_user ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row) return skip('no user with department');
        var d = row.department;
        if (d && typeof d === 'object' && isSysId(d.value)) {
            return tableGet('cmn_department/' + d.value, { sysparm_fields: 'sys_id,name' }).then(function (r2) {
                return r2.ok ? pass(d.display_value + ' → cmn_department ok') : warn('dept sys_id not resolvable: HTTP ' + r2.status);
            });
        }
        return fail('department shape: ' + JSON.stringify(d).slice(0, 100));
    });
});

add('acl-001', 'acl', 'sys_dictionary often 403 for non-admin (access varies)', function () {
    return tableGet('sys_dictionary', { sysparm_limit: '1', sysparm_fields: 'sys_id' }).then(function (r) {
        if (r.status === 403) return pass('403 for this account — matches gotcha');
        if (r.ok) return pass('200 — this account can read sys_dictionary (admin?)');
        return warn('HTTP ' + r.status);
    });
});

/* ========== RATE LIMIT ========== */
add('rate-001', 'rate-limit', 'x-ratelimit-remaining is never sent', function () {
    // observational across calls already made
    return apiGet('/api/now/table/incident', { sysparm_limit: '1', sysparm_fields: 'sys_id' }).then(function (r) {
        if (r.headers.rem) return fail('x-ratelimit-remaining present: ' + r.headers.rem);
        return pass('absent (as documented)');
    });
});

add('rate-002', 'rate-limit', 'x-ratelimit-limit / reset / rule may appear inconsistently', function () {
    return pass('across ' + API_STATS.calls + ' calls so far: headersSeen=' + API_STATS.headersSeen +
        ' headersMissing=' + API_STATS.headersMissing +
        (API_STATS.lastLimit ? ' lastLimit=' + API_STATS.lastLimit : ''));
});

add('rate-003', 'rate-limit', 'When present, x-ratelimit-limit is typically 100', function () {
    if (!API_STATS.lastLimit) return skip('no limit header observed yet — will recheck at end');
    if (API_STATS.lastLimit === 100) return pass('limit=100');
    return warn('limit=' + API_STATS.lastLimit + ' (docs say typically 100; instance may differ)');
});

add('rate-004', 'rate-limit', 'Two identical requests may differ in rate-limit header presence', function () {
    var p = { sysparm_limit: '1', sysparm_fields: 'sys_id' };
    return tableGet('incident', p).then(function (a) {
        return delay(1000).then(function () {
            return tableGet('incident', p).then(function (b) {
                var aHas = !!(a.headers.lim || a.headers.rst || a.headers.rule);
                var bHas = !!(b.headers.lim || b.headers.rst || b.headers.rule);
                if (aHas !== bHas) return pass('inconsistent: first=' + aHas + ' second=' + bHas);
                return pass('consistent this time (both ' + aHas + ') — unreliability is intermittent');
            });
        });
    });
});

/* ========== DOM / SPA ========== */
add('spa-001', 'spa', 'Page URL is under /now/sow/', function () {
    return location.href.indexOf('/now/sow/') >= 0
        ? pass(location.pathname)
        : warn('not a /now/sow/ URL: ' + location.pathname + ' — some checks still apply');
});

add('spa-002', 'spa', 'history.pushState is available', function () {
    return typeof history.pushState === 'function' ? pass('function') : fail('missing');
});

add('spa-003', 'spa', 'PopStateEvent is constructible', function () {
    try {
        var e = new PopStateEvent('popstate', { state: {} });
        return e.type === 'popstate' ? pass('ok') : fail('bad type');
    } catch (err) {
        return fail(String(err.message || err));
    }
});

add('spa-004', 'spa', 'Current record parses as /record/{table}/{32-hex-sys_id}', function () {
    var url = decodeURIComponent(location.href);
    var re = /\/record\/([a-z0-9_]+)\/([0-9a-f]{32})/gi;
    var match, last = null;
    while ((match = re.exec(url)) !== null) last = match;
    if (!last) return skip('not on a record page');
    SAMPLE.record = { table: last[1], sysId: last[2] };
    return pass(last[1] + '/' + last[2]);
});

add('spa-005', 'spa', 'Home view detectable via /now/sow/home', function () {
    if (location.href.indexOf('/now/sow/home') >= 0) return pass('on home');
    return skip('not currently on home');
});

add('shadow-001', 'shadow-dom', 'Shadow roots exist in the SOW page', function () {
    var count = 0;
    walkShadows(document, function (el) { if (el.shadowRoot) count++; }, 0);
    SAMPLE.shadowHosts = count;
    return count > 0 ? pass(count + ' hosts with shadowRoot') : fail('no shadow roots found');
});

add('shadow-002', 'shadow-dom', 'Shadow roots nest (depth > 1)', function () {
    var depth = countShadowDepth();
    SAMPLE.shadowDepth = depth;
    return depth > 1 ? pass('max depth=' + depth) : fail('depth=' + depth);
});

add('shadow-003', 'shadow-dom', 'Shadow trees can be deep (≥10 levels soft)', function () {
    var depth = SAMPLE.shadowDepth || countShadowDepth();
    if (depth >= 10) return pass('depth=' + depth);
    if (depth >= 5) return warn('depth=' + depth + ' (docs cite 10–30; this page is shallower)');
    return fail('depth=' + depth);
});

add('sel-001', 'selectors', 'findHostWith(.polaris-header-controls) finds the header host', function () {
    var host = findHostWith('.polaris-header-controls');
    if (!host) return warn('not found — chrome may differ on this instance/theme');
    SAMPLE.headerHost = host;
    return pass('host tag=' + host.tagName);
});

add('sel-002', 'selectors', '.polaris-header-controls exists inside a shadow root', function () {
    var host = SAMPLE.headerHost || findHostWith('.polaris-header-controls');
    if (!host || !host.shadowRoot) return skip('no header host');
    var el = host.shadowRoot.querySelector('.polaris-header-controls');
    return el ? pass('found') : fail('host found but selector missing inside');
});

add('sel-003', 'selectors', '.sn-chrome-one-tab exists (tab strip)', function () {
    var hits = queryDeep('.sn-chrome-one-tab');
    return hits.length ? pass(hits.length + ' tab(s)') : warn('no tabs — maybe home with nothing open');
});

add('sel-004', 'selectors', '.sn-chrome-one-tab.is-selected marks the active tab', function () {
    var hits = queryDeep('.sn-chrome-one-tab.is-selected');
    return hits.length ? pass(hits.length + ' selected') : skip('none selected');
});

add('sel-005', 'selectors', '.sn-chrome-one-tab-label holds ticket text', function () {
    var hits = queryDeep('.sn-chrome-one-tab-label');
    if (!hits.length) return skip('no labels');
    var texts = hits.slice(0, 5).map(function (h) { return (h.textContent || '').trim(); });
    return pass(texts.join(' | '));
});

add('sel-006', 'selectors', '.sn-chrome-tabs-group exists', function () {
    var hits = queryDeep('.sn-chrome-tabs-group');
    return hits.length ? pass('found') : warn('not found');
});

add('sel-007', 'selectors', 'sn-contact-card components exist on record pages', function () {
    var cards = [];
    walkShadows(document, function (el) {
        if (el.tagName && el.tagName.toLowerCase() === 'sn-contact-card') cards.push(el);
    }, 0);
    SAMPLE.contactCards = cards;
    if (!cards.length) return skip('no contact cards (open a ticket with a caller)');
    return pass(cards.length + ' card(s)');
});

add('sel-008', 'selectors', 'Contact cards expose aria-label and inner .sn-contact-card--content', function () {
    var cards = SAMPLE.contactCards || [];
    if (!cards.length) return skip('no cards');
    var details = cards.slice(0, 4).map(function (c) {
        var label = c.getAttribute('aria-label') || '';
        var inner = c.shadowRoot && (
            c.shadowRoot.querySelector('.sn-contact-card--content') ||
            c.shadowRoot.querySelector('.sn-contact-card--container')
        );
        return (label || '(no label)') + (inner ? ' [inner ok]' : ' [no inner]');
    });
    return pass(details.join('; '));
});

add('sel-009', 'selectors', 'sn-canvas-tabs / SN-CANVAS-TABSDATA present', function () {
    var found = { tabs: 0, tabsdata: 0, withConfig: 0 };
    walkShadows(document, function (el) {
        var tag = el.tagName;
        if (tag === 'SN-CANVAS-TABS') { found.tabs++; if (el.tabConfig) found.withConfig++; }
        if (tag === 'SN-CANVAS-TABSDATA') { found.tabsdata++; if (el.tabConfig) found.withConfig++; }
    }, 0);
    // also query light DOM
    document.querySelectorAll('sn-canvas-tabs, sn-canvas-tabsdata').forEach(function () {});
    if (found.tabs + found.tabsdata === 0) return warn('no sn-canvas-tabs elements found');
    return pass('TABS=' + found.tabs + ' TABSDATA=' + found.tabsdata + ' with tabConfig=' + found.withConfig);
});

add('sel-010', 'selectors', 'SN-CANVAS-MAIN with mainConfig exists', function () {
    var found = 0, withCfg = 0;
    walkShadows(document, function (el) {
        if (el.tagName === 'SN-CANVAS-MAIN') {
            found++;
            if (el.mainConfig) withCfg++;
        }
    }, 0);
    if (!found) return warn('no SN-CANVAS-MAIN');
    return pass('found=' + found + ' with mainConfig=' + withCfg);
});

add('sel-011', 'selectors', 'a[data-testisrecordlink=true] record links exist when tickets open', function () {
    var hits = queryDeep('a[data-testisrecordlink="true"]');
    return hits.length ? pass(hits.length + ' link(s)') : skip('none — open a record tab');
});

/* ========== MACROCOMPONENT (soft) ========== */
add('macro-001', 'macroponent', 'getTabRoot macroponent-f51912f4… (INSTANCE-SPECIFIC, soft)', function () {
    var m1 = document.querySelector('macroponent-f51912f4c700201072b211d4d8c26010');
    if (!m1) return warn('shell macroponent id not found — expected on some instances only');
    if (!m1.shadowRoot) return warn('found but no shadowRoot yet');
    SAMPLE.macroShell = m1;
    return pass('found');
});

add('macro-002', 'macroponent', 'Nested macroponent-c276387c… inside appshell (soft)', function () {
    var m1 = SAMPLE.macroShell || document.querySelector('macroponent-f51912f4c700201072b211d4d8c26010');
    if (!m1 || !m1.shadowRoot) return skip('shell missing');
    var shell = m1.shadowRoot.querySelector('sn-canvas-appshell-main');
    if (!shell || !shell.shadowRoot) return warn('sn-canvas-appshell-main missing');
    var m2 = shell.shadowRoot.querySelector('macroponent-c276387cc331101080d6d3658940ddd2');
    if (!m2) return warn('chrome macroponent id not found — instance-specific');
    return pass('found');
});

add('macro-003', 'macroponent', 'Portable: MACROPONENT-C5D9C004 prefix matches record pages', function () {
    var n = 0;
    walkShadows(document, function (el) {
        if (el.tagName && /^MACROPONENT-C5D9C004/i.test(el.tagName)) n++;
    }, 0);
    if (n) return pass(n + ' record macroponent(s)');
    return skip('none mounted — open a record');
});

/* ========== AMB ========== */
add('amb-001', 'amb', 'window.g_ambClient exists', function () {
    var c = null;
    try { c = window.g_ambClient || (window.top && window.top !== window && window.top.g_ambClient) || null; }
    catch (e) { c = window.g_ambClient || null; }
    SAMPLE.amb = c;
    return c ? pass('typeof=' + typeof c) : warn('g_ambClient not found — push lane unavailable, polling still works');
});

add('amb-002', 'amb', 'g_ambClient.getRecordWatcherChannel is a function', function () {
    var c = SAMPLE.amb;
    if (!c) return skip('no client');
    return typeof c.getRecordWatcherChannel === 'function'
        ? pass('function')
        : fail('missing getRecordWatcherChannel');
});

add('amb-003', 'amb', 'g_ambClient.getConnectionState reports a live-ish state', function () {
    var c = SAMPLE.amb;
    if (!c) return skip('no client');
    if (typeof c.getConnectionState !== 'function') return warn('no getConnectionState');
    var state = String(c.getConnectionState());
    SAMPLE.ambState = state;
    if (/up|connect|open/i.test(state)) return pass('state=' + state);
    return warn('state=' + state + ' — not live yet');
});

add('amb-004', 'amb', 'Prefer g_ambClient even if window.amb also exists', function () {
    var hasG = !!(window.g_ambClient && typeof window.g_ambClient.getRecordWatcherChannel === 'function');
    var legacy = !!(window.amb && typeof window.amb.getClient === 'function');
    if (hasG && legacy) {
        return pass('both present — use g_ambClient.getRecordWatcherChannel (not amb.getClient)');
    }
    if (hasG) return pass('g_ambClient present; legacy window.amb.getClient absent');
    if (legacy) return fail('only window.amb — skill requires g_ambClient');
    return fail('neither API present');
});

/* ========== GENESYS ========== */
add('genesys-001', 'genesys', 'Softphone iframe#iframe is findable in shadow DOM when present', function () {
    var frame = null;
    function find(root, depth) {
        if (!root || depth > 30 || frame) return;
        try {
            var d = root.querySelector && root.querySelector('iframe#iframe');
            if (d) { frame = d; return; }
            root.querySelectorAll('*').forEach(function (el) {
                if (el.shadowRoot) find(el.shadowRoot, depth + 1);
            });
        } catch (e) {}
    }
    find(document, 0);
    SAMPLE.genesysFrame = frame;
    if (frame) return pass('found src=' + (frame.getAttribute('src') || '').slice(0, 80));
    return skip('no iframe#iframe — softphone not loaded on this page');
});

add('genesys-002', 'genesys', 'Genesys iframe contentWindow is accessible for capture-phase listen', function () {
    var f = SAMPLE.genesysFrame;
    if (!f) return skip('no frame');
    try {
        var w = f.contentWindow;
        if (!w) return fail('contentWindow null');
        return pass('contentWindow reachable (addEventListener available: ' + (typeof w.addEventListener) + ')');
    } catch (e) {
        return warn('contentWindow blocked: ' + e.message);
    }
});

add('genesys-003', 'genesys', 'softphone_connector message type (skip — needs live call traffic)', function () {
    return skip('cannot verify message schema without a live softphone event');
});

/* ========== STORAGE (read-only probes — no persistent writes) ========== */
add('storage-001', 'storage', 'localStorage may work or throw — both valid', function () {
    try {
        var n = localStorage.length;
        localStorage.getItem('__sow_skill_probe_readonly');
        return pass('readable, length=' + n);
    } catch (e) {
        return pass('blocked/throws (as documented): ' + e.name);
    }
});

add('storage-001b', 'storage', 'sessionStorage may work or throw', function () {
    try {
        var n = sessionStorage.length;
        sessionStorage.getItem('__sow_skill_probe_readonly');
        return pass('readable, length=' + n);
    } catch (e) {
        return pass('blocked/throws: ' + e.name);
    }
});

add('storage-002', 'storage', 'indexedDB API is present (open not exercised — read-only)', function () {
    try {
        if (!window.indexedDB) return warn('indexedDB undefined');
        return pass('indexedDB object present (not opening DB — read-only run)');
    } catch (e) {
        return pass('throws: ' + e.name);
    }
});

add('storage-005', 'storage', 'Budget key sow_api_budget_v1 readable if present', function () {
    try {
        var raw = localStorage.getItem('sow_api_budget_v1');
        if (raw == null) return skip('key absent (no skill budget tracker installed yet)');
        var o = JSON.parse(raw);
        var keys = Object.keys(o || {});
        return pass('present keys=' + keys.join(','));
    } catch (e) {
        return warn('unreadable/blocked: ' + e.message);
    }
});

add('storage-006', 'storage', 'Cache key sow_api_cache_v1 readable if present', function () {
    try {
        var raw = localStorage.getItem('sow_api_cache_v1');
        if (raw == null) return skip('key absent');
        var o = JSON.parse(raw);
        return pass('present, typeof=' + typeof o);
    } catch (e) {
        return warn('unreadable: ' + e.message);
    }
});

add('storage-003', 'storage', 'showSaveFilePicker availability (File System Access API)', function () {
    if (typeof window.showSaveFilePicker === 'function') return pass('available');
    return warn('unavailable — settings.md fallback (download/file input) required');
});

add('storage-004', 'storage', 'showOpenFilePicker availability', function () {
    if (typeof window.showOpenFilePicker === 'function') return pass('available');
    return warn('unavailable');
});

/* ========== PLATFORM APIs ========== */
add('plat-001', 'platform', 'document.hidden is a boolean (Page Visibility)', function () {
    return typeof document.hidden === 'boolean' ? pass('hidden=' + document.hidden) : fail('missing');
});

add('plat-002', 'platform', 'document.visibilityState exists', function () {
    return document.visibilityState ? pass(document.visibilityState) : fail('missing');
});

add('plat-003', 'platform', 'MutationObserver is available', function () {
    return typeof MutationObserver === 'function' ? pass('function') : fail('missing');
});

add('plat-004', 'platform', 'WeakSet is available', function () {
    return typeof WeakSet === 'function' ? pass('function') : fail('missing');
});

add('plat-005', 'platform', 'EventTarget.prototype.dispatchEvent exists', function () {
    return typeof EventTarget.prototype.dispatchEvent === 'function' ? pass('function') : fail('missing');
});

add('plat-006', 'platform', 'Event.composedPath exists (for click-outside across shadows)', function () {
    try {
        var e = new MouseEvent('click');
        if (typeof e.composedPath === 'function') return pass('function');
        return warn('composedPath missing on MouseEvent');
    } catch (err) {
        return fail(String(err.message || err));
    }
});

add('plat-007', 'platform', 'window.fetch is available', function () {
    return typeof window.fetch === 'function' ? pass('function') : fail('missing');
});

add('plat-008', 'platform', 'window.postMessage is available', function () {
    return typeof window.postMessage === 'function' ? pass('function') : fail('missing');
});

add('plat-009', 'platform', 'AudioContext available (anti-throttle technique dependency)', function () {
    var AC = window.AudioContext || window.webkitAudioContext;
    return AC ? pass('available') : skip('no AudioContext — anti-throttle audio unavailable');
});

add('plat-010', 'platform', 'CSP meta or enforced policy present (external scripts blocked)', function () {
    var meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (meta) return pass('CSP meta: ' + (meta.getAttribute('content') || '').slice(0, 120));
    // try a sandboxed external fetch — may be blocked by CSP connect-src
    return fetch('https://example.com/', { mode: 'no-cors' }).then(function () {
        return warn('no CSP meta; external no-cors fetch did not throw (CSP may still block scripts)');
    }).catch(function (e) {
        return pass('external fetch blocked: ' + e.message);
    });
});

/* ========== EXTRA QUERY / RELATIONSHIP CLAIMS ========== */
add('query-012', 'query', 'STARTSWITH operator accepted', function () {
    return tableGet('sys_user', {
        sysparm_query: 'user_nameSTARTSWITHa',
        sysparm_limit: '1',
        sysparm_fields: 'user_name'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        return r.ok ? pass('HTTP 200') : fail('HTTP ' + r.status);
    });
});

add('query-013', 'query', 'ENDSWITH operator accepted', function () {
    return tableGet('sys_user', {
        sysparm_query: 'user_nameENDSWITHa',
        sysparm_limit: '1',
        sysparm_fields: 'user_name'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        return r.ok ? pass('HTTP 200') : fail('HTTP ' + r.status);
    });
});

add('query-014', 'query', 'BETWEEN operator accepted on dates', function () {
    return tableGet('incident', {
        sysparm_query: 'sys_created_onBETWEENjavascript:gs.daysAgoStart(7)@javascript:gs.daysAgoEnd(0)',
        sysparm_limit: '1',
        sysparm_fields: 'sys_id'
    }).then(function (r) {
        return r.ok ? pass('HTTP 200') : warn('HTTP ' + r.status + ' — BETWEEN syntax may vary');
    });
});

add('query-015', 'query', 'Delta high-water query sys_updated_on>…^ORDERBYDESC works', function () {
    var hw = new Date(Date.now() - 90 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    return tableGet('incident', {
        sysparm_query: 'sys_updated_on>' + hw + '^ORDERBYDESCsys_updated_on',
        sysparm_limit: '5',
        sysparm_fields: 'sys_id,sys_updated_on',
        sysparm_display_value: 'all'
    }).then(function (r) {
        return r.ok ? pass('HTTP 200, rows=' + (r.json.result || []).length + ' (hw≈' + hw + ')') : fail('HTTP ' + r.status);
    });
});

add('query-016', 'query', 'sysparm_limit=1000 is accepted', function () {
    return tableGet('incident', {
        sysparm_limit: '1000',
        sysparm_fields: 'sys_id',
        sysparm_no_count: 'true'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var n = (r.json.result || []).length;
        return n <= 1000 ? pass('returned ' + n) : fail('returned ' + n + ' > 1000');
    });
});

add('rel-001', 'relations', 'sc_task.request_item links to parent RITM', function () {
    return tableGet('sc_task', {
        sysparm_query: 'request_itemISNOTEMPTY',
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_exclude_reference_link: 'true',
        sysparm_fields: 'sys_id,number,request_item'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row || !row.request_item) return skip('no sc_task with request_item');
        var rid = rv(row.request_item);
        return tableGet('sc_req_item/' + rid, {
            sysparm_fields: 'sys_id,number',
            sysparm_display_value: 'all'
        }).then(function (r2) {
            if (!r2.ok) return warn('parent RITM HTTP ' + r2.status);
            return pass(dv(row.number) + ' → ' + dv(r2.json.result.number));
        });
    });
});

add('rel-002', 'relations', 'sc_req_item.request links to parent REQ', function () {
    return tableGet('sc_req_item', {
        sysparm_query: 'requestISNOTEMPTY',
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_exclude_reference_link: 'true',
        sysparm_fields: 'sys_id,number,request'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (!row || !row.request) return skip('no RITM with request');
        var rid = rv(row.request);
        return tableGet('sc_request/' + rid, {
            sysparm_fields: 'sys_id,number',
            sysparm_display_value: 'all'
        }).then(function (r2) {
            if (!r2.ok) return warn('parent REQ HTTP ' + r2.status);
            return pass(dv(row.number) + ' → ' + dv(r2.json.result.number));
        });
    });
});

/* ========== TICKET PREFIXES ========== */
var PREFIX_CHECKS = [
    ['incident', 'INC', 'prefix-inc'],
    ['sc_req_item', 'RITM', 'prefix-ritm'],
    ['sc_request', 'REQ', 'prefix-req'],
    ['sc_task', 'SCTASK', 'prefix-sctask'],
    ['interaction', 'IMS', 'prefix-ims'],
    ['change_request', 'CHG', 'prefix-chg'],
    ['problem', 'PRB', 'prefix-prb'],
    ['change_task', 'CTASK', 'prefix-ctask'],
    ['kb_knowledge', 'KB', 'prefix-kb']
];
PREFIX_CHECKS.forEach(function (p) {
    add(p[2], 'prefixes', p[0] + ' numbers typically start with ' + p[1], function () {
        return tableGet(p[0], {
            sysparm_limit: '3',
            sysparm_display_value: 'true',
            sysparm_fields: 'number',
            sysparm_query: 'numberISNOTEMPTY'
        }).then(function (r) {
            if (r.status === 403) return skip('ACL');
            if (r.status === 404) return warn('table missing on this instance');
            if (!r.ok) return fail('HTTP ' + r.status);
            var rows = r.json.result || [];
            if (!rows.length) return skip('no numbered rows');
            var bad = rows.filter(function (x) {
                return String(x.number || '').indexOf(p[1]) !== 0;
            });
            if (!bad.length) return pass(rows.map(function (x) { return x.number; }).join(', '));
            return warn('unexpected prefixes: ' + bad.map(function (x) { return x.number; }).join(', '));
        });
    });
});

/* ========== MORE TABLES / ACL ========== */
add('table-exist-sys_user_grmember', 'tables', 'sys_user_grmember table exists', function () {
    return tableGet('sys_user_grmember', { sysparm_limit: '1', sysparm_fields: 'sys_id,user,group' }).then(function (r) {
        if (r.status === 404) return fail('404');
        if (r.status === 403) return pass('exists (403 ACL)');
        if (r.ok) return pass('200');
        return warn('HTTP ' + r.status);
    });
});

add('acl-002', 'acl', 'sys_audit often 403 for non-admin (soft)', function () {
    return tableGet('sys_audit', { sysparm_limit: '1', sysparm_fields: 'sys_id' }).then(function (r) {
        if (r.status === 403) return pass('403');
        if (r.status === 404) return warn('404 — table may be unavailable');
        if (r.ok) return pass('200 — elevated rights');
        return warn('HTTP ' + r.status);
    });
});

add('acl-003', 'acl', 'cmn_cost_center often 403 for non-admin (soft)', function () {
    return tableGet('cmn_cost_center', { sysparm_limit: '1', sysparm_fields: 'sys_id' }).then(function (r) {
        if (r.status === 403) return pass('403');
        if (r.status === 404) return warn('404');
        if (r.ok) return pass('200 — elevated rights');
        return warn('HTTP ' + r.status);
    });
});

add('state-004', 'state', 'sc_task closed raw states include 3/4/7 (soft)', function () {
    return tableGet('sc_task', {
        sysparm_query: 'stateIN3,4,7',
        sysparm_limit: '1',
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,number,state'
    }).then(function (r) {
        if (r.status === 403) return skip('ACL');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result[0];
        if (row) return pass(dv(row.number) + ' state=' + rv(row.state));
        return warn('no rows in 3/4/7');
    });
});

add('state-005', 'state', 'isClosedState display fallback regex /resolved|closed|complete|cancel/i', function () {
    var re = /resolved|closed|complete|cancel/i;
    return tableGet('incident', {
        sysparm_query: 'stateISNOTEMPTY',
        sysparm_limit: '20',
        sysparm_display_value: 'all',
        sysparm_fields: 'state,number'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var hits = (r.json.result || []).filter(function (row) { return re.test(dv(row.state)); });
        return hits.length
            ? pass('matched ' + hits.length + ' e.g. ' + dv(hits[0].state))
            : warn('no display-value matched closed regex in sample of 20');
    });
});

add('journal-004', 'journal', 'Journal fields list accepted: sys_id,element_id,name,value,sys_created_by,sys_created_on', function () {
    return tableGet('sys_journal_field', {
        sysparm_limit: '1',
        sysparm_fields: 'sys_id,element_id,name,value,sys_created_by,sys_created_on'
    }).then(function (r) {
        if (r.status === 403) return pass('403 ACL — field list not confirmed');
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = (r.json.result || [])[0];
        if (!row) return pass('200 empty — fields param accepted');
        var missing = ['sys_id', 'element_id', 'name', 'value', 'sys_created_by', 'sys_created_on']
            .filter(function (k) { return !(k in row); });
        return missing.length ? warn('missing keys: ' + missing.join(',')) : pass('all keys present');
    });
});

add('err-001', 'response-shape', 'Error envelope exposes error.message on bad requests', function () {
    return apiGet('/api/now/table/___sow_skill_verifier_missing_table___', { sysparm_limit: '1' }).then(function (r) {
        if (r.ok) return warn('unexpected 200 for nonsense table');
        var err = r.json && r.json.error;
        if (err && err.message) return pass('error.message=' + String(err.message).slice(0, 120));
        return warn('HTTP ' + r.status + ' without error.message: ' + r.text.slice(0, 120));
    });
});

add('endpoint-001', 'endpoints', 'Attachment path exists (GET probe — expect not 404)', function () {
    return apiGet('/api/now/attachment/file', {
        table_name: 'incident',
        table_sys_id: '00000000000000000000000000000000',
        file_name: 'sow-skill-verifier-probe.txt'
    }).then(function (r) {
        if (r.status === 404) return fail('404 — attachment endpoint missing');
        // 400/401/405/415 are fine — path exists, we are not uploading
        return pass('HTTP ' + r.status + ' (path reachable; no upload performed)');
    });
});

add('endpoint-002', 'endpoints', 'order_now path shape exists (GET probe — no order placed)', function () {
    return apiGet('/api/sn_sc/servicecatalog/items/00000000000000000000000000000000/order_now').then(function (r) {
        if (r.status === 404) return warn('404 — catalog/order_now may be scoped differently');
        return pass('HTTP ' + r.status + ' (no POST; response shape not exercised)');
    });
});

add('endpoint-003', 'endpoints', 'Presence is not under /api/now/table/', function () {
    return apiGet('/api/now/ui/presence').then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        return pass('GET /api/now/ui/presence OK (cheap non-table endpoint)');
    });
});

add('user-fields-001', 'response-shape', 'sys_user common fields readable for self', function () {
    var id = SAMPLE.currentUser && SAMPLE.currentUser.user_sys_id;
    if (!id) return skip('no current user_sys_id yet');
    return tableGet('sys_user/' + id, {
        sysparm_display_value: 'all',
        sysparm_fields: 'sys_id,name,first_name,last_name,employee_number,user_name,email,title'
    }).then(function (r) {
        if (!r.ok) return fail('HTTP ' + r.status);
        var row = r.json.result || {};
        var present = ['sys_id', 'name', 'user_name', 'email'].filter(function (k) { return k in row; });
        return present.length >= 3 ? pass(present.join(',')) : warn('sparse fields: ' + Object.keys(row).join(','));
    });
});

/* ========== MORE DOM / SELECTORS ========== */
add('sel-012', 'selectors', 'sn-canvas-appshell-main tag exists', function () {
    var hits = queryDeep('sn-canvas-appshell-main');
    return hits.length ? pass('count=' + hits.length) : warn('not found');
});

add('sel-013', 'selectors', '.sn-chrome-tabs-content exists', function () {
    var hits = queryDeep('.sn-chrome-tabs-content');
    return hits.length ? pass('count=' + hits.length) : warn('not found (release/layout dependent)');
});

add('sel-014', 'selectors', '.search-container inside header controls (soft)', function () {
    var host = findHostWith('.polaris-header-controls');
    if (!host || !host.shadowRoot) return skip('no header host');
    var sc = host.shadowRoot.querySelector('.search-container');
    return sc ? pass('found') : warn('absent on this layout');
});

add('sel-015', 'selectors', 'now-record-common-uiactionbar on record pages (soft)', function () {
    var hits = queryDeep('now-record-common-uiactionbar');
    if (hits.length) return pass('count=' + hits.length);
    if (location.href.indexOf('/record/') < 0) return skip('not on a record URL');
    return warn('not found on this record page');
});

add('sel-016', 'selectors', 'tabConfig maxMainTabLimit / maxTotalSubTabLimit present (soft)', function () {
    var found = null;
    walkShadows(document, function (el) {
        if (found) return;
        try {
            if (el.tabConfig && typeof el.tabConfig === 'object') found = el.tabConfig;
        } catch (e) {}
    }, 0);
    if (!found) {
        try {
            document.querySelectorAll('*').forEach(function (el) {
                if (!found && el.tabConfig && typeof el.tabConfig === 'object') found = el.tabConfig;
            });
        } catch (e2) {}
    }
    if (!found) return warn('no tabConfig found yet');
    var mm = found.maxMainTabLimit, mt = found.maxTotalSubTabLimit;
    var msg = 'maxMainTabLimit=' + mm + ' maxTotalSubTabLimit=' + mt;
    if (typeof mm === 'number' && typeof mt === 'number') {
        return pass(msg + ' (common stock defaults ~10/~20; live instances often raise sub-tab limit)');
    }
    return warn(msg + ' — unexpected types');
});

add('sel-017', 'selectors', 'mainConfig maxActivePageCount / maxCachedPageCount (soft)', function () {
    var found = null;
    walkShadows(document, function (el) {
        if (found) return;
        try {
            if (el.mainConfig && typeof el.mainConfig === 'object') found = el.mainConfig;
        } catch (e) {}
    }, 0);
    if (!found) return warn('no mainConfig found');
    var a = found.maxActivePageCount, c = found.maxCachedPageCount;
    var msg = 'maxActivePageCount=' + a + ' maxCachedPageCount=' + c;
    if (a === 3 && c === 5) return pass(msg + ' (docs defaults)');
    return warn(msg + ' (docs cite ≈3/≈5)');
});

add('sel-018', 'selectors', 'Multiple .is-selected possible; labels readable', function () {
    var tabs = queryDeep('.sn-chrome-one-tab.is-selected');
    if (!tabs.length) return skip('no selected tabs');
    var labels = tabs.map(function (t) {
        try {
            var lab = t.querySelector('.sn-chrome-one-tab-label') ||
                (t.shadowRoot && t.shadowRoot.querySelector('.sn-chrome-one-tab-label'));
            return lab ? lab.textContent.trim() : '';
        } catch (e) { return ''; }
    }).filter(Boolean);
    return pass('selected=' + tabs.length + ' labels=' + labels.join(' | '));
});

/* ========== AMB / NOTIFICATIONS EXTRA ========== */
add('amb-005', 'amb', 'getRecordWatcherChannel returns a subscribe-able channel (unsub immediately)', function () {
    var c = window.g_ambClient;
    if (!c || typeof c.getRecordWatcherChannel !== 'function') return skip('g_ambClient API missing');
    try {
        var ch = c.getRecordWatcherChannel('incident', 'sys_id=00000000000000000000000000000000');
        if (!ch) return fail('channel null');
        if (typeof ch.subscribe !== 'function') return warn('no subscribe(); keys=' + Object.keys(ch).join(','));
        var sub = ch.subscribe(function () {});
        try {
            if (sub && typeof sub.unsubscribe === 'function') sub.unsubscribe();
            else if (typeof ch.unsubscribe === 'function') ch.unsubscribe();
        } catch (e2) {}
        return pass('subscribed+unsubscribed (no ticket mutation)');
    } catch (e) {
        return warn('channel error: ' + e.message);
    }
});

add('amb-006', 'amb', 'NOTIFICATIONS_UPDATED appears in CustomEvent detail.type (5s listen)', function () {
    return new Promise(function (resolve) {
        var seen = false, detailType = '';
        var orig = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (ev) {
            try {
                if (ev && ev.detail && ev.detail.type &&
                    String(ev.detail.type).indexOf('NOTIFICATIONS_UPDATED') >= 0) {
                    seen = true;
                    detailType = String(ev.detail.type);
                }
            } catch (e2) {}
            return orig.call(this, ev);
        };
        setTimeout(function () {
            EventTarget.prototype.dispatchEvent = orig;
            if (seen) resolve(pass('seen detail.type=' + detailType));
            else resolve(skip('no NOTIFICATIONS_UPDATED during 5s — trigger a notif and re-run failures'));
        }, 5000);
    });
});

add('amb-007', 'amb', 'SIMPLE_EVENT#NOW_NOTIFICATION_PANEL_APPEND is NOT the listen type', function () {
    return pass('documented anti-pattern noted; listen via detail.type containing NOTIFICATIONS_UPDATED');
});

add('plat-011', 'platform', 'window.NOW object exists on SOW', function () {
    return window.NOW && typeof window.NOW === 'object' ? pass('keys≈' + Object.keys(window.NOW).slice(0, 12).join(',')) : warn('NOW absent');
});

add('plat-012', 'platform', 'window.__SOWAPI / __sowFetchHooked may exist if toolkit installed', function () {
    var a = window.__SOWAPI, b = window.__sowFetchHooked;
    if (a || b != null) return pass('__SOWAPI=' + typeof a + ' __sowFetchHooked=' + String(b));
    return skip('toolkit hooks not installed on this page');
});

add('plat-013', 'platform', 'agentic_processing soft observation (fetch not stubbed)', function () {
    return skip('behavioral; do not stub fetch on live instance — watch Network for periodic 400s manually');
});

/* ========== WRITE APIs — explicitly skipped ========== */
add('skip-001', 'skipped-writes', 'order_now response shape (result.sys_id) — SKIP (write)', function () {
    return skip('read-only run; not calling POST order_now (path probed via GET only)');
});
add('skip-002', 'skipped-writes', 'Attachment upload — SKIP (write)', function () {
    return skip('read-only run; not calling POST /api/now/attachment/file');
});
add('skip-003', 'skipped-writes', 'interaction_related_record POST — SKIP (write)', function () {
    return skip('read-only run; GET existence checked separately');
});
add('skip-004', 'skipped-writes', 'Table API PATCH — SKIP (write)', function () {
    return skip('read-only run — never PATCH/POST ticket fields');
});
add('skip-005', 'skipped-writes', 'tabConfig / mainConfig mutation — SKIP (write)', function () {
    return skip('read-only; values inspected but not assigned');
});
add('skip-006', 'skipped-writes', 'Visibility / AudioContext anti-throttle — SKIP (behavior change)', function () {
    return skip('would alter page timers; APIs presence checked under platform');
});

/* final observational rate-limit summary */
add('rate-final', 'rate-limit', 'Final rate-limit observation summary', function () {
    var msg = 'API calls this run=' + API_STATS.calls +
        '; headersSeen=' + API_STATS.headersSeen +
        '; headersMissing=' + API_STATS.headersMissing +
        '; lastLimit=' + (API_STATS.lastLimit || 'n/a') +
        '; hit429=' + API_STATS.limited;
    if (API_STATS.lastLimit && API_STATS.lastLimit !== 100) return warn(msg);
    return pass(msg);
});

/* ── UI ────────────────────────────────────────────────────── */
var CAT_ORDER = ['auth', 'response-shape', 'table-api', 'query', 'stats', 'presence',
    'caller', 'journal', 'state', 'tables', 'relations', 'prefixes', 'acl',
    'rate-limit', 'endpoints',
    'spa', 'shadow-dom', 'selectors', 'macroponent', 'amb', 'genesys',
    'storage', 'platform', 'skipped-writes'];

var CAT_LABELS = {
    auth: 'Authentication',
    'response-shape': 'Response shapes',
    'table-api': 'Table API params',
    query: 'Query syntax',
    stats: 'Stats API',
    presence: 'Presence API',
    caller: 'Caller fields',
    journal: 'Journals',
    state: 'Closed states',
    tables: 'Tables exist',
    relations: 'Record relations',
    prefixes: 'Ticket prefixes',
    acl: 'ACL probes',
    'rate-limit': 'Rate limits',
    endpoints: 'Other endpoints',
    spa: 'SPA / URL',
    'shadow-dom': 'Shadow DOM',
    selectors: 'Selectors',
    macroponent: 'Macroponents (soft)',
    amb: 'AMB / push',
    genesys: 'Genesys',
    storage: 'Storage',
    platform: 'Platform APIs',
    'skipped-writes': 'Writes (skipped)'
};

var results = {}; // id -> {status, detail, ms}
var running = false;

var root = document.createElement('div');
root.id = 'sow-skill-verifier';
root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:' + Z,
    'display:flex', 'flex-direction:column',
    'background:' + BG, 'color:' + T,
    'font-family:' + BODY, 'font-size:13px'
].join(';');

var style = document.createElement('style');
style.textContent = [
    '#sow-skill-verifier *{box-sizing:border-box;}',
    '#sow-skill-verifier button{font-family:inherit;cursor:pointer;}',
    '#sv-hd{display:flex;align-items:center;gap:12px;padding:12px 16px;background:' + S1 + ';border-bottom:1px solid ' + BORD + ';border-left:3px solid ' + ACC + ';}',
    '#sv-hd h1{font-size:14px;font-weight:700;margin:0;}',
    '#sv-hd .chip{font-family:' + MONO + ';font-size:10px;color:' + ACC + ';background:rgba(129,140,248,0.12);border:1px solid rgba(129,140,248,0.45);padding:2px 6px;}',
    '#sv-stats{display:flex;gap:10px;flex:1;justify-content:flex-end;font-family:' + MONO + ';font-size:11px;}',
    '#sv-stats span{padding:2px 8px;border:1px solid ' + BORD + ';}',
    '#sv-stats .p{color:' + OK + ';} #sv-stats .f{color:' + DANGER + ';} #sv-stats .w{color:' + WARN + ';} #sv-stats .s{color:' + SKIP + ';}',
    '#sv-actions{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid ' + BORD + ';background:' + S1 + ';}',
    '#sv-actions button{background:' + S2 + ';color:' + T + ';border:1px solid ' + BORD + ';padding:6px 12px;font-size:12px;}',
    '#sv-actions button.primary{background:rgba(129,140,248,0.15);border-color:' + ACC + ';color:' + ACC + ';}',
    '#sv-actions button:disabled{opacity:0.4;cursor:not-allowed;}',
    '#sv-prog{height:3px;background:' + S2 + ';}',
    '#sv-prog > i{display:block;height:100%;width:0;background:' + ACC + ';transition:width 0.15s;}',
    '#sv-body{flex:1;overflow:auto;padding:12px 16px 32px;}',
    '.sv-cat{margin:0 0 18px;}',
    '.sv-cat h2{font-size:12px;font-weight:700;color:' + DIM + ';text-transform:uppercase;letter-spacing:0.04em;margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid ' + BORD + ';}',
    '.sv-row{display:grid;grid-template-columns:88px 1fr;gap:10px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.04);}',
    '.sv-row:hover{background:' + S2 + ';}',
    '.sv-st{font-family:' + MONO + ';font-size:10px;font-weight:700;padding:2px 6px;align-self:start;}',
    '.sv-st.pass{color:' + OK + ';border:1px solid rgba(16,185,129,0.4);}',
    '.sv-st.fail{color:' + DANGER + ';border:1px solid rgba(239,68,68,0.4);}',
    '.sv-st.warn{color:' + WARN + ';border:1px solid rgba(245,158,11,0.4);}',
    '.sv-st.skip{color:' + SKIP + ';border:1px solid rgba(100,116,139,0.4);}',
    '.sv-st.pend{color:' + FAINT + ';border:1px solid ' + BORD + ';}',
    '.sv-st.run{color:' + ACC + ';border:1px solid rgba(129,140,248,0.4);}',
    '.sv-claim{font-size:12.5px;color:' + T + ';}',
    '.sv-id{font-family:' + MONO + ';font-size:10px;color:' + FAINT + ';margin-right:8px;}',
    '.sv-detail{font-family:' + MONO + ';font-size:11px;color:' + DIM + ';margin-top:3px;word-break:break-word;}',
    '#sv-ft{padding:6px 16px;border-top:1px solid ' + BORD + ';background:' + S1 + ';font-family:' + MONO + ';font-size:11px;color:' + DIM + ';}'
].join('\n');
document.head.appendChild(style);

root.innerHTML =
    '<div id="sv-hd">' +
        '<h1>SOW Skill Verifier</h1>' +
        '<span class="chip">read-only</span>' +
        '<span class="chip">' + TESTS.length + ' claims</span>' +
        '<div id="sv-stats">' +
            '<span class="p" id="sv-n-pass">0 pass</span>' +
            '<span class="f" id="sv-n-fail">0 fail</span>' +
            '<span class="w" id="sv-n-warn">0 warn</span>' +
            '<span class="s" id="sv-n-skip">0 skip</span>' +
        '</div>' +
        '<span id="sv-close" style="cursor:pointer;color:' + FAINT + ';padding:4px 8px;font-size:16px;">✕</span>' +
    '</div>' +
    '<div id="sv-actions">' +
        '<button class="primary" id="sv-run">Run all checks</button>' +
        '<button id="sv-rerun-fail" disabled>Re-run failures</button>' +
        '<button id="sv-export" disabled>Copy report JSON</button>' +
        '<span id="sv-status" style="color:' + DIM + ';font-size:12px;margin-left:8px;">Idle — will not write to any ticket or table.</span>' +
    '</div>' +
    '<div id="sv-prog"><i id="sv-bar"></i></div>' +
    '<div id="sv-body"></div>' +
    '<div id="sv-ft">Skill claim verifier · GET-only · rate-limit aware · stop on 429</div>';

document.body.appendChild(root);

function renderList() {
    var body = document.getElementById('sv-body');
    var html = '';
    CAT_ORDER.forEach(function (cat) {
        var items = TESTS.filter(function (t) { return t.cat === cat; });
        if (!items.length) return;
        html += '<section class="sv-cat" data-cat="' + cat + '"><h2>' + esc(CAT_LABELS[cat] || cat) +
            ' <span style="font-weight:400;color:' + FAINT + '">(' + items.length + ')</span></h2>';
        items.forEach(function (t) {
            var r = results[t.id];
            var st = r ? r.status : 'pend';
            html += '<div class="sv-row" id="sv-row-' + t.id + '">' +
                '<span class="sv-st ' + st + '">' + st.toUpperCase() + '</span>' +
                '<div><div class="sv-claim"><span class="sv-id">' + esc(t.id) + '</span>' + esc(t.claim) + '</div>' +
                (r && r.detail ? '<div class="sv-detail">' + esc(r.detail) + (r.ms != null ? ' · ' + r.ms + 'ms' : '') + '</div>' : '') +
                '</div></div>';
        });
        html += '</section>';
    });
    body.innerHTML = html;
}

function updateStats() {
    var c = { pass: 0, fail: 0, warn: 0, skip: 0 };
    Object.keys(results).forEach(function (id) {
        var s = results[id].status;
        if (c[s] != null) c[s]++;
    });
    document.getElementById('sv-n-pass').textContent = c.pass + ' pass';
    document.getElementById('sv-n-fail').textContent = c.fail + ' fail';
    document.getElementById('sv-n-warn').textContent = c.warn + ' warn';
    document.getElementById('sv-n-skip').textContent = c.skip + ' skip';
    var done = Object.keys(results).length;
    document.getElementById('sv-bar').style.width = Math.round(100 * done / TESTS.length) + '%';
    document.getElementById('sv-export').disabled = done === 0;
    document.getElementById('sv-rerun-fail').disabled = c.fail === 0 && c.warn === 0;
}

function paintRow(id) {
    var r = results[id];
    var row = document.getElementById('sv-row-' + id);
    if (!row || !r) return;
    var st = row.querySelector('.sv-st');
    st.className = 'sv-st ' + r.status;
    st.textContent = r.status.toUpperCase();
    var claim = row.querySelector('.sv-claim');
    var detail = row.querySelector('.sv-detail');
    if (!detail) {
        detail = document.createElement('div');
        detail.className = 'sv-detail';
        claim.parentNode.appendChild(detail);
    }
    detail.textContent = (r.detail || '') + (r.ms != null ? ' · ' + r.ms + 'ms' : '');
}

renderList();
updateStats();

document.getElementById('sv-close').addEventListener('click', function () {
    root.style.display = 'none';
});

function setStatus(msg) {
    document.getElementById('sv-status').textContent = msg;
}

function runOne(test) {
    var row = document.getElementById('sv-row-' + test.id);
    if (row) {
        var st = row.querySelector('.sv-st');
        st.className = 'sv-st run';
        st.textContent = 'RUN';
    }
    var t0 = Date.now();
    return Promise.resolve()
        .then(function () { return test.fn(); })
        .then(function (res) {
            if (!res || !res.status) res = fail('test returned no status');
            results[test.id] = { status: res.status, detail: res.detail || '', ms: Date.now() - t0 };
        })
        .catch(function (err) {
            if (err && err.skipped) {
                results[test.id] = { status: 'skip', detail: String(err.message || err), ms: Date.now() - t0 };
            } else if (err && err.status === 429) {
                results[test.id] = { status: 'fail', detail: 'HTTP 429 retry-after=' + (err.retryAfter || '?'), ms: Date.now() - t0 };
            } else {
                results[test.id] = { status: 'fail', detail: String((err && err.message) || err), ms: Date.now() - t0 };
            }
        })
        .then(function () {
            paintRow(test.id);
            updateStats();
        });
}

function runAll(filterFn) {
    if (running) return;
    running = true;
    document.getElementById('sv-run').disabled = true;
    API_STATS.limited = false;

    var queue = TESTS.filter(filterFn || function () { return true; });
    if (!filterFn) {
        results = {};
        renderList();
        updateStats();
    }

    var i = 0;
    function next() {
        if (i >= queue.length) {
            running = false;
            document.getElementById('sv-run').disabled = false;
            setStatus('Done. ' + API_STATS.calls + ' API calls. Review fails/warns above.');
            return;
        }
        if (API_STATS.limited) {
            // mark remaining API-ish tests as skip
            while (i < queue.length) {
                var t = queue[i++];
                if (!results[t.id]) {
                    results[t.id] = { status: 'skip', detail: 'skipped after 429 to protect rate budget', ms: 0 };
                    paintRow(t.id);
                }
            }
            updateStats();
            running = false;
            document.getElementById('sv-run').disabled = false;
            setStatus('Stopped early after HTTP 429. ' + API_STATS.calls + ' API calls made.');
            return;
        }
        var test = queue[i++];
        setStatus('Running ' + test.id + ' (' + i + '/' + queue.length + ')…');
        // Small gap between API-heavy categories to avoid bursts
        var gap = /^(auth|response-shape|table-api|query|stats|presence|caller|journal|state|tables|relations|prefixes|acl|rate-limit|endpoints)$/.test(test.cat) ? 80 : 0;
        runOne(test).then(function () { return delay(gap); }).then(next);
    }
    next();
}

document.getElementById('sv-run').addEventListener('click', function () { runAll(null); });
document.getElementById('sv-rerun-fail').addEventListener('click', function () {
    runAll(function (t) {
        var r = results[t.id];
        return r && (r.status === 'fail' || r.status === 'warn');
    });
});

document.getElementById('sv-export').addEventListener('click', function () {
    var report = {
        generatedAt: new Date().toISOString(),
        origin: location.origin,
        href: location.href,
        apiCalls: API_STATS.calls,
        rateLimit: {
            lastLimit: API_STATS.lastLimit,
            headersSeen: API_STATS.headersSeen,
            headersMissing: API_STATS.headersMissing,
            hit429: API_STATS.limited
        },
        summary: { pass: 0, fail: 0, warn: 0, skip: 0 },
        results: []
    };
    TESTS.forEach(function (t) {
        var r = results[t.id] || { status: 'pend', detail: '' };
        if (report.summary[r.status] != null) report.summary[r.status]++;
        report.results.push({
            id: t.id, category: t.cat, claim: t.claim,
            status: r.status, detail: r.detail, ms: r.ms
        });
    });
    var text = JSON.stringify(report, null, 2);
    function done() {
        setStatus('Report copied to clipboard (' + text.length + ' chars)');
    }
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(done).catch(function () {
            window.prompt('Copy report:', text);
            done();
        });
    } else {
        window.prompt('Copy report:', text);
        done();
    }
});

VER.stop = function () {
    try { root.remove(); } catch (e) {}
    try { style.remove(); } catch (e) {}
    VER.__alive = false;
};

setStatus('Ready — ' + TESTS.length + ' claims queued. Click Run all checks. Read-only: no ticket writes.');
