/**
 * Shared types for client and server
 * No Three.js dependencies allowed here
 */

// Vector3 as plain object (no Three.js)
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Team affiliation
export type Team = 'friendly' | 'enemy';

// Player classes
export type ClassName = 'Rogue' | 'Mage' | 'Priest' | 'Warrior' | 'Druid' | 'Shaman';

// Entity definition (for spawning)
export interface EntityDef {
  id: string;
  name: string;
  team: Team;
  position: [number, number, number];
  class: ClassName;
}

// Collider shapes (for physics)
export interface CylinderCollider {
  type: 'cylinder';
  x: number;
  z: number;
  radius: number;
  height: number;
}

export interface BoxCollider {
  type: 'box';
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
}

export type Collider = CylinderCollider | BoxCollider;

// Debuff tags
export type DebuffTag = 'cc' | 'incapacitate' | 'stun' | 'slow' | 'dot' | 'silence';

// Debuff definition
export interface DebuffDef {
  id: string;
  name: string;
  duration: number;
  tags: DebuffTag[];
}

// Runtime debuff instance (with timing)
export interface Debuff extends DebuffDef {
  appliedAt: number; // server tick or timestamp
  expiresAt: number;
  sourceId: string;
}

// Entity state snapshot (for network sync)
export interface EntitySnapshot {
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
  debuffs: string[]; // debuff IDs currently active
  castingAbilityId: string | null;
  castProgress: number; // 0-1, only valid if castingAbilityId set
}

// Projectile state snapshot
export interface ProjectileSnapshot {
  id: number;
  abilityId: string;
  sourceId: string;
  targetId: string;
  pos: Vec3;
  vel: Vec3;
}
