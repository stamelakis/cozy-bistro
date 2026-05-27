import type { Game } from "../game/Game";
import type { GuestSpawner } from "../game/GuestSpawner";

/**
 * Minimal HTML overlay for the 3D game: shows money, rating, day, time
 * remaining, active guests, total served, etc. Just text-on-canvas style
 * — proper UI design is a Phase 5 concern. For now this confirms the
 * gameplay systems are actually running.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly spawner: GuestSpawner;
  private readonly fields: Record<string, HTMLElement> = {};

  constructor(parent: HTMLElement, game: Game, spawner: GuestSpawner) {
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
    const guests = this.spawner.getActiveGuestCount();
    const served = this.game.customers.getDailyServed();
    this.fields.money.textContent = `Money: $${money}`;
    this.fields.rating.textContent = `Rating: ${rating} ⭐`;
    this.fields.day.textContent = `Day: ${day}`;
    this.fields.guests.textContent = `Guests in: ${guests}`;
    this.fields.served.textContent = `Served today: ${served}`;
  }
}
