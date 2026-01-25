/**
 * NetworkGame - Orchestrates multiplayer client networking
 *
 * Coordinates:
 * - WebSocket connection
 * - Clock synchronization
 * - Input capture and sending
 * - State management and interpolation
 * - Client-side prediction
 */

import { GameSocket, ConnectionState } from './socket';
import { NetworkClock } from './clock';
import { InputManager } from './input';
import { InputCapture } from './capture';
import { NetworkState, InterpolatedEntity } from './state';
import { ClientPrediction, PredictedState } from './prediction';
import type { ServerMessage, GameEvent, MoveInput, Welcome } from '../shared/protocol';
import type { Vec3 } from '../shared/types';

// ============================================================================
// Types
// ============================================================================

export interface NetworkGameConfig {
  serverUrl: string;
  onConnectionChange?: (state: ConnectionState) => void;
  onWelcome?: (welcome: Welcome) => void;
  onEvents?: (events: GameEvent[]) => void;
}

export interface LocalPlayerState {
  id: string;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  isGrounded: boolean;
}

// ============================================================================
// NetworkGame
// ============================================================================

export class NetworkGame {
  private config: NetworkGameConfig;

  // Network components
  private socket: GameSocket;
  private clock: NetworkClock;
  private inputManager: InputManager;
  private inputCapture: InputCapture;
  private networkState: NetworkState;
  private prediction: ClientPrediction;

  // Local player state
  private localPlayerId: string | null = null;
  private initialized: boolean = false;

  constructor(config: NetworkGameConfig, getYaw: () => number) {
    this.config = config;

    // Create socket
    this.socket = new GameSocket({
      url: config.serverUrl,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      onMessage: (msg) => this.handleMessage(msg),
      onStateChange: (state) => {
        this.config.onConnectionChange?.(state);
        if (state === 'disconnected') {
          this.handleDisconnect();
        }
      },
      onWelcome: (welcome) => this.handleWelcome(welcome),
    });

    // Create clock
    this.clock = new NetworkClock(this.socket);

    // Create input systems
    this.inputManager = new InputManager(this.socket);
    this.inputCapture = new InputCapture(this.inputManager, getYaw);

    // Create state management
    this.networkState = new NetworkState();
    this.prediction = new ClientPrediction();
  }

  /**
   * Connect to server and start networking
   */
  connect(): void {
    this.socket.connect();
  }

  /**
   * Disconnect from server
   */
  disconnect(): void {
    this.inputCapture.detach();
    this.clock.stop();
    this.socket.disconnect();
    this.reset();
  }

  /**
   * Initialize local player (called after receiving Welcome)
   */
  initializeLocalPlayer(pos: Vec3, yaw: number): void {
    this.prediction.initialize(pos, yaw);
    this.inputCapture.attach();
    this.initialized = true;
  }

  /**
   * Update networking each frame
   * Returns local player state for rendering
   */
  update(dt: number): LocalPlayerState | null {
    if (!this.initialized || !this.localPlayerId) {
      return null;
    }

    // Send inputs (rate limited internally)
    this.inputCapture.update(dt);

    // Update interpolation for remote entities
    this.networkState.updateInterpolation(Date.now());

    // Update error smoothing
    this.prediction.updateErrorSmoothing(dt);

    // Process any pending events
    const events = this.networkState.consumeEvents();
    if (events.length > 0) {
      this.config.onEvents?.(events);
    }

    // Return local player render state
    const predicted = this.prediction.getPredicted();
    const renderPos = this.prediction.getRenderPosition();

    return {
      id: this.localPlayerId,
      pos: renderPos,
      vel: predicted.vel,
      yaw: predicted.yaw,
      isGrounded: this.prediction.isGrounded(),
    };
  }

  /**
   * Apply local input for prediction (called from game loop)
   */
  applyLocalInput(input: MoveInput): PredictedState {
    return this.prediction.applyInput(input);
  }

  /**
   * Send ability input
   */
  useAbility(abilityId: string, targetId: string | null): void {
    this.inputCapture.sendAbility(abilityId, targetId);
  }

  /**
   * Get current input state for local prediction
   */
  getInputState() {
    return this.inputCapture.getInputState();
  }

  /**
   * Get all remote entities for rendering
   */
  getRemoteEntities(): InterpolatedEntity[] {
    return this.networkState.getAllInterpolatedEntities();
  }

  /**
   * Get a specific remote entity
   */
  getRemoteEntity(id: string): InterpolatedEntity | undefined {
    return this.networkState.getInterpolatedEntity(id);
  }

  /**
   * Get local player ID
   */
  getLocalPlayerId(): string | null {
    return this.localPlayerId;
  }

  /**
   * Check if connected and initialized
   */
  isReady(): boolean {
    return this.socket.isConnected() && this.initialized;
  }

  /**
   * Get connection state
   */
  getConnectionState(): ConnectionState {
    return this.socket.getState();
  }

  /**
   * Get RTT in milliseconds
   */
  getRTT(): number {
    return this.clock.getRTT();
  }

  /**
   * Get debug info
   */
  getDebugInfo(): string {
    const connState = this.socket.getState();
    const clockInfo = this.clock.getDebugInfo();
    const predInfo = this.prediction.getDebugInfo();
    const pendingInputs = this.inputManager.getPendingCount();

    return `Conn: ${connState} | ${clockInfo} | Pending: ${pendingInputs} | ${predInfo}`;
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'Pong':
        this.clock.handlePong(msg);
        break;

      case 'Snapshot':
        this.handleSnapshot(msg);
        break;

      case 'Events':
        this.networkState.addEvents(msg.events);
        break;
    }
  }

  private handleWelcome(welcome: Welcome): void {
    console.log('[NetworkGame] Welcome received, playerId:', welcome.playerId);
    this.localPlayerId = welcome.playerId;
    this.networkState.setLocalPlayerId(welcome.playerId);

    // Start clock synchronization
    this.clock.start();

    // Notify listener
    this.config.onWelcome?.(welcome);
  }

  private handleSnapshot(snapshot: import('../shared/protocol').Snapshot): void {
    // Add to network state
    this.networkState.addSnapshot(snapshot);

    // Reconcile local player prediction
    if (this.localPlayerId && this.initialized) {
      const serverState = this.networkState.getLocalPlayerServerState();
      if (serverState) {
        // Acknowledge inputs
        const acked = this.inputManager.acknowledgeUpTo(snapshot.ackedSeq);

        // Get unacked inputs for replay
        const unackedInputs = this.inputManager.getUnacknowledgedMoveInputs();

        // Log reconciliation periodically (every ~1 second of snapshots)
        if (snapshot.tick % 20 === 0) {
          console.log(
            `[NetworkGame] Snapshot tick=${snapshot.tick} ackedSeq=${snapshot.ackedSeq} ` +
            `acked=${acked.length} unacked=${unackedInputs.length} entities=${snapshot.entities.length}`
          );
        }

        // Reconcile
        this.prediction.reconcile(serverState, snapshot.ackedSeq, unackedInputs);
      }
    }
  }

  private handleDisconnect(): void {
    console.log('[NetworkGame] Disconnected, resetting state');
    this.initialized = false;
    this.inputCapture.detach();
    this.clock.stop();
  }

  private reset(): void {
    this.localPlayerId = null;
    this.initialized = false;
    this.inputManager.reset();
    this.networkState.reset();
    this.prediction.initialize({ x: 0, y: 0, z: 0 });
  }
}
