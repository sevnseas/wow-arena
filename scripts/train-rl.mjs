#!/usr/bin/env node
/**
 * Headless RL trainer. Tick-time only, no Three.js, no wall-clock.
 * Trains one shared MLP per archetype (wolf / rabbit / cow / cat / dog /
 * werewolf) in a single mixed-ecosystem rollout per episode.
 * Run: `npm run train` or `npx tsx scripts/train-rl.mjs [episodes] [maxTicks]`
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  train, kitingCheck, targetLockCheck, stochasticVarianceCheck, gangUpCheck,
  serializePolicy, ARCHETYPES,
} from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const episodes = Number(process.argv[2] ?? 400);
const maxTicks = Number(process.argv[3] ?? 900);

console.log(`Training ${episodes} episodes × ${maxTicks} ticks across ${ARCHETYPES.length} archetypes.`);
const t0 = Date.now();
const { registry } = train({ episodes, maxTicks, logEvery: Math.max(1, Math.floor(episodes / 20)) });
const dt = (Date.now() - t0) / 1000;
console.log(`Done in ${dt.toFixed(1)}s (${(episodes / dt).toFixed(1)} ep/s).`);

console.log('\nValidation suite:');
const k = kitingCheck();
console.log(`  Kiting:          fledDistance=${k.fledDistance.toFixed(2)}, survivedTicks=${k.survivedTicks}`);
const l = targetLockCheck();
console.log(`  Target lock:     hits=${l.hits}, killed=${l.killed}`);
const v = stochasticVarianceCheck(registry.get('wolf'));
console.log(`  Stoch variance:  ${v.uniqueIntentSequences} unique action streams across 3 wolves`);
const g = gangUpCheck(registry.get('wolf'));
console.log(`  Gang-up:         attackRate=${(g.attackRate * 100).toFixed(1)}% bossKilled=${g.bossKilled}`);

const outDir = resolve(here, '../public/policies');
mkdirSync(outDir, { recursive: true });
const serialized = registry.serialize();
for (const a of ARCHETYPES) {
  writeFileSync(resolve(outDir, `${a}.json`), serialized[a]);
}
// Keep legacy file names so old loaders still work.
writeFileSync(resolve(outDir, 'predator.json'), serializePolicy(registry.get('wolf')));
writeFileSync(resolve(outDir, 'prey.json'), serializePolicy(registry.get('rabbit')));
console.log(`\nWrote per-archetype policies → ${outDir}/{${ARCHETYPES.join(',')}}.json`);
