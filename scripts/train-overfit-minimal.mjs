import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(new URL(import.meta.url).pathname).split('/').slice(0, -1).join('/');
const policyDir = resolve(here, 'public', 'policies-rl4');

console.log('=== ULTRA-MINIMAL OVERFITTING ===\n');
console.log('Creating a network that ONLY learns: if rabbit is here, move there\n');

// Create an absurdly simple network: just memorize the best action for each relative position
const positions = [];
const actions = [];

// Generate training data: for different rabbit positions, what's the best action?
for (let angle = 0; angle < 360; angle += 45) {
  const rad = (angle * Math.PI) / 180;
  for (let dist = 1; dist <= 3; dist += 0.5) {
    const dx = Math.cos(rad) * dist;
    const dz = Math.sin(rad) * dist;

    // Determine best action based on rabbit angle
    let bestAction;
    if (Math.abs(angle) < 45 || Math.abs(angle) > 315) {
      bestAction = 0;  // Forward
    } else if (angle < 135) {
      bestAction = 5;  // Forward-Right
    } else if (angle < 225) {
      bestAction = 1;  // Back
    } else {
      bestAction = 4;  // Forward-Left
    }

    positions.push({ dx: dx / 3, dz: dz / 3 });
    actions.push(bestAction);
  }
}

console.log(`Generated ${positions.length} training samples\n`);

// Simple linear mapping: multiply position by weights to get action logits
const weights = new Float32Array(8 * 2);  // 2 inputs (dx, dz) -> 8 outputs
for (let i = 0; i < weights.length; i++) {
  weights[i] = (Math.random() - 0.5) * 2;
}

const bias = new Float32Array(8);
for (let i = 0; i < bias.length; i++) {
  bias[i] = 0;
}

// Training loop
const lr = 0.1;
console.log('Training...\n');

for (let epoch = 0; epoch < 100; epoch++) {
  let correct = 0;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const targetAction = actions[i];

    // Forward pass: compute logits
    const logits = new Float32Array(8);
    for (let a = 0; a < 8; a++) {
      logits[a] = pos.dx * weights[a * 2 + 0] + pos.dz * weights[a * 2 + 1] + bias[a];
    }

    // Softmax
    let maxL = Math.max(...logits);
    const exp = new Float32Array(8);
    let sumExp = 0;
    for (let a = 0; a < 8; a++) {
      exp[a] = Math.exp(logits[a] - maxL);
      sumExp += exp[a];
    }
    const probs = new Float32Array(8);
    for (let a = 0; a < 8; a++) {
      probs[a] = exp[a] / sumExp;
    }

    // Check if correct
    const predictedAction = probs.indexOf(Math.max(...probs));
    if (predictedAction === targetAction) correct++;

    // Backward pass: simple gradient update
    for (let a = 0; a < 8; a++) {
      const target = a === targetAction ? 1 : 0;
      const error = probs[a] - target;
      weights[a * 2 + 0] -= lr * error * pos.dx;
      weights[a * 2 + 1] -= lr * error * pos.dz;
      bias[a] -= lr * error;
    }
  }

  const accuracy = (correct / positions.length * 100).toFixed(1);
  if (epoch % 10 === 0) {
    console.log(`Epoch ${epoch.toString().padStart(3)}: accuracy ${accuracy}%`);
  }
}

console.log('\n=== RESULT ===');

// Final test
let finalCorrect = 0;
for (let i = 0; i < positions.length; i++) {
  const pos = positions[i];
  const targetAction = actions[i];

  const logits = new Float32Array(8);
  for (let a = 0; a < 8; a++) {
    logits[a] = pos.dx * weights[a * 2 + 0] + pos.dz * weights[a * 2 + 1] + bias[a];
  }

  let maxL = Math.max(...logits);
  const exp = new Float32Array(8);
  let sumExp = 0;
  for (let a = 0; a < 8; a++) {
    exp[a] = Math.exp(logits[a] - maxL);
    sumExp += exp[a];
  }

  let predictedAction = 0;
  for (let a = 0; a < 8; a++) {
    if (exp[a] / sumExp > exp[predictedAction] / sumExp) predictedAction = a;
  }

  if (predictedAction === targetAction) finalCorrect++;
}

const finalAccuracy = (finalCorrect / positions.length * 100).toFixed(1);
console.log(`Final accuracy: ${finalAccuracy}% (target: 100%)`);

if (finalAccuracy >= 80) {
  console.log('✓ Network learned direction-to-action mapping\n');

  // Now create a policy object that wraps this minimal model
  const policyObj = {
    cfg: {
      version: 2,
      hidden: 2,
      lr: 0.1,
      baselineEMA: 0.9,
      entropyCoef: 0.0,
    },
    W1: Array.from(weights),
    b1: Array.from(bias),
    W2: Array.from(new Float32Array(8)),  // Not used
    b2: Array.from(new Float32Array(8)),
    baseline: 0,
  };

  writeFileSync(resolve(policyDir, 'wolf.json'), JSON.stringify(policyObj));

  const meta = {
    archetype: 'wolf',
    trainedAt: new Date().toISOString(),
    trainingType: 'minimal-direction-overfit',
    episodes: 1,
    accuracy: parseFloat(finalAccuracy),
    policyConfig: {
      version: 2,
      hidden: 2,
      lr: 0.1,
      baselineEMA: 0.9,
      entropyCoef: 0.0,
    },
  };

  writeFileSync(resolve(policyDir, 'wolf.meta.json'), JSON.stringify(meta, null, 2));

  console.log('Saved minimal overfitted policy');
  console.log('Ready for scenario test: http://localhost:3000/threejs-arena/scenarios.html?s=wolf-vs-rabbit');
} else {
  console.log('⚠ Learning failed, accuracy too low');
}
