import type { Game } from "../game/Game";
import { getIngredientCost } from "../data/ingredients";
import { getFurnitureDef } from "../data/furnitureCatalog";

/**
 * Compact at-a-glance ingredient status panel that sits above the
 * StaffPanel.
 *
 * Layout (collapsed):
 *   📦 STOCK
 *   📋 6 below target · 16 used today  ▾   ← hover reveals item list
 *   🛒 Auto-shop ON · 7 in transit
 *   ❄️ Storage 14/18 per item  ▾           ← hover reveals breakdown
 *   🍳 5 queued · 0 cooking · 0 delivering
 *
 * The summary line reflects the worst severity (OUT / LOW / below
 * target / all good) so its color is meaningful at a glance. Detail
 * lists only appear on hover, so the widget stays small when nothing
 * needs attention. Hover state is preserved across update() ticks
 * because the DOM is built once in the constructor — update() only
 * rewrites text content, never destroys and rebuilds nodes.
 */
export class StockStatusWidget {
  private readonly game: Game;
  private readonly root: HTMLElement;

  // Stable DOM — created once in constructor. Update() mutates text
  // content only so hover-revealed details don't snap shut on each
  // tick.
  private readonly needRow: HTMLElement;
  private readonly needBadge: HTMLElement;
  private readonly needCaret: HTMLElement;
  private readonly needDetails: HTMLElement;
  private readonly autoShop: HTMLElement;
  private readonly storageRow: HTMLElement;
  private readonly storageBadge: HTMLElement;
  private readonly storageCaret: HTMLElement;
  private readonly storageDetails: HTMLElement;
  private readonly pipeline: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      font: "11px/1.3 system-ui, sans-serif",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const title = document.createElement("div");
    title.textContent = "📦 STOCK";
    Object.assign(title.style, {
      fontWeight: "700", fontSize: "12px",
      marginBottom: "4px", letterSpacing: "0.04em",
      textAlign: "center", opacity: "0.9",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(title);

    // === Need badge + expandable detail list ===
    this.needRow = makeHoverRow();
    this.needBadge = document.createElement("span");
    this.needCaret = makeCaret();
    this.needRow.appendChild(this.needBadge);
    this.needRow.appendChild(this.needCaret);
    this.root.appendChild(this.needRow);
    this.needDetails = makeDetailsPanel();
    this.root.appendChild(this.needDetails);
    attachHover(this.needRow, this.needDetails, this.needCaret);

    // === Auto-shop status ===
    this.autoShop = document.createElement("div");
    Object.assign(this.autoShop.style, {
      fontSize: "10px", marginTop: "3px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.autoShop);

    // === Storage badge + expandable breakdown ===
    this.storageRow = makeHoverRow();
    this.storageBadge = document.createElement("span");
    this.storageCaret = makeCaret();
    this.storageRow.appendChild(this.storageBadge);
    this.storageRow.appendChild(this.storageCaret);
    this.root.appendChild(this.storageRow);
    this.storageDetails = makeDetailsPanel();
    this.root.appendChild(this.storageDetails);
    attachHover(this.storageRow, this.storageDetails, this.storageCaret);

    // === Kitchen pipeline ===
    this.pipeline = document.createElement("div");
    Object.assign(this.pipeline.style, {
      marginTop: "4px", fontSize: "10px", textAlign: "center",
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

    // Below-target detail rows for the hover-revealed list. Inclusion
    // is qty<target (not qty+pending<target) so a currently-empty
    // shelf is listed even when a helper's already running to refill
    // it — the player needs to see it's empty NOW.
    const needRows: string[] = [];
    for (const s of pantry) {
      if (s.quantity >= target) continue;
      const way = this.game.cooking.getPendingForIngredient(s.id);
      const need = target - s.quantity;
      const wayStr = way > 0 ? `, way ${way}` : "";
      needRows.push(`<div>${s.name}: need ${need} <span style="opacity:0.7">(have ${s.quantity}${wayStr})</span></div>`);
    }

    // === Need badge (always visible) ===
    const usedTodaySpan = usedToday > 0
      ? ` <span style="opacity:0.65">· ${usedToday} used today</span>`
      : "";
    if (out.length > 0) {
      // Spell out OUT count + LOW count alongside it, since both are
      // urgent. Hover reveals which specific items.
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

    // === Need details (hover-revealed) ===
    if (needRows.length === 0) {
      // Nothing useful to expand — hide the caret hint and put a quiet
      // confirmation in the panel for the rare hovering player.
      this.needDetails.innerHTML = `<div style="opacity:0.6">All ingredients at target.</div>`;
      this.needCaret.style.visibility = "hidden";
      this.needRow.style.cursor = "default";
    } else {
      this.needDetails.innerHTML = needRows.join("");
      this.needCaret.style.visibility = "visible";
      this.needRow.style.cursor = "help";
    }

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

    // === Storage badge (always visible) ===
    const cap = this.game.getMaxStockTarget();
    const current = this.game.getStockTarget();
    const pct = cap > 0 ? current / cap : 0;
    // Number color tracks how close we are to maxed out. Green when
    // there's plenty of room, amber when 85%+, red when capped — same
    // ladder as the stock severity above so the eye reads them together.
    const capColor = pct >= 1 ? "#ff9a9a" : pct >= 0.85 ? "#ffd47a" : "#a8e2a8";
    this.storageBadge.innerHTML =
      `❄️ Storage ` +
      `<span style="color:${capColor};font-weight:700">${current}</span>` +
      `<span style="opacity:0.6">/${cap}</span>` +
      ` <span style="opacity:0.6">per item</span>`;

    // === Storage details (hover-revealed) ===
    const base = this.game.getMinStockTarget();
    const lines: string[] = [];
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
        `Cap: <b>${cap}</b> · using <b>${current}</b>` +
      `</div>`
    );
    this.storageDetails.innerHTML = lines.join("");

    // === Pipeline ===
    const ts = this.game.getTicketStats?.();
    if (ts) {
      const totalTickets = ts.queued + ts.cooking + ts.ready + ts.delivering;
      this.pipeline.style.opacity = totalTickets > 0 ? "1" : "0.6";
      this.pipeline.style.color = totalTickets > 0 ? "#a8e2a8" : "#fff5dc";
      this.pipeline.textContent = totalTickets > 0
        ? `🍳 ${ts.queued} queued · ${ts.cooking} cooking · ${ts.ready + ts.delivering} delivering`
        : "🍳 Kitchen idle";
    } else {
      this.pipeline.textContent = "";
    }
  }
}

/** A summary row that brightens slightly on hover so it reads as
 * "click here for more". Hover handlers for the actual expand /
 * collapse are attached separately via attachHover(). */
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

/** Down-caret shown beside an expandable summary; flips to up-caret
 * when the details panel is open. */
function makeCaret(): HTMLElement {
  const caret = document.createElement("span");
  caret.textContent = "▾";
  Object.assign(caret.style, {
    opacity: "0.6", fontSize: "9px", flexShrink: "0",
  } as Partial<CSSStyleDeclaration>);
  return caret;
}

/** Hidden-by-default detail panel that pops out under a hover row. */
function makeDetailsPanel(): HTMLElement {
  const details = document.createElement("div");
  Object.assign(details.style, {
    display: "none", fontSize: "10px",
    maxHeight: "140px", overflowY: "auto",
    background: "rgba(0,0,0,0.22)", borderRadius: "3px",
    padding: "4px 6px", marginTop: "2px",
  } as Partial<CSSStyleDeclaration>);
  return details;
}

/** Wire mouseenter/leave on the row AND the details panel so the
 * cursor can travel from row into the popped-out details without it
 * collapsing. The small leave-delay covers the cursor crossing the
 * 1-2px gap between row and panel. */
function attachHover(row: HTMLElement, details: HTMLElement, caret: HTMLElement): void {
  let hovering = false;
  const open = () => {
    hovering = true;
    details.style.display = "block";
    caret.textContent = "▴";
    row.style.background = "rgba(255,245,220,0.08)";
  };
  const close = () => {
    hovering = false;
    setTimeout(() => {
      if (!hovering) {
        details.style.display = "none";
        caret.textContent = "▾";
        row.style.background = "";
      }
    }, 80);
  };
  row.addEventListener("mouseenter", open);
  row.addEventListener("mouseleave", close);
  details.addEventListener("mouseenter", open);
  details.addEventListener("mouseleave", close);
}
