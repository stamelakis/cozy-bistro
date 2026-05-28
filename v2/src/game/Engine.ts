import * as THREE from "three";
import { IsoCamera } from "../scene/IsoCamera";
import { WorldScene } from "../scene/WorldScene";
import { Game } from "./Game";
import { GuestSpawner } from "./GuestSpawner";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { PedestrianSpawner } from "./PedestrianSpawner";
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
import { StockStatusWidget } from "../ui/StockStatusWidget";
import { DecorModal } from "../ui/DecorModal";
import { DayEndModal } from "../ui/DayEndModal";
import { LedgerModal } from "../ui/LedgerModal";
import { HelpModal } from "../ui/HelpModal";
import { StatsModal } from "../ui/StatsModal";
import { AchievementsModal } from "../ui/AchievementsModal";
import { SlotsModal } from "../ui/SlotsModal";
import { AdminModal } from "../ui/AdminModal";
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
  errand?: ErrandRouter;
  pedestrians?: PedestrianSpawner;
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
  readonly stockWidget: StockStatusWidget;
  readonly decorModal: DecorModal;
  readonly dayEndModal: DayEndModal;
  readonly ledgerModal: LedgerModal;
  readonly helpModal: HelpModal;
  readonly statsModal: StatsModal;
  readonly achievementsModal: AchievementsModal;
  readonly slotsModal: SlotsModal;
  readonly adminModal: AdminModal;
  readonly cloudModal: CloudModal;
  readonly floatingText: FloatingText;
  readonly statusBubbles: StatusBubbles;
  readonly sfx: SfxPlayer;
  readonly saver: SaveSystem;
  readonly cloud: SpacetimeClient;

  private running = false;
  private lastResizeCheckAt = 0;
  private hudAccumulator = 0;
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
      openSlots: () => this.slotsModal.show(),
      openAdmin: () => this.adminModal.show(),
      openUpgrades: () => this.upgradeModal.show(),
      openDecor: () => this.decorModal.show(),
      openExpand: () => this.expandModal.show(),
      openPantry: () => this.pantryModal.show(),
      openCloud: () => this.cloudModal.show(),
      resetSave: () => this.resetSave(),
      isMuted: () => this.sfx.isMuted(),
      toggleMute: () => { this.sfx.setMuted(!this.sfx.isMuted()); return this.sfx.isMuted(); },
    });
    this.sidebar.addSeparator();
    this.expandWidget = new ExpandWidget(this.sidebar.body, this.game);
    this.sidebar.addSeparator();
    this.stockWidget = new StockStatusWidget(this.sidebar.body, this.game);
    this.sidebar.addSeparator();
    this.staffPanel = new StaffPanel(this.sidebar.body, this.game);
    // Modals still live on the page-level container so they overlay the world.
    this.pantryModal = new PantryModal(container, this.game);
    this.menuPanel = new MenuPanel(container, this.game);
    this.upgradeModal = new UpgradeModal(container, this.game);
    this.expandModal = new ExpandModal(container, this.game);
    // Update world visibility whenever the tier changes (player bought an expansion).
    this.game.onLuxuryTierChanged = (tier) => this.scene.setLuxuryTier(tier);
    this.decorModal = new DecorModal(container, this.game);
    // Wire theme changes to the live scene + restore the saved theme.
    this.game.onThemeChanged = (theme) => this.scene.setTheme(theme);
    this.scene.setTheme(this.game.getCurrentTheme());
    this.dayEndModal = new DayEndModal(container);
    this.game.onDayEnded = (summary) => {
      this.dayEndModal.show(summary);
      this.sfx.gong();
    };
    this.ledgerModal = new LedgerModal(container, this.game);
    this.helpModal = new HelpModal(container);
    this.statsModal = new StatsModal(container, this.game);
    this.achievementsModal = new AchievementsModal(container, this.game);
    this.slotsModal = new SlotsModal(container, this.saver.getActiveSlot(), this.cloud);
    this.adminModal = new AdminModal(container, this.game);
    this.cloudModal = new CloudModal(container, this.cloud);
    // Pop a toast above the door whenever an achievement unlocks.
    this.game.achievements.onUnlock = (a) => {
      // Floating text and sound; player can open the AchievementsModal for details.
      this.floatingText.pop(0, 5, `🏆 ${a.name}`, "#ffd986");
      this.sfx.chime();
    };
    // Auto-show the welcome modal on a brand-new visit.
    if (!HelpModal.hasBeenSeen()) this.helpModal.show();
    this.floatingText = new FloatingText(container, this.camera.threeCamera, this.renderer.domElement);
    this.statusBubbles = new StatusBubbles(container, this.camera.threeCamera, this.renderer.domElement);
    this.sfx = new SfxPlayer();
    // Furniture registry — tracks every placed item so it persists, supports
    // overlap detection, and can be sold via the build-menu sell mode.
    this.registry = new FurnitureRegistry(this.scene.threeScene, this.scene.loader);
    // Pathfinder reads the live registry each query — we don't have to
    // rebuild a grid when furniture is placed/moved/sold. PlacedFurnitureItem
    // has defId/x/z plus extras, so it satisfies the PathfinderItem shape
    // structurally.
    this.pathfind = new Pathfinding(() => this.registry.snapshotItems());
    this.seatMarkers = new SeatMarkers(this.scene.threeScene, this.registry);
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
      }));
      // After restore, the demo's door (with its hinge panel captured)
      // gets removed and the save's restored door comes in fresh —
      // re-capture the hinge panel so setDoorOpen actually animates it.
      // Same dance for the stove + cooking flame: pin the flame to the
      // restored stove model so it sits on the actual burner instead
      // of the default fallback height.
      //
      // For stoves we deliberately pick a SINGLE primary stove (the one
      // closest to the chef's working spot, scene.stovePos). The old
      // version iterated every stove and let the last one win, which
      // is why the player saw the flame on a stove the chef wasn't
      // working at.
      void this.registry.restore(restored).then(() => {
        let primaryStove: THREE.Object3D | undefined;
        let bestDist = Infinity;
        const sx = this.scene.stovePos.x, sz = this.scene.stovePos.y;
        for (const it of this.registry.snapshotItems()) {
          if (it.defId === "door") this.scene.attachDoorPanel(it.model);
          if (it.defId === "stove" || it.defId === "stove-electric") {
            const dx = it.x - sx, dz = it.z - sz;
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; primaryStove = it.model; }
          }
          // Re-register lamps so a freshly-loaded save still gets the
          // night illumination on every placed lamp without the player
          // having to move them. Category lookup beats id-by-id checks
          // because new lamp variants in the catalog get picked up for
          // free.
          const def = getFurnitureDef(it.defId);
          if (def?.category === "lamp") this.scene.registerLamp(it.model);
        }
        if (primaryStove) this.scene.alignStoveFlameToStove(primaryStove);
        // Doors restored from save → rebuild the front wall so the
        // gaps reflect where they actually live now.
        this.scene.rebuildFrontWall(this.frontWallDoorXs());
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
      // Now that the demo door is in the registry (or NOT, for a
      // saved game where it was sold), rebuild the front wall so it
      // has its gaps in the right places.
      this.scene.rebuildFrontWall(this.frontWallDoorXs());
    });
    // Let the Game read counts of placed sinks/dishwashers when scaling
    // the dish-wash interval.
    this.game.countPlacedById = (id) => this.registry.countById(id);
    this.game.registry = this.registry;
    // StaffPanel queries this to show "X working" badges.
    this.game.getStaffWorkingCount = (role) => {
      if (role === "chef") {
        return this.router?.snapshotStatus().filter((s) => s.role === "chef" && s.label).length ?? 0;
      }
      if (role === "waiter") {
        return this.router?.snapshotStatus().filter((s) => s.role === "waiter" && s.label).length ?? 0;
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
    // Build menu — for placing furniture at runtime.
    const buildMenu = new BuildMenu(container, this.game, this.scene.loader, this.scene.threeScene, this.camera.threeCamera, this.renderer.domElement, this.registry);
    buildMenu.seatMarkers = this.seatMarkers;
    buildMenu.onDoorPlaced = (model) => {
      this.scene.attachDoorPanel(model);
      // Door event invalidates the front-wall layout — rebuild from
      // whatever's now in the registry.
      this.scene.rebuildFrontWall(this.frontWallDoorXs());
    };
    buildMenu.onDoorRemoved = () => {
      this.scene.rebuildFrontWall(this.frontWallDoorXs());
    };
    buildMenu.onStovePlaced = (model) => this.scene.alignStoveFlameToStove(model);
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
        const baseCounts = { chef: 1, waiter: 1, errand: this.scene.errandChar ? 1 : 0 };
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
        );
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
      this.pedestrians = new PedestrianSpawner(this.scene.threeScene, this.scene.characterLoader, this.scene.animator);
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
      this.game.onTrainingCompleted = (member) => {
        // Find the actor's world position so the toast pops over the
        // right character. Fall back to the supply counter for errand
        // helpers offscreen.
        const worldPos = this.findMemberWorldPos(member.id);
        const label = `🎓 ${member.name} → L${member.upgradeLevel}`;
        this.floatingText?.pop(worldPos.x, worldPos.y - 0.4, label, "#ffd986");
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

    // Save on tab close.
    window.addEventListener("beforeunload", () => this.saver.saveNow());
    window.addEventListener("resize", this.handleResize);
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
    if (this.errand) {
      for (const h of this.errand.snapshotStatus()) {
        if (check(h.character.groundPos.x, h.character.groundPos.y)) return true;
      }
    }
    return false;
  }

  /** Build a fresh status-bubble list from the routers' + spawner's
   * current state. One entry per actor; empty label = no bubble. */
  private updateStatusBubbles(): void {
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
  private frontWallDoorXs(): number[] {
    const out: number[] = [];
    for (const it of this.registry.snapshotItems()) {
      const def = getFurnitureDef(it.defId);
      if (def?.category === "door" && Math.abs(it.z - 5.5) < 0.1) out.push(it.x);
    }
    return out;
  }

  /** Wipe the active save slot and reload. Asks for confirmation since
   * this is destructive. */
  private resetSave(): void {
    const slot = this.saver.getActiveSlot();
    const ok = window.confirm(`Reset slot ${slot} and start over? This wipes the current save and reloads the page.`);
    if (!ok) return;
    SaveSystem.deleteSlot(slot);
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
    const roles: ("chef" | "waiter" | "errand")[] = ["chef", "waiter", "errand"];
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
          : this.errand!.getHelperCount();
      console.log(`[syncStaff] ${role}: want=${members.length}, have=${have} (will spawn ${Math.max(0, members.length - have)})`);
      // Members 0..have-1 are already attached to actors (the base
      // char + any earlier extras). Spawn extras for the remaining
      // members and link each to its HiredStaffMember.id.
      for (let i = have; i < members.length; i += 1) {
        const member = members[i];
        const char = await this.scene.spawnExtraStaff(role, i);
        if (!char) {
          console.warn(`[syncStaff] ${role} extra #${i} (${member.name}) failed to load`);
          continue;
        }
        console.log(`[syncStaff] ${role} extra #${i} (${member.name}) spawned at (${char.groundPos.x.toFixed(2)}, ${char.groundPos.y.toFixed(2)})`);
        this.floatingText?.pop(char.groundPos.x, char.groundPos.y - 0.4,
          `+1 ${this.labelForRole(role)}: ${member.name}`, "#a8e2a8");
        if (role === "chef") this.router.addChef(char, member.id);
        else if (role === "waiter") this.router.addWaiter(char, member.id);
        else this.errand!.addHelper(char, member.id);
      }
    }
  }

  /** Spawn an extra staff character and slot them into the right router.
   * Picks an offset slot so multiple extras of the same role don't pile
   * onto a single spot. Pops a floating "+1 Role" toast at the new
   * character's spot so the player can see where to look. */
  private async handleStaffHired(role: "chef" | "waiter" | "errand"): Promise<void> {
    const currentInRouter = role === "chef"
      ? (this.router?.getChefCount() ?? 0)
      : role === "waiter"
        ? (this.router?.getWaiterCount() ?? 0)
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
    const char = await this.scene.spawnExtraStaff(role, offsetSlot);
    if (!char) {
      // Loading failed — still tell the player something visible.
      this.floatingText?.pop(0, -2.2, `+1 ${this.labelForRole(role)}: ${member.name} (load failed)`, "#ff9a9a");
      return;
    }
    this.floatingText?.pop(char.groundPos.x, char.groundPos.y - 0.4,
      `+1 ${this.labelForRole(role)}: ${member.name}`, "#a8e2a8");
    if (role === "chef") this.router?.addChef(char, member.id);
    else if (role === "waiter") this.router?.addWaiter(char, member.id);
    else this.errand?.addHelper(char, member.id);
  }

  private labelForRole(role: "chef" | "waiter" | "errand"): string {
    return role === "chef" ? "Chef" : role === "waiter" ? "Waiter" : "Errand";
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
  private handleStaffFired(role: "chef" | "waiter" | "errand"): void {
    let removed: { character: { root: import("three").Object3D } | null } | null = null;
    if (role === "chef") removed = { character: this.router?.removeChef() ?? null };
    else if (role === "waiter") removed = { character: this.router?.removeWaiter() ?? null };
    else removed = { character: this.errand?.removeHelper() ?? null };
    const model = removed?.character?.root;
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
    this.trash?.update(dt);
    // After all movement, run a personal-space pass so walking guests
    // + pedestrians don't stack on top of each other.
    if (dt > 0 && (this.spawner || this.pedestrians)) {
      const actors: MovableActor[] = [];
      if (this.spawner) actors.push(...this.spawner.snapshotMovable());
      if (this.pedestrians) actors.push(...this.pedestrians.snapshotMovable());
      PersonalSpace.apply(actors, dt);
    }
    // Stove flame mirrors chef working state. Drive it before scene.update
    // so the flame's flicker animation runs this frame. The cooking sizzle
    // tracks the same flag (per-stove-type profile to come once we wire
    // chefs to specific stoves).
    const cooking = this.router?.isAnyChefCooking() ?? false;
    this.scene.setStoveFlame(cooking);
    if (cooking) this.sfx.startCookingLoop("stove");
    else this.sfx.stopCookingLoop();
    // Open the door when a guest, errand helper, or pedestrian is close.
    this.scene.setDoorOpen(this.anyoneNearDoor());
    // Day/night lighting follows the in-game day timer.
    const day = this.scene.applyDayNight(this.game.day.getDayProgress());
    this.renderer.setClearColor(day.skyColor);
    if (this.scene.threeScene.fog instanceof THREE.Fog) {
      this.scene.threeScene.fog.color.setHex(day.skyColor);
    }
    this.scene.update(dt);
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
