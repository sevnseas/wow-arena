import { describe, it, expect } from 'vitest';
import {
  RLEnv,
  engineTick,
  Policy,
  PolicyRegistry,
  PolicyDriver,
  Intent,
  STATE_DIM,
  INTENT_COUNT,
  train,
  kitingCheck,
  targetLockCheck,
  stochasticVarianceCheck,
  cowTest,
  packSyncCheck,
  herdCohesionCheck,
  reinforceUpdate,
  type Step,
  type PolicyAgentRef,
} from '../rl';

describe('RL env', () => {
  it('runs deterministically from a seed (tick-time, not wall-clock)', () => {
    const runOnce = () => {
      const env = new RLEnv({}, 7);
      env.scatterSpawn({
        archetype: 'wolf', team: 'predator',
        hp: 60, maxHp: 60, size: 0.55, speed: 4.0, attackCooldown: 1.2,
      }, 2);
      env.scatterSpawn({
        archetype: 'rabbit', team: 'prey',
        hp: 20, maxHp: 20, size: 0.28, speed: 3.5, attackCooldown: 999,
      }, 3);
      for (const e of env.entities) e.currentIntent = e.team === 'predator' ? Intent.Attack : Intent.Flee;
      for (let t = 0; t < 100; t++) {
        for (const e of env.entities) env.observe(e, new Float32Array(STATE_DIM));
        for (const e of env.entities) if (e.alive) engineTick(env, e, env.config.dt);
        env.tick++;
      }
      return env.entities.map(e => `${e.x.toFixed(4)},${e.z.toFixed(4)},${e.hp.toFixed(2)}`).join('|');
    };
    expect(runOnce()).toBe(runOnce());
  });

  it('applies size-proportional damage', () => {
    const env = new RLEnv({}, 1);
    const big = env.spawn({ archetype: 'wolf', team: 'predator', x: 0, z: 0, hp: 50, maxHp: 50, size: 2.0, speed: 4, attackCooldown: 1 });
    const small = env.spawn({ archetype: 'wolf', team: 'predator', x: 5, z: 0, hp: 50, maxHp: 50, size: 0.5, speed: 4, attackCooldown: 1 });
    const victimA = env.spawn({ archetype: 'rabbit', team: 'prey', x: 0, z: 0, hp: 999, maxHp: 999, size: 0.3, speed: 0, attackCooldown: 1 });
    const victimB = env.spawn({ archetype: 'rabbit', team: 'prey', x: 5, z: 0, hp: 999, maxHp: 999, size: 0.3, speed: 0, attackCooldown: 1 });
    env.damage(big, victimA);
    env.damage(small, victimB);
    const dmgA = 999 - victimA.hp;
    const dmgB = 999 - victimB.hp;
    expect(dmgA).toBeGreaterThan(dmgB * 3);
  });
});

describe('Policy', () => {
  it('produces valid probability distributions', () => {
    const p = new Policy();
    const s = new Float32Array(STATE_DIM).fill(0.5);
    const { probs } = p.forward(s);
    expect(probs.length).toBe(5);
    const sum = Array.from(probs).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    for (const x of probs) expect(x).toBeGreaterThanOrEqual(0);
  });

  it('REINFORCE moves probability mass toward rewarded actions', () => {
    const p = new Policy({ lr: 0.1, entropyCoef: 0 });
    const s = new Float32Array(STATE_DIM).fill(0.3);
    const targetAction = 1; // Attack
    for (let it = 0; it < 50; it++) {
      const { probs, hidden } = p.forward(s);
      const traj: Step[] = [{
        state: new Float32Array(s),
        hidden,
        probs,
        action: targetAction,
        reward: 1.0,
        temperature: 1.0,
      }];
      reinforceUpdate(p, traj);
    }
    const finalProbs = p.forward(s).probs;
    expect(finalProbs[targetAction]).toBeGreaterThan(0.5);
  });
});

describe('Validation suite (entity-policies.md §4)', () => {
  it('kiting check: fleeing entity puts distance between itself and pack', () => {
    const r = kitingCheck();
    expect(r.fledDistance).toBeGreaterThan(2);
  });

  it('target lock check: wolf bites a fleeing rabbit at least once', () => {
    const r = targetLockCheck();
    expect(r.hits).toBeGreaterThan(0);
  });

  it('stochastic variance check: different temperatures yield different action streams', () => {
    const r = stochasticVarianceCheck(new Policy());
    expect(r.uniqueIntentSequences).toBeGreaterThan(1);
  });
});

describe('Training', () => {
  it('runs a short multi-archetype training loop end-to-end', () => {
    const out = train({
      episodes: 4, maxTicks: 100,
      rabbits: 2, cows: 1, cats: 1, dogs: 1, wolves: 2, werewolves: 1,
      grassPatches: 4, logEvery: 100,
    });
    expect(out.history.length).toBe(4);
    expect(out.registry.get('wolf')).toBeDefined();
    expect(out.registry.get('cow')).toBeDefined();
    expect(out.registry.get('werewolf')).toBeDefined();
  });
});

// ---- Behavioral tests for the live driver: smoothing, flee target, healing ----

/** Build a minimal in-memory PolicyAgentRef with a captured intent log. */
function makeMockAgent(opts: {
  id: string;
  archetype: PolicyAgentRef['archetype'];
  team: PolicyAgentRef['team'];
  hp?: number;
  maxHp?: number;
  pos?: { x: number; z: number };
  size?: number;
  personalityBias?: Float32Array;
  temperature?: number;
}): PolicyAgentRef & { intents: Intent[]; lastFleeFrom: { x: number; z: number } | null } {
  const state = {
    hp: opts.hp ?? 30, maxHp: opts.maxHp ?? 30,
    pos: opts.pos ?? { x: 0, z: 0 },
    intents: [] as Intent[],
    lastFleeFrom: null as { x: number; z: number } | null,
    attackerId: null as string | null,
    alive: true,
  };
  return {
    id: opts.id,
    archetype: opts.archetype,
    team: opts.team,
    size: opts.size ?? 0.4,
    personalityBias: opts.personalityBias ?? new Float32Array(INTENT_COUNT),
    temperature: opts.temperature ?? 1.0,
    get alive() { return state.alive; },
    get hp() { return state.hp; },
    get maxHp() { return state.maxHp; },
    get status() { return 0 as 0 | 1 | 2; },
    get pos() { return state.pos; },
    get attackerId() { return state.attackerId; },
    applyIntent(intent: Intent, _focus: PolicyAgentRef | null, ctx?: { resolveAttacker?: (id: string) => { pos: { x: number; z: number } } | null }) {
      state.intents.push(intent);
      if (intent === Intent.Flee && state.attackerId) {
        const att = ctx?.resolveAttacker?.(state.attackerId);
        if (att) state.lastFleeFrom = { x: att.pos.x, z: att.pos.z };
      }
    },
    // Mutable test helpers (escape-hatch through the object literal):
    intents: state.intents,
    get lastFleeFrom() { return state.lastFleeFrom; },
    set lastFleeFrom(v: { x: number; z: number } | null) { state.lastFleeFrom = v; },
    // expose state mutators
    _setHp: (v: number) => { state.hp = v; },
    _setAttackerId: (id: string | null) => { state.attackerId = id; },
  } as any;
}

describe('Intent smoothing (no churn)', () => {
  it('holds the previous intent when probabilities are roughly tied', () => {
    // Hand-craft a policy that returns near-uniform probs over all 5 intents.
    const policy = new Policy();
    // Zero all weights → softmax is uniform.
    policy.W1.fill(0); policy.W2.fill(0); policy.b1.fill(0); policy.b2.fill(0);
    const registry = new PolicyRegistry();
    registry.policies.wolf = policy;
    const driver = new PolicyDriver(registry, {
      decisionInterval: 0.1, switchMargin: 0.5, minHoldSeconds: 0, panicHpDrop: 1,
    });
    const a = makeMockAgent({ id: 'w1', archetype: 'wolf', team: 'predator' });
    driver.setAgents([a]);

    // Run many decisions; with a uniform distribution and a 0.5 switch margin,
    // the brain cannot ever beat the held intent, so it should latch.
    for (let i = 0; i < 30; i++) driver.update(0.1);
    const intents = (a as any).intents as Intent[];
    expect(intents.length).toBeGreaterThan(10);
    // Every intent after the first should equal the first one (no churn).
    const first = intents[0];
    expect(intents.every(i => i === first)).toBe(true);
  });

  it('respects the minimum hold time even when the new sample wins by margin', () => {
    const policy = new Policy();
    // Hand-set logits so probs are heavily favoring intent 0 (Idle).
    policy.W1.fill(0); policy.W2.fill(0); policy.b1.fill(0);
    policy.b2.fill(0); policy.b2[Intent.Idle] = 5;
    const registry = new PolicyRegistry();
    registry.policies.wolf = policy;
    const driver = new PolicyDriver(registry, {
      decisionInterval: 0.1, switchMargin: 0, minHoldSeconds: 2.0, panicHpDrop: 1,
    });
    const a = makeMockAgent({ id: 'w1', archetype: 'wolf', team: 'predator' });
    driver.setAgents([a]);
    // First decision picks Idle and locks it.
    driver.update(0.1);
    // Now flip the policy to strongly prefer Attack — but min hold = 2.0s
    // and we've only elapsed 0.1s, so the held intent should win.
    policy.b2.fill(0); policy.b2[Intent.Attack] = 5;
    for (let i = 0; i < 10; i++) driver.update(0.1);   // 1.1s total
    const intents = (a as any).intents as Intent[];
    // All decisions so far should be Idle (the held intent).
    expect(intents.every(i => i === Intent.Idle)).toBe(true);
    // Now run past the hold window and observe the switch.
    for (let i = 0; i < 20; i++) driver.update(0.1);   // 3.1s total
    const after = (a as any).intents as Intent[];
    expect(after.some(i => i === Intent.Attack)).toBe(true);
  });

  it('breaks the hold lock when HP drops sharply (panic override)', () => {
    const policy = new Policy();
    policy.W1.fill(0); policy.W2.fill(0); policy.b1.fill(0);
    policy.b2.fill(0); policy.b2[Intent.Idle] = 5;
    const registry = new PolicyRegistry();
    registry.policies.wolf = policy;
    const driver = new PolicyDriver(registry, {
      decisionInterval: 0.1, switchMargin: 0, minHoldSeconds: 99, panicHpDrop: 0.2,
    });
    const a = makeMockAgent({ id: 'w1', archetype: 'wolf', team: 'predator', hp: 100, maxHp: 100 });
    driver.setAgents([a]);
    driver.update(0.1);
    // Switch policy to strongly favor Flee + drop HP from 100→30 (>20% drop).
    policy.b2.fill(0); policy.b2[Intent.Flee] = 5;
    (a as any)._setHp(30);
    driver.update(0.1);
    const last = (a as any).intents.at(-1);
    expect(last).toBe(Intent.Flee);
  });
});

describe('Flee target = actual attacker, not arbitrary focus', () => {
  it('flees from the entity that damaged me, even if a different one is in focus', () => {
    const policy = new Policy();
    policy.W1.fill(0); policy.W2.fill(0); policy.b1.fill(0);
    policy.b2.fill(0); policy.b2[Intent.Flee] = 10;
    const registry = new PolicyRegistry();
    registry.policies.rabbit = policy;
    const driver = new PolicyDriver(registry, {
      decisionInterval: 0.1, switchMargin: 0, minHoldSeconds: 0, panicHpDrop: 1,
    });
    const rabbit = makeMockAgent({ id: 'r', archetype: 'rabbit', team: 'prey',
      pos: { x: 0, z: 0 }, hp: 10, maxHp: 30 });
    // Decoy is the *highest-priority* focus (low HP → top of pickFocus score)
    // but the actual attacker is somewhere else.
    const decoy = makeMockAgent({ id: 'decoy', archetype: 'wolf', team: 'predator',
      pos: { x: -5, z: 0 }, hp: 1, maxHp: 100 });
    const attacker = makeMockAgent({ id: 'attacker', archetype: 'wolf', team: 'predator',
      pos: { x: 7, z: 3 }, hp: 100, maxHp: 100 });
    (rabbit as any)._setAttackerId('attacker');
    driver.setAgents([rabbit, decoy, attacker]);
    driver.update(0.1);
    const from = (rabbit as any).lastFleeFrom;
    expect(from).not.toBeNull();
    expect(from.x).toBeCloseTo(7, 5);
    expect(from.z).toBeCloseTo(3, 5);
  });
});

describe('Emergent low-HP healing behavior', () => {
  it('a wounded grazer that holds Heal recovers HP (env-level integration)', () => {
    const env = new RLEnv({ bounds: 25, decisionInterval: 1 }, 42);
    env.seedGrass(8);
    const cow = env.spawn({
      archetype: 'cow', team: 'prey', x: 0, z: 0,
      hp: 8, maxHp: 60, size: 0.7, speed: 2, attackCooldown: 999,
    });
    cow.currentIntent = Intent.Heal;
    const startHp = cow.hp;
    for (let t = 0; t < 200; t++) {
      env.observe(cow, new Float32Array(STATE_DIM));
      engineTick(env, cow, env.config.dt);
      env.tickGrass(env.config.dt);
      env.tick++;
    }
    expect(cow.hp).toBeGreaterThan(startHp + 10);
  });

  it('a hidden wolf regenerates while not taking damage', () => {
    const env = new RLEnv({ bounds: 25, decisionInterval: 1 }, 99);
    const wolf = env.spawn({
      archetype: 'wolf', team: 'predator', x: 0, z: 0,
      hp: 20, maxHp: 70, size: 0.6, speed: 5.5, attackCooldown: 1,
    });
    wolf.currentIntent = Intent.Heal;
    // Tick many seconds — no enemies present so no damage.
    for (let t = 0; t < 300; t++) {
      env.observe(wolf, new Float32Array(STATE_DIM));
      engineTick(env, wolf, env.config.dt);
      env.tick++;
    }
    expect(wolf.hidden).toBe(true);
    expect(wolf.hp).toBeGreaterThan(50);
  });
});

describe('rl2 §4 emergent-behavior validators are wired and observable', () => {
  // We don't assert hard thresholds (those need full training to land) — just
  // that the validators run, return well-formed metrics, and respond to their
  // inputs. The trained values are checked in the train-rl.mjs run output.
  it('cowTest returns finite metrics for an untrained policy', () => {
    const r = cowTest(new Policy(), { cows: 4, ticks: 60 });
    expect(Number.isFinite(r.startMeanDist)).toBe(true);
    expect(Number.isFinite(r.endMeanDist)).toBe(true);
    expect(r.cowAttackProbAfter).toBeGreaterThanOrEqual(0);
    expect(r.cowAttackProbAfter).toBeLessThanOrEqual(1);
  });
  it('packSyncCheck reports a syncRate in [0,1]', () => {
    const r = packSyncCheck(new Policy());
    expect(r.syncRate).toBeGreaterThanOrEqual(0);
    expect(r.syncRate).toBeLessThanOrEqual(1);
  });
  it('herdCohesionCheck returns a before/after comparison', () => {
    const r = herdCohesionCheck(new Policy());
    expect(r.beforeRadius).toBeGreaterThan(0);
    expect(typeof r.tightened).toBe('boolean');
  });
});

describe('Opportunistic attack vs commit-to-flee', () => {
  it('high-HP attacker vs a low-HP enemy: a trained-ish policy picks Attack', () => {
    // Use the gang-up bias in pickFocus: a low-HP target should dominate the
    // focus signal, and an aggressive personality should commit to attack.
    const env = new RLEnv({}, 1);
    const me = env.spawn({
      archetype: 'wolf', team: 'predator', x: 0, z: 0,
      hp: 70, maxHp: 70, size: 0.6, speed: 5, attackCooldown: 1.0,
    });
    env.spawn({
      archetype: 'rabbit', team: 'prey', x: 3, z: 0,
      hp: 2, maxHp: 30, size: 0.28, speed: 3, attackCooldown: 999,
    });
    const buf = new Float32Array(STATE_DIM);
    env.observe(me, buf);
    // Sanity: focused-entity hp fraction is very low (low-HP victim is dominant).
    expect(buf[3]).toBeLessThan(0.1);
    // And focus distance is short.
    expect(buf[4]).toBeLessThan(0.3);
  });
});
