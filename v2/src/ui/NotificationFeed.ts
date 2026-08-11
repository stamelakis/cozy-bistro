/**
 * Patch A — Action notification feed. A 🔔 bell (fixed bottom-right) with an
 * unread badge, a toast stack that slides in above it, and a dropdown log of
 * the recent history. Every entry can carry a jump action — clicking the
 * toast (or its log row) takes the player TO the thing: open the Upgrades
 * panel, the Pantry, glow the crate button, etc. The point is turning idle
 * watching into directed taps: "Upgrade done — tap to see."
 *
 * Purely client-side presentation. Event DETECTION lives in Engine's 1 Hz
 * feed poll (edge-triggered: fire on state transitions, never per-frame) —
 * this class only renders what it's pushed and dedupes safety-net repeats.
 *
 * Visual language mirrors uiHints.showEventBanner / ExpandWidget: dark
 * coffee panel, cream text, gold accents.
 */

export interface FeedEntry {
  /** Emoji lead-in, e.g. "🎁". */
  icon: string;
  text: string;
  /** Jump action — invoked on toast/log-row click. Optional. */
  action?: () => void;
  /** Entries pushed with the same key within dedupeMs are dropped (safety
   * net on top of the caller's own edge-triggering). */
  dedupeKey?: string;
  /** Custom dedupe window; default 4 min. */
  dedupeMs?: number;
  /** Accent color for the toast border/icon chip. Default warm gold. */
  accent?: string;
}

interface LogRow extends FeedEntry {
  at: number; // performance-independent wall time for the log timestamps
}

const TOAST_LIFE_MS = 7000;
const LOG_LIMIT = 24;
const DEFAULT_DEDUPE_MS = 4 * 60 * 1000;

export class NotificationFeed {
  private readonly bell: HTMLButtonElement;
  private readonly badge: HTMLSpanElement;
  private readonly toastStack: HTMLDivElement;
  private readonly logPanel: HTMLDivElement;
  private readonly log: LogRow[] = [];
  private readonly lastByKey = new Map<string, number>();
  private unread = 0;
  private logOpen = false;
  private reducedMotion = false;

  constructor(host: HTMLElement) {
    this.reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ── Bell ──────────────────────────────────────────────────────────
    this.bell = document.createElement("button");
    this.bell.id = "cb-notif-bell";
    this.bell.textContent = "🔔";
    this.bell.title = "Notifications";
    Object.assign(this.bell.style, {
      position: "fixed",
      right: "14px",
      bottom: "64px", // clear of the bottom MENU bar
      width: "40px",
      height: "40px",
      borderRadius: "50%",
      background: "rgba(20, 14, 10, 0.92)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.5)",
      boxShadow: "0 4px 14px rgba(0, 0, 0, 0.45)",
      font: "18px/1 system-ui, sans-serif",
      cursor: "pointer",
      zIndex: "16",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.badge = document.createElement("span");
    Object.assign(this.badge.style, {
      position: "absolute",
      top: "-4px",
      right: "-4px",
      minWidth: "16px",
      height: "16px",
      padding: "0 4px",
      borderRadius: "8px",
      background: "#e0574f",
      color: "#fff",
      font: "700 10px/16px system-ui, sans-serif",
      textAlign: "center",
      display: "none",
    } as Partial<CSSStyleDeclaration>);
    this.bell.appendChild(this.badge);
    this.bell.onclick = () => this.toggleLog();
    host.appendChild(this.bell);

    // ── Toast stack (grows upward above the bell) ─────────────────────
    this.toastStack = document.createElement("div");
    this.toastStack.id = "cb-notif-toasts";
    Object.assign(this.toastStack.style, {
      position: "fixed",
      right: "14px",
      bottom: "112px",
      display: "flex",
      flexDirection: "column-reverse", // newest nearest the bell
      gap: "6px",
      alignItems: "flex-end",
      zIndex: "16",
      pointerEvents: "none", // individual toasts re-enable
    } as Partial<CSSStyleDeclaration>);
    host.appendChild(this.toastStack);

    // ── Log dropdown ──────────────────────────────────────────────────
    this.logPanel = document.createElement("div");
    this.logPanel.id = "cb-notif-log";
    Object.assign(this.logPanel.style, {
      position: "fixed",
      right: "14px",
      bottom: "112px",
      width: "min(320px, calc(100vw - 28px))",
      maxHeight: "46vh",
      overflowY: "auto",
      background: "rgba(20, 14, 10, 0.96)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.5)",
      borderRadius: "10px",
      boxShadow: "0 6px 22px rgba(0, 0, 0, 0.55)",
      font: "12px/1.45 system-ui, sans-serif",
      padding: "6px",
      display: "none",
      zIndex: "17",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    host.appendChild(this.logPanel);
  }

  /** Push a notification: toast + log + unread badge. Deduped by key. */
  push(e: FeedEntry): void {
    const now = Date.now();
    if (e.dedupeKey) {
      const last = this.lastByKey.get(e.dedupeKey) ?? 0;
      if (now - last < (e.dedupeMs ?? DEFAULT_DEDUPE_MS)) return;
      this.lastByKey.set(e.dedupeKey, now);
    }
    this.log.unshift({ ...e, at: now });
    if (this.log.length > LOG_LIMIT) this.log.pop();
    if (!this.logOpen) {
      this.unread += 1;
      this.paintBadge();
    } else {
      this.paintLog();
    }
    this.spawnToast(e);
  }

  /** Explicitly clear a dedupe key so a re-armed state can notify again
   * (e.g. crate claimed → "ready" may fire on the NEXT cooldown lapse). */
  resetDedupe(key: string): void {
    this.lastByKey.delete(key);
  }

  private spawnToast(e: FeedEntry): void {
    const t = document.createElement("div");
    const accent = e.accent ?? "rgba(255, 220, 150, 0.85)";
    Object.assign(t.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      maxWidth: "min(320px, calc(100vw - 28px))",
      background: "rgba(20, 14, 10, 0.94)",
      color: "#fff5dc",
      border: `1px solid ${accent}`,
      borderRadius: "9px",
      padding: "7px 11px",
      font: "12px/1.35 system-ui, sans-serif",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
      cursor: e.action ? "pointer" : "default",
      pointerEvents: "auto",
      opacity: this.reducedMotion ? "1" : "0",
      transform: this.reducedMotion ? "none" : "translateX(14px)",
      transition: this.reducedMotion ? "none" : "opacity 0.22s ease, transform 0.22s ease",
    } as Partial<CSSStyleDeclaration>);
    const icon = document.createElement("span");
    icon.textContent = e.icon;
    icon.style.fontSize = "16px";
    const txt = document.createElement("span");
    txt.textContent = e.text;
    t.appendChild(icon);
    t.appendChild(txt);
    if (e.action) {
      const go = e.action;
      t.onclick = () => {
        go();
        dismiss();
      };
      t.title = "Click to view";
    }
    this.toastStack.appendChild(t);
    if (!this.reducedMotion) {
      requestAnimationFrame(() => {
        t.style.opacity = "1";
        t.style.transform = "translateX(0)";
      });
    }
    let gone = false;
    const dismiss = (): void => {
      if (gone) return;
      gone = true;
      if (this.reducedMotion) { t.remove(); return; }
      t.style.opacity = "0";
      t.style.transform = "translateX(14px)";
      window.setTimeout(() => t.remove(), 240);
    };
    window.setTimeout(dismiss, TOAST_LIFE_MS);
  }

  private toggleLog(): void {
    this.logOpen = !this.logOpen;
    this.logPanel.style.display = this.logOpen ? "block" : "none";
    if (this.logOpen) {
      this.unread = 0;
      this.paintBadge();
      this.paintLog();
    }
  }

  private paintBadge(): void {
    this.badge.style.display = this.unread > 0 ? "block" : "none";
    this.badge.textContent = this.unread > 9 ? "9+" : String(this.unread);
  }

  private paintLog(): void {
    this.logPanel.replaceChildren();
    if (this.log.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "Nothing yet — events land here.";
      Object.assign(empty.style, { opacity: "0.6", padding: "8px" } as Partial<CSSStyleDeclaration>);
      this.logPanel.appendChild(empty);
      return;
    }
    for (const row of this.log) {
      const r = document.createElement("div");
      Object.assign(r.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 6px",
        borderRadius: "6px",
        cursor: row.action ? "pointer" : "default",
      } as Partial<CSSStyleDeclaration>);
      r.onmouseenter = () => { r.style.background = "rgba(255, 245, 220, 0.07)"; };
      r.onmouseleave = () => { r.style.background = "transparent"; };
      const icon = document.createElement("span");
      icon.textContent = row.icon;
      const txt = document.createElement("span");
      txt.textContent = row.text;
      txt.style.flex = "1";
      const when = document.createElement("span");
      const ageS = Math.max(0, Math.round((Date.now() - row.at) / 1000));
      when.textContent = ageS < 60 ? `${ageS}s` : ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`;
      Object.assign(when.style, { opacity: "0.5", fontSize: "10px" } as Partial<CSSStyleDeclaration>);
      r.appendChild(icon);
      r.appendChild(txt);
      r.appendChild(when);
      if (row.action) {
        const go = row.action;
        r.onclick = () => {
          go();
          this.toggleLog();
        };
      }
      this.logPanel.appendChild(r);
    }
  }
}
