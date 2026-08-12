/**
 * Unified top strip (PC) — the game's single command surface. Two rows in
 * one continuous bar:
 *
 *   row 1 (main): floor selector · camera controls · timer chips · 🔔 bell
 *   row 2 (dock): Metro-style command tiles — EVERY panel opener that used
 *                 to live scattered down the sidebar, plus Build. Important
 *                 actions get WIDE tiles (icon + label), the rest are SMALL
 *                 icon tiles with tooltips.
 *
 * Mobile stays on its own layout: MobileUI pops the floor selector +
 * camera controls back out to fixed phone spots, and the CSS injected here
 * swaps the two button surfaces — desktop hides the sidebar's legacy
 * button grid (`.cb-hud-buttons`), mobile hides the dock — so both
 * platforms keep exactly one copy of every button.
 */

export class TopStrip {
  readonly root: HTMLDivElement;
  /** Row 1 — hosts the floor selector, camera controls, timers, bell. */
  readonly rowMain: HTMLDivElement;
  /** Row 2 — hosts the CommandDock tiles. */
  readonly rowDock: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.classList.add("cb-topstrip");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      // Sidebar occupies x 12..268. The right edge is OURS now — every
      // panel (build palette included) hangs off this bar as a dropdown
      // instead of floating on its own.
      left: "280px",
      right: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "6px 12px 8px",
      background: "rgba(20, 14, 10, 0.86)",
      borderRadius: "12px",
      boxShadow: "0 4px 18px rgba(0,0,0,0.40)",
      color: "#fff5dc",
      pointerEvents: "auto",
      zIndex: "5",
    } as Partial<CSSStyleDeclaration>);

    this.rowMain = document.createElement("div");
    Object.assign(this.rowMain.style, {
      display: "flex",
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "8px 14px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.rowMain);

    this.rowDock = document.createElement("div");
    this.rowDock.classList.add("cb-topstrip-dock");
    Object.assign(this.rowDock.style, {
      display: "flex",
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "5px",
      borderTop: "1px solid rgba(255, 245, 220, 0.12)",
      paddingTop: "6px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.rowDock);

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
