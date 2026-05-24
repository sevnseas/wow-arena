import { createEnv4, spawn4, observe4 } from '../src/rl/index.ts';
import { MAX_ENTITIES_RL4, FEATURES_PER_ENTITY_RL4 } from '../src/rl/types.ts';

console.log('=== OBSERVATION TEST ===\n');

const env = createEnv4({ bounds: 10, visionRadius: 20 }, 1);

const rabbit = spawn4(env, {
  archetype: 'rabbit', team: 'prey',
  x: 5, z: 5,
  hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
  maxAge: 999, starveRate: 0,
});

const wolf = spawn4(env, {
  archetype: 'wolf', team: 'predator',
  x: 0, z: 0,
  hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
  maxAge: 999, starveRate: 0,
});

const obs = observe4(env, wolf);

console.log(`Wolf at (0, 0), Rabbit at (5, 5), distance = 7.07m`);
console.log(`Vision radius: 20m`);
console.log(`Observation dimension: ${obs.length}\n`);

// Check entity slots
console.log('Entity minimap (first 140 values, 20 entities × 7 features):');
let hasRabbit = false;
for (let i = 0; i < MAX_ENTITIES_RL4; i++) {
  const base = i * FEATURES_PER_ENTITY_RL4;
  const relX = obs[base + 0];
  const relZ = obs[base + 1];
  const vx = obs[base + 2];
  const vz = obs[base + 3];
  const hp = obs[base + 4];
  const arch = obs[base + 5] * 6;
  const team = obs[base + 6];
  
  if (relX !== 0 || relZ !== 0 || hp !== 0) {
    const archName = arch === 2 ? 'RABBIT' : arch === 1 ? 'WOLF' : `UNKNOWN(${arch})`;
    console.log(`  [${i}] rel=(${relX.toFixed(2)}, ${relZ.toFixed(2)}) vel=(${vx.toFixed(2)}, ${vz.toFixed(2)}) hp=${hp.toFixed(2)} type=${archName} team=${team}`);
    if (arch === 2) hasRabbit = true;
  }
}

// Self-state
const selfBase = MAX_ENTITIES_RL4 * FEATURES_PER_ENTITY_RL4;
console.log(`\nSelf-state (wolf's own state):`);
console.log(`  HP%: ${obs[selfBase + 0].toFixed(2)}`);
console.log(`  Age%: ${obs[selfBase + 1].toFixed(2)}`);
console.log(`  Counter%: ${obs[selfBase + 2].toFixed(2)}`);
console.log(`  Nearest grass X: ${obs[selfBase + 3].toFixed(2)}`);
console.log(`  Nearest grass Z: ${obs[selfBase + 4].toFixed(2)}`);

console.log(`\n${hasRabbit ? '✓ Rabbit visible in observation' : '✗ Rabbit NOT in observation'}`);
