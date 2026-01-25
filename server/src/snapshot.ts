/**
 * Snapshot building and event broadcasting
 */

import type { ServerGameState } from './state';
import type {
  Snapshot,
  Events,
  GameEvent,
  ServerMessage,
} from '../../src/shared/protocol';

// ============================================================================
// Types
// ============================================================================

export interface EventQueue {
  events: GameEvent[];
}

// ============================================================================
// Snapshot Building
// ============================================================================

/**
 * Build a snapshot of the current game state
 */
export function buildSnapshot(
  state: ServerGameState,
  ackedSeq: number
): Snapshot {
  return {
    type: 'Snapshot',
    tick: state.getTick(),
    serverTime: Date.now(),
    ackedSeq,
    entities: state.buildAllEntitySnapshots(),
    projectiles: state.buildAllProjectileSnapshots(),
  };
}

/**
 * Build an events message from accumulated events
 */
export function buildEventsMessage(events: GameEvent[]): Events | null {
  if (events.length === 0) return null;

  return {
    type: 'Events',
    events,
  };
}

// ============================================================================
// Event Queue
// ============================================================================

export function createEventQueue(): EventQueue {
  return { events: [] };
}

export function pushEvents(queue: EventQueue, events: GameEvent[]): void {
  queue.events.push(...events);
}

export function flushEvents(queue: EventQueue): GameEvent[] {
  const events = queue.events;
  queue.events = [];
  return events;
}

export function getEventCount(queue: EventQueue): number {
  return queue.events.length;
}
