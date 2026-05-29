import * as THREE from "three";

/**
 * Orthographic camera with an isometric-style angle. Keeps the iso/Stardew
 * feel of the 2D game while letting us rotate the view freely and pan/zoom.
 *
 * Standard iso angles: 30° down from horizontal, 45° around vertical.
 */
export class IsoCamera {
  readonly threeCamera: THREE.OrthographicCamera;
  private target = new THREE.Vector3(0, 0, 0);
  private zoom = 12; // half-height of view in world units
  private azimuth = Math.PI / 4; // 45°
  private elevation = Math.atan(1 / Math.SQRT2); // ~35.26°, true iso

  private dragging = false;
  private dragLastX = 0;
  private dragLastY = 0;

  // Floor-focus tween: when the player presses a floor button on the
  // FloorSelector the camera glides its look-at target up/down to the
  // matching storey instead of snapping. We blend `target.y` from the
  // current value toward `tweenEndY` over `tweenDur` real seconds.
  private tweenStartY = 0;
  private tweenEndY = 0;
  private tweenElapsed = 0;
  private tweenDur = 0;

  constructor(viewW: number, viewH: number) {
    const aspect = viewW / viewH;
    this.threeCamera = new THREE.OrthographicCamera(
      -this.zoom * aspect, this.zoom * aspect,
      this.zoom, -this.zoom,
      0.1, 1000,
    );
    this.updatePose();
  }

  /** Attach pointer + wheel handlers to the canvas for pan/zoom/rotate. */
  attachInputTo(el: HTMLElement): void {
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  resize(w: number, h: number): void {
    const aspect = w / h;
    this.threeCamera.left = -this.zoom * aspect;
    this.threeCamera.right = this.zoom * aspect;
    this.threeCamera.top = this.zoom;
    this.threeCamera.bottom = -this.zoom;
    this.threeCamera.updateProjectionMatrix();
  }

  update(dt: number): void {
    // Drive the floor-focus tween if one is running. Calling
    // `tweenTargetY` while a tween is mid-flight extends it from the
    // current eased position (we sample target.y at the new "start").
    if (this.tweenDur > 0) {
      this.tweenElapsed = Math.min(this.tweenElapsed + dt, this.tweenDur);
      const t = this.tweenElapsed / this.tweenDur;
      // Smoothstep ease for a gentle in/out — no overshoot so the camera
      // doesn't punch through the storey above/below the destination.
      const eased = t * t * (3 - 2 * t);
      this.target.y = this.tweenStartY + (this.tweenEndY - this.tweenStartY) * eased;
      this.updatePose();
      if (this.tweenElapsed >= this.tweenDur) {
        this.target.y = this.tweenEndY;
        this.tweenDur = 0;
        this.tweenElapsed = 0;
      }
    }
  }

  /** Smoothly glide the camera look-at target's Y to the requested
   * height over `durationSec` seconds. Pass 0 for an instant snap.
   * Called by FloorSelector when a new floor is picked — the X/Z
   * components of the target are left untouched so the player's pan
   * is preserved. */
  tweenTargetY(y: number, durationSec = 0.45): void {
    if (durationSec <= 0) {
      this.target.y = y;
      this.tweenDur = 0;
      this.updatePose();
      return;
    }
    this.tweenStartY = this.target.y;
    this.tweenEndY = y;
    this.tweenElapsed = 0;
    this.tweenDur = durationSec;
  }

  /** Read the look-at target's Y — used by FloorSelector to know
   * whether the camera is already at the requested floor. */
  getTargetY(): number {
    return this.target.y;
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0015);
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, 3, 40);
    this.resize(window.innerWidth, window.innerHeight);
  };

  private dragButton = 0; // which mouse button started the drag
  private dragMoved = 0;  // total px moved during this drag

  private onPointerDown = (e: PointerEvent): void => {
    // Left = pan, Right = rotate, Middle = rotate.
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      this.dragging = true;
      this.dragButton = e.button;
      this.dragMoved = 0;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragLastX;
    const dy = e.clientY - this.dragLastY;
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;
    this.dragMoved += Math.abs(dx) + Math.abs(dy);

    if (this.dragButton === 2 || this.dragButton === 1 || e.shiftKey) {
      // Right / middle / Shift+left = rotate.
      this.azimuth -= dx * 0.005;
      this.elevation = THREE.MathUtils.clamp(this.elevation - dy * 0.005, Math.PI / 12, Math.PI / 2 - 0.05);
    } else {
      // Plain left-drag = pan.
      const panScale = this.zoom * 0.0025;
      const right = new THREE.Vector3().setFromMatrixColumn(this.threeCamera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.threeCamera.matrix, 1);
      this.target.addScaledVector(right, -dx * panScale);
      this.target.addScaledVector(up, dy * panScale);
    }
    this.updatePose();
  };

  /** Returns true if the most recent drag was a true drag (moved more
   * than ~6 px) — used by BuildMenu to suppress the place-click. */
  wasDragging(): boolean {
    return this.dragMoved > 6;
  }

  private onPointerUp = (_e: PointerEvent): void => {
    this.dragging = false;
  };

  private updatePose(): void {
    const r = 30;
    const x = r * Math.cos(this.elevation) * Math.cos(this.azimuth);
    const z = r * Math.cos(this.elevation) * Math.sin(this.azimuth);
    const y = r * Math.sin(this.elevation);
    this.threeCamera.position.set(this.target.x + x, this.target.y + y, this.target.z + z);
    this.threeCamera.lookAt(this.target);
    this.threeCamera.up.set(0, 1, 0);
  }
}
