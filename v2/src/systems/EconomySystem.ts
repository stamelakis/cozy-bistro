import type { SaveGameState, TransactionLogEntry } from "../data/types";

const maxTransactionLogEntries = 5000;

export type EarnReason = "payment" | "refund" | "grant" | "offline";
export type SpendReason = "ingredients" | "staff" | "unlock" | "decor" | "rent";
export type ForceSpendReason = "rent" | "charge";

export class EconomySystem {
  private money: number;
  private transactionLog: TransactionLogEntry[] = [];
  private dailyRevenueTotal = 0;
  private dailyExpensesTotal = 0;

  constructor(startingMoney = 4000) {
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
    this.recordTransaction(reason === "rent" ? "Rent" : "Forced charge", -amount);
  }

  getDailyRevenue(): number {
    return this.dailyRevenueTotal;
  }

  getDailyExpenses(): number {
    return this.dailyExpensesTotal;
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
