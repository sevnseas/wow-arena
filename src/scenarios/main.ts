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
interface PolicyMeta {
  archetype: string;
  trainedAt: string;
  episodesPerStage: number;
  bestEpisodeMA50: number;
  bestStage: string;
  bestEpisodeIndex: number;
  killRatesByStage: Record<string, number>;
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
    provenance = `<span style="color:#9f9">trained ${age} · ${meta.episodesPerStage} eps × ${Object.keys(meta.killRatesByStage).length} stages</span>`;
  }
  const krRows = meta
    ? Object.entries(meta.killRatesByStage).map(([k, v]) => {
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
    ${meta ? `<div class="row"><span class="lbl">trained</span><span class="val" style="font-size:10px">best ma50 ${meta.bestEpisodeMA50.toFixed(0)} @${meta.bestStage}/ep${meta.bestEpisodeIndex} · hidden=${meta.policyConfig.hidden} lr=${meta.policyConfig.lr}</span></div>` : ''}
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
let lastDist = NaN;
let kills = 0;
let killCelebrated = false;

function frame() {
  requestAnimationFrame(frame);
  const real = Math.min(0.05, clock.getDelta());
  const dt = real * simSpeed;

  if (driver) driver.update(dt);
  world.tick(dt);
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
