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
- [ ] Create `src/shared/` directory structure
- [ ] Extract `EntityDef`, `ClassName`, `Team` types to `src/shared/types.ts`
- [ ] Extract ability metadata to `src/shared/abilities.ts` (id, name, cooldown, range, castTime - no Three.js)
- [ ] Extract physics constants to `src/shared/physics.ts` (gravity, speed, arena bounds, pillar positions)
- [ ] Define protocol types in `src/shared/protocol.ts` (ClientMessage, ServerMessage unions)
- [ ] Add vitest, write serialization round-trip tests for protocol types

## Phase 4.2: Server Skeleton
- [ ] Create `server/` with `package.json` (ws, typescript, vitest)
- [ ] `server/tsconfig.json` targeting Node, importing from `../src/shared`
- [ ] `server/src/index.ts` - WebSocket server on configurable port
- [ ] Connection tracking: assign playerId on connect, remove on disconnect
- [ ] Fixed tick loop (20Hz) with `setInterval`
- [ ] Unit tests: server starts, accepts connection, tracks clients

## Phase 4.3: Server Game State
- [ ] `server/src/state.ts` - `ServerGameState` class
- [ ] `EntityState`: id, class, team, pos, vel, yaw, hp, maxHp, alive, respawnAt
- [ ] `entities: Map<string, EntityState>`
- [ ] Cooldowns: `Map<string, Map<abilityId, readyAt>>`
- [ ] Debuffs: `Map<string, Debuff[]>`
- [ ] Active casts: `Map<string, ActiveCast | null>`
- [ ] Methods: `spawnEntity`, `removeEntity`, `getEntity`, `setPosition`, `applyDamage`, `kill`, `respawn`
- [ ] Unit tests: spawn entity, damage reduces HP, kill sets alive=false

## Phase 4.4: Server Physics
- [ ] `server/src/physics.ts` - Vec3 as `{x,y,z}` plain objects
- [ ] `applyMovement(entity, input, dt)` - velocity from input, apply gravity
- [ ] `resolveCollisions(entity)` - pillar cylinders, arena bounds, ramp box
- [ ] Port collision math from `player.ts` without Three.js vectors
- [ ] Unit tests: entity stops at wall, slides along pillar, stays in bounds

## Phase 4.5: Server Input Processing
- [ ] `server/src/input.ts` - `InputQueue` per player
- [ ] `processMoveInput(playerId, msg)` - validate, apply physics, store seq for ack
- [ ] `processAbilityInput(playerId, msg)` - validate cooldown, range, target; queue cast or execute instant
- [ ] Input rate limiting (max 60 inputs/sec per player)
- [ ] Unit tests: valid input updates position, invalid input rejected, rate limit enforced

## Phase 4.6: Server Abilities
- [ ] `server/src/abilities.ts` - `executeAbility(state, casterId, abilityId, targetId)`
- [ ] Instant abilities: teleport (shadowstep, blink), melee hit, debuff apply (blind)
- [ ] Cast abilities: track in `activeCasts`, complete after duration, call effect
- [ ] Cast interruption: movement cancels, stun cancels
- [ ] Projectile spawn: add to `state.projectiles`, track position each tick
- [ ] Projectile hit: check distance to target, apply effect, remove projectile
- [ ] Debuff lifecycle: apply with duration, remove when expired, emit events
- [ ] Damage/heal: modify HP, check death condition
- [ ] Unit tests: shadowstep moves entity behind target, frostbolt spawns projectile, polymorph applies CC

## Phase 4.7: Server Snapshots & Events
- [ ] `server/src/snapshot.ts` - `buildSnapshot(state): Snapshot`
- [ ] Snapshot includes: tick, all entity states, all active projectiles
- [ ] Event queue: accumulate events during tick, flush with snapshot
- [ ] Broadcast: send snapshot + events to all clients each tick
- [ ] Late join: send full state snapshot on connect
- [ ] Unit tests: snapshot contains expected entity data, events queue and flush correctly

## Phase 4.8: Client Network Layer
- [ ] `src/net/socket.ts` - WebSocket wrapper with connect/disconnect/reconnect
- [ ] `src/net/protocol.ts` - encode/decode ClientMessage and ServerMessage
- [ ] Connection state: disconnected → connecting → connected → disconnected
- [ ] Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- [ ] `src/net/clock.ts` - ping/pong for RTT measurement, server time offset

## Phase 4.9: Client Input Sending
- [ ] Capture WASD/space state, build `MoveInput` with sequence number
- [ ] Send MoveInput at 60Hz (or throttle to 20Hz matching server tick)
- [ ] On ability key: send `AbilityInput` with slot and current targetId
- [ ] Input buffer: store sent inputs with seq for reconciliation

## Phase 4.10: Client Prediction & Reconciliation
- [ ] Local player: apply input immediately (predict position)
- [ ] Store predicted state with seq number
- [ ] On snapshot: find matching seq, compare server pos to predicted
- [ ] If delta > threshold: snap or blend to server position
- [ ] Replay unacked inputs from buffer after correction
- [ ] Tuning: snap threshold, blend speed

## Phase 4.11: Client Remote Entity Interpolation
- [ ] Snapshot buffer: store last N snapshots (e.g., 5)
- [ ] Render remote entities at interpolated position (render time = server time - 100ms)
- [ ] Interpolate pos, yaw between two snapshots
- [ ] Handle missing entity: fade out or hide
- [ ] Handle new entity: fade in at position

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
- [ ] `src/mode.ts` - `GameMode = 'standalone' | 'multiplayer'`
- [ ] URL param `?mode=standalone` or `?mode=multiplayer` (default standalone)
- [ ] Standalone: existing local-only logic, no network
- [ ] Multiplayer: connect to server, use network state
- [ ] Verify current demo works unchanged in standalone mode

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
