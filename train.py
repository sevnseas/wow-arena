"""Task 1: Train the wolf-rabbit policy with PufferLib's native PPO (PuffeRL).

Reuses pufferlib.models.Default (handles Box obs + MultiDiscrete actions).
Start small: `python train.py --timesteps 200000` runs in well under a minute
on GPU and should show non-nan losses + rising 'eaten' count.
"""
import argparse
import numpy as np
import torch

import pufferlib
import pufferlib.vector
import pufferlib.models
import pufferlib.pufferl as pufferl

from wolf_rabbit import WolfRabbit


# Minimal config dict matching PuffeRL's expected keys (from default.ini [train]).
def make_config(timesteps, device, batch_size, minibatch_size, lr):
    return dict(
        env='wolf_rabbit',
        seed=42, torch_deterministic=True, cpu_offload=False, device=device,
        optimizer='adam', anneal_lr=True, precision='float32',
        total_timesteps=int(timesteps), learning_rate=lr,
        gamma=0.99, gae_lambda=0.95, update_epochs=2, clip_coef=0.2,
        vf_coef=0.5, vf_clip_coef=0.2, max_grad_norm=0.5, ent_coef=0.01,
        adam_beta1=0.9, adam_beta2=0.999, adam_eps=1e-8,
        data_dir='experiments', checkpoint_interval=1000,
        batch_size=batch_size, minibatch_size=minibatch_size,
        max_minibatch_size=minibatch_size, bptt_horizon=16,
        compile=False, compile_mode='default', compile_fullgraph=False,
        vtrace_rho_clip=1.0, vtrace_c_clip=1.0,
        prio_alpha=0.8, prio_beta0=0.2,
        use_rnn=False,
        # logging / misc keys PuffeRL touches
        name='wolf_rabbit', project='arena', neptune=False, wandb=False,
        load_id=None, load_model_path=None,
    )


def build_vecenv(env_cls, num_agents, map_half, n_rabbits, max_steps):
    return pufferlib.vector.make(
        env_cls,
        env_kwargs=dict(num_agents=num_agents, map_half=map_half,
                        n_rabbits=n_rabbits, max_steps=max_steps),
        backend=pufferlib.vector.Serial,
        num_envs=1,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--timesteps', type=int, default=200_000)
    ap.add_argument('--num-agents', type=int, default=4096)
    ap.add_argument('--map-half', type=float, default=1.5)
    ap.add_argument('--n-rabbits', type=int, default=1)
    ap.add_argument('--max-steps', type=int, default=256)
    ap.add_argument('--batch-size', type=int, default=32768)
    ap.add_argument('--minibatch-size', type=int, default=8192)
    ap.add_argument('--lr', type=float, default=3e-3)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    ap.add_argument('--save', default='experiments/wolf_rabbit.pt')
    ap.add_argument('--backend', choices=['numpy', 'cpp'], default='numpy',
                    help="cpp = C++ engine + mask-aware policy (Tasks 2/3)")
    args = ap.parse_args()

    if args.backend == 'cpp':
        from wolf_rabbit_cpp import WolfRabbitCpp, MaskedPolicy
        env_cls = WolfRabbitCpp
    else:
        env_cls = WolfRabbit

    vecenv = build_vecenv(env_cls, args.num_agents, args.map_half,
                          args.n_rabbits, args.max_steps)
    config = make_config(args.timesteps, args.device, args.batch_size,
                         args.minibatch_size, args.lr)
    if args.backend == 'cpp':
        policy = MaskedPolicy(vecenv.driver_env, hidden_size=128).to(args.device)
    else:
        policy = pufferlib.models.Default(vecenv.driver_env, hidden_size=128).to(args.device)

    trainer = pufferl.PuffeRL(config, vecenv, policy)
    while trainer.global_step < args.timesteps:
        trainer.evaluate()
        trainer.train()
    trainer.print_dashboard()

    import os
    os.makedirs('experiments', exist_ok=True)
    torch.save(policy.state_dict(), args.save)
    print(f"saved policy -> {args.save}")
    trainer.close()


if __name__ == '__main__':
    main()
