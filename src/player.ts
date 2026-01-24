/**
 * PlayerController - Handles player movement and physics
 */

import * as THREE from 'three';
import { yawToDir, assertFiniteVec3, prettyVec } from './coords';
import type { Collider, CylinderCollider, BoxCollider } from './arena';

export interface PlayerConfig {
  moveSpeed: number;
  jumpForce: number;
  gravity: number;
  groundY: number;
  radius: number; // Player collision radius
}

const DEFAULT_CONFIG: PlayerConfig = {
  moveSpeed: 6,
  jumpForce: 8,
  gravity: 20,
  groundY: 0,
  radius: 0.35
};

export class PlayerController {
  public position: THREE.Vector3;
  public velocity: THREE.Vector3;
  public mesh: THREE.Object3D | null = null;

  private config: PlayerConfig;
  private isGrounded: boolean = true;
  private groundLevel: number = 0; // Current ground height (can be on box)
  private colliders: Collider[] = [];

  // Input state
  private keys: Set<string> = new Set();

  constructor(
    startPosition: THREE.Vector3,
    config: Partial<PlayerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.position = startPosition.clone();
    this.velocity = new THREE.Vector3();
    this.groundLevel = this.config.groundY;

    // Bind event handlers
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
  }

  /**
   * Set colliders for collision detection
   */
  setColliders(colliders: Collider[]): void {
    this.colliders = colliders;
  }

  /**
   * Attach keyboard event listeners
   */
  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  /**
   * Detach keyboard event listeners
   */
  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.keys.add(e.code.toLowerCase());

    // Jump on space
    if (e.code === 'Space' && this.isGrounded) {
      this.velocity.y = this.config.jumpForce;
      this.isGrounded = false;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code.toLowerCase());
  }

  /**
   * Check if a key is pressed
   */
  isKeyPressed(code: string): boolean {
    return this.keys.has(code.toLowerCase());
  }

  /**
   * Get movement input as a normalized vector
   */
  getInputDirection(): THREE.Vector3 {
    const input = new THREE.Vector3();

    if (this.isKeyPressed('keyw') || this.isKeyPressed('arrowup')) {
      input.z -= 1;
    }
    if (this.isKeyPressed('keys') || this.isKeyPressed('arrowdown')) {
      input.z += 1;
    }
    if (this.isKeyPressed('keya') || this.isKeyPressed('arrowleft')) {
      input.x -= 1;
    }
    if (this.isKeyPressed('keyd') || this.isKeyPressed('arrowright')) {
      input.x += 1;
    }

    if (input.lengthSq() > 0) {
      input.normalize();
    }

    return input;
  }

  /**
   * Update player physics and position
   * @param deltaTime Time since last frame in seconds
   * @param cameraYaw Current camera yaw for movement direction
   */
  update(deltaTime: number, cameraYaw: number): void {
    // Get input in local space
    const input = this.getInputDirection();

    if (input.lengthSq() > 0) {
      // Transform input direction by camera yaw
      // Forward (-Z in local) should be camera forward direction
      const forward = yawToDir(cameraYaw);
      const right = new THREE.Vector3(-forward.z, 0, forward.x);

      // Calculate world-space movement direction
      const moveDir = new THREE.Vector3()
        .addScaledVector(right, input.x)
        .addScaledVector(forward, -input.z); // Negate because input.z < 0 means forward

      moveDir.normalize();

      // Apply horizontal movement
      this.velocity.x = moveDir.x * this.config.moveSpeed;
      this.velocity.z = moveDir.z * this.config.moveSpeed;
    } else {
      // No input - stop horizontal movement
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    // Apply gravity
    if (!this.isGrounded) {
      this.velocity.y -= this.config.gravity * deltaTime;
    }

    // Update position
    this.position.addScaledVector(this.velocity, deltaTime);

    // Resolve collisions (with wall sliding)
    this.resolveCollisions();

    // Ground check
    if (this.position.y <= this.groundLevel) {
      this.position.y = this.groundLevel;
      this.velocity.y = 0;
      this.isGrounded = true;
    } else {
      // Above ground - falling
      this.isGrounded = false;
    }

    // Keep in arena bounds
    const bound = 18;
    this.position.x = Math.max(-bound, Math.min(bound, this.position.x));
    this.position.z = Math.max(-bound, Math.min(bound, this.position.z));

    // Update mesh position if attached
    if (this.mesh) {
      this.mesh.position.copy(this.position);
    }

    // Sanity check
    assertFiniteVec3(this.position, 'PlayerPosition');
  }

  /**
   * Resolve collisions with arena geometry
   */
  private resolveCollisions(): void {
    // Reset ground level to base
    let newGroundLevel = this.config.groundY;

    for (const col of this.colliders) {
      if (col.type === 'cylinder') {
        this.resolveCylinder(col);
      } else if (col.type === 'box') {
        const boxGround = this.resolveBox(col);
        if (boxGround > newGroundLevel) {
          newGroundLevel = boxGround;
        }
      }
    }

    this.groundLevel = newGroundLevel;
  }

  /**
   * Resolve collision with a cylinder (pillar)
   * Push out horizontally with wall sliding
   */
  private resolveCylinder(col: CylinderCollider): void {
    const dx = this.position.x - col.x;
    const dz = this.position.z - col.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const minDist = col.radius + this.config.radius;

    if (dist < minDist && dist > 0.001) {
      // Push out along the normal
      const overlap = minDist - dist;
      const nx = dx / dist;
      const nz = dz / dist;

      this.position.x += nx * overlap;
      this.position.z += nz * overlap;

      // Wall slide: remove velocity component into the wall
      const velDotN = this.velocity.x * nx + this.velocity.z * nz;
      if (velDotN < 0) {
        this.velocity.x -= velDotN * nx;
        this.velocity.z -= velDotN * nz;
      }
    }
  }

  /**
   * Resolve collision with a box
   * Returns ground level if player is on top
   */
  private resolveBox(col: BoxCollider): number {
    // Rotation: to local space (rotate by -rotation), to world space (rotate by +rotation)
    const cosR = Math.cos(col.rotation);
    const sinR = Math.sin(col.rotation);

    // Player position relative to box center
    const dx = this.position.x - col.x;
    const dz = this.position.z - col.z;

    // Transform to box local space (rotate by -rotation)
    const localX = dx * cosR + dz * sinR;
    const localZ = -dx * sinR + dz * cosR;

    const halfW = col.width / 2 + this.config.radius;
    const halfD = col.depth / 2 + this.config.radius;

    // Check if within box bounds horizontally
    if (Math.abs(localX) < halfW && Math.abs(localZ) < halfD) {
      // Check if on top of box (use tighter bounds for standing)
      const onTopX = Math.abs(localX) < col.width / 2 + this.config.radius * 0.5;
      const onTopZ = Math.abs(localZ) < col.depth / 2 + this.config.radius * 0.5;
      if (onTopX && onTopZ && this.position.y >= col.height - 0.1 && this.velocity.y <= 0) {
        return col.height;
      }

      // Side collision - find smallest penetration axis
      const overlapX = halfW - Math.abs(localX);
      const overlapZ = halfD - Math.abs(localZ);

      // Push direction in local space
      let pushLocalX = 0;
      let pushLocalZ = 0;

      if (overlapX < overlapZ) {
        pushLocalX = overlapX * Math.sign(localX);
      } else {
        pushLocalZ = overlapZ * Math.sign(localZ);
      }

      // Transform push back to world space (rotate by +rotation)
      const worldPushX = pushLocalX * cosR - pushLocalZ * sinR;
      const worldPushZ = pushLocalX * sinR + pushLocalZ * cosR;

      this.position.x += worldPushX;
      this.position.z += worldPushZ;

      // Wall slide: compute normal in world space and remove velocity into wall
      if (worldPushX !== 0 || worldPushZ !== 0) {
        const pushLen = Math.sqrt(worldPushX * worldPushX + worldPushZ * worldPushZ);
        const nx = worldPushX / pushLen;
        const nz = worldPushZ / pushLen;
        const velDotN = this.velocity.x * nx + this.velocity.z * nz;
        if (velDotN < 0) {
          this.velocity.x -= velDotN * nx;
          this.velocity.z -= velDotN * nz;
        }
      }
    }

    return this.config.groundY;
  }

  /**
   * Get debug info string
   */
  getDebugInfo(): string {
    return `Pos: ${prettyVec(this.position)} | Vel: ${prettyVec(this.velocity)} | Grounded: ${this.isGrounded}`;
  }
}
