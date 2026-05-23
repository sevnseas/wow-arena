/**
 * RL4 Training runner: Train and save a policy.
 * Can be run standalone or imported as a module.
 */

import { train4, type TrainConfig4 } from './train4';
import { serializePolicy4 } from './policy4';

export async function runTraining(
  config: Partial<TrainConfig4> = {},
): Promise<string> {
  const fullConfig: Partial<TrainConfig4> = {
    episodes: 100,
    stepsPerEpisode: 200,
    decisionInterval: 5,
    agents: 2,
    agentType: 'wolf',
    enemies: [{ type: 'cat', count: 2 }],
    seed: 42,
    logEvery: 10,
    ...config,
  };

  console.log('Starting RL4 training with config:', fullConfig);
  const result = await train4(fullConfig, {});

  const serialized = serializePolicy4(result.policy);
  console.log(`Training complete. Serialized policy size: ${serialized.length} bytes`);
  console.log(`Final return: ${result.history[result.history.length - 1]?.episodeReward || 'N/A'}`);

  return serialized;
}

// Export a trained policy in local storage format
export function getSampleTrainedPolicy(): string {
  // This is a pre-trained policy that can be used for testing
  // In production, this would be replaced with an actual trained policy
  const SAMPLE_POLICY = {
    cfg: { hidden: 64, lr: 0.01, baselineEMA: 0.95, entropyCoef: 0.01 },
    W1: new Array(140 * 64).fill(0.01),
    b1: new Array(64).fill(0),
    W2: new Array(64 * 11).fill(0.01),
    b2: new Array(11).fill(0),
    baseline: 0.5,
  };
  return JSON.stringify(SAMPLE_POLICY);
}
