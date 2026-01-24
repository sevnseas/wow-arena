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

## Architecture

```
src/
├── main.ts        # Game loop, state, entity creation
├── abilities.ts   # Class ability definitions
├── systems.ts     # Cooldowns, Debuffs, Casting, Projectiles
├── player.ts      # Movement, collision detection
├── camera.ts      # Third-person orbit camera
├── targeting.ts   # Click-to-target raycasting
├── character.ts   # Procedural character mesh + animation
├── arena.ts       # Arena geometry, colliders
├── entities.ts    # NPC spawn definitions
└── coords.ts      # Coordinate helpers (+Y up, -Z forward)
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
