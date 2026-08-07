# Installer Page Template

A complete, copy-paste HTML template for bookmarklet installer pages.
Includes drag-to-install, copy fallback, module listing, and the JavaScript
wrapping logic. Replace the marked sections with your tool code.

## Standard Template (Small-Medium Payloads)

For tools under ~80KB encoded. Uses the `encodeURIComponent(functionBody)` approach.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>My SOW Tool - Install</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
        --page:      oklch(14% 0.018 268);
        --surface-0: oklch(19% 0.022 268);
        --surface-1: oklch(22% 0.026 268);
        --surface-2: oklch(26% 0.032 268);
        --border:       oklch(100% 0 0 / 0.10);
        --border-faint: oklch(100% 0 0 / 0.06);
        --text:  oklch(93% 0.008 286);
        --dim:   oklch(70% 0.012 250);
        --faint: oklch(55% 0.018 255);
        --accent:      oklch(68% 0.15 277);
        --accent-soft: oklch(68% 0.15 277 / 0.10);
        --accent-bord: oklch(68% 0.15 277 / 0.45);
        --ok:     oklch(70% 0.15 163);
        --danger: oklch(64% 0.21 25);
        --mono: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
        --body: -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;
        --sp-chip:    4px;
        --sp-tight:   8px;
        --sp-row:     12px;
        --sp-inset:   16px;
        --sp-section: 24px;
        --sp-page:    32px;
    }
    html { background: var(--page); }
    body {
        background: var(--page); color: var(--text); font-family: var(--body);
        min-height: 100vh; display: flex; align-items: flex-start;
        justify-content: center; padding: var(--sp-page) var(--sp-inset);
        font-size: 13px; line-height: 1.5;
    }
    .panel {
        width: 100%; max-width: 720px;
        background: var(--surface-0); border: 1px solid var(--border);
        box-shadow: 0 12px 40px oklch(0% 0 0 / 0.5);
    }
    .panel-hd {
        display: flex; align-items: center; gap: 10px;
        padding: var(--sp-row) 14px;
        border-bottom: 1px solid var(--border);
        border-left: 3px solid var(--accent);
        background: var(--surface-1);
    }
    .panel-hd .title { font-weight: 700; font-size: 13px; }
    .chip {
        font-family: var(--mono); font-size: 10px; font-weight: 700;
        color: var(--accent); background: var(--accent-soft);
        border: 1px solid var(--accent-bord); padding: 2px 6px;
    }
    .install {
        display: flex; align-items: center; gap: var(--sp-section);
        padding: var(--sp-inset) 14px; border-bottom: 1px solid var(--border);
    }
    .install-copy { flex: 1; min-width: 0; }
    .install-copy h2 { font-size: 13px; font-weight: 700; margin-bottom: var(--sp-chip); }
    .install-copy p { color: var(--dim); font-size: 12px; max-width: 420px; }
    .install-copy kbd {
        font-family: var(--mono); font-size: 11px; color: var(--text);
        background: var(--surface-2); border: 1px solid var(--border);
        padding: 1px var(--sp-chip); white-space: nowrap;
    }
    .drag-btn {
        display: inline-flex; align-items: center; gap: var(--sp-tight);
        font-family: var(--body); font-size: 13px; font-weight: 600;
        color: var(--accent); background: var(--accent-soft);
        border: 1px solid var(--accent-bord);
        padding: 10px 18px; text-decoration: none; cursor: grab;
        transition: transform 0.12s ease, opacity 0.12s ease;
    }
    .drag-btn:hover { border-color: var(--accent); }
    .drag-btn:active { cursor: grabbing; transform: translateY(1px); }
    .drag-hint {
        font-size: 11px; color: var(--faint); margin-top: var(--sp-tight);
    }
    .copy-btn {
        font-family: var(--mono); font-size: 11px; color: var(--dim);
        background: transparent; border: 1px solid var(--border);
        padding: 4px 10px; cursor: pointer; margin-top: var(--sp-tight);
    }
    .copy-btn:hover { border-color: var(--accent); color: var(--text); }
    .modules { list-style: none; }
    .mod-row {
        display: grid; grid-template-columns: 64px 1fr;
        gap: var(--sp-inset); align-items: baseline;
        padding: var(--sp-row) 14px;
        border-top: 1px solid var(--border-faint);
    }
    .mod-row:hover { background: var(--surface-1); }
    .mod-key {
        font-family: var(--mono); font-size: 11px; font-weight: 500;
        color: var(--accent);
    }
    .mod-name { font-size: 13px; font-weight: 700; }
    .mod-desc { font-size: 12px; color: var(--dim); margin-top: 2px; }
    .panel-ft {
        padding: var(--sp-tight) 14px;
        border-top: 1px solid var(--border); background: var(--surface-1);
        font-family: var(--mono); font-size: 11px; color: var(--dim);
    }
    @media (max-width: 640px) {
        .install { flex-direction: column; align-items: stretch; }
    }
    @media (prefers-reduced-motion: reduce) {
        .drag-btn { transition: none; }
    }
</style>
</head>
<body>
<main class="panel">
    <header class="panel-hd">
        <span class="title">My SOW Tool</span>
        <span class="chip">v1.0</span>
    </header>

    <section class="install">
        <div class="install-copy">
            <h2>Install</h2>
            <p>
                Drag the button to your bookmarks bar, then click it on any
                SOW page. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>
                if the bookmarks bar is hidden.
            </p>
            <button class="copy-btn" id="copy-btn">Copy bookmarklet code</button>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:var(--sp-tight);flex-shrink:0;">
            <a class="drag-btn" id="install-link" href="javascript:void(0)">
                My SOW Tool
            </a>
            <span class="drag-hint">drag to your bookmarks bar</span>
        </div>
    </section>

    <!-- List your modules/features here -->
    <ol class="modules">
        <li class="mod-row">
            <span class="mod-key">feat1</span>
            <div>
                <div class="mod-name">Feature One</div>
                <div class="mod-desc">Description of what this feature does.</div>
            </div>
        </li>
        <li class="mod-row">
            <span class="mod-key">feat2</span>
            <div>
                <div class="mod-name">Feature Two</div>
                <div class="mod-desc">Description of the second feature.</div>
            </div>
        </li>
    </ol>

    <footer class="panel-ft">v1.0</footer>
</main>

<script>
(function() {
    // ================================================================
    // REPLACE THIS FUNCTION BODY WITH YOUR TOOL CODE
    // ================================================================
    var toolCode = function() {
        'use strict';

        // Re-entry guard
        var existing = document.getElementById('my-tool-root');
        if (existing) {
            existing.style.display =
                existing.style.display === 'none' ? 'block' : 'none';
            return;
        }

        // -- YOUR TOOL CODE GOES HERE --
        var el = document.createElement('div');
        el.id = 'my-tool-root';
        el.textContent = 'Tool is running.';
        el.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;' +
            'background:#131620;color:#e8e8f0;padding:12px 16px;' +
            'border:1px solid rgba(255,255,255,0.1);font-size:13px;';
        document.body.appendChild(el);
    };
    // ================================================================

    // Wrap and set as bookmarklet href
    var code = toolCode.toString();
    var body = code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'));
    var href = 'javascript:void((function(){' + encodeURIComponent(body) + '})())';
    document.getElementById('install-link').href = href;

    // Copy fallback
    document.getElementById('copy-btn').addEventListener('click', function() {
        var fullCode = 'javascript:void((function(){' + encodeURIComponent(body) + '})())';
        if (navigator.clipboard) {
            navigator.clipboard.writeText(fullCode).then(function() {
                document.getElementById('copy-btn').textContent = 'Copied';
            });
        } else {
            var ta = document.createElement('textarea');
            ta.value = fullCode;
            ta.style.cssText = 'position:fixed;left:-9999px;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            document.getElementById('copy-btn').textContent = 'Copied';
        }
        setTimeout(function() {
            document.getElementById('copy-btn').textContent = 'Copy bookmarklet code';
        }, 2000);
    });
})();
</script>
</body>
</html>
```

## Large Payload Template (Base64)

For tools over ~80KB. Encode the source as base64 and decode at install time:

```html
<!-- Same HTML structure as above, but replace the <script> with: -->
<script>
(function() {
    // Base64-encoded UTF-8 source of your tool
    var PAYLOAD_B64 = "PUT_YOUR_BASE64_HERE";

    function b64ToUtf8(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    }

    var source = b64ToUtf8(PAYLOAD_B64);
    var href = 'javascript:' + encodeURIComponent(source);
    document.getElementById('install-link').href = href;

    document.getElementById('copy-btn').addEventListener('click', function() {
        if (navigator.clipboard) {
            navigator.clipboard.writeText(href).then(function() {
                document.getElementById('copy-btn').textContent = 'Copied';
            });
        }
        setTimeout(function() {
            document.getElementById('copy-btn').textContent = 'Copy bookmarklet code';
        }, 2000);
    });
})();
</script>
```

To generate the base64 payload, use:

```bash
base64 -w0 my-tool.js
```

Or in Node.js:

```javascript
const fs = require('fs');
const source = fs.readFileSync('my-tool.js', 'utf-8');
const b64 = Buffer.from(source, 'utf-8').toString('base64');
fs.writeFileSync('payload.b64', b64);
```
