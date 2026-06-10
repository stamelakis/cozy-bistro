import * as THREE from "three";
import type { IsoCamera } from "../scene/IsoCamera";
import type { WorldScene } from "../scene/WorldScene";
import type { AnimatedCharacter, CharacterAction } from "../scene/CharacterAnimator";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { fitFurniture, placementY } from "../assets/fitFurniture";
import { HeldItemVisualizer } from "../scene/HeldItemVisualizer";
import { SeatPlateVisualizer } from "../scene/SeatPlateVisualizer";
import { CookingPotVisualizer } from "../scene/CookingPotVisualizer";
import { WashCycleRingVisualizer } from "../scene/WashCycleRingVisualizer";
import { DirtyPileVisualizer } from "../scene/DirtyPileVisualizer";
import {
  buildPerimeterWallSegments, extractWallOpenings, emptyFloorOpenings,
  wallKindForCamera, type OpeningSourcePlacement, type WallDir,
} from "../scene/wallBuilder";
import {
  buildStaircaseFlight, buildSupplyCounterMesh, attachLampLight,
  buildParisExteriorDecor, buildRatingSign,
} from "../scene/interiorPieces";
import { RESTAURANT_THEMES, type RestaurantTheme } from "../data/themes";
import { customerArchetypes } from "../data/customerArchetypes";
import { recipes } from "../data/recipes";
import type { StatusEntry } from "./StatusBubbles";

/** Meters between adjacent floor slabs — mirrors
 * WorldScene.STOREY_HEIGHT (currently 3 m). */
const STOREY_HEIGHT = 3;

/** Customer character variants — duplicates the GuestSpawner's roster
 * so a visited save's ghost customers cycle through the same set of
 * faces the player sees in their own restaurant. Kept inline here so
 * VisitMode doesn't have to import GuestSpawner just for the strings. */
const GUEST_VARIANT_IDS = [
  "guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6",
];

/** Save snapshot of a placed piece of furniture as published by
 * publish_player_save. Position uses the legacy "y = world Z" 2D-grid
 * naming. */
interface SavedFurniture {
  uid: string;
  furnitureId: string;
  position: { x: number; y: number };
  rotation?: number;
  floor?: number;
}

/** Categorised placement of a placed piece — what VisitMode actually
 * needs to position characters near it. */
interface PlacementSlot {
  x: number;
  z: number;
  rotationRad: number;
  floor: number;
  category: string;
}

/** Metadata stamped on each city-building shell by
 * WorldScene.populateCityBuildings so a click raycast can identify
 * which plot the player clicked. */
export interface VisitablePlot {
  id: bigint;
  plotX: number;
  plotZ: number;
  ownerHex: string;
  ownerName: string;
}

/** Snapshot of the visited player's save, returned by
 * SpacetimeClient.getPlayerSave — VisitMode reads this to populate
 * the overlay with their day / money / rating / tier. Identity is
 * passed back in by the lookup function. */
export interface VisitedSaveStats {
  dayNumber: number;
  money: number;
  ratingAvg: number;
  luxuryTier: number;
}

/** Per-frame snapshot of camera state we restore on exit. */
interface CameraSnapshot {
  targetX: number;
  targetZ: number;
  targetY: number;
  zoom: number;
  azimuth: number;
}

/**
 * Visitor mode UI + state. Wires three things:
 *
 *  1. A canvas pointerup listener that raycasts against the city
 *     building shells. When a click lands on a shell, a small
 *     floating "Visit [Name]'s Restaurant" popup appears near the
 *     cursor.
 *  2. Clicking the popup enters visit mode — camera snaps to the
 *     visited plot's world position (after the worldRoot shift),
 *     drops zoom to a comfortable "look at this house" range, and
 *     resets azimuth so the visited plot is shown at the standard
 *     iso angle. A top-center "Visiting [name] · Exit" overlay
 *     stays visible until the player exits.
 *  3. Exit returns the camera to its pre-visit pose.
 *
 * Rendering the visited save's actual furniture is a separate
 * future commit (P4 task #66); this class handles the navigation
 * + presentation layer so the player can fly around the city and
 * land on any plot.
 */
/** Map an active_guest.state to an animator action. Anchored states
 * (seated at a table, in the bathroom, waiting their turn at the
 * door) all render as "sit"; in-transit states render as "walk".
 * Unknown / empty defaults to "idle". */
function customerActionFor(state: string): CharacterAction {
  if (state === "seated" || state === "ordering" || state === "eating"
    || state === "waitingForFood" || state === "wcSitting"
    || state === "wcWashing" || state === "waiting") {
    return "sit";
  }
  if (state === "walkingIn" || state === "leaving" || state === "wcWalking"
    || state === "done") {
    return "walk";
  }
  return "idle";
}

export class VisitMode {
  private readonly camera: IsoCamera;
  private readonly scene: WorldScene;
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private snapshot: CameraSnapshot | null = null;
  private activePlot: VisitablePlot | null = null;
  private popup: HTMLDivElement | null = null;
  private overlay: HTMLDivElement | null = null;
  /** Group holding every loaded furniture model for the current
   * visit. Parented to worldRoot at the visited plot's coords on
   * enter; removed + nulled on exit. Geometries/materials come from
   * the model loader's cache and are reused across visits. */
  private visitorRoot: THREE.Group | null = null;
  /** Animated character roots spawned by spawnVisitorActivity. The
   * animator owns the per-frame motion; on exit we remove each one
   * from the animator (otherwise we'd leak idle/sit poses ticking on
   * meshes the visit no longer owns). */
  private spawnedGhostRoots: THREE.Object3D[] = [];
  /** Liveness counts surfaced in the overlay — "🍽 X seated · 👤 Y staff".
   * Bumped as ghosts spawn; the overlay refreshes when they land. */
  private liveCustomerCount = 0;
  private liveStaffCount = 0;
  /** Element inside the overlay that renders the liveness counts —
   * cached so spawn callbacks can re-render it without rebuilding
   * the whole overlay. */
  private livenessEl: HTMLSpanElement | null = null;
  /** Optional hook so Engine can pause its own systems while a visit
   * is active (e.g. suppress build-menu placement, hide bubbles). */
  onEnter?: (plot: VisitablePlot) => void;
  onExit?: () => void;
  /** Engine wires this to SpacetimeClient.getPlayerSave so the
   * overlay can show the visited player's actual stats (day, money,
   * rating, tier) read from their published save. Returns null if
   * the visited player hasn't synced a save yet. */
  fetchVisitedStats?: (ownerHex: string) => VisitedSaveStats | null;
  /** Engine wires this to SpacetimeClient.getPlayerSave so the
   * interior render can load the visited player's furniture
   * placements. Returns the raw JSON blob (the same string the
   * publish_player_save reducer received). */
  fetchVisitedSaveBlob?: (ownerHex: string) => string | null;
  /** Engine wires this to SpacetimeClient.recordVisit so the
   * visited player's client can pick up the event and surface a
   * "X is visiting your restaurant" toast. Fire-and-forget. */
  recordVisit?: (hostHex: string) => void;
  /** Engine wires this to SpacetimeClient so visit mode can stand
   * up a live subscription on the host's staff_actor rows + render
   * the host's chefs / waiters / barmen as animated characters
   * walking around the visited restaurant in real time. Optional —
   * when null, VisitMode falls back to the static "ghost activity"
   * spawn that loads from the save snapshot. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;
  /** Live staff actors fetched from the host's staff_actor table
   * (keyed by memberId). Subscription handlers spawn / update / remove
   * entries; exit() disposes them all. Separate from spawnedGhostRoots
   * because their animation update path is "snap to server pos every
   * 100ms" not "play the saved idle/sit pose". */
  private liveStaffCharacters: Map<string, AnimatedCharacter> = new Map();
  /** memberIds we tried to spawn but the GLB load is still in flight.
   * Prevents a fast burst of insert events from spawning two characters
   * for the same memberId before the first load finishes. */
  private liveStaffPendingLoads: Set<string> = new Set();
  /** Live ticket counts read from active_ticket subscription. Surface
   * in the visit overlay so visitors can see "🍳 3 cooking · 🍽 2 ready"
   * — gives an instant read on how busy the host's kitchen is without
   * having to spawn plate meshes. Keyed by ticket id (server u64 as
   * string) so we can re-key on update without double-counting. */
  private liveTicketStates: Map<string, string> = new Map();

  /** Bubble-label metadata, indexed for snapshotBubbles(). Engine's
   * updateStatusBubbles polls this every frame when a visit is active
   * so the visitor sees the SAME chef cook-recipe labels + guest
   * patience countdowns + errand badges the host sees on their own
   * restaurant. Updated by the subscription handlers in lockstep
   * with the character spawn/snap/dispose path. */
  private staffMetaByMember: Map<string, {
    role: string;
    state: string;
    ticketId: bigint | null;
    errandPhase?: string | null;
  }> = new Map();
  private guestMetaById: Map<string, {
    state: string;
    patienceMs: bigint;
    archetype: string;
    orderIndex: number;
  }> = new Map();
  private ticketMetaById: Map<string, {
    state: string;
    recipeId: string;
    appliance: string;
    assignedChefId: string;
  }> = new Map();
  /** Live customer characters from active_guest subscription, keyed by
   * the server's guest id (as string). Spawn-on-insert, snap-on-
   * update, dispose-on-delete — same pattern as liveStaffCharacters. */
  private liveCustomerCharacters: Map<string, AnimatedCharacter> = new Map();
  private liveCustomerPendingLoads: Set<string> = new Set();

  /** Phase 8.3 — Snapshot-interpolation buffers for live staff +
   * customers. The previous render path snapped groundPos directly
   * on every cloud update, which at 2 Hz server ticks produced a
   * visible ~1.5 m teleport every 500 ms (helpers had the same bug
   * inside the host's own restaurant — fixed there with the same
   * pattern). Each cloud update pushes (prevPos = current last,
   * lastPos = new server pos, stampMs = now). The per-frame
   * `tickLiveMotion(dt)` LERPs groundPos between prev and last
   * over the tick window so the on-screen character traces exactly
   * what the server walked, one tick (~500 ms) late. facingY is
   * computed from the snapshot velocity vector (last − prev) — the
   * direction the server actually moved them, which is always
   * correct even on a bending path. Sitting / idle characters get
   * facing preserved from when they were last moving. */
  private liveStaffSnapshots: Map<string, {
    prevPos: THREE.Vector2;
    lastPos: THREE.Vector2;
    stampMs: number;
    /** True when the character should not move this frame even if
     * snapshots disagree slightly — used for `seated` / `eating` /
     * `working` etc. where the server's row.x/z is a constant. */
    stationary: boolean;
  }> = new Map();
  private liveCustomerSnapshots: Map<string, {
    prevPos: THREE.Vector2;
    lastPos: THREE.Vector2;
    stampMs: number;
    stationary: boolean;
  }> = new Map();

  /** Phase H.A — Attaches plate/glass meshes to staff actors who are
   * actively transporting an order (ticket.state == "delivering").
   * Reads cloud rows; doesn't need any local-sim state. Same instance
   * will be re-used by the host's view post-H.D when we delete the
   * legacy heldPlate.visible toggling in StaffRouter. */
  private heldItems: HeldItemVisualizer = new HeldItemVisualizer();
  /** Phase H.A — Renders a plate at the seat position whenever a
   * guest's state is "eating". Replaces (in visit mode) the host's
   * showPlateForGuest. */
  private seatPlates: SeatPlateVisualizer = new SeatPlateVisualizer();
  /** Phase H.A — Renders a bubbling pot at a chef when they're
   * cooking a non-bar ticket. */
  private cookingPots: CookingPotVisualizer = new CookingPotVisualizer();
  /** Phase H.A — Renders a countdown ring at each dishwasher with
   * a running batch. Brand-new visual (host didn't have one either). */
  private washCycleRings: WashCycleRingVisualizer = new WashCycleRingVisualizer();
  /** Phase H.B — Renders a leftover plate/glass at each table that
   * has a dirty_pile row. Replaces (in visit mode) the host's local
   * dirtyTableMeshes array. */
  private dirtyPiles: DirtyPileVisualizer = new DirtyPileVisualizer();
  /** Phase H.A — Cache of placed_furniture positions keyed by uid.
   * Populated alongside the interior render; used by the wash-cycle
   * ring visualizer to resolve a dishwasher's uid → coords. */
  private furniturePosByUid: Map<string, { x: number; z: number; floor: number }> = new Map();
  /** Wall ghost-swap tracker — mirrors the host's
   * WorldScene.updateWallVisibility. Each floor owns a solid wallMat
   * (theme-driven), a transparent ghostMat (cloned with opacity 0.15
   * + depthWrite off, matches host's `wallGhostMat`), and four
   * direction-keyed mesh arrays. updateWallVisibility flips each
   * direction's meshes between the two materials based on whether
   * the camera is on the outdoor side of that wall, so the visitor
   * sees through the front + side walls of the visited restaurant
   * the same way the host sees through their own. */
  private wallTracker: Map<number, {
    wallMat: THREE.Material;
    ghostMat: THREE.Material;
    perDir: Record<WallDir, THREE.Mesh[]>;
    currentKind: Record<WallDir, "solid" | "ghost">;
  }> = new Map();

  constructor(container: HTMLElement, canvas: HTMLCanvasElement, camera: IsoCamera, scene: WorldScene) {
    this.container = container;
    this.canvas = canvas;
    this.camera = camera;
    this.scene = scene;
    this.attachClickHandler();
  }

  /** Currently in visit mode? Engine reads this to gate other systems. */
  isVisiting(): boolean {
    return this.activePlot !== null;
  }

  /** The plot the player is currently visiting (null when not). */
  getActivePlot(): VisitablePlot | null {
    return this.activePlot;
  }

  // ─── Click → popup → enter visit ─────────────────────────────────

  private attachClickHandler(): void {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    this.canvas.addEventListener("pointerup", (e) => {
      // Right-click is the camera rotate gesture — never a visit.
      if (e.button !== 0) return;
      // Suppress if the click was actually a drag (camera pan/rotate).
      if (this.camera.wasDragging()) return;
      // While visiting, clicks don't open new popups — player must
      // use Exit Visit button.
      if (this.activePlot) return;
      ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
      ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(ndc, this.camera.threeCamera);
      const hits = raycaster.intersectObjects(this.scene.cityBuildings ? this.scene.cityBuildings.children : [], true);
      for (const hit of hits) {
        const plot = this.findPlot(hit.object);
        if (plot) {
          this.showPopup(e.clientX, e.clientY, plot);
          return;
        }
      }
      // Click missed all shells — close any open popup.
      this.hidePopup();
    });
  }

  /** Walk up the parent chain looking for the visitPlot userData
   * stamp put on shell groups by populateCityBuildings. */
  private findPlot(obj: THREE.Object3D | null): VisitablePlot | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      const plot = cur.userData?.visitPlot as VisitablePlot | undefined;
      if (plot) return plot;
      cur = cur.parent;
    }
    return null;
  }

  private showPopup(screenX: number, screenY: number, plot: VisitablePlot): void {
    this.hidePopup();
    const popup = document.createElement("div");
    Object.assign(popup.style, {
      position: "fixed",
      left: `${screenX + 10}px`,
      top: `${screenY + 10}px`,
      background: "rgba(20, 14, 10, 0.92)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.45)",
      borderRadius: "8px",
      padding: "8px 12px",
      font: "13px/1.3 system-ui, sans-serif",
      boxShadow: "0 4px 18px rgba(0, 0, 0, 0.4)",
      cursor: "default",
      zIndex: "20",
      pointerEvents: "auto",
      maxWidth: "240px",
    } as Partial<CSSStyleDeclaration>);
    const nameLine = document.createElement("div");
    nameLine.style.marginBottom = "6px";
    nameLine.style.fontWeight = "700";
    nameLine.textContent = plot.ownerName
      ? `${plot.ownerName}'s plot`
      : "Unclaimed plot";
    popup.appendChild(nameLine);
    if (plot.ownerName) {
      // Popup intentionally does NOT preview stats (money / rating /
      // tier / day) — the visit experience now leans on what the
      // player can SEE inside the restaurant (live staff + customer
      // ghosts), not a numeric stat card. The Visit Restaurant button
      // is the only call to action here.
      const btn = document.createElement("button");
      btn.textContent = `🏃 Visit Restaurant`;
      Object.assign(btn.style, {
        background: "rgba(220, 180, 130, 0.30)",
        color: "#fff5dc",
        border: "1px solid rgba(255, 220, 150, 0.55)",
        borderRadius: "6px",
        padding: "5px 10px",
        cursor: "pointer",
        font: "inherit",
        fontWeight: "600",
        width: "100%",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => {
        this.hidePopup();
        this.enter(plot);
      };
      popup.appendChild(btn);
    } else {
      const note = document.createElement("div");
      note.textContent = "No one's here yet.";
      note.style.opacity = "0.65";
      note.style.fontSize = "11px";
      popup.appendChild(note);
    }
    this.container.appendChild(popup);
    this.popup = popup;
  }

  private hidePopup(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
  }

  // ─── Enter / exit visit ──────────────────────────────────────────

  enter(plot: VisitablePlot): void {
    if (this.activePlot) return;
    const t = this.camera.getTargetXZ();
    this.snapshot = {
      targetX: t.x,
      targetZ: t.z,
      targetY: this.camera.getTargetY(),
      zoom: this.camera.getZoom(),
      azimuth: this.camera.getAzimuth(),
    };
    this.activePlot = plot;
    // Snap camera to the visited plot. The plot's world coordinates
    // (after the player's own worldRoot offset) tell us where the
    // shell visually sits in the player's view.
    const worldX = plot.plotX + this.scene.worldRoot.position.x;
    const worldZ = plot.plotZ + this.scene.worldRoot.position.z;
    this.camera.setTargetXZ(worldX, worldZ);
    this.camera.setZoom(18);
    // Reset to default iso azimuth so plots are always viewed from
    // the same angle — easier to compare layouts.
    this.camera.setAzimuth(Math.PI / 4);
    this.showOverlay(plot);
    // Hide the placeholder shell so the loaded interior is visible
    // (otherwise the Paris-style facade walls occlude the furniture).
    this.hideVisitedShell(plot);
    // Live subscriptions BEFORE the static interior render. The
    // subscription's cache replay fires onInsert events synchronously
    // for every existing row, so by the time loadVisitedInterior's
    // async spawnVisitorActivity reaches the ghost-staff spawn,
    // this.liveStaffCharacters is already populated (if any data
    // exists). spawnVisitorActivity then SKIPS the ghost staff spawn
    // — no doubling.
    this.startLiveStaffSubscription(plot);
    this.startLiveTicketSubscription(plot);
    this.startLiveCustomerSubscription(plot);
    this.startLiveDishwasherSubscription(plot);
    this.startLiveDirtyPileSubscription(plot);
    // Kick off the interior render — fire-and-forget; the overlay
    // shows "(loading interior…)" until the placements land.
    void this.loadVisitedInterior(plot);
    // P5.8 — let the host's client know they have a visitor. The
    // host then surfaces a toast via its visit_event subscription.
    this.recordVisit?.(plot.ownerHex);
    this.onEnter?.(plot);
  }

  exit(): void {
    if (!this.activePlot || !this.snapshot) return;
    const s = this.snapshot;
    this.camera.setTargetXZ(s.targetX, s.targetZ);
    this.camera.setZoom(s.zoom);
    this.camera.setAzimuth(s.azimuth);
    this.snapshot = null;
    this.activePlot = null;
    this.hideOverlay();
    this.disposeLiveStaff();
    this.disposeVisitorRoot();
    this.restoreVisitedShell();
    this.onExit?.();
  }

  // ─── Live staff render (Phase H follow-up) ───────────────────────

  /** Subscribe to the host's staff_actor table and render every row
   * as an animated character. Called from enter() once we know the
   * visited plot's ownerHex; bails when the cloud client isn't wired
   * or when the host's restaurant_id can't be resolved (subscription
   * cache hasn't hydrated yet, or the host's restaurant was deleted).
   *
   * The subscription stays active for the session — current SDK
   * surface doesn't give us a clean unsubscribe — but the handlers
   * gate on `this.activePlot` so a fired event for the wrong host
   * (after the player has switched visits) is a no-op. The
   * liveStaffCharacters map is cleared on every enter() so old
   * entries from the previous visit don't bleed through. */
  private startLiveStaffSubscription(plot: VisitablePlot): void {
    if (!this.cloud) {
      console.log("[Visit] live staff: cloud not wired — skipping");
      return;
    }
    const hostRid = this.cloud.findRestaurantIdByOwnerHex(plot.ownerHex);
    if (hostRid == null) {
      // Restaurant row hasn't been delivered yet — fall back to the
      // static ghost activity. Could retry on a short timer, but the
      // first visit usually fires after the cache is primed.
      console.log(`[Visit] live staff: no restaurant_id for owner ${plot.ownerHex} (cache not primed?) — falling back to ghosts`);
      return;
    }
    console.log(`[Visit] live staff: subscribing to restaurant ${hostRid}`);
    const targetPlotId = plot.id;
    let firedCount = 0;
    this.cloud.subscribeStaffActorChanges({
      onInsert: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        firedCount += 1;
        console.log(`[Visit] live staff onInsert #${firedCount}: member=${row.memberId} role=${row.role} state=${row.state} pos=(${row.x.toFixed(1)}, ${row.z.toFixed(1)})`);
        // Phase 8.1 — Stamp the bubble-label meta so getStatusBubbles
        // has ticket + role + errand_phase ready before the
        // GLB load resolves.
        this.staffMetaByMember.set(row.memberId, {
          role: row.role,
          state: row.state,
          ticketId: row.ticketId,
          errandPhase: row.errandPhase,
        });
        // H.A — Update the held-item visualizer's cache BEFORE the
        // character GLB has loaded; reconcile() will no-op until
        // setHost arrives in spawnLiveStaffActor's success branch.
        this.heldItems.onStaffActor(row.memberId, row.ticketId);
        this.cookingPots.onStaffActor(row.memberId, row.ticketId);
        void this.spawnLiveStaffActor(row, targetPlotId);
      },
      onUpdate: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.staffMetaByMember.set(row.memberId, {
          role: row.role,
          state: row.state,
          ticketId: row.ticketId,
          errandPhase: row.errandPhase,
        });
        this.heldItems.onStaffActor(row.memberId, row.ticketId);
        this.cookingPots.onStaffActor(row.memberId, row.ticketId);
        this.applyLiveStaffUpdate(row);
      },
      onDelete: (memberId) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.staffMetaByMember.delete(memberId);
        console.log(`[Visit] live staff onDelete: member=${memberId}`);
        this.heldItems.onStaffActorDelete(memberId);
        this.cookingPots.onStaffActorDelete(memberId);
        this.removeLiveStaffActor(memberId);
      },
    }, hostRid);
    // After a moment, surface whether ANY inserts fired. If zero,
    // it means the host has no staff_actor rows in the cache — they
    // need to enable ?serverSim=staff and play for a bit.
    setTimeout(() => {
      if (this.activePlot?.id !== targetPlotId) return;
      if (firedCount === 0) {
        console.log(`[Visit] live staff: no inserts fired for restaurant ${hostRid} after 2s. The host needs to play with ?serverSim=staff enabled to populate staff_actor rows.`);
      } else {
        console.log(`[Visit] live staff: ${firedCount} actor(s) spawned for restaurant ${hostRid}`);
      }
    }, 2000);
  }

  /** Spawn one character model for a server staff_actor row. memberId
   * lookup prevents duplicates from re-firing inserts (the SDK cache
   * fires one onInsert per existing row at subscribe time). Bails
   * when we already have or are loading this memberId. */
  private async spawnLiveStaffActor(
    row: import("../cloud/SpacetimeClient").StaffActorRow,
    targetPlotId: bigint,
  ): Promise<void> {
    if (this.liveStaffCharacters.has(row.memberId)) return;
    if (this.liveStaffPendingLoads.has(row.memberId)) return;
    this.liveStaffPendingLoads.add(row.memberId);
    // Resolve the character model from the row's role. The host's
    // characterLoader cache is shared with the player's own scene,
    // so loading the third chef this session reuses the GLB clone.
    const role = row.role === "chef" || row.role === "waiter"
        || row.role === "barman" || row.role === "errand"
      ? row.role : "waiter";
    try {
      const model = await this.scene.characterLoader.load(role);
      // Player exited mid-load — abandon. The pending-loads guard
      // prevents this slot from ever being re-spawned, which is the
      // right behaviour: the player isn't watching this plot any more.
      if (this.activePlot?.id !== targetPlotId) {
        this.liveStaffPendingLoads.delete(row.memberId);
        return;
      }
      const floor = Math.max(0, row.floor);
      // Server x/z are restaurant-local (origin at the visited plot's
      // centre); visitorRoot is parented at that same plot world pos,
      // so position the model in visitorRoot-local coords.
      model.position.set(row.x, floor * STOREY_HEIGHT, row.z);
      const animated: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(row.x, row.z),
        facingY: 0,
        // "walk" lets the animator animate the legs while the
        // groundPos moves; would otherwise be locked in idle pose.
        action: row.state === "idle" || row.state === "working" ? "idle" : "walk",
        phase: Math.random() * 5,
        seatHeight: 0,
      };
      // Visitor root may have been disposed between the load start
      // and now — bail when it's gone.
      if (!this.visitorRoot) {
        this.liveStaffPendingLoads.delete(row.memberId);
        return;
      }
      this.visitorRoot.add(model);
      this.scene.animator.add(animated);
      this.liveStaffCharacters.set(row.memberId, animated);
      this.liveStaffCount += 1;
      // Phase 8.3 — Seed the snapshot buffer so the next update
      // event has somewhere to roll prev/last from. Spawn position
      // = server's current row.x/z, stationary = idle/working so
      // a newly-spawned-at-station chef doesn't try to walk anywhere
      // until the server actually moves them.
      const stationaryAtSpawn = row.state === "idle" || row.state === "working";
      this.pushStaffSnapshot(row.memberId, row.x, row.z, stationaryAtSpawn);
      // H.A — Register the character root with the cloud-derived
      // visualizers. Any pending state cached from pre-load events
      // gets reconciled now that we have a host to attach to.
      this.heldItems.setHost(row.memberId, { root: animated.root });
      this.cookingPots.setHost(row.memberId, { root: animated.root });
      this.refreshLivenessLabel();
    } catch (err) {
      console.warn(`[Visit] failed to spawn live staff ${role}:`, err);
    } finally {
      this.liveStaffPendingLoads.delete(row.memberId);
    }
  }

  /** Apply one row update — push the server's position into the
   * snapshot buffer for snapshot-interpolation playback. `tickLiveMotion`
   * runs each frame and LERPs groundPos between the prev + last
   * snapshots so the on-screen character moves smoothly instead of
   * snapping ~1.5 m every 500 ms tick.
   *
   * Server tick is 2 Hz, so the visible motion is ~500 ms behind
   * the server's "now" — invisible at the scale we're rendering at,
   * and a huge upgrade vs the previous direct-snap behaviour. */
  private applyLiveStaffUpdate(row: import("../cloud/SpacetimeClient").StaffActorRow): void {
    const c = this.liveStaffCharacters.get(row.memberId);
    if (!c) {
      // Row arrived before its insert was processed (rare; can happen
      // if the subscription fires events out of order during a fast
      // restart). Treat as insert.
      void this.spawnLiveStaffActor(row, this.activePlot?.id ?? 0n);
      return;
    }
    // Per-state animation: server publishes "idle" / "working" while
    // anchored at a station, anything else while in transit. Match
    // the action so the animator picks the right pose loop.
    const newAction: CharacterAction = row.state === "idle" || row.state === "working"
      ? "idle" : "walk";
    if (c.action !== newAction) c.action = newAction;
    // Push the snapshot. `stationary` short-circuits the interp so
    // anchored actors don't wobble between two near-identical positions.
    const stationary = row.state === "idle" || row.state === "working";
    this.pushStaffSnapshot(row.memberId, row.x, row.z, stationary);
  }

  /** Phase 8.3 — Roll the snapshot buffer forward: prevPos = previous
   * last, lastPos = new server pos. On the first push for this key,
   * seed both to the same coords so velocity = 0 and facing stays put. */
  private pushStaffSnapshot(memberId: string, x: number, z: number, stationary: boolean): void {
    const existing = this.liveStaffSnapshots.get(memberId);
    if (!existing) {
      this.liveStaffSnapshots.set(memberId, {
        prevPos: new THREE.Vector2(x, z),
        lastPos: new THREE.Vector2(x, z),
        stampMs: performance.now(),
        stationary,
      });
      // Seed groundPos so the very first render frame has a sensible
      // value. Later snapshots feed through tickLiveMotion.
      const c = this.liveStaffCharacters.get(memberId);
      if (c) c.groundPos.set(x, z);
    } else {
      existing.prevPos.copy(existing.lastPos);
      existing.lastPos.set(x, z);
      existing.stampMs = performance.now();
      existing.stationary = stationary;
    }
  }

  /** Same shape for live customers. */
  private pushCustomerSnapshot(key: string, x: number, z: number, stationary: boolean): void {
    const existing = this.liveCustomerSnapshots.get(key);
    if (!existing) {
      this.liveCustomerSnapshots.set(key, {
        prevPos: new THREE.Vector2(x, z),
        lastPos: new THREE.Vector2(x, z),
        stampMs: performance.now(),
        stationary,
      });
      const c = this.liveCustomerCharacters.get(key);
      if (c) c.groundPos.set(x, z);
    } else {
      existing.prevPos.copy(existing.lastPos);
      existing.lastPos.set(x, z);
      existing.stampMs = performance.now();
      existing.stationary = stationary;
    }
  }

  /** Phase 8.3 — Per-frame snapshot-interpolation. Engine.update calls
   * this BEFORE scene.update so the animator sees the freshly
   * interpolated groundPos + facingY when it composes each character's
   * world transform.
   *
   * For each live actor: LERP groundPos between prevPos and lastPos
   * based on wall-clock elapsed since the latest snapshot, clamped to
   * one tick window (500 ms). Compute facingY from the snapshot
   * velocity vector. Stationary characters skip LERP entirely so
   * sitting customers don't shiver between micro-different server
   * positions. */
  tickLiveMotion(): void {
    if (!this.activePlot) return;
    const SERVER_TICK_MS = 500;
    const now = performance.now();
    for (const [memberId, snap] of this.liveStaffSnapshots) {
      const c = this.liveStaffCharacters.get(memberId);
      if (!c) continue;
      this.applyOneSnapshot(c, snap, SERVER_TICK_MS, now);
    }
    for (const [key, snap] of this.liveCustomerSnapshots) {
      const c = this.liveCustomerCharacters.get(key);
      if (!c) continue;
      this.applyOneSnapshot(c, snap, SERVER_TICK_MS, now);
    }
  }

  private applyOneSnapshot(
    c: AnimatedCharacter,
    snap: {
      prevPos: THREE.Vector2;
      lastPos: THREE.Vector2;
      stampMs: number;
      stationary: boolean;
    },
    tickMs: number,
    now: number,
  ): void {
    if (snap.stationary) {
      // Anchored at a station / seat — pin to the latest snapshot
      // exactly. No interp, no velocity-derived facing.
      c.groundPos.set(snap.lastPos.x, snap.lastPos.y);
      return;
    }
    const elapsed = now - snap.stampMs;
    const t = Math.max(0, Math.min(1, elapsed / tickMs));
    const x = snap.prevPos.x + (snap.lastPos.x - snap.prevPos.x) * t;
    const z = snap.prevPos.y + (snap.lastPos.y - snap.prevPos.y) * t;
    c.groundPos.set(x, z);
    const vx = snap.lastPos.x - snap.prevPos.x;
    const vz = snap.lastPos.y - snap.prevPos.y;
    if (Math.hypot(vx, vz) > 0.001) {
      // GLB forward = -Z → atan2(-vx, -vz). Same convention as
      // StaffRouter + ErrandRouter so all roles + visit-mode actors
      // face along their motion vector consistently.
      c.facingY = Math.atan2(-vx, -vz);
    }
  }

  /** Remove a live staff character — server deleted the row (player
   * fired the staff member or unregistered the actor). Detach from
   * the animator + the visitor scene. */
  private removeLiveStaffActor(memberId: string): void {
    const c = this.liveStaffCharacters.get(memberId);
    if (!c) return;
    // H.A — Detach cloud-derived visuals BEFORE removing the
    // character root so each visualizer clears its parent ref cleanly.
    this.heldItems.setHost(memberId, null);
    this.cookingPots.setHost(memberId, null);
    this.scene.animator.remove(c.root);
    c.root.removeFromParent();
    this.liveStaffCharacters.delete(memberId);
    this.liveStaffSnapshots.delete(memberId);
    this.liveStaffCount = Math.max(0, this.liveStaffCount - 1);
    this.refreshLivenessLabel();
  }

  /** Dispose every live staff character. Called from exit(). */
  private disposeLiveStaff(): void {
    for (const c of this.liveStaffCharacters.values()) {
      this.scene.animator.remove(c.root);
      c.root.removeFromParent();
    }
    this.liveStaffCharacters.clear();
    this.liveStaffPendingLoads.clear();
    this.liveStaffSnapshots.clear();
    // Also dispose live customers (same lifecycle — both bound to the
    // current visit). Reset ticket counts so the next visit starts
    // clean. The subscription handlers stay attached but gated by
    // activePlot so they won't bleed into the next visit's data.
    for (const c of this.liveCustomerCharacters.values()) {
      this.scene.animator.remove(c.root);
      c.root.removeFromParent();
    }
    this.liveCustomerCharacters.clear();
    this.liveCustomerPendingLoads.clear();
    this.liveCustomerSnapshots.clear();
    this.liveTicketStates.clear();
    // Phase 8.1 — Bubble meta lives + dies with the visit.
    this.staffMetaByMember.clear();
    this.guestMetaById.clear();
    this.ticketMetaById.clear();
    // H.A — Drop all cloud-derived visualizer caches + any attached
    // meshes. Next visit re-subscribes and rebuilds from scratch.
    this.heldItems.dispose();
    this.seatPlates.dispose();
    this.cookingPots.dispose();
    this.washCycleRings.dispose();
    this.dirtyPiles.dispose();
    this.furniturePosByUid.clear();
    this.refreshLivenessLabel();
  }

  // ─── Live customer render (active_guest subscription) ────────────

  /** Subscribe to the host's active_guest table and render every row
   * as an animated character (chair-sitting / walking / etc.). Same
   * pattern + gating as live staff. */
  private startLiveCustomerSubscription(plot: VisitablePlot): void {
    if (!this.cloud) return;
    const hostRid = this.cloud.findRestaurantIdByOwnerHex(plot.ownerHex);
    if (hostRid == null) return;
    const targetPlotId = plot.id;
    let firedCount = 0;
    this.cloud.subscribeActiveGuestChanges({
      onInsert: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        firedCount += 1;
        // Phase 8.1 — Bubble meta (patience countdown, state icon).
        this.guestMetaById.set(String(row.id), {
          state: row.state,
          patienceMs: row.patienceMs,
          archetype: row.archetype,
          orderIndex: row.orderIndex,
        });
        // H.A — Plate-on-table reconcile alongside the character spawn.
        this.seatPlates.onGuest(row);
        void this.spawnLiveCustomerActor(row, targetPlotId);
      },
      onUpdate: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.guestMetaById.set(String(row.id), {
          state: row.state,
          patienceMs: row.patienceMs,
          archetype: row.archetype,
          orderIndex: row.orderIndex,
        });
        this.seatPlates.onGuest(row);
        this.applyLiveCustomerUpdate(row);
      },
      onDelete: (id) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.guestMetaById.delete(String(id));
        this.seatPlates.onGuestDelete(id);
        this.removeLiveCustomerActor(String(id));
      },
    }, hostRid);
    setTimeout(() => {
      if (this.activePlot?.id !== targetPlotId) return;
      console.log(`[Visit] live customers: ${firedCount} active_guest row(s) for restaurant ${hostRid}`);
    }, 2000);
  }

  /** Spawn one character for an active_guest row. Variant ("guest-vN")
   * maps directly to a character model id. Action picked from state:
   * "seated" / "eating" / "ordering" / "waitingForFood" → "sit";
   * everything else → "walk" (or "idle" for unknown). */
  private async spawnLiveCustomerActor(
    row: import("../cloud/SpacetimeClient").ActiveGuestRow,
    targetPlotId: bigint,
  ): Promise<void> {
    const key = String(row.id);
    if (this.liveCustomerCharacters.has(key)) return;
    if (this.liveCustomerPendingLoads.has(key)) return;
    this.liveCustomerPendingLoads.add(key);
    const modelId = row.variant && row.variant.startsWith("guest-") ? row.variant : "guest-v0";
    try {
      const model = await this.scene.characterLoader.load(modelId);
      if (this.activePlot?.id !== targetPlotId || !this.visitorRoot) {
        this.liveCustomerPendingLoads.delete(key);
        return;
      }
      const floor = Math.max(0, row.floor);
      model.position.set(row.x, floor * STOREY_HEIGHT, row.z);
      const action: CharacterAction = customerActionFor(row.state);
      const animated: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(row.x, row.z),
        facingY: 0,
        action,
        phase: Math.random() * 5,
        // 0.5 m chair lift — same as the existing ghost-customer
        // spawn so the sitting pose lands on the cushion when state
        // is "seated" / "eating".
        seatHeight: 0.5,
      };
      this.visitorRoot.add(model);
      this.scene.animator.add(animated);
      this.liveCustomerCharacters.set(key, animated);
      this.liveCustomerCount += 1;
      // Phase 8.3 — Seed snapshot. A guest spawned in "walkingIn"
      // is in transit; a guest spawned in "seated" is anchored.
      this.pushCustomerSnapshot(key, row.x, row.z, action === "sit" || action === "idle");
      this.refreshLivenessLabel();
    } catch (err) {
      console.warn(`[Visit] failed to spawn live customer ${modelId}:`, err);
    } finally {
      this.liveCustomerPendingLoads.delete(key);
    }
  }

  private applyLiveCustomerUpdate(row: import("../cloud/SpacetimeClient").ActiveGuestRow): void {
    const key = String(row.id);
    const c = this.liveCustomerCharacters.get(key);
    if (!c) {
      void this.spawnLiveCustomerActor(row, this.activePlot?.id ?? 0n);
      return;
    }
    const newAction = customerActionFor(row.state);
    if (c.action !== newAction) c.action = newAction;
    // Phase 8.3 — snapshot interp instead of direct snap. "sit" states
    // are stationary (server's row.x/z is the seat coords; LERP'ing
    // micro-differences would jitter the model).
    const stationary = newAction === "sit" || newAction === "idle";
    this.pushCustomerSnapshot(key, row.x, row.z, stationary);
  }

  private removeLiveCustomerActor(key: string): void {
    const c = this.liveCustomerCharacters.get(key);
    if (!c) return;
    this.scene.animator.remove(c.root);
    c.root.removeFromParent();
    this.liveCustomerCharacters.delete(key);
    this.liveCustomerSnapshots.delete(key);
    this.liveCustomerCount = Math.max(0, this.liveCustomerCount - 1);
    this.refreshLivenessLabel();
  }

  // ─── Live ticket counts (kitchen activity chip) ──────────────────

  /** Subscribe to the host's active_ticket table. Updates the visit
   * overlay's kitchen-activity counters as tickets transition through
   * queued / cooking / ready / delivering states. Same activePlot
   * gate as the staff sub. */
  private startLiveTicketSubscription(plot: VisitablePlot): void {
    if (!this.cloud) return;
    const hostRid = this.cloud.findRestaurantIdByOwnerHex(plot.ownerHex);
    if (hostRid == null) return;
    const targetPlotId = plot.id;
    this.cloud.subscribeActiveTicketChanges({
      onInsert: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.liveTicketStates.set(String(row.id), row.state);
        // Phase 8.1 — Bubble meta so chef labels can read
        // "🥘 [recipe name]" when cooking.
        this.ticketMetaById.set(String(row.id), {
          state: row.state, recipeId: row.recipeId,
          appliance: row.appliance, assignedChefId: row.assignedChefId,
        });
        // H.A — Cloud-derived visualizers need ticket state +
        // appliance + assigned chef to pick plate vs glass meshes
        // and to anchor the cooking pot on the right chef.
        this.heldItems.onTicket(row.id, row.state, row.appliance);
        this.cookingPots.onTicket(row.id, row.state, row.appliance, row.assignedChefId);
        this.refreshLivenessLabel();
      },
      onUpdate: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.liveTicketStates.set(String(row.id), row.state);
        this.ticketMetaById.set(String(row.id), {
          state: row.state, recipeId: row.recipeId,
          appliance: row.appliance, assignedChefId: row.assignedChefId,
        });
        this.heldItems.onTicket(row.id, row.state, row.appliance);
        this.cookingPots.onTicket(row.id, row.state, row.appliance, row.assignedChefId);
        this.refreshLivenessLabel();
      },
      onDelete: (id) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.liveTicketStates.delete(String(id));
        this.ticketMetaById.delete(String(id));
        this.heldItems.onTicketDelete(id);
        this.cookingPots.onTicketDelete(id);
        this.refreshLivenessLabel();
      },
    }, hostRid);
  }

  /** Phase H.A — Subscribe to the host's dishwasher_batch rows and
   * feed each into the WashCycleRingVisualizer. The ring position
   * resolver (set in loadVisitedInterior) reads furniturePosByUid
   * which the furniture-load loop populates as it places dishwashers
   * on the visit scene; if a batch event arrives before the
   * furniture has loaded, the visualizer no-ops and will pick the
   * batch up on the next update event after the furniture lands. */
  private startLiveDishwasherSubscription(plot: VisitablePlot): void {
    if (!this.cloud) return;
    const hostRid = this.cloud.findRestaurantIdByOwnerHex(plot.ownerHex);
    if (hostRid == null) return;
    const targetPlotId = plot.id;
    this.cloud.subscribeDishwasherBatchChanges({
      onInsert: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.washCycleRings.onBatch(row.furnitureUid, Number(row.cycleTimeRemainingMs));
      },
      onUpdate: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.washCycleRings.onBatch(row.furnitureUid, Number(row.cycleTimeRemainingMs));
      },
      onDelete: (uid) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.washCycleRings.onBatchDelete(uid);
      },
    }, hostRid);
  }

  /** Phase H.B — Subscribe to the host's dirty_pile rows and feed
   * each into the DirtyPileVisualizer. New cloud table; visit-mode
   * was previously dead silent on dirty piles because they were
   * local-sim only. */
  private startLiveDirtyPileSubscription(plot: VisitablePlot): void {
    if (!this.cloud) return;
    const hostRid = this.cloud.findRestaurantIdByOwnerHex(plot.ownerHex);
    if (hostRid == null) return;
    const targetPlotId = plot.id;
    this.cloud.subscribeDirtyPileChanges({
      onInsert: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.dirtyPiles.onPile(row);
      },
      onUpdate: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.dirtyPiles.onPile(row);
      },
      onDelete: (id) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.dirtyPiles.onPileDelete(id);
      },
    }, hostRid);
  }

  // ─── Interior render (P4.3) ──────────────────────────────────────

  /** Hide every city-shell + fence in the cityBuildings group while
   * the visit is active. The visited plot's shell is replaced by the
   * loaded interior (loadVisitedInterior), and the OTHER plots'
   * placeholder shells just clutter the view — the user reported the
   * neighbouring dark roofs distracted from the visited restaurant.
   *
   * Records which children we touched so restoreVisitedShells can put
   * them back in the same state on exit (in case the city was
   * re-populated mid-visit, we don't blindly unhide things that were
   * already hidden for unrelated reasons). */
  private hiddenShells: THREE.Object3D[] = [];
  private hideVisitedShell(_plot: VisitablePlot): void {
    if (!this.scene.cityBuildings) return;
    for (const child of this.scene.cityBuildings.children) {
      if (child.visible) {
        child.visible = false;
        this.hiddenShells.push(child);
      }
    }
  }

  private restoreVisitedShell(): void {
    for (const child of this.hiddenShells) {
      child.visible = true;
    }
    this.hiddenShells = [];
  }

  // ─── Phase 8.1 — Status-bubble parity ──────────────────────────────

  /** Build the same status-bubble payload the host's StaffRouter +
   * ErrandRouter + GuestSpawner produce — from the cloud row meta
   * captured by the subscription handlers. Engine.updateStatusBubbles
   * polls this every frame when a visit is active so the visitor sees
   * the host's chef cooking labels, waiter delivering badges, errand
   * boy trip phase, and guest patience countdowns over the SAME
   * characters the host sees.
   *
   * Empty / dim labels are filtered (the StatusBubbles renderer hides
   * empty-text entries anyway, but it saves a pool slot). */
  snapshotBubbles(): StatusEntry[] {
    if (!this.activePlot) return [];
    const out: StatusEntry[] = [];

    // ── Staff bubbles ──
    for (const [memberId, char] of this.liveStaffCharacters) {
      const meta = this.staffMetaByMember.get(memberId);
      if (!meta) continue;
      const label = this.buildStaffLabel(meta);
      if (!label) continue;
      out.push({
        key: `visit-staff-${memberId}`,
        character: char,
        label,
        // Errand bubble gets the same purple tint the host's
        // updateStatusBubbles uses for errand entries.
        bg: meta.role === "errand" ? "rgba(80, 50, 90, 0.85)" : undefined,
      });
    }

    // ── Guest bubbles ──
    for (const [guestId, char] of this.liveCustomerCharacters) {
      const meta = this.guestMetaById.get(guestId);
      if (!meta) continue;
      const { label, panic, eating } = this.buildGuestLabel(meta);
      if (!label) continue;
      out.push({
        key: `visit-guest-${guestId}`,
        character: char,
        label,
        // Mirror Engine.updateStatusBubbles' colour rules: panic
        // (low patience) → red, eating → green, default → amber.
        bg: panic
          ? "rgba(160, 40, 40, 0.9)"
          : eating
            ? "rgba(50, 110, 60, 0.85)"
            : undefined,
      });
    }

    return out;
  }

  /** Construct the chef/waiter/barman/errand label string. Mirrors
   * StaffRouter.snapshotStatus + ErrandRouter.snapshotStatus shape
   * but reads cloud meta instead of local sim state. */
  private buildStaffLabel(meta: {
    role: string; state: string;
    ticketId: bigint | null;
    errandPhase?: string | null;
  }): string {
    // Errand helper — phase emoji
    if (meta.role === "errand") {
      switch (meta.errandPhase ?? "") {
        case "walkingToDoor":
        case "exitingDoor":
        case "walkingToRoadEdge":
          return "🛒 →";
        case "offscreen":
          return "🛒 shopping";
        case "walkingFromRoadEdge":
        case "enteringDoor":
        case "walkingToCounter":
          return "🛒 ←";
        case "atCounter":
          return "📦 unloading";
        case "returningHome":
          return "🛒 done";
        default:
          return ""; // idle helper at home — no bubble
      }
    }
    // Chef / barman / waiter with a ticket — look up recipe name.
    if (meta.ticketId != null) {
      const ticketMeta = this.ticketMetaById.get(String(meta.ticketId));
      const recipeName = ticketMeta
        ? (recipes.find((r) => r.id === ticketMeta.recipeId)?.name ?? ticketMeta.recipeId)
        : "";
      if (meta.role === "chef" || meta.role === "barman") {
        const icon = meta.role === "barman" ? "🍷" : "🥘";
        return recipeName ? `${icon} ${recipeName}` : icon;
      }
      if (meta.role === "waiter") {
        // No table number from cloud yet; just the recipe.
        return recipeName ? `🍽 ${recipeName}` : "🍽";
      }
    }
    // Idle staff — no bubble (matches host's empty-label semantic).
    return "";
  }

  /** Construct the guest label string + decide the colour-coding flags. */
  private buildGuestLabel(meta: {
    state: string; patienceMs: bigint;
    archetype: string; orderIndex: number;
  }): { label: string; panic: boolean; eating: boolean } {
    const arch = customerArchetypes.find((a) => a.id === meta.archetype);
    const prefix = arch?.shortLabel ?? "👤";
    const patienceSecs = Math.max(0, Math.ceil(Number(meta.patienceMs) / 1000));
    const panic = patienceSecs > 0 && patienceSecs <= 10;
    switch (meta.state) {
      case "walkingIn":
      case "walkingToWait":
        return { label: `${prefix} ⏳`, panic, eating: false };
      case "waitingForSeat":
        return { label: `${prefix} 🪑 ${patienceSecs}s`, panic, eating: false };
      case "seated":
      case "ordering": {
        const secs = patienceSecs > 0 ? ` ${patienceSecs}s` : "";
        return { label: `${prefix} 📋${secs}`, panic, eating: false };
      }
      case "waitingForFood": {
        const secs = patienceSecs > 0 ? ` ${patienceSecs}s` : "";
        return { label: `${prefix} ⏳${secs}`, panic, eating: false };
      }
      case "eating":
        return { label: `${prefix} 🍴`, panic: false, eating: true };
      case "wcWalking":
      case "wcSitting":
        return { label: `${prefix} 🚻`, panic: false, eating: false };
      case "wcWashing":
        return { label: `${prefix} 🧼`, panic: false, eating: false };
      default:
        return { label: "", panic: false, eating: false };
    }
  }

  private disposeVisitorRoot(): void {
    // Detach every spawned ghost from the animator first — leaving
    // them registered would mean per-frame idle/sit poses still
    // ticking on meshes that have already been removed from the
    // scene, accumulating wasted work across repeat visits.
    for (const root of this.spawnedGhostRoots) {
      this.scene.animator.remove(root);
    }
    this.spawnedGhostRoots = [];
    this.liveCustomerCount = 0;
    this.liveStaffCount = 0;
    this.livenessEl = null;
    // Dispose wall materials we own — unlike furniture geometries
    // (shared via the loader cache), the wallMat / ghostMat / floorMat
    // are freshly built per visit, so we free them here to keep GPU
    // memory from growing on repeat visits. Floor materials don't
    // round-trip through the tracker, but they're parented to
    // visitorRoot meshes and will be released alongside the root's
    // tree when worldRoot.remove happens below.
    for (const entry of this.wallTracker.values()) {
      entry.wallMat.dispose();
      entry.ghostMat.dispose();
    }
    this.wallTracker.clear();
    if (!this.visitorRoot) return;
    this.scene.worldRoot.remove(this.visitorRoot);
    // Geometries + materials come from the shared ModelLoader cache —
    // do NOT dispose them here or the player's own restaurant loses
    // every furniture mesh on the next visit.
    this.visitorRoot = null;
  }

  // ─── Camera-relative wall ghost swap ──────────────────────────────

  /** Per-frame: swap the two perimeter walls the camera is on the
   * OUTDOOR side of to the transparent ghost material so the visitor
   * can see into the dining room. Mirrors host's
   * WorldScene.updateWallVisibility (line 2308) but uses
   * coordinates LOCAL to the visited plot (camera world pos minus the
   * plot's world position) — the host's walls live at world origin
   * so it can use the camera world pos directly, while the visit
   * plot can be anywhere in the city grid.
   *
   * Engine wires this into the render loop alongside the host's own
   * updateWallVisibility call so visit + host stay in lockstep on
   * wall visibility from frame to frame. No-op when no visit is
   * active or the interior shell hasn't built yet. */
  updateWallVisibility(cameraWorldPos: THREE.Vector3): void {
    const plot = this.activePlot;
    if (!plot || !this.visitorRoot || this.wallTracker.size === 0) return;
    // Visitor root sits at (plot.plotX, 0, plot.plotZ) LOCAL to
    // worldRoot, which itself is offset by worldRoot.position. So
    // the plot's absolute world position is the sum, and the
    // camera-in-plot-local-space is cameraWorldPos minus that sum.
    // Wall axis math in wallBuilder is in plot-local coords (walls at
    // x ∈ {-4.5, 5.5}, z ∈ {-4.5, 5.5}), so this puts the dot product
    // on the same scale the host's check uses.
    const offsetX = this.scene.worldRoot.position.x + plot.plotX;
    const offsetZ = this.scene.worldRoot.position.z + plot.plotZ;
    const camLocal = { x: cameraWorldPos.x - offsetX, z: cameraWorldPos.z - offsetZ };
    for (const entry of this.wallTracker.values()) {
      for (const dir of ["front", "back", "left", "right"] as const) {
        const kind = wallKindForCamera(dir, camLocal);
        if (kind === entry.currentKind[dir]) continue;
        // Visit mode hides the camera-side walls ENTIRELY instead of
        // ghosting them to 15% opacity (the host's behaviour). The
        // visitor is just observing — no need to keep the wall outline
        // visible as an orientation hint, and full-hide reads as the
        // "see straight in" experience users expect from a doll-house
        // view. Solid keeps the original wallMat; ghost flips
        // mesh.visible = false on every segment for the swept direction.
        const visible = kind === "solid";
        const mat = entry.wallMat;
        for (const mesh of entry.perDir[dir]) {
          mesh.material = mat;
          mesh.visible = visible;
        }
        entry.currentKind[dir] = kind;
      }
    }
  }

  private async loadVisitedInterior(plot: VisitablePlot): Promise<void> {
    const blob = this.fetchVisitedSaveBlob?.(plot.ownerHex);
    if (!blob) return; // overlay already shows "(save not synced yet)"
    let save: {
      furniture?: SavedFurniture[];
      staffMembers?: Array<{ role?: string }>;
      staff?: { chefs?: number; waiters?: number; errandBoys?: number };
      expansionLevel?: number;
      luxuryTier?: number;
    };
    try {
      save = JSON.parse(blob);
    } catch (e) {
      console.warn("[Visit] failed to parse visited save:", e);
      return;
    }
    if (!save.furniture || !Array.isArray(save.furniture)) return;

    // Visitor root lives INSIDE worldRoot at the plot's local
    // coordinates — so the same worldRoot offset that positions every
    // other player's shell also positions our render. The save's
    // placements are in restaurant-local coords (origin = building
    // centre), which is exactly what we want here too.
    const root = new THREE.Group();
    root.position.set(plot.plotX, 0, plot.plotZ);
    this.scene.worldRoot.add(root);
    this.visitorRoot = root;

    // Phase visit-shell — render the same interior structural pieces
    // the host sees: white floor plane, 4 perimeter walls with the
    // host's door/window cuts, upper storey slabs + walls if the save
    // unlocked them, roof. Wall geometry is shared with the host via
    // src/scene/wallBuilder so visit + host walls are guaranteed to
    // match. Door/window edges come from the save snapshot's
    // furniture list — same source the host reads from its registry.
    const expansionLevel = readExpansionLevelFromSave(save);
    const wallSourcePlacements: OpeningSourcePlacement[] = (save.furniture ?? []).map((p) => ({
      defId: p.furnitureId,
      x: p.position.x,
      // Save snapshot's "y" is world Z (legacy 2D-grid naming;
      // matches the same alias used downstream in the furniture
      // load above — see line ~927).
      z: p.position.y,
      floor: Math.max(0, p.floor ?? 0),
    }));
    // Visit-mode theme parity — read the visited restaurant's
    // per-floor theme overrides from the cloud Restaurant row
    // (DecorModal pushes via set_restaurant_theme_overrides on every
    // applyTheme). Falls back to the catalog default when the host
    // hasn't customised. Map storey index → catalog theme so the
    // shell builder reads wallColor + floorColor directly.
    const themeCsv = this.cloud?.getRestaurantThemeOverridesByOwnerHex(plot.ownerHex) ?? "";
    const themesByFloor = parseThemeOverridesCsv(themeCsv);
    const restaurantName = this.cloud?.getRestaurantNameByOwnerHex(plot.ownerHex) ?? "Cozy Bistro";
    const signStyle = this.cloud?.getRestaurantSignStyleByOwnerHex(plot.ownerHex)
      ?? { font: "serif", textColor: "cream", plaqueStyle: "dark" };
    const rating = this.cloud?.getRestaurantRatingByOwnerHex(plot.ownerHex) ?? 0;
    this.buildInteriorShell(
      root, expansionLevel, wallSourcePlacements, themesByFloor,
      restaurantName, signStyle, rating,
    );

    // H.A — Wire visualizers that need a scene-mount and/or
    // furniture-position resolver. SeatPlate plates need a per-floor
    // mount, but for now we only support floor 0 in visit mode (a
    // single visitorRoot); the SeatPlateVisualizer falls back to the
    // single root via setFallbackRoot.
    this.seatPlates.setFallbackRoot(root);
    this.washCycleRings.setRoot(root);
    this.washCycleRings.setResolver((uid) => this.furniturePosByUid.get(uid) ?? null);
    this.dirtyPiles.setFallbackRoot(root);

    // Snapshot the active plot id — if the player exits mid-load
    // we must NOT keep adding meshes to a stale root.
    const targetPlotId = plot.id;

    // Categorize placements while we load so the activity-spawn pass
    // below can find chairs / stoves / counters / bars in O(items).
    const placements: PlacementSlot[] = [];

    await Promise.all(save.furniture.map(async (p) => {
      if (!this.visitorRoot || this.activePlot?.id !== targetPlotId) return;
      const def = getFurnitureDef(p.furnitureId);
      if (!def) return;
      // Record the slot regardless of whether the model loads — for
      // activity placement we only need the position + category,
      // and we want chairs to seat ghosts even if a single chair
      // mesh fails to load.
      placements.push({
        x: p.position.x,
        z: p.position.y,
        rotationRad: ((p.rotation ?? 0) * Math.PI) / 180,
        floor: Math.max(0, p.floor ?? 0),
        category: def.category,
      });
      // H.A — Cache every placed piece's position by uid so the
      // WashCycleRingVisualizer can resolve dishwasher locations
      // (and future visualizers can too — anchored-to-furniture
      // visuals are common).
      this.furniturePosByUid.set(p.uid, {
        x: p.position.x,
        z: p.position.y,
        floor: Math.max(0, p.floor ?? 0),
      });
      try {
        const model = await this.scene.loader.load(def.modelPath);
        if (!this.visitorRoot || this.activePlot?.id !== targetPlotId) return;
        // Each load returns a fresh clone from the cache. Pose it.
        fitFurniture(model, def);
        const floor = Math.max(0, p.floor ?? 0);
        const rotY = ((p.rotation ?? 0) * Math.PI) / 180;
        model.position.set(
          p.position.x,
          placementY(model, def) + floor * STOREY_HEIGHT,
          p.position.y, // save's "y" is world Z (legacy 2D grid naming)
        );
        model.rotation.y = rotY;
        // If the placed piece is a lamp, attach a warm point light
        // matching what the host's registerLamp does. Without this
        // visited interiors render lamp GLBs as dark static geometry
        // — host shows them glowing.
        attachLampLight(model, def.id);
        this.visitorRoot.add(model);
      } catch (err) {
        console.warn(`[Visit] failed to load ${def.id}:`, err);
      }
    }));

    // Furniture is in place — populate the visit with live characters.
    // Fire-and-forget; each character spawn updates the overlay's
    // liveness counter as it lands.
    if (this.activePlot?.id === targetPlotId) {
      void this.spawnVisitorActivity(plot, save, placements);
    }
  }

  /** Spawn the host's staff + a roster of seated ghost customers so
   * the visited restaurant reads as alive instead of an empty doll-
   * house. Driven entirely by the published save snapshot — there's
   * no live state sync, but staff counts + furniture positions give
   * enough information to fake a believable scene. */
  private async spawnVisitorActivity(
    plot: VisitablePlot,
    save: {
      staffMembers?: Array<{ role?: string }>;
      staff?: { chefs?: number; waiters?: number; errandBoys?: number };
    },
    placements: PlacementSlot[],
  ): Promise<void> {
    if (!this.visitorRoot) return;
    const targetPlotId = plot.id;

    // Bucket placements by category so we can match staff to their
    // workstations without rescanning the list per character.
    const chairs: PlacementSlot[] = [];
    const stoves: PlacementSlot[] = [];
    const counters: PlacementSlot[] = [];
    const bars: PlacementSlot[] = [];
    for (const p of placements) {
      switch (p.category) {
        case "chair":   chairs.push(p); break;
        case "stove":   stoves.push(p); break;
        case "counter": counters.push(p); break;
        case "bar":     bars.push(p); break;
      }
    }

    // === Resolve the staff roster ===
    // Prefer staffMembers (the per-individual list); fall back to the
    // aggregate counts for legacy saves that never wrote the detailed
    // array. Each entry distils down to a role string.
    const roles: ("chef" | "waiter" | "barman" | "errand")[] = [];
    if (Array.isArray(save.staffMembers) && save.staffMembers.length > 0) {
      for (const m of save.staffMembers) {
        const role = m.role;
        if (role === "chef" || role === "waiter" || role === "barman" || role === "errand") {
          roles.push(role);
        }
      }
    } else {
      const s = save.staff ?? {};
      for (let i = 0; i < (s.chefs ?? 0); i += 1) roles.push("chef");
      for (let i = 0; i < (s.waiters ?? 0); i += 1) roles.push("waiter");
      for (let i = 0; i < (s.errandBoys ?? 0); i += 1) roles.push("errand");
    }

    // === Spawn the staff ===
    // Each role prefers a category of workstation; falls back to a
    // generic "stand near the centre" pose if no station of that
    // category was placed in the visited save.
    const stationByRole: Record<string, PlacementSlot[]> = {
      chef: stoves.length ? stoves : counters,
      waiter: counters.length ? counters : chairs,
      barman: bars.length ? bars : counters,
      errand: counters.length ? counters : stoves,
    };
    const counterCursor: Record<string, number> = {};
    const staffPromises: Promise<void>[] = [];
    // Skip ghost-staff spawn if the host has live data — the
    // subscription has already populated liveStaffCharacters with the
    // server's actual chefs / waiters / barmen (which actually walk).
    // Without this check we'd double up: one static ghost AND one
    // live actor for every staff member.
    //
    // Check liveStaffPendingLoads (synchronously incremented inside
    // spawnLiveStaffActor BEFORE the async GLB load) in addition to
    // liveStaffCharacters (only set post-await). spawnVisitorActivity
    // can reach this gate while every live spawn is still mid-load,
    // so checking only liveStaffCharacters.size would race and let
    // the ghost path fire too — double rendering.
    const hasLiveStaff = this.liveStaffCharacters.size > 0 || this.liveStaffPendingLoads.size > 0;
    if (hasLiveStaff) {
      console.log(`[Visit] static ghost-staff spawn skipped — ${this.liveStaffCharacters.size + this.liveStaffPendingLoads.size} live actor(s) rendering or loading`);
    } else {
      for (const role of roles) {
        const pool = stationByRole[role] ?? counters;
        let slot: PlacementSlot | undefined;
        if (pool.length > 0) {
          const idx = (counterCursor[role] ?? 0) % pool.length;
          counterCursor[role] = idx + 1;
          slot = pool[idx];
        }
        staffPromises.push(this.spawnGhostCharacter(role, slot, "idle", targetPlotId, /* isStaff */ true));
      }
    }

    // === Spawn the seated ghost customers ===
    // Customer count derives from rating × 1.5 capped by chair count
    // — high-rated restaurants read as busier without ever placing
    // more guests than there are chairs to seat them at. Ratings are
    // pulled from the same fetcher the popup never uses but is still
    // present for analytics; absent rating defaults to 3.0.
    const ratingForCount = this.fetchVisitedStats?.(plot.ownerHex)?.ratingAvg ?? 3.0;
    const targetCustomerCount = Math.max(
      0,
      Math.min(
        chairs.length,
        Math.floor(1 + ratingForCount * 1.5),
      ),
    );
    // Fisher-Yates shuffle in place (avoid Array.sort with random,
    // which is biased and produces uneven distributions).
    const shuffledChairs = chairs.slice();
    for (let i = shuffledChairs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledChairs[i], shuffledChairs[j]] = [shuffledChairs[j], shuffledChairs[i]];
    }
    const customerPromises: Promise<void>[] = [];
    // Same logic as staff: skip ghost customers when live data exists
    // for the host so we don't double up real-time customers with
    // procedurally-placed ghosts.
    //
    // Check pending loads too — the async GLB load race means
    // liveCustomerCharacters can be empty even when the subscription
    // has already received N inserts. See the staff equivalent above.
    const hasLiveCustomers = this.liveCustomerCharacters.size > 0 || this.liveCustomerPendingLoads.size > 0;
    if (hasLiveCustomers) {
      console.log(`[Visit] static ghost-customer spawn skipped — ${this.liveCustomerCharacters.size + this.liveCustomerPendingLoads.size} live customer(s) rendering or loading`);
    } else {
      for (let i = 0; i < targetCustomerCount; i += 1) {
        const variant = GUEST_VARIANT_IDS[Math.floor(Math.random() * GUEST_VARIANT_IDS.length)];
        customerPromises.push(this.spawnGhostCharacter(variant, shuffledChairs[i], "sit", targetPlotId, /* isStaff */ false));
      }
    }

    await Promise.all([...staffPromises, ...customerPromises]);
    // Final overlay refresh — sometimes a single character spawn fails
    // and the running tally would land slightly off; this is the
    // settle-state pass.
    this.refreshLivenessLabel();
  }

  /** Load + position a single ghost character. modelId is the loader
   * key — either a role ("chef"/"waiter"/...) or a guest variant
   * ("guest-v3"). The character registers with the scene's animator
   * so the existing idle / sit poses tick on it; on visit exit
   * disposeVisitorRoot detaches it. */
  private async spawnGhostCharacter(
    modelId: string,
    slot: PlacementSlot | undefined,
    action: CharacterAction,
    targetPlotId: bigint,
    isStaff: boolean,
  ): Promise<void> {
    if (!this.visitorRoot || this.activePlot?.id !== targetPlotId) return;
    try {
      const model = await this.scene.characterLoader.load(modelId);
      if (!this.visitorRoot || this.activePlot?.id !== targetPlotId) return;
      // Pull the character a metre off the workstation so they read
      // as standing BESIDE it rather than inside it; sitting ghosts
      // anchor directly on the chair slot so seatHeight lifts them to
      // the seat cushion.
      let x = slot?.x ?? 0;
      let z = slot?.z ?? 0;
      const facingY = slot?.rotationRad ?? 0;
      const floor = slot?.floor ?? 0;
      if (action !== "sit" && slot) {
        // Step backward from the workstation along the slot's facing
        // direction so the character ends up on the "approach" side
        // (chefs in front of stoves, waiters at the counter front).
        const back = 0.55;
        x -= Math.sin(facingY) * back;
        z -= Math.cos(facingY) * back;
      }
      model.position.set(x, floor * STOREY_HEIGHT, z);
      model.rotation.y = facingY;
      const animated: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(x, z),
        facingY,
        action,
        phase: Math.random() * 5,
        // Chair seat height — matches the player's own guests so the
        // sitting pose lands the character on the cushion, not the floor.
        seatHeight: 0.5,
      };
      this.visitorRoot.add(model);
      this.scene.animator.add(animated);
      this.spawnedGhostRoots.push(model);
      if (isStaff) this.liveStaffCount += 1;
      else this.liveCustomerCount += 1;
      this.refreshLivenessLabel();
    } catch (e) {
      console.warn(`[Visit] failed to spawn ghost ${modelId}:`, e);
    }
  }

  /** Update the overlay's liveness chip in-place. Cheap textContent
   * write — no DOM rebuild — so we can call it from every spawn
   * callback without thrashing layout. */
  private refreshLivenessLabel(): void {
    if (!this.livenessEl) return;
    const c = this.liveCustomerCount;
    const s = this.liveStaffCount;
    // Kitchen activity from active_ticket rows. Aggregate the four
    // in-flight states so a visitor reads how busy the host's kitchen
    // is right now. "delivered" is a transient dwell state, skipped.
    let cooking = 0, ready = 0;
    for (const state of this.liveTicketStates.values()) {
      if (state === "cooking") cooking += 1;
      else if (state === "ready") ready += 1;
    }
    // Distinguish LIVE data (subscription is wired + host has rows)
    // from FROZEN data (just the static ghost-activity spawn from the
    // save snapshot). Helps the player tell whether they're seeing
    // real-time motion or a placeholder scene at a glance.
    const hasLive = this.liveStaffCharacters.size > 0
      || this.liveCustomerCharacters.size > 0
      || this.liveTicketStates.size > 0;
    const liveBadge = hasLive ? "🔴 LIVE · " : "❄ STATIC · ";
    const baseEmpty = c === 0 && s === 0;
    const kitchenIdle = cooking === 0 && ready === 0;
    if (baseEmpty && kitchenIdle) {
      this.livenessEl.textContent = `${liveBadge}(quiet right now)`;
      return;
    }
    const parts: string[] = [];
    if (c > 0) parts.push(`🍽 ${c} seated`);
    if (s > 0) parts.push(`👤 ${s} staff`);
    if (cooking > 0) parts.push(`🍳 ${cooking} cooking`);
    if (ready > 0) parts.push(`🛎 ${ready} ready`);
    this.livenessEl.textContent = liveBadge + parts.join(" · ");
  }

  // ─── Top-center "Visiting X · Exit" overlay ─────────────────────

  private showOverlay(plot: VisitablePlot): void {
    this.hideOverlay();
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "fixed",
      top: "70px", // below the camera-controls + floor-selector row
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(20, 14, 10, 0.92)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.55)",
      borderRadius: "10px",
      padding: "8px 14px",
      font: "14px/1.3 system-ui, sans-serif",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      boxShadow: "0 4px 18px rgba(0, 0, 0, 0.45)",
      zIndex: "15",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    const label = document.createElement("span");
    label.innerHTML = `🏃 Visiting <b>${escapeHtml(plot.ownerName)}'s</b> restaurant`;
    wrap.appendChild(label);
    // Liveness — counts of staff + seated customers actually visible
    // inside the restaurant right now. Replaces the old money / rating
    // / tier stat strip: the visit is meant to be about WATCHING the
    // restaurant in motion, not reading a numbers card.
    const liveness = document.createElement("span");
    Object.assign(liveness.style, {
      fontSize: "12px",
      opacity: "0.85",
      borderLeft: "1px solid rgba(255, 220, 150, 0.3)",
      paddingLeft: "10px",
    } as Partial<CSSStyleDeclaration>);
    liveness.textContent = "loading…";
    wrap.appendChild(liveness);
    this.livenessEl = liveness;
    const exit = document.createElement("button");
    exit.textContent = "Exit Visit";
    Object.assign(exit.style, {
      background: "rgba(200, 100, 100, 0.30)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 180, 180, 0.55)",
      borderRadius: "6px",
      padding: "4px 12px",
      cursor: "pointer",
      font: "inherit",
      fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    exit.onclick = () => this.exit();
    wrap.appendChild(exit);
    this.container.appendChild(wrap);
    this.overlay = wrap;
  }

  private hideOverlay(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  /** Construct the visited restaurant's interior shell (floor + walls
   * + multi-storey slabs + stairs + roof) into the visitor root.
   * Mirrors what WorldScene.addBuilding does for the host, including
   * the door/window opening cuts driven by the visited save's
   * furniture list.
   *
   * Coords match the host exactly: floor is 10×10 centered at (0.5,
   * 0, 0.5), walls span X∈[−4.5, 5.5] and Z∈[−4.5, 5.5]. Each storey
   * sits at floorIdx × STOREY_HEIGHT.
   *
   * Perimeter wall geometry comes from the shared wallBuilder module
   * — the same buildPerimeterWallSegments call WorldScene uses on the
   * host's own scene. Visit mode passes a single shared wallMat
   * (no ghost-wall transparency needed — visitors only view from the
   * default iso angle) and extracts openings from the placement list
   * via the shared extractWallOpenings helper. */
  private buildInteriorShell(
    root: THREE.Group,
    expansionLevel: number,
    placements: readonly OpeningSourcePlacement[],
    themesByFloor: Map<number, RestaurantTheme>,
    restaurantName: string,
    signStyle: { font: string; textColor: string; plaqueStyle: string },
    rating: number,
  ): void {
    const W = 10;
    // Per-storey materials cloned from the picked theme. Themes carry
    // wallColor + floorColor as numeric hex (data/themes.ts); host's
    // setStoreyTheme writes them onto cloned-per-floor materials so
    // each floor can have its own DecorModal choice. Visit mode does
    // the same, falling back to the catalog default (RESTAURANT_THEMES[0]
    // = "plain-white") when no override was set for that floor.
    const defaultTheme = RESTAURANT_THEMES[0];
    /** Per-floor material trio. wallMat = solid theme-tinted wall;
     * ghostMat = same colour but transparent (opacity 0.15) with
     * depthWrite off so it doesn't write into the depth buffer and
     * occlude things behind it — same recipe as WorldScene.wallGhostMat
     * (line 1838) so the ghosted wall reads identically in visit mode.
     * floorMat = theme-driven slab/floor. */
    const materialForFloor = (floorIdx: number): { wallMat: THREE.Material; ghostMat: THREE.Material; floorMat: THREE.Material } => {
      const theme = themesByFloor.get(floorIdx) ?? defaultTheme;
      return {
        wallMat: new THREE.MeshStandardMaterial({
          color: theme.wallColor, roughness: 0.85, side: THREE.DoubleSide,
        }),
        ghostMat: new THREE.MeshStandardMaterial({
          color: theme.wallColor, roughness: 0.6, side: THREE.DoubleSide,
          transparent: true, opacity: 0.15, depthWrite: false,
        }),
        floorMat: new THREE.MeshStandardMaterial({
          color: theme.floorColor, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
        }),
      };
    };
    // Roof keeps the catalog beige — host's mansard isn't theme-driven.
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0xe8d8b8, roughness: 0.9, side: THREE.DoubleSide,
    });

    // Extract openings keyed by floor + direction from the save's
    // furniture. Same algorithm the host's Engine.allPerimeterOpenings
    // runs against its placed-furniture registry — just sourced from
    // the save snapshot here.
    const openingsByFloor = extractWallOpenings(placements, getFurnitureDef);

    /** Construct one storey's perimeter walls + slab. floorIdx 0 has
     * no slab (the ground floor uses a PlaneGeometry directly).
     * Walls are tracked per-direction in this.wallTracker so the
     * per-frame updateWallVisibility() can swap to ghostMat on the
     * two walls the camera is currently looking at — same behaviour
     * the host's WorldScene.updateWallVisibility provides on the
     * player's own restaurant. */
    const buildStorey = (floorIdx: number): void => {
      const baseY = floorIdx * STOREY_HEIGHT;
      const { wallMat, ghostMat, floorMat } = materialForFloor(floorIdx);
      // Slab (upper storeys only — ground floor has its own floor mesh).
      if (floorIdx > 0) {
        const slab = new THREE.Mesh(new THREE.PlaneGeometry(W, W), floorMat);
        slab.rotation.x = -Math.PI / 2;
        slab.position.set(0.5, baseY, 0.5);
        slab.receiveShadow = true;
        root.add(slab);
      } else {
        // Ground floor: PlaneGeometry with the theme-driven floor mat.
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, W), floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(0.5, 0.0, 0.5);
        floor.receiveShadow = true;
        root.add(floor);
      }
      // 4 perimeter walls. Build via the shared wallBuilder so doors +
      // windows in the save snapshot cut the same gap shapes the host
      // sees (full-height + 1 m lintel for doors; sill + lintel +
      // open middle band for windows). Capture the returned mesh array
      // per-direction so the wall tracker can material-swap them later.
      const floorOpenings = openingsByFloor.get(floorIdx) ?? emptyFloorOpenings();
      const perDir: Record<WallDir, THREE.Mesh[]> = {
        front: [], back: [], left: [], right: [],
      };
      for (const dir of ["front", "back", "left", "right"] as const) {
        perDir[dir] = buildPerimeterWallSegments(root, dir,
          floorOpenings[dir].doors,
          floorOpenings[dir].windows, {
            yOffset: baseY,
            resolveMaterial: () => wallMat,
            castShadow: false,
            receiveShadow: true,
          },
        );
      }
      this.wallTracker.set(floorIdx, {
        wallMat, ghostMat, perDir,
        // Seed with "solid" so the first updateWallVisibility tick
        // can detect the kind change and apply ghost where needed —
        // walls were built with wallMat above, so this matches reality.
        currentKind: { front: "solid", back: "solid", left: "solid", right: "solid" },
      });
    };

    buildStorey(0);

    // Upper storeys per expansion level. Expansion level 1 = ground
    // only; 2 = +floor 1; up to MAX_STOREYS. Defensive clamp keeps a
    // bogus save value from rendering an arbitrary number of floors.
    const maxStoreys = Math.max(1, Math.min(expansionLevel, 4));
    for (let idx = 1; idx < maxStoreys; idx += 1) {
      buildStorey(idx);
      // Visual staircase flight from floor (idx-1) up to floor idx.
      // buildStaircaseFlight takes baseY = idx × STOREY_HEIGHT and
      // builds the steps DOWN into the floor below; mirrors the host's
      // addStaircaseSegment placement (the flight is parented to the
      // storey it LEAVES from on the host side, but visit mode just
      // parents everything under the visitorRoot — same visual).
      buildStaircaseFlight(root, idx * STOREY_HEIGHT);
    }

    // Back-wall supply counter. Procedural cabinet + crates the host
    // builds on every restaurant — visit mode mirrors so the kitchen
    // line reads complete from above. Always on the ground floor.
    buildSupplyCounterMesh(root);

    // Paris-style exterior decoration: cornice bands per floor +
    // iron balconies on upper floors. Mansard + cap + chimney are
    // SKIPPED in visit mode — see buildParisExteriorDecor's
    // ghostRoof branch. The host's WorldScene hides those same
    // pieces in interior view (applyStoreyVisibility) because the
    // camera looks down into a focused floor and a slate roof would
    // occlude it. Visit mode is always interior-view from the
    // visitor's perspective, so the same rule applies. Cornice +
    // balconies stay since they're at upper-floor cornice height,
    // not on top of the roof.
    buildParisExteriorDecor(root, maxStoreys, { ghostRoof: true });

    // Front-door rating sign with the visited restaurant's name +
    // host's plaque style + live star rating average. All three
    // arrive via cloud now: name from Restaurant.name, style from
    // the three sign_* fields (foreground client pushes via
    // setRestaurantSignStyle on every RestaurantSignModal save),
    // rating from cloud_rating_history_csv (foreground client pushes
    // via setCloudRatingHistory on every recordRating). Visit mode
    // renders the same plaque the host sees on their own door.
    buildRatingSign(root, restaurantName, signStyle, rating);

    // Flat roof skipped — the Paris mansard added by
    // buildParisExteriorDecor sits at the same Y and covers the same
    // footprint. Host's WorldScene also keeps the flat plane hidden
    // (line 2008) once the mansard is built.
    void roofMat;
  }
}

/** Read the player's expansion / luxury tier out of the save snapshot.
 * Falls back to 1 (ground floor only) if the field is missing or
 * unrecognized. Matches the field names the host's SaveSystem writes —
 * keep in sync if those change. */
function readExpansionLevelFromSave(save: { expansionLevel?: number; luxuryTier?: number }): number {
  return save.expansionLevel ?? save.luxuryTier ?? 1;
}

/** Parse the cloud Restaurant.theme_overrides_csv into a per-floor
 * theme map. Format is "storey:theme_id|storey:theme_id" — see the
 * server-side comment on the column for the canonical shape. Returns
 * an empty map for empty / null CSV. Unknown theme ids are skipped
 * (graceful degradation if the catalog dropped an entry). */
function parseThemeOverridesCsv(csv: string): Map<number, RestaurantTheme> {
  const out = new Map<number, RestaurantTheme>();
  if (!csv) return out;
  for (const entry of csv.split("|")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    const floor = Number(trimmed.slice(0, sep));
    if (!Number.isFinite(floor) || floor < 0) continue;
    const themeId = trimmed.slice(sep + 1).trim();
    const theme = RESTAURANT_THEMES.find((t) => t.id === themeId);
    if (theme) out.set(floor, theme);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
