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
  type OpeningSourcePlacement,
} from "../scene/wallBuilder";
import {
  buildStaircaseFlight, buildSupplyCounterMesh, attachLampLight,
  buildParisExteriorDecor, buildRatingSign,
} from "../scene/interiorPieces";
import { RESTAURANT_THEMES, type RestaurantTheme } from "../data/themes";

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
  /** Shell mesh at the visited plot — hidden during visit so the
   * loaded interior is unobstructed by the placeholder facade.
   * Re-shown on exit. */
  private hiddenShell: THREE.Object3D | null = null;
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
  /** Live customer characters from active_guest subscription, keyed by
   * the server's guest id (as string). Spawn-on-insert, snap-on-
   * update, dispose-on-delete — same pattern as liveStaffCharacters. */
  private liveCustomerCharacters: Map<string, AnimatedCharacter> = new Map();
  private liveCustomerPendingLoads: Set<string> = new Set();

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
        // H.A — Update the held-item visualizer's cache BEFORE the
        // character GLB has loaded; reconcile() will no-op until
        // setHost arrives in spawnLiveStaffActor's success branch.
        this.heldItems.onStaffActor(row.memberId, row.ticketId);
        this.cookingPots.onStaffActor(row.memberId, row.ticketId);
        void this.spawnLiveStaffActor(row, targetPlotId);
      },
      onUpdate: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.heldItems.onStaffActor(row.memberId, row.ticketId);
        this.cookingPots.onStaffActor(row.memberId, row.ticketId);
        this.applyLiveStaffUpdate(row);
      },
      onDelete: (memberId) => {
        if (this.activePlot?.id !== targetPlotId) return;
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

  /** Apply one row update — snap the character's groundPos to the
   * server's position. With the server stepping at 10 Hz this gives
   * an effectively smooth walk; the per-frame animation routine
   * picks up the moved groundPos and lerps the visible model
   * position the same way it does for the player's own characters. */
  private applyLiveStaffUpdate(row: import("../cloud/SpacetimeClient").StaffActorRow): void {
    const c = this.liveStaffCharacters.get(row.memberId);
    if (!c) {
      // Row arrived before its insert was processed (rare; can happen
      // if the subscription fires events out of order during a fast
      // restart). Treat as insert.
      void this.spawnLiveStaffActor(row, this.activePlot?.id ?? 0n);
      return;
    }
    c.groundPos.set(row.x, row.z);
    // Per-state animation: server publishes "idle" / "working" while
    // anchored at a station, anything else while in transit. Match
    // the action so the animator picks the right pose loop.
    const newAction: CharacterAction = row.state === "idle" || row.state === "working"
      ? "idle" : "walk";
    if (c.action !== newAction) c.action = newAction;
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
    this.liveTicketStates.clear();
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
        // H.A — Plate-on-table reconcile alongside the character spawn.
        this.seatPlates.onGuest(row);
        void this.spawnLiveCustomerActor(row, targetPlotId);
      },
      onUpdate: (row) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.seatPlates.onGuest(row);
        this.applyLiveCustomerUpdate(row);
      },
      onDelete: (id) => {
        if (this.activePlot?.id !== targetPlotId) return;
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
    c.groundPos.set(row.x, row.z);
    const newAction = customerActionFor(row.state);
    if (c.action !== newAction) c.action = newAction;
  }

  private removeLiveCustomerActor(key: string): void {
    const c = this.liveCustomerCharacters.get(key);
    if (!c) return;
    this.scene.animator.remove(c.root);
    c.root.removeFromParent();
    this.liveCustomerCharacters.delete(key);
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
        this.heldItems.onTicket(row.id, row.state, row.appliance);
        this.cookingPots.onTicket(row.id, row.state, row.appliance, row.assignedChefId);
        this.refreshLivenessLabel();
      },
      onDelete: (id) => {
        if (this.activePlot?.id !== targetPlotId) return;
        this.liveTicketStates.delete(String(id));
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

  /** Walk the cityBuildings group to find the shell whose visitPlot
   * userData matches the given plot, and hide it so the loaded
   * interior renders unobstructed. */
  private hideVisitedShell(plot: VisitablePlot): void {
    if (!this.scene.cityBuildings) return;
    for (const child of this.scene.cityBuildings.children) {
      const p = child.userData?.visitPlot as VisitablePlot | undefined;
      if (p && p.id === plot.id) {
        child.visible = false;
        this.hiddenShell = child;
        return;
      }
    }
  }

  private restoreVisitedShell(): void {
    if (this.hiddenShell) {
      this.hiddenShell.visible = true;
      this.hiddenShell = null;
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
    if (!this.visitorRoot) return;
    this.scene.worldRoot.remove(this.visitorRoot);
    // Geometries + materials come from the shared ModelLoader cache —
    // do NOT dispose them here or the player's own restaurant loses
    // every furniture mesh on the next visit.
    this.visitorRoot = null;
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
    this.buildInteriorShell(root, expansionLevel, wallSourcePlacements, themesByFloor, restaurantName);

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
  ): void {
    const W = 10;
    // Per-storey materials cloned from the picked theme. Themes carry
    // wallColor + floorColor as numeric hex (data/themes.ts); host's
    // setStoreyTheme writes them onto cloned-per-floor materials so
    // each floor can have its own DecorModal choice. Visit mode does
    // the same, falling back to the catalog default (RESTAURANT_THEMES[0]
    // = "plain-white") when no override was set for that floor.
    const defaultTheme = RESTAURANT_THEMES[0];
    const materialForFloor = (floorIdx: number): { wallMat: THREE.Material; floorMat: THREE.Material } => {
      const theme = themesByFloor.get(floorIdx) ?? defaultTheme;
      return {
        wallMat: new THREE.MeshStandardMaterial({
          color: theme.wallColor, roughness: 0.85, side: THREE.DoubleSide,
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
     * no slab (the ground floor uses a PlaneGeometry directly). */
    const buildStorey = (floorIdx: number): void => {
      const baseY = floorIdx * STOREY_HEIGHT;
      const { wallMat, floorMat } = materialForFloor(floorIdx);
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
      // open middle band for windows).
      const floorOpenings = openingsByFloor.get(floorIdx) ?? emptyFloorOpenings();
      for (const dir of ["front", "back", "left", "right"] as const) {
        buildPerimeterWallSegments(root, dir,
          floorOpenings[dir].doors,
          floorOpenings[dir].windows, {
            yOffset: baseY,
            resolveMaterial: () => wallMat,
            castShadow: false,
            receiveShadow: true,
          },
        );
      }
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
    // iron balconies on upper floors + slate-grey mansard + chimney
    // at the top of the topmost unlocked storey. Same cornice /
    // balcony / mansard recipe the host uses on its own scene —
    // matches the city's other Paris-style facades so the visited
    // restaurant reads as part of the same neighbourhood.
    buildParisExteriorDecor(root, maxStoreys);

    // Front-door rating sign with the visited restaurant's name +
    // 5 placeholder stars. Style mirrors the host's catalog-default
    // (serif font on dark plaque with cream text); a richer parity
    // pass would mirror the host's chosen plaqueStyle / textColor /
    // font, but those aren't on the cloud schema yet.
    buildRatingSign(root, restaurantName);

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
