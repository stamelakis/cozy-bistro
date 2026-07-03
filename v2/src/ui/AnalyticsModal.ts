import type { Game } from "../game/Game";

/**
 * Phase M.11 — the analytics dashboard the player asked for: two time-series
 * graphs read from the server's `stat_snapshot` table (one row per ~minute,
 * recorded continuously server-side even while the owner is offline):
 *   1) Customers over time, stacked by state (walkingIn / seated / ordering /
 *      waitingForFood / eating / leaving / wc…).
 *   2) Staff over time, stacked by activity (idle / cooking / → serve / …).
 * A green/grey band along the shared time axis marks when the OWNER was online
 * vs offline, so the player can eyeball whether anything changes on/off.
 *
 * Rendered on raw <canvas> (no charting dependency). Opens from the HUD; reads
 * a fresh snapshot list each time it's shown (audit tool, not a live ticker).
 */

interface Snapshot {
  atMicros: number;
  ownerOnline: boolean;
  cloudMoneyCents: number;
  dailyServed: number;
  dailyLost: number;
  guestsJson: string;
  staffJson: string;
}

/** Fallback palette for series with no semantic colour. */
const PALETTE = [
  "#6ea8fe", "#f7b267", "#8ce99a", "#ff8fa3", "#b197fc", "#63e6be",
  "#ffd43b", "#ff922b", "#74c0fc", "#e599f7", "#96f2d7", "#ffa8a8",
  "#a9e34b", "#c0eb75", "#66d9e8", "#faa2c1",
];

/** Semantic colours for known customer states — instantly readable
 * (waiting = warm/urgent, eating = green/served, leaving = grey). */
const CUSTOMER_COLORS: Record<string, string> = {
  walkingIn: "#74c0fc",
  waiting: "#ffd43b",
  waitingForSeat: "#ffd43b",
  seated: "#63e6be",
  ordering: "#ffe066",
  waitingForFood: "#ff922b", // the bottleneck signal — lots of orange = kitchen behind
  eating: "#51cf66",         // served + happy
  leaving: "#adb5bd",
  wcSitting: "#b197fc",
  wcWalking: "#b197fc",
  wcWashing: "#b197fc",
};

/** Colour a staff activity: idle = grey (you're paying for nothing), a "→"
 * (walking to a task) = blue, actually-working = green; else palette. */
function staffColor(key: string, idx: number): string {
  if (key === "idle") return "#868e96";
  if (key === "returning") return "#adb5bd";
  if (key.startsWith("→") || key.startsWith("->")) return "#74c0fc"; // moving to a task
  if (/cook|work|mix|serv|wash|stove|bar|order|dish/i.test(key)) return "#51cf66";
  return PALETTE[idx % PALETTE.length];
}

export class AnalyticsModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly content: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
      display: "none", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.5)", zIndex: "1000", pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.hide(); });
    parent.appendChild(this.root);

    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "min(880px, calc(100vw - 32px))", maxHeight: "88vh",
      display: "flex", flexDirection: "column", padding: "16px 20px",
      background: "rgba(26,19,13,0.97)", color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif", borderRadius: "10px",
      border: "2px solid #d8b98f", boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "\u{1F4CA} ANALYTICS";
    Object.assign(title.style, { fontSize: "16px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    const close = document.createElement("button");
    close.textContent = "✕";
    Object.assign(close.style, {
      background: "transparent", color: "#fff5dc", border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px", width: "26px", height: "26px", cursor: "pointer", font: "inherit", fontSize: "13px",
    } as Partial<CSSStyleDeclaration>);
    close.onclick = () => this.hide();
    header.appendChild(close);
    body.appendChild(header);

    const legendBar = document.createElement("div");
    legendBar.innerHTML =
      "How many customers were in each state, and what your staff were doing, over time. " +
      "The strip under each chart shows when <b style='color:#51cf66'>you were online</b> vs " +
      "<b style='color:#868e96'>offline</b> — so you can see if anything changes when you leave. " +
      "One point per minute; ~12 hours kept.";
    Object.assign(legendBar.style, { fontSize: "10px", opacity: "0.7", lineHeight: "1.45", marginBottom: "8px" } as Partial<CSSStyleDeclaration>);
    body.appendChild(legendBar);

    this.content = document.createElement("div");
    Object.assign(this.content.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.content);
  }

  show(): void { this.render(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  private parse(json: string): Record<string, number> {
    try {
      const o = JSON.parse(json) as Record<string, unknown>;
      const out: Record<string, number> = {};
      for (const k of Object.keys(o)) {
        const v = Number(o[k]);
        if (Number.isFinite(v) && v > 0) out[k] = v;
      }
      return out;
    } catch { return {}; }
  }

  private render(): void {
    this.content.innerHTML = "";
    const snaps: Snapshot[] = this.game.economy.cloud?.getStatSnapshots() ?? [];
    if (snaps.length < 2) {
      const empty = document.createElement("div");
      empty.textContent = snaps.length === 0
        ? "No snapshots yet — the server records one per minute. Check back in a few minutes."
        : "Only one snapshot so far — need at least two to draw a trend. Check back soon.";
      Object.assign(empty.style, { opacity: "0.6", textAlign: "center", padding: "40px 20px" } as Partial<CSSStyleDeclaration>);
      this.content.appendChild(empty);
      return;
    }

    // Summary line — window covered + latest served/lost + money.
    const spanMin = Math.round((snaps[snaps.length - 1].atMicros - snaps[0].atMicros) / 60_000_000);
    const last = snaps[snaps.length - 1];
    const summary = document.createElement("div");
    summary.innerHTML =
      `<b>${snaps.length}</b> points over <b>${spanMin} min</b> · ` +
      `latest: <b>${last.dailyServed}</b> served / <b style='color:#ff922b'>${last.dailyLost}</b> lost today · ` +
      `balance <b>$${Math.round(last.cloudMoneyCents / 100).toLocaleString()}</b>`;
    Object.assign(summary.style, { fontSize: "11px", opacity: "0.85", marginBottom: "10px" } as Partial<CSSStyleDeclaration>);
    this.content.appendChild(summary);

    this.content.appendChild(this.buildChart(
      "\u{1F465} Customers over time (by state)", snaps,
      (s) => this.parse(s.guestsJson),
      (key, idx) => CUSTOMER_COLORS[key] ?? PALETTE[idx % PALETTE.length],
    ));
    this.content.appendChild(this.buildChart(
      "\u{1F9D1}‍\u{1F373} Staff over time (by activity)", snaps,
      (s) => this.parse(s.staffJson),
      staffColor,
    ));
  }

  /** One titled stacked-area chart + online/offline band + legend. */
  private buildChart(
    title: string,
    snaps: Snapshot[],
    extract: (s: Snapshot) => Record<string, number>,
    colorFor: (key: string, idx: number) => string,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "18px";

    const h = document.createElement("div");
    h.textContent = title;
    Object.assign(h.style, { fontSize: "12px", fontWeight: "700", marginBottom: "4px" } as Partial<CSSStyleDeclaration>);
    wrap.appendChild(h);

    // Union of series keys across all snapshots, sorted for stable colours.
    const keySet = new Set<string>();
    const perSnap = snaps.map((s) => extract(s));
    for (const m of perSnap) for (const k of Object.keys(m)) keySet.add(k);
    const keys = Array.from(keySet).sort();
    if (keys.length === 0) {
      const none = document.createElement("div");
      none.textContent = "(no activity recorded in this window)";
      Object.assign(none.style, { opacity: "0.5", fontSize: "11px", padding: "8px" } as Partial<CSSStyleDeclaration>);
      wrap.appendChild(none);
      return wrap;
    }
    const colors: Record<string, string> = {};
    keys.forEach((k, i) => { colors[k] = colorFor(k, i); });

    // Canvas (DPR-scaled for crispness). BAND_H strip at the bottom = online.
    const CSS_W = 828, CSS_H = 200, BAND_H = 12, PAD_L = 34, PAD_R = 8, PAD_T = 6;
    const plotH = CSS_H - PAD_T - BAND_H - 2;
    const plotW = CSS_W - PAD_L - PAD_R;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = CSS_W * dpr; canvas.height = CSS_H * dpr;
    Object.assign(canvas.style, { width: `${CSS_W}px`, height: `${CSS_H}px`, maxWidth: "100%", borderRadius: "6px", background: "rgba(0,0,0,0.25)" } as Partial<CSSStyleDeclaration>);
    const ctx = canvas.getContext("2d");
    wrap.appendChild(canvas);

    if (ctx) {
      ctx.scale(dpr, dpr);
      const n = snaps.length;
      const x = (i: number) => PAD_L + (n === 1 ? 0 : (i / (n - 1)) * plotW);
      // Max stacked total for the Y scale.
      let maxTotal = 1;
      for (const m of perSnap) {
        let t = 0; for (const k of keys) t += m[k] ?? 0;
        if (t > maxTotal) maxTotal = t;
      }
      const y = (v: number) => PAD_T + plotH - (v / maxTotal) * plotH;

      // Gridlines + Y labels (0, mid, max).
      ctx.strokeStyle = "rgba(255,245,220,0.12)";
      ctx.fillStyle = "rgba(255,245,220,0.55)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (const frac of [0, 0.5, 1]) {
        const val = Math.round(maxTotal * frac);
        const gy = y(val);
        ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(PAD_L + plotW, gy); ctx.stroke();
        ctx.fillText(String(val), PAD_L - 4, gy);
      }

      // Stacked areas: bottom-most series first, accumulate upward.
      const bottoms = new Array(n).fill(0);
      for (const k of keys) {
        ctx.beginPath();
        // top edge L→R
        for (let i = 0; i < n; i++) {
          const top = bottoms[i] + (perSnap[i][k] ?? 0);
          const px = x(i), py = y(top);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        // bottom edge R→L
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(i), y(bottoms[i]));
        ctx.closePath();
        ctx.fillStyle = colors[k];
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        for (let i = 0; i < n; i++) bottoms[i] += (perSnap[i][k] ?? 0);
      }

      // Online/offline band along the bottom.
      const bandY = CSS_H - BAND_H;
      for (let i = 0; i < n; i++) {
        const x0 = x(i);
        const x1 = i < n - 1 ? x(i + 1) : x0 + plotW / Math.max(1, n - 1);
        ctx.fillStyle = snaps[i].ownerOnline ? "#51cf66" : "#495057";
        ctx.fillRect(x0, bandY, Math.max(1, x1 - x0), BAND_H);
      }
      ctx.fillStyle = "rgba(255,245,220,0.75)";
      ctx.textAlign = "left"; ctx.font = "8px system-ui, sans-serif";
      ctx.fillText("you: online / offline", PAD_L + 2, bandY + BAND_H / 2);
    }

    // Legend — swatch + label + latest value.
    const legend = document.createElement("div");
    Object.assign(legend.style, { display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: "6px", fontSize: "10px" } as Partial<CSSStyleDeclaration>);
    const latest = perSnap[perSnap.length - 1];
    for (const k of keys) {
      const item = document.createElement("span");
      Object.assign(item.style, { display: "inline-flex", alignItems: "center", gap: "4px", opacity: "0.9" } as Partial<CSSStyleDeclaration>);
      const sw = document.createElement("span");
      Object.assign(sw.style, { width: "9px", height: "9px", borderRadius: "2px", background: colors[k], display: "inline-block", flex: "0 0 9px" } as Partial<CSSStyleDeclaration>);
      item.appendChild(sw);
      const lbl = document.createElement("span");
      lbl.textContent = `${k} (${latest[k] ?? 0})`;
      item.appendChild(lbl);
      legend.appendChild(item);
    }
    wrap.appendChild(legend);
    return wrap;
  }
}
