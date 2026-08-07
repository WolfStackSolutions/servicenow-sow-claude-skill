// Minimal SOW bookmarklet: injects a draggable panel into the workspace.
// Demonstrates: re-entry guard, namespace isolation, panel creation, cleanup.
//
// Wrap this in a bookmarklet installer page per SKILL.md instructions.

'use strict';

// Re-entry guard
var existing = document.getElementById('my-tool-panel');
if (existing) {
    existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
    return;
}

// Namespace
if (!window._myTool) window._myTool = {};
var tk = window._myTool;

// Constants
var BG = '#131620', S1 = '#181c28', BORD = 'rgba(255,255,255,0.1)';
var T = '#e8e8f0', ACC = '#6C6FFF', FAINT = '#5a6270';
var MONO = "'JetBrains Mono','SF Mono',Consolas,monospace";

// Panel
var panel = document.createElement('div');
panel.id = 'my-tool-panel';
panel.style.cssText = [
    'position:fixed;right:16px;bottom:16px;z-index:2147483549',
    'width:340px;background:' + BG + ';color:' + T,
    'border:1px solid ' + BORD,
    'box-shadow:0 12px 40px rgba(0,0,0,0.5)',
    'font-family:-apple-system,sans-serif;font-size:13px'
].join(';');

// Header (draggable)
var header = document.createElement('div');
header.style.cssText = [
    'display:flex;align-items:center;gap:10px;padding:12px 14px',
    'border-bottom:1px solid ' + BORD,
    'border-left:3px solid ' + ACC,
    'background:' + S1 + ';user-select:none;cursor:move'
].join(';');
header.innerHTML =
    '<span style="font-weight:700;font-size:13px;">My Tool</span>' +
    '<span style="flex:1;"></span>' +
    '<span id="my-tool-close" style="cursor:pointer;color:' + FAINT + ';padding:2px 4px;">&#10005;</span>';
panel.appendChild(header);

// Body
var body = document.createElement('div');
body.style.cssText = 'padding:14px;';
body.textContent = 'Tool is running. Replace this with your content.';
panel.appendChild(body);

document.body.appendChild(panel);

// Close button
document.getElementById('my-tool-close').addEventListener('click', function() {
    panel.style.display = 'none';
});

// Draggable
(function() {
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    header.addEventListener('pointerdown', function(e) {
        if (e.target.id === 'my-tool-close') return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        var r = panel.getBoundingClientRect();
        ox = r.left; oy = r.top;
        panel.style.transform = 'none';
        panel.style.left = ox + 'px';
        panel.style.top = oy + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', function(e) {
        if (!dragging) return;
        panel.style.left = (ox + e.clientX - sx) + 'px';
        panel.style.top = (oy + e.clientY - sy) + 'px';
    });
    header.addEventListener('pointerup', function() { dragging = false; });
})();
