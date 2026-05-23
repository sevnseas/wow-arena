/**
 * RL4 Policy: Direct control with minimap observation.
 *
 * Network: STATE_DIM_RL4 → hidden (64) → ACTION_COUNT logits
 * Trained with REINFORCE + baseline + entropy regularization.
 */

import { ACTION_COUNT, STATE_DIM_RL4 } from './types';
import type { Rng } from './rng';

export interface PolicyConfig4 {
  hidden: number;
  lr: number;
  baselineEMA: number;
  entropyCoef: number;
}

export const DEFAULT_POLICY_CONFIG4: PolicyConfig4 = {
  hidden: 64,
  lr: 0.01,
  baselineEMA: 0.95,
  entropyCoef: 0.01,
};

export class Policy4 {
  readonly cfg: PolicyConfig4;
  W1: Float32Array; b1: Float32Array;
  W2: Float32Array; b2: Float32Array;
  baseline = 0;

  constructor(cfg: Partial<PolicyConfig4> = {}, rng?: Rng) {
    this.cfg = { ...DEFAULT_POLICY_CONFIG4, ...cfg };
    const h = this.cfg.hidden;
    this.W1 = new Float32Array(STATE_DIM_RL4 * h);
    this.b1 = new Float32Array(h);
    this.W2 = new Float32Array(h * ACTION_COUNT);
    this.b2 = new Float32Array(ACTION_COUNT);
    const init = (arr: Float32Array, fanIn: number) => {
      const scale = Math.sqrt(2 / fanIn);
      for (let i = 0; i < arr.length; i++) {
        arr[i] = (rng ? rng.gauss() : (Math.random() * 2 - 1)) * scale;
      }
    };
    init(this.W1, STATE_DIM_RL4);
    init(this.W2, this.cfg.hidden);
  }

  forward(state: Float32Array, temperature = 1.0): {
    probs: Float32Array;
    logits: Float32Array;
    hidden: Float32Array;
  } {
    const h = this.cfg.hidden;
    const hidden = new Float32Array(h);
    for (let j = 0; j < h; j++) {
      let s = this.b1[j];
      for (let i = 0; i < STATE_DIM_RL4; i++) s += state[i] * this.W1[j * STATE_DIM_RL4 + i];
      hidden[j] = Math.tanh(s);
    }
    const logits = new Float32Array(ACTION_COUNT);
    for (let k = 0; k < ACTION_COUNT; k++) {
      let s = this.b2[k];
      for (let j = 0; j < h; j++) s += hidden[j] * this.W2[k * h + j];
      logits[k] = s / Math.max(0.05, temperature);
    }
    let maxL = -Infinity;
    for (let k = 0; k < ACTION_COUNT; k++) if (logits[k] > maxL) maxL = logits[k];
    let sum = 0;
    const probs = new Float32Array(ACTION_COUNT);
    for (let k = 0; k < ACTION_COUNT; k++) { probs[k] = Math.exp(logits[k] - maxL); sum += probs[k]; }
    const inv = 1 / sum;
    for (let k = 0; k < ACTION_COUNT; k++) probs[k] *= inv;
    return { probs, logits, hidden };
  }
}

export interface Step4 {
  state: Float32Array;
  hidden: Float32Array;
  probs: Float32Array;
  action: number;
  reward: number;
  temperature: number;
}

export function reinforceUpdate4(policy: Policy4, traj: Step4[], gamma = 0.97): number {
  if (traj.length === 0) return 0;
  const G = new Float32Array(traj.length);
  let acc = 0;
  for (let t = traj.length - 1; t >= 0; t--) { acc = traj[t].reward + gamma * acc; G[t] = acc; }
  let mean = 0; for (let t = 0; t < G.length; t++) mean += G[t]; mean /= G.length;
  policy.baseline = policy.cfg.baselineEMA * policy.baseline + (1 - policy.cfg.baselineEMA) * mean;
  const adv = new Float32Array(G.length);
  for (let t = 0; t < G.length; t++) adv[t] = G[t] - policy.baseline;
  if (adv.length > 1) {
    let am = 0; for (let t = 0; t < adv.length; t++) am += adv[t]; am /= adv.length;
    let av = 0; for (let t = 0; t < adv.length; t++) av += (adv[t] - am) * (adv[t] - am);
    const std = Math.sqrt(av / adv.length) + 1e-6;
    if (std > 1e-3) for (let t = 0; t < adv.length; t++) adv[t] = (adv[t] - am) / std;
  }

  const h = policy.cfg.hidden;
  const lr = policy.cfg.lr;
  const ec = policy.cfg.entropyCoef;
  const gW1 = new Float32Array(policy.W1.length);
  const gb1 = new Float32Array(policy.b1.length);
  const gW2 = new Float32Array(policy.W2.length);
  const gb2 = new Float32Array(policy.b2.length);

  for (let t = 0; t < traj.length; t++) {
    const step = traj[t];
    const advT = adv[t];
    const probs = step.probs;
    const dlogits = new Float32Array(probs.length);
    let entropy = 0; for (let k = 0; k < probs.length; k++) entropy -= probs[k] * Math.log(probs[k] + 1e-9);
    for (let k = 0; k < probs.length; k++) {
      const oneHot = k === step.action ? 1 : 0;
      let g = -(oneHot - probs[k]) * advT;
      g += ec * probs[k] * (Math.log(probs[k] + 1e-9) + entropy);
      dlogits[k] = g / Math.max(0.05, step.temperature);
    }

    const dHidden = new Float32Array(h);
    for (let k = 0; k < ACTION_COUNT; k++) {
      gb2[k] += dlogits[k];
      for (let j = 0; j < h; j++) {
        gW2[k * h + j] += dlogits[k] * step.hidden[j];
        dHidden[j] += dlogits[k] * policy.W2[k * h + j];
      }
    }

    for (let j = 0; j < h; j++) dHidden[j] *= (1 - step.hidden[j] * step.hidden[j]);
    for (let j = 0; j < h; j++) {
      gb1[j] += dHidden[j];
      for (let i = 0; i < STATE_DIM_RL4; i++) {
        gW1[j * STATE_DIM_RL4 + i] += dHidden[j] * step.state[i];
      }
    }
  }

  const invN = 1 / traj.length;
  for (let i = 0; i < policy.W1.length; i++) policy.W1[i] -= lr * gW1[i] * invN;
  for (let i = 0; i < policy.b1.length; i++) policy.b1[i] -= lr * gb1[i] * invN;
  for (let i = 0; i < policy.W2.length; i++) policy.W2[i] -= lr * gW2[i] * invN;
  for (let i = 0; i < policy.b2.length; i++) policy.b2[i] -= lr * gb2[i] * invN;

  return mean;
}

export function serializePolicy4(p: Policy4): string {
  return JSON.stringify({
    cfg: p.cfg,
    W1: Array.from(p.W1), b1: Array.from(p.b1),
    W2: Array.from(p.W2), b2: Array.from(p.b2),
    baseline: p.baseline,
  });
}

export function deserializePolicy4(json: string): Policy4 {
  const obj = JSON.parse(json);
  const p = new Policy4(obj.cfg);
  p.W1 = new Float32Array(obj.W1); p.b1 = new Float32Array(obj.b1);
  p.W2 = new Float32Array(obj.W2); p.b2 = new Float32Array(obj.b2);
  p.baseline = obj.baseline ?? 0;
  return p;
}
