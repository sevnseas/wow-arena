/**
 * Character View - Animation abstraction layer
 *
 * Gameplay talks to CharacterView, not meshes/animations directly.
 * This allows swapping procedural placeholders for GLB models later.
 */

import * as THREE from 'three';

// Locomotion states
export type LocomotionState = 'idle' | 'walk' | 'run' | 'jump' | 'fall';

/**
 * CharacterView interface - all character visuals implement this
 */
export interface CharacterView {
  readonly root: THREE.Object3D;

  /** Set the direction the character is facing (yaw in radians) */
  setFacingYaw(yaw: number): void;

  /** Set locomotion state and speed (0-1) */
  setLocomotion(state: LocomotionState, speed01: number): void;

  /** Trigger a one-shot animation (attack, spell, etc) */
  triggerOneShot(name: string): void;

  /** Update animations (call each frame) */
  update(dt: number): void;

  /** Dispose resources */
  dispose(): void;
}

/**
 * ProceduralCharacterView - Animated placeholder using primitives
 *
 * Hierarchy:
 *   root
 *   └─ hips
 *      ├─ torso
 *      │  ├─ head
 *      │  ├─ leftArm
 *      │  └─ rightArm
 *      ├─ leftLeg
 *      └─ rightLeg
 */
export class ProceduralCharacterView implements CharacterView {
  public readonly root: THREE.Group;

  private hips: THREE.Group;
  private torso: THREE.Group;
  private head: THREE.Mesh;
  private leftArm: THREE.Group;
  private rightArm: THREE.Group;
  private leftLeg: THREE.Group;
  private rightLeg: THREE.Group;

  private state: LocomotionState = 'idle';
  private speed01: number = 0;
  private phase: number = 0;
  private targetYaw: number = 0;
  private currentYaw: number = 0;

  private color: number;

  constructor(color: number = 0xffff00) {
    this.color = color;
    this.root = new THREE.Group();
    this.root.name = 'CharacterRoot';

    // Build hierarchy
    this.hips = this.createHips();
    this.torso = this.createTorso();
    this.head = this.createHead();
    this.leftArm = this.createArm('left');
    this.rightArm = this.createArm('right');
    this.leftLeg = this.createLeg('left');
    this.rightLeg = this.createLeg('right');

    // Assemble
    this.root.add(this.hips);
    this.hips.add(this.torso);
    this.hips.add(this.leftLeg);
    this.hips.add(this.rightLeg);
    this.torso.add(this.head);
    this.torso.add(this.leftArm);
    this.torso.add(this.rightArm);
  }

  private createMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: this.color,
      roughness: 0.7,
      metalness: 0.2
    });
  }

  private createHips(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'Hips';
    group.position.y = 0.9; // Hip height

    const geo = new THREE.BoxGeometry(0.35, 0.15, 0.2);
    const mesh = new THREE.Mesh(geo, this.createMaterial());
    mesh.castShadow = true;
    group.add(mesh);

    return group;
  }

  private createTorso(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'Torso';
    group.position.y = 0.3; // Above hips

    const geo = new THREE.BoxGeometry(0.35, 0.45, 0.2);
    const mesh = new THREE.Mesh(geo, this.createMaterial());
    mesh.position.y = 0.225;
    mesh.castShadow = true;
    group.add(mesh);

    return group;
  }

  private createHead(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(0.12, 12, 8);
    const mesh = new THREE.Mesh(geo, this.createMaterial());
    mesh.name = 'Head';
    mesh.position.y = 0.55;
    mesh.castShadow = true;
    return mesh;
  }

  private createArm(side: 'left' | 'right'): THREE.Group {
    const group = new THREE.Group();
    group.name = `${side}Arm`;

    const xOffset = side === 'left' ? -0.25 : 0.25;
    group.position.set(xOffset, 0.4, 0);

    // Upper arm
    const upperGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.25, 8);
    const upperMesh = new THREE.Mesh(upperGeo, this.createMaterial());
    upperMesh.position.y = -0.125;
    upperMesh.castShadow = true;
    group.add(upperMesh);

    // Forearm
    const forearm = new THREE.Group();
    forearm.position.y = -0.25;

    const foreGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8);
    const foreMesh = new THREE.Mesh(foreGeo, this.createMaterial());
    foreMesh.position.y = -0.11;
    foreMesh.castShadow = true;
    forearm.add(foreMesh);

    group.add(forearm);
    return group;
  }

  private createLeg(side: 'left' | 'right'): THREE.Group {
    const group = new THREE.Group();
    group.name = `${side}Leg`;

    const xOffset = side === 'left' ? -0.1 : 0.1;
    group.position.set(xOffset, 0, 0);

    // Upper leg
    const upperGeo = new THREE.CylinderGeometry(0.06, 0.05, 0.4, 8);
    const upperMesh = new THREE.Mesh(upperGeo, this.createMaterial());
    upperMesh.position.y = -0.2;
    upperMesh.castShadow = true;
    group.add(upperMesh);

    // Lower leg
    const lowerGroup = new THREE.Group();
    lowerGroup.position.y = -0.4;

    const lowerGeo = new THREE.CylinderGeometry(0.05, 0.04, 0.4, 8);
    const lowerMesh = new THREE.Mesh(lowerGeo, this.createMaterial());
    lowerMesh.position.y = -0.2;
    lowerMesh.castShadow = true;
    lowerGroup.add(lowerMesh);

    // Foot
    const footGeo = new THREE.BoxGeometry(0.08, 0.05, 0.15);
    const footMesh = new THREE.Mesh(footGeo, this.createMaterial());
    footMesh.position.set(0, -0.425, 0.03);
    footMesh.castShadow = true;
    lowerGroup.add(footMesh);

    group.add(lowerGroup);
    return group;
  }

  setFacingYaw(yaw: number): void {
    this.targetYaw = yaw;
  }

  setLocomotion(state: LocomotionState, speed01: number): void {
    this.state = state;
    this.speed01 = Math.max(0, Math.min(1, speed01));
  }

  triggerOneShot(_name: string): void {
    // TODO: Implement one-shot animations
  }

  update(dt: number): void {
    // Smooth yaw rotation
    const yawDiff = this.targetYaw - this.currentYaw;
    // Handle wrap-around
    let shortestDiff = ((yawDiff + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (shortestDiff < -Math.PI) shortestDiff += Math.PI * 2;
    this.currentYaw += shortestDiff * Math.min(1, dt * 10);
    this.root.rotation.y = this.currentYaw;

    // Advance phase for walk/run animation
    const phaseSpeed = this.state === 'run' ? 12 : 6;
    if (this.state === 'walk' || this.state === 'run') {
      this.phase += dt * phaseSpeed * this.speed01;
    }

    // Apply pose based on state
    switch (this.state) {
      case 'idle':
        this.applyIdlePose(dt);
        break;
      case 'walk':
      case 'run':
        this.applyWalkPose();
        break;
      case 'jump':
      case 'fall':
        this.applyJumpPose();
        break;
    }
  }

  private applyIdlePose(_dt: number): void {
    // Subtle breathing
    const breathPhase = Date.now() * 0.002;
    const breathAmount = Math.sin(breathPhase) * 0.01;

    this.torso.position.y = 0.3 + breathAmount;
    this.hips.position.y = 0.9;

    // Reset limbs
    this.leftArm.rotation.x = 0;
    this.rightArm.rotation.x = 0;
    this.leftLeg.rotation.x = 0;
    this.rightLeg.rotation.x = 0;
  }

  private applyWalkPose(): void {
    const swing = Math.sin(this.phase);
    const swingAmount = this.state === 'run' ? 0.6 : 0.35;

    // Legs swing opposite to each other
    this.leftLeg.rotation.x = swing * swingAmount;
    this.rightLeg.rotation.x = -swing * swingAmount;

    // Arms swing opposite to legs
    this.leftArm.rotation.x = -swing * swingAmount * 0.7;
    this.rightArm.rotation.x = swing * swingAmount * 0.7;

    // Slight torso bob
    const bob = Math.abs(Math.sin(this.phase * 2)) * 0.03;
    this.hips.position.y = 0.9 + bob;
  }

  private applyJumpPose(): void {
    // Legs tucked
    this.leftLeg.rotation.x = -0.4;
    this.rightLeg.rotation.x = -0.4;

    // Arms out
    this.leftArm.rotation.x = -0.8;
    this.rightArm.rotation.x = -0.8;
    this.leftArm.rotation.z = 0.3;
    this.rightArm.rotation.z = -0.3;
  }

  dispose(): void {
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (obj.material instanceof THREE.Material) {
          obj.material.dispose();
        }
      }
    });
  }
}

/**
 * Stub for future GLB-based character
 */
export class GltfCharacterView implements CharacterView {
  public readonly root: THREE.Group;

  constructor(_modelPath: string) {
    this.root = new THREE.Group();
    // TODO: Load GLB, setup AnimationMixer
  }

  setFacingYaw(_yaw: number): void {
    // TODO
  }

  setLocomotion(_state: LocomotionState, _speed01: number): void {
    // TODO
  }

  triggerOneShot(_name: string): void {
    // TODO
  }

  update(_dt: number): void {
    // TODO
  }

  dispose(): void {
    // TODO
  }
}
