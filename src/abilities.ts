/**
 * Ability System - Class abilities and loadouts
 */

import * as THREE from 'three';
import { CooldownManager, DebuffManager, CastSystem, ProjectileSystem } from './systems';
import { ARENA_BOUND } from './shared/physics';

// ============================================================================
// Types
// ============================================================================

export type ClassName = 'Rogue' | 'Mage' | 'Priest';

export interface AbilityDef {
  id: string;
  name: string;
  key: string;
  cooldown: number;
  castTime: number; // 0 = instant
  range: number; // 0 = self/no target, -1 = melee
  requiresTarget: boolean;
  execute: (ctx: AbilityContext) => void;
}

export interface AbilityContext {
  casterId: string;
  casterPos: THREE.Vector3;
  casterYaw: number;
  targetId: string | null;
  targetPos: THREE.Vector3 | null;
  cooldowns: CooldownManager;
  debuffs: DebuffManager;
  casts: CastSystem;
  projectiles: ProjectileSystem;
  getEntityPos: (id: string) => THREE.Vector3 | null;
  setEntityPos: (id: string, pos: THREE.Vector3) => void;
  flashHit: (entityId: string) => void;
}

// ============================================================================
// Rogue Abilities
// ============================================================================

const rogueAbilities: AbilityDef[] = [
  {
    id: 'rogue_teleport',
    name: 'Shadowstep',
    key: '1',
    cooldown: 15,
    castTime: 0,
    range: 15,
    requiresTarget: true,
    execute: (ctx) => {
      if (!ctx.targetId || !ctx.targetPos) return;

      // Teleport behind target
      const dirToTarget = ctx.targetPos.clone().sub(ctx.casterPos).normalize();
      const behindPos = ctx.targetPos.clone().add(dirToTarget.multiplyScalar(1.5));
      behindPos.y = 0; // Stay on ground

      ctx.setEntityPos(ctx.casterId, behindPos);
      ctx.cooldowns.startCooldown('rogue_teleport', 15);
    }
  },
  {
    id: 'rogue_hemorrhage',
    name: 'Hemorrhage',
    key: '2',
    cooldown: 3,
    castTime: 0,
    range: 3,
    requiresTarget: true,
    execute: (ctx) => {
      if (!ctx.targetId) return;

      ctx.flashHit(ctx.targetId);
      ctx.cooldowns.startCooldown('rogue_hemorrhage', 3);
    }
  },
  {
    id: 'rogue_blind',
    name: 'Blind',
    key: '3',
    cooldown: 25,
    castTime: 0,
    range: 8,
    requiresTarget: true,
    execute: (ctx) => {
      if (!ctx.targetId) return;

      ctx.debuffs.applyDebuff(ctx.targetId, {
        id: 'blind',
        name: 'Blind',
        duration: 9,
        tags: ['cc', 'incapacitate']
      });
      ctx.cooldowns.startCooldown('rogue_blind', 25);
    }
  }
];

// ============================================================================
// Mage Abilities
// ============================================================================

const mageAbilities: AbilityDef[] = [
  {
    id: 'mage_blink',
    name: 'Blink',
    key: '1',
    cooldown: 15,
    castTime: 0,
    range: 0,
    requiresTarget: false,
    execute: (ctx) => {
      // Blink forward 8m
      const forward = new THREE.Vector3(
        -Math.sin(ctx.casterYaw),
        0,
        -Math.cos(ctx.casterYaw)
      );
      const newPos = ctx.casterPos.clone().add(forward.multiplyScalar(8));
      newPos.y = 0;

      // Clamp to arena bounds
      newPos.x = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, newPos.x));
      newPos.z = Math.max(-ARENA_BOUND, Math.min(ARENA_BOUND, newPos.z));

      ctx.setEntityPos(ctx.casterId, newPos);
      ctx.cooldowns.startCooldown('mage_blink', 15);
    }
  },
  {
    id: 'mage_frostbolt',
    name: 'Frostbolt',
    key: '2',
    cooldown: 0,
    castTime: 1.5,
    range: 30,
    requiresTarget: true,
    execute: (ctx) => {
      if (!ctx.targetId || !ctx.targetPos) return;

      const targetId = ctx.targetId;
      const targetPos = ctx.targetPos.clone();

      ctx.casts.beginCast({
        abilityId: 'mage_frostbolt',
        abilityName: 'Frostbolt',
        castTime: 1.5,
        targetId,
        onComplete: () => {
          const startPos = ctx.casterPos.clone();
          startPos.y = 1;
          targetPos.y = 1;

          ctx.projectiles.spawn(
            startPos,
            targetPos,
            targetId,
            20, // speed
            0x88ccff, // ice blue
            () => ctx.flashHit(targetId)
          );
        }
      });
    }
  },
  {
    id: 'mage_polymorph',
    name: 'Polymorph',
    key: '3',
    cooldown: 25,
    castTime: 1.5,
    range: 20,
    requiresTarget: true,
    execute: (ctx) => {
      if (!ctx.targetId) return;

      const targetId = ctx.targetId;

      ctx.casts.beginCast({
        abilityId: 'mage_polymorph',
        abilityName: 'Polymorph',
        castTime: 1.5,
        targetId,
        onComplete: () => {
          ctx.debuffs.applyDebuff(targetId, {
            id: 'polymorph',
            name: 'Polymorph',
            duration: 9,
            tags: ['cc', 'incapacitate']
          });
          ctx.cooldowns.startCooldown('mage_polymorph', 25);
        }
      });
    }
  }
];

// ============================================================================
// Priest Abilities
// ============================================================================

const priestAbilities: AbilityDef[] = [
  {
    id: 'priest_heal',
    name: 'Heal',
    key: '1',
    cooldown: 0,
    castTime: 2.0,
    range: 30,
    requiresTarget: true,
    execute: (ctx) => {
      if (!ctx.targetId) return;

      // Start cast
      ctx.casts.beginCast({
        abilityId: 'priest_heal',
        abilityName: 'Heal',
        castTime: 2.0,
        targetId: ctx.targetId,
        onComplete: () => {
          ctx.flashHit(ctx.targetId!);
          // Would increment health here
        }
      });
    }
  },
  {
    id: 'priest_smite',
    name: 'Smite',
    key: '2',
    cooldown: 0,
    castTime: 1.5,
    range: 30,
    requiresTarget: true,
    execute: (ctx) => {
      if (!ctx.targetId || !ctx.targetPos) return;

      const targetId = ctx.targetId;
      const targetPos = ctx.targetPos.clone();

      ctx.casts.beginCast({
        abilityId: 'priest_smite',
        abilityName: 'Smite',
        castTime: 1.5,
        targetId,
        onComplete: () => {
          const startPos = ctx.casterPos.clone();
          startPos.y = 1;
          targetPos.y = 1;

          ctx.projectiles.spawn(
            startPos,
            targetPos,
            targetId,
            15,
            0xffff88, // holy yellow
            () => ctx.flashHit(targetId)
          );
        }
      });
    }
  },
  {
    id: 'priest_fear',
    name: 'Psychic Scream',
    key: '3',
    cooldown: 30,
    castTime: 0,
    range: 0, // AoE around self
    requiresTarget: false,
    execute: (ctx) => {
      // Apply fear to all enemies within 8m
      // For now, just start cooldown - actual AoE logic needs entity list
      ctx.cooldowns.startCooldown('priest_fear', 30);
      // The main.ts will need to handle the AoE application
    }
  }
];

// ============================================================================
// Class Loadouts
// ============================================================================

export const CLASS_ABILITIES: Record<ClassName, AbilityDef[]> = {
  Rogue: rogueAbilities,
  Mage: mageAbilities,
  Priest: priestAbilities
};

export function getAbilityByKey(className: ClassName, key: string): AbilityDef | undefined {
  return CLASS_ABILITIES[className].find(a => a.key === key);
}

export function getClassAbilities(className: ClassName): AbilityDef[] {
  return CLASS_ABILITIES[className];
}

// Action bar keybinds in order
export const ACTION_BAR_KEYS = ['1', '2', '3', 'q', 'e', 'r', 'f', 'g'];
