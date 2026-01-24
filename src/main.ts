/**
 * WoW Arena Sandbox - Phase 1 MVP
 *
 * A spatial toybox with:
 * - Strict coordinate system (+Y up, +X right, -Z forward)
 * - Nagrand-style arena blockout
 * - Third-person camera with orbit controls
 * - Click-to-target system
 */

import * as THREE from 'three';
import { createAxisGizmo, dirToYaw } from './coords';
import { createArena, createArenaLighting, getColliders } from './arena';
import { CameraRig } from './camera';
import { PlayerController } from './player';
import { TargetingSystem } from './targeting';
import { INITIAL_ENTITIES, EntityDef } from './entities';
import { ProceduralCharacterView, CharacterView, LocomotionState } from './character';

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
}

// ============================================================================
// Entity Creation
// ============================================================================

function createEntityMesh(def: EntityDef): THREE.Group {
  const group = new THREE.Group();
  group.name = def.id;

  // Create capsule-like shape (cylinder + hemispheres)
  const { radius, height } = def.collider;
  const cylinderHeight = height - radius * 2;

  // Main body (cylinder)
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

  // Top sphere
  const topGeometry = new THREE.SphereGeometry(radius, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const topMaterial = new THREE.MeshStandardMaterial({
    color: def.color,
    roughness: 0.7,
    metalness: 0.2
  });
  const top = new THREE.Mesh(topGeometry, topMaterial);
  top.position.y = height - radius;
  top.castShadow = true;
  group.add(top);

  // Bottom sphere
  const bottomGeometry = new THREE.SphereGeometry(radius, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const bottomMaterial = new THREE.MeshStandardMaterial({
    color: def.color,
    roughness: 0.7,
    metalness: 0.2
  });
  const bottom = new THREE.Mesh(bottomGeometry, bottomMaterial);
  bottom.position.y = radius;
  bottom.castShadow = true;
  group.add(bottom);

  // Team indicator ring at feet
  const ringGeometry = new THREE.RingGeometry(radius + 0.05, radius + 0.15, 32);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: def.team === 'friendly' ? 0x00ff88 : 0xff4444,
    side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  group.add(ring);

  // Set position
  group.position.set(...def.position);

  // Store entity data
  group.userData = {
    entityId: def.id,
    entityName: def.name,
    entityTeam: def.team,
    entityClass: def.class
  };

  return group;
}

// ============================================================================
// Initialization
// ============================================================================

function init(): GameState {
  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.Fog(0x1a1a2e, 30, 60);

  // Create renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.appendChild(renderer.domElement);

  // Create camera rig
  const cameraRig = new CameraRig();
  cameraRig.attach(renderer.domElement);

  // Add arena
  const arena = createArena();
  scene.add(arena);

  // Add lighting
  const lighting = createArenaLighting();
  scene.add(lighting);

  // Add coordinate axis gizmo at origin
  const axisGizmo = createAxisGizmo(2);
  axisGizmo.position.set(0, 0.01, 0);
  scene.add(axisGizmo);

  // Create entities (NPCs get capsule mesh, player gets CharacterView)
  const entities = new Map<string, THREE.Object3D>();

  for (const def of INITIAL_ENTITIES) {
    if (def.id !== 'player') {
      const mesh = createEntityMesh(def);
      scene.add(mesh);
      entities.set(def.id, mesh);
    }
  }

  // Create player with CharacterView
  const playerDef = INITIAL_ENTITIES.find(e => e.id === 'player')!;
  const playerView = new ProceduralCharacterView(playerDef.color);
  playerView.root.position.set(...playerDef.position);
  scene.add(playerView.root);
  entities.set('player', playerView.root);

  // Create player controller
  const player = new PlayerController(
    new THREE.Vector3(...playerDef.position)
  );
  player.mesh = playerView.root;
  player.attach();
  player.setColliders(getColliders());

  // Create targeting system
  const targeting = new TargetingSystem(cameraRig.camera);
  targeting.attach(renderer.domElement);

  // Register all entities as targetable (except player)
  for (const [id, mesh] of entities) {
    if (id !== 'player') {
      const def = INITIAL_ENTITIES.find(e => e.id === id)!;
      targeting.registerTargetable(mesh, id, def.name, def.team);
    }
  }

  // Get debug element
  const debugElement = document.getElementById('debug-info');

  // Handle window resize
  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    const height = window.innerHeight;

    cameraRig.resize(width, height);
    renderer.setSize(width, height);
  });

  // Create clock
  const clock = new THREE.Clock();

  return {
    scene,
    renderer,
    cameraRig,
    player,
    playerView,
    targeting,
    entities,
    clock,
    debugElement
  };
}

// ============================================================================
// Game Loop
// ============================================================================

function animate(state: GameState): void {
  requestAnimationFrame(() => animate(state));

  const {
    scene,
    renderer,
    cameraRig,
    player,
    playerView,
    targeting,
    clock,
    debugElement
  } = state;

  const delta = clock.getDelta();

  // Update player (pass camera yaw for movement direction)
  player.update(delta, cameraRig.yaw);

  // Update player character view
  const vel = player.velocity;
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  const isGrounded = player.position.y <= 0.01;

  let locoState: LocomotionState = 'idle';
  if (!isGrounded) {
    locoState = vel.y > 0 ? 'jump' : 'fall';
  } else if (speed > 4) {
    locoState = 'run';
  } else if (speed > 0.1) {
    locoState = 'walk';
  }

  playerView.setLocomotion(locoState, speed / 6);

  // Face movement direction when moving
  if (speed > 0.1) {
    const moveYaw = dirToYaw(new THREE.Vector3(vel.x, 0, vel.z));
    playerView.setFacingYaw(-moveYaw); // Negate because our convention
  }

  playerView.update(delta);

  // Update camera to follow player
  cameraRig.update(player.position);

  // Update targeting system
  targeting.update(player.position);

  // Update debug info
  if (debugElement) {
    debugElement.textContent = player.getDebugInfo();
  }

  // Render
  renderer.render(scene, cameraRig.camera);
}

// ============================================================================
// Start
// ============================================================================

const gameState = init();
animate(gameState);

console.log('WoW Arena Sandbox - Phase 1');
console.log('Controls:');
console.log('  WASD: Move');
console.log('  Space: Jump');
console.log('  Left-click drag: Orbit camera');
console.log('  Click on unit: Target');
console.log('  Click empty space: Clear target');
