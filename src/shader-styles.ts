import * as THREE from 'three';

export type ShaderStyle = 'default' | 'wow';

// ── Gradient maps ─────────────────────────────────────────────────────────────

function makeGradientMap(steps: number[]): THREE.DataTexture {
  // steps: luminance values 0-255 for each band
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => { data[i*4]=v; data[i*4+1]=v; data[i*4+2]=v; data[i*4+3]=255; });
  const tex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// 3-step WoW-ish gradient: shadow / midtone / highlight
const wowGradient = makeGradientMap([40, 140, 255]);

// ── Inverted hull outline ─────────────────────────────────────────────────────

const OUTLINE_TAG = '__wow_outline__';

function addHullOutline(mesh: THREE.Mesh, color = 0x1a0f2e, thickness = 0.03): void {
  if ((mesh as any)[OUTLINE_TAG]) return;
  const outlineMat = new THREE.MeshBasicMaterial({
    color,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const outline = new THREE.Mesh(mesh.geometry, outlineMat);
  outline.scale.setScalar(1 + thickness);
  outline.name = OUTLINE_TAG;
  mesh.add(outline);
  (mesh as any)[OUTLINE_TAG] = outline;
}

function removeHullOutline(mesh: THREE.Mesh): void {
  const outline = (mesh as any)[OUTLINE_TAG] as THREE.Mesh | undefined;
  if (!outline) return;
  mesh.remove(outline);
  outline.material instanceof THREE.Material && outline.material.dispose();
  delete (mesh as any)[OUTLINE_TAG];
}

// ── Material conversion ───────────────────────────────────────────────────────

const ORIGINAL_MAT_TAG = '__orig_mat__';

function toToon(src: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial): THREE.MeshToonMaterial {
  const color = (src as any).color ?? new THREE.Color(0x888888);
  const map   = (src as any).map   ?? null;
  return new THREE.MeshToonMaterial({ color, map, gradientMap: wowGradient });
}

function applyWow(scene: THREE.Scene): void {
  scene.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material;
    if (!mat || (obj as any)[ORIGINAL_MAT_TAG]) return; // skip already converted

    const mats = Array.isArray(mat) ? mat : [mat];
    const toons = mats.map(m => {
      if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshBasicMaterial) {
        return toToon(m as any);
      }
      return m; // keep as-is (MeshToonMaterial already, etc.)
    });

    (obj as any)[ORIGINAL_MAT_TAG] = mat;
    obj.material = Array.isArray(mat) ? toons : toons[0];

    // Outline on solid geometry (skip ground plane — too flat)
    if (obj.name !== 'Ground') {
      addHullOutline(obj);
    }
  });
}

function revertWow(scene: THREE.Scene): void {
  scene.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return;
    const orig = (obj as any)[ORIGINAL_MAT_TAG];
    if (!orig) return;

    // Dispose toon material
    const cur = Array.isArray(obj.material) ? obj.material : [obj.material];
    cur.forEach(m => m.dispose());

    obj.material = orig;
    delete (obj as any)[ORIGINAL_MAT_TAG];
    removeHullOutline(obj);
  });
}

// ── Fog ───────────────────────────────────────────────────────────────────────

type FogState = { fog: THREE.FogBase | null };

function applyWowFog(scene: THREE.Scene, state: FogState): void {
  state.fog = scene.fog;
  // Deep purple/blue like Nagrand or Blade's Edge at dusk
  scene.fog = new THREE.FogExp2(0x1a0f2e, 0.018);
  scene.background = new THREE.Color(0x1a0f2e);
}

function revertFog(scene: THREE.Scene, state: FogState): void {
  scene.fog = state.fog;
  scene.background = new THREE.Color(0x1a1a2e);
}

// ── Public manager ────────────────────────────────────────────────────────────

export class ShaderStyleManager {
  private current: ShaderStyle = 'default';
  private fogState: FogState = { fog: null };

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {}

  setStyle(style: ShaderStyle): void {
    if (style === this.current) return;

    // Revert old
    if (this.current === 'wow') {
      revertWow(this.scene);
      revertFog(this.scene, this.fogState);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    }

    // Apply new
    if (style === 'wow') {
      applyWow(this.scene);
      applyWowFog(this.scene, this.fogState);
      // Flat tone mapping keeps toon colours punchy (no film-grain crush)
      this.renderer.toneMapping = THREE.NoToneMapping;
    }

    this.current = style;
  }

  getStyle(): ShaderStyle { return this.current; }

  // No-op — kept so main.ts call signature stays compatible
  setSize(_w: number, _h: number): void {}
  render(): void {} // main.ts still calls renderer.render directly
}

// ── Dropdown UI ───────────────────────────────────────────────────────────────

export function createShaderDropdown(manager: ShaderStyleManager): void {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position:fixed; top:16px; left:50%; transform:translateX(-50%);
    z-index:200; display:flex; align-items:center; gap:8px;
    background:rgba(0,0,0,0.72); border:1px solid #444;
    border-radius:8px; padding:5px 14px;
    font-family:'Segoe UI',Arial,sans-serif; pointer-events:all;
  `;

  const label = document.createElement('span');
  label.textContent = 'Style:';
  label.style.cssText = 'color:#aaa;font-size:12px;user-select:none;';

  const select = document.createElement('select');
  select.style.cssText = `
    background:#1a1a2e; color:#e8d89a; border:1px solid #555;
    border-radius:4px; padding:2px 8px; font-size:13px; cursor:pointer;
    font-family:inherit;
  `;

  const options: { value: ShaderStyle; label: string }[] = [
    { value: 'default', label: 'Default (PBR)' },
    { value: 'wow',     label: 'World of Warcraft' },
  ];
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    select.appendChild(el);
  }

  select.value = manager.getStyle();
  select.addEventListener('change', () => manager.setStyle(select.value as ShaderStyle));

  wrap.appendChild(label);
  wrap.appendChild(select);
  document.body.appendChild(wrap);
}
