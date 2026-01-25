/**
 * Network clock - RTT measurement and server time synchronization
 */

import type { GameSocket } from './socket';
import type { Pong } from '../shared/protocol';

// ============================================================================
// Types
// ============================================================================

export interface ClockState {
  rtt: number;           // Round-trip time in ms
  serverOffset: number;  // Local time - server time
  lastPingTime: number;
  sampleCount: number;
}

// ============================================================================
// NetworkClock
// ============================================================================

export class NetworkClock {
  private socket: GameSocket;
  private state: ClockState = {
    rtt: 0,
    serverOffset: 0,
    lastPingTime: 0,
    sampleCount: 0,
  };

  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pendingPingTime: number | null = null;

  // Smoothing factor for exponential moving average
  private readonly smoothingFactor = 0.2;

  constructor(socket: GameSocket) {
    this.socket = socket;
  }

  /**
   * Start periodic ping/pong for RTT measurement
   */
  start(intervalMs: number = 2000): void {
    this.stop();

    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, intervalMs);

    // Send initial ping immediately
    this.sendPing();
  }

  /**
   * Stop RTT measurement
   */
  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Handle Pong message from server
   */
  handlePong(pong: Pong): void {
    if (this.pendingPingTime === null) {
      return;
    }

    const now = Date.now();
    const rtt = now - pong.clientTime;
    const oneWayDelay = rtt / 2;

    // Estimate server time at the moment we received the pong
    // Server sent pong at pong.serverTime, we received it after oneWayDelay
    const estimatedServerTime = pong.serverTime + oneWayDelay;
    const offset = now - estimatedServerTime;

    this.state.sampleCount++;

    if (this.state.sampleCount === 1) {
      // First sample - use directly
      this.state.rtt = rtt;
      this.state.serverOffset = offset;
      console.log(`[Clock] First RTT sample: ${rtt.toFixed(0)}ms, offset: ${offset.toFixed(0)}ms`);
    } else {
      // Exponential moving average for smoothing
      this.state.rtt = this.state.rtt * (1 - this.smoothingFactor) + rtt * this.smoothingFactor;
      this.state.serverOffset = this.state.serverOffset * (1 - this.smoothingFactor) + offset * this.smoothingFactor;

      // Log every 5th sample to avoid spam
      if (this.state.sampleCount % 5 === 0) {
        console.log(`[Clock] RTT: ${this.state.rtt.toFixed(0)}ms (sample #${this.state.sampleCount})`);
      }
    }

    this.state.lastPingTime = now;
    this.pendingPingTime = null;
  }

  /**
   * Get current RTT estimate in milliseconds
   */
  getRTT(): number {
    return this.state.rtt;
  }

  /**
   * Get estimated one-way latency
   */
  getLatency(): number {
    return this.state.rtt / 2;
  }

  /**
   * Convert local time to estimated server time
   */
  toServerTime(localTime: number): number {
    return localTime - this.state.serverOffset;
  }

  /**
   * Convert server time to local time
   */
  toLocalTime(serverTime: number): number {
    return serverTime + this.state.serverOffset;
  }

  /**
   * Get current estimated server time
   */
  getServerTime(): number {
    return this.toServerTime(Date.now());
  }

  /**
   * Check if clock has been synchronized
   */
  isSynced(): boolean {
    return this.state.sampleCount >= 3;
  }

  /**
   * Get debug info
   */
  getDebugInfo(): string {
    return `RTT: ${this.state.rtt.toFixed(0)}ms | Offset: ${this.state.serverOffset.toFixed(0)}ms | Samples: ${this.state.sampleCount}`;
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private sendPing(): void {
    if (!this.socket.isConnected()) {
      return;
    }

    const now = Date.now();
    this.pendingPingTime = now;

    this.socket.send({
      type: 'Ping',
      clientTime: now,
    });
  }
}
