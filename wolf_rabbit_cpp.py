"""C++-backed PufferEnv + mask-aware policy (Tasks 2 & 3 integration).

The native C++ Engine owns flat buffers; this PufferEnv copies them into the
buffers PufferLib hands us each step (a single memcpy each -- still ~10M+
agent-steps/sec end to end). The 8-direction boundary mask produced inside the
C++ step loop is appended to the observation tail, so it rides PufferLib's
standard zero-copy obs pipeline with no extra plumbing. MaskedPolicy slices it
off and biases the direction-head logits by -inf for out-of-bounds moves.

Observation layout (float32), length OBS_DIM + 8:
    [ ...26 sim features (matches wolf_rabbit.py)... , 8 direction-mask bits ]
"""
import numpy as np
import gymnasium
import torch
from torch import nn

import pufferlib
import pufferlib.models
import pufferlib.pytorch

import wolf_engine as we

SIM_OBS = we.OBS_DIM          # 26
N_DIRS = 8
FULL_OBS = SIM_OBS + N_DIRS   # 34 (sim features + action mask)


class WolfRabbitCpp(pufferlib.PufferEnv):
    def __init__(self, buf=None, num_agents=2048, map_half=1.5, n_rabbits=1,
                 wolf_speed=0.15, eat_radius=0.12, max_steps=256, seed=0):
        self.num_agents = int(num_agents)
        self.single_observation_space = gymnasium.spaces.Box(
            low=-1.0, high=1.0, shape=(FULL_OBS,), dtype=np.float32)
        self.single_action_space = gymnasium.spaces.MultiDiscrete([8, 2])
        super().__init__(buf)

        self.eng = we.Engine(num_agents=self.num_agents, map_half=map_half,
                             n_rabbits=n_rabbits, wolf_speed=wolf_speed,
                             eat_radius=eat_radius, max_steps=max_steps, seed=seed)
        self._seed = seed

    def _pull(self):
        # copy engine's flat buffers into PufferLib's buffers
        self.observations[:, :SIM_OBS] = self.eng.observations()
        self.observations[:, SIM_OBS:] = self.eng.masks().astype(np.float32)
        np.clip(self.observations, -1.0, 1.0, out=self.observations)

    def reset(self, seed=None):
        self.eng.reset(self._seed if seed is None else seed)
        self._pull()
        return self.observations, []

    def step(self, actions):
        actions = np.ascontiguousarray(actions, dtype=np.int32).reshape(self.num_agents, 2)
        self.eng.step(actions)
        self.rewards[:] = self.eng.rewards()
        self.terminals[:] = self.eng.terminals().astype(bool)
        self.truncations[:] = self.eng.truncations().astype(bool)
        self._pull()
        infos = []
        trunc_mask = np.asarray(self.truncations)
        if trunc_mask.any():
            # last_* hold per-episode stats snapshotted at truncation (pre-reset)
            le = self.eng.last_eaten()[trunc_mask]
            lb = self.eng.last_boundary_hits()[trunc_mask]
            infos = [{'eaten': float(le.mean()),
                      'boundary_hits': float(lb.mean())}]
        return (self.observations, self.rewards, self.terminals,
                self.truncations, infos)

    def close(self):
        pass


class MaskedPolicy(nn.Module):
    """Default MLP policy that applies the C++ boundary mask to direction logits."""
    def __init__(self, env, hidden_size=128):
        super().__init__()
        self.action_nvec = tuple(env.single_action_space.nvec)  # (8, 2)
        self.encoder = nn.Sequential(
            nn.Linear(FULL_OBS, hidden_size), nn.GELU())
        self.decoder = pufferlib.pytorch.layer_init(
            nn.Linear(hidden_size, sum(self.action_nvec)), std=0.01)
        self.value = pufferlib.pytorch.layer_init(nn.Linear(hidden_size, 1), std=1)

    def forward_eval(self, obs, state=None):
        obs = obs.float()
        mask = obs[:, SIM_OBS:]                       # (B, 8) 1=allowed
        hidden = self.encoder(obs)
        logits = self.decoder(hidden).split(self.action_nvec, dim=1)
        dir_logits = logits[0].masked_fill(mask < 0.5, -1e8)
        return [dir_logits, logits[1]], self.value(hidden)

    def forward(self, obs, state=None):
        return self.forward_eval(obs, state)
