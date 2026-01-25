/**
 * Client-side prediction and server reconciliation
 *
 * Handles:
 * - Local movement prediction for instant responsiveness
 * - Server state reconciliation when snapshots arrive
 * - Replay of unacknowledged inputs after correction
 */

import type { Vec3 } from '../shared/types';
import type { MoveInput, EntitySnapshot } from '../shared/protocol';
import {
  MOVE_SPEED,
  JUMP_FORCE,
  GRAVITY,
  ARENA_BOUND,
} from '../shared/physics';

// ============================================================================
// Types
// ============================================================================

export interface PredictedState {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  isGrounded: boolean;
}

export interface PredictionConfig {
  snapThreshold: number;     // Distance to snap vs blend
  blendSpeed: number;        // How fast to blend toward server pos
  maxPredictionError: number; // Max allowed prediction error before forced snap
}

// ============================================================================
// ClientPrediction
// ============================================================================

export class ClientPrediction {
  private config: PredictionConfig;

  // Current predicted state
  private predicted: PredictedState = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    isGrounded: true,
  };

  // Last server-confirmed state
  private serverState: PredictedState | null = null;

  // Error tracking for smoothing
  private positionError: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(config: Partial<PredictionConfig> = {}) {
    this.config = {
      snapThreshold: 0.5,      // Snap if error > 0.5 units
      blendSpeed: 10,          // Units per second to correct
      maxPredictionError: 3,   // Force snap if > 3 units off
      ...config,
    };
  }

  /**
   * Initialize predicted state
   */
  initialize(pos: Vec3, yaw: number = 0): void {
    this.predicted = {
      pos: { ...pos },
      vel: { x: 0, y: 0, z: 0 },
      yaw,
      isGrounded: pos.y <= 0.01,
    };
    this.serverState = null;
    this.positionError = { x: 0, y: 0, z: 0 };
  }

  /**
   * Apply input locally for prediction
   */
  applyInput(input: MoveInput): PredictedState {
    // Calculate movement direction from yaw
    // dx/dz are in local space (forward/right), transform to world space
    const forward = {
      x: -Math.sin(input.yaw),
      z: -Math.cos(input.yaw),
    };
    const right = {
      x: forward.z,
      z: -forward.x,
    };

    // Build movement vector (dz is forward/back, dx is left/right)
    let moveX = right.x * input.dx + forward.x * input.dz;
    let moveZ = right.z * input.dx + forward.z * input.dz;

    // Normalize if diagonal
    const moveLen = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (moveLen > 1) {
      moveX /= moveLen;
      moveZ /= moveLen;
    }

    // Apply horizontal velocity
    if (moveLen > 0) {
      this.predicted.vel.x = moveX * MOVE_SPEED;
      this.predicted.vel.z = moveZ * MOVE_SPEED;
    } else {
      this.predicted.vel.x = 0;
      this.predicted.vel.z = 0;
    }

    // Handle jump
    if (input.jump && this.predicted.isGrounded) {
      this.predicted.vel.y = JUMP_FORCE;
      this.predicted.isGrounded = false;
    }

    // Apply gravity if not grounded
    if (!this.predicted.isGrounded) {
      this.predicted.vel.y -= GRAVITY * input.dt;
    }

    // Update position
    this.predicted.pos.x += this.predicted.vel.x * input.dt;
    this.predicted.pos.y += this.predicted.vel.y * input.dt;
    this.predicted.pos.z += this.predicted.vel.z * input.dt;

    // Ground check
    if (this.predicted.pos.y <= 0) {
      this.predicted.pos.y = 0;
      this.predicted.vel.y = 0;
      this.predicted.isGrounded = true;
    }

    // Arena bounds
    this.predicted.pos.x = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, this.predicted.pos.x));
    this.predicted.pos.z = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, this.predicted.pos.z));

    // Update yaw
    this.predicted.yaw = input.yaw;

    return { ...this.predicted };
  }

  /**
   * Reconcile with server state
   * @param serverEntity Server's authoritative entity state
   * @param ackedSeq Sequence number server has processed up to
   * @param unackedInputs Inputs not yet acknowledged by server
   */
  reconcile(
    serverEntity: EntitySnapshot,
    _ackedSeq: number,
    unackedInputs: MoveInput[]
  ): PredictedState {
    // Store server state
    this.serverState = {
      pos: { ...serverEntity.pos },
      vel: { ...serverEntity.vel },
      yaw: serverEntity.yaw,
      isGrounded: serverEntity.pos.y <= 0.01,
    };

    // Start from server position
    const reconciled: PredictedState = {
      pos: { ...serverEntity.pos },
      vel: { ...serverEntity.vel },
      yaw: serverEntity.yaw,
      isGrounded: serverEntity.pos.y <= 0.01,
    };

    // Replay unacknowledged inputs
    for (const input of unackedInputs) {
      this.applyInputToState(reconciled, input);
    }

    // Calculate error between predicted and reconciled
    const errorX = this.predicted.pos.x - reconciled.pos.x;
    const errorY = this.predicted.pos.y - reconciled.pos.y;
    const errorZ = this.predicted.pos.z - reconciled.pos.z;
    const errorMag = Math.sqrt(errorX * errorX + errorY * errorY + errorZ * errorZ);

    if (errorMag > this.config.maxPredictionError) {
      // Large error - snap immediately
      this.predicted = { ...reconciled };
      this.positionError = { x: 0, y: 0, z: 0 };
    } else if (errorMag > this.config.snapThreshold) {
      // Medium error - store for gradual correction
      this.predicted = { ...reconciled };
      this.positionError = { x: errorX, y: errorY, z: errorZ };
    } else {
      // Small error - update predicted silently
      this.predicted = { ...reconciled };
      this.positionError = { x: 0, y: 0, z: 0 };
    }

    return { ...this.predicted };
  }

  /**
   * Update error smoothing (call each frame)
   */
  updateErrorSmoothing(dt: number): void {
    const blendAmount = this.config.blendSpeed * dt;

    // Reduce error over time
    const errorMag = Math.sqrt(
      this.positionError.x ** 2 +
      this.positionError.y ** 2 +
      this.positionError.z ** 2
    );

    if (errorMag < 0.01) {
      this.positionError = { x: 0, y: 0, z: 0 };
      return;
    }

    const reduction = Math.min(blendAmount, errorMag);
    const scale = (errorMag - reduction) / errorMag;

    this.positionError.x *= scale;
    this.positionError.y *= scale;
    this.positionError.z *= scale;
  }

  /**
   * Get render position (predicted + error offset for smoothing)
   */
  getRenderPosition(): Vec3 {
    return {
      x: this.predicted.pos.x + this.positionError.x,
      y: this.predicted.pos.y + this.positionError.y,
      z: this.predicted.pos.z + this.positionError.z,
    };
  }

  /**
   * Get predicted state
   */
  getPredicted(): PredictedState {
    return { ...this.predicted };
  }

  /**
   * Get last server state
   */
  getServerState(): PredictedState | null {
    return this.serverState ? { ...this.serverState } : null;
  }

  /**
   * Get current position error magnitude
   */
  getErrorMagnitude(): number {
    return Math.sqrt(
      this.positionError.x ** 2 +
      this.positionError.y ** 2 +
      this.positionError.z ** 2
    );
  }

  /**
   * Check if grounded
   */
  isGrounded(): boolean {
    return this.predicted.isGrounded;
  }

  /**
   * Get debug info
   */
  getDebugInfo(): string {
    const error = this.getErrorMagnitude();
    return `Predicted: (${this.predicted.pos.x.toFixed(1)}, ${this.predicted.pos.y.toFixed(1)}, ${this.predicted.pos.z.toFixed(1)}) | Error: ${error.toFixed(3)}`;
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private applyInputToState(state: PredictedState, input: MoveInput): void {
    // Calculate movement direction from yaw
    const forward = {
      x: -Math.sin(input.yaw),
      z: -Math.cos(input.yaw),
    };
    const right = {
      x: forward.z,
      z: -forward.x,
    };

    // Build movement vector (dz is forward/back, dx is left/right)
    let moveX = right.x * input.dx + forward.x * input.dz;
    let moveZ = right.z * input.dx + forward.z * input.dz;

    // Normalize if diagonal
    const moveLen = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (moveLen > 1) {
      moveX /= moveLen;
      moveZ /= moveLen;
    }

    // Apply horizontal velocity
    if (moveLen > 0) {
      state.vel.x = moveX * MOVE_SPEED;
      state.vel.z = moveZ * MOVE_SPEED;
    } else {
      state.vel.x = 0;
      state.vel.z = 0;
    }

    // Handle jump
    if (input.jump && state.isGrounded) {
      state.vel.y = JUMP_FORCE;
      state.isGrounded = false;
    }

    // Apply gravity if not grounded
    if (!state.isGrounded) {
      state.vel.y -= GRAVITY * input.dt;
    }

    // Update position
    state.pos.x += state.vel.x * input.dt;
    state.pos.y += state.vel.y * input.dt;
    state.pos.z += state.vel.z * input.dt;

    // Ground check
    if (state.pos.y <= 0) {
      state.pos.y = 0;
      state.vel.y = 0;
      state.isGrounded = true;
    }

    // Arena bounds
    state.pos.x = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, state.pos.x));
    state.pos.z = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, state.pos.z));

    // Update yaw
    state.yaw = input.yaw;
  }
}
