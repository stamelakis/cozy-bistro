import * as THREE from "three";
import { furnitureCatalog, type FurnitureDef } from "../data/furnitureCatalog";
import type { ModelLoader } from "../assets/ModelLoader";
import type { Game } from "../game/Game";

/**
 * Minimal build/buy menu — list furniture items on the right side of the
 * screen. Click an item to enter PLACING mode: a translucent preview
 * follows the mouse cursor on the ground plane, snapping to integer grid
 * cells. Left-click to confirm placement (deducts cost from money).
 * Right-click or Escape to cancel.
 *
 * For Phase 4 this is intentionally simple — no rotation, no deletion,
 * no per-tier filtering, no overlap detection. The ground is large enough
 * that overlaps don't break anything mechanically yet.
 */

export class BuildMenu {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly loader: ModelLoader;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly canvas: HTMLCanvasElement;

  private placingDef: FurnitureDef | null = null;
  private preview: THREE.Object3D | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  /** Snapped world position the preview is hovering over. */
  private readonly hoverCell = new THREE.Vector3();
  private hoverValid = false;

  constructor(
    parent: HTMLElement,
    game: Game,
    loader: ModelLoader,
    scene: THREE.Scene,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
  ) {
    this.game = game;
    this.loader = loader;
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.root = this.buildPanel(parent);
    this.attachInput();
  }

  private buildPanel(parent: HTMLElement): HTMLElement {
    const root = document.createElement("div");
    Object.assign(root.style, {
      position: "fixed",
      top: "12px",
      right: "12px",
      width: "220px",
      maxHeight: "calc(100vh - 24px)",
      overflowY: "auto",
      padding: "12px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "8px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(root);

    const title = document.createElement("div");
    title.textContent = "BUILD";
    Object.assign(title.style, { fontSize: "14px", fontWeight: "600", marginBottom: "8px" } as Partial<CSSStyleDeclaration>);
    root.appendChild(title);

    for (const def of furnitureCatalog) {
      const btn = document.createElement("button");
      btn.textContent = `${def.name} — $${def.cost}`;
      Object.assign(btn.style, {
        display: "block",
        width: "100%",
        margin: "0 0 4px 0",
        padding: "6px 8px",
        background: "rgba(255,245,220,0.08)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px",
        textAlign: "left",
        cursor: "pointer",
        fontSize: "12px",
      } as Partial<CSSStyleDeclaration>);
      btn.onmouseenter = () => { btn.style.background = "rgba(255,245,220,0.16)"; };
      btn.onmouseleave = () => { btn.style.background = "rgba(255,245,220,0.08)"; };
      btn.onclick = () => this.startPlacing(def);
      root.appendChild(btn);
    }

    const hint = document.createElement("div");
    hint.textContent = "Click an item, then click the floor to place. Esc to cancel.";
    Object.assign(hint.style, { marginTop: "8px", opacity: "0.65", fontSize: "11px" } as Partial<CSSStyleDeclaration>);
    root.appendChild(hint);

    return root;
  }

  private attachInput(): void {
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("click", this.onClick);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.cancelPlacing();
    });
  }

  private async startPlacing(def: FurnitureDef): Promise<void> {
    if (this.game.economy.canAfford(def.cost) === false) {
      this.flashRoot("Not enough money");
      return;
    }
    this.cancelPlacing();
    this.placingDef = def;
    try {
      this.preview = await this.loader.load(def.modelPath);
      this.preview.scale.setScalar(def.scale);
      this.preview.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const m = (o.material as THREE.Material).clone() as THREE.Material;
          m.transparent = true;
          m.opacity = 0.6;
          o.material = m;
          o.castShadow = false;
        }
      });
      this.scene.add(this.preview);
    } catch (err) {
      console.warn("preview load failed:", err);
      this.placingDef = null;
    }
  }

  private cancelPlacing(): void {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    this.placingDef = null;
  }

  private flashRoot(msg: string): void {
    const old = this.root.style.background;
    this.root.style.background = "rgba(140, 30, 30, 0.85)";
    const note = document.createElement("div");
    note.textContent = msg;
    note.style.marginTop = "6px";
    note.style.color = "#ffd0d0";
    this.root.appendChild(note);
    setTimeout(() => {
      this.root.style.background = old;
      note.remove();
    }, 1200);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.placingDef || !this.preview) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    // Intersect with the y=0 ground plane.
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    this.hoverValid = this.raycaster.ray.intersectPlane(groundPlane, point) !== null;
    if (this.hoverValid) {
      // Snap to integer cells (1 cell = 1 world unit).
      this.hoverCell.set(Math.round(point.x), 0, Math.round(point.z));
      this.preview.position.copy(this.hoverCell);
    }
  };

  private onClick = (e: MouseEvent): void => {
    if (!this.placingDef || !this.preview || !this.hoverValid) return;
    if (e.button !== 0) return;
    const def = this.placingDef;
    if (!this.game.economy.spendMoney(def.cost, "decor")) {
      this.flashRoot("Not enough money");
      return;
    }
    // Bake the preview into the scene: clone it as a solid model and add.
    void this.loader.load(def.modelPath).then((solid) => {
      solid.position.copy(this.hoverCell);
      solid.scale.setScalar(def.scale);
      this.scene.add(solid);
    });
    // Keep placing more of the same — many people want to drop multiples
    // (e.g. 4 chairs around a table). Esc / right-click to stop.
  };
}
