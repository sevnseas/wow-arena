/**
 * Arena - Nagrand-style blockout with pillars and terrain
 */

import * as THREE from 'three';
// @ts-ignore - JS texture modules
import { createTexture as createCeramicTexture } from './textures/ceramic_gray.js';
import { createTerrain, createWaterPlane } from './terrain';

// Arena dimensions
const ARENA_SIZE = 40;
const PILLAR_HEIGHT = 4;
const PILLAR_RADIUS = 1.2;

// Collision shapes
export interface CylinderCollider {
  type: 'cylinder';
  x: number;
  z: number;
  radius: number;
  height: number;
}

export interface BoxCollider {
  type: 'box';
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
}

export type Collider = CylinderCollider | BoxCollider;

// Store colliders for export
const colliders: Collider[] = [];

// Cached textures
let ceramicTexture: THREE.CanvasTexture | undefined;

function getCeramicTexture(): THREE.CanvasTexture {
  if (ceramicTexture) return ceramicTexture;
  ceramicTexture = createCeramicTexture(THREE, 256, 54321) as THREE.CanvasTexture;
  ceramicTexture.repeat.set(1, 2);
  return ceramicTexture;
}


/**
 * Create a pillar at the given position
 */
function createPillar(x: number, z: number): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(
    PILLAR_RADIUS,
    PILLAR_RADIUS * 1.1,
    PILLAR_HEIGHT,
    16
  );
  const material = new THREE.MeshStandardMaterial({
    map: getCeramicTexture(),
    roughness: 0.8,
    metalness: 0.1
  });
  const pillar = new THREE.Mesh(geometry, material);
  pillar.position.set(x, PILLAR_HEIGHT / 2, z);
  pillar.castShadow = true;
  pillar.receiveShadow = true;
  pillar.name = 'Pillar';

  // Register collider
  colliders.push({
    type: 'cylinder',
    x,
    z,
    radius: PILLAR_RADIUS * 1.1, // Use base radius
    height: PILLAR_HEIGHT
  });

  return pillar;
}

/**
 * Create a ramp/box for LOS features
 */
function createRamp(
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
  rotation: number = 0
): THREE.Group {
  const group = new THREE.Group();

  // Main box
  const boxGeometry = new THREE.BoxGeometry(width, height, depth);
  const material = new THREE.MeshStandardMaterial({
    color: 0x6b5b4f,
    roughness: 0.85,
    metalness: 0.05
  });
  const box = new THREE.Mesh(boxGeometry, material);
  box.position.y = height / 2;
  box.castShadow = true;
  box.receiveShadow = true;
  group.add(box);

  group.position.set(x, 0, z);
  group.rotation.y = rotation;
  group.name = 'Ramp';

  // Register collider
  colliders.push({
    type: 'box',
    x,
    z,
    width,
    depth,
    height,
    rotation
  });

  return group;
}

/**
 * Create individual boundary wall segments with entrance gaps
 * Each wall is split into left and right segments with a centered entrance
 */
function createBoundaryWalls(): THREE.Group {
  const walls = new THREE.Group();
  walls.name = 'BoundaryWalls';

  const wallHeight = 1.5;
  const wallThickness = 0.5;
  const halfSize = ARENA_SIZE / 2;
  const entranceWidth = 6; // Width of the gap for each entrance

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x555555,
    roughness: 0.7,
    metalness: 0.2
  });

  // Create wall segment and register collider
  const createWallSegment = (
    length: number,
    x: number,
    z: number,
    rotY: number
  ) => {
    const geometry = new THREE.BoxGeometry(length, wallHeight, wallThickness);
    const wall = new THREE.Mesh(geometry, wallMaterial);
    wall.position.set(x, wallHeight / 2, z);
    wall.rotation.y = rotY;
    wall.castShadow = true;
    wall.receiveShadow = true;
    walls.add(wall);

    // Register as collider
    colliders.push({
      type: 'box',
      x,
      z,
      width: rotY === 0 ? length : wallThickness,
      depth: rotY === 0 ? wallThickness : length,
      height: wallHeight,
      rotation: rotY
    });

    return wall;
  };

  const halfSegmentLength = (ARENA_SIZE - entranceWidth) / 2;
  const offset = halfSegmentLength / 2 + entranceWidth / 2;

  // North wall (z = -halfSize) - split left and right
  createWallSegment(halfSegmentLength, -offset, -halfSize, 0);
  createWallSegment(halfSegmentLength, offset, -halfSize, 0);

  // South wall (z = halfSize) - split left and right
  createWallSegment(halfSegmentLength, -offset, halfSize, 0);
  createWallSegment(halfSegmentLength, offset, halfSize, 0);

  // West wall (x = -halfSize) - split top and bottom
  createWallSegment(halfSegmentLength, -halfSize, -offset, Math.PI / 2);
  createWallSegment(halfSegmentLength, -halfSize, offset, Math.PI / 2);

  // East wall (x = halfSize) - split top and bottom
  createWallSegment(halfSegmentLength, halfSize, -offset, Math.PI / 2);
  createWallSegment(halfSegmentLength, halfSize, offset, Math.PI / 2);

  return walls;
}

/**
 * Get all collision shapes
 */
export function getColliders(): Collider[] {
  return colliders;
}

/**
 * Build the complete arena scene
 */
export function createArena(): THREE.Group {
  // Clear colliders in case of re-creation
  colliders.length = 0;

  const arena = new THREE.Group();
  arena.name = 'Arena';

  // Terrain (replaces flat ground plane)
  const { mesh: terrain } = createTerrain();
  arena.add(terrain);

  // Water plane
  arena.add(createWaterPlane());

  // 4 main pillars in cardinal positions (Nagrand-style)
  const pillarOffset = 8;
  arena.add(createPillar(-pillarOffset, -pillarOffset));
  arena.add(createPillar(pillarOffset, -pillarOffset));
  arena.add(createPillar(-pillarOffset, pillarOffset));
  arena.add(createPillar(pillarOffset, pillarOffset));

  // Center obstacles for LOS
  arena.add(createRamp(-3, 0, 2, 4, 1.2, Math.PI / 6));
  arena.add(createRamp(3, 0, 2, 4, 1.2, -Math.PI / 6));

  // Boundary walls
  arena.add(createBoundaryWalls());

  return arena;
}

/**
 * Create lighting for the arena
 */
export function createArenaLighting(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'Lighting';

  // Ambient light
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  lights.add(ambient);

  // Main directional light (sun)
  const sun = new THREE.DirectionalLight(0xffffee, 1.0);
  sun.position.set(10, 20, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 50;
  sun.shadow.camera.left = -25;
  sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -25;
  lights.add(sun);

  // Hemisphere light for softer ambient
  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x3d5c3d, 0.3);
  lights.add(hemi);

  return lights;
}
