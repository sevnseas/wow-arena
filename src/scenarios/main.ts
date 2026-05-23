/**
 * Standalone scenario runner. Hosts minimal isolated worlds where a trained
 * RL4 policy steers an entity in real time. Each scenario uses a fenced "pen"
 * matching one of the training curriculum stages so the policy's competence
 * is visible — bounds=3m means random actions force collisions, bounds=25m
 * means the policy needs to actually navigate.
 *
 * URL: scenarios.html?s=<name>   (defaults to wolf-vs-rabbit)
 */
import * as THREE from 'three';
import { WolfPack } from '../wolves';
import { CatColony } from '../cats';
import { RabbitWarren } from '../rabbits';
import { CowHerd } from '../cows';
import {
  loadPolicy4Registry, PolicyDriver4, ACTION_NAMES,
  type PolicyAgent4Ref,
} from '../rl/runtime4';
import type { PreyProvider } from '../prey';

// ---- DOM ----
const hud = document.getElementById('hud')!;
const log = document.getElementById('log')!;
const picker = document.getElementById('picker')!;
const scenarioName = new URLSearchParams(location.search).get('s') ?? 'wolf-vs-rabbit';
for (const a of picker.querySelectorAll('a')) {
  if ((a as HTMLAnchorElement).dataset.s === scenarioName) a.classList.add('active');
}

function logLine(msg: string): void {
  const line = document.createElement('div');
  line.textContent = msg;
  log.appendChild(line);
  while (log.childElementCount > 8) log.removeChild(log.firstChild!);
}

// ---- Scene ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141622);

const sun = new THREE.DirectionalLight(0xfff2cc, 1.1);
sun.position.set(10, 18, 8);
sun.castShadow = true;
scene.add(sun);
scene.add(new THREE.AmbientLight(0xa0a8c0, 0.6));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
const heroLookAt = new THREE.Vector3();
let heroEntity: { pos: { x: number; z: number }; id: string } | null = null;

/** Build a visible pen: ground square, wireframe walls, corner posts. The
 *  pen acts as a hard reference for "this is where training was set up" so
 *  the observer can intuit what the policy is supposed to handle. */
function buildPen(half: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Pen';

  // Ground — slightly inset so wireframe walls don't z-fight the dirt.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2, half * 2),
    new THREE.MeshStandardMaterial({ color: 0x3a4538, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  g.add(ground);

  // Reference grid — 1m divisions so "rabbit is 4m away" is countable.
  const grid = new THREE.GridHelper(half * 2, half * 2, 0x556055, 0x303530);
  (grid.material as THREE.Material).opacity = 0.45;
  (grid.material as THREE.Material).transparent = true;
  g.add(grid);

  // Pen walls — translucent + wireframe so they read as a boundary, not a maze.
  const wallH = 1.0;
  const wallMat = new THREE.MeshBasicMaterial({
    color: 0xffaa55, transparent: true, opacity: 0.15, side: THREE.DoubleSide,
  });
  const wireMat = new THREE.LineBasicMaterial({ color: 0xffaa55 });
  const sides: Array<[number, number, number, number]> = [
    [-half, -half,  half, -half],
    [ half, -half,  half,  half],
    [ half,  half, -half,  half],
    [-half,  half, -half, -half],
  ];
  for (const [x1, z1, x2, z2] of sides) {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const ang = Math.atan2(x2 - x1, z2 - z1);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, wallH), wallMat);
    wall.position.set((x1 + x2) / 2, wallH / 2, (z1 + z2) / 2);
    wall.rotation.y = ang;
    g.add(wall);
    // Top + bottom wire edges.
    for (const y of [0, wallH]) {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x1, y, z1), new THREE.Vector3(x2, y, z2),
      ]);
      g.add(new THREE.Line(geom, wireMat));
    }
  }
  // Corner posts.
  for (const [x, z] of [[-half, -half], [half, -half], [half, half], [-half, half]]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, wallH * 1.2, 0.15),
      new THREE.MeshStandardMaterial({ color: 0xffaa55, roughness: 0.7 }),
    );
    post.position.set(x, wallH * 0.6, z);
    g.add(post);
  }

  return g;
}

/** Remove a pack's decorative props (den, cave, boulders) so the scenarios
 *  page shows nothing but the participants in the pen. */
function stripDecorations(packGroupNames: string[]): void {
  for (const name of packGroupNames) {
    const obj = scene.getObjectByName(name);
    if (obj) scene.remove(obj);
  }
}

// ---- Scenario definitions ----
interface ScenarioDef {
  name: string;
  /** Pen half-width in meters — matches a training curriculum stage. */
  half: number;
  /** Where to put the camera (distance from center, height) — auto-scaled by pen size. */
  camDistScale?: number;
  spawn(half: number): {
    providers: PreyProvider[];
    brainAgents: PolicyAgent4Ref[];
    observables: PolicyAgent4Ref[];
    hero: PolicyAgent4Ref;
    tick(dt: number): void;
  };
}

function rl3ToObs4(a: any): PolicyAgent4Ref {
  return {
    id: a.id, team: a.team, archetype: a.archetype, size: a.size,
    get alive() { return a.alive; },
    get hp() { return a.hp; },
    get maxHp() { return a.maxHp; },
    get pos() { return a.pos; },
    applyAction: () => {},
  };
}

const SCENARIOS: Record<string, ScenarioDef> = {
  // Tiny pen — matches the easiest training stage (pen3). Random actions
  // alone collide constantly, so a working policy looks decisive here even
  // if it can't generalize to open ranges yet.
  'wolf-vs-rabbit': {
    name: 'wolf vs rabbit · pen 3m',
    half: 3,
    spawn(half) {
      const rabbits = new RabbitWarren(scene, 0, half, null);
      (rabbits as any).spawnRabbit?.();
      const wolves = new WolfPack(scene, 0, half, null, [rabbits], new THREE.Vector3(0.3, 0, 0.3));
      (wolves as any).spawnWolf?.();
      stripDecorations(['WolvesSpawningGround']);
      const brainAgents = wolves.getPolicy4Agents();
      const observables = rabbits.getPolicyAgents().map(rl3ToObs4);
      return {
        providers: [rabbits], brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { wolves.update(dt); rabbits.update(dt); },
      };
    },
  },
  'wolf-vs-rabbit-mid': {
    name: 'wolf vs rabbit · pen 6m',
    half: 6,
    spawn(half) {
      const rabbits = new RabbitWarren(scene, 0, half, null);
      (rabbits as any).spawnRabbit?.();
      const wolves = new WolfPack(scene, 0, half, null, [rabbits], new THREE.Vector3(-2, 0, -2));
      (wolves as any).spawnWolf?.();
      stripDecorations(['WolvesSpawningGround']);
      const brainAgents = wolves.getPolicy4Agents();
      const observables = rabbits.getPolicyAgents().map(rl3ToObs4);
      return {
        providers: [rabbits], brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { wolves.update(dt); rabbits.update(dt); },
      };
    },
  },
  'wolf-vs-rabbit-open': {
    name: 'wolf vs rabbit · pen 12m',
    half: 12,
    spawn(half) {
      const rabbits = new RabbitWarren(scene, 0, half, null);
      (rabbits as any).spawnRabbit?.();
      const wolves = new WolfPack(scene, 0, half, null, [rabbits], new THREE.Vector3(-4, 0, -4));
      (wolves as any).spawnWolf?.();
      stripDecorations(['WolvesSpawningGround']);
      const brainAgents = wolves.getPolicy4Agents();
      const observables = rabbits.getPolicyAgents().map(rl3ToObs4);
      return {
        providers: [rabbits], brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { wolves.update(dt); rabbits.update(dt); },
      };
    },
  },
  'pack-vs-cow': {
    name: '2 wolves vs cow · pen 8m',
    half: 8,
    spawn(half) {
      const cows = new CowHerd(scene, 0, half, null);
      (cows as any).spawnCow?.();
      const wolves = new WolfPack(scene, 0, half, null, [cows], new THREE.Vector3(-3, 0, -3));
      (wolves as any).spawnWolf?.();
      (wolves as any).spawnWolf?.();
      stripDecorations(['WolvesSpawningGround']);
      const brainAgents = wolves.getPolicy4Agents();
      const observables = cows.getPolicyAgents().map(rl3ToObs4);
      return {
        providers: [cows], brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { wolves.update(dt); cows.update(dt); },
      };
    },
  },
  'cat-vs-rabbit': {
    name: 'cat vs rabbit · pen 3m',
    half: 3,
    spawn(half) {
      const rabbits = new RabbitWarren(scene, 0, half, null);
      (rabbits as any).spawnRabbit?.();
      const cats = new CatColony(scene, 0, half, null);
      (cats as any).spawnCat?.();
      const brainAgents = cats.getPolicy4Agents();
      const observables = rabbits.getPolicyAgents().map(rl3ToObs4);
      return {
        providers: [rabbits], brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { cats.update(dt); rabbits.update(dt); },
      };
    },
  },
};

const scen = SCENARIOS[scenarioName] ?? SCENARIOS['wolf-vs-rabbit'];
scene.add(buildPen(scen.half));
const world = scen.spawn(scen.half);
heroEntity = world.hero;

// Camera positioned to frame the whole pen — proportional to size.
const camDist = scen.half * 2.4;
const camHeight = scen.half * 1.6 + 4;
camera.position.set(0, camHeight, camDist);
camera.lookAt(0, 0.5, 0);

// ---- RL4 driver wiring ----
let driver: PolicyDriver4 | null = null;
const baseUrl = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const policyRoot = `${baseUrl.replace(/\/$/, '')}/policies-rl4`;
(async () => {
  const reg = await loadPolicy4Registry(policyRoot);
  if (!reg) {
    logLine('no policies found at ' + policyRoot + ' — run `npm run train:rl4`');
    return;
  }
  driver = new PolicyDriver4(reg, { decisionInterval: 0.3 });
  driver.setAgents([...world.brainAgents, ...world.observables]);
  const archs = Object.keys(reg.policies);
  logLine(`loaded RL4 policies for ${archs.join(', ')} · driver active`);
})();

// ---- Sim speed hotkeys ----
window.addEventListener('keydown', (e) => {
  if (e.code === 'Equal' || e.code === 'NumpadAdd') simSpeed = Math.min(8, simSpeed * 2);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') simSpeed = Math.max(0.25, simSpeed / 2);
  if (e.code === 'KeyR') location.reload();
});

// ---- HUD ----
function updateHud(): void {
  const hero = world.hero;
  const dec = driver?.getDecision(hero.id);
  const target = world.observables[0];
  const dist = target ? Math.hypot(target.pos.x - hero.pos.x, target.pos.z - hero.pos.z) : NaN;
  const act = dec ? ACTION_NAMES[dec.action] : '—';
  const probs = dec
    ? Array.from(dec.probs).map((p, i) => ({ p, i }))
        .sort((a, b) => b.p - a.p).slice(0, 3)
        .map(({ p, i }) => `${ACTION_NAMES[i]}:${(p * 100).toFixed(0)}%`).join(' ')
    : '—';
  const trainHint = scen.half === 3 ? '~98% kill-rate (training distribution)'
                   : scen.half === 6 ? '~60% kill-rate'
                   : scen.half === 8 ? '~40-60% kill-rate'
                   : scen.half === 12 ? '~15% kill-rate (out-of-distribution)'
                   : '~3% kill-rate (open arena)';
  hud.innerHTML = `
    <h1>${scen.name}</h1>
    <div class="row"><span class="lbl">expect</span><span class="val" style="color:#9af0c0">${trainHint}</span></div>
    <div class="row"><span class="lbl">hero</span><span class="val">${hero.archetype} · ${hero.hp.toFixed(0)}/${hero.maxHp.toFixed(0)} hp</span></div>
    <div class="row"><span class="lbl">action</span><span class="val">${act}</span></div>
    <div class="row"><span class="lbl">top 3</span><span class="val">${probs}</span></div>
    <div class="row"><span class="lbl">target</span><span class="val">${target ? `${target.archetype} (${target.hp.toFixed(0)}/${target.maxHp.toFixed(0)})` : 'none'}</span></div>
    <div class="row"><span class="lbl">dist</span><span class="val">${isNaN(dist) ? '—' : dist.toFixed(1) + 'm'}</span></div>
    <div class="row"><span class="lbl">sim×</span><span class="val">${simSpeed.toFixed(2)}</span></div>
    <div class="row"><span class="lbl">kills</span><span class="val">${kills}</span></div>
  `;
}

// ---- Main loop ----
const clock = new THREE.Clock();
let simSpeed = 1.0;
let lastDist = NaN;
let kills = 0;
let killCelebrated = false;

function frame() {
  requestAnimationFrame(frame);
  const real = Math.min(0.05, clock.getDelta());
  const dt = real * simSpeed;

  if (driver) driver.update(dt);
  world.tick(dt);

  // Log significant events.
  const target = world.observables[0];
  if (target) {
    const dist = Math.hypot(target.pos.x - world.hero.pos.x, target.pos.z - world.hero.pos.z);
    if (!isNaN(lastDist)) {
      if (lastDist > 3 && dist <= 3) logLine(`hero closed to bite range (${dist.toFixed(1)}m)`);
    }
    lastDist = dist;
    if (!target.alive && !killCelebrated) {
      kills++;
      killCelebrated = true;
      logLine(`KILL — t=${clock.elapsedTime.toFixed(1)}s (#${kills}) · press R to restart`);
    }
  }

  // Camera follow only mild — keep pen visible at all times.
  if (heroEntity) {
    const lerp = scen.half >= 8 ? 0.04 : 0.0; // small pens: static cam; bigger: gentle follow
    heroLookAt.lerp(new THREE.Vector3(heroEntity.pos.x * 0.3, 0.5, heroEntity.pos.z * 0.3), lerp || 1);
    camera.lookAt(heroLookAt);
  }

  updateHud();
  renderer.render(scene, camera);
}
frame();

(window as any).scenario = { world, get driver() { return driver; } };
