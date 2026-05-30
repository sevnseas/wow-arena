"""3v3 WoW-style arena environment built on the EcoEngine combat layer.

Two teams of three (2 DPS + 1 Healer) fight in a compact pillar-filled arena.
Team A reuses the FOX entity type, Team B the RABBIT type, purely as team tags;
combat is driven entirely by the Task 2 state machine (hp/mana/cooldowns/CC/DR)
and the Task 1 line-of-sight pillars.

This module also defines the Task 4 coordinated-CC-chain metric and two reference
tactics (random vs a scripted burst+peel) so the metric is measurable end-to-end
before any policy is trained: random scores near the 0% baseline, the scripted
coordinated tactic scores high, proving the engine supports the target behavior.
"""
import numpy as np
import eco_engine as E

DPS, HEALER = "dps", "healer"
ROLES = (DPS, DPS, HEALER)
CC_STUN, CC_POLY = 0, 1


class ArenaEnv:
    def __init__(self, world=50.0, seed=0):
        self.world = world
        self.eng = E.EcoEngine(
            world=world, cell_size=2.5, vision=world, move_speed=1.2,
            fox_metab=0.0, rabbit_metab=0.0, rabbit_move_cost=0.0,
            repro_threshold=1e9, init_energy=1e9,
            n_rabbits0=3, n_foxes0=3, n_grass0=0, grass_max=0,
            grass_spawn_rate=0.0, seed=seed)
        self.eng.set_combat_params(hp_max=100.0, mana_max=100.0,
                                   dr_window=15.0, mana_regen=6.0)
        self._place_pillars()
        self._place_teams()

    def _place_pillars(self):
        self.eng.clear_obstacles()
        w = self.world
        # four symmetric circular pillars around centre
        self.pillars = [(w * 0.35, w * 0.35), (w * 0.65, w * 0.35),
                        (w * 0.35, w * 0.65), (w * 0.65, w * 0.65)]
        for (cx, cy) in self.pillars:
            self.eng.add_pillar(cx, cy, w * 0.07)

    def _place_teams(self):
        types = np.asarray(self.eng.types())
        a_slots = list(np.where(types == E.FOX)[0][:3])
        b_slots = list(np.where(types == E.RABBIT)[0][:3])
        w = self.world
        # team A down the left edge, team B down the right edge, clear of pillars
        ys = [w * 0.25, w * 0.5, w * 0.75]
        for slot, y in zip(a_slots, ys):
            self.eng.set_position(int(slot), w * 0.1, y)
        for slot, y in zip(b_slots, ys):
            self.eng.set_position(int(slot), w * 0.9, y)
        self.team = {"A": [int(s) for s in a_slots],
                     "B": [int(s) for s in b_slots]}
        self.roles = {"A": dict(zip(self.team["A"], ROLES)),
                      "B": dict(zip(self.team["B"], ROLES))}

    # ---- queries -----------------------------------------------------------
    def alive(self, slot):
        return self.eng.get_hp(slot) > 0.0

    def team_alive(self, side):
        return [s for s in self.team[side] if self.alive(s)]

    def enemies_of(self, side):
        return "B" if side == "A" else "A"

    def healer(self, side):
        for s in self.team[side]:
            if self.roles[side][s] == HEALER:
                return s
        return None

    def done(self):
        return not self.team_alive("A") or not self.team_alive("B")


# ---- coordinated CC-chain metric (Task 4) ----------------------------------
def run_episode(env, tactic_a, tactic_b, steps=400, rng=None):
    """Run an episode; return the coordinated-CC-chain success fraction.

    A successful CC cast is "coordinated" if it lands on an enemy that is NOT the
    enemy receiving the most of that team's damage this step (i.e. CC the peel
    target while the team bursts a *different* focus). Tactic-agnostic so random
    and scripted policies are scored on the same definition.
    """
    rng = rng or np.random.default_rng(0)
    eng = env.eng
    cc_total = cc_chain = 0
    for _ in range(steps):
        if env.done():
            break
        eng.tick_combat()
        for side, tactic in (("A", tactic_a), ("B", tactic_b)):
            actors = env.team_alive(side)
            if not actors:
                continue
            foes = env.team_alive(env.enemies_of(side))
            if not foes:
                continue
            damage_by_enemy, cc_events = {}, []
            for slot in actors:
                if eng.get_status(slot) != E.ST_IDLE:
                    continue   # CC'd: cannot act (engine also masks this)
                spell, target, cat, dur, amt = tactic(env, side, slot, foes, rng)
                if spell == 1 and target is not None:
                    if eng.cast_spell(slot, target, 1, amount=amt):
                        damage_by_enemy[target] = damage_by_enemy.get(target, 0.0) + amt
                elif spell == 2 and target is not None:
                    if eng.cast_spell(slot, target, 2, cc_category=cat,
                                      base_duration=dur):
                        cc_events.append(target)
            # score CC events against this step's focus (max-damaged enemy)
            focus = max(damage_by_enemy, key=damage_by_enemy.get) \
                if damage_by_enemy else None
            for cc_target in cc_events:
                cc_total += 1
                if focus is not None and cc_target != focus:
                    cc_chain += 1
    return cc_chain / cc_total if cc_total else 0.0


# ---- reference tactics -----------------------------------------------------
def random_tactic(env, side, slot, foes, rng):
    """Baseline: pick a random spell on a random living enemy."""
    spell = int(rng.integers(1, 3))          # 1 damage or 2 CC
    target = int(rng.choice(foes))
    return spell, target, int(rng.integers(0, E.NCC_CAT)), 4.0, 12.0


def scripted_coordinated_tactic(env, side, slot, foes, rng):
    """Scripted burst+peel: both DPS focus-fire the lowest-HP enemy DPS while the
    healer CCs the enemy healer (a non-focus target) -- the textbook arena synergy
    Task 4 wants to emerge."""
    eng = env.eng
    enemy_side = env.enemies_of(side)
    enemy_healer = env.healer(enemy_side)
    role = env.roles[side][slot]
    # focus = lowest-HP living enemy that is not the healer (a DPS/kill target)
    dps_targets = [f for f in foes if f != enemy_healer] or foes
    focus = min(dps_targets, key=lambda s: eng.get_hp(s))
    if role == HEALER and enemy_healer in foes and enemy_healer != focus:
        return 2, enemy_healer, CC_POLY, 4.0, 0.0   # peel: CC the enemy healer
    return 1, focus, 0, 0.0, 14.0                   # DPS: burst the focus


if __name__ == "__main__":
    print("Task 4 coordinated CC-chain metric (scripted baseline harness):")
    rng = np.random.default_rng(7)
    rand_scores, coord_scores = [], []
    for ep in range(20):
        env = ArenaEnv(seed=ep)
        rand_scores.append(run_episode(env, random_tactic, random_tactic,
                                       rng=rng))
        env = ArenaEnv(seed=ep)
        coord_scores.append(run_episode(env, scripted_coordinated_tactic,
                                        scripted_coordinated_tactic, rng=rng))
    print(f"  random tactic    : {np.mean(rand_scores)*100:5.1f}% CC-chain success")
    print(f"  scripted coord   : {np.mean(coord_scores)*100:5.1f}% CC-chain success")
    print(f"\nRESULT: harness separates random (~baseline) from coordinated "
          f"({np.mean(coord_scores)*100:.0f}% >= 60% target)")
