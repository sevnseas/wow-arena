import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';
import { Rng } from '../src/rl/rng.ts';
import { actionToUnitVec } from '../src/rl/runtime4.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== MOVEMENT-ONLY WOLF TRAINING ===\n');

const cfg = { hidden: 128, lr: 0.02, baselineEMA: 0.9, entropyCoef: 0.005 };
const rng = new Rng(666);
const wolf = new Policy4(cfg, rng);

const episodes = 500;
let kills = 0;
let totalDist = 0;
let batch = [];

for (let ep = 0; ep < episodes; ep++) {
  const env = createEnv4({ bounds: 5, visionRadius: 30 }, 10000 + ep);
  
  // Rabbit at fixed location
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 2, z: 2,
    hp: 40, maxHp: 40, size: 0.28, speed: 2.6, attackCooldown: 1,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;
  rabbit.rewardThisEpisode = 0;
  
  // Wolf at origin
  const w = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: 0, z: 0,
    hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  w.lastHp = w.hp;
  w.rewardThisEpisode = 0;
  
  let trajectory = [];
  let minDist = 5;
  let killed = false;
  
  for (let step = 0; step < 600; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, w);
      const { probs, hidden } = wolf.forward(obs, 1.0);
      
      // ONLY movement actions (0-7)
      const movementProbs = Array.from(probs).slice(0, 8);
      const sum = movementProbs.reduce((a,b) => a+b);
      const normalized = movementProbs.map(p => p/sum);
      
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < 8; k++) { r -= normalized[k]; if (r < 0) { action = k; break; } }
      
      // Apply movement action directly
      const dir = actionToUnitVec(action);
      w.vx = dir.x * 4;
      w.vz = dir.z * 4;
      
      const dist = Math.hypot(rabbit.x - w.x, rabbit.z - w.z);
      minDist = Math.min(minDist, dist);
      
      trajectory.push({ state: obs, hidden, probs: new Float32Array(normalized), action, reward: 0 });
      
      // Rabbit wanders
      if (rabbit.alive) {
        const ra = Math.floor(Math.random() * 8);
        const rd = actionToUnitVec(ra);
        rabbit.vx = rd.x * 2.6;
        rabbit.vz = rd.z * 2.6;
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
  
  totalDist += minDist;
  if (killed) kills++;
  
  // Reward: closer = better
  let reward = 1 / (1 + minDist); // 1 when touching, ~0.33 at 2m, ~0.2 at 4m
  if (killed) reward += 2;
  
  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].reward += reward;
    trajectory[trajectory.length - 1].episodeEnd = true;
    
    batch.push(trajectory);
    if (batch.length >= 4) {
      reinforceUpdate4(wolf, batch.flat());
      batch = [];
    }
  }
  
  const killRate = kills / (ep + 1);
  const avgDist = totalDist / (ep + 1);
  
  if (ep % 100 === 0 || ep === episodes - 1) {
    console.log(`ep ${ep.toString().padStart(3)}: kill% ${(killRate*100).toFixed(1).padStart(5)} avg_closest ${avgDist.toFixed(2)}m`);
  }
}

const finalKillRate = kills / episodes;
writeFileSync(resolve(outDir, 'wolf.json'), serializePolicy4(wolf));
console.log(`\n✓ Saved wolf policy`);
console.log(`Kill rate: ${(finalKillRate*100).toFixed(1)}%`);
console.log(`Avg closest: ${(totalDist/episodes).toFixed(2)}m`);

if (finalKillRate >= 0.7) {
  console.log('✓ GOOD: Wolf should hunt well in scenario');
} else {
  console.log('⚠️  Wolf learning is slow');
}
