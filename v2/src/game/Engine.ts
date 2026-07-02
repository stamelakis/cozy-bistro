import * as THREE from "three";
import { IsoCamera } from "../scene/IsoCamera";
import { WorldScene } from "../scene/WorldScene";
import { Game } from "./Game";
import { isServerSim } from "./featureFlags";
import { GuestSpawner } from "./GuestSpawner";
import { DishwareLeakWatcher } from "../systems/DishwareLeakWatcher";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { disposeObject3D } from "../assets/disposeObject3D";
import { PedestrianSpawner } from "./PedestrianSpawner";
import { SharedPedestrians } from "./SharedPedestrians";
import { TrashSpawner } from "./TrashSpawner";
import { Hud } from "../ui/Hud";
import { Sidebar } from "../ui/Sidebar";
import { BuildMenu } from "../ui/BuildMenu";
import { StaffPanel } from "../ui/StaffPanel";
import { PantryModal } from "../ui/PantryModal";
import { MenuPanel } from "../ui/MenuPanel";
import { UpgradeModal } from "../ui/UpgradeModal";
import { ExpandModal } from "../ui/ExpandModal";
import { ExpandWidget } from "../ui/ExpandWidget";
import { FloorSelector } from "../ui/FloorSelector";
import { CameraControls } from "../ui/CameraControls";
import { setMobileInGame } from "../ui/MobileUI";
import { VisitMode } from "../ui/VisitMode";
import { StockStatusWidget } from "../ui/StockStatusWidget";
import { DecorModal } from "../ui/DecorModal";
import { DayEndModal } from "../ui/DayEndModal";
import { LedgerModal } from "../ui/LedgerModal";
import { HelpModal } from "../ui/HelpModal";
import { StatsModal } from "../ui/StatsModal";
import { AchievementsModal } from "../ui/AchievementsModal";
import { SlotsModal } from "../ui/SlotsModal";
import { AdminModal } from "../ui/AdminModal";
import { RestaurantSignModal } from "../ui/RestaurantSignModal";
import { CloudModal } from "../ui/CloudModal";
import { FloatingText } from "../ui/FloatingText";
import { StatusBubbles, type StatusEntry } from "../ui/StatusBubbles";
import { SfxPlayer } from "../ui/SfxPlayer";
import { StaffRouter } from "./StaffRouter";
import { ErrandRouter } from "./ErrandRouter";
import { FurnitureRegistry } from "./FurnitureRegistry";
import { Pathfinding } from "./Pathfinding";
import { SeatMarkers } from "../scene/SeatMarkers";
import { DirtyPileVisualizer } from "../scene/DirtyPileVisualizer";
import { PersonalSpace, type MovableActor } from "./PersonalSpace";
import { SaveSystem } from "./SaveSystem";
import { featureFlags } from "./featureFlags";
import { SpacetimeClient } from "../cloud/SpacetimeClient";
import { LoginModal } from "../ui/LoginModal";
import { BuildingPickModal } from "../ui/BuildingPickModal";
import { ChatPanel } from "../ui/ChatPanel";
import { PlayerRosterPanel } from "../ui/PlayerRosterPanel";
import { makeDraggableResizable } from "../ui/PanelDragResize";
import {
  type GraphicsQuality,
  GRAPHICS_PRESETS,
  getSavedGraphicsQuality,
  setSavedGraphicsQuality,
  FPS_CAP_OPTIONS,
  loadSavedFpsCap,
  setSavedFpsCap,
  loadSavedShowFps,
  setSavedShowFps,
} from "./GraphicsQuality";

/** Top-level engine. Owns the renderer, scene, camera, and the main loop. */
export class Engine {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly clock = new THREE.Clock();

  readonly scene: WorldScene;
  readonly camera: IsoCamera;
  readonly game: Game;
  spawner?: GuestSpawner;
  router?: StaffRouter;
  /** Dev-mode dishware leak detector. Wired after spawner exists; runs
   * a check every second and prints recent mutation history if the
   * inventory total drifts below the lifetime-added baseline. */
  private dishwareLeakWatcher?: DishwareLeakWatcher;
  /** Task A — Cloud-driven dirty-pile renderer for the HOST's OWN
   * restaurant. Under Path B the server despawns guests directly
   * (guest-bridge onDelete → despawnGuest), bypassing the local
   * finalizeVisit → spawnLeftoversForGuest that used to leave a dirty-
   * plate mesh on the table — so tables never showed leftovers. The
   * server still writes dirty_pile rows, so we subscribe to our OWN
   * restaurant's rows and render them with the SAME visualizer VisitMode
   * uses for other players' restaurants. Per-floor storey mounts give
   * the piles the same per-storey visibility as the served-food plates. */
  private hostDirtyPiles?: DirtyPileVisualizer;
  /** Once-latch so the interval retry loop only subscribes the host
   * dirty-pile feed a single time after the restaurant context lands. */
  private hostDirtyPileSubscribed = false;
  errand?: ErrandRouter;
  pedestrians?: PedestrianSpawner;
  sharedPedestrians?: SharedPedestrians;
  trash?: TrashSpawner;
  readonly registry: FurnitureRegistry;
  /** Shared A* pathfinder. Reads obstacle positions live from the
   * registry so every staff/customer move routes around placed
   * furniture instead of clipping through it. */
  readonly pathfind: Pathfinding;
  readonly seatMarkers: SeatMarkers;
  readonly sidebar: Sidebar;
  readonly hud: Hud;
  readonly staffPanel: StaffPanel;
  readonly pantryModal: PantryModal;
  readonly menuPanel: MenuPanel;
  readonly upgradeModal: UpgradeModal;
  readonly expandModal: ExpandModal;
  readonly expandWidget: ExpandWidget;
  readonly floorSelector: FloorSelector;
  readonly cameraControls: CameraControls;
  readonly visitMode: VisitMode;
  /** Build/move/sell controller — promoted to a field so the
   * onLuxuryTierChanged callback can refresh its tier tabs the
   * instant the player buys an expansion. */
  buildMenu!: BuildMenu;
  readonly stockWidget: StockStatusWidget;
  readonly decorModal: DecorModal;
  readonly dayEndModal: DayEndModal;
  readonly ledgerModal: LedgerModal;
  readonly helpModal: HelpModal;
  readonly statsModal: StatsModal;
  readonly achievementsModal: AchievementsModal;
  readonly slotsModal: SlotsModal;
  readonly adminModal: AdminModal;
  readonly signModal: RestaurantSignModal;
  readonly cloudModal: CloudModal;
  readonly floatingText: FloatingText;
  readonly statusBubbles: StatusBubbles;
  readonly sfx: SfxPlayer;
  readonly saver: SaveSystem;
  readonly cloud: SpacetimeClient;
  /** H.30 — accumulated dt since last sync_day_clock fire. The cloud
   * yoke fires every DAY_SYNC_INTERVAL seconds so the server's
   * day_elapsed_ms doesn't drift away from local in foreground play. */
  private daySyncAccum = 0;

  /** Promise that resolves when the save's furniture has been restored
   * into the registry.  restoreFromCloud awaits this so the cloud's
   * fresh state can't be overwritten by a slow save restore.  See the
   * race-condition comment at the assignment site. */
  private furnitureRestorePromise: Promise<void> | null = null;
  /** P8 chat panel — bottom-left, always visible after auth. Mounted
   * lazily by installAuthGate so it can subscribe to the chat_message
   * table that the cloud only has after the initial subscription. */
  private chatPanel: ChatPanel | null = null;
  /** Player roster panel sitting just below CameraControls — small
   * presence list with a green / grey dot per account. Same mount
   * gating as chatPanel (needs cloud subscription). */
  private rosterPanel: PlayerRosterPanel | null = null;

  private running = false;
  private lastResizeCheckAt = 0;
  private hudAccumulator = 0;
  /** Phase 9.39 — latched true once the server's day_elapsed_ms has been
   * adopted into the local DayCycleSystem on first cloud contact, so the
   * day/night lighting resumes at the correct time of day after a reload
   * instead of resetting to dawn. */
  private dayClockAdopted = false;
  /** Phase 9.2 — true once syncStaffToHeadcount has registered every
   * saved staff member into the router. The bridge-retry block in
   * update() holds off on the staff/ticket hydrates until then —
   * hydrating before actors exist would latch with every row
   * reported "missing" and skip the position restore. */
  private staffSyncDone = false;
  /** Phase 9.5 — true once the furniture registry has finished its
   * cloud restore (or the flag-off / failure paths resolved). The
   * GUEST hydrate + bridge attach wait on this: importing seated
   * guests against a registry with no resolved seats yet made
   * refreshSeatedGuestPoses treat every guest's table as sold and
   * walk the entire dining room out the door ("everyone wanders,
   * nobody sits"). */
  private furnitureCloudReady = false;
  /** Phase 9.5 — one-shot latch for the retry-loop actor resync.
   * Set after the first resyncAllActorsToCloud pass that runs with
   * live cloud context + a synced roster. */
  private actorsResynced = false;
  /** Phase 9.7 — one-shot latch for the retry-loop seat-slot push. */
  private seatSlotsPushed = false;
  /** Phase 9.19 — change-tracker for the pantry stock-target push;
   * -1 forces one push on boot. */
  private lastPushedStockTarget = -1;
  /** Phase 9.9 — one-shot latch for adopting the cloud's in-flight
   * recipe-upgrade deadlines (drops ghost timers the server already
   * completed; corrects stale remaining-time on live ones). */
  private recipeUpgradesRestored = false;
  /** Path B — one-shot latch for adopting the cloud's
   * prepared_serving rows (cook-ahead dishes on the pass survive a
   * reload). Same shape as recipeUpgradesRestored. */
  private preparedServingsRestored = false;
  /** Path B — one-shot latch for adopting the server-written
   * cloud_day_history_json ring buffer at boot. Live updates flow
   * through the restaurant.onUpdate adoption in SpacetimeClient;
   * this covers the boot snapshot via the same 1 Hz retry loop that
   * fixed the other hydrate races. */
  private dayHistoryRestored = false;

  // ===== Phase I — FPS cap + on-screen FPS counter =====
  // Lets the player pin the frame rate so the GPU / fan don't spin
  // hard when they don't need 144 Hz, and surfaces the live frame
  // rate as a small badge for diagnostics.  Both settings persist
  // to localStorage so they survive reload.
  /** Cap in frames-per-second, or null for "no cap" (let
   * requestAnimationFrame run at the display's native refresh).
   * tick() gates on this; reading null skips the gate entirely. */
  private fpsCap: number | null = null;
  /** Timestamp of the LAST frame that actually ran sim+render.
   * Used together with fpsCap to skip excess rAF callbacks. */
  private lastRenderedFrameAt = 0;
  /** Rolling samples of (1000 / interFrameMs) for the FPS counter.
   * Capped at FPS_SAMPLE_WINDOW so the average tracks the last
   * ~1 second of frames. */
  private fpsSamples: number[] = [];
  /** Smoothed FPS pushed into the HUD widget every 0.5 s.  Read-
   * only from outside — getter exposes it. */
  private fpsAvg = 0;
  /** Accumulator that drives the 0.5 s FPS-widget refresh tick. */
  private fpsAvgAccum = 0;
  /** Display the live-FPS badge (top-right HUD).  Persists via
   * localStorage; default off so users who don't care see no chrome. */
  private showFps = false;
  /** The DOM badge that displays current FPS when showFps is on.
   * Built lazily on first use. */
  private fpsBadge: HTMLDivElement | null = null;
  /** Phase 9.42 — in-game health badge + its hover detail panel. Built
   * lazily; updated ~1 Hz from the server's health_summary_csv. */
  private healthBadge: HTMLDivElement | null = null;
  private healthTooltip: HTMLDivElement | null = null;
  private healthAccum = 0;
  /** Current player-facing graphics quality preset. Captured at
   * construct from localStorage, mutated by applyGraphicsQuality. */
  private currentQuality: GraphicsQuality = "medium";
  /** Whether the sun is currently casting shadows. Tracked so the
   * per-frame zoom-based toggle in tick() doesn't repeatedly re-set
   * the same flag (which would otherwise force three.js to clear
   * the shadow render target every frame). */
  private sunShadowOn = false;
  /** Anti-perf — armed once per zoom-out pass so the anticipatory exterior
   * shader pre-warm (see tick) fires a single time as the player nears the
   * 0.40 threshold, not every frame. Reset when they zoom back in past 0.60. */
  private exteriorPrewarmArmed = false;
  /** Anti-freeze — true while the WebGL context is lost (GPU device reset).
   * The tick skips its body while set so we don't render into a dead
   * context; cleared on webglcontextrestored. */
  private contextLost = false;
  private gpuResetBanner: HTMLElement | null = null;
  /** Multiplier applied to dt before sim updates. 1 = real-time, 2 = 2x, etc.
   * Rendering is unaffected (so paused still re-renders camera moves). */
  private timeScale = 1;
  private paused = false;

  setTimeScale(scale: number): void {
    this.timeScale = Math.max(0, scale);
  }
  getTimeScale(): number {
    return this.timeScale;
  }
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Return the currently-active quality preset so the sidebar
   * dropdown can render its initial selected state correctly. */
  getGraphicsQuality(): GraphicsQuality {
    return this.currentQuality;
  }

  /** Apply a new graphics-quality preset live (no reload required).
   * Pixel ratio + sun-shadow toggle take effect immediately;
   * furniture-shadow flag is walked across every placed model so a
   * mid-session change reaches existing furniture too. The change
   * is persisted to localStorage so it survives the next session.
   *
   * Cheap: the furniture walk is typically <500 meshes, and the
   * pixel-ratio update just re-sizes the renderer's framebuffer
   * (no shader recompilation). The next render frame picks up the
   * new state automatically. */
  applyGraphicsQuality(q: GraphicsQuality): void {
    if (q === this.currentQuality) return;
    this.currentQuality = q;
    setSavedGraphicsQuality(q);
    const preset = GRAPHICS_PRESETS[q];
    // Pixel ratio — biggest knob, applied to the renderer + frame
    // buffer immediately. setSize() also re-derives the framebuffer
    // dimensions so the new pixel ratio actually takes effect.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    // Re-evaluate sun shadow on next tick — the zoom-based gate in
    // tick() reads the preset flag, so we just need to drop the
    // tracked-state guard so it re-applies even at the same zoom.
    this.sunShadowOn = !preset.sunShadows; // force a delta next tick
    // Furniture castShadow flip — walk every placed model and toggle
    // its meshes. The building structure (walls / floors / mansard /
    // scenery / lamps / trees) is NOT touched here; those have their
    // own castShadow policies set at construction.
    if (this.registry) {
      this.registry.forEachPlacedModel((model) => {
        this.scene.setShadowCastingOnSubtree(model, preset.furnitureShadows);
      });
    }
  }
  isPaused(): boolean {
    return this.paused;
  }

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      // Needed for canvas.toDataURL/snapshot to capture the latest frame.
      // Small perf hit on integrated GPUs but invaluable for tooling.
      preserveDrawingBuffer: true,
    });
    // Pixel ratio cap from the player's saved graphics quality. On a
    // 1× display this is a no-op regardless of the preset; on a
    // retina / 4K display each step (1.0 → 1.5 → 2.0) roughly
    // doubles fragment cost per frame, which is the single biggest
    // perf knob in the engine. The dropdown in the sidebar flips
    // this at runtime via applyGraphicsQuality().
    this.currentQuality = getSavedGraphicsQuality();
    // Phase I — restore FPS settings from localStorage before tick()
    // starts firing.  Without this the first second of play would run
    // uncapped + counter-less even if the player had previously
    // pinned a cap.
    this.fpsCap = loadSavedFpsCap();
    this.showFps = loadSavedShowFps();
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, GRAPHICS_PRESETS[this.currentQuality].pixelRatio),
    );
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0xd8c4a3);
    container.appendChild(this.renderer.domElement);

    // Anti-freeze — WebGL context-loss recovery. On an overloaded / low-end
    // GPU (e.g. a GTX 1050 Ti asked to render every floor's furniture +
    // shadows + lights at once on a high-floor reveal) the driver watchdog
    // can reset the device, losing the WebGL context. WITHOUT a handler the
    // render loop keeps firing into a dead context and the canvas freezes
    // FOREVER while the page stays alive ("frozen until I close it").
    // preventDefault lets the browser attempt a restore; we pause rendering
    // and show a banner so the player isn't stranded on a frozen frame.
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.error(
        "[Engine] WebGL CONTEXT LOST — GPU device reset (driver watchdog / TDR). "
        + "Render paused; the page is still alive. THIS is the 'frozen forever' cause.",
      );
      this.contextLost = true;
      this.showGpuResetBanner();
    }, false);
    this.renderer.domElement.addEventListener("webglcontextrestored", () => {
      console.warn("[Engine] WebGL context restored — resuming render.");
      this.contextLost = false;
      this.hideGpuResetBanner();
    }, false);

    this.scene = new WorldScene();
    this.camera = new IsoCamera(container.clientWidth, container.clientHeight);
    this.camera.attachInputTo(this.renderer.domElement);
    // Phase I (perf) — wire the camera + worldRoot into the
    // CharacterAnimator so its update() can frustum-cull off-screen
    // characters and skip their per-frame pose recompute.  ~30-50 %
    // of spawned characters are off-camera at iso angle (other plots,
    // far side of the city), so this typically drops tickCharacter
    // work in half.  Safe to call this early: setCullCamera just
    // stores refs; the actual frustum is rebuilt every update().
    this.scene.animator.setCullCamera(this.camera.threeCamera, this.scene.worldRoot);
    // Phase 9.29 — floor-focus body gate. Same hooks the status bubbles
    // use, so a character's BODY hides on non-focused storeys exactly as
    // its bubble does (and as the storey geometry already does). Without
    // this, characters — parented to the always-visible world root —
    // float across hidden upper floors while their bubbles/walls are
    // correctly gated, which reads as "seeing it all at once".
    this.scene.animator.getFocusedFloor = () => this.scene.getFocusedStorey();
    this.scene.animator.getStoreyHeight = () => WorldScene.getStoreyHeight();
    this.scene.animator.isExteriorView = () => this.scene.isExteriorMode();

    const savedState = SaveSystem.loadFromStorage();
    // Track whether we booted on a truly fresh device (no localStorage
    // save in this slot). The SpacetimeDB layer uses this signal to
    // decide whether to auto-pull the cloud save — without it, a
    // returning player who logs in on a second machine would silently
    // start over with an empty restaurant while their real save sat
    // untouched in the DB.
    const wasFreshStart = !savedState;
    this.game = new Game(savedState);
    this.saver = new SaveSystem(this.game);
    // Cloud sync to SpacetimeDB Maincloud (cozy-bistro-andre). Runs in
    // parallel with the local save; if the network is down the game
    // continues working from localStorage.
    this.cloud = new SpacetimeClient(this.game, this.saver);
    // Admin console hook — lets Dunnin flip the money cutover from their
    // authenticated session (the CLI publish identity isn't the in-game
    // admin). Server-side admin-gated, so harmless to expose: a non-admin
    // call is rejected. From the browser console: cozyMoneyCutover(true).
    (window as unknown as Record<string, unknown>).cozyMoneyCutover =
      (active: boolean) => this.cloud?.setMoneyCutoverActive(active);
    // Debug — spawn ONE rigged guest through the REAL skinned-guest path
    // (SkinnedCharacterLoader + SkeletalController + the CharacterAnimator
    // fork) to eyeball "the new face" without waiting for the ~1-in-6 hash
    // to land on a live server guest. cozySkinnedGuestHandle.setSit(bool) /
    // .dispose(). NOT part of normal play.
    (window as unknown as Record<string, unknown>).cozySkinnedGuest = async (): Promise<unknown> => {
      if (!this.spawner) { console.warn("[cozySkinnedGuest] spawner not ready — start/load a restaurant first"); return null; }
      const handle = await this.spawner.debugSpawnSkinned(0, 2);
      (window as unknown as Record<string, unknown>).cozySkinnedGuestHandle = handle;
      console.info("[cozySkinnedGuest] spawned a rigged guest at local (0,2). cozySkinnedGuestHandle.setSit(true|false) / .dispose()");
      return handle;
    };
    // Debug — spawn ONE of the new rigged GLB models by id to eyeball scale,
    // facing, and animation: cozyRiggedChar("businessman" | "chef" | "teengirl"
    // | "waiter" | "oldman" | ...). cozyRiggedCharHandle.setSit(bool)/.dispose().
    (window as unknown as Record<string, unknown>).cozyRiggedChar = async (modelId = "businessman"): Promise<unknown> => {
      if (!this.spawner) { console.warn("[cozyRiggedChar] spawner not ready — start/load a restaurant first"); return null; }
      const handle = await this.spawner.debugSpawnRigged(modelId, 0, 2);
      (window as unknown as Record<string, unknown>).cozyRiggedCharHandle = handle;
      console.info(`[cozyRiggedChar] spawned '${modelId}' at local (0,2). cozyRiggedCharHandle.setSit(true|false) / .dispose()`);
      return handle;
    };
    this.cloud.setWasFreshStart(wasFreshStart);
    this.cloud.connect();
    window.addEventListener("beforeunload", () => this.cloud.cloudSaveNow());

    // P1 — multiplayer auth gate. The game keeps initialising (so
    // the world renders behind the modal), but `Game.update` is
    // suspended via setAuthGated(true) until the player logs in.
    // Returning players whose existing identity already has an
    // auth_record auto-dismiss the modal within ~1s (we poll after
    // the subscription cache lands). New / different-browser
    // players see the sign-up / login form.
    this.game.setAuthGated(true);
    this.installAuthGate(container);
    // Phase 9.2 — Bridge/hydrate retry loop. The original wiring
    // fired attachGuestServerBridge / hydrateFromCloud exactly once
    // from the staffReady GLB callback, which races the auth +
    // subscription flow; when GLBs finished first (common for a
    // returning player with a warm cache) conn/restaurantId weren't
    // resolved yet, the subscribe calls registered nothing, and the
    // once-flags latched a permanently dead bridge — server-spawned
    // guests never materialised and a reload showed an empty
    // restaurant.
    //
    // setInterval, NOT the rAF tick: browsers fully suspend
    // requestAnimationFrame in hidden tabs, so a tick-based retry
    // can never recover a tab that finished login while hidden.
    // Interval timers keep firing (clamped to 1 Hz in background),
    // which is exactly the cadence we want. Every call below is
    // internally guarded (once-flag + hasRestaurantContext), so the
    // steady-state cost is a few boolean checks per second.
    window.setInterval(() => {
      if (!this.cloud.hasRestaurantContext()) return;
      // Phase 9.39 — adopt the server's within-day clock ONCE on first
      // contact (i.e. on reload) so the day/night lighting resumes at the
      // correct TIME OF DAY instead of snapping back to dawn (lights off).
      // The server advances day_elapsed_ms every tick incl. offline, so
      // it's the live time of day. After this the local DayCycleSystem
      // ticks + re-syncs normally via syncDayClock.
      if (!this.dayClockAdopted) {
        const cloudMs = this.cloud.getCloudDayElapsedMs();
        if (cloudMs != null) {
          this.dayClockAdopted = true;
          this.game.day.setElapsedSeconds(cloudMs / 1000);
          console.log(`[Phase 9.39] adopted cloud day clock: ${(cloudMs / 1000).toFixed(0)}s elapsed → dayProgress ${this.game.day.getDayProgress().toFixed(2)}`);
        }
      }
      // Phase 9.19 — keep the server's pantry_target in step with
      // the player's stock-target control. Change-tracked so the
      // reducer fires once per adjustment (plus once at boot), not
      // every second.
      const stockTarget = this.game.getStockTarget();
      if (stockTarget !== this.lastPushedStockTarget) {
        this.lastPushedStockTarget = stockTarget;
        this.cloud.setPantryTarget(stockTarget);
      }
      // Phase 9.5 — guests wait for the furniture registry's cloud
      // restore. Seated guests imported before seats exist get
      // "table sold" walk-outs from refreshSeatedGuestPoses.
      if (this.furnitureCloudReady) {
        this.spawner?.attachGuestServerBridge();
        void this.spawner?.hydrateFromCloud();
        // Task A — subscribe the host's OWN restaurant dirty_pile rows
        // and feed the cloud-driven visualizer. Default restaurantId
        // (omitted) scopes the subscription to this player's restaurant.
        // Once-latched; the server is the sole writer under Path B (its
        // despawn path writes the rows + the host's local finalize path
        // is bypassed), so there's no double-render with the dormant
        // local dirtyTableMeshes. Gated on featureFlags.guests so the
        // pure-local sim (flag off) keeps using its own leftover meshes.
        if (!this.hostDirtyPileSubscribed && this.hostDirtyPiles && featureFlags.guests) {
          this.hostDirtyPileSubscribed = true;
          const piles = this.hostDirtyPiles;
          this.cloud.subscribeDirtyPileChanges({
            onInsert: (row) => piles.onPile(row),
            onUpdate: (row) => piles.onPile(row),
            onDelete: (id) => piles.onPileDelete(id),
          });
          // Initial-snapshot replay: a late-registered onInsert handler
          // doesn't get re-fired for rows already in the subscription
          // cache, so seed the visualizer with whatever piles exist
          // right now (same snapshot-then-deltas pattern the guest
          // bridge uses via hydrateFromCloud + subscribeActiveGuestChanges).
          for (const row of this.cloud.listDirtyPiles()) {
            piles.onPile(row);
          }
          console.log("[Task A] host dirty-pile visualizer subscribed to own restaurant");
        }
        // Phase 9.7 — one-shot seat-slot push so the server's
        // assignment list reflects THIS session's furniture even
        // when the player never edits anything before logging off.
        if (!this.seatSlotsPushed) {
          this.seatSlotsPushed = true;
          this.registry.mirrorSeatSlotsNow();
        }
        // Phase 9.9 — adopt cloud recipe-upgrade deadlines (drop
        // ghost timers the server already completed; correct stale
        // remaining-time on live ones). Same once-latched shape as
        // restoreBoostStateFromCloud.
        if (!this.recipeUpgradesRestored) {
          this.recipeUpgradesRestored = true;
          this.game.cooking.restoreRecipeUpgradesFromCloud(
            this.cloud.listRecipeUpgradesInFlight(),
          );
        }
        // Path B — adopt the cloud's prepared-serving rows (cook-
        // ahead dishes on the pass). Cloud wins wholesale; same
        // once-latched shape as the recipe upgrades above.
        if (!this.preparedServingsRestored) {
          this.preparedServingsRestored = true;
          this.game.cooking.restorePreparedServingsFromCloud(
            this.cloud.listPreparedServings(),
          );
        }
        // Path B — one-shot boot adoption of the server-written day
        // history. The server's tick_day_clock is the sole writer of
        // cloud_day_history_json now; the restaurant.onUpdate
        // adoption in SpacetimeClient covers live changes but only
        // fires on row CHANGES — this picks up the snapshot that was
        // already in the subscription cache at boot (offline days
        // stop reading as zeros in Daily Trends). Skips when the
        // cloud has no history yet so a legacy local save isn't
        // wiped.
        if (!this.dayHistoryRestored) {
          this.dayHistoryRestored = true;
          try {
            const cloudDays = this.cloud.getCloudDayHistory();
            if (cloudDays && cloudDays.length > 0) {
              this.game.history.applyCloudSnapshot(cloudDays);
              console.log(`[PathB] day-history boot adoption: ${cloudDays.length} days from cloud`);
            }
          } catch (e) {
            console.warn("[Engine] day-history boot adoption failed:", e);
          }
        }
      }
      this.router?.attachServerBridge();
      this.errand?.attachServerBridge();
      // Staff/errand/ticket hydrates wait for actor registration —
      // hydrating before syncStaffToHeadcount lands would report
      // every row "missing" and skip the position restore.
      if (this.staffSyncDone) {
        // Phase 9.5 — actor REGISTRATION had the same boot race as
        // the bridges: the staffReady chain's resyncAllActorsToCloud
        // no-ops without a restaurantId and was never retried, so a
        // boot where GLBs beat auth left ZERO staff_actor rows on
        // the server — which freezes that restaurant's entire
        // offline sim (spawn gate requires staff) AND leaves no
        // cooks/waiters for the tick to drive. One successful pass
        // latches; register_staff_actor is idempotent server-side.
        if (!this.actorsResynced) {
          this.actorsResynced = true;
          this.router?.resyncAllActorsToCloud();
          this.errand?.resyncAllActorsToCloud();
          // Phase 9.12 — purge GHOST staff_actor rows. Member ids
          // rotate across sessions (fresh-storage boots mint new
          // ones) and nothing ever unregistered the old rows, so
          // the server accumulated phantom actors it kept
          // dispatching — work happened invisibly (errand trips
          // delivering with no rendered helper; the staff panel
          // reading "3 idle" while ghost ids shopped). Any cloud
          // row whose member_id isn't in the CURRENT roster gets
          // unregistered (owner-gated reducer; releases held
          // tickets internally).
          const known = new Set<string>();
          for (const role of ["chef", "waiter", "barman", "errand"] as const) {
            for (const m of this.game.staff.getMembers(role)) known.add(m.id);
          }
          for (const row of this.cloud.listStaffActors()) {
            if (!known.has(row.memberId)) {
              console.log(`[9.12] purging ghost staff_actor ${row.memberId} (${row.role}) — not in current roster`);
              this.cloud.unregisterStaffActor(row.memberId);
            }
          }
        }
        this.router?.hydrateFromCloud();
        this.errand?.hydrateFromCloud();
        this.router?.hydrateTicketsFromCloud(
          (serverId) => this.spawner?.findLocalGuestIdByServerId(serverId),
        );
      }
    }, 1000);
    // SfxPlayer is constructed early — before the HUD — because the
    // HUD's volume slider reads its initial value from
    // `actions.getSfxVolume()` SYNCHRONOUSLY during construction.
    // (Other audio lambdas are lazy / button-driven and don't care
    // about init order, but the slider does.) Browser autoplay rules
    // still block actual playback until the first user gesture; the
    // kickAudio listeners below resume the AudioContext + start music.
    this.sfx = new SfxPlayer();
    const kickAudio = (): void => {
      // Wake the Web Audio context too — without this, the FIRST few
      // sounds (kitchen sizzle, ding, etc.) play into a suspended
      // context and the player gets random silence on early actions.
      this.sfx.resumeContext();
      if (!this.sfx.isMusicMuted()) this.sfx.startMusic();
    };
    window.addEventListener("pointerdown", kickAudio, { once: true });
    window.addEventListener("keydown",     kickAudio, { once: true });
    // Single shared left panel that holds the HUD + tier/boost widget +
    // stock status + staff panel as stacked sections.
    this.sidebar = new Sidebar(container);
    // UI request — Expand / Boost / Grant pinned at the very top of
    // the sidebar (above cash/weather) so the three economy actions
    // are the first thing the eye lands on. Constructed first so
    // its DOM nodes appear above the HUD's stacked sections.
    this.expandWidget = new ExpandWidget(this.sidebar.body, this.game);
    this.sidebar.addSeparator();
    this.hud = new Hud(this.sidebar.body, this.game, {
      getCount: () => this.spawner?.getActiveGuestCount() ?? 0,
      isOpen: () => this.game.restaurantOpen,
      setOpen: (open: boolean) => {
        if (this.game.restaurantOpen === open) return;
        this.game.restaurantOpen = open;
        if (!this.spawner) return;
        this.spawner.restaurantOpen = open;
        // Phase 6.3 — push the new open/closed flag to the cloud
        // immediately. Otherwise player_save.restaurant_open stays at
        // the previous value until the next autosave (day rollover /
        // beforeunload), so:
        //   - server's offline spawn gate (try_server_spawn_guest's
        //     `if !restaurant_open` check) keeps spawning into a
        //     closed restaurant — or stops spawning into a freshly
        //     opened one — for potentially several minutes
        //   - visitors reading the cloud see a stale "open" badge
        // cloudSaveNow re-publishes the whole player_save row + the
        // save blob, which carries free_seats too, keeping the
        // attraction layer's two gates in lockstep with the toggle.
        this.cloud.cloudSaveNow();
      },
    }, {
      isPaused: () => this.isPaused(),
      setPaused: (p) => this.setPaused(p),
      getTimeScale: () => this.getTimeScale(),
      setTimeScale: (s) => this.setTimeScale(s),
    }, {
      openLedger: () => this.ledgerModal.show(),
      openHelp: () => this.helpModal.show(),
      openStats: () => this.statsModal.show(),
      openAchievements: () => this.achievementsModal.show(),
      // P1.7 — multi-slot picker is a DEV-only convenience now.
      // Production runs as single-slot multiplayer; the menu button
      // is hidden in non-dev builds so players can't stumble into
      // it. Vite injects import.meta.env.DEV based on the build mode.
      openSlots: () => {
        if (!import.meta.env.DEV) return;
        this.slotsModal.show();
      },
      isAdmin: () => this.cloud.getCurrentAccount()?.isAdmin ?? false,
      // P5 — live online player count read off the heartbeat-driven
      // last_seen_at window. HUD renders "👥 N online" in the title
      // block so multiplayer presence is always visible.
      getOnlineCount: () => this.cloud.countOnlinePlayers(),
      // P5.9 — count of pedestrians currently targeting the player's
      // own plot. Surfaces the rating→attraction loop in real time.
      // Returns 0 when no plot is claimed yet. Reads myPlotId from a
      // cached value (refreshed in refreshCityBuildings) so the HUD
      // tick doesn't re-iterate the building table every 200 ms.
      getIncomingCount: () => {
        if (this.cachedMyPlotId == null) return 0;
        return this.cloud.countPedestriansTargeting(this.cachedMyPlotId);
      },
      // Admin panel — only renders for the player whose auth_record
      // has is_admin = true (the Dunnin bootstrap). Client-side
      // check is a UX gate; the server-side is_admin flag is the
      // real gate on the reducers (admin_reset_password, etc.).
      openAdmin: () => {
        if (!this.cloud.getCurrentAccount()?.isAdmin) {
          console.warn("[Engine] openAdmin blocked — not an admin account");
          return;
        }
        this.adminModal.show();
      },
      openUpgrades: () => this.upgradeModal.show(),
      openDecor: () => this.decorModal.show(),
      openExpand: () => this.expandModal.show(),
      openPantry: () => this.pantryModal.show(),
      openCloud: () => this.cloudModal.show(),
      resetSave: () => this.resetSave(),
      isMuted: () => this.sfx.isMuted(),
      toggleMute: () => { this.sfx.setMuted(!this.sfx.isMuted()); return this.sfx.isMuted(); },
      // Background music — independent toggle from SFX so the player
      // can keep appliance sounds and silence the pad (or vice versa).
      isMusicMuted: () => this.sfx.isMusicMuted(),
      toggleMusic: () => {
        const next = !this.sfx.isMusicMuted();
        this.sfx.setMusicMuted(next);
        if (!next) this.sfx.startMusic();
        return next;
      },
      getSfxVolume: () => this.sfx.getVolume(),
      setSfxVolume: (v) => this.sfx.setVolume(v),
      // Pull live seat-availability off the spawner for the HUD's
      // SEATS card. Optional because the spawner is built after the
      // staff GLBs finish loading — getSpawnerStats may not exist for
      // the first few frames.
      getSeatStats: () => {
        const stats = this.spawner?.getSpawnerStats();
        if (!stats) return undefined;
        return { avail: stats.seatsAvail, total: stats.seatsTotal };
      },
    });
    this.sidebar.addSeparator();
    this.stockWidget = new StockStatusWidget(this.sidebar.body, this.game);
    this.sidebar.addSeparator();
    this.staffPanel = new StaffPanel(this.sidebar.body, this.game);
    // Character-wipe button at the very bottom of every section.
    // Visible to ALL players (not gated to admin) — this is the
    // standard "delete account" affordance. Lives down here so it
    // can't be misclicked from the busy modal-icon row at the top.
    this.installGraphicsSection();
    this.installResetSaveSection();
    // Hook the floor-reassign UI: when the player switches a member's
    // home storey, move their 3D character to the new floor's slab
    // and clear any cached path on the router so they don't try to
    // walk back to the old floor's home spot.
    this.staffPanel.onStaffFloorChanged = (memberId, oldFloor, newFloor) => {
      const fromChefWaiter = this.router?.getCharacterByMemberId(memberId);
      const fromErrand = this.errand?.findCharacterByMemberId(memberId);
      const char = fromChefWaiter ?? fromErrand;
      if (char) {
        this.scene.relocateStaff(char, oldFloor, newFloor);
        this.router?.updateActorHomeFloor(memberId, oldFloor, newFloor, WorldScene.getStoreyHeight());
      }
    };
    // Phase I (H.68) — waiter rest-spot tool.  Set fires a click-to-
    // place mode (next canvas click is captured + raycast against the
    // focused storey's floor plane); Clear fires the cloud reducer
    // and falls the StaffRouter back to the built-in default.
    this.staffPanel.onSetWaiterRestSpot = () => this.enterWaiterRestPlacement();
    this.staffPanel.onClearWaiterRestSpot = () => {
      this.cloud.clearWaiterRestSpot();
      this.staffPanel.setWaiterRestStatus(null);
      this.floatingText?.pop(0, 1, "📍 Waiter rest spot cleared", "#ffd986");
    };
    // Modals still live on the page-level container so they overlay the world.
    // (SfxPlayer + kickAudio listeners constructed earlier — see above.)
    this.pantryModal = new PantryModal(container, this.game);
    this.menuPanel = new MenuPanel(container, this.game);
    makeDraggableResizable({
      // v3 — old saved widths from when the panel's maxWidth was 760
      // overrode the new 500-max via PanelDragResize.applyLayout, which
      // sets explicit width + maxWidth:none. Bumping the key drops the
      // stale wider layout so new sessions get the intended 500-px box.
      // v4 → v5 (2026-06-27): abandon stale layouts that pinned the
      // collapsed title-only height and ran the MENU off-screen on expand
      // (the module wipe only cleared the un-versioned keys, so a bad .v4
      // survived refreshes). Pairs with the saveCurrentLayout guard.
      storageKey: "cozy-bistro.panel.menu.v5",
      root: this.menuPanel.root,
      handle: this.menuPanel.titleEl,
      collapseSentinel: this.menuPanel.body,
      expandDirection: "up", // bottom-anchored — grow up when expanded
      minWidth: 320,
      minHeight: 60,
    });
    this.upgradeModal = new UpgradeModal(container, this.game);
    this.expandModal = new ExpandModal(container, this.game);
    // Floor-focus selector. Lives on the page container as a fixed
    // horizontal strip at the top. Constructed AFTER the scene exists
    // so it can read NUM_STOREYS / STOREY_HEIGHT statics. The
    // onFocusChanged callback is wired AFTER BuildMenu exists below.
    this.floorSelector = new FloorSelector(container, this.scene, this.camera);
    // Camera-control widget (zoom + rotate buttons with live indicators).
    // Pinned top-left so it doesn't clash with the top-center FloorSelector.
    // Polled from the same 5 Hz HUD tick below so the zoom % and compass
    // arrow track wheel-zoom and right-drag-rotate as well as button clicks.
    // The Home button reads the player's plot anchor from the scene so
    // it always snaps back to the current claimed building, even if the
    // player later moves to a different plot.
    this.cameraControls = new CameraControls(container, this.camera,
      () => ({
        // The actual playable restaurant is hardcoded at world origin
        // — the multiplayer plot anchor only affects the PLACEHOLDER
        // shell rendered in the cityBuildings group. Home should land
        // on the real restaurant the player interacts with, so (0,0).
        x: 0,
        // Y = currently-focused floor's height so Home preserves the
        // floor the player picked from the FloorSelector (not whatever
        // garbage target.y might have collected over a session).
        y: this.scene.getFocusedStorey() * WorldScene.getStoreyHeight(),
        z: 0,
      }));
    // P4 visit mode — click on another player's shell to fly the
    // camera to that plot and view it. Engine doesn't need to gate
    // anything yet; the build menu's placement raycast targets the
    // ground plane, not city shells, so the two click handlers don't
    // collide.
    this.visitMode = new VisitMode(container, this.renderer.domElement, this.camera, this.scene);
    // Bridge VisitMode → SpacetimeClient so the overlay can read the
    // visited player's published save (day / money / rating / tier).
    this.visitMode.fetchVisitedStats = (ownerHex: string) => {
      const accounts = this.cloud.listAccounts();
      const acct = accounts.find((a) => a.identity.toHexString() === ownerHex);
      if (!acct) return null;
      const save = this.cloud.getPlayerSave(acct.identity);
      if (!save) return null;
      return {
        dayNumber: save.dayNumber,
        money: save.money,
        ratingAvg: save.ratingAvg,
        luxuryTier: save.luxuryTier,
      };
    };
    // And the full save blob so VisitMode can load the visited
    // restaurant's furniture into the visitorRoot group.
    this.visitMode.fetchVisitedSaveBlob = (ownerHex: string) => {
      const accounts = this.cloud.listAccounts();
      const acct = accounts.find((a) => a.identity.toHexString() === ownerHex);
      if (!acct) return null;
      const save = this.cloud.getPlayerSave(acct.identity);
      return save?.data ?? null;
    };
    // P5.8 — let the host's client know we're visiting so they can
    // toast "👀 X is visiting your restaurant".
    this.visitMode.recordVisit = (hostHex: string) => {
      const accounts = this.cloud.listAccounts();
      const acct = accounts.find((a) => a.identity.toHexString() === hostHex);
      if (!acct) return;
      this.cloud.recordVisit(acct.identity);
      // Lifetime "I visited someone" counter — used by the
      // social-themed achievements.
      this.game.bumpPlayerCounter("visitsOut");
    };
    // Live-state subscription: VisitMode uses this to read the host's
    // staff_actor rows and render every chef/waiter/barman as an
    // animated character that walks around the visited restaurant in
    // real time. Server-side Phase H.1 steps each actor's position
    // every 100 ms, so the visitor sees actual motion without anyone
    // having to actively run the host's local sim.
    this.visitMode.cloud = this.cloud;
    // Inbound side: subscribe to visit_event inserts targeting this
    // identity. Show a small bottom-right toast that auto-fades.
    this.cloud.onVisitedByOther((visitorHex: string) => {
      const accounts = this.cloud.listAccounts();
      const visitor = accounts.find((a) => a.identity.toHexString() === visitorHex);
      this.showVisitToast(visitor?.displayName ?? "Someone");
      // Lifetime "someone visited me" counter.
      this.game.bumpPlayerCounter("visitsIn");
    });
    // Home button while visiting should exit visit mode first so the
    // player goes back to their own restaurant cleanly.
    const originalGoHome = this.camera.goHome.bind(this.camera);
    this.camera.goHome = (x: number, z: number, floorY: number): void => {
      if (this.visitMode.isVisiting()) this.visitMode.exit();
      originalGoHome(x, z, floorY);
    };
    // Classify each floor by what its seats serve so the FloorSelector
    // can show a sub-label under each button (food / drinks / mix /
    // empty). Re-evaluated on the selector's own 1.5s timer so the tag
    // refreshes after table placements without threading furniture
    // events through here.
    this.floorSelector.getFloorContent = (floor) => {
      let hasFood = false;
      let hasDrink = false;
      for (const slot of this.registry.getResolvedSeatSlots()) {
        if (slot.floor !== floor) continue;
        if (slot.surface === "drink") hasDrink = true;
        else hasFood = true;
        if (hasFood && hasDrink) break;
      }
      if (!hasFood && !hasDrink) return "nothing";
      if (hasFood && hasDrink) return "mix";
      return hasFood ? "food" : "drink";
    };
    // Update world visibility whenever the tier changes (player bought an expansion).
    this.game.onLuxuryTierChanged = (tier) => {
      this.scene.setLuxuryTier(tier);
      this.floorSelector.update();
      // Tell the registry too so its seat catalog filter (which used
      // to read mesh visibility, but now reads tier) keeps the
      // upper-floor seats included as they unlock.
      this.registry.setLuxuryTier(tier);
      // BuildMenu tabs gain / lose the lock badge — refresh so the
      // freshly-unlocked tier becomes clickable immediately.
      this.buildMenu?.refreshTierTabs();
      // Phase 6.9 — eager push so visit-mode's buildInteriorShell
      // picks up the new floor count immediately. Without this, the
      // visitor's view of the building stayed at the old storey count
      // until the next autosave (day rollover / beforeunload).
      // cloudSaveNow is the right hammer here: tier purchases are
      // rare (5 lifetime) so the full save-blob upload is fine.
      void tier;
      this.cloud.cloudSaveNow();
    };
    this.decorModal = new DecorModal(container, this.game);
    // So opening Decor on Floor 2 lands on Floor 2's tab by default.
    this.decorModal.getFocusedStorey = () => this.scene.getFocusedStorey();
    // Wire theme changes to the live scene + restore the saved theme.
    // Also push the per-floor override CSV to the cloud restaurant
    // row so visit-mode + co-owner views render the same colors.
    // Format matches what set_restaurant_theme_overrides expects.
    this.game.onThemeChanged = (floor, theme) => {
      this.scene.setStoreyTheme(floor, theme);
      this.cloud.setRestaurantThemeOverrides(this.game.snapshotThemesByFloor());
    };
    // Replay every storey's saved theme on startup so the world
    // reflects per-floor decor choices the moment the scene mounts.
    for (let f = 0; f < WorldScene.getNumStoreys(); f += 1) {
      this.scene.setStoreyTheme(f, this.game.getThemeForFloor(f));
    }
    this.dayEndModal = new DayEndModal(container);
    this.game.onDayEnded = (summary) => {
      this.dayEndModal.show(summary);
      this.sfx.gong();
    };
    this.ledgerModal = new LedgerModal(container, this.game);
    this.helpModal = new HelpModal(container);
    // Hard block: HelpModal won't open while the game is still
    // auth-gated, regardless of who calls show(). Stops the welcome
    // card from flashing before the LoginModal on a cold load even
    // if a race condition somewhere else triggers show() early.
    this.helpModal.canShow = () => !this.game.isAuthGated();
    this.statsModal = new StatsModal(container, this.game);
    this.achievementsModal = new AchievementsModal(container, this.game);
    this.slotsModal = new SlotsModal(container, this.saver.getActiveSlot(), this.cloud);
    this.adminModal = new AdminModal(container, this.game, this.sfx, this.cloud, {
      isPaused: () => this.paused,
      setPaused: (p) => this.setPaused(p),
      getTimeScale: () => this.timeScale,
      setTimeScale: (s) => this.setTimeScale(s),
    });
    this.cloudModal = new CloudModal(container, this.cloud);
    // Door-plaque editor: click the plaque on the door lintel to edit
    // the restaurant name + sign style. Wire the scene-update callback
    // so a saved edit instantly repaints the in-world plaque, and seed
    // the scene with the current persisted name on startup.
    this.signModal = new RestaurantSignModal(container, this.game);
    this.game.onRestaurantSignChanged = (name, style) => {
      this.scene.setRestaurantSign(name, style);
      // Push BOTH name + style eagerly so visitors see the rename and
      // the new plaque styling within a tick of the host's save. The
      // legacy autosave path also writes Restaurant.name, but only at
      // day rollover / beforeunload — too slow for the "open the
      // RestaurantSignModal, type a name, click save, then ALT-TAB to
      // the visitor browser" demo flow. Phase 6.8 added
      // set_restaurant_name; Phase H added set_restaurant_sign_style.
      this.cloud.setRestaurantName(name);
      this.cloud.setRestaurantSignStyle(style);
    };
    this.scene.setRestaurantSign(this.game.getRestaurantName(), this.game.getRestaurantSignStyle());

    // Phase 6.7 — boost activation eagerly pushes the expiry to the
    // cloud so try_server_spawn_guest can halve the offline spawn
    // interval for the same window the foreground sees. Fire-and-
    // forget; the reducer is idempotent.
    this.game.onBoostStarted = (expiresAtMs) => {
      this.cloud.setBoostExpiresAt(expiresAtMs);
    };
    // Click listener — raycast against the plaque mesh; pop the modal
    // when hit. Doesn't interfere with build / sell / move modes since
    // those have their own pointer handling and we only trigger when
    // the click hits the plaque specifically.
    this.renderer.domElement.addEventListener("click", (e) => {
      if (!this.scene.signPlaqueMesh) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1),
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera.threeCamera);
      const hit = ray.intersectObject(this.scene.signPlaqueMesh, false);
      if (hit.length > 0) this.signModal.show();
    });
    // Pop a toast above the door whenever an achievement unlocks.
    // Phase I (H.100) — also pay the cash reward and surface the amount
    // in the toast so the player sees the bonus land. earnMoney
    // attributes the income to "achievement" for the daily ledger /
    // history split. Hydrate path uses markUnlockedSilent which does
    // NOT call onUnlock, so already-claimed achievements never
    // re-grant on reload.
    this.game.achievements.onUnlock = (a) => {
      const reward = a.cashReward ?? 0;
      if (reward > 0) {
        this.game.economy.rewardAchievement(reward);
      }
      const label = reward > 0
        ? `🏆 ${a.name} · +$${reward.toLocaleString("en-US")}`
        : `🏆 ${a.name}`;
      this.floatingText.pop(0, 5, label, "#ffd986");
      this.sfx.chime();
    };
    // Auto-show the welcome modal on a brand-new visit — but ONLY
    // after auth completes (see enterGame below). Triggering it
    // here during Engine construction made the welcome card flash
    // for a moment behind the login modal on every fresh load.
    this.floatingText = new FloatingText(container, this.camera.threeCamera, this.renderer.domElement);
    this.statusBubbles = new StatusBubbles(container, this.camera.threeCamera, this.renderer.domElement);
    // Phase I (UX) — wire the wall-occluder source so bubbles hide
    // when their character is behind a solid wall the player can't
    // see through.  WorldScene.getSolidWallOccluders() returns only
    // walls currently in non-ghost mode, so a wall the camera has
    // swapped to translucent (player CAN see through) doesn't trigger
    // false occlusion.
    this.statusBubbles.getOccluders = () => this.scene.getSolidWallOccluders();
    // Furniture registry — tracks every placed item so it persists, supports
    // overlap detection, and can be sold via the build-menu sell mode.
    // Pass a getStoreyMount callback so the registry can park each
    // placed item under the right parent — main scene for ground
    // floor, or the matching storey group for Floor 1+. That makes
    // visibility (focus + tier) automatic instead of needing a manual
    // toggle pass for every furniture model.
    this.registry = new FurnitureRegistry(
      this.scene.threeScene,
      this.scene.loader,
      (floor) => this.scene.getStoreyMount(floor),
      WorldScene.getStoreyHeight(),
    );
    // Phase F.3 — when isServerSim("furniture") is on, every
    // place/move/sell on the local registry also fires the matching
    // placed_furniture reducer. No-op when flag off.
    this.registry.cloud = this.cloud;
    // Pathfinder reads the live registry each query — we don't have to
    // rebuild a grid when furniture is placed/moved/sold. PlacedFurnitureItem
    // has defId/x/z plus extras, so it satisfies the PathfinderItem shape
    // structurally.
    this.pathfind = new Pathfinding(() => this.registry.snapshotItems());
    this.seatMarkers = new SeatMarkers(this.scene.threeScene, this.registry);
    // Floor-aware filtering — Phase 5 placements track a `floor` on each
    // placed item, so seat markers and status bubbles can hide anything
    // not on the focused storey. Without these wires the ground floor's
    // seat-slot discs leak through the upper slab and the upstairs
    // "cooking" / "pickup" labels leak through the camera into the
    // ground view (and vice versa).
    this.seatMarkers.getFocusedFloor = () => this.scene.getFocusedStorey();
    this.seatMarkers.getStoreyHeight = () => WorldScene.getStoreyHeight();
    this.statusBubbles.getFocusedFloor = () => this.scene.getFocusedStorey();
    this.statusBubbles.getStoreyHeight = () => WorldScene.getStoreyHeight();
    // Phase 9.37 — gameplay pops (+$N, tips, ratings, cleaning) follow the
    // same focused-floor filter as the bubbles, so other floors' pops
    // don't leak into the view.
    this.floatingText.getFocusedFloor = () => this.scene.getFocusedStorey();
    this.floatingText.getStoreyHeight = () => WorldScene.getStoreyHeight();
    if (savedState?.furniture && savedState.furniture.length > 0) {
      // SaveGameState.furniture mirrors the 2D PlacedFurniture shape
      // ({position:{x,y}, rotation:degrees}). Re-instantiate each item
      // back into the 3D scene.
      const restored = savedState.furniture.map((p) => ({
        uid: p.uid,
        defId: p.furnitureId,
        x: p.position.x,
        z: p.position.y,
        rotY: ((p.rotation ?? 0) * Math.PI) / 180,
        // Forward the surface-host link so restore's second pass
        // can re-snap surface items (toaster, coffee machine, etc.)
        // to their counter / cabinet top. Without this they loaded
        // at y=0 and visibly fell THROUGH the host counter every
        // time the player reopened the save.
        parentUid: p.parentUid,
        slotIndex: p.slotIndex,
        // And forward the player's per-child rotation offset so an
        // R-rotated microwave / coffee machine / blender survives
        // reload.
        localRotY: p.localRotY,
        // Multi-storey: which floor the item lives on. Missing in
        // pre-multi-storey saves → undefined → registry treats as
        // floor 0 (ground).
        floor: p.floor,
      }));
      // After restore, the demo's door (with its hinge panel captured)
      // gets removed and the save's restored door comes in fresh —
      // re-capture the hinge panel so setDoorOpen actually animates it.
      // Same dance for the stove + cooking flame: pin the flame to the
      // restored stove model so it sits on the actual burner instead
      // of the default fallback height.
      //
      // Walk the restored items to re-attach scene refs (door panel,
      // lamp lighting). Per-stove flames don't need a save-time pin
      // anymore — syncStoveFlames picks them up the next frame.
      //
      // CRITICAL: capture this promise on `furnitureRestorePromise` so
      // the LATER restoreFromCloud() call can await it.  Without the
      // chain, both restores fire as void-then-fire-and-forget and the
      // save's stale data can finish AFTER the cloud's fresh data —
      // overwriting it.  Symptom: move a table, refresh, table is
      // back at the old position because the save (autosaved before
      // the move) won the race.
      this.furnitureRestorePromise = this.registry.restore(restored).then(() => {
        for (const it of this.registry.snapshotItems()) {
          if (it.defId === "door") this.scene.attachDoorPanel(it.model);
          // Re-register lamps so a freshly-loaded save still gets the
          // night illumination on every placed lamp without the player
          // having to move them. Category lookup beats id-by-id checks
          // because new lamp variants in the catalog get picked up for
          // free.
          const def = getFurnitureDef(it.defId);
          if (def?.category === "lamp") this.scene.registerLamp(it.model);
        }
        // Doors + windows restored from save → rebuild every
        // perimeter wall so the gaps reflect where they actually
        // live now.
        this.scene.rebuildAllPerimeterWalls(this.allPerimeterOpenings());
        // Apply the current graphics-quality preset to the restored
        // furniture. Without this the Low preset's furnitureShadows=false
        // wouldn't reach pieces loaded from a save (they ship with
        // castShadow=true from ModelLoader.prepareScene).
        const preset = GRAPHICS_PRESETS[this.currentQuality];
        this.registry.forEachPlacedModel((model) => {
          this.scene.setShadowCastingOnSubtree(model, preset.furnitureShadows);
        });
      });
    }
    this.saver.registry = this.registry;
    // Demo placements: only register on a brand-new save (registry empty
    // after the restore above). Otherwise the save IS the source of
    // truth — re-registering demo would resurrect items the player sold.
    const hasSavedFurniture = !!(savedState?.furniture && savedState.furniture.length > 0);
    void this.scene.demoReady.then(() => {
      if (!hasSavedFurniture) {
        this.registry.registerExisting(this.scene.demoPlacements);
      } else {
        // The save is the source of truth — discard the demo placements.
        // Most are GLB-backed (shared cache; must NOT dispose), but the demo
        // front door is a proc model with unique geo+mat — free that one.
        for (const dp of this.scene.demoPlacements) {
          this.scene.threeScene.remove(dp.model);
          if (getFurnitureDef(dp.defId)?.modelPath.startsWith("proc:")) {
            disposeObject3D(dp.model);
          }
        }
      }
      // Apply tier visibility so locked sections show their marker.
      this.scene.setLuxuryTier(this.game.getLuxuryTier());
      this.registry.setLuxuryTier(this.game.getLuxuryTier());
      this.floorSelector.update();
      // Now that the demo door is in the registry (or NOT, for a
      // saved game where it was sold), rebuild every perimeter wall
      // so they have their gaps in the right places.
      this.scene.rebuildAllPerimeterWalls(this.allPerimeterOpenings());
    });
    // Let the Game read counts of placed sinks/dishwashers when scaling
    // the dish-wash interval.
    this.game.countPlacedById = (id) => this.registry.countById(id);
    this.game.getProvidedAppliances = () => this.registry.getProvidedAppliances();
    this.game.registry = this.registry;
    // StaffPanel queries this to show "X working" badges.
    this.game.getStaffWorkingCount = (role) => {
      // Phase 2 — the SERVER's staff_actor is the authority. The local
      // router sim renders idle even when the server has the member
      // working (drift grows across a session), so prefer the server's
      // not-idle count; fall back to the local snapshot only when the
      // cloud isn't ready (or for errand, which stays a local sim).
      const srv = this.cloud?.getServerStaffWorkingCount(role);
      if (srv != null) return srv;
      if (role === "chef") {
        return this.router?.snapshotStatus().filter((s) => s.role === "chef" && s.label).length ?? 0;
      }
      if (role === "waiter") {
        return this.router?.snapshotStatus().filter((s) => s.role === "waiter" && s.label).length ?? 0;
      }
      if (role === "barman") {
        return this.router?.snapshotStatus().filter((s) => s.role === "barman" && s.label).length ?? 0;
      }
      return this.errand?.snapshotStatus().filter((s) => s.label).length ?? 0;
    };
    // StaffPanel queries this for the "tickets queued" footer — keeps the
    // panel from looking "0 working" when there's actually work pending.
    this.game.getTicketStats = () => {
      // Phase 2 — prefer the server's active_ticket tallies; local fallback.
      const srv = this.cloud?.getServerTicketStats();
      if (srv != null) return srv;
      const tickets = this.router?.tickets ?? [];
      let queued = 0, cooking = 0, ready = 0, delivering = 0;
      for (const t of tickets) {
        if (t.state === "queued") queued += 1;
        else if (t.state === "cooking") cooking += 1;
        else if (t.state === "ready") ready += 1;
        else if (t.state === "delivering") delivering += 1;
      }
      return { queued, cooking, ready, delivering };
    };
    // Per-chef backlog accessor — StaffPanel reads this every HUD
    // tick to show "🍳 N" next to each chef's name. Returns 0 when
    // the router isn't ready yet (pre-staffReady) or the chef has
    // no work in their queue.
    this.game.getChefBacklog = (chefMemberId: string) => {
      // Phase 2 — server active_ticket first, local router as fallback.
      return this.cloud?.getServerChefBacklog(chefMemberId)
        ?? this.router?.getChefBacklog?.(chefMemberId) ?? 0;
    };
    // Phase I (H.72) — same wiring for the other roles so StaffPanel
    // can render a per-member "currently working" badge across the
    // board.  Each accessor returns 0 when the router isn't ready
    // yet (pre-staffReady) — that's harmless since the badge then
    // just doesn't appear, matching the "idle" visual.
    this.game.getBarmanBacklog = (id: string) => this.cloud?.getServerBarmanBacklog(id) ?? this.router?.getBarmanBacklog?.(id) ?? 0;
    this.game.getWaiterBacklog = (id: string) => this.cloud?.getServerWaiterBacklog(id) ?? this.router?.getWaiterBacklog?.(id) ?? 0;
    this.game.getErrandBacklog = (id: string) => this.errand?.getHelperWorkload?.(id) ?? 0;
    // Build menu — for placing furniture at runtime.
    const buildMenu = new BuildMenu(container, this.game, this.scene.loader, this.scene.threeScene, this.camera.threeCamera, this.renderer.domElement, this.registry);
    this.buildMenu = buildMenu;
    if (buildMenu.rootEl && buildMenu.titleEl) {
      makeDraggableResizable({
        storageKey: "cozy-bistro.panel.build.v3", // v2→v3 (2026-06-27): drop stale collapsed-height layouts
        root: buildMenu.rootEl,
        handle: buildMenu.titleEl,
        collapseSentinel: buildMenu.bodyEl,
        expandDirection: "down", // top-anchored — grow down when expanded
        minWidth: 220,
        minHeight: 60,
      });
    }
    buildMenu.seatMarkers = this.seatMarkers;
    // Multi-storey hooks: BuildMenu uses these to raycast against the
    // focused floor's slab, mount new placements under the right storey
    // group, and tie the storey-Y math to a single source of truth.
    buildMenu.getFocusedStorey = () => this.scene.getFocusedStorey();
    buildMenu.getStoreyMount = (floor) => this.scene.getStoreyMount(floor);
    buildMenu.getStoreyHeight = () => WorldScene.getStoreyHeight();
    // When the FloorSelector switches storeys mid-build, teleport the
    // active placement preview to the new floor so the player doesn't
    // have to wiggle the mouse to refresh the ghost's Y.
    this.floorSelector.onFocusChanged = () => {
      buildMenu.refreshFocusedFloor();
      // During a visit the FloorSelector drives the VISITED restaurant (the
      // player's own scene is hidden), so mirror the focus onto the visit
      // scene — otherwise a multi-floor host renders every storey stacked.
      if (this.visitMode.isVisiting()) {
        this.visitMode.setFocusedStorey(this.scene.getFocusedStorey());
      }
    };
    buildMenu.onDoorPlaced = (model) => {
      this.scene.attachDoorPanel(model);
      // Door event invalidates the front-wall layout — rebuild every
      // perimeter wall so the gap + lintel land in the right places
      // and any window cuts on neighbouring walls stay correct.
      // heldUid is non-null mid-move (pickup fires onDoorRemoved with
      // heldUid set; drop fires onDoorPlaced with heldUid cleared).
      // Either way the rebuild reflects the right state.
      this.scene.rebuildAllPerimeterWalls(this.allPerimeterOpenings(buildMenu.heldUid));
    };
    buildMenu.onDoorRemoved = () => {
      this.scene.rebuildAllPerimeterWalls(this.allPerimeterOpenings(buildMenu.heldUid));
    };
    buildMenu.onWindowPlaced = () => {
      this.scene.rebuildAllPerimeterWalls(this.allPerimeterOpenings(buildMenu.heldUid));
    };
    buildMenu.onWindowRemoved = () => {
      this.scene.rebuildAllPerimeterWalls(this.allPerimeterOpenings(buildMenu.heldUid));
    };
    // Per-stove flame pins are now driven by Engine.update via
    // scene.syncStoveFlames(registry.getCookingStoves()) — no place-
    // time hook required.
    buildMenu.onLampPlaced = (model) => this.scene.registerLamp(model);
    buildMenu.onLampRemoved = (model) => this.scene.unregisterLamp(model);

    // Spawner + routers + per-event hooks. Wait until WorldScene finishes
    // loading staff characters, then construct. Critically, all "common"
    // spawner hooks (registry, floatingText, sfx, hire/fire callbacks)
    // are wired regardless of whether the full router pair came up — a
    // previous version of this block returned early on missing chef/
    // waiter, which meant spawner.registry stayed null and the room
    // reported "0/0 seats" forever.
    void this.scene.staffReady.then(() => {
      const haveStaffPair = !!(this.scene.chefChar && this.scene.waiterChar);
      console.log(`[Engine] staffReady: chefChar=${this.scene.chefChar ? "OK" : "MISSING"} waiterChar=${this.scene.waiterChar ? "OK" : "MISSING"} errandChar=${this.scene.errandChar ? "OK" : "MISSING"}`);
      if (!haveStaffPair) {
        console.error(
          "[Engine] ⚠ STUB ROUTER ACTIVE — tickets will be processed but staff models won't move. " +
          "Chef or waiter character GLB failed to load. Check Network tab for chef.glb / waiter.glb.",
        );
      } else {
        // Make sure the StaffSystem has a roster entry for every base
        // staff character the world spawned (1 chef, 1 waiter, 1
        // errand). A fresh save has an empty roster; a loaded save
        // may already have the records. ensureBaseHeadcount pads
        // missing ones with auto-named members so we can attach
        // training to them.
        // Barman count starts at 0 — the player hires one when they
        // build a bar counter and want it staffed. No "base barman"
        // gets pre-spawned with the world.
        const baseCounts = { chef: 1, waiter: 1, errand: this.scene.errandChar ? 1 : 0, barman: 0 };
        this.game.staff.ensureBaseHeadcount(baseCounts);
        // First member of each role is the base char.
        const chefId = this.game.staff.getMembers("chef")[0]!.id;
        const waiterId = this.game.staff.getMembers("waiter")[0]!.id;
        this.router = new StaffRouter(
          this.scene.chefChar!, chefId,
          this.scene.waiterChar!, waiterId,
          this.scene.stovePos, this.scene.pickupPos,
          this.pathfind,
          () => this.registry.getStoves(),
          // Per-MEMBER multipliers — read live so a training upgrade
          // bought mid-shift takes effect immediately.
          (memberId) => this.game.getWaiterSpeedMultiplier(memberId),
          (memberId) => this.game.staff.getChefCookMultiplier(memberId),
          // Phase C.2: broader cook-station pool — the chef picks the
          // station whose `provides` matches the recipe's appliance
          // requirement instead of always claiming a stove.
          () => this.registry.getCookStations(),
        );
        // Wire the storey re-parent hook so staff models follow their
        // currentFloor through the stair cross — without this, a Floor 1
        // waiter descending to Floor 0 stays parented to Floor 1's
        // (hidden when player focuses on Floor 0) and looks like they
        // teleported the plate without actually walking down.
        this.router.reparentCharacter = (char, toFloor) => {
          this.scene.reparentCharacterToFloor(char, toFloor);
        };
        console.log("[Engine] real StaffRouter created with chef + waiter members", chefId, waiterId);
      }
      this.spawner = new GuestSpawner(
        this.scene.threeScene, this.scene.characterLoader, this.scene.animator,
        this.game, this.router ?? this.buildStubRouter(),
      );
      this.spawner.floatingText = this.floatingText;
      this.spawner.sfx = this.sfx;
      this.spawner.registry = this.registry;
      this.spawner.pathfind = this.pathfind;
      // Phase B.3b — when isServerSim("guests") is on, GuestSpawner
      // mirrors guest lifecycle to the active_guest cloud table.
      // No-op when flag off (default).
      this.spawner.cloud = this.cloud;
      // Phase I.1 (H.47) — hydrate from active_guest now that the
      // spawner has its cloud handle.  Imports any cloud rows that
      // aren't in the local save (server-spawned during offline play)
      // and despawns local guests the server already settled.  Async
      // because each import loads a GLB; we don't await it (foreground
      // sim can resume immediately, imported guests pop in as their
      // characters load — same UX as a normal spawn).
      void this.spawner.hydrateFromCloud();
      // Phase H Phase 3a — subscribe to active_guest changes so
      // server-driven guest state transitions get applied locally
      // with the right visual side effects (plate, chime, etc.).
      // Idempotent on repeated calls.
      this.spawner.attachGuestServerBridge();
      // Phase C.3b — same for StaffRouter's ticket lifecycle. Plus
      // wire the cross-system lookup so placeOrder knows the server-
      // side guest id for the FK.
      if (this.router) {
        this.router.cloud = this.cloud;
        this.router.lookupGuestServerId = (id) => this.spawner?.lookupGuestServerId(id);
        this.router.lookupLocalGuestId = (serverId) => this.spawner?.findLocalGuestIdByServerId(serverId);
        // Phase H Phase 1 — subscribe to server's authoritative ticket
        // + staff_actor decisions and reconcile local state.  Idempotent:
        // when the local sim wins the race the bridge is a no-op; when
        // the server wins (backgrounded tab, server tick lands first),
        // the bridge transitions the local actor instead of waiting for
        // the local sim to make the same decision a frame later.
        this.router.attachServerBridge();
      }
      // P5.7 — let SpacetimeClient.cloudSaveNow read the live restaurant
      // open / free-seats state so server-side attraction can skip
      // closed + full plots.
      this.cloud.cloudSpawnerHook = () => {
        const stats = this.spawner?.getSpawnerStats();
        if (!stats) return null;
        return { open: this.spawner!.restaurantOpen, freeSeats: stats.seatsAvail };
      };
      // Re-parent guests onto the right storey group as they cross the
      // stair. Without this hook, every guest is parented to the main
      // scene for their entire visit (always visible) — a Floor 1
      // customer would render in the ground-floor view too, leaking
      // upper-floor activity into the focused storey.
      this.spawner.reparentCharacter = (char, toFloor) => {
        this.scene.reparentCharacterToFloor(char, toFloor);
      };
      // Plates + leftover meshes also need per-floor parenting so
      // they hide with the storey when the player focuses elsewhere
      // (without this the served-food icons on Floor 2 bled through
      // the slab when the player switched to Floor 0).
      this.spawner.getStoreyMount = (floor: number) => this.scene.getStoreyMount(floor);
      // Task A — stand up the host's own cloud-driven dirty-pile
      // renderer. Parent each pile to its storey group (same per-floor
      // mount the served-food plates use) so leftovers on Floor 1 hide
      // when the player focuses Floor 0 instead of bleeding through the
      // slab. Built once; the dirty_pile subscription is attached in the
      // post-context interval loop below (hostDirtyPileSubscribed latch).
      if (!this.hostDirtyPiles) {
        this.hostDirtyPiles = new DirtyPileVisualizer();
        const storeys = WorldScene.getNumStoreys();
        for (let f = 0; f < storeys; f += 1) {
          this.hostDirtyPiles.setStoreyMount(f, this.scene.getStoreyMount(f));
        }
        // Fallback to the ground-floor mount for any row whose floor has
        // no registered storey group yet (defensive; matches VisitMode).
        this.hostDirtyPiles.setFallbackRoot(this.scene.getStoreyMount(0));
      }
      // We deliberately don't wire dishware.onDishWashed: the wash
      // trip path removes the specific mesh it picked up (via
      // pickupDirty) and firing onDishWashed afterward would yank a
      // SECOND unrelated leftover off some other table — the dirty
      // pile would visually drain twice as fast as it inventory-drains.
      // Wire the waiter wash trip system. Spawner owns the dirty
      // pieces; StaffRouter walks the waiter to them. Without this
      // block (e.g. no router), dirty plates simply pile up.
      if (this.router) {
        const spawner = this.spawner;
        const registry = this.registry;
        const dishware = this.game.dishware;
        // Wire the waiter take-order callback so when a waiter finishes
        // the dwell at a seated guest's table, the spawner builds the
        // recipe list + enqueues the cooking ticket. Without this wire
        // the seated guest would sit forever; the spawner's seated
        // block has a defensive fallback that builds the order if
        // g.orderTaken becomes true with an empty g.order, but the
        // happy path is for this callback to do it.
        this.router.takeOrderCallback = (guestId) => {
          spawner.onWaiterTookOrder(guestId);
        };
        // Wire patience lookup so the router sorts work by urgency
        // (X3 — most-impatient ticket / order request gets picked
        // first instead of the oldest one).
        this.router.getGuestPatience = (guestId) => spawner.getGuestPatience(guestId);
        this.router.washCallbacks = {
          getDirtyPickups: () => spawner.getDirtyPickups(),
          claimDirtyPickup: (id, memberId) => spawner.claimDirtyPickup(id, memberId),
          releaseDirtyPickup: (id) => spawner.releaseDirtyPickup(id),
          pickupDirty: (id) => spawner.pickupDirty(id),
          getWashStations: () => registry.getWashStations().map((s) => ({
            uid: s.uid, defId: s.defId, standPos: s.standPos, dwell: s.dwell, floor: s.floor,
          })),
          washOne: (kind) => { dishware.washOne(kind); },
          canDishwasherLoad: (uid, kind) => dishware.canDishwasherLoad(uid, kind),
          canDishwasherLoadN: (uid, kind, max) => dishware.canDishwasherLoadN(uid, kind, max),
          loadDishwasher: (uid, defId, kind) => dishware.loadDishwasher(uid, defId, kind),
        };
      }
      // Dishware leak watcher — automatic guard against any future
      // code path that decrements the clean pool without returning the
      // plate via dirty or buy. Wires every mutation + context event
      // into a ring buffer; tick() runs once per second and prints a
      // warning with the recent history when the inventory total
      // dips below the lifetime-added baseline.
      this.dishwareLeakWatcher = new DishwareLeakWatcher(
        this.game.dishware,
        { getInFlightDishCount: () => this.spawner?.getInFlightDishCount() ?? 0 },
      );
      this.game.dishware.setLogger((msg) => this.dishwareLeakWatcher?.record(msg));
      this.spawner.setDishwareLogger((msg) => this.dishwareLeakWatcher?.record(msg));
      // Phase E — DishwareSystem mirrors pool + batch mutations to
      // the cloud when isServerSim("dishware") is on. No-op flag-off.
      this.game.dishware.cloud = this.cloud;
      // H.36 — same shape for the pantry. CookingSystem mirrors every
      // consumeIngredients / addPantryStock to bump_pantry_stock so
      // visit mode + co-owner views see live ingredient counts.
      this.game.cooking.cloud = this.cloud;
      // H.40 — push the current active menu now (covers the
      // initial-load case where menu was set from the save before
      // cloud was wired). addToMenu/removeFromMenu fire their own
      // mirrors from this point forward.
      this.cloud.setActiveMenu(this.game.cooking.getMenuRecipeIds());
      // H.39 — staff roster mirror. StaffSystem fires
      // setHiredStaffMember on hire + training-level-up, and
      // deleteHiredStaffMember on fire.  Mirrors are observational
      // (client stays the source of truth in foreground); cloud row
      // gives visit mode + leaderboard access to the live roster.
      this.game.staff.cloud = this.cloud;
      // Energy audit (D) — skip catalog reseed if we already did one
      // recently.  Catalog data (recipe_ingredients, recipe_meta,
      // customer_archetype, ingredient_cost) is essentially static —
      // it only changes when a build ships a new game data file.
      // Resetting on every connect (~190 reducer calls) was burning
      // energy for no real benefit.  24-hour TTL gives us a daily
      // re-seed window that catches any catalog edits the player
      // hasn't reloaded for, without paying the cost per session.
      //
      // The per-restaurant recipe_level mirror is gated separately
      // since it's owner-specific state — H.43 reconciles those on
      // every connect via the drain path, not via this seed loop.
      const LAST_CATALOG_SEED_KEY = "cozy-bistro.last-catalog-seed.v4"; // v4: + furniture_meta (server-side appeal/aggregates)
      const CATALOG_SEED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
      const lastSeedRaw = localStorage.getItem(LAST_CATALOG_SEED_KEY);
      const lastSeed = lastSeedRaw ? parseInt(lastSeedRaw, 10) : 0;
      const seedAgeMs = Date.now() - lastSeed;
      const needsCatalogReseed = !lastSeed || seedAgeMs > CATALOG_SEED_TTL_MS;
      if (needsCatalogReseed) {
        console.log("[Engine] catalog reseed (lastSeed:",
          lastSeed ? `${Math.round(seedAgeMs / 1000 / 60 / 60)}h ago` : "never", ")");
        // H.37 + H.40 + H.53 — seed recipe_ingredients + recipe_meta
        // (the per-recipe static catalog data).  Server's
        // auto_place_next_course + build_server_order read these.
        void Promise.all([
          import("../data/recipes"),
          import("../systems/CookingSystem"),
        ]).then(([{ recipes }, { getRecipeLuxuryTier }]) => {
          for (const r of recipes) {
            this.cloud.setRecipeIngredients(r.id, r.ingredients);
            const appliance = r.category === "drink"
              ? "bar"
              : (r.appliances?.[0] ?? r.stationNeeded ?? "stove");
            this.cloud.setRecipeMeta({
              recipeId: r.id,
              // ×1.5 mirrors Game.COOK_TIME_GLOBAL_MULT (private there,
              // so the factor is duplicated here). Keeps server-spawned
              // background-guest cook times in step with the foreground
              // place_order path that already routes through that mult.
              baseCookSecondsMs: Math.round((r.preparationTimeSeconds ?? 5) * 1.5 * 1000),
              appliance,
              // Phase 9.56 — send the RECOMPUTED L1 base (tier base profit
              // + ingredient), not the static catalog sellPrice, so the
              // server's offline pricing tracks the new tier scaling.
              sellPriceCents: Math.round(this.game.getBaseSellPrice(r) * 100),
              satisfactionX100Base: Math.round((r.satisfactionEffect ?? 4) * 100),
              category: r.category,
              tier: getRecipeLuxuryTier(r),
            });
          }
        });
        // H.38 — same shape for customer_archetype.
        void import("../data/customerArchetypes").then(({ customerArchetypes }) => {
          for (const a of customerArchetypes) {
            this.cloud.setCustomerArchetype({
              archetypeId: a.id,
              weight: a.weight,
              patienceMultX100: Math.round(a.patienceMultiplier * 100),
              tipMultX100: Math.round(a.tipMultiplier * 100),
              orderSizeBias: a.orderSizeBias,
              wcUseChanceX100: Math.round(a.wcUseChance * 100),
            });
          }
        });
        // H.41 — seed ingredient_cost.
        void import("../data/ingredients").then(({ INGREDIENT_COSTS }) => {
          for (const [id, dollars] of Object.entries(INGREDIENT_COSTS)) {
            this.cloud.setIngredientCost(id, Math.round(dollars * 100));
          }
        });
        // Phase A2 (anti-cheat) — seed furniture_cost so the server can
        // price-check furniture purchases (Phase B). scaledCost is the
        // displayed buy price; ×100 → cents. Only the admin's seed lands
        // (set_furniture_cost gates changes); non-admin re-seeds no-op.
        void import("../data/furnitureCatalog").then(({ furnitureCatalog, scaledCost, furnitureRefundValue }) => {
          for (const def of furnitureCatalog) {
            this.cloud.setFurnitureCost(
              def.id,
              Math.round(scaledCost(def) * 100),
              Math.round(furnitureRefundValue(def) * 100),
            );
            // Phase 9.62 — seed furniture_meta so the SERVER computes
            // per-seat taste appeal + the attraction aggregate itself
            // (no more client-computed mirrors). surface "" for non-tables.
            this.cloud.setFurnitureMeta(
              def.id,
              def.category,
              Math.round((def.style ?? 0) * 100),
              Math.round((def.comfort ?? 0) * 100),
              Math.round((def.attractionBonus ?? 0) * 100),
              Math.round((def.ratingBonus ?? 0) * 100),
              def.surface ?? "",
            );
          }
        });
        localStorage.setItem(LAST_CATALOG_SEED_KEY, String(Date.now()));
      } else {
        console.log("[Engine] catalog reseed skipped (last seed",
          `${Math.round(seedAgeMs / 1000 / 60)}m ago, < ${CATALOG_SEED_TTL_MS / 1000 / 60 / 60}h TTL)`);
      }
      // Per-restaurant recipe_level mirror — H.53.  Owner-specific
      // state, fires regardless of catalog reseed gate.  Idempotent;
      // server skips writes when the level matches.
      void import("../data/recipes").then(({ recipes }) => {
        for (const r of recipes) {
          this.cloud.setRecipeLevel(r.id, this.game.cooking.getRecipeUpgradeLevel(r));
        }
      });
      // H.59 — hydrate achievement unlocks from the cloud's
      // achievement_unlock table.  The server already records every
      // unlock (via the unlock_achievement reducer fired in
      // wireGameHooks); this is the read-side pickup so a fresh
      // device sees the same unlocked set, and a save that's behind
      // doesn't "re-unlock" milestones the server already has.
      try {
        const cloudUnlocks = this.cloud.listMyAchievements();
        let added = 0;
        for (const id of cloudUnlocks) {
          if (this.game.achievements.markUnlockedSilent(id)) added += 1;
        }
        if (added > 0) {
          console.log(`[H.59] achievement hydrate: ${added} unlock(s) imported from cloud (total ${this.game.achievements.count()}/${this.game.achievements.total()})`);
        }
      } catch (e) {
        console.warn("[Engine] H.59 achievement hydrate failed:", e);
      }

      // H.60 — wire ReputationSystem's cloud handle so every future
      // recordRating mirrors the full list; then hydrate from cloud
      // if it has a fresher version than the save did.  Cloud is
      // authoritative — if it's set, override local.
      this.game.reputation.cloud = this.cloud;
      try {
        const cloudHistory = this.cloud.getCloudRatingHistory();
        if (cloudHistory && cloudHistory.length > 0) {
          this.game.reputation.applyCloudRatingHistory(cloudHistory);
          console.log(`[H.60] rating-history hydrate: ${cloudHistory.length} ratings imported from cloud (avg ${this.game.reputation.getAverageRating().toFixed(2)})`);
        }
      } catch (e) {
        console.warn("[Engine] H.60 rating-history hydrate failed:", e);
      }

      // H.61 — wire EconomySystem's cloud handle (transaction log
      // mirror).  Push cadence is driven from Engine.update's
      // daySyncAccum tick (every 5 s), not on every recordTransaction
      // — busy play can fire many transactions per second.
      this.game.economy.cloud = this.cloud;
      try {
        const cloudLog = this.cloud.getCloudTransactionLog();
        if (cloudLog && cloudLog.length > 0) {
          this.game.economy.applyCloudTransactionLog(cloudLog);
          console.log(`[H.61] transaction-log hydrate: ${cloudLog.length} entries imported from cloud`);
        }
      } catch (e) {
        console.warn("[Engine] H.61 transaction-log hydrate failed:", e);
      }

      // H.63 — wire DayHistory's cloud handle so every Game.rolloverDay
      // mirrors the ring buffer.  Hydrate from cloud if populated.
      this.game.history.cloud = this.cloud;
      try {
        const cloudDays = this.cloud.getCloudDayHistory();
        if (cloudDays && cloudDays.length > 0) {
          this.game.history.applyCloudSnapshot(cloudDays);
          console.log(`[H.63] day-history hydrate: ${cloudDays.length} days imported from cloud`);
        }
      } catch (e) {
        console.warn("[Engine] H.63 day-history hydrate failed:", e);
      }

      // Phase I (H.68) — hydrate the StaffPanel's waiter-rest-spot
      // status label from cloud.  StaffRouter.pickWaiterIdleSpot
      // reads the cloud value live each tick so no client-side
      // cache to sync — just the UI label needs a one-time pull.
      try {
        const restSpot = this.cloud.getWaiterRestSpot();
        this.staffPanel.setWaiterRestStatus(restSpot);
        if (restSpot) {
          console.log(`[H.68] waiter rest spot hydrate: F${restSpot.floor} (${restSpot.x.toFixed(1)}, ${restSpot.z.toFixed(1)})`);
        }
      } catch (e) {
        console.warn("[Engine] H.68 waiter-rest-spot hydrate failed:", e);
      }

      // H.41 + Phase 7.5 — drain offline auto-shop debt.
      // Server now deducts cloud_money_cents directly during the
      // backgrounded restock (try_restock_pantry), and Phase 7.2's
      // setMoney(cloudMoneyCents) on rollup drain already adopted the
      // restock-deducted cash value. Skip the local forceSpendMoney
      // here — debiting again would double-charge. Still consume the
      // counter to clear it.
      const pendingRestockCents = this.cloud.getPendingRestockCostCents();
      if (pendingRestockCents > 0) {
        console.log(`[Cloud] consumed ${pendingRestockCents} cents pending restock (already deducted from cloud_money_cents server-side)`);
        this.cloud.consumePendingRestockCost();
      }

      // H.43 — drain server-completed recipe upgrades.  Server
      // bumped these while the tab was offline; apply level+1 locally
      // for each, clear any stale local trainingCompletesAt so the
      // local tickRecipeUpgrades doesn't double-fire, then consume.
      const completedRecipes = this.cloud.getPendingRecipeUpgradesCompleted();
      if (completedRecipes.length > 0) {
        for (const recipeId of completedRecipes) {
          const curLevel = this.game.cooking.getRecipeUpgradeLevel(recipeId);
          // Server already bumped, so we want curLevel+1.  Clamp via
          // setRecipeUpgradeLevel which already enforces [1, max].
          this.game.cooking.setRecipeUpgradeLevel(recipeId, curLevel + 1);
          // Drop any stale local timer so the next tickRecipeUpgrades
          // doesn't fire a duplicate completion.
          this.game.cooking.cancelRecipeUpgrade(recipeId);
        }
        this.cloud.consumePendingRecipeUpgrades();
      }

      // H.44 — drain server-completed staff training.  Server already
      // bumped hired_staff_member.upgrade_level; sync each local
      // roster entry to the cloud value, clear local trainingCompletesAt,
      // then consume the pending CSV.  Cloud level is authoritative
      // post-completion.
      const completedTraining = this.cloud.getPendingTrainingCompletions();
      if (completedTraining.length > 0) {
        for (const memberId of completedTraining) {
          const cloudLevel = this.cloud.getCloudMemberUpgradeLevel(memberId);
          if (cloudLevel == null) continue;
          const localMember = this.game.staff.getMember(memberId);
          if (!localMember) continue;
          // Suppress the mirror so we don't re-fire setHiredStaffMember
          // back at the cloud during this sync (cloud is the source
          // of truth here).
          this.game.staff.withMirrorSuppressed(() => {
            localMember.upgradeLevel = cloudLevel;
            if (typeof localMember.trainingCompletesAt === "number") {
              delete localMember.trainingCompletesAt;
            }
          });
        }
        this.cloud.consumePendingTrainingCompletions();
      }

      // H.45 + Phase 7.5 — drain offline salary accrual.
      // Server now also deducts cloud_money_cents directly during the
      // offline tick (alongside bumping pending_salary_cost_cents).
      // Phase 7.2's setMoney(cloudMoneyCents) on rollup drain already
      // adopted the salary-deducted cash value, so calling
      // forceSpendMoney here would double-deduct — visibly drop cash
      // a second time after the cloud adoption, which IS the reload
      // jolt the user reported. Skip the local debit; just consume
      // the counter to clear it and reset the tick clock so the next
      // offline period starts fresh.
      const pendingSalaryCents = this.cloud.getPendingSalaryCents();
      if (pendingSalaryCents > 0) {
        console.log(`[Cloud] consumed ${pendingSalaryCents} cents pending salary (already deducted from cloud_money_cents server-side)`);
        this.cloud.consumePendingSalary();
      }
      this.cloud.resetSalaryTickClock();
      // H.45 — seed the server's base payroll rate so its offline
      // accrual matches the local rate.  Fires on every reconnect;
      // if the admin panel changed the rate later, a fresh
      // setCloudPayrollRate call from Game.tick would keep them in
      // sync (current implementation: server just uses whatever the
      // last mirror set).
      this.cloud.setCloudPayrollRate(
        Math.round(this.game.admin.payrollPerStaffPerMinute * 100),
      );
      // Phase 6.10 — Reconcile boost timers against the cloud's
      // boost_expires_at_micros. Local boostCooldownRemaining ticks
      // only while the tab is open; without this step the save-blob
      // would restore a stale countdown that doesn't reflect the
      // wall-clock elapsed during offline. Game.restoreBoostStateFromCloud
      // derives the correct boostRemaining / boostCooldownRemaining
      // from the single cloud timestamp + Date.now().
      try {
        const boostExpiresAtMicros = this.cloud.getCloudBoostExpiresAtMicros();
        if (boostExpiresAtMicros != null) {
          this.game.restoreBoostStateFromCloud(boostExpiresAtMicros / 1000);
        }
      } catch (e) {
        console.warn("[Engine] Phase 6.10 boost reconcile failed:", e);
      }
      // Wire SaveSystem → GuestSpawner so a refresh / cloud-load
      // doesn't permanently lose plates a mid-meal guest was holding.
      this.game.gatherInFlightDishes = () => this.spawner?.getInFlightByKindTier() ?? [];
      if (this.router) {
        this.router.setDishwareLogger((msg) => this.dishwareLeakWatcher?.record(msg));
      }
      // P5 — replace the legacy per-client PedestrianSpawner with the
      // SharedPedestrians renderer that consumes the server-side
      // pedestrian table. Both parent into worldRoot so the player's
      // plot offset shifts the crowd onto the correct visual avenues.
      this.sharedPedestrians = new SharedPedestrians(this.scene.worldRoot, this.scene.characterLoader, this.scene.animator);
      // P5.3b — when a target-bound walker reaches a plot's door,
      // SharedPedestrians fires onArrival with the plot id. If it
      // matches the player's own claimed plot, feed the customer
      // into the local GuestSpawner so the existing seat-pick /
      // order / eat flow takes over. Walkers heading to OTHER plots
      // are visually identical to ambient walkers from this client's
      // POV — they despawn at someone else's door and that owner's
      // browser handles the gameplay handoff.
      this.sharedPedestrians.onArrival = (targetPlotId: bigint, _variant: string): void => {
        const mine = this.cloud.getMyBuilding();
        if (!mine) return;
        if (mine.id !== targetPlotId) return;
        this.spawner?.triggerExternalArrival(_variant);
      };
      this.trash = new TrashSpawner(this.scene.threeScene, this.game);
      // Errand helper — carries the shopping list out the door, then back.
      // The frozen list is delivered to the pantry the moment they're home.
      if (this.scene.errandChar) {
        // Errand helper makes a full out-and-back trip:
        //   home → door → pavement edge → (offscreen 20s) → pavement
        //   edge → door → supply counter → home
        // The ErrandRouter needs both anchors: the door (entry/exit
        // waypoint) and the supply counter (drop-off point).
        const errandId = this.game.staff.getMembers("errand")[0]?.id ?? this.game.staff.addStaff("errand").id;
        this.errand = new ErrandRouter(
          this.scene.errandChar,
          errandId,
          this.scene.doorPos,
          this.scene.supplyCounterPos,
          this.pathfind,
        );
        this.errand.onDelivery = (list) => this.game.completeErrandDelivery(list);
        this.game.onAutoShopDispatch = (list) => this.errand?.triggerRun(list);
        // Gate the auto-shop dispatcher on actual errand capacity so we
        // can't leak the pending counter again by committing money for
        // trips the router drops.
        this.game.canDispatchErrand = () => this.errand?.canAcceptTrip() ?? false;
        // Phase I (H.65) — wire the cloud handle so the errand helper
        // mirrors position + state to staff_actor (role="errand") at
        // 1 Hz.  Without this the helper's pose is purely client-side
        // and a refresh teleports them back to home — the exact bug
        // the user reported.  setCloud also re-registers the base
        // helper that was added in the ctor before we had the handle.
        this.errand.setCloud(this.cloud);
        // Phase H Phase 5.4 — subscribe to staff_actor changes so
        // server-dispatched errand trips drive the local helper's
        // visual (position + phase + visibility). Local Game's
        // dispatchAutoShopTrip is gated when serverOwnsErrand() is
        // on; the bridge is the sole driver in that mode.
        this.errand.attachServerBridge();
      }
      // Hire / fire callbacks. We wire these even when staff is missing
      // so future hires can attempt to load (handleStaffHired falls back
      // gracefully when this.router is undefined).
      this.game.onStaffHired = (role) => {
        void this.handleStaffHired(role);
      };
      this.game.onStaffFired = (role) => {
        this.handleStaffFired(role);
      };
      this.game.onStaffMemberFired = (memberId, role) => {
        this.handleStaffMemberFired(memberId, role);
      };
      this.game.onTrainingCompleted = (member) => {
        // Find the actor's world position so the toast pops over the
        // right character. Fall back to the supply counter for errand
        // helpers offscreen.
        const worldPos = this.findMemberWorldPos(member.id);
        const label = `🎓 ${member.name} → L${member.upgradeLevel}`;
        this.floatingText?.pop(worldPos.x, worldPos.y - 0.4, label, "#ffd986");
        this.sfx?.chime();
      };
      this.game.onRecipeUpgradeCompleted = (recipe, newLevel) => {
        // Recipe upgrades pop over the stove since that's where the
        // kitchen's brain lives visually.
        const at = this.scene.stovePos;
        this.floatingText?.pop(at.x, at.y - 0.4,
          `📜 ${recipe.name} → L${newLevel}`, "#ffd986");
        this.sfx?.chime();
      };
      if (haveStaffPair) {
        // Restore any extra hired staff from the save. The base 3
        // characters (1 chef, 1 waiter, 1 errand) are already in the
        // world; if the save shows more, spawn the difference. Sync
        // tolerates a missing errand router internally.
        //
        // Phase I.1 (H.48) — once syncStaffToHeadcount has registered
        // every saved staff member into the router, hydrate each one's
        // STATE from cloud's staff_actor table.  Save brings back the
        // last autosaved positions; cloud has the actual server-driven
        // mid-trip positions (H.6/H.8/H.34/H.35 may have moved them
        // during the offline window).
        // Phase I (H.74/H.77) — fire the roster push IMMEDIATELY (not
        // inside the .then() below).  syncStaffToHeadcount awaits GLB
        // loads which can reject; if it does, the .then() never runs
        // and the cloud roster stays empty forever.  pushRosterToCloud
        // iterates the LOCAL members array — it doesn't need actors
        // to exist yet, just StaffSystem.cloud to be wired (it is by
        // this point in the connect flow).
        this.game.staff.pushRosterToCloud();
        void this.syncStaffToHeadcount().then(() => {
          // Phase I (H.74) — actor resync goes here because we DO need
          // syncStaffToHeadcount to have run first (it spawns the
          // extra-staff actors).  Same robustness story below: any
          // throw in syncStaffToHeadcount kills these.
          this.router?.resyncAllActorsToCloud();
          this.errand?.resyncAllActorsToCloud();
          this.router?.hydrateFromCloud();
          // Phase I.1 (H.48b) — once staff are hydrated AND H.47 has
          // imported any cloud-only guests, reconstruct local tickets
          // from active_ticket.  Skips tickets whose guest_id has no
          // matching local guest (their guest was server-settled
          // before reconnect).
          this.router?.hydrateTicketsFromCloud(
            (serverId) => this.spawner?.findLocalGuestIdByServerId(serverId),
          );
          // Phase I (H.65) — restore the errand helper's last-known
          // position + state.  Same shape as the staff hydrate above:
          // the local sim spawned a fresh helper at home; cloud has
          // the actual mid-trip pose we want to resume from.
          this.errand?.hydrateFromCloud();
          // Phase 9.2 — actors are registered; the update() retry
          // block may now run the staff/ticket hydrates if the calls
          // above no-opped on missing cloud context.
          this.staffSyncDone = true;
        }).catch((err) => {
          // Phase I (H.77) — surface failures.  Without a catch, any
          // rejected promise inside syncStaffToHeadcount (e.g. one of
          // the GLB loads inside spawnExtraStaff) would swallow the
          // entire chain — including the actor-resync push that
          // populates the cloud's staff_actor table.  Logging here
          // means we still see the error AND fire a best-effort
          // resync so the cloud roster fills even on partial GLB
          // failure.
          console.error("[Engine] syncStaffToHeadcount chain failed:", err);
          this.router?.resyncAllActorsToCloud();
          this.errand?.resyncAllActorsToCloud();
          // Phase 9.2 — even on partial GLB failure, let the retry
          // block attempt the hydrates for whatever actors DID land.
          this.staffSyncDone = true;
        });
      } else {
        console.warn("[Engine] no staff pair — skipping syncStaffToHeadcount");
      }
    });

    // Save on tab close. saveNowSync uses the main-thread JSON.stringify
    // path — the page may close before the save worker round-trip
    // completes, so we can't rely on the async path here.
    window.addEventListener("beforeunload", () => this.saver.saveNowSync());

    // Phase B dev hooks — let the developer poke at the server-
    // authoritative migration from devtools without writing code.
    // Wired even in production; the flag default of all-OFF means
    // calling these has no effect on the live sim until you flip
    // `?serverSim=guests` and reload.
    //
    // Usage from the browser console:
    //   cozyBistro.spawnTestGuest()   → fires a sample spawn_guest reducer
    //   cozyBistro.listGuests()       → prints every active_guest row
    //   cozyBistro.featureFlags       → current serverSim flag state
    (window as unknown as { cozyBistro?: unknown }).cozyBistro = {
      spawnTestGuest: () => {
        const clientTempId = `dev-guest-${Date.now()}`;
        this.cloud.spawnGuest({
          clientTempId,
          variant: "guest-v0",
          archetype: "regular",
          tasteDiet: "both",
          tasteDecorPref: 0.5,
          tasteWindowPref: 0.5,
          tasteCuisineBias: "",
          tasteDrinkTolerance: 0.5,
          willUseToilet: false,
          doorX: 0, doorZ: 5.45, doorFloor: 0,
          // H.17 / H.24 — neutral defaults for the dev-only test spawn.
          // Keep this caller in sync with SpacetimeClient.spawnGuest's
          // signature whenever new fields are mirrored; CI runs `tsc`
          // and a missing field here blocks the GitHub Pages deploy.
          patienceMultX100: 100,
          willWashOnly: false,
        });
        console.log(`[Dev] spawn_guest fired (clientTempId=${clientTempId})`);
      },
      listGuests: () => {
        const rows = this.cloud.listActiveGuests();
        console.table(rows);
        return rows;
      },
      /** Aggregate snapshot of every server-side table this restaurant
       * has authored. Use to verify the write-side mirror is actually
       * publishing data when the corresponding ?serverSim=... flag is
       * on. Prints one console.table per system + a summary line. */
      /** Inspect what live data exists on the server for a host the
       * player can visit. Pass `ownerHex` (the hex identity of the
       * other player) OR call with no args to print a summary across
       * every restaurant the visitor's cache knows about. Use this
       * when visit mode shows "no movement" to figure out whether
       * the host actually has staff_actor rows populated. */
      visitDebug: (ownerHex?: string) => {
        console.group("[cozyBistro.visitDebug]");
        const allStaff = this.cloud.listAllStaffActors();
        const allGuests = this.cloud.listAllActiveGuests();
        const allTickets = this.cloud.listAllActiveTickets();
        // Summary across every restaurant. Helps confirm SOMETHING
        // is in the cache before drilling into one host.
        const totalRows = allStaff.length + allGuests.length + allTickets.length;
        console.log(`Cache totals across all restaurants: ${allStaff.length} staff · ${allGuests.length} guests · ${allTickets.length} tickets`);
        if (totalRows === 0) {
          console.log("⚠ No live rows in subscription cache for ANY restaurant.");
          console.log("  → Either nobody has played yet on the published module, or the module hasn't been published with the latest server-sim tables. Have a host open the game and play for a few seconds to populate.");
          console.groupEnd();
          return { staff: [], guests: [], tickets: [] };
        }
        // Group counts per restaurant for a quick overview.
        const perRestaurant = new Map<string, { staff: number; guests: number; tickets: number }>();
        const bump = (rid: bigint, key: "staff" | "guests" | "tickets") => {
          const k = String(rid);
          const entry = perRestaurant.get(k) ?? { staff: 0, guests: 0, tickets: 0 };
          entry[key] += 1;
          perRestaurant.set(k, entry);
        };
        for (const s of allStaff)   bump(s.restaurantId, "staff");
        for (const g of allGuests)  bump(g.restaurantId, "guests");
        for (const t of allTickets) bump(t.restaurantId, "tickets");
        for (const [rid, counts] of perRestaurant) {
          console.log(`  restaurant ${rid}: ${counts.staff} staff · ${counts.guests} guests · ${counts.tickets} tickets`);
        }
        if (ownerHex) {
          const targetRid = this.cloud.findRestaurantIdByOwnerHex(ownerHex);
          if (targetRid == null) {
            console.log(`⚠ No restaurant found for owner ${ownerHex}. Either the cache hasn't primed or the player has no restaurant.`);
          } else {
            const hostStaff   = allStaff  .filter((s) => s.restaurantId === targetRid);
            const hostGuests  = allGuests .filter((g) => g.restaurantId === targetRid);
            const hostTickets = allTickets.filter((t) => t.restaurantId === targetRid);
            console.log(`Host ${ownerHex} → restaurant ${targetRid}:`);
            if (hostStaff.length === 0 && hostGuests.length === 0 && hostTickets.length === 0) {
              console.log("  ⚠ No live rows for this host. They need to be online (or have been online recently) for their session to populate the tables.");
            } else {
              if (hostStaff.length)   { console.log(`  ${hostStaff.length} staff:`);   console.table(hostStaff.map((s) => s.row)); }
              if (hostGuests.length)  { console.log(`  ${hostGuests.length} guests:`); console.table(hostGuests.map((g) => g.row)); }
              if (hostTickets.length) { console.log(`  ${hostTickets.length} tickets:`); console.table(hostTickets.map((t) => t.row)); }
            }
          }
        }
        console.groupEnd();
        return { staff: allStaff, guests: allGuests, tickets: allTickets };
      },
      cloudReport: () => {
        const guests   = this.cloud.listActiveGuests();
        const tickets  = this.cloud.listActiveTickets();
        const staff    = this.cloud.listStaffActors();
        const furniture = this.cloud.listPlacedFurniture();
        const dishPools = this.cloud.listDishwarePools();
        const dishBatches = this.cloud.listDishwasherBatches();
        console.group("[cozyBistro.cloudReport]");
        console.log(`Active guests:  ${guests.length} row(s)`);
        if (guests.length)   console.table(guests);
        console.log(`Active tickets: ${tickets.length} row(s)`);
        if (tickets.length)  console.table(tickets);
        console.log(`Staff actors:   ${staff.length} row(s)`);
        if (staff.length)    console.table(staff);
        console.log(`Placed furniture: ${furniture.length} row(s)`);
        if (furniture.length) console.table(furniture);
        console.log(`Dishware pools:   ${dishPools.length} row(s)`);
        if (dishPools.length) console.table(dishPools);
        console.log(`Dishwasher batches: ${dishBatches.length} row(s)`);
        if (dishBatches.length) console.table(dishBatches);
        console.log("Flags:", featureFlags);
        console.groupEnd();
        return { guests, tickets, staff, furniture, dishPools, dishBatches };
      },
      get featureFlags() { return featureFlags; },
    };
    window.addEventListener("resize", this.handleResize);
  }

  /** Update every placed interior doorway's panel — open when any
   * guest or staff member is close enough to walk through, closed
   * otherwise. Cheap: walks the registry once, the actor list once
   * per door, and only mutates panels that actually changed (via the
   * scene's lerp). */
  private updateInteriorDoorways(dt: number): void {
    const items = this.registry.snapshotItems();
    const doors: { uid: string; model: THREE.Object3D; open: boolean }[] = [];
    if (items.length === 0) {
      this.scene.updateInternalDoors(doors, dt);
      return;
    }
    // Snapshot every walkable actor's ground position + which floor
    // they're standing on. SKIP pinned guests (waiting for a seat,
    // seated, eating, on the toilet, etc.) — they're stationary by
    // intent and shouldn't make a nearby door flap open. Only actors
    // actually walking somewhere can "want" to pass through a door.
    // The floor is derived from the character's model Y so a guest
    // on Floor 1 can't open a Floor 0 door directly below them.
    const storeyH = WorldScene.getStoreyHeight();
    const floorOf = (root: THREE.Object3D): number => {
      const f = Math.round(root.position.y / storeyH);
      return Math.max(0, Math.min(WorldScene.getNumStoreys() - 1, f));
    };
    const positions: { x: number; z: number; floor: number }[] = [];
    if (this.spawner) {
      for (const g of this.spawner.snapshotMovable()) {
        if (g.pinned) continue;
        positions.push({
          x: g.character.groundPos.x,
          z: g.character.groundPos.y,
          floor: floorOf(g.character.root),
        });
      }
    }
    if (this.router) {
      for (const s of this.router.snapshotStatus()) {
        positions.push({
          x: s.character.groundPos.x,
          z: s.character.groundPos.y,
          floor: floorOf(s.character.root),
        });
      }
    }
    if (this.errand) {
      for (const h of this.errand.snapshotStatus()) {
        positions.push({
          x: h.character.groundPos.x,
          z: h.character.groundPos.y,
          floor: floorOf(h.character.root),
        });
      }
    }
    // Per-door trigger zone: a thin corridor along the door's local
    // passage axis. In the door's local frame:
    //   |local_x| < PANEL_HALF   → inside the door's own column along
    //                              the wall (an actor walking parallel
    //                              to the wall on a neighbouring cell
    //                              has |local_x| ≥ 1 and is excluded)
    //   |local_z| < PASSAGE_HALF → within the door cell + the two
    //                              passage cells (one tile on each
    //                              side that an actor would actually
    //                              step on to enter)
    // The previous radius-1.5 check fired for any actor in a 3-tile
    // bubble — including waiting customers on adjacent chairs.
    const PASSAGE_HALF = 1.4;
    const PANEL_HALF   = 0.5;
    for (const it of items) {
      if (it.defId !== "int-doorway") continue;
      const cosR = Math.cos(it.rotY);
      const sinR = Math.sin(it.rotY);
      const doorFloor = it.floor ?? 0;
      let open = false;
      for (const p of positions) {
        // Cross-floor characters can't trigger this door. Without
        // this filter a guest walking on Floor 1 would flap the
        // door panel of any Floor 0 door with the same XZ — the
        // visible "doors twitching from people who can't reach
        // them" bug.
        if (p.floor !== doorFloor) continue;
        const dx = p.x - it.x;
        const dz = p.z - it.z;
        // Project the actor's offset into the door's local frame
        // (inverse Y-axis rotation by rotY). local_x runs along the
        // door's wall panel; local_z runs through the doorway.
        const localX = cosR * dx - sinR * dz;
        const localZ = sinR * dx + cosR * dz;
        if (Math.abs(localX) < PANEL_HALF && Math.abs(localZ) < PASSAGE_HALF) {
          open = true; break;
        }
      }
      doors.push({ uid: it.uid, model: it.model, open });
    }
    this.scene.updateInternalDoors(doors, dt);
  }

  /** True if any guest/errand/pedestrian is within ~1.5 units of the
   * front door (0, 5). Used to swing it open. */
  private anyoneNearDoor(): boolean {
    const DOOR_X = 0, DOOR_Z = 5, NEAR_SQ = 1.5 * 1.5;
    const check = (x: number, z: number) => {
      const dx = x - DOOR_X, dz = z - DOOR_Z;
      return dx * dx + dz * dz <= NEAR_SQ;
    };
    if (this.spawner) {
      for (const g of this.spawner.snapshotMovable()) {
        if (check(g.character.groundPos.x, g.character.groundPos.y)) return true;
      }
    }
    if (this.pedestrians) {
      for (const p of this.pedestrians.snapshotMovable()) {
        if (check(p.character.groundPos.x, p.character.groundPos.y)) return true;
      }
    }
    if (this.sharedPedestrians) {
      for (const p of this.sharedPedestrians.snapshotMovable()) {
        if (check(p.character.groundPos.x, p.character.groundPos.y)) return true;
      }
    }
    if (this.errand) {
      for (const h of this.errand.snapshotStatus()) {
        if (check(h.character.groundPos.x, h.character.groundPos.y)) return true;
      }
    }
    return false;
  }

  /** Build a fresh status-bubble list from the routers' + spawner's
   * current state. One entry per actor; empty label = no bubble.
   * In exterior mode (camera zoomed out past 40%) we suppress every
   * bubble — the building reads as a closed exterior, no peeking at
   * the staff/guest status from outside. */
  private updateStatusBubbles(): void {
    if (this.scene.isExteriorMode()) {
      this.statusBubbles.update([]);
      return;
    }
    const entries: StatusEntry[] = [];
    if (this.router) {
      const snap = this.router.snapshotStatus();
      snap.forEach((s, i) => {
        entries.push({ key: `${s.role}-${i}`, character: s.character, label: s.label });
      });
    }
    if (this.errand) {
      this.errand.snapshotStatus().forEach((s, i) => {
        entries.push({ key: `errand-${i}`, character: s.character, label: s.label, bg: "rgba(80, 50, 90, 0.85)" });
      });
    }
    if (this.spawner) {
      this.spawner.snapshotStatus().forEach((s) => {
        entries.push({
          key: `guest-${s.id}`,
          character: s.character,
          label: s.label,
          // Red flash for guests about to leave angry; green for eating.
          bg: s.panic
            ? "rgba(160, 40, 40, 0.9)"
            : (s.label.startsWith("🍴") ? "rgba(50, 110, 60, 0.85)" : undefined),
        });
      });
    }
    // Phase 8.1 — When a visit is active, also include the visited
    // restaurant's status bubbles so the visitor sees the same chef
    // cook-recipe labels, waiter delivery badges, errand boy trip
    // phases, and guest patience countdowns the host sees on their
    // own restaurant. The host's own characters are typically
    // off-camera during a visit (worldRoot offset shifts to the
    // visited plot), so the local entries collected above render
    // far from the active view and don't visually clutter the visit.
    if (this.visitMode.isVisiting()) {
      for (const entry of this.visitMode.snapshotBubbles()) {
        entries.push(entry);
      }
    }
    this.statusBubbles.update(entries);
  }

  /** Current X-coords of doors sitting on the front wall (z=5.5). The
   * scene rebuilds its front-wall geometry from this list so each door
   * visibly punches a 1-tile gap with a lintel above. Looks up by
   * CATEGORY so all door variants (the procedural one, Kenney
   * doorways, wall doorways, etc.) count, not just the "door" id. */
  // frontWallDoorXs removed — every door + window in the perimeter
  // now flows through allPerimeterOpenings below.

  /** Bucket every door (one wall) AND every window (any wall) by which
   * perimeter wall they sit on. Walls are at z = ±(min/max) / x = ±
   * for front / back / left / right respectively; an item within 0.1
   * of one of those coords belongs to that wall. Windows can live on
   * any perimeter wall; real doors stay confined to the front wall as
   * before. */
  private allPerimeterOpenings(excludeUid: string | null = null): Map<number, { front: { doors: number[]; windows: number[] }; back: { doors: number[]; windows: number[] }; left: { doors: number[]; windows: number[] }; right: { doors: number[]; windows: number[] } }> {
    const out = new Map<number, { front: { doors: number[]; windows: number[] }; back: { doors: number[]; windows: number[] }; left: { doors: number[]; windows: number[] }; right: { doors: number[]; windows: number[] } }>();
    const getFloor = (floor: number) => {
      let entry = out.get(floor);
      if (!entry) {
        entry = {
          front: { doors: [], windows: [] },
          back:  { doors: [], windows: [] },
          left:  { doors: [], windows: [] },
          right: { doors: [], windows: [] },
        };
        out.set(floor, entry);
      }
      return entry;
    };
    for (const it of this.registry.snapshotItems()) {
      // Skip the door / window currently floating with the player's
      // cursor during a move so the wall fills back in at its old
      // position. BuildMenu fires onWindowRemoved on pickup with
      // heldUid set, and onWindowPlaced on drop with heldUid cleared.
      if (excludeUid && it.uid === excludeUid) continue;
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "door") continue;
      const isWindow = def.id.startsWith("window");
      const floor = getFloor(it.floor);
      // Front wall (z = 5.5).
      if (Math.abs(it.z - 5.5) < 0.1) {
        if (isWindow) floor.front.windows.push(it.x);
        else floor.front.doors.push(it.x);
        continue;
      }
      // Back wall (z = -4.5) — only windows live here today.
      if (Math.abs(it.z + 4.5) < 0.1) {
        if (isWindow) floor.back.windows.push(it.x);
        continue;
      }
      // Left wall (x = -4.5) — axis is Z.
      if (Math.abs(it.x + 4.5) < 0.1) {
        if (isWindow) floor.left.windows.push(it.z);
        continue;
      }
      // Right wall (x = 5.5).
      if (Math.abs(it.x - 5.5) < 0.1) {
        if (isWindow) floor.right.windows.push(it.z);
        continue;
      }
    }
    return out;
  }

  /** Wipe the active save slot and reload. Asks for confirmation since
   * this is destructive. */
  /** Mount the persistent bottom-left chat panel. Idempotent — the
   * panel is created once per Engine lifetime, after auth completes,
   * because it subscribes to the chat_message table during
   * construction and that table is only populated after the cloud's
   * initial subscription lands.
   *
   * Defensive: if the cloud isn't ready yet (initial subscription
   * still in flight) we retry on a short delay. That covers the
   * race where enterGame fires after a successful login but before
   * the subscription's onApplied has populated the table cache. */
  private mountChatPanel(container: HTMLElement): void {
    if (this.chatPanel) return;
    if (!this.cloud.isReady()) {
      // Subscribe so we mount the moment the cloud finishes its
      // initial wire-up. Also schedule a fallback timer so we
      // mount even if subscribe(...) never fires (offline mode,
      // SDK quirk). 2-second floor is generous — once it fires
      // the idempotent guard at the top stops a double-mount.
      const tryMount = (): void => {
        if (this.chatPanel) return;
        if (!this.cloud.isReady()) return;
        this.mountChatPanel(container);
        unsub();
      };
      const unsub = this.cloud.subscribe(tryMount);
      window.setTimeout(tryMount, 2000);
      return;
    }
    try {
      this.chatPanel = new ChatPanel(container, this.cloud);
      this.chatPanel.onMessageSent = () => this.game.bumpPlayerCounter("chatsSent");
      makeDraggableResizable({
        storageKey: "cozy-bistro.panel.chat.v4", // v3→v4 (2026-06-27): drop stale collapsed-height layouts
        root: this.chatPanel.root,
        handle: this.chatPanel.titleBar,
        collapseSentinel: this.chatPanel.body,
        expandDirection: "up", // bottom-anchored — grow up when expanded
        // Bumped from 200×32 → 260×220 so the user can't drag the
        // chat down to a strip where the input + Send button get
        // squashed (the in-game screenshot showed it ~200×80, with
        // "Be the first to say hello!" barely fitting).  The 32 px
        // minH only applied to the collapsed title bar, but the
        // resize handles enforce it ALWAYS — so a player who
        // happens to drag the south edge ends up with an unusable
        // chat.  Collapsing via the ▾ button still hides the body
        // entirely via display:none, independent of this resize min.
        minWidth: 260,
        minHeight: 220,
      });
    } catch (e) {
      console.warn("[Engine] failed to mount chat panel:", e);
    }
    // Player roster panel — small presence list under CameraControls.
    // Same mount gating (needs the cloud's initial subscription so
    // auth_record + player tables are populated). Failure is logged
    // and ignored: the roster is informational, not blocking.
    try {
      if (!this.rosterPanel) {
        this.rosterPanel = new PlayerRosterPanel(container, this.cloud);
      }
    } catch (e) {
      console.warn("[Engine] failed to mount roster panel:", e);
    }
  }

  /** Has the one-time seamless-reload veil already run? Guards against a
   * second enterGame (e.g. re-entry after the BuildingPickModal) stacking
   * another veil. */
  private seamlessRevealStarted = false;

  /** Seamless reload — overlay a loading veil and keep it up until the
   * server snapshot has been applied to staff + guests, then lift it.
   * Without this the player watches everyone start at default positions
   * and walk into place while the once-per-second hydrate (the boot retry
   * loop) catches up. ALWAYS lifts (finally) and is bounded by a timeout,
   * so a slow / missing snapshot degrades to the old catch-up behaviour
   * rather than a stuck screen. */
  private async revealWhenHydrated(): Promise<void> {
    if (this.seamlessRevealStarted) return;
    this.seamlessRevealStarted = true;
    const veil = this.showLoadingVeil();
    try {
      // Wait until the snapshot can actually be applied: furniture
      // restored (so seats exist — importing seated guests before that
      // walks the whole room out, see furnitureCloudReady), plus the staff
      // router + guest spawner constructed with a live cloud context.
      // Polled with wall-clock-bounded backoff (~5s) so it never hangs.
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        // Wait for the staff_actor rows to ACTUALLY be in the subscription
        // cache, not merely for a restaurant id — lifting the veil before
        // they land shows the default spawn positions, and hydrate would
        // latch on the empty answer and never re-apply.
        if (this.furnitureCloudReady && this.router && this.spawner
            && this.cloud.hasRestaurantContext()
            && this.cloud.listStaffActors().length > 0) break;
        await new Promise<void>((r) => { window.setTimeout(r, 80); });
      }
      // Apply it now — idempotent (once-latched, so the retry loop's later
      // calls no-op). Snaps staff to their server positions AND pushes them
      // out of any furniture they were parked in; seats guests onto their
      // seats. The guest snap stays gated on furnitureCloudReady to avoid
      // the "no seats yet → everyone walks out" race.
      this.router?.hydrateFromCloud();
      this.errand?.hydrateFromCloud();
      if (this.furnitureCloudReady) await this.spawner?.hydrateFromCloud();
      // Let the game loop paint a few frames so the snapped + pushed-out
      // transforms are actually on screen before we uncover the scene.
      // setTimeout (not rAF) so a backgrounded tab can't strand the veil.
      await new Promise<void>((r) => { window.setTimeout(r, 180); });
    } catch (e) {
      console.warn("[Engine] seamless-reveal hydrate failed:", e);
    } finally {
      veil.remove();
    }
  }

  /** Full-screen "Setting up your restaurant…" overlay used by
   * {@link revealWhenHydrated}. Sits above all game chrome (modals are
   * <=1500) and fades itself out on remove(). */
  private showLoadingVeil(): { remove: () => void } {
    if (!document.getElementById("cb-veil-style")) {
      const s = document.createElement("style");
      s.id = "cb-veil-style";
      s.textContent = "@keyframes cb-veil-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(s);
    }
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed", inset: "0", zIndex: "99999",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: "14px",
      background: "#1b1410", color: "#fff5dc",
      font: "16px/1.4 system-ui, sans-serif",
      transition: "opacity 280ms ease", opacity: "1",
    } as Partial<CSSStyleDeclaration>);
    const spinner = document.createElement("div");
    Object.assign(spinner.style, {
      width: "34px", height: "34px",
      border: "3px solid rgba(255,245,220,0.2)",
      borderTopColor: "#e8c89a", borderRadius: "50%",
      animation: "cb-veil-spin 0.8s linear infinite",
    } as Partial<CSSStyleDeclaration>);
    const label = document.createElement("div");
    label.textContent = "Setting up your restaurant…";
    label.style.opacity = "0.85";
    el.appendChild(spinner);
    el.appendChild(label);
    document.body.appendChild(el);
    let removed = false;
    return { remove: () => {
      if (removed) return;
      removed = true;
      el.style.opacity = "0";
      window.setTimeout(() => el.remove(), 300);
    } };
  }

  /** Spawn the LoginModal AND start polling to see if the connecting
   * identity is already authenticated (returning player). On
   * authenticated, check building ownership — players who haven't
   * picked a plot yet see the BuildingPickModal next; players with
   * a plot enter the game immediately. */
  private installAuthGate(container: HTMLElement): void {
    // didClaim=true means the player JUST claimed via the picker
    // (one-time starter cash bonus applies). didClaim=false means
    // a returning player whose plot was already on file (no bonus
    // — they already got it on the original claim).
    const enterGame = (didClaim: boolean): void => {
      // Phase I (H.98) — Belt-and-suspenders guard. afterAuth's
      // ready() check is supposed to prevent entry without a
      // Restaurant + Building, but if the player ever lands here
      // with no Restaurant row (auth race, stale cache, future
      // refactor regression), force the modal instead of starting
      // a local-only ghost session that can't sync. The user's
      // localStorage still has data; once they claim, the H.75
      // furniture backfill + similar pushes will mirror it up.
      //
      // didClaim=true means the modal JUST resolved — the
      // claim_building reducer has acknowledged but the cloud
      // subscription may not have echoed the new Restaurant row
      // yet. Poll for up to 5s before falling back to the modal so
      // we don't re-show it for a network round-trip.
      if (this.cloud.getMyRestaurantId() == null) {
        if (didClaim) {
          let waited = 0;
          const wait = (): void => {
            waited += 200;
            if (this.cloud.getMyRestaurantId() != null) {
              enterGame(true);
              return;
            }
            if (waited < 5000) { window.setTimeout(wait, 200); return; }
            console.warn("[Engine] enterGame(didClaim=true): Restaurant row never arrived after 5s — re-showing modal");
            new BuildingPickModal(container, this.cloud, () => enterGame(true));
          };
          window.setTimeout(wait, 200);
          return;
        }
        console.warn("[Engine] enterGame called with no Restaurant on cloud — forcing BuildingPickModal (cache may be stale; try Ctrl+Shift+R if this repeats)");
        new BuildingPickModal(container, this.cloud, () => enterGame(true));
        return;
      }
      const mine = this.cloud.getMyBuilding();
      if (mine) {
        // Per-plot rent multiplier — small 0.6×, medium 1.0×, large 1.4×.
        this.game.plotRentMultiplier =
          mine.kind === "small" ? 0.6 :
          mine.kind === "large" ? 1.4 :
          1.0;
        const bonus = mine.kind === "small" ? 1000 : mine.kind === "medium" ? 1500 : 2000;
        // Phase I (H.97) — Starter grant is RECURRING every 3h, not
        // a one-time-on-claim. didClaim still forces the first grant
        // (so a brand-new player gets opening cash immediately) but
        // subsequent logins check the localStorage cooldown and
        // auto-claim if 3 hours have elapsed since the last one. The
        // timestamp key is host-scoped so cookie-mode (per-tab) and
        // localStorage-mode (cross-tab) both work.
        const GRANT_COOLDOWN_MS = 3 * 60 * 60 * 1000;
        const grantKey = `cozy-bistro-last-grant:${(window.location.host || "local")}`;
        const lastGrantStr = localStorage.getItem(grantKey);
        const lastGrant = lastGrantStr ? parseInt(lastGrantStr, 10) : 0;
        const now = Date.now();
        const cooldownElapsed = (now - lastGrant) >= GRANT_COOLDOWN_MS;
        if (isServerSim("money")) {
          // Anti-cheat B/C — server-authoritative grant: the server owns
          // the cooldown + plot-size amount and credits cloud_money_cents;
          // the client adopts via the restaurant subscription. The reducer
          // no-ops when not due, so no client bookkeeping is needed.
          this.cloud.claimStarterGrant();
        } else if (didClaim || cooldownElapsed) {
          this.game.economy.earnMoney(bonus, "grant");
          // Phase 9.3 — Eager-push the grant to cloud_money_cents.
          // The grant lands BEFORE the first money anchor (the
          // delta-sync baseline is null until the first cloud
          // adoption), so without this push the adoption would
          // overwrite local with the cloud value and silently wipe
          // the grant. Order doesn't matter: if the bump lands
          // before adoption it's included in the adopted value; if
          // after, the onUpdate delta credits it back.
          this.cloud.bumpCloudMoneyCents(Math.round(bonus * 100));
          localStorage.setItem(grantKey, String(now));
          const reason = didClaim ? "fresh claim" : `3h grant (last was ${Math.floor((now - lastGrant) / 3600000)}h ago)`;
          console.log(`[Engine] +$${bonus} starter cash bonus for ${mine.kind} plot — ${reason}`);
          // Floating text so the player sees the bonus land. Same
          // pattern as the existing rating / payment popups.
          try {
            this.floatingText?.pop?.(0, 0, `+$${bonus} grant`, "#ffd966");
          } catch { /* floatingText may not be wired yet on first claim */ }
        } else {
          const hoursLeft = Math.ceil((GRANT_COOLDOWN_MS - (now - lastGrant)) / 3600000);
          console.log(`[Engine] starter grant on cooldown — ${hoursLeft}h to next $${bonus} grant`);
        }
      }
      this.game.setAuthGated(false);
      // Reveal the mobile bottom bar / camera chrome now that login +
      // plot-pick are behind us (no-op on desktop).
      setMobileInGame(true);
      // Seamless reload — hold a loading veil over the scene until the
      // server snapshot has been applied to staff + guests (see
      // revealWhenHydrated), so they're never seen starting at default
      // positions and walking into place. Fire-and-forget; always lifts.
      void this.revealWhenHydrated();
      // Global weather — route the local WeatherSystem to the
      // server's weather_state table. Other clients see the same
      // rain / snow / festival at the same wallclock time. The
      // provider returns null when the cache hasn't landed yet;
      // WeatherSystem falls back to its local default in that
      // case (a brief sunny flash before the first sync).
      this.game.weather.setCloudProvider(() => this.cloud.getCurrentWeatherKind());
      // P8 — spawn the persistent chat panel now that we know the
      // player is authenticated AND the cloud is wired (the panel
      // subscribes to the chat_message table during construction).
      // Constructed at most once per Engine lifetime; idempotent.
      this.mountChatPanel(container);
      // Phase F read-side flip — when isServerSim("furniture") is on
      // AND the cloud has rows for this restaurant, ADOPT those rows
      // as the truth. The JSON save_snapshot loaded a moment ago via
      // game.hydrate gets clobbered for furniture only. Cross-device
      // login: open on phone, see laptop's layout. Async-loads each
      // GLB, settles a few hundred ms later.
      //
      // Safe-by-default: when the flag is off OR the cloud has no
      // furniture rows, no-op. When on but only the local has items
      // (first device claiming this restaurant), the mirror we
      // installed in Phase F will populate the cloud on the next
      // save round-trip, so subsequent logins find data to restore.
      if (featureFlags.furniture) {
        // Restore first, then subscribe — order matters: subscribing
        // before the cache is primed would deliver every existing row
        // as a fresh "insert" event and re-trigger model loads we just
        // did via restoreFromCloud. Awaiting the restore ensures
        // applyCloudInsert's "uid already in items" idempotency guard
        // catches the cache replay.
        //
        // CRITICAL: await the save's restore FIRST.  Otherwise the two
        // async operations race — and because cloud restore is faster
        // (no GLB loads), it finishes first, then the save's restore
        // finishes second and clobbers the cloud's fresh state.  That
        // race was the cause of the "move a table, refresh, position
        // reverts" bug.  Sequencing here makes cloud authoritative.
        const saveDone = this.furnitureRestorePromise ?? Promise.resolve();
        void saveDone.then(() => this.registry.restoreFromCloud()).then(() => {
          // Phase 9.49 — restoreFromCloud WIPED + rebuilt every furniture
          // model as a fresh instance (it's authoritative on reload), so
          // the lamps registered after the save-restore now point at
          // detached models and the new cloud lamp models are
          // unregistered — dark at night. This is the recurring "lights
          // off when I reload at night" bug. Reset the lamp registry and
          // re-register from the fresh cloud items so night illumination
          // resumes. (The save-restore path does the same at the top of
          // setupRunningGame; cloud restore never did.)
          this.scene.clearAllLamps();
          for (const it of this.registry.snapshotItems()) {
            const def = getFurnitureDef(it.defId);
            if (def?.category === "lamp") this.scene.registerLamp(it.model);
          }
          this.registry.subscribeToCloudChanges();
        }).finally(() => {
          // Phase 9.5 — unblock the guest hydrate/bridge retry loop.
          // Importing seated guests BEFORE the furniture registry has
          // seats made refreshSeatedGuestPoses think every table was
          // sold and walk the whole dining room out the door (the
          // "everyone wanders, nobody sits" bug). .finally so a
          // restore failure degrades to the size-0 guard inside
          // refreshSeatedGuestPoses instead of an empty restaurant.
          this.furnitureCloudReady = true;
        });
      } else {
        // Furniture flag off — local save is the only furniture
        // source and it's already restored; guests may hydrate.
        this.furnitureCloudReady = true;
      }
      // Phase E read-side flip — when isServerSim("dishware") is on,
      // adopt the cloud's pool + dishwasher_batch rows as the truth.
      // Same ordering as furniture: restore (synchronous — no GLB
      // loads, just Map writes) then subscribe so the cache replay
      // hits the idempotency guard in applyPoolRow.
      if (featureFlags.dishware) {
        this.game.dishware.restoreFromCloud();
        this.game.dishware.subscribeToCloudChanges();
      }
      // Phase I.1 (H.48d) — same pattern for pantry.  H.36 pantry
      // mirror gives the server live counts (incl. H.41 restock during
      // offline); save's ingredient list might be stale.  Cloud wins
      // post-load — pantry counts get reconciled to whatever the
      // server has.
      this.game.cooking.restorePantryFromCloud();
      // Render the rest of the city — every OTHER player's plot
      // gets a small Greek-Island shell so the world reads as
      // multiplayer even before we ship per-other-restaurant
      // interiors. Re-poll the cache for a couple of seconds in
      // case the building list lands after the auth_record one.
      this.refreshCityBuildings();
      // Pre-compile shaders for hidden storeys + roof so the first
      // click on Floor 1+ doesn't stall the renderer compiling fresh
      // material programs on the reveal frame. renderer.compile() can
      // burn 50-300 ms walking the scene graph, so we schedule it via
      // requestIdleCallback — the browser picks a frame when the main
      // thread is idle and the player never feels the cost. The
      // setTimeout fallback covers Safari + old browsers without
      // requestIdleCallback. A 2 s timeout cap makes sure the compile
      // happens even if the page never goes idle (e.g. a frantic
      // first session). Missed materials on later tier upgrades are
      // caught on the next floor click anyway (second reveal is
      // already cached so it's fast).
      const runPrecompile = (): void => {
        this.scene.precompileShaders(this.renderer, this.camera.threeCamera);
      };
      type IdleCB = (cb: () => void, opts?: { timeout: number }) => number;
      const ric = (window as unknown as { requestIdleCallback?: IdleCB }).requestIdleCallback;
      if (typeof ric === "function") ric(runPrecompile, { timeout: 2000 });
      else window.setTimeout(runPrecompile, 0);
      // First-visit welcome pop. Deferred to here (instead of the
      // Engine constructor) so it can't flash for a moment behind
      // the login modal on a cold load. Only first-time players
      // see it; the modal sets a localStorage flag on dismiss.
      if (!HelpModal.hasBeenSeen()) {
        // Small delay so the welcome lands AFTER the auth-modal
        // dismiss animation (which has its own ~600 ms tail) — that
        // way they don't visually stack.
        window.setTimeout(() => {
          if (!HelpModal.hasBeenSeen()) this.helpModal.show();
        }, 800);
      }
    };
    const afterAuth = (): void => {
      // Auth complete. The game stays auth-gated until BOTH a plot
      // is owned AND a Restaurant row exists on the cloud — without
      // either, the world has nothing to render against.
      //
      // Phase I (H.96) — Pre-H.96 only the building was checked,
      // and the client silently auto-created a Restaurant in
      // onSubscriptionReady. After a wipe / partial migration that
      // could leave the user in a "has Building but no Restaurant"
      // (or inverse) state with no UI prompt to recover. Now
      // claim_building atomically creates the Restaurant, and the
      // modal shows when EITHER is missing.
      const ready = (): boolean =>
        this.cloud.getMyBuilding() !== null
        && this.cloud.getMyRestaurantId() !== null;
      // A big restaurant's building + restaurant rows can take well over the
      // old 3s grace to land. Previously we showed the picker and STOPPED —
      // which stranded a RETURNING player on "pick a building" even though
      // their restaurant existed (they had to back/forward to clear it). Now:
      // poll indefinitely; show the picker only after a longer grace; and
      // AUTO-DISMISS it the instant the rows arrive. A genuinely new player
      // claims a plot (doEnter(true)); the `entered` latch then stops the poll.
      let pickModal: BuildingPickModal | null = null;
      let entered = false;
      const doEnter = (didClaim: boolean): void => {
        if (entered) return;
        entered = true;
        pickModal?.destroy();
        pickModal = null;
        enterGame(didClaim);
      };
      if (ready()) { doEnter(false); return; }
      let waited = 0;
      const GRACE_MS = 6000;
      const wait = (): void => {
        if (entered) return;
        waited += 250;
        if (ready()) { doEnter(false); return; }
        if (waited >= GRACE_MS && !pickModal) {
          // claim_building auto-creates the Restaurant atomically (H.96), so
          // the modal's completion means both rows now exist. enterGame(true)
          // triggers the starter cash bonus.
          pickModal = new BuildingPickModal(container, this.cloud, () => doEnter(true));
        }
        window.setTimeout(wait, 250);
      };
      window.setTimeout(wait, 250);
    };

    // Pre-build the modal HIDDEN so the silent detection window below
    // can decide whether the player is already authenticated. If
    // they are, the modal is destroyed without ever being shown —
    // no "login screen flashes on reload" anymore. If they're not,
    // we reveal it after the timeout.
    const modal = new LoginModal(container, this.cloud, () => afterAuthOnce(), /* startHidden */ true);

    // afterAuth must run exactly once — both the manual-login path
    // (modal's onAuthenticated callback) and the silent-detection
    // path (subscription listener below) can race to invoke it
    // when login completes. Without this guard the second caller
    // would re-enter the game and trample the in-flight state set
    // by the first.
    let didAfterAuth = false;
    const afterAuthOnce = (): void => {
      if (didAfterAuth) return;
      didAfterAuth = true;
      try { unsub?.(); } catch { /* ignore */ }
      window.clearTimeout(timer);
      afterAuth();
    };

    // Already authenticated synchronously (cache hot, common path
    // when the page reloads and the token deserializes immediately).
    if (this.cloud.isAuthenticated()) {
      modal.destroy();
      afterAuthOnce();
      return;
    }

    // Otherwise wait for the auth_record cache to land. Subscribe to
    // the cloud's table-change notifications and KEEP listening even
    // after the modal is shown — slow connections / cold maincloud
    // can take >5s for the auth_record row to land, and we want a
    // late arrival to auto-dismiss the modal instead of forcing the
    // already-logged-in player to type credentials again. The 8s
    // patience window (was 3s) just controls when the modal becomes
    // visible if we haven't detected auth by then.
    let timer = 0;
    const unsub: () => void = this.cloud.subscribe(() => {
      if (didAfterAuth) return;
      if (this.cloud.isAuthenticated()) {
        modal.destroy();
        afterAuthOnce();
      }
    });
    timer = window.setTimeout(() => {
      if (!didAfterAuth) modal.show();
    }, 8000);
  }

  /** Read the current building list from SpacetimeDB and have
   * WorldScene render placeholder shells for every OTHER player's
   * plot. Called once on auth complete; can be called again later
   * when buildings update (other players claim a plot, etc.).
   * Cheap — the WorldScene rebuild wipes + re-adds the small group.
   *
   * Re-polls for ~5 s after the first call so a slow cache fill
   * still gets picked up. Each poll only does work if the building
   * count changed since the previous pass. */
  private cityBuildingCount = -1;
  /** Cached player-plot id so the 5 Hz HUD doesn't re-iterate the
   * building table every tick to find the player's own plot.
   * Refreshed in refreshCityBuildings when the building count
   * changes (claim landing / releasing). */
  private cachedMyPlotId: bigint | null = null;
  private refreshCityBuildings(): void {
    const apply = (): void => {
      const list = this.cloud.listBuildings();
      if (list.length === this.cityBuildingCount) return;
      this.cityBuildingCount = list.length;
      // Enrich each building with the owner's display name so the
      // visit overlay can show "Visit Alice's Restaurant" instead of
      // raw identity hex. Lookup is via the auth_record cache.
      const accounts = this.cloud.listAccounts();
      const enriched = list.map((b) => {
        const acct = accounts.find((a) => a.identity.toHexString() === b.ownerIdentity.toHexString());
        return { ...b, ownerName: acct?.displayName ?? "" };
      });
      this.scene.populateCityBuildings(enriched);
      const mine = this.cloud.getMyBuilding();
      this.cachedMyPlotId = mine?.id ?? null;
      if (mine) {
        // Shift the shared city so the player's claimed plot
        // appears at the camera's local origin. From a shared-map
        // perspective the player IS at (mine.plotX, mine.plotZ) —
        // every other client renders the same absolute layout, just
        // with a different worldRoot offset under their own
        // restaurant.
        this.scene.setOwnedPlotOffset(mine.plotX, mine.plotZ);
      }
    };
    apply();
    // Poll for 5s to catch a late cache fill.
    let waited = 0;
    const stepMs = 500;
    const tick = (): void => {
      waited += stepMs;
      apply();
      if (waited < 5000) window.setTimeout(tick, stepMs);
    };
    window.setTimeout(tick, stepMs);
  }

  /** P5.8 — bottom-right toast: "👀 [Name] is visiting your restaurant".
   * Auto-fades after 5 s. Stacks if multiple land in quick succession
   * (each toast pushes the previous one upward via DOM flow).
   * Container is the same #app the rest of the UI lives in so the
   * toast doesn't survive a page navigation. */
  private showVisitToast(visitorName: string): void {
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      background: "rgba(20, 14, 10, 0.94)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.55)",
      borderRadius: "10px",
      padding: "10px 14px",
      font: "13px/1.3 system-ui, sans-serif",
      boxShadow: "0 4px 18px rgba(0, 0, 0, 0.45)",
      zIndex: "30",
      pointerEvents: "auto",
      maxWidth: "280px",
      opacity: "0",
      transition: "opacity 200ms ease-out",
    } as Partial<CSSStyleDeclaration>);
    toast.innerHTML = `👀 <b>${escapeHtmlForToast(visitorName)}</b> is visiting your restaurant`;
    this.container.appendChild(toast);
    // Fade-in next frame so the transition fires.
    requestAnimationFrame(() => { toast.style.opacity = "1"; });
    // Fade-out + remove after 5 s.
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 250);
    }, 5000);
  }

  /** Build the Graphics-quality picker row near the bottom of the
   * sidebar. Three radio-style buttons (Low / Medium / High) flip
   * the saved preset; the engine re-applies pixel ratio + shadow
   * settings immediately so the player can preview the change
   * without reloading.
   *
   * Layout: small "🖥 Graphics" header + three pill buttons in a
   * row. Active button highlighted. The chosen value is persisted
   * via setSavedGraphicsQuality so the next session boots on the
   * right preset. */
  private installGraphicsSection(): void {
    this.sidebar.addSeparator();
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      display: "flex", flexDirection: "column", gap: "4px",
      marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    const header = document.createElement("div");
    header.textContent = "🖥 GRAPHICS";
    Object.assign(header.style, {
      fontSize: "10px", fontWeight: "700",
      letterSpacing: "0.06em", opacity: "0.7",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(header);
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(row);
    const buttons: { q: GraphicsQuality; btn: HTMLButtonElement }[] = [];
    const TIERS: { q: GraphicsQuality; label: string; tooltip: string }[] = [
      { q: "low", label: "Low",
        tooltip: "Best performance. 1× pixel ratio, no dynamic shadows, " +
                 "no furniture shadows. Use on laptops with integrated " +
                 "GPUs or when other tabs are hogging the system." },
      { q: "medium", label: "Medium",
        tooltip: "Balanced (default). 1.5× pixel ratio, dynamic sun shadows on, " +
                 "furniture casts shadows. Recommended for most setups." },
      { q: "high", label: "High",
        tooltip: "Best visuals. 2× pixel ratio, dynamic sun shadows on, " +
                 "furniture casts shadows. Use on a desktop GPU." },
    ];
    const refresh = (): void => {
      const cur = this.getGraphicsQuality();
      for (const b of buttons) {
        const active = b.q === cur;
        b.btn.style.background = active
          ? "rgba(255, 210, 120, 0.35)"
          : "rgba(120, 180, 200, 0.14)";
        b.btn.style.borderColor = active
          ? "rgba(255, 220, 150, 0.75)"
          : "rgba(255,245,220,0.20)";
        b.btn.style.fontWeight = active ? "700" : "600";
      }
    };
    for (const tier of TIERS) {
      const btn = document.createElement("button");
      btn.textContent = tier.label;
      btn.title = tier.tooltip;
      Object.assign(btn.style, {
        flex: "1",
        padding: "5px 4px",
        background: "rgba(120, 180, 200, 0.14)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.20)",
        borderRadius: "4px", cursor: "pointer",
        font: "inherit", fontSize: "11px", fontWeight: "600",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => {
        this.applyGraphicsQuality(tier.q);
        refresh();
      };
      row.appendChild(btn);
      buttons.push({ q: tier.q, btn });
    }
    refresh();

    // === Phase I — FPS cap + show-FPS controls (same section) ===
    const fpsRow = document.createElement("div");
    Object.assign(fpsRow.style, {
      display: "flex", gap: "6px", alignItems: "center",
      marginTop: "6px", fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    const fpsLabel = document.createElement("span");
    fpsLabel.textContent = "FPS cap";
    Object.assign(fpsLabel.style, { opacity: "0.8" } as Partial<CSSStyleDeclaration>);
    fpsLabel.title =
      "Pin the frame rate so your GPU / fan don't push higher than you need.\n" +
      "• Unlimited — runs at your display's native refresh (default).\n" +
      "• 30 / 60 / 75 / 120 / 144 — caps at the chosen rate.";
    fpsRow.appendChild(fpsLabel);
    const fpsSelect = document.createElement("select");
    Object.assign(fpsSelect.style, {
      flex: "1",
      padding: "3px 4px",
      background: "rgba(120, 180, 200, 0.14)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.20)",
      borderRadius: "4px", cursor: "pointer",
      font: "inherit", fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    for (const cap of FPS_CAP_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = cap === null ? "none" : String(cap);
      opt.textContent = cap === null ? "Unlimited" : `${cap} fps`;
      if (cap === this.fpsCap) opt.selected = true;
      fpsSelect.appendChild(opt);
    }
    fpsSelect.onchange = () => {
      const v = fpsSelect.value;
      this.setFpsCap(v === "none" ? null : parseInt(v, 10));
    };
    fpsRow.appendChild(fpsSelect);
    wrap.appendChild(fpsRow);

    const showRow = document.createElement("label");
    Object.assign(showRow.style, {
      display: "flex", gap: "6px", alignItems: "center",
      marginTop: "4px", cursor: "pointer", fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    showRow.title = "Toggle a small live frame-rate badge in the top-right corner.";
    const showChk = document.createElement("input");
    showChk.type = "checkbox";
    showChk.checked = this.showFps;
    showChk.onchange = () => this.setShowFps(showChk.checked);
    showRow.appendChild(showChk);
    const showLab = document.createElement("span");
    showLab.textContent = "Show FPS counter";
    showRow.appendChild(showLab);
    wrap.appendChild(showRow);

    this.sidebar.body.appendChild(wrap);

    // Build the FPS badge lazily on demand.  When showFps starts true
    // (restored from localStorage), unhide it right away.
    if (this.showFps) this.setShowFps(true);
  }

  /** Phase I (H.68) — enter waiter-rest-spot placement mode.  Shows
   * a banner with instructions, captures the next canvas click, and
   * raycasts against the focused storey's floor plane to derive
   * world-local x/z.  Bails on Escape or click-outside-canvas.
   *
   * Capture-phase listener so we win over CameraControls (which
   * also listens on the canvas).  Removed in `cleanup()` regardless
   * of how the mode exits. */
  private enterWaiterRestPlacement(): void {
    if (this.waiterRestPlacementActive) return; // re-entry guard
    this.waiterRestPlacementActive = true;
    // Banner explaining what to do.
    const banner = document.createElement("div");
    Object.assign(banner.style, {
      position: "fixed", top: "12px", left: "50%",
      transform: "translateX(-50%)",
      padding: "8px 14px",
      background: "rgba(20, 14, 10, 0.92)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      fontWeight: "600",
      border: "1px solid #d8b98f",
      borderRadius: "6px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
      zIndex: "10001",
      pointerEvents: "none",
    } as Partial<CSSStyleDeclaration>);
    banner.textContent = "📍 Move over a floor tile, then click to set the waiter rest spot — ESC to cancel";
    this.container.appendChild(banner);

    const canvas = this.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    // Phase 9.33 — live tile highlight that follows the cursor so the
    // player can SEE which tile they're aiming at before committing. A
    // translucent disc + bright ring lying flat on the focused storey,
    // tile-snapped (floor + 0.5) so it reads as a discrete tile. Parented
    // to worldRoot so its position is in restaurant-local space (matches
    // the coords we hand setWaiterRestSpot).
    const preview = this.makeTilePreview();
    this.scene.worldRoot.add(preview.group);
    preview.group.visible = false;

    // Raycast the cursor to the focused storey's floor plane → tile-
    // snapped restaurant-local x/z, or null ONLY when the ray misses the
    // plane (e.g. aimed above the horizon). NO bounds check here — the
    // highlight should still show (tinted) when you hover outside the
    // building, not vanish.
    const floorHit = (clientX: number, clientY: number): { x: number; z: number; floor: number; planeY: number } | null => {
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera.threeCamera);
      const focused = this.scene.getFocusedStorey();
      const planeY = focused * WorldScene.getStoreyHeight();
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
      const hitWorld = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, hitWorld)) return null;
      // World → restaurant-local (subtract worldRoot's city-shift), then
      // snap to the tile centre so the highlight + the saved spot align.
      const x = Math.floor(hitWorld.x - this.scene.worldRoot.position.x) + 0.5;
      const z = Math.floor(hitWorld.z - this.scene.worldRoot.position.z) + 0.5;
      return { x, z, floor: focused, planeY };
    };
    // Whether a tile is inside the focused floor's furniture footprint
    // (+slack). Gates SAVING (an off-map pin strands every waiter walking
    // toward an unreachable tile) and tints the highlight. Mirrors the
    // server's set_waiter_rest_spot guard so the two never disagree.
    const inBounds = (hit: { x: number; z: number; floor: number }): boolean => {
      const b = this.focusedFloorBounds(hit.floor);
      return !b || (hit.x >= b.minX && hit.x <= b.maxX && hit.z >= b.minZ && hit.z <= b.maxZ);
    };

    const cleanup = (): void => {
      this.waiterRestPlacementActive = false;
      canvas.removeEventListener("pointerdown", onCanvasPointer, true);
      canvas.removeEventListener("pointermove", onCanvasMove, true);
      window.removeEventListener("keydown", onKey, true);
      banner.remove();
      this.scene.worldRoot.remove(preview.group);
      preview.dispose();
    };
    const onCanvasMove = (e: PointerEvent): void => {
      const hit = floorHit(e.clientX, e.clientY);
      if (!hit) { preview.group.visible = false; return; }
      preview.group.position.set(hit.x, hit.planeY + 0.05, hit.z);
      preview.setValid(inBounds(hit)); // green inside the building, amber outside
      preview.group.visible = true;
    };
    const onCanvasPointer = (e: PointerEvent): void => {
      // Left-click only.  Right-click would otherwise interfere
      // with the camera's pan/rotate.
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const hit = floorHit(e.clientX, e.clientY);
      // Phase 9.36 — EVERY click exits the mode (calls cleanup). The 9.35
      // "stay active on a bad click" left the placement listeners attached
      // when the player gave up, and this handler stopPropagation()s every
      // left-click — so the whole game silently swallowed clicks until ESC.
      if (!hit) {
        this.floatingText?.pop(0, 1, "📍 No floor there — try again, aim at your restaurant", "#ff8866");
        cleanup();
        return;
      }
      if (!inBounds(hit)) {
        // The highlight was already amber here, so this isn't a surprise.
        this.floatingText?.pop(hit.x, hit.z, "📍 Too far — pick a tile inside your restaurant", "#ff8c44", hit.floor);
        this.spawnPlacementFlash(hit.x, hit.z, hit.planeY, 0xff8c44);
        cleanup();
        return;
      }
      this.cloud.setWaiterRestSpot(hit.x, hit.z, hit.floor);
      this.staffPanel.setWaiterRestStatus({ x: hit.x, z: hit.z, floor: hit.floor });
      this.floatingText?.pop(hit.x, hit.z, `📍 Waiter rest spot set`, "#86ff86", hit.floor);
      // Phase 9.33 — confirmation flash: an expanding, fading ring at the
      // chosen tile so the click visibly "lands". Self-removes; outlives
      // cleanup (which tears down the hover preview).
      this.spawnPlacementFlash(hit.x, hit.z, hit.planeY, 0x86ff86);
      this.sfx?.chime?.();
      cleanup();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cleanup();
      }
    };
    canvas.addEventListener("pointerdown", onCanvasPointer, true);
    canvas.addEventListener("pointermove", onCanvasMove, true);
    window.addEventListener("keydown", onKey, true);
  }

  /** Phase 9.33 — Build a flat tile-highlight: a translucent filled disc
   * under a brighter ring, both lying on the XZ plane. `setValid` tints
   * it green (a valid in-building tile) or amber (out of bounds) so the
   * player gets live placement feedback. Returned with a dispose() that
   * frees the geometries + materials. */
  private makeTilePreview(): { group: THREE.Group; setValid: (valid: boolean) => void; dispose: () => void } {
    const group = new THREE.Group();
    const discGeo = new THREE.CircleGeometry(0.5, 40);
    const discMat = new THREE.MeshBasicMaterial({ color: 0x86ff86, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    const ringGeo = new THREE.RingGeometry(0.48, 0.6, 40);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x86ff86, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    group.add(disc, ring);
    group.renderOrder = 999; // draw over the floor, no depth fighting
    let lastValid = true;
    return {
      group,
      setValid: (valid: boolean): void => {
        if (valid === lastValid) return;
        lastValid = valid;
        const c = valid ? 0x86ff86 : 0xff8c44;
        discMat.color.setHex(c);
        ringMat.color.setHex(c);
      },
      dispose: () => { discGeo.dispose(); discMat.dispose(); ringGeo.dispose(); ringMat.dispose(); },
    };
  }

  /** Phase 9.33 — A one-shot expanding/fading ring at (localX, localZ)
   * on storey-plane Y, parented to worldRoot. Animates ~450ms then
   * removes + disposes itself. Confirms a placement click landed. */
  private spawnPlacementFlash(localX: number, localZ: number, planeY: number, color: number): void {
    const geo = new THREE.RingGeometry(0.3, 0.5, 40);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(localX, planeY + 0.06, localZ);
    ring.renderOrder = 1000;
    this.scene.worldRoot.add(ring);
    const start = performance.now();
    const DUR = 450;
    const step = (): void => {
      const t = (performance.now() - start) / DUR;
      if (t >= 1) {
        this.scene.worldRoot.remove(ring);
        geo.dispose();
        mat.dispose();
        return;
      }
      const s = 1 + t * 2.6;
      ring.scale.set(s, s, s);
      mat.opacity = 0.9 * (1 - t);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Phase 9.35 — axis-aligned bounds of the placed furniture on `floor`,
   * padded by a few tiles, in restaurant-local coords. Used to keep the
   * waiter-rest placement inside the building so an off-map click can't
   * pin an unreachable spot. Returns null when the floor has no furniture
   * (nothing to anchor to → don't restrict). */
  private focusedFloorBounds(floor: number): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let any = false;
    for (const item of this.registry.snapshotItems()) {
      if (item.floor !== floor) continue;
      any = true;
      if (item.x < minX) minX = item.x;
      if (item.x > maxX) maxX = item.x;
      if (item.z < minZ) minZ = item.z;
      if (item.z > maxZ) maxZ = item.z;
    }
    if (!any) return null;
    const M = 3; // tiles of slack so a rest spot just off the furniture still works
    return { minX: minX - M, maxX: maxX + M, minZ: minZ - M, maxZ: maxZ + M };
  }

  /** Latch so re-clicking the Set button while placement is already
   * active doesn't stack two listener sets.  Reset by cleanup(). */
  private waiterRestPlacementActive = false;

  /** Phase I — runtime setter for the FPS cap.  Updates the persisted
   * value, the live cap field, and resets the rolling sample window
   * so the counter doesn't average across the rate change. */
  setFpsCap(cap: number | null): void {
    this.fpsCap = cap;
    setSavedFpsCap(cap);
    this.fpsSamples.length = 0;
  }

  /** Phase I — runtime setter for the FPS badge visibility.  Builds
   * the badge element on first show; toggles `display` on subsequent
   * calls.  Persists the choice so reload doesn't reset it. */
  setShowFps(show: boolean): void {
    this.showFps = show;
    setSavedShowFps(show);
    if (show) {
      if (!this.fpsBadge) {
        this.fpsBadge = document.createElement("div");
        Object.assign(this.fpsBadge.style, {
          position: "fixed",
          top: "8px",
          right: "8px",
          padding: "4px 8px",
          background: "rgba(0,0,0,0.55)",
          color: "#7fffa1",
          font: "11px/1 system-ui, monospace",
          fontWeight: "700",
          letterSpacing: "0.04em",
          borderRadius: "4px",
          pointerEvents: "none",
          zIndex: "10001", // above tooltips so it never hides
          minWidth: "54px",
          textAlign: "right",
        } as Partial<CSSStyleDeclaration>);
        this.fpsBadge.textContent = "— FPS";
        this.container.appendChild(this.fpsBadge);
      }
      this.fpsBadge.style.display = "block";
    } else if (this.fpsBadge) {
      this.fpsBadge.style.display = "none";
    }
  }

  /** Phase 9.42 — Observability. ~1 Hz, reads the server's
   * health_summary_csv and renders a top-left badge: "✓ Healthy" (green)
   * or "⚠ N issues" (amber) / "🚨 N issues" (red, when a dispatch
   * regression is flagged). Hovering shows the human-readable list. This
   * surfaces the same anomalies I'd otherwise hunt by hand. */
  private updateHealthBadge(dt: number): void {
    this.healthAccum += dt;
    if (this.healthAccum < 1.0) return;
    this.healthAccum = 0;
    if (!this.healthBadge) {
      const badge = document.createElement("div");
      Object.assign(badge.style, {
        position: "fixed", top: "8px", left: "8px",
        padding: "4px 9px", background: "rgba(0,0,0,0.45)",
        color: "#7fffa1", font: "12px/1.1 system-ui, sans-serif",
        fontWeight: "700", borderRadius: "5px", cursor: "help",
        zIndex: "10001", userSelect: "none",
      } as Partial<CSSStyleDeclaration>);
      const tip = document.createElement("div");
      Object.assign(tip.style, {
        position: "fixed", top: "34px", left: "8px", maxWidth: "340px",
        padding: "8px 10px", background: "rgba(18,14,12,0.96)",
        color: "#fff5dc", font: "11px/1.5 system-ui, sans-serif",
        border: "1px solid #d8b98f", borderRadius: "6px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)", zIndex: "10002",
        display: "none", pointerEvents: "none",
      } as Partial<CSSStyleDeclaration>);
      badge.addEventListener("mouseenter", () => { if (tip.childNodes.length) tip.style.display = "block"; });
      badge.addEventListener("mouseleave", () => { tip.style.display = "none"; });
      this.container.appendChild(badge);
      this.container.appendChild(tip);
      this.healthBadge = badge;
      this.healthTooltip = tip;
    }
    const badge = this.healthBadge;
    const tip = this.healthTooltip!;
    const summary = this.cloud.getHealthSummary();
    if (!summary) {
      badge.textContent = "✓ Healthy";
      badge.style.color = "#7fffa1";
      badge.style.background = "rgba(0,0,0,0.45)";
      tip.replaceChildren();
      tip.style.display = "none";
      return;
    }
    const items = summary.split("|").map((tok) => {
      const [code, val = ""] = tok.split(":");
      return Engine.formatHealthFlag(code, val);
    });
    const severe = items.some((i) => i.severe);
    badge.textContent = `${severe ? "🚨" : "⚠"} ${items.length} issue${items.length === 1 ? "" : "s"}`;
    badge.style.color = severe ? "#ff9a9a" : "#ffd47a";
    badge.style.background = severe ? "rgba(80,12,12,0.72)" : "rgba(60,42,0,0.72)";
    tip.replaceChildren(...items.map((i) => {
      const row = document.createElement("div");
      row.textContent = i.text;
      row.style.margin = "2px 0";
      if (i.severe) row.style.color = "#ff9a9a";
      return row;
    }));
  }

  /** Map a server health-flag code+value to a human-readable line +
   * severity. `severe` (red) = a dispatch regression that shouldn't
   * happen (idle staff while work waits); the rest are amber capacity/
   * flow signals. */
  private static formatHealthFlag(code: string, val: string): { text: string; severe: boolean } {
    switch (code) {
      case "waiter_starved": return { text: `🚨 Waiters idle while ${val} guests wait to order`, severe: true };
      case "chef_starved":   return { text: `🚨 Chefs idle while ${val} orders are queued`, severe: true };
      case "kitchen_full":   return { text: `🔥 Kitchen maxed out — ${val} orders queued, every stove busy (add stoves)`, severe: false };
      case "order_queue":    return { text: `🪑 ${val} guests waiting to order (take-order queue)`, severe: false };
      case "cook_backlog":   return { text: `🍳 ${val} orders queued — kitchen behind`, severe: false };
      case "undelivered":    return { text: `🍽️ ${val} plates cooked, waiting for a waiter`, severe: false };
      case "chef_hog":       return { text: `👨‍🍳 One chef is handling ${val}% of the cooking`, severe: false };
      case "lost_spike":     return { text: `💔 High walkout rate — ${val}% leaving angry`, severe: false };
      case "dirty_seats":    return { text: `🍽️ ${val} seats need bussing — unservable until cleaned`, severe: false };
      default:               return { text: `${code} ${val}`, severe: false };
    }
  }

  /** Build the always-bottom Reset-Save section. Lives in its own
   * sidebar-bottom slot (after StaffPanel) so it's visually
   * separated from gameplay actions and can't be misclicked from
   * the busier modal-icon row at the top of the HUD. */
  private installResetSaveSection(): void {
    this.sidebar.addSeparator();

    // Phase I (H.73) — Logout button.  Sits just above Reset save in
    // the same section so the two account-level controls live
    // together, with Logout the safer / more common one on top.
    // Differentiated by both colour (cool blue/cyan vs. Reset save's
    // alarming red) and copy ("→") so they don't read as twins.
    const logoutWrap = document.createElement("div");
    Object.assign(logoutWrap.style, { marginBottom: "6px" } as Partial<CSSStyleDeclaration>);
    const logoutBtn = document.createElement("button");
    logoutBtn.textContent = "→ Log out";
    Object.assign(logoutBtn.style, {
      display: "block", width: "100%",
      padding: "6px 8px",
      background: "rgba(100, 160, 200, 0.20)",
      color: "#fff5dc",
      border: "1px solid rgba(100, 160, 200, 0.45)",
      borderRadius: "4px", cursor: "pointer",
      font: "inherit", fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    logoutBtn.title =
      "Log out — disconnects this session from your account, clears\n" +
      "the saved auth token, then reloads the page.  Your save and\n" +
      "plot stay intact; the next login pops you back in where you\n" +
      "left off.  Use this when switching accounts or handing the\n" +
      "browser to someone else.";
    logoutBtn.onclick = () => this.logout();
    logoutWrap.appendChild(logoutBtn);
    this.sidebar.body.appendChild(logoutWrap);

    const wrap = document.createElement("div");
    Object.assign(wrap.style, { marginBottom: "4px" } as Partial<CSSStyleDeclaration>);
    const btn = document.createElement("button");
    btn.textContent = "🗑 Reset save (start over)";
    Object.assign(btn.style, {
      display: "block", width: "100%",
      padding: "6px 8px",
      background: "rgba(200, 80, 80, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(200, 80, 80, 0.45)",
      borderRadius: "4px", cursor: "pointer",
      font: "inherit", fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    btn.title =
      "Reset save — character wipe.\n" +
      "Releases your plot, deletes your restaurant + achievements + " +
      "leaderboard scores, and sends you back to the plot picker. " +
      "Username + password are kept. There's a confirmation prompt — " +
      "you need to type RESET to proceed.";
    btn.onclick = () => this.resetSave();
    wrap.appendChild(btn);
    this.sidebar.body.appendChild(wrap);
  }

  /** Phase I (H.73) — log out the current session.  Fires the server
   * logout reducer (drops the auth_record link for this identity),
   * clears the per-host token from local + session storage so a
   * reload doesn't silently re-claim the same wallet, then hard-
   * reloads.  After reload the connect flow sees no token, the SDK
   * generates a fresh anonymous identity, isAuthenticated() returns
   * false, and the LoginModal pops. */
  private async logout(): Promise<void> {
    const ok = window.confirm(
      "Log out of this session?\n\n" +
      "Your restaurant and progress stay on the server — you can\n" +
      "log back in with the same username + password anytime.",
    );
    if (!ok) return;
    try {
      await this.cloud.logout();
    } catch (e) {
      console.warn("[Engine] cloud.logout reducer failed (continuing with local clear):", e);
    }
    // Reload regardless of whether the reducer succeeded — the token
    // is already wiped client-side so the next session is fresh
    // even if the server didn't get the logout call (e.g. dropped
    // connection at the moment of click).
    window.location.reload();
  }

  /** Character wipe. Releases the player's plot, deletes their
   * server save + leaderboard + achievements, then nukes local
   * save slots and reloads — the engine's auth gate sees no
   * building owned and pops the plot picker. Username + password
   * are preserved.
   *
   * Strong confirmation dialog so a stray click doesn't trash the
   * account; double-confirms by requiring the player to type the
   * word RESET (matches industry-standard "delete account"
   * affordance). */
  private async resetSave(): Promise<void> {
    const slot = this.saver.getActiveSlot();
    const ok = window.confirm(
      "⚠ RESET SAVE — this will permanently:\n" +
      "  • Release your current plot (anyone can take it)\n" +
      "  • Delete your restaurant, decor, money, tier, achievements,\n" +
      "    leaderboard scores, and active menu\n" +
      "  • Send you back to the plot picker to start fresh\n\n" +
      "Your USERNAME and PASSWORD will be kept so you can log in\n" +
      "again to the new restaurant.\n\n" +
      "Continue?"
    );
    if (!ok) return;
    const typed = window.prompt("Type RESET (in caps) to confirm:");
    if (typed !== "RESET") {
      // eslint-disable-next-line no-alert
      window.alert("Cancelled — nothing was wiped.");
      return;
    }
    // Server-side wipe first (releases building + clears player_save
    // + leaderboard + achievements). If this fails we bail BEFORE
    // touching the local save so the player can retry without
    // losing local state.
    try {
      await this.cloud.wipeMyRestaurant();
    } catch (e) {
      console.warn("[Engine] wipeMyRestaurant failed:", e);
      // eslint-disable-next-line no-alert
      window.alert("Couldn't reach the server to wipe — try again in a moment.");
      return;
    }
    // Wipe local save + the panel-position localStorage entries
    // (otherwise the new restaurant inherits the old layout) +
    // reload. The reload hits the auth gate which sees no owned
    // building → spawns BuildingPickModal → fresh start.
    SaveSystem.deleteSlot(slot);
    try {
      localStorage.removeItem("cozy-bistro.panel.build");
      localStorage.removeItem("cozy-bistro.panel.menu");
      localStorage.removeItem("cozy-bistro.panel.chat");
      localStorage.removeItem("cozy-bistro.panel.build.v2");
      localStorage.removeItem("cozy-bistro.panel.menu.v2");
      localStorage.removeItem("cozy-bistro.panel.chat.v2");
      localStorage.removeItem("cozy-bistro.panel.menu.v3");
      // Don't wipe the auth token — keep them logged in for the new pick.
    } catch { /* ignore */ }
    window.location.reload();
  }

  /** Match world characters to the saved StaffSystem headcount. The base
   * 3 characters from populateCharacters cover "1 of each"; this fills
   * in the rest on load. Diagnostic logs per role so we can see in
   * DevTools which spawn calls landed and which failed. */
  private async syncStaffToHeadcount(): Promise<void> {
    if (!this.router) {
      console.warn("[syncStaff] no router — skipping all roles");
      return;
    }
    const roles: ("chef" | "waiter" | "errand" | "barman")[] = ["chef", "waiter", "errand", "barman"];
    for (const role of roles) {
      // Errand role needs its own router; skip cleanly if absent rather
      // than blocking chef/waiter restoration.
      if (role === "errand" && !this.errand) {
        console.warn("[syncStaff] no errand router — skipping errand restore");
        continue;
      }
      const members = this.game.staff.getMembers(role);
      const have = role === "chef"
        ? this.router.getChefCount()
        : role === "waiter"
          ? this.router.getWaiterCount()
          : role === "barman"
            ? this.router.getBarmanCount()
            : this.errand!.getHelperCount();
      console.log(`[syncStaff] ${role}: want=${members.length}, have=${have} (will spawn ${Math.max(0, members.length - have)})`);
      // Members 0..have-1 are already attached to actors (the base
      // char + any earlier extras). Spawn extras for the remaining
      // members and link each to its HiredStaffMember.id.
      for (let i = have; i < members.length; i += 1) {
        const member = members[i];
        const char = await this.scene.spawnExtraStaff(role, i, member.homeFloor ?? 0);
        if (!char) {
          console.warn(`[syncStaff] ${role} extra #${i} (${member.name}) failed to load`);
          continue;
        }
        console.log(`[syncStaff] ${role} extra #${i} (${member.name}) spawned at (${char.groundPos.x.toFixed(2)}, ${char.groundPos.y.toFixed(2)})`);
        this.floatingText?.pop(char.groundPos.x, char.groundPos.y - 0.4,
          `+1 ${this.labelForRole(role)}: ${member.name}`, "#a8e2a8");
        if (role === "chef") this.router.addChef(char, member.id, member.homeFloor ?? 0);
        else if (role === "waiter") this.router.addWaiter(char, member.id, member.homeFloor ?? 0);
        else if (role === "barman") this.router.addBarman(char, member.id, member.homeFloor ?? 0);
        else this.errand!.addHelper(char, member.id);
      }
    }
  }

  /** Spawn an extra staff character and slot them into the right router.
   * Picks an offset slot so multiple extras of the same role don't pile
   * onto a single spot. Pops a floating "+1 Role" toast at the new
   * character's spot so the player can see where to look. */
  private async handleStaffHired(role: "chef" | "waiter" | "errand" | "barman"): Promise<void> {
    const currentInRouter = role === "chef"
      ? (this.router?.getChefCount() ?? 0)
      : role === "waiter"
        ? (this.router?.getWaiterCount() ?? 0)
        : role === "barman"
          ? (this.router?.getBarmanCount() ?? 0)
          : (this.errand?.getHelperCount() ?? 0);
    const offsetSlot = currentInRouter;
    // Game.hireStaff already appended the new member record. Grab the
    // tail of the roster so we have the auto-generated name + id.
    const members = this.game.staff.getMembers(role);
    // Spawn for the first ACTIVE member of this role that has no world actor
    // yet — covers both a fresh hire (the new active member) and a
    // reactivation (an un-benched member whose actor was despawned). Benched
    // members are skipped so they stay invisible.
    const hasActor = (id: string) =>
      !!(this.router?.findCharacterByMemberId(id) || this.errand?.findCharacterByMemberId(id));
    const member = members.find((m) => !m.isDeactivated && !hasActor(m.id));
    if (!member) {
      console.warn(`[Engine] handleStaffHired: no spawnable roster member for ${role}`);
      return;
    }
    // Spawn the model first so we know its actual world pose for the toast.
    // Newly hired staff default to ground floor — the player reassigns
    // via the StaffPanel floor selector after-the-fact.
    const char = await this.scene.spawnExtraStaff(role, offsetSlot, member.homeFloor ?? 0);
    if (!char) {
      // Loading failed — still tell the player something visible.
      this.floatingText?.pop(0, -2.2, `+1 ${this.labelForRole(role)}: ${member.name} (load failed)`, "#ff9a9a");
      return;
    }
    this.floatingText?.pop(char.groundPos.x, char.groundPos.y - 0.4,
      `+1 ${this.labelForRole(role)}: ${member.name}`, "#a8e2a8");
    if (role === "chef") this.router?.addChef(char, member.id, member.homeFloor ?? 0);
    else if (role === "waiter") this.router?.addWaiter(char, member.id, member.homeFloor ?? 0);
    else if (role === "barman") this.router?.addBarman(char, member.id, member.homeFloor ?? 0);
    else this.errand?.addHelper(char, member.id);
  }

  private labelForRole(role: "chef" | "waiter" | "errand" | "barman"): string {
    return role === "chef" ? "Chef" : role === "waiter" ? "Waiter" : role === "barman" ? "Barman" : "Errand";
  }

  /** Look up the world position of the actor that represents a
   * HiredStaffMember. Falls back to a sensible "near the kitchen"
   * point when the actor can't be located (e.g. an errand helper
   * who's offscreen on a shopping run). */
  private findMemberWorldPos(memberId: string): THREE.Vector2 {
    const fromStaff = this.router?.findCharacterByMemberId(memberId);
    if (fromStaff) return fromStaff.groundPos.clone();
    const fromErrand = this.errand?.findCharacterByMemberId(memberId);
    if (fromErrand) return fromErrand.groundPos.clone();
    return this.scene.stovePos.clone();
  }

  /** Remove the most-recently-added staff character of this role from
   * its router pool, and drop their model from the scene. */
  private handleStaffFired(role: "chef" | "waiter" | "errand" | "barman"): void {
    let removed: { character: { root: import("three").Object3D } | null } | null = null;
    if (role === "chef") removed = { character: this.router?.removeChef() ?? null };
    else if (role === "waiter") removed = { character: this.router?.removeWaiter() ?? null };
    else if (role === "barman") removed = { character: this.router?.removeBarman() ?? null };
    else removed = { character: this.errand?.removeHelper() ?? null };
    const model = removed?.character?.root;
    if (model) {
      this.scene.threeScene.remove(model);
      this.scene.animator.remove(model);
    }
  }

  /** Per-member fire path. Targets the SPECIFIC actor whose
   * AnimatedCharacter.memberId matches, so an upgraded staff
   * member the player picks out by name disappears from the
   * scene (not a random colleague of the same role).
   *
   * Falls back to the LIFO removeChef/Waiter/Barman/Helper if the
   * actor isn't in the pool yet — covers the race where the
   * spawn promise hasn't resolved when the player clicks fire. */
  private handleStaffMemberFired(memberId: string, role: "chef" | "waiter" | "errand" | "barman"): void {
    let character: { root: import("three").Object3D } | null = null;
    if (role === "errand") {
      character = this.errand?.removeHelperById(memberId)
        ?? this.errand?.removeHelper()
        ?? null;
    } else {
      character = this.router?.removeMemberById(memberId)
        ?? (role === "chef"   ? this.router?.removeChef()   ?? null
           : role === "waiter" ? this.router?.removeWaiter() ?? null
           : this.router?.removeBarman() ?? null);
    }
    const model = character?.root;
    if (model) {
      this.scene.threeScene.remove(model);
      this.scene.animator.remove(model);
    }
  }

  /** Fallback if the staff GLBs failed to load — gives an instant-delivery
   * stub so guests still complete their loop. */
  private buildStubRouter(): StaffRouter {
    // We can't construct a real StaffRouter without chef/waiter chars, so
    // we expose a duck-typed shim that always reports "delivered" after a
    // short delay. Keeps the game running for diagnostic purposes.
    const tickets: { guestId: string; readyAt: number }[] = [];
    return {
      tickets: [],
      enqueueOrder: (guestId: string, _r: string, _s: THREE.Vector2, cookSeconds: number) => {
        tickets.push({ guestId, readyAt: performance.now() / 1000 + cookSeconds + 2 });
        return guestId;
      },
      popDeliveredFor: (guestId: string) => {
        const now = performance.now() / 1000;
        const i = tickets.findIndex((t) => t.guestId === guestId && t.readyAt <= now);
        if (i < 0) return false;
        tickets.splice(i, 1);
        return true;
      },
      update: () => {},
    } as unknown as StaffRouter;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.tick();
  }

  stop(): void {
    this.running = false;
  }

  private readonly handleResize = (): void => {
    this.lastResizeCheckAt = performance.now();
  };

  private resizeIfNeeded(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === this.renderer.domElement.width / this.renderer.getPixelRatio() &&
        h === this.renderer.domElement.height / this.renderer.getPixelRatio()) {
      return;
    }
    this.renderer.setSize(w, h);
    this.camera.resize(w, h);
  }

  /** Anti-freeze — persistent banner shown when the WebGL context is lost
   * (see the webglcontextlost handler in the constructor). Offers a reload
   * because a lost context can't always be auto-restored on a low-end GPU. */
  private showGpuResetBanner(): void {
    if (this.gpuResetBanner) return;
    const b = document.createElement("div");
    b.textContent = "⚠️ Graphics device was reset (GPU overloaded) — the game paused.";
    Object.assign(b.style, {
      position: "fixed", top: "0", left: "0", right: "0", padding: "10px 16px",
      zIndex: "100000", background: "rgba(130, 24, 24, 0.96)", color: "#fff",
      font: "13px system-ui, sans-serif", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    const btn = document.createElement("button");
    btn.textContent = "Reload";
    Object.assign(btn.style, {
      marginLeft: "12px", padding: "3px 12px", cursor: "pointer", font: "inherit",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = () => window.location.reload();
    b.appendChild(btn);
    document.body.appendChild(b);
    this.gpuResetBanner = b;
  }

  private hideGpuResetBanner(): void {
    this.gpuResetBanner?.remove();
    this.gpuResetBanner = null;
  }

  private tick = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    // Anti-freeze — while the WebGL context is lost, rendering into it is a
    // silent no-op; skip the frame body. rAF stays scheduled above, so the
    // loop auto-resumes the instant the context is restored.
    if (this.contextLost) return;

    // Phase I — FPS cap gate.  When fpsCap is non-null, skip this
    // whole tick body (including the renderer.render call) if we
    // ran a frame less than 1000/cap ms ago.  rAF still keeps
    // scheduling so input handlers attached elsewhere stay live
    // — only the sim + render are throttled.  THREE.Clock.getDelta
    // accumulates between calls, so the next non-skipped frame
    // sees the full elapsed time and advances the sim by the
    // right amount.
    //
    // Small grace (-1 ms) so a frame that lands just barely under
    // the budget on a high-refresh display still runs — without it,
    // a 60 Hz cap on a 60 Hz display alternates run/skip.
    const now = performance.now();
    if (this.fpsCap !== null) {
      const minFrameMs = 1000 / this.fpsCap - 1;
      if (now - this.lastRenderedFrameAt < minFrameMs) return;
    }
    // Push frame timing into the FPS counter rolling window AFTER
    // the cap gate so the value reflects the actual rendered rate,
    // not the rAF rate.
    if (this.lastRenderedFrameAt > 0) {
      const frameMs = now - this.lastRenderedFrameAt;
      if (frameMs > 0) {
        this.fpsSamples.push(1000 / frameMs);
        if (this.fpsSamples.length > 60) this.fpsSamples.shift();
      }
    }
    this.lastRenderedFrameAt = now;

    if (performance.now() - this.lastResizeCheckAt < 1000) {
      this.resizeIfNeeded();
    }

    const rawDt = Math.min(this.clock.getDelta(), 0.1);
    // Scale the sim dt by the player's time control. Cap the scaled value
    // so 4x on a slow frame doesn't simulate a big jump.
    const dt = this.paused ? 0 : Math.min(rawDt * this.timeScale, 0.25);
    // Keep the spawner's open flag in step with the game's (the authority,
    // restored from save) — the spawner reads it to gate guest spawning.
    if (this.spawner) this.spawner.restaurantOpen = this.game.restaurantOpen;
    this.game.update(dt);
    // H.30 — periodic yoke of the cloud's day clock to local. Uses
    // rawDt (real seconds, ignores pause / timeScale) so the cloud
    // sees real wall-clock progression and a paused / sped-up
    // foreground tab doesn't desync. Fires every 5 s — short enough
    // that a quick disconnect/reconnect can't accumulate spurious
    // pending day rollovers, long enough that we're not hammering
    // the reducer.
    const DAY_SYNC_INTERVAL_SEC = 5;
    this.daySyncAccum += rawDt;
    if (this.daySyncAccum >= DAY_SYNC_INTERVAL_SEC) {
      this.daySyncAccum = 0;
      // elapsed-in-day in seconds = dayLength - timeRemaining.
      const DAY_LENGTH_SEC = 720;
      const elapsedSec = DAY_LENGTH_SEC - this.game.day.getTimeRemainingSeconds();
      const elapsedMs = Math.max(0, Math.round(elapsedSec * 1000));
      this.cloud.syncDayClock(elapsedMs);
      // Phase 7.7 — Delta-based money sync. Compute (local - lastSynced)
      // and push the delta instead of the absolute value. Lets the
      // server's accumulate adds (tips, revenue, etc.) coexist with
      // client-side spends like hire/fire/upgrade without either side
      // clobbering the other. The Restaurant subscription handler
      // also advances lastSyncedCents on cloud-driven updates so this
      // push doesn't double-count server adds.
      const localCents = Math.round(this.game.economy.getMoney() * 100);
      const lastSynced = this.game.economy.getLastSyncedCents();
      // Phase 9.3 — NEVER push against an unanchored baseline. On a
      // fresh boot lastSynced is null until the first cloud adoption
      // (applyPendingVisitRollup or the restaurant.onUpdate handler)
      // anchors it; computing (localSave − 0) here pushed the
      // player's entire saved balance to the cloud as fake income on
      // every reload — half of the 100k → 3.4M doubling loop.
      if (lastSynced !== null) {
        const deltaCents = localCents - lastSynced;
        // Only advance the synced baseline if the bump actually reached the
        // server. If the socket is down (conn nulled on disconnect) the bump
        // no-ops and returns false — advancing the baseline anyway would
        // silently drop this delta on the next reload re-anchor (lost money).
        if (deltaCents !== 0 && this.cloud.bumpCloudMoneyCents(deltaCents)) {
          this.game.economy.noteSyncedCents(localCents);
        }
      }
      // H.46 — push today's revenue + expense totals so visitors,
      // the leaderboard, and any second-device session see live
      // values instead of save-snapshot stale ones.  Same cadence,
      // same idempotency rationale.
      //
      // Phase 6.11 — Daily customer-served + customer-lost counts
      // mirror at the same cadence so the visit-mode overlay + the
      // leaderboard surface accurate "today" totals between autosaves.
      this.cloud.syncCloudDailyTotals(
        this.game.economy.getDailyRevenue(),
        this.game.economy.getDailyExpenses(),
        this.game.customers.getDailyServed(),
        this.game.customers.getDailyLost(),
      );
      // H.61 — push the transaction log snapshot if dirty.  No-op
      // when no transactions have been recorded since the last
      // push.  Same cadence as the money / daily-totals sync to
      // avoid multiplying network calls.
      this.game.economy.syncTransactionLogToCloud();
    }
    this.router?.update(dt);
    this.errand?.update(dt);
    this.spawner?.update(dt);
    this.pedestrians?.update(dt);
    // P5 — pull the current server pedestrian list every frame and
    // reconcile the renderer against it. Cheap: list is tiny (<24
    // rows) and the renderer only adds/removes models on changes,
    // pure-lerps existing positions.
    if (this.sharedPedestrians) {
      this.sharedPedestrians.update(this.cloud.listPedestrians(), rawDt);
    }
    this.trash?.update(dt);
    // After all movement, run a personal-space pass so walking guests
    // + pedestrians don't stack on top of each other.
    if (dt > 0 && (this.spawner || this.pedestrians || this.sharedPedestrians || this.router)) {
      const actors: MovableActor[] = [];
      if (this.spawner) actors.push(...this.spawner.snapshotMovable());
      if (this.pedestrians) actors.push(...this.pedestrians.snapshotMovable());
      if (this.sharedPedestrians) actors.push(...this.sharedPedestrians.snapshotMovable());
      // Staff were historically left OUT of the separation pass, so idle
      // waiters/chefs/barmen (which never re-walk once parked) stacked
      // permanently on their shared rest spot — a visible "blob" on the floor.
      // Working (at-station) staff come back pinned so they aren't shoved off.
      if (this.router) actors.push(...this.router.snapshotMovable());
      PersonalSpace.apply(actors, dt);
      // Re-pin every indoor staff member's XZ back inside the
      // building walls AFTER the PersonalSpace push — without this
      // a crowded doorway can incrementally drive a waiter through
      // the south wall onto the pavement / mid-air outside.
      this.router?.clampAllStaffToInterior();
    }
    // Per-stove flames — reconcile the flame map with the registry's
    // current cooking-stoves (adds new flames, removes ones for sold
    // stoves), then light only the stoves whose own chef is currently
    // at the burner. Driven before scene.update so the per-frame
    // flicker animation runs this frame. The cooking-loop SFX tracks
    // the aggregate flag (any flame visible = sizzling).
    this.scene.syncStationEffects(this.registry.getCookStations());
    // Compute the augmented active set: every stove the router is
    // currently cooking on PLUS any range hood that's positioned
    // directly above one of those stoves (same X column within 0.7,
    // Z within 1.5). The hood activation tracks the chef — when they
    // walk away the hood goes dark + silent too. Cheap because the
    // registry snapshot is already in hand for syncStationEffects.
    const cookingStoves = this.router?.getCookingStoveUids() ?? new Set<string>();
    const activeUids = new Set(cookingStoves);
    if (cookingStoves.size > 0) {
      const stations = this.registry.getCookStations();
      const stovePositions: { x: number; z: number }[] = [];
      for (const s of stations) {
        if (cookingStoves.has(s.uid)) stovePositions.push({ x: s.x, z: s.z });
      }
      for (const s of stations) {
        if (s.defId !== "kitchen-hood" && s.defId !== "kitchen-hood-l") continue;
        for (const p of stovePositions) {
          if (Math.abs(s.x - p.x) < 0.7 && Math.abs(s.z - p.z) < 1.5) {
            activeUids.add(s.uid);
            break;
          }
        }
      }
    }
    this.scene.setActiveStations(activeUids);
    // Per-variant cooking-loop SFX — feed the live "which appliance
    // visuals are active right now" set straight into the SfxPlayer.
    // setLoopActive is idempotent, so it's safe to call for every
    // variant every frame; the player only spends CPU on the ones
    // that actually flip state.
    const activeStations = this.scene.getActiveStationVariants();
    this.sfx.setLoopActive("gas-stove",      activeStations.has("gas"));
    this.sfx.setLoopActive("electric-stove", activeStations.has("electric"));
    this.sfx.setLoopActive("toaster",        activeStations.has("toaster"));
    this.sfx.setLoopActive("coffee",         activeStations.has("coffee"));
    this.sfx.setLoopActive("blender",        activeStations.has("blender"));
    this.sfx.setLoopActive("microwave",      activeStations.has("microwave"));
    this.sfx.setLoopActive("hood",           activeStations.has("hood"));
    // Dishwasher: any plates / glasses mid-cycle = humming away.
    const dwInflight = this.game.dishware.getDishwasherInFlight("plate")
                     + this.game.dishware.getDishwasherInFlight("glass");
    this.sfx.setLoopActive("dishwasher", dwInflight > 0);
    // New cooking stations (grill / fryer / oven / pizza oven) carry their
    // own built-in glow rather than a WorldScene stationEffect, so they're
    // not in getActiveStationVariants. Drive their loops straight off the
    // active-station uids (a chef "working" there) + the station's provides.
    const activeAppliances = new Set<string>();
    for (const s of this.registry.getCookStations()) {
      if (activeUids.has(s.uid)) activeAppliances.add(s.provides);
    }
    this.sfx.setLoopActive("grill",      activeAppliances.has("grill"));
    this.sfx.setLoopActive("fryer",      activeAppliances.has("fryer"));
    this.sfx.setLoopActive("oven",       activeAppliances.has("oven"));
    this.sfx.setLoopActive("pizza-oven", activeAppliances.has("pizza-oven"));
    // Open the door when a guest, errand helper, or pedestrian is close.
    this.scene.setDoorOpen(this.anyoneNearDoor());
    // Animate interior doorways — any placed int-doorway opens when a
    // guest or staff member is close enough to walk through.
    this.updateInteriorDoorways(dt);
    // Push the current weather id BEFORE applyDayNight so the lighting
    // tint matches today's roll. setWeather is a no-op when nothing
    // changed, so cheap to call every frame.
    const todaysWeatherId = this.game.weather.getCurrent().id;
    this.scene.setWeather(todaysWeatherId);
    // Track which weather kinds the player has ever seen — drives
    // the "experienced every weather" achievement. The set is small
    // so .add is a no-op for already-seen entries; safe to call
    // every frame.
    this.game.recordPlayerSet("weathersSeen", todaysWeatherId);
    // Day/night lighting follows the in-game day timer; applyDayNight
    // layers any weather tints on top of the base dayness ramp.
    const dayProgress = this.game.day.getDayProgress();
    // Feed the live day-cycle progress to the music system. SfxPlayer
    // owns the 4-phase state machine (day loop → dusk fade → night
    // loop → dawn fade), so the engine just keeps it informed.
    this.sfx.setDayProgress(dayProgress);
    const day = this.scene.applyDayNight(dayProgress);
    // Reposition the street-lamp light pool around the camera so the
    // player walks through pools of light at night. Bulb glow itself
    // ramps inside applyDayNight via the shared bulb material.
    this.scene.updateStreetLamps(this.camera.threeCamera.position);
    this.scene.updatePlacedLampLights(this.camera.threeCamera.position);
    this.scene.updateStoveLights(this.camera.threeCamera.position);
    this.renderer.setClearColor(day.skyColor);
    if (this.scene.threeScene.fog instanceof THREE.Fog) {
      this.scene.threeScene.fog.color.setHex(day.skyColor);
    }
    // Sky dome — same hue as the fog haze so the "void" past the
    // visible city dissolves into the same horizon colour. Without
    // this, low-elevation rays escape past the ground plane and
    // the renderer just draws the clear colour where they miss.
    this.scene.setSkyColor(day.skyColor);
    // Pin the dome to the camera so it ALWAYS surrounds the
    // viewport — even when the player has panned the target far
    // from origin. Without this the dome sits at (0,0,0) and at
    // large pans the camera could end up looking out past it.
    if (this.scene.skyDome) {
      this.scene.skyDome.position.copy(this.camera.threeCamera.position);
    }
    // Tick weather particles — uses rawDt so rain still falls at a
    // believable rate when the simulation is paused or fast-forwarded.
    // Camera position lets the particle volume follow the player.
    this.scene.updateWeather(rawDt, this.camera.threeCamera.position);
    // Dishware leak watchdog — fires once per second internally;
    // surfaces any drop in (clean+dirty+inflight) vs lifetimeAdded
    // to the console along with the recent action history.
    this.dishwareLeakWatcher?.tick(rawDt);
    // Phase 8.3 — Visit-mode snapshot interpolation. When the player
    // is touring another restaurant, the live staff + customer
    // positions arrive every 500 ms via cloud subscriptions; this
    // call LERPs each character's groundPos between the previous and
    // latest snapshot so the on-screen motion is continuous instead
    // of teleporting once per server tick. Must run BEFORE
    // scene.update so the animator's pose composition reads the
    // freshly-interpolated values.
    this.visitMode.tickLiveMotion();
    this.scene.update(dt);
    // Exterior-only view kicks in below the 40% zoom-percent mark:
    // walls close, all unlocked storeys + roof show regardless of
    // focus, and the SFX bus mutes. Above the threshold the normal
    // see-through interior view returns. Driven from the same frame
    // tick as the wall ghost rule so they always agree.
    const zoomPercent = this.camera.getZoomPercent();
    // Anti-perf — anticipatory shader pre-warm. The exterior flip at 0.40
    // reveals every storey + roof at once; compiling their programs on that
    // frame stalls the main thread ("the whole game freezes"). So as the
    // player zooms OUT past 0.55, kick off an async (non-blocking) compile
    // of that still-hidden geometry in the background — by the time they
    // cross 0.40 it's warm and the flip is instant. Fire once per pass
    // (armed at 0.55, re-armed past 0.60) so we don't traverse the scene
    // every frame; the compile is a cache no-op once warm.
    if (zoomPercent < 0.55 && !this.exteriorPrewarmArmed) {
      this.exteriorPrewarmArmed = true;
      this.scene.precompileShaders(this.renderer, this.camera.threeCamera);
    } else if (zoomPercent > 0.60) {
      this.exteriorPrewarmArmed = false;
    }
    const exterior = zoomPercent < 0.40;
    this.scene.setExteriorMode(exterior);
    this.sfx.setExteriorMuted(exterior);
    // Zoom-based sun-shadow toggle. Past the exterior threshold the
    // shadow streak under each piece of furniture is a few pixels
    // tall and visually meaningless; skipping the shadow pass at
    // that zoom is a free perf win. Inside the threshold we
    // respect the saved-quality preset (Low disables shadows even
    // when zoomed in). Only writes the flag when it CHANGES — three.js
    // clears the shadow render target on every state flip otherwise.
    const presetWantsShadows = GRAPHICS_PRESETS[this.currentQuality].sunShadows;
    const desiredSunShadow = presetWantsShadows && zoomPercent >= 0.45;
    if (desiredSunShadow !== this.sunShadowOn) {
      this.sunShadowOn = desiredSunShadow;
      this.scene.setSunShadowsEnabled(desiredSunShadow);
    }
    // Swap which two exterior walls render as transparent glass based
    // on which side the camera is currently on. Cheap enough to run
    // every frame, and we want it to track right through a camera drag.
    this.scene.updateWallVisibility(this.camera.threeCamera.position);
    // Visit-mode mirror: when looking at someone else's restaurant the
    // visited plot's walls do the same ghost swap on the camera-side
    // walls so visitors see into the dining room exactly the way the
    // host sees into their own. No-op when no visit is active.
    this.visitMode.updateWallVisibility(this.camera.threeCamera.position);
    // Refresh status bubbles above staff (after scene.update so character
    // positions reflect this frame's animator output).
    this.updateStatusBubbles();
    // Camera + floating text + saver use real time so the camera still
    // responds to input while paused and we don't double-save under fast-forward.
    this.camera.update(rawDt);
    this.floatingText.update(rawDt);
    this.saver.update(rawDt);
    // Phase 9.42 — health badge (~1 Hz internally), reads the server scan.
    this.updateHealthBadge(rawDt);

    // Phase I — FPS badge refresh, same 5 Hz cadence as the HUD.
    // We average the rolling sample window into fpsAvg then push to
    // the badge element if it's visible.  Keeping the badge update
    // alongside the rest of the 5 Hz block instead of inside the
    // 60+ Hz tick body avoids per-frame DOM churn (the badge text
    // doesn't need to change 144 times a second — the player can't
    // read that fast).
    this.fpsAvgAccum += rawDt;
    if (this.fpsAvgAccum >= 0.2) {
      this.fpsAvgAccum = 0;
      if (this.fpsSamples.length > 0) {
        let sum = 0;
        for (const s of this.fpsSamples) sum += s;
        this.fpsAvg = sum / this.fpsSamples.length;
      }
      if (this.showFps && this.fpsBadge) {
        this.fpsBadge.textContent = `${this.fpsAvg.toFixed(0)} FPS`;
      }
    }

    // HUD only needs ~5 Hz; updating every frame is wasteful DOM work.
    // Drive off rawDt, not the paused-scaled dt — money/camera readouts must
    // still refresh while paused (admin pause sets dt=0, which froze them).
    this.hudAccumulator += rawDt;
    if (this.hudAccumulator >= 0.2) {
      this.hud.update();
      this.staffPanel.update();
      this.menuPanel.update();
      this.expandWidget.update();
      this.stockWidget.update();
      this.cameraControls.update();
      // Rating sign mounted on the door lintel — keeps the visible star
      // count in sync with the actual restaurant rating.
      this.scene.updateRatingSign(this.game.reputation.getAverageRating());
      // SeatMarkers.refresh internally no-ops when disabled, so this is
      // safe to call unconditionally — BuildMenu toggles the enabled flag.
      this.seatMarkers.refresh();
      this.hudAccumulator = 0;
    }

    this.renderer.render(this.scene.threeScene, this.camera.threeCamera);
  };
}

/** Local helper for the visit-toast text — keeps a stray apostrophe
 * or angle bracket in a display name from breaking the toast's
 * innerHTML. Tiny enough to live in this file rather than its own. */
function escapeHtmlForToast(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
