/**
 * Low-poly procedural terrain using simplex noise
 */

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

const TERRAIN_SIZE = 100;
const TERRAIN_SEGMENTS = 100;
const TERRAIN_MAX_HEIGHT = 3;
const NOISE_SCALE_1 = 50;
const NOISE_SCALE_2 = 25;

/**
 * Generate height data using layered simplex noise
 */
function generateHeightData(width: number, height: number): Uint8Array {
  const noise2D = createNoise2D();
  const size = width * height;
  const data = new Uint8Array(size);

  for (let i = 0; i < size; i++) {
    const x = i % width;
    const y = Math.floor(i / width);

    // Layered noise (octaves) creates more natural terrain
    let v =
      noise2D(x / NOISE_SCALE_1, y / NOISE_SCALE_1) * 0.5 +
      noise2D(x / NOISE_SCALE_2, y / NOISE_SCALE_2) * 0.25;

    data[i] = (v + 0.75) * 128; // Normalize to 0-255
  }

  return data;
}

/**
 * Get terrain height at world coordinates
 */
export function getTerrainHeight(x: number, z: number, heightData: Uint8Array | null): number {
  if (!heightData) return 0;
  const centerX = TERRAIN_SIZE / 2;
  const centerZ = TERRAIN_SIZE / 2;
  const localX = Math.floor(x + centerX);
  const localZ = Math.floor(z + centerZ);

  // Clamp to terrain bounds
  const clampedX = Math.max(0, Math.min(TERRAIN_SEGMENTS - 1, localX));
  const clampedZ = Math.max(0, Math.min(TERRAIN_SEGMENTS - 1, localZ));

  const dataIndex = clampedZ * TERRAIN_SEGMENTS + clampedX;
  const normalizedHeight = heightData[dataIndex] / 255;
  return normalizedHeight * TERRAIN_MAX_HEIGHT;
}

/**
 * Create the low-poly terrain mesh
 */
export function createTerrain(): { mesh: THREE.Mesh; heightData: Uint8Array } {
  // Generate height data
  const heightData = generateHeightData(TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);

  // Create base geometry
  const geometry = new THREE.PlaneGeometry(
    TERRAIN_SIZE,
    TERRAIN_SIZE,
    TERRAIN_SEGMENTS - 1,
    TERRAIN_SEGMENTS - 1
  );
  geometry.rotateX(-Math.PI / 2); // Lay it flat

  // Convert to non-indexed for independent vertex colors/shading
  const lowPolyGeom = geometry.toNonIndexed();
  const posAttribute = lowPolyGeom.getAttribute('position');

  // Apply height data to vertices
  for (let i = 0; i < posAttribute.count; i++) {
    const x = Math.floor(posAttribute.getX(i) + TERRAIN_SIZE / 2);
    const z = Math.floor(posAttribute.getZ(i) + TERRAIN_SIZE / 2);
    const clampedX = Math.max(0, Math.min(TERRAIN_SEGMENTS - 1, x));
    const clampedZ = Math.max(0, Math.min(TERRAIN_SEGMENTS - 1, z));
    const dataIndex = clampedZ * TERRAIN_SEGMENTS + clampedX;

    const h = (heightData[dataIndex] / 255) * TERRAIN_MAX_HEIGHT;
    posAttribute.setY(i, h);
  }

  // Compute normals for lighting (flat shading does the low-poly look)
  lowPolyGeom.computeVertexNormals();

  // Apply height-based vertex colors
  const colors = [];
  const color = new THREE.Color();

  for (let i = 0; i < posAttribute.count; i++) {
    const y = posAttribute.getY(i);

    // Color by elevation (matching WotLK aesthetic)
    if (y < 0.5) color.setHex(0x3a7d5f); // Dark grass
    else if (y < 1.2) color.setHex(0x5a9d7f); // Medium grass
    else if (y < 1.8) color.setHex(0x7ab99f); // Light grass
    else if (y < 2.3) color.setHex(0xaa9966); // Stone/dirt
    else color.setHex(0xcccccc); // High peaks

    colors.push(color.r, color.g, color.b);
  }

  lowPolyGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  // Create material with vertex colors and flat shading
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    side: THREE.DoubleSide
  });

  const terrain = new THREE.Mesh(lowPolyGeom, material);
  terrain.receiveShadow = true;
  terrain.name = 'Terrain';

  return { mesh: terrain, heightData };
}

/**
 * Create water plane at base level
 */
export function createWaterPlane(): THREE.Mesh {
  const waterGeometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE);
  waterGeometry.rotateX(-Math.PI / 2);

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a5f7f,
    roughness: 0.3,
    metalness: 0.8,
    transparent: true,
    opacity: 0.4,
    depthWrite: false
  });

  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.position.y = 0.05; // Slightly above ground
  water.name = 'Water';

  return water;
}
