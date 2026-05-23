/**
 * Seedable PRNG (mulberry32). Required so RL rollouts are deterministic
 * — every tick of training must be reproducible from the seed alone.
 */

export class Rng {
  private state: number;
  constructor(seed: number = 1) {
    this.state = (seed >>> 0) || 1;
  }
  /** Uniform [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  /** Standard-normal via Box–Muller. */
  gauss(): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Returns the categorical sample given a softmax distribution. */
  categorical(probs: Float32Array): number {
    const r = this.next();
    let acc = 0;
    for (let i = 0; i < probs.length; i++) {
      acc += probs[i];
      if (r < acc) return i;
    }
    return probs.length - 1;
  }
}
