import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deserializePolicy4, createEnv4, spawn4, observe4, act4, step4,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, '..', 'public', 'policies-rl4');

const policy = deserializePolicy4(readFileSync(resolve(policyDir, 'wolf.json'), 'utf8'));

console.log('=== TESTING SIMPLE CHASE POLICY ===\n');

let totalMinDist = 0;
let successCount = 0;
const episodes = 50;

for (let ep = 0; ep < episodes; ep++) {
  const env = createEnv4({ bounds: 5, visionRadius: 15 }, 130000 + ep);

  const rabbitX = (Math.random() - 0.5) * 4;
  const rabbitZ = (Math.random() - 0.5) * 4;
  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: rabbitX, z: rabbitZ,
    hp: 100, maxHp: 100, size: 0.28, speed: 0,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;

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
  let minDist = initialDist;

  for (let step = 0; step < 150; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, wolf);
      const { probs } = policy.forward(obs, 1.0);

      let action = 0;
      let r = Math.random();
      for (let k = 0; k < probs.length; k++) {
        r -= probs[k];
        if (r < 0) { action = k; break; }
      }

      act4(env, wolf, action, 0.1);

      const dist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
      minDist = Math.min(minDist, dist);
    }

    step4(env, 0.1);
  }

  totalMinDist += minDist;
  if (minDist < 0.5) successCount++;

  if ((ep + 1) % 10 === 0) {
    console.log(`Ep ${ep+1}/${episodes}: avg min dist so far ${(totalMinDist / (ep + 1)).toFixed(2)}m | success rate ${(successCount / (ep + 1) * 100).toFixed(0)}%`);
  }
}

const avgMinDist = totalMinDist / episodes;
const successRate = successCount / episodes;

console.log(`\n=== RESULTS ===`);
console.log(`Average minimum distance: ${avgMinDist.toFixed(2)}m (target: <0.5m)`);
console.log(`Close (<0.5m) success rate: ${(successRate * 100).toFixed(0)}%`);
console.log(`Initial distance: ~3.5m\n`);

if (avgMinDist < 1.0 && successRate > 0.3) {
  console.log('✓ Policy chases rabbit effectively');
} else {
  console.log('⚠ Policy needs improvement');
}
