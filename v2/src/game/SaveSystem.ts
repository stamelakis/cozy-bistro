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

  constructor(game: Game) {
    this.game = game;
    this.activeSlot = readActiveSlot();
  }

  getActiveSlot(): number { return this.activeSlot; }

  /** Read the active slot's previously-saved state. */
  static loadFromStorage(): SaveGameState | undefined {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(slotKey(readActiveSlot()));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as SaveGameState;
    } catch {
      console.warn("Save data was corrupt; starting fresh.");
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
    if (typeof localStorage === "undefined") return;
    const state = this.snapshot();
    try {
      localStorage.setItem(slotKey(this.activeSlot), JSON.stringify(state));
    } catch (e) {
      console.warn("Save failed (quota?):", e);
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

  /** Build a SaveGameState snapshot from the current game systems. */
  private snapshot(): SaveGameState {
    return {
      money: this.game.economy.getMoney(),
      reputation: this.game.reputation.getReputation(),
      dayNumber: this.game.day.getDayNumber(),
      unlockedRecipeIds: this.game.cooking.getUnlockedRecipeIdsSnapshot(),
      menuRecipeIds: this.game.cooking.getMenuRecipeIdsSnapshot(),
      recipeUpgradeLevels: this.game.cooking.getRecipeUpgradeLevelsSnapshot(),
      // Persist player-placed furniture so layouts survive reloads. The 2D
      // PlacedFurniture shape uses {position:{x,y}, rotation:degrees}.
      // World x/z snap to integer cells, so position is lossless. rotation
      // is multiples of 90° (BuildMenu only rotates in quarters), so degree
      // rounding is also lossless.
      furniture: this.registry
        ? (this.registry.snapshot().map((p) => ({
            uid: p.uid,
            furnitureId: p.defId,
            position: { x: p.x, y: p.z },
            rotation: Math.round((p.rotY * 180) / Math.PI),
          })) as PlacedFurniture[])
        : [],
      ingredients: this.game.cooking.getPantrySnapshot(),
      preparedServings: this.game.cooking.getPreparedServingsSnapshot(),
      staff: this.game.staff.getStaff(),
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
      dirtyDishCount: this.game.getDirtyDishCount(),
      lastSavedAt: Date.now(),
      transactionLog: [...this.game.economy.getTransactionLog()],
    };
  }
}
