import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";

/**
 * Recipe upgrade browser. Replaces the always-visible UpgradePanel
 * with a modal opened from the HUD's icon row. Same upgrade math
 * as before (cost = level² × $30, +30% sell + 1.5 satisfaction per
 * level, max L10).
 */

export class UpgradeModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0",
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
      width: "min(560px, calc(100vw - 40px))",
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
    title.textContent = "RECIPE UPGRADES";
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

  show(): void { this.refresh(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.body.innerHTML = "";
    const unlocked = this.game.cooking.getUnlockedRecipeIds();
    if (unlocked.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No recipes unlocked yet.";
      empty.style.opacity = "0.6";
      empty.style.textAlign = "center";
      empty.style.padding = "20px";
      this.body.appendChild(empty);
      return;
    }
    for (const id of unlocked) {
      const recipe = recipes.find((r) => r.id === id);
      if (!recipe) continue;
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "10px",
        padding: "6px 8px",
        borderBottom: "1px solid rgba(255,245,220,0.08)",
      } as Partial<CSSStyleDeclaration>);
      const label = document.createElement("span");
      label.style.flex = "1";
      const level = this.game.cooking.getRecipeUpgradeLevel(recipe);
      const price = this.game.getEffectiveSellPrice(recipe);
      const sat = this.game.getEffectiveSatisfaction(recipe).toFixed(0);
      label.textContent = `${recipe.name} — L${level} · $${price} · ${sat}😋`;
      row.appendChild(label);
      const btn = document.createElement("button");
      Object.assign(btn.style, {
        padding: "4px 10px",
        background: "rgba(120, 200, 120, 0.18)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.25)",
        borderRadius: "4px",
        cursor: "pointer",
        font: "inherit", fontSize: "11px",
      } as Partial<CSSStyleDeclaration>);
      if (level >= 10) {
        btn.textContent = "MAX";
        btn.disabled = true;
        btn.style.opacity = "0.5";
      } else {
        const cost = this.game.getRecipeUpgradeCost(recipe);
        btn.textContent = `Upgrade ($${cost})`;
        const can = this.game.economy.canAfford(cost);
        btn.disabled = !can;
        btn.style.opacity = can ? "1" : "0.5";
        btn.onclick = () => {
          if (this.game.economy.spendMoney(cost, "unlock")) {
            this.game.cooking.setRecipeUpgradeLevel(id, level + 1);
            this.refresh();
          }
        };
      }
      row.appendChild(btn);
      this.body.appendChild(row);
    }
  }
}
