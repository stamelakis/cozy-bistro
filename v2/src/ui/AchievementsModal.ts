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
  /** Engine wires this to grant the reward + persist the claim. */
  private readonly onClaim: (a: Achievement) => void;
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;

  constructor(parent: HTMLElement, game: Game, onClaim: (a: Achievement) => void) {
    this.game = game;
    this.onClaim = onClaim;
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
  /** True while the panel is on-screen — Engine skips a redundant rebuild
   * when a claim happens from the win popup with the panel closed. */
  isOpen(): boolean { return this.root.style.display !== "none"; }

  refresh(): void {
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
   * with a trophy + gold name; locked entries dimmed with a padlock.
   * H.100 — show the cash prize on the right side; pre-unlock it's
   * dimmed ("how much you'll earn"), post-unlock it shows "claimed". */
  private buildRow(a: Achievement): HTMLElement {
    const unlocked = this.game.achievements.isUnlocked(a.id);
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      gap: "10px",
      padding: "6px 6px",
      borderBottom: "1px solid rgba(255,245,220,0.06)",
      opacity: unlocked ? "1" : "0.45",
      alignItems: "center",
    } as Partial<CSSStyleDeclaration>);
    const icon = document.createElement("span");
    icon.textContent = unlocked ? "🏆" : "🔒";
    Object.assign(icon.style, { fontSize: "18px", flex: "0 0 24px" } as Partial<CSSStyleDeclaration>);
    row.appendChild(icon);
    const text = document.createElement("div");
    Object.assign(text.style, { flex: "1", minWidth: "0" } as Partial<CSSStyleDeclaration>);
    const name = document.createElement("div");
    name.textContent = a.name;
    Object.assign(name.style, { fontWeight: "700", fontSize: "12px", color: unlocked ? "#ffd986" : undefined } as Partial<CSSStyleDeclaration>);
    const desc = document.createElement("div");
    desc.textContent = a.description;
    Object.assign(desc.style, { fontSize: "11px", opacity: "0.85" } as Partial<CSSStyleDeclaration>);
    text.appendChild(name);
    text.appendChild(desc);
    row.appendChild(text);

    // H.100 — Prize chip on the right.  Color-codes by reward size so
    // T1-T2 read as small flavor bonuses while T6-T7 stand out as
    // genuine milestones. Strikethrough + "claimed" tag once unlocked,
    // since the cash is already in the till.
    const reward = a.cashReward ?? 0;
    const claimed = this.game.achievements.isClaimed(a.id);
    const bgByTier =
      reward >= 50_000 ? "rgba(255,200,90,0.40)" : // T7 gold
      reward >= 15_000 ? "rgba(255,180,90,0.32)" : // T6
      reward >=  5_000 ? "rgba(170,200,255,0.25)" : // T5 blue
      reward >=  1_500 ? "rgba(170,200,255,0.18)" : // T4
      reward >=    500 ? "rgba(140,210,140,0.18)" : // T3 green
      reward >=    150 ? "rgba(140,210,140,0.12)" : // T2
                         "rgba(255,255,255,0.08)";  // T1
    if (unlocked && !claimed) {
      // WON but not claimed → a live Claim button + gold row highlight so it
      // reads as actionable. Rewards are only paid when the player claims.
      const claimBtn = document.createElement("button");
      claimBtn.textContent = reward > 0 ? `Claim +$${reward.toLocaleString("en-US")}` : "Claim";
      Object.assign(claimBtn.style, {
        flex: "0 0 auto", padding: "6px 12px", borderRadius: "9px",
        fontWeight: "800", fontSize: "11px", cursor: "pointer", border: "none",
        background: "linear-gradient(180deg, #ffd472, #f0b43c)", color: "#3a2708",
        whiteSpace: "nowrap", boxShadow: "0 2px 6px rgba(240,180,60,0.35)",
      } as Partial<CSSStyleDeclaration>);
      claimBtn.onclick = () => { this.onClaim(a); this.refresh(); };
      row.appendChild(claimBtn);
      row.style.background = "rgba(240,190,80,0.10)";
      row.style.borderRadius = "6px";
    } else if (reward > 0) {
      // Locked (preview the prize, dimmed) OR claimed (struck-through + ✓).
      const prize = document.createElement("div");
      prize.textContent = claimed ? `+$${reward.toLocaleString("en-US")} ✓` : `+$${reward.toLocaleString("en-US")}`;
      prize.title = claimed
        ? `Claimed — $${reward.toLocaleString("en-US")} paid out.`
        : `Cash reward — unlock this, then claim it.`;
      Object.assign(prize.style, {
        fontSize: "11px", fontWeight: "700", padding: "3px 8px", borderRadius: "10px",
        background: bgByTier, color: claimed ? "#a8e2a8" : "#fff5dc",
        flex: "0 0 auto", fontVariantNumeric: "tabular-nums",
        textDecoration: claimed ? "line-through" : "none",
        opacity: claimed ? "0.7" : "1", whiteSpace: "nowrap",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(prize);
    } else if (claimed) {
      // Reward-less award, collected.
      const done = document.createElement("span");
      done.textContent = "✓";
      Object.assign(done.style, {
        color: "#a8e2a8", fontWeight: "800", flex: "0 0 auto", opacity: "0.8", fontSize: "13px",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(done);
    }
    return row;
  }
}
