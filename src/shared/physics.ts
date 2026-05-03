/**
 * Physics constants - shared between client and server
 */

import type { Collider } from './types';

// Player movement
export const MOVE_SPEED = 6;        // units per second
export const JUMP_FORCE = 8;        // initial vertical velocity
export const GRAVITY = 20;          // units per second squared
export const GROUND_Y = 0;          // ground plane height

// Player collision
export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.8;

// Arena bounds
export const ARENA_SIZE = 40;
export const ARENA_BOUND = 25;      // allows venturing outside through entrances (walls at ±20)

// Pillar dimensions
export const PILLAR_HEIGHT = 4;
export const PILLAR_RADIUS = 1.2;
export const PILLAR_BASE_RADIUS = PILLAR_RADIUS * 1.1; // base is slightly wider

// Pillar positions (4 cardinal pillars)
export const PILLAR_OFFSET = 8;
export const PILLAR_POSITIONS: Array<[number, number]> = [
  [-PILLAR_OFFSET, -PILLAR_OFFSET],
  [PILLAR_OFFSET, -PILLAR_OFFSET],
  [-PILLAR_OFFSET, PILLAR_OFFSET],
  [PILLAR_OFFSET, PILLAR_OFFSET],
];

// Ramp/box obstacles
export const RAMPS: Array<{
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
}> = [
  { x: -3, z: 0, width: 2, depth: 4, height: 1.2, rotation: Math.PI / 6 },
  { x: 3, z: 0, width: 2, depth: 4, height: 1.2, rotation: -Math.PI / 6 },
];

// Build colliders array from constants
export function buildColliders(): Collider[] {
  const colliders: Collider[] = [];

  // Pillars
  for (const [x, z] of PILLAR_POSITIONS) {
    colliders.push({
      type: 'cylinder',
      x,
      z,
      radius: PILLAR_BASE_RADIUS,
      height: PILLAR_HEIGHT,
    });
  }

  // Ramps
  for (const ramp of RAMPS) {
    colliders.push({
      type: 'box',
      x: ramp.x,
      z: ramp.z,
      width: ramp.width,
      depth: ramp.depth,
      height: ramp.height,
      rotation: ramp.rotation,
    });
  }

  return colliders;
}

// Spawn positions
export const FRIENDLY_SPAWNS: Array<[number, number, number]> = [
  [0, 0, 8],
  [-3, 0, 10],
  [3, 0, 10],
];

export const ENEMY_SPAWNS: Array<[number, number, number]> = [
  [0, 0, -8],
  [-4, 0, -10],
  [4, 0, -10],
];

// Server tick rate
export const SERVER_TICK_RATE = 20;  // Hz
export const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE;  // 50ms

// Snapshot send rate (can be lower than tick rate)
export const SNAPSHOT_RATE = 20;  // Hz
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;

// Client interpolation delay (ms behind server time for smooth remote entities)
export const INTERP_DELAY_MS = 100;
