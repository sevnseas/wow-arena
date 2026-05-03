/**
 * Stylized Trees - Procedurally generated foliage with vertex shaders
 * Based on https://douges.dev/blog/threejs-trees-1
 */

import * as THREE from 'three';
// @ts-ignore
import CustomShaderMaterial from 'three-custom-shader-material/vanilla';

// Foliage vertex shader - translates vertices in view space for billboard effect
const foliageVertexShader = `
  // Remap UV from [0, 1] to [-1, 1] for centered expansion
  vec2 vertexOffset = vec2(
    uv.x * 2.0 - 1.0,
    uv.y * 2.0 - 1.0
  );

  // Transform to view space (camera relative)
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);

  // Apply offset in camera-plane space (billboarding effect)
  // This stretches the foliage when not viewed head-on, creating a natural look
  mvPos.xy += vertexOffset * 0.6;

  gl_Position = projectionMatrix * mvPos;
`;

/**
 * Create a procedural tree with trunk and foliage
 */
function createProceduralTree(
  x: number,
  z: number,
  height: number
): THREE.Group {
  const tree = new THREE.Group();
  tree.position.set(x, height, z);
  tree.name = 'Tree';

  // Trunk
  const trunkGeometry = new THREE.CylinderGeometry(0.3, 0.5, height * 0.6, 8);
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: 0x5d4037,
    roughness: 0.8,
    metalness: 0.0
  });
  const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
  trunk.position.y = height * 0.3;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  tree.add(trunk);

  // Foliage material using CustomShaderMaterial for proper lighting
  const foliageMaterial = new CustomShaderMaterial({
    baseMaterial: THREE.MeshStandardMaterial,
    color: 0x2d5016,
    roughness: 0.7,
    metalness: 0.0,
    vertexShader: foliageVertexShader,
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.5
  });

  // Create foliage as crossing planes (X pattern at multiple heights)
  const layerCount = 3;
  for (let layer = 0; layer < layerCount; layer++) {
    const layerHeight = height * (0.4 + layer * 0.2);
    const layerSize = height * (0.6 + layer * 0.2);

    // Two perpendicular planes (X pattern)
    for (let plane = 0; plane < 2; plane++) {
      const geometry = new THREE.PlaneGeometry(layerSize, layerSize);

      const foliage = new THREE.Mesh(geometry, foliageMaterial);
      foliage.position.y = layerHeight;

      // Rotate second plane 90 degrees for crossing pattern
      if (plane === 1) {
        foliage.rotation.y = Math.PI / 4;
      }

      foliage.castShadow = true;
      foliage.receiveShadow = true;
      tree.add(foliage);
    }
  }

  return tree;
}

/**
 * Create a forest in the arena surroundings
 */
export function createForest(terrainHeightData: Uint8Array | null): THREE.Group {
  const forest = new THREE.Group();
  forest.name = 'Forest';

  // Tree placement area (outside core arena)
  const minDist = 16; // Minimum distance from center (arena core)
  const maxDist = 40; // Maximum distance from center (terrain edge)
  const treeCount = 12;

  for (let i = 0; i < treeCount; i++) {
    // Random angle and distance for natural placement
    const angle = Math.random() * Math.PI * 2;
    const dist = minDist + Math.random() * (maxDist - minDist);

    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;

    // Vary tree height
    const baseHeight = 4 + Math.random() * 3;

    // Get terrain height at this location
    let terrainHeight = 0;
    if (terrainHeightData) {
      const centerX = 50;
      const centerZ = 50;
      const localX = Math.floor(x + centerX);
      const localZ = Math.floor(z + centerZ);
      const clampedX = Math.max(0, Math.min(99, localX));
      const clampedZ = Math.max(0, Math.min(99, localZ));
      const dataIndex = clampedZ * 100 + clampedX;
      terrainHeight = (terrainHeightData[dataIndex] / 255) * 3;
    }

    const tree = createProceduralTree(x, z, baseHeight);
    tree.position.y = terrainHeight;
    forest.add(tree);
  }

  return forest;
}

/**
 * Create a single stylized bush/shrub
 */
export function createBush(x: number, z: number, height: number): THREE.Group {
  const bush = new THREE.Group();
  bush.position.set(x, height * 0.5, z);
  bush.name = 'Bush';

  const foliageMaterial = new CustomShaderMaterial({
    baseMaterial: THREE.MeshStandardMaterial,
    color: 0x3d5c1f,
    roughness: 0.7,
    metalness: 0.0,
    vertexShader: foliageVertexShader,
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.5
  });

  // Create X-pattern crossing planes
  for (let plane = 0; plane < 2; plane++) {
    const geometry = new THREE.PlaneGeometry(height * 0.8, height);

    const foliage = new THREE.Mesh(geometry, foliageMaterial);
    foliage.position.set(0, 0, 0);

    if (plane === 1) {
      foliage.rotation.y = Math.PI / 2;
    }

    foliage.castShadow = true;
    foliage.receiveShadow = true;
    bush.add(foliage);
  }

  return bush;
}
