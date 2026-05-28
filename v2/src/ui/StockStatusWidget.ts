import type { Game } from "../game/Game";
import { getIngredientCost } from "../data/ingredients";

/**
 * Compact at-a-glance ingredient warning panel that sits attached
 * directly above the StaffPanel. Shows: ingredients currently out of
 * stock (red), ingredients running low (amber), and a hint about
 * what the auto-shop is buying right now.
 *
 * Like the StaffPanel + ExpandWidget, this is always visible — the
 * goal is to surface critical state without an extra click.
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
    // Sort by stock asc, then cost desc — most-needed first.
    const out = pantry.filter((s) => s.quantity === 0)
      .sort((a, b) => getIngredientCost(b.id) - getIngredientCost(a.id));
    const low = pantry.filter((s) => s.quantity > 0 && s.quantity <= 2)
      .sort((a, b) => a.quantity - b.quantity);
    if (out.length === 0 && low.length === 0) {
      const usedToday = this.game.cooking.getTotalConsumedToday();
      const ok = document.createElement("div");
      ok.innerHTML = usedToday > 0
        ? `✓ All ingredients stocked <span style="opacity:0.7">· ${usedToday} used today</span>`
        : "✓ All ingredients stocked";
      Object.assign(ok.style, { color: "#a8e2a8", textAlign: "center", padding: "2px 0" } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(ok);
      return;
    }
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
    if (this.game.autoShopEnabled) {
      const auto = document.createElement("div");
      auto.textContent = "🛒 Auto-shop ON";
      Object.assign(auto.style, {
        fontSize: "10px", opacity: "0.65", marginTop: "3px", textAlign: "center",
      } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(auto);
    } else {
      const auto = document.createElement("div");
      auto.textContent = "🛒 Auto-shop OFF — restock manually";
      Object.assign(auto.style, {
        fontSize: "10px", color: "#ffd47a", marginTop: "3px", textAlign: "center",
      } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(auto);
    }
  }
}
