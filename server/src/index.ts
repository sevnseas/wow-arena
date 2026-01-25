/**
 * Arena Server - WebSocket game server
 */

import { WebSocketServer, WebSocket } from 'ws';
import {
  SERVER_TICK_MS,
  SERVER_TICK_RATE,
} from '../../src/shared/physics';
import {
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type Welcome,
  type Pong,
} from '../../src/shared/protocol';

// ============================================================================
// Types
// ============================================================================

export interface ClientConnection {
  id: string;
  ws: WebSocket;
  playerId: string;
  lastInputSeq: number;
  connectedAt: number;
}

export interface ServerConfig {
  port: number;
  tickRate: number;
}

// ============================================================================
// Server
// ============================================================================

export class ArenaServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientConnection> = new Map();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private currentTick: number = 0;
  private nextClientId: number = 1;
  private running: boolean = false;

  private readonly config: ServerConfig;

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = {
      port: config.port ?? 8080,
      tickRate: config.tickRate ?? SERVER_TICK_RATE,
    };
  }

  /**
   * Start the server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.running) {
        reject(new Error('Server already running'));
        return;
      }

      this.wss = new WebSocketServer({ port: this.config.port });

      this.wss.on('listening', () => {
        console.log(`[Server] Listening on port ${this.config.port}`);
        this.running = true;
        this.startTickLoop();
        resolve();
      });

      this.wss.on('error', (err) => {
        console.error('[Server] WebSocket error:', err);
        reject(err);
      });

      this.wss.on('connection', (ws) => this.handleConnection(ws));
    });
  }

  /**
   * Stop the server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.running = false;

      // Stop tick loop
      if (this.tickInterval) {
        clearInterval(this.tickInterval);
        this.tickInterval = null;
      }

      // Close all client connections
      for (const client of this.clients.values()) {
        client.ws.close();
      }
      this.clients.clear();

      // Close server
      if (this.wss) {
        this.wss.close(() => {
          console.log('[Server] Stopped');
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get current tick
   */
  getCurrentTick(): number {
    return this.currentTick;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get all connected client IDs
   */
  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private handleConnection(ws: WebSocket): void {
    const clientId = `client_${this.nextClientId++}`;
    const playerId = `player_${clientId}`;

    const client: ClientConnection = {
      id: clientId,
      ws,
      playerId,
      lastInputSeq: 0,
      connectedAt: Date.now(),
    };

    this.clients.set(clientId, client);
    console.log(`[Server] Client connected: ${clientId} (${this.clients.size} total)`);

    // Send welcome message
    const welcome: Welcome = {
      type: 'Welcome',
      playerId,
      tick: this.currentTick,
      serverTime: Date.now(),
    };
    this.send(client, welcome);

    // Set up message handler
    ws.on('message', (data) => {
      try {
        const msg = decodeClientMessage(data.toString());
        if (msg) {
          this.handleMessage(client, msg);
        }
      } catch (err) {
        console.error(`[Server] Error parsing message from ${clientId}:`, err);
      }
    });

    // Set up close handler
    ws.on('close', () => {
      this.clients.delete(clientId);
      console.log(`[Server] Client disconnected: ${clientId} (${this.clients.size} remaining)`);
    });

    // Set up error handler
    ws.on('error', (err) => {
      console.error(`[Server] Client error ${clientId}:`, err);
    });
  }

  private handleMessage(client: ClientConnection, msg: ClientMessage): void {
    switch (msg.type) {
      case 'Ping':
        this.handlePing(client, msg.clientTime);
        break;

      case 'MoveInput':
        // Track sequence number
        client.lastInputSeq = msg.seq;
        // TODO: Process movement in Phase 4.5
        break;

      case 'AbilityInput':
        client.lastInputSeq = msg.seq;
        // TODO: Process ability in Phase 4.6
        break;

      case 'SetTarget':
        client.lastInputSeq = msg.seq;
        // TODO: Track target selection
        break;

      case 'SelectClass':
        client.lastInputSeq = msg.seq;
        // TODO: Handle class selection
        break;
    }
  }

  private handlePing(client: ClientConnection, clientTime: number): void {
    const pong: Pong = {
      type: 'Pong',
      clientTime,
      serverTime: Date.now(),
    };
    this.send(client, pong);
  }

  private send(client: ClientConnection, msg: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(encodeServerMessage(msg));
    }
  }

  private broadcast(msg: ServerMessage): void {
    const encoded = encodeServerMessage(msg);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(encoded);
      }
    }
  }

  private startTickLoop(): void {
    const tickMs = 1000 / this.config.tickRate;

    this.tickInterval = setInterval(() => {
      this.tick();
    }, tickMs);
  }

  private tick(): void {
    this.currentTick++;

    // TODO: In later phases:
    // - Process queued inputs
    // - Update physics
    // - Check projectile hits
    // - Update debuff timers
    // - Build and broadcast snapshot
  }
}

// ============================================================================
// Main entry point (when run directly)
// ============================================================================

// Check if this module is being run directly
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');

if (isMain) {
  const port = parseInt(process.env.PORT ?? '8080', 10);
  const server = new ArenaServer({ port });

  server.start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Server] Shutting down...');
    await server.stop();
    process.exit(0);
  });
}
