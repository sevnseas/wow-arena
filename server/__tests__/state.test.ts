import { describe, it, expect, beforeEach } from 'vitest';
import { ServerGameState } from '../src/state';

describe('ServerGameState', () => {
  let state: ServerGameState;

  beforeEach(() => {
    state = new ServerGameState();
  });

  describe('tick management', () => {
    it('starts at tick 0', () => {
      expect(state.getTick()).toBe(0);
    });

    it('advances tick', () => {
      state.advanceTick();
      expect(state.getTick()).toBe(1);

      state.advanceTick();
      state.advanceTick();
      expect(state.getTick()).toBe(3);
    });

    it('can set tick directly', () => {
      state.setTick(100);
      expect(state.getTick()).toBe(100);
    });
  });

  describe('entity management', () => {
    it('spawns entity with correct properties', () => {
      const entity = state.spawnEntity('player1', 'TestPlayer', 'Mage', 'friendly');

      expect(entity.id).toBe('player1');
      expect(entity.name).toBe('TestPlayer');
      expect(entity.class).toBe('Mage');
      expect(entity.team).toBe('friendly');
      expect(entity.hp).toBe(100);
      expect(entity.maxHp).toBe(100);
      expect(entity.alive).toBe(true);
    });

    it('spawns entity at provided position', () => {
      const entity = state.spawnEntity('player1', 'Test', 'Rogue', 'friendly', { x: 5, y: 0, z: 10 });

      expect(entity.pos).toEqual({ x: 5, y: 0, z: 10 });
    });

    it('spawns friendly entities facing center', () => {
      const entity = state.spawnEntity('player1', 'Test', 'Mage', 'friendly');
      expect(entity.yaw).toBe(0);
    });

    it('spawns enemy entities facing center', () => {
      const entity = state.spawnEntity('enemy1', 'Test', 'Warrior', 'enemy');
      expect(entity.yaw).toBe(Math.PI);
    });

    it('removes entity', () => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly');
      expect(state.hasEntity('player1')).toBe(true);

      const removed = state.removeEntity('player1');
      expect(removed).toBe(true);
      expect(state.hasEntity('player1')).toBe(false);
    });

    it('returns false when removing non-existent entity', () => {
      expect(state.removeEntity('nonexistent')).toBe(false);
    });

    it('gets entity by id', () => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly');

      const entity = state.getEntity('player1');
      expect(entity?.id).toBe('player1');
    });

    it('returns undefined for non-existent entity', () => {
      expect(state.getEntity('nonexistent')).toBeUndefined();
    });

    it('counts entities correctly', () => {
      expect(state.getEntityCount()).toBe(0);

      state.spawnEntity('player1', 'Test1', 'Mage', 'friendly');
      expect(state.getEntityCount()).toBe(1);

      state.spawnEntity('player2', 'Test2', 'Rogue', 'friendly');
      expect(state.getEntityCount()).toBe(2);

      state.removeEntity('player1');
      expect(state.getEntityCount()).toBe(1);
    });

    it('gets all entities', () => {
      state.spawnEntity('player1', 'Test1', 'Mage', 'friendly');
      state.spawnEntity('player2', 'Test2', 'Rogue', 'enemy');

      const entities = state.getAllEntities();
      expect(entities).toHaveLength(2);
      expect(entities.map(e => e.id)).toContain('player1');
      expect(entities.map(e => e.id)).toContain('player2');
    });
  });

  describe('position/velocity', () => {
    beforeEach(() => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly', { x: 0, y: 0, z: 0 });
    });

    it('sets position', () => {
      state.setPosition('player1', { x: 5, y: 1, z: 10 });

      const entity = state.getEntity('player1');
      expect(entity?.pos).toEqual({ x: 5, y: 1, z: 10 });
    });

    it('sets velocity', () => {
      state.setVelocity('player1', { x: 1, y: 2, z: 3 });

      const entity = state.getEntity('player1');
      expect(entity?.vel).toEqual({ x: 1, y: 2, z: 3 });
    });

    it('sets yaw', () => {
      state.setYaw('player1', 1.57);

      const entity = state.getEntity('player1');
      expect(entity?.yaw).toBe(1.57);
    });

    it('returns false for non-existent entity', () => {
      expect(state.setPosition('nonexistent', { x: 0, y: 0, z: 0 })).toBe(false);
      expect(state.setVelocity('nonexistent', { x: 0, y: 0, z: 0 })).toBe(false);
      expect(state.setYaw('nonexistent', 0)).toBe(false);
    });
  });

  describe('health/damage', () => {
    beforeEach(() => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly');
    });

    it('applies damage', () => {
      const damage = state.applyDamage('player1', 30);

      expect(damage).toBe(30);
      expect(state.getEntity('player1')?.hp).toBe(70);
    });

    it('caps damage at current HP', () => {
      state.applyDamage('player1', 50);
      const damage = state.applyDamage('player1', 100);

      expect(damage).toBe(50);
      expect(state.getEntity('player1')?.hp).toBe(0);
    });

    it('applies heal', () => {
      state.applyDamage('player1', 50);
      const heal = state.applyHeal('player1', 30);

      expect(heal).toBe(30);
      expect(state.getEntity('player1')?.hp).toBe(80);
    });

    it('caps heal at max HP', () => {
      state.applyDamage('player1', 20);
      const heal = state.applyHeal('player1', 50);

      expect(heal).toBe(20);
      expect(state.getEntity('player1')?.hp).toBe(100);
    });

    it('returns 0 damage for non-existent entity', () => {
      expect(state.applyDamage('nonexistent', 50)).toBe(0);
    });

    it('returns 0 heal for non-existent entity', () => {
      expect(state.applyHeal('nonexistent', 50)).toBe(0);
    });
  });

  describe('kill/respawn', () => {
    beforeEach(() => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly', { x: 5, y: 0, z: 5 });
    });

    it('kills entity', () => {
      const killed = state.kill('player1');

      expect(killed).toBe(true);
      expect(state.getEntity('player1')?.alive).toBe(false);
      expect(state.getEntity('player1')?.hp).toBe(0);
    });

    it('sets respawnAt on kill', () => {
      state.setTick(50);
      state.kill('player1');

      const entity = state.getEntity('player1');
      expect(entity?.respawnAt).toBe(150); // 50 + 100 (5 seconds at 20Hz)
    });

    it('cannot kill already dead entity', () => {
      state.kill('player1');
      const killedAgain = state.kill('player1');

      expect(killedAgain).toBe(false);
    });

    it('respawns entity', () => {
      state.kill('player1');
      const spawnPos = state.respawn('player1');

      expect(spawnPos).not.toBeNull();
      expect(state.getEntity('player1')?.alive).toBe(true);
      expect(state.getEntity('player1')?.hp).toBe(100);
      expect(state.getEntity('player1')?.respawnAt).toBeNull();
    });

    it('cannot respawn alive entity', () => {
      const spawnPos = state.respawn('player1');
      expect(spawnPos).toBeNull();
    });

    it('clears debuffs on kill', () => {
      state.applyDebuff('player1', 'enemy1', {
        id: 'test',
        name: 'Test',
        duration: 10,
        tags: [],
      });
      expect(state.getDebuffs('player1')).toHaveLength(1);

      state.kill('player1');
      expect(state.getDebuffs('player1')).toHaveLength(0);
    });

    it('clears active cast on kill', () => {
      state.startCast('player1', 'test_ability', null, 30);
      expect(state.getActiveCast('player1')).not.toBeNull();

      state.kill('player1');
      expect(state.getActiveCast('player1')).toBeNull();
    });

    it('identifies entities pending respawn', () => {
      state.spawnEntity('player2', 'Test2', 'Rogue', 'friendly');

      state.setTick(0);
      state.kill('player1');
      state.kill('player2');

      // Not time yet
      state.setTick(50);
      expect(state.getEntitiesPendingRespawn()).toHaveLength(0);

      // Time for respawn
      state.setTick(100);
      expect(state.getEntitiesPendingRespawn()).toHaveLength(2);
    });
  });

  describe('cooldowns', () => {
    beforeEach(() => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly');
    });

    it('starts cooldown', () => {
      state.setTick(10);
      state.startCooldown('player1', 'ability1', 20);

      expect(state.isOnCooldown('player1', 'ability1')).toBe(true);
    });

    it('cooldown expires after duration', () => {
      state.setTick(10);
      state.startCooldown('player1', 'ability1', 20);

      state.setTick(29);
      expect(state.isOnCooldown('player1', 'ability1')).toBe(true);

      state.setTick(30);
      expect(state.isOnCooldown('player1', 'ability1')).toBe(false);
    });

    it('gets cooldown remaining', () => {
      state.setTick(10);
      state.startCooldown('player1', 'ability1', 20);

      expect(state.getCooldownRemaining('player1', 'ability1')).toBe(20);

      state.setTick(20);
      expect(state.getCooldownRemaining('player1', 'ability1')).toBe(10);

      state.setTick(30);
      expect(state.getCooldownRemaining('player1', 'ability1')).toBe(0);
    });

    it('returns false for ability not on cooldown', () => {
      expect(state.isOnCooldown('player1', 'ability1')).toBe(false);
    });
  });

  describe('debuffs', () => {
    beforeEach(() => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly');
      state.spawnEntity('enemy1', 'Enemy', 'Warrior', 'enemy');
    });

    it('applies debuff', () => {
      const debuff = state.applyDebuff('player1', 'enemy1', {
        id: 'slow',
        name: 'Slow',
        duration: 5,
        tags: ['slow'],
      });

      expect(debuff).not.toBeNull();
      expect(debuff?.id).toBe('slow');
      expect(state.getDebuffs('player1')).toHaveLength(1);
    });

    it('sets correct expiration', () => {
      state.setTick(10);
      state.applyDebuff('player1', 'enemy1', {
        id: 'slow',
        name: 'Slow',
        duration: 5, // 5 seconds = 100 ticks
        tags: ['slow'],
      });

      const debuffs = state.getDebuffs('player1');
      expect(debuffs[0].appliedAt).toBe(10);
      expect(debuffs[0].expiresAt).toBe(110);
    });

    it('refreshes existing debuff', () => {
      state.setTick(10);
      state.applyDebuff('player1', 'enemy1', {
        id: 'slow',
        name: 'Slow',
        duration: 5,
        tags: ['slow'],
      });

      state.setTick(50);
      state.applyDebuff('player1', 'enemy1', {
        id: 'slow',
        name: 'Slow',
        duration: 5,
        tags: ['slow'],
      });

      expect(state.getDebuffs('player1')).toHaveLength(1);
      expect(state.getDebuffs('player1')[0].appliedAt).toBe(50);
    });

    it('removes debuff', () => {
      state.applyDebuff('player1', 'enemy1', {
        id: 'slow',
        name: 'Slow',
        duration: 5,
        tags: ['slow'],
      });

      const removed = state.removeDebuff('player1', 'slow');
      expect(removed).toBe(true);
      expect(state.getDebuffs('player1')).toHaveLength(0);
    });

    it('checks for debuff with tag', () => {
      expect(state.hasDebuffWithTag('player1', 'cc')).toBe(false);

      state.applyDebuff('player1', 'enemy1', {
        id: 'stun',
        name: 'Stun',
        duration: 3,
        tags: ['cc', 'stun'],
      });

      expect(state.hasDebuffWithTag('player1', 'cc')).toBe(true);
      expect(state.hasDebuffWithTag('player1', 'stun')).toBe(true);
      expect(state.hasDebuffWithTag('player1', 'slow')).toBe(false);
    });

    it('removes expired debuffs', () => {
      state.setTick(0);
      state.applyDebuff('player1', 'enemy1', {
        id: 'short',
        name: 'Short',
        duration: 1, // 20 ticks
        tags: [],
      });
      state.applyDebuff('player1', 'enemy1', {
        id: 'long',
        name: 'Long',
        duration: 5, // 100 ticks
        tags: [],
      });

      state.setTick(20);
      const removed = state.removeExpiredDebuffs();

      expect(removed).toHaveLength(1);
      expect(removed[0].debuffId).toBe('short');
      expect(state.getDebuffs('player1')).toHaveLength(1);
      expect(state.getDebuffs('player1')[0].id).toBe('long');
    });
  });

  describe('active casts', () => {
    beforeEach(() => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly');
    });

    it('starts cast', () => {
      state.setTick(10);
      const cast = state.startCast('player1', 'frostbolt', 'target1', 30);

      expect(cast).not.toBeNull();
      expect(cast?.abilityId).toBe('frostbolt');
      expect(cast?.startTick).toBe(10);
      expect(cast?.endTick).toBe(40);
    });

    it('cannot start cast while already casting', () => {
      state.startCast('player1', 'frostbolt', 'target1', 30);
      const secondCast = state.startCast('player1', 'fireball', 'target1', 20);

      expect(secondCast).toBeNull();
    });

    it('cannot start cast while CC\'d', () => {
      state.applyDebuff('player1', 'enemy1', {
        id: 'stun',
        name: 'Stun',
        duration: 3,
        tags: ['cc'],
      });

      const cast = state.startCast('player1', 'frostbolt', 'target1', 30);
      expect(cast).toBeNull();
    });

    it('interrupts cast', () => {
      state.startCast('player1', 'frostbolt', 'target1', 30);
      const interrupted = state.interruptCast('player1');

      expect(interrupted?.abilityId).toBe('frostbolt');
      expect(state.getActiveCast('player1')).toBeNull();
    });

    it('gets completed casts', () => {
      state.setTick(10);
      state.startCast('player1', 'frostbolt', 'target1', 30);

      state.setTick(39);
      expect(state.getCompletedCasts()).toHaveLength(0);

      state.setTick(40);
      const completed = state.getCompletedCasts();
      expect(completed).toHaveLength(1);
      expect(completed[0].entityId).toBe('player1');
      expect(completed[0].cast.abilityId).toBe('frostbolt');
    });
  });

  describe('projectiles', () => {
    beforeEach(() => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly', { x: 0, y: 0, z: 5 });
      state.spawnEntity('enemy1', 'Enemy', 'Warrior', 'enemy', { x: 0, y: 0, z: -5 });
    });

    it('spawns projectile', () => {
      const proj = state.spawnProjectile(
        'frostbolt',
        'player1',
        'enemy1',
        { x: 0, y: 1, z: 5 },
        20
      );

      expect(proj.id).toBe(1);
      expect(proj.abilityId).toBe('frostbolt');
      expect(proj.sourceId).toBe('player1');
      expect(proj.targetId).toBe('enemy1');
      expect(proj.speed).toBe(20);
    });

    it('calculates velocity toward target', () => {
      const proj = state.spawnProjectile(
        'frostbolt',
        'player1',
        'enemy1',
        { x: 0, y: 1, z: 5 },
        20
      );

      // Target is at z=-5, start is at z=5, so velocity should be mostly negative Z
      expect(proj.vel.z).toBeLessThan(0);
      expect(Math.abs(proj.vel.x)).toBeLessThan(Math.abs(proj.vel.z));
    });

    it('assigns unique IDs', () => {
      const proj1 = state.spawnProjectile('fb1', 'player1', 'enemy1', { x: 0, y: 1, z: 0 }, 20);
      const proj2 = state.spawnProjectile('fb2', 'player1', 'enemy1', { x: 0, y: 1, z: 0 }, 20);

      expect(proj1.id).not.toBe(proj2.id);
    });

    it('removes projectile', () => {
      const proj = state.spawnProjectile('frostbolt', 'player1', 'enemy1', { x: 0, y: 1, z: 0 }, 20);

      expect(state.getAllProjectiles()).toHaveLength(1);

      state.removeProjectile(proj.id);
      expect(state.getAllProjectiles()).toHaveLength(0);
    });

    it('removes projectiles when entity is removed', () => {
      state.spawnProjectile('frostbolt', 'player1', 'enemy1', { x: 0, y: 1, z: 0 }, 20);
      expect(state.getAllProjectiles()).toHaveLength(1);

      state.removeEntity('player1');
      expect(state.getAllProjectiles()).toHaveLength(0);
    });
  });

  describe('snapshots', () => {
    beforeEach(() => {
      state.spawnEntity('player1', 'Test', 'Mage', 'friendly', { x: 1, y: 2, z: 3 });
    });

    it('builds entity snapshot', () => {
      const entity = state.getEntity('player1')!;
      const snapshot = state.buildEntitySnapshot(entity);

      expect(snapshot.id).toBe('player1');
      expect(snapshot.name).toBe('Test');
      expect(snapshot.class).toBe('Mage');
      expect(snapshot.team).toBe('friendly');
      expect(snapshot.pos).toEqual({ x: 1, y: 2, z: 3 });
      expect(snapshot.hp).toBe(100);
      expect(snapshot.alive).toBe(true);
      expect(snapshot.debuffs).toEqual([]);
      expect(snapshot.castingAbilityId).toBeNull();
    });

    it('includes debuffs in snapshot', () => {
      state.spawnEntity('enemy1', 'Enemy', 'Warrior', 'enemy');
      state.applyDebuff('player1', 'enemy1', {
        id: 'slow',
        name: 'Slow',
        duration: 5,
        tags: ['slow'],
      });

      const entity = state.getEntity('player1')!;
      const snapshot = state.buildEntitySnapshot(entity);

      expect(snapshot.debuffs).toEqual(['slow']);
    });

    it('includes cast progress in snapshot', () => {
      state.setTick(10);
      state.startCast('player1', 'frostbolt', 'target', 40);

      state.setTick(30);
      const entity = state.getEntity('player1')!;
      const snapshot = state.buildEntitySnapshot(entity);

      expect(snapshot.castingAbilityId).toBe('frostbolt');
      expect(snapshot.castProgress).toBe(0.5);
    });

    it('builds all entity snapshots', () => {
      state.spawnEntity('player2', 'Test2', 'Rogue', 'friendly');

      const snapshots = state.buildAllEntitySnapshots();
      expect(snapshots).toHaveLength(2);
    });

    it('builds projectile snapshot', () => {
      state.spawnEntity('enemy1', 'Enemy', 'Warrior', 'enemy');
      const proj = state.spawnProjectile('frostbolt', 'player1', 'enemy1', { x: 0, y: 1, z: 0 }, 20);

      const snapshot = state.buildProjectileSnapshot(proj);

      expect(snapshot.id).toBe(proj.id);
      expect(snapshot.abilityId).toBe('frostbolt');
      expect(snapshot.sourceId).toBe('player1');
      expect(snapshot.targetId).toBe('enemy1');
    });
  });
});
