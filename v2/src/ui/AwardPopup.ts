import type { Achievement } from "../game/AchievementSystem";

/**
 * AwardPopup — the celebratory card shown the moment an award is WON. It
 * explains what the player did (name + description) and what they won (the cash
 * reward), with a Claim button. Awards are NOT auto-granted: the reward is paid
 * only when the player claims it here (or later from the Awards panel).
 * Dismissing with "Later" / ✕ leaves the award claimable in the panel.
 *
 * Several awards can unlock in the same tick, so they QUEUE and show one at a
 * time — claim or dismiss advances to the next.
 */
export class AwardPopup {
  private readonly root: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly descEl: HTMLElement;
  private readonly rewardEl: HTMLElement;
  private readonly claimBtn: HTMLButtonElement;
  private readonly queueTag: HTMLElement;
  private queue: Achievement[] = [];
  private current: Achievement | null = null;

  constructor(parent: HTMLElement, private readonly onClaim: (a: Achievement) => void) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", inset: "0", display: "none",
      alignItems: "center", justifyContent: "center",
      background: "rgba(8,5,3,0.55)", zIndex: "2000", padding: "20px",
    } as Partial<CSSStyleDeclaration>);
    // Tapping the dim backdrop = "Later" (keeps it claimable in the panel).
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.dismiss(); });
    parent.appendChild(this.root);

    const card = document.createElement("div");
    Object.assign(card.style, {
      boxSizing: "border-box", width: "100%", maxWidth: "340px",
      background: "linear-gradient(180deg, rgba(44,32,18,0.98), rgba(30,22,14,0.98))",
      color: "#fff5dc", border: "2px solid #e8c07a", borderRadius: "14px",
      padding: "22px 22px 18px", textAlign: "center",
      font: "13px/1.5 system-ui, sans-serif",
      boxShadow: "0 16px 48px rgba(0,0,0,0.65), 0 0 0 4px rgba(232,192,122,0.12)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(card);

    const trophy = document.createElement("div");
    trophy.textContent = "🏆";
    Object.assign(trophy.style, { fontSize: "44px", lineHeight: "1", marginBottom: "6px" } as Partial<CSSStyleDeclaration>);
    card.appendChild(trophy);

    const kicker = document.createElement("div");
    kicker.textContent = "AWARD UNLOCKED";
    Object.assign(kicker.style, {
      fontSize: "10px", fontWeight: "700", letterSpacing: "0.18em",
      color: "#e8c07a", marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(kicker);

    this.nameEl = document.createElement("div");
    Object.assign(this.nameEl.style, {
      fontSize: "19px", fontWeight: "800", color: "#ffe6a8", marginBottom: "6px",
      textWrap: "balance",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.nameEl);

    this.descEl = document.createElement("div");
    Object.assign(this.descEl.style, { opacity: "0.9", marginBottom: "14px" } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.descEl);

    this.rewardEl = document.createElement("div");
    Object.assign(this.rewardEl.style, {
      fontSize: "15px", fontWeight: "800", color: "#a8e2a8", marginBottom: "16px",
      fontVariantNumeric: "tabular-nums",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.rewardEl);

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, { display: "flex", gap: "8px" } as Partial<CSSStyleDeclaration>);

    const later = document.createElement("button");
    later.textContent = "Later";
    Object.assign(later.style, {
      flex: "0 0 auto", minHeight: "46px", padding: "10px 16px", borderRadius: "9px",
      fontWeight: "700", fontSize: "13px", cursor: "pointer",
      border: "1px solid rgba(255,245,220,0.28)", background: "transparent", color: "#fff5dc",
    } as Partial<CSSStyleDeclaration>);
    later.onclick = () => this.dismiss();
    btnRow.appendChild(later);

    this.claimBtn = document.createElement("button");
    Object.assign(this.claimBtn.style, {
      flex: "1", minHeight: "46px", padding: "10px 16px", borderRadius: "9px",
      fontWeight: "800", fontSize: "14px", cursor: "pointer", border: "none",
      background: "linear-gradient(180deg, #ffd472, #f0b43c)", color: "#3a2708",
      boxShadow: "0 3px 10px rgba(240,180,60,0.35)",
    } as Partial<CSSStyleDeclaration>);
    this.claimBtn.onclick = () => this.claimCurrent();
    btnRow.appendChild(this.claimBtn);
    card.appendChild(btnRow);

    // "+2 more" tag when several awards are queued behind this one.
    this.queueTag = document.createElement("div");
    Object.assign(this.queueTag.style, {
      fontSize: "10px", opacity: "0.6", marginTop: "10px", display: "none",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.queueTag);
  }

  /** Queue an award to celebrate; shows immediately if nothing is up. */
  enqueue(a: Achievement): void {
    this.queue.push(a);
    if (!this.current) this.showNext();
    else this.syncQueueTag();
  }

  private showNext(): void {
    this.current = this.queue.shift() ?? null;
    if (!this.current) { this.root.style.display = "none"; return; }
    const a = this.current;
    const reward = a.cashReward ?? 0;
    this.nameEl.textContent = a.name;
    this.descEl.textContent = a.description;
    this.rewardEl.textContent = reward > 0 ? `Reward:  +$${reward.toLocaleString("en-US")}` : "";
    this.rewardEl.style.display = reward > 0 ? "block" : "none";
    this.claimBtn.textContent = reward > 0 ? `Claim +$${reward.toLocaleString("en-US")}` : "Claim";
    this.syncQueueTag();
    this.root.style.display = "flex";
  }

  private syncQueueTag(): void {
    const n = this.queue.length;
    this.queueTag.textContent = n > 0 ? `+${n} more award${n === 1 ? "" : "s"} to review` : "";
    this.queueTag.style.display = n > 0 ? "block" : "none";
  }

  private claimCurrent(): void {
    if (this.current) this.onClaim(this.current);
    this.showNext();
  }

  /** Dismiss without claiming — the award stays claimable in the panel. */
  private dismiss(): void {
    this.showNext();
  }
}
