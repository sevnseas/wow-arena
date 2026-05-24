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

console.log('=== HUNT OBSERVATION DIAGNOSTIC ===\n');
console.log('Analyzing what the wolf policy sees in hunt scenario...\n');

const env = createEnv4({ bounds: 3, visionRadius: 12 }, 50000);

const rabbit = spawn4(env, {
  archetype: 'rabbit', team: 'prey',
  x: 1.3, z: 1.3,
  hp: 25, maxHp: 25, size: 0.28, speed: 1.8, attackCooldown: 1,
  maxAge: 999, starveRate: 0,
});
rabbit.lastHp = rabbit.hp;

const wolf = spawn4(env, {
  archetype: 'wolf', team: 'predator',
  x: -1.3, z: -1.3,
  hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
  maxAge: 999, starveRate: 0,
});
wolf.lastHp = wolf.hp;

console.log(`Initial positions:`);
console.log(`  Wolf: (${wolf.x.toFixed(2)}, ${wolf.z.toFixed(2)})`);
console.log(`  Rabbit: (${rabbit.x.toFixed(2)}, ${rabbit.z.toFixed(2)})`);
console.log(`  Distance: ${Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z).toFixed(2)}m\n`);

// Run a hunt and show what the policy sees
console.log('Step | Rabbit(x,z) | Wolf(x,z) | Dist | Obs[0-6] (first entity) | Action | Probs');
console.log('-'.repeat(120));

let killed = false;
let step = 0;

for (step = 0; step < 300; step++) {
  if (step % 5 === 0) {
    const obs = observe4(env, wolf);
    const { probs } = policy.forward(obs, 1.0);

    let action = 0;
    let r = Math.random();
    for (let k = 0; k < 8; k++) {
      r -= probs[k];
      if (r < 0) { action = k; break; }
    }

    const dist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);

    // Show first 7 observation features (first entity's relative position, velocity, HP, type)
    const obsStr = `[${obs[0].toFixed(2)}, ${obs[1].toFixed(2)}, ${obs[2].toFixed(2)}, ${obs[3].toFixed(2)}, ${obs[4].toFixed(2)}, ${obs[5].toFixed(2)}, ${obs[6].toFixed(2)}]`;
    const probsStr = `[${probs.slice(0, 8).map(p => (p*100|0).toString().padStart(2)).join('%,')}%]`;

    console.log(
      `${step.toString().padStart(3)} | ` +
      `(${rabbit.x.toFixed(2)},${rabbit.z.toFixed(2)}) | ` +
      `(${wolf.x.toFixed(2)},${wolf.z.toFixed(2)}) | ` +
      `${dist.toFixed(2)}m | ` +
      `${obsStr} | ` +
      `${action} | ` +
      `${probsStr}`
    );

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

console.log('-'.repeat(120));
console.log(`\nEpisode ended at step ${step}: ${killed ? 'KILL ✓' : 'FAIL ✗'}`);
if (killed) {
  console.log(`Final distance: ${Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z).toFixed(2)}m`);
}
