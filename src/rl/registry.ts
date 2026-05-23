/**
 * Per-archetype policy registry. Every archetype owns a shared MLP — every
 * wolf in the world runs `predator_wolf`, every cow runs `cow`, etc. This
 * is the "Shared Parameter Training" path from entity-policies.md §2.
 */

import { Policy, type PolicyConfig, serializePolicy, deserializePolicy } from './policy';
import { ARCHETYPES, type Archetype } from './types';

export class PolicyRegistry {
  readonly policies: Record<Archetype, Policy>;

  constructor(cfg: Partial<PolicyConfig> = {}) {
    const out = {} as Record<Archetype, Policy>;
    for (const a of ARCHETYPES) out[a] = new Policy(cfg);
    this.policies = out;
  }

  get(a: Archetype): Policy {
    return this.policies[a];
  }

  serialize(): Record<Archetype, string> {
    const out = {} as Record<Archetype, string>;
    for (const a of ARCHETYPES) out[a] = serializePolicy(this.policies[a]);
    return out;
  }
}

export function deserializeRegistry(blob: Partial<Record<Archetype, string>>): PolicyRegistry {
  const r = new PolicyRegistry();
  for (const a of ARCHETYPES) {
    const json = blob[a];
    if (json) r.policies[a] = deserializePolicy(json);
  }
  return r;
}
