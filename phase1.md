# Phase 1 — WoW Arena Spatial Sandbox (MVP)

## 1-Paragraph PRD
Build a minimal, iteration-friendly **WoW Arena sandbox** (starting with **Rogue / Mage / Priest**) in **Three.js** to prototype positioning, camera feel, and targeting UX quickly. This is **not** a combat simulator; it is a **spatial toybox** with a strict coordinate system, a recognizable arena blockout (Nagrand-ish), a third-person camera that feels controllable, and a basic “who is my target” UI. Success means you can drop 3–6 units into the arena, move and jump one player, orbit the camera without losing orientation, click units to target them, and *always* understand what direction is what via in-world debug gizmos.

---

## Phase 1 Technical Plan (Opinionated, Iterative)

### 0) Coordinate System + Debug Direction Helpers (**Do First**)

#### Direction
Lock the mental model early. If XYZ is ambiguous, *everything* later becomes pain.

**Canonical Convention**
- `+Y` = up  
- `+X` = right  
- `-Z` = forward  

This matches common Three.js camera assumptions and must never change.

#### Tasks
- Create `coords.ts` (or `coords.js`) as a single source of truth
  - Export constants: `WORLD_UP`, `WORLD_RIGHT`, `WORLD_FWD`
  - Export helpers:
    - `worldForward()`
    - `worldRight()`
    - `yawToDir(yaw)`
    - `dirToYaw(vec)`
    - `flattenXZ(vec)`
    - `snapToGround(pos)`
    - `assertFiniteVec3(vec)`
    - `prettyVec(vec)`
- Implement RGB axis gizmo
  - X = red, Y = green, Z = blue
  - Use arrow geometry (cylinder + cone), readable from any angle
- Implement `debugPick()` mode
  - Clicking an axis arrow logs:
    - vector value
    - symbolic name (e.g. `WORLD_FWD`)
    - yaw equivalent (if applicable)

#### Completion Criteria
- You can point at any axis in the scene and know exactly what it means in code
- All movement, camera, and targeting math imports from `coords.ts`
- No raw `(0, 0, -1)` literals outside the coordinate module

---

### 1) Arena Blockout (Nagrand-ish)

#### Direction
Block out *recognizable gameplay space*, not visual fidelity.

#### Tasks
- Represent players as cylinder/capsule colliders
  - Canonical dimensions (e.g. radius `0.35`, height `1.8`)
  - Visual mesh derived from collider size
- Build arena primitives
  - Flat ground plane
  - 4 pillar-like columns
  - Simple ramps / boxes approximating Nagrand LOS features
- Make entity creation data-driven
  - `entities.json` or TS array:
    ```ts
    {
      id,
      name,
      team,
      position,
      collider,
      color
    }
    ```

#### Completion Criteria
- Arena is immediately readable as “an arena”
- Pillars clearly block line of sight
- Player units feel correctly scaled relative to terrain
- Swapping a cylinder for a character mesh would not affect gameplay code

---

### 2) Camera + Player Movement + Jumping

#### Direction
Camera control and orientation clarity matter more than physics realism.

#### Tasks
- Implement `PlayerRoot`
  - Owns world position and velocity
  - Constrained to ground plane
- Implement `CameraRig`
  - Pivot at player position
  - Boom arm with adjustable distance
  - Camera always looks at a point slightly above player center
- Camera controls
  - Left-click drag = orbit (yaw + pitch)
  - Clamp pitch (e.g. `-20° → 70°`)
  - Smooth movement with lerp
  - Optional “recenter behind player” key
- Player movement
  - WASD movement in **player-local XZ**
  - Directions derived from camera yaw only
  - Simple gravity + jump impulse
  - Ground detection via raycast (or flat-ground shortcut initially)

#### Completion Criteria
- You can orbit the camera without losing spatial orientation
- Forward movement always matches camera facing
- Jumping feels responsive and predictable
- Camera never flips, jitters, or drifts off target

---

### 3) Targeting + Target Pane UI

#### Direction
Targeting is both gameplay UX *and* a debugging tool.

#### Tasks
- Implement click-to-target
  - Raycast against entity meshes or colliders
  - On hit: set `gameState.targetId`
  - On empty click: clear target
- Render target pane (HTML overlay, top-left)
  - Default: “No Target”
  - On target:
    - Name
    - Optional team color
- Visual feedback in scene
  - Highlight targeted entity (outline, emissive pulse, or ground ring)
- Debug output on target
  - Distance to target
  - Relative direction in XYZ convention

#### Completion Criteria
- Clicking any unit reliably sets and clears target
- Target pane always reflects current state
- You can visually and numerically verify ranges and angles
- Targeting code is UI-agnostic and reusable for abilities later

---

## Phase 1 Exit Condition

Phase 1 is complete when:
- Spatial orientation is never ambiguous
- Camera + movement feel solid and predictable
- Arena layout supports LOS reasoning
- Targeting works and doubles as a debugging aid

Only after this do we move to **Phase 2: visual fidelity + character animation**, because combat logic is useless without spatial confidence.
