# Comment and Journal Parsing

ServiceNow stores comments and work notes in journal fields. There are two ways
to read them, each with trade-offs.

**Start with Method 2 (inline parsing).** Journal-table reads are the cleaner
API, but row-level ACLs block them on many instances and return HTTP 200 with
zero rows rather than an error. A tool built on Method 1 alone looks like it is
working while silently reporting no comments. Build inline parsing first, then
use the journal table as an optimisation where it is permitted.

## Method 1: sys_journal_field Table (When ACLs Allow)

Query `sys_journal_field` for individual journal entries with author and
timestamp. Three details matter:

- Query **all** tracked tables at once with `nameIN`, not one table per call.
- Do **not** put `element_idIN…` in the query. Scoping by element id is what
  trips the ACL on restricted instances and returns nothing. Filter to your
  tracked records client-side instead.
- Read comments here, but get **work notes from the inline field** — they are
  frequently blocked separately even when comments are readable.

```javascript
function fetchJournalEntries(tableNames, trackedIds, sinceUtc) {
    // Re-read slightly behind the high-water mark: entries can be committed
    // out of order relative to their timestamps.
    var overlap = fmtUTC(new Date(
        Date.parse(sinceUtc.replace(' ', 'T') + 'Z') - 120000));

    var q = 'nameIN' + tableNames.join(',') +
            '^element=comments' +
            '^sys_created_on>' + overlap +
            '^ORDERBYsys_created_on';

    return snGet('sys_journal_field', q,
        ['sys_id', 'element_id', 'name', 'value', 'sys_created_by', 'sys_created_on'],
        80
    ).then(function(rows) {
        // Scope client-side: trackedIds maps element_id -> your ticket record
        return rows.filter(function(row) { return trackedIds[rv(row.element_id)]; });
    });
}
```

Treat both a 403 **and** an unexpectedly empty result as a signal to switch
permanently to Method 2 for the session:

```javascript
var journalMode = 'inline';   // 'journal' | 'inline'
```

Dedupe by the journal row's own `sys_id`; you do not need content hashing on
this path.

## Method 2: Inline Comment Parsing (Primary)

Read the concatenated journal text from the record's `comments` and `work_notes`
fields. Request these with `sysparm_display_value=true`, not `all` — you want the
rendered strings, and the nested `{ value, display_value }` objects just get in
the way:

```javascript
snGetById(table, sysId, ['comments', 'work_notes', 'number', 'short_description', 'state']);
// with sysparm_display_value=true
```

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

To detect new comments without re-firing events for old ones, hash each entry.
Include `kind` in the hash: a comment and a work note posted in the same second
by the same author with the same text are different events, and leaving `kind`
out silently swallows one of them.

```javascript
function hashEntry(entry) {
    // djb2 over timestamp + author + kind + a short body prefix.
    // 60 chars is enough to disambiguate; longer prefixes make the key churn
    // when ServiceNow re-renders trailing whitespace or markup.
    var str = entry.timestamp + '|' + entry.author + '|' + entry.kind + '|' +
              entry.body.slice(0, 60);
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}

// Track seen hashes per ticket
var seenHashes = {}; // { 'table|sysId': [hash, hash, ...] }

function detectNewComments(tableKey, sysId, journalText) {
    var key = tableKey + '|' + sysId;
    var entries = parseJournalText(journalText);
    var isBaseline = seenHashes[key] === undefined;
    var known = seenHashes[key] || [];
    var newEntries = [];

    entries.forEach(function(entry) {
        var h = hashEntry(entry);
        if (known.indexOf(h) > -1) return;
        known.push(h);
        // On the first read of a ticket, record what is already there
        // without firing events for a backlog the user has already seen.
        if (!isBaseline) newEntries.push(entry);
    });

    // A ticket with no comments must still be marked as baselined. Storing an
    // empty array reads as "never baselined" on the next cycle and replays the
    // whole history the first time a comment appears, so store a sentinel.
    seenHashes[key] = known.length ? known : ['~'];
    return newEntries;
}
```

### Baselining and adoption

The distinction between "no comments yet" and "not yet checked" causes the most
visible bug in this area — a burst of notifications for months-old comments.

- **Never seed `[]`.** Use the `['~']` sentinel above.
- **Leave newly adopted tickets `undefined`** so their existing journal is
  baselined silently on the next cycle rather than announced.
- **Re-queue failed reads.** If the read that was supposed to baseline a ticket
  errored, that ticket must be retried; otherwise it stays permanently silent
  because later cycles see a populated snapshot and assume nothing changed.

### Muting integration noise

Instances generate journal entries from integrations that no human wants to see.
Filter them before events exist, not in the UI layer:

```javascript
var MUTE_AUTHORS = ['Splunk'];
var MUTE_BODIES  = ['Incident created from Interaction'];

function isNoise(entry) {
    return MUTE_AUTHORS.some(function(a) { return entry.author.indexOf(a) > -1; })
        || MUTE_BODIES.some(function(b) { return entry.body.indexOf(b) > -1; });
}
```

### Cleaning journal body text

Journal entries may contain HTML artifacts:

```javascript
function cleanJournalBody(text) {
    var s = String(text || '');
    // SOW's rich text editor wraps pasted content in [code]...[/code]
    s = s.replace(/\[code\]([\s\S]*?)\[\/code\]/gi, function(_, inner) { return inner; });
    // Convert block-level tags to newlines before stripping, or multi-line
    // comments collapse into one unreadable run of text.
    s = s.replace(/<\s*(?:br|\/p|\/div|\/li|\/tr)\s*\/?\s*>/gi, '\n');
    return s
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
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
    incident:     { '6': true, '7': true, '8': true },   // Resolved, Closed, Canceled
    sc_req_item:  { '3': true, '4': true, '7': true },
    sc_task:      { '3': true, '4': true, '7': true },
    interaction:  { 'closed_complete': true, 'closed_abandoned': true }
};
```

These numeric codes come from choice lists and **are customised per instance**.
Always keep a display-value fallback so an unknown table or a renumbered choice
degrades to something sensible instead of treating every ticket as open:

```javascript
function isClosedState(table, rawVal, displayVal) {
    var map = CLOSED_STATES[table];
    if (map && map[String(rawVal).toLowerCase()]) return true;
    return /resolved|closed|complete|cancel/.test(String(displayVal || '').toLowerCase());
}
```

Note that `interaction` uses workflow **strings** while task tables use numbers —
code that assumes numeric states breaks on IMS records.

## Linking Tickets to an Interaction

Comments on a family of related records live in different places: the
customer-visible conversation is usually on the parent RITM while the working
detail is on the SCTASK. If you watch only one, you miss half the story. When you
track an `sc_task`, follow `request_item` up to its RITM as well.

To associate a ticket with an interaction, POST to `interaction_related_record` —
do not try to PATCH the interaction:

```javascript
function associateToInteraction(interactionSysId, documentTable, documentSysId) {
    return fetch('/api/now/table/interaction_related_record', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-UserToken': getToken()
        },
        body: JSON.stringify({
            interaction: interactionSysId,
            document_table: documentTable,   // 'incident', 'sc_request', ...
            document_id: documentSysId
        })
    }).then(function(r) {
        if (r.status === 201 || r.ok) return { ok: true };
        if (r.status === 403) return { ok: false, msg: 'Permission denied' };
        return { ok: false, msg: 'Failed (' + r.status + ')' };
    });
}
```

A successful create returns **201**, not 200. Resolve the prefix to the right
table first, walking up to the parent where appropriate: `SCTASK` to its RITM to
its REQ, `RITM` to its REQ.

## Scoping Interaction Queries

Interactions auto-assign to whoever handles the call, so scoping an IMS query by
`assigned_to` matches every interaction the user has ever touched. On first run
that adopts hundreds of records and produces a notification storm. Scope by
`opened_by` instead.
