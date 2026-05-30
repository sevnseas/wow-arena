"""Task 3 acceptance: PufferLib-style shared-policy MARL plumbing.

Asserts:
  1. variable active-agent counts are handled frame-to-frame (e.g. 40 foxes/120
     rabbits -> 41/118) without shape failures;
  2. gradients cleanly backprop into BOTH independent policy heads;
  3. ID synchronisation: a slot is only ever written by the policy of its own
     type (cross-contamination guardrail) -- and the guard actually fires when
     alignment is violated.
"""
import numpy as np
import torch
import eco_engine as E
from eco_marl import MARLRunner


def test_variable_agent_counts():
    r = MARLRunner(engine_kwargs=dict(seed=1))
    seen = set()
    for _ in range(40):
        n = r.eng.build_agent_obs()
        obs = np.array(r.eng.agent_obs(), copy=True)
        slots = np.array(r.eng.agent_slots(), copy=True)
        types = np.array(r.eng.agent_types(), copy=True)
        assert obs.shape == (n, E.AOBS)
        assert n == (types == E.FOX).sum() + (types == E.RABBIT).sum()
        r._route_actions(slots, types, obs)
        r.eng.step(r._action_buf, True)
        seen.add((int((types == E.FOX).sum()), int((types == E.RABBIT).sum())))
    print(f"  [OK] handled {len(seen)} distinct (fox,rabbit) count combos, "
          f"no shape failures")
    assert len(seen) > 5


def test_gradients_both_heads():
    r = MARLRunner(engine_kwargs=dict(seed=2))
    store, _ = r.collect(horizon=64)
    # snapshot params
    before = {t: [p.clone() for p in r.policy[t].parameters()] for t in (E.FOX, E.RABBIT)}
    stats = r.update(store)
    assert E.FOX in stats and E.RABBIT in stats, "both species must have transitions"
    for t in (E.FOX, E.RABBIT):
        # grads were produced
        gnorms = [p.grad is not None and p.grad.abs().sum().item() > 0
                  for p in r.policy[t].parameters()]
        assert any(gnorms), f"no gradient reached policy {t}"
        # params actually moved
        moved = any(not torch.equal(a, b)
                    for a, b in zip(before[t], r.policy[t].parameters()))
        assert moved, f"policy {t} params did not update"
    print(f"  [OK] gradients + param updates on BOTH heads "
          f"(fox grad={stats[E.FOX]['grad']:.3f}, rab grad={stats[E.RABBIT]['grad']:.3f})")


def test_no_cross_contamination():
    r = MARLRunner(engine_kwargs=dict(seed=3))
    # run many frames; the assertion inside _route_actions must never fire
    for _ in range(200):
        n = r.eng.build_agent_obs()
        if n == 0:
            break
        obs = np.array(r.eng.agent_obs(), copy=True)
        slots = np.array(r.eng.agent_slots(), copy=True)
        types = np.array(r.eng.agent_types(), copy=True)
        r._route_actions(slots, types, obs)
        r.eng.step(r._action_buf, True)
    print("  [OK] 200 frames, no rabbit action ever applied to a fox (or vice versa)")

    # negative control: deliberately mislabel types -> guard MUST fire
    r.eng.build_agent_obs()
    slots = np.array(r.eng.agent_slots(), copy=True)
    types = np.array(r.eng.agent_types(), copy=True)
    obs = np.array(r.eng.agent_obs(), copy=True)
    if (types == E.FOX).any() and (types == E.RABBIT).any():
        bad = types.copy()
        bad[bad == E.FOX] = E.RABBIT          # claim every fox is a rabbit
        try:
            r._route_actions(slots, bad, obs)
            raise SystemExit("guardrail FAILED to catch mislabelled types")
        except AssertionError:
            print("  [OK] guardrail correctly raises on deliberate ID mismatch")


if __name__ == "__main__":
    print("Task 3 acceptance:")
    test_variable_agent_counts()
    test_gradients_both_heads()
    test_no_cross_contamination()
    print("\nRESULT: multi-agent shared-policy integration PASS")
