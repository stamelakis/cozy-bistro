import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";

/**
 * Luxury-tier expansion panel — single button that buys the next tier.
 * Each tier unlocks the higher-tier recipes in the menu picker (e.g. tier 2
 * unlocks the L2 recipes, tier 5 unlocks the prestige dishes). Costs grow
 * geometrically ($500, $1500, $4500, $13.5k, $40.5k).
 *
 * Lives bottom-center so it sits between the build menu (top-right) and
 * the menu panel (bottom-center, collapsible). Always visible — a one-line
 * status bar with the buy button on the right.
 */
export class ExpandPanel {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly buyBtn: HTMLButtonElement;
  private readonly unlocksEl: HTMLElement;
  private readonly boostBtn: HTMLButtonElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      bottom: "60px", // sit above the collapsed MenuPanel
      left: "50%",
      transform: "translateX(-50%)",
      padding: "8px 12px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "8px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      alignItems: "center",
      pointerEvents: "auto",
      minWidth: "320px",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "10px", alignItems: "center", width: "100%" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(row);

    this.statusEl = document.createElement("span");
    Object.assign(this.statusEl.style, { fontWeight: "600", fontSize: "13px", flex: "1" } as Partial<CSSStyleDeclaration>);
    row.appendChild(this.statusEl);

    this.buyBtn = document.createElement("button");
    Object.assign(this.buyBtn.style, {
      padding: "4px 10px",
      background: "rgba(120, 200, 120, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    this.buyBtn.onclick = () => {
      if (this.game.buyExpansion()) {
        this.update();
      }
    };
    row.appendChild(this.buyBtn);

    this.unlocksEl = document.createElement("div");
    Object.assign(this.unlocksEl.style, { opacity: "0.7", fontSize: "11px", textAlign: "center" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.unlocksEl);

    // Marketing boost button — temporary spawn-rate doubling.
    this.boostBtn = document.createElement("button");
    Object.assign(this.boostBtn.style, {
      marginTop: "2px",
      padding: "4px 12px",
      background: "rgba(200, 120, 200, 0.25)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.35)",
      borderRadius: "4px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "11px",
      fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    this.boostBtn.onclick = () => {
      if (this.game.buyBoost()) this.update();
    };
    this.root.appendChild(this.boostBtn);

    this.update();
  }

  update(): void {
    // Boost button reflects active timer if running.
    if (this.game.isBoostActive()) {
      const remaining = Math.ceil(this.game.getBoostRemaining());
      this.boostBtn.textContent = `📣 BOOST ACTIVE — ${remaining}s`;
      this.boostBtn.disabled = true;
      this.boostBtn.style.opacity = "0.7";
    } else {
      const cost = this.game.getBoostCost();
      const dur = this.game.getBoostDurationSeconds();
      this.boostBtn.textContent = `📣 Boost guests (${dur}s) — $${cost}`;
      const can = this.game.economy.canAfford(cost);
      this.boostBtn.disabled = !can;
      this.boostBtn.style.opacity = can ? "1" : "0.5";
    }

    const tier = this.game.getLuxuryTier();
    const max = this.game.getMaxLuxuryTier();
    this.statusEl.textContent = `Restaurant tier ${tier} / ${max}`;
    if (tier >= max) {
      this.buyBtn.textContent = "MAX TIER";
      this.buyBtn.disabled = true;
      this.buyBtn.style.opacity = "0.5";
      this.unlocksEl.textContent = "Every recipe is unlocked.";
      return;
    }
    const cost = this.game.getExpansionCost();
    const nextTier = tier + 1;
    const newRecipes = recipes
      .filter((r) => getRecipeLuxuryTier(r) === nextTier)
      .map((r) => r.name);
    this.buyBtn.textContent = `Expand to Tier ${nextTier} ($${cost})`;
    const can = this.game.economy.canAfford(cost);
    this.buyBtn.disabled = !can;
    this.buyBtn.style.opacity = can ? "1" : "0.5";
    if (newRecipes.length === 0) {
      this.unlocksEl.textContent = `Unlocks tier ${nextTier} polish (no new recipes this step).`;
    } else if (newRecipes.length <= 3) {
      this.unlocksEl.textContent = `Unlocks: ${newRecipes.join(", ")}`;
    } else {
      this.unlocksEl.textContent = `Unlocks: ${newRecipes.slice(0, 3).join(", ")} (+${newRecipes.length - 3} more)`;
    }
  }
}
