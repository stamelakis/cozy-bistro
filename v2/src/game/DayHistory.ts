/**
 * Append-only ring buffer of daily summaries. Game pushes one record
 * per day on rollover; the StatsModal reads back the last N entries to
 * render trend lines / bar charts.
 *
 * Cap at MAX_DAYS to keep saves bounded. Older entries are dropped.
 */

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

  push(record: DayRecord): void {
    this.days.push(record);
    if (this.days.length > MAX_DAYS) {
      this.days = this.days.slice(-MAX_DAYS);
    }
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
