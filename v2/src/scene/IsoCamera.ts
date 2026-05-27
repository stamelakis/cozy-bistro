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

  update(_dt: number): void {
    // Camera pose currently only changes from input events; reserved for
    // future smoothing/interpolation.
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0015);
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, 3, 40);
    this.resize(window.innerWidth, window.innerHeight);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button === 2 || e.button === 1) {
      // Right or middle drag rotates.
      this.dragging = true;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } else if (e.button === 0 && e.shiftKey) {
      // Shift+left drag pans.
      this.dragging = true;
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

    if (e.shiftKey) {
      // Pan in the camera's screen-aligned plane.
      const panScale = this.zoom * 0.0025;
      const right = new THREE.Vector3().setFromMatrixColumn(this.threeCamera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.threeCamera.matrix, 1);
      this.target.addScaledVector(right, -dx * panScale);
      this.target.addScaledVector(up, dy * panScale);
    } else {
      // Rotate around target.
      this.azimuth -= dx * 0.005;
      this.elevation = THREE.MathUtils.clamp(this.elevation - dy * 0.005, Math.PI / 12, Math.PI / 2 - 0.05);
    }
    this.updatePose();
  };

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
