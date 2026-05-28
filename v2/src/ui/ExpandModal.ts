import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";

/**
 * Restaurant tier + marketing boost — moved out of the always-visible
 * ExpandPanel into a modal so the bottom-center stays clean. Opens
 * via the 🏛 button in the HUD's icon row.
 */
export class ExpandModal {
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
      width: "min(440px, calc(100vw - 40px))",
      display: "flex", flexDirection: "column",
      padding: "20px 24px",
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
      marginBottom: "12px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "RESTAURANT";
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
    body.appendChild(this.body);
  }

  show(): void { this.refresh(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.body.innerHTML = "";
    const tier = this.game.getLuxuryTier();
    const max = this.game.getMaxLuxuryTier();
    const status = document.createElement("div");
    status.innerHTML = `<b>Current tier:</b> ${tier} / ${max}`;
    Object.assign(status.style, { fontSize: "13px", marginBottom: "12px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(status);

    if (tier < max) {
      const cost = this.game.getExpansionCost();
      const nextTier = tier + 1;
      const newRecipes = recipes
        .filter((r) => getRecipeLuxuryTier(r) === nextTier)
        .map((r) => r.name);
      const seats = nextTier >= 2 && nextTier <= 4 ? " · +4 seats" : "";
      const recipeText = newRecipes.length === 0
        ? `Tier ${nextTier} polish (no new recipes)`
        : newRecipes.length <= 3
          ? newRecipes.join(", ")
          : `${newRecipes.slice(0, 3).join(", ")} (+${newRecipes.length - 3} more)`;
      const unlocks = document.createElement("div");
      unlocks.innerHTML = `<b>Next unlock:</b> ${recipeText}${seats}`;
      Object.assign(unlocks.style, { fontSize: "11px", opacity: "0.85", marginBottom: "10px" } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(unlocks);

      const buy = document.createElement("button");
      buy.textContent = `Expand to Tier ${nextTier} ($${cost})`;
      Object.assign(buy.style, {
        padding: "8px 14px",
        background: "rgba(120, 200, 120, 0.20)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.3)",
        borderRadius: "4px",
        cursor: "pointer", font: "inherit", fontSize: "12px",
        fontWeight: "600", marginBottom: "16px",
      } as Partial<CSSStyleDeclaration>);
      const can = this.game.economy.canAfford(cost);
      buy.disabled = !can;
      buy.style.opacity = can ? "1" : "0.5";
      buy.onclick = () => { if (this.game.buyExpansion()) this.refresh(); };
      this.body.appendChild(buy);
    } else {
      const max = document.createElement("div");
      max.textContent = "MAX TIER — every recipe is available.";
      Object.assign(max.style, { fontSize: "12px", opacity: "0.85", marginBottom: "16px", color: "#a8e2a8" } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(max);
    }

    const boostHeader = document.createElement("div");
    boostHeader.innerHTML = `<b>📣 Marketing boost</b>`;
    Object.assign(boostHeader.style, { fontSize: "13px", marginBottom: "4px", marginTop: "8px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(boostHeader);
    const boostDesc = document.createElement("div");
    boostDesc.textContent = `Pay $${this.game.getBoostCost()} for ${this.game.getBoostDurationSeconds()}s of 2× spawn rate.`;
    Object.assign(boostDesc.style, { fontSize: "11px", opacity: "0.75", marginBottom: "6px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(boostDesc);

    const boostBtn = document.createElement("button");
    Object.assign(boostBtn.style, {
      padding: "6px 12px",
      background: "rgba(200, 120, 200, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.3)",
      borderRadius: "4px",
      cursor: "pointer", font: "inherit", fontSize: "12px",
      fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    if (this.game.isBoostActive()) {
      boostBtn.textContent = `📣 ACTIVE — ${Math.ceil(this.game.getBoostRemaining())}s remaining`;
      boostBtn.disabled = true;
      boostBtn.style.opacity = "0.7";
    } else {
      const cost = this.game.getBoostCost();
      boostBtn.textContent = `Boost guests — $${cost}`;
      const can = this.game.economy.canAfford(cost);
      boostBtn.disabled = !can;
      boostBtn.style.opacity = can ? "1" : "0.5";
      boostBtn.onclick = () => { if (this.game.buyBoost()) this.refresh(); };
    }
    this.body.appendChild(boostBtn);
  }
}
