import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  computeReward4, clearEcosystemEvents,
} from '../src/rl/index.ts';
import { Rng } from '../src/rl/rng.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== WOLF HUNTING FOCUSED TRAINING ===\n');

const cfg = { hidden: 64, lr: 0.004, baselineEMA: 0.95, entropyCoef: 0.01 };
const rng = new Rng(999);
const wolf = new Policy4(cfg, rng);

let bestScore = -Infinity;
let bestPolicy = null;

for (let stage = 0; stage < 3; stage++) {
  const stageLabel = stage === 0 ? 'Close' : stage === 1 ? 'Medium' : 'Open';
  const startDist = stage === 0 ? 1.0 : stage === 1 ? 1.5 : 2.0;
  const bounds = stage === 0 ? 3 : stage === 1 ? 5 : 8;
  const episodes = 300;
  
  console.log(`\n--- Stage ${stage}: ${stageLabel} (${bounds}m pen, spawn ${startDist}m apart) ---`);
  
  let kills = 0;
  let totalReward = 0;
  let batch = [];
  
  for (let ep = 0; ep < episodes; ep++) {
    const env = createEnv4({ bounds, visionRadius: 20 }, 6000 + ep);
    
    // Rabbit spawns opposite wolf
    const rabbit = spawn4(env, {
      archetype: 'rabbit', team: 'prey',
      x: startDist, z: startDist, 
      hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
      maxAge: 120, starveRate: 0, // No starvation, just hunting
    });
    rabbit.lastHp = rabbit.hp;
    rabbit.rewardThisEpisode = 0;
    
    // Wolf spawns at origin
    const w = spawn4(env, {
      archetype: 'wolf', team: 'predator',
      x: -startDist, z: -startDist,
      hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
      maxAge: 120, starveRate: 0, // No starvation
    });
    w.lastHp = w.hp;
    w.rewardThisEpisode = 0;
    
    let trajectory = [];
    let epKills = 0;
    let epReturn = 0;
    
    // Episode
    for (let step = 0; step < 600; step++) {
      if (step % 5 === 0) {
        const obs = observe4(env, w);
        const { probs, hidden } = wolf.forward(obs, 1.0);
        let action = 0;
        let r = Math.random();
        for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
        
        act4(env, w, action, 0.1);
        const reward = computeReward4(env, w, 'wolf');
        epReturn += reward;
        
        trajectory.push({ state: obs, hidden, probs, action, reward });
        
        // Rabbit random action (no policy)
        if (rabbit.alive) {
          act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);
        }
      }
      
      step4(env, 0.1);
      
      for (const ev of env.events) {
        if (ev.type === 'died' && ev.cause === 'predator') {
          epKills++;
        }
      }
      clearEcosystemEvents(env);
    }
    
    kills += epKills;
    totalReward += epReturn;
    
    // Train
    if (trajectory.length > 0) {
      trajectory[trajectory.length - 1].episodeEnd = true;
      batch.push(trajectory);
      if (batch.length >= 8) {
        reinforceUpdate4(wolf, batch.flat());
        batch = [];
      }
    }
    
    const killRate = kills / (ep + 1);
    if (ep % 100 === 0 || ep === episodes - 1) {
      console.log(`  ep ${ep.toString().padStart(3)}: kill% ${(killRate*100).toFixed(1).padStart(5)} avg_reward ${(totalReward/(ep+1)).toFixed(1)}`);
    }
  }
  
  const stageKillRate = kills / episodes;
  const stageReward = totalReward / episodes;
  console.log(`Stage result: ${(stageKillRate*100).toFixed(1)}% kill rate, ${stageReward.toFixed(1)} avg reward`);
  
  if (stageReward > bestScore) {
    bestScore = stageReward;
    bestPolicy = serializePolicy4(wolf);
  }
}

if (bestPolicy) {
  writeFileSync(resolve(outDir, 'wolf.json'), bestPolicy);
  console.log(`\n✓ Saved improved wolf policy (best score: ${bestScore.toFixed(1)})`);
}
