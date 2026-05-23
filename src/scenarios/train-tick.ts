/**
 * In-browser tick-speed REINFORCE trainer. Same algorithm + curriculum as
 * scripts/train-rl4.mjs but rendered live so you can watch the policy learn:
 *
 *   • Top-down 2D view of env4 (no live game packs — pure tick sim) shows
 *     the agent, the rabbit, the current pen, and the chosen-action arrow.
 *   • Loss/return charts update every batch. Pen-size chart shows the
 *     curriculum advancing each time the trailing-MA plateaus.
 *   • Kill-rate per stage prints to the log as stages complete.
 *
 * Runs as many episodes/sec as your CPU allows (target: 30+ eps/sec on the
 * tight pen). Open via scenarios.html?s=train
 */
import {
  Policy4, reinforceUpdate4, type Step4,
} from '../rl/policy4';
import {
  createEnv4, spawn4, observe4, act4, step4, computeReward4,
} from '../rl/env4';
import { Rng } from '../rl/rng';
import { ACTION_NAMES, actionToUnitVec, isMovementAction } from '../rl/runtime4';
import type { Archetype, Entity } from '../rl/types';

// Match scripts/train-rl4.mjs PHYS table exactly so browser training and
// headless training produce equivalent policies.
const PHYS: Record<string, { size: number; speed: number; attackCooldown: number; hp: number }> = {
  wolf:     { size: 0.50, speed: 4.0, attackCooldown: 0.4, hp: 60 },
  cat:      { size: 0.38, speed: 4.5, attackCooldown: 0.4, hp: 45 },
  rabbit:   { size: 0.28, speed: 2.6, attackCooldown: 1.0, hp: 30 },
  werewolf: { size: 0.75, speed: 4.6, attackCooldown: 0.5, hp: 180 },
};

const STAGES = [
  { label: 'tight',  minBounds: 1.5, maxBounds: 1.5, visionRadius: 6,  episodes: 600 },
  { label: 'mix3',   minBounds: 1.5, maxBounds: 3,   visionRadius: 8,  episodes: 600 },
  { label: 'mix6',   minBounds: 1.5, maxBounds: 6,   visionRadius: 12, episodes: 800 },
  { label: 'mix12',  minBounds: 1.5, maxBounds: 12,  visionRadius: 16, episodes: 1000 },
  { label: 'open',   minBounds: 1.5, maxBounds: 25,  visionRadius: 18, episodes: 1500 },
];

type AgentSpec = { agentType: Archetype; enemies: Array<{ type: Archetype; count: number }> };
const AGENT: Record<string, AgentSpec> = {
  wolf:     { agentType: 'wolf',     enemies: [{ type: 'rabbit', count: 1 }] },
  cat:      { agentType: 'cat',      enemies: [{ type: 'rabbit', count: 1 }] },
  werewolf: { agentType: 'werewolf', enemies: [{ type: 'wolf',   count: 1 }] },
};

export interface TrainTickHost {
  /** Called every frame with the latest env state for rendering. */
  onRender(state: {
    agent: Entity | null;
    enemies: Entity[];
    bounds: number;
    chosenAction: number | null;
  }): void;
  /** Called every episode with the latest return. */
  onEpisode(ep: number, ret: number, ma50: number, stageLabel: string, stageEp: number): void;
  /** Called when a stage completes. */
  onStageDone(stageLabel: string, killRate: number): void;
  onLog(msg: string): void;
}

export interface TrainTickHandle {
  stop(): void;
  /** Episodes per animation frame. Higher = faster but choppier UI. */
  setEpsPerFrame(n: number): void;
  /** Pause/resume training to inspect rendered state. */
  setPaused(p: boolean): void;
  policy: Policy4;
}

export function startTickTrainer(host: TrainTickHost, agentName: keyof typeof AGENT = 'wolf'): TrainTickHandle {
  const target = AGENT[agentName];
  const aph = PHYS[target.agentType];

  const cfg = { hidden: 64, lr: 0.002, baselineEMA: 0.95, entropyCoef: 0.01 };
  const rng = new Rng(42);
  const policy = new Policy4(cfg, rng);

  // Mutable training state — advancing stages is a state-machine transition.
  let stageIdx = 0;
  let stageEp = 0;
  let globalEp = 0;
  const stageHistory: number[] = [];
  const sumWindow: number[] = [];
  let windowSum = 0;
  let batchTrajs: Step4[][] = [];
  const batchSize = 8;

  // For rendering: keep latest env around so render() can read it post-tick.
  let latestAgent: Entity | null = null;
  let latestEnemies: Entity[] = [];
  let latestBounds = 1.5;
  let latestAction: number | null = null;

  let epsPerFrame = 1;
  let paused = false;
  let stopped = false;

  function runOneEpisode(): void {
    const stage = STAGES[stageIdx];
    const bounds = stage.minBounds + (stage.maxBounds - stage.minBounds) * Math.random();
    const envCfg = { bounds, visionRadius: stage.visionRadius };
    const env4 = createEnv4(envCfg, 42 + globalEp);
    const agent = spawn4(env4, {
      archetype: target.agentType, team: 'predator',
      x: (Math.random() - 0.5) * 0.5, z: (Math.random() - 0.5) * 0.5,
      hp: aph.hp, maxHp: aph.hp, size: aph.size, speed: aph.speed,
      attackCooldown: aph.attackCooldown,
    });
    const enemies: Entity[] = [];
    for (const { type, count } of target.enemies) {
      const eph = PHYS[type];
      const minSpawn = aph.size + eph.size + 0.4;
      const maxSpawn = Math.max(minSpawn + 0.1, bounds - eph.size - 0.2);
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = minSpawn + (maxSpawn - minSpawn) * Math.sqrt(Math.random());
        enemies.push(spawn4(env4, {
          archetype: type, team: 'prey',
          x: Math.cos(ang) * rr, z: Math.sin(ang) * rr,
          hp: eph.hp, maxHp: eph.hp, size: eph.size, speed: eph.speed,
          attackCooldown: eph.attackCooldown,
        }));
      }
    }

    const traj: Step4[] = [];
    const stepsPerEp = 300;
    const decisionInterval = 5;
    let lastChosen: number | null = null;
    for (let step = 0; step < stepsPerEp; step++) {
      if (step % decisionInterval === 0 && agent.alive) {
        const state = observe4(env4, agent);
        const { probs, hidden } = policy.forward(state, 1.0);
        let r = Math.random(), a = 0;
        for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { a = k; break; } }
        act4(env4, agent, a, env4.env.config.dt);
        const reward = computeReward4(env4, agent as any);
        traj.push({ state, hidden, probs, action: a, reward, temperature: 1.0 });
        lastChosen = a;
      }
      step4(env4, env4.env.config.dt);
    }
    if (traj.length > 0) traj[traj.length - 1].episodeEnd = true;

    let epReturn = 0;
    for (const s of traj) epReturn += s.reward;
    stageHistory.push(epReturn);
    windowSum += epReturn;
    sumWindow.push(epReturn);
    if (sumWindow.length > 50) windowSum -= sumWindow.shift()!;
    const ma50 = windowSum / sumWindow.length;

    batchTrajs.push(traj);
    if (batchTrajs.length >= batchSize) {
      reinforceUpdate4(policy, batchTrajs.flat());
      batchTrajs = [];
    }

    latestAgent = agent;
    latestEnemies = enemies;
    latestBounds = bounds;
    latestAction = lastChosen;

    host.onEpisode(globalEp, epReturn, ma50, stage.label, stageEp);
    globalEp++;
    stageEp++;

    if (stageEp >= stage.episodes) {
      // Stage done — evaluate kill rate at the stage's max pen.
      const kr = killRateQuick(policy, target, stage);
      host.onStageDone(stage.label, kr);
      host.onLog(`stage ${stage.label} done · kill-rate@max=${(kr * 100).toFixed(0)}% · advancing`);
      stageIdx = Math.min(STAGES.length - 1, stageIdx + 1);
      stageEp = 0;
      sumWindow.length = 0;
      windowSum = 0;
      stageHistory.length = 0;
    }
  }

  function frame() {
    if (stopped) return;
    if (!paused) {
      for (let i = 0; i < epsPerFrame; i++) runOneEpisode();
    }
    host.onRender({
      agent: latestAgent,
      enemies: latestEnemies,
      bounds: latestBounds,
      chosenAction: latestAction,
    });
    requestAnimationFrame(frame);
  }
  frame();

  return {
    stop() { stopped = true; },
    setEpsPerFrame(n) { epsPerFrame = Math.max(1, Math.min(50, Math.floor(n))); },
    setPaused(p) { paused = p; },
    policy,
  };
}

function killRateQuick(policy: Policy4, target: AgentSpec, stage: typeof STAGES[number]): number {
  const fixedBounds = stage.maxBounds;
  const envCfg = { bounds: fixedBounds, visionRadius: stage.visionRadius };
  const spawnRadius = Math.max(1, fixedBounds * 0.85);
  const aph = PHYS[target.agentType];
  let kills = 0;
  const TRIALS = 25;
  for (let t = 0; t < TRIALS; t++) {
    const env4 = createEnv4(envCfg, 99999 + t);
    const agent = spawn4(env4, {
      archetype: target.agentType, team: 'predator',
      x: (Math.random() - 0.5) * 0.5, z: (Math.random() - 0.5) * 0.5,
      hp: aph.hp, maxHp: aph.hp, size: aph.size, speed: aph.speed,
      attackCooldown: aph.attackCooldown,
    });
    const enemies: Entity[] = [];
    for (const { type, count } of target.enemies) {
      const eph = PHYS[type];
      const minSpawn = aph.size + eph.size + 0.4;
      const maxSpawn = Math.max(minSpawn + 0.1, spawnRadius);
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = minSpawn + (maxSpawn - minSpawn) * Math.sqrt(Math.random());
        enemies.push(spawn4(env4, {
          archetype: type, team: 'prey',
          x: Math.cos(ang) * rr, z: Math.sin(ang) * rr,
          hp: eph.hp, maxHp: eph.hp, size: eph.size, speed: eph.speed,
          attackCooldown: eph.attackCooldown,
        }));
      }
    }
    for (let step = 0; step < 300; step++) {
      if (step % 5 === 0 && agent.alive) {
        const { probs } = policy.forward(observe4(env4, agent), 1.0);
        let r = Math.random(), a = 0;
        for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { a = k; break; } }
        act4(env4, agent, a, env4.env.config.dt);
      }
      step4(env4, env4.env.config.dt);
      if (enemies.every(e => !e.alive)) break;
    }
    if (enemies.some(e => !e.alive)) kills++;
  }
  return kills / TRIALS;
}

export { STAGES, AGENT, ACTION_NAMES, actionToUnitVec, isMovementAction };
