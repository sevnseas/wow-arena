/**
 * Server Input Processing - handle and validate client inputs
 */

import type { MoveInput, AbilityInput } from '../../src/shared/protocol';
import type { ServerGameState } from './state';
import {
  applyMovement,
  type EntityPhysicsState,
  type MoveInputData,
} from './physics';
import { getAbilityById, MELEE_RANGE } from '../../src/shared/abilities';
import { SERVER_TICK_RATE } from '../../src/shared/physics';
import { vec3DistanceXZ } from './physics';

// ============================================================================
// Types
// ============================================================================

export interface InputQueueEntry {
  type: 'move' | 'ability';
  seq: number;
  receivedAt: number; // tick when received
  data: MoveInput | AbilityInput;
}

export interface PlayerInputState {
  lastSeq: number;
  lastInputTick: number;
  inputsThisTick: number;
  physicsState: EntityPhysicsState;
}

export interface InputProcessResult {
  success: boolean;
  error?: string;
  seq: number;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_INPUTS_PER_TICK = 3; // Rate limit: max inputs per server tick
const MAX_DT = 0.1; // Maximum delta time per input (100ms)
const MIN_DT = 0.001; // Minimum delta time (1ms)

// ============================================================================
// InputProcessor
// ============================================================================

export class InputProcessor {
  // Player input states
  private playerStates: Map<string, PlayerInputState> = new Map();

  /**
   * Initialize input state for a player
   */
  initPlayer(playerId: string, entityId: string, state: ServerGameState): void {
    const entity = state.getEntity(entityId);
    if (!entity) return;

    this.playerStates.set(playerId, {
      lastSeq: 0,
      lastInputTick: 0,
      inputsThisTick: 0,
      physicsState: {
        pos: { ...entity.pos },
        vel: { ...entity.vel },
        isGrounded: true,
        groundLevel: 0,
      },
    });
  }

  /**
   * Remove player from input tracking
   */
  removePlayer(playerId: string): void {
    this.playerStates.delete(playerId);
  }

  /**
   * Reset input counts for new tick
   */
  resetTick(currentTick: number): void {
    for (const state of this.playerStates.values()) {
      if (state.lastInputTick < currentTick) {
        state.inputsThisTick = 0;
      }
    }
  }

  /**
   * Get last acknowledged sequence number for player
   */
  getLastSeq(playerId: string): number {
    return this.playerStates.get(playerId)?.lastSeq ?? 0;
  }

  /**
   * Process a move input
   */
  processMoveInput(
    playerId: string,
    entityId: string,
    input: MoveInput,
    state: ServerGameState,
    currentTick: number
  ): InputProcessResult {
    const playerState = this.playerStates.get(playerId);
    if (!playerState) {
      return { success: false, error: 'Player not initialized', seq: input.seq };
    }

    const entity = state.getEntity(entityId);
    if (!entity) {
      return { success: false, error: 'Entity not found', seq: input.seq };
    }

    if (!entity.alive) {
      return { success: false, error: 'Entity is dead', seq: input.seq };
    }

    // Rate limiting
    if (playerState.lastInputTick === currentTick) {
      playerState.inputsThisTick++;
      if (playerState.inputsThisTick > MAX_INPUTS_PER_TICK) {
        return { success: false, error: 'Rate limited', seq: input.seq };
      }
    } else {
      playerState.lastInputTick = currentTick;
      playerState.inputsThisTick = 1;
    }

    // Validate sequence number (must be newer)
    if (input.seq <= playerState.lastSeq) {
      return { success: false, error: 'Old sequence number', seq: input.seq };
    }

    // Validate delta time
    const dt = Math.max(MIN_DT, Math.min(MAX_DT, input.dt));

    // Check if player is CC'd (can't move)
    if (state.hasDebuffWithTag(entityId, 'cc')) {
      // Player is CC'd - don't apply movement, but still ack the input
      playerState.lastSeq = input.seq;
      return { success: true, seq: input.seq };
    }

    // Check if casting (movement cancels cast)
    const activeCast = state.getActiveCast(entityId);
    if (activeCast && (Math.abs(input.dx) > 0.1 || Math.abs(input.dz) > 0.1)) {
      // Moving while casting - interrupt cast
      state.interruptCast(entityId);
    }

    // Build move input data
    const moveData: MoveInputData = {
      dx: Math.max(-1, Math.min(1, input.dx)),
      dz: Math.max(-1, Math.min(1, input.dz)),
      yaw: input.yaw,
      jump: input.jump,
    };

    // Apply physics
    const newPhysicsState = applyMovement(playerState.physicsState, moveData, dt);

    // Validate movement (basic speed check)
    const distMoved = vec3DistanceXZ(playerState.physicsState.pos, newPhysicsState.pos);
    const maxDist = 10 * dt; // Max 10 units/sec (some buffer for blink)

    if (distMoved > maxDist) {
      // Suspicious movement - clamp it
      // For now, just reject but in production you might want to log this
      return { success: false, error: 'Movement too fast', seq: input.seq };
    }

    // Update physics state
    playerState.physicsState = newPhysicsState;

    // Apply to game state
    state.setPosition(entityId, newPhysicsState.pos);
    state.setVelocity(entityId, newPhysicsState.vel);
    state.setYaw(entityId, input.yaw);

    // Update sequence
    playerState.lastSeq = input.seq;

    return { success: true, seq: input.seq };
  }

  /**
   * Process an ability input
   * Returns error string if ability cannot be used, null if queued/executed
   */
  processAbilityInput(
    playerId: string,
    entityId: string,
    input: AbilityInput,
    state: ServerGameState,
    currentTick: number
  ): InputProcessResult {
    const playerState = this.playerStates.get(playerId);
    if (!playerState) {
      return { success: false, error: 'Player not initialized', seq: input.seq };
    }

    const entity = state.getEntity(entityId);
    if (!entity) {
      return { success: false, error: 'Entity not found', seq: input.seq };
    }

    if (!entity.alive) {
      return { success: false, error: 'Entity is dead', seq: input.seq };
    }

    // Rate limiting (same as move input)
    if (playerState.lastInputTick === currentTick) {
      playerState.inputsThisTick++;
      if (playerState.inputsThisTick > MAX_INPUTS_PER_TICK) {
        return { success: false, error: 'Rate limited', seq: input.seq };
      }
    } else {
      playerState.lastInputTick = currentTick;
      playerState.inputsThisTick = 1;
    }

    // Get ability definition
    const ability = getAbilityById(input.abilityId);
    if (!ability) {
      return { success: false, error: 'Unknown ability', seq: input.seq };
    }

    // Check if CC'd
    if (state.hasDebuffWithTag(entityId, 'cc')) {
      return { success: false, error: 'Cannot cast while CC\'d', seq: input.seq };
    }

    // Check if already casting
    if (state.getActiveCast(entityId)) {
      return { success: false, error: 'Already casting', seq: input.seq };
    }

    // Check cooldown
    if (state.isOnCooldown(entityId, input.abilityId)) {
      return { success: false, error: 'Ability on cooldown', seq: input.seq };
    }

    // Check target requirements
    if (ability.requiresTarget) {
      if (!input.targetId) {
        return { success: false, error: 'Requires target', seq: input.seq };
      }

      const target = state.getEntity(input.targetId);
      if (!target) {
        return { success: false, error: 'Target not found', seq: input.seq };
      }

      if (!target.alive) {
        return { success: false, error: 'Target is dead', seq: input.seq };
      }

      // Check range
      const range = ability.range === -1 ? MELEE_RANGE : ability.range;
      if (range > 0) {
        const dist = vec3DistanceXZ(entity.pos, target.pos);
        if (dist > range) {
          return { success: false, error: 'Out of range', seq: input.seq };
        }
      }
    }

    // Update sequence
    playerState.lastSeq = input.seq;

    // Ability is valid - actual execution happens in abilities.ts
    // This just validates the input; the server tick will call executeAbility
    return { success: true, seq: input.seq };
  }

  /**
   * Sync physics state with game state (call after teleports, etc.)
   */
  syncPhysicsState(playerId: string, entityId: string, state: ServerGameState): void {
    const playerState = this.playerStates.get(playerId);
    const entity = state.getEntity(entityId);

    if (playerState && entity) {
      playerState.physicsState.pos = { ...entity.pos };
      playerState.physicsState.vel = { ...entity.vel };
    }
  }
}
