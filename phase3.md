# Phase 3 — Class Select + Action Bar + Cooldowns/Debuffs + 3 Core Abilities per Class

## Goal
Add the first layer of “arena game loop” without full combat depth: the player can **pick a class** (Tab), sees a **3×3 action bar** with keybinds, and can use **3 abilities** per class (attack / movement / CC). This phase also introduces the foundational systems we’ll reuse forever: **cooldowns, debuffs, cast bars, and simple projectiles**.

---

## A. Class Selection (Tab)

### Tasks
- Press `Tab` toggles a class picker overlay: **Rogue / Mage / Priest**
- Selecting a class:
  - swaps the player’s `AbilityLoadout`
  - swaps player visuals (procedural rig or GLB later)
  - updates action bar icons/labels (placeholder is fine)

### Completion Criteria
- Tab reliably opens/closes picker
- Selecting a class immediately changes action bar + enabled abilities
- No reload required; state transitions are clean (no stuck cooldowns/casts)

---

## B. Action Bar UI (3×3 Grid) + Keybind Reflection

### Direction
UI should reflect input *and* ability state (cooldown, cast, debuff target).

### Tasks
- Render a fixed 3×3 grid (bottom center or bottom left)
- Slots show:
  - keybind label (e.g. `1`, `2`, `3`, `Q`, `E`, `R`, `F`, `G`)  
  - ability name (small text, optional)
  - cooldown overlay (dark radial or simple dim + timer text)
- Input handling:
  - pressing the bound key triggers the ability
  - slot flashes/press animation when key is pressed
  - if ability is unavailable (cooldown / no target / out of range), slot flashes “error” state

**Keybind map**
- Row 1: `1 2 3`
- Row 2: `Q E R`
- Row 3: `F G` (+ one empty slot is fine)

### Completion Criteria
- Action bar renders with correct keybinds for current class
- Pressing a key visually “presses” the slot
- Cooldown clearly shows remaining time and blocks re-use

---

## C. Core Systems: Cooldowns, Debuffs, Casting, Projectiles

### C1) Cooldown System

#### Tasks
- Add `CooldownManager` (per player)
  - `startCooldown(abilityId, seconds)`
  - `getRemaining(abilityId)`
  - `isReady(abilityId)`
- Action bar pulls from cooldown manager

#### Completion Criteria
- Cooldowns persist correctly across frames
- You cannot trigger an ability while on cooldown
- UI countdown matches the actual internal timer

---

### C2) Debuff System (Duration + Tags)

#### Tasks
- Add `DebuffManager` (per entity)
  - store: `{ id, name, duration, expiresAt, tags }`
  - `applyDebuff(entityId, debuff)`
  - `hasDebuff(entityId, id)`
  - `update(now)` removes expired
- Render a minimal debuff strip on target frame (top-left near target pane)
- For now debuffs can be “logical only” (no stat changes), but must track duration

#### Completion Criteria
- Applying “Blind/Poly/Fear” creates a debuff entry with correct duration
- Debuff expires automatically
- UI shows remaining time (rough seconds is fine)

---

### C3) Casting + Cast Bar (Global Requirement)

#### Tasks
- Add `CastSystem` (per caster)
  - states: `idle | casting`
  - `beginCast({ abilityId, castTimeSec, targetId, onComplete })`
  - interrupt rules (Phase 3 simplest):
    - movement cancels cast OR allow slow movement but keep it simple (pick one)
- Add cast bar UI (center-bottom or under action bar)
  - shows spell name + progress over time
- Abilities marked as casted:
  - Priest Heal: 2.0s
  - Priest Smite: 1.5s
  - (Optional) Mage Frostbolt: you can make it instant OR 1.5s; if you want consistency, make it 1.5s too.

#### Completion Criteria
- Cast bar appears for casted spells and completes at correct time
- Ability effect only occurs on cast completion
- If cast is canceled (by movement or re-cast), effect does not occur and UI resets

---

### C4) Projectile System (for Frostbolt / Smite visuals)

#### Tasks
- Add `ProjectileSystem`
  - spawn sphere with velocity toward target snapshot (or homing, but snapshot is simpler)
  - on collision (distance threshold) apply effect/damage event
- Minimal hit feedback:
  - flash target outline or spawn a short-lived particle puff

#### Completion Criteria
- Frostbolt sphere travels visibly and “hits” target reliably
- Projectile lifetime is bounded (no infinite spheres)
- Hit triggers effect hook (even if damage is placeholder)

---

## D. Class Ability Specs (Phase 3 MVP)

### Rogue (Target-required unless noted)
1. **Teleport Behind Target** — Key `1`, CD **15s**
   - Requirements: must have target, within max range (pick e.g. 15m)
   - Effect: instantly move rogue to a position behind target (use target facing yaw if available; otherwise behind relative to target→rogue vector)
2. **Hemorrhage** — Key `2`, CD optional (0–3s), instant
   - Effect: play a melee “lunge/jump” animation, register a hit event on target
3. **Blind** — Key `3`, duration **9s**, CD (pick e.g. 90s later; for now 20–30s is fine)
   - Effect: apply `BLIND` debuff to target (logical only)

**Completion Criteria**
- Rogue can teleport behind a target reliably (no clipping into pillars; resolve by nudging outward if blocked)
- Hemo triggers a clear animation cue and a hit event
- Blind applies a 9s debuff shown in UI and prevents reapplication while active (optional, but recommended)

---

### Mage
1. **Blink Forward** — Key `1`, CD (pick e.g. 15s)
   - Effect: move mage forward along facing direction by fixed distance (e.g. 8m), clamp if blocked
2. **Frostbolt** — Key `2`, projectile (cast time optional; choose instant first)
   - Effect: spawn a projectile sphere toward target; on hit, apply a slow debuff (optional) or just hit feedback
3. **Polymorph** — Key `3`, duration **9s**, cast optional (2.0s later)
   - Effect: apply `POLYMORPH` debuff; swap target visual to “sheep placeholder” (even just scaling + white color works)

**Completion Criteria**
- Blink moves forward consistently relative to facing
- Frostbolt projectile visibly travels and hits
- Polymorph applies 9s debuff and changes target appearance while active

---

### Priest
1. **Heal Target** — Key `1`, **2.0s cast**, target-required
   - Effect: on complete, spawn a heal VFX cue and increment a placeholder health value
2. **Smite** — Key `2`, **1.5s cast**, projectile to target
   - Effect: projectile hit triggers damage event (placeholder)
3. **Fear** — Key `3`, AoE around caster, duration **9s**
   - Effect: apply `FEAR` debuff to nearby enemies within radius (e.g. 8m); for now “fear” can just show debuff + optional wander jitter later

**Completion Criteria**
- Heal shows cast bar for 2s and only applies on completion
- Smite shows cast bar for 1.5s and launches projectile
- Fear applies debuff to multiple nearby targets correctly and expires

---

## E. Phase 3 Exit Condition
Phase 3 is done when:
- Tab-based class selection works cleanly
- 3×3 action bar reflects input + cooldowns
- Cooldown + debuff + cast systems exist and are used by real abilities
- Each class has:
  - 1 movement ability
  - 1 attack ability
  - 1 CC ability
…with visible feedback and consistent state handling.
