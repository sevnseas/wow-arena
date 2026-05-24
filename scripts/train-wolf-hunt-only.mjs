import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  computeReward4, clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== WOLF HUNT-ONLY TRAINING ===\n');
console.log('Training wolf to hunt rabbits with pure movement actions...\n');

const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(42);

// Balanced learning rate with higher entropy for exploration
const cfg = { hidden: 64, lr: 0.003, baselineEMA: 0.98, entropyCoef: 0.02 };
const policy = new Policy4(cfg, rng);

let bestKillRate = 0;
let bestPolicy = null;

async function trainEpisode(episodeNum) {
  // 3m pen setup: wolf and rabbit spawn opposite corners
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 10000 + episodeNum);

  // Spawn rabbit (stationary-ish, wanders slowly)
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 1.2, z: 1.2,
    hp: 20, maxHp: 20, size: 0.28, speed: 2.0, attackCooldown: 1,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;
  rabbit.rewardThisEpisode = 0;

  // Spawn wolf
  const wolf = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: -1.2, z: -1.2,
    hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  wolf.lastHp = wolf.hp;
  wolf.rewardThisEpisode = 0;

  let killed = false;
  const trajectory = [];

  // 400-step episode (plenty of time to hunt)
  for (let step = 0; step < 400; step++) {
    if (step % 5 === 0) {
      // Wolf makes decision every 5 physics steps
      const obs = observe4(env, wolf);
      const { probs, hidden } = policy.forward(obs, 1.0);

      // Sample action: only movement (0-7), never abilities (8-11)
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < 8; k++) {
        r -= probs[k];
        if (r < 0) {
          action = k;
          break;
        }
      }

      // Apply movement action
      act4(env, wolf, action, 0.1);

      // Rabbit wanders randomly
      act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);

      // Reward structure:
      // - Small penalty for each step (encourages quick hunts)
      // - Large bonus when killing
      let reward = -0.05;
      const rew = computeReward4(env, wolf, 'wolf');

      // Check for kill event
      for (const ev of env.events) {
        if (ev.type === 'died' && ev.cause === 'predator') {
          reward = 50.0; // Massive hunt reward
          killed = true;
        }
      }

      trajectory.push({ state: obs, probs, hidden, action, reward, temperature: 1.0 });
      clearEcosystemEvents(env);
    }

    step4(env, 0.1);
  }

  // Train on episode
  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].episodeEnd = true;
    reinforceUpdate4(policy, trajectory);
  }

  const episodeReturn = trajectory.reduce((sum, t) => sum + t.reward, 0);
  return { episodeReturn, killed };
}

// Train for 500 episodes
const window = 30;
const returns = [];
const kills = [];

for (let ep = 0; ep < 500; ep++) {
  const { episodeReturn, killed } = await trainEpisode(ep);
  returns.push(episodeReturn);
  kills.push(killed ? 1 : 0);

  if (ep % 20 === 0) {
    const recentReturns = returns.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    const recentKills = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    console.log(`ep ${ep.toString().padStart(3)}: return=${episodeReturn.toFixed(2).padStart(7)} | avg20=${recentReturns.toFixed(2).padStart(7)} | kill_rate=${(recentKills*100).toFixed(1).padStart(5)}%`);
  }

  // Track best policy
  const windowKillRate = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
  if (windowKillRate > bestKillRate) {
    bestKillRate = windowKillRate;
    bestPolicy = serializePolicy4(policy);
  }
}

console.log('\n=== FINAL RESULTS ===');
const finalWindow = 30;
const finalReturns = returns.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
const finalKillRate = kills.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
console.log(`Final 30 episodes avg return: ${finalReturns.toFixed(2)}`);
console.log(`Final 30 episodes kill rate: ${(finalKillRate*100).toFixed(1)}%`);
console.log(`Best 20-ep window kill rate: ${(bestKillRate*100).toFixed(1)}%\n`);

// Save policy
console.log('Saving trained wolf policy...');
writeFileSync(resolve(outDir, 'wolf.json'), bestPolicy);
console.log(`✓ Saved to ${resolve(outDir, 'wolf.json')}`);

// Also save metadata
const meta = {
  archetype: 'wolf',
  trainingDate: new Date().toISOString(),
  trainingType: 'hunt-only-movement',
  episodes: 500,
  finalKillRate: finalKillRate,
  bestKillRate: bestKillRate,
  config: cfg,
};
writeFileSync(resolve(outDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

if (finalKillRate < 0.6) {
  console.log(`\n⚠ WARNING: Kill rate is ${(finalKillRate*100).toFixed(1)}%, target is 80%+`);
} else {
  console.log(`\n✓ Wolf trained to ${(finalKillRate*100).toFixed(1)}% kill rate!`);
}
