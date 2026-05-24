import { createEnv4, spawn4, step4, clearEcosystemEvents } from '../src/rl/index.ts';

console.log('=== BASIC KILL TEST ===\n');

// Simplest possible test: wolf and rabbit touching
const env = createEnv4({ bounds: 5 }, 1);

const rabbit = spawn4(env, {
  archetype: 'rabbit', team: 'prey',
  x: 0.5, z: 0, // Very close
  hp: 10, maxHp: 10, size: 0.28, speed: 2.6, attackCooldown: 1,
  maxAge: 999, starveRate: 0,
});

const wolf = spawn4(env, {
  archetype: 'wolf', team: 'predator',
  x: 0, z: 0,
  hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
  maxAge: 999, starveRate: 0,
});

console.log(`Initial: wolf at (${wolf.x}, ${wolf.z}), rabbit at (${rabbit.x}, ${rabbit.z})`);
console.log(`Distance: ${Math.hypot(rabbit.x - wolf.x, rabbit.z - wolf.z).toFixed(2)}m`);
console.log(`Rabbit HP: ${rabbit.hp}, Wolf attackTimer: ${wolf.attackTimer}`);

// Just step - no actions
for (let i = 0; i < 100; i++) {
  step4(env, 0.1);
  
  if (i % 10 === 0) {
    console.log(`Step ${i.toString().padStart(3)}: wolf.hp=${wolf.hp.toFixed(0)}, rabbit.hp=${rabbit.hp.toFixed(0)}, alive=${rabbit.alive}, attackTimer=${wolf.attackTimer.toFixed(2)}`);
  }
  
  for (const ev of env.events) {
    if (ev.type === 'died') {
      console.log(`⚠️  Event: ${ev.type} cause=${ev.cause}`);
    }
  }
  clearEcosystemEvents(env);
}

console.log(`\nFinal: rabbit alive=${rabbit.alive}, hp=${rabbit.hp}`);
console.log(rabbit.alive ? '✗ FAIL: Wolf did not kill stationary rabbit' : '✓ PASS: Wolf can kill stationary rabbit');
