/**
 * Ability metadata - shared between client and server
 * No Three.js dependencies, no execute functions (those are server/client specific)
 */

import type { ClassName, DebuffDef } from './types';

// Ability metadata (no execute function - that's implementation specific)
export interface AbilityMeta {
  id: string;
  name: string;
  key: string;
  cooldown: number;
  castTime: number; // 0 = instant
  range: number;    // 0 = self, -1 = melee (3m), >0 = max range
  requiresTarget: boolean;
  projectileSpeed?: number; // if ability spawns projectile
  debuff?: DebuffDef;       // if ability applies debuff
}

// Rogue abilities
export const ROGUE_ABILITIES: AbilityMeta[] = [
  {
    id: 'rogue_shadowstep',
    name: 'Shadowstep',
    key: '1',
    cooldown: 15,
    castTime: 0,
    range: 15,
    requiresTarget: true,
  },
  {
    id: 'rogue_hemorrhage',
    name: 'Hemorrhage',
    key: '2',
    cooldown: 3,
    castTime: 0,
    range: 3, // melee
    requiresTarget: true,
  },
  {
    id: 'rogue_blind',
    name: 'Blind',
    key: '3',
    cooldown: 25,
    castTime: 0,
    range: 8,
    requiresTarget: true,
    debuff: {
      id: 'blind',
      name: 'Blind',
      duration: 9,
      tags: ['cc', 'incapacitate'],
    },
  },
];

// Mage abilities
export const MAGE_ABILITIES: AbilityMeta[] = [
  {
    id: 'mage_blink',
    name: 'Blink',
    key: '1',
    cooldown: 15,
    castTime: 0,
    range: 0, // self
    requiresTarget: false,
  },
  {
    id: 'mage_frostbolt',
    name: 'Frostbolt',
    key: '2',
    cooldown: 0,
    castTime: 1.5,
    range: 30,
    requiresTarget: true,
    projectileSpeed: 20,
  },
  {
    id: 'mage_polymorph',
    name: 'Polymorph',
    key: '3',
    cooldown: 25,
    castTime: 1.5,
    range: 20,
    requiresTarget: true,
    debuff: {
      id: 'polymorph',
      name: 'Polymorph',
      duration: 9,
      tags: ['cc', 'incapacitate'],
    },
  },
];

// Priest abilities
export const PRIEST_ABILITIES: AbilityMeta[] = [
  {
    id: 'priest_heal',
    name: 'Heal',
    key: '1',
    cooldown: 0,
    castTime: 2.0,
    range: 30,
    requiresTarget: true,
  },
  {
    id: 'priest_smite',
    name: 'Smite',
    key: '2',
    cooldown: 0,
    castTime: 1.5,
    range: 30,
    requiresTarget: true,
    projectileSpeed: 15,
  },
  {
    id: 'priest_fear',
    name: 'Psychic Scream',
    key: '3',
    cooldown: 30,
    castTime: 0,
    range: 0, // AoE around self
    requiresTarget: false,
    debuff: {
      id: 'fear',
      name: 'Fear',
      duration: 8,
      tags: ['cc'],
    },
  },
];

// Class ability lookup
export const CLASS_ABILITIES: Record<ClassName, AbilityMeta[]> = {
  Rogue: ROGUE_ABILITIES,
  Mage: MAGE_ABILITIES,
  Priest: PRIEST_ABILITIES,
  // Stub for enemy classes (not playable yet)
  Warrior: [],
  Druid: [],
  Shaman: [],
};

// Get ability by ID
export function getAbilityById(id: string): AbilityMeta | undefined {
  for (const abilities of Object.values(CLASS_ABILITIES)) {
    const found = abilities.find(a => a.id === id);
    if (found) return found;
  }
  return undefined;
}

// Get ability by class and key
export function getAbilityByKey(className: ClassName, key: string): AbilityMeta | undefined {
  return CLASS_ABILITIES[className]?.find(a => a.key === key);
}

// Action bar keys in order
export const ACTION_BAR_KEYS = ['1', '2', '3', 'q', 'e', 'r', 'f', 'g'];

// Melee range constant
export const MELEE_RANGE = 3;

// Fear AoE radius
export const FEAR_RADIUS = 8;
