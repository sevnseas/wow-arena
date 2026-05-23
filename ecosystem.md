# Ecosystem Curriculum — Grass → Rabbits → Wolves

Goal: a self-sustaining population simulation where trained RL4 policies
drive rabbit grazing/reproduction and wolf hunting/reproduction, and the
emergent dynamics resemble Lotka-Volterra predator-prey oscillations
(rabbit population rises → wolves rise → rabbits crash → wolves crash → repeat).

Built on the existing pen + curriculum infrastructure:
[`README.md`](./README.md) §RL4, [`scripts/train-rl4.mjs`](./scripts/train-rl4.mjs),
[`src/scenarios/train-tick.ts`](./src/scenarios/train-tick.ts).

---

## Mechanics (naive implementation)

### Grass

- Static patches sprinkled across the pen. Each has `nutrition` (0..1) that
  drops to 0 when eaten and regrows linearly at `grassRegrow` per second.
- When any rabbit's centre is within `grassRadius` of a patch with nutrition > 0,
  the patch's nutrition transfers to the rabbit at `grazeRate`: the rabbit's
  `hp` rises (capped) **and** its `grassEaten` counter increments by the
  nutrition consumed (fractional OK).
- No new action needed for eating — it's a passive collision effect, same
  pattern as the existing `tickGrazeHeal` in `src/prey.ts`. Rabbits learn to
  *walk on* grass.

### Aging + starvation

- Every entity gets `age: number` (seconds lived) and a per-archetype `maxAge`.
  At `age > maxAge` the entity dies of natural causes — emits a `died`
  event so metrics can distinguish death-by-age from death-by-predator.
- Continuous slow `hp` drain (`starveRate`, e.g. `1 hp/sec` for rabbits,
  `0.5 hp/sec` for wolves). Eating offsets the drain. A rabbit that doesn't
  graze starves to death in ~30s; a wolf without prey in ~3min.

### Reproduction action

Add a **12th action: `Interact`** (button 4 / mouse R / whatever). It's a
short-range ability:

- If the caster is a **rabbit** with `grassEaten >= 3` AND there's another
  live rabbit within `interactRange` (~1m) → spawn a new rabbit at the
  midpoint. Reset both parents' `grassEaten` counter. The newborn starts at
  full HP and `age = 0`.
- If the caster is a **wolf** with `rabbitEaten >= 1` AND there's another live
  wolf within `interactRange` → spawn a new wolf at the midpoint, reset both
  parents' counter, newborn at full HP age 0.
- Otherwise the action is a no-op (still uses the cooldown).

This keeps the action space small (one extra slot) and the reproduction
predicate trivial: *count + adjacency*. The policy must learn to (1) graze
enough, then (2) seek out a partner, then (3) hit Interact.

### Wolf eating

When a wolf's bite kills a rabbit (`damage()` returns `true`), increment that
wolf's `rabbitEaten` by 1. No other change — the existing combat path already
fires the kill event.

---

## Observation extensions

Current obs: 20 entity slots × 7 features (pos, vel, hp, archetype, team).

Add 5 self-state features at the end of the vector (still uses the same
"minimap" framing):

| feature | description |
|---|---|
| 140 | `self.hp / self.maxHp` |
| 141 | `self.age / self.maxAge` (mortality clock) |
| 142 | `self.grassEaten / 3` (or `self.rabbitEaten / 1`) — clamped to 1 |
| 143 | nearest-grass `rel_x` (0 if none in vision) |
| 144 | nearest-grass `rel_z` |

Total obs = 145 dims. Grass patches don't take 20 slots — only the nearest
one is exposed (rabbits don't need to navigate around multiple, just go to
the closest visible). Wolves see grass too but their policy will learn to
ignore it.

> Alternative: encode grass as additional entity slots with `archetype=7`
> (grass), pushing total slots to e.g. 25. Pros: uniform. Cons: bigger
> input → more params. Start with the 5-extra-features version.

---

## Curriculum

Each stage runs ~1500 episodes per archetype. The pen widens as before, but
new stages add the ecosystem complexity layer by layer. Eating + reproduction
shaping rewards activate progressively so the policy converges in pieces.

| stage | bounds | grass density | partners | predators | new reward signal |
|---|---|---|---|---|---|
| **S1: graze** | 4m × 4m | 8 patches | 0 | 0 | `+r` per grass eaten, `−r` for starvation HP loss |
| **S2: graze+age** | 6m × 6m | 6 patches | 0 | 0 | as S1 + `+0.05 per second alive` |
| **S3: reproduce** | 8m × 8m | 8 patches | 1 (passive rabbit) | 0 | as S2 + `+10` for each successful reproduce |
| **S4: hunt** | 10m × 10m | 4 patches | 0 partners | 1 rabbit | wolf-only: as RL4 today, but rabbit moves and grazes (env4 prey is animate now) |
| **S5: ecosystem** | 18m × 18m | 12 patches | 2-4 wolves + 6-10 rabbits | mixed | per-archetype: kill bonus (wolf), graze bonus (rabbit), reproduce bonus (both); shared distance shaping |

S1–S3 trains rabbits. S4 trains wolves. S5 trains both jointly with the
final policy used in deployment. Per-archetype policies (`rabbit.json`,
`wolf.json`) get their own training run but the env state is shared
during S5.

---

## Tasks

### Task 1 — env4 extensions

**Files**: `src/rl/env4.ts`, `src/rl/types.ts`

- Add `Grass` interface (`x`, `z`, `nutrition`, `regrowTimer`) and
  `env4.grass: Grass[]`.
- Spawn helper: `spawnGrass(env4, x, z)`. Initial nutrition = 1.
- Per-tick: depleted patches regrow at `grassRegrow * dt`; rabbits within
  `grassRadius` of a non-empty patch absorb `grazeRate * dt` from it into
  `hp` (capped at maxHp) and `grassEaten` counter.
- Add to each `Entity`: `age: number`, `maxAge: number`, `grassEaten: number`,
  `preyEaten: number`, `starveRate: number`.
- Per-tick age increment; starvation HP drain; death-by-age when `age >
  maxAge` (mark `alive = false`, emit `died { cause: 'age' }` event).
- Add 12th action constant `Action.Interact = 11`. `ACTION_COUNT = 12`.
- In `act4`: if action is Interact, find nearest same-team alive entity
  within `interactRange`. If found AND archetype-specific counter threshold
  met, spawn newborn at midpoint, reset both counters, emit `born` event.
  Newborn inherits parent's `maxAge` and archetype-default `starveRate`.
- New env events: `grazed`, `born`, `died`.

**Acceptance**: unit test `rl4-ecosystem.test.ts` covering
- rabbit on grass gains hp and grassEaten,
- exhausted grass regrows,
- aged entity dies on its own,
- starving entity dies if it can't reach grass,
- Interact spawns newborn iff counter ≥ threshold and partner in range,
- counters reset after reproduction.

---

### Task 2 — observation, policy size bump, reward shaping

**Files**: `src/rl/env4.ts` (observe4), `src/rl/policy4.ts`, `src/rl/types.ts`

- Bump `STATE_DIM_RL4` from 140 to 145 to fit the 5 self-state features.
  Existing policies are invalidated — bump `policyConfig.version: 2` in
  serialized JSON and reject loading older files in `loadPolicy4Registry`
  (graceful warning).
- `observe4` writes self-state at indices [140..144]: `hp%, age%,
  counter/threshold, nearestGrass.rel_x, nearestGrass.rel_z`.
- `ACTION_COUNT = 12` invalidates the W2 shape. Re-init.
- `computeReward4` per-archetype:
  - rabbit: `+0.5 * grazedThisStep`, `+10 * bornThisStep`,
    `−2 * deathThisStep`, distance shaping to nearest grass when hungry.
  - wolf: `+0.1 * dmgThisStep`, `+3 * killThisStep`, `+10 * bornThisStep`,
    distance shaping to nearest rabbit.
- Per-archetype shaping toggle so train-rl4 can pass the right one.

**Acceptance**: trained policy at S2 (graze+age) reaches an average lifetime
> 60s without dying. At S3 reproduces ≥ 1 child per minute on average.

---

### Task 3 — multi-archetype curriculum + co-training

**Files**: `scripts/train-rl4.mjs`, `src/scenarios/train-tick.ts`

- Add stages S1-S5 to the curriculum config.
- S1-S4 train one archetype at a time (other entities are either absent or
  scripted-passive). S5 runs both archetypes' policies inside the same env.
  Each archetype has its own Policy4 instance; the trainer alternates which
  one is the "learner" per batch (or runs both in parallel with separate
  optimizers).
- Add per-stage entity spawn function (currently hard-coded in train-rl4).
- Save best policies for each archetype based on stage-specific metric:
  - rabbit policy chosen by average lifetime + reproduction rate at S5
  - wolf policy chosen by kill rate + reproduction rate at S5

**Acceptance**: after full curriculum, headless metric run shows:
- mean rabbit lifetime > 40s
- mean wolf lifetime > 90s
- population doesn't collapse to 0 in < 2min of sim time across 20 trials

---

### Task 4 — ecosystem scenario + population metrics

**Files**: `scenarios.html`, `src/scenarios/main.ts`, `scripts/scenario-tick.mjs`

- New scenario `?s=ecosystem` — bounds=18m pen, 12 grass patches, 6 rabbits,
  2 wolves. Render grass patches as green disks; rabbits / wolves as before.
- HUD adds:
  - Live **population chart** (last 120s of {rabbit count, wolf count})
  - Birth / death counters per archetype
  - Average age + grass coverage gauges
  - "extinction in X" timer (estimates from current growth rate)
- Headless `npm run scenario ecosystem 600` (10 min sim) outputs:
  - per-second CSV: `t, n_rabbits, n_wolves, n_grass_patches, n_births_total, n_deaths_total`
  - terminal summary: oscillation period (if any), extinction time (if any),
    Lotka-Volterra phase plot ASCII

**Acceptance**: at least one out of 20 headless runs survives 10 minutes
without either species going extinct, AND shows at least one full cycle
(rabbit peak → wolf peak → rabbit trough → wolf trough → rabbit recovery).

---

## Metrics to monitor

### Per-archetype training metrics (existing infrastructure)

- Return MA50 — should still flatten per stage (sanity)
- Per-stage kill-rate (wolves) / reproduction-rate (rabbits)
- Mean lifetime per training stage

### Ecosystem-level metrics (new)

| metric | target | how |
|---|---|---|
| **rabbit births / min** | 4-15 in healthy state | event count over time |
| **wolf births / min** | 0.5-3 | event count over time |
| **mean rabbit lifetime** | 30-90s | running average |
| **mean wolf lifetime** | 60-180s | running average |
| **population oscillation** | 1+ full cycle in 10 min | autocorrelation peak on rabbit count |
| **extinction rate** | < 50% of 10-min runs end with either species at 0 | survival over 20 seeded headless runs |
| **death cause breakdown** | rabbits mostly die to wolves; wolves mostly die to age/starvation | `died` event `cause` field histogram |
| **grass coverage** | 30-70% of patches alive at steady state | regrow vs eat balance |

### Red flags

- `grassEaten` counter saturates at 3 but reproduction-rate ≈ 0 → policy not
  learning to seek partners → add stronger "find partner" shaping in S3
- Wolves always converge on one rabbit and kill it instantly, ignore others
  → reduce decision-time / increase prey HP / spread spawn
- Population dies in < 30s every run → starvation drain too high OR
  reproduce threshold too high; tune `maxAge`, `starveRate`, thresholds
- One archetype dominates (wolves wipe rabbits in < 1min always) → S5
  needs alternating "rabbit-only practice" episodes to keep rabbit policy
  competitive

---

## Open questions (to revisit when implementing)

- Should `Interact` cost HP? (otherwise rabbits can spam reproduce after
  one feeding). Current plan: counter must reset, which already gates it.
- Energy currency vs hp-as-energy? Current plan reuses HP for simplicity.
- Mate selection — random nearest? Pick a "fittest" mate? Start random.
- Newborn HP at spawn — full vs half? Start full; tune if births dominate.
- Should grass occupy minimap slots OR be its own feature group? Start
  with the 5-feature self-state addition (cheaper, smaller policy).

---

## Why this is tractable

- The reproduction predicate is *count + adjacency* — no new search
  problem. Pure shaping reward.
- env4 already supports passive collision-driven heal (grazing pattern).
- The pen + Adam + mixed-pen curriculum stack from RL4 carries forward
  directly; only the *task* is changing, not the optimization.
- Pop dynamics are a known emergent property of agents that (a) seek food,
  (b) reproduce when fed, (c) starve when not — if the per-step policies
  do the right local thing, the population dynamics fall out for free.
