# Settings Persistence

SOW environments often block `localStorage` and `sessionStorage`. The proven
durable store is the File System Access API with an IndexedDB handle cache.

## Strategy

Do not treat `localStorage` as the primary store and the file as a fallback. In a
locked-down environment that gets you a tool that works while you test it and
forgets everything for real users. The layering that survives:

1. **In-memory** on your namespace (`tk.state`) — always works, always the live
   copy your UI reads.
2. **A JSON file** via the File System Access API — the durable copy. The user
   picks the location once.
3. **IndexedDB** — caches the *file handle* only, so later saves and loads are
   silent with no picker.
4. **Download / file-input** — last-resort manual export and import when
   `showSaveFilePicker` is unavailable.

`localStorage` still has a place, just not this one. It is well suited to
throwaway data where loss is acceptable: a response cache, or bulky event history
you would not want in a settings file. Wrap every access in try/catch and treat
failure as a cache miss.

Three rules make the difference between this working and annoying users:

- **Never open a file picker unprompted.** Restore silently if a handle is
  cached; otherwise stay in memory until the user explicitly saves.
- **Debounce writes** (around 800ms). Settings toggles fire in bursts.
- **Gate autosave** behind a "synced" flag, so an early write cannot clobber a
  good file with default state before the load has completed.

```javascript
var SETTINGS_FILE = 'sow_settings.json';
var saveTimer = null;

function saveState() {
    if (!window.showSaveFilePicker || !tk.settingsHandle || !tk.settingsSynced) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeSettingsFile, 800);
}

// On startup: silent restore only, never a picker
(function autoSync() {
    if (!window.showSaveFilePicker || tk.settingsAutoSynced) return;
    tk.settingsAutoSynced = true;
    idbGet('settings').then(function(handle) {
        if (!handle) return;                 // no handle yet: stay in memory
        tk.settingsHandle = handle;
        loadSettingsFile().then(function() { tk.settingsSynced = true; });
    });
})();
```

Include a schema version in the JSON from the first release. Migrating a file you
already shipped without one means guessing at its shape.

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

Silently swallowing the write failure is deliberate — a blocked or full
`localStorage` must not break the tool. But it also means you cannot assume
anything you wrote is still there.

### Quota

Growing collections (event history, seen-comment hashes) will eventually exceed
quota. Truncate and retry rather than losing the whole record:

```javascript
function persist(state) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch (e) {
        // Almost certainly quota. Keep the newest slice and try once more.
        try {
            var trimmed = Object.assign({}, state, { events: state.events.slice(0, 50) });
            localStorage.setItem(LS_KEY, JSON.stringify(trimmed));
        } catch (e2) {}
    }
}
```

Cap caches by entry count too, evicting oldest first, so a long-lived tab does not
grow without bound.

### Stale handles

A cached IndexedDB handle can point at a file the user has moved, renamed, or
deleted. Reads then fail with `NotFoundError`. Treat that as "no handle" — clear
the cache and fall back to in-memory state rather than repeatedly erroring:

```javascript
loadSettingsFile().catch(function(e) {
    if (e && e.name === 'NotFoundError') {
        tk.settingsHandle = null;
        idbSet('settings', null);
    }
});
```

Permissions also lapse between sessions, so `ensurePermission` can return false on
a handle that worked yesterday. Both cases should degrade quietly, not prompt.
