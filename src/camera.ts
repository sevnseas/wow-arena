/**
 * CameraRig - Third-person camera with orbit controls
 */

import * as THREE from 'three';

export interface CameraConfig {
  distance: number;
  minDistance: number;
  maxDistance: number;
  height: number;        // Height offset for look-at point
  pitchMin: number;      // Minimum pitch in radians
  pitchMax: number;      // Maximum pitch in radians
  sensitivity: number;   // Mouse sensitivity
  smoothing: number;     // Lerp factor for smooth movement
}

const DEFAULT_CONFIG: CameraConfig = {
  distance: 8,
  minDistance: 3,
  maxDistance: 20,
  height: 1.2,
  pitchMin: -20 * Math.PI / 180,  // -20 degrees
  pitchMax: 70 * Math.PI / 180,   // 70 degrees
  sensitivity: 0.003,
  smoothing: 0.1
};

export class CameraRig {
  public camera: THREE.PerspectiveCamera;
  public pivot: THREE.Object3D;

  private config: CameraConfig;
  private targetYaw: number = 0;
  private targetPitch: number = 0.3;
  private currentYaw: number = 0;
  private currentPitch: number = 0.3;
  private targetDistance: number;

  private leftDown: boolean = false;
  private rightDown: boolean = false;
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;
  // Yaw delta accumulated from RMB drag since last consume. main.ts pulls
  // this each frame and applies it to the player's facing yaw so camera
  // and character stay aligned in WoW-style "right click to turn".
  private pendingPlayerYawDelta: number = 0;

  constructor(config: Partial<CameraConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.targetDistance = this.config.distance;

    // Create camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );

    // Create pivot point (follows player)
    this.pivot = new THREE.Object3D();
    this.pivot.name = 'CameraPivot';

    // Bind event handlers
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
  }

  /**
   * Attach event listeners
   */
  attach(element: HTMLElement): void {
    element.addEventListener('mousedown', this.onMouseDown);
    element.addEventListener('mouseup', this.onMouseUp);
    element.addEventListener('mousemove', this.onMouseMove);
    element.addEventListener('wheel', this.onWheel);
    element.addEventListener('contextmenu', this.onContextMenu);

    // Also listen for mouseup on window to catch releases outside canvas
    window.addEventListener('mouseup', this.onMouseUp);
  }

  /**
   * Detach event listeners
   */
  detach(element: HTMLElement): void {
    element.removeEventListener('mousedown', this.onMouseDown);
    element.removeEventListener('mouseup', this.onMouseUp);
    element.removeEventListener('mousemove', this.onMouseMove);
    element.removeEventListener('wheel', this.onWheel);
    element.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('mouseup', this.onMouseUp);
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button === 0) this.leftDown = true;
    if (e.button === 2) this.rightDown = true;
    if (e.button === 0 || e.button === 2) {
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.leftDown = false;
    if (e.button === 2) this.rightDown = false;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.leftDown && !this.rightDown) return;

    const deltaX = e.clientX - this.lastMouseX;
    const deltaY = e.clientY - this.lastMouseY;

    const yawDelta = -deltaX * this.config.sensitivity;
    this.targetYaw += yawDelta;
    this.targetPitch += deltaY * this.config.sensitivity;

    // RMB also rotates the player so the camera stays behind the character.
    // (LMB-only drag orbits the camera while the character keeps facing
    // wherever it was — classic WoW behavior.)
    if (this.rightDown) this.pendingPlayerYawDelta += yawDelta;

    // Clamp pitch
    this.targetPitch = Math.max(
      this.config.pitchMin,
      Math.min(this.config.pitchMax, this.targetPitch)
    );

    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
  }

  private onWheel(e: WheelEvent): void {
    this.targetDistance += e.deltaY * 0.01;
    this.targetDistance = Math.max(
      this.config.minDistance,
      Math.min(this.config.maxDistance, this.targetDistance)
    );
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
  }

  /**
   * Get the current camera yaw (for movement direction)
   */
  get yaw(): number {
    return this.currentYaw;
  }

  /**
   * Check if camera is being dragged (to prevent targeting on orbit)
   */
  get dragging(): boolean {
    return this.leftDown || this.rightDown;
  }

  /** Both buttons held → "mouse-walk" forward (WoW convention). */
  get bothHeld(): boolean {
    return this.leftDown && this.rightDown;
  }

  /**
   * Pull (and clear) the yaw delta accumulated from RMB dragging since the
   * last call. The caller adds this to the player's facing yaw.
   */
  consumePlayerYawDelta(): number {
    const v = this.pendingPlayerYawDelta;
    this.pendingPlayerYawDelta = 0;
    return v;
  }

  /**
   * Force the camera yaw to follow the given player yaw exactly. Used
   * after the player turns externally (e.g. snap-to-target) so the
   * camera doesn't lag behind.
   */
  setYaw(yaw: number): void {
    this.targetYaw = yaw;
  }

  /**
   * Recenter camera behind player
   */
  recenterBehindPlayer(playerYaw: number): void {
    this.targetYaw = playerYaw;
  }

  /**
   * Update camera position based on pivot and smoothing
   */
  update(targetPosition: THREE.Vector3): void {
    // Smooth interpolation
    this.currentYaw += (this.targetYaw - this.currentYaw) * this.config.smoothing;
    this.currentPitch += (this.targetPitch - this.currentPitch) * this.config.smoothing;

    // Calculate camera position on sphere around pivot
    const sphericalOffset = new THREE.Vector3(
      Math.sin(this.currentYaw) * Math.cos(this.currentPitch),
      Math.sin(this.currentPitch),
      Math.cos(this.currentYaw) * Math.cos(this.currentPitch)
    ).multiplyScalar(this.targetDistance);

    // Update pivot position (slightly above player)
    this.pivot.position.copy(targetPosition);
    this.pivot.position.y += this.config.height;

    // Position camera
    this.camera.position.copy(this.pivot.position).add(sphericalOffset);

    // Look at pivot point
    this.camera.lookAt(this.pivot.position);
  }

  /**
   * Handle window resize
   */
  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
