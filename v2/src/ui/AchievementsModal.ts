import type { Game } from "../game/Game";
import { ACHIEVEMENTS, type Achievement, type AchievementCategory } from "../game/AchievementSystem";

/** Player-facing labels for each category — order also drives the
 * section order in the modal (intro first, big-ticket cash + days
 * up top, the system-specific sections below). */
const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  intro:     "Getting Started",
  cash:      "Cash",
  days:      "Days Survived",
  customers: "Customers Served",
  rating:    "Reputation",
  tier:      "Restaurant Tier",
  staff:     "Staff",
  training:  "Training",
  menu:      "Menu",
  pantry:    "Pantry",
  build:     "Build",
  decor:     "Decor",
  dishware:  "Dishware",
  social:    "Social",
  weather:   "Weather",
  boost:     "Boost",
};

const CATEGORY_ORDER: AchievementCategory[] = [
  "intro", "cash", "days", "customers", "rating", "tier",
  "staff", "training", "menu", "pantry", "build", "decor",
  "dishware", "social", "weather", "boost",
];

/**
 * Achievements browser — full list with unlocked / locked state, plus a
 * count badge at the top. Pure presentation; the actual unlock detection
 * runs in AchievementSystem on a 1s tick.
 */

export class AchievementsModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "0", left: "0",
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
      width: "min(520px, calc(100vw - 40px))",
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
    title.textContent = "ACHIEVEMENTS";
    Object.assign(title.style, { fontSize: "16px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    this.countEl = document.createElement("span");
    Object.assign(this.countEl.style, { opacity: "0.7", fontSize: "12px", flex: "1", textAlign: "right", marginRight: "10px" } as Partial<CSSStyleDeclaration>);
    header.appendChild(this.countEl);
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

    this.listEl = document.createElement("div");
    Object.assign(this.listEl.style, { flex: "1", overflowY: "auto" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.listEl);
  }

  show(): void { this.refresh(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.countEl.textContent = `${this.game.achievements.count()} / ${this.game.achievements.total()} unlocked`;
    this.listEl.innerHTML = "";
    // Bucket achievements by category so we can render section
    // headers with per-section progress (3/8 unlocked …) ahead of
    // each group. Each bucket stays in the source-file order
    // (which is roughly easy → hard), so within a section the
    // entry-level milestone shows up first.
    const buckets = new Map<AchievementCategory, Achievement[]>();
    for (const a of ACHIEVEMENTS) {
      const arr = buckets.get(a.category) ?? [];
      arr.push(a);
      buckets.set(a.category, arr);
    }
    for (const cat of CATEGORY_ORDER) {
      const list = buckets.get(cat);
      if (!list || list.length === 0) continue;
      const unlockedInCat = list.filter((a) => this.game.achievements.isUnlocked(a.id)).length;
      // Section header — name + N/M badge so the player can see at a
      // glance which pillars they've barely touched.
      const sectionHeader = document.createElement("div");
      Object.assign(sectionHeader.style, {
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        marginTop: "16px", marginBottom: "4px",
        paddingBottom: "4px",
        borderBottom: "1px solid rgba(255,245,220,0.20)",
      } as Partial<CSSStyleDeclaration>);
      const sectionTitle = document.createElement("span");
      sectionTitle.textContent = CATEGORY_LABELS[cat] ?? cat;
      Object.assign(sectionTitle.style, {
        fontSize: "13px", fontWeight: "700",
        letterSpacing: "0.05em", textTransform: "uppercase",
        color: "#ffd986",
      } as Partial<CSSStyleDeclaration>);
      sectionHeader.appendChild(sectionTitle);
      const sectionCount = document.createElement("span");
      sectionCount.textContent = `${unlockedInCat} / ${list.length}`;
      Object.assign(sectionCount.style, {
        fontSize: "11px", opacity: "0.65",
        fontVariantNumeric: "tabular-nums",
      } as Partial<CSSStyleDeclaration>);
      sectionHeader.appendChild(sectionCount);
      this.listEl.appendChild(sectionHeader);
      for (const a of list) this.listEl.appendChild(this.buildRow(a));
    }
  }

  /** Build a single achievement row. Unlocked entries fully opaque
   * with a trophy + gold name; locked entries dimmed with a padlock. */
  private buildRow(a: Achievement): HTMLElement {
    const unlocked = this.game.achievements.isUnlocked(a.id);
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      gap: "10px",
      padding: "6px 6px",
      borderBottom: "1px solid rgba(255,245,220,0.06)",
      opacity: unlocked ? "1" : "0.45",
    } as Partial<CSSStyleDeclaration>);
    const icon = document.createElement("span");
    icon.textContent = unlocked ? "🏆" : "🔒";
    Object.assign(icon.style, { fontSize: "18px", flex: "0 0 24px" } as Partial<CSSStyleDeclaration>);
    row.appendChild(icon);
    const text = document.createElement("div");
    Object.assign(text.style, { flex: "1" } as Partial<CSSStyleDeclaration>);
    const name = document.createElement("div");
    name.textContent = a.name;
    Object.assign(name.style, { fontWeight: "700", fontSize: "12px", color: unlocked ? "#ffd986" : undefined } as Partial<CSSStyleDeclaration>);
    const desc = document.createElement("div");
    desc.textContent = a.description;
    Object.assign(desc.style, { fontSize: "11px", opacity: "0.85" } as Partial<CSSStyleDeclaration>);
    text.appendChild(name);
    text.appendChild(desc);
    row.appendChild(text);
    return row;
  }
}
