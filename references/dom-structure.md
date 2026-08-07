# SOW DOM Structure

ServiceNow's Service Operations Workspace is a single-page application built with
nested web components (custom elements with Shadow DOM). Understanding this tree
is critical for injecting UI and observing changes.

## Component Tree (Simplified)

```
document
  macroponent-f51912f4c700201072b211d4d8c26010    (app shell root)
    #shadowRoot
      sn-canvas-appshell-main
        #shadowRoot
          macroponent-c276387cc331101080d6d3658940ddd2    (workspace chrome)
            #shadowRoot
              sn-canvas-tabs
                #shadowRoot
                  .sn-chrome-tabs-group          (the tab strip)
                    .sn-chrome-one-tab-container  (one per open tab)
                      .sn-chrome-one-tab          (tab element)
                        .sn-chrome-one-tab-label  (ticket number text)
              sn-canvas-main                     (content area)
                #shadowRoot
                  sn-canvas-tabsdata
                  macroponent-c5d9c004...         (one per mounted record page)
```

## Key Landmarks

### Tab Root

Navigate from the document root to the tab strip shadow root:

```javascript
function getTabRoot() {
    var m1 = document.querySelector('macroponent-f51912f4c700201072b211d4d8c26010');
    if (!m1 || !m1.shadowRoot) return null;
    var shell = m1.shadowRoot.querySelector('sn-canvas-appshell-main');
    if (!shell || !shell.shadowRoot) return null;
    var m2 = shell.shadowRoot.querySelector(
        'macroponent-c276387cc331101080d6d3658940ddd2'
    );
    if (!m2 || !m2.shadowRoot) return null;
    var tabs = m2.shadowRoot.querySelector('sn-canvas-tabs');
    if (!tabs || !tabs.shadowRoot) return null;
    return tabs.shadowRoot;
}
```

### Header Controls

The workspace header sits inside a shadow root. To inject a widget (like a search
bar or timer) into the header:

```javascript
function findHostWith(selector) {
    // Walk every shadow root in the document to find the one containing this selector
    function walk(root, depth) {
        if (!root || depth > 30) return null;
        try {
            if (root.querySelector(selector)) return root;
            var all = (root.host ? root : root).querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
                if (all[i].shadowRoot) {
                    var found = walk(all[i].shadowRoot, depth + 1);
                    if (found) return found;
                }
            }
        } catch (e) {}
        return null;
    }
    return { shadowRoot: walk(document, 0) };
}

function mountInHeader(element) {
    var host = findHostWith('.polaris-header-controls');
    if (!host || !host.shadowRoot) return false;
    var controls = host.shadowRoot.querySelector('.polaris-header-controls');
    if (!controls) return false;
    controls.insertBefore(element, controls.firstChild);
    return true;
}
```

### Contact Cards

Caller/contact info on records uses `sn-contact-card` components:

```javascript
// Find all contact cards on the page
function findContactCards() {
    var cards = [];
    function walk(root, depth) {
        if (!root || depth > 30) return;
        try {
            root.querySelectorAll('sn-contact-card').forEach(function(c) {
                cards.push(c);
            });
            root.querySelectorAll('*').forEach(function(el) {
                if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
            });
        } catch (e) {}
    }
    walk(document, 0);
    return cards;
}
```

Contact cards carry an `aria-label` attribute that identifies them:
- `"Caller"` -- the caller on an incident
- `"Opened by"` -- the agent who opened the record
- `"Opened for"` -- the user on an interaction (IMS)

### Active Tab Detection

```javascript
function getActiveTabLabel() {
    var root = getTabRoot();
    if (!root) return null;
    var selected = root.querySelector('.sn-chrome-one-tab.is-selected');
    if (!selected) return null;
    var label = selected.querySelector('.sn-chrome-one-tab-label');
    return label ? label.textContent.trim() : null;
}
```

### Current Record from URL

SOW encodes the current record in the URL path:

```javascript
function currentRecord() {
    var url = decodeURIComponent(location.href);
    var re = /\/record\/([a-z0-9_]+)\/([0-9a-f]{32})/gi;
    var match, last = null;
    while ((match = re.exec(url)) !== null) last = match;
    if (!last) return null;
    return { table: last[1].toLowerCase(), sysId: last[2] };
}
```

## Tab Configuration Objects

SOW's tab and screen pool sizes are configured on live component instances:

```javascript
// Tab limits (on sn-canvas-tabs / sn-canvas-tabsdata)
element.tabConfig = {
    maxMainTabLimit: 10,      // default, can be raised
    maxTotalSubTabLimit: 20   // sub-tabs (e.g. IMS child records)
};

// Screen pool (on sn-canvas-main)
element.mainConfig = {
    maxActivePageCount: 3,    // screens kept fully mounted
    maxCachedPageCount: 5     // screens kept in cache (teardown above this)
};
```

These can be patched at runtime to raise limits and improve performance.
Use a periodic reassert (every 3s) because the framework may rewrite them:

```javascript
var origConfig = null;
function applyLimits() {
    walkAll(document.body, function(el) {
        if (el.tagName === 'SN-CANVAS-TABS' && el.tabConfig) {
            if (!origConfig) origConfig = Object.assign({}, el.tabConfig);
            el.tabConfig = Object.assign({}, el.tabConfig, {
                maxMainTabLimit: 16,
                maxTotalSubTabLimit: 40
            });
        }
    });
}
setInterval(applyLimits, 3000);
```

## Web Component Tag Reference

| Tag | Purpose |
|-----|---------|
| `macroponent-f51912f4...` | App shell root |
| `sn-canvas-appshell-main` | Main app shell |
| `macroponent-c276387c...` | Workspace chrome (tabs + content) |
| `sn-canvas-tabs` | Tab strip container |
| `sn-canvas-tabsdata` | Tab data model |
| `sn-canvas-main` | Content/screen manager |
| `sn-contact-card` | Caller/contact display |
| `now-alert` | Notification banners |
| `macroponent-c5d9c004...` | Mounted record page instance |

Note: macroponent IDs are instance-specific. The ones listed here are from
observed production instances but may differ. Use tag name patterns or walk
the tree dynamically when possible.
