"""Train the shared Fox/Rabbit policies once and save a checkpoint the viewer
(and anything else) can load. Trains on the tuned ECO config so the engine's
refuge guardrail keeps both species alive while the policies learn to hunt/forage.

    python train_eco.py --iters 400 --out experiments/eco_policies.pt
"""
import argparse
import time
import numpy as np
import torch

import eco_engine as E
from eco_marl import MARLRunner
from eco_oscillation import ECO


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=400)
    ap.add_argument("--horizon", type=int, default=64)
    ap.add_argument("--out", default="experiments/eco_policies.pt")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    r = MARLRunner(engine_kwargs=ECO, device=args.device)
    t0 = time.time()
    for it in range(1, args.iters + 1):
        store, counts = r.collect(horizon=args.horizon)
        stats = r.update(store)
        if it % 20 == 0 or it == 1:
            f, rb = counts[-1] if counts else (0, 0)
            fl = stats.get(E.FOX, {}).get("loss", float("nan"))
            rl = stats.get(E.RABBIT, {}).get("loss", float("nan"))
            print(f"iter {it:4d}  foxes={f:4d} rabbits={rb:4d}  "
                  f"fox_loss={fl:+.3f} rab_loss={rl:+.3f}  "
                  f"({(time.time()-t0):.0f}s)")
    r.save(args.out)
    print(f"\nsaved checkpoint -> {args.out}")


if __name__ == "__main__":
    main()
