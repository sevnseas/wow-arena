import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { CharacterView, LocomotionState } from './character';

type AnimName =
  | 'idle' | 'walk' | 'run' | 'run_stop' | 'turn_left' | 'turn_right'
  | 'jump' | 'cast_spell' | 'cast_heal' | 'swipe';

/**
 * Strip XZ root translation from a clip so the character stays in place
 * while the game's physics drives world position. Keeps Y (vertical bounce).
 *
 * Mixamo bakes locomotion into the hip bone position track. Each frame the
 * hips translate forward by (clipLength / frameCount) — visually the mesh
 * slides forward instead of running in-place. We zero the X and Z values
 * on that track so only the Y bounce remains.
 */
function removeRootMotionXZ(clip: THREE.AnimationClip): void {
  clip.tracks.forEach(track => {
    // Match the root/hip bone position track — Mixamo names it "mixamorigHips.position"
    // but after prefix-stripping it might just be "Hips.position"
    const isHipPos = track.name.toLowerCase().includes('hips') &&
                     track.name.endsWith('.position');
    if (!isHipPos) return;

    const values = (track as THREE.VectorKeyframeTrack).values;
    // VectorKeyframeTrack for position stores [x,y,z, x,y,z, ...] per keyframe
    for (let i = 0; i < values.length; i += 3) {
      values[i]     = 0; // X → zero
      // values[i+1] = Y — keep (vertical hip bounce)
      values[i + 2] = 0; // Z → zero
    }
  });
}

// All Mixamo rigs share the same mixamorigXxx bone names, so animations are
// interchangeable. Each character can have a preferred native set.
//
// Split into ESSENTIAL (small, load-blocking) and OPTIONAL (large, lazy).
// The character is playable as soon as essentials finish; optional clips
// register themselves into the mixer when they arrive in the background.
type AnimFiles = Record<AnimName, string>;

const MARIA_ESSENTIAL: Partial<AnimFiles> = {
  idle:       'idle.fbx',
  walk:       'walk.fbx',
  run:        'run.fbx',
  run_stop:   'run_stop.fbx',
  turn_left:  'turn_left.fbx',
  turn_right: 'turn_right.fbx',
  jump:       'jump_mutant.fbx',   // Cross-rig, essential for gameplay
};
const MARIA_OPTIONAL: Partial<AnimFiles> = {
  cast_spell: 'cast_spell.fbx',     // ~20 MB cross-rig
  cast_heal:  'cast_heal.fbx',      // ~20 MB cross-rig
  swipe:      'mutant_swiping.fbx', // ~310 KB cross-rig — used for melee/blink
};

const MUTANT_ESSENTIAL: Partial<AnimFiles> = {
  idle:       'mutant_breathing_idle.fbx',
  walk:       'mutant_walking.fbx',
  run:        'mutant_run.fbx',
  run_stop:   'mutant_run.fbx',
  turn_left:  'mutant_left_turn_45.fbx',
  turn_right: 'mutant_right_turn_45.fbx',
  jump:       'mutant_jumping.fbx',
};
const MUTANT_OPTIONAL: Partial<AnimFiles> = {
  cast_spell: 'mutant_swiping.fbx',
  cast_heal:  'mutant_flexing_muscles.fbx',
  swipe:      'mutant_swiping.fbx',
};

export class MixamoCharacterView implements CharacterView {
  public readonly root: THREE.Group;

  private mixer: THREE.AnimationMixer;
  private clips: Map<AnimName, THREE.AnimationAction> = new Map();
  private current: THREE.AnimationAction | null = null;
  private currentName: AnimName | null = null;
  private readonly FADE = 0.2;

  private prevState: LocomotionState = 'idle';
  private groundState: LocomotionState = 'idle'; // Last grounded state (walk/run/idle) for jump/fall recovery
  private targetYaw = 0;
  private currentYaw = 0;
  private prevYaw = 0;
  private yawVel = 0; // radians/s — used for turn-in-place detection

  // Jump animation phasing: physics drives the clip cursor through
  // takeoff/airborne (0..AIR_END) while flying; the landing tail
  // (AIR_END..1) plays at normal speed once we hit the ground.
  private static readonly JUMP_AIR_END = 0.7;
  private jumpLandTimer: number | null = null;

  // True between startCasting() and stopCasting() so per-frame startCasting
  // calls during a channel don't keep resetting the clip to frame 0 (T-pose).
  private isCastingActive = false;

  private constructor(root: THREE.Group, mixer: THREE.AnimationMixer) {
    this.root = root;
    this.mixer = mixer;
  }

  static async load(basePath = 'models', charFile = 'character'): Promise<MixamoCharacterView> {
    const loader = new FBXLoader();
    const loadFbx = (url: string): Promise<THREE.Group> =>
      new Promise((res, rej) => loader.load(url, res, undefined, rej));

    const isMutant = charFile === 'mutant';
    const essential = isMutant ? MUTANT_ESSENTIAL : MARIA_ESSENTIAL;
    const optional  = isMutant ? MUTANT_OPTIONAL  : MARIA_OPTIONAL;

    // 1. Mesh + essential anims load in parallel — character is playable after this
    const essentialEntries = Object.entries(essential) as [AnimName, string][];
    const [mesh, ...essentialFbxs] = await Promise.all([
      loadFbx(`${basePath}/${charFile}.fbx`),
      ...essentialEntries.map(([, f]) => loadFbx(`${basePath}/${f}`)),
    ]);

    mesh.scale.setScalar(0.01);
    mesh.traverse((c: any) => {
      if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
    });

    const mixer = new THREE.AnimationMixer(mesh);
    const view  = new MixamoCharacterView(mesh, mixer);

    const registerClip = (name: AnimName, fbx: THREE.Group) => {
      const clip = fbx.animations[0];
      if (!clip) { console.warn(`No clip in ${name}`); return; }
      clip.name = name;
      clip.tracks.forEach(t => { t.name = t.name.replace(/^[^|]+\|/, ''); });
      removeRootMotionXZ(clip);
      view.clips.set(name, mixer.clipAction(clip));
      console.log(`✓ ${name} (${clip.duration.toFixed(2)}s)`);
    };

    essentialFbxs.forEach((fbx, i) => registerClip(essentialEntries[i][0], fbx));
    view.play('idle');

    // 2. Optional (large) anims load in the background — available whenever ready
    const optionalEntries = Object.entries(optional) as [AnimName, string][];
    Promise.allSettled(optionalEntries.map(([, f]) => loadFbx(`${basePath}/${f}`))).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') registerClip(optionalEntries[i][0], r.value);
        else console.warn(`⚠ Optional anim failed: ${optionalEntries[i][0]}`);
      });
    });

    return view;
  }

  // ── Interface ─────────────────────────────────────────────────────────────

  setFacingYaw(yaw: number) {
    // Game yaw is CW (atan2(-x,-z)); Three.js rotation.y is CCW.
    // Mixamo also faces +Z at rest, game forward is -Z → +π offset.
    this.targetYaw = -yaw + Math.PI;
  }

  setLocomotion(state: LocomotionState, speed01: number) {
    const wasMoving = this.prevState === 'walk' || this.prevState === 'run';
    const isMoving  = state === 'walk' || state === 'run';

    // Track the last grounded state for jump/fall recovery
    if (state === 'walk' || state === 'run' || state === 'idle') {
      this.groundState = state;
    }

    const wasAirborne = this.prevState === 'jump' || this.prevState === 'fall';
    const isAirborne  = state === 'jump' || state === 'fall';

    if (state !== this.prevState) {
      if (isAirborne && !wasAirborne) {
        // Takeoff: start jump clip but pause it — setAirborne() scrubs the cursor.
        this.startAirborne();
      } else if (!isAirborne && wasAirborne) {
        // Landing: let the landing tail of the jump clip play out, then resume.
        this.finishLanding();
      } else if (wasMoving && this.prevState === 'run' && state === 'idle') {
        // run → idle: run_stop then idle
        this.oneShot('run_stop', 'idle');
      } else if (isMoving) {
        this.play(speed01 > 0.55 ? 'run' : 'walk');
      } else if (!isAirborne) {
        this.play('idle');
      }
      this.prevState = state;
    } else if (isMoving) {
      // Only update movement animation while grounded (jump/fall states have isMoving=false)
      const want: AnimName = speed01 > 0.55 ? 'run' : 'walk';
      if (want !== this.currentName) this.play(want);
    }
  }

  triggerOneShot(name: string) {
    // Map game ability names → animation clips. Per-ability target durations
    // shape how the swing reads: longer for a deliberate hit, snappier for
    // a dash/teleport. Falls back to cast_spell at 0.6s for unmapped abilities.
    const ABILITY: Record<string, { anim: AnimName; dur: number }> = {
      attack:           { anim: 'cast_spell', dur: 0.6 },
      cast_spell:       { anim: 'cast_spell', dur: 0.6 },
      cast_heal:        { anim: 'cast_heal',  dur: 0.6 },
      rogue_hemorrhage: { anim: 'swipe',      dur: 0.45 },  // melee strike
      rogue_shadowstep: { anim: 'swipe',      dur: 0.3 },   // dash
      rogue_blind:      { anim: 'cast_spell', dur: 0.5 },   // throw gesture
      mage_blink:       { anim: 'swipe',      dur: 0.25 },  // quick dodge
      priest_fear:      { anim: 'cast_spell', dur: 0.5 },
      priest_heal:      { anim: 'cast_heal',  dur: 0.6 },
    };
    const { anim, dur } = ABILITY[name] ?? { anim: 'cast_spell' as AnimName, dur: 0.6 };
    this.oneShot(anim, this.groundState as AnimName, dur);
  }

  startCasting(castTime?: number) {
    // Called every frame while channeling — only restart the clip on the
    // leading edge, otherwise we'd reset action.time to 0 each frame and
    // the character would T-pose at the first keyframe.
    if (this.isCastingActive && this.currentName === 'cast_spell') return;
    this.isCastingActive = true;
    this.replay('cast_spell');
    const action = this.clips.get('cast_spell');
    if (action && castTime && castTime > 0) {
      const dur = (action as any)._clip?.duration as number | undefined;
      if (dur && dur > 0) action.timeScale = dur / castTime;
    }
  }
  stopCasting() {
    // Called every frame while NOT casting — only act on the trailing edge
    // of an actual cast, otherwise we'd fight every other animation.
    if (!this.isCastingActive) return;
    this.isCastingActive = false;
    // Cast/heal clamps at its last frame on completion; explicitly return
    // to a ground state so the character doesn't freeze in the cast pose.
    if (this.currentName === 'cast_spell' || this.currentName === 'cast_heal') {
      this.play(this.groundState as AnimName);
    }
  }
  setDebuffed(debuffed: boolean) { this.mixer.timeScale = debuffed ? 0.5 : 1; }

  setAirborne(velY: number, jumpForce: number) {
    const action = this.clips.get('jump');
    if (!action || this.currentName !== 'jump') return;
    const dur = (action as any)._clip?.duration as number | undefined;
    if (!dur) return;
    // velY: +jumpForce at takeoff → 0 at apex → -jumpForce at landing.
    // Map to t ∈ [0, 1] across the airborne portion of the clip.
    const t = THREE.MathUtils.clamp((jumpForce - velY) / (2 * jumpForce), 0, 1);
    action.time = t * MixamoCharacterView.JUMP_AIR_END * dur;
  }

  update(dt: number) {
    this.mixer.update(dt);

    // Smooth yaw with spring-ish damping
    const diff = this.targetYaw - this.currentYaw;
    const shortDiff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.currentYaw += shortDiff * Math.min(1, dt * 12);
    this.yawVel = (this.currentYaw - this.prevYaw) / dt;
    this.prevYaw = this.currentYaw;
    this.root.rotation.y = this.currentYaw;

    // Turn-in-place when idle and rotating quickly
    if (this.prevState === 'idle' && this.currentName === 'idle') {
      if (this.yawVel > 1.5)       this.play('turn_left');
      else if (this.yawVel < -1.5) this.play('turn_right');
    }
    // Return to idle after turn completes (turns aren't looped)
    if ((this.currentName === 'turn_left' || this.currentName === 'turn_right')
        && Math.abs(this.yawVel) < 0.3) {
      this.play('idle');
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.traverse((c: any) => {
      c.geometry?.dispose();
      if (Array.isArray(c.material)) c.material.forEach((m: any) => m.dispose());
      else c.material?.dispose();
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private readonly ONE_SHOTS: ReadonlySet<AnimName> = new Set([
    'run_stop', 'turn_left', 'turn_right', 'jump', 'cast_spell', 'cast_heal', 'swipe',
  ]);

  private play(name: AnimName) {
    if (name === this.currentName) return;
    this.startClip(name);
  }

  // Play even if the requested clip is already current — needed for one-shots
  // that may be re-triggered (back-to-back casts, repeated swings) after the
  // previous play completed and clamped at the final frame.
  private replay(name: AnimName) {
    this.startClip(name);
  }

  private startClip(name: AnimName) {
    const next = this.clips.get(name);
    if (!next) return;

    // Any clip change invalidates a pending landing timer — otherwise it
    // can fire later and snap us back to a stale state (e.g. user
    // lands→runs→stops, then the orphaned timer plays 'idle' on top of
    // run_stop; or jumps again mid-landing and the old timer wins).
    if (this.jumpLandTimer !== null) {
      clearTimeout(this.jumpLandTimer);
      this.jumpLandTimer = null;
    }

    if (this.current && this.current !== next) this.current.fadeOut(this.FADE);

    const looping = !this.ONE_SHOTS.has(name);
    next.loop = looping ? THREE.LoopRepeat : THREE.LoopOnce;
    next.clampWhenFinished = !looping;
    next.timeScale = 1;
    next.paused = false;
    next.reset().fadeIn(this.FADE).play();

    this.current = next;
    this.currentName = name;
  }

  // Play a one-shot then return to `returnTo` when finished. If `targetDur`
  // is given, the clip is time-scaled to last roughly that long.
  private oneShot(name: AnimName, returnTo: AnimName, targetDur?: number) {
    const clip = this.clips.get(name);
    if (!clip) {
      this.play(returnTo);
      return;
    }

    this.replay(name);
    const action = this.clips.get(name)!;
    const clipDur = (action as any)._clip?.duration as number | undefined;
    if (targetDur && clipDur && clipDur > 0) {
      action.timeScale = clipDur / targetDur;
    }
    const dur = (clipDur ?? 1) / (action.timeScale || 1);
    setTimeout(() => { if (this.currentName === name) this.play(returnTo); }, dur * 1000);
  }

  // ── Jump phasing ──────────────────────────────────────────────────────────
  //
  // Mixamo's jumping clip is a single ~2.4s mocap covering crouch → push →
  // hang → land. Our jump physics (JUMP_FORCE=8, GRAVITY=20) gives ~0.8s of
  // airtime, and the time spent at any vertical velocity is determined by
  // physics, not the artist. We split the clip into two regions:
  //   [0, AIR_END]  — takeoff + airborne, scrubbed by setAirborne()
  //   [AIR_END, 1]  — landing tail, played at native speed on touchdown
  // This keeps the takeoff anticipation, the apex hang, and the landing
  // squash all aligned with what the physics is actually doing.

  private startAirborne() {
    const action = this.clips.get('jump');
    if (!action) {
      this.play(this.groundState as AnimName);
      return;
    }
    // replay() force-restarts jump even if currentName was already 'jump'
    // (e.g. landing tail still playing from a previous jump) and clears
    // any in-flight landing timer via startClip().
    this.replay('jump');
    action.paused = true;          // freeze the mixer; setAirborne() drives time
    action.time = 0;
  }

  private finishLanding() {
    const action = this.clips.get('jump');
    if (!action) {
      this.play(this.groundState as AnimName);
      return;
    }
    const dur = (action as any)._clip?.duration as number | undefined;
    if (!dur) {
      this.play(this.groundState as AnimName);
      return;
    }
    action.paused = false;
    const remaining = Math.max(0, dur - action.time);
    if (this.jumpLandTimer !== null) clearTimeout(this.jumpLandTimer);
    this.jumpLandTimer = window.setTimeout(() => {
      this.jumpLandTimer = null;
      if (this.currentName === 'jump') this.play(this.groundState as AnimName);
    }, remaining * 1000);
  }
}
