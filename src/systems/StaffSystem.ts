import type { HiredStaff, SaveGameState } from "../components/types";

export type StaffRole = "chef" | "waiter" | "errand";

export const chefHireCost = 80;
export const waiterHireCost = 70;
export const errandHireCost = 65;
export const chefFireCost = 18;
export const waiterFireCost = 14;
export const errandFireCost = 12;
export const defaultPayrollPerStaffPerMinute = 1;

/** A payroll tick result describes what the scene should charge and how to bookkeep. */
export interface SalaryTickResult {
  /** Whole-dollar amount to charge for this tick. Caller applies the money operation. */
  charge: number;
}

/**
 * Owns staff headcount, pending-firing queue (waiters/chefs who are busy and will leave
 * after their current task), hire/fire pricing math, and the salary tick accumulator.
 *
 * Phaser-coupled actor management (sprites, animation, station assignment) stays in the
 * scene because it touches the rendering layer; this class only tracks counts.
 */
export class StaffSystem {
  private staff: HiredStaff = { chefs: 0, waiters: 0, errandBoys: 0 };
  private pendingStaffFirings: Record<StaffRole, number> = { chef: 0, waiter: 0, errand: 0 };
  private lastSalaryChargeAt = 0;
  private salaryRemainder = 0;

  // === Headcount ===

  /** Returns a fresh shallow copy with errandBoys normalised to a number. */
  getStaff(): HiredStaff {
    return {
      chefs: this.staff.chefs,
      waiters: this.staff.waiters,
      errandBoys: this.staff.errandBoys ?? 0,
    };
  }

  getStaffCount(role: StaffRole): number {
    if (role === "chef") return this.staff.chefs;
    if (role === "waiter") return this.staff.waiters;
    return this.staff.errandBoys ?? 0;
  }

  getTotalStaff(): number {
    return this.staff.chefs + this.staff.waiters + (this.staff.errandBoys ?? 0);
  }

  getPendingFirings(role: StaffRole): number {
    return this.pendingStaffFirings[role];
  }

  /**
   * Increment the count for `role`. Returns the index of the new staff member
   * (e.g. for the scene to spawn the corresponding actor sprite).
   */
  addStaff(role: StaffRole): number {
    if (role === "chef") {
      this.staff.chefs += 1;
      return this.staff.chefs - 1;
    }
    if (role === "waiter") {
      this.staff.waiters += 1;
      return this.staff.waiters - 1;
    }
    this.staff.errandBoys = (this.staff.errandBoys ?? 0) + 1;
    return (this.staff.errandBoys ?? 1) - 1;
  }

  /** Decrement the count for `role`. Floors at 0. */
  removeStaff(role: StaffRole): void {
    if (role === "chef") {
      this.staff.chefs = Math.max(0, this.staff.chefs - 1);
    } else if (role === "waiter") {
      this.staff.waiters = Math.max(0, this.staff.waiters - 1);
    } else {
      this.staff.errandBoys = Math.max(0, (this.staff.errandBoys ?? 0) - 1);
    }
  }

  queueFiring(role: StaffRole): void {
    this.pendingStaffFirings[role] += 1;
  }

  /** Drain one pending firing. Returns true if there was one to drain. */
  drainPendingFiring(role: StaffRole): boolean {
    if (this.pendingStaffFirings[role] <= 0) {
      return false;
    }
    this.pendingStaffFirings[role] -= 1;
    return true;
  }

  // === Pricing ===

  getStaffHireCost(role: StaffRole): number {
    const baseCost = role === "chef" ? chefHireCost : role === "waiter" ? waiterHireCost : errandHireCost;
    const currentCount = this.getStaffCount(role);
    return roundStaffMoney(baseCost * (1 + currentCount * 0.1));
  }

  getStaffFireCost(role: StaffRole): number {
    return role === "chef" ? chefFireCost : role === "waiter" ? waiterFireCost : errandFireCost;
  }

  // === Salary tick ===

  /**
   * Advance the salary accumulator using current wall-clock time.
   *
   * On the first call (or after reset), the timestamp is recorded and no charge is
   * returned. Subsequent calls measure elapsed ms, accumulate the fractional payroll
   * owed, and return the whole-dollar amount due. Caller applies the money operation
   * with the scene's standard side effects (rate sampling, transaction log).
   *
   * Returns `charge: 0` until at least 5 seconds have elapsed since the last
   * non-skipped call — this is the existing in-game cadence.
   */
  tickSalary(time: number, payrollPerStaffPerMinute: number): SalaryTickResult {
    if (this.lastSalaryChargeAt === 0) {
      this.lastSalaryChargeAt = time;
      return { charge: 0 };
    }

    const elapsedMs = time - this.lastSalaryChargeAt;
    if (elapsedMs < 5000) {
      return { charge: 0 };
    }

    this.lastSalaryChargeAt = time;
    const due = this.salaryRemainder + (this.getTotalStaff() * payrollPerStaffPerMinute * elapsedMs) / 60000;
    const charge = Math.floor(due);
    this.salaryRemainder = due - charge;
    return { charge };
  }

  /** Reset the salary accumulator (e.g. on save load so the first tick after load doesn't double-charge). */
  resetSalaryTick(): void {
    this.lastSalaryChargeAt = 0;
    this.salaryRemainder = 0;
  }

  // === Labels ===

  getStaffRoleLabel(role: StaffRole): string {
    if (role === "chef") return "Chef";
    if (role === "waiter") return "Waiter";
    return "Errand helper";
  }

  // === Save/load ===

  hydrate(save: SaveGameState | null | undefined): void {
    this.staff = {
      chefs: save?.staff?.chefs ?? 0,
      waiters: save?.staff?.waiters ?? 0,
      errandBoys: save?.staff?.errandBoys ?? 0,
    };
    this.pendingStaffFirings = { chef: 0, waiter: 0, errand: 0 };
    this.resetSalaryTick();
  }
}

/** Pure helper: round payroll/hire costs up to the nearest $5, minimum $1. */
function roundStaffMoney(amount: number): number {
  return Math.max(1, Math.ceil(amount / 5) * 5);
}
