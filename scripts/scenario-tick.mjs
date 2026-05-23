#!/usr/bin/env node
/**
 * Headless tick-speed runner for an RL4 scenario. Drives WolfPack / RabbitWarren
 * etc. *as the live browser does* — same adapters, same driver, same physics —
 * but writes a per-second timeline of (action, distance, hero/target HP) so the
 * policy's behavior is checkable without a browser.
 *
 * Run:  npm run scenario [name] [seconds]
 *   name    = wolf-vs-rabbit | pack-vs-cow | cat-vs-rabbit | ecosystem  (default wolf-vs-rabbit)
 *   seconds = simulated seconds                              (default 30)
 *   trials  = ecosystem-only trial count for survival checks  (default 1)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stub the WebGL bits so wolves/cats/three can construct headlessly.
// (We do NOT replace globalThis.performance — jsdom's Performance shim
// recurses with Node's built-in. Node's own `performance` is fine.)
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const THREE = await import('three');
const { WolfPack } = await import('../src/wolves.ts');
const { CatColony } = await import('../src/cats.ts');
const { RabbitWarren } = await import('../src/rabbits.ts');
const { CowHerd } = await import('../src/cows.ts');
const {
  loadPolicy4Registry: _loader, PolicyDriver4, Policy4Registry,
  ACTION_NAMES,
} = await import('../src/rl/runtime4.ts');
const { deserializePolicy4 } = await import('../src/rl/policy4.ts');
const {
  createEnv4, spawn4, spawnGrass, observe4, act4, step4, clearEcosystemEvents,
} = await import('../src/rl/env4.ts');

const scenarioName = process.argv[2] ?? 'wolf-vs-rabbit';
const totalSec = Number(process.argv[3] ?? 30);
const totalTrials = Number(process.argv[4] ?? 1);

const scene = new THREE.Scene();

const PHYS = {
  rabbit: { size: 0.28, speed: 2.6, attackCooldown: 1.0, hp: 30 },
  wolf:   { size: 0.50, speed: 4.0, attackCooldown: 0.4, hp: 60 },
};
const ECOSYSTEM_TARGET_HALF = 18;

function rl3ToObs4(a) {
  return {
    id: a.id, team: a.team, archetype: a.archetype, size: a.size,
    get alive() { return a.alive; },
    get hp() { return a.hp; },
    get maxHp() { return a.maxHp; },
    get pos() { return a.pos; },
    applyAction: () => {},
  };
}

function spawnScenario(name, seed = 31) {
  if (name === 'ecosystem') return spawnEcosystemScenario(seed);
  // Pen variants verify the policy in the distribution it was actually trained
  // on. Curriculum stages: pen3 / pen6 / pen12 / open(25). Without matching
  // the training distribution, low kill-rates can be misread as "policy
  // doesn't work" when it's really "policy hasn't learned this regime yet".
  if (name === 'wolf-vs-rabbit-pen') {
    const rabbits = new RabbitWarren(scene, 1, 3, null);
    const wolves = new WolfPack(scene, 1, 3, null, [rabbits], new THREE.Vector3(0.5, 0, 0.5));
    return {
      wolves, rabbits, providers: [rabbits],
      brain: wolves.getPolicy4Agents(),
      obs: rabbits.getPolicyAgents().map(rl3ToObs4),
      tick(dt) { wolves.update(dt); rabbits.update(dt); },
    };
  }
  if (name === 'wolf-vs-rabbit') {
    const rabbits = new RabbitWarren(scene, 1, 25, null);
    const wolves = new WolfPack(scene, 1, 25, null, [rabbits], new THREE.Vector3(-8, 0, -8));
    return {
      wolves, rabbits, providers: [rabbits],
      brain: wolves.getPolicy4Agents(),
      obs: rabbits.getPolicyAgents().map(rl3ToObs4),
      tick(dt) { wolves.update(dt); rabbits.update(dt); },
    };
  }
  if (name === 'pack-vs-cow') {
    const cows = new CowHerd(scene, 1, 25, null);
    const wolves = new WolfPack(scene, 2, 25, null, [cows], new THREE.Vector3(-10, 0, -10));
    return {
      wolves, cows, providers: [cows],
      brain: wolves.getPolicy4Agents(),
      obs: cows.getPolicyAgents().map(rl3ToObs4),
      tick(dt) { wolves.update(dt); cows.update(dt); },
    };
  }
  if (name === 'cat-vs-rabbit') {
    const rabbits = new RabbitWarren(scene, 1, 25, null);
    const cats = new CatColony(scene, 1, 25, null);
    return {
      cats, rabbits, providers: [rabbits],
      brain: cats.getPolicy4Agents(),
      obs: rabbits.getPolicyAgents().map(rl3ToObs4),
      tick(dt) { cats.update(dt); rabbits.update(dt); },
    };
  }
  throw new Error(`unknown scenario: ${name}`);
}

function spawnEcosystemScenario(seed = 31) {
  const half = tightEcosystemHalf(6, 2, 12);
  const env = createEnv4({ bounds: half, visionRadius: Math.max(6, half * 1.4) }, seed);
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    const r = (0.25 + (i % 3) * 0.22) * half;
    spawnGrass(env, Math.cos(a) * r, Math.sin(a) * r);
  }
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    spawnEcosystemEntity(env, 'rabbit', Math.cos(a) * half * 0.42, Math.sin(a) * half * 0.42);
  }
  spawnEcosystemEntity(env, 'wolf', -half * 0.5, -half * 0.5);
  spawnEcosystemEntity(env, 'wolf', half * 0.5, half * 0.5);
  return { kind: 'ecosystem', env, metrics: { half, targetHalf: ECOSYSTEM_TARGET_HALF, history: [] } };
}

function spawnEcosystemEntity(env, archetype, x, z) {
  const p = PHYS[archetype];
  return spawn4(env, {
    archetype,
    team: archetype === 'wolf' ? 'predator' : 'prey',
    x, z,
    hp: p.hp, maxHp: p.hp, size: p.size, speed: p.speed,
    attackCooldown: p.attackCooldown,
    maxAge: archetype === 'wolf' ? 120 : 60,
    starveRate: archetype === 'wolf' ? 0.5 : 1.0,
  });
}

const reg = new Policy4Registry();
for (const a of ['wolf', 'cat', 'werewolf', 'rabbit']) {
  try {
    const json = readFileSync(resolve(root, 'public', 'policies-rl4', `${a}.json`), 'utf8');
    reg.policies[a] = deserializePolicy4(json);
  } catch {}
}

if (scenarioName === 'ecosystem') {
  if (totalTrials > 1) runEcosystemTrials(reg, totalSec, totalTrials);
  else runEcosystem(spawnScenario('ecosystem').env, reg, totalSec, { verbose: true });
  process.exit(0);
}

const world = spawnScenario(scenarioName);

const driver = new PolicyDriver4(reg, { decisionInterval: 0.3, seed: 1 });
driver.setAgents([...world.brain, ...world.obs]);

const hero = world.brain[0];
const target = world.obs[0];

console.log(`\n=== Scenario: ${scenarioName} ===`);
console.log(`Hero: ${hero.archetype} #${hero.id} @ (${hero.pos.x.toFixed(1)}, ${hero.pos.z.toFixed(1)})`);
console.log(`Target: ${target.archetype} #${target.id} @ (${target.pos.x.toFixed(1)}, ${target.pos.z.toFixed(1)})`);
console.log(`Initial distance: ${Math.hypot(hero.pos.x - target.pos.x, hero.pos.z - target.pos.z).toFixed(2)}m\n`);

const dt = 1 / 60;
const totalTicks = Math.floor(totalSec / dt);
const actionHist = new Array(ACTION_NAMES.length).fill(0);
let lastLogSec = -1;
let firstContactAt = -1;

for (let t = 0; t < totalTicks; t++) {
  driver.update(dt);
  world.tick(dt);

  // Refresh agent list each tick so dead/respawned entities are tracked.
  driver.setAgents([...world.brain, ...world.obs]);

  const elapsed = (t + 1) * dt;
  const sec = Math.floor(elapsed);
  if (sec !== lastLogSec) {
    lastLogSec = sec;
    const d = target.alive
      ? Math.hypot(hero.pos.x - target.pos.x, hero.pos.z - target.pos.z)
      : NaN;
    const dec = driver.getDecision(hero.id);
    const act = dec ? ACTION_NAMES[dec.action] : '—';
    console.log(
      `t=${sec.toString().padStart(2)}s  hero(${hero.pos.x.toFixed(1).padStart(5)},${hero.pos.z.toFixed(1).padStart(5)}) hp=${hero.hp.toFixed(0).padStart(3)}` +
      `   target(${target.alive ? target.pos.x.toFixed(1).padStart(5) : '  —  '},${target.alive ? target.pos.z.toFixed(1).padStart(5) : '  —  '}) hp=${target.hp.toFixed(0).padStart(3)}` +
      `   dist=${isNaN(d) ? '  —  ' : d.toFixed(2).padStart(5) + 'm'}   action=${act}`
    );
  }

  const dec = driver.getDecision(hero.id);
  if (dec) actionHist[dec.action]++;

  if (firstContactAt < 0 && target.alive) {
    const d = Math.hypot(hero.pos.x - target.pos.x, hero.pos.z - target.pos.z);
    if (d < 1.5) firstContactAt = elapsed;
  }
  if (!target.alive) break;
}

console.log('\n--- summary ---');
console.log(`Total simulated: ${totalSec}s`);
console.log(`First contact (within 1.5m): ${firstContactAt < 0 ? 'never' : firstContactAt.toFixed(1) + 's'}`);
console.log(`Target alive at end: ${target.alive} (hp ${target.hp.toFixed(0)}/${target.maxHp})`);
console.log(`Hero alive at end:   ${hero.alive} (hp ${hero.hp.toFixed(0)}/${hero.maxHp})`);
console.log(`\nHero action histogram:`);
for (let i = 0; i < actionHist.length; i++) {
  if (actionHist[i] > 0) {
    const bar = '█'.repeat(Math.round(actionHist[i] / 5));
    console.log(`  ${ACTION_NAMES[i].padEnd(10)} ${actionHist[i].toString().padStart(4)}  ${bar}`);
  }
}

function runEcosystem(env, reg, seconds, opts = {}) {
  const verbose = opts.verbose ?? true;
  const dt = 1 / 60;
  const totalTicks = Math.floor(seconds / dt);
  const decisionEvery = 0.3;
  const nextDecision = new Map();
  let births = 0, deaths = 0;
  let rabbitBirths = 0, wolfBirths = 0;
  const deathCauses = { predator: 0, starvation: 0, age: 0 };
  const rows = ['t,n_rabbits,n_wolves,n_grass_patches,n_births_total,n_deaths_total'];
  const timeline = [];
  const lifetimes = { rabbit: [], wolf: [] };
  const metrics = { half: env.env.config.bounds, targetHalf: ECOSYSTEM_TARGET_HALF, history: timeline };
  const policiesPresent = { rabbit: !!reg.get('rabbit'), wolf: !!reg.get('wolf') };

  if (verbose) {
    console.log(`\n=== Scenario: ecosystem ===`);
    console.log(`adaptive pen: ${metrics.half.toFixed(1)}m → ${metrics.targetHalf}m · policies rabbit=${policiesPresent.rabbit} wolf=${policiesPresent.wolf}`);
    console.log(rows[0]);
  }
  for (let tick = 0; tick < totalTicks; tick++) {
    const elapsed = tick * dt;
    for (const e of env.entities) {
      if (!e.alive) continue;
      const policy = reg.get(e.archetype);
      if (!policy) continue;
      const due = nextDecision.get(e.id) ?? 0;
      if (elapsed < due) continue;
      const { probs } = policy.forward(observe4(env, e), 1.0);
      let r = Math.random(), action = 0;
      for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
      act4(env, e, action, dt);
      nextDecision.set(e.id, elapsed + decisionEvery);
    }
    step4(env, dt);
    for (const ev of env.events) {
      if (ev.type === 'born') {
        births++;
        if (ev.archetype === 'rabbit') rabbitBirths++;
        if (ev.archetype === 'wolf') wolfBirths++;
      } else if (ev.type === 'died') {
        deaths++;
        deathCauses[ev.cause]++;
        const dead = env.entities.find(e => e.id === ev.entityId);
        if (dead?.archetype === 'rabbit' || dead?.archetype === 'wolf') lifetimes[dead.archetype].push(dead.age);
      }
    }
    clearEcosystemEvents(env);

    if (tick % 60 === 0) {
      const alive = env.entities.filter(e => e.alive);
      const nRabbits = alive.filter(e => e.archetype === 'rabbit').length;
      const nWolves = alive.filter(e => e.archetype === 'wolf').length;
      const nGrass = env.grass.filter(g => g.nutrition > 0.2).length;
      const t = Math.floor(elapsed);
      const row = `${t},${nRabbits},${nWolves},${nGrass},${births},${deaths}`;
      rows.push(row);
      timeline.push({ t, nRabbits, nWolves });
      maybeGrowEcosystemPen(env, metrics);
      if (verbose) console.log(row);
    }
  }
  for (const e of env.entities) {
    if (e.alive && (e.archetype === 'rabbit' || e.archetype === 'wolf')) lifetimes[e.archetype].push(e.age);
  }

  const final = timeline[timeline.length - 1] ?? { nRabbits: 0, nWolves: 0 };
  const extinction = timeline.find(p => p.nRabbits === 0 || p.nWolves === 0)?.t ?? null;
  const cycle = detectCycle(timeline);
  const result = {
    seconds,
    final,
    births: { rabbit: rabbitBirths, wolf: wolfBirths, total: births },
    deaths: { total: deaths, ...deathCauses },
    extinction,
    cycle,
    survived: extinction === null,
    meanRabbitLifetime: mean(lifetimes.rabbit),
    meanWolfLifetime: mean(lifetimes.wolf),
    finalHalf: metrics.half,
    timeline,
  };
  if (verbose) {
    console.log('\n--- ecosystem summary ---');
    console.log(`Total simulated: ${seconds}s`);
    console.log(`Final population: rabbits=${final.nRabbits} wolves=${final.nWolves}`);
    console.log(`Births: rabbits=${rabbitBirths} wolves=${wolfBirths} total=${births}`);
    console.log(`Deaths: total=${deaths} predator=${deathCauses.predator} starvation=${deathCauses.starvation} age=${deathCauses.age}`);
    console.log(`Mean lifetime: rabbits=${result.meanRabbitLifetime.toFixed(1)}s wolves=${result.meanWolfLifetime.toFixed(1)}s`);
    console.log(`Pen half-width: ${result.finalHalf.toFixed(1)}m`);
    console.log(`Extinction time: ${extinction === null ? 'none' : extinction + 's'}`);
    console.log(`Oscillation period: ${cycle.period === null ? 'none detected' : cycle.period + 's'}`);
    console.log('\nLotka-Volterra phase plot (rabbit x, wolf y):');
    console.log(phasePlot(timeline));
  }
  return result;
}

function runEcosystemTrials(reg, seconds, trials) {
  const results = [];
  console.log(`\n=== Ecosystem trials: ${trials} × ${seconds}s ===`);
  for (let i = 0; i < trials; i++) {
    const world = spawnEcosystemScenario(31 + i * 997);
    const r = runEcosystem(world.env, reg, seconds, { verbose: false });
    results.push(r);
    console.log(`trial ${String(i + 1).padStart(2)}  survived=${r.survived ? 'yes' : ' no'}  cycle=${r.cycle.full ? 'yes' : ' no'}  ext=${r.extinction ?? '-'}  final R${r.final.nRabbits}/W${r.final.nWolves}  life R${r.meanRabbitLifetime.toFixed(1)} W${r.meanWolfLifetime.toFixed(1)}  pen ${r.finalHalf.toFixed(1)}m`);
  }
  const survivors = results.filter(r => r.survived);
  const cycles = results.filter(r => r.cycle.full);
  const pass = results.some(r => r.survived && r.cycle.full);
  console.log('\n--- trials summary ---');
  console.log(`Survived 10min-equivalent window: ${survivors.length}/${trials}`);
  console.log(`Full cycles detected: ${cycles.length}/${trials}`);
  console.log(`Acceptance candidate: ${pass ? 'yes' : 'no'}`);
}

function detectCycle(points) {
  const rabbitPeaks = [], rabbitTroughs = [], wolfPeaks = [], wolfTroughs = [];
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i].nRabbits > points[i - 1].nRabbits && points[i].nRabbits >= points[i + 1].nRabbits) rabbitPeaks.push(points[i].t);
    if (points[i].nRabbits < points[i - 1].nRabbits && points[i].nRabbits <= points[i + 1].nRabbits) rabbitTroughs.push(points[i].t);
    if (points[i].nWolves > points[i - 1].nWolves && points[i].nWolves >= points[i + 1].nWolves) wolfPeaks.push(points[i].t);
    if (points[i].nWolves < points[i - 1].nWolves && points[i].nWolves <= points[i + 1].nWolves) wolfTroughs.push(points[i].t);
  }
  const full = rabbitPeaks.some(rp =>
    wolfPeaks.some(wp => wp > rp &&
      rabbitTroughs.some(rt => rt > wp &&
        wolfTroughs.some(wt => wt > rt &&
          rabbitPeaks.some(recovery => recovery > wt)))));
  return { period: rabbitPeaks.length >= 2 ? rabbitPeaks[1] - rabbitPeaks[0] : null, full };
}

function phasePlot(points) {
  if (!points.length) return '(no data)';
  const w = 48, h = 14;
  const maxR = Math.max(1, ...points.map(p => p.nRabbits));
  const maxW = Math.max(1, ...points.map(p => p.nWolves));
  const grid = Array.from({ length: h }, () => Array(w).fill(' '));
  for (const p of points) {
    const x = Math.min(w - 1, Math.round((p.nRabbits / maxR) * (w - 1)));
    const y = h - 1 - Math.min(h - 1, Math.round((p.nWolves / maxW) * (h - 1)));
    grid[y][x] = '*';
  }
  return grid.map(r => `|${r.join('')}|`).join('\n') + `\n rabbits 0..${maxR}, wolves 0..${maxW}`;
}

function tightEcosystemHalf(rabbits, wolves, grass) {
  const entityArea = rabbits * Math.PI * (PHYS.rabbit.size + 0.55) ** 2
    + wolves * Math.PI * (PHYS.wolf.size + 0.65) ** 2;
  const grassArea = grass * Math.PI * 0.45 ** 2;
  return Math.max(1.5, Math.sqrt((entityArea + grassArea) / 0.70) / 2);
}

function maybeGrowEcosystemPen(env, metrics) {
  if (metrics.half >= metrics.targetHalf || metrics.history.length < 40) return;
  const score = p => p.nRabbits + p.nWolves * 2;
  const recent = mean(metrics.history.slice(-12).map(score));
  const older = mean(metrics.history.slice(-40, -28).map(score));
  if (Math.abs(recent - older) / Math.max(1, Math.abs(older)) > 0.05) return;
  metrics.half = Math.min(metrics.targetHalf, metrics.half * 1.35 + 0.25);
  env.env.config.bounds = metrics.half;
  env.env.config.visionRadius = Math.max(6, metrics.half * 1.4);
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
