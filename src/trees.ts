/**
 * Stylized Trees - Procedurally generated foliage with vertex shaders
 */

import * as THREE from 'three';

// Foliage vertex shader for billboarding and expansion
const foliageVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;

    // Remap UV from [0, 1] to [-1, 1] for centered expansion
    vec2 vertexOffset = vec2(
      uv.x * 2.0 - 1.0,
      uv.y * 2.0 - 1.0
    );

    // Transform to view space (camera relative)
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);

    // Scale expansion by distance for perspective effect
    float dist = length(mvPos.xyz);
    float scale = 0.8 + 0.2 * (1.0 - exp(-dist * 0.1));

    // Apply offset in camera-plane space (billboarding)
    mvPos.xy += vertexOffset * scale * 0.5;

    gl_Position = projectionMatrix * mvPos;
  }
`;

// Foliage fragment shader with alpha testing
const foliageFragmentShader = `
  uniform vec3 color;
  varying vec2 vUv;

  void main() {
    // Create organic leaf shape using noise
    float noise = fract(sin(vUv.x * 12.9898 + vUv.y * 78.233) * 43758.5453);

    // Create clumpy alpha mask
    float dist = length(vUv - vec2(0.5, 0.5));
    float alpha = smoothstep(0.6, 0.3, dist);
    alpha *= (0.6 + 0.4 * noise);

    // Alpha test for performance
    if (alpha < 0.3) discard;

    gl_FragColor = vec4(color, alpha);
  }
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

  // Foliage - multiple layers of billboard quads
  const foliageMaterial = new THREE.ShaderMaterial({
    vertexShader: foliageVertexShader,
    fragmentShader: foliageFragmentShader,
    uniforms: {
      color: { value: new THREE.Color(0x2d5016) }
    },
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.3
  });

  // Create foliage layers
  const layerCount = 3;
  for (let layer = 0; layer < layerCount; layer++) {
    const layerHeight = height * (0.4 + layer * 0.2);
    const layerRadius = height * (0.3 + layer * 0.15);

    // Create foliage quads
    const quadCount = 6 + layer * 2;
    for (let i = 0; i < quadCount; i++) {
      const angle = (i / quadCount) * Math.PI * 2;
      const qx = Math.cos(angle) * layerRadius;
      const qz = Math.sin(angle) * layerRadius;

      // Billboard quad geometry (properly UV mapped)
      const geometry = new THREE.PlaneGeometry(
        layerRadius * 0.8,
        layerHeight * 0.4
      );

      // Reset UVs for shader (fills entire 0-1 space)
      const uvAttribute = geometry.getAttribute('uv');
      for (let j = 0; j < uvAttribute.count; j++) {
        uvAttribute.setXY(j, (j % 2), Math.floor(j / 2));
      }

      const foliage = new THREE.Mesh(geometry, foliageMaterial);
      foliage.position.set(qx, layerHeight, qz);
      foliage.lookAt(0, layerHeight, 0); // Face center
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

  const foliageMaterial = new THREE.ShaderMaterial({
    vertexShader: foliageVertexShader,
    fragmentShader: foliageFragmentShader,
    uniforms: {
      color: { value: new THREE.Color(0x3d5c1f) }
    },
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.3
  });

  // Create rounded foliage blob
  const quadCount = 8;
  for (let i = 0; i < quadCount; i++) {
    const angle = (i / quadCount) * Math.PI * 2;
    const radius = height * 0.4;
    const qx = Math.cos(angle) * radius;
    const qz = Math.sin(angle) * radius;

    const geometry = new THREE.PlaneGeometry(height * 0.6, height * 0.6);

    // Reset UVs
    const uvAttribute = geometry.getAttribute('uv');
    for (let j = 0; j < uvAttribute.count; j++) {
      uvAttribute.setXY(j, (j % 2), Math.floor(j / 2));
    }

    const foliage = new THREE.Mesh(geometry, foliageMaterial);
    foliage.position.set(qx, 0, qz);
    foliage.lookAt(0, 0, 0);
    foliage.castShadow = true;
    foliage.receiveShadow = true;
    bush.add(foliage);
  }

  return bush;
}
