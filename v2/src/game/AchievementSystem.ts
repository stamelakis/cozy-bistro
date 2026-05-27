import type { Game } from "./Game";

/**
 * Lightweight achievement tracker. A small set of hand-tuned milestones
 * that surface progress (first sale, max tier, multi-day survival, etc).
 * Each one has a predicate evaluated periodically against the live Game;
 * on first true it's marked unlocked, fires a callback (toast + chime),
 * and persists to the save.
 */

export interface Achievement {
  id: string;
  name: string;
  description: string;
  /** Returns true once the milestone is reached. */
  predicate: (game: Game) => boolean;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    id: "first-sale",
    name: "Open for Business",
    description: "Earn your first dollar.",
    predicate: (g) => g.economy.getDailyRevenue() > 0 || g.history.recent(1).some((d) => d.revenue > 0),
  },
  {
    id: "five-star",
    name: "Five-Star Service",
    description: "Receive a 5-star rating.",
    predicate: (g) => g.reputation.getRatingHistorySnapshot().includes(5),
  },
  {
    id: "tycoon-1k",
    name: "Pocket Change",
    description: "Reach $1,000 in the till.",
    predicate: (g) => g.economy.getMoney() >= 1000,
  },
  {
    id: "tycoon-5k",
    name: "Tycoon",
    description: "Reach $5,000 in the till.",
    predicate: (g) => g.economy.getMoney() >= 5000,
  },
  {
    id: "max-tier",
    name: "Top of the World",
    description: "Reach the maximum restaurant tier.",
    predicate: (g) => g.getLuxuryTier() >= g.getMaxLuxuryTier(),
  },
  {
    id: "day-7",
    name: "First Week",
    description: "Survive to day 7.",
    predicate: (g) => g.day.getDayNumber() >= 7,
  },
  {
    id: "day-30",
    name: "Bistro Veteran",
    description: "Survive to day 30.",
    predicate: (g) => g.day.getDayNumber() >= 30,
  },
  {
    id: "full-staff",
    name: "Full Brigade",
    description: "Hire at least one of every staff role.",
    predicate: (g) =>
      g.staff.getStaffCount("chef") >= 1 &&
      g.staff.getStaffCount("waiter") >= 1 &&
      g.staff.getStaffCount("errand") >= 1,
  },
  {
    id: "century-served",
    name: "Hundred Plates",
    description: "Serve 100 guests across all time.",
    predicate: (g) => totalServed(g) >= 100,
  },
];

function totalServed(g: Game): number {
  // Today's count + every completed day in history.
  let total = g.customers.getDailyServed();
  for (const d of g.history.recent()) total += d.served;
  return total;
}

export class AchievementSystem {
  private unlocked = new Set<string>();
  private elapsedSinceCheck = 0;
  /** Optional: fired the first time an achievement is unlocked. Engine
   * wires this up to pop a celebratory toast + chime. */
  onUnlock?: (achievement: Achievement) => void;

  /** Returns the snapshot of unlocked ids for save persistence. */
  snapshot(): string[] {
    return Array.from(this.unlocked);
  }

  hydrate(ids?: string[]): void {
    this.unlocked = new Set(ids ?? []);
  }

  isUnlocked(id: string): boolean { return this.unlocked.has(id); }
  count(): number { return this.unlocked.size; }
  total(): number { return ACHIEVEMENTS.length; }

  /** Per-tick check; rate-limited to once a second to keep predicate cost low. */
  update(dt: number, game: Game): void {
    this.elapsedSinceCheck += dt;
    if (this.elapsedSinceCheck < 1) return;
    this.elapsedSinceCheck = 0;
    for (const a of ACHIEVEMENTS) {
      if (this.unlocked.has(a.id)) continue;
      if (a.predicate(game)) {
        this.unlocked.add(a.id);
        this.onUnlock?.(a);
      }
    }
  }
}
