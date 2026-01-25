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
  type MoveInput,
  type AbilityInput,
  type Welcome,
  type Pong,
  type GameEvent,
} from '../../src/shared/protocol';
import { ServerGameState } from './state';
import { InputProcessor } from './input';
import {
  executeAbility,
  completeCast,
  updateProjectiles,
  updateDebuffs,
  updateRespawns,
} from './abilities';
import {
  buildSnapshot,
  buildEventsMessage,
  createEventQueue,
  pushEvents,
  flushEvents,
  type EventQueue,
} from './snapshot';

// ============================================================================
// Types
// ============================================================================

export interface ClientConnection {
  id: string;
  ws: WebSocket;
  playerId: string;
  entityId: string;
  targetId: string | null;
  lastInputSeq: number;
  connectedAt: number;
  pendingAbility: AbilityInput | null;
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

  // Game state
  private state: ServerGameState = new ServerGameState();
  private inputProcessor: InputProcessor = new InputProcessor();
  private eventQueue: EventQueue = createEventQueue();

  private readonly config: ServerConfig;

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = {
      port: config.port ?? 8080,
      tickRate: config.tickRate ?? SERVER_TICK_RATE,
    };
  }

  // Expose state for testing
  getState(): ServerGameState {
    return this.state;
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
    const entityId = `entity_${clientId}`;

    // Spawn entity for this player
    const team = this.clients.size % 2 === 0 ? 'friendly' : 'enemy';
    const className = team === 'friendly' ? 'Mage' : 'Warrior';
    this.state.spawnEntity(entityId, playerId, className, team);

    // Initialize input processor for this player
    this.inputProcessor.initPlayer(playerId, entityId, this.state);

    const client: ClientConnection = {
      id: clientId,
      ws,
      playerId,
      entityId,
      targetId: null,
      lastInputSeq: 0,
      connectedAt: Date.now(),
      pendingAbility: null,
    };

    this.clients.set(clientId, client);
    console.log(`[Server] Client connected: ${clientId} as ${className} (${this.clients.size} total)`);

    // Emit entity spawned event
    const entity = this.state.getEntity(entityId)!;
    pushEvents(this.eventQueue, [{
      type: 'EntitySpawned',
      tick: this.currentTick,
      entity: this.state.buildEntitySnapshot(entity),
    }]);

    // Send welcome message
    const welcome: Welcome = {
      type: 'Welcome',
      playerId,
      tick: this.currentTick,
      serverTime: Date.now(),
    };
    this.send(client, welcome);

    // Send current snapshot so client knows the state
    const snapshot = buildSnapshot(this.state, 0);
    this.send(client, snapshot);

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
      // Remove entity
      this.state.removeEntity(entityId);
      this.inputProcessor.removePlayer(playerId);
      this.clients.delete(clientId);

      // Emit entity removed event
      pushEvents(this.eventQueue, [{
        type: 'EntityRemoved',
        tick: this.currentTick,
        entityId,
        reason: 'disconnect',
      }]);

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
        this.handleMoveInput(client, msg);
        break;

      case 'AbilityInput':
        this.handleAbilityInput(client, msg);
        break;

      case 'SetTarget':
        client.lastInputSeq = msg.seq;
        client.targetId = msg.targetId;
        break;

      case 'SelectClass':
        client.lastInputSeq = msg.seq;
        // TODO: Handle class selection (respawn as new class)
        break;
    }
  }

  private handleMoveInput(client: ClientConnection, msg: MoveInput): void {
    const result = this.inputProcessor.processMoveInput(
      client.playerId,
      client.entityId,
      msg,
      this.state,
      this.currentTick
    );

    if (result.success) {
      client.lastInputSeq = result.seq;
    }
  }

  private handleAbilityInput(client: ClientConnection, msg: AbilityInput): void {
    // Use client's current target if not specified in message
    const targetId = msg.targetId ?? client.targetId;
    const inputWithTarget: AbilityInput = { ...msg, targetId };

    const result = this.inputProcessor.processAbilityInput(
      client.playerId,
      client.entityId,
      inputWithTarget,
      this.state,
      this.currentTick
    );

    if (result.success) {
      client.lastInputSeq = result.seq;
      // Queue the ability for execution in tick
      client.pendingAbility = inputWithTarget;
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
    this.state.setTick(this.currentTick);

    // Reset input processor rate limits
    this.inputProcessor.resetTick(this.currentTick);

    // Process pending abilities
    for (const client of this.clients.values()) {
      if (client.pendingAbility) {
        const result = executeAbility(
          this.state,
          client.entityId,
          client.pendingAbility.abilityId,
          client.pendingAbility.targetId
        );

        if (result.events.length > 0) {
          pushEvents(this.eventQueue, result.events);
        }

        // Sync physics state after teleports
        if (client.pendingAbility.abilityId === 'rogue_shadowstep' ||
            client.pendingAbility.abilityId === 'mage_blink') {
          this.inputProcessor.syncPhysicsState(client.playerId, client.entityId, this.state);
        }

        client.pendingAbility = null;
      }
    }

    // Check for completed casts
    for (const { entityId, cast } of this.state.getCompletedCasts()) {
      const events = completeCast(this.state, entityId, cast);
      pushEvents(this.eventQueue, events);
    }

    // Update projectiles
    const dt = 1 / this.config.tickRate;
    const projectileEvents = updateProjectiles(this.state, dt);
    pushEvents(this.eventQueue, projectileEvents);

    // Update debuffs
    const debuffEvents = updateDebuffs(this.state);
    pushEvents(this.eventQueue, debuffEvents);

    // Update respawns
    const respawnEvents = updateRespawns(this.state);
    pushEvents(this.eventQueue, respawnEvents);

    // Broadcast events
    const events = flushEvents(this.eventQueue);
    if (events.length > 0) {
      const eventsMsg = buildEventsMessage(events);
      if (eventsMsg) {
        this.broadcast(eventsMsg);
      }
    }

    // Broadcast snapshot to all clients
    for (const client of this.clients.values()) {
      const ackedSeq = this.inputProcessor.getLastSeq(client.playerId);
      const snapshot = buildSnapshot(this.state, ackedSeq);
      this.send(client, snapshot);
    }
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
