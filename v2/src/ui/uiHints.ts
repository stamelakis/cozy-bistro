/**
 * Small shared UI helpers for gentle, non-blocking guidance:
 *  - flashHighlight: pulse a ring around an element and scroll it into view.
 *  - showPlacementHint: a discreet "place this on a counter/wall/…" toast with
 *    a "don't show this again" checkbox, remembered per placement type.
 *
 * Both are dependency-free and safe to call repeatedly.
 */

/** Pulse a golden ring around an element to draw the eye, and bring it into
 * view. Used when the game jumps the player somewhere (e.g. "you need a blender"
 * → open Build → here it is). Non-destructive: it animates box-shadow only. */
export function flashHighlight(el: HTMLElement | null | undefined, pulses = 3): void {
  if (!el) return;
  try { el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }); } catch { /* older engines */ }
  // A soft expanding ring, repeated a few times. box-shadow interpolates
  // cleanly (unlike the `outline` shorthand) so the pulse looks smooth.
  el.animate(
    [
      { boxShadow: "0 0 0 0 rgba(255,217,134,0.9)" },
      { boxShadow: "0 0 0 7px rgba(255,217,134,0)" },
    ],
    { duration: 850, iterations: Math.max(1, pulses), easing: "ease-out" },
  );
}

// ── Placement hint toast ─────────────────────────────────────────────

/** Short, friendly "where does this go" line per placement type. "tile"
 * (ordinary floor furniture) needs no hint — that's the obvious default. */
const PLACEMENT_HINTS: Record<string, string> = {
  surface: "Place this on top of a counter or table.",
  wall: "Mount this on a wall.",
  "wall-shelf": "Mount this up high on a wall.",
  ceiling: "Aim at the floor — it hangs from the ceiling above that spot.",
  edge: "Drop this on the line between two tiles.",
};

function dismissKey(placement: string): string { return `cb-placehint-off:${placement}`; }

let toastEl: HTMLElement | null = null;
let hideTimer: number | null = null;

/**
 * Show a discreet hint about how a just-selected item must be placed. No-op for
 * ordinary floor items, and no-op if the player ticked "don't show again" for
 * this placement type. Auto-hides after a few seconds.
 */
export function showPlacementHint(placement: string | undefined | null): void {
  const key = placement ?? "tile";
  const msg = PLACEMENT_HINTS[key];
  if (!msg) return;
  try { if (localStorage.getItem(dismissKey(key))) return; } catch { /* private mode */ }

  if (!toastEl) toastEl = buildToast();
  const label = toastEl.querySelector<HTMLElement>("[data-hint-msg]");
  const check = toastEl.querySelector<HTMLInputElement>("input[type=checkbox]");
  if (label) label.textContent = msg;
  if (check) {
    check.checked = false;
    check.onchange = () => {
      if (check.checked) { try { localStorage.setItem(dismissKey(key), "1"); } catch { /* ignore */ } }
      else { try { localStorage.removeItem(dismissKey(key)); } catch { /* ignore */ } }
    };
  }

  toastEl.style.display = "flex";
  // restart the fade-in each time
  toastEl.style.opacity = "0";
  requestAnimationFrame(() => { if (toastEl) toastEl.style.opacity = "1"; });

  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hidePlacementHint, 5200);
}

export function hidePlacementHint(): void {
  if (!toastEl) return;
  toastEl.style.opacity = "0";
  window.setTimeout(() => { if (toastEl) toastEl.style.display = "none"; }, 220);
  if (hideTimer != null) { window.clearTimeout(hideTimer); hideTimer = null; }
}

function buildToast(): HTMLElement {
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed", top: "74px", left: "50%", transform: "translateX(-50%)",
    zIndex: "2500", display: "none", alignItems: "center", gap: "12px",
    maxWidth: "min(440px, calc(100vw - 32px))", boxSizing: "border-box",
    padding: "9px 14px", borderRadius: "10px",
    background: "rgba(20,14,8,0.9)", border: "1px solid rgba(255,217,134,0.4)",
    color: "#fff5dc", font: "13px/1.4 system-ui, sans-serif",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    transition: "opacity 200ms ease", opacity: "0",
    // The toast sits up top, out of the placement zone; keep it click-through
    // EXCEPT the checkbox, which re-enables pointer events on itself.
    pointerEvents: "none",
  } as Partial<CSSStyleDeclaration>);

  const icon = document.createElement("span");
  icon.textContent = "💡";
  icon.style.flex = "0 0 auto";
  root.appendChild(icon);

  const msg = document.createElement("span");
  msg.dataset.hintMsg = "1";
  msg.style.flex = "1";
  root.appendChild(msg);

  const dismiss = document.createElement("label");
  Object.assign(dismiss.style, {
    flex: "0 0 auto", display: "flex", alignItems: "center", gap: "5px",
    fontSize: "11px", opacity: "0.72", cursor: "pointer", pointerEvents: "auto",
    whiteSpace: "nowrap",
  } as Partial<CSSStyleDeclaration>);
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.style.cursor = "pointer";
  const cbText = document.createElement("span");
  cbText.textContent = "Don't show again";
  dismiss.append(cb, cbText);
  root.appendChild(dismiss);

  document.body.appendChild(root);
  return root;
}

// ── Event banner ─────────────────────────────────────────────────────
// A prominent, transient centre-top banner for one-off "something's
// happening" moments (Rush hour, a VIP arriving). Bolder than the
// placement hint, no checkbox, click-through, auto-hides.

let eventBannerEl: HTMLElement | null = null;
let eventBannerTimer: number | null = null;

export function showEventBanner(msg: string, opts?: { icon?: string; accent?: string; ms?: number }): void {
  const icon = opts?.icon ?? "🎉";
  const accent = opts?.accent ?? "#ffd966";
  const ms = opts?.ms ?? 4200;
  if (!eventBannerEl) eventBannerEl = buildEventBanner();
  const iconEl = eventBannerEl.querySelector<HTMLElement>("[data-ev-icon]");
  const msgEl = eventBannerEl.querySelector<HTMLElement>("[data-ev-msg]");
  if (iconEl) iconEl.textContent = icon;
  if (msgEl) { msgEl.textContent = msg; msgEl.style.color = accent; }
  eventBannerEl.style.borderColor = accent;
  eventBannerEl.style.display = "flex";
  eventBannerEl.style.opacity = "0";
  eventBannerEl.style.transform = "translateX(-50%) translateY(-8px)";
  requestAnimationFrame(() => {
    if (!eventBannerEl) return;
    eventBannerEl.style.opacity = "1";
    eventBannerEl.style.transform = "translateX(-50%) translateY(0)";
  });
  if (eventBannerTimer != null) window.clearTimeout(eventBannerTimer);
  eventBannerTimer = window.setTimeout(() => {
    if (!eventBannerEl) return;
    eventBannerEl.style.opacity = "0";
    window.setTimeout(() => { if (eventBannerEl) eventBannerEl.style.display = "none"; }, 260);
  }, ms);
}

function buildEventBanner(): HTMLElement {
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed", top: "120px", left: "50%", transform: "translateX(-50%)",
    zIndex: "2600", display: "none", alignItems: "center", gap: "10px",
    maxWidth: "min(520px, calc(100vw - 32px))", boxSizing: "border-box",
    padding: "10px 20px", borderRadius: "12px",
    background: "rgba(20,14,8,0.92)", border: "2px solid #ffd966",
    color: "#fff5dc", font: "700 16px/1.3 system-ui, sans-serif",
    boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
    transition: "opacity 220ms ease, transform 220ms ease", opacity: "0",
    pointerEvents: "none", whiteSpace: "nowrap",
  } as Partial<CSSStyleDeclaration>);
  const icon = document.createElement("span");
  icon.dataset.evIcon = "1";
  icon.style.fontSize = "22px";
  root.appendChild(icon);
  const msg = document.createElement("span");
  msg.dataset.evMsg = "1";
  root.appendChild(msg);
  document.body.appendChild(root);
  return root;
}
