"""Live browser viewer for the 3v3 WoW arena (eco_arena_env + combat layer).

Runs one ArenaEnv at a fixed tick rate and streams pillar geometry plus every
agent's position, team, role, hp/mana and crowd-control status to a Three.js
canvas over a WebSocket. Three drive modes:

    python3 eco_arena_server.py --hz 12                  # scripted burst+peel (default)
    python3 eco_arena_server.py --hz 12 --mode random    # uncoordinated baseline
    python3 eco_arena_server.py --hz 12 --mode policy \\
        --ckpt experiments/arena_stage3.pt               # trained ArenaPolicy self-play

Then open http://localhost:8000/eco_arena_index.html
"""
import argparse
import asyncio
import functools
import http.server
import json
import threading
import time

import numpy as np

import eco_engine as E
import eco_arena_env as AE

TEAM_COLOR = {"A": "A", "B": "B"}
STATUS_NAME = {E.ST_IDLE: "idle", E.ST_STUNNED: "stunned",
               E.ST_POLYMORPHED: "polymorphed"}


class ArenaSim:
    def __init__(self, mode="scripted", ckpt=None, device="cpu", world=50.0):
        self.mode = mode
        self.world = world
        self.device = device
        self.seed = int(time.time()) & 0xffff
        self.pillar_r = world * 0.07
        self.policy = None
        if mode == "policy":
            import os
            import torch
            from eco_arena_policy import ArenaPolicy
            self._torch = torch
            self.policy = ArenaPolicy().to(device)
            if ckpt and os.path.exists(ckpt):
                self.policy.load_state_dict(torch.load(ckpt, map_location=device))
                print(f"loaded arena policy <- {ckpt}")
            else:
                print(f"WARNING: no checkpoint at {ckpt}; using a random-init "
                      f"ArenaPolicy (train Stage 3 first). Showing untrained play.")
            self.policy.eval()
        self._new_env()
        self.frame_ms = 0.0
        self.speed = 1.0
        self.episode = 0
        self.cooldown_to_reset = 0

    def _new_env(self):
        self.seed = (self.seed + 1) & 0xffff
        self.env = AE.ArenaEnv(world=self.world, seed=self.seed)
        self.eng = self.env.eng
        self._act = np.full((self.eng.capacity(), 2), np.nan, dtype=np.float32)

    # ---- per-agent decision (move offset, spell, target slot, cc, dur, amt) ----
    def _enemy_slot_for_target(self, side, target_idx, foes):
        """target head: 1..3 -> enemy ordinal, else fall back to first foe."""
        order = sorted(foes)
        i = int(target_idx) - 1
        if 0 <= i < len(order):
            return order[i]
        return order[0] if order else None

    def _decide_scripted(self, side, slot, foes, rng):
        eng = self.eng
        enemy_side = self.env.enemies_of(side)
        enemy_healer = self.env.healer(enemy_side)
        role = self.env.roles[side][slot]
        dps_targets = [f for f in foes if f != enemy_healer] or foes
        focus = min(dps_targets, key=lambda s: eng.get_hp(s))
        ax, ay = float(np.asarray(eng.xs())[slot]), float(np.asarray(eng.ys())[slot])
        if role == AE.HEALER and enemy_healer in foes and enemy_healer != focus:
            tgt = enemy_healer
            tx, ty = float(np.asarray(eng.xs())[tgt]), float(np.asarray(eng.ys())[tgt])
            return (-(tx - ax), -(ty - ay)), 2, tgt, AE.CC_POLY, 4.0, 0.0  # kite + CC
        tx, ty = float(np.asarray(eng.xs())[focus]), float(np.asarray(eng.ys())[focus])
        return (tx - ax, ty - ay), 1, focus, 0, 0.0, 14.0                  # close + burst

    def _decide_random(self, side, slot, foes, rng):
        spell = int(rng.integers(1, 3))
        tgt = int(rng.choice(foes))
        ang = rng.uniform(0, 2 * np.pi)
        return (np.cos(ang), np.sin(ang)), spell, tgt, int(rng.integers(0, E.NCC_CAT)), 4.0, 12.0

    def _decide_policy(self, side, slot, foes, row, obs, mask):
        torch = self._torch
        ot = torch.as_tensor(obs[row:row + 1], device=self.device)
        mt = torch.as_tensor(mask[row:row + 1], device=self.device)
        acts, _, _ = self.policy.act(ot, mt)
        move = int(acts["move"].item())
        spell = int(acts["spell"].item())
        tidx = int(acts["target"].item())
        ang = move * (2 * np.pi / E.N_MOVE)
        tgt = self._enemy_slot_for_target(side, tidx, foes)
        cat = slot % E.NCC_CAT
        return (np.cos(ang), np.sin(ang)), spell, tgt, cat, 4.0, 12.0

    def tick(self):
        t0 = time.perf_counter()
        rng = np.random.default_rng((self.eng.step_count() + self.seed) & 0xffffffff)
        if self.env.done():
            self.cooldown_to_reset -= 1
            if self.cooldown_to_reset <= 0:
                self.episode += 1
                self._new_env()
            return self._serialize()

        self.eng.tick_combat()
        self._act[:] = np.nan
        obs = mask = slots = None
        if self.mode == "policy":
            self.eng.build_agent_obs()
            self.eng.build_action_mask()
            obs = np.asarray(self.eng.agent_obs())
            mask = np.asarray(self.eng.action_mask())
            slots = np.asarray(self.eng.agent_slots())

        decisions = []
        for side in ("A", "B"):
            actors = self.env.team_alive(side)
            foes = self.env.team_alive(self.env.enemies_of(side))
            if not actors or not foes:
                continue
            for slot in actors:
                if self.eng.get_status(slot) != E.ST_IDLE:
                    continue
                if self.mode == "policy":
                    row = int(np.where(slots == slot)[0][0])
                    mv, sp, tgt, cat, dur, amt = self._decide_policy(
                        side, slot, foes, row, obs, mask)
                elif self.mode == "random":
                    mv, sp, tgt, cat, dur, amt = self._decide_random(side, slot, foes, rng)
                else:
                    mv, sp, tgt, cat, dur, amt = self._decide_scripted(side, slot, foes, rng)
                # movement offset scaled toward vision so A* plans a real path
                n = float(np.hypot(*mv))
                if n > 1e-6:
                    s = (self.world * 0.5) / n
                    self._act[slot] = (mv[0] * s, mv[1] * s)
                decisions.append((slot, sp, tgt, cat, dur, amt))

        self.eng.step(self._act, True)                 # A* movement around pillars
        for slot, sp, tgt, cat, dur, amt in decisions:  # then resolve casts
            if tgt is None:
                continue
            if sp == 1:
                self.eng.cast_spell(slot, tgt, 1, amount=amt)
            elif sp in (2, 3):
                self.eng.cast_spell(slot, tgt, sp, cc_category=cat, base_duration=dur)

        if self.env.done():
            self.cooldown_to_reset = 24  # hold the final frame ~2s before reset
        out = self._serialize()
        self.frame_ms = (time.perf_counter() - t0) * 1000.0
        out["frame_ms"] = round(self.frame_ms, 2)
        return out

    def _serialize(self):
        eng = self.eng
        xs = np.asarray(eng.xs()); ys = np.asarray(eng.ys())
        agents = []
        for side in ("A", "B"):
            for slot in self.env.team[side]:
                hp = float(eng.get_hp(slot))
                agents.append({
                    "slot": int(slot), "team": side,
                    "role": self.env.roles[side][slot],
                    "x": round(float(xs[slot]), 2), "y": round(float(ys[slot]), 2),
                    "hp": round(hp, 1), "hp_frac": round(max(0.0, hp) / 100.0, 3),
                    "mana": round(float(eng.get_mana(slot)), 1),
                    "status": STATUS_NAME.get(eng.get_status(slot), "idle"),
                    "cc": round(float(eng.get_cc_timer(slot)), 1),
                    "alive": hp > 0.0,
                })
        return {
            "world": self.world,
            "pillars": [{"x": round(cx, 2), "y": round(cy, 2),
                         "r": round(self.pillar_r, 2)} for (cx, cy) in self.env.pillars],
            "agents": agents,
            "aliveA": len(self.env.team_alive("A")),
            "aliveB": len(self.env.team_alive("B")),
            "step": int(eng.step_count()),
            "episode": self.episode,
            "mode": self.mode,
        }


async def _receiver(ws, sim):
    try:
        async for msg in ws:
            try:
                data = json.loads(msg)
            except (ValueError, TypeError):
                continue
            if "speed" in data:
                try:
                    sim.speed = max(0.1, min(8.0, float(data["speed"])))
                except (TypeError, ValueError):
                    pass
    except Exception:
        pass


async def stream(ws, sim, hz):
    next_t = time.perf_counter()
    recv = asyncio.create_task(_receiver(ws, sim))
    try:
        while True:
            await ws.send(json.dumps(sim.tick()))
            next_t += 1.0 / (hz * sim.speed)
            sleep = next_t - time.perf_counter()
            if sleep > 0:
                await asyncio.sleep(sleep)
            else:
                next_t = time.perf_counter()
    except Exception:
        pass
    finally:
        recv.cancel()


def serve_http(port):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"http  viewer  -> http://localhost:{port}/eco_arena_index.html")


async def main():
    import websockets
    ap = argparse.ArgumentParser()
    ap.add_argument("--hz", type=int, default=12)
    ap.add_argument("--mode", choices=["scripted", "random", "policy"],
                    default=None,
                    help="default: 'policy' if the checkpoint exists, else 'scripted'")
    ap.add_argument("--ckpt", default="experiments/arena_stage3.pt")
    ap.add_argument("--world", type=float, default=50.0)
    ap.add_argument("--http-port", type=int, default=8000)
    ap.add_argument("--ws-port", type=int, default=8001)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    import os
    mode = args.mode
    if mode is None:
        mode = "policy" if os.path.exists(args.ckpt) else "scripted"
        print(f"auto-selected mode='{mode}' "
              f"({'checkpoint found' if mode == 'policy' else 'no checkpoint'})")
    sim = ArenaSim(mode=mode, ckpt=args.ckpt, device=args.device,
                   world=args.world)
    serve_http(args.http_port)
    handler = functools.partial(stream, sim=sim, hz=args.hz)
    print(f"ws    stream  -> ws://localhost:{args.ws_port}/  @ {args.hz} Hz "
          f"(mode={mode})")
    async with websockets.serve(handler, "0.0.0.0", args.ws_port):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
