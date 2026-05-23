To scale this cleanly to an open world without drowning your neural networks in spatial navigation data, you can split the architecture into a Two-Tier System.By taking raycasting and pathfinding completely out of the AI's brain and handling them algorithmically, the neural network only has to make the high-level tactical decisions. It acts like an arena player calling out orders, while a standard game programming script handles the actual walking and steering.1. The High-Level, Raycast-Free Engine SplitInstead of giving the network directional movement controls (like "Move Up" or "Move Left"), you change the action space to Intentions. The network picks who or what to interact with, and how to interact. Your algorithmic game engine handles the rest.┌────────────────────────────────────────────────────────┐
│               TIER 1: THE NEURAL BRAIN                 │
│ Inputs: Dynamic entity context (HP, Roles, Distance)   │
│ Outputs: High-Level Intentions (e.g., "Attack Healer")  │
└────────────────────────────────────────────────────────┘
                           │
                           ▼ [Intention Transmitted]
┌────────────────────────────────────────────────────────┐
│             TIER 2: THE ALGORITHMIC ENGINE             │
│ • Runs A* / NavMesh to execute pathing around walls.   │
│ • Handles physics, steering vectors, and collisions.   │
└────────────────────────────────────────────────────────┘
The New High-Level ActionsYour output array simplifies dramatically from spatial directions to Entity-Targeted Actions:0: Idle / Wander1: Execute Attack Protocol on Focused Entity2: Execute Crowd Control (CC) Protocol on Focused Entity3: Execute Heal Protocol on Focused Entity4: Execute Flee/Disengage Protocol (Engine paths away to safe range)If the brain selects Action 1 on a target behind a wall, your algorithmic engine automatically kicks in, calculates an A* path or NavMesh vector around the obstacle, and moves the character forward. The network never needs to "see" the wall; it only needs to know it chose to attack.2. Shared Policies with "Personality" RandomnessIn an open world, training an individual neural network for every single wolf or prey on the map is impossible. Instead, you use Shared Parameter Training (sharing one brain across an entire archetype) paired with Stochastic (Random) Sampling and Attribute Offsets.Shared Parameter TrainingYou only train a few distinct master policy networks:Werewolf_PolicyPredator_Wolf_PolicyPrey_Animal_PolicyEvery wolf spawned in the open world runs the exact same Predator_Wolf_Policy weights. This allows thousands of entities across the world to gather experiences simultaneously and feed them back into a single, massive open-world training pool.Adding "Personality" Without RetrainingTo make sure every wolf doesn't act like an identical hive-mind clone, you introduce two simple variations at runtime:Python# Execution of shared policy with individual agent variety
def determine_agent_action(agent, visible_entities):
    # 1. Gather high-level context (No spatial rays)
    state_vector = gather_high_level_context(agent, visible_entities)
    
    # 2. Network outputs raw preferences (logits)
    action_logits = shared_wolf_policy(state_vector)
    
    # 3. Add an individual "Personality Offset" directly to the choices
    # e.g., Aggressive wolves get a hardcoded boost to attack actions
    action_logits += agent.personality_bias 
    
    # 4. Use Stochastic Sampling (Temperature) instead of taking the absolute max
    # Higher temperature = more random, unpredictable actions
    probabilities = torch.softmax(action_logits / agent.temperature, dim=-1)
    
    # Sample from the distribution
    chosen_action = torch.multinomial(probabilities, 1).item()
    return chosen_action
By giving one spawned wolf a personality_bias toward fleeing and a high temperature (making it erratic), and another wolf a bias toward attacking, they will behave completely differently in the open world despite using the exact same trained policy network.3. High-Level State Space Contract (Open World Version)Because we stripped out spatial raycasts, the input vector $S$ for each agent becomes incredibly small, lightweight, and fast to execute headlessly.Instead of tracking every coordinate, you use an Attention-Pooled Summary of the immediate vicinity:Vector IndexFeature NameTypeRangeDescription0self_hp_pctFloat$[0, 1]$Agent's health.1self_statusCategorical$0, 1, 2$$0=\text{Normal}$, $1=\text{Stunned}$, $2=\text{Blinded}$.2focused_entity_typeCategorical$0-3$What the attention layer is looking at.3focused_entity_hpFloat$[0, 1]$Health of that entity.4focused_entity_distFloat$[0, 1]$Algorithmic path-distance to that entity.5ally_danger_maxFloat$[0, 1]$Lowest HP pct found among nearby allies.6enemy_pressure_countInteger$0-10$How many hostiles are currently attacking self.4. The First Version Sanity Check (Open World)To verify this high-level, algorithmic-assisted framework is working before deploying it across a sprawling open world, use this simple Three-Step Validation Test:The "Kiting" Check: Spawn a Werewolf and a Pack of Wolves. If the Werewolf's HP drops low and it selects Action: Flee, verify that the algorithmic pathfinder takes over and successfully guides it smoothly away from the pack. The network should get a reward for survival time without getting stuck on corners.The "Target Lock" Check: Verify that when a wolf selects Action: Attack Protocol on a moving prey, the engine successfully manages the chase vectors. The policy gradient should show a steady increase in rewards for damage dealt, proving the high-level brain is correctly steering the low-level engine.The "Stochastic Variance" Check: Spawn three wolves using the same brain weights but different random temperatures. If one immediately engages, one lingers, and one takes a wider approach flank, your personality layer is successfully preventing hive-mind synchronization.

---

## 5. What's actually trained, and what isn't

Implemented in `src/rl/` and trained by `npm run train`.

### Trainable parameters (RL touches these)

Per archetype (`wolf`, `rabbit`, `cow`, `cat`, `dog`, `werewolf`) there is exactly **one** small MLP — the Tier-1 brain — and only its weights change during training:

```
state(7) → Linear+tanh → hidden(24) → Linear → logits(5)   // policy.ts
                  W1, b1                    W2, b2
```

That's the entire learnable surface: `W1` (7×24), `b1` (24), `W2` (24×5), `b2` (5) — about **350 parameters per archetype**, ~2.1k across all six. Stored as JSON in `public/policies/<archetype>.json`.

### Fixed at runtime, not trained

These are **inputs to the forward pass**, not parameters:

- **`personalityBias`** — per-entity Float32Array(5) added to logits at decision time. Sampled randomly when the wolf/cow/etc spawns; never updated.
- **`temperature`** — per-entity scalar dividing the logits before softmax. Same: random per spawn, frozen.
- **Tier-2 engine** (`engine.ts`) — pathing, attack range, flee vector, grass contact, hide regen. Pure code; the network never sees walls or velocities.

The personality + temperature give the *pack* its variance using *one* set of weights. Two wolves with identical brains behave differently because their bias+temp differ. The RL never tries to optimize personality — it optimizes the *baseline* policy on top of which personalities perturb.

### Fitness function — discounted returns + EMA baseline

In `policy.ts → reinforceUpdate`:

1. Per agent, per decision tick, we record a tuple `(state, hidden, probs, action, reward)`.
2. At episode end we compute **returns-to-go** with discount `γ = 0.97`:

   ```
   G_t = r_t + γ·r_{t+1} + γ²·r_{t+2} + …
   ```

3. The baseline is an **EMA of mean episode return** per policy: `baseline ← 0.95·baseline + 0.05·mean(G)`. This is the only state that survives between episodes besides the weights.
4. Advantages `A_t = G_t − baseline`, then z-normalized across the batch for stability.
5. REINFORCE gradient on each logit:

   ```
   ∂L/∂logit_k = -(1{k = a_t} - π_k) · A_t / temperature   +   entropy_coef · π_k · (log π_k + H)
   ```

   Plain SGD update with `lr = 0.01`, no momentum. Entropy bonus (`0.01`) keeps the distribution from collapsing to a single deterministic action.

The reward `r_t` itself is **archetype-specific shaping** in `train.ts → shapedReward`:

| archetype | drivers (positive) | drivers (negative) |
|---|---|---|
| rabbit / cow | survival ticks, HP healed by grazing, accumulated `damageBuff` | damage taken, death |
| cat | rabbit kills (scaled by victim toughness), damage dealt | damage taken, death |
| dog | damage to predators near herd, kill bonus | damage taken |
| wolf | damage dealt, kills, HP regen while hidden | damage taken (small), death |
| werewolf | big damage bonus, big kill bonus (scaled by target HP) | death (big), damage taken (tiny) |

Combined with the `pickFocus` low-HP bias, those rewards are what produce the emergent gang-up on a bloodied werewolf — wolves *learn* that piling on a low-HP enemy is high return.

### How an epoch actually runs

`train.ts → runEpisode` runs **one shared world** per episode containing *every* archetype together:

```
for each episode in 0…N:
    env = RLEnv(seed = base + episode)
    seed grass patches
    spawn rabbits, cows, cats, dogs, wolves, 1 werewolf
    tracks = [ {entity, policy = registry.get(entity.archetype), steps: []} ]

    for tick in 0…maxTicks:
        if decision_tick:
            for each living agent:
                step.reward += shapedReward(...)        # close prior step
                state = env.observe(agent)
                probs = agent.policy.forward(state, agent.personalityBias, agent.temperature)
                action = sample(probs)                  # the Intent
                agent.entity.currentIntent = action
                steps.append({state, hidden, probs, action, reward = 0})
        else:
            for each living agent:
                step.reward += shapedReward(...)        # keep accumulating

        for each living entity:
            engineTick(env, e, dt)                      # Tier 2 executes intent
        env.tickGrass(dt)

    # Episode-end update — one batch per archetype, all on the same world.
    for archetype in ARCHETYPES:
        batch = concat(track.steps for track if track.entity.archetype == archetype)
        reinforceUpdate(registry.get(archetype), batch)   # updates W1, b1, W2, b2 in place
        # `baseline` on each Policy also updates here.
```

**Three properties to note:**

1. **Concurrent multi-agent rollouts.** Every wolf, cow, cat, etc in the world is acting *at the same time* in the same simulation. Their interactions shape each other's rewards — wolves learn against the actual cows being trained, not a static target. (This is what enables emergence: the gang-up wasn't programmed; it falls out of training wolves against a werewolf that is itself learning to bite back.)

2. **Per-archetype shared parameters.** All N rabbits' steps land in *one* batch and update *one* policy. With N=6 rabbits × ~180 decisions/episode = ~1k samples per archetype per episode — far more data than one-brain-per-rabbit would give us, and the basis for the doc's "open world / thousands of agents" claim in §2.

3. **Weights persist across epochs.** `registry` is constructed once before the training loop. Each `reinforceUpdate` mutates `W1, b1, W2, b2, baseline` in place. The next episode's `Policy.forward` reads the just-updated values — so each archetype's pack steadily climbs from random behavior to the shaped reward. After training, those mutated weights are written to `public/policies/<archetype>.json` and loaded into the live browser game via `loadPolicyRegistry`.

There is no replay buffer, no value network, no target network — REINFORCE with an EMA baseline is intentionally the simplest thing that produces the validation behaviors. Swapping it for PPO would just replace the body of `reinforceUpdate`; the brain/engine split (§1) and the state/action contract (§3) wouldn't change.

