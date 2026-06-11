import type { Game } from "../game/Game";
import { getIngredientCost } from "../data/ingredients";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { GLASS_SETS, PLATE_SETS, type DishKind } from "../data/dishwareCatalog";

/**
 * Compact at-a-glance ingredient status panel that sits above the
 * StaffPanel.
 *
 * Layout (always five lines — the widget NEVER changes height):
 *   📦 STOCK
 *   📋 6 below target · 16 used today
 *   🛒 Auto-shop ON · 7 in transit
 *   ❄️ Storage 14/18 per item
 *   🍳 5 queued · 0 cooking · 0 delivering
 *
 * Hovering the 📋 or ❄️ row pops a floating tooltip after a 1s delay
 * with the detail breakdown. The tooltip is appended to document.body
 * and positioned with `position: fixed`, so showing it never reflows
 * the sidebar — the widget stays the same size at all times.
 *
 * The summary line reflects the worst severity (OUT / LOW / below
 * target / all good); its color reads at a glance.
 *
 * DOM is built once in the constructor — update() only rewrites text
 * content. That way the floating tooltip can stay open across ticks
 * without snapping shut, and any scrolling the player has done inside
 * the tooltip is preserved.
 */
export class StockStatusWidget {
  private readonly game: Game;
  private readonly root: HTMLElement;

  private readonly needRow: HTMLElement;
  private readonly needBadge: HTMLElement;
  private readonly needCaret: HTMLElement;
  private readonly needTooltip: HTMLElement;
  private readonly autoShop: HTMLElement;
  private readonly dishRow: HTMLElement;
  private readonly dishBadge: HTMLElement;
  private readonly dishCaret: HTMLElement;
  private readonly dishTooltip: HTMLElement;
  private readonly storageRow: HTMLElement;
  private readonly storageBadge: HTMLElement;
  private readonly storageCaret: HTMLElement;
  private readonly storageTooltip: HTMLElement;
  private readonly pipeline: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      font: "11px/1.3 system-ui, sans-serif",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    // Phase I (H.81) — Reorganized layout into three labelled
    // sections so the player can tell ingredient stock, dishware
    // stock, and kitchen pipeline apart at a glance:
    //
    //   ─── 🥫 INGREDIENTS ───
    //   145 / 2400 · cap 30/item          ← storage badge (clickable)
    //   ⚠ OUT: 3 · LOW: 2 · 18 used today ← need badge (clickable)
    //   🛒 Auto-shop ON · 7 in transit
    //
    //   ─── 🍽 DISHWARE ───
    //   35 plates (3 dirty) · 14 glasses  ← dish badge (clickable)
    //
    //   ─── 🍳 KITCHEN ───
    //   5 queued · 0 cooking · 2 delivering

    // Phase I (H.97) — Three labelled CARDS instead of free-flowing
    // text with thin separators. Each card has its own tinted
    // background, accent-colored left border, and padded inset so
    // the three sub-panels read as distinct blocks.
    const ingredientsCard = makeSectionCard("🥫 INGREDIENTS", "rgba(255,200,90,0.7)");

    // Storage badge moved to TOP of ingredients section — that's the
    // "how full is my pantry" headline number the user wanted to see
    // first.
    this.storageRow = makeHoverRow();
    this.storageBadge = document.createElement("span");
    this.storageCaret = makeCaret();
    this.storageRow.appendChild(this.storageBadge);
    this.storageRow.appendChild(this.storageCaret);
    ingredientsCard.appendChild(this.storageRow);
    this.storageTooltip = makeFloatingTooltip();
    document.body.appendChild(this.storageTooltip);
    attachHoverTooltip(this.storageRow, this.storageTooltip, this.storageCaret);

    // Need badge — warnings about specific ingredients.
    this.needRow = makeHoverRow();
    this.needBadge = document.createElement("span");
    this.needCaret = makeCaret();
    this.needRow.appendChild(this.needBadge);
    this.needRow.appendChild(this.needCaret);
    ingredientsCard.appendChild(this.needRow);
    this.needTooltip = makeFloatingTooltip();
    document.body.appendChild(this.needTooltip);
    attachHoverTooltip(this.needRow, this.needTooltip, this.needCaret);

    this.autoShop = document.createElement("div");
    Object.assign(this.autoShop.style, {
      fontSize: "10px", marginTop: "1px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    ingredientsCard.appendChild(this.autoShop);
    this.root.appendChild(ingredientsCard);

    const dishwareCard = makeSectionCard("🍽 DISHWARE", "rgba(170,200,255,0.7)");

    this.dishRow = makeHoverRow();
    this.dishBadge = document.createElement("span");
    this.dishCaret = makeCaret();
    this.dishRow.appendChild(this.dishBadge);
    this.dishRow.appendChild(this.dishCaret);
    dishwareCard.appendChild(this.dishRow);
    this.dishTooltip = makeFloatingTooltip();
    document.body.appendChild(this.dishTooltip);
    attachHoverTooltip(this.dishRow, this.dishTooltip, this.dishCaret);
    this.root.appendChild(dishwareCard);

    const kitchenCard = makeSectionCard("🍳 KITCHEN", "rgba(140,210,140,0.7)");

    this.pipeline = document.createElement("div");
    Object.assign(this.pipeline.style, {
      fontSize: "10px", textAlign: "center", opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    kitchenCard.appendChild(this.pipeline);
    this.root.appendChild(kitchenCard);

    this.update();
  }

  update(): void {
    const pantry = this.game.cooking.getPantry();
    const target = this.game.getStockTarget();

    // Severity buckets.
    const out = pantry.filter((s) => s.quantity === 0)
      .sort((a, b) => getIngredientCost(b.id) - getIngredientCost(a.id));
    const low = pantry.filter((s) => s.quantity > 0 && s.quantity <= 2)
      .sort((a, b) => a.quantity - b.quantity);
    const usedToday = this.game.cooking.getTotalConsumedToday();

    // Below-target detail rows. Inclusion is qty<target (not
    // qty+pending<target) so a currently-empty shelf is listed even
    // when a helper's already running to refill it — the player needs
    // to see it's empty NOW.
    const needRows: string[] = [];
    for (const s of pantry) {
      if (s.quantity >= target) continue;
      const way = this.game.cooking.getPendingForIngredient(s.id);
      const need = target - s.quantity;
      const wayStr = way > 0 ? `, way ${way}` : "";
      needRows.push(`<div>${s.name}: need ${need} <span style="opacity:0.7">(have ${s.quantity}${wayStr})</span></div>`);
    }

    // === Need badge ===
    const usedTodaySpan = usedToday > 0
      ? ` <span style="opacity:0.65">· ${usedToday} used today</span>`
      : "";
    if (out.length > 0) {
      const lowSuffix = low.length > 0
        ? ` · <span style="color:#ffd47a">LOW: ${low.length}</span>`
        : "";
      this.needBadge.innerHTML =
        `<span style="color:#ff9a9a;font-weight:700">⚠ OUT:</span>` +
        ` <span style="color:#ff9a9a;font-weight:700">${out.length}</span>` +
        lowSuffix + usedTodaySpan;
    } else if (low.length > 0) {
      const belowExtra = needRows.length - low.length;
      const belowSuffix = belowExtra > 0
        ? ` <span style="opacity:0.7">· ${belowExtra} below target</span>`
        : "";
      this.needBadge.innerHTML =
        `<span style="color:#ffd47a;font-weight:700">LOW:</span>` +
        ` <span style="color:#ffd47a;font-weight:700">${low.length}</span>` +
        belowSuffix + usedTodaySpan;
    } else if (needRows.length > 0) {
      this.needBadge.innerHTML =
        `<span style="color:#ffd47a">📋 ${needRows.length} below target</span>` +
        usedTodaySpan;
    } else {
      this.needBadge.innerHTML = `<span style="color:#a8e2a8">✓ All stocked</span>${usedTodaySpan}`;
    }

    // === Need tooltip body ===
    // Preserve scroll position across ticks so the player can read
    // through a long list without it snapping back to the top.
    const needScroll = this.needTooltip.scrollTop;
    if (needRows.length === 0) {
      this.needTooltip.innerHTML =
        `<div style="font-weight:700;margin-bottom:3px">📋 In Need</div>` +
        `<div style="opacity:0.7">All ingredients at target.</div>`;
      this.needCaret.style.visibility = "hidden";
      this.needRow.style.cursor = "default";
    } else {
      this.needTooltip.innerHTML =
        `<div style="font-weight:700;margin-bottom:3px">📋 In Need</div>` +
        needRows.join("");
      this.needCaret.style.visibility = "visible";
      this.needRow.style.cursor = "help";
    }
    this.needTooltip.scrollTop = needScroll;

    // === Auto-shop status ===
    if (this.game.autoShopEnabled) {
      let totalPending = 0;
      const pending = this.game.cooking.getPendingOrdersSnapshot();
      for (const id of Object.keys(pending)) totalPending += pending[id];
      this.autoShop.style.opacity = "0.85";
      this.autoShop.style.color = "";
      this.autoShop.innerHTML = totalPending > 0
        ? `🛒 Auto-shop ON · <span style="color:#a8c8e8">${totalPending} in transit</span>`
        : "🛒 Auto-shop ON";
    } else {
      this.autoShop.style.opacity = "1";
      this.autoShop.style.color = "#ffd47a";
      this.autoShop.textContent = "🛒 Auto-shop OFF — restock manually";
    }

    // === Dishware badge — Phase I (H.82) STABLE denominator ===
    //
    // User feedback: "the total must be a specific number, not a
    // fluctuating one.  Write x/y (u on the way, i served, o
    // washing, etc.)"
    //
    // Old display used clean+dirty as the denominator, which dropped
    // by 1 every time a dish moved into a dishwasher or into a
    // customer's hand.  Fluctuating "total" hid leaks and made the
    // user think dishes were vanishing.
    //
    // New format keeps the denominator pinned to canonical lifetime
    // (STARTER + sum(purchaseLog), the H.76 invariant — never
    // changes during play) and breaks down the difference by state:
    //
    //   Plates 5 / 81  (3 dirty · 8 washing · 65 in use)
    //   Glasses 24 / 30  (1 washing · 5 in use)
    //
    // If everything is clean the breakdown disappears entirely:
    //   Plates 81 / 81
    //   Glasses 30 / 30
    //
    // Mathematical invariant: clean + dirty + washing + in_use == lifetime.
    // If they don't add up, that's a real leak — the tooltip shows
    // both sides so the player can spot it.
    const dish = this.game.dishware;
    const plateClean = dish.getClean("plate");
    const plateDirty = dish.getDirty("plate");
    const plateInWash = dish.getDishwasherInFlight("plate");
    const glassClean = dish.getClean("glass");
    const glassDirty = dish.getDirty("glass");
    const glassInWash = dish.getDishwasherInFlight("glass");
    const lifetimes = dish.getLifetimeAddedByKind();
    const plateLifetime = lifetimes.plate;
    const glassLifetime = lifetimes.glass;
    // "In use" = held by an eating customer or in transit on a
    // waiter's tray.  Pulled from the snapshot the SaveSystem uses.
    const allInFlight = this.game.getInFlightDishesForSave();
    let plateInUse = 0, glassInUse = 0;
    for (const e of allInFlight) {
      if (e.kind === "plate") plateInUse += e.count;
      else if (e.kind === "glass") glassInUse += e.count;
    }

    const plateColor = plateClean === 0 ? "#ff9a9a" : plateClean <= 4 ? "#ffd47a" : "#a8e2a8";
    const glassColor = glassClean === 0 ? "#ff9a9a" : glassClean <= 4 ? "#ffd47a" : "#a8e2a8";

    const breakdownTag = (parts: { label: string; n: number }[]): string => {
      const live = parts.filter((p) => p.n > 0).map((p) => `${p.n} ${p.label}`);
      if (live.length === 0) return "";
      return ` <span style="opacity:0.55">(${live.join(" · ")})</span>`;
    };
    const plateExtra = breakdownTag([
      { label: "dirty", n: plateDirty },
      { label: "washing", n: plateInWash },
      { label: "in use", n: plateInUse },
    ]);
    const glassExtra = breakdownTag([
      { label: "dirty", n: glassDirty },
      { label: "washing", n: glassInWash },
      { label: "in use", n: glassInUse },
    ]);
    this.dishBadge.innerHTML =
      `Plates ` +
      `<span style="color:${plateColor};font-weight:700">${plateClean}</span>` +
      `<span style="opacity:0.6"> / ${plateLifetime}</span>` +
      plateExtra +
      `<br>Glasses ` +
      `<span style="color:${glassColor};font-weight:700">${glassClean}</span>` +
      `<span style="opacity:0.6"> / ${glassLifetime}</span>` +
      glassExtra;

    // === Dishware tooltip body ===
    const dishScroll = this.dishTooltip.scrollTop;
    const dishLines: string[] = [];
    // SELL-BACK — sell buttons only work while the cloud has a
    // restaurant context (the refund is credited server-side).
    const sellCloudReady = dish.cloud?.hasRestaurantContext() ?? false;
    dishLines.push(`<div style="font-weight:700;margin-bottom:3px">🍽️ Dishware</div>`);
    dishLines.push(renderDishSection("Plates", "plate", dish, sellCloudReady));
    dishLines.push(`<div style="height:4px"></div>`);
    dishLines.push(renderDishSection("Glasses", "glass", dish, sellCloudReady));
    // Phase I (H.82) — canonical account.  Show every state bucket
    // and confirm the sum matches the lifetime invariant.
    const plateAccount = plateClean + plateDirty + plateInWash + plateInUse;
    const glassAccount = glassClean + glassDirty + glassInWash + glassInUse;
    const plateLeak = plateLifetime - plateAccount;
    const glassLeak = glassLifetime - glassAccount;
    const anyLeak = plateLeak !== 0 || glassLeak !== 0;
    dishLines.push(
      `<div style="margin-top:4px;padding-top:3px;border-top:1px solid rgba(255,245,220,0.12)">` +
        `<div style="color:#a8c8e8;font-weight:700;margin-bottom:2px">Account</div>` +
        `<div>Plates: <b>${plateClean}</b> clean · ${plateDirty} dirty · ${plateInWash} washing · ${plateInUse} in use = <b>${plateAccount}</b> / ${plateLifetime}` +
          (plateLeak !== 0 ? ` <span style="color:#ff9a9a">(${plateLeak > 0 ? "LEAK" : "OVER"} ${Math.abs(plateLeak)})</span>` : "") +
        `</div>` +
        `<div>Glasses: <b>${glassClean}</b> clean · ${glassDirty} dirty · ${glassInWash} washing · ${glassInUse} in use = <b>${glassAccount}</b> / ${glassLifetime}` +
          (glassLeak !== 0 ? ` <span style="color:#ff9a9a">(${glassLeak > 0 ? "LEAK" : "OVER"} ${Math.abs(glassLeak)})</span>` : "") +
        `</div>` +
        // Phase I (H.90) — Restore-mode reconcile button.  Only
        // shown when there's a non-zero leak / over.  Clicking it:
        //   LEAK: adds the missing dishes back to clean (you paid
        //     for them, you get them back).
        //   OVER: trims excess from highest-tier clean → dirty.
        // Lifetime stays unchanged either way — purchaseLog is
        // never rewritten.
        (anyLeak
          ? `<div style="margin-top:6px"><button id="dish-recalibrate-btn" style="background:rgba(120,180,200,0.25);color:#fff5dc;border:1px solid rgba(120,180,200,0.5);border-radius:4px;padding:3px 8px;cursor:pointer;font:inherit;font-size:10px;font-weight:600">${plateLeak > 0 || glassLeak > 0 ? "Restore missing dishes" : "Trim excess dishes"}</button></div>`
          : ""),
      `</div>`,
    );
    // Wash is driven by waiter trips — no abstract interval to surface.
    // We only need to warn the player when their kitchen LITERALLY
    // can't wash anything (no sink + no dishwasher) AND dirty pieces
    // are piling up.
    const totalDirty = plateDirty + glassDirty;
    const washInterval = dish.getWashInterval();
    if (!Number.isFinite(washInterval) && totalDirty > 0) {
      dishLines.push(`<div style="color:#ff9a9a;margin-top:2px">No sink or dishwasher — wash paused.</div>`);
    }
    // Phase I (H.82) — dropped the "Washing in dishwashers: X plates,
    // Y glasses" extra line; the canonical Account block above
    // already breaks out the `washing` bucket per kind, so this was
    // duplicate info.
    this.dishTooltip.innerHTML = dishLines.join("");
    this.dishTooltip.scrollTop = dishScroll;
    // Phase I (H.90) — Wire the restore/trim button.  Captured the
    // in-flight counts in this update() pass so the click reconciles
    // against the precise current snapshot.
    if (anyLeak) {
      const btn = this.dishTooltip.querySelector("#dish-recalibrate-btn") as HTMLButtonElement | null;
      if (btn) {
        btn.onclick = (): void => {
          dish.reconcileToLifetime(plateInUse, glassInUse);
          this.update(); // re-render immediately so leak label vanishes
        };
      }
    }
    // Phase I (H.94) — Wire per-tier "−1" delete buttons. One handler
    // per row, reads kind + tier off data attrs and calls
    // dish.deleteOne. Re-renders immediately so the row updates / vanishes.
    const delButtons = this.dishTooltip.querySelectorAll("button.dish-del-btn");
    delButtons.forEach((el) => {
      const btn = el as HTMLButtonElement;
      const kind = btn.getAttribute("data-del-kind") as DishKind | null;
      const tierStr = btn.getAttribute("data-del-tier");
      if (!kind || !tierStr) return;
      const tier = parseInt(tierStr, 10);
      if (!Number.isInteger(tier)) return;
      btn.onclick = (): void => {
        const ok = dish.deleteOne(kind, tier);
        if (!ok) return;
        this.update();
      };
    });
    // SELL-BACK — Wire per-tier "Sell" buttons. Each sells ONE clean
    // piece of (kind, tier) at 50% of the catalog per-piece price.
    const sellButtons = this.dishTooltip.querySelectorAll("button.dish-sell-btn");
    sellButtons.forEach((el) => {
      const btn = el as HTMLButtonElement;
      const kind = btn.getAttribute("data-sell-kind") as DishKind | null;
      const tierStr = btn.getAttribute("data-sell-tier");
      if (!kind || !tierStr) return;
      const tier = parseInt(tierStr, 10);
      if (!Number.isInteger(tier)) return;
      btn.onclick = (): void => this.handleSellDishware(kind, tier);
    });

    // === Storage badge ===
    // Phase I (H.80) — Show ACTUAL pantry stock vs total capacity,
    // not just the per-item target.  Reads as
    //   "❄️ Stock 145/2400  · cap 30/item"
    // where 145 = sum of every ingredient's current quantity,
    // 2400 = numIngredients × per-item target, 30 = per-item target.
    const perItemTarget = target;                // already declared above
    const perItemMax = this.game.getMaxStockTarget();
    const totalStocked = pantry.reduce((acc, p) => acc + p.quantity, 0);
    const ingredientCount = pantry.length;
    const totalCap = ingredientCount > 0 ? ingredientCount * perItemTarget : perItemMax;
    const usagePct = totalCap > 0 ? totalStocked / totalCap : 0;
    const usageColor = usagePct >= 0.95 ? "#a8e2a8" : usagePct >= 0.6 ? "#fff5dc" : usagePct >= 0.3 ? "#ffd47a" : "#ff9a9a";
    // Section header already says "INGREDIENTS"; drop the redundant
    // icon + word and lead with the headline number.
    this.storageBadge.innerHTML =
      `<span style="color:${usageColor};font-weight:700">${totalStocked}</span>` +
      `<span style="opacity:0.6"> / ${totalCap}</span>` +
      ` <span style="opacity:0.5">· cap ${perItemTarget}/item</span>`;

    // === Storage tooltip body ===
    const storageScroll = this.storageTooltip.scrollTop;
    const base = this.game.getMinStockTarget();
    const lines: string[] = [];
    lines.push(`<div style="font-weight:700;margin-bottom:3px">❄️ Storage Cap</div>`);
    lines.push(`<div style="opacity:0.75">Base (no fridges): +${base}</div>`);
    const registry = this.game.registry;
    if (registry) {
      const counts = new Map<string, number>();
      for (const it of registry.snapshotItems()) {
        const def = getFurnitureDef(it.defId);
        if (def?.stockCapacity) {
          counts.set(it.defId, (counts.get(it.defId) ?? 0) + 1);
        }
      }
      const entries = Array.from(counts.entries())
        .map(([id, count]) => {
          const def = getFurnitureDef(id);
          const each = def?.stockCapacity ?? 0;
          return { id, name: def?.name ?? id, count, each, total: count * each };
        })
        .sort((a, b) => b.total - a.total);
      for (const e of entries) {
        const countTag = e.count > 1 ? ` <span style="opacity:0.6">×${e.count}</span>` : "";
        lines.push(`<div>${e.name}${countTag}: <span style="color:#a8c8e8">+${e.total}</span> <span style="opacity:0.5">(@${e.each})</span></div>`);
      }
    }
    lines.push(
      `<div style="margin-top:3px;padding-top:3px;border-top:1px solid rgba(255,245,220,0.12);color:#a8e2a8">` +
        `Per-item cap: <b>${perItemMax}</b> · current target <b>${perItemTarget}</b>` +
      `</div>`
    );
    lines.push(
      `<div style="opacity:0.75;margin-top:2px">Total stocked: <b>${totalStocked}</b> / ${totalCap} units (${(usagePct * 100).toFixed(0)}%)</div>`
    );
    this.storageTooltip.innerHTML = lines.join("");
    this.storageTooltip.scrollTop = storageScroll;

    // === Kitchen pipeline ===
    // Phase I (H.81) — Emoji moved to section header; this line just
    // shows the numbers in the queued · cooking · delivering order.
    const ts = this.game.getTicketStats?.();
    if (ts) {
      const totalTickets = ts.queued + ts.cooking + ts.ready + ts.delivering;
      this.pipeline.style.opacity = totalTickets > 0 ? "1" : "0.55";
      this.pipeline.style.color = totalTickets > 0 ? "#a8e2a8" : "#fff5dc";
      this.pipeline.textContent = totalTickets > 0
        ? `${ts.queued} queued · ${ts.cooking} cooking · ${ts.ready + ts.delivering} delivering`
        : "Kitchen idle";
    } else {
      this.pipeline.textContent = "";
    }
  }

  /** SELL-BACK — Sell ONE clean piece of (kind, tier) back at 50% of
   * the catalog per-piece price (set cost ÷ set size).
   *
   * Local-mutation decision: we deliberately DO NOT touch the local
   * pool here. Every DishwareSystem pool write routes through its
   * applyPoolDelta, which auto-mirrors the delta to the server via
   * bumpDishwarePool — stacked on sell_dishware's own decrement that
   * would double-deduct the cloud pool. Instead the server's decrement
   * flows back through the dishware_pool subscription (applyPoolRow,
   * mirror-suppressed) and this widget's per-frame update() repaints
   * the row. Only the lifetime / purchase-log side is recorded locally
   * (recordSale) so the Account block doesn't read the sold piece as
   * a LEAK. */
  private handleSellDishware(kind: DishKind, tier: number): void {
    const dish = this.game.dishware;
    const cloud = dish.cloud;
    if (!cloud?.hasRestaurantContext()) return;
    const row = dish.getTierBreakdown(kind).find((r) => r.tier === tier);
    if (!row || row.clean <= 0) return; // stale button — nothing clean
    const unitCents = dishwareUnitPriceCents(kind, tier);
    if (unitCents == null) return; // tier not in catalog
    cloud.sellDishware(kind, tier, 1, unitCents);
    dish.recordSale(kind, tier, 1);
    this.update();
  }
}

/** SELL-BACK — Per-piece catalog price in cents for one (kind, tier):
 * set cost ÷ set size, matching what the buy grid charges per piece.
 * Returns null for tiers missing from the catalog so callers can skip
 * rendering a sell button for unknown tiers. */
function dishwareUnitPriceCents(kind: DishKind, tier: number): number | null {
  const list = kind === "plate" ? PLATE_SETS : GLASS_SETS;
  const set = list.find((s) => s.tier === tier);
  if (!set || set.setSize <= 0) return null;
  return Math.round((set.cost / set.setSize) * 100);
}

/** Summary row that brightens slightly on hover so it reads as "hover
 * for details". The actual show/hide of the tooltip is handled by
 * attachHoverTooltip(). */
function makeHoverRow(): HTMLElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: "4px", padding: "2px 4px", marginTop: "3px",
    borderRadius: "3px", textAlign: "center", cursor: "help",
    transition: "background 80ms ease",
  } as Partial<CSSStyleDeclaration>);
  return row;
}

/** Phase I (H.97) — Section CARD container with a header inside.
 * Replaces the thin-separator makeSectionHeader. Each card has a
 * tinted background and an accent-colored left border, so the three
 * sub-panels read as distinct blocks rather than a flat run-on of
 * text. The accent color is per-section (warm yellow for stock,
 * cool blue for dishware, green for kitchen) so the player can
 * scan and find the section they care about by color, not just
 * label. */
function makeSectionCard(label: string, accentColor: string): HTMLElement {
  const card = document.createElement("div");
  Object.assign(card.style, {
    marginTop: "6px",
    padding: "5px 7px 5px 8px",
    background: "rgba(255,245,220,0.045)",
    borderLeft: `3px solid ${accentColor}`,
    borderRadius: "0 4px 4px 0",
  } as Partial<CSSStyleDeclaration>);
  const header = document.createElement("div");
  Object.assign(header.style, {
    fontSize: "10px",
    fontWeight: "700",
    letterSpacing: "0.06em",
    opacity: "0.75",
    marginBottom: "3px",
    color: accentColor.replace(/,[\d.]+\)$/, ",1)"), // opacify
  } as Partial<CSSStyleDeclaration>);
  header.textContent = label;
  card.appendChild(header);
  return card;
}

/** Down-caret beside an expandable summary; flips to up-caret while
 * the tooltip is open. */
function makeCaret(): HTMLElement {
  const caret = document.createElement("span");
  caret.textContent = "▾";
  Object.assign(caret.style, {
    opacity: "0.6", fontSize: "9px", flexShrink: "0",
  } as Partial<CSSStyleDeclaration>);
  return caret;
}

/** A free-floating tooltip element. Appended to document.body and
 * positioned with `position: fixed` so it never affects the sidebar
 * layout when it appears/disappears. */
function makeFloatingTooltip(): HTMLElement {
  const tip = document.createElement("div");
  Object.assign(tip.style, {
    display: "none",
    position: "fixed",
    font: "11px/1.4 system-ui, sans-serif",
    color: "#fff5dc",
    background: "rgba(28,22,16,0.97)",
    border: "1px solid rgba(255,245,220,0.22)",
    borderRadius: "5px",
    padding: "6px 8px",
    boxShadow: "0 6px 18px rgba(0,0,0,0.55)",
    maxHeight: "260px", overflowY: "auto",
    minWidth: "180px", maxWidth: "300px",
    zIndex: "10000",
    pointerEvents: "auto",
  } as Partial<CSSStyleDeclaration>);
  return tip;
}

/** Renders the per-tier breakdown for plates or glasses inside the
 * dishware tooltip. Sorts tiers descending so the prestige rows lead.
 * H.94 — each row has a "−1" button so the player can clear out
 * lower-tier stock they've outgrown. SELL-BACK — each row also gets a
 * "Sell" button that sells ONE clean piece back at 50% of the catalog
 * per-piece price (disabled at 0 clean / cloud offline). Buttons carry
 * data-attrs that the post-innerHTML wiring in update() reads to call
 * deleteOne / handleSellDishware. */
function renderDishSection(label: string, kind: DishKind, dish: Game["dishware"], sellCloudReady: boolean): string {
  const lines: string[] = [];
  lines.push(`<div style="font-weight:700;opacity:0.85">${label}</div>`);
  const rows = dish.getTierBreakdown(kind);
  if (rows.length === 0) {
    lines.push(`<div style="opacity:0.55;padding-left:4px">None owned.</div>`);
  } else {
    for (const r of rows) {
      const tierBadge = `<span style="opacity:0.7">T${r.tier}</span>`;
      const cleanSpan = `<span style="color:#a8e2a8">${r.clean} clean</span>`;
      const dirtySpan = r.dirty > 0
        ? ` · <span style="color:#ffd47a">${r.dirty} dirty</span>`
        : "";
      const delBtn = `<button class="dish-del-btn" data-del-kind="${kind}" data-del-tier="${r.tier}" `
        + `title="Permanently delete one ${kind} of T${r.tier} (clean first, then dirty). `
        + `Lowers lifetime by 1." `
        + `style="margin-left:6px;background:rgba(255,90,90,0.15);color:#ffb0b0;`
        + `border:1px solid rgba(255,90,90,0.35);border-radius:3px;padding:0 5px;`
        + `cursor:pointer;font:inherit;font-size:9px">−1</button>`;
      // SELL-BACK — sell one CLEAN piece at 50% of the per-piece
      // catalog price. Dirty pieces can't be sold (server clamps to
      // clean too); unknown tiers render no button.
      let sellBtn = "";
      const unitCents = dishwareUnitPriceCents(kind, r.tier);
      if (unitCents != null) {
        const refundCents = Math.floor(unitCents / 2);
        const refundStr = (refundCents / 100).toFixed(2).replace(/\.00$/, "");
        const canSell = sellCloudReady && r.clean > 0;
        const title = !sellCloudReady
          ? "Cloud offline — selling needs a connection (the refund is credited server-side)."
          : r.clean <= 0
          ? `No clean ${kind} at T${r.tier} to sell (dirty pieces can't be sold).`
          : `Sell one clean ${kind} of T${r.tier} back for $${refundStr} `
            + `(50% of $${(unitCents / 100).toFixed(2).replace(/\.00$/, "")}/piece).`;
        sellBtn = `<button class="dish-sell-btn" data-sell-kind="${kind}" data-sell-tier="${r.tier}" `
          + (canSell ? "" : "disabled ")
          + `title="${title}" `
          + `style="margin-left:4px;background:rgba(255,210,120,0.12);color:#ffd47a;`
          + `border:1px solid rgba(255,210,120,0.35);border-radius:3px;padding:0 5px;`
          + `cursor:${canSell ? "pointer" : "not-allowed"};opacity:${canSell ? "1" : "0.4"};`
          + `font:inherit;font-size:9px">Sell +$${refundStr}</button>`;
      }
      lines.push(`<div style="padding-left:4px">${tierBadge} · ${cleanSpan}${dirtySpan}${delBtn}${sellBtn}</div>`);
    }
  }
  return lines.join("");
}

/** Hook a summary row to its floating tooltip. The tooltip appears
 * after a 1s hover delay and is positioned next to the row on
 * whichever side has more viewport space — so the sidebar's own side
 * (left or right) doesn't matter. Hovering INTO the tooltip keeps it
 * open; the small close delay covers the cursor gap between row and
 * tooltip. */
function attachHoverTooltip(
  row: HTMLElement,
  tip: HTMLElement,
  caret: HTMLElement,
): void {
  const OPEN_DELAY = 1000;
  const CLOSE_DELAY = 150;
  let openTimer: number | null = null;
  let closeTimer: number | null = null;
  let hovering = false;

  const clearOpen = () => {
    if (openTimer != null) { clearTimeout(openTimer); openTimer = null; }
  };
  const clearClose = () => {
    if (closeTimer != null) { clearTimeout(closeTimer); closeTimer = null; }
  };

  const showNow = () => {
    // Two-pass position: render invisibly first so we can measure
    // the tooltip's actual size, then place it where it fits.
    tip.style.visibility = "hidden";
    tip.style.display = "block";
    const r = row.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const margin = 8;
    // Pick the side of the row with more space; that way it works
    // whether the sidebar is on the left or right of the screen.
    const spaceLeft = r.left;
    const spaceRight = vw - r.right;
    let left = spaceLeft > spaceRight
      ? r.left - tw - margin
      : r.right + margin;
    left = Math.max(margin, Math.min(vw - tw - margin, left));
    let top = r.top;
    if (top + th > vh - margin) top = Math.max(margin, vh - th - margin);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
    caret.textContent = "▴";
    row.style.background = "rgba(255,245,220,0.08)";
  };

  const hideNow = () => {
    tip.style.display = "none";
    caret.textContent = "▾";
    row.style.background = "";
  };

  const onEnter = () => {
    hovering = true;
    clearClose();
    if (tip.style.display === "block") return; // already open
    if (openTimer != null) return;             // already scheduled
    openTimer = window.setTimeout(() => {
      openTimer = null;
      if (hovering) showNow();
    }, OPEN_DELAY);
  };

  const onLeave = () => {
    hovering = false;
    clearOpen();
    clearClose();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (!hovering) hideNow();
    }, CLOSE_DELAY);
  };

  row.addEventListener("mouseenter", onEnter);
  row.addEventListener("mouseleave", onLeave);
  tip.addEventListener("mouseenter", onEnter);
  tip.addEventListener("mouseleave", onLeave);
}
