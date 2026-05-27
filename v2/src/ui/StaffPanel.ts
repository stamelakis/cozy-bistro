import type { Game } from "../game/Game";
import type { StaffRole } from "../systems/StaffSystem";

/**
 * Bottom-left panel showing current staff counts + hire/fire buttons per
 * role. Hiring costs money up front, then payroll ticks per minute via
 * Game.update(). Firing has a small severance cost.
 */
export class StaffPanel {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private readonly rows: Record<StaffRole, { count: HTMLElement; hire: HTMLButtonElement; fire: HTMLButtonElement }> = {} as Record<StaffRole, { count: HTMLElement; hire: HTMLButtonElement; fire: HTMLButtonElement }>;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      left: "12px",
      bottom: "12px",
      padding: "10px 12px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "8px",
      minWidth: "220px",
      pointerEvents: "none",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const title = document.createElement("div");
    title.textContent = "STAFF";
    Object.assign(title.style, { fontWeight: "600", fontSize: "13px", marginBottom: "6px" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(title);

    (["chef", "waiter", "errand"] as StaffRole[]).forEach((role) => this.addRow(role));
  }

  private addRow(role: StaffRole): void {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" } as Partial<CSSStyleDeclaration>);
    const count = document.createElement("span");
    count.style.flex = "1";
    const hire = this.makeBtn("+", "rgba(120,200,120,0.18)");
    const fire = this.makeBtn("−", "rgba(200,120,120,0.18)");
    hire.onclick = () => this.tryHire(role);
    fire.onclick = () => this.tryFire(role);
    row.appendChild(count);
    row.appendChild(hire);
    row.appendChild(fire);
    this.root.appendChild(row);
    this.rows[role] = { count, hire, fire };
  }

  private makeBtn(label: string, bg: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      width: "28px", height: "24px",
      background: bg, color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)", borderRadius: "4px",
      cursor: "pointer", pointerEvents: "auto", font: "inherit",
    } as Partial<CSSStyleDeclaration>);
    return b;
  }

  private tryHire(role: StaffRole): void {
    // Game.hireStaff handles the economy + staff system + onStaffHired
    // callback so the Engine can spawn the actual world character.
    if (this.game.hireStaff(role)) this.update();
  }

  private tryFire(role: StaffRole): void {
    if (this.game.fireStaff(role)) this.update();
  }

  update(): void {
    (["chef", "waiter", "errand"] as StaffRole[]).forEach((role) => {
      const count = this.game.staff.getStaffCount(role);
      const hireCost = this.game.staff.getStaffHireCost(role);
      const fireCost = this.game.staff.getStaffFireCost(role);
      const label = this.game.staff.getStaffRoleLabel(role);
      this.rows[role].count.textContent = `${label}: ${count}`;
      this.rows[role].hire.title = `Hire ${label} ($${hireCost})`;
      this.rows[role].fire.title = `Fire ${label} ($${fireCost})`;
      this.rows[role].fire.disabled = count === 0;
      this.rows[role].fire.style.opacity = count === 0 ? "0.4" : "1";
    });
  }
}
