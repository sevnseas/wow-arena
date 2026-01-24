// Grass texture generator
// Procedural tileable grass with noise variation and blade strokes

// === PARAMETERS (edit these) ===
const PARAMS = {
  baseColor: [61, 92, 61],      // Base green RGB
  colorVariation: 25,           // How much color varies
  bladeCount: 800,              // Number of grass blades
  bladeLengthMin: 8,
  bladeLengthMax: 20,
  bladeWidth: 1.5,
  dirtSpeckCount: 50,
  dirtColor: [80, 65, 50],
  noiseScale: 0.02,
  noiseStrength: 20
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
  const rand = seededRandom(seed);
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

      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, PARAMS.baseColor[0] + variation));
      data[i + 1] = Math.max(0, Math.min(255, PARAMS.baseColor[1] + variation));
      data[i + 2] = Math.max(0, Math.min(255, PARAMS.baseColor[2] + variation));
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  // Draw grass blades
  for (let i = 0; i < PARAMS.bladeCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const length = PARAMS.bladeLengthMin + rand() * (PARAMS.bladeLengthMax - PARAMS.bladeLengthMin);
    const angle = -Math.PI / 2 + (rand() - 0.5) * 0.6; // Mostly upward
    const curve = (rand() - 0.5) * 0.3;

    // Color variation per blade
    const colorShift = (rand() - 0.5) * PARAMS.colorVariation;
    const r = Math.max(0, Math.min(255, PARAMS.baseColor[0] + colorShift - 10));
    const g = Math.max(0, Math.min(255, PARAMS.baseColor[1] + colorShift + 15));
    const b = Math.max(0, Math.min(255, PARAMS.baseColor[2] + colorShift - 10));

    ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.lineWidth = PARAMS.bladeWidth;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(x, y);

    // Curved blade
    const midX = x + Math.cos(angle) * length * 0.5 + curve * 10;
    const midY = y + Math.sin(angle) * length * 0.5;
    const endX = x + Math.cos(angle + curve) * length;
    const endY = y + Math.sin(angle + curve) * length;

    ctx.quadraticCurveTo(midX, midY, endX, endY);
    ctx.stroke();

    // Wrap for tiling
    if (x < PARAMS.bladeLengthMax) {
      ctx.beginPath();
      ctx.moveTo(x + size, y);
      ctx.quadraticCurveTo(midX + size, midY, endX + size, endY);
      ctx.stroke();
    }
    if (x > size - PARAMS.bladeLengthMax) {
      ctx.beginPath();
      ctx.moveTo(x - size, y);
      ctx.quadraticCurveTo(midX - size, midY, endX - size, endY);
      ctx.stroke();
    }
  }

  // Dirt specks
  for (let i = 0; i < PARAMS.dirtSpeckCount; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1 + rand() * 2;

    ctx.fillStyle = `rgb(${PARAMS.dirtColor[0]}, ${PARAMS.dirtColor[1]}, ${PARAMS.dirtColor[2]})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
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
