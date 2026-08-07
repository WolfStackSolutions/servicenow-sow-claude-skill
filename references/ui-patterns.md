# UI Patterns for SOW Tools

SOW tools inject UI directly into the page DOM. These patterns are proven in
production across multiple tools.

## Design System Constants

Use a consistent surface stack and colour system across all injected UI:

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

## Pattern: Fixed Panel (FAB + Expandable)

A floating action button in the corner that opens a panel above it:

```javascript
var Z = 2147483549; // high z-index, below ServiceNow's own modals

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

## Pattern: Confirmation Modal

Backdrop + centered card for destructive actions:

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
