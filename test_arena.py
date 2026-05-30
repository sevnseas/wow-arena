"""Task 2 acceptance harness for the arena combat state machine.

Checks:
  1. CC masking: a stunned/polymorphed agent has ALL movement + non-idle spell
     heads forced to 0 in the C++ action-mask buffer; a free agent does not.
  2. Diminishing Returns: a second same-category CC inside the DR window lands at
     exactly 50% duration, the third at 25%, the fourth is immune (0); a CC of a
     *different* category is unaffected.
  3. Cooldown / mana / line-of-sight gating of casts.
"""
import numpy as np
import eco_engine as E

# Two stationary agents (one rabbit "caster", one fox "target"), no metabolism /
# reproduction so the combat layer is studied in isolation.
ARENA = dict(world=40.0, cell_size=2.0, vision=30.0, move_speed=1.0,
             fox_metab=0.0, rabbit_metab=0.0, rabbit_move_cost=0.0,
             repro_threshold=1e9, init_energy=1e9,
             n_rabbits0=1, n_foxes0=1, n_grass0=0, grass_max=0,
             grass_spawn_rate=0.0, seed=5)


def _two_agents():
    eng = E.EcoEngine(**ARENA)
    eng.clear_obstacles()
    eng.set_combat_params(hp_max=100.0, mana_max=100.0, dr_window=15.0,
                          mana_regen=1.0)
    types = np.asarray(eng.types())
    caster = int(np.where(types == E.RABBIT)[0][0])
    target = int(np.where(types == E.FOX)[0][0])
    eng.set_position(caster, 10.0, 20.0)
    eng.set_position(target, 14.0, 20.0)   # in LoS, close together
    return eng, caster, target


def test_cc_masks_movement_and_spells():
    eng, caster, target = _two_agents()
    # land a 4-tick stun (category 0) on the target
    assert eng.cast_spell(caster, target, slot=2, cc_category=0,
                          base_duration=4.0), "CC cast should succeed"
    assert eng.get_status(target) == E.ST_STUNNED
    assert eng.get_cc_timer(target) == 4.0

    n = eng.build_agent_obs()
    eng.build_action_mask()
    mask = np.asarray(eng.action_mask())
    slots = np.asarray(eng.agent_slots())
    trow = int(np.where(slots == target)[0][0])
    crow = int(np.where(slots == caster)[0][0])

    move = mask[:, :E.N_MOVE]
    spell = mask[:, E.N_MOVE:E.N_MOVE + E.NSPELL]
    # target (CC'd): every movement angle masked, every non-idle spell masked,
    # idle still legal.
    assert move[trow].sum() == 0.0, "CC'd agent must have movement locked"
    assert spell[trow, 0] == 1.0, "idle is always legal"
    assert spell[trow, 1:].sum() == 0.0, "CC'd agent must have spells locked"
    # caster (free): can move; idle always legal
    assert move[crow].sum() == E.N_MOVE, "free agent can move in every direction"
    assert spell[crow, 0] == 1.0
    print("  [OK] CC'd agent: all 16 move + 3 spell heads masked; free agent open")


def test_diminishing_returns_halving():
    eng, caster, target = _two_agents()
    # spell slot 2 has an 8-tick cooldown by default; zero it out between casts so
    # we exercise DR, not cooldown gating, by recreating fresh casters is messy --
    # instead reduce cooldown via repeated ticks. Simpler: cast, clear CC + cd by
    # ticking enough, then recast within the DR window.
    durations = []
    for cast_i in range(4):
        ok = eng.cast_spell(caster, target, slot=2, cc_category=0,
                            base_duration=4.0)
        assert ok, f"cast {cast_i} should fire (DR shortens duration, not the cast)"
        durations.append(eng.get_cc_timer(target))
        # advance just past the CC so status clears, but stay inside dr_window
        # (15) and clear the caster's 8-tick cooldown: tick 8 times.
        for _ in range(8):
            eng.tick_combat()
    # 1st full (4), 2nd halved (2), 3rd quartered (1), 4th immune (0)
    assert durations == [4.0, 2.0, 1.0, 0.0], f"DR ladder wrong: {durations}"
    print(f"  [OK] DR ladder by category: {durations} (full/half/quarter/immune)")

    # a different CC category is independent: fresh poly lands at full value
    eng2, c2, t2 = _two_agents()
    eng2.cast_spell(c2, t2, slot=2, cc_category=0, base_duration=4.0)  # stun
    for _ in range(8):
        eng2.tick_combat()
    ok = eng2.cast_spell(c2, t2, slot=2, cc_category=1, base_duration=4.0)  # poly
    assert ok and eng2.get_cc_timer(t2) == 4.0, "different CC category must be full"
    assert eng2.get_status(t2) == E.ST_POLYMORPHED
    print("  [OK] DR is per-category: stun then poly both land full")

    # DR window expiry forgets stacks: after dr_window ticks the next stun is full
    eng3, c3, t3 = _two_agents()
    eng3.cast_spell(c3, t3, slot=2, cc_category=0, base_duration=4.0)
    for _ in range(16):   # > dr_window (15)
        eng3.tick_combat()
    assert eng3.get_dr_stacks(t3, 0) == 0, "DR stacks must reset after window"
    eng3.cast_spell(c3, t3, slot=2, cc_category=0, base_duration=4.0)
    assert eng3.get_cc_timer(t3) == 4.0, "post-window CC should be full again"
    print("  [OK] DR window expiry resets stacks; CC lands full afterwards")


def test_cast_gating():
    eng, caster, target = _two_agents()
    # cooldown gate: immediate recast of the same slot fails
    assert eng.cast_spell(caster, target, slot=1, base_duration=0.0, amount=10.0)
    assert not eng.cast_spell(caster, target, slot=1, amount=10.0), \
        "second cast on cooldown must fail"
    assert eng.get_hp(target) == 90.0, "one damage tick of 10 applied"

    # CC'd caster cannot act
    eng2, c2, t2 = _two_agents()
    eng2.cast_spell(t2, c2, slot=2, cc_category=0, base_duration=4.0)  # target stuns caster
    assert eng2.get_status(c2) == E.ST_STUNNED
    assert not eng2.cast_spell(c2, t2, slot=1, amount=10.0), \
        "stunned caster must be unable to cast"

    # line-of-sight gate: a pillar between caster and target blocks the cast
    eng3, c3, t3 = _two_agents()
    eng3.set_position(c3, 5.0, 20.0)
    eng3.set_position(t3, 35.0, 20.0)
    eng3.add_pillar(20.0, 20.0, 6.0)
    assert not eng3.line_of_sight(5, 20, 35, 20)
    assert not eng3.cast_spell(c3, t3, slot=1, amount=10.0), \
        "occluded target must block the cast"
    print("  [OK] casts gated by cooldown, CC-on-caster, and line-of-sight")


if __name__ == "__main__":
    print("Task 2 acceptance:")
    test_cc_masks_movement_and_spells()
    test_diminishing_returns_halving()
    test_cast_gating()
    print("\nRESULT: arena combat state machine PASS")
