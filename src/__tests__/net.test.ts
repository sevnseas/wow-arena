/**
 * @vitest-environment jsdom
 */
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputManager } from '../net/input';
import { NetworkState } from '../net/state';
import { InputCapture } from '../net/capture';
import { ClientPrediction } from '../net/prediction';
import type { Snapshot, EntitySnapshot, MoveInput } from '../shared/protocol';

// Mock GameSocket
function createMockSocket(connected: boolean = true) {
  const sent: unknown[] = [];
  return {
    isConnected: () => connected,
    send: (msg: unknown) => {
      sent.push(msg);
      return connected;
    },
    _sent: sent,
  };
}

describe('InputManager', () => {
  let inputManager: InputManager;
  let mockSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    mockSocket = createMockSocket();
    inputManager = new InputManager(mockSocket as never);
  });

  describe('sendMoveInput', () => {
    it('sends move input with incrementing sequence', () => {
      inputManager.sendMoveInput(1, 0, false, 0, 0.016);
      inputManager.sendMoveInput(0, 1, false, 1.5, 0.016);

      expect(mockSocket._sent).toHaveLength(2);
      expect(mockSocket._sent[0]).toMatchObject({
        type: 'MoveInput',
        seq: 1,
        dz: 1,
        dx: 0,
      });
      expect(mockSocket._sent[1]).toMatchObject({
        type: 'MoveInput',
        seq: 2,
        dz: 0,
        dx: 1,
      });
    });

    it('returns pending input', () => {
      const pending = inputManager.sendMoveInput(1, 0, false, 0, 0.016);

      expect(pending).not.toBeNull();
      expect(pending!.seq).toBe(1);
      expect(pending!.type).toBe('move');
    });

    it('returns null when disconnected', () => {
      mockSocket = createMockSocket(false);
      inputManager = new InputManager(mockSocket as never);

      const pending = inputManager.sendMoveInput(1, 0, false, 0, 0.016);

      expect(pending).toBeNull();
      expect(mockSocket._sent).toHaveLength(0);
    });

    it('tracks pending inputs', () => {
      inputManager.sendMoveInput(1, 0, false, 0, 0.016);
      inputManager.sendMoveInput(0, 1, false, 0, 0.016);

      expect(inputManager.getPendingCount()).toBe(2);
    });
  });

  describe('sendAbilityInput', () => {
    it('sends ability input with sequence', () => {
      inputManager.sendAbilityInput('mage_frostbolt', 'target1');

      expect(mockSocket._sent).toHaveLength(1);
      expect(mockSocket._sent[0]).toMatchObject({
        type: 'AbilityInput',
        seq: 1,
        abilityId: 'mage_frostbolt',
        targetId: 'target1',
      });
    });

    it('handles null target', () => {
      inputManager.sendAbilityInput('mage_blink', null);

      expect(mockSocket._sent[0]).toMatchObject({
        type: 'AbilityInput',
        targetId: null,
      });
    });
  });

  describe('acknowledgeUpTo', () => {
    it('removes acknowledged inputs', () => {
      inputManager.sendMoveInput(1, 0, false, 0, 0.016);
      inputManager.sendMoveInput(0, 1, false, 0, 0.016);
      inputManager.sendMoveInput(0, 0, true, 0, 0.016);

      const acked = inputManager.acknowledgeUpTo(2);

      expect(acked).toHaveLength(2);
      expect(acked[0].seq).toBe(1);
      expect(acked[1].seq).toBe(2);
      expect(inputManager.getPendingCount()).toBe(1);
    });

    it('returns empty for already acked sequence', () => {
      inputManager.sendMoveInput(1, 0, false, 0, 0.016);
      inputManager.acknowledgeUpTo(1);

      const acked = inputManager.acknowledgeUpTo(1);

      expect(acked).toHaveLength(0);
    });

    it('updates lastAckedSeq', () => {
      inputManager.sendMoveInput(1, 0, false, 0, 0.016);
      inputManager.acknowledgeUpTo(1);

      expect(inputManager.getLastAckedSeq()).toBe(1);
    });
  });

  describe('getUnacknowledgedMoveInputs', () => {
    it('returns only unacked move inputs', () => {
      inputManager.sendMoveInput(1, 0, false, 0, 0.016);
      inputManager.sendAbilityInput('test', null);
      inputManager.sendMoveInput(0, 1, false, 0, 0.016);

      const moves = inputManager.getUnacknowledgedMoveInputs();

      expect(moves).toHaveLength(2);
      expect(moves[0].type).toBe('MoveInput');
      expect(moves[1].type).toBe('MoveInput');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      inputManager.sendMoveInput(1, 0, false, 0, 0.016);
      inputManager.acknowledgeUpTo(0);

      inputManager.reset();

      expect(inputManager.getSequence()).toBe(0);
      expect(inputManager.getPendingCount()).toBe(0);
      expect(inputManager.getLastAckedSeq()).toBe(0);
    });
  });

  describe('max pending inputs', () => {
    it('trims old inputs when limit exceeded', () => {
      const manager = new InputManager(mockSocket as never, { maxPendingInputs: 3 });

      manager.sendMoveInput(1, 0, false, 0, 0.016);
      manager.sendMoveInput(1, 0, false, 0, 0.016);
      manager.sendMoveInput(1, 0, false, 0, 0.016);
      manager.sendMoveInput(1, 0, false, 0, 0.016);

      expect(manager.getPendingCount()).toBe(3);
      // First input should be trimmed
      const unacked = manager.getUnacknowledgedInputs();
      expect(unacked[0].seq).toBe(2);
    });
  });
});

describe('NetworkState', () => {
  let networkState: NetworkState;

  function createSnapshot(
    tick: number,
    entities: Partial<EntitySnapshot>[] = []
  ): Snapshot {
    return {
      type: 'Snapshot',
      tick,
      serverTime: tick * 50,
      ackedSeq: 0,
      entities: entities.map((e, i) => ({
        id: e.id ?? `entity${i}`,
        name: e.name ?? `Entity ${i}`,
        class: e.class ?? 'Mage',
        team: e.team ?? 'friendly',
        pos: e.pos ?? { x: 0, y: 0, z: 0 },
        vel: e.vel ?? { x: 0, y: 0, z: 0 },
        yaw: e.yaw ?? 0,
        hp: e.hp ?? 100,
        maxHp: e.maxHp ?? 100,
        alive: e.alive ?? true,
        debuffs: e.debuffs ?? [],
        castingAbilityId: e.castingAbilityId ?? null,
        castProgress: e.castProgress ?? 0,
      })),
      projectiles: [],
    };
  }

  beforeEach(() => {
    networkState = new NetworkState({ interpolationDelay: 100 });
  });

  describe('addSnapshot', () => {
    it('stores snapshot', () => {
      networkState.addSnapshot(createSnapshot(1));

      expect(networkState.getSnapshotCount()).toBe(1);
    });

    it('updates server tick', () => {
      networkState.addSnapshot(createSnapshot(42));

      expect(networkState.getServerTick()).toBe(42);
    });

    it('updates server time', () => {
      networkState.addSnapshot(createSnapshot(10));

      expect(networkState.getServerTime()).toBe(500);
    });

    it('trims old snapshots', () => {
      const state = new NetworkState({ snapshotBufferSize: 3 });

      state.addSnapshot(createSnapshot(1));
      state.addSnapshot(createSnapshot(2));
      state.addSnapshot(createSnapshot(3));
      state.addSnapshot(createSnapshot(4));

      expect(state.getSnapshotCount()).toBe(3);
    });
  });

  describe('setLocalPlayerId', () => {
    it('stores and retrieves local player ID', () => {
      networkState.setLocalPlayerId('player1');

      expect(networkState.getLocalPlayerId()).toBe('player1');
    });
  });

  describe('getLocalPlayerServerState', () => {
    it('returns local player from latest snapshot', () => {
      networkState.setLocalPlayerId('player1');
      networkState.addSnapshot(
        createSnapshot(1, [
          { id: 'player1', hp: 80 },
          { id: 'player2', hp: 100 },
        ])
      );

      const state = networkState.getLocalPlayerServerState();

      expect(state).toBeDefined();
      expect(state!.id).toBe('player1');
      expect(state!.hp).toBe(80);
    });

    it('returns undefined if no local player set', () => {
      networkState.addSnapshot(createSnapshot(1, [{ id: 'player1' }]));

      expect(networkState.getLocalPlayerServerState()).toBeUndefined();
    });
  });

  describe('updateInterpolation', () => {
    it('excludes local player from interpolation', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      networkState.setLocalPlayerId('local');
      networkState.addSnapshot(
        createSnapshot(1, [
          { id: 'local', pos: { x: 0, y: 0, z: 0 } },
          { id: 'remote', pos: { x: 5, y: 0, z: 5 } },
        ])
      );

      vi.advanceTimersByTime(200);
      networkState.updateInterpolation(Date.now());

      expect(networkState.getInterpolatedEntity('local')).toBeUndefined();
      expect(networkState.getInterpolatedEntity('remote')).toBeDefined();

      vi.useRealTimers();
    });

    it('interpolates between snapshots', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      networkState.addSnapshot(
        createSnapshot(1, [{ id: 'entity1', pos: { x: 0, y: 0, z: 0 } }])
      );

      vi.advanceTimersByTime(50);
      networkState.addSnapshot(
        createSnapshot(2, [{ id: 'entity1', pos: { x: 10, y: 0, z: 0 } }])
      );

      // Render time should be 150ms behind current
      // At 1150ms, interpolation delay of 100ms means target = 1050ms
      // First snapshot at 1000ms, second at 1050ms
      // t = (1050 - 1000) / (1050 - 1000) = 1.0
      vi.advanceTimersByTime(100);
      networkState.updateInterpolation(Date.now());

      const entity = networkState.getInterpolatedEntity('entity1');
      expect(entity).toBeDefined();
      // Should be fully at second position since we've caught up
      expect(entity!.pos.x).toBe(10);

      vi.useRealTimers();
    });

    it('uses latest snapshot when extrapolating', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      networkState.addSnapshot(
        createSnapshot(1, [{ id: 'entity1', pos: { x: 5, y: 0, z: 5 } }])
      );

      // Way past the snapshot time
      vi.advanceTimersByTime(500);
      networkState.updateInterpolation(Date.now());

      const entity = networkState.getInterpolatedEntity('entity1');
      expect(entity).toBeDefined();
      expect(entity!.pos).toEqual({ x: 5, y: 0, z: 5 });

      vi.useRealTimers();
    });
  });

  describe('getAllInterpolatedEntities', () => {
    it('returns all remote entities', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      networkState.setLocalPlayerId('local');
      networkState.addSnapshot(
        createSnapshot(1, [
          { id: 'local' },
          { id: 'remote1' },
          { id: 'remote2' },
        ])
      );

      vi.advanceTimersByTime(200);
      networkState.updateInterpolation(Date.now());

      const entities = networkState.getAllInterpolatedEntities();
      expect(entities).toHaveLength(2);
      expect(entities.map((e) => e.id).sort()).toEqual(['remote1', 'remote2']);

      vi.useRealTimers();
    });
  });

  describe('events', () => {
    it('queues and consumes events', () => {
      networkState.addEvents([
        { type: 'Damage', tick: 1, sourceId: 'a', targetId: 'b', amount: 10, abilityId: 'test' },
      ]);
      networkState.addEvents([
        { type: 'Death', tick: 2, entityId: 'b', killerId: 'a' },
      ]);

      const events = networkState.consumeEvents();

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('Damage');
      expect(events[1].type).toBe('Death');
    });

    it('clears events after consume', () => {
      networkState.addEvents([
        { type: 'Damage', tick: 1, sourceId: 'a', targetId: 'b', amount: 10, abilityId: 'test' },
      ]);

      networkState.consumeEvents();
      const events = networkState.consumeEvents();

      expect(events).toHaveLength(0);
    });
  });

  describe('getLatestSnapshot', () => {
    it('returns most recent snapshot', () => {
      networkState.addSnapshot(createSnapshot(1));
      networkState.addSnapshot(createSnapshot(2));
      networkState.addSnapshot(createSnapshot(3));

      const latest = networkState.getLatestSnapshot();

      expect(latest).toBeDefined();
      expect(latest!.tick).toBe(3);
    });

    it('returns undefined when empty', () => {
      expect(networkState.getLatestSnapshot()).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      networkState.setLocalPlayerId('player1');
      networkState.addSnapshot(createSnapshot(1, [{ id: 'entity1' }]));
      networkState.addEvents([
        { type: 'Damage', tick: 1, sourceId: 'a', targetId: 'b', amount: 10, abilityId: 'test' },
      ]);

      networkState.reset();

      expect(networkState.getLocalPlayerId()).toBeNull();
      expect(networkState.getSnapshotCount()).toBe(0);
      expect(networkState.getServerTick()).toBe(0);
      expect(networkState.consumeEvents()).toHaveLength(0);
    });
  });

  describe('angle interpolation', () => {
    it('interpolates yaw correctly across wraparound', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      // Start at nearly 2*PI, end at 0.1 (should go through wraparound)
      networkState.addSnapshot(
        createSnapshot(1, [{ id: 'entity1', yaw: Math.PI * 1.9 }])
      );

      vi.advanceTimersByTime(50);
      networkState.addSnapshot(
        createSnapshot(2, [{ id: 'entity1', yaw: 0.1 }])
      );

      vi.advanceTimersByTime(100);
      networkState.updateInterpolation(Date.now());

      const entity = networkState.getInterpolatedEntity('entity1');
      expect(entity).toBeDefined();
      // Should interpolate through the shorter path
      // At t=1.0, should be at 0.1
      expect(entity!.yaw).toBeCloseTo(0.1, 1);

      vi.useRealTimers();
    });
  });
});

describe('InputCapture', () => {
  let inputCapture: InputCapture;
  let mockSocket: ReturnType<typeof createMockSocket>;
  let inputManager: InputManager;
  let yaw: number;

  function createMockSocket(connected: boolean = true) {
    const sent: unknown[] = [];
    return {
      isConnected: () => connected,
      send: (msg: unknown) => {
        sent.push(msg);
        return connected;
      },
      _sent: sent,
    };
  }

  function simulateKeyDown(code: string): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  }

  function simulateKeyUp(code: string): void {
    window.dispatchEvent(new KeyboardEvent('keyup', { code }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    mockSocket = createMockSocket();
    inputManager = new InputManager(mockSocket as never);
    yaw = 0;
    inputCapture = new InputCapture(inputManager, () => yaw, { sendRate: 20 });
    inputCapture.attach();
  });

  afterEach(() => {
    inputCapture.detach();
    vi.useRealTimers();
  });

  describe('getInputState', () => {
    it('returns zero state when no keys pressed', () => {
      const state = inputCapture.getInputState();

      expect(state.forward).toBe(0);
      expect(state.right).toBe(0);
      expect(state.jump).toBe(false);
    });

    it('detects W key as forward', () => {
      simulateKeyDown('KeyW');

      const state = inputCapture.getInputState();
      expect(state.forward).toBe(1);
    });

    it('detects S key as backward', () => {
      simulateKeyDown('KeyS');

      const state = inputCapture.getInputState();
      expect(state.forward).toBe(-1);
    });

    it('detects A key as left', () => {
      simulateKeyDown('KeyA');

      const state = inputCapture.getInputState();
      expect(state.right).toBe(-1);
    });

    it('detects D key as right', () => {
      simulateKeyDown('KeyD');

      const state = inputCapture.getInputState();
      expect(state.right).toBe(1);
    });

    it('cancels opposite directions', () => {
      simulateKeyDown('KeyW');
      simulateKeyDown('KeyS');

      const state = inputCapture.getInputState();
      expect(state.forward).toBe(0);
    });

    it('includes current yaw', () => {
      yaw = 1.5;

      const state = inputCapture.getInputState();
      expect(state.yaw).toBe(1.5);
    });
  });

  describe('update', () => {
    it('sends input when rate allows', () => {
      simulateKeyDown('KeyW');
      vi.advanceTimersByTime(50); // Past 20Hz interval

      inputCapture.update(0.016);

      expect(mockSocket._sent).toHaveLength(1);
      expect(mockSocket._sent[0]).toMatchObject({
        type: 'MoveInput',
        dz: 1,
      });
    });

    it('respects send rate limit', () => {
      simulateKeyDown('KeyW');

      inputCapture.update(0.016); // First send
      vi.advanceTimersByTime(10); // Not enough time
      inputCapture.update(0.016); // Should not send

      expect(mockSocket._sent).toHaveLength(1);
    });

    it('sends after rate interval passes', () => {
      simulateKeyDown('KeyW');

      inputCapture.update(0.016);
      vi.advanceTimersByTime(60); // More than 50ms (20Hz)
      inputCapture.update(0.016);

      expect(mockSocket._sent).toHaveLength(2);
    });

    it('calls onInputSent callback', () => {
      const callback = vi.fn();
      inputCapture.setOnInputSent(callback);
      simulateKeyDown('KeyW');
      vi.advanceTimersByTime(50);

      inputCapture.update(0.016);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].type).toBe('move');
    });
  });

  describe('sendAbility', () => {
    it('sends ability input immediately', () => {
      inputCapture.sendAbility('mage_frostbolt', 'target1');

      expect(mockSocket._sent).toHaveLength(1);
      expect(mockSocket._sent[0]).toMatchObject({
        type: 'AbilityInput',
        abilityId: 'mage_frostbolt',
        targetId: 'target1',
      });
    });
  });

  describe('keyboard events', () => {
    it('clears key state on keyup', () => {
      simulateKeyDown('KeyW');
      expect(inputCapture.getInputState().forward).toBe(1);

      simulateKeyUp('KeyW');
      expect(inputCapture.getInputState().forward).toBe(0);
    });

    it('clears all keys on detach', () => {
      simulateKeyDown('KeyW');
      simulateKeyDown('KeyD');

      inputCapture.detach();

      expect(inputCapture.getInputState().forward).toBe(0);
      expect(inputCapture.getInputState().right).toBe(0);
    });
  });

  describe('isKeyPressed', () => {
    it('returns true for pressed keys', () => {
      simulateKeyDown('KeyW');

      expect(inputCapture.isKeyPressed('keyw')).toBe(true);
    });

    it('returns false for unpressed keys', () => {
      expect(inputCapture.isKeyPressed('keyw')).toBe(false);
    });
  });
});

describe('ClientPrediction', () => {
  let prediction: ClientPrediction;

  beforeEach(() => {
    prediction = new ClientPrediction();
    prediction.initialize({ x: 0, y: 0, z: 0 });
  });

  describe('initialize', () => {
    it('sets initial position', () => {
      prediction.initialize({ x: 5, y: 0, z: 10 });

      const state = prediction.getPredicted();
      expect(state.pos).toEqual({ x: 5, y: 0, z: 10 });
    });

    it('sets initial yaw', () => {
      prediction.initialize({ x: 0, y: 0, z: 0 }, 1.5);

      const state = prediction.getPredicted();
      expect(state.yaw).toBe(1.5);
    });

    it('resets velocity', () => {
      const input: MoveInput = { type: 'MoveInput', seq: 1, dz: 1, dx: 0, jump: false, yaw: 0, dt: 0.1 };
      prediction.applyInput(input);

      prediction.initialize({ x: 0, y: 0, z: 0 });

      const state = prediction.getPredicted();
      expect(state.vel).toEqual({ x: 0, y: 0, z: 0 });
    });
  });

  describe('applyInput', () => {
    it('moves forward when forward=1', () => {
      const input: MoveInput = { type: 'MoveInput', seq: 1, dz: 1, dx: 0, jump: false, yaw: 0, dt: 0.1 };

      prediction.applyInput(input);

      const state = prediction.getPredicted();
      expect(state.pos.z).toBeLessThan(0); // Forward is -Z at yaw=0
    });

    it('moves backward when forward=-1', () => {
      const input: MoveInput = { type: 'MoveInput', seq: 1, dz: -1, dx: 0, jump: false, yaw: 0, dt: 0.1 };

      prediction.applyInput(input);

      const state = prediction.getPredicted();
      expect(state.pos.z).toBeGreaterThan(0);
    });

    it('moves sideways when right=1', () => {
      const input: MoveInput = { type: 'MoveInput', seq: 1, dz: 0, dx: 1, jump: false, yaw: 0, dt: 0.1 };

      prediction.applyInput(input);

      const state = prediction.getPredicted();
      // At yaw=0, right direction is -X in this coordinate system
      expect(state.pos.x).not.toBe(0);
    });

    it('applies jump velocity when grounded', () => {
      const input: MoveInput = { type: 'MoveInput', seq: 1, dz: 0, dx: 0, jump: true, yaw: 0, dt: 0.016 };

      prediction.applyInput(input);

      const state = prediction.getPredicted();
      expect(state.vel.y).toBeGreaterThan(0);
      expect(state.isGrounded).toBe(false);
    });

    it('does not double-jump when airborne', () => {
      const jump1: MoveInput = { type: 'MoveInput', seq: 1, dz: 0, dx: 0, jump: true, yaw: 0, dt: 0.016 };
      const jump2: MoveInput = { type: 'MoveInput', seq: 2, dz: 0, dx: 0, jump: true, yaw: 0, dt: 0.016 };

      prediction.applyInput(jump1);
      const velAfterFirst = prediction.getPredicted().vel.y;

      prediction.applyInput(jump2);
      const velAfterSecond = prediction.getPredicted().vel.y;

      // Second jump should not increase velocity (gravity reduces it)
      expect(velAfterSecond).toBeLessThan(velAfterFirst);
    });

    it('applies gravity when airborne', () => {
      // Jump first
      prediction.applyInput({ type: 'MoveInput', seq: 1, dz: 0, dx: 0, jump: true, yaw: 0, dt: 0.016 });
      const velAfterJump = prediction.getPredicted().vel.y;

      // Apply more time airborne
      prediction.applyInput({ type: 'MoveInput', seq: 2, dz: 0, dx: 0, jump: false, yaw: 0, dt: 0.1 });

      const state = prediction.getPredicted();
      expect(state.vel.y).toBeLessThan(velAfterJump);
    });

    it('clamps position to arena bounds', () => {
      // Move way past bounds
      for (let i = 0; i < 100; i++) {
        prediction.applyInput({ type: 'MoveInput', seq: i, dz: 1, dx: 0, jump: false, yaw: 0, dt: 0.1 });
      }

      const state = prediction.getPredicted();
      expect(state.pos.z).toBeGreaterThanOrEqual(-18);
    });

    it('updates yaw', () => {
      prediction.applyInput({ type: 'MoveInput', seq: 1, dz: 1, dx: 0, jump: false, yaw: 2.5, dt: 0.016 });

      const state = prediction.getPredicted();
      expect(state.yaw).toBe(2.5);
    });
  });

  describe('reconcile', () => {
    it('applies server position', () => {
      // Move locally
      prediction.applyInput({ type: 'MoveInput', seq: 1, dz: 1, dx: 0, jump: false, yaw: 0, dt: 0.1 });

      // Server says we're at a different position
      const serverEntity: EntitySnapshot = {
        id: 'player',
        name: 'Player',
        class: 'Mage',
        team: 'friendly',
        pos: { x: 5, y: 0, z: 5 },
        vel: { x: 0, y: 0, z: 0 },
        yaw: 0,
        hp: 100,
        maxHp: 100,
        alive: true,
        debuffs: [],
        castingAbilityId: null,
        castProgress: 0,
      };

      prediction.reconcile(serverEntity, 1, []);

      const state = prediction.getPredicted();
      expect(state.pos).toEqual({ x: 5, y: 0, z: 5 });
    });

    it('replays unacknowledged inputs', () => {
      // Server position at (0,0,0), but we have unacked input to move forward
      const serverEntity: EntitySnapshot = {
        id: 'player',
        name: 'Player',
        class: 'Mage',
        team: 'friendly',
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        yaw: 0,
        hp: 100,
        maxHp: 100,
        alive: true,
        debuffs: [],
        castingAbilityId: null,
        castProgress: 0,
      };

      const unacked: MoveInput[] = [
        { type: 'MoveInput', seq: 2, dz: 1, dx: 0, jump: false, yaw: 0, dt: 0.1 },
      ];

      prediction.reconcile(serverEntity, 1, unacked);

      const state = prediction.getPredicted();
      // Should have moved forward from (0,0,0) after replaying input
      expect(state.pos.z).toBeLessThan(0);
    });

    it('snaps on large error', () => {
      // Start far away
      prediction.initialize({ x: 100, y: 0, z: 100 });

      // Server says we're at origin
      const serverEntity: EntitySnapshot = {
        id: 'player',
        name: 'Player',
        class: 'Mage',
        team: 'friendly',
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        yaw: 0,
        hp: 100,
        maxHp: 100,
        alive: true,
        debuffs: [],
        castingAbilityId: null,
        castProgress: 0,
      };

      prediction.reconcile(serverEntity, 0, []);

      // Should have snapped to server position
      expect(prediction.getErrorMagnitude()).toBe(0);
      expect(prediction.getPredicted().pos).toEqual({ x: 0, y: 0, z: 0 });
    });
  });

  describe('updateErrorSmoothing', () => {
    it('reduces error over time', () => {
      // Create some artificial error via a medium-sized reconcile
      prediction.initialize({ x: 1, y: 0, z: 0 });

      const serverEntity: EntitySnapshot = {
        id: 'player',
        name: 'Player',
        class: 'Mage',
        team: 'friendly',
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        yaw: 0,
        hp: 100,
        maxHp: 100,
        alive: true,
        debuffs: [],
        castingAbilityId: null,
        castProgress: 0,
      };

      prediction.reconcile(serverEntity, 0, []);
      const initialError = prediction.getErrorMagnitude();

      // Simulate several frames of smoothing
      for (let i = 0; i < 10; i++) {
        prediction.updateErrorSmoothing(0.016);
      }

      expect(prediction.getErrorMagnitude()).toBeLessThan(initialError);
    });
  });

  describe('getRenderPosition', () => {
    it('includes error offset', () => {
      prediction.initialize({ x: 1, y: 0, z: 0 });

      // Reconcile to origin - will create error if threshold is passed
      const serverEntity: EntitySnapshot = {
        id: 'player',
        name: 'Player',
        class: 'Mage',
        team: 'friendly',
        pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        yaw: 0,
        hp: 100,
        maxHp: 100,
        alive: true,
        debuffs: [],
        castingAbilityId: null,
        castProgress: 0,
      };

      prediction.reconcile(serverEntity, 0, []);

      const renderPos = prediction.getRenderPosition();
      const predictedPos = prediction.getPredicted().pos;

      // Render position should differ from predicted by error amount
      const diff = Math.abs(renderPos.x - predictedPos.x) +
                   Math.abs(renderPos.y - predictedPos.y) +
                   Math.abs(renderPos.z - predictedPos.z);

      expect(diff).toBeCloseTo(prediction.getErrorMagnitude(), 2);
    });
  });

  describe('isGrounded', () => {
    it('returns true when on ground', () => {
      prediction.initialize({ x: 0, y: 0, z: 0 });
      expect(prediction.isGrounded()).toBe(true);
    });

    it('returns false when airborne', () => {
      prediction.initialize({ x: 0, y: 0, z: 0 });
      prediction.applyInput({ type: 'MoveInput', seq: 1, dz: 0, dx: 0, jump: true, yaw: 0, dt: 0.016 });
      expect(prediction.isGrounded()).toBe(false);
    });
  });
});
