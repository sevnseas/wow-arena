import * as THREE from 'three';

const canvas = document.getElementById('world');
const hud = document.getElementById('hud');
const roster = document.getElementById('roster');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d14);
scene.fog = new THREE.FogExp2(0x0a0d14, 0.006);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x202838, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(40, 80, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
scene.add(sun);

let world = 50;
const arena = new THREE.Group();
scene.add(arena);

// ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(world, world),
  new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
arena.add(ground);
const grid = new THREE.GridHelper(world, 20, 0x2c3a52, 0x1f2a3c);
grid.position.y = 0.01;
arena.add(grid);
const ring = new THREE.Mesh(
  new THREE.RingGeometry(world * 0.49, world * 0.5, 64),
  new THREE.MeshBasicMaterial({ color: 0x3a4c6b, side: THREE.DoubleSide }));
ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
arena.add(ring);

const TEAM_COL = { A: 0x5fa8ff, B: 0xff6b6b };
const pillarGroup = new THREE.Group(); arena.add(pillarGroup);
const agentGroup = new THREE.Group(); arena.add(agentGroup);
const agents = new Map();   // slot -> { group, body, hpfill, ring, role }

// world (x,y) -> scene (X up=Y, Z) centred on origin
function place(obj, x, y, h = 0) { obj.position.set(x - world / 2, h, y - world / 2); }

function buildPillars(pillars) {
  pillarGroup.clear();
  for (const p of pillars) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(p.r, p.r * 1.05, 7, 24),
      new THREE.MeshStandardMaterial({ color: 0x4a5878, roughness: 0.8 }));
    m.castShadow = true; m.receiveShadow = true;
    place(m, p.x, p.y, 3.5);
    pillarGroup.add(m);
  }
}

function makeAgent(a) {
  const g = new THREE.Group();
  const col = TEAM_COL[a.team];
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 20, 16),
    new THREE.MeshStandardMaterial({ color: col, roughness: 0.5,
      emissive: col, emissiveIntensity: 0.12 }));
  body.castShadow = true; body.position.y = 1.2;
  g.add(body);
  // healer marker: a green cross cone above the head
  if (a.role === 'healer') {
    const c = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.1, 4),
      new THREE.MeshStandardMaterial({ color: 0x6ef0a0, emissive: 0x2fa060,
        emissiveIntensity: 0.4 }));
    c.position.y = 3.1; g.add(c);
  }
  // CC status ring (hidden unless crowd-controlled)
  const ccRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.5, 0.12, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
  ccRing.rotation.x = -Math.PI / 2; ccRing.position.y = 0.15; ccRing.visible = false;
  g.add(ccRing);
  // HP bar (billboarded): background + fill
  const bar = new THREE.Group(); bar.position.y = 2.9;
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.32),
    new THREE.MeshBasicMaterial({ color: 0x222a38 }));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.32),
    new THREE.MeshBasicMaterial({ color: 0x5ad06a }));
  fill.position.z = 0.01;
  bar.add(bg); bar.add(fill);
  g.add(bar);
  agentGroup.add(g);
  agents.set(a.slot, { group: g, body, hpfill: fill, hpbar: bar, ring: ccRing,
    role: a.role, team: a.team });
}

function updateAgents(list) {
  for (const a of list) {
    if (!agents.has(a.slot)) makeAgent(a);
    const A = agents.get(a.slot);
    place(A.group, a.x, a.y, 0);
    A.group.visible = true;
    const frac = Math.max(0, a.hp_frac);
    A.hpfill.scale.x = Math.max(0.001, frac);
    A.hpfill.position.x = -(2.2 * (1 - frac)) / 2;
    A.hpfill.material.color.setHex(frac > 0.5 ? 0x5ad06a : frac > 0.25 ? 0xe0c14a : 0xe05050);
    const ccd = a.status !== 'idle';
    A.ring.visible = ccd && a.alive;
    A.body.material.emissiveIntensity = ccd ? 0.5 : 0.12;
    if (!a.alive) {
      A.group.position.y = -0.6;
      A.body.material.opacity = 0.25; A.body.material.transparent = true;
      A.hpbar.visible = false;
    } else {
      A.body.material.opacity = 1; A.body.material.transparent = false;
      A.hpbar.visible = true;
    }
  }
}

// ---- self-contained orbit camera ----
let az = Math.PI * 0.25, pol = 0.95, rad = world * 1.4;
let dragging = false, px = 0, py = 0;
function applyCam() {
  const r = rad;
  camera.position.set(
    r * Math.sin(pol) * Math.cos(az),
    r * Math.cos(pol),
    r * Math.sin(pol) * Math.sin(az));
  camera.lookAt(0, 2, 0);
}
canvas.addEventListener('mousedown', e => { dragging = true; px = e.clientX; py = e.clientY; });
addEventListener('mouseup', () => dragging = false);
addEventListener('mousemove', e => {
  if (!dragging) return;
  az -= (e.clientX - px) * 0.005;
  pol = Math.min(1.45, Math.max(0.15, pol - (e.clientY - py) * 0.005));
  px = e.clientX; py = e.clientY; applyCam();
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  rad = Math.min(world * 3, Math.max(world * 0.5, rad * (1 + Math.sign(e.deltaY) * 0.08)));
  applyCam();
}, { passive: false });

// ---- HUD / roster ----
function renderHud(s) {
  hud.innerHTML =
    `<div class="k">mode</div> <b>${s.mode}</b>` +
    `<div><span class="teamA">Team A</span> alive <b>${s.aliveA}</b> &nbsp; ` +
    `<span class="teamB">Team B</span> alive <b>${s.aliveB}</b></div>` +
    `<div class="k">step ${s.step} &middot; episode ${s.episode}</div>` +
    `<div class="k">frame ${s.frame_ms ?? '-'} ms &middot; speed ${speed.toFixed(1)}x</div>`;
  const rows = s.agents.map(a => {
    const cls = a.alive ? '' : 'dead';
    const cc = a.status !== 'idle' ? `<span class="cc">${a.status} ${a.cc}</span>` : '';
    return `<div class="row ${cls}"><span class="team${a.team}">${a.team} ${a.role}</span>` +
      `<span><span class="hpbar"><span class="hpfill" style="width:${Math.max(0, a.hp_frac) * 100}%"></span></span> ` +
      `${a.hp} ${cc}</span></div>`;
  }).join('');
  roster.innerHTML = `<div class="k" style="margin-bottom:5px">roster (hp / status)</div>${rows}`;
}

// ---- websocket ----
let speed = 1.0, ws = null;
function connect() {
  const wsPort = new URLSearchParams(location.search).get('wsPort') || '8001';
  ws = new WebSocket(`ws://${location.hostname}:${wsPort}/`);
  ws.onmessage = ev => {
    const s = JSON.parse(ev.data);
    if (s.world && s.world !== world) { world = s.world; }
    if (s.pillars && pillarGroup.children.length !== s.pillars.length) buildPillars(s.pillars);
    else if (s.pillars && pillarGroup.children.length === 0) buildPillars(s.pillars);
    updateAgents(s.agents);
    renderHud(s);
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
addEventListener('keydown', e => {
  if (e.key === '+' || e.key === '=') speed = Math.min(8, speed + 0.5);
  else if (e.key === '-' || e.key === '_') speed = Math.max(0.5, speed - 0.5);
  else return;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ speed }));
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

applyCam();
buildPillars([]);
connect();
(function loop() {
  requestAnimationFrame(loop);
  // billboard HP bars toward camera
  for (const A of agents.values()) if (A.hpbar.visible) A.hpbar.quaternion.copy(camera.quaternion);
  renderer.render(scene, camera);
})();
