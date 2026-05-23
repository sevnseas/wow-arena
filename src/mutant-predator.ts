import * as THREE from 'three';
import type { Collider } from './arena';
import type { EntityRefLike } from './game-entity';
import { MixamoCharacterView } from './mixamo-character';
import { resolveAnimalPhysics } from './animal-physics';
import {
  combatContactRange,
  emitDamageSplat,
  emitHealSplat,
  healPreyState,
  maintainCombatSpacing,
  makePreyState,
  notePreyAttacker,
  type CombatTargetRef,
  type PreyProvider,
  type PreyRef,
  type PreyState,
} from './prey';
import { Intent, INTENT_COUNT, type PolicyAgentRef } from './rl';

const MUTANT_RADIUS = 0.75;
const WALK_SPEED = 2.2;
const HUNT_SPEED = 4.6;
const TURN_RATE = 3.6;
const SCENT_RADIUS = 22;
const ATTACK_DAMAGE = 14;
const ATTACK_COOLDOWN = 1.7;
const PROWL_RADIUS = 7;
/** Player gets close → instant aggro. */
const PLAYER_AGGRO_RADIUS = 7;
/** After being damaged, hold aggro for this many seconds even at range. */
const PLAYER_HIT_AGGRO_LINGER = 12;
/** Lose interest if player gets this far. */
const PLAYER_DEAGGRO_RADIUS = 30;

type MutantState = 'prowl' | 'hunt' | 'attack';

export class MutantPredator implements PreyProvider {
  private view: MixamoCharacterView;
  private scene: THREE.Scene;
  private bounds: number;
  private heightData: Uint8Array | null;
  private preyProviders: PreyProvider[];
  private colliders: Collider[] = [];
  private preyState: PreyState = makePreyState(180);
  private pos: THREE.Vector3;
  private yaw = 0;
  private target: THREE.Vector3;
  private prey: CombatTargetRef | null = null;
  private state: MutantState = 'prowl';
  private attackTimer = 0;
  private id = 'mutant-werewolf';
  private name = 'Werewolf';

  private constructor(
    scene: THREE.Scene,
    view: MixamoCharacterView,
    bounds: number,
    heightData: Uint8Array | null,
    preyProviders: PreyProvider[],
    startPos: THREE.Vector3,
  ) {
    this.scene = scene;
    this.view = view;
    this.bounds = bounds;
    this.heightData = heightData;
    this.preyProviders = preyProviders;
    this.pos = startPos.clone();
    this.target = this.pickProwlTarget();
    this.view.root.name = 'MutantWerewolf';
    this.view.root.position.copy(this.pos);
    this.view.root.scale.multiplyScalar(1.08);
    this.view.root.userData.policyAgentId = this.id;
    this.view.root.userData.policyArchetype = 'werewolf';
    this.scene.add(this.view.root);
  }

  static async create(
    scene: THREE.Scene,
    bounds: number,
    heightData: Uint8Array | null,
    preyProviders: PreyProvider[],
    startPos = new THREE.Vector3(14, 0, -14),
  ): Promise<MutantPredator> {
    const view = await MixamoCharacterView.load('models', 'mutant');
    return new MutantPredator(scene, view, bounds, heightData, preyProviders, startPos);
  }

  setColliders(colliders: Collider[]): void {
    this.colliders = colliders;
  }

  private playerProvider: (() => CombatTargetRef | null) | null = null;
  /** Wire the boss to a live player reference so it can aggro on proximity
   *  AND so attack-aggro retention works through the brain layer. */
  setPlayerProvider(fn: () => CombatTargetRef | null): void {
    this.playerProvider = fn;
  }

  private getPlayerRef(): CombatTargetRef | null {
    return this.playerProvider?.() ?? null;
  }

  /**
   * Brain-driven adapter for the werewolf boss. The trained policy chooses
   * Attack to lock onto a focus, Idle to drop combat (rare), or Flee to
   * retreat when overwhelmed — the existing prowl/hunt/attack state machine
   * still executes the actual movement and bite timing.
   */
  getPolicyAgents(): PolicyAgentRef[] {
    if (this.preyState.dead) return [];
    const self = this;
    return [{
      id: this.id,
      team: 'predator',
      archetype: 'werewolf',
      size: MUTANT_RADIUS,
      personalityBias: this.personalityBias,
      temperature: this.temperature,
      get alive() { return !self.preyState.dead; },
      get hp() { return self.preyState.hp; },
      get maxHp() { return self.preyState.maxHp; },
      get status() { return 0 as 0 | 1 | 2; },
      get pos() { return { x: self.pos.x, z: self.pos.z }; },
      get attackerId() { return self.preyState.lastAttackerId; },
      applyIntent(intent, focus, _ctx) {
        if (self.preyState.dead) return;
        // Boss is locked on the player — ignore brain re-targets. The brain
        // doesn't observe the player so it would just point us back at a
        // rabbit, which would be silly when there's a human shooting at us.
        if (self.playerLocked) return;
        if (intent === Intent.Attack && focus) {
          const ref = self.resolveTargetByPos(focus.id, focus.pos.x, focus.pos.z);
          if (ref) {
            self.prey = ref;
            self.state = 'hunt';
          }
        } else if (intent === Intent.Flee && focus) {
          // Werewolf rarely flees — but if the brain decides to, override the
          // target to a point away from the focus and switch back to prowl.
          self.target.set(
            self.pos.x - (focus.pos.x - self.pos.x),
            0,
            self.pos.z - (focus.pos.z - self.pos.z),
          );
          self.state = 'prowl';
          self.prey = null;
        } else if (intent === Intent.Idle) {
          self.prey = null;
          self.state = 'prowl';
        }
      },
    }];
  }

  /** Set by update() when the player is in aggro range; prevents the brain
   *  from re-pointing prey at some other entity while the boss is locked on
   *  the player. */
  private playerLocked = false;

  private personalityBias: Float32Array = (() => {
    const b = new Float32Array(INTENT_COUNT);
    b[Intent.Attack] = 0.9;  // boss is almost always aggressive
    return b;
  })();
  private temperature = 0.5;

  private resolveTargetByPos(id: string, x: number, z: number): CombatTargetRef | null {
    for (const prov of this.preyProviders) {
      let found: CombatTargetRef | null = null;
      prov.forEachPrey(ref => {
        if (found || !ref.alive) return;
        if (ref.id === id) { found = ref; return; }
        if (Math.hypot(ref.pos.x - x, ref.pos.z - z) < 0.6) found = ref;
      });
      if (found) return found;
    }
    return null;
  }

  update(delta: number): void {
    if (this.preyState.dead) {
      this.view.setLocomotion('idle', 0);
      this.view.update(delta);
      return;
    }

    this.attackTimer = Math.max(0, this.attackTimer - delta);
    if (!this.prey?.alive) this.prey = null;

    // Player aggro: proximity OR recent damage. Locks the boss onto the
    // player until they die or escape past PLAYER_DEAGGRO_RADIUS. This
    // overrides whatever the brain picked — a boss never ignores a hostile
    // human standing in its face.
    const player = this.getPlayerRef();
    if (player?.alive) {
      const dx = player.pos.x - this.pos.x;
      const dz = player.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      const hitByPlayerRecently =
        this.preyState.lastAttackerId === player.id &&
        (performance.now() - this.preyState.lastHitAt) < PLAYER_HIT_AGGRO_LINGER * 1000;
      const playerIsCurrentPrey = this.prey?.id === player.id;
      const tooClose = dist < PLAYER_AGGRO_RADIUS;
      const stillEngaged = playerIsCurrentPrey && dist < PLAYER_DEAGGRO_RADIUS;
      if (tooClose || hitByPlayerRecently || stillEngaged) {
        this.prey = player;
        this.state = 'hunt';
        this.playerLocked = dist < PLAYER_DEAGGRO_RADIUS;
      } else if (playerIsCurrentPrey && dist >= PLAYER_DEAGGRO_RADIUS) {
        // Escaped — drop aggro and let the brain pick again next decision.
        this.prey = null;
        this.playerLocked = false;
      }
    }

    if (!this.prey) {
      this.prey = this.findNearestHuntTarget(this.pos, SCENT_RADIUS);
      if (this.prey) this.state = 'hunt';
    }

    let moveSpeed = WALK_SPEED;
    let moving = true;
    let tx = this.target.x;
    let tz = this.target.z;

    if (this.prey) {
      tx = this.prey.pos.x;
      tz = this.prey.pos.z;
      const attackRange = combatContactRange(MUTANT_RADIUS, this.prey, 0.25);
      const d2 = this.distSqTo(this.prey.pos);
      if (d2 <= attackRange * attackRange) {
        this.state = 'attack';
        moving = false;
        maintainCombatSpacing(this.pos, this.prey, attackRange);
        if (this.attackTimer <= 0) {
          this.view.triggerUpperBodyAttack?.(0.6);
          this.prey.damage(ATTACK_DAMAGE, this.makePreyRef());
          this.attackTimer = ATTACK_COOLDOWN;
        }
      } else {
        this.state = 'hunt';
        moveSpeed = HUNT_SPEED;
      }
    } else {
      this.state = 'prowl';
      if (this.distSqTo(this.target) < 1.2 * 1.2) this.target.copy(this.pickProwlTarget());
    }

    this.steerToward(tx, tz, delta);
    if (moving) {
      this.pos.x += Math.sin(this.yaw) * moveSpeed * delta;
      this.pos.z += Math.cos(this.yaw) * moveSpeed * delta;
    }

    const y = resolveAnimalPhysics(this.pos, {
      radius: MUTANT_RADIUS,
      bounds: this.bounds,
      heightData: this.heightData,
      colliders: this.colliders,
    });
    this.view.root.position.set(this.pos.x, y, this.pos.z);
    this.view.setFacingYaw(Math.PI - this.yaw);
    this.view.setLocomotion(moving ? (this.state === 'hunt' ? 'run' : 'walk') : 'idle', moving ? 1 : 0);
    this.view.update(delta);
  }

  findNearestPrey(pos: THREE.Vector3, maxDist: number): PreyRef | null {
    if (this.preyState.dead) return null;
    return this.pos.distanceToSquared(pos) <= maxDist * maxDist ? this.makePreyRef() : null;
  }

  forEachPrey(fn: (ref: PreyRef) => void): void {
    if (!this.preyState.dead) fn(this.makePreyRef());
  }

  dispose(): void {
    this.scene.remove(this.view.root);
    this.view.dispose();
  }

  private findNearestHuntTarget(pos: THREE.Vector3, maxDist: number): PreyRef | null {
    let best: PreyRef | null = null;
    let bestSq = maxDist * maxDist;
    for (const provider of this.preyProviders) {
      const candidate = provider.findNearestPrey(pos, maxDist);
      if (!candidate || candidate.id === this.id) continue;
      const d = candidate.pos.distanceToSquared(pos);
      if (d < bestSq) {
        bestSq = d;
        best = candidate;
      }
    }
    return best;
  }

  private makePreyRef(): PreyRef {
    const thisRef = this;
    return {
      id: this.id,
      name: this.name,
      team: 'enemy',
      mesh: this.view.root,
      get pos() { return thisRef.pos; },
      get alive() { return !thisRef.preyState.dead; },
      get hp() { return thisRef.preyState.hp; },
      get maxHp() { return thisRef.preyState.maxHp; },
      get radius() { return MUTANT_RADIUS; },
      damage: (amount: number, attacker?: EntityRefLike) => {
        if (this.preyState.dead) return false;
        this.preyState.hp = Math.max(0, this.preyState.hp - amount);
        this.preyState.lastHitAt = performance.now();
        notePreyAttacker(this.preyState, attacker);
        emitDamageSplat(this.view.root, amount);
        if (attacker?.alive) {
          // Hard-aggro the attacker — applies whether it's the player or
          // another animal. Player aggro is additionally protected against
          // brain re-targeting in applyIntent via `playerLocked`.
          this.prey = attacker;
          this.state = 'hunt';
        }
        if (this.preyState.hp <= 0) {
          this.preyState.dead = true;
          this.prey = null;
          this.view.root.visible = false;
          return true;
        }
        return false;
      },
      heal: (amount: number) => {
        const healed = healPreyState(this.preyState, amount);
        if (healed > 0) {
          this.view.root.visible = true;
          emitHealSplat(this.view.root, healed);
        }
        return healed;
      },
      scare: () => {},
    };
  }

  private pickProwlTarget(): THREE.Vector3 {
    const center = new THREE.Vector3(14, 0, -14);
    const a = Math.random() * Math.PI * 2;
    const r = PROWL_RADIUS * Math.sqrt(Math.random());
    return new THREE.Vector3(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
  }

  private steerToward(x: number, z: number, delta: number): void {
    const desiredYaw = Math.atan2(x - this.pos.x, z - this.pos.z);
    let yawDiff = desiredYaw - this.yaw;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    this.yaw += Math.max(-TURN_RATE * delta, Math.min(TURN_RATE * delta, yawDiff));
  }

  private distSqTo(p: THREE.Vector3): number {
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    return dx * dx + dz * dz;
  }
}
