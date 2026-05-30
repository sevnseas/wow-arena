# Predator–Prey Ecosystem RL (PufferLib)

A self-sustaining, multi-agent **Lotka–Volterra ecosystem** — foxes hunt rabbits,
rabbits forage grass — built on a zero-allocation C++ backend with a
permutation-invariant, shared-policy MARL stack. Populations rise and crash in
classic predator–prey waves that run indefinitely without going extinct.

This is the second roadmap in this repo. It scales the original single-wolf
arena (see [The original single-wolf scenario](#the-original-single-wolf-scenario))
up to hundreds of independently-living agents that are born, eat, reproduce, and
die. The 4-task roadmap is in `goal.md`.

## What we built

| Task | what | status |
|------|------|--------|
| 1. Target-based C++ pathfinding | fixed 1024-slot pool, bounded A*, native obstacle rejection, greedy fallback | ✅ |
| 2. Multi-scale perception | DeepSets local entities plus 24-slot egocentric density rings | ✅ |
| 3. Tactical MARL rewards | normalized rabbit cohesion and fox assist shaping, clipped PPO + GAE | ✅ |
| 4. Emergent tactics validation | herding screen passes; predator phase-lock tuning remains | partial |

See [Status / measured results](#status--measured-results) for numbers.

## Architecture

```
            ┌──────────────────────────── eco_engine.cpp (C++) ───────────────────────────┐
            │  fixed pool[1024]  SoA: type,x,y,energy,age     dense active-list (no scans) │
            │  counting-sort spatial hash grid  → O(1) neighbours · bounded A* wall routing│
            │  metabolism · eat (grid) · binary fission · death (free-list) · grass regrow │
            │  refuge source-population (anti-extinction guardrail)                        │
            └───────────────┬───────────────────────────────────┬──────────────────────────┘
                            │ build_agent_obs()                  │ step(actions[1024], use_actions)
                            ▼                                    ▲
        per-agent obs[n,124] + slots + types         per-slot float targets (dx, dy)
                            │                                    │
            ┌───────────────▼─────── eco_marl.py ────────────────┴──────────────┐
            │  route obs by type → Fox_Policy θ_fox / Rabbit_Policy θ_rabbit     │
            │  assert no cross-contamination · PPO update on BOTH heads          │
            └───────────────┬───────────────────────────────────────────────────┘
                            ▼  eco_policy.py
            EcoPolicy = PermInvTrunk(self + local max-pool + density rings) → actor(81) + critic
```

### Observation (per living agent) — `eco_policy.py`, mirrored in `eco_engine.cpp`

`OBS_DIM = SELF_DIM(4) + MAX_VIS(16) × ENT_DIM(6) + DENSITY_DIM(24) = 124`,
all `float32`:

```
self  [0..3]   x, y (∈[-1,1]),  energy/repro_threshold (∈[0,1]),  is_fox
ent×16[4..99]  per visible neighbour (nearest 16 within vision radius):
                 active, rel_dx/vision, rel_dy/vision, is_rabbit, is_fox, is_grass
density[100..123] log10(count + 1) in 8 directions × 3 distance bands
```

Inactive entity slots are zeroed. Because the trunk **max-pools** over the entity
axis, slot *order* and *padding* are irrelevant — this is what makes the policy
robust to entities dying / reproducing / warping array positions.

### Action — `Discrete(81)` target lattice

One of 81 egocentric target offsets on a 9×9 lattice. The C++ engine resolves the
low-level movement with A* capped at 32 expansions. Blocked or over-budget targets
fall back immediately to a greedy vector without entering wall cells.

### Reward (`eco_marl.py::collect`)

Per-agent reward includes energy delta and `−10` on death. Threatened rabbits get
a signed normalized proximity reward in `[-0.005, +0.005]`; foxes get bounded
close-prey and pack-pressure shaping plus normalized coordinated-kill
amplification. `eco_marl.py` optimizes identity-safe trajectories with clipped
PPO, value clipping, entropy regularization, and GAE.

## Quickstart

```bash
bash build_eco.sh                 # build eco_engine (.so);  or see build.sh flags

# 1. validate the engine (grid==naive, 0% memory drift, graceful cap)
python3 test_eco.py

# 2. validate the perm-invariant trunk (order-invariance to 1e-5) + MARL plumbing
python3 test_policy.py
python3 test_marl.py

# 3. show sustained Lotka–Volterra oscillation (200k frames, ASCII population plot)
python3 eco_oscillation.py

# 4. train the shared policies once, then watch them live
python3 train_eco.py --iters 1000 --device cuda --out experiments/eco_tactical.pt
# continue tuning the same policy weights
python3 train_eco.py --iters 500 --device cuda --resume --out experiments/eco_tactical.pt
python3 eco_server.py --policy --ckpt experiments/eco_tactical.pt --hz 30 --device cuda
python3 eco_tactics.py --checkpoint experiments/eco_tactical.pt --device cuda
```

> The older `experiments/eco_policies.pt` checkpoint predates target actions.
> Train `experiments/eco_tactical.pt` before evaluating coordinated behavior.

## Live viewer

`eco_server.py` runs one live `EcoEngine` and streams every entity's position +
type and the running fox/rabbit/grass counts over a WebSocket to a Three.js scene
(`eco_index.html`): grass nodes grow from the terrain, procedural rabbits hop
between streamed positions, and animated mutant rigs from `wow-arena` visualize
foxes. `EcoEngine`, `ECO`, and the existing fox/rabbit shared policies remain
authoritative; `wow-arena` contributes graphics only. A scrolling population
graph shows foxes **lagging** rabbits.

```bash
python3 eco_server.py --hz 30                        # random-walk agents (instant, no training)
python3 eco_server.py --policy --hz 30 --device cuda # trained target policies
```

Then open **http://localhost:8000/eco_index.html**.

### Viewer controls

| input | effect |
|-------|--------|
| **click** scene | capture the mouse for the fly camera; click again while captured to inspect the aimed-at entity |
| **mouse** | look around while the fly camera is captured |
| **`W` / `A` / `S` / `D`** | fly horizontally |
| **`R` / `F`** or **space** | rise / fall |
| **shift** | fly faster |
| **`E`** | inspect the entity under the crosshair |
| **`+` / `−`** | replay speed 0.1×–8× (browser sends `{speed}`, server scales its tick interval) |

The selection panel (`Sim.inspect` → WebSocket, bidirectional) shows, per click:

- **state** — self state, nearest entities, and the density-ring peak;
- **action** — the highest-probability coordinate targets, chosen target, and critic value.

Grass reports as a passive energy node (no observation, no policy). In random-walk
mode the panel shows state only, with a note that no policy is loaded.

## Files

| file | what |
|------|------|
| `eco_engine.cpp` / `build_eco.sh` | Task 1–2 — fixed pool, spatial grid, bounded A*, density observations |
| `eco_policy.py` | Task 2 — local DeepSets encoder plus density channel and target lattice |
| `eco_marl.py` | Task 3 — type-routed targets, normalized group rewards, clipped PPO + GAE |
| `eco_oscillation.py` | structural long-horizon oscillation validator + tuned config `ECO` |
| `eco_tactics.py` | compare trained coordination metrics against random walk |
| `train_eco.py` | train both policies once → `experiments/eco_tactical.pt` |
| `eco_server.py` / `eco_index.html` / `eco_viewer.js` | live Three.js WebSocket viewer (random-walk or pretrained); fly camera, crosshair inspection, `+/−` replay speed |
| `test_eco.py` / `test_policy.py` / `test_marl.py` | acceptance harnesses for Tasks 1–3 |
| `eco_arena_env.py` | WoW-arena branch — 3v3 two-team arena (4 pillars, combat layer) + coordinated CC-chain metric and reference tactics |
| `eco_arena.py` | arena action-head masking + Task 4 action-mask alignment guardrail (`assert_mask_lock`) |
| `eco_arena_policy.py` | multi-head masked arena policy (perm-inv trunk + move/spell/target heads + critic) |
| `eco_arena_train.py` | Task 3 curriculum manager — Stage 1 target-dummy training + cross-stage checkpoint reload |
| `test_arena.py` | arena acceptance harness — CC masking, diminishing returns, mask-lock guardrail, 3v3 CC-chain metric, curriculum |

### WoW-arena branch (`threejs-eco-rendering`)

Layered on the ecosystem engine without disturbing its hot path:

- **Task 1** — `eco_engine.cpp::line_of_sight` (drift-free integer-grid DDA) and
  `add_pillar` give arena line-of-sight occlusion + 4 static circular pillars; the
  existing bounded A* already routes around them.
- **Task 2** — additive combat state machine: per-agent hp/mana, `NSPELL`
  cooldowns, `cc_timer`/status enum (IDLE/STUNNED/POLYMORPHED), per-category
  Diminishing Returns (full/half/quarter/immune). `cast_spell` enforces
  alive/not-CC'd/off-cooldown/mana + line-of-sight; `build_action_mask` hard-locks
  movement + non-idle spells for a CC'd or dead agent.
- **Task 4 guardrail** — `eco_arena.assert_mask_lock` is the strict runtime check
  that mask and combat state never drift under target swaps / deaths.
- **Task 3** — `eco_arena_policy.py` multi-head masked policy + `eco_arena_train.py`
  `CurriculumManager`: Stage 1 (target dummy) training improves damage efficiency
  (~200 → ~310 dmg/episode) and cross-stage checkpoint reload preserves the trunk
  + head structure exactly. Stages 2 (1v1 + LoS) and 3 (3v3 shared-policy) scaffolded.
- **Task 3/4 harness** — `eco_arena_env.py` measures coordinated CC-chain success;
  scripted burst+peel reaches ~60% vs ~22% random, validating the metric for
  trained policies.

## Status / measured results

| Task | result |
|------|--------|
| 1. engine | 200 concurrent bounded-A* queries **0.031 ms/frame**; grid step bit-identical; refuge slots reserved under cap pressure |
| 2. perception | local permutation invariance exact; 24 density slots distinguish clustered populations beyond the nearest-16 cap |
| 3. MARL | both heads update; target routing, reward bounds, and 50-agent simultaneous terminal GAE verified |
| 4. tactics | 5k-frame screen: trained rabbit threat-state spacing **−40.6%** vs random (herding target met); phase correlation **0.15** (required ≥0.65, still failing) |

## Caveats (and how to push past them)

These are honest limitations of the current state, each with a concrete pointer.

- **"≥5M steps/s" (Task 1 target) is not physically attainable for a *full*
  ecosystem tick.** A tick does ~4 passes over ~500 entities, so 5M ticks/s would
  need billions of entity-updates/s single-threaded. Measured: **~0.1–0.3M
  full-ecosystem ticks/s** at 500 entities. What the spatial grid *actually* buys
  is **O(N) scaling and exact correctness**, not the headline number — verified by
  `test_eco.py::test_grid_correctness` (grid == naive) and the density sweep
  (~0.9× at 230 entities → ~2.5× at 480, widening as N grows). To go faster:
  thread the per-agent loops (OpenMP over `alist` in `eco_engine.cpp::step`) or
  run many independent arenas in parallel à la the original `engine.cpp`
  (23.7M *agent*-steps/s).

- **The oscillation is mostly *structural*, not learned.** It comes from
  density-dependent predation + finite grass, and is kept off the extinction floor
  by a mechanical refuge — `refuge_rabbits` / `refuge_foxes` in `eco_engine.cpp`,
  re-seeded *to target each tick* (the `while` loops at the end of `step()`; a
  1/tick version lets a fox boom wipe rabbits faster than they respawn). Set both
  to `0` and the system collapses within ~hundreds of steps (see the early sweep
  in this repo's history). The tuned numbers live in `ECO` in
  `eco_oscillation.py` (config "E").

- **Trained phase lock is not complete.** The target policy now clusters rabbits
  under threat, but fox kills remain too sparse to preserve the structural wave
  correlation. `python3 eco_tactics.py --checkpoint experiments/eco_tactical.pt
  --device cuda` prints the trained-versus-random screen. Continue tuning fox
  pursuit and pack rewards before claiming autonomous tactical validation.

- **The shipped checkpoint predates the target-action policy.** Loading it keeps
  compatible layers, but the new density and coordinate heads need a fresh run:
  `python3 train_eco.py --iters 1000 --device cuda`.

- **MARL uses a custom loop, not PufferLib's native multi-agent vectorizer.**
  Task 3 demonstrates the *shared-policy mechanics* the spec asks for (two weight
  spaces, variable agents, ID-sync guardrail, gradients to both heads — all in
  `eco_marl.py` / `test_marl.py`) but routes obs→policy→actions in Python rather
  than through `pufferlib`'s multiagent wrapper. Throughput is bound by that
  Python-side per-frame routing, not the C++ engine.

- **Live policy inference is CPU-bound.** ~200 agents/tick through two MLP
  policies is **~61 ms/frame on CPU** (too slow for 30 Hz) vs **~12.7 ms on GPU**.
  Use `--device cuda`, or `--hz 15` on CPU (`eco_server.py::Sim.tick`). Random-walk
  mode (`--policy` omitted) is ~0.03 ms/frame either way.

- **Both species share one `repro_threshold`.** Foxes and rabbits use the same
  energy threshold to reproduce (`eco_engine.cpp`); their *effective* thresholds
  differ only because their per-event energy gains differ (`grass_energy` vs
  `rabbit_energy_to_fox`). Add separate fox/rabbit thresholds there if you want
  finer control over each species' growth rate.

## The original single-wolf scenario

The first roadmap in this repo (older `goal.md`, 5 tasks) is a WoW-arena-style
slice: **one wolf learns to hunt rabbits** from a relative/egocentric game-state
(not pixels), trained with PufferLib PPO. It includes a NumPy reference env, a
headless C++ engine at **23.7M agent-steps/s** with zero per-step allocation,
native in-bounds action masking (0 boundary violations), curriculum scaling
(3×3 → 15×15 with no weight reset), and its own 60 Hz WebSocket viewer.

Files: `wolf_rabbit.py` (NumPy env), `engine.cpp` / `build.sh` (C++ engine),
`wolf_rabbit_cpp.py` (`PufferEnv` + `MaskedPolicy`), `train.py`,
`train_curriculum.py`, `eval.py`, `server.py` + `index.html`.

```bash
bash build.sh
python train.py --backend cpp --timesteps 2000000 --device cuda --save experiments/wolf_cpp.pt
python server.py --model experiments/wolf_curriculum.pt --hz 30   # http://localhost:8000/
```

Per-agent obs is a fixed `MAX_RABBITS=8` entity array
(`[wolf_x/H, wolf_y/H, (active, rel_dx/2H, rel_dy/2H)×8]`, +8 mask bits on the
C++ backend); action is `MultiDiscrete([8,2])` (direction, stay/move). This is
the single-agent, fixed-array ancestor that the ecosystem's permutation-invariant,
variable-population design replaces.

## Notes

- The `gym` deprecation warning comes from PufferLib's internal `pufferlib.spaces`
  importing legacy `gym`; our envs use `gymnasium.spaces`. Harmless.
- `pip` here needs `--break-system-packages` (PEP 668); that's how `pybind11` /
  `websockets` were installed.
