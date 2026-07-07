/**
 * MobileUI — a self-contained responsive layer for phones / tablets.
 *
 * The game UI is ~30 hand-rolled DOM panels styled with inline
 * `Object.assign(el.style, …)` desktop values (no framework, no shared
 * stylesheet). Two of them — the Sidebar (256px, left) and BuildMenu
 * (260px, right) — are *always on*, so on a ~380px phone they bury the
 * canvas. Rather than rewrite every panel, this module bolts on a mobile
 * layer that leaves desktop 100% untouched:
 *
 *   1. Injects ONE <style> whose rules are all prefixed `body.cb-mobile`
 *      and marked !important, so they override the inline desktop styles
 *      ONLY while that class is on <body>.
 *   2. Toggles `body.cb-mobile` from a matchMedia predicate (coarse
 *      pointer OR narrow viewport), re-evaluated on resize / orientation.
 *   3. Builds a bottom action bar that turns the two side panels and the
 *      recipe MenuPanel into slide-in sheets — a shared dimmed backdrop,
 *      one-open-at-a-time, plus a "View" toggle that hides all chrome for
 *      an unobstructed look at the restaurant.
 *   4. Tags every full-screen modal overlay (they all share one inline
 *      signature) via a MutationObserver, so the stylesheet can blow them
 *      up to full-screen sheets — no need to edit each of the 9 modals.
 *
 * Panels opt in only by adding a stable class to their root
 * (cb-sidebar / cb-buildmenu / cb-menupanel / cb-floorsel /
 * cb-cameracontrols / cb-chat / cb-roster). Everything else here finds
 * its targets by class, so construction order doesn't matter.
 */

const STYLE_ID = "cb-mobile-style";
const MOBILE_CLASS = "cb-mobile";

/** bar key → panel selector for the three slide-in sheets. */
const SHEETS = {
  build: ".cb-buildmenu",
  recipes: ".cb-menupanel",
  manage: ".cb-sidebar",
} as const;
type SheetKey = keyof typeof SHEETS;

let initialized = false;
let backdrop: HTMLElement | null = null;
let bar: HTMLElement | null = null;

/** Call once at boot (after the Engine has built its UI). Idempotent. */
export function initMobileUI(): void {
  if (initialized) return;
  initialized = true;
  injectStyles();
  buildChrome();
  watchModals();
  applyMode();
  window.addEventListener("resize", applyMode, { passive: true });
  window.addEventListener("orientationchange", applyMode, { passive: true });
}

/** Mark gameplay as reached so the bottom bar / camera chrome appear only
 * after the login + plot-pick gates clear (Engine calls this). */
export function setMobileInGame(inGame: boolean): void {
  document.body.classList.toggle("cb-ingame", inGame);
}

/** Close any open slide-in sheet. Called when furniture placement starts
 * so the player can actually see the floor they're placing on. No-op on
 * desktop (nothing is ever in the open state there). */
export function closeMobileSheets(): void {
  closeAllSheets();
}

// ── mode toggle ──────────────────────────────────────────────────────

function isMobile(): boolean {
  // A touch device of any size, OR a narrow window on desktop. A wide
  // mouse-driven desktop stays on the untouched desktop layout.
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  return coarse || window.innerWidth <= 820;
}

function applyMode(): void {
  const on = isMobile();
  document.body.classList.toggle(MOBILE_CLASS, on);
  if (!on) {
    // Leaving mobile (e.g. rotated a tablet wide / resized the window):
    // don't strand a half-open sheet over the desktop layout.
    closeAllSheets();
    document.body.classList.remove("cb-hideui");
  }
}

// ── slide-in sheets ──────────────────────────────────────────────────

function sheetEl(key: SheetKey): HTMLElement | null {
  return document.querySelector<HTMLElement>(SHEETS[key]);
}

function closeAllSheets(): void {
  (Object.keys(SHEETS) as SheetKey[]).forEach((k) =>
    sheetEl(k)?.classList.remove("cb-open"),
  );
  backdrop?.classList.remove("cb-show");
  syncBarActive(null);
}

function toggleSheet(key: SheetKey): void {
  const el = sheetEl(key);
  if (!el) return;
  const willOpen = !el.classList.contains("cb-open");
  closeAllSheets();
  if (willOpen) {
    el.classList.add("cb-open");
    backdrop?.classList.add("cb-show");
    syncBarActive(key);
    ensureExpanded(el);
  }
}

/** The Build / Recipes panels carry a desktop "click to collapse" title.
 * When they open as a mobile sheet we want their content visible, not a
 * lone title bar — so if the title still reads "expand", click it once to
 * expand. Driving the panel's own handler keeps its state consistent. */
function ensureExpanded(panel: HTMLElement): void {
  const title = panel.firstElementChild;
  if (title instanceof HTMLElement && /expand/i.test(title.textContent ?? "")) {
    title.click();
  }
}

function syncBarActive(active: SheetKey | null): void {
  bar?.querySelectorAll<HTMLElement>(".cb-bb-btn").forEach((b) => {
    b.classList.toggle("cb-active", b.dataset.key === active);
  });
}

function toggleHideUI(): void {
  const hidden = document.body.classList.toggle("cb-hideui");
  if (hidden) closeAllSheets();
}

// ── chrome (bottom bar + backdrop + restore button) ──────────────────

function buildChrome(): void {
  backdrop = document.createElement("div");
  backdrop.className = "cb-backdrop";
  backdrop.addEventListener("click", closeAllSheets);
  document.body.appendChild(backdrop);

  bar = document.createElement("div");
  bar.className = "cb-bottombar";
  const buttons: Array<{ key: SheetKey | "hide"; icon: string; label: string }> = [
    { key: "build", icon: "🏗", label: "Build" },
    { key: "recipes", icon: "🍽", label: "Recipes" },
    { key: "manage", icon: "📋", label: "Manage" },
    { key: "hide", icon: "👁", label: "View" },
  ];
  for (const { key, icon, label } of buttons) {
    const b = document.createElement("button");
    b.className = "cb-bb-btn";
    b.dataset.key = key;
    b.innerHTML =
      `<span class="cb-bb-ic">${icon}</span><span class="cb-bb-lb">${label}</span>`;
    b.addEventListener("click", () => {
      if (key === "hide") toggleHideUI();
      else toggleSheet(key);
    });
    bar.appendChild(b);
  }
  document.body.appendChild(bar);

  const restore = document.createElement("button");
  restore.className = "cb-restore";
  restore.textContent = "⛶";
  restore.title = "Show controls";
  restore.addEventListener("click", toggleHideUI);
  document.body.appendChild(restore);
}

// ── modal auto-tagging ───────────────────────────────────────────────

/** Every centred modal overlay shares the same inline signature
 * (fixed + full-viewport + the 45%-black backdrop). Tag them — and their
 * inner box — so the stylesheet can full-screen them on mobile. */
function maybeTagModal(el: HTMLElement): void {
  if (!(el instanceof HTMLElement) || el.classList.contains("cb-modal-overlay")) {
    return;
  }
  const s = el.style;
  if (s.position !== "fixed") return;
  const fullW = s.width === "100vw" || s.inset === "0px" || s.width === "100%";
  const backdropLike = s.background.includes("rgba(0, 0, 0, 0.45)");
  if (!fullW || !backdropLike) return;
  el.classList.add("cb-modal-overlay");
  const box = el.firstElementChild;
  if (box instanceof HTMLElement) box.classList.add("cb-modal-body");
}

function watchModals(): void {
  const app = document.getElementById("app") ?? document.body;
  // Modals are appended as direct children of the app container, so a
  // depth-1 childList observer is enough (and avoids reacting to the
  // per-frame status-bubble churn deeper in the tree).
  for (const child of Array.from(app.children)) {
    if (child instanceof HTMLElement) maybeTagModal(child);
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n instanceof HTMLElement) maybeTagModal(n);
      });
    }
  }).observe(app, { childList: true });
}

// ── the stylesheet ───────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Heights reused below: bottom bar ≈ 60px, plus the device safe area. */
const CSS = `
/* ============================================================
   Cozy Bistro — mobile layer. Every rule is gated on
   body.cb-mobile so the desktop layout is byte-for-byte
   unchanged. !important is required to beat the inline styles
   the panels set on themselves.
   ============================================================ */

body.cb-mobile { -webkit-user-select: none; user-select: none; }

/* --- the two always-on side panels + recipe panel become sheets --- */
body.cb-mobile .cb-sidebar,
body.cb-mobile .cb-buildmenu,
body.cb-mobile .cb-menupanel {
  z-index: 900 !important;
  transition: transform 240ms cubic-bezier(.22,.61,.36,1) !important;
  will-change: transform;
}

/* Manage (Sidebar) → left sheet, sitting above the bottom bar */
body.cb-mobile .cb-sidebar {
  top: env(safe-area-inset-top, 0px) !important;
  left: 0 !important;
  bottom: calc(60px + env(safe-area-inset-bottom, 0px)) !important;
  width: min(88vw, 380px) !important;
  height: auto !important;
  border-radius: 0 16px 16px 0 !important;
  transform: translateX(-104%) !important;
  font-size: 14px !important;
}
body.cb-mobile .cb-sidebar.cb-open { transform: translateX(0) !important; }

/* Build (BuildMenu) → right sheet */
body.cb-mobile .cb-buildmenu {
  top: env(safe-area-inset-top, 0px) !important;
  right: 0 !important;
  left: auto !important;
  bottom: calc(60px + env(safe-area-inset-bottom, 0px)) !important;
  width: min(88vw, 380px) !important;
  max-height: none !important;
  height: auto !important;
  border-radius: 16px 0 0 16px !important;
  transform: translateX(104%) !important;
  font-size: 13px !important;
}
body.cb-mobile .cb-buildmenu.cb-open { transform: translateX(0) !important; }

/* Recipes (MenuPanel) → bottom sheet */
body.cb-mobile .cb-menupanel {
  /* width:100% must INCLUDE the panel's 12px padding, else the sheet is
     24px wider than the viewport and its right edge clips off-screen. */
  box-sizing: border-box !important;
  left: 0 !important;
  right: 0 !important;
  bottom: calc(60px + env(safe-area-inset-bottom, 0px)) !important;
  top: auto !important;
  width: 100% !important;
  max-width: 100% !important;
  max-height: 64vh !important;
  overflow-y: auto !important;
  border-radius: 18px 18px 0 0 !important;
  /* Offset must clear the panel's own height PLUS the bottom bar — a
     collapsed MenuPanel is only ~30px tall, so a plain 120% left its
     title poking up behind the bar. The +140px guarantees it's gone. */
  transform: translateY(calc(100% + 140px)) !important;
}
body.cb-mobile .cb-menupanel.cb-open { transform: translateY(0) !important; }

/* dimmed backdrop behind an open sheet */
.cb-backdrop { display: none; }
body.cb-mobile .cb-backdrop {
  display: block;
  position: fixed;
  inset: 0;
  z-index: 850;
  background: rgba(0,0,0,0.5);
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
}
body.cb-mobile .cb-backdrop.cb-show { opacity: 1; pointer-events: auto; }

/* --- bottom action bar (only once in-game) --- */
.cb-bottombar { display: none; }
body.cb-mobile.cb-ingame .cb-bottombar {
  display: flex;
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 1000;
  gap: 4px;
  padding: 5px 6px calc(5px + env(safe-area-inset-bottom, 0px));
  background: rgba(18,12,8,0.94);
  border-top: 1px solid rgba(255,245,220,0.14);
  box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
}
body.cb-mobile .cb-bb-btn {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 52px;
  padding: 4px 2px;
  background: transparent;
  color: #fff5dc;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  font: 600 11px/1 system-ui, sans-serif;
}
body.cb-mobile .cb-bb-btn .cb-bb-ic { font-size: 22px; line-height: 1; }
body.cb-mobile .cb-bb-btn.cb-active { background: rgba(255,210,120,0.24); color: #fffff0; }
body.cb-mobile .cb-bb-btn:active { background: rgba(255,245,220,0.12); }

/* "View" (hide all chrome) — restore button floats while hidden */
.cb-restore { display: none; }
body.cb-mobile.cb-ingame.cb-hideui .cb-restore {
  display: flex;
  align-items: center;
  justify-content: center;
  position: fixed;
  right: calc(12px + env(safe-area-inset-right, 0px));
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  width: 48px; height: 48px;
  z-index: 1000;
  background: rgba(18,12,8,0.92);
  color: #fff5dc;
  border: 1px solid rgba(255,245,220,0.32);
  border-radius: 50%;
  font-size: 20px;
  cursor: pointer;
}
body.cb-mobile.cb-hideui .cb-bottombar,
body.cb-mobile.cb-hideui .cb-floorsel,
body.cb-mobile.cb-hideui .cb-cameracontrols,
body.cb-mobile.cb-hideui .cb-sidebar,
body.cb-mobile.cb-hideui .cb-buildmenu,
body.cb-mobile.cb-hideui .cb-menupanel,
body.cb-mobile.cb-hideui .cb-backdrop {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* --- floor selector: tuck under the notch, allow horizontal scroll --- */
body.cb-mobile .cb-floorsel {
  top: calc(6px + env(safe-area-inset-top, 0px)) !important;
  padding: 5px 7px !important;
  gap: 4px !important;
  max-width: calc(100vw - 16px) !important;
  overflow-x: auto !important;
  z-index: 700 !important;
}

/* --- camera controls: park bottom-right, above the bar --- */
body.cb-mobile .cb-cameracontrols {
  top: auto !important;
  left: auto !important;
  right: calc(8px + env(safe-area-inset-right, 0px)) !important;
  bottom: calc(70px + env(safe-area-inset-bottom, 0px)) !important;
  z-index: 700 !important;
}

/* --- secondary panels: declutter (reachable in a later pass) --- */
body.cb-mobile .cb-chat,
body.cb-mobile .cb-roster { display: none !important; }

/* --- modals → full-screen sheets --- */
body.cb-mobile .cb-modal-overlay {
  z-index: 1500 !important;
  background: rgba(10,7,4,0.55) !important;
  align-items: stretch !important;
  justify-content: stretch !important;
}
body.cb-mobile .cb-modal-body {
  width: 100% !important;
  max-width: 100% !important;
  height: 100% !important;
  max-height: 100% !important;
  border-radius: 0 !important;
  border: none !important;
  padding:
    calc(14px + env(safe-area-inset-top, 0px)) 14px
    calc(16px + env(safe-area-inset-bottom, 0px)) !important;
  font-size: 13px !important;
  overflow-y: auto !important;
  /* Wide data grids (Stats / Upgrades) scroll sideways instead of clip. */
  overflow-x: auto !important;
}
/* Enlarge the header close button (the trailing ✕) to a real tap target. */
body.cb-mobile .cb-modal-body > div:first-child > button:last-child {
  width: 40px !important;
  height: 40px !important;
  font-size: 18px !important;
  flex: 0 0 auto !important;
}

/* --- floating touch controls for placing / moving furniture (no keyboard):
   ⟳ rotate (left), ✓ place (right-inner), ✕ done (right-outer). Shown only on
   mobile, only while a build interaction is active. --- */
.cb-touch-btn { display: none; }
body.cb-mobile .cb-touch-btn.cb-show {
  display: flex;
  align-items: center;
  justify-content: center;
  position: fixed;
  bottom: calc(74px + env(safe-area-inset-bottom, 0px));
  width: 60px; height: 60px;
  z-index: 1100;
  color: #2a1c10;
  border-radius: 50%;
  font-size: 27px; font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,0.45);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
body.cb-mobile .cb-touch-rotate.cb-show {
  left: calc(14px + env(safe-area-inset-left, 0px));
  background: rgba(255,210,120,0.96);
  border: 1px solid rgba(255,235,190,0.85);
}
body.cb-mobile .cb-touch-confirm.cb-show {
  right: calc(84px + env(safe-area-inset-right, 0px));
  background: rgba(120,200,130,0.96);
  border: 1px solid rgba(190,240,200,0.85);
}
body.cb-mobile .cb-touch-cancel.cb-show {
  right: calc(14px + env(safe-area-inset-right, 0px));
  background: rgba(226,120,110,0.96);
  border: 1px solid rgba(245,190,185,0.85);
}
body.cb-mobile .cb-touch-btn.cb-show:active { filter: brightness(1.12); }
`;
