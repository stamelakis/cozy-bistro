import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";

/**
 * Compact tier + boost widget that sits attached below the HUD. Replaces
 * the modal-only access for these two important actions — they're worth
 * being one click away.
 *
 * Layout: title bar showing "Tier N/5", expand button, separator, boost
 * button. Tooltip on the unlocks preview.
 */
export class ExpandWidget {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly tierLabel: HTMLElement;
  private readonly expandBtn: HTMLButtonElement;
  private readonly boostBtn: HTMLButtonElement;
  private readonly unlocksLine: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    // Inline section — Sidebar handles the position/background/padding.
    this.root = document.createElement("div");
    parent.appendChild(this.root);

    this.tierLabel = document.createElement("div");
    Object.assign(this.tierLabel.style, {
      fontWeight: "700", fontSize: "12px", marginBottom: "4px",
      letterSpacing: "0.03em",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.tierLabel);

    this.unlocksLine = document.createElement("div");
    Object.assign(this.unlocksLine.style, {
      fontSize: "10px", opacity: "0.7", marginBottom: "6px",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.unlocksLine);

    this.expandBtn = document.createElement("button");
    Object.assign(this.expandBtn.style, {
      width: "100%", padding: "5px 8px", marginBottom: "5px",
      background: "rgba(120, 200, 120, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.3)",
      borderRadius: "4px", cursor: "pointer", font: "inherit",
      fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    this.expandBtn.onclick = () => { if (this.game.buyExpansion()) this.update(); };
    this.root.appendChild(this.expandBtn);

    this.boostBtn = document.createElement("button");
    Object.assign(this.boostBtn.style, {
      width: "100%", padding: "5px 8px",
      background: "rgba(200, 120, 200, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.3)",
      borderRadius: "4px", cursor: "pointer", font: "inherit",
      fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    this.boostBtn.onclick = () => { if (this.game.buyBoost()) this.update(); };
    this.root.appendChild(this.boostBtn);

    this.update();
  }

  update(): void {
    const tier = this.game.getLuxuryTier();
    const max = this.game.getMaxLuxuryTier();
    this.tierLabel.textContent = `🏛 Restaurant tier ${tier} / ${max}`;

    if (tier < max) {
      const cost = this.game.getExpansionCost();
      const nextTier = tier + 1;
      const newRecipes = recipes
        .filter((r) => getRecipeLuxuryTier(r) === nextTier)
        .map((r) => r.name);
      const seats = nextTier >= 2 && nextTier <= 4 ? " · +4 seats" : "";
      const preview = newRecipes.length === 0
        ? `tier ${nextTier} polish${seats}`
        : `${newRecipes.slice(0, 2).join(", ")}${newRecipes.length > 2 ? ` +${newRecipes.length - 2}` : ""}${seats}`;
      this.unlocksLine.textContent = `→ ${preview}`;
      this.unlocksLine.title = newRecipes.join(", ") + seats;
      this.expandBtn.textContent = `Expand → Tier ${nextTier}  ($${cost})`;
      const can = this.game.economy.canAfford(cost);
      this.expandBtn.disabled = !can;
      this.expandBtn.style.opacity = can ? "1" : "0.5";
      this.expandBtn.style.display = "block";
    } else {
      this.unlocksLine.textContent = "✓ Every recipe unlocked";
      this.expandBtn.style.display = "none";
    }

    if (this.game.isBoostActive()) {
      this.boostBtn.textContent = `📣 BOOST — ${Math.ceil(this.game.getBoostRemaining())}s left`;
      this.boostBtn.disabled = true;
      this.boostBtn.style.opacity = "0.7";
    } else {
      const c = this.game.getBoostCost();
      const d = this.game.getBoostDurationSeconds();
      this.boostBtn.textContent = `📣 Boost guests ${d}s — $${c}`;
      const can = this.game.economy.canAfford(c);
      this.boostBtn.disabled = !can;
      this.boostBtn.style.opacity = can ? "1" : "0.5";
    }
  }
}
