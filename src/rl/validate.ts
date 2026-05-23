/**
 * Three-step validation suite from entity-policies.md §4.
 *
 * Each check is a scripted scenario that exercises the brain/engine split
 * with hand-set policies (or trained ones) so we can confirm the high-level
 * intentions are wired correctly to the algorithmic engine.
 */

import { RLEnv } from './env';
import { engineTick } from './engine';
import { Policy } from './policy';
import { Intent, STATE_DIM, type Entity } from './types';

export interface KitingResult {
  survivedTicks: number;
  finalDistanceToNearestWolf: number;
  fledDistance: number;
}

/** "Kiting" check — a wounded werewolf set to Flee must out-pace the pack. */
export function kitingCheck(seed = 1): KitingResult {
  const env = new RLEnv({ bounds: 40, decisionInterval: 1 }, seed);
  // Pack clustered on one side so the focus is unambiguous and the kiting
  // direction is well-defined (otherwise a symmetric encirclement makes the
  // closest-enemy focus flip each tick and the engine just oscillates).
  const ww = env.spawn({
    archetype: 'wolf', team: 'prey', x: 0, z: 0, hp: 200, maxHp: 200,
    size: 0.7, speed: 6.5, attackCooldown: 1.0,
  });
  for (let i = 0; i < 4; i++) {
    env.spawn({
      archetype: 'wolf', team: 'predator',
      x: 8 + (i - 1.5) * 1.5, z: 2 + (i % 2) * 1.5, hp: 60, maxHp: 60,
      size: 0.55, speed: 4.0, attackCooldown: 1.2,
    });
  }
  ww.currentIntent = Intent.Flee;
  for (const e of env.entities) if (e.team === 'predator') e.currentIntent = Intent.Attack;
  const startX = ww.x, startZ = ww.z;
  let survivedTicks = 0;
  for (let t = 0; t < 800 && ww.alive; t++) {
    // Re-focus each tick so engine knows what to flee/chase.
    for (const e of env.entities) env.observe(e, new Float32Array(STATE_DIM));
    for (const e of env.entities) if (e.alive) engineTick(env, e, env.config.dt);
    env.tick++;
    survivedTicks = t;
  }
  let nearest = Infinity;
  for (const e of env.entities) {
    if (e.team !== 'predator') continue;
    const d = Math.hypot(e.x - ww.x, e.z - ww.z);
    nearest = Math.min(nearest, d);
  }
  return { survivedTicks, finalDistanceToNearestWolf: nearest, fledDistance: Math.hypot(ww.x - startX, ww.z - startZ) };
}

/** "Target Lock" check — a single wolf must close on a moving rabbit. */
export function targetLockCheck(seed = 2): { hits: number; killed: boolean } {
  const env = new RLEnv({ bounds: 30, decisionInterval: 1 }, seed);
  const wolf = env.spawn({
    archetype: 'wolf', team: 'predator', x: 0, z: 0,
    hp: 60, maxHp: 60, size: 0.55, speed: 4.0, attackCooldown: 1.0,
  });
  const rabbit = env.spawn({
    archetype: 'rabbit', team: 'prey', x: 6, z: 0,
    hp: 30, maxHp: 30, size: 0.28, speed: 3.5, attackCooldown: 999,
  });
  wolf.currentIntent = Intent.Attack;
  rabbit.currentIntent = Intent.Flee;
  let hits = 0;
  for (let t = 0; t < 400 && rabbit.alive; t++) {
    env.events.length = 0;
    for (const e of env.entities) env.observe(e, new Float32Array(STATE_DIM));
    for (const e of env.entities) if (e.alive) engineTick(env, e, env.config.dt);
    for (const ev of env.events) if (ev.attackerId === wolf.id) hits++;
    env.tick++;
  }
  return { hits, killed: !rabbit.alive };
}

/**
 * "Gang-up" check — a wounded werewolf surrounded by 4 wolves should be
 * attacked by most of them most of the time. Returns the fraction of wolf
 * decisions that picked Intent.Attack on the werewolf focus.
 */
export function gangUpCheck(wolfPolicy: Policy, seed = 9): { attackRate: number; bossKilled: boolean } {
  const env = new RLEnv({ bounds: 25, decisionInterval: 5 }, seed);
  const boss = env.spawn({
    archetype: 'werewolf', team: 'predator', x: 0, z: 0,
    hp: 60, maxHp: 220, size: 0.95, speed: 4.8, attackCooldown: 0.8,
  });
  const wolves: Entity[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    wolves.push(env.spawn({
      archetype: 'wolf', team: 'predator',
      x: Math.cos(a) * 5, z: Math.sin(a) * 5,
      hp: 70, maxHp: 70, size: 0.6, speed: 5.5, attackCooldown: 1.0,
      temperature: 0.5,
    }));
  }
  let attackOnBoss = 0;
  let totalDecisions = 0;
  for (let t = 0; t < 400 && boss.alive; t++) {
    if (env.isDecisionTick()) {
      for (const w of wolves) {
        if (!w.alive) continue;
        const s = new Float32Array(STATE_DIM);
        const focus = env.observe(w, s);
        const { probs } = wolfPolicy.forward(s, w.personalityBias, w.temperature);
        const action = env.rng.categorical(probs);
        w.currentIntent = action as Intent;
        totalDecisions++;
        if (action === Intent.Attack && focus && focus.id === boss.id) attackOnBoss++;
      }
      // Boss greedily attacks the nearest wolf — its hand-coded behavior.
      if (boss.alive) boss.currentIntent = Intent.Attack;
      env.observe(boss, new Float32Array(STATE_DIM));
    }
    env.events.length = 0;
    for (const e of env.entities) if (e.alive) engineTick(env, e, env.config.dt);
    env.tick++;
  }
  return {
    attackRate: totalDecisions === 0 ? 0 : attackOnBoss / totalDecisions,
    bossKilled: !boss.alive,
  };
}

/** "Stochastic Variance" check — 3 wolves, same weights, different temperatures. */
export function stochasticVarianceCheck(policy: Policy, seed = 3): {
  intents: number[][];
  uniqueIntentSequences: number;
} {
  const env = new RLEnv({ bounds: 25, decisionInterval: 1 }, seed);
  const temps = [0.3, 1.0, 2.5];
  const wolves: Entity[] = [];
  for (let i = 0; i < 3; i++) {
    wolves.push(env.spawn({
      archetype: 'wolf', team: 'predator',
      x: -4 + i * 4, z: -10,
      hp: 60, maxHp: 60, size: 0.55, speed: 4.0, attackCooldown: 1.2,
      temperature: temps[i],
    }));
  }
  env.spawn({
    archetype: 'rabbit', team: 'prey', x: 0, z: 0,
    hp: 30, maxHp: 30, size: 0.28, speed: 3.5, attackCooldown: 999,
  });
  const intents: number[][] = wolves.map(() => []);
  for (let t = 0; t < 60; t++) {
    for (let i = 0; i < wolves.length; i++) {
      const s = new Float32Array(STATE_DIM);
      env.observe(wolves[i], s);
      const { probs } = policy.forward(s, wolves[i].personalityBias, wolves[i].temperature);
      const action = env.rng.categorical(probs);
      wolves[i].currentIntent = action as Intent;
      intents[i].push(action);
    }
    for (const e of env.entities) if (e.alive) engineTick(env, e, env.config.dt);
    env.tick++;
  }
  const seq = new Set(intents.map(s => s.join(',')));
  return { intents, uniqueIntentSequences: seq.size };
}
