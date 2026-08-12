/**
 * Unified top strip (PC) — ONE continuous bar across the top of the play
 * area holding, left to right: camera controls · floor selector · timer
 * chips · 🔔 notification bell. Replaces four separately-floating panels
 * so there is exactly one place where "controls" live — the #1 GUI
 * complaint from PC testers.
 *
 * Hosted children keep their own classes (cb-cameracontrols, cb-floorsel)
 * because MobileUI's stylesheet re-parks them with `position: fixed
 * !important` overrides — on phones they pop out of the strip and land
 * exactly where the mobile layout always put them, so mobile is
 * untouched by this refactor.
 */

export class TopStrip {
  readonly root: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.classList.add("cb-topstrip");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      // Sidebar occupies x 12..268; BuildMenu owns right:12 + 300px wide.
      left: "280px",
      right: "324px",
      display: "flex",
      flexDirection: "row",
      flexWrap: "wrap", // narrow screens: timer chips wrap to a second line
      alignItems: "center",
      gap: "8px 14px",
      padding: "6px 12px",
      background: "rgba(20, 14, 10, 0.86)",
      borderRadius: "12px",
      boxShadow: "0 4px 18px rgba(0,0,0,0.40)",
      color: "#fff5dc",
      pointerEvents: "auto",
      zIndex: "5",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);
  }
}
