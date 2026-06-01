import * as THREE from "three";
import { IsoCamera } from "../scene/IsoCamera";
import { WorldScene } from "../scene/WorldScene";
import { Game } from "./Game";
import { GuestSpawner } from "./GuestSpawner";
import { DishwareLeakWatcher } from "../systems/DishwareLeakWatcher";
import { getFurnitureDef } from "../data/furnitureCatalog";
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
import { PersonalSpace, type MovableActor } from "./PersonalSpace";
import { SaveSystem } from "./SaveSystem";
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
  /** True when the chef/waiter pair failed to load and the spawner is
   * running with the stub router (tickets resolve internally with no
   * staff motion). Surfaced in the UI as a loud warning so we don't
   * spend another week chasing "staff not moving" without realizing
   * THIS is the underlying state. */
  private usingStubRouter = false;
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
  /** Current player-facing graphics quality preset. Captured at
   * construct from localStorage, mutated by applyGraphicsQuality. */
  private currentQuality: GraphicsQuality = "medium";
  /** Whether the sun is currently casting shadows. Tracked so the
   * per-frame zoom-based toggle in tick() doesn't repeatedly re-set
   * the same flag (which would otherwise force three.js to clear
   * the shadow render target every frame). */
  private sunShadowOn = false;
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
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, GRAPHICS_PRESETS[this.currentQuality].pixelRatio),
    );
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0xd8c4a3);
    container.appendChild(this.renderer.domElement);

    this.scene = new WorldScene();
    this.camera = new IsoCamera(container.clientWidth, container.clientHeight);
    this.camera.attachInputTo(this.renderer.domElement);

    const savedState = SaveSystem.loadFromStorage();
    this.game = new Game(savedState);
    this.saver = new SaveSystem(this.game);
    // Cloud sync to SpacetimeDB Maincloud (cozy-bistro-andre). Runs in
    // parallel with the local save; if the network is down the game
    // continues working from localStorage.
    this.cloud = new SpacetimeClient(this.game, this.saver);
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
    this.sidebar.saveNowBtn.onclick = () => {
      this.saver.saveNow();
      this.sidebar.updateSaveStatus(this.saver.getSaveStats());
    };
    this.hud = new Hud(this.sidebar.body, this.game, {
      getCount: () => this.spawner?.getActiveGuestCount() ?? 0,
      isOpen: () => this.spawner?.restaurantOpen ?? true,
      setOpen: (open: boolean) => { if (this.spawner) this.spawner.restaurantOpen = open; },
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
    this.expandWidget = new ExpandWidget(this.sidebar.body, this.game);
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
    // Modals still live on the page-level container so they overlay the world.
    // (SfxPlayer + kickAudio listeners constructed earlier — see above.)
    this.pantryModal = new PantryModal(container, this.game);
    this.menuPanel = new MenuPanel(container, this.game);
    makeDraggableResizable({
      storageKey: "cozy-bistro.panel.menu.v2",
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
    };
    this.decorModal = new DecorModal(container, this.game);
    // So opening Decor on Floor 2 lands on Floor 2's tab by default.
    this.decorModal.getFocusedStorey = () => this.scene.getFocusedStorey();
    // Wire theme changes to the live scene + restore the saved theme.
    this.game.onThemeChanged = (floor, theme) => this.scene.setStoreyTheme(floor, theme);
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
    };
    this.scene.setRestaurantSign(this.game.getRestaurantName(), this.game.getRestaurantSignStyle());
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
    this.game.achievements.onUnlock = (a) => {
      // Floating text and sound; player can open the AchievementsModal for details.
      this.floatingText.pop(0, 5, `🏆 ${a.name}`, "#ffd986");
      this.sfx.chime();
    };
    // Auto-show the welcome modal on a brand-new visit — but ONLY
    // after auth completes (see enterGame below). Triggering it
    // here during Engine construction made the welcome card flash
    // for a moment behind the login modal on every fresh load.
    this.floatingText = new FloatingText(container, this.camera.threeCamera, this.renderer.domElement);
    this.statusBubbles = new StatusBubbles(container, this.camera.threeCamera, this.renderer.domElement);
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
      void this.registry.restore(restored).then(() => {
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
        for (const dp of this.scene.demoPlacements) {
          this.scene.threeScene.remove(dp.model);
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
      return this.router?.getChefBacklog?.(chefMemberId) ?? 0;
    };
    // Build menu — for placing furniture at runtime.
    const buildMenu = new BuildMenu(container, this.game, this.scene.loader, this.scene.threeScene, this.camera.threeCamera, this.renderer.domElement, this.registry);
    this.buildMenu = buildMenu;
    if (buildMenu.rootEl && buildMenu.titleEl) {
      makeDraggableResizable({
        storageKey: "cozy-bistro.panel.build.v2",
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
    this.floorSelector.onFocusChanged = () => buildMenu.refreshFocusedFloor();
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
        this.usingStubRouter = true;
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
        void this.syncStaffToHeadcount();
      } else {
        console.warn("[Engine] no staff pair — skipping syncStaffToHeadcount");
      }
    });

    // Save on tab close. saveNowSync uses the main-thread JSON.stringify
    // path — the page may close before the save worker round-trip
    // completes, so we can't rely on the async path here.
    window.addEventListener("beforeunload", () => this.saver.saveNowSync());
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
        storageKey: "cozy-bistro.panel.chat.v2",
        root: this.chatPanel.root,
        handle: this.chatPanel.titleBar,
        collapseSentinel: this.chatPanel.body,
        expandDirection: "up", // bottom-anchored — grow up when expanded
        minWidth: 200,
        minHeight: 32,
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
      const mine = this.cloud.getMyBuilding();
      if (mine) {
        // Per-plot rent multiplier — small 0.6×, medium 1.0×, large 1.4×.
        this.game.plotRentMultiplier =
          mine.kind === "small" ? 0.6 :
          mine.kind === "large" ? 1.4 :
          1.0;
        if (didClaim) {
          // Starter cash scales WITH plot size — bigger plot, bigger
          // grant. A larger restaurant takes more furniture to fill
          // out a viable opening day, so the extra cash offsets the
          // higher build-out cost. EconomySystem now starts at $0
          // (instead of $6000) so this grant IS the player's total
          // opening pot.
          const bonus = mine.kind === "small" ? 1000 : mine.kind === "medium" ? 1500 : 2000;
          this.game.economy.earnMoney(bonus, "grant");
          console.log(`[Engine] +$${bonus} starter cash bonus for ${mine.kind} plot`);
        }
      }
      this.game.setAuthGated(false);
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
      // Auth complete. Check if this account has a plot; if not,
      // show BuildingPickModal. The game stays auth-gated until a
      // plot is owned so the world doesn't render an unrooted
      // restaurant in some random spot.
      if (this.cloud.getMyBuilding()) {
        enterGame(false);
        return;
      }
      // Poll for ~3s — the building cache may not have landed yet
      // on the same tick as the auth_record. If still unowned
      // after the grace period, show the picker.
      let waited = 0;
      const wait = (): void => {
        waited += 200;
        if (this.cloud.getMyBuilding()) {
          enterGame(false);
          return;
        }
        if (waited < 3000) { window.setTimeout(wait, 200); return; }
        // Show the building picker. The fresh claim triggers the
        // starter cash bonus (via enterGame(true)).
        new BuildingPickModal(container, this.cloud, () => enterGame(true));
      };
      window.setTimeout(wait, 200);
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
    this.sidebar.body.appendChild(wrap);
  }

  /** Build the always-bottom Reset-Save section. Lives in its own
   * sidebar-bottom slot (after StaffPanel) so it's visually
   * separated from gameplay actions and can't be misclicked from
   * the busier modal-icon row at the top of the HUD. */
  private installResetSaveSection(): void {
    this.sidebar.addSeparator();
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
    const member = members[members.length - 1];
    if (!member) {
      console.warn(`[Engine] handleStaffHired: no roster member found for ${role}`);
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

  private tick = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.tick);

    if (performance.now() - this.lastResizeCheckAt < 1000) {
      this.resizeIfNeeded();
    }

    const rawDt = Math.min(this.clock.getDelta(), 0.1);
    // Scale the sim dt by the player's time control. Cap the scaled value
    // so 4x on a slow frame doesn't simulate a big jump.
    const dt = this.paused ? 0 : Math.min(rawDt * this.timeScale, 0.25);
    this.game.update(dt);
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
    if (dt > 0 && (this.spawner || this.pedestrians || this.sharedPedestrians)) {
      const actors: MovableActor[] = [];
      if (this.spawner) actors.push(...this.spawner.snapshotMovable());
      if (this.pedestrians) actors.push(...this.pedestrians.snapshotMovable());
      if (this.sharedPedestrians) actors.push(...this.sharedPedestrians.snapshotMovable());
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
    this.scene.update(dt);
    // Exterior-only view kicks in below the 40% zoom-percent mark:
    // walls close, all unlocked storeys + roof show regardless of
    // focus, and the SFX bus mutes. Above the threshold the normal
    // see-through interior view returns. Driven from the same frame
    // tick as the wall ghost rule so they always agree.
    const zoomPercent = this.camera.getZoomPercent();
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
    // Refresh status bubbles above staff (after scene.update so character
    // positions reflect this frame's animator output).
    this.updateStatusBubbles();
    // Camera + floating text + saver use real time so the camera still
    // responds to input while paused and we don't double-save under fast-forward.
    this.camera.update(rawDt);
    this.floatingText.update(rawDt);
    this.saver.update(rawDt);

    // HUD only needs ~5 Hz; updating every frame is wasteful DOM work.
    this.hudAccumulator += dt;
    if (this.hudAccumulator >= 0.2) {
      this.hud.update();
      this.staffPanel.update();
      this.menuPanel.update();
      this.expandWidget.update();
      this.stockWidget.update();
      this.cameraControls.update();
      this.sidebar.updateSaveStatus(this.saver.getSaveStats());
      // Rating sign mounted on the door lintel — keeps the visible star
      // count in sync with the actual restaurant rating.
      this.scene.updateRatingSign(this.game.reputation.getAverageRating());
      // Spawner diagnostic line — defaults to "waiting on world" until
      // the spawner is constructed (post-staffReady). Stub-router state
      // takes priority and surfaces as a red warning.
      if (this.usingStubRouter) {
        this.sidebar.updateSpawnerStatus({
          customers: 0, waiting: 0, seatsAvail: 0, seatsTotal: 0,
          overflow: 0, spawnInSec: 0, open: false, hasRegistry: false,
          tables: 0, chairs: 0, rawSlots: 0,
        });
        this.sidebar.spawnerStatus.textContent =
          "⚠ STUB ROUTER — staff models can't move. Hard-refresh once.";
        this.sidebar.spawnerStatus.style.color = "#ff5050";
        this.sidebar.spawnerStatus.style.opacity = "1";
      } else if (this.spawner) {
        this.sidebar.updateSpawnerStatus(this.spawner.getSpawnerStats());
      }
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
