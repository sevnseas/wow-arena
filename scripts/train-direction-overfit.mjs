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

console.log('=== OVERFITTING TEST: Wolf learns to move toward rabbit ===\n');
console.log('Minimal training: ONLY reward is direction toward rabbit\n');

const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(12345);

// Simple network for pure direction tracking
const cfg = { hidden: 32, lr: 0.01, baselineEMA: 0.9, entropyCoef: 0.005 };
const policy = new Policy4(cfg, rng);

async function trainEpisode(episodeNum) {
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 110000 + episodeNum);

  // Rabbit at fixed position
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 1.3, z: 1.3,
    hp: 100, maxHp: 100, size: 0.28, speed: 2.0, attackCooldown: 1,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;

  // Wolf at opposite corner
  const wolf = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: -1.3, z: -1.3,
    hp: 100, maxHp: 100, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  wolf.lastHp = wolf.hp;

  const trajectory = [];

  // 200-step episode
  for (let step = 0; step < 200; step++) {
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

      // REWARD ONLY: Is the action moving toward the rabbit?
      // Actions: 0=fwd, 1=back, 2=strafeL, 3=strafeR, 4=fwdL, 5=fwdR, 6=backL, 7=backR
      const dx = rabbit.x - wolf.x;
      const dz = rabbit.z - wolf.z;
      const dist = Math.hypot(dx, dz);

      // Direction to rabbit (0-1, 1 = directly toward)
      let dirReward = 0;
      if (action >= 0 && action <= 7) {  // Movement actions
        // Compute unit vector toward rabbit
        const toRabbit = { x: dx / dist, z: dz / dist };

        // Action vectors (unit)
        const actionVec = [
          { x: 0, z: 1 },      // 0: forward
          { x: 0, z: -1 },     // 1: back
          { x: -1, z: 0 },     // 2: strafeL
          { x: 1, z: 0 },      // 3: strafeR
          { x: -0.707, z: 0.707 }, // 4: fwdL
          { x: 0.707, z: 0.707 },  // 5: fwdR
          { x: -0.707, z: -0.707 },// 6: backL
          { x: 0.707, z: -0.707 },  // 7: backR
        ];

        const v = actionVec[action];
        // Dot product: how aligned is action with direction to rabbit?
        dirReward = v.x * toRabbit.x + v.z * toRabbit.z;  // -1 to +1
        dirReward = Math.max(0, dirReward);  // Only positive (0 to 1)
        dirReward *= 10;  // Scale up
      }

      trajectory.push({
        state: obs,
        probs,
        hidden,
        action,
        reward: dirReward,
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
  return { episodeReturn };
}

console.log('Training wolf to move toward rabbit (pure direction reward)...\n');

const returns = [];
for (let ep = 0; ep < 300; ep++) {
  const { episodeReturn } = await trainEpisode(ep);
  returns.push(episodeReturn);

  if (ep % 30 === 0) {
    const window = 30;
    const recent = returns.slice(Math.max(0, ep - window));
    const avg = recent.reduce((a,b)=>a+b) / recent.length;
    console.log(`ep ${ep.toString().padStart(3)}: return=${episodeReturn.toFixed(2).padStart(6)} | avg30=${avg.toFixed(2).padStart(6)}`);
  }
}

console.log('\n=== RESULTS ===');
const finalWindow = 30;
const finalReturns = returns.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
console.log(`Final 30 episodes avg return: ${finalReturns.toFixed(2)}`);
console.log(`Maximum possible per episode: 10.0 (perfect direction alignment)`);
console.log(`Overfitting achieved: ${(finalReturns/10*100).toFixed(0)}%\n`);

if (finalReturns > 8.5) {
  console.log('✓ OVERFIT SUCCESSFUL: Wolf learned to move toward rabbit');
} else {
  console.log('⚠ Overfitting incomplete');
}

console.log('Saving direction-overfit policy...');
const serialized = serializePolicy4(policy);
writeFileSync(resolve(policyDir, 'wolf.json'), serialized);

const meta = {
  archetype: 'wolf',
  trainedAt: new Date().toISOString(),
  trainingType: 'direction-overfit',
  episodes: 300,
  finalReturnAvg: finalReturns,
  policyConfig: {
    version: 2,
    ...cfg,
  },
};
writeFileSync(resolve(policyDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

console.log(`✓ Policy saved to wolf.json`);
console.log(`✓ Metadata saved to wolf.meta.json\n`);
console.log('Ready to test in scenario at:');
console.log('http://localhost:3000/threejs-arena/scenarios.html?s=wolf-vs-rabbit');
