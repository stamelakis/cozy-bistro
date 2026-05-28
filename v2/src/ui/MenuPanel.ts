import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";
import { getIngredientCost } from "../data/ingredients";
import type { LuxuryTier, RecipeDefinition } from "../data/types";

/**
 * Recipe menu picker (center-bottom). 5 tier tabs — each tab shows the
 * recipes of that tier, locked tabs are grayed and uncheckable. Each
 * row shows: checkbox, name (Lvl), effective $sell, satisfaction, and
 * ingredient list (with per-unit costs).
 *
 * Collapsed by default — click the title to expand.
 */
export class MenuPanel {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabsRow: HTMLElement;
  private readonly content: HTMLElement;
  private collapsed = true;
  private selectedTier: LuxuryTier = 1;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      left: "50%",
      transform: "translateX(-50%)",
      bottom: "12px",
      maxWidth: "720px",
      width: "min(720px, calc(100vw - 480px))",
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
    title.textContent = "MENU ▾  (click to expand)";
    Object.assign(title.style, { fontWeight: "600", fontSize: "13px", cursor: "pointer" } as Partial<CSSStyleDeclaration>);
    title.onclick = () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? "none" : "block";
      title.textContent = this.collapsed ? "MENU ▾  (click to expand)" : "MENU ▴  (click to collapse)";
    };
    this.root.appendChild(title);

    this.body = document.createElement("div");
    Object.assign(this.body.style, { display: "none", marginTop: "8px" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);

    this.tabsRow = document.createElement("div");
    Object.assign(this.tabsRow.style, { display: "flex", gap: "4px", marginBottom: "8px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(this.tabsRow);

    this.content = document.createElement("div");
    Object.assign(this.content.style, { maxHeight: "30vh", overflowY: "auto", paddingRight: "4px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(this.content);
  }

  update(): void {
    if (this.collapsed) return; // skip work when hidden
    this.renderTabs();
    this.renderContent();
  }

  private renderTabs(): void {
    this.tabsRow.innerHTML = "";
    const playerTier = this.game.getLuxuryTier();
    const baseProfits = [3, 4, 5, 6, 7];
    for (let t = 1; t <= 5; t += 1) {
      const tier = t as LuxuryTier;
      const locked = tier > playerTier;
      const active = tier === this.selectedTier;
      const btn = document.createElement("button");
      btn.textContent = `Tier ${t}${locked ? " 🔒" : ""}  ·  $${baseProfits[t - 1]}/dish`;
      Object.assign(btn.style, {
        flex: "1",
        padding: "5px 4px",
        background: active
          ? "rgba(120, 200, 120, 0.30)"
          : locked
            ? "rgba(255,245,220,0.04)"
            : "rgba(255,245,220,0.10)",
        color: locked ? "rgba(255,245,220,0.4)" : "#fff5dc",
        border: active ? "1px solid rgba(120, 200, 120, 0.7)" : "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px",
        cursor: locked ? "not-allowed" : "pointer",
        font: "inherit",
        fontSize: "11px",
        fontWeight: active ? "700" : "500",
      } as Partial<CSSStyleDeclaration>);
      btn.disabled = locked;
      btn.title = locked ? `Unlock with Tier ${t} expansion` : `Base profit per dish at L1: $${baseProfits[t - 1]}`;
      btn.onclick = () => {
        if (locked) return;
        this.selectedTier = tier;
        this.renderTabs();
        this.renderContent();
      };
      this.tabsRow.appendChild(btn);
    }
  }

  private renderContent(): void {
    this.content.innerHTML = "";
    const inTier = recipes.filter((r) => getRecipeLuxuryTier(r) === this.selectedTier);
    if (inTier.length === 0) {
      this.content.textContent = "No recipes in this tier.";
      return;
    }
    const onMenu = new Set(this.game.cooking.getMenuRecipeIds());
    const playerTier = this.game.getLuxuryTier();
    const tierUnlocked = this.selectedTier <= playerTier;
    // Sort within tier by category (appetizer, main, dessert, drink, side) then name.
    const order = { appetizer: 0, main: 1, dessert: 2, drink: 3, side: 4 } as const;
    inTier.sort((a, b) => (order[a.category] - order[b.category]) || a.name.localeCompare(b.name));
    for (const recipe of inTier) {
      this.content.appendChild(this.renderRecipe(recipe, onMenu.has(recipe.id), tierUnlocked));
    }
  }

  private renderRecipe(recipe: RecipeDefinition, on: boolean, unlocked: boolean): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "4px 6px",
      borderBottom: "1px solid rgba(255,245,220,0.06)",
      opacity: unlocked ? "1" : "0.45",
    } as Partial<CSSStyleDeclaration>);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.disabled = !unlocked;
    cb.onchange = () => {
      if (cb.checked) this.game.cooking.addToMenu(recipe.id);
      else this.game.cooking.removeFromMenu(recipe.id);
    };
    row.appendChild(cb);

    const left = document.createElement("div");
    Object.assign(left.style, { flex: "1", minWidth: "0" } as Partial<CSSStyleDeclaration>);
    const nameRow = document.createElement("div");
    Object.assign(nameRow.style, { display: "flex", alignItems: "center", gap: "6px" } as Partial<CSSStyleDeclaration>);
    const cat = document.createElement("span");
    cat.textContent = this.shortForCategory(recipe.category);
    Object.assign(cat.style, {
      fontSize: "9px", padding: "1px 4px", borderRadius: "3px",
      background: this.colorForCategory(recipe.category), color: "#1b1410",
      fontWeight: "700", minWidth: "18px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    cat.title = recipe.category[0].toUpperCase() + recipe.category.slice(1);
    nameRow.appendChild(cat);
    const level = this.game.cooking.getRecipeUpgradeLevel(recipe);
    const name = document.createElement("span");
    name.textContent = `${recipe.name}${level > 1 ? `  L${level}` : ""}`;
    Object.assign(name.style, { fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as Partial<CSSStyleDeclaration>);
    nameRow.appendChild(name);
    left.appendChild(nameRow);
    // Ingredient line — list every ingredient with its per-unit cost.
    const ingLine = document.createElement("div");
    ingLine.textContent = recipe.ingredients
      .map((id) => `${this.prettyIng(id)}($${getIngredientCost(id)})`)
      .join(" + ");
    Object.assign(ingLine.style, { fontSize: "10px", opacity: "0.65", marginTop: "1px" } as Partial<CSSStyleDeclaration>);
    left.appendChild(ingLine);
    row.appendChild(left);

    const stats = document.createElement("div");
    Object.assign(stats.style, { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } as Partial<CSSStyleDeclaration>);
    const price = this.game.getEffectiveSellPrice(recipe);
    const profit = this.game.getEffectiveProfit(recipe);
    const sat = this.game.getEffectiveSatisfaction(recipe).toFixed(0);
    const priceLine = document.createElement("div");
    priceLine.innerHTML = `$${price} <span style="opacity:0.55">(+$${profit})</span>`;
    Object.assign(priceLine.style, { fontWeight: "600", fontSize: "12px", color: "#a8e2a8" } as Partial<CSSStyleDeclaration>);
    stats.appendChild(priceLine);
    const satLine = document.createElement("div");
    satLine.textContent = `${sat}😋`;
    Object.assign(satLine.style, { fontSize: "10px", opacity: "0.75" } as Partial<CSSStyleDeclaration>);
    stats.appendChild(satLine);
    row.appendChild(stats);

    return row;
  }

  private prettyIng(id: string): string {
    return id.replace(/[-_]/g, " ");
  }

  private colorForCategory(c: string): string {
    return c === "appetizer" ? "#f6d36a"
      : c === "main"      ? "#f0a070"
      : c === "dessert"   ? "#f0a0d0"
      : c === "drink"     ? "#a0d8f0"
      : "#cccccc"; // side
  }
  private shortForCategory(c: string): string {
    return c === "appetizer" ? "Ap"
      : c === "main"      ? "Ma"
      : c === "dessert"   ? "De"
      : c === "drink"     ? "Dr"
      : "Si";
  }
}
