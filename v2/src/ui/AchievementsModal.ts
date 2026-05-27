import type { Game } from "../game/Game";
import { ACHIEVEMENTS } from "../game/AchievementSystem";

/**
 * Achievements browser — full list with unlocked / locked state, plus a
 * count badge at the top. Pure presentation; the actual unlock detection
 * runs in AchievementSystem on a 1s tick.
 */

export class AchievementsModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "0", left: "0",
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
      width: "min(520px, calc(100vw - 40px))",
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
    title.textContent = "ACHIEVEMENTS";
    Object.assign(title.style, { fontSize: "16px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    this.countEl = document.createElement("span");
    Object.assign(this.countEl.style, { opacity: "0.7", fontSize: "12px", flex: "1", textAlign: "right", marginRight: "10px" } as Partial<CSSStyleDeclaration>);
    header.appendChild(this.countEl);
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

    this.listEl = document.createElement("div");
    Object.assign(this.listEl.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.listEl);
  }

  show(): void { this.refresh(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.countEl.textContent = `${this.game.achievements.count()} / ${this.game.achievements.total()} unlocked`;
    this.listEl.innerHTML = "";
    for (const a of ACHIEVEMENTS) {
      const unlocked = this.game.achievements.isUnlocked(a.id);
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        gap: "10px",
        padding: "8px 6px",
        borderBottom: "1px solid rgba(255,245,220,0.06)",
        opacity: unlocked ? "1" : "0.45",
      } as Partial<CSSStyleDeclaration>);
      const icon = document.createElement("span");
      icon.textContent = unlocked ? "🏆" : "🔒";
      Object.assign(icon.style, { fontSize: "20px", flex: "0 0 24px" } as Partial<CSSStyleDeclaration>);
      row.appendChild(icon);
      const text = document.createElement("div");
      Object.assign(text.style, { flex: "1" } as Partial<CSSStyleDeclaration>);
      const name = document.createElement("div");
      name.textContent = a.name;
      Object.assign(name.style, { fontWeight: "700", fontSize: "13px", color: unlocked ? "#ffd986" : undefined } as Partial<CSSStyleDeclaration>);
      const desc = document.createElement("div");
      desc.textContent = a.description;
      Object.assign(desc.style, { fontSize: "11px", opacity: "0.85" } as Partial<CSSStyleDeclaration>);
      text.appendChild(name);
      text.appendChild(desc);
      row.appendChild(text);
      this.listEl.appendChild(row);
    }
  }
}
