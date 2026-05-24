import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== WOLF HUNTING: Optimize for speed + 100% kill rate ===\n');

const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(8888);

// Reward shaping favors fast kills: earlier kill = bigger reward
const cfg = { hidden: 64, lr: 0.002, baselineEMA: 0.97, entropyCoef: 0.015 };
const policy = new Policy4(cfg, rng);

let bestKillRate = 0;
let bestAvgTimeToKill = Infinity;
let bestPolicy = null;

async function trainEpisode(episodeNum) {
  const startDist = 2.0;
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 90000 + episodeNum);

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
  let killStep = -1;
  const trajectory = [];

  for (let step = 0; step < 2000; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, wolf);
      const { probs, hidden } = policy.forward(obs, 1.0);

      let action = 0;
      let r = Math.random();
      for (let k = 0; k < probs.length; k++) {
        r -= probs[k];
        if (r < 0) { action = k; break; }
      }

      act4(env, wolf, action, 0.1);
      act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);

      // Strong reward for early kills (exponential: kill at step 20 = 15, step 100 = 7.5, step 400 = 0.9)
      // Penalty per step encourages speed
      let reward = -0.01;
      for (const ev of env.events) {
        if (ev.type === 'died' && ev.cause === 'predator') {
          // Exponential decay based on step count - earlier is much better
          const decisionCount = step / 5;
          reward = 20 * Math.exp(-decisionCount / 30);
          killStep = step;
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
  const timeToKill = killed ? (killStep / 5) * 0.1 : NaN; // Seconds to kill

  return { episodeReturn, killed, timeToKill };
}

const window = 60;
const returns = [];
const kills = [];
const killTimes = [];

for (let ep = 0; ep < 800; ep++) {
  const { episodeReturn, killed, timeToKill } = await trainEpisode(ep);
  returns.push(episodeReturn);
  kills.push(killed ? 1 : 0);
  if (killed) killTimes.push(timeToKill);

  if (ep % 80 === 0) {
    const recentKills = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    const recentTimes = killTimes.slice(Math.max(0, killTimes.length - 40));
    const avgTime = recentTimes.length > 0 ? recentTimes.reduce((a,b)=>a+b) / recentTimes.length : NaN;
    console.log(`ep ${ep.toString().padStart(3)}: kill=${(recentKills*100).toFixed(0).padStart(3)}% | avg_time=${isNaN(avgTime) ? '—' : (avgTime.toFixed(2) + 's').padStart(6)}`);
  }

  const windowKillRate = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
  const recentTimes = killTimes.slice(Math.max(0, killTimes.length - 40));
  const avgTime = recentTimes.length > 0 ? recentTimes.reduce((a,b)=>a+b) / recentTimes.length : Infinity;

  // Save policy that achieves 100% kills AND has fastest average time
  if (windowKillRate >= 0.99 && avgTime < bestAvgTimeToKill) {
    bestKillRate = windowKillRate;
    bestAvgTimeToKill = avgTime;
    bestPolicy = serializePolicy4(policy);
  }
}

console.log('\n=== FINAL RESULTS ===');
const finalWindow = 60;
const finalReturns = returns.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
const finalKillRate = kills.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
const finalTimes = killTimes.slice(-40);
const finalAvgTime = finalTimes.length > 0 ? finalTimes.reduce((a,b)=>a+b) / finalTimes.length : NaN;
const finalMinTime = finalTimes.length > 0 ? Math.min(...finalTimes) : NaN;

console.log(`Final 60 episodes kill rate: ${(finalKillRate*100).toFixed(1)}%`);
console.log(`Final 40 kills avg time: ${finalAvgTime.toFixed(2)}s`);
console.log(`Fastest kill time: ${finalMinTime.toFixed(2)}s`);
console.log(`Best 60-ep window kill rate: ${(bestKillRate*100).toFixed(1)}%`);
console.log(`Best avg time to kill: ${bestAvgTimeToKill.toFixed(2)}s\n`);

console.log('Saving optimized wolf policy...');
writeFileSync(resolve(outDir, 'wolf.json'), bestPolicy);

const meta = {
  archetype: 'wolf',
  trainedAt: new Date().toISOString(),
  trainingType: 'hunt-optimized-speed',
  episodes: 800,
  finalKillRate: finalKillRate,
  bestKillRate: bestKillRate,
  bestStage: 'hunt-v5',
  bestEpisodeIndex: 799,
  bestMetricScore50: bestAvgTimeToKill,
  policyConfig: {
    version: 2,
    ...cfg,
  },
};
writeFileSync(resolve(outDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

console.log(`✓ Wolf: ${(finalKillRate*100).toFixed(0)}% kills in ${finalAvgTime.toFixed(2)}s avg`);
