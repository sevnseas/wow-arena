/**
 * Headless, tick-driven RL environment. Time advances by `dt` per step,
 * never by wall-clock — so 100k ticks runs as fast as the CPU allows.
 *
 * Tier 1 (the neural brain) is called once per `decisionInterval` ticks
 * via `decide()`. Between decisions, Tier 2 (the engine in ./engine.ts)
 * executes the held intention algorithmically each tick.
 *
 * Damage is size-proportional: `dmg = baseDamage * attacker.size`. This is
 * the "make damage proportional to entity size" requirement from the goal.
 */

import { Rng } from './rng';
import {
  DEFAULT_ENV_CONFIG,
  type Entity,
  type EntityInit,
  type EnvConfig,
  type GrassPatch,
  Intent,
  STATE_DIM,
  isGrazer,
} from './types';

export interface StepEventDamage {
  type: 'damage';
  attackerId: number;
  victimId: number;
  amount: number;
  killed: boolean;
}
export type StepEvent = StepEventDamage;

export interface EnvSnapshot {
  tick: number;
  entities: ReadonlyArray<Readonly<Entity>>;
}

export class RLEnv {
  readonly config: EnvConfig;
  readonly entities: Entity[] = [];
  readonly grass: GrassPatch[] = [];
  readonly rng: Rng;
  tick = 0;
  events: StepEvent[] = [];
  private nextId = 0;

  constructor(config: Partial<EnvConfig> = {}, seed = 1) {
    this.config = { ...DEFAULT_ENV_CONFIG, ...config };
    this.rng = new Rng(seed);
  }

  reset(seed?: number): void {
    if (seed !== undefined) (this.rng as any).state = (seed >>> 0) || 1;
    this.tick = 0;
    this.entities.length = 0;
    this.grass.length = 0;
    this.events.length = 0;
    this.nextId = 0;
  }

  /** Scatter `count` grass patches uniformly inside the bounds. */
  seedGrass(count: number): void {
    for (let i = 0; i < count; i++) {
      this.grass.push({
        x: this.rng.range(-this.config.bounds * 0.9, this.config.bounds * 0.9),
        z: this.rng.range(-this.config.bounds * 0.9, this.config.bounds * 0.9),
        nutrition: this.config.grassNutrition,
        regrowTimer: 0,
      });
    }
  }

  findNearestGrass(x: number, z: number): GrassPatch | null {
    let best: GrassPatch | null = null;
    let bestSq = Infinity;
    for (const g of this.grass) {
      if (g.nutrition <= 0) continue;
      const d = (g.x - x) * (g.x - x) + (g.z - z) * (g.z - z);
      if (d < bestSq) { bestSq = d; best = g; }
    }
    return best;
  }

  spawn(init: EntityInit): Entity {
    const e: Entity = {
      id: this.nextId++,
      archetype: init.archetype,
      team: init.team,
      x: init.x,
      z: init.z,
      vx: 0,
      vz: 0,
      hp: init.hp,
      maxHp: init.maxHp,
      size: init.size,
      speed: init.speed,
      attackCooldown: init.attackCooldown,
      attackTimer: 0,
      status: 0,
      statusTimer: 0,
      lastHitTick: -9999,
      attackerId: null,
      personalityBias: init.personalityBias ?? new Float32Array(5),
      temperature: init.temperature ?? 1.0,
      currentIntent: Intent.Idle,
      focusedId: null,
      rewardThisEpisode: 0,
      alive: true,
      damageBuff: 0,
      hidden: false,
      healedThisDecision: 0,
      killsThisEpisode: 0,
      // Ecosystem defaults — long lifespan + no starvation unless the caller
      // passes ecosystem-specific values. Keeps legacy tests/training unaffected.
      age: 0,
      maxAge: init.maxAge ?? 9999,
      starveRate: init.starveRate ?? 0,
      grassEaten: 0,
      preyEaten: 0,
    };
    this.entities.push(e);
    return e;
  }

  /** Random scatter spawn helper used by the training rollouts. */
  scatterSpawn(init: Omit<EntityInit, 'x' | 'z'>, count: number, area = 0.8): Entity[] {
    const out: Entity[] = [];
    const r = this.config.bounds * area;
    for (let i = 0; i < count; i++) {
      out.push(this.spawn({
        ...init,
        x: this.rng.range(-r, r),
        z: this.rng.range(-r, r),
      }));
    }
    return out;
  }

  /** True when this tick is a decision tick (Tier 1 must run). */
  isDecisionTick(): boolean {
    return this.tick % this.config.decisionInterval === 0;
  }

  /** Locate the highest-priority focus target for an entity. */
  pickFocus(e: Entity): Entity | null {
    let best: Entity | null = null;
    let bestScore = -Infinity;
    const visSq = this.config.visionRadius * this.config.visionRadius;
    for (const other of this.entities) {
      if (!other.alive || other.id === e.id) continue;
      // Hidden predators are unfocusable except by the werewolf boss (better senses).
      if (other.hidden && e.archetype !== 'werewolf') continue;
      const dx = other.x - e.x;
      const dz = other.z - e.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > visSq) continue;
      const enemy = other.team !== e.team ? 1 : 0;
      // Boss-takedown bias: low-HP enemies get a bigger weight so wounded
      // werewolves (or any tough enemy) become unmissable — encourages the
      // emergent gang-up behavior we want from training.
      const lowHp = (1 - other.hp / other.maxHp);
      // Prefer enemies, then low-hp targets (heavy weight), then nearby targets.
      const score = enemy * 10 + lowHp * 8 - Math.sqrt(d2) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = other;
      }
    }
    return best;
  }

  /** Build the 12-dim state vector for entity `e`. See STATE_DIM doc-comment. */
  observe(e: Entity, out: Float32Array, offset = 0): Entity | null {
    const focus = this.pickFocus(e);
    e.focusedId = focus?.id ?? null;

    let allyDanger = 1.0;
    let pressure = 0;
    let herdPanic = 0;        // ∑ (damage-recency * proximity) over allies
    let packReadiness = 0;    // # same-team allies also targeting our focus
    const recentDmgWindow = 2.0; // seconds
    const visSq = this.config.visionRadius * this.config.visionRadius;
    for (const o of this.entities) {
      if (!o.alive || o.id === e.id) continue;
      const dx = o.x - e.x, dz = o.z - e.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > visSq) continue;
      if (o.team === e.team) {
        allyDanger = Math.min(allyDanger, o.hp / o.maxHp);
        // Herd panic: a recently-hit ally pulls the herd's attention.
        const sinceHit = (this.tick - o.lastHitTick) * this.config.dt;
        if (sinceHit < recentDmgWindow) {
          const recency = 1 - sinceHit / recentDmgWindow;
          const proximity = 1 - Math.sqrt(d2) / this.config.visionRadius;
          herdPanic += recency * proximity;
        }
        // Pack readiness: ally has the same focus → coordinated strike likely.
        if (focus && o.focusedId === focus.id) packReadiness++;
      } else if (o.attackerId === e.id || (o.currentIntent === Intent.Attack && o.focusedId === e.id)) {
        pressure++;
      }
    }

    const focusType = focus
      ? focus.archetype === 'wolf' ? 1
      : focus.archetype === 'rabbit' ? 2
      : focus.archetype === 'cow' ? 3
      : focus.archetype === 'cat' ? 4
      : focus.archetype === 'dog' ? 5
      : focus.archetype === 'werewolf' ? 6
      : 0
      : 0;
    const focusHp = focus ? focus.hp / focus.maxHp : 0;
    const focusDist = focus
      ? Math.min(1, Math.hypot(focus.x - e.x, focus.z - e.z) / this.config.visionRadius)
      : 1;

    // Target unawareness: focus is hidden, fleeing, or facing away from us.
    // Proxy "facing away" via velocity direction vs. line-to-self.
    let unawareness = 0;
    if (focus) {
      if (focus.hidden) unawareness = 1;
      else if (focus.currentIntent === Intent.Flee) unawareness = 0.8;
      else {
        const vmag = Math.hypot(focus.vx, focus.vz);
        if (vmag > 0.3) {
          const toMeX = e.x - focus.x, toMeZ = e.z - focus.z;
          const toMeMag = Math.hypot(toMeX, toMeZ) || 1;
          const dot = (focus.vx * toMeX + focus.vz * toMeZ) / (vmag * toMeMag);
          // dot=1 → moving toward us (aware), dot=-1 → moving away (unaware).
          unawareness = Math.max(0, (1 - dot) * 0.5);
        }
      }
    }

    // Resource density: nutrition available within a short forage radius.
    let resourceDensity = 0;
    const forageR2 = 64; // 8m
    for (const g of this.grass) {
      if (g.nutrition <= 0) continue;
      const d2g = (g.x - e.x) * (g.x - e.x) + (g.z - e.z) * (g.z - e.z);
      if (d2g < forageR2) resourceDensity += g.nutrition / this.config.grassNutrition;
    }
    resourceDensity = Math.min(1, resourceDensity / 3);

    // Energy reserve: HP-as-proxy for hunger/stamina. For grazers grazingUntil
    // damageBuff pushes this above 1 — capped to 1 for the brain.
    const energyReserve = Math.min(1, e.hp / e.maxHp + e.damageBuff * 0.3);

    out[offset + 0] = e.hp / e.maxHp;
    out[offset + 1] = e.status / 2;
    out[offset + 2] = focusType / 6;
    out[offset + 3] = focusHp;
    out[offset + 4] = focusDist;
    out[offset + 5] = 1 - allyDanger;
    out[offset + 6] = Math.min(1, pressure / 5);
    out[offset + 7] = Math.min(1, herdPanic);
    out[offset + 8] = Math.min(1, packReadiness / 4);
    out[offset + 9] = unawareness;
    out[offset + 10] = resourceDensity;
    out[offset + 11] = energyReserve;
    return focus;
  }

  /** Size-proportional damage; scales with attacker.damageBuff (graze stacks). */
  damage(attacker: Entity, victim: Entity): boolean {
    if (!victim.alive) return false;
    const amount = this.config.baseDamage * attacker.size * (1 + attacker.damageBuff);
    victim.hp -= amount;
    victim.lastHitTick = this.tick;
    victim.attackerId = attacker.id;
    // Taking damage breaks hide.
    victim.hidden = false;
    const killed = victim.hp <= 0;
    if (killed) {
      victim.hp = 0;
      victim.alive = false;
      attacker.killsThisEpisode++;
    }
    this.events.push({ type: 'damage', attackerId: attacker.id, victimId: victim.id, amount, killed });
    return killed;
  }

  /** Live entities only. */
  living(): Entity[] {
    return this.entities.filter(e => e.alive);
  }

  /**
   * Apply the heal effects: grazers chomp the patch they're standing on
   * (HP + damage buff); hidden predators slowly regenerate HP. Called by
   * the engine every tick for entities in Heal intent.
   */
  applyGrazeOrHide(e: Entity, dt: number): void {
    if (isGrazer(e.archetype)) {
      // Standing on a grass patch?
      for (const g of this.grass) {
        if (g.nutrition <= 0) continue;
        const dx = g.x - e.x, dz = g.z - e.z;
        if (dx * dx + dz * dz <= this.config.grassRadius * this.config.grassRadius) {
          const consumed = Math.min(g.nutrition, this.config.grazeHealRate * dt);
          g.nutrition -= consumed;
          if (g.nutrition <= 0) { g.nutrition = 0; g.regrowTimer = this.config.grassRegrow; }
          const before = e.hp;
          e.hp = Math.min(e.maxHp, e.hp + consumed);
          e.healedThisDecision += (e.hp - before);
          e.damageBuff = Math.min(this.config.grazeBuffCap, e.damageBuff + this.config.grazeBuffRate * dt);
          break;
        }
      }
    } else {
      // Hidden predator regen — must be off-combat for >2s (no recent damage).
      const offCombat = (this.tick - e.lastHitTick) * this.config.dt > 2.0;
      if (e.hidden && offCombat) {
        const before = e.hp;
        e.hp = Math.min(e.maxHp, e.hp + this.config.hideHealRate * dt);
        e.healedThisDecision += (e.hp - before);
      }
    }
  }

  /** Re-grow exhausted grass patches over time. */
  tickGrass(dt: number): void {
    for (const g of this.grass) {
      if (g.nutrition > 0) continue;
      g.regrowTimer -= dt;
      if (g.regrowTimer <= 0) g.nutrition = this.config.grassNutrition;
    }
  }
}

export { STATE_DIM };
