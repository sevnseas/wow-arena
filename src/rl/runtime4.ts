/**
 * Browser runtime that bridges trained RL4 (direct-control + minimap) policies
 * onto live game entities.
 *
 * Mirrors the training contract in env4.ts:
 *   • Observation = 20 nearest entities × 7 features (rel pos, vel, hp, type, team)
 *   • Action      = 11 discrete (8 movement directions + 3 ability slots)
 *
 * Each tracked entity exposes a `PolicyAgent4Ref` with `applyAction(action,
 * focus)`. The engine in wolves.ts / cats.ts / mutant-predator.ts translates
 * movement actions to a steering target (so existing locomotion/animation
 * keeps working) and abilities to combat triggers.
 */

import { Policy4, deserializePolicy4 } from './policy4';
import {
  ACTION_COUNT, Action,
  ARCHETYPES, MAX_ENTITIES_RL4, FEATURES_PER_ENTITY_RL4, STATE_DIM_RL4,
  type Archetype, type Team,
} from './types';
import { Rng } from './rng';

export interface PolicyAgent4Ref {
  id: string;
  team: Team;
  archetype: Archetype;
  size: number;
  alive: boolean;
  hp: number;
  maxHp: number;
  /** Age in seconds (optional, defaults to 0 for scenarios). */
  age?: number;
  /** Reproduction counter: grassEaten for rabbits, preyEaten for wolves (optional, defaults to 0). */
  counter?: number;
  /** World-space position (z is depth in the game world). */
  pos: { x: number; z: number };
  /** Apply the policy's chosen Action for the next decision window. */
  applyAction(action: number, focus: PolicyAgent4Ref | null): void;
}

export class Policy4Registry {
  policies: Partial<Record<Archetype, Policy4>> = {};
  get(a: Archetype): Policy4 | null { return this.policies[a] ?? null; }
  has(a: Archetype): boolean { return !!this.policies[a]; }
}

export async function loadPolicy4Registry(baseUrl: string): Promise<Policy4Registry | null> {
  try {
    const results = await Promise.all(ARCHETYPES.map(async (a) => {
      const res = await fetch(`${baseUrl}/${a}.json`);
      if (!res.ok) return [a, null] as const;
      return [a, await res.text()] as const;
    }));
    const reg = new Policy4Registry();
    let any = false;
    for (const [a, json] of results) {
      if (json) {
        try { reg.policies[a] = deserializePolicy4(json); any = true; }
        catch (e) { console.warn(`[rl4] failed to parse ${a}.json:`, e); }
      }
    }
    return any ? reg : null;
  } catch (err) {
    console.warn('[rl4] failed to load policy registry:', err);
    return null;
  }
}

export interface PolicyDriver4Config {
  decisionInterval: number;
  visionRadius: number;
  maxSpeed: number;
  temperature: number;
  seed: number;
}

export const DEFAULT_DRIVER4_CONFIG: PolicyDriver4Config = {
  decisionInterval: 0.4,
  visionRadius: 18,
  maxSpeed: 10,
  temperature: 1.0,
  seed: 1,
};

const ACTION_NAMES = [
  'MoveFwd', 'MoveBack', 'StrafeL', 'StrafeR',
  'FwdL', 'FwdR', 'BackL', 'BackR',
  'Ability1', 'Ability2', 'Ability3', 'Interact',
];

export interface AgentDecision4 {
  action: number;
  actionName: string;
  probs: Float32Array;
  state: Float32Array;
  focusId: string | null;
  takenAt: number;
}

function archetypeCode(a: Archetype): number {
  return a === 'wolf' ? 1 : a === 'rabbit' ? 2 : a === 'cow' ? 3
       : a === 'cat' ? 4 : a === 'dog' ? 5 : a === 'werewolf' ? 6 : 0;
}

export class PolicyDriver4 {
  readonly cfg: PolicyDriver4Config;
  private registry: Policy4Registry;
  private agents: PolicyAgent4Ref[] = [];
  private agentById = new Map<string, PolicyAgent4Ref>();
  private decisions = new Map<string, AgentDecision4>();
  private nextDecision = new Map<string, number>();
  /** Last observed position + elapsed-at-time for finite-difference velocity. */
  private lastObs = new Map<string, { x: number; z: number; t: number }>();
  /** Cached velocity per agent — refreshed at observation time. */
  private velCache = new Map<string, { x: number; z: number }>();
  /** Agents the brain should observe but not steer (e.g. player takeover). */
  private paused = new Set<string>();
  elapsed = 0;
  private rng: Rng;

  constructor(registry: Policy4Registry, cfg?: Partial<PolicyDriver4Config>) {
    this.registry = registry;
    this.cfg = { ...DEFAULT_DRIVER4_CONFIG, ...(cfg ?? {}) };
    this.rng = new Rng(this.cfg.seed);
  }

  setAgents(agents: PolicyAgent4Ref[]): void {
    this.agents = agents.slice();
    this.agentById.clear();
    for (const a of this.agents) {
      this.agentById.set(a.id, a);
      if (!this.nextDecision.has(a.id)) {
        // Stagger so all agents don't decide on the same frame.
        this.nextDecision.set(a.id, this.elapsed + this.rng.next() * this.cfg.decisionInterval);
      }
    }
  }

  getAgent(id: string): PolicyAgent4Ref | null { return this.agentById.get(id) ?? null; }
  getDecision(id: string): AgentDecision4 | null { return this.decisions.get(id) ?? null; }
  hasPolicy(arch: Archetype): boolean { return this.registry.has(arch); }
  pause(id: string): void { this.paused.add(id); }
  resume(id: string): void { this.paused.delete(id); }
  isPaused(id: string): boolean { return this.paused.has(id); }

  update(dt: number): void {
    this.elapsed += dt;
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (!this.registry.has(a.archetype)) continue;
      if (this.paused.has(a.id)) continue;
      const due = this.nextDecision.get(a.id) ?? 0;
      if (this.elapsed < due) continue;
      this.decide(a);
      this.nextDecision.set(a.id, this.elapsed + this.cfg.decisionInterval);
    }
  }

  private decide(a: PolicyAgent4Ref): void {
    this.refreshVelocities();
    const focus = this.pickFocus(a);
    const state = this.observe(a);
    const policy = this.registry.get(a.archetype)!;
    const { probs } = policy.forward(state, this.cfg.temperature);
    const action = this.rng.categorical(probs);

    this.decisions.set(a.id, {
      action,
      actionName: ACTION_NAMES[action] ?? String(action),
      probs: new Float32Array(probs),
      state,
      focusId: focus?.id ?? null,
      takenAt: this.elapsed,
    });

    a.applyAction(action, focus);
  }

  /** Refresh per-agent velocity by finite-differencing position vs last
   *  observation. Cheap and avoids leaking velocity tracking into entities. */
  private refreshVelocities(): void {
    for (const a of this.agents) {
      const last = this.lastObs.get(a.id);
      if (last) {
        const dt = Math.max(1e-3, this.elapsed - last.t);
        this.velCache.set(a.id, { x: (a.pos.x - last.x) / dt, z: (a.pos.z - last.z) / dt });
      } else {
        this.velCache.set(a.id, { x: 0, z: 0 });
      }
      this.lastObs.set(a.id, { x: a.pos.x, z: a.pos.z, t: this.elapsed });
    }
  }

  /** Pick a target for ability-routing: closest enemy in vision. */
  private pickFocus(a: PolicyAgent4Ref): PolicyAgent4Ref | null {
    let best: PolicyAgent4Ref | null = null;
    let bestD2 = Infinity;
    const r2 = this.cfg.visionRadius * this.cfg.visionRadius;
    for (const o of this.agents) {
      if (!o.alive || o.id === a.id) continue;
      if (o.team === a.team) continue;
      const dx = o.pos.x - a.pos.x;
      const dz = o.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      // Slight low-HP preference, scaled smaller than distance.
      const score = d2 - (1 - o.hp / o.maxHp) * 6;
      if (score < bestD2) { bestD2 = score; best = o; }
    }
    return best;
  }

  /** Build the 140-dim minimap observation — mirror of env4.observe4. */
  private observe(a: PolicyAgent4Ref): Float32Array {
    const state = new Float32Array(STATE_DIM_RL4);
    const r = this.cfg.visionRadius;
    const r2 = r * r;
    const maxSpeed = this.cfg.maxSpeed;

    const visible: PolicyAgent4Ref[] = [];
    for (const o of this.agents) {
      if (!o.alive || o.id === a.id) continue;
      const dx = o.pos.x - a.pos.x;
      const dz = o.pos.z - a.pos.z;
      if (dx * dx + dz * dz <= r2) visible.push(o);
    }
    visible.sort((x, y) => {
      const dxa = x.pos.x - a.pos.x, dza = x.pos.z - a.pos.z;
      const dxb = y.pos.x - a.pos.x, dzb = y.pos.z - a.pos.z;
      return (dxa * dxa + dza * dza) - (dxb * dxb + dzb * dzb);
    });

    const n = Math.min(visible.length, MAX_ENTITIES_RL4);
    for (let i = 0; i < n; i++) {
      const o = visible[i];
      const base = i * FEATURES_PER_ENTITY_RL4;
      const v = this.velCache.get(o.id) ?? { x: 0, z: 0 };
      state[base + 0] = (o.pos.x - a.pos.x) / r;
      state[base + 1] = (o.pos.z - a.pos.z) / r;
      state[base + 2] = v.x / maxSpeed;
      state[base + 3] = v.z / maxSpeed;
      state[base + 4] = o.maxHp > 0 ? o.hp / o.maxHp : 0;
      state[base + 5] = archetypeCode(o.archetype) / 6;
      state[base + 6] = o.team === a.team ? 0 : 1;
    }

    // Self-state features (HP%, age%, counter%, nearest grass X/Z).
    const selfBase = MAX_ENTITIES_RL4 * FEATURES_PER_ENTITY_RL4;
    state[selfBase + 0] = a.maxHp > 0 ? Math.max(0, a.hp / a.maxHp) : 0;
    state[selfBase + 1] = a.age !== undefined ? Math.min(1, (a.age ?? 0) / 60) : 0; // Assume 60s max age for scenarios
    const counter = a.counter ?? 0;
    const threshold = a.archetype === 'rabbit' ? 3 : a.archetype === 'wolf' ? 1 : 0;
    state[selfBase + 2] = threshold > 0 ? Math.min(1, counter / threshold) : 0;
    // Grass location: not available in scenario, set to 0 (no visible grass).
    state[selfBase + 3] = 0;
    state[selfBase + 4] = 0;
    return state;
  }
}

/** World-space direction vector for a movement action. Length 1 (unit). */
export function actionToUnitVec(action: number): { x: number; z: number } {
  const inv = 1 / Math.SQRT2;
  switch (action) {
    case Action.MoveForward:  return { x: 0,    z: 1 };
    case Action.MoveBackward: return { x: 0,    z: -1 };
    case Action.StrafeLeft:   return { x: -1,   z: 0 };
    case Action.StrafeRight:  return { x: 1,    z: 0 };
    case Action.MoveFwdLeft:  return { x: -inv, z: inv };
    case Action.MoveFwdRight: return { x: inv,  z: inv };
    case Action.MoveBackLeft: return { x: -inv, z: -inv };
    case Action.MoveBackRight:return { x: inv,  z: -inv };
    default:                  return { x: 0,    z: 0 };
  }
}

export function isMovementAction(action: number): boolean {
  return action >= Action.MoveForward && action <= Action.MoveBackRight;
}

export function isAbilityAction(action: number): boolean {
  return action >= Action.Ability1 && action <= Action.Ability3;
}

export { ACTION_NAMES };
export { ACTION_COUNT };
