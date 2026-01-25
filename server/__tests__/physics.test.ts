import { describe, it, expect } from 'vitest';
import {
  vec3,
  vec3Add,
  vec3Sub,
  vec3Scale,
  vec3Length,
  vec3Normalize,
  vec3Distance,
  vec3DistanceXZ,
  applyMovement,
  yawToForward,
  updateProjectilePosition,
  checkProjectileHit,
  getPositionBehindTarget,
  getBlinkDestination,
  isPositionValid,
  findValidPositionNear,
  type EntityPhysicsState,
  type MoveInputData,
} from '../src/physics';
import { ARENA_BOUND, GROUND_Y, MOVE_SPEED, JUMP_FORCE, PILLAR_OFFSET } from '../../src/shared/physics';

describe('vec3 helpers', () => {
  it('creates vec3', () => {
    const v = vec3(1, 2, 3);
    expect(v).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('adds vec3', () => {
    const result = vec3Add(vec3(1, 2, 3), vec3(4, 5, 6));
    expect(result).toEqual({ x: 5, y: 7, z: 9 });
  });

  it('subtracts vec3', () => {
    const result = vec3Sub(vec3(5, 7, 9), vec3(1, 2, 3));
    expect(result).toEqual({ x: 4, y: 5, z: 6 });
  });

  it('scales vec3', () => {
    const result = vec3Scale(vec3(1, 2, 3), 2);
    expect(result).toEqual({ x: 2, y: 4, z: 6 });
  });

  it('calculates length', () => {
    const len = vec3Length(vec3(3, 4, 0));
    expect(len).toBe(5);
  });

  it('normalizes vec3', () => {
    const norm = vec3Normalize(vec3(3, 0, 4));
    expect(norm.x).toBeCloseTo(0.6);
    expect(norm.y).toBe(0);
    expect(norm.z).toBeCloseTo(0.8);
  });

  it('normalizes zero vector to zero', () => {
    const norm = vec3Normalize(vec3(0, 0, 0));
    expect(norm).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('calculates 3D distance', () => {
    const dist = vec3Distance(vec3(0, 0, 0), vec3(3, 4, 0));
    expect(dist).toBe(5);
  });

  it('calculates XZ distance', () => {
    const dist = vec3DistanceXZ(vec3(0, 10, 0), vec3(3, 20, 4));
    expect(dist).toBe(5);
  });
});

describe('yawToForward', () => {
  it('yaw 0 points to -Z', () => {
    const forward = yawToForward(0);
    expect(forward.x).toBeCloseTo(0);
    expect(forward.z).toBeCloseTo(-1);
  });

  it('yaw PI/2 points to -X', () => {
    const forward = yawToForward(Math.PI / 2);
    expect(forward.x).toBeCloseTo(-1);
    expect(forward.z).toBeCloseTo(0);
  });

  it('yaw PI points to +Z', () => {
    const forward = yawToForward(Math.PI);
    expect(forward.x).toBeCloseTo(0);
    expect(forward.z).toBeCloseTo(1);
  });
});

describe('applyMovement', () => {
  function makeState(x = 0, z = 0): EntityPhysicsState {
    return {
      pos: { x, y: 0, z },
      vel: { x: 0, y: 0, z: 0 },
      isGrounded: true,
      groundLevel: GROUND_Y,
    };
  }

  function noInput(): MoveInputData {
    return { dx: 0, dz: 0, yaw: 0, jump: false };
  }

  it('applies forward movement (W key)', () => {
    const state = makeState();
    const input: MoveInputData = { dx: 0, dz: -1, yaw: 0, jump: false };

    const result = applyMovement(state, input, 1.0);

    // Moving forward (W) with yaw 0 should move in -Z direction
    expect(result.pos.z).toBeLessThan(0);
    expect(result.vel.z).toBeCloseTo(-MOVE_SPEED);
  });

  it('applies strafe movement (A key)', () => {
    const state = makeState();
    const input: MoveInputData = { dx: -1, dz: 0, yaw: 0, jump: false };

    const result = applyMovement(state, input, 1.0);

    // Strafing left with yaw 0 should move in -X direction
    expect(result.pos.x).toBeLessThan(0);
  });

  it('stops when no input', () => {
    const state = makeState();
    state.vel = { x: 5, y: 0, z: 5 };

    const result = applyMovement(state, noInput(), 0.1);

    expect(result.vel.x).toBe(0);
    expect(result.vel.z).toBe(0);
  });

  it('applies jump', () => {
    const state = makeState();
    const input: MoveInputData = { dx: 0, dz: 0, yaw: 0, jump: true };

    const result = applyMovement(state, input, 0.016);

    expect(result.vel.y).toBeCloseTo(JUMP_FORCE, 0);
    expect(result.isGrounded).toBe(false);
  });

  it('cannot jump while in air', () => {
    const state = makeState();
    state.isGrounded = false;
    state.vel.y = 2;
    const input: MoveInputData = { dx: 0, dz: 0, yaw: 0, jump: true };

    const result = applyMovement(state, input, 0.016);

    expect(result.vel.y).toBeLessThan(2); // Gravity applied
  });

  it('applies gravity when in air', () => {
    const state = makeState();
    state.pos.y = 5;
    state.isGrounded = false;

    const result = applyMovement(state, noInput(), 0.1);

    expect(result.vel.y).toBeLessThan(0);
    expect(result.pos.y).toBeLessThan(5);
  });

  it('lands on ground', () => {
    const state = makeState();
    state.pos.y = 0.5;
    state.vel.y = -10;
    state.isGrounded = false;

    const result = applyMovement(state, noInput(), 0.1);

    expect(result.pos.y).toBe(GROUND_Y);
    expect(result.vel.y).toBe(0);
    expect(result.isGrounded).toBe(true);
  });

  it('clamps to arena bounds', () => {
    const state = makeState(ARENA_BOUND + 10, ARENA_BOUND + 10);

    const result = applyMovement(state, noInput(), 0.016);

    expect(result.pos.x).toBe(ARENA_BOUND);
    expect(result.pos.z).toBe(ARENA_BOUND);
  });

  it('collides with pillar', () => {
    // Pillar at (-8, -8), try to walk into it
    const state = makeState(-PILLAR_OFFSET - 2, -PILLAR_OFFSET);
    const input: MoveInputData = { dx: 1, dz: 0, yaw: 0, jump: false };

    // Move toward pillar for 1 second
    let current = state;
    for (let i = 0; i < 60; i++) {
      current = applyMovement(current, input, 0.016);
    }

    // Should be pushed out of pillar
    const distFromPillar = vec3DistanceXZ(current.pos, vec3(-PILLAR_OFFSET, 0, -PILLAR_OFFSET));
    expect(distFromPillar).toBeGreaterThan(1.2); // Pillar radius + player radius
  });

  it('movement direction follows camera yaw', () => {
    const state = makeState();

    // Forward with yaw = PI/2 (facing left) should move in -X
    const input: MoveInputData = { dx: 0, dz: -1, yaw: Math.PI / 2, jump: false };
    const result = applyMovement(state, input, 1.0);

    expect(result.pos.x).toBeLessThan(-5);
    expect(Math.abs(result.pos.z)).toBeLessThan(0.1);
  });
});

describe('projectile physics', () => {
  it('updates projectile position toward target', () => {
    const pos = vec3(0, 1, 0);
    const vel = vec3(0, 0, -10);
    const target = vec3(0, 1, -20);

    const newPos = updateProjectilePosition(pos, vel, target, 20, 0.5);

    expect(newPos.z).toBeLessThan(pos.z);
    expect(newPos.z).toBeCloseTo(-10, 0);
  });

  it('projectile reaches target', () => {
    const pos = vec3(0, 1, -19.95);
    const vel = vec3(0, 0, -20);
    const target = vec3(0, 1, -20);

    const newPos = updateProjectilePosition(pos, vel, target, 20, 0.1);

    // When very close (< 0.1), snaps to target
    expect(newPos).toEqual(target);
  });

  it('checks projectile hit', () => {
    expect(checkProjectileHit(vec3(0, 1, 0), vec3(0.3, 1, 0))).toBe(true);
    expect(checkProjectileHit(vec3(0, 1, 0), vec3(1, 1, 0))).toBe(false);
  });
});

describe('ability positions', () => {
  describe('getPositionBehindTarget', () => {
    it('calculates position behind target', () => {
      const caster = vec3(0, 0, 5);
      const target = vec3(0, 0, 0);

      const behind = getPositionBehindTarget(caster, target, 1.5);

      // Target is at origin, caster is at z=5
      // Position behind should be at z < 0
      expect(behind.z).toBeLessThan(0);
      expect(behind.y).toBe(GROUND_Y);
    });

    it('handles diagonal approach', () => {
      const caster = vec3(5, 0, 5);
      const target = vec3(0, 0, 0);

      const behind = getPositionBehindTarget(caster, target, 2);

      // Should be on opposite side of target from caster
      expect(behind.x).toBeLessThan(0);
      expect(behind.z).toBeLessThan(0);
    });
  });

  describe('getBlinkDestination', () => {
    it('blinks forward with yaw 0', () => {
      const pos = vec3(0, 0, 0);
      const dest = getBlinkDestination(pos, 0, 8);

      expect(dest.x).toBeCloseTo(0);
      expect(dest.z).toBeCloseTo(-8);
    });

    it('blinks forward with yaw PI/2', () => {
      const pos = vec3(0, 0, 0);
      const dest = getBlinkDestination(pos, Math.PI / 2, 8);

      expect(dest.x).toBeCloseTo(-8);
      expect(dest.z).toBeCloseTo(0);
    });

    it('clamps to arena bounds', () => {
      const pos = vec3(15, 0, 0);
      const dest = getBlinkDestination(pos, -Math.PI / 2, 20);

      expect(dest.x).toBe(ARENA_BOUND);
    });
  });

  describe('isPositionValid', () => {
    it('accepts position in open arena', () => {
      expect(isPositionValid(vec3(0, 0, 0))).toBe(true);
    });

    it('rejects position inside pillar', () => {
      // Pillar at (-8, -8)
      expect(isPositionValid(vec3(-PILLAR_OFFSET, 0, -PILLAR_OFFSET))).toBe(false);
    });

    it('rejects position outside arena', () => {
      expect(isPositionValid(vec3(ARENA_BOUND + 1, 0, 0))).toBe(false);
      expect(isPositionValid(vec3(0, 0, -ARENA_BOUND - 1))).toBe(false);
    });
  });

  describe('findValidPositionNear', () => {
    it('returns preferred direction if valid', () => {
      const target = vec3(0, 0, 0);
      const dir = vec3(0, 0, 1);

      const pos = findValidPositionNear(target, dir, 2);

      expect(pos.z).toBeGreaterThan(0);
    });

    it('finds alternative if preferred is invalid', () => {
      // Target near pillar, try to go into pillar
      const target = vec3(-PILLAR_OFFSET + 1, 0, -PILLAR_OFFSET);
      const dir = vec3(-1, 0, 0); // Into pillar

      const pos = findValidPositionNear(target, dir, 1.5);

      expect(isPositionValid(pos)).toBe(true);
    });
  });
});
