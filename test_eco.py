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

RAND = np.full((E.MAX_TOTAL_ENTITIES, 2), np.nan, dtype=np.float32)


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


def test_refuge_capacity_reserved():
    eng = E.EcoEngine(world=30.0, cell_size=8.0, n_rabbits0=1010, n_foxes0=0,
                      n_grass0=0, grass_max=0, grass_spawn_rate=0.0,
                      rabbit_metab=0.0, rabbit_move_cost=0.0,
                      repro_threshold=1.0, init_energy=2.0,
                      refuge_rabbits=0, refuge_foxes=6, seed=9)
    eng.step(RAND, False)
    assert eng.active_count() == eng.capacity()
    assert eng.count_foxes() == 6
    print("  [OK] spawn pressure preserves six reserved fox-refuge slots")


def test_astar_targets_and_fallback():
    ek = dict(world=40.0, cell_size=4.0, vision=16.0, eat_radius=1.5,
              move_speed=1.0, rabbit_metab=0.0, fox_metab=0.0,
              rabbit_move_cost=0.0, repro_threshold=1e9, init_energy=10.0,
              n_rabbits0=1, n_foxes0=0, n_grass0=0, grass_max=0,
              grass_spawn_rate=0.0, seed=11)
    eng = E.EcoEngine(**ek)
    slot = int(np.where(np.asarray(eng.types()) == E.RABBIT)[0][0])
    eng.set_position(slot, 6.0, 10.0)
    eng.set_obstacle(2, 2)
    actions = RAND.copy()
    actions[slot] = (16.0, 0.0)
    eng.step(actions, True)
    assert eng.path_queries() == 1
    assert 0 < eng.path_expansions() <= E.ASTAR_MAX_EXPANSIONS
    assert eng.path_fallbacks() == 0
    assert not eng.is_obstacle(int(np.asarray(eng.xs())[slot] // 4),
                               int(np.asarray(eng.ys())[slot] // 4))

    eng.set_position(slot, 6.0, 10.0)
    actions[slot] = (4.0, 0.0)  # target cell is the solid wall itself
    eng.step(actions, True)
    assert eng.invalid_targets() == 1
    assert eng.path_fallbacks() == 1
    assert not eng.is_obstacle(int(np.asarray(eng.xs())[slot] // 4),
                               int(np.asarray(eng.ys())[slot] // 4))
    print("  [OK] target offsets route via bounded A*; blocked targets fall back safely")


def test_los_and_pillars():
    # Compact arena with a single central circular pillar (the arena geometry
    # primitive). LoS through the pillar must be occluded; rays clearing it must
    # stay visible; integer DDA must be perfectly direction-symmetric.
    # vision spans the arena so a single target offset can sit past the pillar,
    # forcing A* to plan a detour around it rather than re-targeting per step.
    eng = E.EcoEngine(world=40.0, cell_size=2.0, vision=30.0,
                      n_rabbits0=0, n_foxes0=1, n_grass0=0, grass_max=0,
                      grass_spawn_rate=0.0, move_speed=1.0,
                      fox_metab=0.0, repro_threshold=1e9, init_energy=1e9,
                      seed=17)
    eng.clear_obstacles()
    eng.add_pillar(20.0, 20.0, 6.0)
    assert eng.is_obstacle(10, 10), "pillar centre cell must be blocked"
    assert not eng.is_obstacle(0, 0), "far corner must be clear"
    assert not eng.line_of_sight(5, 20, 35, 20), "ray through pillar must occlude"
    assert eng.line_of_sight(5, 5, 35, 5), "ray clearing pillar stays visible"
    assert not eng.line_of_sight(8, 8, 32, 32), "diagonal through pillar occludes"
    # integer grid stepping => zero floating-point drift => exactly symmetric
    for (a, b) in [((5, 20), (35, 20)), ((8, 8), (32, 32)), ((5, 5), (33, 31))]:
        assert eng.line_of_sight(*a, *b) == eng.line_of_sight(*b, *a), \
            "LoS not direction-symmetric -> float drift"

    # A* must route a policy target straight through the pillar around it,
    # never clipping into solid geometry, never getting stuck.
    slot = int(np.where(np.asarray(eng.types()) == E.FOX)[0][0])
    eng.set_position(slot, 5.0, 20.0)
    acts = RAND.copy()
    acts[slot] = (30.0, 0.0)  # aim due east straight through the pillar
    for _ in range(200):
        eng.step(acts, True)
        x, y = np.asarray(eng.xs())[slot], np.asarray(eng.ys())[slot]
        assert not eng.is_obstacle(int(x / 2.0), int(y / 2.0)), "clipped into pillar"
    x = float(np.asarray(eng.xs())[slot])
    assert x > 25.0, f"A* failed to round the pillar (stuck at x={x:.1f})"
    print(f"  [OK] LoS occlusion + A* rounds pillar to x={x:.1f} without clipping")


def _cluster_density(n):
    eng = E.EcoEngine(world=40.0, cell_size=4.0, vision=12.0,
                      n_rabbits0=n, n_foxes0=0, n_grass0=0, grass_max=0,
                      grass_spawn_rate=0.0, seed=13)
    rabbits = np.where(np.asarray(eng.types()) == E.RABBIT)[0]
    for slot in rabbits:
        eng.set_position(int(slot), 20.0, 20.0)
    eng.build_agent_obs()
    row = np.asarray(eng.agent_obs())[0]
    return row[E.LOCAL_DIM:]


def test_density_channel_counts_beyond_top_n():
    small = _cluster_density(5)
    dense = _cluster_density(20)
    assert small.shape == dense.shape == (E.DENSITY_DIM,)
    assert np.isclose(small.max(), np.log10(5.0), atol=1e-6)
    assert np.isclose(dense.max(), np.log10(20.0), atol=1e-6)
    assert dense.max() > small.max()
    print("  [OK] fixed 24-slot density channel distinguishes 5 vs 20 clustered rabbits")


def test_astar_budget():
    eng = E.EcoEngine(world=100.0, cell_size=4.0, vision=12.0,
                      eat_radius=0.1, rabbit_metab=0.0, fox_metab=0.0,
                      rabbit_move_cost=0.0, repro_threshold=1e9, init_energy=10.0,
                      n_rabbits0=200, n_foxes0=0, n_grass0=0, grass_max=0,
                      grass_spawn_rate=0.0, seed=17)
    actions = np.full((E.MAX_TOTAL_ENTITIES, 2), np.nan, dtype=np.float32)
    slots = np.where(np.asarray(eng.types()) == E.RABBIT)[0]
    actions[slots] = (12.0, 12.0)
    for _ in range(20):
        eng.step(actions, True)
    t0 = time.perf_counter()
    frames = 1000
    for _ in range(frames):
        eng.step(actions, True)
    ms = (time.perf_counter() - t0) * 1000.0 / frames
    assert eng.path_queries() == 200
    assert eng.path_expansions() <= 200 * E.ASTAR_MAX_EXPANSIONS
    assert ms <= 0.5, f"A* frame overhead {ms:.3f}ms exceeds 0.5ms target"
    print(f"  [OK] bounded A*: 200 concurrent queries in {ms:.3f} ms/frame")


def test_density_builder_budget():
    eng = E.EcoEngine(world=100.0, cell_size=8.0, vision=12.0,
                      n_rabbits0=200, n_foxes0=0, n_grass0=0, grass_max=0,
                      grass_spawn_rate=0.0, seed=19)
    for _ in range(20):
        eng.build_agent_obs()
    t0 = time.perf_counter()
    frames = 1000
    for _ in range(frames):
        eng.build_agent_obs()
    ms = (time.perf_counter() - t0) * 1000.0 / frames
    assert ms <= 0.5, f"density observation builder {ms:.3f}ms exceeds 0.5ms target"
    assert np.asarray(eng.agent_obs()).shape == (200, E.AOBS)
    print(f"  [OK] local+density observation builder: {ms:.3f} ms/frame @ 200 agents")


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
    test_refuge_capacity_reserved()
    test_astar_targets_and_fallback()
    test_los_and_pillars()
    test_density_channel_counts_beyond_top_n()
    test_astar_budget()
    test_density_builder_budget()
    sps_g, sps_n, act = test_throughput()
    drift = test_memory_drift()
    print(f"\nRESULT: grid-correctness PASS | "
          f"speedup {sps_g/sps_n:.1f}x | "
          f"mem-drift {'PASS' if abs(drift) < 1.0 else 'FAIL'} ({drift:.2f}%)")
