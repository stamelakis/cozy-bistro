import type { Game } from "../game/Game";
import { getIngredientCost } from "../data/ingredients";

/**
 * Pantry panel (bottom-right): one row per ingredient currently in stock,
 * showing name + unit cost + quantity. Color-coded (green ≥4, amber 1-3,
 * red 0). Includes an "Auto-shop ON/OFF" toggle and a running total value.
 */
export class PantryPanel {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly toggle: HTMLButtonElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      padding: "10px 12px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "8px",
      minWidth: "180px",
      maxHeight: "40vh",
      overflowY: "auto",
      pointerEvents: "auto",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const title = document.createElement("div");
    title.textContent = "PANTRY";
    Object.assign(title.style, { fontWeight: "600", fontSize: "13px", marginBottom: "6px" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(title);

    this.list = document.createElement("div");
    this.root.appendChild(this.list);

    this.toggle = document.createElement("button");
    Object.assign(this.toggle.style, {
      marginTop: "6px",
      padding: "4px 8px",
      background: "rgba(255,245,220,0.10)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      pointerEvents: "auto",
      font: "inherit",
      width: "100%",
    } as Partial<CSSStyleDeclaration>);
    this.toggle.onclick = () => { this.game.autoShopEnabled = !this.game.autoShopEnabled; this.update(); };
    this.root.appendChild(this.toggle);
  }

  private totalLabel?: HTMLElement;

  update(): void {
    // Sort by unit cost desc so the expensive stuff is at the top.
    const pantry = this.game.cooking.getPantry().slice()
      .sort((a, b) => getIngredientCost(b.id) - getIngredientCost(a.id)
        || a.name.localeCompare(b.name));
    // Rebuild only if shape changed (cheap diff: rowcount + ids).
    if (this.list.children.length !== pantry.length) {
      this.list.innerHTML = "";
      for (const stock of pantry) {
        const row = document.createElement("div");
        row.dataset.id = stock.id;
        Object.assign(row.style, {
          display: "grid",
          gridTemplateColumns: "1fr 40px 30px",
          gap: "4px",
          alignItems: "baseline",
          fontVariantNumeric: "tabular-nums",
        } as Partial<CSSStyleDeclaration>);
        const name = document.createElement("span");
        name.textContent = stock.name;
        Object.assign(name.style, { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as Partial<CSSStyleDeclaration>);
        const unit = document.createElement("span");
        unit.className = "unit";
        Object.assign(unit.style, { fontSize: "10px", opacity: "0.6", textAlign: "right" } as Partial<CSSStyleDeclaration>);
        const qty = document.createElement("span");
        qty.className = "qty";
        Object.assign(qty.style, { textAlign: "right", fontWeight: "700" } as Partial<CSSStyleDeclaration>);
        row.appendChild(name);
        row.appendChild(unit);
        row.appendChild(qty);
        this.list.appendChild(row);
      }
    }
    let totalValue = 0;
    pantry.forEach((stock, i) => {
      const row = this.list.children[i] as HTMLElement;
      const unitEl = row.querySelector(".unit") as HTMLElement;
      const qtyEl = row.querySelector(".qty") as HTMLElement;
      const cost = getIngredientCost(stock.id);
      unitEl.textContent = `$${cost}`;
      qtyEl.textContent = String(stock.quantity);
      qtyEl.style.color = stock.quantity === 0 ? "#ff9a9a"
        : stock.quantity <= 3 ? "#ffd47a"
        : "#a8e2a8";
      totalValue += cost * stock.quantity;
    });
    this.toggle.textContent = this.game.autoShopEnabled ? "Auto-shop: ON" : "Auto-shop: OFF";
    this.toggle.style.background = this.game.autoShopEnabled
      ? "rgba(120, 200, 120, 0.18)" : "rgba(200, 120, 120, 0.18)";
    if (!this.totalLabel) {
      this.totalLabel = document.createElement("div");
      Object.assign(this.totalLabel.style, {
        fontSize: "10px", opacity: "0.7", marginTop: "4px",
        borderTop: "1px solid rgba(255,245,220,0.12)", paddingTop: "4px",
      } as Partial<CSSStyleDeclaration>);
      this.root.appendChild(this.totalLabel);
    }
    this.totalLabel.textContent = `Inventory value: $${totalValue}`;
  }
}
