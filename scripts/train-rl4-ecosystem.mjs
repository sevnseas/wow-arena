#!/usr/bin/env node
/**
 * RL4 ecosystem trainer (ecosystem.md §curriculum). Trains separate
 * Policy4 networks for rabbit and wolf through a 5-stage curriculum
 * culminating in S5 co-training inside one shared env.
 *
 * Writes:
 *   public/policies-rl4/rabbit.json + rabbit.meta.json + rabbit.history.csv
 *   public/policies-rl4/wolf.json   + wolf.meta.json   + wolf.history.csv
 *
 * Each stage drops a fixed batch of episodes against the spawn rules
 * defined below. S1-S3 train rabbits, S4 trains wolves, and S5 trains both
 * policies inside one shared env. Best policy per archetype is the
 * trailing-MA50 best recorded during S5 (the only stage where both
 * archetypes learn against the final mix). Earlier stages train the
 * policies but their snapshots aren't candidates for deployment.
 *
 * Run: npm run train:ecosystem            # default 800 eps / stage
 *      npm run train:ecosystem 2000        # longer
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Policy4, reinforceUpdate4, serializePolicy4, deserializePolicy4,
  createEnv4, spawnGrass, spawn4, observe4, act4, step4, computeReward4,
  clearEcosystemEvents,
} from '../src/rl/index.ts';
import { Rng } from '../src/rl/rng.ts';

const here = dirname(fileURLToPath(import.meta.url));
const epsPerStage = Number(process.argv[2] ?? 800);
const outDir = resolve(here, '..', 'public', 'policies-rl4');
mkdirSync(outDir, { recursive: true });

// PHYS table aligned with the live game radii — same as train-rl4.mjs.
const PHYS = {
  rabbit: { size: 0.28, speed: 2.6, attackCooldown: 1.0, hp: 30 },
  wolf:   { size: 0.50, speed: 4.0, attackCooldown: 0.4, hp: 60 },
};

/** Curriculum from ecosystem.md §curriculum.
 *  S1: solo rabbit + grass — pure grazing.
 *  S2: rabbit + grass + age — adds lifespan + starvation pressure.
 *  S3: 2 rabbits + grass — partner reproduction unlocks.
 *  S4: 1 wolf + 1 rabbit (animate-passive) — wolf hunts to kill.
 *  S5: 4 rabbits + 2 wolves + grass — full ecosystem, both policies learn. */
const STAGES = [
  { label: 'S1-graze',   learners: ['rabbit'],         bounds: 4,  grass: 8,  rabbits: 1, wolves: 0, maxAgeR: 9999, maxAgeW: 9999, starveR: 1.0, starveW: 0.0 },
  { label: 'S2-survive', learners: ['rabbit'],         bounds: 6,  grass: 6,  rabbits: 1, wolves: 0, maxAgeR: 60,   maxAgeW: 9999, starveR: 1.0, starveW: 0.0 },
  { label: 'S3-repro',   learners: ['rabbit'],         bounds: 8,  grass: 8,  rabbits: 2, wolves: 0, maxAgeR: 60,   maxAgeW: 9999, starveR: 1.0, starveW: 0.0 },
  { label: 'S4-hunt',    learners: ['wolf'],           bounds: 10, grass: 4,  rabbits: 1, wolves: 1, maxAgeR: 60,   maxAgeW: 120,  starveR: 1.0, starveW: 0.5 },
  { label: 'S5-eco',     learners: ['rabbit', 'wolf'], bounds: 18, grass: 12, rabbits: 4, wolves: 2, maxAgeR: 60,   maxAgeW: 120,  starveR: 1.0, starveW: 0.5 },
];

const cfg = { hidden: 64, lr: 0.002, baselineEMA: 0.95, entropyCoef: 0.01 };
const rngR = new Rng(7);
const rngW = new Rng(13);
const rabbitPolicy = new Policy4(cfg, rngR);
const wolfPolicy = new Policy4(cfg, rngW);
let bestRabbit = clone(rabbitPolicy), bestRabbitMA = -Infinity, bestRabbitEp = -1;
let bestWolf = clone(wolfPolicy), bestWolfMA = -Infinity, bestWolfEp = -1;
const histRabbit = [], maRabbit = [];
const histWolf = [], maWolf = [];

console.log(`=== ECOSYSTEM TRAINING · ${epsPerStage} eps/stage ===`);

for (let si = 0; si < STAGES.length; si++) {
  const stage = STAGES[si];
  const isFinal = si === STAGES.length - 1;
  console.log(`\n--- ${stage.label} (bounds=${stage.bounds}m · ${stage.rabbits}rabbits ${stage.wolves}wolves ${stage.grass}grass) ---`);
  const result = runStage(stage, isFinal);
  histRabbit.push(...result.histR);
  histWolf.push(...result.histW);
  maRabbit.push(...result.maR);
  maWolf.push(...result.maW);
  console.log(`   end-of-stage rabbit ma50 ${result.bestRMa.toFixed(1)} · wolf ma50 ${result.bestWMa.toFixed(1)}`);
  console.log(`   stage births: ${result.births.rabbit} rabbit / ${result.births.wolf} wolf · stage kills: ${result.kills}`);
}

writeFileSync(resolve(outDir, 'rabbit.json'), serializePolicy4(bestRabbit));
writeFileSync(resolve(outDir, 'wolf.json'),   serializePolicy4(bestWolf));
writeFileSync(resolve(outDir, 'rabbit.history.csv'),
  'episode,return,return_ma50\n' + histRabbit.map((r, i) => `${i},${r.toFixed(4)},${maRabbit[i].toFixed(4)}`).join('\n'));
writeFileSync(resolve(outDir, 'wolf.history.csv'),
  'episode,return,return_ma50\n' + histWolf.map((r, i) => `${i},${r.toFixed(4)},${maWolf[i].toFixed(4)}`).join('\n'));

const meta = (arch, bestMa, bestEp, hist) => ({
  archetype: arch, trainedAt: new Date().toISOString(),
  episodesPerStage: epsPerStage,
  stages: STAGES.map(s => ({ ...s })),
  bestEpisodeMA50: bestMa,
  bestStage: 'S5-eco',
  bestEpisodeIndex: bestEp,
  policyConfig: cfg,
  historyLength: hist.length,
});
writeFileSync(resolve(outDir, 'rabbit.meta.json'), JSON.stringify(meta('rabbit', bestRabbitMA, bestRabbitEp, histRabbit), null, 2));
writeFileSync(resolve(outDir, 'wolf.meta.json'),   JSON.stringify(meta('wolf',   bestWolfMA,   bestWolfEp,   histWolf),   null, 2));
console.log(`\nwrote rabbit.json (best ma50 ${bestRabbitMA.toFixed(1)})`);
console.log(`wrote wolf.json (best ma50 ${bestWolfMA.toFixed(1)})`);
console.log(asciiPlot('rabbit', maRabbit));
console.log(asciiPlot('wolf',   maWolf));

// ---------------------------------------------------------------------------

function runStage(stage, isFinal) {
  const stepsPerEp = 600;     // longer than hunt episodes so reproduction
                              // has time to happen.
  const decisionInterval = 5;
  const batchSize = 8;
  const histR = [], histW = [], maR = [], maW = [];
  const sumWinR = [], sumWinW = [];
  let sumR = 0, sumW = 0;
  let bestRMa = -Infinity, bestWMa = -Infinity;
  let batchR = [], batchW = [];
  const births = { rabbit: 0, wolf: 0 };
  let kills = 0;
  const trainsRabbit = stage.learners.includes('rabbit');
  const trainsWolf = stage.learners.includes('wolf');

  for (let ep = 0; ep < epsPerStage; ep++) {
    const env = createEnv4({ bounds: stage.bounds, visionRadius: Math.max(6, stage.bounds * 1.4) }, 7000 + ep);
    // Scatter grass uniformly inside the pen.
    for (let i = 0; i < stage.grass; i++) {
      spawnGrass(env, (Math.random() - 0.5) * 2 * stage.bounds * 0.85,
                      (Math.random() - 0.5) * 2 * stage.bounds * 0.85);
    }
    // Spawn rabbits.
    const rabbits = [];
    for (let i = 0; i < stage.rabbits; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = (Math.random() * 0.4 + 0.2) * stage.bounds;
      const e = spawn4(env, {
        archetype: 'rabbit', team: 'prey',
        x: Math.cos(ang) * r, z: Math.sin(ang) * r,
        hp: PHYS.rabbit.hp, maxHp: PHYS.rabbit.hp,
        size: PHYS.rabbit.size, speed: PHYS.rabbit.speed,
        attackCooldown: PHYS.rabbit.attackCooldown,
        maxAge: stage.maxAgeR, starveRate: stage.starveR,
      });
      e.lastHp = e.hp; e.rewardThisEpisode = 0;
      rabbits.push(e);
    }
    // Spawn wolves.
    const wolves = [];
    for (let i = 0; i < stage.wolves; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = (Math.random() * 0.3 + 0.5) * stage.bounds;
      const e = spawn4(env, {
        archetype: 'wolf', team: 'predator',
        x: Math.cos(ang) * r, z: Math.sin(ang) * r,
        hp: PHYS.wolf.hp, maxHp: PHYS.wolf.hp,
        size: PHYS.wolf.size, speed: PHYS.wolf.speed,
        attackCooldown: PHYS.wolf.attackCooldown,
        maxAge: stage.maxAgeW, starveRate: stage.starveW,
      });
      e.lastHp = e.hp; e.rewardThisEpisode = 0;
      wolves.push(e);
    }

    // Track parents-of-newborn so we can also train the child's policy
    // from-spawn this episode. Newborns added mid-episode get steps
    // appended to the parent's trajectory class (rabbit vs wolf).
    const trajR = []; // Step4[] for any rabbit that acted this episode
    const trajW = [];

    let rabbitReturn = 0, wolfReturn = 0;
    for (let step = 0; step < stepsPerEp; step++) {
      if (step % decisionInterval === 0) {
        for (const e of env.entities) {
          if (!e.alive) continue;
          const isLearner = e.archetype === 'rabbit' ? trainsRabbit : trainsWolf;
          if (!isLearner) continue;
          const policy = e.archetype === 'rabbit' ? rabbitPolicy : wolfPolicy;
          const state = observe4(env, e);
          const { probs, hidden } = policy.forward(state, 1.0);
          let r = Math.random(), a = 0;
          for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { a = k; break; } }
          act4(env, e, a, env.env.config.dt);
          const reward = computeReward4(env, e, e.archetype === 'rabbit' ? 'rabbit' : 'wolf');
          if (e.archetype === 'rabbit') { trajR.push({ state, hidden, probs, action: a, reward, temperature: 1.0 }); rabbitReturn += reward; }
          else                          { trajW.push({ state, hidden, probs, action: a, reward, temperature: 1.0 }); wolfReturn  += reward; }
        }
      }
      step4(env, env.env.config.dt);
      // Tally stage metrics from events.
      for (const ev of env.events) {
        if (ev.type === 'born') births[ev.archetype === 'rabbit' ? 'rabbit' : 'wolf']++;
        if (ev.type === 'died' && ev.cause === 'predator') kills++;
      }
      clearEcosystemEvents(env);
    }

    if (trajR.length > 0) {
      trajR[trajR.length - 1].episodeEnd = true;
      batchR.push(trajR);
      histR.push(rabbitReturn);
      sumR += rabbitReturn; sumWinR.push(rabbitReturn);
      if (sumWinR.length > 50) sumR -= sumWinR.shift();
      const ma = sumR / sumWinR.length;
      maR.push(ma);
      if (sumWinR.length === 50 && ma > bestRMa) {
        bestRMa = ma;
        if (isFinal && ma > bestRabbitMA) { bestRabbitMA = ma; bestRabbit = clone(rabbitPolicy); bestRabbitEp = histR.length - 1; }
      }
      if (batchR.length >= batchSize) { reinforceUpdate4(rabbitPolicy, batchR.flat()); batchR = []; }
    }
    if (trajW.length > 0) {
      trajW[trajW.length - 1].episodeEnd = true;
      batchW.push(trajW);
      histW.push(wolfReturn);
      sumW += wolfReturn; sumWinW.push(wolfReturn);
      if (sumWinW.length > 50) sumW -= sumWinW.shift();
      const ma = sumW / sumWinW.length;
      maW.push(ma);
      if (sumWinW.length === 50 && ma > bestWMa) {
        bestWMa = ma;
        if (isFinal && ma > bestWolfMA) { bestWolfMA = ma; bestWolf = clone(wolfPolicy); bestWolfEp = histW.length - 1; }
      }
      if (batchW.length >= batchSize) { reinforceUpdate4(wolfPolicy, batchW.flat()); batchW = []; }
    }

    if (ep % Math.max(1, Math.floor(epsPerStage / 8)) === 0) {
      console.log(`   ep ${ep.toString().padStart(5)}/${epsPerStage}  R-ret ${rabbitReturn.toFixed(1).padStart(7)} (ma ${(maR[maR.length-1]||0).toFixed(1)})  W-ret ${wolfReturn.toFixed(1).padStart(7)} (ma ${(maW[maW.length-1]||0).toFixed(1)})  +R${births.rabbit} +W${births.wolf} kills:${kills}`);
    }
  }
  if (batchR.length > 0) reinforceUpdate4(rabbitPolicy, batchR.flat());
  if (batchW.length > 0) reinforceUpdate4(wolfPolicy, batchW.flat());
  return { histR, histW, maR, maW, bestRMa, bestWMa, births, kills };
}

function clone(p) { return deserializePolicy4(serializePolicy4(p)); }

function asciiPlot(label, values) {
  if (values.length === 0) return `(no data for ${label})`;
  const width = 70, height = 10;
  const buckets = new Array(width).fill(0).map(() => []);
  for (let i = 0; i < values.length; i++) {
    const col = Math.min(width - 1, Math.floor((i / values.length) * width));
    buckets[col].push(values[i]);
  }
  const colVals = buckets.map(b => b.length ? b.reduce((s, x) => s + x, 0) / b.length : 0);
  const mn = Math.min(...colVals), mx = Math.max(...colVals), span = (mx - mn) || 1;
  const rows = Array.from({ length: height }, () => ' '.repeat(width).split(''));
  for (let x = 0; x < width; x++) {
    const y = Math.max(0, Math.min(height - 1, height - 1 - Math.round(((colVals[x] - mn) / span) * (height - 1))));
    rows[y][x] = '▇';
  }
  const out = [`\n${label} return ma50 over curriculum:`];
  rows.forEach((r, i) => {
    const lbl = i === 0 ? mx.toFixed(1).padStart(7) : i === height - 1 ? mn.toFixed(1).padStart(7) : ' '.repeat(7);
    out.push(`  ${lbl} │${r.join('')}`);
  });
  return out.join('\n');
}
