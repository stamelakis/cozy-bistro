/**
 * Unified top strip (PC) — the game's single command surface, laid out as
 * three zones plus a hanging tab:
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ [camera nav]   [ small icon tiles row  ]        [🔔]       │
 *   │                [ wide command tiles row ]       [timers ↓] │
 *   └──────────────────┐ [G][2][3][4][5] ┌───────────────────────┘
 *                      └────(centered)───┘
 *
 *   • navigation cluster LEFT · command tiles CENTER (small row over
 *     wide row) · bell + timer chips stacked RIGHT
 *   • the floor selector hangs below as a small centered extension tab —
 *     not a full second line.
 *
 * Hosted children keep their own classes (cb-cameracontrols, cb-floorsel)
 * because MobileUI re-parks them with `position: fixed !important`
 * overrides — phones keep their exact layouts, untouched.
 */

export class TopStrip {
  /** Transparent full-width wrapper (click-through outside the panels). */
  readonly root: HTMLDivElement;
  /** LEFT zone of the main bar — camera/navigation cluster. */
  readonly zoneNav: HTMLDivElement;
  /** CENTER zone — the CommandDock builds its two tile rows in here. */
  readonly zoneMiddle: HTMLDivElement;
  /** RIGHT zone — 🔔 bell on top, timer chips stacked beneath. */
  readonly zoneRight: HTMLDivElement;
  /** The centered floor-selector tab hanging under the bar. */
  readonly floorTab: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.classList.add("cb-topstrip");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      left: "280px", // sidebar occupies x 12..268
      right: "12px",
      display: "flex",
      flexDirection: "column",
      alignItems: "stretch",
      pointerEvents: "none", // sections re-enable — the wrapper is air
      zIndex: "5",
      color: "#fff5dc",
    } as Partial<CSSStyleDeclaration>);

    // ── Main bar ────────────────────────────────────────────────────
    const barMain = document.createElement("div");
    barMain.classList.add("cb-topstrip-main");
    Object.assign(barMain.style, {
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      gap: "16px",
      padding: "5px 12px", // thin — every spare vertical pixel is play area
      background: "rgba(20, 14, 10, 0.86)",
      borderRadius: "12px",
      boxShadow: "0 4px 18px rgba(0,0,0,0.40)",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(barMain);

    this.zoneNav = document.createElement("div");
    Object.assign(this.zoneNav.style, {
      display: "flex",
      alignItems: "center",
      flexShrink: "0",
    } as Partial<CSSStyleDeclaration>);
    barMain.appendChild(this.zoneNav);

    this.zoneMiddle = document.createElement("div");
    Object.assign(this.zoneMiddle.style, {
      flex: "1",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "4px",
      minWidth: "0",
    } as Partial<CSSStyleDeclaration>);
    barMain.appendChild(this.zoneMiddle);

    // Right zone is a ROW: timer chips (stacked column) to the LEFT of the
    // bell, so any number of timers can pile downward without pushing the
    // bell around.
    this.zoneRight = document.createElement("div");
    Object.assign(this.zoneRight.style, {
      display: "flex",
      flexDirection: "row",
      alignItems: "flex-start",
      gap: "8px",
      flexShrink: "0",
      alignSelf: "flex-start",
    } as Partial<CSSStyleDeclaration>);
    barMain.appendChild(this.zoneRight);

    // ── Floor tab — a small centered extension, not a full line ────
    this.floorTab = document.createElement("div");
    this.floorTab.classList.add("cb-topstrip-tab");
    Object.assign(this.floorTab.style, {
      alignSelf: "center",
      width: "max-content",
      display: "flex",
      alignItems: "center",
      padding: "5px 12px 7px",
      background: "rgba(20, 14, 10, 0.86)",
      borderRadius: "0 0 12px 12px",
      boxShadow: "0 6px 14px rgba(0,0,0,0.35)",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.floorTab);

    parent.appendChild(this.root);
    injectSwapCss();
  }
}

/** Desktop shows the dock and hides the sidebar's legacy button grid;
 * mobile does the reverse (its drawer still needs the sidebar buttons).
 * Injected once. */
function injectSwapCss(): void {
  if (document.getElementById("cb-topstrip-swap")) return;
  const s = document.createElement("style");
  s.id = "cb-topstrip-swap";
  s.textContent =
    "body:not(.cb-mobile) .cb-hud-buttons { display: none !important; }\n" +
    "body.cb-mobile .cb-topstrip-dock { display: none !important; }";
  document.head.appendChild(s);
}
