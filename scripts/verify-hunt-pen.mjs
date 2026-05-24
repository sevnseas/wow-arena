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

console.log('Hunt pen scenario (5m bounds, S3 - 2 rabbits, 1 wolf):\n');

const env = createEnv4({ bounds: 5 }, 2025);

// Spawn rabbits
const rabbits = [];
for (let i = 0; i < 2; i++) {
  const r = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: (i - 0.5) * 1, z: (i - 0.5) * 1,
    hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
    maxAge: 90, starveRate: 0.25,
  });
  r.lastHp = r.hp; r.rewardThisEpisode = 0;
  rabbits.push(r);
}

// Spawn wolf
const w = spawn4(env, {
  archetype: 'wolf', team: 'predator',
  x: 0, z: 0, hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
  maxAge: 120, starveRate: 0.25,
});
w.lastHp = w.hp; w.rewardThisEpisode = 0;

// Scatter grass for rabbits
for (let i = 0; i < 6; i++) {
  spawnGrass(env, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
}

let kills = 0, births = 0, wolfReward = 0;

for (let step = 0; step < 600; step++) {
  if (step % 5 === 0) {
    // Act rabbits
    for (const r of rabbits) {
      if (!r.alive) continue;
      const obs = observe4(env, r);
      const { probs } = rabbit.forward(obs, 1.0);
      let action = 0;
      let rnd = Math.random();
      for (let k = 0; k < probs.length; k++) { rnd -= probs[k]; if (rnd < 0) { action = k; break; } }
      act4(env, r, action, 0.1);
      const rew = computeReward4(env, r, 'rabbit');
    }
    
    // Act wolf
    if (w.alive) {
      const obs = observe4(env, w);
      const { probs } = wolf.forward(obs, 1.0);
      let action = 0;
      let rnd = Math.random();
      for (let k = 0; k < probs.length; k++) { rnd -= probs[k]; if (rnd < 0) { action = k; break; } }
      act4(env, w, action, 0.1);
      const rew = computeReward4(env, w, 'wolf');
      wolfReward += rew;
    }
  }
  
  step4(env, 0.1);
  
  for (const ev of env.events) {
    if (ev.type === 'born') births++;
    if (ev.type === 'died' && ev.cause === 'predator') kills++;
  }
  clearEcosystemEvents(env);
}

const aliveRabbits = rabbits.filter(r => r.alive).length;

console.log(`Results after 60 seconds:`);
console.log(`  Wolf alive: ${w.alive ? '✓ YES' : '✗ NO'}`);
console.log(`  Rabbits alive: ${aliveRabbits}/2`);
console.log(`  Kills by wolf: ${kills}`);
console.log(`  Births: ${births}`);
console.log(`  Wolf reward: ${wolfReward.toFixed(0)}`);
console.log(`  Wolf hunted: ${kills > 0 ? '✓ YES' : '✗ NO'}`);
console.log(`  Rabbits survived: ${aliveRabbits > 0 ? '✓ YES' : '✗ NO'}`);
console.log(`  Status: ${kills > 0 && aliveRabbits > 0 ? '✓ PASS - Predator hunting, prey surviving' : '✗ FAIL'}`);
