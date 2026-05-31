import type { IsoCamera } from "../scene/IsoCamera";

/**
 * Compact camera-control widget pinned to the top of the viewport,
 * just to the right of the 256px-wide Sidebar (the Sidebar lives at
 * top:12 / left:12 and FloorSelector is top-center). Two columns of
 * buttons:
 *
 *   [ +  ]  [ ⟲ ]
 *   [ 38%]  [ N ]   ← live indicators
 *   [ −  ]  [ ⟳ ]
 *   [ ⌂  ]  [ ⌂ ]   ← reset buttons (zoom 1×, rotation 45°)
 *
 * The indicators are read from the IsoCamera every animation frame so
 * they update when the player wheel-zooms or right-drag rotates the
 * scene too — not only when they click the on-screen buttons.
 *
 * Zoom buttons multiply by a fixed factor (1.4× per click) so click
 * cadence matches the wheel's exponential feel. Rotation buttons step
 * by 22.5° per click — half of an octant — so a couple of clicks
 * rotates the view to the next cardinal direction.
 */
export class CameraControls {
  private readonly camera: IsoCamera;
  /** Callback returning the world (x, z) the Home button should snap
   * to. Engine wires this to scene.ownedPlotAnchor so the button
   * always points at the player's claimed building, even if they
   * later move to a different plot. */
  private readonly getHomePos: () => { x: number; z: number };
  private readonly zoomPct: HTMLDivElement;
  private readonly dirLabel: HTMLDivElement;
  private readonly dirArrow: HTMLDivElement;

  /** Multiplier applied per zoom-button click. <1 zooms in, >1 zooms out. */
  private static readonly ZOOM_STEP = 1.4;
  /** Rotation step per rotate-button click, in radians (22.5° = π/8). */
  private static readonly ROT_STEP = Math.PI / 8;

  constructor(parent: HTMLElement, camera: IsoCamera, getHomePos: () => { x: number; z: number }) {
    this.camera = camera;
    this.getHomePos = getHomePos;

    const root = document.createElement("div");
    Object.assign(root.style, {
      position: "fixed",
      top: "12px",
      // Sidebar occupies 12..268 (256px + left:12). 12px gap = 280.
      left: "280px",
      display: "flex",
      flexDirection: "row",
      gap: "8px",
      padding: "8px 10px",
      background: "rgba(20, 14, 10, 0.86)",
      borderRadius: "12px",
      boxShadow: "0 4px 18px rgba(0,0,0,0.40)",
      color: "#fff5dc",
      font: "12px/1.2 system-ui, sans-serif",
      pointerEvents: "auto",
      zIndex: "5",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(root);

    // ── Zoom column ────────────────────────────────────────────────
    const zoomCol = this.makeColumn();
    const zoomIn = this.makeBtn("+", "Zoom in",
      () => camera.zoomBy(1 / CameraControls.ZOOM_STEP));
    const zoomPct = this.makeIndicator("100%");
    const zoomOut = this.makeBtn("−", "Zoom out",
      () => camera.zoomBy(CameraControls.ZOOM_STEP));
    const zoomReset = this.makeBtn("⌂", "Reset zoom",
      () => camera.resetZoom(), true);
    zoomCol.appendChild(zoomIn);
    zoomCol.appendChild(zoomPct);
    zoomCol.appendChild(zoomOut);
    zoomCol.appendChild(zoomReset);
    root.appendChild(zoomCol);
    this.zoomPct = zoomPct;

    // ── Rotation column ────────────────────────────────────────────
    const rotCol = this.makeColumn();
    // The rotate-LEFT button visually turns the world clockwise from
    // the player's perspective, which means decreasing azimuth in our
    // math. Likewise rotate-RIGHT increases azimuth. (Match what the
    // right-drag camera does — drag right = camera turns right.)
    const rotLeft = this.makeBtn("⟲", "Rotate left (clockwise)",
      () => camera.rotateBy(CameraControls.ROT_STEP));
    const dirHolder = this.makeIndicator("N");
    // Inside the direction indicator we also draw a tiny arrow that
    // points the same way the camera is facing — visual reinforcement
    // beyond the N/E/S/W letter so the orientation is obvious at a
    // glance.
    const dirArrow = document.createElement("div");
    Object.assign(dirArrow.style, {
      fontSize: "13px",
      lineHeight: "1",
      marginTop: "1px",
      transition: "transform 120ms ease-out",
    } as Partial<CSSStyleDeclaration>);
    dirArrow.textContent = "▲";
    dirHolder.appendChild(dirArrow);
    const rotRight = this.makeBtn("⟳", "Rotate right (counter-clockwise)",
      () => camera.rotateBy(-CameraControls.ROT_STEP));
    const rotReset = this.makeBtn("⌂", "Reset rotation",
      () => camera.resetRotation(), true);
    rotCol.appendChild(rotLeft);
    rotCol.appendChild(dirHolder);
    rotCol.appendChild(rotRight);
    rotCol.appendChild(rotReset);
    root.appendChild(rotCol);
    this.dirLabel = dirHolder;
    this.dirArrow = dirArrow;

    // ── Home column ────────────────────────────────────────────────
    // Single tall button that snaps the camera back to the player's
    // claimed plot at default zoom + default rotation. The current
    // floor selection (target.y) is preserved so a player who's
    // building on Floor 2 doesn't get dumped back to ground level.
    const homeCol = this.makeColumn();
    const homeBtn = document.createElement("button");
    homeBtn.textContent = "🏠";
    homeBtn.title = "Recenter on my restaurant (default zoom + rotation, keep current floor)";
    Object.assign(homeBtn.style, {
      height: "100%",
      minHeight: "98px",
      padding: "0 8px",
      background: "rgba(220, 180, 130, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.45)",
      borderRadius: "6px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "22px",
      fontWeight: "700",
      lineHeight: "1",
      textAlign: "center",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    } as Partial<CSSStyleDeclaration>);
    homeBtn.onmouseenter = () => { homeBtn.style.background = "rgba(255, 210, 160, 0.40)"; };
    homeBtn.onmouseleave = () => { homeBtn.style.background = "rgba(220, 180, 130, 0.22)"; };
    homeBtn.onclick = (e) => {
      e.preventDefault();
      const home = this.getHomePos();
      this.camera.goHome(home.x, home.z);
      this.update();
    };
    homeCol.appendChild(homeBtn);
    root.appendChild(homeCol);

    this.update();
  }

  private makeColumn(): HTMLDivElement {
    const col = document.createElement("div");
    Object.assign(col.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "stretch",
      gap: "3px",
      minWidth: "44px",
    } as Partial<CSSStyleDeclaration>);
    return col;
  }

  private makeBtn(label: string, tooltip: string, onClick: () => void, secondary = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.title = tooltip;
    Object.assign(btn.style, {
      height: secondary ? "20px" : "26px",
      padding: "0 6px",
      background: secondary ? "rgba(120, 180, 200, 0.10)" : "rgba(120, 180, 200, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "6px",
      cursor: "pointer",
      font: "inherit",
      fontSize: secondary ? "11px" : "16px",
      fontWeight: "700",
      lineHeight: "1",
      textAlign: "center",
      opacity: secondary ? "0.75" : "1",
    } as Partial<CSSStyleDeclaration>);
    btn.onmouseenter = () => { btn.style.background = secondary ? "rgba(180, 220, 240, 0.22)" : "rgba(180, 220, 240, 0.35)"; };
    btn.onmouseleave = () => { btn.style.background = secondary ? "rgba(120, 180, 200, 0.10)" : "rgba(120, 180, 200, 0.22)"; };
    btn.onclick = (e) => { e.preventDefault(); onClick(); this.update(); };
    return btn;
  }

  private makeIndicator(initial: string): HTMLDivElement {
    const ind = document.createElement("div");
    ind.textContent = initial;
    Object.assign(ind.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "2px 0",
      background: "rgba(255, 220, 150, 0.18)",
      border: "1px solid rgba(255, 220, 150, 0.35)",
      borderRadius: "6px",
      fontWeight: "700",
      fontSize: "12px",
      color: "#fff5dc",
      letterSpacing: "0.04em",
      minHeight: "22px",
      pointerEvents: "none",
    } as Partial<CSSStyleDeclaration>);
    return ind;
  }

  /** Refresh the percent / cardinal labels from the live camera. Cheap
   * enough to call every animation frame — three reads and three
   * string-assignment writes. */
  update(): void {
    const pct = Math.round(this.camera.getZoomPercent() * 100);
    // Show the textContent as "ZOOM\n<pct>%" by setting innerHTML so
    // the percentage sits on its own line under a tiny label.
    this.zoomPct.firstChild?.remove();
    const zoomLine = document.createTextNode(`${pct}%`);
    this.zoomPct.insertBefore(zoomLine, this.zoomPct.firstChild);

    const dir = this.camera.getCardinalLabel();
    // Replace only the first text node so we don't clobber the arrow div.
    if (this.dirLabel.firstChild && this.dirLabel.firstChild.nodeType === Node.TEXT_NODE) {
      this.dirLabel.firstChild.nodeValue = dir;
    } else {
      this.dirLabel.insertBefore(document.createTextNode(dir), this.dirLabel.firstChild);
    }
    // Rotate the little ▲ to match the camera's azimuth. Default
    // azimuth (45°) shows ▲ pointing up = north on our compass; from
    // there each π/2 rotation of the camera rotates the arrow 90°.
    const az = this.camera.getAzimuthDegrees();
    // Match the cardinal-label math in IsoCamera.getCardinalLabel:
    // bearing = -(az - 45) (mod 360). The arrow's CSS rotation is
    // applied clockwise from up, so we use `bearing` directly.
    const bearing = (((-(az - 45)) % 360) + 360) % 360;
    this.dirArrow.style.transform = `rotate(${bearing}deg)`;
  }
}
