# Injection Patterns for SOW

## Core Principle: SOW is an SPA

ServiceNow SOW never does full page loads after the initial boot. Every navigation
(opening a ticket, switching tabs, going home) is handled client-side via the
router. `DOMContentLoaded` and `load` events fire once, on initial page load only.

**You must use MutationObservers and polling to detect content changes.**

## Shadow DOM Traversal

SOW's components nest shadow roots 10-30 levels deep. Any DOM query must walk
through them recursively:

```javascript
function walkShadows(root, visitor, depth) {
    if (!root || (depth || 0) > 30) return;
    try {
        root.querySelectorAll('*').forEach(function(el) {
            visitor(el);
            if (el.shadowRoot) walkShadows(el.shadowRoot, visitor, (depth || 0) + 1);
        });
    } catch (e) {}
}

// Example: find all elements matching a selector across shadow boundaries
function queryShadowAll(selector) {
    var found = [];
    walkShadows(document, function(el) {
        if (el.matches && el.matches(selector)) found.push(el);
    });
    return found;
}
```

### Performance variant (walk without querySelectorAll)

For hot paths (called every 2-3 seconds), avoid querySelectorAll overhead:

```javascript
function walkAll(root, visit) {
    var el = root.firstElementChild;
    while (el) {
        visit(el);
        if (el.shadowRoot) walkAll(el.shadowRoot, visit);
        walkAll(el, visit);
        el = el.nextElementSibling;
    }
}
```

## MutationObserver Patterns

### Pattern 1: Watch a specific shadow root

When you know which component to observe (e.g. the tab strip):

```javascript
function watchShadowRoot(element, callback) {
    if (!element || !element.shadowRoot) return null;
    var observer = new MutationObserver(callback);
    observer.observe(element.shadowRoot, { childList: true, subtree: true });
    return observer;
}
```

### Pattern 2: Auto-discover and watch new shadow roots

Shadow roots appear dynamically as components mount. Keep a WeakSet of already-
watched roots and periodically scan for new ones:

```javascript
var watched = new WeakSet();
var observers = [];

function watchNewShadows(root) {
    if (!root) return;
    root.querySelectorAll('*').forEach(function(el) {
        if (el.shadowRoot && !watched.has(el.shadowRoot)) {
            watched.add(el.shadowRoot);
            // Run your injection logic on this new shadow root
            injectInto(el.shadowRoot);
            // Watch it for future changes
            var obs = new MutationObserver(function() {
                injectInto(el.shadowRoot);
            });
            obs.observe(el.shadowRoot, { childList: true, subtree: true });
            observers.push(obs);
            // Recurse into nested shadows
            watchNewShadows(el.shadowRoot);
        }
    });
}

// Initial pass + periodic re-scan (components mount lazily)
watchNewShadows(document);
var scanInterval = setInterval(function() {
    watchNewShadows(document);
}, 3000);

// Cleanup
function teardown() {
    clearInterval(scanInterval);
    observers.forEach(function(o) { o.disconnect(); });
}
```

### Pattern 3: Click handler across shadow boundaries

SOW's shadow DOM means `document.addEventListener('click', ...)` won't catch
clicks inside shadow roots. Register a capture-phase handler on each discovered
shadow root, and re-run as new roots mount:

```javascript
function watchShadowClicks(root, handler) {
    if (!root) return;
    root.querySelectorAll('*').forEach(function(el) {
        if (el.shadowRoot && !watched.has(el.shadowRoot)) {
            watched.add(el.shadowRoot);
            el.shadowRoot.addEventListener('click', handler, true);
            watchShadowClicks(el.shadowRoot, handler);
        }
    });
}

document.addEventListener('click', clickHandler, true);
watchShadowClicks(document, clickHandler);

// Components mount late and after navigation, so re-scan.
[500, 1500, 3000].forEach(function(ms) {
    setTimeout(function() { watchShadowClicks(document, clickHandler); }, ms);
});
var rescan = setInterval(function() { watchShadowClicks(document, clickHandler); }, 3000);
```

The capture phase (`true`) is essential — events retargeted at the shadow host
will not reach a bubbling listener with the original target intact.

### Pattern 4: Find the host of a selector

To inject into a component you must find the **host element** whose shadow root
contains your target. An iterative stack walk avoids deep recursion and lets you
cap total work on a large tree:

```javascript
function findHostWith(sel) {
    var stack = [document.body], seen = 0;
    while (stack.length && seen < 60000) {
        var n = stack.pop();
        seen++;
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
```

It returns the **host**, so callers query through `host.shadowRoot`:

```javascript
var host = findHostWith('.polaris-header-controls');
if (!host || !host.shadowRoot) return false;
var controls = host.shadowRoot.querySelector('.polaris-header-controls');
```

### Clicks outside an injected panel

`event.target` is retargeted at shadow boundaries, so the usual
`panel.contains(e.target)` check reports false for clicks inside your own panel.
Use `composedPath()`:

```javascript
document.addEventListener('mousedown', function(e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (path.indexOf(panel) === -1 && path.indexOf(fab) === -1) closePanel();
}, true);
```

## SPA Navigation

### Opening a record programmatically

SOW uses `pushState` + a dispatched `popstate` event for in-page navigation:

```javascript
function openRecord(table, sysId) {
    history.pushState({}, '', '/now/sow/record/' + table + '/' + sysId);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
}

// Example: open an incident
openRecord('incident', 'abc123def456...');
```

### Reading the current record

You usually do not need generic navigation events — you need to know which record
is on screen. Parse it from the URL when you need it, rather than maintaining
navigation state:

```javascript
function currentRecord() {
    try {
        var url = decodeURIComponent(location.href);
        var m = /\/record\/([a-z0-9_]+)\/([0-9a-f]{32})/i.exec(url);
        return m ? { table: m[1], sysId: m[2] } : null;
    } catch (e) { return null; }
}

function onHome() {
    return location.href.indexOf('/now/sow/home') > -1;
}
```

For tab switches, a capture-phase click handler on the tab chrome
(see Pattern 3) fires reliably. Avoid driving navigation detection from a
`MutationObserver` on `document.body` — SOW mutates the body constantly, so the
callback runs thousands of times to catch a handful of navigations.

## DOM Interception

### Blocking elements (e.g. notification banners)

To prevent `now-alert` elements from appearing and stealing focus:

```javascript
var origInsertBefore = Node.prototype.insertBefore;
var origAppendChild = Node.prototype.appendChild;

var HIDE = 'display:none!important;height:0!important;' +
           'overflow:hidden!important;pointer-events:none!important;';

function isNowAlert(n) {
    return n && n.tagName && n.tagName.toLowerCase() === 'now-alert';
}

Node.prototype.insertBefore = function(newNode, refNode) {
    if (isNowAlert(newNode)) {
        // Let it insert (so no errors) but immediately hide and remove.
        var result = origInsertBefore.apply(this, arguments);
        newNode.style.cssText = HIDE;
        Promise.resolve().then(function() {
            try { newNode.remove(); } catch(e) {}
        });
        return result;
    }
    return origInsertBefore.apply(this, arguments);
};

// Same for appendChild
Node.prototype.appendChild = function(newNode) {
    if (isNowAlert(newNode)) {
        var result = origAppendChild.apply(this, arguments);
        newNode.style.cssText = HIDE;
        Promise.resolve().then(function() {
            try { newNode.remove(); } catch(e) {}
        });
        return result;
    }
    return origAppendChild.apply(this, arguments);
};
```

`overflow:hidden` matters: without it a suppressed alert can still reserve
scrollable space in its container.

### Capturing the message text before you suppress it

Hiding the element throws away the message, so hook the dispatch that carries it.
The event is a generic CustomEvent — the interesting part is in `detail.type`,
**not** `event.type`:

```javascript
var pendingMessages = [];
var origDispatch = EventTarget.prototype.dispatchEvent;

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
                    if (msg) pendingMessages.push(msg);
                });
            }
        } catch (ex) {}
    }
    return origDispatch.apply(this, arguments);
};
```

Both layers are needed. The dispatch hook alone gives you the text but the banner
still appears and steals focus; the DOM hook alone suppresses the banner but loses
the message. Pair them by shifting off `pendingMessages` as each `now-alert` is
blocked.

**Always restore originals on cleanup:**

```javascript
function cleanup() {
    EventTarget.prototype.dispatchEvent = origDispatch;
    Node.prototype.insertBefore = origInsertBefore;
    Node.prototype.appendChild = origAppendChild;
}
```

### Hooking fetch

Observe or modify fetch calls made by the workspace:

```javascript
(function hookFetch() {
    if (window.__myFetchHooked) return;   // never wrap twice
    window.__myFetchHooked = true;
    var orig = window.fetch;
    if (typeof orig !== 'function') return;   // some contexts have no fetch
    window.fetch = function(input) {
        var url = '';
        try {
            url = (typeof input === 'string') ? input : (input && input.url) || '';
        } catch (e) {}

        if (url.indexOf('/api/now/table/') < 0) return orig.apply(this, arguments);

        return orig.apply(this, arguments).then(function(r) {
            try { noteApiCall(r, url); } catch (e) {}
            return r;
        });
    };
})();
```

Two guards are doing real work here. The `__myFetchHooked` flag stops a
second bookmarklet click from wrapping your own wrapper — each re-entry would
otherwise add a layer that never unwinds. The early return for non-matching URLs
keeps the hook off the hot path for every unrelated request on the page.

If a tool stubs or rewrites responses, keep the original and restore it on
teardown so disabling the tool actually disables the behaviour:

```javascript
var origFetch = window.fetch;
window.fetch = function() { /* ... */ };
return function cleanup() { window.fetch = origFetch; };
```

## Background Tabs and Timer Throttling

Browsers throttle timers in hidden tabs, often to about once per minute. There
are two valid responses and they are opposites, so pick deliberately.

### Respect hidden (default for anything polling ServiceNow)

Do not burn rate-limit budget on a tab nobody is looking at. Park the work and
catch up when the tab returns:

```javascript
var sleeping = false;

document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') { sleeping = true; return; }
    if (!sleeping) return;
    sleeping = false;
    pollNow();          // immediate catch-up, then resume normal cadence
});
```

A lighter variant is to double the wait interval while hidden rather than
stopping, which keeps a slow trickle of updates alive.

### Spoof visible (only for third-party dashboards you are keeping warm)

If a tool's job is to keep a *different* application refreshing while
backgrounded, override the visibility surface and swallow the events. Pair it with
a silent oscillator, because timer throttling persists even when the page believes
it is visible:

```javascript
function startAntiThrottle() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    var ctx = new AC();
    var osc = ctx.createOscillator(), gain = ctx.createGain();
    gain.gain.value = 0.0001;        // inaudible, but keeps the tab "active"
    osc.frequency.value = 20;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    return ctx;
}

function startVisibilitySpoof() {
    var vals = {
        hidden: false, visibilityState: 'visible',
        webkitHidden: false, webkitVisibilityState: 'visible',
        mozHidden: false, msHidden: false
    };
    Object.keys(vals).forEach(function(prop) {
        Object.defineProperty(document, prop, {
            configurable: true,
            get: function() { return vals[prop]; }
        });
    });
    try { document.hasFocus = function() { return true; }; } catch (e) {}
    var swallow = function(e) { e.stopImmediatePropagation(); };
    ['visibilitychange', 'webkitvisibilitychange',
     'mozvisibilitychange', 'msvisibilitychange'].forEach(function(t) {
        document.addEventListener(t, swallow, true);
    });
}
```

Some applications also idle out on lack of input, so dispatching a synthetic
`mousemove` / `keydown` every 60s keeps their own keep-alive satisfied.

**Do not spoof visibility on SOW itself.** It defeats the rate-limit protection
above and makes an idle tab keep consuming the user's hourly budget. This is a
technique for a companion tab, not for the workspace.

## Tool Lifecycle Pattern

Every tool should return a cleanup function from its `on()` method:

```javascript
var tools = [
    {
        name: 'My Tool',
        key: 'mytool',
        on: function() {
            var intervals = [];
            var observers = [];
            var elements = [];

            // ... set up the tool ...
            var panel = document.createElement('div');
            document.body.appendChild(panel);
            elements.push(panel);

            var iv = setInterval(doWork, 3000);
            intervals.push(iv);

            var obs = new MutationObserver(onMutation);
            obs.observe(document.body, { childList: true, subtree: true });
            observers.push(obs);

            // Return cleanup function
            return function() {
                intervals.forEach(clearInterval);
                observers.forEach(function(o) { o.disconnect(); });
                elements.forEach(function(el) {
                    try { el.remove(); } catch(e) {}
                });
            };
        }
    }
];

// Toggle on/off
var cleanupFns = {};
function toggle(key) {
    if (cleanupFns[key]) {
        cleanupFns[key]();
        delete cleanupFns[key];
    } else {
        var tool = tools.find(function(t) { return t.key === key; });
        if (tool) cleanupFns[key] = tool.on();
    }
}
```

## Visibility-Aware Polling

Avoid wasting API budget when the tab is hidden:

```javascript
function startPolling(fn, intervalMs) {
    var timer = setInterval(function() {
        if (!document.hidden) fn();
    }, intervalMs);

    var onVisible = function() {
        if (!document.hidden) fn(); // immediate poll on return
    };
    document.addEventListener('visibilitychange', onVisible);

    return function stop() {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
    };
}
```
