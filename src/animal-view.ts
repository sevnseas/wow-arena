/**
 * AnimalCharacterView — wraps one of the animal meshes (wolf / cat / rabbit)
 * as a CharacterView so the player can pick "Wolf" etc. in the Tab class
 * selector and embody that body. Locomotion is a simple leg-swing cycle keyed
 * off the speed01 fed in by main.ts — animation style matches what the wild
 * animal packs do in their own update loops (intentional: the player look the
 * same as a brain-driven wolf, side by side).
 *
 * Visual only — combat / abilities are unhooked here. This view exists so the
 * player has an animal body; ability code lives in main.ts.
 */
import * as THREE from 'three';
import type { CharacterView, LocomotionState } from './character';
import { buildWolfMesh } from './wolves';
import { buildCatMesh } from './cats';
import { buildRabbitMesh } from './rabbits';

export type AnimalKind = 'wolf' | 'cat' | 'rabbit';

interface AnimalLegs {
  /** Each entry returns the THREE object whose rotation.x we animate. */
  get(i: number): THREE.Object3D | undefined;
  count(): number;
}

export class AnimalCharacterView implements CharacterView {
  readonly root: THREE.Group;
  readonly kind: AnimalKind;
  private legs: AnimalLegs;
  private walkPhase = 0;
  private currentSpeed = 0;
  /** World yaw fed in by main.ts (player.facingYaw). We rotate the mesh group
   *  to match — using sin(yaw)/cos(yaw) the same way wolves.ts does, so the
   *  body orients correctly under WoW-style camera-relative WASD. */
  private yaw = 0;

  constructor(kind: AnimalKind) {
    this.kind = kind;
    if (kind === 'wolf') {
      const parts = buildWolfMesh();
      this.root = parts.group;
      this.legs = {
        get: (i) => parts.legs[i],
        count: () => parts.legs.length,
      };
    } else if (kind === 'cat') {
      const parts = buildCatMesh();
      this.root = parts.group;
      this.legs = {
        get: (i) => parts.legs[i]?.mesh,
        count: () => parts.legs.length,
      };
    } else {
      const parts = buildRabbitMesh();
      this.root = parts.group;
      // Rabbits hop with two pairs — animate the back pair as a unit.
      const all = [...parts.legsBack, ...parts.legsFront];
      this.legs = {
        get: (i) => all[i],
        count: () => all.length,
      };
    }
  }

  setFacingYaw(yaw: number): void {
    // Negate to match main.ts's CCW-yaw convention for the existing Mixamo
    // character (it calls setFacingYaw(-state.player.facingYaw)). The mesh's
    // forward in the animal packs is +Z, so add Math.PI flips to face away
    // from the camera as the player expects.
    this.yaw = -yaw;
    this.root.rotation.y = this.yaw;
  }

  setLocomotion(state: LocomotionState, speed01: number, _moveLocal?: THREE.Vector3): void {
    this.currentSpeed = state === 'idle' ? 0 : speed01;
  }

  setAirborne(): void { /* no-op */ }
  triggerOneShot(_name: string): void { /* no-op */ }
  triggerUpperBodyAttack(_dur?: number): void { /* no-op */ }
  startCasting(_castTime?: number): void { /* no-op */ }
  stopCasting(): void { /* no-op */ }
  setDebuffed(_b: boolean): void { /* no-op */ }

  update(dt: number): void {
    // Walk cycle — alternating leg swings at a cadence proportional to speed.
    // Magic numbers match the per-pack walk styles so a player-wolf reads the
    // same as a brain-wolf walking next to it.
    const cadence = this.kind === 'rabbit' ? 6 : (this.kind === 'cat' ? 10 : 11);
    const amp = this.kind === 'rabbit' ? 0.4 : 0.7;
    this.walkPhase += dt * cadence * Math.max(0.1, this.currentSpeed);
    const swing = Math.sin(this.walkPhase) * amp * this.currentSpeed;
    const swingOpp = Math.sin(this.walkPhase + Math.PI) * amp * this.currentSpeed;
    for (let i = 0; i < this.legs.count(); i++) {
      const leg = this.legs.get(i);
      if (!leg) continue;
      leg.rotation.x = (i % 2 === 0) ? swing : swingOpp;
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      g?.dispose?.();
    });
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
