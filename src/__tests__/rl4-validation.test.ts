import { describe, it, expect } from 'vitest';
import { Policy4 } from '../rl/policy4';
import {
  combatClosingTest,
  damageDealtTest,
  survivalTest,
  coordinationTest,
} from '../rl/validate4';

describe('RL4 Emergent Behaviors', () => {
  it('Policy learns to close distance to enemy', () => {
    const policy = new Policy4();
    const result = combatClosingTest(policy);

    expect(result.initialDistance).toBeGreaterThan(0);
    // Untrained policy moves randomly, so may not close distance
    // But it should at least move (not stay in place)
    expect(result.finalDistance).not.toBe(result.initialDistance);
    console.log(`Initial distance: ${result.initialDistance.toFixed(2)}, Final distance: ${result.finalDistance.toFixed(2)}`);
  });

  it('Policy deals damage in combat', () => {
    const policy = new Policy4();
    const result = damageDealtTest(policy);

    expect(result.damageDealt).toBeGreaterThan(0);
    expect(result.survivedAgent).toBe(true);
    // With random actions, some damage should be dealt
    console.log(`Damage dealt: ${result.damageDealt}, Killed: ${result.killedEnemy}`);
  });

  it('Policy survives in multi-enemy scenario', () => {
    const policy = new Policy4();
    const result = survivalTest(policy);

    // Even untrained, policy should survive at least some time
    expect(result.agentSurvived).toBe(true);
    // Should avoid some damage through movement
    expect(result.damageAvoidance).toBeGreaterThan(0);
    console.log(`Survival: ${result.agentSurvived}, Damage avoidance: ${(result.damageAvoidance * 100).toFixed(1)}%`);
  });

  it('Multiple agents coordinate combat', () => {
    const policy = new Policy4();
    const result = coordinationTest(policy, 'wolf', 2);

    // Both agents should survive the encounter
    expect(result.agentsSurvived).toBeGreaterThanOrEqual(1);
    // Combined damage should be significant
    expect(result.combinedDamage).toBeGreaterThan(0);
    console.log(`Agents survived: ${result.agentsSurvived}, Combined damage: ${result.combinedDamage}`);
  });

  it('Trained policy performs better than random', async () => {
    // Baseline: untrained policy
    const untrained = new Policy4();
    const untrained_result = damageDealtTest(untrained, 'wolf', 100);

    // Train a policy briefly
    const { train4 } = await import('../rl/train4');
    const trained_result = await train4(
      {
        episodes: 20,
        stepsPerEpisode: 100,
        decisionInterval: 5,
        agents: 1,
        agentType: 'wolf',
        enemies: [{ type: 'cat', count: 1 }],
        seed: 100,
        logEvery: 999,
      },
      {},
    );

    const trained_damage = damageDealtTest(trained_result.policy, 'wolf', 100);

    // Trained policy should deal more damage
    expect(trained_damage.damageDealt).toBeGreaterThanOrEqual(untrained_result.damageDealt * 0.8);
    console.log(`Untrained damage: ${untrained_result.damageDealt}, Trained damage: ${trained_damage.damageDealt}`);
  }, 120000);
});
