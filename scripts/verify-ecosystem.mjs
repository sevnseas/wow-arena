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

console.log('Verifying ecosystem stability with trained policies:\n');

// S4 ecosystem: 6-10 rabbits, 1-2 wolves, 12 grass patches
const stepsPerEp = 600;
const decisionInterval = 5;
let totalBirths = { rabbit: 0, wolf: 0 };
let totalKills = 0;
let lifetimes = { rabbit: [], wolf: [] };

for (let ep = 0; ep < 20; ep++) {
  const env = createEnv4({ bounds: 10, visionRadius: 14 }, 9000 + ep);
  
  // Ecosystem config
  env.config.reproThreshold.rabbit = 2;
  env.config.reproThreshold.wolf = 1;
  
  // Spawn grass
  for (let i = 0; i < 12; i++) {
    spawnGrass(env, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
  }
  
  // Spawn rabbits
  const rabbits = [];
  for (let i = 0; i < 8; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = (Math.random() * 0.35 + 0.1) * 10;
    const e = spawn4(env, {
      archetype: 'rabbit', team: 'prey',
      x: Math.cos(ang) * r, z: Math.sin(ang) * r,
      hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
      maxAge: 90, starveRate: 0.25,
    });
    e.lastHp = e.hp; e.rewardThisEpisode = 0;
    rabbits.push(e);
  }
  
  // Spawn wolves
  const wolves = [];
  for (let i = 0; i < 1; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = (Math.random() * 0.35 + 0.2) * 10;
    const e = spawn4(env, {
      archetype: 'wolf', team: 'predator',
      x: Math.cos(ang) * r, z: Math.sin(ang) * r,
      hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
      maxAge: 120, starveRate: 0.25,
    });
    e.lastHp = e.hp; e.rewardThisEpisode = 0;
    wolves.push(e);
  }
  
  // Episode simulation
  for (let step = 0; step < stepsPerEp; step++) {
    if (step % decisionInterval === 0) {
      for (const e of env.entities) {
        if (!e.alive) continue;
        const policy = e.archetype === 'rabbit' ? rabbit : wolf;
        const state = observe4(env, e);
        const { probs } = policy.forward(state, 1.0);
        let action = 0;
        let r = Math.random();
        for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
        act4(env, e, action, env.env.config.dt);
        const reward = computeReward4(env, e, e.archetype === 'rabbit' ? 'rabbit' : 'wolf');
      }
    }
    step4(env, env.env.config.dt);
    
    // Track events
    for (const ev of env.events) {
      if (ev.type === 'born') {
        totalBirths[ev.archetype === 'rabbit' ? 'rabbit' : 'wolf']++;
      }
      if (ev.type === 'died' && ev.cause === 'predator') {
        totalKills++;
      }
    }
    clearEcosystemEvents(env);
  }
  
  // Track lifetimes
  for (const e of env.entities) {
    if (e.archetype === 'rabbit' || e.archetype === 'wolf') {
      lifetimes[e.archetype].push(e.age);
    }
  }
  
  const aliveRabbits = env.entities.filter(e => e.archetype === 'rabbit' && e.alive).length;
  const aliveWolves = env.entities.filter(e => e.archetype === 'wolf' && e.alive).length;
  if (ep === 0 || ep === 9 || ep === 19) {
    console.log(`  ep ${ep}: ${aliveRabbits}R alive, ${aliveWolves}W alive (${totalBirths.rabbit}R births, ${totalKills} kills)`);
  }
}

const meanRabbitLife = lifetimes.rabbit.length ? lifetimes.rabbit.reduce((a,b)=>a+b)/lifetimes.rabbit.length : 0;
const meanWolfLife = lifetimes.wolf.length ? lifetimes.wolf.reduce((a,b)=>a+b)/lifetimes.wolf.length : 0;

console.log(`\nEcosystem Summary (20 episodes):`);
console.log(`  Rabbit births: ${totalBirths.rabbit} (avg ${(totalBirths.rabbit/20).toFixed(1)}/ep)`);
console.log(`  Wolf births: ${totalBirths.wolf} (avg ${(totalBirths.wolf/20).toFixed(1)}/ep)`);
console.log(`  Kills: ${totalKills} (avg ${(totalKills/20).toFixed(1)}/ep)`);
console.log(`  Mean lifetime: Rabbit ${meanRabbitLife.toFixed(1)}s, Wolf ${meanWolfLife.toFixed(1)}s`);

const birthDeathRatio = totalKills > 0 ? totalBirths.rabbit / totalKills : Infinity;
const status = birthDeathRatio > 1 ? '✓ STABLE (rabbits outpacing kills)' : '✗ UNSTABLE (kills > births)';
console.log(`  Birth/kill ratio: ${birthDeathRatio.toFixed(2)} - ${status}`);
