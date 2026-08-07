# Genesys Cloud Softphone Integration

SOW integrates Genesys Cloud (PureCloud) telephony via an embedded iframe. The
iframe communicates with the host page using `window.postMessage`. The message
type is `softphone_connector`.

## Hooking Into Genesys Messages

```javascript
function hookGenesys(onMessage) {
    // The softphone iframe posts to the host window
    function handler(ev) {
        var data = ev.data;
        if (!data || data.type !== 'softphone_connector') return;
        var msg = data.msg;
        if (!msg) return;
        onMessage(msg, data);
    }
    window.addEventListener('message', handler);

    // The iframe may be in the main window or a child frame.
    // Also hook any iframe windows that load later.
    var hookedWindows = new WeakSet();
    function hookIframeWindows() {
        try {
            var frames = document.querySelectorAll('iframe');
            frames.forEach(function(frame) {
                try {
                    var win = frame.contentWindow;
                    if (win && !hookedWindows.has(win)) {
                        hookedWindows.add(win);
                        win.addEventListener('message', handler);
                    }
                } catch (e) {} // cross-origin frames will throw
            });
        } catch (e) {}
    }
    var scanInterval = setInterval(hookIframeWindows, 5000);

    return function unhook() {
        window.removeEventListener('message', handler);
        clearInterval(scanInterval);
    };
}
```

## Message Types

### Status Changes

```javascript
// msg.type === 'UserAction' && msg.category === 'status'
{
    type: 'UserAction',
    category: 'status',
    data: {
        status: 'ON_QUEUE',     // or BREAK, MEAL, TRAINING, MEETING, BUSY, AWAY, OFF_QUEUE
        sub_status: 'Tea Break' // optional sub-status text
    }
}
```

### Routing Status

```javascript
// msg.type === 'UserAction' && msg.category === 'routingStatus'
{
    type: 'UserAction',
    category: 'routingStatus',
    data: 'IDLE'  // or 'OFF_QUEUE'
}
```

### Call Lifecycle

All call events use `msg.type === 'Interaction'` with different categories:

```javascript
// INCOMING CALL (alerting)
// msg.category === 'add', msg.data.state === 'ALERTING'
{
    type: 'Interaction',
    category: 'add',
    data: {
        state: 'ALERTING',
        id: 'conversation-uuid',
        displayAddress: '+61312345678',
        ani: '+61312345678',
        name: 'Caller Name',
        queueName: 'Service Desk',
        direction: 'inbound',
        calledNumber: '+61398765432',
        totalIvrDurationSeconds: 45
    }
}

// CALL CONNECTED
// msg.category === 'connect' or 'change', data.isConnected === true
{
    type: 'Interaction',
    category: 'connect',
    data: {
        new: {
            state: 'CONNECTED',
            isConnected: true,
            id: 'conversation-uuid',
            connectedTime: '2025-01-15T09:30:00.000Z',
            displayAddress: '+61312345678',
            queueName: 'Service Desk',
            direction: 'inbound',
            totalIvrDurationSeconds: 45
        }
    }
}

// CALL DISCONNECTED (entering wrap-up)
// msg.category === 'disconnect' or 'change', data.state === 'DISCONNECTED'
{
    type: 'Interaction',
    category: 'disconnect',
    data: {
        new: {
            state: 'DISCONNECTED',
            isDisconnected: true,
            id: 'conversation-uuid',
            endTime: '2025-01-15T09:35:00.000Z',
            interactionDurationSeconds: 300,
            totalAcdDurationSeconds: 250,
            totalIvrDurationSeconds: 45
        }
    }
}

// WRAP-UP COMPLETE (after care work done)
// msg.category === 'acw', data.isDone === true
{
    type: 'Interaction',
    category: 'acw',
    data: {
        new: {
            isDone: true,
            dispositionDurationSeconds: 45
        }
    }
}
```

## Building a Call Timer

Track the call phase state machine:

```
idle -> alerting -> oncall -> wrapup -> idle
```

```javascript
var phase = { current: 'idle', anchor: null, callId: null };

function handleGenesysMsg(msg) {
    if (msg.type === 'UserAction' && msg.category === 'status') {
        updateStatusDisplay(msg.data.status, msg.data.sub_status);
        return;
    }
    if (msg.type !== 'Interaction') return;

    var d = (msg.data && msg.data.new) ? msg.data.new : msg.data;
    if (!d) return;

    if (msg.category === 'add' && d.state === 'ALERTING') {
        phase.current = 'alerting';
        phase.callId = d.id;
        phase.anchor = Date.now();
    }
    else if (d.isConnected && d.state === 'CONNECTED') {
        phase.current = 'oncall';
        phase.anchor = d.connectedTime
            ? new Date(d.connectedTime).getTime() : Date.now();
    }
    else if (d.isDisconnected && d.state === 'DISCONNECTED') {
        phase.current = 'wrapup';
        phase.anchor = d.endTime
            ? new Date(d.endTime).getTime() : Date.now();
    }
    else if (msg.category === 'acw' && d.isDone) {
        // Record call stats here
        phase.current = 'idle';
        phase.anchor = Date.now();
    }

    renderTimer();
}

function renderTimer() {
    if (phase.current === 'idle') return;
    var elapsed = (Date.now() - phase.anchor) / 1000;
    var mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    var ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    timerEl.textContent = mm + ':' + ss;
}
```
