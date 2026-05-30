"""Task 2 acceptance: prove the trunk is permutation-invariant and ignores
inactive (zero-masked) entities, and measure inference latency."""
import time
import numpy as np
import torch
from eco_policy import EcoPolicy, SELF_DIM, ENT_DIM, MAX_VIS, OBS_DIM, pack_obs

torch.manual_seed(0)


def random_agent_obs(n_active, rng):
    self_state = rng.standard_normal(SELF_DIM).astype(np.float32)
    ents = []
    for _ in range(n_active):
        e = np.zeros(ENT_DIM, dtype=np.float32)
        e[0] = 1.0                                  # active flag
        e[1:3] = rng.standard_normal(2) * 0.3       # rel dx,dy
        e[3 + rng.integers(0, 3)] = 1.0             # one-hot type
        ents.append(e)
    return self_state, ents


def test_permutation_invariance():
    rng = np.random.default_rng(1)
    pol = EcoPolicy().eval()
    max_diff = 0.0
    for _ in range(50):
        n = rng.integers(2, MAX_VIS + 1)
        self_state, ents = random_agent_obs(n, rng)
        obs_a = pack_obs(self_state, ents)
        perm = rng.permutation(len(ents))
        obs_b = pack_obs(self_state, [ents[i] for i in perm])
        with torch.no_grad():
            la, _ = pol(torch.from_numpy(obs_a)[None])
            lb, _ = pol(torch.from_numpy(obs_b)[None])
        max_diff = max(max_diff, (la - lb).abs().max().item())
    print(f"  permutation invariance: max logit diff = {max_diff:.2e} "
          f"(target <= 1e-5)")
    assert max_diff <= 1e-5
    print("  [OK] order-invariant")


def test_closest_furthest_swap():
    """Spec's guardrail: flip the array indices of nearest vs furthest neighbour;
    output distribution must match to 1e-5."""
    rng = np.random.default_rng(2)
    pol = EcoPolicy().eval()
    self_state, ents = random_agent_obs(MAX_VIS, rng)
    # sort by distance, then swap closest (0) and furthest (-1) slots
    ents = sorted(ents, key=lambda e: e[1] ** 2 + e[2] ** 2)
    swapped = list(ents); swapped[0], swapped[-1] = swapped[-1], swapped[0]
    with torch.no_grad():
        pa = torch.softmax(pol(torch.from_numpy(pack_obs(self_state, ents))[None])[0], -1)
        pb = torch.softmax(pol(torch.from_numpy(pack_obs(self_state, swapped))[None])[0], -1)
    d = (pa - pb).abs().max().item()
    print(f"  closest/furthest swap: max prob diff = {d:.2e}")
    assert d <= 1e-5
    print("  [OK] hunting target invariant to slot order")


def test_inactive_invariance():
    """Adding/removing zero-masked padding entities must not change output."""
    rng = np.random.default_rng(3)
    pol = EcoPolicy().eval()
    self_state, ents = random_agent_obs(5, rng)
    obs_few = pack_obs(self_state, ents)            # 5 active, 11 padding
    # different random padding rows but still inactive (active flag = 0)
    obs_pad = obs_few.copy()
    for k in range(5, MAX_VIS):
        row = rng.standard_normal(ENT_DIM).astype(np.float32)
        row[0] = 0.0                                 # keep inactive
        obs_pad[SELF_DIM + k * ENT_DIM: SELF_DIM + (k + 1) * ENT_DIM] = row
    with torch.no_grad():
        a = pol(torch.from_numpy(obs_few)[None])[0]
        b = pol(torch.from_numpy(obs_pad)[None])[0]
    d = (a - b).abs().max().item()
    print(f"  inactive-row invariance: max logit diff = {d:.2e}")
    assert d <= 1e-5
    print("  [OK] padding entities ignored")


def test_latency():
    pol = EcoPolicy().eval()
    for bs in (256, 1024):
        obs = torch.randn(bs, OBS_DIM)
        with torch.no_grad():
            for _ in range(5): pol(obs)           # warm
            t0 = time.perf_counter()
            for _ in range(50): pol(obs)
            ms = (time.perf_counter() - t0) / 50 * 1000
        print(f"  latency batch={bs:>4}: {ms:.3f} ms/inference (target <= 3.5ms)")


if __name__ == "__main__":
    print("Task 2 acceptance:")
    test_permutation_invariance()
    test_closest_furthest_swap()
    test_inactive_invariance()
    test_latency()
    print("\nRESULT: permutation-invariant trunk PASS")
