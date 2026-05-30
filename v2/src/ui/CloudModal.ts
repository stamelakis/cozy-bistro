import type { SpacetimeClient } from "../cloud/SpacetimeClient";

/**
 * Cloud features modal — three tabs:
 *   - Leaderboards: top scores in `daily_revenue` and `daily_served`.
 *   - Friends: list, plus send/accept/decline/unfriend.
 *   - Restaurants: mine + co-owned + public ones, with public toggle +
 *     co-owner invite/remove.
 *
 * Reads from SpacetimeClient (which proxies to the live DB cache) and
 * subscribes to its change events so the UI live-refreshes when other
 * players' rows arrive.
 */
// P6 — "Cloud" rebrand to "Social". The legacy "restaurants" tab
// was removed (the building-pick + plot-claim flow replaces it).
// Friends + Leaderboards remain the social meat. A username search
// is added inside the friends tab so players can find each other
// without needing a friend code.
type Tab = "leaderboards" | "friends";

const CATEGORIES = [
  { id: "daily_revenue", label: "Daily Revenue", scoreLabel: "$" },
  { id: "daily_served",  label: "Daily Served",  scoreLabel: "guests" },
];

export class CloudModal {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly cloud: SpacetimeClient;
  private tab: Tab = "leaderboards";
  private leaderboardCategory = "daily_revenue";
  private unsubscribe?: () => void;

  constructor(parent: HTMLElement, cloud: SpacetimeClient) {
    this.cloud = cloud;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0",
      width: "100vw", height: "100vh",
      display: "none",
      alignItems: "center", justifyContent: "center",
      background: "rgba(0, 0, 0, 0.45)",
      zIndex: "1000",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.hide(); });
    parent.appendChild(this.root);

    const card = document.createElement("div");
    Object.assign(card.style, {
      width: "min(560px, calc(100vw - 40px))",
      maxHeight: "88vh",
      display: "flex", flexDirection: "column",
      padding: "18px 22px",
      background: "rgba(28, 20, 14, 0.96)",
      color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(card);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "👋 SOCIAL";
    Object.assign(title.style, { fontSize: "16px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      width: "26px", height: "26px", cursor: "pointer",
      font: "inherit", fontSize: "13px",
    } as Partial<CSSStyleDeclaration>);
    closeBtn.onclick = () => this.hide();
    header.appendChild(closeBtn);
    card.appendChild(header);

    // Tab strip.
    const tabs = document.createElement("div");
    Object.assign(tabs.style, {
      display: "flex", gap: "6px", marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    const tabList: { id: Tab; label: string }[] = [
      { id: "leaderboards", label: "🏆 Leaderboards" },
      { id: "friends",      label: "👥 Friends" },
    ];
    for (const t of tabList) {
      const btn = document.createElement("button");
      btn.textContent = t.label;
      Object.assign(btn.style, {
        flex: "1",
        padding: "6px 8px",
        background: "rgba(255,245,220,0.06)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px",
        cursor: "pointer", font: "inherit", fontSize: "12px",
      } as Partial<CSSStyleDeclaration>);
      btn.dataset.tab = t.id;
      btn.onclick = () => { this.tab = t.id; this.refresh(); };
      tabs.appendChild(btn);
    }
    card.appendChild(tabs);

    this.body = document.createElement("div");
    Object.assign(this.body.style, {
      flex: "1", overflowY: "auto",
      padding: "4px 0",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.body);

    // Listen for live DB updates.
    this.unsubscribe = this.cloud.subscribe(() => {
      // Only redraw if visible — saves DOM churn.
      if (this.root.style.display !== "none") this.refresh();
    });
  }

  show(): void { this.refresh(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  dispose(): void { this.unsubscribe?.(); }

  // === Render ===

  private refresh(): void {
    // Refresh tab strip highlights.
    const tabBtns = this.root.querySelectorAll("button[data-tab]");
    for (const btn of Array.from(tabBtns) as HTMLButtonElement[]) {
      const active = btn.dataset.tab === this.tab;
      btn.style.background = active ? "rgba(120,200,120,0.25)" : "rgba(255,245,220,0.06)";
      btn.style.fontWeight = active ? "700" : "400";
    }

    this.body.innerHTML = "";
    if (!this.cloud.isReady()) {
      const p = document.createElement("div");
      p.textContent = "Connecting to the cloud…";
      Object.assign(p.style, { textAlign: "center", padding: "24px", opacity: "0.7" } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(p);
      return;
    }
    if (this.tab === "leaderboards") this.renderLeaderboards();
    else this.renderFriends();
  }

  private renderLeaderboards(): void {
    // Category chooser.
    const catRow = document.createElement("div");
    Object.assign(catRow.style, { display: "flex", gap: "6px", marginBottom: "10px" } as Partial<CSSStyleDeclaration>);
    for (const c of CATEGORIES) {
      const btn = document.createElement("button");
      btn.textContent = c.label;
      Object.assign(btn.style, {
        flex: "1", padding: "5px 8px",
        background: c.id === this.leaderboardCategory ? "rgba(120,180,200,0.30)" : "rgba(255,245,220,0.06)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.18)",
        borderRadius: "4px", cursor: "pointer", font: "inherit", fontSize: "11px",
        fontWeight: c.id === this.leaderboardCategory ? "700" : "400",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => { this.leaderboardCategory = c.id; this.refresh(); };
      catRow.appendChild(btn);
    }
    this.body.appendChild(catRow);

    const cat = CATEGORIES.find((c) => c.id === this.leaderboardCategory)!;
    const rows = this.cloud.getLeaderboard(cat.id, 25);
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No scores submitted yet. Finish a day to be the first!";
      Object.assign(empty.style, { textAlign: "center", padding: "16px", opacity: "0.65" } as Partial<CSSStyleDeclaration>);
      this.body.appendChild(empty);
      return;
    }

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "grid", gridTemplateColumns: "32px 1fr 80px 60px",
      gap: "8px", padding: "4px 8px",
      fontSize: "10px", fontWeight: "700", textTransform: "uppercase",
      opacity: "0.6", letterSpacing: "0.05em",
      borderBottom: "1px solid rgba(255,245,220,0.18)",
    } as Partial<CSSStyleDeclaration>);
    header.innerHTML = `<span>#</span><span>Player</span><span style="text-align:right">${cat.scoreLabel}</span><span style="text-align:right">Day</span>`;
    this.body.appendChild(header);

    for (const r of rows) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "grid", gridTemplateColumns: "32px 1fr 80px 60px",
        gap: "8px", padding: "5px 8px",
        background: r.isMe ? "rgba(120,200,120,0.15)" : undefined,
        borderBottom: "1px solid rgba(255,245,220,0.06)",
        fontVariantNumeric: "tabular-nums",
        fontWeight: r.isMe ? "700" : "400",
      } as Partial<CSSStyleDeclaration>);
      const trophy = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `${r.rank}`;
      const fmt = cat.id === "daily_revenue" ? `$${r.score}` : String(r.score);
      row.innerHTML =
        `<span>${trophy}</span>` +
        `<span>${escapeHtml(r.playerName)}${r.isMe ? " (you)" : ""}</span>` +
        `<span style="text-align:right">${fmt}</span>` +
        `<span style="text-align:right;opacity:0.7">${r.dayNumber}</span>`;
      this.body.appendChild(row);
    }
  }

  private renderFriends(): void {
    // "My display name" row.
    const view = this.cloud.getFriendsView();
    const meSection = document.createElement("div");
    Object.assign(meSection.style, { marginBottom: "12px" } as Partial<CSSStyleDeclaration>);
    const meLabel = document.createElement("div");
    meLabel.textContent = "Your display name";
    Object.assign(meLabel.style, { fontSize: "10px", opacity: "0.7", marginBottom: "4px", textTransform: "uppercase" } as Partial<CSSStyleDeclaration>);
    meSection.appendChild(meLabel);
    const meRow = document.createElement("div");
    Object.assign(meRow.style, { display: "flex", gap: "6px" } as Partial<CSSStyleDeclaration>);
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 32;
    nameInput.value = this.cloud.getMyName();
    nameInput.placeholder = "Pick a name (1–32 chars)";
    Object.assign(nameInput.style, {
      flex: "1", padding: "5px 8px",
      background: "rgba(255,245,220,0.08)", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      font: "inherit", fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    meRow.appendChild(nameInput);
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    Object.assign(saveBtn.style, btnStyle("rgba(120,200,120,0.22)") as Partial<CSSStyleDeclaration>);
    saveBtn.onclick = () => { this.cloud.setMyName(nameInput.value); };
    meRow.appendChild(saveBtn);
    meSection.appendChild(meRow);
    const hexLine = document.createElement("div");
    hexLine.textContent = `Your ID: ${this.cloud.getMyHex()}`;
    Object.assign(hexLine.style, { fontSize: "10px", opacity: "0.55", marginTop: "4px", wordBreak: "break-all" } as Partial<CSSStyleDeclaration>);
    meSection.appendChild(hexLine);
    this.body.appendChild(meSection);

    // Username search — find players on this server by username
    // substring. Clicking a result pre-fills the hex below so the
    // friend-request flow stays the same (just less typing).
    this.body.appendChild(sectionHeader("Find a player"));
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search usernames…";
    Object.assign(searchInput.style, {
      width: "100%", padding: "5px 8px", boxSizing: "border-box",
      background: "rgba(255,245,220,0.08)", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      font: "inherit", fontSize: "12px", marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(searchInput);
    const resultsList = document.createElement("div");
    Object.assign(resultsList.style, {
      maxHeight: "120px", overflowY: "auto", marginBottom: "10px",
      border: "1px solid rgba(255,245,220,0.10)", borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(resultsList);
    const renderResults = (): void => {
      const q = searchInput.value.trim().toLowerCase();
      resultsList.innerHTML = "";
      const accounts = this.cloud.listAccounts()
        .filter((a) => !a.isMe)
        .filter((a) => q === "" ? true : a.username.includes(q) || a.displayName.toLowerCase().includes(q));
      if (accounts.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = q ? "No matches." : "No other players yet.";
        Object.assign(empty.style, { padding: "8px 10px", fontSize: "11px", opacity: "0.6" } as Partial<CSSStyleDeclaration>);
        resultsList.appendChild(empty);
        return;
      }
      for (const a of accounts.slice(0, 30)) {
        const row = document.createElement("div");
        Object.assign(row.style, {
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "5px 8px", fontSize: "11px",
          borderBottom: "1px solid rgba(255,245,220,0.06)",
        } as Partial<CSSStyleDeclaration>);
        const name = document.createElement("span");
        name.innerHTML = `${escapeHtml(a.displayName)} ${a.isAdmin ? "<span style=\"opacity:0.65;font-size:9px\">admin</span>" : ""}<br><span style="opacity:0.55;font-size:10px">@${a.username}</span>`;
        row.appendChild(name);
        const sendQuickBtn = document.createElement("button");
        sendQuickBtn.textContent = "Friend";
        Object.assign(sendQuickBtn.style, btnStyle("rgba(120,180,200,0.22)") as Partial<CSSStyleDeclaration>);
        sendQuickBtn.onclick = () => {
          this.cloud.sendFriendRequestByHex(a.identity.toHexString());
        };
        row.appendChild(sendQuickBtn);
        resultsList.appendChild(row);
      }
    };
    searchInput.oninput = renderResults;
    renderResults();

    // Send-request row.
    const sendSection = sectionHeader("Send a friend request");
    this.body.appendChild(sendSection);
    const sendRow = document.createElement("div");
    Object.assign(sendRow.style, { display: "flex", gap: "6px", marginBottom: "10px" } as Partial<CSSStyleDeclaration>);
    const targetInput = document.createElement("input");
    targetInput.type = "text";
    targetInput.placeholder = "Paste their Identity hex";
    Object.assign(targetInput.style, {
      flex: "1", padding: "5px 8px",
      background: "rgba(255,245,220,0.08)", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      font: "inherit", fontSize: "11px", fontFamily: "monospace",
    } as Partial<CSSStyleDeclaration>);
    sendRow.appendChild(targetInput);
    const sendBtn = document.createElement("button");
    sendBtn.textContent = "Send";
    Object.assign(sendBtn.style, btnStyle("rgba(120,180,200,0.22)") as Partial<CSSStyleDeclaration>);
    sendBtn.onclick = () => {
      const hex = targetInput.value.trim();
      if (!hex) return;
      this.cloud.sendFriendRequestByHex(hex);
      targetInput.value = "";
    };
    sendRow.appendChild(sendBtn);
    this.body.appendChild(sendRow);

    // Incoming.
    this.body.appendChild(sectionHeader(`Incoming requests (${view.incoming.length})`));
    if (view.incoming.length === 0) {
      this.body.appendChild(muted("None right now."));
    } else {
      for (const r of view.incoming) {
        const row = personRow(`${r.fromName}`);
        const acceptBtn = document.createElement("button");
        acceptBtn.textContent = "Accept";
        Object.assign(acceptBtn.style, btnStyle("rgba(120,200,120,0.22)") as Partial<CSSStyleDeclaration>);
        acceptBtn.onclick = () => this.cloud.respondFriendRequest(r.requestId, true);
        const denyBtn = document.createElement("button");
        denyBtn.textContent = "Decline";
        Object.assign(denyBtn.style, btnStyle("rgba(200,120,120,0.22)") as Partial<CSSStyleDeclaration>);
        denyBtn.onclick = () => this.cloud.respondFriendRequest(r.requestId, false);
        row.appendChild(acceptBtn);
        row.appendChild(denyBtn);
        this.body.appendChild(row);
      }
    }

    // Outgoing.
    this.body.appendChild(sectionHeader(`Pending (sent) (${view.outgoing.length})`));
    if (view.outgoing.length === 0) {
      this.body.appendChild(muted("Nothing pending."));
    } else {
      for (const r of view.outgoing) {
        this.body.appendChild(personRow(`${r.toName} — waiting`));
      }
    }

    // Friends.
    this.body.appendChild(sectionHeader(`Friends (${view.friends.length})`));
    if (view.friends.length === 0) {
      this.body.appendChild(muted("Nobody yet — send a request above."));
    } else {
      for (const f of view.friends) {
        const row = personRow(`${f.name}`);
        const unfriendBtn = document.createElement("button");
        unfriendBtn.textContent = "Unfriend";
        Object.assign(unfriendBtn.style, btnStyle("rgba(200,120,120,0.18)") as Partial<CSSStyleDeclaration>);
        unfriendBtn.onclick = () => {
          if (window.confirm(`Unfriend ${f.name}?`)) this.cloud.unfriendByHex(f.hex);
        };
        row.appendChild(unfriendBtn);
        this.body.appendChild(row);
      }
    }
  }

}

// ===== UI helpers =====

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" :
    ch === "<" ? "&lt;" :
    ch === ">" ? "&gt;" :
    ch === '"' ? "&quot;" : "&#39;",
  );
}

function btnStyle(bg: string): Record<string, string> {
  return {
    padding: "5px 10px",
    background: bg,
    color: "#fff5dc",
    border: "1px solid rgba(255,245,220,0.25)",
    borderRadius: "4px",
    cursor: "pointer",
    font: "inherit",
    fontSize: "11px",
    fontWeight: "600",
  };
}

function sectionHeader(text: string): HTMLElement {
  const h = document.createElement("div");
  h.textContent = text;
  Object.assign(h.style, {
    fontSize: "10px", fontWeight: "700", textTransform: "uppercase",
    letterSpacing: "0.05em", opacity: "0.7",
    marginTop: "8px", marginBottom: "4px",
  } as Partial<CSSStyleDeclaration>);
  return h;
}

function muted(text: string): HTMLElement {
  const d = document.createElement("div");
  d.textContent = text;
  Object.assign(d.style, { fontSize: "11px", opacity: "0.55", padding: "4px 0" } as Partial<CSSStyleDeclaration>);
  return d;
}

function personRow(label: string): HTMLElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex", alignItems: "center", gap: "6px",
    padding: "5px 8px", marginBottom: "4px",
    background: "rgba(255,245,220,0.04)",
    borderRadius: "4px",
  } as Partial<CSSStyleDeclaration>);
  const span = document.createElement("span");
  span.textContent = label;
  Object.assign(span.style, { flex: "1", fontSize: "12px" } as Partial<CSSStyleDeclaration>);
  row.appendChild(span);
  return row;
}
