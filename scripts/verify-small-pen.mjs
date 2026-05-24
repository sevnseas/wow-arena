import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 
  deserializePolicy4, createEnv4, spawn4, spawnGrass, observe4, act4, step4,
  computeReward4, clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

const rabbit = deserializePolicy4(readFileSync(resolve(outDir, 'rabbit.json'), 'utf8'));
const wolf = deserializePolicy4(readFileSync(resolve(outDir, 'wolf.json'), 'utf8'));

console.log('Small pen scenario (3m bounds, S1 - rabbit solo with starvation):\n');

const env = createEnv4({ bounds: 3 }, 2024);
const r = spawn4(env, {
  archetype: 'rabbit', team: 'prey',
  x: 0, z: 0, hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
  maxAge: 90, starveRate: 0.25,
});
r.lastHp = r.hp; r.rewardThisEpisode = 0;

// Scatter grass
for (let i = 0; i < 8; i++) {
  spawnGrass(env, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5);
}

let steps = 0, deaths = 0, grazeEvents = 0, distToGrass = [];

for (let step = 0; step < 600; step++) {
  if (step % 5 === 0) {
    const obs = observe4(env, r);
    const { probs } = rabbit.forward(obs, 1.0);
    let action = 0;
    let rnd = Math.random();
    for (let k = 0; k < probs.length; k++) { rnd -= probs[k]; if (rnd < 0) { action = k; break; } }
    act4(env, r, action, 0.1);
    
    // Track grass distance
    const grassX = obs[obs.length - 2];
    const grassZ = obs[obs.length - 1];
    const dist = Math.hypot(grassX, grassZ);
    if (dist > 0) distToGrass.push(dist);
  }
  
  step4(env, 0.1);
  
  for (const ev of env.events) {
    if (ev.type === 'grazed') grazeEvents++;
    if (ev.type === 'died') deaths++;
  }
  clearEcosystemEvents(env);
}

const avgDist = distToGrass.length ? distToGrass.reduce((a,b)=>a+b)/distToGrass.length : 0;

console.log(`Results after 60 seconds:`);
console.log(`  Rabbit alive: ${r.alive ? '✓ YES' : '✗ NO'}`);
console.log(`  HP: ${r.hp.toFixed(0)} / 30`);
console.log(`  Graze events: ${grazeEvents} (${(grazeEvents/120).toFixed(1)}/sec)`);
console.log(`  Deaths: ${deaths}`);
console.log(`  Avg distance to grass: ${avgDist.toFixed(2)} (0-1 normalized)`);
console.log(`  Grass nutrition eaten: ${r.grassEaten.toFixed(1)} units`);
console.log(`  Status: ${r.alive ? '✓ PASS - Rabbit learned to survive' : '✗ FAIL - Rabbit starved'}`);
