/**
 * Client input manager - sends inputs to server with sequence numbers
 */

import type { GameSocket } from './socket';
import type { MoveInput, AbilityInput } from '../shared/protocol';

// ============================================================================
// Types
// ============================================================================

export interface PendingInput {
  seq: number;
  type: 'move' | 'ability';
  input: MoveInput | AbilityInput;
  timestamp: number;
}

export interface InputManagerConfig {
  maxPendingInputs: number;  // Max inputs to keep for reconciliation
}

// ============================================================================
// InputManager
// ============================================================================

export class InputManager {
  private socket: GameSocket;
  private config: InputManagerConfig;

  // Sequence number for input ordering
  private sequence: number = 0;

  // Pending inputs awaiting server acknowledgment
  private pendingInputs: PendingInput[] = [];

  // Last acknowledged sequence from server
  private lastAckedSeq: number = 0;

  constructor(socket: GameSocket, config: Partial<InputManagerConfig> = {}) {
    this.socket = socket;
    this.config = {
      maxPendingInputs: 120,  // ~2 seconds at 60fps
      ...config,
    };
  }

  /**
   * Send movement input to server
   * @param dz Forward/backward input (-1 to 1, positive = forward)
   * @param dx Left/right input (-1 to 1, positive = right)
   */
  sendMoveInput(
    dz: number,
    dx: number,
    jump: boolean,
    yaw: number,
    dt: number
  ): PendingInput | null {
    if (!this.socket.isConnected()) {
      return null;
    }

    const seq = ++this.sequence;
    const input: MoveInput = {
      type: 'MoveInput',
      seq,
      dx,
      dz,
      jump,
      yaw,
      dt,
    };

    const pending: PendingInput = {
      seq,
      type: 'move',
      input,
      timestamp: Date.now(),
    };

    this.addPendingInput(pending);
    this.socket.send(input);

    return pending;
  }

  /**
   * Send ability input to server
   */
  sendAbilityInput(abilityId: string, targetId: string | null): PendingInput | null {
    if (!this.socket.isConnected()) {
      return null;
    }

    const seq = ++this.sequence;
    const input: AbilityInput = {
      type: 'AbilityInput',
      seq,
      abilityId,
      targetId,
    };

    const pending: PendingInput = {
      seq,
      type: 'ability',
      input,
      timestamp: Date.now(),
    };

    this.addPendingInput(pending);
    this.socket.send(input);

    return pending;
  }

  /**
   * Handle server acknowledgment of inputs
   */
  acknowledgeUpTo(ackedSeq: number): PendingInput[] {
    if (ackedSeq <= this.lastAckedSeq) {
      return [];
    }

    const prevAcked = this.lastAckedSeq;
    this.lastAckedSeq = ackedSeq;

    // Log significant acknowledgment gaps (more than 5 inputs at once)
    if (ackedSeq - prevAcked > 5) {
      console.log(`[InputManager] Acked ${ackedSeq - prevAcked} inputs (${prevAcked} -> ${ackedSeq})`);
    }

    // Remove acknowledged inputs and return them
    const acknowledged: PendingInput[] = [];
    this.pendingInputs = this.pendingInputs.filter((pending) => {
      if (pending.seq <= ackedSeq) {
        acknowledged.push(pending);
        return false;
      }
      return true;
    });

    return acknowledged;
  }

  /**
   * Get inputs that haven't been acknowledged yet (for reconciliation)
   */
  getUnacknowledgedInputs(): PendingInput[] {
    return [...this.pendingInputs];
  }

  /**
   * Get move inputs that haven't been acknowledged (for prediction replay)
   */
  getUnacknowledgedMoveInputs(): MoveInput[] {
    return this.pendingInputs
      .filter((p) => p.type === 'move')
      .map((p) => p.input as MoveInput);
  }

  /**
   * Get current sequence number
   */
  getSequence(): number {
    return this.sequence;
  }

  /**
   * Get last acknowledged sequence
   */
  getLastAckedSeq(): number {
    return this.lastAckedSeq;
  }

  /**
   * Get count of pending inputs
   */
  getPendingCount(): number {
    return this.pendingInputs.length;
  }

  /**
   * Reset state (on disconnect)
   */
  reset(): void {
    this.sequence = 0;
    this.pendingInputs = [];
    this.lastAckedSeq = 0;
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private addPendingInput(pending: PendingInput): void {
    this.pendingInputs.push(pending);

    // Trim old inputs if we have too many
    while (this.pendingInputs.length > this.config.maxPendingInputs) {
      this.pendingInputs.shift();
    }
  }
}
