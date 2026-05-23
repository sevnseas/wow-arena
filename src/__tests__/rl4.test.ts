import { describe, it, expect } from 'vitest';
import {
  Action, ACTION_COUNT, STATE_DIM_RL4, MAX_ENTITIES_RL4,
  type Archetype,
} from '../rl/types';
import { Policy4, reinforceUpdate4, type Step4 } from '../rl/policy4';
import { createEnv4, spawn4, observe4, act4, step4, computeReward4 } from '../rl/env4';

describe('RL4 Direct Control', () => {
  it('Action enum has 11 discrete actions', () => {
    expect(ACTION_COUNT).toBe(11);
    expect(Action.MoveForward).toBe(0);
    expect(Action.Ability3).toBe(10);
  });

  it('Observation space is correct size', () => {
    expect(STATE_DIM_RL4).toBe(MAX_ENTITIES_RL4 * 7);
  });

  it('Policy4 forward pass produces valid probabilities', () => {
    const p = new Policy4();
    const state = new Float32Array(STATE_DIM_RL4).fill(0.5);
    const { probs } = p.forward(state);
    expect(probs.length).toBe(ACTION_COUNT);
    const sum = Array.from(probs).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    for (const x of probs) expect(x).toBeGreaterThanOrEqual(0);
  });

  it('REINFORCE learns to prefer rewarded actions', () => {
    const p = new Policy4({ lr: 0.1, entropyCoef: 0 });
    const state = new Float32Array(STATE_DIM_RL4).fill(0.5);
    const targetAction = Action.MoveForward;
    for (let it = 0; it < 30; it++) {
      const { probs, hidden } = p.forward(state);
      const traj: Step4[] = [{
        state: new Float32Array(state),
        hidden,
        probs,
        action: targetAction,
        reward: 1.0,
        temperature: 1.0,
      }];
      reinforceUpdate4(p, traj);
    }
    const finalProbs = p.forward(state).probs;
    expect(finalProbs[targetAction]).toBeGreaterThan(0.3);
  });

  it('Creates environment with entities', () => {
    const env4 = createEnv4({}, 42);
    const agent = spawn4(env4, {
      archetype: 'wolf' as Archetype,
      team: 'predator',
      x: 0,
      z: 0,
      hp: 100,
      maxHp: 100,
      size: 1.0,
      speed: 8,
      attackCooldown: 0.3,
    });
    expect(agent.alive).toBe(true);
    expect(agent.hp).toBe(100);
    expect(env4.entities.length).toBe(1);
  });

  it('Observation captures nearby entities', () => {
    const env4 = createEnv4({}, 42);
    const agent = spawn4(env4, {
      archetype: 'wolf' as Archetype,
      team: 'predator',
      x: 0,
      z: 0,
      hp: 100,
      maxHp: 100,
      size: 1.0,
      speed: 8,
      attackCooldown: 0.3,
    });
    spawn4(env4, {
      archetype: 'cat' as Archetype,
      team: 'prey',
      x: 5,
      z: 0,
      hp: 60,
      maxHp: 60,
      size: 0.8,
      speed: 6,
      attackCooldown: 0.5,
    });
    const state = observe4(env4, agent);
    expect(state.length).toBe(STATE_DIM_RL4);
    // First entity should have non-zero position values
    const relX = state[0];
    expect(Math.abs(relX)).toBeGreaterThan(0.1); // Should be ~0.28 (5/18)
  });

  it('Actions change entity velocity', () => {
    const env4 = createEnv4({}, 42);
    const agent = spawn4(env4, {
      archetype: 'wolf' as Archetype,
      team: 'predator',
      x: 0,
      z: 0,
      hp: 100,
      maxHp: 100,
      size: 1.0,
      speed: 8,
      attackCooldown: 0.3,
    });
    const dt = 0.1;
    const initialX = agent.x;
    act4(env4, agent, Action.MoveForward, dt);
    step4(env4, dt);
    expect(agent.z).toBeGreaterThan(initialX); // Moved in +Z direction
  });

  it('Combat damage is applied', () => {
    const env4 = createEnv4({}, 42);
    const attacker = spawn4(env4, {
      archetype: 'wolf' as Archetype,
      team: 'predator',
      x: 0,
      z: 0,
      hp: 100,
      maxHp: 100,
      size: 1.0,
      speed: 8,
      attackCooldown: 0.1,
    });
    const victim = spawn4(env4, {
      archetype: 'cat' as Archetype,
      team: 'prey',
      x: 0.5,
      z: 0,
      hp: 100,
      maxHp: 100,
      size: 0.8,
      speed: 6,
      attackCooldown: 0.5,
    });
    const initialHp = victim.hp;
    for (let i = 0; i < 10; i++) {
      act4(env4, attacker, Action.MoveForward, 0.1);
      step4(env4, 0.1);
    }
    expect(victim.hp).toBeLessThan(initialHp);
  });

  it('Computes rewards correctly', () => {
    const env4 = createEnv4({}, 42);
    const agent = spawn4(env4, {
      archetype: 'wolf' as Archetype,
      team: 'predator',
      x: 0,
      z: 0,
      hp: 100,
      maxHp: 100,
      size: 1.0,
      speed: 8,
      attackCooldown: 0.3,
    }) as any;
    agent.lastHp = 100;
    agent.rewardThisEpisode = 0;
    const reward = computeReward4(env4, agent);
    expect(reward).toBeGreaterThan(0); // Survival reward
  });
});
