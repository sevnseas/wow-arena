import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deserializePolicy4, Policy4, reinforceUpdate4, serializePolicy4,
  createEnv4, spawnGrass, spawn4, observe4, act4, step4,
  computeReward4, clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== ECOSYSTEM BALANCE TRAINING ===\n');
console.log('Training rabbit and wolf policies for stable co-existence...\n');

const { Rng } = await import('../src/rl/rng.ts');

// Load existing wolf policy (already good at hunting)
const wolfPolicy = deserializePolicy4(
  readFileSync(resolve(policyDir, 'wolf.json'), 'utf8')
);

// Create new rabbit policy optimized for ecosystem
const rabbitRng = new Rng(5555);
const rabbitCfg = { hidden: 64, lr: 0.0015, baselineEMA: 0.98, entropyCoef: 0.01 };
const rabbitPolicy = new Policy4(rabbitCfg, rabbitRng);

console.log('Starting ecosystem balance training with 8R/2W co-evolution...\n');

let bestRabbitPolicy = null;
let bestSustainability = -Infinity;
let bestPopStability = -Infinity;

async function trainEpisode(episodeNum) {
  const env = createEnv4({ bounds: 8, visionRadius: 12 }, 100000 + episodeNum);

  // Spawn rabbits
  const rabbits = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const rabbit = spawn4(env, {
      archetype: 'rabbit', team: 'prey',
      x: Math.cos(angle) * 3.5, z: Math.sin(angle) * 3.5,
      hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
      maxAge: 90, starveRate: 0.25,
    });
    rabbit.lastHp = rabbit.hp;
    rabbits.push({ entity: rabbit, traj: [] });
  }

  // Spawn wolves
  const wolves = [];
  for (let i = 0; i < 2; i++) {
    const wolf = spawn4(env, {
      archetype: 'wolf', team: 'predator',
      x: (i === 0 ? -5 : 5), z: (i === 0 ? -5 : 5),
      hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
      maxAge: 120, starveRate: 0.2,
    });
    wolf.lastHp = wolf.hp;
    wolves.push({ entity: wolf, traj: [] });
  }

  // Spawn grass
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const r = (0.25 + (i % 3) * 0.22) * 8;
    spawnGrass(env, Math.cos(angle) * r, Math.sin(angle) * r);
  }

  const metrics = {
    rabbitBirths: 0,
    wolfBirths: 0,
    kills: 0,
    finalRabbits: 8,
    finalWolves: 2,
    sampledPopulation: [],
  };

  let time = 0;
  const decisionInterval = 0.3;
  let nextDecision = {};

  // Run 200 seconds
  while (time < 200) {
    time += 0.05;

    // Decisions
    for (const entity of env.entities) {
      if (!entity.alive) continue;
      const policy = entity.archetype === 'rabbit' ? rabbitPolicy : wolfPolicy;
      if (!policy) continue;

      const due = nextDecision[entity.id] ?? 0;
      if (time < due) continue;

      const obs = observe4(env, entity);
      const { probs, hidden } = policy.forward(obs, 1.0);

      let action = 0;
      let r = Math.random();
      for (let k = 0; k < probs.length; k++) {
        r -= probs[k];
        if (r < 0) { action = k; break; }
      }

      act4(env, entity, action, 0.05);

      // Compute reward for rabbits
      if (entity.archetype === 'rabbit') {
        const reward = computeReward4(env, entity, 'rabbit');
        const rabbit = rabbits.find(r => r.entity.id === entity.id);
        if (rabbit) {
          rabbit.traj.push({ state: obs, probs, hidden, action, reward, temperature: 1.0 });
        }
      }

      nextDecision[entity.id] = time + decisionInterval;
    }

    step4(env, 0.05);

    // Track events
    for (const ev of env.events) {
      if (ev.type === 'born' && ev.archetype === 'rabbit') metrics.rabbitBirths++;
      if (ev.type === 'born' && ev.archetype === 'wolf') metrics.wolfBirths++;
      if (ev.type === 'died' && ev.cause === 'predator') metrics.kills++;
    }
    clearEcosystemEvents(env);

    // Sample every 5 seconds
    if (time % 5 === 0) {
      const alive = env.entities.filter(e => e.alive);
      metrics.sampledPopulation.push({
        rabbits: alive.filter(e => e.archetype === 'rabbit').length,
        wolves: alive.filter(e => e.archetype === 'wolf').length,
      });
    }
  }

  // Train rabbit policy on collected trajectories
  for (const rabbit of rabbits) {
    if (rabbit.traj.length > 0) {
      rabbit.traj[rabbit.traj.length - 1].episodeEnd = true;
      reinforceUpdate4(rabbitPolicy, rabbit.traj);
    }
  }

  // Calculate sustainability score: reward stable mixed populations
  const alive = env.entities.filter(e => e.alive);
  metrics.finalRabbits = alive.filter(e => e.archetype === 'rabbit').length;
  metrics.finalWolves = alive.filter(e => e.archetype === 'wolf').length;

  // Sustainability: penalize extinction, reward reproduction
  let sustainability = metrics.rabbitBirths * 5 - metrics.kills * 2 - (metrics.finalRabbits === 0 ? 100 : 0);

  // Population stability: prefer balanced population
  let stability = 0;
  if (metrics.finalRabbits > 3 && metrics.finalWolves > 0) stability = metrics.finalRabbits + metrics.finalWolves * 10;

  return { metrics, sustainability, stability };
}

const returns = [];
const stability = [];

for (let ep = 0; ep < 300; ep++) {
  const { metrics, sustainability, stability: stabScore } = await trainEpisode(ep);
  returns.push(sustainability);
  stability.push(stabScore);

  if (ep % 30 === 0) {
    const recent = stability.slice(Math.max(0, ep - 40));
    const avgStab = recent.reduce((a,b)=>a+b) / recent.length;
    const r = metrics.finalRabbits, w = metrics.finalWolves, b = metrics.rabbitBirths, k = metrics.kills;
    console.log(`ep ${ep.toString().padStart(3)}: R${r}/${w}W | births=${b} kills=${k} | stability=${avgStab.toFixed(1)}`);
  }

  if (stabScore > bestPopStability) {
    bestPopStability = stabScore;
    bestRabbitPolicy = serializePolicy4(rabbitPolicy);
  }
}

console.log('\n=== FINAL RESULTS ===');
const lastPop = returns[returns.length - 1];
console.log(`Best population stability score: ${bestPopStability.toFixed(1)}`);

console.log('Saving ecosystem-optimized rabbit policy...');
writeFileSync(resolve(policyDir, 'rabbit.json'), bestRabbitPolicy);

const meta = {
  archetype: 'rabbit',
  trainedAt: new Date().toISOString(),
  trainingType: 'ecosystem-balance',
  episodes: 300,
  policyConfig: {
    version: 2,
    ...rabbitCfg,
  },
};
writeFileSync(resolve(policyDir, 'rabbit.meta.json'), JSON.stringify(meta, null, 2));

console.log(`✓ Rabbit policy updated for ecosystem balance`);
