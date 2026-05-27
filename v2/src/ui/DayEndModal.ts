import type { DayEndSummary } from "../game/Game";

/**
 * Full-screen modal that pops up when a day rolls over. Shows a recap of
 * the day's revenue, expenses, guests served/lost, and current rating.
 * Player clicks "Continue" to dismiss; the game keeps running underneath
 * so nothing pauses.
 *
 * Auto-dismisses after 8 seconds so an AFK player doesn't get a stack of
 * modals if they leave the tab open overnight.
 */

const AUTO_DISMISS_SECONDS = 8;

export class DayEndModal {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private dismissTimer: number | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0, 0, 0, 0.45)",
      zIndex: "1000",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    this.body = document.createElement("div");
    Object.assign(this.body.style, {
      minWidth: "360px",
      padding: "20px 26px",
      background: "rgba(28, 20, 14, 0.96)",
      color: "#fff5dc",
      font: "13px/1.4 system-ui, sans-serif",
      borderRadius: "12px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);
  }

  show(summary: DayEndSummary): void {
    if (this.dismissTimer != null) {
      window.clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    this.body.innerHTML = "";

    const title = document.createElement("div");
    title.textContent = `Day ${summary.dayNumber} ended`;
    Object.assign(title.style, {
      fontSize: "20px",
      fontWeight: "700",
      marginBottom: "12px",
      letterSpacing: "0.04em",
    } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(title);

    const netSign = summary.net >= 0 ? "+" : "-";
    const netColor = summary.net >= 0 ? "#a8e2a8" : "#f0a8a8";
    const stats: { label: string; value: string; color?: string }[] = [
      { label: "Guests served", value: `${summary.served}` },
      { label: "Guests lost", value: `${summary.lost}` },
      { label: "Revenue", value: `$${summary.revenue}`, color: "#a8e2a8" },
      { label: "Expenses", value: `$${summary.expenses}`, color: "#f0c8a0" },
      { label: "Net", value: `${netSign}$${Math.abs(summary.net)}`, color: netColor },
      { label: "Rating", value: `${summary.rating.toFixed(2)} ★` },
    ];
    for (const stat of stats) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        justifyContent: "space-between",
        gap: "20px",
        padding: "4px 8px",
        borderBottom: "1px solid rgba(255,245,220,0.08)",
      } as Partial<CSSStyleDeclaration>);
      const left = document.createElement("span");
      left.textContent = stat.label;
      left.style.opacity = "0.8";
      const right = document.createElement("span");
      right.textContent = stat.value;
      right.style.fontWeight = "600";
      if (stat.color) right.style.color = stat.color;
      row.appendChild(left);
      row.appendChild(right);
      this.body.appendChild(row);
    }

    const continueBtn = document.createElement("button");
    continueBtn.textContent = `Continue to day ${summary.dayNumber + 1}`;
    Object.assign(continueBtn.style, {
      marginTop: "16px",
      padding: "8px 18px",
      background: "rgba(120, 200, 120, 0.25)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.4)",
      borderRadius: "6px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "13px",
      fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    continueBtn.onclick = () => this.hide();
    this.body.appendChild(continueBtn);

    this.root.style.display = "flex";
    // Safety: auto-dismiss so an AFK player isn't blocked by a stack of these.
    this.dismissTimer = window.setTimeout(() => this.hide(), AUTO_DISMISS_SECONDS * 1000);
  }

  private hide(): void {
    this.root.style.display = "none";
    if (this.dismissTimer != null) {
      window.clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }
}
