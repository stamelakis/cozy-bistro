import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";
import type { LuxuryTier } from "../data/types";
import { STAFF_UPGRADE_MAX, getTrainingDurationHours, type StaffRole } from "../systems/StaffSystem";
import { ingredientIcon, recipeIcon } from "./foodIcons";

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

  /** Phase I (UX) — 1 Hz tickers for "🧪 Cooking Ns" and "📚 Training Ns"
   * labels.  refresh() rebuilds this list as it renders each in-flight
   * row; show() kicks off a 1 s setInterval that calls each ticker.
   * Each ticker returns `true` when the deadline elapses so the modal
   * can refresh() once to flip the row back from "Cooking" / "Training"
   * to the regular Upgrade / Train button.  Without this, the timer
   * label was static — players had to close + reopen the modal to see
   * the countdown move.
   *
   * Stored as () => boolean (true = expired) instead of () => void
   * so the tick batcher can collapse multiple expirations into one
   * refresh() at the end of the tick rather than refreshing mid-walk
   * (which would invalidate the updaters array we're still iterating). */
  private countdownUpdaters: Array<() => boolean> = [];
  private countdownInterval: number | null = null;

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

  show(): void {
    this.refresh();
    this.root.style.display = "flex";
    // Phase I (UX) — kick off 1 Hz countdown refresh.  Stays running
    // only while the modal is visible (cleared in hide()).
    if (this.countdownInterval === null) {
      this.countdownInterval = window.setInterval(() => this.tickCountdowns(), 1000);
    }
  }
  hide(): void {
    this.root.style.display = "none";
    if (this.countdownInterval !== null) {
      window.clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  /** Phase I (UX) — called once per second while the modal is open.
   * Runs every registered countdown updater.  If any reported expired
   * (return value true), refresh() the whole modal so the row that
   * just finished flips back to its Upgrade / Train button. */
  private tickCountdowns(): void {
    let needsFullRefresh = false;
    for (const update of this.countdownUpdaters) {
      try { if (update()) needsFullRefresh = true; }
      catch (e) { console.warn("[UpgradeModal] countdown updater threw:", e); }
    }
    if (needsFullRefresh) this.refresh();
  }

  private refresh(): void {
    // Phase I (UX) — drop any countdown updaters from the previous
    // render.  Each render pass registers fresh closures bound to
    // the row elements that were just created.
    this.countdownUpdaters = [];
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
    const baseProfits = ([1, 2, 3, 4, 5] as const).map((t) => this.game.getTierBaseProfit(t));
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
      // Plate icon leads the head row so the player can pick out the
      // dish at a glance, same as on the MenuPanel.
      const head = document.createElement("div");
      head.innerHTML = `<span style="font-size:16px;margin-right:6px;vertical-align:-2px;">${recipeIcon(recipe.id)}</span><span style="display:inline-block;font-size:10px;padding:2px 6px;border-radius:3px;background:${lvlBg};color:${lvlColor};font-weight:800;margin-right:6px;">L${level}</span><b>${recipe.name}</b>${activeChip} &nbsp; <span style="color:#a8e2a8">$${price}</span> <span style="opacity:0.55">(+$${profit})</span> · ${sat}😋`;
      label.appendChild(head);
      if (level < 10) {
        const mats = this.game.getRecipeUpgradeMaterials(recipe);
        const matText = mats.map((m) => {
          const have = this.game.cooking.getIngredientQuantity(m.id);
          const short = have >= m.qty ? "" : ` (need ${m.qty - have})`;
          const color = have >= m.qty ? "#9be09b" : "#ff9a9a";
          // Ingredient icon so the materials list is visually scannable
          // without reading every label.
          return `<span style="color:${color}">${ingredientIcon(m.id)} ${this.pretty(m.id)}×${m.qty}${short}</span>`;
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
      } else if (this.game.isRecipeTraining(recipe)) {
        // This specific recipe is mid-upgrade — countdown instead of
        // the Upgrade button.  Phase I (UX) — wrap the label compute
        // in a closure registered with countdownUpdaters so the
        // 1 Hz tick refreshes "Ns" without rebuilding the row.
        const updateRecipeCooking = (): boolean => {
          const remaining = this.game.getRecipeTrainingRemainingSeconds(recipe) ?? 0;
          btn.innerHTML = `🧪 Cooking<br><span style="font-size:10px;opacity:0.85">${formatHM(remaining)}</span>`;
          return remaining <= 0; // signals "expired → please refresh"
        };
        updateRecipeCooking();
        this.countdownUpdaters.push(updateRecipeCooking);
        btn.disabled = true;
        btn.style.opacity = "0.7";
        btn.style.background = "rgba(120, 160, 220, 0.22)";
      } else {
        const moneyCost = this.game.getRecipeUpgradeCost(recipe);
        const durationMin = this.game.getRecipeUpgradeDurationMinutes(recipe);
        const otherTrainingId = this.game.getCurrentlyTrainingRecipeId();
        const someoneElseTraining = otherTrainingId !== null && otherTrainingId !== recipe.id;
        if (someoneElseTraining) {
          const other = this.game.cooking
            ? recipes.find((r) => r.id === otherTrainingId)
            : undefined;
          btn.innerHTML = `🧪 Busy<br><span style="font-size:10px;opacity:0.85">$${moneyCost} · ${formatMinutes(durationMin)}</span>`;
          btn.title = other
            ? `${other.name} is being developed — only one recipe at a time`
            : "Another recipe is being developed";
          btn.disabled = true;
          btn.style.opacity = "0.5";
        } else {
          btn.innerHTML = `Upgrade<br><span style="font-size:10px;opacity:0.85">$${moneyCost} · ${formatMinutes(durationMin)}</span>`;
          btn.title = `Spend $${moneyCost} + materials and wait ${formatMinutes(durationMin)} (real time) to reach L${level + 1}`;
          const can = this.game.canUpgradeRecipe(recipe);
          btn.disabled = !can;
          btn.style.opacity = can ? "1" : "0.5";
          btn.onclick = () => { if (this.game.upgradeRecipe(recipe)) this.refresh(); };
        }
      }
      row.appendChild(btn);
      this.body.appendChild(row);
    }
  }

  /** Render the Staff tab: ONE row per hired member with their name,
   * role, current training level, the next-level effect preview, the
   * cost, and a Train button. Each row trains that single person —
   * upgrades no longer apply to the whole role. */
  private renderStaffContent(): void {
    this.body.innerHTML = "";
    const roleMeta: Record<StaffRole, { emoji: string; label: string; stat: string;
                                        current: (lv: number) => string;
                                        next: (lv: number) => string }> = {
      chef: {
        emoji: "🧑‍🍳", label: "Chef", stat: "cook speed",
        current: (lv) => `Cooks at ${100 - 3 * lv}% of base time`,
        next: (lv) => `→ ${100 - 3 * (lv + 1)}% (-3% cook time)`,
      },
      waiter: {
        emoji: "🍽️", label: "Waiter", stat: "serve speed",
        current: (lv) => `Walks at ${100 + 3 * lv}% of base speed`,
        next: (lv) => `→ ${100 + 3 * (lv + 1)}% (+3% serve speed)`,
      },
      barman: {
        // Same training curve as the chef — training shaves drink mix
        // time the same way it shaves cook time. The visual + label is
        // bar-themed so the player doesn't confuse training screens.
        emoji: "🍸", label: "Barman", stat: "mix speed",
        current: (lv) => `Mixes at ${100 - 3 * lv}% of base time`,
        next: (lv) => `→ ${100 - 3 * (lv + 1)}% (-3% mix time)`,
      },
      errand: {
        emoji: "📦", label: "Errand Helper", stat: "carry capacity",
        current: (lv) => `Carries ${10 + 2 * lv} units per trip`,
        next: (lv) => `→ ${10 + 2 * (lv + 1)} units per trip (+2)`,
      },
    };

    const players = this.game.staff.getMembers();
    if (players.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No staff hired yet.";
      empty.style.opacity = "0.6";
      empty.style.textAlign = "center";
      empty.style.padding = "30px";
      this.body.appendChild(empty);
      return;
    }

    // Sort: chef → waiter → errand, within role by name.
    const order: Record<StaffRole, number> = { chef: 0, barman: 1, waiter: 2, errand: 3 };
    const sorted = [...players].sort((a, b) =>
      (order[a.role] - order[b.role]) || a.name.localeCompare(b.name),
    );

    for (const m of sorted) {
      const meta = roleMeta[m.role];
      const level = m.upgradeLevel;
      const maxed = level >= STAFF_UPGRADE_MAX;

      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "12px",
        padding: "10px 8px",
        borderBottom: "1px solid rgba(255,245,220,0.08)",
      } as Partial<CSSStyleDeclaration>);

      const label = document.createElement("div");
      label.style.flex = "1";
      const lvlBg = maxed ? "#f5c14a" : level > 0 ? "#7a9a6a" : "#4a4137";
      const lvlColor = level > 0 ? "#fff" : "#cbb";
      const head = document.createElement("div");
      head.innerHTML =
        `<span style="display:inline-block;font-size:10px;padding:2px 6px;border-radius:3px;background:${lvlBg};color:${lvlColor};font-weight:800;margin-right:6px;">L${level}/${STAFF_UPGRADE_MAX}</span>` +
        `<b>${meta.emoji} ${m.name}</b>` +
        ` <span style="opacity:0.65;font-size:11px;">— ${meta.label} (${meta.stat})</span>`;
      label.appendChild(head);

      const detail = document.createElement("div");
      Object.assign(detail.style, { fontSize: "11px", marginTop: "4px", opacity: "0.9" } as Partial<CSSStyleDeclaration>);
      const currentLine = `<span style="opacity:0.7">Now:</span> ${meta.current(level)}`;
      const nextLine = maxed
        ? `<span style="color:#f5c14a">Fully trained</span>`
        : `<span style="color:#a8e2a8">${meta.next(level)}</span>`;
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
      } else if (this.game.isMemberTraining(m.id)) {
        // In-flight training — show a countdown instead of the Train
        // button. Update the row label too so the "now / next" text
        // reads "Training to L(n+1)".  Phase I (UX) — wrap both the
        // button label and the detail row in a closure registered
        // with countdownUpdaters so the "Ns left" updates live.
        const targetLevel = level + 1;
        const hours = getTrainingDurationHours(targetLevel);
        const updateMemberTraining = (): boolean => {
          const remaining = this.game.getMemberTrainingRemainingSeconds(m.id) ?? 0;
          btn.innerHTML = `📚 Training<br><span style="font-size:10px;opacity:0.85">${formatHM(remaining)}</span>`;
          // Replace the "next" preview line with the target level + the
          // expected total duration so the player sees the deal.
          detail.innerHTML =
            `<span style="opacity:0.7">Now:</span> ${meta.current(level)} ` +
            `&nbsp; · &nbsp; ` +
            `<span style="color:#a8d4f0">📚 Training to L${targetLevel} — ${hours}h real, ${formatHM(remaining)} left</span>`;
          return remaining <= 0; // expired → caller will refresh()
        };
        updateMemberTraining();
        this.countdownUpdaters.push(updateMemberTraining);
        btn.disabled = true;
        btn.style.opacity = "0.7";
        btn.style.background = "rgba(120, 160, 220, 0.22)";
      } else {
        const cost = this.game.getMemberUpgradeCost(m.id);
        const requiredTier = this.game.getMemberUpgradeRequiredTier(m.id);
        const playerTier = this.game.getLuxuryTier();
        const tierLocked = requiredTier !== null && requiredTier > playerTier;
        const targetLevel = level + 1;
        const hours = getTrainingDurationHours(targetLevel);
        // Lockout when someone ELSE is mid-training — the school only
        // has one chair, you can train only one staff member at a time.
        const otherTrainingId = this.game.getCurrentlyTrainingMemberId();
        const someoneElseTraining = otherTrainingId !== null && otherTrainingId !== m.id;
        const costLabel = compactDollars(cost);
        if (tierLocked) {
          btn.innerHTML = `🔒 Tier ${requiredTier}<br><span style="font-size:10px;opacity:0.85">${costLabel} · ${hours}h</span>`;
          btn.title = `Requires restaurant tier ${requiredTier} (you're on ${playerTier})`;
        } else if (someoneElseTraining) {
          const other = this.game.staff.getMember(otherTrainingId!);
          btn.innerHTML = `📚 Busy<br><span style="font-size:10px;opacity:0.85">${costLabel} · ${hours}h</span>`;
          btn.title = other
            ? `${other.name} is currently training — only one staff member at a time`
            : "Someone else is currently training";
        } else {
          btn.innerHTML = `Train<br><span style="font-size:10px;opacity:0.85">${costLabel} · ${hours}h</span>`;
          btn.title = `Spend $${cost.toLocaleString()} and wait ${hours} real hours to reach L${targetLevel}`;
        }
        const can = this.game.canUpgradeMember(m.id);
        btn.disabled = !can;
        btn.style.opacity = can ? "1" : "0.5";
        btn.onclick = () => { if (this.game.upgradeMember(m.id)) this.refresh(); };
      }
      row.appendChild(btn);
      this.body.appendChild(row);
    }

    const footer = document.createElement("div");
    Object.assign(footer.style, {
      marginTop: "14px", padding: "10px",
      background: "rgba(255,245,220,0.04)",
      border: "1px solid rgba(255,245,220,0.10)",
      borderRadius: "4px",
      fontSize: "11px", lineHeight: "1.5", opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    footer.innerHTML =
      `Training affects <b>only that person</b>. Costs <b>4× per level</b> ` +
      `($500 / $2k / $8k / $32k / $128k) and runs on a <b>real-time</b> clock ` +
      `(3h / 6h / 12h / 24h / 48h) — closing the tab, pausing, or fast-forwarding ` +
      `in-game time won't speed it up. Only <b>one</b> staff member can train at ` +
      `a time. The Errand Helper's training raises the auto-shop's carry cap.`;
    this.body.appendChild(footer);
  }

  private pretty(id: string): string { return id.replace(/[-_]/g, " "); }
}

/** Compact currency: $500, $2k, $8k, $32k, $128k. End-game training
 * costs blow past 5 digits so the full $128,000 doesn't fit on the
 * Train button — abbreviate above $1000. */
function compactDollars(amount: number): string {
  if (amount < 1000) return `$${amount}`;
  if (amount < 1_000_000) {
    const k = amount / 1000;
    return Number.isInteger(k) ? `$${k}k` : `$${k.toFixed(1)}k`;
  }
  const m = amount / 1_000_000;
  return Number.isInteger(m) ? `$${m}M` : `$${m.toFixed(1)}M`;
}

/** Format a duration given in MINUTES as "Xm" or "Xh Ym" — used on
 * the recipe Upgrade button which carries durations like 1m, 16m,
 * 256m, etc. */
function formatMinutes(totalMinutes: number): string {
  if (totalMinutes < 60) {
    const m = Math.round(totalMinutes * 10) / 10;
    return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes - hours * 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Format a duration in REAL seconds as "Xh Ym" / "Xm Ys". Training
 * deadlines are wall-clock now, so this is straightforward
 * seconds → hours/minutes/seconds. */
function formatHM(realSeconds: number): string {
  const totalMinutes = Math.floor(realSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  const seconds = Math.max(0, Math.round(realSeconds - totalMinutes * 60));
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}
