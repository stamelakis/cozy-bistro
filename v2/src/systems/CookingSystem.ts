import type { ApplianceId, IngredientStock, LuxuryTier, RecipeDefinition, SaveGameState } from "../data/types";
import { recipes } from "../data/recipes";
import { isServerSim } from "../game/featureFlags";

import { clamp } from "../data/util";
export const maxRecipeUpgradeLevel = 10;
export const maxActiveRecipesPerCategory = 3;

export type RecipeIdentifier = RecipeDefinition | string;

/**
 * The cooking system owns the player's recipe roster (which recipes are unlocked at the
 * current luxury tier, which ones are active on the served menu, per-recipe upgrade
 * levels) and the pantry/ingredient inventory (current stock, pending errand orders,
 * in-transit deliveries, prepared servings sitting on the pass).
 *
 * It does not own live cooking timers, station actors, or pantry UI rendering — those
 * still live in the scene.
 *
 * Methods that depend on the current unlocked luxury tier take it as a parameter rather
 * than reading from state. The scene owns expansionLevel and computes the tier; this
 * keeps CookingSystem decoupled from expansion mechanics.
 */
export class CookingSystem {
  private menuRecipeIds: string[];
  private unlockedRecipeIds: string[];
  private recipeUpgradeLevels: Record<string, number> = {};
  /** Wall-clock deadlines for in-flight recipe upgrades. Keyed by
   * recipe id; the value is a `Date.now()`-style timestamp. The
   * kitchen only develops one dish at a time so this map has at most
   * one entry — using a record (not a scalar) lets the save format
   * extend to multiple parallel runs cleanly if we ever want to. */
  private recipeTrainingCompletesAt: Record<string, number> = {};
  private pantry: IngredientStock[] = [];
  private errandOrder: Record<string, number> = {};
  private errandInTransit: Record<string, number> = {};
  private preparedServings: Record<string, number> = {};
  /** H.36 — Cloud handle for mirroring pantry mutations. Wired
   *  optionally by Engine after auth lands; null in tests or before
   *  cloud connect. Mirror helpers below bail silently when unset
   *  or when we'd be pushing a zero delta. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;
  /** Suppresses pantry mirror writes during bulk-load paths (save
   *  hydrate, cloud restore) — the cloud already holds those values
   *  and re-firing every entry's delta would just duplicate what
   *  subscription already knows. */
  private suppressPantryMirror = false;

  constructor() {
    this.menuRecipeIds = recipes
      .filter((recipe) => (recipe.luxuryTier ?? 1) <= 1 && recipe.activeByDefault)
      .map((recipe) => recipe.id);
    this.unlockedRecipeIds = recipes
      .filter((recipe) => (recipe.luxuryTier ?? 1) <= 1)
      .map((recipe) => recipe.id);
  }

  getMenuRecipeIds(): readonly string[] {
    return this.menuRecipeIds;
  }

  getMenuRecipeIdsSnapshot(): string[] {
    return this.menuRecipeIds.slice();
  }

  getUnlockedRecipeIds(): readonly string[] {
    return this.unlockedRecipeIds;
  }

  getUnlockedRecipeIdsSnapshot(): string[] {
    return this.unlockedRecipeIds.slice();
  }

  getRecipeUpgradeLevelsSnapshot(): Record<string, number> {
    return { ...this.recipeUpgradeLevels };
  }

  isRecipeUnlocked(recipe: RecipeDefinition, unlockedTier: LuxuryTier): boolean {
    return getRecipeLuxuryTier(recipe) <= unlockedTier;
  }

  getRecipeUpgradeLevel(recipe: RecipeIdentifier): number {
    const recipeId = typeof recipe === "string" ? recipe : recipe.id;
    return clamp(Math.floor(this.recipeUpgradeLevels[recipeId] ?? 1), 1, maxRecipeUpgradeLevel);
  }

  setRecipeUpgradeLevel(recipeId: string, level: number): void {
    const clamped = clamp(Math.floor(level), 1, maxRecipeUpgradeLevel);
    this.recipeUpgradeLevels[recipeId] = clamped;
    // H.53 — mirror per-restaurant per-recipe level so server's
    // build_server_order applies the same effective satisfaction +
    // price bonuses to server-spawned guests' orders.
    if (this.cloud) {
      this.cloud.setRecipeLevel(recipeId, clamped);
    }
  }

  // === Recipe upgrade training (wall-clock) ===

  /** Snapshot of the in-flight deadlines map for save round-trips. */
  getRecipeTrainingSnapshot(): Record<string, number> {
    return { ...this.recipeTrainingCompletesAt };
  }

  /** True if a specific recipe is currently being developed. */
  isRecipeTraining(recipeId: string): boolean {
    return typeof this.recipeTrainingCompletesAt[recipeId] === "number";
  }

  /** Id of the recipe currently being developed, or null if the
   * kitchen is idle. Caller (UI) uses this to disable other recipe
   * Upgrade buttons while one is in progress. */
  getCurrentlyTrainingRecipeId(): string | null {
    for (const id of Object.keys(this.recipeTrainingCompletesAt)) return id;
    return null;
  }
  isAnyRecipeTraining(): boolean {
    return this.getCurrentlyTrainingRecipeId() !== null;
  }

  /** Wall-clock deadline (ms) for the in-flight upgrade, or null. */
  getRecipeTrainingCompletesAt(recipeId: string): number | null {
    return this.recipeTrainingCompletesAt[recipeId] ?? null;
  }

  /** Phase 9.9 — Adopt the cloud's in-flight upgrade deadlines as
   * truth on reconnect. The local save restored whatever timers were
   * running at the last autosave; the SERVER kept ticking while the
   * tab was closed (recipe_upgrade_in_flight rows are deleted on
   * completion and the recipe id lands in the pending-completions
   * CSV, drained separately). So after this call:
   *   - a cloud row → its deadline replaces the local one (fixes
   *     "timer shows the wrong remaining time" after reload),
   *   - no cloud row → the local entry is DROPPED (fixes the ghost
   *     countdown ticking toward a moment in the past for an
   *     upgrade the server already completed).
   * Mirrors restoreBoostStateFromCloud's shape. */
  restoreRecipeUpgradesFromCloud(
    rows: { recipeId: string; completesAtMs: number }[],
  ): void {
    const next: Record<string, number> = {};
    for (const r of rows) next[r.recipeId] = r.completesAtMs;
    const before = Object.keys(this.recipeTrainingCompletesAt).sort().join(",") || "(none)";
    const after = Object.keys(next).sort().join(",") || "(none)";
    if (before !== after) {
      console.log(`[9.9] recipe upgrade timers: local [${before}] → cloud [${after}] — adopting cloud`);
    }
    this.recipeTrainingCompletesAt = next;
  }

  /** Path B — Adopt the cloud's prepared_serving rows as truth on
   * reconnect. preparedServings was save-only before this: a reload
   * mid-service lost every cook-ahead dish on the pass even though
   * the ingredients were already spent. Cloud rows win WHOLESALE,
   * exactly like restoreRecipeUpgradesFromCloud above:
   *   - a cloud row → its count replaces the local one,
   *   - no cloud row → the local entry is DROPPED (the dish was
   *     consumed in another session, or the save predates the
   *     mirror).
   * Does NOT re-fire the mirror — the cloud already holds these. */
  restorePreparedServingsFromCloud(
    rows: { recipeId: string; count: number }[],
  ): void {
    const next: Record<string, number> = {};
    for (const r of rows) {
      const n = Math.max(0, Math.floor(r.count));
      if (r.recipeId && n > 0) next[r.recipeId] = n;
    }
    const before = Object.keys(this.preparedServings).sort().join(",") || "(none)";
    const after = Object.keys(next).sort().join(",") || "(none)";
    if (before !== after) {
      console.log(`[PathB] prepared servings: local [${before}] → cloud [${after}] — adopting cloud`);
    }
    this.preparedServings = next;
  }

  /** Start a recipe-upgrade timer. Returns true when it actually
   * started (recipe wasn't already training, current level < max).
   * Caller is responsible for debiting money / materials. */
  startRecipeUpgrade(recipeId: string, durationMs: number): boolean {
    if (this.isRecipeTraining(recipeId)) return false;
    const level = this.getRecipeUpgradeLevel(recipeId);
    if (level >= maxRecipeUpgradeLevel) return false;
    const completesAt = Date.now() + durationMs;
    this.recipeTrainingCompletesAt[recipeId] = completesAt;
    // H.43 — mirror the deadline server-side so the level-up fires
    // even if the tab is closed for the whole window.
    if (this.cloud) {
      this.cloud.startRecipeUpgrade(recipeId, completesAt);
    }
    return true;
  }

  cancelRecipeUpgrade(recipeId: string): boolean {
    if (!this.isRecipeTraining(recipeId)) return false;
    delete this.recipeTrainingCompletesAt[recipeId];
    // H.43 — mirror cancellation; server drops the in-flight row.
    if (this.cloud) {
      this.cloud.cancelRecipeUpgrade(recipeId);
    }
    return true;
  }

  /** Tick all in-flight recipe upgrades — any whose Date.now()
   * deadline has passed get their level bumped and the deadline
   * cleared. Returns the ids of recipes that just completed a level
   * so the caller can pop UI confirmations. */
  tickRecipeUpgrades(): string[] {
    const completed: string[] = [];
    const now = Date.now();
    for (const [id, deadline] of Object.entries(this.recipeTrainingCompletesAt)) {
      if (now >= deadline) {
        const level = this.getRecipeUpgradeLevel(id);
        this.setRecipeUpgradeLevel(id, level + 1);
        delete this.recipeTrainingCompletesAt[id];
        completed.push(id);
      }
    }
    return completed;
  }

  getUnlockedRecipeIdsForCurrentTier(unlockedTier: LuxuryTier): string[] {
    return recipes.filter((recipe) => this.isRecipeUnlocked(recipe, unlockedTier)).map((recipe) => recipe.id);
  }

  /** Refresh both the unlocked-recipe list and the active menu to match the current tier. */
  syncLuxuryUnlocks(unlockedTier: LuxuryTier): void {
    this.unlockedRecipeIds = this.getUnlockedRecipeIdsForCurrentTier(unlockedTier);
    this.menuRecipeIds = this.normalizeMenuRecipeIds(this.menuRecipeIds, unlockedTier);
  }

  /** Drop recipe ids that are unknown, locked, or exceed the per-category cap. */
  normalizeMenuRecipeIds(recipeIds: string[], unlockedTier: LuxuryTier): string[] {
    const counts = new Map<RecipeDefinition["category"], number>();
    return recipeIds.filter((recipeId) => {
      const recipe = recipes.find((item) => item.id === recipeId);
      if (!recipe || !this.isRecipeUnlocked(recipe, unlockedTier)) {
        return false;
      }

      const count = counts.get(recipe.category) ?? 0;
      if (count >= maxActiveRecipesPerCategory) {
        return false;
      }

      counts.set(recipe.category, count + 1);
      return true;
    });
  }

  isOnMenu(recipeId: string): boolean {
    return this.menuRecipeIds.includes(recipeId);
  }

  /**
   * Remove a recipe from the active menu.
   *
   * Returns `"removed"` on success, `"notOnMenu"` if it wasn't active, or `"lastItem"`
   * if removal would empty the menu (the caller can surface that as a UX warning).
   */
  removeFromMenu(recipeId: string): "removed" | "notOnMenu" | "lastItem" {
    if (!this.menuRecipeIds.includes(recipeId)) {
      return "notOnMenu";
    }
    if (this.menuRecipeIds.length === 1) {
      return "lastItem";
    }
    this.menuRecipeIds = this.menuRecipeIds.filter((id) => id !== recipeId);
    this.cloud?.setActiveMenu(this.menuRecipeIds); // H.40
    return "removed";
  }

  /** Returns `false` if already on menu or if the recipe's category
   * is already at the per-category cap (maxActiveRecipesPerCategory).
   * Returns `true` after a successful add. */
  addToMenu(recipeId: string): boolean {
    if (this.menuRecipeIds.includes(recipeId)) {
      return false;
    }
    const recipe = recipes.find((r) => r.id === recipeId);
    if (recipe) {
      const cat = recipe.category;
      const inCat = this.menuRecipeIds.reduce((n, id) => {
        const r = recipes.find((rr) => rr.id === id);
        return n + (r?.category === cat ? 1 : 0);
      }, 0);
      if (inCat >= maxActiveRecipesPerCategory) return false;
    }
    this.menuRecipeIds = [...this.menuRecipeIds, recipeId];
    this.cloud?.setActiveMenu(this.menuRecipeIds); // H.40
    return true;
  }

  getActiveRecipeCountForCategory(category: RecipeDefinition["category"]): number {
    return recipes.filter((recipe) => recipe.category === category && this.menuRecipeIds.includes(recipe.id)).length;
  }

  // === Appliance gating ===
  //
  // Each recipe declares which kitchen appliances it needs to be makeable.
  // Items in the catalog declare what they provide. The cooking system
  // gates the menu UI off "do you actually own one of each required
  // appliance?" — recipes that aren't makeable can't be added to the
  // active menu.

  /** The set of appliance ids needed for the recipe. Falls back to
   * `[stationNeeded]` for recipes that haven't opted into an explicit
   * `appliances` list — keeps the 53 existing recipes working without
   * a manual touch-up pass on every one. */
  getRecipeAppliances(recipe: RecipeDefinition): readonly ApplianceId[] {
    if (recipe.appliances && recipe.appliances.length > 0) return recipe.appliances;
    return [recipe.stationNeeded as ApplianceId];
  }

  /** True iff every appliance the recipe needs is currently provided
   * by at least one placed item. `provided` is the set returned by
   * FurnitureRegistry.getProvidedAppliances(). When the callback is
   * absent (early boot, save migration), recipes are treated as
   * makeable so the legacy behaviour is preserved. */
  canMakeRecipe(recipe: RecipeDefinition, provided: ReadonlySet<string> | undefined): boolean {
    if (!provided) return true;
    const needs = this.getRecipeAppliances(recipe);
    for (const a of needs) if (!provided.has(a)) return false;
    return true;
  }

  // === Pantry & ingredient inventory ===

  getPantry(): readonly IngredientStock[] {
    return this.pantry;
  }

  /** Mutable reference for the scene's read-only display/ordering passes. Do not mutate from callers. */
  getPantryRaw(): IngredientStock[] {
    return this.pantry;
  }

  getPantrySnapshot(): IngredientStock[] {
    return this.pantry.map((item) => ({ ...item }));
  }

  getIngredientQuantity(ingredientId: string): number {
    return this.pantry.find((item) => item.id === ingredientId)?.quantity ?? 0;
  }

  getIngredientName(ingredientId: string): string {
    return this.pantry.find((item) => item.id === ingredientId)?.name ?? ingredientId;
  }

  /** Returns the recipe's ingredient ids that have zero stock right now. */
  getMissingIngredientsForRecipe(recipe: RecipeDefinition): string[] {
    return recipe.ingredients.filter((ingredient) => this.getIngredientQuantity(ingredient) <= 0);
  }

  hasIngredients(recipe: RecipeDefinition): boolean {
    return this.getMissingIngredientsForRecipe(recipe).length === 0;
  }

  /** A recipe is fulfillable if there's a prepared serving on the pass OR pantry has everything. */
  canFulfillRecipe(recipe: RecipeDefinition): boolean {
    return (this.preparedServings[recipe.id] ?? 0) > 0 || this.hasIngredients(recipe);
  }

  /** Per-ingredient running consumption count for the current day. Reset
   * by resetDailyConsumption() on day rollover. Lets the UI show that
   * ingredients ARE being used even when auto-shop snaps them back up
   * between display refreshes. */
  private consumedToday: Map<string, number> = new Map();

  /**
   * Decrement pantry by 1 for each ingredient in the recipe (skipping ingredients
   * not present in pantry). Returns the count of stocks actually decremented.
   */
  consumeIngredients(recipe: RecipeDefinition): number {
    let consumed = 0;
    recipe.ingredients.forEach((ingredient) => {
      const stock = this.pantry.find((item) => item.id === ingredient);
      if (stock) {
        stock.quantity = Math.max(0, stock.quantity - 1);
        this.consumedToday.set(ingredient, (this.consumedToday.get(ingredient) ?? 0) + 1);
        consumed += 1;
        // H.36 — mirror the decrement to the server's pantry_stock
        // table. Visit mode + co-owner views see live ingredient
        // counts instead of waiting for autosave. Bails silently
        // when cloud isn't wired (tests / pre-auth boot).
        //
        // Phase H Phase 2 — when the server owns ticket dispatch,
        // place_order ALSO consumes pantry (see place_order in
        // restaurant_sim.rs). Firing this mirror too would
        // double-decrement server pantry. Local pantry array still
        // decrements above for instant UI; server's decrement
        // happens when the cloud.placeOrder reducer call lands.
        if (!this.suppressPantryMirror && this.cloud && !isServerSim("tickets")) {
          this.cloud.bumpPantryStock(ingredient, -1);
        }
      }
    });
    return consumed;
  }

  /** How much of an ingredient has been consumed since the last day
   * rollover. UI surfaces this so a player can see activity even when
   * the auto-shop holds quantities at target. */
  getConsumedToday(id: string): number {
    return this.consumedToday.get(id) ?? 0;
  }

  /** Total ingredient units consumed today across all ingredients. */
  getTotalConsumedToday(): number {
    let n = 0;
    for (const v of this.consumedToday.values()) n += v;
    return n;
  }

  resetDailyConsumption(): void {
    this.consumedToday.clear();
  }

  /** Adds quantity to an existing pantry entry; no-op if the ingredient id is unknown. */
  addPantryStock(ingredientId: string, quantity: number): boolean {
    const stock = this.pantry.find((item) => item.id === ingredientId);
    if (!stock) {
      return false;
    }
    stock.quantity += quantity;
    // H.36 — mirror the increment. Symmetrical to consumeIngredients.
    if (!this.suppressPantryMirror && this.cloud && quantity > 0) {
      this.cloud.bumpPantryStock(ingredientId, quantity);
    }
    return true;
  }

  // === Pending errand orders ===
  // Auto-shop is now an errand-driven supply chain. When an errand helper
  // leaves to go shopping, the list of items they're fetching is added
  // here so subsequent auto-shop ticks know NOT to double-order them.
  // When the helper returns home, deliverErrandOrder unwinds the entry
  // and adds the units to the pantry.

  private pendingErrandOrders: Map<string, number> = new Map();

  /** Pending units for one ingredient (0 if none). */
  getPendingForIngredient(id: string): number {
    return this.pendingErrandOrders.get(id) ?? 0;
  }

  /** Snapshot of all pending orders for UI/debug. */
  getPendingOrdersSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, n] of this.pendingErrandOrders) out[id] = n;
    return out;
  }

  /** Reserve N units of an ingredient as "an errand helper is bringing them". */
  addPendingErrandOrder(id: string, units: number): void {
    if (units <= 0) return;
    this.pendingErrandOrders.set(id, (this.pendingErrandOrders.get(id) ?? 0) + units);
  }

  /** An errand helper returned home — deliver these units to the pantry
   * and clear them from the pending map. */
  deliverErrandOrder(list: Map<string, number>): void {
    for (const [id, units] of list) {
      this.addPantryStock(id, units);
      const cur = this.pendingErrandOrders.get(id) ?? 0;
      const next = Math.max(0, cur - units);
      if (next === 0) this.pendingErrandOrders.delete(id);
      else this.pendingErrandOrders.set(id, next);
    }
  }

  /** Wipe the pending-orders bookkeeping. Used only as a recovery
   * mechanism — the auto-shop dispatcher used to silently leak the
   * pending counter when the errand router queue overflowed, and a
   * saved game from that era can come back showing 30+ units "in
   * transit" with no helper carrying them. Engine calls this on
   * startup when pending exceeds the helper count's plausible max. */
  clearAllPendingOrders(): void {
    this.pendingErrandOrders.clear();
  }

  // === Prepared servings (cooked dishes waiting on the pass) ===

  getPreparedServings(): Readonly<Record<string, number>> {
    return this.preparedServings;
  }

  getPreparedServingsSnapshot(): Record<string, number> {
    return { ...this.preparedServings };
  }

  getPreparedServingCount(recipeId: string): number {
    return this.preparedServings[recipeId] ?? 0;
  }

  getTotalPreparedServings(): number {
    return Object.values(this.preparedServings).reduce((sum, count) => sum + count, 0);
  }

  /** Path B — mirror one recipe's current prepared-serving count to
   * the cloud's prepared_serving table so cook-ahead dishes survive a
   * reload (they were save-only before: ingredients spent, dishes
   * gone). Reads the post-mutation count so callers just mutate then
   * call this. Bails silently when cloud isn't wired (tests /
   * pre-auth boot); the server upserts and deletes the row at 0. */
  private mirrorPreparedServing(recipeId: string): void {
    if (!this.cloud) return;
    this.cloud.setPreparedServing(recipeId, this.preparedServings[recipeId] ?? 0);
  }

  storePreparedServing(recipeId: string): void {
    this.preparedServings[recipeId] = (this.preparedServings[recipeId] ?? 0) + 1;
    this.mirrorPreparedServing(recipeId);
  }

  /** Removes a single prepared serving. Returns true if one was actually decremented. */
  consumePreparedServing(recipeId: string): boolean {
    const current = this.preparedServings[recipeId] ?? 0;
    if (current <= 0) {
      return false;
    }
    const next = current - 1;
    if (next <= 0) {
      delete this.preparedServings[recipeId];
    } else {
      this.preparedServings[recipeId] = next;
    }
    this.mirrorPreparedServing(recipeId);
    return true;
  }

  /** Drop zero-or-negative prepared-serving entries; used by the save-repair tool. */
  prunePreparedServings(): void {
    const dropped = Object.entries(this.preparedServings)
      .filter(([, quantity]) => quantity <= 0)
      .map(([recipeId]) => recipeId);
    this.preparedServings = Object.fromEntries(
      Object.entries(this.preparedServings).filter(([, quantity]) => quantity > 0),
    );
    // Path B — mirror the repairs so the cloud drops the same rows.
    for (const recipeId of dropped) this.mirrorPreparedServing(recipeId);
  }

  // === Errand orders (groceries the player has queued but not yet sent) ===

  getErrandOrder(): Readonly<Record<string, number>> {
    return this.errandOrder;
  }

  getErrandOrderEntries(): Array<[string, number]> {
    return Object.entries(this.errandOrder);
  }

  getTotalErrandOrderQuantity(): number {
    return Object.values(this.errandOrder).reduce((sum, quantity) => sum + quantity, 0);
  }

  queueErrand(ingredientId: string, quantity: number): void {
    this.errandOrder[ingredientId] = (this.errandOrder[ingredientId] ?? 0) + quantity;
  }

  clearErrandOrder(): void {
    this.errandOrder = {};
  }

  // === Errand in-transit (groceries being delivered by an errand boy) ===

  getErrandInTransit(): Readonly<Record<string, number>> {
    return this.errandInTransit;
  }

  getErrandInTransitQuantity(ingredientId: string): number {
    return this.errandInTransit[ingredientId] ?? 0;
  }

  getTotalErrandInTransit(): number {
    return Object.values(this.errandInTransit).reduce((sum, quantity) => sum + quantity, 0);
  }

  recordErrandInTransit(ingredientId: string, quantity: number): void {
    this.errandInTransit[ingredientId] = (this.errandInTransit[ingredientId] ?? 0) + quantity;
  }

  /** Subtract from in-transit (e.g. on delivery or cancellation). Floors at 0. */
  removeErrandInTransit(ingredientId: string, quantity: number): void {
    this.errandInTransit[ingredientId] = Math.max(0, (this.errandInTransit[ingredientId] ?? 0) - quantity);
  }

  /** Drop zero-or-negative in-transit entries; used by the save-repair tool. */
  pruneErrandInTransit(): void {
    this.errandInTransit = Object.fromEntries(
      Object.entries(this.errandInTransit).filter(([, quantity]) => quantity > 0),
    );
  }

  // === Save/load ===

  /** Apply persisted state on load, then re-sync to the current expansion tier. */
  hydrate(save: SaveGameState | null | undefined, unlockedTier: LuxuryTier): void {
    this.recipeUpgradeLevels = hydrateRecipeUpgradeLevels(save?.recipeUpgradeLevels);
    this.recipeTrainingCompletesAt = {};
    if (save?.recipeTrainingCompletesAt) {
      for (const [id, ts] of Object.entries(save.recipeTrainingCompletesAt)) {
        if (typeof ts === "number" && Number.isFinite(ts)) {
          this.recipeTrainingCompletesAt[id] = ts;
        }
      }
    }
    this.unlockedRecipeIds = this.getUnlockedRecipeIdsForCurrentTier(unlockedTier);
    const menu = save?.menuRecipeIds ?? this.menuRecipeIds;
    this.menuRecipeIds = this.normalizeMenuRecipeIds(menu, unlockedTier);
    this.pantry = hydratePantry(save?.ingredients);
    this.preparedServings = { ...(save?.preparedServings ?? {}) };
    this.errandOrder = {};
    this.errandInTransit = {};
  }

  /** Phase I.1 (H.48d) — Override local pantry counts with cloud
   * pantry_stock values.  Called by Engine on subscription ready,
   * AFTER load() seeds from the save.  Cloud has the true state
   * (server may have consumed via H.37 + restocked via H.41 during
   * offline play); local save is a snapshot from autosave time.
   *
   * Idempotent — if cloud and local agree (typical foreground
   * mid-session), it's a no-op write.  Skips when not connected. */
  restorePantryFromCloud(): void {
    if (!this.cloud) return;
    const rows = this.cloud.listPantryStock();
    if (rows.length === 0) return;
    for (const row of rows) {
      const stock = this.pantry.find((s) => s.id === row.ingredientId);
      if (stock) {
        stock.quantity = row.quantity;
      } else {
        // Cloud has an ingredient the local pantry didn't initialize
        // (e.g. a restock added stock for a new ingredient) — append it.
        const name = row.ingredientId.charAt(0).toUpperCase() + row.ingredientId.slice(1);
        this.pantry.push({ id: row.ingredientId, name, quantity: row.quantity });
      }
    }
  }

  /** Kept for backwards compat with any external callers — equivalent to filtering by getUnlockedRecipeIds(). */
  getAvailableRecipes(unlockedRecipeIds: string[]): typeof recipes {
    return recipes.filter((recipe) => unlockedRecipeIds.includes(recipe.id));
  }
}

/** Pure data: luxury tier of a recipe (explicit field or auto-ranked from price/satisfaction). */
export function getRecipeLuxuryTier(recipe: RecipeDefinition): LuxuryTier {
  if (recipe.luxuryTier) {
    return recipe.luxuryTier;
  }

  if (recipe.sellPrice >= 88 || recipe.satisfactionEffect >= 20) {
    return 5;
  }
  if (recipe.sellPrice >= 62 || recipe.satisfactionEffect >= 15) {
    return 4;
  }
  if (recipe.sellPrice >= 44 || recipe.satisfactionEffect >= 11) {
    return 3;
  }
  if (recipe.sellPrice >= 28 || recipe.satisfactionEffect >= 7) {
    return 2;
  }
  return 1;
}

/** Pure data: normalise a persisted recipe-upgrade-level map to the full recipe set and clamp values. */
export function hydrateRecipeUpgradeLevels(levels?: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    recipes.map((recipe) => [
      recipe.id,
      clamp(Math.floor(levels?.[recipe.id] ?? 1), 1, maxRecipeUpgradeLevel),
    ]),
  );
}

/** Pure data: the new-game starter pantry. Quantities are tuned so a fresh restaurant can immediately serve tier-1 dishes. */
export function getStarterPantry(): IngredientStock[] {
  return [
    { id: "bread", name: "Bread", quantity: 8 },
    { id: "butter", name: "Butter", quantity: 8 },
    { id: "stock", name: "Stock", quantity: 6 },
    { id: "vegetables", name: "Vegetables", quantity: 6 },
    { id: "herbs", name: "Herbs", quantity: 6 },
    { id: "pasta", name: "Pasta", quantity: 3 },
    { id: "tomato", name: "Tomato", quantity: 3 },
    { id: "cheese", name: "Cheese", quantity: 3 },
    { id: "lettuce", name: "Lettuce", quantity: 4 },
    { id: "oil", name: "Oil", quantity: 4 },
    { id: "flour", name: "Flour", quantity: 4 },
    { id: "sugar", name: "Sugar", quantity: 4 },
    { id: "chicken", name: "Chicken", quantity: 3 },
    { id: "rice", name: "Rice", quantity: 4 },
    { id: "spices", name: "Spices", quantity: 4 },
    { id: "beef", name: "Beef", quantity: 2 },
    { id: "potato", name: "Potato", quantity: 4 },
    { id: "fish", name: "Fish", quantity: 2 },
    { id: "mushroom", name: "Mushroom", quantity: 3 },
    { id: "egg", name: "Egg", quantity: 4 },
    { id: "berries", name: "Berries", quantity: 3 },
    { id: "cocoa", name: "Cocoa", quantity: 2 },
    { id: "milk", name: "Milk", quantity: 4 },
    { id: "cream", name: "Cream", quantity: 2 },
    { id: "apple", name: "Apple", quantity: 3 },
    { id: "lemon", name: "Lemon", quantity: 3 },
    { id: "tea", name: "Tea", quantity: 3 },
    { id: "coffee", name: "Coffee", quantity: 3 },
    { id: "orange", name: "Orange", quantity: 3 },
    { id: "salt", name: "Salt", quantity: 5 },
    { id: "lentils", name: "Lentils", quantity: 4 },
    { id: "yogurt", name: "Yogurt", quantity: 3 },
    { id: "honey", name: "Honey", quantity: 3 },
    { id: "mint", name: "Mint", quantity: 3 },
    { id: "turkey", name: "Turkey", quantity: 0 },
    { id: "pumpkin", name: "Pumpkin", quantity: 0 },
    { id: "carrot", name: "Carrot", quantity: 0 },
    { id: "sweet-potato", name: "Sweet Potato", quantity: 0 },
    { id: "salmon", name: "Salmon", quantity: 0 },
    { id: "pear", name: "Pear", quantity: 0 },
    { id: "matcha", name: "Matcha", quantity: 0 },
    { id: "goat-cheese", name: "Goat Cheese", quantity: 0 },
    { id: "shrimp", name: "Shrimp", quantity: 0 },
    { id: "duck", name: "Duck", quantity: 0 },
    { id: "corn", name: "Corn", quantity: 0 },
    { id: "pistachio", name: "Pistachio", quantity: 0 },
    { id: "rose", name: "Rose", quantity: 0 },
    { id: "asparagus", name: "Asparagus", quantity: 0 },
    { id: "truffle", name: "Truffle", quantity: 0 },
    { id: "filet", name: "Filet", quantity: 0 },
    { id: "vanilla", name: "Vanilla", quantity: 0 },
    { id: "saffron", name: "Saffron", quantity: 0 },
    { id: "caviar", name: "Caviar", quantity: 0 },
  ];
}

/** Merge saved pantry quantities on top of the starter pantry. New ingredients added in updates appear at their starter quantity. */
export function hydratePantry(savedIngredients?: IngredientStock[]): IngredientStock[] {
  const savedById = new Map((savedIngredients ?? []).map((ingredient) => [ingredient.id, ingredient]));
  return getStarterPantry().map((defaultIngredient) => ({
    ...defaultIngredient,
    quantity: savedById.get(defaultIngredient.id)?.quantity ?? defaultIngredient.quantity,
  }));
}
