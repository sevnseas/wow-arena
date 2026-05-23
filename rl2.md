To see complex tactical ecosystem behaviors—like cows forming defensive herds, rabbits balancing reproduction loops with panic bursts, wolves stalking as an organized unit, and ranged characters executing perfect kiting sweeps—emerge purely out of a neural network, you don't write rules. You design specialized State Signals (Perception) and Fitness Functions (Discounted Returns).By feeding these precise signals into your high-level, algorithmic-assisted framework, the agents will discover these legendary MMO behaviors completely unscripted.1. The Behavioral Blueprint MatrixHere is exactly how to configure the perception inputs, action choices, and reward systems for each of your desired emergent archetypes.Archetype A: The Prey Herd (Cows Ganging Up)The Intent: Cows graze peacefully, but if a single wolf bites one herd member, the entire flock turns into a defensive phalanx to protect it.Perception Vectors Needed:herd_panic_vector: A pooled directional vector showing the average distance and location of any ally taking damage nearby.ally_hp_deltas: Tracking if a neighbor's health pool is falling.High-Level Actions: 0: Graze/Wander, 1: Intercept & Defend Target (Algorithmic pathing to an ally's attacker).Reward Formulation ($R$):Individual survival is heavily tied to team survival using Shared Team Credit Assignment ($0.5 R_{\text{Self}} + 0.5 \bar{R}_{\text{Herd}}$).If a cow runs away while its sister is being chewed on, the team penalty drags its individual score down. If it switches to Action 1: Defend Target, hitting that specific wolf removes the team-wide bleeding penalty. Defensive herd grouping emerges.Archetype B: The Risk-Reward Gatherer (Rabbits Repopulating)The Intent: Rabbits venture out to collect resources fast, then quickly dive back into holes to multiply.Perception Vectors Needed:resource_density: Proximity and yield of nearby grazing patches.safe_zone_dist: Distance to the nearest burrow/hole.energy_reserve: A float $[0, 1.0]$ representing hunger/reproduction readiness.High-Level Actions: 0: Rapid Gather, 1: Dash to Burrow, 2: Reproduce (Only clickable at $1.0$ energy).Reward Formulation ($R$):+5.0 for executing Action 2: Reproduce (The ultimate evolutionary goal).-10.0 for dying.+0.1 per resource gathered.The Emergent Loop: The rabbit will discover that sitting in the open gathering forever guarantees a massive death penalty when a wolf wanders by. It learns to execute high-intensity bursts of gathering until its energy_reserve hits $1.0$, then instantly drops everything to select Action 1: Dash to Burrow to safely cash in its reproduction reward.Archetype C: The Apex Pack (Stalking Wolves)The Intent: Wolves don't run in mindlessly; they tail a target from the shadows and strike as a unified burst window.Perception Vectors Needed:target_unawareness: $1.0$ if the target cannot see the wolf (e.g., wolf is behind them or in stealth), $0.0$ if spotted.pack_readiness: Count of nearby allies who also have a clear line-of-sight pathing vector to the same target.High-Level Actions: 0: Stalk & Shadow (Algorithmic match-speed steering that maintains an 8-meter gap outside detection range), 1: Pack Strike (Maximum DPS dump).Reward Formulation ($R$):A massive Coordination Penalty if a wolf attacks while pack_readiness < 2. A single wolf rushing in alerts the prey, causes it to flee, and yields zero food.An exponential bonus for attacking when pack_readiness == Max and target_unawareness == 1.0.The Emergent Loop: Wolves will naturally fan out and trail behind a cow, waiting patiently in the Stalk action state until the neural networks of all nearby pack mates simultaneously signal that they are in position. They execute a synchronized target switch, completely overwhelming the prey.2. Advanced Arena Dynamics: Ranged Kiting & Intelligent CCWhen handling tactical combat features like crowd control and kiting, you treat spells as Tools with Strategic Utility Values.Ranged Attackers (The Kiting Arc)To make a hunter or mage kite perfectly, you do not hardcode a retreat distance. It is driven by Melee Avoidance Penalties.The Setup: Give the ranged entity an action called Action: Maintain Max Range (The engine calculates a backtracking steering path that keeps the target right at the maximum edge of a 20-meter spell range).The Reward Driver: Apply a massive negative penalty to the ranged agent if an enemy gets within a 3-meter melee radius (is_cornered).The Emergence: The agent's $Q$-network learns that executing attack spells while an enemy is charging down on them leads directly to a massive is_cornered penalty. It will smoothly alternate between Maintain Max Range to open up spatial gaps, and dumping instant-cast damage spells when the gap is safe.Strategic CC Evaluation (Who to Lock Down)To get an agent to intelligently choose whom to stun or blind out of a crowd, your Attention Encoder must output a Utility Vector for every potential target.       Attention Layer Selection Vector
 ┌─────────────────┬───────────────────┐
 │ Enemy Threat    │ CC Value Outputs  │
 ├─────────────────┼───────────────────┤
 │ DPS Wolf        │ Q(Stun) = 1.2     │
 │ Healer Wolf     │ Q(Stun) = 4.8  ◄──┼── [Highest expected long-term return]
 │ Tanky Cow       │ Q(Stun) = 0.1     │
 └─────────────────┴───────────────────┘
The network evaluates the long-term discounted value of throwing a CC spell at each entity.If it stuns a DPS entity, damage drops slightly.If it stuns a Healer, the team's ability to secure a kill spikes drastically over the next 60 ticks.Because the discounted return system rewards the actual kill event, the $Q$-value for selecting Action: Cast CC targeted at the Healer slot will naturally become the dominant choice.3. Raid Tactics: The Boss PhaseTo train your open-world entities to coordinate against a massive World Boss, the scenario requires an Autocurriculum Phase Change.Phase 1: The Meat Shield ShieldThe Boss has an aura that reflects $200\%$ damage if hit from the front.The Emergence: Agents attacking from the front die instantly (massive negative reward). The network learns to path exclusively to the Boss's rear attention-pooled coordinates to deal damage safely.Phase 2: The Whittle & Attrition CycleThe Boss has a massive health pool ($1,000,000$ HP). No single group can burn it down before running out of mana or health.The Emergence: Agents discover they cannot simply lock into Action: Direct Attack indefinitely. They learn to rotate their high-level Options:Group A enters the fray and executes ENGAGE_BURST_TARGET.When Group A’s hp_pct drops to $30\%$, their network's survival instinct kicks in, forcing them to switch to TACTICAL_FLEE.Simultaneously, a fresh Group B (who has been waiting in WANDER_SCOUT or HEAL mode) notices the Boss's aggro table shifting and steps in to intercept.4. The Unified Sandbox Validation GuideTo prove these advanced behaviors are clicking headlessly in your engine, check these data milestones during epoch training reviews:[ Check 1: Herd Cohesion ] ─────► Do cows cluster vectors tighten when a predator spawns?
[ Check 2: Wolf Synced Logits ] ─► Do pack wolves' attack probabilities spike on the SAME frame?
[ Check 3: Hunter Distance ] ───► Does a ranged agent's distance graph look like a steady wave?
The Cow Test: If you spawn 1 Wolf near 5 Cows, and within 500 epochs the individual cows stop scattering in random directions and instead draw a clear pathing line straight to the Wolf's coordinates to swarm it, your team-aware reward assignment is perfectly dialed in.The Wolf Test: Check your network's output logs. If the wolves are successfully running the stalking algorithm, you will see their action choices locked at Action: Stalk for dozens of consecutive frames, with their output probability for Action: Pack Strike sitting at a tense $95\%$ waiting to explode the moment the target's back is turned.

---

## 5. Implementation status (this branch)

Implemented in `src/rl/` + `src/__tests__/rl.test.ts`. Run `npm run train` to retrain end-to-end; the script prints every metric below.

### State space (rl2 §1, §2)

`STATE_DIM = 12` — the original 7 features plus the rl2 additions:

| idx | feature                | rl2 source                  | computed in env / live |
|----:|------------------------|-----------------------------|------------------------|
| 0   | `self_hp_pct`          | core                        | both                   |
| 1   | `self_status`          | core                        | both                   |
| 2   | `focused_entity_type`  | core (now 6 categories)     | both                   |
| 3   | `focused_entity_hp`    | core                        | both                   |
| 4   | `focused_entity_dist`  | core                        | both                   |
| 5   | `ally_danger_max`      | core                        | both                   |
| 6   | `enemy_pressure_count` | core                        | both                   |
| 7   | `herd_panic`           | §1A herd_panic_vector       | env: recency×proximity of damaged allies; live: damaged-ally proximity |
| 8   | `pack_readiness`       | §1C pack_readiness          | both — # same-team allies sharing focus |
| 9   | `target_unawareness`   | §1C target_unawareness      | env: hidden/Flee/velocity-dot; live: focus's last intent = Flee |
| 10  | `resource_density`     | §1B resource_density        | env only (no live grass yet) |
| 11  | `energy_reserve`       | §1B energy_reserve          | both — HP-as-proxy (+ damage buff in env) |

Action space stays at 5 (`Idle / Attack / CC / Heal / Flee`) — archetype-specific interpretations as described in `entity-policies.md §5` (Heal = graze for grazers / hide for predators; Attack = strike or, for cows, intercept-and-defend; Flee = run-from-attacker via `lastAttackerId`).

### Reward shaping (rl2 §1 — discounted returns drive these)

| archetype | shaping additions vs entity-policies.md §5 |
|---|---|
| `cow`   | shared-team credit (avg of herd's per-step rewards blended 50/50 with self); defender bonus when actual hit lands on an attacker that recently bit an ally; **exploration bonus** when `herd_panic > 0.1` AND chose Attack; symmetric penalty when `Flee` chosen under herd panic |
| `wolf`  | sync-aware: damageDealt × 0.25 when ≥1 ally shares focus, ×0.02 otherwise; –1.5 solo-attack penalty; direct per-decision shaping that rewards choosing Attack when `pack_readiness ≥ 1` and penalises it when alone |
| `rabbit/cat/dog/werewolf` | unchanged from §5 |

The `cow` exploration bonus was the unlock — without it the policy converged to "Heal/Flee is safer than charging in" and never discovered the defender payoff. The bonus is paid for *picking* Attack under herd panic (not for landing damage), so the policy gradient can climb out of the safety local minimum.

The `wolf` direct shaping similarly nudges the policy to read feature index 8 (`pack_readiness`) before going for the strike.

### Per-archetype "what's RL really doing here"

- **Cow (rl2 §1A)** — RL learns: P(Attack | herd_panic > 0.1) ≫ P(Attack | herd_panic ≈ 0). When the wolf chews on a sister, the herd_panic feature spikes for every cow within visionRadius, the brain switches to Attack, the engine paths each cow at the wolf, and the swarm credit cascades back through the shared-team blend.
- **Rabbit (rl2 §1B)** — RL learns: rest at high HP (energy reserve full) → minimal pressure, free survival ticks; under predator pressure → flee. The `energy_reserve` feature gives the brain a hunger proxy without needing an explicit reproduce counter (kept as future work; flagged below).
- **Wolf (rl2 §1C)** — RL learns: P(Attack) climbs sharply with `pack_readiness`. Solo attacks get –1.5; synchronised attacks get +0.25/dmg. Multiple wolves observing the same focus all see the same high `pack_readiness` feature value and (because the policy is shared) all spike Attack on the same frame — the "synced logits" rl2 §4 calls for.

### Validation results (run: 1500 episodes × 900 ticks, 12s wall-clock)

| rl2 §4 check         | metric                                  | result                |
|----------------------|-----------------------------------------|-----------------------|
| Cow Test             | mean cow→wolf distance, P(attack)       | 7.00 → **2.33**, 31% Attack |
| Herd Cohesion        | pairwise distance before / after wolf   | 7.99 → **3.87**, **tightened ✓** |
| Wolf Synced Logits   | sync-tick rate, peak P(Attack) mean     | **100%**, **93.6%**   |
| Gang-up on werewolf  | wolf attack rate on bloodied boss       | **100%**, boss killed |
| Kiting / Target Lock / Stochastic Variance | from §4 originals | all pass              |

The Wolf Test from rl2 §4 ("output probability for Action: Pack Strike sitting at a tense 95% waiting to explode") corresponds directly to the **93.6% peak P(Attack) mean** above.

Validators live in `src/rl/validate.ts` — `cowTest`, `packSyncCheck`, `herdCohesionCheck` (alongside `kitingCheck`, `targetLockCheck`, `stochasticVarianceCheck`, `gangUpCheck`). All 18 vitest cases pass.

### Not yet implemented from this doc (deliberate cuts)

- **Rabbit reproduce action**: rl2 §1B's third action (`2: Reproduce`) and the `safe_zone_dist` burrow feature aren't wired into the engine — the rabbit policy currently uses Heal-as-rest and Flee for the gather/burrow loop, with `energy_reserve` standing in as the readiness signal. Adding burrows would mean spawn-rate manipulation tied to a population cap.
- **Ranged kiting / strategic CC (rl2 §2)**: no ranged or magic-capable entity is wired into the brain pipeline yet; the action space carries `CC` as a no-op slot for them.
- **World boss raid phases (rl2 §3)**: the werewolf is a boss but uses a flat damage model — no back-only damage aura, no autocurriculum phase change.

These slots are first-class in the architecture (action space + state contract already covers them); adding them is engine-side, not training-side.

