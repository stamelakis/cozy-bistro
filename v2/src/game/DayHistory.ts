/**
 * Append-only ring buffer of daily summaries. Game pushes one record
 * per day on rollover; the StatsModal reads back the last N entries to
 * render trend lines / bar charts.
 *
 * Cap at MAX_DAYS to keep saves bounded. Older entries are dropped.
 */

import { isServerSim } from "./featureFlags";

const MAX_DAYS = 60;

export interface DayRecord {
  dayNumber: number;
  served: number;
  lost: number;
  revenue: number;
  expenses: number;
  net: number;
  rating: number;
  /** Weather emoji + label saved with the day for the recap. */
  weatherEmoji: string;
  weatherLabel: string;
}

export class DayHistory {
  private days: DayRecord[] = [];

  /** Phase I.5 (H.63) — cloud handle for mirroring the ring buffer
   * on every day rollover.  Engine wires this on connect.  Low
   * frequency (1 push per 12-min game day) so we push synchronously
   * in `push` rather than batching. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;

  push(record: DayRecord): void {
    this.days.push(record);
    if (this.days.length > MAX_DAYS) {
      this.days = this.days.slice(-MAX_DAYS);
    }
    // H.63 — mirror to cloud.  Server idempotency makes repeat-on-
    // re-rollover safe.
    //
    // Path B — when the server sim owns the restaurant, the server's
    // tick_day_clock appends one record per rollover itself and is
    // the SOLE writer of cloud_day_history_json (that's what gives
    // offline days real numbers in Daily Trends). The client only
    // ADOPTS: live via the restaurant.onUpdate diff in
    // SpacetimeClient + once at boot via the Engine retry loop.
    // Pushing the local ring buffer too would overwrite server-
    // appended offline records. Same isServerSim gate style as
    // CookingSystem.consumeIngredients.
    if (this.cloud && !isServerSim("guests")) {
      this.cloud.setCloudDayHistory(this.days);
    }
  }

  /** Phase I.5 (H.63) — Override local history from a cloud snapshot.
   * Engine calls on subscription ready; cloud wins when populated. */
  applyCloudSnapshot(raw: unknown[]): void {
    const parsed: DayRecord[] = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const e = r as Partial<DayRecord>;
      if (typeof e.dayNumber !== "number") continue;
      parsed.push({
        dayNumber: e.dayNumber,
        served: Number(e.served) || 0,
        lost: Number(e.lost) || 0,
        revenue: Number(e.revenue) || 0,
        expenses: Number(e.expenses) || 0,
        net: Number(e.net) || 0,
        rating: Number(e.rating) || 0,
        weatherEmoji: String(e.weatherEmoji ?? ""),
        weatherLabel: String(e.weatherLabel ?? ""),
      });
    }
    this.days = parsed.slice(-MAX_DAYS);
  }

  /** Get the last N records (newest last). */
  recent(n = MAX_DAYS): DayRecord[] {
    return this.days.slice(-n);
  }

  count(): number {
    return this.days.length;
  }

  /** For save snapshot. */
  snapshot(): DayRecord[] {
    return this.days.slice();
  }

  hydrate(records?: DayRecord[]): void {
    this.days = (records ?? []).slice(-MAX_DAYS);
  }
}
