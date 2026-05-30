import * as THREE from 'three';
import { FBXLoader } from './vendor/three/addons/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from './vendor/three/addons/utils/SkeletonUtils.js';

const canvas = document.getElementById('world');
const chart = document.getElementById('chart');
const cx = chart.getContext('2d');
const hud = document.getElementById('hud');
const inspectEl = document.getElementById('inspect');
const lockHint = document.getElementById('lockHint');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87a9b0);
scene.fog = new THREE.FogExp2(0x87a9b0, 0.012);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.08, 300);
camera.position.set(0, 12, 24);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

scene.add(new THREE.HemisphereLight(0xd7edf0, 0x334326, 2.2));
const sun = new THREE.DirectionalLight(0xfff0ca, 2.8);
sun.position.set(-24, 38, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -42;
sun.shadow.camera.right = sun.shadow.camera.top = 42;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 100;
scene.add(sun);

const INITIAL_WORLD = 60;
let worldSize = INITIAL_WORLD;
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(INITIAL_WORLD + 5, INITIAL_WORLD + 5, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x50793b, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const boundaryMat = new THREE.MeshBasicMaterial({ color: 0xb6d18a, transparent: true, opacity: 0.18 });
const boundary = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(INITIAL_WORLD, 5, INITIAL_WORLD)),
  new THREE.LineBasicMaterial({ color: boundaryMat.color, transparent: true, opacity: boundaryMat.opacity }),
);
boundary.position.y = 2.5;
scene.add(boundary);

const grassGeometry = new THREE.ConeGeometry(0.14, 0.85, 4);
grassGeometry.translate(0, 0.425, 0);
const grass = new THREE.InstancedMesh(
  grassGeometry,
  new THREE.MeshStandardMaterial({ color: 0x397e35, roughness: 1 }),
  1024,
);
grass.castShadow = true;
grass.receiveShadow = true;
grass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(grass);
const matrix = new THREE.Matrix4();
const selectionMarker = new THREE.Mesh(
  new THREE.TorusGeometry(.72, .055, 8, 28),
  new THREE.MeshBasicMaterial({ color: 0xf2bf55 }),
);
selectionMarker.rotation.x = Math.PI / 2;
selectionMarker.position.y = .08;
selectionMarker.visible = false;
scene.add(selectionMarker);

const slots = new Map();
const pickables = [];
let grassSlots = [];
const histF = [], histR = [], histG = [], HMAX = 360;
const raycaster = new THREE.Raycaster();
const center = new THREE.Vector2(0, 0);
let selected = null;
let latestState = null;
let ws = null;
let speed = 1;
let mutantAssets = null;
let yaw = 0;
let pitch = -0.22;
const keys = new Set();
const clock = new THREE.Clock();
const velocity = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function worldPos(x, y) {
  return new THREE.Vector3(x - worldSize / 2, 0, y - worldSize / 2);
}

function setWorldSize(nextSize) {
  if (!nextSize || nextSize === worldSize) return;
  worldSize = nextSize;
  const groundScale = (worldSize + 5) / (INITIAL_WORLD + 5);
  ground.scale.set(groundScale, groundScale, 1);
  const boundaryScale = worldSize / INITIAL_WORLD;
  boundary.scale.set(boundaryScale, 1, boundaryScale);
}

function makeRabbit() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe7ddca, roughness: 0.92 });
  const bellyMat = new THREE.MeshStandardMaterial({ color: 0xfffaf0, roughness: 0.95 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xff8a9a, roughness: 0.7 });
  const mesh = (geometry, material, position, scale) => {
    const value = new THREE.Mesh(geometry, material);
    value.position.set(...position);
    if (scale) value.scale.set(...scale);
    value.castShadow = true;
    group.add(value);
    return value;
  };
  const body = mesh(new THREE.SphereGeometry(0.22, 10, 8), bodyMat, [0, .27, 0], [1.1, .9, 1.4]);
  mesh(new THREE.SphereGeometry(.18, 8, 6), bellyMat, [0, .18, .01], [1, .5, 1.2]);
  const head = mesh(new THREE.SphereGeometry(.16, 10, 8), bodyMat, [0, .61, .28], [1, .95, 1.05]);
  mesh(new THREE.SphereGeometry(.025, 6, 6), noseMat, [0, .59, .445]);
  mesh(new THREE.SphereGeometry(.022, 6, 6), eyeMat, [-.07, .65, .4]);
  mesh(new THREE.SphereGeometry(.022, 6, 6), eyeMat, [.07, .65, .4]);
  const earL = mesh(new THREE.BoxGeometry(.05, .28, .07), bodyMat, [-.07, .88, .26]);
  const earR = mesh(new THREE.BoxGeometry(.05, .28, .07), bodyMat, [.07, .88, .26]);
  earL.rotation.z = .1;
  earR.rotation.z = -.1;
  mesh(new THREE.SphereGeometry(.08, 8, 6), bellyMat, [0, .3, -.32]);
  for (const x of [-.1, .1]) mesh(new THREE.BoxGeometry(.07, .14, .08), bodyMat, [x, .11, .18]);
  for (const x of [-.13, .13]) mesh(new THREE.BoxGeometry(.1, .18, .18), bodyMat, [x, .09, -.15]);
  group.userData.rabbitParts = { body, head, earL, earR };
  return group;
}

function makeFoxFallback() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(.38, .85, 5, 8),
    new THREE.MeshStandardMaterial({ color: 0xb94035, roughness: .88 }),
  );
  body.rotation.x = Math.PI / 2;
  body.position.y = .55;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(.42, .9, 5),
    new THREE.MeshStandardMaterial({ color: 0xe66b4e, roughness: .88 }),
  );
  head.rotation.x = Math.PI / 2;
  head.position.set(0, .63, .85);
  head.castShadow = true;
  group.add(head);
  return group;
}

function removeRootMotion(clip) {
  clip.tracks.forEach(track => {
    if (!track.name.toLowerCase().includes('hips') || !track.name.endsWith('.position')) return;
    for (let i = 0; i < track.values.length; i += 3) {
      track.values[i] = 0;
      track.values[i + 2] = 0;
    }
  });
}

async function loadMutants() {
  const loader = new FBXLoader();
  const load = url => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
  const [model, idle, walk, run] = await Promise.all([
    load('./assets/models/mutant.fbx'),
    load('./assets/models/mutant_breathing_idle.fbx'),
    load('./assets/models/mutant_walking.fbx'),
    load('./assets/models/mutant_run.fbx'),
  ]);
  model.scale.setScalar(.01);
  model.traverse(child => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  const clips = { idle: idle.animations[0], walk: walk.animations[0], run: run.animations[0] };
  Object.values(clips).forEach(clip => {
    clip.tracks.forEach(track => { track.name = track.name.replace(/^[^|]+\|/, ''); });
    removeRootMotion(clip);
  });
  mutantAssets = { model, clips };
  for (const entity of slots.values()) {
    if (entity.type === 3) replaceFoxVisual(entity);
  }
}

function replaceFoxVisual(entity) {
  if (!mutantAssets) return;
  scene.remove(entity.root);
  const root = cloneSkeleton(mutantAssets.model);
  root.scale.setScalar(.012);
  root.userData.slot = entity.slot;
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const [name, clip] of Object.entries(mutantAssets.clips)) actions[name] = mixer.clipAction(clip);
  actions.run.play();
  entity.root = root;
  entity.mixer = mixer;
  entity.actions = actions;
  entity.currentAction = 'run';
  root.position.copy(entity.current);
  scene.add(root);
  rebuildPickables();
}

function spawn(slot, type, target) {
  let root;
  if (type === 2) root = makeRabbit();
  else root = mutantAssets ? cloneSkeleton(mutantAssets.model) : makeFoxFallback();
  root.userData.slot = slot;
  root.position.copy(target);
  scene.add(root);
  const entity = {
    slot, type, root, current: target.clone(), target: target.clone(), previous: target.clone(),
    phase: Math.random() * Math.PI * 2, mixer: null, actions: null, currentAction: null,
  };
  slots.set(slot, entity);
  if (type === 3 && mutantAssets) replaceFoxVisual(entity);
  rebuildPickables();
  return entity;
}

function rebuildPickables() {
  pickables.length = 0;
  pickables.push(grass);
  for (const entity of slots.values()) pickables.push(entity.root);
}

function removeEntity(slot) {
  const entity = slots.get(slot);
  if (!entity) return;
  scene.remove(entity.root);
  slots.delete(slot);
}

function updateEntities(state) {
  // eco_server.py is authoritative. This module only interpolates streamed
  // slots and adds presentation animation; it does not run ecology or policy.
  setWorldSize(state.world);
  latestState = state;
  const living = new Set();
  const positions = new Map();
  let grassCount = 0;
  grassSlots = [];
  for (let i = 0; i < state.t.length; i++) {
    const type = state.t[i];
    const slot = state.slot[i];
    const target = worldPos(state.x[i], state.y[i]);
    if (type === 1) {
      matrix.makeTranslation(target.x, 0, target.z);
      const scale = .72 + ((slot * 29) % 35) / 100;
      matrix.scale(new THREE.Vector3(scale, scale, scale));
      grass.setMatrixAt(grassCount++, matrix);
      grassSlots.push(slot);
      positions.set(slot, target);
      continue;
    }
    living.add(slot);
    let entity = slots.get(slot);
    if (!entity || entity.type !== type) {
      if (entity) removeEntity(slot);
      entity = spawn(slot, type, target);
    }
    entity.previous.copy(entity.target);
    entity.target.copy(target);
    positions.set(slot, target);
  }
  grass.count = grassCount;
  grass.instanceMatrix.needsUpdate = true;
  for (const slot of [...slots.keys()]) {
    if (!living.has(slot)) removeEntity(slot);
  }
  rebuildPickables();
  const selectedPosition = positions.get(selected);
  selectionMarker.visible = Boolean(selectedPosition);
  if (selectedPosition) selectionMarker.position.set(selectedPosition.x, .08, selectedPosition.z);
  updateHud(state);
  if (state.inspect) renderInspect(state.inspect);
  histF.push(state.foxes); histR.push(state.rabbits); histG.push(state.grass);
  if (histF.length > HMAX) { histF.shift(); histR.shift(); histG.shift(); }
  drawChart();
}

function animateEntities(dt, elapsed) {
  const alpha = 1 - Math.exp(-dt * 10);
  for (const entity of slots.values()) {
    entity.current.lerp(entity.target, alpha);
    const dx = entity.target.x - entity.previous.x;
    const dz = entity.target.z - entity.previous.z;
    const moving = dx * dx + dz * dz > .0005;
    if (moving) entity.root.rotation.y = Math.atan2(dx, dz);
    entity.root.position.copy(entity.current);
    if (entity.type === 2) {
      const parts = entity.root.userData.rabbitParts;
      const hop = moving ? Math.max(0, Math.sin(elapsed * 10 + entity.phase)) : 0;
      entity.root.position.y = hop * .38;
      parts.body.rotation.x = hop * -.16;
      parts.head.rotation.x = hop * .12;
      parts.earL.rotation.x = parts.earR.rotation.x = Math.sin(elapsed * 5 + entity.phase) * .12;
    } else if (entity.mixer) {
      const wanted = moving ? 'run' : 'idle';
      if (wanted !== entity.currentAction) {
        entity.actions[entity.currentAction].fadeOut(.22);
        entity.actions[wanted].reset().fadeIn(.22).play();
        entity.currentAction = wanted;
      }
      entity.mixer.update(dt);
    }
  }
}

function updateHud(state) {
  hud.innerHTML =
    `<span class="k">step</span> &nbsp; ${state.step}<br>` +
    `<span class="grass">grass</span> &nbsp; ${state.grass}<br>` +
    `<span class="rab">rabbits</span> ${state.rabbits}<br>` +
    `<span class="fox">foxes</span> &nbsp; ${state.foxes}<br>` +
    `<span class="k">frame</span> &nbsp;${state.frame_ms} ms<br>` +
    `<span class="k">speed</span> &nbsp;${speed.toFixed(2)}x`;
}

function drawChart() {
  const W = chart.width, H = chart.height;
  cx.clearRect(0, 0, W, H);
  const max = Math.max(10, ...histR, ...histF, ...histG);
  const line = (arr, color) => {
    cx.strokeStyle = color;
    cx.lineWidth = 1.4;
    cx.beginPath();
    arr.forEach((value, i) => {
      const x = i / HMAX * W;
      const y = H - value / max * (H - 18) - 3;
      i ? cx.lineTo(x, y) : cx.moveTo(x, y);
    });
    cx.stroke();
  };
  line(histG, '#5baf55'); line(histR, '#f4ead9'); line(histF, '#ff8172');
  cx.fillStyle = '#afbeb4';
  cx.font = '10px monospace';
  cx.fillText(`population history (max ${max})`, 6, 12);
}

function renderInspect(d) {
  if (!d.alive) {
    inspectEl.innerHTML = `<h2>slot ${d.slot}</h2><span class="muted">entity died - aim at another</span>`;
    return;
  }
  const color = { grass: '#70d36b', rabbit: '#f4ead9', fox: '#ff8172' }[d.type_name];
  let html = `<h2 style="color:${color}">${d.type_name.toUpperCase()} - slot ${d.slot}</h2>` +
    `<table><tr><td class="muted">position</td><td>(${d.x}, ${d.y})</td></tr>` +
    `<tr><td class="muted">energy</td><td>${d.energy}</td></tr></table>`;
  if (d.note) html += `<div class="muted" style="margin-top:5px">${d.note}</div>`;
  if (d.obs) {
    const o = d.obs;
    html += `<h2 style="margin-top:9px">STATE - observation</h2><table>` +
      `<tr><td class="muted">self x,y</td><td>${o.self.x_norm}, ${o.self.y_norm}</td></tr>` +
      `<tr><td class="muted">energy norm</td><td>${o.self.energy_norm}</td></tr>` +
      `<tr><td class="muted">visible</td><td>${o.n_visible} / 16</td></tr></table>`;
    if (o.visible.length) {
      html += `<table style="margin-top:3px"><tr class="muted"><td>#</td><td>kind</td><td>dx</td><td>dy</td><td>dist</td></tr>`;
      o.visible.slice(0, 6).forEach((e, i) => {
        html += `<tr><td class="muted">${i}</td><td>${e.kind}</td><td>${e.rel_dx}</td><td>${e.rel_dy}</td><td>${e.dist}</td></tr>`;
      });
      html += '</table>';
    }
  }
  if (d.policy) {
    const p = d.policy;
    const max = Math.max(...p.probs);
    html += `<h2 style="margin-top:9px">ACTION - policy output</h2>` +
      `<div>V(s) = <b>${p.value}</b> - chosen <span class="chosen">${p.action_label}</span></div><table>`;
    p.probs.forEach((prob, i) => {
      const cls = i === p.action ? ' class="chosen"' : '';
      html += `<tr${cls}><td>${p.labels[i]}</td><td><span class="bar" style="width:${Math.round(prob / (max + 1e-9) * 110)}px"></span> ${(prob * 100).toFixed(1)}%</td></tr>`;
    });
    html += '</table>';
  }
  inspectEl.innerHTML = html;
}

function selectCenterEntity() {
  raycaster.setFromCamera(center, camera);
  const hits = raycaster.intersectObjects(pickables, true);
  if (!hits.length) return;
  if (hits[0].object === grass) {
    selected = grassSlots[hits[0].instanceId];
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ select: selected }));
    return;
  }
  let object = hits[0].object;
  while (object && object.userData.slot === undefined) object = object.parent;
  if (!object) return;
  selected = object.userData.slot;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ select: selected }));
}

function updateFlyCamera(dt) {
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0);
  forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.crossVectors(forward, UP).normalize();
  velocity.set(0, 0, 0);
  if (keys.has('KeyW')) velocity.add(forward);
  if (keys.has('KeyS')) velocity.sub(forward);
  if (keys.has('KeyD')) velocity.add(right);
  if (keys.has('KeyA')) velocity.sub(right);
  if (keys.has('KeyR') || keys.has('Space')) velocity.y += 1;
  if (keys.has('KeyF')) velocity.y -= 1;
  if (velocity.lengthSq()) velocity.normalize().multiplyScalar((keys.has('ShiftLeft') ? 25 : 10) * dt);
  camera.position.add(velocity);
  camera.position.y = THREE.MathUtils.clamp(camera.position.y, .6, 55);
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -48, 48);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -48, 48);
}

function connect() {
  const wsPort = new URLSearchParams(location.search).get('wsPort') || '8001';
  ws = new WebSocket(`ws://${location.hostname}:${wsPort}/`);
  ws.onopen = () => {
    if (selected !== null) ws.send(JSON.stringify({ select: selected }));
    if (speed !== 1) ws.send(JSON.stringify({ speed }));
  };
  ws.onmessage = event => updateEntities(JSON.parse(event.data));
  ws.onclose = () => setTimeout(connect, 1000);
}

document.addEventListener('pointerlockchange', () => {
  lockHint.hidden = document.pointerLockElement === canvas;
});
canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  else selectCenterEntity();
});
document.addEventListener('mousemove', event => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= event.movementX * .0023;
  pitch = THREE.MathUtils.clamp(pitch - event.movementY * .0023, -1.45, 1.45);
});
document.addEventListener('keydown', event => {
  keys.add(event.code);
  if (event.code === 'KeyE') selectCenterEntity();
  if (event.key === '+' || event.key === '=') speed = Math.min(8, speed * 1.25);
  else if (event.key === '-' || event.key === '_') speed = Math.max(.1, speed / 1.25);
  else return;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ speed }));
  if (latestState) updateHud(latestState);
});
document.addEventListener('keyup', event => keys.delete(event.code));
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), .1);
  updateFlyCamera(dt);
  animateEntities(dt, clock.elapsedTime);
  renderer.render(scene, camera);
}

loadMutants().catch(error => console.error('mutant assets failed to load; using fallback visuals', error));
connect();
frame();
