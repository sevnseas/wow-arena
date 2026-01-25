import { describe, it, expect, beforeEach } from 'vitest';
import { InputProcessor } from '../src/input';
import { ServerGameState } from '../src/state';
import type { MoveInput, AbilityInput } from '../../src/shared/protocol';

describe('InputProcessor', () => {
  let processor: InputProcessor;
  let state: ServerGameState;

  beforeEach(() => {
    processor = new InputProcessor();
    state = new ServerGameState();
  });

  describe('player initialization', () => {
    it('initializes player input state', () => {
      state.spawnEntity('entity1', 'Test', 'Mage', 'friendly', { x: 5, y: 0, z: 10 });
      processor.initPlayer('player1', 'entity1', state);

      expect(processor.getLastSeq('player1')).toBe(0);
    });

    it('removes player', () => {
      state.spawnEntity('entity1', 'Test', 'Mage', 'friendly');
      processor.initPlayer('player1', 'entity1', state);
      processor.removePlayer('player1');

      expect(processor.getLastSeq('player1')).toBe(0); // Returns 0 for unknown player
    });
  });

  describe('processMoveInput', () => {
    beforeEach(() => {
      state.spawnEntity('entity1', 'Test', 'Mage', 'friendly', { x: 0, y: 0, z: 0 });
      processor.initPlayer('player1', 'entity1', state);
    });

    it('processes valid move input', () => {
      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 0,
        dz: -1,
        yaw: 0,
        jump: false,
        dt: 0.016,
      };

      const result = processor.processMoveInput('player1', 'entity1', input, state, 1);

      expect(result.success).toBe(true);
      expect(result.seq).toBe(1);
      expect(processor.getLastSeq('player1')).toBe(1);
    });

    it('updates entity position', () => {
      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 0,
        dz: -1,
        yaw: 0,
        jump: false,
        dt: 0.5, // Large dt for noticeable movement
      };

      processor.processMoveInput('player1', 'entity1', input, state, 1);

      const entity = state.getEntity('entity1');
      expect(entity?.pos.z).toBeLessThan(0);
    });

    it('rejects input for uninitialized player', () => {
      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 0,
        dz: 0,
        yaw: 0,
        jump: false,
        dt: 0.016,
      };

      const result = processor.processMoveInput('unknown', 'entity1', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Player not initialized');
    });

    it('rejects input for dead entity', () => {
      state.kill('entity1');

      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 0,
        dz: -1,
        yaw: 0,
        jump: false,
        dt: 0.016,
      };

      const result = processor.processMoveInput('player1', 'entity1', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Entity is dead');
    });

    it('rejects old sequence numbers', () => {
      const input1: MoveInput = {
        type: 'MoveInput',
        seq: 5,
        dx: 0,
        dz: 0,
        yaw: 0,
        jump: false,
        dt: 0.016,
      };

      processor.processMoveInput('player1', 'entity1', input1, state, 1);

      const input2: MoveInput = {
        type: 'MoveInput',
        seq: 3, // Older than 5
        dx: 0,
        dz: 0,
        yaw: 0,
        jump: false,
        dt: 0.016,
      };

      const result = processor.processMoveInput('player1', 'entity1', input2, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Old sequence number');
    });

    it('rate limits inputs', () => {
      const makeInput = (seq: number): MoveInput => ({
        type: 'MoveInput',
        seq,
        dx: 0,
        dz: 0,
        yaw: 0,
        jump: false,
        dt: 0.016,
      });

      // First 3 should succeed
      expect(processor.processMoveInput('player1', 'entity1', makeInput(1), state, 1).success).toBe(true);
      expect(processor.processMoveInput('player1', 'entity1', makeInput(2), state, 1).success).toBe(true);
      expect(processor.processMoveInput('player1', 'entity1', makeInput(3), state, 1).success).toBe(true);

      // 4th should fail
      const result = processor.processMoveInput('player1', 'entity1', makeInput(4), state, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Rate limited');
    });

    it('resets rate limit on new tick', () => {
      const makeInput = (seq: number): MoveInput => ({
        type: 'MoveInput',
        seq,
        dx: 0,
        dz: 0,
        yaw: 0,
        jump: false,
        dt: 0.016,
      });

      // Max out on tick 1
      processor.processMoveInput('player1', 'entity1', makeInput(1), state, 1);
      processor.processMoveInput('player1', 'entity1', makeInput(2), state, 1);
      processor.processMoveInput('player1', 'entity1', makeInput(3), state, 1);

      processor.resetTick(2);

      // Should work on tick 2
      const result = processor.processMoveInput('player1', 'entity1', makeInput(4), state, 2);
      expect(result.success).toBe(true);
    });

    it('prevents movement when CC\'d', () => {
      state.spawnEntity('enemy1', 'Enemy', 'Warrior', 'enemy');
      state.applyDebuff('entity1', 'enemy1', {
        id: 'stun',
        name: 'Stun',
        duration: 5,
        tags: ['cc'],
      });

      const startPos = { ...state.getEntity('entity1')!.pos };

      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 1,
        dz: 1,
        yaw: 0,
        jump: true,
        dt: 0.5,
      };

      const result = processor.processMoveInput('player1', 'entity1', input, state, 1);

      // Input is acked but movement not applied
      expect(result.success).toBe(true);
      expect(state.getEntity('entity1')?.pos).toEqual(startPos);
    });

    it('interrupts cast on movement', () => {
      state.startCast('entity1', 'test_spell', null, 60);
      expect(state.getActiveCast('entity1')).not.toBeNull();

      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 1,
        dz: 0,
        yaw: 0,
        jump: false,
        dt: 0.016,
      };

      processor.processMoveInput('player1', 'entity1', input, state, 1);

      expect(state.getActiveCast('entity1')).toBeNull();
    });

    it('does not interrupt cast when stationary', () => {
      state.startCast('entity1', 'test_spell', null, 60);

      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 0,
        dz: 0,
        yaw: 1.5, // Just turning, not moving
        jump: false,
        dt: 0.016,
      };

      processor.processMoveInput('player1', 'entity1', input, state, 1);

      expect(state.getActiveCast('entity1')).not.toBeNull();
    });

    it('clamps delta time to valid range', () => {
      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 0,
        dz: -1,
        yaw: 0,
        jump: false,
        dt: 10, // Absurdly large dt - should be clamped to MAX_DT (0.1)
      };

      const result = processor.processMoveInput('player1', 'entity1', input, state, 1);

      expect(result.success).toBe(true);
      // Entity should have moved, but not 10 seconds worth
      const entity = state.getEntity('entity1');
      expect(entity?.pos.z).toBeGreaterThan(-2); // Much less than 60 units (6 * 10)
    });
  });

  describe('processAbilityInput', () => {
    beforeEach(() => {
      state.spawnEntity('player_entity', 'Player', 'Mage', 'friendly', { x: 0, y: 0, z: 5 });
      state.spawnEntity('enemy_entity', 'Enemy', 'Warrior', 'enemy', { x: 0, y: 0, z: -5 });
      processor.initPlayer('player1', 'player_entity', state);
    });

    it('validates ability exists', () => {
      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'nonexistent_spell',
        targetId: null,
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown ability');
    });

    it('rejects when CC\'d', () => {
      state.applyDebuff('player_entity', 'enemy_entity', {
        id: 'stun',
        name: 'Stun',
        duration: 5,
        tags: ['cc'],
      });

      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_blink',
        targetId: null,
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot cast while CC\'d');
    });

    it('rejects when already casting', () => {
      state.startCast('player_entity', 'mage_frostbolt', 'enemy_entity', 30);

      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_blink',
        targetId: null,
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Already casting');
    });

    it('rejects when on cooldown', () => {
      state.startCooldown('player_entity', 'mage_blink', 300); // 15s cooldown

      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_blink',
        targetId: null,
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Ability on cooldown');
    });

    it('validates target requirement', () => {
      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_frostbolt',
        targetId: null,
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Requires target');
    });

    it('validates target exists', () => {
      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_frostbolt',
        targetId: 'nonexistent',
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Target not found');
    });

    it('validates target is alive', () => {
      state.kill('enemy_entity');

      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_frostbolt',
        targetId: 'enemy_entity',
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Target is dead');
    });

    it('validates range', () => {
      // Move enemy far away (Frostbolt has 30m range)
      state.setPosition('enemy_entity', { x: 0, y: 0, z: -50 });

      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_frostbolt',
        targetId: 'enemy_entity',
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Out of range');
    });

    it('accepts valid self-targeted ability', () => {
      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_blink',
        targetId: null,
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(true);
    });

    it('accepts valid targeted ability', () => {
      const input: AbilityInput = {
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_frostbolt',
        targetId: 'enemy_entity',
      };

      const result = processor.processAbilityInput('player1', 'player_entity', input, state, 1);

      expect(result.success).toBe(true);
    });

    it('rate limits ability inputs', () => {
      const makeInput = (seq: number): AbilityInput => ({
        type: 'AbilityInput',
        seq,
        abilityId: 'mage_blink',
        targetId: null,
      });

      // First 3 succeed (though cooldown would block repeat uses in real scenario)
      processor.processAbilityInput('player1', 'player_entity', makeInput(1), state, 1);
      state.startCooldown('player_entity', 'mage_blink', 0); // Clear cooldown for test

      processor.processAbilityInput('player1', 'player_entity', makeInput(2), state, 1);
      state.startCooldown('player_entity', 'mage_blink', 0);

      processor.processAbilityInput('player1', 'player_entity', makeInput(3), state, 1);

      // 4th should fail due to rate limit
      const result = processor.processAbilityInput('player1', 'player_entity', makeInput(4), state, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Rate limited');
    });
  });

  describe('syncPhysicsState', () => {
    it('syncs physics state with game state', () => {
      state.spawnEntity('entity1', 'Test', 'Mage', 'friendly', { x: 0, y: 0, z: 0 });
      processor.initPlayer('player1', 'entity1', state);

      // Teleport the entity
      state.setPosition('entity1', { x: 10, y: 0, z: 10 });
      processor.syncPhysicsState('player1', 'entity1', state);

      // Next movement should start from new position
      const input: MoveInput = {
        type: 'MoveInput',
        seq: 1,
        dx: 0,
        dz: -1,
        yaw: 0,
        jump: false,
        dt: 0.1,
      };

      processor.processMoveInput('player1', 'entity1', input, state, 1);

      const entity = state.getEntity('entity1');
      // Should be near (10, 0, 9.4) not near (0, 0, -0.6)
      expect(entity?.pos.x).toBeCloseTo(10, 0);
    });
  });
});
