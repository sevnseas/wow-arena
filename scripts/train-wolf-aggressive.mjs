import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  computeReward4, clearEcosystemEvents,
} from '../src/rl/index.ts';
import { Rng } from '../src/rl/rng.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== AGGRESSIVE WOLF HUNTING TRAINING ===\n');

// Higher learning rate, more aggression
const cfg = { hidden: 128, lr: 0.01, baselineEMA: 0.9, entropyCoef: 0.005 };
const rng = new Rng(777);
const wolf = new Policy4(cfg, rng);

const bounds = 4;
const episodes = 500;
let bestScore = -Infinity;
let bestPolicy = null;

let kills = 0;
let totalReward = 0;
let batch = [];
let recentKills = [];

for (let ep = 0; ep < episodes; ep++) {
  const env = createEnv4({ bounds, visionRadius: 25 }, 7000 + ep);
  
  // Random spawn positions but always visible
  const rabbitDist = 1.5 + Math.random() * 0.5;
  const angle = Math.random() * Math.PI * 2;
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: Math.cos(angle) * rabbitDist,
    z: Math.sin(angle) * rabbitDist,
    hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
    maxAge: 120, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;
  rabbit.rewardThisEpisode = 0;
  
  const wolf_entity = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: 0, z: 0,
    hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 120, starveRate: 0,
  });
  wolf_entity.lastHp = wolf_entity.hp;
  wolf_entity.rewardThisEpisode = 0;
  
  let trajectory = [];
  let killed = false;
  let epReturn = 0;
  
  // Shorter episodes to focus on immediate hunting
  for (let step = 0; step < 400; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, wolf_entity);
      const { probs, hidden } = wolf.forward(obs, 1.0);
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
      
      act4(env, wolf_entity, action, 0.1);
      let reward = computeReward4(env, wolf_entity, 'wolf');
      
      // Bonus reward for closing distance to prey (shape the hunt)
      if (step > 0) {
        const dx = rabbit.x - wolf_entity.x;
        const dz = rabbit.z - wolf_entity.z;
        const dist = Math.hypot(dx, dz);
        reward += (0.5 - Math.min(0.5, dist / 3)) * 0.5; // Closer = more reward
      }
      
      epReturn += reward;
      trajectory.push({ state: obs, hidden, probs, action, reward });
      
      // Rabbit random wander
      if (rabbit.alive) {
        act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);
      }
    }
    
    step4(env, 0.1);
    
    for (const ev of env.events) {
      if (ev.type === 'died' && ev.cause === 'predator') {
        killed = true;
      }
    }
    clearEcosystemEvents(env);
  }
  
  if (killed) {
    kills++;
    recentKills.push(1);
  } else {
    recentKills.push(0);
  }
  if (recentKills.length > 50) recentKills.shift();
  
  totalReward += epReturn;
  
  // Train
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
  
  if (ep % 50 === 0) {
    console.log(`ep ${ep.toString().padStart(3)}: kill% ${(killRate*100).toFixed(1).padStart(5)} recent% ${(recentRate*100).toFixed(1).padStart(5)} avg_rew ${(totalReward/(ep+1)).toFixed(1)}`);
  }
  
  const score = totalReward / (ep + 1);
  if (score > bestScore) {
    bestScore = score;
    bestPolicy = serializePolicy4(wolf);
  }
}

const finalKillRate = kills / episodes;
console.log(`\nFinal: ${(finalKillRate*100).toFixed(1)}% kill rate over ${episodes} episodes`);
console.log(`Best score: ${bestScore.toFixed(1)}`);

if (bestPolicy) {
  writeFileSync(resolve(outDir, 'wolf.json'), bestPolicy);
  console.log(`✓ Saved wolf policy (${(finalKillRate*100).toFixed(1)}% kill rate)`);
  
  if (finalKillRate > 0.7) {
    console.log('✓ GOOD: Wolf should hunt effectively in scenario now');
  } else if (finalKillRate > 0.5) {
    console.log('~ OKAY: Wolf will hunt but not perfectly');
  } else {
    console.log('✗ POOR: Wolf still not trained well enough');
  }
}
