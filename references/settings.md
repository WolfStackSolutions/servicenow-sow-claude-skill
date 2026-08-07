# Settings Persistence

SOW environments often block `localStorage` and `sessionStorage`. The proven
fallback is the File System Access API with an IndexedDB handle cache.

## Strategy

1. **First choice**: `localStorage` (fast, synchronous, but may be blocked)
2. **Durable storage**: File System Access API writes a JSON file to disk
3. **Handle cache**: IndexedDB stores the file handle so subsequent reads/writes
   are silent (no picker dialog)

## File System Access API Pattern

```javascript
var SETTINGS_FILE = 'my_tool_settings.json';
var settingsHandle = null;

// IndexedDB for caching the file handle
function idbOpen() {
    return new Promise(function(res, rej) {
        try {
            var req = indexedDB.open('my-tool', 1);
            req.onupgradeneeded = function() {
                req.result.createObjectStore('handles');
            };
            req.onsuccess = function() { res(req.result); };
            req.onerror = function() { rej(req.error); };
        } catch(e) { rej(e); }
    });
}

function idbGet(key) {
    return idbOpen().then(function(db) {
        return new Promise(function(res, rej) {
            var rq = db.transaction('handles', 'readonly')
                       .objectStore('handles').get(key);
            rq.onsuccess = function() { res(rq.result || null); };
            rq.onerror = function() { rej(rq.error); };
        });
    }).catch(function() { return null; });
}

function idbSet(key, val) {
    return idbOpen().then(function(db) {
        return new Promise(function(res, rej) {
            var tx = db.transaction('handles', 'readwrite');
            tx.objectStore('handles').put(val, key);
            tx.oncomplete = function() { res(); };
            tx.onerror = function() { rej(tx.error); };
        });
    }).catch(function() {});
}

// Permission check
function ensurePermission(handle, write) {
    var opts = { mode: write ? 'readwrite' : 'read' };
    return handle.queryPermission(opts).then(function(p) {
        if (p === 'granted') return true;
        return handle.requestPermission(opts).then(function(p2) {
            return p2 === 'granted';
        });
    });
}

// Pick a file (only needed on first use)
function pickFile(forSave) {
    var opts = {
        id: 'my-tool',
        startIn: 'documents',
        types: [{
            description: 'Tool settings',
            accept: { 'application/json': ['.json'] }
        }]
    };
    var p;
    if (forSave) {
        opts.suggestedName = SETTINGS_FILE;
        p = window.showSaveFilePicker(opts);
    } else {
        p = window.showOpenFilePicker(opts).then(function(a) { return a[0]; });
    }
    return p.then(function(h) {
        settingsHandle = h;
        idbSet('settings', h); // cache for next time
        return h;
    });
}

// Get handle (from cache or picker)
function getHandle(forSave) {
    if (settingsHandle) return Promise.resolve(settingsHandle);
    return idbGet('settings').then(function(h) {
        if (h) { settingsHandle = h; return h; }
        return pickFile(forSave);
    });
}

// Save
function saveSettings(state) {
    if (!window.showSaveFilePicker) {
        // Fallback: download as blob
        var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = SETTINGS_FILE;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        return Promise.resolve();
    }
    return getHandle(true).then(function(h) {
        return ensurePermission(h, true).then(function(ok) {
            if (!ok) throw new Error('Permission denied');
            return h.createWritable();
        }).then(function(w) {
            return w.write(JSON.stringify(state, null, 2)).then(function() {
                return w.close();
            });
        });
    });
}

// Load
function loadSettings() {
    if (!window.showOpenFilePicker) {
        // Fallback: file input
        return new Promise(function(resolve) {
            var inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = '.json';
            inp.addEventListener('change', function() {
                var f = inp.files[0];
                if (!f) { resolve(null); return; }
                var reader = new FileReader();
                reader.onload = function() {
                    try { resolve(JSON.parse(reader.result)); }
                    catch(e) { resolve(null); }
                };
                reader.readAsText(f);
            });
            inp.click();
        });
    }
    return getHandle(false).then(function(h) {
        return ensurePermission(h, false).then(function(ok) {
            if (!ok) throw new Error('Permission denied');
            return h.getFile();
        }).then(function(f) {
            return f.text();
        }).then(function(text) {
            return JSON.parse(text);
        });
    });
}

// Auto-save (debounced)
var saveTimer = null;
function autoSave(state) {
    if (!settingsHandle) return; // no handle yet, skip silent save
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function() {
        saveSettings(state).catch(function() {});
    }, 800);
}

// Auto-sync on startup (silent, no picker)
function autoSync(callback) {
    if (!window.showSaveFilePicker) return;
    idbGet('settings').then(function(h) {
        if (!h) return;
        settingsHandle = h;
        loadSettings()
            .then(function(cfg) { if (cfg) callback(cfg); })
            .catch(function() {}); // stale handle or permission expired
    });
}
```

## localStorage Wrapper (With Graceful Failure)

```javascript
function lsGet(key, defaultValue) {
    try {
        var val = localStorage.getItem(key);
        return val ? JSON.parse(val) : defaultValue;
    } catch(e) {
        return defaultValue;
    }
}

function lsSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch(e) {}
}
```
