import type { Game } from "../game/Game";
import type { DayRecord } from "../game/DayHistory";

/**
 * Trends viewer — shows the last 14 day records as a table + simple
 * inline bar chart for net profit. Lets the player see whether they're
 * trending up or down across the week.
 *
 * Refreshes on every open so the data is always current.
 */

const VISIBLE_DAYS = 14;

export class StatsModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "0", left: "0",
      width: "100vw", height: "100vh",
      display: "none",
      alignItems: "center", justifyContent: "center",
      background: "rgba(0, 0, 0, 0.45)",
      zIndex: "1000",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.hide(); });
    parent.appendChild(this.root);

    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "min(640px, calc(100vw - 40px))",
      maxHeight: "84vh",
      display: "flex", flexDirection: "column",
      padding: "18px 22px",
      background: "rgba(28, 20, 14, 0.96)",
      color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "DAILY TRENDS";
    Object.assign(title.style, { fontSize: "16px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      width: "26px", height: "26px", cursor: "pointer",
      font: "inherit", fontSize: "13px",
    } as Partial<CSSStyleDeclaration>);
    closeBtn.onclick = () => this.hide();
    header.appendChild(closeBtn);
    body.appendChild(header);

    this.body = document.createElement("div");
    Object.assign(this.body.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.body);
  }

  show(): void {
    this.refresh();
    this.root.style.display = "flex";
  }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.body.innerHTML = "";
    const days = this.game.history.recent(VISIBLE_DAYS);
    if (days.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No completed days yet. Finish day 1 to see trends.";
      empty.style.opacity = "0.6";
      empty.style.textAlign = "center";
      empty.style.padding = "30px";
      this.body.appendChild(empty);
      return;
    }
    // Header row
    const headerRow = makeRow(["Day", "Weather", "Served", "Lost", "Revenue", "Expenses", "Net", "★"], true);
    this.body.appendChild(headerRow);
    // Find max abs(net) for bar scaling.
    const maxAbsNet = Math.max(1, ...days.map((d) => Math.abs(d.net)));
    // Show newest first.
    for (const d of [...days].reverse()) {
      this.body.appendChild(this.renderRow(d, maxAbsNet));
    }
    // Totals at the bottom.
    const totals = days.reduce((acc, d) => ({
      served: acc.served + d.served,
      lost: acc.lost + d.lost,
      revenue: acc.revenue + d.revenue,
      expenses: acc.expenses + d.expenses,
      net: acc.net + d.net,
    }), { served: 0, lost: 0, revenue: 0, expenses: 0, net: 0 });
    const totalRow = makeRow([
      `Total (${days.length}d)`, "—",
      `${totals.served}`, `${totals.lost}`,
      `$${totals.revenue}`, `$${totals.expenses}`,
      `${totals.net >= 0 ? "+" : "-"}$${Math.abs(totals.net)}`,
      "—",
    ], true);
    totalRow.style.borderTop = "2px solid rgba(255,245,220,0.25)";
    totalRow.style.marginTop = "4px";
    totalRow.style.paddingTop = "6px";
    this.body.appendChild(totalRow);
  }

  private renderRow(d: DayRecord, maxAbsNet: number): HTMLElement {
    const row = makeRow([
      `Day ${d.dayNumber}`,
      `${d.weatherEmoji} ${d.weatherLabel}`,
      `${d.served}`,
      `${d.lost}`,
      `$${d.revenue}`,
      `$${d.expenses}`,
      "", // we fill the net cell with a bar
      d.rating.toFixed(2),
    ], false);
    // Replace the net cell with a label + a tiny bar.
    const netCellIdx = 6;
    const netCell = row.children[netCellIdx] as HTMLElement;
    netCell.textContent = "";
    netCell.style.display = "flex";
    netCell.style.alignItems = "center";
    netCell.style.gap = "6px";
    const sign = d.net >= 0 ? "+" : "-";
    const label = document.createElement("span");
    label.textContent = `${sign}$${Math.abs(d.net)}`;
    label.style.minWidth = "52px";
    label.style.color = d.net >= 0 ? "#a8e2a8" : "#f0a8a8";
    netCell.appendChild(label);
    const bar = document.createElement("span");
    const width = Math.round(Math.abs(d.net) / maxAbsNet * 60);
    Object.assign(bar.style, {
      display: "inline-block",
      height: "8px",
      width: `${width}px`,
      background: d.net >= 0 ? "#5fae5f" : "#c25555",
      borderRadius: "2px",
    } as Partial<CSSStyleDeclaration>);
    netCell.appendChild(bar);
    return row;
  }
}

function makeRow(cells: string[], bold: boolean): HTMLElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "grid",
    gridTemplateColumns: "minmax(60px,auto) 1fr 60px 60px 80px 80px 130px 50px",
    gap: "10px",
    padding: "4px 6px",
    borderBottom: "1px solid rgba(255,245,220,0.06)",
    fontVariantNumeric: "tabular-nums",
    fontWeight: bold ? "700" : "400",
  } as Partial<CSSStyleDeclaration>);
  for (const c of cells) {
    const cell = document.createElement("span");
    cell.textContent = c;
    row.appendChild(cell);
  }
  return row;
}
