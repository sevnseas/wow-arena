/**
 * Shared-parameter policy for Tier 1.
 *
 * Architecture: 7-dim state → hidden (tanh) → logits over 5 intentions.
 * One Policy instance is shared across every entity of an archetype-group
 * (e.g. all wolves use the predator policy). Per-entity diversity comes
 * from `personalityBias` added to logits and a `temperature` divisor on
 * the softmax — exactly as described in entity-policies.md §2.
 *
 * Trained with REINFORCE: we keep gradients flat (no autograd), accumulate
 * ∂logπ/∂θ * advantage per step, then SGD-update at episode end.
 */

import { INTENT_COUNT, STATE_DIM } from './types';
import type { Rng } from './rng';

export interface PolicyConfig {
  hidden: number;
  lr: number;
  /** Reward-baseline EMA factor (0..1). Higher = slower-moving baseline. */
  baselineEMA: number;
  /** Entropy bonus coefficient — encourages exploration. */
  entropyCoef: number;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  hidden: 24,
  lr: 0.01,
  baselineEMA: 0.95,
  entropyCoef: 0.01,
};

export class Policy {
  readonly cfg: PolicyConfig;
  W1: Float32Array; b1: Float32Array;
  W2: Float32Array; b2: Float32Array;
  baseline = 0;

  constructor(cfg: Partial<PolicyConfig> = {}, rng?: Rng) {
    this.cfg = { ...DEFAULT_POLICY_CONFIG, ...cfg };
    const h = this.cfg.hidden;
    this.W1 = new Float32Array(STATE_DIM * h);
    this.b1 = new Float32Array(h);
    this.W2 = new Float32Array(h * INTENT_COUNT);
    this.b2 = new Float32Array(INTENT_COUNT);
    const init = (arr: Float32Array, fanIn: number) => {
      const scale = Math.sqrt(2 / fanIn);
      for (let i = 0; i < arr.length; i++) {
        arr[i] = (rng ? rng.gauss() : (Math.random() * 2 - 1)) * scale;
      }
    };
    init(this.W1, STATE_DIM);
    init(this.W2, this.cfg.hidden);
  }

  /** Forward pass. Returns (probs, hidden) — both needed for backprop. */
  forward(state: Float32Array, biasAdd?: Float32Array, temperature = 1.0): {
    probs: Float32Array;
    logits: Float32Array;
    hidden: Float32Array;
  } {
    const h = this.cfg.hidden;
    const hidden = new Float32Array(h);
    for (let j = 0; j < h; j++) {
      let s = this.b1[j];
      for (let i = 0; i < STATE_DIM; i++) s += state[i] * this.W1[j * STATE_DIM + i];
      hidden[j] = Math.tanh(s);
    }
    const logits = new Float32Array(INTENT_COUNT);
    for (let k = 0; k < INTENT_COUNT; k++) {
      let s = this.b2[k];
      for (let j = 0; j < h; j++) s += hidden[j] * this.W2[k * h + j];
      if (biasAdd) s += biasAdd[k];
      logits[k] = s / Math.max(0.05, temperature);
    }
    // softmax
    let maxL = -Infinity;
    for (let k = 0; k < INTENT_COUNT; k++) if (logits[k] > maxL) maxL = logits[k];
    let sum = 0;
    const probs = new Float32Array(INTENT_COUNT);
    for (let k = 0; k < INTENT_COUNT; k++) { probs[k] = Math.exp(logits[k] - maxL); sum += probs[k]; }
    const inv = 1 / sum;
    for (let k = 0; k < INTENT_COUNT; k++) probs[k] *= inv;
    return { probs, logits, hidden };
  }
}

/** A single experience tuple recorded during a rollout. */
export interface Step {
  state: Float32Array;
  hidden: Float32Array;
  probs: Float32Array;
  action: number;
  reward: number;
  temperature: number;
}

/**
 * REINFORCE update over one trajectory using returns-to-go and an EMA baseline.
 * Modifies `policy` weights in place.
 */
export function reinforceUpdate(policy: Policy, traj: Step[], gamma = 0.97): number {
  if (traj.length === 0) return 0;
  // Returns-to-go.
  const G = new Float32Array(traj.length);
  let acc = 0;
  for (let t = traj.length - 1; t >= 0; t--) { acc = traj[t].reward + gamma * acc; G[t] = acc; }
  // Update baseline (EMA on mean return).
  let mean = 0; for (let t = 0; t < G.length; t++) mean += G[t]; mean /= G.length;
  policy.baseline = policy.cfg.baselineEMA * policy.baseline + (1 - policy.cfg.baselineEMA) * mean;
  const adv = new Float32Array(G.length);
  for (let t = 0; t < G.length; t++) adv[t] = G[t] - policy.baseline;
  // Normalize advantages for stability — only when we have a real batch.
  // Length-1 trajectories collapse to zero advantage under (x-mean)/std and
  // would produce no learning signal.
  if (adv.length > 1) {
    let am = 0; for (let t = 0; t < adv.length; t++) am += adv[t]; am /= adv.length;
    let av = 0; for (let t = 0; t < adv.length; t++) av += (adv[t] - am) * (adv[t] - am);
    const std = Math.sqrt(av / adv.length) + 1e-6;
    if (std > 1e-3) for (let t = 0; t < adv.length; t++) adv[t] = (adv[t] - am) / std;
  }

  const h = policy.cfg.hidden;
  const lr = policy.cfg.lr;
  const ec = policy.cfg.entropyCoef;
  // Accumulate grads, then apply once for batched SGD.
  const gW1 = new Float32Array(policy.W1.length);
  const gb1 = new Float32Array(policy.b1.length);
  const gW2 = new Float32Array(policy.W2.length);
  const gb2 = new Float32Array(policy.b2.length);

  for (let t = 0; t < traj.length; t++) {
    const step = traj[t];
    const advT = adv[t];
    const probs = step.probs;
    // dL/dlogits_k = (probs[k] - 1{k==a}) * (-adv) + ec * dEntropy/dlogits
    const dlogits = new Float32Array(probs.length);
    let entropy = 0; for (let k = 0; k < probs.length; k++) entropy -= probs[k] * Math.log(probs[k] + 1e-9);
    for (let k = 0; k < probs.length; k++) {
      const oneHot = k === step.action ? 1 : 0;
      // policy gradient: ascend logπ * adv → grad = -(oneHot - p) * adv
      let g = -(oneHot - probs[k]) * advT;
      // entropy regularization: maximize H → grad = -ec * (-(log p + 1) * p * (delta - p))
      // For softmax, dH/dlogit_k = -p_k * (log p_k + H). We descend -H, so add +ec*p_k*(log p_k + H).
      g += ec * probs[k] * (Math.log(probs[k] + 1e-9) + entropy);
      // temperature scaling on forward also scales the gradient.
      dlogits[k] = g / Math.max(0.05, step.temperature);
    }

    // Back-prop into W2/b2 and into hidden.
    const dHidden = new Float32Array(h);
    for (let k = 0; k < INTENT_COUNT; k++) {
      gb2[k] += dlogits[k];
      for (let j = 0; j < h; j++) {
        gW2[k * h + j] += dlogits[k] * step.hidden[j];
        dHidden[j] += dlogits[k] * policy.W2[k * h + j];
      }
    }
    // tanh derivative
    for (let j = 0; j < h; j++) dHidden[j] *= (1 - step.hidden[j] * step.hidden[j]);
    for (let j = 0; j < h; j++) {
      gb1[j] += dHidden[j];
      for (let i = 0; i < STATE_DIM; i++) gW1[j * STATE_DIM + i] += dHidden[j] * step.state[i];
    }
  }

  const invN = 1 / traj.length;
  for (let i = 0; i < policy.W1.length; i++) policy.W1[i] -= lr * gW1[i] * invN;
  for (let i = 0; i < policy.b1.length; i++) policy.b1[i] -= lr * gb1[i] * invN;
  for (let i = 0; i < policy.W2.length; i++) policy.W2[i] -= lr * gW2[i] * invN;
  for (let i = 0; i < policy.b2.length; i++) policy.b2[i] -= lr * gb2[i] * invN;

  let totalReward = 0; for (const s of traj) totalReward += s.reward;
  return totalReward;
}

export function serializePolicy(p: Policy): string {
  return JSON.stringify({
    cfg: p.cfg,
    W1: Array.from(p.W1), b1: Array.from(p.b1),
    W2: Array.from(p.W2), b2: Array.from(p.b2),
    baseline: p.baseline,
  });
}
export function deserializePolicy(json: string): Policy {
  const obj = JSON.parse(json);
  const p = new Policy(obj.cfg);
  p.W1 = new Float32Array(obj.W1); p.b1 = new Float32Array(obj.b1);
  p.W2 = new Float32Array(obj.W2); p.b2 = new Float32Array(obj.b2);
  p.baseline = obj.baseline ?? 0;
  return p;
}
