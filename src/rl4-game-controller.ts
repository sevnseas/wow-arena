/**
 * RL4 Game Controller: Integrates trained RL4 policies with the Three.js game.
 *
 * Allows entities in the game world to be controlled by trained RL4 policies.
 * Can also allow player to control any entity with RL4 action space.
 */

import * as THREE from 'three';
import { Policy4, deserializePolicy4 } from './rl/policy4';
import { createEnv4, observe4, act4 } from './rl/env4';
import type { Archetype } from './rl/types';
import { Action } from './rl/types';

export interface RL4ControlledEntity {
  id: string;
  position: THREE.Vector3;
  policy: Policy4;
  archetype: Archetype;
  hp: number;
  maxHp: number;
  velocity: THREE.Vector3;
  lastDecisionTime: number;
  decisionInterval: number; // ms between decisions
}

export class RL4GameController {
  private entities: Map<string, RL4ControlledEntity> = new Map();
  private policies: Map<Archetype, Policy4> = new Map();
  private env4 = createEnv4({}, 1); // Minimal env for observation generation

  constructor() {
    // Initialize with default policies (can be replaced with trained ones)
  }

  /** Load trained policies from JSON */
  loadPolicies(
    policies: Partial<Record<Archetype, string>>
  ): void {
    for (const [type, json] of Object.entries(policies)) {
      if (json) {
        try {
          this.policies.set(type as Archetype, deserializePolicy4(json));
          console.log(`[RL4] Loaded policy for ${type}`);
        } catch (e) {
          console.error(`[RL4] Failed to load policy for ${type}:`, e);
        }
      }
    }
  }

  /** Register an entity to be controlled by RL4 policy */
  registerEntity(
    id: string,
    position: THREE.Vector3,
    archetype: Archetype,
    hp: number,
    maxHp: number,
    decisionIntervalMs: number = 100
  ): void {
    const policy = this.policies.get(archetype);
    if (!policy) {
      console.warn(`[RL4] No policy for archetype ${archetype}, creating default`);
      this.policies.set(archetype, new Policy4());
    }

    this.entities.set(id, {
      id,
      position: position.clone(),
      policy: this.policies.get(archetype)!,
      archetype,
      hp,
      maxHp,
      velocity: new THREE.Vector3(),
      lastDecisionTime: 0,
      decisionInterval: decisionIntervalMs,
    });
  }

  /** Unregister entity */
  unregisterEntity(id: string): void {
    this.entities.delete(id);
  }

  /** Update entity state (called each frame) */
  update(
    id: string,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    hp: number
  ): {
    action: number;
    velocity: THREE.Vector3;
  } | null {
    const entity = this.entities.get(id);
    if (!entity) return null;

    entity.position.copy(position);
    entity.velocity.copy(velocity);
    entity.hp = hp;

    const now = Date.now();
    if (now - entity.lastDecisionTime < entity.decisionInterval) {
      return { action: -1, velocity: entity.velocity };
    }

    entity.lastDecisionTime = now;

    // Generate observation from game state
    // For now, use empty observation since we don't have real entities
    // In production, this would include nearby entities from game state
    const state = new Float32Array(140).fill(0); // STATE_DIM_RL4 = 140

    const { probs } = entity.policy.forward(state);

    // Sample action from policy
    let action = 0;
    let r = Math.random();
    for (let a = 0; a < probs.length; a++) {
      r -= probs[a];
      if (r < 0) {
        action = a;
        break;
      }
    }

    // Convert action to velocity
    const newVelocity = this.actionToGameVelocity(action, entity.archetype);
    entity.velocity.copy(newVelocity);

    return { action, velocity: newVelocity };
  }

  /** Convert RL4 action to game velocity vector */
  private actionToGameVelocity(action: number, archetype: Archetype): THREE.Vector3 {
    // Get entity speed based on archetype
    const speeds: Record<Archetype, number> = {
      wolf: 8,
      cat: 7,
      dog: 6,
      rabbit: 5,
      cow: 3,
      werewolf: 7,
    };
    const speed = speeds[archetype] ?? 6;

    const v = speed;
    const half = v / Math.sqrt(2);

    let vx = 0,
      vz = 0;

    switch (action) {
      case Action.MoveForward:
        vz = v;
        break;
      case Action.MoveBackward:
        vz = -v;
        break;
      case Action.StrafeLeft:
        vx = -v;
        break;
      case Action.StrafeRight:
        vx = v;
        break;
      case Action.MoveFwdLeft:
        vx = -half;
        vz = half;
        break;
      case Action.MoveFwdRight:
        vx = half;
        vz = half;
        break;
      case Action.MoveBackLeft:
        vx = -half;
        vz = -half;
        break;
      case Action.MoveBackRight:
        vx = half;
        vz = -half;
        break;
      case Action.Ability1:
      case Action.Ability2:
      case Action.Ability3:
        // Abilities don't change velocity
        break;
    }

    return new THREE.Vector3(vx, 0, vz);
  }

  /** Get all controlled entities */
  getEntities(): RL4ControlledEntity[] {
    return Array.from(this.entities.values());
  }

  /** Get entity by ID */
  getEntity(id: string): RL4ControlledEntity | null {
    return this.entities.get(id) ?? null;
  }

  /** Clear all entities */
  clear(): void {
    this.entities.clear();
  }

  /** Get the number of controlled entities */
  getEntityCount(): number {
    return this.entities.size;
  }
}

// Global instance for easy access
let globalController: RL4GameController | null = null;

export function getRL4Controller(): RL4GameController {
  if (!globalController) {
    globalController = new RL4GameController();
  }
  return globalController;
}

export function createRL4Controller(): RL4GameController {
  globalController = new RL4GameController();
  return globalController;
}
