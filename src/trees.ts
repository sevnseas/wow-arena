/**
 * Stylized Trees - faithful port of https://douges.dev/blog/threejs-trees-1
 * Uses douges' tree.glb + foliage_alpha3.png with vertex-shader leaf billboarding & wind sway.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BASE = (import.meta as any).env?.BASE_URL ?? '/';
const TREE_GLB_URL = `${BASE}trees/tree.glb`;
const FOLIAGE_ALPHA_URL = `${BASE}trees/foliage_alpha3.png`;

interface FoliageUniforms {
  u_effectBlend: { value: number };
  u_inflate: { value: number };
  u_scale: { value: number };
  u_windSpeed: { value: number };
  u_windTime: { value: number };
}

// Single shared uniforms object so wind animates all foliage in sync at minimal cost
const sharedUniforms: FoliageUniforms = {
  u_effectBlend: { value: 1.0 },
  u_inflate: { value: 0.0 },
  u_scale: { value: 1.0 },
  u_windSpeed: { value: 1.0 },
  u_windTime: { value: 0.0 }
};

let tickerStarted = false;
function startWindTicker() {
  if (tickerStarted) return;
  tickerStarted = true;
  let last = performance.now();
  const tick = (now: number) => {
    const delta = (now - last) / 1000;
    last = now;
    sharedUniforms.u_windTime.value += sharedUniforms.u_windSpeed.value * delta;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function createFoliageMaterial(alphaMap: THREE.Texture): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#3f6d21'),
    alphaMap,
    alphaTest: 0.5,
    transparent: false,
    side: THREE.FrontSide,
    roughness: 0.9,
    metalness: 0.0
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.u_effectBlend = sharedUniforms.u_effectBlend;
    shader.uniforms.u_inflate = sharedUniforms.u_inflate;
    shader.uniforms.u_scale = sharedUniforms.u_scale;
    shader.uniforms.u_windSpeed = sharedUniforms.u_windSpeed;
    shader.uniforms.u_windTime = sharedUniforms.u_windTime;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      /* glsl */ `
      #include <common>
      uniform float u_effectBlend;
      uniform float u_inflate;
      uniform float u_scale;
      uniform float u_windSpeed;
      uniform float u_windTime;

      float inverseLerp(float v, float minValue, float maxValue) {
        return (v - minValue) / (maxValue - minValue);
      }
      float remap(float v, float inMin, float inMax, float outMin, float outMax) {
        return mix(outMin, outMax, inverseLerp(v, inMin, inMax));
      }
      mat4 rotateZ(float radians) {
        float c = cos(radians);
        float s = sin(radians);
        return mat4(c, -s, 0, 0,  s, c, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1);
      }
      vec4 applyWind(vec4 v) {
        float boundedYNormal = remap(normal.y, -1.0, 1.0, 0.0, 1.0);
        float posXZ = position.x + position.z;
        float power = u_windSpeed / 5.0 * -0.5;
        float topFacing = remap(sin(u_windTime + posXZ), -1.0, 1.0, 0.0, power);
        float bottomFacing = remap(cos(u_windTime + posXZ), -1.0, 1.0, 0.0, 0.05);
        float radians = mix(bottomFacing, topFacing, boundedYNormal);
        return rotateZ(radians) * v;
      }
      vec2 calcInitialOffsetFromUVs() {
        vec2 offset = vec2(
          remap(uv.x, 0.0, 1.0, -1.0, 1.0),
          remap(uv.y, 0.0, 1.0, -1.0, 1.0)
        );
        offset *= vec2(-1.0, 1.0);
        offset = normalize(offset) * u_scale;
        return offset;
      }
      vec3 inflateOffset(vec3 offset) {
        return offset + normal.xyz * u_inflate;
      }
      `
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      mvPosition = modelViewMatrix * mvPosition;

      vec2 vertexOffset = calcInitialOffsetFromUVs();
      vec3 inflatedVertexOffset = inflateOffset(vec3(vertexOffset, 0.0));
      mvPosition += vec4(mix(vec3(0.0), inflatedVertexOffset, u_effectBlend), 0.0);
      mvPosition = applyWind(mvPosition);

      gl_Position = projectionMatrix * mvPosition;
      `
    );
  };

  return material;
}

interface TreeAssets {
  trunkMesh: THREE.Mesh;
  foliageMesh: THREE.Mesh;
  foliageMaterial: THREE.MeshStandardMaterial;
  trunkMaterial: THREE.MeshBasicMaterial;
}

let assetsPromise: Promise<TreeAssets> | null = null;
function loadTreeAssets(): Promise<TreeAssets> {
  if (assetsPromise) return assetsPromise;

  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  texLoader.setCrossOrigin('anonymous');

  const gltfP = new Promise<THREE.Group>((resolve, reject) => {
    gltfLoader.setCrossOrigin('anonymous');
    gltfLoader.load(TREE_GLB_URL, (gltf) => resolve(gltf.scene), undefined, reject);
  });
  const texP = new Promise<THREE.Texture>((resolve, reject) => {
    texLoader.load(FOLIAGE_ALPHA_URL, (t) => resolve(t), undefined, reject);
  });

  assetsPromise = Promise.all([gltfP, texP]).then(([scene, alphaMap]) => {
    alphaMap.colorSpace = THREE.NoColorSpace;
    alphaMap.wrapS = THREE.ClampToEdgeWrapping;
    alphaMap.wrapT = THREE.ClampToEdgeWrapping;

    let trunkMesh: THREE.Mesh | null = null;
    let foliageMesh: THREE.Mesh | null = null;
    scene.updateMatrixWorld(true);
    scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        if (mesh.name === 'trunk') trunkMesh = mesh;
        else if (mesh.name === 'foliage') foliageMesh = mesh;
      }
    });
    if (!trunkMesh || !foliageMesh) {
      throw new Error('tree.glb missing expected "trunk" or "foliage" mesh');
    }

    const foliageMaterial = createFoliageMaterial(alphaMap);
    const trunkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });

    startWindTicker();

    return { trunkMesh, foliageMesh, foliageMaterial, trunkMaterial };
  });

  return assetsPromise;
}

function buildTreeMesh(assets: TreeAssets, scale: number): THREE.Group {
  const tree = new THREE.Group();
  tree.name = 'Tree';

  const trunk = new THREE.Mesh(assets.trunkMesh.geometry, assets.trunkMaterial);
  trunk.position.copy(assets.trunkMesh.position);
  trunk.quaternion.copy(assets.trunkMesh.quaternion);
  trunk.scale.copy(assets.trunkMesh.scale);
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  tree.add(trunk);

  const foliage = new THREE.Mesh(assets.foliageMesh.geometry, assets.foliageMaterial);
  foliage.position.copy(assets.foliageMesh.position);
  foliage.quaternion.copy(assets.foliageMesh.quaternion);
  foliage.scale.copy(assets.foliageMesh.scale);
  foliage.castShadow = true;
  foliage.receiveShadow = true;
  tree.add(foliage);

  tree.scale.setScalar(scale);
  return tree;
}

/**
 * Create a forest in the arena surroundings.
 * Returns immediately with an empty group; trees are added asynchronously once assets load.
 */
export function createForest(terrainHeightData: Uint8Array | null): THREE.Group {
  const forest = new THREE.Group();
  forest.name = 'Forest';

  const minDist = 16;
  const maxDist = 40;
  const treeCount = 14;

  const placements: Array<{ x: number; z: number; y: number; scale: number; rotY: number }> = [];
  for (let i = 0; i < treeCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = minDist + Math.random() * (maxDist - minDist);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;

    let terrainHeight = 0;
    if (terrainHeightData) {
      const localX = Math.max(0, Math.min(99, Math.floor(x + 50)));
      const localZ = Math.max(0, Math.min(99, Math.floor(z + 50)));
      terrainHeight = (terrainHeightData[localZ * 100 + localX] / 255) * 3;
    }

    placements.push({
      x,
      z,
      y: terrainHeight,
      scale: 1.6 + Math.random() * 1.0,
      rotY: Math.random() * Math.PI * 2
    });
  }

  loadTreeAssets()
    .then((assets) => {
      for (const p of placements) {
        const tree = buildTreeMesh(assets, p.scale);
        tree.position.set(p.x, p.y, p.z);
        tree.rotation.y = p.rotY;
        forest.add(tree);
      }
    })
    .catch((err) => {
      console.error('[trees] failed to load tree assets', err);
    });

  return forest;
}
