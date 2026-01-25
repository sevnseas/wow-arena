import { describe, it, expect, beforeEach } from 'vitest';
import { ServerGameState } from '../src/state';
import {
  buildSnapshot,
  buildEventsMessage,
  createEventQueue,
  pushEvents,
  flushEvents,
  getEventCount,
} from '../src/snapshot';
import type { GameEvent } from '../../src/shared/protocol';

describe('snapshot', () => {
  let state: ServerGameState;

  beforeEach(() => {
    state = new ServerGameState();
    state.setTick(100);
  });

  describe('buildSnapshot', () => {
    it('includes current tick and server time', () => {
      const snapshot = buildSnapshot(state, 0);

      expect(snapshot.type).toBe('Snapshot');
      expect(snapshot.tick).toBe(100);
      expect(typeof snapshot.serverTime).toBe('number');
    });

    it('includes acked sequence number', () => {
      const snapshot = buildSnapshot(state, 42);

      expect(snapshot.ackedSeq).toBe(42);
    });

    it('includes all entities', () => {
      state.spawnEntity('player1', 'Player1', 'Mage', 'friendly');
      state.spawnEntity('player2', 'Player2', 'Rogue', 'enemy');

      const snapshot = buildSnapshot(state, 0);

      expect(snapshot.entities).toHaveLength(2);
      expect(snapshot.entities.map(e => e.id)).toContain('player1');
      expect(snapshot.entities.map(e => e.id)).toContain('player2');
    });

    it('includes entity position and velocity', () => {
      state.spawnEntity('player1', 'Player', 'Mage', 'friendly', { x: 5, y: 1, z: 10 });
      state.setVelocity('player1', { x: 1, y: 0, z: -1 });

      const snapshot = buildSnapshot(state, 0);
      const entity = snapshot.entities[0];

      expect(entity.pos).toEqual({ x: 5, y: 1, z: 10 });
      expect(entity.vel).toEqual({ x: 1, y: 0, z: -1 });
    });

    it('includes health and alive status', () => {
      state.spawnEntity('player1', 'Player', 'Mage', 'friendly');
      state.applyDamage('player1', 30);

      const snapshot = buildSnapshot(state, 0);
      const entity = snapshot.entities[0];

      expect(entity.hp).toBe(70);
      expect(entity.maxHp).toBe(100);
      expect(entity.alive).toBe(true);
    });

    it('includes debuffs', () => {
      state.spawnEntity('player1', 'Player', 'Mage', 'friendly');
      state.spawnEntity('enemy', 'Enemy', 'Warrior', 'enemy');
      state.applyDebuff('player1', 'enemy', {
        id: 'slow',
        name: 'Slow',
        duration: 5,
        tags: ['slow'],
      });

      const snapshot = buildSnapshot(state, 0);
      const entity = snapshot.entities.find(e => e.id === 'player1')!;

      expect(entity.debuffs).toEqual(['slow']);
    });

    it('includes cast progress', () => {
      state.spawnEntity('player1', 'Player', 'Mage', 'friendly');
      state.setTick(100);
      state.startCast('player1', 'mage_frostbolt', 'target', 40);

      state.setTick(120);
      const snapshot = buildSnapshot(state, 0);
      const entity = snapshot.entities[0];

      expect(entity.castingAbilityId).toBe('mage_frostbolt');
      expect(entity.castProgress).toBe(0.5);
    });

    it('includes all projectiles', () => {
      state.spawnEntity('player1', 'Player', 'Mage', 'friendly');
      state.spawnEntity('enemy', 'Enemy', 'Warrior', 'enemy');
      state.spawnProjectile('mage_frostbolt', 'player1', 'enemy', { x: 0, y: 1, z: 0 }, 20);

      const snapshot = buildSnapshot(state, 0);

      expect(snapshot.projectiles).toHaveLength(1);
      expect(snapshot.projectiles[0].abilityId).toBe('mage_frostbolt');
    });
  });

  describe('buildEventsMessage', () => {
    it('returns null for empty events', () => {
      const msg = buildEventsMessage([]);
      expect(msg).toBeNull();
    });

    it('wraps events in Events message', () => {
      const events: GameEvent[] = [
        { type: 'Damage', tick: 1, sourceId: 'a', targetId: 'b', amount: 10, abilityId: 'test' },
      ];

      const msg = buildEventsMessage(events);

      expect(msg?.type).toBe('Events');
      expect(msg?.events).toHaveLength(1);
    });
  });

  describe('event queue', () => {
    it('starts empty', () => {
      const queue = createEventQueue();
      expect(getEventCount(queue)).toBe(0);
    });

    it('accumulates events', () => {
      const queue = createEventQueue();

      pushEvents(queue, [
        { type: 'Damage', tick: 1, sourceId: 'a', targetId: 'b', amount: 10, abilityId: 'test' },
      ]);
      expect(getEventCount(queue)).toBe(1);

      pushEvents(queue, [
        { type: 'Heal', tick: 2, sourceId: 'a', targetId: 'b', amount: 20, abilityId: 'heal' },
        { type: 'Death', tick: 3, entityId: 'b', killerId: 'a' },
      ]);
      expect(getEventCount(queue)).toBe(3);
    });

    it('flushes and clears', () => {
      const queue = createEventQueue();

      pushEvents(queue, [
        { type: 'Damage', tick: 1, sourceId: 'a', targetId: 'b', amount: 10, abilityId: 'test' },
      ]);

      const events = flushEvents(queue);

      expect(events).toHaveLength(1);
      expect(getEventCount(queue)).toBe(0);
    });

    it('returns empty array on second flush', () => {
      const queue = createEventQueue();

      pushEvents(queue, [
        { type: 'Damage', tick: 1, sourceId: 'a', targetId: 'b', amount: 10, abilityId: 'test' },
      ]);

      flushEvents(queue);
      const secondFlush = flushEvents(queue);

      expect(secondFlush).toHaveLength(0);
    });
  });
});
