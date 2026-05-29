import {
  BASE_DISH_CAPACITY,
  STARTER_GLASS_COUNT,
  STARTER_PLATE_COUNT,
  dishSatisfactionForTier,
  type DishKind,
  type DishwareSetDef,
} from "../data/dishwareCatalog";

/**
 * Owns the restaurant's plate + glass inventory.
 *
 * The data model is two per-tier pools, one for plates and one for
 * glasses. Each tier holds a CLEAN and a DIRTY count. A serve reserves
 * the highest-tier clean plate available; when the customer leaves it
 * becomes dirty in the same tier; the waiter wash loop converts it back
 * to clean.
 *
 * Capacity = base 48 + FurnitureDef.dishCapacity summed across every
 * placed non-fridge storage / cabinet. The total cap covers plates +
 * glasses combined (they share shelf space). buy() is rejected if the
 * purchase would exceed the cap.
 *
 * The "active rating tier" the player sees for plates / glasses is the
 * highest tier they currently own ANY clean stock of — that's also the
 * tier reservePlate() / reserveGlass() pick first, so newer / shinier
 * dishware shows up on tables as soon as the player buys it.
 */
export class DishwareSystem {
  /** plates[tier] = { clean, dirty }. Sparse — tiers with zero owned
   * are simply absent. */
  private plates: Map<number, { clean: number; dirty: number }> = new Map();
  private glasses: Map<number, { clean: number; dirty: number }> = new Map();

  // washClock removed — Phase 3 replaced the abstract timer-driven
  // wash with explicit waiter trips. Kept the field name in comments
  // for save-file archaeology.

  /** Engine-provided callback that sums FurnitureDef.dishCapacity
   * across every placed non-fridge storage / counter. When absent
   * (early boot, tests) the system falls back to BASE_DISH_CAPACITY
   * only. */
  getStorageBonus?: () => number;

  /** Engine-provided callback returning how many sinks / dishwashers
   * are placed. Dishwashers wash twice as fast as sinks; if no wash
   * station is placed the loop pauses (dirty plates pile up). */
  countWashStations?: () => { sinks: number; dishwashers: number; dishwasherPro: number };

  /** Engine-provided callback fired AFTER a successful wash. GuestSpawner
   * wires this so the matching dirty-plate mesh disappears from the
   * world the same tick the inventory counter ticks up. */
  onDishWashed?: (kind: DishKind, tier: number) => void;

  constructor() {
    this.plates.set(1, { clean: STARTER_PLATE_COUNT, dirty: 0 });
    this.glasses.set(1, { clean: STARTER_GLASS_COUNT, dirty: 0 });
  }

  // === Counts ===

  /** Total clean count across all tiers for the given kind. */
  getClean(kind: DishKind): number {
    return sumPool(this.poolFor(kind), "clean");
  }

  /** Total dirty count across all tiers. */
  getDirty(kind: DishKind): number {
    return sumPool(this.poolFor(kind), "dirty");
  }

  /** Total owned (clean + dirty) of all tiers. */
  getOwned(kind: DishKind): number {
    return this.getClean(kind) + this.getDirty(kind);
  }

  /** Total owned plates AND glasses combined — shares the storage cap. */
  getTotalOwned(): number {
    return this.getOwned("plate") + this.getOwned("glass");
  }

  /** Storage cap = base + sum of dishCapacity across placed cabinets. */
  getCapacity(): number {
    const bonus = this.getStorageBonus?.() ?? 0;
    return BASE_DISH_CAPACITY + Math.max(0, bonus);
  }

  /** How much more dishware the player can buy before hitting the cap. */
  getFreeCapacity(): number {
    return Math.max(0, this.getCapacity() - this.getTotalOwned());
  }

  /** Per-tier snapshot for the UI: returns clean + dirty + total for
   * every tier with non-zero stock. Sorted from highest tier down so
   * the prestige tiers list first. */
  getTierBreakdown(kind: DishKind): Array<{ tier: number; clean: number; dirty: number }> {
    const out: Array<{ tier: number; clean: number; dirty: number }> = [];
    for (const [tier, entry] of this.poolFor(kind)) {
      if (entry.clean + entry.dirty <= 0) continue;
      out.push({ tier, clean: entry.clean, dirty: entry.dirty });
    }
    out.sort((a, b) => b.tier - a.tier);
    return out;
  }

  /** Highest tier with at least one clean piece, or null if everything
   * is dirty. Used to derive the "active rating tier" surfaced in UI
   * and for picking which plate to serve next. */
  getActiveTier(kind: DishKind): number | null {
    let best: number | null = null;
    for (const [tier, entry] of this.poolFor(kind)) {
      if (entry.clean <= 0) continue;
      if (best === null || tier > best) best = tier;
    }
    return best;
  }

  // === Mutations ===

  /** Try to reserve one clean piece — picks the highest tier first so
   * the player's nicest plates lead. Returns the tier that was reserved
   * or null when nothing is clean. The serve loop calls this before
   * sending a ticket; if null, the order can't go through. */
  reserveOne(kind: DishKind): number | null {
    const tier = this.getActiveTier(kind);
    if (tier === null) return null;
    const pool = this.poolFor(kind);
    const entry = pool.get(tier)!;
    entry.clean -= 1;
    if (entry.clean === 0 && entry.dirty === 0) pool.delete(tier);
    return tier;
  }

  /** Move one piece of the given tier into the dirty pool. Called when
   * a guest finishes their course. */
  markDirty(kind: DishKind, tier: number): void {
    const pool = this.poolFor(kind);
    const entry = pool.get(tier) ?? { clean: 0, dirty: 0 };
    entry.dirty += 1;
    pool.set(tier, entry);
  }

  /** Wash one dirty piece (any tier — picks the highest-tier dirty so
   * VIP plates come back online first). Returns the tier that was
   * washed, or null when there's nothing dirty. */
  washOne(kind: DishKind): number | null {
    const pool = this.poolFor(kind);
    let best: number | null = null;
    for (const [tier, entry] of pool) {
      if (entry.dirty <= 0) continue;
      if (best === null || tier > best) best = tier;
    }
    if (best === null) return null;
    const entry = pool.get(best)!;
    entry.dirty -= 1;
    entry.clean += 1;
    this.onDishWashed?.(kind, best);
    return best;
  }

  /** Add `count` clean pieces of a given tier to the pool. Caps at the
   * current storage capacity — returns the count actually added so
   * callers can refund the unused portion or show a "no room" warning. */
  addClean(kind: DishKind, tier: number, count: number): number {
    if (count <= 0) return 0;
    const free = this.getFreeCapacity();
    if (free <= 0) return 0;
    const take = Math.min(count, free);
    const pool = this.poolFor(kind);
    const entry = pool.get(tier) ?? { clean: 0, dirty: 0 };
    entry.clean += take;
    pool.set(tier, entry);
    return take;
  }

  /** Buy ONE set of the given catalog entry. Returns the number of
   * pieces actually added (0 when capacity blocks, setSize on success).
   * Caller is responsible for charging the cost. */
  buySet(set: DishwareSetDef): number {
    return this.addClean(set.kind, set.tier, set.setSize);
  }

  // === Wash loop (v1 — timer-driven, replaced by waiter trips later) ===

  /** Wash interval in seconds. Each placed sink shaves 0.6s, each
   * dishwasher 1.5s, each pro dishwasher 2.5s. Floors at 0.5s so
   * even a max-buff kitchen still has visible wash latency. With
   * zero wash stations the interval is Infinity — dirty piles up. */
  getWashInterval(): number {
    const stats = this.countWashStations?.() ?? { sinks: 0, dishwashers: 0, dishwasherPro: 0 };
    const total = stats.sinks + stats.dishwashers + stats.dishwasherPro;
    if (total === 0) return Infinity;
    const base = 4.0;
    const speedup = stats.sinks * 0.6 + stats.dishwashers * 1.5 + stats.dishwasherPro * 2.5;
    return Math.max(0.5, base - speedup);
  }

  /** Tick — kept around for save-migration parity (early phases ran an
   * abstract wash timer here). Real washing is now driven by waiter
   * trips in StaffRouter, which call washOne() directly. The
   * `washClock` field is retained for the rare path that re-enables
   * the fallback timer (no waiters hired, dishes still piling up). */
  update(_dt: number): void {
    // Intentional no-op. Wash work happens when a waiter completes a
    // trip; see StaffRouter's wash state machine for the live cadence.
    void _dt;
  }

  // === Save / load ===

  /** Compact serialisation for the save file: per-kind list of
   * { tier, clean, dirty } entries. Empty pools omit themselves so a
   * freshly-saved game stays small. */
  snapshot(): { plates: Array<[number, number, number]>; glasses: Array<[number, number, number]> } {
    return {
      plates: poolToTriples(this.plates),
      glasses: poolToTriples(this.glasses),
    };
  }

  /** Re-hydrate from a saved snapshot. Unknown / corrupted entries are
   * silently dropped (we still want the player to be able to load).
   *
   * Dirty pieces in the save are auto-washed on load: we move them
   * back to the clean pool. The mesh positions aren't persisted, so
   * leaving the dirty count high would mean those plates are "stuck"
   * in inventory — no mesh on the table for the waiter to claim, so
   * the wash loop can never drain them. Mental model: while you were
   * away, someone cleaned up. */
  hydrate(save: { plates?: Array<[number, number, number]>; glasses?: Array<[number, number, number]> } | null | undefined): void {
    this.plates = new Map();
    this.glasses = new Map();
    if (save?.plates) triplesToPool(save.plates, this.plates);
    if (save?.glasses) triplesToPool(save.glasses, this.glasses);
    if (this.plates.size === 0) this.plates.set(1, { clean: STARTER_PLATE_COUNT, dirty: 0 });
    if (this.glasses.size === 0) this.glasses.set(1, { clean: STARTER_GLASS_COUNT, dirty: 0 });
    autoWashPool(this.plates);
    autoWashPool(this.glasses);
  }

  // === Rating bonus ===

  /** Satisfaction bonus contributed by serving one plate / glass of
   * the given tier. Used by GuestSpawner.finalizeVisit to bump the
   * customer's average per-course satisfaction in line with the tier
   * of dishware actually served. */
  satisfactionFor(kind: DishKind, tier: number): number {
    return dishSatisfactionForTier(kind, tier);
  }

  private poolFor(kind: DishKind): Map<number, { clean: number; dirty: number }> {
    return kind === "plate" ? this.plates : this.glasses;
  }
}

function sumPool(pool: Map<number, { clean: number; dirty: number }>, key: "clean" | "dirty"): number {
  let n = 0;
  for (const entry of pool.values()) n += entry[key];
  return n;
}

function poolToTriples(pool: Map<number, { clean: number; dirty: number }>): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const [tier, entry] of pool) {
    if (entry.clean === 0 && entry.dirty === 0) continue;
    out.push([tier, entry.clean, entry.dirty]);
  }
  return out;
}

/** Move every dirty piece in the pool back to clean. Called from
 * hydrate so save / load doesn't strand inventory in a state where
 * dirty pieces exist but no mesh on a table backs them — the wash
 * loop would never find one to claim. */
function autoWashPool(pool: Map<number, { clean: number; dirty: number }>): void {
  for (const entry of pool.values()) {
    if (entry.dirty > 0) {
      entry.clean += entry.dirty;
      entry.dirty = 0;
    }
  }
}

function triplesToPool(triples: Array<[number, number, number]>, into: Map<number, { clean: number; dirty: number }>): void {
  for (const [tier, clean, dirty] of triples) {
    if (typeof tier !== "number" || tier < 1 || tier > 5) continue;
    const c = Math.max(0, Math.floor(typeof clean === "number" ? clean : 0));
    const d = Math.max(0, Math.floor(typeof dirty === "number" ? dirty : 0));
    if (c + d <= 0) continue;
    into.set(tier, { clean: c, dirty: d });
  }
}

/** Save format slice — exported so SaveSystem can declare the field. */
export interface DishwareSaveSlice {
  plates: Array<[number, number, number]>;
  glasses: Array<[number, number, number]>;
}
