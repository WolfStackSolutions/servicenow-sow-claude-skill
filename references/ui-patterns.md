# UI Patterns for SOW Tools

These patterns are proven in production.

## Escaping: read this before any `innerHTML`

Every string you render from ServiceNow is attacker-influenced — short
descriptions, comments, user names, catalog variables, API error messages. Your
tool runs with the user's full session, so an injection here is not cosmetic.

Use `textContent` for plain strings, and escape before any `innerHTML`:

```javascript
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
```

Static markup you wrote yourself (icons, layout, SVG) can be assigned directly.
The rule applies to interpolated data:

```javascript
// Fine - you wrote all of this
header.innerHTML = '<span class="title">Watchlist</span><span class="sp"></span>';

// Fine - data is escaped
row.innerHTML = '<span class="num">' + esc(t.number) + '</span>' +
                '<span class="desc">' + esc(t.short_description) + '</span>';

// Never
row.innerHTML = '<span>' + t.short_description + '</span>';
```

Escape the `"` and `'` characters too, not just angle brackets — a value
interpolated into an attribute escapes its quotes otherwise.

## Design System Constants

There is no single palette. Match the context your UI appears in: a corner panel
on dark SOW chrome, a shadow-DOM dashboard, or a ServiceNow-native light panel.
Pick one stack per tool and stay in it.

```javascript
// Dark theme (matches SOW's own dark mode)
var BG    = '#131620';   // deepest background
var S1    = '#181c28';   // surface level 1 (headers, footers)
var S2    = '#1e2333';   // surface level 2 (hover, cards)
var BORD  = 'rgba(255,255,255,0.10)';
var BORD2 = 'rgba(255,255,255,0.06)';  // faint borders
var T     = '#e8e8f0';   // primary text
var DIM   = '#9aa0ab';   // secondary text
var FAINT = '#5a6270';   // tertiary text / labels
var OK    = '#10b981';   // success
var WARN  = '#f59e0b';   // warning
var DANGER= '#ef4444';   // error / danger
var ACC   = '#6C6FFF';   // accent (indigo)
var MONO  = "'JetBrains Mono','SF Mono',Consolas,monospace";
var BODY  = "-apple-system,system-ui,'Segoe UI',Roboto,sans-serif";
```

### Alternative stacks

A full-screen or shadow-DOM tool wants its own slightly different surface stack,
and anything that has to look like part of ServiceNow needs a light one:

```javascript
// Shadow-DOM dashboard: set as custom properties on :host
// --bg:#0f1117; --s1:#161922; --s2:#1c2030; --s3:#242838;
// --bord:rgba(255,255,255,0.08); --bord2:rgba(255,255,255,0.14);
// --t:#e4e5eb; --dim:#8b91a0; --faint:#5a5f6e;
// --acc:#818cf8; --acc2:#6366f1;

// ServiceNow-native light panel
var NAVY = '#16325c';   // header + body text
var BG   = '#ffffff';
var LINE = '#c9d1dc';
var BLUE = '#0052cc';   // primary actions
var MUTED= '#5e6e82';
```

## z-index Layers

A single constant does not survive contact with a second tool. Layer by role so
tools coexist predictably:

| z-index | Use |
|---------|-----|
| `2147483000` | Full-screen wrap or side drawer |
| `2147483001` | Setup/boot overlay above the wrap |
| `2147483002` | Toast rack belonging to a full-screen tool |
| `2147483549` | Secondary corner FAB (sits behind the primary) |
| `2147483550` | Primary corner FAB and its panel |
| `2147483647` | Small always-on-top status panel |
| `9999990`-`9999999` | Ephemeral toasts, dropdowns, one-shot modals |

Two things follow from this. Toasts must outrank the panel that spawned them, or
they render behind it. And when two FABs share a corner, the lower one should move
up rather than overlap:

```javascript
function repositionFabs() {
    var primary = document.getElementById('primary-fab');
    fab.style.bottom = (primary && primary.offsetParent) ? '68px' : '16px';
}
```

## Pattern: Fixed Panel (FAB + Expandable)

A floating action button in the corner that opens a panel above it:

```javascript
var Z = 2147483550; // primary corner tool; see the layer table above

// FAB
var fab = document.createElement('div');
fab.id = 'my-tool-fab';
fab.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:' + Z,
    'width:42px', 'height:42px', 'background:' + BG,
    'border:1px solid ' + BORD,
    'display:flex', 'align-items:center', 'justify-content:center',
    'cursor:pointer', 'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'transition:border-color 0.15s,background 0.15s'
].join(';');
fab.innerHTML = '<svg>...</svg>'; // your icon
fab.addEventListener('mouseenter', function() { fab.style.borderColor = ACC; });
fab.addEventListener('mouseleave', function() { fab.style.borderColor = BORD; });
document.body.appendChild(fab);

// Panel (hidden by default)
var panel = document.createElement('div');
panel.id = 'my-tool-panel';
panel.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:68px', 'z-index:' + Z,
    'display:none', 'flex-direction:column',
    'width:400px', 'max-width:calc(100vw - 32px)',
    'height:480px', 'max-height:calc(100vh - 100px)',
    'background:' + BG, 'color:' + T,
    'border:1px solid ' + BORD,
    'box-shadow:0 12px 40px rgba(0,0,0,0.5)',
    'overflow:hidden', 'font-family:' + BODY, 'font-size:13px'
].join(';');
document.body.appendChild(panel);

// Panel header (accent stripe on left border)
var header = document.createElement('div');
header.style.cssText = [
    'display:flex', 'align-items:center', 'gap:10px',
    'padding:12px 14px',
    'border-bottom:1px solid ' + BORD,
    'border-left:3px solid ' + ACC,  // accent stripe
    'background:' + S1, 'flex-shrink:0'
].join(';');
header.innerHTML =
    '<span style="font-weight:700;font-size:13px;">Tool Name</span>' +
    '<span style="flex:1;"></span>' +
    '<span id="my-tool-close" style="cursor:pointer;color:' + FAINT + ';">&#10005;</span>';
panel.appendChild(header);

// Toggle
fab.addEventListener('click', function() {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});
```

### Dismissal and scrolling

A panel that only closes via its own X button feels broken next to real UI. Wire
up Escape and click-outside, remembering that `composedPath()` is required for
the outside check to work across shadow boundaries:

```javascript
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && panel.style.display !== 'none') closePanel();
}, true);

document.addEventListener('mousedown', function(e) {
    if (panel.style.display === 'none') return;
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (path.indexOf(panel) === -1 && path.indexOf(fab) === -1) closePanel();
}, true);
```

For a scrollable body inside a flex panel, `min-height:0` is what actually makes
it scroll — without it the body grows and the panel overflows the viewport:

```javascript
body.style.cssText = 'flex:1;overflow-y:auto;min-height:0;scrollbar-width:thin;';
```

### Tabs

```javascript
// Reflect state in aria-selected, not just styling
panel.querySelectorAll('.tab').forEach(function(b) {
    b.setAttribute('aria-selected', b.dataset.tab === activeTab ? 'true' : 'false');
});
```

## Pattern: Header Widget (Pill)

Inject a compact widget into the SOW header bar:

```javascript
var widget = document.createElement('div');
widget.id = 'my-widget';
widget.style.cssText = [
    'display:inline-flex', 'align-items:center', 'gap:8px',
    'height:34px', 'padding:0 14px',
    'background:var(--now-unified-nav_search--background-color,#23243d)',
    'border:1px solid var(--now-unified-nav_search--border-color,#3c3d5d)',
    'border-radius:var(--now-unified-nav_search--border-radius,4px)',
    'font-family:' + BODY, 'color:' + T,
    'margin-right:8px', 'align-self:center', 'flex-shrink:0',
    'position:relative', 'box-sizing:border-box'
].join(';');

// Mount in the header
function mount() {
    var host = findHostWith('.polaris-header-controls');
    if (!host || !host.shadowRoot) return false;
    var controls = host.shadowRoot.querySelector('.polaris-header-controls');
    if (!controls) return false;
    controls.insertBefore(widget, controls.firstChild);
    return true;
}

// Retry mounting (header may not exist yet)
if (!mount()) {
    var tries = 0;
    var mountInterval = setInterval(function() {
        tries++;
        if (mount() || tries > 40) clearInterval(mountInterval);
    }, 250);
}

// Re-mount if the header rebuilds (SOW does this sometimes)
var remountObs = new MutationObserver(function() {
    if (!widget.isConnected) {
        setTimeout(function() { try { mount(); } catch(e) {} }, 120);
    }
});
remountObs.observe(document.body, { childList: true, subtree: true });
```

## Pattern: Toast Notification

Brief, self-dismissing messages:

```javascript
function toast(message, color, durationMs) {
    var el = document.createElement('div');
    el.style.cssText = [
        'position:fixed', 'bottom:14px', 'left:50%',
        'transform:translateX(-50%)', 'z-index:9999999',
        'background:rgba(13,13,21,0.94)',
        'border:1.5px solid ' + (color || ACC),
        'font-family:' + MONO, 'font-size:12px',
        'color:' + (color || ACC),
        'padding:8px 16px',
        'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
        'pointer-events:none', 'transition:opacity 0.3s',
        'max-width:500px', 'word-break:break-all'
    ].join(';');
    el.textContent = message;
    document.body.appendChild(el);
    var d = durationMs || 2500;
    setTimeout(function() { el.style.opacity = '0'; }, d);
    setTimeout(function() { try { el.remove(); } catch(e) {} }, d + 400);
}
```

### Toast stack (for event-driven tools)

A single toast is fine for confirmations. Anything reacting to ticket events will
fire several at once, and they will stack on top of each other. Use a rack with a
cap:

```javascript
var rack = document.createElement('div');
rack.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:78px',   // clear of the FAB
    'z-index:' + (Z + 1),                            // above its own panel
    'display:flex', 'flex-direction:column-reverse', 'gap:10px',
    'width:360px', 'max-width:calc(100vw - 32px)',
    'pointer-events:none'
].join(';');
document.body.appendChild(rack);

var MAX_TOASTS = 4;

function pushToast(ev, lifeMs) {
    while (rack.children.length >= MAX_TOASTS) rack.removeChild(rack.firstChild);
    var el = document.createElement('div');
    el.style.pointerEvents = 'auto';   // so it can be hovered and clicked
    el.innerHTML = '<b>' + esc(ev.number) + '</b> ' + esc(ev.text || '');

    // Pause the countdown while the user is reading it.
    var life = lifeMs || 6000, started = Date.now(), remaining = life, timer;
    function arm() { timer = setTimeout(dismiss, remaining); }
    function dismiss() { try { el.remove(); } catch (e) {} }
    el.addEventListener('mouseenter', function() {
        clearTimeout(timer);
        remaining -= (Date.now() - started);
    });
    el.addEventListener('mouseleave', function() { started = Date.now(); arm(); });

    rack.appendChild(el);
    arm();
}
```

`pointer-events:none` on the rack with `auto` on each toast lets clicks pass
through the empty column while keeping the toasts themselves interactive.

## Pattern: Confirmation Modal

Backdrop + centered card for destructive actions:

Pass only strings you control, or `esc()` them at the call site — this template
interpolates `title` and `message` into markup.

```javascript
function showConfirmModal(title, message, onConfirm) {
    var backdrop = document.createElement('div');
    backdrop.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
        'z-index:9999995', 'background:rgba(0,0,0,0.5)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'backdrop-filter:blur(3px)'
    ].join(';');

    var box = document.createElement('div');
    box.style.cssText = [
        'background:' + BG, 'border:1.5px solid ' + ACC,
        'color:' + T, 'width:400px', 'max-width:calc(100vw - 40px)',
        'overflow:hidden', 'display:flex', 'flex-direction:column',
        'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
        'font-family:' + BODY
    ].join(';');

    box.innerHTML =
        '<div style="padding:14px 18px;border-bottom:1px solid ' + BORD + ';">' +
            '<div style="font-size:13px;font-weight:700;">' + title + '</div>' +
        '</div>' +
        '<div style="padding:14px 18px;font-size:13px;color:' + DIM + ';">' +
            message +
        '</div>' +
        '<div style="padding:10px 18px;display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="modal-cancel" style="padding:6px 14px;background:' + S2 +
                ';border:1px solid ' + BORD + ';color:' + T + ';cursor:pointer;">Cancel</button>' +
            '<button id="modal-confirm" style="padding:6px 14px;background:' + ACC +
                ';border:1px solid ' + ACC + ';color:#fff;cursor:pointer;font-weight:600;">Confirm</button>' +
        '</div>';

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    box.querySelector('#modal-cancel').addEventListener('click', function() {
        backdrop.remove();
    });
    box.querySelector('#modal-confirm').addEventListener('click', function() {
        backdrop.remove();
        onConfirm();
    });
    backdrop.addEventListener('click', function(e) {
        if (e.target === backdrop) backdrop.remove();
    });
}
```

## Pattern: Draggable Panel

Make any panel draggable by its header:

```javascript
function makeDraggable(panel, handle) {
    var startX = 0, startY = 0, origX = 0, origY = 0, dragging = false;
    handle.style.cursor = 'move';

    handle.addEventListener('pointerdown', function(e) {
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        var rect = panel.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        panel.style.transform = 'none';
        panel.style.left = origX + 'px';
        panel.style.top = origY + 'px';
        handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', function(e) {
        if (!dragging) return;
        panel.style.left = (origX + e.clientX - startX) + 'px';
        panel.style.top = (origY + e.clientY - startY) + 'px';
    });

    handle.addEventListener('pointerup', function() { dragging = false; });
}
```

## Animation Notes

- Only animate `transform` and `opacity` (never layout properties)
- Always include `prefers-reduced-motion` media query:

```javascript
var style = document.createElement('style');
style.textContent = [
    '@keyframes panel-in {',
    '  from { opacity:0; transform:translateY(10px) scale(0.98); }',
    '  to   { opacity:1; transform:translateY(0) scale(1); }',
    '}',
    '@media (prefers-reduced-motion:reduce) {',
    '  #my-panel, #my-panel * { animation:none !important; transition:none !important; }',
    '}'
].join('\n');
document.head.appendChild(style);
```
