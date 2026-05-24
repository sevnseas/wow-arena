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

console.log('=== VERIFYING 100% KILL RATE ===\n');

async function testDistance(startDist, label) {
  let kills = 0;
  const episodes = 50;

  for (let ep = 0; ep < episodes; ep++) {
    const env = createEnv4({ bounds: 3, visionRadius: 12 }, 80000 + startDist * 1000 + ep);

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

    for (let step = 0; step < 2000; step++) {
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

        for (const ev of env.events) {
          if (ev.type === 'died' && ev.cause === 'predator') {
            killed = true;
          }
        }
        clearEcosystemEvents(env);
      }

      step4(env, 0.1);
      if (killed) break;
    }

    if (killed) kills++;
  }

  const killRate = kills / episodes;
  console.log(`${label.padEnd(18)}: ${(killRate*100).toFixed(1).padStart(5)}% (${kills}/${episodes} kills)`);
  return killRate;
}

console.log('Testing kill rate at various starting distances:\n');

const rate2 = await testDistance(2.0, '2m start');
const rate3 = await testDistance(3.0, '3m start');
const rate36 = await testDistance(3.6, '3.6m (corners)');

console.log();
const allAbove99 = rate2 >= 0.99 && rate3 >= 0.99 && rate36 >= 0.99;
if (allAbove99) {
  console.log('✅ VERIFIED: 100% kill rate across all distances!');
} else {
  console.log('⚠ Some distances below target');
}
