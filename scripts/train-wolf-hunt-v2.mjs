import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  computeReward4, clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== WOLF HUNT-ONLY V2: Larger network, longer episodes ===\n');

const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(123); // Different seed to avoid local optima

// Larger network for complex hunting behavior
const cfg = { hidden: 128, lr: 0.002, baselineEMA: 0.98, entropyCoef: 0.01 };
const policy = new Policy4(cfg, rng);

let bestKillRate = 0;
let bestPolicy = null;

async function trainEpisode(episodeNum) {
  // 3m pen: 600 steps (much longer = more learning signal)
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 20000 + episodeNum);

  // Rabbit: slow moving target
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 1.3, z: 1.3,
    hp: 25, maxHp: 25, size: 0.28, speed: 1.8, attackCooldown: 1,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;
  rabbit.rewardThisEpisode = 0;

  // Wolf: faster predator
  const wolf = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: -1.3, z: -1.3,
    hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  wolf.lastHp = wolf.hp;
  wolf.rewardThisEpisode = 0;

  let killed = false;
  let killStep = -1;
  const trajectory = [];

  // 600-step episode
  for (let step = 0; step < 600; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, wolf);
      const { probs, hidden } = policy.forward(obs, 1.0);

      // Only movement actions (0-7)
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < 8; k++) {
        r -= probs[k];
        if (r < 0) { action = k; break; }
      }

      act4(env, wolf, action, 0.1);
      act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);

      // Reward: encourage EARLY kills
      let reward = -0.02; // Small penalty per step

      for (const ev of env.events) {
        if (ev.type === 'died' && ev.cause === 'predator') {
          killStep = step;
          killed = true;
          // Exponential reward: killing at step 50 gives ~100, at step 200 gives ~50, at step 600 gives ~10
          reward = 100 * Math.exp(-(step / 150));
        }
      }

      trajectory.push({ state: obs, probs, hidden, action, reward, temperature: 1.0 });
      clearEcosystemEvents(env);
    }

    step4(env, 0.1);

    // Early exit if killed to speed up training
    if (killed && killStep >= 0 && step > killStep + 50) break;
  }

  // Train on episode
  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].episodeEnd = true;
    reinforceUpdate4(policy, trajectory);
  }

  const episodeReturn = trajectory.reduce((sum, t) => sum + t.reward, 0);
  return { episodeReturn, killed };
}

// Train for 600 episodes
const window = 40;
const returns = [];
const kills = [];

for (let ep = 0; ep < 600; ep++) {
  const { episodeReturn, killed } = await trainEpisode(ep);
  returns.push(episodeReturn);
  kills.push(killed ? 1 : 0);

  if (ep % 30 === 0) {
    const recentReturns = returns.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    const recentKills = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    console.log(`ep ${ep.toString().padStart(3)}: return=${episodeReturn.toFixed(2).padStart(7)} | avg40=${recentReturns.toFixed(2).padStart(7)} | kill_rate=${(recentKills*100).toFixed(1).padStart(5)}%`);
  }

  // Track best policy
  const windowKillRate = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
  if (windowKillRate > bestKillRate) {
    bestKillRate = windowKillRate;
    bestPolicy = serializePolicy4(policy);
  }
}

console.log('\n=== FINAL RESULTS ===');
const finalWindow = 50;
const finalReturns = returns.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
const finalKillRate = kills.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
console.log(`Final 50 episodes avg return: ${finalReturns.toFixed(2)}`);
console.log(`Final 50 episodes kill rate: ${(finalKillRate*100).toFixed(1)}%`);
console.log(`Best 40-ep window kill rate: ${(bestKillRate*100).toFixed(1)}%\n`);

// Save policy
console.log('Saving trained wolf policy...');
writeFileSync(resolve(outDir, 'wolf.json'), bestPolicy);
console.log(`✓ Saved to ${resolve(outDir, 'wolf.json')}`);

const meta = {
  archetype: 'wolf',
  trainingDate: new Date().toISOString(),
  trainingType: 'hunt-v2-early-reward',
  episodes: 600,
  finalKillRate: finalKillRate,
  bestKillRate: bestKillRate,
  config: cfg,
};
writeFileSync(resolve(outDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

if (finalKillRate < 0.7) {
  console.log(`⚠ WARNING: Kill rate is ${(finalKillRate*100).toFixed(1)}%, target is 80%+`);
} else {
  console.log(`✓ Wolf trained to ${(finalKillRate*100).toFixed(1)}% kill rate!`);
}
