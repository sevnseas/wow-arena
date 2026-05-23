/**
 * Browser runtime that bridges trained Policies onto live game entities.
 *
 * Each tracked entity is wrapped in a `PolicyAgent` adapter that:
 *   • exposes only the high-level fields the brain needs (pos/hp/team/size)
 *   • implements `applyIntent(intent, focus)` to nudge the entity's existing
 *     algorithmic state machine (Tier 2 lives in wolves.ts / rabbits.ts).
 *
 * The driver re-decides every `decisionInterval` seconds per agent and runs
 * the shared Policy with the agent's personality bias + temperature, exactly
 * matching the headless training contract.
 */

import { Policy, deserializePolicy } from './policy';
import { PolicyRegistry } from './registry';
import { ARCHETYPES, Intent, INTENT_COUNT, STATE_DIM, type Team, type Archetype } from './types';
import { Rng } from './rng';

/** Optional context passed to `applyIntent` so the engine can react to live
 *  ecosystem state — e.g. flee away from the most recent attacker, not just
 *  the focus the brain happened to pick. */
export interface IntentContext {
  resolveAttacker?: (id: string) => { pos: { x: number; z: number } } | null;
}

export interface PolicyAgentRef {
  id: string;
  team: Team;
  archetype: Archetype;
  size: number;
  alive: boolean;
  hp: number;
  maxHp: number;
  status: 0 | 1 | 2;
  pos: { x: number; z: number };
  /** Per-individual personality offsets (length INTENT_COUNT). */
  personalityBias: Float32Array;
  temperature: number;
  /** Most recent entity to damage us — used for Flee target selection. */
  attackerId?: string | null;
  /** Engine hook: execute the chosen intent for the next decision window. */
  applyIntent(intent: Intent, focus: PolicyAgentRef | null, ctx?: IntentContext): void;
}

export interface PolicyDriverConfig {
  decisionInterval: number; // seconds between brain decisions per agent
  visionRadius: number;
  seed: number;
  /**
   * Hysteresis margin: to *switch* away from the currently-held intent the
   * new sample's probability must exceed the held intent's probability by
   * this much. Prevents flip-flopping when the distribution is roughly tied.
   */
  switchMargin: number;
  /**
   * Minimum seconds an intent persists after being chosen, regardless of
   * margin. Commitment actions (Heal, Flee) deserve a chance to actually
   * pay off before the brain second-guesses itself. Critical-HP events
   * override the hold.
   */
  minHoldSeconds: number;
  /**
   * If HP fraction drops by this much in one decision interval, the
   * minimum-hold lock is broken so the entity can react to a sudden threat.
   */
  panicHpDrop: number;
}

export const DEFAULT_DRIVER_CONFIG: PolicyDriverConfig = {
  decisionInterval: 0.5,
  visionRadius: 18,
  seed: 1,
  switchMargin: 0.12,
  minHoldSeconds: 1.2,
  panicHpDrop: 0.15,
};

/**
 * Fetch a full per-archetype PolicyRegistry from `${baseUrl}/<archetype>.json`.
 * Missing files fall back to a freshly-initialized untrained policy — the
 * trained ones still drive whichever archetypes did get a file.
 */
export async function loadPolicyRegistry(baseUrl: string): Promise<PolicyRegistry | null> {
  try {
    const results = await Promise.all(ARCHETYPES.map(async (a) => {
      const res = await fetch(`${baseUrl}/${a}.json`);
      if (!res.ok) return [a, null] as const;
      return [a, await res.text()] as const;
    }));
    const registry = new PolicyRegistry();
    let any = false;
    for (const [a, json] of results) {
      if (json) {
        registry.policies[a] = deserializePolicy(json);
        any = true;
      }
    }
    return any ? registry : null;
  } catch (err) {
    console.warn('[rl] failed to load policy registry:', err);
    return null;
  }
}

/** Legacy two-policy loader — kept for the prior pred/prey single-pair training. */
export async function loadPolicies(baseUrl: string): Promise<{ predator: Policy; prey: Policy } | null> {
  try {
    const [predRes, preyRes] = await Promise.all([
      fetch(`${baseUrl}/predator.json`),
      fetch(`${baseUrl}/prey.json`),
    ]);
    if (!predRes.ok || !preyRes.ok) return null;
    const [predJson, preyJson] = await Promise.all([predRes.text(), preyRes.text()]);
    return { predator: deserializePolicy(predJson), prey: deserializePolicy(preyJson) };
  } catch (err) {
    console.warn('[rl] failed to load policies:', err);
    return null;
  }
}

/** Snapshot of the last brain decision for one agent — surfaced to the editor. */
export interface AgentDecision {
  intent: Intent;             // committed intent (post-smoothing)
  sampled: Intent;            // raw sample before smoothing (may differ)
  probs: Float32Array;        // post-softmax (with personality + temperature applied)
  rawLogits: Float32Array;    // pre-temperature, includes personality bias
  state: Float32Array;        // 7-dim input vector
  focusId: string | null;
  takenAt: number;            // driver-elapsed seconds when sampled
  /** True when smoothing overrode the sample to hold the previous intent. */
  smoothed: boolean;
  /** Tick on which this intent first committed (for the min-hold clock). */
  committedAt: number;
}

export class PolicyDriver {
  readonly cfg: PolicyDriverConfig;
  private registry: PolicyRegistry;
  private agents: PolicyAgentRef[] = [];
  private agentById = new Map<string, PolicyAgentRef>();
  private decisions = new Map<string, AgentDecision>();
  private lastHpFrac = new Map<string, number>();
  private nextDecision = new Map<string, number>();
  private elapsed = 0;
  private rng: Rng;
  private buf = new Float32Array(STATE_DIM);

  constructor(registry: PolicyRegistry, cfg?: Partial<PolicyDriverConfig>);
  constructor(predator: Policy, prey: Policy, cfg?: Partial<PolicyDriverConfig>);
  constructor(
    a: PolicyRegistry | Policy,
    b?: Policy | Partial<PolicyDriverConfig>,
    c?: Partial<PolicyDriverConfig>,
  ) {
    // Two construction shapes: legacy (predator, prey, cfg) or the new
    // PolicyRegistry path. Keep both so existing callers keep working.
    if (a instanceof PolicyRegistry) {
      this.registry = a;
      this.cfg = { ...DEFAULT_DRIVER_CONFIG, ...(b as Partial<PolicyDriverConfig> | undefined) };
    } else {
      const reg = new PolicyRegistry();
      // Predators reuse the same predator policy; grazers reuse the prey policy.
      reg.policies['wolf'] = a;
      reg.policies['cat'] = a;
      reg.policies['dog'] = a;
      reg.policies['werewolf'] = a;
      reg.policies['rabbit'] = b as Policy;
      reg.policies['cow'] = b as Policy;
      this.registry = reg;
      this.cfg = { ...DEFAULT_DRIVER_CONFIG, ...(c ?? {}) };
    }
    this.rng = new Rng(this.cfg.seed);
  }

  add(agent: PolicyAgentRef): void {
    this.agents.push(agent);
    // Stagger initial decisions so all agents don't fire on the same frame.
    this.nextDecision.set(agent.id, this.elapsed + this.rng.next() * this.cfg.decisionInterval);
  }

  /** Replace tracked agent list (useful when entities respawn / spawn in waves). */
  setAgents(agents: PolicyAgentRef[]): void {
    this.agents = agents.slice();
    this.agentById.clear();
    for (const a of this.agents) {
      this.agentById.set(a.id, a);
      if (!this.nextDecision.has(a.id)) {
        this.nextDecision.set(a.id, this.elapsed + this.rng.next() * this.cfg.decisionInterval);
      }
    }
  }

  /** Most recent intent + probability snapshot for an agent (or null). */
  getDecision(id: string): AgentDecision | null {
    return this.decisions.get(id) ?? null;
  }

  /** Look up the live adapter reference (HP, personality, etc.) by id. */
  getAgent(id: string): PolicyAgentRef | null {
    return this.agentById.get(id) ?? null;
  }

  update(dt: number): void {
    this.elapsed += dt;
    for (const a of this.agents) {
      if (!a.alive) continue;
      const due = this.nextDecision.get(a.id) ?? 0;
      if (this.elapsed < due) continue;
      this.decide(a);
      this.nextDecision.set(a.id, this.elapsed + this.cfg.decisionInterval);
    }
  }

  /** Run Tier-1 once for `a`: build state, sample, smooth, push to engine. */
  private decide(a: PolicyAgentRef): void {
    const focus = this.pickFocus(a);
    this.observe(a, focus, this.buf);
    const policy = this.registry.get(a.archetype);
    const { probs, logits } = policy.forward(this.buf, a.personalityBias, a.temperature);
    const sampled = this.rng.categorical(probs) as Intent;

    // ---- smoothing / hysteresis ----
    const prev = this.decisions.get(a.id);
    const heldIntent = prev?.intent;
    const hpFrac = a.maxHp > 0 ? a.hp / a.maxHp : 0;
    const lastHp = this.lastHpFrac.get(a.id) ?? hpFrac;
    const hpDrop = lastHp - hpFrac;
    this.lastHpFrac.set(a.id, hpFrac);
    const heldFor = prev ? this.elapsed - prev.committedAt : Infinity;
    const panic = hpDrop > this.cfg.panicHpDrop;
    let committed = sampled;
    let smoothed = false;
    if (heldIntent !== undefined && !panic) {
      const margin = probs[sampled] - probs[heldIntent];
      // Keep the previous intent if either (a) we haven't held it long enough
      // OR (b) the new sample isn't decisively better.
      if (heldFor < this.cfg.minHoldSeconds || margin < this.cfg.switchMargin) {
        committed = heldIntent;
        smoothed = sampled !== heldIntent;
      }
    }

    const committedAt = prev && prev.intent === committed ? prev.committedAt : this.elapsed;
    this.decisions.set(a.id, {
      intent: committed,
      sampled,
      probs: new Float32Array(probs),
      rawLogits: new Float32Array(logits),
      state: new Float32Array(this.buf),
      focusId: focus?.id ?? null,
      takenAt: this.elapsed,
      smoothed,
      committedAt,
    });

    const ctx: IntentContext = {
      resolveAttacker: (id) => {
        const att = this.agentById.get(id);
        return att ? { pos: att.pos } : null;
      },
    };
    a.applyIntent(committed, focus, ctx);
  }

  private pickFocus(a: PolicyAgentRef): PolicyAgentRef | null {
    let best: PolicyAgentRef | null = null;
    let bestScore = -Infinity;
    const r2 = this.cfg.visionRadius * this.cfg.visionRadius;
    for (const o of this.agents) {
      if (!o.alive || o.id === a.id) continue;
      const dx = o.pos.x - a.pos.x;
      const dz = o.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const enemy = o.team !== a.team ? 1 : 0;
      // Mirror env.pickFocus: heavy weight on low-HP enemies — a bloodied
      // werewolf draws nearby attackers into the emergent gang-up.
      const score = enemy * 10 + (1 - o.hp / o.maxHp) * 8 - Math.sqrt(d2) * 0.05;
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  private observe(a: PolicyAgentRef, focus: PolicyAgentRef | null, out: Float32Array): void {
    let allyDanger = 1.0;
    let pressure = 0;
    const r2 = this.cfg.visionRadius * this.cfg.visionRadius;
    for (const o of this.agents) {
      if (!o.alive || o.id === a.id) continue;
      const dx = o.pos.x - a.pos.x, dz = o.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      if (o.team === a.team) allyDanger = Math.min(allyDanger, o.hp / o.maxHp);
      else if (Math.sqrt(d2) < (o.size + a.size + 2)) pressure++;
    }
    const focusType = focus
      ? focus.archetype === 'wolf' ? 1
      : focus.archetype === 'rabbit' ? 2
      : focus.archetype === 'cow' ? 3
      : 0
      : 0;
    out[0] = a.hp / a.maxHp;
    out[1] = a.status / 2;
    out[2] = focusType / 3;
    out[3] = focus ? focus.hp / focus.maxHp : 0;
    out[4] = focus
      ? Math.min(1, Math.hypot(focus.pos.x - a.pos.x, focus.pos.z - a.pos.z) / this.cfg.visionRadius)
      : 1;
    out[5] = 1 - allyDanger;
    out[6] = Math.min(1, pressure / 5);
    // Final intent count sanity (not in vector, just keeps INTENT_COUNT linked).
    void INTENT_COUNT;
  }
}
