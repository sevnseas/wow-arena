import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deserializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, '..', 'public', 'policies-rl4');

const policy = deserializePolicy4(readFileSync(resolve(policyDir, 'wolf.json'), 'utf8'));

console.log('=== VERIFYING DIRECTION OVERFITTING ===\n');

function testDirectionTracking() {
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 13579);

  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 1.3, z: 1.3,
    hp: 100, maxHp: 100, size: 0.28, speed: 2.0, attackCooldown: 1,
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

  console.log(`Initial positions:`);
  console.log(`  Wolf:   (${wolf.x.toFixed(2)}, ${wolf.z.toFixed(2)})`);
  console.log(`  Rabbit: (${rabbit.x.toFixed(2)}, ${rabbit.z.toFixed(2)})`);
  console.log(`  Distance: ${Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z).toFixed(2)}m\n`);

  const decisions = [];

  for (let step = 0; step < 100; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, wolf);
      const { probs } = policy.forward(obs, 1.0);

      // Sample action
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < probs.length; k++) {
        r -= probs[k];
        if (r < 0) { action = k; break; }
      }

      const actionNames = ['Fwd', 'Back', 'L', 'R', 'FL', 'FR', 'BL', 'BR', 'A1', 'A2', 'A3'];
      const dx = rabbit.x - wolf.x;
      const dz = rabbit.z - wolf.z;
      const dist = Math.hypot(dx, dz);

      // Check if action is toward rabbit
      const actionVec = [
        { x: 0, z: 1 },      // Fwd
        { x: 0, z: -1 },     // Back
        { x: -1, z: 0 },     // StrafeL
        { x: 1, z: 0 },      // StrafeR
        { x: -0.707, z: 0.707 },
        { x: 0.707, z: 0.707 },
        { x: -0.707, z: -0.707 },
        { x: 0.707, z: -0.707 },
        { x: 0, z: 0 },      // Ability (not movement)
        { x: 0, z: 0 },
        { x: 0, z: 0 },
      ];

      const toRabbit = { x: dx / dist, z: dz / dist };
      const v = actionVec[action];
      const alignment = action < 8 ? v.x * toRabbit.x + v.z * toRabbit.z : -1;

      decisions.push({
        step: step,
        action: actionNames[action],
        alignment,
        dist,
      });

      act4(env, wolf, action, 0.1);
      clearEcosystemEvents(env);
    }

    step4(env, 0.1);
  }

  console.log('Sample decisions (showing direction alignment to rabbit):');
  console.log('Step | Action | Distance | Alignment | Correct?');
  console.log('-----|--------|----------|-----------|----------');

  for (const d of decisions.slice(0, 10)) {
    const correct = d.alignment > 0.5 ? '✓' : '✗';
    console.log(
      `${d.step.toString().padStart(4)} | ${d.action.padEnd(6)} | ${d.dist.toFixed(2).padStart(8)}m | ${d.alignment.toFixed(2).padStart(9)} | ${correct}`
    );
  }

  const aligned = decisions.filter(d => d.alignment > 0.5).length;
  const moveActions = decisions.filter(d => d.action !== 'A1' && d.action !== 'A2' && d.action !== 'A3').length;
  const alignmentRate = aligned / moveActions * 100;

  console.log(`\n=== ALIGNMENT CHECK ===`);
  console.log(`Movement actions toward rabbit: ${aligned}/${moveActions} (${alignmentRate.toFixed(0)}%)`);

  if (alignmentRate > 80) {
    console.log(`✓ VERIFIED: Policy consistently moves toward rabbit`);
    return true;
  } else {
    console.log(`⚠ Policy inconsistent: ${alignmentRate.toFixed(0)}% alignment (target 80%+)`);
    return false;
  }
}

const success = testDirectionTracking();
process.exit(success ? 0 : 1);
