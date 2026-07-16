import { TutorialChef } from "./TutorialChef";

/**
 * Tutorial engine — a declarative step list, a spotlight, an arrow, and the
 * chef doing the talking.
 *
 * DESIGN
 * • SOFT GUIDE. The dim layer is pointer-events:none, so the player can always
 *   click anything, wander off, and come back. A hard gate (only the highlighted
 *   button works) is foolproof right up until it desyncs, and then it's a prison.
 * • ONE SCRIPT FOR BOTH LAYOUTS. Steps name their target with a resolver
 *   (`() => HTMLElement | null`) evaluated live, not a fixed rect. MobileUI
 *   restyles the SAME elements into sheets, so the same resolver lands on the
 *   right thing on desktop and phone — no parallel mobile script to maintain.
 * • INTERVAL, NOT rAF, drives repositioning + `until` polling. Panels move,
 *   scroll and re-render under us, so the spotlight re-measures continuously;
 *   an interval also keeps working when rAF is throttled/paused.
 *
 * A step either waits for the player to press Next (explanation) or auto-advances
 * when `until()` goes true (they actually did the thing).
 */

export interface TutorialStep {
  /** Stable id — persisted so we can resume exactly here. Never reuse. */
  id: string;
  /** What the chef says. */
  say: string;
  /** Element to spotlight, resolved live each tick (may return null while a
   * panel is closed — the step just dims without a hole until it appears). */
  target?: () => HTMLElement | null;
  /** Side effect when the step opens — e.g. open the panel it's about. */
  onEnter?: () => void;
  /** When present the step auto-advances the moment this returns true (polled),
   * and no Next button is shown: the player advances by DOING it. */
  until?: () => boolean;
}

const TICK_MS = 120;
/**
 * SAFETY NET. A "do it yourself" step hides Next, so if its predicate can't go
 * true the player is hard-parked with no way forward — which is exactly what an
 * integration test caught (a step waiting on an award that had nothing to
 * claim). After this long on one step we reveal an escape hatch. No script bug,
 * confused player, or unforeseen game state can ever trap someone.
 */
const WAIT_GRACE_MS = 30_000;

export class Tutorial {
  private readonly root: HTMLElement;
  private readonly spot: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly bubble: HTMLElement;
  private readonly says: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly skipBtn: HTMLButtonElement;
  private readonly chefCanvas: HTMLCanvasElement;
  private readonly chef = new TutorialChef();

  private steps: TutorialStep[] = [];
  private idx = -1;
  private timer: number | null = null;
  private graceTimer: number | null = null;

  /** Fired whenever the active step changes — Engine persists the id so a
   * reload resumes here instead of restarting the whole thing. */
  onStepChanged?: (stepId: string) => void;
  /** Fired once when the run ends. `completed` false = the player skipped. */
  onFinish?: (completed: boolean) => void;

  get active(): boolean { return this.idx >= 0; }
  get currentStepId(): string | null { return this.steps[this.idx]?.id ?? null; }

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", inset: "0", zIndex: "3000", display: "none",
      pointerEvents: "none", // SOFT guide — never trap the player's clicks
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    // Spotlight: a hole punched through a huge box-shadow. Cheap, and it dims
    // everything except the target with one element.
    this.spot = document.createElement("div");
    Object.assign(this.spot.style, {
      position: "absolute", left: "-100px", top: "-100px", width: "0", height: "0",
      borderRadius: "10px", pointerEvents: "none",
      boxShadow: "0 0 0 9999px rgba(6,4,2,0.62)",
      transition: "left 180ms ease, top 180ms ease, width 180ms ease, height 180ms ease",
      outline: "2px solid rgba(255,217,134,0.9)", outlineOffset: "2px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.spot);

    this.arrow = document.createElement("div");
    this.arrow.textContent = "▼";
    Object.assign(this.arrow.style, {
      position: "absolute", display: "none", pointerEvents: "none",
      fontSize: "26px", lineHeight: "1", color: "#ffd986",
      textShadow: "0 2px 6px rgba(0,0,0,0.8)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.arrow);

    // Chef + speech bubble.
    this.panel = document.createElement("div");
    Object.assign(this.panel.style, {
      position: "absolute", left: "18px", bottom: "18px",
      display: "flex", alignItems: "flex-end", gap: "2px",
      pointerEvents: "auto", maxWidth: "min(560px, calc(100vw - 36px))",
      transition: "left 220ms ease, right 220ms ease",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.panel);

    this.chefCanvas = document.createElement("canvas");
    this.chefCanvas.width = 320; this.chefCanvas.height = 320;
    Object.assign(this.chefCanvas.style, {
      width: "150px", height: "150px", flex: "0 0 auto",
      filter: "drop-shadow(0 6px 16px rgba(0,0,0,0.55))",
    } as Partial<CSSStyleDeclaration>);
    this.panel.appendChild(this.chefCanvas);

    this.bubble = document.createElement("div");
    Object.assign(this.bubble.style, {
      position: "relative", minWidth: "0", marginBottom: "16px",
      background: "rgba(34,24,16,0.97)", color: "#fff5dc",
      border: "2px solid #e8c07a", borderRadius: "14px",
      padding: "13px 15px 11px", font: "13px/1.5 system-ui, sans-serif",
      boxShadow: "0 10px 34px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.panel.appendChild(this.bubble);

    this.says = document.createElement("div");
    Object.assign(this.says.style, { marginBottom: "10px", whiteSpace: "pre-line" } as Partial<CSSStyleDeclaration>);
    this.bubble.appendChild(this.says);

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px" } as Partial<CSSStyleDeclaration>);
    this.progress = document.createElement("span");
    Object.assign(this.progress.style, {
      fontSize: "10px", opacity: "0.55", flex: "1", fontVariantNumeric: "tabular-nums",
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(this.progress);

    this.skipBtn = document.createElement("button");
    this.skipBtn.textContent = "Skip";
    Object.assign(this.skipBtn.style, {
      padding: "7px 12px", borderRadius: "8px", cursor: "pointer",
      font: "inherit", fontSize: "11.5px", fontWeight: "700",
      background: "transparent", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.28)",
    } as Partial<CSSStyleDeclaration>);
    this.skipBtn.onclick = () => this.finish(false);
    row.appendChild(this.skipBtn);

    this.nextBtn = document.createElement("button");
    this.nextBtn.textContent = "Next";
    Object.assign(this.nextBtn.style, {
      padding: "7px 16px", borderRadius: "8px", cursor: "pointer", border: "none",
      font: "inherit", fontSize: "12.5px", fontWeight: "800",
      background: "linear-gradient(180deg, #ffd472, #f0b43c)", color: "#3a2708",
      boxShadow: "0 3px 10px rgba(240,180,60,0.35)",
    } as Partial<CSSStyleDeclaration>);
    this.nextBtn.onclick = () => this.advance();
    row.appendChild(this.nextBtn);
    this.bubble.appendChild(row);
  }

  setScript(steps: TutorialStep[]): void { this.steps = steps; }

  /** Begin (or RESUME from `fromId`, so a reload doesn't restart the run). */
  start(fromId?: string | null): void {
    if (this.steps.length === 0) return;
    const resumeAt = fromId ? this.steps.findIndex((s) => s.id === fromId) : 0;
    this.idx = resumeAt >= 0 ? resumeAt : 0;
    this.root.style.display = "block";
    // No chef (no WebGL / GLB) just means the bubble talks on its own.
    void this.chef.mount(this.chefCanvas).then((ok) => { if (ok) this.chef.start(); });
    this.enter();
    if (this.timer == null) this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  /** Stop without recording a result (e.g. teardown). */
  stop(): void {
    if (this.timer != null) { window.clearInterval(this.timer); this.timer = null; }
    if (this.graceTimer != null) { window.clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.chef.stop();
    this.root.style.display = "none";
    this.idx = -1;
  }

  private finish(completed: boolean): void {
    this.stop();
    this.chef.dispose();
    this.onFinish?.(completed);
  }

  private advance(): void {
    if (this.idx + 1 >= this.steps.length) { this.finish(true); return; }
    this.idx += 1;
    this.enter();
  }

  /** Open the step: run its side effect, show the line, pick the advance mode. */
  private enter(): void {
    const step = this.steps[this.idx];
    if (!step) return;
    try { step.onEnter?.(); } catch { /* a panel refusing to open must not kill the run */ }
    this.says.textContent = step.say;
    this.progress.textContent = `${this.idx + 1} / ${this.steps.length}`;
    // A "do it yourself" step advances by DOING — no Next to shortcut past it.
    const waits = typeof step.until === "function";
    this.nextBtn.textContent = "Next";
    this.nextBtn.style.display = waits ? "none" : "";
    if (this.graceTimer != null) { window.clearTimeout(this.graceTimer); this.graceTimer = null; }
    if (waits) {
      // …but never hard-park them — see WAIT_GRACE_MS.
      this.graceTimer = window.setTimeout(() => {
        this.nextBtn.textContent = "Skip this →";
        this.nextBtn.style.display = "";
      }, WAIT_GRACE_MS);
    }
    this.onStepChanged?.(step.id);
    this.reposition();
  }

  private tick(): void {
    const step = this.steps[this.idx];
    if (!step) return;
    this.reposition();
    if (step.until) {
      let done = false;
      try { done = step.until(); } catch { done = false; }
      if (done) this.advance();
    }
  }

  /** Re-measure the target every tick — panels move, scroll, and re-render. */
  private reposition(): void {
    const step = this.steps[this.idx];
    const el = step?.target?.() ?? null;
    if (!el || !el.isConnected) {
      // No target (or its panel is closed): park the hole off-screen so the
      // box-shadow dims the whole view, and hide the arrow.
      Object.assign(this.spot.style, { left: "-100px", top: "-100px", width: "0", height: "0" });
      this.spot.style.outline = "none";
      this.arrow.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { this.arrow.style.display = "none"; return; }
    const pad = 6;
    Object.assign(this.spot.style, {
      left: `${Math.round(r.left - pad)}px`, top: `${Math.round(r.top - pad)}px`,
      width: `${Math.round(r.width + pad * 2)}px`, height: `${Math.round(r.height + pad * 2)}px`,
      outline: "2px solid rgba(255,217,134,0.9)",
    });
    // Arrow above the target, flipping below when it'd fall off the top.
    const above = r.top > 54;
    this.arrow.textContent = above ? "▼" : "▲";
    this.arrow.style.display = "block";
    this.arrow.style.left = `${Math.round(r.left + r.width / 2 - 9)}px`;
    this.arrow.style.top = above ? `${Math.round(r.top - 34)}px` : `${Math.round(r.bottom + 8)}px`;
    this.arrow.animate(
      above
        ? [{ transform: "translateY(-4px)" }, { transform: "translateY(3px)" }, { transform: "translateY(-4px)" }]
        : [{ transform: "translateY(4px)" }, { transform: "translateY(-3px)" }, { transform: "translateY(4px)" }],
      { duration: 900, iterations: 1, easing: "ease-in-out" },
    );
    // Keep the chef out of the way of whatever he's pointing at.
    const panelRect = this.panel.getBoundingClientRect();
    const overlaps = !(r.right < panelRect.left || r.left > panelRect.right
      || r.bottom < panelRect.top || r.top > panelRect.bottom);
    if (overlaps && r.left < window.innerWidth / 2) {
      this.panel.style.left = "auto"; this.panel.style.right = "18px";
    } else if (!overlaps && this.panel.style.right === "18px" && r.right > window.innerWidth / 2) {
      this.panel.style.right = "auto"; this.panel.style.left = "18px";
    }
  }

  /** Paint one chef frame without rAF — used by tests (the preview pane runs
   * pages hidden, which pauses rAF entirely). */
  renderChefFrame(dt = 0.05): void { this.chef.render(dt); }

  dispose(): void { this.stop(); this.chef.dispose(); }
}
