/**
 * Standalone scenario runner. Hosts minimal isolated worlds (e.g. one wolf
 * vs. one rabbit) so you can watch a trained RL4 policy steer an entity in
 * real time — and so the same scenario is runnable headlessly via
 * `npm run scenario` for tick-speed verification.
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
scene.fog = new THREE.Fog(0x141622, 25, 70);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: 0x3a4538, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// grid for spatial reference
const grid = new THREE.GridHelper(80, 40, 0x556055, 0x303530);
(grid.material as THREE.Material).opacity = 0.5;
(grid.material as THREE.Material).transparent = true;
scene.add(grid);

const sun = new THREE.DirectionalLight(0xfff2cc, 1.1);
sun.position.set(10, 18, 8);
sun.castShadow = true;
scene.add(sun);
scene.add(new THREE.AmbientLight(0xa0a8c0, 0.55));

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

// Orbital follow camera — looks at the "hero" entity (the one the policy
// drives) from above-and-behind.
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 18, 18);
const heroLookAt = new THREE.Vector3();
let heroEntity: { pos: { x: number; z: number }; id: string } | null = null;

// ---- Scenario definitions ----
interface Scenario {
  name: string;
  spawn(): {
    bounds: number;
    providers: PreyProvider[];
    /** Adapter list for the RL4 driver (predators with applyAction). */
    brainAgents: PolicyAgent4Ref[];
    /** Read-only observables (rabbits, cows, etc). */
    observables: PolicyAgent4Ref[];
    /** Which entity the camera follows + HUD reports. */
    hero: PolicyAgent4Ref;
    /** Per-frame tick (animate sub-systems). */
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

const SCENARIOS: Record<string, Scenario> = {
  'wolf-vs-rabbit': {
    name: 'wolf vs rabbit',
    spawn() {
      const bounds = 25;
      const rabbits = new RabbitWarren(scene, 0, bounds, null);
      // Manually spawn a rabbit far from the wolf so we can see chase.
      (rabbits as any).spawnRabbit?.();
      const wolves = new WolfPack(scene, 0, bounds, null, [rabbits], new THREE.Vector3(-8, 0, -8));
      (wolves as any).spawnWolf?.();
      const brainAgents = wolves.getPolicy4Agents();
      const observables = rabbits.getPolicyAgents().map(rl3ToObs4);
      return {
        bounds, providers: [rabbits],
        brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { wolves.update(dt); rabbits.update(dt); },
      };
    },
  },
  'pack-vs-cow': {
    name: '2 wolves vs cow',
    spawn() {
      const bounds = 25;
      const cows = new CowHerd(scene, 0, bounds, null);
      (cows as any).spawnCow?.(); // single cow
      const wolves = new WolfPack(scene, 0, bounds, null, [cows], new THREE.Vector3(-10, 0, -10));
      (wolves as any).spawnWolf?.();
      (wolves as any).spawnWolf?.();
      const brainAgents = wolves.getPolicy4Agents();
      const observables = cows.getPolicyAgents().map(rl3ToObs4);
      return {
        bounds, providers: [cows],
        brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { wolves.update(dt); cows.update(dt); },
      };
    },
  },
  'cat-vs-rabbit': {
    name: 'cat vs rabbit',
    spawn() {
      const bounds = 25;
      const rabbits = new RabbitWarren(scene, 0, bounds, null);
      (rabbits as any).spawnRabbit?.();
      const cats = new CatColony(scene, 0, bounds, null);
      (cats as any).spawnCat?.();
      const brainAgents = cats.getPolicy4Agents();
      const observables = rabbits.getPolicyAgents().map(rl3ToObs4);
      return {
        bounds, providers: [rabbits],
        brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { cats.update(dt); rabbits.update(dt); },
      };
    },
  },
};

const scen = SCENARIOS[scenarioName] ?? SCENARIOS['wolf-vs-rabbit'];
const world = scen.spawn();
heroEntity = world.hero;

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
  logLine(`loaded RL4 policies (${Object.keys(reg.policies).length}) · driver active`);
})();

// ---- Sim speed hotkeys ----
window.addEventListener('keydown', (e) => {
  if (e.code === 'Equal' || e.code === 'NumpadAdd') simSpeed = Math.min(8, simSpeed * 2);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') simSpeed = Math.max(0.25, simSpeed / 2);
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
  hud.innerHTML = `
    <h1>${scen.name}</h1>
    <div class="row"><span class="lbl">hero</span><span class="val">${hero.archetype} · ${hero.hp.toFixed(0)}/${hero.maxHp.toFixed(0)} hp</span></div>
    <div class="row"><span class="lbl">action</span><span class="val">${act}</span></div>
    <div class="row"><span class="lbl">top 3</span><span class="val">${probs}</span></div>
    <div class="row"><span class="lbl">target</span><span class="val">${target ? `${target.archetype} (${target.hp.toFixed(0)}/${target.maxHp.toFixed(0)})` : 'none'}</span></div>
    <div class="row"><span class="lbl">dist</span><span class="val">${isNaN(dist) ? '—' : dist.toFixed(1) + 'm'}</span></div>
    <div class="row"><span class="lbl">sim×</span><span class="val">${simSpeed.toFixed(2)}</span></div>
  `;
}

// ---- Main loop ----
const clock = new THREE.Clock();
let simSpeed = 1.0;
let lastDist = NaN;

function frame() {
  requestAnimationFrame(frame);
  const real = Math.min(0.05, clock.getDelta());
  const dt = real * simSpeed;

  // Tick brain.
  if (driver) driver.update(dt);

  // Tick world (animals).
  world.tick(dt);

  // Log significant events: hero attacks, distance milestones.
  const target = world.observables[0];
  if (target) {
    const dist = Math.hypot(target.pos.x - world.hero.pos.x, target.pos.z - world.hero.pos.z);
    if (!isNaN(lastDist)) {
      if (lastDist > 3 && dist <= 3) logLine(`hero closed to bite range (${dist.toFixed(1)}m)`);
      if (lastDist > 10 && dist <= 10) logLine(`hero within 10m of target`);
    }
    lastDist = dist;
    if (!target.alive && lastDist >= 0) {
      logLine(`target died — emergent kill at t=${(clock.elapsedTime).toFixed(1)}s`);
      lastDist = -1;
    }
  }

  // Camera follow.
  if (heroEntity) {
    heroLookAt.set(heroEntity.pos.x, 0.5, heroEntity.pos.z);
    camera.position.lerp(new THREE.Vector3(heroEntity.pos.x, 14, heroEntity.pos.z + 14), 0.05);
    camera.lookAt(heroLookAt);
  }

  updateHud();
  renderer.render(scene, camera);
}
frame();

// Expose for console poking.
(window as any).scenario = { world, get driver() { return driver; } };
