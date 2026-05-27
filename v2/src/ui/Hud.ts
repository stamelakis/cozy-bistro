import type { Game } from "../game/Game";

/** Minimal accessor the HUD needs — we go through a getter object so the
 * Engine can construct the HUD before the spawner exists (spawner is built
 * after the staff GLBs finish loading). */
export interface SpawnerAccessor {
  getCount(): number;
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

/**
 * Minimal HTML overlay for the 3D game: shows money, rating, day, time
 * remaining, active guests, total served, etc. Just text-on-canvas style
 * — proper UI design is a Phase 5 concern. For now this confirms the
 * gameplay systems are actually running.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly spawner: SpawnerAccessor;
  private readonly fields: Record<string, HTMLElement> = {};

  constructor(parent: HTMLElement, game: Game, spawner: SpawnerAccessor) {
    this.game = game;
    this.spawner = spawner;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      left: "12px",
      padding: "12px 16px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "13px/1.4 system-ui, sans-serif",
      borderRadius: "8px",
      pointerEvents: "none",
      minWidth: "200px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    this.addRow("title", "COZY BISTRO 3D", "16px", true);
    this.addRow("money", "Money: —");
    this.addRow("rating", "Rating: —");
    this.addRow("day", "Day: —");
    this.addRow("guests", "Guests: —");
    this.addRow("served", "Served today: —");
    this.addRow("lost", "Lost today: —");
    this.addOpenCloseButton();
  }

  private addOpenCloseButton(): void {
    const btn = document.createElement("button");
    btn.id = "hud-openclose";
    Object.assign(btn.style, {
      marginTop: "8px",
      padding: "6px 10px",
      background: "rgba(120, 200, 120, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      pointerEvents: "auto",
      font: "inherit",
      width: "100%",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = () => {
      this.spawner.setOpen(!this.spawner.isOpen());
      this.update();
    };
    this.root.style.pointerEvents = "none";
    this.root.appendChild(btn);
    this.fields.openclose = btn;
  }

  private addRow(key: string, text: string, size = "13px", bold = false): void {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.fontSize = size;
    if (bold) el.style.fontWeight = "600";
    if (bold) el.style.marginBottom = "6px";
    this.root.appendChild(el);
    this.fields[key] = el;
  }

  update(): void {
    const money = Math.round(this.game.economy.getMoney());
    const rating = this.game.reputation.getAverageRating().toFixed(1);
    const day = this.game.day.getDayNumber();
    const guests = this.spawner.getCount();
    const served = this.game.customers.getDailyServed();
    const lost = this.game.customers.getDailyLost();
    this.fields.money.textContent = `Money: $${money}`;
    this.fields.rating.textContent = `Rating: ${rating} ⭐`;
    this.fields.day.textContent = `Day: ${day}`;
    this.fields.guests.textContent = `Guests in: ${guests}`;
    this.fields.served.textContent = `Served today: ${served}`;
    this.fields.lost.textContent = `Lost today: ${lost}`;
    const open = this.spawner.isOpen();
    this.fields.openclose.textContent = open ? "OPEN — click to close" : "CLOSED — click to open";
    (this.fields.openclose as HTMLButtonElement).style.background = open
      ? "rgba(120, 200, 120, 0.18)" : "rgba(200, 120, 120, 0.18)";
  }
}
