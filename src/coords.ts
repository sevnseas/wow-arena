/**
 * Coordinate System - Single Source of Truth
 *
 * Convention:
 * - +Y = up
 * - +X = right
 * - -Z = forward
 *
 * This matches common Three.js camera assumptions.
 */

import * as THREE from 'three';

// Canonical direction constants
export const WORLD_UP = new THREE.Vector3(0, 1, 0);
export const WORLD_RIGHT = new THREE.Vector3(1, 0, 0);
export const WORLD_FWD = new THREE.Vector3(0, 0, -1);

// Immutable copies for safe usage
export function worldUp(): THREE.Vector3 {
  return WORLD_UP.clone();
}

export function worldForward(): THREE.Vector3 {
  return WORLD_FWD.clone();
}

export function worldRight(): THREE.Vector3 {
  return WORLD_RIGHT.clone();
}

/**
 * Convert a yaw angle (radians) to a direction vector on XZ plane.
 * Yaw = 0 means facing -Z (forward)
 * Yaw increases counter-clockwise when viewed from above
 */
export function yawToDir(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(
    -Math.sin(yaw),
    0,
    -Math.cos(yaw)
  );
}

/**
 * Convert a direction vector to yaw angle (radians).
 * Returns angle in range [-PI, PI]
 */
export function dirToYaw(vec: THREE.Vector3): number {
  return Math.atan2(-vec.x, -vec.z);
}

/**
 * Flatten a vector to the XZ plane (remove Y component)
 */
export function flattenXZ(vec: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(vec.x, 0, vec.z);
}

/**
 * Snap a position to ground level (Y = 0 for now)
 */
export function snapToGround(pos: THREE.Vector3, groundY: number = 0): THREE.Vector3 {
  return new THREE.Vector3(pos.x, groundY, pos.z);
}

/**
 * Assert that a vector has finite values (no NaN or Infinity)
 */
export function assertFiniteVec3(vec: THREE.Vector3, label: string = 'vector'): void {
  if (!Number.isFinite(vec.x) || !Number.isFinite(vec.y) || !Number.isFinite(vec.z)) {
    throw new Error(`${label} has non-finite values: ${prettyVec(vec)}`);
  }
}

/**
 * Format a vector for display
 */
export function prettyVec(vec: THREE.Vector3, precision: number = 2): string {
  return `(${vec.x.toFixed(precision)}, ${vec.y.toFixed(precision)}, ${vec.z.toFixed(precision)})`;
}

/**
 * Get the symbolic name for a direction vector if it matches a canonical direction
 */
export function getDirectionName(vec: THREE.Vector3, tolerance: number = 0.01): string | null {
  const normalized = vec.clone().normalize();

  if (normalized.distanceTo(WORLD_UP) < tolerance) return '+Y (WORLD_UP)';
  if (normalized.distanceTo(WORLD_UP.clone().negate()) < tolerance) return '-Y (DOWN)';
  if (normalized.distanceTo(WORLD_RIGHT) < tolerance) return '+X (WORLD_RIGHT)';
  if (normalized.distanceTo(WORLD_RIGHT.clone().negate()) < tolerance) return '-X (LEFT)';
  if (normalized.distanceTo(WORLD_FWD) < tolerance) return '-Z (WORLD_FWD)';
  if (normalized.distanceTo(WORLD_FWD.clone().negate()) < tolerance) return '+Z (BACK)';

  return null;
}

/**
 * Create RGB axis gizmo arrows
 * X = Red, Y = Green, Z = Blue
 */
export function createAxisGizmo(size: number = 2): THREE.Group {
  const gizmo = new THREE.Group();
  gizmo.name = 'AxisGizmo';

  const createArrow = (
    direction: THREE.Vector3,
    color: number,
    label: string
  ): THREE.Group => {
    const arrow = new THREE.Group();
    arrow.name = label;

    // Cylinder shaft
    const shaftGeometry = new THREE.CylinderGeometry(0.02, 0.02, size * 0.85, 8);
    const shaftMaterial = new THREE.MeshBasicMaterial({ color });
    const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
    shaft.position.y = size * 0.85 / 2;
    arrow.add(shaft);

    // Cone head
    const coneGeometry = new THREE.ConeGeometry(0.06, size * 0.15, 8);
    const coneMaterial = new THREE.MeshBasicMaterial({ color });
    const cone = new THREE.Mesh(coneGeometry, coneMaterial);
    cone.position.y = size * 0.925;
    arrow.add(cone);

    // Orient the arrow along the direction
    if (direction.equals(WORLD_RIGHT)) {
      arrow.rotation.z = -Math.PI / 2;
    } else if (direction.equals(WORLD_FWD)) {
      arrow.rotation.x = Math.PI / 2;
    }
    // Y axis needs no rotation (default orientation)

    // Store metadata for debug picking
    arrow.userData = {
      isAxisArrow: true,
      direction: direction.clone(),
      label,
      color
    };

    return arrow;
  };

  gizmo.add(createArrow(WORLD_RIGHT, 0xff0000, 'X-Axis (Red)'));
  gizmo.add(createArrow(WORLD_UP, 0x00ff00, 'Y-Axis (Green)'));
  gizmo.add(createArrow(WORLD_FWD, 0x0088ff, 'Z-Axis (Blue)'));

  return gizmo;
}

/**
 * Debug pick mode - logs info about clicked axis
 */
export function debugPickAxis(
  intersect: THREE.Intersection,
  _camera: THREE.Camera
): void {
  let current: THREE.Object3D | null = intersect.object;

  while (current) {
    if (current.userData?.isAxisArrow) {
      const { direction, label } = current.userData;
      const dirName = getDirectionName(direction);
      const yaw = dirToYaw(direction);

      console.log('=== Axis Debug Pick ===');
      console.log(`Label: ${label}`);
      console.log(`Direction: ${prettyVec(direction)}`);
      if (dirName) console.log(`Symbolic: ${dirName}`);
      console.log(`Yaw: ${(yaw * 180 / Math.PI).toFixed(1)}°`);
      console.log('=======================');
      return;
    }
    current = current.parent;
  }
}
