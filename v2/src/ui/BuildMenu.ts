import * as THREE from "three";
import { furnitureCatalog, type FurnitureDef } from "../data/furnitureCatalog";
import type { ModelLoader } from "../assets/ModelLoader";
import type { Game } from "../game/Game";
import { FurnitureRegistry, footprintCells } from "../game/FurnitureRegistry";
import type { SeatMarkers } from "../scene/SeatMarkers";
import { fitFurniture, placementY } from "../assets/fitFurniture";

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

/** The fixed segments of the restaurant's exterior shell, taken from
 * WorldScene.addBuilding. Wall-mounted items (mirror, art, sconces)
 * snap to these in addition to player-placed partition walls. Each
 * segment is a 2-D line from (x1, z1) to (x2, z2) with a wall rotation
 * `rotY` matching how the corresponding mesh was authored (0 for walls
 * running along X, π/2 for walls running along Z). */
const EXTERIOR_WALL_SEGMENTS: readonly { x1: number; z1: number; x2: number; z2: number; rotY: number }[] = [
  // Back wall (horizontal, along X at z=-4.5).
  { x1: -4.5, z1: -4.5, x2:  5.5, z2: -4.5, rotY: 0 },
  // Left side wall (vertical, along Z at x=-4.5).
  { x1: -4.5, z1: -4.5, x2: -4.5, z2:  5.5, rotY: Math.PI / 2 },
  // Right side wall (vertical, along Z at x=5.5).
  { x1:  5.5, z1: -4.5, x2:  5.5, z2:  5.5, rotY: Math.PI / 2 },
  // Front-left segment (horizontal, along X at z=5.5, x from -4.5 to -0.5).
  { x1: -4.5, z1:  5.5, x2: -0.5, z2:  5.5, rotY: 0 },
  // Front-right segment (horizontal, along X at z=5.5, x from 0.5 to 5.5).
  { x1:  0.5, z1:  5.5, x2:  5.5, z2:  5.5, rotY: 0 },
];

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
  /** Latest furniture item the cursor is pointing AT (not the cell beneath
   * it). Sell/move pickup uses this so a click on a chair from an iso
   * angle hits the chair, not the floor patch past it. */
  private hoveredItemUid: string | null = null;
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
  /** Original pose of the item being moved, for undo + cancel-restore. */
  private holdingFrom: { x: number; z: number; rotY: number } | null = null;
  /** The actual placed model that's being carried — we hide it while the
   * preview ghost follows the cursor, and reveal it again on drop/cancel. */
  private movingOriginalModel: THREE.Object3D | null = null;
  /** Optional: gates the seat-slot markers so they only appear during
   * active place/move modes. Engine wires this in after construction. */
  seatMarkers?: SeatMarkers;
  /** Optional callback fired when the player places a door — Engine
   * uses this to re-capture the hinge panel ref for the open/close
   * animation and to punch a fresh gap in the front wall. */
  onDoorPlaced?: (model: THREE.Object3D) => void;
  /** Fired when a door is sold or undone, so the front wall can be
   * resealed where the door used to be. */
  onDoorRemoved?: (model: THREE.Object3D) => void;
  /** Optional callback fired when the player places a stove — Engine
   * pins the cooking flame to the new stove's measured top. */
  onStovePlaced?: (model: THREE.Object3D) => void;
  /** Fired whenever the player places (or restores) a lamp — Engine
   * forwards to WorldScene.registerLamp so the new lamp picks up the
   * night-cycle illumination. */
  onLampPlaced?: (model: THREE.Object3D) => void;
  /** Fired whenever a lamp is sold or undone, so the same registration
   * can be torn down. */
  onLampRemoved?: (model: THREE.Object3D) => void;

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
      "table", "chair", "stove", "counter", "wall", "door", "bathroom",
      "decoration", "plant", "lamp",
    ];
    const categoryLabels: Record<FurnitureDef["category"], string> = {
      table: "Tables", chair: "Chairs", stove: "Cooking", counter: "Counters",
      wall: "Walls & Partitions", door: "Doors & Windows", bathroom: "Bathroom",
      decoration: "Decor", plant: "Plants", lamp: "Lighting",
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
        // Clear the text content; we lay out name+cost on the left and
        // an optional badge on the right via inline child spans so the
        // button stays scannable for the player.
        btn.textContent = "";
        Object.assign(btn.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "6px",
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
        const nameSpan = document.createElement("span");
        nameSpan.textContent = `${def.name} — $${def.cost}`;
        btn.appendChild(nameSpan);
        if (def.surface === "drink") {
          // Coffee tables behave drinks-only; sofas / benches / corner
          // sofas are flagged purely so the player knows they belong in
          // a lounge setup. Either way the chip-style badge gives a
          // glance-read of "this is for the drink side".
          const badge = document.createElement("span");
          badge.textContent = "🥤 Drinks only";
          Object.assign(badge.style, {
            fontSize: "10px",
            padding: "1px 6px",
            borderRadius: "999px",
            background: "rgba(120, 180, 220, 0.18)",
            border: "1px solid rgba(120, 180, 220, 0.55)",
            color: "#c8e0f0",
            whiteSpace: "nowrap",
            letterSpacing: "0.02em",
          } as Partial<CSSStyleDeclaration>);
          btn.appendChild(badge);
        }
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
    // If we were mid-carry, snap the original back to its starting pose
    // (clean cancel).
    if (!this.moveMode && this.holdingUid && this.holdingFrom) {
      this.restoreMoveOriginal();
    }
    this.holdingUid = null;
    this.holdingFrom = null;
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
    // Show / hide the seat-slot markers — they're a placement aid only.
    this.seatMarkers?.setEnabled(this.moveMode || this.placingDef != null);
  }

  /** Restore the carried original to its starting pose + visibility, and
   * tear down the move preview. */
  private restoreMoveOriginal(): void {
    if (this.holdingUid && this.holdingFrom) {
      this.registry.setPose(this.holdingUid, this.holdingFrom.x, this.holdingFrom.z, this.holdingFrom.rotY);
    }
    if (this.movingOriginalModel) {
      this.movingOriginalModel.visible = true;
      this.movingOriginalModel = null;
    }
    this.cancelPreview();
  }

  /** Tear down whatever ghost preview is currently in the scene. */
  private cancelPreview(): void {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    this.placingDef = null;
    this.currentPlan = null;
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
        // Cancel order matters: if mid-carry, restore original first so
        // toggleMoveMode doesn't re-trigger restore against a stale state.
        if (this.holdingUid && this.holdingFrom) {
          this.restoreMoveOriginal();
          this.holdingUid = null;
          this.holdingFrom = null;
          this.flashRoot("Move cancelled", "info");
        } else {
          this.cancelPlacing();
        }
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
      this.flashRoot("Not enough money", "error");
      return;
    }
    if (this.sellMode) this.toggleSellMode(); // exit sell mode if entering place mode
    if (this.moveMode) this.toggleMoveMode();
    this.cancelPlacing();
    this.placingDef = def;
    this.preview = await this.makeGhostPreview(def);
    if (!this.preview) {
      this.placingDef = null;
      return;
    }
    this.scene.add(this.preview);
    // Surface seat-slot markers as a placement aid.
    this.seatMarkers?.setEnabled(true);
  }

  /** Synchronously clone an already-placed model into a translucent ghost.
   * Used for move-pickup so the ghost appears the same frame the original
   * hides — no async-load race that could leave the player staring at an
   * empty floor. */
  private cloneModelAsGhost(source: THREE.Object3D): THREE.Object3D {
    const ghost = source.clone(true);
    // Object3D.clone() copies the `visible` flag — and pickup code hides
    // the source BEFORE calling us. Without this force-visible pass,
    // every move-mode ghost rendered invisible and the player saw their
    // chair vanish for the duration of the move. Force-visible on the
    // root + all descendants so the ghost reliably renders regardless
    // of the source's current visibility state.
    ghost.visible = true;
    ghost.traverse((o) => {
      o.visible = true;
      if (o instanceof THREE.Mesh) {
        const cloneOne = (m: THREE.Material): THREE.Material => {
          const c = m.clone();
          c.transparent = true;
          c.opacity = 0.55;
          (c as THREE.Material).depthWrite = false;
          return c;
        };
        o.material = Array.isArray(o.material) ? o.material.map(cloneOne) : cloneOne(o.material);
        o.castShadow = false;
      }
    });
    return ghost;
  }

  /** Build a translucent ghost copy of the given item def for use as a
   * placement preview. Cloned materials so tinting the ghost doesn't
   * leak onto already-placed copies. */
  private async makeGhostPreview(def: FurnitureDef): Promise<THREE.Object3D | null> {
    try {
      const model = await this.loader.load(def.modelPath);
      fitFurniture(model, def);
      model.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const m = (o.material as THREE.Material).clone() as THREE.Material;
          m.transparent = true;
          m.opacity = 0.55;
          // Preview must not write depth — otherwise the floor markers
          // get z-occluded by the ghost when it's right over them.
          (m as THREE.Material).depthWrite = false;
          o.material = m;
          o.castShadow = false;
        }
      });
      return model;
    } catch (err) {
      console.warn("preview load failed:", err);
      return null;
    }
  }

  private cancelPlacing(): void {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview = null;
    }
    this.placingDef = null;
    this.currentPlan = null;
    // If nothing else needs the markers, hide them.
    if (!this.moveMode && this.holdingUid == null) {
      this.seatMarkers?.setEnabled(false);
    }
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
        this.flashRoot(`Undid place — refunded $${entry.refundCost}`, "info");
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
        solid.position.set(entry.x, placementY(solid, def), entry.z);
        solid.rotation.y = entry.rotY;
        this.scene.add(solid);
        this.registry.register(def.id, entry.x, entry.z, entry.rotY, solid);
      });
      this.flashRoot(`Undid sell — paid back $${entry.refundPaid}`, "info");
      return;
    }
    if (entry.kind === "move") {
      this.registry.setPose(entry.uid, entry.fromX, entry.fromZ, entry.fromRotY);
      this.flashRoot("Undid move", "info");
      return;
    }
    if (entry.kind === "auto-arrange") {
      for (const m of entry.moves) {
        this.registry.setPose(m.uid, m.fromX, m.fromZ, m.fromRotY);
      }
      this.flashRoot(`Undid auto-arrange (${entry.moves.length} chairs)`, "info");
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
      this.flashRoot("Every chair is already at a seat slot", "info");
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
    this.flashRoot(`Auto-arranged ${moved} chair${moved === 1 ? "" : "s"}`, "success");
  }

  private flashRoot(msg: string, kind: "info" | "success" | "error" = "info"): void {
    const old = this.root.style.background;
    const bg =
      kind === "success" ? "rgba(40, 110, 50, 0.85)" :
      kind === "error" ? "rgba(140, 30, 30, 0.85)" :
      "rgba(50, 80, 110, 0.85)";
    const textColor =
      kind === "success" ? "#d6f0c8" :
      kind === "error" ? "#ffd0d0" :
      "#d4e3ee";
    this.root.style.background = bg;
    const note = document.createElement("div");
    note.textContent = msg;
    note.style.marginTop = "6px";
    note.style.color = textColor;
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
    // Intersect with the y=0 ground plane (used for placement + drop).
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    this.hoverValid = this.raycaster.ray.intersectPlane(groundPlane, point) !== null;
    if (!this.hoverValid) return;
    // Snap differently for edge-placed items (walls / internal doorways
    // sit on grid lines) vs tile items (centered in cells).
    if (this.placingDef?.placement === "edge") {
      const e = this.snapToEdge(point.x, point.z);
      this.hoverCell.set(e.x, 0, e.z);
    } else {
      // Even-sized tile items anchor at the cross-section of cells, so
      // they need a half-integer snap — otherwise their footprint
      // straddles cells unevenly. Use the placingDef's size to pick
      // the parity.
      this.hoverCell.set(this.snapAxis(point.x, this.placingDef?.size.width ?? 1), 0,
                         this.snapAxis(point.z, this.placingDef?.size.depth ?? 1));
    }

    // Pickup-mode raycast: while the player is in sell or move-pickup,
    // they're aiming AT items (not floor cells). With an iso camera, a
    // ground-plane hit lands past the chair the user clicked, so a strict
    // findAt(floor-x, floor-z) misses by a wide margin. Instead, raycast
    // against placed furniture meshes directly.
    this.hoveredItemUid = null;
    const wantsItem = this.sellMode || (this.moveMode && !this.holdingUid);
    if (wantsItem) {
      const items = this.registry.snapshotItems();
      if (items.length > 0) {
        const roots = items.map((it) => it.model);
        const hits = this.raycaster.intersectObjects(roots, true);
        if (hits.length > 0) {
          let hitRoot: THREE.Object3D | null = hits[0].object;
          while (hitRoot && !roots.includes(hitRoot)) hitRoot = hitRoot.parent;
          if (hitRoot) {
            const matched = items.find((it) => it.model === hitRoot);
            if (matched) {
              this.hoveredItemUid = matched.uid;
              // Pretend the hover-cell is the item's own center so the
              // visual placement-quality tint of the existing ghost (if
              // any) tracks the would-be pickup.
              this.hoverCell.set(matched.x, 0, matched.z);
            }
          }
        }
      }
    }

    if (!this.preview || !this.placingDef) return;
    const plan = this.computePlacementPlan(this.placingDef, point);
    this.currentPlan = plan;
    // Apply the plan's pose to the preview so the user sees the snap.
    // placementY picks the right Y for each placement kind: floor at 0,
    // wall items at chest height, ceiling items hanging from y=3 so
    // their top touches the ceiling.
    const previewY = placementY(this.preview, this.placingDef);
    this.preview.position.set(plan.x, previewY, plan.z);
    this.preview.rotation.y = plan.rotY;
    this.tintPreview(plan.quality);
  };

  /** Snap a single world-axis to the correct cell anchor for an item of
   * the given size on that axis. Odd sizes (1, 3, ...) anchor at tile
   * centers (integer coords); even sizes (2, 4) anchor at cross-sections
   * (half-integer coords). Without the parity split, a 2×2 table would
   * land on a single tile center and visibly straddle three tiles. */
  private snapAxis(value: number, size: number): number {
    if (size % 2 === 0) return Math.round(value - 0.5) + 0.5;
    return Math.round(value);
  }

  /** Decide where the preview should land and how good that placement is.
   *
   * For chairs near a table seat slot we auto-snap to the slot (overriding
   * the user's snapped cell + the rotationY they pressed R for) and mark
   * GREEN. Otherwise we use the integer cell under the cursor and mark
   * YELLOW (or RED if blocked). */
  private computePlacementPlan(def: FurnitureDef, rawPoint: THREE.Vector3): PlacementPlan {
    // Edge-placed items (walls, internal doorways, partitions, the
    // front door) snap to grid LINES rather than tile centers. The
    // wall sits between two adjacent cells; both cells stay usable.
    // rotY swings 90° so the mesh aligns with the edge direction.
    if (def.placement === "edge") {
      const e = this.snapToEdge(rawPoint.x, rawPoint.z);
      // For front doors specifically: only allow placement when the
      // snapped edge actually coincides with an exterior wall segment.
      // Stops the player from dropping a "front door" floating between
      // tiles in the middle of the restaurant.
      if (def.category === "door") {
        const onPerimeter = this.isOnPerimeterWall(e.x, e.z);
        if (!onPerimeter) {
          return { quality: "blocked", x: e.x, z: e.z, rotY: e.rotY };
        }
      }
      // No tile-overlap check — walls don't claim a tile.
      return { quality: "ok", x: e.x, z: e.z, rotY: e.rotY };
    }
    // Wall-mounted items (mirror, art, signage, sconces) need an
    // existing placed wall to attach to. Find the nearest one and use
    // its anchor + rotation. Mark blocked if no wall is within reach
    // so the player gets an immediate red preview.
    if (def.placement === "wall") {
      const host = this.findNearestWall(rawPoint.x, rawPoint.z, 1.8);
      if (host) {
        return { quality: "snap-perfect", x: host.x, z: host.z, rotY: host.rotY };
      }
      return { quality: "blocked", x: rawPoint.x, z: rawPoint.z, rotY: this.rotationY };
    }

    const cellX = this.snapAxis(rawPoint.x, def.size.width);
    const cellZ = this.snapAxis(rawPoint.z, def.size.depth);
    // When moving an existing item, ignore that item in every overlap /
    // slot-occupancy check — otherwise it would falsely block its own
    // destination.
    const excludeUid = this.holdingUid ?? undefined;

    // Chair-specific: try to snap a 1×1 chair to the nearest empty seat
    // slot. Use the raw (unsnapped) pointer position so the chair
    // "magnets" toward the ideal pose even while the cursor is over the
    // table itself. Multi-tile chairs (sofas, benches) deliberately
    // skip this — their footprint anchor is a half-integer cross and
    // snapping to a slot's integer position would make them visually
    // overhang into the table. The player drops them on the grid and
    // the footprint-aware slot detection picks up the seats they cover.
    if (def.category === "chair" && def.size.width === 1 && def.size.depth === 1) {
      const slot = this.registry.findNearestSeatSlot(rawPoint.x, rawPoint.z, 1.4, excludeUid);
      if (slot && slot.chairUid == null) {
        return {
          quality: "snap-perfect",
          x: slot.x, z: slot.z,
          rotY: FurnitureRegistry.chairRotForSlot(slot.facingY),
        };
      }
    }

    // Footprint-aware occupancy check. Enumerate the cells this item
    // would actually cover (honouring L-shape masks + rotation) and
    // make sure every one of them is clear on the right layer. The
    // legacy single-point isOccupied was too coarse for multi-tile
    // L-shapes — a corner sofa wrapping a coffee table would see the
    // table inside its 0.6 tolerance and report "blocked" even though
    // the table sat in the sofa's open elbow (mask = 0).
    const layer: "tile" | "ceiling" = def.placement === "ceiling" ? "ceiling" : "tile";
    const previewCells = footprintCells({ x: cellX, z: cellZ, rotY: this.rotationY }, def);
    for (const cell of previewCells) {
      if (this.registry.isCellBlocked(cell.x, cell.z, excludeUid, layer)) {
        return { quality: "blocked", x: cellX, z: cellZ, rotY: this.rotationY };
      }
    }
    return { quality: "ok", x: cellX, z: cellZ, rotY: this.rotationY };
  }

  /** Find the nearest wall to the cursor — either a player-placed
   * partition (registry, placement="edge") or one of the building's
   * exterior walls — and return a mount anchor + rotation for a
   * wall-mounted item. The mount picks the FACE of the wall the cursor
   * is on, so the same wall can hold items on both sides. Returns null
   * if nothing is within maxDist. */
  private findNearestWall(x: number, z: number, maxDist: number): { x: number; z: number; rotY: number } | null {
    let bestDistSq = maxDist * maxDist;
    // Best hit: anchor (mount point on the wall plane) + rotY (the wall's
    // own orientation, which we use to derive its normals below).
    let best: { x: number; z: number; rotY: number } | null = null;

    // 1) Player-placed partition walls (registry items with placement
    //    "edge"). These are anchored at their own centers — a single
    //    point per wall.
    for (const it of this.registry.snapshotItems()) {
      if (this.holdingUid && it.uid === this.holdingUid) continue;
      const itDef = furnitureCatalog.find((d) => d.id === it.defId);
      if (!itDef || itDef.placement !== "edge") continue;
      const dx = it.x - x, dz = it.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = { x: it.x, z: it.z, rotY: it.rotY };
      }
    }

    // 2) Exterior building walls. These are long segments, not points,
    //    so we project the cursor onto each segment and take the
    //    closest point along its length.
    for (const seg of EXTERIOR_WALL_SEGMENTS) {
      const sx = seg.x2 - seg.x1, sz = seg.z2 - seg.z1;
      const segLen2 = sx * sx + sz * sz;
      // Parametric position along segment: 0 = start, 1 = end.
      const t = Math.max(0, Math.min(1, ((x - seg.x1) * sx + (z - seg.z1) * sz) / segLen2));
      const px = seg.x1 + sx * t;
      const pz = seg.z1 + sz * t;
      const dx = px - x, dz = pz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = { x: px, z: pz, rotY: seg.rotY };
      }
    }

    if (!best) return null;

    // Wall's two normals: rotY=0 wall extends along X with normals on
    // ±Z; rotY=π/2 wall extends along Z with normals on ±X. Pick the
    // side the cursor is on.
    const wallNormalX = Math.sin(best.rotY);
    const wallNormalZ = Math.cos(best.rotY);
    const proj = (x - best.x) * wallNormalX + (z - best.z) * wallNormalZ;
    const sign = proj >= 0 ? 1 : -1;
    const mountNX = wallNormalX * sign;
    const mountNZ = wallNormalZ * sign;
    // Push the item a hair off the wall plane so its own depth doesn't
    // z-fight with the wall geometry.
    const off = 0.07;
    return {
      x: best.x + mountNX * off,
      z: best.z + mountNZ * off,
      // Item's GLB front is -Z (three.js standard); rotate so its
      // visible front aligns with the mount normal. The required θ for
      // R_y(θ) * (0, 0, -1) = (mountNX, 0, mountNZ) is
      // atan2(-mountNX, -mountNZ). Earlier this used atan2(-mountNZ, mountNX)
      // which assumed a +X-front GLB and produced items perpendicular
      // to the wall.
      rotY: Math.atan2(-mountNX, -mountNZ),
    };
  }

  /** True if a snapped edge anchor (x, z) sits on one of the exterior
   * wall PLANES — used to gate front-door placement so the player
   * can't drop a door in the middle of the floor. Note this checks
   * the plane, not the segment list, because the front wall is now
   * rebuilt around every placed door — the gap left by the demo door
   * isn't an "off the wall" position, it's just where the existing
   * door already lives. */
  private isOnPerimeterWall(x: number, z: number): boolean {
    const TOL = 0.05;
    const X_MIN = -4.5, X_MAX = 5.5;
    const Z_MIN = -4.5, Z_MAX = 5.5;
    // Back / front horizontal walls.
    if (Math.abs(z - Z_MIN) < TOL && x >= X_MIN - TOL && x <= X_MAX + TOL) return true;
    if (Math.abs(z - Z_MAX) < TOL && x >= X_MIN - TOL && x <= X_MAX + TOL) return true;
    // Left / right vertical walls.
    if (Math.abs(x - X_MIN) < TOL && z >= Z_MIN - TOL && z <= Z_MAX + TOL) return true;
    if (Math.abs(x - X_MAX) < TOL && z >= Z_MIN - TOL && z <= Z_MAX + TOL) return true;
    return false;
  }

  /** Snap a raw cursor position to the nearest grid edge for "edge"
   * placement (walls, internal doorways). Picks horizontal vs vertical
   * orientation based on which axis is closer to a half-integer line.
   *
   *   - Horizontal edge (between cells differing in Z): rotY = 0,
   *     mesh runs along X. Anchor at (integer X, half-integer Z).
   *   - Vertical edge (between cells differing in X): rotY = π/2,
   *     mesh runs along Z. Anchor at (half-integer X, integer Z).
   *
   * The mesh is authored 1 tile long, so a snapped edge anchor lines
   * the wall up exactly between two cell centers. */
  private snapToEdge(rawX: number, rawZ: number): { x: number; z: number; rotY: number } {
    const fracX = rawX - Math.floor(rawX); // 0..1
    const fracZ = rawZ - Math.floor(rawZ);
    // Distance from each axis's nearest 0.5 (mid-cell line).
    const distVertical = Math.abs(fracX - 0.5);
    const distHorizontal = Math.abs(fracZ - 0.5);
    if (distVertical < distHorizontal) {
      // Closer to a vertical grid line — place a vertical wall (runs
      // along Z). Snap X to nearest half-integer, Z to integer.
      return {
        x: Math.floor(rawX) + 0.5,
        z: Math.round(rawZ),
        rotY: Math.PI / 2,
      };
    }
    return {
      x: Math.round(rawX),
      z: Math.floor(rawZ) + 0.5,
      rotY: 0,
    };
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
      // Prefer the item under the cursor (raycaster hit) over a floor-cell
      // search, since iso-projection often misses by 1-2 cells.
      const item = this.hoveredItemUid
        ? this.registry.snapshotItems().find((it) => it.uid === this.hoveredItemUid) ?? null
        : this.registry.findAt(Math.round(this.hoverCell.x), Math.round(this.hoverCell.z));
      if (!item) {
        this.flashRoot("Nothing to sell there", "error");
        return;
      }
      const snapshot = { defId: item.defId, x: item.x, z: item.z, rotY: item.rotY };
      // Capture the model BEFORE removeAtByUid drops it from the scene
      // so we can tear down its lamp registration if applicable.
      const itemModel = item.model;
      const itemDef = furnitureCatalog.find((d) => d.id === item.defId);
      const removed = this.registry.removeAtByUid(item.uid);
      if (!removed) {
        this.flashRoot("Nothing to sell there", "error");
        return;
      }
      if (itemDef?.category === "lamp") this.onLampRemoved?.(itemModel);
      if (itemDef?.category === "door") this.onDoorRemoved?.(itemModel);
      this.game.economy.earnMoney(removed.refund, "payment");
      this.pushUndo({ kind: "sell", defId: snapshot.defId, x: snapshot.x, z: snapshot.z, rotY: snapshot.rotY, refundPaid: removed.refund });
      this.flashRoot(`Sold for $${removed.refund}`, "success");
      return;
    }
    if (this.moveMode && this.hoverValid) {
      if (!this.holdingUid) {
        // First click: pick up whatever's under the cursor (raycaster hit
        // takes priority over the floor-cell fallback for iso angles).
        const item = this.hoveredItemUid
          ? this.registry.snapshotItems().find((it) => it.uid === this.hoveredItemUid) ?? null
          : this.registry.findAt(Math.round(this.hoverCell.x), Math.round(this.hoverCell.z));
        if (!item) { this.flashRoot("Nothing to move there", "error"); return; }
        this.holdingUid = item.uid;
        this.holdingFrom = { x: item.x, z: item.z, rotY: item.rotY };
        this.movingOriginalModel = item.model;
        const def = furnitureCatalog.find((d) => d.id === item.defId);
        if (def) {
          this.placingDef = def;
          this.rotationY = item.rotY;
          // Build the ghost SYNCHRONOUSLY from the actual placed model so
          // it appears immediately — no async load race that could leave
          // the original hidden with no preview. Clone BEFORE hiding the
          // source so the cloned `visible` flag stays true (the helper
          // still force-sets visible, but doing this in the right order
          // means the ghost is correct even if the helper is later
          // refactored).
          const ghost = this.cloneModelAsGhost(item.model);
          this.preview = ghost;
          this.preview.position.set(item.x, this.preview.position.y, item.z);
          this.preview.rotation.y = item.rotY;
          this.scene.add(this.preview);
          this.tintPreview("snap-perfect"); // at start, sits at its current valid pose
        }
        // Now hide the original — done after cloning so the clone above
        // never inherited an invisible source.
        item.model.visible = false;
        this.flashRoot(`Picked up — click destination`, "success");
      } else {
        // Second click: drop using the latest plan from pointermove.
        const plan = this.currentPlan;
        if (!plan || plan.quality === "blocked") {
          this.flashRoot("Destination is blocked", "error");
          return;
        }
        const fromPose = this.holdingFrom!;
        this.registry.setPose(this.holdingUid, plan.x, plan.z, plan.rotY);
        if (this.movingOriginalModel) {
          this.movingOriginalModel.visible = true;
          this.movingOriginalModel = null;
        }
        this.cancelPreview();
        this.pushUndo({ kind: "move", uid: this.holdingUid, fromX: fromPose.x, fromZ: fromPose.z, fromRotY: fromPose.rotY });
        this.holdingUid = null;
        this.holdingFrom = null;
        this.flashRoot(plan.quality === "snap-perfect" ? "Moved — perfect seat!" : "Moved", "success");
      }
      return;
    }
    if (!this.placingDef || !this.preview || !this.hoverValid) return;
    const def = this.placingDef;
    const plan = this.currentPlan;
    if (!plan || plan.quality === "blocked") {
      this.flashRoot("Cell already occupied", "error");
      return;
    }
    if (!this.game.economy.spendMoney(def.cost, "decor")) {
      this.flashRoot("Not enough money", "error");
      return;
    }
    // Bake the preview into the scene using the plan's final pose (which
    // may be a slot-snapped chair pose, not the raw cursor cell).
    const placeX = plan.x, placeZ = plan.z, rotY = plan.rotY;
    const cost = def.cost;
    void this.loader.load(def.modelPath).then((solid) => {
      fitFurniture(solid, def);
      // placementY picks the right Y per placement kind: 0 for floor
      // items, 1.5 for wall sconces, CEILING_Y minus the model height
      // for ceiling items so the model TOP touches the ceiling and the
      // body hangs below. Was hardcoded to wall-only before — ceiling
      // lamps landed at y=0 (on the floor) instead of overhead.
      solid.position.set(placeX, placementY(solid, def), placeZ);
      solid.rotation.y = rotY;
      this.scene.add(solid);
      const uid = this.registry.register(def.id, placeX, placeZ, rotY, solid);
      this.pushUndo({ kind: "place", uid, defId: def.id, refundCost: cost });
      if (def.category === "door") this.onDoorPlaced?.(solid);
      if (def.id === "stove" || def.id === "stove-electric") this.onStovePlaced?.(solid);
      if (def.category === "lamp") this.onLampPlaced?.(solid);
    });
    if (plan.quality === "snap-perfect") {
      this.flashRoot("Perfect placement!", "success");
    }
    // Keep placing more of the same — many people want to drop multiples
    // (e.g. 4 chairs around a table). Esc / right-click to stop.
  };
}
