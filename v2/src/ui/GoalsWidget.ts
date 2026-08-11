/**
 * Patch C — Daily goals card (sidebar). Three rotating goals over the
 * server's own daily counters, a claim button per goal, and the streak
 * line. Targets come from SpacetimeClient.getDailyGoals — the exact
 * client mirror of the server's formula — and every claim is validated
 * server-side (claim_daily_goal), so this card can't mint anything.
 * All three claimed in one day → the server rolls a bonus supply crate.
 */

import type { SpacetimeClient } from "../cloud/SpacetimeClient";
import { showEventBanner } from "./uiHints";

export class GoalsWidget {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly cloud: SpacetimeClient;
  private readonly getDayNumber: () => number;
  /** Slots claimed this session (optimistic, pre-sync). */
  private readonly optimisticClaims = new Set<number>();

  constructor(parent: HTMLElement, cloud: SpacetimeClient, getDayNumber: () => number) {
    this.cloud = cloud;
    this.getDayNumber = getDayNumber;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      background: "rgba(255, 245, 220, 0.06)",
      border: "1px solid rgba(255, 245, 220, 0.14)",
      borderRadius: "8px",
      padding: "8px 10px",
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

  /** ~1 Hz refresh from Engine's UI updater. */
  update(): void {
    if (!this.cloud.hasRestaurantContext()) {
      this.root.style.display = "none";
      return;
    }
    this.root.style.display = "block";
    const day = this.getDayNumber();
    const goals = this.cloud.getDailyGoals(day);
    const state = this.cloud.getDailyGoalState();
    this.body.replaceChildren();
    for (const g of goals) {
      const claimed = g.claimed || this.optimisticClaims.has(g.slot);
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 0",
      } as Partial<CSSStyleDeclaration>);
      const label = document.createElement("span");
      const isMoney = g.slot !== 0;
      const fmt = (v: number): string => isMoney ? `$${Math.floor(v / 100)}` : String(v);
      label.textContent = `${g.icon} ${g.label}`;
      Object.assign(label.style, { flex: "1", opacity: claimed ? "0.55" : "1" } as Partial<CSSStyleDeclaration>);
      const progress = document.createElement("span");
      progress.textContent = claimed ? "✓" : `${fmt(Math.min(g.progress, g.target))}/${fmt(g.target)}`;
      Object.assign(progress.style, {
        fontVariantNumeric: "tabular-nums",
        fontSize: "11px",
        color: claimed ? "#9fe09f" : g.claimable ? "#ffd986" : "rgba(255,245,220,0.65)",
        fontWeight: claimed || g.claimable ? "700" : "400",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(label);
      row.appendChild(progress);
      if (!claimed && g.claimable) {
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
          this.optimisticClaims.add(g.slot);
          this.cloud.claimDailyGoal(g.slot);
          showEventBanner(`Goal complete — +$${g.rewardCents / 100}!`, { icon: "📋", accent: "#9fe09f", ms: 2600 });
          const others = goals.filter((o) => o.slot !== g.slot);
          if (others.every((o) => o.claimed || this.optimisticClaims.has(o.slot))) {
            showEventBanner("All 3 goals done — bonus crate rolled! 🎁", { icon: "🏆", accent: "#ffe08a", ms: 4200 });
          }
          this.update();
        };
        row.appendChild(btn);
      }
      this.body.appendChild(row);
    }
    // New day → the optimistic latch is stale; the server mask resets too.
    if (state && state.dayNumber !== day) this.optimisticClaims.clear();
    if (state && state.streak > 1) {
      const streak = document.createElement("div");
      streak.textContent = `🔥 ${state.streak}-day streak`;
      Object.assign(streak.style, {
        fontSize: "10px",
        opacity: "0.8",
        marginTop: "4px",
        color: "#ffcf9a",
      } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(streak);
    }
  }
}
