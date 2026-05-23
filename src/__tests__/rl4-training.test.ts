import { describe, it, expect } from 'vitest';
import { train4, type TrainConfig4 } from '../rl/train4';

describe('RL4 Training Pipeline', () => {
  it('Completes a short training run without crashing', async () => {
    const cfg: Partial<TrainConfig4> = {
      episodes: 5,
      stepsPerEpisode: 50,
      decisionInterval: 5,
      agents: 1,
      agentType: 'wolf',
      enemies: [{ type: 'cat', count: 1 }],
      seed: 42,
      logEvery: 10,
    };

    const result = await train4(cfg, {});
    expect(result.policy).toBeDefined();
    expect(result.history.length).toBe(5);
    expect(result.history[0].episodeReward).toBeDefined();
  }, 30000); // Increase timeout for training

  it('Runs multiple episodes and tracks returns', async () => {
    const cfg: Partial<TrainConfig4> = {
      episodes: 10,
      stepsPerEpisode: 100,
      decisionInterval: 5,
      agents: 2,
      agentType: 'wolf',
      enemies: [{ type: 'cat', count: 2 }],
      seed: 123,
      logEvery: 999,
    };

    const result = await train4(cfg, {});

    // Verify we got results for all episodes
    expect(result.history.length).toBe(10);
    // All returns should be finite numbers
    for (const entry of result.history) {
      expect(isFinite(entry.episodeReward)).toBe(true);
    }
  }, 60000);
});
