/**
 * Core Game Systems - Cooldowns, Debuffs, Casting, Projectiles
 */

import * as THREE from 'three';

// ============================================================================
// Cooldown Manager
// ============================================================================

export class CooldownManager {
  private cooldowns: Map<string, number> = new Map(); // abilityId -> expiresAt

  startCooldown(abilityId: string, seconds: number): void {
    this.cooldowns.set(abilityId, Date.now() + seconds * 1000);
  }

  getRemaining(abilityId: string): number {
    const expiresAt = this.cooldowns.get(abilityId);
    if (!expiresAt) return 0;
    return Math.max(0, (expiresAt - Date.now()) / 1000);
  }

  isReady(abilityId: string): boolean {
    return this.getRemaining(abilityId) <= 0;
  }

  reset(abilityId: string): void {
    this.cooldowns.delete(abilityId);
  }

  resetAll(): void {
    this.cooldowns.clear();
  }
}

// ============================================================================
// Debuff System
// ============================================================================

export interface Debuff {
  id: string;
  name: string;
  duration: number;
  expiresAt: number;
  tags: string[];
}

export class DebuffManager {
  private debuffs: Map<string, Debuff[]> = new Map(); // entityId -> debuffs

  applyDebuff(entityId: string, debuff: Omit<Debuff, 'expiresAt'>): void {
    if (!this.debuffs.has(entityId)) {
      this.debuffs.set(entityId, []);
    }
    const list = this.debuffs.get(entityId)!;

    // Remove existing debuff with same id (refresh)
    const idx = list.findIndex(d => d.id === debuff.id);
    if (idx >= 0) list.splice(idx, 1);

    list.push({
      ...debuff,
      expiresAt: Date.now() + debuff.duration * 1000
    });
  }

  hasDebuff(entityId: string, debuffId: string): boolean {
    const list = this.debuffs.get(entityId);
    if (!list) return false;
    return list.some(d => d.id === debuffId && d.expiresAt > Date.now());
  }

  getDebuffs(entityId: string): Debuff[] {
    const list = this.debuffs.get(entityId);
    if (!list) return [];
    return list.filter(d => d.expiresAt > Date.now());
  }

  getDebuffRemaining(entityId: string, debuffId: string): number {
    const list = this.debuffs.get(entityId);
    if (!list) return 0;
    const debuff = list.find(d => d.id === debuffId);
    if (!debuff) return 0;
    return Math.max(0, (debuff.expiresAt - Date.now()) / 1000);
  }

  removeDebuff(entityId: string, debuffId: string): void {
    const list = this.debuffs.get(entityId);
    if (!list) return;
    const idx = list.findIndex(d => d.id === debuffId);
    if (idx >= 0) list.splice(idx, 1);
  }

  update(): void {
    const now = Date.now();
    for (const [entityId, list] of this.debuffs) {
      const filtered = list.filter(d => d.expiresAt > now);
      if (filtered.length === 0) {
        this.debuffs.delete(entityId);
      } else {
        this.debuffs.set(entityId, filtered);
      }
    }
  }

  clear(entityId: string): void {
    this.debuffs.delete(entityId);
  }

  clearAll(): void {
    this.debuffs.clear();
  }
}

// ============================================================================
// Cast System
// ============================================================================

export interface CastInfo {
  abilityId: string;
  abilityName: string;
  castTime: number;
  startedAt: number;
  targetId: string | null;
  onComplete: () => void;
}

export class CastSystem {
  private currentCast: CastInfo | null = null;

  get isCasting(): boolean {
    return this.currentCast !== null;
  }

  get castProgress(): number {
    if (!this.currentCast) return 0;
    const elapsed = (Date.now() - this.currentCast.startedAt) / 1000;
    return Math.min(1, elapsed / this.currentCast.castTime);
  }

  get currentCastInfo(): CastInfo | null {
    return this.currentCast;
  }

  beginCast(info: Omit<CastInfo, 'startedAt'>): boolean {
    if (this.isCasting) return false;

    this.currentCast = {
      ...info,
      startedAt: Date.now()
    };
    return true;
  }

  interrupt(): void {
    this.currentCast = null;
  }

  update(): void {
    if (!this.currentCast) return;

    const elapsed = (Date.now() - this.currentCast.startedAt) / 1000;
    if (elapsed >= this.currentCast.castTime) {
      const onComplete = this.currentCast.onComplete;
      this.currentCast = null;
      onComplete();
    }
  }
}

// ============================================================================
// Projectile System
// ============================================================================

export interface Projectile {
  id: number;
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  targetPos: THREE.Vector3;
  targetId: string | null;
  speed: number;
  maxLifetime: number;
  createdAt: number;
  onHit: () => void;
}

export class ProjectileSystem {
  private projectiles: Projectile[] = [];
  private nextId = 0;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  spawn(
    startPos: THREE.Vector3,
    targetPos: THREE.Vector3,
    targetId: string | null,
    speed: number,
    color: number,
    onHit: () => void
  ): void {
    const geometry = new THREE.SphereGeometry(0.15, 8, 8);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(startPos);
    this.scene.add(mesh);

    const direction = targetPos.clone().sub(startPos).normalize();

    this.projectiles.push({
      id: this.nextId++,
      mesh,
      velocity: direction.multiplyScalar(speed),
      targetPos: targetPos.clone(),
      targetId,
      speed,
      maxLifetime: 5,
      createdAt: Date.now(),
      onHit
    });
  }

  update(dt: number): void {
    const now = Date.now();
    const toRemove: Projectile[] = [];

    for (const proj of this.projectiles) {
      // Move projectile
      proj.mesh.position.addScaledVector(proj.velocity, dt);

      // Check if hit target (distance threshold)
      const distToTarget = proj.mesh.position.distanceTo(proj.targetPos);
      if (distToTarget < 0.5) {
        proj.onHit();
        toRemove.push(proj);
        continue;
      }

      // Check lifetime
      const age = (now - proj.createdAt) / 1000;
      if (age > proj.maxLifetime) {
        toRemove.push(proj);
      }
    }

    // Remove finished projectiles
    for (const proj of toRemove) {
      this.scene.remove(proj.mesh);
      proj.mesh.geometry.dispose();
      (proj.mesh.material as THREE.Material).dispose();
      const idx = this.projectiles.indexOf(proj);
      if (idx >= 0) this.projectiles.splice(idx, 1);
    }
  }

  clear(): void {
    for (const proj of this.projectiles) {
      this.scene.remove(proj.mesh);
      proj.mesh.geometry.dispose();
      (proj.mesh.material as THREE.Material).dispose();
    }
    this.projectiles = [];
  }
}
