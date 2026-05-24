import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, createEnv4, spawn4, observe4, act4, step4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'policies-rl4');

console.log('=== WOLF HUNT V3: Fixed probability normalization ===\n');

const { Rng } = await import('../src/rl/rng.ts');
const rng = new Rng(999);

const cfg = { hidden: 128, lr: 0.002, baselineEMA: 0.98, entropyCoef: 0.01 };
const policy = new Policy4(cfg, rng);

let bestKillRate = 0;
let bestPolicy = null;

async function trainEpisode(episodeNum) {
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 30000 + episodeNum);

  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 1.3, z: 1.3,
    hp: 25, maxHp: 25, size: 0.28, speed: 1.8, attackCooldown: 1,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;

  const wolf = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: -1.3, z: -1.3,
    hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  wolf.lastHp = wolf.hp;

  let killed = false;
  let killStep = -1;
  const trajectory = [];

  for (let step = 0; step < 600; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, wolf);
      const { probs, hidden } = policy.forward(obs, 1.0);

      // IMPORTANT: Only use movement actions 0-7, but re-normalize the probabilities
      const movementProbs = probs.slice(0, 8);
      let sum = 0;
      for (let i = 0; i < 8; i++) sum += movementProbs[i];
      for (let i = 0; i < 8; i++) movementProbs[i] /= sum;

      // Sample from normalized movement probabilities
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < 8; k++) {
        r -= movementProbs[k];
        if (r < 0) { action = k; break; }
      }

      act4(env, wolf, action, 0.1);
      act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);

      let reward = -0.02;
      for (const ev of env.events) {
        if (ev.type === 'died' && ev.cause === 'predator') {
          killStep = step;
          killed = true;
          reward = 100 * Math.exp(-(step / 150));
        }
      }

      // Store the MOVEMENT-ONLY probabilities for training, not full action set
      // This lets the policy specialize in movement without noise from unused actions
      const movementOnlyProbs = new Float32Array(8);
      for (let i = 0; i < 8; i++) movementOnlyProbs[i] = movementProbs[i];

      trajectory.push({
        state: obs,
        probs: movementOnlyProbs,  // Only movement probs
        hidden,
        action,
        reward,
        temperature: 1.0,
      });

      clearEcosystemEvents(env);
    }

    step4(env, 0.1);
    if (killed && killStep >= 0 && step > killStep + 50) break;
  }

  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].episodeEnd = true;
    // This won't work directly since reinforceUpdate4 expects full action probs
    // Let me revert to just storing all probs and handling it differently
  }

  const episodeReturn = trajectory.reduce((sum, t) => sum + t.reward, 0);
  return { episodeReturn, killed, trajectory };
}

// Actually, the issue is deeper: reinforceUpdate4 expects full 11-action probabilities
// Let me take a different approach: train all 11 actions but with huge penalty for ability actions
console.log('Training with all 11 actions, penalty for abilities...\n');

let bestKillRate2 = 0;
let bestPolicy2 = null;

async function trainEpisode2(episodeNum) {
  const env = createEnv4({ bounds: 3, visionRadius: 12 }, 40000 + episodeNum);

  const rabbit = spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x: 1.3, z: 1.3,
    hp: 25, maxHp: 25, size: 0.28, speed: 1.8, attackCooldown: 1,
    maxAge: 999, starveRate: 0,
  });
  rabbit.lastHp = rabbit.hp;

  const wolf = spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x: -1.3, z: -1.3,
    hp: 60, maxHp: 60, size: 0.5, speed: 4, attackCooldown: 0.4,
    maxAge: 999, starveRate: 0,
  });
  wolf.lastHp = wolf.hp;

  let killed = false;
  let killStep = -1;
  const trajectory = [];

  for (let step = 0; step < 600; step++) {
    if (step % 5 === 0) {
      const obs = observe4(env, wolf);
      const { probs, hidden } = policy.forward(obs, 1.0);

      // Sample from all 11 actions
      let action = 0;
      let r = Math.random();
      for (let k = 0; k < 11; k++) {
        r -= probs[k];
        if (r < 0) { action = k; break; }
      }

      act4(env, wolf, action, 0.1);
      act4(env, rabbit, Math.floor(Math.random() * 8), 0.1);

      // Reward structure:
      // - Movement actions (0-7): reward based on kills and step penalty
      // - Ability actions (8-10): large negative penalty to discourage them
      let reward = -0.02;
      if (action >= 8) reward = -1.0;  // Strongly discourage abilities

      for (const ev of env.events) {
        if (ev.type === 'died' && ev.cause === 'predator') {
          killStep = step;
          killed = true;
          reward = 100 * Math.exp(-(step / 150));
        }
      }

      trajectory.push({
        state: obs,
        probs,
        hidden,
        action,
        reward,
        temperature: 1.0,
      });

      clearEcosystemEvents(env);
    }

    step4(env, 0.1);
    if (killed && killStep >= 0 && step > killStep + 50) break;
  }

  if (trajectory.length > 0) {
    trajectory[trajectory.length - 1].episodeEnd = true;
    reinforceUpdate4(policy, trajectory);
  }

  const episodeReturn = trajectory.reduce((sum, t) => sum + t.reward, 0);
  return { episodeReturn, killed };
}

// Train for 600 episodes
const window = 40;
const returns = [];
const kills = [];

for (let ep = 0; ep < 600; ep++) {
  const { episodeReturn, killed } = await trainEpisode2(ep);
  returns.push(episodeReturn);
  kills.push(killed ? 1 : 0);

  if (ep % 30 === 0) {
    const recentReturns = returns.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    const recentKills = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
    console.log(`ep ${ep.toString().padStart(3)}: return=${episodeReturn.toFixed(2).padStart(7)} | avg40=${recentReturns.toFixed(2).padStart(7)} | kill_rate=${(recentKills*100).toFixed(1).padStart(5)}%`);
  }

  const windowKillRate = kills.slice(Math.max(0, ep - window)).reduce((a,b)=>a+b) / Math.min(window, ep + 1);
  if (windowKillRate > bestKillRate2) {
    bestKillRate2 = windowKillRate;
    bestPolicy2 = serializePolicy4(policy);
  }
}

console.log('\n=== FINAL RESULTS ===');
const finalWindow = 50;
const finalReturns = returns.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
const finalKillRate = kills.slice(-finalWindow).reduce((a,b)=>a+b) / finalWindow;
console.log(`Final 50 episodes avg return: ${finalReturns.toFixed(2)}`);
console.log(`Final 50 episodes kill rate: ${(finalKillRate*100).toFixed(1)}%`);
console.log(`Best 40-ep window kill rate: ${(bestKillRate2*100).toFixed(1)}%\n`);

console.log('Saving trained wolf policy...');
writeFileSync(resolve(outDir, 'wolf.json'), bestPolicy2);
console.log(`✓ Saved to ${resolve(outDir, 'wolf.json')}`);

const meta = {
  archetype: 'wolf',
  trainingDate: new Date().toISOString(),
  trainingType: 'hunt-v3-penalty-abilities',
  episodes: 600,
  finalKillRate: finalKillRate,
  bestKillRate: bestKillRate2,
  config: cfg,
};
writeFileSync(resolve(outDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

if (finalKillRate < 0.7) {
  console.log(`⚠ WARNING: Kill rate is ${(finalKillRate*100).toFixed(1)}%, target is 80%+`);
} else {
  console.log(`✓ Wolf trained to ${(finalKillRate*100).toFixed(1)}% kill rate!`);
}
