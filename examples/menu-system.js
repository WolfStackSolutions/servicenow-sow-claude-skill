// Multi-tool menu system for SOW bookmarklets.
// Demonstrates: tools array with on/off lifecycle, menu panel with toggles,
// state persistence, categorised grid layout, cleanup management.
//
// This is the architecture pattern used by production SOW toolkits.
// Each tool is a self-contained module that returns a cleanup function.

'use strict';

// Re-entry: toggle menu visibility
var existing = document.getElementById('sow-toolkit-menu');
if (existing) {
    existing.style.display = existing.style.display === 'none' ? 'block' : 'none';
    return;
}

// Namespace
if (!window._sowToolkit) window._sowToolkit = {};
var tk = window._sowToolkit;
if (!tk.state) tk.state = {};
var state = tk.state;

// ============================================================
// TOOLS ARRAY
// Each tool has: name, key, on() -> cleanupFn
// ============================================================
var tools = [
    {
        name: 'Example Tool A',
        key: 'toolA',
        on: function() {
            var intervals = [];

            // Tool logic here...
            var indicator = document.createElement('div');
            indicator.id = 'tool-a-indicator';
            indicator.style.cssText =
                'position:fixed;bottom:10px;left:10px;z-index:999999;' +
                'background:#131620;color:#10b981;border:1px solid #10b981;' +
                'padding:6px 12px;font-size:12px;font-family:monospace;';
            indicator.textContent = 'Tool A: active';
            document.body.appendChild(indicator);

            var iv = setInterval(function() {
                // periodic work...
            }, 5000);
            intervals.push(iv);

            // Return cleanup function
            return function() {
                intervals.forEach(clearInterval);
                try { indicator.remove(); } catch(e) {}
            };
        }
    },
    {
        name: 'Example Tool B',
        key: 'toolB',
        disabled: false, // set true to grey out in the menu
        on: function() {
            console.log('Tool B started');
            return function() {
                console.log('Tool B stopped');
            };
        }
    },
    {
        name: 'Example Tool C',
        key: 'toolC',
        on: function() {
            console.log('Tool C started');
            return function() {
                console.log('Tool C stopped');
            };
        }
    }
];

// Tool descriptions shown in the menu
var DESCS = {
    toolA: 'Does the first thing.',
    toolB: 'Does the second thing.',
    toolC: 'Does the third thing.'
};

// Tool categories for the menu grid
var CATS = [
    { title: 'CORE', keys: ['toolA', 'toolB'] },
    { title: 'EXTRA', keys: ['toolC'] }
];

// ============================================================
// TOGGLE LOGIC
// ============================================================
function toggleTool(key) {
    var tool = null;
    tools.forEach(function(t) { if (t.key === key) tool = t; });
    if (!tool || tool.disabled) return;

    if (tk[key]) {
        // Tool is running -- stop it
        try { tk[key](); } catch(e) { console.error('Cleanup error:', key, e); }
        delete tk[key];
        state[key] = false;
    } else {
        // Tool is stopped -- start it
        try {
            tk[key] = tool.on();
            state[key] = true;
        } catch(e) {
            console.error('Start error:', key, e);
        }
    }
}

// ============================================================
// MENU UI
// ============================================================
var M_BG = '#131620', M_S1 = '#181c28', M_S2 = '#1e2333';
var M_BORD = 'rgba(255,255,255,0.10)';
var M_T = '#e8e8f0', M_DIM = '#9aa0ab', M_FAINT = '#5a6270';
var M_ACC = '#6C6FFF';
var M_MONO = "'JetBrains Mono','SF Mono',Consolas,monospace";
var M_BODY = "-apple-system,system-ui,'Segoe UI',Roboto,sans-serif";

// Outer frame (draggable container)
var frame = document.createElement('div');
frame.id = 'sow-toolkit-menu';
frame.style.cssText =
    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
    'z-index:2147483647;font-family:' + M_BODY + ';font-size:13px;';

var menu = document.createElement('div');
menu.style.cssText =
    'width:520px;max-width:96vw;max-height:80vh;overflow-y:auto;' +
    'background:' + M_BG + ';border:1px solid ' + M_BORD + ';' +
    'box-shadow:0 24px 80px rgba(0,0,0,0.7);color:' + M_T + ';';

// Header
var hd = document.createElement('div');
hd.style.cssText =
    'display:flex;align-items:center;gap:10px;padding:12px 14px;' +
    'border-bottom:1px solid ' + M_BORD + ';border-left:3px solid ' + M_ACC + ';' +
    'background:' + M_S1 + ';user-select:none;';
hd.innerHTML =
    '<span style="font-weight:700;font-size:13px;">SOW Toolkit</span>' +
    '<span style="font-family:' + M_MONO + ';font-size:10px;font-weight:700;' +
        'color:' + M_ACC + ';background:rgba(108,111,255,0.1);' +
        'border:1px solid rgba(108,111,255,0.45);padding:2px 6px;">v1.0</span>' +
    '<span style="flex:1;"></span>' +
    '<span id="sow-tk-close" style="cursor:pointer;color:' + M_FAINT +
        ';font-size:16px;padding:2px 6px;">&#10005;</span>';
menu.appendChild(hd);

// Draggable
(function() {
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    hd.style.cursor = 'move';
    hd.addEventListener('pointerdown', function(e) {
        if (e.target.id === 'sow-tk-close') return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        var r = frame.getBoundingClientRect();
        ox = r.left; oy = r.top;
        frame.style.transform = 'none';
        frame.style.left = ox + 'px'; frame.style.top = oy + 'px';
        hd.setPointerCapture(e.pointerId);
    });
    hd.addEventListener('pointermove', function(e) {
        if (!dragging) return;
        frame.style.left = (ox + e.clientX - sx) + 'px';
        frame.style.top = (oy + e.clientY - sy) + 'px';
    });
    hd.addEventListener('pointerup', function() { dragging = false; });
})();

// Build categorised tool grid
var grid = document.createElement('div');
grid.style.cssText = 'padding:10px;display:flex;flex-direction:column;gap:8px;';

CATS.forEach(function(cat) {
    var box = document.createElement('div');
    box.style.cssText =
        'border:1px solid ' + M_BORD + ';background:rgba(255,255,255,0.02);';

    // Category header
    var catHd = document.createElement('div');
    catHd.style.cssText =
        'font-family:' + M_MONO + ';font-size:9px;font-weight:700;' +
        'letter-spacing:1.2px;padding:7px 10px 5px;color:' + M_FAINT + ';' +
        'border-bottom:1px solid ' + M_BORD + ';';
    catHd.textContent = cat.title;
    box.appendChild(catHd);

    // Tool rows
    var list = document.createElement('div');
    list.style.cssText = 'padding:4px;display:flex;flex-direction:column;gap:2px;';

    cat.keys.forEach(function(key) {
        var tool = null;
        tools.forEach(function(t) { if (t.key === key) tool = t; });
        if (!tool) return;

        var row = document.createElement('div');
        row.style.cssText =
            'display:flex;align-items:center;gap:8px;padding:8px 10px;' +
            'transition:background 0.1s;';
        row.addEventListener('mouseenter', function() {
            row.style.background = M_S2;
        });
        row.addEventListener('mouseleave', function() {
            row.style.background = 'transparent';
        });

        // Tool info
        var info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        info.innerHTML =
            '<div style="font-weight:600;font-size:12px;">' + tool.name + '</div>' +
            '<div style="font-size:11px;color:' + M_DIM + ';margin-top:1px;">' +
                (DESCS[key] || '') + '</div>';
        row.appendChild(info);

        // Toggle switch
        var isOn = !!state[key] && !!tk[key];
        var toggle = document.createElement('div');
        toggle.style.cssText =
            'width:36px;height:20px;border-radius:10px;cursor:pointer;' +
            'position:relative;transition:all 0.2s;flex-shrink:0;' +
            (isOn
                ? 'background:' + M_ACC + ';border:1px solid ' + M_ACC + ';'
                : 'background:' + M_S2 + ';border:1px solid ' + M_BORD + ';');
        var dot = document.createElement('div');
        dot.style.cssText =
            'width:14px;height:14px;border-radius:50%;position:absolute;top:2px;' +
            'transition:all 0.2s cubic-bezier(0.4,0,0.2,1);' +
            (isOn
                ? 'left:18px;background:#fff;'
                : 'left:2px;background:#3a4152;');
        toggle.appendChild(dot);

        function renderToggle() {
            var on = !!state[key] && !!tk[key];
            if (on) {
                toggle.style.background = M_ACC;
                toggle.style.borderColor = M_ACC;
                dot.style.left = '18px';
                dot.style.background = '#fff';
            } else {
                toggle.style.background = M_S2;
                toggle.style.borderColor = M_BORD;
                dot.style.left = '2px';
                dot.style.background = '#3a4152';
            }
        }

        toggle.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleTool(key);
            renderToggle();
        });

        row.appendChild(toggle);
        list.appendChild(row);
    });

    box.appendChild(list);
    grid.appendChild(box);
});

menu.appendChild(grid);

// Footer
var footer = document.createElement('div');
footer.style.cssText =
    'padding:10px 14px;border-top:1px solid ' + M_BORD + ';' +
    'background:' + M_S1 + ';font-family:' + M_MONO + ';' +
    'font-size:10px;color:' + M_FAINT + ';';
footer.textContent = 'click the bookmarklet again to toggle this menu';
menu.appendChild(footer);

frame.appendChild(menu);
document.body.appendChild(frame);

// Close button
document.getElementById('sow-tk-close').addEventListener('click', function() {
    frame.style.display = 'none';
});

// Auto-start tools that were toggled on last session
tools.forEach(function(t) {
    if (!t.disabled && state[t.key] && !tk[t.key]) {
        try { tk[t.key] = t.on(); } catch(e) { console.error(t.key, e); }
    }
});
