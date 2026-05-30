"""Task 4: macro ecological validation -- sustained Lotka-Volterra oscillations.

Runs the tuned ecosystem for a long horizon and checks the spec's acceptance:
  * continuous autonomous oscillations for >= 100,000 frames,
  * the system NEVER hits a 0-population dead state (mechanical refuge guardrail),
  * classic predator-prey phase structure: foxes LAG rabbits (rabbits peak ->
    foxes peak -> rabbits crash -> foxes starve -> rabbits recover).

Oscillation is driven structurally by density-dependent predation + finite grass,
and kept off the extinction floor by two mechanical guardrails the spec asks for:
a hard fox vision radius (spatial refuge) and a small protected source population.
Trained policies (Tasks 2-3) sharpen hunting but the oscillation does not depend
on them, which is exactly why it is robust to "predator hyper-efficiency".
"""
import numpy as np
import eco_engine as E

RAND = np.full(E.MAX_TOTAL_ENTITIES, -1, dtype=np.int8)

# Tuned, validated config "E": large-amplitude oscillation, never extinct.
ECO = dict(
    world=60.0, cell_size=8.0, vision=12.0, eat_radius=1.5, move_speed=1.0,
    rabbit_metab=0.05, fox_metab=0.20, rabbit_move_cost=0.0,
    grass_energy=4.0, rabbit_energy_to_fox=11.0, repro_threshold=18.0,
    init_energy=8.0, n_rabbits0=150, n_foxes0=40, n_grass0=150,
    grass_max=220, grass_spawn_rate=2.2, max_age=0.0,
    refuge_rabbits=15, refuge_foxes=6,        # spatial-refuge source population
)


def simulate(steps, sample=50, seed=5):
    eng = E.EcoEngine(use_grid=True, seed=seed, **ECO)
    F, R, G = [], [], []
    min_f = min_r = 10 ** 9
    for t in range(steps):
        eng.step(RAND, False)
        f, r = eng.count_foxes(), eng.count_rabbits()
        min_f = min(min_f, f); min_r = min(min_r, r)
        if t % sample == 0:
            F.append(f); R.append(r); G.append(eng.count_grass())
    return np.array(F), np.array(R), np.array(G), min_f, min_r


def count_peaks(x, prom_frac=0.15):
    """Local maxima with a prominence filter -> number of oscillation crests."""
    x = x.astype(float)
    # smooth
    k = 9
    s = np.convolve(x, np.ones(k) / k, mode="same")
    thr = s.mean() + prom_frac * (s.max() - s.mean())
    peaks = []
    for i in range(2, len(s) - 2):
        if s[i] > thr and s[i] >= s[i - 1] and s[i] > s[i + 1]:
            if not peaks or i - peaks[-1] > 5:
                peaks.append(i)
    return peaks


def phase_lag(R, F, max_lag=60):
    """Cross-correlation lag (in samples) maximising corr(R[t], F[t+lag]).
    Positive => foxes lag rabbits, the Lotka-Volterra signature."""
    R = (R - R.mean()) / (R.std() + 1e-9)
    F = (F - F.mean()) / (F.std() + 1e-9)
    best, blag = -2, 0
    for lag in range(0, max_lag):
        c = np.mean(R[:len(R) - lag] * F[lag:])
        if c > best:
            best, blag = c, lag
    return blag, best


def sparkline(x, width=90, rows=9):
    x = x.astype(float)
    idx = np.linspace(0, len(x) - 1, width).astype(int)
    x = x[idx]
    lo, hi = x.min(), x.max()
    grid = [[" "] * width for _ in range(rows)]
    for c, v in enumerate(x):
        r = int((v - lo) / (hi - lo + 1e-9) * (rows - 1))
        grid[rows - 1 - r][c] = "█"
    return "\n".join("".join(row) for row in grid)


def main(steps=200_000):
    print(f"Task 4 acceptance: simulating {steps:,} frames...")
    F, R, G, min_f, min_r = simulate(steps)
    fp, rp = count_peaks(F), count_peaks(R)
    lag, corr = phase_lag(R, F)
    never_extinct = (min_f > 0 and min_r > 0)
    horizon = steps if never_extinct else 0

    print(f"\n  rabbits  min/mean/max = {R.min():4d}/{R.mean():6.1f}/{R.max():4d}")
    print(f"  foxes    min/mean/max = {min_f:4d}/{F.mean():6.1f}/{F.max():4d}")
    print(f"  grass    min/mean/max = {G.min():4d}/{G.mean():6.1f}/{G.max():4d}")
    print(f"  oscillation crests: rabbits={len(rp)}  foxes={len(fp)}")
    print(f"  predator phase lag  : {lag} samples  (corr={corr:.2f}, "
          f"positive => foxes lag rabbits = Lotka-Volterra)")
    print(f"  survival horizon    : {horizon:,} frames  (never 0-population: "
          f"{never_extinct})")

    print("\n  rabbits (R) population over time:")
    print(sparkline(R))
    print("\n  foxes (F) population over time:")
    print(sparkline(F))

    ok = (never_extinct and horizon >= 100_000 and len(rp) >= 3
          and len(fp) >= 3 and lag > 0)
    print(f"\nRESULT: {'PASS' if ok else 'FAIL'} -- "
          f"{'continuous Lotka-Volterra oscillations >=100k frames, no extinction'
             if ok else 'criteria not met'}")
    return ok


if __name__ == "__main__":
    main()
