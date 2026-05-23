/**
 * RL4 REINFORCE Trainer: Multi-entity direct control.
 *
 * Trains a shared policy to control different entity types (wolves, cats, etc.)
 * using direct control (movement + abilities) in a unified action space.
 *
 * One episode = spawn agent + enemies → roll out → collect experience → update policy.
 */

import { Rng } from './rng';
import { Policy4, reinforceUpdate4, serializePolicy4, deserializePolicy4, type Step4 } from './policy4';
import { createEnv4, spawn4, observe4, act4, step4, computeReward4 } from './env4';
import type { EnvConfig, Archetype } from './types';

export interface TrainConfig4 {
  episodes: number;
  stepsPerEpisode: number;
  decisionInterval: number; // steps between decisions
  agents: number; // number of controlled entities per episode
  agentType: Archetype; // type of agents to train
  enemies: Array<{ type: Archetype; count: number }>; // enemies to spawn
  seed: number;
  logEvery: number;
  log?: (msg: string) => void;
  /** Max distance enemies spawn from the agent (radius). Smaller = easier
   *  scenario; gradient signal from contact reward is much stronger when
   *  random actions still produce occasional collisions. */
  spawnRadius: number;
  /** Cap agent spawn jitter so the curriculum's spawnRadius is meaningful
   *  (otherwise agent + enemy randomness can put them 20m apart even at
   *  spawnRadius=3). */
  agentSpawnJitter: number;
}

export const DEFAULT_TRAIN_CONFIG4: TrainConfig4 = {
  episodes: 100,
  stepsPerEpisode: 300,
  decisionInterval: 5,
  agents: 1,
  agentType: 'wolf',
  enemies: [
    { type: 'wolf', count: 2 },
  ],
  seed: 42,
  logEvery: 10,
  spawnRadius: 8,
  agentSpawnJitter: 2,
};

export interface TrainResult4 {
  policy: Policy4;
  history: Array<{ ep: number; episodeReward: number }>;
  /** Best episode return seen and which episode produced it. */
  best: { ep: number; episodeReward: number };
}

export async function train4(
  config: Partial<TrainConfig4> = {},
  envCfg: Partial<EnvConfig> = {},
  onProgress?: (ep: number, reward: number) => void,
  /** Optional: receives a deep-copied snapshot of the policy whenever a new
   *  best episode return is seen. Caller uses this for "best checkpoint"
   *  semantics — the final policy is often worse due to REINFORCE noise. */
  onBest?: (snapshot: Policy4, ep: number, reward: number) => void,
): Promise<TrainResult4> {
  const cfg = { ...DEFAULT_TRAIN_CONFIG4, ...config };
  const policy = new Policy4({}, new Rng(cfg.seed));
  const history: Array<{ ep: number; episodeReward: number }> = [];
  let best = { ep: -1, episodeReward: -Infinity };

  for (let ep = 0; ep < cfg.episodes; ep++) {
    const env4 = createEnv4(envCfg, cfg.seed + ep);
    const agents: Array<{ entity: any; traj: Step4[] }> = [];

    // Agent spawn — kept near origin so spawnRadius is the dominant signal.
    const aj = cfg.agentSpawnJitter;
    for (let i = 0; i < cfg.agents; i++) {
      const agent = spawn4(env4, {
        archetype: cfg.agentType,
        team: 'predator',
        x: (Math.random() - 0.5) * 2 * aj,
        z: (Math.random() - 0.5) * 2 * aj,
        hp: 100,
        maxHp: 100,
        size: 1.0,
        speed: 8,
        attackCooldown: 0.3,
      });
      agents.push({ entity: agent, traj: [] });
    }

    // Enemy spawn — randomized within `spawnRadius` of the origin. Curriculum
    // tightens this for early stages so REINFORCE actually sees kill signal.
    const radius = cfg.spawnRadius;
    for (const { type, count } of cfg.enemies) {
      for (let i = 0; i < count; i++) {
        // Uniform within disc of given radius.
        const ang = Math.random() * Math.PI * 2;
        const r = radius * Math.sqrt(Math.random());
        spawn4(env4, {
          archetype: type,
          team: 'prey',
          x: Math.cos(ang) * r,
          z: Math.sin(ang) * r,
          hp: 60,
          maxHp: 60,
          size: 0.8,
          speed: 6,
          attackCooldown: 0.5,
        });
      }
    }

    // Roll out episode.
    for (let step = 0; step < cfg.stepsPerEpisode; step++) {
      // Decision step: sample actions from policy for each agent.
      if (step % cfg.decisionInterval === 0) {
        for (const { entity: agent, traj } of agents) {
          if (!agent.alive) continue;
          const state = observe4(env4, agent);
          // Save *actual* hidden activations from the forward pass. Previously
          // we stored a zero array here, which silently zeroed the W2 gradient
          // and prevented the hidden layer from ever learning.
          const { probs, hidden } = policy.forward(state, 1.0);

          // Sample action from policy.
          let r = Math.random();
          let action = 0;
          for (let a = 0; a < probs.length; a++) {
            r -= probs[a];
            if (r < 0) { action = a; break; }
          }

          // Execute action.
          act4(env4, agent, action, env4.env.config.dt);

          // Store step for learning.
          const reward = computeReward4(env4, agent);
          traj.push({
            state,
            hidden,
            probs,
            action,
            reward,
            temperature: 1.0,
          });
        }
      }

      // Physics step for all entities.
      step4(env4, env4.env.config.dt);
    }

    // Compute episode return and update policy.
    let episodeReturn = 0;
    for (const { traj } of agents) {
      if (traj.length > 0) {
        const ret = reinforceUpdate4(policy, traj);
        episodeReturn += ret;
      }
    }
    episodeReturn /= agents.length || 1;
    history.push({ ep, episodeReward: episodeReturn });

    // Track best episode and hand a snapshot to caller. We deep-clone the
    // policy weights so subsequent updates can't mutate the saved snapshot.
    if (episodeReturn > best.episodeReward) {
      best = { ep, episodeReward: episodeReturn };
      if (onBest) onBest(clonePolicy4(policy), ep, episodeReturn);
    }

    if (cfg.logEvery && ep % cfg.logEvery === 0) {
      const msg = `Episode ${ep} | Return: ${episodeReturn.toFixed(2)} | best ${best.episodeReward.toFixed(2)} @${best.ep}`;
      if (cfg.log) cfg.log(msg);
      else console.log(msg);
    }
    if (onProgress) onProgress(ep, episodeReturn);
  }

  return { policy, history, best };
}

function clonePolicy4(p: Policy4): Policy4 {
  // Cheapest deep copy — JSON roundtrip survives every weight matrix shape.
  return deserializePolicy4(serializePolicy4(p));
}
