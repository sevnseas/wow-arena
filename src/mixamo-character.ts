import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { CharacterView, LocomotionState } from './character';

type AnimName =
  | 'idle' | 'walk' | 'run' | 'run_stop' | 'turn_left' | 'turn_right'
  | 'jump' | 'cast_spell' | 'cast_heal';

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
};
const MARIA_OPTIONAL: Partial<AnimFiles> = {
  jump:       'jump_mutant.fbx',   // ~20 MB cross-rig
  cast_spell: 'cast_spell.fbx',   // ~20 MB cross-rig
  cast_heal:  'cast_heal.fbx',    // ~20 MB cross-rig
};

const MUTANT_ESSENTIAL: Partial<AnimFiles> = {
  idle:       'mutant_breathing_idle.fbx',
  walk:       'mutant_walking.fbx',
  run:        'mutant_run.fbx',
  run_stop:   'mutant_run.fbx',
  turn_left:  'mutant_left_turn_45.fbx',
  turn_right: 'mutant_right_turn_45.fbx',
};
const MUTANT_OPTIONAL: Partial<AnimFiles> = {
  jump:       'mutant_jumping.fbx',
  cast_spell: 'mutant_swiping.fbx',
  cast_heal:  'mutant_flexing_muscles.fbx',
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

    if (state !== this.prevState) {
      if (state === 'jump') {
        this.oneShot('jump', this.groundState as AnimName);
      } else if (wasMoving && this.prevState === 'run' && state === 'idle') {
        // run → idle: run_stop then idle
        this.oneShot('run_stop', 'idle');
      } else if (isMoving) {
        this.play(speed01 > 0.55 ? 'run' : 'walk');
      } else {
        this.play('idle');
      }
      this.prevState = state;
    } else if (isMoving) {
      const want: AnimName = speed01 > 0.55 ? 'run' : 'walk';
      if (want !== this.currentName) this.play(want);
    }
  }

  triggerOneShot(name: string) {
    // Map game ability names → animation names
    const ANIM_MAP: Record<string, AnimName> = {
      attack:           'cast_spell',
      cast_spell:       'cast_spell',
      cast_heal:        'cast_heal',
      rogue_shadowstep: 'cast_spell',
      rogue_blind:      'cast_spell',
    };
    const animName = ANIM_MAP[name] ?? (name as AnimName);
    this.oneShot(animName, this.groundState as AnimName);
  }

  startCasting() { this.play('cast_spell'); }
  stopCasting()  { this.play(this.groundState as AnimName); }
  setDebuffed(debuffed: boolean) { this.mixer.timeScale = debuffed ? 0.5 : 1; }

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
    'run_stop', 'turn_left', 'turn_right', 'jump', 'cast_spell', 'cast_heal',
  ]);

  private play(name: AnimName) {
    const next = this.clips.get(name);
    if (!next || name === this.currentName) return;

    if (this.current) this.current.fadeOut(this.FADE);

    const looping = !this.ONE_SHOTS.has(name);
    next.loop = looping ? THREE.LoopRepeat : THREE.LoopOnce;
    next.clampWhenFinished = !looping;
    next.reset().fadeIn(this.FADE).play();

    this.current = next;
    this.currentName = name;
  }

  // Play a one-shot then return to `returnTo` when finished
  private oneShot(name: AnimName, returnTo: AnimName) {
    const clip = this.clips.get(name);
    if (!clip) { this.play(returnTo); return; }

    this.play(name);
    const dur = (clip as any)._clip?.duration ?? 1;
    setTimeout(() => { if (this.currentName === name) this.play(returnTo); }, dur * 1000);
  }
}
