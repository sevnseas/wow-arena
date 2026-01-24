# Phase 2 — Visual Fidelity + Character Animation Framework

## Goal
Upgrade the sandbox from debug visuals to *readable, shippable-looking* graphics without locking ourselves into assets too early. This phase adds a **procedural texture mini-tool** (no AI, pure code) and a **character animation framework** that works today with primitives and swaps cleanly to GLB + animations later.

---

## A. Procedural Texture Mini-Tool (Ground + Pillars)

### Direction
Each texture lives in **one JS file** that:
- procedurally generates a tileable texture via Canvas (noise + strokes)
- renders a **live preview** in the browser
- exports a helper to create a Three.js `CanvasTexture`

No engine coupling, no AI, no shader rabbit hole.

### Tasks
- Create `tools/textures/_runner.html` + `_runner.js`
  - Loads a texture module via `?tex=grass`
  - Shows 1× preview and 2×2 tiling preview
- Implement `grass.js`
  - Green base with value noise variation
  - Simple blade strokes + dirt specks
  - Expose parameters (scale, density, seed) at top of file
- Implement `ceramic_gray.js`
  - Neutral gray base
  - Subtle speckle + faint crack/vein lines
  - Slight edge darkening for depth
- Integrate textures into arena scene
  - Ground uses grass texture, repeated
  - Pillars use ceramic texture, vertical repeat

### Completion Criteria
- Editing `grass.js` or `ceramic_gray.js` immediately changes preview
- Textures tile without obvious seams
- Arena no longer looks “flat debug,” but still lightweight
- Texture code is importable with **zero** arena-specific logic

---

## B. Character View + Animation Framework

### Direction
Gameplay never talks to meshes or animations directly.
It talks to a **CharacterView interface** that can be backed by:
- a procedural placeholder rig (now)
- a GLB + AnimationMixer implementation (later)

This avoids refactors when real assets arrive.

### Tasks
- Define `CharacterView` interface
  - `setFacingYaw(yaw)`
  - `setLocomotion(state, speed01)`
  - `triggerOneShot(name)`
  - `update(dt)`
- Implement `ProceduralCharacterView`
  - Build hierarchy: root → hips → torso → head / arms / legs
  - Animate via joint rotations:
    - idle = breathing
    - walk/run = arm/leg swing driven by phase
    - jump = legs tuck, arms out
- Create locomotion state mapping
  - idle / walk / run / jump / fall
  - Driven purely by movement system outputs
- Stub `GltfCharacterView`
  - Load GLB
  - Setup `AnimationMixer`
  - Map clip names → actions
  - Same public interface as procedural version

### Completion Criteria
- Movement works identically with procedural or GLB-backed characters
- Character faces movement direction cleanly
- Walk/run/jump states are visually distinct
- Replacing procedural view with GLB requires **no gameplay changes**

---

## C. Integration Check

### Tasks
- Attach CharacterView root to existing player entity
- Drive animation state from Phase 1 movement logic
- Verify camera + targeting still behave correctly

### Completion Criteria
- Player moves, jumps, turns, animates coherently
- Visuals improve without breaking controls or targeting
- Codebase clearly separates:
  - gameplay
  - visuals
  - tooling

---

## Exit Condition (Phase 2 Done)
We can:
- iterate textures visually in isolation
- drop in a real GLB character and animations
- continue toward abilities (stealth, blink, poly) without visual rewrites
