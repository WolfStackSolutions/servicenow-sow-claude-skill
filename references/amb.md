# AMB (Asynchronous Message Bus) / CometD

ServiceNow uses AMB (built on CometD/Bayeux protocol) for real-time server push.
SOW uses it internally for notifications, record updates, and presence. You can
tap into the same bus or work with its effects.

## How AMB Works in SOW

AMB runs over long-polling or WebSocket (depending on instance config) at:

```
/amb/connect
/amb/handshake
/amb/subscribe
```

The client library lives on `window.amb` or as a CometD instance. SOW subscribes
to channels for notifications, record changes, and chat/presence updates.

## Intercepting AMB-Driven Notifications

Rather than subscribing to AMB channels directly (which requires knowing the
exact channel names, which vary by instance), the practical approach is to
intercept the effects of AMB messages -- the UI events they trigger.

### Notification Interception

When AMB delivers a notification, SOW dispatches a custom event to insert it
into the UI. Intercept this dispatch:

```javascript
var origDispatch = EventTarget.prototype.dispatchEvent;
var pendingMessages = [];

EventTarget.prototype.dispatchEvent = function(event) {
    if (event && event.type === 'SIMPLE_EVENT#NOW_NOTIFICATION_PANEL_APPEND') {
        try {
            var payload = event.detail;
            if (payload && payload.notifications) {
                payload.notifications.forEach(function(n) {
                    var msg = (n.message || '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (msg) {
                        pendingMessages.push(msg);
                        // Do something with the notification message
                        onNotification(msg, n);
                    }
                });
            }
        } catch (e) {}
    }
    return origDispatch.apply(this, arguments);
};

// Cleanup
function restoreDispatch() {
    EventTarget.prototype.dispatchEvent = origDispatch;
}
```

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

## Direct AMB Subscription (Advanced)

If you need real-time push (sub-second latency) and the instance exposes the
AMB client, you can subscribe to channels directly. This is instance-dependent
and less portable than polling.

```javascript
// Check if AMB client is available
var ambClient = window.amb;
if (!ambClient) {
    // Try to find it on the ServiceNow global
    try {
        ambClient = window.NOW && window.NOW.amb;
    } catch (e) {}
}

if (ambClient && typeof ambClient.getClient === 'function') {
    var client = ambClient.getClient();

    // Record update channel pattern (instance-specific)
    // Common patterns:
    //   /rw/default/{table}/{sys_id}
    //   /glide/ui/update/{table}
    client.subscribe('/rw/default/incident/' + sysId, function(message) {
        console.log('Record updated:', message);
        // message.data contains the change payload
    });
}
```

**Warning:** Channel paths vary by instance version and configuration. The
polling approach in this document is the portable solution. Only use direct
AMB subscription when you have confirmed the channel structure on your
target instance.

## Choosing Between Polling and AMB

| Factor | Delta Polling | Direct AMB |
|--------|--------------|------------|
| Latency | 5-30 seconds (your interval) | Sub-second |
| Portability | Works on any instance | Instance-dependent channels |
| API cost | Counted against rate limit | No Table API cost |
| Complexity | Simple, stateless per-poll | Connection management, reconnect |
| Reliability | Very high | Can drop during handshake issues |

**Recommendation:** Use delta polling for most tools. Reserve direct AMB for
tools where sub-second notification latency is the core feature and you can
test on the target instance.
