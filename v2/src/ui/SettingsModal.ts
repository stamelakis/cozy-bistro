/**
 * SettingsModal — a single "⚙ Settings" popup that gathers the controls that
 * used to be scattered across the UI: graphics quality + FPS options (were near
 * the bottom of the sidebar), sound / music (were a row in the HUD), and the
 * account actions log-out + reset-save (also sidebar). None of them are things
 * a player touches often, so tucking them behind one gear button declutters the
 * playfield a lot.
 *
 * This class is only the chrome — overlay, card, title, ✕, scroll body. Engine
 * builds the actual section DOM straight into `body` (it already owns the
 * graphics/quality/logout/reset logic and the SfxPlayer). `setOnShow` lets the
 * audio section re-sync its live state (mute icon, volume position) each time
 * the modal opens.
 */
export class SettingsModal {
  private readonly root: HTMLElement;
  /** Engine appends its Graphics / Sound / Account sections here. */
  readonly body: HTMLElement;
  private onShowCb?: () => void;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
      display: "none", alignItems: "center", justifyContent: "center",
      background: "rgba(0, 0, 0, 0.45)", zIndex: "1000", pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.hide(); });
    parent.appendChild(this.root);

    const card = document.createElement("div");
    Object.assign(card.style, {
      position: "relative",
      width: "min(440px, calc(100vw - 40px))", maxHeight: "86vh",
      display: "flex", flexDirection: "column", padding: "16px 20px 18px",
      background: "rgba(28, 20, 14, 0.96)", color: "#fff5dc",
      font: "12px/1.45 system-ui, sans-serif", borderRadius: "12px",
      border: "2px solid #d8b98f", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(card);

    const title = document.createElement("div");
    title.textContent = "⚙ Settings";
    Object.assign(title.style, {
      fontWeight: "700", fontSize: "15px", marginBottom: "12px", letterSpacing: "0.02em",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(title);

    const close = document.createElement("button");
    close.textContent = "✕";
    Object.assign(close.style, {
      position: "absolute", top: "12px", right: "14px", zIndex: "2",
      background: "transparent", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      width: "26px", height: "26px", cursor: "pointer", font: "inherit", fontSize: "13px",
    } as Partial<CSSStyleDeclaration>);
    close.onclick = () => this.hide();
    card.appendChild(close);

    this.body = document.createElement("div");
    Object.assign(this.body.style, {
      flex: "1", overflowY: "auto",
      display: "flex", flexDirection: "column", gap: "16px",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.body);
  }

  /** Register a callback fired each time the modal opens — used by the audio
   * section to refresh the mute icons + volume slider to live values. */
  setOnShow(cb: () => void): void { this.onShowCb = cb; }

  show(): void { this.onShowCb?.(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }
}
