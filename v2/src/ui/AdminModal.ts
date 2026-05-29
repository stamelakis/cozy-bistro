import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { STAFF_UPGRADE_MAX } from "../systems/StaffSystem";

/**
 * Dev-mode panel — tuning sliders for live balance changes plus a
 * whole pile of one-shot "cheat" affordances (money, tier jump,
 * recipe / staff promote and demote, refill pantry, wash everything,
 * reset reputation, etc.). Nothing here is meant to ship to a regular
 * gameplay path — every method it calls on Game / its systems is
 * prefixed `admin*` so the boundary stays obvious.
 *
 * Each block of controls is a small section with its own header. Reset
 * snaps the sliders back; the actions are fire-and-forget.
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

/** Quick-adjust deltas for the money buttons. */
const MONEY_DELTAS = [100, 1000, 10000, 100000] as const;

export class AdminModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;

  // === Section refs the show() refresh path reads back ===
  private readonly controls: { input: HTMLInputElement; valueEl: HTMLElement; key: string }[] = [];
  private upgradesBody!: HTMLElement;
  private moneyValue!: HTMLElement;
  private tierValue!: HTMLElement;
  private ratingValue!: HTMLElement;

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
      width: "min(480px, calc(100vw - 40px))",
      maxHeight: "92vh",
      display: "flex", flexDirection: "column",
      padding: "18px 22px",
      background: "rgba(28, 20, 14, 0.96)",
      color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
      overflowY: "auto",
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

    // === Tuning sliders ===
    for (const def of SLIDERS) this.body.appendChild(this.renderSlider(def));
    const resetBtn = this.actionButton("Reset sliders", "danger", () => {
      for (const def of SLIDERS) {
        (this.game.admin as unknown as Record<string, number>)[def.key as string] = DEFAULTS[def.key as string];
      }
      this.refreshControls();
    });
    resetBtn.style.alignSelf = "center";
    resetBtn.style.marginTop = "4px";
    this.body.appendChild(resetBtn);

    // === Money section ===
    body.appendChild(this.buildMoneySection());

    // === Luxury tier section ===
    body.appendChild(this.buildTierSection());

    // === Reputation section ===
    body.appendChild(this.buildReputationSection());

    // === Weather section — preview rain / snow / festival visuals
    // without waiting for the day-end roll. ===
    body.appendChild(this.buildWeatherSection());

    // === Quick actions ===
    body.appendChild(this.buildQuickActionsSection());

    // === Upgrades (recipes + staff) ===
    body.appendChild(this.buildUpgradesSection());
  }

  // ============================================================
  //                          SECTIONS
  // ============================================================

  private buildMoneySection(): HTMLElement {
    const section = this.sectionShell("💰 MONEY");
    const stat = document.createElement("div");
    Object.assign(stat.style, {
      fontSize: "13px", fontWeight: "700",
      color: "#ffd986", marginBottom: "4px",
      fontVariantNumeric: "tabular-nums",
    } as Partial<CSSStyleDeclaration>);
    this.moneyValue = stat;
    section.appendChild(stat);
    // Grid of +N / -N buttons.
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gap: "4px",
      gridTemplateColumns: "repeat(4, 1fr)",
    } as Partial<CSSStyleDeclaration>);
    const fmt = (n: number) => n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
    for (const delta of MONEY_DELTAS) {
      row.appendChild(this.actionButton(`+${fmt(delta)}`, "good", () => {
        this.game.economy.earnMoney(delta, "payment");
        this.refreshStats();
      }));
    }
    for (const delta of MONEY_DELTAS) {
      row.appendChild(this.actionButton(`-${fmt(delta)}`, "danger", () => {
        this.game.economy.forceSpendMoney(delta, "charge");
        this.refreshStats();
      }));
    }
    section.appendChild(row);
    // Direct set.
    const setRow = document.createElement("div");
    Object.assign(setRow.style, {
      display: "grid", gap: "4px",
      gridTemplateColumns: "1fr 60px",
      marginTop: "6px",
    } as Partial<CSSStyleDeclaration>);
    const input = document.createElement("input");
    input.type = "number";
    input.placeholder = "Set exact amount";
    input.min = "0";
    Object.assign(input.style, {
      background: "rgba(255,245,220,0.06)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.18)",
      borderRadius: "3px",
      padding: "4px 6px", font: "inherit", fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    setRow.appendChild(input);
    const setBtn = this.actionButton("Set", "neutral", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 0) return;
      this.game.economy.setMoney(Math.round(v));
      this.refreshStats();
    });
    setRow.appendChild(setBtn);
    section.appendChild(setRow);
    return section;
  }

  private buildTierSection(): HTMLElement {
    const section = this.sectionShell("🏛️ LUXURY TIER");
    const stat = document.createElement("div");
    Object.assign(stat.style, {
      fontSize: "13px", fontWeight: "700",
      color: "#ffd986", marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    this.tierValue = stat;
    section.appendChild(stat);
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    for (let t = 1; t <= 5; t += 1) {
      row.appendChild(this.actionButton(`T${t}`, "neutral", () => {
        this.game.adminSetLuxuryTier(t);
        this.refreshStats();
      }));
    }
    section.appendChild(row);
    return section;
  }

  private buildReputationSection(): HTMLElement {
    const section = this.sectionShell("⭐ REPUTATION");
    const stat = document.createElement("div");
    Object.assign(stat.style, {
      fontSize: "13px", fontWeight: "700",
      color: "#ffd986", marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    this.ratingValue = stat;
    section.appendChild(stat);
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    // Pump one rating value through the system (1..5) per click.
    for (let r = 1; r <= 5; r += 1) {
      row.appendChild(this.actionButton(`${"★".repeat(r)}`, "neutral", () => {
        this.game.reputation.recordRating(r);
        this.refreshStats();
      }));
    }
    row.appendChild(this.actionButton("Reset", "danger", () => {
      this.game.adminResetReputation();
      this.refreshStats();
    }));
    section.appendChild(row);
    return section;
  }

  private buildWeatherSection(): HTMLElement {
    const section = this.sectionShell("🌦 WEATHER");
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    // One button per weather type — clicking forces it on the current
    // day so the player can preview the visual without waiting for the
    // day-end roll. Sunny is "neutral", rainy / cold are "neutral" too;
    // festival uses "good" to read as a celebratory option.
    const weathers: { id: string; emoji: string; label: string; kind: "good" | "neutral" }[] = [
      { id: "sunny",    emoji: "☀️",  label: "Sunny",    kind: "neutral" },
      { id: "cloudy",   emoji: "⛅",  label: "Cloudy",   kind: "neutral" },
      { id: "rainy",    emoji: "🌧️",  label: "Rainy",    kind: "neutral" },
      { id: "cold",     emoji: "🥶",  label: "Cold",     kind: "neutral" },
      { id: "festival", emoji: "🎉",  label: "Festival", kind: "good"    },
    ];
    for (const w of weathers) {
      row.appendChild(this.actionButton(`${w.emoji} ${w.label}`, w.kind, () => {
        this.game.weather.setById(w.id);
      }));
    }
    section.appendChild(row);
    return section;
  }

  private buildQuickActionsSection(): HTMLElement {
    const section = this.sectionShell("⚡ QUICK ACTIONS");
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(this.actionButton("Fill pantry", "good", () => {
      this.game.adminFillPantry();
    }));
    row.appendChild(this.actionButton("Empty pantry", "danger", () => {
      this.game.adminEmptyPantry();
    }));
    row.appendChild(this.actionButton("Wash everything", "good", () => {
      this.game.dishware.adminWashAll();
    }));
    row.appendChild(this.actionButton("Toggle auto-shop", "neutral", () => {
      this.game.autoShopEnabled = !this.game.autoShopEnabled;
    }));
    section.appendChild(row);
    return section;
  }

  private buildUpgradesSection(): HTMLElement {
    const section = this.sectionShell("📈 MANAGE UPGRADES");
    this.upgradesBody = document.createElement("div");
    Object.assign(this.upgradesBody.style, {
      maxHeight: "32vh", overflowY: "auto",
      display: "flex", flexDirection: "column", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    section.appendChild(this.upgradesBody);
    return section;
  }

  // ============================================================
  //                       UPGRADE ROWS
  // ============================================================

  /** Populate the upgrades section with one row per recipe + one row
   * per staff member. Rows are sorted so the highest-level entries
   * sit at the top. */
  private renderUpgradesPanel(): void {
    this.upgradesBody.innerHTML = "";
    // Recipes: only the ones the player can currently see (unlocked
    // tier and known to the cooking system).
    const recipeRows = recipes
      .map((r) => ({ recipe: r, level: this.game.cooking.getRecipeUpgradeLevel(r) }))
      .filter((e) => this.game.cooking.isRecipeUnlocked(e.recipe, this.game.getLuxuryTier()))
      .sort((a, b) => b.level - a.level || a.recipe.name.localeCompare(b.recipe.name));
    for (const { recipe, level } of recipeRows) {
      this.upgradesBody.appendChild(
        this.renderUpgradeRow(`🍽️ ${recipe.name}`, level, /* max */ 10,
          (delta) => this.game.adminAdjustRecipeLevel(recipe, delta)),
      );
    }
    // Staff members.
    const trainedMembers = this.game.staff
      .getMembers()
      .slice()
      .sort((a, b) => b.upgradeLevel - a.upgradeLevel || a.name.localeCompare(b.name));
    for (const m of trainedMembers) {
      const roleEmoji = m.role === "chef" ? "🧑‍🍳" : m.role === "waiter" ? "🍽️" : "📦";
      this.upgradesBody.appendChild(
        this.renderUpgradeRow(`${roleEmoji} ${m.name}`, m.upgradeLevel, STAFF_UPGRADE_MAX,
          (delta) => this.game.adminAdjustMemberLevel(m.id, delta)),
      );
    }
    if (this.upgradesBody.childElementCount === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No upgradable rows.";
      Object.assign(empty.style, {
        opacity: "0.55", fontSize: "11px",
        padding: "8px 0", textAlign: "center",
      } as Partial<CSSStyleDeclaration>);
      this.upgradesBody.appendChild(empty);
    }
  }

  private renderUpgradeRow(
    label: string,
    level: number,
    maxLevel: number,
    onAdjust: (delta: number) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "1fr 36px 36px",
      alignItems: "center", gap: "4px",
      padding: "4px 6px",
      background: "rgba(255,245,220,0.04)",
      borderRadius: "4px",
      fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    const labelEl = document.createElement("span");
    labelEl.innerHTML = `<b>${label}</b> <span style="opacity:0.7">— L${level}</span>`;
    row.appendChild(labelEl);
    const downBtn = this.actionButton("↓", "danger", () => {
      onAdjust(-1);
      this.renderUpgradesPanel();
    });
    downBtn.disabled = level <= 0;
    if (downBtn.disabled) downBtn.style.opacity = "0.3";
    row.appendChild(downBtn);
    const upBtn = this.actionButton("↑", "good", () => {
      onAdjust(+1);
      this.renderUpgradesPanel();
    });
    upBtn.disabled = level >= maxLevel;
    if (upBtn.disabled) upBtn.style.opacity = "0.3";
    row.appendChild(upBtn);
    return row;
  }

  // ============================================================
  //                       UI helpers
  // ============================================================

  private sectionShell(title: string): HTMLElement {
    const section = document.createElement("div");
    Object.assign(section.style, {
      marginTop: "12px", paddingTop: "10px",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      display: "flex", flexDirection: "column", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    const t = document.createElement("div");
    t.textContent = title;
    Object.assign(t.style, {
      fontSize: "12px", fontWeight: "700",
      letterSpacing: "0.04em", opacity: "0.85",
      marginBottom: "2px",
    } as Partial<CSSStyleDeclaration>);
    section.appendChild(t);
    return section;
  }

  private actionButton(label: string, tone: "good" | "danger" | "neutral", onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    const colors = tone === "good"
      ? { bg: "rgba(120, 200, 120, 0.18)", border: "rgba(120, 200, 120, 0.40)" }
      : tone === "danger"
      ? { bg: "rgba(200, 120, 120, 0.18)", border: "rgba(200, 120, 120, 0.40)" }
      : { bg: "rgba(255, 245, 220, 0.10)", border: "rgba(255, 245, 220, 0.25)" };
    Object.assign(btn.style, {
      padding: "5px 8px",
      background: colors.bg,
      color: "#fff5dc",
      border: `1px solid ${colors.border}`,
      borderRadius: "3px",
      cursor: "pointer",
      font: "inherit", fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = onClick;
    return btn;
  }

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

  /** Refresh the section header value rows (money, tier, rating).
   * Cheap; runs on every action-button click so the displays stay
   * in sync without polling. */
  private refreshStats(): void {
    if (this.moneyValue) {
      this.moneyValue.textContent = `Current: $${this.game.economy.getMoney().toLocaleString()}`;
    }
    if (this.tierValue) {
      this.tierValue.textContent = `Current: T${this.game.getLuxuryTier()}`;
    }
    if (this.ratingValue) {
      const r = this.game.reputation.getAverageRating();
      this.ratingValue.textContent = `Current: ${r.toFixed(2)} ★`;
    }
  }

  show(): void {
    this.refreshControls();
    this.refreshStats();
    this.renderUpgradesPanel();
    this.root.style.display = "flex";
  }
  hide(): void { this.root.style.display = "none"; }
}
