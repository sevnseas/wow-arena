/**
 * Procedural low-poly rabbits. Smaller than dogs and they hop in short
 * bursts: a quick forward leap, a brief landing pause, then sometimes
 * stop entirely to look around before picking a new direction.
 */

import * as THREE from 'three';
import type { Collider } from './arena';
import { Holdable, HoldableProvider } from './holdable';
import { resolveAnimalPhysics } from './animal-physics';

const HOP_SPEED = 2.6;          // peak forward speed during a hop
const HOP_DURATION = 0.45;      // seconds of one hop arc
const HOP_REST_RANGE = [0.2, 0.5];  // pause between hops while traveling
const TURN_RATE = 4.5;
const REACH_RADIUS = 0.8;
const STOP_CHANCE = 0.45;       // chance to fully stop after reaching a spot
const STOP_TIME = [1.5, 4.5];
const RABBIT_RADIUS = 0.28;

const PALETTE = [
  { body: 0xeae3d2, belly: 0xfffaf0 }, // white
  { body: 0x8a7458, belly: 0xd9c9af }, // brown
  { body: 0x444240, belly: 0x6b6864 }, // gray
  { body: 0xc9a87a, belly: 0xe8d5af }  // tan
];

export interface RabbitParts {
  group: THREE.Group;
  body: THREE.Object3D;
  head: THREE.Object3D;
  earL: THREE.Object3D;
  earR: THREE.Object3D;
  legsBack: THREE.Object3D[];
  legsFront: THREE.Object3D[];
  tail: THREE.Object3D;
}

type RabbitState = 'hop' | 'rest' | 'stopped';

import type { PreyRef, PreyProvider, PreyState } from './prey';
import { combatContactRange, emitDamageSplat, emitHealSplat, healPreyState, maintainCombatSpacing, makePreyState, notePreyAttacker, tickGrazeHeal } from './prey';
import { Intent, INTENT_COUNT, type PolicyAgentRef } from './rl';

interface Rabbit {
  parts: RabbitParts;
  pos: THREE.Vector3;
  yaw: number;
  target: THREE.Vector3;
  state: RabbitState;
  stateTimer: number;     // remaining time in current state
  hopPhase: number;       // 0..1 within current hop
  bounds: number;
  heightData: Uint8Array | null;
  held: boolean;
  prey: PreyState;
  id: string;
  name: string;
  personalityBias: Float32Array;
  temperature: number;
}

export function buildRabbitMesh(): RabbitParts {
  const palette = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const bodyMat = new THREE.MeshStandardMaterial({ color: palette.body, roughness: 0.9, metalness: 0.0 });
  const bellyMat = new THREE.MeshStandardMaterial({ color: palette.belly, roughness: 0.9, metalness: 0.0 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xff8a9a, roughness: 0.7 });

  const group = new THREE.Group();
  group.name = 'Rabbit';

  // Round-ish body (squashed sphere)
  const bodyGeo = new THREE.SphereGeometry(0.22, 10, 8);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.scale.set(1.1, 0.9, 1.4);
  body.position.y = 0.27;
  body.castShadow = true;
  group.add(body);

  // Belly highlight
  const bellyGeo = new THREE.SphereGeometry(0.18, 8, 6);
  const belly = new THREE.Mesh(bellyGeo, bellyMat);
  belly.scale.set(1.0, 0.5, 1.2);
  belly.position.set(0, 0.18, 0);
  group.add(belly);

  // Head pivot at front
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.34, 0.28);
  group.add(headPivot);

  const headGeo = new THREE.SphereGeometry(0.16, 10, 8);
  const head = new THREE.Mesh(headGeo, bodyMat);
  head.scale.set(1.0, 0.95, 1.05);
  head.castShadow = true;
  headPivot.add(head);

  // Nose
  const noseGeo = new THREE.SphereGeometry(0.025, 6, 6);
  const nose = new THREE.Mesh(noseGeo, noseMat);
  nose.position.set(0, -0.02, 0.16);
  headPivot.add(nose);

  // Eyes
  const eyeGeo = new THREE.SphereGeometry(0.022, 6, 6);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.07, 0.04, 0.12);
  headPivot.add(eyeL);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.07;
  headPivot.add(eyeR);

  // Long ears — pivoted at base so they can twitch
  const earGeo = new THREE.BoxGeometry(0.05, 0.28, 0.07);
  const earPivotL = new THREE.Group();
  earPivotL.position.set(-0.07, 0.12, -0.02);
  headPivot.add(earPivotL);
  const earL = new THREE.Mesh(earGeo, bodyMat);
  earL.position.y = 0.14;
  earL.castShadow = true;
  earPivotL.add(earL);
  earPivotL.rotation.z = 0.1;

  const earPivotR = new THREE.Group();
  earPivotR.position.set(0.07, 0.12, -0.02);
  headPivot.add(earPivotR);
  const earR = new THREE.Mesh(earGeo, bodyMat);
  earR.position.y = 0.14;
  earR.castShadow = true;
  earPivotR.add(earR);
  earPivotR.rotation.z = -0.1;

  // Tail — small fluffy ball
  const tailGeo = new THREE.SphereGeometry(0.08, 8, 6);
  const tail = new THREE.Mesh(tailGeo, bellyMat);
  tail.position.set(0, 0.3, -0.32);
  group.add(tail);

  // Front legs (small, tucked)
  const frontLegGeo = new THREE.BoxGeometry(0.07, 0.14, 0.08);
  const legsFront: THREE.Object3D[] = [];
  for (const x of [-0.1, 0.1]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.18, 0.18);
    group.add(pivot);
    const leg = new THREE.Mesh(frontLegGeo, bodyMat);
    leg.position.y = -0.07;
    leg.castShadow = true;
    pivot.add(leg);
    legsFront.push(pivot);
  }

  // Back legs (bigger, more visible — pivot for hop tuck)
  const backLegGeo = new THREE.BoxGeometry(0.1, 0.18, 0.18);
  const legsBack: THREE.Object3D[] = [];
  for (const x of [-0.13, 0.13]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.18, -0.15);
    group.add(pivot);
    const leg = new THREE.Mesh(backLegGeo, bodyMat);
    leg.position.y = -0.09;
    leg.castShadow = true;
    pivot.add(leg);
    legsBack.push(pivot);
  }

  return { group, body, head: headPivot, earL: earPivotL, earR: earPivotR, legsBack, legsFront, tail };
}

function pickTarget(bounds: number): THREE.Vector3 {
  const r = bounds * 0.85;
  return new THREE.Vector3(
    (Math.random() * 2 - 1) * r,
    0,
    (Math.random() * 2 - 1) * r
  );
}

export class RabbitWarren implements HoldableProvider, PreyProvider {
  private rabbits: Rabbit[] = [];
  private group: THREE.Group;
  private bounds: number;
  private heightData: Uint8Array | null;
  private targetCount: number;
  private respawnTimer = 4;
  private colliders: Collider[] = [];

  constructor(scene: THREE.Scene, count: number, bounds: number, heightData: Uint8Array | null) {
    this.bounds = bounds;
    this.heightData = heightData;
    this.targetCount = count;
    this.group = new THREE.Group();
    this.group.name = 'RabbitWarren';
    scene.add(this.group);

    for (let i = 0; i < count; i++) {
      this.spawnRabbit();
    }
  }

  private spawnRabbit(): void {
    const parts = buildRabbitMesh();
    const start = pickTarget(this.bounds);
    const rabbit: Rabbit = {
      parts,
      pos: start.clone(),
      yaw: Math.random() * Math.PI * 2,
      target: pickTarget(this.bounds),
      state: 'rest',
      stateTimer: Math.random() * 1.5,
      hopPhase: 0,
      bounds: this.bounds,
      heightData: this.heightData,
      held: false,
      prey: makePreyState(30),
      id: `rabbit-${this.rabbits.length + 1}`,
      name: 'Rabbit',
      personalityBias: (() => {
        const b = new Float32Array(INTENT_COUNT);
        // Rabbits get a flee bias by default — variance gives some bolder bunnies.
        b[Intent.Flee] = 0.5 + Math.random() * 0.6;
        b[Intent.Idle] = (Math.random() - 0.3) * 0.5;
        return b;
      })(),
      temperature: 0.6 + Math.random() * 0.7,
    };
    parts.group.position.copy(start);
    parts.group.rotation.y = rabbit.yaw;
    parts.group.userData.policyAgentId = rabbit.id;
    parts.group.userData.policyArchetype = 'rabbit';
    this.group.add(parts.group);
    this.rabbits.push(rabbit);
  }

  update(delta: number): void {
    for (const r of this.rabbits) {
      if (r.held) continue;
      if (r.prey.dead) {
        this.updateDead(r, delta);
        continue;
      }
      this.updateRabbit(r, delta);
    }
    // Slow respawn: keep the warren topped up so wolves always have prey.
    this.respawnTimer -= delta;
    if (this.respawnTimer <= 0 && this.rabbits.length < this.targetCount) {
      this.spawnRabbit();
      this.respawnTimer = 4 + Math.random() * 4;
    }
  }

  /**
   * Adapters for the RL PolicyDriver. The brain selects Flee/Idle; the
   * existing hop/scare state machine executes the result.
   */
  getPolicyAgents(): PolicyAgentRef[] {
    return this.rabbits.map(r => this.makePolicyAgent(r));
  }

  private makePolicyAgent(r: Rabbit): PolicyAgentRef {
    return {
      id: r.id,
      team: 'prey',
      archetype: 'rabbit',
      size: RABBIT_RADIUS,
      personalityBias: r.personalityBias,
      temperature: r.temperature,
      get alive() { return !r.prey.dead && !r.held; },
      get hp() { return r.prey.hp; },
      get maxHp() { return r.prey.maxHp; },
      get status() { return 0 as 0 | 1 | 2; },
      get pos() { return { x: r.pos.x, z: r.pos.z }; },
      get attackerId() { return r.prey.lastAttackerId; },
      applyIntent(intent: Intent, focus, ctx) {
        if (r.prey.dead || r.held) return;
        // Flee with attacker-priority: actual damager wins over generic focus.
        if (intent === Intent.Flee) {
          let fromX = focus?.pos.x ?? r.pos.x + 1;
          let fromZ = focus?.pos.z ?? r.pos.z;
          if (r.prey.lastAttackerId) {
            const att = ctx?.resolveAttacker?.(r.prey.lastAttackerId);
            if (att) { fromX = att.pos.x; fromZ = att.pos.z; }
          }
          r.prey.fleeUntil = performance.now() + 1100;
          r.prey.fleeFromX = fromX;
          r.prey.fleeFromZ = fromZ;
          r.prey.grazingUntil = 0;
          return;
        }
        if (intent === Intent.Heal) {
          // Stand-and-graze: clear flee, mark grazing window so tickGrazeHeal regens.
          r.prey.fleeUntil = 0;
          r.prey.grazingUntil = performance.now() + 1500;
          return;
        }
        if (intent === Intent.Idle) {
          r.prey.fleeUntil = 0;
          r.prey.grazingUntil = 0;
          return;
        }
        // Attack / CC → no-op for rabbits; they let foraging continue.
      },
    };
  }

  findNearestPrey(pos: THREE.Vector3, maxDist: number): PreyRef | null {
    let best: Rabbit | null = null;
    let bestSq = maxDist * maxDist;
    for (const r of this.rabbits) {
      if (r.prey.dead || r.held) continue;
      const dx = r.pos.x - pos.x;
      const dz = r.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = r; }
    }
    if (!best) return null;
    return this.makePreyRef(best);
  }

  private makePreyRef(r: Rabbit): PreyRef {
    return {
      id: r.id,
      name: r.name,
      team: 'neutral',
      mesh: r.parts.group,
      get pos() { return r.pos; },
      get alive() { return !r.prey.dead; },
      get hp() { return r.prey.hp; },
      get maxHp() { return r.prey.maxHp; },
      get radius() { return RABBIT_RADIUS; },
      damage: (amount: number, attacker?: PreyRef) => {
        if (r.prey.dead) return false;
        r.prey.hp -= amount;
        r.prey.lastHitAt = performance.now();
        emitDamageSplat(r.parts.group, amount);
        notePreyAttacker(r.prey, attacker);
        if (attacker?.alive) r.prey.combatTarget = attacker;
        if (r.prey.hp <= 0) {
          r.prey.hp = 0;
          r.prey.dead = true;
          r.prey.combatTarget = null;
          r.parts.group.rotation.x = Math.PI / 2 * 0.9;
          return true;
        }
        return false;
      },
      heal: (amount: number) => {
        const healed = healPreyState(r.prey, amount);
        if (healed > 0) emitHealSplat(r.parts.group, healed);
        return healed;
      },
      scare: (fromX: number, fromZ: number, durationMs: number) => {
        if (r.prey.dead) return;
        r.prey.fleeUntil = performance.now() + durationMs;
        r.prey.fleeFromX = fromX;
        r.prey.fleeFromZ = fromZ;
      },
    };
  }

  /** Iterate over all living prey refs (used by the HP-bar overlay). */
  forEachPrey(fn: (ref: PreyRef) => void): void {
    for (const r of this.rabbits) {
      if (!r.held && !r.prey.dead) fn(this.makePreyRef(r));
    }
  }

  setColliders(colliders: Collider[]): void {
    this.colliders = colliders;
  }

  private updateDead(r: Rabbit, delta: number): void {
    r.prey.deadTimer += delta;
    const fadeStart = 3.0;
    const fadeEnd = 6.0;
    if (r.prey.deadTimer >= fadeEnd) {
      this.group.remove(r.parts.group);
      const idx = this.rabbits.indexOf(r);
      if (idx >= 0) this.rabbits.splice(idx, 1);
      return;
    }
    if (r.prey.deadTimer > fadeStart) {
      const t = (r.prey.deadTimer - fadeStart) / (fadeEnd - fadeStart);
      r.parts.group.scale.setScalar(1 - t);
    }
  }

  findNearestHoldable(pos: THREE.Vector3, maxDist: number): Holdable | null {
    let best: Rabbit | null = null;
    let bestSq = maxDist * maxDist;
    for (const r of this.rabbits) {
      if (r.held) continue;
      const dx = r.pos.x - pos.x;
      const dz = r.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = r; }
    }
    if (!best) return null;
    const rab = best;
    return {
      mesh: rab.parts.group,
      get held() { return rab.held; },
      set held(v: boolean) { rab.held = v; },
      pickUp: () => { rab.held = true; },
      releaseAt: (p, yaw) => {
        rab.held = false;
        rab.pos.set(p.x, 0, p.z);
        rab.yaw = yaw;
        rab.target = pickTarget(rab.bounds);
        rab.state = 'rest';
        rab.stateTimer = 0.4 + Math.random() * 0.6;
        rab.hopPhase = 0;
        for (const l of rab.parts.legsBack) l.rotation.x = 0;
        for (const l of rab.parts.legsFront) l.rotation.x = 0;
        rab.parts.body.position.y = 0.27;
        rab.parts.head.position.y = 0.34;
        rab.parts.head.rotation.y = 0;
        rab.parts.tail.position.y = 0.3;
      }
    };
  }

  private updateRabbit(r: Rabbit, delta: number): void {
    const now = performance.now();
    const grazed = tickGrazeHeal(r.prey, delta, 4);
    if (grazed > 0) emitHealSplat(r.parts.group, grazed);
    this.updateCombat(r, delta);

    // Flee: if a predator scared us recently, point target directly away
    // and force hop state. Wears off after fleeUntil expires.
    if (r.prey.fleeUntil > now) {
      const dx = r.pos.x - r.prey.fleeFromX;
      const dz = r.pos.z - r.prey.fleeFromZ;
      const d = Math.hypot(dx, dz) || 1;
      const fleeDist = 8;
      r.target.set(
        Math.max(-r.bounds, Math.min(r.bounds, r.pos.x + (dx / d) * fleeDist)),
        0,
        Math.max(-r.bounds, Math.min(r.bounds, r.pos.z + (dz / d) * fleeDist)),
      );
      if (r.state === 'stopped' || r.state === 'rest') {
        r.state = 'hop';
        r.hopPhase = 0;
        r.stateTimer = 0;
      }
    }

    // Steer (always face target if we're not deeply stopped)
    if (r.state !== 'stopped') {
      const dx = r.target.x - r.pos.x;
      const dz = r.target.z - r.pos.z;
      const desiredYaw = Math.atan2(dx, dz);
      let yawDiff = desiredYaw - r.yaw;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      r.yaw += Math.max(-TURN_RATE * delta, Math.min(TURN_RATE * delta, yawDiff));
    }

    // State machine
    if (r.state === 'hop') {
      r.hopPhase += delta / HOP_DURATION;
      const t = Math.min(1, r.hopPhase);

      // Forward speed peaks mid-hop (sin profile)
      const speedFactor = Math.sin(t * Math.PI);
      r.pos.x += Math.sin(r.yaw) * HOP_SPEED * speedFactor * delta;
      r.pos.z += Math.cos(r.yaw) * HOP_SPEED * speedFactor * delta;

      // Vertical arc
      const hopHeight = Math.sin(t * Math.PI) * 0.18;
      r.parts.body.position.y = 0.27 + hopHeight;
      r.parts.head.position.y = 0.34 + hopHeight;
      r.parts.tail.position.y = 0.3 + hopHeight;

      // Tuck back legs forward, then extend; front legs swing slightly
      const tuck = Math.sin(t * Math.PI);
      r.parts.legsBack[0].rotation.x = -0.6 * tuck;
      r.parts.legsBack[1].rotation.x = -0.6 * tuck;
      r.parts.legsFront[0].rotation.x = 0.4 * tuck;
      r.parts.legsFront[1].rotation.x = 0.4 * tuck;

      // Ears bob a bit
      r.parts.earL.rotation.x = -0.1 * tuck;
      r.parts.earR.rotation.x = -0.1 * tuck;

      if (t >= 1) {
        r.state = 'rest';
        r.stateTimer = HOP_REST_RANGE[0] + Math.random() * (HOP_REST_RANGE[1] - HOP_REST_RANGE[0]);
        r.hopPhase = 0;
        // Reset limbs
        for (const l of r.parts.legsBack) l.rotation.x = 0;
        for (const l of r.parts.legsFront) l.rotation.x = 0;
        r.parts.body.position.y = 0.27;
        r.parts.head.position.y = 0.34;
        r.parts.tail.position.y = 0.3;
      }
    } else if (r.state === 'rest') {
      r.stateTimer -= delta;
      // Subtle breathing
      const breathe = Math.sin(now * 0.005) * 0.005;
      r.parts.body.position.y = 0.27 + breathe;

      const dx = r.target.x - r.pos.x;
      const dz = r.target.z - r.pos.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < REACH_RADIUS * REACH_RADIUS) {
        // Arrived — sometimes stop and look around, otherwise pick new target
        if (Math.random() < STOP_CHANCE) {
          r.state = 'stopped';
          r.stateTimer = STOP_TIME[0] + Math.random() * (STOP_TIME[1] - STOP_TIME[0]);
        } else {
          r.target = pickTarget(r.bounds);
          r.stateTimer = 0;
        }
      } else if (r.stateTimer <= 0) {
        r.state = 'hop';
        r.hopPhase = 0;
      }
    } else {
      // stopped — twitch ears, look around occasionally
      r.stateTimer -= delta;
      const twitchL = Math.sin(now * 0.012) * 0.15;
      const twitchR = Math.sin(now * 0.012 + 1.7) * 0.15;
      r.parts.earL.rotation.z = 0.1 + twitchL;
      r.parts.earR.rotation.z = -0.1 + twitchR;
      r.parts.head.rotation.y = Math.sin(now * 0.0015) * 0.6;

      if (r.stateTimer <= 0) {
        r.parts.head.rotation.y = 0;
        r.target = pickTarget(r.bounds);
        r.state = 'rest';
        r.stateTimer = 0.2;
      }
    }

    // Soft arena bounds
    if (Math.abs(r.pos.x) > r.bounds || Math.abs(r.pos.z) > r.bounds) {
      r.target = pickTarget(r.bounds);
    }

    // Settle ears toward neutral when not stopped
    if (r.state !== 'stopped') {
      r.parts.earL.rotation.z += (0.1 - r.parts.earL.rotation.z) * 0.1;
      r.parts.earR.rotation.z += (-0.1 - r.parts.earR.rotation.z) * 0.1;
    }

    // Apply terrain
    const y = resolveAnimalPhysics(r.pos, {
      radius: RABBIT_RADIUS,
      bounds: r.bounds,
      heightData: r.heightData,
      colliders: this.colliders,
    });
    r.parts.group.position.set(r.pos.x, y, r.pos.z);
    r.parts.group.rotation.y = r.yaw;
  }

  private updateCombat(r: Rabbit, delta: number): void {
    r.prey.attackTimer = Math.max(0, r.prey.attackTimer - delta);
    const target = r.prey.combatTarget;
    if (!target?.alive) {
      r.prey.combatTarget = null;
      return;
    }
    const dx = target.pos.x - r.pos.x;
    const dz = target.pos.z - r.pos.z;
    const attackRange = combatContactRange(RABBIT_RADIUS, target);
    if (dx * dx + dz * dz > attackRange * attackRange) return;
    maintainCombatSpacing(r.pos, target, attackRange);
    r.yaw = Math.atan2(dx, dz);
    if (r.prey.attackTimer <= 0) {
      target.damage(3, this.makePreyRef(r));
      r.prey.attackTimer = 1.8;
    }
  }
}
