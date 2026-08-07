# Comment and Journal Parsing

ServiceNow stores comments and work notes in journal fields. There are two ways
to read them, each with trade-offs.

## Method 1: sys_journal_field Table (Preferred When Available)

Query `sys_journal_field` for individual journal entries with author and timestamp.
This is the cleanest approach but may be ACL-blocked on some instances.

```javascript
function fetchJournalEntries(tableName, elementIds, sinceUtc) {
    var q = 'nameIN' + tableName +
            '^element=comments' +
            '^sys_created_on>' + sinceUtc +
            '^ORDERBYsys_created_on';
    return snGet('sys_journal_field', q,
        ['sys_id', 'element_id', 'name', 'value', 'sys_created_by', 'sys_created_on'],
        80
    );
}
```

If this returns 403 or an empty result set when you expect data, the instance
has ACL-blocked it. Fall back to Method 2.

## Method 2: Inline Comment Parsing (Fallback)

Read the concatenated journal text from the record's `comments` or `work_notes`
display value. ServiceNow renders entries with header lines like:

```
15/07/2026 09:39:45 - Jane Smith (Additional comments)
The actual comment body text here...

14/07/2026 16:22:10 - John Doe (Work notes)
Internal work note body...
```

### Parsing the header format

```javascript
var JOURNAL_HEADER = /(\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}[ ]+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\s*-\s*(.+?)\s*\((Additional comments|Work notes|Comments|Customer visible)\)/g;

function parseJournalText(text) {
    var marks = [];
    var match;
    JOURNAL_HEADER.lastIndex = 0;
    while ((match = JOURNAL_HEADER.exec(text)) !== null) {
        marks.push({
            index: match.index,
            length: match[0].length,
            timestamp: match[1],
            author: match[2].trim(),
            kind: match[3]  // 'Additional comments', 'Work notes', etc.
        });
    }

    var entries = [];
    for (var i = 0; i < marks.length; i++) {
        var bodyStart = marks[i].index + marks[i].length;
        var bodyEnd = (i + 1 < marks.length) ? marks[i + 1].index : text.length;
        var body = text.substring(bodyStart, bodyEnd).trim();
        entries.push({
            timestamp: marks[i].timestamp,
            author: marks[i].author,
            kind: marks[i].kind,
            body: body
        });
    }
    return entries; // newest first (ServiceNow prepends new entries)
}
```

### Content-addressed deduplication

To detect new comments without re-firing events for old ones, hash each entry:

```javascript
function hashEntry(entry) {
    // Simple content-addressed hash
    var str = entry.timestamp + '|' + entry.author + '|' + entry.body.slice(0, 200);
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return String(hash);
}

// Track seen hashes per ticket
var seenHashes = {}; // { 'table|sysId': Set of hashes }

function detectNewComments(tableKey, sysId, journalText) {
    var key = tableKey + '|' + sysId;
    if (!seenHashes[key]) seenHashes[key] = {};

    var entries = parseJournalText(journalText);
    var newEntries = [];

    entries.forEach(function(entry) {
        var h = hashEntry(entry);
        if (!seenHashes[key][h]) {
            seenHashes[key][h] = true;
            newEntries.push(entry);
        }
    });

    return newEntries;
}
```

### Cleaning journal body text

Journal entries may contain HTML artifacts:

```javascript
function cleanJournalBody(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')   // strip HTML tags
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}
```

## Snapshot-Diff Engine for Change Detection

Track ticket state changes by comparing snapshots across poll cycles:

```javascript
function snapshot(record, tableDef) {
    return {
        num: dv(record.number),
        sd: dv(record.short_description),
        groupDv: dv(record.assignment_group),
        groupRv: rv(record.assignment_group),
        assignDv: dv(record.assigned_to),
        assignRv: rv(record.assigned_to),
        stateRv: rv(record.state),
        stateDv: dv(record.state),
        updatedOn: rv(record.sys_updated_on),
        closed: !!(tableDef.closedStates[rv(record.state)])
    };
}

function diff(oldSnap, newSnap) {
    var events = [];
    if (oldSnap.groupRv !== newSnap.groupRv) {
        events.push({
            type: 'group',
            text: oldSnap.groupDv + ' -> ' + newSnap.groupDv
        });
    }
    if (oldSnap.assignRv !== newSnap.assignRv) {
        events.push({
            type: 'assign',
            text: oldSnap.assignDv + ' -> ' + newSnap.assignDv
        });
    }
    if (oldSnap.stateRv !== newSnap.stateRv) {
        if (!oldSnap.closed && newSnap.closed) {
            events.push({ type: 'resolved', text: newSnap.stateDv });
        } else if (oldSnap.closed && !newSnap.closed) {
            events.push({ type: 'reopened', text: newSnap.stateDv });
        } else if (!oldSnap.closed && !newSnap.closed) {
            events.push({
                type: 'state',
                text: oldSnap.stateDv + ' -> ' + newSnap.stateDv
            });
        }
        // closed -> closed transitions (e.g. resolved -> closed) are noise
    }
    return events;
}
```

## Closed State Codes

Different tables use different raw values for closed states:

```javascript
var CLOSED_STATES = {
    incident:     { '6': true, '7': true, '8': true },
    sc_req_item:  { '3': true, '4': true, '7': true },
    sc_task:      { '3': true, '4': true, '7': true },
    interaction:  { 'closed_complete': true, 'closed_abandoned': true }
};
```
