import type { SaveGameState } from "../data/types";

/** A rent cycle covers one in-game day (24h). */
export const rentIntervalSeconds = 24 * 60 * 60;

/** Phase 9.51 — named time-of-day phases, keyed to the same windows
 * WorldScene.applyDayNight uses for the lighting (dawn 0–.083, daylight
 * .083–.583, dusk .583–.667, night .667–1). `start` is the lower bound
 * of the phase's progress range; `setTo` is the progress an admin
 * "jump to this phase" control lands on — mid-phase, so the lighting
 * reads unambiguously as that time of day. */
export interface DayPhase {
  key: string;
  label: string;
  icon: string;
  start: number;
  setTo: number;
}
export const DAY_PHASES: readonly DayPhase[] = [
  { key: "dawn", label: "Dawn", icon: "🌅", start: 0.0, setTo: 0.04 },
  { key: "morning", label: "Morning", icon: "🌤️", start: 0.083, setTo: 0.2 },
  { key: "day", label: "Day", icon: "☀️", start: 0.33, setTo: 0.45 },
  { key: "dusk", label: "Dusk", icon: "🌇", start: 0.583, setTo: 0.625 },
  { key: "night", label: "Night", icon: "🌙", start: 0.667, setTo: 0.83 },
];

/** Which {@link DayPhase} a given [0,1) day progress falls in. Wraps
 * out-of-range input so callers don't have to pre-clamp. */
export function phaseForProgress(progress: number): DayPhase {
  const p = (((progress % 1) + 1) % 1);
  let cur = DAY_PHASES[0];
  for (const ph of DAY_PHASES) {
    if (p >= ph.start) cur = ph;
  }
  return cur;
}

export interface DayCycleTickResult {
  /** True on the frame where the in-game day timer crosses dayLengthSeconds. */
  dayEnded: boolean;
}

/**
 * Owns time accumulators: day timer, total playtime, and the rent-cycle clock.
 *
 * The scene calls {@link tick} once per frame with the frame delta and gets back a
 * `dayEnded` signal it can use to roll the day over. The scene also calls
 * {@link consumePendingRentPeriods} once per frame to collect any whole rent
 * intervals that have elapsed and apply the corresponding money charge itself.
 *
 * Rent money + day-rollover side effects (resetting daily totals across systems,
 * incrementing dayNumber, etc.) are intentionally not done here — the scene
 * coordinates those because they touch other systems.
 */
export class DayCycleSystem {
  private dayNumber: number;
  private elapsedSeconds = 0;
  private readonly dayLengthSeconds: number;
  private rentElapsedSeconds = 0;
  private totalPlaySeconds = 0;

  // 720 sec = 12 real minutes for one full 24h game-day. Matches the
  // applyDayNight schedule: 8h night + 4h dawn/dusk + 12h day = 24h.
  constructor(dayNumber = 1, dayLengthSeconds = 720) {
    this.dayNumber = dayNumber;
    this.dayLengthSeconds = dayLengthSeconds;
  }

  /** Advance all accumulators by `deltaSeconds`. Returns whether the day timer crossed its threshold this frame. */
  tick(deltaSeconds: number): DayCycleTickResult {
    this.elapsedSeconds += deltaSeconds;
    this.totalPlaySeconds += deltaSeconds;
    this.rentElapsedSeconds += deltaSeconds;
    return { dayEnded: this.elapsedSeconds >= this.dayLengthSeconds };
  }

  getDayNumber(): number {
    return this.dayNumber;
  }

  getTimeRemainingSeconds(): number {
    return Math.max(0, this.dayLengthSeconds - this.elapsedSeconds);
  }

  /** Day progress in [0, 1]. 0 = just rolled over (dawn), 0.5 = noon,
   * 1 = day ending (dusk into night). Engine uses this to drive the
   * sun-color / ambient-light day-night cycle. */
  getDayProgress(): number {
    return Math.max(0, Math.min(1, this.elapsedSeconds / this.dayLengthSeconds));
  }

  setDayNumber(dayNumber: number): void {
    this.dayNumber = dayNumber;
  }

  /** Phase 9.39 — adopt an authoritative within-day elapsed time (e.g.
   * the server's day_elapsed_ms on reload) so the day/night lighting
   * resumes at the correct TIME OF DAY instead of snapping back to dawn.
   * Clamped into [0, dayLength) so a value the server already rolled
   * over doesn't read as a finished day. */
  setElapsedSeconds(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    this.elapsedSeconds = Math.max(0, Math.min(this.dayLengthSeconds - 0.001, seconds));
  }

  /** Real-time length of one in-game day, in seconds. */
  getDayLengthSeconds(): number {
    return this.dayLengthSeconds;
  }

  /** Phase 9.51 — admin time-of-day control: jump the day clock to a
   * fractional progress in [0,1). The next Engine frame feeds this
   * through applyDayNight (lamps, pavement lights, sun + shadows) and
   * sfx.setDayProgress (music), so a single call retimes the whole
   * scene. Returns the new within-day elapsed time in ms so the caller
   * can push it to the server (syncDayClock) and make the jump stick. */
  setProgress(progress01: number): number {
    const p = Math.max(0, Math.min(0.9999, progress01));
    this.setElapsedSeconds(p * this.dayLengthSeconds);
    return Math.round(this.elapsedSeconds * 1000);
  }

  /**
   * Reset the day timer and advance the day counter by 1. The scene should call this
   * after handling a `dayEnded` signal from {@link tick}; if it doesn't, subsequent
   * ticks will keep returning `dayEnded: true` until rollover is performed.
   */
  rollOverDay(): void {
    this.elapsedSeconds = 0;
    this.dayNumber += 1;
  }

  getTotalPlaySeconds(): number {
    return this.totalPlaySeconds;
  }

  getRentElapsedSeconds(): number {
    return this.rentElapsedSeconds;
  }

  getRentHoursRemaining(intervalSeconds = rentIntervalSeconds): number {
    return Math.max(0, (intervalSeconds - this.rentElapsedSeconds) / 3600);
  }

  /**
   * Returns the number of full rent intervals that have elapsed since the last
   * call, and rolls the rent accumulator forward (mod interval). Returns 0
   * when no full period has elapsed — callers should bail early in that case.
   */
  consumePendingRentPeriods(intervalSeconds = rentIntervalSeconds): number {
    if (this.rentElapsedSeconds < intervalSeconds) {
      return 0;
    }
    const periodsDue = Math.floor(this.rentElapsedSeconds / intervalSeconds);
    this.rentElapsedSeconds %= intervalSeconds;
    return periodsDue;
  }

  /** Restore time accumulators from a save snapshot. Includes dayNumber —
   * without this, every reload showed "Day 1" even after the player had
   * advanced. (elapsedSeconds isn't persisted yet because the save schema
   * doesn't carry it; days roll over silently within a session and that's
   * acceptable.) */
  hydrate(save: SaveGameState | null | undefined): void {
    if (typeof save?.dayNumber === "number" && save.dayNumber >= 1) {
      this.dayNumber = Math.floor(save.dayNumber);
    }
    this.rentElapsedSeconds = save?.rentElapsedSeconds ?? 0;
    this.totalPlaySeconds = save?.totalPlaySeconds ?? 0;
  }
}
