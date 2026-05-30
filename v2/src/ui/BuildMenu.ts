import * as THREE from "three";
import { furnitureCatalog, inferQualityTier, type FurnitureDef } from "../data/furnitureCatalog";
import type { LuxuryTier } from "../data/types";
import type { ModelLoader } from "../assets/ModelLoader";
import type { Game } from "../game/Game";
import { FurnitureRegistry, footprintCells } from "../game/FurnitureRegistry";
import type { SeatMarkers } from "../scene/SeatMarkers";
import { fitFurniture, placementY, defHeight, snapToAdjacentWall, WALL_SHELF_MAX_BELOW_HEIGHT } from "../assets/fitFurniture";
import { attachTooltip } from "./tooltip";

/** A single user action that can be undone. The BuildMenu records one of
 * these for every place / sell / move / auto-arrange, capped at MAX_UNDO. */
type UndoEntry =
  | { kind: "place"; uid: string; defId: string; refundCost: number }
  | { kind: "sell"; defId: string; x: number; z: number; rotY: number; refundPaid: number; floor: number }
  | { kind: "move"; uid: string; fromX: number; fromZ: number; fromRotY: number; fromFloor: number }
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
  /** Surface placement: the host item the surface item will sit on. */
  hostUid?: string;
  /** Surface placement: which slot on the host. */
  slotIndex?: number;
  /** Surface placement: Y of the host's top so the preview/place can
   * land at the right height. */
  hostTopY?: number;
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
  /** Floor-relative Y the preview should sit at, captured once when the
   * ghost is constructed (and again on a move-mode pickup). Without
   * this, calling placementY(preview, def) each pointer-move would
   * read the model's current position.y as the "default" and the
   * Floor N offset would compound — Y growing by storeyHeight every
   * frame and shoving the ghost out of view. */
  private previewBaseY = 0;
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
  /** Public read of holdingUid — Engine uses this to exclude the held
   * window / door from the perimeter-wall opening derivation while it
   * floats with the cursor, so the wall fills back in mid-move instead
   * of keeping a hole at the old position. */
  get heldUid(): string | null { return this.holdingUid; }
  /** Original pose of the item being moved, for undo + cancel-restore. */
  private holdingFrom: { x: number; z: number; rotY: number; floor: number } | null = null;
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
  /** Fired when a window is placed / removed. Engine forwards to
   * WorldScene's rebuildAllPerimeterWalls so the wall opens a sill +
   * lintel cut for the new window and you can see through it from
   * either side. */
  onWindowPlaced?: (model: THREE.Object3D) => void;
  onWindowRemoved?: (model: THREE.Object3D) => void;
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
  /** Returns the storey index the camera is currently focused on. New
   * placements + the raycast plane both use this. Defaults to ground
   * floor when the callback isn't wired up. */
  getFocusedStorey?: () => number;
  /** Returns the THREE container new placements on `floor` should be
   * parented into. Engine wires this to WorldScene.getStoreyMount so
   * upper-floor items inherit the storey group's visibility. */
  getStoreyMount?: (floor: number) => THREE.Object3D;
  /** Meters between adjacent floor slabs — used for the raycast plane Y
   * and the placement Y offset. Defaults to 3 m to match WorldScene. */
  getStoreyHeight?: () => number;

  /** Foldable state — when collapsed only the title bar shows. */
  private collapsed = false;
  /** Which tier tab is currently active. */
  private selectedTier: LuxuryTier = 1;
  /** Title bar DOM element — text + arrow updated on collapse toggle. */
  private titleEl?: HTMLDivElement;
  /** Body wrapper holding the tier tabs + content. Hidden when collapsed. */
  private bodyEl?: HTMLDivElement;
  /** Tier tab row — rebuilt on tier change to update the active highlight. */
  private tierTabsEl?: HTMLDivElement;
  /** Content area — rebuilt each time the selected tier changes. */
  private tierContentEl?: HTMLDivElement;

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
    this.buildPanel(parent);
    this.attachInput();
  }

  private buildPanel(parent: HTMLElement): HTMLElement {
    const root = document.createElement("div");
    Object.assign(root.style, {
      position: "fixed",
      top: "12px",
      right: "12px",
      width: "260px",
      // Fill the full right edge of the viewport when expanded — the
      // PantryPanel at bottom-right is short enough that the player
      // can scroll past it inside the build menu's own scroll area.
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

    // Title bar — clickable to collapse / expand. Mirrors MenuPanel's
    // affordance so the player has a single collapse pattern across
    // both center-bottom and top-right panels.
    const title = document.createElement("div");
    Object.assign(title.style, {
      fontSize: "14px", fontWeight: "600",
      marginBottom: "0",
      cursor: "pointer",
      userSelect: "none",
      display: "flex", alignItems: "center", justifyContent: "space-between",
    } as Partial<CSSStyleDeclaration>);
    title.onclick = () => this.toggleCollapsed();
    root.appendChild(title);
    this.titleEl = title;
    attachTooltip(title,
      "BUILD menu — place, move, and sell furniture.\n" +
      "Pick a tier (T1 cheap basics → T5 luxury) and a category to see what's available. " +
      "Click an item, then click a tile to place it. Press R to rotate, Esc to cancel.\n" +
      "SELL refunds 50% of an item's cost; MOVE picks up an item to drop somewhere else; " +
      "AUTO-ARRANGE snaps loose chairs to the nearest table seat. UNDO reverts the last 5 build actions."
    );

    // Body holds the tier tabs + content + action buttons. Toggled by
    // the collapse flag.
    const body = document.createElement("div");
    Object.assign(body.style, { marginTop: "10px" } as Partial<CSSStyleDeclaration>);
    root.appendChild(body);
    this.bodyEl = body;

    // Tier tab strip — 5 buttons, same affordance as MenuPanel's tier
    // tabs. Re-render the content below whenever the active tier
    // changes.
    const tierTabs = document.createElement("div");
    Object.assign(tierTabs.style, {
      display: "flex", gap: "3px", marginBottom: "8px",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(tierTabs);
    this.tierTabsEl = tierTabs;

    // Content area populated per tier — categories collapsible inside.
    const tierContent = document.createElement("div");
    body.appendChild(tierContent);
    this.tierContentEl = tierContent;

    this.refreshTitle();
    this.renderTierTabs();
    this.renderTierContent();

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
    body.appendChild(actionRow);

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
    body.appendChild(actionRow2);

    const hint = document.createElement("div");
    hint.innerHTML = `Click item → click floor to place. R = rotate. Esc = cancel.<br/>
      Preview tints: <span style="color:#70e070">green</span> = perfect (chair snapped to a table seat),
      <span style="color:#ffd47a">yellow</span> = OK, <span style="color:#ff5050">red</span> = blocked.`;
    Object.assign(hint.style, { marginTop: "8px", opacity: "0.85", fontSize: "10px", lineHeight: "1.35" } as Partial<CSSStyleDeclaration>);
    body.appendChild(hint);

    return root;
  }

  /** Toggle the build menu open/closed and refresh the title chevron. */
  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    if (this.bodyEl) this.bodyEl.style.display = this.collapsed ? "none" : "block";
    this.refreshTitle();
    // Re-render the tier content whenever we OPEN the panel so every
    // category dropdown resets to its default (collapsed) state. The
    // per-category open/closed flag lives inside renderTierContent's
    // closure, so a fresh render is the cleanest "forget what was
    // expanded" path — same effect as toggling tiers.
    if (!this.collapsed) this.renderTierContent();
  }

  /** Sync the title text with the collapse state. */
  private refreshTitle(): void {
    if (!this.titleEl) return;
    const arrow = this.collapsed ? "▾" : "▴";
    const hint = this.collapsed ? " (click to expand)" : "";
    this.titleEl.innerHTML = `<span>BUILD ${arrow}${hint}</span>`;
  }

  /** Re-render the tier tab row, highlighting the active tier. The
   * tier is purely organisational right now — no items are locked
   * behind the player's current luxury tier, the tabs just slice the
   * catalog by quality so the prestige furniture has a dedicated
   * shelf instead of being lost in a long alphabetical list. */
  private renderTierTabs(): void {
    if (!this.tierTabsEl) return;
    this.tierTabsEl.innerHTML = "";
    for (let t = 1; t <= 5; t += 1) {
      const tier = t as LuxuryTier;
      const active = tier === this.selectedTier;
      const count = furnitureCatalog.filter((d) => inferQualityTier(d) === tier).length;
      const btn = document.createElement("button");
      btn.textContent = `T${t}`;
      btn.title = `Tier ${t} — ${count} item${count === 1 ? "" : "s"}`;
      Object.assign(btn.style, {
        flex: "1",
        padding: "5px 0",
        background: active ? "rgba(120, 200, 120, 0.30)" : "rgba(255,245,220,0.08)",
        color: "#fff5dc",
        border: active ? "1px solid rgba(120, 200, 120, 0.7)" : "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px",
        cursor: "pointer",
        font: "inherit", fontSize: "11px",
        fontWeight: active ? "700" : "500",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => {
        this.selectedTier = tier;
        this.renderTierTabs();
        this.renderTierContent();
      };
      this.tierTabsEl.appendChild(btn);
    }
  }

  /** Re-render the content area for the active tier — categories
   * with item buttons. EVERY category is rendered for every tier so the
   * player sees the full taxonomy at a glance — empty (Cat, 0) sections
   * collapsed and labelled "no items yet" — instead of having to guess
   * which buckets the game even supports. Category sections stay
   * collapsible so a tier with lots of items doesn't dominate the panel. */
  private renderTierContent(): void {
    if (!this.tierContentEl) return;
    this.tierContentEl.innerHTML = "";
    const categoryOrder: FurnitureDef["category"][] = [
      "table", "chair", "stove", "wash", "appliance", "counter", "storage",
      "wall", "door", "bathroom", "decoration", "plant", "lamp",
    ];
    const categoryLabels: Record<FurnitureDef["category"], string> = {
      table: "Tables", chair: "Chairs", stove: "Cooking", wash: "Dishwashing",
      appliance: "Appliances", counter: "Counters", storage: "Storage",
      wall: "Walls & Partitions", door: "Doors & Windows",
      bathroom: "Bathroom", decoration: "Decor", plant: "Plants", lamp: "Lighting",
    };
    // Every category starts collapsed — the panel now fills the full
    // right edge of the viewport, so the player skim-reads the headers
    // and expands what they care about instead of having one section
    // pre-opened to set the scroll position.
    for (const cat of categoryOrder) {
      const items = furnitureCatalog.filter(
        (d) => d.category === cat && inferQualityTier(d) === this.selectedTier,
      );
      const empty = items.length === 0;
      let open = false;
      const header = document.createElement("div");
      Object.assign(header.style, {
        marginTop: "8px",
        marginBottom: "3px",
        padding: "3px 4px",
        fontSize: "11px",
        fontWeight: "700",
        // Dim empty headers so the eye can skip them — but keep the row
        // visible so the player knows the category exists in this tier.
        opacity: empty ? "0.45" : "0.85",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        cursor: "pointer",
        background: "rgba(255,245,220,0.05)",
        borderRadius: "3px",
        userSelect: "none",
      } as Partial<CSSStyleDeclaration>);
      const itemsWrap = document.createElement("div");
      itemsWrap.style.display = open ? "block" : "none";
      const refreshHeader = (): void => {
        header.textContent = `${open ? "▾" : "▸"} ${categoryLabels[cat]} (${items.length})`;
      };
      refreshHeader();
      header.onclick = () => {
        open = !open;
        itemsWrap.style.display = open ? "block" : "none";
        refreshHeader();
      };
      this.tierContentEl.appendChild(header);
      if (empty) {
        const placeholder = document.createElement("div");
        placeholder.textContent = "no items in this tier yet";
        Object.assign(placeholder.style, {
          opacity: "0.5",
          fontStyle: "italic",
          fontSize: "11px",
          padding: "4px 6px 6px 14px",
        } as Partial<CSSStyleDeclaration>);
        itemsWrap.appendChild(placeholder);
      } else {
        for (const def of items) this.appendItemButton(itemsWrap, def);
      }
      this.tierContentEl.appendChild(itemsWrap);
    }
  }

  /** Render a single catalog row inside a category section. Same
   * button layout the panel had before (name + cost on the left, drink
   * badge on the right), just factored out so renderTierContent can
   * reuse it. */
  private appendItemButton(into: HTMLElement, def: FurnitureDef): void {
    const btn = document.createElement("button");
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
    into.appendChild(btn);
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
      // Restore the original storey so a Floor-1 → ground cancel
      // doesn't leave the item floating at Y=0 on the upper-floor slab.
      this.registry.setItemFloor(this.holdingUid, this.holdingFrom.floor);
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
        // Wall / wall-shelf items have their rotation FORCED by the wall
        // they snap to — R must not change them. The old code patched
        // currentPlan.rotY for every placement type, and a click before
        // the next pointer-move snapped the rotation back; clicks
        // immediately after R placed the item perpendicular to the wall
        // (bbox piercing through the wall, mesh sticking into the room).
        const placement = this.placingDef?.placement ?? "tile";
        const wallLocked = placement === "wall" || placement === "wall-shelf";
        if (wallLocked) {
          // Swallow R for wall items — preview already shows the forced
          // orientation and clicks should honour that, not the player's
          // accumulated rotationY.
          return;
        }
        this.rotationY = (this.rotationY + Math.PI / 2) % (Math.PI * 2);
        // Patch currentPlan too — otherwise a click immediately after R
        // (no mouse move in between) consumes the plan that
        // onPointerMove captured at the OLD rotation, and the item lands
        // facing the original direction even though the preview looks
        // rotated. Adding π/2 mirrors the same delta that just went
        // into this.rotationY, so the formula
        //   tile items:    plan.rotY = this.rotationY
        //   surface items: plan.rotY = snap.rotY + this.rotationY
        // both stay in sync.
        if (this.currentPlan) {
          this.currentPlan.rotY = (this.currentPlan.rotY + Math.PI / 2) % (Math.PI * 2);
          this.preview.rotation.y = this.currentPlan.rotY;
        } else {
          this.preview.rotation.y = this.rotationY;
        }
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
    // Cache the floor-relative placement Y NOW — the model.position.y
    // is still at fitFurniture's baseline. Reading it later (after we
    // start shifting the model around) would feed back into itself.
    this.previewBaseY = placementY(this.preview, def);
    // Seed the preview with the focused floor's Y so the ghost shows
    // up immediately on upper floors — otherwise it starts at world
    // Y=0 (ground) and the camera (looking at Floor N's slab) just
    // doesn't see it until the user wiggles the cursor to trigger
    // onPointerMove. Surface items keep Y from the host so we leave
    // them alone.
    if (def.placement !== "surface") {
      this.preview.position.y = this.previewBaseY + this.currentFloorY();
    }
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
          // depthTest off so the ghost is visible through solid
          // geometry. Without this, snapping a window from inside the
          // building lands the preview at a perimeter wall that may be
          // BEHIND a solid wall from the camera POV — the player saw
          // nothing and assumed the placement wasn't registering.
          (c as THREE.Material).depthTest = false;
          return c;
        };
        o.material = Array.isArray(o.material) ? o.material.map(cloneOne) : cloneOne(o.material);
        o.castShadow = false;
        // Push the ghost to the top of the render order so it draws
        // last (after the solid walls + furniture) and the off-depth-
        // test pixels actually win.
        o.renderOrder = 999;
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
          // depthTest off + max renderOrder so the ghost is visible
          // through walls + furniture. Especially important for window
          // placement from inside the building: the snap target can
          // be a perimeter wall BEHIND a solid back/left wall from
          // the camera's POV, and without this the ghost rendered
          // invisible — the player had no idea where the placement
          // would land.
          (m as THREE.Material).depthTest = false;
          o.material = m;
          o.castShadow = false;
          o.renderOrder = 999;
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
        // Restore the item at its original floor — without the slab Y
        // offset here, an undo of a Floor-1 sell would respawn the
        // item on the ground. getStoreyHeight is wired from Engine.
        const h = this.getStoreyHeight?.() ?? 3;
        solid.position.set(entry.x, placementY(solid, def) + entry.floor * h, entry.z);
        solid.rotation.y = entry.rotY;
        const mount = this.getStoreyMount?.(entry.floor) ?? this.scene;
        mount.add(solid);
        this.registry.register(def.id, entry.x, entry.z, entry.rotY, solid, undefined, entry.floor);
      });
      this.flashRoot(`Undid sell — paid back $${entry.refundPaid}`, "info");
      return;
    }
    if (entry.kind === "move") {
      this.registry.setPose(entry.uid, entry.fromX, entry.fromZ, entry.fromRotY);
      // Cross-floor move undo: put the item back on its original
      // storey so a Floor 1 → ground move can actually be undone.
      this.registry.setItemFloor(entry.uid, entry.fromFloor);
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

  /** Pop a small transient toast under the panel (NOT the whole-panel
   * background flash that used to live here — that filled the screen
   * with red/green/blue blocks every time the player took an action,
   * which was distracting). The toast sits just to the left of the
   * BuildMenu so its kind-colour reads at a glance without recolouring
   * the panel itself. */
  private flashRoot(msg: string, kind: "info" | "success" | "error" = "info"): void {
    const bg =
      kind === "success" ? "rgba(40, 110, 50, 0.92)" :
      kind === "error" ? "rgba(140, 30, 30, 0.92)" :
      "rgba(50, 80, 110, 0.92)";
    const textColor =
      kind === "success" ? "#d6f0c8" :
      kind === "error" ? "#ffd0d0" :
      "#d4e3ee";
    const toast = document.createElement("div");
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: "fixed",
      top: "16px",
      right: "284px", // panel is 260 wide + 12 margin + 12 gap
      maxWidth: "260px",
      padding: "8px 12px",
      background: bg,
      color: textColor,
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "6px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
      pointerEvents: "none",
      zIndex: "950",
      opacity: "1",
      transition: "opacity 0.4s ease",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; }, 1000);
    setTimeout(() => { toast.remove(); }, 1500);
  }

  /** Engine calls this after FloorSelector switches the focused storey
   * so the active preview / move ghost teleports up/down to the new
   * floor without the player having to wiggle the cursor. X+Z stay
   * fixed (the cursor cell didn't move) — only Y changes. */
  refreshFocusedFloor(): void {
    if (!this.preview || !this.placingDef) return;
    // Surface items take Y from the host's measured top — no floor
    // adjustment needed (and the host's own Y already lives at the
    // right slab). For floor / wall / ceiling items, recompute Y from
    // the CACHED previewBaseY + the new floor's slab offset. Reading
    // placementY here would compound with model.position.y the same
    // way onPointerMove used to.
    if (this.placingDef.placement === "surface") return;
    this.preview.position.y = this.previewBaseY + this.currentFloorY();
  }

  /** Storey index the camera is currently focused on. Defaults to 0 if
   * the engine hasn't wired the getter up. */
  private currentFloor(): number {
    return this.getFocusedStorey?.() ?? 0;
  }

  /** World Y of the focused storey's slab — the plane new placements
   * sit on. Multiplies the focused floor by the storey height. */
  private currentFloorY(): number {
    return this.currentFloor() * (this.getStoreyHeight?.() ?? 3);
  }

  /** Parent container that new placements on the current floor should
   * be added to. Ground floor is the main scene; upper floors are the
   * storey group so visibility (focus + tier) applies. */
  private currentMount(): THREE.Object3D {
    return this.getStoreyMount?.(this.currentFloor()) ?? this.scene;
  }

  private onPointerMove = (e: PointerEvent): void => {
    // Run the raycaster in placing / sell / move modes so we always
    // know which cell a click would hit.
    if (!this.placingDef && !this.sellMode && !this.moveMode) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    // Intersect with the focused storey's slab plane (floor 0 → y=0,
    // floor 1 → y=3, etc.). For a plane y=h the equation is
    // n·p + d = 0 with n=(0,1,0), so d = -h. Without this shift, every
    // raycast on an upper floor lands on the ground slab and items
    // would spawn at y=0 — visibly below the floor the user is on.
    const slabY = this.currentFloorY();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -slabY);
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
      // the parity, swapping width/depth when the player has rotated
      // the placement 90° (computePlacementPlan does the same).
      const def = this.placingDef;
      const w = def?.size.width ?? 1;
      const d = def?.size.depth ?? 1;
      const swapped = Math.abs(Math.sin(this.rotationY)) > 0.5;
      const xs = swapped ? d : w;
      const zs = swapped ? w : d;
      this.hoverCell.set(this.snapAxis(point.x, xs), 0,
                         this.snapAxis(point.z, zs));
    }

    // Pickup-mode raycast: while the player is in sell or move-pickup,
    // they're aiming AT items (not floor cells). With an iso camera, a
    // ground-plane hit lands past the chair the user clicked, so a strict
    // findAt(floor-x, floor-z) misses by a wide margin. Instead, raycast
    // against placed furniture meshes directly.
    this.hoveredItemUid = null;
    const wantsItem = this.sellMode || (this.moveMode && !this.holdingUid);
    if (wantsItem) {
      // Restrict the raycast to items on the focused storey. Without
      // this, an iso ray on Floor 1 passes through the slab below and
      // grabs a ground-floor item — selling/moving deletes the wrong
      // thing. Items on different floors are out of scope for the
      // current interaction.
      const focusedFloor = this.currentFloor();
      const items = this.registry.snapshotItems().filter((it) => it.floor === focusedFloor);
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
    // Surface items get their Y from the host's measured top so the
    // ghost previews on top of the table/counter instead of on the floor.
    // Non-surface items add the current floor's slab Y so the preview
    // hovers over the focused floor instead of the ground. Uses the
    // cached previewBaseY captured at ghost-creation time — re-reading
    // placementY here would feed off model.position.y, which was just
    // set by the previous tick, and the Y would compound every frame.
    const previewY = this.placingDef.placement === "surface" && plan.hostTopY !== undefined
      ? plan.hostTopY
      : this.previewBaseY + this.currentFloorY();
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
      // Clamp the raw point to the building's perimeter bounds before
      // snapping. The iso camera + ground-plane raycast means hovering
      // OVER a tall item (plant pot, tall fridge) projects the ground
      // hit PAST the wall behind it — which then snaps to a grid line
      // outside the building and reads as "blocked". Clamping pulls
      // the snap target back onto the building so a window can land
      // on the wall even when the cursor approach is occluded.
      const clampedX = Math.max(-4.5, Math.min(5.5, rawPoint.x));
      const clampedZ = Math.max(-4.5, Math.min(5.5, rawPoint.z));
      let e = this.snapToEdge(clampedX, clampedZ);
      const needsPerimeter = def.category === "door" && !def.id.startsWith("window");
      const needsWall = def.id.startsWith("window");
      // For perimeter-required edge items (real doors, windows), the
      // standard "nearest grid line" snap is wrong when the cursor is
      // INSIDE the building near a wall — it snaps to the closer
      // interior grid line, not to the perimeter wall behind it. So
      // when the natural snap doesn't land on a valid wall, fall back
      // to the nearest perimeter wall edge. That way the player can
      // place a window from the inside view (clicking near the wall
      // from a tile centre) just as easily as from the outside view.
      if (needsPerimeter && !this.isOnPerimeterWall(e.x, e.z)) {
        e = this.snapToNearestPerimeterEdge(clampedX, clampedZ);
      } else if (needsWall && !this.hasWallAtEdge(e.x, e.z)) {
        e = this.snapToNearestPerimeterEdge(clampedX, clampedZ);
      }
      // Final validation — if even the fallback didn't land on a wall
      // (shouldn't happen for the perimeter fallback, but defensive
      // for future placement rules) mark as blocked.
      if (needsPerimeter && !this.isOnPerimeterWall(e.x, e.z)) {
        return { quality: "blocked", x: e.x, z: e.z, rotY: e.rotY };
      }
      if (needsWall && !this.hasWallAtEdge(e.x, e.z)) {
        return { quality: "blocked", x: e.x, z: e.z, rotY: e.rotY };
      }
      // Windows on a perimeter wall: force the rotation so the mesh's
      // interior face always points into the building, no matter which
      // of the four walls it lands on. The standard snap returns the
      // same rotY for opposite walls (rotY=0 for both front + back,
      // rotY=π/2 for both left + right), which leaves the window mesh
      // pointing the same WORLD direction on both — so on one wall the
      // glass faces the room and on the opposite wall it faces the
      // lawn. Same logic applies whether the player clicked from
      // outside (snap landed directly on the perimeter) or from inside
      // (snap fell back through snapToNearestPerimeterEdge).
      if (needsWall && this.isOnPerimeterWall(e.x, e.z)) {
        e.rotY = this.perimeterInteriorRotY(e.x, e.z);
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
    // Wall-shelf items (upper kitchen cabinets) mount on a wall like
    // wall art but at chest+ height, hanging out OVER the cells in
    // front of the wall. The cells beneath must be empty or contain
    // an item ≤ WALL_SHELF_MAX_BELOW_HEIGHT tall — a counter (0.92m)
    // is fine, a walk-in fridge (2.2m) is blocked.
    if (def.placement === "wall-shelf") {
      const host = this.findNearestWall(rawPoint.x, rawPoint.z, 1.8);
      if (!host) {
        return { quality: "blocked", x: rawPoint.x, z: rawPoint.z, rotY: this.rotationY };
      }
      // Snap the anchor with the same parity rule tile placement uses:
      // odd-sized axes land on a tile centre, even-sized axes land on
      // a tile boundary line. Without this a 2-wide upper cabinet
      // (e.g. kitchen-upper-d) anchored at integer X visibly straddled
      // three tiles instead of cleanly covering two.
      //
      // Rotation matters: at rotY=0 the cabinet's width-axis is X; at
      // rotY=π/2 the rotation swaps width and depth onto X/Z. Pull
      // size from def the same way footprintCells does, then run
      // snapAxis per-axis.
      const swapped = Math.abs(Math.sin(host.rotY)) > 0.5;
      const xSize = swapped ? def.size.depth : def.size.width;
      const zSize = swapped ? def.size.width : def.size.depth;
      const anchorX = this.snapAxis(host.x, xSize);
      const anchorZ = this.snapAxis(host.z, zSize);
      // Enumerate every cell the cabinet would cover (1×1, 2×1, etc.)
      // and verify each one is clear or hosts a short-enough item.
      const cells = footprintCells({ x: anchorX, z: anchorZ, rotY: host.rotY }, def);
      const excludeUid = this.holdingUid ?? undefined;
      for (const cell of cells) {
        const below = this.registry.findAt(cell.x, cell.z, excludeUid, this.currentFloor());
        if (!below) continue;
        const belowDef = furnitureCatalog.find((d) => d.id === below.defId);
        if (!belowDef) continue;
        // Only floor-layer items count — wall art / surface items /
        // ceiling lamps don't actually compete for vertical space here.
        const belowPlacement = belowDef.placement ?? "tile";
        if (belowPlacement !== "tile") continue;
        if (defHeight(belowDef) > WALL_SHELF_MAX_BELOW_HEIGHT) {
          return { quality: "blocked", x: anchorX, z: anchorZ, rotY: host.rotY };
        }
      }
      return { quality: "snap-perfect", x: anchorX, z: anchorZ, rotY: host.rotY };
    }
    // Surface-placed items (table lamps, toasters, coffee machines)
    // need an existing placed host item that exposes surfaceSlots.
    // Find the nearest one with a free slot to the cursor and snap to it.
    if (def.placement === "surface") {
      const snap = this.findNearestSurfaceSlot(rawPoint.x, rawPoint.z);
      if (snap) {
        return {
          quality: "snap-perfect",
          x: snap.x, z: snap.z,
          // Surface items inherit the host's facing as their base
          // orientation, plus whatever the player added by pressing R.
          // Without the rotationY add the ghost snapped back to the
          // host's facing on every pointer-move and the user couldn't
          // turn appliances on top of counters.
          rotY: snap.rotY + this.rotationY,
          hostUid: snap.hostUid,
          slotIndex: snap.slotIndex,
          hostTopY: snap.hostTopY,
        };
      }
      return { quality: "blocked", x: rawPoint.x, z: rawPoint.z, rotY: this.rotationY };
    }

    // Rotation matters for the snap parity: at rotY=0 a 2×1 sofa is 2-wide
    // along X (snap X to half-integer) and 1-deep along Z (snap Z to integer).
    // At rotY=π/2 the rotation swaps the world-space width and depth onto
    // X/Z, so the snap axes need to swap too — otherwise pressing R on a
    // 2×1 sofa leaves the snap aligned to the old axis and the mesh lands
    // straddling tile boundaries on the wrong side. Mirrors the same swap
    // the wall-shelf path uses above.
    const tileSwapped = Math.abs(Math.sin(this.rotationY)) > 0.5;
    const tileXSize = tileSwapped ? def.size.depth : def.size.width;
    const tileZSize = tileSwapped ? def.size.width : def.size.depth;
    const cellX = this.snapAxis(rawPoint.x, tileXSize);
    const cellZ = this.snapAxis(rawPoint.z, tileZSize);
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
      // Scope the seat search to the focused storey so a Floor 0 coffee
      // table's seat slot doesn't suck in a chair being placed on
      // Floor 1 (the XZ snap is identical across floors, only Y differs).
      const slot = this.registry.findNearestSeatSlot(rawPoint.x, rawPoint.z, 1.4, excludeUid, this.currentFloor());
      if (slot && slot.chairUid == null) {
        // chairUid only tracks CHAIRS on the slot's cell — a non-chair
        // item (side-table, decoration, plant) sitting on the same cell
        // still blocks placement but doesn't set chairUid, so without
        // this isCellBlocked guard the ghost showed snap-perfect green
        // for a seat the click could never actually land on.
        const slotCellX = Math.round(slot.x);
        const slotCellZ = Math.round(slot.z);
        if (!this.registry.isCellBlocked(slotCellX, slotCellZ, excludeUid, "tile", slot.floor)) {
          return {
            quality: "snap-perfect",
            x: slot.x, z: slot.z,
            rotY: FurnitureRegistry.chairRotForSlot(slot.facingY),
          };
        }
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
    // Flat ground decor (rugs) skips the occupancy check entirely so a
    // rug can land under any furniture or another rug. The reverse
    // direction (other items placing ON a rug) is handled in
    // FurnitureRegistry.isCellBlocked, which skips flat items in its
    // blocker scan.
    if (!def.flat) {
      const previewCells = footprintCells({ x: cellX, z: cellZ, rotY: this.rotationY }, def);
      const floor = this.currentFloor();
      for (const cell of previewCells) {
        if (this.registry.isCellBlocked(cell.x, cell.z, excludeUid, layer, floor)) {
          return { quality: "blocked", x: cellX, z: cellZ, rotY: this.rotationY };
        }
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
    // Push the item PAST the wall surface, not just away from the wall
    // axis. Walls are BoxGeometry with thickness 0.2, so their visible
    // faces sit 0.1 from the wall's centre line — the previous 0.07
    // mounted items 0.03 INSIDE the visible surface, which buried
    // thicker pieces like the wine wall (back panel + bottle tips
    // sank into the wall). 0.12 = 0.1 wall half-thickness + 0.02
    // clearance, so flat paintings still hug the surface and thicker
    // pieces sit cleanly in front of it.
    const off = 0.12;
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

  /** Find the nearest free surface slot on a placed host item to the
   * cursor. Walks every placed item, considers ones that declare
   * surfaceSlots, computes each slot's world position (rotating the
   * host-local dx/dz by the host's rotY), and returns the closest one
   * that isn't already reserved by another surface-placed child. The
   * Y comes from a measured bounding box on the host model so the
   * preview / placement lands on the actual top surface regardless of
   * which asset it is. Returns null when nothing within ~2 units has a
   * free slot. */
  private findNearestSurfaceSlot(rawX: number, rawZ: number): {
    x: number; z: number; rotY: number; hostUid: string; slotIndex: number; hostTopY: number;
  } | null {
    const items = this.registry.snapshotItems();
    const excludeUid = this.holdingUid ?? undefined;
    let best: {
      x: number; z: number; rotY: number; hostUid: string; slotIndex: number; hostTopY: number; dist: number;
    } | null = null;
    const MAX_DIST = 2.0;
    for (const host of items) {
      const hostDef = furnitureCatalog.find((d) => d.id === host.defId);
      const slots = hostDef?.surfaceSlots;
      if (!slots || slots.length === 0) continue;
      const reserved = this.registry.getOccupiedSurfaceSlots(host.uid, excludeUid);
      // Measure the host's world-space top once; all of its slots share
      // the same Y.
      host.model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(host.model);
      const topY = box.max.y;
      const cos = Math.cos(host.rotY), sin = Math.sin(host.rotY);
      for (let i = 0; i < slots.length; i += 1) {
        if (reserved.has(i)) continue;
        const slot = slots[i];
        // R_y(rotY) * (dx, 0, dz) — matches the registry's reseat math.
        const sx = host.x + slot.dx * cos + slot.dz * sin;
        const sz = host.z - slot.dx * sin + slot.dz * cos;
        const d = Math.hypot(sx - rawX, sz - rawZ);
        if (d > MAX_DIST) continue;
        if (!best || d < best.dist) {
          best = { x: sx, z: sz, rotY: host.rotY, hostUid: host.uid, slotIndex: i, hostTopY: topY, dist: d };
        }
      }
    }
    if (!best) return null;
    return {
      x: best.x, z: best.z, rotY: best.rotY,
      hostUid: best.hostUid, slotIndex: best.slotIndex, hostTopY: best.hostTopY,
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

  /** True if the snapped edge has a wall — either an exterior
   * perimeter wall OR an interior partition the player has placed
   * (int-wall, int-wall-half, int-doorway, int-window). Used for
   * window placement so a window can only land on something that's
   * actually a wall, not just any random grid line on the lawn. */
  private hasWallAtEdge(x: number, z: number): boolean {
    if (this.isOnPerimeterWall(x, z)) return true;
    const TOL = 0.05;
    for (const it of this.registry.snapshotItems()) {
      const def = furnitureCatalog.find((d) => d.id === it.defId);
      // Look for items that physically EXIST on a wall edge — interior
      // partitions (category "wall") or any other edge-placed item.
      // Excluded: edge-placed items that ARE windows / doors (we don't
      // want a window snap to satisfy itself).
      if (def?.placement !== "edge") continue;
      if (def.id.startsWith("window")) continue;
      if (def.category === "door") continue;
      if (Math.abs(it.x - x) < TOL && Math.abs(it.z - z) < TOL) return true;
    }
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

  /** Snap to the nearest PERIMETER wall edge. Used as the fallback for
   * windows + perimeter-only doors when the regular nearest-grid-line
   * snap lands on an interior tile boundary (which happens when the
   * cursor is INSIDE the building close to a wall — the inside tile
   * line is geometrically closer than the wall plane behind it).
   * Picks whichever of the 4 perimeter walls is nearest to the raw
   * point, then snaps the along-axis coord to the nearest integer
   * (clamped to the wall's valid placement range). */
  private snapToNearestPerimeterEdge(rawX: number, rawZ: number): { x: number; z: number; rotY: number } {
    const distFront = Math.abs(rawZ - 5.5);
    const distBack  = Math.abs(rawZ + 4.5);
    const distLeft  = Math.abs(rawX + 4.5);
    const distRight = Math.abs(rawX - 5.5);
    const minDist = Math.min(distFront, distBack, distLeft, distRight);
    // Tiles along a 10-wide wall sit at integer x ∈ [-4, 5] (front/back)
    // or integer z ∈ [-4, 5] (left/right). Clamp to keep the window
    // anchor inside the wall span.
    const clampAlong = (v: number): number => Math.max(-4, Math.min(5, Math.round(v)));
    if (minDist === distFront) return { x: clampAlong(rawX), z: 5.5, rotY: 0 };
    if (minDist === distBack)  return { x: clampAlong(rawX), z: -4.5, rotY: 0 };
    if (minDist === distLeft)  return { x: -4.5, z: clampAlong(rawZ), rotY: Math.PI / 2 };
    return { x: 5.5, z: clampAlong(rawZ), rotY: Math.PI / 2 };
  }

  /** rotY that points an edge-placed mesh's "front face" (Kenney
   * convention: -Z in model space) into the BUILDING INTERIOR for the
   * named perimeter wall. Used so a placed window has its glass /
   * decorative side facing the room on every wall, instead of facing
   * outward on the back + left walls (which is what snapToEdge's
   * symmetric rotY=0 / π/2 default produces). Tolerant about how
   * close the coords are to the wall plane — uses 0.1 as the same
   * proximity rule isOnPerimeterWall uses. */
  private perimeterInteriorRotY(x: number, z: number): number {
    const TOL = 0.1;
    if (Math.abs(z - 5.5) < TOL)  return 0;            // front: -Z faces interior (south, into room)
    if (Math.abs(z + 4.5) < TOL)  return Math.PI;      // back: rotate 180° so +Z faces interior
    if (Math.abs(x + 4.5) < TOL)  return -Math.PI / 2; // left: -X faces interior, rotate -90°
    return Math.PI / 2;                                 // right: +X is exterior, default π/2 puts -X facing interior
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
        : this.registry.findAt(Math.round(this.hoverCell.x), Math.round(this.hoverCell.z), undefined, this.currentFloor());
      if (!item) {
        this.flashRoot("Nothing to sell there", "error");
        return;
      }
      const snapshot = { defId: item.defId, x: item.x, z: item.z, rotY: item.rotY, floor: item.floor };
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
      // Windows ride in the "door" category for the build menu UI but
      // don't trigger door-specific scene rebuilds (no hinged panel,
      // no front-wall cut).
      if (itemDef?.category === "door" && !itemDef.id.startsWith("window")) this.onDoorRemoved?.(itemModel);
      if (itemDef?.id.startsWith("window")) this.onWindowRemoved?.(itemModel);
      this.game.economy.earnMoney(removed.refund, "payment");
      this.pushUndo({ kind: "sell", defId: snapshot.defId, x: snapshot.x, z: snapshot.z, rotY: snapshot.rotY, refundPaid: removed.refund, floor: snapshot.floor });
      this.flashRoot(`Sold for $${removed.refund}`, "success");
      return;
    }
    if (this.moveMode && this.hoverValid) {
      if (!this.holdingUid) {
        // First click: pick up whatever's under the cursor (raycaster hit
        // takes priority over the floor-cell fallback for iso angles).
        const item = this.hoveredItemUid
          ? this.registry.snapshotItems().find((it) => it.uid === this.hoveredItemUid) ?? null
          : this.registry.findAt(Math.round(this.hoverCell.x), Math.round(this.hoverCell.z), undefined, this.currentFloor());
        if (!item) { this.flashRoot("Nothing to move there", "error"); return; }
        this.holdingUid = item.uid;
        this.holdingFrom = { x: item.x, z: item.z, rotY: item.rotY, floor: item.floor };
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
          // Recover the floor-relative base Y from the clone's world Y
          // by subtracting the item's home-floor slab offset. Stored
          // for the same reason placement preview caches it — onPointerMove
          // and refreshFocusedFloor add currentFloorY() back on each
          // tick; without the cache the Y would compound by storeyHeight
          // every frame.
          this.previewBaseY = this.preview.position.y - item.floor * (this.getStoreyHeight?.() ?? 3);
          this.scene.add(this.preview);
          this.tintPreview("snap-perfect"); // at start, sits at its current valid pose
        }
        // Now hide the original — done after cloning so the clone above
        // never inherited an invisible source.
        item.model.visible = false;
        // Fire the same removed-callback the sell path uses so the
        // perimeter wall fills back in mid-move. Engine's handler
        // reads heldUid (now set) and excludes this item from the
        // openings derivation, so the hole at the old position
        // disappears as soon as the player picks up.
        if (def?.category === "door" && !def.id.startsWith("window")) this.onDoorRemoved?.(item.model);
        if (def?.id.startsWith("window")) this.onWindowRemoved?.(item.model);
        this.flashRoot(`Picked up — click destination`, "success");
      } else {
        // Second click: drop using the latest plan from pointermove.
        const plan = this.currentPlan;
        if (!plan || plan.quality === "blocked") {
          this.flashRoot("Destination is blocked", "error");
          return;
        }
        const fromPose = this.holdingFrom!;
        const movedItem = this.registry.snapshotItems().find((it) => it.uid === this.holdingUid);
        const movedDef = movedItem ? furnitureCatalog.find((d) => d.id === movedItem.defId) : undefined;
        this.registry.setPose(this.holdingUid, plan.x, plan.z, plan.rotY);
        // Cross-floor drop: if the player switched focus while holding
        // the item, re-parent it (and any surface children) into the
        // new floor's storey mount and shift its Y by the slab delta.
        this.registry.setItemFloor(this.holdingUid, this.currentFloor());
        if (this.movingOriginalModel) {
          this.movingOriginalModel.visible = true;
          this.movingOriginalModel = null;
        }
        this.cancelPreview();
        this.pushUndo({ kind: "move", uid: this.holdingUid, fromX: fromPose.x, fromZ: fromPose.z, fromRotY: fromPose.rotY, fromFloor: fromPose.floor });
        this.holdingUid = null;
        this.holdingFrom = null;
        // Fire the placed-callback so the wall re-cuts a hole at the
        // new position. heldUid is null now so the rebuild sees this
        // item where it just landed and the openings derivation
        // includes it.
        if (movedItem && movedDef) {
          if (movedDef.category === "door" && !movedDef.id.startsWith("window")) this.onDoorPlaced?.(movedItem.model);
          if (movedDef.id.startsWith("window")) this.onWindowPlaced?.(movedItem.model);
        }
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
    // Capture the surface-host info before the async load — if the
    // plan is for a surface item, we need parentUid + slotIndex when
    // registering and hostTopY for the Y position.
    const planHostUid = plan.hostUid;
    const planSlotIndex = plan.slotIndex;
    const planHostTopY = plan.hostTopY;
    // Snapshot the floor here so an async model-load doesn't get
    // its placement re-routed if the player switches focus while the
    // GLB is fetching.
    const placeFloor = this.currentFloor();
    const floorY = this.currentFloorY();
    const mount = this.currentMount();
    void this.loader.load(def.modelPath).then((solid) => {
      fitFurniture(solid, def);
      // placementY picks the right Y per placement kind: 0 for floor
      // items, 1.5 for wall sconces, CEILING_Y minus the model height
      // for ceiling items so the model TOP touches the ceiling and the
      // body hangs below. Surface items override with the host's
      // measured top Y so they sit on the table/counter top exactly
      // (the host's Y already accounts for its floor). For floor /
      // wall / ceiling items we add `floorY` so an upper-floor place
      // lands on the right slab.
      const yOverride = def.placement === "surface" ? planHostTopY : undefined;
      const baseY = yOverride ?? (placementY(solid, def) + floorY);
      solid.position.set(placeX, baseY, placeZ);
      solid.rotation.y = rotY;
      // Visual-only: slide narrow tile items so their back face hugs
      // any wall their cell touches. Keeps the kitchen line + dining
      // tables against the wall flush instead of leaving an uneven
      // per-item gap.
      snapToAdjacentWall(solid, def);
      // Surface items inherit their host's floor (set by register
      // automatically). Everyone else is mounted under the focused
      // storey's group so storey visibility applies.
      if (def.placement === "surface") {
        this.scene.add(solid);
      } else {
        mount.add(solid);
      }
      const parent = (def.placement === "surface" && planHostUid && typeof planSlotIndex === "number")
        ? { parentUid: planHostUid, slotIndex: planSlotIndex }
        : undefined;
      const uid = this.registry.register(def.id, placeX, placeZ, rotY, solid, parent, placeFloor);
      this.pushUndo({ kind: "place", uid, defId: def.id, refundCost: cost });
      // Real doors keep their existing hook (hinged panel + front-
      // wall cut). Windows have their own callback that triggers
      // a perimeter-wall rebuild so the sill + lintel gap shows
      // through from either side.
      if (def.category === "door" && !def.id.startsWith("window")) this.onDoorPlaced?.(solid);
      if (def.id.startsWith("window")) this.onWindowPlaced?.(solid);
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
