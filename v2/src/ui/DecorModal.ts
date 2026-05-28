import type { Game } from "../game/Game";
import { RESTAURANT_THEMES } from "../data/themes";

/**
 * Interior-theme picker as a modal (was DecorPanel). Click outside
 * or the X to close. Each theme row shows two color swatches, name,
 * description, and price; clicking an unlocked one buys + applies.
 */

export class DecorModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0",
      width: "100vw", height: "100vh",
      display: "none",
      alignItems: "center", justifyContent: "center",
      background: "rgba(0, 0, 0, 0.45)",
      zIndex: "1000",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.hide(); });
    parent.appendChild(this.root);

    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "min(480px, calc(100vw - 40px))",
      maxHeight: "84vh",
      display: "flex", flexDirection: "column",
      padding: "18px 22px",
      background: "rgba(28, 20, 14, 0.96)",
      color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "INTERIOR THEME";
    Object.assign(title.style, { fontSize: "16px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      width: "26px", height: "26px", cursor: "pointer",
      font: "inherit", fontSize: "13px",
    } as Partial<CSSStyleDeclaration>);
    closeBtn.onclick = () => this.hide();
    header.appendChild(closeBtn);
    body.appendChild(header);

    this.body = document.createElement("div");
    Object.assign(this.body.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.body);
  }

  show(): void { this.refresh(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.body.innerHTML = "";
    const current = this.game.getCurrentTheme();
    for (const theme of RESTAURANT_THEMES) {
      const row = document.createElement("div");
      const active = theme.id === current.id;
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "10px",
        padding: "8px 10px", marginBottom: "4px",
        background: active ? "rgba(120, 200, 120, 0.18)" : "rgba(255,245,220,0.06)",
        borderRadius: "6px",
        cursor: active ? "default" : "pointer",
        border: active ? "1px solid rgba(120, 200, 120, 0.5)" : "1px solid transparent",
      } as Partial<CSSStyleDeclaration>);
      const wallSw = document.createElement("span");
      Object.assign(wallSw.style, {
        display: "inline-block", width: "14px", height: "20px",
        background: `#${theme.wallColor.toString(16).padStart(6, "0")}`,
        border: "1px solid rgba(0,0,0,0.3)",
      } as Partial<CSSStyleDeclaration>);
      const floorSw = document.createElement("span");
      Object.assign(floorSw.style, {
        display: "inline-block", width: "14px", height: "20px",
        background: `#${theme.floorColor.toString(16).padStart(6, "0")}`,
        border: "1px solid rgba(0,0,0,0.3)",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(wallSw); row.appendChild(floorSw);
      const text = document.createElement("div");
      Object.assign(text.style, { flex: "1" } as Partial<CSSStyleDeclaration>);
      const name = document.createElement("div");
      name.textContent = theme.name + (active ? "  ✓" : "");
      name.style.fontWeight = active ? "700" : "500";
      const desc = document.createElement("div");
      desc.textContent = theme.description;
      Object.assign(desc.style, { fontSize: "11px", opacity: "0.75" } as Partial<CSSStyleDeclaration>);
      text.appendChild(name); text.appendChild(desc);
      row.appendChild(text);
      const price = document.createElement("span");
      price.textContent = active ? "—" : theme.cost === 0 ? "free" : `$${theme.cost}`;
      Object.assign(price.style, { fontSize: "12px", opacity: "0.85", minWidth: "40px", textAlign: "right" } as Partial<CSSStyleDeclaration>);
      row.appendChild(price);
      if (!active) {
        const can = theme.cost === 0 || this.game.economy.canAfford(theme.cost);
        if (!can) {
          row.style.opacity = "0.4";
          row.style.cursor = "not-allowed";
        } else {
          row.onclick = () => {
            if (this.game.applyTheme(theme.id)) this.refresh();
          };
        }
      }
      this.body.appendChild(row);
    }
  }
}
