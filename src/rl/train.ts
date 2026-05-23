/**
 * Multi-agent, multi-archetype REINFORCE trainer.
 *
 * Each rollout spawns a balanced ecosystem (grazers + cats + dogs + wolves
 * + one werewolf boss) on grass patches and lets every archetype's shared
 * policy take its own intentions. Trajectories are batched per-archetype
 * and the policy for each is updated independently at episode end.
 *
 * Reward shaping is per-archetype — see `shapedReward` — and is designed
 * to surface the emergent behaviors called for in the goal:
 *   • grazers: heal + buff by standing on grass; survive
 *   • cats:    eat rabbits, avoid wolves
 *   • dogs:    defend prey from predators
 *   • wolves:  hunt prey, but learn to disengage + Hide when wounded
 *   • werewolf: be a boss; threat scales with damageBuff
 *   • the per-focus low-HP bias in env.pickFocus encourages the gang-up
 */

import { RLEnv } from './env';
import { engineTick } from './engine';
import { Policy, reinforceUpdate, type Step } from './policy';
import { PolicyRegistry } from './registry';
import {
  ARCHETYPES, Intent, STATE_DIM, type Archetype, type Entity, isGrazer, isPredator,
} from './types';

export interface TrainConfig {
  episodes: number;
  maxTicks: number;
  rabbits: number;
  cows: number;
  cats: number;
  dogs: number;
  wolves: number;
  werewolves: number;
  grassPatches: number;
  seed: number;
  logEvery: number;
  log?: (msg: string) => void;
}

export const DEFAULT_TRAIN_CONFIG: TrainConfig = {
  episodes: 400,
  maxTicks: 900,
  rabbits: 6,
  cows: 3,
  cats: 2,
  dogs: 2,
  wolves: 4,
  werewolves: 1,
  grassPatches: 12,
  seed: 42,
  logEvery: 25,
};

export interface TrainResult {
  registry: PolicyRegistry;
  history: { ep: number; perArchetype: Record<Archetype, number>; werewolfKilled: boolean }[];
}

interface AgentTrack {
  entity: Entity;
  steps: Step[];
  lastHp: number;
  policy: Policy;
}

/** Per-archetype reward signal computed every decision interval. */
function shapedReward(track: AgentTrack, env: RLEnv): number {
  const e = track.entity;
  let r = 0;
  let damageDealt = 0;
  let killBonus = 0;
  let attackedHerdAttacker = false; // for cow team-credit
  for (const ev of env.events) {
    if (ev.attackerId === e.id) {
      damageDealt += ev.amount;
      if (ev.killed) {
        const victim = env.entities[ev.victimId];
        const tough = victim ? victim.maxHp / 30 : 1;
        killBonus += 6 + tough * 4;
      }
      // rl2 §1A: cow defending the herd — extra credit when the wolf we hit
      // had recently chewed on an ally.
      const victim = env.entities[ev.victimId];
      if (victim && victim.team !== e.team) {
        for (const ally of env.entities) {
          if (ally.alive && ally.team === e.team && ally.id !== e.id
              && ally.attackerId === victim.id
              && (env.tick - ally.lastHitTick) * env.config.dt < 3.0) {
            attackedHerdAttacker = true;
            break;
          }
        }
      }
    }
  }
  const damageTaken = Math.max(0, track.lastHp - e.hp);
  const healed = e.healedThisDecision;
  e.healedThisDecision = 0;
  track.lastHp = e.hp;

  switch (e.archetype) {
    case 'rabbit':
    case 'cow': {
      r += 0.25;
      r += healed * 0.25;
      r += e.damageBuff * 0.05;
      r -= damageTaken * 0.18;
      if (!e.alive) r -= 8;
      // Cows: shared team-credit + defender bonus (rl2 §1A).
      if (e.archetype === 'cow') {
        if (attackedHerdAttacker) r += damageDealt * 0.7 + 5.0;
        // Exploration signal: the herd is under attack and this cow picks
        // Attack — pay it even before contact, so the policy can climb out
        // of the "flee is safest" local minimum and discover defending pays.
        const herdPanic = computeHerdPanic(env, e);
        if (herdPanic > 0.1) {
          if (e.currentIntent === Intent.Attack) r += 2.0 * herdPanic;
          // Penalise fleeing while the herd is under attack — the policy
          // has to physically choose between solidarity and self-preservation.
          if (e.currentIntent === Intent.Flee) r -= 1.0 * herdPanic;
        }
        if (!e.alive) r += 5; // unwind a chunk of the -8 prey death penalty
      }
      break;
    }
    case 'cat': {
      r += damageDealt * 0.08 + killBonus;
      r -= damageTaken * 0.15;
      r += healed * 0.05;
      if (!e.alive) r -= 6;
      break;
    }
    case 'dog': {
      r += damageDealt * 0.12 + killBonus * 0.8;
      r += 0.05;
      r -= damageTaken * 0.12;
      if (!e.alive) r -= 6;
      break;
    }
    case 'wolf': {
      // rl2 §1C: stalking pack — coordination matters.
      const focus = e.focusedId !== null ? env.entities[e.focusedId] : null;
      let packCount = 0;
      if (focus) {
        for (const o of env.entities) {
          if (!o.alive || o.id === e.id) continue;
          if (o.team === e.team && o.focusedId === focus.id) packCount++;
        }
      }
      const synced = packCount >= 1; // at least one ally also on the same target
      if (damageDealt > 0) {
        if (synced) {
          r += damageDealt * 0.25 + killBonus * 1.5; // big bonus for joint strike
        } else {
          r += damageDealt * 0.02 + killBonus * 0.3; // soloing barely pays
          r -= 1.5;                                  // explicit coordination penalty
        }
      }
      // Direct shaping: encourage selecting Attack only when pack_readiness > 0.
      // This adds a tiny per-decision signal that pushes the brain to read
      // feature index 8 (pack_readiness) and condition on it.
      if (e.currentIntent === Intent.Attack && focus) {
        if (packCount === 0) r -= 0.3;
        else r += 0.1 * packCount;
      }
      r += healed * 0.08;
      r -= damageTaken * 0.05;
      if (!e.alive) r -= 5;
      break;
    }
    case 'werewolf': {
      r += damageDealt * 0.15 + killBonus * 1.5;
      r -= damageTaken * 0.03;
      if (!e.alive) r -= 15;
      break;
    }
  }
  return r;
}

/** Recompute the herd-panic signal: weighted by recency × proximity. */
function computeHerdPanic(env: RLEnv, e: Entity): number {
  let sum = 0;
  const r = env.config.visionRadius;
  for (const o of env.entities) {
    if (!o.alive || o.id === e.id || o.team !== e.team) continue;
    const sinceHit = (env.tick - o.lastHitTick) * env.config.dt;
    if (sinceHit > 2.0) continue;
    const recency = 1 - sinceHit / 2.0;
    const d = Math.hypot(o.x - e.x, o.z - e.z);
    if (d > r) continue;
    sum += recency * (1 - d / r);
  }
  return Math.min(1, sum);
}

/** rl2 §1A: shared team credit — after per-step rewards are computed, blend
 *  each grazer's reward with the herd average so individual survival is
 *  coupled to herd survival. Drives defensive swarming. */
function applyTeamCredit(tracks: AgentTrack[]): void {
  for (const archetype of ['cow'] as const) {
    const herd = tracks.filter(t => t.entity.archetype === archetype && t.steps.length > 0);
    if (herd.length < 2) continue;
    // Compute average of each cow's most recent step reward.
    let sum = 0;
    for (const t of herd) sum += t.steps[t.steps.length - 1].reward;
    const avg = sum / herd.length;
    for (const t of herd) {
      const last = t.steps[t.steps.length - 1];
      last.reward = 0.5 * last.reward + 0.5 * avg;
    }
  }
}

function randomPersonality(): Float32Array {
  const b = new Float32Array(5);
  for (let i = 0; i < 5; i++) b[i] = (Math.random() - 0.5) * 0.5;
  return b;
}

function setupEpisode(env: RLEnv, cfg: TrainConfig): void {
  env.seedGrass(cfg.grassPatches);

  const spawn = (a: Archetype, n: number, base: Partial<{ hp: number; size: number; speed: number; cd: number }>) => {
    for (let i = 0; i < n; i++) {
      env.spawn({
        archetype: a,
        team: isPredator(a) ? 'predator' : 'prey',
        x: env.rng.range(-env.config.bounds * 0.8, env.config.bounds * 0.8),
        z: env.rng.range(-env.config.bounds * 0.8, env.config.bounds * 0.8),
        hp: base.hp ?? 30, maxHp: base.hp ?? 30,
        size: base.size ?? 0.4,
        speed: base.speed ?? 3.5,
        attackCooldown: base.cd ?? 1.0,
        personalityBias: randomPersonality(),
        temperature: 0.7 + Math.random() * 0.7,
      });
    }
  };

  spawn('rabbit',    cfg.rabbits,    { hp: 16, size: 0.28, speed: 4.0, cd: 999 });
  spawn('cow',       cfg.cows,       { hp: 60, size: 0.7,  speed: 2.0, cd: 999 });
  spawn('cat',       cfg.cats,       { hp: 28, size: 0.38, speed: 4.6, cd: 1.0 });
  spawn('dog',       cfg.dogs,       { hp: 45, size: 0.45, speed: 4.4, cd: 1.0 });
  spawn('wolf',      cfg.wolves,     { hp: 70, size: 0.6,  speed: 5.5, cd: 1.0 });
  spawn('werewolf',  cfg.werewolves, { hp: 220,size: 0.95, speed: 4.8, cd: 0.8 });
}

export function runEpisode(
  registry: PolicyRegistry,
  cfg: TrainConfig,
  seed: number,
): { tracks: AgentTrack[]; werewolfKilled: boolean } {
  const env = new RLEnv({}, seed);
  setupEpisode(env, cfg);
  const tracks: AgentTrack[] = env.entities.map(e => ({
    entity: e,
    steps: [],
    lastHp: e.hp,
    policy: registry.get(e.archetype),
  }));

  const obsBuf = new Float32Array(STATE_DIM);
  let werewolfKilled = false;

  for (let t = 0; t < cfg.maxTicks; t++) {
    if (env.isDecisionTick()) {
      // Close out reward for prior decision, then pick a new intention.
      for (const tr of tracks) {
        if (!tr.entity.alive) continue;
        if (tr.steps.length > 0) {
          tr.steps[tr.steps.length - 1].reward += shapedReward(tr, env);
        }
        env.observe(tr.entity, obsBuf, 0);
        const stateCopy = new Float32Array(obsBuf);
        const fwd = tr.policy.forward(stateCopy, tr.entity.personalityBias, tr.entity.temperature);
        const action = env.rng.categorical(fwd.probs);
        tr.entity.currentIntent = action as Intent;
        tr.steps.push({
          state: stateCopy,
          hidden: fwd.hidden,
          probs: fwd.probs,
          action,
          reward: 0,
          temperature: tr.entity.temperature,
        });
      }
    } else {
      for (const tr of tracks) {
        if (!tr.entity.alive || tr.steps.length === 0) continue;
        tr.steps[tr.steps.length - 1].reward += shapedReward(tr, env);
      }
    }
    if (env.isDecisionTick()) applyTeamCredit(tracks);

    env.events.length = 0;
    for (const e of env.entities) {
      if (!e.alive) continue;
      engineTick(env, e, env.config.dt);
    }
    env.tickGrass(env.config.dt);
    env.tick++;

    // Stop early if no prey remains AND no boss remains — pointless to continue.
    const anyPrey = env.entities.some(e => e.team === 'prey' && e.alive);
    const anyBoss = env.entities.some(e => e.archetype === 'werewolf' && e.alive);
    if (!anyPrey && !anyBoss) break;
  }

  werewolfKilled = env.entities.some(e => e.archetype === 'werewolf' && !e.alive);
  return { tracks, werewolfKilled };
}

export function train(cfg: Partial<TrainConfig> = {}): TrainResult {
  const fullCfg: TrainConfig = { ...DEFAULT_TRAIN_CONFIG, ...cfg };
  const log = fullCfg.log ?? ((m) => console.log(m));
  const registry = new PolicyRegistry();
  const history: TrainResult['history'] = [];

  for (let ep = 0; ep < fullCfg.episodes; ep++) {
    const { tracks, werewolfKilled } = runEpisode(registry, fullCfg, fullCfg.seed + ep);
    const batches: Record<Archetype, Step[]> = {} as any;
    const rewards: Record<Archetype, number> = {} as any;
    for (const a of ARCHETYPES) { batches[a] = []; rewards[a] = 0; }
    for (const tr of tracks) {
      const a = tr.entity.archetype;
      batches[a].push(...tr.steps);
      for (const s of tr.steps) rewards[a] += s.reward;
    }
    for (const a of ARCHETYPES) {
      if (batches[a].length > 0) reinforceUpdate(registry.get(a), batches[a]);
    }
    history.push({ ep, perArchetype: rewards, werewolfKilled });
    if (ep % fullCfg.logEvery === 0 || ep === fullCfg.episodes - 1) {
      const summary = ARCHETYPES.map(a => `${a[0]}${a[1]}=${rewards[a].toFixed(1)}`).join(' ');
      log(`ep ${ep.toString().padStart(4)} | ${summary} | ww-killed=${werewolfKilled}`);
    }
  }

  return { registry, history };
}

// Silence unused-import warnings for the helpers used only by callers.
export { isGrazer, isPredator };
