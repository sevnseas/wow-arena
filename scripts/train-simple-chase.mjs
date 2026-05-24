import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4,
  createEnv4, spawn4, observe4, act4, step4,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== SIMPLE CHASE TRAINING ===\n');
console.log('Reward: reduce distance to rabbit (0 to 1 scale, max reward = getting close)\n');

const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(777);

const cfg = { hidden: 32, lr: 0.005, baselineEMA: 0.95, entropyCoef: 0.01 };
const policy = new Policy4(cfg, rng);

async function trainEpisode(episodeNum) {
  const env = createEnv4({ bounds: 5, visionRadius: 15 }, 120000 + episodeNum);

  // Rabbit at random position
  const rabbitX = (Math.random() - 0.5) * 4;
  const rabbitZ = (Math.random() - 0.5) * 4;
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: rabbitX, z: rabbitZ,
    hp: 100, maxHp: 100, size: 0.28, speed: 0, attackCooldown: 1, // Stationary
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;

  // Wolf at opposite random position
  const wolfX = (Math.random() - 0.5) * 4;
  const wolfZ = (Math.random() - 0.5) * 4;
  const wolf = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: wolfX, z: wolfZ,
    hp: 100, maxHp: 100, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  wolf.lastHp = wolf.hp;

  const initialDist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
  const trajectory = [];
  let minDist = initialDist;

  // 150 steps
  for (let step = 0; step < 150; step++) {
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

      const dist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
      minDist = Math.min(minDist, dist);

      // REWARD: Got closer to rabbit
      const closerReward = initialDist - dist;  // Positive if closer

      // PENALTY: Moved away from rabbit
      const awayPenalty = dist > initialDist ? -2 : 0;

      let reward = closerReward + awayPenalty;

      // BONUS: Very close
      if (dist < 0.5) reward += 10;

      trajectory.push({
        state: obs,
        probs,
        hidden,
        action,
        reward,
        temperature: 1.0,
      });
    }

    step4(env, 0.1);
  }

  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].episodeEnd = true;
    reinforceUpdate4(policy, trajectory);
  }

  const episodeReturn = trajectory.reduce((sum, t) => sum + t.reward, 0);
  const gotClose = minDist < 0.5;

  return { episodeReturn, minDist, gotClose };
}

console.log('Training on getting close to rabbit...\n');

const returns = [];
const minDists = [];
const closeCount = [];

for (let ep = 0; ep < 400; ep++) {
  const { episodeReturn, minDist, gotClose } = await trainEpisode(ep);
  returns.push(episodeReturn);
  minDists.push(minDist);
  closeCount.push(gotClose ? 1 : 0);

  if (ep % 40 === 0) {
    const window = 40;
    const recentReturn = returns.slice(-window).reduce((a,b)=>a+b) / window;
    const recentDist = minDists.slice(-window).reduce((a,b)=>a+b) / window;
    const recentClose = closeCount.slice(-window).reduce((a,b)=>a+b) / window;
    console.log(`ep ${ep.toString().padStart(3)}: return=${episodeReturn.toFixed(2).padStart(6)} | avg_dist=${recentDist.toFixed(2).padStart(5)}m | got_close=${(recentClose*100).toFixed(0).padStart(3)}%`);
  }
}

console.log('\n=== FINAL RESULTS ===');
const finalWindow = 40;
const finalReturns = returns.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
const finalDists = minDists.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
const finalCloseRate = closeCount.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;

console.log(`Final avg return: ${finalReturns.toFixed(2)}`);
console.log(`Final avg min distance: ${finalDists.toFixed(2)}m (started at ~3.5m)`);
console.log(`Close (<0.5m) rate: ${(finalCloseRate*100).toFixed(0)}%\n`);

if (finalDists < 1.0 && finalCloseRate > 0.5) {
  console.log('✓ TRAINING SUCCESSFUL: Wolf learns to get close to rabbit');
} else {
  console.log('⚠ Training incomplete');
}

console.log('Saving policy...');
const serialized = serializePolicy4(policy);
writeFileSync(resolve(policyDir, 'wolf.json'), serialized);

const meta = {
  archetype: 'wolf',
  trainedAt: new Date().toISOString(),
  trainingType: 'simple-chase',
  episodes: 400,
  finalAvgReturn: finalReturns,
  finalAvgMinDist: finalDists,
  finalCloseRate: finalCloseRate,
  policyConfig: {
    version: 2,
    ...cfg,
  },
};
writeFileSync(resolve(policyDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

console.log(`✓ Policy and metadata saved`);
console.log(`\nTest in scenario: http://localhost:3000/threejs-arena/scenarios.html?s=wolf-vs-rabbit`);
