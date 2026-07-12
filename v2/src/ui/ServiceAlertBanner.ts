import type { Game } from "../game/Game";

/**
 * Prominent top-of-screen warning banner that fires ONLY when a resource
 * shortage is actually BLOCKING SERVICE (not just "low"):
 *   • 0 clean plates (and you own plates)   → food orders can't be served
 *   • 0 clean glasses (and you own glasses) → drinks can't be served
 *   • an ingredient is fully out with NOTHING inbound (auto-shop off or
 *     can't keep up) → dishes needing it can't be cooked
 *
 * Each blocker names the cause and offers the one action that fixes it
 * (open the Pantry — buy dishware / enable Auto-shop / raise targets).
 *
 * UX rules:
 *   • A 2.5s grace before showing, so a brief clean-dish dip that the wash
 *     loop immediately recovers doesn't flash the banner.
 *   • Dismissible (✕) — but it re-appears the instant the SET of blockers
 *     CHANGES, so a new / worse shortage still alerts.
 *   • Fully hides the moment nothing is blocking.
 */
const GRACE_MS = 2500;

export class ServiceAlertBanner {
  private readonly root: HTMLElement;
  private readonly text: HTMLElement;
  private dismissedSig: string | null = null;
  private blockedSince: number | null = null;

  constructor(
    private readonly game: Game,
    private readonly onFix: () => void,
  ) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "96px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "none",
      alignItems: "center",
      gap: "12px",
      width: "max-content",
      maxWidth: "min(560px, calc(100vw - 32px))",
      padding: "9px 10px 9px 14px",
      background: "linear-gradient(90deg, rgba(158,32,32,0.97), rgba(122,24,24,0.97))",
      color: "#fff",
      font: "600 13px/1.35 system-ui, sans-serif",
      borderRadius: "9px",
      border: "1px solid rgba(255,160,160,0.6)",
      boxShadow: "0 6px 22px rgba(0,0,0,0.5)",
      zIndex: "1200",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);

    const icon = document.createElement("span");
    icon.textContent = "⚠";
    Object.assign(icon.style, { fontSize: "18px", flexShrink: "0", lineHeight: "1" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(icon);

    this.text = document.createElement("div");
    Object.assign(this.text.style, { flex: "1", minWidth: "0" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.text);

    const fixBtn = document.createElement("button");
    fixBtn.textContent = "Open Pantry";
    Object.assign(fixBtn.style, {
      flexShrink: "0",
      background: "rgba(255,255,255,0.94)",
      color: "#7a1818",
      border: "none",
      borderRadius: "5px",
      padding: "6px 12px",
      cursor: "pointer",
      font: "700 12px system-ui, sans-serif",
    } as Partial<CSSStyleDeclaration>);
    fixBtn.onclick = () => this.onFix();
    this.root.appendChild(fixBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      flexShrink: "0",
      background: "transparent",
      color: "rgba(255,255,255,0.85)",
      border: "none",
      cursor: "pointer",
      font: "700 14px system-ui, sans-serif",
      padding: "0 2px",
    } as Partial<CSSStyleDeclaration>);
    closeBtn.onclick = () => {
      // Silence THIS exact set of blockers; a different set re-alerts.
      this.dismissedSig = this.computeProblems().join("|");
      this.root.style.display = "none";
    };
    this.root.appendChild(closeBtn);

    document.body.appendChild(this.root);
  }

  /** Called on the HUD's throttled cadence (~5 Hz). */
  update(): void {
    const problems = this.computeProblems();
    if (problems.length === 0) {
      this.blockedSince = null;
      this.dismissedSig = null;      // resolved → a future blocker alerts fresh
      this.root.style.display = "none";
      return;
    }
    const now = performance.now();
    if (this.blockedSince === null) this.blockedSince = now;
    if (now - this.blockedSince < GRACE_MS) {
      this.root.style.display = "none"; // wait out a transient dip
      return;
    }
    const sig = problems.join("|");
    if (sig === this.dismissedSig) {
      this.root.style.display = "none"; // player dismissed this exact set
      return;
    }
    this.dismissedSig = null;           // set changed → force back into view
    this.text.innerHTML = this.renderProblems(problems);
    this.root.style.display = "flex";
  }

  /** One short sentence per active service-blocker, most-critical first.
   * Empty array = nothing is blocking. */
  private computeProblems(): string[] {
    const out: string[] = [];
    const dish = this.game.dishware;
    const lifetime = dish.getLifetimeAddedByKind();
    if (lifetime.plate > 0 && dish.getClean("plate") === 0) {
      out.push("Out of clean plates — food orders can't be served.");
    }
    if (lifetime.glass > 0 && dish.getClean("glass") === 0) {
      out.push("Out of clean glasses — drinks can't be served.");
    }
    // Ingredients fully out with NOTHING inbound (auto-shop off or unable to
    // keep up) — a genuinely stuck restock, not a momentary dip a helper is
    // already covering.
    const stuck = this.game.cooking.getPantry()
      .filter((s) => s.quantity === 0 && this.game.cooking.getPendingForIngredient(s.id) === 0)
      .map((s) => s.name);
    if (stuck.length > 0) {
      const shown = stuck.slice(0, 3).join(", ");
      const more = stuck.length > 3 ? `, +${stuck.length - 3} more` : "";
      out.push(`Out of ${shown}${more} (none on the way) — some dishes can't be cooked.`);
    }
    return out;
  }

  private renderProblems(problems: string[]): string {
    if (problems.length === 1) {
      return `<div>${escapeHtml(problems[0])}</div>`
        + `<div style="font-weight:400;opacity:0.9;font-size:11px;margin-top:2px">${escapeHtml(this.fixHint(problems[0]))}</div>`;
    }
    const list = problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
    return `<div>Service is stalling:</div>`
      + `<ul style="margin:3px 0 0;padding-left:18px;font-weight:400;font-size:11.5px">${list}</ul>`;
  }

  private fixHint(problem: string): string {
    return problem.startsWith("Out of clean")
      ? "Buy more sets in the Pantry, or add a dishwasher / another waiter."
      : "Open the Pantry to turn on Auto-shop or raise your stock targets.";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
