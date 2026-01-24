// Ceramic gray texture generator
// Neutral gray with subtle speckle, faint cracks, edge darkening

// === PARAMETERS (edit these) ===
const PARAMS = {
  baseColor: [140, 135, 130],   // Base gray RGB
  speckleCount: 400,
  speckleSize: 1.5,
  speckleVariation: 30,
  crackCount: 8,
  crackColor: [100, 95, 90],
  crackWidth: 0.8,
  edgeDarkening: 0.15,          // How much edges darken (0-1)
  noiseScale: 0.03,
  noiseStrength: 15
};

export const info = { ...PARAMS };

// Simple seeded random
function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Value noise
function noise2D(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const hash = (a, b) => {
    const n = a + b * 57 + seed;
    return seededRandom(n * 13)();
  };

  const v00 = hash(xi, yi);
  const v10 = hash(xi + 1, yi);
  const v01 = hash(xi, yi + 1);
  const v11 = hash(xi + 1, yi + 1);

  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);

  return v00 * (1 - sx) * (1 - sy) +
         v10 * sx * (1 - sy) +
         v01 * (1 - sx) * sy +
         v11 * sx * sy;
}

export function generate(size, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = seededRandom(seed);

  // Fill base color with noise variation
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise2D(x * PARAMS.noiseScale, y * PARAMS.noiseScale, seed);
      const variation = (n - 0.5) * PARAMS.noiseStrength;

      // Edge darkening (for depth when tiled)
      const edgeX = Math.min(x, size - x) / (size * 0.2);
      const edgeY = Math.min(y, size - y) / (size * 0.2);
      const edgeFactor = 1 - Math.max(0, 1 - Math.min(edgeX, edgeY)) * PARAMS.edgeDarkening;

      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, (PARAMS.baseColor[0] + variation) * edgeFactor));
      data[i + 1] = Math.max(0, Math.min(255, (PARAMS.baseColor[1] + variation) * edgeFactor));
      data[i + 2] = Math.max(0, Math.min(255, (PARAMS.baseColor[2] + variation) * edgeFactor));
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  // Speckles
  for (let i = 0; i < PARAMS.speckleCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.5 + rand() * PARAMS.speckleSize;
    const colorShift = (rand() - 0.5) * PARAMS.speckleVariation;

    const sr = Math.max(0, Math.min(255, PARAMS.baseColor[0] + colorShift));
    const sg = Math.max(0, Math.min(255, PARAMS.baseColor[1] + colorShift));
    const sb = Math.max(0, Math.min(255, PARAMS.baseColor[2] + colorShift));

    ctx.fillStyle = `rgb(${sr}, ${sg}, ${sb})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Faint crack/vein lines
  ctx.strokeStyle = `rgba(${PARAMS.crackColor[0]}, ${PARAMS.crackColor[1]}, ${PARAMS.crackColor[2]}, 0.3)`;
  ctx.lineWidth = PARAMS.crackWidth;

  for (let i = 0; i < PARAMS.crackCount; i++) {
    let x = rand() * size;
    let y = rand() * size;
    const segments = 3 + Math.floor(rand() * 4);

    ctx.beginPath();
    ctx.moveTo(x, y);

    for (let j = 0; j < segments; j++) {
      const angle = rand() * Math.PI * 2;
      const length = 15 + rand() * 30;
      x += Math.cos(angle) * length;
      y += Math.sin(angle) * length;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  return canvas;
}

// Three.js helper
export function createTexture(THREE, size = 256, seed = Date.now()) {
  const canvas = generate(size, seed);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}
