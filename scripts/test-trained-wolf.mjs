import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deserializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

const policy = deserializePolicy4(readFileSync(resolve(outDir, 'wolf.json'), 'utf8'));

console.log('=== TESTING TRAINED WOLF POLICY ===\n');

async function testScenario(startDist, label, episodes = 50) {
  let totalReward = 0;
  let kills = 0;

  for (let ep = 0; ep < episodes; ep++) {
    const env = createEnv4({ bounds: 3, visionRadius: 12 }, 60000 + ep);

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
    let episodeReturn = 0;

    for (let step = 0; step < 1000; step++) {
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
        act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);

        let reward = -0.01;
        for (const ev of env.events) {
          if (ev.type === 'died' && ev.cause === 'predator') {
            reward = 10.0;
            killed = true;
          }
        }

        episodeReturn += reward;
        clearEcosystemEvents(env);
      }

      step4(env, 0.1);
      if (killed) break;
    }

    totalReward += episodeReturn;
    if (killed) kills++;
  }

  const avgReturn = totalReward / episodes;
  const killRate = kills / episodes;
  console.log(`${label}:`);
  console.log(`  Kill rate: ${(killRate*100).toFixed(1)}%`);
  console.log(`  Avg return: ${avgReturn.toFixed(2)}`);
  console.log();

  return killRate;
}

// Test at 2m (training distance)
console.log('--- Training Configuration (2m start) ---');
await testScenario(2.0, '2m start', 50);

// Test at 3m (full arena)
console.log('--- Scenario Configuration (3m start) ---');
await testScenario(3.0, '3m start', 50);

// Test at 3.6m (opposite corners, like real scenario)
console.log('--- Opposite Corners (3.6m start) ---');
const rate = await testScenario(3.6, '3.6m start', 50);

if (rate > 0.5) {
  console.log('✓ Policy is ready for scenario deployment!');
} else {
  console.log('⚠ Policy needs more training at longer distances');
}
