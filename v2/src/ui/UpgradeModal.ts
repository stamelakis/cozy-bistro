import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";
import type { LuxuryTier } from "../data/types";

/**
 * Recipe upgrade browser, mirrors the MenuPanel's tier-tab layout.
 * Each tab shows that tier's recipes with current level + materials
 * needed + button. Locked tiers grey out and disable buying.
 */

export class UpgradeModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs: HTMLElement;
  private selectedTier: LuxuryTier = 1;

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
      width: "min(620px, calc(100vw - 40px))",
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

    this.tabs = document.createElement("div");
    Object.assign(this.tabs.style, { display: "flex", gap: "4px", marginBottom: "10px" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.tabs);

    this.body = document.createElement("div");
    Object.assign(this.body.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.body);
  }

  show(): void { this.refresh(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.renderTabs();
    this.renderContent();
  }

  private renderTabs(): void {
    this.tabs.innerHTML = "";
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
        padding: "6px 4px",
        background: active
          ? "rgba(120, 200, 120, 0.30)"
          : locked
            ? "rgba(255,245,220,0.04)"
            : "rgba(255,245,220,0.10)",
        color: locked ? "rgba(255,245,220,0.4)" : "#fff5dc",
        border: active ? "1px solid rgba(120, 200, 120, 0.7)" : "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px",
        cursor: locked ? "not-allowed" : "pointer",
        font: "inherit", fontSize: "11px",
        fontWeight: active ? "700" : "500",
      } as Partial<CSSStyleDeclaration>);
      btn.disabled = locked;
      btn.onclick = () => { if (locked) return; this.selectedTier = tier; this.refresh(); };
      this.tabs.appendChild(btn);
    }
  }

  private renderContent(): void {
    this.body.innerHTML = "";
    const unlocked = new Set(this.game.cooking.getUnlockedRecipeIds());
    const inTier = recipes
      .filter((r) => getRecipeLuxuryTier(r) === this.selectedTier)
      .filter((r) => unlocked.has(r.id));
    if (inTier.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No unlocked recipes in this tier yet.";
      empty.style.opacity = "0.6";
      empty.style.textAlign = "center";
      empty.style.padding = "30px";
      this.body.appendChild(empty);
      return;
    }
    // Sort within tier by category then name.
    const order = { appetizer: 0, main: 1, dessert: 2, drink: 3, side: 4 } as const;
    inTier.sort((a, b) => (order[a.category] - order[b.category]) || a.name.localeCompare(b.name));
    for (const recipe of inTier) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "10px",
        padding: "8px 8px",
        borderBottom: "1px solid rgba(255,245,220,0.08)",
      } as Partial<CSSStyleDeclaration>);
      const label = document.createElement("div");
      label.style.flex = "1";
      const level = this.game.cooking.getRecipeUpgradeLevel(recipe);
      const price = this.game.getEffectiveSellPrice(recipe);
      const profit = this.game.getEffectiveProfit(recipe);
      const sat = this.game.getEffectiveSatisfaction(recipe).toFixed(0);
      const head = document.createElement("div");
      head.innerHTML = `<b>${recipe.name}</b> &nbsp; L${level} &nbsp; <span style="color:#a8e2a8">$${price}</span> <span style="opacity:0.55">(+$${profit})</span> · ${sat}😋`;
      label.appendChild(head);
      if (level < 10) {
        const mats = this.game.getRecipeUpgradeMaterials(recipe);
        const matText = mats.map((m) => {
          const have = this.game.cooking.getIngredientQuantity(m.id);
          const short = have >= m.qty ? "" : ` (need ${m.qty - have})`;
          const color = have >= m.qty ? "#9be09b" : "#ff9a9a";
          return `<span style="color:${color}">${this.pretty(m.id)}×${m.qty}${short}</span>`;
        }).join(" + ");
        const matLine = document.createElement("div");
        matLine.innerHTML = `<span style="opacity:0.6">Materials:</span> ${matText}`;
        Object.assign(matLine.style, { fontSize: "11px", marginTop: "2px" } as Partial<CSSStyleDeclaration>);
        label.appendChild(matLine);
      }
      row.appendChild(label);

      const btn = document.createElement("button");
      Object.assign(btn.style, {
        padding: "6px 12px",
        background: "rgba(120, 200, 120, 0.22)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.25)",
        borderRadius: "4px",
        cursor: "pointer", font: "inherit", fontSize: "11px",
        minWidth: "100px",
      } as Partial<CSSStyleDeclaration>);
      if (level >= 10) {
        btn.textContent = "MAX";
        btn.disabled = true;
        btn.style.opacity = "0.5";
      } else {
        const moneyCost = this.game.getRecipeUpgradeCost(recipe);
        btn.innerHTML = `Upgrade<br><span style="font-size:10px;opacity:0.85">$${moneyCost} + mats</span>`;
        const can = this.game.canUpgradeRecipe(recipe);
        btn.disabled = !can;
        btn.style.opacity = can ? "1" : "0.5";
        btn.onclick = () => { if (this.game.upgradeRecipe(recipe)) this.refresh(); };
      }
      row.appendChild(btn);
      this.body.appendChild(row);
    }
  }

  private pretty(id: string): string { return id.replace(/[-_]/g, " "); }
}
