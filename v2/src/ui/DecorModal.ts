import type { Game } from "../game/Game";
import { RESTAURANT_THEMES } from "../data/themes";
import { WorldScene } from "../scene/WorldScene";

/**
 * Interior-theme picker as a modal (was DecorPanel). Click outside
 * or the X to close. Each theme row shows two color swatches, name,
 * description, and price; clicking an unlocked one buys + applies.
 *
 * Multi-storey: a row of floor tabs at the top selects which storey
 * the chosen theme applies to. The tab opens to the currently focused
 * storey by default so the player edits the floor they're looking at.
 * Locked floors (tier-gated) show their tab disabled with 🔒.
 */

export class DecorModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly body: HTMLElement;
  /** Storey index currently being edited. Defaults to ground floor and
   * is re-set to the focused storey every time the modal opens. */
  private activeFloor = 0;
  /** Optional source for the focused storey so the modal opens on the
   * floor the camera is looking at. Engine wires this. */
  getFocusedStorey?: () => number;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
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

    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "min(480px, calc(100vw - 40px))",
      maxHeight: "84vh",
      display: "flex", flexDirection: "column",
      padding: "18px 22px",
      background: "rgba(28, 20, 14, 0.96)",
      color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "INTERIOR THEME";
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
    body.appendChild(header);

    // Floor tab row — one button per storey. Locked storeys (tier-gated)
    // are visually disabled but still rendered so the player knows the
    // floor is coming.
    this.tabsEl = document.createElement("div");
    Object.assign(this.tabsEl.style, {
      display: "flex", flexDirection: "row", gap: "4px",
      marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.tabsEl);

    this.body = document.createElement("div");
    Object.assign(this.body.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.body);
  }

  show(): void {
    // Default-open on the storey the camera is focused on so the player
    // edits the floor they're looking at.
    this.activeFloor = Math.max(0, this.getFocusedStorey?.() ?? 0);
    this.refresh();
    this.root.style.display = "flex";
  }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.renderTabs();
    this.renderThemeList();
  }

  private renderTabs(): void {
    this.tabsEl.innerHTML = "";
    const n = WorldScene.getNumStoreys();
    const tier = this.game.getLuxuryTier();
    for (let idx = 0; idx < n; idx += 1) {
      const unlocked = idx === 0 || tier >= idx + 1;
      const isActive = idx === this.activeFloor;
      const btn = document.createElement("button");
      const label = idx === 0 ? "G" : String(idx);
      btn.textContent = unlocked ? label : "🔒";
      btn.title = unlocked
        ? (idx === 0 ? "Ground floor" : `Floor ${idx}`)
        : `Floor ${idx} — unlocks at tier ${idx + 1}`;
      btn.disabled = !unlocked;
      Object.assign(btn.style, {
        flex: "1", padding: "6px 0",
        background: isActive
          ? "rgba(255, 210, 120, 0.45)"
          : "rgba(120, 180, 200, 0.18)",
        color: isActive ? "#fffff0" : "#fff5dc",
        border: isActive
          ? "1px solid rgba(255, 220, 150, 0.85)"
          : "1px solid rgba(255,245,220,0.22)",
        borderRadius: "6px",
        cursor: unlocked ? "pointer" : "not-allowed",
        opacity: unlocked ? "1" : "0.45",
        font: "inherit", fontSize: "13px", fontWeight: "700",
      } as Partial<CSSStyleDeclaration>);
      if (unlocked) {
        btn.onclick = () => { this.activeFloor = idx; this.refresh(); };
      }
      this.tabsEl.appendChild(btn);
    }
  }

  private renderThemeList(): void {
    this.body.innerHTML = "";
    const current = this.game.getThemeForFloor(this.activeFloor);
    const luxuryTier = this.game.getLuxuryTier();
    // Lowest tier first so the progression reads top → bottom, like the
    // build menu's tier tabs.
    const themes = [...RESTAURANT_THEMES].sort((a, b) => a.tier - b.tier || a.cost - b.cost);
    for (const theme of themes) {
      const row = document.createElement("div");
      const active = theme.id === current.id;
      const locked = theme.tier > luxuryTier;
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "9px",
        padding: "8px 10px", marginBottom: "4px",
        background: active ? "rgba(120, 200, 120, 0.18)" : "rgba(255,245,220,0.06)",
        borderRadius: "6px",
        cursor: active || locked ? "default" : "pointer",
        border: active ? "1px solid rgba(120, 200, 120, 0.5)" : "1px solid transparent",
        opacity: locked ? "0.5" : "1",
      } as Partial<CSSStyleDeclaration>);
      // Tier badge — matches the build-menu T1–T5 language.
      const tierBadge = document.createElement("span");
      tierBadge.textContent = `T${theme.tier}`;
      Object.assign(tierBadge.style, {
        fontSize: "10px", fontWeight: "700", padding: "3px 5px",
        borderRadius: "4px", background: "rgba(255,210,120,0.22)",
        color: "#ffe6b0", minWidth: "20px", textAlign: "center", flex: "0 0 auto",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(tierBadge);
      const wallSw = document.createElement("span");
      Object.assign(wallSw.style, {
        display: "inline-block", width: "14px", height: "20px",
        background: `#${theme.wallColor.toString(16).padStart(6, "0")}`,
        border: "1px solid rgba(0,0,0,0.3)",
      } as Partial<CSSStyleDeclaration>);
      const floorSw = document.createElement("span");
      Object.assign(floorSw.style, {
        display: "inline-block", width: "14px", height: "20px",
        background: `#${theme.floorColor.toString(16).padStart(6, "0")}`,
        border: "1px solid rgba(0,0,0,0.3)",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(wallSw); row.appendChild(floorSw);
      const text = document.createElement("div");
      Object.assign(text.style, { flex: "1" } as Partial<CSSStyleDeclaration>);
      const name = document.createElement("div");
      name.textContent = theme.name + (active ? "  ✓" : "");
      name.style.fontWeight = active ? "700" : "500";
      const desc = document.createElement("div");
      desc.textContent = theme.description;
      Object.assign(desc.style, { fontSize: "11px", opacity: "0.75" } as Partial<CSSStyleDeclaration>);
      text.appendChild(name); text.appendChild(desc);
      // Appeal line — attraction (spawn rate) + rating, like decoration items.
      const bits: string[] = [];
      if (theme.attractionBonus > 0) bits.push(`✨ +${theme.attractionBonus} appeal`);
      if (theme.ratingBonus > 0) bits.push(`★ +${theme.ratingBonus.toFixed(2)} rating`);
      if (bits.length) {
        const appeal = document.createElement("div");
        appeal.textContent = bits.join("    ");
        Object.assign(appeal.style, { fontSize: "10px", opacity: "0.9", color: "#ffe0a0", marginTop: "2px" } as Partial<CSSStyleDeclaration>);
        text.appendChild(appeal);
      }
      row.appendChild(text);
      const price = document.createElement("span");
      price.textContent = locked
        ? `🔒 T${theme.tier}`
        : active ? "—" : theme.cost === 0 ? "free" : `$${theme.cost}`;
      Object.assign(price.style, { fontSize: "12px", opacity: "0.85", minWidth: "46px", textAlign: "right", flex: "0 0 auto" } as Partial<CSSStyleDeclaration>);
      if (locked) price.title = `Unlocks at luxury tier ${theme.tier}`;
      row.appendChild(price);
      if (!active && !locked) {
        const can = theme.cost === 0 || this.game.economy.canAfford(theme.cost);
        if (!can) {
          row.style.opacity = "0.4";
          row.style.cursor = "not-allowed";
        } else {
          row.onclick = () => {
            if (this.game.applyTheme(this.activeFloor, theme.id)) this.refresh();
          };
        }
      }
      this.body.appendChild(row);
    }
  }
}
