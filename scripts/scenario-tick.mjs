#!/usr/bin/env node
/**
 * Headless tick-speed runner for an RL4 scenario. Drives WolfPack / RabbitWarren
 * etc. *as the live browser does* — same adapters, same driver, same physics —
 * but writes a per-second timeline of (action, distance, hero/target HP) so the
 * policy's behavior is checkable without a browser.
 *
 * Run:  npm run scenario [name] [seconds]
 *   name    = wolf-vs-rabbit | pack-vs-cow | cat-vs-rabbit  (default wolf-vs-rabbit)
 *   seconds = simulated seconds                              (default 30)
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

const scenarioName = process.argv[2] ?? 'wolf-vs-rabbit';
const totalSec = Number(process.argv[3] ?? 30);

const scene = new THREE.Scene();

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

function spawnScenario(name) {
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

const world = spawnScenario(scenarioName);

const reg = new Policy4Registry();
for (const a of ['wolf', 'cat', 'werewolf']) {
  try {
    const json = readFileSync(resolve(root, 'public', 'policies-rl4', `${a}.json`), 'utf8');
    reg.policies[a] = deserializePolicy4(json);
  } catch {}
}

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
const actionHist = new Array(11).fill(0);
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
