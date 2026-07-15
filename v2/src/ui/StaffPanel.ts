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
/** A game-day is 720s = 12 real minutes, and wages are charged per real
 * minute, so a per-game-day wage = per-minute × this. Keeps the "/day"
 * payroll display comparable to the "/day" rent shown elsewhere. */
const GAME_MINUTES_PER_DAY = 12;

export class StaffPanel {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly rows: Record<StaffRole, {
    label: HTMLElement; activity: HTMLElement;
    hire: HTMLButtonElement;
    members: HTMLElement;
  }> = {} as Record<StaffRole, { label: HTMLElement; activity: HTMLElement; hire: HTMLButtonElement; members: HTMLElement }>;
  private payrollLine?: HTMLElement;
  /** Fired when the player reassigns a member to a new home floor.
   * Engine wires this to WorldScene.relocateStaff so the model is
   * re-parented + Y-shifted to the new storey. */
  onStaffFloorChanged?: (memberId: string, oldFloor: number, newFloor: number) => void;

  /** Phase I (H.68) — Fired when the player clicks "Set Waiter Rest
   * Spot".  Engine handles entering placement mode (click-on-floor
   * → fire reducer).  Optional so the panel works in isolation
   * during tests / visit mode. */
  onSetWaiterRestSpot?: () => void;

  /** Phase I (H.68) — Fired when the player clicks "Clear" next to
   * the rest spot label.  Engine handles the cloud round-trip. */
  onClearWaiterRestSpot?: () => void;

  /** Phase I (H.68) — Renders "📍 Rest spot: set / not set" + the
   * Set / Clear buttons.  Engine pokes this label via setWaiterRestStatus
   * after a hydrate or after a reducer round-trip. */
  private waiterRestLabel?: HTMLElement;

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
      "Hire + Fire per role. Each role costs a per-day wage paid from your cash (shown at the bottom). " +
      "Train staff in the Upgrades modal to raise their effective tier."
    );

    const rolesToShow: StaffRole[] = ["chef", "barman", "waiter", "errand"];
    rolesToShow.forEach((role) => this.addRow(role));
    // Build-time sanity check the player can grep in DevTools — if
    // this line is missing from the console output, the browser is
    // serving a cached StaffPanel and a hard reload + Vite restart
    // is needed. Logs the exact roster the panel knows about so a
    // mis-ordered or missing role is immediately obvious.
    console.log(`[StaffPanel] mounted rows for: ${rolesToShow.join(", ")}`);

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

    // Phase I (H.68) — waiter rest-spot controls.  Chefs / helpers /
    // barmen already auto-anchor near their station; waiters had no
    // resting position before this, so they'd hover wherever they
    // last finished a delivery.  This block lets the player click a
    // tile to pin where idle waiters should congregate.
    const restRow = document.createElement("div");
    Object.assign(restRow.style, {
      marginTop: "6px",
      paddingTop: "6px",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      display: "flex", gap: "4px", alignItems: "center",
      fontSize: "10px",
    } as Partial<CSSStyleDeclaration>);
    this.waiterRestLabel = document.createElement("span");
    this.waiterRestLabel.textContent = "📍 Waiter rest: not set";
    Object.assign(this.waiterRestLabel.style, {
      flex: "1", opacity: "0.85",
    } as Partial<CSSStyleDeclaration>);
    attachTooltip(this.waiterRestLabel,
      "Where your waiters go when they have nothing to do.\n" +
      "Click Set, then click on any floor tile inside your restaurant.\n" +
      "Chefs / helpers / barmen automatically rest near their station;\n" +
      "waiters get this manual control because they have no fixed anchor."
    );
    restRow.appendChild(this.waiterRestLabel);

    const setBtn = document.createElement("button");
    setBtn.textContent = "Set";
    Object.assign(setBtn.style, {
      padding: "3px 7px",
      background: "rgba(120, 180, 200, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px", cursor: "pointer",
      font: "inherit", fontSize: "10px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    setBtn.onclick = () => this.onSetWaiterRestSpot?.();
    restRow.appendChild(setBtn);

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    Object.assign(clearBtn.style, {
      padding: "3px 7px",
      background: "rgba(200, 120, 100, 0.18)",
      color: "#fff5dc",
      border: "1px solid rgba(200, 120, 100, 0.35)",
      borderRadius: "4px", cursor: "pointer",
      font: "inherit", fontSize: "10px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    clearBtn.onclick = () => this.onClearWaiterRestSpot?.();
    restRow.appendChild(clearBtn);

    this.root.appendChild(restRow);
  }

  /** Phase I (H.72) — pick the right emoji + count + tooltip for the
   * per-member workload badge by role.  Returns null when the role
   * has no workload accessor wired yet (defensive — keeps the UI
   * silent rather than throwing on an unknown role).  Same color
   * ramp logic in the caller works against any role's count.
   *
   * Counts:
   *   chef    — queued + cooking tickets routed to this chef
   *   barman  — queued + cooking BAR tickets routed to this barman
   *   waiter  — concurrent tasks they own (deliver + wash + take-order)
   *   errand  — 1 if on a trip, 0 if loitering by the counter
   */
  private workloadBadgeInfo(
    role: StaffRole,
    memberId: string,
  ): { emoji: string; count: number; tooltip: string } | null {
    switch (role) {
      case "chef": {
        const n = this.game.getChefBacklog?.(memberId) ?? 0;
        return { emoji: "🍳", count: n, tooltip:
          `${n} tickets in this chef's backlog (queued + cooking). ` +
          `Hire another chef if this stays high — waiters spill to other floors when same-floor chefs hit 4+.` };
      }
      case "barman": {
        const n = this.game.getBarmanBacklog?.(memberId) ?? 0;
        return { emoji: "🍸", count: n, tooltip:
          `${n} drinks in this barman's queue (queued + mixing). ` +
          `Hire another barman if this stays high.` };
      }
      case "waiter": {
        const n = this.game.getWaiterBacklog?.(memberId) ?? 0;
        return { emoji: "🍽", count: n, tooltip:
          `${n} active task(s) — meal delivery, wash trip, and take-order count together.` };
      }
      case "errand": {
        const n = this.game.getErrandBacklog?.(memberId) ?? 0;
        const trip = this.game.getErrandTripSummary?.(memberId) ?? "";
        return { emoji: "📦", count: n, tooltip:
          n > 0
            ? (trip ? `Bringing back: ${trip}.` : "On a shopping trip.")
            : "Idle by the supply counter." };
      }
      default:
        return null;
    }
  }

  /** Phase I (H.68) — Update the rest-spot status label after a
   * hydrate / set / clear.  Engine calls this so the panel reflects
   * the live cloud value. */
  setWaiterRestStatus(spot: { x: number; z: number; floor: number } | null): void {
    if (!this.waiterRestLabel) return;
    if (spot) {
      const floorLabel = spot.floor === 0 ? "G" : `F${spot.floor}`;
      this.waiterRestLabel.textContent =
        `📍 Waiter rest: ${floorLabel} (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)})`;
    } else {
      this.waiterRestLabel.textContent = "📍 Waiter rest: not set";
    }
  }

  private addRow(role: StaffRole): void {
    const block = document.createElement("div");
    Object.assign(block.style, {
      marginBottom: "10px",
      padding: "10px 12px",
      background: "rgba(255,245,220,0.05)",
      border: "1px solid rgba(255,245,220,0.10)",
      borderRadius: "10px",
    } as Partial<CSSStyleDeclaration>);

    const top = document.createElement("div");
    Object.assign(top.style, { display: "flex", alignItems: "center", gap: "8px" } as Partial<CSSStyleDeclaration>);
    const label = document.createElement("span");
    Object.assign(label.style, { fontWeight: "700", fontSize: "13.5px", flex: "1", lineHeight: "1.25" } as Partial<CSSStyleDeclaration>);
    // Hire (+) stays here because adding a new member is a generic
    // role-level action ("I need another chef"). Per-member fire (−)
    // lives in the member row below — necessary now that training
    // raises individual member value, so the player has to be able
    // to pick which specific member to let go.
    const hire = document.createElement("button");
    hire.textContent = "＋ Hire";
    Object.assign(hire.style, {
      flex: "0 0 auto", padding: "6px 11px", borderRadius: "7px",
      background: "rgba(120,200,120,0.28)", color: "#eaffea",
      border: "1px solid rgba(150,230,150,0.5)", cursor: "pointer",
      font: "inherit", fontSize: "12px", fontWeight: "700", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    hire.onclick = () => { if (this.game.hireStaff(role)) this.update(); };
    top.appendChild(label);
    top.appendChild(hire);
    block.appendChild(top);

    const activity = document.createElement("div");
    Object.assign(activity.style, { fontSize: "11px", opacity: "0.75", marginTop: "3px" } as Partial<CSSStyleDeclaration>);
    block.appendChild(activity);

    // Per-member floor-assignment rows. Only populated when the current
    // tier has unlocked at least one upper storey (no point showing a
    // single-button picker on a ground-only restaurant).
    const members = document.createElement("div");
    Object.assign(members.style, { marginTop: "8px", display: "none" } as Partial<CSSStyleDeclaration>);
    block.appendChild(members);

    this.root.appendChild(block);
    this.rows[role] = { label, activity, hire, members };
  }

  /** Pulse a role's hire (+) button and scroll it into view — used when the
   * service alert routes the player here (e.g. ingredients stuck → hire an
   * errand helper) so the relevant control is obvious. */
  highlightHire(role: StaffRole): void {
    const btn = this.rows[role]?.hire;
    if (!btn) return;
    btn.scrollIntoView({ block: "center", behavior: "smooth" });
    btn.animate(
      [
        { boxShadow: "0 0 0 0 rgba(120,220,140,0.9)", transform: "scale(1)" },
        { boxShadow: "0 0 0 10px rgba(120,220,140,0)", transform: "scale(1.18)" },
        { boxShadow: "0 0 0 0 rgba(120,220,140,0)", transform: "scale(1)" },
      ],
      { duration: 900, iterations: 3, easing: "ease-out" },
    );
  }

  /** Cache of the most-recent roster signature per role. Lets
   * renderMembers SKIP the destroy-and-rebuild pass when nothing
   * changed since the last update — without this, the 5Hz HUD tick
   * wiped (innerHTML = "") and recreated every member row every
   * 200ms, which meant the floor-selector buttons disappeared
   * between mousedown and mouseup whenever a click straddled a
   * render boundary. User-visible effect: "click button, nothing
   * happens, click again, finally works". */
  private memberRosterSig: Record<string, string> = {};

  /** Build (or rebuild) the per-member roster with one floor selector
   * per member. Called from `update` whenever the panel refreshes —
   * but actually rebuilds only when the roster signature changed
   * (members added / fired / reassigned / training-flag toggled).
   * Otherwise the existing DOM stays put so in-flight clicks aren't
   * destroyed mid-gesture. */
  private renderMembers(role: StaffRole, hostEl: HTMLElement): void {
    const tier = this.game.getLuxuryTier();
    const numStoreys = WorldScene.getNumStoreys();
    const members = this.game.staff.getMembers(role);
    // Always render member rows so the per-member fire button is
    // reachable, even on tier 1 where there's only one floor to
    // assign to. The floor-button strip is suppressed at tier 1
    // since the player has no assignment choice to make there.
    if (members.length === 0) {
      if (hostEl.childElementCount > 0 || hostEl.style.display !== "none") {
        hostEl.style.display = "none";
        hostEl.innerHTML = "";
        this.memberRosterSig[role] = "";
      }
      return;
    }
    // Signature captures everything that affects what the UI draws:
    // tier (gates the active floor buttons), the member list (id +
    // current home floor). If two consecutive ticks produce the
    // same string, the existing DOM is correct as-is.
    // Signature also includes the per-member workload count so the
    // row rebuilds whenever any backlog changes (otherwise the
    // badge would stay stale at the original value).  Phase I
    // (H.72) — extended from chef-only to all four roles so the
    // barman / waiter / errand badges also live-update.
    const backlogFor = (m: { id: string }): number => {
      const info = this.workloadBadgeInfo(role, m.id);
      return info?.count ?? 0;
    };
    const sig = `t${tier}|n${numStoreys}|` + members.map((m) => `${m.id}@${m.homeFloor ?? 0}/b${backlogFor(m)}/L${m.upgradeLevel | 0}/D${m.isDeactivated ? 1 : 0}`).join(",");
    if (this.memberRosterSig[role] === sig && hostEl.style.display === "block") {
      return;
    }
    this.memberRosterSig[role] = sig;
    hostEl.innerHTML = "";
    hostEl.style.display = "block";
    const showFloorButtons = tier >= 2;
    for (const member of members) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "6px",
        padding: "5px 8px",
        marginTop: "4px",
        fontSize: "11px",
        background: "rgba(255,255,255,0.035)",
        borderRadius: "7px",
      } as Partial<CSSStyleDeclaration>);
      // H.97 — Per-member level chip BEFORE the name, so the player
      // sees at a glance who's mentored. upgradeLevel starts at 0 and
      // climbs with each completed training. Capped visual at 5 to
      // match the recipe-tier ceiling; the underlying number keeps
      // accumulating for fractional speed bonuses but the player
      // doesn't see "Lv 12" cluttering the row.
      const levelChip = document.createElement("span");
      const lvl = Math.max(0, Math.min(5, member.upgradeLevel | 0));
      levelChip.textContent = `Lv${lvl}`;
      Object.assign(levelChip.style, {
        fontSize: "9px",
        fontWeight: "700",
        padding: "1px 4px",
        borderRadius: "3px",
        background: lvl >= 4 ? "rgba(255,200,90,0.35)"
          : lvl >= 2 ? "rgba(170,200,255,0.25)"
          : "rgba(255,255,255,0.10)",
        color: "#fff5dc",
        marginRight: "5px",
        flex: "0 0 auto",
        fontVariantNumeric: "tabular-nums",
        opacity: lvl === 0 ? "0.55" : "1",
      } as Partial<CSSStyleDeclaration>);
      levelChip.title = `Training level ${lvl}. Higher = faster cook / wash / errand times.`;
      row.appendChild(levelChip);

      const name = document.createElement("span");
      name.textContent = member.name;
      Object.assign(name.style, {
        flex: "1", overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap", opacity: "0.9",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(name);
      // Per-member workload badge — Phase I (H.72) generalised what
      // used to be a chef-only "🍳 N" indicator so every role gets a
      // visual cue when they're busy.  Each role picks a different
      // emoji (cooking pan / mixing glass / serving tray / shopping
      // bag) and queries its own Game accessor.  Same color ramp
      // applies across the board — green = fine, amber = catching
      // up, red = hire help — so the player learns one visual
      // language and reads any role's load at a glance.
      const badgeInfo = this.workloadBadgeInfo(role, member.id);
      if (badgeInfo && badgeInfo.count > 0) {
        const badge = document.createElement("span");
        badge.textContent = `${badgeInfo.emoji} ${badgeInfo.count}`;
        badge.title = badgeInfo.tooltip;
        const n = badgeInfo.count;
        const bg = n >= 5
          ? "rgba(220, 80, 80, 0.55)"
          : n >= 3
            ? "rgba(220, 170, 80, 0.45)"
            : "rgba(120, 200, 120, 0.35)";
        Object.assign(badge.style, {
          fontSize: "10px",
          fontWeight: "700",
          padding: "1px 5px",
          borderRadius: "3px",
          background: bg,
          color: "#fff5dc",
          marginRight: "4px",
          flex: "0 0 auto",
          fontVariantNumeric: "tabular-nums",
        } as Partial<CSSStyleDeclaration>);
        row.appendChild(badge);
      }
      if (showFloorButtons) {
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
            width: "20px", height: "20px", padding: "0",
            fontSize: "11px", fontWeight: "700",
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
      }
      // Per-member fire button — far right of the row. Replaces the
      // old role-level − button at the top, which was problematic now
      // that staff can be individually trained: the player needs to
      // choose WHO to let go, not "whoever the LIFO picks". Wears the
      // member's name in the tooltip + severance cost so misclicks
      // self-correct.
      if (member.isDeactivated) {
        // No-negative-money: benched member — grey the whole row + offer a
        // free Reactivate (↺) in place of Fire. Reactivating just resumes
        // their wages; they kept every upgrade.
        row.style.opacity = "0.5";
        const reactivate = document.createElement("button");
        reactivate.textContent = "↺ rehire";
        reactivate.title = `Reactivate ${member.name} (Lv${member.upgradeLevel | 0} ${role}) — free, resumes wages`;
        Object.assign(reactivate.style, {
          height: "18px", padding: "0 6px", marginLeft: "4px",
          fontSize: "10px", fontWeight: "700",
          background: "rgba(120, 200, 120, 0.30)", color: "#eaffea",
          border: "1px solid rgba(150, 230, 150, 0.55)", borderRadius: "3px",
          cursor: "pointer", font: "inherit", lineHeight: "1", whiteSpace: "nowrap",
        } as Partial<CSSStyleDeclaration>);
        reactivate.onclick = () => {
          if (this.game.reactivateStaffMember(member.id)) this.update();
        };
        row.appendChild(reactivate);
      } else {
        const fire = document.createElement("button");
        fire.textContent = "−";
        const severance = this.game.staff.getStaffFireCost(role);
        const trainingLvl = this.game.getMemberUpgradeLevel(member.id);
        fire.title = `Fire ${member.name} (L${trainingLvl} ${role}) — costs $${severance} severance`;
        Object.assign(fire.style, {
          width: "20px", height: "20px", padding: "0",
          marginLeft: "2px",
          fontSize: "13px", fontWeight: "700",
          background: "rgba(200, 120, 120, 0.22)",
          color: "#fff5dc",
          border: "1px solid rgba(255, 180, 180, 0.45)",
          borderRadius: "3px",
          cursor: "pointer",
          font: "inherit",
          lineHeight: "1",
        } as Partial<CSSStyleDeclaration>);
        fire.onclick = () => {
          if (this.game.fireStaffMember(member.id)) this.update();
        };
        row.appendChild(fire);
      }
      hostEl.appendChild(row);
    }
  }

  update(): void {
    let totalCount = 0;
    let totalPayroll = 0;
    const perStaff = this.game.admin.payrollPerStaffPerMinute;
    (["chef", "barman", "waiter", "errand"] as StaffRole[]).forEach((role) => {
      const count = this.game.staff.getStaffCount(role);
      const hireCost = this.game.staff.getStaffHireCost(role);
      const label = this.game.staff.getStaffRoleLabel(role);
      const working = this.game.getStaffWorkingCount?.(role) ?? 0;
      const idle = Math.max(0, count - working);
      // Role payroll = base × count + sum-of-training-levels. Pulled
      // from StaffSystem so it stays in sync with what tickSalary
      // actually charges (each training level adds $1/min per
      // member, on top of the base per-staff wage).
      const rolePayroll = this.game.staff.getRolePayrollPerMinute(role, perStaff);
      const row = this.rows[role];
      const unlockTier = this.game.getRoleUnlockTier(role);
      const locked = this.game.getLuxuryTier() < unlockTier;
      // Title row now includes the role payroll so the player can see
      // expenses per category, not just an aggregate footer. Locked
      // roles (e.g. barman before tier 2) gain a small "🔒 tier N"
      // tag so the player sees the unlock without hovering.
      const lockTag = locked
        ? ` <span style="opacity:0.7;font-weight:600;font-size:10px;color:#ffd47a">🔒 tier ${unlockTier}</span>`
        : "";
      row.label.innerHTML = `${label} (${count}) <span style="opacity:0.65;font-weight:400;font-size:11px">· $${Math.round(rolePayroll * GAME_MINUTES_PER_DAY)}/day</span>${lockTag}`;
      row.activity.innerHTML = locked
        ? `<span style="opacity:0.5">Unlocks at tier ${unlockTier}</span>`
        : count === 0
          ? `<span style="opacity:0.4">none hired</span>`
          : `<span style="color:#a8e2a8">▶ ${working} working</span> · <span style="color:#ffd47a">⏸ ${idle} idle</span>`;
      // Two gates on the hire button: tier unlock + cash. Title
      // string surfaces whichever is blocking so the player isn't
      // guessing why the + is greyed out (e.g. barman before tier
      // 2 reads "Unlocks at tier 2" instead of just "disabled").
      const hireGate = this.game.canHireStaff(role);
      row.hire.title = hireGate.ok
        ? `Hire ${label} ($${hireCost}) — adds $${Math.round(perStaff * GAME_MINUTES_PER_DAY)}/day payroll`
        : `${hireGate.reason} · would cost $${hireCost} + $${Math.round(perStaff * GAME_MINUTES_PER_DAY)}/day`;
      row.hire.disabled = !hireGate.ok;
      row.hire.style.opacity = hireGate.ok ? "1" : "0.4";
      // Per-member fire buttons (one per row in `members`) replaced
      // the old role-level − here; renderMembers builds them.
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
          `${totalCount} hired · $${Math.round(totalPayroll * GAME_MINUTES_PER_DAY)}/day${queueLine}`;
      }
    }
  }
}
