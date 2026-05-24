/**
 * Task 1 acceptance tests for the ecosystem extensions in env4
 * (grass, age, starvation, Interact reproduction). See ecosystem.md.
 */
import { describe, it, expect } from 'vitest';
import { createEnv4, spawn4, spawnGrass, step4, act4, clearEcosystemEvents, observe4, computeReward4 } from '../rl/env4';
import { Action, MAX_ENTITIES_RL4, FEATURES_PER_ENTITY_RL4 } from '../rl/types';

function rabbit(env: any, x: number, z: number, opts: any = {}) {
  return spawn4(env, {
    archetype: 'rabbit', team: 'prey',
    x, z, hp: 30, maxHp: 30, size: 0.28, speed: 2.6,
    attackCooldown: 1.0,
    maxAge: opts.maxAge ?? 60, starveRate: opts.starveRate ?? 0,
  });
}

function wolf(env: any, x: number, z: number, opts: any = {}) {
  return spawn4(env, {
    archetype: 'wolf', team: 'predator',
    x, z, hp: 60, maxHp: 60, size: 0.5, speed: 4,
    attackCooldown: 0.4,
    maxAge: opts.maxAge ?? 120, starveRate: opts.starveRate ?? 0,
  });
}

describe('env4 ecosystem: grass + grazing', () => {
  it('rabbit standing on grass gains hp + grassEaten over time', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0);
    spawnGrass(env, 0, 0);
    r.hp = 10; // start hungry so heal cap doesn't clip
    for (let i = 0; i < 20; i++) step4(env, 0.1); // 2s
    expect(r.grassEaten).toBeGreaterThan(0.5);
    expect(r.hp).toBeGreaterThan(10);
  });

  it('depleted grass regrows', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0);
    const g = spawnGrass(env, 0, 0);
    expect(g.regrowTimer).toBe(0);
    r.hp = 10;
    // Eat all of it.
    for (let i = 0; i < 100; i++) step4(env, 0.1);
    expect(g.nutrition).toBeLessThan(0.05);
    expect(g.regrowTimer).toBe(0);
    // Move rabbit away so it can't keep eating.
    r.x = 10; r.z = 10;
    step4(env, 0.1);
    expect(g.regrowTimer).toBeGreaterThan(0);
    for (let i = 0; i < 249; i++) step4(env, 0.1); // 25s total
    expect(g.nutrition).toBeGreaterThan(0.5);
  });

  it('emits grazed events with entity id', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0);
    spawnGrass(env, 0, 0);
    step4(env, 0.1);
    const grazed = env.events.filter(e => e.type === 'grazed');
    expect(grazed.length).toBeGreaterThan(0);
    expect((grazed[0] as any).entityId).toBe(r.id);
  });
});

describe('env4 ecosystem: age + starvation', () => {
  it('entity dies of age past maxAge', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0, { maxAge: 1 });
    for (let i = 0; i < 15; i++) step4(env, 0.1); // 1.5s > 1s
    expect(r.alive).toBe(false);
    const dieEv = env.events.find(e => e.type === 'died' && (e as any).entityId === r.id);
    expect(dieEv).toBeTruthy();
    expect((dieEv as any).cause).toBe('age');
  });

  it('entity starves to death without food', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0, { starveRate: 5 });
    expect(r.hp).toBe(30);
    // 30 hp / 5 hp/s = 6s drain.
    for (let i = 0; i < 80; i++) step4(env, 0.1); // 8s, ample
    expect(r.alive).toBe(false);
    const dieEv = env.events.find(e => e.type === 'died' && (e as any).entityId === r.id);
    expect((dieEv as any).cause).toBe('starvation');
  });

  it('starvation is offset by grazing', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0, { starveRate: 2 });
    spawnGrass(env, 0, 0);
    spawnGrass(env, 0.3, 0); // overlapping, ample food
    for (let i = 0; i < 80; i++) step4(env, 0.1); // 8s on food
    expect(r.alive).toBe(true);
    expect(r.hp).toBeGreaterThan(10);
  });
});

describe('env4 ecosystem: Interact reproduction', () => {
  it('rabbit Interact spawns newborn iff counter≥3 and partner in range', () => {
    const env = createEnv4({ bounds: 5 });
    const a = rabbit(env, 0, 0);
    const b = rabbit(env, 0.4, 0); // within interactRange 1.2m
    a.grassEaten = 3;
    b.grassEaten = 3;
    const beforeN = env.entities.length;
    act4(env, a, Action.Interact, 0.1);
    expect(env.entities.length).toBe(beforeN + 1);
    expect(a.grassEaten).toBe(0); // counter reset on both parents
    expect(b.grassEaten).toBe(0);
    const ev = env.events.find(e => e.type === 'born');
    expect(ev).toBeTruthy();
    expect((ev as any).archetype).toBe('rabbit');
  });

  it('Interact does nothing when counter is too low', () => {
    const env = createEnv4({ bounds: 5 });
    const a = rabbit(env, 0, 0);
    rabbit(env, 0.4, 0);
    a.grassEaten = 2; // below threshold of 3
    const beforeN = env.entities.length;
    act4(env, a, Action.Interact, 0.1);
    expect(env.entities.length).toBe(beforeN);
  });

  it('Interact does nothing without partner in range', () => {
    const env = createEnv4({ bounds: 10 });
    const a = rabbit(env, 0, 0);
    rabbit(env, 5, 5); // far away
    a.grassEaten = 3;
    const beforeN = env.entities.length;
    act4(env, a, Action.Interact, 0.1);
    expect(env.entities.length).toBe(beforeN);
    expect(a.grassEaten).toBe(3); // not reset since no spawn happened
  });

  it('wolf Interact requires preyEaten >= 1 and another wolf in range', () => {
    const env = createEnv4({ bounds: 5 });
    const a = wolf(env, 0, 0);
    const b = wolf(env, 0.6, 0);
    for (let i = 0; i < 8; i++) rabbit(env, 2 + i * 0.1, 0);
    a.preyEaten = 1;
    b.preyEaten = 0;
    const beforeN = env.entities.length;
    act4(env, a, Action.Interact, 0.1);
    expect(env.entities.length).toBe(beforeN + 1); // child spawned
    expect(a.preyEaten).toBe(0);
    expect(b.preyEaten).toBe(0);
  });

  it('wolf Interact is gated by available prey population', () => {
    const env = createEnv4({ bounds: 5 });
    const a = wolf(env, 0, 0);
    wolf(env, 0.6, 0);
    rabbit(env, 2, 0);
    a.preyEaten = 1;
    const beforeN = env.entities.length;
    act4(env, a, Action.Interact, 0.1);
    expect(env.entities.length).toBe(beforeN);
    expect(a.preyEaten).toBe(1);
  });

  it('wolf preyEaten increments on kill via collision damage', () => {
    const env = createEnv4({ bounds: 5 });
    const w = wolf(env, 0, 0);
    const r = rabbit(env, 0.3, 0); // in contact
    r.hp = 1; // one bite kills
    clearEcosystemEvents(env);
    for (let i = 0; i < 30; i++) step4(env, 0.1);
    expect(r.alive).toBe(false);
    expect(w.preyEaten).toBeGreaterThanOrEqual(1);
    const dieEv = env.events.find(e => e.type === 'died' && (e as any).entityId === r.id);
    expect((dieEv as any).cause).toBe('predator');
  });

  it('predator damages prey regardless of spawn order', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0);
    const w = wolf(env, 0.3, 0);
    r.hp = 1;
    clearEcosystemEvents(env);
    step4(env, 0.1);
    expect(r.alive).toBe(false);
    expect(w.alive).toBe(true);
    expect(w.preyEaten).toBe(1);
  });
});

describe('env4 ecosystem: observation self-state features', () => {
  const SELF_BASE = MAX_ENTITIES_RL4 * FEATURES_PER_ENTITY_RL4;
  it('encodes hp%, age%, counter%, nearest grass rel pos', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0, { maxAge: 100 });
    spawnGrass(env, 2, 0); // east of rabbit
    r.hp = 15; // 50% hp
    r.age = 25; // 25% age
    r.grassEaten = 1.5; // 50% of threshold 3

    const obs = observe4(env, r);
    expect(obs[SELF_BASE + 0]).toBeCloseTo(0.5, 2);    // hp%
    expect(obs[SELF_BASE + 1]).toBeCloseTo(0.25, 2);   // age%
    expect(obs[SELF_BASE + 2]).toBeCloseTo(0.5, 2);    // counter%
    expect(obs[SELF_BASE + 3]).toBeGreaterThan(0);     // nearest grass +x
    expect(obs[SELF_BASE + 4]).toBeCloseTo(0, 4);      // grass directly east → z=0
  });

  it('grass features are zero when no patches in vision', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0);
    const obs = observe4(env, r);
    expect(obs[SELF_BASE + 3]).toBe(0);
    expect(obs[SELF_BASE + 4]).toBe(0);
  });
});

describe('env4 ecosystem: reward shaping', () => {
  it('rabbit mode rewards grazing', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0);
    spawnGrass(env, 0, 0);
    r.hp = 10;
    (r as any).lastHp = r.hp;
    (r as any).rewardThisEpisode = 0;
    step4(env, 0.5); // grazing happens
    const rew = computeReward4(env, r as any, 'rabbit');
    expect(rew).toBeGreaterThan(0);
  });

  it('rabbit mode rewards reproduction', () => {
    const env = createEnv4({ bounds: 5 });
    const a = rabbit(env, 0, 0);
    const b = rabbit(env, 0.4, 0);
    a.grassEaten = 3; b.grassEaten = 3;
    (a as any).lastHp = a.hp; (a as any).rewardThisEpisode = 0;
    act4(env, a, Action.Interact, 0.1);
    const rew = computeReward4(env, a as any, 'rabbit');
    expect(rew).toBeGreaterThan(5); // +10 per birth easily dominates
  });

  it('rabbit mode penalizes death events', () => {
    const env = createEnv4({ bounds: 5 });
    const r = rabbit(env, 0, 0, { starveRate: 100 });
    r.hp = 1;
    (r as any).lastHp = r.hp; (r as any).rewardThisEpisode = 0;
    step4(env, 0.1);
    const rew = computeReward4(env, r as any, 'rabbit');
    expect(rew).toBeLessThan(-2);
  });

  it('wolf mode rewards reproduction', () => {
    const env = createEnv4({ bounds: 5 });
    const a = wolf(env, 0, 0);
    wolf(env, 0.6, 0);
    for (let i = 0; i < 8; i++) rabbit(env, 2 + i * 0.1, 0);
    a.preyEaten = 1;
    (a as any).lastHp = a.hp; (a as any).rewardThisEpisode = 0;
    act4(env, a, Action.Interact, 0.1);
    const rew = computeReward4(env, a as any, 'wolf');
    expect(rew).toBeGreaterThan(5);
  });

  it('fed wolf mode shapes toward same-species partner', () => {
    const env = createEnv4({ bounds: 8 });
    const a = wolf(env, 0, 0);
    const b = wolf(env, 3, 0);
    rabbit(env, 1, 0);
    a.preyEaten = 1;
    (a as any).lastHp = a.hp; (a as any).rewardThisEpisode = 0;
    (a as any).lastEnemyDist = 3.5;
    b.x = 2;
    const rew = computeReward4(env, a as any, 'wolf');
    expect(rew).toBeGreaterThan(0.5);
  });
});

describe('env4 ecosystem: clearEcosystemEvents', () => {
  it('events accumulate then clear on demand', () => {
    const env = createEnv4({ bounds: 5 });
    rabbit(env, 0, 0);
    spawnGrass(env, 0, 0);
    step4(env, 0.1);
    expect(env.events.length).toBeGreaterThan(0);
    clearEcosystemEvents(env);
    expect(env.events.length).toBe(0);
  });
});
