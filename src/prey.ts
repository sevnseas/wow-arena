/**
 * Shared prey contract for animal modules that can be hunted by predators
 * (wolves). Each huntable animal mutates its own internal state on
 * damage()/scare() and exposes its current position + alive flag through
 * the lightweight PreyRef wrapper.
 */

import * as THREE from 'three';
import type { EntityRefLike, EntityTeam } from './game-entity';

export interface PreyRef extends EntityRefLike {
  id: string;
  name: string;
  team: EntityTeam;
  mesh: THREE.Object3D;
  /** Live world position (updated each frame by the owner). */
  readonly pos: THREE.Vector3;
  readonly alive: boolean;
  readonly hp: number;
  readonly maxHp: number;
  readonly radius: number;
  /** Returns true if this hit killed the prey. */
  damage(amount: number, attacker?: EntityRefLike): boolean;
  /** Returns the actual amount restored. */
  heal(amount: number): number;
  /** Mark prey as panicked away from a threat for `durationMs`. */
  scare(fromX: number, fromZ: number, durationMs: number): void;
}

export type CombatTargetRef = EntityRefLike & {
  scare?: (fromX: number, fromZ: number, durationMs: number) => void;
};

export interface PreyProvider {
  findNearestPrey(pos: THREE.Vector3, maxDist: number): PreyRef | null;
  forEachPrey(fn: (ref: PreyRef) => void): void;
}

/** State pack reused by each animal — keeps the per-module diff small. */
export interface PreyState {
  hp: number;
  maxHp: number;
  dead: boolean;
  deadTimer: number;
  fleeUntil: number;
  fleeFromX: number;
  fleeFromZ: number;
  /** Last time HP changed — drives the HP bar fade. */
  lastHitAt: number;
  combatTarget: CombatTargetRef | null;
  attackTimer: number;
  /**
   * Most recent entity that damaged us — exposed to the policy adapter so the
   * brain's Flee intent runs away from the *actual attacker*, not just the
   * highest-priority focus (which might be some unrelated low-HP enemy).
   */
  lastAttackerId: string | null;
  /**
   * When ≥ performance.now(), this entity is grazing (or hidden, for
   * predators) and should slowly regen. Set by the policy adapter when the
   * brain picks Intent.Heal; cleared on damage or when the intent changes.
   */
  grazingUntil: number;
}

export function makePreyState(maxHp: number): PreyState {
  return {
    hp: maxHp,
    maxHp,
    dead: false,
    deadTimer: 0,
    fleeUntil: 0,
    fleeFromX: 0,
    fleeFromZ: 0,
    lastHitAt: 0,
    combatTarget: null,
    attackTimer: 0,
    lastAttackerId: null,
    grazingUntil: 0,
  };
}

/**
 * Tick HP regeneration when the entity is grazing/hidden AND has not been
 * damaged recently. Called from each animal's update loop with the current
 * dt. Returns the actual amount healed (for UI splats if desired).
 */
export function tickGrazeHeal(state: PreyState, dt: number, healPerSec = 4): number {
  const now = performance.now();
  if (state.dead) return 0;
  if (state.grazingUntil < now) return 0;
  if (now - state.lastHitAt < 1500) return 0; // out-of-combat for ≥1.5s
  if (state.hp >= state.maxHp) return 0;
  const before = state.hp;
  state.hp = Math.min(state.maxHp, state.hp + healPerSec * dt);
  return state.hp - before;
}

export function clampToBounds(pos: THREE.Vector3, bounds: number): boolean {
  const x = pos.x;
  const z = pos.z;
  pos.x = Math.max(-bounds, Math.min(bounds, pos.x));
  pos.z = Math.max(-bounds, Math.min(bounds, pos.z));
  return pos.x !== x || pos.z !== z;
}

export function emitDamageSplat(mesh: THREE.Object3D, amount: number): void {
  mesh.userData.damageSplats?.spawnDamage?.(mesh, amount);
}

export function emitHealSplat(mesh: THREE.Object3D, amount: number): void {
  mesh.userData.damageSplats?.spawnHeal?.(mesh, amount);
}

/** Record an attacker on a PreyState. Centralised so every pack tracks it. */
export function notePreyAttacker(state: PreyState, attacker?: EntityRefLike | { id?: string }): void {
  if (!attacker) return;
  const id = (attacker as { id?: string }).id;
  if (id) state.lastAttackerId = id;
}

export function healPreyState(state: PreyState, amount: number): number {
  if (state.dead || state.hp >= state.maxHp) return 0;
  const before = state.hp;
  state.hp = Math.min(state.maxHp, state.hp + amount);
  state.lastHitAt = performance.now();
  return state.hp - before;
}

/**
 * Translate a brain Intent onto a PreyState-style entity:
 *   • Attack → latch combat target
 *   • Flee   → run from the most recent attacker (preferred) or the focus
 *   • Heal   → drop combat, start grazing window (tickGrazeHeal regens)
 *   • Idle   → drop combat target, let the default state machine resume
 *
 * `resolveAttacker` looks up the live ref for the entity that last damaged
 * us, so flee direction = away from the actual threat, not whatever happens
 * to be in focus this tick.
 */
export function applyIntentToPreyState(
  state: PreyState,
  intent: 0 | 1 | 2 | 3 | 4,
  focus: { id: string; pos: { x: number; z: number }; team?: string; alive?: boolean } | null,
  resolveFocus: (id: string, x: number, z: number) => CombatTargetRef | null,
  resolveAttacker?: (id: string) => { pos: { x: number; z: number } } | null,
): void {
  if (state.dead) return;
  // Heal/Flee/Idle all imply "stop fighting" — if we don't clear here the
  // entity will keep chasing whoever last hit it and the visible behavior
  // contradicts the brain's stated intent.
  if (intent !== 1 /* not Attack */) state.combatTarget = null;
  // Grazing only lives while the intent says so.
  if (intent !== 3 /* not Heal */) state.grazingUntil = 0;

  switch (intent) {
    case 1: { // Attack
      if (focus && focus.alive !== false) {
        const ref = resolveFocus(focus.id, focus.pos.x, focus.pos.z);
        if (ref) state.combatTarget = ref;
      }
      break;
    }
    case 4: { // Flee — prefer the live attacker over the focus pick.
      let fromX = focus?.pos.x ?? 0;
      let fromZ = focus?.pos.z ?? 0;
      if (state.lastAttackerId && resolveAttacker) {
        const att = resolveAttacker(state.lastAttackerId);
        if (att) { fromX = att.pos.x; fromZ = att.pos.z; }
      }
      if (focus || state.lastAttackerId) {
        state.fleeUntil = performance.now() + 1200;
        state.fleeFromX = fromX;
        state.fleeFromZ = fromZ;
      }
      break;
    }
    case 3: { // Heal — graze window (extends each decision while held).
      state.grazingUntil = performance.now() + 1500;
      state.fleeUntil = 0;
      break;
    }
    case 0: // Idle — defaults already cleared above.
    case 2: // CC — no-op for non-magic animals.
    default: break;
  }
}

export function combatContactRange(attackerRadius: number, target: CombatTargetRef, buffer = 0.15): number {
  return attackerRadius + (target.radius ?? 0.6) + buffer;
}

export function maintainCombatSpacing(pos: THREE.Vector3, target: CombatTargetRef, range: number): void {
  const dx = pos.x - target.pos.x;
  const dz = pos.z - target.pos.z;
  const dist = Math.hypot(dx, dz);
  const minDist = range * 0.9;
  if (dist <= 0.001 || dist >= minDist) return;
  const push = minDist - dist;
  pos.x += (dx / dist) * push;
  pos.z += (dz / dist) * push;
}
