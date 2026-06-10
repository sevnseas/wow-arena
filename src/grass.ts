/**
 * Stylized instanced grass — based on Felix Mariotto's three.js forum example
 * (https://discourse.threejs.org/t/simple-instanced-grass-example/26694) and
 * the BotW-style technique writeup at
 * https://smythdesign.com/blog/stylized-grass-webgl/
 *
 * Each blade is a thin plane (0.1 × 1) with 4 vertical segments. UV.y drives:
 *   - wind displacement (1 - cos(uv.y * π/2)) so the base stays planted and
 *     the tip bends the most;
 *   - tip-to-base color gradient (darker at base, lighter at tip).
 *
 * Placement uses clustered (Poisson-disk-ish) jittered grid sampling so the
 * field reads as natural patches rather than uniform white noise.
 */

import * as THREE from 'three';
import { REGION_FOOTPRINTS } from './regions';
import { blendBiomeTint, BIOME_GROUND_TINT } from './biomes';

export interface GrassFieldParams {
  seed: number;
  count: number;
  innerRadius: number;
  outerRadius: number;
  bladeHeight: number;
  bladeWidth: number;
  windStrength: number;
  windSpeed: number;
  baseColor: number;
  tipColor: number;
  hueJitter: number;     // 0..1 random hue variance per blade
  patchiness: number;    // 0 = uniform, 1 = strong clustering
  crossPlanes: boolean;  // if true, two planes rotated 60° per instance for fuller silhouette
}

export const DEFAULT_GRASS_PARAMS: GrassFieldParams = {
  seed: 1337,
  count: 72000,
  innerRadius: 2,
  outerRadius: 96,
  bladeHeight: 0.4,
  bladeWidth: 0.11,
  windStrength: 0.1,
  windSpeed: 1.5,
  // Matched to the terrain shader's lush-lowland band so blades grow out of
  // the ground color instead of floating on it; tips lift toward warm lime.
  baseColor: 0x3e6322,
  tipColor: 0x8dbb4a,
  hueJitter: 0.14,
  patchiness: 0.3,
  crossPlanes: true,
};

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Up to 8 actors (player + nearby animals) can press grass simultaneously.
const MAX_ACTORS = 8;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vInstanceTint;
  attribute vec3 aTint;
  attribute float aPhase;

  uniform float uTime;
  uniform float uWindStrength;
  uniform float uWindSpeed;
  // Each vec4 = (worldX, worldY, worldZ, pressRadius). Slot ignored when w<=0.
  uniform vec4 uActors[${MAX_ACTORS}];

  void main() {
    vUv = uv;
    vInstanceTint = aTint;

    // Taper the blade toward the tip so it reads as a curved leaf, not a
    // rectangle strip. Local xz shrink keeps both cross planes symmetric.
    vec3 tapered = position;
    float taper = mix(1.0, 0.12, uv.y * uv.y);
    tapered.x *= taper;
    tapered.z *= taper;

    vec4 mvPosition = vec4(tapered, 1.0);
    #ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
    #endif

    // Static per-blade arc: each blade bows in its own direction (derived
    // from its random phase), strongest at the tip — gives the field the
    // tousled, curved-blade silhouette instead of upright flat cards.
    vec2 leanDir = vec2(cos(aPhase * 2.4), sin(aPhase * 2.4));
    float arc = uv.y * uv.y * 0.16;
    mvPosition.x += leanDir.x * arc;
    mvPosition.z += leanDir.y * arc;

    // Wind: base stays put, tip sways the most. The per-blade phase (aPhase)
    // makes neighbouring blades fall out of sync, producing a wave-like gust.
    float dispPower = 1.0 - cos(uv.y * 1.5707963);
    float wave = sin(mvPosition.x * 0.25 + mvPosition.z * 0.18 + uTime * uWindSpeed + aPhase);
    float wDisp = wave * uWindStrength * dispPower;
    mvPosition.x += wDisp;
    mvPosition.z += wDisp * 0.5;

    // Actor collision: bend tip away from any actor within their press radius.
    // Base position is the instance origin in world space.
    vec3 bladeBase = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 push = vec3(0.0);
    for (int i = 0; i < ${MAX_ACTORS}; i++) {
      vec4 actor = uActors[i];
      if (actor.w <= 0.0001) continue;
      vec2 d = bladeBase.xz - actor.xz;
      float dist = length(d);
      if (dist < actor.w) {
        // Smooth falloff: full bend at center, zero at edge.
        float t = 1.0 - dist / actor.w;
        float k = t * t * (3.0 - 2.0 * t);
        // Direction away from actor.
        vec2 dir = dist > 0.0001 ? d / dist : vec2(1.0, 0.0);
        // Tip is pushed; UV.y scales so base stays planted.
        // Push magnitude: ~half the press radius so the blade lays mostly flat.
        float mag = k * actor.w * 0.55 * dispPower;
        push.x += dir.x * mag;
        push.z += dir.y * mag;
        // Slight downward squish at the tip — feels like the blade is mashed.
        push.y -= k * 0.25 * dispPower;
      }
    }
    mvPosition.xyz += push;

    gl_Position = projectionMatrix * modelViewMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vInstanceTint;

  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;

  void main() {
    // Tip-to-base gradient: gentle ambient-occlusion at the base only. Kept
    // shallow (0.72 → 1.0) so blades read as a lit carpet, not dark spikes.
    float clarity = vUv.y * 0.28 + 0.72;
    vec3 col = mix(uBaseColor, uTipColor, vUv.y) * vInstanceTint;
    gl_FragColor = vec4(col * clarity, 1.0);
  }
`;

export class GrassField extends THREE.Group {
  params: GrassFieldParams;
  private material: THREE.ShaderMaterial | null = null;
  private readonly heightSampler: (x: number, z: number) => number;

  constructor(heightSampler: (x: number, z: number) => number, initial: Partial<GrassFieldParams> = {}) {
    super();
    this.name = 'GrassField';
    this.heightSampler = heightSampler;
    this.params = { ...DEFAULT_GRASS_PARAMS, ...initial };

    this.userData.editableParams = {
      schema: grassSchema(),
      get: () => this.params,
      set: (next: Partial<GrassFieldParams>) => {
        this.params = { ...this.params, ...next };
        this.rebuild();
      },
      regenerate: () => this.rebuild(),
    };

    this.rebuild();
  }

  /** Call each frame with elapsed seconds to drive wind. */
  update(elapsed: number): void {
    if (this.material) this.material.uniforms.uTime.value = elapsed;
  }

  /**
   * Update the actor list each frame. Pass world positions + press radii of
   * things that should bend nearby grass (player, animals). Extra entries
   * beyond MAX_ACTORS are ignored.
   */
  setActors(actors: ReadonlyArray<{ pos: THREE.Vector3; radius: number }>): void {
    if (!this.material) return;
    const slots = this.material.uniforms.uActors.value as THREE.Vector4[];
    for (let i = 0; i < MAX_ACTORS; i++) {
      const a = actors[i];
      if (a) slots[i].set(a.pos.x, a.pos.y, a.pos.z, a.radius);
      else slots[i].set(0, 0, 0, 0);
    }
  }

  rebuild(): void {
    for (const c of [...this.children]) {
      this.remove(c);
      if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
    }
    if (this.material) this.material.dispose();

    const p = this.params;

    // Single blade: thin plane, 4 vertical segments — UV.y rises base→tip.
    const blade = new THREE.PlaneGeometry(p.bladeWidth, p.bladeHeight, 1, 4);
    blade.translate(0, p.bladeHeight * 0.5, 0);

    let geo: THREE.BufferGeometry = blade;
    if (p.crossPlanes) {
      // Second plane rotated 60° around Y — fuller silhouette from above.
      const second = blade.clone();
      const m = new THREE.Matrix4().makeRotationY(Math.PI / 3);
      second.applyMatrix4(m);
      geo = mergeGeometries(blade, second);
      blade.dispose();
    }

    // Allocate fixed-length actor uniform array; CPU mutates it each frame.
    const actorSlots: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_ACTORS; i++) actorSlots.push(new THREE.Vector4(0, 0, 0, 0));

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uWindStrength: { value: p.windStrength },
        uWindSpeed: { value: p.windSpeed },
        uBaseColor: { value: new THREE.Color(p.baseColor) },
        uTipColor: { value: new THREE.Color(p.tipColor) },
        uActors: { value: actorSlots },
      },
    });

    const mesh = new THREE.InstancedMesh(geo, this.material, p.count);
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    // Per-instance attributes: tint (vec3) and phase (float).
    const tints = new Float32Array(p.count * 3);
    const phases = new Float32Array(p.count);

    const rng = mulberry32(p.seed);
    const placements = clusterPlacements(rng, p.innerRadius, p.outerRadius, p.count, p.patchiness);

    const dummy = new THREE.Object3D();
    const tintBase = new THREE.Color(p.tipColor);
    const hsl = { h: 0, s: 0, l: 0 };
    tintBase.getHSL(hsl);

    for (let i = 0; i < p.count; i++) {
      const [x, z] = placements[i];
      const y = this.heightSampler(x, z);
      dummy.position.set(x, y, z);
      dummy.rotation.y = rng() * Math.PI * 2;
      const s = 0.7 + rng() * 0.6;
      dummy.scale.set(s, 0.85 + rng() * 0.5, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Per-blade hue jitter — small HSL nudge so the field has organic variance.
      const hueShift = (rng() - 0.5) * p.hueJitter;
      const lightShift = (rng() - 0.5) * p.hueJitter * 0.4;
      const tinted = new THREE.Color().setHSL(
        (hsl.h + hueShift + 1) % 1,
        Math.max(0, Math.min(1, hsl.s)),
        Math.max(0, Math.min(1, hsl.l + lightShift)),
      );
      // Stored as multiplier: divide by tipColor per channel so 1.0 == identity.
      // Clamp tightly so a hue nudge on a low channel (e.g. blue in a green
      // tip) can't explode into a neon spike.
      const clampTint = (v: number) => Math.max(0.75, Math.min(1.25, v));
      // Biome gradient: blades take on the local ecosystem's tint (amber in
      // autumn, gold in arid, frosted in tundra), blended smoothly across
      // zone borders by the shared biome weight field.
      const bt = blendBiomeTint(x, z, BIOME_GROUND_TINT);
      const clampBiome = (v: number) => Math.max(0.45, Math.min(1.7, v));
      tints[i * 3 + 0] = clampBiome(clampTint(tinted.r / Math.max(0.001, tintBase.r)) * bt[0]);
      tints[i * 3 + 1] = clampBiome(clampTint(tinted.g / Math.max(0.001, tintBase.g)) * bt[1]);
      tints[i * 3 + 2] = clampBiome(clampTint(tinted.b / Math.max(0.001, tintBase.b)) * bt[2]);

      phases[i] = rng() * Math.PI * 2;
    }
    mesh.instanceMatrix.needsUpdate = true;

    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));

    this.add(mesh);
  }
}

function grassSchema() {
  return [
    { key: 'seed',          label: 'Seed',          type: 'int' as const,   min: 0, max: 99999, step: 1 },
    { key: 'count',         label: 'Blades',        type: 'int' as const,   min: 0, max: 50000, step: 500 },
    { key: 'innerRadius',   label: 'Inner radius',  type: 'float' as const, min: 0, max: 40, step: 0.5 },
    { key: 'outerRadius',   label: 'Outer radius',  type: 'float' as const, min: 5, max: 60, step: 0.5 },
    { key: 'bladeHeight',   label: 'Blade height',  type: 'float' as const, min: 0.1, max: 2.5, step: 0.05 },
    { key: 'bladeWidth',    label: 'Blade width',   type: 'float' as const, min: 0.02, max: 0.5, step: 0.01 },
    { key: 'windStrength',  label: 'Wind strength', type: 'float' as const, min: 0, max: 1, step: 0.01 },
    { key: 'windSpeed',     label: 'Wind speed',    type: 'float' as const, min: 0, max: 5, step: 0.05 },
    { key: 'hueJitter',     label: 'Hue jitter',    type: 'float' as const, min: 0, max: 0.5, step: 0.01 },
    { key: 'patchiness',    label: 'Patchiness',    type: 'float' as const, min: 0, max: 1, step: 0.05 },
  ];
}

/**
 * Jittered-grid placement biased by 2D value noise so blades clump into
 * patches rather than being uniformly random. `patchiness` = 0 produces flat
 * uniform density; 1 produces strong clumps with bald spots.
 */
function clusterPlacements(
  rng: () => number,
  inner: number,
  outer: number,
  count: number,
  patchiness: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  // Pre-bake a coarse noise field for patch density (radial grid).
  const noiseSeed = Math.floor(rng() * 1e9);
  const noise = (x: number, z: number) => valueNoise(x * 0.07, z * 0.07, noiseSeed);

  let attempts = 0;
  const maxAttempts = count * 6;
  while (out.length < count && attempts < maxAttempts) {
    attempts++;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng() * (outer * outer - inner * inner) + inner * inner);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // Don't grass over the themed regions (towns, swamps have their own ground).
    if (REGION_FOOTPRINTS.some(f => Math.hypot(x - f.x, z - f.z) < f.r - 4)) continue;
    // Density mask: noise ∈ [-1, 1] → accept probability.
    const n = (noise(x, z) + 1) * 0.5;          // 0..1
    const accept = 1 - patchiness + patchiness * n;
    if (rng() < accept) out.push([x, z]);
  }
  return out;
}

/** Simple 2D value noise (bilinear-interpolated hash grid). */
function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  return ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v) * 2 - 1;
}

function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296);
}

/** Tiny utility — concatenates two non-indexed-or-indexed plane geometries. */
function mergeGeometries(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  // For PlaneGeometry we know the attributes are position/normal/uv/index.
  const aIndexed = a.index ? a.toNonIndexed() : a;
  const bIndexed = b.index ? b.toNonIndexed() : b;
  const merged = new THREE.BufferGeometry();

  const ap = aIndexed.getAttribute('position') as THREE.BufferAttribute;
  const bp = bIndexed.getAttribute('position') as THREE.BufferAttribute;
  const au = aIndexed.getAttribute('uv') as THREE.BufferAttribute;
  const bu = bIndexed.getAttribute('uv') as THREE.BufferAttribute;

  const pos = new Float32Array(ap.array.length + bp.array.length);
  pos.set(ap.array as Float32Array, 0);
  pos.set(bp.array as Float32Array, ap.array.length);

  const uv = new Float32Array(au.array.length + bu.array.length);
  uv.set(au.array as Float32Array, 0);
  uv.set(bu.array as Float32Array, au.array.length);

  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.computeVertexNormals();
  return merged;
}
