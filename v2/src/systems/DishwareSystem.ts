import {
  BASE_DISH_CAPACITY,
  STARTER_GLASS_COUNT,
  STARTER_PLATE_COUNT,
  dishSatisfactionForTier,
  type DishKind,
  type DishwareSetDef,
} from "../data/dishwareCatalog";
import { isServerSim } from "../game/featureFlags";

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
/** Per-dishwasher background batch state. Plates / glasses get loaded
 * by the waiter on a "drop and walk away" trip (short dwell); the
 * cycle clock counts down independently and flushes everything in the
 * batch to the clean pool when it hits zero.
 *
 * Each loaded piece bumps the clock by washPerItem seconds (1.5 for a
 * regular dishwasher, 1.0 for the pro). Running totals are kept by
 * kind because the clean-pool calls split by plate / glass. */
interface DishwasherBatch {
  defId: string;
  plates: number;
  glasses: number;
  cycleTimeRemaining: number;
}

/** Per-kind capacity inside one dishwasher. Same for regular and pro
 * — the pro's edge is shorter cycle time, not a bigger drum. */
const DISHWASHER_CAPACITY = { plate: 10, glass: 5 } as const;

/** Seconds the dishwasher cycle adds per loaded piece — the user
 * called for "half the sink" (sink dwell = 3.0s). Pro shaves another
 * third off. */
function dishwasherWashPerItem(defId: string): number {
  return defId === "dishwasher-pro" ? 1.0 : 1.5;
}

export class DishwareSystem {
  /** plates[tier] = { clean, dirty }. Sparse — tiers with zero owned
   * are simply absent. */
  private plates: Map<number, { clean: number; dirty: number }> = new Map();
  private glasses: Map<number, { clean: number; dirty: number }> = new Map();

  /** uid → batch state. Auto-created on first load. */
  private dishwasherBatches: Map<string, DishwasherBatch> = new Map();

  /** Total pieces ever ADDED to the inventory — bumped by buy / starter
   * stock. Tracked PER KIND so a save can persist the "high-water" total
   * for plates and glasses independently. On hydrate the system tops
   * up the clean pool to match these totals — any pieces that leaked
   * during the previous session come back as clean plates / glasses,
   * preventing the slow inventory shrink the player kept seeing.
   *
   * SOURCE OF TRUTH: these are computed from STARTER + sum(purchaseLog).
   * The mutable fields shadow the running total so we don't recompute
   * on every read. They're INCREMENTED only by buySet (real purchases)
   * and RESET only by resetToStarter / hydrate-with-log. Hydrate never
   * does a Math.max re-baseline — that was the duping bug. */
  private lifetimeAddedPlate = 0;
  private lifetimeAddedGlass = 0;
  /** Append-only log of every dishware purchase the player has made
   * this lifetime — the source of truth for the lifetime totals.
   * Persisted in the save so the player can always reconcile back to
   * "starter stock plus the dishware they bought" if the in-game
   * counters ever drift. Each entry is one buySet call. */
  private purchaseLog: Array<{ kind: DishKind; tier: number; count: number; at: number }> = [];

  /** Optional dev-mode logger — every mutation calls this with a
   * one-line description before returning. Wired by Engine to the
   * DishwareLeakWatcher's ring buffer so the action history is captured
   * even when leaks happen during background ticks the player never
   * notices. Off by default; instrumentation overhead is one closure
   * call per mutation when on. */
  private logger?: (msg: string) => void;

  /** Phase E — Engine wires this so every pool / batch mutation
   * mirrors to the cloud's dishware_pool + dishwasher_batch tables
   * when isServerSim("dishware") is on. Null in tests / pre-cloud
   * boot. mirrorPool / mirrorBatch helpers below bail silently. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;

  /** Wire (or unwire) the per-mutation logger. Pass undefined to mute. */
  setLogger(fn: ((msg: string) => void) | undefined): void {
    this.logger = fn;
  }

  // === Phase E — cloud mirror helpers ===

  /** Read the current (kind, tier) entry and push it to the cloud's
   * dishware_pool table. Called from every mutation site. Bails when
   * the flag is off OR the cloud isn't wired. Server upserts on
   * non-zero clean/dirty and deletes the row when both reach zero so
   * the pool table doesn't accumulate empties. */
  private mirrorPool(kind: DishKind, tier: number): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("dishware") || !this.cloud) return;
    const pool = this.poolFor(kind);
    const entry = pool.get(tier) ?? { clean: 0, dirty: 0 };
    this.cloud.updateDishwarePool(kind, tier, entry.clean, entry.dirty);
  }

  /** H.31 — Delta-based mirror for a single mutation. The four
   * mutators (reserveOne, markDirty, washOne, addClean) call this
   * instead of mirrorPool so the server's H.21 wash loader can also
   * contribute to the same row without absolute-write clobbering.
   * Bulk-sync paths still use mirrorPool / mirrorAllPools. */
  private mirrorBump(kind: DishKind, tier: number, cleanDelta: number, dirtyDelta: number): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("dishware") || !this.cloud) return;
    this.cloud.bumpDishwarePool(kind, tier, cleanDelta, dirtyDelta);
  }

  /** Sweep every (kind, tier) pool entry to the cloud. Used after
   * bulk operations (hydrate from save, adminWashAll) where we'd
   * otherwise have to fire mirrorPool inside the inner loops. */
  private mirrorAllPools(): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("dishware") || !this.cloud) return;
    for (const [tier] of this.plates) this.mirrorPool("plate", tier);
    for (const [tier] of this.glasses) this.mirrorPool("glass", tier);
  }

  /** Push the current state of one dishwasher's batch to the cloud.
   * Same delete-on-zero semantics — empty cycles drop the row. */
  private mirrorBatch(uid: string): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("dishware") || !this.cloud) return;
    const batch = this.dishwasherBatches.get(uid);
    if (!batch) {
      // Local batch was cleared (cycle finished) — push an empty
      // update so the server deletes its row too.
      this.cloud.updateDishwasherBatch(uid, "", 0, 0, BigInt(0));
      return;
    }
    this.cloud.updateDishwasherBatch(
      uid,
      batch.defId,
      batch.plates,
      batch.glasses,
      BigInt(Math.round(batch.cycleTimeRemaining * 1000)),
    );
  }

  /** Latch set during restoreFromCloud / applyCloud* so the per-mutation
   * mirror doesn't bounce the cloud-driven update straight back to the
   * server. Same idea as FurnitureRegistry.suppressMirrorForReload. */
  private suppressMirrorForReload = false;

  /** Phase E read-side flip — adopt the cloud's pool + dishwasher
   * batch rows as the truth when a second device logs in. Wipes local
   * pools (set on cold boot to STARTER counts via hydrate) and replaces
   * them with whatever the cloud holds. Idempotent. */
  restoreFromCloud(): void {
    if (!isServerSim("dishware") || !this.cloud) return;
    const pools = this.cloud.listDishwarePools();
    const batches = this.cloud.listDishwasherBatches();
    if (pools.length === 0 && batches.length === 0) {
      this.log("restoreFromCloud → no cloud rows, keeping local hydrate state");
      return;
    }
    // Safety guard for Phase H default-on. Only restore from cloud
    // when local has the STARTER hydrate values — anything beyond
    // that means the user's localStorage already has gameplay state
    // and we shouldn't clobber it.
    //
    // The "is local just starters?" check: STARTER_PLATE_COUNT clean
    // plates at tier 1 + STARTER_GLASS_COUNT clean glasses at tier 1,
    // nothing else owned. Anything beyond that — extra tiers, dirty
    // pieces, lifetime > starter total — means the user has played
    // and localStorage is the authoritative state.
    const starterTotal = STARTER_PLATE_COUNT + STARTER_GLASS_COUNT;
    const localTotal = this.getOwned("plate") + this.getOwned("glass");
    const onlyStarter = localTotal <= starterTotal
        && this.getDirty("plate") === 0 && this.getDirty("glass") === 0
        && this.plates.size <= 1 && this.glasses.size <= 1;
    if (!onlyStarter) {
      this.log(`restoreFromCloud: local has gameplay state (${localTotal} pieces, ${this.getDirty("plate")} dirty plates) — keeping local. Mirroring local up to cloud.`);
      this.mirrorAllPools();
      return;
    }
    this.suppressMirrorForReload = true;
    try {
      this.plates.clear();
      this.glasses.clear();
      for (const p of pools) {
        const target = p.kind === "plate" ? this.plates : this.glasses;
        target.set(p.tier, { clean: p.clean, dirty: p.dirty });
      }
      // Phase I (H.76) — DO NOT re-baseline lifetime from the loaded
      // pool here.  The old line `lifetimeAddedPlate = getOwned("plate")`
      // was one of two sources of the "534 plates and climbing" bug:
      // whenever cloud or pool had a transient bloated value (from
      // subscription replay, in-flight double-count, etc.), this
      // would lock the bloated count in as the new canonical
      // lifetime, which then propagated forward via save.
      //
      // Lifetime is now ALWAYS derived from STARTER + sum(purchaseLog)
      // via computeLifetimeFromLog().  hydrate() recomputes it on
      // every load.  Cloud restoreFromCloud only updates the pool
      // distribution (clean / dirty / tier breakdown) — never the
      // canonical owned count.
      this.dishwasherBatches.clear();
      for (const b of batches) {
        this.dishwasherBatches.set(b.furnitureUid, {
          defId: b.defId,
          plates: b.plates,
          glasses: b.glasses,
          cycleTimeRemaining: Number(b.cycleTimeRemainingMs) / 1000,
        });
      }
    } finally {
      this.suppressMirrorForReload = false;
    }
    this.log(`restoreFromCloud → ${pools.length} pool entries, ${batches.length} batches`);
  }

  /** Subscribe to live dishware row changes. Wired by Engine after
   * restoreFromCloud completes. Subsequent cloud-side updates (another
   * device's wash, a tick that flushed the batch) apply immediately so
   * the player sees the count change without a refresh. */
  subscribeToCloudChanges(): void {
    if (!isServerSim("dishware") || !this.cloud) return;
    this.cloud.subscribeDishwarePoolChanges({
      onInsert: (row) => this.applyPoolRow(row),
      onUpdate: (row) => this.applyPoolRow(row),
      onDelete: (kind, tier) => this.applyPoolDelete(kind, tier),
    });
    this.cloud.subscribeDishwasherBatchChanges({
      onInsert: (row) => this.applyBatchRow(row),
      onUpdate: (row) => this.applyBatchRow(row),
      onDelete: (uid) => this.applyBatchDelete(uid),
    });
  }

  /** Apply one (kind, tier) pool update from the cloud. Skips when the
   * local value already matches — own-write echo, no work to do. */
  private applyPoolRow(row: import("../cloud/SpacetimeClient").DishwarePoolRow): void {
    const pool = this.poolFor(row.kind);
    const cur = pool.get(row.tier);
    if (cur && cur.clean === row.clean && cur.dirty === row.dirty) return;

    // Phase I (H.78) — SELF-HEALING CAP.  If accepting this cloud row
    // would push the total owned past the canonical lifetime, REJECT
    // it and push our local truth back to cloud instead.
    //
    // Why this matters: previous sessions persisted bloated values to
    // cloud's dishware_pool (the 534-plate ratchet).  H.76 makes
    // local hydrate to a clean canonical count, but the cloud
    // subscription's INITIAL sync replays those stale rows back at
    // the client — overwriting the freshly-trimmed local back to
    // bloated.  Combined with mirrorBump elsewhere, the user sees
    // "fixed at 40 → jumped to 500 instantly" right after first
    // delivery of the subscription cache.
    //
    // Now: applyPoolRow simulates the row, checks if owned would
    // exceed lifetime, and if so leaves local alone + pushes our
    // canonical truth back to cloud (one bumpDishwarePool per
    // mismatch).  The cloud's row self-heals to canonical, and
    // subsequent subscription deltas match.
    const lifetime = row.kind === "plate" ? this.lifetimeAddedPlate : this.lifetimeAddedGlass;
    // Simulate accepting the row + sum the other tiers' owned.
    let otherTiersOwned = 0;
    for (const [tier, e] of pool) {
      if (tier !== row.tier) otherTiersOwned += e.clean + e.dirty;
    }
    const proposedOwned = otherTiersOwned + row.clean + row.dirty;
    if (proposedOwned > lifetime) {
      console.warn(
        `[Dishware] H.78 rejected cloud row that would push owned past lifetime: ` +
        `kind=${row.kind} tier=${row.tier} cloudClean=${row.clean} cloudDirty=${row.dirty} ` +
        `→ proposed owned=${proposedOwned}, lifetime=${lifetime}.  Pushing local truth back.`,
      );
      // Force local back to canonical (in case some prior code
      // already mutated it) and push every tier of this kind UP to
      // cloud so the bloated row gets overwritten.
      this.reconcilePoolToLifetime(row.kind);
      if (this.cloud && isServerSim("dishware")) {
        for (const [tier, e] of pool) {
          this.cloud.updateDishwarePool(row.kind, tier, e.clean, e.dirty);
        }
      }
      return;
    }

    this.suppressMirrorForReload = true;
    try {
      pool.set(row.tier, { clean: row.clean, dirty: row.dirty });
      // Phase I (H.76) — REMOVED the lifetime self-heal bump.  Lifetime
      // is strictly derived from STARTER + sum(purchaseLog) — never
      // from the pool's owned count.
    } finally {
      this.suppressMirrorForReload = false;
    }
  }

  /** Apply a dishware_pool delete (server compacted a zero-count row).
   * Local pool follows by clearing the (kind, tier) entry. */
  private applyPoolDelete(kind: "plate" | "glass", tier: number): void {
    const pool = this.poolFor(kind);
    if (!pool.has(tier)) return;
    this.suppressMirrorForReload = true;
    try {
      pool.delete(tier);
    } finally {
      this.suppressMirrorForReload = false;
    }
  }

  /** Apply one dishwasher_batch row from the cloud. Captures the
   * current cycle-remaining straight from the server — local cycle
   * decay in update() will continue from this snapshot. */
  private applyBatchRow(row: import("../cloud/SpacetimeClient").DishwasherBatchRow): void {
    const cur = this.dishwasherBatches.get(row.furnitureUid);
    const newRemaining = Number(row.cycleTimeRemainingMs) / 1000;
    if (cur && cur.plates === row.plates && cur.glasses === row.glasses
        && Math.abs(cur.cycleTimeRemaining - newRemaining) < 0.05
        && cur.defId === row.defId) {
      return;
    }
    this.suppressMirrorForReload = true;
    try {
      this.dishwasherBatches.set(row.furnitureUid, {
        defId: row.defId,
        plates: row.plates,
        glasses: row.glasses,
        cycleTimeRemaining: newRemaining,
      });
    } finally {
      this.suppressMirrorForReload = false;
    }
  }

  /** Apply a dishwasher_batch delete (cycle finished server-side or
   * dishwasher was sold). */
  private applyBatchDelete(uid: string): void {
    if (!this.dishwasherBatches.has(uid)) return;
    this.suppressMirrorForReload = true;
    try {
      this.dishwasherBatches.delete(uid);
    } finally {
      this.suppressMirrorForReload = false;
    }
  }

  /** Internal logging helper — keeps the log() callsites tidy and
   * lets us add a global toggle later without touching every emit. */
  private log(msg: string): void {
    this.logger?.(msg);
  }

  /** Total dishware ever added to the inventory. The watcher diffs
   * this against current (clean + dirty + in-flight) to detect leaks. */
  getLifetimeAdded(): number {
    return this.lifetimeAddedPlate + this.lifetimeAddedGlass;
  }
  /** Per-kind lifetime totals for the save snapshot. Restored on
   * hydrate to recover any pieces that leaked during the previous
   * session. */
  getLifetimeAddedByKind(): { plate: number; glass: number } {
    return { plate: this.lifetimeAddedPlate, glass: this.lifetimeAddedGlass };
  }
  private bumpLifetime(kind: DishKind, n: number): void {
    if (n <= 0) return;
    if (kind === "plate") this.lifetimeAddedPlate += n;
    else this.lifetimeAddedGlass += n;
  }

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
    this.lifetimeAddedPlate = STARTER_PLATE_COUNT;
    this.lifetimeAddedGlass = STARTER_GLASS_COUNT;
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
    if (tier === null) {
      this.log(`reserveOne(${kind}) → null (no clean stock)`);
      return null;
    }
    const pool = this.poolFor(kind);
    const entry = pool.get(tier)!;
    entry.clean -= 1;
    if (entry.clean === 0 && entry.dirty === 0) pool.delete(tier);
    this.log(`reserveOne(${kind}, t${tier}) → clean ${this.getClean(kind)}, dirty ${this.getDirty(kind)}`);
    this.mirrorBump(kind, tier, -1, 0); // H.31
    return tier;
  }

  /** Move one piece of the given tier into the dirty pool. Called when
   * a guest finishes their course. */
  markDirty(kind: DishKind, tier: number): void {
    const pool = this.poolFor(kind);
    const entry = pool.get(tier) ?? { clean: 0, dirty: 0 };
    entry.dirty += 1;
    pool.set(tier, entry);
    this.log(`markDirty(${kind}, t${tier}) → clean ${this.getClean(kind)}, dirty ${this.getDirty(kind)}`);
    this.mirrorBump(kind, tier, 0, +1); // H.31
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
    if (best === null) {
      this.log(`washOne(${kind}) → null (nothing dirty)`);
      return null;
    }
    const entry = pool.get(best)!;
    entry.dirty -= 1;
    entry.clean += 1;
    this.onDishWashed?.(kind, best);
    this.log(`washOne(${kind}, t${best}) → clean ${this.getClean(kind)}, dirty ${this.getDirty(kind)}`);
    this.mirrorBump(kind, best, +1, -1); // H.31
    return best;
  }

  /** Add `count` clean pieces of a given tier to the pool. Caps at the
   * current storage capacity — returns the count actually added so
   * callers can refund the unused portion or show a "no room" warning. */
  addClean(kind: DishKind, tier: number, count: number): number {
    if (count <= 0) return 0;
    const free = this.getFreeCapacity();
    if (free <= 0) {
      this.log(`addClean(${kind}, t${tier}, +${count}) → 0 (capacity full)`);
      return 0;
    }
    const take = Math.min(count, free);
    const pool = this.poolFor(kind);
    const entry = pool.get(tier) ?? { clean: 0, dirty: 0 };
    entry.clean += take;
    pool.set(tier, entry);
    // NOTE: lifetimeAdded is NOT bumped here. addClean is the shared
    // "move into the clean pool" path, used both by buySet (genuinely
    // new dishware) and by GuestSpawner.settleGuestDishes (returning a
    // reservation that was already counted in lifetimeAdded). buySet
    // bumps lifetimeAdded itself so only real purchases inflate the
    // expected total.
    this.log(`addClean(${kind}, t${tier}, +${take}) → clean ${this.getClean(kind)}, dirty ${this.getDirty(kind)}`);
    this.mirrorBump(kind, tier, +take, 0); // H.31
    return take;
  }

  /** Buy ONE set of the given catalog entry. Returns the number of
   * pieces actually added (0 when capacity blocks, setSize on success).
   * Caller is responsible for charging the cost. */
  buySet(set: DishwareSetDef): number {
    const taken = this.addClean(set.kind, set.tier, set.setSize);
    // Only the buy path inflates lifetime totals — settleGuestDishes
    // also calls addClean to return reservations, and those plates were
    // already part of the lifetime when bought.
    this.bumpLifetime(set.kind, taken);
    if (taken > 0) {
      // Append to the immutable purchase log — this is the audit
      // trail the player can use to reconcile their inventory if
      // the in-game pool ever drifts. Combined with STARTER counts
      // it's the ground-truth lifetime.
      this.purchaseLog.push({ kind: set.kind, tier: set.tier, count: taken, at: Date.now() });
    }
    this.log(`buySet(${set.id ?? set.kind}, t${set.tier}, +${taken}) → lifetime ${this.getLifetimeAdded()}`);
    return taken;
  }

  /** Read-only view of the purchase log for debug / admin UI. */
  getPurchaseLog(): readonly { kind: DishKind; tier: number; count: number; at: number }[] {
    return this.purchaseLog;
  }

  /** Recompute the "expected" lifetime totals straight from STARTER
   * + sum(purchaseLog). This is the canonical formula — if the
   * mutable lifetime counters ever disagree, this is the value
   * they should be reset to. */
  computeLifetimeFromLog(): { plate: number; glass: number } {
    let plate = STARTER_PLATE_COUNT;
    let glass = STARTER_GLASS_COUNT;
    for (const p of this.purchaseLog) {
      if (p.kind === "plate") plate += p.count;
      else glass += p.count;
    }
    return { plate, glass };
  }

  /** Phase I (H.76) — Reconcile a single kind's pool to match the
   * canonical lifetime.  Called by hydrate after computing lifetime
   * from STARTER + sum(purchaseLog).  Two cases:
   *
   *   - owned > target (BLOAT): trim the excess.  Start from
   *     highest-tier clean (most replaceable), then highest-tier
   *     dirty, walking down to tier 1.  Preserves the player's
   *     best plates last.
   *   - owned < target (LEAK): top up the missing count into tier
   *     1 clean.  These are pieces that were in-flight at save
   *     time or got dropped by the chef-stall bug; recovering them
   *     keeps the total honest.
   *
   * No-op when owned === target. */
  private reconcilePoolToLifetime(kind: DishKind): void {
    const target = kind === "plate" ? this.lifetimeAddedPlate : this.lifetimeAddedGlass;
    const owned = this.getOwned(kind);
    if (owned === target) return;
    const map = kind === "plate" ? this.plates : this.glasses;
    if (owned > target) {
      let excess = owned - target;
      const tiersDesc = Array.from(map.keys()).sort((a, b) => b - a);
      for (const tier of tiersDesc) {
        if (excess <= 0) break;
        const e = map.get(tier)!;
        const trimClean = Math.min(excess, e.clean);
        e.clean -= trimClean;
        excess -= trimClean;
        if (excess <= 0) break;
        const trimDirty = Math.min(excess, e.dirty);
        e.dirty -= trimDirty;
        excess -= trimDirty;
      }
      this.log(`hydrate: trimmed ${owned - target} excess ${kind}(s) → canonical ${target} (was ${owned})`);
    } else {
      const missing = target - owned;
      const e = map.get(1) ?? { clean: 0, dirty: 0 };
      e.clean += missing;
      map.set(1, e);
      this.log(`hydrate: topped up ${missing} missing ${kind}(s) → clean tier 1 (was ${owned}, target ${target})`);
    }
  }

  /** Admin: reset both pool and lifetime counters to STARTER +
   * sum(purchaseLog). Sole purpose is undoing the accumulated
   * over-compensation from the pre-fix hydrate bug. Players who
   * sat on that bug for many sessions ended up with hundreds of
   * phantom dishes; this rewinds them to "what you actually
   * bought" without losing the purchase history. */
  reconcileToPurchaseLog(): void {
    const target = this.computeLifetimeFromLog();
    this.plates = new Map();
    this.glasses = new Map();
    this.plates.set(1, { clean: target.plate, dirty: 0 });
    this.glasses.set(1, { clean: target.glass, dirty: 0 });
    this.lifetimeAddedPlate = target.plate;
    this.lifetimeAddedGlass = target.glass;
    this.log(`reconcileToPurchaseLog → ${target.plate} plates, ${target.glass} glasses (starter + ${this.purchaseLog.length} purchases)`);
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

  /** Tick the background dishwasher cycles. Waiters dropping a piece
   * at a dishwasher add it to that station's batch and walk away; the
   * cycle clock counts down here and flushes every loaded piece to
   * the clean pool when it hits zero. Sink washes happen synchronously
   * via washOne() the moment the waiter finishes scrubbing — those
   * never touch this tick. */
  update(dt: number): void {
    // Phase H cutover — when isServerSim("dishware") is on, the server
    // owns the cycle countdown (H.4 added tick_dishwasher_batch to
    // restaurant_tick). Skip the local countdown entirely so the
    // cloud row's cycle_time_remaining_ms is the only source of truth.
    // The subscription's applyBatchRow updates our local dishwasherBatches
    // map to match each server tick, including the auto-flush on
    // expiry — so the UI / sound effects driven off
    // getDishwasherBatch keep working without local arithmetic.
    if (isServerSim("dishware")) return;
    // Throttle the per-tick batch-time stream to ~1 Hz. Pool updates
    // already fire on every washOne call below, but the batch's
    // cycle_time_remaining_ms otherwise wouldn't update server-side
    // until the cycle completed — leaving subscribers reading a
    // stale "8.4 s remaining" for the entire wash.
    this.batchStreamAccum += dt;
    const streamDue = this.batchStreamAccum >= 1.0;
    if (streamDue) this.batchStreamAccum = 0;
    for (const [uid, batch] of this.dishwasherBatches) {
      const loaded = batch.plates + batch.glasses;
      if (loaded === 0) continue;
      batch.cycleTimeRemaining -= dt;
      if (batch.cycleTimeRemaining > 0) {
        if (streamDue) this.mirrorBatch(uid);
        continue;
      }
      // Cycle complete — all loaded pieces become clean simultaneously.
      // washOne picks the highest-tier dirty piece globally; the
      // dishwasher is abstract about WHICH piece it holds.
      for (let i = 0; i < batch.plates; i += 1) this.washOne("plate");
      for (let i = 0; i < batch.glasses; i += 1) this.washOne("glass");
      batch.plates = 0;
      batch.glasses = 0;
      batch.cycleTimeRemaining = 0;
      this.mirrorBatch(uid); // empty → server deletes the row
    }
  }

  /** Accumulator for the ~1 Hz dishwasher cycle-clock stream. */
  private batchStreamAccum = 0;

  // === Dishwasher batch API (called by the waiter wash trip) ===

  /** Can the named dishwasher accept one more piece of `kind`? Returns
   * false when this dishwasher's batch is already at capacity for
   * that kind. The waiter trip system reads this before claiming a
   * station so a full dishwasher doesn't lock out other waiters. */
  canDishwasherLoad(uid: string, kind: DishKind): boolean {
    const batch = this.dishwasherBatches.get(uid);
    if (!batch) return true;
    const current = kind === "plate" ? batch.plates : batch.glasses;
    return current < DISHWASHER_CAPACITY[kind];
  }

  /** Drop one piece into the named dishwasher. Returns false when
   * the batch is full for that kind (callers should fall back to a
   * sink or another dishwasher). The cycle timer extends by
   * washPerItem so a steady drip of plates keeps the cycle running. */
  loadDishwasher(uid: string, defId: string, kind: DishKind): boolean {
    let batch = this.dishwasherBatches.get(uid);
    if (!batch) {
      batch = { defId, plates: 0, glasses: 0, cycleTimeRemaining: 0 };
      this.dishwasherBatches.set(uid, batch);
    } else {
      // If the same uid somehow gets a different def (move / replace),
      // refresh defId so the wash rate matches the placed unit.
      batch.defId = defId;
    }
    const current = kind === "plate" ? batch.plates : batch.glasses;
    if (current >= DISHWASHER_CAPACITY[kind]) return false;
    if (kind === "plate") batch.plates += 1;
    else batch.glasses += 1;
    batch.cycleTimeRemaining += dishwasherWashPerItem(defId);
    this.mirrorBatch(uid);
    return true;
  }

  /** Per-uid snapshot — for the StockStatusWidget tooltip and any
   * future "open dishwasher" UI. Returns null when the uid hasn't
   * been loaded yet (empty dishwashers don't have a batch record). */
  getDishwasherBatch(uid: string): { plates: number; glasses: number; cycleTimeRemaining: number } | null {
    const batch = this.dishwasherBatches.get(uid);
    if (!batch) return null;
    return { plates: batch.plates, glasses: batch.glasses, cycleTimeRemaining: batch.cycleTimeRemaining };
  }

  /** Sum of pieces currently mid-wash across every dishwasher. UI
   * uses this to clarify "X dirty (Y in dishwashers)" so the player
   * isn't surprised by the wait between trip end and clean-count tick. */
  getDishwasherInFlight(kind: DishKind): number {
    let n = 0;
    for (const b of this.dishwasherBatches.values()) {
      n += kind === "plate" ? b.plates : b.glasses;
    }
    return n;
  }

  /** Capacity per kind in a single dishwasher. Exposed so UI / tooltips
   * can show "10 / 10 plates" without hardcoding the number. */
  static getDishwasherCapacity(kind: DishKind): number {
    return DISHWASHER_CAPACITY[kind];
  }

  /** Admin / dev-tool: move every dirty piece (in pools + dishwasher
   * batches) back into the clean pool. Useful for testing the
   * post-rush "everything is clean again" state without waiting for
   * the wash cycles. */
  adminWashAll(): void {
    for (const entry of this.plates.values()) {
      entry.clean += entry.dirty;
      entry.dirty = 0;
    }
    for (const entry of this.glasses.values()) {
      entry.clean += entry.dirty;
      entry.dirty = 0;
    }
    for (const [uid, batch] of this.dishwasherBatches) {
      for (let i = 0; i < batch.plates; i += 1) this.washOne("plate");
      for (let i = 0; i < batch.glasses; i += 1) this.washOne("glass");
      batch.plates = 0;
      batch.glasses = 0;
      batch.cycleTimeRemaining = 0;
      this.mirrorBatch(uid);
    }
    this.mirrorAllPools();
    this.log(`adminWashAll → clean p${this.getClean("plate")}/g${this.getClean("glass")}, dirty p${this.getDirty("plate")}/g${this.getDirty("glass")}`);
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
  hydrate(
    save: { plates?: Array<[number, number, number]>; glasses?: Array<[number, number, number]> } | null | undefined,
    inFlight?: Array<{ kind: string; tier: number; count: number }>,
    lifetime?: { plate?: number; glass?: number },
    purchaseLog?: Array<{ kind: string; tier: number; count: number; at?: number }>,
  ): void {
    this.plates = new Map();
    this.glasses = new Map();
    if (save?.plates) triplesToPool(save.plates, this.plates);
    if (save?.glasses) triplesToPool(save.glasses, this.glasses);
    if (this.plates.size === 0) this.plates.set(1, { clean: STARTER_PLATE_COUNT, dirty: 0 });
    if (this.glasses.size === 0) this.glasses.set(1, { clean: STARTER_GLASS_COUNT, dirty: 0 });
    autoWashPool(this.plates);
    autoWashPool(this.glasses);
    // === Phase I (H.76) — Canonical accounting via purchaseLog ===
    //
    // Per Dunnin's specification ("started with X, bought Y, total
    // = X+Y"), lifetime is ALWAYS computed from STARTER +
    // sum(purchaseLog).  The save's `lifetime` field is no longer
    // trusted — it could be bloated from the legacy "subscription
    // bump" + "restoreFromCloud re-baseline" bugs that ratcheted
    // counts upward across sessions.  purchaseLog is the
    // immutable audit trail of what the player actually bought;
    // it can only grow via buySet (one append per purchase).

    // Step 1 — load the audit log.
    const sawLogField = Array.isArray(purchaseLog);
    if (sawLogField) {
      this.purchaseLog = purchaseLog!
        .filter((p) => p && typeof p.tier === "number" && typeof p.count === "number"
          && p.tier >= 1 && p.tier <= 5 && p.count > 0)
        .map((p) => ({
          kind: p.kind === "glass" ? "glass" : "plate" as DishKind,
          tier: Math.floor(p.tier),
          count: Math.floor(p.count),
          at: typeof p.at === "number" ? p.at : 0,
        }));
    } else {
      this.purchaseLog = [];
    }

    // Step 2 — if the save predates the purchaseLog field (legacy
    // user), synthesize a single retroactive entry from whatever
    // is in the pool right now MINUS the starter.  That preserves
    // their existing dishes as "things they bought back then" so
    // we don't zero them out.  Going forward, future buys append
    // normally.
    //
    // We ONLY synthesize for true legacy (sawLogField=false).  If
    // the save HAS a purchaseLog field but it's empty, treat that
    // as "user hasn't bought anything yet" — STARTER counts apply.
    if (!sawLogField) {
      const platesBeyondStarter = Math.max(0, this.getOwned("plate") - STARTER_PLATE_COUNT);
      const glassesBeyondStarter = Math.max(0, this.getOwned("glass") - STARTER_GLASS_COUNT);
      if (platesBeyondStarter > 0) {
        this.purchaseLog.push({ kind: "plate", tier: 1, count: platesBeyondStarter, at: 0 });
      }
      if (glassesBeyondStarter > 0) {
        this.purchaseLog.push({ kind: "glass", tier: 1, count: glassesBeyondStarter, at: 0 });
      }
      if (platesBeyondStarter > 0 || glassesBeyondStarter > 0) {
        this.log(`legacy save without purchaseLog — synthesized ${platesBeyondStarter} plate(s) + ${glassesBeyondStarter} glass(es) into the log`);
      }
    }

    // Step 3 — derive lifetime from the (possibly-just-synthesized) log.
    const target = this.computeLifetimeFromLog();
    this.lifetimeAddedPlate = target.plate;
    this.lifetimeAddedGlass = target.glass;

    // Step 4 — reconcile the loaded pool to match the canonical
    // lifetime.  Trim if over (bloat recovery), top up if under
    // (in-flight pieces returning home, leaks from chef-stall etc.).
    this.reconcilePoolToLifetime("plate");
    this.reconcilePoolToLifetime("glass");

    // The `inFlight` + `lifetime` save params are now ignored — kept
    // in the signature only so old call sites don't have to change.
    void inFlight; void lifetime;
    this.log(`hydrate → clean p${this.getClean("plate")}/g${this.getClean("glass")}, dirty p${this.getDirty("plate")}/g${this.getDirty("glass")}, lifetime p${this.lifetimeAddedPlate}/g${this.lifetimeAddedGlass} (canonical), log entries: ${this.purchaseLog.length}`);
    // Phase E — push the post-hydrate pool snapshot to the cloud so
    // subscribers see the loaded restaurant's dish inventory without
    // waiting for the first per-action mutation.
    this.mirrorAllPools();
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
