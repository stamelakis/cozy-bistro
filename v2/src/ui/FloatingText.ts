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
  /** Storey this pop belongs to. Pops on a non-focused storey are hidden
   * so a floor-1 "+$N" / "🧹 cleaning" doesn't leak into the floor-0 view.
   * undefined = a UI message (rest spot set, hire) that always shows. */
  floor?: number;
}

export class FloatingText {
  private readonly host: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly canvas: HTMLCanvasElement;
  private readonly active: ActiveText[] = [];
  /** Phase 9.37 — same floor-focus hooks the status bubbles use, so
   * world-anchored gameplay pops only render on the storey the player is
   * looking at. Wired by Engine; unset = no gating (everything shows). */
  getFocusedFloor?: () => number;
  getStoreyHeight?: () => number;

  constructor(host: HTMLElement, camera: THREE.Camera, canvas: HTMLCanvasElement) {
    this.host = host;
    this.camera = camera;
    this.canvas = canvas;
  }

  /** Spawn a floating label at world XZ, ~1.6 m above storey `floor`'s
   * slab. When `floor` is given the pop only renders while the player is
   * looking at that storey; omit it for UI messages that should always
   * show (they sit at the focused storey's height). */
  pop(worldX: number, worldZ: number, text: string, color = "#fff5dc", floor?: number): void {
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
    const storeyH = this.getStoreyHeight?.() ?? 3;
    // Sit above the right slab: a tagged pop uses its own floor; a UI pop
    // uses whatever floor the player is currently looking at so it's in view.
    const renderFloor = floor ?? (this.getFocusedFloor?.() ?? 0);
    this.active.push({
      el,
      worldPos: new THREE.Vector3(worldX, renderFloor * storeyH + 1.6, worldZ),
      age: 0,
      duration: 1.6,
      drift: 50,
      floor,
    });
  }

  update(dt: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const tmp = new THREE.Vector3();
    const focused = this.getFocusedFloor?.();
    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const t = this.active[i];
      t.age += dt;
      if (t.age >= t.duration) {
        t.el.remove();
        this.active.splice(i, 1);
        continue;
      }
      // Floor gate — hide a pop tagged to a storey the player isn't looking
      // at (undefined floor = UI message, always shown).
      if (t.floor !== undefined && focused !== undefined && t.floor !== focused) {
        t.el.style.display = "none";
        continue;
      }
      t.el.style.display = "block";
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
