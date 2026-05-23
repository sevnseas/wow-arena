/**
 * RL4 Full training pipeline: Train policies for different entity types.
 * Produces JSON serialized policies ready for web game integration.
 */

import { train4 } from './train4';
import { Policy4, serializePolicy4 } from './policy4';
import type { Archetype, EnvConfig } from './types';

export interface TrainedPolicies {
  wolf: string;
  cat: string;
  werewolf: string;
  timestamp: number;
  metadata: {
    episodes: number;
    stepsPerEpisode: number;
    finalReturns: Record<string, number>;
  };
}

export async function trainPoliciesForAllTypes(config: {
  episodes?: number;
  stepsPerEpisode?: number;
  logEvery?: number;
}  = {}): Promise<TrainedPolicies> {
  const episodes = config.episodes ?? 50;
  const stepsPerEpisode = config.stepsPerEpisode ?? 200;
  const logEvery = config.logEvery ?? 10;

  const finalReturns: Record<string, number> = {};

  console.log(`Training RL4 policies for ${episodes} episodes...`);

  // Train wolf policy (predator)
  console.log('\n=== Training Wolf Policy ===');
  const wolfResult = await train4(
    {
      episodes,
      stepsPerEpisode,
      decisionInterval: 5,
      agents: 2,
      agentType: 'wolf',
      enemies: [{ type: 'cat', count: 2 }, { type: 'rabbit', count: 1 }],
      seed: 42,
      logEvery,
    },
    {}
  );
  const wolfSerialized = serializePolicy4(wolfResult.policy);
  finalReturns.wolf = wolfResult.history[wolfResult.history.length - 1]?.episodeReward ?? 0;
  console.log(`Wolf training complete. Final return: ${finalReturns.wolf.toFixed(2)}`);

  // Train cat policy (agile predator)
  console.log('\n=== Training Cat Policy ===');
  const catResult = await train4(
    {
      episodes,
      stepsPerEpisode,
      decisionInterval: 5,
      agents: 1,
      agentType: 'cat',
      enemies: [{ type: 'rabbit', count: 3 }],
      seed: 123,
      logEvery,
    },
    {}
  );
  const catSerialized = serializePolicy4(catResult.policy);
  finalReturns.cat = catResult.history[catResult.history.length - 1]?.episodeReward ?? 0;
  console.log(`Cat training complete. Final return: ${finalReturns.cat.toFixed(2)}`);

  // Train werewolf policy (boss)
  console.log('\n=== Training Werewolf Policy ===');
  const werewolfResult = await train4(
    {
      episodes,
      stepsPerEpisode,
      decisionInterval: 5,
      agents: 1,
      agentType: 'werewolf',
      enemies: [{ type: 'wolf', count: 3 }, { type: 'cat', count: 2 }],
      seed: 456,
      logEvery,
    },
    {}
  );
  const werewolfSerialized = serializePolicy4(werewolfResult.policy);
  finalReturns.werewolf = werewolfResult.history[werewolfResult.history.length - 1]?.episodeReward ?? 0;
  console.log(`Werewolf training complete. Final return: ${finalReturns.werewolf.toFixed(2)}`);

  const result: TrainedPolicies = {
    wolf: wolfSerialized,
    cat: catSerialized,
    werewolf: werewolfSerialized,
    timestamp: Date.now(),
    metadata: {
      episodes,
      stepsPerEpisode,
      finalReturns,
    },
  };

  return result;
}

export function savePolicies(policies: TrainedPolicies): string {
  return JSON.stringify(policies, null, 2);
}

export function loadPolicies(json: string): TrainedPolicies {
  return JSON.parse(json);
}

export function getPolicyByType(policies: TrainedPolicies, type: Archetype): string {
  if (type === 'wolf') return policies.wolf;
  if (type === 'cat') return policies.cat;
  if (type === 'werewolf') return policies.werewolf;
  // Default to wolf for unknown types
  return policies.wolf;
}
