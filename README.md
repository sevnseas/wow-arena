# WoW Arena Sandbox

Three.js arena combat prototype with class abilities, targeting, and projectiles.

## Run

```bash
npm install
npm run dev
```

## Controls

- `WASD` - Move
- `Space` - Jump
- `Tab` - Class selector
- `1-3` - Abilities
- `Left/Right click` - Target / Orbit camera
- `Scroll` - Zoom

## Mixamo Characters

Real animated characters from [Mixamo](https://www.mixamo.com) can be loaded in place of the procedural placeholder.

### Setup

1. Download a character pack from Mixamo as **FBX** files
2. Place files in `public/models/`:
   - `character.fbx` — mesh (e.g. Maria)
   - `mutant.fbx` — alternate mesh
   - `idle.fbx`, `walk.fbx`, `run.fbx`, `run_stop.fbx`, `turn_left.fbx`, `turn_right.fbx`
3. Enable with URL param: `?mixamo=1` (add `&char=mutant` for alternate)

### How it works (`src/mixamo-character.ts`)

- **FBXLoader** loads character mesh + each animation clip in parallel
- Mixamo FBX is in **cm** → scaled `0.01` to metres
- Separate-file animation tracks carry an `ArmatureName|` prefix that doesn't match the character skeleton — stripped on load via `track.name.replace(/^[^|]+\|/, '')`
- **Coordinate fix**: Mixamo characters face **+Z** at rest; game forward is **-Z**. `setFacingYaw` applies `targetYaw = -yaw + π` so facing is correct without touching `main.ts`
- **AnimationMixer** crossfades between clips (`FADE = 0.2s`). State machine handles: idle → walk → run, run → run_stop → idle, idle + fast yaw → turn_left / turn_right

### Animation debug page

`public/anim-debug.html` — standalone Three.js page (CDN, no build step) that shows all animation clips playing simultaneously on clones of the same character.

- Uses **`SkeletonUtils.clone()`** (not `.clone(true)`) so bone bindings survive the copy and `AnimationMixer` can drive them
- Labels are scene-level `Object3D` anchors that `lookAt(camera)` each frame, placed in world units after scale
- Orbit controls for pan/zoom; buttons focus camera on each clip
- Switch between Maria / Mutant via buttons top-right

## Architecture

```
src/
├── main.ts              # Game loop, state, entity creation
├── abilities.ts         # Class ability definitions
├── systems.ts           # Cooldowns, Debuffs, Casting, Projectiles
├── player.ts            # Movement, collision detection
├── camera.ts            # Third-person orbit camera
├── targeting.ts         # Click-to-target raycasting
├── character.ts         # Procedural character mesh + animation (CharacterView interface)
├── mixamo-character.ts  # Mixamo FBX loader implementing CharacterView
├── arena.ts             # Arena geometry, colliders
├── entities.ts          # NPC spawn definitions
└── coords.ts            # Coordinate helpers (+Y up, -Z forward)
```

## Entity Hierarchy

### Classes
- `Rogue` - Shadowstep (teleport), Hemorrhage (melee), Blind (CC)
- `Mage` - Blink (dash), Frostbolt (1.5s cast), Polymorph (1.5s cast CC)
- `Priest` - Heal (2s cast), Smite (1.5s cast), Psychic Scream (AoE)

### Ability Flow
```
KeyPress → tryUseAbility() → check cooldown/range/target
  → instant: execute immediately, triggerOneShot()
  → cast: beginCast() → castbar UI → onComplete callback
```

### Projectiles
```
spawn(start, target, speed, color, onHit)
  → MeshBasicMaterial sphere
  → update() moves by velocity * dt
  → hit when dist < 0.5 → onHit() → dispose
```

### Collision
- Cylinder colliders for pillars
- Rotated box colliders for ramps
- Wall sliding on contact
- Grounded check for jump

### Camera
- Spherical orbit around player pivot
- Yaw/pitch from mouse drag
- Distance from scroll wheel
- Smooth interpolation

### Debuff Visuals
- CC debuffs (blind, polymorph) replace entity mesh with rotating cube
- Original mesh hidden, restored on expiry
