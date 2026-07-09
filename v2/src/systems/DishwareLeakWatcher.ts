/**
 * Background watchdog for the dishware inventory.
 *
 * The user reported plates + glasses slowly disappearing over long
 * sessions. We fixed three known leak paths (table sold under a
 * seated guest, fired waiter mid-carry, safety net in despawnGuest),
 * but the user wanted a guard against any FUTURE leak slipping through
 * unnoticed.
 *
 * Model:
 *   expected = dishware.getLifetimeAdded()
 *     Monotonically grows on starter stock + buy. Never decreases in
 *     v1 — there's no admin-sell action. hydrate re-baselines after
 *     a save load.
 *
 *   actual = dishware.getOwned(plate) + dishware.getOwned(glass) +
 *            spawner.getInFlightDishCount()
 *     Sums the persistent pool counts PLUS plates currently held by
 *     guests as reservations (clean-decremented at beginNextCourse,
 *     not yet marked dirty or returned). Without the in-flight term
 *     the watcher would false-positive every time a guest is mid-meal.
 *
 * When actual < expected, a piece of dishware has gone missing. We
 * print the ring buffer of recent mutations + context events so the
 * developer can pinpoint which code path dropped it. To avoid log
 * spam we only print when the deficit GROWS — a repeated identical
 * deficit fires once.
 *
 * Cost: one closure call per dishware mutation while logger is on,
 * one tick + four .get() calls + a comparison every second. Cheap
 * enough to leave on in development; gated behind enable() so a
 * release build can disable it with a single line.
 */

import type { DishwareSystem } from "./DishwareSystem";

/** Engine implements this so the watcher can read the in-flight
 * reservation total without circular-importing GuestSpawner. */
export interface InFlightSource {
  getInFlightDishCount(): number;
  /** The in-flight dish list WITH per-piece tiers (dishes held by eating
   * guests / on a waiter's tray) — the same snapshot the manual Restore
   * button reads. The gated auto-restore hands it to reconcileToLifetime
   * so each leaked TIER is restored to its own canonical count, not
   * dumped at tier 1. */
  getInFlightList(): ReadonlyArray<{ kind: string; tier: number; count: number }>;
}

const MAX_LOG_ENTRIES = 80;

// === Gated auto-restore tuning ===
// The historical duping bug came from auto-restoring at the WRONG time —
// during hydrate, before the in-flight bucket was reconstructed, so it
// "restored" dishes that were merely out on tables and then double-counted
// when they came back. These gates make the auto path only ever act on a
// genuine, settled loss:
//   • never within BOOT_SETTLE of construction (boot sync / in-flight
//     reconstruction finishes first);
//   • only after the deficit has stayed positive AND within a ±TOLERANCE
//     band for STABLE_CHECKS consecutive one-second checks (a transient —
//     a dish mid-transition — clears in a check or two and never qualifies).
// Combined with restoreLeaksOnly's top-up-only guarantee, a misfire can at
// worst add a recoverable piece, never delete a real one.
const AUTO_RESTORE_BOOT_SETTLE_MS = 30_000;
const AUTO_RESTORE_STABLE_CHECKS = 15;
const AUTO_RESTORE_TOLERANCE = 2;

export class DishwareLeakWatcher {
  private readonly dishware: DishwareSystem;
  private readonly inFlightSource: InFlightSource;
  private readonly log: string[] = [];
  private lastReportedDeficit = 0;
  /** Seconds since the last check tick. The watcher fires once per
   * second to keep console output sparse without missing rapid leaks. */
  private accumulator = 0;
  /** Wall-clock at construction — every log entry timestamps relative
   * to this so the report reads as "T+5.2s, T+5.3s, …" instead of
   * absolute performance.now() noise. */
  private readonly startMs = performance.now();
  private enabled = true;
  /** Auto-restore kill-switch (default on). If a future bug ever makes
   * the gated restore misbehave, one call to enableAutoRestore(false)
   * reverts to log-only / manual-button behaviour without a rebuild. */
  private autoRestore = true;
  /** Consecutive one-second checks the deficit has stayed positive, plus
   * the min / max seen in that window — the stability gate. Reset the
   * moment the deficit clears or wobbles beyond tolerance. */
  private posSecs = 0;
  private windowMin = 0;
  private windowMax = 0;

  constructor(dishware: DishwareSystem, inFlightSource: InFlightSource) {
    this.dishware = dishware;
    this.inFlightSource = inFlightSource;
  }

  /** Toggle the gated auto-restore (default on). Off = log-only, the
   * player restores via the manual button as before. */
  enableAutoRestore(on: boolean): void {
    this.autoRestore = on;
    if (!on) this.posSecs = 0;
  }

  /** Gated, top-up-only auto-recovery. Returns true if it restored this
   * tick (caller then skips the leak log + re-baselines). Only fires
   * once a positive deficit has held stable past boot-settle — see the
   * AUTO_RESTORE_* gate docs. */
  private maybeAutoRestore(deficit: number): boolean {
    const settled = performance.now() - this.startMs > AUTO_RESTORE_BOOT_SETTLE_MS;
    if (!this.autoRestore || deficit <= 0 || !settled) {
      this.posSecs = 0;
      return false;
    }
    if (this.posSecs === 0) {
      this.windowMin = deficit;
      this.windowMax = deficit;
    } else {
      this.windowMin = Math.min(this.windowMin, deficit);
      this.windowMax = Math.max(this.windowMax, deficit);
    }
    this.posSecs += 1;
    const stable = this.windowMax - this.windowMin <= AUTO_RESTORE_TOLERANCE;
    if (this.posSecs < AUTO_RESTORE_STABLE_CHECKS || !stable || this.windowMin <= 0) {
      return false;
    }
    const result = this.dishware.reconcileToLifetime(this.inFlightSource.getInFlightList());
    // eslint-disable-next-line no-console
    console.info(
      `[Dishware] auto-reconciled after a stable deficit (~${this.windowMin}) held ` +
      `${this.posSecs}s — restored ${result.restored}, trimmed ${result.trimmed} (canonical per-tier).`,
    );
    this.posSecs = 0;
    return result.restored > 0 || result.trimmed > 0;
  }

  /** Off / on toggle. Disabled watchers are inert — record() is a
   * no-op and check() returns immediately. Engine leaves it on in
   * development. */
  enable(on: boolean): void {
    this.enabled = on;
  }

  /** Push one entry into the ring buffer. Called from the per-mutation
   * logger hooks on DishwareSystem / GuestSpawner / StaffRouter. Buffer
   * caps at MAX_LOG_ENTRIES so a long session doesn't accumulate
   * unbounded memory. */
  record(msg: string): void {
    if (!this.enabled) return;
    const t = ((performance.now() - this.startMs) / 1000).toFixed(2);
    this.log.push(`T+${t}s  ${msg}`);
    if (this.log.length > MAX_LOG_ENTRIES) this.log.shift();
  }

  /** Engine ticks this every frame with `dt` so the watcher amortises
   * the actual diff to once per second. Returns the deficit (>0 when
   * a leak was newly detected this tick, 0 otherwise) — caller can
   * surface it in dev-tools UI if they want a live banner. */
  tick(dt: number): number {
    if (!this.enabled) return 0;
    this.accumulator += dt;
    if (this.accumulator < 1.0) return 0;
    this.accumulator = 0;
    return this.checkOnce();
  }

  /** Force an immediate check. Useful from a dev-tools button. */
  checkOnce(): number {
    if (!this.enabled) return 0;
    const expected = this.dishware.getLifetimeAdded();
    const owned = this.dishware.getOwned("plate") + this.dishware.getOwned("glass");
    const inFlight = this.inFlightSource.getInFlightDishCount();
    const actual = owned + inFlight;
    const deficit = expected - actual;
    // Gated, top-up-only auto-recovery. If it restored this tick, skip
    // the leak log below and re-baseline so a fresh future leak still
    // reports (and can be auto-restored again).
    if (this.maybeAutoRestore(deficit)) {
      this.lastReportedDeficit = 0;
      return 0;
    }
    if (deficit > this.lastReportedDeficit) {
      // Console output is intentionally one big block so the dev's
      // eye lands on the WARN header and follows the indented action
      // history right below it.
      // eslint-disable-next-line no-console
      console.warn(
        `🚨 DISHWARE LEAK detected\n` +
        `   expected (lifetime): ${expected}\n` +
        `   actual (owned+inflight): ${actual}  (owned ${owned}, inFlight ${inFlight})\n` +
        `   new deficit: ${deficit}  (was ${this.lastReportedDeficit})\n` +
        `   last ${this.log.length} actions:`,
      );
      for (const entry of this.log) {
        // eslint-disable-next-line no-console
        console.warn("  " + entry);
      }
      this.lastReportedDeficit = deficit;
      return deficit;
    } else if (deficit < this.lastReportedDeficit) {
      // Deficit shrank — state recovered (e.g. admin wash) — quietly
      // re-baseline so a future leak only re-reports when it pushes
      // PAST this new low.
      this.lastReportedDeficit = deficit;
    }
    return 0;
  }

  /** Read-only snapshot of the current ring buffer for dev-tools UIs
   * that want to render it without triggering a check. */
  getLog(): readonly string[] {
    return this.log;
  }

  /** Current deficit — call from a dev-tools dashboard for a live
   * gauge. Doesn't print anything. */
  getDeficit(): number {
    const expected = this.dishware.getLifetimeAdded();
    const owned = this.dishware.getOwned("plate") + this.dishware.getOwned("glass");
    const inFlight = this.inFlightSource.getInFlightDishCount();
    return expected - (owned + inFlight);
  }
}
