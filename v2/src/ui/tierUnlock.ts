import type { Game } from "../game/Game";

/**
 * Shared tier-unlock gate — the pay-to-expand card shown when the player clicks
 * a 🔒 tier lock ANYWHERE in the UI (build-menu tabs, recipe menu, décor,
 * pantry dishware, staff roles, floors). Lifted out of the UpgradeModal, which
 * already used this exact card, so every lock behaves the same instead of some
 * of them sending the player off to hunt for the Expand button.
 *
 *  - The NEXT tier up → one-tap "Pay $X" (same buyExpansion path as the Expand
 *    button), or a disabled "Need $X" when the player can't afford it.
 *  - Any tier beyond that → explains you must unlock the one before it first
 *    (expansions go one tier at a time).
 *
 * `onUnlocked` fires after a successful purchase so the caller can re-render.
 */
export function showTierGate(game: Game, targetTier: number, onUnlocked?: () => void): void {
  const cur = game.getLuxuryTier();
  if (targetTier <= cur) return;              // already unlocked
  if (cur >= game.getMaxLuxuryTier()) return; // nothing above

  let title: string;
  let message: string;
  let pay: { label: string; disabled: boolean; action: () => void } | null = null;
  if (targetTier === cur + 1) {
    const cost = game.getExpansionCost();
    const can = game.economy.canAfford(cost);
    title = `Unlock Tier ${targetTier}?`;
    message = `Expand your restaurant to Tier ${targetTier} for $${cost.toLocaleString()} — it opens the next wave of higher-tier furniture, recipes, décor and staff.`;
    pay = {
      label: can ? `Pay $${cost.toLocaleString()}` : `Need $${cost.toLocaleString()}`,
      disabled: !can,
      action: () => { if (game.buyExpansion()) onUnlocked?.(); },
    };
  } else {
    title = `Tier ${targetTier} is locked`;
    message = `Unlock Tier ${cur + 1} first — tiers unlock one at a time.`;
  }

  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", display: "flex",
    alignItems: "center", justifyContent: "center",
    // Non-zero RGB so MobileUI's black-backdrop modal tagger skips this small
    // transient card (it isn't a scrollable modal).
    background: "rgba(8,5,3,0.5)", zIndex: "4000", padding: "20px",
  } as Partial<CSSStyleDeclaration>);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const card = document.createElement("div");
  Object.assign(card.style, {
    boxSizing: "border-box", width: "100%", maxWidth: "320px",
    background: "rgba(34,24,16,0.98)", color: "#fff5dc",
    border: "1px solid #d8b98f", borderRadius: "12px",
    padding: "20px 20px 16px", textAlign: "center",
    font: "13px/1.5 system-ui, sans-serif",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
  } as Partial<CSSStyleDeclaration>);

  const h = document.createElement("div");
  Object.assign(h.style, { fontSize: "16px", fontWeight: "700", marginBottom: "8px" } as Partial<CSSStyleDeclaration>);
  h.textContent = title;
  const p = document.createElement("div");
  Object.assign(p.style, { opacity: "0.9", marginBottom: "16px" } as Partial<CSSStyleDeclaration>);
  p.textContent = message;
  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", gap: "8px" } as Partial<CSSStyleDeclaration>);

  const mkBtn = (label: string, primary: boolean, disabled: boolean, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      flex: "1", minHeight: "46px", padding: "10px 14px", borderRadius: "8px",
      fontWeight: "700", fontSize: "13px", cursor: disabled ? "default" : "pointer",
      border: primary ? "none" : "1px solid rgba(255,245,220,0.28)",
      background: primary ? (disabled ? "rgba(120,180,120,0.28)" : "rgba(120,200,120,0.92)") : "transparent",
      color: primary ? (disabled ? "rgba(255,245,220,0.5)" : "#17240f") : "#fff5dc",
    } as Partial<CSSStyleDeclaration>);
    b.disabled = disabled;
    if (!disabled) b.onclick = onClick;
    return b;
  };

  if (pay) {
    const payInfo = pay;
    row.appendChild(mkBtn(payInfo.label, true, payInfo.disabled, () => { payInfo.action(); overlay.remove(); }));
    row.appendChild(mkBtn("Not now", false, false, () => overlay.remove()));
  } else {
    row.appendChild(mkBtn("Got it", false, false, () => overlay.remove()));
  }
  card.append(h, p, row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}
