/**
 * Generative ecosystem — seeded placement of grass tufts, flowers, rocks,
 * mushrooms, huts, and village clusters across the arena surroundings.
 *
 * The system exposes its parameters via `userData.editableParams`, which the
 * SceneEditor picks up and renders as live-editable controls. Hitting
 * "Regenerate" rebuilds all placements with the current seed/params.
 *
 * Per-instance edits: huts are individual meshes (pickable in the editor);
 * grass/flowers/rocks/mushrooms are instanced for perf and edited at the
 * group level (color, density, scale).
 */

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GrassField } from './grass';
import type { Collider } from './arena';
// @ts-ignore - shared JS builders are also consumed directly by the Node PNG renderer.
import { collectStructureColliders, createRoundHut, createVillageCluster } from './procedural-structures.js';

export type Biome = 'grassland' | 'autumn' | 'tundra' | 'arid';

export interface EcosystemParams {
  seed: number;
  biome: Biome;
  innerRadius: number;     // exclude props inside this radius (keep combat area clean)
  outerRadius: number;
  flowerCount: number;
  rockCount: number;
  mushroomCount: number;
  hutCount: number;
  villageCount: number;
  rockScale: number;
}

export const DEFAULT_PARAMS: EcosystemParams = {
  seed: 1337,
  biome: 'grassland',
  innerRadius: 9,
  outerRadius: 72,
  flowerCount: 350,
  // Heavier rock count + power-law sizing produces many small pebbles around
  // a few rich veins, with the occasional hill-scale boulder.
  rockCount: 220,
  mushroomCount: 60,
  hutCount: 6,
  villageCount: 2,
  rockScale: 1.0,
};

interface Palette {
  grass: [number, number];   // [primary, secondary] hex colors blended per tuft
  flower: number[];
  rock: number;
  mushroomCap: number;
  mushroomStem: number;
  hutWall: number;
  hutRoof: number;
  ground: number;            // accent disc tint
}

const PALETTES: Record<Biome, Palette> = {
  grassland: {
    // Base sits in the ground's olive family; tip lifts to a soft yellow-green
    // so blades blend with the sward instead of reading as neon sticks.
    grass: [0x4e6b28, 0x9bbf55],
    flower: [0xf2c14e, 0xe85d75, 0xf0eaf4, 0xa86fe4],
    rock: 0x7a7368,
    mushroomCap: 0xc44a3f,
    mushroomStem: 0xf3ead4,
    hutWall: 0x8a6a3d,
    hutRoof: 0x6a3a1f,
    ground: 0x6f9a3e,
  },
  autumn: {
    grass: [0x8a5a1a, 0xb88340],
    flower: [0xe85d2a, 0xd9bf3a, 0xc94020],
    rock: 0x6b5b48,
    mushroomCap: 0xa83820,
    mushroomStem: 0xe6d5b0,
    hutWall: 0x7a5320,
    hutRoof: 0x4a1f10,
    ground: 0x7a5520,
  },
  tundra: {
    grass: [0xc0d4d0, 0x9ab6b3],
    flower: [0xeaf1f5, 0xb7d4ea, 0xd8e3ec],
    rock: 0x90989a,
    mushroomCap: 0x6a8aa0,
    mushroomStem: 0xeaf1ef,
    hutWall: 0xb8b0a0,
    hutRoof: 0x5e6770,
    ground: 0xbcc9c4,
  },
  arid: {
    grass: [0xc9a558, 0xa6803a],
    flower: [0xd84620, 0xf0bf3a, 0xe87a25],
    rock: 0x9a7a55,
    mushroomCap: 0xc06030,
    mushroomStem: 0xeed8b0,
    hutWall: 0xb88a4a,
    hutRoof: 0x6a3a1a,
    ground: 0xc6a368,
  },
};

/** Tiny mulberry32 PRNG — deterministic, no deps. */
function makeRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Ecosystem extends THREE.Group {
  params: EcosystemParams;
  grass: GrassField;
  private readonly heightSampler: (x: number, z: number) => number;

  constructor(_heightData: Uint8Array | null, heightSampler: (x: number, z: number) => number, initial: Partial<EcosystemParams> = {}) {
    super();
    this.name = 'Ecosystem';
    this.heightSampler = heightSampler;
    this.grass = new GrassField(heightSampler, {
      seed: (initial.seed ?? DEFAULT_PARAMS.seed) ^ 0xA5A5,
      innerRadius: initial.innerRadius ?? DEFAULT_PARAMS.innerRadius,
      outerRadius: initial.outerRadius ?? DEFAULT_PARAMS.outerRadius,
    });
    this.add(this.grass);
    this.params = { ...DEFAULT_PARAMS, ...initial };

    // Expose to editor.
    this.userData.editableParams = {
      schema: ecosystemSchema(),
      get: () => this.params,
      set: (next: Partial<EcosystemParams>) => {
        this.params = { ...this.params, ...next };
        this.regenerate();
      },
      regenerate: () => this.regenerate(),
    };

    this.regenerate();
  }

  regenerate(): void {
    // Clear previous children (keep the GrassField; it has its own lifecycle).
    for (const child of [...this.children]) {
      if (child === this.grass) continue;
      this.remove(child);
      disposeDeep(child);
    }

    const rng = makeRng(this.params.seed);
    const palette = PALETTES[this.params.biome];

    // Update grass placement, seed, and biome-tinted colors when the
    // ecosystem regenerates. Each biome maps grass to its palette's primary
    // green/gold pair.
    this.grass.params = {
      ...this.grass.params,
      seed: this.params.seed ^ 0xA5A5,
      // Grass grows into the arena while larger props stay outside the
      // combat ring. This matches WoW's dense ground cover without clutter.
      innerRadius: Math.min(this.params.innerRadius, 2.5),
      // Broad meadow well past the prop radius so ground cover doesn't end in
      // an obvious disc near the player.
      outerRadius: Math.max(this.params.outerRadius, 96),
      baseColor: palette.grass[0],
      tipColor: palette.grass[1],
    };
    this.grass.rebuild();

    // Structures are placed first so rocks can avoid overlapping their main
    // silhouettes. Villages sit outside the combat ring as scenic landmarks.
    const hutsGroup = buildHuts(rng, this.params, palette, this.heightSampler);
    const villagesGroup = buildVillages(rng, this.params, palette, this.heightSampler);
    const hutObstacles = hutsGroup.children.map(h => ({
      x: h.position.x,
      z: h.position.z,
      r: HUT_ROOF_RADIUS * (h.scale.x || 1) + 0.5,
    }));
    const villageObstacles = (villagesGroup.userData.colliders as Collider[])
      .map(c => ({
        x: c.x,
        z: c.z,
        r: c.type === 'cylinder'
          ? c.radius
          : Math.sqrt(c.width * c.width + c.depth * c.depth) * 0.5,
      }));
    // 4 arena pillars at (±8, ±8) with radius ~1.2.
    const pillarObstacles = [
      { x: -8, z: -8, r: 1.6 },
      { x:  8, z: -8, r: 1.6 },
      { x: -8, z:  8, r: 1.6 },
      { x:  8, z:  8, r: 1.6 },
    ];
    const obstacles = [...hutObstacles, ...villageObstacles, ...pillarObstacles];

    this.add(hutsGroup);
    this.add(villagesGroup);
    this.add(buildFlowers(rng, this.params, palette, this.heightSampler));
    this.add(buildRocks(rng, this.params, palette, this.heightSampler, obstacles));
    this.add(buildMushrooms(rng, this.params, palette, this.heightSampler));
  }

  /** Drive wind animation. */
  update(elapsed: number): void {
    this.grass.update(elapsed);
  }

  /**
   * Colliders for every solid prop in the ecosystem (huts + sizeable rocks).
   * Geometry is derived directly from each primitive's dimensions so the
   * hitbox matches what's rendered.
   */
  getColliders(): Collider[] {
    const out: Collider[] = [];
    for (const child of this.children) {
      // Huts (parent group; each child is a single hut group with .collider)
      if (child.name === 'Huts') {
        for (const hut of child.children) {
          const c = hut.userData.collider as { type: 'cylinder'; radius: number; height: number } | undefined;
          if (!c) continue;
          const scale = hut.scale.x || 1;
          out.push({
            type: 'cylinder',
            x: hut.position.x,
            z: hut.position.z,
            radius: c.radius * scale,
            height: c.height * scale,
          });
        }
      }
      // Rocks
      if (child.name === 'Rocks') {
        const cols = child.userData.colliders as Collider[] | undefined;
        if (cols) out.push(...cols);
      }
      if (child.name === 'Villages') {
        const cols = child.userData.colliders as Collider[] | undefined;
        if (cols) out.push(...cols);
      }
    }
    return out;
  }
}

function ecosystemSchema() {
  return [
    { key: 'seed',          label: 'Seed',          type: 'int' as const, min: 0, max: 99999, step: 1 },
    { key: 'biome',         label: 'Biome',         type: 'select' as const, options: ['grassland', 'autumn', 'tundra', 'arid'] },
    { key: 'innerRadius',   label: 'Inner radius',  type: 'float' as const, min: 0, max: 40, step: 0.5 },
    { key: 'outerRadius',   label: 'Outer radius',  type: 'float' as const, min: 5, max: 50, step: 0.5 },
    { key: 'flowerCount',   label: 'Flowers',       type: 'int' as const, min: 0, max: 1000, step: 25 },
    { key: 'rockCount',     label: 'Rocks',         type: 'int' as const, min: 0, max: 300, step: 5 },
    { key: 'mushroomCount', label: 'Mushrooms',     type: 'int' as const, min: 0, max: 300, step: 5 },
    { key: 'hutCount',      label: 'Huts',          type: 'int' as const, min: 0, max: 20, step: 1 },
    { key: 'villageCount',  label: 'Villages',      type: 'int' as const, min: 0, max: 4, step: 1 },
    { key: 'rockScale',     label: 'Rock scale',    type: 'float' as const, min: 0.3, max: 3.0, step: 0.05 },
  ];
}

// ---------- builders ----------

function sampleRadial(rng: () => number, inner: number, outer: number): [number, number] {
  // Uniform-area sampling in annulus.
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng() * (outer * outer - inner * inner) + inner * inner);
  return [Math.cos(a) * r, Math.sin(a) * r];
}

function buildFlowers(
  rng: () => number,
  p: EcosystemParams,
  palette: Palette,
  height: (x: number, z: number) => number,
): THREE.Object3D {
  // Small disc + stem.
  const group = new THREE.Group();
  group.name = 'Flowers';

  const stemGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.25, 4);
  stemGeo.translate(0, 0.125, 0);
  const stemMat = new THREE.MeshLambertMaterial({ color: 0x3b5a1a });
  const stems = new THREE.InstancedMesh(stemGeo, stemMat, p.flowerCount);
  stems.name = 'FlowerStems';

  const headGeo = new THREE.CircleGeometry(0.08, 6);
  headGeo.rotateX(-Math.PI / 2);
  headGeo.translate(0, 0.27, 0);
  const headMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const heads = new THREE.InstancedMesh(headGeo, headMat, p.flowerCount);
  heads.name = 'FlowerHeads';

  const tmpMatrix = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();
  const tmpPos = new THREE.Vector3();
  const tmpScale = new THREE.Vector3(1, 1, 1);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < p.flowerCount; i++) {
    const [x, z] = sampleRadial(rng, p.innerRadius, p.outerRadius);
    const y = height(x, z);
    const s = 0.8 + rng() * 0.6;
    tmpPos.set(x, y, z);
    tmpScale.set(s, s, s);
    tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
    tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
    stems.setMatrixAt(i, tmpMatrix);
    heads.setMatrixAt(i, tmpMatrix);

    tmpColor.set(palette.flower[Math.floor(rng() * palette.flower.length)]);
    heads.setColorAt(i, tmpColor);
  }
  stems.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  if (heads.instanceColor) heads.instanceColor.needsUpdate = true;

  group.add(stems);
  group.add(heads);
  return group;
}

interface RockObstacle { x: number; z: number; r: number }

function buildRocks(
  rng: () => number,
  p: EcosystemParams,
  palette: Palette,
  height: (x: number, z: number) => number,
  obstacles: RockObstacle[] = [],
): THREE.Object3D {
  // Vein clustering: pick K vein centers across the annulus, then sample
  // rocks weighted toward them (gaussian falloff per vein). A small fraction
  // are "stray" rocks placed uniformly so the field doesn't feel grid-like.
  //
  // Size distribution: Pareto-like (power-law). Most rocks are small (0.4–1.0),
  // a few are mid (1.0–2.0), and rare ones become hill-sized boulders (2.5–4.5).
  //
  // Some veins are flagged as "boulder fields" — they spawn a small hill
  // cluster (one big boulder + several supporting rocks).
  const group = new THREE.Group();
  group.name = 'Rocks';

  // IcosahedronGeometry is non-indexed AND its UV attribute introduces seams
  // (verts at the same position with different UVs), so `mergeVertices` only
  // collapses verts that share BOTH. To get a truly watertight shape, strip
  // the UV attribute first — rocks have no texture map. Then merge, jitter
  // the unique vertex set, and go back to non-indexed for flat shading.
  // Several silhouette variants (different jitter seeds, one chunkier
  // low-detail shape, one craggier high-detail shape) so boulder fields don't
  // read as the same rock stamped everywhere.
  const buildRockGeo = (seed: number, detail: number, jitter: number) => {
    const rawGeo = new THREE.IcosahedronGeometry(0.35, detail);
    rawGeo.deleteAttribute('uv');
    rawGeo.deleteAttribute('normal');
    const indexed = mergeVertices(rawGeo, 1e-3);
    const ipos = indexed.attributes.position as THREE.BufferAttribute;
    const j = makeRng(seed);
    for (let i = 0; i < ipos.count; i++) {
      const f = 1 - jitter / 2 + j() * jitter;
      ipos.setXYZ(i, ipos.getX(i) * f, ipos.getY(i) * f, ipos.getZ(i) * f);
    }
    const out = indexed.toNonIndexed();
    out.computeVertexNormals();
    rawGeo.dispose();
    indexed.dispose();
    return out;
  };
  const geoVariants = [
    buildRockGeo(0xC0DE, 1, 0.42),
    buildRockGeo(0xBEEF, 1, 0.55),
    buildRockGeo(0xFACE, 2, 0.34),
  ];

  // White base — the full rock color is carried by per-instance colors
  // (instanceColor multiplies material.color, so a tinted base would darken
  // every rock toward black).
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: true,
  });
  // Broad procedural texturing: world-space tonal noise plus a mossy tint
  // creeping up from the ground on near-flat upward faces.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vRockWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vRockWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vRockWorld;
        float rkhash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float rknoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          vec3 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(rkhash(i), rkhash(i + vec3(1,0,0)), u.x),
                mix(rkhash(i + vec3(0,1,0)), rkhash(i + vec3(1,1,0)), u.x), u.y),
            mix(mix(rkhash(i + vec3(0,0,1)), rkhash(i + vec3(1,0,1)), u.x),
                mix(rkhash(i + vec3(0,1,1)), rkhash(i + vec3(1,1,1)), u.x), u.y),
            u.z);
        }
        `,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        /* glsl */ `
        vec4 diffuseColor = vec4( diffuse, opacity );
        {
          float grain = rknoise(vRockWorld * 2.2) * 0.6 + rknoise(vRockWorld * 9.0) * 0.4;
          diffuseColor.rgb *= 0.84 + grain * 0.32;
          // Mossy green on up-facing surfaces (face normal via derivatives —
          // matches the flat shading).
          vec3 fn = normalize(cross(dFdx(vRockWorld), dFdy(vRockWorld)));
          float up = clamp(fn.y, 0.0, 1.0);
          float moss = smoothstep(0.55, 0.95, up) * smoothstep(0.3, 0.75, rknoise(vRockWorld * 1.1));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.42, 0.18), moss * 0.5);
        }
        `,
      );
  };

  // Vein centers. Number scales with map size so big maps don't feel sparse.
  const mapSize = p.outerRadius - p.innerRadius;
  const veinCount = Math.max(5, Math.round(mapSize / 6));
  interface Vein { x: number; z: number; spread: number; weight: number; boulder: boolean }
  const veins: Vein[] = [];
  for (let i = 0; i < veinCount; i++) {
    const [vx, vz] = sampleRadial(rng, p.innerRadius + 1, p.outerRadius - 2);
    veins.push({
      x: vx,
      z: vz,
      spread: 2 + rng() * 4,
      // Zipf weighting: first vein dominates, later ones taper off — gives a
      // small number of "rich" veins and many "sparse" ones.
      weight: 1 / (i + 1),
      boulder: rng() < 0.6,
    });
  }
  const totalWeight = veins.reduce((s, v) => s + v.weight, 0);

  // Pre-spawn boulder hills: each boulder vein gets one large boulder + 4-8
  // smaller rocks clustered tightly. Big ones can be cave-mouth scale.
  const allRocks: Array<{ x: number; z: number; size: number; squash: number }> = [];

  const tryPush = (x: number, z: number, size: number, squash: number) => {
    // Obstacle rejection on XZ plane — keep rocks out of huts + pillars.
    // Use rock radius (size * 0.6) so big boulders don't kiss obstacle edges.
    const rockR = size * 0.6;
    for (const o of obstacles) {
      const dx = x - o.x, dz = z - o.z;
      if (dx * dx + dz * dz < (o.r + rockR) * (o.r + rockR)) return false;
    }
    allRocks.push({ x, z, size, squash });
    return true;
  };

  for (const v of veins) {
    if (!v.boulder) continue;
    // Hill-scale boulders: 3.0–5.5 — significantly larger than before.
    const bigSize = 3.0 + rng() * 2.5;
    if (!tryPush(v.x, v.z, bigSize, 0.55 + rng() * 0.25)) continue;
    const support = 4 + Math.floor(rng() * 5);
    for (let k = 0; k < support; k++) {
      const a = rng() * Math.PI * 2;
      const r = bigSize * (0.35 + rng() * 0.75);
      tryPush(
        v.x + Math.cos(a) * r,
        v.z + Math.sin(a) * r,
        bigSize * (0.25 + rng() * 0.4),
        0.5 + rng() * 0.5,
      );
    }
  }

  // Distributed small rocks around veins (power-law size). Promote a fraction
  // to mid-size so the field has visible medium boulders too.
  const remaining = Math.max(0, p.rockCount - allRocks.length);
  let placed = 0;
  let attempts = 0;
  while (placed < remaining && attempts < remaining * 6) {
    attempts++;
    let x: number, z: number, size: number;
    if (rng() < 0.15) {
      [x, z] = sampleRadial(rng, p.innerRadius + 1, p.outerRadius);
    } else {
      let pick = rng() * totalWeight;
      let chosen = veins[0];
      for (const v of veins) { pick -= v.weight; if (pick <= 0) { chosen = v; break; } }
      const a = rng() * Math.PI * 2;
      const r = Math.abs(gaussian(rng)) * chosen.spread;
      x = chosen.x + Math.cos(a) * r;
      z = chosen.z + Math.sin(a) * r;
    }
    size = paretoSize(rng) * p.rockScale;
    // 8% of "normal" rocks promoted to medium boulder size.
    if (rng() < 0.08) size = Math.max(size, 1.6 + rng() * 1.0);
    if (tryPush(x, z, size, 0.5 + rng() * 0.5)) placed++;
  }

  // Pack into one InstancedMesh per geometry variant (still 3 draw calls).
  // Variant choice and a warm/cool grey per-instance tint keep fields varied.
  const variantOf = (i: number) => i % geoVariants.length;
  const counts = geoVariants.map((_, vi) =>
    allRocks.reduce((n, _r, i) => n + (variantOf(i) === vi ? 1 : 0), 0));
  const meshes = geoVariants.map((g, vi) => {
    const m = new THREE.InstancedMesh(g, mat, counts[vi]);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  });

  const tmpMatrix = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();
  const tmpPos = new THREE.Vector3();
  const tmpScale = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const baseColor = new THREE.Color(palette.rock);
  // Icosahedron radius pre-scale; after scaling by `size`, bottom is at
  // `-size * baseRadius * squash`. Lift so the bottom rests on the terrain
  // (with a small sink for large boulders so they read as embedded hills).
  const BASE_ROCK_R = 0.35;
  const cursor = geoVariants.map(() => 0);
  for (let i = 0; i < allRocks.length; i++) {
    const r = allRocks[i];
    const halfH = r.size * BASE_ROCK_R * r.squash;
    const sink = r.size > 2 ? halfH * 0.30 : 0; // big rocks half-buried slightly
    const y = height(r.x, r.z) + halfH - sink;
    tmpPos.set(r.x, y, r.z);
    tmpScale.set(r.size, r.size * r.squash, r.size);
    tmpQuat.setFromEuler(new THREE.Euler(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4));
    tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
    const vi = variantOf(i);
    const slot = cursor[vi]++;
    meshes[vi].setMatrixAt(slot, tmpMatrix);
    // Tint: drift between cool grey and warm sandstone, darker for small stones.
    const warm = rng();
    const lum = 0.82 + rng() * 0.3 + Math.min(0.12, r.size * 0.03);
    tmpColor.copy(baseColor)
      .lerp(new THREE.Color(0x8d7a5e), warm * 0.4)
      .multiplyScalar(lum);
    meshes[vi].setColorAt(slot, tmpColor);
  }
  for (const m of meshes) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    group.add(m);
  }

  // Per-rock cylinder collider (derived from the icosahedron's scaled radius).
  // Only register rocks above a threshold — tiny pebbles shouldn't block
  // movement (they'd feel like invisible walls). Climbable, with topY set
  // from the rock's terrain-relative placement so the player can stand on
  // medium and large boulders.
  const ROCK_COLLIDE_MIN_SIZE = 0.9;
  const colliders: Collider[] = [];
  for (const r of allRocks) {
    if (r.size < ROCK_COLLIDE_MIN_SIZE) continue;
    const halfH = r.size * BASE_ROCK_R * r.squash;
    const sink = r.size > 2 ? halfH * 0.30 : 0;
    const baseY = height(r.x, r.z) - sink;        // bottom of the visible rock
    const topY = baseY + 2 * halfH;
    colliders.push({
      type: 'cylinder',
      x: r.x,
      z: r.z,
      radius: r.size * BASE_ROCK_R * 0.9,
      height: topY,                                // collider extends from y=0 up to topY (good enough)
      topY,
      climbable: true,
    });
  }
  group.userData.colliders = colliders;
  return group;
}

/** Pareto-distributed rock size — most ~0.5, occasional outliers up to ~3. */
function paretoSize(rng: () => number): number {
  // Sample u in (0,1); inverse-CDF of Pareto with xm=0.5, alpha=1.7.
  const u = Math.max(0.0001, rng());
  const xm = 0.5;
  const alpha = 1.7;
  return Math.min(4.0, xm / Math.pow(u, 1 / alpha));
}

/** Box-Muller transform — standard normal in [-∞, ∞], typically ~[-3, 3]. */
function gaussian(rng: () => number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function buildMushrooms(
  rng: () => number,
  p: EcosystemParams,
  palette: Palette,
  height: (x: number, z: number) => number,
): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'Mushrooms';

  const stemGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.2, 6);
  stemGeo.translate(0, 0.1, 0);
  const stemMat = new THREE.MeshLambertMaterial({ color: palette.mushroomStem });
  const stems = new THREE.InstancedMesh(stemGeo, stemMat, p.mushroomCount);
  stems.name = 'MushroomStems';
  stems.castShadow = true;

  const capGeo = new THREE.SphereGeometry(0.13, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  capGeo.translate(0, 0.2, 0);
  const capMat = new THREE.MeshLambertMaterial({ color: palette.mushroomCap });
  const caps = new THREE.InstancedMesh(capGeo, capMat, p.mushroomCount);
  caps.name = 'MushroomCaps';
  caps.castShadow = true;

  const tmpMatrix = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();
  const tmpPos = new THREE.Vector3();
  const tmpScale = new THREE.Vector3();
  for (let i = 0; i < p.mushroomCount; i++) {
    const [x, z] = sampleRadial(rng, p.innerRadius + 1, p.outerRadius);
    const y = height(x, z);
    const s = 0.7 + rng() * 1.0;
    tmpPos.set(x, y, z);
    tmpScale.set(s, s, s);
    tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
    tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
    stems.setMatrixAt(i, tmpMatrix);
    caps.setMatrixAt(i, tmpMatrix);
  }
  stems.instanceMatrix.needsUpdate = true;
  caps.instanceMatrix.needsUpdate = true;
  group.add(stems);
  group.add(caps);
  return group;
}

function buildHuts(
  rng: () => number,
  p: EcosystemParams,
  palette: Palette,
  height: (x: number, z: number) => number,
): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'Huts';

  for (let i = 0; i < p.hutCount; i++) {
    // Huts sit just outside the combat zone, well inside the tree line.
    const [x, z] = sampleRadial(rng, p.innerRadius + 4, p.outerRadius - 8);
    const y = height(x, z);
    const hut = createRoundHut({
      seed: Math.floor(rng() * 100000),
      palette: toStructurePalette(palette),
    }) as THREE.Group;
    hut.name = `Hut_${i}`;
    hut.position.set(x, y, z);
    hut.rotation.y = rng() * Math.PI * 2;
    const s = 0.9 + rng() * 0.5;
    hut.scale.setScalar(s);
    group.add(hut);
  }
  return group;
}

// Hitbox derives directly from these primitive dimensions so collisions
// match what the player sees.
const HUT_ROOF_RADIUS = 2.35;

function buildVillages(
  rng: () => number,
  p: EcosystemParams,
  palette: Palette,
  height: (x: number, z: number) => number,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Villages';
  const colliders: Collider[] = [];
  const structurePalette = toStructurePalette(palette);

  for (let i = 0; i < p.villageCount; i++) {
    const angle = 0.55 + (i / Math.max(1, p.villageCount)) * Math.PI * 2 + (rng() - 0.5) * 0.28;
    const radius = Math.max(p.innerRadius + 14, p.outerRadius - 6 + rng() * 3);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const village = createVillageCluster({
      seed: p.seed + 101 + i * 37,
      fortified: i % 2 === 1,
      scale: 0.64 + rng() * 0.08,
      palette: structurePalette,
    }) as THREE.Group;
    village.position.set(x, height(x, z), z);
    village.rotation.y = -angle + Math.PI * 0.5;
    group.add(village);
  }

  colliders.push(...collectStructureColliders(group) as Collider[]);
  group.userData.colliders = colliders;
  return group;
}

function toStructurePalette(p: Palette) {
  return {
    plaster: p.hutWall,
    plasterLight: new THREE.Color(p.hutWall).lerp(new THREE.Color(0xffffff), 0.18).getHex(),
    thatch: p.hutRoof,
    thatchLight: new THREE.Color(p.hutRoof).lerp(new THREE.Color(0xd89b4b), 0.3).getHex(),
    stone: p.rock,
    stoneDark: new THREE.Color(p.rock).multiplyScalar(0.68).getHex(),
  };
}

function disposeDeep(obj: THREE.Object3D): void {
  obj.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(x => x.dispose());
    else if (mat) mat.dispose();
  });
}
