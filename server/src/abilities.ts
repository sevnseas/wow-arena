/**
 * Server-side ability execution
 */

import type { ServerGameState, ActiveCast, Projectile } from './state';
import type { GameEvent } from '../../src/shared/protocol';
import {
  getAbilityById,
  MELEE_RANGE,
  FEAR_RADIUS,
  type AbilityMeta,
} from '../../src/shared/abilities';
import { SERVER_TICK_RATE } from '../../src/shared/physics';
import {
  vec3,
  vec3DistanceXZ,
  getPositionBehindTarget,
  getBlinkDestination,
  findValidPositionNear,
  updateProjectilePosition,
  checkProjectileHit,
} from './physics';

// ============================================================================
// Types
// ============================================================================

export interface AbilityExecutionResult {
  success: boolean;
  events: GameEvent[];
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const PROJECTILE_HIT_RADIUS = 0.5;
const FROSTBOLT_DAMAGE = 20;
const SMITE_DAMAGE = 15;
const HEMORRHAGE_DAMAGE = 25;
const HEAL_AMOUNT = 30;

// ============================================================================
// Ability Execution
// ============================================================================

/**
 * Execute an ability (called when input is validated)
 */
export function executeAbility(
  state: ServerGameState,
  casterId: string,
  abilityId: string,
  targetId: string | null
): AbilityExecutionResult {
  const events: GameEvent[] = [];
  const tick = state.getTick();

  const caster = state.getEntity(casterId);
  if (!caster || !caster.alive) {
    return { success: false, events, error: 'Caster not found or dead' };
  }

  const ability = getAbilityById(abilityId);
  if (!ability) {
    return { success: false, events, error: 'Unknown ability' };
  }

  // Instant abilities execute immediately
  if (ability.castTime === 0) {
    return executeInstantAbility(state, casterId, ability, targetId, events, tick);
  }

  // Cast-time abilities start a cast
  const castDurationTicks = Math.round(ability.castTime * SERVER_TICK_RATE);
  const cast = state.startCast(casterId, abilityId, targetId, castDurationTicks);

  if (!cast) {
    return { success: false, events, error: 'Cannot start cast' };
  }

  events.push({
    type: 'CastStarted',
    tick,
    casterId,
    abilityId,
    targetId,
    castTime: ability.castTime,
  });

  return { success: true, events };
}

/**
 * Execute an instant ability
 */
function executeInstantAbility(
  state: ServerGameState,
  casterId: string,
  ability: AbilityMeta,
  targetId: string | null,
  events: GameEvent[],
  tick: number
): AbilityExecutionResult {
  const caster = state.getEntity(casterId)!;

  // Start cooldown
  if (ability.cooldown > 0) {
    const cooldownTicks = Math.round(ability.cooldown * SERVER_TICK_RATE);
    state.startCooldown(casterId, ability.id, cooldownTicks);
  }

  switch (ability.id) {
    case 'rogue_shadowstep':
      return executeShadowstep(state, casterId, targetId, events, tick);

    case 'rogue_hemorrhage':
      return executeHemorrhage(state, casterId, targetId, events, tick);

    case 'rogue_blind':
      return executeBlind(state, casterId, targetId, events, tick);

    case 'mage_blink':
      return executeBlink(state, casterId, events, tick);

    case 'priest_fear':
      return executeFear(state, casterId, events, tick);

    default:
      return { success: false, events, error: `Unknown instant ability: ${ability.id}` };
  }
}

/**
 * Complete a cast (called when cast timer expires)
 */
export function completeCast(
  state: ServerGameState,
  casterId: string,
  cast: ActiveCast
): GameEvent[] {
  const events: GameEvent[] = [];
  const tick = state.getTick();

  // Clear the active cast
  state.interruptCast(casterId);

  const caster = state.getEntity(casterId);
  if (!caster || !caster.alive) {
    return events;
  }

  const ability = getAbilityById(cast.abilityId);
  if (!ability) {
    return events;
  }

  events.push({
    type: 'CastCompleted',
    tick,
    casterId,
    abilityId: cast.abilityId,
  });

  // Start cooldown
  if (ability.cooldown > 0) {
    const cooldownTicks = Math.round(ability.cooldown * SERVER_TICK_RATE);
    state.startCooldown(casterId, ability.id, cooldownTicks);
  }

  // Execute the ability effect
  switch (cast.abilityId) {
    case 'mage_frostbolt':
      executeFrostbolt(state, casterId, cast.targetId, events, tick);
      break;

    case 'mage_polymorph':
      executePolymorph(state, casterId, cast.targetId, events, tick);
      break;

    case 'priest_heal':
      executeHeal(state, casterId, cast.targetId, events, tick);
      break;

    case 'priest_smite':
      executeSmite(state, casterId, cast.targetId, events, tick);
      break;
  }

  return events;
}

// ============================================================================
// Instant Ability Implementations
// ============================================================================

function executeShadowstep(
  state: ServerGameState,
  casterId: string,
  targetId: string | null,
  events: GameEvent[],
  tick: number
): AbilityExecutionResult {
  if (!targetId) {
    return { success: false, events, error: 'Shadowstep requires target' };
  }

  const caster = state.getEntity(casterId)!;
  const target = state.getEntity(targetId);

  if (!target || !target.alive) {
    return { success: false, events, error: 'Target not found or dead' };
  }

  // Calculate position behind target (opposite side from caster)
  // Direction from caster to target, then place caster on far side of target
  const toTarget = vec3(
    target.pos.x - caster.pos.x,
    0,
    target.pos.z - caster.pos.z
  );
  const newPos = findValidPositionNear(target.pos, toTarget, 1.5);

  state.setPosition(casterId, newPos);

  return { success: true, events };
}

function executeHemorrhage(
  state: ServerGameState,
  casterId: string,
  targetId: string | null,
  events: GameEvent[],
  tick: number
): AbilityExecutionResult {
  if (!targetId) {
    return { success: false, events, error: 'Hemorrhage requires target' };
  }

  const target = state.getEntity(targetId);
  if (!target || !target.alive) {
    return { success: false, events, error: 'Target not found or dead' };
  }

  // Apply damage
  const actualDamage = state.applyDamage(targetId, HEMORRHAGE_DAMAGE);

  if (actualDamage > 0) {
    events.push({
      type: 'Damage',
      tick,
      sourceId: casterId,
      targetId,
      amount: actualDamage,
      abilityId: 'rogue_hemorrhage',
    });

    // Check for kill (HP reached 0)
    const targetAfter = state.getEntity(targetId);
    if (targetAfter && targetAfter.hp <= 0 && targetAfter.alive) {
      state.kill(targetId);
      events.push({
        type: 'Death',
        tick,
        entityId: targetId,
        killerId: casterId,
      });
    }
  }

  return { success: true, events };
}

function executeBlind(
  state: ServerGameState,
  casterId: string,
  targetId: string | null,
  events: GameEvent[],
  tick: number
): AbilityExecutionResult {
  if (!targetId) {
    return { success: false, events, error: 'Blind requires target' };
  }

  const ability = getAbilityById('rogue_blind')!;
  if (!ability.debuff) {
    return { success: false, events, error: 'Blind has no debuff defined' };
  }

  const debuff = state.applyDebuff(targetId, casterId, ability.debuff);

  if (debuff) {
    events.push({
      type: 'DebuffApplied',
      tick,
      sourceId: casterId,
      targetId,
      debuffId: debuff.id,
      duration: ability.debuff.duration,
    });
  }

  return { success: true, events };
}

function executeBlink(
  state: ServerGameState,
  casterId: string,
  events: GameEvent[],
  tick: number
): AbilityExecutionResult {
  const caster = state.getEntity(casterId)!;
  const newPos = getBlinkDestination(caster.pos, caster.yaw, 8);

  state.setPosition(casterId, newPos);

  return { success: true, events };
}

function executeFear(
  state: ServerGameState,
  casterId: string,
  events: GameEvent[],
  tick: number
): AbilityExecutionResult {
  const caster = state.getEntity(casterId)!;
  const ability = getAbilityById('priest_fear')!;

  if (!ability.debuff) {
    return { success: false, events, error: 'Fear has no debuff defined' };
  }

  // Find all enemies within FEAR_RADIUS
  for (const entity of state.getAllEntities()) {
    if (entity.id === casterId) continue;
    if (entity.team === caster.team) continue;
    if (!entity.alive) continue;

    const dist = vec3DistanceXZ(caster.pos, entity.pos);
    if (dist <= FEAR_RADIUS) {
      const debuff = state.applyDebuff(entity.id, casterId, ability.debuff);

      if (debuff) {
        events.push({
          type: 'DebuffApplied',
          tick,
          sourceId: casterId,
          targetId: entity.id,
          debuffId: debuff.id,
          duration: ability.debuff.duration,
        });
      }
    }
  }

  return { success: true, events };
}

// ============================================================================
// Cast Ability Implementations
// ============================================================================

function executeFrostbolt(
  state: ServerGameState,
  casterId: string,
  targetId: string | null,
  events: GameEvent[],
  tick: number
): void {
  if (!targetId) return;

  const caster = state.getEntity(casterId);
  const target = state.getEntity(targetId);

  if (!caster || !target) return;

  const ability = getAbilityById('mage_frostbolt')!;
  const startPos = vec3(caster.pos.x, 1, caster.pos.z);

  const projectile = state.spawnProjectile(
    'mage_frostbolt',
    casterId,
    targetId,
    startPos,
    ability.projectileSpeed ?? 20
  );

  events.push({
    type: 'ProjectileSpawned',
    tick,
    projectileId: projectile.id,
    abilityId: 'mage_frostbolt',
    sourceId: casterId,
    targetId,
    startPos,
    speed: ability.projectileSpeed ?? 20,
  });
}

function executePolymorph(
  state: ServerGameState,
  casterId: string,
  targetId: string | null,
  events: GameEvent[],
  tick: number
): void {
  if (!targetId) return;

  const ability = getAbilityById('mage_polymorph')!;
  if (!ability.debuff) return;

  const debuff = state.applyDebuff(targetId, casterId, ability.debuff);

  if (debuff) {
    events.push({
      type: 'DebuffApplied',
      tick,
      sourceId: casterId,
      targetId,
      debuffId: debuff.id,
      duration: ability.debuff.duration,
    });
  }
}

function executeHeal(
  state: ServerGameState,
  casterId: string,
  targetId: string | null,
  events: GameEvent[],
  tick: number
): void {
  if (!targetId) return;

  const target = state.getEntity(targetId);
  if (!target || !target.alive) return;

  const actualHeal = state.applyHeal(targetId, HEAL_AMOUNT);

  if (actualHeal > 0) {
    events.push({
      type: 'Heal',
      tick,
      sourceId: casterId,
      targetId,
      amount: actualHeal,
      abilityId: 'priest_heal',
    });
  }
}

function executeSmite(
  state: ServerGameState,
  casterId: string,
  targetId: string | null,
  events: GameEvent[],
  tick: number
): void {
  if (!targetId) return;

  const caster = state.getEntity(casterId);
  const target = state.getEntity(targetId);

  if (!caster || !target) return;

  const ability = getAbilityById('priest_smite')!;
  const startPos = vec3(caster.pos.x, 1, caster.pos.z);

  const projectile = state.spawnProjectile(
    'priest_smite',
    casterId,
    targetId,
    startPos,
    ability.projectileSpeed ?? 15
  );

  events.push({
    type: 'ProjectileSpawned',
    tick,
    projectileId: projectile.id,
    abilityId: 'priest_smite',
    sourceId: casterId,
    targetId,
    startPos,
    speed: ability.projectileSpeed ?? 15,
  });
}

// ============================================================================
// Projectile Updates
// ============================================================================

/**
 * Update all projectiles and check for hits
 */
export function updateProjectiles(
  state: ServerGameState,
  dt: number
): GameEvent[] {
  const events: GameEvent[] = [];
  const tick = state.getTick();
  const projectilesToRemove: number[] = [];

  for (const proj of state.getAllProjectiles()) {
    const target = state.getEntity(proj.targetId);

    // Remove if target is gone or dead
    if (!target || !target.alive) {
      projectilesToRemove.push(proj.id);
      continue;
    }

    // Update position
    const targetPos = vec3(target.pos.x, 1, target.pos.z);
    const newPos = updateProjectilePosition(proj.pos, proj.vel, targetPos, proj.speed, dt);
    proj.pos = newPos;

    // Check for hit
    if (checkProjectileHit(proj.pos, targetPos, PROJECTILE_HIT_RADIUS)) {
      // Hit!
      events.push({
        type: 'ProjectileHit',
        tick,
        projectileId: proj.id,
        targetId: proj.targetId,
      });

      // Apply damage based on ability
      let damage = 0;
      if (proj.abilityId === 'mage_frostbolt') {
        damage = FROSTBOLT_DAMAGE;
      } else if (proj.abilityId === 'priest_smite') {
        damage = SMITE_DAMAGE;
      }

      if (damage > 0) {
        const actualDamage = state.applyDamage(proj.targetId, damage);

        if (actualDamage > 0) {
          events.push({
            type: 'Damage',
            tick,
            sourceId: proj.sourceId,
            targetId: proj.targetId,
            amount: actualDamage,
            abilityId: proj.abilityId,
          });

          // Check for kill
          const targetAfter = state.getEntity(proj.targetId);
          if (targetAfter && targetAfter.hp <= 0 && targetAfter.alive) {
            state.kill(proj.targetId);
            events.push({
              type: 'Death',
              tick,
              entityId: proj.targetId,
              killerId: proj.sourceId,
            });
          }
        }
      }

      projectilesToRemove.push(proj.id);
      continue;
    }

    // Check for timeout
    const age = tick - proj.spawnTick;
    if (age > proj.maxLifetimeTicks) {
      projectilesToRemove.push(proj.id);
    }
  }

  // Remove finished projectiles
  for (const id of projectilesToRemove) {
    state.removeProjectile(id);
  }

  return events;
}

// ============================================================================
// Debuff Updates
// ============================================================================

/**
 * Update debuffs and remove expired ones
 */
export function updateDebuffs(state: ServerGameState): GameEvent[] {
  const events: GameEvent[] = [];
  const tick = state.getTick();

  const removed = state.removeExpiredDebuffs();

  for (const { entityId, debuffId } of removed) {
    events.push({
      type: 'DebuffRemoved',
      tick,
      targetId: entityId,
      debuffId,
    });
  }

  return events;
}

// ============================================================================
// Respawn Updates
// ============================================================================

/**
 * Check for and process respawns
 */
export function updateRespawns(state: ServerGameState): GameEvent[] {
  const events: GameEvent[] = [];
  const tick = state.getTick();

  for (const entity of state.getEntitiesPendingRespawn()) {
    const pos = state.respawn(entity.id);

    if (pos) {
      events.push({
        type: 'Respawn',
        tick,
        entityId: entity.id,
        pos,
      });
    }
  }

  return events;
}
