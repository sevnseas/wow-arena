import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== WOLF HUNT V4: Simple reward, long episodes ===\n');

const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(7777);

// Conservative: lower learning rate, stronger baseline for stability
const cfg = { hidden: 64, lr: 0.001, baselineEMA: 0.99, entropyCoef: 0.005 };
const policy = new Policy4(cfg, rng);

let bestKillRate = 0;
let bestPolicy = null;

async function trainEpisode(episodeNum) {
  // Start closer together to make initial learning easier
  const startDist = 2.0;
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 50000 + episodeNum);

  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: startDist / 2, z: startDist / 2,
    hp: 20, maxHp: 20, size: 0.28, speed: 1.5, attackCooldown: 1,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;

  const wolf = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: -startDist / 2, z: -startDist / 2,
    hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  wolf.lastHp = wolf.hp;

  let killed = false;
  const trajectory = [];

  // Very long episode: 1000 steps
  for (let step = 0; step < 1000; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, wolf);
      const { probs, hidden } = policy.forward(obs, 1.0);

      // Sample from all actions
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < probs.length; k++) {
        r -= probs[k];
        if (r < 0) { action = k; break; }
      }

      act4(env, wolf, action, 0.1);
      act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);

      // SIMPLE reward: +10 for kill, -0.01 per step (200 steps/episode = -2 baseline)
      let reward = -0.01;
      for (const ev of env.events) {
        if (ev.type === 'died' && ev.cause === 'predator') {
          reward = 10.0;
          killed = true;
        }
      }

      trajectory.push({
        state: obs,
        probs,
        hidden,
        action,
        reward,
        temperature: 1.0,
      });

      clearEcosystemEvents(env);
    }

    step4(env, 0.1);
    if (killed) break;
  }

  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].episodeEnd = true;
    reinforceUpdate4(policy, trajectory);
  }

  const episodeReturn = trajectory.reduce((sum, t) => sum + t.reward, 0);
  return { episodeReturn, killed };
}

const window = 50;
const returns = [];
const kills = [];

for (let ep = 0; ep < 400; ep++) {
  const { episodeReturn, killed } = await trainEpisode(ep);
  returns.push(episodeReturn);
  kills.push(killed ? 1 : 0);

  if (ep % 40 === 0) {
    const recentReturns = returns.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    const recentKills = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    console.log(`ep ${ep.toString().padStart(3)}: return=${episodeReturn.toFixed(2).padStart(6)} | avg50=${recentReturns.toFixed(2).padStart(6)} | kill=${(recentKills*100).toFixed(0).padStart(3)}%`);
  }

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
console.log(`Best 50-ep window kill rate: ${(bestKillRate*100).toFixed(1)}%\n`);

console.log('Saving trained wolf policy...');
writeFileSync(resolve(outDir, 'wolf.json'), bestPolicy);

const meta = {
  archetype: 'wolf',
  trainingDate: new Date().toISOString(),
  trainingType: 'hunt-v4-simple-reward',
  episodes: 400,
  finalKillRate: finalKillRate,
  bestKillRate: bestKillRate,
  config: cfg,
};
writeFileSync(resolve(outDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

if (finalKillRate < 0.7) {
  console.log(`⚠ Kill rate: ${(finalKillRate*100).toFixed(1)}%`);
} else {
  console.log(`✓ Wolf kill rate: ${(finalKillRate*100).toFixed(1)}%`);
}
