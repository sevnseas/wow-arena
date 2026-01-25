/**
 * Server-side physics - movement and collision without Three.js
 */

import type { Vec3, Collider, CylinderCollider, BoxCollider } from '../../src/shared/types';
import {
  MOVE_SPEED,
  JUMP_FORCE,
  GRAVITY,
  GROUND_Y,
  PLAYER_RADIUS,
  ARENA_BOUND,
  buildColliders,
} from '../../src/shared/physics';

// ============================================================================
// Vec3 helpers (no Three.js)
// ============================================================================

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3LengthSq(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len < 0.0001) return { x: 0, y: 0, z: 0 };
  return vec3Scale(v, 1 / len);
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3Length(vec3Sub(a, b));
}

export function vec3DistanceXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function vec3Copy(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

// ============================================================================
// Movement input
// ============================================================================

export interface MoveInputData {
  dx: number; // -1 to 1
  dz: number; // -1 to 1
  yaw: number; // camera yaw in radians
  jump: boolean;
}

export interface EntityPhysicsState {
  pos: Vec3;
  vel: Vec3;
  isGrounded: boolean;
  groundLevel: number;
}

// ============================================================================
// Physics system
// ============================================================================

// Cached colliders
let cachedColliders: Collider[] | null = null;

function getColliders(): Collider[] {
  if (!cachedColliders) {
    cachedColliders = buildColliders();
  }
  return cachedColliders;
}

/**
 * Convert yaw to forward direction vector
 */
export function yawToForward(yaw: number): Vec3 {
  return {
    x: -Math.sin(yaw),
    y: 0,
    z: -Math.cos(yaw),
  };
}

/**
 * Apply movement input to entity
 * Returns updated physics state
 */
export function applyMovement(
  state: EntityPhysicsState,
  input: MoveInputData,
  dt: number
): EntityPhysicsState {
  const result: EntityPhysicsState = {
    pos: vec3Copy(state.pos),
    vel: vec3Copy(state.vel),
    isGrounded: state.isGrounded,
    groundLevel: state.groundLevel,
  };

  // Calculate movement direction from input
  const inputLen = Math.sqrt(input.dx * input.dx + input.dz * input.dz);

  if (inputLen > 0.001) {
    // Normalize input
    const normDx = input.dx / inputLen;
    const normDz = input.dz / inputLen;

    // Transform by camera yaw
    const forward = yawToForward(input.yaw);
    const right: Vec3 = { x: -forward.z, y: 0, z: forward.x };

    // Calculate world-space movement direction
    const moveX = right.x * normDx + forward.x * (-normDz);
    const moveZ = right.z * normDx + forward.z * (-normDz);

    // Normalize and apply speed
    const moveLen = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (moveLen > 0.001) {
      result.vel.x = (moveX / moveLen) * MOVE_SPEED;
      result.vel.z = (moveZ / moveLen) * MOVE_SPEED;
    }
  } else {
    // No input - stop horizontal movement
    result.vel.x = 0;
    result.vel.z = 0;
  }

  // Handle jump
  if (input.jump && result.isGrounded) {
    result.vel.y = JUMP_FORCE;
    result.isGrounded = false;
  }

  // Apply gravity if not grounded
  if (!result.isGrounded) {
    result.vel.y -= GRAVITY * dt;
  }

  // Update position
  result.pos.x += result.vel.x * dt;
  result.pos.y += result.vel.y * dt;
  result.pos.z += result.vel.z * dt;

  // Resolve collisions
  resolveCollisions(result);

  // Ground check
  if (result.pos.y <= result.groundLevel) {
    result.pos.y = result.groundLevel;
    result.vel.y = 0;
    result.isGrounded = true;
  } else {
    result.isGrounded = false;
  }

  // Clamp to arena bounds
  result.pos.x = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, result.pos.x));
  result.pos.z = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, result.pos.z));

  return result;
}

/**
 * Resolve collisions with arena geometry
 */
function resolveCollisions(state: EntityPhysicsState): void {
  const colliders = getColliders();
  let newGroundLevel = GROUND_Y;

  for (const col of colliders) {
    if (col.type === 'cylinder') {
      resolveCylinder(state, col);
    } else if (col.type === 'box') {
      const boxGround = resolveBox(state, col);
      if (boxGround > newGroundLevel) {
        newGroundLevel = boxGround;
      }
    }
  }

  state.groundLevel = newGroundLevel;
}

/**
 * Resolve collision with a cylinder (pillar)
 */
function resolveCylinder(state: EntityPhysicsState, col: CylinderCollider): void {
  const dx = state.pos.x - col.x;
  const dz = state.pos.z - col.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const minDist = col.radius + PLAYER_RADIUS;

  if (dist < minDist && dist > 0.001) {
    // Push out along the normal
    const overlap = minDist - dist;
    const nx = dx / dist;
    const nz = dz / dist;

    state.pos.x += nx * overlap;
    state.pos.z += nz * overlap;

    // Wall slide: remove velocity component into the wall
    const velDotN = state.vel.x * nx + state.vel.z * nz;
    if (velDotN < 0) {
      state.vel.x -= velDotN * nx;
      state.vel.z -= velDotN * nz;
    }
  }
}

/**
 * Resolve collision with a box
 * Returns ground level if player can stand on top
 */
function resolveBox(state: EntityPhysicsState, col: BoxCollider): number {
  const cosR = Math.cos(col.rotation);
  const sinR = Math.sin(col.rotation);

  // Position relative to box center
  const dx = state.pos.x - col.x;
  const dz = state.pos.z - col.z;

  // Transform to box local space
  const localX = dx * cosR - dz * sinR;
  const localZ = dx * sinR + dz * cosR;

  const halfW = col.width / 2;
  const halfD = col.depth / 2;

  // Check if within box bounds horizontally
  const inBoxX = Math.abs(localX) < halfW + PLAYER_RADIUS;
  const inBoxZ = Math.abs(localZ) < halfD + PLAYER_RADIUS;

  if (!inBoxX || !inBoxZ) {
    return GROUND_Y;
  }

  // Check if player is above the box
  const feetY = state.pos.y;
  const isAboveBox = feetY >= col.height - 0.05;
  const withinTopBounds =
    Math.abs(localX) < halfW + PLAYER_RADIUS * 0.8 &&
    Math.abs(localZ) < halfD + PLAYER_RADIUS * 0.8;

  if (isAboveBox && withinTopBounds) {
    return col.height;
  }

  // Side collision
  if (feetY < col.height) {
    const overlapX = halfW + PLAYER_RADIUS - Math.abs(localX);
    const overlapZ = halfD + PLAYER_RADIUS - Math.abs(localZ);

    if (overlapX > 0 && overlapZ > 0) {
      let pushLocalX = 0;
      let pushLocalZ = 0;

      if (overlapX < overlapZ) {
        pushLocalX = overlapX * Math.sign(localX);
      } else {
        pushLocalZ = overlapZ * Math.sign(localZ);
      }

      // Transform back to world space
      const worldPushX = pushLocalX * cosR - pushLocalZ * sinR;
      const worldPushZ = pushLocalX * sinR + pushLocalZ * cosR;

      state.pos.x += worldPushX;
      state.pos.z += worldPushZ;

      // Wall slide
      if (worldPushX !== 0 || worldPushZ !== 0) {
        const pushLen = Math.sqrt(worldPushX * worldPushX + worldPushZ * worldPushZ);
        const nx = worldPushX / pushLen;
        const nz = worldPushZ / pushLen;
        const velDotN = state.vel.x * nx + state.vel.z * nz;
        if (velDotN < 0) {
          state.vel.x -= velDotN * nx;
          state.vel.z -= velDotN * nz;
        }
      }
    }
  }

  return GROUND_Y;
}

/**
 * Update projectile position (simple linear motion toward target)
 */
export function updateProjectilePosition(
  pos: Vec3,
  vel: Vec3,
  targetPos: Vec3,
  speed: number,
  dt: number
): Vec3 {
  // Recalculate velocity toward current target position
  const toTarget = vec3Sub(targetPos, pos);
  const dist = vec3Length(toTarget);

  if (dist < 0.1) {
    // Very close, just move to target
    return vec3Copy(targetPos);
  }

  // Update velocity to track target
  const newVel = vec3Scale(vec3Normalize(toTarget), speed);

  // Move
  return vec3Add(pos, vec3Scale(newVel, dt));
}

/**
 * Check if projectile has reached target
 */
export function checkProjectileHit(
  projPos: Vec3,
  targetPos: Vec3,
  hitRadius: number = 0.5
): boolean {
  return vec3DistanceXZ(projPos, targetPos) < hitRadius;
}

/**
 * Calculate position behind target (for shadowstep)
 */
export function getPositionBehindTarget(
  casterPos: Vec3,
  targetPos: Vec3,
  distance: number = 1.5
): Vec3 {
  const toTarget = vec3Sub(targetPos, casterPos);
  const dir = vec3Normalize({ x: toTarget.x, y: 0, z: toTarget.z });

  return {
    x: targetPos.x + dir.x * distance,
    y: GROUND_Y,
    z: targetPos.z + dir.z * distance,
  };
}

/**
 * Calculate blink destination (forward from current position)
 */
export function getBlinkDestination(
  pos: Vec3,
  yaw: number,
  distance: number = 8
): Vec3 {
  const forward = yawToForward(yaw);

  let newX = pos.x + forward.x * distance;
  let newZ = pos.z + forward.z * distance;

  // Clamp to arena bounds
  newX = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, newX));
  newZ = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, newZ));

  return { x: newX, y: GROUND_Y, z: newZ };
}

/**
 * Check if position is valid (not inside obstacles)
 */
export function isPositionValid(pos: Vec3): boolean {
  const colliders = getColliders();

  for (const col of colliders) {
    if (col.type === 'cylinder') {
      const dx = pos.x - col.x;
      const dz = pos.z - col.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < col.radius + PLAYER_RADIUS) {
        return false;
      }
    }
  }

  // Check arena bounds
  if (Math.abs(pos.x) > ARENA_BOUND || Math.abs(pos.z) > ARENA_BOUND) {
    return false;
  }

  return true;
}

/**
 * Find valid position near target (for teleport abilities)
 */
export function findValidPositionNear(
  targetPos: Vec3,
  preferredDir: Vec3,
  distance: number = 1.5
): Vec3 {
  // Try preferred direction first
  const preferred = vec3Add(targetPos, vec3Scale(vec3Normalize(preferredDir), distance));
  preferred.y = GROUND_Y;

  if (isPositionValid(preferred)) {
    return preferred;
  }

  // Try rotating around target
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
    const dx = Math.cos(angle) * distance;
    const dz = Math.sin(angle) * distance;
    const candidate: Vec3 = {
      x: targetPos.x + dx,
      y: GROUND_Y,
      z: targetPos.z + dz,
    };

    if (isPositionValid(candidate)) {
      return candidate;
    }
  }

  // Fallback: return target position (shouldn't happen in normal arena)
  return { x: targetPos.x, y: GROUND_Y, z: targetPos.z };
}
