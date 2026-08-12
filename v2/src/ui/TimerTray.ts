/**
 * Patch A — Timer tray. A compact fixed column (top-right) listing every
 * ACTIVE long-running timer — recipe upgrade, staff training, supply-crate
 * cooldown — with a live countdown. Clicking a chip jumps to the owning
 * panel (Upgrades / Staff / the crate button) so "what was I waiting on?"
 * is always one glance + one click away.
 *
 * Data-agnostic: Engine supplies a provider that reads the SERVER-
 * authoritative timers from the SpacetimeClient subscription cache each
 * refresh — this class only renders. Call update() at ~1 Hz; it hides
 * itself entirely when no timer is running.
 */

export interface TimerItem {
  /** Emoji lead-in, e.g. "⚡" for an upgrade, "🎓" training, "🎁" crate. */
  icon: string;
  /** Short label, e.g. "Herb Soup → Lv3" or "Maria → Lv2". */
  label: string;
  /** Seconds remaining (<= 0 renders as "done!"). */
  remainingS: number;
  onClick?: () => void;
}

export class TimerTray {
  private readonly root: HTMLDivElement;
  private readonly provider: () => TimerItem[];

  constructor(host: HTMLElement, provider: () => TimerItem[], opts?: { hosted?: boolean }) {
    this.provider = provider;
    this.root = document.createElement("div");
    this.root.id = "cb-timer-tray";
    // Hosted (TopStrip) mode: an inline chip row inside the unified top
    // bar. Standalone mode keeps the old fixed top-center placement.
    Object.assign(this.root.style, opts?.hosted === true
      ? {
        // Right zone of the TopStrip: chips STACK vertically under the
        // bell, right-aligned — "timers on top of each other".
        display: "none",
        flexDirection: "column",
        gap: "4px",
        alignItems: "flex-end",
        pointerEvents: "none", // chips re-enable
      }
      : {
        position: "fixed",
        top: "96px", // fully below the floor selector (measured live: ends ~y=91)
        left: "50%",
        transform: "translateX(-50%)",
        display: "none",
        flexDirection: "row",
        gap: "6px",
        alignItems: "center",
        zIndex: "14",
        pointerEvents: "none", // chips re-enable
      } as Partial<CSSStyleDeclaration>);
    host.appendChild(this.root);
  }

  /** Rebuild the chip list from the provider. ~1 Hz from Engine. */
  update(): void {
    const items = this.provider();
    if (items.length === 0) {
      this.root.style.display = "none";
      this.root.replaceChildren();
      return;
    }
    this.root.style.display = "flex";
    this.root.replaceChildren();
    for (const item of items) {
      const chip = document.createElement("div");
      Object.assign(chip.style, {
        display: "flex",
        alignItems: "center",
        gap: "7px",
        background: "rgba(20, 14, 10, 0.9)",
        color: "#fff5dc",
        border: "1px solid rgba(255, 220, 150, 0.45)",
        borderRadius: "8px",
        padding: "4px 10px",
        font: "11px/1.3 system-ui, sans-serif",
        boxShadow: "0 3px 10px rgba(0, 0, 0, 0.4)",
        cursor: item.onClick ? "pointer" : "default",
        pointerEvents: "auto",
        whiteSpace: "nowrap",
      } as Partial<CSSStyleDeclaration>);
      const icon = document.createElement("span");
      icon.textContent = item.icon;
      const label = document.createElement("span");
      label.textContent = item.label;
      Object.assign(label.style, {
        maxWidth: "150px",
        overflow: "hidden",
        textOverflow: "ellipsis",
      } as Partial<CSSStyleDeclaration>);
      const time = document.createElement("span");
      time.textContent = item.remainingS <= 0 ? "done!" : fmt(item.remainingS);
      Object.assign(time.style, {
        fontWeight: "700",
        color: item.remainingS <= 0 ? "#9fe09f" : "#ffd986",
        fontVariantNumeric: "tabular-nums",
      } as Partial<CSSStyleDeclaration>);
      chip.appendChild(icon);
      chip.appendChild(label);
      chip.appendChild(time);
      if (item.onClick) {
        const go = item.onClick;
        chip.onclick = () => go();
        chip.title = "Click to open";
      }
      this.root.appendChild(chip);
    }
  }
}

function fmt(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m.toString().padStart(2, "0")}m`;
  }
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, "0")}`;
}
