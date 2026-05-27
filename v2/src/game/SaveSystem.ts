import type { SaveGameState } from "../data/types";
import type { Game } from "./Game";

/**
 * localStorage-backed save/load. Snapshots Game state periodically so
 * progress survives page reloads. Format mirrors the 2D SaveGameState
 * so we could in theory load a 2D save here, though guests/staff
 * actor positions don't carry over because the worlds aren't compatible.
 */

const STORAGE_KEY = "cozy-bistro-3d-save";
const AUTOSAVE_INTERVAL_SECONDS = 5;

export class SaveSystem {
  private readonly game: Game;
  private elapsed = 0;

  constructor(game: Game) {
    this.game = game;
  }

  /** Read a previously-saved state from localStorage, or undefined if none. */
  static loadFromStorage(): SaveGameState | undefined {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as SaveGameState;
    } catch {
      console.warn("Save data was corrupt; starting fresh.");
      return undefined;
    }
  }

  /** Manually trigger a save right now (e.g. on `beforeunload`). */
  saveNow(): void {
    if (typeof localStorage === "undefined") return;
    const state = this.snapshot();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
      furniture: [], // v2 hard-codes the layout for now; will populate when build/buy UI lands
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
      lastSavedAt: Date.now(),
      transactionLog: [...this.game.economy.getTransactionLog()],
    };
  }
}
