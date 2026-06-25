import type { SpacetimeClient } from "../cloud/SpacetimeClient";

/**
 * Small always-visible roster panel sitting just under the
 * CameraControls box. Lists every account on the server with a
 * coloured presence dot:
 *   - 🟢 green = online (heartbeat within ~90 s)
 *   - ⚪ grey  = offline
 *
 * Sorted online-first, then alphabetical within each section, so
 * the people the player can actually interact with rise to the top.
 *
 * Live-refreshes off the cloud's notify channel (auth_record /
 * player table changes ping the listener) and also re-polls on a
 * 5 s timer so the green→grey transition happens even when no
 * other table mutation fired.
 */
export class PlayerRosterPanel {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly cloud: SpacetimeClient;
  private cloudUnsub: (() => void) | null = null;
  private tickHandle: number | null = null;
  /** Hash of the last render — skip rebuilding when nothing visible
   * changed (cheaper than diffing per-row, and the roster is small). */
  private lastSig = "";

  constructor(parent: HTMLElement, cloud: SpacetimeClient) {
    this.cloud = cloud;

    this.root = document.createElement("div");
    this.root.classList.add("cb-roster");
    Object.assign(this.root.style, {
      position: "fixed",
      // Sits directly below CameraControls (which is top:12, left:280
      // with ~4 vertical button rows ≈ 175 px tall including padding).
      // 195 leaves a 12 px gap below it without overlapping when zoom
      // / rotate / home are all stacked at max content.
      top: "195px",
      left: "280px",
      width: "max-content",
      minWidth: "120px",
      maxWidth: "180px",
      maxHeight: "calc(100vh - 220px)",
      overflowY: "auto",
      padding: "8px 10px",
      background: "rgba(20, 14, 10, 0.86)",
      color: "#fff5dc",
      font: "11px/1.3 system-ui, sans-serif",
      borderRadius: "10px",
      boxShadow: "0 4px 14px rgba(0,0,0,0.40)",
      pointerEvents: "auto",
      zIndex: "5",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const header = document.createElement("div");
    header.textContent = "PLAYERS";
    Object.assign(header.style, {
      fontSize: "9px", fontWeight: "700",
      letterSpacing: "0.08em",
      opacity: "0.6",
      marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(header);

    this.list = document.createElement("div");
    Object.assign(this.list.style, {
      display: "flex", flexDirection: "column", gap: "3px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.list);

    this.refresh();
    // Live-refresh on any cloud state mutation (catches login /
    // logout / new signup) AND on a 5 s timer (catches the
    // online→offline transition that's purely time-based — no
    // table event fires when someone's last_seen_at ages out).
    this.cloudUnsub = this.cloud.subscribe(() => this.refresh());
    this.tickHandle = window.setInterval(() => this.refresh(), 5_000);
  }

  /** Rebuild the list rows from the current roster. Cheap when
   * nothing changed — the signature check short-circuits. */
  private refresh(): void {
    const roster = this.cloud.getPlayerRoster();
    // Signature includes online flags AND display names so a name
    // change or presence flip both trigger a redraw without forcing
    // full re-render every tick.
    const sig = roster.map((r) => `${r.isOnline ? "o" : "x"}:${r.username}`).join("|");
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.list.innerHTML = "";
    if (roster.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "no accounts yet";
      Object.assign(empty.style, {
        opacity: "0.5", fontStyle: "italic", fontSize: "10px",
      } as Partial<CSSStyleDeclaration>);
      this.list.appendChild(empty);
      return;
    }
    for (const r of roster) this.list.appendChild(this.renderRow(r));
  }

  private renderRow(r: { displayName: string; isOnline: boolean; isMe: boolean; isAdmin: boolean }): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", alignItems: "center", gap: "6px",
      padding: "1px 0",
    } as Partial<CSSStyleDeclaration>);
    const dot = document.createElement("span");
    Object.assign(dot.style, {
      flex: "0 0 8px",
      width: "8px", height: "8px",
      borderRadius: "50%",
      background: r.isOnline ? "#5ac96f" : "#6a6a6a",
      // Green online dot gets a soft glow so it pops against the
      // dark panel; offline stays flat grey.
      boxShadow: r.isOnline ? "0 0 6px rgba(90, 201, 111, 0.55)" : "none",
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(dot);
    const name = document.createElement("span");
    name.textContent = r.displayName + (r.isMe ? " (you)" : "") + (r.isAdmin ? " 🛡" : "");
    Object.assign(name.style, {
      flex: "1",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      color: r.isOnline ? "#fff5dc" : "rgba(255, 245, 220, 0.55)",
      fontWeight: r.isMe ? "700" : "500",
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(name);
    return row;
  }

  destroy(): void {
    if (this.cloudUnsub) { this.cloudUnsub(); this.cloudUnsub = null; }
    if (this.tickHandle !== null) { window.clearInterval(this.tickHandle); this.tickHandle = null; }
    try { this.root.remove(); } catch { /* already gone */ }
  }
}
