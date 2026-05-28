import { EconomySystem } from "../systems/EconomySystem";
import { ReputationSystem } from "../systems/ReputationSystem";
import { CookingSystem } from "../systems/CookingSystem";
import { CustomerSystem } from "../systems/CustomerSystem";
import { DayCycleSystem, rentIntervalSeconds } from "../systems/DayCycleSystem";
import { StaffSystem, type StaffRole } from "../systems/StaffSystem";
import { WeatherSystem } from "./WeatherSystem";
import { DayHistory } from "./DayHistory";
import { AchievementSystem } from "./AchievementSystem";
import { RESTAURANT_THEMES, type RestaurantTheme } from "../data/themes";
import { recipes } from "../data/recipes";
import { getRecipeIngredientCost, getIngredientCost } from "../data/ingredients";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";
import type { IngredientStock, LuxuryTier, RecipeDefinition, SaveGameState } from "../data/types";

/** Highest luxury tier the player can unlock. */
const MAX_LUXURY_TIER: LuxuryTier = 5;
/** Cost to go from tier N to tier N+1: BASE * GROWTH^(N-1). */
const EXPANSION_BASE_COST = 500;
const EXPANSION_GROWTH = 3;

/** Default seconds between automatic dish-wash ticks. Sinks and
 * dishwashers placed in the registry shorten this — see
 * Game.getEffectiveDishWashInterval. */
const DISH_WASH_INTERVAL = 3;
/** Above this pile, guests visibly notice and rate the restaurant lower. */
const DIRTY_PILE_PENALTY_THRESHOLD = 8;

/** Snapshot of a day's results, captured the instant the day ends and
 * before any daily counters are reset. */
export interface DayEndSummary {
  /** The day that just ended (1-based, matches the HUD). */
  dayNumber: number;
  served: number;
  lost: number;
  revenue: number;
  expenses: number;
  net: number;
  rating: number;
}

/** Base money charged automatically per in-game day. Scales with luxury tier:
 *  tier 1 → $40, tier 2 → $70, tier 3 → $100, tier 4 → $130, tier 5 → $160 */
const BASE_DAILY_RENT = 40;
const RENT_PER_TIER = 30;
/** Default money charged per staff member per real minute. */
const DEFAULT_PAYROLL_PER_STAFF_PER_MINUTE = 6;
/** Default cost per unit of ingredient when auto-shopping. */
export const INGREDIENT_UNIT_COST = 2;

/**
 * Runtime-tweakable knobs. Game.admin holds an instance the player can
 * mutate via the AdminPanel (dev mode). Each tick reads from admin
 * instead of the static defaults, so changes take effect immediately.
 */
export interface AdminSettings {
  payrollPerStaffPerMinute: number;
  /** Multiplier on the per-ingredient buy cost (1 = default, <1 = cheaper). */
  ingredientCostMultiplier: number;
  /** Multiplier on guest spawn interval (>1 = slower spawns). */
  spawnRateMultiplier: number;
  /** Multiplier on the dish-wash interval (<1 = faster). */
  dishWashMultiplier: number;
  /** Multiplier on daily rent (<1 = cheaper rent). */
  rentMultiplier: number;
}
const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  payrollPerStaffPerMinute: DEFAULT_PAYROLL_PER_STAFF_PER_MINUTE,
  ingredientCostMultiplier: 1,
  spawnRateMultiplier: 1,
  dishWashMultiplier: 1,
  rentMultiplier: 1,
};
/** Auto-shop tries to keep each ingredient stocked at this level. */
const STOCK_TARGET = 8;
/** Auto-shop runs this often (seconds). */
const AUTOSHOP_INTERVAL = 4;
/** Max units bought per ingredient per auto-shop tick. Higher = faster
 * recovery from a depleted pantry but bigger spending spikes. */
const AUTOSHOP_BATCH_PER_INGREDIENT = 3;
/** Each recipe-upgrade level adds this much to satisfactionEffect. */
const UPGRADE_SATISFACTION_PER_LEVEL = 1.5;
/** Base profit per tier per upgrade level. Sell price = base * level + ingredient cost.
 *  Indexed by tier 1..5 (index 0 unused). So tier 1 dish at L1 → $3 profit,
 *  tier 5 dish at L10 → $70 profit. */
const TIER_BASE_PROFIT = [0, 3, 4, 5, 6, 7];

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
  readonly weather: WeatherSystem;
  readonly history: DayHistory;
  readonly achievements: AchievementSystem;

  /** Auto-shop accumulator (seconds since last attempt). */
  private autoShopClock = 0;
  /** Set false to disable auto-shop (player will have to manage stock manually). */
  autoShopEnabled = true;
  /** Current luxury tier (1..5). Raised by buyExpansion(); controls which
   * recipes the player can unlock through the menu picker. */
  private luxuryTier: LuxuryTier = 1;
  /** Seconds remaining of an active marketing boost. While > 0,
   * GuestSpawner halves its spawn interval. */
  private boostRemaining = 0;
  /** Currently applied interior theme id. */
  private themeId: string = RESTAURANT_THEMES[0].id;
  /** Pile of dirty plates waiting to be washed. Each guest that finishes
   * a meal leaves one. Auto-decremented at DISH_WASH_INTERVAL. */
  private dirtyDishCount = 0;
  /** Accumulator for the auto-wash tick. */
  private dishWashClock = 0;
  /** Runtime-mutable tuning knobs (AdminPanel). */
  readonly admin: AdminSettings = { ...DEFAULT_ADMIN_SETTINGS };
  /** Optional callback fired when the theme changes — Engine wires
   * this to WorldScene.setTheme so the world recolors. */
  onThemeChanged?: (theme: RestaurantTheme) => void;
  /** Optional: when set, the dish-wash interval queries this for
   * counts of placed sinks / dishwashers. */
  countPlacedById?: (id: string) => number;
  /** Optional callback fired once per auto-shop tick that actually bought
   * something. Engine wires this to the ErrandRouter so the helper makes
   * a visible door trip. Receiver should be cheap (queue, don't block). */
  onAutoShop?: () => void;
  /** Optional callback fired when a day rolls over. Receives a snapshot
   * of the just-ended day's totals BEFORE they're reset. Engine wires
   * this to the day-end modal so the player sees the recap. */
  onDayEnded?: (summary: DayEndSummary) => void;
  /** Fired when the player successfully hires a new staff member. Engine
   * uses this to spawn an extra character in the world and add them to
   * the corresponding router pool. */
  onStaffHired?: (role: StaffRole, indexAmongRole: number) => void;
  /** Fired when the player fires a staff member. Engine uses this to
   * remove the matching character from the world. */
  onStaffFired?: (role: StaffRole) => void;

  constructor(save?: SaveGameState) {
    this.economy = new EconomySystem();
    this.reputation = new ReputationSystem();
    this.cooking = new CookingSystem();
    this.customers = new CustomerSystem();
    this.day = new DayCycleSystem();
    this.staff = new StaffSystem();
    this.weather = new WeatherSystem();
    this.history = new DayHistory();
    this.achievements = new AchievementSystem();
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
      this.economy.forceSpendMoney(this.getDailyRent() * rentPeriodsDue, "rent");
    }
    // Payroll runs continuously while staff are hired. tickSalary takes
    // a millisecond timestamp and internally rate-limits its own charges.
    const payroll = this.staff.tickSalary(this.day.getTotalPlaySeconds() * 1000, this.admin.payrollPerStaffPerMinute);
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
      // Smart batched order: each ingredient buys up to BATCH_PER_INGREDIENT
      // units toward STOCK_TARGET in a single tick. Sort by which is most
      // depleted first so a near-empty critical ingredient gets serviced
      // before a barely-low one.
      const needs = pantry
        .map((stock, idx) => ({ stock, deficit: STOCK_TARGET - stock.quantity, idx }))
        .filter((n) => n.deficit > 0)
        .sort((a, b) => b.deficit - a.deficit);
      const costMult = this.admin.ingredientCostMultiplier;
      for (const need of needs) {
        // Per-ingredient real cost × admin multiplier (so truffles cost
        // more than bread, just like in real life).
        const unitCost = Math.max(0, Math.round(getIngredientCost(need.stock.id) * costMult));
        const units = Math.min(AUTOSHOP_BATCH_PER_INGREDIENT, need.deficit);
        let bought = 0;
        for (let i = 0; i < units; i += 1) {
          if (unitCost > 0 && !this.economy.spendMoney(unitCost, "ingredients")) break;
          need.stock.quantity += 1;
          bought += 1;
        }
        if (bought > 0) purchased = true;
        if (bought < units) break; // out of money — stop scanning
      }
      if (purchased && this.onAutoShop) this.onAutoShop();
    }
    // Boost timer counts down with real sim time.
    if (this.boostRemaining > 0) {
      this.boostRemaining = Math.max(0, this.boostRemaining - dt);
    }
    // Wash dirty dishes one at a time. Interval is reduced (faster wash)
    // for each placed sink + dishwasher.
    if (this.dirtyDishCount > 0) {
      this.dishWashClock += dt;
      if (this.dishWashClock >= this.getEffectiveDishWashInterval()) {
        this.dishWashClock = 0;
        this.dirtyDishCount -= 1;
      }
    } else {
      this.dishWashClock = 0;
    }
    // Achievement predicates only check once per second internally.
    this.achievements.update(dt, this);
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
    // Day history: store typed records but tolerate any shape since it's
    // typed loosely in SaveGameState for cross-version compat.
    if (Array.isArray(save.dayHistory)) {
      this.history.hydrate(save.dayHistory as Parameters<typeof this.history.hydrate>[0]);
    }
    if (Array.isArray(save.achievements)) {
      this.achievements.hydrate(save.achievements as string[]);
    }
    if (typeof save.themeId === "string") {
      this.themeId = save.themeId;
    }
    if (typeof save.dirtyDishCount === "number") {
      this.dirtyDishCount = Math.max(0, save.dirtyDishCount);
    }
  }

  private rolloverDay(): void {
    // Capture the day's totals BEFORE resetting them — used by both the
    // day-end modal callback AND the persistent history.
    const dayNumber = this.day.getDayNumber();
    const revenue = this.economy.getDailyRevenue();
    const expenses = this.economy.getDailyExpenses();
    const served = this.customers.getDailyServed();
    const lost = this.customers.getDailyLost();
    const rating = this.reputation.getReputation();
    const weather = this.weather.getCurrent();
    this.history.push({
      dayNumber,
      served,
      lost,
      revenue,
      expenses,
      net: revenue - expenses,
      rating,
      weatherEmoji: weather.emoji,
      weatherLabel: weather.label,
    });
    this.onDayEnded?.({
      dayNumber, served, lost, revenue, expenses,
      net: revenue - expenses,
      rating,
    });
    this.economy.resetDailyTotals();
    this.customers.resetDailyTotals();
    this.day.rollOverDay();
    // Roll the next day's weather AFTER the day counter advances so the
    // HUD's "Day N" matches the weather forecast for that same day.
    this.weather.rollForNewDay();
  }

  // === Recipe pricing / upgrades (rewritten in batch 49) ===

  /** Sum of per-unit costs of every ingredient this recipe needs. */
  getRecipeIngredientCost(recipe: RecipeDefinition): number {
    return getRecipeIngredientCost(recipe.ingredients);
  }

  /** Per-tier base profit (the dollar amount a level-1 dish nets above
   * ingredient cost). Tier 1 → $3, Tier 5 → $7. */
  getTierBaseProfit(tier: LuxuryTier): number {
    return TIER_BASE_PROFIT[tier] ?? TIER_BASE_PROFIT[1];
  }

  /** Effective profit for one serving of a recipe at its current upgrade
   * level: base * level. */
  getEffectiveProfit(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    const tier = getRecipeLuxuryTier(recipe);
    return this.getTierBaseProfit(tier) * level;
  }

  /** Final price the guest pays: profit + ingredient cost. */
  getEffectiveSellPrice(recipe: RecipeDefinition): number {
    return this.getEffectiveProfit(recipe) + this.getRecipeIngredientCost(recipe);
  }

  /** Satisfaction after upgrade level: +1.5 per level above 1. */
  getEffectiveSatisfaction(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return recipe.satisfactionEffect + (level - 1) * UPGRADE_SATISFACTION_PER_LEVEL;
  }

  /** Money cost to take this recipe to the next level. */
  getRecipeUpgradeCost(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return level * level * 30;
  }

  /** Material cost to upgrade — L units of each ingredient, where L is
   * the CURRENT level. Returns the list as { id, qty }. */
  getRecipeUpgradeMaterials(recipe: RecipeDefinition): { id: string; qty: number }[] {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return recipe.ingredients.map((id) => ({ id, qty: level }));
  }

  /** True if the player has both the money AND the materials to upgrade. */
  canUpgradeRecipe(recipe: RecipeDefinition): boolean {
    if (this.cooking.getRecipeUpgradeLevel(recipe) >= 10) return false;
    if (!this.economy.canAfford(this.getRecipeUpgradeCost(recipe))) return false;
    const needed = this.getRecipeUpgradeMaterials(recipe);
    for (const n of needed) {
      if (this.cooking.getIngredientQuantity(n.id) < n.qty) return false;
    }
    return true;
  }

  /** Spend money + ingredients, bump the recipe to next level. Returns
   * true on success. */
  upgradeRecipe(recipe: RecipeDefinition): boolean {
    if (!this.canUpgradeRecipe(recipe)) return false;
    const cost = this.getRecipeUpgradeCost(recipe);
    if (!this.economy.spendMoney(cost, "unlock")) return false;
    // Pull the ingredients out of the pantry.
    const pantry = this.cooking.getPantryRaw();
    const needed = this.getRecipeUpgradeMaterials(recipe);
    for (const n of needed) {
      const stock = pantry.find((s) => s.id === n.id);
      if (stock) stock.quantity = Math.max(0, stock.quantity - n.qty);
    }
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    this.cooking.setRecipeUpgradeLevel(recipe.id, level + 1);
    return true;
  }

  /** Daily rent owed this in-game day. Scales with luxury tier and the
   * admin.rentMultiplier knob. */
  getDailyRent(): number {
    const raw = BASE_DAILY_RENT + (this.luxuryTier - 1) * RENT_PER_TIER;
    return Math.max(0, Math.round(raw * this.admin.rentMultiplier));
  }

  // === Dirty-dish pile ===

  getDirtyDishCount(): number { return this.dirtyDishCount; }

  /** Called by GuestSpawner when a guest finishes their meal and leaves —
   * each plate they ate gets queued for washing. */
  addDirtyDish(count = 1): void {
    this.dirtyDishCount += count;
  }

  /** True when the pile is large enough that newly-rolled guest ratings
   * should be penalized for a noticeably dirty restaurant. */
  isDishPileOverwhelming(): boolean {
    return this.dirtyDishCount > DIRTY_PILE_PENALTY_THRESHOLD;
  }

  /** Seconds between wash ticks, reduced by sinks (-0.5s each) and
   * dishwashers (-1.0s for compact, -1.5s for pro), then scaled by
   * admin.dishWashMultiplier. Floored at 0.4s. */
  getEffectiveDishWashInterval(): number {
    let interval = DISH_WASH_INTERVAL;
    if (this.countPlacedById) {
      const sinks = this.countPlacedById("sink");
      const dish = this.countPlacedById("dishwasher");
      const dishPro = this.countPlacedById("dishwasher-pro");
      interval -= sinks * 0.5 + dish * 1.0 + dishPro * 1.5;
    }
    return Math.max(0.4, interval * this.admin.dishWashMultiplier);
  }

  // === Interior themes (wall + floor color presets) ===

  getCurrentTheme(): RestaurantTheme {
    return RESTAURANT_THEMES.find((t) => t.id === this.themeId) ?? RESTAURANT_THEMES[0];
  }

  /** Apply (and persist) a new interior theme. Free themes skip the
   * money check. Returns true on success. */
  applyTheme(themeId: string): boolean {
    const theme = RESTAURANT_THEMES.find((t) => t.id === themeId);
    if (!theme) return false;
    if (theme.id === this.themeId) return true; // no-op
    if (theme.cost > 0 && !this.economy.spendMoney(theme.cost, "decor")) return false;
    this.themeId = theme.id;
    this.onThemeChanged?.(theme);
    return true;
  }

  // === Marketing boost (paid spawn-rate increase) ===

  /** True while a paid boost is active (halves GuestSpawner's interval). */
  isBoostActive(): boolean {
    return this.boostRemaining > 0;
  }

  /** Seconds remaining of the active boost (0 if inactive). */
  getBoostRemaining(): number {
    return this.boostRemaining;
  }

  /** Cost of buying a 60s boost. Scales gently with player wealth so it
   * stays meaningful in the late game. */
  getBoostCost(): number {
    return 80;
  }
  getBoostDurationSeconds(): number {
    return 60;
  }
  /** Try to buy a boost. Returns true if money was spent and timer was reset. */
  buyBoost(): boolean {
    if (!this.economy.spendMoney(this.getBoostCost(), "decor")) return false;
    this.boostRemaining = this.getBoostDurationSeconds();
    return true;
  }

  // === Staff hire/fire (wraps economy + StaffSystem + fires callback) ===

  /** Try to hire a staff member. Returns true on success (money was
   * available and was charged, headcount went up, callback fired). */
  hireStaff(role: StaffRole): boolean {
    const cost = this.staff.getStaffHireCost(role);
    if (!this.economy.spendMoney(cost, "staff")) return false;
    const idx = this.staff.addStaff(role);
    this.onStaffHired?.(role, idx);
    return true;
  }

  /** Try to fire a staff member. Returns true if there was someone to fire
   * (severance was charged and the callback fired). */
  fireStaff(role: StaffRole): boolean {
    if (this.staff.getStaffCount(role) === 0) return false;
    const cost = this.staff.getStaffFireCost(role);
    this.economy.forceSpendMoney(cost, "charge");
    this.staff.removeStaff(role);
    this.onStaffFired?.(role);
    return true;
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
