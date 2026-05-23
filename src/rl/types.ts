/**
 * RL environment types — kept dependency-free and Three.js-free so the
 * environment can run headlessly under `node` for training.
 *
 * The architecture mirrors `entity-policies.md`:
 *   Tier 1 (brain)     — picks an Intention (5 discrete actions).
 *   Tier 2 (engine)    — executes the intention algorithmically (steering,
 *                        attack timing, flee vectors). The brain never sees
 *                        spatial rays.
 */

export type Archetype = 'wolf' | 'rabbit' | 'cow' | 'cat' | 'dog' | 'werewolf';
export type Team = 'predator' | 'prey';

/** Archetypes the shared MLPs are trained on. Each gets its own weight set. */
export const ARCHETYPES: Archetype[] = ['wolf', 'rabbit', 'cow', 'cat', 'dog', 'werewolf'];

/** Predators hunt + can Hide-to-Heal; grazers can Graze-to-Heal-and-Buff. */
export function isPredator(a: Archetype): boolean {
  return a === 'wolf' || a === 'cat' || a === 'dog' || a === 'werewolf';
}
export function isGrazer(a: Archetype): boolean {
  return a === 'rabbit' || a === 'cow';
}

/** Discrete intention space shared by every archetype. */
export const enum Intent {
  Idle = 0,
  Attack = 1,
  CC = 2,
  Heal = 3,
  Flee = 4,
}
export const INTENT_COUNT = 5;

/**
 * Feature vector fed to the neural brain (Tier 1). Indices:
 *   0  self_hp_pct          — current HP fraction
 *   1  self_status           — 0 normal / 0.5 stunned / 1 blinded
 *   2  focused_entity_type   — categorical / 3 (0=none, 1=wolf, 2=rabbit, 3=cow…)
 *   3  focused_entity_hp     — fraction
 *   4  focused_entity_dist   — normalised by visionRadius
 *   5  ally_danger_max       — 1 - min(allyHpFrac), i.e. how hurt the worst ally is
 *   6  enemy_pressure_count  — # hostiles currently focusing me / 5
 *   7  herd_panic            — magnitude of nearby ally-damage signal (rl2 §1A)
 *   8  pack_readiness        — # same-team allies also targeting our focus / 4
 *   9  target_unawareness    — 1 if focus is fleeing / hidden / facing away
 *   10 resource_density      — nearby grass nutrition (grazers care most)
 *   11 energy_reserve        — HP-as-proxy for hunger/stamina (rl2 §1B)
 */
export const STATE_DIM = 12;

export interface EntityInit {
  archetype: Archetype;
  team: Team;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  /** Scales damage dealt and combat reach (per entity-policies.md note). */
  size: number;
  speed: number;
  attackCooldown: number;
  /** Optional per-individual personality logits added to brain output. */
  personalityBias?: Float32Array;
  /** Higher temperature → more stochastic / erratic action sampling. */
  temperature?: number;
}

export interface Entity {
  id: number;
  archetype: Archetype;
  team: Team;
  x: number;
  z: number;
  vx: number;
  vz: number;
  hp: number;
  maxHp: number;
  size: number;
  speed: number;
  attackCooldown: number;
  /** Per-tick countdown until next attack is allowed. */
  attackTimer: number;
  /** 0 = normal, 1 = stunned, 2 = blinded (kept for state contract). */
  status: 0 | 1 | 2;
  statusTimer: number;
  /** Tick on which this entity was hit last (used for "under pressure" feats). */
  lastHitTick: number;
  attackerId: number | null;
  /** Personality offset added to logits each decision. */
  personalityBias: Float32Array;
  temperature: number;
  /** Current intention chosen by Tier 1 (held until next decision tick). */
  currentIntent: Intent;
  focusedId: number | null;
  /** Accumulated reward this episode (for training). */
  rewardThisEpisode: number;
  alive: boolean;
  /** Multiplier on outgoing damage; grows with grazing. */
  damageBuff: number;
  /** True while in hide-and-heal (predators) — drops aggro / focus visibility. */
  hidden: boolean;
  /** Stat-tracking for trainer / reward shaping. */
  healedThisDecision: number;
  killsThisEpisode: number;
}

export interface EnvConfig {
  bounds: number;
  /** Decisions are taken every `decisionInterval` ticks; engine runs every tick. */
  decisionInterval: number;
  /** Seconds of simulated time per tick. */
  dt: number;
  /** Base damage; final damage = base * attacker.size * (1+damageBuff). */
  baseDamage: number;
  /** Contact range = attacker.size + target.size + buffer. */
  contactBuffer: number;
  /** Vision radius used to build the focused-entity state vector. */
  visionRadius: number;
  /** HP per second when standing on a grass patch (grazers). */
  grazeHealRate: number;
  /** Damage-buff per second of grazing, capped at grazeBuffCap. */
  grazeBuffRate: number;
  grazeBuffCap: number;
  /** HP per second while hidden (predators). */
  hideHealRate: number;
  /** Grass patch radius for contact-detection / re-grow time / nutrition. */
  grassRadius: number;
  grassRegrow: number;
  grassNutrition: number;
}

export const DEFAULT_ENV_CONFIG: EnvConfig = {
  bounds: 25,
  decisionInterval: 5, // 5 ticks at dt=0.1 → 1 decision / 0.5s sim time
  dt: 0.1,
  baseDamage: 6,
  contactBuffer: 0.2,
  visionRadius: 18,
  grazeHealRate: 8,
  grazeBuffRate: 0.2,
  grazeBuffCap: 1.5,
  hideHealRate: 6,
  grassRadius: 1.5,
  grassRegrow: 8,
  grassNutrition: 12,
};

export interface GrassPatch {
  x: number;
  z: number;
  /** Remaining nutrition before exhaustion. */
  nutrition: number;
  /** Counter for regrowth once depleted. */
  regrowTimer: number;
}
