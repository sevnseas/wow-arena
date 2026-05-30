"""Task 3: shared-policy MARL integration over the eco_engine.

Two independent weight spaces -- Fox_Policy and Rabbit_Policy -- each a
permutation-invariant EcoPolicy (Task 2). Every living fox runs theta_fox;
every living rabbit runs theta_rabbit. The C++ engine emits a variable-length
batch of (obs, slot, type) every frame; this runner:

  1. groups obs by type and queries the matching policy,
  2. scatters sampled actions back into a per-slot action buffer, asserting that
     a slot is only ever written by the policy for its own type
     (the spec's cross-contamination guardrail), and
  3. runs a compact PPO update that backprops into BOTH policy heads.

Per-agent reward (minimal; Task 4 tunes the real ecology):
    fox    : +energy gained this step (eating rabbits), -metabolism, -1 on death
    rabbit : +energy gained (eating grass), + small survival, -1 on death, +0.5 split
"""
import numpy as np
import torch
from torch import nn

import eco_engine as E
from eco_policy import EcoPolicy, OBS_DIM

assert E.AOBS == OBS_DIM, f"engine AOBS {E.AOBS} != policy OBS_DIM {OBS_DIM}"

GAMMA = 0.95


class MARLRunner:
    def __init__(self, engine_kwargs=None, device="cpu", lr=3e-4):
        ek = dict(world=60.0, cell_size=8.0, vision=12.0, eat_radius=1.5,
                  move_speed=1.0, rabbit_metab=0.02, fox_metab=0.25,
                  rabbit_move_cost=0.0, grass_energy=3.0, rabbit_energy_to_fox=14.0,
                  repro_threshold=18.0, init_energy=10.0,
                  n_rabbits0=120, n_foxes0=30, n_grass0=200, grass_max=300,
                  grass_spawn_rate=8.0, seed=0)
        if engine_kwargs:
            ek.update(engine_kwargs)
        self.eng = E.EcoEngine(**ek)
        self.device = device
        self.fox = EcoPolicy().to(device)
        self.rab = EcoPolicy().to(device)
        self.opt = {
            E.FOX: torch.optim.Adam(self.fox.parameters(), lr=lr),
            E.RABBIT: torch.optim.Adam(self.rab.parameters(), lr=lr),
        }
        self.policy = {E.FOX: self.fox, E.RABBIT: self.rab}
        self._action_buf = np.full(self.eng.capacity(), -1, dtype=np.int8)
        # prev energy per slot, to derive per-agent reward from energy deltas
        self._prev_e = np.zeros(self.eng.capacity(), dtype=np.float32)

    def _route_actions(self, slots, types, obs):
        """Run each species' policy on its own agents, scatter into action buf.
        Returns dict[type] -> (slots, actions, logp, value) for the PPO update."""
        self._action_buf[:] = -1
        out = {}
        obs_t = torch.as_tensor(obs, device=self.device)
        for t in (E.FOX, E.RABBIT):
            sel = np.where(types == t)[0]
            if sel.size == 0:
                continue
            o = obs_t[sel]
            logits, value = self.policy[t](o)
            dist = torch.distributions.Categorical(logits=logits)
            act = dist.sample()
            logp = dist.log_prob(act)
            a_np = act.detach().cpu().numpy().astype(np.int8)
            s_np = slots[sel]
            # ---- cross-contamination guardrail ----
            # every slot we are about to write MUST currently be this type.
            cur = np.asarray(self.eng.types())[s_np]
            assert np.all(cur == t), \
                f"policy {t} tried to act on slots of type {cur[cur!=t][:5]}"
            self._action_buf[s_np] = a_np
            out[t] = (s_np, act, logp, value.squeeze(-1))
        return out

    def collect(self, horizon=64):
        """Roll out `horizon` frames, returning per-species transition batches."""
        store = {E.FOX: [], E.RABBIT: []}
        counts = []
        for _ in range(horizon):
            n = self.eng.build_agent_obs()
            if n == 0:
                break
            obs = np.array(self.eng.agent_obs(), copy=True)
            slots = np.array(self.eng.agent_slots(), copy=True)
            types = np.array(self.eng.agent_types(), copy=True)
            # snapshot energy for reward
            e_before = np.asarray(self.eng.energies()).copy()
            self._prev_e[slots] = e_before[slots]

            routed = self._route_actions(slots, types, obs)
            self.eng.step(self._action_buf, True)
            counts.append((self.eng.count_foxes(), self.eng.count_rabbits()))

            types_after = np.asarray(self.eng.types())
            e_after = np.asarray(self.eng.energies())
            for t, (s_np, act, logp, value) in routed.items():
                alive = types_after[s_np] == t
                rew = np.where(
                    alive, e_after[s_np] - self._prev_e[s_np], -1.0
                ).astype(np.float32)
                if t == E.RABBIT:
                    rew += np.where(alive, 0.01, 0.0)   # survival bonus
                store[t].append((act, logp, value, torch.as_tensor(rew, device=self.device),
                                 torch.as_tensor(alive, device=self.device)))
        return store, counts

    def update(self, store):
        """Compact PPO-style (actor-critic) update for both species."""
        stats = {}
        for t in (E.FOX, E.RABBIT):
            traj = store[t]
            if not traj:
                continue
            acts = torch.cat([x[0] for x in traj])
            logps = torch.cat([x[1] for x in traj])
            values = torch.cat([x[2] for x in traj])
            rews = torch.cat([x[3] for x in traj])
            # per-transition return (no cross-step bootstrap: agents are
            # short-lived and identity-shifting -> treat reward + gamma*value)
            with torch.no_grad():
                returns = rews + GAMMA * values.detach()
            adv = (returns - values).detach()
            adv = (adv - adv.mean()) / (adv.std() + 1e-8)
            actor_loss = -(logps * adv).mean()
            critic_loss = 0.5 * (returns - values).pow(2).mean()
            loss = actor_loss + critic_loss
            self.opt[t].zero_grad()
            loss.backward()
            gnorm = nn.utils.clip_grad_norm_(self.policy[t].parameters(), 5.0)
            self.opt[t].step()
            stats[t] = dict(loss=float(loss.detach()), grad=float(gnorm), n=len(acts))
        return stats


    def save(self, path):
        torch.save({"fox": self.fox.state_dict(),
                    "rabbit": self.rab.state_dict()}, path)

    def load(self, path, map_location=None):
        ckpt = torch.load(path, map_location=map_location or self.device)
        self.fox.load_state_dict(ckpt["fox"])
        self.rab.load_state_dict(ckpt["rabbit"])
        return self


if __name__ == "__main__":
    r = MARLRunner()
    for it in range(20):
        store, counts = r.collect(horizon=64)
        stats = r.update(store)
        f, rb = counts[-1] if counts else (0, 0)
        msg = " ".join(f"{'FOX' if k==E.FOX else 'RAB'}:loss={v['loss']:+.3f}"
                        f"/g={v['grad']:.2f}/n={v['n']}" for k, v in stats.items())
        print(f"iter {it:2d}  foxes={f:3d} rabbits={rb:3d}  {msg}")
