import type { Game } from "../game/Game";
import { attachTooltip } from "./tooltip";

/** Minimal accessor the HUD needs — we go through a getter object so the
 * Engine can construct the HUD before the spawner exists (spawner is built
 * after the staff GLBs finish loading). */
export interface SpawnerAccessor {
  getCount(): number;
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

/** Controls for the simulation clock (pause / speed). */
export interface TimeControl {
  isPaused(): boolean;
  setPaused(p: boolean): void;
  getTimeScale(): number;
  setTimeScale(scale: number): void;
}

/** Modal openers + the audio + reset hooks Engine wires in. */
export interface HudActions {
  openLedger: () => void;
  openHelp: () => void;
  openStats: () => void;
  openAchievements: () => void;
  openSlots: () => void;
  openAdmin: () => void;
  openUpgrades: () => void;
  openDecor: () => void;
  openExpand: () => void;
  openPantry: () => void;
  openCloud: () => void;
  resetSave: () => void;
  isMuted: () => boolean;
  toggleMute: () => boolean;
}

/** A modal-trigger icon for the icon row. */
interface IconBtn { icon: string; title: string; click: () => void; tint?: string }

/**
 * Compact HUD: stats grid + speed/mute row + single modal icon row +
 * tiny dev sub-row at the bottom. Everything else (upgrades, decor,
 * ledger, achievements, stats, slots, admin, help) lives in modals.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly spawner: SpawnerAccessor;
  private readonly time: TimeControl;
  private readonly actions: HudActions;
  private readonly fields: Record<string, HTMLElement> = {};
  private readonly speedBtns: Record<string, HTMLButtonElement> = {};
  private muteBtn?: HTMLButtonElement;
  private openCloseBtn?: HTMLButtonElement;
  private devOpen = false;
  private devSection?: HTMLDivElement;
  private devToggle?: HTMLButtonElement;

  constructor(parent: HTMLElement, game: Game, spawner: SpawnerAccessor, time: TimeControl, actions: HudActions) {
    this.game = game;
    this.spawner = spawner;
    this.time = time;
    this.actions = actions;
    // Inline section — Sidebar provides the position/background/padding.
    this.root = document.createElement("div");
    parent.appendChild(this.root);

    this.buildTitle();
    this.buildStatsGrid();
    this.buildOpenCloseRow();
    this.buildSpeedRow();
    this.buildModalIconRow();
    this.buildDevSection();
  }

  private buildTitle(): void {
    const t = document.createElement("div");
    t.textContent = "COZY BISTRO 3D";
    Object.assign(t.style, {
      fontSize: "13px", fontWeight: "700", letterSpacing: "0.04em",
      marginBottom: "8px", textAlign: "center", opacity: "0.9",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(t);
  }

  /** 2-column compact stats grid: label/value pairs. */
  private buildStatsGrid(): void {
    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      columnGap: "6px",
      rowGap: "2px",
      fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    const pairs: { key: string; label: string }[] = [
      { key: "money", label: "$" },
      { key: "rating", label: "★" },
      { key: "day", label: "Day" },
      { key: "weather", label: "" },
      { key: "guests", label: "👥" },
      { key: "daytime", label: "⏳" },
      { key: "served", label: "✓" },
      { key: "lost", label: "✗" },
      { key: "dishes", label: "🍽" },
      { key: "rent", label: "Rent" },
    ];
    for (const p of pairs) {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "4px", overflow: "hidden" } as Partial<CSSStyleDeclaration>);
      const lab = document.createElement("span");
      lab.textContent = p.label;
      Object.assign(lab.style, { opacity: "0.55", minWidth: "20px" } as Partial<CSSStyleDeclaration>);
      const val = document.createElement("span");
      val.textContent = "—";
      Object.assign(val.style, { fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as Partial<CSSStyleDeclaration>);
      row.appendChild(lab); row.appendChild(val);
      grid.appendChild(row);
      this.fields[p.key] = val;
    }
    this.root.appendChild(grid);
  }

  private buildOpenCloseRow(): void {
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      marginTop: "8px", padding: "5px 8px", width: "100%",
      background: "rgba(120, 200, 120, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px", cursor: "pointer", font: "inherit",
      fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = () => { this.spawner.setOpen(!this.spawner.isOpen()); this.update(); };
    this.root.appendChild(btn);
    this.openCloseBtn = btn;
  }

  private buildSpeedRow(): void {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", gap: "3px", marginTop: "5px",
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
      Object.assign(btn.style, this.tinyBtnStyle() as Partial<CSSStyleDeclaration>);
      btn.style.flex = "1";
      btn.onclick = () => { c.action(); this.update(); };
      row.appendChild(btn);
      this.speedBtns[c.key] = btn;
    }
    const mute = document.createElement("button");
    Object.assign(mute.style, this.tinyBtnStyle() as Partial<CSSStyleDeclaration>);
    mute.style.flex = "0 0 28px";
    mute.onclick = () => { this.actions.toggleMute(); this.update(); };
    row.appendChild(mute);
    this.muteBtn = mute;
    this.root.appendChild(row);
  }

  /** Single icon row for opening all the modals. Tooltips on hover. */
  private buildModalIconRow(): void {
    // Two rows of 2 large labeled buttons + their secondary row.
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(2, 1fr)",
      gap: "5px", marginTop: "6px",
    } as Partial<CSSStyleDeclaration>);
    const buttons: IconBtn[] = [
      { icon: "⚡ Upgrades",   title:
          "UPGRADES — pay coins + real time to boost things.\n" +
          "Recipes: higher sell price + satisfaction per level. Staff: faster cook / service speed " +
          "+ higher effective tier. One upgrade at a time per row — they run in real-time even with " +
          "the game paused.",
        click: this.actions.openUpgrades,    tint: "rgba(140, 200, 140, 0.22)" },
      { icon: "🧺 Pantry",     title:
          "PANTRY — your raw ingredient stockpile.\n" +
          "Cooking a recipe consumes its ingredients. When a row falls below its stock target the " +
          "errand helper goes shopping. Adjust the target with the +/- buttons; raise the max with " +
          "fridges + storage furniture.",
        click: this.actions.openPantry,      tint: "rgba(220, 200, 120, 0.22)" },
      { icon: "🎨 Decor",      title:
          "DECOR — interior theme & wall colour.\n" +
          "Pick a colour palette for the floor / walls / lights. Theme bonuses tweak customer " +
          "satisfaction and ambience; doesn't affect recipes.",
        click: this.actions.openDecor,       tint: "rgba(220, 150, 200, 0.22)" },
      { icon: "📊 Trends",     title:
          "TRENDS — per-day revenue / customers / rating.\n" +
          "See whether the last few days are trending up or down so you know whether your last " +
          "build / upgrade actually helped.",
        click: this.actions.openStats,       tint: "rgba(140, 180, 200, 0.22)" },
    ];
    const row2 = document.createElement("div");
    Object.assign(row2.style, {
      display: "grid", gridTemplateColumns: "repeat(2, 1fr)",
      gap: "5px", marginTop: "5px",
    } as Partial<CSSStyleDeclaration>);
    const buttons2: IconBtn[] = [
      { icon: "🏆 Awards",     title:
          "AWARDS — long-term goals & milestones.\n" +
          "Each award lists a target (e.g. \"Serve 100 customers\", \"Hit a 4.5★ rating\") and pays " +
          "a one-shot cash reward when you cross it.",
        click: this.actions.openAchievements, tint: "rgba(220, 200, 120, 0.22)" },
      { icon: "📓 Ledger",     title:
          "LEDGER — every transaction this session.\n" +
          "Lists payments in (customer orders), payments out (rent, wages, ingredient runs, " +
          "furniture purchases). Use it to figure out where your money is going.",
        click: this.actions.openLedger,     tint: "rgba(200, 180, 120, 0.22)" },
      { icon: "☁ Cloud",       title:
          "CLOUD — online features.\n" +
          "Leaderboards (high scores), friends, public restaurants. Requires a cloud account " +
          "(set up under Slots). Offline play continues to work normally if cloud is off.",
        click: this.actions.openCloud, tint: "rgba(160, 200, 220, 0.24)" },
      { icon: "💾 Slots",      title:
          "SLOTS — local save slots + cloud sync.\n" +
          "Three local save slots; switch between them, name them, manually save / load. Same panel " +
          "controls the optional cloud-save: push your local state up, or pull a cloud save down.",
        click: this.actions.openSlots,  tint: "rgba(160, 180, 140, 0.22)" },
      { icon: "? Help",        title:
          "HELP — how to play.\n" +
          "Quick reference for the build menu, customer loop, staff roles, save system, and " +
          "keyboard shortcuts.",
        click: this.actions.openHelp,       tint: "rgba(180, 200, 220, 0.22)" },
    ];
    const row3 = document.createElement("div");
    Object.assign(row3.style, {
      display: "grid", gridTemplateColumns: "1fr",
      marginTop: "4px",
    } as Partial<CSSStyleDeclaration>);
    const buttons3: IconBtn[] = [
      { icon: "⚙ Dev tools",   title:
          "DEV TOOLS — debugging shortcuts.\n" +
          "Expands a small section under the icons with a $500 starter grant, the admin tuning " +
          "sliders (money / tier / upgrades / etc.), and a reset-save button. For experimenting " +
          "or recovering from a stuck state — not part of normal play.",
        click: () => this.toggleDev(),    tint: "rgba(180, 180, 180, 0.18)" },
    ];
    const mkBtn = (b: IconBtn, size: "big" | "med" | "small"): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.textContent = b.icon;
      // Custom delayed tooltip instead of the native `title` attribute —
      // matches the panel UI styling and gives the user a consistent
      // ~1 s reveal across browsers.
      attachTooltip(btn, b.title);
      const pad = size === "big" ? "8px 4px" : size === "med" ? "5px 3px" : "4px 2px";
      const fs = size === "big" ? "13px" : size === "med" ? "11px" : "10px";
      Object.assign(btn.style, {
        padding: pad,
        background: b.tint ?? "rgba(255,245,220,0.08)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px", cursor: "pointer", font: "inherit",
        fontSize: fs,
        fontWeight: size === "big" ? "700" : "500",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = b.click;
      return btn;
    };
    for (const b of buttons) row.appendChild(mkBtn(b, "big"));
    // Secondary row now uses the same "big" size so the layout is uniform —
    // user wanted Awards/Ledger/Cloud/Slots/Help at the same size as the
    // first row of Upgrades/Pantry/Decor/Trends.
    for (const b of buttons2) row2.appendChild(mkBtn(b, "big"));
    for (const b of buttons3) row3.appendChild(mkBtn(b, "small"));
    this.root.appendChild(row);
    this.root.appendChild(row2);
    this.root.appendChild(row3);
  }

  private buildDevSection(): void {
    const section = document.createElement("div");
    section.style.display = "none";
    section.style.marginTop = "6px";
    section.style.borderTop = "1px solid rgba(255,245,220,0.15)";
    section.style.paddingTop = "6px";
    this.devSection = section;
    const mkRow = (label: string, action: () => void, tint: string) => {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, {
        display: "block", width: "100%", marginBottom: "3px",
        padding: "4px 6px", background: tint, color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px", cursor: "pointer", font: "inherit", fontSize: "10px",
      } as Partial<CSSStyleDeclaration>);
      b.onclick = action;
      section.appendChild(b);
    };
    mkRow("+$500 starter grant", () => { this.game.economy.earnMoney(500, "grant"); this.update(); }, "rgba(120, 140, 200, 0.18)");
    mkRow("Tuning sliders",      () => this.actions.openAdmin(), "rgba(120, 140, 200, 0.18)");
    mkRow("Reset save",          () => this.actions.resetSave(), "rgba(200, 80, 80, 0.18)");
    this.root.appendChild(section);
  }

  private toggleDev(): void {
    this.devOpen = !this.devOpen;
    if (this.devSection) this.devSection.style.display = this.devOpen ? "block" : "none";
  }

  private tinyBtnStyle(): Record<string, string> {
    return {
      padding: "3px 4px",
      background: "rgba(255,245,220,0.08)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "11px",
    };
  }

  update(): void {
    const money = Math.round(this.game.economy.getMoney());
    const rating = this.game.reputation.getAverageRating().toFixed(1);
    const day = this.game.day.getDayNumber();
    const guests = this.spawner.getCount();
    const served = this.game.customers.getDailyServed();
    const lost = this.game.customers.getDailyLost();
    const remaining = Math.max(0, Math.ceil(this.game.day.getTimeRemainingSeconds()));
    const mins = Math.floor(remaining / 60);
    const secs = String(remaining % 60).padStart(2, "0");
    const dishes = this.game.getDirtyDishCount();
    const rent = this.game.getDailyRent();
    const w = this.game.weather.getCurrent();
    this.fields.money.textContent = `$${money}`;
    this.fields.rating.textContent = `${rating}`;
    this.fields.day.textContent = `${day}`;
    this.fields.weather.textContent = `${w.emoji}${w.label}`;
    this.fields.weather.title = `Weather: ${w.label}`;
    this.fields.guests.textContent = `${guests}`;
    this.fields.served.textContent = `${served}`;
    this.fields.lost.textContent = `${lost}`;
    this.fields.daytime.textContent = `${mins}:${secs}`;
    this.fields.dishes.textContent = `${dishes}`;
    this.fields.dishes.style.color = this.game.isDishPileOverwhelming() ? "#ff9a9a" : "#fff5dc";
    this.fields.rent.textContent = `$${rent}`;

    const open = this.spawner.isOpen();
    if (this.openCloseBtn) {
      this.openCloseBtn.textContent = open ? "🟢 OPEN — click to close" : "🔴 CLOSED — click to open";
      this.openCloseBtn.style.background = open ? "rgba(120, 200, 120, 0.18)" : "rgba(200, 120, 120, 0.18)";
    }
    const activeKey = this.time.isPaused() ? "pause" : String(this.time.getTimeScale());
    for (const [key, btn] of Object.entries(this.speedBtns)) {
      btn.style.background = key === activeKey
        ? "rgba(120, 200, 120, 0.35)"
        : "rgba(255,245,220,0.08)";
      btn.style.fontWeight = key === activeKey ? "700" : "400";
    }
    if (this.muteBtn) {
      const muted = this.actions.isMuted();
      this.muteBtn.textContent = muted ? "🔇" : "🔈";
      this.muteBtn.title = muted ? "Sound off — click to enable" : "Sound on — click to mute";
    }
    if (this.devToggle) {
      this.devToggle.style.background = this.devOpen ? "rgba(255,245,220,0.18)" : "rgba(180, 180, 180, 0.18)";
    }
  }
}
