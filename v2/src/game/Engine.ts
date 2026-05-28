import * as THREE from "three";
import { IsoCamera } from "../scene/IsoCamera";
import { WorldScene } from "../scene/WorldScene";
import { Game } from "./Game";
import { GuestSpawner } from "./GuestSpawner";
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
import { FloatingText } from "../ui/FloatingText";
import { StatusBubbles, type StatusEntry } from "../ui/StatusBubbles";
import { SfxPlayer } from "../ui/SfxPlayer";
import { StaffRouter } from "./StaffRouter";
import { ErrandRouter } from "./ErrandRouter";
import { FurnitureRegistry } from "./FurnitureRegistry";
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
    this.slotsModal = new SlotsModal(container, this.saver.getActiveSlot());
    this.adminModal = new AdminModal(container, this.game);
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
      void this.registry.restore(restored);
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
    });
    // Let the Game read counts of placed sinks/dishwashers when scaling
    // the dish-wash interval.
    this.game.countPlacedById = (id) => this.registry.countById(id);
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
    // Build menu — for placing furniture at runtime.
    new BuildMenu(container, this.game, this.scene.loader, this.scene.threeScene, this.camera.threeCamera, this.renderer.domElement, this.registry);

    // Spawner + router need the staff characters. Wait until WorldScene
    // finishes loading them, then construct.
    void this.scene.staffReady.then(() => {
      if (!this.scene.chefChar || !this.scene.waiterChar) {
        console.warn("Staff characters unavailable — spawner running without staff routing");
        this.spawner = new GuestSpawner(this.scene.threeScene, this.scene.characterLoader, this.scene.animator, this.game, this.buildStubRouter());
        return;
      }
      this.router = new StaffRouter(this.scene.chefChar, this.scene.waiterChar, this.scene.stovePos, this.scene.pickupPos);
      this.spawner = new GuestSpawner(this.scene.threeScene, this.scene.characterLoader, this.scene.animator, this.game, this.router);
      this.spawner.floatingText = this.floatingText;
      this.spawner.sfx = this.sfx;
      this.spawner.registry = this.registry;
      this.pedestrians = new PedestrianSpawner(this.scene.threeScene, this.scene.characterLoader, this.scene.animator);
      this.trash = new TrashSpawner(this.scene.threeScene, this.game);
      // Errand helper — runs to door + back whenever auto-shop fires.
      if (this.scene.errandChar) {
        this.errand = new ErrandRouter(this.scene.errandChar, this.scene.doorPos);
        this.game.onAutoShop = () => this.errand?.triggerRun();
      }
      // Wire hire/fire callbacks now that the routers exist. The first
      // staff member of each role is already part of populateCharacters
      // and was added to the router by the constructor; hiring extras
      // spawns brand-new characters that get added to the pool.
      this.game.onStaffHired = (role) => {
        void this.handleStaffHired(role);
      };
      this.game.onStaffFired = (role) => {
        this.handleStaffFired(role);
      };
      // Restore any extra hired staff from the save. The base 3 characters
      // (1 chef, 1 waiter, 1 errand) are already in the world; if the save
      // shows more, spawn the difference so what the player sees matches
      // what they're paying payroll for.
      void this.syncStaffToHeadcount();
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
   * in the rest on load. */
  private async syncStaffToHeadcount(): Promise<void> {
    if (!this.router || !this.errand) return;
    const roles: ("chef" | "waiter" | "errand")[] = ["chef", "waiter", "errand"];
    for (const role of roles) {
      const want = this.game.staff.getStaffCount(role);
      // The starter character counts as 1 if hired. If StaffSystem says 0,
      // we leave the starter standing (cosmetic only — it won't grab tickets
      // because we'd remove it, but for simplicity keep the body around).
      const have = role === "chef"
        ? this.router.getChefCount()
        : role === "waiter"
          ? this.router.getWaiterCount()
          : this.errand.getHelperCount();
      // Spawn missing extras. We bypass handleStaffHired because that one
      // is for player-triggered hires; here we're just restoring visuals.
      for (let i = have; i < Math.max(want, 1); i += 1) {
        const char = await this.scene.spawnExtraStaff(role, i);
        if (!char) continue;
        if (role === "chef") this.router.addChef(char);
        else if (role === "waiter") this.router.addWaiter(char);
        else this.errand.addHelper(char);
      }
    }
  }

  /** Spawn an extra staff character and slot them into the right router.
   * Picks an offset slot so multiple extras of the same role don't pile
   * onto a single spot. */
  private async handleStaffHired(role: "chef" | "waiter" | "errand"): Promise<void> {
    // The starter character at populateCharacters time is index 0; extras
    // start at offsetSlot=1.
    const currentInRouter = role === "chef"
      ? (this.router?.getChefCount() ?? 0)
      : role === "waiter"
        ? (this.router?.getWaiterCount() ?? 0)
        : (this.errand?.getHelperCount() ?? 0);
    const offsetSlot = currentInRouter; // 0 is the starter (already placed), so first extra is 1
    const char = await this.scene.spawnExtraStaff(role, offsetSlot);
    if (!char) return;
    if (role === "chef") this.router?.addChef(char);
    else if (role === "waiter") this.router?.addWaiter(char);
    else this.errand?.addHelper(char);
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
    // so the flame's flicker animation runs this frame.
    this.scene.setStoveFlame(this.router?.isAnyChefCooking() ?? false);
    // Open the door when a guest, errand helper, or pedestrian is close.
    this.scene.setDoorOpen(this.anyoneNearDoor());
    // Day/night lighting follows the in-game day timer.
    const day = this.scene.applyDayNight(this.game.day.getDayProgress());
    this.renderer.setClearColor(day.skyColor);
    if (this.scene.threeScene.fog instanceof THREE.Fog) {
      this.scene.threeScene.fog.color.setHex(day.skyColor);
    }
    this.scene.update(dt);
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
      this.hudAccumulator = 0;
    }

    this.renderer.render(this.scene.threeScene, this.camera.threeCamera);
  };
}
