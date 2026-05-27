import { SaveSystem, type SlotInfo } from "../game/SaveSystem";

/**
 * Save-slots picker. Shows the 3 slots with their stored money / day /
 * last-saved timestamp. Switching slots reloads the page so the new
 * slot becomes active. Deleting a slot wipes its key but does NOT
 * reload (so the current game in another slot keeps running).
 */

export class SlotsModal {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly currentSlot: number;

  constructor(parent: HTMLElement, currentSlot: number) {
    this.currentSlot = currentSlot;
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
      width: "min(440px, calc(100vw - 40px))",
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
    title.textContent = "SAVE SLOTS";
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

    this.body = document.createElement("div");
    Object.assign(this.body.style, { display: "flex", flexDirection: "column", gap: "8px" } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.body);
  }

  show(): void { this.refresh(); this.root.style.display = "flex"; }
  hide(): void { this.root.style.display = "none"; }

  private refresh(): void {
    this.body.innerHTML = "";
    const slots = SaveSystem.listSlots();
    for (const slot of slots) {
      this.body.appendChild(this.renderSlot(slot));
    }
  }

  private renderSlot(info: SlotInfo): HTMLElement {
    const isActive = info.slot === this.currentSlot;
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex", gap: "10px", alignItems: "center",
      padding: "10px 12px",
      background: isActive ? "rgba(120, 200, 120, 0.15)" : "rgba(255,245,220,0.06)",
      borderRadius: "6px",
      border: isActive ? "1px solid rgba(120,200,120,0.55)" : "1px solid transparent",
    } as Partial<CSSStyleDeclaration>);

    const label = document.createElement("div");
    Object.assign(label.style, { flex: "1" } as Partial<CSSStyleDeclaration>);
    const name = document.createElement("div");
    name.textContent = `Slot ${info.slot}${isActive ? " — current" : ""}`;
    Object.assign(name.style, { fontWeight: "700", fontSize: "13px", color: isActive ? "#a8e2a8" : undefined } as Partial<CSSStyleDeclaration>);
    label.appendChild(name);
    const desc = document.createElement("div");
    Object.assign(desc.style, { fontSize: "11px", opacity: "0.8" } as Partial<CSSStyleDeclaration>);
    if (info.exists) {
      const stamp = info.lastSavedAt ? new Date(info.lastSavedAt).toLocaleString() : "—";
      desc.textContent = `Day ${info.day ?? "?"} · $${info.money ?? "?"} · ${stamp}`;
    } else {
      desc.textContent = "Empty slot";
    }
    label.appendChild(desc);
    row.appendChild(label);

    if (!isActive) {
      const switchBtn = document.createElement("button");
      switchBtn.textContent = info.exists ? "Load" : "Start";
      Object.assign(switchBtn.style, {
        padding: "5px 10px",
        background: "rgba(120, 180, 200, 0.25)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.35)",
        borderRadius: "4px",
        cursor: "pointer",
        font: "inherit",
        fontSize: "12px",
      } as Partial<CSSStyleDeclaration>);
      switchBtn.onclick = () => SaveSystem.switchToSlot(info.slot);
      row.appendChild(switchBtn);
    }
    if (info.exists && !isActive) {
      const delBtn = document.createElement("button");
      delBtn.textContent = "🗑";
      Object.assign(delBtn.style, {
        padding: "5px 10px",
        background: "rgba(200, 80, 80, 0.18)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.25)",
        borderRadius: "4px",
        cursor: "pointer",
        font: "inherit",
      } as Partial<CSSStyleDeclaration>);
      delBtn.onclick = () => {
        if (window.confirm(`Delete the save in slot ${info.slot}? This can't be undone.`)) {
          SaveSystem.deleteSlot(info.slot);
          this.refresh();
        }
      };
      row.appendChild(delBtn);
    }
    return row;
  }
}
