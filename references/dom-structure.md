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

`findHostWith` (defined in `injection.md`) returns the **host element** whose
shadow root contains the selector, so callers reach through `host.shadowRoot`:

```javascript
function mountInHeader(element) {
    var host = findHostWith('.polaris-header-controls');
    if (!host || !host.shadowRoot) return false;
    var controls = host.shadowRoot.querySelector('.polaris-header-controls');
    if (!controls) return false;
    // Sit to the left of the search box when there is one.
    var search = controls.querySelector('.search-container');
    if (search) controls.insertBefore(element, search);
    else controls.insertBefore(element, controls.firstChild);
    return true;
}
```

This is selector-based, so unlike `getTabRoot()` it does not depend on any
instance-specific macroponent id. Prefer it.

Header chrome is rebuilt on navigation, which silently detaches your widget.
Watch for that and re-mount, debounced so a burst of mutations causes one
re-mount rather than hundreds:

```javascript
var queued = false;
var obs = new MutationObserver(function() {
    if (queued || element.isConnected) return;
    queued = true;
    setTimeout(function() {
        queued = false;
        try { mountInHeader(element); } catch (e) {}
    }, 120);
});
obs.observe(document.body, { childList: true, subtree: true });
```

If the header slot cannot be found at all, fall back to a fixed-position element
on `document.body` rather than failing to render.

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

Contact cards carry an `aria-label` that identifies their role, containing
`"Caller"` (incident caller), `"Opened by"` (the agent, not the customer), or
`"Opened for"` (the IMS customer).

Match on lowercased **substrings**, not exact equality — labels carry extra text
and differ between record types. Almost every tool wants the customer, which
means explicitly excluding the agent card:

```javascript
var label = (card.getAttribute('aria-label') || '').toLowerCase();
if (label.indexOf('opened by') > -1) return;                      // agent, skip
if (label.indexOf('caller') < 0 && label.indexOf('opened') < 0) return;
```

Inject inside the card's own shadow root, not next to the host:

```javascript
var sr = card.shadowRoot;
if (!sr) return;
var container = sr.querySelector('.sn-contact-card--content')
             || sr.querySelector('.sn-contact-card--container');
if (container) container.appendChild(myBadge);
```

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

### Which ticket is the user actually on?

Sub-tabs break the simple version above. An INC opened inside an IMS means **two**
tabs report `is-selected`, and the parent usually wins the query. Collect all
selected tabs across shadow roots and prefer the non-IMS one, since that is the
record the user is working in:

```javascript
function getActiveTicketNumber() {
    var numbers = [];
    function walk(root, depth) {
        if (!root || depth > 30) return;
        root.querySelectorAll('.sn-chrome-one-tab.is-selected').forEach(function(tab) {
            var label = tab.querySelector('.sn-chrome-one-tab-label');
            var text = (label ? label.textContent : tab.textContent).trim();
            var m = text.match(/\b(INC|RITM|REQ|IMS|SCTASK)\d{5,}\b/);
            if (m) numbers.push(m[0]);
        });
        root.querySelectorAll('*').forEach(function(el) {
            if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        });
    }
    walk(document, 0);
    var nonIms = numbers.filter(function(n) { return n.indexOf('IMS') !== 0; });
    return nonIms.length ? nonIms[nonIms.length - 1]
                         : numbers[numbers.length - 1] || null;
}
```

### Skip hidden tabs when reading fields

Background tabs keep their DOM mounted, so a field query happily returns values
from a ticket the user is not looking at. Check visibility first:

```javascript
function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
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
    maxMainTabLimit: 10,      // common default; instance may already raise this
    maxTotalSubTabLimit: 20   // common default — live instances often use 30+
};

// Screen pool (on sn-canvas-main)
element.mainConfig = {
    maxActivePageCount: 3,    // screens kept fully mounted
    maxCachedPageCount: 5     // screens kept in cache (teardown above this)
};
```

These can be patched at runtime to raise limits and improve performance.
Use a periodic reassert (every 3s) because the framework may rewrite them:

Discover the components by **tag name plus the presence of the config property**.
The config lives on either `SN-CANVAS-TABSDATA` or `SN-CANVAS-TABS` depending on
the release, so checking only one finds nothing on some instances:

```javascript
var origConfig = null;

function findTabEls() {
    var els = [];
    walkAll(document.body, function(el) {
        var tag = el.tagName;
        if ((tag === 'SN-CANVAS-TABSDATA' || tag === 'SN-CANVAS-TABS') &&
            el.tabConfig && typeof el.tabConfig === 'object') {
            els.push(el);
        }
    });
    return els;
}

function applyLimits(maxMain) {
    findTabEls().forEach(function(el) {
        if (!origConfig) origConfig = Object.assign({}, el.tabConfig);
        el.tabConfig = Object.assign({}, el.tabConfig, {
            maxMainTabLimit: maxMain,
            maxTotalSubTabLimit: Math.max(40, maxMain * 2)
        });
    });
}
setInterval(function() { applyLimits(16); }, 3000);
```

The elements themselves get swapped out, not just their config, so re-find them
on each pass (or check `el.isConnected`) rather than caching the references. On
teardown, restore `origConfig` — leaving raised limits behind changes workspace
behaviour after your tool is gone.

Screen pool size (`mainConfig` on `SN-CANVAS-MAIN`) is a separate control with its
own trade-off: more cached pages means faster tab switching and more memory.
Patch it independently of tab limits.

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

Macroponent IDs are **instance-specific**. The full 32-character hashes above come
from one observed production instance and are the single biggest portability risk
in any SOW tool — on a different instance `getTabRoot()` returns `null` forever
and every feature built on it silently does nothing.

Prefer, in order:

1. **A selector plus `findHostWith`** — `findHostWith('.polaris-header-controls')`,
   `findHostWith('.sn-chrome-tabs-group')`. No ids involved.
2. **Tag name plus a property check** — `SN-CANVAS-TABS` with a `tabConfig`,
   `SN-CANVAS-MAIN` with a `mainConfig`.
3. **A tag-name prefix** when you only need to count or locate instances:

```javascript
// Matches macroponent-c5d9c004... without pinning the whole hash
if (/^MACROPONENT-C5D9C004/i.test(el.tagName)) recordPages.push(el);
```

Reach for hardcoded macroponent ids only as a last resort, and always guard the
null case so the tool degrades instead of throwing.

### Selectors stable across instances

These class names are part of the workspace chrome rather than generated
component ids, and are safe to target:

| Selector | Purpose |
|----------|---------|
| `.sn-chrome-tabs-group` | Tab list container |
| `.sn-chrome-tabs-content` | Tab strip content area |
| `.sn-chrome-one-tab` | A single tab |
| `.sn-chrome-one-tab.is-selected` | Active tab |
| `.sn-chrome-one-tab-label` | Ticket number text |
| `.polaris-header-controls` | Header control strip |
| `.sn-contact-card--content` | Inside a contact card's shadow root |
| `a[data-testisrecordlink="true"]` | Record links |
| `now-record-common-uiactionbar` | Record action bar |
