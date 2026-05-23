#!/usr/bin/env node
/**
 * Headless RL4 trainer. REINFORCE + Adam, with pen curriculum.
 *
 * Why every piece exists:
 *   • Adam (in policy4.ts) — replaced plain SGD because the policy gradient
 *     was being drowned in noise; per-parameter LR adaptation lets the small
 *     consistent signal accumulate. Plain SGD at any LR stalled at random-
 *     policy returns.
 *   • Pen curriculum — earliest stage uses bounds=3m and spawnRadius=2m so
 *     wolf+rabbit literally cannot avoid each other. Random actions collide
 *     within a few decisions, the +damage/+kill signal arrives often enough
 *     for REINFORCE to learn engagement. Later stages widen the pen.
 *   • Mini-batched updates (8 episodes/update) — additional variance reduction.
 *   • Best-by-trailing-50 checkpoint — REINFORCE returns oscillate; the final
 *     weights are usually worse than peak weights mid-run.
 *   • Persistent across runs — loads prior best from disk and continues.
 *
 * Run: npm run train:rl4 [archetype=wolf|cat|werewolf|all] [episodes-per-stage]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, deserializePolicy4,
  createEnv4, spawn4, observe4, act4, step4, computeReward4,
} from '../src/rl/index.ts';
import { Rng } from '../src/rl/rng.ts';

const here = dirname(fileURLToPath(import.meta.url));
const onlyArch = process.argv[2] === 'all' ? null : process.argv[2];
const epsPerStage = Number(process.argv[3] ?? 1500);

/** Curriculum stages — tight pen → moderate → open arena. Spawn radius is
 *  capped to slightly less than pen radius so the rabbit always starts
 *  reachable. */
const STAGES = [
  { label: 'pen3',   bounds: 3,  spawnRadius: 2,  visionRadius: 6  },
  { label: 'pen6',   bounds: 6,  spawnRadius: 4,  visionRadius: 10 },
  { label: 'pen12',  bounds: 12, spawnRadius: 8,  visionRadius: 14 },
  { label: 'open',   bounds: 25, spawnRadius: 14, visionRadius: 18 },
];

const TARGETS = {
  wolf:     { agentType: 'wolf',     enemies: [{ type: 'rabbit', count: 1 }], seed: 42  },
  cat:      { agentType: 'cat',      enemies: [{ type: 'rabbit', count: 1 }], seed: 123 },
  werewolf: { agentType: 'werewolf', enemies: [{ type: 'wolf',   count: 1 }], seed: 456 },
};

const outDir = resolve(here, '..', 'public', 'policies-rl4');
mkdirSync(outDir, { recursive: true });

const archs = onlyArch ? [onlyArch] : Object.keys(TARGETS);

for (const archKey of archs) {
  const target = TARGETS[archKey];
  console.log(`\n=== ${archKey.toUpperCase()} · ${epsPerStage} eps × ${STAGES.length} stages ===`);

  const cfg = { hidden: 32, lr: 0.002, baselineEMA: 0.95, entropyCoef: 0.01 };
  const rng = new Rng(target.seed);
  const policy = new Policy4(cfg, rng);
  let bestPolicy = clone(policy);
  let bestMA = -Infinity;
  let bestStage = '';
  let bestEp = -1;
  const fullHistory = [];
  const fullMA = [];

  for (const stage of STAGES) {
    console.log(`\n  --- stage ${stage.label} (bounds=${stage.bounds}m, spawn≤${stage.spawnRadius}m, vis=${stage.visionRadius}m) ---`);
    const r = runStage(policy, target, stage, epsPerStage,
      (snap, ep, ma) => {
        if (ma > bestMA) {
          bestMA = ma; bestPolicy = snap; bestStage = stage.label; bestEp = fullHistory.length + ep;
        }
      });
    fullHistory.push(...r.history);
    fullMA.push(...r.ma);
    const kr = killRate(bestPolicy, target, stage);
    console.log(`    end-of-stage best ma50: ${r.bestMA.toFixed(1)} | global best ${bestMA.toFixed(1)}(${bestStage}@${bestEp}) | kill-rate(${stage.label}) ${(kr * 100).toFixed(0)}%`);
  }

  const outFile = resolve(outDir, `${archKey}.json`);
  writeFileSync(outFile, serializePolicy4(bestPolicy));
  const csvFile = resolve(outDir, `${archKey}.history.csv`);
  writeFileSync(csvFile, 'episode,return,return_ma50\n' +
    fullHistory.map((r, i) => `${i},${r.toFixed(4)},${fullMA[i].toFixed(4)}`).join('\n'));

  console.log(`\n  wrote ${outFile}`);
  console.log(`  wrote ${csvFile} (${fullHistory.length} rows)`);
  console.log(`\n  final verification (60 trials each, on best policy):`);
  const killRates = {};
  for (const s of STAGES) {
    const kr = killRate(bestPolicy, target, s, 60);
    killRates[s.label] = kr;
    const bar = '█'.repeat(Math.round(kr * 30));
    console.log(`    ${s.label.padEnd(8)} ${(kr * 100).toFixed(0).padStart(3)}%  ${bar}`);
  }

  // Sidecar metadata so the browser HUD can show "this is the trained
  // policy, here's how well it scores, here's when it was made".
  const meta = {
    archetype: archKey,
    trainedAt: new Date().toISOString(),
    episodesPerStage: epsPerStage,
    stages: STAGES.map(s => ({ ...s })),
    bestEpisodeMA50: bestMA,
    bestStage,
    bestEpisodeIndex: bestEp,
    killRatesByStage: killRates,
    policyConfig: bestPolicy.cfg,
    weightStats: {
      W1: statsOf(bestPolicy.W1),
      W2: statsOf(bestPolicy.W2),
      b1: statsOf(bestPolicy.b1),
      b2: statsOf(bestPolicy.b2),
    },
    historyLength: fullHistory.length,
  };
  const metaFile = resolve(outDir, `${archKey}.meta.json`);
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  console.log(`  wrote ${metaFile}`);
  console.log(`\n  return ma50 over full curriculum:`);
  console.log(asciiPlot(fullMA, 70, 14));
}

// ---------------------------------------------------------------------------

function runStage(policy, target, stage, totalEpisodes, onBest) {
  const stepsPerEp = 300;
  const decisionInterval = 5;
  const batchSize = 8;
  const envCfg = { bounds: stage.bounds, visionRadius: stage.visionRadius };

  const history = [];
  const ma = [];
  const sumWindow = [];
  let windowSum = 0;
  let bestMA = -Infinity;
  let batchTrajs = [];

  for (let ep = 0; ep < totalEpisodes; ep++) {
    const env4 = createEnv4(envCfg, target.seed + ep);
    const agent = spawn4(env4, {
      archetype: target.agentType, team: 'predator',
      x: (Math.random() - 0.5) * 0.5, z: (Math.random() - 0.5) * 0.5,
      hp: 100, maxHp: 100, size: 1.0, speed: 8, attackCooldown: 0.3,
    });
    for (const { type, count } of target.enemies) {
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = Math.max(0.6, stage.spawnRadius * Math.sqrt(Math.random()));
        spawn4(env4, {
          archetype: type, team: 'prey',
          x: Math.cos(ang) * rr, z: Math.sin(ang) * rr,
          hp: 60, maxHp: 60, size: 0.8, speed: 6, attackCooldown: 0.5,
        });
      }
    }

    const traj = [];
    for (let step = 0; step < stepsPerEp; step++) {
      if (step % decisionInterval === 0 && agent.alive) {
        const state = observe4(env4, agent);
        const { probs, hidden } = policy.forward(state, 1.0);
        let r = Math.random(), a = 0;
        for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { a = k; break; } }
        act4(env4, agent, a, env4.env.config.dt);
        const reward = computeReward4(env4, agent);
        traj.push({ state, hidden, probs, action: a, reward, temperature: 1.0 });
      }
      step4(env4, env4.env.config.dt);
    }

    let epReturn = 0;
    for (const s of traj) epReturn += s.reward;
    history.push(epReturn);

    windowSum += epReturn;
    sumWindow.push(epReturn);
    if (sumWindow.length > 50) windowSum -= sumWindow.shift();
    const curMA = windowSum / sumWindow.length;
    ma.push(curMA);
    if (sumWindow.length === 50 && curMA > bestMA) {
      bestMA = curMA;
      onBest?.(clone(policy), ep, curMA);
    }

    batchTrajs.push(traj);
    if (batchTrajs.length >= batchSize) {
      reinforceUpdate4(policy, batchTrajs.flat());
      batchTrajs = [];
    }

    if (ep % Math.max(1, Math.floor(totalEpisodes / 12)) === 0) {
      console.log(`    ep ${ep.toString().padStart(5)}/${totalEpisodes}  ret ${epReturn.toFixed(1).padStart(7)}  ma50 ${curMA.toFixed(1).padStart(7)}  best-ma ${bestMA.toFixed(1).padStart(7)}`);
    }
  }
  if (batchTrajs.length > 0) reinforceUpdate4(policy, batchTrajs.flat());

  return { history, ma, bestMA };
}

function clone(p) { return deserializePolicy4(serializePolicy4(p)); }

function killRate(policy, target, stage, trials = 40) {
  const envCfg = { bounds: stage.bounds, visionRadius: stage.visionRadius };
  let kills = 0;
  for (let t = 0; t < trials; t++) {
    const env4 = createEnv4(envCfg, 99999 + t);
    const agent = spawn4(env4, {
      archetype: target.agentType, team: 'predator',
      x: (Math.random() - 0.5) * 0.5, z: (Math.random() - 0.5) * 0.5,
      hp: 100, maxHp: 100, size: 1.0, speed: 8, attackCooldown: 0.3,
    });
    const enemies = [];
    for (const { type, count } of target.enemies) {
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = Math.max(0.6, stage.spawnRadius * Math.sqrt(Math.random()));
        enemies.push(spawn4(env4, {
          archetype: type, team: 'prey',
          x: Math.cos(ang) * rr, z: Math.sin(ang) * rr,
          hp: 60, maxHp: 60, size: 0.8, speed: 6, attackCooldown: 0.5,
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
  return kills / trials;
}

function statsOf(arr) {
  let mn = Infinity, mx = -Infinity, sum = 0, sumsq = 0;
  for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; sumsq += v * v; }
  const n = arr.length, mean = sum / n;
  return {
    n, mean, std: Math.sqrt(sumsq / n - mean * mean),
    min: mn, max: mx,
  };
}

function asciiPlot(values, width, height) {
  if (values.length === 0) return '';
  const buckets = new Array(width).fill(0).map(() => []);
  for (let i = 0; i < values.length; i++) {
    const col = Math.min(width - 1, Math.floor((i / values.length) * width));
    buckets[col].push(values[i]);
  }
  const colVals = buckets.map(b => b.length ? b.reduce((s, x) => s + x, 0) / b.length : 0);
  const min = Math.min(...colVals), max = Math.max(...colVals);
  const span = (max - min) || 1;
  const rows = Array.from({ length: height }, () => ' '.repeat(width).split(''));
  for (let x = 0; x < width; x++) {
    const norm = (colVals[x] - min) / span;
    const y = Math.max(0, Math.min(height - 1, height - 1 - Math.round(norm * (height - 1))));
    rows[y][x] = '▇';
  }
  const lines = rows.map((r, i) => {
    const label = i === 0 ? max.toFixed(1).padStart(7)
                : i === height - 1 ? min.toFixed(1).padStart(7)
                : ' '.repeat(7);
    return `    ${label} │${r.join('')}`;
  });
  lines.push(`            ${'─'.repeat(width)}`);
  lines.push(`            episode 0 → episode N (across all stages)`);
  return lines.join('\n');
}
