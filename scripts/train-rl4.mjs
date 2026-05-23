#!/usr/bin/env node
/**
 * Headless RL4 trainer. Direct-control + minimap observation.
 * Trains one policy per archetype that the live game cares about and
 * writes serialized JSON to public/policies-rl4/<archetype>.json.
 *
 * Run: `npm run train:rl4 [episodesPerArchetype] [stepsPerEpisode]`
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { train4, serializePolicy4 } from '../src/rl/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const episodes = Number(process.argv[2] ?? 120);
const stepsPerEpisode = Number(process.argv[3] ?? 300);

const targets = [
  {
    name: 'wolf',
    cfg: {
      agentType: 'wolf', agents: 2,
      enemies: [{ type: 'rabbit', count: 3 }, { type: 'cow', count: 1 }],
      seed: 42,
    },
  },
  {
    name: 'cat',
    cfg: {
      agentType: 'cat', agents: 2,
      enemies: [{ type: 'rabbit', count: 4 }],
      seed: 123,
    },
  },
  {
    name: 'werewolf',
    cfg: {
      agentType: 'werewolf', agents: 1,
      enemies: [{ type: 'wolf', count: 3 }, { type: 'cat', count: 2 }],
      seed: 456,
    },
  },
];

const outDir = resolve(here, '..', 'public', 'policies-rl4');
mkdirSync(outDir, { recursive: true });

console.log(`Training RL4 policies — ${episodes} eps × ${stepsPerEpisode} steps each.`);

for (const t of targets) {
  const t0 = Date.now();
  const { policy, history } = await train4(
    {
      episodes,
      stepsPerEpisode,
      decisionInterval: 5,
      logEvery: Math.max(1, Math.floor(episodes / 8)),
      ...t.cfg,
    },
    {},
  );
  const dt = (Date.now() - t0) / 1000;
  const last = history.at(-1)?.episodeReward ?? 0;
  const first = history.at(0)?.episodeReward ?? 0;
  const json = serializePolicy4(policy);
  const file = resolve(outDir, `${t.name}.json`);
  writeFileSync(file, json);
  console.log(`  ${t.name.padEnd(8)} done in ${dt.toFixed(1)}s · return ${first.toFixed(2)} → ${last.toFixed(2)} · wrote ${file}`);
}

console.log('\nAll done. Reload the game (RL4 policies load automatically).');
