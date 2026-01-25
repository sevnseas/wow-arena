import { describe, it, expect } from 'vitest';
import {
  encodeClientMessage,
  decodeClientMessage,
  encodeServerMessage,
  decodeServerMessage,
  type MoveInput,
  type AbilityInput,
  type Snapshot,
  type Welcome,
  type Events,
  type CastStartedEvent,
} from '../protocol';

describe('protocol', () => {
  describe('client messages', () => {
    it('encodes and decodes MoveInput', () => {
      const msg: MoveInput = {
        type: 'MoveInput',
        seq: 42,
        dx: 0.5,
        dz: -1,
        yaw: 1.57,
        jump: true,
        dt: 0.016,
      };

      const encoded = encodeClientMessage(msg);
      const decoded = decodeClientMessage(encoded);

      expect(decoded).toEqual(msg);
    });

    it('encodes and decodes AbilityInput', () => {
      const msg: AbilityInput = {
        type: 'AbilityInput',
        seq: 100,
        abilityId: 'mage_frostbolt',
        targetId: 'enemy1',
      };

      const encoded = encodeClientMessage(msg);
      const decoded = decodeClientMessage(encoded);

      expect(decoded).toEqual(msg);
    });

    it('handles null targetId in AbilityInput', () => {
      const msg: AbilityInput = {
        type: 'AbilityInput',
        seq: 101,
        abilityId: 'mage_blink',
        targetId: null,
      };

      const encoded = encodeClientMessage(msg);
      const decoded = decodeClientMessage(encoded);

      expect(decoded).toEqual(msg);
      expect(decoded?.type).toBe('AbilityInput');
      if (decoded?.type === 'AbilityInput') {
        expect(decoded.targetId).toBeNull();
      }
    });

    it('returns null for invalid JSON', () => {
      const decoded = decodeClientMessage('not valid json');
      expect(decoded).toBeNull();
    });
  });

  describe('server messages', () => {
    it('encodes and decodes Welcome', () => {
      const msg: Welcome = {
        type: 'Welcome',
        playerId: 'player_123',
        tick: 1000,
        serverTime: Date.now(),
      };

      const encoded = encodeServerMessage(msg);
      const decoded = decodeServerMessage(encoded);

      expect(decoded).toEqual(msg);
    });

    it('encodes and decodes Snapshot with entities', () => {
      const msg: Snapshot = {
        type: 'Snapshot',
        tick: 500,
        serverTime: 1234567890,
        ackedSeq: 42,
        entities: [
          {
            id: 'player1',
            name: 'TestPlayer',
            class: 'Mage',
            team: 'friendly',
            pos: { x: 1, y: 0, z: 2 },
            vel: { x: 0, y: 0, z: 0 },
            yaw: 3.14,
            hp: 100,
            maxHp: 100,
            alive: true,
            debuffs: [],
            castingAbilityId: null,
            castProgress: 0,
          },
          {
            id: 'enemy1',
            name: 'BadGuy',
            class: 'Warrior',
            team: 'enemy',
            pos: { x: -5, y: 0, z: -5 },
            vel: { x: 1, y: 0, z: 0 },
            yaw: 0,
            hp: 80,
            maxHp: 100,
            alive: true,
            debuffs: ['blind'],
            castingAbilityId: null,
            castProgress: 0,
          },
        ],
        projectiles: [
          {
            id: 1,
            abilityId: 'mage_frostbolt',
            sourceId: 'player1',
            targetId: 'enemy1',
            pos: { x: 0, y: 1, z: 0 },
            vel: { x: 10, y: 0, z: -10 },
          },
        ],
      };

      const encoded = encodeServerMessage(msg);
      const decoded = decodeServerMessage(encoded);

      expect(decoded).toEqual(msg);
    });

    it('encodes and decodes Events', () => {
      const castEvent: CastStartedEvent = {
        type: 'CastStarted',
        tick: 100,
        casterId: 'player1',
        abilityId: 'mage_frostbolt',
        targetId: 'enemy1',
        castTime: 1.5,
      };

      const msg: Events = {
        type: 'Events',
        events: [castEvent],
      };

      const encoded = encodeServerMessage(msg);
      const decoded = decodeServerMessage(encoded);

      expect(decoded).toEqual(msg);
    });

    it('returns null for invalid JSON', () => {
      const decoded = decodeServerMessage('{broken');
      expect(decoded).toBeNull();
    });
  });

  describe('round-trip integrity', () => {
    it('preserves floating point precision', () => {
      const msg: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 0.123456789,
        dz: -0.987654321,
        yaw: 3.141592653589793,
        jump: false,
        dt: 0.016666666666666666,
      };

      const decoded = decodeClientMessage(encodeClientMessage(msg));
      expect(decoded).toEqual(msg);
    });

    it('preserves Vec3 structure', () => {
      const msg: Snapshot = {
        type: 'Snapshot',
        tick: 1,
        serverTime: 0,
        ackedSeq: 0,
        entities: [{
          id: 'test',
          name: 'Test',
          class: 'Rogue',
          team: 'friendly',
          pos: { x: 1.5, y: 2.5, z: 3.5 },
          vel: { x: -1, y: 0, z: 1 },
          yaw: 0,
          hp: 100,
          maxHp: 100,
          alive: true,
          debuffs: [],
          castingAbilityId: null,
          castProgress: 0,
        }],
        projectiles: [],
      };

      const decoded = decodeServerMessage(encodeServerMessage(msg)) as Snapshot;
      expect(decoded.entities[0].pos.x).toBe(1.5);
      expect(decoded.entities[0].pos.y).toBe(2.5);
      expect(decoded.entities[0].pos.z).toBe(3.5);
    });
  });
});
