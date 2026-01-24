/**
 * Targeting System - Click-to-target with raycasting
 */

import * as THREE from 'three';
import { prettyVec, dirToYaw, flattenXZ } from './coords';

export interface TargetInfo {
  id: string;
  name: string;
  team: 'friendly' | 'enemy';
  mesh: THREE.Object3D;
  distance: number;
  direction: THREE.Vector3;
}

export class TargetingSystem {
  private raycaster: THREE.Raycaster;
  private mouse: THREE.Vector2;
  private camera: THREE.Camera;
  private targetables: Map<THREE.Object3D, { id: string; name: string; team: 'friendly' | 'enemy' }>;

  public currentTarget: TargetInfo | null = null;
  private originalMaterials: Map<THREE.Object3D, THREE.Material | THREE.Material[]> = new Map();

  // UI elements
  private nameElement: HTMLElement | null = null;
  private infoElement: HTMLElement | null = null;

  constructor(camera: THREE.Camera) {
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.camera = camera;
    this.targetables = new Map();

    this.onClick = this.onClick.bind(this);
  }

  /**
   * Attach click listener
   */
  attach(element: HTMLElement): void {
    element.addEventListener('click', this.onClick);

    // Get UI elements
    this.nameElement = document.getElementById('target-name');
    this.infoElement = document.getElementById('target-info');
  }

  /**
   * Detach click listener
   */
  detach(element: HTMLElement): void {
    element.removeEventListener('click', this.onClick);
  }

  /**
   * Register a mesh as targetable
   */
  registerTargetable(
    mesh: THREE.Object3D,
    id: string,
    name: string,
    team: 'friendly' | 'enemy'
  ): void {
    this.targetables.set(mesh, { id, name, team });
    mesh.userData.targetable = true;
    mesh.userData.entityId = id;
  }

  /**
   * Unregister a targetable mesh
   */
  unregisterTargetable(mesh: THREE.Object3D): void {
    this.targetables.delete(mesh);
  }

  private onClick(e: MouseEvent): void {
    // Calculate normalized device coordinates
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    // Update raycaster
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Get all targetable meshes
    const targetableMeshes = Array.from(this.targetables.keys());

    // Check for intersections
    const intersects = this.raycaster.intersectObjects(targetableMeshes, true);

    if (intersects.length > 0) {
      // Find the targetable parent
      let targetMesh: THREE.Object3D | null = null;
      let current: THREE.Object3D | null = intersects[0].object;

      while (current) {
        if (this.targetables.has(current)) {
          targetMesh = current;
          break;
        }
        current = current.parent;
      }

      if (targetMesh) {
        this.setTarget(targetMesh);
      }
    } else {
      // Clicked empty space - clear target
      this.clearTarget();
    }
  }

  /**
   * Set target to a specific mesh
   */
  setTarget(mesh: THREE.Object3D): void {
    // Clear previous target highlight
    this.clearHighlight();

    const data = this.targetables.get(mesh);
    if (!data) return;

    // Calculate target info
    const direction = new THREE.Vector3();
    mesh.getWorldPosition(direction);

    this.currentTarget = {
      id: data.id,
      name: data.name,
      team: data.team,
      mesh,
      distance: 0,
      direction
    };

    // Apply highlight
    this.applyHighlight(mesh, data.team);

    // Update UI
    this.updateUI();

    console.log(`Target set: ${data.name} (${data.id})`);
  }

  /**
   * Clear current target
   */
  clearTarget(): void {
    this.clearHighlight();
    this.currentTarget = null;
    this.updateUI();
    console.log('Target cleared');
  }

  private applyHighlight(mesh: THREE.Object3D, team: 'friendly' | 'enemy'): void {
    // Find the actual mesh with material
    mesh.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const mat = child.material as THREE.MeshStandardMaterial;
        // Only apply highlight if material supports emissive
        if (mat.emissive !== undefined) {
          // Store original values
          this.originalMaterials.set(child, {
            emissive: mat.emissive.clone(),
            emissiveIntensity: mat.emissiveIntensity
          } as unknown as THREE.Material);

          // Apply highlight without cloning
          mat.emissive = new THREE.Color(team === 'friendly' ? 0x00ff00 : 0xff0000);
          mat.emissiveIntensity = 0.3;
        }
      }
    });
  }

  private clearHighlight(): void {
    // Restore original emissive values
    this.originalMaterials.forEach((stored, mesh) => {
      if (mesh instanceof THREE.Mesh) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const original = stored as unknown as { emissive: THREE.Color; emissiveIntensity: number };
        if (mat.emissive !== undefined && original.emissive) {
          mat.emissive.copy(original.emissive);
          mat.emissiveIntensity = original.emissiveIntensity;
        }
      }
    });
    this.originalMaterials.clear();
  }

  /**
   * Update targeting info (call each frame)
   */
  update(playerPosition: THREE.Vector3): void {
    if (!this.currentTarget) return;

    // Get target world position
    const targetPos = new THREE.Vector3();
    this.currentTarget.mesh.getWorldPosition(targetPos);

    // Calculate distance
    this.currentTarget.distance = playerPosition.distanceTo(targetPos);

    // Calculate relative direction
    this.currentTarget.direction = targetPos.clone().sub(playerPosition);

    // Update UI with current info
    this.updateUI();
  }

  private updateUI(): void {
    if (!this.nameElement || !this.infoElement) return;

    if (!this.currentTarget) {
      this.nameElement.textContent = 'No Target';
      this.nameElement.style.color = '#888';
      this.infoElement.textContent = '';
    } else {
      const { name, team, distance, direction } = this.currentTarget;

      // Set name with team color
      this.nameElement.textContent = name;
      this.nameElement.style.color = team === 'friendly' ? '#00ff88' : '#ff4444';

      // Set info
      const yawDeg = (dirToYaw(direction) * 180 / Math.PI).toFixed(0);
      this.infoElement.innerHTML = `
        Distance: ${distance.toFixed(1)}m<br>
        Direction: ${prettyVec(flattenXZ(direction).normalize())}<br>
        Bearing: ${yawDeg}°
      `;
    }
  }

  /**
   * Get the raycaster for external use (e.g., debug picking)
   */
  getRaycaster(): THREE.Raycaster {
    return this.raycaster;
  }
}
