import {
  Policy4, createEnv4, spawn4, observe4, act4, step4, clearEcosystemEvents,
} from '../src/rl/index.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deserializePolicy4 } from '../src/rl/policy4.ts';
import { ACTION_NAMES } from '../src/rl/runtime4.ts';

const policy = deserializePolicy4(readFileSync(resolve('./public/policies-rl4/wolf.json'), 'utf8'));

console.log('=== WOLF ACTION ANALYSIS ===\n');

const env = createEnv4({ bounds: 4, visionRadius: 25 }, 5555);

const rabbit = spawn4(env, {
  archetype: 'rabbit', team: 'prey',
  x: 3, z: 0, // Across the pen
  hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
  maxAge: 999, starveRate: 0,
});

const wolf = spawn4(env, {
  archetype: 'wolf', team: 'predator',
  x: 0, z: 0,
  hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
  maxAge: 999, starveRate: 0,
});

console.log(`Initial: wolf=(0,0), rabbit=(3,0), distance=3m\n`);
console.log(`Step | Distance | Action | Top3 probs`);
console.log(`-----|----------|--------|--------`);

for (let step = 0; step < 100; step++) {
  if (step % 5 === 0) {
    const obs = observe4(env, wolf);
    const { probs } = policy.forward(obs, 1.0);
    
    let action = 0;
    let r = Math.random();
    for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
    
    const dist = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
    
    // Top 3 actions
    const sorted = Array.from(probs).map((p, i) => ({p, i})).sort((a,b) => b.p - a.p);
    const top3 = sorted.slice(0, 3).map(x => `${ACTION_NAMES[x.i]}:${(x.p*100).toFixed(0)}%`).join(' ');
    
    console.log(`${step.toString().padStart(4)} | ${dist.toFixed(2)}m | ${ACTION_NAMES[action].padEnd(7)} | ${top3}`);
    
    act4(env, wolf, action, 0.1);
    if (rabbit.alive) act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);
  }
  
  step4(env, 0.1);
  clearEcosystemEvents(env);
}

const final = Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z);
console.log(`\nFinal distance: ${final.toFixed(2)}m`);
console.log(`${final < 3 ? '✓ Wolf is hunting' : '✗ Wolf not approaching rabbit'}`);
