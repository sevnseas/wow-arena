#!/usr/bin/env node
/**
 * Sanity simulator: load the trained RL4 policies, drive a small set of mock
 * PolicyAgent4Refs through the real PolicyDriver4, and observe how action
 * choices evolve as enemies approach. Confirms that:
 *   (1) the live observation builder produces sensible inputs,
 *   (2) trained policies actually condition on those inputs (varied actions),
 *   (3) entities re-target / re-orient when the world changes.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deserializePolicy4, Policy4Registry, PolicyDriver4,
  actionToUnitVec, isMovementAction, isAbilityAction, ACTION_NAMES,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const reg = new Policy4Registry();
for (const a of ['wolf', 'cat', 'werewolf']) {
  const json = readFileSync(resolve(root, 'public', 'policies-rl4', `${a}.json`), 'utf8');
  reg.policies[a] = deserializePolicy4(json);
}

// Build a mini-world: 2 wolves, 1 cat, 1 werewolf, 3 rabbits, 1 "player".
function mkAgent(id, archetype, team, pos) {
  const state = {
    id, archetype, team, size: 0.5,
    pos: { x: pos.x, z: pos.z },
    hp: 60, maxHp: 60,
    alive: true,
    lastAction: -1, lastFocus: null,
  };
  return {
    ...state,
    get pos() { return state.pos; },
    get hp() { return state.hp; },
    get maxHp() { return state.maxHp; },
    get alive() { return state.alive; },
    applyAction(action, focus) {
      state.lastAction = action;
      state.lastFocus = focus?.id ?? null;
      if (isMovementAction(action)) {
        const v = actionToUnitVec(action);
        // step ~3m per decision interval at moderate speed
        state.pos.x += v.x * 1.2;
        state.pos.z += v.z * 1.2;
      } else if (isAbilityAction(action) && focus) {
        // simulate damage to focus
        focus._takeDamage?.(6);
      }
    },
    _internal: state,
    _takeDamage(d) {
      state.hp -= d;
      if (state.hp <= 0) { state.hp = 0; state.alive = false; }
    },
  };
}

const wolves = [
  mkAgent('wolf-1', 'wolf', 'predator', { x: -10, z: -10 }),
  mkAgent('wolf-2', 'wolf', 'predator', { x: -11, z: -9 }),
];
const cat = mkAgent('cat-1', 'cat', 'predator', { x: 8, z: 4 });
const werewolf = mkAgent('werewolf', 'werewolf', 'predator', { x: 0, z: 14 });
const rabbits = [
  mkAgent('rabbit-1', 'rabbit', 'prey', { x: -8, z: -8 }),
  mkAgent('rabbit-2', 'rabbit', 'prey', { x: 10, z: 6 }),
  mkAgent('rabbit-3', 'rabbit', 'prey', { x: 2, z: 12 }),
];
const player = mkAgent('player', 'rabbit', 'prey', { x: 0, z: 0 });
player._internal.hp = 100; player._internal.maxHp = 100;

const allAgents = [...wolves, cat, werewolf, ...rabbits, player];

const driver = new PolicyDriver4(reg, { decisionInterval: 0.4, seed: 7 });
driver.setAgents(allAgents);

const dt = 0.1;
const totalSec = 20;
const ticks = Math.floor(totalSec / dt);

const counts = new Map(); // id -> { actionCounts:[11], abilities:0, moveDirs:0 }
for (const a of allAgents) counts.set(a.id, { ac: new Array(11).fill(0), totalDecisions: 0 });

let lastSnap = 0;
for (let t = 0; t < ticks; t++) {
  driver.update(dt);
  for (const a of allAgents) {
    const dec = driver.getDecision(a.id);
    if (!dec) continue;
    if (dec.takenAt > lastSnap) {
      const c = counts.get(a.id);
      c.ac[dec.action]++;
      c.totalDecisions++;
    }
  }
  lastSnap = driver.elapsed;
  // simple "encounter" — at t=5s rabbits become unaware and wolves should
  // close distance. We don't update prey movement; just watch predator paths.
}

console.log(`\nSim ran ${totalSec}s · ${ticks} ticks. Final positions and behavior:\n`);
for (const a of [...wolves, cat, werewolf]) {
  const c = counts.get(a.id);
  const top = c.ac
    .map((n, i) => [n, i])
    .filter(([n]) => n > 0)
    .sort(([a], [b]) => b - a)
    .slice(0, 4)
    .map(([n, i]) => `${ACTION_NAMES[i]}×${n}`)
    .join(' ');
  const moves = c.ac.slice(0, 8).reduce((s, n) => s + n, 0);
  const abils = c.ac.slice(8).reduce((s, n) => s + n, 0);
  console.log(`  ${a.id.padEnd(10)} @ (${a.pos.x.toFixed(1)}, ${a.pos.z.toFixed(1)})  decisions=${c.totalDecisions} · ${moves}m+${abils}a · top: ${top}`);
}

// Distance closing check: did wolves move toward player?
const distNow = wolves.map(w => Math.hypot(w.pos.x - player.pos.x, w.pos.z - player.pos.z));
console.log(`\nWolf->player distances now: ${distNow.map(d => d.toFixed(1)).join(', ')}`);
console.log(`(started at ~14.1 / 14.1 — closer means the policy is steering toward the player)`);
