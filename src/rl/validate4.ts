/**
 * RL4 Validation suite: Check for emergent behaviors in direct control policies.
 *
 * Tests verify that trained policies learn to:
 * - Close distance to enemies
 * - Deal damage through combat
 * - Survive by avoiding attacks
 * - Coordinate (in multi-agent setups)
 */

import { createEnv4, spawn4, observe4, act4, step4, computeReward4 } from './env4';
import { Policy4 } from './policy4';
import type { Archetype } from './types';

export interface CombatClosingResult {
  initialDistance: number;
  finalDistance: number;
  closed: boolean;
}

/** Verify policy closes distance to a stationary target. */
export function combatClosingTest(
  policy: Policy4,
  agentType: Archetype = 'wolf',
  seed = 1,
): CombatClosingResult {
  const env4 = createEnv4({}, seed);
  const agent = spawn4(env4, {
    archetype: agentType,
    team: 'predator',
    x: 0,
    z: 0,
    hp: 100,
    maxHp: 100,
    size: 1.0,
    speed: 8,
    attackCooldown: 0.3,
  }) as any;
  agent.lastHp = agent.hp;
  agent.rewardThisEpisode = 0;

  const enemy = spawn4(env4, {
    archetype: 'cat',
    team: 'prey',
    x: 10,
    z: 0,
    hp: 80,
    maxHp: 80,
    size: 0.8,
    speed: 0, // stationary target
    attackCooldown: 0.5,
  });

  const initialDistance = Math.hypot(enemy.x - agent.x, enemy.z - agent.z);

  for (let step = 0; step < 200; step++) {
    const state = observe4(env4, agent);
    const { probs } = policy.forward(state);
    let action = 0;
    let r = Math.random();
    for (let a = 0; a < probs.length; a++) {
      r -= probs[a];
      if (r < 0) {
        action = a;
        break;
      }
    }
    act4(env4, agent, action, env4.env.config.dt);
    step4(env4, env4.env.config.dt);
  }

  const finalDistance = Math.hypot(enemy.x - agent.x, enemy.z - agent.z);
  return {
    initialDistance,
    finalDistance,
    closed: finalDistance < initialDistance * 0.8,
  };
}

export interface DamageDealtResult {
  damageDealt: number;
  killedEnemy: boolean;
  survivedAgent: boolean;
}

/** Verify policy deals damage to enemies. */
export function damageDealtTest(
  policy: Policy4,
  agentType: Archetype = 'wolf',
  seed = 2,
): DamageDealtResult {
  const env4 = createEnv4({}, seed);
  const agent = spawn4(env4, {
    archetype: agentType,
    team: 'predator',
    x: 0,
    z: 0,
    hp: 100,
    maxHp: 100,
    size: 1.0,
    speed: 8,
    attackCooldown: 0.3,
  }) as any;
  agent.lastHp = agent.hp;
  agent.rewardThisEpisode = 0;

  const enemy = spawn4(env4, {
    archetype: 'cat',
    team: 'prey',
    x: 2,
    z: 0,
    hp: 60,
    maxHp: 60,
    size: 0.8,
    speed: 0,
    attackCooldown: 0.5,
  });

  let totalDamageDealt = 0;

  for (let step = 0; step < 300; step++) {
    env4.env.events.length = 0;
    const state = observe4(env4, agent);
    const { probs } = policy.forward(state);
    let action = 0;
    let r = Math.random();
    for (let a = 0; a < probs.length; a++) {
      r -= probs[a];
      if (r < 0) {
        action = a;
        break;
      }
    }
    act4(env4, agent, action, env4.env.config.dt);
    step4(env4, env4.env.config.dt);

    // Count damage dealt
    for (const ev of env4.env.events) {
      if (ev.type === 'damage' && ev.attackerId === agent.id) {
        totalDamageDealt += ev.amount;
      }
    }
  }

  return {
    damageDealt: totalDamageDealt,
    killedEnemy: !enemy.alive,
    survivedAgent: agent.alive,
  };
}

export interface SurvivalResult {
  agentSurvived: boolean;
  damageAvoidance: number; // fraction of time without taking damage
}

/** Verify policy avoids damage in a combat scenario. */
export function survivalTest(
  policy: Policy4,
  agentType: Archetype = 'wolf',
  seed = 3,
): SurvivalResult {
  const env4 = createEnv4({}, seed);
  const agent = spawn4(env4, {
    archetype: agentType,
    team: 'predator',
    x: 0,
    z: 0,
    hp: 100,
    maxHp: 100,
    size: 1.0,
    speed: 8,
    attackCooldown: 0.3,
  }) as any;
  agent.lastHp = agent.hp;
  agent.rewardThisEpisode = 0;

  const enemies = [];
  for (let i = 0; i < 2; i++) {
    enemies.push(
      spawn4(env4, {
        archetype: 'cat',
        team: 'prey',
        x: 5 + i * 3,
        z: 0,
        hp: 80,
        maxHp: 80,
        size: 0.8,
        speed: 6,
        attackCooldown: 0.5,
      })
    );
  }

  let ticksWithoutDamage = 0;
  let totalTicks = 0;

  for (let step = 0; step < 400; step++) {
    env4.env.events.length = 0;
    const prevHp = agent.hp;
    const state = observe4(env4, agent);
    const { probs } = policy.forward(state);
    let action = 0;
    let r = Math.random();
    for (let a = 0; a < probs.length; a++) {
      r -= probs[a];
      if (r < 0) {
        action = a;
        break;
      }
    }
    act4(env4, agent, action, env4.env.config.dt);
    step4(env4, env4.env.config.dt);

    if (agent.alive) {
      totalTicks++;
      if (agent.hp === prevHp) {
        ticksWithoutDamage++;
      }
    } else {
      break;
    }
  }

  return {
    agentSurvived: agent.alive,
    damageAvoidance: totalTicks > 0 ? ticksWithoutDamage / totalTicks : 0,
  };
}

export interface CoordinationResult {
  agentsSurvived: number;
  combinedDamage: number;
}

/** Verify multiple agents coordinate to defeat enemies. */
export function coordinationTest(
  policy: Policy4,
  agentType: Archetype = 'wolf',
  agentCount = 2,
  seed = 4,
): CoordinationResult {
  const env4 = createEnv4({}, seed);
  const agents: Array<any> = [];

  for (let i = 0; i < agentCount; i++) {
    const agent = spawn4(env4, {
      archetype: agentType,
      team: 'predator',
      x: -3 + i * 3,
      z: 0,
      hp: 100,
      maxHp: 100,
      size: 1.0,
      speed: 8,
      attackCooldown: 0.3,
    }) as any;
    agent.lastHp = agent.hp;
    agent.rewardThisEpisode = 0;
    agents.push(agent);
  }

  const enemies = [];
  for (let i = 0; i < 1; i++) {
    enemies.push(
      spawn4(env4, {
        archetype: 'cat',
        team: 'prey',
        x: 5,
        z: 0,
        hp: 120,
        maxHp: 120,
        size: 0.8,
        speed: 4,
        attackCooldown: 0.5,
      })
    );
  }

  let totalDamage = 0;

  for (let step = 0; step < 500; step++) {
    env4.env.events.length = 0;

    for (const agent of agents) {
      if (!agent.alive) continue;
      const state = observe4(env4, agent);
      const { probs } = policy.forward(state);
      let action = 0;
      let r = Math.random();
      for (let a = 0; a < probs.length; a++) {
        r -= probs[a];
        if (r < 0) {
          action = a;
          break;
        }
      }
      act4(env4, agent, action, env4.env.config.dt);
    }

    step4(env4, env4.env.config.dt);

    for (const ev of env4.env.events) {
      if (ev.type === 'damage' && agents.some(a => a.id === ev.attackerId)) {
        totalDamage += ev.amount;
      }
    }

    if (enemies.every(e => !e.alive)) break;
  }

  return {
    agentsSurvived: agents.filter(a => a.alive).length,
    combinedDamage: totalDamage,
  };
}
