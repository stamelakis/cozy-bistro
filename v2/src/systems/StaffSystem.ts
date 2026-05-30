import type { HiredStaff, HiredStaffMember, SaveGameState } from "../data/types";
import { randomStaffName } from "../data/staffNames";

export type StaffRole = "chef" | "waiter" | "errand" | "barman";

export const chefHireCost = 80;
export const waiterHireCost = 70;
export const errandHireCost = 65;
// Barman sits between chef and waiter — narrower job (drinks only)
// but a real station-owner, not a runner. Hire cost mirrors chef's.
export const barmanHireCost = 80;
export const chefFireCost = 18;
export const waiterFireCost = 14;
export const errandFireCost = 12;
export const barmanFireCost = 18;
export const defaultPayrollPerStaffPerMinute = 0;

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
/** Cap on staff training levels — 0 = base, STAFF_UPGRADE_MAX = fully
 * trained. 5 feels right for a casual sim: each level is a meaningful
 * but not overwhelming bump and the player has a clear endpoint. */
export const STAFF_UPGRADE_MAX = 5;

/** Training duration in REAL hours, doubling per target level. L1 is
 * "set it and come back in 3 hours" — the trainee's deadline is a
 * wall-clock timestamp (Date.now() + duration_ms), so closing the
 * tab or fast-forwarding game time don't accelerate it. Indexed by
 * the TARGET level (1..STAFF_UPGRADE_MAX). */
const TRAINING_HOURS_BY_TARGET_LEVEL: Record<number, number> = {
  1: 3,
  2: 6,
  3: 12,
  4: 24,
  5: 48,
};
export function getTrainingDurationHours(targetLevel: number): number {
  return TRAINING_HOURS_BY_TARGET_LEVEL[targetLevel] ?? 3;
}
/** Training duration in milliseconds — what startMemberTraining adds
 * to Date.now() to compute the deadline. */
export function getTrainingDurationMs(targetLevel: number): number {
  return getTrainingDurationHours(targetLevel) * 3600 * 1000;
}

export class StaffSystem {
  /** Source of truth — one record per hired staff member. Aggregate
   * {@link HiredStaff} counts and the legacy per-role multipliers are
   * derived from this list. Each member has their own
   * `upgradeLevel`, so the player trains an individual instead of
   * buffing the whole role. */
  private members: HiredStaffMember[] = [];
  private pendingStaffFirings: Record<StaffRole, number> = { chef: 0, waiter: 0, errand: 0, barman: 0 };
  private lastSalaryChargeAt = 0;
  private salaryRemainder = 0;
  /** Monotonic counter for generating unique member ids within a
   * session. The persisted ids are namespaced by session timestamp,
   * but within one session this avoids collisions when the player
   * hire/fires rapidly. */
  private nextMemberCounter = 1;

  // === Headcount ===

  /** Aggregate counts in the legacy {@link HiredStaff} shape — used by
   * the save snapshot for back-compat with older clients. The
   * {@link members} list is the real source. */
  getStaff(): HiredStaff {
    return {
      chefs: this.getStaffCount("chef"),
      waiters: this.getStaffCount("waiter"),
      errandBoys: this.getStaffCount("errand"),
    };
  }

  getStaffCount(role: StaffRole): number {
    let n = 0;
    for (const m of this.members) if (m.role === role) n += 1;
    return n;
  }

  getTotalStaff(): number {
    return this.members.length;
  }

  /** Read-only view of every hired member. */
  getMembers(role?: StaffRole): readonly HiredStaffMember[] {
    if (!role) return this.members;
    return this.members.filter((m) => m.role === role);
  }

  /** Storey the member calls home. Defaults to 0 (ground floor) when
   * unset — matches the legacy single-storey behaviour. */
  getMemberHomeFloor(id: string): number {
    return this.getMember(id)?.homeFloor ?? 0;
  }

  /** Reassign a member to a new home floor. Returns true if changed.
   * Caller (Engine) is responsible for visually relocating the
   * AnimatedCharacter to the new floor's home position. */
  setMemberHomeFloor(id: string, floor: number): boolean {
    const m = this.getMember(id);
    if (!m) return false;
    const clamped = Math.max(0, Math.floor(floor));
    if ((m.homeFloor ?? 0) === clamped) return false;
    if (clamped === 0) delete m.homeFloor;
    else m.homeFloor = clamped;
    return true;
  }

  getMember(id: string): HiredStaffMember | undefined {
    return this.members.find((m) => m.id === id);
  }

  getPendingFirings(role: StaffRole): number {
    return this.pendingStaffFirings[role];
  }

  /** Append a fresh staff member to the roster. Returns the new
   * record (id + auto-generated name + level 0). Caller does NOT need
   * to track the index — they should hold the returned member's id
   * for any per-member operation. */
  addStaff(role: StaffRole): HiredStaffMember {
    const member: HiredStaffMember = {
      id: makeMemberId(role, this.nextMemberCounter++),
      role,
      name: randomStaffName(),
      upgradeLevel: 0,
    };
    this.members.push(member);
    return member;
  }

  /** Remove the most recently hired member of the role (matches the
   * old "last in, first out" behaviour the routers + Engine assume).
   * Returns the removed record or null. */
  removeStaff(role: StaffRole): HiredStaffMember | null {
    for (let i = this.members.length - 1; i >= 0; i -= 1) {
      if (this.members[i].role === role) {
        return this.members.splice(i, 1)[0];
      }
    }
    return null;
  }

  /** Remove a specific member by id. Used by hire-cancel / fire-by-id
   * paths if/when the UI lets the player target individuals. */
  removeStaffById(id: string): HiredStaffMember | null {
    const i = this.members.findIndex((m) => m.id === id);
    if (i < 0) return null;
    return this.members.splice(i, 1)[0];
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
    const baseCost =
      role === "chef" ? chefHireCost :
      role === "waiter" ? waiterHireCost :
      role === "barman" ? barmanHireCost :
      errandHireCost;
    const currentCount = this.getStaffCount(role);
    return roundStaffMoney(baseCost * (1 + currentCount * 0.1));
  }

  getStaffFireCost(role: StaffRole): number {
    return (
      role === "chef" ? chefFireCost :
      role === "waiter" ? waiterFireCost :
      role === "barman" ? barmanFireCost :
      errandFireCost
    );
  }

  // === Training upgrades — per member ===

  /** Training level of a specific staff member (0..STAFF_UPGRADE_MAX). */
  getMemberUpgradeLevel(id: string): number {
    return this.getMember(id)?.upgradeLevel ?? 0;
  }

  /** Cost to move THIS member from their current level to the next.
   * Quadruples per level — late-game training is a serious
   * investment. Base $500, so the full ladder is:
   *   L0 → L1: $500
   *   L1 → L2: $2,000
   *   L2 → L3: $8,000
   *   L3 → L4: $32,000
   *   L4 → L5: $128,000
   *   Total: $170,500 to fully max one member. */
  getMemberUpgradeCost(id: string): number {
    const level = this.getMemberUpgradeLevel(id);
    if (level >= STAFF_UPGRADE_MAX) return 0;
    return 500 * Math.pow(4, level);
  }

  /** True if the member is currently training toward their next
   * level. */
  isMemberTraining(id: string): boolean {
    return typeof this.getMember(id)?.trainingCompletesAt === "number";
  }

  /** True if ANY member of the restaurant is currently training. The
   * training school only has one chair — only one staff member can
   * be off-shift studying at a time. Returns the id of that member
   * so callers can show "{name} is studying" in disabled rows. */
  getCurrentlyTrainingMemberId(): string | null {
    for (const m of this.members) {
      if (typeof m.trainingCompletesAt === "number") return m.id;
    }
    return null;
  }
  isAnyMemberTraining(): boolean {
    return this.getCurrentlyTrainingMemberId() !== null;
  }

  /** Wall-clock timestamp (ms since epoch) at which the current
   * training will complete, or null when the member isn't training.
   * Lives on the wall clock so closing the tab, pausing, or fast-
   * forwarding in-game time don't shorten the deadline. */
  getMemberTrainingCompletesAt(id: string): number | null {
    const m = this.getMember(id);
    return typeof m?.trainingCompletesAt === "number" ? m.trainingCompletesAt : null;
  }

  /** Start training one member toward their next level. Sets the
   * deadline to {@link Date.now} + duration in MS. Returns true when
   * the timer actually started. */
  startMemberTraining(id: string): boolean {
    const m = this.getMember(id);
    if (!m || m.upgradeLevel >= STAFF_UPGRADE_MAX) return false;
    if (typeof m.trainingCompletesAt === "number") return false; // already training
    const targetLevel = m.upgradeLevel + 1;
    m.trainingCompletesAt = Date.now() + getTrainingDurationMs(targetLevel);
    return true;
  }

  /** Cancel any in-flight training on this member (does NOT refund
   * money). */
  cancelMemberTraining(id: string): boolean {
    const m = this.getMember(id);
    if (!m || typeof m.trainingCompletesAt !== "number") return false;
    delete m.trainingCompletesAt;
    return true;
  }

  /** Advance every member's training clock against the wall clock.
   * Completes any whose Date.now() deadline has passed (their level
   * ticks up). Called once per Game tick. Returns the list of
   * members who just completed a level so the caller can pop UI
   * confirmations. */
  tickTraining(): HiredStaffMember[] {
    const completed: HiredStaffMember[] = [];
    const now = Date.now();
    for (const m of this.members) {
      if (typeof m.trainingCompletesAt !== "number") continue;
      if (now >= m.trainingCompletesAt) {
        m.upgradeLevel = Math.min(STAFF_UPGRADE_MAX, m.upgradeLevel + 1);
        delete m.trainingCompletesAt;
        completed.push(m);
      }
    }
    return completed;
  }

  /** Revert one member one level (used by dev tools / refunds). Also
   * cancels any in-flight training. No money side-effect — caller
   * chooses whether to credit anything. */
  demoteMember(id: string): boolean {
    const m = this.getMember(id);
    if (!m) return false;
    let changed = false;
    if (typeof m.trainingCompletesAt === "number") {
      delete m.trainingCompletesAt;
      changed = true;
    }
    if (m.upgradeLevel > 0) {
      m.upgradeLevel -= 1;
      changed = true;
    }
    return changed;
  }

  /** Admin / dev-tool: bump a member's upgradeLevel by `delta`
   * (positive promotes, negative demotes). Clamped to [0, MAX].
   * Cancels any in-flight training so the deadline doesn't fire on a
   * level the player no longer holds. No cost. */
  adminAdjustLevel(id: string, delta: number): boolean {
    const m = this.getMember(id);
    if (!m) return false;
    if (typeof m.trainingCompletesAt === "number") delete m.trainingCompletesAt;
    const target = Math.max(0, Math.min(STAFF_UPGRADE_MAX, m.upgradeLevel + delta));
    if (target === m.upgradeLevel) return false;
    m.upgradeLevel = target;
    return true;
  }

  // === Per-member effect multipliers ===

  /** Chef cook-time multiplier for a SPECIFIC chef. Recipe prep
   * times are multiplied by this — lower is faster. Returns 1 when
   * the id is unknown. */
  getChefCookMultiplier(id: string): number {
    const level = this.getMemberUpgradeLevel(id);
    return Math.max(0.1, 1 - 0.10 * level);
  }

  /** Waiter walk-speed multiplier for a SPECIFIC waiter. Higher =
   * faster. */
  getWaiterSpeedMultiplier(id: string): number {
    return 1 + 0.10 * this.getMemberUpgradeLevel(id);
  }

  /** Per-trip carry capacity in units. The auto-shop dispatcher reads
   * the MAX across all helpers, since any of them might pick up the
   * trip and we want training on at least one helper to lift the cap.
   * Base 10 + 2 per training level on the best-trained helper. */
  getHelperCarryCapacity(): number {
    let best = 0;
    for (const m of this.members) if (m.role === "errand") best = Math.max(best, m.upgradeLevel);
    return 10 + 2 * best;
  }

  /** Ensure the roster has at least the given headcount for each
   * role. Used on a fresh game / save load — the world always spawns
   * 1 base chef + 1 base waiter + 1 base errand helper, so the
   * StaffSystem needs matching members for those to attach training
   * to. Returns the newly created members (empty if no padding was
   * needed). */
  ensureBaseHeadcount(counts: Record<StaffRole, number>): HiredStaffMember[] {
    const added: HiredStaffMember[] = [];
    for (const role of ["chef", "waiter", "errand"] as StaffRole[]) {
      while (this.getStaffCount(role) < counts[role]) {
        added.push(this.addStaff(role));
      }
    }
    return added;
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
    // Per-member payroll = base + upgradeLevel ($1/min per level).
    // A fully-trained (L5) member costs base+5/min; a fresh L0 hire
    // costs exactly base. Summing across the roster is the same cost
    // as before for an all-L0 crew, with training fees layered on
    // top — the player pays for the productivity boost.
    const totalPayroll = this.getTotalPayrollPerMinute(payrollPerStaffPerMinute);
    const due = this.salaryRemainder + (totalPayroll * elapsedMs) / 60000;
    const charge = Math.floor(due);
    this.salaryRemainder = due - charge;
    return { charge };
  }

  /** Sum of every hired member's per-minute wage = base × headcount +
   * total training levels. Used by tickSalary for the charge and by
   * Hud / StaffPanel for the on-screen totals so the numbers match. */
  getTotalPayrollPerMinute(basePerStaff: number): number {
    let total = 0;
    for (const m of this.members) {
      total += basePerStaff + (m.upgradeLevel ?? 0);
    }
    return total;
  }

  /** Per-role payroll/min — same formula, restricted to one role.
   * StaffPanel's per-row "$X/min" badge sums this so a row with
   * trained members shows the higher cost honestly instead of
   * displaying flat base × count. */
  getRolePayrollPerMinute(role: StaffRole, basePerStaff: number): number {
    let total = 0;
    for (const m of this.members) {
      if (m.role !== role) continue;
      total += basePerStaff + (m.upgradeLevel ?? 0);
    }
    return total;
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
    if (role === "barman") return "Barman";
    return "Errand helper";
  }

  // === Save/load ===

  hydrate(save: SaveGameState | null | undefined): void {
    this.members = [];
    this.nextMemberCounter = 1;
    if (save?.staffMembers && Array.isArray(save.staffMembers)) {
      // Modern save — rebuild the roster exactly.
      for (const m of save.staffMembers) {
        if (m && typeof m.id === "string" && (m.role === "chef" || m.role === "waiter" || m.role === "errand")) {
          const restored: HiredStaffMember = {
            id: m.id,
            role: m.role,
            name: typeof m.name === "string" && m.name.length > 0 ? m.name : randomStaffName(),
            upgradeLevel: clampLevel(m.upgradeLevel),
          };
          if (typeof m.trainingCompletesAt === "number" && Number.isFinite(m.trainingCompletesAt)) {
            restored.trainingCompletesAt = m.trainingCompletesAt;
          }
          // homeFloor missing on legacy saves → default to 0 (ground).
          if (typeof m.homeFloor === "number" && Number.isInteger(m.homeFloor) && m.homeFloor >= 0) {
            restored.homeFloor = m.homeFloor;
          }
          this.members.push(restored);
        }
      }
    } else {
      // Legacy save — generate members from the per-role counts and
      // apply the legacy per-role staffUpgrades level to every member
      // of that role (best we can do without per-member history).
      // Legacy save format only counted chef/waiter/errand. Barman is
      // a new role — saves never have a barman count, so default to 0;
      // the player hires one fresh in the new session.
      const counts: Record<StaffRole, number> = {
        chef: save?.staff?.chefs ?? 0,
        waiter: save?.staff?.waiters ?? 0,
        errand: save?.staff?.errandBoys ?? 0,
        barman: 0,
      };
      const legacyLevels: Record<StaffRole, number> = {
        chef: clampLevel(save?.staffUpgrades?.chef),
        waiter: clampLevel(save?.staffUpgrades?.waiter),
        errand: clampLevel(save?.staffUpgrades?.errand),
        barman: 0,
      };
      for (const role of ["chef", "waiter", "errand", "barman"] as StaffRole[]) {
        for (let i = 0; i < counts[role]; i += 1) {
          const m = this.addStaff(role);
          m.upgradeLevel = legacyLevels[role];
        }
      }
    }
    this.pendingStaffFirings = { chef: 0, waiter: 0, errand: 0, barman: 0 };
    this.resetSalaryTick();
  }

  /** Snapshot members for save. */
  snapshotMembers(): HiredStaffMember[] {
    return this.members.map((m) => ({ ...m }));
  }
}

function clampLevel(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(STAFF_UPGRADE_MAX, Math.floor(v)));
}

function makeMemberId(role: StaffRole, counter: number): string {
  // Encode the role for readability and add a session-local seed so
  // multiple sessions writing to the same cloud slot don't collide.
  const stamp = Date.now().toString(36);
  return `${role}-${stamp}-${counter}`;
}

/** Pure helper: round payroll/hire costs up to the nearest $5, minimum $1. */
function roundStaffMoney(amount: number): number {
  return Math.max(1, Math.ceil(amount / 5) * 5);
}
