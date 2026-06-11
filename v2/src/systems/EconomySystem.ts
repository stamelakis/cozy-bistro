import type { SaveGameState, TransactionLogEntry } from "../data/types";

const maxTransactionLogEntries = 5000;

export type EarnReason = "payment" | "refund" | "grant" | "offline" | "achievement";
export type SpendReason = "ingredients" | "staff" | "unlock" | "decor" | "rent";
export type ForceSpendReason = "rent" | "charge" | "restock" | "salary";

export class EconomySystem {
  private money: number;
  private transactionLog: TransactionLogEntry[] = [];
  private dailyRevenueTotal = 0;
  private dailyExpensesTotal = 0;

  /** Phase I.5 (H.61) — cloud handle for periodic transaction-log
   * mirror.  Engine wires this on connect.  Push cadence is driven
   * from Engine.update's daySyncAccum tick (5 s), NOT every record
   * call — busy play can fire many transactions per second.
   *
   * `transactionLogDirty` is set whenever a record fires so the
   * sync tick knows whether to bother pushing. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;
  private transactionLogDirty = false;

  /** Phase 7.7 — Baseline for delta-based cloud money sync. The
   * Engine.update tick pushes (local - lastSyncedCents) to the server
   * as a DELTA, then advances this to match. Lets server-side
   * accumulate adds (tips/revenue/etc.) coexist with client-side
   * spends without either side overwriting the other.
   *
   * Phase 9.3 — null means UNANCHORED: no successful local↔cloud
   * reconciliation has happened yet this session. Both delta
   * consumers MUST refuse to compute a delta against an unanchored
   * baseline:
   *   - Engine's 5s push: computing (localSave − 0) on a fresh boot
   *     pushed the player's ENTIRE saved balance to the cloud as if
   *     it were new income…
   *   - restaurant.onUpdate handler: …and computing (cloud − 0) on
   *     the first row update earned the entire CLOUD balance on top
   *     of the local save.
   *   Together those two roughly DOUBLED the balance on every
   *   reload (the 100k → 3.4M dupe). The first anchor must always
   *   be an ADOPTION (setMoney to cloud + noteSyncedCents), never a
   *   delta. */
  private lastSyncedCents: number | null = null;

  /** Phase 7.7 — Caller informs the sync system that money has been
   * synced (in either direction) and the local↔cloud delta is now 0.
   * Engine.update's 5s sync calls this after firing bumpCloudMoney.
   * The Restaurant subscription handler calls it after adopting a
   * server-side cloud_money_cents update into local. */
  noteSyncedCents(cents: number): void {
    this.lastSyncedCents = cents;
  }

  /** Phase 7.7 — Read the last-synced baseline. Engine.update uses
   * (local * 100) - lastSyncedCents to compute the delta to push.
   * Phase 9.3 — null = unanchored; callers must adopt, not delta. */
  getLastSyncedCents(): number | null {
    return this.lastSyncedCents;
  }

  constructor(startingMoney = 0) {
    // Default is 0 because the Engine's enterGame flow grants the
    // size-specific starter cash on first claim (small=$1000,
    // medium=$1500, large=$2000). Returning players have their
    // saved money loaded over the top via load(). The previous
    // default of $6000 stacked with the claim bonus to give new
    // players a much larger pot than intended.
    this.money = startingMoney;
  }

  getMoney(): number {
    return this.money;
  }

  canAfford(amount: number): boolean {
    return this.money >= amount;
  }

  spend(amount: number): boolean {
    if (!this.canAfford(amount)) {
      return false;
    }

    this.money -= amount;
    return true;
  }

  charge(amount: number): void {
    this.money -= amount;
  }

  earn(amount: number): void {
    this.money += amount;
  }

  setMoney(amount: number): void {
    this.money = amount;
  }

  /** Earn money and update daily revenue + transaction log. */
  earnMoney(amount: number, reason: EarnReason = "payment"): void {
    this.earn(amount);
    if (reason === "payment" || reason === "offline") {
      this.dailyRevenueTotal += amount;
    }
    this.recordTransaction(getEarnTransactionLabel(reason), amount);
  }

  /** Spend money if affordable; updates daily expenses + transaction log. Returns whether the spend succeeded. */
  spendMoney(amount: number, reason: SpendReason): boolean {
    const spent = this.spend(amount);
    if (spent) {
      this.dailyExpensesTotal += amount;
      this.recordTransaction(getSpendTransactionLabel(reason), -amount);
    }
    return spent;
  }

  /** Charge money regardless of affordability (allows negative balance); updates daily expenses + transaction log. */
  forceSpendMoney(amount: number, reason: ForceSpendReason = "rent"): void {
    this.charge(amount);
    this.dailyExpensesTotal += amount;
    const label =
      reason === "rent" ? "Rent"
      : reason === "restock" ? "Auto-shop restock (offline)"
      : reason === "salary" ? "Staff salary (offline)"
      : "Forced charge";
    this.recordTransaction(label, -amount);
  }

  getDailyRevenue(): number {
    return this.dailyRevenueTotal;
  }

  getDailyExpenses(): number {
    return this.dailyExpensesTotal;
  }

  /** Phase 7.8 — Adopt cloud_daily_revenue_cents as the local truth.
   * Server's accumulate_pending_visit_rollup writes the canonical
   * value on every despawn; the cloud subscription handler calls
   * this so the HUD + leaderboard read the server's "today" number
   * instead of a syncCloudDailyTotals-stale local one. Clamped >= 0. */
  setDailyRevenue(amount: number): void {
    this.dailyRevenueTotal = Math.max(0, amount);
  }

  /** Phase 7.8 — Same for expenses. Mirrors tick_offline_salary,
   * tick_day_clock rent, and try_restock_pantry which all bump
   * cloud_daily_expenses_cents directly server-side. */
  setDailyExpenses(amount: number): void {
    this.dailyExpensesTotal = Math.max(0, amount);
  }

  /** Undo part of a prior expense without crediting it as new revenue (e.g. cancelled order refund). */
  refundDailyExpenses(amount: number): void {
    this.dailyExpensesTotal = Math.max(0, this.dailyExpensesTotal - amount);
  }

  resetDailyTotals(): void {
    this.dailyRevenueTotal = 0;
    this.dailyExpensesTotal = 0;
  }

  getTransactionLog(): readonly TransactionLogEntry[] {
    return this.transactionLog;
  }

  /** Snapshot of the transaction log clipped to the save-friendly cap. */
  getTransactionLogForSave(): TransactionLogEntry[] {
    return this.transactionLog.slice(-maxTransactionLogEntries);
  }

  recordTransaction(transaction: string, amount: number): void {
    const roundedAmount = Math.round(amount);
    const signedAmount =
      roundedAmount > 0 ? `+$${roundedAmount}` : roundedAmount < 0 ? `-$${Math.abs(roundedAmount)}` : "$0";
    this.transactionLog.push({
      at: Date.now(),
      transaction: `${transaction} ${signedAmount}`,
      amount: roundedAmount,
      balance: Math.round(this.money),
    });
    if (this.transactionLog.length > maxTransactionLogEntries) {
      this.transactionLog = this.transactionLog.slice(-maxTransactionLogEntries);
    }
    // H.61 — mark dirty so the next Engine sync tick pushes the
    // snapshot to cloud.  Don't push here — busy play can fire
    // many transactions per second.
    this.transactionLogDirty = true;
  }

  /** Phase I.5 (H.61) — Push the transaction log snapshot to cloud
   * if dirty.  Called from Engine's daySyncAccum tick (5 s cadence,
   * piggybacking on syncCloudMoney / syncCloudDailyTotals).  No-op
   * when no transactions have been recorded since last push. */
  syncTransactionLogToCloud(): void {
    if (!this.cloud) return;
    if (!this.transactionLogDirty) return;
    this.transactionLogDirty = false;
    // Last 100 is plenty for the ledger view.  Server caps at
    // 16 KB; client caps the array before serializing.
    this.cloud.setCloudTransactionLog(this.transactionLog.slice(-100));
  }

  /** Phase I.5 (H.61) — Override the local log from a fresh cloud
   * snapshot.  Engine calls on subscription ready; cloud is
   * authoritative if it has entries. */
  applyCloudTransactionLog(entries: readonly TransactionLogEntry[]): void {
    this.transactionLog = entries
      .filter((e) => Number.isFinite(e.at) && typeof e.transaction === "string"
        && Number.isFinite(e.amount) && Number.isFinite(e.balance))
      .slice(-maxTransactionLogEntries);
    this.transactionLogDirty = false;
  }

  /** Restore economy state from a save snapshot. Includes money — the
   * old 2D comment ("Money is set separately by the scene") referred to
   * GameScene wiring that no longer exists in v2; without restoring money
   * here the player's balance always resets to the constructor default
   * on every page reload. */
  hydrate(save: SaveGameState | null | undefined): void {
    if (typeof save?.money === "number" && Number.isFinite(save.money)) {
      this.money = save.money;
    }
    this.dailyRevenueTotal = save?.dailyRevenue ?? 0;
    this.dailyExpensesTotal = save?.dailyExpenses ?? 0;
    this.transactionLog = hydrateTransactionLogEntries(save?.transactionLog);
  }
}

function getEarnTransactionLabel(reason: EarnReason): string {
  const labels: Record<EarnReason, string> = {
    payment: "Customer payment",
    refund: "Refund",
    grant: "Grant/reward",
    offline: "Offline earnings",
    achievement: "Achievement reward",
  };
  return labels[reason];
}

function getSpendTransactionLabel(reason: SpendReason): string {
  const labels: Record<SpendReason, string> = {
    ingredients: "Ingredient purchase",
    staff: "Staff cost",
    unlock: "Unlock purchase",
    decor: "Furniture/decor purchase",
    rent: "Rent",
  };
  return labels[reason];
}

function hydrateTransactionLogEntries(entries?: TransactionLogEntry[]): TransactionLogEntry[] {
  return (entries ?? [])
    .map((entry) => ({
      at: Number(entry.at) || Date.now(),
      transaction: String(entry.transaction || "Transaction"),
      amount: Math.round(Number(entry.amount) || 0),
      balance: Math.round(Number(entry.balance) || 0),
    }))
    .slice(-maxTransactionLogEntries);
}
