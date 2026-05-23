/**
 * Verifies that the RL4 driver actually drives live entity movement (the bug
 * was that wolf/cat state machines were overriding the brain's target every
 * frame, so the policy's chosen direction never persisted long enough to
 * translate the entity). With `brainSteer`, applying a directional Action
 * must produce visible position deltas in the entity's actual world space.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { WolfPack } from '../wolves';
import { CatColony } from '../cats';
import { Action } from '../rl/types';

function makeScene() { return new THREE.Scene(); }

describe('RL4 live entity control', () => {
  it('wolf moves in chosen world-space direction when MoveForward applied', () => {
    const scene = makeScene();
    const pack = new WolfPack(scene, 1, 50, null, [], new THREE.Vector3(0, 0, 0));
    const agents = pack.getPolicy4Agents();
    expect(agents.length).toBe(1);
    const w = agents[0];
    const startZ = w.pos.z;

    // Apply MoveForward (positive Z) repeatedly across simulated frames.
    // 180 frames = 3s — enough for any starting yaw to rotate around and walk.
    for (let i = 0; i < 180; i++) {
      w.applyAction(Action.MoveForward, null);
      pack.update(1 / 60);
    }

    const dz = w.pos.z - startZ;
    expect(dz).toBeGreaterThan(0.5); // visible forward motion despite turn-up
  });

  it('wolf reverses direction when StrafeLeft replaces MoveForward', () => {
    const scene = makeScene();
    const pack = new WolfPack(scene, 1, 50, null, [], new THREE.Vector3(0, 0, 0));
    const w = pack.getPolicy4Agents()[0];

    for (let i = 0; i < 180; i++) {
      w.applyAction(Action.MoveForward, null);
      pack.update(1 / 60);
    }
    const midX = w.pos.x;
    for (let i = 0; i < 180; i++) {
      w.applyAction(Action.StrafeLeft, null);
      pack.update(1 / 60);
    }
    // After strafing left we expect a clear net -X displacement vs mid-point.
    expect(w.pos.x - midX).toBeLessThan(-0.5);
  });

  it('cat moves under brain control too', () => {
    const scene = makeScene();
    const colony = new CatColony(scene, 1, 30, null);
    const cats = colony.getPolicy4Agents();
    expect(cats.length).toBeGreaterThan(0);
    const c = cats[0];
    const start = { x: c.pos.x, z: c.pos.z };

    // Cat turns slowly (TURN_RATE), so allow several seconds of frames so it
    // can rotate to face the target then translate.
    for (let i = 0; i < 240; i++) {
      c.applyAction(Action.MoveForward, null);
      colony.update(1 / 60);
    }
    const dz = c.pos.z - start.z;
    // MoveForward = +Z; expect non-trivial positive drift.
    expect(dz).toBeGreaterThan(0.5);
  });
});
