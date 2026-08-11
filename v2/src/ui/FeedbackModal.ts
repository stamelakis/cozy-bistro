/**
 * Beta feedback — the "💬 Feedback" modal. Category chips + a textarea +
 * send. Submissions go to the server `feedback` table (submit_feedback,
 * rate-limited to one per minute, 500 chars) where the admin inbox reads
 * them. Deliberately tiny: the lower the friction, the more testers talk.
 */

import type { SpacetimeClient } from "../cloud/SpacetimeClient";
import { showEventBanner } from "./uiHints";

const CATEGORIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "bug", label: "🐛 Bug" },
  { id: "idea", label: "💡 Idea" },
  { id: "other", label: "💬 Other" },
];

export class FeedbackModal {
  private readonly root: HTMLDivElement;
  private readonly textarea: HTMLTextAreaElement;
  private category = "bug";
  private lastSentAt = 0;

  constructor(parent: HTMLElement, private readonly cloud: SpacetimeClient) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      inset: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0, 0, 0, 0.55)",
      zIndex: "40",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.hide();
    });

    const card = document.createElement("div");
    Object.assign(card.style, {
      width: "min(420px, calc(100vw - 32px))",
      background: "rgba(28, 20, 14, 0.97)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.5)",
      borderRadius: "12px",
      padding: "16px",
      font: "13px/1.5 system-ui, sans-serif",
      boxShadow: "0 8px 30px rgba(0, 0, 0, 0.6)",
    } as Partial<CSSStyleDeclaration>);

    const title = document.createElement("div");
    title.textContent = "💬 Tell us what you think";
    Object.assign(title.style, { fontSize: "16px", fontWeight: "700", marginBottom: "4px" } as Partial<CSSStyleDeclaration>);
    card.appendChild(title);
    const sub = document.createElement("div");
    sub.textContent = "Bugs, ideas, anything — it lands straight on the dev's desk.";
    Object.assign(sub.style, { opacity: "0.7", fontSize: "12px", marginBottom: "10px" } as Partial<CSSStyleDeclaration>);
    card.appendChild(sub);

    const chips = document.createElement("div");
    Object.assign(chips.style, { display: "flex", gap: "6px", marginBottom: "10px" } as Partial<CSSStyleDeclaration>);
    const chipEls = new Map<string, HTMLButtonElement>();
    for (const c of CATEGORIES) {
      const chip = document.createElement("button");
      chip.textContent = c.label;
      Object.assign(chip.style, {
        border: "1px solid rgba(255, 220, 150, 0.5)",
        borderRadius: "14px",
        padding: "4px 12px",
        cursor: "pointer",
        font: "inherit",
        fontSize: "12px",
        color: "#fff5dc",
      } as Partial<CSSStyleDeclaration>);
      chip.onclick = () => {
        this.category = c.id;
        for (const [id, el] of chipEls) {
          el.style.background = id === c.id ? "rgba(255, 217, 134, 0.3)" : "rgba(255, 245, 220, 0.06)";
        }
      };
      chipEls.set(c.id, chip);
      chips.appendChild(chip);
    }
    chipEls.get("bug")!.style.background = "rgba(255, 217, 134, 0.3)";
    for (const [id, el] of chipEls) {
      if (id !== "bug") el.style.background = "rgba(255, 245, 220, 0.06)";
    }
    card.appendChild(chips);

    this.textarea = document.createElement("textarea");
    this.textarea.maxLength = 500;
    this.textarea.placeholder = "What happened / what would make the game better?";
    Object.assign(this.textarea.style, {
      width: "100%",
      minHeight: "90px",
      resize: "vertical",
      background: "rgba(255, 245, 220, 0.08)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 245, 220, 0.25)",
      borderRadius: "6px",
      padding: "8px",
      font: "inherit",
      boxSizing: "border-box",
      marginBottom: "10px",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(this.textarea);

    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", justifyContent: "flex-end" } as Partial<CSSStyleDeclaration>);
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    Object.assign(cancel.style, {
      background: "rgba(255, 245, 220, 0.08)", color: "#fff5dc",
      border: "1px solid rgba(255, 245, 220, 0.3)", borderRadius: "6px",
      padding: "6px 14px", cursor: "pointer", font: "inherit",
    } as Partial<CSSStyleDeclaration>);
    cancel.onclick = () => this.hide();
    const send = document.createElement("button");
    send.textContent = "Send";
    Object.assign(send.style, {
      background: "rgba(120, 200, 120, 0.3)", color: "#d8ffd8",
      border: "1px solid rgba(120, 200, 120, 0.6)", borderRadius: "6px",
      padding: "6px 18px", cursor: "pointer", font: "inherit", fontWeight: "700",
    } as Partial<CSSStyleDeclaration>);
    send.onclick = () => this.send();
    row.appendChild(cancel);
    row.appendChild(send);
    card.appendChild(row);
    this.root.appendChild(card);
    parent.appendChild(this.root);
  }

  show(): void {
    this.root.style.display = "flex";
    this.textarea.focus();
  }

  hide(): void {
    this.root.style.display = "none";
  }

  private send(): void {
    const msg = this.textarea.value.trim();
    if (msg.length < 3) {
      showEventBanner("Tell us a little more first 🙂", { icon: "💬", ms: 2200 });
      return;
    }
    // Mirror the server's one-per-minute limit so honest users get a
    // friendly message instead of a silently-dropped note.
    if (Date.now() - this.lastSentAt < 60_000) {
      showEventBanner("One note per minute — hold that thought!", { icon: "⏳", ms: 2600 });
      return;
    }
    this.cloud.submitFeedback(this.category, msg);
    this.lastSentAt = Date.now();
    this.textarea.value = "";
    this.hide();
    showEventBanner("Thanks — feedback sent! 💛", { icon: "💬", accent: "#9fe09f", ms: 2800 });
  }
}
