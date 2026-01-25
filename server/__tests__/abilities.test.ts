import { describe, it, expect, beforeEach } from 'vitest';
import { ServerGameState } from '../src/state';
import {
  executeAbility,
  completeCast,
  updateProjectiles,
  updateDebuffs,
  updateRespawns,
} from '../src/abilities';
import { vec3DistanceXZ } from '../src/physics';

describe('abilities', () => {
  let state: ServerGameState;

  beforeEach(() => {
    state = new ServerGameState();
    state.spawnEntity('player', 'Player', 'Rogue', 'friendly', { x: 0, y: 0, z: 5 });
    state.spawnEntity('enemy', 'Enemy', 'Warrior', 'enemy', { x: 0, y: 0, z: -5 });
  });

  describe('executeAbility', () => {
    it('rejects unknown ability', () => {
      const result = executeAbility(state, 'player', 'unknown_spell', null);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown ability');
    });

    it('rejects if caster dead', () => {
      state.kill('player');

      const result = executeAbility(state, 'player', 'rogue_blind', 'enemy');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Caster not found or dead');
    });
  });

  describe('instant abilities', () => {
    describe('Shadowstep', () => {
      it('teleports behind target', () => {
        const result = executeAbility(state, 'player', 'rogue_shadowstep', 'enemy');

        expect(result.success).toBe(true);

        const player = state.getEntity('player')!;
        const enemy = state.getEntity('enemy')!;

        // Player should be behind enemy (further from original position)
        expect(player.pos.z).toBeLessThan(enemy.pos.z);
      });

      it('requires target', () => {
        const result = executeAbility(state, 'player', 'rogue_shadowstep', null);

        expect(result.success).toBe(false);
        expect(result.error).toBe('Shadowstep requires target');
      });

      it('starts cooldown', () => {
        executeAbility(state, 'player', 'rogue_shadowstep', 'enemy');

        expect(state.isOnCooldown('player', 'rogue_shadowstep')).toBe(true);
      });
    });

    describe('Hemorrhage', () => {
      it('deals damage', () => {
        const result = executeAbility(state, 'player', 'rogue_hemorrhage', 'enemy');

        expect(result.success).toBe(true);
        expect(state.getEntity('enemy')?.hp).toBeLessThan(100);
        expect(result.events).toContainEqual(
          expect.objectContaining({ type: 'Damage', targetId: 'enemy' })
        );
      });

      it('can kill target', () => {
        state.applyDamage('enemy', 90);

        const result = executeAbility(state, 'player', 'rogue_hemorrhage', 'enemy');

        expect(result.events).toContainEqual(
          expect.objectContaining({ type: 'Death', entityId: 'enemy' })
        );
        expect(state.getEntity('enemy')?.alive).toBe(false);
      });
    });

    describe('Blind', () => {
      it('applies CC debuff', () => {
        const result = executeAbility(state, 'player', 'rogue_blind', 'enemy');

        expect(result.success).toBe(true);
        expect(state.hasDebuffWithTag('enemy', 'cc')).toBe(true);
        expect(result.events).toContainEqual(
          expect.objectContaining({ type: 'DebuffApplied', debuffId: 'blind' })
        );
      });
    });

    describe('Blink', () => {
      it('teleports forward', () => {
        state.removeEntity('player');
        state.spawnEntity('mage', 'Mage', 'Mage', 'friendly', { x: 0, y: 0, z: 0 });
        state.setYaw('mage', 0); // Facing -Z

        const result = executeAbility(state, 'mage', 'mage_blink', null);

        expect(result.success).toBe(true);
        expect(state.getEntity('mage')?.pos.z).toBeLessThan(-5);
      });

      it('does not require target', () => {
        state.removeEntity('player');
        state.spawnEntity('mage', 'Mage', 'Mage', 'friendly');

        const result = executeAbility(state, 'mage', 'mage_blink', null);

        expect(result.success).toBe(true);
      });
    });

    describe('Psychic Scream (Fear)', () => {
      it('applies fear to nearby enemies', () => {
        state.removeEntity('player');
        state.spawnEntity('priest', 'Priest', 'Priest', 'friendly', { x: 0, y: 0, z: 0 });
        state.setPosition('enemy', { x: 0, y: 0, z: -5 }); // Within 8m

        const result = executeAbility(state, 'priest', 'priest_fear', null);

        expect(result.success).toBe(true);
        expect(state.hasDebuffWithTag('enemy', 'cc')).toBe(true);
      });

      it('does not affect allies', () => {
        state.removeEntity('player');
        state.spawnEntity('priest', 'Priest', 'Priest', 'friendly', { x: 0, y: 0, z: 0 });
        state.spawnEntity('ally', 'Ally', 'Mage', 'friendly', { x: 2, y: 0, z: 0 });

        executeAbility(state, 'priest', 'priest_fear', null);

        expect(state.hasDebuffWithTag('ally', 'cc')).toBe(false);
      });

      it('does not affect enemies out of range', () => {
        state.removeEntity('player');
        state.spawnEntity('priest', 'Priest', 'Priest', 'friendly', { x: 0, y: 0, z: 0 });
        state.setPosition('enemy', { x: 0, y: 0, z: -20 }); // Outside 8m

        executeAbility(state, 'priest', 'priest_fear', null);

        expect(state.hasDebuffWithTag('enemy', 'cc')).toBe(false);
      });
    });
  });

  describe('cast abilities', () => {
    describe('starting a cast', () => {
      it('creates active cast for Frostbolt', () => {
        state.removeEntity('player');
        state.spawnEntity('mage', 'Mage', 'Mage', 'friendly');

        const result = executeAbility(state, 'mage', 'mage_frostbolt', 'enemy');

        expect(result.success).toBe(true);
        expect(state.getActiveCast('mage')).not.toBeNull();
        expect(state.getActiveCast('mage')?.abilityId).toBe('mage_frostbolt');
        expect(result.events).toContainEqual(
          expect.objectContaining({ type: 'CastStarted', abilityId: 'mage_frostbolt' })
        );
      });

      it('does not start cooldown until cast completes', () => {
        state.removeEntity('player');
        state.spawnEntity('mage', 'Mage', 'Mage', 'friendly');

        executeAbility(state, 'mage', 'mage_polymorph', 'enemy');

        // Cooldown should not start yet
        expect(state.isOnCooldown('mage', 'mage_polymorph')).toBe(false);
      });
    });

    describe('completeCast', () => {
      it('Frostbolt spawns projectile', () => {
        state.removeEntity('player');
        state.spawnEntity('mage', 'Mage', 'Mage', 'friendly');

        executeAbility(state, 'mage', 'mage_frostbolt', 'enemy');
        const cast = state.getActiveCast('mage')!;

        const events = completeCast(state, 'mage', cast);

        expect(events).toContainEqual(
          expect.objectContaining({ type: 'CastCompleted', abilityId: 'mage_frostbolt' })
        );
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'ProjectileSpawned', abilityId: 'mage_frostbolt' })
        );
        expect(state.getAllProjectiles()).toHaveLength(1);
      });

      it('Polymorph applies CC', () => {
        state.removeEntity('player');
        state.spawnEntity('mage', 'Mage', 'Mage', 'friendly');

        executeAbility(state, 'mage', 'mage_polymorph', 'enemy');
        const cast = state.getActiveCast('mage')!;

        const events = completeCast(state, 'mage', cast);

        expect(state.hasDebuffWithTag('enemy', 'cc')).toBe(true);
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'DebuffApplied', debuffId: 'polymorph' })
        );
      });

      it('Heal restores HP', () => {
        state.removeEntity('player');
        state.spawnEntity('priest', 'Priest', 'Priest', 'friendly');
        state.spawnEntity('ally', 'Ally', 'Mage', 'friendly');
        state.applyDamage('ally', 50);

        executeAbility(state, 'priest', 'priest_heal', 'ally');
        const cast = state.getActiveCast('priest')!;

        const events = completeCast(state, 'priest', cast);

        expect(state.getEntity('ally')?.hp).toBeGreaterThan(50);
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'Heal', targetId: 'ally' })
        );
      });

      it('Smite spawns projectile', () => {
        state.removeEntity('player');
        state.spawnEntity('priest', 'Priest', 'Priest', 'friendly');

        executeAbility(state, 'priest', 'priest_smite', 'enemy');
        const cast = state.getActiveCast('priest')!;

        const events = completeCast(state, 'priest', cast);

        expect(events).toContainEqual(
          expect.objectContaining({ type: 'ProjectileSpawned', abilityId: 'priest_smite' })
        );
      });

      it('starts cooldown after cast completes', () => {
        state.removeEntity('player');
        state.spawnEntity('mage', 'Mage', 'Mage', 'friendly');

        executeAbility(state, 'mage', 'mage_polymorph', 'enemy');
        const cast = state.getActiveCast('mage')!;

        completeCast(state, 'mage', cast);

        expect(state.isOnCooldown('mage', 'mage_polymorph')).toBe(true);
      });
    });
  });

  describe('updateProjectiles', () => {
    beforeEach(() => {
      state.removeEntity('player');
      state.spawnEntity('mage', 'Mage', 'Mage', 'friendly', { x: 0, y: 0, z: 5 });
    });

    it('moves projectile toward target', () => {
      state.spawnProjectile('mage_frostbolt', 'mage', 'enemy', { x: 0, y: 1, z: 5 }, 20);

      const projBefore = state.getAllProjectiles()[0];
      const zBefore = projBefore.pos.z;

      updateProjectiles(state, 0.1);

      const projAfter = state.getAllProjectiles()[0];
      expect(projAfter.pos.z).toBeLessThan(zBefore);
    });

    it('hits target and applies damage', () => {
      // Spawn projectile very close to target
      state.spawnProjectile('mage_frostbolt', 'mage', 'enemy', { x: 0, y: 1, z: -4.9 }, 20);

      const events = updateProjectiles(state, 0.1);

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'ProjectileHit', targetId: 'enemy' })
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'Damage', targetId: 'enemy' })
      );
      expect(state.getEntity('enemy')?.hp).toBeLessThan(100);
    });

    it('removes projectile after hit', () => {
      state.spawnProjectile('mage_frostbolt', 'mage', 'enemy', { x: 0, y: 1, z: -4.9 }, 20);

      updateProjectiles(state, 0.1);

      expect(state.getAllProjectiles()).toHaveLength(0);
    });

    it('projectile can kill target', () => {
      state.applyDamage('enemy', 90);
      state.spawnProjectile('mage_frostbolt', 'mage', 'enemy', { x: 0, y: 1, z: -4.9 }, 20);

      const events = updateProjectiles(state, 0.1);

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'Death', entityId: 'enemy' })
      );
    });

    it('removes projectile if target dies', () => {
      state.spawnProjectile('mage_frostbolt', 'mage', 'enemy', { x: 0, y: 1, z: 0 }, 20);
      state.kill('enemy');

      updateProjectiles(state, 0.1);

      expect(state.getAllProjectiles()).toHaveLength(0);
    });

    it('removes projectile after timeout', () => {
      const proj = state.spawnProjectile('mage_frostbolt', 'mage', 'enemy', { x: 0, y: 1, z: 10 }, 1);
      state.setTick(proj.spawnTick + proj.maxLifetimeTicks + 1);

      updateProjectiles(state, 0.05);

      expect(state.getAllProjectiles()).toHaveLength(0);
    });
  });

  describe('updateDebuffs', () => {
    it('removes expired debuffs', () => {
      state.setTick(0);
      state.applyDebuff('enemy', 'player', {
        id: 'test_debuff',
        name: 'Test',
        duration: 1, // 20 ticks
        tags: [],
      });

      expect(state.getDebuffs('enemy')).toHaveLength(1);

      state.setTick(21);
      const events = updateDebuffs(state);

      expect(state.getDebuffs('enemy')).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'DebuffRemoved', debuffId: 'test_debuff' })
      );
    });

    it('keeps non-expired debuffs', () => {
      state.setTick(0);
      state.applyDebuff('enemy', 'player', {
        id: 'test_debuff',
        name: 'Test',
        duration: 5,
        tags: [],
      });

      state.setTick(50);
      updateDebuffs(state);

      expect(state.getDebuffs('enemy')).toHaveLength(1);
    });
  });

  describe('updateRespawns', () => {
    it('respawns dead entities after timer', () => {
      state.setTick(0);
      state.kill('enemy');

      // Not time yet
      state.setTick(50);
      let events = updateRespawns(state);
      expect(events).toHaveLength(0);
      expect(state.getEntity('enemy')?.alive).toBe(false);

      // Time for respawn
      state.setTick(100);
      events = updateRespawns(state);

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'Respawn', entityId: 'enemy' })
      );
      expect(state.getEntity('enemy')?.alive).toBe(true);
    });

    it('respawns at spawn point', () => {
      state.kill('enemy');
      state.setTick(100);

      const events = updateRespawns(state);
      const respawnEvent = events.find(e => e.type === 'Respawn');

      expect(respawnEvent).toBeDefined();
      // Enemy team spawns on negative Z side
      if (respawnEvent?.type === 'Respawn') {
        expect(respawnEvent.pos.z).toBeLessThan(0);
      }
    });
  });
});
