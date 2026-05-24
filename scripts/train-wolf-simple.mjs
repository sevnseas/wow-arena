import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';
import { Rng } from '../src/rl/rng.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== SIMPLE HUNTING REWARD TRAINING ===\n');

const cfg = { hidden: 64, lr: 0.005, baselineEMA: 0.9, entropyCoef: 0.01 };
const rng = new Rng(333);
const wolf = new Policy4(cfg, rng);

const episodes = 1000;
let kills = 0;
let batch = [];
let recentKills = [];

for (let ep = 0; ep < episodes; ep++) {
  const env = createEnv4({ bounds: 4, visionRadius: 25 }, 8000 + ep);
  
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 2, z: 2, // Fixed spawn
    hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;
  rabbit.rewardThisEpisode = 0;
  
  const w = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: 0, z: 0,
    hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  w.lastHp = w.hp;
  w.rewardThisEpisode = 0;
  
  let trajectory = [];
  let killed = false;
  
  for (let step = 0; step < 500; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, w);
      const { probs, hidden } = wolf.forward(obs, 1.0);
      
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
      
      act4(env, w, action, 0.1);
      
      // SIMPLE REWARD: kill = +100, each step alive = +0.1, no kill = nothing
      let reward = 0.1;
      
      trajectory.push({ state: obs, hidden, probs, action, reward });
      
      // Rabbit wanders
      if (rabbit.alive) {
        act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);
      } else {
        reward += 100; // KILL BONUS
        killed = true;
      }
    }
    
    step4(env, 0.1);
    clearEcosystemEvents(env);
  }
  
  if (killed) {
    kills++;
    recentKills.push(1);
  } else {
    recentKills.push(0);
  }
  if (recentKills.length > 100) recentKills.shift();
  
  // Train every episode
  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].episodeEnd = true;
    batch.push(trajectory);
    if (batch.length >= 4) {
      reinforceUpdate4(wolf, batch.flat());
      batch = [];
    }
  }
  
  const killRate = kills / (ep + 1);
  const recentRate = recentKills.reduce((a,b)=>a+b) / recentKills.length;
  
  if (ep % 100 === 0 || ep === episodes - 1) {
    console.log(`ep ${ep.toString().padStart(4)}: overall kill% ${(killRate*100).toFixed(1).padStart(5)} recent100 ${(recentRate*100).toFixed(1).padStart(5)}`);
  }
}

const finalKillRate = kills / episodes;
writeFileSync(resolve(outDir, 'wolf.json'), serializePolicy4(wolf));
console.log(`\n✓ Final kill rate: ${(finalKillRate*100).toFixed(1)}%`);

if (finalKillRate >= 0.9) {
  console.log('✓ EXCELLENT: Wolf is well-trained');
} else if (finalKillRate >= 0.7) {
  console.log('✓ GOOD: Wolf hunts consistently');
} else if (finalKillRate >= 0.5) {
  console.log('~ OKAY: Wolf hunts sometimes');
} else {
  console.log('✗ POOR: Wolf still not learning');
}
