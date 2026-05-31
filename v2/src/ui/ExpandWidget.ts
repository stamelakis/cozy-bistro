import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier } from "../systems/CookingSystem";

/**
 * Compact tier + boost widget that sits attached below the HUD. Replaces
 * the modal-only access for these two important actions — they're worth
 * being one click away.
 *
 * Layout: title bar showing "Tier N/5", expand button, separator, boost
 * button. Tooltip on the unlocks preview.
 */
/** Persistent localStorage key for the "once per real day" starter
 * grant cooldown. Value is the YYYY-MM-DD calendar date on which
 * the player last claimed; the button is hidden until the calendar
 * date changes (player's local timezone). */
const GRANT_STORAGE_KEY = "cozy-bistro.last-starter-grant-day";

/** Amount of the hardship subsidy the starter-grant button hands out. */
const STARTER_GRANT_AMOUNT = 500;
/** Player has to be below this balance to see the grant button at
 * all — it's a safety net for "ran out of money" not a free top-up. */
const STARTER_GRANT_THRESHOLD = 500;

export class ExpandWidget {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly tierLabel: HTMLElement;
  private readonly expandBtn: HTMLButtonElement;
  private readonly boostBtn: HTMLButtonElement;
  private readonly grantBtn: HTMLButtonElement;
  private readonly unlocksLine: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    // Inline section — Sidebar handles the position/background/padding.
    this.root = document.createElement("div");
    parent.appendChild(this.root);

    this.tierLabel = document.createElement("div");
    Object.assign(this.tierLabel.style, {
      fontWeight: "700", fontSize: "12px", marginBottom: "4px",
      letterSpacing: "0.03em",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.tierLabel);

    this.unlocksLine = document.createElement("div");
    Object.assign(this.unlocksLine.style, {
      fontSize: "10px", opacity: "0.7", marginBottom: "6px",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.unlocksLine);

    this.expandBtn = document.createElement("button");
    Object.assign(this.expandBtn.style, {
      width: "100%", padding: "5px 8px", marginBottom: "5px",
      background: "rgba(120, 200, 120, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.3)",
      borderRadius: "4px", cursor: "pointer", font: "inherit",
      fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    this.expandBtn.onclick = () => { if (this.game.buyExpansion()) this.update(); };
    this.root.appendChild(this.expandBtn);

    this.boostBtn = document.createElement("button");
    Object.assign(this.boostBtn.style, {
      width: "100%", padding: "5px 8px",
      background: "rgba(200, 120, 200, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.3)",
      borderRadius: "4px", cursor: "pointer", font: "inherit",
      fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    this.boostBtn.onclick = () => { if (this.game.buyBoost()) this.update(); };
    this.root.appendChild(this.boostBtn);

    // Hardship subsidy — visible only when balance < $500 AND not
    // yet claimed today. Calendar-day cooldown is stored in
    // localStorage so it survives reloads without needing server
    // state. (Server-side would prevent cheating via clearing
    // localStorage, but for v1 the local check is fine — the
    // amount is tiny relative to mid-game economy.)
    this.grantBtn = document.createElement("button");
    Object.assign(this.grantBtn.style, {
      width: "100%", padding: "5px 8px", marginTop: "5px",
      background: "rgba(120, 140, 200, 0.22)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.3)",
      borderRadius: "4px", cursor: "pointer", font: "inherit",
      fontSize: "11px", fontWeight: "600",
      display: "none",
    } as Partial<CSSStyleDeclaration>);
    this.grantBtn.textContent = `💸 Starter grant — +$${STARTER_GRANT_AMOUNT}`;
    this.grantBtn.title = "If you're broke (under $500), one free starter grant per real day.";
    this.grantBtn.onclick = () => {
      // Re-verify both conditions on click (UI might be stale).
      if (this.game.economy.getMoney() >= STARTER_GRANT_THRESHOLD) return;
      if (this.hasClaimedGrantToday()) return;
      this.game.economy.earnMoney(STARTER_GRANT_AMOUNT, "grant");
      try { localStorage.setItem(GRANT_STORAGE_KEY, todayLocalDateString()); } catch { /* ignore */ }
      this.update();
    };
    this.root.appendChild(this.grantBtn);

    this.update();
  }

  /** True iff the player already claimed today's starter grant. */
  private hasClaimedGrantToday(): boolean {
    try {
      const last = localStorage.getItem(GRANT_STORAGE_KEY);
      return last === todayLocalDateString();
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
    } else {
      this.unlocksLine.textContent = "✓ Every recipe unlocked";
      this.expandBtn.style.display = "none";
    }

    if (this.game.isBoostActive()) {
      this.boostBtn.textContent = `📣 BOOST — ${Math.ceil(this.game.getBoostRemaining())}s left`;
      this.boostBtn.disabled = true;
      this.boostBtn.style.opacity = "0.7";
    } else {
      const cooldown = this.game.getBoostCooldownRemaining();
      if (cooldown > 0) {
        // mm:ss format so a 15-minute wait reads cleanly at any
        // remaining value (00:42 is more legible than "42s" right
        // before it lapses, and "14:59" beats "899s").
        this.boostBtn.textContent = `📣 Cooldown ${formatMmSs(cooldown)}`;
        this.boostBtn.disabled = true;
        this.boostBtn.style.opacity = "0.5";
      } else {
        const c = this.game.getBoostCost();
        const d = this.game.getBoostDurationSeconds();
        this.boostBtn.textContent = `📣 Boost guests ${d}s — $${c}`;
        const can = this.game.economy.canAfford(c);
        this.boostBtn.disabled = !can;
        this.boostBtn.style.opacity = can ? "1" : "0.5";
      }
    }

    // Starter grant visibility — broke + not yet claimed today.
    const broke = this.game.economy.getMoney() < STARTER_GRANT_THRESHOLD;
    const claimed = this.hasClaimedGrantToday();
    this.grantBtn.style.display = (broke && !claimed) ? "block" : "none";
  }
}

/** Today's date in the player's local timezone as YYYY-MM-DD.
 * Used as the storage value for the once-per-day grant cooldown. */
function todayLocalDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${dd}`;
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
