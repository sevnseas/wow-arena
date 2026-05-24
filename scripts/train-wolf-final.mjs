import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';
import { Rng } from '../src/rl/rng.ts';
import { isMovementAction, actionToUnitVec } from '../src/rl/runtime4.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== FINAL WOLF HUNTING TRAINING ===\n');
console.log('Strategy: Use RL4 environment with aggressive hunt shaping\n');

const cfg = { hidden: 256, lr: 0.02, baselineEMA: 0.85, entropyCoef: 0.002 };
const rng = new Rng(1111);
const wolf = new Policy4(cfg, rng);

let best = null;
let bestKill = 0;

// 3 stages of increasing difficulty
for (let stage = 0; stage < 3; stage++) {
  const stageEps = [400, 400, 300][stage];
  const startDist = [1.0, 1.5, 2.0][stage];
  const label = ['Close', 'Medium', 'Far'][stage];
  
  console.log(`\n--- Stage ${stage}: ${label} (${startDist}m) ---`);
  
  let kills = 0;
  let batch = [];
  
  for (let ep = 0; ep < stageEps; ep++) {
    const env = createEnv4({ bounds: 6, visionRadius: 30 }, 11000 + stage * 5000 + ep);
    
    // Rabbit fixed location
    const rabbit = spawn4(env, {
      archetype: 'rabbit', team: 'prey',
      x: startDist, z: startDist,
      hp: 50, maxHp: 50, size: 0.28, speed: 2.6, attackCooldown: 1,
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
    let maxDist = 0;
    
    for (let step = 0; step < 700; step++) {
      if (step % 5 === 0) {
        const obs = observe4(env, w);
        const { probs, hidden } = wolf.forward(obs, 1.0);
        
        let action = 0;
        let r = Math.random();
        for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
        
        act4(env, w, action, 0.1);
        
        // Calculate immediate reward
        let reward = 0;
        const dx = rabbit.x - w.x;
        const dz = rabbit.z - w.z;
        const dist = Math.hypot(dx, dz);
        
        if (rabbit.alive) {
          // Strong shaping toward prey
          maxDist = Math.max(maxDist, dist);
          const minThere = Math.min(1, maxDist);
          reward += Math.max(0, minThere - dist) * 0.3; // Reward for getting closer
          
          // Extra bonus for being close
          if (dist < 0.5) reward += 0.5;
          if (dist < 0.2) reward += 2.0;
        }
        
        trajectory.push({ state: obs, hidden, probs, action, reward });
        
        // Rabbit wanders
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
      // Bonus for kill
      if (trajectory.length > 0) {
        trajectory[trajectory.length - 1].reward += 100;
      }
    }
    
    if (trajectory.length > 0) {
      trajectory[trajectory.length - 1].episodeEnd = true;
      batch.push(trajectory);
      if (batch.length >= 8) {
        reinforceUpdate4(wolf, batch.flat());
        batch = [];
      }
    }
    
    const killRate = kills / (ep + 1);
    if (ep % (stageEps/4) === 0 || ep === stageEps - 1) {
      console.log(`  ep ${ep.toString().padStart(3)}: ${(killRate*100).toFixed(1)}%`);
    }
  }
  
  const stageKill = kills / stageEps;
  console.log(`Stage result: ${(stageKill*100).toFixed(1)}% kill rate`);
  
  if (stageKill > bestKill) {
    bestKill = stageKill;
    best = serializePolicy4(wolf);
  }
}

if (best) {
  writeFileSync(resolve(outDir, 'wolf.json'), best);
  console.log(`\n✓ Saved wolf policy`);
  console.log(`Best kill rate: ${(bestKill*100).toFixed(1)}%`);
  console.log(bestKill >= 0.5 ? '✓ Ready for scenario' : '⚠️  Marginal performance');
}
