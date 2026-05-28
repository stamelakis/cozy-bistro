import type { Game } from "../game/Game";
import { getIngredientCost } from "../data/ingredients";

/**
 * Compact at-a-glance ingredient status panel that sits above the
 * StaffPanel. Always-visible sections:
 *   - Top summary line (OUT / LOW / below-target / all-good)
 *   - 📋 In Need: every ingredient below the stock target with detail
 *   - 🛒 Auto-shop status + in-transit count
 *   - 🍳 Kitchen ticket pipeline
 *
 * The summary line reflects the worst severity present so the player
 * never sees "✓ All ingredients stocked" while the In Need section
 * underneath lists shortfalls — that contradiction was a real bug.
 */
export class StockStatusWidget {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    // Inline section — Sidebar handles the position/background/padding.
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      font: "11px/1.3 system-ui, sans-serif",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const title = document.createElement("div");
    title.textContent = "📦 STOCK";
    Object.assign(title.style, {
      fontWeight: "700", fontSize: "12px",
      marginBottom: "4px", letterSpacing: "0.04em",
      textAlign: "center", opacity: "0.9",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(title);

    this.body = document.createElement("div");
    this.root.appendChild(this.body);
    this.update();
  }

  update(): void {
    this.body.innerHTML = "";
    const pantry = this.game.cooking.getPantry();
    const target = this.game.getStockTarget();

    // Severity buckets.
    const out = pantry.filter((s) => s.quantity === 0)
      .sort((a, b) => getIngredientCost(b.id) - getIngredientCost(a.id));
    const low = pantry.filter((s) => s.quantity > 0 && s.quantity <= 2)
      .sort((a, b) => a.quantity - b.quantity);
    const usedToday = this.game.cooking.getTotalConsumedToday();

    // Below-target rows — used by both the top summary and the In Need
    // list so they always agree. Inclusion rule is "qty < target" — NOT
    // "qty + pending < target" as it used to be. That older rule caused
    // a real contradiction: an item could be OUT (qty=0) while pending
    // covered the deficit on paper, so the top line correctly screamed
    // "OUT: bread" while In Need said "All at target." The item is
    // still empty on the shelf right now even if a helper is bringing
    // more, so it belongs in the list.
    const needRows: string[] = [];
    for (const s of pantry) {
      if (s.quantity >= target) continue;
      const way = this.game.cooking.getPendingForIngredient(s.id);
      const need = target - s.quantity;
      const wayStr = way > 0 ? `, way ${way}` : "";
      needRows.push(`<div>${s.name}: need ${need} <span style="opacity:0.7">(have ${s.quantity}${wayStr})</span></div>`);
    }

    // === Top summary line (single source of truth) ===
    // Reflects worst severity in the pantry. We used to show "✓ All
    // ingredients stocked" whenever nothing was at qty=0 or qty<=2, but
    // that ignored "below target with errand in flight" cases — leading
    // to a contradiction where the In Need section listed shortfalls
    // while the summary line claimed everything was fine.
    const usedTodaySpan = usedToday > 0
      ? ` <span style="opacity:0.7">· ${usedToday} used today</span>`
      : "";
    const top = document.createElement("div");
    if (out.length > 0) {
      top.innerHTML = `<span style="color:#ff9a9a;font-weight:700">OUT:</span> ${out.slice(0, 6).map((s) => s.name).join(", ")}${out.length > 6 ? ` (+${out.length - 6})` : ""}`;
      Object.assign(top.style, { marginBottom: "3px" } as Partial<CSSStyleDeclaration>);
    } else if (low.length > 0) {
      top.innerHTML = `<span style="color:#ffd47a;font-weight:700">LOW:</span> ${low.slice(0, 6).map((s) => `${s.name}(${s.quantity})`).join(", ")}${low.length > 6 ? ` (+${low.length - 6})` : ""}`;
    } else if (needRows.length > 0) {
      // Nothing critical, but some items below target. Subtle amber so
      // the player knows there's still work for the errand helper.
      top.innerHTML = `<span style="color:#ffd47a">📋 ${needRows.length} item${needRows.length === 1 ? "" : "s"} below target</span>${usedTodaySpan}`;
      Object.assign(top.style, { textAlign: "center", padding: "2px 0" } as Partial<CSSStyleDeclaration>);
    } else {
      top.innerHTML = `✓ All at target${usedTodaySpan}`;
      Object.assign(top.style, { color: "#a8e2a8", textAlign: "center", padding: "2px 0" } as Partial<CSSStyleDeclaration>);
    }
    this.body.appendChild(top);

    // === In Need section (always shown) ===
    this.appendSectionHeader("📋 In Need");
    {
      const list = document.createElement("div");
      Object.assign(list.style, {
        maxHeight: "84px", overflowY: "auto", fontSize: "10px",
      } as Partial<CSSStyleDeclaration>);
      if (needRows.length === 0) {
        list.innerHTML = `<div style="opacity:0.6">All at target.</div>`;
      } else {
        list.innerHTML = needRows.slice(0, 12).join("");
        if (needRows.length > 12) {
          list.innerHTML += `<div style="opacity:0.6">+${needRows.length - 12} more…</div>`;
        }
      }
      this.body.appendChild(list);
    }

    // === Auto-shop + in-transit summary ===
    const auto = document.createElement("div");
    Object.assign(auto.style, {
      fontSize: "10px", marginTop: "5px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    if (this.game.autoShopEnabled) {
      let totalPending = 0;
      const pending = this.game.cooking.getPendingOrdersSnapshot();
      for (const id of Object.keys(pending)) totalPending += pending[id];
      auto.style.opacity = "0.85";
      auto.innerHTML = totalPending > 0
        ? `🛒 Auto-shop ON · <span style="color:#a8c8e8">${totalPending} in transit</span>`
        : "🛒 Auto-shop ON";
    } else {
      auto.style.color = "#ffd47a";
      auto.textContent = "🛒 Auto-shop OFF — restock manually";
    }
    this.body.appendChild(auto);

    // === Kitchen ticket pipeline (always shown) ===
    const ts = this.game.getTicketStats?.();
    if (ts) {
      const totalTickets = ts.queued + ts.cooking + ts.ready + ts.delivering;
      const pipeline = document.createElement("div");
      Object.assign(pipeline.style, {
        marginTop: "4px", fontSize: "10px", textAlign: "center",
        opacity: totalTickets > 0 ? "1" : "0.6",
        color: totalTickets > 0 ? "#a8e2a8" : "#fff5dc",
      } as Partial<CSSStyleDeclaration>);
      pipeline.textContent = totalTickets > 0
        ? `🍳 ${ts.queued} queued · ${ts.cooking} cooking · ${ts.ready + ts.delivering} delivering`
        : "🍳 Kitchen idle — no tickets";
      this.body.appendChild(pipeline);
    }
  }

  /** Small bold dimmed header used at the top of every sub-section. */
  private appendSectionHeader(label: string): void {
    const header = document.createElement("div");
    header.textContent = label;
    Object.assign(header.style, {
      marginTop: "6px", fontWeight: "700", fontSize: "10px",
      opacity: "0.75", letterSpacing: "0.04em",
    } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(header);
  }
}
