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
  // Optional ecosystem params — sensible defaults below if omitted so
  // existing tests/training that don't care about lifespan still work.
  maxAge?: number;
  starveRate?: number;
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
  // ---- ecosystem (see ecosystem.md) ----
  /** Simulated seconds lived. */
  age: number;
  /** Maximum lifespan in seconds; dies of natural causes when `age > maxAge`. */
  maxAge: number;
  /** HP drained per second between meals — keeps grazers/predators on a
   *  clock. Eating offsets the drain. */
  starveRate: number;
  /** Grass nutrition (0..1 units) consumed since last reproduction. Rabbits
   *  need >= 3 to trigger Interact-reproduction. */
  grassEaten: number;
  /** Number of prey killed since last reproduction (wolves/predators). */
  preyEaten: number;
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

/**
 * RL4: Direct control + minimap observation
 *
 * Player can control any entity type with unified action space:
 * - 8 movement directions (w/a/s/d cardinal + diagonals)
 * - 3 ability slots (1/2/3)
 * Total: 11 discrete actions
 *
 * Observation is minimap-style: all visible entities with position, HP, type.
 * Policy learns target selection, positioning, and ability timing.
 */

export const enum Action {
  /** Movement: forward */
  MoveForward = 0,
  /** Movement: backward */
  MoveBackward = 1,
  /** Movement: strafe left */
  StrafeLeft = 2,
  /** Movement: strafe right */
  StrafeRight = 3,
  /** Movement: forward-left diagonal */
  MoveFwdLeft = 4,
  /** Movement: forward-right diagonal */
  MoveFwdRight = 5,
  /** Movement: backward-left diagonal */
  MoveBackLeft = 6,
  /** Movement: backward-right diagonal */
  MoveBackRight = 7,
  /** Ability 1 */
  Ability1 = 8,
  /** Ability 2 */
  Ability2 = 9,
  /** Ability 3 */
  Ability3 = 10,
  /** Short-range "interact" — reproduces with nearby same-team entity if
   *  the archetype-specific resource counter is full. See ecosystem.md. */
  Interact = 11,
}
export const ACTION_COUNT = 12;

/** Maximum entities observable in minimap state (padding for variable counts). */
export const MAX_ENTITIES_RL4 = 20;

/**
 * Per-entity minimap features:
 *   0  rel_x         — relative X position (normalized by vision radius)
 *   1  rel_z         — relative Z position (normalized by vision radius)
 *   2  vel_x         — X velocity (normalized by max speed)
 *   3  vel_z         — Z velocity (normalized by max speed)
 *   4  hp_pct        — current HP / max HP
 *   5  archetype     — categorical (0=none, 1=wolf, 2=rabbit, 3=cow, 4=cat, 5=dog, 6=werewolf)
 *   6  team          — 0=same team, 1=enemy team
 */
export const FEATURES_PER_ENTITY_RL4 = 7;

/** Total observation size: MAX_ENTITIES_RL4 * FEATURES_PER_ENTITY_RL4 */
export const STATE_DIM_RL4 = MAX_ENTITIES_RL4 * FEATURES_PER_ENTITY_RL4;
