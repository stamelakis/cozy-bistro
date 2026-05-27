import * as THREE from "three";
import { furnitureCatalog, type FurnitureDef } from "../data/furnitureCatalog";
import type { ModelLoader } from "../assets/ModelLoader";
import type { Game } from "../game/Game";
import type { FurnitureRegistry } from "../game/FurnitureRegistry";

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
  private readonly registry: FurnitureRegistry;

  private placingDef: FurnitureDef | null = null;
  private preview: THREE.Object3D | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  /** Snapped world position the preview is hovering over. */
  private readonly hoverCell = new THREE.Vector3();
  private hoverValid = false;
  /** Rotation (radians around Y) applied to the preview/placed model.
   * Press R while placing to rotate 90°. */
  private rotationY = 0;
  /** When true, clicking a placed item refunds 50% and removes it.
   * Mutually exclusive with placingDef (entering sell mode cancels placement). */
  private sellMode = false;
  private sellBtn?: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    game: Game,
    loader: ModelLoader,
    scene: THREE.Scene,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    registry: FurnitureRegistry,
  ) {
    this.game = game;
    this.loader = loader;
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.registry = registry;
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

    // Group buttons by category so a longer catalog stays scannable.
    // Each category is a collapsible section (all collapsed by default
    // except Tables) to handle the 50+ items without dominating the screen.
    const categoryOrder: FurnitureDef["category"][] = [
      "table", "chair", "stove", "counter", "decoration", "plant", "lamp", "door",
    ];
    const categoryLabels: Record<FurnitureDef["category"], string> = {
      table: "Tables", chair: "Chairs", stove: "Cooking", counter: "Counters",
      decoration: "Decor", plant: "Plants", lamp: "Lighting", door: "Doors & Windows",
    };
    for (const cat of categoryOrder) {
      const items = furnitureCatalog.filter((d) => d.category === cat);
      if (items.length === 0) continue;
      const startOpen = cat === "table";
      let open = startOpen;
      const header = document.createElement("div");
      Object.assign(header.style, {
        marginTop: "8px",
        marginBottom: "3px",
        padding: "3px 4px",
        fontSize: "11px",
        fontWeight: "700",
        opacity: "0.85",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        cursor: "pointer",
        background: "rgba(255,245,220,0.05)",
        borderRadius: "3px",
        userSelect: "none",
      } as Partial<CSSStyleDeclaration>);
      const items_wrap = document.createElement("div");
      items_wrap.style.display = open ? "block" : "none";
      const refreshHeader = () => {
        header.textContent = `${open ? "▾" : "▸"} ${categoryLabels[cat]} (${items.length})`;
      };
      refreshHeader();
      header.onclick = () => {
        open = !open;
        items_wrap.style.display = open ? "block" : "none";
        refreshHeader();
      };
      root.appendChild(header);
      for (const def of items) {
        const btn = document.createElement("button");
        btn.textContent = `${def.name} — $${def.cost}`;
        Object.assign(btn.style, {
          display: "block",
          width: "100%",
          margin: "0 0 3px 0",
          padding: "5px 8px",
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
        items_wrap.appendChild(btn);
      }
      root.appendChild(items_wrap);
    }

    const sellBtn = document.createElement("button");
    sellBtn.textContent = "SELL MODE (50% refund)";
    Object.assign(sellBtn.style, {
      display: "block",
      width: "100%",
      marginTop: "10px",
      padding: "6px 8px",
      background: "rgba(220, 140, 80, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(220, 140, 80, 0.5)",
      borderRadius: "4px",
      textAlign: "center",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    sellBtn.onclick = () => this.toggleSellMode();
    root.appendChild(sellBtn);
    this.sellBtn = sellBtn;

    const hint = document.createElement("div");
    hint.textContent = "Click item → click floor to place. R = rotate. Esc = cancel.";
    Object.assign(hint.style, { marginTop: "8px", opacity: "0.65", fontSize: "11px" } as Partial<CSSStyleDeclaration>);
    root.appendChild(hint);

    return root;
  }

  private toggleSellMode(): void {
    this.sellMode = !this.sellMode;
    if (this.sellMode) {
      this.cancelPlacing(); // sell mode and placing mode are mutually exclusive
    }
    if (this.sellBtn) {
      this.sellBtn.style.background = this.sellMode
        ? "rgba(220, 140, 80, 0.6)"
        : "rgba(220, 140, 80, 0.18)";
      this.sellBtn.textContent = this.sellMode
        ? "SELL MODE — click item to sell (Esc to exit)"
        : "SELL MODE (50% refund)";
    }
  }

  private attachInput(): void {
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("click", this.onClick);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.cancelPlacing();
        if (this.sellMode) this.toggleSellMode();
      }
      if ((e.key === "r" || e.key === "R") && this.preview) {
        this.rotationY = (this.rotationY + Math.PI / 2) % (Math.PI * 2);
        this.preview.rotation.y = this.rotationY;
      }
    });
  }

  private async startPlacing(def: FurnitureDef): Promise<void> {
    if (this.game.economy.canAfford(def.cost) === false) {
      this.flashRoot("Not enough money");
      return;
    }
    if (this.sellMode) this.toggleSellMode(); // exit sell mode if entering place mode
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
    // Run the raycaster in both placing mode (to position the preview)
    // and sell mode (to know which cell a click would hit).
    if (!this.placingDef && !this.sellMode) return;
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
      if (this.preview) {
        this.preview.position.copy(this.hoverCell);
        // Tint preview red if the cell is already taken — placement will be blocked.
        const blocked = this.registry.isOccupied(this.hoverCell.x, this.hoverCell.z);
        this.preview.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            const m = o.material as THREE.MeshStandardMaterial;
            if (m && "color" in m && m.color) {
              m.color.set(blocked ? 0xff8080 : 0xffffff);
            }
          }
        });
      }
    }
  };

  private onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    if (this.sellMode && this.hoverValid) {
      const x = Math.round(this.hoverCell.x);
      const z = Math.round(this.hoverCell.z);
      const removed = this.registry.removeAt(x, z);
      if (!removed) {
        this.flashRoot("Nothing to sell there");
        return;
      }
      this.game.economy.earnMoney(removed.refund, "payment");
      this.flashRoot(`Sold for $${removed.refund}`);
      return;
    }
    if (!this.placingDef || !this.preview || !this.hoverValid) return;
    const def = this.placingDef;
    const cellX = Math.round(this.hoverCell.x);
    const cellZ = Math.round(this.hoverCell.z);
    if (this.registry.isOccupied(cellX, cellZ)) {
      this.flashRoot("Cell already occupied");
      return;
    }
    if (!this.game.economy.spendMoney(def.cost, "decor")) {
      this.flashRoot("Not enough money");
      return;
    }
    // Bake the preview into the scene: clone it as a solid model and add.
    const rotY = this.rotationY;
    void this.loader.load(def.modelPath).then((solid) => {
      solid.position.set(cellX, 0, cellZ);
      solid.rotation.y = rotY;
      solid.scale.setScalar(def.scale);
      this.scene.add(solid);
      this.registry.register(def.id, cellX, cellZ, rotY, solid);
    });
    // Keep placing more of the same — many people want to drop multiples
    // (e.g. 4 chairs around a table). Esc / right-click to stop.
  };
}
