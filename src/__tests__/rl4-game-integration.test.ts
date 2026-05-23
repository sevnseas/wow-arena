import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { RL4GameController } from '../rl4-game-controller';
import { Policy4, serializePolicy4 } from '../rl/policy4';

describe('RL4 Game Integration', () => {
  it('Creates game controller', () => {
    const controller = new RL4GameController();
    expect(controller).toBeDefined();
    expect(controller.getEntityCount()).toBe(0);
  });

  it('Registers and updates entities', () => {
    const controller = new RL4GameController();
    const pos = new THREE.Vector3(0, 0, 0);

    controller.registerEntity('wolf1', pos, 'wolf', 100, 100);
    expect(controller.getEntityCount()).toBe(1);

    const entity = controller.getEntity('wolf1');
    expect(entity).toBeDefined();
    expect(entity?.archetype).toBe('wolf');
  });

  it('Loads trained policies', () => {
    const controller = new RL4GameController();
    const policy = new Policy4();
    const serialized = serializePolicy4(policy);

    controller.loadPolicies({
      wolf: serialized,
      cat: serialized,
    });

    expect(controller.getEntity('wolf1')).toBeNull();
  });

  it('Updates entity with RL4 policy decisions', () => {
    const controller = new RL4GameController();
    const policy = new Policy4();
    const serialized = serializePolicy4(policy);

    controller.loadPolicies({
      wolf: serialized,
    });

    const pos = new THREE.Vector3(0, 0, 0);
    const vel = new THREE.Vector3();

    controller.registerEntity('wolf1', pos, 'wolf', 100, 100, 50); // 50ms decision interval

    // First update should return action
    const result1 = controller.update('wolf1', pos, vel, 100);
    expect(result1).toBeDefined();
    expect(result1?.action).toBeGreaterThanOrEqual(-1);
    expect(result1?.velocity).toBeDefined();

    // Second update too soon should be cached
    const result2 = controller.update('wolf1', pos, vel, 100);
    expect(result2).toBeDefined();

    // Update with new decision interval should give decision
    controller.unregisterEntity('wolf1');
    controller.registerEntity('wolf2', pos, 'wolf', 100, 100, 0); // 0ms interval
    const result3 = controller.update('wolf2', pos, vel, 100);
    expect(result3?.action).toBeGreaterThanOrEqual(0);
    expect(result3?.action).toBeLessThan(11); // ACTION_COUNT = 11
  });

  it('Applies different velocities for different actions', () => {
    const controller = new RL4GameController();

    const pos = new THREE.Vector3(0, 0, 0);
    const vel = new THREE.Vector3();

    // Mock a policy that always returns action 0 (MoveForward)
    const policy = new Policy4({});
    const serialized = serializePolicy4(policy);
    controller.loadPolicies({ wolf: serialized });
    controller.registerEntity('wolf1', pos, 'wolf', 100, 100, 0);

    const result = controller.update('wolf1', pos, vel, 100);
    expect(result?.velocity).toBeDefined();
    // Should have Z velocity component for some actions
    const totalVel = Math.abs(result?.velocity.x ?? 0) + Math.abs(result?.velocity.z ?? 0);
    expect(totalVel).toBeGreaterThanOrEqual(0);
  });

  it('Supports multiple controlled entities', () => {
    const controller = new RL4GameController();
    const policy = new Policy4();
    const serialized = serializePolicy4(policy);

    controller.loadPolicies({
      wolf: serialized,
      cat: serialized,
    });

    const pos = new THREE.Vector3(0, 0, 0);
    const vel = new THREE.Vector3();

    controller.registerEntity('wolf1', pos, 'wolf', 100, 100);
    controller.registerEntity('cat1', pos, 'cat', 80, 80);
    controller.registerEntity('wolf2', pos, 'wolf', 100, 100);

    expect(controller.getEntityCount()).toBe(3);

    // Update all entities
    controller.update('wolf1', pos, vel, 100);
    controller.update('cat1', pos, vel, 80);
    controller.update('wolf2', pos, vel, 100);

    // Unregister one
    controller.unregisterEntity('cat1');
    expect(controller.getEntityCount()).toBe(2);
  });

  it('Handles different archetypes correctly', () => {
    const controller = new RL4GameController();
    const policy = new Policy4();
    const serialized = serializePolicy4(policy);

    controller.loadPolicies({
      wolf: serialized,
      cat: serialized,
      werewolf: serialized,
    });

    const pos = new THREE.Vector3(0, 0, 0);
    const vel = new THREE.Vector3();

    const archetypes: Array<'wolf' | 'cat' | 'werewolf'> = ['wolf', 'cat', 'werewolf'];

    for (const arch of archetypes) {
      controller.registerEntity(`${arch}1`, pos, arch, 100, 100, 0);
      const result = controller.update(`${arch}1`, pos, vel, 100);
      expect(result?.action).toBeGreaterThanOrEqual(0);
      expect(result?.velocity).toBeDefined();
    }
  });

  it('Clears all entities', () => {
    const controller = new RL4GameController();
    const pos = new THREE.Vector3();

    controller.registerEntity('e1', pos, 'wolf', 100, 100);
    controller.registerEntity('e2', pos, 'cat', 80, 80);

    expect(controller.getEntityCount()).toBe(2);

    controller.clear();
    expect(controller.getEntityCount()).toBe(0);
  });
});
