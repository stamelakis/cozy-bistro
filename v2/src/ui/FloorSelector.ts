import type { IsoCamera } from "../scene/IsoCamera";
import type { WorldScene } from "../scene/WorldScene";

/**
 * Horizontal strip of large floor buttons pinned to the top-center of
 * the viewport. One button per storey of the building (ground + up to
 * NUM_STOREYS-1 upper floors). Pressing a button:
 *  1. Calls `scene.setFocusedStorey(idx)` so storeys above the focus
 *     are hidden and the wall-ghosting rule re-evaluates.
 *  2. Asks the camera to tween its look-at Y to `idx * STOREY_HEIGHT`,
 *     so the chosen floor sits in the middle of the view.
 *
 * Buttons for storeys that the current luxury tier has not yet unlocked
 * are rendered greyed-out and locked with a 🔒 icon. Layout: ground (G)
 * on the LEFT, upper floors going right — matches the mental model that
 * higher numbers = "further along the progression".
 */
/** What the FloorSelector should render beneath each floor button. */
export type FloorContent = "nothing" | "mix" | "food" | "drink";

export class FloorSelector {
  private readonly root: HTMLElement;
  private readonly scene: WorldScene;
  private readonly camera: IsoCamera;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly contentLabels: HTMLElement[] = [];
  private refreshTimer: number | null = null;
  /** Optional notifier fired after a focus change (BuildMenu uses this
   * to teleport its active placement preview to the new floor). */
  onFocusChanged?: () => void;
  /** Engine wires this to query the registry's resolved seat slots and
   * classify each floor by what kind of orders it serves. Without it
   * the per-floor "food only / drinks only / mix / nothing" sub-labels
   * stay empty. */
  getFloorContent?: (floor: number) => FloorContent;

  constructor(parent: HTMLElement, scene: WorldScene, camera: IsoCamera) {
    this.scene = scene;
    this.camera = camera;

    this.root = document.createElement("div");
    this.root.classList.add("cb-floorsel");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      flexDirection: "row",
      gap: "6px",
      padding: "8px 10px",
      background: "rgba(20, 14, 10, 0.86)",
      borderRadius: "12px",
      boxShadow: "0 4px 18px rgba(0,0,0,0.40)",
      color: "#fff5dc",
      font: "14px/1.3 system-ui, sans-serif",
      pointerEvents: "auto",
      zIndex: "5",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    // One column per storey. Each column = a button on top and a small
    // content label below ("food only", "drinks only", "mix", or
    // "nothing"). Index 0 = ground (leftmost), 1..N-1 = upper.
    const n = (this.scene.constructor as typeof WorldScene).getNumStoreys();
    for (let idx = 0; idx < n; idx += 1) {
      const col = document.createElement("div");
      Object.assign(col.style, {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "3px",
      } as Partial<CSSStyleDeclaration>);

      const btn = document.createElement("button");
      Object.assign(btn.style, {
        minWidth: "56px",
        height: "44px",
        padding: "0 14px",
        background: "rgba(120, 180, 200, 0.18)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.22)",
        borderRadius: "8px",
        cursor: "pointer",
        font: "inherit",
        fontSize: "18px",
        fontWeight: "700",
        textAlign: "center",
        letterSpacing: "0.04em",
      } as Partial<CSSStyleDeclaration>);
      const label = idx === 0 ? "G" : String(idx);
      btn.textContent = label;
      btn.title = idx === 0 ? "Ground floor" : `Floor ${idx}`;
      btn.onclick = () => this.select(idx);
      col.appendChild(btn);

      const content = document.createElement("div");
      Object.assign(content.style, {
        fontSize: "10px",
        fontWeight: "600",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        opacity: "0.7",
        // Reserve the line height so locked / empty labels don't make
        // the row jump in height when content changes.
        minHeight: "12px",
        whiteSpace: "nowrap",
        textAlign: "center",
        pointerEvents: "none",
      } as Partial<CSSStyleDeclaration>);
      content.textContent = "";
      col.appendChild(content);

      this.root.appendChild(col);
      this.buttons.push(btn);
      this.contentLabels.push(content);
    }

    this.update();
    // The seat catalog changes whenever the player places, sells, or
    // moves a table — and we'd rather not thread every furniture event
    // through here. Refreshing the per-floor labels every 1.5s keeps
    // them current cheaply (just a registry scan + DOM string assign).
    this.refreshTimer = window.setInterval(() => this.update(), 1500);
  }

  /** Stop the periodic label refresh — call on teardown / HMR so the
   * interval doesn't leak (or double-fire if the selector is recreated). */
  dispose(): void {
    if (this.refreshTimer != null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Switch focus to the given storey. Safe to call repeatedly with
   * the same index — the camera tween is a no-op when already there. */
  private select(idx: number): void {
    const tier = this.scene.getLuxuryTier();
    if (idx > 0 && tier < idx + 1) return; // locked

    this.scene.setFocusedStorey(idx);

    const H = (this.scene.constructor as typeof WorldScene).getStoreyHeight();
    // Lift the camera target so the chosen floor's mid-height is roughly
    // centered. We aim a touch above the slab so doors/walls of that
    // floor sit comfortably below the screen middle. Tween shortened
    // from 0.5 s → 0.30 s so the click→arrived feel is snappier;
    // anything below ~0.25 s starts feeling like a teleport instead
    // of a deliberate camera move.
    this.camera.tweenTargetY(idx * H, 0.30);

    this.onFocusChanged?.();
    this.update();
  }

  /** Re-skin button states. Call this when the tier changes (new floors
   * unlock) or after the focused storey moves so the highlight tracks. */
  update(): void {
    const tier = this.scene.getLuxuryTier();
    const focused = this.scene.getFocusedStorey();
    for (let idx = 0; idx < this.buttons.length; idx += 1) {
      const btn = this.buttons[idx];
      const unlocked = idx === 0 || tier >= idx + 1;
      const isActive = idx === focused;
      const label = idx === 0 ? "G" : String(idx);
      btn.textContent = unlocked ? label : `🔒`;
      btn.disabled = !unlocked;
      btn.title = !unlocked
        ? `Floor ${idx} — unlocks at tier ${idx + 1}`
        : idx === 0
          ? "Ground floor"
          : `Floor ${idx}`;
      btn.style.opacity = unlocked ? "1" : "0.45";
      btn.style.cursor = unlocked ? "pointer" : "not-allowed";
      btn.style.background = isActive
        ? "rgba(255, 210, 120, 0.45)"
        : "rgba(120, 180, 200, 0.18)";
      btn.style.borderColor = isActive
        ? "rgba(255, 220, 150, 0.85)"
        : "rgba(255,245,220,0.22)";
      btn.style.color = isActive ? "#fffff0" : "#fff5dc";

      // Sub-label classifies the floor by what gets served:
      //   nothing → no seats placed yet
      //   food    → every seat on this floor is a food seat
      //   drink   → every seat is drinks-only (coffee tables, bar)
      //   mix     → both kinds of seats coexist
      // Locked floors render their requirement instead so the player
      // sees what tier unlocks them at a glance.
      const labelEl = this.contentLabels[idx];
      if (!unlocked) {
        labelEl.textContent = `tier ${idx + 1}`;
        labelEl.style.color = "#caa67c";
        labelEl.style.opacity = "0.55";
        continue;
      }
      const content: FloorContent = this.getFloorContent?.(idx) ?? "nothing";
      const COPY: Record<FloorContent, string> = {
        nothing: "empty",
        food:    "food",
        drink:   "drinks",
        mix:     "mixed",
      };
      const COLOR: Record<FloorContent, string> = {
        nothing: "#bca78c",  // muted cream — empty floor reads as "nothing here"
        food:    "#a8d8a0",  // soft green
        drink:   "#a8c8e8",  // soft blue
        mix:     "#e8c878",  // warm amber — both food + drinks
      };
      labelEl.textContent = COPY[content];
      labelEl.style.color = COLOR[content];
      labelEl.style.opacity = isActive ? "1" : "0.85";
    }
  }
}
