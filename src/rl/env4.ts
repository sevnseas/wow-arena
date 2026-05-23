/**
 * RL4 Environment wrapper: Direct control + minimap observation.
 *
 * Wraps RLEnv and converts:
 * - Actions (11 discrete) → direct velocity commands
 * - Entity state → minimap-style observations
 * Provides simplified reward signals for direct control learning.
 */

import { RLEnv } from './env';
import {
  Action, MAX_ENTITIES_RL4, FEATURES_PER_ENTITY_RL4, STATE_DIM_RL4,
  type Entity, type EntityInit, type EnvConfig, type Archetype,
} from './types';

/** Convert action to velocity direction. */
function actionToVelocity(action: number, speed: number): { vx: number; vz: number } {
  const v = speed;
  const half = v / Math.sqrt(2); // for diagonals
  switch (action) {
    case Action.MoveForward:      return { vx: 0,    vz: v };
    case Action.MoveBackward:     return { vx: 0,    vz: -v };
    case Action.StrafeLeft:       return { vx: -v,   vz: 0 };
    case Action.StrafeRight:      return { vx: v,    vz: 0 };
    case Action.MoveFwdLeft:      return { vx: -half, vz: half };
    case Action.MoveFwdRight:     return { vx: half,  vz: half };
    case Action.MoveBackLeft:     return { vx: -half, vz: -half };
    case Action.MoveBackRight:    return { vx: half,  vz: -half };
    default:                       return { vx: 0,    vz: 0 }; // abilities, no movement
  }
}

/** Get archetype code for observation (0=none, 1=wolf, ..., 6=werewolf). */
function archetypeToCode(arch: Archetype): number {
  return arch === 'wolf' ? 1
    : arch === 'rabbit' ? 2
    : arch === 'cow' ? 3
    : arch === 'cat' ? 4
    : arch === 'dog' ? 5
    : arch === 'werewolf' ? 6
    : 0;
}

export interface RLEnv4 {
  env: RLEnv;
  entities: Array<Entity & { rewardThisEpisode: number; lastHp: number }>;
}

export function createEnv4(config: Partial<EnvConfig> = {}, seed = 1): RLEnv4 {
  return { env: new RLEnv(config, seed), entities: [] };
}

/** Spawn an entity for training. */
export function spawn4(env4: RLEnv4, init: EntityInit): Entity {
  const e = env4.env.spawn(init);
  (e as any).rewardThisEpisode = 0;
  (e as any).lastHp = e.hp;
  env4.entities.push(e as any);
  return e;
}

/** Reset for next episode. */
export function reset4(env4: RLEnv4, seed?: number): void {
  env4.env.reset(seed);
  env4.entities.length = 0;
}

/** Build minimap observation for an entity. */
export function observe4(env4: RLEnv4, e: Entity): Float32Array {
  const state = new Float32Array(STATE_DIM_RL4);
  const visionRadius = env4.env.config.visionRadius;
  const maxSpeed = 10; // typical max speed for entities

  // Collect all visible entities within vision radius.
  const visible: Entity[] = [];
  const visSq = visionRadius * visionRadius;
  for (const other of env4.env.entities) {
    if (!other.alive || other.id === e.id) continue;
    const dx = other.x - e.x;
    const dz = other.z - e.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= visSq) visible.push(other);
  }

  // Closest first sorting (improves learning).
  visible.sort((a, b) => {
    const da = (a.x - e.x) ** 2 + (a.z - e.z) ** 2;
    const db = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
    return da - db;
  });

  // Fill observation with up to MAX_ENTITIES_RL4 entities.
  let idx = 0;
  for (let i = 0; i < visible.length && idx < MAX_ENTITIES_RL4; i++) {
    const other = visible[i];
    const base = idx * FEATURES_PER_ENTITY_RL4;

    const dx = other.x - e.x;
    const dz = other.z - e.z;

    state[base + 0] = (dx / visionRadius); // rel_x, may exceed [-1, 1]
    state[base + 1] = (dz / visionRadius); // rel_z
    state[base + 2] = (other.vx / maxSpeed);
    state[base + 3] = (other.vz / maxSpeed);
    state[base + 4] = other.hp / other.maxHp; // hp_pct
    state[base + 5] = archetypeToCode(other.archetype) / 6; // archetype
    state[base + 6] = other.team === e.team ? 0 : 1; // team (0=ally, 1=enemy)

    idx++;
  }

  // Pad remaining slots with zeros (already initialized).
  return state;
}

/** Execute one action (movement + ability placeholder). */
export function act4(_env4: RLEnv4, e: Entity, action: number, _dt: number): void {
  // Convert action to velocity.
  const { vx, vz } = actionToVelocity(action, e.speed);
  e.vx = vx;
  e.vz = vz;

  // Ability actions (8-10) would execute combat abilities here.
  // For now, just movement.
  if (action === Action.Ability1 || action === Action.Ability2 || action === Action.Ability3) {
    // TODO: Implement ability execution (cooldowns, damage, ranges).
  }
}

/** Apply physics step (collision, damage, etc.). */
export function step4(env4: RLEnv4, dt: number): void {
  const env = env4.env;

  // Physics: position update + boundary clamping.
  for (const e of env4.entities) {
    if (!e.alive) continue;
    e.x += e.vx * dt;
    e.z += e.vz * dt;
    if (e.x < -env.config.bounds) e.x = -env.config.bounds;
    if (e.x > env.config.bounds) e.x = env.config.bounds;
    if (e.z < -env.config.bounds) e.z = -env.config.bounds;
    if (e.z > env.config.bounds) e.z = env.config.bounds;
  }

  // Simple collision: if two entities are close, they damage each other.
  for (let i = 0; i < env4.entities.length; i++) {
    const a = env4.entities[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < env4.entities.length; j++) {
      const b = env4.entities[j];
      if (!b.alive) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const contactRange = a.size + b.size + env.config.contactBuffer;
      if (d < contactRange && a.team !== b.team) {
        // a attacks b if cooldown is ready.
        if (a.attackTimer <= 0) {
          env.damage(a, b);
          a.attackTimer = a.attackCooldown;
        }
      }
    }
  }

  // Update tick and attack timers.
  env.tick++;
  for (const e of env4.entities) {
    if (e.attackTimer > 0) e.attackTimer -= dt;
  }
}

/** Compute per-entity reward this decision interval. */
export function computeReward4(
  env4: RLEnv4,
  e: Entity & { lastHp: number; rewardThisEpisode: number; lastEnemyDist?: number },
): number {
  let r = 0;

  // Damage dealt this tick.
  const dmgEvents = env4.env.events.filter(ev => ev.type === 'damage' && ev.attackerId === e.id);
  for (const ev of dmgEvents) {
    r += ev.amount * 0.1;
    if (ev.killed) r += 3;
  }

  // Survival.
  r += 0.01;

  // Penalty for taking damage.
  const dmgTaken = Math.max(0, e.lastHp - e.hp);
  r -= dmgTaken * 0.15;

  // Distance-closing shaping: predators get a dense gradient signal when they
  // walk toward the nearest enemy. Without this, the wolf must stumble into
  // contact range purely by chance — too sparse for REINFORCE to learn from
  // within a reasonable training budget.
  let nearestEnemyDist = Infinity;
  for (const o of env4.env.entities) {
    if (!o.alive || o.id === e.id || o.team === e.team) continue;
    const dx = o.x - e.x, dz = o.z - e.z;
    const d = Math.hypot(dx, dz);
    if (d < nearestEnemyDist) nearestEnemyDist = d;
  }
  if (Number.isFinite(nearestEnemyDist) && e.lastEnemyDist !== undefined) {
    // +reward for each meter closed. Magnitude chosen so closing 1m/decision
    // dwarfs the +0.01 survival ticks but stays below the +0.1/dmg signal —
    // dense gradient for navigation, kills still dominate the long-term return.
    r += (e.lastEnemyDist - nearestEnemyDist) * 0.5;
  }
  e.lastEnemyDist = Number.isFinite(nearestEnemyDist) ? nearestEnemyDist : undefined;

  e.lastHp = e.hp;
  e.rewardThisEpisode += r;
  return r;
}
