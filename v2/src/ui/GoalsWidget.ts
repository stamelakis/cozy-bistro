/**
 * Patch C — Daily goals card (sidebar). Three rotating goals over the
 * server's own daily counters, a claim button per goal, and the streak
 * line. Targets come from SpacetimeClient.getDailyGoals — the exact
 * client mirror of the server's formula — and every claim is validated
 * server-side (claim_daily_goal), so this card can't mint anything.
 * All three claimed in one day → the server rolls a bonus supply crate.
 *
 * Render discipline (the "clunky clicking" fix): the row DOM is PERSISTENT.
 * Progress numbers update in place every tick; the DOM is rebuilt ONLY when
 * the structural state changes (day, claimed mask, claimable flags,
 * streak). The old version replaceChildren()'d ~5×/s, which destroyed the
 * claim button between mousedown and mouseup — clicks randomly ate
 * themselves and the button kept reappearing before the server row synced.
 */

import type { SpacetimeClient } from "../cloud/SpacetimeClient";
import { showEventBanner } from "./uiHints";

export class GoalsWidget {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly cloud: SpacetimeClient;
  private readonly getDayNumber: () => number;
  /** Slots claimed this session (optimistic, pre-sync) — keyed to a day. */
  private optimisticClaims = new Set<number>();
  private optimisticDay = -1;
  /** Structural signature of the last full rebuild. */
  private lastSig = "";
  /** Live refs for in-place progress updates (index = slot). */
  private progressEls: HTMLElement[] = [];

  constructor(parent: HTMLElement, cloud: SpacetimeClient, getDayNumber: () => number) {
    this.cloud = cloud;
    this.getDayNumber = getDayNumber;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      background: "rgba(255, 245, 220, 0.06)",
      border: "1px solid rgba(255, 245, 220, 0.14)",
      borderRadius: "8px",
      padding: "8px 10px",
      // Breathing room from the ExpandWidget's crate button above — the
      // cards were kissing.
      marginTop: "8px",
      marginBottom: "8px",
      font: "12px/1.4 system-ui, sans-serif",
      color: "#fff5dc",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "📋 DAILY GOALS";
    Object.assign(title.style, {
      fontSize: "10px",
      fontWeight: "700",
      letterSpacing: "0.06em",
      opacity: "0.75",
      marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(title);
    this.body = document.createElement("div");
    this.root.appendChild(this.body);
    parent.appendChild(this.root);
  }

  /** ~5 Hz from Engine's UI updater — cheap: usually just text updates. */
  update(): void {
    if (!this.cloud.hasRestaurantContext()) {
      this.root.style.display = "none";
      return;
    }
    this.root.style.display = "block";
    const day = this.getDayNumber();
    // Optimistic claims are per-day; roll them when the LOCAL day changes
    // (never from a missing server row — that was the multi-collect bug:
    // pre-sync the row reads day -1, which cleared the latch every tick).
    if (day !== this.optimisticDay) {
      this.optimisticDay = day;
      this.optimisticClaims = new Set();
    }
    const goals = this.cloud.getDailyGoals(day);
    const state = this.cloud.getDailyGoalState();
    const streak = state?.streak ?? 0;
    const merged = goals.map((g) => ({
      ...g,
      claimed: g.claimed || this.optimisticClaims.has(g.slot),
    }));
    const sig = `${day}|${streak}|` + merged.map((g) => `${g.claimed ? "c" : g.claimable ? "a" : "-"}:${g.target}`).join("|");
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.rebuild(merged, streak);
    }
    // In-place progress text — no DOM churn, buttons stay clickable.
    for (const g of merged) {
      const el = this.progressEls[g.slot];
      if (el && !g.claimed) {
        el.textContent = g.claimable
          ? "ready!"
          : `${this.fmt(g.slot, Math.min(g.progress, g.target))}/${this.fmt(g.slot, g.target)}`;
      }
    }
  }

  private fmt(slot: number, v: number): string {
    return slot === 0 ? String(v) : `$${Math.floor(v / 100)}`;
  }

  private rebuild(
    goals: Array<{ slot: number; icon: string; label: string; target: number; progress: number; claimed: boolean; claimable: boolean; rewardCents: number }>,
    streak: number,
  ): void {
    this.body.replaceChildren();
    this.progressEls = [];
    for (const g of goals) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 0",
        minHeight: "24px",
      } as Partial<CSSStyleDeclaration>);
      const label = document.createElement("span");
      label.textContent = `${g.icon} ${g.label}`;
      Object.assign(label.style, { flex: "1", opacity: g.claimed ? "0.55" : "1" } as Partial<CSSStyleDeclaration>);
      row.appendChild(label);
      const progress = document.createElement("span");
      Object.assign(progress.style, {
        fontVariantNumeric: "tabular-nums",
        fontSize: "11px",
        color: g.claimed ? "#9fe09f" : g.claimable ? "#ffd986" : "rgba(255,245,220,0.65)",
        fontWeight: g.claimed || g.claimable ? "700" : "400",
      } as Partial<CSSStyleDeclaration>);
      progress.textContent = g.claimed ? "✓" : "";
      this.progressEls[g.slot] = progress;
      row.appendChild(progress);
      if (!g.claimed && g.claimable) {
        const btn = document.createElement("button");
        btn.textContent = `Claim $${g.rewardCents / 100}`;
        Object.assign(btn.style, {
          background: "rgba(120, 200, 120, 0.25)",
          color: "#d8ffd8",
          border: "1px solid rgba(120, 200, 120, 0.55)",
          borderRadius: "5px",
          padding: "2px 8px",
          cursor: "pointer",
          font: "inherit",
          fontSize: "10px",
          fontWeight: "700",
        } as Partial<CSSStyleDeclaration>);
        btn.onclick = () => {
          // Latch + disable IMMEDIATELY — no second click can land even if
          // the next rebuild is a frame away. Server validates + is
          // idempotent per slot regardless.
          if (this.optimisticClaims.has(g.slot)) return;
          this.optimisticClaims.add(g.slot);
          btn.disabled = true;
          btn.style.opacity = "0.5";
          this.cloud.claimDailyGoal(g.slot);
          showEventBanner(`Goal complete — +$${g.rewardCents / 100}!`, { icon: "📋", accent: "#9fe09f", ms: 2600 });
          if (goals.filter((o) => o.slot !== g.slot).every((o) => o.claimed || this.optimisticClaims.has(o.slot))) {
            showEventBanner("All 3 goals done — bonus crate rolled! 🎁", { icon: "🏆", accent: "#ffe08a", ms: 4200 });
          }
          this.lastSig = ""; // force a clean rebuild next tick
        };
        row.appendChild(btn);
      }
      this.body.appendChild(row);
    }
    if (streak > 1) {
      const streakEl = document.createElement("div");
      streakEl.textContent = `🔥 ${streak}-day streak`;
      Object.assign(streakEl.style, {
        fontSize: "10px",
        opacity: "0.8",
        marginTop: "4px",
        color: "#ffcf9a",
      } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(streakEl);
    }
  }
}
