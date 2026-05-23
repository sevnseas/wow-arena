/**
 * Tier 2 — the algorithmic engine. Given an entity's held Intent + focused
 * target, it produces velocity, runs attack timing, and resolves collisions.
 *
 * The brain (Tier 1) never sees walls, raycasts or pathfinding state. Here
 * we steer directly toward/away from the focus (no obstacles yet — the
 * structure leaves room for A* / NavMesh substitution without changing the
 * brain interface).
 */

import { type RLEnv } from './env';
import { type Entity, Intent, isGrazer, isPredator } from './types';

const ATTACK_REACH_MULT = 1.0;
const FLEE_TURN_LERP = 0.35;

function clampBounds(e: Entity, bounds: number): void {
  if (e.x < -bounds) e.x = -bounds;
  if (e.x > bounds) e.x = bounds;
  if (e.z < -bounds) e.z = -bounds;
  if (e.z > bounds) e.z = bounds;
}

function steerToward(e: Entity, tx: number, tz: number, speed: number, dt: number): void {
  const dx = tx - e.x;
  const dz = tz - e.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return;
  const sx = (dx / d) * speed;
  const sz = (dz / d) * speed;
  e.vx = e.vx * (1 - FLEE_TURN_LERP) + sx * FLEE_TURN_LERP;
  e.vz = e.vz * (1 - FLEE_TURN_LERP) + sz * FLEE_TURN_LERP;
  e.x += e.vx * dt;
  e.z += e.vz * dt;
}

function contactRange(env: RLEnv, a: Entity, b: Entity): number {
  return a.size + b.size + env.config.contactBuffer;
}

/** Execute one engine tick for `e` based on its currently held intent. */
export function engineTick(env: RLEnv, e: Entity, dt: number): void {
  // Status decay (stuns/blinds tick down even though we don't apply them yet).
  if (e.statusTimer > 0) {
    e.statusTimer -= dt;
    if (e.statusTimer <= 0) { e.status = 0; e.statusTimer = 0; }
  }
  if (e.attackTimer > 0) e.attackTimer = Math.max(0, e.attackTimer - dt);
  if (e.status === 1 /* stunned */) return;

  // Hide only persists while in Heal intent; any other intent breaks it.
  if (e.hidden && e.currentIntent !== Intent.Heal) e.hidden = false;

  const focus = e.focusedId !== null ? env.entities[e.focusedId] : null;
  const validFocus = focus && focus.alive ? focus : null;

  switch (e.currentIntent) {
    case Intent.Idle: {
      // Light random wander so idling entities don't bunch up at spawn.
      e.vx *= 0.85;
      e.vz *= 0.85;
      e.x += e.vx * dt;
      e.z += e.vz * dt;
      break;
    }
    case Intent.Attack: {
      if (!validFocus) { e.vx *= 0.9; e.vz *= 0.9; break; }
      const reach = contactRange(env, e, validFocus) * ATTACK_REACH_MULT;
      const dx = validFocus.x - e.x;
      const dz = validFocus.z - e.z;
      const d = Math.hypot(dx, dz);
      if (d > reach) {
        steerToward(e, validFocus.x, validFocus.z, e.speed, dt);
      } else {
        e.vx *= 0.5; e.vz *= 0.5;
        if (e.attackTimer <= 0) {
          env.damage(e, validFocus);
          e.attackTimer = e.attackCooldown;
        }
      }
      break;
    }
    case Intent.CC: {
      // No-op; reserved in the shared action contract.
      e.vx *= 0.9; e.vz *= 0.9;
      break;
    }
    case Intent.Heal: {
      // Archetype-specific:
      //   • grazers (cow/rabbit) → walk to nearest grass patch, chomp it
      //   • predators (wolf/cat/dog) → stand still, become hidden, regen
      //   • werewolf boss → no hide (it's a boss, it heals via attacks)
      if (isGrazer(e.archetype)) {
        const g = env.findNearestGrass(e.x, e.z);
        if (g) {
          const dx = g.x - e.x, dz = g.z - e.z;
          const d = Math.hypot(dx, dz);
          if (d > env.config.grassRadius * 0.6) {
            steerToward(e, g.x, g.z, e.speed * 0.85, dt);
          } else {
            e.vx *= 0.5; e.vz *= 0.5;
          }
        } else {
          e.vx *= 0.9; e.vz *= 0.9;
        }
        env.applyGrazeOrHide(e, dt);
      } else if (isPredator(e.archetype) && e.archetype !== 'werewolf') {
        e.vx *= 0.5; e.vz *= 0.5;
        e.hidden = true;
        env.applyGrazeOrHide(e, dt);
      } else {
        // Werewolf — heal is a no-op; trains it to prefer Attack always.
        e.vx *= 0.9; e.vz *= 0.9;
      }
      break;
    }
    case Intent.Flee: {
      if (!validFocus) { e.vx *= 0.9; e.vz *= 0.9; break; }
      // Steer to the antipode of the focus relative to current position.
      const tx = e.x - (validFocus.x - e.x);
      const tz = e.z - (validFocus.z - e.z);
      steerToward(e, tx, tz, e.speed * 1.15, dt);
      break;
    }
  }

  clampBounds(e, env.config.bounds);
}
