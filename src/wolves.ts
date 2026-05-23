/**
 * Predator wolves — wander around their den, hunt nearby rabbits, fight
 * them on contact, then return to the den. Visual style follows the dog
 * mesh pattern (low-poly procedural) but with a leaner silhouette and
 * grey/dark palette.
 *
 * Combat reuses the existing damage-splat pattern: when a wolf bites a
 * rabbit, DamageSplatSystem.spawnDamage paints a floating number on the
 * prey, matching how player abilities feed back damage.
 *
 * State machine: idle / wander / hunt / attack / feed / return-to-den.
 */

import * as THREE from 'three';
import { getTerrainHeight } from './terrain';
import type { Collider } from './arena';
import { combatContactRange, emitDamageSplat, emitHealSplat, maintainCombatSpacing, type CombatTargetRef, type PreyRef, type PreyProvider } from './prey';
import { resolveAnimalPhysics } from './animal-physics';
import { Intent, INTENT_COUNT, type PolicyAgentRef } from './rl';

const WALK_SPEED = 1.8;
const HUNT_SPEED = 4.0;
const TURN_RATE = 3.0;
const REACH_RADIUS = 1.0;
const PROWL_RADIUS = 6;          // wander radius around the den when idle
const SCENT_RADIUS = 18;         // how far a wolf can smell prey
/**
 * Base bite damage. Final damage scales with attacker size — a bigger wolf
 * hits proportionally harder (see entity-policies.md / RL env, which uses
 * the same dmg = base * size rule for consistency with training).
 */
const ATTACK_DAMAGE_BASE = 16; // base * WOLF_RADIUS (0.5) ≈ 8, matches prior tuning
const ATTACK_COOLDOWN = 1.4;     // seconds between bites
const FEED_TIME = 3.0;           // seconds after a kill before resuming patrol
const SCARE_RADIUS = 6;          // wolves passing close scare rabbits even without attacking
const WOLF_RADIUS = 0.5;

const WOLF_PALETTE = [
  { body: 0x4a4a4f, belly: 0x6a6a72, ears: 0x222226 }, // timber grey
  { body: 0x2e2e2e, belly: 0x444448, ears: 0x111111 }, // black wolf
  { body: 0x6e6359, belly: 0x968a7c, ears: 0x3a342c }, // brown wolf
];

interface WolfParts {
  group: THREE.Group;
  legs: THREE.Object3D[];
  tail: THREE.Object3D;
  head: THREE.Object3D;
  body: THREE.Object3D;
  jaw: THREE.Object3D;
}

type WolfState = 'wander' | 'hunt' | 'attack' | 'feed' | 'return';

interface Wolf {
  parts: WolfParts;
  pos: THREE.Vector3;
  yaw: number;
  state: WolfState;
  target: THREE.Vector3;
  prey: CombatTargetRef | null;
  attackTimer: number;     // counts down between bites
  stateTimer: number;
  walkPhase: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  deadTimer: number;
  lastHitAt: number;
  id: string;
  name: string;
  aggro: Map<string, { ref: CombatTargetRef; score: number }>;
  prowlCenter: THREE.Vector3;
  /** Per-individual policy overrides (set when running under PolicyDriver). */
  personalityBias: Float32Array;
  temperature: number;
  /** Brain-driven intent override; null = use built-in state machine. */
  brainIntent: 'idle' | 'attack' | 'flee' | null;
}

function buildWolfMesh(): WolfParts {
  const palette = WOLF_PALETTE[Math.floor(Math.random() * WOLF_PALETTE.length)];
  const bodyMat = new THREE.MeshStandardMaterial({ color: palette.body, roughness: 0.85, flatShading: true });
  const bellyMat = new THREE.MeshStandardMaterial({ color: palette.belly, roughness: 0.85, flatShading: true });
  const earMat = new THREE.MeshStandardMaterial({ color: palette.ears, roughness: 0.9, flatShading: true });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xe8c63a });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });

  const group = new THREE.Group();
  group.name = 'Wolf';

  // Body: leaner & longer than the dog box.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 1.15), bodyMat);
  body.position.y = 0.62;
  body.castShadow = true;
  group.add(body);

  // Belly (paler underside)
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.53, 0.2, 1.05), bellyMat);
  belly.position.set(0, 0.46, 0);
  group.add(belly);

  // Hackles ridge along the back — a small raised box for menace.
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.85), bodyMat);
  ridge.position.set(0, 0.92, 0.05);
  group.add(ridge);

  // Head pivot at front (slightly lower than dog for more wolf-like posture).
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.7, 0.6);
  headPivot.rotation.x = 0.05;
  group.add(headPivot);

  // Neck
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.36, 0.34), bodyMat);
  neck.position.set(0, -0.08, 0.05);
  headPivot.add(neck);

  // Head (wedge — wider at back, narrower at snout via tapered chain)
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.4), bodyMat);
  head.position.set(0, 0.05, 0.32);
  headPivot.add(head);

  // Snout
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.32), bodyMat);
  snout.position.set(0, -0.05, 0.6);
  headPivot.add(snout);

  // Jaw (animated when biting)
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.15, 0.58);
  headPivot.add(jaw);
  const jawMesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.3), bellyMat);
  jawMesh.position.set(0, -0.04, 0.0);
  jaw.add(jawMesh);

  // Nose
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.08), noseMat);
  nose.position.set(0, -0.02, 0.77);
  headPivot.add(nose);

  // Pointed ears
  const earGeo = new THREE.ConeGeometry(0.12, 0.28, 4);
  const earL = new THREE.Mesh(earGeo, earMat);
  earL.position.set(-0.15, 0.32, 0.18);
  earL.rotation.z = 0.18;
  headPivot.add(earL);
  const earR = earL.clone();
  earR.position.x = 0.15;
  earR.rotation.z = -0.18;
  headPivot.add(earR);

  // Glowing yellow eyes
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), eyeMat);
    eye.position.set(0.11 * sx, 0.12, 0.48);
    headPivot.add(eye);
  }

  // Tail (longer, hanging low)
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.68, -0.6);
  tailPivot.rotation.x = -0.7;
  group.add(tailPivot);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.55), bodyMat);
  tail.position.z = -0.28;
  tail.castShadow = true;
  tailPivot.add(tail);

  // Legs — taller than dogs (more wolfish)
  const legs: THREE.Object3D[] = [];
  const positions: [number, number, number][] = [
    [-0.2, 0.5, 0],          // FL
    [0.2, 0.5, Math.PI],     // FR
    [-0.2, -0.45, Math.PI],  // BL
    [0.2, -0.45, 0],         // BR
  ];
  for (const [x, z, phase] of positions) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.5, z);
    group.add(pivot);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.52, 0.12), bodyMat);
    leg.position.y = -0.26;
    leg.castShadow = true;
    pivot.add(leg);
    const paw = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.18), noseMat);
    paw.position.y = -0.5;
    pivot.add(paw);
    pivot.userData.phase = phase;
    legs.push(pivot);
  }

  return { group, legs, tail: tailPivot, head: headPivot, body, jaw };
}

function buildDen(): THREE.Group {
  // A simple stone formation: a few large boulders + a dark cave mouth.
  const den = new THREE.Group();
  den.name = 'WolvesSpawningGround';

  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x554f48, roughness: 1.0, flatShading: true });
  const darkMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });

  // 3 surrounding boulders
  const boulderRadii = [1.6, 1.3, 1.5];
  const boulderAngles = [Math.PI * 0.2, Math.PI * 0.95, Math.PI * 1.5];
  for (let i = 0; i < boulderRadii.length; i++) {
    const r = boulderRadii[i];
    const a = boulderAngles[i];
    const x = Math.cos(a) * 2.0;
    const z = Math.sin(a) * 2.0;
    const b = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), stoneMat);
    b.position.set(x, r * 0.55, z);
    b.rotation.y = a;
    b.castShadow = true;
    b.receiveShadow = true;
    den.add(b);
  }

  // Cave mouth: dark recessed disc + small overhang
  const arch = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.4, 0.5, 12, 1, true), stoneMat);
  arch.position.y = 1.55;
  arch.rotation.x = Math.PI / 2;
  arch.rotation.z = 0;
  den.add(arch);

  const mouth = new THREE.Mesh(new THREE.CircleGeometry(1.05, 16), darkMat);
  mouth.position.set(0, 1.2, 0.01);
  mouth.rotation.x = 0;
  den.add(mouth);

  // Bone tokens scattered out front
  for (let i = 0; i < 4; i++) {
    const bone = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xe9e2cf, roughness: 0.9 }),
    );
    bone.position.set(
      (Math.random() - 0.5) * 2.6,
      0.04,
      0.8 + Math.random() * 1.4,
    );
    bone.rotation.y = Math.random() * Math.PI * 2;
    den.add(bone);
  }

  return den;
}

export class WolfPack implements PreyProvider {
  private wolves: Wolf[] = [];
  private group: THREE.Group;
  private den: THREE.Group;
  private denPos: THREE.Vector3;
  private bounds: number;
  private heightData: Uint8Array | null;
  private preyProviders: PreyProvider[];
  private colliders: Collider[] = [];

  constructor(
    scene: THREE.Scene,
    count: number,
    bounds: number,
    heightData: Uint8Array | null,
    preyProviders: PreyProvider[],
    denPos: THREE.Vector3 = new THREE.Vector3(-14, 0, -14),
  ) {
    this.bounds = bounds;
    this.heightData = heightData;
    this.preyProviders = preyProviders;
    this.denPos = denPos.clone();

    this.group = new THREE.Group();
    this.group.name = 'WolfPack';
    scene.add(this.group);

    // Den is its own scene child so it's pickable as a landmark.
    this.den = buildDen();
    this.den.position.set(denPos.x, getTerrainHeight(denPos.x, denPos.z, heightData), denPos.z);
    scene.add(this.den);

    for (let i = 0; i < count; i++) {
      this.spawnWolf();
    }
  }

  private spawnWolf(): void {
    const parts = buildWolfMesh();
    const idx = this.wolves.length;
    const angle = idx * 2.399963 + Math.random() * 0.45;
    const spread = 2.5 + (idx % 3) * 1.4 + Math.random() * 1.2;
    const offset = new THREE.Vector3(
      Math.cos(angle) * spread,
      0,
      Math.sin(angle) * spread,
    );
    const pos = this.denPos.clone().add(offset);
    const wolf: Wolf = {
      parts,
      pos,
      yaw: Math.random() * Math.PI * 2,
      state: 'wander',
      target: new THREE.Vector3(),
      prey: null,
      attackTimer: 0,
      stateTimer: 0,
      walkPhase: Math.random() * Math.PI * 2,
      hp: 60,
      maxHp: 60,
      dead: false,
      deadTimer: 0,
      lastHitAt: 0,
      id: `wolf-${this.wolves.length + 1}`,
      name: 'Wolf',
      aggro: new Map(),
      prowlCenter: pos.clone(),
      personalityBias: (() => {
        // Subtle per-wolf personality: mild attack bias + jitter so each
        // wolf in the pack behaves a little differently (entity-policies §2).
        const b = new Float32Array(INTENT_COUNT);
        b[Intent.Attack] = 0.4 + Math.random() * 0.4;
        b[Intent.Idle] = (Math.random() - 0.5) * 0.4;
        b[Intent.Flee] = (Math.random() - 0.5) * 0.3;
        return b;
      })(),
      temperature: 0.7 + Math.random() * 0.8,
      brainIntent: null,
    };
    wolf.target.copy(this.pickWanderTarget(wolf));
    parts.group.position.copy(pos);
    parts.group.rotation.y = wolf.yaw;
    parts.group.userData.policyAgentId = wolf.id;
    parts.group.userData.policyArchetype = 'wolf';
    this.group.add(parts.group);
    this.wolves.push(wolf);
  }

  private pickWanderTarget(wolf?: Wolf): THREE.Vector3 {
    const center = wolf?.prowlCenter ?? this.denPos;
    const a = Math.random() * Math.PI * 2;
    const r = PROWL_RADIUS * Math.sqrt(Math.random());
    return new THREE.Vector3(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
  }

  update(delta: number): void {
    for (const wolf of this.wolves) {
      if (wolf.dead) {
        wolf.deadTimer += delta;
        if (wolf.deadTimer > 10) {
          wolf.dead = false;
          wolf.deadTimer = 0;
          wolf.hp = wolf.maxHp;
          wolf.aggro.clear();
          wolf.parts.group.rotation.x = 0;
          wolf.pos.copy(this.denPos).add(new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3));
          wolf.prowlCenter.copy(wolf.pos);
          wolf.target.copy(this.pickWanderTarget(wolf));
          wolf.state = 'wander';
        }
        continue;
      }
      this.updateWolf(wolf, delta);
    }
  }

  setColliders(colliders: Collider[]): void {
    this.colliders = colliders;
  }

  /**
   * Per-wolf adapter for the RL PolicyDriver. The brain picks an Intent
   * every ~0.5s and we map it onto the existing state machine — keeping
   * pathing and combat timing algorithmic (Tier 2), only routing the
   * high-level "attack / idle / flee" choice through the network.
   */
  getPolicyAgents(): PolicyAgentRef[] {
    return this.wolves.map(w => this.makePolicyAgent(w));
  }

  private makePolicyAgent(w: Wolf): PolicyAgentRef {
    const self = this;
    return {
      id: w.id,
      team: 'predator',
      archetype: 'wolf',
      size: WOLF_RADIUS,
      personalityBias: w.personalityBias,
      temperature: w.temperature,
      get alive() { return !w.dead; },
      get hp() { return w.hp; },
      get maxHp() { return w.maxHp; },
      get status() { return 0 as 0 | 1 | 2; },
      get pos() { return { x: w.pos.x, z: w.pos.z }; },
      get attackerId() { return null; },
      applyIntent(intent: Intent, focus, ctx) {
        if (w.dead) return;
        switch (intent) {
          case Intent.Attack: {
            w.brainIntent = 'attack';
            // Latch onto the brain-chosen focus if it's a valid huntable.
            if (focus && focus.team !== 'predator') {
              const ref = self.resolvePreyByPos(focus.pos.x, focus.pos.z, focus.id);
              if (ref) {
                w.prey = ref;
                self.addAggro(w, ref, 5);
                w.state = w.state === 'attack' ? 'attack' : 'hunt';
              }
            }
            break;
          }
          case Intent.Flee: {
            w.brainIntent = 'flee';
            // Prefer fleeing away from whoever's actively damaging this wolf
            // (resolved via ctx) — falls back to focus if there's no attacker.
            // The brain knows it's hurt; the engine just needs the right vector.
            const last = w.lastHitAt > 0 ? null : null; // wolves don't track attackerId yet
            let from = focus;
            if (last) from = last;
            if (from) {
              const tx = w.pos.x - (from.pos.x - w.pos.x);
              const tz = w.pos.z - (from.pos.z - w.pos.z);
              w.target.set(tx, 0, tz);
              w.state = 'return';
            }
            void ctx;
            break;
          }
          case Intent.Heal: {
            // "Hide" — drop combat target, wander away, regen if not hit.
            w.brainIntent = 'idle';
            w.prey = null;
            w.aggro.clear();
            if (w.state === 'hunt' || w.state === 'attack') {
              w.state = 'wander';
              w.target.copy(self.pickWanderTarget(w));
            }
            // Regen pulse (tickGrazeHeal would need a PreyState; wolves use
            // their own hp field, so heal inline when off-combat for ≥2s).
            const now = performance.now();
            if (now - w.lastHitAt > 2000 && w.hp < w.maxHp) {
              w.hp = Math.min(w.maxHp, w.hp + 4 * 0.5); // ~4 hp/sec at 0.5s decisions
            }
            break;
          }
          case Intent.Idle:
          default: {
            w.brainIntent = 'idle';
            w.prey = null;
            w.aggro.clear();
            if (w.state === 'hunt' || w.state === 'attack') {
              w.state = 'wander';
              w.target.copy(self.pickWanderTarget(w));
            }
            break;
          }
        }
      },
    };
  }

  private resolvePreyByPos(x: number, z: number, id: string): CombatTargetRef | null {
    // Tiny lookup across providers — match by id or by tight position window.
    for (const prov of this.preyProviders) {
      let found: CombatTargetRef | null = null;
      prov.forEachPrey(ref => {
        if (found || !ref.alive) return;
        if (ref.id === id) { found = ref; return; }
        if (Math.hypot(ref.pos.x - x, ref.pos.z - z) < 0.5) found = ref;
      });
      if (found) return found;
    }
    return null;
  }

  /**
   * Wolf positions for the grass-actor list (so prowling wolves also bend
   * grass blades). Other systems can read these too.
   */
  getPositions(): THREE.Vector3[] {
    return this.wolves.map(w => w.pos);
  }

  /** Query every non-wolf prey provider and return the closest living prey. */
  private findNearestHuntTarget(pos: THREE.Vector3, maxDist: number): PreyRef | null {
    let best: PreyRef | null = null;
    let bestSq = maxDist * maxDist;
    for (const prov of this.preyProviders) {
      const candidate = prov.findNearestPrey(pos, maxDist);
      if (!candidate) continue;
      const dx = candidate.pos.x - pos.x;
      const dz = candidate.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = candidate; }
    }
    return best;
  }

  findNearestPrey(pos: THREE.Vector3, maxDist: number): PreyRef | null {
    let best: Wolf | null = null;
    let bestSq = maxDist * maxDist;
    for (const wolf of this.wolves) {
      if (wolf.dead) continue;
      const dx = wolf.pos.x - pos.x;
      const dz = wolf.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) { bestSq = d; best = wolf; }
    }
    return best ? this.makePreyRef(best) : null;
  }

  forEachPrey(fn: (ref: PreyRef) => void): void {
    for (const wolf of this.wolves) {
      if (!wolf.dead) fn(this.makePreyRef(wolf));
    }
  }

  private makePreyRef(wolf: Wolf): PreyRef {
    return {
      id: wolf.id,
      name: wolf.name,
      team: 'enemy',
      mesh: wolf.parts.group,
      get pos() { return wolf.pos; },
      get alive() { return !wolf.dead; },
      get hp() { return wolf.hp; },
      get maxHp() { return wolf.maxHp; },
      get radius() { return WOLF_RADIUS; },
      damage: (amount: number, attacker?: PreyRef) => {
        if (wolf.dead) return false;
        wolf.hp -= amount;
        wolf.lastHitAt = performance.now();
        emitDamageSplat(wolf.parts.group, amount);
        if (attacker?.alive) {
          this.addAggro(wolf, attacker, amount + 40);
          wolf.prey = attacker;
          wolf.state = 'hunt';
          wolf.stateTimer = 0;
        }
        if (wolf.hp <= 0) {
          wolf.hp = 0;
          wolf.dead = true;
          wolf.prey = null;
          wolf.aggro.clear();
          wolf.parts.group.rotation.x = Math.PI / 2 * 0.9;
          return true;
        }
        return false;
      },
      heal: (amount: number) => {
        if (wolf.dead || wolf.hp >= wolf.maxHp) return 0;
        const before = wolf.hp;
        wolf.hp = Math.min(wolf.maxHp, wolf.hp + amount);
        wolf.lastHitAt = performance.now();
        const healed = wolf.hp - before;
        if (healed > 0) emitHealSplat(wolf.parts.group, healed);
        return healed;
      },
      scare: () => {},
    };
  }

  private addAggro(wolf: Wolf, ref: CombatTargetRef, amount: number): void {
    if (ref.id === wolf.id) return;
    const existing = wolf.aggro.get(ref.id);
    wolf.aggro.set(ref.id, { ref, score: (existing?.score ?? 0) + amount });
  }

  private chooseAggroTarget(wolf: Wolf): CombatTargetRef | null {
    let best: CombatTargetRef | null = null;
    let bestScore = 0;
    for (const [id, entry] of wolf.aggro) {
      entry.score *= 0.995;
      if (!entry.ref.alive || entry.score < 1) {
        wolf.aggro.delete(id);
        continue;
      }
      if (entry.score > bestScore) {
        bestScore = entry.score;
        best = entry.ref;
      }
    }
    return best;
  }

  private updateWolf(wolf: Wolf, delta: number): void {
    // Cooldown decay
    if (wolf.attackTimer > 0) wolf.attackTimer = Math.max(0, wolf.attackTimer - delta);
    wolf.stateTimer += delta;

    // ----- prey acquisition / loss -----
    const aggroTarget = this.chooseAggroTarget(wolf);
    if (aggroTarget && aggroTarget !== wolf.prey) {
      wolf.prey = aggroTarget;
      wolf.state = 'hunt';
      wolf.stateTimer = 0;
    }
    if (wolf.state === 'wander' || wolf.state === 'return') {
      const prey = this.findNearestHuntTarget(wolf.pos, SCENT_RADIUS);
      if (prey) {
        wolf.prey = prey;
        this.addAggro(wolf, prey, 10);
        wolf.state = 'hunt';
        wolf.stateTimer = 0;
      }
    }
    if (wolf.prey && !wolf.prey.alive) {
      wolf.prey = null;
      if (wolf.state === 'hunt' || wolf.state === 'attack') {
        wolf.state = 'feed';
        wolf.stateTimer = 0;
      }
    }

    // ----- per-state behaviour -----
    let moveSpeed = WALK_SPEED;
    let targetX = wolf.target.x;
    let targetZ = wolf.target.z;

    switch (wolf.state) {
      case 'wander': {
        const dx = wolf.target.x - wolf.pos.x;
        const dz = wolf.target.z - wolf.pos.z;
        if (dx * dx + dz * dz < REACH_RADIUS * REACH_RADIUS) {
          wolf.target.copy(this.pickWanderTarget(wolf));
        }
        break;
      }
      case 'hunt': {
        if (!wolf.prey) { wolf.state = 'wander'; break; }
        targetX = wolf.prey.pos.x;
        targetZ = wolf.prey.pos.z;
        moveSpeed = HUNT_SPEED;
        // Scare the prey as we close in.
        wolf.prey.scare?.(wolf.pos.x, wolf.pos.z, 1500);
        // In bite range → transition to attack
        const dx = targetX - wolf.pos.x;
        const dz = targetZ - wolf.pos.z;
        const attackRange = combatContactRange(WOLF_RADIUS, wolf.prey);
        if (dx * dx + dz * dz < attackRange * attackRange) {
          wolf.state = 'attack';
          wolf.stateTimer = 0;
        }
        break;
      }
      case 'attack': {
        if (!wolf.prey) { wolf.state = 'feed'; wolf.stateTimer = 0; break; }
        targetX = wolf.prey.pos.x;
        targetZ = wolf.prey.pos.z;
        moveSpeed = 0; // hold position
        // Out of bite range? Resume chase.
        const dx = targetX - wolf.pos.x;
        const dz = targetZ - wolf.pos.z;
        const attackRange = combatContactRange(WOLF_RADIUS, wolf.prey);
        maintainCombatSpacing(wolf.pos, wolf.prey, attackRange);
        if (dx * dx + dz * dz > (attackRange * 1.6) * (attackRange * 1.6)) {
          wolf.state = 'hunt';
          break;
        }
        // Bite on cooldown
        if (wolf.attackTimer <= 0) {
          const wolfRef = this.makePreyRef(wolf);
          const damage = ATTACK_DAMAGE_BASE * WOLF_RADIUS;
          const killed = wolf.prey.damage(damage, wolfRef);
          this.addAggro(wolf, wolf.prey, damage);
          wolf.attackTimer = ATTACK_COOLDOWN;
          // Jaw snap visual
          wolf.parts.jaw.rotation.x = -0.6;
          if (killed) {
            wolf.prey = null;
            wolf.state = 'feed';
            wolf.stateTimer = 0;
          }
        }
        break;
      }
      case 'feed': {
        moveSpeed = 0;
        if (wolf.stateTimer >= FEED_TIME) {
          wolf.state = 'return';
          wolf.stateTimer = 0;
          wolf.target.set(this.denPos.x, 0, this.denPos.z);
        }
        break;
      }
      case 'return': {
        const dx = this.denPos.x - wolf.pos.x;
        const dz = this.denPos.z - wolf.pos.z;
        if (dx * dx + dz * dz < (PROWL_RADIUS * 0.8) * (PROWL_RADIUS * 0.8)) {
          wolf.state = 'wander';
          wolf.target.copy(this.pickWanderTarget(wolf));
        }
        break;
      }
    }

    // ----- steering -----
    const dx = targetX - wolf.pos.x;
    const dz = targetZ - wolf.pos.z;
    const desiredYaw = Math.atan2(dx, dz);
    let yawDiff = desiredYaw - wolf.yaw;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    wolf.yaw += Math.max(-TURN_RATE * delta, Math.min(TURN_RATE * delta, yawDiff));

    if (moveSpeed > 0) {
      const turnPenalty = 1 - Math.min(1, Math.abs(yawDiff) / Math.PI) * 0.55;
      const sp = moveSpeed * turnPenalty;
      wolf.pos.x += Math.sin(wolf.yaw) * sp * delta;
      wolf.pos.z += Math.cos(wolf.yaw) * sp * delta;
      // Soft bounds
      wolf.pos.x = Math.max(-this.bounds, Math.min(this.bounds, wolf.pos.x));
      wolf.pos.z = Math.max(-this.bounds, Math.min(this.bounds, wolf.pos.z));

      // Walk-cycle animation (faster during hunt for galloping feel).
      wolf.walkPhase += delta * (moveSpeed > WALK_SPEED ? 14 : 9) * turnPenalty;
      const swing = Math.sin(wolf.walkPhase) * 0.75;
      const swingOpp = Math.sin(wolf.walkPhase + Math.PI) * 0.75;
      wolf.parts.legs[0].rotation.x = swing;
      wolf.parts.legs[1].rotation.x = swingOpp;
      wolf.parts.legs[2].rotation.x = swingOpp;
      wolf.parts.legs[3].rotation.x = swing;
      wolf.parts.body.position.y = 0.62 + Math.abs(Math.sin(wolf.walkPhase * 2)) * 0.05;
      wolf.parts.tail.rotation.y = Math.sin(wolf.walkPhase * 1.2) * 0.4;
    } else {
      // Settle legs while idle/attacking/feeding.
      for (const leg of wolf.parts.legs) leg.rotation.x *= 0.85;
    }

    // Jaw recovery between bites.
    wolf.parts.jaw.rotation.x = Math.min(0, wolf.parts.jaw.rotation.x + delta * 3);

    // Drop to terrain & rotate.
    const y = resolveAnimalPhysics(wolf.pos, {
      radius: WOLF_RADIUS,
      bounds: this.bounds,
      heightData: this.heightData,
      colliders: this.colliders,
    });
    wolf.parts.group.position.set(wolf.pos.x, y, wolf.pos.z);
    wolf.parts.group.rotation.y = wolf.yaw;

    // Passive scare aura: rabbits very close panic even without active hunt.
    // (Stored on the wolf so it doesn't spam; only when not already hunting it.)
    if (wolf.state !== 'hunt' && wolf.state !== 'attack') {
      const passive = this.findNearestHuntTarget(wolf.pos, SCARE_RADIUS);
      if (passive) passive.scare(wolf.pos.x, wolf.pos.z, 800);
    }
  }
}
