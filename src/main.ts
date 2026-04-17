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
import { createAxisGizmo, dirToYaw } from './coords';
import { createArena, createArenaLighting, getColliders } from './arena';
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
  classSelectOpen: boolean;

  // CC cube visuals: entityId -> cube mesh
  ccCubes: Map<string, THREE.Mesh>;

  // Phase 4: Network state
  mode: GameMode;
  network: NetworkGame | null;
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
    state.playerView.startCasting();
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
  // Check each entity for CC debuffs
  for (const [entityId, entityMesh] of state.entities) {
    if (entityId === 'player') continue; // Player uses CharacterView

    const debuffs = state.debuffs.getDebuffs(entityId);
    const hasCC = debuffs.some(d => CC_DEBUFFS.includes(d.id));

    if (hasCC && !state.ccCubes.has(entityId)) {
      // Entity just got CC'd - create cube and hide original
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({
          color: 0x8844ff,
          roughness: 0.5,
          metalness: 0.3
        })
      );
      cube.position.copy(entityMesh.position);
      cube.position.y = 1; // Center cube at entity height
      cube.castShadow = true;
      state.scene.add(cube);
      state.ccCubes.set(entityId, cube);

      // Hide original entity
      entityMesh.visible = false;
    } else if (!hasCC && state.ccCubes.has(entityId)) {
      // CC expired - remove cube and show original
      const cube = state.ccCubes.get(entityId)!;
      state.scene.remove(cube);
      cube.geometry.dispose();
      (cube.material as THREE.Material).dispose();
      state.ccCubes.delete(entityId);

      // Show original entity
      entityMesh.visible = true;
    } else if (hasCC && state.ccCubes.has(entityId)) {
      // Update cube position and rotation
      const cube = state.ccCubes.get(entityId)!;
      cube.position.copy(entityMesh.position);
      cube.position.y = 1;
      cube.rotation.y += 0.02;
      cube.rotation.x += 0.01;
    }
  }
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
    casterYaw: state.cameraRig.yaw,
    targetId: target?.id || null,
    targetPos: target ? target.mesh.position.clone() : null,
    cooldowns: state.cooldowns,
    debuffs: state.debuffs,
    casts: state.casts,
    projectiles: state.projectiles,
    getEntityPos: (id) => {
      const ent = state.entities.get(id);
      return ent ? ent.position.clone() : null;
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
    }
  };

  // Execute
  flashSlotPressed(key);

  // Trigger arm animation for instant abilities
  if (ability.castTime === 0) {
    state.playerView.triggerOneShot('attack');
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
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.Fog(0x1a1a2e, 30, 60);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  if (!renderer.getContext()) {
    console.error('[Game] WebGL context failed!');
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.appendChild(renderer.domElement);

  const cameraRig = new CameraRig();
  cameraRig.attach(renderer.domElement);

  const arena = createArena();
  scene.add(arena);

  const lighting = createArenaLighting();
  scene.add(lighting);

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
        scene.add(mesh);
        entities.set(def.id, mesh);
      }
    }
  }

  const playerDef = INITIAL_ENTITIES.find(e => e.id === 'player')!;
  const useMixamo = new URL(window.location.href).searchParams.get('mixamo') === '1';
  const playerView = await createCharacterView(useMixamo, playerDef.color);
  playerView.root.position.set(...playerDef.position);
  scene.add(playerView.root);
  entities.set('player', playerView.root);

  const player = new PlayerController(
    new THREE.Vector3(...playerDef.position)
  );
  player.mesh = playerView.root;
  player.setColliders(getColliders());

  // Only attach local input in standalone mode
  // In multiplayer, NetworkGame handles input
  if (mode === 'standalone') {
    player.attach();
  }

  const targeting = new TargetingSystem(cameraRig.camera);
  targeting.attach(renderer.domElement);

  if (mode === 'standalone') {
    for (const [id, mesh] of entities) {
      if (id !== 'player') {
        const def = INITIAL_ENTITIES.find(e => e.id === id)!;
        targeting.registerTargetable(mesh, id, def.name, def.team);
      }
    }
  }

  const debugElement = document.getElementById('debug-info');

  window.addEventListener('resize', () => {
    cameraRig.resize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();

  // Phase 3 systems
  const cooldowns = new CooldownManager();
  const debuffs = new DebuffManager();
  const casts = new CastSystem();
  const projectiles = new ProjectileSystem(scene);

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
    classSelectOpen: false,
    ccCubes: new Map(),
    mode,
    network
  };

  setupInput(state);
  updateActionBar(state);

  return state;
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

  // Render
  state.renderer.render(state.scene, state.cameraRig.camera);
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

  // Update player
  state.player.update(delta, state.cameraRig.yaw);

  // Update player character view
  const vel = state.player.velocity;
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const isGrounded = state.player.position.y <= 0.01;

  let locoState: LocomotionState = 'idle';
  if (!isGrounded) {
    locoState = vel.y > 0 ? 'jump' : 'fall';
  } else if (speed > 4) {
    locoState = 'run';
  } else if (speed > 0.1) {
    locoState = 'walk';
  }

  state.playerView.setLocomotion(locoState, speed / 6);

  if (speed > 0.1) {
    const moveYaw = dirToYaw(new THREE.Vector3(vel.x, 0, vel.z));
    state.playerView.setFacingYaw(-moveYaw);
  }

  state.playerView.update(delta);

  // Update camera
  state.cameraRig.update(state.player.position);

  // Update targeting
  state.targeting.update(state.player.position);

  // Update systems
  state.debuffs.update();
  state.casts.update();
  state.projectiles.update(delta);

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

    let locoState: LocomotionState = 'idle';
    if (!localState.isGrounded) {
      locoState = localState.vel.y > 0 ? 'jump' : 'fall';
    } else if (speed > 4) {
      locoState = 'run';
    } else if (speed > 0.1) {
      locoState = 'walk';
    }

    state.playerView.setLocomotion(locoState, speed / 6);

    if (speed > 0.1) {
      const moveYaw = Math.atan2(localState.vel.x, localState.vel.z);
      state.playerView.setFacingYaw(-moveYaw);
    }
  }

  state.playerView.update(delta);

  // Update camera
  state.cameraRig.update(state.player.position);

  // Update targeting
  state.targeting.update(state.player.position);

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
