import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 
  deserializePolicy4, Policy4, reinforceUpdate4, createEnv4, spawn4, observe4, act4, step4,
  computeReward4, clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

// Load current wolf policy
const currentWolf = deserializePolicy4(readFileSync(resolve(outDir, 'wolf.json'), 'utf8'));

// Create a fresh wolf policy for retraining
const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(42);
const cfg = { hidden: 64, lr: 0.002, baselineEMA: 0.95, entropyCoef: 0.01 };
const freshWolf = new Policy4(cfg, rng);

console.log('=== WOLF HUNTING TEST ===\n');
console.log('Testing if wolf can learn to hunt rabbits in isolation...\n');

// Simple hunt scenario: 1 wolf, 1 rabbit in 4m pen
async function testHunting(policy, label, episodes = 50) {
  let totalReward = 0;
  let kills = 0;
  let closest = [];
  
  for (let ep = 0; ep < episodes; ep++) {
    const env = createEnv4({ bounds: 4, visionRadius: 12 }, 5000 + ep);
    
    // Spawn rabbit
    const rabbit = spawn4(env, {
      archetype: 'rabbit', team: 'prey',
      x: 1.5, z: 1.5, // Opposite corner from wolf
      hp: 30, maxHp: 30, size: 0.28, speed: 2.6, attackCooldown: 1,
      maxAge: 999, starveRate: 0,
    });
    rabbit.lastHp = rabbit.hp;
    rabbit.rewardThisEpisode = 0;
    
    // Spawn wolf
    const wolf = spawn4(env, {
      archetype: 'wolf', team: 'predator',
      x: -1.5, z: -1.5, // Opposite corner
      hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
      maxAge: 999, starveRate: 0,
    });
    wolf.lastHp = wolf.hp;
    wolf.rewardThisEpisode = 0;
    
    let minDist = 10;
    let killed = false;
    let trajectory = [];
    
    // Run episode
    for (let step = 0; step < 600; step++) {
      if (step % 5 === 0) {
        // Wolf decision
        const obs = observe4(env, wolf);
        const { probs } = policy.forward(obs, 1.0);
        let action = 0;
        let r = Math.random();
        for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
        act4(env, wolf, action, 0.1);
        
        const rew = computeReward4(env, wolf, 'wolf');
        trajectory.push({ state: obs, probs, action, reward: rew });
        
        // Rabbit just wanders (no policy)
        act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);
      }
      
      step4(env, 0.1);

      const dx = rabbit.x - wolf.x;
      const dz = rabbit.z - wolf.z;
      const dist = Math.hypot(dx, dz);
      minDist = Math.min(minDist, dist);
      
      for (const ev of env.events) {
        if (ev.type === 'died' && ev.cause === 'predator') {
          killed = true;
        }
      }
      clearEcosystemEvents(env);
    }
    
    const episodeReturn = trajectory.reduce((sum, t) => sum + t.reward, 0);
    totalReward += episodeReturn;
    if (killed) kills++;
    closest.push(minDist);
    
    // Train if this is a learnable policy
    if (label === 'Fresh') {
      if (trajectory.length > 0) {
        trajectory[trajectory.length - 1].episodeEnd = true;
        reinforceUpdate4(policy, trajectory);
      }
    }
    
    if (ep % 10 === 0) {
      console.log(`  ep ${ep.toString().padStart(3)}: return=${episodeReturn.toFixed(1).padStart(6)} killed=${killed ? 'Y' : 'N'} closest=${minDist.toFixed(2)}m`);
    }
  }
  
  const avgReward = totalReward / episodes;
  const killRate = kills / episodes;
  const avgClosest = closest.reduce((a,b)=>a+b)/closest.length;
  
  console.log(`\n${label} Results:`);
  console.log(`  Avg reward: ${avgReward.toFixed(1)}`);
  console.log(`  Kill rate: ${(killRate*100).toFixed(1)}%`);
  console.log(`  Closest avg: ${avgClosest.toFixed(2)}m`);
  console.log(`  Status: ${killRate > 0.5 ? '✓ GOOD' : '✗ POOR'}`);
  console.log();
  
  return { avgReward, killRate, avgClosest };
}

// Test current policy
console.log('--- Testing CURRENT wolf policy ---');
const current = await testHunting(currentWolf, 'Current', 50);

// Test fresh policy learning
console.log('--- Testing FRESH wolf policy (learning) ---');
const fresh = await testHunting(freshWolf, 'Fresh', 100);

// Summary
console.log('=== DIAGNOSIS ===');
if (current.killRate < 0.3) {
  console.log('✗ CURRENT POLICY: Wolf not hunting effectively');
  console.log('  Issue: Trained policy doesn\'t transfer to scenario');
  console.log('  Solution: Need to retrain with scenario-compatible setup');
}
if (fresh.killRate > current.killRate) {
  console.log('✓ FRESH POLICY: Learning is working');
  console.log(`  Fresh learned ${(fresh.killRate*100).toFixed(0)}% kill rate in 100 eps`);
  console.log('  This means retraining from scratch will work');
} else {
  console.log('✗ LEARNING ISSUE: Fresh policy not improving');
  console.log('  Problem: Reward signal or observation space issue');
}
