"""Task 5: Real-time playback server.

Hosts one live C++ engine instance (num_agents=1: a single wolf hunting
rabbits), runs the trained MaskedPolicy at a fixed tick rate, and streams the
serialized entity state to web clients over a WebSocket. Also serves the static
viewer at http://localhost:8000/.

    python server.py --model experiments/wolf_curriculum.pt --hz 30 --map-half 1.5

Then open http://localhost:8000/ in a browser.

Per-frame budget target: model inference + C++ step + JSON serialize <= 5 ms.
The server prints a rolling frame-time so you can watch the guardrail.
"""
import argparse
import asyncio
import json
import functools
import http.server
import threading
import time

import numpy as np
import torch
import websockets

from wolf_rabbit_cpp import WolfRabbitCpp, MaskedPolicy, SIM_OBS, N_DIRS


class Sim:
    def __init__(self, model, map_half, n_rabbits, device):
        self.device = device
        self.map_half = map_half
        self.env = WolfRabbitCpp(num_agents=1, map_half=map_half,
                                 n_rabbits=n_rabbits, max_steps=10_000_000)
        self.policy = MaskedPolicy(self.env, 128).to(device)
        self.policy.load_state_dict(torch.load(model, map_location=device))
        self.policy.eval()
        self.obs, _ = self.env.reset(seed=int(time.time()) & 0xffff)
        self.frame_ms = 0.0
        for _ in range(3):  # warm up CUDA / cuDNN so frame 1 is in budget
            self.tick()
        self.obs, _ = self.env.reset(seed=int(time.time()) & 0xffff)

    def tick(self):
        t0 = time.perf_counter()
        with torch.no_grad():
            o = torch.as_tensor(self.obs).to(self.device).float()
            logits, _ = self.policy.forward_eval(o, None)
            a = torch.stack([l.argmax(-1) for l in logits], 1).cpu().numpy()
        self.obs, r, term, trunc, info = self.env.step(a)
        state = self.serialize()
        self.frame_ms = (time.perf_counter() - t0) * 1000.0
        return state

    def serialize(self):
        """Pack current entity positions into a compact JSON-able dict."""
        eng = self.env.eng
        # reconstruct absolute positions from obs (wolf abs + rabbit relatives)
        obs = self.obs[0]
        H = self.map_half
        wolf = [float(obs[0] * H), float(obs[1] * H)]
        rabbits = []
        for j in range(SIM_OBS // 3):  # 8 slots
            base = 2 + 3 * j
            active = obs[base] > 0.5
            if active:
                rx = wolf[0] + float(obs[base + 1]) * 2 * H
                ry = wolf[1] + float(obs[base + 2]) * 2 * H
                rabbits.append([rx, ry])
        return {
            'h': H,
            'wolf': wolf,
            'rabbits': rabbits,
            'eaten': int(eng.eaten()[0]),
            'frame_ms': round(self.frame_ms, 3),
        }


async def stream(websocket, sim, hz):
    dt = 1.0 / hz
    next_t = time.perf_counter()
    try:
        while True:
            state = sim.tick()
            await websocket.send(json.dumps(state))
            next_t += dt
            sleep = next_t - time.perf_counter()
            if sleep > 0:
                await asyncio.sleep(sleep)
            else:
                next_t = time.perf_counter()  # fell behind; resync
    except websockets.ConnectionClosed:
        pass


def serve_http(port):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler)
    httpd = http.server.ThreadingHTTPServer(('0.0.0.0', port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"http  viewer  -> http://localhost:{port}/")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='experiments/wolf_curriculum.pt')
    ap.add_argument('--hz', type=int, default=30)
    ap.add_argument('--map-half', type=float, default=1.5)
    ap.add_argument('--n-rabbits', type=int, default=3)
    ap.add_argument('--http-port', type=int, default=8000)
    ap.add_argument('--ws-port', type=int, default=8001)
    ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    args = ap.parse_args()

    sim = Sim(args.model, args.map_half, args.n_rabbits, args.device)
    serve_http(args.http_port)
    handler = functools.partial(stream, sim=sim, hz=args.hz)
    print(f"ws    stream  -> ws://localhost:{args.ws_port}/  @ {args.hz} Hz")
    async with websockets.serve(handler, '0.0.0.0', args.ws_port):
        await asyncio.Future()  # run forever


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
