import * as THREE from "three";
import { furnitureCatalog, type FurnitureDef } from "../data/furnitureCatalog";
import type { ModelLoader } from "../assets/ModelLoader";
import type { Game } from "../game/Game";
import { FurnitureRegistry } from "../game/FurnitureRegistry";
import { fitFurniture } from "../assets/fitFurniture";

/** A single user action that can be undone. The BuildMenu records one of
 * these for every place / sell / move / auto-arrange, capped at MAX_UNDO. */
type UndoEntry =
  | { kind: "place"; uid: string; defId: string; refundCost: number }
  | { kind: "sell"; defId: string; x: number; z: number; rotY: number; refundPaid: number }
  | { kind: "move"; uid: string; fromX: number; fromZ: number; fromRotY: number }
  | { kind: "auto-arrange"; moves: Array<{ uid: string; fromX: number; fromZ: number; fromRotY: number }> };

/** Result of evaluating the current hover position for a placement preview.
 *
 * - "blocked": cell is occupied or otherwise invalid — show RED, don't allow click.
 * - "snap-perfect": chair auto-snapped to an empty seat slot — show GREEN,
 *   placement uses the snapped pose (overrides hoverCell + rotationY).
 * - "ok": placement is allowed but not optimal — show YELLOW.
 */
type PlacementQuality = "blocked" | "snap-perfect" | "ok";
interface PlacementPlan {
  quality: PlacementQuality;
  /** Final placement world coords (integer cell, or snapped slot). */
  x: number;
  z: number;
  /** Final rotation (radians). */
  rotY: number;
}

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

  /** Past actions the player can undo. Capped at MAX_UNDO; oldest dropped. */
  private undoStack: UndoEntry[] = [];
  private static readonly MAX_UNDO = 5;
  private undoBtn?: HTMLButtonElement;
  private placingDef: FurnitureDef | null = null;
  private preview: THREE.Object3D | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  /** Snapped world position the preview is hovering over. */
  private readonly hoverCell = new THREE.Vector3();
  private hoverValid = false;
  /** Latest evaluated placement plan — populated by onPointerMove, consumed
   * by onClick. Lets the quality tint, snap pose and click placement stay
   * in lockstep (no chance of clicking before the tint updates). */
  private currentPlan: PlacementPlan | null = null;
  /** Rotation (radians around Y) applied to the preview/placed model.
   * Press R while placing to rotate 90°. */
  private rotationY = 0;
  /** When true, clicking a placed item refunds 50% and removes it.
   * Mutually exclusive with placingDef (entering sell mode cancels placement). */
  private sellMode = false;
  private sellBtn?: HTMLButtonElement;
  /** When true, first click picks up a placed item, second click drops
   * it at a new cell. */
  private moveMode = false;
  private moveBtn?: HTMLButtonElement;
  /** uid of the item the player is currently moving (between the two
   * clicks of a move). null = not holding anything yet. */
  private holdingUid: string | null = null;
  /** Original pose of the item being moved, for undo. */
  private holdingFrom: { x: number; z: number; rotY: number } | null = null;

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
      width: "230px",
      // Leave room for the PantryPanel at bottom-right (~35vh).
      maxHeight: "calc(60vh)",
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

    // Sell + Move buttons live as a pair under the catalog list.
    const actionRow = document.createElement("div");
    Object.assign(actionRow.style, {
      display: "grid", gridTemplateColumns: "1fr 1fr",
      gap: "4px", marginTop: "10px",
    } as Partial<CSSStyleDeclaration>);
    const sellBtn = document.createElement("button");
    sellBtn.textContent = "SELL (50%)";
    Object.assign(sellBtn.style, {
      padding: "6px 4px",
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
    actionRow.appendChild(sellBtn);
    this.sellBtn = sellBtn;

    const moveBtn = document.createElement("button");
    moveBtn.textContent = "MOVE";
    Object.assign(moveBtn.style, {
      padding: "6px 4px",
      background: "rgba(120, 160, 220, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(120, 160, 220, 0.5)",
      borderRadius: "4px",
      textAlign: "center",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    moveBtn.onclick = () => this.toggleMoveMode();
    actionRow.appendChild(moveBtn);
    this.moveBtn = moveBtn;
    root.appendChild(actionRow);

    // Auto-Arrange + Undo as a second pair of actions.
    const actionRow2 = document.createElement("div");
    Object.assign(actionRow2.style, {
      display: "grid", gridTemplateColumns: "1fr 1fr",
      gap: "4px", marginTop: "4px",
    } as Partial<CSSStyleDeclaration>);
    const autoBtn = document.createElement("button");
    autoBtn.textContent = "AUTO-ARRANGE";
    autoBtn.title = "Snap every chair to its nearest empty table seat slot";
    Object.assign(autoBtn.style, {
      padding: "6px 4px",
      background: "rgba(140, 200, 140, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(140, 200, 140, 0.5)",
      borderRadius: "4px",
      textAlign: "center",
      cursor: "pointer",
      fontSize: "11px",
      fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    autoBtn.onclick = () => this.runAutoArrange();
    actionRow2.appendChild(autoBtn);

    this.undoBtn = document.createElement("button");
    this.undoBtn.textContent = "↶ UNDO";
    this.undoBtn.title = "Undo the last build action (up to 5)";
    Object.assign(this.undoBtn.style, {
      padding: "6px 4px",
      background: "rgba(200, 180, 120, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(200, 180, 120, 0.5)",
      borderRadius: "4px",
      textAlign: "center",
      cursor: "pointer",
      fontSize: "11px",
      fontWeight: "600",
      opacity: "0.5", // disabled until something is on the stack
    } as Partial<CSSStyleDeclaration>);
    this.undoBtn.disabled = true;
    this.undoBtn.onclick = () => this.runUndo();
    actionRow2.appendChild(this.undoBtn);
    root.appendChild(actionRow2);

    const hint = document.createElement("div");
    hint.innerHTML = `Click item → click floor to place. R = rotate. Esc = cancel.<br/>
      Preview tints: <span style="color:#70e070">green</span> = perfect (chair snapped to a table seat),
      <span style="color:#ffd47a">yellow</span> = OK, <span style="color:#ff5050">red</span> = blocked.`;
    Object.assign(hint.style, { marginTop: "8px", opacity: "0.85", fontSize: "10px", lineHeight: "1.35" } as Partial<CSSStyleDeclaration>);
    root.appendChild(hint);

    return root;
  }

  private toggleMoveMode(): void {
    this.moveMode = !this.moveMode;
    this.holdingUid = null;
    if (this.moveMode) {
      this.cancelPlacing();
      if (this.sellMode) this.toggleSellMode();
    }
    if (this.moveBtn) {
      this.moveBtn.style.background = this.moveMode
        ? "rgba(120, 160, 220, 0.6)"
        : "rgba(120, 160, 220, 0.18)";
      this.moveBtn.textContent = this.moveMode
        ? "MOVE — click item then dest (Esc to exit)"
        : "MOVE";
    }
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
        if (this.moveMode) this.toggleMoveMode();
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
    if (this.moveMode) this.toggleMoveMode();
    this.cancelPlacing();
    this.placingDef = def;
    try {
      this.preview = await this.loader.load(def.modelPath);
      fitFurniture(this.preview, def);
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

  /** Record an undoable action. Drops the oldest if over MAX_UNDO. */
  private pushUndo(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > BuildMenu.MAX_UNDO) {
      this.undoStack = this.undoStack.slice(-BuildMenu.MAX_UNDO);
    }
    this.refreshUndoBtn();
  }

  /** Update the Undo button label + enabled state to reflect the stack. */
  private refreshUndoBtn(): void {
    if (!this.undoBtn) return;
    const n = this.undoStack.length;
    this.undoBtn.disabled = n === 0;
    this.undoBtn.style.opacity = n === 0 ? "0.45" : "1";
    this.undoBtn.textContent = n === 0 ? "↶ UNDO" : `↶ UNDO (${n})`;
  }

  /** Pop the latest undo entry and reverse its effect. */
  private runUndo(): void {
    const entry = this.undoStack.pop();
    this.refreshUndoBtn();
    if (!entry) return;
    if (entry.kind === "place") {
      const removed = this.registry.removeAtByUid(entry.uid);
      if (removed) {
        this.game.economy.earnMoney(entry.refundCost, "refund");
        this.flashRoot(`Undid place — refunded $${entry.refundCost}`);
      }
      return;
    }
    if (entry.kind === "sell") {
      const def = furnitureCatalog.find((d) => d.id === entry.defId);
      if (!def) return;
      // Charge back the refund the player got, then re-spawn the item.
      this.game.economy.charge(entry.refundPaid);
      void this.loader.load(def.modelPath).then((solid) => {
        fitFurniture(solid, def);
        solid.position.set(entry.x, solid.position.y, entry.z);
        solid.rotation.y = entry.rotY;
        this.scene.add(solid);
        this.registry.register(def.id, entry.x, entry.z, entry.rotY, solid);
      });
      this.flashRoot(`Undid sell — paid back $${entry.refundPaid}`);
      return;
    }
    if (entry.kind === "move") {
      this.registry.setPose(entry.uid, entry.fromX, entry.fromZ, entry.fromRotY);
      this.flashRoot("Undid move");
      return;
    }
    if (entry.kind === "auto-arrange") {
      for (const m of entry.moves) {
        this.registry.setPose(m.uid, m.fromX, m.fromZ, m.fromRotY);
      }
      this.flashRoot(`Undid auto-arrange (${entry.moves.length} chairs)`);
      return;
    }
  }

  /** Snap every chair to its nearest free seat slot via the registry, then
   * record the moves so they can be undone as a single action. */
  private runAutoArrange(): void {
    // Capture pre-state so undo can reverse the batch.
    const preState = new Map<string, { x: number; z: number; rotY: number }>();
    for (const it of this.registry.snapshotItems()) {
      preState.set(it.uid, { x: it.x, z: it.z, rotY: it.rotY });
    }
    const moved = this.registry.autoArrangeChairs(2.0);
    if (moved === 0) {
      this.flashRoot("Every chair is already at a seat slot");
      return;
    }
    // Diff: keep only the items that actually moved.
    const moves: Array<{ uid: string; fromX: number; fromZ: number; fromRotY: number }> = [];
    for (const it of this.registry.snapshotItems()) {
      const before = preState.get(it.uid);
      if (!before) continue;
      if (before.x !== it.x || before.z !== it.z || before.rotY !== it.rotY) {
        moves.push({ uid: it.uid, fromX: before.x, fromZ: before.z, fromRotY: before.rotY });
      }
    }
    if (moves.length > 0) {
      this.pushUndo({ kind: "auto-arrange", moves });
    }
    this.flashRoot(`Auto-arranged ${moved} chair${moved === 1 ? "" : "s"}`);
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
    // Run the raycaster in placing / sell / move modes so we always
    // know which cell a click would hit.
    if (!this.placingDef && !this.sellMode && !this.moveMode) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    // Intersect with the y=0 ground plane.
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    this.hoverValid = this.raycaster.ray.intersectPlane(groundPlane, point) !== null;
    if (!this.hoverValid) return;
    // Snap to integer cells (1 cell = 1 world unit) for non-chair placement.
    this.hoverCell.set(Math.round(point.x), 0, Math.round(point.z));
    if (!this.preview || !this.placingDef) return;
    const plan = this.computePlacementPlan(this.placingDef, point);
    this.currentPlan = plan;
    // Apply the plan's pose to the preview so the user sees the snap.
    this.preview.position.set(plan.x, 0, plan.z);
    this.preview.rotation.y = plan.rotY;
    this.tintPreview(plan.quality);
  };

  /** Decide where the preview should land and how good that placement is.
   *
   * For chairs near a table seat slot we auto-snap to the slot (overriding
   * the user's snapped cell + the rotationY they pressed R for) and mark
   * GREEN. Otherwise we use the integer cell under the cursor and mark
   * YELLOW (or RED if blocked). */
  private computePlacementPlan(def: FurnitureDef, rawPoint: THREE.Vector3): PlacementPlan {
    const cellX = Math.round(rawPoint.x);
    const cellZ = Math.round(rawPoint.z);

    // Chair-specific: try to snap to the nearest empty seat slot. Use the
    // raw (unsnapped) pointer position so the chair "magnets" toward the
    // ideal pose even while the cursor is over the table itself.
    if (def.category === "chair") {
      const slot = this.registry.findNearestSeatSlot(rawPoint.x, rawPoint.z, 1.4);
      if (slot && slot.chairUid == null) {
        // Snap! Convert the slot's customer-facing direction into the
        // chair model's required rotY so the seat actually opens toward
        // the customer's correct facing.
        return {
          quality: "snap-perfect",
          x: slot.x, z: slot.z,
          rotY: FurnitureRegistry.chairRotForSlot(slot.facingY),
        };
      }
    }

    const blocked = this.registry.isOccupied(cellX, cellZ);
    if (blocked) {
      return { quality: "blocked", x: cellX, z: cellZ, rotY: this.rotationY };
    }
    return { quality: "ok", x: cellX, z: cellZ, rotY: this.rotationY };
  }

  /** Set every mesh on the preview to the quality color. Materials were
   * cloned at startPlacing time so this only affects the ghost. */
  private tintPreview(quality: PlacementQuality): void {
    if (!this.preview) return;
    // Red = blocked. Green = perfect snap. Yellow = ok but not optimal.
    const tint = quality === "blocked" ? 0xff5050
      : quality === "snap-perfect" ? 0x70e070
      : 0xffd47a;
    this.preview.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.MeshStandardMaterial;
        if (m && "color" in m && m.color) {
          m.color.set(tint);
        }
        if (m && "emissive" in m) {
          // A little glow on green/red so the state is unmistakable even
          // in busy lighting.
          (m.emissive as THREE.Color).setHex(
            quality === "blocked" ? 0x300000 :
            quality === "snap-perfect" ? 0x004400 :
            0x000000,
          );
        }
      }
    });
  }

  private onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    if (this.sellMode && this.hoverValid) {
      const x = Math.round(this.hoverCell.x);
      const z = Math.round(this.hoverCell.z);
      // Look up the item first so we can snapshot it for undo.
      const item = this.registry.findAt(x, z);
      if (!item) {
        this.flashRoot("Nothing to sell there");
        return;
      }
      const snapshot = { defId: item.defId, x: item.x, z: item.z, rotY: item.rotY };
      const removed = this.registry.removeAt(x, z);
      if (!removed) {
        this.flashRoot("Nothing to sell there");
        return;
      }
      this.game.economy.earnMoney(removed.refund, "payment");
      this.pushUndo({ kind: "sell", defId: snapshot.defId, x: snapshot.x, z: snapshot.z, rotY: snapshot.rotY, refundPaid: removed.refund });
      this.flashRoot(`Sold for $${removed.refund}`);
      return;
    }
    if (this.moveMode && this.hoverValid) {
      const x = Math.round(this.hoverCell.x);
      const z = Math.round(this.hoverCell.z);
      if (!this.holdingUid) {
        // First click: pick up whatever's here.
        const item = this.registry.findAt(x, z);
        if (!item) { this.flashRoot("Nothing to move there"); return; }
        this.holdingUid = item.uid;
        // Stash starting pose so undo can roll back to here.
        this.holdingFrom = { x: item.x, z: item.z, rotY: item.rotY };
        this.flashRoot(`Picked up — click destination`);
      } else {
        // Second click: drop at the new cell.
        const fromPose = this.holdingFrom!;
        const ok = this.registry.relocate(this.holdingUid, x, z);
        if (!ok) { this.flashRoot("Destination is occupied"); return; }
        this.pushUndo({ kind: "move", uid: this.holdingUid, fromX: fromPose.x, fromZ: fromPose.z, fromRotY: fromPose.rotY });
        this.holdingUid = null;
        this.holdingFrom = null;
        this.flashRoot("Moved");
      }
      return;
    }
    if (!this.placingDef || !this.preview || !this.hoverValid) return;
    const def = this.placingDef;
    const plan = this.currentPlan;
    if (!plan || plan.quality === "blocked") {
      this.flashRoot("Cell already occupied");
      return;
    }
    if (!this.game.economy.spendMoney(def.cost, "decor")) {
      this.flashRoot("Not enough money");
      return;
    }
    // Bake the preview into the scene using the plan's final pose (which
    // may be a slot-snapped chair pose, not the raw cursor cell).
    const placeX = plan.x, placeZ = plan.z, rotY = plan.rotY;
    const cost = def.cost;
    void this.loader.load(def.modelPath).then((solid) => {
      fitFurniture(solid, def);
      solid.position.set(placeX, solid.position.y, placeZ);
      solid.rotation.y = rotY;
      this.scene.add(solid);
      const uid = this.registry.register(def.id, placeX, placeZ, rotY, solid);
      this.pushUndo({ kind: "place", uid, defId: def.id, refundCost: cost });
    });
    if (plan.quality === "snap-perfect") {
      this.flashRoot("Perfect placement!");
    }
    // Keep placing more of the same — many people want to drop multiples
    // (e.g. 4 chairs around a table). Esc / right-click to stop.
  };
}
