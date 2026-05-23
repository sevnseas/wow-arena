/**
 * Procedural low-poly cats that wander the arena.
 * Slimmer than dogs, with pointier ears and a long curving tail that
 * swishes side-to-side. Same wander/pickup contract as DogPack.
 */

import * as THREE from 'three';
import type { Collider } from './arena';
import { Holdable, HoldableProvider } from './holdable';
import type { PreyRef, PreyProvider, PreyState } from './prey';
import { applyIntentToPreyState, combatContactRange, emitDamageSplat, emitHealSplat, healPreyState, maintainCombatSpacing, makePreyState, notePreyAttacker, tickGrazeHeal } from './prey';
import { Intent, INTENT_COUNT, type PolicyAgentRef } from './rl';
import { actionToUnitVec, isMovementAction, type PolicyAgent4Ref } from './rl/runtime4';
import { resolveAnimalPhysics } from './animal-physics';

const WALK_SPEED = 1.4;
const TURN_RATE = 2.6;
const REACH_RADIUS = 1.2;
const PAUSE_CHANCE = 0.35;
const PAUSE_TIME = [1.5, 4.5];
const TAIL_SEGMENTS = 4;
const CAT_RADIUS = 0.38;

const PALETTE = [
  { body: 0x2a2a2a, belly: 0x4a4a4a }, // black
  { body: 0xe8e2d5, belly: 0xf5f1e6 }, // white
  { body: 0xc99355, belly: 0xe8c08a }, // orange tabby
  { body: 0x6b6055, belly: 0x9a8d7e }, // grey tabby
  { body: 0x5a3a24, belly: 0x8a6440 }  // brown
];

export interface CatParts {
  group: THREE.Group;
  legs: { mesh: THREE.Mesh; phase: number }[];
  tail: THREE.Object3D;
  tailSegments: THREE.Object3D[];
  head: THREE.Object3D;
  body: THREE.Object3D;
}

interface Cat {
  parts: CatParts;
  pos: THREE.Vector3;
  yaw: number;
  target: THREE.Vector3;
  pauseTimer: number;
  walkPhase: number;
  bounds: number;
  heightData: Uint8Array | null;
  held: boolean;
  personalityBias: Float32Array;
  temperature: number;
  prey: PreyState;
  id: string;
  name: string;
  /** True when RL4 is actively steering this cat — suppresses the auto
   *  wander-retargeting that would otherwise overwrite the policy target. */
  brainSteer?: boolean;
  brainSteerAt?: number;
}

export function buildCatMesh(): CatParts {
  const palette = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const bodyMat = new THREE.MeshStandardMaterial({ color: palette.body, roughness: 0.85, metalness: 0.0 });
  const bellyMat = new THREE.MeshStandardMaterial({ color: palette.belly, roughness: 0.85, metalness: 0.0 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xd07a8a, roughness: 0.6 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x88dd55, roughness: 0.4 });

  const group = new THREE.Group();
  group.name = 'Cat';

  // Body — slimmer than dog
  const bodyGeo = new THREE.BoxGeometry(0.36, 0.34, 0.78);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.48;
  body.castShadow = true;
  group.add(body);

  // Belly underside
  const bellyGeo = new THREE.BoxGeometry(0.34, 0.14, 0.7);
  const belly = new THREE.Mesh(bellyGeo, bellyMat);
  belly.position.set(0, 0.36, 0);
  group.add(belly);

  // Head pivot at front
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.6, 0.42);
  group.add(headPivot);

  const headGeo = new THREE.BoxGeometry(0.32, 0.3, 0.32);
  const head = new THREE.Mesh(headGeo, bodyMat);
  head.position.set(0, 0.06, 0.16);
  head.castShadow = true;
  headPivot.add(head);

  // Snout — small
  const snoutGeo = new THREE.BoxGeometry(0.16, 0.12, 0.12);
  const snout = new THREE.Mesh(snoutGeo, bellyMat);
  snout.position.set(0, -0.02, 0.32);
  headPivot.add(snout);

  const noseGeo = new THREE.BoxGeometry(0.06, 0.05, 0.04);
  const nose = new THREE.Mesh(noseGeo, noseMat);
  nose.position.set(0, 0.0, 0.4);
  headPivot.add(nose);

  // Eyes
  const eyeGeo = new THREE.BoxGeometry(0.05, 0.05, 0.04);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.09, 0.07, 0.31);
  headPivot.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.09, 0.07, 0.31);
  headPivot.add(eyeR);

  // Triangular pointy ears — tetrahedrons, sized like a tall pyramid
  const earGeo = new THREE.ConeGeometry(0.08, 0.18, 4);
  const earL = new THREE.Mesh(earGeo, bodyMat);
  earL.position.set(-0.11, 0.28, 0.1);
  earL.rotation.z = 0.15;
  earL.rotation.y = Math.PI / 4;
  headPivot.add(earL);
  const earR = earL.clone();
  earR.position.x = 0.11;
  earR.rotation.z = -0.15;
  headPivot.add(earR);

  // Long tail — segmented chain so it can curve and swish
  const tailRoot = new THREE.Group();
  tailRoot.position.set(0, 0.6, -0.4);
  group.add(tailRoot);

  const segLen = 0.22;
  const tailSegments: THREE.Object3D[] = [];
  let parent: THREE.Object3D = tailRoot;
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    const seg = new THREE.Group();
    seg.position.set(0, 0, i === 0 ? 0 : -segLen);
    parent.add(seg);

    const taper = 1 - i * 0.15;
    const segGeo = new THREE.BoxGeometry(0.08 * taper, 0.08 * taper, segLen);
    const segMesh = new THREE.Mesh(segGeo, bodyMat);
    segMesh.position.z = -segLen / 2;
    segMesh.castShadow = true;
    seg.add(segMesh);

    tailSegments.push(seg);
    parent = seg;
  }

  // Legs
  const legs: CatParts['legs'] = [];
  const legPositions: [number, number, number][] = [
    [-0.14, 0.32, 0],      // FL
    [0.14, 0.32, Math.PI], // FR
    [-0.14, -0.32, Math.PI], // BL
    [0.14, -0.32, 0]         // BR
  ];
  for (const [x, z, phase] of legPositions) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.4, z);
    group.add(pivot);

    const legGeo = new THREE.BoxGeometry(0.09, 0.4, 0.09);
    const leg = new THREE.Mesh(legGeo, bodyMat);
    leg.position.y = -0.2;
    leg.castShadow = true;
    pivot.add(leg);

    const pawGeo = new THREE.BoxGeometry(0.11, 0.06, 0.14);
    const paw = new THREE.Mesh(pawGeo, bellyMat);
    paw.position.y = -0.4;
    pivot.add(paw);

    legs.push({ mesh: pivot as unknown as THREE.Mesh, phase });
  }

  return { group, legs, tail: tailRoot, tailSegments, head: headPivot, body };
}

function pickTarget(bounds: number): THREE.Vector3 {
  const r = bounds * 0.85;
  return new THREE.Vector3(
    (Math.random() * 2 - 1) * r,
    0,
    (Math.random() * 2 - 1) * r
  );
}

function makeCatPersonality(): Float32Array {
  const b = new Float32Array(INTENT_COUNT);
  b[Intent.Attack] = 0.2 + Math.random() * 0.4;   // cats moderately predatory
  b[Intent.Heal] = (Math.random() - 0.3) * 0.4;   // some prefer hiding
  return b;
}

export class CatColony implements HoldableProvider, PreyProvider {
  private cats: Cat[] = [];
  private group: THREE.Group;
  private bounds: number;
  private heightData: Uint8Array | null;
  private targetCount: number;
  private respawnTimer = 6;
  private colliders: Collider[] = [];

  constructor(scene: THREE.Scene, count: number, bounds: number, heightData: Uint8Array | null) {
    this.bounds = bounds;
    this.heightData = heightData;
    this.targetCount = count;
    this.group = new THREE.Group();
    this.group.name = 'CatColony';
    scene.add(this.group);

    for (let i = 0; i < count; i++) this.spawnCat();
  }

  private spawnCat(): void {
    const parts = buildCatMesh();
    const start = pickTarget(this.bounds);
    const cat: Cat = {
      parts,
      pos: start.clone(),
      yaw: Math.random() * Math.PI * 2,
      target: pickTarget(this.bounds),
      pauseTimer: 0,
      walkPhase: Math.random() * Math.PI * 2,
      bounds: this.bounds,
      heightData: this.heightData,
      held: false,
      prey: makePreyState(45),
      id: `cat-${this.cats.length + 1}`,
      name: 'Cat',
      personalityBias: makeCatPersonality(),
      temperature: 0.6 + Math.random() * 0.6,
    };
    parts.group.position.copy(start);
    parts.group.rotation.y = cat.yaw;
    parts.group.userData.policyAgentId = cat.id;
    parts.group.userData.policyArchetype = 'cat';
    this.group.add(parts.group);
    this.cats.push(cat);
  }

  update(delta: number): void {
    for (const cat of this.cats) {
      if (cat.held) continue;
      if (cat.prey.dead) {
        cat.prey.deadTimer += delta;
        if (cat.prey.deadTimer > 6) {
          this.group.remove(cat.parts.group);
          const idx = this.cats.indexOf(cat);
          if (idx >= 0) this.cats.splice(idx, 1);
        } else if (cat.prey.deadTimer > 3) {
          const t = (cat.prey.deadTimer - 3) / 3;
          cat.parts.group.scale.setScalar(1 - t);
        }
        continue;
      }
      this.updateCat(cat, delta);
    }
    this.respawnTimer -= delta;
    if (this.respawnTimer <= 0 && this.cats.length < this.targetCount) {
      this.spawnCat();
      this.respawnTimer = 8 + Math.random() * 4;
    }
  }

  getPolicyAgents(): PolicyAgentRef[] {
    return this.cats.map(c => this.makePolicyAgent(c));
  }

  private makePolicyAgent(c: Cat): PolicyAgentRef {
    return {
      id: c.id,
      team: 'predator',
      archetype: 'cat',
      size: CAT_RADIUS,
      personalityBias: c.personalityBias,
      temperature: c.temperature,
      get alive() { return !c.prey.dead && !c.held; },
      get hp() { return c.prey.hp; },
      get maxHp() { return c.prey.maxHp; },
      get status() { return 0 as 0 | 1 | 2; },
      get pos() { return { x: c.pos.x, z: c.pos.z }; },
      get attackerId() { return c.prey.lastAttackerId; },
      applyIntent(intent, focus, ctx) {
        applyIntentToPreyState(
          c.prey, intent as 0|1|2|3|4, focus,
          () => null,
          (id) => ctx?.resolveAttacker?.(id) ?? null,
        );
      },
    };
  }

  /** RL4 adapter — see WolfPack.getPolicy4Agents for design notes. */
  getPolicy4Agents(): PolicyAgent4Ref[] {
    return this.cats
      .filter(c => !c.prey.dead && !c.held)
      .map(c => this.makePolicy4Agent(c));
  }

  private makePolicy4Agent(c: Cat): PolicyAgent4Ref {
    return {
      id: c.id,
      team: 'predator',
      archetype: 'cat',
      size: CAT_RADIUS,
      get alive() { return !c.prey.dead && !c.held; },
      get hp() { return c.prey.hp; },
      get maxHp() { return c.prey.maxHp; },
      get pos() { return { x: c.pos.x, z: c.pos.z }; },
      applyAction(action, _focus) {
        if (c.prey.dead || c.held) return;
        c.brainSteer = true;
        c.brainSteerAt = performance.now();
        if (isMovementAction(action)) {
          const dir = actionToUnitVec(action);
          const reach = 4;
          c.target.set(c.pos.x + dir.x * reach, 0, c.pos.z + dir.z * reach);
          // Break out of grazing pause so the policy actually moves.
          c.pauseTimer = 0;
          // Drop any existing combat target so the brain's direction wins.
          c.prey.combatTarget = null;
        }
      },
    };
  }

  findNearestPrey(pos: THREE.Vector3, maxDist: number): PreyRef | null {
    let best: Cat | null = null;
    let bestSq = maxDist * maxDist;
    for (const c of this.cats) {
      if (c.held || c.prey.dead) continue;
      const dx = c.pos.x - pos.x;
      const dz = c.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = c; }
    }
    if (!best) return null;
    return this.makePreyRef(best);
  }

  private makePreyRef(c: Cat): PreyRef {
    return {
      id: c.id,
      name: c.name,
      team: 'neutral',
      mesh: c.parts.group,
      get pos() { return c.pos; },
      get alive() { return !c.prey.dead; },
      get hp() { return c.prey.hp; },
      get maxHp() { return c.prey.maxHp; },
      get radius() { return CAT_RADIUS; },
      damage: (amount: number, attacker?: PreyRef) => {
        if (c.prey.dead) return false;
        c.prey.hp -= amount;
        c.prey.lastHitAt = performance.now();
        emitDamageSplat(c.parts.group, amount);
        notePreyAttacker(c.prey, attacker);
        if (attacker?.alive) c.prey.combatTarget = attacker;
        if (c.prey.hp <= 0) {
          c.prey.hp = 0;
          c.prey.dead = true;
          c.prey.combatTarget = null;
          c.parts.group.rotation.x = Math.PI / 2 * 0.9;
          return true;
        }
        return false;
      },
      heal: (amount: number) => {
        const healed = healPreyState(c.prey, amount);
        if (healed > 0) emitHealSplat(c.parts.group, healed);
        return healed;
      },
      scare: (fromX, fromZ, durMs) => {
        if (c.prey.dead) return;
        c.prey.fleeUntil = performance.now() + durMs;
        c.prey.fleeFromX = fromX;
        c.prey.fleeFromZ = fromZ;
        // Cats sprint short bursts: instantly pick a target away.
        const dx = c.pos.x - fromX, dz = c.pos.z - fromZ;
        const d = Math.hypot(dx, dz) || 1;
        c.target.set(c.pos.x + dx / d * 6, 0, c.pos.z + dz / d * 6);
        c.pauseTimer = 0;
      },
    };
  }

  forEachPrey(fn: (ref: PreyRef) => void): void {
    for (const c of this.cats) if (!c.held && !c.prey.dead) fn(this.makePreyRef(c));
  }

  setColliders(colliders: Collider[]): void {
    this.colliders = colliders;
  }

  findNearestHoldable(pos: THREE.Vector3, maxDist: number): Holdable | null {
    let best: Cat | null = null;
    let bestSq = maxDist * maxDist;
    for (const cat of this.cats) {
      if (cat.held) continue;
      const dx = cat.pos.x - pos.x;
      const dz = cat.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = cat; }
    }
    if (!best) return null;
    return this.makeHoldable(best);
  }

  private makeHoldable(cat: Cat): Holdable {
    return {
      mesh: cat.parts.group,
      get held() { return cat.held; },
      set held(v: boolean) { cat.held = v; },
      pickUp: () => { cat.held = true; },
      releaseAt: (pos, yaw) => {
        cat.held = false;
        cat.pos.set(pos.x, 0, pos.z);
        cat.yaw = yaw;
        cat.target = pickTarget(cat.bounds);
        cat.pauseTimer = 0.6 + Math.random() * 0.6;
        for (const leg of cat.parts.legs) leg.mesh.rotation.x = 0;
        cat.parts.body.position.y = 0.48;
        cat.parts.head.rotation.x = 0;
        cat.parts.tail.rotation.y = 0;
        for (const seg of cat.parts.tailSegments) seg.rotation.set(0, 0, 0);
      }
    };
  }

  private updateCat(cat: Cat, delta: number): void {
    const grazed = tickGrazeHeal(cat.prey, delta, 5);
    if (grazed > 0) emitHealSplat(cat.parts.group, grazed);
    if (cat.prey.grazingUntil > performance.now()) {
      cat.pauseTimer = Math.max(cat.pauseTimer, 0.3);
    }
    this.updateCombat(cat, delta);
    const moving = cat.pauseTimer <= 0;

    if (!moving) {
      cat.pauseTimer -= delta;
      // Idle: lazy tail flick — base swings, segments trail with phase offset
      const t = performance.now() * 0.004;
      cat.parts.tail.rotation.y = Math.sin(t) * 0.3;
      cat.parts.tailSegments.forEach((seg, i) => {
        seg.rotation.y = Math.sin(t - i * 0.4) * 0.25;
      });
      // Slow head turn — curious cat
      cat.parts.head.rotation.y = Math.sin(t * 0.5) * 0.3;
      for (const leg of cat.parts.legs) leg.mesh.rotation.x *= 0.9;
      this.applyTerrain(cat);
      return;
    }

    cat.parts.head.rotation.y *= 0.9;

    const dx = cat.target.x - cat.pos.x;
    const dz = cat.target.z - cat.pos.z;
    const distSq = dx * dx + dz * dz;

    // RL4 control timeout: drop brain steer after 1.5s without a refresh.
    const brainAge = performance.now() - (cat.brainSteerAt ?? 0);
    if (cat.brainSteer && brainAge > 1500) cat.brainSteer = false;

    if (distSq < REACH_RADIUS * REACH_RADIUS) {
      // Brain control: don't pick a new wander target on arrival — the
      // policy refreshes `cat.target` on its next decision tick.
      if (cat.brainSteer) {
        // fall through to steering — keep moving until brain updates target
      } else {
        if (Math.random() < PAUSE_CHANCE) {
          cat.pauseTimer = PAUSE_TIME[0] + Math.random() * (PAUSE_TIME[1] - PAUSE_TIME[0]);
        }
        cat.target = pickTarget(cat.bounds);
        return;
      }
    }

    const desiredYaw = Math.atan2(dx, dz);
    let yawDiff = desiredYaw - cat.yaw;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    const turnRate = cat.brainSteer ? TURN_RATE * 3 : TURN_RATE;
    const turn = Math.max(-turnRate * delta, Math.min(turnRate * delta, yawDiff));
    cat.yaw += turn;

    const turnPenalty = 1 - Math.min(1, Math.abs(yawDiff) / Math.PI) * 0.6;
    const speed = WALK_SPEED * turnPenalty;
    cat.pos.x += Math.sin(cat.yaw) * speed * delta;
    cat.pos.z += Math.cos(cat.yaw) * speed * delta;

    if (Math.abs(cat.pos.x) > cat.bounds || Math.abs(cat.pos.z) > cat.bounds) {
      cat.target = pickTarget(cat.bounds);
    }

    // Walk cycle — slightly faster cadence than dog, lighter step
    cat.walkPhase += delta * 10 * turnPenalty;
    const swing = Math.sin(cat.walkPhase) * 0.6;
    const swingOpp = Math.sin(cat.walkPhase + Math.PI) * 0.6;
    cat.parts.legs[0].mesh.rotation.x = swing;
    cat.parts.legs[1].mesh.rotation.x = swingOpp;
    cat.parts.legs[2].mesh.rotation.x = swingOpp;
    cat.parts.legs[3].mesh.rotation.x = swing;

    // Subtle body bob — cats are smoother walkers
    const bob = Math.abs(Math.sin(cat.walkPhase * 2)) * 0.025;
    cat.parts.body.position.y = 0.48 + bob;

    // Tail swish — base drives, segments trail with increasing phase lag and amplitude
    const tailPhase = cat.walkPhase * 0.6;
    cat.parts.tail.rotation.y = Math.sin(tailPhase) * 0.4;
    cat.parts.tailSegments.forEach((seg, i) => {
      seg.rotation.y = Math.sin(tailPhase - (i + 1) * 0.5) * (0.25 + i * 0.05);
      // Slight upward curve at rest
      seg.rotation.x = -0.08;
    });

    cat.parts.head.rotation.x = Math.sin(cat.walkPhase) * 0.05;

    this.applyTerrain(cat);
  }

  private applyTerrain(cat: Cat): void {
    const y = resolveAnimalPhysics(cat.pos, {
      radius: CAT_RADIUS,
      bounds: cat.bounds,
      heightData: cat.heightData,
      colliders: this.colliders,
    });
    cat.parts.group.position.set(cat.pos.x, y, cat.pos.z);
    cat.parts.group.rotation.y = cat.yaw;
  }

  private updateCombat(cat: Cat, delta: number): void {
    cat.prey.attackTimer = Math.max(0, cat.prey.attackTimer - delta);
    const target = cat.prey.combatTarget;
    if (!target?.alive) {
      cat.prey.combatTarget = null;
      return;
    }
    const dx = target.pos.x - cat.pos.x;
    const dz = target.pos.z - cat.pos.z;
    const attackRange = combatContactRange(CAT_RADIUS, target);
    if (dx * dx + dz * dz > attackRange * attackRange) {
      cat.target.set(target.pos.x, 0, target.pos.z);
      cat.pauseTimer = 0;
      return;
    }
    maintainCombatSpacing(cat.pos, target, attackRange);
    cat.yaw = Math.atan2(dx, dz);
    if (cat.prey.attackTimer <= 0) {
      target.damage(5, this.makePreyRef(cat));
      cat.prey.attackTimer = 1.4;
    }
  }
}
