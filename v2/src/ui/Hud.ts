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
  isMusicMuted: () => boolean;
  toggleMusic: () => boolean;
  /** SFX bus level, 0..1. Drives the volume slider in the HUD. */
  getSfxVolume: () => number;
  setSfxVolume: (v: number) => void;
  /** Functional seat counts surfaced in the HUD's SEATS card.
   * Optional because the spawner may not exist for the first few
   * frames; HUD shows "—" when this returns undefined. */
  getSeatStats?: () => { avail: number; total: number } | undefined;
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
  private musicBtn?: HTMLButtonElement;
  private volumeSlider?: HTMLInputElement;
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
    // Two-line title: brand + small "your restaurant" subtitle so the
    // panel reads as a proper info card instead of a stripped header.
    t.innerHTML = `<span style="font-size:14px;font-weight:800;letter-spacing:0.06em;">COZY BISTRO 3D</span><div style="font-size:9px;font-weight:600;letter-spacing:0.18em;opacity:0.55;margin-top:1px;">YOUR RESTAURANT</div>`;
    Object.assign(t.style, {
      marginBottom: "8px", textAlign: "center", opacity: "0.95",
      padding: "6px 8px",
      background: "linear-gradient(180deg, rgba(255,245,220,0.08), rgba(255,245,220,0.02))",
      border: "1px solid rgba(255,245,220,0.12)",
      borderRadius: "5px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(t);
  }

  /** Visually-rich stat cards. Each card is a small chip with:
   *   - icon (emoji or symbol)
   *   - uppercase label (small, dimmed)
   *   - value (large, bold, colour-coded to the stat)
   * 2-column grid, with the "money" card spanning both columns at the
   * top because cash on hand is the headline number players check most.
   *
   * Hover tooltips on every card explain what the stat means + why it
   * matters — players opening the game for the first time get the same
   * vocabulary the menus use ("rating", "served", "lost", etc).
   */
  private buildStatsGrid(): void {
    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "5px",
      fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    interface StatSpec {
      key: string; icon: string; label: string;
      tint: string;        // background pill colour
      accent: string;      // value text colour
      tooltip: string;     // shown on hover
      span?: 1 | 2;
    }
    const specs: StatSpec[] = [
      { key: "money", icon: "💰", label: "CASH",
        tint: "rgba(120, 200, 120, 0.14)", accent: "#a8e2a8",
        tooltip: "Cash on hand. Spent on furniture, ingredients, wages, rent. " +
                 "Earned from customer orders. If it hits $0 you can still play — " +
                 "but you can't buy anything new until customers pay.",
        span: 2 },
      { key: "rating", icon: "⭐", label: "RATING",
        tint: "rgba(245, 193, 74, 0.14)", accent: "#f5c14a",
        tooltip: "Average customer rating out of 5. Driven by satisfaction (food, " +
                 "service speed, decor, bathroom quality). Higher rating attracts more " +
                 "customers and lets a recipe charge a premium." },
      { key: "weather", icon: "", label: "WEATHER",
        tint: "rgba(160, 200, 220, 0.14)", accent: "#a8d4ea",
        tooltip: "Today's weather. Affects walk-in traffic — sunny days busy, rainy " +
                 "days quieter. Plan stock + staff for the forecast." },
      { key: "day", icon: "📅", label: "DAY",
        tint: "rgba(180, 160, 220, 0.14)", accent: "#c8b5e8",
        tooltip: "Day counter. Each day ends when the in-game clock hits closing time " +
                 "and rolls a day-end summary (paying rent, wages, etc)." },
      { key: "daytime", icon: "⏰", label: "TIME LEFT",
        tint: "rgba(220, 180, 130, 0.14)", accent: "#e8c89a",
        tooltip: "Real seconds left in the in-game day. When it hits 0:00 the day ends, " +
                 "rent and wages are deducted, and a new day starts." },
      // Customers in vs seats available — paired so the player sees
      // "we have 8 IN and 4 SEATS left = filling up" at a glance.
      { key: "guests", icon: "👥", label: "IN",
        tint: "rgba(220, 150, 200, 0.14)", accent: "#e8b5d4",
        tooltip: "Customers currently inside the restaurant (waiting, seated, or eating). " +
                 "Watch this against SEATS — if IN approaches SEATS, you're filling up " +
                 "and walk-ins will queue / leave." },
      { key: "seats", icon: "🪑", label: "SEATS",
        tint: "rgba(160, 200, 200, 0.14)", accent: "#a8d4cc",
        tooltip: "Functional seats available right now / total functional seats. " +
                 "A seat is FUNCTIONAL when a chair is parked at one of a table's " +
                 "designated seat slots — yellow seat-slot markers show where chairs " +
                 "need to go. Add tables + chairs to grow this number." },
      // Daily outcomes — served vs lost, the two halves of the day's
      // customer count.
      { key: "served", icon: "✓", label: "SERVED",
        tint: "rgba(120, 200, 120, 0.14)", accent: "#a8e2a8",
        tooltip: "Customers served today. Each served customer paid their bill and " +
                 "left a rating contribution. Resets at day end." },
      { key: "lost", icon: "✗", label: "LOST",
        tint: "rgba(220, 100, 100, 0.14)", accent: "#ff9a9a",
        tooltip: "Customers who left without being served today — usually because the " +
                 "wait was too long. Each lost customer dings your average rating." },
      // Dish state — dirty count + total storage cap so the player can
      // see how much dishware they have AND how much is piled up.
      { key: "dishes", icon: "🍽", label: "DIRTY DISHES",
        tint: "rgba(220, 170, 100, 0.14)", accent: "#e8b878",
        tooltip: "Dirty plates + glasses piling up on tables. Waiters can't serve " +
                 "fresh food when the clean stock runs out. Build sinks / dishwashers " +
                 "to wash faster; turns red when the pile is overwhelming the kitchen." },
      { key: "storage", icon: "📦", label: "PANTRY STOCK",
        tint: "rgba(200, 180, 130, 0.14)", accent: "#e0c898",
        tooltip: "Per-ingredient stock target / max allowed. The auto-shop refills " +
                 "every ingredient toward your chosen target each day. The MAX grows " +
                 "with placed fridges + storage furniture (each fridge's stockCapacity " +
                 "raises the ceiling); raise the slider in the Pantry modal to use it." },
      // Daily expenses — rent + wages paired so the player can read
      // their fixed-cost burden side by side.
      { key: "rent", icon: "🏠", label: "RENT/DAY",
        tint: "rgba(180, 180, 200, 0.14)", accent: "#c8c8e0",
        tooltip: "Daily rent charged at day end. Grows with the size + tier of your " +
                 "restaurant. Track it against your daily revenue to know if you're " +
                 "profitable." },
      { key: "wages", icon: "💵", label: "WAGES/MIN",
        tint: "rgba(180, 200, 180, 0.14)", accent: "#bce0bc",
        tooltip: "Total staff payroll per in-game minute, across every hired chef, " +
                 "waiter, and errand helper. Charged continuously throughout the day; " +
                 "compare to RENT to see your full fixed-cost burden." },
    ];
    for (const s of specs) {
      const card = document.createElement("div");
      Object.assign(card.style, {
        display: "flex", flexDirection: "column",
        gap: "1px",
        padding: "4px 6px",
        background: s.tint,
        border: "1px solid rgba(255,245,220,0.10)",
        borderRadius: "4px",
        overflow: "hidden",
        gridColumn: s.span === 2 ? "1 / span 2" : "auto",
      } as Partial<CSSStyleDeclaration>);
      const topLine = document.createElement("div");
      Object.assign(topLine.style, {
        display: "flex", alignItems: "center", gap: "4px",
        fontSize: "9px", fontWeight: "700", letterSpacing: "0.08em",
        opacity: "0.65", textTransform: "uppercase",
      } as Partial<CSSStyleDeclaration>);
      if (s.icon) {
        const iconEl = document.createElement("span");
        iconEl.textContent = s.icon;
        iconEl.style.fontSize = "11px";
        iconEl.style.opacity = "1";
        topLine.appendChild(iconEl);
      }
      const labEl = document.createElement("span");
      labEl.textContent = s.label;
      topLine.appendChild(labEl);
      card.appendChild(topLine);
      const val = document.createElement("div");
      val.textContent = "—";
      Object.assign(val.style, {
        fontSize: s.span === 2 ? "16px" : "13px",
        fontWeight: "700",
        color: s.accent,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        fontVariantNumeric: "tabular-nums",
        lineHeight: "1.15",
      } as Partial<CSSStyleDeclaration>);
      card.appendChild(val);
      grid.appendChild(card);
      this.fields[s.key] = val;
      attachTooltip(card, s.tooltip);
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
    // Speed / pause buttons have moved into the Dev tools dropdown
    // (see buildDevSection). This row now hosts the audio controls:
    // a master SFX volume slider plus the existing mute and music
    // toggles. Speed control isn't something a casual player needs at
    // their fingertips most of the time — the volume slider is.
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", gap: "3px", marginTop: "5px", alignItems: "center",
    } as Partial<CSSStyleDeclaration>);
    // Speaker icon on the left as a visual cue that the slider drives
    // sound effects.
    const speakerIcon = document.createElement("span");
    speakerIcon.textContent = "🔊";
    Object.assign(speakerIcon.style, {
      fontSize: "12px", flex: "0 0 18px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(speakerIcon);
    // The slider itself — 0..100 (integer, easy to think about) maps
    // directly onto the SfxPlayer's 0..1 volume.
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(this.actions.getSfxVolume() * 100));
    Object.assign(slider.style, {
      flex: "1", minWidth: "0",
      cursor: "pointer",
      accentColor: "#7bc97b",
    } as Partial<CSSStyleDeclaration>);
    slider.title = "Sound effects volume";
    slider.oninput = () => {
      const v = Number(slider.value);
      this.actions.setSfxVolume(v / 100);
    };
    row.appendChild(slider);
    this.volumeSlider = slider;
    const mute = document.createElement("button");
    Object.assign(mute.style, this.tinyBtnStyle() as Partial<CSSStyleDeclaration>);
    mute.style.flex = "0 0 28px";
    mute.onclick = () => { this.actions.toggleMute(); this.update(); };
    row.appendChild(mute);
    this.muteBtn = mute;
    // Music toggle — independent from SFX so the player can leave the
    // pad off but still hear plates clinking + the kitchen sizzling.
    const music = document.createElement("button");
    Object.assign(music.style, this.tinyBtnStyle() as Partial<CSSStyleDeclaration>);
    music.style.flex = "0 0 28px";
    music.onclick = () => { this.actions.toggleMusic(); this.update(); };
    row.appendChild(music);
    this.musicBtn = music;
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
    // Speed / pause controls — moved here so the always-visible HUD row
    // can host the more frequently-touched volume slider instead.
    const speedHeader = document.createElement("div");
    speedHeader.textContent = "Game speed";
    Object.assign(speedHeader.style, {
      fontSize: "9px", opacity: "0.65",
      letterSpacing: "0.06em", textTransform: "uppercase",
      marginBottom: "3px",
    } as Partial<CSSStyleDeclaration>);
    section.appendChild(speedHeader);
    const speedRow = document.createElement("div");
    Object.assign(speedRow.style, {
      display: "flex", gap: "3px", marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    const choices: { label: string; action: () => void; key: string }[] = [
      { label: "‖",  action: () => this.time.setPaused(true),                                                  key: "pause" },
      { label: "1×", action: () => { this.time.setPaused(false); this.time.setTimeScale(1); },                 key: "1" },
      { label: "2×", action: () => { this.time.setPaused(false); this.time.setTimeScale(2); },                 key: "2" },
      { label: "4×", action: () => { this.time.setPaused(false); this.time.setTimeScale(4); },                 key: "4" },
    ];
    for (const c of choices) {
      const btn = document.createElement("button");
      btn.textContent = c.label;
      Object.assign(btn.style, this.tinyBtnStyle() as Partial<CSSStyleDeclaration>);
      btn.style.flex = "1";
      btn.onclick = () => { c.action(); this.update(); };
      speedRow.appendChild(btn);
      this.speedBtns[c.key] = btn;
    }
    section.appendChild(speedRow);
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
    // Cash with thousands separator — $19,716 reads more cleanly than
    // $19716. Red accent when negative (still rendered: the game lets
    // you go below zero through wages / rent).
    this.fields.money.textContent = `$${money.toLocaleString("en-US")}`;
    this.fields.money.style.color = money < 0 ? "#ff9a9a" : money < 200 ? "#e8c89a" : "#a8e2a8";
    // Rating shown out of 5 so the number has a built-in scale reference.
    this.fields.rating.textContent = `${rating} / 5`;
    this.fields.day.textContent = `${day}`;
    // Weather: emoji on its own line above the label so the icon is
    // unmistakable instead of squished into the value cell.
    this.fields.weather.textContent = `${w.emoji} ${w.label}`;
    this.fields.guests.textContent = `${guests}`;
    this.fields.served.textContent = `${served}`;
    this.fields.lost.textContent = `${lost}`;
    // Time left — orange tint when the day is in its last 60 seconds so
    // the player knows to close out remaining orders.
    this.fields.daytime.textContent = `${mins}:${secs}`;
    this.fields.daytime.style.color = remaining < 60 ? "#ff9a9a" : "#e8c89a";
    // Dirty count / true total owned (clean + dirty + in-flight).
    // Without the in-flight term the denominator dropped by 1 each
    // time a customer started eating — the user (rightly) read that
    // as a 1-per-second leak. Now the total reflects everything the
    // restaurant actually owns regardless of who's holding the plate.
    const totalDish = this.game.dishware.getTotalOwned() + this.game.getInFlightDishCount();
    this.fields.dishes.textContent = `${dishes} / ${totalDish}`;
    this.fields.dishes.style.color = this.game.isDishPileOverwhelming() ? "#ff9a9a" : "#e8b878";
    this.fields.rent.textContent = `$${rent}`;
    // Pantry stock target / max allowed. The target is what the
    // auto-shop refills toward; the max is capped by fridges +
    // storage furniture. Shows e.g. "10 / 22" — the player's chosen
    // level vs the highest they can currently set it.
    const stockTarget = this.game.getStockTarget();
    const stockMax = this.game.getMaxStockTarget();
    this.fields.storage.textContent = `${stockTarget} / ${stockMax}`;
    // Amber when the player is already at the ceiling (more fridges
    // would raise it), neutral otherwise.
    this.fields.storage.style.color = (stockMax > 0 && stockTarget >= stockMax)
      ? "#e8c89a" : "#e0c898";
    // Total payroll per in-game minute = headcount × per-staff rate.
    const headcount = this.game.staff.getTotalStaff();
    const perStaff = this.game.admin.payrollPerStaffPerMinute;
    const wagesPerMin = headcount * perStaff;
    this.fields.wages.textContent = `$${wagesPerMin}`;
    // Functional seats — available now / total currently provisioned.
    // Spawner is optional on the very first frames so default to "—".
    const seatStats = this.actions.getSeatStats?.();
    if (seatStats) {
      this.fields.seats.textContent = `${seatStats.avail} / ${seatStats.total}`;
      // Red when nothing's free, amber when ≤20% free, otherwise neutral.
      const ratio = seatStats.total > 0 ? seatStats.avail / seatStats.total : 0;
      this.fields.seats.style.color = ratio === 0 ? "#ff9a9a"
        : ratio < 0.2 ? "#e8c89a" : "#a8d4cc";
    } else {
      this.fields.seats.textContent = "—";
    }

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
    if (this.volumeSlider) {
      // Keep the slider in sync if anything else (admin tools etc.)
      // changes the volume; skip the assignment if the user is mid-drag
      // so we don't fight their input.
      const target = String(Math.round(this.actions.getSfxVolume() * 100));
      if (document.activeElement !== this.volumeSlider && this.volumeSlider.value !== target) {
        this.volumeSlider.value = target;
      }
    }
    if (this.muteBtn) {
      const muted = this.actions.isMuted();
      this.muteBtn.textContent = muted ? "🔇" : "🔈";
      this.muteBtn.title = muted ? "Sound off — click to enable" : "Sound on — click to mute";
    }
    if (this.musicBtn) {
      const muted = this.actions.isMusicMuted();
      this.musicBtn.textContent = muted ? "🎵̸" : "🎵";
      this.musicBtn.style.opacity = muted ? "0.45" : "1";
      this.musicBtn.title = muted ? "Music off — click to enable" : "Music on — click to mute";
    }
    if (this.devToggle) {
      this.devToggle.style.background = this.devOpen ? "rgba(255,245,220,0.18)" : "rgba(180, 180, 180, 0.18)";
    }
  }
}
