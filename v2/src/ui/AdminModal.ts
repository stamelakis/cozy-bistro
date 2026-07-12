import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { STAFF_UPGRADE_MAX } from "../systems/StaffSystem";
import type { SfxPlayer } from "./SfxPlayer";
import type { SpacetimeClient } from "../cloud/SpacetimeClient";
import { DAY_PHASES, phaseForProgress } from "../systems/DayCycleSystem";

/** Same shape as the HUD's TimeControl — passed in by Engine so
 * the admin panel can host the speed buttons (moved here from the
 * old in-sidebar dev section). */
export interface AdminTimeControl {
  isPaused(): boolean;
  setPaused(p: boolean): void;
  getTimeScale(): number;
  setTimeScale(s: number): void;
}

/** Every appliance loop the SfxPlayer can drive, plus a couple of
 * one-shots, exposed in the admin "Audio test" section so the dev can
 * audition them in isolation. Each loop entry maps to the LoopId in
 * SfxPlayer.setLoopActive. */
const AUDIO_LOOPS: { id: string; label: string }[] = [
  { id: "gas-stove",      label: "🔥 Gas stove"      },
  { id: "electric-stove", label: "⚡ Electric stove" },
  { id: "microwave",      label: "📡 Microwave"      },
  { id: "coffee",         label: "☕ Coffee"         },
  { id: "blender",        label: "🌀 Blender"        },
  { id: "toaster",        label: "🍞 Toaster"        },
  { id: "hood",           label: "💨 Hood fan"       },
  { id: "sink",           label: "🚰 Sink"           },
  { id: "bathtub",        label: "🛁 Bathtub"        },
  { id: "dishwasher",     label: "🧽 Dishwasher"     },
  { id: "grill",          label: "🍖 Grill"          },
  { id: "fryer",          label: "🍟 Deep fryer"     },
  { id: "oven",           label: "♨️ Oven"           },
  { id: "pizza-oven",     label: "🍕 Pizza oven"     },
];

/** Approximate audible duration of each one-shot in milliseconds —
 * used to animate a progress-fill across the button while the sound
 * plays. Estimated from SfxPlayer's envelope math (attack + decay +
 * any setTimeout-scheduled tail). Slight over-estimates are better
 * than under: a bar that hits 100% before the last gurgle is harder
 * to read than one that lingers a beat. */
const AUDIO_ONESHOTS: { id: string; label: string; durationMs: number }[] = [
  { id: "toiletFlush", label: "🚽 Toilet flush", durationMs: 1500 },
  { id: "ding",        label: "🔔 Ding",         durationMs: 240  },
  { id: "chime",       label: "✨ Chime",         durationMs: 320  },
  { id: "chaching",    label: "💰 Cha-ching",    durationMs: 280  },
  { id: "gong",        label: "🪘 Gong",         durationMs: 1450 },
  { id: "alert",       label: "⚠️ Alert",         durationMs: 380  },
  { id: "thud",        label: "👎 Thud",         durationMs: 240  },
  { id: "drip",        label: "💧 Drip",         durationMs: 140  },
];

/** Inject the CSS keyframes for the loop pulse + ensure they only
 * appear once even if multiple AdminModal instances are constructed. */
const AUDIO_TEST_STYLE_ID = "admin-audio-test-styles";
function ensureAudioTestStyles(): void {
  if (document.getElementById(AUDIO_TEST_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = AUDIO_TEST_STYLE_ID;
  // playing-shimmer is the loop indicator — a soft green band that
  // sweeps left-to-right across the button continuously while the
  // loop is active. progress-fill-bar is just a sliver element we
  // animate via inline style; no keyframes needed for it.
  s.textContent = `
    @keyframes admin-audio-shimmer {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .admin-audio-loop-active {
      background: rgba(120, 200, 120, 0.30) !important;
      border-color: rgba(120, 200, 120, 0.75) !important;
      position: relative;
      overflow: hidden;
    }
    .admin-audio-loop-active::after {
      content: "";
      position: absolute;
      top: 0; left: 0; bottom: 0;
      width: 50%;
      background: linear-gradient(90deg,
        rgba(255, 255, 255, 0)   0%,
        rgba(255, 255, 255, 0.18) 50%,
        rgba(255, 255, 255, 0)   100%);
      animation: admin-audio-shimmer 1.6s linear infinite;
      pointer-events: none;
    }
  `;
  document.head.appendChild(s);
}

/**
 * Dev-mode panel — tuning sliders for live balance changes plus a
 * whole pile of one-shot "cheat" affordances (money, tier jump,
 * recipe / staff promote and demote, refill pantry, wash everything,
 * reset reputation, etc.). Nothing here is meant to ship to a regular
 * gameplay path — every method it calls on Game / its systems is
 * prefixed `admin*` so the boundary stays obvious.
 *
 * Each block of controls is a small section with its own header. Reset
 * snaps the sliders back; the actions are fire-and-forget.
 */

interface SliderDef {
  key: keyof Game["admin"];
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

const SLIDERS: SliderDef[] = [
  { key: "payrollPerStaffPerMinute", label: "Payroll / staff / min", min: 0, max: 30, step: 1,
    format: (v) => `$${v}` },
  { key: "ingredientCostMultiplier", label: "Ingredient cost ×", min: 0, max: 3, step: 0.1,
    format: (v) => v.toFixed(1) + "×" },
  { key: "spawnRateMultiplier", label: "Spawn interval ×", min: 0.25, max: 3, step: 0.05,
    format: (v) => v.toFixed(2) + "×" },
  { key: "dishWashMultiplier", label: "Dish-wash interval ×", min: 0.25, max: 3, step: 0.05,
    format: (v) => v.toFixed(2) + "×" },
  { key: "rentMultiplier", label: "Daily rent ×", min: 0, max: 3, step: 0.05,
    format: (v) => v.toFixed(2) + "×" },
];

const DEFAULTS: Record<string, number> = {
  payrollPerStaffPerMinute: 6,
  ingredientCostMultiplier: 1,
  spawnRateMultiplier: 1,
  dishWashMultiplier: 1,
  rentMultiplier: 1,
};

/** Quick-adjust deltas for the money buttons. */
const MONEY_DELTAS = [100, 1000, 10000, 100000] as const;

export class AdminModal {
  private readonly game: Game;
  private readonly sfx: SfxPlayer;
  private readonly cloud: SpacetimeClient | null;
  private readonly time: AdminTimeControl | null;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  /** Cloud-admin sections live here so we can re-render the lists
   * (pending reset tickets, banned players) without rebuilding the
   * rest of the modal each time the server state changes. Null until
   * the cloud is wired AND the current account is admin. */
  private cloudAdminBody: HTMLElement | null = null;
  /** Unsubscribe from the cloud's state-change pings. Set when we
   * subscribe in show() and cleared in hide() so the listener
   * doesn't run when nobody's looking. */
  private cloudUnsub: (() => void) | null = null;

  // === Section refs the show() refresh path reads back ===
  private readonly controls: { input: HTMLInputElement; valueEl: HTMLElement; key: string }[] = [];
  private upgradesBody!: HTMLElement;
  private moneyValue!: HTMLElement;
  private tierValue!: HTMLElement;
  private ratingValue!: HTMLElement;
  /** Audio-test rows keyed by loop id. Each row hosts a label plus
   * a ▶ and ■ button; refresh adds/removes the shimmer class so the
   * dev can see which loops are playing without relying on speakers. */
  private audioLoopRows = new Map<string, HTMLElement>();
  /** Local mirror of which loops the test panel started — flipped back
   * off when the modal closes so a hidden loop doesn't keep playing. */
  private audioTestActive = new Set<string>();

  constructor(parent: HTMLElement, game: Game, sfx: SfxPlayer, cloud: SpacetimeClient | null = null, time: AdminTimeControl | null = null) {
    this.game = game;
    this.sfx = sfx;
    this.cloud = cloud;
    this.time = time;
    // Audio-test CSS animations (shimmer / progress bar) are static —
    // one stylesheet shared across all AdminModal lifetimes.
    ensureAudioTestStyles();
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
      maxHeight: "92vh",
      display: "flex", flexDirection: "column",
      padding: "18px 22px",
      background: "rgba(28, 20, 14, 0.96)",
      color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
      overflowY: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "DEV TUNING";
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
    Object.assign(this.body.style, { display: "flex", flexDirection: "column", gap: "10px" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.body);

    // === Tuning sliders ===
    for (const def of SLIDERS) this.body.appendChild(this.renderSlider(def));
    const resetBtn = this.actionButton("Reset sliders", "danger", () => {
      for (const def of SLIDERS) {
        (this.game.admin as unknown as Record<string, number>)[def.key as string] = DEFAULTS[def.key as string];
      }
      this.refreshControls();
    });
    resetBtn.style.alignSelf = "center";
    resetBtn.style.marginTop = "4px";
    this.body.appendChild(resetBtn);

    // === Game speed section (only if a TimeControl was wired) ===
    // Migrated from the in-sidebar dev section (P12). Sits between
    // the sliders and Money so the most-used dev controls (speed +
    // money) are grouped near the top.
    // Phase 9.6 — speed section REMOVED. The world simulates 24/7 in
    // real time on the server; pause/2×/4× only desynced the local
    // render + day-clock yoke from reality and read as a lie. The
    // buildSpeedSection helper stays (dead) in case a render-only
    // pause ever comes back.
    void this.time;
    void this.buildSpeedSection;

    // === Time of day (admin) — jump the world clock to dawn/day/dusk/
    // night. Retimes lamps, pavement lights, the sun + shadows, and the
    // music in one shot. Unlike the removed pause/2×/4× speed control
    // this is a ONE-OFF jump pushed to the server (syncDayClock), so the
    // clock keeps running real-time from there — no persistent desync. ===
    body.appendChild(this.buildTimeOfDaySection());

    // === Money section ===
    body.appendChild(this.buildMoneySection());

    // === Luxury tier section ===
    body.appendChild(this.buildTierSection());

    // === Reputation section ===
    body.appendChild(this.buildReputationSection());

    // === Weather section — preview rain / snow / festival visuals
    // without waiting for the day-end roll. ===
    body.appendChild(this.buildWeatherSection());

    // === Audio test — toggle individual appliance loops + fire
    // one-shots so the dev can audition each sound in isolation. ===
    body.appendChild(this.buildAudioTestSection());

    // === Quick actions ===
    body.appendChild(this.buildQuickActionsSection());

    // === Upgrades (recipes + staff) ===
    body.appendChild(this.buildUpgradesSection());

    // === Cloud admin (visible only when the account is admin) ===
    // The container is always present so we can swap content in /
    // out without rebuilding the modal; renderCloudAdmin() decides
    // whether to populate it based on getCurrentAccount().isAdmin.
    if (this.cloud) {
      this.cloudAdminBody = document.createElement("div");
      body.appendChild(this.cloudAdminBody);
    }
  }

  // ============================================================
  //                          SECTIONS
  // ============================================================

  private buildSpeedSection(time: AdminTimeControl): HTMLElement {
    const section = this.sectionShell("⏱ GAME SPEED");
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    const speedBtns: { btn: HTMLButtonElement; key: string }[] = [];
    const choices: { label: string; tone: "good" | "neutral"; apply: () => void; isActive: () => boolean; key: string }[] = [
      { label: "‖ Pause", tone: "neutral", apply: () => time.setPaused(true),
        isActive: () => time.isPaused(), key: "pause" },
      { label: "1×",      tone: "neutral", apply: () => { time.setPaused(false); time.setTimeScale(1); },
        isActive: () => !time.isPaused() && time.getTimeScale() === 1, key: "1" },
      { label: "2×",      tone: "neutral", apply: () => { time.setPaused(false); time.setTimeScale(2); },
        isActive: () => !time.isPaused() && time.getTimeScale() === 2, key: "2" },
      { label: "4×",      tone: "neutral", apply: () => { time.setPaused(false); time.setTimeScale(4); },
        isActive: () => !time.isPaused() && time.getTimeScale() === 4, key: "4" },
    ];
    const refreshActive = (): void => {
      for (const c of speedBtns) {
        const choice = choices.find((x) => x.key === c.key);
        const active = choice?.isActive() ?? false;
        c.btn.style.background = active ? "rgba(120, 200, 120, 0.32)" : "rgba(255,245,220,0.10)";
        c.btn.style.borderColor = active ? "rgba(120, 200, 120, 0.60)" : "rgba(255,245,220,0.25)";
        c.btn.style.fontWeight = active ? "700" : "600";
      }
    };
    for (const c of choices) {
      const btn = this.actionButton(c.label, c.tone, () => { c.apply(); refreshActive(); });
      row.appendChild(btn);
      speedBtns.push({ btn, key: c.key });
    }
    refreshActive();
    section.appendChild(row);
    return section;
  }

  /** Phase 9.51 — admin time-of-day jump. One button per named phase;
   * clicking retimes the whole scene (lamps, pavement lights, sun +
   * shadows via applyDayNight, and music via sfx.setDayProgress) and
   * pushes the new clock to the server so it sticks. The current phase
   * is highlighted. */
  private buildTimeOfDaySection(): HTMLElement {
    const section = this.sectionShell("🌗 TIME OF DAY");
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", flexWrap: "wrap", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    const btns: { btn: HTMLButtonElement; key: string }[] = [];
    const refreshActive = (): void => {
      const cur = phaseForProgress(this.game.day.getDayProgress()).key;
      for (const b of btns) {
        const active = b.key === cur;
        b.btn.style.background = active ? "rgba(120, 200, 120, 0.32)" : "rgba(255,245,220,0.10)";
        b.btn.style.borderColor = active ? "rgba(120, 200, 120, 0.60)" : "rgba(255,245,220,0.25)";
        b.btn.style.fontWeight = active ? "700" : "600";
      }
    };
    for (const ph of DAY_PHASES) {
      const btn = this.actionButton(`${ph.icon} ${ph.label}`, "neutral", () => {
        const ms = this.game.day.setProgress(ph.setTo);
        this.cloud?.syncDayClock(ms);
        refreshActive();
      });
      btn.style.flex = "1 1 auto";
      btn.style.whiteSpace = "nowrap";
      row.appendChild(btn);
      btns.push({ btn, key: ph.key });
    }
    refreshActive();
    section.appendChild(row);
    return section;
  }

  private buildMoneySection(): HTMLElement {
    const section = this.sectionShell("💰 MONEY");
    const stat = document.createElement("div");
    Object.assign(stat.style, {
      fontSize: "13px", fontWeight: "700",
      color: "#ffd986", marginBottom: "4px",
      fontVariantNumeric: "tabular-nums",
    } as Partial<CSSStyleDeclaration>);
    this.moneyValue = stat;
    section.appendChild(stat);
    // Grid of +N / -N buttons.
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gap: "4px",
      gridTemplateColumns: "repeat(4, 1fr)",
    } as Partial<CSSStyleDeclaration>);
    const fmt = (n: number) => n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
    for (const delta of MONEY_DELTAS) {
      row.appendChild(this.actionButton(`+${fmt(delta)}`, "good", () => {
        this.game.economy.adminAdjust(delta);
        this.refreshStats();
      }));
    }
    for (const delta of MONEY_DELTAS) {
      row.appendChild(this.actionButton(`-${fmt(delta)}`, "danger", () => {
        this.game.economy.adminAdjust(-delta);
        this.refreshStats();
      }));
    }
    section.appendChild(row);
    // Direct set.
    const setRow = document.createElement("div");
    Object.assign(setRow.style, {
      display: "grid", gap: "4px",
      gridTemplateColumns: "1fr 60px",
      marginTop: "6px",
    } as Partial<CSSStyleDeclaration>);
    const input = document.createElement("input");
    input.type = "number";
    input.placeholder = "Set exact amount";
    input.min = "0";
    Object.assign(input.style, {
      background: "rgba(255,245,220,0.06)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.18)",
      borderRadius: "3px",
      padding: "4px 6px", font: "inherit", fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    setRow.appendChild(input);
    const setBtn = this.actionButton("Set", "neutral", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 0) return;
      this.game.economy.adminSetMoney(Math.round(v));
      this.refreshStats();
    });
    setRow.appendChild(setBtn);
    section.appendChild(setRow);
    return section;
  }

  private buildTierSection(): HTMLElement {
    const section = this.sectionShell("🏛️ LUXURY TIER");
    const stat = document.createElement("div");
    Object.assign(stat.style, {
      fontSize: "13px", fontWeight: "700",
      color: "#ffd986", marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    this.tierValue = stat;
    section.appendChild(stat);
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    for (let t = 1; t <= 5; t += 1) {
      row.appendChild(this.actionButton(`T${t}`, "neutral", () => {
        this.game.adminSetLuxuryTier(t);
        this.refreshStats();
      }));
    }
    section.appendChild(row);
    return section;
  }

  private buildReputationSection(): HTMLElement {
    const section = this.sectionShell("⭐ REPUTATION");
    const stat = document.createElement("div");
    Object.assign(stat.style, {
      fontSize: "13px", fontWeight: "700",
      color: "#ffd986", marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    this.ratingValue = stat;
    section.appendChild(stat);
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    // Pump one rating value through the system (1..5) per click.
    for (let r = 1; r <= 5; r += 1) {
      row.appendChild(this.actionButton(`${"★".repeat(r)}`, "neutral", () => {
        this.game.reputation.recordRating(r);
        this.refreshStats();
      }));
    }
    row.appendChild(this.actionButton("Reset", "danger", () => {
      this.game.adminResetReputation();
      this.refreshStats();
    }));
    section.appendChild(row);
    return section;
  }

  private buildWeatherSection(): HTMLElement {
    const section = this.sectionShell("🌦 WEATHER");
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    // One button per weather type — clicking forces it on the current
    // day so the player can preview the visual without waiting for the
    // day-end roll. Heavy rain + snowy are the new dramatic ones.
    const weathers: { id: string; emoji: string; label: string; kind: "good" | "neutral" }[] = [
      { id: "sunny",       emoji: "☀️",  label: "Sunny",      kind: "neutral" },
      { id: "cloudy",      emoji: "⛅",  label: "Cloudy",     kind: "neutral" },
      { id: "rainy",       emoji: "🌧️",  label: "Rainy",      kind: "neutral" },
      { id: "heavy-rain",  emoji: "⛈️",  label: "Heavy Rain", kind: "neutral" },
      { id: "cold",        emoji: "🥶",  label: "Cold",       kind: "neutral" },
      { id: "snowy",       emoji: "❄️",  label: "Snowy",      kind: "neutral" },
      { id: "festival",    emoji: "🎉",  label: "Festival",   kind: "good"    },
    ];
    for (const w of weathers) {
      row.appendChild(this.actionButton(`${w.emoji} ${w.label}`, w.kind, () => {
        // Weather is now GLOBAL — route the admin pick through the
        // server reducer so every connected client switches at the
        // same wallclock moment. Falls back to the local-only
        // setter if no cloud is wired (offline play).
        if (this.cloud) {
          this.cloud.adminSetWeather(w.id).catch((err) => {
            console.warn("[Admin] adminSetWeather failed:", err);
            // Local fallback so the admin still sees their pick
            // even when the reducer round-trip fails for any reason.
            this.game.weather.setById(w.id);
          });
        } else {
          this.game.weather.setById(w.id);
        }
      }));
    }
    section.appendChild(row);
    return section;
  }

  private buildAudioTestSection(): HTMLElement {
    const section = this.sectionShell("🔊 AUDIO TEST");
    const hint = document.createElement("div");
    hint.textContent = "▶ starts a loop, ■ stops it. Multiple can play at once. Shimmer = playing.";
    Object.assign(hint.style, {
      fontSize: "10px", opacity: "0.65", marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    section.appendChild(hint);
    // One row per loop: [label .........] [▶] [■]. Splitting the
    // toggle into a Play and a Stop fixes the "click does nothing"
    // confusion — Play always (re)starts, Stop always stops, regardless
    // of the current state.
    const loopGrid = document.createElement("div");
    Object.assign(loopGrid.style, {
      display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    for (const loop of AUDIO_LOOPS) {
      loopGrid.appendChild(this.buildAudioLoopRow(loop.id, loop.label));
    }
    section.appendChild(loopGrid);
    // Stop-all row — kill every loop the panel started in one click.
    const stopAll = this.actionButton("■ Stop all loops", "danger", () => {
      for (const id of Array.from(this.audioTestActive)) {
        this.sfx.setLoopTestActive(id as Parameters<SfxPlayer["setLoopTestActive"]>[0], false);
        this.refreshAudioLoopBtn(id, false);
      }
      this.audioTestActive.clear();
    });
    Object.assign(stopAll.style, { marginTop: "4px" } as Partial<CSSStyleDeclaration>);
    section.appendChild(stopAll);
    // One-shots — small grid below the loops.
    const oneshotHeader = document.createElement("div");
    oneshotHeader.textContent = "One-shots";
    Object.assign(oneshotHeader.style, {
      fontSize: "10px", opacity: "0.7", margin: "6px 0 2px 0",
    } as Partial<CSSStyleDeclaration>);
    section.appendChild(oneshotHeader);
    const oneshotGrid = document.createElement("div");
    Object.assign(oneshotGrid.style, {
      display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    for (const o of AUDIO_ONESHOTS) {
      const btn = this.actionButton(o.label, "neutral", () => {
        // Hand off to the matching method on the SfxPlayer. Cast to
        // any here is contained: AUDIO_ONESHOTS lists only valid
        // method ids and the call shape is identical for each.
        const fn = (this.sfx as unknown as Record<string, () => void>)[o.id];
        if (typeof fn === "function") fn.call(this.sfx);
        // Visual play-time bar so the dev can see "yes, the click
        // landed and a sound just fired" without relying on speaker
        // output (which can be muted, low-volume, or — as the
        // suspended-AudioContext bug showed — silent for a wholly
        // different reason).
        this.runOneShotProgress(btn, o.durationMs);
      });
      oneshotGrid.appendChild(btn);
    }
    section.appendChild(oneshotGrid);
    return section;
  }

  /** Build one loop row: [label] [▶] [■]. Play always (re)starts the
   * loop — useful when a game-driven loop (e.g. the chef's stove)
   * was already running and the dev wants to confirm what it sounds
   * like. Stop always stops. */
  private buildAudioLoopRow(id: string, label: string): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", alignItems: "center", gap: "4px",
      padding: "3px 4px 3px 8px",
      background: "rgba(255,245,220,0.10)",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      position: "relative", overflow: "hidden",
    } as Partial<CSSStyleDeclaration>);
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    Object.assign(labelEl.style, {
      flex: "1", fontSize: "11px", fontWeight: "600",
      position: "relative", zIndex: "1",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(labelEl);
    // Play and Stop as tiny side-by-side buttons. They live above the
    // shimmer overlay (z-index:1) so the shimmer can't eat their clicks.
    const playBtn = this.miniIconButton("▶", "good", () => {
      // Force a fresh start: stop any in-flight loop (engine-driven or
      // previous test) before starting so the dev always hears the
      // sound fade in from zero. setLoopTestActive takes ownership of
      // the id so the engine's per-frame setLoopActive(id, false) call
      // (fires every Engine.update tick when no chef is cooking) can't
      // turn it back off the next frame — which was why most loops
      // played silently from the test panel before.
      this.sfx.setLoopTestActive(id as Parameters<SfxPlayer["setLoopTestActive"]>[0], false);
      this.audioTestActive.add(id);
      // Small delay to let the 240 ms stop fade complete before the
      // restart — otherwise the new fade-in races the old fade-out and
      // the dev hears nothing for ~half a second.
      window.setTimeout(() => {
        if (!this.audioTestActive.has(id)) return;
        this.sfx.setLoopTestActive(id as Parameters<SfxPlayer["setLoopTestActive"]>[0], true);
        this.refreshAudioLoopBtn(id, true);
      }, 260);
      // Paint active immediately so the dev sees the click landed.
      this.refreshAudioLoopBtn(id, true);
    });
    row.appendChild(playBtn);
    const stopBtn = this.miniIconButton("■", "danger", () => {
      this.audioTestActive.delete(id);
      this.sfx.setLoopTestActive(id as Parameters<SfxPlayer["setLoopTestActive"]>[0], false);
      this.refreshAudioLoopBtn(id, false);
    });
    row.appendChild(stopBtn);
    this.audioLoopRows.set(id, row);
    return row;
  }

  /** Small ▶ / ■ button used in the audio-test loop rows. Same tone
   * palette as actionButton, but compact + raised above the shimmer
   * layer so the click always lands. */
  private miniIconButton(label: string, tone: "good" | "danger", onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    const colors = tone === "good"
      ? { bg: "rgba(120, 200, 120, 0.30)", border: "rgba(120, 200, 120, 0.60)" }
      : { bg: "rgba(200, 120, 120, 0.30)", border: "rgba(200, 120, 120, 0.60)" };
    Object.assign(btn.style, {
      width: "22px", height: "22px",
      padding: "0",
      background: colors.bg,
      color: "#fff5dc",
      border: `1px solid ${colors.border}`,
      borderRadius: "3px",
      cursor: "pointer",
      font: "inherit", fontSize: "11px", fontWeight: "700",
      lineHeight: "1",
      flex: "0 0 22px",
      position: "relative", zIndex: "2",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = onClick;
    return btn;
  }

  /** Toggle the shimmer overlay on a loop row. */
  private refreshAudioLoopBtn(id: string, active: boolean): void {
    const row = this.audioLoopRows.get(id);
    if (!row) return;
    if (active) {
      row.classList.add("admin-audio-loop-active");
    } else {
      row.classList.remove("admin-audio-loop-active");
    }
  }

  /** Render a left-to-right progress bar inside the given one-shot
   * button that fills over `durationMs` and then disappears. Gives
   * the dev visual confirmation that "yes, this click landed and the
   * sound is currently playing", even when audio is muted / the
   * speakers are off / etc. */
  private runOneShotProgress(btn: HTMLButtonElement, durationMs: number): void {
    // Mark the button so a rapid double-click doesn't spawn two
    // overlapping bars (the second would race the first to width:100%).
    const existing = btn.querySelector(".admin-audio-progress");
    if (existing) existing.remove();
    btn.style.position = "relative";
    btn.style.overflow = "hidden";
    // actionButton sets the label via textContent — a raw text node.
    // Wrap it in a relatively-positioned span the first time so the
    // animated bar (z-index 0) sits BEHIND the text instead of over
    // the top of it.
    const rawText = Array.from(btn.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
    if (rawText && rawText.nodeValue) {
      const span = document.createElement("span");
      span.textContent = rawText.nodeValue;
      Object.assign(span.style, { position: "relative", zIndex: "1" } as Partial<CSSStyleDeclaration>);
      btn.replaceChild(span, rawText);
    }
    const bar = document.createElement("div");
    bar.className = "admin-audio-progress";
    Object.assign(bar.style, {
      position: "absolute",
      left: "0",
      top: "0",
      bottom: "0",
      width: "0%",
      background: "rgba(120, 200, 120, 0.30)",
      transition: `width ${durationMs}ms linear`,
      pointerEvents: "none",
      zIndex: "0",
    } as Partial<CSSStyleDeclaration>);
    btn.appendChild(bar);
    // Two RAFs guarantee the browser commits the initial width:0%
    // before flipping to 100% — single RAF can collapse the transition
    // and the bar would just snap.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.width = "100%";
    }));
    window.setTimeout(() => { bar.remove(); }, durationMs + 100);
  }

  private buildQuickActionsSection(): HTMLElement {
    const section = this.sectionShell("⚡ QUICK ACTIONS");
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(this.actionButton("Fill pantry", "good", () => {
      this.game.adminFillPantry();
    }));
    row.appendChild(this.actionButton("Empty pantry", "danger", () => {
      this.game.adminEmptyPantry();
    }));
    row.appendChild(this.actionButton("Wash everything", "good", () => {
      this.game.dishware.adminWashAll();
    }));
    row.appendChild(this.actionButton("Soil clean (test out-of-stock)", "danger", () => {
      this.game.dishware.adminSoilAll();
    }));
    row.appendChild(this.actionButton("Toggle auto-shop", "neutral", () => {
      this.game.autoShopEnabled = !this.game.autoShopEnabled;
    }));
    section.appendChild(row);
    // Dishware reconciliation — undoes drift from the pre-fix
    // over-compensation. Resets inventory to STARTER + sum(purchase
    // log) so the player can recover from "I have 363 plates" back
    // to "I have whatever I actually bought + starter stock". Lives
    // on its own row because it triggers a confirm dialog and the
    // result text deserves its own line.
    const reconcileRow = document.createElement("div");
    Object.assign(reconcileRow.style, {
      marginTop: "6px",
      display: "flex", flexDirection: "column", gap: "3px",
    } as Partial<CSSStyleDeclaration>);
    const reconcileBtn = this.actionButton("🍽 Reconcile dishware (fix duping)", "danger", () => {
      const before = `${this.game.dishware.getOwned("plate")}p + ${this.game.dishware.getOwned("glass")}g`;
      if (!window.confirm(
        `Reset dishware inventory to STARTER + recorded purchases?\n\n` +
        `Current: ${before}\n` +
        `This wipes any phantom dishes left over from the\n` +
        `pre-fix over-compensation bug. Your purchase history\n` +
        `is preserved — only the inventory counters reset.`
      )) return;
      const after = this.game.adminReconcileDishware();
      // Brief inline feedback so the player sees the new count.
      const msg = document.createElement("div");
      msg.textContent = `Reconciled: ${before} → ${after.plates}p + ${after.glasses}g`;
      Object.assign(msg.style, {
        fontSize: "10px", opacity: "0.85", padding: "2px 4px",
        background: "rgba(120, 200, 120, 0.18)", borderRadius: "3px",
      } as Partial<CSSStyleDeclaration>);
      reconcileRow.appendChild(msg);
      window.setTimeout(() => { try { msg.remove(); } catch { /* ignore */ } }, 5000);
    });
    reconcileRow.appendChild(reconcileBtn);
    section.appendChild(reconcileRow);
    return section;
  }

  private buildUpgradesSection(): HTMLElement {
    const section = this.sectionShell("📈 MANAGE UPGRADES");
    this.upgradesBody = document.createElement("div");
    Object.assign(this.upgradesBody.style, {
      maxHeight: "32vh", overflowY: "auto",
      display: "flex", flexDirection: "column", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    section.appendChild(this.upgradesBody);
    return section;
  }

  // ============================================================
  //                       UPGRADE ROWS
  // ============================================================

  /** Populate the upgrades section with one row per recipe + one row
   * per staff member. Rows are sorted so the highest-level entries
   * sit at the top. */
  private renderUpgradesPanel(): void {
    this.upgradesBody.innerHTML = "";
    // Recipes: only the ones the player can currently see (unlocked
    // tier and known to the cooking system).
    const recipeRows = recipes
      .map((r) => ({ recipe: r, level: this.game.cooking.getRecipeUpgradeLevel(r) }))
      .filter((e) => this.game.cooking.isRecipeUnlocked(e.recipe, this.game.getLuxuryTier()))
      .sort((a, b) => b.level - a.level || a.recipe.name.localeCompare(b.recipe.name));
    for (const { recipe, level } of recipeRows) {
      this.upgradesBody.appendChild(
        this.renderUpgradeRow(`🍽️ ${recipe.name}`, level, /* max */ 10,
          (delta) => this.game.adminAdjustRecipeLevel(recipe, delta)),
      );
    }
    // Staff members.
    const trainedMembers = this.game.staff
      .getMembers()
      .slice()
      .sort((a, b) => b.upgradeLevel - a.upgradeLevel || a.name.localeCompare(b.name));
    for (const m of trainedMembers) {
      const roleEmoji = m.role === "chef" ? "🧑‍🍳" : m.role === "waiter" ? "🍽️" : "📦";
      this.upgradesBody.appendChild(
        this.renderUpgradeRow(`${roleEmoji} ${m.name}`, m.upgradeLevel, STAFF_UPGRADE_MAX,
          (delta) => this.game.adminAdjustMemberLevel(m.id, delta)),
      );
    }
    if (this.upgradesBody.childElementCount === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No upgradable rows.";
      Object.assign(empty.style, {
        opacity: "0.55", fontSize: "11px",
        padding: "8px 0", textAlign: "center",
      } as Partial<CSSStyleDeclaration>);
      this.upgradesBody.appendChild(empty);
    }
  }

  private renderUpgradeRow(
    label: string,
    level: number,
    maxLevel: number,
    onAdjust: (delta: number) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "1fr 36px 36px",
      alignItems: "center", gap: "4px",
      padding: "4px 6px",
      background: "rgba(255,245,220,0.04)",
      borderRadius: "4px",
      fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    const labelEl = document.createElement("span");
    labelEl.innerHTML = `<b>${label}</b> <span style="opacity:0.7">— L${level}</span>`;
    row.appendChild(labelEl);
    const downBtn = this.actionButton("↓", "danger", () => {
      onAdjust(-1);
      this.renderUpgradesPanel();
    });
    downBtn.disabled = level <= 0;
    if (downBtn.disabled) downBtn.style.opacity = "0.3";
    row.appendChild(downBtn);
    const upBtn = this.actionButton("↑", "good", () => {
      onAdjust(+1);
      this.renderUpgradesPanel();
    });
    upBtn.disabled = level >= maxLevel;
    if (upBtn.disabled) upBtn.style.opacity = "0.3";
    row.appendChild(upBtn);
    return row;
  }

  // ============================================================
  //                       CLOUD ADMIN (Dunnin-only)
  // ============================================================

  /** Repopulate the cloud-admin container — pending reset tickets,
   * banned-players list, and a player-action panel for ban / delete-
   * restaurant. Re-runs whenever the cloud's state changes (new
   * ticket, account banned, etc.) so the lists stay live without
   * the admin needing to close + reopen the modal.
   *
   * Bails silently when the cloud isn't connected or the current
   * account isn't admin — the container stays empty and invisible. */
  private renderCloudAdmin(): void {
    if (!this.cloudAdminBody || !this.cloud) return;
    this.cloudAdminBody.innerHTML = "";
    const account = this.cloud.getCurrentAccount();
    if (!account || !account.isAdmin) return;
    this.cloudAdminBody.appendChild(this.buildResetRequestsSection());
    this.cloudAdminBody.appendChild(this.buildBansSection());
    this.cloudAdminBody.appendChild(this.buildPlayerActionsSection());
  }

  private buildResetRequestsSection(): HTMLElement {
    const section = this.sectionShell("📨 PASSWORD RESET REQUESTS");
    if (!this.cloud) return section;
    const pending = this.cloud.listResetRequests().filter((r) => r.status === "pending");
    if (pending.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No pending requests.";
      Object.assign(empty.style, {
        opacity: "0.55", fontSize: "11px", padding: "4px 0",
      } as Partial<CSSStyleDeclaration>);
      section.appendChild(empty);
      return section;
    }
    // Sort newest first so the freshest ask is at the top.
    pending.sort((a, b) => b.createdAtMs - a.createdAtMs);
    for (const req of pending) {
      section.appendChild(this.buildResetRequestRow(req));
    }
    return section;
  }

  private buildResetRequestRow(req: { id: bigint; username: string; message: string; createdAtMs: number }): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", flexDirection: "column", gap: "4px",
      padding: "6px 8px",
      background: "rgba(255,245,220,0.06)",
      border: "1px solid rgba(255,245,220,0.18)",
      borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    const head = document.createElement("div");
    Object.assign(head.style, {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      gap: "8px",
    } as Partial<CSSStyleDeclaration>);
    const name = document.createElement("span");
    name.textContent = `@${req.username}`;
    Object.assign(name.style, {
      fontSize: "12px", fontWeight: "700", color: "#ffd986",
    } as Partial<CSSStyleDeclaration>);
    head.appendChild(name);
    const when = document.createElement("span");
    when.textContent = formatRelative(req.createdAtMs);
    Object.assign(when.style, { fontSize: "10px", opacity: "0.55" } as Partial<CSSStyleDeclaration>);
    head.appendChild(when);
    row.appendChild(head);
    const msg = document.createElement("div");
    msg.textContent = req.message || "(no message)";
    Object.assign(msg.style, {
      fontSize: "11px", opacity: "0.85",
      whiteSpace: "pre-wrap", wordBreak: "break-word",
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(msg);
    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "grid", gridTemplateColumns: "1fr 70px", gap: "4px",
      marginTop: "2px",
    } as Partial<CSSStyleDeclaration>);
    const newPwInput = document.createElement("input");
    newPwInput.type = "text";
    newPwInput.placeholder = "Temporary password (6+ chars)";
    Object.assign(newPwInput.style, {
      background: "rgba(255,245,220,0.06)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "3px",
      padding: "4px 6px", font: "inherit", fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    actions.appendChild(newPwInput);
    const resolveBtn = this.actionButton("Reset", "good", async () => {
      const pw = newPwInput.value;
      if (pw.length < 6) {
        flashMsg(row, "Password must be 6+ chars", "error");
        return;
      }
      try {
        await this.cloud!.adminResetPassword(req.username, pw, req.id);
        flashMsg(row, `Reset OK — tell @${req.username}: ${pw}`, "good");
      } catch (e) {
        flashMsg(row, errorString(e), "error");
      }
    });
    actions.appendChild(resolveBtn);
    row.appendChild(actions);
    return row;
  }

  private buildBansSection(): HTMLElement {
    const section = this.sectionShell("🚫 BANNED PLAYERS");
    if (!this.cloud) return section;
    const bans = this.cloud.listBans();
    if (bans.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No banned accounts.";
      Object.assign(empty.style, {
        opacity: "0.55", fontSize: "11px", padding: "4px 0",
      } as Partial<CSSStyleDeclaration>);
      section.appendChild(empty);
      return section;
    }
    bans.sort((a, b) => b.bannedAtMs - a.bannedAtMs);
    for (const b of bans) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "grid", gridTemplateColumns: "1fr 64px",
        gap: "6px", alignItems: "center",
        padding: "5px 8px",
        background: "rgba(200,120,120,0.08)",
        border: "1px solid rgba(200,120,120,0.30)",
        borderRadius: "4px",
      } as Partial<CSSStyleDeclaration>);
      const info = document.createElement("div");
      const reasonText = b.reason ? ` — ${b.reason}` : "";
      info.innerHTML = `<b style="color:#ffd986">@${escapeHtml(b.username)}</b>` +
        `<span style="opacity:0.75; font-size:11px">${escapeHtml(reasonText)}</span>`;
      row.appendChild(info);
      const unbanBtn = this.actionButton("Unban", "neutral", async () => {
        try {
          await this.cloud!.adminUnbanPlayer(b.username);
        } catch (e) {
          flashMsg(row, errorString(e), "error");
        }
      });
      row.appendChild(unbanBtn);
      section.appendChild(row);
    }
    return section;
  }

  private buildPlayerActionsSection(): HTMLElement {
    const section = this.sectionShell("🛠 PLAYER ACTIONS");
    const desc = document.createElement("div");
    desc.textContent = "Enter a username. Ban locks them out and frees their plot. Delete restaurant wipes their save + frees their plot, but lets them log back in.";
    Object.assign(desc.style, {
      fontSize: "10px", opacity: "0.65", marginBottom: "4px",
    } as Partial<CSSStyleDeclaration>);
    section.appendChild(desc);
    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid", gridTemplateColumns: "1fr", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    const userInput = document.createElement("input");
    userInput.type = "text";
    userInput.placeholder = "Username (e.g. alice)";
    Object.assign(userInput.style, {
      background: "rgba(255,245,220,0.06)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "3px",
      padding: "5px 8px", font: "inherit", fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    grid.appendChild(userInput);
    const reasonInput = document.createElement("input");
    reasonInput.type = "text";
    reasonInput.placeholder = "Ban reason (optional — shown to the player)";
    Object.assign(reasonInput.style, {
      background: "rgba(255,245,220,0.06)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "3px",
      padding: "5px 8px", font: "inherit", fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    grid.appendChild(reasonInput);
    const buttonRow = document.createElement("div");
    Object.assign(buttonRow.style, {
      display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    const banBtn = this.actionButton("🚫 Ban player", "danger", async () => {
      const u = userInput.value.trim();
      if (!u) { flashMsg(section, "Enter a username", "error"); return; }
      // Belt-and-braces confirm so a stray click doesn't nuke
      // an active player — server enforces the same gate.
      if (!window.confirm(`Ban @${u}? This frees their plot and prevents login.`)) return;
      try {
        await this.cloud!.adminBanPlayer(u, reasonInput.value);
        userInput.value = ""; reasonInput.value = "";
        flashMsg(section, `Banned @${u}`, "good");
      } catch (e) {
        flashMsg(section, errorString(e), "error");
      }
    });
    buttonRow.appendChild(banBtn);
    const deleteBtn = this.actionButton("🗑 Delete restaurant", "danger", async () => {
      const u = userInput.value.trim();
      if (!u) { flashMsg(section, "Enter a username", "error"); return; }
      if (!window.confirm(`Wipe @${u}'s restaurant save and free their plot? They can log in again and pick a new plot.`)) return;
      try {
        await this.cloud!.adminDeleteRestaurant(u);
        userInput.value = ""; reasonInput.value = "";
        flashMsg(section, `Wiped @${u}'s restaurant`, "good");
      } catch (e) {
        flashMsg(section, errorString(e), "error");
      }
    });
    buttonRow.appendChild(deleteBtn);
    grid.appendChild(buttonRow);
    section.appendChild(grid);
    return section;
  }

  // ============================================================
  //                       UI helpers
  // ============================================================

  private sectionShell(title: string): HTMLElement {
    const section = document.createElement("div");
    Object.assign(section.style, {
      marginTop: "12px", paddingTop: "10px",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      display: "flex", flexDirection: "column", gap: "4px",
    } as Partial<CSSStyleDeclaration>);
    const t = document.createElement("div");
    t.textContent = title;
    Object.assign(t.style, {
      fontSize: "12px", fontWeight: "700",
      letterSpacing: "0.04em", opacity: "0.85",
      marginBottom: "2px",
    } as Partial<CSSStyleDeclaration>);
    section.appendChild(t);
    return section;
  }

  private actionButton(label: string, tone: "good" | "danger" | "neutral", onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    const colors = tone === "good"
      ? { bg: "rgba(120, 200, 120, 0.18)", border: "rgba(120, 200, 120, 0.40)" }
      : tone === "danger"
      ? { bg: "rgba(200, 120, 120, 0.18)", border: "rgba(200, 120, 120, 0.40)" }
      : { bg: "rgba(255, 245, 220, 0.10)", border: "rgba(255, 245, 220, 0.25)" };
    Object.assign(btn.style, {
      padding: "5px 8px",
      background: colors.bg,
      color: "#fff5dc",
      border: `1px solid ${colors.border}`,
      borderRadius: "3px",
      cursor: "pointer",
      font: "inherit", fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = onClick;
    return btn;
  }

  private renderSlider(def: SliderDef): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", flexDirection: "column", gap: "3px" } as Partial<CSSStyleDeclaration>);
    const top = document.createElement("div");
    Object.assign(top.style, { display: "flex", justifyContent: "space-between" } as Partial<CSSStyleDeclaration>);
    const label = document.createElement("span");
    label.textContent = def.label;
    label.style.opacity = "0.85";
    const value = document.createElement("span");
    Object.assign(value.style, { fontWeight: "700", color: "#ffd986", fontVariantNumeric: "tabular-nums" } as Partial<CSSStyleDeclaration>);
    top.appendChild(label);
    top.appendChild(value);
    row.appendChild(top);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    const current = (this.game.admin as unknown as Record<string, number>)[def.key as string];
    input.value = String(current);
    value.textContent = def.format(current);
    input.oninput = () => {
      const v = Number(input.value);
      (this.game.admin as unknown as Record<string, number>)[def.key as string] = v;
      value.textContent = def.format(v);
    };
    row.appendChild(input);
    this.controls.push({ input, valueEl: value, key: def.key as string });
    return row;
  }

  private refreshControls(): void {
    for (const c of this.controls) {
      const v = (this.game.admin as unknown as Record<string, number>)[c.key];
      const def = SLIDERS.find((d) => d.key === c.key);
      if (!def) continue;
      c.input.value = String(v);
      c.valueEl.textContent = def.format(v);
    }
  }

  /** Refresh the section header value rows (money, tier, rating).
   * Cheap; runs on every action-button click so the displays stay
   * in sync without polling. */
  private refreshStats(): void {
    if (this.moneyValue) {
      this.moneyValue.textContent = `Current: $${this.game.economy.getMoney().toLocaleString()}`;
    }
    if (this.tierValue) {
      this.tierValue.textContent = `Current: T${this.game.getLuxuryTier()}`;
    }
    if (this.ratingValue) {
      const r = this.game.reputation.getAverageRating();
      this.ratingValue.textContent = `Current: ${r.toFixed(2)} ★`;
    }
  }

  show(): void {
    this.refreshControls();
    this.refreshStats();
    this.renderUpgradesPanel();
    this.renderCloudAdmin();
    // Live-refresh the cloud admin panel when reset tickets / bans
    // mutate so a freshly resolved ticket disappears without the
    // admin having to close and reopen the modal.
    if (this.cloud && !this.cloudUnsub) {
      this.cloudUnsub = this.cloud.subscribe(() => {
        // Cheap: only the cloud-admin container repaints; the rest
        // of the modal is static between shows.
        this.renderCloudAdmin();
      });
    }
    this.root.style.display = "flex";
  }
  hide(): void {
    // Stop every audio-test loop the dev started — otherwise a forgotten
    // "blender" toggle keeps running invisibly after the modal closes,
    // AND we have to release the test lock or the engine can't drive
    // that loop again until the page reloads.
    for (const id of Array.from(this.audioTestActive)) {
      this.sfx.setLoopTestActive(id as Parameters<SfxPlayer["setLoopTestActive"]>[0], false);
      this.refreshAudioLoopBtn(id, false);
    }
    this.audioTestActive.clear();
    // Release the cloud subscription so we're not re-rendering an
    // invisible panel every time something changes on the server.
    if (this.cloudUnsub) { this.cloudUnsub(); this.cloudUnsub = null; }
    this.root.style.display = "none";
  }
}

// ============================================================
//                       MODULE HELPERS
// ============================================================

/** Render a short relative-time label ("2 min ago", "1 h ago"). */
function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

/** Pop an inline message INSIDE a section / row that auto-fades.
 * Used for ban / reset / delete confirmations + errors so the admin
 * gets feedback in-context without a separate toast system. */
function flashMsg(parent: HTMLElement, text: string, kind: "good" | "error"): void {
  // Remove a prior message so they don't stack on a rapid-fire click.
  const prior = parent.querySelector(".admin-flash");
  if (prior) prior.remove();
  const el = document.createElement("div");
  el.className = "admin-flash";
  el.textContent = text;
  const palette = kind === "good"
    ? { bg: "rgba(120, 200, 120, 0.20)", color: "rgba(200, 250, 200, 0.95)" }
    : { bg: "rgba(200, 120, 120, 0.20)", color: "rgba(255, 200, 200, 0.95)" };
  Object.assign(el.style, {
    marginTop: "4px",
    padding: "4px 6px",
    background: palette.bg,
    color: palette.color,
    border: `1px solid ${palette.color}`,
    borderRadius: "3px",
    fontSize: "11px",
    fontWeight: "600",
    wordBreak: "break-word",
  } as Partial<CSSStyleDeclaration>);
  parent.appendChild(el);
  window.setTimeout(() => {
    try { el.remove(); } catch { /* already gone */ }
  }, 4500);
}

function errorString(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Action failed";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;",
  } as Record<string, string>)[c] ?? c);
}
