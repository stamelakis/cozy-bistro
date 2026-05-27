import type { Game } from "../game/Game";

/**
 * Pantry panel (bottom-right): one row per ingredient currently in stock,
 * showing name + quantity. Color-coded (green ≥4, amber 1-3, red 0).
 * Includes an "Auto-shop ON/OFF" toggle.
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

  update(): void {
    const pantry = this.game.cooking.getPantry().slice().sort((a, b) => a.name.localeCompare(b.name));
    // Rebuild only if shape changed (cheap diff: rowcount + ids).
    if (this.list.children.length !== pantry.length) {
      this.list.innerHTML = "";
      for (const stock of pantry) {
        const row = document.createElement("div");
        row.dataset.id = stock.id;
        Object.assign(row.style, { display: "flex", justifyContent: "space-between" } as Partial<CSSStyleDeclaration>);
        const name = document.createElement("span");
        name.textContent = stock.name;
        const qty = document.createElement("span");
        qty.className = "qty";
        row.appendChild(name);
        row.appendChild(qty);
        this.list.appendChild(row);
      }
    }
    pantry.forEach((stock, i) => {
      const row = this.list.children[i] as HTMLElement;
      const qty = row.querySelector(".qty") as HTMLElement;
      qty.textContent = String(stock.quantity);
      qty.style.color = stock.quantity === 0 ? "#ff9a9a"
        : stock.quantity <= 3 ? "#ffd47a"
        : "#a8e2a8";
    });
    this.toggle.textContent = this.game.autoShopEnabled ? "Auto-shop: ON" : "Auto-shop: OFF";
    this.toggle.style.background = this.game.autoShopEnabled
      ? "rgba(120, 200, 120, 0.18)" : "rgba(200, 120, 120, 0.18)";
  }
}
