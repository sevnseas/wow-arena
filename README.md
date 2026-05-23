# WoW Arena Sandbox

Three.js arena combat prototype aimed at a stylized, low-poly MMORPG look: readable silhouettes, hand-painted surfaces, fast tab-target controls, billboard spell effects, and server-ready combat logic.

The current `feature/animals` branch adds ambient animal life on top of the existing arena, Mixamo character path, low-poly terrain, collision, sky, abilities, and multiplayer scaffolding.

## Run

```bash
npm install
npm run dev
```

Useful URLs:

```text
http://localhost:5173/?mode=standalone
http://localhost:5173/?mode=standalone&mixamo=1
http://localhost:5173/?mode=standalone&mixamo=1&char=mutant
http://localhost:5173/?mode=multiplayer&server=ws://localhost:8080
```

Server:

```bash
cd server
npm install
npm test
npm run dev
```

## RL training (predator / prey policies)

Two generations of policies live in this repo. They share the same headless
environment in `src/rl/` (pure tick time, no Three.js / wall clock).

### RL3 — intention policy (legacy)

5-action high-level brain (`Idle / Attack / CC / Heal / Flee`) trained per
archetype; an algorithmic engine in `src/rl/engine.ts` executes the chosen
intention. Documented in [`entity-policies.md`](./entity-policies.md).

```bash
npm run train                       # 300 eps, writes public/policies/*.json
```

### RL4 — direct-control policy (current)

11-action policy (`MoveForward / MoveBack / StrafeLeft / StrafeRight` + 4
diagonals + 3 ability slots) that drives entities directly — same action
space the player uses for animal classes. Observation is a 20-slot ×
7-feature "minimap" (relative position, velocity, HP, archetype, team)
totaling 140 dims. Network: 140 → 64 hidden → 11 logits, REINFORCE with Adam.

Curriculum (mixed-pen sampling, each stage widens the range of pen sizes):

| stage | bounds range | episodes (default) |
|---|---|---|
| tight | [1.5, 1.5] m | 600 |
| mix3 | [1.5, 3] m | 600 |
| mix6 | [1.5, 6] m | 800 |
| mix12 | [1.5, 12] m | 1000 |
| open | [1.5, 25] m | 1500 |

The best snapshot is taken only during the final stage (so a pen1.5 overfit
can't be chosen). Per-archetype kill-rate after ~800 eps/stage:

| archetype | tight | mix3 | mix6 | mix12 | open |
|---|---|---|---|---|---|
| wolf | 100% | 100% | 100% | 82% | 65% |
| werewolf | 100% | 100% | 100% | 93% | 63% |
| cat | 100% | 98% | 62% | 12% | 7% (small contact window — needs more) |

```bash
npm run train:rl4 wolf 1500         # 1500 eps per stage = 7500 total, writes
                                    #   public/policies-rl4/wolf.json
                                    #   public/policies-rl4/wolf.meta.json
                                    #   public/policies-rl4/wolf.history.csv
npm run train:rl4 all 1500          # train wolf, cat, werewolf
npm run scenario wolf-vs-rabbit-pen 20   # headless verification, prints per-second
                                          # state + final action histogram + kill summary
```

### Game integration

Loaded automatically in the live game when `public/policies-rl4/*.json`
exist. `PolicyDriver4` builds the minimap observation from live game
entities and calls back into per-archetype adapters
(`getPolicy4Agents()` on `WolfPack` / `CatColony` / `MutantPredator`).
A `brainSteer` flag on each entity suppresses the auto-prey-acquisition
state machine so the policy's chosen direction actually wins, and
turn rate is boosted 3× under brain control so the wolf can commit to a
direction within one 0.4s decision interval. `?policy=rl3` forces the
legacy Intent-based driver instead.

## Scenarios (RL4 verification)

Isolated test arenas at `scenarios.html` show the trained policy steering
one entity inside a visible pen matched to a curriculum stage.

```
http://localhost:3000/threejs-arena/scenarios.html?s=wolf-vs-rabbit
http://localhost:3000/threejs-arena/scenarios.html?s=wolf-vs-rabbit-mid    # 6m pen
http://localhost:3000/threejs-arena/scenarios.html?s=wolf-vs-rabbit-open   # 12m pen
http://localhost:3000/threejs-arena/scenarios.html?s=cat-vs-rabbit
http://localhost:3000/threejs-arena/scenarios.html?s=pack-vs-cow
```

Each page shows:
- **Policy provenance HUD** — training date, episodes, hidden-layer size,
  best episode MA50, per-stage kill-rate bar chart with the current pen
  highlighted (so you know what % chance the kill is *expected* to have).
- **Pen** — wireframe orange walls + 1m grid + corner posts, sized to the
  training stage; no cave / boulders / decoration.
- **Action arrow** — cyan arrow above the agent showing the world-space
  direction the policy just chose; length and color scale with confidence.
  Ability actions pulse an orange ring instead.
- **Minimap canvas** (bottom-right) — paints the literal 140-dim observation
  the network sees: each visible entity as a colored dot at its normalized
  rel-pos, sized by HP, with a velocity tail. The chosen-action overlay
  matches input ↔ output in one frame.

## Tick-speed in-browser trainer

```
http://localhost:3000/threejs-arena/train.html?a=wolf
http://localhost:3000/threejs-arena/train.html?a=cat
http://localhost:3000/threejs-arena/train.html?a=werewolf
```

The same REINFORCE curriculum used by `npm run train:rl4`, rendered live:

- Left pane — 2D top-down `env4` sim: pen, agent, prey, chosen-action arrow.
- Right pane — return MA chart updates per batch; curriculum-stage progress
  bars; kill-rate per completed stage; eps/sec counter; pause / 1× / 5× / 20×
  speed; **"export policy"** button downloads the trained JSON.
- Same `train-tick.ts` code as the headless script so what you see in the
  browser converges to the same policy.

You can watch the loss MA flatten in each stage, then drop and recover as
the curriculum widens the pen.

```bash
npm test src/__tests__/rl4-live-control.test.ts   # verifies brainSteer
                                                   # actually translates wolves
npm test src/__tests__/rl.test.ts                  # legacy RL3 tests
```

Design docs: [`rl4.md`](./rl4.md), [`RL4-IMPLEMENTATION.md`](./RL4-IMPLEMENTATION.md), [`entity-policies.md`](./entity-policies.md).

## Controls

- `WASD` moves relative to character facing.
- `Space` jumps.
- `Tab` opens class selection.
- `1-3`, `Q`, `E`, `R`, `F`, `G` cast abilities.
- `C` picks up or drops nearby animals.
- Left click targets.
- Right mouse drag rotates the character.
- Both mouse buttons held walks forward.
- Scroll zooms the camera.

## Vision

The visual target is "Wrath-era arena, but sharper": low-poly geometry, chunky silhouettes, textured stone, readable class VFX, and strong lighting changes without drifting into high-fidelity realism.

Core rules:

- Treat Mixamo as a finished external character source. Do not decompile, decompose, or rebuild those assets unless there is a clear loading bug.
- Preserve the retro look with low polygon counts and crisp texture sampling.
- Use normal or bump detail to imply chiseled stone, bevels, cracks, and terrain cuts instead of adding geometry.
- Prefer Three.js-native procedural assets, hand-painted atlases, vertex colors, hard silhouettes, and billboard VFX over dense meshes.
- Keep combat input latency low: movement, cast starts, stops, and melee swings should read almost immediately.
- Keep gameplay systems deterministic enough that the client can move toward server-authoritative multiplayer.

Texture rule for painted assets:

```ts
texture.minFilter = THREE.NearestFilter;
texture.magFilter = THREE.NearestFilter;
texture.generateMipmaps = false;
```

Use this selectively. UI/combat text can stay linear-filtered when readability needs it, but world albedo/atlas textures should be point-filtered by default.

## Current Audit

### Mixamo Animation

Current implementation:

- `src/mixamo-character.ts` loads a character FBX plus essential animation FBXs in parallel.
- Optional large clips such as spell casts load in the background.
- Root XZ motion is stripped from hip tracks so game physics owns world movement.
- Directional walk/run variants support forward, backpedal, and strafing.
- Jump animation is scrubbed by vertical physics while airborne, then plays landing tail.
- Upper-body swipe action strips lower-body tracks so auto-attacks can layer over locomotion.
- Current crossfade is `0.2s`, which is readable but slightly soft for tab-target combat.

Gaps:

- Mixamo should be treated as stable source material; the roadmap should focus on integration, not repacking or rebuilding the assets.
- Transition timing is not centrally tuned per state. Some states should be near-instant (`0.05s` to `0.1s`), while others can keep polish fades.
- Multiplayer path infers facing from velocity in places instead of carrying authoritative facing through the protocol.

### Terrain

Current implementation:

- `src/terrain.ts` generates a low-poly heightfield from layered simplex noise.
- Geometry is converted to non-indexed, vertex colored by elevation, and flat-shaded.
- Player and animals query height data for ground placement.

Gaps:

- The terrain is continuous noise, not angular Voronoi cells.
- Height lookup is nearest-grid based and not shared with server physics.
- Terrain material has vertex colors only; no atlas, stylized normal map, or baked ambient-occlusion pass.

### Arena Geometry And Collisions

Current implementation:

- `src/arena.ts` builds four cylindrical pillars, two rotated box ramps, boundary wall boxes, water, terrain, and forest.
- Pillars use a procedural diffuse canvas texture plus a procedural bump map.
- `src/player.ts` resolves cylinders in the XZ plane and rotated boxes by local-space overlap.
- Collision resolution includes wall sliding.

Gaps:

- All static colliders are checked every frame; there is no grid or quadtree broadphase.
- Client and server collision definitions diverge. Server physics has shared/static arena pieces, but client terrain and branch-only visuals are not unified.
- Pillars use `bumpMap`, not a real tangent-space normal map. That is acceptable as a prototype, but normal maps will scale better for chiseled stylized lighting.

### Trees

Current implementation:

- `src/trees.ts` loads `tree.glb` and `foliage_alpha3.png`.
- Foliage uses a shader hook for leaf inflation and wind sway.
- Trees are placed around the arena perimeter and follow terrain height.

Gaps:

- Tree count is low and every tree is an object clone, not an instanced forest layer.
- Trunk material is currently black/basic, useful for silhouette but not a finished bark pass.
- Foliage texture filtering is not forced to pixel-art sampling.

### Animals

Current implementation on `feature/animals`:

- `src/dogs.ts`, `src/rabbits.ts`, `src/cats.ts`, and `src/cows.ts` create procedural low-poly animals.
- Animals wander with simple state machines and terrain following.
- All animal types implement the `Holdable` contract in `src/holdable.ts`.
- Cows use canvas hide textures, periodic "Moo" billboard sprites, and low-poly horns/udder/tail details.

Gaps:

- Animals do not avoid pillars, ramps, or walls.
- Materials are per-animal/per-part rather than atlas-driven.
- Canvas-generated cow hides and moo sprites are not pooled or globally disposed as a complete system.
- Animals are visual ambience only; they are not represented in server state.

### Native Asset Bank

Current implementation:

- Procedural animals already prove the pattern: Three.js primitives, simple materials, object-local pivots, and code-driven animation.
- Arena pieces, projectiles, splats, trees, terrain, and animals are spread across feature modules.
- There is no central catalog for what exists, what states each asset supports, or what is missing.

Gaps:

- No asset registry exists for native assets.
- No viewer/editor exists to browse assets, inspect animations, compare variants, or mark quality status.
- No shared animation vocabulary exists for procedural assets.
- Combat, harvesting, and resource-being-gathered states are not represented as first-class asset requirements.

### Lighting And Atmosphere

Current implementation:

- `src/sky.ts` owns the dynamic sky, fog color, ambient light, hemisphere light, and sun/moon directional light.
- Time of day cycles from sunrise through night.
- Shadows are enabled with PCF soft shadows and a 2048 sun shadow map.
- Clouds and stars use additive shaders.

Gaps:

- Lighting is dynamic but not yet art-directed around arena readability.
- No color-grading/LUT or stylized ramping pass exists.
- Shadow settings are global and not tuned per asset category.
- Materials do not yet share a consistent roughness/normal/vertex-color policy.

### VFX

Current implementation:

- Projectiles are simple `MeshBasicMaterial` spheres created per cast.
- Damage and heal splats are sprites generated from canvas textures.
- Cow speech bubbles are sprites.
- Sky uses additive blending for stars/clouds.

Gaps:

- Spell VFX are not yet billboard-first, atlas-backed, additive sprites.
- Runtime allocations happen on each projectile, splat, and moo spawn.
- No object pool exists for particles or combat text.

### Netcode Readiness

Current implementation:

- Server code exists with WebSocket snapshots, events, input sequencing, server tick loop, server-side abilities, debuffs, cooldowns, and movement validation.
- Client has input capture, prediction, interpolation, clock sync, and reconciliation.
- Server tick is fixed, but standalone client simulation is still render-delta driven.

Gaps:

- Standalone/client visual logic is coupled to `requestAnimationFrame` delta.
- Terrain height, richer collider data, and facing yaw need to be shared consistently between client and server.
- VFX/animation triggers from server events are still incomplete.

## Architecture Map

```text
src/
  main.ts              Game bootstrap, scene state, loop, ability input, animals
  arena.ts             Arena mesh construction, pillar/ramp/wall colliders
  terrain.ts           Low-poly terrain height data and terrain mesh
  trees.ts             GLB tree loading, foliage shader wind/billboarding
  sky.ts               Dynamic sky, fog, ambient/hemi/sun lighting
  player.ts            Local movement, terrain grounding, cylinder/box collision
  character.ts         Procedural fallback character view
  mixamo-character.ts  Mixamo FBX CharacterView implementation
  systems.ts           Cooldowns, debuffs, casting, projectiles
  damage-splat.ts      Floating combat text sprites
  dogs.ts              Procedural wandering dogs
  rabbits.ts           Procedural hopping rabbits
  cats.ts              Procedural wandering cats
  cows.ts              Procedural cows, hide texture, moo sprites
  holdable.ts          Shared pickup/drop contract for animals
  net/                 Client networking, prediction, interpolation
  shared/              Shared protocol, ability, and physics types

server/src/
  index.ts             WebSocket server and fixed tick loop
  input.ts             Input validation and movement processing
  physics.ts           Server movement/collision helpers
  abilities.ts         Server-side combat execution
  state.ts             Authoritative entity state
  snapshot.ts          Snapshot and event messages
```

## Production Path

### 1. Native Asset Bank And Editor

Goal: a predictable bank of Three.js-native assets that can be inspected, improved, and reused without touching Mixamo source assets.

- Keep Mixamo as the high-quality humanoid character path and improve only its runtime integration.
- Create `src/assets/registry.ts` that describes every native asset: id, category, builder, variants, animation states, materials, collider, tags, and quality status.
- Move procedural builders toward reusable asset modules instead of one-off scene systems.
- Build an in-app asset viewer/editor route or page, for example `?tool=asset-bank`, that can spawn every registered asset in isolation.
- Let the editor preview states such as `idle`, `walk`, `run`, `attack`, `cast`, `hit`, `death`, `gather`, `being_gathered`, `depleted`, `pickup`, and `carried`.
- Track missing assets and missing states directly in the registry rather than in ad-hoc notes.
- Build one native-material/texture library for stone, grass, dirt, foliage, animal markings, resources, tools, and VFX masks.
- Add a texture helper that applies nearest filtering to hand-painted world textures.
- Generate or bake stylized normal maps for native arena pieces such as pillars, ramps, tree bark, terrain cliffs, ore nodes, trees, crates, and interactables.

Example registry shape:

```ts
export interface NativeAssetDefinition {
  id: string;
  category: 'animal' | 'resource' | 'prop' | 'arena' | 'vfx' | 'combat';
  build: () => THREE.Object3D;
  states: Partial<Record<AssetState, AssetStateDefinition>>;
  variants?: string[];
  tags?: string[];
  status: 'prototype' | 'usable' | 'polish' | 'final';
  missing?: string[];
}
```

### 2. Stylized Arena Pass

Goal: make the current blockout visually competitive before expanding gameplay.

- Replace simplex terrain with angular Voronoi terrain cells or quantized height regions.
- Preserve low-poly geometry, but add stronger color regions for grass, dirt, and stone.
- Upgrade pillar material from bump-only to diffuse + normal + optional vertex AO.
- Give ramps and walls the same rock material language as pillars.
- Add hand-painted decals: cracks, moss edges, worn combat paths, and pillar bases.
- Tune fog/sky/sun around combat readability first, scenic atmosphere second.

Acceptance criteria:

- Pillars read as chiseled stone from gameplay camera distance.
- The arena floor has distinct tactical zones without becoming noisy.
- Character silhouettes remain readable at sunrise, midday, sunset, and night.

### 3. Animation Responsiveness

Goal: inputs should feel immediate for both authored Mixamo animation and native procedural animation.

- Reduce default locomotion/cast transition fade from `0.2s` toward `0.08s`.
- Make transition duration state-specific: instant for cast start/stop and melee, softer for idle turns.
- Keep layered upper-body attacks and extend the same pattern to cast gestures.
- Add native procedural animation definitions for combat, work, gather, being gathered, damaged, depleted, pickup, and carried states.
- Preview all native animation states in the asset-bank editor before wiring them into gameplay.
- Carry facing yaw through multiplayer snapshots instead of inferring from velocity.
- Add an animation debug acceptance page for "state swap under 100ms".

Acceptance criteria:

- Run -> cast start visually changes in under `0.1s`.
- Moving while casting interrupts both cast state and cast pose immediately.
- Melee can fire while moving without lower-body foot sliding.

### 4. Collision And Spatial Partitioning

Goal: keep collision simple but scalable.

- Build a static XZ broadphase grid for pillars, ramps, walls, pets, totems, and animals.
- Query only nearby colliders for player and NPC movement.
- Share arena collider definitions between `src/shared`, client, and server.
- Add animal obstacle avoidance using the same broadphase, at least for pillars/walls.
- Keep cylinders for pillars and boxes for ramps/walls; avoid mesh collision.

Acceptance criteria:

- Adding 100 simple pets/totems does not change collision complexity linearly per actor.
- Client and server agree on pillar, wall, ramp, arena bound, and terrain grounding rules.

### 5. Billboard VFX And Pooling

Goal: make spell visuals cheap, readable, and Warcraft-like.

- Replace raw projectile spheres with camera-facing sprite quads.
- Use additive blending for frostbolts, heals, impact flashes, and aura rings.
- Pre-allocate a particle/sprite pool at startup.
- Reuse combat text and speech bubble sprites instead of creating textures/materials per spawn.
- Add VFX atlas UV rects so every effect can share one or two textures.

Acceptance criteria:

- A burst of 100 spell impacts produces no visible garbage-collection hitch.
- Frostbolt and heal effects are readable from the gameplay camera without mesh detail.

### 6. Animals As Ambient Worldbuilding

Goal: keep the animal branch charm, but make it production-safe.

- Register dogs, rabbits, cats, and cows in the native asset bank with their supported states and missing states.
- Move animal palettes and markings into the shared atlas.
- Add obstacle-aware wandering and soft avoidance around the combat center.
- Consider instancing for non-held animals if counts increase.
- Keep pickup/drop local in standalone; only network it if animals become gameplay-relevant.
- Pool moo/combat text sprites through the same VFX pool.

Acceptance criteria:

- Animals never walk through pillars or walls.
- Picking up/dropping animals does not break terrain placement or object ownership.
- Animal rendering cost remains bounded as counts increase.

### 7. Resource And Interaction Assets

Goal: make gathering and interactable world objects part of the same visual pipeline as animals and combat props.

- Add native assets for trees, herb nodes, ore nodes, crates, banners, camp props, totems, traps, summoned objects, and depleted resource remains.
- Give resource assets paired states: idle resource, being gathered, successful gather burst, depleted, and respawn.
- Give tool/character-side procedural states where needed: chop, mine, harvest, channel, kneel, loot, and carry.
- Keep these as Three.js-native meshes and billboard effects unless a specific asset needs authored external art.
- Expose every state in the asset-bank editor so missing gathering/combat/resource feedback is visible.

Acceptance criteria:

- Every resource node has an idle, being gathered, depleted, and respawn-ready visual.
- Every interactable states its collider, interaction radius, and supported animation/VFX hooks.
- Missing visual states are visible in the editor inventory.

### 8. Deterministic Game Loop

Goal: prepare for server-authoritative arena play.

- Run gameplay simulation on a fixed timestep on the client, matching server tick semantics where possible.
- Keep rendering interpolation separate from gameplay simulation.
- Move shared movement, terrain height, collider query, and ability timing to `src/shared`.
- Drive local prediction from fixed inputs, not arbitrary render `delta`.
- Emit server combat events that trigger client animation and VFX consistently.

Acceptance criteria:

- Standalone and multiplayer use the same movement math for player collision.
- Replaying the same input sequence produces the same authoritative position.
- Ability casts, interrupts, projectile impacts, and CC visuals can be event-driven.

## Near-Term Task List

1. Add `src/textures/applyPixelTexture.ts` and apply it to pillar diffuse/bump, cow hides, foliage alpha, terrain/atlas textures, and future VFX atlas where appropriate.
2. Replace `FADE = 0.2` in `MixamoCharacterView` with state-specific fades and tune cast/melee transitions below `0.1s`.
3. Create `src/assets/registry.ts` and register dogs, rabbits, cats, cows, pillars, ramps, walls, trees, projectiles, splats, and basic resource-node placeholders.
4. Build an asset-bank viewer/editor page that lists registered assets, renders each variant, previews states, and shows missing states.
5. Define the native asset state vocabulary: `idle`, `walk`, `run`, `attack`, `cast`, `hit`, `death`, `gather`, `being_gathered`, `depleted`, `pickup`, and `carried`.
6. Create `src/shared/colliders.ts` as the single source for pillars, ramps, walls, and arena bounds.
7. Add a static broadphase grid around the existing collider list before increasing entity counts.
8. Prototype Voronoi terrain height generation behind a URL flag, keeping current simplex terrain as fallback.
9. Convert projectile spheres into pooled additive sprites.
10. Move damage splats and cow moo sprites onto a pooled text/sprite system.
11. Build one first-pass native texture/material library and update pillar/ramp/wall/tree/animal/resource materials to consume it.
12. Tune `SkyEnvironment` intensities and fog for four locked presets: sunrise, midday, sunset, night.

## Existing Docs

- `MIXAMO_SETUP.md` covers Mixamo setup details.
- `foliage.md` and `stylized-trees.md` cover tree references and shader notes.
- `phase1.md`, `phase2.md`, `phase3.md`, and `phase4-multiplayer.md` document earlier roadmap stages.
- `TESTING.md` documents test expectations.
