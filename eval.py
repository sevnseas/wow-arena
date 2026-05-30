"""Evaluate a trained wolf-rabbit policy: rabbits eaten per episode and
boundary violations. Greedy (argmax) actions.

    python eval.py --model experiments/wolf_rabbit.pt --map-half 1.5
"""
import argparse
import numpy as np
import torch

import pufferlib.models
from wolf_rabbit import WolfRabbit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='experiments/wolf_rabbit.pt')
    ap.add_argument('--num-agents', type=int, default=1024)
    ap.add_argument('--map-half', type=float, default=1.5)
    ap.add_argument('--n-rabbits', type=int, default=1)
    ap.add_argument('--max-steps', type=int, default=256)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    args = ap.parse_args()

    env = WolfRabbit(num_agents=args.num_agents, map_half=args.map_half,
                     n_rabbits=args.n_rabbits, max_steps=args.max_steps)
    policy = pufferlib.models.Default(env, hidden_size=128).to(args.device)
    policy.load_state_dict(torch.load(args.model, map_location=args.device))
    policy.eval()

    obs, _ = env.reset(seed=123)
    nvec = tuple(env.single_action_space.nvec)
    total_eaten = []
    total_bhits = []
    for _ in range(args.max_steps):
        with torch.no_grad():
            o = torch.as_tensor(obs).to(args.device).float()
            logits, _ = policy.forward_eval(o, None)
            acts = torch.stack([l.argmax(dim=-1) for l in logits], dim=1).cpu().numpy()
        obs, r, term, trunc, info = env.step(acts)
        for d in info:
            total_eaten.append(d['eaten'])
            total_bhits.append(d['boundary_hits'])

    # also report on agents that didn't truncate yet
    eaten_now = env.eaten.copy()
    print(f"map {args.map_half*2:.1f}x{args.map_half*2:.1f}  "
          f"agents={args.num_agents}  steps={args.max_steps}")
    if total_eaten:
        print(f"completed episodes: {len(total_eaten)}")
        print(f"  mean rabbits eaten/episode : {np.mean(total_eaten):.2f}")
        print(f"  mean boundary hits/episode : {np.mean(total_bhits):.2f}")
    print(f"in-flight eaten (this {args.max_steps}-step rollout): "
          f"mean={eaten_now.mean():.2f}  max={eaten_now.max()}")


if __name__ == '__main__':
    main()
