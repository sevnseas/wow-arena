import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { CharacterView, LocomotionState } from './character';

type AnimName = 'idle' | 'walk' | 'run' | 'run_stop' | 'turn_left' | 'turn_right';

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

// Animation file map
const ANIM_FILES: Record<AnimName, string> = {
  idle:       'idle.fbx',
  walk:       'walk.fbx',
  run:        'run.fbx',
  run_stop:   'run_stop.fbx',
  turn_left:  'turn_left.fbx',
  turn_right: 'turn_right.fbx',
};

export class MixamoCharacterView implements CharacterView {
  public readonly root: THREE.Group;

  private mixer: THREE.AnimationMixer;
  private clips: Map<AnimName, THREE.AnimationAction> = new Map();
  private current: THREE.AnimationAction | null = null;
  private currentName: AnimName | null = null;
  private readonly FADE = 0.2;

  private prevState: LocomotionState = 'idle';
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

    // Load character mesh + all anims in parallel
    const animEntries = Object.entries(ANIM_FILES) as [AnimName, string][];
    const [mesh, ...animFbxs] = await Promise.all([
      loadFbx(`${basePath}/${charFile}.fbx`),
      ...animEntries.map(([, file]) => loadFbx(`${basePath}/${file}`)),
    ]);

    // Mixamo FBX is in cm — scale to metres
    mesh.scale.setScalar(0.01);
    mesh.traverse((c: any) => {
      if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
    });

    const mixer = new THREE.AnimationMixer(mesh);
    const view = new MixamoCharacterView(mesh, mixer);

    animFbxs.forEach((fbx, i) => {
      const [name] = animEntries[i];
      const clip = fbx.animations[0];
      if (!clip) { console.warn(`No clip in ${ANIM_FILES[name]}`); return; }
      clip.name = name;
      // Strip "ArmatureName|" prefix Mixamo puts on separate-file animations
      clip.tracks.forEach(t => { t.name = t.name.replace(/^[^|]+\|/, ''); });
      // Remove root motion: zero out XZ translation on the hip/root bone so
      // the game's movement system owns position — keep Y for vertical bounce.
      removeRootMotionXZ(clip);
      const action = mixer.clipAction(clip);
      view.clips.set(name, action);
      console.log(`✓ ${name} (${clip.duration.toFixed(2)}s)`);
    });

    view.play('idle');
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

    if (state !== this.prevState) {
      // run → idle: play run_stop first, then idle
      if (wasMoving && this.prevState === 'run' && state === 'idle') {
        this.play('run_stop');
        // After run_stop duration, fall back to idle
        const stopClip = this.clips.get('run_stop');
        if (stopClip) {
          const dur = (stopClip as any)._clip?.duration ?? 0.5;
          setTimeout(() => { if (this.currentName === 'run_stop') this.play('idle'); }, dur * 1000);
        }
      } else if (isMoving) {
        this.play(speed01 > 0.55 ? 'run' : 'walk');
      } else {
        this.play('idle');
      }
      this.prevState = state;
    } else if (isMoving) {
      // Same movement state but speed changed — swap walk ↔ run smoothly
      const want: AnimName = speed01 > 0.55 ? 'run' : 'walk';
      if (want !== this.currentName) this.play(want);
    }
  }

  triggerOneShot(name: string) {
    const action = this.clips.get(name as AnimName);
    if (!action) return;
    action.loop = THREE.LoopOnce;
    action.clampWhenFinished = true;
    action.reset().play();
  }

  startCasting() { /* keep current anim */ }
  stopCasting()  { /* keep current anim */ }
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

  private play(name: AnimName) {
    const next = this.clips.get(name);
    if (!next || name === this.currentName) return;

    if (this.current) this.current.fadeOut(this.FADE);

    const looping = name !== 'run_stop' && name !== 'turn_left' && name !== 'turn_right';
    next.loop = looping ? THREE.LoopRepeat : THREE.LoopOnce;
    next.clampWhenFinished = !looping;
    next.reset().fadeIn(this.FADE).play();

    this.current = next;
    this.currentName = name;
  }
}
