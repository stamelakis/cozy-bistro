import type { Game } from "../game/Game";
import { getIngredientCost } from "../data/ingredients";
import { GLASS_SETS, PLATE_SETS, type DishwareSetDef } from "../data/dishwareCatalog";

/**
 * Pantry browser — full list of stocked ingredients with Ingredient /
 * Unit Cost / Stock columns. Includes the Auto-shop toggle + the
 * inventory-value total. Opens from the HUD's 🧺 icon.
 */
export class PantryModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private totalLine?: HTMLElement;
  private targetValueEl?: HTMLElement;
  private targetMinusBtn?: HTMLButtonElement;
  private targetPlusBtn?: HTMLButtonElement;
  private restockLine?: HTMLElement;
  /** Track last-known quantities so we can flash rows that just went up. */
  private lastQty: Map<string, number> = new Map();
  /** Same idea but for the daily "used" counter — it grows monotonically
   * over the day, so we just flash on increment. */
  private lastUsed: Map<string, number> = new Map();
  /** Map from ingredient id → quantity-cell element. Lets the live refresh
   * mutate just the values without rebuilding the entire row list — keeps
   * scroll position stable and gives us cheap per-row highlight pulses. */
  private qtyEls: Map<string, HTMLElement> = new Map();
  /** Per-row "used today" badge cells (small orange text). */
  private usedTodayEls: Map<string, HTMLElement> = new Map();
  /** Last seen auto-shop wall-clock timestamp, so we re-render the summary
   * line when a fresh restock fires. */
  private lastSeenAutoShopMs = 0;
  /** Interval handle for the live refresh while the modal is visible. */
  private refreshTimer: number | null = null;

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
      width: "min(460px, calc(100vw - 40px))",
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
    title.textContent = "🧺 PANTRY";
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

    // Column headers.
    const headerRow = document.createElement("div");
    Object.assign(headerRow.style, {
      display: "grid",
      gridTemplateColumns: "1fr 60px 50px 50px",
      gap: "10px",
      padding: "4px 6px",
      fontSize: "10px",
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      opacity: "0.65",
      borderBottom: "1px solid rgba(255,245,220,0.18)",
      marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    headerRow.innerHTML = `<span>Ingredient</span><span style="text-align:right">Unit Cost</span><span style="text-align:right">Stock</span><span style="text-align:right">Used</span>`;
    body.appendChild(headerRow);

    this.list = document.createElement("div");
    Object.assign(this.list.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.list);

    // Auto-shop toggle.
    this.toggle = document.createElement("button");
    Object.assign(this.toggle.style, {
      marginTop: "10px",
      padding: "6px 10px",
      background: "rgba(255,245,220,0.10)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      font: "inherit",
      width: "100%",
    } as Partial<CSSStyleDeclaration>);
    this.toggle.onclick = () => { this.game.autoShopEnabled = !this.game.autoShopEnabled; this.refresh(); };
    body.appendChild(this.toggle);

    // Per-ingredient stock-target selector (min 3, default 5). The auto-shop
    // refills toward this many units per ingredient.
    const targetRow = document.createElement("div");
    Object.assign(targetRow.style, {
      display: "flex", alignItems: "center", gap: "8px",
      marginTop: "8px", padding: "6px 10px",
      background: "rgba(255,245,220,0.06)",
      border: "1px solid rgba(255,245,220,0.18)",
      borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    const targetLabel = document.createElement("span");
    targetLabel.textContent = "Stock size per ingredient";
    Object.assign(targetLabel.style, { flex: "1", fontSize: "11px", opacity: "0.85" } as Partial<CSSStyleDeclaration>);
    targetRow.appendChild(targetLabel);
    const mkBumpBtn = (text: string, delta: number): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = text;
      Object.assign(b.style, {
        width: "26px", height: "24px",
        background: "rgba(255,245,220,0.10)", color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.30)", borderRadius: "4px",
        cursor: "pointer", font: "inherit", fontSize: "14px", fontWeight: "700",
      } as Partial<CSSStyleDeclaration>);
      b.onclick = () => { this.game.bumpStockTarget(delta); this.refresh(); };
      return b;
    };
    this.targetMinusBtn = mkBumpBtn("−", -1);
    targetRow.appendChild(this.targetMinusBtn);
    this.targetValueEl = document.createElement("span");
    Object.assign(this.targetValueEl.style, {
      minWidth: "32px", textAlign: "center", fontWeight: "700",
      fontSize: "14px", fontVariantNumeric: "tabular-nums",
    } as Partial<CSSStyleDeclaration>);
    targetRow.appendChild(this.targetValueEl);
    this.targetPlusBtn = mkBumpBtn("+", +1);
    targetRow.appendChild(this.targetPlusBtn);
    body.appendChild(targetRow);

    this.totalLine = document.createElement("div");
    Object.assign(this.totalLine.style, {
      marginTop: "6px", fontSize: "11px", opacity: "0.75",
      textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.totalLine);

    // Last-restock summary — flashes when a new auto-shop fires.
    this.restockLine = document.createElement("div");
    Object.assign(this.restockLine.style, {
      marginTop: "4px", fontSize: "11px", textAlign: "center",
      padding: "4px 6px", borderRadius: "4px",
      transition: "background-color 0.4s ease",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.restockLine);

    // === Dishware section — plates + glasses bought in sets of 4 ===
    this.buildDishwareSection(body);
  }

  // === Dishware shop UI ===
  // Lives inside the Pantry modal so the player has one consumables
  // hub. Each tier of plates / glasses gets a row with the cost, the
  // per-piece satisfaction bonus, and a Buy button that adds 4
  // pieces to the clean pool (subject to the dish-storage cap).

  private dishStatLine?: HTMLElement;
  private dishRowEls: Map<string, { tierLine: HTMLElement; buyBtn: HTMLButtonElement }> = new Map();

  private buildDishwareSection(parent: HTMLElement): void {
    const heading = document.createElement("div");
    heading.textContent = "🍽️ DISHWARE";
    Object.assign(heading.style, {
      marginTop: "14px", fontSize: "12px", fontWeight: "700",
      letterSpacing: "0.04em", textAlign: "center", opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(heading);

    this.dishStatLine = document.createElement("div");
    Object.assign(this.dishStatLine.style, {
      marginTop: "2px", fontSize: "10px", textAlign: "center", opacity: "0.75",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.dishStatLine);

    // Side-by-side plate + glass columns.
    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px",
      marginTop: "6px",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(grid);

    grid.appendChild(this.buildDishwareColumn("Plates", PLATE_SETS));
    grid.appendChild(this.buildDishwareColumn("Glasses", GLASS_SETS));
  }

  private buildDishwareColumn(label: string, sets: readonly DishwareSetDef[]): HTMLElement {
    const col = document.createElement("div");
    Object.assign(col.style, {
      display: "flex", flexDirection: "column", gap: "3px",
      padding: "6px 8px",
      background: "rgba(255,245,220,0.04)",
      border: "1px solid rgba(255,245,220,0.14)",
      borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    const header = document.createElement("div");
    header.textContent = label;
    Object.assign(header.style, {
      fontSize: "10px", fontWeight: "700", opacity: "0.85",
      letterSpacing: "0.04em",
    } as Partial<CSSStyleDeclaration>);
    col.appendChild(header);
    for (const set of sets) {
      col.appendChild(this.buildDishwareRow(set));
    }
    return col;
  }

  private buildDishwareRow(set: DishwareSetDef): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "26px 1fr 42px",
      alignItems: "center", gap: "4px",
      padding: "2px 2px",
      borderBottom: "1px solid rgba(255,245,220,0.05)",
    } as Partial<CSSStyleDeclaration>);
    const tierBadge = document.createElement("span");
    tierBadge.textContent = `T${set.tier}`;
    Object.assign(tierBadge.style, {
      fontSize: "10px", fontWeight: "700", opacity: "0.7", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    const tierLine = document.createElement("span");
    Object.assign(tierLine.style, {
      fontSize: "10px", lineHeight: "1.2",
    } as Partial<CSSStyleDeclaration>);
    // Initial text gets populated by refreshDishware so it reflects
    // current ownership immediately.
    tierLine.textContent = set.name;
    const buyBtn = document.createElement("button");
    // Just the price — the per-click quantity is shown in the row
    // text now ("×4") so there's no value to repeating it here.
    buyBtn.textContent = `$${set.cost}`;
    Object.assign(buyBtn.style, {
      background: "rgba(255,245,220,0.10)", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.28)", borderRadius: "3px",
      cursor: "pointer", font: "inherit", fontSize: "10px",
      padding: "3px 4px",
    } as Partial<CSSStyleDeclaration>);
    buyBtn.title = `Buy a set of ${set.setSize} ${set.name.toLowerCase()} for $${set.cost}` +
      (set.satisfactionPerPiece > 0
        ? ` · +${set.satisfactionPerPiece.toFixed(1)} satisfaction per piece served`
        : "");
    buyBtn.onclick = () => this.handleBuyDishSet(set);
    row.appendChild(tierBadge);
    row.appendChild(tierLine);
    row.appendChild(buyBtn);
    this.dishRowEls.set(set.id, { tierLine, buyBtn });
    return row;
  }

  private handleBuyDishSet(set: DishwareSetDef): void {
    // Luxury-tier gate — match the recipe + furniture unlock pattern.
    // T2+ dishware needs the player to have expanded to that tier.
    if (set.tier > this.game.getLuxuryTier()) {
      this.flashRow(set.id, "rgba(220, 120, 120, 0.45)");
      return;
    }
    const free = this.game.dishware.getFreeCapacity();
    if (free < set.setSize) {
      this.flashRow(set.id, "rgba(220, 120, 120, 0.45)");
      return;
    }
    if (!this.game.economy.spendMoney(set.cost, "ingredients")) {
      this.flashRow(set.id, "rgba(220, 120, 120, 0.45)");
      return;
    }
    const added = this.game.dishware.buySet(set);
    if (added === 0) {
      // Capacity changed between the check and the call — refund.
      this.game.economy.earnMoney(set.cost, "payment");
      this.flashRow(set.id, "rgba(220, 120, 120, 0.45)");
      return;
    }
    this.flashRow(set.id, "rgba(120, 220, 120, 0.45)");
    this.refreshDishware();
  }

  /** Flash a single dishware row's tier line so the click feels reactive. */
  private flashRow(setId: string, color: string): void {
    const entry = this.dishRowEls.get(setId);
    if (!entry) return;
    entry.tierLine.style.transition = "background-color 0.2s ease";
    entry.tierLine.style.background = color;
    window.setTimeout(() => { entry.tierLine.style.background = "transparent"; }, 500);
  }

  /** Rewrites the per-row name + ownership tag (× count) and updates
   * the summary header. Cheap — called every tick the modal is open. */
  private refreshDishware(): void {
    const dish = this.game.dishware;
    const plateClean = dish.getClean("plate");
    const plateDirty = dish.getDirty("plate");
    const glassClean = dish.getClean("glass");
    const glassDirty = dish.getDirty("glass");
    const stored = dish.getTotalOwned();
    const cap = dish.getCapacity();
    if (this.dishStatLine) {
      const dirty = plateDirty + glassDirty;
      const dirtyStr = dirty > 0 ? ` · ${dirty} dirty` : "";
      this.dishStatLine.textContent =
        `${plateClean} plates clean · ${glassClean} glasses clean · ${stored}/${cap} stored${dirtyStr}`;
    }
    const playerTier = this.game.getLuxuryTier();
    for (const set of [...PLATE_SETS, ...GLASS_SETS]) {
      const entry = this.dishRowEls.get(set.id);
      if (!entry) continue;
      const bonusTag = set.satisfactionPerPiece > 0
        ? ` <span style="opacity:0.6">+${set.satisfactionPerPiece.toFixed(1)}</span>`
        : "";
      // Set size — "what you'd buy with one click" — is the most useful
      // number on a per-row basis. Current ownership ("×44") was easy
      // to mistake for the buy quantity, so it lives only in the
      // summary line above the section now.
      const buyTag = ` <span style="opacity:0.6">×${set.setSize}</span>`;
      const locked = set.tier > playerTier;
      // Locked tiers grey out the name + show a 🔒 button instead of
      // the price. Matches how the build menu / recipe upgrades behave
      // — the player has to expand to unlock the tier first.
      entry.tierLine.innerHTML = `${set.name}${bonusTag}${buyTag}`;
      entry.tierLine.style.opacity = locked ? "0.45" : "1";
      const free = dish.getFreeCapacity();
      const canFit = free >= set.setSize;
      const canAfford = this.game.economy.getMoney() >= set.cost;
      const enabled = !locked && canFit && canAfford;
      entry.buyBtn.disabled = !enabled;
      entry.buyBtn.style.opacity = enabled ? "1" : "0.35";
      entry.buyBtn.style.cursor = enabled ? "pointer" : "not-allowed";
      // Just the price — the per-click ×4 lives in the row text now.
      entry.buyBtn.textContent = locked ? "🔒" : `$${set.cost}`;
      entry.buyBtn.title = locked
        ? `Tier ${set.tier} dishware unlocks when you expand to Luxury Tier ${set.tier}.`
        : !canFit
        ? `No room for ${set.setSize} more — buy more cabinets first.`
        : !canAfford
        ? `Need $${set.cost} (have $${this.game.economy.getMoney()}).`
        : `Buy a set of ${set.setSize} ${set.name.toLowerCase()} for $${set.cost}` +
          (set.satisfactionPerPiece > 0
            ? ` · +${set.satisfactionPerPiece.toFixed(1)} satisfaction per piece served`
            : "");
    }
  }

  show(): void {
    this.refresh();
    this.root.style.display = "flex";
    // Live-refresh while open so the player can watch the auto-shop
    // increment ingredients in real time. 400ms is fast enough that a
    // single auto-shop tick (every 4 game-sec) is visible immediately,
    // cheap enough to not churn the DOM.
    if (this.refreshTimer == null) {
      this.refreshTimer = window.setInterval(() => this.tickRefresh(), 400);
    }
  }

  hide(): void {
    this.root.style.display = "none";
    if (this.refreshTimer != null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Cheap live update — mutates the quantity cells, the per-row
   * "consumed today" badge, and the restock summary. The full rebuild
   * only fires on show() / target bump. */
  private tickRefresh(): void {
    const pantry = this.game.cooking.getPantry();
    let totalValue = 0;
    for (const stock of pantry) {
      const cost = getIngredientCost(stock.id);
      totalValue += cost * stock.quantity;
      const qtyEl = this.qtyEls.get(stock.id);
      if (qtyEl) {
        const prev = this.lastQty.get(stock.id) ?? stock.quantity;
        const pending = this.game.cooking.getPendingForIngredient(stock.id);
        const text = pending > 0
          ? `${stock.quantity} +${pending}`
          : String(stock.quantity);
        if (qtyEl.textContent !== text) {
          qtyEl.textContent = text;
          if (stock.quantity > prev) this.pulseRow(qtyEl);
        }
        qtyEl.style.color = stock.quantity === 0 ? "#ff9a9a"
          : stock.quantity <= 3 ? "#ffd47a"
          : "#a8e2a8";
        this.lastQty.set(stock.id, stock.quantity);
      }
      const usedEl = this.usedTodayEls.get(stock.id);
      if (usedEl) {
        const used = this.game.cooking.getConsumedToday(stock.id);
        const prevUsed = this.lastUsed.get(stock.id) ?? used;
        if (used !== prevUsed) {
          usedEl.textContent = used > 0 ? `−${used}` : "";
          if (used > prevUsed) this.pulseRow(usedEl, "rgba(220, 170, 100, 0.45)");
          this.lastUsed.set(stock.id, used);
        }
      }
    }
    if (this.totalLine) {
      const totalUsed = this.game.cooking.getTotalConsumedToday();
      this.totalLine.textContent = totalUsed > 0
        ? `Inventory value: $${totalValue} · used today: ${totalUsed}`
        : `Inventory value: $${totalValue}`;
    }
    this.updateRestockSummary();
    this.refreshDishware();
  }

  /** Briefly flash an element's background to draw the eye to a change.
   * Default color is the green "restock" pulse; pass a custom rgba for
   * other event types (e.g. orange for "just got consumed"). */
  private pulseRow(el: HTMLElement, color = "rgba(120, 220, 120, 0.45)"): void {
    el.style.transition = "background-color 0.2s ease";
    el.style.background = color;
    window.setTimeout(() => {
      el.style.background = "transparent";
    }, 500);
  }

  /** Render the "Last restock: …" line + a fade-from-green pulse whenever
   * a fresh auto-shop fires. */
  private updateRestockSummary(): void {
    if (!this.restockLine) return;
    const last = this.game.getLastAutoShop();
    if (!last) {
      this.restockLine.textContent = "Waiting for first auto-shop…";
      this.restockLine.style.opacity = "0.55";
      this.restockLine.style.background = "transparent";
      this.restockLine.style.color = "#fff5dc";
      return;
    }
    const isNew = last.atMs !== this.lastSeenAutoShopMs;
    if (isNew) {
      this.lastSeenAutoShopMs = last.atMs;
      this.restockLine.style.background = "rgba(120, 200, 120, 0.30)";
      window.setTimeout(() => {
        if (this.restockLine) this.restockLine.style.background = "transparent";
      }, 800);
    }
    const ageS = Math.max(0, Math.round((Date.now() - last.atMs) / 1000));
    const ageStr = ageS < 60 ? `${ageS}s ago` : `${Math.round(ageS / 60)}m ago`;
    const plural = last.itemCount === 1 ? "item" : "items";
    this.restockLine.style.opacity = "1";
    this.restockLine.style.color = "#d6f0c8";
    this.restockLine.textContent = `🛒 Last restock: $${last.totalSpent} on ${last.itemCount} ${plural} · ${ageStr}`;
  }

  private refresh(): void {
    const pantry = this.game.cooking.getPantry().slice()
      .sort((a, b) => getIngredientCost(b.id) - getIngredientCost(a.id) || a.name.localeCompare(b.name));
    this.list.innerHTML = "";
    this.qtyEls.clear();
    this.usedTodayEls.clear();
    let totalValue = 0;
    for (const stock of pantry) {
      const cost = getIngredientCost(stock.id);
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "grid",
        gridTemplateColumns: "1fr 60px 50px 50px",
        gap: "10px",
        padding: "4px 6px",
        borderBottom: "1px solid rgba(255,245,220,0.06)",
        fontVariantNumeric: "tabular-nums",
      } as Partial<CSSStyleDeclaration>);
      const nameEl = document.createElement("span");
      nameEl.textContent = stock.name;
      const costEl = document.createElement("span");
      costEl.textContent = `$${cost}`;
      costEl.style.textAlign = "right";
      costEl.style.opacity = "0.85";
      const qtyEl = document.createElement("span");
      qtyEl.textContent = String(stock.quantity);
      qtyEl.style.textAlign = "right";
      qtyEl.style.fontWeight = "700";
      qtyEl.style.color = stock.quantity === 0 ? "#ff9a9a"
        : stock.quantity <= 3 ? "#ffd47a"
        : "#a8e2a8";
      // "Used today" badge — orange minus-count, blank when none used yet.
      const usedToday = this.game.cooking.getConsumedToday(stock.id);
      const usedEl = document.createElement("span");
      usedEl.textContent = usedToday > 0 ? `−${usedToday}` : "";
      usedEl.style.textAlign = "right";
      usedEl.style.fontWeight = "600";
      usedEl.style.color = "#e0a050";
      usedEl.style.fontSize = "11px";
      row.appendChild(nameEl);
      row.appendChild(costEl);
      row.appendChild(qtyEl);
      row.appendChild(usedEl);
      this.list.appendChild(row);
      this.qtyEls.set(stock.id, qtyEl);
      this.usedTodayEls.set(stock.id, usedEl);
      this.lastQty.set(stock.id, stock.quantity);
      this.lastUsed.set(stock.id, usedToday);
      totalValue += cost * stock.quantity;
    }
    this.updateRestockSummary();
    this.toggle.textContent = this.game.autoShopEnabled ? "Auto-shop: ON" : "Auto-shop: OFF";
    this.toggle.style.background = this.game.autoShopEnabled
      ? "rgba(120, 200, 120, 0.18)" : "rgba(200, 120, 120, 0.18)";
    if (this.targetValueEl) {
      this.targetValueEl.textContent = String(this.game.getStockTarget());
    }
    if (this.targetMinusBtn) {
      const atMin = this.game.getStockTarget() <= this.game.getMinStockTarget();
      this.targetMinusBtn.disabled = atMin;
      this.targetMinusBtn.style.opacity = atMin ? "0.35" : "1";
    }
    if (this.targetPlusBtn) {
      const atMax = this.game.getStockTarget() >= this.game.getMaxStockTarget();
      this.targetPlusBtn.disabled = atMax;
      this.targetPlusBtn.style.opacity = atMax ? "0.35" : "1";
    }
    if (this.totalLine) this.totalLine.textContent = `Inventory value: $${totalValue}`;
    this.refreshDishware();
  }
}
