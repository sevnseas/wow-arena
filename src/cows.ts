/**
 * Procedural low-poly cows that wander the arena.
 * Larger and slower than the other animals, with a barrel body, small
 * horns, an udder, and a thin tail that ends in a tuft.
 */

import * as THREE from 'three';
import type { Collider } from './arena';
import { Holdable, HoldableProvider } from './holdable';
import type { PreyRef, PreyProvider, PreyState } from './prey';
import { applyIntentToPreyState, combatContactRange, emitDamageSplat, emitHealSplat, healPreyState, maintainCombatSpacing, makePreyState, notePreyAttacker, tickGrazeHeal } from './prey';
import { Intent, INTENT_COUNT, type PolicyAgentRef } from './rl';
import { resolveAnimalPhysics } from './animal-physics';

const WALK_SPEED = 1.0;
const TURN_RATE = 1.6;
const REACH_RADIUS = 1.5;
const PAUSE_CHANCE = 0.5;
const PAUSE_TIME = [2.5, 6.0];
const COW_RADIUS = 0.7;

const PALETTE = [
  { body: 0xf2ede3, spot: 0x1a1a1a }, // classic holstein white + black
  { body: 0xb8845a, spot: 0xffffff }, // brown + white
  { body: 0x2a2422, spot: 0xe8d4a8 }, // black + cream
  { body: 0xd9c5a0, spot: 0x6b3e22 }  // tan + dark brown
];

interface CowParts {
  group: THREE.Group;
  legs: { mesh: THREE.Mesh; phase: number }[];
  tail: THREE.Object3D;
  tailTuft: THREE.Object3D;
  head: THREE.Object3D;
  body: THREE.Object3D;
}

interface Cow {
  parts: CowParts;
  pos: THREE.Vector3;
  yaw: number;
  target: THREE.Vector3;
  pauseTimer: number;
  walkPhase: number;
  bounds: number;
  heightData: Uint8Array | null;
  held: boolean;
  mooCooldown: number;
  prey: PreyState;
  id: string;
  name: string;
  personalityBias: Float32Array;
  temperature: number;
}

interface MooBubble {
  sprite: THREE.Sprite;
  cow: Cow;
  age: number;
  lifetime: number;
}

const MOO_BUBBLE_LIFETIME = 2.2;
const MOO_INITIAL_DELAY = [3, 12];
const MOO_INTERVAL = [8, 22];

// Cached sprite texture — same for every moo, drawn once.
let mooTexture: THREE.CanvasTexture | null = null;
function getMooTexture(): THREE.CanvasTexture {
  if (mooTexture) return mooTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 128);
  // RuneScape-style: bright yellow text, hard black 1-pixel drop shadow.
  ctx.font = 'bold 80px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000000';
  ctx.fillText('Moo', 128 + 3, 64 + 3);
  ctx.fillStyle = '#ffff00';
  ctx.fillText('Moo', 128, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  mooTexture = tex;
  return tex;
}

function makeCowHideTexture(bodyHex: number, spotHex: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const toCss = (hex: number) => '#' + hex.toString(16).padStart(6, '0');
  ctx.fillStyle = toCss(bodyHex);
  ctx.fillRect(0, 0, 256, 256);

  // Each spot is a cluster of 3-6 overlapping ellipses → soft, organic edge.
  ctx.fillStyle = toCss(spotHex);
  const spotCount = 6 + Math.floor(Math.random() * 5);
  for (let i = 0; i < spotCount; i++) {
    const cx = Math.random() * 256;
    const cy = Math.random() * 256;
    const blobs = 3 + Math.floor(Math.random() * 4);
    for (let j = 0; j < blobs; j++) {
      const ox = (Math.random() - 0.5) * 60;
      const oy = (Math.random() - 0.5) * 60;
      const rx = 18 + Math.random() * 28;
      const ry = 18 + Math.random() * 28;
      const rot = Math.random() * Math.PI;
      ctx.beginPath();
      ctx.ellipse(cx + ox, cy + oy, rx, ry, rot, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildCowMesh(): CowParts {
  const palette = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  // Hide texture carries the spots — body geometry stays clean.
  const hideTex = makeCowHideTexture(palette.body, palette.spot);
  const bodyMat = new THREE.MeshStandardMaterial({ map: hideTex, roughness: 0.9, metalness: 0.0 });
  const plainBodyMat = new THREE.MeshStandardMaterial({ color: palette.body, roughness: 0.9, metalness: 0.0 });
  const tuftMat = new THREE.MeshStandardMaterial({ color: palette.spot, roughness: 0.9 });
  const hornMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.5 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xd9a4a4, roughness: 0.7 });
  const udderMat = new THREE.MeshStandardMaterial({ color: 0xe8a8a8, roughness: 0.8 });
  const hoofMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.7 });

  const group = new THREE.Group();
  group.name = 'Cow';

  // Body — chunky barrel, spots come from the texture.
  const bodyGeo = new THREE.BoxGeometry(0.75, 0.7, 1.4);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.95;
  body.castShadow = true;
  group.add(body);

  // Head pivot at front
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 1.05, 0.78);
  group.add(headPivot);

  const neckGeo = new THREE.BoxGeometry(0.42, 0.42, 0.32);
  const neck = new THREE.Mesh(neckGeo, plainBodyMat);
  neck.position.set(0, -0.06, 0.04);
  neck.castShadow = true;
  headPivot.add(neck);

  const headGeo = new THREE.BoxGeometry(0.46, 0.42, 0.5);
  const head = new THREE.Mesh(headGeo, plainBodyMat);
  head.position.set(0, 0.04, 0.38);
  head.castShadow = true;
  headPivot.add(head);

  // Snout (lighter)
  const snoutGeo = new THREE.BoxGeometry(0.34, 0.22, 0.2);
  const snout = new THREE.Mesh(snoutGeo, noseMat);
  snout.position.set(0, -0.08, 0.62);
  headPivot.add(snout);

  // Nostrils
  const nostrilGeo = new THREE.BoxGeometry(0.05, 0.05, 0.04);
  const nostrilL = new THREE.Mesh(nostrilGeo, hoofMat);
  nostrilL.position.set(-0.08, -0.05, 0.72);
  headPivot.add(nostrilL);
  const nostrilR = nostrilL.clone();
  nostrilR.position.x = 0.08;
  headPivot.add(nostrilR);

  // Eyes
  const eyeGeo = new THREE.BoxGeometry(0.07, 0.07, 0.04);
  const eyeL = new THREE.Mesh(eyeGeo, hoofMat);
  eyeL.position.set(-0.13, 0.1, 0.62);
  headPivot.add(eyeL);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.13;
  headPivot.add(eyeR);

  // Floppy side ears
  const earGeo = new THREE.BoxGeometry(0.16, 0.1, 0.22);
  const earL = new THREE.Mesh(earGeo, plainBodyMat);
  earL.position.set(-0.27, 0.16, 0.22);
  earL.rotation.z = 0.4;
  headPivot.add(earL);
  const earR = earL.clone();
  earR.position.x = 0.27;
  earR.rotation.z = -0.4;
  headPivot.add(earR);

  // Small horns — short cones
  const hornGeo = new THREE.ConeGeometry(0.05, 0.18, 6);
  const hornL = new THREE.Mesh(hornGeo, hornMat);
  hornL.position.set(-0.16, 0.28, 0.22);
  hornL.rotation.z = 0.5;
  headPivot.add(hornL);
  const hornR = hornL.clone();
  hornR.position.x = 0.16;
  hornR.rotation.z = -0.5;
  headPivot.add(hornR);

  // Udder under the back belly
  const udderGeo = new THREE.BoxGeometry(0.32, 0.18, 0.32);
  const udder = new THREE.Mesh(udderGeo, udderMat);
  udder.position.set(0, 0.55, -0.4);
  group.add(udder);
  // Teats
  const teatGeo = new THREE.BoxGeometry(0.05, 0.08, 0.05);
  for (const [x, z] of [[-0.08, -0.32], [0.08, -0.32], [-0.08, -0.48], [0.08, -0.48]]) {
    const teat = new THREE.Mesh(teatGeo, udderMat);
    teat.position.set(x, 0.43, z);
    group.add(teat);
  }

  // Tail — root pivot at back, with a tuft pivot at the tip
  const tailRoot = new THREE.Group();
  tailRoot.position.set(0, 1.2, -0.7);
  tailRoot.rotation.x = -0.2;
  group.add(tailRoot);

  const tailGeo = new THREE.BoxGeometry(0.07, 0.07, 0.6);
  const tail = new THREE.Mesh(tailGeo, plainBodyMat);
  tail.position.z = -0.3;
  tail.castShadow = true;
  tailRoot.add(tail);

  // Tuft pivot at the end of the tail
  const tuftPivot = new THREE.Group();
  tuftPivot.position.set(0, 0, -0.6);
  tailRoot.add(tuftPivot);
  const tuftGeo = new THREE.BoxGeometry(0.16, 0.16, 0.18);
  const tuft = new THREE.Mesh(tuftGeo, tuftMat);
  tuft.position.z = -0.09;
  tuft.castShadow = true;
  tuftPivot.add(tuft);

  // Legs — thicker and longer than dog
  const legs: CowParts['legs'] = [];
  const legPositions: [number, number, number][] = [
    [-0.28, 0.55, 0],
    [0.28, 0.55, Math.PI],
    [-0.28, -0.55, Math.PI],
    [0.28, -0.55, 0]
  ];
  for (const [x, z, phase] of legPositions) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.78, z);
    group.add(pivot);

    const legGeo = new THREE.BoxGeometry(0.18, 0.7, 0.18);
    const leg = new THREE.Mesh(legGeo, plainBodyMat);
    leg.position.y = -0.35;
    leg.castShadow = true;
    pivot.add(leg);

    const hoofGeo = new THREE.BoxGeometry(0.2, 0.1, 0.22);
    const hoof = new THREE.Mesh(hoofGeo, hoofMat);
    hoof.position.y = -0.74;
    pivot.add(hoof);

    legs.push({ mesh: pivot as unknown as THREE.Mesh, phase });
  }

  return { group, legs, tail: tailRoot, tailTuft: tuftPivot, head: headPivot, body };
}

function pickTarget(bounds: number): THREE.Vector3 {
  const r = bounds * 0.85;
  return new THREE.Vector3(
    (Math.random() * 2 - 1) * r,
    0,
    (Math.random() * 2 - 1) * r
  );
}

export class CowHerd implements HoldableProvider, PreyProvider {
  private cows: Cow[] = [];
  private group: THREE.Group;
  private bounds: number;
  private heightData: Uint8Array | null;
  private moos: MooBubble[] = [];
  private scene: THREE.Scene;
  private targetCount: number;
  private respawnTimer = 8;
  private colliders: Collider[] = [];

  constructor(scene: THREE.Scene, count: number, bounds: number, heightData: Uint8Array | null) {
    this.bounds = bounds;
    this.heightData = heightData;
    this.targetCount = count;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'CowHerd';
    scene.add(this.group);

    for (let i = 0; i < count; i++) this.spawnCow();
  }

  private spawnCow(): void {
    const parts = buildCowMesh();
    const start = pickTarget(this.bounds);
    const cow: Cow = {
      parts,
      pos: start.clone(),
      yaw: Math.random() * Math.PI * 2,
      target: pickTarget(this.bounds),
      pauseTimer: Math.random() * 2,
      walkPhase: Math.random() * Math.PI * 2,
      bounds: this.bounds,
      heightData: this.heightData,
      held: false,
      mooCooldown: MOO_INITIAL_DELAY[0] + Math.random() * (MOO_INITIAL_DELAY[1] - MOO_INITIAL_DELAY[0]),
      prey: makePreyState(120),       // cows are tanky
      id: `cow-${this.cows.length + 1}`,
      name: 'Cow',
      personalityBias: (() => {
        const b = new Float32Array(INTENT_COUNT);
        b[Intent.Heal] = 0.6 + Math.random() * 0.4;   // cows like to graze
        b[Intent.Flee] = (Math.random() - 0.4) * 0.3;
        return b;
      })(),
      temperature: 0.7 + Math.random() * 0.5,
    };
    parts.group.position.copy(start);
    parts.group.rotation.y = cow.yaw;
    parts.group.userData.policyAgentId = cow.id;
    parts.group.userData.policyArchetype = 'cow';
    this.group.add(parts.group);
    this.cows.push(cow);
  }

  update(delta: number): void {
    for (const cow of this.cows) {
      if (cow.held) continue;
      if (cow.prey.dead) {
        cow.prey.deadTimer += delta;
        if (cow.prey.deadTimer > 8) {
          this.group.remove(cow.parts.group);
          const idx = this.cows.indexOf(cow);
          if (idx >= 0) this.cows.splice(idx, 1);
        } else if (cow.prey.deadTimer > 4) {
          const t = (cow.prey.deadTimer - 4) / 4;
          cow.parts.group.scale.setScalar(1 - t);
        }
        continue;
      }
      this.updateCow(cow, delta);
      cow.mooCooldown -= delta;
      if (cow.mooCooldown <= 0) {
        this.spawnMoo(cow);
        cow.mooCooldown = MOO_INTERVAL[0] + Math.random() * (MOO_INTERVAL[1] - MOO_INTERVAL[0]);
      }
    }
    this.updateMoos(delta);
    this.respawnTimer -= delta;
    if (this.respawnTimer <= 0 && this.cows.length < this.targetCount) {
      this.spawnCow();
      this.respawnTimer = 12 + Math.random() * 6;
    }
  }

  getPolicyAgents(): PolicyAgentRef[] {
    return this.cows.map(c => this.makePolicyAgent(c));
  }

  private makePolicyAgent(c: Cow): PolicyAgentRef {
    return {
      id: c.id,
      team: 'prey',
      archetype: 'cow',
      size: COW_RADIUS,
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

  findNearestPrey(pos: THREE.Vector3, maxDist: number): PreyRef | null {
    let best: Cow | null = null;
    let bestSq = maxDist * maxDist;
    for (const c of this.cows) {
      if (c.held || c.prey.dead) continue;
      const dx = c.pos.x - pos.x;
      const dz = c.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = c; }
    }
    if (!best) return null;
    return this.makePreyRef(best);
  }

  private makePreyRef(c: Cow): PreyRef {
    return {
      id: c.id,
      name: c.name,
      team: 'neutral',
      mesh: c.parts.group,
      get pos() { return c.pos; },
      get alive() { return !c.prey.dead; },
      get hp() { return c.prey.hp; },
      get maxHp() { return c.prey.maxHp; },
      get radius() { return COW_RADIUS; },
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
        // Cows are slow; nudge their target away.
        const dx = c.pos.x - fromX, dz = c.pos.z - fromZ;
        const d = Math.hypot(dx, dz) || 1;
        c.target.set(c.pos.x + dx / d * 4, 0, c.pos.z + dz / d * 4);
        c.pauseTimer = 0;
      },
    };
  }

  forEachPrey(fn: (ref: PreyRef) => void): void {
    for (const c of this.cows) if (!c.held && !c.prey.dead) fn(this.makePreyRef(c));
  }

  setColliders(colliders: Collider[]): void {
    this.colliders = colliders;
  }

  private spawnMoo(cow: Cow): void {
    const mat = new THREE.SpriteMaterial({
      map: getMooTexture(),
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.4, 0.7, 1);
    // World-space sprite so it doesn't rotate with the cow.
    this.scene.add(sprite);
    const head = cow.parts.group.position;
    sprite.position.set(head.x, head.y + 2.0, head.z);
    sprite.renderOrder = 999;
    this.moos.push({ sprite, cow, age: 0, lifetime: MOO_BUBBLE_LIFETIME });
  }

  private updateMoos(delta: number): void {
    for (let i = this.moos.length - 1; i >= 0; i--) {
      const m = this.moos[i];
      m.age += delta;
      const t = m.age / m.lifetime;
      if (t >= 1) {
        this.scene.remove(m.sprite);
        m.sprite.material.dispose();
        this.moos.splice(i, 1);
        continue;
      }
      // Rise above the cow's head, fade out near the end.
      const cowPos = m.cow.parts.group.position;
      m.sprite.position.set(cowPos.x, cowPos.y + 2.0 + t * 0.6, cowPos.z);
      m.sprite.material.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    }
  }

  findNearestHoldable(pos: THREE.Vector3, maxDist: number): Holdable | null {
    let best: Cow | null = null;
    let bestSq = maxDist * maxDist;
    for (const cow of this.cows) {
      if (cow.held) continue;
      const dx = cow.pos.x - pos.x;
      const dz = cow.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = cow; }
    }
    if (!best) return null;
    return this.makeHoldable(best);
  }

  private makeHoldable(cow: Cow): Holdable {
    return {
      mesh: cow.parts.group,
      get held() { return cow.held; },
      set held(v: boolean) { cow.held = v; },
      pickUp: () => { cow.held = true; },
      releaseAt: (pos, yaw) => {
        cow.held = false;
        cow.pos.set(pos.x, 0, pos.z);
        cow.yaw = yaw;
        cow.target = pickTarget(cow.bounds);
        cow.pauseTimer = 0.6 + Math.random() * 0.6;
        for (const leg of cow.parts.legs) leg.mesh.rotation.x = 0;
        cow.parts.body.position.y = 0.95;
        cow.parts.head.rotation.x = 0;
        cow.parts.tail.rotation.y = 0;
        cow.parts.tailTuft.rotation.set(0, 0, 0);
      }
    };
  }

  private updateCow(cow: Cow, delta: number): void {
    // Brain-driven graze regen: if the policy is holding Heal, slowly heal
    // and force a grazing pause so the cow doesn't keep wandering / fighting.
    const grazed = tickGrazeHeal(cow.prey, delta, 5);
    if (grazed > 0) emitHealSplat(cow.parts.group, grazed);
    if (cow.prey.grazingUntil > performance.now()) {
      cow.pauseTimer = Math.max(cow.pauseTimer, 0.3);
    }
    this.updateCombat(cow, delta);
    const moving = cow.pauseTimer <= 0;

    if (!moving) {
      cow.pauseTimer -= delta;
      // Idle: lazy tail flick to swat flies, slow head dip (grazing)
      const t = performance.now() * 0.003;
      cow.parts.tail.rotation.y = Math.sin(t) * 0.25;
      cow.parts.tailTuft.rotation.y = Math.sin(t - 0.6) * 0.5;
      cow.parts.head.rotation.x = 0.2 + Math.sin(t * 0.4) * 0.15;
      for (const leg of cow.parts.legs) leg.mesh.rotation.x *= 0.9;
      this.applyTerrain(cow);
      return;
    }

    cow.parts.head.rotation.x *= 0.9;

    const dx = cow.target.x - cow.pos.x;
    const dz = cow.target.z - cow.pos.z;
    const distSq = dx * dx + dz * dz;

    if (distSq < REACH_RADIUS * REACH_RADIUS) {
      if (Math.random() < PAUSE_CHANCE) {
        cow.pauseTimer = PAUSE_TIME[0] + Math.random() * (PAUSE_TIME[1] - PAUSE_TIME[0]);
      }
      cow.target = pickTarget(cow.bounds);
      return;
    }

    const desiredYaw = Math.atan2(dx, dz);
    let yawDiff = desiredYaw - cow.yaw;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    const turn = Math.max(-TURN_RATE * delta, Math.min(TURN_RATE * delta, yawDiff));
    cow.yaw += turn;

    const turnPenalty = 1 - Math.min(1, Math.abs(yawDiff) / Math.PI) * 0.6;
    const speed = WALK_SPEED * turnPenalty;
    cow.pos.x += Math.sin(cow.yaw) * speed * delta;
    cow.pos.z += Math.cos(cow.yaw) * speed * delta;

    if (Math.abs(cow.pos.x) > cow.bounds || Math.abs(cow.pos.z) > cow.bounds) {
      cow.target = pickTarget(cow.bounds);
    }

    // Slower, heavier walk cycle
    cow.walkPhase += delta * 6 * turnPenalty;
    const swing = Math.sin(cow.walkPhase) * 0.55;
    const swingOpp = Math.sin(cow.walkPhase + Math.PI) * 0.55;
    cow.parts.legs[0].mesh.rotation.x = swing;
    cow.parts.legs[1].mesh.rotation.x = swingOpp;
    cow.parts.legs[2].mesh.rotation.x = swingOpp;
    cow.parts.legs[3].mesh.rotation.x = swing;

    // Heavier body bob
    const bob = Math.abs(Math.sin(cow.walkPhase * 2)) * 0.06;
    cow.parts.body.position.y = 0.95 + bob;

    // Tail swings gently; tuft trails with phase lag and bigger amplitude
    cow.parts.tail.rotation.y = Math.sin(cow.walkPhase * 0.7) * 0.3;
    cow.parts.tailTuft.rotation.y = Math.sin(cow.walkPhase * 0.7 - 0.6) * 0.7;

    cow.parts.head.rotation.x = Math.sin(cow.walkPhase) * 0.06;

    this.applyTerrain(cow);
  }

  private applyTerrain(cow: Cow): void {
    const y = resolveAnimalPhysics(cow.pos, {
      radius: COW_RADIUS,
      bounds: cow.bounds,
      heightData: cow.heightData,
      colliders: this.colliders,
    });
    cow.parts.group.position.set(cow.pos.x, y, cow.pos.z);
    cow.parts.group.rotation.y = cow.yaw;
  }

  private updateCombat(cow: Cow, delta: number): void {
    cow.prey.attackTimer = Math.max(0, cow.prey.attackTimer - delta);
    const target = cow.prey.combatTarget;
    if (!target?.alive) {
      cow.prey.combatTarget = null;
      return;
    }
    const dx = target.pos.x - cow.pos.x;
    const dz = target.pos.z - cow.pos.z;
    const attackRange = combatContactRange(COW_RADIUS, target);
    if (dx * dx + dz * dz > attackRange * attackRange) {
      cow.target.set(target.pos.x, 0, target.pos.z);
      cow.pauseTimer = 0;
      return;
    }
    maintainCombatSpacing(cow.pos, target, attackRange);
    cow.yaw = Math.atan2(dx, dz);
    if (cow.prey.attackTimer <= 0) {
      target.damage(9, this.makePreyRef(cow));
      cow.prey.attackTimer = 1.9;
    }
  }
}
