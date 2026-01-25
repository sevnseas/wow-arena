/**
 * Server Game State - authoritative state for all entities
 */

import type {
  Vec3,
  ClassName,
  Team,
  Debuff,
  DebuffDef,
  EntitySnapshot,
  ProjectileSnapshot,
} from '../../src/shared/types';
import { FRIENDLY_SPAWNS, ENEMY_SPAWNS } from '../../src/shared/physics';

// ============================================================================
// Types
// ============================================================================

export interface EntityState {
  id: string;
  name: string;
  class: ClassName;
  team: Team;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  respawnAt: number | null; // tick when entity respawns, null if alive
}

export interface ActiveCast {
  abilityId: string;
  targetId: string | null;
  startTick: number;
  endTick: number;
}

export interface Projectile {
  id: number;
  abilityId: string;
  sourceId: string;
  targetId: string;
  pos: Vec3;
  vel: Vec3;
  speed: number;
  spawnTick: number;
  maxLifetimeTicks: number;
}

// ============================================================================
// ServerGameState
// ============================================================================

export class ServerGameState {
  // Entity data
  private entities: Map<string, EntityState> = new Map();

  // Combat state
  private cooldowns: Map<string, Map<string, number>> = new Map(); // entityId -> (abilityId -> readyAtTick)
  private debuffs: Map<string, Debuff[]> = new Map(); // entityId -> debuffs
  private activeCasts: Map<string, ActiveCast | null> = new Map(); // entityId -> active cast

  // Projectiles
  private projectiles: Map<number, Projectile> = new Map();
  private nextProjectileId: number = 1;

  // Timing
  private currentTick: number = 0;

  // Respawn
  private respawnDelayTicks: number = 100; // 5 seconds at 20Hz
  private friendlySpawnIndex: number = 0;
  private enemySpawnIndex: number = 0;

  // ============================================================================
  // Tick management
  // ============================================================================

  getTick(): number {
    return this.currentTick;
  }

  setTick(tick: number): void {
    this.currentTick = tick;
  }

  advanceTick(): void {
    this.currentTick++;
  }

  // ============================================================================
  // Entity management
  // ============================================================================

  spawnEntity(
    id: string,
    name: string,
    className: ClassName,
    team: Team,
    pos?: Vec3
  ): EntityState {
    // Use provided position or get spawn position
    const spawnPos = pos ?? this.getSpawnPosition(team);

    const entity: EntityState = {
      id,
      name,
      class: className,
      team,
      pos: { ...spawnPos },
      vel: { x: 0, y: 0, z: 0 },
      yaw: team === 'friendly' ? 0 : Math.PI, // Face center
      hp: 100,
      maxHp: 100,
      alive: true,
      respawnAt: null,
    };

    this.entities.set(id, entity);
    this.cooldowns.set(id, new Map());
    this.debuffs.set(id, []);
    this.activeCasts.set(id, null);

    return entity;
  }

  removeEntity(id: string): boolean {
    if (!this.entities.has(id)) return false;

    this.entities.delete(id);
    this.cooldowns.delete(id);
    this.debuffs.delete(id);
    this.activeCasts.delete(id);

    // Remove projectiles from/to this entity
    for (const [projId, proj] of this.projectiles) {
      if (proj.sourceId === id || proj.targetId === id) {
        this.projectiles.delete(projId);
      }
    }

    return true;
  }

  getEntity(id: string): EntityState | undefined {
    return this.entities.get(id);
  }

  getAllEntities(): EntityState[] {
    return Array.from(this.entities.values());
  }

  getEntityCount(): number {
    return this.entities.size;
  }

  hasEntity(id: string): boolean {
    return this.entities.has(id);
  }

  // ============================================================================
  // Position/velocity
  // ============================================================================

  setPosition(id: string, pos: Vec3): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    entity.pos = { ...pos };
    return true;
  }

  setVelocity(id: string, vel: Vec3): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    entity.vel = { ...vel };
    return true;
  }

  setYaw(id: string, yaw: number): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    entity.yaw = yaw;
    return true;
  }

  // ============================================================================
  // Health/damage
  // ============================================================================

  applyDamage(id: string, amount: number): number {
    const entity = this.entities.get(id);
    if (!entity || !entity.alive) return 0;

    const actualDamage = Math.min(entity.hp, amount);
    entity.hp -= actualDamage;

    return actualDamage;
  }

  applyHeal(id: string, amount: number): number {
    const entity = this.entities.get(id);
    if (!entity || !entity.alive) return 0;

    const actualHeal = Math.min(entity.maxHp - entity.hp, amount);
    entity.hp += actualHeal;

    return actualHeal;
  }

  kill(id: string): boolean {
    const entity = this.entities.get(id);
    if (!entity || !entity.alive) return false;

    entity.alive = false;
    entity.hp = 0;
    entity.respawnAt = this.currentTick + this.respawnDelayTicks;

    // Clear combat state
    this.activeCasts.set(id, null);
    this.debuffs.set(id, []);

    return true;
  }

  respawn(id: string): Vec3 | null {
    const entity = this.entities.get(id);
    if (!entity || entity.alive) return null;

    const spawnPos = this.getSpawnPosition(entity.team);

    entity.alive = true;
    entity.hp = entity.maxHp;
    entity.pos = { ...spawnPos };
    entity.vel = { x: 0, y: 0, z: 0 };
    entity.respawnAt = null;

    // Clear cooldowns on respawn
    this.cooldowns.set(id, new Map());

    return spawnPos;
  }

  getEntitiesPendingRespawn(): EntityState[] {
    return this.getAllEntities().filter(
      e => !e.alive && e.respawnAt !== null && e.respawnAt <= this.currentTick
    );
  }

  // ============================================================================
  // Cooldowns
  // ============================================================================

  startCooldown(entityId: string, abilityId: string, durationTicks: number): void {
    const entityCooldowns = this.cooldowns.get(entityId);
    if (!entityCooldowns) return;

    entityCooldowns.set(abilityId, this.currentTick + durationTicks);
  }

  isOnCooldown(entityId: string, abilityId: string): boolean {
    const entityCooldowns = this.cooldowns.get(entityId);
    if (!entityCooldowns) return false;

    const readyAt = entityCooldowns.get(abilityId);
    if (readyAt === undefined) return false;

    return this.currentTick < readyAt;
  }

  getCooldownRemaining(entityId: string, abilityId: string): number {
    const entityCooldowns = this.cooldowns.get(entityId);
    if (!entityCooldowns) return 0;

    const readyAt = entityCooldowns.get(abilityId);
    if (readyAt === undefined) return 0;

    return Math.max(0, readyAt - this.currentTick);
  }

  // ============================================================================
  // Debuffs
  // ============================================================================

  applyDebuff(
    targetId: string,
    sourceId: string,
    debuffDef: DebuffDef
  ): Debuff | null {
    const targetDebuffs = this.debuffs.get(targetId);
    if (!targetDebuffs) return null;

    const entity = this.entities.get(targetId);
    if (!entity || !entity.alive) return null;

    // Check if debuff already exists (refresh it)
    const existingIndex = targetDebuffs.findIndex(d => d.id === debuffDef.id);

    const durationTicks = Math.round(debuffDef.duration * 20); // Convert seconds to ticks
    const debuff: Debuff = {
      ...debuffDef,
      appliedAt: this.currentTick,
      expiresAt: this.currentTick + durationTicks,
      sourceId,
    };

    if (existingIndex >= 0) {
      // Refresh existing debuff
      targetDebuffs[existingIndex] = debuff;
    } else {
      // Add new debuff
      targetDebuffs.push(debuff);
    }

    return debuff;
  }

  removeDebuff(targetId: string, debuffId: string): boolean {
    const targetDebuffs = this.debuffs.get(targetId);
    if (!targetDebuffs) return false;

    const index = targetDebuffs.findIndex(d => d.id === debuffId);
    if (index < 0) return false;

    targetDebuffs.splice(index, 1);
    return true;
  }

  getDebuffs(entityId: string): Debuff[] {
    return this.debuffs.get(entityId) ?? [];
  }

  hasDebuffWithTag(entityId: string, tag: string): boolean {
    const debuffs = this.debuffs.get(entityId);
    if (!debuffs) return false;

    return debuffs.some(d => d.tags.includes(tag as any));
  }

  getExpiredDebuffs(): Array<{ entityId: string; debuff: Debuff }> {
    const expired: Array<{ entityId: string; debuff: Debuff }> = [];

    for (const [entityId, debuffs] of this.debuffs) {
      for (const debuff of debuffs) {
        if (debuff.expiresAt <= this.currentTick) {
          expired.push({ entityId, debuff });
        }
      }
    }

    return expired;
  }

  removeExpiredDebuffs(): Array<{ entityId: string; debuffId: string }> {
    const removed: Array<{ entityId: string; debuffId: string }> = [];

    for (const [entityId, debuffs] of this.debuffs) {
      for (let i = debuffs.length - 1; i >= 0; i--) {
        if (debuffs[i].expiresAt <= this.currentTick) {
          removed.push({ entityId, debuffId: debuffs[i].id });
          debuffs.splice(i, 1);
        }
      }
    }

    return removed;
  }

  // ============================================================================
  // Active casts
  // ============================================================================

  startCast(
    entityId: string,
    abilityId: string,
    targetId: string | null,
    durationTicks: number
  ): ActiveCast | null {
    const entity = this.entities.get(entityId);
    if (!entity || !entity.alive) return null;

    // Can't start cast if already casting
    if (this.activeCasts.get(entityId)) return null;

    // Can't cast while CC'd
    if (this.hasDebuffWithTag(entityId, 'cc')) return null;

    const cast: ActiveCast = {
      abilityId,
      targetId,
      startTick: this.currentTick,
      endTick: this.currentTick + durationTicks,
    };

    this.activeCasts.set(entityId, cast);
    return cast;
  }

  interruptCast(entityId: string): ActiveCast | null {
    const cast = this.activeCasts.get(entityId);
    if (!cast) return null;

    this.activeCasts.set(entityId, null);
    return cast;
  }

  getActiveCast(entityId: string): ActiveCast | null {
    return this.activeCasts.get(entityId) ?? null;
  }

  getCompletedCasts(): Array<{ entityId: string; cast: ActiveCast }> {
    const completed: Array<{ entityId: string; cast: ActiveCast }> = [];

    for (const [entityId, cast] of this.activeCasts) {
      if (cast && cast.endTick <= this.currentTick) {
        completed.push({ entityId, cast });
      }
    }

    return completed;
  }

  // ============================================================================
  // Projectiles
  // ============================================================================

  spawnProjectile(
    abilityId: string,
    sourceId: string,
    targetId: string,
    startPos: Vec3,
    speed: number
  ): Projectile {
    const id = this.nextProjectileId++;

    const target = this.entities.get(targetId);
    const targetPos = target?.pos ?? startPos;

    // Calculate initial velocity toward target
    const dx = targetPos.x - startPos.x;
    const dy = targetPos.y - startPos.y;
    const dz = targetPos.z - startPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const vel: Vec3 = dist > 0.001
      ? { x: (dx / dist) * speed, y: (dy / dist) * speed, z: (dz / dist) * speed }
      : { x: 0, y: 0, z: speed };

    const projectile: Projectile = {
      id,
      abilityId,
      sourceId,
      targetId,
      pos: { ...startPos },
      vel,
      speed,
      spawnTick: this.currentTick,
      maxLifetimeTicks: 100, // 5 seconds
    };

    this.projectiles.set(id, projectile);
    return projectile;
  }

  removeProjectile(id: number): boolean {
    return this.projectiles.delete(id);
  }

  getProjectile(id: number): Projectile | undefined {
    return this.projectiles.get(id);
  }

  getAllProjectiles(): Projectile[] {
    return Array.from(this.projectiles.values());
  }

  // ============================================================================
  // Snapshots
  // ============================================================================

  buildEntitySnapshot(entity: EntityState): EntitySnapshot {
    const debuffs = this.debuffs.get(entity.id) ?? [];
    const cast = this.activeCasts.get(entity.id);

    let castProgress = 0;
    if (cast) {
      const totalTicks = cast.endTick - cast.startTick;
      const elapsedTicks = this.currentTick - cast.startTick;
      castProgress = totalTicks > 0 ? Math.min(1, elapsedTicks / totalTicks) : 1;
    }

    return {
      id: entity.id,
      name: entity.name,
      class: entity.class,
      team: entity.team,
      pos: { ...entity.pos },
      vel: { ...entity.vel },
      yaw: entity.yaw,
      hp: entity.hp,
      maxHp: entity.maxHp,
      alive: entity.alive,
      debuffs: debuffs.map(d => d.id),
      castingAbilityId: cast?.abilityId ?? null,
      castProgress,
    };
  }

  buildAllEntitySnapshots(): EntitySnapshot[] {
    return this.getAllEntities().map(e => this.buildEntitySnapshot(e));
  }

  buildProjectileSnapshot(proj: Projectile): ProjectileSnapshot {
    return {
      id: proj.id,
      abilityId: proj.abilityId,
      sourceId: proj.sourceId,
      targetId: proj.targetId,
      pos: { ...proj.pos },
      vel: { ...proj.vel },
    };
  }

  buildAllProjectileSnapshots(): ProjectileSnapshot[] {
    return this.getAllProjectiles().map(p => this.buildProjectileSnapshot(p));
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private getSpawnPosition(team: Team): Vec3 {
    const spawns = team === 'friendly' ? FRIENDLY_SPAWNS : ENEMY_SPAWNS;
    const index = team === 'friendly'
      ? this.friendlySpawnIndex++ % spawns.length
      : this.enemySpawnIndex++ % spawns.length;

    const [x, y, z] = spawns[index];
    return { x, y, z };
  }
}
