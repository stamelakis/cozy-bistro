import type { Game } from "../game/Game";
import type { StaffRole } from "../systems/StaffSystem";
import { WorldScene } from "../scene/WorldScene";
import { attachTooltip } from "./tooltip";

/**
 * Enlarged staff panel with per-role activity badges + payroll summary.
 *
 * Per row: role label · count · working/idle badges · hire (+ cost) ·
 * fire (- severance).
 *
 * Footer: total payroll/min and total hire cost for next reinforcement.
 */
export class StaffPanel {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly rows: Record<StaffRole, {
    label: HTMLElement; activity: HTMLElement;
    hire: HTMLButtonElement; fire: HTMLButtonElement;
    members: HTMLElement;
  }> = {} as Record<StaffRole, { label: HTMLElement; activity: HTMLElement; hire: HTMLButtonElement; fire: HTMLButtonElement; members: HTMLElement }>;
  private payrollLine?: HTMLElement;
  /** Fired when the player reassigns a member to a new home floor.
   * Engine wires this to WorldScene.relocateStaff so the model is
   * re-parented + Y-shifted to the new storey. */
  onStaffFloorChanged?: (memberId: string, oldFloor: number, newFloor: number) => void;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    // Inline section — Sidebar handles the position/background/padding.
    this.root = document.createElement("div");
    parent.appendChild(this.root);

    const title = document.createElement("div");
    title.textContent = "👥 STAFF";
    Object.assign(title.style, {
      fontWeight: "700", fontSize: "12px", letterSpacing: "0.04em",
      marginBottom: "6px", textAlign: "center", opacity: "0.9",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(title);
    attachTooltip(title,
      "STAFF — the people running your restaurant.\n" +
      "• Chef cooks orders at the stove. Each placed stove gets one chef; more chefs = more dishes/min.\n" +
      "• Waiter takes orders and brings food. Faster service when you have more waiters per table.\n" +
      "• Errand helper buys groceries when the pantry runs low (per the auto-shop list).\n" +
      "Hire + Fire per role. Each role costs a per-minute wage paid from your cash (shown at the bottom). " +
      "Train staff in the Upgrades modal to raise their effective tier."
    );

    (["chef", "barman", "waiter", "errand"] as StaffRole[]).forEach((role) => this.addRow(role));

    // Footer: total payroll + status.
    this.payrollLine = document.createElement("div");
    Object.assign(this.payrollLine.style, {
      marginTop: "6px",
      paddingTop: "6px",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      fontSize: "10px",
      opacity: "0.75",
      textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.payrollLine);
  }

  private addRow(role: StaffRole): void {
    const block = document.createElement("div");
    Object.assign(block.style, {
      marginBottom: "5px",
      padding: "4px 6px",
      background: "rgba(255,245,220,0.04)",
      borderRadius: "4px",
    } as Partial<CSSStyleDeclaration>);

    const top = document.createElement("div");
    Object.assign(top.style, { display: "flex", alignItems: "center", gap: "6px" } as Partial<CSSStyleDeclaration>);
    const label = document.createElement("span");
    Object.assign(label.style, { fontWeight: "600", fontSize: "12px", flex: "1" } as Partial<CSSStyleDeclaration>);
    const hire = this.makeBtn("+", "rgba(120,200,120,0.22)");
    const fire = this.makeBtn("−", "rgba(200,120,120,0.22)");
    hire.onclick = () => { if (this.game.hireStaff(role)) this.update(); };
    fire.onclick = () => { if (this.game.fireStaff(role)) this.update(); };
    top.appendChild(label);
    top.appendChild(hire);
    top.appendChild(fire);
    block.appendChild(top);

    const activity = document.createElement("div");
    Object.assign(activity.style, { fontSize: "10px", opacity: "0.75", marginTop: "2px" } as Partial<CSSStyleDeclaration>);
    block.appendChild(activity);

    // Per-member floor-assignment rows. Only populated when the current
    // tier has unlocked at least one upper storey (no point showing a
    // single-button picker on a ground-only restaurant).
    const members = document.createElement("div");
    Object.assign(members.style, { marginTop: "3px", display: "none" } as Partial<CSSStyleDeclaration>);
    block.appendChild(members);

    this.root.appendChild(block);
    this.rows[role] = { label, activity, hire, fire, members };
  }

  /** Build (or rebuild) the per-member roster with one floor selector
   * per member. Called from `update` whenever the panel refreshes so
   * a hire/fire/reassign immediately reflects in the strip. */
  private renderMembers(role: StaffRole, hostEl: HTMLElement): void {
    const tier = this.game.getLuxuryTier();
    const numStoreys = WorldScene.getNumStoreys();
    // Hide the whole strip on tier 1 — only one floor exists, no
    // assignment to make.
    if (tier < 2) {
      hostEl.style.display = "none";
      hostEl.innerHTML = "";
      return;
    }
    hostEl.innerHTML = "";
    hostEl.style.display = "block";
    const members = this.game.staff.getMembers(role);
    for (const member of members) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "3px",
        padding: "2px 0",
        fontSize: "10px",
      } as Partial<CSSStyleDeclaration>);
      const name = document.createElement("span");
      name.textContent = member.name;
      Object.assign(name.style, {
        flex: "1", overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap", opacity: "0.9",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(name);
      const current = member.homeFloor ?? 0;
      for (let idx = 0; idx < numStoreys; idx += 1) {
        const unlocked = idx === 0 || tier >= idx + 1;
        const isActive = idx === current;
        const btn = document.createElement("button");
        btn.textContent = idx === 0 ? "G" : String(idx);
        btn.title = unlocked
          ? (idx === 0 ? "Ground" : `Floor ${idx}`)
          : `Floor ${idx} — unlocks at tier ${idx + 1}`;
        btn.disabled = !unlocked;
        Object.assign(btn.style, {
          width: "16px", height: "18px", padding: "0",
          fontSize: "10px", fontWeight: "700",
          background: isActive
            ? "rgba(255, 210, 120, 0.45)"
            : "rgba(120, 180, 200, 0.18)",
          color: isActive ? "#fffff0" : "#fff5dc",
          border: isActive
            ? "1px solid rgba(255, 220, 150, 0.85)"
            : "1px solid rgba(255,245,220,0.22)",
          borderRadius: "3px",
          cursor: unlocked ? "pointer" : "not-allowed",
          opacity: unlocked ? "1" : "0.4",
          font: "inherit",
        } as Partial<CSSStyleDeclaration>);
        if (unlocked && !isActive) {
          btn.onclick = () => {
            const old = member.homeFloor ?? 0;
            if (this.game.staff.setMemberHomeFloor(member.id, idx)) {
              this.onStaffFloorChanged?.(member.id, old, idx);
              this.update();
            }
          };
        }
        row.appendChild(btn);
      }
      hostEl.appendChild(row);
    }
  }

  private makeBtn(text: string, bg: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = text;
    Object.assign(b.style, {
      width: "26px", height: "22px",
      background: bg, color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      cursor: "pointer", font: "inherit", fontSize: "13px", fontWeight: "700",
    } as Partial<CSSStyleDeclaration>);
    return b;
  }

  update(): void {
    let totalCount = 0;
    let totalPayroll = 0;
    const perStaff = this.game.admin.payrollPerStaffPerMinute;
    (["chef", "barman", "waiter", "errand"] as StaffRole[]).forEach((role) => {
      const count = this.game.staff.getStaffCount(role);
      const hireCost = this.game.staff.getStaffHireCost(role);
      const fireCost = this.game.staff.getStaffFireCost(role);
      const label = this.game.staff.getStaffRoleLabel(role);
      const working = this.game.getStaffWorkingCount?.(role) ?? 0;
      const idle = Math.max(0, count - working);
      const rolePayroll = count * perStaff;
      const row = this.rows[role];
      // Title row now includes the role payroll so the player can see
      // expenses per category, not just an aggregate footer.
      row.label.innerHTML = `${label} (${count}) <span style="opacity:0.65;font-weight:400;font-size:11px">· $${rolePayroll}/min</span>`;
      row.activity.innerHTML = count === 0
        ? `<span style="opacity:0.4">none hired</span>`
        : `<span style="color:#a8e2a8">▶ ${working} working</span> · <span style="color:#ffd47a">⏸ ${idle} idle</span>`;
      row.hire.title = `Hire ${label} ($${hireCost}) — adds $${perStaff}/min payroll`;
      row.fire.title = `Fire ${label} (−$${fireCost} severance)`;
      const canHire = this.game.economy.canAfford(hireCost);
      row.hire.disabled = !canHire;
      row.hire.style.opacity = canHire ? "1" : "0.4";
      row.fire.disabled = count === 0;
      row.fire.style.opacity = count === 0 ? "0.4" : "1";
      this.renderMembers(role, row.members);
      totalCount += count;
      totalPayroll += rolePayroll;
    });
    if (this.payrollLine) {
      if (totalCount === 0) {
        this.payrollLine.textContent = "No staff hired — guests wait forever.";
      } else {
        const stats = this.game.getTicketStats?.();
        const totalTickets = stats
          ? stats.queued + stats.cooking + stats.ready + stats.delivering
          : 0;
        const queueLine = stats && totalTickets > 0
          ? ` · 📋 ${stats.queued} queued · 🍳 ${stats.cooking} cooking · 🍽 ${stats.delivering + stats.ready} delivering`
          : ` · idle — no pending tickets`;
        this.payrollLine.textContent =
          `${totalCount} hired · $${totalPayroll}/min${queueLine}`;
      }
    }
  }
}
