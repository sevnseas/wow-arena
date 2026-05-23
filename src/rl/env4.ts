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
  Action, MAX_ENTITIES_RL4, FEATURES_PER_ENTITY_RL4, STATE_DIM_RL4, SELF_FEATURES_RL4,
  type Entity, type EntityInit, type EnvConfig, type Archetype,
} from './types';

/** Static grass patch (ecosystem). Rabbits absorb nutrition by walking on it.
 *  Depleted patches regrow at `grassRegrow` per second. See ecosystem.md. */
export interface Grass {
  id: number;
  x: number;
  z: number;
  /** 0..1 — fraction of full nutrition currently available. */
  nutrition: number;
  /** Seconds since the patch was last fully depleted. Zero while full. */
  regrowTimer: number;
}

/** Ecosystem events surfaced for metrics + reward shaping. Stored alongside
 *  the existing env.events (damage/kill) but kept on env4 itself so the
 *  legacy RLEnv interface doesn't need to change. */
export type EcosystemEvent =
  | { type: 'grazed'; entityId: number; amount: number }
  | { type: 'born';   parentAId: number; parentBId: number; childId: number; archetype: Archetype }
  | { type: 'died';   entityId: number; cause: 'age' | 'starvation' | 'predator' };

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
  /** Grass patches present in this env. Empty for non-ecosystem scenarios. */
  grass: Grass[];
  /** Ecosystem-level events accumulated since last `clearEcosystemEvents`. */
  events: EcosystemEvent[];
  /** Counter for unique grass ids (since they're spawned dynamically). */
  nextGrassId: number;
  /** Counter for unique entity ids when spawning newborns mid-episode. */
  config: { grazeRate: number; grassRegrow: number; grassRadius: number; interactRange: number; reproThreshold: { rabbit: number; wolf: number } };
}

/** Default ecosystem knobs — kept on env4 (not EnvConfig) so legacy RL3
 *  code doesn't have to change. */
export const ECO_DEFAULTS = {
  /** Nutrition units transferred per second when standing on a patch. */
  grazeRate: 1.5,
  /** Patch nutrition regrowth per second (capped at 1.0). */
  grassRegrow: 0.05,
  /** Patch contact radius for grazing. */
  grassRadius: 0.6,
  /** Range within which Interact can find a reproduction partner. */
  interactRange: 1.2,
  /** Per-archetype counter thresholds that gate reproduction. */
  reproThreshold: { rabbit: 3, wolf: 1 },
};

export function createEnv4(config: Partial<EnvConfig> = {}, seed = 1): RLEnv4 {
  return {
    env: new RLEnv(config, seed),
    entities: [],
    grass: [],
    events: [],
    nextGrassId: 0,
    config: { ...ECO_DEFAULTS },
  };
}

/** Add a grass patch at (x, z) with full nutrition. */
export function spawnGrass(env4: RLEnv4, x: number, z: number): Grass {
  const g: Grass = { id: env4.nextGrassId++, x, z, nutrition: 1, regrowTimer: 0 };
  env4.grass.push(g);
  return g;
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

  // Self-state features at the end. See SELF_FEATURES_RL4 docstring for
  // the slot layout — these tell the policy how much HP it has left, how
  // close to natural death, how full its reproduction counter is, and
  // where the nearest grass patch is.
  const selfBase = MAX_ENTITIES_RL4 * FEATURES_PER_ENTITY_RL4;
  state[selfBase + 0] = e.maxHp > 0 ? Math.max(0, e.hp / e.maxHp) : 0;
  state[selfBase + 1] = e.maxAge > 0 ? Math.min(1, e.age / e.maxAge) : 0;
  const counterThreshold = e.archetype === 'rabbit'
    ? env4.config.reproThreshold.rabbit
    : env4.config.reproThreshold.wolf;
  const counter = e.archetype === 'rabbit' ? e.grassEaten : e.preyEaten;
  state[selfBase + 2] = counterThreshold > 0 ? Math.min(1, counter / counterThreshold) : 0;
  // Nearest grass — only meaningful for rabbits in practice, but wolves
  // get the input too (their policy learns to ignore it).
  let bestD = Infinity, bestGx = 0, bestGz = 0;
  for (const g of env4.grass) {
    if (g.nutrition <= 0) continue;
    const dx = g.x - e.x, dz = g.z - e.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; bestGx = dx; bestGz = dz; }
  }
  if (Number.isFinite(bestD) && bestD <= visSq) {
    state[selfBase + 3] = bestGx / visionRadius;
    state[selfBase + 4] = bestGz / visionRadius;
  }
  void SELF_FEATURES_RL4;
  return state;
}

/** Execute one action (movement + ability + ecosystem Interact). */
export function act4(env4: RLEnv4, e: Entity, action: number, _dt: number): void {
  const { vx, vz } = actionToVelocity(action, e.speed);
  e.vx = vx;
  e.vz = vz;

  if (action === Action.Interact) {
    // Reproduction: requires (a) the per-archetype counter is met and (b) a
    // live same-team partner is within interactRange. Pure adjacency check —
    // no search problem for the policy.
    tryReproduce(env4, e);
  }
  // Ability1-3 are policy slots that the live game wires to abilities, but
  // env4 itself doesn't model abilities yet (combat is collision-driven).
}

/** Spawn a newborn at the midpoint of two parents iff counter + adjacency
 *  predicates pass. Resets both parents' counter on success. Emits `born`. */
function tryReproduce(env4: RLEnv4, e: Entity): boolean {
  const threshold = e.archetype === 'rabbit'
    ? env4.config.reproThreshold.rabbit
    : (e.archetype === 'wolf' || e.archetype === 'cat' || e.archetype === 'dog' || e.archetype === 'werewolf')
      ? env4.config.reproThreshold.wolf
      : Infinity;
  const counter = e.archetype === 'rabbit' ? e.grassEaten : e.preyEaten;
  if (counter < threshold) return false;

  const range = env4.config.interactRange;
  let mate: Entity | null = null;
  let bestD2 = range * range;
  for (const o of env4.env.entities) {
    if (!o.alive || o.id === e.id) continue;
    if (o.archetype !== e.archetype) continue; // same species only
    const d2 = (o.x - e.x) * (o.x - e.x) + (o.z - e.z) * (o.z - e.z);
    if (d2 < bestD2) { bestD2 = d2; mate = o; }
  }
  if (!mate) return false;

  // Spawn newborn at midpoint, full HP, age 0, inherits parents' params.
  const child = env4.env.spawn({
    archetype: e.archetype,
    team: e.team,
    x: (e.x + mate.x) / 2,
    z: (e.z + mate.z) / 2,
    hp: e.maxHp,
    maxHp: e.maxHp,
    size: e.size,
    speed: e.speed,
    attackCooldown: e.attackCooldown,
    maxAge: e.maxAge,
    starveRate: e.starveRate,
  });
  // RLEnv4 tracks `entities` separately with reward bookkeeping fields.
  (child as Entity & { rewardThisEpisode: number; lastHp: number }).rewardThisEpisode = 0;
  (child as Entity & { rewardThisEpisode: number; lastHp: number }).lastHp = child.hp;
  env4.entities.push(child as Entity & { rewardThisEpisode: number; lastHp: number });

  // Reset both parents' counters.
  if (e.archetype === 'rabbit') {
    e.grassEaten = 0; mate.grassEaten = 0;
  } else {
    e.preyEaten = 0; mate.preyEaten = 0;
  }

  env4.events.push({
    type: 'born', parentAId: e.id, parentBId: mate.id, childId: child.id,
    archetype: e.archetype,
  });
  return true;
}

/** Apply physics step (collision, damage, grazing, ageing, starvation). */
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

  // Combat collision: enemies in contact attack. Predator kills track
  // `preyEaten` for reproduction; deaths get a `predator` cause event.
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
        if (a.attackTimer <= 0) {
          const targetWasAlive = b.alive;
          env.damage(a, b);
          a.attackTimer = a.attackCooldown;
          if (targetWasAlive && !b.alive) {
            // Predator credit + death event for ecosystem metrics.
            a.preyEaten += 1;
            env4.events.push({ type: 'died', entityId: b.id, cause: 'predator' });
          }
        }
      }
    }
  }

  // Grass regrowth + grazing pass.
  const { grassRadius, grassRegrow, grazeRate } = env4.config;
  for (const g of env4.grass) {
    if (g.nutrition < 1) {
      g.regrowTimer += dt;
      g.nutrition = Math.min(1, g.nutrition + grassRegrow * dt);
      if (g.nutrition >= 1) g.regrowTimer = 0;
    }
  }
  for (const e of env4.entities) {
    if (!e.alive || e.archetype !== 'rabbit') continue;
    for (const g of env4.grass) {
      if (g.nutrition <= 0) continue;
      const dx = g.x - e.x, dz = g.z - e.z;
      if (dx * dx + dz * dz > grassRadius * grassRadius) continue;
      const take = Math.min(g.nutrition, grazeRate * dt);
      g.nutrition -= take;
      if (g.nutrition <= 0) {
        g.nutrition = 0;
        g.regrowTimer = 0;
      }
      e.grassEaten += take;
      e.hp = Math.min(e.maxHp, e.hp + take * 8); // grazing also heals
      env4.events.push({ type: 'grazed', entityId: e.id, amount: take });
    }
  }

  // Age + starvation. Death events are emitted exactly once per entity:
  // either `age` or `starvation` (predator deaths are above).
  for (const e of env4.entities) {
    if (!e.alive) continue;
    e.age += dt;
    if (e.starveRate > 0) e.hp -= e.starveRate * dt;
    if (e.age > e.maxAge) {
      e.alive = false;
      env4.events.push({ type: 'died', entityId: e.id, cause: 'age' });
    } else if (e.hp <= 0) {
      e.alive = false;
      env4.events.push({ type: 'died', entityId: e.id, cause: 'starvation' });
    }
  }

  // Update tick and attack timers.
  env.tick++;
  for (const e of env4.entities) {
    if (e.attackTimer > 0) e.attackTimer -= dt;
  }
}

/** Clear accumulated ecosystem events. Call between reward computation
 *  windows so events aren't double-counted. */
export function clearEcosystemEvents(env4: RLEnv4): void {
  env4.events.length = 0;
}

/** Reward shaping mode — pick the right reward function for what we're
 *  training. The legacy 'hunt' mode is what RL4 currently trains on.
 *  'rabbit' rewards grazing + reproduction + survival. 'wolf' rewards
 *  hunting + eating + reproduction. */
export type RewardMode = 'hunt' | 'rabbit' | 'wolf';

/** Per-entity reward bookkeeping the shaping functions need across ticks. */
type RewardCarry = Entity & {
  lastHp: number;
  rewardThisEpisode: number;
  lastEnemyDist?: number;
  lastGrassDist?: number;
};

/** Compute per-entity reward this decision interval. `mode` selects which
 *  shaping function to use; see RewardMode. Legacy callers (no mode) get
 *  the 'hunt' shaping that all the trained wolf/cat/werewolf policies used. */
export function computeReward4(env4: RLEnv4, e: RewardCarry, mode: RewardMode = 'hunt'): number {
  switch (mode) {
    case 'rabbit': return rewardRabbit(env4, e);
    case 'wolf':   return rewardWolf(env4, e);
    case 'hunt':
    default:       return rewardHunt(env4, e);
  }
}

/** Hunting (legacy RL4): damage dealt, kill bonus, distance-closing on
 *  nearest enemy. What wolf/cat/werewolf were trained on. */
function rewardHunt(env4: RLEnv4, e: RewardCarry): number {
  let r = 0;
  const dmgEvents = env4.env.events.filter(ev => ev.type === 'damage' && ev.attackerId === e.id);
  for (const ev of dmgEvents) {
    r += ev.amount * 0.1;
    if (ev.killed) r += 3;
  }
  r += 0.01; // survival
  const dmgTaken = Math.max(0, e.lastHp - e.hp);
  r -= dmgTaken * 0.15;
  let nearestEnemyDist = Infinity;
  for (const o of env4.env.entities) {
    if (!o.alive || o.id === e.id || o.team === e.team) continue;
    const dx = o.x - e.x, dz = o.z - e.z;
    const d = Math.hypot(dx, dz);
    if (d < nearestEnemyDist) nearestEnemyDist = d;
  }
  if (Number.isFinite(nearestEnemyDist) && e.lastEnemyDist !== undefined) {
    r += (e.lastEnemyDist - nearestEnemyDist) * 0.5;
  }
  e.lastEnemyDist = Number.isFinite(nearestEnemyDist) ? nearestEnemyDist : undefined;
  e.lastHp = e.hp;
  e.rewardThisEpisode += r;
  return r;
}

/** Rabbit shaping: reward grazing + each successful birth + staying alive,
 *  penalize starvation HP drain. Distance-closing on nearest grass when
 *  hungry (counter < threshold) — once full, no shaping toward grass so the
 *  policy is free to seek a partner. */
function rewardRabbit(env4: RLEnv4, e: RewardCarry): number {
  let r = 0;
  const grazedEv = env4.events.filter(ev => ev.type === 'grazed' && (ev as any).entityId === e.id);
  for (const ev of grazedEv) r += (ev as any).amount * 0.5;
  const bornEv = env4.events.filter(ev => ev.type === 'born' &&
    ((ev as any).parentAId === e.id || (ev as any).parentBId === e.id));
  r += bornEv.length * 10;
  const diedEv = env4.events.filter(ev => ev.type === 'died' && (ev as any).entityId === e.id);
  r -= diedEv.length * 2;
  r += 0.02; // alive-this-tick bonus — strong incentive to dodge predators
  const dmgTaken = Math.max(0, e.lastHp - e.hp);
  r -= dmgTaken * 0.2;
  // Distance to nearest grass — only shape it when the rabbit still needs
  // food. Once full, no pull, so it can focus on finding a mate.
  const threshold = env4.config.reproThreshold.rabbit;
  if (e.grassEaten < threshold) {
    let bestD = Infinity;
    for (const g of env4.grass) {
      if (g.nutrition <= 0) continue;
      const d = Math.hypot(g.x - e.x, g.z - e.z);
      if (d < bestD) bestD = d;
    }
    if (Number.isFinite(bestD) && e.lastGrassDist !== undefined) {
      r += (e.lastGrassDist - bestD) * 0.4;
    }
    e.lastGrassDist = Number.isFinite(bestD) ? bestD : undefined;
  } else {
    // Full — pull toward nearest same-team partner instead.
    let bestD = Infinity;
    for (const o of env4.env.entities) {
      if (!o.alive || o.id === e.id || o.archetype !== e.archetype) continue;
      const d = Math.hypot(o.x - e.x, o.z - e.z);
      if (d < bestD) bestD = d;
    }
    if (Number.isFinite(bestD) && e.lastGrassDist !== undefined) {
      r += (e.lastGrassDist - bestD) * 0.4;
    }
    e.lastGrassDist = Number.isFinite(bestD) ? bestD : undefined;
  }
  e.lastHp = e.hp;
  e.rewardThisEpisode += r;
  return r;
}

/** Wolf shaping: damage + kills (which auto-credit preyEaten) + each
 *  successful birth + alive bonus. Distance shaping on nearest rabbit
 *  always (predator's primary goal). */
function rewardWolf(env4: RLEnv4, e: RewardCarry): number {
  let r = 0;
  const dmgEvents = env4.env.events.filter(ev => ev.type === 'damage' && ev.attackerId === e.id);
  for (const ev of dmgEvents) {
    r += ev.amount * 0.1;
    if (ev.killed) r += 3;
  }
  const bornEv = env4.events.filter(ev => ev.type === 'born' &&
    ((ev as any).parentAId === e.id || (ev as any).parentBId === e.id));
  r += bornEv.length * 10;
  r += 0.01;
  const dmgTaken = Math.max(0, e.lastHp - e.hp);
  r -= dmgTaken * 0.15;
  let nearestEnemyDist = Infinity;
  for (const o of env4.env.entities) {
    if (!o.alive || o.id === e.id || o.team === e.team) continue;
    const dx = o.x - e.x, dz = o.z - e.z;
    const d = Math.hypot(dx, dz);
    if (d < nearestEnemyDist) nearestEnemyDist = d;
  }
  if (Number.isFinite(nearestEnemyDist) && e.lastEnemyDist !== undefined) {
    r += (e.lastEnemyDist - nearestEnemyDist) * 0.5;
  }
  e.lastEnemyDist = Number.isFinite(nearestEnemyDist) ? nearestEnemyDist : undefined;
  e.lastHp = e.hp;
  e.rewardThisEpisode += r;
  return r;
}
