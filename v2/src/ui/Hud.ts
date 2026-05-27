import type { Game } from "../game/Game";

/** Minimal accessor the HUD needs — we go through a getter object so the
 * Engine can construct the HUD before the spawner exists (spawner is built
 * after the staff GLBs finish loading). */
export interface SpawnerAccessor {
  getCount(): number;
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

/** Controls for the simulation clock (pause / speed). Engine wires this up
 * so the HUD can drive timeScale without depending on Engine directly. */
export interface TimeControl {
  isPaused(): boolean;
  setPaused(p: boolean): void;
  getTimeScale(): number;
  setTimeScale(scale: number): void;
}

/** Extra HUD action hooks the Engine wires in (opening modals, clearing
 * the save). Kept as a plain callback bundle so we don't pass Engine
 * directly. */
export interface HudActions {
  openLedger: () => void;
  resetSave: () => void;
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
  private readonly time: TimeControl;
  private readonly actions: HudActions;
  private readonly fields: Record<string, HTMLElement> = {};
  private readonly speedBtns: Record<string, HTMLButtonElement> = {};

  constructor(parent: HTMLElement, game: Game, spawner: SpawnerAccessor, time: TimeControl, actions: HudActions) {
    this.game = game;
    this.spawner = spawner;
    this.time = time;
    this.actions = actions;
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
    this.addRow("daytime", "Day ends in: —");
    this.addSpeedControls();
    this.addOpenCloseButton();
    this.addLedgerButton();
    this.addAdminGrantButton();
    this.addResetButton();
  }

  private addLedgerButton(): void {
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      marginTop: "4px",
      padding: "4px 8px",
      background: "rgba(200, 180, 120, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      pointerEvents: "auto",
      font: "inherit",
      width: "100%",
      fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    btn.textContent = "Show ledger";
    btn.onclick = () => this.actions.openLedger();
    this.root.appendChild(btn);
  }

  private addResetButton(): void {
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      marginTop: "4px",
      padding: "4px 8px",
      background: "rgba(200, 80, 80, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      pointerEvents: "auto",
      font: "inherit",
      width: "100%",
      fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    btn.textContent = "[dev] Reset save";
    btn.onclick = () => this.actions.resetSave();
    this.root.appendChild(btn);
  }

  private addSpeedControls(): void {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      marginTop: "6px",
      display: "flex",
      gap: "4px",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    const choices: { label: string; action: () => void; key: string }[] = [
      { label: "‖", action: () => this.time.setPaused(true), key: "pause" },
      { label: "1×", action: () => { this.time.setPaused(false); this.time.setTimeScale(1); }, key: "1" },
      { label: "2×", action: () => { this.time.setPaused(false); this.time.setTimeScale(2); }, key: "2" },
      { label: "4×", action: () => { this.time.setPaused(false); this.time.setTimeScale(4); }, key: "4" },
    ];
    for (const c of choices) {
      const btn = document.createElement("button");
      btn.textContent = c.label;
      Object.assign(btn.style, {
        flex: "1",
        padding: "4px 6px",
        background: "rgba(255,245,220,0.08)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.25)",
        borderRadius: "4px",
        cursor: "pointer",
        font: "inherit",
        fontSize: "12px",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => { c.action(); this.update(); };
      wrap.appendChild(btn);
      this.speedBtns[c.key] = btn;
    }
    this.root.appendChild(wrap);
  }

  private addAdminGrantButton(): void {
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      marginTop: "4px",
      padding: "4px 8px",
      background: "rgba(120, 140, 200, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      pointerEvents: "auto",
      font: "inherit",
      width: "100%",
      fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    btn.textContent = "[dev] +$500 starter grant";
    btn.onclick = () => {
      this.game.economy.earnMoney(500, "grant");
      this.update();
    };
    this.root.appendChild(btn);
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
    const remaining = Math.max(0, Math.ceil(this.game.day.getTimeRemainingSeconds()));
    const mins = Math.floor(remaining / 60);
    const secs = String(remaining % 60).padStart(2, "0");
    this.fields.daytime.textContent = `Day ends in: ${mins}:${secs}`;
    const open = this.spawner.isOpen();
    this.fields.openclose.textContent = open ? "OPEN — click to close" : "CLOSED — click to open";
    (this.fields.openclose as HTMLButtonElement).style.background = open
      ? "rgba(120, 200, 120, 0.18)" : "rgba(200, 120, 120, 0.18)";
    // Highlight whichever speed button matches the current state.
    const activeKey = this.time.isPaused() ? "pause" : String(this.time.getTimeScale());
    for (const [key, btn] of Object.entries(this.speedBtns)) {
      btn.style.background = key === activeKey
        ? "rgba(120, 200, 120, 0.35)"
        : "rgba(255,245,220,0.08)";
      btn.style.fontWeight = key === activeKey ? "700" : "400";
    }
  }
}
