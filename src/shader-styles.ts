import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export type ShaderStyle = 'default' | 'cel' | 'wow';

// ── Cel-shade pass ────────────────────────────────────────────────────────────
// Quantises luminance into hard bands and draws black Sobel outlines.
const CelShader = {
  uniforms: {
    tDiffuse:   { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    bands:      { value: 4.0 },
    outlineStr: { value: 0.6 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float bands;
    uniform float outlineStr;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299,0.587,0.114)); }

    void main() {
      vec2 px = 1.0 / resolution;
      vec4 col = texture2D(tDiffuse, vUv);

      // Hard colour bands on luma
      float l = luma(col.rgb);
      float banded = floor(l * bands) / bands;
      col.rgb *= banded / max(l, 0.001);

      // Sobel on luma for outlines
      float tl = luma(texture2D(tDiffuse, vUv + vec2(-px.x,  px.y)).rgb);
      float tm = luma(texture2D(tDiffuse, vUv + vec2(    0,  px.y)).rgb);
      float tr = luma(texture2D(tDiffuse, vUv + vec2( px.x,  px.y)).rgb);
      float ml = luma(texture2D(tDiffuse, vUv + vec2(-px.x,     0)).rgb);
      float mr = luma(texture2D(tDiffuse, vUv + vec2( px.x,     0)).rgb);
      float bl = luma(texture2D(tDiffuse, vUv + vec2(-px.x, -px.y)).rgb);
      float bm = luma(texture2D(tDiffuse, vUv + vec2(     0,-px.y)).rgb);
      float br = luma(texture2D(tDiffuse, vUv + vec2( px.x, -px.y)).rgb);

      float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
      float gy = -tl - 2.0*tm - tr + bl + 2.0*bm + br;
      float edge = clamp(sqrt(gx*gx + gy*gy) * outlineStr * 8.0, 0.0, 1.0);

      col.rgb = mix(col.rgb, vec3(0.0), edge);
      gl_FragColor = col;
    }
  `,
};

// ── WoW-style pass ────────────────────────────────────────────────────────────
// Softer 3-band toon shading, warm saturation boost, and coloured outlines.
const WowShader = {
  uniforms: {
    tDiffuse:   { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299,0.587,0.114)); }

    vec3 toon3(vec3 c) {
      float l = luma(c);
      float t = l < 0.28 ? 0.15
              : l < 0.62 ? 0.55
              :             0.95;
      return c * (t / max(l, 0.001));
    }

    // Warm-shift and saturate like WoW's older renderer
    vec3 wowColour(vec3 c) {
      // Slight warm tint
      c *= vec3(1.08, 1.02, 0.92);
      // Saturation boost
      float g = luma(c);
      c = mix(vec3(g), c, 1.35);
      return clamp(c, 0.0, 1.0);
    }

    void main() {
      vec2 px = 1.0 / resolution;
      vec4 col = texture2D(tDiffuse, vUv);

      col.rgb = toon3(col.rgb);
      col.rgb = wowColour(col.rgb);

      // Coloured outline: dark purple/blue like WoW's stylised look
      float tl = luma(texture2D(tDiffuse, vUv + vec2(-px.x,  px.y)).rgb);
      float tm = luma(texture2D(tDiffuse, vUv + vec2(    0,  px.y)).rgb);
      float tr = luma(texture2D(tDiffuse, vUv + vec2( px.x,  px.y)).rgb);
      float ml = luma(texture2D(tDiffuse, vUv + vec2(-px.x,     0)).rgb);
      float mr = luma(texture2D(tDiffuse, vUv + vec2( px.x,     0)).rgb);
      float bl = luma(texture2D(tDiffuse, vUv + vec2(-px.x, -px.y)).rgb);
      float bm = luma(texture2D(tDiffuse, vUv + vec2(     0,-px.y)).rgb);
      float br = luma(texture2D(tDiffuse, vUv + vec2( px.x, -px.y)).rgb);

      float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
      float gy = -tl - 2.0*tm - tr + bl + 2.0*bm + br;
      float edge = clamp(sqrt(gx*gx + gy*gy) * 6.0, 0.0, 1.0);

      vec3 outlineCol = vec3(0.08, 0.04, 0.18); // deep indigo
      col.rgb = mix(col.rgb, outlineCol, edge * 0.85);

      gl_FragColor = col;
    }
  `,
};

// ── ShaderStyleManager ────────────────────────────────────────────────────────
export class ShaderStyleManager {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private celPass: ShaderPass;
  private wowPass: ShaderPass;
  private currentStyle: ShaderStyle = 'default';

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.celPass = new ShaderPass(CelShader);
    this.celPass.enabled = false;
    this.composer.addPass(this.celPass);

    this.wowPass = new ShaderPass(WowShader);
    this.wowPass.enabled = false;
    this.composer.addPass(this.wowPass);
  }

  setStyle(style: ShaderStyle) {
    this.currentStyle = style;
    this.celPass.enabled = style === 'cel';
    this.wowPass.enabled = style === 'wow';
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
    const res = new THREE.Vector2(w, h);
    (this.celPass.uniforms as any).resolution.value = res;
    (this.wowPass.uniforms as any).resolution.value = res;
  }

  render() {
    this.composer.render();
  }

  getStyle(): ShaderStyle { return this.currentStyle; }
}

// ── Dropdown UI ───────────────────────────────────────────────────────────────
export function createShaderDropdown(manager: ShaderStyleManager): void {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    z-index: 200; display: flex; align-items: center; gap: 8px;
    background: rgba(0,0,0,0.75); border: 1px solid #555;
    border-radius: 8px; padding: 6px 14px; font-family: 'Segoe UI', Arial, sans-serif;
  `;

  const label = document.createElement('span');
  label.textContent = 'Style:';
  label.style.cssText = 'color:#aaa; font-size:12px;';

  const select = document.createElement('select');
  select.style.cssText = `
    background: #222; color: #fff; border: 1px solid #555;
    border-radius: 4px; padding: 2px 6px; font-size: 13px; cursor: pointer;
  `;

  const options: { value: ShaderStyle; label: string }[] = [
    { value: 'default', label: 'Default (PBR)' },
    { value: 'cel',     label: 'Cel Shade' },
    { value: 'wow',     label: 'World of Warcraft' },
  ];

  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    select.appendChild(el);
  }

  select.addEventListener('change', () => {
    manager.setStyle(select.value as ShaderStyle);
  });

  wrap.appendChild(label);
  wrap.appendChild(select);
  document.body.appendChild(wrap);
}
