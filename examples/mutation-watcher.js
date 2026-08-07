// MutationObserver that survives SOW's SPA navigations.
// Demonstrates: shadow DOM auto-discovery, periodic re-scan,
// injection into dynamically-mounted components, cleanup.

'use strict';

var watched = new WeakSet();
var observers = [];
var intervals = [];

// Your injection logic -- called whenever new content appears
function inject(root) {
    // Example: find all contact cards and add a button
    root.querySelectorAll('sn-contact-card').forEach(function(card) {
        var sr = card.shadowRoot;
        if (!sr) return;

        // Skip if already injected
        if (sr.querySelector('.my-injected-btn')) return;

        var container = sr.querySelector('.sn-contact-card--content') ||
                        sr.querySelector('.sn-contact-card--container');
        if (!container) return;

        var btn = document.createElement('button');
        btn.className = 'my-injected-btn';
        btn.textContent = 'My Action';
        btn.style.cssText =
            'margin-top:6px;padding:4px 10px;font-size:12px;' +
            'color:#fff;background:#293e40;border:none;cursor:pointer;';
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            console.log('Button clicked on card:', card.getAttribute('aria-label'));
        });
        container.appendChild(btn);
    });
}

// Watch a shadow root for changes, auto-inject when content appears
function watchShadow(el) {
    if (!el || !el.shadowRoot || watched.has(el.shadowRoot)) return;
    watched.add(el.shadowRoot);

    // Inject into existing content
    inject(el.shadowRoot);

    // Watch for future changes
    var obs = new MutationObserver(function() {
        inject(el.shadowRoot);
    });
    obs.observe(el.shadowRoot, { childList: true, subtree: true });
    observers.push(obs);

    // Recurse into nested shadow roots
    el.shadowRoot.querySelectorAll('*').forEach(watchShadow);
}

// Top-level observer for the document body
var bodyObs = new MutationObserver(function() {
    inject(document);
    document.querySelectorAll('*').forEach(watchShadow);
});
bodyObs.observe(document.body, { childList: true, subtree: true });
observers.push(bodyObs);

// Initial scan
inject(document);
document.querySelectorAll('*').forEach(watchShadow);

// Periodic re-scan (catches lazily-mounted components)
var scanIv = setInterval(function() {
    inject(document);
    document.querySelectorAll('*').forEach(watchShadow);
}, 3000);
intervals.push(scanIv);

// Cleanup function -- call this to fully remove the tool
function cleanup() {
    intervals.forEach(clearInterval);
    observers.forEach(function(o) { o.disconnect(); });
    // Remove injected elements
    var allRoots = [document];
    function collectRoots(root) {
        root.querySelectorAll('*').forEach(function(el) {
            if (el.shadowRoot) {
                allRoots.push(el.shadowRoot);
                collectRoots(el.shadowRoot);
            }
        });
    }
    collectRoots(document);
    allRoots.forEach(function(root) {
        root.querySelectorAll('.my-injected-btn').forEach(function(btn) {
            btn.remove();
        });
    });
}
