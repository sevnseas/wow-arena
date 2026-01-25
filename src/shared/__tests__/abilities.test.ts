import { describe, it, expect } from 'vitest';
import {
  CLASS_ABILITIES,
  getAbilityById,
  getAbilityByKey,
  ROGUE_ABILITIES,
  MAGE_ABILITIES,
  PRIEST_ABILITIES,
  MELEE_RANGE,
} from '../abilities';

describe('abilities', () => {
  describe('class ability arrays', () => {
    it('Rogue has 3 abilities', () => {
      expect(ROGUE_ABILITIES).toHaveLength(3);
    });

    it('Mage has 3 abilities', () => {
      expect(MAGE_ABILITIES).toHaveLength(3);
    });

    it('Priest has 3 abilities', () => {
      expect(PRIEST_ABILITIES).toHaveLength(3);
    });

    it('all abilities have unique IDs', () => {
      const allAbilities = [
        ...ROGUE_ABILITIES,
        ...MAGE_ABILITIES,
        ...PRIEST_ABILITIES,
      ];
      const ids = allAbilities.map(a => a.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('all abilities have required fields', () => {
      const allAbilities = [
        ...ROGUE_ABILITIES,
        ...MAGE_ABILITIES,
        ...PRIEST_ABILITIES,
      ];

      for (const ability of allAbilities) {
        expect(ability.id).toBeDefined();
        expect(ability.name).toBeDefined();
        expect(ability.key).toBeDefined();
        expect(typeof ability.cooldown).toBe('number');
        expect(typeof ability.castTime).toBe('number');
        expect(typeof ability.range).toBe('number');
        expect(typeof ability.requiresTarget).toBe('boolean');
      }
    });
  });

  describe('CLASS_ABILITIES lookup', () => {
    it('returns Rogue abilities', () => {
      expect(CLASS_ABILITIES['Rogue']).toBe(ROGUE_ABILITIES);
    });

    it('returns Mage abilities', () => {
      expect(CLASS_ABILITIES['Mage']).toBe(MAGE_ABILITIES);
    });

    it('returns Priest abilities', () => {
      expect(CLASS_ABILITIES['Priest']).toBe(PRIEST_ABILITIES);
    });

    it('returns empty array for NPC classes', () => {
      expect(CLASS_ABILITIES['Warrior']).toEqual([]);
      expect(CLASS_ABILITIES['Druid']).toEqual([]);
      expect(CLASS_ABILITIES['Shaman']).toEqual([]);
    });
  });

  describe('getAbilityById', () => {
    it('finds rogue_shadowstep', () => {
      const ability = getAbilityById('rogue_shadowstep');
      expect(ability).toBeDefined();
      expect(ability?.name).toBe('Shadowstep');
    });

    it('finds mage_frostbolt', () => {
      const ability = getAbilityById('mage_frostbolt');
      expect(ability).toBeDefined();
      expect(ability?.castTime).toBe(1.5);
      expect(ability?.projectileSpeed).toBe(20);
    });

    it('finds priest_heal', () => {
      const ability = getAbilityById('priest_heal');
      expect(ability).toBeDefined();
      expect(ability?.castTime).toBe(2.0);
    });

    it('returns undefined for unknown ID', () => {
      const ability = getAbilityById('unknown_ability');
      expect(ability).toBeUndefined();
    });
  });

  describe('getAbilityByKey', () => {
    it('finds Rogue ability by key 1', () => {
      const ability = getAbilityByKey('Rogue', '1');
      expect(ability?.id).toBe('rogue_shadowstep');
    });

    it('finds Mage ability by key 2', () => {
      const ability = getAbilityByKey('Mage', '2');
      expect(ability?.id).toBe('mage_frostbolt');
    });

    it('finds Priest ability by key 3', () => {
      const ability = getAbilityByKey('Priest', '3');
      expect(ability?.id).toBe('priest_fear');
    });

    it('returns undefined for invalid key', () => {
      const ability = getAbilityByKey('Rogue', '9');
      expect(ability).toBeUndefined();
    });
  });

  describe('ability properties', () => {
    it('Shadowstep is instant with 15m range', () => {
      const ability = getAbilityById('rogue_shadowstep');
      expect(ability?.castTime).toBe(0);
      expect(ability?.range).toBe(15);
      expect(ability?.requiresTarget).toBe(true);
    });

    it('Hemorrhage has melee range', () => {
      const ability = getAbilityById('rogue_hemorrhage');
      expect(ability?.range).toBe(MELEE_RANGE);
    });

    it('Blind applies a debuff', () => {
      const ability = getAbilityById('rogue_blind');
      expect(ability?.debuff).toBeDefined();
      expect(ability?.debuff?.id).toBe('blind');
      expect(ability?.debuff?.duration).toBe(9);
      expect(ability?.debuff?.tags).toContain('cc');
    });

    it('Blink is self-targeted', () => {
      const ability = getAbilityById('mage_blink');
      expect(ability?.range).toBe(0);
      expect(ability?.requiresTarget).toBe(false);
    });

    it('Frostbolt spawns projectile', () => {
      const ability = getAbilityById('mage_frostbolt');
      expect(ability?.projectileSpeed).toBe(20);
    });

    it('Polymorph applies CC debuff', () => {
      const ability = getAbilityById('mage_polymorph');
      expect(ability?.debuff?.tags).toContain('incapacitate');
    });

    it('Psychic Scream is instant AoE', () => {
      const ability = getAbilityById('priest_fear');
      expect(ability?.castTime).toBe(0);
      expect(ability?.range).toBe(0); // AoE around self
      expect(ability?.requiresTarget).toBe(false);
    });
  });
});
