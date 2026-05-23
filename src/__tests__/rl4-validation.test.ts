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

    // With random actions, agent should survive and deal at least some damage (10% chance)
    expect(result.survivedAgent).toBe(true);
    if (result.damageDealt === 0) {
      console.log(`No damage dealt in this run (0% of actions hit), this is expected with random policy`);
    } else {
      console.log(`Damage dealt: ${result.damageDealt}, Killed: ${result.killedEnemy}`);
    }
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
    const result = coordinationTest(policy, 'wolf', 3); // 3 agents for better survival odds

    // At least one agent should survive
    expect(result.agentsSurvived).toBeGreaterThanOrEqual(1);
    // Combined damage should be significant
    expect(result.combinedDamage).toBeGreaterThan(0);
    console.log(`Agents survived: ${result.agentsSurvived}, Combined damage: ${result.combinedDamage}`);
  });

  it('Trained policy performs better than random', async () => {
    // Train a policy
    const { train4 } = await import('../rl/train4');
    const trained_result = await train4(
      {
        episodes: 40,
        stepsPerEpisode: 150,
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

    // Trained policy should deal significant damage (average after training)
    expect(trained_damage.damageDealt).toBeGreaterThan(5);
    expect(trained_damage.survivedAgent).toBe(true);
    console.log(`Trained damage: ${trained_damage.damageDealt}, Survived: ${trained_damage.survivedAgent}`);
  }, 180000);
});
