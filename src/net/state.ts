/**
 * Client network state - snapshot buffering and entity interpolation
 */

import type { Snapshot, EntitySnapshot, ProjectileSnapshot, GameEvent } from '../shared/protocol';
import type { Vec3 } from '../shared/types';

// ============================================================================
// Types
// ============================================================================

export interface BufferedSnapshot {
  snapshot: Snapshot;
  receivedAt: number;
}

export interface InterpolatedEntity {
  id: string;
  name: string;
  className: string;
  team: string;

  // Interpolated position/rotation
  pos: Vec3;
  vel: Vec3;
  yaw: number;

  // Combat state
  hp: number;
  maxHp: number;
  alive: boolean;
  debuffs: string[];

  // Cast state
  castingAbilityId: string | null;
  castProgress: number;
}

export interface NetworkStateConfig {
  interpolationDelay: number;  // How far behind to render (ms)
  snapshotBufferSize: number;  // Max snapshots to keep
}

// ============================================================================
// NetworkState
// ============================================================================

export class NetworkState {
  private config: NetworkStateConfig;

  // Snapshot buffer for interpolation
  private snapshots: BufferedSnapshot[] = [];

  // Current interpolated entities (excluding local player)
  private interpolatedEntities: Map<string, InterpolatedEntity> = new Map();

  // Projectile state from latest snapshot
  private projectiles: ProjectileSnapshot[] = [];

  // Local player ID
  private localPlayerId: string | null = null;

  // Server state
  private serverTick: number = 0;
  private serverTime: number = 0;

  // Events pending processing
  private pendingEvents: GameEvent[] = [];

  constructor(config: Partial<NetworkStateConfig> = {}) {
    this.config = {
      interpolationDelay: 100,  // 100ms behind for smooth interpolation
      snapshotBufferSize: 30,   // ~1.5 seconds at 20Hz
      ...config,
    };
  }

  /**
   * Set local player ID (to exclude from interpolation)
   */
  setLocalPlayerId(id: string): void {
    this.localPlayerId = id;
  }

  /**
   * Get local player ID
   */
  getLocalPlayerId(): string | null {
    return this.localPlayerId;
  }

  /**
   * Add a snapshot to the buffer
   */
  addSnapshot(snapshot: Snapshot): void {
    const buffered: BufferedSnapshot = {
      snapshot,
      receivedAt: Date.now(),
    };

    this.snapshots.push(buffered);
    this.serverTick = snapshot.tick;
    this.serverTime = snapshot.serverTime;

    // Update projectiles from latest snapshot
    this.projectiles = snapshot.projectiles;

    // Trim old snapshots
    while (this.snapshots.length > this.config.snapshotBufferSize) {
      this.snapshots.shift();
    }
  }

  /**
   * Add events to pending queue
   */
  addEvents(events: GameEvent[]): void {
    this.pendingEvents.push(...events);
  }

  /**
   * Consume pending events
   */
  consumeEvents(): GameEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  /**
   * Update interpolated entities for current render time
   */
  updateInterpolation(renderTime: number): void {
    const targetTime = renderTime - this.config.interpolationDelay;

    // Find two snapshots to interpolate between
    const { before, after } = this.findSnapshotsForTime(targetTime);

    if (!before) {
      return;
    }

    if (!after) {
      // Extrapolate from last snapshot
      this.applySnapshot(before.snapshot, 0);
      return;
    }

    // Calculate interpolation factor
    const range = after.receivedAt - before.receivedAt;
    const t = range > 0 ? (targetTime - before.receivedAt) / range : 0;
    const clampedT = Math.max(0, Math.min(1, t));

    this.interpolateBetween(before.snapshot, after.snapshot, clampedT);
  }

  /**
   * Get interpolated state for a remote entity
   */
  getInterpolatedEntity(id: string): InterpolatedEntity | undefined {
    return this.interpolatedEntities.get(id);
  }

  /**
   * Get all interpolated entities (excluding local player)
   */
  getAllInterpolatedEntities(): InterpolatedEntity[] {
    return Array.from(this.interpolatedEntities.values());
  }

  /**
   * Get local player's server state from latest snapshot
   */
  getLocalPlayerServerState(): EntitySnapshot | undefined {
    if (!this.localPlayerId || this.snapshots.length === 0) {
      return undefined;
    }

    const latest = this.snapshots[this.snapshots.length - 1];
    return latest.snapshot.entities.find((e) => e.id === this.localPlayerId);
  }

  /**
   * Get current projectiles
   */
  getProjectiles(): ProjectileSnapshot[] {
    return this.projectiles;
  }

  /**
   * Get current server tick
   */
  getServerTick(): number {
    return this.serverTick;
  }

  /**
   * Get current server time
   */
  getServerTime(): number {
    return this.serverTime;
  }

  /**
   * Get latest snapshot (for reconciliation)
   */
  getLatestSnapshot(): Snapshot | undefined {
    if (this.snapshots.length === 0) {
      return undefined;
    }
    return this.snapshots[this.snapshots.length - 1].snapshot;
  }

  /**
   * Get snapshot count
   */
  getSnapshotCount(): number {
    return this.snapshots.length;
  }

  /**
   * Reset state (on disconnect)
   */
  reset(): void {
    this.snapshots = [];
    this.interpolatedEntities.clear();
    this.projectiles = [];
    this.localPlayerId = null;
    this.serverTick = 0;
    this.serverTime = 0;
    this.pendingEvents = [];
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private findSnapshotsForTime(targetTime: number): {
    before: BufferedSnapshot | undefined;
    after: BufferedSnapshot | undefined;
  } {
    let before: BufferedSnapshot | undefined;
    let after: BufferedSnapshot | undefined;

    for (const snapshot of this.snapshots) {
      if (snapshot.receivedAt <= targetTime) {
        before = snapshot;
      } else {
        after = snapshot;
        break;
      }
    }

    return { before, after };
  }

  private applySnapshot(snapshot: Snapshot, _t: number): void {
    // Update entities from snapshot (excluding local player)
    const newEntities = new Map<string, InterpolatedEntity>();

    for (const entity of snapshot.entities) {
      if (entity.id === this.localPlayerId) {
        continue;
      }

      newEntities.set(entity.id, {
        id: entity.id,
        name: entity.name,
        className: entity.class,
        team: entity.team,
        pos: { ...entity.pos },
        vel: { ...entity.vel },
        yaw: entity.yaw,
        hp: entity.hp,
        maxHp: entity.maxHp,
        alive: entity.alive,
        debuffs: [...entity.debuffs],
        castingAbilityId: entity.castingAbilityId,
        castProgress: entity.castProgress,
      });
    }

    this.interpolatedEntities = newEntities;
  }

  private interpolateBetween(before: Snapshot, after: Snapshot, t: number): void {
    const newEntities = new Map<string, InterpolatedEntity>();

    // Create map of "after" entities for lookup
    const afterMap = new Map<string, EntitySnapshot>();
    for (const entity of after.entities) {
      afterMap.set(entity.id, entity);
    }

    // Interpolate each entity
    for (const beforeEntity of before.entities) {
      if (beforeEntity.id === this.localPlayerId) {
        continue;
      }

      const afterEntity = afterMap.get(beforeEntity.id);

      if (!afterEntity) {
        // Entity doesn't exist in after snapshot, use before state
        newEntities.set(beforeEntity.id, this.entityFromSnapshot(beforeEntity));
        continue;
      }

      // Interpolate position
      const pos = this.lerpVec3(beforeEntity.pos, afterEntity.pos, t);

      // Use latest values for non-interpolated state
      newEntities.set(beforeEntity.id, {
        id: afterEntity.id,
        name: afterEntity.name,
        className: afterEntity.class,
        team: afterEntity.team,
        pos,
        vel: afterEntity.vel,
        yaw: this.lerpAngle(beforeEntity.yaw, afterEntity.yaw, t),
        hp: afterEntity.hp,
        maxHp: afterEntity.maxHp,
        alive: afterEntity.alive,
        debuffs: [...afterEntity.debuffs],
        castingAbilityId: afterEntity.castingAbilityId,
        castProgress: afterEntity.castProgress,
      });
    }

    // Add entities that only exist in "after" (newly spawned)
    for (const afterEntity of after.entities) {
      if (afterEntity.id === this.localPlayerId) {
        continue;
      }
      if (!newEntities.has(afterEntity.id)) {
        newEntities.set(afterEntity.id, this.entityFromSnapshot(afterEntity));
      }
    }

    this.interpolatedEntities = newEntities;
  }

  private entityFromSnapshot(snapshot: EntitySnapshot): InterpolatedEntity {
    return {
      id: snapshot.id,
      name: snapshot.name,
      className: snapshot.class,
      team: snapshot.team,
      pos: { ...snapshot.pos },
      vel: { ...snapshot.vel },
      yaw: snapshot.yaw,
      hp: snapshot.hp,
      maxHp: snapshot.maxHp,
      alive: snapshot.alive,
      debuffs: [...snapshot.debuffs],
      castingAbilityId: snapshot.castingAbilityId,
      castProgress: snapshot.castProgress,
    };
  }

  private lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }

  private lerpAngle(a: number, b: number, t: number): number {
    // Handle angle wraparound
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }
}
