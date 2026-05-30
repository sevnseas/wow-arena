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
| 1. C++ spatial-grid ecosystem engine | fixed 1024-slot entity pool, free-list recycling, counting-sort spatial hash grid, metabolism / eating / binary-fission reproduction / death | ✅ |
| 2. Permutation-invariant trunk | DeepSets self-state + shared per-entity MLP + masked max-pool; order-invariant policy | ✅ |
| 3. Shared-policy MARL | two weight spaces (Fox / Rabbit), variable active agents per frame, ID-synced action routing | ✅ |
| 4. Ecological oscillation | tuned config → sustained Lotka–Volterra waves, never extinct | ✅ |

See [Status / measured results](#status--measured-results) for numbers.

## Architecture

```
            ┌──────────────────────────── eco_engine.cpp (C++) ───────────────────────────┐
            │  fixed pool[1024]  SoA: type,x,y,energy,age     dense active-list (no scans) │
            │  counting-sort spatial hash grid  → O(1) neighbour queries                   │
            │  metabolism · eat (grid) · binary fission · death (free-list) · grass regrow │
            │  refuge source-population (anti-extinction guardrail)                        │
            └───────────────┬───────────────────────────────────┬──────────────────────────┘
                            │ build_agent_obs()                  │ step(actions[1024], use_actions)
                            ▼                                    ▲
        per-agent obs[n,100] + slots + types          per-slot int8 actions (0..7)
                            │                                    │
            ┌───────────────▼─────── eco_marl.py ────────────────┴──────────────┐
            │  route obs by type → Fox_Policy θ_fox / Rabbit_Policy θ_rabbit     │
            │  assert no cross-contamination · PPO update on BOTH heads          │
            └───────────────┬───────────────────────────────────────────────────┘
                            ▼  eco_policy.py
            EcoPolicy = PermInvTrunk(self + masked max-pool over entities) → actor(8) + critic
```

### Observation (per living agent) — `eco_policy.py`, mirrored in `eco_engine.cpp`

`OBS_DIM = SELF_DIM(4) + MAX_VIS(16) × ENT_DIM(6) = 100`, all `float32`:

```
self  [0..3]   x, y (∈[-1,1]),  energy/repro_threshold (∈[0,1]),  is_fox
ent×16[4..99]  per visible neighbour (nearest 16 within vision radius):
                 active, rel_dx/vision, rel_dy/vision, is_rabbit, is_fox, is_grass
```

Inactive entity slots are zeroed. Because the trunk **max-pools** over the entity
axis, slot *order* and *padding* are irrelevant — this is what makes the policy
robust to entities dying / reproducing / warping array positions.

### Action — `Discrete(8)`

One of 8 compass directions; the agent always steps `move_speed` that way
(reflective arena boundaries). Foxes and rabbits run the *same architecture* with
*independent weights*.

### Reward (minimal; `eco_marl.py::collect`)

Per-agent, derived from the engine each tick: `energy gained this step`
(foxes from eating rabbits, rabbits from grass), `+0.01` rabbit survival bonus,
`−1` on death. Tuning the *ecology* (config `ECO` in `eco_oscillation.py`) does
most of the work; see caveats.

## Quickstart

```bash
bash build_eco.sh                 # build eco_engine (.so);  or see build.sh flags

# 1. validate the engine (grid==naive, 0% memory drift, graceful cap)
python test_eco.py

# 2. validate the perm-invariant trunk (order-invariance to 1e-5) + MARL plumbing
python test_policy.py
python test_marl.py

# 3. show sustained Lotka–Volterra oscillation (200k frames, ASCII population plot)
python eco_oscillation.py

# 4. train the shared policies once, then watch them live
python train_eco.py --iters 200 --device cuda      # -> experiments/eco_policies.pt
python eco_server.py --policy --hz 30 --device cuda # open http://localhost:8000/eco_index.html
```

> The repo ships a prebuilt `eco_engine*.so` and a trained
> `experiments/eco_policies.pt`, so you can skip straight to step 4.

## Live viewer

`eco_server.py` runs one live `EcoEngine` and streams every entity's position +
type and the running fox/rabbit/grass counts over a WebSocket to a canvas
(`eco_index.html`): green = grass, white = rabbits, red = foxes, plus a scrolling
population graph where you can watch foxes **lag** rabbits.

```bash
python eco_server.py --hz 30                        # random-walk agents (instant, no training)
python eco_server.py --policy --hz 30 --device cuda # pretrained shared policies
```

Then open **http://localhost:8000/eco_index.html**.

## Files

| file | what |
|------|------|
| `eco_engine.cpp` / `build_eco.sh` | Task 1 — C++ ecosystem engine + pybind11 (spatial grid, fixed pool, metabolism, refuge) |
| `eco_policy.py` | Task 2 — `PermInvTrunk` (DeepSets / masked max-pool) + `EcoPolicy` |
| `eco_marl.py` | Task 3 — `MARLRunner`: two shared policies, type-routed actions, ID-sync guard, PPO update, `save`/`load` |
| `eco_oscillation.py` | Task 4 — long-horizon validator + tuned config `ECO` |
| `train_eco.py` | train both policies once → `experiments/eco_policies.pt` |
| `eco_server.py` / `eco_index.html` | live WebSocket viewer (random-walk or pretrained) |
| `test_eco.py` / `test_policy.py` / `test_marl.py` | acceptance harnesses for Tasks 1–3 |

## Status / measured results

| Task | result |
|------|--------|
| 1. engine | grid step **bit-identical** to brute-force O(N²); **0.000 % RSS drift over 5M churn steps**; graceful cap (never overflows 1024); grid speedup over naive grows with density |
| 2. trunk | permutation invariance **exact (0.00e+00**, target ≤1e-5), incl. closest/furthest swap; padding ignored; GPU inference **1.3–2.5 ms** (≤3.5 ms budget) |
| 3. MARL | variable agent counts handled; gradients reach **both** heads; cross-contamination guard verified (+ negative control fires on deliberate mislabel) |
| 4. oscillation | **200,000 frames, never 0-population**; foxes lag rabbits (xcorr +, corr 0.71) = Lotka–Volterra |

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

- **The pretrained policies are lightly trained.** `experiments/eco_policies.pt`
  is 200 iterations of a *PPO-lite* update (`eco_marl.py::update`: single-step
  return `r + γ·V`, no GAE, no clip ratio, no entropy term) on a minimal reward.
  They reach a balanced ~100 fox / ~96 rabbit state but don't look dramatically
  smarter than random-walk in the viewer. To get visibly better hunting:
  `python train_eco.py --iters 1000 --device cuda`, and/or upgrade `update()` to
  full clipped PPO + GAE and add reward shaping (e.g. distance-to-prey) in
  `collect()`.

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
