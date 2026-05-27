import * as THREE from "three";

/**
 * Pops a short-lived "+$5" / "-1★" world-anchored label that floats up
 * and fades out. Read with the iso camera even when the camera is
 * panned/rotated, because we re-project the world point each frame.
 */

interface ActiveText {
  el: HTMLElement;
  worldPos: THREE.Vector3;
  age: number;
  duration: number;
  drift: number; // pixels of upward float over its lifetime
}

export class FloatingText {
  private readonly host: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly canvas: HTMLCanvasElement;
  private readonly active: ActiveText[] = [];

  constructor(host: HTMLElement, camera: THREE.Camera, canvas: HTMLCanvasElement) {
    this.host = host;
    this.camera = camera;
    this.canvas = canvas;
  }

  /** Spawn a floating label at the given world XZ position (y is 1m off floor). */
  pop(worldX: number, worldZ: number, text: string, color = "#fff5dc"): void {
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed",
      pointerEvents: "none",
      color,
      font: "600 16px/1 system-ui, sans-serif",
      textShadow: "0 1px 4px rgba(0,0,0,0.7)",
      transform: "translate(-50%, -50%)",
      transition: "opacity 0.4s linear",
      opacity: "1",
      zIndex: "20",
    } as Partial<CSSStyleDeclaration>);
    this.host.appendChild(el);
    this.active.push({
      el,
      worldPos: new THREE.Vector3(worldX, 1.6, worldZ),
      age: 0,
      duration: 1.6,
      drift: 50,
    });
  }

  update(dt: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const tmp = new THREE.Vector3();
    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const t = this.active[i];
      t.age += dt;
      if (t.age >= t.duration) {
        t.el.remove();
        this.active.splice(i, 1);
        continue;
      }
      // Re-project world position to screen.
      tmp.copy(t.worldPos);
      tmp.project(this.camera);
      const sx = rect.left + (tmp.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-tmp.y * 0.5 + 0.5) * rect.height - (t.age / t.duration) * t.drift;
      t.el.style.left = `${sx}px`;
      t.el.style.top = `${sy}px`;
      // Fade in last 0.4s of life.
      if (t.age > t.duration - 0.4) {
        t.el.style.opacity = String(Math.max(0, (t.duration - t.age) / 0.4));
      }
    }
  }
}
