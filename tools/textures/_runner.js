// Texture preview runner
// Usage: _runner.html?tex=grass

const params = new URLSearchParams(window.location.search);
const texName = params.get('tex') || 'grass';

document.getElementById('tex-name').textContent = texName;

let currentModule = null;
let currentSeed = Date.now();

async function loadTexture() {
  try {
    currentModule = await import(`./${texName}.js`);
    render();
  } catch (e) {
    document.getElementById('info').textContent = `Error loading ${texName}.js: ${e.message}`;
  }
}

function render() {
  if (!currentModule) return;

  const singleCanvas = document.getElementById('single');
  const tiledCanvas = document.getElementById('tiled');
  const singleCtx = singleCanvas.getContext('2d');
  const tiledCtx = tiledCanvas.getContext('2d');

  // Generate the texture
  const textureCanvas = currentModule.generate(256, currentSeed);

  // Draw single preview
  singleCtx.drawImage(textureCanvas, 0, 0);

  // Draw tiled preview (2x2)
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      tiledCtx.drawImage(textureCanvas, x * 256, y * 256);
    }
  }

  // Show info
  const info = currentModule.info || {};
  document.getElementById('info').textContent = JSON.stringify({
    name: texName,
    seed: currentSeed,
    ...info
  }, null, 2);
}

window.regenerate = function() {
  currentSeed = Date.now();
  render();
};

window.download = function() {
  const canvas = document.getElementById('single');
  const link = document.createElement('a');
  link.download = `${texName}_${currentSeed}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
};

loadTexture();
