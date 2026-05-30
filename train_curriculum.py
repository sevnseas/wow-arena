"""Task 4: Curriculum + scale invariance.

Train on a tiny 3x3 arena until the wolf is a proficient tracker, then grow the
arena in place (3x3 -> 6x6 -> 15x15) by poking the C++ engine's map_half via
set_map_half -- WITHOUT resetting network weights. Finally validate that the
policy still solves the original 3x3 (no catastrophic regression).

Proficiency metric: trailing-average rabbits eaten per episode. Crossing the
threshold advances the curriculum stage.

    python train_curriculum.py --device cuda
"""
import argparse
from collections import deque
import numpy as np
import torch

import pufferlib.vector
import pufferlib.pufferl as pufferl

from wolf_rabbit_cpp import WolfRabbitCpp, MaskedPolicy
from train import make_config

STAGES = [1.5, 3.0, 7.5]            # arena half-extents: 3x3 -> 6x6 -> 15x15
ADVANCE_EATEN = 8.0                  # mean eaten/episode to advance a stage


def eval_eaten(env, policy, device, map_half, steps=256, seed=999):
    """Greedy rollout at a given arena size; returns mean rabbits eaten."""
    env.eng.set_map_half(map_half)
    obs, _ = env.reset(seed=seed)
    for _ in range(steps):
        with torch.no_grad():
            o = torch.as_tensor(obs).to(device).float()
            logits, _ = policy.forward_eval(o, None)
            a = torch.stack([l.argmax(-1) for l in logits], 1).cpu().numpy()
        obs, *_ = env.step(a)
    # all agents reset together at max_steps; last_eaten holds the episode total
    return float(env.eng.last_eaten().mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--num-agents', type=int, default=2048)
    ap.add_argument('--batch-size', type=int, default=65536)
    ap.add_argument('--minibatch-size', type=int, default=16384)
    ap.add_argument('--lr', type=float, default=3e-3)
    ap.add_argument('--max-steps', type=int, default=256)
    ap.add_argument('--stage-timesteps', type=int, default=4_000_000,
                    help='max timesteps to spend per stage before forcing advance')
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    ap.add_argument('--save', default='experiments/wolf_curriculum.pt')
    args = ap.parse_args()

    vecenv = pufferlib.vector.make(
        WolfRabbitCpp,
        env_kwargs=dict(num_agents=args.num_agents, map_half=STAGES[0],
                        n_rabbits=1, max_steps=args.max_steps),
        backend=pufferlib.vector.Serial, num_envs=1)
    env = vecenv.driver_env

    total_budget = args.stage_timesteps * len(STAGES)
    config = make_config(total_budget, args.device, args.batch_size,
                         args.minibatch_size, args.lr)
    policy = MaskedPolicy(env, hidden_size=128).to(args.device)
    trainer = pufferl.PuffeRL(config, vecenv, policy)

    for stage, half in enumerate(STAGES):
        env.eng.set_map_half(half)
        print(f"\n=== Stage {stage}: arena {2*half:.0f}x{2*half:.0f} (map_half={half}) ===",
              flush=True)
        trail = deque(maxlen=10)
        stage_start = trainer.global_step
        while trainer.global_step - stage_start < args.stage_timesteps:
            trainer.evaluate()
            trainer.train()
            for info in getattr(trainer, 'infos', {}) or []:
                pass
            m = eval_eaten(env, policy, args.device, half, seed=stage * 13 + 1)
            trail.append(m)
            avg = np.mean(trail)
            print(f"  step={trainer.global_step:>9}  eval_eaten={m:5.2f}  "
                  f"trail_avg={avg:5.2f}", flush=True)
            # restore training arena (eval mutated it)
            env.eng.set_map_half(half)
            if avg >= ADVANCE_EATEN:
                print(f"  -> proficiency reached (trail_avg {avg:.2f} >= {ADVANCE_EATEN})",
                      flush=True)
                break

    # final validation: no catastrophic regression on the original 3x3
    print("\n=== Validation across all stages (greedy) ===", flush=True)
    for half in STAGES:
        m = eval_eaten(env, policy, args.device, half, seed=4242)
        bh = float(env.eng.boundary_hits().mean())
        print(f"  arena {2*half:>4.0f}x{2*half:<4.0f}  eaten/ep={m:5.2f}  "
              f"boundary_hits/ep={bh:.3f}", flush=True)

    import os
    os.makedirs('experiments', exist_ok=True)
    torch.save(policy.state_dict(), args.save)
    print(f"saved -> {args.save}", flush=True)
    trainer.close()


if __name__ == '__main__':
    main()
