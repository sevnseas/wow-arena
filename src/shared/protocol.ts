/**
 * Network protocol types - messages between client and server
 */

import type { Vec3, EntitySnapshot, ProjectileSnapshot, ClassName } from './types';

// Re-export snapshot types for convenience
export type { EntitySnapshot, ProjectileSnapshot } from './types';

// ============================================================================
// Client -> Server Messages
// ============================================================================

export interface MoveInput {
  type: 'MoveInput';
  seq: number;      // sequence number for reconciliation
  dx: number;       // input direction X (-1 to 1)
  dz: number;       // input direction Z (-1 to 1)
  yaw: number;      // camera yaw (radians)
  jump: boolean;    // jump pressed this frame
  dt: number;       // delta time for this input (seconds)
}

export interface AbilityInput {
  type: 'AbilityInput';
  seq: number;
  abilityId: string;
  targetId: string | null;
}

export interface SetTarget {
  type: 'SetTarget';
  seq: number;
  targetId: string | null;
}

export interface SelectClass {
  type: 'SelectClass';
  seq: number;
  className: ClassName;
}

export interface Ping {
  type: 'Ping';
  clientTime: number;
}

export type ClientMessage = MoveInput | AbilityInput | SetTarget | SelectClass | Ping;

// ============================================================================
// Server -> Client Messages
// ============================================================================

export interface Welcome {
  type: 'Welcome';
  playerId: string;
  tick: number;
  serverTime: number;
}

export interface Snapshot {
  type: 'Snapshot';
  tick: number;
  serverTime: number;
  entities: EntitySnapshot[];
  projectiles: ProjectileSnapshot[];
  // Acked input sequence for this player (for reconciliation)
  ackedSeq: number;
}

export interface Pong {
  type: 'Pong';
  clientTime: number;
  serverTime: number;
}

// Game events (discrete happenings)
export interface CastStartedEvent {
  type: 'CastStarted';
  tick: number;
  casterId: string;
  abilityId: string;
  targetId: string | null;
  castTime: number; // seconds
}

export interface CastCompletedEvent {
  type: 'CastCompleted';
  tick: number;
  casterId: string;
  abilityId: string;
}

export interface CastInterruptedEvent {
  type: 'CastInterrupted';
  tick: number;
  casterId: string;
  reason: 'moved' | 'stunned' | 'interrupted';
}

export interface ProjectileSpawnedEvent {
  type: 'ProjectileSpawned';
  tick: number;
  projectileId: number;
  abilityId: string;
  sourceId: string;
  targetId: string;
  startPos: Vec3;
  speed: number;
}

export interface ProjectileHitEvent {
  type: 'ProjectileHit';
  tick: number;
  projectileId: number;
  targetId: string;
}

export interface DamageEvent {
  type: 'Damage';
  tick: number;
  sourceId: string;
  targetId: string;
  amount: number;
  abilityId: string;
}

export interface HealEvent {
  type: 'Heal';
  tick: number;
  sourceId: string;
  targetId: string;
  amount: number;
  abilityId: string;
}

export interface DebuffAppliedEvent {
  type: 'DebuffApplied';
  tick: number;
  sourceId: string;
  targetId: string;
  debuffId: string;
  duration: number;
}

export interface DebuffRemovedEvent {
  type: 'DebuffRemoved';
  tick: number;
  targetId: string;
  debuffId: string;
}

export interface DeathEvent {
  type: 'Death';
  tick: number;
  entityId: string;
  killerId: string | null;
}

export interface RespawnEvent {
  type: 'Respawn';
  tick: number;
  entityId: string;
  pos: Vec3;
}

export interface EntitySpawnedEvent {
  type: 'EntitySpawned';
  tick: number;
  entity: EntitySnapshot;
}

export interface EntityRemovedEvent {
  type: 'EntityRemoved';
  tick: number;
  entityId: string;
  reason: 'disconnect' | 'despawn';
}

export type GameEvent =
  | CastStartedEvent
  | CastCompletedEvent
  | CastInterruptedEvent
  | ProjectileSpawnedEvent
  | ProjectileHitEvent
  | DamageEvent
  | HealEvent
  | DebuffAppliedEvent
  | DebuffRemovedEvent
  | DeathEvent
  | RespawnEvent
  | EntitySpawnedEvent
  | EntityRemovedEvent;

export interface Events {
  type: 'Events';
  events: GameEvent[];
}

export type ServerMessage = Welcome | Snapshot | Pong | Events;

// ============================================================================
// Serialization helpers
// ============================================================================

export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

export function decodeClientMessage(data: string): ClientMessage | null {
  try {
    return JSON.parse(data) as ClientMessage;
  } catch {
    return null;
  }
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeServerMessage(data: string): ServerMessage | null {
  try {
    return JSON.parse(data) as ServerMessage;
  } catch {
    return null;
  }
}
