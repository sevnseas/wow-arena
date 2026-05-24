import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deserializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  computeReward4, clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, '..', 'public', 'policies-rl4');

// Load trained policies
const rabbitPolicy = deserializePolicy4(readFileSync(resolve(policyDir, 'rabbit.json'), 'utf8'));
const wolfPolicy = deserializePolicy4(readFileSync(resolve(policyDir, 'wolf.json'), 'utf8'));

console.log('=== ECOSYSTEM SIMULATION TEST ===\n');
console.log('Testing population dynamics with trained rabbit and wolf policies...\n');

function runEcosystem(duration = 300) {
  const env = createEnv4({ bounds: 8, visionRadius: 12 }, 777);

  // Initial setup: 8 rabbits, 2 wolves, 12 grass
  const rabbits = [];
  const wolves = [];

  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const r = 3.5;
    const rabbit = spawn4(env, {
      archetype: 'rabbit', team: 'prey',
      x: Math.cos(angle) * r, z: Math.sin(angle) * r,
      hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
      maxAge: 90, starveRate: 0.25,
    });
    rabbit.lastHp = rabbit.hp;
    rabbits.push(rabbit);
  }

  for (let i = 0; i < 2; i++) {
    const wolf = spawn4(env, {
      archetype: 'wolf', team: 'predator',
      x: (i === 0 ? -5 : 5), z: (i === 0 ? -5 : 5),
      hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
      maxAge: 120, starveRate: 0.2,
    });
    wolf.lastHp = wolf.hp;
    wolves.push(wolf);
  }

  // Spawn grass
  const grassPatches = 12;
  for (let i = 0; i < grassPatches; i++) {
    const angle = (i / grassPatches) * Math.PI * 2;
    const r = (0.25 + (i % 3) * 0.22) * 8;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    // Import spawnGrass if available
    try {
      // Direct grass spawn via env
      env.grass.push({ id: Math.random(), x, z, nutrition: 1.0, alive: true });
    } catch (e) {
      // Skip if spawnGrass not available
    }
  }

  const metrics = {
    startRabbits: rabbits.length,
    startWolves: wolves.length,
    births: { rabbit: 0, wolf: 0 },
    deaths: { rabbit: 0, wolf: 0 },
    kills: 0,
    history: [],
  };

  // Run simulation
  const decisionInterval = 0.3;
  let nextDecision = {};
  for (const e of env.entities) {
    nextDecision[e.id] = 0;
  }

  const startTime = Date.now();
  let time = 0;

  while (time < duration) {
    time += 0.05; // 50ms per frame

    // Make decisions
    for (const e of env.entities) {
      if (!e.alive) continue;
      const policy = e.archetype === 'rabbit' ? rabbitPolicy : wolfPolicy;
      if (!policy) continue;

      const due = nextDecision[e.id] ?? 0;
      if (time < due) continue;

      const obs = observe4(env, e);
      const { probs } = policy.forward(obs, 1.0);

      let action = 0;
      let r = Math.random();
      for (let k = 0; k < probs.length; k++) {
        r -= probs[k];
        if (r < 0) { action = k; break; }
      }

      act4(env, e, action, 0.05);
      nextDecision[e.id] = time + decisionInterval;
    }

    // Physics step
    step4(env, 0.05);

    // Track events
    for (const ev of env.events) {
      if (ev.type === 'born') metrics.births[ev.archetype]++;
      if (ev.type === 'died') {
        metrics.deaths[ev.archetype]++;
        if (ev.cause === 'predator') metrics.kills++;
      }
    }
    clearEcosystemEvents(env);

    // Sample population every 5 seconds
    if (Math.floor(time * 20) % 100 === 0) {
      const alive = env.entities.filter(e => e.alive);
      const rabbits = alive.filter(e => e.archetype === 'rabbit').length;
      const wolves = alive.filter(e => e.archetype === 'wolf').length;
      metrics.history.push({ t: time, rabbits, wolves });
    }
  }

  return metrics;
}

const sim = runEcosystem(300);

console.log('=== RESULTS AFTER 5 MINUTES ===\n');
console.log(`Starting population: ${sim.startRabbits} rabbits, ${sim.startWolves} wolves`);
console.log(`Final population: ${sim.history[sim.history.length - 1]?.rabbits ?? 0} rabbits, ${sim.history[sim.history.length - 1]?.wolves ?? 0} wolves`);
console.log(`\nBirths: ${sim.births.rabbit} rabbits, ${sim.births.wolf} wolves`);
console.log(`Deaths: ${sim.deaths.rabbit} rabbits, ${sim.deaths.wolf} wolves`);
console.log(`Kills: ${sim.kills} (predation events)`);

const finalPop = sim.history[sim.history.length - 1];
if (!finalPop || finalPop.rabbits === 0 && finalPop.wolves === 0) {
  console.log('\n⚠ ECOSYSTEM COLLAPSED - All entities dead');
} else if (finalPop.wolves === 0) {
  console.log('\n⚠ WOLVES EXTINCT - Predators gone');
} else if (finalPop.rabbits === 0) {
  console.log('\n⚠ RABBITS EXTINCT - Prey gone');
} else if (finalPop.rabbits > 50 || finalPop.wolves > 10) {
  console.log('\n⚠ POPULATION EXPLOSION - Unsustainable growth');
} else if (finalPop.rabbits > 5 && finalPop.wolves > 1) {
  console.log('\n✓ ECOSYSTEM STABLE - Balanced population');
} else {
  console.log('\n⚠ LOW POPULATION - Close to extinction risk');
}

console.log('\nPopulation history:');
for (const point of sim.history) {
  const rabbitBar = '🐰'.repeat(Math.min(Math.ceil(point.rabbits / 2), 20));
  const wolfBar = '🐺'.repeat(Math.min(point.wolves, 20));
  console.log(`${point.t.toFixed(1).padStart(5)}s: ${rabbitBar.padEnd(20)} ${wolfBar.padEnd(20)} (${point.rabbits}R/${point.wolves}W)`);
}
