/**
 * Generate a test character GLB file with animations
 * This simulates a Mixamo-exported character for testing purposes
 *
 * Usage: node generate-test-character.mjs
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import fs from 'fs';
import path from 'path';

// Create scene and character
const scene = new THREE.Scene();

// Create a simple humanoid character hierarchy
const root = new THREE.Group();
root.name = 'Armature';

const hips = new THREE.Group();
hips.name = 'Hips';
hips.position.set(0, 1, 0);

const spine = new THREE.Group();
spine.name = 'Spine';
spine.position.set(0, 0.2, 0);

const chest = new THREE.Group();
chest.name = 'Chest';
chest.position.set(0, 0.15, 0);

const neck = new THREE.Group();
neck.name = 'Neck';
neck.position.set(0, 0.2, 0);

const head = new THREE.Group();
head.name = 'Head';
head.position.set(0, 0.15, 0);

const leftShoulder = new THREE.Group();
leftShoulder.name = 'LeftShoulder';
leftShoulder.position.set(-0.3, 0.1, 0);

const leftArm = new THREE.Group();
leftArm.name = 'LeftArm';
leftArm.position.set(0, -0.25, 0);

const leftForeArm = new THREE.Group();
leftForeArm.name = 'LeftForeArm';
leftForeArm.position.set(0, -0.2, 0);

const leftHand = new THREE.Group();
leftHand.name = 'LeftHand';
leftHand.position.set(0, -0.15, 0);

const rightShoulder = new THREE.Group();
rightShoulder.name = 'RightShoulder';
rightShoulder.position.set(0.3, 0.1, 0);

const rightArm = new THREE.Group();
rightArm.name = 'RightArm';
rightArm.position.set(0, -0.25, 0);

const rightForeArm = new THREE.Group();
rightForeArm.name = 'RightForeArm';
rightForeArm.position.set(0, -0.2, 0);

const rightHand = new THREE.Group();
rightHand.name = 'RightHand';
rightHand.position.set(0, -0.15, 0);

const leftUpLeg = new THREE.Group();
leftUpLeg.name = 'LeftUpLeg';
leftUpLeg.position.set(-0.1, -0.1, 0);

const leftLeg = new THREE.Group();
leftLeg.name = 'LeftLeg';
leftLeg.position.set(0, -0.3, 0);

const leftFoot = new THREE.Group();
leftFoot.name = 'LeftFoot';
leftFoot.position.set(0, -0.3, 0);

const rightUpLeg = new THREE.Group();
rightUpLeg.name = 'RightUpLeg';
rightUpLeg.position.set(0.1, -0.1, 0);

const rightLeg = new THREE.Group();
rightLeg.name = 'RightLeg';
rightLeg.position.set(0, -0.3, 0);

const rightFoot = new THREE.Group();
rightFoot.name = 'RightFoot';
rightFoot.position.set(0, -0.3, 0);

// Build hierarchy
root.add(hips);
hips.add(spine);
spine.add(chest);
chest.add(neck);
neck.add(head);
chest.add(leftShoulder);
leftShoulder.add(leftArm);
leftArm.add(leftForeArm);
leftForeArm.add(leftHand);
chest.add(rightShoulder);
rightShoulder.add(rightArm);
rightArm.add(rightForeArm);
rightForeArm.add(rightHand);
hips.add(leftUpLeg);
leftUpLeg.add(leftLeg);
leftLeg.add(leftFoot);
hips.add(rightUpLeg);
rightUpLeg.add(rightLeg);
rightLeg.add(rightFoot);

// Create mesh geometry
const geometry = new THREE.BoxGeometry(0.2, 0.3, 0.15);
const material = new THREE.MeshStandardMaterial({ color: 0x8866ff });

function addMeshToBone(group) {
  const mesh = new THREE.Mesh(geometry, material.clone());
  mesh.scale.setScalar(0.5);
  group.add(mesh);
}

// Add meshes to bones
[hips, spine, chest, neck, head, leftArm, leftForeArm, leftHand, rightArm, rightForeArm, rightHand, leftUpLeg, leftLeg, leftFoot, rightUpLeg, rightLeg, rightFoot].forEach(
  addMeshToBone
);

scene.add(root);

// Create animations
const tracks = [];

// Idle animation (minimal movement)
const idleDuration = 2;
tracks.push(
  new THREE.VectorKeyframeTrack(
    `${root.name}.position`,
    [0, idleDuration],
    [0, 0, 0, 0, 0, 0]
  )
);

// Walk animation
const walkDuration = 1;
const walkTracks = [
  new THREE.VectorKeyframeTrack(
    `${leftUpLeg.name}.rotation`,
    [0, 0.25, 0.5, 0.75, 1],
    [0, 0, 0, 0.3, 0, 0, 0, 0, 0, -0.3, 0, 0, 0, 0, 0]
  ),
  new THREE.VectorKeyframeTrack(
    `${rightUpLeg.name}.rotation`,
    [0, 0.25, 0.5, 0.75, 1],
    [0, 0, 0, -0.3, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0]
  ),
  new THREE.VectorKeyframeTrack(
    `${leftArm.name}.rotation`,
    [0, 0.25, 0.5, 0.75, 1],
    [0, 0, 0, -0.2, 0, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0]
  ),
  new THREE.VectorKeyframeTrack(
    `${rightArm.name}.rotation`,
    [0, 0.25, 0.5, 0.75, 1],
    [0, 0, 0, 0.2, 0, 0, 0, 0, 0, -0.2, 0, 0, 0, 0, 0]
  ),
];

// Run animation (faster walk)
const runTracks = walkTracks.map((track) => {
  const newTrack = track.clone();
  // Speed up the animation by scaling time values
  const times = newTrack.times.map((t) => t * 0.5);
  return new THREE.VectorKeyframeTrack(
    newTrack.name,
    times,
    newTrack.values
  );
});

// Cast animation (arms raised)
const castDuration = 1.5;
const castTracks = [
  new THREE.VectorKeyframeTrack(
    `${leftArm.name}.rotation`,
    [0, castDuration],
    [0, 0, 0, Math.PI / 2, 0, 0]
  ),
  new THREE.VectorKeyframeTrack(
    `${rightArm.name}.rotation`,
    [0, castDuration],
    [0, 0, 0, Math.PI / 2, 0, 0]
  ),
];

// Create animation clips
const animations = [
  new THREE.AnimationClip('idle', idleDuration, tracks),
  new THREE.AnimationClip('walk', walkDuration, walkTracks),
  new THREE.AnimationClip('run', walkDuration * 0.5, runTracks),
  new THREE.AnimationClip('cast', castDuration, castTracks),
];

// Export to GLB
const exporter = new GLTFExporter();

exporter.parse(
  scene,
  (gltf) => {
    const data = JSON.stringify(gltf);
    const blob = new Blob([data], { type: 'application/octet-stream' });

    // In Node.js, we need to use the buffer directly
    const output = exporter.parse(scene, { binary: true });

    fs.writeFileSync(
      path.join('public', 'models', 'character.glb'),
      Buffer.from(output)
    );
    console.log('✓ Generated public/models/character.glb');
  },
  { binary: true, animations }
);

exporter.parse(
  scene,
  (gltf) => {
    const output = exporter.parse(scene, { binary: true });
    fs.writeFileSync(
      path.join('public', 'models', 'character.glb'),
      Buffer.from(output)
    );
    console.log('✓ Generated public/models/character.glb');
  },
  { binary: true, animations }
);
