import { createEnv4, spawn4, observe4 } from '../src/rl/index.ts';
import { Policy4Registry } from '../src/rl/runtime4.ts';
import { Rng } from '../src/rl/rng.ts';

console.log('=== COMPARING OBSERVATION FORMATS ===\n');

const env = createEnv4({ bounds: 10, visionRadius: 20 }, 1);

// Spawn two entities
const rabbit = spawn4(env, {
  archetype: 'rabbit', team: 'prey',
  x: 5, z: 5,
  hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
  maxAge: 60, starveRate: 0.25,
});

const wolf = spawn4(env, {
  archetype: 'wolf', team: 'predator',
  x: 0, z: 0,
  hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
  maxAge: 120, starveRate: 0.5,
});

// Get env4 observation
const obs4 = observe4(env, wolf);

// Simulate PolicyDriver4 observation
const visionRadius = 20;
const maxSpeed = 10;
const MAX_ENTITIES = 20;
const FEATURES_PER = 7;
const STATE_DIM = 145;

const obs_driver = new Float32Array(STATE_DIM);

// Find visible entities
const visible = [];
for (const other of env.entities) {
  if (!other.alive || other.id === wolf.id) continue;
  const dx = other.x - wolf.x;
  const dz = other.z - wolf.z;
  const d2 = dx*dx + dz*dz;
  if (d2 <= visionRadius * visionRadius) visible.push(other);
}

visible.sort((a, b) => {
  const da = (a.x - wolf.x)**2 + (a.z - wolf.z)**2;
  const db = (b.x - wolf.x)**2 + (b.z - wolf.z)**2;
  return da - db;
});

// Fill entity slots
for (let i = 0; i < visible.length && i < MAX_ENTITIES; i++) {
  const other = visible[i];
  const base = i * FEATURES_PER;
  obs_driver[base + 0] = (other.x - wolf.x) / visionRadius;
  obs_driver[base + 1] = (other.z - wolf.z) / visionRadius;
  obs_driver[base + 2] = (other.vx || 0) / maxSpeed;
  obs_driver[base + 3] = (other.vz || 0) / maxSpeed;
  obs_driver[base + 4] = other.maxHp > 0 ? other.hp / other.maxHp : 0;
  const archCode = other.archetype === 'rabbit' ? 2 : other.archetype === 'wolf' ? 1 : 0;
  obs_driver[base + 5] = archCode / 6;
  obs_driver[base + 6] = other.team === wolf.team ? 0 : 1;
}

// Self-state
const selfBase = MAX_ENTITIES * FEATURES_PER;
obs_driver[selfBase + 0] = wolf.maxHp > 0 ? Math.max(0, wolf.hp / wolf.maxHp) : 0;
obs_driver[selfBase + 1] = wolf.maxAge > 0 ? Math.min(1, wolf.age / wolf.maxAge) : 0;
const threshold = 1; // wolf
obs_driver[selfBase + 2] = threshold > 0 ? Math.min(1, (wolf.preyEaten || 0) / threshold) : 0;
obs_driver[selfBase + 3] = 0; // grass X
obs_driver[selfBase + 4] = 0; // grass Z

// Compare
console.log('Comparing observations:\n');
let matches = 0;
for (let i = 0; i < 50; i++) {
  const diff = Math.abs(obs4[i] - obs_driver[i]);
  if (diff < 0.001) matches++;
  if (diff > 0.01) {
    console.log(`[${i.toString().padStart(3)}] env4: ${obs4[i].toFixed(4)} vs driver: ${obs_driver[i].toFixed(4)} diff: ${diff.toFixed(4)}`);
  }
}

console.log(`\nFirst 50 values: ${matches}/50 match closely`);
console.log(`env4 dimension: ${obs4.length}, driver dimension: ${obs_driver.length}`);

if (matches >= 45) {
  console.log('✓ Observations are compatible');
} else {
  console.log('✗ Observations differ significantly');
}
