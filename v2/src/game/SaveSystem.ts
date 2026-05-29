import type { SaveGameState, PlacedFurniture } from "../data/types";
import type { Game } from "./Game";
import type { FurnitureRegistry } from "./FurnitureRegistry";

/**
 * localStorage-backed save/load with slot support. Game state is
 * snapshotted to whatever the active slot is (1-3 by default).
 * Switching slots writes the active id to localStorage and reloads,
 * giving the player parallel timelines.
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

export class SaveSystem {
  private readonly game: Game;
  /** Optional — Engine sets this after the registry is constructed. */
  registry?: FurnitureRegistry;
  private elapsed = 0;
  private readonly activeSlot: number;
  /** Saves performed in this session — surfaced via getSaveStats() for the
   * HUD diagnostic readout. */
  private saveCount = 0;
  private lastSaveMs = 0;
  private lastSaveBytes = 0;
  private lastSaveOk = true;
  private lastSaveError = "";

  constructor(game: Game) {
    this.game = game;
    this.activeSlot = readActiveSlot();
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

  /** Manually trigger a save right now (e.g. on `beforeunload`). */
  saveNow(): void {
    if (typeof localStorage === "undefined") {
      this.lastSaveOk = false;
      this.lastSaveError = "localStorage unavailable";
      console.warn("[Save] localStorage not available — save skipped");
      return;
    }
    let json: string;
    try {
      const state = this.snapshot();
      json = JSON.stringify(state);
    } catch (e) {
      this.lastSaveOk = false;
      this.lastSaveError = `snapshot error: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[Save] snapshot/serialize failed:", e);
      return;
    }
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

  /** Per-frame tick. Autosaves on a fixed interval. */
  update(dt: number): void {
    this.elapsed += dt;
    if (this.elapsed >= AUTOSAVE_INTERVAL_SECONDS) {
      this.elapsed = 0;
      this.saveNow();
    }
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
      themeId: this.game.getCurrentTheme().id,
      restaurantName: this.game.getRestaurantName(),
      signStyle: this.game.getRestaurantSignStyle(),
      // Snapshot in-flight plate reservations so a refresh doesn't
      // silently lose every plate held by a mid-meal guest.
      inFlightDishes: this.game.getInFlightDishesForSave(),
      // High-water total of all dishware ever added. On load the
      // hydrate path tops up the clean pool to match this so any
      // pieces that leaked during play return as clean.
      dishwareLifetime: this.game.dishware.getLifetimeAddedByKind(),
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
