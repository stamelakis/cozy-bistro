import type { Game } from "./Game";
import { recipes } from "../data/recipes";
import { RESTAURANT_THEMES } from "../data/themes";
import { maxRecipeUpgradeLevel } from "../systems/CookingSystem";

/**
 * Achievement tracker. Each entry has a stable id (don't ever
 * change once shipped — save data references it), a player-facing
 * name + description, an optional category tag for the UI to group
 * by, and a predicate evaluated periodically against the live
 * Game. On first true the achievement is marked unlocked, fires
 * a callback (toast + chime), and persists.
 *
 * The list is organised in difficulty waves: the first ~10 are
 * intentionally easy (open the game, place a chair, serve a
 * customer) so the player gets immediate progression feedback;
 * subsequent waves tier up to long-haul goals (Day 100, $500k,
 * upgrade a recipe to max).
 *
 * Categories cover every system the player can interact with:
 * intro, cash, days, customers, rating, tier, staff, training,
 * menu, pantry, build, decor, dishware, social, weather, boost.
 */

export type AchievementCategory =
  | "intro"
  | "cash"
  | "days"
  | "customers"
  | "rating"
  | "tier"
  | "staff"
  | "training"
  | "menu"
  | "pantry"
  | "build"
  | "decor"
  | "dishware"
  | "social"
  | "weather"
  | "boost";

export interface Achievement {
  id: string;
  name: string;
  description: string;
  /** Loose group used by the AchievementsModal to render tabs. */
  category: AchievementCategory;
  /** Returns true once the milestone is reached. */
  predicate: (game: Game) => boolean;
}

// ──────────────────────────────────────────────────────────────
// Helper: lifetime served count = today + every completed day.
function totalServed(g: Game): number {
  let total = g.customers.getDailyServed();
  for (const d of g.history.recent()) total += d.served;
  return total;
}

/** Highest training level reached across ALL hired staff members. */
function maxStaffLevel(g: Game): number {
  let max = 0;
  for (const m of g.staff.getMembers()) {
    const lvl = g.getMemberUpgradeLevel(m.id);
    if (lvl > max) max = lvl;
  }
  return max;
}

/** Highest recipe upgrade level across the player's whole roster. */
function maxRecipeLevel(g: Game): number {
  const levels = g.cooking.getRecipeUpgradeLevelsSnapshot();
  let max = 0;
  for (const v of Object.values(levels)) if (v > max) max = v;
  return max;
}

/** Distinct recipe categories currently on the menu (max 5). */
function menuCategoryCount(g: Game): number {
  const onMenu = new Set(g.cooking.getMenuRecipeIds());
  const cats = new Set<string>();
  for (const r of recipes) {
    if (onMenu.has(r.id)) cats.add(r.category);
  }
  return cats.size;
}

/** Count the number of unique floors that have at least one piece
 * of placed furniture. Player builds on a floor by placing anything
 * there via BuildMenu — the floor index on every placed item is
 * exposed via Game.snapshotFurnitureFloors below. */
function floorsBuiltOn(g: Game): number {
  const floors = new Set<number>();
  for (const f of g.snapshotFurnitureFloors()) floors.add(f);
  return floors.size;
}

/** Count placed decor items the player has built. Walks the registry
 * snapshot (when wired) and tallies "decoration" + "plant" + "lamp"
 * categories — the visual-only group. */
function decorPiecesPlaced(g: Game): number {
  return g.snapshotFurnitureCategories?.()
    .filter((c) => c === "decoration" || c === "plant" || c === "lamp")
    .length ?? 0;
}

/** Whether the player owns at least one piece in any tier-N dishware
 * pool of the given kind. Uses the per-tier breakdown so a tier they
 * sold back to zero correctly DOESN'T count. */
function ownsTier(g: Game, kind: "plate" | "glass", tier: number): boolean {
  for (const row of g.dishware.getTierBreakdown(kind)) {
    if (row.tier === tier && (row.clean + row.dirty) > 0) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────
// Factory helpers — keep the giant list readable.

const cashAt = (id: string, name: string, amount: number): Achievement => ({
  id, name, category: "cash",
  description: `Have $${amount.toLocaleString("en-US")} in the till.`,
  predicate: (g) => g.economy.getMoney() >= amount,
});

const dayAt = (id: string, name: string, day: number, desc: string): Achievement => ({
  id, name, category: "days", description: desc,
  predicate: (g) => g.day.getDayNumber() >= day,
});

const servedAt = (id: string, name: string, n: number, desc: string): Achievement => ({
  id, name, category: "customers", description: desc,
  predicate: (g) => totalServed(g) >= n,
});

const furnitureAt = (id: string, name: string, n: number, desc: string): Achievement => ({
  id, name, category: "build", description: desc,
  predicate: (g) => g.playerCounters.furniturePlaced >= n,
});

const tierAt = (id: string, name: string, tier: number, desc: string): Achievement => ({
  id, name, category: "tier", description: desc,
  predicate: (g) => g.getLuxuryTier() >= tier,
});

const ratingAt = (id: string, name: string, fives: number, desc: string): Achievement => ({
  id, name, category: "rating", description: desc,
  predicate: (g) => g.reputation.getRatingHistorySnapshot().filter((r) => r === 5).length >= fives,
});

// ──────────────────────────────────────────────────────────────
// THE ROSTER. Order is roughly difficulty-ascending so the
// modal can render them in the same sequence the player will
// hit them.

export const ACHIEVEMENTS: readonly Achievement[] = [
  // ─── INTRO (8) ─── one-tap milestones the player will pass
  // within their first session.
  { id: "first-sale",      name: "Open for Business",  category: "intro",
    description: "Earn your first dollar.",
    predicate: (g) => g.economy.getDailyRevenue() > 0 || g.history.recent().some((d) => d.revenue > 0) },
  { id: "first-served",    name: "First Plate",        category: "intro",
    description: "Serve your first customer.",
    predicate: (g) => totalServed(g) >= 1 },
  { id: "first-recipe",    name: "On The Menu",        category: "intro",
    description: "Add a recipe to the menu.",
    predicate: (g) => g.cooking.getMenuRecipeIds().length >= 1 },
  { id: "first-furniture", name: "First Decoration",   category: "intro",
    description: "Place your first piece of furniture.",
    predicate: (g) => g.playerCounters.furniturePlaced >= 1 },
  { id: "first-staff",     name: "Not Alone Anymore",  category: "intro",
    description: "Hire your first staff member.",
    predicate: (g) => g.staff.getTotalStaff() >= 1 },
  { id: "first-chat",      name: "Say Hi",             category: "intro",
    description: "Send your first chat message.",
    predicate: (g) => g.playerCounters.chatsSent >= 1 },
  { id: "first-weather",   name: "Outside Awareness",  category: "intro",
    description: "Experience a full day of weather.",
    predicate: (g) => g.playerCounters.weathersSeen.size >= 1 },
  { id: "first-shopping",  name: "Stocking Up",        category: "intro",
    description: "Buy at least one ingredient set.",
    predicate: (g) => g.economy.getDailyExpenses() > 0 || g.history.recent().some((d) => d.expenses > 0) },

  // ─── CASH (12) ─── from spare change to retirement.
  cashAt("cash-100",   "Pocket Change",    100),
  cashAt("cash-250",   "Lunch Money",      250),
  cashAt("cash-500",   "Saving Up",        500),
  cashAt("cash-1k",    "Four Figures",     1_000),
  cashAt("cash-2k",    "Comfortable",      2_000),
  cashAt("cash-5k",    "Tycoon",           5_000),
  cashAt("cash-10k",   "Five Figures",     10_000),
  cashAt("cash-25k",   "Restaurateur",     25_000),
  cashAt("cash-50k",   "Bistro Baron",     50_000),
  cashAt("cash-100k",  "Six Figures",      100_000),
  cashAt("cash-250k",  "Quarter Mill",     250_000),
  cashAt("cash-500k",  "Half a Million",   500_000),

  // ─── DAYS (9) ─── playtime milestones.
  dayAt("day-2",   "Second Service",  2,   "Survive to day 2."),
  dayAt("day-3",   "Three Days In",   3,   "Survive to day 3."),
  dayAt("day-5",   "Workweek",        5,   "Survive to day 5."),
  dayAt("day-7",   "First Week",      7,   "Survive to day 7."),
  dayAt("day-10",  "Double Digits",   10,  "Survive to day 10."),
  dayAt("day-20",  "Steady Habit",    20,  "Survive to day 20."),
  dayAt("day-30",  "Bistro Veteran",  30,  "Survive to day 30."),
  dayAt("day-60",  "Two-Month Run",   60,  "Survive to day 60."),
  dayAt("day-100", "Century Chef",    100, "Survive to day 100."),

  // ─── CUSTOMERS SERVED (10) ─── lifetime plates out the door.
  servedAt("served-5",    "Quick Five",      5,    "Serve 5 customers lifetime."),
  servedAt("served-10",   "Lunch Rush",      10,   "Serve 10 customers lifetime."),
  servedAt("served-25",   "Building a Crowd",25,   "Serve 25 customers lifetime."),
  servedAt("served-50",   "Half a Hundred",  50,   "Serve 50 customers lifetime."),
  servedAt("served-100",  "Hundred Plates",  100,  "Serve 100 customers lifetime."),
  servedAt("served-250",  "Reliable Spot",   250,  "Serve 250 customers lifetime."),
  servedAt("served-500",  "Five Hundred",    500,  "Serve 500 customers lifetime."),
  servedAt("served-1k",   "Thousand-Strong", 1000, "Serve 1,000 customers lifetime."),
  servedAt("served-2.5k", "City Favorite",   2500, "Serve 2,500 customers lifetime."),
  servedAt("served-5k",   "Bistro Legend",   5000, "Serve 5,000 customers lifetime."),

  // ─── RATING (6) ─── from first 5⭐ to consistent excellence.
  { id: "rating-first-5", name: "Five-Star Service", category: "rating",
    description: "Receive your first 5-star rating.",
    predicate: (g) => g.reputation.getRatingHistorySnapshot().includes(5) },
  ratingAt("rating-10-fives",  "Crowd Pleaser",  10,  "Earn 10 five-star ratings."),
  ratingAt("rating-50-fives",  "Critic Darling", 50,  "Earn 50 five-star ratings."),
  ratingAt("rating-100-fives", "Untouchable",    100, "Earn 100 five-star ratings."),
  { id: "rating-avg-4", name: "Solid Reputation", category: "rating",
    description: "Reach a 4.0 average rating (10+ votes).",
    predicate: (g) => g.reputation.getRatingCount() >= 10 && g.reputation.getAverageRating() >= 4.0 },
  { id: "rating-avg-4.5", name: "Best in Town", category: "rating",
    description: "Reach a 4.5 average rating (25+ votes).",
    predicate: (g) => g.reputation.getRatingCount() >= 25 && g.reputation.getAverageRating() >= 4.5 },

  // ─── LUXURY TIER (4) ─── expansion milestones.
  tierAt("tier-2", "Step Up",          2, "Expand to Luxury Tier 2."),
  tierAt("tier-3", "Refined",          3, "Expand to Luxury Tier 3."),
  tierAt("tier-4", "Upscale",          4, "Expand to Luxury Tier 4."),
  tierAt("tier-5", "Top of the World", 5, "Reach the maximum restaurant tier."),

  // ─── STAFF (10) ─── hiring milestones.
  { id: "staff-chef-1", name: "Hire a Chef", category: "staff",
    description: "Have at least one chef on payroll.",
    predicate: (g) => g.staff.getStaffCount("chef") >= 1 },
  { id: "staff-waiter-1", name: "Hire a Waiter", category: "staff",
    description: "Have at least one waiter on payroll.",
    predicate: (g) => g.staff.getStaffCount("waiter") >= 1 },
  { id: "staff-errand-1", name: "Hire an Errand Helper", category: "staff",
    description: "Have at least one errand helper on payroll.",
    predicate: (g) => g.staff.getStaffCount("errand") >= 1 },
  { id: "staff-barman-1", name: "Hire a Barman", category: "staff",
    description: "Have at least one barman on payroll.",
    predicate: (g) => g.staff.getStaffCount("barman") >= 1 },
  { id: "staff-all-roles", name: "Full Brigade", category: "staff",
    description: "Have at least one of every staff role.",
    predicate: (g) =>
      g.staff.getStaffCount("chef") >= 1 &&
      g.staff.getStaffCount("waiter") >= 1 &&
      g.staff.getStaffCount("errand") >= 1 &&
      g.staff.getStaffCount("barman") >= 1 },
  { id: "staff-3-chefs", name: "Kitchen Line", category: "staff",
    description: "Have 3 chefs on staff at the same time.",
    predicate: (g) => g.staff.getStaffCount("chef") >= 3 },
  { id: "staff-5-chefs", name: "Brigade de Cuisine", category: "staff",
    description: "Have 5 chefs on staff at the same time.",
    predicate: (g) => g.staff.getStaffCount("chef") >= 5 },
  { id: "staff-3-waiters", name: "Floor Crew", category: "staff",
    description: "Have 3 waiters on staff at the same time.",
    predicate: (g) => g.staff.getStaffCount("waiter") >= 3 },
  { id: "staff-total-10", name: "Ten on Payroll", category: "staff",
    description: "Have 10 total staff members.",
    predicate: (g) => g.staff.getTotalStaff() >= 10 },
  { id: "staff-total-20", name: "Big Operation", category: "staff",
    description: "Have 20 total staff members.",
    predicate: (g) => g.staff.getTotalStaff() >= 20 },

  // ─── STAFF TRAINING (4) ─── upgrade levels.
  { id: "train-staff-3", name: "Bumped Up", category: "training",
    description: "Train any staff member to level 3.",
    predicate: (g) => maxStaffLevel(g) >= 3 },
  { id: "train-staff-5", name: "Seasoned Pro", category: "training",
    description: "Train any staff member to level 5.",
    predicate: (g) => maxStaffLevel(g) >= 5 },
  { id: "train-staff-7", name: "Master at Work", category: "training",
    description: "Train any staff member to level 7.",
    predicate: (g) => maxStaffLevel(g) >= 7 },
  { id: "train-staff-max", name: "Top of the Class", category: "training",
    description: "Train any staff member to the maximum level (10).",
    predicate: (g) => maxStaffLevel(g) >= 10 },

  // ─── MENU (8) ─── recipe variety + upgrades.
  { id: "menu-3", name: "Starter Menu", category: "menu",
    description: "Have 3 recipes on the menu.",
    predicate: (g) => g.cooking.getMenuRecipeIds().length >= 3 },
  { id: "menu-5", name: "Variety Pack", category: "menu",
    description: "Have 5 recipes on the menu.",
    predicate: (g) => g.cooking.getMenuRecipeIds().length >= 5 },
  { id: "menu-10", name: "Full Menu", category: "menu",
    description: "Have 10 recipes on the menu.",
    predicate: (g) => g.cooking.getMenuRecipeIds().length >= 10 },
  { id: "menu-15", name: "Encyclopedia", category: "menu",
    description: "Have 15 recipes on the menu.",
    predicate: (g) => g.cooking.getMenuRecipeIds().length >= 15 },
  { id: "menu-all-categories", name: "Something for Everyone", category: "menu",
    description: "Have at least one recipe in every category (appetizer, main, side, drink, dessert).",
    predicate: (g) => menuCategoryCount(g) >= 5 },
  { id: "upgrade-recipe-3", name: "Refined Recipe", category: "menu",
    description: "Upgrade any recipe to level 3.",
    predicate: (g) => maxRecipeLevel(g) >= 3 },
  { id: "upgrade-recipe-5", name: "Signature Dish", category: "menu",
    description: "Upgrade any recipe to level 5.",
    predicate: (g) => maxRecipeLevel(g) >= 5 },
  { id: "upgrade-recipe-max", name: "Perfected", category: "menu",
    description: `Upgrade any recipe to the maximum level (${maxRecipeUpgradeLevel}).`,
    predicate: (g) => maxRecipeLevel(g) >= maxRecipeUpgradeLevel },

  // ─── PANTRY (5) ─── ingredient logistics.
  { id: "pantry-auto-shop", name: "Set It and Forget It", category: "pantry",
    description: "Enable Auto-shop.",
    predicate: (g) => g.autoShopEnabled === true },
  { id: "pantry-stock-5", name: "Stocked Up", category: "pantry",
    description: "Raise the per-ingredient stock target to 5.",
    predicate: (g) => g.getStockTarget() >= 5 },
  { id: "pantry-stock-10", name: "Deep Pantry", category: "pantry",
    description: "Raise the per-ingredient stock target to 10.",
    predicate: (g) => g.getStockTarget() >= 10 },
  { id: "pantry-stock-max", name: "Mise en Place", category: "pantry",
    description: "Max out the stock target (depends on your fridges).",
    predicate: (g) => g.getMaxStockTarget() > g.getMinStockTarget() && g.getStockTarget() >= g.getMaxStockTarget() },
  { id: "pantry-12-stocked", name: "Well-Provisioned", category: "pantry",
    description: "Have 12 different ingredients with stock ≥ 5.",
    predicate: (g) => g.cooking.getPantry().filter((s) => s.quantity >= 5).length >= 12 },

  // ─── BUILD (8) ─── decorating + multi-floor.
  furnitureAt("furniture-5",   "Getting Cozy",     5,   "Place 5 pieces of furniture."),
  furnitureAt("furniture-10",  "Filled In",        10,  "Place 10 pieces of furniture."),
  furnitureAt("furniture-25",  "Properly Outfitted",25, "Place 25 pieces of furniture."),
  furnitureAt("furniture-50",  "Full Service",     50,  "Place 50 pieces of furniture."),
  furnitureAt("furniture-100", "Interior Designer",100, "Place 100 pieces of furniture."),
  furnitureAt("furniture-250", "Master Builder",   250, "Place 250 pieces of furniture."),
  { id: "build-2-floors", name: "Going Up", category: "build",
    description: "Build on at least 2 different floors.",
    predicate: (g) => floorsBuiltOn(g) >= 2 },
  { id: "build-all-floors", name: "Skyscraper", category: "build",
    description: "Build on every unlocked floor (5).",
    predicate: (g) => floorsBuiltOn(g) >= 5 },

  // ─── DECOR (5) ─── theme + decor exploration.
  { id: "decor-theme-change", name: "Fresh Coat", category: "decor",
    description: "Change a floor's theme for the first time.",
    predicate: (g) => g.playerCounters.themeChanges >= 1 },
  { id: "decor-3-themes", name: "Trying Looks", category: "decor",
    description: "Try 3 different restaurant themes.",
    predicate: (g) => g.playerCounters.themesTried.size >= 3 },
  { id: "decor-all-themes", name: "Aesthete", category: "decor",
    description: "Try every restaurant theme at least once.",
    predicate: (g) => g.playerCounters.themesTried.size >= RESTAURANT_THEMES.length },
  { id: "decor-10-pieces", name: "Knick-knacks", category: "decor",
    description: "Place 10 decoration / plant / lamp items.",
    predicate: (g) => decorPiecesPlaced(g) >= 10 },
  { id: "decor-30-pieces", name: "Visual Feast", category: "decor",
    description: "Place 30 decoration / plant / lamp items.",
    predicate: (g) => decorPiecesPlaced(g) >= 30 },

  // ─── DISHWARE (8) ─── plate + glass collections.
  { id: "dish-buy-set", name: "First Purchase", category: "dishware",
    description: "Buy any extra plate or glass set.",
    predicate: (g) => g.dishware.getPurchaseLog().length >= 1 },
  { id: "dish-50-plates", name: "Plate Stash", category: "dishware",
    description: "Own 50 plates (clean or dirty).",
    predicate: (g) => g.dishware.getClean("plate") + g.dishware.getDirty("plate") >= 50 },
  { id: "dish-150-plates", name: "Plate Reserve", category: "dishware",
    description: "Own 150 plates.",
    predicate: (g) => g.dishware.getClean("plate") + g.dishware.getDirty("plate") >= 150 },
  { id: "dish-300-plates", name: "Plate Warehouse", category: "dishware",
    description: "Own 300 plates.",
    predicate: (g) => g.dishware.getClean("plate") + g.dishware.getDirty("plate") >= 300 },
  { id: "dish-50-glasses", name: "Glassware Drawer", category: "dishware",
    description: "Own 50 glasses (clean or dirty).",
    predicate: (g) => g.dishware.getClean("glass") + g.dishware.getDirty("glass") >= 50 },
  { id: "dish-150-glasses", name: "Bar-Stocked", category: "dishware",
    description: "Own 150 glasses.",
    predicate: (g) => g.dishware.getClean("glass") + g.dishware.getDirty("glass") >= 150 },
  { id: "dish-t3", name: "Tier 3 Tableware", category: "dishware",
    description: "Buy a tier-3 plate or glass set.",
    predicate: (g) => ownsTier(g, "plate", 3) || ownsTier(g, "glass", 3) },
  { id: "dish-t5", name: "Fine China", category: "dishware",
    description: "Buy a tier-5 plate or glass set.",
    predicate: (g) => ownsTier(g, "plate", 5) || ownsTier(g, "glass", 5) },

  // ─── SOCIAL (6) ─── chat + visit cross-player loop.
  { id: "social-chat-10", name: "Chatterbox", category: "social",
    description: "Send 10 chat messages.",
    predicate: (g) => g.playerCounters.chatsSent >= 10 },
  { id: "social-chat-50", name: "Town Crier", category: "social",
    description: "Send 50 chat messages.",
    predicate: (g) => g.playerCounters.chatsSent >= 50 },
  { id: "social-visit-1", name: "Nosy Neighbor", category: "social",
    description: "Visit another player's restaurant.",
    predicate: (g) => g.playerCounters.visitsOut >= 1 },
  { id: "social-visit-5", name: "City Tour", category: "social",
    description: "Visit 5 different restaurants.",
    predicate: (g) => g.playerCounters.visitsOut >= 5 },
  { id: "social-visit-20", name: "Restaurant Critic", category: "social",
    description: "Visit 20 restaurants.",
    predicate: (g) => g.playerCounters.visitsOut >= 20 },
  { id: "social-visited-5", name: "Word of Mouth", category: "social",
    description: "Have 5 visitors come to your restaurant.",
    predicate: (g) => g.playerCounters.visitsIn >= 5 },

  // ─── WEATHER (4) ─── outdoor variety.
  { id: "weather-3", name: "Forecaster", category: "weather",
    description: "See 3 different weather conditions.",
    predicate: (g) => g.playerCounters.weathersSeen.size >= 3 },
  { id: "weather-5", name: "All Seasons", category: "weather",
    description: "See 5 different weather conditions.",
    predicate: (g) => g.playerCounters.weathersSeen.size >= 5 },
  { id: "weather-all", name: "Weatherproof", category: "weather",
    description: "Experience every weather condition the game can throw at you.",
    predicate: (g) => g.playerCounters.weathersSeen.size >= 7 },
  { id: "weather-festival", name: "Festival Vibes", category: "weather",
    description: "Run service during a Festival Day.",
    predicate: (g) => g.weather.getCurrent().id === "festival" && totalServed(g) >= 5 },

  // ─── BOOST (3) ─── special action usage.
  { id: "boost-1", name: "First Boost", category: "boost",
    description: "Trigger the boost button for the first time.",
    predicate: (g) => g.playerCounters.boostsUsed >= 1 },
  { id: "boost-10", name: "Hype Master", category: "boost",
    description: "Trigger the boost button 10 times.",
    predicate: (g) => g.playerCounters.boostsUsed >= 10 },
  { id: "boost-50", name: "Marketing Genius", category: "boost",
    description: "Trigger the boost button 50 times.",
    predicate: (g) => g.playerCounters.boostsUsed >= 50 },
];

// ──────────────────────────────────────────────────────────────

export class AchievementSystem {
  private unlocked = new Set<string>();
  private elapsedSinceCheck = 0;
  /** Optional: fired the first time an achievement is unlocked. Engine
   * wires this up to pop a celebratory toast + chime. */
  onUnlock?: (achievement: Achievement) => void;

  /** Returns the snapshot of unlocked ids for save persistence. */
  snapshot(): string[] {
    return Array.from(this.unlocked);
  }

  hydrate(ids?: string[]): void {
    this.unlocked = new Set(ids ?? []);
  }

  isUnlocked(id: string): boolean { return this.unlocked.has(id); }
  count(): number { return this.unlocked.size; }
  total(): number { return ACHIEVEMENTS.length; }

  /** Per-tick check; rate-limited to once a second to keep predicate cost low. */
  update(dt: number, game: Game): void {
    this.elapsedSinceCheck += dt;
    if (this.elapsedSinceCheck < 1) return;
    this.elapsedSinceCheck = 0;
    for (const a of ACHIEVEMENTS) {
      if (this.unlocked.has(a.id)) continue;
      if (a.predicate(game)) {
        this.unlocked.add(a.id);
        this.onUnlock?.(a);
      }
    }
  }
}
