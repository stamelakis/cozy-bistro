import type { Game } from "../game/Game";
import { StaffPanel } from "./StaffPanel";
import type { StaffRole } from "../systems/StaffSystem";

/**
 * StaffModal — the staff roster / management UI as a full popup panel (the 10th
 * top-bar button), lifted out of the cramped sidebar into a roomy overlay.
 *
 * It hosts a StaffPanel — which already owns all the hire / fire / assign /
 * floor / rest-spot logic as a chrome-less, mount-anywhere view — so there's no
 * duplicated logic. The panel's live badges refresh while the modal is open;
 * Engine wires the panel's floor / rest-spot callbacks after construction via
 * `.panel`. `show({ highlight })` pulses a role's hire button (used when the
 * service alert routes the player here to hire an errand helper).
 */
export class StaffModal {
  private readonly root: HTMLElement;
  readonly panel: StaffPanel;
  private refreshTimer: number | null = null;

  constructor(parent: HTMLElement, game: Game) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
      display: "none", alignItems: "center", justifyContent: "center",
      background: "rgba(0, 0, 0, 0.45)", zIndex: "1000", pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.hide(); });
    parent.appendChild(this.root);

    const body = document.createElement("div");
    Object.assign(body.style, {
      position: "relative",
      // Wide enough for the roster TILE GRID to run 2-3 columns on desktop
      // (it auto-fills at minmax(184px, 1fr)) and collapse to 1 on a phone.
      width: "min(760px, calc(100vw - 40px))", maxHeight: "86vh",
      display: "flex", flexDirection: "column", padding: "16px 20px 18px",
      background: "rgba(28, 20, 14, 0.96)", color: "#fff5dc",
      font: "12px/1.45 system-ui, sans-serif", borderRadius: "12px",
      border: "2px solid #d8b98f", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    const close = document.createElement("button");
    close.textContent = "✕";
    Object.assign(close.style, {
      position: "absolute", top: "10px", right: "12px", zIndex: "2",
      background: "transparent", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      width: "26px", height: "26px", cursor: "pointer", font: "inherit", fontSize: "13px",
    } as Partial<CSSStyleDeclaration>);
    close.onclick = () => this.hide();
    body.appendChild(close);

    const scroll = document.createElement("div");
    Object.assign(scroll.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(scroll);
    this.panel = new StaffPanel(scroll, game);
  }

  show(opts?: { highlight?: StaffRole }): void {
    // setVisible also starts the tiles' live model portraits (idle animation).
    this.panel.setVisible(true);
    this.root.style.display = "flex";
    if (this.refreshTimer == null) {
      this.refreshTimer = window.setInterval(() => this.panel.update(), 400);
    }
    if (opts?.highlight) {
      const role = opts.highlight;
      // Let the panel finish its layout pass, then pulse + scroll to the button.
      window.setTimeout(() => this.panel.highlightHire(role), 60);
    }
  }

  hide(): void {
    this.root.style.display = "none";
    // Stops the portrait render loop — a closed Staff menu costs no GPU.
    this.panel.setVisible(false);
    if (this.refreshTimer != null) { window.clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }
}
