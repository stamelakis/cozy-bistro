import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";

/**
 * Dev-mode tuning sliders. Mutates Game.admin live so changes take
 * effect immediately — useful for balance testing without recompiling.
 *
 * Each slider is a small range input with a numeric label. "Reset"
 * snaps every slider back to the default.
 */

interface SliderDef {
  key: keyof Game["admin"];
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

const SLIDERS: SliderDef[] = [
  { key: "payrollPerStaffPerMinute", label: "Payroll / staff / min", min: 0, max: 30, step: 1,
    format: (v) => `$${v}` },
  { key: "ingredientCostMultiplier", label: "Ingredient cost ×", min: 0, max: 3, step: 0.1,
    format: (v) => v.toFixed(1) + "×" },
  { key: "spawnRateMultiplier", label: "Spawn interval ×", min: 0.25, max: 3, step: 0.05,
    format: (v) => v.toFixed(2) + "×" },
  { key: "dishWashMultiplier", label: "Dish-wash interval ×", min: 0.25, max: 3, step: 0.05,
    format: (v) => v.toFixed(2) + "×" },
  { key: "rentMultiplier", label: "Daily rent ×", min: 0, max: 3, step: 0.05,
    format: (v) => v.toFixed(2) + "×" },
];

const DEFAULTS: Record<string, number> = {
  payrollPerStaffPerMinute: 6,
  ingredientCostMultiplier: 1,
  spawnRateMultiplier: 1,
  dishWashMultiplier: 1,
  rentMultiplier: 1,
};

export class AdminModal {
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
    title.textContent = "DEV TUNING";
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
    Object.assign(this.body.style, { display: "flex", flexDirection: "column", gap: "10px" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.body);

    for (const def of SLIDERS) this.body.appendChild(this.renderSlider(def));

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset to defaults";
    Object.assign(resetBtn.style, {
      marginTop: "12px",
      padding: "6px 12px",
      background: "rgba(200, 120, 120, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      font: "inherit",
      alignSelf: "center",
    } as Partial<CSSStyleDeclaration>);
    resetBtn.onclick = () => {
      for (const def of SLIDERS) {
        (this.game.admin as unknown as Record<string, number>)[def.key as string] = DEFAULTS[def.key as string];
      }
      this.refreshControls();
    };
    body.appendChild(resetBtn);

    // Upgrade rollback panel. Lets the developer drop any upgraded
    // recipe or staff member back a level for live testing without
    // having to restart from a fresh save. No refunds — this is a
    // debugging affordance, not gameplay.
    const upgradesSection = document.createElement("div");
    Object.assign(upgradesSection.style, {
      marginTop: "16px", paddingTop: "12px",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      display: "flex", flexDirection: "column", gap: "6px",
    } as Partial<CSSStyleDeclaration>);
    const upgradesTitle = document.createElement("div");
    upgradesTitle.textContent = "MANAGE UPGRADES (rollback)";
    Object.assign(upgradesTitle.style, {
      fontSize: "12px", fontWeight: "700",
      letterSpacing: "0.04em", opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    upgradesSection.appendChild(upgradesTitle);
    this.upgradesBody = document.createElement("div");
    Object.assign(this.upgradesBody.style, {
      maxHeight: "30vh", overflowY: "auto",
      display: "flex", flexDirection: "column", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    upgradesSection.appendChild(this.upgradesBody);
    body.appendChild(upgradesSection);
  }

  /** Container for the dynamic rollback rows — repopulated each show. */
  private upgradesBody!: HTMLElement;

  /** Populate the rollback section with one row per upgraded recipe +
   * one row per upgraded staff member. Each row has a "↓" button that
   * drops the level by 1. */
  private renderUpgradesPanel(): void {
    this.upgradesBody.innerHTML = "";
    // Recipes with level > 1 (level 1 = no upgrades bought yet).
    const upgradedRecipes = recipes
      .map((r) => ({ recipe: r, level: this.game.cooking.getRecipeUpgradeLevel(r) }))
      .filter((e) => e.level > 1)
      .sort((a, b) => b.level - a.level || a.recipe.name.localeCompare(b.recipe.name));
    for (const { recipe, level } of upgradedRecipes) {
      this.upgradesBody.appendChild(
        this.renderUpgradeRow(`🍽️ ${recipe.name}`, level, () => {
          if (this.game.demoteRecipe(recipe)) this.renderUpgradesPanel();
        }),
      );
    }
    // Staff members with level > 0.
    const trainedMembers = this.game.staff
      .getMembers()
      .filter((m) => m.upgradeLevel > 0)
      .slice()
      .sort((a, b) => b.upgradeLevel - a.upgradeLevel || a.name.localeCompare(b.name));
    for (const m of trainedMembers) {
      const roleEmoji = m.role === "chef" ? "🧑‍🍳" : m.role === "waiter" ? "🍽️" : "📦";
      this.upgradesBody.appendChild(
        this.renderUpgradeRow(`${roleEmoji} ${m.name}`, m.upgradeLevel, () => {
          if (this.game.demoteMember(m.id)) this.renderUpgradesPanel();
        }),
      );
    }
    if (this.upgradesBody.childElementCount === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No upgrades to roll back.";
      Object.assign(empty.style, {
        opacity: "0.55", fontSize: "11px",
        padding: "8px 0", textAlign: "center",
      } as Partial<CSSStyleDeclaration>);
      this.upgradesBody.appendChild(empty);
    }
  }

  private renderUpgradeRow(label: string, level: number, onDemote: () => void): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", alignItems: "center", gap: "8px",
      padding: "4px 6px",
      background: "rgba(255,245,220,0.04)",
      borderRadius: "4px",
      fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    const labelEl = document.createElement("span");
    labelEl.innerHTML = `<b>${label}</b> <span style="opacity:0.7">— L${level}</span>`;
    labelEl.style.flex = "1";
    row.appendChild(labelEl);
    const btn = document.createElement("button");
    btn.textContent = "↓ L" + (level - 1);
    btn.title = "Drop one level (no refund)";
    Object.assign(btn.style, {
      padding: "3px 8px",
      background: "rgba(200, 120, 120, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(200, 120, 120, 0.45)",
      borderRadius: "3px",
      cursor: "pointer", font: "inherit", fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = onDemote;
    row.appendChild(btn);
    return row;
  }

  private readonly controls: { input: HTMLInputElement; valueEl: HTMLElement; key: string }[] = [];

  private renderSlider(def: SliderDef): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", flexDirection: "column", gap: "3px" } as Partial<CSSStyleDeclaration>);
    const top = document.createElement("div");
    Object.assign(top.style, { display: "flex", justifyContent: "space-between" } as Partial<CSSStyleDeclaration>);
    const label = document.createElement("span");
    label.textContent = def.label;
    label.style.opacity = "0.85";
    const value = document.createElement("span");
    Object.assign(value.style, { fontWeight: "700", color: "#ffd986", fontVariantNumeric: "tabular-nums" } as Partial<CSSStyleDeclaration>);
    top.appendChild(label);
    top.appendChild(value);
    row.appendChild(top);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    const current = (this.game.admin as unknown as Record<string, number>)[def.key as string];
    input.value = String(current);
    value.textContent = def.format(current);
    input.oninput = () => {
      const v = Number(input.value);
      (this.game.admin as unknown as Record<string, number>)[def.key as string] = v;
      value.textContent = def.format(v);
    };
    row.appendChild(input);
    this.controls.push({ input, valueEl: value, key: def.key as string });
    return row;
  }

  private refreshControls(): void {
    for (const c of this.controls) {
      const v = (this.game.admin as unknown as Record<string, number>)[c.key];
      const def = SLIDERS.find((d) => d.key === c.key);
      if (!def) continue;
      c.input.value = String(v);
      c.valueEl.textContent = def.format(v);
    }
  }

  show(): void {
    this.refreshControls();
    this.renderUpgradesPanel();
    this.root.style.display = "flex";
  }
  hide(): void { this.root.style.display = "none"; }
}
