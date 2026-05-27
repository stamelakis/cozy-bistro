import { EconomySystem } from "../systems/EconomySystem";
import { ReputationSystem } from "../systems/ReputationSystem";
import { CookingSystem } from "../systems/CookingSystem";
import { CustomerSystem } from "../systems/CustomerSystem";
import { DayCycleSystem, rentIntervalSeconds } from "../systems/DayCycleSystem";
import { StaffSystem } from "../systems/StaffSystem";
import type { SaveGameState } from "../data/types";

/** Money charged automatically per in-game day. */
const DAILY_RENT = 40;
/** Money charged per staff member per real minute. */
const PAYROLL_PER_STAFF_PER_MINUTE = 6;

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
      this.cooking.syncLuxuryUnlocks(1);
      if (this.cooking.getMenuRecipeIds().length === 0) {
        this.cooking.addToMenu("toast");
      }
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
  }

  hydrate(save: SaveGameState): void {
    this.economy.hydrate(save);
    this.reputation.hydrate(save);
    // cooking needs the current unlocked-tier; default to tier 1 for now
    // (we'll wire real expansion progression later).
    this.cooking.hydrate(save, 1);
    this.customers.hydrate(save);
    this.day.hydrate(save);
    this.staff.hydrate(save);
  }

  private rolloverDay(): void {
    this.economy.resetDailyTotals();
    this.customers.resetDailyTotals();
    this.day.rollOverDay();
  }
}
