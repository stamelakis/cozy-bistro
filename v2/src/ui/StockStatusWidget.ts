import type { Game } from "../game/Game";
import { getIngredientCost } from "../data/ingredients";

/**
 * Compact at-a-glance ingredient warning panel that sits attached
 * directly above the StaffPanel. Mirrors the three "right tab" sections
 * the 2D version had: In Need, Stock On Hand, Kitchen Tickets — plus a
 * compact "auto-shop status" footer.
 *
 * Like the StaffPanel + ExpandWidget, this is always visible — the goal
 * is to surface critical state without an extra click. Section headers
 * always render so the layout stays stable even when the pantry is
 * fully topped up.
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

    // === Top status line — out / low / all-stocked summary ===
    const out = pantry.filter((s) => s.quantity === 0)
      .sort((a, b) => getIngredientCost(b.id) - getIngredientCost(a.id));
    const low = pantry.filter((s) => s.quantity > 0 && s.quantity <= 2)
      .sort((a, b) => a.quantity - b.quantity);
    const usedToday = this.game.cooking.getTotalConsumedToday();

    if (out.length === 0 && low.length === 0) {
      const ok = document.createElement("div");
      ok.innerHTML = usedToday > 0
        ? `✓ All ingredients stocked <span style="opacity:0.7">· ${usedToday} used today</span>`
        : "✓ All ingredients stocked";
      Object.assign(ok.style, { color: "#a8e2a8", textAlign: "center", padding: "2px 0" } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(ok);
    } else {
      if (out.length > 0) {
        const line = document.createElement("div");
        line.innerHTML = `<span style="color:#ff9a9a;font-weight:700">OUT:</span> ${out.slice(0, 6).map((s) => s.name).join(", ")}${out.length > 6 ? ` (+${out.length - 6})` : ""}`;
        Object.assign(line.style, { marginBottom: "3px" } as Partial<CSSStyleDeclaration>);
        this.body.appendChild(line);
      }
      if (low.length > 0) {
        const line = document.createElement("div");
        line.innerHTML = `<span style="color:#ffd47a;font-weight:700">LOW:</span> ${low.slice(0, 6).map((s) => `${s.name}(${s.quantity})`).join(", ")}${low.length > 6 ? ` (+${low.length - 6})` : ""}`;
        this.body.appendChild(line);
      }
    }

    // === In Need section (always shown — mirrors 2D layout) ===
    // Lists every ingredient below target with the format
    //   "Bread: need 2 (have 3, way 1)"
    // …where "way" is how many units the errand helper is bringing.
    // When pantry is at target shows a dim "All at target." line so the
    // section header doesn't render with empty content (which looked
    // broken in playtest).
    const needRows: string[] = [];
    for (const s of pantry) {
      const way = this.game.cooking.getPendingForIngredient(s.id);
      const need = Math.max(0, target - s.quantity - way);
      if (need <= 0) continue;
      const wayStr = way > 0 ? `, way ${way}` : "";
      needRows.push(`<div>${s.name}: need ${need} <span style="opacity:0.7">(have ${s.quantity}${wayStr})</span></div>`);
    }
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

    // === Stock On Hand section (always shown — full pantry list) ===
    // Two-column grid so 30+ ingredients still fit in a compact widget,
    // scrollable past ~110px. Colors mirror the OUT/LOW alert so a glance
    // tells the player which line items are red/amber/green.
    this.appendSectionHeader("📦 Stock On Hand");
    {
      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "grid", gridTemplateColumns: "1fr 1fr",
        rowGap: "1px", columnGap: "6px",
        maxHeight: "110px", overflowY: "auto",
        fontSize: "10px", padding: "1px 0",
      } as Partial<CSSStyleDeclaration>);
      const sorted = [...pantry].sort((a, b) => a.name.localeCompare(b.name));
      for (const s of sorted) {
        const color = s.quantity === 0 ? "#ff9a9a"
          : s.quantity <= 2 ? "#ffd47a"
          : "#dcdcd8";
        const cell = document.createElement("div");
        // Truncate long names so the qty column stays aligned.
        cell.innerHTML = `<span style="color:${color}">${s.name}</span>: <span style="color:${color};font-weight:600">${s.quantity}</span>`;
        cell.style.whiteSpace = "nowrap";
        cell.style.overflow = "hidden";
        cell.style.textOverflow = "ellipsis";
        grid.appendChild(cell);
      }
      this.body.appendChild(grid);
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

    // === Kitchen ticket pipeline (also revived from 2D) ===
    // Always shown — empty pipeline reads "Kitchen idle — no tickets"
    // so the player has a clear "nothing's cooking" anchor when the
    // restaurant is quiet.
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
