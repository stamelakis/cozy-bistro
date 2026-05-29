import type { IsoCamera } from "../scene/IsoCamera";
import type { WorldScene } from "../scene/WorldScene";

/**
 * Vertical strip of floor buttons pinned to the right edge of the
 * viewport. One button per storey of the building (ground + up to
 * NUM_STOREYS-1 upper floors). Pressing a button:
 *  1. Calls `scene.setFocusedStorey(idx)` so storeys above the focus
 *     are hidden and the wall-ghosting rule re-evaluates.
 *  2. Asks the camera to tween its look-at Y to `idx * STOREY_HEIGHT`,
 *     so the chosen floor sits in the middle of the view.
 *
 * Buttons for storeys that the current luxury tier has not yet unlocked
 * are rendered greyed-out and locked with a 🔒 icon.
 */
export class FloorSelector {
  private readonly root: HTMLElement;
  private readonly scene: WorldScene;
  private readonly camera: IsoCamera;
  private readonly buttons: HTMLButtonElement[] = [];

  constructor(parent: HTMLElement, scene: WorldScene, camera: IsoCamera) {
    this.scene = scene;
    this.camera = camera;

    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "50%",
      right: "12px",
      transform: "translateY(-50%)",
      display: "flex",
      flexDirection: "column-reverse", // ground at the bottom, top floor up top
      gap: "4px",
      padding: "6px",
      background: "rgba(20, 14, 10, 0.86)",
      borderRadius: "10px",
      boxShadow: "0 4px 18px rgba(0,0,0,0.40)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      pointerEvents: "auto",
      zIndex: "5",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    // One button per storey. Index 0 = ground, 1..N-1 = upper floors.
    const n = (this.scene.constructor as typeof WorldScene).getNumStoreys();
    for (let idx = 0; idx < n; idx += 1) {
      const btn = document.createElement("button");
      Object.assign(btn.style, {
        width: "44px",
        padding: "6px 0",
        background: "rgba(120, 180, 200, 0.18)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.22)",
        borderRadius: "6px",
        cursor: "pointer",
        font: "inherit",
        fontSize: "12px",
        fontWeight: "700",
        textAlign: "center",
      } as Partial<CSSStyleDeclaration>);
      const label = idx === 0 ? "G" : String(idx);
      btn.textContent = label;
      btn.title = idx === 0 ? "Ground floor" : `Floor ${idx}`;
      btn.onclick = () => this.select(idx);
      this.root.appendChild(btn);
      this.buttons.push(btn);
    }

    this.update();
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
    // floor sit comfortably below the screen middle.
    this.camera.tweenTargetY(idx * H, 0.5);

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
    }
  }
}
