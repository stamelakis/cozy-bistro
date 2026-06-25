import { SpacetimeClient } from "../cloud/SpacetimeClient";

/**
 * Always-on bottom-left chat panel — sits in the strip between the
 * sidebar (left, 256 px) and the centered MenuPanel. Tabs: a pinned
 * "Global" tab + one tab per active PM conversation. Each tab has a
 * scrollable transcript and an input field; click anywhere on a tab
 * header to focus, X to close (PMs only — global can't be closed).
 *
 * Server messages arrive through SpacetimeClient.onChatMessage. The
 * panel keeps a small per-channel cache (rebuilt from listChatMessages
 * on demand) so opening a tab the player hasn't visited yet
 * back-fills the recent transcript without an extra round trip.
 *
 * Compact when minimized: just the title bar + tab strip (about
 * 32 px tall). Click the title bar's chevron to toggle.
 */
export class ChatPanel {
  private readonly cloud: SpacetimeClient;
  /** Optional hook fired after a successful send (global OR PM).
   * Engine wires this to bump game.playerCounters.chatsSent so the
   * social achievements unlock. */
  onMessageSent?: () => void;
  /** Root panel element — exposed so the engine can make it
   * draggable + resizable. */
  readonly root: HTMLElement;
  /** Title bar — used as the drag handle by PanelDragResize. */
  readonly titleBar: HTMLElement;
  private readonly tabsRow: HTMLElement;
  /** Body container holding tabs + log + input row. display:none
   * when minimized. Exposed so PanelDragResize can watch it as
   * the collapse sentinel. */
  readonly body: HTMLElement;
  private readonly logArea: HTMLElement;
  private readonly inputRow: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly newPmBtn: HTMLButtonElement;
  private readonly toggleBtn: HTMLButtonElement;

  /** Active tab identifier. `"global"` or a `pm:<a>|<b>` channel id. */
  private activeChannel = "global";
  /** Tab descriptors keyed by channel id. */
  private tabs = new Map<string, { channel: string; label: string; closable: boolean; unread: number; otherHex?: string; btn: HTMLButtonElement; close?: HTMLButtonElement }>();
  /** In-memory message log per channel. Populated ONLY from
   * onChatMessage callbacks fired during the current session — no
   * server-cached replay is rendered. This is what enforces
   * "ephemeral chat": a reload starts the UI fresh even if the
   * server still briefly holds messages from a few seconds ago. */
  private sessionMessages = new Map<string, SessionMessage[]>();
  /** Cap on messages kept per channel — older ones drop. Keeps
   * memory bounded if a session runs for hours. */
  private readonly maxPerChannel = 200;
  /** True when the panel body is collapsed (only title bar visible).
   * Defaults TRUE so the panel opens as a thin 32 px-tall bar that
   * doesn't crowd the centered MenuPanel. The user clicks the title
   * to expand. */
  private minimized = true;
  /** Snapshot of the last-rendered log signature per channel — lets us
   * skip rebuilding the log DOM when nothing changed for the active
   * tab. Same defensive pattern as MenuPanel. */
  private lastLogSig = "";
  /** Detach the chat-message listener on dispose. */
  private chatUnsub: (() => void) | null = null;

  constructor(parent: HTMLElement, cloud: SpacetimeClient) {
    this.cloud = cloud;

    // === Outer chrome ===
    // Bottom-left strip — far enough right to clear the 256 px sidebar
    // with margins, narrow enough not to crash into the centered
    // MenuPanel on common screen sizes. width clamps so a tiny
    // viewport still hides the panel rather than overlapping things.
    this.root = document.createElement("div");
    this.root.classList.add("cb-chat");
    // Bottom-left strip — right of the 256 px sidebar (12 px gap).
    // The centered MenuPanel can grow leftward to meet this strip on
    // typical viewports (at 100vw=1280, menu_left = 280 = chat_left
    // exactly), so the chat MUST stay narrow and START minimized
    // to avoid hiding the menu's first column. Width caps at 300 px
    // because that's the widest the panel can be before it starts
    // visibly crashing into the menu at ~1400 px viewports.
    //
    // Expanded behaviour (see setMinimized): the panel lifts ABOVE
    // the MenuPanel's max possible expanded height so the two never
    // visually collide when both are open.
    Object.assign(this.root.style, {
      position: "fixed",
      left: "280px",
      bottom: "12px",
      // Slimmer than before — 260 px target with 220 floor / 280 cap.
      // Some overlap with the centered MenuPanel is unavoidable at
      // 1280-px viewports (menu_left = chat_left = 280 there), but a
      // narrower chat keeps that overlap to a bearable strip on
      // expand, and the panel no longer needs to fly up the screen
      // to find space.
      width: "min(280px, calc(100vw - 920px))",
      // Bumped minWidth from 220 → 260 so the "Say something in
      // Global..." input + Send button always have enough breathing
      // room — the user reported the resize handle let them shrink
      // it past the point where the input was unusable.
      minWidth: "260px",
      maxWidth: "320px",
      // No maxHeight here — PanelDragResize owns the root's height.
      // The body starts display:none (set by applyMinimizedStyles in
      // the constructor) so the root collapses naturally to the
      // title-bar height for the first paint.
      display: "flex",
      flexDirection: "column",
      background: "rgba(20, 14, 10, 0.86)",
      color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif",
      // All four corners rounded so the minimized "title-bar only"
      // state matches the rest of the UI (Sidebar, MenuPanel etc).
      // Previously the bottom corners were sharp ("10px 10px 0 0")
      // which looked unfinished when collapsed.  overflow:hidden
      // below still clips the body neatly against the rounded edges.
      borderRadius: "10px",
      pointerEvents: "auto",
      boxShadow: "0 -4px 14px rgba(0,0,0,0.35)",
      zIndex: "100",
      overflow: "hidden",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);
    console.log("[ChatPanel] mounted at left:280, bottom:12 (root attached to:", parent.tagName, ")");

    // === Title bar (always visible — drives minimize toggle) ===
    const titleBar = document.createElement("div");
    this.titleBar = titleBar;
    Object.assign(titleBar.style, {
      display: "flex", alignItems: "center", gap: "6px",
      padding: "5px 8px 5px 10px",
      background: "rgba(0,0,0,0.30)",
      borderBottom: "1px solid rgba(255,245,220,0.15)",
      cursor: "pointer",
      userSelect: "none",
      flex: "0 0 auto",
    } as Partial<CSSStyleDeclaration>);
    const titleText = document.createElement("span");
    titleText.textContent = "💬 CHAT";
    Object.assign(titleText.style, {
      fontSize: "11px", fontWeight: "700", letterSpacing: "0.06em", flex: "1",
    } as Partial<CSSStyleDeclaration>);
    titleBar.appendChild(titleText);
    this.toggleBtn = document.createElement("button");
    this.toggleBtn.textContent = "▾";
    Object.assign(this.toggleBtn.style, {
      background: "transparent", color: "#fff5dc",
      border: "none", cursor: "pointer",
      font: "inherit", fontSize: "14px", padding: "0 4px",
      lineHeight: "1",
    } as Partial<CSSStyleDeclaration>);
    titleBar.appendChild(this.toggleBtn);
    titleBar.onclick = () => this.setMinimized(!this.minimized);
    // Title bar's button shares the click via bubbling — no special
    // handler needed; both elements toggle the same state.
    this.root.appendChild(titleBar);

    // === Tab strip ===
    this.tabsRow = document.createElement("div");
    Object.assign(this.tabsRow.style, {
      display: "flex", alignItems: "stretch", gap: "2px",
      padding: "4px 6px 0 6px",
      flex: "0 0 auto",
      background: "rgba(0,0,0,0.18)",
      overflowX: "auto",
      whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.tabsRow);

    // === Body (transcript + input) — hidden when minimized ===
    this.body = document.createElement("div");
    Object.assign(this.body.style, {
      display: "flex", flexDirection: "column",
      flex: "1 1 auto",
      minHeight: "0", // allow flex children to scroll
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);

    this.logArea = document.createElement("div");
    Object.assign(this.logArea.style, {
      flex: "1 1 auto",
      overflowY: "auto",
      padding: "6px 8px",
      display: "flex", flexDirection: "column", gap: "3px",
      minHeight: "120px", maxHeight: "200px",
    } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(this.logArea);

    // === Input row ===
    this.inputRow = document.createElement("div");
    Object.assign(this.inputRow.style, {
      display: "flex", gap: "4px",
      padding: "6px 8px 8px 8px",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      background: "rgba(0,0,0,0.18)",
    } as Partial<CSSStyleDeclaration>);
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Say something…";
    this.input.maxLength = 500;
    Object.assign(this.input.style, {
      flex: "1",
      background: "rgba(255,245,220,0.06)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "3px",
      padding: "5px 8px",
      font: "inherit", fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    this.inputRow.appendChild(this.input);
    this.sendBtn = document.createElement("button");
    this.sendBtn.textContent = "Send";
    Object.assign(this.sendBtn.style, {
      padding: "5px 10px",
      background: "rgba(120, 200, 120, 0.25)", color: "#fff5dc",
      border: "1px solid rgba(120, 200, 120, 0.55)",
      borderRadius: "3px", cursor: "pointer",
      font: "inherit", fontSize: "11px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    this.inputRow.appendChild(this.sendBtn);
    this.newPmBtn = document.createElement("button");
    this.newPmBtn.textContent = "✉";
    this.newPmBtn.title = "Start a private chat with another player";
    Object.assign(this.newPmBtn.style, {
      padding: "5px 8px",
      background: "rgba(255,245,220,0.10)", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "3px", cursor: "pointer",
      font: "inherit", fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    this.inputRow.appendChild(this.newPmBtn);
    this.body.appendChild(this.inputRow);

    // === Wire interactions ===
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.fireSend();
      }
    });
    // Prevent the global keyboard shortcuts (build menu hotkeys, etc.)
    // from firing when the player is typing in chat — the engine binds
    // a bunch of single-letter shortcuts to window keydown, which would
    // hijack the keypress and never reach the input. Stopping
    // propagation on the input's own keydown keeps the typed character
    // local to the field.
    this.input.addEventListener("keydown", (e) => e.stopPropagation());
    this.input.addEventListener("keyup", (e) => e.stopPropagation());
    this.input.addEventListener("keypress", (e) => e.stopPropagation());
    this.sendBtn.onclick = () => this.fireSend();
    this.newPmBtn.onclick = () => this.openNewPmFlow();

    // Pin the global tab.
    this.addTab({ channel: "global", label: "🌐 Global", closable: false });
    this.setActive("global");

    // Default minimized — hide body + tabs so only the title bar
    // shows. setMinimized(true) is idempotent with the field
    // default; calling it here ensures the visible state matches
    // `this.minimized` after construction.
    this.applyMinimizedStyles();

    // No discoverExistingPms() — explicitly ephemeral. PM tabs spawn
    // when the FIRST message arrives in this session, not from
    // server-cached history.

    // Subscribe to new chat messages — bump unread counts, refresh
    // active log, auto-spawn a tab if it's a PM we haven't seen.
    // This is the ONLY source of messages for the UI; nothing
    // reads from the server-side cache (cloud.listChatMessages).
    this.chatUnsub = this.cloud.onChatMessage((msg) => this.onIncoming(msg));
  }

  // ============================================================
  //                       TAB MANAGEMENT
  // ============================================================

  private addTab(opts: { channel: string; label: string; closable: boolean; otherHex?: string }): void {
    if (this.tabs.has(opts.channel)) return;
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      padding: "4px 8px",
      background: "rgba(255,245,220,0.08)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.18)",
      borderTopLeftRadius: "4px", borderTopRightRadius: "4px",
      borderBottom: "none",
      cursor: "pointer",
      font: "inherit", fontSize: "11px", fontWeight: "600",
      display: "flex", alignItems: "center", gap: "4px",
      whiteSpace: "nowrap",
      flex: "0 0 auto",
    } as Partial<CSSStyleDeclaration>);
    btn.onclick = () => this.setActive(opts.channel);
    const labelEl = document.createElement("span");
    labelEl.textContent = opts.label;
    btn.appendChild(labelEl);
    let close: HTMLButtonElement | undefined;
    if (opts.closable) {
      close = document.createElement("button");
      close.textContent = "×";
      Object.assign(close.style, {
        background: "transparent", color: "#fff5dc",
        border: "none", cursor: "pointer",
        font: "inherit", fontSize: "12px",
        padding: "0 2px", lineHeight: "1", opacity: "0.7",
      } as Partial<CSSStyleDeclaration>);
      close.onclick = (e) => {
        e.stopPropagation();
        this.removeTab(opts.channel);
      };
      btn.appendChild(close);
    }
    this.tabsRow.appendChild(btn);
    this.tabs.set(opts.channel, { ...opts, unread: 0, btn, close });
    this.refreshTabStyles();
  }

  private removeTab(channel: string): void {
    if (channel === "global") return; // pinned
    const t = this.tabs.get(channel);
    if (!t) return;
    try { t.btn.remove(); } catch { /* already gone */ }
    this.tabs.delete(channel);
    if (this.activeChannel === channel) this.setActive("global");
  }

  private setActive(channel: string): void {
    if (!this.tabs.has(channel)) return;
    this.activeChannel = channel;
    // Clear the unread count when focusing a tab.
    const t = this.tabs.get(channel);
    if (t) t.unread = 0;
    this.input.value = "";
    this.input.placeholder = channel === "global"
      ? "Say something in Global…"
      : `Private — message ${this.tabs.get(channel)?.label.replace(/^@/, "") ?? "player"}…`;
    this.refreshTabStyles();
    this.lastLogSig = ""; // force log rebuild
    this.refreshActiveLog();
    // Focus the input if the panel is visible so the player can
    // start typing immediately after a tab switch.
    if (!this.minimized) this.input.focus();
  }

  private refreshTabStyles(): void {
    for (const t of this.tabs.values()) {
      const active = t.channel === this.activeChannel;
      t.btn.style.background = active ? "rgba(120, 200, 120, 0.30)" : "rgba(255,245,220,0.08)";
      t.btn.style.borderColor = active ? "rgba(120, 200, 120, 0.55)" : "rgba(255,245,220,0.18)";
      t.btn.style.fontWeight = active ? "700" : "600";
      // First child is the label span — rewrite its text to include
      // the unread badge inline so wide-character labels (Greek names,
      // emoji) still align cleanly without a separate flex layout.
      const labelSpan = t.btn.querySelector("span");
      if (labelSpan) {
        if (t.unread > 0 && !active) {
          labelSpan.innerHTML = `${escapeHtml(t.label)} <span style="background:#d36a6a;color:#fff5dc;border-radius:8px;padding:0 5px;font-size:9px;margin-left:2px">${t.unread > 99 ? "99+" : t.unread}</span>`;
        } else {
          labelSpan.textContent = t.label;
        }
      }
    }
  }

  // ============================================================
  //                       MESSAGE HANDLING
  // ============================================================

  private onIncoming(msg: { id: bigint; channel: string; senderHex: string; senderName: string; text: string; sentAtMs: number; isMine: boolean }): void {
    // Push into the session-only in-memory store. We deliberately
    // do NOT consult the server cache for older messages — every
    // session starts with an empty log.
    //
    // Dedupe by message id (in case the server replays a row we
    // already received earlier in the session).
    let list = this.sessionMessages.get(msg.channel);
    if (!list) {
      list = [];
      this.sessionMessages.set(msg.channel, list);
    }
    if (list.some((m) => m.id === msg.id)) return;
    list.push({
      id: msg.id,
      senderHex: msg.senderHex,
      senderName: msg.senderName,
      text: msg.text,
      sentAtMs: msg.sentAtMs,
      isMine: msg.isMine,
    });
    // Trim oldest if we're over the per-channel cap.
    if (list.length > this.maxPerChannel) {
      list.splice(0, list.length - this.maxPerChannel);
    }
    // Auto-spawn a PM tab when we receive a message on a channel we
    // didn't already have open (the recipient may not have started
    // the conversation themselves).
    if (msg.channel.startsWith("pm:") && !this.tabs.has(msg.channel)) {
      // Resolve the OTHER party of the PM channel — for incoming
      // messages from someone else, that's the sender; for our own
      // sent messages it's whoever the channel id pairs us with.
      const myHex = (this.cloud.getMyHex() || "").toLowerCase();
      let otherHex = msg.senderHex.toLowerCase();
      if (msg.isMine) {
        const body = msg.channel.slice(3);
        const [a, b] = body.split("|");
        otherHex = (a?.toLowerCase() === myHex ? b : a) ?? otherHex;
      }
      const otherName = this.cloud.displayNameFor(otherHex);
      this.addTab({ channel: msg.channel, label: `@${otherName}`, closable: true, otherHex });
    }
    // If the active tab matches, just refresh the log; otherwise bump
    // the unread counter for that tab.
    if (msg.channel === this.activeChannel) {
      this.lastLogSig = "";
      this.refreshActiveLog();
    } else if (!msg.isMine) {
      const t = this.tabs.get(msg.channel);
      if (t) { t.unread += 1; this.refreshTabStyles(); }
    }
  }

  private refreshActiveLog(): void {
    const channel = this.activeChannel;
    // Read from the session-only in-memory store, NOT from the
    // server-side cache (cloud.listChatMessages). This guarantees a
    // reload starts the chat fresh even if the server still has a
    // few seconds of recently-delivered messages in its table.
    const msgs = this.sessionMessages.get(channel) ?? [];
    // Signature = id of newest message + length. A new send or delete
    // bumps either field; signatures match → no rebuild needed.
    const sig = msgs.length === 0 ? "0|0" : `${msgs[msgs.length - 1].id}|${msgs.length}`;
    if (sig === this.lastLogSig) return;
    this.lastLogSig = sig;
    this.logArea.innerHTML = "";
    if (msgs.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = channel === "global"
        ? "Be the first to say hello!"
        : "No messages yet — say hi!";
      Object.assign(empty.style, {
        textAlign: "center", opacity: "0.5", fontSize: "11px",
        padding: "16px 0",
      } as Partial<CSSStyleDeclaration>);
      this.logArea.appendChild(empty);
      return;
    }
    for (const m of msgs) this.logArea.appendChild(renderMessageRow(m));
    // Scroll to bottom so the newest message is visible.
    this.logArea.scrollTop = this.logArea.scrollHeight;
  }

  private async fireSend(): Promise<void> {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.disabled = true;
    this.sendBtn.disabled = true;
    try {
      if (this.activeChannel === "global") {
        await this.cloud.sendChatGlobal(text);
      } else if (this.activeChannel.startsWith("pm:")) {
        const t = this.tabs.get(this.activeChannel);
        if (!t?.otherHex) {
          this.flashError("Can't determine recipient for this conversation");
          return;
        }
        await this.cloud.sendChatPrivate(t.otherHex, text);
      }
      this.input.value = "";
      // Notify the engine so it can bump the lifetime "chats sent"
      // counter (drives the social achievements). Fire-and-forget.
      try { this.onMessageSent?.(); } catch { /* ignore */ }
    } catch (e) {
      this.flashError(errorString(e));
    } finally {
      this.input.disabled = false;
      this.sendBtn.disabled = false;
      this.input.focus();
    }
  }

  private flashError(text: string): void {
    // Surface in the input field as a transient placeholder swap —
    // small and unobtrusive, no separate toast required.
    const old = this.input.placeholder;
    this.input.placeholder = `⚠ ${text}`;
    this.input.style.borderColor = "rgba(220, 130, 130, 0.6)";
    window.setTimeout(() => {
      this.input.placeholder = old;
      this.input.style.borderColor = "rgba(255,245,220,0.22)";
    }, 4000);
  }

  // ============================================================
  //                       NEW PM FLOW
  // ============================================================

  /** Prompt the player for a username, look them up via the cloud's
   * auth_record cache, then open a PM tab. Simple `window.prompt`
   * for v1 — could be upgraded to a player picker UI later that
   * surfaces online players inline. */
  private openNewPmFlow(): void {
    const raw = window.prompt("Username to message:");
    if (!raw) return;
    const target = raw.trim();
    if (!target) return;
    const targetLc = target.toLowerCase();
    // Find the account by username.
    const account = this.cloud.listAccounts().find((a) => a.username === targetLc);
    if (!account) {
      this.flashError(`No account named "${target}"`);
      return;
    }
    if (account.isMe) {
      this.flashError("Can't PM yourself");
      return;
    }
    const otherHex = account.identity.toHexString().toLowerCase();
    const meHex = (this.cloud.getMyHex() || "").toLowerCase();
    if (!meHex) {
      this.flashError("Not connected yet — try again in a moment");
      return;
    }
    // Compute the channel id locally (same shape as the server's
    // pm_channel_for) so the new tab maps to the SAME conversation
    // as any prior history.
    const channel = SpacetimeClient.pmChannelFor(meHex, otherHex);
    this.addTab({ channel, label: `@${account.displayName || account.username}`, closable: true, otherHex });
    this.setActive(channel);
  }

  // (discoverExistingPms removed — owner wants ephemeral chat with
  //  no historical replay. PM tabs auto-spawn from onIncoming when
  //  the first in-session message arrives on a new channel.)

  // ============================================================
  //                       MINIMIZE / DISPOSE
  // ============================================================

  setMinimized(min: boolean): void {
    this.minimized = min;
    this.applyMinimizedStyles();
  }

  /** Apply the visual state for `this.minimized`. Split out from
   * setMinimized so the constructor can call it once everything is
   * mounted without going through the full toggle path.
   *
   * Only flips body + tabs visibility + the chevron — the ROOT's
   * height/maxHeight are owned by PanelDragResize (which observes
   * the body's display flip and re-applies the saved expanded
   * height on transition). Asserting maxHeight here on every toggle
   * fought with PanelDragResize's anchor-based positioning + the
   * saved-height restore, leaving the chat clipped to 280 px on
   * expand even when the user had resized it taller — that was the
   * "chat doesn't expand properly" bug that MenuPanel + BuildMenu
   * never had (neither of them touches root height). */
  private applyMinimizedStyles(): void {
    const min = this.minimized;
    this.body.style.display = min ? "none" : "flex";
    this.tabsRow.style.display = min ? "none" : "flex";
    this.toggleBtn.textContent = min ? "▴" : "▾";
  }

  destroy(): void {
    if (this.chatUnsub) { this.chatUnsub(); this.chatUnsub = null; }
    try { this.root.remove(); } catch { /* already gone */ }
  }
}

/** Session-only message record. Lives entirely in the ChatPanel's
 * in-memory store and never gets re-hydrated from the server cache
 * on the next session (that's the whole point — ephemeral chat). */
interface SessionMessage {
  id: bigint;
  senderHex: string;
  senderName: string;
  text: string;
  sentAtMs: number;
  isMine: boolean;
}

// ============================================================
//                       HELPERS
// ============================================================

function renderMessageRow(m: { senderName: string; senderHex: string; text: string; sentAtMs: number; isMine: boolean }): HTMLElement {
  // Chat-bubble layout: own messages right-aligned with a green
  // tint, other people's messages left-aligned with an amber tint.
  // Replaces the old "flat list of name/time/text triples" which
  // visually ran two consecutive messages together because the
  // separator was a barely-visible dotted line.
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: m.isMine ? "flex-end" : "flex-start",
    marginBottom: "6px",
  } as Partial<CSSStyleDeclaration>);

  // The bubble itself — colored background + border so each message
  // is clearly its own unit, no matter how short or long.
  const bubble = document.createElement("div");
  Object.assign(bubble.style, {
    maxWidth: "82%",
    minWidth: "0", // allow flex children to truncate
    padding: "4px 8px 5px 8px",
    borderRadius: "8px",
    background: m.isMine
      ? "rgba(120, 200, 120, 0.18)"
      : "rgba(255, 217, 134, 0.10)",
    border: m.isMine
      ? "1px solid rgba(120, 200, 120, 0.35)"
      : "1px solid rgba(255, 217, 134, 0.22)",
    display: "flex",
    flexDirection: "column",
    gap: "1px",
  } as Partial<CSSStyleDeclaration>);

  // Head row — name on one side, timestamp on the other. Both small
  // and de-emphasized so the message TEXT is the visual focus.
  const head = document.createElement("div");
  Object.assign(head.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: "10px",
    fontSize: "10px",
    lineHeight: "1.2",
  } as Partial<CSSStyleDeclaration>);
  const name = document.createElement("span");
  name.textContent = m.isMine ? "You" : m.senderName;
  Object.assign(name.style, {
    fontWeight: "700",
    color: m.isMine ? "#a8e2a8" : "#ffd986",
  } as Partial<CSSStyleDeclaration>);
  head.appendChild(name);
  const time = document.createElement("span");
  time.textContent = formatShortTime(m.sentAtMs);
  Object.assign(time.style, {
    opacity: "0.55",
    fontVariantNumeric: "tabular-nums",
  } as Partial<CSSStyleDeclaration>);
  head.appendChild(time);
  bubble.appendChild(head);

  // The message text. Always on its own row inside the bubble so a
  // one-word reply still reads as a chat message and not as "name
  // followed by inline content".
  const text = document.createElement("div");
  text.textContent = m.text;
  Object.assign(text.style, {
    fontSize: "12px",
    lineHeight: "1.35",
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
  } as Partial<CSSStyleDeclaration>);
  bubble.appendChild(text);

  row.appendChild(bubble);
  return row;
}

function formatShortTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function errorString(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Send failed";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;",
  } as Record<string, string>)[c] ?? c);
}
