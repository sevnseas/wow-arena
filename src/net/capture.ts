/**
 * Input capture - reads keyboard state and sends to server
 */

import type { InputManager, PendingInput } from './input';

// ============================================================================
// Types
// ============================================================================

export interface InputState {
  forward: number;   // -1 to 1 (W/S or up/down)
  right: number;     // -1 to 1 (A/D or left/right)
  jump: boolean;     // Space pressed this frame
  yaw: number;       // Camera yaw
}

export interface InputCaptureConfig {
  sendRate: number;  // How often to send inputs (Hz)
}

// ============================================================================
// InputCapture
// ============================================================================

export class InputCapture {
  private config: InputCaptureConfig;
  private inputManager: InputManager;

  // Keyboard state
  private keys: Set<string> = new Set();
  private jumpPressed: boolean = false;

  // Send timing
  private lastSendTime: number = 0;
  private sendInterval: number;

  // Callbacks
  private getYaw: () => number;
  private onInputSent?: (pending: PendingInput) => void;

  // Bound handlers for cleanup
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;

  constructor(
    inputManager: InputManager,
    getYaw: () => number,
    config: Partial<InputCaptureConfig> = {}
  ) {
    this.inputManager = inputManager;
    this.getYaw = getYaw;
    this.config = {
      sendRate: 20,  // Match server tick rate
      ...config,
    };
    this.sendInterval = 1000 / this.config.sendRate;

    this.boundKeyDown = this.onKeyDown.bind(this);
    this.boundKeyUp = this.onKeyUp.bind(this);
  }

  /**
   * Set callback for when input is sent
   */
  setOnInputSent(callback: (pending: PendingInput) => void): void {
    this.onInputSent = callback;
  }

  /**
   * Attach keyboard listeners
   */
  attach(): void {
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
  }

  /**
   * Detach keyboard listeners
   */
  detach(): void {
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    this.keys.clear();
    this.jumpPressed = false;
  }

  /**
   * Get current input state (for local prediction)
   */
  getInputState(): InputState {
    return {
      forward: this.getForward(),
      right: this.getRight(),
      jump: this.jumpPressed,
      yaw: this.getYaw(),
    };
  }

  /**
   * Send move input if enough time has passed
   * Call this every frame
   * @returns PendingInput if sent, null otherwise
   */
  update(dt: number): PendingInput | null {
    const now = Date.now();
    const timeSinceLastSend = now - this.lastSendTime;

    if (timeSinceLastSend < this.sendInterval) {
      // Clear jump flag after checking - it's per-frame
      this.jumpPressed = false;
      return null;
    }

    // Build and send input
    const forward = this.getForward();
    const right = this.getRight();
    const yaw = this.getYaw();
    const jump = this.jumpPressed;

    // Only send if there's actual input or we're sending keep-alive
    const hasInput = forward !== 0 || right !== 0 || jump;

    // Reset jump flag
    this.jumpPressed = false;

    if (!hasInput && timeSinceLastSend < this.sendInterval * 5) {
      // No input and recent send - skip
      return null;
    }

    const pending = this.inputManager.sendMoveInput(
      forward,
      right,
      jump,
      yaw,
      dt
    );

    if (pending) {
      this.lastSendTime = now;
      this.onInputSent?.(pending);
    }

    return pending;
  }

  /**
   * Send ability input immediately
   */
  sendAbility(abilityId: string, targetId: string | null): PendingInput | null {
    return this.inputManager.sendAbilityInput(abilityId, targetId);
  }

  /**
   * Check if a specific key is pressed
   */
  isKeyPressed(code: string): boolean {
    return this.keys.has(code.toLowerCase());
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private onKeyDown(e: KeyboardEvent): void {
    const code = e.code.toLowerCase();
    this.keys.add(code);

    // Track jump press
    if (e.code === 'Space') {
      this.jumpPressed = true;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code.toLowerCase());
  }

  private getForward(): number {
    let forward = 0;
    if (this.keys.has('keyw') || this.keys.has('arrowup')) {
      forward += 1;
    }
    if (this.keys.has('keys') || this.keys.has('arrowdown')) {
      forward -= 1;
    }
    return forward;
  }

  private getRight(): number {
    let right = 0;
    if (this.keys.has('keyd') || this.keys.has('arrowright')) {
      right += 1;
    }
    if (this.keys.has('keya') || this.keys.has('arrowleft')) {
      right -= 1;
    }
    return right;
  }
}
