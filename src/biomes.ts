/**
 * World-space biome field — turns the existing biome palettes into actual
 * places. Each biome owns a soft gaussian footprint on the map; weights are
 * normalized so any point is a smooth blend of the ecosystems around it
 * (WoW-style zone gradients rather than hard borders).
 *
 * The same centers/sigmas are mirrored in the terrain shader (terrain.ts) so
 * ground color, grass tint, tree foliage and the player-local atmosphere all
 * agree about where one ecosystem flows into the next.
 */

import * as THREE from 'three';

export type BiomeKey = 'grassland' | 'autumn' | 'tundra' | 'arid';

export interface BiomeZone {
  key: BiomeKey;
  x: number;
  z: number;
  /** Gaussian falloff radius — bigger = wider zone and softer gradient. */
  sigma: number;
}

// Grassland holds the settled center; the outer biomes claim compass arcs of
// the 320×320 world. Sigmas overlap on purpose: the overlap band IS the
// gradient.
export const BIOME_ZONES: BiomeZone[] = [
  { key: 'grassland', x: 0, z: 0, sigma: 78 },
  { key: 'autumn', x: 105, z: -75, sigma: 78 },
  { key: 'arid', x: -110, z: 60, sigma: 80 },
  { key: 'tundra', x: 30, z: 125, sigma: 72 },
];

/** Per-biome accent colors used by world tinting (kept in sync with the
 * ecosystem palettes' mood, expressed as multiplicative tints on lush green). */
export const BIOME_GROUND_TINT: Record<BiomeKey, [number, number, number]> = {
  grassland: [1.0, 1.0, 1.0],
  autumn: [1.38, 0.92, 0.52],   // amber/rust
  tundra: [0.94, 1.0, 1.08],    // frosted, desaturated (extra desat in shader)
  arid: [1.30, 1.10, 0.62],     // sun-baked gold
};

/** Atmosphere tint per biome — multiplies fog/haze when the player stands
 * inside the zone, so each ecosystem has its own air. */
export const BIOME_FOG_TINT: Record<BiomeKey, [number, number, number]> = {
  grassland: [1.0, 1.0, 1.0],
  autumn: [1.12, 1.0, 0.82],
  tundra: [0.94, 1.0, 1.10],
  arid: [1.10, 1.02, 0.84],
};

/** Foliage colors for trees by biome (blended by weight at the tree's spot). */
export const BIOME_FOLIAGE: Record<BiomeKey, number> = {
  grassland: 0x5d8a37,
  autumn: 0xb05a1c,
  tundra: 0x7fa08a,
  arid: 0x8a8a3a,
};

const tmpWeights: number[] = [0, 0, 0, 0];

/**
 * Normalized biome weights at a world position. Returned array is reused —
 * copy if you keep it. Order matches BIOME_ZONES.
 */
export function biomeWeights(x: number, z: number): readonly number[] {
  let sum = 0;
  for (let i = 0; i < BIOME_ZONES.length; i++) {
    const b = BIOME_ZONES[i];
    const dx = x - b.x, dz = z - b.z;
    // Gaussian falloff with a small floor so no biome ever fully zeroes out
    // (keeps the blend numerically smooth at map corners).
    const w = Math.exp(-(dx * dx + dz * dz) / (2 * b.sigma * b.sigma)) + 0.02;
    tmpWeights[i] = w;
    sum += w;
  }
  for (let i = 0; i < BIOME_ZONES.length; i++) tmpWeights[i] /= sum;
  return tmpWeights;
}

/** Blend an arbitrary per-biome color choice by the local weights. */
export function blendBiomeColor(
  x: number,
  z: number,
  pick: (key: BiomeKey) => number,
  out = new THREE.Color(),
): THREE.Color {
  const w = biomeWeights(x, z);
  out.setRGB(0, 0, 0);
  const c = new THREE.Color();
  for (let i = 0; i < BIOME_ZONES.length; i++) {
    c.set(pick(BIOME_ZONES[i].key));
    out.r += c.r * w[i];
    out.g += c.g * w[i];
    out.b += c.b * w[i];
  }
  return out;
}

/** Blend a per-biome [r,g,b] tuple table by local weights into `out`. */
export function blendBiomeTint(
  x: number,
  z: number,
  table: Record<BiomeKey, [number, number, number]>,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const w = biomeWeights(x, z);
  out[0] = out[1] = out[2] = 0;
  for (let i = 0; i < BIOME_ZONES.length; i++) {
    const t = table[BIOME_ZONES[i].key];
    out[0] += t[0] * w[i];
    out[1] += t[1] * w[i];
    out[2] += t[2] * w[i];
  }
  return out;
}

/**
 * GLSL implementation of the same weight field, for the terrain shader.
 * Returns vec4 weights in BIOME_ZONES order (grassland, autumn, arid, tundra
 * — note: order follows the array above).
 */
export function biomeWeightsGLSL(): string {
  const zs = BIOME_ZONES;
  const term = (i: number) =>
    `exp(-(dot(p - vec2(${zs[i].x.toFixed(1)}, ${zs[i].z.toFixed(1)}), p - vec2(${zs[i].x.toFixed(1)}, ${zs[i].z.toFixed(1)}))) / ${(2 * zs[i].sigma * zs[i].sigma).toFixed(1)}) + 0.02`;
  return /* glsl */ `
  vec4 biomeWeights(vec2 p) {
    vec4 w = vec4(${term(0)}, ${term(1)}, ${term(2)}, ${term(3)});
    return w / (w.x + w.y + w.z + w.w);
  }
  `;
}
