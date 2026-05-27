import { EconomySystem } from "../systems/EconomySystem";
import { ReputationSystem } from "../systems/ReputationSystem";
import { CookingSystem } from "../systems/CookingSystem";
import { CustomerSystem } from "../systems/CustomerSystem";
import { DayCycleSystem, rentIntervalSeconds } from "../systems/DayCycleSystem";
import { StaffSystem } from "../systems/StaffSystem";
import { recipes } from "../data/recipes";
import type { IngredientStock, LuxuryTier, RecipeDefinition, SaveGameState } from "../data/types";

/** Highest luxury tier the player can unlock. */
const MAX_LUXURY_TIER: LuxuryTier = 5;
/** Cost to go from tier N to tier N+1: BASE * GROWTH^(N-1). */
const EXPANSION_BASE_COST = 500;
const EXPANSION_GROWTH = 3;

/** Money charged automatically per in-game day. */
const DAILY_RENT = 40;
/** Money charged per staff member per real minute. */
const PAYROLL_PER_STAFF_PER_MINUTE = 6;
/** Cost per unit of ingredient when auto-shopping. */
export const INGREDIENT_UNIT_COST = 2;
/** Auto-shop tries to keep each ingredient stocked at this level. */
const STOCK_TARGET = 8;
/** Auto-shop runs this often (seconds). */
const AUTOSHOP_INTERVAL = 4;
/** Each recipe-upgrade level multiplies sellPrice by 1 + this. */
const UPGRADE_PRICE_BONUS_PER_LEVEL = 0.30;
/** Each recipe-upgrade level adds this much to satisfactionEffect. */
const UPGRADE_SATISFACTION_PER_LEVEL = 1.5;

/**
 * Top-level game logic. Owns the rule-system instances and drives them per
 * tick. Pure logic — knows nothing about Three.js or DOM. The scene layer
 * reads from this to render and the UI layer reads from this to display.
 */
export class Game {
  readonly economy: EconomySystem;
  readonly reputation: ReputationSystem;
  readonly cooking: CookingSystem;
  readonly customers: CustomerSystem;
  readonly day: DayCycleSystem;
  readonly staff: StaffSystem;

  /** Auto-shop accumulator (seconds since last attempt). */
  private autoShopClock = 0;
  /** Set false to disable auto-shop (player will have to manage stock manually). */
  autoShopEnabled = true;
  /** Current luxury tier (1..5). Raised by buyExpansion(); controls which
   * recipes the player can unlock through the menu picker. */
  private luxuryTier: LuxuryTier = 1;
  /** Optional callback fired once per auto-shop tick that actually bought
   * something. Engine wires this to the ErrandRouter so the helper makes
   * a visible door trip. Receiver should be cheap (queue, don't block). */
  onAutoShop?: () => void;

  constructor(save?: SaveGameState) {
    this.economy = new EconomySystem();
    this.reputation = new ReputationSystem();
    this.cooking = new CookingSystem();
    this.customers = new CustomerSystem();
    this.day = new DayCycleSystem();
    this.staff = new StaffSystem();
    if (save) this.hydrate(save);
    // Seed the cooking menu with one default recipe so guests have
    // something to order. (CookingSystem hydrate would handle this on
    // load; for a fresh game we need to bootstrap it manually.)
    if (!save) {
      this.cooking.syncLuxuryUnlocks(this.luxuryTier);
      if (this.cooking.getMenuRecipeIds().length === 0) {
        this.cooking.addToMenu("toast");
      }
    }
    this.seedPantryIfEmpty();
  }

  /** Walk all known recipes once and ensure each unique ingredient has a
   * pantry entry. Without this, addPantryStock is a no-op (because the
   * pantry was empty), so the auto-shop has nothing to refill. */
  private seedPantryIfEmpty(): void {
    const pantry = this.cooking.getPantryRaw();
    const known = new Set(pantry.map((s) => s.id));
    const allIngredients = new Set<string>();
    for (const r of recipes) for (const ing of r.ingredients) allIngredients.add(ing);
    let added = false;
    for (const ingredientId of allIngredients) {
      if (!known.has(ingredientId)) {
        // Slot in a fresh stock with a small starter quantity so the game
        // is immediately playable on day one.
        const stock: IngredientStock = { id: ingredientId, name: prettifyIngredientId(ingredientId), quantity: 4 };
        pantry.push(stock);
        added = true;
      }
    }
    if (added) {
      // CookingSystem holds the pantry array by reference, so push works.
      // No further bookkeeping needed.
    }
  }

  /** Per-frame tick. dt is seconds since last call. */
  update(dt: number): void {
    // DayCycleSystem returns whether a day just rolled over so we can
    // trigger end-of-day events (collect rent, reset daily counters, etc).
    const dayTick = this.day.tick(dt);
    if (dayTick.dayEnded) {
      this.rolloverDay();
    }
    // Rent ticks on the slow "rent period" timer (default = 1 in-game day).
    const rentPeriodsDue = this.day.consumePendingRentPeriods(rentIntervalSeconds);
    if (rentPeriodsDue > 0) {
      this.economy.forceSpendMoney(DAILY_RENT * rentPeriodsDue, "rent");
    }
    // Payroll runs continuously while staff are hired. tickSalary takes
    // a millisecond timestamp and internally rate-limits its own charges.
    const payroll = this.staff.tickSalary(this.day.getTotalPlaySeconds() * 1000, PAYROLL_PER_STAFF_PER_MINUTE);
    if (payroll.charge > 0) {
      this.economy.forceSpendMoney(payroll.charge, "charge");
    }
    // Auto-shop: refill any ingredient below STOCK_TARGET, 1 unit per tick
    // (so a long shortage costs more money than a brief one and the player
    // can react before going bankrupt).
    this.autoShopClock += dt;
    if (this.autoShopEnabled && this.autoShopClock >= AUTOSHOP_INTERVAL) {
      this.autoShopClock = 0;
      const pantry = this.cooking.getPantryRaw();
      let purchased = false;
      for (const stock of pantry) {
        if (stock.quantity >= STOCK_TARGET) continue;
        if (!this.economy.spendMoney(INGREDIENT_UNIT_COST, "ingredients")) break;
        stock.quantity += 1;
        purchased = true;
      }
      if (purchased && this.onAutoShop) this.onAutoShop();
    }
  }

  hydrate(save: SaveGameState): void {
    this.economy.hydrate(save);
    this.reputation.hydrate(save);
    // Restore expansion/tier first so cooking unlocks the right recipes.
    // 2D stored expansionLevel as 0..8 (0 = no expansions); we squash to
    // a 1..5 luxury tier by adding 1 and clamping.
    if (typeof save.expansionLevel === "number") {
      const raw = Math.max(1, Math.min(MAX_LUXURY_TIER, save.expansionLevel + 1));
      this.luxuryTier = raw as LuxuryTier;
    }
    this.cooking.hydrate(save, this.luxuryTier);
    this.customers.hydrate(save);
    this.day.hydrate(save);
    this.staff.hydrate(save);
  }

  private rolloverDay(): void {
    this.economy.resetDailyTotals();
    this.customers.resetDailyTotals();
    this.day.rollOverDay();
  }

  // === Recipe upgrade math (used by GuestSpawner + UpgradePanel) ===

  /** Sell price after upgrade level: +30% per level above 1. */
  getEffectiveSellPrice(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return Math.round(recipe.sellPrice * (1 + (level - 1) * UPGRADE_PRICE_BONUS_PER_LEVEL));
  }

  /** Satisfaction after upgrade level: +1.5 per level above 1. */
  getEffectiveSatisfaction(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return recipe.satisfactionEffect + (level - 1) * UPGRADE_SATISFACTION_PER_LEVEL;
  }

  /** Cost in money to take this recipe to next level. Grows quadratically. */
  getRecipeUpgradeCost(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return level * level * 30;
  }

  // === Luxury-tier expansion (controls which recipes can be unlocked) ===

  getLuxuryTier(): LuxuryTier {
    return this.luxuryTier;
  }

  getMaxLuxuryTier(): LuxuryTier {
    return MAX_LUXURY_TIER;
  }

  /** Cost to go from the current tier to the next one. Returns 0 at max. */
  getExpansionCost(): number {
    if (this.luxuryTier >= MAX_LUXURY_TIER) return 0;
    return Math.round(EXPANSION_BASE_COST * EXPANSION_GROWTH ** (this.luxuryTier - 1));
  }

  /** Try to bump luxury tier by 1. Spends money, syncs recipe unlocks.
   * Returns true on success. */
  buyExpansion(): boolean {
    if (this.luxuryTier >= MAX_LUXURY_TIER) return false;
    const cost = this.getExpansionCost();
    if (!this.economy.spendMoney(cost, "unlock")) return false;
    this.luxuryTier = (this.luxuryTier + 1) as LuxuryTier;
    this.cooking.syncLuxuryUnlocks(this.luxuryTier);
    return true;
  }
}

/** Turn "olive-oil" / "olive_oil" / "olive oil" into "Olive Oil". */
function prettifyIngredientId(id: string): string {
  return id.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
