/**
 * Shared drag + resize helper for the Build / Menu / Chat panels.
 *
 * Usage:
 *   makeDraggableResizable({
 *     storageKey: "cozy-bistro.panel.build",
 *     root: this.root,
 *     handle: this.titleBar,
 *     minWidth: 220, minHeight: 60,
 *   });
 *
 * Effects:
 *   - Title bar gets a "move" cursor and starts a drag on pointerdown.
 *     Buttons inside the title bar (click targets like the collapse
 *     toggle) keep working — we bail out of the drag if the pointer
 *     target's closest ancestor is a <button>.
 *   - Drag converts the panel to top/left absolute positioning (drops
 *     any right/bottom/transform anchors) and constrains the panel
 *     inside the viewport.
 *   - Resize handles (8 directions) appear at the panel edges + corners.
 *     They use native pointer events; no CSS `resize:` (which requires
 *     overflow constraints that break our panels' internal scrolling).
 *   - Position + size persist to localStorage keyed on `storageKey`.
 *     Restored on every construction so layout survives reload.
 *
 * Idempotent — calling twice on the same root is a no-op (re-running
 * the constructor on hot-reload won't stack handles).
 */

export interface PanelDragResizeOptions {
  /** Unique localStorage key for this panel's saved layout. */
  storageKey: string;
  /** The root element to drag + resize. Must be `position: fixed`. */
  root: HTMLElement;
  /** The element the user clicks to start a drag (usually the title bar). */
  handle: HTMLElement;
  /** Minimum width in px. Default 180. */
  minWidth?: number;
  /** Minimum height in px. Default 60. */
  minHeight?: number;
  /** Optional callback fired after a drag / resize completes — useful
   * if the panel needs to recompute internal layout after a size change. */
  onChange?: () => void;
  /** Optional sentinel element. When its inline `display` style flips
   * to "none" / non-"none" the helper treats the panel as collapsed /
   * expanded — it then auto-adjusts the panel's height + position so:
   *   • collapsed → height clears (panel shrinks to title-bar height)
   *   • expanded  → saved height restored, position recomputed so the
   *     panel grows in the preferred direction (and falls back to the
   *     opposite direction if there isn't room).
   * Without this, panels with a fixed PanelDragResize height keep
   * that height when their internal "click to expand" toggle hides
   * the body — leaving a big empty box. */
  collapseSentinel?: HTMLElement;
  /** Which direction the panel prefers to grow when expanding.
   *   • "down" — top edge stays put, bottom edge moves down.
   *     Use for top-anchored panels (Build).
   *   • "up"   — bottom edge stays put, top edge moves up.
   *     Use for bottom-anchored panels (Menu, Chat).
   * If the preferred direction would push the panel off-screen,
   * setExpanded falls back to the other direction. Default "down". */
  expandDirection?: "up" | "down";
}

/** Marker attribute we set on a root we've already wired up — guards
 * against double-init on hot reload. */
const INIT_MARKER = "data-drag-resize-wired";

/** Padding from viewport edges when clamping drag / resize. */
const VIEWPORT_PADDING = 4;

/** One-time migration: wipe legacy v1 panel layouts left behind by
 * the P11/P11.5 bug where dragging a collapsed panel saved its
 * tiny ~32 px height as the "expanded" size, then later expansions
 * clipped the body content to that height. The v2 storage keys
 * use proper save-only-when-expanded logic. Runs at module load
 * before any panel attaches. */
(() => {
  try {
    for (const k of [
      "cozy-bistro.panel.build", "cozy-bistro.panel.menu", "cozy-bistro.panel.chat",
      // Abandoned VERSIONED keys — must be wiped too, else a bad saved value
      // (e.g. a pinned collapsed height) survives refreshes under its version.
      "cozy-bistro.panel.build.v2",
      "cozy-bistro.panel.menu.v2", "cozy-bistro.panel.menu.v3", "cozy-bistro.panel.menu.v4",
      "cozy-bistro.panel.chat.v2", "cozy-bistro.panel.chat.v3",
    ]) {
      localStorage.removeItem(k);
    }
  } catch { /* private mode / quota — fine to skip */ }
})();

export function makeDraggableResizable(opts: PanelDragResizeOptions): void {
  const { root, handle, storageKey, onChange } = opts;
  const minW = opts.minWidth ?? 180;
  const minH = opts.minHeight ?? 60;
  const expandDirection = opts.expandDirection ?? "down";
  if (root.getAttribute(INIT_MARKER) === "1") return;
  root.setAttribute(INIT_MARKER, "1");

  // Capture the panel's HOME anchor from its authored inline CSS (BEFORE the
  // restore below converts it to absolute left/top), so an un-dragged panel
  // can re-home to its edge/centre on viewport resize instead of stranding at
  // a fixed left when devtools / the window opens + closes.
  const homeRightPx = root.style.right.endsWith("px") ? parseFloat(root.style.right) : null;
  const homeCentered = root.style.left === "50%"
    || (root.style.transform || "").includes("translateX(-50%)");
  let userMoved = false;

  // === RESTORE saved layout (or convert current anchor to top/left) ===
  // Height is restored ONLY when collapseSentinel is absent OR the
  // panel is currently expanded. For panels with a collapse sentinel
  // we let the sentinel observer below apply the height the moment
  // we know whether the panel is in the expanded or collapsed state,
  // because applying a fixed height on top of a collapsed panel
  // leaves a giant empty box around the title bar (P11 bug).
  const saved = loadState(storageKey);
  let savedHeight: number | undefined = saved?.height;
  const sentinelStartsCollapsed = opts.collapseSentinel
    ? opts.collapseSentinel.style.display === "none"
    : false;
  if (saved) {
    const heightToApply = (opts.collapseSentinel && sentinelStartsCollapsed)
      ? undefined
      : saved.height;
    // For bottom-anchored panels (Menu, Chat) the SAVED BOTTOM is
    // the meaningful anchor. saved.top + saved.height records the
    // bottom edge at save time; if the panel reloads collapsed,
    // saved.height no longer applies and using saved.top alone
    // puts the title bar where the body used to be — mid-screen
    // instead of pinned to the bottom of the viewport. Translate
    // top so the bottom edge stays put. 32 px is the conservative
    // collapsed-content height; the post-mount anchor sweep below
    // re-caches the real bottom from the actual rect on the
    // first user move, so a small error here self-corrects.
    let topToApply = saved.top;
    if (opts.expandDirection === "up"
        && opts.collapseSentinel
        && sentinelStartsCollapsed) {
      const COLLAPSED_HEIGHT_GUESS = 32;
      topToApply = saved.top + saved.height - COLLAPSED_HEIGHT_GUESS;
    }
    applyLayout(root, saved.left, topToApply, saved.width, heightToApply);
  } else {
    // First-time wiring — capture whatever absolute position the panel
    // currently has (its CSS top/right/bottom/left + transform) and
    // freeze it as top/left so subsequent drags work from a known
    // starting point.
    const rect = root.getBoundingClientRect();
    applyLayout(root, rect.left, rect.top);
  }

  // Track current collapsed state — drives whether resize-save
  // records height and whether the resize handles are clickable.
  let isExpanded = !sentinelStartsCollapsed;

  /** Hook called from drag/resize end so the collapse-sentinel
   * branch can re-cache its anchored edge after an explicit
   * user move. Filled in by the collapseSentinel block below if
   * a sentinel was wired; no-op otherwise. */
  let refreshAnchorsAfterUserMove: () => void = () => { /* no sentinel — nothing to anchor */ };

  // === DRAG ===
  // Title bars often double as click-to-collapse buttons, so we
  // distinguish a tap from a drag: pointerdown only ARMS a possible
  // drag; we don't commit (don't capture, don't preventDefault) until
  // the pointer has moved past DRAG_THRESHOLD px. Below the threshold
  // the synthetic click is allowed to fire and the title's onclick
  // (collapse toggle) runs normally.
  handle.style.cursor = "move";
  handle.style.touchAction = "none";

  const DRAG_THRESHOLD = 4;
  let armed = false;
  let committed = false;
  let dragStartX = 0, dragStartY = 0;
  let panelStartX = 0, panelStartY = 0;
  let activePointerId = -1;
  let didDrag = false;

  // Suppress the synthetic click that fires after a drag-pointerup —
  // otherwise dragging the title bar would also fire the collapse
  // toggle. Wired with capture:true so we intercept before the
  // panel's own onclick.
  const suppressNextClick = (ev: MouseEvent): void => {
    ev.stopPropagation();
    ev.preventDefault();
    handle.removeEventListener("click", suppressNextClick, true);
  };

  const onDragDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // Let clicks inside form controls / nested buttons reach their
    // handlers without arming the drag.
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input, textarea, select, a")) return;
    armed = true;
    committed = false;
    didDrag = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = root.getBoundingClientRect();
    panelStartX = rect.left;
    panelStartY = rect.top;
    activePointerId = e.pointerId;
  };
  const onDragMove = (e: PointerEvent): void => {
    if (!armed || e.pointerId !== activePointerId) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (!committed) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      committed = true;
      didDrag = true;
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    const maxLeft = window.innerWidth - w - VIEWPORT_PADDING;
    const maxTop = window.innerHeight - h - VIEWPORT_PADDING;
    const left = clamp(panelStartX + dx, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, maxLeft));
    const top = clamp(panelStartY + dy, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, maxTop));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    e.preventDefault();
  };
  const onDragUp = (e: PointerEvent): void => {
    if (!armed || e.pointerId !== activePointerId) return;
    armed = false;
    activePointerId = -1;
    if (committed) {
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      userMoved = true; // user repositioned it — stop auto-homing on resize
      // Re-cache the anchored edge so the next expand/collapse
      // uses the dragged position as its baseline instead of the
      // pre-drag one.
      refreshAnchorsAfterUserMove();
      // Pass isExpanded so saveCurrentLayout preserves the
      // last-known EXPANDED height even when the user drags a
      // collapsed panel — otherwise the collapsed title-only
      // height (~32 px) gets stored as the "expanded" size and
      // the panel clips its body to 32 px the next time it opens.
      saveCurrentLayout(storageKey, root, isExpanded);
      onChange?.();
    }
    if (didDrag) {
      // Block the synthetic click that fires after a successful drag.
      handle.addEventListener("click", suppressNextClick, true);
    }
  };
  handle.addEventListener("pointerdown", onDragDown);
  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", onDragUp);
  handle.addEventListener("pointercancel", onDragUp);

  // === RESIZE HANDLES (8 directions) ===
  const directions: { id: ResizeDir; cursor: string; style: Partial<CSSStyleDeclaration> }[] = [
    { id: "n",  cursor: "ns-resize",   style: { top: "0", left: "8px", right: "8px", height: "6px" } },
    { id: "s",  cursor: "ns-resize",   style: { bottom: "0", left: "8px", right: "8px", height: "6px" } },
    { id: "w",  cursor: "ew-resize",   style: { left: "0", top: "8px", bottom: "8px", width: "6px" } },
    { id: "e",  cursor: "ew-resize",   style: { right: "0", top: "8px", bottom: "8px", width: "6px" } },
    { id: "nw", cursor: "nwse-resize", style: { top: "0", left: "0", width: "10px", height: "10px" } },
    { id: "ne", cursor: "nesw-resize", style: { top: "0", right: "0", width: "10px", height: "10px" } },
    { id: "sw", cursor: "nesw-resize", style: { bottom: "0", left: "0", width: "10px", height: "10px" } },
    { id: "se", cursor: "nwse-resize", style: { bottom: "0", right: "0", width: "10px", height: "10px" } },
  ];
  const resizeHandleEls: HTMLElement[] = [];
  for (const d of directions) {
    const h = document.createElement("div");
    Object.assign(h.style, {
      position: "absolute",
      cursor: d.cursor,
      zIndex: "10",
      touchAction: "none",
      // Tinted SE corner so the user knows resize is a thing.
      background: d.id === "se" ? "rgba(255, 245, 220, 0.18)" : "transparent",
      borderBottomRightRadius: d.id === "se" ? "4px" : undefined,
      ...d.style,
    } as Partial<CSSStyleDeclaration>);
    wireResize(h, d.id, root, minW, minH, storageKey, onChange, () => isExpanded, () => { userMoved = true; refreshAnchorsAfterUserMove(); });
    root.appendChild(h);
    resizeHandleEls.push(h);
  }
  // Resize handles sit AT the root's edges (top:0, bottom:0, etc.)
  // with width/height < 10 px, so they're inside the padding box
  // even when the root has overflow:hidden. No overflow patching
  // needed — and we explicitly DON'T flip overflow because panels
  // (notably ChatPanel) set overflow:hidden to clip rounded
  // corners + the title bar's lower border.

  // === COLLAPSE SENTINEL (height + reposition on expand/collapse) ===
  // Anchor tracking — the visible edge that should stay put across
  // expand/collapse. For "up" direction panels (chat / menu) we
  // anchor the BOTTOM; for "down" panels (build) we anchor the
  // TOP. The anchor is captured up front and updated only when
  // the user EXPLICITLY moves the panel (drag / resize / clamp).
  // We can't derive it from getBoundingClientRect() inside
  // applyForState because by then the body's display flip has
  // already changed the rect — that was the bug where chat /
  // menu wandered up on expand and stayed there on collapse.
  let anchoredTop: number = root.getBoundingClientRect().top;
  let anchoredBottom: number = root.getBoundingClientRect().bottom;
  /** Re-cache both anchors from the current rect. Called after any
   * USER-INITIATED reposition (drag end, resize end, viewport-clamp
   * during expand). NOT called from inside applyForState's height
   * flip — that's the whole point. */
  const updateAnchorsFromRect = (): void => {
    const r = root.getBoundingClientRect();
    anchoredTop = r.top;
    anchoredBottom = r.bottom;
  };
  if (opts.collapseSentinel) {
    const sentinel = opts.collapseSentinel;
    const applyForState = (nowExpanded: boolean): void => {
      if (nowExpanded) {
        // Refresh from localStorage on every expand — wireResize
        // persists the new height there, but the `savedHeight`
        // captured at init is stale once the user has resized
        // within the same session. Re-reading means
        // collapse → resize → expand restores the resized height
        // instead of bouncing back to the page-load value.
        const fresh = readState(storageKey);
        if (fresh) savedHeight = fresh.height;
        if (savedHeight !== undefined) {
          root.style.height = `${savedHeight}px`;
          root.style.maxHeight = "none";
          root.style.minHeight = "0";
        } else {
          root.style.height = "";
          root.style.maxHeight = "";
        }
      } else {
        // Collapsed — drop height; the panel's body is already
        // display:none so the root shrinks naturally to the
        // title-bar height.
        root.style.height = "";
        root.style.maxHeight = "";
      }
      // Position from the persisted anchor, NOT from the just-mutated
      // rect — see the comments on the anchor variables.
      const newHeight = root.offsetHeight;
      let newTop: number;
      if (expandDirection === "up") {
        newTop = anchoredBottom - newHeight;
      } else {
        newTop = anchoredTop;
      }
      // Clamp into viewport. If we had to clamp, re-anchor so a
      // subsequent collapse uses the clamped position as the new
      // baseline (otherwise the panel would jump back to the
      // off-screen position on collapse).
      let clamped = false;
      if (newTop + newHeight > window.innerHeight - VIEWPORT_PADDING) {
        newTop = window.innerHeight - VIEWPORT_PADDING - newHeight;
        clamped = true;
      }
      if (newTop < VIEWPORT_PADDING) {
        newTop = VIEWPORT_PADDING;
        clamped = true;
      }
      root.style.top = `${newTop}px`;
      if (clamped) {
        anchoredTop = newTop;
        anchoredBottom = newTop + newHeight;
      }
      for (const h of resizeHandleEls) {
        h.style.display = nowExpanded ? "" : "none";
      }
      isExpanded = nowExpanded;
      // Late-content guard for bottom-anchored ("up") panels: the body can
      // finish rendering a frame or two AFTER expand (e.g. MenuPanel's recipe
      // list populates lazily on open). We positioned by `top` from the height
      // measured just now, so once the body grows the bottom slides DOWN
      // off-screen — the "first expand opens off-screen, second is fine" bug.
      // Re-pin the top from the anchored bottom after the content settles so
      // the panel grows UP instead.
      if (nowExpanded && expandDirection === "up") {
        const repin = (): void => {
          if (!isExpanded) return;
          const h = root.offsetHeight;
          let t = anchoredBottom - h;
          if (t + h > window.innerHeight - VIEWPORT_PADDING) {
            t = window.innerHeight - VIEWPORT_PADDING - h;
          }
          if (t < VIEWPORT_PADDING) t = VIEWPORT_PADDING;
          root.style.top = `${t}px`;
        };
        requestAnimationFrame(repin);
        setTimeout(repin, 130);
      }
    };
    // Initial pass — apply CSS height/visibility to match the
    // sentinel's current state, then capture the resulting bottom
    // edge as the baseline anchor (so the very FIRST toggle uses
    // the right reference).
    applyForState(!sentinelStartsCollapsed);
    updateAnchorsFromRect();
    const observer = new MutationObserver(() => {
      const nowExpanded = sentinel.style.display !== "none";
      if (nowExpanded === isExpanded) return;
      applyForState(nowExpanded);
    });
    observer.observe(sentinel, { attributes: true, attributeFilter: ["style"] });
    // Persistent late-content guard for bottom-anchored ("up") panels. The
    // one-shot rAF/timeout repin in applyForState still misses content that
    // populates MORE than ~130 ms after expand — MenuPanel's recipe list
    // renders on a later data tick, so the body grew and slid off the bottom of
    // the screen ("first open is off-screen, second is fine" — the recurring
    // bug). A ResizeObserver re-pins the top from the anchored BOTTOM on ANY
    // size change while expanded, so the panel always grows UP and its body
    // stays on-screen no matter when the content settles. Skipped mid-drag
    // (`armed`) so it can't fight a title-bar reposition; writing `top` never
    // changes the element's size, so this can't feed back into a loop.
    if (expandDirection === "up" && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (!isExpanded || armed) return;
        const h = root.offsetHeight;
        let t = anchoredBottom - h;
        if (t + h > window.innerHeight - VIEWPORT_PADDING) t = window.innerHeight - VIEWPORT_PADDING - h;
        if (t < VIEWPORT_PADDING) t = VIEWPORT_PADDING;
        root.style.top = `${t}px`;
      });
      ro.observe(root);
    }
  }
  // Make the anchor updater available to the drag handler above so
  // explicit panel moves re-cache the anchored edge.
  refreshAnchorsAfterUserMove = updateAnchorsFromRect;

  // Ride the viewport on resize. A bottom-anchored ("up") panel gets converted
  // to absolute top/left for dragging, after which it no longer follows the
  // viewport bottom — so a viewport change (opening/closing devtools, resizing
  // the window) strands it at a fixed top px, off the bottom, and it then
  // EXPANDS in the wrong place. Shift it by the viewport-height delta so its
  // bottom edge keeps riding the viewport bottom, and re-cache the anchor.
  {
    let lastVH = window.innerHeight;
    window.addEventListener("resize", () => {
      const dvh = window.innerHeight - lastVH;
      lastVH = window.innerHeight;
      const r = root.getBoundingClientRect();
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      // Clamp BOTH axes so a narrower / shorter viewport (devtools open/close,
      // window resize) can't strand the panel off-screen. "up" panels also
      // shift their top by the height delta so the bottom edge keeps riding
      // the viewport bottom rather than drifting up.
      const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - VIEWPORT_PADDING - w);
      const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - VIEWPORT_PADDING - h);
      // Re-home an UN-dragged panel to its authored anchor as the viewport
      // changes — Build (right-anchored) rides the right edge, centred panels
      // stay centred — instead of stranding at a fixed left. A panel the user
      // has dragged keeps its own position (just clamped on-screen).
      let homeLeft: number;
      if (!userMoved && homeRightPx !== null) {
        homeLeft = window.innerWidth - w - homeRightPx;
      } else if (!userMoved && homeCentered) {
        homeLeft = (window.innerWidth - w) / 2;
      } else {
        homeLeft = r.left;
      }
      const baseTop = expandDirection === "up" ? r.top + dvh : r.top;
      const newLeft = Math.max(VIEWPORT_PADDING, Math.min(homeLeft, maxLeft));
      const newTop = Math.max(VIEWPORT_PADDING, Math.min(baseTop, maxTop));
      root.style.left = `${newLeft}px`;
      root.style.top = `${newTop}px`;
      updateAnchorsFromRect();
    });
  }

  void savedHeight; // referenced for closure capture
}

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function wireResize(
  handle: HTMLElement,
  dir: ResizeDir,
  root: HTMLElement,
  minW: number,
  minH: number,
  storageKey: string,
  onChange?: () => void,
  /** Returns whether the panel is in the expanded state. Resize is
   * a no-op when collapsed (no useful body to size; also avoids
   * saving the tiny collapsed height back as the "expanded" size). */
  expandedGate?: () => boolean,
  /** Called on resize-end so the outer collapse-sentinel logic
   * can re-cache its anchor edge against the resized rect. */
  afterUserMove?: () => void,
): void {
  let active = false;
  let startX = 0, startY = 0;
  let startW = 0, startH = 0;
  let startLeft = 0, startTop = 0;
  let pid = -1;
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // No-op while collapsed — see expandedGate doc.
    if (expandedGate && !expandedGate()) return;
    active = true;
    startX = e.clientX; startY = e.clientY;
    const rect = root.getBoundingClientRect();
    startW = rect.width; startH = rect.height;
    startLeft = rect.left; startTop = rect.top;
    pid = e.pointerId;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.stopPropagation();
    e.preventDefault();
  };
  const onMove = (e: PointerEvent): void => {
    if (!active || e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let newLeft = startLeft;
    let newTop = startTop;
    let newW = startW;
    let newH = startH;
    if (dir.includes("e")) newW = Math.max(minW, startW + dx);
    if (dir.includes("s")) newH = Math.max(minH, startH + dy);
    if (dir.includes("w")) {
      newW = Math.max(minW, startW - dx);
      newLeft = startLeft + (startW - newW);
    }
    if (dir.includes("n")) {
      newH = Math.max(minH, startH - dy);
      newTop = startTop + (startH - newH);
    }
    // Clamp to viewport.
    if (newLeft < VIEWPORT_PADDING) { newW -= VIEWPORT_PADDING - newLeft; newLeft = VIEWPORT_PADDING; }
    if (newTop < VIEWPORT_PADDING) { newH -= VIEWPORT_PADDING - newTop; newTop = VIEWPORT_PADDING; }
    if (newLeft + newW > window.innerWidth - VIEWPORT_PADDING) {
      newW = window.innerWidth - VIEWPORT_PADDING - newLeft;
    }
    if (newTop + newH > window.innerHeight - VIEWPORT_PADDING) {
      newH = window.innerHeight - VIEWPORT_PADDING - newTop;
    }
    if (newW < minW) newW = minW;
    if (newH < minH) newH = minH;
    applyLayout(root, newLeft, newTop, newW, newH);
  };
  const onUp = (e: PointerEvent): void => {
    if (!active || e.pointerId !== pid) return;
    active = false;
    pid = -1;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    afterUserMove?.();
    // Resize is gated to expanded-only by onDown (expandedGate),
    // so always treat this save as an expanded-state save.
    saveCurrentLayout(storageKey, root, true);
    onChange?.();
  };
  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

/** Apply absolute top/left (and optional width/height) to a root,
 * dropping the right/bottom/transform anchors so subsequent reads of
 * its bounding rect match the inline style. */
function applyLayout(root: HTMLElement, left: number, top: number, width?: number, height?: number): void {
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  root.style.right = "auto";
  root.style.bottom = "auto";
  root.style.transform = "none";
  if (width !== undefined) {
    root.style.width = `${width}px`;
    root.style.maxWidth = "none";
    root.style.minWidth = "0";
  }
  if (height !== undefined) {
    root.style.height = `${height}px`;
    root.style.maxHeight = "none";
    root.style.minHeight = "0";
  }
}

/** Persist current rect to localStorage. `isExpanded` controls
 * whether the CURRENT height is written:
 *   • true  → write left/top/width/height as measured.
 *   • false → write left/top/width but preserve the previously
 *     saved height. Writing the collapsed title-only height
 *     (~32 px) would clip the body the next time the panel
 *     opens — that was the root cause of the "no content" bug
 *     in chat after dragging while minimized. */
function saveCurrentLayout(key: string, root: HTMLElement, isExpanded: boolean): void {
  try {
    const rect = root.getBoundingClientRect();
    let height = rect.height;
    if (!isExpanded) {
      const existing = readState(key);
      if (existing) {
        height = existing.height;
      } else {
        // Collapsed AND no previously-saved expanded height: do NOT persist
        // the collapsed title-only height. It would be re-applied as the
        // panel's fixed height on the next expand and clip the body off the
        // bottom of the screen (the "MENU runs off-screen after dragging it
        // while collapsed" bug). The drag's inline left/top still hold for
        // this session; we just refuse to store a height we know is wrong.
        return;
      }
    }
    const state: SavedState = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height,
    };
    localStorage.setItem(key, JSON.stringify(state));
  } catch { /* ignore quota / privacy mode */ }
}

interface SavedState { left: number; top: number; width: number; height: number }
function readState(key: string): SavedState | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    if (typeof parsed.left !== "number" || typeof parsed.top !== "number") return null;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return null;
    return parsed as SavedState;
  } catch {
    return null;
  }
}
function loadState(key: string): SavedState | null {
  const parsed = readState(key);
  if (!parsed) return null;
  // Sanity-clamp against the current viewport so a saved layout from
  // a wider monitor doesn't strand the panel offscreen.
  const left = clamp(parsed.left, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, window.innerWidth - 80));
  const top = clamp(parsed.top, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, window.innerHeight - 40));
  return { left, top, width: parsed.width, height: parsed.height };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
