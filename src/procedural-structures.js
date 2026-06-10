/**
 * Shared low-poly Warcraft-style structure kit.
 *
 * The live game and tools/render-structures.mjs both consume these builders,
 * so structure contact sheets render the same geometry that ships in-world.
 */

import * as THREE from 'three';

export const DEFAULT_STRUCTURE_PALETTE = {
  plaster: 0xb89a6a,
  plasterLight: 0xd1b47d,
  timber: 0x5a351d,
  timberDark: 0x301b10,
  thatch: 0x7c4b20,
  thatchLight: 0xa56b2b,
  stone: 0x93846e,
  stoneLight: 0xb8a58b,
  stoneDark: 0x5d554d,
  iron: 0x403d3b,
  clothRed: 0x8d2d25,
  clothBlue: 0x315d85,
  clothGold: 0xc9a13d,
  ember: 0xff8a24,
  water: 0x4e9ab5,
};

export function makeRng(seed) {
  let a = seed | 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function palette(overrides = {}) {
  return { ...DEFAULT_STRUCTURE_PALETTE, ...overrides };
}

/**
 * Broad procedural texturing for every structure piece: world-space value
 * noise breaks each flat low-poly face into hand-painted tonal patches, and a
 * subtle directional banding suggests planks / coursed stone / thatch strands
 * without UVs or texture assets. Shared GLSL so three.js compiles one program.
 */
function structureTexturing(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n varying vec3 vStructWorld;')
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n vStructWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      /* glsl */ `
      #include <common>
      varying vec3 vStructWorld;
      float sthash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.1, 0.17, 0.13));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float stnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(sthash(i), sthash(i + vec3(1,0,0)), u.x),
              mix(sthash(i + vec3(0,1,0)), sthash(i + vec3(1,1,0)), u.x), u.y),
          mix(mix(sthash(i + vec3(0,0,1)), sthash(i + vec3(1,0,1)), u.x),
              mix(sthash(i + vec3(0,1,1)), sthash(i + vec3(1,1,1)), u.x), u.y),
          u.z);
      }
      `,
    )
    .replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      /* glsl */ `
      vec4 diffuseColor = vec4( diffuse, opacity );
      {
        // Painterly tonal patches at two scales.
        float tonal = stnoise(vStructWorld * 1.7) * 0.65 + stnoise(vStructWorld * 6.5) * 0.35;
        // Horizontal banding — reads as planks on timber, courses on stone,
        // strand layers on thatch. Softened by the noise so it never tiles.
        float band = sin(vStructWorld.y * 9.0 + stnoise(vStructWorld * 2.2) * 3.0) * 0.5 + 0.5;
        float shade = 0.90 + tonal * 0.18 + band * 0.06;
        // Weathering: pieces darken slightly toward the ground line.
        shade *= 0.94 + 0.06 * clamp(vStructWorld.y * 0.6, 0.0, 1.0);
        diffuseColor.rgb *= shade;
      }
      `,
    );
}

function mat(color, roughness = 0.95) {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness: 0,
    flatShading: true,
  });
  m.onBeforeCompile = structureTexturing;
  // Identical shader for every structure material → one cached program.
  m.customProgramCacheKey = () => 'structure-texturing';
  return m;
}

function glowMat(color) {
  return new THREE.MeshBasicMaterial({ color });
}

function addMesh(
  group,
  geometry,
  material,
  {
    name = 'Piece',
    position = [0, 0, 0],
    rotation = [0, 0, 0],
    scale = [1, 1, 1],
  } = {},
) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function place(group, child, x, z, y = 0, yaw = 0, scale = 1) {
  child.position.set(x, y, z);
  child.rotation.y = yaw;
  child.scale.setScalar(scale);
  group.add(child);
  return child;
}

export function setStructureCollider(group, collider) {
  group.userData.collider = collider;
  return group;
}

export function addStructureCollider(group, collider) {
  if (!group.userData.colliders) group.userData.colliders = [];
  group.userData.colliders.push(collider);
  return group;
}

export function addWallPlaneCollider(
  group,
  {
    x = 0,
    z = 0,
    width,
    height,
    thickness = 0.16,
    rotation = 0,
  },
) {
  return addStructureCollider(group, {
    type: 'plane',
    x,
    z,
    width,
    height,
    thickness,
    rotation,
  });
}

/**
 * Flatten local structure metadata into the box/cylinder physics shapes used
 * by the game. Plane metadata stays pleasant to author while compiling to a
 * thin oriented box, so the runtime physics layer does not need a third path.
 */
export function collectStructureColliders(root) {
  root.updateMatrixWorld(true);
  const colliders = [];
  const center = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const rotation = new THREE.Euler();

  root.traverse(object => {
    const singular = object.userData.collider;
    const multiple = object.userData.colliders ?? [];
    const authored = singular ? [singular, ...multiple] : multiple;
    if (authored.length === 0) return;

    object.getWorldScale(scale);
    object.getWorldQuaternion(quaternion);
    rotation.setFromQuaternion(quaternion, 'YXZ');
    for (const collider of authored) {
      center
        .set(collider.x ?? 0, 0, collider.z ?? 0)
        .applyMatrix4(object.matrixWorld);
      if (collider.type === 'cylinder') {
        colliders.push({
          type: 'cylinder',
          x: center.x,
          z: center.z,
          radius: collider.radius * Math.max(scale.x, scale.z),
          height: collider.height * scale.y,
        });
        continue;
      }
      const depth = collider.type === 'plane' ? collider.thickness : collider.depth;
      colliders.push({
        type: 'box',
        x: center.x,
        z: center.z,
        width: collider.width * scale.x,
        depth: depth * scale.z,
        height: collider.height * scale.y,
        rotation: rotation.y + (collider.rotation ?? 0),
      });
    }
  });
  return colliders;
}

function addBeam(group, material, x, y, z, sx, sy, sz, rz = 0, ry = 0) {
  return addMesh(group, new THREE.BoxGeometry(sx, sy, sz), material, {
    name: 'TimberBeam',
    position: [x, y, z],
    rotation: [0, ry, rz],
  });
}

function addBattlements(group, material, width, depth, y, count = 4) {
  const block = 0.42;
  const height = 0.48;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = THREE.MathUtils.lerp(-width * 0.42, width * 0.42, t);
    const z = THREE.MathUtils.lerp(-depth * 0.42, depth * 0.42, t);
    addMesh(group, new THREE.BoxGeometry(block, height, block), material, {
      name: 'Battlement',
      position: [x, y, -depth * 0.5],
    });
    addMesh(group, new THREE.BoxGeometry(block, height, block), material, {
      name: 'Battlement',
      position: [x, y, depth * 0.5],
    });
    addMesh(group, new THREE.BoxGeometry(block, height, block), material, {
      name: 'Battlement',
      position: [-width * 0.5, y, z],
    });
    addMesh(group, new THREE.BoxGeometry(block, height, block), material, {
      name: 'Battlement',
      position: [width * 0.5, y, z],
    });
  }
}

function addDoorBraces(group, material, x, y, z, width, height, yaw = 0) {
  for (const offset of [-width * 0.38, width * 0.38]) {
    addMesh(group, new THREE.BoxGeometry(0.09, height * 0.9, 0.09), material, {
      name: 'DoorBrace',
      position: [x + offset * Math.cos(yaw), y, z - offset * Math.sin(yaw)],
      rotation: [0, yaw, 0],
    });
  }
  addMesh(group, new THREE.BoxGeometry(width * 0.9, 0.1, 0.1), material, {
    name: 'DoorBrace',
    position: [x, y + height * 0.18, z],
    rotation: [0, yaw, 0],
  });
}

function addWindow(group, p, x, y, z, yaw = 0, width = 0.62, height = 0.82) {
  const dark = mat(0x1d1710);
  const wood = mat(p.timberDark);
  addMesh(group, new THREE.BoxGeometry(width, height, 0.075), dark, {
    name: 'WindowInset',
    position: [x, y, z],
    rotation: [0, yaw, 0],
  });
  for (const offset of [-width * 0.57, width * 0.57]) {
    addMesh(group, new THREE.BoxGeometry(0.1, height + 0.16, 0.1), wood, {
      name: 'WindowFrame',
      position: [x + offset * Math.cos(yaw), y, z - offset * Math.sin(yaw)],
      rotation: [0, yaw, 0],
    });
  }
  for (const offset of [-height * 0.58, height * 0.58]) {
    addMesh(group, new THREE.BoxGeometry(width + 0.2, 0.1, 0.1), wood, {
      name: 'WindowFrame',
      position: [x, y + offset, z],
      rotation: [0, yaw, 0],
    });
  }
  addMesh(group, new THREE.BoxGeometry(width * 0.88, 0.07, 0.095), wood, {
    name: 'WindowMullion',
    position: [x, y, z],
    rotation: [0, yaw, 0],
  });
}

function addStoneBand(group, material, width, depth, y, height = 0.25) {
  addMesh(group, new THREE.BoxGeometry(width, height, depth), material, {
    name: 'StoneBand',
    position: [0, y, 0],
  });
}

export function createCrate({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Crate';
  const wood = mat(p.timber);
  const dark = mat(p.timberDark);
  addMesh(group, new THREE.BoxGeometry(0.8, 0.8, 0.8), wood, { position: [0, 0.4, 0] });
  addBeam(group, dark, 0, 0.4, 0.415, 0.12, 0.82, 0.04);
  addBeam(group, dark, 0, 0.4, -0.415, 0.12, 0.82, 0.04);
  addBeam(group, dark, 0.415, 0.4, 0, 0.04, 0.82, 0.12);
  addBeam(group, dark, -0.415, 0.4, 0, 0.04, 0.82, 0.12);
  addBeam(group, dark, 0, 0.4, 0.42, 0.1, 1.05, 0.05, -0.72);
  addBeam(group, dark, 0, 0.4, 0.425, 0.1, 1.05, 0.05, 0.72);
  addBeam(group, dark, 0.42, 0.4, 0, 0.1, 1.05, 0.05, -0.72, Math.PI / 2);
  for (const y of [0.07, 0.73]) {
    addMesh(group, new THREE.BoxGeometry(0.92, 0.1, 0.92), dark, {
      name: 'CrateRim',
      position: [0, y, 0],
    });
  }
  group.scale.setScalar(scale);
  return group;
}

export function createBarrel({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Barrel';
  addMesh(group, new THREE.CylinderGeometry(0.42, 0.42, 0.92, 10), mat(p.timber), {
    position: [0, 0.46, 0],
  });
  for (const y of [0.14, 0.46, 0.78]) {
    addMesh(group, new THREE.TorusGeometry(0.43, 0.035, 5, 10), mat(p.iron), {
      position: [0, y, 0],
      rotation: [Math.PI / 2, 0, 0],
    });
  }
  addMesh(group, new THREE.CylinderGeometry(0.37, 0.37, 0.055, 10), mat(p.thatchLight), {
    name: 'BarrelLid',
    position: [0, 0.96, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(0.045, 0.055, 0.24, 6), mat(p.iron), {
    name: 'BarrelTap',
    position: [0, 0.48, 0.5],
    rotation: [Math.PI / 2, 0, 0],
  });
  group.scale.setScalar(scale);
  return group;
}

export function createBench({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Bench';
  const wood = mat(p.timber);
  const dark = mat(p.timberDark);
  addMesh(group, new THREE.BoxGeometry(2.35, 0.18, 0.62), wood, {
    name: 'BenchSeat',
    position: [0, 0.8, 0],
  });
  addMesh(group, new THREE.BoxGeometry(2.35, 0.18, 0.38), wood, {
    name: 'BenchBack',
    position: [0, 1.42, -0.34],
    rotation: [0.12, 0, 0],
  });
  for (const x of [-0.92, 0.92]) {
    addMesh(group, new THREE.CylinderGeometry(0.1, 0.14, 0.82, 6), dark, {
      name: 'BenchLeg',
      position: [x, 0.4, -0.2],
    });
    addMesh(group, new THREE.CylinderGeometry(0.1, 0.14, 0.82, 6), dark, {
      name: 'BenchLeg',
      position: [x, 0.4, 0.2],
    });
    addBeam(group, dark, x, 1.13, -0.36, 0.13, 1.2, 0.13, -0.12);
  }
  addBeam(group, dark, 0, 0.53, 0, 1.95, 0.12, 0.12);
  group.scale.setScalar(scale);
  return group;
}

export function createBanner({ color, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const cloth = color ?? p.clothRed;
  const group = new THREE.Group();
  group.name = 'Banner';
  addMesh(group, new THREE.CylinderGeometry(0.055, 0.075, 3.1, 6), mat(p.timberDark), {
    position: [0, 1.55, 0],
  });
  addMesh(group, new THREE.BoxGeometry(0.95, 1.35, 0.06), mat(cloth), {
    position: [0.5, 2.25, 0],
  });
  addBeam(group, mat(p.iron), 0.48, 2.94, 0, 1.12, 0.07, 0.07);
  addMesh(group, new THREE.BoxGeometry(0.11, 1.28, 0.075), mat(p.clothGold), {
    name: 'BannerTrim',
    position: [0.08, 2.24, 0.05],
  });
  addMesh(group, new THREE.BoxGeometry(0.66, 0.12, 0.075), mat(p.clothGold), {
    name: 'BannerMark',
    position: [0.54, 2.36, 0.05],
    rotation: [0, 0, -0.48],
  });
  addMesh(group, new THREE.BoxGeometry(0.66, 0.12, 0.075), mat(p.clothGold), {
    name: 'BannerMark',
    position: [0.54, 2.36, 0.05],
    rotation: [0, 0, 0.48],
  });
  addMesh(group, new THREE.ConeGeometry(0.14, 0.35, 4), mat(p.clothGold), {
    position: [0, 3.25, 0],
  });
  group.scale.setScalar(scale);
  return group;
}

export function createCampfire({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Campfire';
  const rock = mat(p.stoneDark);
  const log = mat(p.timberDark);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addMesh(group, new THREE.DodecahedronGeometry(0.16, 0), rock, {
      position: [Math.cos(a) * 0.6, 0.13, Math.sin(a) * 0.6],
    });
  }
  addMesh(group, new THREE.CylinderGeometry(0.11, 0.11, 1.05, 6), log, {
    position: [0, 0.23, 0],
    rotation: [Math.PI / 2, 0, Math.PI / 4],
  });
  addMesh(group, new THREE.CylinderGeometry(0.11, 0.11, 1.05, 6), log, {
    position: [0, 0.23, 0],
    rotation: [Math.PI / 2, 0, -Math.PI / 4],
  });
  addMesh(group, new THREE.ConeGeometry(0.36, 1.0, 7), glowMat(p.ember), {
    name: 'Flame',
    position: [0, 0.83, 0],
  });
  addMesh(group, new THREE.ConeGeometry(0.2, 0.7, 7), glowMat(0xffd45a), {
    name: 'FlameCore',
    position: [0.05, 0.68, 0],
  });
  group.scale.setScalar(scale);
  return group;
}

export function createFenceSegment({ length = 4, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'FenceSegment';
  const wood = mat(p.timberDark);
  for (const x of [-length * 0.5, 0, length * 0.5]) {
    addMesh(group, new THREE.CylinderGeometry(0.1, 0.14, 1.55, 6), wood, {
      position: [x, 0.78, 0],
    });
    addMesh(group, new THREE.ConeGeometry(0.15, 0.35, 5), wood, {
      position: [x, 1.72, 0],
    });
  }
  addBeam(group, wood, 0, 0.62, 0, length, 0.16, 0.16, 0.08);
  addBeam(group, wood, 0, 1.08, 0, length, 0.16, 0.16, -0.08);
  addBeam(group, wood, -length * 0.25, 0.86, 0, length * 0.52, 0.12, 0.12, -0.38);
  addBeam(group, wood, length * 0.25, 0.86, 0, length * 0.52, 0.12, 0.12, 0.38);
  addWallPlaneCollider(group, { width: length, height: 1.55, thickness: 0.18 });
  group.scale.setScalar(scale);
  return group;
}

export function createSackPile({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'SackPile';
  const sack = mat(p.plaster);
  const tie = mat(p.timberDark);
  for (const [x, y, z, s] of [
    [-0.42, 0.38, 0, 1],
    [0.38, 0.32, 0.1, 0.84],
    [0.02, 0.78, -0.06, 0.78],
  ]) {
    addMesh(group, new THREE.SphereGeometry(0.48, 7, 5), sack, {
      name: 'Sack',
      position: [x, y, z],
      scale: [s * 0.82, s, s * 0.68],
    });
    addMesh(group, new THREE.TorusGeometry(0.14 * s, 0.035, 4, 7), tie, {
      name: 'SackTie',
      position: [x, y + s * 0.5, z],
      rotation: [Math.PI / 2, 0, 0],
    });
  }
  group.scale.setScalar(scale);
  return group;
}

export function createWoodpile({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Woodpile';
  const bark = mat(p.timberDark);
  const cut = mat(p.thatchLight);
  for (const [x, y, z] of [
    [-0.52, 0.2, 0], [0, 0.2, 0], [0.52, 0.2, 0],
    [-0.28, 0.56, 0], [0.28, 0.56, 0],
  ]) {
    addMesh(group, new THREE.CylinderGeometry(0.18, 0.2, 1.18, 7), bark, {
      name: 'FirewoodLog',
      position: [x, y, z],
      rotation: [Math.PI / 2, 0, 0],
    });
    addMesh(group, new THREE.CylinderGeometry(0.15, 0.15, 0.02, 7), cut, {
      name: 'LogEnd',
      position: [x, y, 0.6],
      rotation: [Math.PI / 2, 0, 0],
    });
  }
  group.scale.setScalar(scale);
  return group;
}

export function createSignpost({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Signpost';
  const wood = mat(p.timber);
  const dark = mat(p.timberDark);
  addMesh(group, new THREE.CylinderGeometry(0.1, 0.16, 2.75, 6), dark, {
    position: [0, 1.38, 0],
  });
  addMesh(group, new THREE.ConeGeometry(0.18, 0.42, 5), dark, {
    position: [0, 2.96, 0],
  });
  addMesh(group, new THREE.BoxGeometry(1.75, 0.42, 0.16), wood, {
    name: 'SignBoard',
    position: [0.62, 2.2, 0],
    rotation: [0, 0, 0.06],
  });
  addMesh(group, new THREE.BoxGeometry(1.4, 0.38, 0.16), wood, {
    name: 'SignBoard',
    position: [-0.48, 1.72, 0],
    rotation: [0, Math.PI, -0.08],
  });
  addMesh(group, new THREE.BoxGeometry(1.0, 0.08, 0.19), dark, {
    name: 'SignMark',
    position: [0.68, 2.2, 0.1],
    rotation: [0, 0, 0.06],
  });
  addMesh(group, new THREE.BoxGeometry(0.72, 0.08, 0.19), dark, {
    name: 'SignMark',
    position: [-0.5, 1.72, 0.1],
    rotation: [0, 0, -0.08],
  });
  group.scale.setScalar(scale);
  return group;
}

export function createWell({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'VillageWell';
  const stone = mat(p.stone);
  const wood = mat(p.timberDark);
  addMesh(group, new THREE.CylinderGeometry(1.1, 1.2, 0.8, 12, 1, true), stone, {
    position: [0, 0.4, 0],
  });
  addMesh(group, new THREE.TorusGeometry(1.15, 0.18, 6, 12), stone, {
    position: [0, 0.8, 0],
    rotation: [Math.PI / 2, 0, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(0.08, 0.1, 2.6, 6), wood, {
    position: [-0.95, 1.65, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(0.08, 0.1, 2.6, 6), wood, {
    position: [0.95, 1.65, 0],
  });
  addBeam(group, wood, 0, 2.85, 0, 2.45, 0.14, 0.14);
  addMesh(group, new THREE.CylinderGeometry(0.16, 0.16, 1.85, 8), wood, {
    name: 'WellSpindle',
    position: [0, 2.0, 0],
    rotation: [0, 0, Math.PI / 2],
  });
  addMesh(group, new THREE.CylinderGeometry(0.035, 0.035, 1.25, 6), mat(p.iron), {
    name: 'WellRope',
    position: [0, 1.28, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(0.24, 0.3, 0.42, 8, 1, true), mat(p.timber), {
    name: 'WellBucket',
    position: [0, 0.72, 0],
  });
  addMesh(group, new THREE.BoxGeometry(2.8, 0.16, 1.7), mat(p.thatch), {
    name: 'WellRoof',
    position: [0, 3.05, 0.52],
    rotation: [0.56, 0, 0],
  });
  addMesh(group, new THREE.BoxGeometry(2.8, 0.16, 1.7), mat(p.thatch), {
    name: 'WellRoof',
    position: [0, 3.05, -0.52],
    rotation: [-0.56, 0, 0],
  });
  addBeam(group, wood, 0, 3.52, 0, 3.0, 0.13, 0.13);
  addMesh(group, new THREE.CylinderGeometry(0.05, 0.05, 0.62, 6), mat(p.iron), {
    name: 'WellHandle',
    position: [1.1, 2.0, 0],
    rotation: [0, 0, Math.PI / 2],
  });
  setStructureCollider(group, { type: 'cylinder', radius: 1.2, height: 0.98 });
  group.scale.setScalar(scale);
  return group;
}

export function createFountain({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'TownFountain';
  const stone = mat(p.stone);
  const light = mat(p.stoneLight);
  addMesh(group, new THREE.CylinderGeometry(2.22, 2.42, 0.58, 12, 1, true), stone, {
    name: 'FountainBasin',
    position: [0, 0.29, 0],
  });
  addMesh(group, new THREE.TorusGeometry(2.26, 0.2, 6, 12), light, {
    name: 'FountainRim',
    position: [0, 0.62, 0],
    rotation: [Math.PI / 2, 0, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(2.06, 2.06, 0.08, 12), glowMat(p.water), {
    name: 'FountainWater',
    position: [0, 0.56, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(0.58, 0.78, 1.94, 9), stone, {
    name: 'FountainPedestal',
    position: [0, 1.5, 0],
  });
  addMesh(group, new THREE.TorusGeometry(0.72, 0.16, 6, 10), light, {
    name: 'FountainPedestalBand',
    position: [0, 2.18, 0],
    rotation: [Math.PI / 2, 0, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(1.1, 0.72, 0.36, 10), light, {
    name: 'FountainUpperBowl',
    position: [0, 2.6, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(0.94, 0.94, 0.06, 10), glowMat(p.water), {
    name: 'FountainUpperWater',
    position: [0, 2.8, 0],
  });
  addMesh(group, new THREE.ConeGeometry(0.34, 0.96, 7), light, {
    name: 'FountainFinial',
    position: [0, 3.22, 0],
  });
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5;
    addMesh(group, new THREE.CylinderGeometry(0.055, 0.055, 1.28, 5), glowMat(p.water), {
      name: 'WaterJet',
      position: [Math.sin(a) * 0.96, 1.82, Math.cos(a) * 0.96],
      rotation: [Math.cos(a) * 0.72, 0, -Math.sin(a) * 0.72],
    });
  }
  setStructureCollider(group, { type: 'cylinder', radius: 2.42, height: 0.82 });
  group.scale.setScalar(scale);
  return group;
}

export function createNoticeBoard({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'NoticeBoard';
  const wood = mat(p.timberDark);
  for (const x of [-1.02, 1.02]) {
    addMesh(group, new THREE.CylinderGeometry(0.1, 0.15, 2.42, 6), wood, {
      name: 'BoardPost',
      position: [x, 1.21, 0],
    });
    addMesh(group, new THREE.ConeGeometry(0.16, 0.38, 5), wood, {
      name: 'BoardPostCap',
      position: [x, 2.58, 0],
    });
  }
  addMesh(group, new THREE.BoxGeometry(2.48, 1.42, 0.16), mat(p.timber), {
    name: 'NoticeBoardPanel',
    position: [0, 1.64, 0],
  });
  for (const [x, y, color] of [
    [-0.66, 1.82, p.plasterLight],
    [0.12, 1.48, p.clothGold],
    [0.68, 1.94, p.plasterLight],
  ]) {
    addMesh(group, new THREE.BoxGeometry(0.58, 0.66, 0.035), mat(color), {
      name: 'Notice',
      position: [x, y, 0.1],
      rotation: [0, 0, x * 0.08],
    });
    addMesh(group, new THREE.CylinderGeometry(0.045, 0.045, 0.04, 6), mat(p.iron), {
      name: 'NoticePin',
      position: [x, y + 0.22, 0.15],
      rotation: [Math.PI / 2, 0, 0],
    });
  }
  addMesh(group, new THREE.BoxGeometry(2.82, 0.16, 0.54), mat(p.thatch), {
    name: 'NoticeBoardRoof',
    position: [0, 2.54, 0],
    rotation: [0.08, 0, 0],
  });
  addWallPlaneCollider(group, { width: 2.48, height: 2.42, thickness: 0.18 });
  group.scale.setScalar(scale);
  return group;
}

export function createHayBale({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'HayBale';
  const hay = mat(p.thatchLight);
  const tie = mat(p.timberDark);
  addMesh(group, new THREE.CylinderGeometry(0.72, 0.72, 1.45, 10), hay, {
    name: 'RolledHay',
    position: [0, 0.72, 0],
    rotation: [0, 0, Math.PI / 2],
  });
  for (const x of [-0.43, 0.43]) {
    addMesh(group, new THREE.TorusGeometry(0.74, 0.045, 5, 10), tie, {
      name: 'HayBinding',
      position: [x, 0.72, 0],
      rotation: [0, Math.PI / 2, 0],
    });
  }
  group.scale.setScalar(scale);
  return group;
}

export function createGraveMarker({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'GraveMarker';
  const stone = mat(p.stoneDark);
  addMesh(group, new THREE.BoxGeometry(0.82, 1.28, 0.3), stone, {
    name: 'Gravestone',
    position: [0, 0.64, 0],
    rotation: [0.02, 0, -0.05],
  });
  addMesh(group, new THREE.CylinderGeometry(0.42, 0.42, 0.32, 10), stone, {
    name: 'GravestoneTop',
    position: [0, 1.22, 0],
    rotation: [Math.PI / 2, 0, 0],
  });
  addMesh(group, new THREE.BoxGeometry(1.18, 0.16, 0.68), mat(p.stone), {
    name: 'GraveFoot',
    position: [0, 0.1, 0.26],
  });
  addMesh(group, new THREE.BoxGeometry(0.12, 0.58, 0.06), mat(p.stoneLight), {
    name: 'GraveMark',
    position: [0, 0.8, 0.18],
  });
  addMesh(group, new THREE.BoxGeometry(0.42, 0.12, 0.06), mat(p.stoneLight), {
    name: 'GraveMark',
    position: [0, 0.92, 0.18],
  });
  group.scale.setScalar(scale);
  return group;
}

export function createRockFormation({ seed = 1, count = 5, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'RockFormation';
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const r = i === 0 ? 0 : 0.55 + rng() * 1.15;
    const size = i === 0 ? 1.55 : 0.45 + rng() * 0.85;
    addMesh(group, new THREE.DodecahedronGeometry(0.72, 0), mat(i % 3 === 0 ? p.stone : p.stoneDark), {
      name: 'Boulder',
      position: [Math.cos(a) * r, size * 0.43, Math.sin(a) * r],
      rotation: [rng() * 0.35, rng() * Math.PI * 2, rng() * 0.35],
      scale: [size, size * (0.65 + rng() * 0.3), size],
    });
  }
  group.scale.setScalar(scale);
  return group;
}

export function createRoundHut({ seed = 1, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'RoundHut';
  const plaster = mat(p.plaster);
  const wood = mat(p.timberDark);
  const thatch = mat(p.thatch);
  addMesh(group, new THREE.CylinderGeometry(1.88, 2.0, 0.38, 9), mat(p.stoneDark), {
    name: 'HutFoundation',
    position: [0, 0.19, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(1.65, 1.85, 2.35, 9), plaster, {
    name: 'HutWalls',
    position: [0, 1.175, 0],
  });
  addMesh(group, new THREE.ConeGeometry(2.35, 1.8, 9), thatch, {
    name: 'HutRoof',
    position: [0, 3.18, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(2.18, 2.18, 0.16, 9), mat(p.thatchLight), {
    name: 'RoofTrim',
    position: [0, 2.36, 0],
  });
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    addMesh(group, new THREE.CylinderGeometry(0.055, 0.075, 2.4, 5), wood, {
      name: 'WallPost',
      position: [Math.sin(a) * 1.72, 1.2, Math.cos(a) * 1.72],
    });
  }
  addMesh(group, new THREE.BoxGeometry(0.95, 1.58, 0.08), mat(p.timberDark), {
    name: 'Door',
    position: [0, 0.79, 1.855],
  });
  addDoorBraces(group, mat(p.timber), 0, 0.82, 1.92, 0.9, 1.42);
  addMesh(group, new THREE.TorusGeometry(1.74, 0.075, 5, 9), wood, {
    name: 'HutWallBand',
    position: [0, 1.78, 0],
    rotation: [Math.PI / 2, 0, 0],
  });
  addWindow(group, p, 1.76, 1.34, 0, Math.PI / 2, 0.42, 0.68);
  addBeam(group, wood, -0.57, 0.86, 1.92, 0.13, 1.72, 0.14);
  addBeam(group, wood, 0.57, 0.86, 1.92, 0.13, 1.72, 0.14);
  addBeam(group, wood, 0, 1.64, 1.91, 1.2, 0.16, 0.14);
  addMesh(group, new THREE.BoxGeometry(1.65, 0.14, 0.88), thatch, {
    name: 'DoorAwning',
    position: [0, 1.94, 2.15],
    rotation: [0.17, 0, 0],
  });
  addMesh(group, new THREE.ConeGeometry(0.18, 0.55, 6), wood, {
    name: 'RoofCap',
    position: [0, 4.34, 0],
  });
  if (rng() < 0.72) {
    addMesh(group, new THREE.CylinderGeometry(0.22, 0.28, 1.45, 6), mat(p.stoneDark), {
      name: 'Chimney',
      position: [0.82, 3.42, -0.25],
      rotation: [0, 0, -0.12],
    });
  }
  if (rng() < 0.52) {
    place(group, createBarrel({ scale: 0.72, palette: p }), -1.48, 1.52, 0, 0.2);
  }
  setStructureCollider(group, { type: 'cylinder', radius: 1.85, height: 2.35 });
  group.scale.setScalar(scale);
  return group;
}

export function createLonghouse({ seed = 1, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'Longhouse';
  const plaster = mat(p.plasterLight);
  const wood = mat(p.timberDark);
  const thatch = mat(p.thatch);
  addMesh(group, new THREE.BoxGeometry(5.05, 0.35, 3.25), mat(p.stoneDark), {
    name: 'LonghouseFoundation',
    position: [0, 0.18, 0],
  });
  addMesh(group, new THREE.BoxGeometry(4.7, 2.3, 2.9), plaster, {
    name: 'LonghouseWalls',
    position: [0, 1.15, 0],
  });
  addMesh(group, new THREE.BoxGeometry(5.05, 0.22, 2.35), thatch, {
    name: 'RoofSlope',
    position: [0, 2.87, 0.76],
    rotation: [0.62, 0, 0],
  });
  addMesh(group, new THREE.BoxGeometry(5.05, 0.22, 2.35), thatch, {
    name: 'RoofSlope',
    position: [0, 2.87, -0.76],
    rotation: [-0.62, 0, 0],
  });
  for (const x of [-2.15, -0.72, 0.72, 2.15]) {
    addBeam(group, wood, x, 1.25, 1.48, 0.14, 2.5, 0.16);
    addBeam(group, wood, x, 1.25, -1.48, 0.14, 2.5, 0.16);
  }
  addBeam(group, wood, 0, 2.4, 0, 5.25, 0.16, 0.16);
  addBeam(group, wood, 0, 3.7, 0, 5.32, 0.14, 0.14);
  addBeam(group, wood, -0.63, 0.92, 1.54, 0.14, 1.84, 0.14);
  addBeam(group, wood, 0.63, 0.92, 1.54, 0.14, 1.84, 0.14);
  addBeam(group, wood, 0, 1.82, 1.54, 1.38, 0.16, 0.14);
  addMesh(group, new THREE.BoxGeometry(1.05, 1.72, 0.08), mat(p.timber), {
    name: 'Door',
    position: [0, 0.86, 1.48],
  });
  addDoorBraces(group, wood, 0, 0.88, 1.57, 1.0, 1.62);
  addWindow(group, p, -1.48, 1.35, 1.54);
  addWindow(group, p, 1.48, 1.35, 1.54);
  addWindow(group, p, -1.48, 1.35, -1.54, Math.PI);
  addWindow(group, p, 1.48, 1.35, -1.54, Math.PI);
  addMesh(group, new THREE.BoxGeometry(1.55, 0.18, 0.8), mat(p.stone), {
    name: 'FrontStep',
    position: [0, 0.12, 1.86],
  });
  addMesh(group, new THREE.CylinderGeometry(0.2, 0.25, 1.2, 6), mat(p.stoneDark), {
    name: 'Chimney',
    position: [1.48, 3.34, -0.42],
    rotation: [0, 0, -0.12],
  });
  if (rng() < 0.75) {
    place(group, createCrate({ scale: 0.72, palette: p }), 1.7, 1.75, 0, 0.12);
  }
  setStructureCollider(group, { type: 'box', width: 4.7, depth: 2.9, height: 2.3 });
  group.scale.setScalar(scale);
  return group;
}

export function createTimberHouse({ seed = 1, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'TimberHouse';
  const plaster = mat(p.plasterLight);
  const wood = mat(p.timberDark);
  const roof = mat(p.thatch);
  const stone = mat(p.stoneDark);

  addMesh(group, new THREE.BoxGeometry(5.4, 0.55, 4.2), stone, {
    name: 'HouseFoundation',
    position: [0, 0.28, 0],
  });
  addMesh(group, new THREE.BoxGeometry(5.0, 3.7, 3.8), plaster, {
    name: 'HouseWalls',
    position: [0, 2.15, 0],
  });
  addMesh(group, new THREE.BoxGeometry(5.65, 0.24, 3.0), roof, {
    name: 'HouseRoof',
    position: [0, 4.72, 0.98],
    rotation: [0.64, 0, 0],
  });
  addMesh(group, new THREE.BoxGeometry(5.65, 0.24, 3.0), roof, {
    name: 'HouseRoof',
    position: [0, 4.72, -0.98],
    rotation: [-0.64, 0, 0],
  });
  addBeam(group, wood, 0, 5.62, 0, 5.92, 0.18, 0.18);
  addBeam(group, wood, 0, 2.08, 1.96, 5.35, 0.18, 0.16);
  addBeam(group, wood, 0, 2.08, -1.96, 5.35, 0.18, 0.16);
  for (const x of [-2.42, -1.22, 0, 1.22, 2.42]) {
    addBeam(group, wood, x, 2.17, 1.98, 0.15, 3.9, 0.15);
    addBeam(group, wood, x, 2.17, -1.98, 0.15, 3.9, 0.15);
  }
  addMesh(group, new THREE.BoxGeometry(1.18, 2.0, 0.1), mat(p.timber), {
    name: 'HouseDoor',
    position: [0, 1.02, 1.99],
  });
  addDoorBraces(group, wood, 0, 1.04, 2.06, 1.08, 1.86);
  for (const x of [-1.55, 1.55]) {
    addWindow(group, p, x, 1.43, 2.04);
    addWindow(group, p, x, 3.03, 2.04, 0, 0.7, 0.72);
    addWindow(group, p, x, 2.65, -2.04, Math.PI, 0.7, 0.72);
  }
  for (const z of [-0.78, 0.78]) {
    addBeam(group, wood, -2.54, 2.17, z, 0.15, 3.9, 0.15);
    addBeam(group, wood, 2.54, 2.17, z, 0.15, 3.9, 0.15);
  }
  addWindow(group, p, -2.56, 2.28, 0, -Math.PI / 2, 0.7, 0.82);
  addWindow(group, p, 2.56, 2.28, 0, Math.PI / 2, 0.7, 0.82);
  addMesh(group, new THREE.BoxGeometry(2.1, 0.2, 1.0), stone, {
    name: 'HouseStep',
    position: [0, 0.15, 2.45],
  });
  addMesh(group, new THREE.CylinderGeometry(0.28, 0.34, 2.25, 7), stone, {
    name: 'HouseChimney',
    position: [1.82, 5.15, -0.52],
    rotation: [0, 0, -0.08],
  });
  if (rng() < 0.8) {
    place(group, createBench({ scale: 0.7, palette: p }), -1.28, 2.62, 0, 0);
  }
  if (rng() < 0.58) {
    place(group, createBarrel({ scale: 0.68, palette: p }), 2.35, 2.18, 0, 0.2);
  }
  setStructureCollider(group, { type: 'box', width: 5.4, depth: 4.2, height: 4.0 });
  group.scale.setScalar(scale);
  return group;
}

export function createInn({ seed = 1, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'VillageInn';
  const plaster = mat(p.plasterLight);
  const wood = mat(p.timberDark);
  const stone = mat(p.stoneDark);
  const roof = mat(p.thatch);

  addMesh(group, new THREE.BoxGeometry(7.6, 0.58, 5.25), stone, {
    name: 'InnFoundation',
    position: [0, 0.29, 0],
  });
  addMesh(group, new THREE.BoxGeometry(6.8, 2.5, 4.65), plaster, {
    name: 'InnLowerFloor',
    position: [0, 1.53, 0],
  });
  addMesh(group, new THREE.BoxGeometry(7.35, 2.28, 5.05), plaster, {
    name: 'InnUpperFloor',
    position: [0, 3.92, 0],
  });
  addMesh(group, new THREE.BoxGeometry(8.05, 0.26, 3.78), roof, {
    name: 'InnRoof',
    position: [0, 5.88, 1.22],
    rotation: [0.63, 0, 0],
  });
  addMesh(group, new THREE.BoxGeometry(8.05, 0.26, 3.78), roof, {
    name: 'InnRoof',
    position: [0, 5.88, -1.22],
    rotation: [-0.63, 0, 0],
  });
  addBeam(group, wood, 0, 7.0, 0, 8.3, 0.2, 0.2);
  for (const z of [-2.4, 2.4]) {
    addBeam(group, wood, 0, 2.76, z, 7.54, 0.2, 0.18);
    for (const x of [-3.48, -2.2, -0.78, 0.78, 2.2, 3.48]) {
      addBeam(group, wood, x, 3.86, z, 0.16, 4.52, 0.16);
    }
  }
  for (const z of [-1.52, 0, 1.52]) {
    addBeam(group, wood, -3.5, 3.86, z, 0.16, 4.52, 0.16);
    addBeam(group, wood, 3.5, 3.86, z, 0.16, 4.52, 0.16);
  }
  addMesh(group, new THREE.BoxGeometry(1.38, 2.18, 0.1), mat(p.timber), {
    name: 'InnDoor',
    position: [0, 1.1, 2.36],
  });
  addDoorBraces(group, wood, 0, 1.12, 2.44, 1.28, 2.04);
  for (const x of [-2.42, -1.12, 1.12, 2.42]) {
    addWindow(group, p, x, 3.96, 2.51, 0, 0.68, 0.82);
  }
  for (const x of [-2.18, 2.18]) {
    addWindow(group, p, x, 1.56, 2.36, 0, 0.64, 0.78);
  }
  addWindow(group, p, -3.7, 3.94, 0.42, -Math.PI / 2, 0.68, 0.82);
  addWindow(group, p, 3.7, 3.94, 0.42, Math.PI / 2, 0.68, 0.82);
  addMesh(group, new THREE.BoxGeometry(2.4, 0.22, 1.22), stone, {
    name: 'InnStep',
    position: [0, 0.16, 2.96],
  });
  addMesh(group, new THREE.CylinderGeometry(0.36, 0.46, 2.54, 7), stone, {
    name: 'InnChimney',
    position: [-2.36, 6.56, -0.82],
  });
  addMesh(group, new THREE.CylinderGeometry(0.54, 0.58, 0.24, 7), mat(p.stone), {
    name: 'ChimneyCap',
    position: [-2.36, 7.84, -0.82],
  });
  addBeam(group, wood, 3.52, 4.42, 2.56, 2.18, 0.14, 0.14, 0, Math.PI / 2);
  addMesh(group, new THREE.CylinderGeometry(0.04, 0.04, 0.58, 5), mat(p.iron), {
    name: 'InnSignChain',
    position: [3.52, 4.04, 3.4],
  });
  addMesh(group, new THREE.BoxGeometry(1.15, 0.74, 0.12), mat(p.clothRed), {
    name: 'InnSign',
    position: [3.52, 3.54, 3.4],
  });
  addMesh(group, new THREE.TorusGeometry(0.24, 0.07, 5, 10), mat(p.clothGold), {
    name: 'InnSignMark',
    position: [3.52, 3.54, 3.48],
  });
  place(group, createBench({ scale: 0.82, palette: p }), -2.08, 2.94, 0, 0);
  place(group, createLanternPost({ scale: 0.66, palette: p }), 2.15, 2.92, 0, 0.04);
  if (rng() < 0.78) {
    place(group, createBarrel({ scale: 0.78, palette: p }), -3.34, 2.62, 0, 0.12);
  }
  setStructureCollider(group, { type: 'box', width: 7.6, depth: 5.25, height: 5.1 });
  group.scale.setScalar(scale);
  return group;
}

export function createChapel({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'VillageChapel';
  const plaster = mat(p.plasterLight);
  const wood = mat(p.timberDark);
  const stone = mat(p.stoneDark);
  const lightStone = mat(p.stoneLight);
  const roof = mat(p.clothBlue);

  addMesh(group, new THREE.BoxGeometry(6.15, 0.58, 8.5), stone, {
    name: 'ChapelFoundation',
    position: [0, 0.29, -0.25],
  });
  addMesh(group, new THREE.BoxGeometry(5.5, 4.25, 7.72), plaster, {
    name: 'ChapelNave',
    position: [0, 2.42, -0.34],
  });
  addMesh(group, new THREE.BoxGeometry(3.12, 5.7, 2.92), stone, {
    name: 'ChapelTower',
    position: [0, 3.14, 3.38],
  });
  addMesh(group, new THREE.BoxGeometry(3.36, 0.24, 8.38), roof, {
    name: 'ChapelRoof',
    position: [1.32, 5.28, -0.35],
    rotation: [0, 0, -0.63],
  });
  addMesh(group, new THREE.BoxGeometry(3.36, 0.24, 8.38), roof, {
    name: 'ChapelRoof',
    position: [-1.32, 5.28, -0.35],
    rotation: [0, 0, 0.63],
  });
  addMesh(group, new THREE.ConeGeometry(2.12, 3.65, 6), roof, {
    name: 'ChapelSpire',
    position: [0, 7.78, 3.38],
  });
  addMesh(group, new THREE.ConeGeometry(0.18, 0.76, 4), mat(p.clothGold), {
    name: 'SpireFinial',
    position: [0, 9.98, 3.38],
  });
  addMesh(group, new THREE.BoxGeometry(0.12, 0.84, 0.12), mat(p.clothGold), {
    name: 'ChapelCross',
    position: [0, 10.55, 3.38],
  });
  addMesh(group, new THREE.BoxGeometry(0.62, 0.12, 0.12), mat(p.clothGold), {
    name: 'ChapelCross',
    position: [0, 10.65, 3.38],
  });
  addMesh(group, new THREE.BoxGeometry(3.42, 0.32, 3.2), lightStone, {
    name: 'TowerBand',
    position: [0, 5.72, 3.38],
  });
  addMesh(group, new THREE.BoxGeometry(1.42, 2.42, 0.12), mat(p.timber), {
    name: 'ChapelDoor',
    position: [0, 1.3, 4.86],
  });
  addDoorBraces(group, wood, 0, 1.3, 4.94, 1.32, 2.26);
  addMesh(group, new THREE.BoxGeometry(2.14, 0.28, 1.2), lightStone, {
    name: 'ChapelStep',
    position: [0, 0.17, 5.42],
  });
  for (const z of [-2.35, -0.2, 1.46]) {
    addWindow(group, p, -2.82, 3.08, z, -Math.PI / 2, 0.48, 1.22);
    addWindow(group, p, 2.82, 3.08, z, Math.PI / 2, 0.48, 1.22);
    addMesh(group, new THREE.BoxGeometry(0.48, 4.3, 0.66), stone, {
      name: 'ChapelButtress',
      position: [-2.94, 2.16, z - 0.68],
    });
    addMesh(group, new THREE.BoxGeometry(0.48, 4.3, 0.66), stone, {
      name: 'ChapelButtress',
      position: [2.94, 2.16, z - 0.68],
    });
  }
  addWindow(group, p, 0, 5.02, 4.88, 0, 0.56, 1.12);
  place(group, createBanner({ color: p.clothBlue, scale: 0.72, palette: p }), -1.62, 4.76, 3.92);
  place(group, createBanner({ color: p.clothRed, scale: 0.72, palette: p }), 1.62, 4.76, 3.92);
  setStructureCollider(group, { type: 'box', width: 6.15, depth: 8.5, height: 5.0 });
  group.scale.setScalar(scale);
  return group;
}

export function createAnvil({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Anvil';
  const iron = mat(p.iron);
  const wood = mat(p.timberDark);
  addMesh(group, new THREE.CylinderGeometry(0.32, 0.45, 0.72, 7), wood, {
    name: 'AnvilStump',
    position: [0, 0.36, 0],
  });
  addMesh(group, new THREE.BoxGeometry(0.96, 0.22, 0.42), iron, {
    name: 'AnvilBody',
    position: [-0.08, 0.86, 0],
  });
  addMesh(group, new THREE.BoxGeometry(1.16, 0.14, 0.56), iron, {
    name: 'AnvilFace',
    position: [-0.02, 1.04, 0],
  });
  addMesh(group, new THREE.ConeGeometry(0.28, 0.82, 5), iron, {
    name: 'AnvilHorn',
    position: [0.72, 0.89, 0],
    rotation: [0, 0, -Math.PI / 2],
  });
  group.scale.setScalar(scale);
  return group;
}

export function createHandcart({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Handcart';
  const wood = mat(p.timber);
  const dark = mat(p.timberDark);
  const iron = mat(p.iron);
  addMesh(group, new THREE.BoxGeometry(1.72, 0.24, 2.0), wood, {
    name: 'CartBed',
    position: [0, 0.92, 0],
  });
  for (const x of [-0.82, 0.82]) {
    addMesh(group, new THREE.BoxGeometry(0.14, 0.78, 2.04), dark, {
      name: 'CartSide',
      position: [x, 1.27, 0],
    });
    for (const z of [-0.72, 0, 0.72]) {
      addMesh(group, new THREE.CylinderGeometry(0.055, 0.07, 0.72, 6), dark, {
        name: 'CartSlat',
        position: [x, 1.25, z],
      });
    }
  }
  for (const x of [-1.0, 1.0]) {
    addMesh(group, new THREE.TorusGeometry(0.68, 0.12, 5, 10), iron, {
      name: 'CartWheel',
      position: [x, 0.68, 0],
      rotation: [0, Math.PI / 2, 0],
    });
    for (let i = 0; i < 6; i++) {
      addMesh(group, new THREE.BoxGeometry(0.08, 1.12, 0.08), dark, {
        name: 'CartSpoke',
        position: [x, 0.68, 0],
        rotation: [i * Math.PI / 6, 0, 0],
      });
    }
  }
  for (const x of [-0.58, 0.58]) {
    addMesh(group, new THREE.BoxGeometry(0.13, 0.13, 2.3), dark, {
      name: 'CartHandle',
      position: [x, 0.86, 2.04],
      rotation: [-0.08, 0, 0],
    });
  }
  place(group, createCrate({ scale: 0.72, palette: p }), -0.35, -0.12, 1.05, 0.08);
  group.scale.setScalar(scale);
  return group;
}

export function createBlacksmith({ seed = 1, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = 'BlacksmithWorkshop';
  const plaster = mat(p.plaster);
  const wood = mat(p.timberDark);
  const stone = mat(p.stoneDark);
  const roof = mat(p.thatch);

  addMesh(group, new THREE.BoxGeometry(5.8, 0.46, 4.2), stone, {
    name: 'SmithyFoundation',
    position: [0, 0.23, 0],
  });
  addMesh(group, new THREE.BoxGeometry(4.9, 2.85, 3.7), plaster, {
    name: 'SmithyWalls',
    position: [-0.35, 1.68, 0],
  });
  addMesh(group, new THREE.BoxGeometry(5.6, 0.22, 2.85), roof, {
    name: 'SmithyRoof',
    position: [-0.35, 3.66, 0.92],
    rotation: [0.62, 0, 0],
  });
  addMesh(group, new THREE.BoxGeometry(5.6, 0.22, 2.85), roof, {
    name: 'SmithyRoof',
    position: [-0.35, 3.66, -0.92],
    rotation: [-0.62, 0, 0],
  });
  addBeam(group, wood, -0.35, 4.5, 0, 5.85, 0.17, 0.17);
  for (const x of [-2.68, -1.18, 0.3, 1.82]) {
    addBeam(group, wood, x, 1.66, 1.92, 0.15, 3.1, 0.15);
    addBeam(group, wood, x, 1.66, -1.92, 0.15, 3.1, 0.15);
  }
  addBeam(group, wood, -0.35, 1.72, 1.94, 5.2, 0.17, 0.15);
  addMesh(group, new THREE.BoxGeometry(1.12, 1.92, 0.1), mat(p.timber), {
    name: 'SmithyDoor',
    position: [-0.5, 1.0, 1.96],
  });
  addDoorBraces(group, wood, -0.5, 1.0, 2.03, 1.0, 1.78);
  addWindow(group, p, 1.1, 1.64, 2.02, 0, 0.7, 0.74);

  addMesh(group, new THREE.CylinderGeometry(0.48, 0.62, 3.25, 7), stone, {
    name: 'ForgeChimney',
    position: [-1.86, 3.62, -0.5],
  });
  addMesh(group, new THREE.CylinderGeometry(0.7, 0.74, 0.24, 7), mat(p.stone), {
    name: 'ChimneyCap',
    position: [-1.86, 5.27, -0.5],
  });

  addMesh(group, new THREE.BoxGeometry(2.7, 0.16, 3.35), roof, {
    name: 'ForgeLeanTo',
    position: [3.28, 2.56, 0],
    rotation: [0, 0, -0.13],
  });
  for (const z of [-1.38, 1.38]) {
    addMesh(group, new THREE.CylinderGeometry(0.08, 0.12, 2.55, 6), wood, {
      name: 'LeanToPost',
      position: [4.46, 1.28, z],
    });
  }
  addMesh(group, new THREE.BoxGeometry(1.65, 0.72, 1.2), stone, {
    name: 'ForgeHearth',
    position: [3.25, 0.58, -0.28],
  });
  addMesh(group, new THREE.BoxGeometry(1.06, 0.1, 0.62), glowMat(p.ember), {
    name: 'ForgeEmbers',
    position: [3.25, 0.98, -0.28],
  });
  place(group, createAnvil({ scale: 0.78, palette: p }), 3.4, 1.05, 0, -0.18);
  if (rng() < 0.75) {
    place(group, createBarrel({ scale: 0.68, palette: p }), 4.34, -1.0, 0, 0.12);
  }
  setStructureCollider(group, { type: 'box', width: 5.8, depth: 4.2, height: 3.1 });
  group.scale.setScalar(scale);
  return group;
}

export function createStable({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'VillageStable';
  const plaster = mat(p.plaster);
  const wood = mat(p.timberDark);
  const roof = mat(p.thatch);

  addMesh(group, new THREE.BoxGeometry(7.5, 0.42, 4.7), mat(p.stoneDark), {
    name: 'StableFoundation',
    position: [0, 0.21, 0],
  });
  addMesh(group, new THREE.BoxGeometry(7.08, 2.72, 0.32), plaster, {
    name: 'StableBackWall',
    position: [0, 1.62, -2.12],
  });
  addMesh(group, new THREE.BoxGeometry(7.86, 0.22, 3.35), roof, {
    name: 'StableRoof',
    position: [0, 3.5, 1.04],
    rotation: [0.62, 0, 0],
  });
  addMesh(group, new THREE.BoxGeometry(7.86, 0.22, 3.35), roof, {
    name: 'StableRoof',
    position: [0, 3.5, -1.04],
    rotation: [-0.62, 0, 0],
  });
  addBeam(group, wood, 0, 4.48, 0, 8.04, 0.18, 0.18);
  for (const x of [-3.45, -1.15, 1.15, 3.45]) {
    addMesh(group, new THREE.CylinderGeometry(0.11, 0.16, 3.12, 6), wood, {
      name: 'StablePost',
      position: [x, 1.56, 2.04],
    });
    addBeam(group, wood, x, 1.28, 0.12, 0.14, 2.42, 4.2);
  }
  for (const x of [-2.3, 0, 2.3]) {
    addMesh(group, new THREE.BoxGeometry(1.82, 0.58, 0.62), mat(p.timber), {
      name: 'StableTrough',
      position: [x, 0.52, 1.54],
    });
    addMesh(group, new THREE.BoxGeometry(1.56, 0.1, 0.48), mat(p.thatchLight), {
      name: 'TroughHay',
      position: [x, 0.84, 1.54],
    });
  }
  place(group, createHayBale({ scale: 0.82, palette: p }), -2.62, -1.34, 0, 0.08);
  place(group, createHayBale({ scale: 0.68, palette: p }), -1.56, -1.32, 0, -0.12);
  place(group, createLanternPost({ scale: 0.6, palette: p }), 3.16, 1.82, 0, 0.04);
  addWallPlaneCollider(group, { z: -2.12, width: 7.08, height: 2.72, thickness: 0.32 });
  for (const x of [-3.45, -1.15, 1.15, 3.45]) {
    addWallPlaneCollider(group, { x, z: 0.12, width: 4.2, height: 2.42, thickness: 0.14, rotation: Math.PI / 2 });
  }
  group.scale.setScalar(scale);
  return group;
}

export function createMarketStall({ color, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'MarketStall';
  const wood = mat(p.timberDark);
  const cloth = mat(color ?? p.clothBlue);
  addMesh(group, new THREE.BoxGeometry(3.0, 0.25, 1.45), mat(p.timber), {
    position: [0, 1.0, 0],
  });
  for (const x of [-1.35, 1.35]) {
    for (const z of [-0.58, 0.58]) {
      addMesh(group, new THREE.CylinderGeometry(0.07, 0.1, 2.65, 6), wood, {
        position: [x, 1.33, z],
      });
    }
  }
  addMesh(group, new THREE.BoxGeometry(3.35, 0.16, 1.95), cloth, {
    name: 'Awning',
    position: [0, 2.7, 0],
    rotation: [0, 0, 0.07],
  });
  for (const x of [-1.24, -0.42, 0.42, 1.24]) {
    addMesh(group, new THREE.BoxGeometry(0.38, 0.035, 2.0), mat(p.clothGold), {
      name: 'AwningStripe',
      position: [x, 2.79 + x * 0.01, 0],
      rotation: [0, 0, 0.07],
    });
  }
  addBeam(group, wood, 0, 1.48, 0.74, 3.18, 0.13, 0.13);
  for (const x of [-0.55, 0, 0.55]) {
    addMesh(group, new THREE.SphereGeometry(0.2, 7, 5), mat(x === 0 ? p.clothGold : p.clothRed), {
      name: 'MarketProduce',
      position: [x, 1.23, 0.34],
      scale: [1, 0.8, 1],
    });
  }
  place(group, createCrate({ scale: 0.66, palette: p }), -1.05, 0.95, 0);
  place(group, createBarrel({ scale: 0.65, palette: p }), 1.1, 0.98, 0);
  setStructureCollider(group, { type: 'box', width: 3.0, depth: 1.45, height: 1.0 });
  group.scale.setScalar(scale);
  return group;
}

export function createLanternPost({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'LanternPost';
  const wood = mat(p.timberDark);
  const iron = mat(p.iron);
  addMesh(group, new THREE.CylinderGeometry(0.1, 0.16, 3.45, 6), wood, {
    name: 'LanternPost',
    position: [0, 1.72, 0],
  });
  addMesh(group, new THREE.ConeGeometry(0.18, 0.42, 5), wood, {
    name: 'PostCap',
    position: [0, 3.65, 0],
  });
  addBeam(group, wood, 0.52, 3.05, 0, 1.18, 0.12, 0.12, -0.16);
  addMesh(group, new THREE.CylinderGeometry(0.025, 0.025, 0.48, 5), iron, {
    name: 'LanternChain',
    position: [1.05, 2.72, 0],
  });
  addMesh(group, new THREE.BoxGeometry(0.42, 0.54, 0.42), glowMat(0xffb53d), {
    name: 'LanternGlow',
    position: [1.05, 2.32, 0],
  });
  for (const x of [-0.24, 0.24]) {
    for (const z of [-0.24, 0.24]) {
      addMesh(group, new THREE.BoxGeometry(0.055, 0.72, 0.055), iron, {
        name: 'LanternFrame',
        position: [1.05 + x, 2.32, z],
      });
    }
  }
  addMesh(group, new THREE.ConeGeometry(0.42, 0.24, 4), iron, {
    name: 'LanternRoof',
    position: [1.05, 2.74, 0],
    rotation: [0, Math.PI / 4, 0],
  });
  group.scale.setScalar(scale);
  return group;
}

export function createWeaponRack({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'WeaponRack';
  const wood = mat(p.timberDark);
  const iron = mat(p.iron);
  for (const x of [-1.12, 1.12]) {
    addMesh(group, new THREE.CylinderGeometry(0.1, 0.14, 2.25, 6), wood, {
      name: 'RackPost',
      position: [x, 1.12, 0],
    });
  }
  addBeam(group, wood, 0, 1.74, 0, 2.45, 0.16, 0.16);
  addBeam(group, wood, 0, 0.72, 0, 2.45, 0.16, 0.16);
  for (const [x, tilt] of [[-0.72, -0.08], [0, 0.06], [0.72, -0.04]]) {
    addMesh(group, new THREE.CylinderGeometry(0.035, 0.05, 2.72, 5), wood, {
      name: 'SpearShaft',
      position: [x, 1.46, 0.06],
      rotation: [0, 0, tilt],
    });
    addMesh(group, new THREE.ConeGeometry(0.14, 0.46, 4), iron, {
      name: 'SpearHead',
      position: [x - Math.sin(tilt) * 1.56, 3.02, 0.06],
      rotation: [0, 0, tilt],
    });
  }
  addMesh(group, new THREE.CylinderGeometry(0.52, 0.52, 0.16, 10), mat(p.clothRed), {
    name: 'RackShield',
    position: [0, 1.26, 0.2],
    rotation: [Math.PI / 2, 0, 0],
  });
  addMesh(group, new THREE.ConeGeometry(0.18, 0.28, 8), iron, {
    name: 'ShieldBoss',
    position: [0, 1.26, 0.34],
    rotation: [Math.PI / 2, 0, 0],
  });
  group.scale.setScalar(scale);
  return group;
}

export function createWatchtower({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'Watchtower';
  const stone = mat(p.stone);
  const wood = mat(p.timberDark);
  addMesh(group, new THREE.CylinderGeometry(1.55, 1.8, 4.7, 9), stone, {
    name: 'TowerBase',
    position: [0, 2.35, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(2.0, 2.0, 0.38, 9), mat(p.stoneLight), {
    name: 'TowerTop',
    position: [0, 4.82, 0],
  });
  addMesh(group, new THREE.CylinderGeometry(1.72, 1.82, 0.34, 9), mat(p.stoneDark), {
    name: 'TowerFoundation',
    position: [0, 0.17, 0],
  });
  addMesh(group, new THREE.TorusGeometry(1.62, 0.13, 5, 9), mat(p.stoneLight), {
    name: 'TowerBand',
    position: [0, 2.6, 0],
    rotation: [Math.PI / 2, 0, 0],
  });
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    addMesh(group, new THREE.BoxGeometry(0.38, 0.68, 0.38), stone, {
      name: 'TowerCrenel',
      position: [Math.sin(a) * 1.72, 5.32, Math.cos(a) * 1.72],
      rotation: [0, a, 0],
    });
  }
  addMesh(group, new THREE.BoxGeometry(0.88, 1.75, 0.08), mat(p.timberDark), {
    name: 'TowerDoor',
    position: [0, 0.88, 1.79],
  });
  addWindow(group, p, 0, 3.5, 1.62, 0, 0.38, 0.88);
  addWindow(group, p, 1.58, 2.05, 0, Math.PI / 2, 0.36, 0.82);
  place(group, createBanner({ color: p.clothRed, scale: 0.74, palette: p }), 0, 0, 5.0);
  addBeam(group, wood, 0, 4.7, 0, 3.3, 0.12, 0.12);
  setStructureCollider(group, { type: 'cylinder', radius: 1.8, height: 4.7 });
  group.scale.setScalar(scale);
  return group;
}

export function createVillageGate({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'VillageGate';
  const wood = mat(p.timberDark);
  for (const x of [-2.15, 2.15]) {
    addMesh(group, new THREE.CylinderGeometry(0.28, 0.42, 4.8, 7), wood, {
      position: [x, 2.4, 0],
    });
    addMesh(group, new THREE.ConeGeometry(0.48, 0.9, 6), wood, {
      position: [x, 5.18, 0],
    });
  }
  addBeam(group, wood, 0, 4.02, 0, 5.0, 0.38, 0.42);
  addBeam(group, wood, 0, 3.42, 0, 4.7, 0.18, 0.18, 0.0);
  addBeam(group, wood, -1.06, 3.98, 0, 2.25, 0.17, 0.17, 0.68);
  addBeam(group, wood, 1.06, 3.98, 0, 2.25, 0.17, 0.17, -0.68);
  for (const x of [-1.35, -0.68, 0, 0.68, 1.35]) {
    addMesh(group, new THREE.ConeGeometry(0.12, 0.48, 5), wood, {
      name: 'GateSpike',
      position: [x, 4.58, 0],
    });
  }
  place(group, createBanner({ color: p.clothRed, scale: 0.62, palette: p }), -2.15, 0.05, 2.9);
  place(group, createBanner({ color: p.clothBlue, scale: 0.62, palette: p }), 2.15, 0.05, 2.9);
  for (const x of [-2.15, 2.15]) {
    addStructureCollider(group, { type: 'cylinder', x, radius: 0.42, height: 4.8 });
  }
  group.scale.setScalar(scale);
  return group;
}

export function createFortifiedWall({ length = 9, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'FortifiedWall';
  const stone = mat(p.stone);
  const light = mat(p.stoneLight);
  const wood = mat(p.timberDark);

  addMesh(group, new THREE.BoxGeometry(length + 0.7, 0.58, 1.72), mat(p.stoneDark), {
    name: 'WallFoundation',
    position: [0, 0.29, 0],
  });
  addMesh(group, new THREE.BoxGeometry(length, 3.35, 1.38), stone, {
    name: 'WallBody',
    position: [0, 1.96, 0],
  });
  addMesh(group, new THREE.BoxGeometry(length + 0.3, 0.28, 1.7), light, {
    name: 'WallWalk',
    position: [0, 3.78, 0],
  });
  for (const z of [-0.72, 0.72]) {
    for (let x = -length * 0.45; x <= length * 0.46; x += 1.18) {
      addMesh(group, new THREE.BoxGeometry(0.52, 0.72, 0.52), light, {
        name: 'WallCrenel',
        position: [x, 4.26, z],
      });
    }
  }
  for (const x of [-length * 0.48, length * 0.48]) {
    addMesh(group, new THREE.CylinderGeometry(0.66, 0.78, 4.62, 8), stone, {
      name: 'WallEndPost',
      position: [x, 2.31, 0],
    });
    addMesh(group, new THREE.ConeGeometry(0.88, 1.48, 8), mat(p.clothBlue), {
      name: 'WallEndRoof',
      position: [x, 5.3, 0],
    });
  }
  addBeam(group, wood, 0, 2.06, 0.76, length * 0.72, 0.16, 0.12);
  addBeam(group, wood, 0, 1.28, 0.76, length * 0.72, 0.16, 0.12);
  place(group, createBanner({ color: p.clothRed, scale: 0.64, palette: p }), -length * 0.28, 0.82, 2.04);
  place(group, createBanner({ color: p.clothBlue, scale: 0.64, palette: p }), length * 0.28, 0.82, 2.04);
  addWallPlaneCollider(group, { width: length + 0.7, height: 3.35, thickness: 1.72 });
  group.scale.setScalar(scale);
  return group;
}

export function createCastleKeep({ scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'CastleKeep';
  const stone = mat(p.stone);
  const light = mat(p.stoneLight);
  addMesh(group, new THREE.BoxGeometry(6.9, 5.4, 6.0), stone, {
    name: 'KeepBody',
    position: [0, 2.7, 0],
  });
  addStoneBand(group, light, 7.2, 6.3, 0.34, 0.68);
  addStoneBand(group, light, 7.06, 6.16, 3.72, 0.24);
  addMesh(group, new THREE.BoxGeometry(4.05, 2.45, 3.8), stone, {
    name: 'UpperKeep',
    position: [0, 6.42, -0.62],
  });
  addBattlements(group, light, 6.9, 6.0, 5.66, 6);
  addBattlements(group, light, 4.05, 3.8, 7.82, 4);
  for (const [x, z] of [[-3.25, -2.82], [3.25, -2.82], [-3.25, 2.82], [3.25, 2.82]]) {
    addMesh(group, new THREE.CylinderGeometry(1.2, 1.35, 6.5, 8), stone, {
      name: 'CornerTower',
      position: [x, 3.25, z],
    });
    addMesh(group, new THREE.ConeGeometry(1.52, 2.35, 8), mat(p.clothBlue), {
      name: 'TowerRoof',
      position: [x, 7.65, z],
    });
    addMesh(group, new THREE.TorusGeometry(1.22, 0.14, 5, 8), light, {
      name: 'TowerBand',
      position: [x, 4.65, z],
      rotation: [Math.PI / 2, 0, 0],
    });
  }
  addMesh(group, new THREE.BoxGeometry(1.8, 2.75, 0.08), mat(p.timberDark), {
    name: 'KeepDoor',
    position: [0, 1.38, 3.02],
  });
  addMesh(group, new THREE.BoxGeometry(2.5, 0.5, 0.5), light, {
    name: 'DoorLintel',
    position: [0, 2.92, 3.12],
  });
  addDoorBraces(group, mat(p.iron), 0, 1.38, 3.09, 1.72, 2.52);
  addMesh(group, new THREE.BoxGeometry(2.45, 0.22, 1.15), light, {
    name: 'KeepStep',
    position: [0, 0.13, 3.64],
  });
  for (const x of [-2.05, 2.05]) {
    addWindow(group, p, x, 4.38, 3.08, 0, 0.38, 0.92);
  }
  addWindow(group, p, 0, 6.58, 1.31, 0, 0.44, 0.98);
  place(group, createBanner({ color: p.clothRed, scale: 0.85, palette: p }), 0, 3.1, 5.15);
  place(group, createBanner({ color: p.clothBlue, scale: 0.7, palette: p }), -1.25, 1.34, 7.05);
  place(group, createBanner({ color: p.clothRed, scale: 0.7, palette: p }), 1.25, 1.34, 7.05);
  setStructureCollider(group, { type: 'box', width: 6.9, depth: 6.0, height: 5.4 });
  group.scale.setScalar(scale);
  return group;
}

export function createVillageCluster({ seed = 1, fortified = false, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const rng = makeRng(seed);
  const group = new THREE.Group();
  group.name = fortified ? 'FortifiedVillage' : 'Village';

  place(group, createWell({ scale: 0.78, palette: p }), 0, 0);
  place(group, createRoundHut({ seed: seed + 11, scale: 0.82, palette: p }), -4.8, -2.8, 0, 0.72);
  place(group, createRoundHut({ seed: seed + 17, scale: 0.72, palette: p }), 4.4, -3.5, 0, -0.58);
  place(group, createLonghouse({ seed: seed + 23, scale: 0.72, palette: p }), -1.2, 5.0, 0, Math.PI);
  place(group, createTimberHouse({ seed: seed + 29, scale: 0.58, palette: p }), -7.0, 3.8, 0, 0.28);
  place(group, createBlacksmith({ seed: seed + 31, scale: 0.55, palette: p }), 7.2, 4.9, 0, -0.72);
  place(group, createMarketStall({ color: rng() < 0.5 ? p.clothRed : p.clothBlue, scale: 0.72, palette: p }), 4.3, 2.1, 0, -0.4);
  place(group, createBench({ scale: 0.72, palette: p }), 1.25, 1.55, 0, -0.52);
  place(group, createCampfire({ scale: 0.72, palette: p }), -1.2, -2.0);
  place(group, createRockFormation({ seed: seed + 37, count: 4, scale: 0.7, palette: p }), -7.0, -0.3);
  place(group, createFenceSegment({ length: 5, scale: 0.85, palette: p }), -5.0, 1.0, 0, Math.PI / 2);
  place(group, createFenceSegment({ length: 5, scale: 0.85, palette: p }), 1.4, -5.5, 0, 0.1);
  place(group, createSignpost({ scale: 0.76, palette: p }), 1.7, -3.1, 0, 0.45);
  place(group, createCrate({ scale: 0.72, palette: p }), 2.45, 2.3, 0, -0.12);
  place(group, createCrate({ scale: 0.56, palette: p }), 3.0, 2.65, 0, 0.18);
  place(group, createBarrel({ scale: 0.7, palette: p }), -3.2, 4.5, 0, 0.1);
  place(group, createHandcart({ scale: 0.58, palette: p }), 3.2, -4.5, 0, -0.35);
  place(group, createLanternPost({ scale: 0.74, palette: p }), 1.7, 1.35, 0, 0.18);
  place(group, createWeaponRack({ scale: 0.66, palette: p }), 7.75, 2.25, 0, -0.72);
  place(group, createSackPile({ scale: 0.68, palette: p }), 4.88, 2.5, 0, -0.1);
  place(group, createWoodpile({ scale: 0.72, palette: p }), 7.85, 6.22, 0, -0.72);
  place(group, createBanner({ color: p.clothRed, scale: 0.66, palette: p }), -4.9, -0.35);
  if (fortified) {
    place(group, createVillageGate({ scale: 0.72, palette: p }), 0.2, -7.0, 0, 0);
    place(group, createWatchtower({ scale: 0.66, palette: p }), 10.0, 7.2, 0, -0.35);
    place(group, createFenceSegment({ length: 4.5, scale: 0.8, palette: p }), 5.4, -4.4, 0, -0.75);
  }
  group.scale.setScalar(scale);
  return group;
}

export function createFortifiedTown({ seed = 1, scale = 1, palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'FortifiedTown';

  place(group, createCastleKeep({ scale: 0.84, palette: p }), 0, 12.2, 0, Math.PI);
  place(group, createChapel({ scale: 0.82, palette: p }), -1.2, -1.4, 0, 0.04);
  place(group, createInn({ seed: seed + 11, scale: 0.78, palette: p }), -10.0, 3.1, 0, 0.42);
  place(group, createBlacksmith({ seed: seed + 19, scale: 0.72, palette: p }), 9.4, 2.5, 0, -0.62);
  place(group, createTimberHouse({ seed: seed + 23, scale: 0.68, palette: p }), -10.2, -6.8, 0, 0.24);
  place(group, createStable({ scale: 0.68, palette: p }), 9.6, -7.8, 0, -0.2);
  place(group, createRoundHut({ seed: seed + 31, scale: 0.72, palette: p }), 5.4, 8.6, 0, -0.3);
  place(group, createFountain({ scale: 0.76, palette: p }), -5.1, 6.0);
  place(group, createMarketStall({ color: p.clothBlue, scale: 0.74, palette: p }), -5.0, -5.8, 0, 0.1);
  place(group, createMarketStall({ color: p.clothRed, scale: 0.72, palette: p }), 4.4, -5.4, 0, -0.2);
  place(group, createVillageGate({ scale: 0.9, palette: p }), 0, -16.5);
  place(group, createFortifiedWall({ length: 11.5, scale: 0.82, palette: p }), -9.8, -14.1, 0, 0.2);
  place(group, createFortifiedWall({ length: 11.5, scale: 0.82, palette: p }), 9.8, -14.1, 0, -0.2);
  place(group, createFortifiedWall({ length: 18, scale: 0.82, palette: p }), -15.4, -0.4, 0, Math.PI / 2);
  place(group, createFortifiedWall({ length: 18, scale: 0.82, palette: p }), 15.4, -0.4, 0, Math.PI / 2);
  place(group, createWatchtower({ scale: 0.72, palette: p }), -15.0, 10.0, 0, 0.12);
  place(group, createWatchtower({ scale: 0.72, palette: p }), 15.0, 10.0, 0, -0.12);
  place(group, createLanternPost({ scale: 0.76, palette: p }), -3.2, -7.2, 0, 0.12);
  place(group, createLanternPost({ scale: 0.76, palette: p }), 3.1, -7.2, 0, -0.12);
  place(group, createHandcart({ scale: 0.62, palette: p }), 7.0, -1.8, 0, -0.45);
  place(group, createBench({ scale: 0.72, palette: p }), -5.0, 3.4, 0, 0.62);
  place(group, createBench({ scale: 0.72, palette: p }), 4.2, 4.0, 0, -0.58);
  place(group, createSackPile({ scale: 0.68, palette: p }), -6.6, -5.1, 0, 0.04);
  place(group, createWoodpile({ scale: 0.68, palette: p }), 10.8, 4.8, 0, -0.62);
  place(group, createNoticeBoard({ scale: 0.74, palette: p }), -4.4, -11.8, 0, 0.1);
  place(group, createHayBale({ scale: 0.72, palette: p }), 12.4, -5.6, 0, -0.18);
  place(group, createGraveMarker({ scale: 0.72, palette: p }), -4.72, -1.85, 0, -0.12);
  place(group, createGraveMarker({ scale: 0.66, palette: p }), -4.86, 0.08, 0, 0.08);
  place(group, createGraveMarker({ scale: 0.7, palette: p }), -4.68, 1.92, 0, -0.06);
  group.scale.setScalar(scale);
  return group;
}

export function createStructureGallery({ palette: colors = {} } = {}) {
  const p = palette(colors);
  const group = new THREE.Group();
  group.name = 'StructureGallery';
  place(group, createRoundHut({ seed: 11, scale: 0.9, palette: p }), -13.0, -4.0);
  place(group, createLonghouse({ seed: 21, scale: 0.85, palette: p }), -7.2, -4.0, 0, -0.12);
  place(group, createTimberHouse({ seed: 32, scale: 0.78, palette: p }), -0.6, -4.0);
  place(group, createBlacksmith({ seed: 43, scale: 0.72, palette: p }), 5.3, -4.0);
  place(group, createMarketStall({ scale: 0.9, palette: p }), 11.0, -4.0);
  place(group, createWell({ scale: 0.82, palette: p }), 15.4, -4.0);
  place(group, createWatchtower({ scale: 0.82, palette: p }), 19.0, -4.0);
  place(group, createVillageGate({ scale: 0.88, palette: p }), -11.5, 5.7);
  place(group, createCastleKeep({ scale: 0.63, palette: p }), -3.6, 6.4);
  place(group, createRockFormation({ seed: 44, count: 6, scale: 0.92, palette: p }), 5.0, 5.4);
  place(group, createCampfire({ scale: 0.8, palette: p }), 8.5, 5.2);
  place(group, createBench({ scale: 0.82, palette: p }), 10.7, 5.0, 0, -0.12);
  place(group, createHandcart({ scale: 0.68, palette: p }), 12.6, 4.3, 0, 0.18);
  place(group, createLanternPost({ scale: 0.76, palette: p }), 15.2, 4.2, 0, -0.15);
  place(group, createWeaponRack({ scale: 0.68, palette: p }), 17.0, 4.3, 0, 0.12);
  place(group, createSackPile({ scale: 0.68, palette: p }), 18.4, 4.35, 0, -0.12);
  place(group, createWoodpile({ scale: 0.72, palette: p }), 19.7, 4.35, 0, 0.08);
  place(group, createCrate({ scale: 0.9, palette: p }), 12.4, 5.0);
  place(group, createBarrel({ scale: 0.86, palette: p }), 13.8, 5.1);
  place(group, createSignpost({ scale: 0.96, palette: p }), 15.2, 3.6, 0, 0.2);
  place(group, createInn({ seed: 58, scale: 0.62, palette: p }), -17.2, 15.0, 0, 0.08);
  place(group, createChapel({ scale: 0.56, palette: p }), -8.0, 15.0);
  place(group, createFortifiedWall({ length: 8.5, scale: 0.64, palette: p }), 1.0, 15.0);
  place(group, createStable({ scale: 0.64, palette: p }), 10.0, 15.0);
  place(group, createFountain({ scale: 0.7, palette: p }), 17.6, 15.0);
  place(group, createNoticeBoard({ scale: 0.72, palette: p }), 21.2, 14.8);
  place(group, createHayBale({ scale: 0.72, palette: p }), 23.5, 15.0);
  place(group, createGraveMarker({ scale: 0.76, palette: p }), 25.6, 15.0);
  return group;
}

export const PROCEDURAL_ASSETS = [
  { id: 'castle-keep', label: 'Castle Keep', category: 'Landmarks', create: createCastleKeep },
  { id: 'chapel', label: 'Village Chapel', category: 'Landmarks', create: createChapel },
  { id: 'inn', label: 'Village Inn', category: 'Buildings', create: createInn },
  { id: 'timber-house', label: 'Timber House', category: 'Buildings', create: createTimberHouse },
  { id: 'blacksmith', label: 'Blacksmith Workshop', category: 'Buildings', create: createBlacksmith },
  { id: 'stable', label: 'Village Stable', category: 'Buildings', create: createStable },
  { id: 'longhouse', label: 'Longhouse', category: 'Buildings', create: createLonghouse },
  { id: 'round-hut', label: 'Round Hut', category: 'Buildings', create: createRoundHut },
  { id: 'watchtower', label: 'Watchtower', category: 'Fortifications', create: createWatchtower },
  { id: 'village-gate', label: 'Village Gate', category: 'Fortifications', create: createVillageGate },
  { id: 'fortified-wall', label: 'Fortified Wall', category: 'Fortifications', create: createFortifiedWall },
  { id: 'market-stall', label: 'Market Stall', category: 'Village Props', create: createMarketStall },
  { id: 'well', label: 'Roofed Well', category: 'Village Props', create: createWell },
  { id: 'fountain', label: 'Town Fountain', category: 'Village Props', create: createFountain },
  { id: 'notice-board', label: 'Notice Board', category: 'Village Props', create: createNoticeBoard },
  { id: 'hay-bale', label: 'Hay Bale', category: 'Village Props', create: createHayBale },
  { id: 'grave-marker', label: 'Grave Marker', category: 'Village Props', create: createGraveMarker },
  { id: 'bench', label: 'Bench', category: 'Village Props', create: createBench },
  { id: 'handcart', label: 'Handcart', category: 'Village Props', create: createHandcart },
  { id: 'anvil', label: 'Anvil', category: 'Village Props', create: createAnvil },
  { id: 'lantern-post', label: 'Lantern Post', category: 'Village Props', create: createLanternPost },
  { id: 'weapon-rack', label: 'Weapon Rack', category: 'Village Props', create: createWeaponRack },
  { id: 'sack-pile', label: 'Sack Pile', category: 'Village Props', create: createSackPile },
  { id: 'woodpile', label: 'Woodpile', category: 'Village Props', create: createWoodpile },
  { id: 'signpost', label: 'Signpost', category: 'Village Props', create: createSignpost },
  { id: 'banner', label: 'Banner', category: 'Village Props', create: createBanner },
  { id: 'fence-segment', label: 'Fence Segment', category: 'Village Props', create: createFenceSegment },
  { id: 'campfire', label: 'Campfire', category: 'Village Props', create: createCampfire },
  { id: 'crate', label: 'Crate', category: 'Village Props', create: createCrate },
  { id: 'barrel', label: 'Barrel', category: 'Village Props', create: createBarrel },
  { id: 'rock-formation', label: 'Rock Formation', category: 'Nature', create: createRockFormation },
  { id: 'village', label: 'Village Cluster', category: 'Collections', create: createVillageCluster },
  {
    id: 'fortified-village',
    label: 'Fortified Village',
    category: 'Collections',
    create: options => createVillageCluster({ ...options, fortified: true }),
  },
  { id: 'fortified-town', label: 'Fortified Town', category: 'Collections', create: createFortifiedTown },
  { id: 'structure-gallery', label: 'Full Asset Gallery', category: 'Collections', create: createStructureGallery },
];

export function createProceduralAsset(id, options = {}) {
  const asset = PROCEDURAL_ASSETS.find(item => item.id === id);
  if (!asset) throw new Error(`Unknown procedural asset: ${id}`);
  return asset.create(options);
}
