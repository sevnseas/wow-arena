import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deserializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== VERIFYING SCENARIO DEPLOYMENT ===\n');
console.log('Testing deployed wolf policy in scenario-like conditions...\n');

let policy;
try {
  const policyJson = readFileSync(resolve(policyDir, 'wolf.json'), 'utf8');
  policy = deserializePolicy4(policyJson);
  console.log('✓ Policy loaded from wolf.json');
} catch (e) {
  console.error('✗ FAILED to load policy:', e.message);
  process.exit(1);
}

let meta;
try {
  const metaJson = readFileSync(resolve(policyDir, 'wolf.meta.json'), 'utf8');
  meta = JSON.parse(metaJson);
  const hidden = meta.policyConfig?.hidden || 'unknown';
  console.log(`✓ Metadata loaded: trainingType=${meta.trainingType}, hidden=${hidden}`);
  if (!meta.policyConfig || meta.policyConfig.version !== 2) {
    console.error('✗ METADATA MISMATCH: policyConfig.version should be 2');
    process.exit(1);
  }
} catch (e) {
  console.error('✗ FAILED to load metadata:', e.message);
  process.exit(1);
}

console.log('\n--- Testing in scenario-like environment ---\n');

// Scenario conditions: wolf and rabbit in 3m pen (like wolf-vs-rabbit scenario)
const env = createEnv4({ bounds: 3, visionRadius: 12 }, 50000);

const rabbit = spawn4(env, {
  archetype: 'rabbit', team: 'prey',
  x: 1.3, z: 1.3,
  hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
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

console.log(`Starting positions (like scenario):`);
console.log(`  Wolf:   (${wolf.x.toFixed(2)}, ${wolf.z.toFixed(2)})`);
console.log(`  Rabbit: (${rabbit.x.toFixed(2)}, ${rabbit.z.toFixed(2)})`);
console.log(`  Initial distance: ${Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z).toFixed(2)}m\n`);

let minDist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
const decisions = [];

// Run for 60 seconds (like actual gameplay)
for (let step = 0; step < 1200; step++) {
  if (step % 10 === 0) {  // Decision every 0.5s
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
        console.log(`  KILL at step ${step}!`);
      }
    }
    clearEcosystemEvents(env);

    const dist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
    minDist = Math.min(minDist, dist);

    decisions.push({
      step,
      action,
      dist,
      getCloser: dist < (decisions.length > 0 ? decisions[decisions.length - 1].dist : minDist),
    });
  }

  step4(env, 0.1);
}

console.log(`\n=== DEPLOYMENT TEST RESULTS ===\n`);

const finalDist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
const gettingCloser = decisions.filter(d => d.getCloser).length / decisions.length;

console.log(`Final distance: ${finalDist.toFixed(2)}m (started at 3.68m)`);
console.log(`Minimum distance reached: ${minDist.toFixed(2)}m`);
console.log(`% of decisions moving closer: ${(gettingCloser * 100).toFixed(0)}%\n`);

// Criteria for success: wolf must get close to rabbit
const success = minDist < 1.0;  // Can get within 1m of rabbit

if (success) {
  console.log('✓ DEPLOYMENT VERIFIED: Wolf policy works in scenario');
  console.log(`  Wolf successfully approaches rabbit (min distance: ${minDist.toFixed(2)}m)`);
  console.log(`  Policy is ready for live testing.`);
  console.log(`\n  Test at: http://localhost:3000/threejs-arena/scenarios.html?s=wolf-vs-rabbit`);
  process.exit(0);
} else {
  console.log('✗ DEPLOYMENT FAILED: Wolf cannot approach rabbit');
  console.log(`  Min distance: ${minDist.toFixed(2)}m (need <1.0m)`);
  process.exit(1);
}
