# Multiplayer Brainstorm — Server-Authoritative Arena

## North Star
- **Server is source of truth** for: positions, facing, casts, cooldowns, debuffs, health, respawns, projectiles, CC outcomes.
- **Client is a renderer + input device** with prediction for responsiveness.
- Same codepaths should support:
  - 1v1 local (server embedded)
  - 3v3 online
  - NPCs (server-driven AI issuing the same “inputs”/commands)

---

## 1) What must be synchronized (authoritative state)

### Entity state (players + NPCs)
- `entityId`, `type` (player/npc), `class`, `team`
- `pos (x,y,z)`, `vel (x,y,z)` (optional), `facingYaw`
- `animState` (idle/walk/run/jump/cast/etc) *or* derive anim from movement + actions
- `hp`, `maxHp`, `alive`, `respawnAt`

**Completion criterion for design:** every visible thing can be derived from a small, explicit server state vector + event stream.

### Combat/ability state
- `cooldowns[abilityId] -> readyAt`
- `activeCast` (spellId, startTime, endTime, targetId/targetPos, interruptible)
- `debuffs[]` (id, stacks?, startTime, endTime, sourceId, tags)
- `projectiles[]` (id, sourceId, spellId, startPos, startTime, velocity OR targetId, ttl)

---

## 2) Two viable networking models (pick one early)

### Model A — Lockstep commands + server sim + snapshots (recommended)
**Client sends:** input commands (move vector, yaw, ability press) with timestamps/sequence.  
**Server simulates:** fixed tick (e.g. 30/60Hz).  
**Server broadcasts:** periodic snapshots + events.

Why it’s good:
- deterministic-ish gameplay logic
- easiest to add NPCs (NPCs just inject commands)
- client prediction is straightforward

### Model B — Pure event-driven (server emits “start cast”, “spawn projectile”)
Works, but you’ll still need periodic snapshots to correct drift. Otherwise physics/proj divergence happens.

**Recommendation:** Model A (commands + snapshots) with an event channel for one-shots.

---

## 3) Client-side prediction vs reconciliation (multiple perspectives)

### Perspective: “I care about responsiveness”
- Predict **your own movement** immediately on input.
- Predict **cast start UI** immediately (cast bar), but server can cancel/correct.
- For most spells:
  - show “pending” feedback instantly
  - confirm effect when server event arrives

### Perspective: “I care about correctness / anti-cheat”
- Server validates all movement (speed, blink distance, teleport behind target legality).
- Server decides hit results, CC application, debuff durations, damage/heals.
- Client never decides “I hit you” — it only renders what server says.

### Perspective: “I care about simplicity”
- Predict only local movement + camera.
- Everything else (projectiles, debuffs) is server-only.
- Accept slightly higher latency feel at first; add prediction later.

**Opinionated call:** Predict local movement + cast bar start. Don’t predict CC outcomes or damage.

---

## 4) How to sync movement + facing (the non-negotiables)

### Server tick & snapshot
- Tick: 30Hz is fine for prototype; 60Hz later.
- Snapshot: 10–20Hz (bandwidth-friendly), plus immediate events for casts/projectiles.

Snapshot contains:
- For each entity: `pos`, `vel?`, `yaw`, `hp`, `alive`, `activeCast?`

Client render loop:
- Interpolate remote entities between snapshots (buffer 100ms)
- Reconcile local player:
  - keep input history
  - when server state arrives, rewind to server pos and reapply unacked inputs

**Completion criterion:** remote players look smooth; local player snaps are rare and tiny.

---

## 5) Spells, projectiles, debuffs: what’s a “state” vs “event”

### Events (one-shot)
- `CastStarted(casterId, spellId, start, end, target)`
- `CastInterrupted(casterId, reason)`
- `ProjectileSpawned(projId, spellId, startPos, vel/target, startTime)`
- `ProjectileHit(projId, targetId, hitTime)`
- `DebuffApplied(targetId, debuffId, start, end, sourceId)`
- `DebuffRemoved(targetId, debuffId)`
- `Damage(sourceId, targetId, amount, time)`
- `Heal(sourceId, targetId, amount, time)`
- `Respawn(entityId, pos, time)`

### State (continuous)
- cooldown timers
- active debuffs list (can be derived from events but include in snapshots for late join / recovery)
- HP (must be in snapshots)

**Opinionated call:** Use events for “what happened,” snapshots for “what is true now.”

---

## 6) Animations: synchronize intent, not bones

You don’t sync skeleton transforms. You sync **high-level animation state**:
- locomotion derived from velocity (client-side)
- action tags from events:
  - `playOneShot: teleport`, `meleeSwing`, `castLoop`, `hitReact`, `death`

If the server says “TeleportBehind happened at t=123.4”:
- client warps entity (or blends quickly)
- triggers teleport one-shot animation
- optionally spawns a small VFX

**Completion criterion:** different clients see the *same sequence of actions* even if frames differ.

---

## 7) Respawning + game loop state

Server owns:
- death condition (hp <= 0)
- respawn timer
- spawn location
- reset debuffs/casts/projectiles affecting the dead entity

Client renders:
- death animation + gray-out
- respawn countdown
- respawn event => reappear

**Completion criterion:** no “ghost debuffs,” no client-only resurrects, no desync.

---

## 8) NPCs later: easiest if they speak “commands”

NPC design principle:
- NPC AI runs on server and emits the same command types as humans:
  - move intent
  - ability press
  - target selection changes

This keeps combat logic unified and avoids special cases.

**Completion criterion:** adding NPCs does not require new networking primitives.

---

## 9) Minimal protocol sketch (what to actually implement first)

### Client → Server (commands)
- `InputTick(seq, dt, moveX, moveZ, yaw, jumpPressed)`
- `AbilityPressed(seq, abilitySlot, targetId?)`
- `SelectTarget(seq, targetId | null)`
- `SelectClass(seq, classId)` (phase 3+)

### Server → Client
- `Snapshot(serverTick, entities[])` at 10–20Hz
- `Events([…])` ASAP (can be batched per tick)

**Completion criterion:** you can run two clients and watch:
- movement smooth
- blink/teleport consistent
- casts + debuffs consistent
- projectiles consistent
- hp bars consistent

---

## 10) The hard parts (call them out now)

- **Teleport behind target**: server must resolve a safe landing point (avoid pillars). Client shouldn’t guess.
- **Projectiles**: either fully server-simulated or “spawn w/ known velocity and deterministic flight.” For prototype, server-sim is simplest.
- **Latency and feel**: without prediction, melee/teleport will feel laggy. Start with local movement prediction and fast event delivery.
- **Replays/debug**: log commands + snapshots for deterministic repro. This becomes your “arena debugger.”

---

## Proposed Phase 4 (Multiplayer MVP) Exit Condition
- Two clients connect to one server.
- Both see the same arena + entities.
- Moving/jumping looks smooth for both perspectives.
- Casting + debuffs + cooldowns are consistent.
- Projectiles hit reliably and only when server says so.
- Death + respawn works without desync.

---

# Implementation Tasks

## Phase 4.1: Shared Foundation
- [x] Create `src/shared/` directory structure
- [x] Extract `EntityDef`, `ClassName`, `Team` types to `src/shared/types.ts`
- [x] Extract ability metadata to `src/shared/abilities.ts` (id, name, cooldown, range, castTime - no Three.js)
- [x] Extract physics constants to `src/shared/physics.ts` (gravity, speed, arena bounds, pillar positions)
- [x] Define protocol types in `src/shared/protocol.ts` (ClientMessage, ServerMessage unions)
- [x] Add vitest, write serialization round-trip tests for protocol types (55 tests passing)

## Phase 4.2: Server Skeleton
- [x] Create `server/` with `package.json` (ws, typescript, vitest)
- [x] `server/tsconfig.json` targeting Node, importing from `../src/shared`
- [x] `server/src/index.ts` - WebSocket server on configurable port
- [x] Connection tracking: assign playerId on connect, remove on disconnect
- [x] Fixed tick loop (20Hz) with `setInterval`
- [x] Unit tests: server starts, accepts connection, tracks clients (12 tests)

## Phase 4.3: Server Game State
- [x] `server/src/state.ts` - `ServerGameState` class
- [x] `EntityState`: id, class, team, pos, vel, yaw, hp, maxHp, alive, respawnAt
- [x] `entities: Map<string, EntityState>`
- [x] Cooldowns: `Map<string, Map<abilityId, readyAt>>`
- [x] Debuffs: `Map<string, Debuff[]>`
- [x] Active casts: `Map<string, ActiveCast | null>`
- [x] Methods: `spawnEntity`, `removeEntity`, `getEntity`, `setPosition`, `applyDamage`, `kill`, `respawn`
- [x] Unit tests: spawn entity, damage reduces HP, kill sets alive=false (56 tests)

## Phase 4.4: Server Physics
- [x] `server/src/physics.ts` - Vec3 as `{x,y,z}` plain objects
- [x] `applyMovement(entity, input, dt)` - velocity from input, apply gravity
- [x] `resolveCollisions(entity)` - pillar cylinders, arena bounds, ramp box
- [x] Port collision math from `player.ts` without Three.js vectors
- [x] Unit tests: entity stops at wall, slides along pillar, stays in bounds (35 tests)

## Phase 4.5: Server Input Processing
- [x] `server/src/input.ts` - `InputProcessor` class with per-player state
- [x] `processMoveInput(playerId, msg)` - validate, apply physics, store seq for ack
- [x] `processAbilityInput(playerId, msg)` - validate cooldown, range, target; queue cast or execute instant
- [x] Input rate limiting (max 3 inputs per tick per player)
- [x] Unit tests: valid input updates position, invalid input rejected, rate limit enforced (25 tests)

## Phase 4.6: Server Abilities
- [x] `server/src/abilities.ts` - `executeAbility(state, casterId, abilityId, targetId)`
- [x] Instant abilities: teleport (shadowstep, blink), melee hit, debuff apply (blind)
- [x] Cast abilities: track in `activeCasts`, complete after duration, call effect
- [x] Cast interruption: movement cancels (in input.ts), stun cancels
- [x] Projectile spawn: add to `state.projectiles`, track position each tick
- [x] Projectile hit: check distance to target, apply effect, remove projectile
- [x] Debuff lifecycle: apply with duration, remove when expired, emit events
- [x] Damage/heal: modify HP, check death condition
- [x] Unit tests: shadowstep moves entity behind target, frostbolt spawns projectile, polymorph applies CC (30 tests)

## Phase 4.7: Server Snapshots & Events
- [x] `server/src/snapshot.ts` - `buildSnapshot(state): Snapshot`
- [x] Snapshot includes: tick, all entity states, all active projectiles
- [x] Event queue: accumulate events during tick, flush with snapshot
- [x] Broadcast: send snapshot + events to all clients each tick
- [x] Late join: send full state snapshot on connect
- [x] Unit tests: snapshot contains expected entity data, events queue and flush correctly (14 tests)
- [x] Integrated full tick loop in server: abilities, projectiles, debuffs, respawns, broadcast

## Phase 4.8: Client Network Layer
- [x] `src/net/socket.ts` - WebSocket wrapper with connect/disconnect/reconnect
- [x] Connection state: disconnected → connecting → connected → disconnected
- [x] Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- [x] `src/net/clock.ts` - ping/pong for RTT measurement, server time offset
- [x] `src/net/input.ts` - InputManager with sequence numbers for reconciliation
- [x] `src/net/state.ts` - NetworkState with snapshot buffering and interpolation

## Phase 4.9: Client Input Sending
- [x] Capture WASD/space state, build `MoveInput` with sequence number
- [x] Send MoveInput at 20Hz (matching server tick rate)
- [x] On ability key: send `AbilityInput` with slot and current targetId
- [x] Input buffer: store sent inputs with seq for reconciliation
- [x] `src/net/capture.ts` - InputCapture class for keyboard handling

## Phase 4.10: Client Prediction & Reconciliation
- [x] Local player: apply input immediately (predict position)
- [x] Store predicted state with seq number
- [x] On snapshot: find matching seq, compare server pos to predicted
- [x] If delta > threshold: snap or blend to server position
- [x] Replay unacked inputs from buffer after correction
- [x] Tuning: snap threshold, blend speed
- [x] `src/net/prediction.ts` - ClientPrediction class with error smoothing

## Phase 4.11: Client Remote Entity Interpolation
- [x] Snapshot buffer: store last N snapshots (e.g., 30)
- [x] Render remote entities at interpolated position (render time = server time - 100ms)
- [x] Interpolate pos, yaw between two snapshots
- [x] Handle missing entity: use last known position
- [x] Handle new entity: snap to position
- [x] Already implemented in `src/net/state.ts` NetworkState class

## Phase 4.12: Client Event Handling
- [ ] `CastStarted`: show cast bar, start casting animation
- [ ] `CastCompleted`: hide cast bar, trigger one-shot animation
- [ ] `CastInterrupted`: hide cast bar, optionally show interrupt feedback
- [ ] `ProjectileSpawned`: create projectile mesh, add to scene
- [ ] `ProjectileHit`: remove projectile, flash hit on target
- [ ] `DebuffApplied`: add to debuff list, show CC cube if applicable
- [ ] `DebuffRemoved`: remove from list, hide CC cube
- [ ] `Damage`: update HP bar, flash hit
- [ ] `Death`: hide entity or show death state
- [ ] `Respawn`: show entity at new position

## Phase 4.13: Standalone Mode
- [x] `src/mode.ts` - `GameMode = 'standalone' | 'multiplayer'`
- [x] URL param `?mode=standalone` or `?mode=multiplayer` (default standalone)
- [x] Standalone: existing local-only logic, no network (default)
- [x] Multiplayer: connect to server, use network state
- [x] `src/net/game.ts` - NetworkGame class for multiplayer orchestration

## Phase 4.14: Integration Tests
- [ ] Test harness: spawn server, connect N clients programmatically
- [ ] Test: single client connects, receives Welcome, sees self in snapshot
- [ ] Test: two clients connect, each sees other's movement
- [ ] Test: client A casts, client B sees cast bar and projectile
- [ ] Test: projectile hits, both clients see damage event
- [ ] Test: target dies, respawns after delay
- [ ] Test: client disconnects, other client sees entity removed
- [ ] Test: client reconnects, receives current state

## Phase 4.15: Polish
- [ ] Handle server shutdown gracefully on client
- [ ] Rate limiting with informative rejection
- [ ] Basic speed hack detection (distance/time validation)
- [ ] Range validation on abilities
- [ ] Cooldown enforcement (ignore client cooldown claims)
- [ ] Update README with multiplayer setup instructions

---

# Progress Log

**2025-01-25**
- Created branch `phase4-multiplayer`
- Analyzed existing codebase architecture
- Documented implementation tasks
- **Phase 4.1 complete**: Shared foundation
  - `src/shared/types.ts` - Vec3, Team, ClassName, EntityDef, Collider, Debuff, EntitySnapshot, ProjectileSnapshot
  - `src/shared/abilities.ts` - AbilityMeta, CLASS_ABILITIES, getAbilityById, getAbilityByKey
  - `src/shared/physics.ts` - movement constants, arena layout, buildColliders(), spawn positions, tick rate
  - `src/shared/protocol.ts` - ClientMessage, ServerMessage unions, encode/decode helpers
  - `src/shared/index.ts` - barrel export
  - Added vitest, 55 tests passing
- **Phase 4.2 complete**: Server skeleton
  - `server/package.json` - ws, tsx, typescript, vitest dependencies
  - `server/tsconfig.json` - Node ESM config with path alias to shared
  - `server/src/index.ts` - ArenaServer class with WebSocket, tick loop, connection tracking
  - Ping/pong for latency measurement
  - 12 server tests passing (67 total)
- **Phase 4.3 complete**: Server game state
  - `server/src/state.ts` - ServerGameState class with full entity/combat management
  - Entity lifecycle: spawn, remove, position/velocity, yaw
  - Health: damage, heal, kill, respawn with timer
  - Cooldowns: tick-based tracking per entity per ability
  - Debuffs: apply, remove, expiry, tag checks
  - Active casts: start, interrupt, completion detection
  - Projectiles: spawn, remove, velocity calculation
  - Snapshots: entity and projectile snapshots for network sync
  - 56 state tests passing (123 total)
- **Phase 4.4 complete**: Server physics
  - `server/src/physics.ts` - pure TypeScript physics without Three.js
  - Vec3 helper functions (add, sub, scale, normalize, distance)
  - Movement: yawToForward, applyMovement with input transformation
  - Collision: cylinder (pillars), box (ramps), arena bounds
  - Projectiles: position update, hit detection
  - Abilities: getPositionBehindTarget, getBlinkDestination, findValidPositionNear
  - 35 physics tests passing (158 total)
- **Phase 4.5 complete**: Server input processing
  - `server/src/input.ts` - InputProcessor with per-player physics state
  - MoveInput: validation, physics application, CC check, cast interruption
  - AbilityInput: cooldown, range, target validation
  - Rate limiting (max 3 inputs per tick)
  - Sequence number tracking for client reconciliation
  - 25 input tests passing (183 total)
- **Phase 4.6 complete**: Server abilities
  - `server/src/abilities.ts` - ability execution and tick updates
  - Instant: Shadowstep, Hemorrhage, Blind, Blink, Psychic Scream
  - Cast: Frostbolt, Polymorph, Heal, Smite
  - Projectiles: spawn, update, hit detection, damage
  - Debuffs: apply, expire, remove
  - Death/respawn integration
  - 30 ability tests passing (213 total)
- **Phase 4.7 complete**: Server snapshots & events + full integration
  - `server/src/snapshot.ts` - buildSnapshot, event queue
  - Full server tick loop: process abilities, casts, projectiles, debuffs, respawns
  - Entity spawn/remove events on connect/disconnect
  - Broadcast snapshots to all clients each tick
  - Send initial snapshot on connect for late join
  - 14 snapshot tests passing (227 total)
- **Phase 4.8 complete**: Client network layer
  - `src/net/socket.ts` - GameSocket with WebSocket management, auto-reconnect
  - `src/net/clock.ts` - NetworkClock for RTT measurement and server time sync
  - `src/net/input.ts` - InputManager with sequence numbers, pending input buffer
  - `src/net/state.ts` - NetworkState with snapshot buffering, entity interpolation
  - `src/net/index.ts` - barrel export
  - 29 client network tests passing (256 total)
- **Phase 4.9 complete**: Client input sending
  - `src/net/capture.ts` - InputCapture with keyboard event handling
  - Rate-limited sending at 20Hz to match server tick
  - Ability input sending
  - 16 InputCapture tests passing (272 total)
- **Phase 4.10 complete**: Client prediction & reconciliation
  - `src/net/prediction.ts` - ClientPrediction class
  - Local movement prediction with physics
  - Server reconciliation with unacked input replay
  - Error smoothing with configurable thresholds
  - 18 prediction tests passing (290 total)
- **Phase 4.11 complete**: Client remote entity interpolation
  - Already implemented in NetworkState class
  - Snapshot buffering with configurable size
  - Position and yaw interpolation between snapshots
  - Handles new/missing entities gracefully
- **Phase 4.13 complete**: Standalone mode support
  - `src/mode.ts` - Game mode detection from URL params
  - `src/net/game.ts` - NetworkGame orchestrator class
  - Supports ?mode=standalone (default) and ?mode=multiplayer
  - Custom server URL via ?server= param
- **Integration complete**: Client network with main.ts
  - Integrated NetworkGame with main.ts for multiplayer mode
  - Separate animate loops for standalone vs multiplayer
  - Dynamic remote entity mesh creation from network state
  - Strategic debug logging in network modules
  - `TESTING.md` - Local testing guide with commands

---

# Files to Create

```
src/
  shared/
    types.ts        # EntityDef, ClassName, Team, etc.
    abilities.ts    # Ability metadata (no Three.js)
    physics.ts      # Constants: gravity, speeds, bounds
    protocol.ts     # ClientMessage, ServerMessage types
  net/
    socket.ts       # WebSocket connection manager
    protocol.ts     # Encode/decode helpers
    clock.ts        # RTT and time sync
  mode.ts           # Standalone vs multiplayer switch

server/
  package.json
  tsconfig.json
  src/
    index.ts        # Entry, WebSocket setup
    state.ts        # ServerGameState
    physics.ts      # Movement and collision
    input.ts        # Input processing
    abilities.ts    # Ability execution
    snapshot.ts     # Snapshot building and broadcast
  test/
    state.test.ts
    physics.test.ts
    input.test.ts
    abilities.test.ts
```

---

# Architecture Notes

## What stays client-only
- CameraRig (orbit camera)
- Three.js scene/renderer
- UI (action bar, cast bar, target frame, debuff display)
- ProceduralCharacterView (animations)
- Local targeting raycaster (click to select)

## What moves to server
- Authoritative positions and velocities
- Ability validation and execution
- Cooldown tracking and enforcement
- Debuff lifecycle
- Projectile simulation
- HP, damage calculation, death, respawn

## What becomes shared
- Type definitions (EntityDef, ClassName, etc.)
- Ability metadata (id, name, cooldown, range, castTime)
- Physics constants (gravity, move speed, arena dimensions)
- Protocol message types
