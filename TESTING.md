# WoW Arena Multiplayer Testing Guide

This document describes how to test the multiplayer implementation locally with 2 clients on the same computer.

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐
│   Client 1      │     │   Client 2      │
│   (Browser)     │     │   (Browser)     │
│                 │     │                 │
│ - Input capture │     │ - Input capture │
│ - Prediction    │     │ - Prediction    │
│ - Interpolation │     │ - Interpolation │
└────────┬────────┘     └────────┬────────┘
         │   WebSocket           │
         │                       │
         └──────────┬────────────┘
                    │
           ┌────────▼────────┐
           │     Server      │
           │  (Node.js)      │
           │                 │
           │ - Authoritative │
           │ - 20 tick/sec   │
           │ - Snapshots     │
           └─────────────────┘
```

## Quick Start

### Terminal 1: Start the Server

```bash
# From project root
npm run dev:server
```

Expected output:
```
[Server] WoW Arena Server starting...
[Server] Listening on port 8080
```

### Terminal 2: Start the Dev Server

```bash
# From project root
npm run dev
```

This starts Vite on http://localhost:5173

### Browser: Open Two Clients

1. **Client 1**: Open http://localhost:5173?mode=multiplayer
2. **Client 2**: Open http://localhost:5173?mode=multiplayer (in new window/tab)

Both clients should connect and see each other.

## Console Logging Reference

The network code includes strategic logging at critical points. Open browser DevTools (F12) to see:

### Client Logs

| Log Prefix | Description |
|------------|-------------|
| `[Socket]` | WebSocket connection events |
| `[Clock]` | RTT measurements (every 5th sample) |
| `[NetworkGame]` | Welcome, snapshots, disconnect |
| `[Prediction]` | Position corrections (when error > 0.5 units) |
| `[InputManager]` | Input acknowledgments (when > 5 at once) |
| `[Game]` | Mode, connection state, events |

### Server Logs

| Log Prefix | Description |
|------------|-------------|
| `[Server]` | Start/stop, client connect/disconnect |
| `[GameState]` | Player actions, combat events |

## Testing Scenarios

### 1. Basic Connection

**Steps:**
1. Start server
2. Open client in multiplayer mode
3. Check console for connection flow

**Expected logs (client):**
```
[Game] Starting in multiplayer mode
[Game] Server URL: ws://localhost:8080
[Socket] WebSocket open, waiting for Welcome...
[NetworkGame] Welcome received, playerId: player_xxx
[Game] Welcome! Player ID: player_xxx
[Clock] First RTT sample: Xms, offset: Xms
```

**Expected logs (server):**
```
[Server] Client connected: player_xxx as Mage (1 total)
```

### 2. Two Clients See Each Other

**Steps:**
1. Connect Client 1
2. Connect Client 2
3. Move Client 1 around

**Expected:**
- Client 2 sees Client 1's capsule moving
- Movement appears smooth (interpolation working)

### 3. Network Latency Simulation

To test with artificial latency, use Chrome DevTools:
1. Open DevTools → Network tab
2. Click "No throttling" dropdown
3. Select "Slow 3G" or add custom profile

**Expected:**
- Higher RTT shown in debug overlay
- Movement still smooth but delayed
- Prediction corrections may appear in console

### 4. Reconnection

**Steps:**
1. Connect client
2. Stop server (Ctrl+C)
3. Observe client logs
4. Restart server
5. Wait for reconnection

**Expected logs:**
```
[Socket] Disconnected
[NetworkGame] Disconnected, resetting state
[Socket] Reconnecting in 1000ms (attempt 1)
[Socket] WebSocket open, waiting for Welcome...
[NetworkGame] Welcome received, playerId: player_xxx
```

### 5. Prediction Accuracy

**Steps:**
1. Connect client
2. Run in circles while watching console
3. Look for prediction correction logs

**If prediction is accurate:**
- Minimal `[Prediction] Correction needed` logs
- No `[Prediction] Large error` warnings

**If predictions mismatch:**
- Console will show correction magnitudes
- Character may "rubber-band" visibly

## Debug Overlay

The in-game debug display shows:
```
Rogue | connected | RTT: 15ms | Conn: connected | RTT: 15ms | Offset: 5ms | Samples: 10 | Pending: 2 | Predicted: (0.0, 0.0, 0.0) | Error: 0.000
```

| Field | Description |
|-------|-------------|
| Class | Current player class |
| State | Connection state |
| RTT | Round-trip time to server |
| Offset | Clock sync offset |
| Samples | Clock sync sample count |
| Pending | Unacknowledged inputs |
| Predicted | Local predicted position |
| Error | Current prediction error |

## Common Issues

### "WebSocket connection failed"

- Check server is running on port 8080
- Check no firewall blocking localhost
- Try explicit URL: `?mode=multiplayer&server=ws://127.0.0.1:8080`

### "Other players not visible"

- Check both clients show "connected" state
- Check server logs show both clients connected
- Verify `getRemoteEntities()` returns entities

### "Character rubber-banding"

- Expected with high latency/packet loss
- Check `[Prediction] Large error` logs
- May indicate client-server physics mismatch

### "High pending input count"

- Indicates server not acknowledging inputs fast enough
- Check server tick rate (should be 20/sec)
- Check for server-side errors

## URL Parameters

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `mode` | `standalone`, `multiplayer` | `standalone` | Game mode |
| `server` | WebSocket URL | `ws://localhost:8080` | Server URL |

Examples:
```
http://localhost:5173                           # Standalone (default)
http://localhost:5173?mode=multiplayer          # Local server
http://localhost:5173?mode=multiplayer&server=ws://192.168.1.100:8080  # Remote server
```

## Performance Profiling

### Client Frame Budget

Target: 60 FPS (16.67ms per frame)

Network update costs:
- Input capture: ~0.1ms
- Interpolation: ~0.5ms per entity
- Prediction: ~0.2ms

### Server Tick Budget

Target: 20 ticks/sec (50ms per tick)

Per-tick costs:
- Input processing: ~0.1ms per input
- Physics step: ~0.5ms per entity
- Snapshot creation: ~0.2ms
- Broadcast: ~0.1ms per client

## Next Steps

After verifying basic functionality:

1. **Phase 4.12**: Handle game events (damage, abilities) from server
2. **Phase 4.14**: Integration tests with mock WebSocket
3. **Phase 4.15**: Polish and error handling
