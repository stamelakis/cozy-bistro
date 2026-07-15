/**
 * Shared 1-second hover tooltip helper.
 *
 * Native HTML `title` attributes show too quickly + slowly depending on
 * OS/browser and look like system chrome — out of place next to the
 * brown-cream restaurant UI. attachTooltip swaps that out for a single
 * shared overlay div that fades in after a configurable delay (default
 * 1 s) and matches the rest of the panel styling.
 *
 * Usage:
 *   attachTooltip(buttonEl, "Open the build menu — place tables…");
 *   attachTooltip(buttonEl, "Multi-line\ntext supported\nfor richer hints");
 *
 * The overlay is created lazily on first use, mounted to document.body,
 * and reused for every subsequent target — so a thousand calls cost one
 * DOM node total.
 *
 * Positioning: tries to sit just below the target, flips above if that
 * overflows the viewport, and clamps horizontally so it never spills
 * off the left/right edges. Pointer-events are disabled so the tooltip
 * never eats clicks meant for the underlying element.
 */

let tip: HTMLDivElement | null = null;

function ensureTip(): HTMLDivElement {
  if (tip) return tip;
  tip = document.createElement("div");
  Object.assign(tip.style, {
    position: "fixed",
    zIndex: "10000",
    maxWidth: "260px",
    padding: "6px 8px",
    background: "rgba(20, 14, 10, 0.92)",
    color: "#fff5dc",
    font: "11px/1.4 system-ui, sans-serif",
    border: "1px solid rgba(255, 245, 220, 0.22)",
    borderRadius: "5px",
    boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
    pointerEvents: "none",
    whiteSpace: "pre-line",
    opacity: "0",
    transition: "opacity 0.12s ease",
    display: "none",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(tip);
  return tip;
}

function showTip(text: string, anchor: HTMLElement): void {
  const t = ensureTip();
  t.textContent = text;
  t.style.display = "block";
  // First place at (0,0) so getBoundingClientRect returns real dims.
  t.style.left = "0px";
  t.style.top  = "0px";
  const rect = anchor.getBoundingClientRect();
  const tipRect = t.getBoundingClientRect();
  // Try below the anchor; flip above if it would overflow.
  let top = rect.bottom + 6;
  if (top + tipRect.height > window.innerHeight - 4) {
    top = rect.top - tipRect.height - 6;
  }
  // Centre horizontally on the anchor, clamp to viewport with a small
  // gutter so the tooltip never visually clips the screen edges.
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  const gutter = 6;
  left = Math.max(gutter, Math.min(window.innerWidth - tipRect.width - gutter, left));
  t.style.left = `${Math.round(left)}px`;
  t.style.top  = `${Math.round(top)}px`;
  // Next frame: fade in. Two RAFs avoid the browser collapsing the
  // 0→1 opacity transition because we just toggled display:none→block.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (tip) tip.style.opacity = "1";
  }));
}

function hideTip(): void {
  if (!tip) return;
  tip.style.opacity = "0";
  // Defer display:none until the fade completes so the tooltip doesn't
  // snap-flicker on rapid mouseleave/enter.
  const t = tip;
  setTimeout(() => {
    // Guard: only hide if no other call snuck in and re-showed it.
    if (t.style.opacity === "0") t.style.display = "none";
  }, 140);
}

/**
 * Attach a 1 s delayed hover tooltip to `element`. The text is shown
 * verbatim — newlines (`\n`) render as line breaks because the shared
 * tooltip uses `white-space: pre-line`.
 *
 * Removes any existing native `title` attribute so the browser doesn't
 * stack its OS tooltip on top of ours.
 */
export function attachTooltip(element: HTMLElement, text: string, delayMs: number = 1000): void {
  // Strip native tooltip so the browser doesn't double-render with its
  // OS-styled bubble.
  element.removeAttribute("title");
  // Mirror the text into data-tip so the mobile long-press handler
  // (MobileUI.initLongPressTooltips) can surface it on touch devices — it
  // walks up from the touched element reading title / data-tip. Without this
  // an attachTooltip element (title stripped) would show nothing on a phone.
  element.dataset.tip = text;
  let timer: number | null = null;
  const clear = (): void => {
    if (timer !== null) { window.clearTimeout(timer); timer = null; }
  };
  element.addEventListener("mouseenter", () => {
    clear();
    timer = window.setTimeout(() => {
      timer = null;
      showTip(text, element);
    }, delayMs);
  });
  element.addEventListener("mouseleave", () => {
    clear();
    hideTip();
  });
  // Also dismiss on click — once the player interacts, the tooltip
  // becomes noise (they obviously know what the thing is).
  element.addEventListener("click", () => {
    clear();
    hideTip();
  });
}
