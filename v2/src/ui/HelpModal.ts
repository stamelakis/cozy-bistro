/**
 * Game guide modal. Auto-shows on the player's very first visit (no
 * dismissal flag in localStorage), then dismissed by clicking outside
 * or the X. The HUD also gets a "?" button so the player can re-open
 * it later.
 *
 * Rewritten as a TABBED guide after the server-authoritative
 * migration: the world now runs 24/7 on the server (no pause, no
 * fast-forward), and the old single-page cheat sheet was wrong about
 * most of that. Content is hard-coded and grouped into six tabs:
 * Basics / Customers / Staff / Icons / Economy / Multiplayer. The
 * Icons tab quotes the status-bubble strings EXACTLY as the routers
 * render them (StaffRouter chefLabel/waiterLabel/barmanLabel,
 * ErrandRouter errandLabel, GuestSpawner guestLabel, VisitMode
 * buildStaffLabel/buildGuestLabel) — update it when those change.
 */

const STORAGE_KEY = "cozy-bistro-3d-help-dismissed-v1";

/** One renderable chunk of tab content. Kept as plain data so the
 * DOM-building loop stays tiny and every block shares the same
 * styling. No markdown / innerHTML — everything is textContent. */
type HelpBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "legend"; rows: ReadonlyArray<readonly [string, string]> };

interface HelpTab {
  label: string;
  blocks: HelpBlock[];
}

const TABS: HelpTab[] = [
  // ────────────────────────────────────────────────────────────────
  {
    label: "Basics",
    blocks: [
      {
        kind: "p",
        text: "Run a bistro on a busy shared street: build out the floor, put recipes on the menu, hire a crew, and serve whoever walks in. Profits buy furniture, better recipes and tier expansions (1 → 5) — each tier adds recipes, extra seats and a whole new floor.",
      },
      { kind: "h", text: "The world never pauses" },
      {
        kind: "ul",
        items: [
          "Your restaurant lives on a server and runs 24/7 — a persistent online world with no fast-forward or time-skip.",
          "While you're logged off it keeps going: guests arrive, eat and pay; staff cook, serve and wash dishes; salaries and rent are charged; errand helpers restock the pantry; training and recipe timers keep counting.",
          "Logging in simply points the camera at the live simulation. Money, rating and the day counter are the server's numbers — exactly where they got to without you.",
          "Stepping away for a while? Set your restaurant to CLOSED from the HUD — it turns guests away and pauses YOUR rent and wages until you reopen. The street and everyone else keep running.",
        ],
      },
      { kind: "h", text: "Getting started" },
      {
        kind: "ul",
        items: [
          "Build: pick a furniture piece, then click the floor to place it. R rotates, Esc cancels.",
          "Rearranging: SELL refunds 50%; STORE banks a piece in your storage room for free (no refund) so you can re-place it later; and you can save named layout presets to swap the whole room at once.",
          "Decor: 🎨 restyles your walls, floor and theme — it feeds the attraction that pulls guests in and shapes their taste matches.",
          "Menu: choose which recipes guests can order (up to 3 per category).",
          "Staff: hire at least one chef and one waiter — without them nothing gets cooked or served.",
          "Reopen this guide any time with the ? button.",
        ],
      },
    ],
  },
  // ────────────────────────────────────────────────────────────────
  {
    label: "Customers",
    blocks: [
      { kind: "h", text: "Arrivals" },
      {
        kind: "ul",
        items: [
          "The neighbourhood sends guests on its own schedule. Weather (rain pushes people indoors), your décor's attraction and a paid Boost change the rate — your seat count does not.",
          "Every guest has a personality (🙂 casual, ⚡ rushed, 🍷 foodie, 📸 tourist, 💕 date night, 😠 grump, 🕵️ critic) plus tastes, and picks a free chair to match: food vs drink table, favourite theme, décor, window, quiet corner, or the bar.",
        ],
      },
      { kind: "h", text: "When the house is full" },
      {
        kind: "ul",
        items: [
          "Arrivals may WAIT near the door. How many wait, and for how long, scales with your restaurant's attraction (décor, comfort, overall vibe) — a plain bistro holds nobody, a beautiful one holds up to ~8 guests for as long as ~15–60 s each.",
          "Waiting guests are seated automatically the moment a chair frees. If their timer runs out first, they leave angry.",
        ],
      },
      { kind: "h", text: "Patience & walkouts" },
      {
        kind: "ul",
        items: [
          "Each guest has a patience pool: roughly 60 s to get their order taken and 180 s per course for the food, stretched or squeezed by personality (⚡ 0.6× … 🍷 1.3×).",
          "Patience empty → angry walkout: a red “-1★ (gave up)” pops above them, the Lost counter ticks up, and a 1★ review is recorded.",
        ],
      },
      { kind: "h", text: "Ratings (1–5★ per visit)" },
      {
        kind: "ul",
        items: [
          "Food satisfaction and recipe level, dishware quality, furniture style & comfort, the bathroom, overwhelming dish piles and smoke from hoodless stoves all weigh in. The 🕵️ Food Critic's review counts three times.",
          "A guest who never got food — or was evicted mid-meal (e.g. you sold their table) — always records 1★.",
          "WC trips: some guests use the toilet or wash their hands. No toilet when needed hurts badly, busy or shabby bathrooms hurt a little, and a clean well-equipped one lifts the score even for guests who never go.",
        ],
      },
    ],
  },
  // ────────────────────────────────────────────────────────────────
  {
    label: "Staff",
    blocks: [
      { kind: "h", text: "Roles" },
      {
        kind: "ul",
        items: [
          "Chef ($80) — claims the most urgent queued ticket, walks to a free matching station (stove, counter, …) on their floor, cooks it, returns. More chefs cook in parallel.",
          "Waiter ($70) — takes orders at the table, carries ready plates out, and washes dishes between jobs. Service outranks washing: a dish run only starts when nobody is waiting to order and no plate is ready, and only one waiter washes at a time (up to 4 pieces per trip).",
          "Barman ($80, Tier 2+) — runs the bar. He serves bar-stool guests their drinks directly (no waiter needed) AND mixes drinks ordered by guests at regular tables for a waiter to carry out. A floor with bar service can offer table guests a drink course.",
          "Errand helper ($65) — when the pantry dips below its targets they walk out the door, shop off-screen and unload at the supply counter. Each trip costs money (≈$2 per ingredient unit).",
          "Each chef, waiter and barman works ONLY the floor you assign them — set it with the floor buttons in the Staff panel. They never cross floors on their own, so if one floor gets slammed while another sits quiet, move staff over yourself. (Errand helpers are the exception — they roam the whole building.)",
          "Because of that, every floor you seat guests on needs its own crew: a chef + waiter for table service, or just a barman for a bar-only floor. Guests on a floor with no one to serve them will wait and walk out.",
        ],
      },
      { kind: "h", text: "Training & pay" },
      {
        kind: "ul",
        items: [
          "Training runs on real time — 3 h to level 1, doubling up to 48 h for level 5 — and finishes even while you're logged off. One trainee at a time. Trained waiters walk faster; trained chefs cook faster.",
          "Salaries: $6 per member per real minute, +$1/min per training level — charged around the clock, including while you're offline. Size your crew for the hours you're away.",
        ],
      },
    ],
  },
  // ────────────────────────────────────────────────────────────────
  {
    label: "Icons",
    blocks: [
      {
        kind: "p",
        text: "Every guest bubble starts with who they are:",
      },
      {
        kind: "legend",
        rows: [
          ["🙂", "Casual Diner"],
          ["⚡", "Quick Lunch — impatient, small order"],
          ["🍷", "Foodie — patient, orders big, tips well"],
          ["📸", "Tourist"],
          ["💕", "Date Night"],
          ["😠", "Grumpy Critic — stingy tipper"],
          ["🕵️", "Food Critic — rare; rating counts 3×, tips 3×"],
        ],
      },
      { kind: "h", text: "Guests" },
      {
        kind: "legend",
        rows: [
          ["(no bubble)", "waiting by the door for a free seat"],
          ["📋 / 📋🥤", "just seated, browsing the menu (🥤 = drink table)"],
          ["📋 37s", "waiting for a waiter to take the order"],
          ["⏳ 55s / 🥤 55s", "order placed → waiting for the food / drink (patience left)"],
          ["🍽️ / 🍹", "eating / drinking (green bubble)"],
          ["🚻", "toilet trip"],
          ["🧼", "washing hands at a sink"],
          ["🎨 🪟 🤫 🍸", "seat tastes: décor / window / quiet corner / bar fan"],
          ["red bubble", "patience nearly gone (~10 s) — about to storm out"],
        ],
      },
      { kind: "h", text: "Pop-ups" },
      {
        kind: "legend",
        rows: [
          ["+$N", "course paid"],
          ["★★★★☆", "the rating they leave on the way out"],
          ["tip +$N", "tip on top (rating, personality & weather)"],
          ["-1★ (gave up)", "angry walkout — counted as Lost"],
        ],
      },
      { kind: "h", text: "Waiter" },
      {
        kind: "legend",
        rows: [
          ["📋 → take order", "walking over to take an order"],
          ["📋 taking order", "taking the order"],
          ["🍳 → fetch dish", "fetching a ready plate from the kitchen"],
          ["🍽️ → serve table / 🍽️ serving dish", "carrying it out and serving it"],
          ["🧽 → grab dirty dish", "going to collect dirty dishes"],
          ["🧼 → to sink", "carrying them to a sink / dishwasher"],
          ["🧼 washing up", "scrubbing / loading"],
          ["🧽 → clear table / 🧹 clearing table", "bussing a vacated (dirty) table"],
          ["(no bubble)", "winding down / heading back to rest — reads as idle on the staff panel"],
        ],
      },
      { kind: "h", text: "Chef" },
      {
        kind: "legend",
        rows: [
          ["→ stove", "walking to a free station"],
          ["🍳 cooking", "cooking the ticket"],
          ["(no bubble)", "winding down / heading back to the stove — reads as idle"],
        ],
      },
      { kind: "h", text: "Barman" },
      {
        kind: "legend",
        rows: [
          ["→ bar", "heading to the bar counter"],
          ["🍸 mixing", "preparing a drink (behind the bar)"],
          ["(no bubble)", "winding down / heading back behind the bar — reads as idle"],
        ],
      },
      { kind: "h", text: "Errand helper (purple bubble)" },
      {
        kind: "legend",
        rows: [
          ["📦 leaving", "heading out the door"],
          ["📦 to shop", "walking up the street to shop"],
          ["📦 returning", "back with the goods"],
          ["📦 → counter", "carrying them to the supply counter"],
          ["📦 dropping off", "unloading into the pantry"],
          ["← back", "done — returning to their spot"],
        ],
      },
      { kind: "h", text: "While visiting another restaurant" },
      {
        kind: "legend",
        rows: [
          ["🥘 / 🍷 / 🍽 + dish", "their chef / barman / waiter working that dish"],
          ["🛒 → · 🛒 shopping · 🛒 ←", "their errand helper's shopping trip"],
          ["📦 unloading · 🛒 done", "the delivery arriving"],
          ["🔴 LIVE / ❄ STATIC", "overlay badge: real-time feed vs snapshot"],
        ],
      },
    ],
  },
  // ────────────────────────────────────────────────────────────────
  {
    label: "Economy",
    blocks: [
      { kind: "h", text: "Income" },
      {
        kind: "ul",
        items: [
          "A dish's price = ingredient cost + profit; profit grows with the recipe's tier and level. Each served course pops “+$N”.",
          "Tips on exit: 5% / 15% / 30% of the bill at 3★ / 4★ / 5★, multiplied by personality (😠 0.4× … 🕵️ 3×) and weather.",
        ],
      },
      { kind: "h", text: "Recurring costs" },
      {
        kind: "ul",
        items: [
          "Rent per in-game day by tier: $40 / $80 / $160 / $320 / $640, scaled by plot size. Your first 14 days are rent-free; after that it's charged at every day rollover.",
          "Wages: $6/min per staff member (+$1/min per training level) — around the clock, even while you're offline.",
          "Auto-shop: ingredients cost ≈$2 per unit, bought whenever stock dips below target (tune targets in Pantry).",
          "One in-game day = 12 real minutes. Served / Lost and daily revenue / expenses reset at the rollover.",
        ],
      },
      { kind: "h", text: "Dishes" },
      {
        kind: "ul",
        items: [
          "Every course dirties a plate or glass. Waiters haul up to 4 pieces per run to a sink (scrubbed clean on the spot) or a dishwasher (holds up to 10 plates + 5 glasses, then washes by itself — the Pro model is faster).",
          "No clean dishes = service stalls, and an overwhelming dirty pile costs a rating star. Buy extra sets in Pantry → Dishware.",
        ],
      },
      { kind: "h", text: "Investments" },
      {
        kind: "ul",
        items: [
          "Recipe development (UPGRADES): $30, doubling each level, plus ingredients. It takes REAL time — about 1 min at Tier 1 Level 1, doubling per tier and per level — and the timer keeps running while you're logged off. Each level raises the sell price and satisfaction; one recipe at a time.",
          "Boost: $80 buys 60 s of 2× guest arrivals, then a 15-minute cooldown.",
          "Expand: Tiers 2–5 cost $30k / $90k / $270k / $810k and unlock new recipes, extra seats (T2–T4) and one more floor each.",
        ],
      },
      { kind: "h", text: "Track your numbers" },
      {
        kind: "ul",
        items: [
          "📊 Trends charts your day-by-day revenue, customers and rating; 📈 Analytics graphs live customer and staff activity over time.",
          "📓 Ledger is a running log of every transaction — sales, tips, wages, rent and shopping.",
          "🏆 Awards hands out one-off cash rewards as you hit milestones.",
        ],
      },
    ],
  },
  // ────────────────────────────────────────────────────────────────
  {
    label: "Multiplayer",
    blocks: [
      {
        kind: "p",
        text: "Every plot on the street is another real player's restaurant — the same server simulates them all, around the clock.",
      },
      {
        kind: "ul",
        items: [
          "Click a plot and choose Visit to walk through it. A 🔴 LIVE badge means you're watching their actual service in real time — staff trips, guest bubbles and kitchen tickets (🍽 seated · 👤 staff · 🍳 cooking · 🛎 ready). ❄ STATIC means you're seeing a snapshot because no live data is flowing right now.",
          "You're on display the same way: anyone can visit your place and watch your crew work, even while you're offline.",
          "The plaque by your door shows your restaurant's name and live star rating to everyone — customise it with the sign editor.",
          "Use the chat panel to talk with other owners; the HUD shows how many players are online. The 👋 Social button opens your friends list and the leaderboards.",
        ],
      },
    ],
  },
];

export class HelpModal {
  private readonly root: HTMLElement;
  private readonly tabButtons: HTMLButtonElement[] = [];
  private readonly content: HTMLDivElement;
  private activeTab = 0;
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
      width: "min(640px, calc(100vw - 40px))",
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
    title.textContent = "Cozy Bistro — Game Guide";
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

    // ── Tab bar ──────────────────────────────────────────────────
    const tabBar = document.createElement("div");
    Object.assign(tabBar.style, {
      display: "flex",
      flexWrap: "wrap",
      gap: "6px",
      paddingBottom: "10px",
      marginBottom: "10px",
      borderBottom: "1px solid rgba(255,245,220,0.15)",
    } as Partial<CSSStyleDeclaration>);
    TABS.forEach((tab, i) => {
      const btn = document.createElement("button");
      btn.textContent = tab.label;
      Object.assign(btn.style, {
        background: "transparent",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.25)",
        borderRadius: "6px",
        padding: "5px 11px",
        cursor: "pointer",
        font: "inherit",
        fontSize: "12px",
        fontWeight: "600",
        opacity: "0.75",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => this.selectTab(i);
      this.tabButtons.push(btn);
      tabBar.appendChild(btn);
    });
    body.appendChild(tabBar);

    // ── Scrollable content area (swapped per tab) ────────────────
    this.content = document.createElement("div");
    Object.assign(this.content.style, {
      flex: "1",
      overflowY: "auto",
      paddingRight: "4px",
      minHeight: "0",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.content);

    const footer = document.createElement("button");
    footer.textContent = "Got it — start playing";
    Object.assign(footer.style, {
      marginTop: "12px",
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

    this.selectTab(0);
  }

  /** Highlight tab `i`'s button and rebuild the content area from its
   * block list. Scroll position resets so each tab starts at the top. */
  private selectTab(i: number): void {
    this.activeTab = i;
    this.tabButtons.forEach((btn, j) => {
      const active = j === i;
      Object.assign(btn.style, {
        background: active ? "rgba(255,217,134,0.16)" : "transparent",
        color: active ? "#ffd986" : "#fff5dc",
        borderColor: active ? "rgba(255,217,134,0.6)" : "rgba(255,245,220,0.25)",
        opacity: active ? "1" : "0.75",
      } as Partial<CSSStyleDeclaration>);
    });
    this.content.replaceChildren();
    for (const block of TABS[this.activeTab].blocks) {
      this.content.appendChild(this.renderBlock(block));
    }
    this.content.scrollTop = 0;
  }

  private renderBlock(block: HelpBlock): HTMLElement {
    switch (block.kind) {
      case "h": {
        const h = document.createElement("div");
        h.textContent = block.text;
        Object.assign(h.style, {
          fontSize: "13px",
          fontWeight: "700",
          margin: "10px 0 4px",
          color: "#ffd986",
        } as Partial<CSSStyleDeclaration>);
        return h;
      }
      case "p": {
        const p = document.createElement("div");
        p.textContent = block.text;
        Object.assign(p.style, { opacity: "0.9", marginBottom: "8px" } as Partial<CSSStyleDeclaration>);
        return p;
      }
      case "ul": {
        const ul = document.createElement("ul");
        Object.assign(ul.style, {
          margin: "0 0 10px",
          paddingLeft: "18px",
          opacity: "0.9",
        } as Partial<CSSStyleDeclaration>);
        for (const item of block.items) {
          const li = document.createElement("li");
          li.textContent = item;
          Object.assign(li.style, { marginBottom: "4px" } as Partial<CSSStyleDeclaration>);
          ul.appendChild(li);
        }
        return ul;
      }
      case "legend": {
        const grid = document.createElement("div");
        Object.assign(grid.style, {
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          columnGap: "14px",
          rowGap: "3px",
          margin: "0 0 10px",
        } as Partial<CSSStyleDeclaration>);
        for (const [icon, meaning] of block.rows) {
          const iconEl = document.createElement("div");
          iconEl.textContent = icon;
          Object.assign(iconEl.style, {
            fontWeight: "600",
            whiteSpace: "nowrap",
          } as Partial<CSSStyleDeclaration>);
          grid.appendChild(iconEl);
          const meaningEl = document.createElement("div");
          meaningEl.textContent = meaning;
          Object.assign(meaningEl.style, { opacity: "0.85" } as Partial<CSSStyleDeclaration>);
          grid.appendChild(meaningEl);
        }
        return grid;
      }
    }
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
