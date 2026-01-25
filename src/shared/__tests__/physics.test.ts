import { describe, it, expect } from 'vitest';
import {
  MOVE_SPEED,
  JUMP_FORCE,
  GRAVITY,
  PLAYER_RADIUS,
  ARENA_BOUND,
  PILLAR_POSITIONS,
  PILLAR_BASE_RADIUS,
  RAMPS,
  buildColliders,
  SERVER_TICK_RATE,
  SERVER_TICK_MS,
  FRIENDLY_SPAWNS,
  ENEMY_SPAWNS,
} from '../physics';

describe('physics constants', () => {
  describe('player movement', () => {
    it('has reasonable move speed', () => {
      expect(MOVE_SPEED).toBe(6);
      expect(MOVE_SPEED).toBeGreaterThan(0);
    });

    it('has reasonable jump force', () => {
      expect(JUMP_FORCE).toBe(8);
      expect(JUMP_FORCE).toBeGreaterThan(0);
    });

    it('has reasonable gravity', () => {
      expect(GRAVITY).toBe(20);
      expect(GRAVITY).toBeGreaterThan(0);
    });

    it('has reasonable player radius', () => {
      expect(PLAYER_RADIUS).toBe(0.35);
      expect(PLAYER_RADIUS).toBeGreaterThan(0);
      expect(PLAYER_RADIUS).toBeLessThan(1);
    });
  });

  describe('arena layout', () => {
    it('has 4 pillars', () => {
      expect(PILLAR_POSITIONS).toHaveLength(4);
    });

    it('pillars are symmetrically placed', () => {
      const [p1, p2, p3, p4] = PILLAR_POSITIONS;

      // Check symmetry
      expect(p1[0]).toBe(-p2[0]);
      expect(p1[1]).toBe(p2[1]);
      expect(p3[0]).toBe(-p4[0]);
      expect(p3[1]).toBe(p4[1]);
    });

    it('has 2 ramps', () => {
      expect(RAMPS).toHaveLength(2);
    });

    it('ramps are positioned in center', () => {
      for (const ramp of RAMPS) {
        expect(Math.abs(ramp.x)).toBeLessThan(5);
        expect(ramp.z).toBe(0);
      }
    });

    it('arena bound allows movement', () => {
      expect(ARENA_BOUND).toBe(18);
      expect(ARENA_BOUND).toBeGreaterThan(0);
    });
  });

  describe('buildColliders', () => {
    it('returns correct number of colliders', () => {
      const colliders = buildColliders();
      // 4 pillars + 2 ramps = 6 colliders
      expect(colliders).toHaveLength(6);
    });

    it('includes pillar colliders', () => {
      const colliders = buildColliders();
      const cylinders = colliders.filter(c => c.type === 'cylinder');
      expect(cylinders).toHaveLength(4);

      for (const cyl of cylinders) {
        if (cyl.type === 'cylinder') {
          expect(cyl.radius).toBe(PILLAR_BASE_RADIUS);
          expect(cyl.height).toBeGreaterThan(0);
        }
      }
    });

    it('includes box colliders for ramps', () => {
      const colliders = buildColliders();
      const boxes = colliders.filter(c => c.type === 'box');
      expect(boxes).toHaveLength(2);

      for (const box of boxes) {
        if (box.type === 'box') {
          expect(box.width).toBeGreaterThan(0);
          expect(box.depth).toBeGreaterThan(0);
          expect(box.height).toBeGreaterThan(0);
        }
      }
    });

    it('colliders are at expected positions', () => {
      const colliders = buildColliders();

      for (const [x, z] of PILLAR_POSITIONS) {
        const found = colliders.find(
          c => c.type === 'cylinder' && c.x === x && c.z === z
        );
        expect(found).toBeDefined();
      }
    });
  });

  describe('spawn positions', () => {
    it('has 3 friendly spawns', () => {
      expect(FRIENDLY_SPAWNS).toHaveLength(3);
    });

    it('has 3 enemy spawns', () => {
      expect(ENEMY_SPAWNS).toHaveLength(3);
    });

    it('friendly spawns are on positive Z side', () => {
      for (const [, , z] of FRIENDLY_SPAWNS) {
        expect(z).toBeGreaterThan(0);
      }
    });

    it('enemy spawns are on negative Z side', () => {
      for (const [, , z] of ENEMY_SPAWNS) {
        expect(z).toBeLessThan(0);
      }
    });

    it('spawns are within arena bounds', () => {
      const allSpawns = [...FRIENDLY_SPAWNS, ...ENEMY_SPAWNS];
      for (const [x, , z] of allSpawns) {
        expect(Math.abs(x)).toBeLessThanOrEqual(ARENA_BOUND);
        expect(Math.abs(z)).toBeLessThanOrEqual(ARENA_BOUND);
      }
    });

    it('spawns are at ground level', () => {
      const allSpawns = [...FRIENDLY_SPAWNS, ...ENEMY_SPAWNS];
      for (const [, y] of allSpawns) {
        expect(y).toBe(0);
      }
    });
  });

  describe('server timing', () => {
    it('tick rate is 20Hz', () => {
      expect(SERVER_TICK_RATE).toBe(20);
    });

    it('tick MS matches tick rate', () => {
      expect(SERVER_TICK_MS).toBe(1000 / SERVER_TICK_RATE);
      expect(SERVER_TICK_MS).toBe(50);
    });
  });
});
