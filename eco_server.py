"""Live viewer for the foxes/rabbits/grass ecosystem (eco_engine).

Runs one live EcoEngine at a fixed tick rate and streams every active entity's
position + type, plus running population counts, to a browser canvas over a
WebSocket. Also serves the static viewer at http://localhost:8000/.

    # structural oscillation, random-walk agents (instant, no training needed):
    python eco_server.py --hz 30

    # use the PRETRAINED shared policies (train once with train_eco.py first):
    python train_eco.py --iters 200          # -> experiments/eco_policies.pt
    python eco_server.py --hz 30 --policy     # loads that checkpoint

Then open http://localhost:8000/eco_index.html
"""
import argparse
import asyncio
import json
import functools
import http.server
import threading
import time

import numpy as np
import websockets

import eco_engine as E
from eco_oscillation import ECO

# compass labels for the 8 discrete actions, matching DIRX/DIRY in eco_engine.cpp
# (index 0 = +x/East, 2 = +y, going counter-clockwise in engine coords)
ACTION_LABELS = ["E →", "NE ↗", "N ↑", "NW ↖", "W ←", "SW ↙", "S ↓", "SE ↘"]
TYPE_NAME = {E.GRASS: "grass", E.RABBIT: "rabbit", E.FOX: "fox"}


def decode_obs(o):
    """Turn a raw AOBS observation vector into the human-readable state the
    policy actually sees: the self-state block + each visible neighbour."""
    world = ECO["world"]
    vision = ECO["vision"]
    self_state = {
        "x_norm": round(float(o[0]), 3),
        "y_norm": round(float(o[1]), 3),
        "energy_norm": round(float(o[2]), 3),
        "is_fox": round(float(o[3]), 1),
    }
    ents = []
    base = E.AOBS - E.MAX_VIS * 6  # SELF_DIM offset (== 4)
    for k in range(E.MAX_VIS):
        e = o[base + k * 6: base + (k + 1) * 6]
        if e[0] < 0.5:
            continue  # inactive / padding slot
        if e[3] > 0.5:
            kind = "rabbit"
        elif e[4] > 0.5:
            kind = "fox"
        else:
            kind = "grass"
        ents.append({
            "kind": kind,
            "rel_dx": round(float(e[1]) * vision, 2),  # back to world units
            "rel_dy": round(float(e[2]) * vision, 2),
            "dist": round(float(np.hypot(e[1], e[2]) * vision), 2),
        })
    ents.sort(key=lambda d: d["dist"])
    return {"self": self_state, "visible": ents, "n_visible": len(ents)}


class Sim:
    def __init__(self, use_policy=False, ckpt="experiments/eco_policies.pt",
                 train_iters=0, device="cpu"):
        self.use_policy = use_policy
        if use_policy:
            # MARLRunner owns its own engine + the two shared policies.
            import os
            import torch
            from eco_marl import MARLRunner
            self.runner = MARLRunner(engine_kwargs=ECO, device=device)
            self.eng = self.runner.eng
            if ckpt and os.path.exists(ckpt):
                self.runner.load(ckpt, map_location=device)
                print(f"loaded pretrained policies <- {ckpt}")
            elif train_iters > 0:
                print(f"no checkpoint at {ckpt}; training {train_iters} iters...")
                for it in range(train_iters):
                    store, _ = self.runner.collect(horizon=64)
                    self.runner.update(store)
                print("  ...done")
            else:
                print(f"WARNING: no checkpoint at {ckpt} and --train-iters 0; "
                      f"policies are random-initialised. Run train_eco.py first.")
            self._act_buf = np.full(self.eng.capacity(), -1, dtype=np.int8)
            self._torch = torch
        else:
            self.eng = E.EcoEngine(use_grid=True, seed=int(time.time()) & 0xffff, **ECO)
        self.frame_ms = 0.0
        self.selected = None        # pool slot the browser asked to inspect

    def tick(self):
        t0 = time.perf_counter()
        if self.use_policy:
            torch = self._torch
            n = self.eng.build_agent_obs()
            self._act_buf[:] = -1
            if n > 0:
                obs = np.asarray(self.eng.agent_obs())
                slots = np.asarray(self.eng.agent_slots())
                types = np.asarray(self.eng.agent_types())
                ot = torch.as_tensor(obs, device=self.runner.device)
                with torch.no_grad():
                    for t in (E.FOX, E.RABBIT):
                        sel = np.where(types == t)[0]
                        if sel.size == 0:
                            continue
                        logits, _ = self.runner.policy[t](ot[sel])
                        act = torch.distributions.Categorical(logits=logits).sample()
                        self._act_buf[slots[sel]] = act.cpu().numpy().astype(np.int8)
            self.eng.step(self._act_buf, True)
        else:
            self.eng.step(_RAND, False)
        state = self.serialize()
        self.frame_ms = (time.perf_counter() - t0) * 1000.0
        state["frame_ms"] = round(self.frame_ms, 2)
        if self.selected is not None:
            state["inspect"] = self.inspect(self.selected)
        return state

    def inspect(self, slot):
        """Full state/action trace for one entity: its raw engine state, the
        observation the policy receives, and (for foxes/rabbits) the policy's
        logits, action-probability distribution, chosen action and value."""
        eng = self.eng
        ty = np.asarray(eng.types())
        if slot < 0 or slot >= len(ty) or ty[slot] == E.EMPTY:
            return {"slot": int(slot), "alive": False}
        t = int(ty[slot])
        info = {
            "slot": int(slot), "alive": True, "type": t,
            "type_name": TYPE_NAME[t],
            "x": round(float(np.asarray(eng.xs())[slot]), 2),
            "y": round(float(np.asarray(eng.ys())[slot]), 2),
            "energy": round(float(np.asarray(eng.energies())[slot]), 3),
        }
        if t == E.GRASS:
            info["note"] = "passive energy node — no observation, no policy"
            return info
        # rabbits/foxes: rebuild this frame's agent observations and locate ours
        eng.build_agent_obs()
        obs = np.asarray(eng.agent_obs())
        slots = np.asarray(eng.agent_slots())
        row = np.where(slots == slot)[0]
        if row.size == 0:
            return info
        o = obs[row[0]]
        info["obs"] = decode_obs(o)
        if self.use_policy:
            torch = self._torch
            ot = torch.as_tensor(o[None], device=self.runner.device)
            with torch.no_grad():
                logits, value = self.runner.policy[t](ot)
                probs = torch.softmax(logits, dim=-1)[0].cpu().numpy()
                logits = logits[0].cpu().numpy()
                value = float(value.squeeze().cpu())
            a = int(np.argmax(probs))
            info["policy"] = {
                "labels": ACTION_LABELS,
                "logits": [round(float(x), 3) for x in logits],
                "probs": [round(float(x), 4) for x in probs],
                "action": a,
                "action_label": ACTION_LABELS[a],
                "value": round(value, 3),
            }
        else:
            info["note"] = "random-walk mode — no policy loaded (run with --policy)"
        return info

    def serialize(self):
        eng = self.eng
        ty = np.asarray(eng.types())
        mask = ty != E.EMPTY
        slots = np.where(mask)[0]
        xs = np.asarray(eng.xs())[mask]
        ys = np.asarray(eng.ys())[mask]
        ty = ty[mask]
        return {
            "world": ECO["world"],
            "x": xs.round(2).tolist(),
            "y": ys.round(2).tolist(),
            "t": ty.tolist(),                       # 1 grass, 2 rabbit, 3 fox
            "slot": slots.tolist(),                 # pool index, for selection
            "foxes": eng.count_foxes(),
            "rabbits": eng.count_rabbits(),
            "grass": eng.count_grass(),
            "step": eng.step_count(),
        }


_RAND = np.full(E.MAX_TOTAL_ENTITIES, -1, dtype=np.int8)


async def _receiver(websocket, sim):
    """Listen for {"select": slot|null} messages from the browser."""
    try:
        async for msg in websocket:
            try:
                data = json.loads(msg)
            except (ValueError, TypeError):
                continue
            if "select" in data:
                sel = data["select"]
                sim.selected = int(sel) if sel is not None else None
    except websockets.ConnectionClosed:
        pass


async def stream(websocket, sim, hz):
    dt = 1.0 / hz
    next_t = time.perf_counter()
    recv_task = asyncio.create_task(_receiver(websocket, sim))
    try:
        while True:
            await websocket.send(json.dumps(sim.tick()))
            next_t += dt
            sleep = next_t - time.perf_counter()
            if sleep > 0:
                await asyncio.sleep(sleep)
            else:
                next_t = time.perf_counter()
    except websockets.ConnectionClosed:
        pass
    finally:
        recv_task.cancel()


def serve_http(port):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"http  viewer  -> http://localhost:{port}/eco_index.html")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hz", type=int, default=30)
    ap.add_argument("--policy", action="store_true",
                    help="use trained shared policies instead of random walk")
    ap.add_argument("--ckpt", default="experiments/eco_policies.pt",
                    help="pretrained policy checkpoint to load in --policy mode")
    ap.add_argument("--train-iters", type=int, default=0,
                    help="if no checkpoint exists, train this many iters in-process")
    ap.add_argument("--http-port", type=int, default=8000)
    ap.add_argument("--ws-port", type=int, default=8001)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    sim = Sim(use_policy=args.policy, ckpt=args.ckpt,
              train_iters=args.train_iters, device=args.device)
    serve_http(args.http_port)
    handler = functools.partial(stream, sim=sim, hz=args.hz)
    print(f"ws    stream  -> ws://localhost:{args.ws_port}/  @ {args.hz} Hz "
          f"({'trained policies' if args.policy else 'random walk'})")
    async with websockets.serve(handler, "0.0.0.0", args.ws_port):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
