"""Task 4 Stage-3 adversarial self-play trainer for the 3v3 arena.

A single shared ArenaPolicy controls every agent on both teams (self-play). Each
step, all living agents across a batch of parallel ArenaEnvs are fed through the
policy in one GPU batch; the C++ action mask gates the move/spell/target heads so
a CC'd or dead agent can never act. Rewards: damage dealt to enemies (+), damage
taken (-), kill participation (+), and a terminal win/loss bonus. Advantage =
discounted return - critic baseline, PPO-clipped update.

    python3 eco_arena_selfplay.py --minutes 15 --device cuda \\
        --out experiments/arena_stage3.pt

This is the training that pushes coordinated CC-chain success past the random
baseline; evaluate it with eco_arena_env.run_episode or watch it in the viewer
(eco_arena_server.py --mode policy).
"""
import argparse
import time
import numpy as np
import torch

import eco_engine as E
import eco_arena_env as AE
from eco_arena_policy import ArenaPolicy, HEADS

GAMMA = 0.99
PPO_CLIP = 0.2
ENTROPY_COEF = 0.01
VALUE_COEF = 0.5


def _target_slot(env, side, target_head, foes_sorted, allies_sorted):
    """Map the 6-way target head to a concrete slot.
    0 = self/current (-> first enemy), 1..3 = enemies, 4..5 = allies."""
    i = int(target_head)
    if i == 0:
        return foes_sorted[0] if foes_sorted else None
    if 1 <= i <= 3:
        j = i - 1
        return foes_sorted[j] if j < len(foes_sorted) else (
            foes_sorted[-1] if foes_sorted else None)
    j = i - 4
    return allies_sorted[j] if j < len(allies_sorted) else None


class SelfPlay:
    def __init__(self, n_envs=48, world=44.0, device="cpu", lr=3e-4):
        self.device = device
        self.n_envs = n_envs
        self.world = world
        self.policy = ArenaPolicy().to(device)
        self.opt = torch.optim.Adam(self.policy.parameters(), lr=lr)
        self.move_speed_scale = world * 0.5

    def _reset_envs(self, seed0):
        self.envs = [AE.ArenaEnv(world=self.world, seed=seed0 + i)
                     for i in range(self.n_envs)]

    def _gather(self):
        """Collect (env, slot, obs, mask, side, foes, allies) for every living,
        actionable agent across all envs. Returns lists + a stacked obs/mask."""
        rows = []
        obs_list, mask_list = [], []
        for ei, env in enumerate(self.envs):
            if env.done():
                continue
            eng = env.eng
            eng.build_agent_obs()
            eng.build_action_mask()
            slots = np.asarray(eng.agent_slots())
            obs = np.asarray(eng.agent_obs())
            mask = np.asarray(eng.action_mask())
            for side in ("A", "B"):
                foes = sorted(env.team_alive(env.enemies_of(side)))
                for slot in env.team_alive(side):
                    if eng.get_status(slot) != E.ST_IDLE:
                        continue
                    r = np.where(slots == slot)[0]
                    if r.size == 0:
                        continue
                    allies = sorted(s for s in env.team_alive(side) if s != slot)
                    rows.append((ei, slot, side, foes, allies))
                    obs_list.append(obs[r[0]])
                    mask_list.append(mask[r[0]])
        if not rows:
            return rows, None, None
        return rows, np.array(obs_list, dtype=np.float32), \
            np.array(mask_list, dtype=np.float32)

    def collect(self, horizon=40, seed0=0):
        self._reset_envs(seed0)
        # per (env,slot) transition streams
        streams = {}      # key -> list of (idx, reward)
        flat_obs, flat_mask = [], []
        flat_act = {name: [] for name, _ in HEADS}
        flat_val, flat_logp = [], []
        for env in self.envs:
            env.eng.tick_combat()
        for _ in range(horizon):
            rows, obs, mask = self._gather()
            if not rows:
                break
            ot = torch.as_tensor(obs, device=self.device)
            mt = torch.as_tensor(mask, device=self.device)
            with torch.no_grad():
                acts, logps, value = self.policy.act(ot, mt)
            acts_np = {n: acts[n].cpu().numpy() for n, _ in HEADS}
            logp_np = sum(logps[n].cpu().numpy() for n, _ in HEADS)
            val_np = value.cpu().numpy()
            # apply movement, then resolve casts, collecting per-agent reward
            move_bufs = {ei: np.full((self.envs[ei].eng.capacity(), 2), np.nan,
                                     dtype=np.float32) for ei in {r[0] for r in rows}}
            pending = []      # (key, idx, env, slot, side, target, spell, hp_self_before)
            for k, (ei, slot, side, foes, allies) in enumerate(rows):
                env = self.envs[ei]
                mv = int(acts_np["move"][k])
                ang = mv * (2 * np.pi / E.N_MOVE)
                move_bufs[ei][slot] = (np.cos(ang) * self.move_speed_scale,
                                       np.sin(ang) * self.move_speed_scale)
                tgt = _target_slot(env, side, acts_np["target"][k], foes, allies)
                idx = len(flat_obs)
                flat_obs.append(obs[k]); flat_mask.append(mask[k])
                for n, _ in HEADS:
                    flat_act[n].append(int(acts_np[n][k]))
                flat_val.append(float(val_np[k])); flat_logp.append(float(logp_np[k]))
                key = (ei, slot)
                streams.setdefault(key, [])
                pending.append((key, idx, ei, slot, side, tgt,
                                int(acts_np["spell"][k]),
                                env.eng.get_hp(slot)))
            for ei, buf in move_bufs.items():
                self.envs[ei].eng.step(buf, True)
            # resolve casts + compute rewards
            for (key, idx, ei, slot, side, tgt, spell, hp_before) in pending:
                eng = self.envs[ei].eng
                reward = 0.0
                if tgt is not None and spell == 1:
                    if eng.cast_spell(slot, tgt, 1, amount=12.0):
                        reward += 1.2
                        if eng.get_hp(tgt) <= 0.0:
                            reward += 5.0       # kill participation
                elif tgt is not None and spell == 2:
                    if eng.cast_spell(slot, tgt, 2, cc_category=slot % E.NCC_CAT,
                                      base_duration=4.0):
                        reward += 0.3          # small shaping for landing CC
                hp_after = eng.get_hp(slot)
                reward -= 0.05 * max(0.0, hp_before - hp_after)
                streams[key].append((idx, reward))
            for env in self.envs:
                if not env.done():
                    env.eng.tick_combat()
        # terminal win/loss bonus
        for (ei, slot), seq in streams.items():
            if not seq:
                continue
            env = self.envs[ei]
            side = "A" if slot in env.team["A"] else "B"
            won = len(env.team_alive(env.enemies_of(side))) == 0
            lost = len(env.team_alive(side)) == 0
            bonus = 8.0 if won else (-8.0 if lost else 0.0)
            idx, r = seq[-1]
            seq[-1] = (idx, r + bonus)
        return streams, flat_obs, flat_mask, flat_act, flat_val, flat_logp

    def update(self, streams, flat_obs, flat_mask, flat_act, flat_val, flat_logp,
               epochs=3):
        N = len(flat_obs)
        if N < 8:
            return 0.0, 0.0
        ret = np.zeros(N, dtype=np.float32)
        for seq in streams.values():
            acc = 0.0
            for idx, r in reversed(seq):
                acc = r + GAMMA * acc
                ret[idx] = acc
        val = np.array(flat_val, dtype=np.float32)
        adv = ret - val
        adv = (adv - adv.mean()) / (adv.std() + 1e-6)
        obs = torch.as_tensor(np.array(flat_obs, dtype=np.float32), device=self.device)
        mask = torch.as_tensor(np.array(flat_mask, dtype=np.float32), device=self.device)
        acts = {n: torch.as_tensor(np.array(flat_act[n]), device=self.device)
                for n, _ in HEADS}
        advt = torch.as_tensor(adv, device=self.device)
        rett = torch.as_tensor(ret, device=self.device)
        old_logp = torch.as_tensor(np.array(flat_logp, dtype=np.float32),
                                   device=self.device)
        last_pg = last_v = 0.0
        for _ in range(epochs):
            logp, entropy, value = self.policy.evaluate(obs, mask, acts)
            ratio = torch.exp(logp - old_logp)
            pg = -torch.min(ratio * advt,
                            torch.clamp(ratio, 1 - PPO_CLIP, 1 + PPO_CLIP) * advt).mean()
            vloss = ((value - rett) ** 2).mean()
            loss = pg + VALUE_COEF * vloss - ENTROPY_COEF * entropy.mean()
            self.opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(self.policy.parameters(), 0.5)
            self.opt.step()
            last_pg, last_v = float(pg.item()), float(vloss.item())
        return last_pg, last_v


def evaluate_cc_chain(policy, device, episodes=12, seed0=1000):
    """Measure the trained policy's coordinated CC-chain success via the env
    metric, both teams driven by the policy."""
    from eco_arena_policy import HEADS as _H

    def policy_tactic(env, side, slot, foes, rng):
        eng = env.eng
        eng.build_agent_obs(); eng.build_action_mask()
        slots = np.asarray(eng.agent_slots())
        r = np.where(slots == slot)[0]
        if r.size == 0:
            return 1, foes[0], 0, 0.0, 12.0
        obs = np.asarray(eng.agent_obs())[r[0]:r[0] + 1]
        mask = np.asarray(eng.action_mask())[r[0]:r[0] + 1]
        with torch.no_grad():
            acts, _, _ = policy.act(torch.as_tensor(obs, device=device),
                                    torch.as_tensor(mask, device=device))
        foes_sorted = sorted(foes)
        tgt = _target_slot(env, side, int(acts["target"].item()), foes_sorted, [])
        spell = int(acts["spell"].item())
        if spell not in (1, 2) or tgt is None:
            spell, tgt = 1, foes_sorted[0]
        return spell, tgt, slot % E.NCC_CAT, 4.0, 12.0

    scores = []
    rng = np.random.default_rng(seed0)
    for ep in range(episodes):
        env = AE.ArenaEnv(seed=seed0 + ep)
        scores.append(AE.run_episode(env, policy_tactic, policy_tactic, rng=rng))
    return float(np.mean(scores))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=15.0)
    ap.add_argument("--n-envs", type=int, default=48)
    ap.add_argument("--horizon", type=int, default=40)
    ap.add_argument("--world", type=float, default=44.0)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--out", default="experiments/arena_stage3.pt")
    args = ap.parse_args()

    torch.manual_seed(0); np.random.seed(0)
    sp = SelfPlay(n_envs=args.n_envs, world=args.world, device=args.device,
                  lr=args.lr)
    print(f"self-play 3v3 on {args.device}: {args.n_envs} envs x {args.horizon} "
          f"horizon, budget {args.minutes:.1f} min")
    start = time.time(); it = 0
    best = -1.0
    while time.time() - start < args.minutes * 60:
        data = sp.collect(horizon=args.horizon, seed0=it * args.n_envs)
        pg, v = sp.update(*data)
        it += 1
        if it % 10 == 0 or time.time() - start >= args.minutes * 60:
            elapsed = time.time() - start
            cc = evaluate_cc_chain(sp.policy, args.device, episodes=8)
            n = len(data[1])
            print(f"  it {it:4d}  {elapsed/60:4.1f}min  samples/iter={n:5d}  "
                  f"pg={pg:+.3f} v={v:6.2f}  CC-chain={cc*100:5.1f}%")
            if cc >= best:
                best = cc
                torch.save(sp.policy.state_dict(), args.out)
    import os
    os.makedirs("experiments", exist_ok=True)
    torch.save(sp.policy.state_dict(), args.out)
    final_cc = evaluate_cc_chain(sp.policy, args.device, episodes=20)
    print(f"\nDONE {it} iters in {(time.time()-start)/60:.1f} min. "
          f"final CC-chain={final_cc*100:.1f}% (best {best*100:.1f}%) -> {args.out}")


if __name__ == "__main__":
    main()
