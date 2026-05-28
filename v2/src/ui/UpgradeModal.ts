import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";
import type { LuxuryTier } from "../data/types";
import { STAFF_UPGRADE_MAX, type StaffRole } from "../systems/StaffSystem";

/**
 * Upgrades browser. Outer tabs split the modal into:
 *   - "Recipes": tier-tab grid of recipe upgrades (cook level + mats).
 *   - "Staff":   per-role training upgrades — Chef cook speed,
 *                Waiter serve speed, Helper carry capacity.
 *
 * The recipes side mirrors MenuPanel's tier-tab layout. The staff side
 * is three big level rows with currency-only cost (no mats).
 */

type Section = "recipes" | "staff";

export class UpgradeModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sectionTabs: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs: HTMLElement;
  private selectedTier: LuxuryTier = 1;
  private selectedSection: Section = "recipes";

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
    this.title = document.createElement("div");
    this.title.textContent = "RECIPE UPGRADES";
    Object.assign(this.title.style, { fontSize: "16px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(this.title);
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

    // Outer section tabs — Recipes vs Staff. Slightly larger / bolder
    // than the inner tier-tab strip so the player perceives the split
    // as the top-level switch.
    this.sectionTabs = document.createElement("div");
    Object.assign(this.sectionTabs.style, {
      display: "flex", gap: "4px", marginBottom: "10px",
      borderBottom: "1px solid rgba(255,245,220,0.18)",
      paddingBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.sectionTabs);

    // Inner tabs (tier strip for Recipes; hidden in Staff).
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
    this.renderSectionTabs();
    if (this.selectedSection === "recipes") {
      this.title.textContent = "RECIPE UPGRADES";
      this.tabs.style.display = "flex";
      this.renderTabs();
      this.renderContent();
    } else {
      this.title.textContent = "STAFF TRAINING";
      this.tabs.style.display = "none";
      this.renderStaffContent();
    }
  }

  private renderSectionTabs(): void {
    this.sectionTabs.innerHTML = "";
    const mk = (key: Section, label: string): HTMLButtonElement => {
      const active = key === this.selectedSection;
      const btn = document.createElement("button");
      btn.textContent = label;
      Object.assign(btn.style, {
        flex: "1",
        padding: "8px 8px",
        background: active ? "rgba(120, 200, 120, 0.22)" : "rgba(255,245,220,0.05)",
        color: "#fff5dc",
        border: active ? "1px solid rgba(120, 200, 120, 0.7)" : "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px",
        cursor: "pointer",
        font: "inherit", fontSize: "13px",
        fontWeight: active ? "700" : "500",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => { this.selectedSection = key; this.refresh(); };
      return btn;
    };
    this.sectionTabs.appendChild(mk("recipes", "🍽️ Recipes"));
    this.sectionTabs.appendChild(mk("staff", "👥 Staff"));
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
      const isOnMenu = this.game.cooking.isOnMenu(recipe.id);
      // Big bold L-badge — same styling as the MenuPanel so the upgrade
      // level reads at a glance across both screens. ACTIVE pill marks
      // the recipes the player has currently switched on.
      const lvlBg = level >= 10 ? "#f5c14a" : level > 1 ? "#7a9a6a" : "#4a4137";
      const lvlColor = level > 1 ? "#fff" : "#cbb";
      const activeChip = isOnMenu
        ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(120,200,120,0.85);color:#1b1410;font-weight:700;margin-left:6px;">ACTIVE</span>`
        : "";
      const head = document.createElement("div");
      head.innerHTML = `<span style="display:inline-block;font-size:10px;padding:2px 6px;border-radius:3px;background:${lvlBg};color:${lvlColor};font-weight:800;margin-right:6px;">L${level}</span><b>${recipe.name}</b>${activeChip} &nbsp; <span style="color:#a8e2a8">$${price}</span> <span style="opacity:0.55">(+$${profit})</span> · ${sat}😋`;
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

  /** Render the Staff tab: 3 rows (Chef / Waiter / Errand helper) each
   * with the current training level, the next-level effect preview,
   * the cost, and an Upgrade button. No materials — staff training
   * costs money only. */
  private renderStaffContent(): void {
    this.body.innerHTML = "";
    const rows: { role: StaffRole; emoji: string; name: string; stat: string;
                  currentText: (level: number) => string;
                  nextText: (level: number) => string }[] = [
      {
        role: "chef", emoji: "🧑‍🍳", name: "Chef", stat: "cook speed",
        currentText: (lv) => `Cook time: ${(lv === 0 ? 100 : 100 - 10 * lv)}% of base`,
        nextText: (lv) => `→ ${100 - 10 * (lv + 1)}% (-10% cook time)`,
      },
      {
        role: "waiter", emoji: "🍽️", name: "Waiter", stat: "serve speed",
        currentText: (lv) => `Walk speed: ${100 + 10 * lv}% of base`,
        nextText: (lv) => `→ ${100 + 10 * (lv + 1)}% (+10% serve speed)`,
      },
      {
        role: "errand", emoji: "📦", name: "Errand Helper", stat: "carry capacity",
        currentText: (lv) => `Carries ${10 + 2 * lv} units per trip`,
        nextText: (lv) => `→ ${10 + 2 * (lv + 1)} units per trip (+2)`,
      },
    ];

    for (const r of rows) {
      const level = this.game.getStaffUpgradeLevel(r.role);
      const headcount = this.game.staff.getStaffCount(r.role);
      const maxed = level >= STAFF_UPGRADE_MAX;

      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "12px",
        padding: "12px 8px",
        borderBottom: "1px solid rgba(255,245,220,0.08)",
      } as Partial<CSSStyleDeclaration>);

      const label = document.createElement("div");
      label.style.flex = "1";
      const lvlBg = level >= STAFF_UPGRADE_MAX ? "#f5c14a" : level > 0 ? "#7a9a6a" : "#4a4137";
      const lvlColor = level > 0 ? "#fff" : "#cbb";
      const head = document.createElement("div");
      head.innerHTML =
        `<span style="display:inline-block;font-size:10px;padding:2px 6px;border-radius:3px;background:${lvlBg};color:${lvlColor};font-weight:800;margin-right:6px;">L${level}/${STAFF_UPGRADE_MAX}</span>` +
        `<b>${r.emoji} ${r.name} — ${r.stat}</b>` +
        ` &nbsp; <span style="opacity:0.7">${headcount} on staff</span>`;
      label.appendChild(head);

      const detail = document.createElement("div");
      Object.assign(detail.style, { fontSize: "11px", marginTop: "4px", opacity: "0.9" } as Partial<CSSStyleDeclaration>);
      const currentLine = `<span style="opacity:0.7">Now:</span> ${r.currentText(level)}`;
      const nextLine = maxed
        ? `<span style="color:#f5c14a">Fully trained</span>`
        : `<span style="color:#a8e2a8">${r.nextText(level)}</span>`;
      detail.innerHTML = `${currentLine} &nbsp; · &nbsp; ${nextLine}`;
      label.appendChild(detail);
      row.appendChild(label);

      const btn = document.createElement("button");
      Object.assign(btn.style, {
        padding: "8px 14px",
        background: "rgba(120, 200, 120, 0.22)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.25)",
        borderRadius: "4px",
        cursor: "pointer", font: "inherit", fontSize: "11px",
        minWidth: "110px", textAlign: "center",
      } as Partial<CSSStyleDeclaration>);
      if (maxed) {
        btn.textContent = "MAX";
        btn.disabled = true;
        btn.style.opacity = "0.5";
      } else {
        const cost = this.game.getStaffUpgradeCost(r.role);
        const requiredTier = this.game.getStaffUpgradeRequiredTier(r.role);
        const playerTier = this.game.getLuxuryTier();
        const tierLocked = requiredTier !== null && requiredTier > playerTier;
        if (tierLocked) {
          btn.innerHTML = `🔒 Tier ${requiredTier}<br><span style="font-size:10px;opacity:0.85">$${cost}</span>`;
          btn.title = `Requires restaurant tier ${requiredTier} (you're on ${playerTier})`;
        } else {
          btn.innerHTML = `Train<br><span style="font-size:10px;opacity:0.85">$${cost}</span>`;
        }
        const can = this.game.canUpgradeStaff(r.role);
        btn.disabled = !can;
        btn.style.opacity = can ? "1" : "0.5";
        btn.onclick = () => { if (this.game.upgradeStaff(r.role)) this.refresh(); };
      }
      row.appendChild(btn);
      this.body.appendChild(row);
    }

    // Quick footer: total training cost remaining + an explanation
    // for the carry stat (which isn't a speed bump).
    const footer = document.createElement("div");
    Object.assign(footer.style, {
      marginTop: "14px", padding: "10px",
      background: "rgba(255,245,220,0.04)",
      border: "1px solid rgba(255,245,220,0.10)",
      borderRadius: "4px",
      fontSize: "11px", lineHeight: "1.5", opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    footer.innerHTML =
      `Training applies to <b>every</b> staff member of that role you've hired, ` +
      `including future hires. The Errand Helper's training raises how much they can ` +
      `bring back in a single auto-shop trip — it's about throughput, not speed.`;
    this.body.appendChild(footer);
  }

  private pretty(id: string): string { return id.replace(/[-_]/g, " "); }
}
