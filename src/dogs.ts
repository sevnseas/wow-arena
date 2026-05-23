/**
 * Procedural low-poly dogs that wander the arena.
 * Body is built from primitives; legs and tail animate via a simple walk
 * cycle phase. Each dog picks a random destination, walks to it, then
 * picks another. Cheap and self-contained.
 */

import * as THREE from 'three';
import type { Collider } from './arena';
import { Holdable, HoldableProvider } from './holdable';
import type { PreyRef, PreyProvider, PreyState } from './prey';
import { applyIntentToPreyState, combatContactRange, emitDamageSplat, emitHealSplat, healPreyState, maintainCombatSpacing, makePreyState, notePreyAttacker, tickGrazeHeal } from './prey';
import { Intent, INTENT_COUNT, type PolicyAgentRef } from './rl';
import { resolveAnimalPhysics } from './animal-physics';

const WALK_SPEED = 1.6;
const TURN_RATE = 2.4;          // radians/sec toward target heading
const REACH_RADIUS = 1.2;       // how close before picking a new spot
const PAUSE_CHANCE = 0.25;      // chance to idle after reaching a spot
const PAUSE_TIME = [1.5, 4.0];
const DOG_RADIUS = 0.45;

const PALETTE = [
  { body: 0x8b6f47, belly: 0xc9a47a }, // tan
  { body: 0x4a3b2a, belly: 0x6b5742 }, // dark brown
  { body: 0xd9d2c5, belly: 0xf2ede3 }, // cream
  { body: 0x2d2d2d, belly: 0x444444 }, // black
  { body: 0xa37856, belly: 0xd1a47e }  // chestnut
];

interface DogParts {
  group: THREE.Group;
  legs: { mesh: THREE.Mesh; phase: number }[];
  tail: THREE.Object3D;
  head: THREE.Object3D;
  body: THREE.Object3D;
}

interface Dog {
  parts: DogParts;
  pos: THREE.Vector3;
  yaw: number;
  target: THREE.Vector3;
  pauseTimer: number;     // > 0 means idling
  walkPhase: number;
  bounds: number;
  heightData: Uint8Array | null;
  held: boolean;
  prey: PreyState;
  id: string;
  name: string;
  personalityBias: Float32Array;
  temperature: number;
}

function buildDogMesh(): DogParts {
  const palette = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const bodyMat = new THREE.MeshStandardMaterial({ color: palette.body, roughness: 0.85, metalness: 0.0 });
  const bellyMat = new THREE.MeshStandardMaterial({ color: palette.belly, roughness: 0.85, metalness: 0.0 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });

  const group = new THREE.Group();
  group.name = 'Dog';

  // Body — stretched box
  const bodyGeo = new THREE.BoxGeometry(0.5, 0.45, 0.95);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);

  // Belly underside, slightly lighter
  const bellyGeo = new THREE.BoxGeometry(0.48, 0.18, 0.85);
  const belly = new THREE.Mesh(bellyGeo, bellyMat);
  belly.position.set(0, 0.4, 0);
  group.add(belly);

  // Neck + head pivot at front of body
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.7, 0.5);
  group.add(headPivot);

  const neckGeo = new THREE.BoxGeometry(0.32, 0.32, 0.28);
  const neck = new THREE.Mesh(neckGeo, bodyMat);
  neck.position.set(0, -0.05, 0.05);
  neck.castShadow = true;
  headPivot.add(neck);

  const headGeo = new THREE.BoxGeometry(0.36, 0.34, 0.42);
  const head = new THREE.Mesh(headGeo, bodyMat);
  head.position.set(0, 0.05, 0.32);
  head.castShadow = true;
  headPivot.add(head);

  // Snout
  const snoutGeo = new THREE.BoxGeometry(0.22, 0.18, 0.22);
  const snout = new THREE.Mesh(snoutGeo, bellyMat);
  snout.position.set(0, -0.04, 0.55);
  headPivot.add(snout);

  const noseGeo = new THREE.BoxGeometry(0.1, 0.08, 0.06);
  const nose = new THREE.Mesh(noseGeo, noseMat);
  nose.position.set(0, -0.02, 0.69);
  headPivot.add(nose);

  // Ears
  const earGeo = new THREE.BoxGeometry(0.08, 0.18, 0.14);
  const earL = new THREE.Mesh(earGeo, bodyMat);
  earL.position.set(-0.13, 0.22, 0.22);
  earL.rotation.z = 0.2;
  headPivot.add(earL);
  const earR = earL.clone();
  earR.position.x = 0.13;
  earR.rotation.z = -0.2;
  headPivot.add(earR);

  // Tail pivot at back
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.68, -0.5);
  tailPivot.rotation.x = -0.5;
  group.add(tailPivot);

  const tailGeo = new THREE.BoxGeometry(0.1, 0.1, 0.4);
  const tail = new THREE.Mesh(tailGeo, bodyMat);
  tail.position.z = -0.2;
  tail.castShadow = true;
  tailPivot.add(tail);

  // Legs — pivoted at hip so we can swing them
  const legs: DogParts['legs'] = [];
  const legPositions: [number, number, number, number][] = [
    // [x, z, phase, isFront]
    [-0.18, 0.38, 0, 1],   // front-left
    [0.18, 0.38, Math.PI, 1], // front-right
    [-0.18, -0.38, Math.PI, 0], // back-left
    [0.18, -0.38, 0, 0]      // back-right
  ];
  for (const [x, z, phase] of legPositions) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.45, z);
    group.add(pivot);

    const legGeo = new THREE.BoxGeometry(0.12, 0.45, 0.12);
    const leg = new THREE.Mesh(legGeo, bodyMat);
    leg.position.y = -0.22;
    leg.castShadow = true;
    pivot.add(leg);

    const pawGeo = new THREE.BoxGeometry(0.14, 0.08, 0.18);
    const paw = new THREE.Mesh(pawGeo, noseMat);
    paw.position.y = -0.43;
    pivot.add(paw);

    legs.push({ mesh: pivot as unknown as THREE.Mesh, phase });
  }

  return { group, legs, tail: tailPivot, head: headPivot, body };
}

function pickTarget(bounds: number): THREE.Vector3 {
  const r = bounds * 0.85;
  return new THREE.Vector3(
    (Math.random() * 2 - 1) * r,
    0,
    (Math.random() * 2 - 1) * r
  );
}

export class DogPack implements HoldableProvider, PreyProvider {
  private dogs: Dog[] = [];
  private group: THREE.Group;
  private bounds: number;
  private heightData: Uint8Array | null;
  private colliders: Collider[] = [];

  constructor(scene: THREE.Scene, count: number, bounds: number, heightData: Uint8Array | null) {
    this.bounds = bounds;
    this.heightData = heightData;
    this.group = new THREE.Group();
    this.group.name = 'DogPack';
    scene.add(this.group);

    for (let i = 0; i < count; i++) {
      this.spawnDog();
    }
  }

  private spawnDog(): void {
    const parts = buildDogMesh();
    const start = pickTarget(this.bounds);
    const dog: Dog = {
      parts,
      pos: start.clone(),
      yaw: Math.random() * Math.PI * 2,
      target: pickTarget(this.bounds),
      pauseTimer: 0,
      walkPhase: Math.random() * Math.PI * 2,
      bounds: this.bounds,
      heightData: this.heightData,
      held: false,
      prey: makePreyState(55),
      id: `dog-${this.dogs.length + 1}`,
      name: 'Dog',
      personalityBias: (() => {
        const b = new Float32Array(INTENT_COUNT);
        // Dogs lean toward attacking predators who threaten the herd.
        b[Intent.Attack] = 0.25 + Math.random() * 0.4;
        return b;
      })(),
      temperature: 0.7 + Math.random() * 0.6,
    };
    parts.group.position.copy(start);
    parts.group.rotation.y = dog.yaw;
    parts.group.userData.policyAgentId = dog.id;
    parts.group.userData.policyArchetype = 'dog';
    this.group.add(parts.group);
    this.dogs.push(dog);
  }

  update(delta: number): void {
    for (const dog of this.dogs) {
      if (dog.prey.dead) {
        dog.prey.deadTimer += delta;
        if (dog.prey.deadTimer > 6) {
          dog.prey.hp = dog.prey.maxHp;
          dog.prey.dead = false;
          dog.prey.deadTimer = 0;
          dog.prey.combatTarget = null;
          dog.parts.group.rotation.x = 0;
          dog.target = pickTarget(dog.bounds);
        }
        continue;
      }
      if (dog.held) continue;
      this.updateDog(dog, delta);
    }
  }

  setColliders(colliders: Collider[]): void {
    this.colliders = colliders;
  }

  getPolicyAgents(): PolicyAgentRef[] {
    return this.dogs.map(d => this.makePolicyAgent(d));
  }

  private makePolicyAgent(d: Dog): PolicyAgentRef {
    return {
      id: d.id,
      team: 'predator',
      archetype: 'dog',
      size: DOG_RADIUS,
      personalityBias: d.personalityBias,
      temperature: d.temperature,
      get alive() { return !d.prey.dead && !d.held; },
      get hp() { return d.prey.hp; },
      get maxHp() { return d.prey.maxHp; },
      get status() { return 0 as 0 | 1 | 2; },
      get pos() { return { x: d.pos.x, z: d.pos.z }; },
      get attackerId() { return d.prey.lastAttackerId; },
      applyIntent(intent, focus, ctx) {
        applyIntentToPreyState(
          d.prey, intent as 0|1|2|3|4, focus,
          () => null,
          (id) => ctx?.resolveAttacker?.(id) ?? null,
        );
      },
    };
  }

  findNearestPrey(pos: THREE.Vector3, maxDist: number): PreyRef | null {
    let best: Dog | null = null;
    let bestSq = maxDist * maxDist;
    for (const dog of this.dogs) {
      if (dog.held || dog.prey.dead) continue;
      const dx = dog.pos.x - pos.x;
      const dz = dog.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = dog; }
    }
    return best ? this.makePreyRef(best) : null;
  }

  forEachPrey(fn: (ref: PreyRef) => void): void {
    for (const dog of this.dogs) {
      if (!dog.held && !dog.prey.dead) fn(this.makePreyRef(dog));
    }
  }

  private makePreyRef(dog: Dog): PreyRef {
    return {
      id: dog.id,
      name: dog.name,
      team: 'neutral',
      mesh: dog.parts.group,
      get pos() { return dog.pos; },
      get alive() { return !dog.prey.dead; },
      get hp() { return dog.prey.hp; },
      get maxHp() { return dog.prey.maxHp; },
      get radius() { return DOG_RADIUS; },
      damage: (amount: number, attacker?: PreyRef) => {
        if (dog.prey.dead) return false;
        dog.prey.hp -= amount;
        dog.prey.lastHitAt = performance.now();
        emitDamageSplat(dog.parts.group, amount);
        notePreyAttacker(dog.prey, attacker);
        if (attacker?.alive) dog.prey.combatTarget = attacker;
        if (dog.prey.hp <= 0) {
          dog.prey.hp = 0;
          dog.prey.dead = true;
          dog.prey.combatTarget = null;
          dog.parts.group.rotation.x = Math.PI / 2 * 0.9;
          return true;
        }
        return false;
      },
      heal: (amount: number) => {
        const healed = healPreyState(dog.prey, amount);
        if (healed > 0) emitHealSplat(dog.parts.group, healed);
        return healed;
      },
      scare: (fromX, fromZ, durMs) => {
        if (dog.prey.dead) return;
        dog.prey.fleeUntil = performance.now() + durMs;
        dog.prey.fleeFromX = fromX;
        dog.prey.fleeFromZ = fromZ;
      },
    };
  }

  findNearestHoldable(pos: THREE.Vector3, maxDist: number): Holdable | null {
    let best: Dog | null = null;
    let bestSq = maxDist * maxDist;
    for (const dog of this.dogs) {
      if (dog.held) continue;
      const dx = dog.pos.x - pos.x;
      const dz = dog.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = dog; }
    }
    if (!best) return null;
    return this.makeHoldable(best);
  }

  private makeHoldable(dog: Dog): Holdable {
    return {
      mesh: dog.parts.group,
      get held() { return dog.held; },
      set held(v: boolean) { dog.held = v; },
      pickUp: () => { dog.held = true; },
      releaseAt: (pos, yaw) => {
        dog.held = false;
        dog.pos.set(pos.x, 0, pos.z);
        dog.yaw = yaw;
        dog.target = pickTarget(dog.bounds);
        dog.pauseTimer = 0.6 + Math.random() * 0.6;
        // Reset limbs
        for (const leg of dog.parts.legs) leg.mesh.rotation.x = 0;
        dog.parts.body.position.y = 0.55;
        dog.parts.head.rotation.x = 0;
        dog.parts.tail.rotation.y = 0;
      }
    };
  }

  private updateDog(dog: Dog, delta: number): void {
    const grazed = tickGrazeHeal(dog.prey, delta, 5);
    if (grazed > 0) emitHealSplat(dog.parts.group, grazed);
    if (dog.prey.grazingUntil > performance.now()) {
      dog.pauseTimer = Math.max(dog.pauseTimer, 0.3);
    }
    this.updateCombat(dog, delta);
    const moving = dog.pauseTimer <= 0;

    if (!moving) {
      dog.pauseTimer -= delta;
      // Idle tail wag, no movement
      dog.parts.tail.rotation.y = Math.sin(performance.now() * 0.008) * 0.6;
      // Settle legs
      for (const leg of dog.parts.legs) leg.mesh.rotation.x *= 0.9;
      this.applyTerrain(dog);
      return;
    }

    // Steer toward target
    const dx = dog.target.x - dog.pos.x;
    const dz = dog.target.z - dog.pos.z;
    const distSq = dx * dx + dz * dz;

    if (distSq < REACH_RADIUS * REACH_RADIUS) {
      // Arrived — maybe pause, then pick a new target
      if (Math.random() < PAUSE_CHANCE) {
        dog.pauseTimer = PAUSE_TIME[0] + Math.random() * (PAUSE_TIME[1] - PAUSE_TIME[0]);
      }
      dog.target = pickTarget(dog.bounds);
      return;
    }

    const desiredYaw = Math.atan2(dx, dz);
    let yawDiff = desiredYaw - dog.yaw;
    // Wrap to [-PI, PI]
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    const turn = Math.max(-TURN_RATE * delta, Math.min(TURN_RATE * delta, yawDiff));
    dog.yaw += turn;

    // Move forward at WALK_SPEED, scaled down while sharply turning
    const turnPenalty = 1 - Math.min(1, Math.abs(yawDiff) / Math.PI) * 0.6;
    const speed = WALK_SPEED * turnPenalty;
    dog.pos.x += Math.sin(dog.yaw) * speed * delta;
    dog.pos.z += Math.cos(dog.yaw) * speed * delta;

    // Soft arena bounds — pick a new target if drifting out
    if (Math.abs(dog.pos.x) > dog.bounds || Math.abs(dog.pos.z) > dog.bounds) {
      dog.target = pickTarget(dog.bounds);
    }

    // Walk cycle
    dog.walkPhase += delta * 9 * turnPenalty;
    const swing = Math.sin(dog.walkPhase) * 0.7;
    const swingOpp = Math.sin(dog.walkPhase + Math.PI) * 0.7;
    dog.parts.legs[0].mesh.rotation.x = swing;       // FL
    dog.parts.legs[1].mesh.rotation.x = swingOpp;    // FR
    dog.parts.legs[2].mesh.rotation.x = swingOpp;    // BL
    dog.parts.legs[3].mesh.rotation.x = swing;       // BR

    // Body bob
    const bob = Math.abs(Math.sin(dog.walkPhase * 2)) * 0.04;
    dog.parts.body.position.y = 0.55 + bob;

    // Tail wag
    dog.parts.tail.rotation.y = Math.sin(dog.walkPhase * 1.5) * 0.5;

    // Head bob slightly
    dog.parts.head.rotation.x = Math.sin(dog.walkPhase) * 0.08;

    this.applyTerrain(dog);
  }

  private applyTerrain(dog: Dog): void {
    const y = this.resolvePosition(dog);
    dog.parts.group.position.set(dog.pos.x, y, dog.pos.z);
    dog.parts.group.rotation.y = dog.yaw;
  }

  private resolvePosition(dog: Dog): number {
    return resolveAnimalPhysics(dog.pos, {
      radius: DOG_RADIUS,
      bounds: dog.bounds,
      heightData: dog.heightData,
      colliders: this.colliders,
    });
  }

  private updateCombat(dog: Dog, delta: number): void {
    dog.prey.attackTimer = Math.max(0, dog.prey.attackTimer - delta);
    const target = dog.prey.combatTarget;
    if (!target?.alive) {
      dog.prey.combatTarget = null;
      return;
    }
    const dx = target.pos.x - dog.pos.x;
    const dz = target.pos.z - dog.pos.z;
    const d2 = dx * dx + dz * dz;
    const attackRange = combatContactRange(DOG_RADIUS, target);
    if (d2 > attackRange * attackRange) {
      dog.target.set(target.pos.x, 0, target.pos.z);
      dog.pauseTimer = 0;
      return;
    }
    maintainCombatSpacing(dog.pos, target, attackRange);
    dog.yaw = Math.atan2(dx, dz);
    if (dog.prey.attackTimer <= 0) {
      target.damage(6, this.makePreyRef(dog));
      dog.prey.attackTimer = 1.6;
    }
  }
}
