# AMB (Asynchronous Message Bus) / CometD

ServiceNow uses AMB (built on CometD/Bayeux protocol) for real-time server push.
SOW uses it internally for notifications, record updates, and presence. You can
tap into the same bus or work with its effects.

## How AMB Works in SOW

AMB runs over long-polling or WebSocket (depending on instance config) at
`/amb/handshake`, `/amb/connect`, and `/amb/subscribe`.

You do not need to speak that protocol. SOW already has a connected client on
the page, and it exposes a record-watcher helper that handles channel naming for
you.

## Subscribing to Record Watchers

The client to use is `window.g_ambClient`. Some SOW pages also expose
`window.amb.getClient()`, but record watchers in this skill go through
`g_ambClient.getRecordWatcherChannel(table, query)` — there is no separate
`getClient()` step on that path. Do not hand-build `/rw/default/...` channel
paths; ask for a channel by table and encoded query:

```javascript
function ambClient() {
    try {
        return window.g_ambClient ||
            (window.top && window.top !== window && window.top.g_ambClient) || null;
    } catch (e) {
        return window.g_ambClient || null;
    }
}

function ambConnected(c) {
    try {
        return c && typeof c.getConnectionState === 'function'
            ? /up|connect|open/i.test(String(c.getConnectionState()))
            : !!c;
    } catch (e) { return false; }
}

var ambSubs = [];

function subscribeAmb(tables, filter, onPush) {
    unsubscribeAmb();
    var c = ambClient();
    if (!c || typeof c.getRecordWatcherChannel !== 'function' || !ambConnected(c)) {
        return false;                       // fall back to polling
    }
    try {
        tables.forEach(function(table) {
            var ch = c.getRecordWatcherChannel(table, filter);
            ambSubs.push(ch.subscribe(function() { onPush(table); }));
        });
        return true;
    } catch (e) {
        return false;
    }
}

function unsubscribeAmb() {
    ambSubs.forEach(function(s) {
        try { s.unsubscribe ? s.unsubscribe() : s(); } catch (e) {}
    });
    ambSubs = [];
}
```

The filter is an ordinary encoded query, e.g. `'assigned_toIN' + sysIds.join(',')`.

Three things to plan for:

- **The client may not be ready** when your bookmarklet runs. Check
  `getConnectionState()` and retry on an interval (around 20s) rather than
  assuming a single attempt is definitive.
- **Treat a push as a trigger, not as data.** The message does not carry a
  trustworthy diff. Use it to run the delta poll you already have.
- **Always keep the polling lane.** If AMB never connects, or drops silently, the
  poller is what keeps the tool working. See `polling-scheduler.md`.

## Intercepting AMB-Driven Notifications

When AMB delivers a notification, SOW dispatches a custom event to insert it into
the UI. The event is a generic CustomEvent, so match on **`detail.type`** — there
is no event *named* `SIMPLE_EVENT#NOW_NOTIFICATION_PANEL_APPEND`, and checking
`event.type` never fires:

```javascript
var origDispatch = EventTarget.prototype.dispatchEvent;
var pendingMessages = [];

EventTarget.prototype.dispatchEvent = function(e) {
    if (e && e.detail && e.detail.type &&
        e.detail.type.indexOf('NOTIFICATIONS_UPDATED') >= 0) {
        try {
            var p = e.detail.payload;
            if (p && p.notifications && p.notifications.length) {
                p.notifications.forEach(function(n) {
                    var msg = (n.message || '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (msg) {
                        pendingMessages.push(msg);
                        onNotification(msg, n);
                    }
                });
            }
        } catch (ex) {}
    }
    return origDispatch.apply(this, arguments);
};

// Cleanup
function restoreDispatch() {
    EventTarget.prototype.dispatchEvent = origDispatch;
}
```

This gives you the message text but does not stop the banner appearing. To
suppress the focus-stealing alert as well, pair it with the `now-alert` DOM
interception in `injection.md`.

### Record Change Detection via Polling

For detecting changes to specific records (assignment changes, state transitions,
comments), AMB channel subscription is fragile across instances. The robust
alternative is delta polling: periodically query the Table API for records you
care about and diff against saved snapshots.

```javascript
// Poll every N seconds for changes to tracked tickets
var POLL_INTERVAL = 15000; // 15 seconds
var snapshots = {};        // 'table|sysId' -> last known state

function pollForChanges(trackedTickets) {
    // Group by table to minimize API calls
    var byTable = {};
    trackedTickets.forEach(function(t) {
        if (!byTable[t.table]) byTable[t.table] = [];
        byTable[t.table].push(t.sysId);
    });

    var promises = Object.keys(byTable).map(function(table) {
        var ids = byTable[table];
        var query = 'sys_idIN' + ids.join(',');
        return snGet(table, query,
            ['sys_id', 'number', 'state', 'assignment_group',
             'assigned_to', 'sys_updated_on', 'short_description'],
            ids.length
        ).then(function(rows) {
            return rows.map(function(r) {
                r.__table = table;
                return r;
            });
        });
    });

    return Promise.all(promises).then(function(groups) {
        var events = [];
        groups.forEach(function(rows) {
            rows.forEach(function(r) {
                var key = r.__table + '|' + rv(r.sys_id);
                var old = snapshots[key];
                var cur = {
                    state: rv(r.state),
                    stateDv: dv(r.state),
                    group: rv(r.assignment_group),
                    groupDv: dv(r.assignment_group),
                    assign: rv(r.assigned_to),
                    assignDv: dv(r.assigned_to),
                    updatedOn: rv(r.sys_updated_on)
                };

                if (old && old.updatedOn !== cur.updatedOn) {
                    // Something changed -- diff it
                    if (old.group !== cur.group) {
                        events.push({
                            type: 'group_change',
                            number: dv(r.number),
                            from: old.groupDv,
                            to: cur.groupDv
                        });
                    }
                    if (old.assign !== cur.assign) {
                        events.push({
                            type: 'assignee_change',
                            number: dv(r.number),
                            from: old.assignDv,
                            to: cur.assignDv
                        });
                    }
                    if (old.state !== cur.state) {
                        events.push({
                            type: 'state_change',
                            number: dv(r.number),
                            from: old.stateDv,
                            to: cur.stateDv
                        });
                    }
                }

                snapshots[key] = cur;
            });
        });
        return events;
    });
}

var pollTimer = setInterval(function() {
    if (document.hidden) return; // save budget when tab is hidden
    pollForChanges(myTrackedTickets).then(function(events) {
        events.forEach(function(evt) {
            toast(evt.number + ': ' + evt.type + ' ' + evt.from + ' -> ' + evt.to);
        });
    });
}, POLL_INTERVAL);
```

### High-Water Mark Optimization

To avoid re-fetching unchanged records, track the highest `sys_updated_on`
value seen per table and only query for records updated since then:

```javascript
var highWaterMark = {}; // table -> 'yyyy-MM-dd HH:mm:ss' (UTC)

function deltaQuery(table, baseQuery, fields, limit) {
    var hwm = highWaterMark[table];
    var query = baseQuery;
    if (hwm) {
        query += '^sys_updated_on>' + hwm;
    }
    query += '^ORDERBYDESCsys_updated_on';

    return snGet(table, query, fields, limit).then(function(rows) {
        // Update high-water mark from results
        rows.forEach(function(r) {
            var updated = rv(r.sys_updated_on);
            if (!highWaterMark[table] || updated > highWaterMark[table]) {
                highWaterMark[table] = updated;
            }
        });
        return rows;
    });
}
```

This means subsequent polls only return records that changed since the last
poll, dramatically reducing response size and API cost.

## Run Both Lanes

Polling and AMB are not alternatives to choose between. Production tools run both,
because each covers the other's weakness:

| Factor | Delta Polling | AMB Record Watchers |
|--------|--------------|---------------------|
| Latency | 5-30 seconds (your interval) | Sub-second |
| Availability | Works on any instance | Needs `g_ambClient` connected |
| API cost | Counted against rate limit | No Table API cost |
| Failure mode | Slow but correct | Can drop silently |
| Data quality | Full record, diffable | Trigger only, no trustworthy diff |

The combination:

- **AMB push** arrives, you debounce it (~800ms) and immediately run a delta
  poll. Users get sub-second updates.
- **The poll lane stays on** but relaxes to a safety net (30s, or 120s+) while AMB
  is confirmed live. If AMB drops, tighten it back automatically.
- **A periodic full sweep** reconciles anything both lanes missed and baselines
  newly appeared records.

This way losing the AMB connection degrades latency instead of breaking the tool,
and you are not paying full polling cost while push is working.

```javascript
var ambKickTimer = null, ambPendingKick = false, polling = false;

function onAmbPush() {
    clearTimeout(ambKickTimer);
    ambKickTimer = setTimeout(function() {
        // Coalesce: a poll already running absorbs this push.
        if (polling) { ambPendingKick = true; return; }
        poll('delta');
    }, 800);
}

function afterPoll() {
    polling = false;
    if (ambPendingKick) { ambPendingKick = false; poll('delta'); }
}
```

Debouncing matters more than it looks: a single reassignment can fire watcher
events on several tables at once, and without coalescing each one starts its own
poll.

See `polling-scheduler.md` for the lane structure, backoff, jitter, and
visibility handling.
