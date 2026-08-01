import type { Game } from "../game/Game";
import type { SpacetimeClient } from "../cloud/SpacetimeClient";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";
import { showEventBanner } from "./uiHints";

/**
 * Compact tier + boost widget that sits attached below the HUD. Replaces
 * the modal-only access for these two important actions — they're worth
 * being one click away.
 *
 * Layout: title bar showing "Tier N/5", expand button, separator, boost
 * button. Tooltip on the unlocks preview.
 */
/** Persistent localStorage key for the once-per-GAME-day starter grant
 * cooldown. Value is the game-day NUMBER on which the player last claimed;
 * the button re-enables once the in-game day rolls over (the server resets
 * the authoritative cooldown on rollover too, in tick_day_clock). */
const GRANT_STORAGE_KEY = "cozy-bistro.last-starter-grant-day";

/** Amount of the hardship subsidy the starter-grant button hands out. */
const STARTER_GRANT_AMOUNT = 500;
/** Player has to be below this balance to see the grant button at
 * all — it's a safety net for "ran out of money" not a free top-up. */
const STARTER_GRANT_THRESHOLD = 500;

/** Injected ONCE. The three widget buttons share a solid, raised, clearly
 * tappable look (replacing the old 0.22-alpha washes that blended into the
 * sidebar and were easy to miss on first login), plus a slow, discreet
 * "breathing" glow used to barely nudge the eye toward whichever action is
 * currently available. Hover lift + focus ring for affordance; respects
 * prefers-reduced-motion. */
let expandWidgetStylesInjected = false;
function injectExpandWidgetStyles(): void {
  if (expandWidgetStylesInjected) return;
  expandWidgetStylesInjected = true;
  const style = document.createElement("style");
  style.id = "cb-expand-widget-styles";
  style.textContent = `
    .cb-xw-btn{ width:100%; padding:9px 11px; border:none; border-radius:8px;
      cursor:pointer; color:#fff; font:700 12.5px/1.15 system-ui,sans-serif;
      letter-spacing:.01em; text-shadow:0 1px 1px rgba(0,0,0,.32);
      box-shadow:0 2px 6px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.18);
      transition:transform .12s ease, filter .12s ease, box-shadow .2s ease; }
    .cb-xw-btn:hover:not(:disabled){ filter:brightness(1.12); transform:translateY(-1px); }
    .cb-xw-btn:active:not(:disabled){ transform:translateY(1px); filter:brightness(.94); }
    .cb-xw-btn:disabled{ cursor:not-allowed; box-shadow:0 1px 3px rgba(0,0,0,.2); }
    .cb-xw-btn:focus-visible{ outline:2px solid rgba(255,240,190,.92); outline-offset:2px; }
    .cb-xw-expand{ background:linear-gradient(135deg,#54b26c,#3b8d52); }
    .cb-xw-boost{ background:linear-gradient(135deg,#cf63c4,#9a3ba6); }
    .cb-xw-grant{ background:linear-gradient(135deg,#5f8ad6,#3f61ad); }
    .cb-xw-crate{ background:linear-gradient(135deg,#5fae7a,#3f8a5a); }
    @keyframes cb-xw-pulse{
      0%,100%{ box-shadow:0 2px 6px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.18), 0 0 0 0 rgba(255,238,170,0); }
      50%{ box-shadow:0 2px 9px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.22), 0 0 13px 1px rgba(255,238,170,.5); } }
    .cb-xw-pulse{ animation:cb-xw-pulse 2.4s ease-in-out infinite; }
    @media (prefers-reduced-motion:reduce){ .cb-xw-pulse{ animation:none; } }
  `;
  document.head.appendChild(style);
}

/** Map a server crate-gift code to a friendly reveal line. */
function describeCrateGift(code: string): string {
  if (code.startsWith("cash:")) return `You won $${code.slice(5)}!`;
  if (code.startsWith("decor:")) return "You won decor — a Small Plant for your storage!";
  switch (code) {
    case "pantry": return "You won a pantry restock!";
    case "timewarp": return "Rare! A Time Warp — 25% off your longest upgrade!";
    default: return "You won a supply crate!";
  }
}

export class ExpandWidget {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly tierLabel: HTMLElement;
  private readonly expandBtn: HTMLButtonElement;
  private readonly boostBtn: HTMLButtonElement;
  private readonly grantBtn: HTMLButtonElement;
  private readonly crateBtn: HTMLButtonElement;
  private readonly unlocksLine: HTMLElement;
  private readonly cloud: SpacetimeClient;

  constructor(parent: HTMLElement, game: Game, cloud: SpacetimeClient) {
    this.game = game;
    this.cloud = cloud;
    injectExpandWidgetStyles();
    // Inline section — Sidebar handles the position/background/padding.
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      display: "flex", flexDirection: "column", gap: "6px",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    this.tierLabel = document.createElement("div");
    Object.assign(this.tierLabel.style, {
      fontWeight: "700", fontSize: "12px", letterSpacing: "0.03em",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.tierLabel);

    this.unlocksLine = document.createElement("div");
    Object.assign(this.unlocksLine.style, {
      fontSize: "10px", opacity: "0.7", marginTop: "-2px",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.unlocksLine);

    this.expandBtn = document.createElement("button");
    this.expandBtn.className = "cb-xw-btn cb-xw-expand";
    this.expandBtn.onclick = () => { if (this.game.buyExpansion()) this.update(); };
    this.root.appendChild(this.expandBtn);

    this.boostBtn = document.createElement("button");
    this.boostBtn.className = "cb-xw-btn cb-xw-boost";
    this.boostBtn.onclick = () => { if (this.game.buyBoost()) this.update(); };
    this.root.appendChild(this.boostBtn);

    // Hardship subsidy — visible only when balance < $500 AND not
    // yet claimed today. Calendar-day cooldown is stored in
    // localStorage so it survives reloads without needing server
    // state. (Server-side would prevent cheating via clearing
    // localStorage, but for v1 the local check is fine — the
    // amount is tiny relative to mid-game economy.)
    this.grantBtn = document.createElement("button");
    this.grantBtn.className = "cb-xw-btn cb-xw-grant";
    // Button is always rendered so the player can see the feature
    // exists and read its requirements. update() flips it
    // enabled/disabled based on the two conditions (balance < $500
    // and not already claimed today).
    this.grantBtn.onclick = () => {
      // Re-verify both conditions on click (UI might be stale).
      if (this.game.economy.getMoney() >= STARTER_GRANT_THRESHOLD) return;
      if (this.hasClaimedGrantToday()) return;
      this.game.economy.grantLowBalance(STARTER_GRANT_AMOUNT);
      try { localStorage.setItem(GRANT_STORAGE_KEY, String(this.game.day.getDayNumber())); } catch { /* ignore */ }
      this.update();
    };
    this.root.appendChild(this.grantBtn);

    // Supply crate — retention. Server-authoritative 3h cooldown (read from the
    // synced Restaurant row); grants a pantry top-up + a Small Plant into storage.
    this.crateBtn = document.createElement("button");
    this.crateBtn.className = "cb-xw-btn cb-xw-crate";
    this.crateBtn.onclick = () => {
      if (this.cloud.getCrateReadyInSeconds() > 0) return;
      const before = this.cloud.getLastCrateMicros();
      this.cloud.claimSupplyCrate();
      showEventBanner("🎁 Opening your supply crate…", { icon: "🎁", accent: "#a8e2a8", ms: 1600 });
      // The gift is rolled SERVER-side; poll for the row to sync back, then
      // reveal exactly what dropped.
      let tries = 0;
      const poll = (): void => {
        tries += 1;
        if (this.cloud.getLastCrateMicros() !== before) {
          showEventBanner(describeCrateGift(this.cloud.getLastCrateGift()), { icon: "🎁", accent: "#ffe08a", ms: 5000 });
          this.update();
          return;
        }
        if (tries < 15) window.setTimeout(poll, 200);
        else this.update();
      };
      window.setTimeout(poll, 250);
    };
    this.root.appendChild(this.crateBtn);

    this.update();
  }

  /** True iff the player already claimed the grant on the current GAME day. */
  private hasClaimedGrantToday(): boolean {
    try {
      const last = localStorage.getItem(GRANT_STORAGE_KEY);
      return last === String(this.game.day.getDayNumber());
    } catch { return false; }
  }

  update(): void {
    const tier = this.game.getLuxuryTier();
    const max = this.game.getMaxLuxuryTier();
    this.tierLabel.textContent = `🏛 Restaurant tier ${tier} / ${max}`;

    if (tier < max) {
      const cost = this.game.getExpansionCost();
      const nextTier = tier + 1;
      const newRecipes = recipes
        .filter((r) => getRecipeLuxuryTier(r) === nextTier)
        .map((r) => r.name);
      const seats = nextTier >= 2 && nextTier <= 4 ? " · +4 seats" : "";
      const preview = newRecipes.length === 0
        ? `tier ${nextTier} polish${seats}`
        : `${newRecipes.slice(0, 2).join(", ")}${newRecipes.length > 2 ? ` +${newRecipes.length - 2}` : ""}${seats}`;
      this.unlocksLine.textContent = `→ ${preview}`;
      this.unlocksLine.title = newRecipes.join(", ") + seats;
      this.expandBtn.textContent = `Expand → Tier ${nextTier}  ($${cost})`;
      const can = this.game.economy.canAfford(cost);
      this.expandBtn.disabled = !can;
      this.expandBtn.style.opacity = can ? "1" : "0.5";
      this.expandBtn.style.display = "block";
      // Breathe only when the upgrade is actually affordable.
      this.expandBtn.classList.toggle("cb-xw-pulse", can);
    } else {
      this.unlocksLine.textContent = "✓ Every recipe unlocked";
      this.expandBtn.style.display = "none";
      this.expandBtn.classList.remove("cb-xw-pulse");
    }

    if (this.game.isBoostActive()) {
      this.boostBtn.textContent = `📣 BOOST — ${Math.ceil(this.game.getBoostRemaining())}s left`;
      this.boostBtn.disabled = true;
      this.boostBtn.style.opacity = "0.7";
      this.boostBtn.classList.remove("cb-xw-pulse");
    } else {
      const cooldown = this.game.getBoostCooldownRemaining();
      if (cooldown > 0) {
        // mm:ss format so a 15-minute wait reads cleanly at any
        // remaining value (00:42 is more legible than "42s" right
        // before it lapses, and "14:59" beats "899s").
        this.boostBtn.textContent = `📣 Cooldown ${formatMmSs(cooldown)}`;
        this.boostBtn.disabled = true;
        this.boostBtn.style.opacity = "0.5";
        this.boostBtn.classList.remove("cb-xw-pulse");
      } else {
        const c = this.game.getBoostCost();
        const d = this.game.getBoostDurationSeconds();
        this.boostBtn.textContent = `📣 Boost guests ${d}s — $${c}`;
        const can = this.game.economy.canAfford(c);
        this.boostBtn.disabled = !can;
        this.boostBtn.style.opacity = can ? "1" : "0.5";
        this.boostBtn.classList.toggle("cb-xw-pulse", can);
      }
    }

    // Starter grant — ALWAYS visible so the player knows it exists.
    // Enabled only when broke + not yet claimed today; otherwise
    // the label explains which condition fails so they know what
    // to wait for.
    const broke = this.game.economy.getMoney() < STARTER_GRANT_THRESHOLD;
    const claimed = this.hasClaimedGrantToday();
    if (broke && !claimed) {
      this.grantBtn.textContent = `💸 Starter grant — +$${STARTER_GRANT_AMOUNT}`;
      this.grantBtn.disabled = false;
      this.grantBtn.style.opacity = "1";
      this.grantBtn.title = "Free starter grant — one per GAME day, only while broke.";
      this.grantBtn.classList.add("cb-xw-pulse");
    } else if (claimed) {
      this.grantBtn.textContent = `💸 Starter grant — claimed this day`;
      this.grantBtn.disabled = true;
      this.grantBtn.style.opacity = "0.5";
      this.grantBtn.title = "Already claimed this game day — available again next day.";
      this.grantBtn.classList.remove("cb-xw-pulse");
    } else {
      // Not broke. Show the threshold so the player knows the rule.
      this.grantBtn.textContent = `💸 Starter grant — need < $${STARTER_GRANT_THRESHOLD}`;
      this.grantBtn.disabled = true;
      this.grantBtn.style.opacity = "0.5";
      this.grantBtn.title = `Free grant kicks in when your balance drops below $${STARTER_GRANT_THRESHOLD}. Once per game day.`;
      this.grantBtn.classList.remove("cb-xw-pulse");
    }

    // Supply crate — server-timed 3h cooldown (read from the synced restaurant
    // row). Ready → claimable + pulsing; otherwise a live countdown.
    const crateSecs = this.cloud.getCrateReadyInSeconds();
    if (crateSecs <= 0) {
      this.crateBtn.textContent = "🎁 Supply crate — ready!";
      this.crateBtn.disabled = false;
      this.crateBtn.style.opacity = "1";
      this.crateBtn.title = "Free every 3h — open for a RANDOM gift: pantry, cash, decor, or a rare Time Warp (25% off an upgrade). Lesser gifts common, big ones rare.";
      this.crateBtn.classList.add("cb-xw-pulse");
    } else {
      const s = Math.ceil(crateSecs);
      const label = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : formatMmSs(s);
      this.crateBtn.textContent = `🎁 Supply crate — ${label}`;
      this.crateBtn.disabled = true;
      this.crateBtn.style.opacity = "0.5";
      this.crateBtn.title = "A random gift every 3 hours — lesser gifts common, big ones (cash, Time Warp) rare.";
      this.crateBtn.classList.remove("cb-xw-pulse");
    }
  }
}

/** mm:ss formatter shared with the boost button. Floor seconds (not
 * ceil) so the counter visibly hits 00:00 the moment the cooldown
 * actually ends instead of rendering 00:01 for one extra frame. */
function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
