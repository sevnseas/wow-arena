/**
 * Atmosphere & post-processing — pushes the renderer toward the WoW look:
 *
 *   • Warm key / cool sky-fill light philosophy (Blizzard art-direction):
 *     https://80.lv/articles/002mrs-crafting-a-wow-diorama-textures-painting-lighting
 *   • Painterly saturation + soft bloom (saturated palettes per zone):
 *     https://cherielily.com/the-warcraft-art-style-breakdown-why-wow-still-looks-good-after-all-these-years/
 *
 * Implementation:
 *   1. EffectComposer chain — RenderPass → UnrealBloomPass → color-grade
 *      shader (saturation + warmth + S-curve contrast + tinted shadows) →
 *      VignetteShader → OutputPass.
 *   2. Ambient motes — slow-drifting additive particle field that catches
 *      sun-coloured highlights, like dust/pollen in a sun shaft.
 *   3. setSize() forwarded so canvas resize keeps the composer in sync.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';

/**
 * Painterly color grade — gentle S-curve contrast, saturation lift, warm
 * highlights / cool shadows (the canonical Blizzard hue-shift). Cheap full-
 * screen pass over the bloomed buffer.
 */
const COLOR_GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSaturation: { value: 1.18 },
    uContrast: { value: 1.05 },
    uWarmth: { value: 0.05 },          // shifts highlights warmer
    uShadowCool: { value: 0.04 },      // shifts shadows cooler
    uExposure: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uWarmth;
    uniform float uShadowCool;
    uniform float uExposure;
    varying vec2 vUv;

    vec3 saturate(vec3 c, float amt) {
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      return mix(vec3(l), c, amt);
    }

    // Mild S-curve: lifts midtones a touch, deepens darks, rolls highlights.
    vec3 sCurve(vec3 c, float k) {
      return mix(c, smoothstep(vec3(0.0), vec3(1.0), c), k - 1.0);
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 col = src.rgb * uExposure;

      // Hue shift: warmth into highlights, coolness into shadows.
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      vec3 warm = vec3(uWarmth, uWarmth * 0.5, -uWarmth * 0.4);
      vec3 cool = vec3(-uShadowCool, -uShadowCool * 0.3, uShadowCool);
      col += warm * smoothstep(0.4, 0.95, lum);
      col += cool * (1.0 - smoothstep(0.0, 0.45, lum));

      col = sCurve(col, uContrast);
      col = saturate(col, uSaturation);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), src.a);
    }
  `,
};

export interface AtmosphereOptions {
  bloomStrength?: number;
  bloomRadius?: number;
  bloomThreshold?: number;
  saturation?: number;
  contrast?: number;
  warmth?: number;
  shadowCool?: number;
  vignette?: number;
}

export class Atmosphere {
  composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private vignette: ShaderPass;
  // Floating motes
  private motes: THREE.Points;
  private moteVelocities: Float32Array;
  private moteBounds: THREE.Box3;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    opts: AtmosphereOptions = {},
  ) {

    const size = new THREE.Vector2();
    renderer.getSize(size);

    this.composer = new EffectComposer(renderer);
    this.composer.setSize(size.x, size.y);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    this.composer.addPass(new RenderPass(scene, camera));

    // Subtle bloom only on the brightest pixels (sun glints, white sprites).
    // High threshold + low strength avoids the blurry "everything glows"
    // look that wrecks the painterly grass.
    // Half-resolution bloom: the pass is a stack of blurs, so feeding it a
    // smaller buffer is visually indistinguishable and much cheaper.
    this.bloom = new UnrealBloomPass(
      size.clone().multiplyScalar(0.5),
      opts.bloomStrength ?? 0.28,
      opts.bloomRadius ?? 0.45,
      opts.bloomThreshold ?? 0.88,
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(COLOR_GRADE_SHADER);
    this.grade.uniforms.uSaturation.value = opts.saturation ?? 1.17;
    this.grade.uniforms.uContrast.value = opts.contrast ?? 1.04;
    this.grade.uniforms.uWarmth.value = opts.warmth ?? 0.035;
    // Keep shadows close to neutral — cold-blue shadows read un-WoW.
    this.grade.uniforms.uShadowCool.value = opts.shadowCool ?? 0.008;
    this.grade.uniforms.uExposure.value = 1.0;
    this.composer.addPass(this.grade);

    // Vignette: VignetteShader's darkness=1 is no darkening; higher
    // brightens corners and lower darkens. Use a slightly soft frame.
    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.1;
    this.vignette.uniforms.darkness.value = opts.vignette ?? 1.1;
    this.composer.addPass(this.vignette);

    this.composer.addPass(new OutputPass());

    // ----- ambient motes -----
    const COUNT = 240;
    const positions = new Float32Array(COUNT * 3);
    this.moteVelocities = new Float32Array(COUNT * 3);
    this.moteBounds = new THREE.Box3(
      new THREE.Vector3(-25, 0.5, -25),
      new THREE.Vector3(25, 6.5, 25),
    );
    for (let i = 0; i < COUNT; i++) {
      const i3 = i * 3;
      positions[i3 + 0] = THREE.MathUtils.lerp(this.moteBounds.min.x, this.moteBounds.max.x, Math.random());
      positions[i3 + 1] = THREE.MathUtils.lerp(this.moteBounds.min.y, this.moteBounds.max.y, Math.random());
      positions[i3 + 2] = THREE.MathUtils.lerp(this.moteBounds.min.z, this.moteBounds.max.z, Math.random());
      // Drift: very slow, mostly horizontal with a touch of upward float.
      this.moteVelocities[i3 + 0] = (Math.random() - 0.5) * 0.25;
      this.moteVelocities[i3 + 1] = Math.random() * 0.08 + 0.02;
      this.moteVelocities[i3 + 2] = (Math.random() - 0.5) * 0.25;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.09,
      color: 0xfff4c8,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.name = 'AmbientMotes';
    this.motes.userData.editorIgnore = true;
    scene.add(this.motes);
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.bloom.setSize(width * 0.5, height * 0.5);
  }

  /**
   * Per-frame: advance motes, wrap them inside the ambient bounds, then
   * render through the composer chain.
   */
  render(delta: number): void {
    const pos = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const min = this.moteBounds.min, max = this.moteBounds.max;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i + 0] += this.moteVelocities[i + 0] * delta;
      arr[i + 1] += this.moteVelocities[i + 1] * delta;
      arr[i + 2] += this.moteVelocities[i + 2] * delta;
      if (arr[i + 1] > max.y) arr[i + 1] = min.y;
      if (arr[i + 0] < min.x) arr[i + 0] = max.x;
      if (arr[i + 0] > max.x) arr[i + 0] = min.x;
      if (arr[i + 2] < min.z) arr[i + 2] = max.z;
      if (arr[i + 2] > max.z) arr[i + 2] = min.z;
    }
    pos.needsUpdate = true;

    // Keep motes near the player so we don't waste budget far away.
    // (Caller can move this group too.)

    this.composer.render(delta);
  }
}
