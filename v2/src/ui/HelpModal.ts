/**
 * Welcome / how-to-play modal. Auto-shows on the player's very first
 * visit (no save in localStorage), then dismissed by clicking outside
 * or the X. The HUD also gets a "?" button so the player can re-open
 * it later.
 *
 * Content is hard-coded (a real tutorial system would walk the player
 * through each UI element; this is just the get-started cheat sheet).
 */

const STORAGE_KEY = "cozy-bistro-3d-help-dismissed-v1";

interface HelpSection {
  title: string;
  body: string;
}

const SECTIONS: HelpSection[] = [
  {
    title: "The loop",
    body: "Guests walk in, sit, order, eat, pay, and leave. Your chef cooks tickets at the stove; the waiter carries plates to the seat. Hire more chefs/waiters from the bottom-left panel when the queue stacks up.",
  },
  {
    title: "Build & sell (top-right)",
    body: "Click a furniture button, then click the floor to place. Press R to rotate. Press Esc to cancel. Hit \"SELL MODE\" to refund 50% on any placed item.",
  },
  {
    title: "Menu picker (bottom-center)",
    body: "Click MENU to choose which recipes guests can order. You can run up to 3 per category. Recipes you haven't unlocked yet won't appear here.",
  },
  {
    title: "Tier expansion",
    body: "The pink tier bar (bottom-center) sells higher-tier recipes. Each tier costs more but unlocks fancier (and more lucrative) dishes.",
  },
  {
    title: "Upgrades (top-center)",
    body: "Click UPGRADES to level individual recipes. Each level gives +30% sell price and more satisfaction, but costs more each step.",
  },
  {
    title: "Auto-shop & pantry (bottom-right)",
    body: "Ingredients auto-restock when below 8 units. Toggle off to manage stock manually. The errand helper makes a visible run to the door whenever a delivery arrives.",
  },
  {
    title: "Speed controls",
    body: "Use the ‖ / 1× / 2× / 4× buttons (under the HUD) to pause or fast-forward. Camera stays responsive while paused.",
  },
  {
    title: "Boost",
    body: "Pay $80 for a 60-second guest-spawn boost when you want to grind revenue. Useful right after a furniture splurge to catch back up.",
  },
];

export class HelpModal {
  private readonly root: HTMLElement;
  /** Optional gate set by the Engine — when present and returns
   * false the modal refuses to show. Used to block the welcome
   * pop while the auth flow is still in progress so the help
   * card can't visually stack with / flash behind the LoginModal
   * on a cold load, no matter what code path triggers show(). */
  canShow?: () => boolean;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0, 0, 0, 0.55)",
      zIndex: "1100",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.hide();
    });
    parent.appendChild(this.root);

    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "min(560px, calc(100vw - 40px))",
      maxHeight: "84vh",
      display: "flex",
      flexDirection: "column",
      padding: "20px 26px",
      background: "rgba(28, 20, 14, 0.97)",
      color: "#fff5dc",
      font: "13px/1.5 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "12px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "Welcome to Cozy Bistro";
    Object.assign(title.style, { fontSize: "20px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      width: "28px",
      height: "28px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "14px",
    } as Partial<CSSStyleDeclaration>);
    closeBtn.onclick = () => this.hide();
    header.appendChild(closeBtn);
    body.appendChild(header);

    const scroller = document.createElement("div");
    Object.assign(scroller.style, {
      flex: "1",
      overflowY: "auto",
      paddingRight: "4px",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(scroller);

    for (const section of SECTIONS) {
      const block = document.createElement("div");
      Object.assign(block.style, { marginBottom: "12px" } as Partial<CSSStyleDeclaration>);
      const h = document.createElement("div");
      h.textContent = section.title;
      Object.assign(h.style, {
        fontSize: "13px",
        fontWeight: "700",
        marginBottom: "2px",
        color: "#ffd986",
      } as Partial<CSSStyleDeclaration>);
      block.appendChild(h);
      const p = document.createElement("div");
      p.textContent = section.body;
      Object.assign(p.style, { opacity: "0.9" } as Partial<CSSStyleDeclaration>);
      block.appendChild(p);
      scroller.appendChild(block);
    }

    const footer = document.createElement("button");
    footer.textContent = "Got it — start playing";
    Object.assign(footer.style, {
      marginTop: "10px",
      padding: "9px 18px",
      background: "rgba(120, 200, 120, 0.25)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.4)",
      borderRadius: "6px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "13px",
      fontWeight: "600",
      alignSelf: "center",
    } as Partial<CSSStyleDeclaration>);
    footer.onclick = () => this.hide();
    body.appendChild(footer);
  }

  show(): void {
    if (this.canShow && !this.canShow()) {
      // Auth flow still in progress (LoginModal owns the screen).
      // Silently drop the request rather than stacking under it.
      return;
    }
    this.root.style.display = "flex";
  }

  hide(): void {
    this.root.style.display = "none";
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore — quota errors, private browsing, etc.
    }
  }

  /** True if the player has never dismissed the help before. Engine
   * uses this to auto-show on the very first visit. */
  static hasBeenSeen(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }
}
