import type { Game } from "../game/Game";
import { RESTAURANT_THEMES } from "../data/themes";

/**
 * Collapsible interior-theme picker. Opens from a "DECOR" button so it
 * doesn't take up screen space when the player isn't redecorating.
 * Shows the currently-applied theme, plus a list of available themes
 * with their cost; clicking one buys + applies it.
 *
 * Sits at top-left, just below the HUD.
 */

export class DecorPanel {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private collapsed = true;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      left: "240px", // sit right of the HUD
      padding: "8px 12px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "8px",
      pointerEvents: "auto",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
      maxWidth: "240px",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    this.title = document.createElement("div");
    Object.assign(this.title.style, { fontWeight: "600", fontSize: "13px", cursor: "pointer" } as Partial<CSSStyleDeclaration>);
    this.title.onclick = () => this.toggle();
    this.root.appendChild(this.title);

    this.body = document.createElement("div");
    Object.assign(this.body.style, {
      display: "none",
      marginTop: "8px",
      maxHeight: "60vh",
      overflowY: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);

    this.update();
  }

  private toggle(): void {
    this.collapsed = !this.collapsed;
    this.body.style.display = this.collapsed ? "none" : "block";
    this.update();
  }

  update(): void {
    const current = this.game.getCurrentTheme();
    this.title.textContent = `🎨 DECOR — ${current.name} ${this.collapsed ? "▾" : "▴"}`;
    if (this.collapsed) return;

    // Rebuild list every refresh so prices update with money state.
    this.body.innerHTML = "";
    for (const theme of RESTAURANT_THEMES) {
      const row = document.createElement("div");
      const active = theme.id === current.id;
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "4px 6px",
        marginBottom: "3px",
        background: active ? "rgba(120, 200, 120, 0.18)" : "rgba(255,245,220,0.06)",
        borderRadius: "4px",
        cursor: active ? "default" : "pointer",
        border: active ? "1px solid rgba(120, 200, 120, 0.5)" : "1px solid transparent",
      } as Partial<CSSStyleDeclaration>);
      // Color swatches so the player can preview without buying.
      const wallSw = document.createElement("span");
      Object.assign(wallSw.style, {
        display: "inline-block", width: "10px", height: "14px",
        background: `#${theme.wallColor.toString(16).padStart(6, "0")}`,
        border: "1px solid rgba(0,0,0,0.3)",
      } as Partial<CSSStyleDeclaration>);
      const floorSw = document.createElement("span");
      Object.assign(floorSw.style, {
        display: "inline-block", width: "10px", height: "14px",
        background: `#${theme.floorColor.toString(16).padStart(6, "0")}`,
        border: "1px solid rgba(0,0,0,0.3)",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(wallSw);
      row.appendChild(floorSw);
      const text = document.createElement("div");
      Object.assign(text.style, { flex: "1" } as Partial<CSSStyleDeclaration>);
      const name = document.createElement("div");
      name.textContent = theme.name + (active ? "  ✓" : "");
      name.style.fontWeight = active ? "700" : "500";
      const desc = document.createElement("div");
      desc.textContent = theme.description;
      Object.assign(desc.style, { fontSize: "10px", opacity: "0.7" } as Partial<CSSStyleDeclaration>);
      text.appendChild(name);
      text.appendChild(desc);
      row.appendChild(text);
      const price = document.createElement("span");
      price.textContent = active ? "—" : theme.cost === 0 ? "free" : `$${theme.cost}`;
      Object.assign(price.style, { fontSize: "11px", opacity: "0.85" } as Partial<CSSStyleDeclaration>);
      row.appendChild(price);
      if (!active) {
        const can = theme.cost === 0 || this.game.economy.canAfford(theme.cost);
        if (!can) {
          row.style.opacity = "0.4";
          row.style.cursor = "not-allowed";
        } else {
          row.onclick = () => {
            if (this.game.applyTheme(theme.id)) this.update();
          };
        }
      }
      this.body.appendChild(row);
    }
  }
}
