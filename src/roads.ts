/**
 * Gravel roads — ground-hugging ribbons (same construction as the river
 * strips) that run from the central clearing out to each themed region and
 * each biome encampment. Procedural speckle in the shader gives a packed-
 * gravel read without texture assets.
 */

import * as THREE from 'three';
import { REGION_FOOTPRINTS } from './regions';
import { BIOME_ZONES, biomeCampPosition } from './biomes';

type HeightFn = (x: number, z: number) => number;

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build one road ribbon from `from` to `to`, meandering gently. */
function buildRoadRibbon(
  rng: () => number,
  from: THREE.Vector2,
  to: THREE.Vector2,
  width: number,
  height: HeightFn,
  material: THREE.Material,
): THREE.Mesh {
  const dir = new THREE.Vector2().subVectors(to, from);
  const perp = new THREE.Vector2(-dir.y, dir.x).normalize();
  const CONTROL = 5;
  const controls: THREE.Vector3[] = [];
  for (let i = 0; i <= CONTROL; i++) {
    const t = i / CONTROL;
    const px = from.x + dir.x * t;
    const pz = from.y + dir.y * t;
    const sway = Math.sin(t * Math.PI) * (rng() - 0.5) * dir.length() * 0.18;
    controls.push(new THREE.Vector3(px + perp.x * sway, 0, pz + perp.y * sway));
  }
  const curve = new THREE.CatmullRomCurve3(controls, false, 'catmullrom', 0.5);

  const SEG = 64;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const Y_OFFSET = 0.07;

  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const pos = curve.getPoint(t);
    const tan = curve.getTangent(t);
    const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
    // Width tapers at both ends so the road feathers into the grass, with a
    // slight organic wobble along its length.
    const ends = Math.min(1, Math.min(t, 1 - t) * 6);
    const w = width * (0.5 + 0.5 * ends) * (0.92 + 0.08 * Math.sin(t * 23.0));

    const left = pos.clone().addScaledVector(side, -w * 0.5);
    const right = pos.clone().addScaledVector(side, w * 0.5);

    positions.push(left.x, height(left.x, left.z) + Y_OFFSET, left.z);
    positions.push(right.x, height(right.x, right.z) + Y_OFFSET, right.z);
    uvs.push(0, t * 30, 1, t * 30);

    if (i < SEG) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.name = 'GravelRoad';
  return mesh;
}

/**
 * Road network: center clearing → each themed region + each biome camp.
 */
export function createRoads(height: HeightFn): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Roads';

  const material = new THREE.MeshStandardMaterial({
    color: 0x9a8d74,
    roughness: 1.0,
    metalness: 0,
  });
  // Procedural gravel: high-frequency speckle + medium tonal patches, plus
  // worn wheel-rut darkening along the center line (uv.x ≈ 0.5).
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vRoadWorld;\n varying vec2 vRoadUv;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n vRoadUv = uv;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vRoadWorld;
        varying vec2 vRoadUv;
        float rdhash(vec2 p) {
          p = fract(p * vec2(127.1, 311.7));
          p += dot(p, p + 34.5);
          return fract(p.x * p.y);
        }
        float rdnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(rdhash(i), rdhash(i + vec2(1, 0)), u.x),
                     mix(rdhash(i + vec2(0, 1)), rdhash(i + vec2(1, 1)), u.x), u.y);
        }
        `,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        /* glsl */ `
        vec4 diffuseColor = vec4( diffuse, opacity );
        {
          // Gravel speckle: individual pebbles at high frequency.
          float pebble = rdhash(floor(vRoadWorld.xz * 9.0));
          float tone = rdnoise(vRoadWorld.xz * 0.6);
          diffuseColor.rgb *= 0.80 + pebble * 0.32 + tone * 0.12;
          // Wheel ruts: two darker worn lines either side of the crown.
          float lane = abs(vRoadUv.x - 0.5);
          float rut = smoothstep(0.10, 0.16, lane) * (1.0 - smoothstep(0.24, 0.34, lane));
          diffuseColor.rgb *= 1.0 - rut * 0.16;
          // Edges blend toward earth so the road feathers into grass.
          float edge = smoothstep(0.34, 0.5, lane);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.82, 0.62), edge);
        }
        `,
      );
  };

  const rng = mulberry32(0x60AD5);

  const destinations: Array<{ x: number; z: number }> = [
    ...REGION_FOOTPRINTS.map(f => ({ x: f.x, z: f.z })),
    ...BIOME_ZONES.filter(z => z.key !== 'grassland').map(z => biomeCampPosition(z)),
  ];

  for (const d of destinations) {
    // Start the road at the rim of the central clearing, not dead center.
    const dir = new THREE.Vector2(d.x, d.z).normalize();
    const from = dir.clone().multiplyScalar(10);
    const to = new THREE.Vector2(d.x, d.z).addScaledVector(dir, -4);
    group.add(buildRoadRibbon(rng, from, to, 2.6, height, material));
  }

  return group;
}
