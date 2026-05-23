# rl3 — outsourcing more of the brain

The first two rounds (`entity-policies.md`, `rl2.md`) shipped a 12-dim state, 5-intent action space, and per-archetype shared MLPs that produce the headline emergent behaviors: gang-up, pack sync, herd defense, hide-to-heal, graze-to-heal.

But a *lot* of the actual decision-making is still hand-coded. Look at any `getPolicyAgents().applyIntent` adapter — wolves resolve their prey via `resolvePreyByPos`, cats use `findNearestPrey` for combat acquisition, the werewolf has bespoke player-aggro logic, every animal's team/enemy classification is wired at spawn time. The brain only picks *what kind* of thing to do; the engine still decides *who*, *when*, and *how aggressively*.

This doc lays out the migration ladder for moving those decisions into the policy, while keeping the deterministic things — pathfinding, animation timing, collision resolution — as tools the brain can *invoke* but not learn.

---

## 1. The principle

> **The policy owns the decision. The tool owns the execution.**

Tier 2 (the engine) currently owns both. Every time `wolves.ts` reads `wolf.state` and picks a behavior, that's a decision the policy could have made if it had richer perception and a richer action space.

The hand-coded rules we keep are the ones a network *cannot afford to relearn from scratch in every episode*:

| keep as tool (deterministic) | move into policy (learned) |
|---|---|
| A* / NavMesh pathfinding | which entity to path *toward* |
| Animation playback + IK | when to attack, when to flee |
| Collision / physics | how aggressively to commit |
| Spell projectile physics | which spell to cast on whom |
| Raycast-based line-of-sight | whether to break LOS deliberately |
| Damage application math | who counts as "enemy" right now |

This split matches the two-tier diagram from `entity-policies.md §1`. What rl3 changes is the *boundary*: more decisions cross into Tier 1.

---

## 2. The migration ladder

Five rungs, ordered by safety. Each rung depends on validation tests landing before the hand-coded version is removed.

### Rung 0 — current state (rl2)

- Brain: `Idle / Attack / CC / Heal / Flee`
- Focus picked **outside the brain** by `pickFocus(visionRadius)` — a deterministic argmax over (team-aware) score
- Team / archetype hard-coded at spawn

### Rung 1 — target selection moves into the brain

The brain stops being given a focus. Instead it sees an **attention-pooled candidate list** and emits both an intent *and* a target slot.

```
Action output ≡ (intent: 5, target_slot: K)
                where target_slot indexes a sorted list of K nearest entities.
```

The deterministic helper provides the K-slot list (with pos, hp, distance, last-seen-intent, archetype-id), but it does *not* score them. The brain learns its own attention weighting and so can produce behaviors the score function never could:

- A cat might focus a low-HP rabbit *or* a wolf attacking it, depending on its hp_reserve.
- A wolf can target the boss specifically when its pack is in position, even if the boss isn't the "best" generic focus.
- A cow can decide "the entity that hit my sister" vs. "the entity attacking me" by reading focus history.

Behavior tests guarding this rung:

- `targetSelectionMatchesPickFocus(±10%)` — under random scenarios the learned policy must reach ≥90% agreement with the old heuristic. Once it does, drop `pickFocus`.
- `attackHealerOverDPS` — in a 1 healer + 2 DPS pod, the policy must select the healer slot >60% of the time when its CC action would be otherwise generic (rl2 §2).

### Rung 2 — team membership is inferred, not assigned

Today `team: 'predator' | 'prey'` is set at spawn. That hard-encodes the social graph.

Replace with **affinity features** per candidate in the attention pool:

```
per-slot features added to the K-list:
  + affinity_recent_damage_to_me     [−1 → +1]
  + affinity_recent_damage_to_ally   [−1 → +1]
  + affinity_recent_heal_to_me       [0 → 1]
  + affinity_archetype_kinship       [0 → 1]   // same archetype → high
  + affinity_archetype_diet          [−1 → +1] // we eat them ↔ they eat us
  + last_observed_intent_was_attack  [0 → 1]
  + last_observed_intent_was_heal    [0 → 1]
```

The network learns "enemy" as `negative_affinity + observed_hostility`. A wolf that has been healing the player should now read as friendly to that player's policy, even though `team !== player.team`. A cow that always grazes near you shifts affinity toward "ally" automatically.

Behavior tests:

- `affinityFlipsAfterBetrayal` — a wolf that the player has been feeding (some new heal-via-item ability) gets attacked by the player → it must re-aggro within ≤3 decisions.
- `affinityResistsNoise` — a single accidental hit during a heal sequence must NOT flip affinity if the next 5 interactions are positive.

This is the most valuable rung. It eliminates an entire class of hand-coded conditionals across `wolves.ts`, `cats.ts`, `dogs.ts`, `mutant-predator.ts`.

### Rung 3 — cast-bar perception + interrupt action

Add an action `Interrupt(target_slot)` and a perception channel:

```
per-slot features added:
  + cast_progress      [0 → 1, 0 = not casting]
  + cast_duration      [seconds remaining]
  + cast_school        // categorical: damage / heal / cc / utility
```

The reward shaping: **interrupting a heal cast > interrupting a damage cast > interrupting nothing**. The policy gradient must learn to read `cast_progress > 0.5 AND cast_school == heal` → P(Interrupt) spike.

Behavior tests:

- `interruptLatency_pct95 < 200ms` — measured from cast-start to interrupt-fire, over 100 trials.
- `interruptPrefersHeal` — when a damage caster and a heal caster are both available, P(Interrupt|heal) > P(Interrupt|damage) by ≥2×.
- `noInterruptOnInstant` — no wasted CC on instant-cast targets (cast_progress always 0).

Tools the brain *invokes* (not learns):

- `tools.cast(spell_id, target)` — handles range check, mana cost, cast-time animation, projectile spawn. Brain doesn't compute trajectory.
- `tools.cancelOwnCast()` — graceful interrupt of self-cast.

### Rung 4 — kiting via "Maintain-Distance(d)" tool

Adds a continuous-output head: the brain emits a scalar `desired_range ∈ [0, 30m]` alongside its intent. The deterministic tool `tools.maintainDistance(target, desired_range)` solves the steering vector. The brain only needs to learn:

```
desired_range ≈ f(self_archetype, self_hp, target_dps, target_charge_speed,
                   enemy_pressure_count, time_since_last_cast)
```

A 30m hunter learns large `desired_range`. A wounded melee learns large `desired_range` when CC is on cooldown. A rabbit just keeps `desired_range = ∞`.

Reward shaping (from rl2 §2): `melee_avoidance_penalty` per tick when an enemy is inside `range < 3m`. Bonus per tick spent inside `optimal_dps_window`.

Behavior tests:

- `huntsmanKiteArc` — measured: rolling std-dev of (distance to focus over 10s) is high, mean distance close to weapon's max range.
- `meleeClosesGap` — same metric, but distance stays small and constant.
- `kiteSwitchesOnCDexpiry` — a kiter caught in melee uses an off-CD slow + opens distance within 3 decisions.

### Rung 5 — pathing target moves into the policy

The final rung. Instead of `tools.pathTo(target_slot)`, the brain emits a coarse waypoint vector — `(direction_8, distance_3)` — and the A* tool handles the actual route around walls.

This unlocks tactical positioning that wasn't directly about a target:

- A wolf positioning behind a tree before pouncing
- A healer kiting toward a pillar to LOS-break the boss's cast
- A cow herd circling around fresh grass while a wolf approaches

Validation:

- `losBreakOnBigCast` — when an enemy boss starts a 3s cast, defenders pick a waypoint whose ray-to-boss is blocked.
- `funnelToChokepoint` — under multi-enemy pressure, agents converge on map chokepoints rather than scattering.

This rung is *expensive*. Don't ship it until rungs 1–4 are validated and the perception layer is rich enough that "tactical positioning" has signal.

---

## 3. State-space evolution

Rl2 state (12-dim, self-centric) → rl3 state (self block + per-slot block, K=4 or 8):

```
rl3 state vector ≡ [ self_features(12) | candidate_slot_1 | … | candidate_slot_K ]

self_features        (12 from rl2: hp, status, focus*, ally_danger, pressure,
                     herd_panic, pack_readiness, target_unawareness,
                     resource_density, energy_reserve)

candidate_slot_k     (≈ 14 features per slot, K = 4 default)
  + dist                       float [0,1]
  + dir_dx / dir_dz            relative bearing (normalised)
  + hp                         float
  + archetype_one_hot          7 dims for {wolf,rabbit,cow,cat,dog,werewolf,player}
  + affinity_recent_damage     (from rung 2)
  + affinity_recent_heal       (from rung 2)
  + cast_progress              (from rung 3)
  + cast_school                3-dim one-hot (dmg/heal/cc) (rung 3)
  + last_observed_intent       (5-dim one-hot, our own decisions Map snapshot)
```

Total dim = 12 + 4 × 14 ≈ **68**. Still a tiny network — 68 × 32 × (5 intents + 4 target slots + 1 desired_range) = ~2.5k parameters per archetype. Trains in seconds on a CPU.

The candidate slots are filled deterministically (closest-K from a vision-radius scan) but **the score that picks WHICH slots to keep is fixed** — distance, then alphabetical id as tiebreak. The brain is the only thing that *uses* the slots to decide.

---

## 4. Action space evolution

```
rl2 action ≡ intent ∈ {Idle, Attack, CC, Heal, Flee}                     [5 logits]

rl3 action ≡ {
  intent:        ∈ {Idle, Attack, CC, Heal, Flee, Interrupt, Cast, Wait} [8 logits]
  target_slot:   ∈ {self, slot_0, …, slot_{K-1}}                         [K+1 logits]
  desired_range: ∈ [0, 1]  // scaled to 30m at engine-time                [continuous]
}
```

Three heads, sampled jointly. Loss = REINFORCE on each head independently with the same advantage (or PPO with shared backbone).

Target-slot semantics:

- `Attack(slot)` → tool: chase + bite that entity
- `Cast(slot)` → tool: cast equipped spell at that entity (spell choice is itself a tiny side-head — punt to rung 3.5)
- `Heal(self)` → graze / hide regen
- `Heal(slot)` → heal that ally (for any future healer archetype)
- `Interrupt(slot)` → trigger CC on the target if it's casting; punished if not
- `Wait` → genuine no-op; lets cooldowns roll without committing

The `target_slot` head is masked: if `slot_k.dist == 0` (slot empty) the logit is set to `-∞` before softmax. This is the standard "invalid-action mask" trick.

---

## 5. Tools the brain calls

These are deterministic helpers exposed via well-named action codes — *not* things the brain has to relearn.

| tool | inputs | what it does |
|---|---|---|
| `tools.pathTo(slot)` | target slot or waypoint | A*/NavMesh; sets engine target |
| `tools.maintainDistance(slot, d)` | slot + meters | reverse-steer to hold range |
| `tools.cast(spell_id, slot)` | spell + target | range check, mana, animation, projectile |
| `tools.cancelOwnCast()` | — | breaks self-cast cleanly |
| `tools.interrupt(slot)` | slot | applies CC if the slot is mid-cast |
| `tools.flee(slot)` | slot | engine antipode steering |
| `tools.graze()` | — | walk to nearest grass, chomp |
| `tools.hide()` | — | drop combat target, slow regen |

Adding a new ability is now a tool-side change (engine + spell data), not a policy retraining. Existing trained brains can call `tools.cast('fireball', slot)` even if `fireball` was added after training, *provided* the spell shows up in the action space — which is why `intent: Cast` is one slot rather than per-spell.

For spell-specific learning, a small per-archetype side-head outputs `spell_id ∈ {fireball, frostbolt, polymorph, …}` conditional on `intent == Cast`. That head is what learns "polymorph the kiter, fireball the meleer."

---

## 6. Reward shaping changes

Most rl2 shaping carries over. New components:

| signal | source | reward |
|---|---|---|
| Interrupt landed on a heal cast | rung 3 | + `heal_about_to_land * 1.0` |
| Interrupt landed on a damage cast | rung 3 | + `damage_about_to_land * 0.4` |
| Interrupt fired against non-caster | rung 3 | − 0.5 (wasted CC) |
| Time inside `optimal_dps_window` | rung 4 | + 0.05 per tick |
| Time inside enemy melee range as a kiter | rung 4 | − 0.1 per tick |
| LOS broken on a 3s+ boss cast | rung 5 | + 1.5 |
| Affinity update consistent with damage history | rung 2 | + 0.02 per correct call |

The principle stays: **shape what we measure in the validation suite, not what we want behaviorally**. If the test asserts "interrupt latency under 200ms", reward arrives strictly from passing that contract.

---

## 7. Behavior test suite — the contract

`src/__tests__/rl.test.ts` + `src/rl/validate.ts` already gate the rl1/rl2 milestones. rl3 grows it from 18 → ~30 cases. Every rung above ships *with its tests* — and the old hand-coded fallback is only deleted once tests pass against the trained policy.

| rung | test | metric / threshold |
|---|---|---|
| 1 | targetSelectionMatchesPickFocus | agreement ≥ 90% |
| 1 | attackHealerOverDPS | P(CC on healer) ≥ 0.6 |
| 2 | affinityFlipsAfterBetrayal | aggro within ≤3 decisions |
| 2 | affinityResistsNoise | no flip on isolated bad event |
| 3 | interruptLatency_pct95 | < 200 ms |
| 3 | interruptPrefersHeal | P(int\|heal) > 2× P(int\|dmg) |
| 3 | noInterruptOnInstant | < 5% of decisions |
| 4 | huntsmanKiteArc | dist std-dev > 4m, mean near max range |
| 4 | meleeClosesGap | dist mean < 2m, std-dev < 1m |
| 4 | kiteSwitchesOnCDexpiry | observed within 3 decisions |
| 5 | losBreakOnBigCast | break achieved before cast finishes, ≥70% |
| 5 | funnelToChokepoint | mean position concentration ↑ vs scatter baseline |

Adding a new emergent behavior to the game **means writing the test first**, then leaving the policy to find it. If three training runs in a row can't pass the test, the reward shaping is wrong — not the policy.

---

## 8. What stays hand-coded (forever)

These never move into the policy because they're either deterministic physics or too dense to learn from scratch:

- collision resolution, capsule sweeps, ground snapping
- animation state machines (the brain triggers `tools.cast`, engine plays the cast animation)
- projectile motion + hitboxes
- A* / NavMesh / steering integration
- damage application arithmetic
- map-side colliders + LOS raycasts

The brain *consumes* their outputs (cast_progress, target_unawareness, focus_dist) and *invokes* their actions (`tools.pathTo`, `tools.cast`). That's the boundary.

---

## 9. Migration order — concrete next 4 PRs

1. **Rung 1 — target slot head.** Refactor `PolicyAgentRef` to accept a slot list. Add target_slot logit head to `Policy`. Validate: `targetSelectionMatchesPickFocus`. Don't delete `pickFocus` yet.
2. **Rung 2 — affinity features.** Add the 7 per-slot affinity features. Replace `team` references in reward shaping with `affinity_recent_damage_*`. Validate: `affinityFlipsAfterBetrayal`. Delete `team` field from spawn (mark all team queries deprecated).
3. **Rung 3 — interrupt + cast bar.** Add Interrupt intent + cast_progress/cast_school per-slot features. Add a tiny `castSystem` already present in `systems.ts` to expose cast progress on entities. Validate: `interruptLatency_pct95 < 200ms`.
4. **Rung 4 — desired_range continuous head.** Add the continuous output. Build `tools.maintainDistance`. Validate: `huntsmanKiteArc`, `meleeClosesGap`.

Each PR includes its tests and re-trains the affected archetypes. Old hand-coded behavior stays as a fallback until the next PR demonstrates the test passes for ≥3 consecutive training seeds.

---

## 10. Risks / open questions

- **Target slot churn.** If the closest-K slot order changes between decisions (a wolf overtakes a cat), a brain that chose `slot_2` last decision now sees a different entity in that slot. Mitigation: pin slot order by stable-id within a decision window, or output a slot *and* its id so the engine can match-and-stick.
- **Joint action variance.** Three heads sampled independently can produce nonsense — `Cast(self)` or `Interrupt(slot_3)` when slot 3 is empty. Mitigation: action-masking for invalid combos, hierarchical sampling (intent first, then target conditional on intent).
- **Affinity bootstrap.** A fresh world has no interaction history → all affinities are 0 → policy can't distinguish anyone. Seed-affinity table per archetype pair (wolf−rabbit = −0.8 initial) gets us a working prior while the per-individual learned signal takes over.
- **Reward hacking on interrupt.** If interrupt reward is too high, every agent will spam Interrupt on every cast — even ones too far away to land. Add the `noInterruptOnInstant` test and a small `−0.05` per Interrupt to keep usage purposeful.
- **Compute cost of K-slot perception.** State dim jumps from 12 → ~68. Per-archetype param count goes from ~350 → ~2.5k. Still small, but per-frame forward pass for ~30 agents = 30 × 2.5k = 75k multiplies — fine on the main thread, but worth checking if we ever scale entity count by 10×.
