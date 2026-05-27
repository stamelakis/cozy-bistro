import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";

/**
 * Recipe upgrade panel — lists every unlocked recipe with its current level,
 * effective sell price, and an "Upgrade ($N)" button. Each upgrade level
 * adds 30% to sell price and +1.5 to satisfaction. Cost grows as level².
 *
 * Lives center-top so it doesn't clash with the build menu (top-right) or
 * the HUD (top-left). Collapsed by default — click the header to open.
 */
export class UpgradePanel {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private collapsed = true;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      maxWidth: "420px",
      padding: "8px 12px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "8px",
      pointerEvents: "auto",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const title = document.createElement("div");
    title.textContent = "UPGRADES ▾  (click to expand)";
    Object.assign(title.style, { fontWeight: "600", fontSize: "13px", cursor: "pointer" } as Partial<CSSStyleDeclaration>);
    title.onclick = () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? "none" : "block";
      title.textContent = this.collapsed ? "UPGRADES ▾  (click to expand)" : "UPGRADES ▴  (click to collapse)";
    };
    this.root.appendChild(title);

    this.body = document.createElement("div");
    Object.assign(this.body.style, { display: "none", marginTop: "8px", maxHeight: "40vh", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);
  }

  update(): void {
    const unlocked = this.game.cooking.getUnlockedRecipeIds();
    if (this.body.children.length !== unlocked.length) {
      this.body.innerHTML = "";
      for (const id of unlocked) {
        const recipe = recipes.find((r) => r.id === id);
        if (!recipe) continue;
        const row = document.createElement("div");
        row.dataset.id = id;
        Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", padding: "3px 0", borderBottom: "1px solid rgba(255,245,220,0.08)" } as Partial<CSSStyleDeclaration>);
        const label = document.createElement("span");
        label.className = "label";
        label.style.flex = "1";
        const btn = document.createElement("button");
        btn.className = "upgrade";
        Object.assign(btn.style, {
          padding: "3px 8px",
          background: "rgba(120, 200, 120, 0.18)",
          color: "#fff5dc",
          border: "1px solid rgba(255,245,220,0.25)",
          borderRadius: "4px",
          cursor: "pointer",
          font: "inherit",
          fontSize: "11px",
        } as Partial<CSSStyleDeclaration>);
        btn.onclick = () => this.tryUpgrade(id);
        row.appendChild(label);
        row.appendChild(btn);
        this.body.appendChild(row);
      }
    }
    // Refresh per-row labels.
    Array.from(this.body.children).forEach((rowEl, i) => {
      const id = (rowEl as HTMLElement).dataset.id!;
      const recipe = recipes.find((r) => r.id === id);
      if (!recipe) return;
      const row = rowEl as HTMLElement;
      const label = row.querySelector(".label") as HTMLElement;
      const btn = row.querySelector(".upgrade") as HTMLButtonElement;
      const level = this.game.cooking.getRecipeUpgradeLevel(recipe);
      const price = this.game.getEffectiveSellPrice(recipe);
      const cost = this.game.getRecipeUpgradeCost(recipe);
      label.textContent = `${recipe.name} — L${level} · $${price}`;
      if (level >= 10) {
        btn.textContent = "MAX";
        btn.disabled = true;
        btn.style.opacity = "0.5";
      } else {
        btn.textContent = `Upgrade ($${cost})`;
        const can = this.game.economy.canAfford(cost);
        btn.disabled = !can;
        btn.style.opacity = can ? "1" : "0.5";
      }
      void i;
    });
  }

  private tryUpgrade(recipeId: string): void {
    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe) return;
    const cost = this.game.getRecipeUpgradeCost(recipe);
    if (!this.game.economy.spendMoney(cost, "unlock")) return;
    const level = this.game.cooking.getRecipeUpgradeLevel(recipe);
    this.game.cooking.setRecipeUpgradeLevel(recipeId, level + 1);
    this.update();
  }
}
