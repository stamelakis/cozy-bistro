import type { Game } from "../game/Game";

/**
 * Transaction log viewer — surfaces the EconomySystem's running ledger
 * so the player can see where their money went. Opens from a button in
 * the HUD; click outside or the X to close. Refreshes each open so the
 * most recent entries are always visible.
 *
 * Shows the last 100 entries newest-first. We don't bother streaming
 * live updates because the player only opens this when they want to
 * audit, not to watch in real time.
 */

const MAX_ROWS = 100;

export class LedgerModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
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
    // Click outside the body to dismiss.
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.hide();
    });
    parent.appendChild(this.root);

    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "min(520px, calc(100vw - 40px))",
      maxHeight: "80vh",
      display: "flex",
      flexDirection: "column",
      padding: "16px 20px",
      background: "rgba(28, 20, 14, 0.96)",
      color: "#fff5dc",
      font: "12px/1.4 system-ui, sans-serif",
      borderRadius: "10px",
      border: "2px solid #d8b98f",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "TRANSACTION LEDGER";
    Object.assign(title.style, { fontSize: "16px", fontWeight: "700", letterSpacing: "0.04em" } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    // Buttons (download + close) live together on the right.
    const btnGroup = document.createElement("div");
    Object.assign(btnGroup.style, { display: "flex", gap: "6px" } as Partial<CSSStyleDeclaration>);
    const csvBtn = document.createElement("button");
    csvBtn.textContent = "⬇ CSV";
    Object.assign(csvBtn.style, {
      padding: "0 10px",
      height: "26px",
      background: "rgba(140, 180, 200, 0.25)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px",
    } as Partial<CSSStyleDeclaration>);
    csvBtn.onclick = () => this.downloadCsv();
    btnGroup.appendChild(csvBtn);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.25)",
      borderRadius: "4px",
      width: "26px",
      height: "26px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "13px",
    } as Partial<CSSStyleDeclaration>);
    closeBtn.onclick = () => this.hide();
    btnGroup.appendChild(closeBtn);
    header.appendChild(btnGroup);
    body.appendChild(header);

    this.listEl = document.createElement("div");
    Object.assign(this.listEl.style, {
      flex: "1",
      overflowY: "auto",
      borderTop: "1px solid rgba(255,245,220,0.15)",
      paddingTop: "8px",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.listEl);
  }

  show(): void {
    this.refresh();
    this.root.style.display = "flex";
  }

  hide(): void {
    this.root.style.display = "none";
  }

  /** Build a CSV from the full transaction log and trigger a browser
   * download. Filename includes the current day so multiple exports
   * don't overwrite. */
  private downloadCsv(): void {
    const log = this.game.economy.getTransactionLog();
    const rows: string[] = ["time,iso,transaction,amount,balance"];
    for (const e of log) {
      const iso = new Date(e.at).toISOString();
      const safeTxn = `"${e.transaction.replace(/"/g, '""')}"`;
      rows.push(`${e.at},${iso},${safeTxn},${e.amount},${e.balance}`);
    }
    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const day = this.game.day.getDayNumber();
    a.href = url;
    a.download = `cozy-bistro-ledger-day${day}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private refresh(): void {
    this.listEl.innerHTML = "";
    const log = this.game.economy.getTransactionLog();
    if (log.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No transactions yet.";
      empty.style.opacity = "0.6";
      empty.style.textAlign = "center";
      empty.style.padding = "20px";
      this.listEl.appendChild(empty);
      return;
    }
    // Newest first, capped.
    const entries = log.slice(-MAX_ROWS).reverse();
    for (const entry of entries) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        justifyContent: "space-between",
        gap: "12px",
        padding: "4px 8px",
        borderBottom: "1px solid rgba(255,245,220,0.06)",
      } as Partial<CSSStyleDeclaration>);
      const time = document.createElement("span");
      time.textContent = formatTime(entry.at);
      Object.assign(time.style, { opacity: "0.6", minWidth: "62px" } as Partial<CSSStyleDeclaration>);
      const label = document.createElement("span");
      label.textContent = entry.transaction;
      label.style.flex = "1";
      const balance = document.createElement("span");
      balance.textContent = `bal $${entry.balance}`;
      Object.assign(balance.style, {
        opacity: "0.7",
        fontVariantNumeric: "tabular-nums",
        color: entry.amount >= 0 ? "#a8e2a8" : "#f0c8a0",
      } as Partial<CSSStyleDeclaration>);
      row.appendChild(time);
      row.appendChild(label);
      row.appendChild(balance);
      this.listEl.appendChild(row);
    }
  }
}

/** Format a Date.now() timestamp as HH:MM:SS. */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
