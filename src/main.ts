/**
 * WoW Arena Sandbox - Phase 4
 *
 * Features:
 * - Class selection (Tab)
 * - Action bar with abilities
 * - Cooldowns, debuffs, casting, projectiles
 * - Multiplayer support (server-authoritative)
 *
 * URL params:
 *   ?mode=standalone  - Local only (default)
 *   ?mode=multiplayer - Connect to server
 *   ?server=ws://host:port - Custom server URL
 */

import * as THREE from 'three';
import { createAxisGizmo } from './coords';
import { createArena, getColliders, getTerrainHeightData } from './arena';
import { CameraRig } from './camera';
import { PlayerController } from './player';
import { TargetingSystem } from './targeting';
import { INITIAL_ENTITIES, EntityDef } from './entities';
import { ProceduralCharacterView, CharacterView, LocomotionState } from './character';
import { MixamoCharacterView } from './mixamo-character';
import { CooldownManager, DebuffManager, CastSystem, ProjectileSystem } from './systems';
import { ClassName, AbilityContext, getClassAbilities, getAbilityByKey } from './abilities';
import { getModeFromUrl, GameMode } from './mode';
import { NetworkGame, ConnectionState } from './net';
import { SkyEnvironment } from './sky';
import { JUMP_FORCE } from './shared/physics';
import { DamageSplatSystem } from './damage-splat';
import { DogPack } from './dogs';
import { RabbitWarren } from './rabbits';
import { CatColony } from './cats';
import { CowHerd } from './cows';
import { Holdable } from './holdable';
import { SceneEditor } from './editor';
import { SnapshotSystem } from './snapshot';
import { Ecosystem } from './ecosystem';
import { getTerrainHeight } from './terrain';
import { ProceduralTree } from './proceduralTree';
import { ColliderDebug } from './collider-debug';
import { WolfPack } from './wolves';
import { Rivers } from './rivers';
import { HpBarOverlay } from './hp-bars';
import { Atmosphere } from './atmosphere';
import type { PreyProvider } from './prey';
import { BasicGameEntity, GameEntity, GameEntityRegistry, RefGameEntity } from './game-entity';
import { MutantPredator } from './mutant-predator';
import { loadPolicyRegistry, PolicyDriver } from './rl';

// ============================================================================
// Character Factory
// ============================================================================

async function createCharacterView(useMixamo: boolean, color?: number): Promise<CharacterView> {
  if (useMixamo) {
    try {
      const params = new URL(window.location.href).searchParams;
      const charFile = params.get('char') || 'character';
      return await MixamoCharacterView.load('models', charFile);
    } catch (error) {
      console.warn('Failed to load Mixamo character, falling back to procedural:', error);
      return new ProceduralCharacterView(color || 0xffff00);
    }
  }
  return new ProceduralCharacterView(color || 0xffff00);
}

// ============================================================================
// Game State
// ============================================================================

interface GameState {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  cameraRig: CameraRig;
  sky: SkyEnvironment;
  player: PlayerController;
  playerView: CharacterView;
  targeting: TargetingSystem;
  entities: Map<string, THREE.Object3D>;
  clock: THREE.Clock;
  debugElement: HTMLElement | null;

  // Phase 3 systems
  currentClass: ClassName;
  cooldowns: CooldownManager;
  debuffs: DebuffManager;
  casts: CastSystem;
  projectiles: ProjectileSystem;
  damageSplats: DamageSplatSystem;
  dogs: DogPack;
  rabbits: RabbitWarren;
  cats: CatColony;
  cows: CowHerd;
  carrySlot: THREE.Group;
  heldAnimal: Holdable | null;
  classSelectOpen: boolean;

  // CC cube visuals: entityId -> cube mesh
  ccCubes: Map<string, THREE.Mesh>;

  // Dev tools / generative world
  editor: SceneEditor;
  snapshots: SnapshotSystem;
  ecosystem: Ecosystem;
  colliderDebug: ColliderDebug;
  rivers: Rivers;
  wolves: WolfPack;
  mutantPredator: MutantPredator;
  hpBars: HpBarOverlay;
  atmosphere: Atmosphere;
  livingProviders: PreyProvider[];
  entityRegistry: GameEntityRegistry;
  policyDriver: PolicyDriver | null;

  // Phase 4: Network state
  mode: GameMode;
  network: NetworkGame | null;

  // Sustained airborne duration in seconds — used to suppress the jump
  // animation for transient ungrounded frames (e.g. walking down small
  // terrain bumps). Reset to 0 on touch-down.
  airborneTime: number;

  // Auto-attack state: after a melee ability lands, keep swinging at the
  // target on a swing timer while in range. Visual + flashHit only.
  autoAttackTargetId: string | null;
  autoAttackRange: number;
  autoAttackSwingTimer: number;     // seconds until next swing
  autoAttackOORTime: number;        // seconds out of range — cancels after grace
}

// ============================================================================
// Entity Creation
// ============================================================================

function createEntityMesh(def: EntityDef): THREE.Group {
  const group = new THREE.Group();
  group.name = def.id;

  const { radius, height } = def.collider;
  const cylinderHeight = height - radius * 2;

  const bodyGeometry = new THREE.CylinderGeometry(radius, radius, cylinderHeight, 16);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: def.color,
    roughness: 0.7,
    metalness: 0.2
  });
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.position.y = height / 2;
  body.castShadow = true;
  group.add(body);

  const topGeometry = new THREE.SphereGeometry(radius, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const top = new THREE.Mesh(topGeometry, bodyMaterial.clone());
  top.position.y = height - radius;
  top.castShadow = true;
  group.add(top);

  const bottomGeometry = new THREE.SphereGeometry(radius, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const bottom = new THREE.Mesh(bottomGeometry, bodyMaterial.clone());
  bottom.position.y = radius;
  bottom.castShadow = true;
  group.add(bottom);

  const ringGeometry = new THREE.RingGeometry(radius + 0.05, radius + 0.15, 32);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: def.team === 'friendly' ? 0x00ff88 : 0xff4444,
    side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  group.add(ring);

  group.position.set(...def.position);
  group.userData = {
    entityId: def.id,
    entityName: def.name,
    entityTeam: def.team,
    entityClass: def.class
  };

  return group;
}

// ============================================================================
// UI Functions
// ============================================================================

function updateConnectionStatus(state: ConnectionState): void {
  const statusEl = document.getElementById('connection-status');
  if (statusEl) {
    statusEl.textContent = state;
    statusEl.className = `connection-status ${state}`;
  }
}

function updateActionBar(state: GameState): void {
  const abilities = getClassAbilities(state.currentClass);
  const slots = document.querySelectorAll('.action-slot');

  slots.forEach((slot, i) => {
    const ability = abilities[i];
    const nameEl = slot.querySelector('.ability-name') as HTMLElement | null;
    const keyEl = slot.querySelector('.keybind') as HTMLElement | null;

    // Skip slots without proper structure
    if (!nameEl || !keyEl) return;

    // Remove existing cooldown overlay
    const existing = slot.querySelector('.cooldown-overlay');
    if (existing) existing.remove();

    if (ability) {
      nameEl.textContent = ability.name;
      keyEl.textContent = ability.key.toUpperCase();

      const remaining = state.cooldowns.getRemaining(ability.id);
      if (remaining > 0) {
        slot.classList.add('on-cooldown');
        const overlay = document.createElement('div');
        overlay.className = 'cooldown-overlay';
        overlay.textContent = Math.ceil(remaining).toString();
        slot.appendChild(overlay);
      } else {
        slot.classList.remove('on-cooldown');
      }
    } else {
      nameEl.textContent = '';
      keyEl.textContent = '';
    }
  });
}

function updateCastBar(state: GameState): void {
  const castBar = document.getElementById('cast-bar')!;
  const fill = document.getElementById('cast-bar-fill')!;
  const text = document.getElementById('cast-bar-text')!;

  if (state.casts.isCasting) {
    castBar.classList.add('active');
    const info = state.casts.currentCastInfo!;
    const progress = state.casts.castProgress * 100;
    fill.style.width = `${progress}%`;
    text.textContent = info.abilityName;
    state.playerView.startCasting(info.castTime);
  } else {
    castBar.classList.remove('active');
    state.playerView.stopCasting();
  }
}

function updateDebuffDisplay(state: GameState): void {
  const container = document.getElementById('target-debuffs')!;
  container.innerHTML = '';

  const target = state.targeting.currentTarget;
  if (!target) return;

  const debuffs = state.debuffs.getDebuffs(target.id);
  for (const debuff of debuffs) {
    const remaining = Math.ceil((debuff.expiresAt - Date.now()) / 1000);
    const el = document.createElement('div');
    el.className = 'debuff-icon';
    el.textContent = `${debuff.name} (${remaining}s)`;
    container.appendChild(el);
  }
}

// CC debuff IDs that turn entities into cubes
const CC_DEBUFFS = ['blind', 'polymorph'];

function updateCCVisuals(state: GameState): void {
  for (const entity of state.entityRegistry.all()) {
    if (entity.id === 'player') continue; // Player uses CharacterView

    const debuffs = entity.getDebuffs(state.debuffs);
    const hasCC = debuffs.some(d => CC_DEBUFFS.includes(d.id));

    if (hasCC && !state.ccCubes.has(entity.id)) {
      // Entity just got CC'd - create cube and hide original
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({
          color: 0x8844ff,
          roughness: 0.5,
          metalness: 0.3
        })
      );
      cube.position.copy(entity.mesh.position);
      cube.position.y = 1; // Center cube at entity height
      cube.castShadow = true;
      state.scene.add(cube);
      state.ccCubes.set(entity.id, cube);

      // Hide original entity
      entity.mesh.visible = false;
    } else if (!hasCC && state.ccCubes.has(entity.id)) {
      // CC expired - remove cube and show original
      const cube = state.ccCubes.get(entity.id)!;
      state.scene.remove(cube);
      cube.geometry.dispose();
      (cube.material as THREE.Material).dispose();
      state.ccCubes.delete(entity.id);

      // Show original entity
      entity.mesh.visible = true;
    } else if (hasCC && state.ccCubes.has(entity.id)) {
      // Update cube position and rotation
      const cube = state.ccCubes.get(entity.id)!;
      cube.position.copy(entity.mesh.position);
      cube.position.y = 1;
      cube.rotation.y += 0.02;
      cube.rotation.x += 0.01;
    }
  }
}

function syncLivingTargetables(state: GameState): void {
  for (const provider of state.livingProviders) {
    provider.forEachPrey((ref) => {
      ref.mesh.userData.damageSplats = state.damageSplats;
      ref.mesh.userData.livingRef = ref;
      const entity = state.entityRegistry.register(new RefGameEntity(ref));
      state.entities.set(ref.id, ref.mesh);
      state.targeting.registerTargetable(ref.mesh, entity.id, entity.name, entity.team);
    });
  }
}

function targetEntity(state: GameState, entityId: string | null | undefined): GameEntity | null {
  return state.entityRegistry.get(entityId);
}

async function setClass(state: GameState, className: ClassName): Promise<void> {
  state.currentClass = className;
  state.cooldowns.resetAll();
  state.casts.interrupt();

  // Update UI
  document.getElementById('class-name')!.textContent = className;
  updateActionBar(state);

  // Update player color based on class
  const colors: Record<ClassName, number> = {
    Rogue: 0xffff00,
    Mage: 0x69ccf0,
    Priest: 0xffffff
  };

  // Recreate player view with new color
  state.scene.remove(state.playerView.root);
  state.playerView.dispose();
  const useMixamo = new URL(window.location.href).searchParams.get('mixamo') === '1';
  state.playerView = await createCharacterView(useMixamo, colors[className]);
  state.playerView.root.position.copy(state.player.position);
  state.scene.add(state.playerView.root);
  state.player.mesh = state.playerView.root;
  state.entityRegistry.register(new BasicGameEntity({
    id: 'player',
    name: `Player (${className})`,
    team: 'friendly',
    mesh: state.playerView.root,
    hp: 100,
    radius: 0.35,
    splats: state.damageSplats,
    position: state.player.position,
  }));
}

function toggleClassSelector(state: GameState): void {
  state.classSelectOpen = !state.classSelectOpen;
  const selector = document.getElementById('class-selector')!;
  selector.classList.toggle('active', state.classSelectOpen);
}

// ============================================================================
// Ability Execution
// ============================================================================

function tryUseAbility(state: GameState, key: string): void {
  const ability = getAbilityByKey(state.currentClass, key);
  if (!ability) return;

  // In multiplayer mode, send to server
  if (state.mode === 'multiplayer' && state.network) {
    const target = state.targeting.currentTarget;
    state.network.useAbility(ability.id, target?.id || null);
    flashSlotPressed(key);
    return;
  }

  // Standalone mode - local execution
  // Check cooldown
  if (!state.cooldowns.isReady(ability.id)) {
    flashSlotError(key);
    return;
  }

  // Check if already casting
  if (state.casts.isCasting && ability.castTime === 0) {
    // Allow instant casts to interrupt? For now, block
    flashSlotError(key);
    return;
  }

  // Check target requirement
  const target = state.targeting.currentTarget;
  if (ability.requiresTarget && !target) {
    flashSlotError(key);
    return;
  }

  // Check range
  if (ability.requiresTarget && target && ability.range > 0) {
    const dist = state.player.position.distanceTo(target.mesh.position);
    if (dist > ability.range) {
      flashSlotError(key);
      return;
    }
  }

  // Build context
  const ctx: AbilityContext = {
    casterId: 'player',
    casterPos: state.player.position.clone(),
    casterYaw: state.player.facingYaw,
    targetId: target?.id || null,
    targetPos: target ? target.mesh.position.clone() : null,
    cooldowns: state.cooldowns,
    debuffs: state.debuffs,
    casts: state.casts,
    projectiles: state.projectiles,
    getEntityPos: (id) => {
      const ent = targetEntity(state, id);
      return ent ? ent.pos.clone() : null;
    },
    setEntityPos: (id, pos) => {
      if (id === 'player') {
        state.player.position.copy(pos);
        state.player.mesh?.position.copy(pos);
      } else {
        const ent = state.entities.get(id);
        if (ent) ent.position.copy(pos);
      }
    },
    flashHit: (entityId) => {
      flashEntityHit(state, entityId);
    },
    spawnDamage: (entityId, min, max) => {
      spawnDamage(state, entityId, min, max);
    },
    spawnHeal: (entityId, min, max) => {
      spawnHeal(state, entityId, min, max);
    },
    applyDebuff: (entityId, debuff) => {
      const entity = targetEntity(state, entityId);
      if (entity) entity.applyDebuff(state.debuffs, debuff);
    }
  };

  // Execute
  flashSlotPressed(key);

  // Trigger ability animation — pass ability.id so Mixamo view can pick the right clip
  if (ability.castTime === 0) {
    if (ability.id === 'rogue_hemorrhage') {
      // Layered upper-body swing so the run anim keeps playing on the legs.
      state.playerView.triggerUpperBodyAttack?.(0.45);
    } else {
      state.playerView.triggerOneShot(ability.id);
    }
  }

  // Hemorrhage starts (or refreshes) auto-attack on the target.
  if (ability.id === 'rogue_hemorrhage' && target) {
    state.autoAttackTargetId = target.id;
    state.autoAttackRange = ability.range;
    state.autoAttackSwingTimer = 1.5;  // first auto-swing 1.5s after the manual hit
    state.autoAttackOORTime = 0;
  }

  ability.execute(ctx);
}

function flashSlotPressed(key: string): void {
  const slot = document.querySelector(`.action-slot[data-key="${key}"]`);
  if (slot) {
    slot.classList.add('pressed');
    setTimeout(() => slot.classList.remove('pressed'), 100);
  }
}

function flashSlotError(key: string): void {
  const slot = document.querySelector(`.action-slot[data-key="${key}"]`);
  if (slot) {
    slot.classList.add('pressed');
    (slot as HTMLElement).style.borderColor = '#f00';
    setTimeout(() => {
      slot.classList.remove('pressed');
      (slot as HTMLElement).style.borderColor = '';
    }, 150);
  }
}

/**
 * Auto-attack: while a melee target is set and within range, play a layered
 * upper-body swing on the swing timer. Cancels if the target despawns or
 * the player stays out of range past the grace window.
 */
function updateAutoAttack(state: GameState, delta: number): void {
  if (!state.autoAttackTargetId) return;

  const target = targetEntity(state, state.autoAttackTargetId);
  if (!target?.alive) {
    state.autoAttackTargetId = null;
    return;
  }

  const dist = state.player.position.distanceTo(target.pos);
  // Small leeway on top of the ability range so jitter at the edge doesn't bounce.
  const inRange = dist <= state.autoAttackRange + 0.5;

  if (inRange) {
    state.autoAttackOORTime = 0;
    state.autoAttackSwingTimer -= delta;
    if (state.autoAttackSwingTimer <= 0) {
      state.playerView.triggerUpperBodyAttack?.(0.45);
      flashEntityHit(state, state.autoAttackTargetId);
      spawnDamage(state, state.autoAttackTargetId, 8, 16);
      state.autoAttackSwingTimer = 1.5;
    }
  } else {
    state.autoAttackOORTime += delta;
    if (state.autoAttackOORTime > 3) {
      state.autoAttackTargetId = null;
    }
  }
}

function spawnDamage(state: GameState, entityId: string, min: number, max: number): void {
  const entity = targetEntity(state, entityId);
  if (!entity) return;
  const amount = Math.floor(min + Math.random() * (max - min + 1));
  entity.damage(amount, targetEntity(state, 'player') ?? undefined);
}

function spawnHeal(state: GameState, entityId: string, min: number, max: number): void {
  const entity = targetEntity(state, entityId);
  if (!entity) return;
  const amount = Math.floor(min + Math.random() * (max - min + 1));
  entity.heal(amount);
}

function togglePickup(state: GameState): void {
  if (state.heldAnimal) {
    releaseHeld(state);
  } else {
    tryPickup(state);
  }
}

function tryPickup(state: GameState): void {
  const playerPos = state.player.position;
  const PICKUP_RANGE = 2.5;

  // Check both providers, pick the closer one
  const candidates: Holdable[] = [];
  const dog = state.dogs.findNearestHoldable(playerPos, PICKUP_RANGE);
  if (dog) candidates.push(dog);
  const rabbit = state.rabbits.findNearestHoldable(playerPos, PICKUP_RANGE);
  if (rabbit) candidates.push(rabbit);
  const cat = state.cats.findNearestHoldable(playerPos, PICKUP_RANGE);
  if (cat) candidates.push(cat);
  const cow = state.cows.findNearestHoldable(playerPos, PICKUP_RANGE);
  if (cow) candidates.push(cow);
  if (!candidates.length) return;

  let nearest = candidates[0];
  let nearestSq = nearest.mesh.position.distanceToSquared(playerPos);
  for (let i = 1; i < candidates.length; i++) {
    const d = candidates[i].mesh.position.distanceToSquared(playerPos);
    if (d < nearestSq) { nearest = candidates[i]; nearestSq = d; }
  }

  nearest.pickUp();
  // Reparent to carry slot — Object3D.add() removes from current parent.
  state.carrySlot.add(nearest.mesh);
  // Animal sits cradled in front of the chest, slightly tilted up so its
  // head faces the camera. Slot is in player-local space (front = -Z after
  // rotating by player yaw), so push it forward in -Z and lift it.
  nearest.mesh.position.set(0, 0.0, -0.4);
  nearest.mesh.rotation.set(-0.25, 0, 0);
  state.heldAnimal = nearest;
}

function updateCarrySlot(state: GameState): void {
  // Place slot at chest height, oriented to face same way as player.
  state.carrySlot.position.set(
    state.player.position.x,
    state.player.position.y + 1.1,
    state.player.position.z
  );
  state.carrySlot.rotation.y = state.player.facingYaw;
}

function releaseHeld(state: GameState): void {
  const held = state.heldAnimal;
  if (!held) return;

  // Drop it just in front of the player.
  const forward = new THREE.Vector3(
    -Math.sin(state.player.facingYaw),
    0,
    -Math.cos(state.player.facingYaw)
  );
  const dropPos = state.player.position.clone().add(forward.multiplyScalar(1.0));

  // Reparent back to the scene root (same parent the pack groups live in).
  state.scene.add(held.mesh);
  held.mesh.position.set(dropPos.x, 0, dropPos.z);
  held.mesh.rotation.set(0, state.player.facingYaw, 0);

  held.releaseAt(dropPos, state.player.facingYaw);
  state.heldAnimal = null;
}

function flashEntityHit(state: GameState, entityId: string): void {
  const entity = state.entities.get(entityId);
  if (!entity) return;

  entity.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) {
      const mat = child.material as THREE.MeshStandardMaterial;
      // Only flash if material has emissive property
      if (mat.emissive) {
        const origEmissive = mat.emissive.clone();
        const origIntensity = mat.emissiveIntensity || 0;
        mat.emissive.set(0xffffff);
        mat.emissiveIntensity = 0.5;
        setTimeout(() => {
          mat.emissive.copy(origEmissive);
          mat.emissiveIntensity = origIntensity;
        }, 100);
      }
    }
  });
}

// ============================================================================
// Input Handling
// ============================================================================

function setupInput(state: GameState): void {
  window.addEventListener('keydown', (e) => {
    // Tab for class selector
    if (e.code === 'Tab') {
      e.preventDefault();
      toggleClassSelector(state);
      return;
    }

    // Block gameplay input while class selector open
    if (state.classSelectOpen) return;

    // Ability keys
    const key = e.key.toLowerCase();
    if (['1', '2', '3', 'q', 'e', 'r', 'f', 'g'].includes(key)) {
      tryUseAbility(state, key);
    }
    if (key === 'c') {
      togglePickup(state);
    }
  });

  // Class selection buttons
  document.querySelectorAll('.class-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const className = btn.getAttribute('data-class') as ClassName;
      setClass(state, className);
      toggleClassSelector(state);
    });
  });
}

// ============================================================================
// Initialization
// ============================================================================

async function init(): Promise<GameState> {
  // Detect game mode
  const { mode, config } = getModeFromUrl();
  console.log(`[Game] Starting in ${mode} mode`);
  if (mode === 'multiplayer') {
    console.log(`[Game] Server URL: ${config.serverUrl}`);
  }

  const scene = new THREE.Scene();
  // Warm Nagrand-like horizon haze; sky shader paints the actual dome.
  scene.background = new THREE.Color(0x6b8db5);
  scene.fog = new THREE.Fog(0x9bb6c9, 45, 110);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  if (!renderer.getContext()) {
    console.error('[Game] WebGL context failed!');
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // WoW-style: warmer exposure + AgX-like filmic curve via ACES, plus a
  // saturation lift through outputColorSpace (sRGB).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const cameraRig = new CameraRig();
  cameraRig.attach(renderer.domElement);

  const arena = createArena();
  scene.add(arena);

  // Generative ecosystem — grass blades (shader-driven, wind-swayed), plus
  // flowers, rocks, mushrooms, huts. Pickable in the SceneEditor; both the
  // Ecosystem group and its GrassField child expose editableParams so
  // seed/biome/density/wind/colors can be tweaked live.
  const terrainData = getTerrainHeightData();
  const ecosystem = new Ecosystem(
    terrainData,
    (x, z) => getTerrainHeight(x, z, terrainData),
  );
  scene.add(ecosystem);

  // Generative rivers — winding water ribbons crossing the terrain.
  const rivers = new Rivers((x, z) => getTerrainHeight(x, z, terrainData));
  scene.add(rivers);

  // A single procedural tree placed on the map as a tweakable showcase —
  // pickable in the SceneEditor with full param schema (seed, trunk height,
  // canopy scale, leaf puff, bend).
  const showcaseTree = new ProceduralTree({ seed: 42 });
  showcaseTree.position.set(6, getTerrainHeight(6, -7, terrainData), -7);
  showcaseTree.scale.setScalar(1.4);
  scene.add(showcaseTree);

  // Sprinkle a handful more procedural trees around the edges so the
  // procedural pipeline coexists with the GLB forest. Each gets a different
  // seed so silhouettes vary.
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.5;
    const r = 22 + (i % 2) * 4;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const t = new ProceduralTree({ seed: 100 + i * 7 });
    t.position.set(x, getTerrainHeight(x, z, terrainData), z);
    t.scale.setScalar(1.1 + (i % 3) * 0.2);
    scene.add(t);
  }

  const sky = new SkyEnvironment();
  scene.add(sky);

  const axisGizmo = createAxisGizmo(2);
  axisGizmo.position.set(0, 0.01, 0);
  scene.add(axisGizmo);

  const entities = new Map<string, THREE.Object3D>();

  // In standalone mode, create all entities
  // In multiplayer mode, only create player initially (others come from server)
  if (mode === 'standalone') {
    for (const def of INITIAL_ENTITIES) {
      if (def.id !== 'player') {
        const mesh = createEntityMesh(def);
        mesh.position.y = getTerrainHeight(mesh.position.x, mesh.position.z, terrainData);
        scene.add(mesh);
        entities.set(def.id, mesh);
      }
    }
  }

  const playerDef = INITIAL_ENTITIES.find(e => e.id === 'player')!;
  const useMixamo = new URL(window.location.href).searchParams.get('mixamo') === '1';
  const playerView = await createCharacterView(useMixamo, playerDef.color);
  playerView.root.position.set(...playerDef.position);
  playerView.root.position.y = getTerrainHeight(playerView.root.position.x, playerView.root.position.z, terrainData);
  scene.add(playerView.root);
  entities.set('player', playerView.root);

  const player = new PlayerController(
    playerView.root.position.clone()
  );
  player.mesh = playerView.root;
  // Combine static arena colliders with the ecosystem's dynamic ones (huts +
  // sizeable rocks). Re-applied whenever the ecosystem regenerates.
  const allColliders = () => [...getColliders(), ...ecosystem.getColliders()];
  let liveState: GameState | null = null;
  const refreshColliders = () => {
    const colliders = allColliders();
    player.setColliders(colliders);
    liveState?.dogs?.setColliders(colliders);
    liveState?.rabbits?.setColliders(colliders);
    liveState?.cats?.setColliders(colliders);
    liveState?.cows?.setColliders(colliders);
    liveState?.wolves?.setColliders(colliders);
    liveState?.mutantPredator?.setColliders(colliders);
  };
  refreshColliders();
  player.setTerrainHeightData(getTerrainHeightData());

  // Only attach local input in standalone mode
  // In multiplayer, NetworkGame handles input
  if (mode === 'standalone') {
    player.attach();
  }

  const targeting = new TargetingSystem(cameraRig.camera, scene);
  targeting.attach(renderer.domElement);

  const debugElement = document.getElementById('debug-info');

  window.addEventListener('resize', () => {
    cameraRig.resize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    state.atmosphere?.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();

  // Phase 3 systems
  const cooldowns = new CooldownManager();
  const debuffs = new DebuffManager();
  const casts = new CastSystem();
  const projectiles = new ProjectileSystem(scene);
  const damageSplats = new DamageSplatSystem(scene);
  const entityRegistry = new GameEntityRegistry();

  // Create network game if in multiplayer mode
  let network: NetworkGame | null = null;
  if (mode === 'multiplayer') {
    network = new NetworkGame(
      {
        serverUrl: config.serverUrl,
        onConnectionChange: (state) => {
          console.log(`[Game] Connection state: ${state}`);
          updateConnectionStatus(state);
        },
        onWelcome: (welcome) => {
          console.log(`[Game] Welcome! Player ID: ${welcome.playerId}`);
          // Initialize prediction with current position
          network!.initializeLocalPlayer(
            { x: playerDef.position[0], y: playerDef.position[1], z: playerDef.position[2] },
            cameraRig.yaw
          );
        },
        onEvents: (events) => {
          console.log(`[Game] Received ${events.length} events`);
          // TODO: Handle events (Phase 4.12)
        },
      },
      () => cameraRig.yaw
    );

    // Start connection
    network.connect();
  }

  const state: GameState = {
    scene,
    renderer,
    cameraRig,
    sky,
    player,
    playerView,
    targeting,
    entities,
    clock,
    debugElement,
    currentClass: 'Rogue',
    cooldowns,
    debuffs,
    casts,
    projectiles,
    damageSplats,
    dogs: new DogPack(scene, 6, 18, getTerrainHeightData()),
    rabbits: new RabbitWarren(scene, 14, 18, getTerrainHeightData()),
    cats: new CatColony(scene, 5, 18, getTerrainHeightData()),
    cows: new CowHerd(scene, 4, 18, getTerrainHeightData()),
    carrySlot: (() => {
      const slot = new THREE.Group();
      slot.name = 'CarrySlot';
      // Top-level scene group; tracked to player each frame to avoid FBX
      // scale issues (Mixamo character root is scaled 0.01).
      scene.add(slot);
      return slot;
    })(),
    heldAnimal: null,
    classSelectOpen: false,
    ccCubes: new Map(),
    mode,
    network,
    airborneTime: 0,
    autoAttackTargetId: null,
    autoAttackRange: 0,
    autoAttackSwingTimer: 0,
    autoAttackOORTime: 0,
    editor: undefined as unknown as SceneEditor,
    snapshots: undefined as unknown as SnapshotSystem,
    ecosystem,
    colliderDebug: undefined as unknown as ColliderDebug,
    rivers,
    wolves: undefined as unknown as WolfPack,
    mutantPredator: undefined as unknown as MutantPredator,
    hpBars: undefined as unknown as HpBarOverlay,
    atmosphere: undefined as unknown as Atmosphere,
    livingProviders: [],
    entityRegistry,
    policyDriver: null,
  };
  liveState = state;

  entityRegistry.register(new BasicGameEntity({
    id: 'player',
    name: playerDef.name,
    team: playerDef.team,
    mesh: playerView.root,
    hp: 100,
    radius: playerDef.collider.radius,
    splats: damageSplats,
    position: player.position,
  }));

  if (mode === 'standalone') {
    for (const [id, mesh] of entities) {
      if (id === 'player') continue;
      const def = INITIAL_ENTITIES.find(e => e.id === id)!;
      const entity = entityRegistry.register(new BasicGameEntity({
        id,
        name: def.name,
        team: def.team,
        mesh,
        hp: 100,
        radius: def.collider.radius,
        splats: damageSplats,
      }));
      targeting.registerTargetable(mesh, entity.id, entity.name, entity.team);
    }
  }

  // Dev tools: editor (`), snapshots (F2/F3), collider debug (F4)
  state.editor = new SceneEditor(scene, cameraRig.camera, renderer.domElement);
  state.snapshots = new SnapshotSystem({
    renderer,
    scene,
    camera: cameraRig.camera,
    rig: cameraRig,
    player,
  });
  state.colliderDebug = new ColliderDebug({
    scene,
    getColliders: allColliders,
  });

  // Push fresh colliders to the player whenever the ecosystem regenerates,
  // so editor tweaks (seed, biome, density) keep collision in sync.
  const origSet = ecosystem.userData.editableParams.set;
  ecosystem.userData.editableParams.set = (next: Record<string, unknown>) => {
    origSet(next);
    refreshColliders();
  };

  // Wolf pack — den at one corner of the map, wolves hunt rabbits with the
  // shared DamageSplatSystem providing combat feedback (same pattern as
  // player abilities).
  state.wolves = new WolfPack(
    scene,
    5,
    18,
    terrainData,
    [state.dogs, state.rabbits, state.cats, state.cows],
    new THREE.Vector3(-14, 0, -14),
  );
  state.mutantPredator = await MutantPredator.create(
    scene,
    18,
    terrainData,
    [state.dogs, state.rabbits, state.cats, state.cows],
    new THREE.Vector3(14, 0, -14),
  );
  // Werewolf needs a live player reference so it can aggro on proximity
  // and on hit (boss never ignores a human swinging a sword at it).
  state.mutantPredator.setPlayerProvider(() => {
    const playerEntity = state.entityRegistry.get('player');
    if (!playerEntity || !playerEntity.alive) return null;
    return {
      id: playerEntity.id,
      pos: playerEntity.pos,
      alive: playerEntity.alive,
      hp: playerEntity.hp,
      maxHp: playerEntity.maxHp,
      radius: playerEntity.radius,
      damage: (amount: number, attacker?: any) => playerEntity.damage(amount, attacker),
      heal: (amount: number) => playerEntity.heal(amount),
    } as any;
  });
  state.livingProviders = [state.dogs, state.rabbits, state.cats, state.cows, state.wolves, state.mutantPredator];
  for (const provider of state.livingProviders) {
    provider.forEachPrey((ref) => { ref.mesh.userData.damageSplats = state.damageSplats; });
  }
  refreshColliders();
  syncLivingTargetables(state);

  // Floating HP bars over any wounded registered entity.
  state.hpBars = new HpBarOverlay(scene, () => state.entityRegistry.all());

  // Atmosphere & post-processing — bloom, painterly color grade, vignette,
  // ambient motes. Last in init so it wraps the full live scene.
  state.atmosphere = new Atmosphere(renderer, scene, cameraRig.camera);

  setupInput(state);
  updateActionBar(state);

  // Trained RL policies drive the high-level intentions for every animal
  // when available. The hand-written state machines remain the algorithmic
  // Tier-2 engine; the brain only picks Attack/Flee/Idle/Heal every ~0.5s.
  // Disable with `?policy=0` in the URL.
  const useBrain = new URLSearchParams(location.search).get('policy') !== '0';
  if (useBrain) {
    const baseUrl = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    const base = `${baseUrl.replace(/\/$/, '')}/policies`;
    const registry = await loadPolicyRegistry(base);
    if (registry) {
      state.policyDriver = new PolicyDriver(registry);
      state.policyDriver.setAgents(collectPolicyAgents(state));
      state.editor.setPolicyDriver(state.policyDriver);
      console.log('[rl] trained per-archetype policies driving wolves, rabbits, cats, dogs, cows, werewolf');
    } else {
      console.log('[rl] no trained policies found at', base, '— using built-in AI. Run `npm run train`.');
    }
  }

  return state;
}

function collectPolicyAgents(state: GameState) {
  return [
    ...state.wolves.getPolicyAgents(),
    ...state.rabbits.getPolicyAgents(),
    ...state.cats.getPolicyAgents(),
    ...state.dogs.getPolicyAgents(),
    ...state.cows.getPolicyAgents(),
    ...state.mutantPredator.getPolicyAgents(),
  ];
}

// ============================================================================
// Grass collision — feed player + nearest animals to the grass shader so
// blades bend underfoot and snap back when actors leave.
// ============================================================================

const _grassActorScratch: Array<{ pos: THREE.Vector3; radius: number; d2: number }> = [];

function updateGrassActors(state: GameState): void {
  _grassActorScratch.length = 0;

  // Player always gets a slot (radius ~ player capsule + a bit).
  _grassActorScratch.push({ pos: state.player.position.clone(), radius: 1.1, d2: 0 });

  // Collect candidate animal positions by walking the named pack groups.
  const playerPos = state.player.position;
  const packs = ['DogPack', 'RabbitWarren', 'CatColony', 'CowHerd', 'WolfPack'];
  const tmp = new THREE.Vector3();
  for (const name of packs) {
    const pack = state.scene.getObjectByName(name);
    if (!pack) continue;
    for (const child of pack.children) {
      child.getWorldPosition(tmp);
      const dx = tmp.x - playerPos.x;
      const dz = tmp.z - playerPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 18 * 18) continue; // skip far animals — they won't be in the visible grass anyway
      // Smaller radius for animals than the player.
      _grassActorScratch.push({ pos: tmp.clone(), radius: 0.75, d2 });
    }
  }

  // Keep the closest 8 actors total (the shader's MAX_ACTORS).
  _grassActorScratch.sort((a, b) => a.d2 - b.d2);
  state.ecosystem.grass.setActors(_grassActorScratch.slice(0, 8));
}

// ============================================================================
// Game Loop
// ============================================================================

function animate(state: GameState): void {
  requestAnimationFrame(() => animate(state));

  const delta = state.clock.getDelta();

  if (state.mode === 'multiplayer' && state.network) {
    // Multiplayer mode - use network state
    animateMultiplayer(state, delta);
  } else {
    // Standalone mode - use local state
    animateStandalone(state, delta);
  }

  // Render through the post-processing chain (bloom, color grade, vignette,
  // ambient motes). Atmosphere is created last in init() so it always exists
  // by the first animate() tick.
  state.atmosphere.render(delta);
}

function animateStandalone(state: GameState, delta: number): void {
  // Cancel cast on movement
  if (state.casts.isCasting) {
    const vel = state.player.velocity;
    const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    if (speed > 0.5) {
      state.casts.interrupt();
    }
  }

  // RMB drag rotates the character; LMB-only orbits the camera independently.
  state.player.facingYaw += state.cameraRig.consumePlayerYawDelta();
  // Both buttons held = walk forward (WoW mouse-walk).
  state.player.update(delta, state.cameraRig.bothHeld);

  // Update player character view
  const vel = state.player.velocity;
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const isGrounded = state.player.isGrounded;

  if (isGrounded) state.airborneTime = 0;
  else             state.airborneTime += delta;
  // Treat as airborne for animation only if intentionally jumping (positive
  // vertical velocity) or sustained airtime — terrain microbumps stay grounded.
  const showAir = !isGrounded && (vel.y > 0.5 || state.airborneTime > 0.12);

  let locoState: LocomotionState = 'idle';
  if (showAir) {
    locoState = vel.y > 0 ? 'jump' : 'fall';
  } else if (speed > 4) {
    locoState = 'run';
  } else if (speed > 0.1) {
    locoState = 'walk';
  }

  // Movement direction in character-local space: rotate world velocity by
  // -facingYaw around Y so the view can pick forward / back / strafe variants.
  const cosF = Math.cos(state.player.facingYaw);
  const sinF = Math.sin(state.player.facingYaw);
  const moveLocal = new THREE.Vector3(
    vel.x * cosF - vel.z * sinF,
    0,
    vel.x * sinF + vel.z * cosF
  );
  state.playerView.setLocomotion(locoState, speed / 6, moveLocal);
  if (showAir) state.playerView.setAirborne?.(vel.y, JUMP_FORCE);

  // Character always faces its own yaw, never the movement direction.
  // Negation aligns the player's CCW yaw with the existing setFacingYaw
  // convention (which itself negates and adds π for the Mixamo rig).
  state.playerView.setFacingYaw(-state.player.facingYaw);

  state.playerView.update(delta);

  // Update camera
  state.cameraRig.update(state.player.position);
  state.sky.update(delta, state.player.position, state.cameraRig.camera, state.scene);

  // Update targeting
  state.targeting.update(state.player.position);

  // Update systems
  state.debuffs.update();
  state.casts.update();
  state.projectiles.update(delta);
  state.damageSplats.update(delta);
  state.dogs.update(delta);
  state.rabbits.update(delta);
  state.cats.update(delta);
  state.cows.update(delta);
  updateCarrySlot(state);
  updateAutoAttack(state, delta);
  state.editor.update();
  state.ecosystem.update(state.clock.elapsedTime);
  state.rivers.update(state.clock.elapsedTime);
  state.wolves.update(delta);
  state.mutantPredator.update(delta);
  if (state.policyDriver) {
    state.policyDriver.setAgents(collectPolicyAgents(state));
    state.policyDriver.update(delta);
  }
  syncLivingTargetables(state);
  state.hpBars.update();
  state.colliderDebug.update();
  updateGrassActors(state);

  // Update UI
  updateActionBar(state);
  updateCastBar(state);
  updateDebuffDisplay(state);
  updateCCVisuals(state);

  // Debug info
  if (state.debugElement) {
    state.debugElement.textContent = `${state.currentClass} | ${state.player.getDebugInfo()}`;
  }
}

function animateMultiplayer(state: GameState, delta: number): void {
  const network = state.network!;

  // Update network and get local player state
  const localState = network.update(delta);

  if (localState) {
    // Update player position from prediction
    state.player.position.set(localState.pos.x, localState.pos.y, localState.pos.z);
    state.playerView.root.position.copy(state.player.position);

    // Update player character view based on velocity
    const speed = Math.sqrt(localState.vel.x ** 2 + localState.vel.z ** 2);

    if (localState.isGrounded) state.airborneTime = 0;
    else                       state.airborneTime += delta;
    const showAir = !localState.isGrounded && (localState.vel.y > 0.5 || state.airborneTime > 0.12);

    let locoState: LocomotionState = 'idle';
    if (showAir) {
      locoState = localState.vel.y > 0 ? 'jump' : 'fall';
    } else if (speed > 4) {
      locoState = 'run';
    } else if (speed > 0.1) {
      locoState = 'walk';
    }

    state.playerView.setLocomotion(locoState, speed / 6);
    if (showAir) state.playerView.setAirborne?.(localState.vel.y, JUMP_FORCE);

    // Multiplayer path: server doesn't ship facing yaw, infer from velocity
    // for now. (Local prediction's facing should be authoritative — wire
    // through state.player.facingYaw when the protocol carries it.)
    if (speed > 0.1) {
      const moveYaw = Math.atan2(localState.vel.x, localState.vel.z);
      state.playerView.setFacingYaw(-moveYaw);
    }
  }

  state.playerView.update(delta);

  // Update camera
  state.cameraRig.update(state.player.position);
  state.sky.update(delta, state.player.position, state.cameraRig.camera, state.scene);

  // Update targeting
  state.targeting.update(state.player.position);

  state.damageSplats.update(delta);
  state.dogs.update(delta);
  state.rabbits.update(delta);
  state.cats.update(delta);
  state.cows.update(delta);
  updateCarrySlot(state);
  state.editor.update();
  state.ecosystem.update(state.clock.elapsedTime);
  state.rivers.update(state.clock.elapsedTime);
  state.wolves.update(delta);
  state.mutantPredator.update(delta);
  if (state.policyDriver) {
    state.policyDriver.setAgents(collectPolicyAgents(state));
    state.policyDriver.update(delta);
  }
  syncLivingTargetables(state);
  state.hpBars.update();
  state.colliderDebug.update();
  updateGrassActors(state);

  // Update remote entities from network state
  const remoteEntities = network.getRemoteEntities();
  for (const remote of remoteEntities) {
    let mesh = state.entities.get(remote.id);

    if (!mesh) {
      // Create new entity mesh
      console.log(`[Game] Creating mesh for remote entity: ${remote.id}`);
      const group = new THREE.Group();
      group.name = remote.id;

      // Simple capsule for now
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, 1.3, 16),
        new THREE.MeshStandardMaterial({
          color: remote.team === 'friendly' ? 0x00ff88 : 0xff4444,
          roughness: 0.7
        })
      );
      body.position.y = 1;
      body.castShadow = true;
      group.add(body);

      state.scene.add(group);
      state.entities.set(remote.id, group);
      state.targeting.registerTargetable(group, remote.id, remote.name, remote.team as 'friendly' | 'enemy');
      mesh = group;
    }

    // Update position and rotation
    mesh.position.set(remote.pos.x, remote.pos.y, remote.pos.z);
    mesh.rotation.y = -remote.yaw;

    // Hide if dead
    mesh.visible = remote.alive;
  }

  // Update UI
  updateActionBar(state);

  // Debug info
  if (state.debugElement) {
    const connState = network.getConnectionState();
    const rtt = network.getRTT();
    state.debugElement.textContent = `${state.currentClass} | ${connState} | RTT: ${rtt.toFixed(0)}ms | ${network.getDebugInfo()}`;
  }
}

// ============================================================================
// Start
// ============================================================================

init().then((gameState) => {
  // Expose for headless screenshot tools and the in-browser console.
  (window as unknown as { __game: unknown }).__game = gameState;
  animate(gameState);
  console.log('WoW Arena Sandbox - Phase 4');
  console.log('Controls:');
  console.log('  WASD: Move | Space: Jump');
  console.log('  Tab: Class Selection');
  console.log('  1-3: Abilities | Click: Target');
  console.log('');
  console.log('URL params:');
  console.log('  ?mode=standalone  - Local only (default)');
  console.log('  ?mode=multiplayer - Connect to server');
  console.log('  ?server=ws://localhost:8080 - Custom server');
  console.log('  ?mixamo=1 - Load Mixamo character (place at public/models/character.glb)');
}).catch(err => {
  console.error('Failed to initialize game:', err);
});
