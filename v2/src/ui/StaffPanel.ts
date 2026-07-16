import type { Game } from "../game/Game";
import { STAFF_UPGRADE_MAX, getTrainingDurationHours, type StaffRole } from "../systems/StaffSystem";
import { WorldScene } from "../scene/WorldScene";
import { attachTooltip } from "./tooltip";
import { showTierGate } from "./tierUnlock";
import { confirmAction } from "./confirmDialog";
import { StaffPortraits } from "./StaffPortraits";

/**
 * Staff manager — a TILE GRID, one tile per hired person.
 *
 * The old layout was four role sections each stacking a vertical list of member
 * cards; past a handful of staff it became a long scroll where nothing was
 * scannable. Now:
 *
 *   • HIRE BAR   — one compact chip per role (icon · count · cost). Click to
 *                  hire; a tier-locked role opens the shared unlock gate.
 *   • TILE GRID  — every member is one tile: who they are, what they're doing
 *                  right now, and their three actions (assign floor, train,
 *                  fire) inline. Scans left-to-right instead of scrolling.
 *   • FOOTER     — payroll + ticket flow + the waiter rest spot.
 *
 * Training moved HERE from the Upgrades modal: it's a per-person action, so it
 * belongs on the person's tile.
 *
 * RENDER DISCIPLINE: the host modal refreshes at ~2.5 Hz. Rebuilding tiles on
 * every tick destroys a button between mousedown and mouseup ("click, nothing
 * happens, click again" — a real bug we already fixed once). So the grid is
 * rebuilt ONLY when the roster STRUCTURE changes (who exists, their level /
 * floor / benched state, the tier); everything volatile (status pill, training
 * countdown, affordability) is updated IN PLACE on the live elements.
 */

/** A game-day is 720s = 12 real minutes, and wages are charged per real
 * minute, so a per-game-day wage = per-minute × this. */
const GAME_MINUTES_PER_DAY = 12;

/** Per-role identity: emoji, labels, and a signature COLOUR that tints the
 * portrait + accents the tile, so a role is recognisable at a glance even
 * before the 3-D portrait has loaded. */
const ROLE_META: Record<StaffRole, { icon: string; label: string; short: string; color: string; blurb: string }> = {
  chef:   { icon: "🍳", label: "Chef", short: "Chef", color: "#ff9d6e",
    blurb: "Cooks food orders at the stove. More chefs = more dishes cooking at once." },
  barman: { icon: "🍸", label: "Barman", short: "Barman", color: "#c78ce0",
    blurb: "Mixes and serves drinks at the bar. Table drinks get delivered by a waiter." },
  waiter: { icon: "🍽", label: "Waiter", short: "Waiter", color: "#6ec8ff",
    blurb: "Takes orders, delivers food, and clears dirty plates to the sink." },
  errand: { icon: "📦", label: "Errand Helper", short: "Helper", color: "#8fd18f",
    blurb: "Shops for groceries when the pantry runs low, so recipes never stall." },
};

/** Section headers — deliberately loud. The first pass used 9.5px at 0.5
 * opacity and players didn't see them at all. */
function sectionHeader(text: string): HTMLElement {
  const el = document.createElement("div");
  el.textContent = text;
  Object.assign(el.style, {
    fontSize: "12px", fontWeight: "800", letterSpacing: "0.16em",
    color: "#ffd986", marginBottom: "8px", paddingBottom: "5px",
    borderBottom: "1px solid rgba(255,217,134,0.30)",
  } as Partial<CSSStyleDeclaration>);
  return el;
}

const ROLES: StaffRole[] = ["chef", "barman", "waiter", "errand"];

/** $1,200 → "$1.2k" so it fits on a tile button. */
function compactDollars(n: number): string {
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

/** Seconds → "2.1h" / "14m" / "45s" for the training countdown. */
function formatEta(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.max(1, Math.round(seconds))}s`;
}

interface TileRefs {
  root: HTMLElement;
  levelChip: HTMLElement;
  status: HTMLElement;
  meta: HTMLElement;
  train: HTMLButtonElement;
  fire: HTMLButtonElement;
  floorSel?: HTMLSelectElement;
}

export class StaffPanel {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly hireBar: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly emptyNote: HTMLElement;
  private readonly payrollLine: HTMLElement;
  private waiterRestLabel?: HTMLElement;
  private readonly restRow: HTMLElement;

  private readonly hireChips: Partial<Record<StaffRole, { btn: HTMLButtonElement; sub: HTMLElement }>> = {};
  private readonly tiles = new Map<string, TileRefs>();
  /** Live idle-animated model portraits (one rig per role, blitted per tile). */
  private readonly portraits = new StaffPortraits();
  /** Structure signature — see RENDER DISCIPLINE in the class doc. */
  private gridSig = "";

  /** Fired when the player reassigns a member to a new home floor. Engine wires
   * this to WorldScene.relocateStaff so the model moves to the new storey. */
  onStaffFloorChanged?: (memberId: string, oldFloor: number, newFloor: number) => void;
  /** Engine enters floor-click placement mode for the waiter rest spot. */
  onSetWaiterRestSpot?: () => void;
  onClearWaiterRestSpot?: () => void;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    parent.appendChild(this.root);

    // ── HIRE BAR ──────────────────────────────────────────────
    const hireHeader = sectionHeader("＋ HIRE STAFF");
    this.root.appendChild(hireHeader);
    attachTooltip(hireHeader,
      "Add someone to the payroll. Each role costs a one-off hire fee plus a " +
      "per-day wage out of your cash. A role you haven't unlocked yet opens the " +
      "tier gate instead.");

    this.hireBar = document.createElement("div");
    Object.assign(this.hireBar.style, {
      display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))",
      gap: "5px", marginBottom: "12px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.hireBar);
    for (const role of ROLES) this.buildHireChip(role);

    // ── TILE GRID ─────────────────────────────────────────────
    this.root.appendChild(sectionHeader("👥 YOUR CREW"));

    this.grid = document.createElement("div");
    Object.assign(this.grid.style, {
      display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(184px, 1fr))",
      gap: "7px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.grid);

    this.emptyNote = document.createElement("div");
    this.emptyNote.textContent = "Nobody hired yet — guests will sit and wait forever. Hire a chef and a waiter to get started.";
    Object.assign(this.emptyNote.style, {
      fontSize: "11px", opacity: "0.5", fontStyle: "italic",
      padding: "14px 4px", textAlign: "center", display: "none",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.emptyNote);

    // ── FOOTER: payroll + rest spot ───────────────────────────
    this.payrollLine = document.createElement("div");
    Object.assign(this.payrollLine.style, {
      marginTop: "10px", paddingTop: "8px",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      fontSize: "10.5px", opacity: "0.8", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.payrollLine);

    this.restRow = document.createElement("div");
    Object.assign(this.restRow.style, {
      marginTop: "7px", paddingTop: "7px",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      display: "flex", gap: "5px", alignItems: "center", fontSize: "10px",
    } as Partial<CSSStyleDeclaration>);
    this.waiterRestLabel = document.createElement("span");
    this.waiterRestLabel.textContent = "📍 Waiter rest: not set";
    Object.assign(this.waiterRestLabel.style, { flex: "1", opacity: "0.85" } as Partial<CSSStyleDeclaration>);
    attachTooltip(this.waiterRestLabel,
      "Where your waiters go when they have nothing to do.\n" +
      "Click Set, then click any floor tile inside your restaurant.\n" +
      "Chefs / helpers / barmen automatically rest near their station; waiters " +
      "have no fixed anchor, so they get this manual control.");
    this.restRow.appendChild(this.waiterRestLabel);
    this.restRow.appendChild(this.smallBtn("Set", "rgba(120,180,200,0.18)", "rgba(255,245,220,0.25)",
      () => this.onSetWaiterRestSpot?.()));
    this.restRow.appendChild(this.smallBtn("Clear", "rgba(200,120,100,0.18)", "rgba(200,120,100,0.35)",
      () => this.onClearWaiterRestSpot?.()));
    this.root.appendChild(this.restRow);

    this.update();
  }

  private smallBtn(text: string, bg: string, border: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = text;
    Object.assign(b.style, {
      padding: "3px 8px", background: bg, color: "#fff5dc",
      border: `1px solid ${border}`, borderRadius: "5px", cursor: "pointer",
      font: "inherit", fontSize: "10px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    b.onclick = onClick;
    return b;
  }

  // ── HIRE BAR ────────────────────────────────────────────────

  private buildHireChip(role: StaffRole): void {
    const meta = ROLE_META[role];
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      display: "flex", flexDirection: "column", alignItems: "center", gap: "1px",
      padding: "7px 4px", borderRadius: "8px", cursor: "pointer", font: "inherit",
      background: "rgba(120,200,120,0.16)", color: "#eaffea",
      border: "1px solid rgba(150,230,150,0.38)", minWidth: "0",
    } as Partial<CSSStyleDeclaration>);
    // A big, unmistakable ＋ so the chip reads as "add one of these" instantly.
    const plus = document.createElement("span");
    plus.textContent = "＋";
    Object.assign(plus.style, {
      fontSize: "20px", fontWeight: "900", lineHeight: "0.85",
      color: "#b6f5b6", flex: "0 0 auto",
    } as Partial<CSSStyleDeclaration>);
    const top = document.createElement("span");
    Object.assign(top.style, {
      fontSize: "11.5px", fontWeight: "700", whiteSpace: "nowrap",
      overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
    } as Partial<CSSStyleDeclaration>);
    top.textContent = `${meta.icon} ${meta.short}`;
    const sub = document.createElement("span");
    Object.assign(sub.style, { fontSize: "9.5px", opacity: "0.85", whiteSpace: "nowrap" } as Partial<CSSStyleDeclaration>);
    btn.append(plus, top, sub);
    btn.onclick = () => this.onHireClick(role);
    this.hireBar.appendChild(btn);
    this.hireChips[role] = { btn, sub };
  }

  /** Hiring spends cash AND commits to an ongoing wage, so it asks first. */
  private onHireClick(role: StaffRole): void {
    const ut = this.game.getRoleUnlockTier(role);
    if (this.game.getLuxuryTier() < ut) { showTierGate(this.game, ut, () => this.update()); return; }
    const meta = ROLE_META[role];
    const cost = this.game.staff.getStaffHireCost(role);
    const perDay = Math.round(this.game.admin.payrollPerStaffPerMinute * GAME_MINUTES_PER_DAY);
    confirmAction({
      title: `Hire a ${meta.label}?`,
      message: `${meta.blurb}\n\n${compactDollars(cost)} to hire, then $${perDay}/day in wages for as long as they work here.`,
      confirmLabel: `Hire · ${compactDollars(cost)}`,
      onConfirm: () => { if (this.game.hireStaff(role)) this.update(); },
    });
  }

  private syncHireBar(): void {
    const perStaff = this.game.admin.payrollPerStaffPerMinute;
    for (const role of ROLES) {
      const chip = this.hireChips[role];
      if (!chip) continue;
      const meta = ROLE_META[role];
      const count = this.game.staff.getStaffCount(role);
      const cost = this.game.staff.getStaffHireCost(role);
      const unlockTier = this.game.getRoleUnlockTier(role);
      const locked = this.game.getLuxuryTier() < unlockTier;
      const gate = this.game.canHireStaff(role);
      chip.sub.textContent = locked ? `🔒 Tier ${unlockTier}` : `+${compactDollars(cost)} · ${count} on staff`;
      // Locked chips stay CLICKABLE — they open the unlock gate.
      chip.btn.disabled = locked ? false : !gate.ok;
      chip.btn.style.opacity = locked ? "0.72" : gate.ok ? "1" : "0.42";
      attachTooltip(chip.btn, locked
        ? `${meta.label} — locked.\n${meta.blurb}\nClick to unlock Tier ${unlockTier}.`
        : gate.ok
          ? `Hire a ${meta.label} for ${compactDollars(cost)}.\n${meta.blurb}\nAdds $${Math.round(perStaff * GAME_MINUTES_PER_DAY)}/day to payroll.`
          : `Can't hire: ${gate.reason}.\n${meta.blurb}\nWould cost ${compactDollars(cost)} + $${Math.round(perStaff * GAME_MINUTES_PER_DAY)}/day.`);
    }
  }

  /** Pulse a role's hire chip — used when the service alert routes the player
   * here (e.g. ingredients stuck → hire an errand helper). */
  highlightHire(role: StaffRole): void {
    const btn = this.hireChips[role]?.btn;
    if (!btn) return;
    btn.scrollIntoView({ block: "center", behavior: "smooth" });
    btn.animate([
      { boxShadow: "0 0 0 0 rgba(120,220,140,0.9)", transform: "scale(1)" },
      { boxShadow: "0 0 0 10px rgba(120,220,140,0)", transform: "scale(1.15)" },
      { boxShadow: "0 0 0 0 rgba(120,220,140,0)", transform: "scale(1)" },
    ], { duration: 900, iterations: 3, easing: "ease-out" });
  }

  // ── TILE GRID ───────────────────────────────────────────────

  /** Everything that changes the tile STRUCTURE. Volatile values (backlog,
   * training countdown, money) are deliberately NOT here — they're refreshed
   * in place so a rebuild can't eat an in-flight click. */
  private computeGridSig(): string {
    const tier = this.game.getLuxuryTier();
    const parts: string[] = [`t${tier}`, `s${WorldScene.getNumStoreys()}`];
    for (const role of ROLES) {
      for (const m of this.game.staff.getMembers(role)) {
        parts.push(`${m.id}:${role}@${m.homeFloor ?? 0}/L${m.upgradeLevel | 0}/D${m.isDeactivated ? 1 : 0}`);
      }
    }
    return parts.join(",");
  }

  private rebuildGridIfNeeded(): void {
    const sig = this.computeGridSig();
    if (sig === this.gridSig) return;
    this.gridSig = sig;
    this.grid.innerHTML = "";
    this.tiles.clear();
    // Old tile canvases are about to be discarded — stop painting into them.
    this.portraits.detachAll();
    let any = false;
    for (const role of ROLES) {
      for (const m of this.game.staff.getMembers(role)) {
        this.grid.appendChild(this.buildTile(role, m));
        any = true;
      }
    }
    this.grid.style.display = any ? "grid" : "none";
    this.emptyNote.style.display = any ? "none" : "block";
  }

  private buildTile(role: StaffRole, member: { id: string; name: string; homeFloor?: number; upgradeLevel?: number; isDeactivated?: boolean }): HTMLElement {
    const meta = ROLE_META[role];
    const benched = !!member.isDeactivated;
    const tile = document.createElement("div");
    Object.assign(tile.style, {
      display: "flex", flexDirection: "column", minWidth: "0", overflow: "hidden",
      background: benched ? "rgba(255,255,255,0.03)" : "rgba(255,245,220,0.06)",
      // Role-coloured edge: the profession reads instantly, even at a glance.
      border: `1px solid ${benched ? "rgba(255,245,220,0.10)" : `${meta.color}55`}`,
      borderRadius: "10px", opacity: benched ? "0.6" : "1",
    } as Partial<CSSStyleDeclaration>);

    // ── PORTRAIT: the REAL rigged model playing its idle clip, so the tile
    // shows who this actually is and breathes instead of being a frozen
    // cut-out. Tinted with the role colour; the role emoji sits behind as a
    // fallback if WebGL / the GLB isn't available.
    const portrait = document.createElement("div");
    Object.assign(portrait.style, {
      position: "relative", height: "84px", flex: "0 0 auto",
      background: `linear-gradient(180deg, ${meta.color}3a, ${meta.color}0d)`,
      borderBottom: `1px solid ${meta.color}44`,
      display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    } as Partial<CSSStyleDeclaration>);
    const fallback = document.createElement("span");
    fallback.textContent = meta.icon;
    Object.assign(fallback.style, { position: "absolute", fontSize: "30px", opacity: "0.34" } as Partial<CSSStyleDeclaration>);
    portrait.appendChild(fallback);
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 128;
    Object.assign(canvas.style, {
      position: "relative", height: "100%", width: "auto", display: "block",
    } as Partial<CSSStyleDeclaration>);
    portrait.appendChild(canvas);
    this.portraits.attach(role, canvas);
    tile.appendChild(portrait);

    // Everything below the portrait gets its own padding (the portrait itself
    // runs edge-to-edge).
    const body = document.createElement("div");
    Object.assign(body.style, {
      display: "flex", flexDirection: "column", gap: "6px",
      padding: "7px 9px 8px", minWidth: "0",
    } as Partial<CSSStyleDeclaration>);
    tile.appendChild(body);

    // Head: name · level chip (the role is already carried by the portrait +
    // the tile's colour, so no emoji needed here).
    const head = document.createElement("div");
    Object.assign(head.style, { display: "flex", alignItems: "center", gap: "5px", minWidth: "0" } as Partial<CSSStyleDeclaration>);
    const name = document.createElement("span");
    name.textContent = member.name;
    Object.assign(name.style, {
      flex: "1", minWidth: "0", fontSize: "12.5px", fontWeight: "700",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    const levelChip = document.createElement("span");
    Object.assign(levelChip.style, {
      flex: "0 0 auto", fontSize: "9.5px", fontWeight: "800",
      padding: "2px 6px", borderRadius: "999px", fontVariantNumeric: "tabular-nums",
    } as Partial<CSSStyleDeclaration>);
    head.append(name, levelChip);
    body.appendChild(head);

    // Status pill — what they're doing right now.
    const status = document.createElement("div");
    body.appendChild(status);

    // Meta line — role · wage · (floor when there's no selector)
    const metaLine = document.createElement("div");
    Object.assign(metaLine.style, { fontSize: "9.5px", opacity: "0.6" } as Partial<CSSStyleDeclaration>);
    body.appendChild(metaLine);

    // Actions — assign (floor) · train · fire
    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "flex", gap: "4px", alignItems: "center", marginTop: "1px" } as Partial<CSSStyleDeclaration>);

    let floorSel: HTMLSelectElement | undefined;
    const tier = this.game.getLuxuryTier();
    const numStoreys = WorldScene.getNumStoreys();
    if (tier >= 2) {
      // ASSIGN — a compact floor picker. Only meaningful once an upper storey
      // exists, so a ground-only restaurant doesn't carry a dead control.
      floorSel = document.createElement("select");
      Object.assign(floorSel.style, {
        flex: "0 0 auto", padding: "3px 4px", borderRadius: "6px", cursor: "pointer",
        background: "rgba(120,180,200,0.18)", color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.22)", font: "inherit", fontSize: "10px", fontWeight: "700",
      } as Partial<CSSStyleDeclaration>);
      for (let idx = 0; idx < numStoreys; idx += 1) {
        const unlocked = idx === 0 || tier >= idx + 1;
        const opt = document.createElement("option");
        opt.value = String(idx);
        opt.textContent = idx === 0 ? "Floor G" : `Floor ${idx}`;
        opt.disabled = !unlocked;
        floorSel.appendChild(opt);
      }
      floorSel.onchange = () => {
        const next = parseInt(floorSel!.value, 10);
        const old = member.homeFloor ?? 0;
        if (next === old) return;
        if (this.game.staff.setMemberHomeFloor(member.id, next)) {
          this.onStaffFloorChanged?.(member.id, old, next);
          this.update();
        }
      };
      attachTooltip(floorSel, `Which floor ${member.name} works on. They'll cook / serve / rest up there.`);
      actions.appendChild(floorSel);
    }

    // TRAIN — per-person, so it lives on the person (was in the Upgrades modal).
    const train = document.createElement("button");
    Object.assign(train.style, {
      flex: "1", minWidth: "0", padding: "4px 5px", borderRadius: "6px",
      cursor: "pointer", font: "inherit", fontSize: "10px", fontWeight: "700",
      background: "rgba(140,170,230,0.24)", color: "#eef3ff",
      border: "1px solid rgba(160,190,240,0.42)", whiteSpace: "nowrap",
      overflow: "hidden", textOverflow: "ellipsis",
    } as Partial<CSSStyleDeclaration>);
    actions.appendChild(train);

    // FIRE / REHIRE
    const fire = document.createElement("button");
    Object.assign(fire.style, {
      flex: "0 0 auto", padding: "4px 7px", borderRadius: "6px", cursor: "pointer",
      font: "inherit", fontSize: "10px", fontWeight: "700", lineHeight: "1.35",
    } as Partial<CSSStyleDeclaration>);
    actions.appendChild(fire);
    body.appendChild(actions);

    const refs: TileRefs = { root: tile, levelChip, status, meta: metaLine, train, fire, floorSel };
    this.tiles.set(member.id, refs);
    this.refreshTile(role, member.id, refs);
    return tile;
  }

  /** Volatile per-tile refresh — runs every tick on the LIVE elements, so no
   * rebuild is needed and no in-flight click is destroyed. */
  private refreshTile(role: StaffRole, memberId: string, refs: TileRefs): void {
    const member = this.game.staff.getMembers(role).find((m) => m.id === memberId);
    if (!member) return;
    const meta = ROLE_META[role];
    const lvl = Math.max(0, member.upgradeLevel | 0);
    const perStaff = this.game.admin.payrollPerStaffPerMinute;

    // Level chip
    refs.levelChip.textContent = `Lv${lvl}`;
    refs.levelChip.style.background = lvl >= 4 ? "rgba(255,200,90,0.35)"
      : lvl >= 2 ? "rgba(170,200,255,0.25)" : "rgba(255,255,255,0.10)";
    refs.levelChip.style.color = "#fff5dc";
    refs.levelChip.style.opacity = lvl === 0 ? "0.6" : "1";
    refs.levelChip.title = `Training level ${lvl} of ${STAFF_UPGRADE_MAX}. Higher = faster work.`;

    // Status pill
    refs.status.innerHTML = "";
    refs.status.appendChild(member.isDeactivated ? this.benchedPill() : this.workStatusPill(role, memberId));

    // Meta line — wage, and the floor when there's no picker to show it.
    const wage = Math.round((perStaff + lvl) * GAME_MINUTES_PER_DAY);
    const floorTxt = this.game.getLuxuryTier() >= 2 ? "" : ` · Floor G`;
    refs.meta.textContent = `${meta.label} · $${wage}/day${floorTxt}`;

    // Floor picker value
    if (refs.floorSel) refs.floorSel.value = String(member.homeFloor ?? 0);

    // Train button
    this.syncTrainBtn(refs.train, memberId, member.name, !!member.isDeactivated);

    // Fire / rehire
    if (member.isDeactivated) {
      refs.fire.textContent = "↺";
      refs.fire.style.background = "rgba(120,200,120,0.30)";
      refs.fire.style.color = "#eaffea";
      refs.fire.style.border = "1px solid rgba(150,230,150,0.55)";
      refs.fire.title = `Rehire ${member.name} — free, resumes their wage.`;
      refs.fire.onclick = () => { if (this.game.reactivateStaffMember(memberId)) this.update(); };
    } else {
      const severance = this.game.staff.getStaffFireCost(role);
      refs.fire.textContent = "✕";
      refs.fire.style.background = "rgba(200,120,120,0.22)";
      refs.fire.style.color = "#fff5dc";
      refs.fire.style.border = "1px solid rgba(255,180,180,0.45)";
      refs.fire.title = `Fire ${member.name} (Lv${lvl} ${meta.label}) — costs ${compactDollars(severance)} severance. Their training is lost.`;
      refs.fire.onclick = () => confirmAction({
        title: `Fire ${member.name}?`,
        message: lvl > 0
          ? `${compactDollars(severance)} severance now.\n\nTheir Lv${lvl} training is lost for good — a replacement ${meta.label} starts back at Lv0.`
          : `${compactDollars(severance)} severance now.\n\nYou can hire another ${meta.label} later at the usual cost.`,
        confirmLabel: `Fire · ${compactDollars(severance)}`,
        danger: true,
        onConfirm: () => { if (this.game.fireStaffMember(memberId)) this.update(); },
      });
    }
  }

  /** Train button state machine: in-progress → maxed → tier-locked → someone
   * else training → affordable / too expensive. */
  private syncTrainBtn(btn: HTMLButtonElement, memberId: string, name: string, benched: boolean): void {
    const level = this.game.getMemberUpgradeLevel(memberId);
    const remaining = this.game.getMemberTrainingRemainingSeconds(memberId);
    const setState = (text: string, enabled: boolean, tip: string, onClick?: () => void): void => {
      btn.textContent = text;
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? "1" : "0.45";
      btn.style.cursor = enabled ? "pointer" : "not-allowed";
      btn.onclick = enabled && onClick ? onClick : null;
      btn.title = tip;
    };

    if (remaining != null && remaining > 0) {
      setState(`📚 ${formatEta(remaining)}`, false, `${name} is at school — ${formatEta(remaining)} left. Training runs in real time, even offline.`);
      return;
    }
    if (level >= STAFF_UPGRADE_MAX) {
      setState("★ Maxed", false, `${name} is fully trained (Lv${STAFF_UPGRADE_MAX}) — as fast as they get.`);
      return;
    }
    const target = level + 1;
    const hours = getTrainingDurationHours(target);
    const requiredTier = this.game.getMemberUpgradeRequiredTier(memberId);
    const playerTier = this.game.getLuxuryTier();
    if (requiredTier !== null && requiredTier > playerTier) {
      // Tier-locked → clickable, opens the shared unlock gate.
      setState(`🔒 T${requiredTier}`, true,
        `Training to Lv${target} needs restaurant Tier ${requiredTier} (you're on ${playerTier}). Click to unlock.`,
        () => showTierGate(this.game, requiredTier, () => this.update()));
      return;
    }
    if (benched) {
      setState("📚 Benched", false, `${name} is benched — rehire them before training.`);
      return;
    }
    const otherId = this.game.getCurrentlyTrainingMemberId();
    if (otherId !== null && otherId !== memberId) {
      const other = this.game.staff.getMember(otherId);
      setState("📚 Busy", false, other
        ? `The school only has one chair — ${other.name} is training right now.`
        : "Someone else is training right now.");
      return;
    }
    const cost = this.game.getMemberUpgradeCost(memberId);
    const can = this.game.canUpgradeMember(memberId);
    setState(`📚 ${compactDollars(cost)}`, can,
      can
        ? `Train ${name} to Lv${target} — ${compactDollars(cost)} and ${hours}h of real time. Raises their speed permanently.`
        : `Need ${compactDollars(cost)} to train ${name} to Lv${target}.`,
      () => { if (this.game.upgradeMember(memberId)) this.update(); });
  }

  private benchedPill(): HTMLElement {
    const pill = document.createElement("span");
    pill.textContent = "🪑 Benched — not working";
    Object.assign(pill.style, {
      display: "inline-block", maxWidth: "100%", padding: "4px 8px", borderRadius: "7px",
      fontSize: "10.5px", fontWeight: "600",
      background: "rgba(255,190,90,0.18)", color: "rgba(255,225,170,0.95)",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    } as Partial<CSSStyleDeclaration>);
    pill.title = "Benched because you ran out of money. Rehire (↺) when you can afford the wage again.";
    return pill;
  }

  /** Icon + plain-language line of what they're doing right now, coloured
   * green → amber → red by load. Idle gets a quiet grey pill. */
  private workStatusPill(role: StaffRole, memberId: string): HTMLElement {
    const info = this.workloadBadgeInfo(role, memberId);
    const n = info?.count ?? 0;
    const pill = document.createElement("span");
    Object.assign(pill.style, {
      display: "flex", alignItems: "center", gap: "5px", maxWidth: "100%",
      padding: "4px 8px", borderRadius: "7px", fontSize: "10.5px", fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    const emoji = document.createElement("span");
    Object.assign(emoji.style, { fontSize: "12px", flex: "0 0 auto" } as Partial<CSSStyleDeclaration>);
    const desc = document.createElement("span");
    Object.assign(desc.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as Partial<CSSStyleDeclaration>);
    if (!info || n === 0) {
      emoji.textContent = "💤";
      desc.textContent = role === "errand" ? "Idle at the counter" : "Idle";
      Object.assign(pill.style, { background: "rgba(255,255,255,0.06)", color: "rgba(255,245,220,0.6)", fontWeight: "500" });
      if (info) pill.title = info.tooltip;
    } else {
      emoji.textContent = info.emoji;
      desc.textContent = this.workDescription(role, memberId, n);
      pill.style.background = n >= 5 ? "rgba(220,80,80,0.5)" : n >= 3 ? "rgba(220,170,80,0.42)" : "rgba(120,200,120,0.34)";
      pill.style.color = "#fff5dc";
      pill.title = info.tooltip;
    }
    pill.append(emoji, desc);
    return pill;
  }

  /** Per-role workload accessor + tooltip. */
  private workloadBadgeInfo(role: StaffRole, memberId: string): { emoji: string; count: number; tooltip: string } | null {
    switch (role) {
      case "chef": {
        const n = this.game.getChefBacklog?.(memberId) ?? 0;
        return { emoji: "🍳", count: n, tooltip:
          `${n} ticket(s) in this chef's backlog (queued + cooking). Hire another chef if it stays high.` };
      }
      case "barman": {
        const n = this.game.getBarmanBacklog?.(memberId) ?? 0;
        return { emoji: "🍸", count: n, tooltip: `${n} drink(s) queued or being mixed.` };
      }
      case "waiter": {
        const n = this.game.getWaiterBacklog?.(memberId) ?? 0;
        return { emoji: "🍽", count: n, tooltip:
          `${n} active task(s) — delivery, wash trip and take-order all count.` };
      }
      case "errand": {
        const n = this.game.getErrandBacklog?.(memberId) ?? 0;
        const trip = this.game.getErrandTripSummary?.(memberId) ?? "";
        return { emoji: "📦", count: n, tooltip:
          n > 0 ? (trip ? `Bringing back: ${trip}.` : "On a shopping trip.") : "Idle by the supply counter." };
      }
      default: return null;
    }
  }

  private workDescription(role: StaffRole, memberId: string, n: number): string {
    switch (role) {
      case "chef": return `Cooking · ${n}`;
      case "barman": return `Mixing · ${n}`;
      case "waiter": return `Serving · ${n}`;
      case "errand": {
        const trip = this.game.getErrandTripSummary?.(memberId) ?? "";
        return trip ? `Fetching ${trip}` : "Shopping";
      }
      default: return `Working · ${n}`;
    }
  }

  // ── FOOTER ──────────────────────────────────────────────────

  /** Engine calls this after a hydrate / set / clear so the label reflects the
   * live cloud value. */
  setWaiterRestStatus(spot: { x: number; z: number; floor: number } | null): void {
    if (!this.waiterRestLabel) return;
    this.waiterRestLabel.textContent = spot
      ? `📍 Waiter rest: ${spot.floor === 0 ? "G" : `F${spot.floor}`} (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)})`
      : "📍 Waiter rest: not set";
  }

  private syncFooter(): void {
    const perStaff = this.game.admin.payrollPerStaffPerMinute;
    let totalCount = 0;
    let totalPayroll = 0;
    for (const role of ROLES) {
      totalCount += this.game.staff.getStaffCount(role);
      totalPayroll += this.game.staff.getRolePayrollPerMinute(role, perStaff);
    }
    if (totalCount === 0) {
      this.payrollLine.textContent = "No staff hired — guests wait forever.";
      return;
    }
    const stats = this.game.getTicketStats?.();
    const pending = stats ? stats.queued + stats.cooking + stats.ready + stats.delivering : 0;
    const flow = stats && pending > 0
      ? ` · 📋 ${stats.queued} queued · 🍳 ${stats.cooking} cooking · 🍽 ${stats.delivering + stats.ready} out`
      : " · no pending tickets";
    this.payrollLine.textContent =
      `${totalCount} on payroll · $${Math.round(totalPayroll * GAME_MINUTES_PER_DAY)}/day${flow}`;
    // Waiter rest spot only matters once a waiter exists.
    this.restRow.style.display = this.game.staff.getStaffCount("waiter") > 0 ? "flex" : "none";
  }

  /** Host modal calls this on show / hide. The portrait render loop only runs
   * while the panel is actually on screen, so a closed Staff menu costs nothing. */
  setVisible(on: boolean): void {
    if (on) { this.update(); this.portraits.start(); }
    else this.portraits.stop();
  }

  dispose(): void { this.portraits.dispose(); }

  update(): void {
    this.syncHireBar();
    this.rebuildGridIfNeeded();
    for (const role of ROLES) {
      for (const m of this.game.staff.getMembers(role)) {
        const refs = this.tiles.get(m.id);
        if (refs) this.refreshTile(role, m.id, refs);
      }
    }
    this.syncFooter();
  }
}
