import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4,
  createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== POLICY4 CHASE TRAINING (Simple Reward) ===\n');

const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(999);

// Simple Policy4 config
const cfg = { hidden: 32, lr: 0.005, baselineEMA: 0.95, entropyCoef: 0.01 };
const policy = new Policy4(cfg, rng);

async function trainEpisode(episodeNum) {
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 140000 + episodeNum);

  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 1.3, z: 1.3,
    hp: 100, maxHp: 100, size: 0.28, speed: 0,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;

  const wolf = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: -1.3, z: -1.3,
    hp: 100, maxHp: 100, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  wolf.lastHp = wolf.hp;

  const initDist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
  const trajectory = [];
  let minDist = initDist;

  for (let step = 0; step < 120; step++) {
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

      // REWARD: Simple - got closer = +reward
      const closerReward = Math.max(0, initDist - dist);
      let reward = closerReward;

      // HUGE bonus if very close (< 0.5m)
      if (dist < 0.5) reward += 5.0;

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
  }

  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].episodeEnd = true;
    reinforceUpdate4(policy, trajectory);
  }

  const episodeReturn = trajectory.reduce((sum, t) => sum + t.reward, 0);
  return { episodeReturn, minDist, success: minDist < 0.5 };
}

console.log('Training wolf to chase rabbit...\n');

const returns = [];
const minDists = [];
const successes = [];

for (let ep = 0; ep < 200; ep++) {
  const { episodeReturn, minDist, success } = await trainEpisode(ep);
  returns.push(episodeReturn);
  minDists.push(minDist);
  successes.push(success ? 1 : 0);

  if (ep % 20 === 0) {
    const window = 20;
    const recentDist = minDists.slice(-window).reduce((a,b)=>a+b) / window;
    const recentSuccess = successes.slice(-window).reduce((a,b)=>a+b) / window;
    console.log(`ep ${ep.toString().padStart(3)}: avg_min_dist=${recentDist.toFixed(2)}m | success=${(recentSuccess*100).toFixed(0)}%`);
  }
}

console.log('\n=== RESULTS ===');
const finalWindow = 20;
const finalDists = minDists.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
const finalSuccess = successes.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;

console.log(`Final avg min distance: ${finalDists.toFixed(2)}m`);
console.log(`Final close (<0.5m) rate: ${(finalSuccess*100).toFixed(0)}%\n`);

if (finalDists < 1.0 && finalSuccess > 0.3) {
  console.log('✓ TRAINING SUCCESSFUL');

  const serialized = serializePolicy4(policy);
  writeFileSync(resolve(policyDir, 'wolf.json'), serialized);

  const meta = {
    archetype: 'wolf',
    trainedAt: new Date().toISOString(),
    trainingType: 'policy4-chase-simple',
    episodes: 200,
    finalAvgMinDist: finalDists,
    finalSuccessRate: finalSuccess,
    policyConfig: {
      version: 2,
      ...cfg,
    },
  };
  writeFileSync(resolve(policyDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

  console.log('Policy saved with correct Policy4 shape');
} else {
  console.log('⚠ Training incomplete');
}
