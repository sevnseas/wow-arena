"""Task 1 acceptance harness for eco_engine.

Checks:
  1. Grid correctness: spatial-grid step produces *identical* dynamics to the
     brute-force O(N^2) step (same seed) -> the grid never misses/adds a prey.
  2. Mechanics + zero slot leaks under birth/death churn; graceful cap.
  3. Throughput @ ~500 active entities, spatial-grid vs naive O(N^2) -> speedup.
  4. RSS memory drift ~0% over 5M steps of aggressive birth/death churn.
"""
import time, resource
import numpy as np
import eco_engine as E

RAND = np.full(E.MAX_TOTAL_ENTITIES, -1, dtype=np.int8)


def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


# Constant ~500-entity config: repro disabled (huge threshold) and no metabolic
# starvation, so rabbit/fox counts stay fixed while grass is eaten + respawns.
# This isolates the per-step movement + grid + interaction cost for a fair,
# reproducible benchmark and an apples-to-apples grid-vs-naive comparison.
BENCH = dict(world=100.0, cell_size=8.0, eat_radius=1.5, move_speed=1.0,
             rabbit_metab=0.0, fox_metab=0.0, rabbit_move_cost=0.0,
             repro_threshold=1e9, init_energy=1e9,
             grass_energy=1.0, rabbit_energy_to_fox=1.0,
             n_rabbits0=260, n_foxes0=40, n_grass0=200, grass_max=200,
             grass_spawn_rate=6.0, seed=7)

# Churny config for mechanics/memory: real births, deaths, predation.
CHURN = dict(world=100.0, cell_size=8.0, eat_radius=1.5, move_speed=1.0,
             rabbit_metab=0.02, fox_metab=0.25, rabbit_move_cost=0.0,
             grass_energy=3.0, rabbit_energy_to_fox=14.0, repro_threshold=18.0,
             init_energy=10.0, n_rabbits0=200, n_foxes0=40, n_grass0=300,
             grass_max=400, grass_spawn_rate=8.0, seed=3)


def test_grid_correctness():
    g = E.EcoEngine(use_grid=True, **CHURN)
    n = E.EcoEngine(use_grid=False, **CHURN)
    for t in range(1500):
        g.step(RAND, False)
        n.step(RAND, False)
        assert (g.count_rabbits(), g.count_foxes(), g.count_grass()) == \
               (n.count_rabbits(), n.count_foxes(), n.count_grass()), \
               f"grid/naive diverged at step {t}"
    # positions identical too (grid must not perturb dynamics)
    assert np.allclose(np.asarray(g.xs()), np.asarray(n.xs()))
    print(f"  [OK] grid step == naive step for 1500 steps "
          f"(R={g.count_rabbits()} F={g.count_foxes()} G={g.count_grass()})")


def test_mechanics():
    eng = E.EcoEngine(use_grid=True, **CHURN)
    saw_birth = saw_death = False
    prev = eng.active_count()
    for _ in range(3000):
        eng.step(RAND, False)
        c = eng.active_count()
        assert c <= eng.capacity(), "pool overflow!"
        assert eng.free_slots() + c == eng.capacity(), "leaked slot!"
        if c > prev: saw_birth = True
        if c < prev: saw_death = True
        prev = c
    assert saw_birth and saw_death
    print(f"  [OK] births+deaths cycle, slot accounting exact "
          f"(active={eng.active_count()})")


def test_capacity_graceful():
    eng = E.EcoEngine(use_grid=True, world=30.0, n_grass0=900, grass_max=1024,
                      grass_spawn_rate=50.0, n_rabbits0=50, n_foxes0=10,
                      cell_size=8.0)
    for _ in range(800):
        eng.step(RAND, False)
        assert eng.active_count() <= eng.capacity()
        assert eng.free_slots() >= 0
    print(f"  [OK] cap respected under spawn pressure (active={eng.active_count()})")


def bench(use_grid, warm=200, n=100_000):
    eng = E.EcoEngine(use_grid=use_grid, **BENCH)
    for _ in range(warm): eng.step(RAND, False)
    act = eng.active_count()
    t0 = time.perf_counter()
    for _ in range(n): eng.step(RAND, False)
    dt = time.perf_counter() - t0
    return n / dt, act


def test_throughput():
    sps_g, act = bench(True)
    sps_n, _ = bench(False)
    print(f"  throughput @ ~{act} active entities:")
    print(f"    spatial grid : {sps_g/1e6:6.2f}M steps/s")
    print(f"    naive O(N^2) : {sps_n/1e6:6.2f}M steps/s")
    print(f"    speedup      : {sps_g/sps_n:6.2f}x")
    return sps_g, sps_n, act


def test_memory_drift(total=5_000_000, chunk=250_000):
    eng = E.EcoEngine(use_grid=True, **CHURN)
    for _ in range(2000): eng.step(RAND, False)   # reach steady churn
    base = rss_mb(); done = 0
    while done < total:
        for _ in range(chunk): eng.step(RAND, False)
        done += chunk
    drift = (rss_mb() - base) / base * 100.0
    print(f"  memory: base={base:.1f}MB -> {rss_mb():.1f}MB  drift={drift:.3f}% "
          f"over {done:,} steps")
    return drift


if __name__ == "__main__":
    print("Task 1 acceptance:")
    test_grid_correctness()
    test_mechanics()
    test_capacity_graceful()
    sps_g, sps_n, act = test_throughput()
    drift = test_memory_drift()
    print(f"\nRESULT: grid-correctness PASS | "
          f"speedup {sps_g/sps_n:.1f}x | "
          f"mem-drift {'PASS' if abs(drift) < 1.0 else 'FAIL'} ({drift:.2f}%)")
