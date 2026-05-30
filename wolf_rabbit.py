"""Task 1: Flat pure-Python (vectorized NumPy) wolf-rabbit environment.

Native PufferLib 3.0 PufferEnv. State and observations live in flat,
fixed-size contiguous arrays whose shapes are hardcoded constants -- this is
the layout the C++ engine (Task 2) will later write into directly.

Design (per the roadmap, egocentric / relative coordinates):

  Observation (float32), length OBS_DIM = 2 + 3 * MAX_RABBITS:
      [ wolf_x / H,  wolf_y / H,                      # self state (2)
        active, rel_dx/(2H), rel_dy/(2H),  ...  ]     # MAX_RABBITS slots (3 each)

  Action: MultiDiscrete([8, 2])
      head 0 -> one of 8 compass directions
      head 1 -> 0 = stay, 1 = move   (future: attack / ability head)

A single PufferEnv instance holds `num_agents` fully independent games and
steps them all at once with vectorized NumPy, so a "pure Python" loop still
clears the Task-1 throughput target.
"""
import numpy as np
import gymnasium
import pufferlib

MAX_RABBITS = 8           # fixed entity-array capacity (hardcoded constant)
OBS_DIM = 2 + 3 * MAX_RABBITS

# 8 compass directions (unit vectors), index = action head 0
_DIRS = np.array([
    ( 1.0,  0.0), ( 0.70710678,  0.70710678),
    ( 0.0,  1.0), (-0.70710678,  0.70710678),
    (-1.0,  0.0), (-0.70710678, -0.70710678),
    ( 0.0, -1.0), ( 0.70710678, -0.70710678),
], dtype=np.float32)


class WolfRabbit(pufferlib.PufferEnv):
    def __init__(self, buf=None, num_agents=1024, map_half=1.5, n_rabbits=1,
                 wolf_speed=0.15, eat_radius=0.12, max_steps=256, seed=0):
        self.num_agents = int(num_agents)
        self.H = float(map_half)          # map half-extent; "3x3" arena -> 1.5
        self.n_rabbits = int(n_rabbits)   # active rabbits (<= MAX_RABBITS)
        self.wolf_speed = float(wolf_speed)
        self.eat_radius = float(eat_radius)
        self.max_steps = int(max_steps)

        self.single_observation_space = gymnasium.spaces.Box(
            low=-1.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32)
        self.single_action_space = gymnasium.spaces.MultiDiscrete([8, 2])

        super().__init__(buf)
        self.rng = np.random.default_rng(seed)

        N = self.num_agents
        self.wolf = np.zeros((N, 2), dtype=np.float32)
        self.rabbits = np.zeros((N, MAX_RABBITS, 2), dtype=np.float32)
        self.active = np.zeros((N, MAX_RABBITS), dtype=bool)
        self.steps = np.zeros(N, dtype=np.int32)
        # diagnostics
        self.eaten = np.zeros(N, dtype=np.int32)
        self.boundary_hits = np.zeros(N, dtype=np.int32)
        self.steps_to_eat = np.zeros(N, dtype=np.int32)

    # ---- helpers -------------------------------------------------------
    def _rand_pos(self, mask):
        """Uniform positions inside the arena for the True entries of mask."""
        out = self.rng.uniform(-self.H, self.H, size=mask.shape + (2,)).astype(np.float32)
        return out

    def _respawn_rabbits(self, agent_idx, slot_mask):
        pos = self.rng.uniform(-self.H, self.H,
                               size=(len(agent_idx), MAX_RABBITS, 2)).astype(np.float32)
        self.rabbits[agent_idx] = np.where(slot_mask[..., None], pos, self.rabbits[agent_idx])

    def _nearest_rabbit_dist(self):
        """Distance from each wolf to its nearest active rabbit, plus rel vecs."""
        rel = self.rabbits - self.wolf[:, None, :]            # (N, MAX, 2)
        d = np.linalg.norm(rel, axis=-1)                      # (N, MAX)
        d = np.where(self.active, d, np.inf)
        return d, rel

    def _compute_obs(self):
        rel = self.rabbits - self.wolf[:, None, :]            # (N, MAX, 2)
        self.observations[:, 0] = self.wolf[:, 0] / self.H
        self.observations[:, 1] = self.wolf[:, 1] / self.H
        ent = self.observations[:, 2:].reshape(self.num_agents, MAX_RABBITS, 3)
        ent[:, :, 0] = self.active.astype(np.float32)
        ent[:, :, 1] = (rel[:, :, 0] / (2 * self.H)) * self.active
        ent[:, :, 2] = (rel[:, :, 1] / (2 * self.H)) * self.active
        np.clip(self.observations, -1.0, 1.0, out=self.observations)

    # ---- gym API -------------------------------------------------------
    def reset(self, seed=None):
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        N = self.num_agents
        self.wolf[:] = self.rng.uniform(-self.H, self.H, size=(N, 2)).astype(np.float32)
        self.rabbits[:] = self.rng.uniform(-self.H, self.H,
                                           size=(N, MAX_RABBITS, 2)).astype(np.float32)
        self.active[:] = False
        self.active[:, :self.n_rabbits] = True
        self.steps[:] = 0
        self.steps_to_eat[:] = 0
        self.eaten[:] = 0
        self.boundary_hits[:] = 0
        d0, _ = self._nearest_rabbit_dist()
        self._prev_dist = d0.min(axis=1)
        self._compute_obs()
        return self.observations, []

    def step(self, actions):
        actions = np.asarray(actions).reshape(self.num_agents, 2)
        direction = _DIRS[actions[:, 0]]                      # (N, 2)
        move = actions[:, 1].astype(np.float32)[:, None]      # 0 stay / 1 move
        new_wolf = self.wolf + direction * move * self.wolf_speed

        # boundary handling: clamp, and count would-be violations
        clamped = np.clip(new_wolf, -self.H, self.H)
        self.boundary_hits += np.any(clamped != new_wolf, axis=1).astype(np.int32)
        self.wolf[:] = clamped

        self.rewards[:] = 0.0
        self.steps += 1
        self.steps_to_eat += 1

        d, rel = self._nearest_rabbit_dist()
        # distance shaping toward nearest rabbit (helps early learning)
        shaped = (self._prev_dist - d.min(axis=1)) * 1.0
        shaped[~np.isfinite(shaped)] = 0.0
        self.rewards += shaped.astype(np.float32)

        # eating: any active rabbit within eat_radius
        hit = (d <= self.eat_radius) & self.active            # (N, MAX)
        any_hit = np.any(hit, axis=1)
        if any_hit.any():
            self.rewards[any_hit] += 1.0
            self.eaten[any_hit] += 1
            self.steps_to_eat[any_hit] = 0
            # respawn eaten rabbits at fresh random positions (continuous task)
            idx = np.where(any_hit)[0]
            new_pos = self.rng.uniform(-self.H, self.H,
                                       size=(len(idx), MAX_RABBITS, 2)).astype(np.float32)
            self.rabbits[idx] = np.where(hit[idx][..., None], new_pos, self.rabbits[idx])

        # truncate on time limit and auto-reset that game
        self.truncations[:] = False
        self.terminals[:] = False
        trunc = self.steps >= self.max_steps
        infos = []
        if trunc.any():
            idx = np.where(trunc)[0]
            for i in idx:
                infos.append({'eaten': int(self.eaten[i]),
                              'boundary_hits': int(self.boundary_hits[i])})
            self.truncations[trunc] = True
            N = len(idx)
            self.wolf[idx] = self.rng.uniform(-self.H, self.H, size=(N, 2)).astype(np.float32)
            self.rabbits[idx] = self.rng.uniform(-self.H, self.H,
                                                 size=(N, MAX_RABBITS, 2)).astype(np.float32)
            self.active[idx] = False
            self.active[idx, :self.n_rabbits] = True
            self.steps[idx] = 0
            self.eaten[idx] = 0
            self.boundary_hits[idx] = 0
            self.steps_to_eat[idx] = 0

        d2, _ = self._nearest_rabbit_dist()
        self._prev_dist = d2.min(axis=1)
        self._compute_obs()
        return (self.observations, self.rewards, self.terminals,
                self.truncations, infos)

    def close(self):
        pass


if __name__ == '__main__':
    # smoke test: random agent, measure throughput and sanity
    import time
    env = WolfRabbit(num_agents=1024)
    obs, _ = env.reset(seed=0)
    assert obs.shape == (1024, OBS_DIM), obs.shape
    n = 2000
    t0 = time.time()
    for _ in range(n):
        a = np.stack([env.rng.integers(0, 8, 1024),
                      env.rng.integers(0, 2, 1024)], axis=1)
        env.step(a)
    dt = time.time() - t0
    agent_steps = n * 1024
    print(f"obs_dim={OBS_DIM}  shape ok")
    print(f"{agent_steps/dt:,.0f} agent-steps/sec  ({n/dt:,.0f} env-steps/sec)")
    print(f"total eaten across agents: {env.eaten.sum()}  boundary_hits: {env.boundary_hits.sum()}")
