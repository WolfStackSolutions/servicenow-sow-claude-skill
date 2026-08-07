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
clicks inside shadow roots. Register handlers on each discovered shadow root:

```javascript
function addShadowClickHandler(handler) {
    document.addEventListener('click', handler, true);
    watchShadows(document, function(el) {
        if (el.shadowRoot && !watched.has(el.shadowRoot)) {
            watched.add(el.shadowRoot);
            el.shadowRoot.addEventListener('click', handler, true);
        }
    });
}
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

### Detecting URL changes

Watch for navigation by hooking popstate and observing URL changes:

```javascript
var lastUrl = location.href;
var urlObserver = new MutationObserver(function() {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        onNavigate();
    }
});
urlObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener('popstate', onNavigate);
```

## DOM Interception

### Blocking elements (e.g. notification banners)

To prevent `now-alert` elements from appearing and stealing focus:

```javascript
var origInsertBefore = Node.prototype.insertBefore;
var origAppendChild = Node.prototype.appendChild;

Node.prototype.insertBefore = function(newNode, refNode) {
    if (newNode && newNode.tagName &&
        newNode.tagName.toLowerCase() === 'now-alert') {
        // Let it insert (so no errors) but immediately hide and remove
        var result = origInsertBefore.apply(this, arguments);
        newNode.style.cssText =
            'display:none!important;height:0!important;pointer-events:none!important;';
        Promise.resolve().then(function() {
            try { newNode.remove(); } catch(e) {}
        });
        return result;
    }
    return origInsertBefore.apply(this, arguments);
};

// Same for appendChild
Node.prototype.appendChild = function(newNode) {
    if (newNode && newNode.tagName &&
        newNode.tagName.toLowerCase() === 'now-alert') {
        var result = origAppendChild.apply(this, arguments);
        newNode.style.cssText =
            'display:none!important;height:0!important;pointer-events:none!important;';
        Promise.resolve().then(function() {
            try { newNode.remove(); } catch(e) {}
        });
        return result;
    }
    return origAppendChild.apply(this, arguments);
};

// Also intercept the notification dispatch event to capture message text
var origDispatch = EventTarget.prototype.dispatchEvent;
EventTarget.prototype.dispatchEvent = function(event) {
    if (event && event.type === 'SIMPLE_EVENT#NOW_NOTIFICATION_PANEL_APPEND') {
        // event.detail.notifications contains the messages
        // Log them, show them in your own UI, etc.
    }
    return origDispatch.apply(this, arguments);
};
```

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
    if (window.__myFetchHooked) return;
    window.__myFetchHooked = true;
    var orig = window.fetch;
    window.fetch = function(input) {
        var url = '';
        try {
            url = (typeof input === 'string') ? input : (input && input.url) || '';
        } catch (e) {}

        // Example: stub out a noisy endpoint that 400s constantly
        if (url.indexOf('agentic_processing') >= 0) {
            return Promise.resolve(
                new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
            );
        }

        // Example: count Table API calls
        if (url.indexOf('/api/now/table/') >= 0) {
            countApiCall();
        }

        return orig.apply(this, arguments);
    };
})();
```

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
