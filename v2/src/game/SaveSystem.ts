import type { SaveGameState, PlacedFurniture } from "../data/types";
import type { Game } from "./Game";
import type { FurnitureRegistry } from "./FurnitureRegistry";

/**
 * localStorage-backed save/load with slot support. Game state is
 * snapshotted to whatever the active slot is (1-3 by default).
 * Switching slots writes the active id to localStorage and reloads,
 * giving the player parallel timelines.
 *
 * Performance: `JSON.stringify` on a mature save costs 5-15 ms which,
 * stacked on top of the per-frame budget, surfaced as a periodic
 * micro-stutter at the autosave cadence. The serialize step is now
 * pushed onto a Web Worker (saveWorker.ts); the main thread only owns
 * the snapshot extraction (must read live game state) and the actual
 * localStorage write (browser API isn't worker-visible). For the
 * `beforeunload` path a synchronous fallback stays on the main thread
 * — the page might close before a worker round-trip completes.
 */

const STORAGE_PREFIX = "cozy-bistro-3d-save";
const ACTIVE_SLOT_KEY = "cozy-bistro-3d-active-slot";
const AUTOSAVE_INTERVAL_SECONDS = 5;
export const MAX_SLOTS = 3;

function slotKey(slot: number): string {
  // Slot 1 reuses the legacy key for backwards compat with existing saves.
  if (slot === 1) return STORAGE_PREFIX;
  return `${STORAGE_PREFIX}-${slot}`;
}

function readActiveSlot(): number {
  if (typeof localStorage === "undefined") return 1;
  const raw = Number(localStorage.getItem(ACTIVE_SLOT_KEY));
  return Number.isFinite(raw) && raw >= 1 && raw <= MAX_SLOTS ? Math.floor(raw) : 1;
}

export interface SlotInfo {
  slot: number;
  exists: boolean;
  money?: number;
  day?: number;
  lastSavedAt?: number;
}

/** Response shape from the save worker — kept in sync with saveWorker.ts. */
type WorkerResponse =
  | { id: number; ok: true; json: string }
  | { id: number; ok: false; error: string };

export class SaveSystem {
  private readonly game: Game;
  /** Optional — Engine sets this after the registry is constructed. */
  registry?: FurnitureRegistry;
  // Phase I (H.67) — `elapsed` accumulator was the per-frame autosave
  // timer.  The autosave loop is disabled now (see update()); the
  // field is removed.  Kept the AUTOSAVE_INTERVAL_SECONDS constant
  // alive as a documentation breadcrumb.
  private readonly activeSlot: number;
  /** Saves performed in this session — surfaced via getSaveStats() for the
   * HUD diagnostic readout. */
  private saveCount = 0;
  private lastSaveMs = 0;
  private lastSaveBytes = 0;
  private lastSaveOk = true;
  private lastSaveError = "";

  /** Off-thread serializer. Constructed once at boot and reused for the
   * lifetime of the page. Falls back to main-thread stringify if the
   * worker can't be created (e.g. unsupported environment). */
  private worker: Worker | null = null;
  private nextReqId = 1;
  private readonly pending = new Map<number, (res: WorkerResponse) => void>();
  /** Set while an async save is in flight so back-to-back autosave timers
   * don't pile up multiple snapshots ahead of the worker. */
  private saveInFlight = false;

  constructor(game: Game) {
    this.game = game;
    this.activeSlot = readActiveSlot();
    this.initWorker();
  }

  /** Boot the save serializer worker. Best-effort: on failure we silently
   * keep the main-thread stringify path so the game never gets stuck
   * "unable to save". */
  private initWorker(): void {
    try {
      // Vite resolves the URL at build time and bundles the worker as a
      // separate chunk; this is the canonical module-worker pattern.
      this.worker = new Worker(new URL("../workers/saveWorker.ts", import.meta.url), { type: "module" });
      this.worker.addEventListener("message", (ev: MessageEvent<WorkerResponse>) => {
        const cb = this.pending.get(ev.data.id);
        if (!cb) return;
        this.pending.delete(ev.data.id);
        cb(ev.data);
      });
      this.worker.addEventListener("error", (e) => {
        console.warn("[SaveSystem] worker error event:", e.message || e);
      });
    } catch (e) {
      console.warn("[SaveSystem] worker init failed — using main-thread serialize:", e);
      this.worker = null;
    }
  }

  /** Serialize the snapshot off-thread. Resolves to the JSON string the
   * caller can hand to `localStorage.setItem` (or a network call).
   * Falls back to a main-thread `JSON.stringify` if the worker isn't
   * available. */
  serializeAsync(state: SaveGameState): Promise<string> {
    if (!this.worker) {
      try {
        return Promise.resolve(JSON.stringify(state));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    const id = this.nextReqId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, (res) => {
        if (res.ok) resolve(res.json);
        else reject(new Error(res.error));
      });
      try {
        this.worker!.postMessage({ id, state });
      } catch (e) {
        this.pending.delete(id);
        // Failed structuredClone or similar — drop back to sync.
        try { resolve(JSON.stringify(state)); }
        catch (e2) { reject(e2); }
        // Suppress unused-variable lint without losing the original.
        void e;
      }
    });
  }

  getActiveSlot(): number { return this.activeSlot; }

  /** Diagnostic — current session save stats so the HUD can show
   * "Saved 12s ago · 387 KB · slot 1" when the player wonders if their
   * progress is being persisted. */
  getSaveStats(): { count: number; lastMs: number; bytes: number; ok: boolean; error: string; slot: number } {
    return {
      count: this.saveCount,
      lastMs: this.lastSaveMs,
      bytes: this.lastSaveBytes,
      ok: this.lastSaveOk,
      error: this.lastSaveError,
      slot: this.activeSlot,
    };
  }

  /** Read the active slot's previously-saved state. */
  static loadFromStorage(): SaveGameState | undefined {
    if (typeof localStorage === "undefined") {
      console.warn("[Load] localStorage unavailable — starting fresh");
      return undefined;
    }
    const slot = readActiveSlot();
    const raw = localStorage.getItem(slotKey(slot));
    if (!raw) {
      console.log(`[Load] no save found in slot ${slot} — starting fresh`);
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as SaveGameState;
      console.log(`[Load] restored slot ${slot} (${(raw.length / 1024).toFixed(1)} KB · day ${parsed.dayNumber} · $${parsed.money})`);
      return parsed;
    } catch (e) {
      console.warn(`[Load] save in slot ${slot} corrupt — starting fresh`, e);
      return undefined;
    }
  }

  /** List metadata for every slot — for the slot picker UI. */
  static listSlots(): SlotInfo[] {
    const out: SlotInfo[] = [];
    for (let i = 1; i <= MAX_SLOTS; i += 1) {
      const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(slotKey(i));
      if (!raw) { out.push({ slot: i, exists: false }); continue; }
      try {
        const parsed = JSON.parse(raw) as SaveGameState;
        out.push({
          slot: i, exists: true,
          money: parsed.money,
          day: parsed.dayNumber,
          lastSavedAt: parsed.lastSavedAt,
        });
      } catch {
        out.push({ slot: i, exists: false });
      }
    }
    return out;
  }

  /** Switch to a different slot and reload — the new slot becomes
   * active and its (possibly empty) save is loaded as the game state. */
  static switchToSlot(slot: number): void {
    if (slot < 1 || slot > MAX_SLOTS) return;
    try {
      localStorage.setItem(ACTIVE_SLOT_KEY, String(slot));
    } catch (e) { console.warn(e); }
    window.location.reload();
  }

  /** Erase the given slot. */
  static deleteSlot(slot: number): void {
    if (slot < 1 || slot > MAX_SLOTS) return;
    try { localStorage.removeItem(slotKey(slot)); } catch (e) { console.warn(e); }
  }

  /** Manually trigger a save right now. Async path — the stringify runs
   * on a worker so the main thread keeps rendering. Use {@link saveNowSync}
   * for `beforeunload` / `pagehide` where the page may close before the
   * round-trip completes. */
  saveNow(): void {
    if (typeof localStorage === "undefined") {
      this.lastSaveOk = false;
      this.lastSaveError = "localStorage unavailable";
      console.warn("[Save] localStorage not available — save skipped");
      return;
    }
    // Coalesce: drop this autosave tick if the previous one is still in
    // the worker. The next tick will catch up. Avoids piling up snapshots
    // when the worker can't keep pace (worst case: a very slow machine).
    if (this.saveInFlight) return;
    let state: SaveGameState;
    try {
      state = this.snapshot();
    } catch (e) {
      this.lastSaveOk = false;
      this.lastSaveError = `snapshot error: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[Save] snapshot failed:", e);
      return;
    }
    this.saveInFlight = true;
    this.serializeAsync(state).then(
      (json) => { this.saveInFlight = false; this.writeJson(json); },
      (err) => {
        this.saveInFlight = false;
        this.lastSaveOk = false;
        this.lastSaveError = `serialize failed: ${err instanceof Error ? err.message : String(err)}`;
        console.error("[Save] serialize failed:", err);
      },
    );
  }

  /** Synchronous save — for `beforeunload` / `pagehide` where the page
   * may close before a worker postMessage round-trip completes. Same
   * stringify cost as before this file was workerified, but only runs on
   * the rare exit path. */
  saveNowSync(): void {
    if (typeof localStorage === "undefined") return;
    let json: string;
    try {
      const state = this.snapshot();
      json = JSON.stringify(state);
    } catch (e) {
      this.lastSaveOk = false;
      this.lastSaveError = `snapshot error: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[Save] sync snapshot/serialize failed:", e);
      return;
    }
    this.writeJson(json);
  }

  /** Common tail of {@link saveNow} and {@link saveNowSync} — write the
   * serialized string to localStorage + update the stats. Split out so
   * both the async (worker) and sync (beforeunload) paths share it. */
  private writeJson(json: string): void {
    try {
      localStorage.setItem(slotKey(this.activeSlot), json);
      this.saveCount += 1;
      this.lastSaveMs = Date.now();
      this.lastSaveBytes = json.length;
      this.lastSaveOk = true;
      this.lastSaveError = "";
      // Every 10th save also logs to console so devs/players opening
      // DevTools can confirm autosave is working. Avoid spam at 0.2 Hz.
      if (this.saveCount === 1 || this.saveCount % 10 === 0) {
        console.log(`[Save] slot ${this.activeSlot} · ${(json.length / 1024).toFixed(1)} KB · save #${this.saveCount}`);
      }
    } catch (e) {
      this.lastSaveOk = false;
      this.lastSaveError = `write failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[Save] write failed (quota? private mode?):", e);
    }
  }

  /** Per-frame tick.  Phase I (H.67) — autosave loop DISABLED.
   *
   * The game is fully server-authoritative now: every meaningful
   * mutation (furniture moves, staff hires, money, day clock, recipe
   * upgrades, salary accrual, transactions, ratings, day history,
   * achievements) mirrors to a dedicated cloud table.  Cloud is the
   * source of truth.  A periodic local save was both:
   *   1. Burning CPU / IndexedDB writes for state that no longer
   *      needed local persistence, AND
   *   2. CAUSING DATA-LOSS BUGS: a stale local save could finish
   *      writing AFTER a fresh cloud mirror, then on reload the
   *      restore-then-restoreFromCloud race let the stale save win.
   *      (Race fixed separately in Engine.ts, but the underlying
   *      duplication of state was the root cause.)
   *
   * The beforeunload sync save (Engine.ts saveNowSync) is preserved
   * as a defense-in-depth offline-fallback for now — if the cloud
   * connection drops mid-session, the next reload at least gets
   * the most recent local snapshot.  AUTOSAVE_INTERVAL_SECONDS is
   * kept for the diagnostic stat output but no longer drives a save.
   *
   * Per the user: "an online game doesn't need autosave". */
  update(_dt: number): void {
    // Intentionally empty.  See H.67 comment above.
    void AUTOSAVE_INTERVAL_SECONDS;
  }

  /** Build a snapshot the cloud bridge can JSON-stringify and ship. */
  snapshotForCloud(): SaveGameState {
    return this.snapshot();
  }

  /** Build a SaveGameState snapshot from the current game systems. */
  private snapshot(): SaveGameState {
    return {
      money: this.game.economy.getMoney(),
      reputation: this.game.reputation.getReputation(),
      dayNumber: this.game.day.getDayNumber(),
      restaurantOpen: this.game.restaurantOpen,
      unlockedRecipeIds: this.game.cooking.getUnlockedRecipeIdsSnapshot(),
      menuRecipeIds: this.game.cooking.getMenuRecipeIdsSnapshot(),
      recipeUpgradeLevels: this.game.cooking.getRecipeUpgradeLevelsSnapshot(),
      recipeTrainingCompletesAt: this.game.cooking.getRecipeTrainingSnapshot(),
      // Persist player-placed furniture so layouts survive reloads. The 2D
      // PlacedFurniture shape uses {position:{x,y}, rotation:degrees}.
      // World x/z snap to integer cells, so position is lossless. rotation
      // is multiples of 90° (BuildMenu only rotates in quarters), so degree
      // rounding is also lossless.
      furniture: this.registry
        ? (this.registry.snapshot().map((p) => {
            const out: PlacedFurniture = {
              uid: p.uid,
              furnitureId: p.defId,
              position: { x: p.x, y: p.z },
              rotation: Math.round((p.rotY * 180) / Math.PI),
            };
            // Persist surface-host link so toasters / coffee machines
            // / blenders re-snap to their counter top on reload
            // instead of dropping to y=0.
            if (p.parentUid) out.parentUid = p.parentUid;
            if (typeof p.slotIndex === "number") out.slotIndex = p.slotIndex;
            // Persist the player's surface-rotation offset so a
            // toaster turned 90° via R survives reload. Without this
            // the registry's restore second pass forces the child
            // back to host.rotY.
            if (typeof p.localRotY === "number") out.localRotY = p.localRotY;
            // Multi-storey: persist which floor the item lives on so
            // upper-floor placements survive reload. Without this an
            // item placed on Floor 1 round-trips as floor=0 and lands
            // on the ground after refresh — the visible "items vanish
            // on Floor 1 after reload" symptom.
            if (typeof p.floor === "number" && p.floor > 0) out.floor = p.floor;
            return out;
          }))
        : [],
      ingredients: this.game.cooking.getPantrySnapshot(),
      preparedServings: this.game.cooking.getPreparedServingsSnapshot(),
      staff: this.game.staff.getStaff(),
      staffMembers: this.game.staff.snapshotMembers(),
      ratingTotal: this.game.reputation.getRatingTotal(),
      ratingCount: this.game.reputation.getRatingCount(),
      ratingHistory: this.game.reputation.getRatingHistorySnapshot(),
      dailyServed: this.game.customers.getDailyServed(),
      dailyLost: this.game.customers.getDailyLost(),
      dailyRevenue: this.game.economy.getDailyRevenue(),
      dailyExpenses: this.game.economy.getDailyExpenses(),
      rentElapsedSeconds: this.game.day.getRentElapsedSeconds(),
      totalPlaySeconds: this.game.day.getTotalPlaySeconds(),
      // 2D stored expansionLevel as 0..8 where 0 = no expansions and the
      // playable tier was expansionLevel + 1. We persist in the same shape
      // so a 2D save would round-trip cleanly.
      expansionLevel: this.game.getLuxuryTier() - 1,
      dayHistory: this.game.history.snapshot(),
      achievements: this.game.achievements.snapshot(),
      achievementsClaimed: this.game.achievements.snapshotClaimed(),
      // Lifetime player counters — fed by the various interaction
      // sites (BuildMenu place, DecorModal theme apply, ExpandWidget
      // boost, VisitMode enter, ChatPanel send, weather tint tick)
      // and consumed by the achievement predicates.
      playerCounters: {
        furniturePlaced: this.game.playerCounters.furniturePlaced,
        themeChanges: this.game.playerCounters.themeChanges,
        themesTried: Array.from(this.game.playerCounters.themesTried),
        visitsOut: this.game.playerCounters.visitsOut,
        visitsIn: this.game.playerCounters.visitsIn,
        chatsSent: this.game.playerCounters.chatsSent,
        boostsUsed: this.game.playerCounters.boostsUsed,
        weathersSeen: Array.from(this.game.playerCounters.weathersSeen),
      },
      themeId: this.game.getCurrentTheme().id,
      themeByFloor: this.game.snapshotThemesByFloor(),
      restaurantName: this.game.getRestaurantName(),
      signStyle: this.game.getRestaurantSignStyle(),
      // Snapshot in-flight plate reservations so a refresh doesn't
      // silently lose every plate held by a mid-meal guest.
      inFlightDishes: this.game.getInFlightDishesForSave(),
      // High-water total of all dishware ever added. On load the
      // hydrate path tops up the clean pool to match this so any
      // pieces that leaked during play return as clean.
      dishwareLifetime: this.game.dishware.getLifetimeAddedByKind(),
      // Append-only audit log of every dishware purchase. STARTER +
      // sum(log) is the immutable ground truth for lifetime totals
      // — if the in-game pool ever drifts, admin can call
      // reconcileToPurchaseLog to rewind back to exactly what the
      // player actually bought.
      dishwarePurchases: this.game.dishware.getPurchaseLog().slice(),
      // Per-tier dish/glass snapshot. Legacy dirtyDishCount is no
      // longer written — the new field has strictly more info, and
      // the loader handles either.
      dishware: this.game.dishware.snapshot(),
      autoShopEnabled: this.game.autoShopEnabled,
      stockTarget: this.game.getStockTarget(),
      lastSavedAt: Date.now(),
      transactionLog: [...this.game.economy.getTransactionLog()],
    };
  }
}
