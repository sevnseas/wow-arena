/**
 * WebSocket connection manager for multiplayer
 */

import {
  encodeClientMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type Welcome,
} from '../shared/protocol';

// ============================================================================
// Types
// ============================================================================

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface SocketConfig {
  url: string;
  reconnectDelay: number;
  maxReconnectDelay: number;
  onMessage: (msg: ServerMessage) => void;
  onStateChange: (state: ConnectionState) => void;
  onWelcome: (welcome: Welcome) => void;
}

// ============================================================================
// GameSocket
// ============================================================================

export class GameSocket {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts: number = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private config: SocketConfig;

  // Player info received from server
  private playerId: string | null = null;

  constructor(config: SocketConfig) {
    this.config = config;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get player ID assigned by server
   */
  getPlayerId(): string | null {
    return this.playerId;
  }

  /**
   * Connect to server
   */
  connect(): void {
    if (this.state !== 'disconnected') {
      return;
    }

    this.setState('connecting');

    try {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        console.log('[Socket] WebSocket open, waiting for Welcome...');
        this.reconnectAttempts = 0;
        // State will be set to 'connected' when we receive Welcome
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = () => {
        console.log('[Socket] Disconnected');
        this.ws = null;
        this.setState('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('[Socket] Error:', error);
      };
    } catch (err) {
      console.error('[Socket] Failed to connect:', err);
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState('disconnected');
    this.playerId = null;
  }

  /**
   * Send a message to the server
   */
  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.ws.send(encodeClientMessage(msg));
      return true;
    } catch (err) {
      console.error('[Socket] Send error:', err);
      return false;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.config.onStateChange(newState);
    }
  }

  private handleMessage(data: string): void {
    const msg = decodeServerMessage(data);
    if (!msg) {
      console.warn('[Socket] Failed to decode message');
      return;
    }

    // Handle Welcome specially to track player ID and set connected state
    if (msg.type === 'Welcome') {
      this.playerId = msg.playerId;
      this.setState('connected');
      this.config.onWelcome(msg);
    }

    // Forward all messages to handler
    this.config.onMessage(msg);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.config.maxReconnectDelay
    );

    console.log(`[Socket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }
}

/**
 * Create a game socket with default config
 */
export function createGameSocket(
  url: string,
  onMessage: (msg: ServerMessage) => void,
  onStateChange: (state: ConnectionState) => void,
  onWelcome: (welcome: Welcome) => void
): GameSocket {
  return new GameSocket({
    url,
    reconnectDelay: 1000,
    maxReconnectDelay: 30000,
    onMessage,
    onStateChange,
    onWelcome,
  });
}
