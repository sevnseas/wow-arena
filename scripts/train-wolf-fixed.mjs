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

console.log('=== FIXED HUNTING REWARD TRAINING ===\n');

const cfg = { hidden: 64, lr: 0.01, baselineEMA: 0.85, entropyCoef: 0.01 };
const rng = new Rng(444);
const wolf = new Policy4(cfg, rng);

const episodes = 800;
let kills = 0;
let batch = [];
let recentKills = [];

for (let ep = 0; ep < episodes; ep++) {
  const env = createEnv4({ bounds: 4, visionRadius: 25 }, 9000 + ep);
  
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 2.5, z: 0,
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
      
      // Rabbit action BEFORE checking if dead
      if (rabbit.alive) {
        act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);
      }
    }
    
    step4(env, 0.1);
    
    // Check for kill DURING step
    for (const ev of env.events) {
      if (ev.type === 'died' && ev.cause === 'predator') {
        killed = true;
      }
    }
    clearEcosystemEvents(env);
  }
  
  // NOW compute final reward based on result
  let reward = killed ? 50 : -0.5; // +50 for kill, -0.5 per episode wasted
  
  if (trajectory.length > 0) {
    // Apply final reward to last step
    trajectory[trajectory.length - 1].reward += reward;
    trajectory[trajectory.length - 1].episodeEnd = true;
    
    batch.push(trajectory);
    if (batch.length >= 4) {
      reinforceUpdate4(wolf, batch.flat());
      batch = [];
    }
  }
  
  if (killed) {
    kills++;
    recentKills.push(1);
  } else {
    recentKills.push(0);
  }
  if (recentKills.length > 100) recentKills.shift();
  
  const killRate = kills / (ep + 1);
  const recentRate = recentKills.reduce((a,b)=>a+b) / recentKills.length;
  
  if (ep % 100 === 0 || ep === episodes - 1) {
    console.log(`ep ${ep.toString().padStart(4)}: overall ${(killRate*100).toFixed(1).padStart(5)}% recent100 ${(recentRate*100).toFixed(1).padStart(5)}%`);
  }
}

const finalKillRate = kills / episodes;
writeFileSync(resolve(outDir, 'wolf.json'), serializePolicy4(wolf));
console.log(`\n✓ Saved wolf policy`);
console.log(`Final kill rate: ${(finalKillRate*100).toFixed(1)}%`);

if (finalKillRate >= 0.8) {
  console.log('✓ EXCELLENT: Ready for scenario');
} else if (finalKillRate >= 0.6) {
  console.log('✓ GOOD: Should hunt in scenario');
} else {
  console.log('⚠️  MARGINAL: May not hunt well');
}
