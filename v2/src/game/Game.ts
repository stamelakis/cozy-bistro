import { EconomySystem } from "../systems/EconomySystem";
import { ReputationSystem } from "../systems/ReputationSystem";
import { CookingSystem } from "../systems/CookingSystem";
import { CustomerSystem } from "../systems/CustomerSystem";
import { DayCycleSystem } from "../systems/DayCycleSystem";
import { DishwareSystem } from "../systems/DishwareSystem";
import { StaffSystem, STAFF_UPGRADE_MAX, type StaffRole } from "../systems/StaffSystem";
import { WeatherSystem } from "./WeatherSystem";
import { DayHistory } from "./DayHistory";
import { AchievementSystem } from "./AchievementSystem";
import { RESTAURANT_THEMES, type RestaurantTheme } from "../data/themes";
import { recipes } from "../data/recipes";
import { getRecipeIngredientCost, getIngredientCost } from "../data/ingredients";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { isServerSim } from "./featureFlags";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";
import type { HiredStaffMember, IngredientStock, LuxuryTier, RecipeDefinition, SaveGameState } from "../data/types";

/** Highest luxury tier the player can unlock. */
const MAX_LUXURY_TIER: LuxuryTier = 5;
/** Cost to go from tier N to tier N+1: BASE * GROWTH^(N-1).
 * Tier 2 = $10k, tier 3 = $20k, tier 4 = $40k, tier 5 = $80k.
 * Tuned so each tier is a real money sink rather than something the
 * player walks past on day two. */
const EXPANSION_BASE_COST = 10000;
const EXPANSION_GROWTH = 2;

/** Default seconds between automatic dish-wash ticks. Sinks and
 * dishwashers placed in the registry shorten this — see
 * Game.getEffectiveDishWashInterval. */
const DISH_WASH_INTERVAL = 3;
/** Seconds the player must wait after a paid boost ends before they
 * can buy another. 15 real minutes — long enough that the boost reads
 * as a tactical "pull a busy hour into the next 60s" rather than a
 * way to permanently double spawn rate by spamming the button. */
const BOOST_COOLDOWN_SECONDS = 15 * 60;
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

/** Daily rent indexed by luxury tier (1..5). Doubles per tier so the
 * fixed cost of operating the bigger spaces forces real economic
 * planning, not just "buy the upgrade and the same trickle covers it":
 *  T1=$40, T2=$80, T3=$160, T4=$320, T5=$640.
 * Index 0 is unused (tiers are 1-indexed). */
const RENT_BY_TIER = [0, 40, 80, 160, 320, 640];
/** Opening grace period, in in-game days. During it a brand-new
 * restaurant pays NO rent AND NO wages — breathing room to upgrade a
 * couple of recipes, hire a little, and reach the break-even line before
 * fixed costs start eating starter cash. Both switch on together on day
 * GRACE_DAYS+1; the HUD shows a live countdown while it's active. */
const GRACE_DAYS = 14;
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
/** Auto-shop default target stock level per ingredient. Player can adjust
 * in the Pantry modal (min 3). */
const DEFAULT_STOCK_TARGET = 5;
/** Global multiplier applied to every recipe's prep time before the
 * chef training bonus. >1 makes the kitchen feel busier; the chef
 * training upgrade then claws some of it back. Patience is unaffected
 * — the customer cap is the same, you just need a more trained chef
 * (or more chefs) to keep up. */
// Dropped from 1.5 → 1.0 so each chef can handle ~50% more dishes per
// minute. With the lower SPAWN_INTERVAL_SECONDS and a 5-storey kitchen
// throughput target, the old 1.5 made every chef a bottleneck at
// ~10 concurrent customers (matching the user's report of 4 chefs
// being only "modestly busy" while 6 waiters were full-out). At 1.0
// the same 4 chefs comfortably feed ~25 concurrent; staffing
// recommendations in the scenario notes scale from there.
//
// Path-B tuning: bumped 1.0 → 1.5 because server-authoritative cooking
// read "a bit fast" / frantic — the ~50% longer cook makes the kitchen
// animation legible without changing the dish-per-customer math (this
// scales BOTH the base cook sent at place_order via getBaseCookSeconds
// AND the per-chef target via getEffectiveCookSecondsForChef, so the
// server's cook timer and the local estimate stay in lockstep). The
// setRecipeMeta background-guest path is scaled by the same factor so
// fully-backgrounded restaurants cook at the same pace.
const COOK_TIME_GLOBAL_MULT = 1.5;

/** Duration (in REAL minutes) for the next recipe upgrade. Base is
 * 1 minute at tier 1 / current level 1, doubling per tier AND per
 * level. So Tier 5 going from L1 → L2 = 1 × 2⁴ × 2⁰ = 16 min;
 * Tier 1 going from L9 → L10 = 256 min. The level argument is the
 * CURRENT level (before the upgrade) — i.e. how seasoned the recipe
 * already is. */
function getRecipeUpgradeDurationMinutes(tier: number, currentLevel: number): number {
  const tierScale = Math.pow(2, tier - 1);
  const levelScale = Math.pow(2, currentLevel - 1);
  return tierScale * levelScale;
}
const MIN_STOCK_TARGET = 3;
// Phase I (H.78b) — was 50 (an arbitrary hard cap that capped late-
// game players who'd placed enough fridges to want more).  Bumped
// to 500 so the meaningful limit is now the sum of placed fridge /
// pantry / walk-in stockCapacity (Game.getFridgeStockBonus).  Place
// more fridges → set higher target.  500 is still finite so a
// runaway auto-shop can't drain the player's cash; that's the only
// reason there's a number here at all.
const MAX_STOCK_TARGET = 500;
/** Auto-shop runs this often (seconds). */
const AUTOSHOP_INTERVAL = 4;
/** Max TOTAL units one errand trip can carry back. Tunes the supply
 * chain: smaller → more frequent trips, larger → fewer trips but
 * bigger lump payments. 10 means each helper run brings 10 units. */
const AUTOSHOP_MAX_PER_TRIP = 10;
/** Each recipe-upgrade level adds this much to satisfactionEffect. */
const UPGRADE_SATISFACTION_PER_LEVEL = 1.5;
/** Base profit per tier. Phase 9.56 — the per-tier step is now $0.50
 *  (was $1.00): tier 1 → $3, then +$0.50/tier up to tier 5 → $5.
 *  Indexed by tier 1..5 (index 0 unused). */
const TIER_BASE_PROFIT = [0, 3, 3.5, 4, 4.5, 5];

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
  readonly dishware: DishwareSystem;

  /** Auto-shop accumulator (seconds since last attempt). */
  private autoShopClock = 0;
  /** Set false to disable auto-shop (player will have to manage stock manually). */
  autoShopEnabled = true;
  /** Whether the restaurant is OPEN for business. When CLOSED, rent + staff
   * wages are PAUSED (and no guests spawn). Persisted in the save blob +
   * mirrored to player_save.restaurant_open so the server's offline rent /
   * salary ticks pause too. The Engine syncs this to the spawner each frame. */
  restaurantOpen = true;
  /** Per-ingredient target stock level the auto-shop refills toward.
   * Player adjustable via PantryModal +/- buttons. */
  private stockTarget: number = DEFAULT_STOCK_TARGET;
  /** Wall-clock summary of the most recent auto-shop fire — surfaced in
   * the Pantry modal so the player can tell when restocking actually
   * happened. Cleared by getLastAutoShop after rendering. */
  private lastAutoShop: { atMs: number; totalSpent: number; itemCount: number; ids: Set<string> } | null = null;
  /** Current luxury tier (1..5). Raised by buyExpansion(); controls which
   * recipes the player can unlock through the menu picker. */
  private luxuryTier: LuxuryTier = 1;
  /** Seconds remaining of an active marketing boost. While > 0,
   * GuestSpawner halves its spawn interval. */
  private boostRemaining = 0;
  /** Seconds left before the next boost can be purchased again. Set
   * to BOOST_COOLDOWN_SECONDS the moment a boost finishes; ticks down
   * with sim time. While > 0, buyBoost rejects. */
  private boostCooldownRemaining = 0;
  /** Currently applied interior theme id (ground floor / legacy field).
   * Upper floors override via `themeByFloor`. */
  private themeId: string = RESTAURANT_THEMES[0].id;
  /** Per-floor theme ids. Key = storey index (0..NUM_STOREYS-1). Missing
   * entries fall back to the default theme so unset floors render as
   * the off-white shell instead of a random pick. */
  private themeByFloor: Record<number, string> = {};
  /** Player-customised restaurant name shown on the door plaque. Edited
   * via the click-to-edit modal that pops when the plaque is clicked.
   * Empty string means "use the default" so the plaque never renders
   * blank — the modal validates non-empty input before persisting. */
  private restaurantName: string = "Cozy Bistro";
  /** Visual styling for the door plaque. Persisted alongside the name
   * and applied to the canvas-texture render of the sign. Defaults
   * picked to read as a warm cosy bistro. */
  private signStyle: { font: string; textColor: string; plaqueStyle: string } = {
    font: "serif",       // catalog id: serif / sans / script / display
    textColor: "cream",  // catalog id: cream / gold / white / red / mint / lavender
    plaqueStyle: "dark", // catalog id: dark / wood / slate / brass
  };
  // dirtyDishCount + dishWashClock removed — superseded by
  // DishwareSystem which tracks per-tier plate/glass dirty pools and
  // runs its own wash clock.
  /** Runtime-mutable tuning knobs (AdminPanel). */
  readonly admin: AdminSettings = { ...DEFAULT_ADMIN_SETTINGS };

  /** Lifetime counters powering the broader achievement set. Mutated
   * by the relevant interaction sites (BuildMenu placement, DecorModal
   * theme change, ExpandWidget boost click, VisitMode enter, ChatPanel
   * send, …). Persisted via save.playerCounters and hydrated on load.
   *
   * Each counter is monotonically non-decreasing; selling furniture
   * doesn't unbump furniturePlaced, for example — these are "how many
   * times the player did X across the lifetime of the save". */
  readonly playerCounters: {
    furniturePlaced: number;
    themeChanges: number;
    themesTried: Set<string>;
    visitsOut: number;
    visitsIn: number;
    chatsSent: number;
    boostsUsed: number;
    weathersSeen: Set<string>;
  } = {
    furniturePlaced: 0,
    themeChanges: 0,
    themesTried: new Set<string>(),
    visitsOut: 0,
    visitsIn: 0,
    chatsSent: 0,
    boostsUsed: 0,
    weathersSeen: new Set<string>(),
  };

  /** Bump a numeric counter and persist on the next save tick. */
  bumpPlayerCounter(
    key: "furniturePlaced" | "themeChanges" | "visitsOut" | "visitsIn" | "chatsSent" | "boostsUsed",
    delta = 1,
  ): void {
    this.playerCounters[key] = Math.max(0, this.playerCounters[key] + delta);
  }

  /** Record that a particular theme / weather id has been seen at
   * least once. No-op if already in the set. */
  recordPlayerSet(key: "themesTried" | "weathersSeen", id: string): void {
    if (!id) return;
    this.playerCounters[key].add(id);
  }
  /** Optional callback fired when a floor's theme changes — Engine
   * wires this to WorldScene.setStoreyTheme so just that floor's
   * walls + slab recolour. Includes the floor index so the listener
   * can target the right storey. */
  onThemeChanged?: (floor: number, theme: RestaurantTheme) => void;
  /** Engine wires this to GuestSpawner so the SaveSystem can persist
   * per-kind / per-tier in-flight plate reservations. Without it a
   * refresh permanently loses any plate a mid-meal guest was holding
   * (guests aren't saved, so their reservation evaporates). */
  gatherInFlightDishes?: () => Array<{ kind: "plate" | "glass"; tier: number; count: number }>;
  /** Snapshot helper used by SaveSystem. Returns empty when no
   * spawner is wired (early-boot saves). */
  getInFlightDishesForSave(): Array<{ kind: "plate" | "glass"; tier: number; count: number }> {
    return this.gatherInFlightDishes?.() ?? [];
  }
  /** Total plates + glasses currently held by eating customers
   * (clean was decremented at beginNextCourse, not yet marked dirty
   * via finalizeVisit). Used by the HUD's DIRTY DISHES card so the
   * "/ total" denominator stays stable during normal play instead of
   * dropping by 1 each time a customer starts eating. */
  getInFlightDishCount(): number {
    let n = 0;
    const list = this.gatherInFlightDishes?.() ?? [];
    for (const e of list) n += e.count;
    return n;
  }
  /** Optional: when set, the dish-wash interval queries this for
   * counts of placed sinks / dishwashers. */
  countPlacedById?: (id: string) => number;
  /** Optional: when set, the cooking system queries this to decide
   * which recipes can currently be put on the menu (gated by required
   * appliances). Returns the set of appliance ids at least one placed
   * item provides. */
  getProvidedAppliances?: () => Set<string>;
  /** Optional: Engine sets this to query how many staff of a role are
   * currently working (non-idle). Used by StaffPanel for the
   * "X working / Y idle" badge. */
  getStaffWorkingCount?: (role: StaffRole) => number;
  /** Optional accessor wired by Engine — returns the current count of
   * tickets in each pipeline state. Used by StaffPanel to show "X queued
   * · Y cooking" so the player can see throughput when staff happens to
   * be idle right now. */
  getTicketStats?: () => { queued: number; cooking: number; ready: number; delivering: number };
  /** Per-chef backlog accessor — count of queued + cooking tickets
   * routed to this specific chef. StaffPanel shows it as a small
   * badge next to each chef's name so the player can see who's
   * drowning and decide whether to hire another chef. */
  getChefBacklog?: (chefMemberId: string) => number;
  /** Phase I (H.72) — sibling accessors for the OTHER roles, so the
   * StaffPanel can render a uniform "currently working" badge for
   * every member instead of only chefs.  Same pattern Engine wires
   * for getChefBacklog. */
  getBarmanBacklog?: (barmanMemberId: string) => number;
  getWaiterBacklog?: (waiterMemberId: string) => number;
  getErrandBacklog?: (helperMemberId: string) => number;
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
  /** Fired the frame a member finishes training. Engine wires this to
   * a floating "🎓 Name is now Lk" toast. */
  onTrainingCompleted?: (member: HiredStaffMember) => void;
  /** Fired the frame a recipe finishes its in-development upgrade.
   * Engine pops a toast over the kitchen. */
  onRecipeUpgradeCompleted?: (recipe: RecipeDefinition, newLevel: number) => void;
  /** Fired when the player fires a staff member. Engine uses this to
   * remove the matching character from the world. */
  onStaffFired?: (role: StaffRole) => void;
  /** Fired when the player fires a SPECIFIC staff member (per-row
   * fire button in the StaffPanel). Engine uses memberId to target
   * the exact character model so a fired upgraded staff member
   * disappears from the world correctly — without this the old
   * LIFO removeChef path would yank a random chef instead. */
  onStaffMemberFired?: (memberId: string, role: StaffRole) => void;

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
    this.dishware = new DishwareSystem();
    // Wire DishwareSystem's storage + wash-station lookups so the cap
    // grows with placed cabinets and the auto-wash interval shortens
    // with placed sinks / dishwashers. Registry is set later by Engine,
    // hence the lazy callbacks.
    this.dishware.getStorageBonus = () => {
      if (!this.registry) return 0;
      let sum = 0;
      for (const it of this.registry.snapshotItems()) {
        const def = getFurnitureDef(it.defId);
        if (def?.dishCapacity) sum += def.dishCapacity;
      }
      return sum;
    };
    this.dishware.countWashStations = () => ({
      sinks: this.countPlacedById?.("sink") ?? 0,
      dishwashers: this.countPlacedById?.("dishwasher") ?? 0,
      dishwasherPro: this.countPlacedById?.("dishwasher-pro") ?? 0,
    });
    if (save) this.hydrate(save);
    // Seed the cooking menu with one default recipe so guests have
    // something to order. (CookingSystem hydrate would handle this on
    // load; for a fresh game we need to bootstrap it manually.)
    if (!save) {
      this.cooking.syncLuxuryUnlocks(this.luxuryTier);
      if (this.cooking.getMenuRecipeIds().length === 0) {
        this.cooking.addToMenu("toast");
      }
      // Starter staff: one of each role so the chef/waiter/errand bodies
      // visible in the world (placed by WorldScene.populateCharacters) are
      // actually accounted for in the panel — previously they would work
      // but the panel said 0 hired, which confused players. Payroll is $0
      // by default so this is a "free starter pack", not a cost.
      this.staff.addStaff("chef");
      this.staff.addStaff("waiter");
      this.staff.addStaff("errand");
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
  /** When true, update() short-circuits — used to pause sim while the
   * LoginModal blocks the player. Without this the game's day cycle
   * + customer spawns + payroll keep running behind the login UI and
   * the player loses time on every reconnect. */
  private authGated = false;
  setAuthGated(gated: boolean): void { this.authGated = gated; }
  /** True while the LoginModal owns the screen. Other UI checks
   * this to refuse rendering on top of the login flow (e.g.
   * HelpModal's auto-show). */
  isAuthGated(): boolean { return this.authGated; }

  update(dt: number): void {
    if (this.authGated) return;
    // DayCycleSystem returns whether a day just rolled over so we can
    // trigger end-of-day events (collect rent, reset daily counters, etc).
    const dayTick = this.day.tick(dt);
    if (dayTick.dayEnded) {
      this.rolloverDay();
    }
    // Rent is now charged inside rolloverDay (gated on RENT_GRACE_DAYS).
    // The old consumePendingRentPeriods path used a 24-real-hour timer
    // that never fired in practice; keeping the function in DayCycleSystem
    // for save compat but not draining it here.
    // Payroll runs continuously while staff are hired. tickSalary takes
    // a millisecond timestamp and internally rate-limits its own charges.
    if (this.restaurantOpen) {
      // tickSalary still runs during the grace period so its 5-second
      // cadence clock keeps pace — skipping it would bill one lump the
      // moment grace ends. We just don't APPLY the charge until fixed costs
      // switch on (day GRACE_DAYS+1); until then staff work for free.
      const payroll = this.staff.tickSalary(this.day.getTotalPlaySeconds() * 1000, this.admin.payrollPerStaffPerMinute);
      if (payroll.charge > 0 && !this.isInGracePeriod()) {
        const couldPay = this.economy.getMoney() >= payroll.charge;
        this.economy.forceSpendMoney(payroll.charge, "wages"); // floors at $0
        if (!couldPay) {
          // No-negative-money: payroll couldn't be covered → BENCH all active
          // staff (they keep upgrades, stop drawing wages + vanish from the
          // restaurant). The player takes the $500 grant and reactivates at will.
          const benched = this.staff.deactivateAllActive();
          for (const m of benched) this.onStaffMemberFired?.(m.id, m.role);
        }
      }
    } else {
      // Restaurant CLOSED — wages are PAUSED. Reset the accumulator so
      // reopening doesn't bill a lump sum for the whole closed gap.
      this.staff.resetSalaryTick();
    }
    // Tick any in-flight staff training. Deadlines are wall-clock so
    // we always pass Date.now() through inside tickTraining; this
    // call just polls. Each completed level fires a floating-text
    // confirmation so the player notices the bump even when their
    // attention is elsewhere on the canvas.
    const completed = this.staff.tickTraining();
    for (const m of completed) {
      this.onTrainingCompleted?.(m);
    }
    // Same drill for recipe upgrades — wall-clock deadlines that
    // could complete this frame even if the user just opened the tab.
    const completedRecipes = this.cooking.tickRecipeUpgrades();
    for (const recipeId of completedRecipes) {
      const recipe = recipes.find((r) => r.id === recipeId);
      if (recipe) this.onRecipeUpgradeCompleted?.(recipe, this.cooking.getRecipeUpgradeLevel(recipe));
    }
    // Auto-shop is now an errand-driven supply chain. Each tick we work
    // out which ingredients are genuinely under target (accounting for
    // units already on the way), build a shopping list capped at
    // AUTOSHOP_MAX_PER_TRIP, debit the cost up-front, then hand the
    // frozen list to an errand helper. The helper walks out, walks back,
    // and only then are the units added to the pantry (via
    // CookingSystem.deliverErrandOrder).
    this.autoShopClock += dt;
    if (this.autoShopEnabled && this.autoShopClock >= AUTOSHOP_INTERVAL) {
      this.autoShopClock = 0;
      // Phase H Phase 5.4 — when server owns dispatch, the server's
      // try_dispatch_errand_trip runs every restaurant tick and
      // walks the helper through the full 9-phase visual. Skip the
      // local detection + dispatch entirely so we don't race the
      // server's pick.
      if (!isServerSim("tickets")) {
        this.dispatchAutoShopTrip();
      }
    }
    // Boost timer counts down with real sim time. When it expires,
    // start the cooldown — without this the player could re-buy a
    // boost the instant the previous one ended and effectively keep a
    // permanent +2× spawn rate going.
    if (this.boostRemaining > 0) {
      const before = this.boostRemaining;
      this.boostRemaining = Math.max(0, this.boostRemaining - dt);
      if (before > 0 && this.boostRemaining === 0) {
        this.boostCooldownRemaining = BOOST_COOLDOWN_SECONDS;
      }
    } else if (this.boostCooldownRemaining > 0) {
      this.boostCooldownRemaining = Math.max(0, this.boostCooldownRemaining - dt);
    }
    // Wash dirty plates + glasses through the dishware system. Per-tier
    // pools track which dishes go back to which prestige level when
    // washed — see DishwareSystem.update for the rate logic.
    this.dishware.update(dt);
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
    // Lifetime counters — preserve any field absent from the save so
    // a partial old save doesn't wipe newer counters. Sets get
    // re-hydrated from string arrays.
    if (save.playerCounters && typeof save.playerCounters === "object") {
      const pc = save.playerCounters;
      if (typeof pc.furniturePlaced === "number") this.playerCounters.furniturePlaced = Math.max(0, pc.furniturePlaced);
      if (typeof pc.themeChanges === "number") this.playerCounters.themeChanges = Math.max(0, pc.themeChanges);
      if (typeof pc.visitsOut === "number") this.playerCounters.visitsOut = Math.max(0, pc.visitsOut);
      if (typeof pc.visitsIn === "number") this.playerCounters.visitsIn = Math.max(0, pc.visitsIn);
      if (typeof pc.chatsSent === "number") this.playerCounters.chatsSent = Math.max(0, pc.chatsSent);
      if (typeof pc.boostsUsed === "number") this.playerCounters.boostsUsed = Math.max(0, pc.boostsUsed);
      if (Array.isArray(pc.themesTried)) {
        for (const id of pc.themesTried) if (typeof id === "string") this.playerCounters.themesTried.add(id);
      }
      if (Array.isArray(pc.weathersSeen)) {
        for (const id of pc.weathersSeen) if (typeof id === "string") this.playerCounters.weathersSeen.add(id);
      }
    }
    if (typeof save.themeId === "string") {
      this.themeId = save.themeId;
      // Legacy single-theme saves: ground floor inherits themeId, upper
      // floors stay on the default until the player picks one.
      this.themeByFloor[0] = save.themeId;
    }
    if (save.themeByFloor && typeof save.themeByFloor === "object") {
      for (const [k, v] of Object.entries(save.themeByFloor)) {
        const n = Number(k);
        if (Number.isInteger(n) && n >= 0 && typeof v === "string") {
          this.themeByFloor[n] = v;
        }
      }
    }
    // Restaurant name + plaque style.
    if (typeof save.restaurantName === "string" && save.restaurantName.trim().length > 0) {
      this.restaurantName = save.restaurantName.slice(0, 28);
    }
    if (save.signStyle && typeof save.signStyle === "object") {
      const s = save.signStyle as { font?: string; textColor?: string; plaqueStyle?: string };
      this.signStyle = {
        font: s.font ?? this.signStyle.font,
        textColor: s.textColor ?? this.signStyle.textColor,
        plaqueStyle: s.plaqueStyle ?? this.signStyle.plaqueStyle,
      };
    }
    // Per-tier dishware snapshot — preferred over the legacy
    // dirtyDishCount when both are present. Hydrate sets up the pool
    // (or seeds starter inventory when no save data is present).
    this.dishware.hydrate(save.dishware, save.inFlightDishes, save.dishwareLifetime, save.dishwarePurchases);
    // Old-save fallback: dirtyDishCount existed pre-feature. We MOVE
    // pieces from clean → dirty rather than ADD to dirty, so total
    // ownership stays at the starter amount instead of inflating to
    // 23 / 25 / etc. (the pre-fix bug). When the player had more
    // legacy dirties than starter clean, we cap at clean — the rest
    // is lost to time, which is fine for a save migration edge case.
    if (!save.dishware && typeof save.dirtyDishCount === "number") {
      const n = Math.max(0, Math.floor(save.dirtyDishCount));
      for (let i = 0; i < n; i += 1) {
        const tier = this.dishware.reserveOne("plate");
        if (tier === null) break;
        this.dishware.markDirty("plate", tier);
      }
    }
    if (typeof save.stockTarget === "number") {
      // Skip setStockTarget's max-cap clamp here — the registry's
      // fridges haven't restored yet, so getMaxStockTarget() is just
      // DEFAULT_STOCK_TARGET (5) and any saved value above 5 would
      // get crushed back to 5 every refresh. Storing the raw value
      // works because getStockTarget() re-clamps at read time,
      // AFTER the registry has loaded and the cap reflects placed
      // fridges. Floors at MIN to defend against a corrupted save.
      this.stockTarget = Math.max(MIN_STOCK_TARGET, Math.round(save.stockTarget));
    }
    if (typeof save.autoShopEnabled === "boolean") {
      this.autoShopEnabled = save.autoShopEnabled;
    }
    if (typeof save.restaurantOpen === "boolean") {
      this.restaurantOpen = save.restaurantOpen;
    }
  }

  /** Public for H.30 — SpacetimeClient.applyPendingDayAdvancement
   * calls this N times to replay rollovers that accrued while the
   * tab was backgrounded. */
  /** Phase 7.4 — `chargeRent` defaults to true for foreground rollovers
   * (the normal "play through a day" path). Set to false when called
   * from applyPendingDayAdvancement on reconnect: the server's
   * tick_day_clock already debited rent from cloud_money_cents for
   * each offline day past the grace window, and Phase 7.2's
   * setMoney(cloudMoneyCents) on rollup drain already adopts that
   * value. Charging again here would double-debit. */
  rolloverDay(chargeRent: boolean = true): void {
    // Capture the day's totals BEFORE resetting them — used by both the
    // day-end modal callback AND the persistent history.
    const dayNumber = this.day.getDayNumber();
    // Rent fires once at the END of each day past the grace period.
    // dayNumber here is the day that JUST ENDED, so the first rent
    // payment lands on the rollover from day GRACE_DAYS to day
    // GRACE_DAYS+1 (i.e. days 1..GRACE_DAYS are free — no rent AND, in
    // the update() payroll path, no wages either).
    if (chargeRent && dayNumber > GRACE_DAYS && this.restaurantOpen) {
      this.economy.forceSpendMoney(this.getDailyRent(), "rent");
    }
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
    this.cooking.resetDailyConsumption();
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
   * level. Phase 9.56 — each level above 1 now adds +50% of the L1
   * profit (was +100%): L1 = base, L2 = base×1.5, L3 = base×2, … */
  getEffectiveProfit(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    const tier = getRecipeLuxuryTier(recipe);
    return this.getTierBaseProfit(tier) * (1 + 0.5 * (level - 1));
  }

  /** Final price the guest pays: profit + ingredient cost. */
  getEffectiveSellPrice(recipe: RecipeDefinition): number {
    return this.getEffectiveProfit(recipe) + this.getRecipeIngredientCost(recipe);
  }

  /** Phase 9.56 — the L1 (un-upgraded) sell price: tier base profit +
   * ingredient cost, no upgrade bonus. The setRecipeMeta cloud mirror
   * sends THIS (not the now-stale static catalog `sellPrice`) so
   * server-spawned background guests get the same tier-scaled base the
   * live client charges; build_server_order layers the per-level upgrade
   * bonus on top. (The static catalog sellPrice still drives the recipe's
   * luxury-TIER classification, so it must stay untouched.) */
  getBaseSellPrice(recipe: RecipeDefinition): number {
    return this.getTierBaseProfit(getRecipeLuxuryTier(recipe)) + this.getRecipeIngredientCost(recipe);
  }

  /** Satisfaction after upgrade level: +1.5 per level above 1. */
  getEffectiveSatisfaction(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return recipe.satisfactionEffect + (level - 1) * UPGRADE_SATISFACTION_PER_LEVEL;
  }

  /** Money cost to take this recipe to the next level. Doubles each step:
   * L1 → $30, L2 → $60, L3 → $120, L4 → $240, L5 → $480, ... */
  getRecipeUpgradeCost(recipe: RecipeDefinition): number {
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return 30 * Math.pow(2, level - 1);
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
    // Only one recipe can be in development at a time — mirrors the
    // staff training rule. If any recipe is mid-upgrade, block all
    // new starts.
    if (this.cooking.isAnyRecipeTraining()) return false;
    if (!this.economy.canAfford(this.getRecipeUpgradeCost(recipe))) return false;
    const needed = this.getRecipeUpgradeMaterials(recipe);
    for (const n of needed) {
      if (this.cooking.getIngredientQuantity(n.id) < n.qty) return false;
    }
    return true;
  }

  /** Spend money + ingredients, bump the recipe to next level. Returns
   * true on success. */
  /** Start developing a recipe — debits money + materials immediately
   * and starts a wall-clock timer. The level ticks up automatically
   * when the deadline passes. */
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
    const tier = getRecipeLuxuryTier(recipe);
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    const durationMs = getRecipeUpgradeDurationMinutes(tier, level) * 60 * 1000;
    return this.cooking.startRecipeUpgrade(recipe.id, durationMs);
  }

  /** True if this recipe is currently mid-upgrade. */
  isRecipeTraining(recipe: RecipeDefinition): boolean {
    return this.cooking.isRecipeTraining(recipe.id);
  }
  /** Id of the recipe currently being developed (any tier), or null. */
  getCurrentlyTrainingRecipeId(): string | null {
    return this.cooking.getCurrentlyTrainingRecipeId();
  }
  /** Real-time seconds remaining on this recipe's upgrade, or null. */
  getRecipeTrainingRemainingSeconds(recipe: RecipeDefinition): number | null {
    const target = this.cooking.getRecipeTrainingCompletesAt(recipe.id);
    if (target === null) return null;
    return Math.max(0, (target - Date.now()) / 1000);
  }
  /** Duration of the *next* recipe upgrade (minutes). UI shows this on
   * the Upgrade button so the player sees the commitment up front. */
  getRecipeUpgradeDurationMinutes(recipe: RecipeDefinition): number {
    const tier = getRecipeLuxuryTier(recipe);
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    return getRecipeUpgradeDurationMinutes(tier, level);
  }

  /** Roll a recipe back one level. Used by the dev-tools "Manage
   * Upgrades" panel — doesn't refund money or materials. Also cancels
   * an in-flight upgrade on that recipe. */
  demoteRecipe(recipe: RecipeDefinition): boolean {
    let changed = false;
    if (this.cooking.cancelRecipeUpgrade(recipe.id)) changed = true;
    const level = this.cooking.getRecipeUpgradeLevel(recipe);
    if (level > 1) {
      this.cooking.setRecipeUpgradeLevel(recipe.id, level - 1);
      changed = true;
    }
    return changed;
  }

  // === Staff training upgrades (per-member) ===
  // Cook speed / serve speed / carry capacity. Each member trains
  // independently — the player picks a specific chef or waiter to
  // mentor instead of buffing the whole role.

  /** Per-member training level. */
  getMemberUpgradeLevel(id: string): number {
    return this.staff.getMemberUpgradeLevel(id);
  }
  /** Cost to train THIS member one more level. */
  getMemberUpgradeCost(id: string): number {
    return this.staff.getMemberUpgradeCost(id);
  }
  /** Restaurant tier required for the next training level on this
   * member. UpgradeModal surfaces it so players know what to unlock
   * to keep training. */
  getMemberUpgradeRequiredTier(id: string): LuxuryTier | null {
    const level = this.staff.getMemberUpgradeLevel(id);
    if (level >= STAFF_UPGRADE_MAX) return null;
    return (level + 1) as LuxuryTier;
  }
  canUpgradeMember(id: string): boolean {
    const m = this.staff.getMember(id);
    if (!m) return false;
    if (m.upgradeLevel >= STAFF_UPGRADE_MAX) return false;
    // Only one training slot in the whole restaurant — if anyone is
    // currently studying, nobody else can start.
    if (this.staff.isAnyMemberTraining()) return false;
    // Each training level is gated behind the matching restaurant
    // tier: L1 needs T1, L5 needs T5.
    if (m.upgradeLevel + 1 > this.getLuxuryTier()) return false;
    return this.economy.canAfford(this.staff.getMemberUpgradeCost(id));
  }

  /** Id of the member who's currently in training (null if nobody
   * is). UI uses this to show "Another in progress" on the other
   * rows. */
  getCurrentlyTrainingMemberId(): string | null {
    return this.staff.getCurrentlyTrainingMemberId();
  }
  /** Start a training run on a member. Money is debited up front;
   * the level ticks up automatically when the wall-clock deadline
   * passes — closing the tab, pausing, or fast-forwarding in-game
   * time don't speed it up. */
  upgradeMember(id: string): boolean {
    if (!this.canUpgradeMember(id)) return false;
    const cost = this.staff.getMemberUpgradeCost(id);
    if (!this.economy.spendMoney(cost, "unlock")) return false;
    return this.staff.startMemberTraining(id);
  }
  /** True if the member is currently mid-training. UI uses this to
   * disable the Train button and show a countdown instead. */
  isMemberTraining(id: string): boolean {
    return this.staff.isMemberTraining(id);
  }
  /** Real-time seconds remaining on this member's training, or null
   * if they're not training. */
  getMemberTrainingRemainingSeconds(id: string): number | null {
    const target = this.staff.getMemberTrainingCompletesAt(id);
    if (target === null) return null;
    return Math.max(0, (target - Date.now()) / 1000);
  }
  /** Roll a member back one training level. Used by the dev-tools
   * "Manage Upgrades" window. Doesn't refund the money — the dev
   * panel can add a refund if it wants one. */
  demoteMember(id: string): boolean {
    return this.staff.demoteMember(id);
  }

  /** Effective cook time for a recipe with a SPECIFIC chef's training
   * applied. StaffRouter calls this with the chef who's about to
   * start cooking. COOK_TIME_GLOBAL_MULT bumps base prep up so an
   * untrained kitchen reads as "doing real work"; a maxed L5 chef
   * still ends up faster than the legacy timing. */
  getEffectiveCookSecondsForChef(recipe: RecipeDefinition, chefMemberId: string): number {
    const mult = this.staff.getChefCookMultiplier(chefMemberId);
    return Math.max(1, recipe.preparationTimeSeconds * COOK_TIME_GLOBAL_MULT * mult);
  }
  /** Base cook-seconds (no chef adjustment). GuestSpawner enqueues
   * this so the ticket carries a stable "base" the chef can then
   * scale by their own multiplier on pickup. */
  getBaseCookSeconds(recipe: RecipeDefinition): number {
    return Math.max(1, recipe.preparationTimeSeconds * COOK_TIME_GLOBAL_MULT);
  }
  /** Walk-speed multiplier for a specific waiter. */
  getWaiterSpeedMultiplier(memberId: string): number {
    return this.staff.getWaiterSpeedMultiplier(memberId);
  }
  /** Per-trip carry cap for the auto-shop dispatcher (uses the
   * best-trained helper). */
  getHelperCarryCapacity(): number {
    return this.staff.getHelperCarryCapacity();
  }

  // === Stock target (auto-shop refill level) ===
  /** What the auto-shop refills toward — the player's manually-chosen
   * target, clamped to the current effective max. Fridges only RAISE
   * THE CEILING (how high the player is allowed to set it), they
   * don't push the target up automatically. Default sits at
   * DEFAULT_STOCK_TARGET (5) and only changes when the player clicks
   * the +/- buttons. */
  getStockTarget(): number {
    const cap = this.getMaxStockTarget();
    return Math.max(MIN_STOCK_TARGET, Math.min(cap, this.stockTarget));
  }
  /** Manually-set baseline — what the +/- UI displays. Same as
   * getStockTarget() in normal use; exists for symmetry with the cap. */
  getBaseStockTarget(): number { return this.stockTarget; }
  /** Sum of stockCapacity across all placed furniture (fridges,
   * pantries, etc.). Adds onto the no-fridge base cap of
   * DEFAULT_STOCK_TARGET to produce the effective max. */
  getFridgeStockBonus(): number {
    if (!this.registry) return 0;
    let sum = 0;
    for (const it of this.registry.snapshotItems()) {
      const def = getFurnitureDef(it.defId);
      if (def?.stockCapacity) sum += def.stockCapacity;
    }
    return sum;
  }
  getMinStockTarget(): number { return MIN_STOCK_TARGET; }
  /** Highest value the player is allowed to set the stock target to —
   * DEFAULT_STOCK_TARGET (5) plus the total fridge stockCapacity
   * bonus, capped at MAX_STOCK_TARGET (50). Without any fridges the
   * cap is just the default 5; a single regular fridge raises it to 7;
   * a walk-in to 11; etc. */
  getMaxStockTarget(): number {
    return Math.min(MAX_STOCK_TARGET, DEFAULT_STOCK_TARGET + this.getFridgeStockBonus());
  }
  setStockTarget(n: number): void {
    const cap = this.getMaxStockTarget();
    this.stockTarget = Math.max(MIN_STOCK_TARGET, Math.min(cap, Math.round(n)));
  }
  /** Convenience: +1 or -1 with clamp. Returns the new value. */
  bumpStockTarget(delta: number): number {
    this.setStockTarget(this.stockTarget + delta);
    return this.stockTarget;
  }

  /** Read the latest auto-shop summary. Used by PantryModal so the player
   * can see WHEN restocking actually happened — without it the modal
   * sits frozen and looks like nothing is happening. Returns null if no
   * auto-shop has fired this session yet. */
  getLastAutoShop(): { atMs: number; totalSpent: number; itemCount: number; ids: ReadonlySet<string> } | null {
    return this.lastAutoShop;
  }

  /** Build a 10-item shopping list of ingredients genuinely below target
   * (excluding any units already on the way with another errand helper),
   * spend the money up-front, mark the units as pending, then trigger
   * an errand trip with the frozen list. The list is delivered to the
   * pantry by completeErrandDelivery when the helper returns home.
   *
   * Bails early if the errand system can't take another trip — the
   * router used to silently drop overflow trips after debiting our
   * money + reserving the pending units, which leaked the pending
   * counter forever ("31 in transit but only 1 helper" bug). */
  private dispatchAutoShopTrip(): void {
    if (this.canDispatchErrand && !this.canDispatchErrand()) return;
    const pantry = this.cooking.getPantryRaw();
    const target = this.stockTarget;
    const costMult = this.admin.ingredientCostMultiplier;
    // Per-ingredient genuine need = target - on-shelf - on-the-way.
    const needs = pantry
      .map((stock) => ({
        id: stock.id,
        deficit: target - stock.quantity - this.cooking.getPendingForIngredient(stock.id),
      }))
      .filter((n) => n.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit);
    if (needs.length === 0) return;
    // Greedy fill of a trip up to the helper's carry capacity. The
    // base cap is AUTOSHOP_MAX_PER_TRIP; the errand-helper training
    // upgrade lifts it +2 per level (so L5 = 20).
    const carryCap = Math.max(AUTOSHOP_MAX_PER_TRIP, this.getHelperCarryCapacity());
    const list = new Map<string, number>();
    let total = 0;
    for (const n of needs) {
      if (total >= carryCap) break;
      const take = Math.min(n.deficit, carryCap - total);
      if (take > 0) {
        list.set(n.id, take);
        total += take;
      }
    }
    if (total === 0) return;
    // Price out the trip + bail if the player can't afford it.
    let totalCost = 0;
    for (const [id, units] of list) {
      totalCost += Math.max(0, Math.round(getIngredientCost(id) * costMult)) * units;
    }
    if (totalCost > 0 && !this.economy.spendMoney(totalCost, "ingredients")) {
      return; // not enough money for this trip — try again next interval
    }
    // Reserve so the next dispatch won't re-buy the same units.
    for (const [id, units] of list) this.cooking.addPendingErrandOrder(id, units);
    // Record what was dispatched + fire the errand helper. The list is
    // frozen here — by the time the helper returns home (~7s later) the
    // pantry may have dropped further, but the trip still delivers
    // exactly these units.
    this.lastAutoShop = {
      atMs: Date.now(),
      totalSpent: totalCost,
      itemCount: list.size,
      ids: new Set(list.keys()),
    };
    this.onAutoShopDispatch?.(list);
  }

  /** Called by the Engine wiring once an errand helper walks back through
   * the door — drains the list onto the pantry shelves and clears the
   * pending reservation. */
  completeErrandDelivery(list: Map<string, number>): void {
    this.cooking.deliverErrandOrder(list);
  }

  /** Fired when an auto-shop trip is dispatched to an errand helper. The
   * Engine wires this to ErrandRouter.triggerRun(list). */
  onAutoShopDispatch?: (list: Map<string, number>) => void;
  /** Queried by the auto-shop dispatcher before committing money — true
   * if the errand router can absorb another trip. Wired by Engine to
   * ErrandRouter.canAcceptTrip. Without this gate, dispatched trips
   * that overflow the router queue silently dropped, leaking the
   * pending-orders counter forever. */
  canDispatchErrand?: () => boolean;

  /** A 0..5 vibe score that drives how willing customers are to wait
   * in an overflow chair. Combines the rolling average rating with a
   * decor contribution from placed furniture (style + attractionBonus).
   *
   * A starter restaurant (no decor, default rating 3.0) sits around 1.8
   * — well below the wait threshold, so nobody queues. As the player
   * decorates + earns higher ratings the score climbs and the queue
   * grows. */
  getAttractiveness(): number {
    const rating = this.reputation.getAverageRating(); // 1..5, defaults to 3.0
    const decor = this.registry
      ? this.registry.getAggregateStats().style + this.registry.getAggregateStats().attractionBonus
      : 0;
    // Lift decor onto the same ~1..5 scale, soft-capped.
    const decorScore = Math.min(5, 1 + decor / 18);
    return Math.max(0, Math.min(5, rating * 0.55 + decorScore * 0.45));
  }

  /** Optional accessor to the placed-furniture registry — set by Engine
   * once the world is ready. Used by getAttractiveness to read decor. */
  registry?: {
    getAggregateStats(): { style: number; comfort: number; attractionBonus: number; ratingBonus: number };
    snapshotItems(): readonly { defId: string; floor: number }[];
  };

  /** Per-placement floor indices for the build-on-N-floors and
   * skyscraper achievements. Empty when no registry is wired
   * (pre-Engine.start) or no furniture is placed yet. */
  snapshotFurnitureFloors(): readonly number[] {
    if (!this.registry) return [];
    return this.registry.snapshotItems().map((it) => it.floor);
  }

  /** Per-placement category strings — derived from the catalog so
   * the achievement predicates can count decor-class items
   * (decoration / plant / lamp) without each one stamping itself.
   * Returns an empty array when the registry isn't wired yet. */
  snapshotFurnitureCategories(): readonly string[] {
    if (!this.registry) return [];
    const out: string[] = [];
    for (const it of this.registry.snapshotItems()) {
      const def = getFurnitureDef(it.defId);
      if (def?.category) out.push(def.category);
    }
    return out;
  }

  /** Per-plot rent multiplier — small plots pay 60% rent, medium
   * 100%, large 140%. Set by Engine when the player's claimed
   * building is resolved. Default 1.0 keeps the legacy single-
   * plot behaviour working when no building is set. */
  plotRentMultiplier = 1.0;

  /** Daily rent owed this in-game day. Scales with luxury tier,
   * the admin.rentMultiplier knob, AND the plot size. */
  getDailyRent(): number {
    const tier = Math.max(1, Math.min(5, this.luxuryTier));
    const raw = RENT_BY_TIER[tier] ?? RENT_BY_TIER[1];
    return Math.max(0, Math.round(raw * this.admin.rentMultiplier * this.plotRentMultiplier));
  }

  /** Opening grace period — days 1..GRACE_DAYS pay no rent AND no wages.
   * The HUD shows a live countdown so fixed costs switching on isn't a
   * surprise. */
  isInGracePeriod(): boolean {
    return this.day.getDayNumber() <= GRACE_DAYS;
  }
  /** Free days left in the opening grace (0 once over; 1 on the last free
   * day, GRACE_DAYS itself). */
  getGraceDaysRemaining(): number {
    return Math.max(0, GRACE_DAYS - this.day.getDayNumber() + 1);
  }
  /** Total grace length in days — for "costs start day N" copy. */
  getGracePeriodDays(): number {
    return GRACE_DAYS;
  }
  /** Live real-time seconds until rent + wages switch on (0 once active):
   * whole days left before the grace ends × day length + time left today. */
  getSecondsUntilCostsStart(): number {
    if (!this.isInGracePeriod()) return 0;
    const daysAfterToday = GRACE_DAYS - this.day.getDayNumber();
    return daysAfterToday * this.day.getDayLengthSeconds() + this.day.getTimeRemainingSeconds();
  }

  // === Dirty-dish pile ===
  //
  // These thin shims now read through DishwareSystem so the HUD + the
  // GuestSpawner penalty keep working without each caller having to
  // know about the per-tier pool structure.

  /** Total dirty plates + glasses queued for washing. */
  getDirtyDishCount(): number {
    return this.dishware.getDirty("plate") + this.dishware.getDirty("glass");
  }

  /** Legacy shim: route an untyped "a dish became dirty" call into the
   * T1 plate pool. New code (GuestSpawner) should call
   * dishware.markDirty with the actual tier of the served piece. */
  addDirtyDish(count = 1): void {
    for (let i = 0; i < count; i += 1) this.dishware.markDirty("plate", 1);
  }

  /** True when the pile is large enough that newly-rolled guest ratings
   * should be penalized for a noticeably dirty restaurant. */
  isDishPileOverwhelming(): boolean {
    return this.getDirtyDishCount() > DIRTY_PILE_PENALTY_THRESHOLD;
  }

  /** Seconds between wash ticks, reduced by sinks (-0.5s each) and
   * dishwashers (-1.0s for compact, -1.5s for pro), then scaled by
   * admin.dishWashMultiplier. Floored at 0.4s.
   *
   * @deprecated DishwareSystem owns the wash cadence now. Kept as a
   * helper for any callers (UI tooltips, admin panel) that want to
   * surface it. */
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

  /** Theme currently applied to the ground floor. Kept for any caller
   * that still wants the "primary" theme without specifying a floor
   * (e.g. the door plaque or other shared decor that lives on the
   * exterior). */
  getCurrentTheme(): RestaurantTheme {
    return this.getThemeForFloor(0);
  }

  /** Theme currently applied to a specific floor. Falls back to the
   * default theme when no override has been set for that floor. */
  getThemeForFloor(floor: number): RestaurantTheme {
    const id = this.themeByFloor[floor] ?? (floor === 0 ? this.themeId : RESTAURANT_THEMES[0].id);
    return RESTAURANT_THEMES.find((t) => t.id === id) ?? RESTAURANT_THEMES[0];
  }

  /** Snapshot the per-floor theme map for save. Returns a plain object
   * keyed by storey index, omitting entries equal to the default theme
   * so the save stays minimal. */
  snapshotThemesByFloor(): Record<number, string> {
    return { ...this.themeByFloor };
  }

  /** Apply (and persist) a theme to a specific floor. Free themes skip
   * the money check. Returns true on success. */
  applyTheme(floor: number, themeId: string): boolean {
    const theme = RESTAURANT_THEMES.find((t) => t.id === themeId);
    if (!theme) return false;
    const currentForFloor = this.themeByFloor[floor] ?? (floor === 0 ? this.themeId : RESTAURANT_THEMES[0].id);
    if (theme.id === currentForFloor) return true; // no-op
    if (theme.cost > 0 && !this.economy.spendMoney(theme.cost, "decor")) return false;
    this.themeByFloor[floor] = theme.id;
    if (floor === 0) this.themeId = theme.id; // keep legacy field in sync for save compat
    // Lifetime counters for the achievement system.
    this.bumpPlayerCounter("themeChanges");
    this.recordPlayerSet("themesTried", theme.id);
    this.onThemeChanged?.(floor, theme);
    return true;
  }

  // === Door plaque (restaurant name + sign styling) ===

  /** Engine wires this so the WorldScene re-renders the plaque canvas
   * whenever the player edits the name or picks a different style.
   * Persisted via SaveSystem so a reload keeps the player's branding. */
  onRestaurantSignChanged?: (name: string, style: { font: string; textColor: string; plaqueStyle: string }) => void;

  getRestaurantName(): string {
    return this.restaurantName;
  }
  getRestaurantSignStyle(): { font: string; textColor: string; plaqueStyle: string } {
    return { ...this.signStyle };
  }
  /** Update the plaque's name + style. Empty / blank names fall back
   * to "Cozy Bistro" so the plaque never reads empty. Fires the
   * scene-update callback so the world plaque re-renders instantly. */
  setRestaurantSign(name: string, style: { font: string; textColor: string; plaqueStyle: string }): void {
    const trimmed = name.trim();
    this.restaurantName = trimmed.length > 0 ? trimmed.slice(0, 28) : "Cozy Bistro";
    this.signStyle = { ...style };
    this.onRestaurantSignChanged?.(this.restaurantName, this.signStyle);
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

  /** Seconds left on the post-boost cooldown (0 = ready to buy
   * again). UI uses this to disable the boost button + show a
   * countdown so the player can tell why their click is being
   * rejected. */
  getBoostCooldownRemaining(): number {
    return this.boostCooldownRemaining;
  }

  /** Full cooldown length in seconds — exposed so the UI can compute
   * a progress fraction if it wants. Kept as a getter (not a const
   * import) for symmetry with the duration / cost accessors. */
  getBoostCooldownDurationSeconds(): number {
    return BOOST_COOLDOWN_SECONDS;
  }

  /** Cost of buying a 60s boost. Scales gently with player wealth so it
   * stays meaningful in the late game. */
  getBoostCost(): number {
    return 80;
  }
  getBoostDurationSeconds(): number {
    return 60;
  }
  /** Try to buy a boost. Returns true if money was spent and timer was
   * reset. Rejects without charging when:
   *   - a boost is already active (no stacking — would double-pay for
   *     the same effective spawn rate)
   *   - the post-boost cooldown is still ticking
   *   - the player can't afford it
   * The UI also disables the button in these cases as a UX hint, but
   * this guard is the canonical gate. */
  /** Phase 6.7 — Engine wires this to SpacetimeClient.setBoostExpiresAt
   * so buyBoost can mirror the active-boost expiry to the cloud.
   * Without this, the server's offline spawn gate doesn't know a
   * boost is active and a paid boost only accelerates spawns while
   * the player keeps the tab foregrounded. Optional — single-player /
   * pre-cloud sessions just don't fire it. */
  onBoostStarted?: (expiresAtMs: number) => void;

  /** Phase 6.10 — Reconcile boostRemaining + boostCooldownRemaining
   * against wall-clock truth from the cloud's boost_expires_at_micros.
   * Engine calls this on subscription-ready (and any time the
   * Restaurant row reports a fresh boost_expires_at) so the player
   * doesn't get re-locked into a stale cooldown after a long offline
   * period.
   *
   * Three possible states:
   *   - now < expiresAtMs              → boost still active; restore
   *                                       boostRemaining + zero cooldown
   *   - now < expiresAtMs + cooldownMs → cooldown still ticking
   *   - now ≥ expiresAtMs + cooldownMs → fully ready to buy again
   *
   * Zero/negative `boostExpiresAtMs` means "never boosted on this
   * restaurant" — clear both timers. */
  restoreBoostStateFromCloud(boostExpiresAtMs: number): void {
    if (boostExpiresAtMs <= 0) {
      this.boostRemaining = 0;
      this.boostCooldownRemaining = 0;
      return;
    }
    const now = Date.now();
    const cooldownMs = BOOST_COOLDOWN_SECONDS * 1000;
    if (now < boostExpiresAtMs) {
      this.boostRemaining = (boostExpiresAtMs - now) / 1000;
      this.boostCooldownRemaining = 0;
    } else if (now < boostExpiresAtMs + cooldownMs) {
      this.boostRemaining = 0;
      this.boostCooldownRemaining = (boostExpiresAtMs + cooldownMs - now) / 1000;
    } else {
      this.boostRemaining = 0;
      this.boostCooldownRemaining = 0;
    }
  }

  buyBoost(): boolean {
    if (this.boostRemaining > 0) return false;
    if (this.boostCooldownRemaining > 0) return false;
    if (!this.economy.spendMoney(this.getBoostCost(), "decor")) return false;
    const durationSeconds = this.getBoostDurationSeconds();
    this.boostRemaining = durationSeconds;
    this.bumpPlayerCounter("boostsUsed");
    // Phase 6.7 — Date.now() is OK here. buyBoost is a discrete UI
    // event, not a render path; the Engine.update loop is what
    // disallows wall-clock for resume determinism.
    this.onBoostStarted?.(Date.now() + durationSeconds * 1000);
    return true;
  }

  // === Staff hire/fire (wraps economy + StaffSystem + fires callback) ===

  /** Minimum luxury tier required to hire a given role. Most roles
   * unlock at tier 1 (immediately available); barman is gated to
   * tier 2 so the player meets the rest of the game before they
   * have to think about a bar economy. Update this if more roles
   * need staggered unlocks. */
  getRoleUnlockTier(role: StaffRole): LuxuryTier {
    return role === "barman" ? 2 : 1;
  }

  /** Whether the role is HIRABLE right now (tier unlocked + money
   * available). Drives StaffPanel's button state — without it the
   * UI shows a hire button that silently rejects on click. */
  canHireStaff(role: StaffRole): { ok: boolean; reason?: string } {
    const required = this.getRoleUnlockTier(role);
    if (this.luxuryTier < required) {
      return { ok: false, reason: `Unlocks at tier ${required}` };
    }
    if (!this.economy.canAfford(this.staff.getStaffHireCost(role))) {
      return { ok: false, reason: "Not enough cash" };
    }
    return { ok: true };
  }

  /** Try to hire a staff member. Returns true on success (money was
   * available and was charged, headcount went up, callback fired).
   * Tier gate is enforced here too — the UI's pre-check is a hint;
   * this is the canonical guard. */
  hireStaff(role: StaffRole): boolean {
    if (this.luxuryTier < this.getRoleUnlockTier(role)) return false;
    const cost = this.staff.getStaffHireCost(role);
    if (!this.economy.spendMoney(cost, "staff")) return false;
    const member = this.staff.addStaff(role);
    // Index is just for backward-compat with existing callback shape —
    // the router looks up the new member by polling the StaffSystem,
    // not by id, so the actual id is consulted there.
    this.onStaffHired?.(role, this.staff.getStaffCount(role) - 1);
    return member.upgradeLevel === 0;
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

  /** Fire one SPECIFIC hired staff member by their id. Charges the
   * usual severance for the member's role, drops them from the
   * StaffSystem roster, and fires onStaffMemberFired so Engine can
   * remove the right character model from the scene. Returns
   * true on success, false if the id is unknown. */
  fireStaffMember(memberId: string): boolean {
    const members = this.staff.getMembers();
    const member = members.find((m) => m.id === memberId);
    if (!member) return false;
    const role = member.role;
    const cost = this.staff.getStaffFireCost(role);
    this.economy.forceSpendMoney(cost, "charge");
    const removed = this.staff.removeStaffById(memberId);
    if (!removed) return false;
    this.onStaffMemberFired?.(memberId, role);
    return true;
  }

  /** No-negative-money: reactivate a BENCHED staff member (free — they kept
   * their upgrades). Un-benches them in the roster + respawns their world
   * actor. Returns true on success, false if the id isn't a benched member. */
  reactivateStaffMember(memberId: string): boolean {
    const member = this.staff.reactivateMember(memberId);
    if (!member) return false;
    this.onStaffHired?.(member.role, this.staff.getStaffCount(member.role) - 1);
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

  /** Fired when the tier changes — Engine wires WorldScene.setLuxuryTier
   * to this so locked sections become visible (or stay hidden). */
  onLuxuryTierChanged?: (tier: LuxuryTier) => void;

  /** Try to bump luxury tier by 1. Spends money, syncs recipe unlocks.
   * Returns true on success. */
  buyExpansion(): boolean {
    if (this.luxuryTier >= MAX_LUXURY_TIER) return false;
    const cost = this.getExpansionCost();
    if (!this.economy.spendMoney(cost, "unlock")) return false;
    this.luxuryTier = (this.luxuryTier + 1) as LuxuryTier;
    this.cooking.syncLuxuryUnlocks(this.luxuryTier);
    this.onLuxuryTierChanged?.(this.luxuryTier);
    return true;
  }

  // === Admin / dev-tool helpers — NOT exposed in normal gameplay ===
  //
  // Each method skips the usual cost / cooldown checks and is intended
  // to be wired only into the AdminModal. They mirror the cancel /
  // demote helpers above so the panel can drive everything through
  // Game without poking into private state.

  /** Set the luxury tier directly (clamped to 1..MAX). Re-syncs recipe
   * unlocks and fires onLuxuryTierChanged. */
  adminSetLuxuryTier(tier: number): void {
    const clamped = Math.max(1, Math.min(MAX_LUXURY_TIER, Math.round(tier))) as LuxuryTier;
    if (clamped === this.luxuryTier) return;
    this.luxuryTier = clamped;
    this.cooking.syncLuxuryUnlocks(this.luxuryTier);
    this.onLuxuryTierChanged?.(this.luxuryTier);
  }

  /** Bump a recipe's upgrade level up by `delta` (negative for down).
   * Cancels any in-flight upgrade on it. Clamped to [1, maxLevel]. No
   * cost charged. */
  adminAdjustRecipeLevel(recipe: RecipeDefinition, delta: number): void {
    this.cooking.cancelRecipeUpgrade(recipe.id);
    const cur = this.cooking.getRecipeUpgradeLevel(recipe);
    this.cooking.setRecipeUpgradeLevel(recipe.id, cur + delta);
  }

  /** Bump a staff member's upgrade level up by `delta` (negative for
   * down). Cancels any in-flight training. */
  adminAdjustMemberLevel(id: string, delta: number): void {
    this.staff.adminAdjustLevel(id, delta);
  }

  /** Top up every ingredient to the active stock target. */
  adminFillPantry(): void {
    const target = this.getStockTarget();
    for (const stock of this.cooking.getPantryRaw()) {
      if (stock.quantity < target) stock.quantity = target;
    }
  }

  /** Drop every ingredient to zero. Useful for testing the out-of-
   * stock / auto-shop pipeline. */
  adminEmptyPantry(): void {
    for (const stock of this.cooking.getPantryRaw()) stock.quantity = 0;
  }

  /** Reset all reputation history so the next customer's rating is
   * the starting average. */
  adminResetReputation(): void {
    this.reputation.adminReset();
  }

  /** Admin one-shot: undo accumulated dishware over-compensation
   * by rewinding inventory + lifetime totals to STARTER + the
   * recorded purchase log. Players who sat on the pre-fix hydrate
   * bug had hundreds of phantom plates / glasses; this gets them
   * back to "exactly what I actually bought" without losing any
   * future purchases. */
  adminReconcileDishware(): { plates: number; glasses: number } {
    this.dishware.reconcileToPurchaseLog();
    return {
      plates: this.dishware.getOwned("plate"),
      glasses: this.dishware.getOwned("glass"),
    };
  }
}

/** Turn "olive-oil" / "olive_oil" / "olive oil" into "Olive Oil". */
function prettifyIngredientId(id: string): string {
  return id.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
