# Wolf–Rabbit Arena RL (PufferLib)

Steps toward a WoW-arena-style entity-RL game. MVP: wolves hunt rabbits on a
continuous 2D arena, trained with PufferLib PPO on a simplified game-state
observation (relative/egocentric, not pixels). Built to extend later toward
projectiles, debuffs, walls, friend/foe, and multi-head encoders.

## What we accomplished

A complete, working vertical slice of an entity-RL game — from environment to
trained policy to a live browser visualizer — built end-to-end against the
5-task roadmap in `goal.md`:

- A wolf that **learns to hunt** purely from simplified game-state (relative
  entity positions), not pixels — ~24 rabbits caught per 256-step episode.
- The exact same simulation implemented **twice**: a NumPy reference
  (`wolf_rabbit.py`) and a headless **C++ engine** (`engine.cpp`, ~24M
  agent-steps/s, zero per-step allocation) that doubles as the future game
  backend.
- **Native action masking** so the wolf physically cannot walk out of bounds
  (0 violations), with the mask generated inside the C++ step loop.
- **Curriculum learning**: one network trained on a 3×3 arena and grown in place
  to 15×15 without resetting weights — and it still solves the small arena
  (no catastrophic forgetting).
- A **30/60 Hz WebSocket server** running live policy inference + the C++ engine,
  streaming entity state to a canvas client at ~1.9 ms/frame.

See the measured numbers in [Status / measured results](#status--measured-results).

## Inputs → Model → Outputs

This is the "MOBA-paper" style design the goal asked for: a compact, structured
game-state vector in, a multi-head discrete action out — **no pixels**.

### Input (observation)

Egocentric and relative, so the policy is translation-invariant and the same
network works at any arena scale. Per agent, a flat `float32` vector:

```
index   field                     meaning
0       wolf_x / H                self position, normalized to [-1,1]
1       wolf_y / H
2..25   per rabbit slot × 8:      fixed-capacity "entity array"
          active                    1 if this slot holds a live rabbit
          rel_dx / (2H)             rabbit position RELATIVE to wolf, normalized
          rel_dy / (2H)
26..33  dir_mask[8]               (C++ backend only) 1 = direction is in-bounds
```

`MAX_RABBITS = 8` is a hardcoded constant (not the live count) — the array is
always full-size and inactive slots are zeroed. This is what keeps the buffers
fixed-shape for PufferLib's zero-copy vectorization, and it's the extension
point for friend/foe, projectiles, or walls later (just more entity arrays).

### Model architecture

A small MLP actor-critic (`pufferlib.models.Default` for the NumPy backend,
`MaskedPolicy` in `wolf_rabbit_cpp.py` for the masked C++ backend):

```
obs (26 or 34)
   │
   └─► Linear(→128) ─► GELU            # shared encoder/"trunk"  (~4.9K params)
          │
          ├─► Linear(128 → 8+2)  ─► split ─► [ dir_logits(8), move_logits(2) ]   # actor heads
          │        └─ (masked backend) dir_logits += -1e8 * (1 - dir_mask)
          │
          └─► Linear(128 → 1)                                                     # critic (value)
```

- Trunk: single 128-unit hidden layer with GELU. Tiny on purpose — the task is
  low-dimensional, and small nets train in seconds and run in <2 ms/frame.
- **Action masking** is applied to the direction-head logits *before* sampling:
  out-of-bounds directions get a `-1e8` bias, so their probability is ~0. The
  mask rides in on the observation tail, so it needs no special PufferLib
  plumbing.
- Trained with PPO via `pufferlib.pufferl.PuffeRL` (the same trainer behind the
  `puffer train` CLI), GAE, entropy bonus, LR annealing.

### Output (action)

`MultiDiscrete([8, 2])` — two independent discrete heads sampled each tick:

```
head 0  direction  ∈ {0..7}   8 compass directions (E, NE, N, NW, W, SW, S, SE)
head 1  move       ∈ {0,1}    0 = stay in place, 1 = step in chosen direction
```

The chosen direction's unit vector × `wolf_speed` × `move` updates the wolf's
continuous position. (Roadmap "future heads" — attack / ability / target-select
— slot in as additional `MultiDiscrete` entries with the same masking pattern.)

### Reward

`+1` per rabbit eaten (wolf within `eat_radius`), plus a small distance-shaping
term (reduction in distance to the nearest rabbit) to densify early learning.
Eaten rabbits respawn at a random location so the hunt is continuous.

## Core design (zero-allocation flat buffers)

Everything is a fixed-size, contiguous, hardcoded-shape array so PufferLib's
zero-copy shared-memory vectorization stays safe.

- **Observation** (`float32`, len `2 + 3*MAX_RABBITS = 26`; C++ backend appends
  an 8-bit action mask → 34):
  `[ wolf_x/H, wolf_y/H,  (active, rel_dx/2H, rel_dy/2H) × MAX_RABBITS ]`
- **Action**: `MultiDiscrete([8, 2])` → head0 = 8 compass directions,
  head1 = stay/move. (Future heads: attack / ability.)
- **Mask** (`uint8[N,8]`): 1 = that direction keeps the wolf in-bounds.

## Files

| file | what |
|------|------|
| `wolf_rabbit.py` | Task 1 — pure-NumPy vectorized `PufferEnv` (reference impl) |
| `engine.cpp` / `build.sh` | Task 2/3 — headless C++ engine + pybind11, native action masking |
| `wolf_rabbit_cpp.py` | C++-backed `PufferEnv` + `MaskedPolicy` (applies mask to logits) |
| `train.py` | PPO training (`--backend numpy|cpp`) |
| `train_curriculum.py` | Task 4 — grow arena 3×3→6×6→15×15, no weight reset |
| `eval.py` | greedy evaluation: rabbits eaten + boundary hits |
| `server.py` | Task 5 — async WebSocket server: live engine + policy inference |
| `index.html` | Task 5 — canvas viewer (auto-served at http://localhost:8000/) |

## Quickstart

```bash
bash build.sh                                   # build C++ engine (.so)
python train.py --backend cpp --timesteps 2000000 --num-agents 2048 \
    --batch-size 65536 --minibatch-size 16384 --device cuda --save experiments/wolf_cpp.pt
python eval.py --model experiments/wolf_cpp.pt
python train_curriculum.py --device cuda        # Task 4
```

Always start with a short run (~1 min) to time before scaling up.

## Status / measured results

| Task | status | result |
|------|--------|--------|
| 1. NumPy prototype + PPO | ✅ | ~1.5M agent-steps/s; trained wolf eats **21/episode** on 3×3 |
| 2. C++ engine + pybind11 | ✅ | **23.7M agent-steps/s** single core; RSS drift ~0% (zero-alloc step loop) |
| 3. Native action masking | ✅ | masked policy → **0 boundary violations**, 17 eaten/episode |
| 4. Curriculum / scale invariance | ✅ | weights grow 3×3→6×6→15×15; validation **23.9 / 11.5 / 4.3** eaten/ep, 0 boundary hits, no regression on 3×3 |
| 5. WebSocket real-time playback | ✅ | `server.py` + `index.html`; 60 Hz stream, **~1.9 ms/frame** (target ≤5 ms), live hunting |

Run the viewer: `python server.py --model experiments/wolf_curriculum.pt --hz 30`
then open http://localhost:8000/ (orange = wolf, blue = rabbits; HUD shows
frame-time against the 5 ms budget).

## Notes

- The `gym` deprecation warning is from PufferLib's internal `pufferlib.spaces`
  isinstance-tuples importing legacy `gym 0.23`; our envs are built with
  `gymnasium.spaces`. Harmless.
- Custom (non-packaged) envs are trained by driving `pufferlib.pufferl.PuffeRL`
  directly (same trainer as the `puffer train` CLI).
