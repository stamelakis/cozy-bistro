/**
 * CommandDock — the TopStrip's second row: every panel opener as a
 * Metro/Start-menu style tile. WIDE tiles (icon + label) for the actions a
 * player reaches for constantly, SMALL square tiles (icon + tooltip) for
 * the rest.
 *
 * The four STANDING panels — Build palette, Recipe Menu, Chat, Players —
 * no longer float around the screen edges on PC: their tiles TOGGLE them
 * as dropdowns hanging from this bar (Engine.toggleDock anchors them under
 * the strip). Modals (Upgrades, Pantry, …) open centered as before.
 *
 * Reuses the Hud's typed action map so both button surfaces (this dock on
 * desktop, the sidebar grid on mobile) stay in lockstep.
 */

import type { HudActions } from "./Hud";
import { ensureAttnPulseStyle } from "./uiHints";

/** Toggle handlers for the bar-anchored dropdown panels. */
export interface DockToggles {
  toggleBuild: () => void;
  toggleRecipes: () => void;
  toggleChat: () => void;
  togglePlayers: () => void;
}

interface Tile {
  icon: string;
  label: string;
  tooltip: string;
  wide: boolean;
  click: () => void;
  tint: string;
  /** localStorage key for the one-time "look here" pulse (new players). */
  attnKey?: string;
}

export class CommandDock {
  constructor(host: HTMLElement, actions: HudActions, toggles: DockToggles) {
    // Two centered rows in the strip's middle zone: SMALL icon tiles on
    // top, WIDE labeled tiles beneath — the user's spec for the bar.
    const wrap = document.createElement("div");
    wrap.classList.add("cb-topstrip-dock");
    Object.assign(wrap.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "5px",
      maxWidth: "100%",
    } as Partial<CSSStyleDeclaration>);
    const mkRow = (): HTMLDivElement => {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        gap: "5px",
      } as Partial<CSSStyleDeclaration>);
      wrap.appendChild(row);
      return row;
    };
    const rowSmall = mkRow();
    const rowWide = mkRow();
    host.appendChild(wrap);

    const tiles: Tile[] = [
      // ── WIDE — the constant-use actions ─────────────────────────────
      { icon: "🔨", label: "Build", tooltip: "Place furniture — opens the build palette", wide: true, click: toggles.toggleBuild, tint: "rgba(220, 170, 110, 0.25)" },
      { icon: "🍽", label: "Recipes", tooltip: "Choose which dishes you serve", wide: true, click: toggles.toggleRecipes, tint: "rgba(230, 170, 120, 0.22)", attnKey: "cb-attn-recipes" },
      { icon: "⚡", label: "Upgrades", tooltip: "Level up recipes + train staff (real-time timers)", wide: true, click: actions.openUpgrades, tint: "rgba(140, 200, 140, 0.22)" },
      { icon: "🧺", label: "Pantry", tooltip: "Ingredient stock, targets, auto-shop toggle, dishware", wide: true, click: actions.openPantry, tint: "rgba(220, 200, 120, 0.22)" },
      { icon: "👥", label: "Staff", tooltip: "Hire, fire, train, and assign your crew", wide: true, click: actions.openStaff, tint: "rgba(160, 180, 220, 0.22)" },
      { icon: "🎨", label: "Decor", tooltip: "Themes, wall + floor colors, sign style", wide: true, click: actions.openDecor, tint: "rgba(220, 150, 200, 0.22)" },
      // ── SMALL — everything else, one icon each ──────────────────────
      { icon: "💬", label: "Chat", tooltip: "Chat with the street", wide: false, click: toggles.toggleChat, tint: "rgba(150, 200, 230, 0.22)", attnKey: "cb-attn-chat" },
      { icon: "🌐", label: "Players", tooltip: "Who's on the server right now", wide: false, click: toggles.togglePlayers, tint: "rgba(150, 220, 190, 0.22)" },
      { icon: "👋", label: "Social", tooltip: "Friends, leaderboards, weekly challenge, profiles", wide: false, click: actions.openCloud, tint: "rgba(200, 170, 230, 0.22)" },
      { icon: "📊", label: "Trends", tooltip: "Day-by-day revenue / customers / rating", wide: false, click: actions.openStats, tint: "rgba(140, 180, 200, 0.22)" },
      { icon: "📈", label: "Analytics", tooltip: "Live customer + staff activity over time", wide: false, click: actions.openAnalytics, tint: "rgba(140, 200, 180, 0.22)" },
      { icon: "📓", label: "Ledger", tooltip: "Every transaction, line by line", wide: false, click: actions.openLedger, tint: "rgba(200, 190, 150, 0.22)" },
      { icon: "🏆", label: "Awards", tooltip: "Milestones with one-shot cash rewards", wide: false, click: actions.openAchievements, tint: "rgba(230, 200, 120, 0.22)" },
      { icon: "🏛", label: "Expand", tooltip: "Buy the next restaurant tier (new floor + recipes)", wide: false, click: actions.openExpand, tint: "rgba(190, 170, 140, 0.22)" },
      { icon: "⚙", label: "Settings", tooltip: "Audio, graphics, account", wide: false, click: actions.openSettings, tint: "rgba(200, 205, 215, 0.20)" },
      { icon: "❔", label: "Help", tooltip: "The game guide", wide: false, click: actions.openHelp, tint: "rgba(180, 200, 220, 0.22)" },
      { icon: "📮", label: "Feedback", tooltip: "Send a bug report or idea straight to the dev", wide: false, click: actions.openFeedback, tint: "rgba(220, 180, 140, 0.22)" },
      { icon: "🔧", label: "Dev tools", tooltip: "Admin tuning panel", wide: false, click: actions.openAdmin, tint: "rgba(160, 140, 220, 0.20)" },
      ...(import.meta.env.DEV
        ? [{ icon: "💾", label: "Slots", tooltip: "Local save slots (dev only)", wide: false, click: actions.openSlots, tint: "rgba(160, 180, 140, 0.22)" }]
        : []),
    ];
    for (const t of tiles) (t.wide ? rowWide : rowSmall).appendChild(makeTile(t));
  }
}

function makeTile(t: Tile): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.title = `${t.label.toUpperCase()} — ${t.tooltip}`;
  Object.assign(btn.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    height: t.wide ? "34px" : "30px",
    padding: t.wide ? "0 12px" : "0",
    width: t.wide ? "auto" : "30px",
    minWidth: t.wide ? "96px" : "30px",
    background: t.tint,
    color: "#fff5dc",
    border: "1px solid rgba(255, 245, 220, 0.20)",
    borderRadius: "7px",
    cursor: "pointer",
    font: "12px/1 system-ui, sans-serif",
    fontWeight: "700",
    letterSpacing: "0.02em",
    flexShrink: "0",
  } as Partial<CSSStyleDeclaration>);
  const icon = document.createElement("span");
  icon.textContent = t.icon;
  icon.style.fontSize = t.wide ? "15px" : "16px";
  btn.appendChild(icon);
  if (t.wide) {
    const label = document.createElement("span");
    label.textContent = t.label;
    btn.appendChild(label);
  }
  // One-time "look here" pulse for panels new players kept missing —
  // rides the tile now that the panels themselves start hidden.
  if (t.attnKey && !localStorage.getItem(t.attnKey)) {
    ensureAttnPulseStyle();
    btn.classList.add("cb-attn-pulse");
  }
  const base = t.tint;
  const hover = base.replace(/0\.2[0-9]?\)/, "0.38)");
  btn.onmouseenter = () => { btn.style.background = hover; };
  btn.onmouseleave = () => { btn.style.background = base; };
  btn.onclick = (e) => {
    e.preventDefault();
    if (t.attnKey && !localStorage.getItem(t.attnKey)) {
      localStorage.setItem(t.attnKey, "1");
      btn.classList.remove("cb-attn-pulse");
    }
    t.click();
  };
  return btn;
}
