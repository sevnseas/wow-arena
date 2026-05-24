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
  loadPolicy4Registry, PolicyDriver4, ACTION_NAMES, actionToUnitVec, isMovementAction,
  type PolicyAgent4Ref,
} from '../rl/runtime4';
import {
  createEnv4, spawn4, spawnGrass, observe4, act4, step4, clearEcosystemEvents,
  type RLEnv4,
} from '../rl/env4';
import type { Policy4 } from '../rl/policy4';
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

const PHYS = {
  rabbit: { size: 0.28, speed: 2.6, attackCooldown: 1.0, hp: 30 },
  wolf:   { size: 0.50, speed: 4.0, attackCooldown: 0.4, hp: 60 },
};
const ECOSYSTEM_TARGET_HALF = 18;
const ECOSYSTEM_TICK_SPEED = 16;

type EcosystemWorld = ReturnType<typeof createEcosystemWorld>;
let ecosystemPolicies: Partial<Record<'rabbit' | 'wolf', Policy4>> = {};

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
      const observables = rabbits.getPolicy4Agents();
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
      const observables = rabbits.getPolicy4Agents();
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
      const observables = rabbits.getPolicy4Agents();
      return {
        providers: [rabbits], brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { wolves.update(dt); rabbits.update(dt); },
      };
    },
  },
  'ecosystem': {
    name: 'ecosystem · rabbits + wolves',
    half: ECOSYSTEM_TARGET_HALF,
    spawn(half) {
      const eco = createEcosystemWorld(half);
      return eco as any;
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
      const observables = rabbits.getPolicy4Agents();
      return {
        providers: [rabbits], brainAgents, observables,
        hero: brainAgents[0],
        tick(dt) { cats.update(dt); rabbits.update(dt); },
      };
    },
  },
};

function createEcosystemWorld(half: number) {
  const initialHalf = tightEcosystemHalf(8, 2, 12);
  const env = createEnv4({ bounds: initialHalf, visionRadius: Math.max(6, initialHalf * 1.4) }, 31);
  const group = new THREE.Group();
  group.name = 'EcosystemScenario';
  scene.add(group);

  const grassMeshes = new Map<number, THREE.Mesh>();
  const entityMeshes = new Map<number, THREE.Mesh>();
  const metrics = {
    births: { rabbit: 0, wolf: 0 },
    deaths: { rabbit: 0, wolf: 0 },
    history: [] as Array<{ t: number; rabbits: number; wolves: number }>,
    lastSample: -1,
    extinctionAt: null as number | null,
    elapsed: 0,
    half: initialHalf,
    targetHalf: half,
    grassTarget: 12,
    immigrants: { rabbit: 0, wolf: 0 },
    lastImmigrationAt: { rabbit: 0, wolf: 0 },
  };

  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    const r = (0.25 + (i % 3) * 0.22) * initialHalf;
    const g = spawnGrass(env, Math.cos(a) * r, Math.sin(a) * r);
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 24),
      new THREE.MeshBasicMaterial({ color: 0x54d66a, transparent: true, opacity: 0.75 }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(g.x, 0.025, g.z);
    group.add(mesh);
    grassMeshes.set(g.id, mesh);
  }

  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    spawnEcosystemEntity(env, 'rabbit', Math.cos(a) * initialHalf * 0.42, Math.sin(a) * initialHalf * 0.42);
  }
  spawnEcosystemEntity(env, 'wolf', -initialHalf * 0.5, -initialHalf * 0.5);
  spawnEcosystemEntity(env, 'wolf', initialHalf * 0.5, initialHalf * 0.5);

  function ensureMesh(e: any): THREE.Mesh {
    let mesh = entityMeshes.get(e.id);
    if (mesh) return mesh;
    const isWolf = e.archetype === 'wolf';
    mesh = new THREE.Mesh(
      isWolf ? new THREE.ConeGeometry(0.45, 1.0, 16) : new THREE.SphereGeometry(0.28, 16, 10),
      new THREE.MeshStandardMaterial({ color: isWolf ? 0xd76666 : 0xf2d7e5, roughness: 0.65 }),
    );
    mesh.castShadow = true;
    group.add(mesh);
    entityMeshes.set(e.id, mesh);
    return mesh;
  }

  function syncMeshes(): void {
    for (const g of env.grass) {
      const mesh = grassMeshes.get(g.id);
      if (!mesh) continue;
      mesh.scale.setScalar(0.35 + g.nutrition * 0.65);
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.18 + g.nutrition * 0.62;
    }
    for (const e of env.entities) {
      const mesh = ensureMesh(e);
      mesh.visible = e.alive;
      mesh.position.set(e.x, e.archetype === 'wolf' ? 0.5 : 0.28, e.z);
      if (Math.abs(e.vx) + Math.abs(e.vz) > 0.01) mesh.rotation.y = Math.atan2(e.vx, e.vz);
    }
  }

  const heroRef: PolicyAgent4Ref = {
    id: 'ecosystem',
    team: 'predator',
    archetype: 'wolf',
    size: PHYS.wolf.size,
    get alive() { return env.entities.some(e => e.alive && e.archetype === 'wolf'); },
    get hp() { return env.entities.find(e => e.alive && e.archetype === 'wolf')?.hp ?? 0; },
    get maxHp() { return PHYS.wolf.hp; },
    get pos() {
      const e = env.entities.find(x => x.alive && x.archetype === 'wolf') ?? env.entities[0];
      return { x: e?.x ?? 0, z: e?.z ?? 0 };
    },
    applyAction: () => {},
  };

  function tick(dt: number): void {
    metrics.elapsed += dt;
    for (const e of env.entities) {
      if (!e.alive) continue;
      const policy = ecosystemPolicies[e.archetype as 'rabbit' | 'wolf'];
      if (!policy) continue;
      const due = (e as any).nextDecisionAt ?? 0;
      if (metrics.elapsed < due) continue;
      const { probs } = policy.forward(observe4(env, e), 1.0);
      let r = Math.random(), action = 0;
      for (let k = 0; k < probs.length; k++) { r -= probs[k]; if (r < 0) { action = k; break; } }
      act4(env, e, action, dt);
      (e as any).nextDecisionAt = metrics.elapsed + 0.3;
    }
    step4(env, dt);
    for (const ev of env.events) {
      if (ev.type === 'born') metrics.births[ev.archetype as 'rabbit' | 'wolf']++;
      if (ev.type === 'died') {
        const dead = env.entities.find(e => e.id === ev.entityId);
        if (dead?.archetype === 'rabbit' || dead?.archetype === 'wolf') metrics.deaths[dead.archetype]++;
      }
    }
    clearEcosystemEvents(env);
    const sec = Math.floor(metrics.elapsed);
    if (sec !== metrics.lastSample) {
      metrics.lastSample = sec;
      let rabbits = env.entities.filter(e => e.alive && e.archetype === 'rabbit').length;
      let wolves = env.entities.filter(e => e.alive && e.archetype === 'wolf').length;
      maybeImmigrate(env, metrics, rabbits, wolves);
      rabbits = env.entities.filter(e => e.alive && e.archetype === 'rabbit').length;
      wolves = env.entities.filter(e => e.alive && e.archetype === 'wolf').length;
      metrics.history.push({ t: sec, rabbits, wolves });
      while (metrics.history.length > 120) metrics.history.shift();
      if (metrics.extinctionAt === null && (rabbits === 0 || wolves === 0)) metrics.extinctionAt = sec;
      const grew = maybeGrowEcosystemPen(env, metrics);
      if (grew) addOuterGrass(env, group, grassMeshes, metrics.half, metrics.grassTarget);
    }
    syncMeshes();
  }

  syncMeshes();
  return {
    kind: 'ecosystem' as const,
    env,
    metrics,
    providers: [] as PreyProvider[],
    brainAgents: [] as PolicyAgent4Ref[],
    observables: [] as PolicyAgent4Ref[],
    hero: heroRef,
    tick,
  };
}

function tightEcosystemHalf(rabbits: number, wolves: number, grass: number): number {
  const entityArea = rabbits * Math.PI * (PHYS.rabbit.size + 0.55) ** 2
    + wolves * Math.PI * (PHYS.wolf.size + 0.65) ** 2;
  const grassArea = grass * Math.PI * 0.45 ** 2;
  return Math.max(1.5, Math.sqrt((entityArea + grassArea) / 0.70) / 2);
}

function maybeGrowEcosystemPen(env: RLEnv4, metrics: { history: Array<{ rabbits: number; wolves: number }>; half: number; targetHalf: number }): boolean {
  if (metrics.half >= metrics.targetHalf || metrics.history.length < 120) return false;
  const score = (p: { rabbits: number; wolves: number }) => p.rabbits + p.wolves * 2;
  const recent = metrics.history.slice(-30).reduce((s, p) => s + score(p), 0) / 30;
  const older = metrics.history.slice(-120, -90).reduce((s, p) => s + score(p), 0) / 30;
  if (Math.abs(recent - older) / Math.max(1, Math.abs(older)) > 0.05) return false;
  metrics.half = Math.min(metrics.targetHalf, metrics.half + Math.min(0.35, (metrics.targetHalf - metrics.half) * 0.12));
  env.env.config.bounds = metrics.half;
  env.env.config.visionRadius = Math.max(6, metrics.half * 1.4);
  return true;
}

function maybeImmigrate(
  env: RLEnv4,
  metrics: { elapsed: number; half: number; lastImmigrationAt: { rabbit: number; wolf: number }; immigrants: { rabbit: number; wolf: number } },
  rabbits: number,
  wolves: number,
): void {
  if (wolves < 2 && rabbits >= 4 && metrics.elapsed - metrics.lastImmigrationAt.wolf >= 18) {
    spawnPairAtEdge(env, 'wolf', metrics.half);
    metrics.immigrants.wolf += 2;
    metrics.lastImmigrationAt.wolf = metrics.elapsed;
  }
  if (rabbits < 6 && metrics.elapsed - metrics.lastImmigrationAt.rabbit >= 18) {
    spawnPairAtEdge(env, 'rabbit', metrics.half);
    spawnPairAtEdge(env, 'rabbit', metrics.half);
    metrics.immigrants.rabbit += 4;
    metrics.lastImmigrationAt.rabbit = metrics.elapsed;
  }
}

function spawnPairAtEdge(env: RLEnv4, archetype: 'rabbit' | 'wolf', half: number): void {
  const a = Math.random() * Math.PI * 2;
  const r = half * 0.82;
  const cx = Math.cos(a) * r;
  const cz = Math.sin(a) * r;
  const sep = archetype === 'wolf' ? 0.8 : 0.5;
  spawnEcosystemEntity(env, archetype, cx - Math.sin(a) * sep, cz + Math.cos(a) * sep);
  spawnEcosystemEntity(env, archetype, cx + Math.sin(a) * sep, cz - Math.cos(a) * sep);
}

function addOuterGrass(env: RLEnv4, group: THREE.Group, grassMeshes: Map<number, THREE.Mesh>, half: number, targetCount: number): void {
  while (env.grass.length < targetCount + Math.floor(half / 3)) {
    const a = Math.random() * Math.PI * 2;
    const r = half * (0.55 + Math.random() * 0.35);
    const g = spawnGrass(env, Math.cos(a) * r, Math.sin(a) * r);
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 24),
      new THREE.MeshBasicMaterial({ color: 0x54d66a, transparent: true, opacity: 0.75 }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(g.x, 0.025, g.z);
    group.add(mesh);
    grassMeshes.set(g.id, mesh);
  }
}

function spawnEcosystemEntity(env: RLEnv4, archetype: 'rabbit' | 'wolf', x: number, z: number) {
  const p = PHYS[archetype];
  return spawn4(env, {
    archetype,
    team: archetype === 'wolf' ? 'predator' : 'prey',
    x, z,
    hp: p.hp, maxHp: p.hp, size: p.size, speed: p.speed,
    attackCooldown: p.attackCooldown,
    maxAge: archetype === 'wolf' ? 120 : 60,
    starveRate: archetype === 'wolf' ? 0.5 : 1.0,
  });
}

const scen = SCENARIOS[scenarioName] ?? SCENARIOS['wolf-vs-rabbit'];
const pen = buildPen(scen.half);
scene.add(pen);
const world = scen.spawn(scen.half);
heroEntity = world.hero;

// Camera positioned to frame the whole pen — proportional to size.
const camDist = scen.half * 2.4;
const camHeight = scen.half * 1.6 + 4;
camera.position.set(0, camHeight, camDist);
camera.lookAt(0, 0.5, 0);

// ---- RL4 driver wiring ----
let driver: PolicyDriver4 | null = null;
interface PolicyMeta {
  archetype: string;
  trainedAt: string;
  episodesPerStage: number;
  bestEpisodeMA50: number;
  bestStage: string;
  bestEpisodeIndex: number;
  killRatesByStage?: Record<string, number>;
  policyConfig: { hidden: number; lr: number; baselineEMA: number; entropyCoef: number };
  historyLength: number;
}
const policyMeta: Record<string, PolicyMeta> = {};
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
  ecosystemPolicies = {
    rabbit: reg.get('rabbit') ?? undefined,
    wolf: reg.get('wolf') ?? undefined,
  };
  const archs = Object.keys(reg.policies);
  logLine(`loaded RL4 policies for ${archs.join(', ')} · driver active`);
  // Sidecar metadata — non-fatal if absent (older policies don't have it).
  for (const a of archs) {
    try {
      const res = await fetch(`${policyRoot}/${a}.meta.json`);
      if (res.ok) policyMeta[a] = await res.json();
    } catch { /* meta is optional */ }
  }
})();

// ---- Action arrow visualization ----
// One arrow per brain-driven agent showing the policy's chosen move direction
// (world frame, matches actionToUnitVec). Length = action confidence; color
// shifts from grey (uniform) → cyan (decisive). Abilities pulse the marker
// instead of pointing. This is the smoking gun for "is the policy actually
// homing on the target?" — by eye, you should see the arrow point at the prey.
const arrowGroup = new THREE.Group();
arrowGroup.name = 'ActionArrows';
scene.add(arrowGroup);

interface AgentMarker {
  agentId: string;
  arrow: THREE.ArrowHelper;
  abilityPulse: THREE.Mesh;
}
const agentMarkers: AgentMarker[] = [];
for (const a of world.brainAgents) {
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0),
    2.0, 0x66e0ff, 0.5, 0.3,
  );
  arrowGroup.add(arrow);
  const pulse = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.0, 24),
    new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0 }),
  );
  pulse.rotation.x = -Math.PI / 2;
  arrowGroup.add(pulse);
  agentMarkers.push({ agentId: a.id, arrow, abilityPulse: pulse });
}

function updateActionArrows(): void {
  for (const m of agentMarkers) {
    const agent = world.brainAgents.find(a => a.id === m.agentId);
    if (!agent || !agent.alive) {
      m.arrow.visible = false; m.abilityPulse.visible = false; continue;
    }
    m.arrow.visible = true;
    const dec = driver?.getDecision(m.agentId);
    const origin = new THREE.Vector3(agent.pos.x, 1.2, agent.pos.z);
    if (dec && isMovementAction(dec.action)) {
      const v = actionToUnitVec(dec.action);
      m.arrow.position.copy(origin);
      m.arrow.setDirection(new THREE.Vector3(v.x, 0, v.z));
      const confidence = dec.probs[dec.action]; // 0..1
      const len = 1.0 + confidence * 2.5;
      m.arrow.setLength(len, Math.min(0.6, len * 0.25), Math.min(0.35, len * 0.15));
      // Color: lerp grey → cyan with confidence.
      const c = new THREE.Color(0x666666).lerp(new THREE.Color(0x66e0ff), confidence);
      (m.arrow.line.material as THREE.LineBasicMaterial).color.copy(c);
      (m.arrow.cone.material as THREE.MeshBasicMaterial).color.copy(c);
      (m.abilityPulse.material as THREE.MeshBasicMaterial).opacity *= 0.85;
    } else if (dec) {
      // Ability action — pulse a ring under the agent.
      m.arrow.position.copy(origin);
      m.arrow.setLength(0.3, 0.15, 0.1);
      m.abilityPulse.position.set(agent.pos.x, 0.05, agent.pos.z);
      (m.abilityPulse.material as THREE.MeshBasicMaterial).opacity = 0.9;
    }
  }
}

// ---- Sim speed hotkeys ----
window.addEventListener('keydown', (e) => {
  if (e.code === 'Equal' || e.code === 'NumpadAdd') simSpeed = Math.min(8, simSpeed * 2);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') simSpeed = Math.max(0.25, simSpeed / 2);
  if (e.code === 'KeyR') location.reload();
});

// ---- HUD ----
function updateHud(): void {
  if ((world as any).kind === 'ecosystem') {
    updateEcosystemHud(world as any as EcosystemWorld);
    return;
  }
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

  // Policy provenance — pulled from the sidecar meta.json if present. The
  // header colors trained vs untrained differently so it's obvious at a glance.
  const meta = policyMeta[hero.archetype];
  let provenance: string;
  if (!driver) {
    provenance = `<span style="color:#ff6">loading…</span>`;
  } else if (!driver.hasPolicy(hero.archetype as any)) {
    provenance = `<span style="color:#f88">NO POLICY for ${hero.archetype}</span>`;
  } else if (!meta) {
    provenance = `<span style="color:#fc6">trained (no meta.json — pre-curriculum run)</span>`;
  } else {
    const age = humanAge(meta.trainedAt);
    provenance = `<span style="color:#9f9">trained ${age} · ${meta.episodesPerStage} eps × ${Object.keys(meta.killRatesByStage ?? {}).length || 'ecosystem'} stages</span>`;
  }
  const krRows = meta
    ? Object.entries(meta.killRatesByStage ?? {}).map(([k, v]) => {
        const cur = (scen.half === 3 && k === 'pen3') || (scen.half === 6 && k === 'pen6')
                 || (scen.half === 8 && k === 'pen6') || (scen.half === 12 && k === 'pen12');
        const w = Math.round((v as number) * 14);
        const bar = '█'.repeat(w) + '·'.repeat(14 - w);
        const color = cur ? '#9af0c0' : '#888';
        return `<div style="color:${color};font-size:10px">${k.padEnd(6)} ${bar} ${((v as number) * 100).toFixed(0).padStart(3)}%${cur ? ' ← this pen' : ''}</div>`;
      }).join('')
    : '';

  hud.innerHTML = `
    <h1>${scen.name}</h1>
    <div class="row"><span class="lbl">policy</span><span class="val">${provenance}</span></div>
    ${meta ? `<div class="row"><span class="lbl">trained</span><span class="val" style="font-size:10px">best ma50 ${(meta.bestEpisodeMA50 ?? meta.bestMetricScore50 ?? 0).toFixed(0)} @${meta.bestStage}/ep${meta.bestEpisodeIndex} · hidden=${meta.policyConfig.hidden} lr=${meta.policyConfig.lr}</span></div>` : ''}
    ${krRows ? `<div style="margin:4px 0 6px 0;font-family:monospace">${krRows}</div>` : ''}
    <hr style="border:0;border-top:1px solid #333;margin:6px 0">
    <div class="row"><span class="lbl">hero</span><span class="val">${hero.archetype} · ${hero.hp.toFixed(0)}/${hero.maxHp.toFixed(0)} hp</span></div>
    <div class="row"><span class="lbl">action</span><span class="val">${act}</span></div>
    <div class="row"><span class="lbl">top 3</span><span class="val">${probs}</span></div>
    <div class="row"><span class="lbl">target</span><span class="val">${target ? `${target.archetype} (${target.hp.toFixed(0)}/${target.maxHp.toFixed(0)})` : 'none'}</span></div>
    <div class="row"><span class="lbl">dist</span><span class="val">${isNaN(dist) ? '—' : dist.toFixed(1) + 'm'}</span></div>
    <div class="row"><span class="lbl">sim×</span><span class="val">${simSpeed.toFixed(2)}</span></div>
    <div class="row"><span class="lbl">kills</span><span class="val">${kills}</span></div>
  `;
}

function updateEcosystemHud(eco: EcosystemWorld): void {
  const alive = eco.env.entities.filter(e => e.alive);
  const rabbits = alive.filter(e => e.archetype === 'rabbit');
  const wolves = alive.filter(e => e.archetype === 'wolf');
  const grassCoverage = eco.env.grass.length
    ? eco.env.grass.reduce((s, g) => s + g.nutrition, 0) / eco.env.grass.length
    : 0;
  const avgAge = (xs: typeof alive) => xs.length ? xs.reduce((s, e) => s + e.age, 0) / xs.length : 0;
  const last = eco.metrics.history[eco.metrics.history.length - 1];
  const prev = eco.metrics.history[Math.max(0, eco.metrics.history.length - 31)];
  const rate = last && prev && last.t !== prev.t
    ? ((last.rabbits + last.wolves) - (prev.rabbits + prev.wolves)) / (last.t - prev.t)
    : 0;
  const extinctionEstimate = eco.metrics.extinctionAt !== null
    ? `extinct at ${eco.metrics.extinctionAt}s`
    : rate < -0.01 ? `${Math.max(0, Math.round((rabbits.length + wolves.length) / -rate))}s` : 'stable';
  const rabbitPolicy = ecosystemPolicies.rabbit ? '#9f9' : '#f88';
  const wolfPolicy = ecosystemPolicies.wolf ? '#9f9' : '#f88';

  hud.innerHTML = `
    <h1>${scen.name}</h1>
    <div class="row"><span class="lbl">policy</span><span class="val"><span style="color:${rabbitPolicy}">rabbit</span> · <span style="color:${wolfPolicy}">wolf</span></span></div>
    <hr style="border:0;border-top:1px solid #333;margin:6px 0">
    <div class="row"><span class="lbl">pop</span><span class="val">rabbits ${rabbits.length} · wolves ${wolves.length}</span></div>
    <div class="row"><span class="lbl">pen</span><span class="val">${eco.metrics.half.toFixed(1)}m → ${eco.metrics.targetHalf.toFixed(0)}m</span></div>
    <div class="row"><span class="lbl">births</span><span class="val">R ${eco.metrics.births.rabbit} · W ${eco.metrics.births.wolf}</span></div>
    <div class="row"><span class="lbl">deaths</span><span class="val">R ${eco.metrics.deaths.rabbit} · W ${eco.metrics.deaths.wolf}</span></div>
    <div class="row"><span class="lbl">spawn</span><span class="val">R ${eco.metrics.immigrants.rabbit} · W ${eco.metrics.immigrants.wolf}</span></div>
    <div class="row"><span class="lbl">avg age</span><span class="val">R ${avgAge(rabbits).toFixed(1)}s · W ${avgAge(wolves).toFixed(1)}s</span></div>
    <div class="row"><span class="lbl">grass</span><span class="val">${(grassCoverage * 100).toFixed(0)}%</span></div>
    <div class="row"><span class="lbl">extinct</span><span class="val">${extinctionEstimate}</span></div>
    <div class="row"><span class="lbl">sim×</span><span class="val">${simSpeed.toFixed(2)} tick-speed</span></div>
    <div style="margin-top:8px;font-family:monospace;line-height:1">${populationChart(eco.metrics.history)}</div>
  `;
}

function populationChart(history: Array<{ rabbits: number; wolves: number }>): string {
  if (history.length === 0) return '';
  const width = 42, height = 8;
  const maxPop = Math.max(1, ...history.map(p => Math.max(p.rabbits, p.wolves)));
  const rows = Array.from({ length: height }, () => Array(width).fill('&nbsp;'));
  for (let i = 0; i < history.length; i++) {
    const x = Math.floor(i / Math.max(1, history.length - 1) * (width - 1));
    const ry = height - 1 - Math.round(history[i].rabbits / maxPop * (height - 1));
    const wy = height - 1 - Math.round(history[i].wolves / maxPop * (height - 1));
    rows[ry][x] = '<span style="color:#f2d7e5">r</span>';
    rows[wy][x] = rows[wy][x] === '&nbsp;' ? '<span style="color:#d76666">w</span>' : '<span style="color:#fff">*</span>';
  }
  return rows.map(r => r.join('')).join('<br>');
}

/** Minimap canvas — draws the exact observation vector the policy receives.
 *  This is the smoking gun for "what does the network actually see?".
 *  Concentric circles = vision radius / 2. Hero is the dot at center.
 *  Other entities: red dot if enemy (team=1), green if ally, sized by HP.
 *  Tail line shows the entity's velocity (cells 2,3 of the obs). The chosen
 *  action arrow is overlaid in cyan so input ↔ output correspondence is
 *  visible in one glance. */
const miniCanvas = document.getElementById('minimap-canvas') as HTMLCanvasElement;
const miniCtx = miniCanvas.getContext('2d')!;
const miniLegend = document.getElementById('minimap-legend')!;

function updateMinimap(): void {
  const W = miniCanvas.width, H = miniCanvas.height;
  miniCtx.fillStyle = '#0a0d18';
  miniCtx.fillRect(0, 0, W, H);

  const hero = world.hero;
  const dec = driver?.getDecision(hero.id);
  if (!dec || !driver) {
    miniCtx.fillStyle = '#666';
    miniCtx.font = '10px monospace';
    miniCtx.fillText('(no decision yet)', 10, H / 2);
    return;
  }

  // The observation is normalized by visionRadius in env4 (rel_x / visionR).
  // Reading driver.cfg.visionRadius would couple to internals; just assume
  // the default 18 — close enough for visualization since we don't rescale.
  const cx = W / 2, cy = H / 2;
  // Concentric circles at 25/50/75/100% of vision radius — sense of scale.
  miniCtx.strokeStyle = '#222a3a';
  for (let i = 1; i <= 4; i++) {
    miniCtx.beginPath();
    miniCtx.arc(cx, cy, (i / 4) * (W / 2 - 4), 0, Math.PI * 2);
    miniCtx.stroke();
  }
  miniCtx.strokeStyle = '#1a2230';
  miniCtx.beginPath(); miniCtx.moveTo(cx, 0); miniCtx.lineTo(cx, H); miniCtx.stroke();
  miniCtx.beginPath(); miniCtx.moveTo(0, cy); miniCtx.lineTo(W, cy); miniCtx.stroke();

  const archColors = ['#666', '#9c7', '#fcd', '#a96', '#c8a', '#cb8', '#f88'];

  // Walk the 20 entity slots in the obs (7 features each).
  const s = dec.state;
  const FEAT = 7;
  const N_SLOTS = 20;
  let nVisible = 0;
  for (let i = 0; i < N_SLOTS; i++) {
    const base = i * FEAT;
    const archCode = Math.round(s[base + 5] * 6);
    if (archCode === 0) continue;
    nVisible++;
    const relX = s[base + 0];      // already normalized to [-1, 1]ish
    const relZ = s[base + 1];
    const velX = s[base + 2];
    const velZ = s[base + 3];
    const hp = s[base + 4];
    const isEnemy = s[base + 6] > 0.5;
    // Map normalized rel-pos to canvas. Note: env4 uses (x, z) world, +z
    // = "forward" in scene. On the canvas we mirror y so +z renders up.
    const px = cx + relX * (W / 2 - 4);
    const py = cy - relZ * (H / 2 - 4);
    // Velocity line.
    miniCtx.strokeStyle = isEnemy ? 'rgba(255,128,128,0.5)' : 'rgba(160,255,160,0.4)';
    miniCtx.beginPath();
    miniCtx.moveTo(px, py);
    miniCtx.lineTo(px + velX * 20, py - velZ * 20);
    miniCtx.stroke();
    // Entity dot, sized by HP.
    const r = 3 + hp * 4;
    miniCtx.fillStyle = isEnemy ? '#ff6666' : archColors[archCode];
    miniCtx.beginPath();
    miniCtx.arc(px, py, r, 0, Math.PI * 2);
    miniCtx.fill();
    miniCtx.strokeStyle = '#000';
    miniCtx.stroke();
    // Slot index — useful for matching against the obs feature dump.
    miniCtx.fillStyle = '#000';
    miniCtx.font = '8px monospace';
    miniCtx.fillText(String(i), px - 2, py + 2);
  }

  // Hero dot.
  miniCtx.fillStyle = '#9af0c0';
  miniCtx.beginPath();
  miniCtx.arc(cx, cy, 5, 0, Math.PI * 2);
  miniCtx.fill();
  miniCtx.strokeStyle = '#000';
  miniCtx.stroke();

  // Chosen action arrow — overlays the input so the eye can confirm
  // "policy chose to move toward THAT dot".
  if (isMovementAction(dec.action)) {
    const v = actionToUnitVec(dec.action);
    miniCtx.strokeStyle = '#66e0ff';
    miniCtx.lineWidth = 2;
    miniCtx.beginPath();
    miniCtx.moveTo(cx, cy);
    miniCtx.lineTo(cx + v.x * 30, cy - v.z * 30);
    miniCtx.stroke();
    miniCtx.lineWidth = 1;
  } else {
    // Ability — pulse a yellow ring at the hero.
    miniCtx.strokeStyle = '#ffcc44';
    miniCtx.lineWidth = 2;
    miniCtx.beginPath();
    miniCtx.arc(cx, cy, 10 + (Date.now() / 100 % 6), 0, Math.PI * 2);
    miniCtx.stroke();
    miniCtx.lineWidth = 1;
  }

  miniLegend.textContent = `${nVisible} entity slot${nVisible === 1 ? '' : 's'} active · 145-dim obs`;
}

function humanAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// ---- Main loop ----
const clock = new THREE.Clock();
let simSpeed = 1.0;
if ((world as any).kind === 'ecosystem') simSpeed = ECOSYSTEM_TICK_SPEED;
let lastDist = NaN;
let kills = 0;
let killCelebrated = false;

function frame() {
  requestAnimationFrame(frame);
  const real = Math.min(0.05, clock.getDelta());
  const dt = real * simSpeed;

  if ((world as any).kind === 'ecosystem') {
    const fixed = 1 / 60;
    const steps = Math.max(1, Math.min(240, Math.floor(dt / fixed)));
    for (let i = 0; i < steps; i++) world.tick(fixed);
  } else {
    if (driver) driver.update(dt);
    world.tick(dt);
  }
  updateActionArrows();

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
  if ((world as any).kind === 'ecosystem') {
    const eco = world as any as EcosystemWorld;
    const scale = eco.metrics.half / scen.half;
    pen.scale.set(scale, 1, scale);
  }
  if (heroEntity) {
    const lerp = scen.half >= 8 ? 0.04 : 0.0; // small pens: static cam; bigger: gentle follow
    heroLookAt.lerp(new THREE.Vector3(heroEntity.pos.x * 0.3, 0.5, heroEntity.pos.z * 0.3), lerp || 1);
    camera.lookAt(heroLookAt);
  }

  updateHud();
  updateMinimap();
  renderer.render(scene, camera);
}
frame();

(window as any).scenario = { world, get driver() { return driver; } };
