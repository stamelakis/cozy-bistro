import type { Game } from "../game/Game";
import { getIngredientCost } from "../data/ingredients";
import { getFurnitureDef } from "../data/furnitureCatalog";
import type { DishKind } from "../data/dishwareCatalog";

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

    this.root.appendChild(makeSectionHeader("🥫 INGREDIENTS"));

    // Storage badge moved to TOP of ingredients section — that's the
    // "how full is my pantry" headline number the user wanted to see
    // first.
    this.storageRow = makeHoverRow();
    this.storageBadge = document.createElement("span");
    this.storageCaret = makeCaret();
    this.storageRow.appendChild(this.storageBadge);
    this.storageRow.appendChild(this.storageCaret);
    this.root.appendChild(this.storageRow);
    this.storageTooltip = makeFloatingTooltip();
    document.body.appendChild(this.storageTooltip);
    attachHoverTooltip(this.storageRow, this.storageTooltip, this.storageCaret);

    // Need badge — warnings about specific ingredients.
    this.needRow = makeHoverRow();
    this.needBadge = document.createElement("span");
    this.needCaret = makeCaret();
    this.needRow.appendChild(this.needBadge);
    this.needRow.appendChild(this.needCaret);
    this.root.appendChild(this.needRow);
    this.needTooltip = makeFloatingTooltip();
    document.body.appendChild(this.needTooltip);
    attachHoverTooltip(this.needRow, this.needTooltip, this.needCaret);

    this.autoShop = document.createElement("div");
    Object.assign(this.autoShop.style, {
      fontSize: "10px", marginTop: "1px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.autoShop);

    this.root.appendChild(makeSectionHeader("🍽 DISHWARE"));

    this.dishRow = makeHoverRow();
    this.dishBadge = document.createElement("span");
    this.dishCaret = makeCaret();
    this.dishRow.appendChild(this.dishBadge);
    this.dishRow.appendChild(this.dishCaret);
    this.root.appendChild(this.dishRow);
    this.dishTooltip = makeFloatingTooltip();
    document.body.appendChild(this.dishTooltip);
    attachHoverTooltip(this.dishRow, this.dishTooltip, this.dishCaret);

    this.root.appendChild(makeSectionHeader("🍳 KITCHEN"));

    this.pipeline = document.createElement("div");
    Object.assign(this.pipeline.style, {
      fontSize: "10px", textAlign: "center", opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.pipeline);

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

    // === Dishware badge — Phase I (H.81) availability/total ===
    // Format: "Plates 5/458 (3 dirty) · Glasses 24/26 (2 dirty)"
    //   N/M = clean ready / total owned
    //   color tracks clean count low/empty
    const dish = this.game.dishware;
    const plateClean = dish.getClean("plate");
    const plateDirty = dish.getDirty("plate");
    const plateTotal = plateClean + plateDirty;
    const glassClean = dish.getClean("glass");
    const glassDirty = dish.getDirty("glass");
    const glassTotal = glassClean + glassDirty;
    const totalDirty = plateDirty + glassDirty;
    const plateColor = plateClean === 0 ? "#ff9a9a" : plateClean <= 4 ? "#ffd47a" : "#a8e2a8";
    const glassColor = glassClean === 0 ? "#ff9a9a" : glassClean <= 4 ? "#ffd47a" : "#a8e2a8";
    const plateDirtyTag = plateDirty > 0 ? ` <span style="opacity:0.55">(${plateDirty} dirty)</span>` : "";
    const glassDirtyTag = glassDirty > 0 ? ` <span style="opacity:0.55">(${glassDirty} dirty)</span>` : "";
    this.dishBadge.innerHTML =
      `Plates ` +
      `<span style="color:${plateColor};font-weight:700">${plateClean}</span>` +
      `<span style="opacity:0.6">/${plateTotal}</span>` +
      plateDirtyTag +
      `<br>Glasses ` +
      `<span style="color:${glassColor};font-weight:700">${glassClean}</span>` +
      `<span style="opacity:0.6">/${glassTotal}</span>` +
      glassDirtyTag;
    // suppress unused-var warning when totalDirty isn't shown inline
    void totalDirty;

    // === Dishware tooltip body ===
    const dishScroll = this.dishTooltip.scrollTop;
    const dishLines: string[] = [];
    dishLines.push(`<div style="font-weight:700;margin-bottom:3px">🍽️ Dishware</div>`);
    dishLines.push(renderDishSection("Plates", "plate", dish));
    dishLines.push(`<div style="height:4px"></div>`);
    dishLines.push(renderDishSection("Glasses", "glass", dish));
    const totalOwned = dish.getTotalOwned();
    const dishCap = dish.getCapacity();
    dishLines.push(
      `<div style="margin-top:4px;padding-top:3px;border-top:1px solid rgba(255,245,220,0.12);color:#a8c8e8">` +
        `Stored: <b>${totalOwned}</b> / ${dishCap} slots` +
      `</div>`,
    );
    // Wash is driven by waiter trips — no abstract interval to surface.
    // We only need to warn the player when their kitchen LITERALLY
    // can't wash anything (no sink + no dishwasher) AND dirty pieces
    // are piling up.
    const washInterval = dish.getWashInterval();
    if (!Number.isFinite(washInterval) && totalDirty > 0) {
      dishLines.push(`<div style="color:#ff9a9a;margin-top:2px">No sink or dishwasher — wash paused.</div>`);
    }
    // Surface how much is mid-cycle inside dishwashers so the "dirty"
    // count drifting upward while plates wait for a batch flush doesn't
    // look like a stuck system.
    const inDwPlates = dish.getDishwasherInFlight("plate");
    const inDwGlasses = dish.getDishwasherInFlight("glass");
    if (inDwPlates + inDwGlasses > 0) {
      const parts: string[] = [];
      if (inDwPlates > 0) parts.push(`${inDwPlates} plate${inDwPlates === 1 ? "" : "s"}`);
      if (inDwGlasses > 0) parts.push(`${inDwGlasses} glass${inDwGlasses === 1 ? "" : "es"}`);
      dishLines.push(`<div style="opacity:0.7;margin-top:2px">Washing in dishwashers: ${parts.join(", ")}</div>`);
    }
    this.dishTooltip.innerHTML = dishLines.join("");
    this.dishTooltip.scrollTop = dishScroll;

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

/** Phase I (H.81) — Section header for the three sub-panels
 * (INGREDIENTS / DISHWARE / KITCHEN).  A thin separator line + a
 * small uppercase label so each section reads as its own block. */
function makeSectionHeader(label: string): HTMLElement {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    display: "flex", alignItems: "center", gap: "5px",
    marginTop: "8px", marginBottom: "1px",
    fontSize: "10px", fontWeight: "700",
    letterSpacing: "0.06em", opacity: "0.55",
  } as Partial<CSSStyleDeclaration>);
  const line = (): HTMLElement => {
    const l = document.createElement("div");
    Object.assign(l.style, {
      flex: "1", height: "1px",
      background: "rgba(255,245,220,0.18)",
    } as Partial<CSSStyleDeclaration>);
    return l;
  };
  wrap.appendChild(line());
  const lab = document.createElement("span");
  lab.textContent = label;
  wrap.appendChild(lab);
  wrap.appendChild(line());
  return wrap;
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
 * dishware tooltip. Sorts tiers descending so the prestige rows lead. */
function renderDishSection(label: string, kind: DishKind, dish: Game["dishware"]): string {
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
      lines.push(`<div style="padding-left:4px">${tierBadge} · ${cleanSpan}${dirtySpan}</div>`);
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
