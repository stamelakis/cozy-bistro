/**
 * Single scrollable left-side panel that hosts the HUD, ExpandWidget,
 * StockStatusWidget, and StaffPanel as stacked sections inside one chrome.
 *
 * Engine constructs a Sidebar first, then passes `sidebar.body` to each
 * widget so they mount their content inline. The widgets themselves
 * draw no background / position — Sidebar owns all of that.
 */
export class Sidebar {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  /** Always-visible save indicator pinned to the panel footer. Engine
   * polls this and updates the text every HUD tick. */
  readonly saveStatus: HTMLElement;
  /** Manual save button right next to the indicator. Engine wires its
   * onclick to fire SaveSystem.saveNow(). */
  readonly saveNowBtn: HTMLButtonElement;
  /** Live spawner diagnostic line (above the save footer). Engine pushes
   * `customers · functional seats · spawn in Ts` into here so the player
   * can see at a glance whether the room is alive. */
  readonly spawnerStatus: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      left: "12px",
      bottom: "12px",
      width: "256px",
      // Solid panel chrome shared across all sections.
      background: "rgba(20, 14, 10, 0.86)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "10px",
      pointerEvents: "auto",
      boxShadow: "0 4px 18px rgba(0,0,0,0.40)",
      // Scroll the body if the four sections together exceed viewport.
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      // Phase I (UX) — explicit z-index so status bubbles can't bleed
      // through.  Matches ChatPanel + MenuPanel (100).  All side / HUD
      // panels need to sit above the bubble layer.
      zIndex: "100",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    this.body = document.createElement("div");
    Object.assign(this.body.style, {
      flex: "1 1 auto",
      overflowY: "auto",
      padding: "10px 12px",
      // Each section adds its own marginTop separator border, except the
      // first. Sidebar.appendSection adds the separator helper.
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);

    // Pinned spawner diagnostic strip — sits just above the save footer.
    this.spawnerStatus = document.createElement("div");
    Object.assign(this.spawnerStatus.style, {
      flex: "0 0 auto",
      padding: "5px 10px",
      borderTop: "1px solid rgba(255,245,220,0.10)",
      background: "rgba(0,0,0,0.10)",
      fontSize: "10px",
      lineHeight: "1.35",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    this.spawnerStatus.textContent = "👥 waiting on world…";
    this.root.appendChild(this.spawnerStatus);

    // Pinned footer: save status + manual save button. Always visible so
    // the player can verify autosave is actually running.
    const footer = document.createElement("div");
    Object.assign(footer.style, {
      flex: "0 0 auto",
      display: "flex", alignItems: "center", gap: "6px",
      padding: "6px 10px",
      borderTop: "1px solid rgba(255,245,220,0.18)",
      background: "rgba(0,0,0,0.18)",
      fontSize: "10px",
    } as Partial<CSSStyleDeclaration>);
    this.saveStatus = document.createElement("span");
    Object.assign(this.saveStatus.style, {
      flex: "1", opacity: "0.85",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    this.saveStatus.textContent = "💾 Not saved yet";
    footer.appendChild(this.saveStatus);
    this.saveNowBtn = document.createElement("button");
    this.saveNowBtn.textContent = "Save now";
    Object.assign(this.saveNowBtn.style, {
      padding: "3px 8px",
      background: "rgba(120, 180, 200, 0.22)", color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.30)", borderRadius: "4px",
      cursor: "pointer", font: "inherit", fontSize: "10px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    footer.appendChild(this.saveNowBtn);
    this.root.appendChild(footer);
  }

  /** Render the spawner diagnostic line. Color flips amber if no spawn
   * is happening despite seats existing, red if seats are zero, green
   * when customers are present. Surfaces tables/chairs counts so we can
   * tell whether the issue is "no items in registry" vs "items present
   * but chairs not at slots". */
  updateSpawnerStatus(stats: {
    customers: number;
    waiting: number;
    seatsAvail: number;
    seatsTotal: number;
    overflow: number;
    spawnInSec: number;
    open: boolean;
    tables: number;
    chairs: number;
    rawSlots: number;
    hasRegistry: boolean;
  }): void {
    if (!stats.hasRegistry) {
      this.spawnerStatus.textContent = "⚠ no registry wired to spawner";
      this.spawnerStatus.style.color = "#ff9a9a";
      this.spawnerStatus.style.opacity = "1";
      return;
    }
    if (!stats.open) {
      this.spawnerStatus.textContent = "🔒 closed — no spawning";
      this.spawnerStatus.style.color = "#fff5dc";
      this.spawnerStatus.style.opacity = "0.6";
      return;
    }
    this.spawnerStatus.style.opacity = "1";
    const parts: string[] = [];
    parts.push(`👥 ${stats.customers}${stats.waiting > 0 ? `+${stats.waiting}🪑` : ""}`);
    parts.push(`💺 ${stats.seatsAvail}/${stats.seatsTotal}`);
    parts.push(`🪑${stats.chairs}|🏠${stats.tables}|◯${stats.rawSlots}`);
    parts.push(`⏱ ${Math.max(0, stats.spawnInSec).toFixed(1)}s`);
    this.spawnerStatus.textContent = parts.join(" · ");
    this.spawnerStatus.style.color =
      stats.seatsTotal === 0 ? "#ff9a9a" :
      stats.customers === 0 && stats.waiting === 0 ? "#ffd47a" :
      "#a8e2a8";
  }

  /** Refresh the pinned save indicator from a stats snapshot. Called by
   * Engine on every HUD tick. */
  updateSaveStatus(stats: { count: number; lastMs: number; bytes: number; ok: boolean; error: string; slot: number }): void {
    if (!stats.ok) {
      this.saveStatus.textContent = `⚠ Save failed: ${stats.error}`.slice(0, 48);
      this.saveStatus.style.color = "#ff9a9a";
      return;
    }
    if (stats.count === 0) {
      this.saveStatus.textContent = "💾 Not saved yet";
      this.saveStatus.style.color = "#fff5dc";
      return;
    }
    const ageS = Math.max(0, Math.round((Date.now() - stats.lastMs) / 1000));
    const ageStr = ageS < 60 ? `${ageS}s` : ageS < 3600 ? `${Math.round(ageS / 60)}m` : `${Math.round(ageS / 3600)}h`;
    const kb = (stats.bytes / 1024).toFixed(1);
    this.saveStatus.textContent = `💾 Slot ${stats.slot} · ${ageStr} ago · ${kb} KB`;
    this.saveStatus.style.color = ageS > 30 ? "#ffd47a" : "#a8e2a8";
  }

  /** Helper: add a thin separator before the next section. Call between
   * sections from Engine after constructing each widget. */
  addSeparator(): void {
    const sep = document.createElement("div");
    Object.assign(sep.style, {
      borderTop: "1px solid rgba(255,245,220,0.14)",
      margin: "8px -12px",
    } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(sep);
  }
}
