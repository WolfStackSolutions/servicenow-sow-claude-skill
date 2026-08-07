# Polling Scheduler

Any tool that watches records over time needs more than `setInterval`. The
problems a real scheduler has to solve: staying inside the hourly rate-limit
budget, not missing updates at interval boundaries, not stampeding when several
tabs run the same tool, recovering from failures, and not burning quota on a tab
nobody is looking at.

## Use setTimeout, not setInterval

`setInterval` keeps firing regardless of whether the previous cycle finished. Once
a poll takes longer than the interval — which happens on every slow response —
you get overlapping cycles and duplicated work. Reschedule at the *end* of each
cycle instead:

```javascript
var timer = null, stopped = false;

function schedule(ms) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(run, ms);
}

function run() {
    poll()
        .then(function() { fails = 0; })
        .catch(function() { fails++; })
        .then(function() { schedule(nextWait()); });
}
```

## Lanes

Different data has different freshness requirements, and putting it all on one
interval means over-polling the cheap parts or under-polling the important ones.
Give each concern its own lane:

| Lane | Typical cadence | Purpose |
|------|-----------------|---------|
| Delta | 5-15s | Records changed since the high-water mark |
| Sweep | 300s | Full lookback: baseline new records, heal drift |
| Header / summary | 8-30s | Counters and aggregates |
| Presence | 5s | Who is online (cheap, non-Table API) |

The delta lane keeps things current; the sweep lane is what makes the tool
self-healing. Deltas can miss records — a query scoped to your tickets will not
return one that was just reassigned *to* you — and without a periodic full
reconciliation those gaps are permanent.

## High-water marks, with overlap

Track the newest `sys_updated_on` you have seen and query for changes after it.
Always query slightly **behind** the mark:

```javascript
var HW_OVERLAP_MS = 90000;

function deltaQuery(scopeCond, hw) {
    var overlap = fmtUTC(new Date(
        Date.parse(hw.replace(' ', 'T') + 'Z') - HW_OVERLAP_MS));
    return scopeCond + '^sys_updated_on>' + overlap + '^ORDERBYDESCsys_updated_on';
}
```

The overlap covers clock skew between the browser and the instance, and records
committed slightly out of order relative to their timestamps. Querying at exactly
the high-water mark drops those records permanently — and silently, which is
worse.

Overlap means you will re-see records. That is fine as long as your change
detection is idempotent: diff against a stored snapshot and emit nothing when
nothing changed. Never emit events straight from "this row came back from the
delta query".

Rules that follow:

1. Order by `sys_updated_on` descending and take the max from the result set.
2. Seed the mark from an empty sweep (client clock minus a few minutes) so the
   delta lane has somewhere to start.
3. Use ServiceNow relative dates for the sweep lookback
   (`javascript:gs.daysAgoStart(7)`), not client-formatted strings.

## Jitter

Identical intervals across tabs or users produce synchronised bursts against the
instance. Spread them:

```javascript
function jitter(ms) { return Math.round(ms * (0.9 + Math.random() * 0.25)); }
```

## Backoff

On failure, back off exponentially with a ceiling, and reset on the first success.
Honour `Retry-After` when the server sends it — a 429 is the instance telling you
exactly how long to wait, and ignoring it in favour of your own timer is how a
tool gets itself rate-limited for longer:

```javascript
var BACKOFF_MAX_MS = 120000;   // or 600000 for a background watcher

function nextWait(base, fails, retryAfterMs) {
    if (retryAfterMs > 0) return retryAfterMs;
    if (fails > 0) return Math.min(base * Math.pow(2, fails), BACKOFF_MAX_MS);
    return jitter(base);
}
```

## Hidden tabs

A backgrounded tab still consumes rate-limit budget while showing nobody
anything. Either park the lanes entirely and catch up on return, or lengthen the
wait:

```javascript
var sleeping = false;

document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') { sleeping = true; return; }
    if (!sleeping) return;
    sleeping = false;
    runAllLanesNow();       // one immediate catch-up, then normal cadence
});

// In the scheduler:
if (sleeping) return schedule(30000);          // park
// or, to keep a trickle:
if (document.hidden) return schedule(base * 2);
```

Do not spoof the Page Visibility API to keep a SOW poller running while hidden.
That defeats the point and drains the user's hourly budget in the background. The
spoofing technique in `injection.md` is for keeping a *third-party* dashboard
warm, not this.

## Coalescing AMB pushes

When AMB is connected, pushes become poll triggers. Debounce them and skip if a
poll is already running, otherwise one reassignment fires several overlapping
polls:

```javascript
var kickTimer = null, pendingKick = false, polling = false;

function onPush() {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(function() {
        if (polling) { pendingKick = true; return; }
        poll('delta');
    }, 800);
}

// At the end of a poll:
polling = false;
if (pendingKick) { pendingKick = false; poll('delta'); }
```

While AMB is confirmed live, relax the delta lane to a safety net (30s, or 120s+)
rather than turning it off. If the connection drops — which it does, without
notifying you — the poller is the only thing still working. Tighten it back
automatically when `getConnectionState()` stops reporting a live connection.

## Staying inside the budget

- Serialise table queries with 40-150ms gaps instead of one parallel burst.
- Cap per-cycle detail reads (12 is a reasonable ceiling) in batches of ~4, and
  stop the remaining batches on the first 429.
- Re-queue anything skipped; dropping it means those records never update.
- Share one budget counter across tools on the page (see `api.md`).

## Teardown

Every lane, listener and observer must be reachable from a single cleanup
function, or a re-run leaves the old scheduler polling forever alongside the new
one:

```javascript
function stop() {
    stopped = true;
    [deltaTimer, sweepTimer, headerTimer, presenceTimer, tick]
        .forEach(function(t) { clearTimeout(t); clearInterval(t); });
    document.removeEventListener('visibilitychange', onVisibility);
    unsubscribeAmb();
}
```

Expose it on your namespace (`window.MyTool.destroy`) and call it before starting
a fresh instance.
