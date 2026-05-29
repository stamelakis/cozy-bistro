import type { Game } from "../game/Game";
import {
  FONT_FAMILIES, FONT_LABELS, TEXT_COLORS,
  PLAQUE_BG, PLAQUE_FRAME, PLAQUE_LABELS,
} from "../scene/WorldScene";

/**
 * Restaurant-name plaque editor. Opens when the player clicks the door
 * plaque. The modal shows:
 *
 *   - A live PREVIEW canvas painted with the current name + style so
 *     edits show immediately, no save round-trip.
 *   - A text input for the restaurant name (28 char cap, like the
 *     game state's truncation).
 *   - Four radio rows: font family, text colour, plaque background,
 *     each styled to LOOK like the option they represent (font radios
 *     render in their own font, colour swatches in their colour, etc.)
 *
 * Save commits the name + style to the Game (which fires the scene
 * callback so the world plaque updates) and closes the modal.
 */

const COLOUR_SWATCH_BORDER = "1px solid rgba(255,245,220,0.25)";

function intToHex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

export class RestaurantSignModal {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private name = "";
  private style = { font: "serif", textColor: "cream", plaqueStyle: "dark" };
  private previewCanvas?: HTMLCanvasElement;
  private nameInput?: HTMLInputElement;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed", top: "0", left: "0",
      width: "100vw", height: "100vh",
      display: "none",
      alignItems: "center", justifyContent: "center",
      background: "rgba(0, 0, 0, 0.55)",
      zIndex: "1000",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.hide(); });
    parent.appendChild(this.root);
    this.buildBody();
  }

  show(): void {
    // Seed the live state from the current Game state every time the
    // player opens the modal so a previously-cancelled edit doesn't
    // leak into a fresh session.
    this.name = this.game.getRestaurantName();
    this.style = this.game.getRestaurantSignStyle();
    if (this.nameInput) this.nameInput.value = this.name;
    this.refreshSelections();
    this.repaintPreview();
    this.root.style.display = "flex";
  }
  hide(): void {
    this.root.style.display = "none";
  }

  private buildBody(): void {
    const body = document.createElement("div");
    Object.assign(body.style, {
      width: "min(520px, calc(100vw - 32px))",
      maxHeight: "90vh", overflowY: "auto",
      padding: "20px 22px",
      background: "rgba(28, 22, 16, 0.96)",
      color: "#fff5dc",
      font: "13px/1.4 system-ui, sans-serif",
      borderRadius: "10px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
      border: "1px solid rgba(255,245,220,0.18)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(body);

    // === Header ===
    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      marginBottom: "12px",
    } as Partial<CSSStyleDeclaration>);
    const title = document.createElement("div");
    title.textContent = "🪧 RESTAURANT SIGN";
    Object.assign(title.style, {
      fontWeight: "700", fontSize: "15px", letterSpacing: "0.06em",
    } as Partial<CSSStyleDeclaration>);
    header.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
      background: "transparent", border: "none", color: "#fff5dc",
      fontSize: "18px", cursor: "pointer",
    } as Partial<CSSStyleDeclaration>);
    closeBtn.onclick = () => this.hide();
    header.appendChild(closeBtn);
    body.appendChild(header);

    // === Live preview canvas ===
    this.previewCanvas = document.createElement("canvas");
    this.previewCanvas.width = 480;
    this.previewCanvas.height = 200;
    Object.assign(this.previewCanvas.style, {
      display: "block",
      width: "100%",
      maxWidth: "480px",
      margin: "0 auto 14px",
      borderRadius: "6px",
    } as Partial<CSSStyleDeclaration>);
    body.appendChild(this.previewCanvas);

    // === Name input ===
    const nameLabel = this.section("Name");
    body.appendChild(nameLabel);
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 28;
    input.placeholder = "Cozy Bistro";
    Object.assign(input.style, {
      display: "block", width: "100%", boxSizing: "border-box",
      padding: "8px 10px",
      background: "rgba(255,245,220,0.08)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.22)",
      borderRadius: "5px",
      font: "inherit", fontSize: "14px",
      marginBottom: "14px",
    } as Partial<CSSStyleDeclaration>);
    input.oninput = () => {
      this.name = input.value;
      this.repaintPreview();
    };
    body.appendChild(input);
    this.nameInput = input;

    // === Font ===
    body.appendChild(this.section("Font"));
    body.appendChild(this.buildFontRow());

    // === Text colour ===
    body.appendChild(this.section("Text colour"));
    body.appendChild(this.buildTextColorRow());

    // === Plaque style ===
    body.appendChild(this.section("Plaque style"));
    body.appendChild(this.buildPlaqueRow());

    // === Save button ===
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "✓  Save";
    Object.assign(saveBtn.style, {
      display: "block", width: "100%",
      marginTop: "18px",
      padding: "10px 12px",
      background: "rgba(120, 200, 120, 0.30)",
      color: "#fff5dc",
      border: "1px solid rgba(255,245,220,0.28)",
      borderRadius: "5px",
      cursor: "pointer", font: "inherit", fontSize: "14px",
      fontWeight: "700",
    } as Partial<CSSStyleDeclaration>);
    saveBtn.onclick = () => {
      this.game.setRestaurantSign(this.name, this.style);
      this.hide();
    };
    body.appendChild(saveBtn);
  }

  private section(label: string): HTMLElement {
    const el = document.createElement("div");
    el.textContent = label.toUpperCase();
    Object.assign(el.style, {
      fontSize: "10px", fontWeight: "700",
      letterSpacing: "0.08em", opacity: "0.65",
      marginBottom: "4px", textTransform: "uppercase",
    } as Partial<CSSStyleDeclaration>);
    return el;
  }

  private buildFontRow(): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(2, 1fr)",
      gap: "5px", marginBottom: "14px",
    } as Partial<CSSStyleDeclaration>);
    for (const id of Object.keys(FONT_FAMILIES)) {
      const btn = document.createElement("button");
      btn.dataset["fontId"] = id;
      btn.textContent = FONT_LABELS[id];
      Object.assign(btn.style, {
        padding: "8px 10px",
        background: "rgba(255,245,220,0.06)",
        color: "#fff5dc",
        border: "1px solid rgba(255,245,220,0.18)",
        borderRadius: "5px", cursor: "pointer",
        font: `700 14px ${FONT_FAMILIES[id]}`,
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => { this.style.font = id; this.refreshSelections(); this.repaintPreview(); };
      row.appendChild(btn);
    }
    return row;
  }

  private buildTextColorRow(): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(6, 1fr)",
      gap: "5px", marginBottom: "14px",
    } as Partial<CSSStyleDeclaration>);
    for (const id of Object.keys(TEXT_COLORS)) {
      const btn = document.createElement("button");
      btn.dataset["colorId"] = id;
      Object.assign(btn.style, {
        height: "36px",
        background: TEXT_COLORS[id],
        border: COLOUR_SWATCH_BORDER,
        borderRadius: "5px", cursor: "pointer",
      } as Partial<CSSStyleDeclaration>);
      btn.title = id;
      btn.onclick = () => { this.style.textColor = id; this.refreshSelections(); this.repaintPreview(); };
      row.appendChild(btn);
    }
    return row;
  }

  private buildPlaqueRow(): HTMLElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid", gridTemplateColumns: "repeat(2, 1fr)",
      gap: "5px", marginBottom: "6px",
    } as Partial<CSSStyleDeclaration>);
    for (const id of Object.keys(PLAQUE_BG)) {
      const btn = document.createElement("button");
      btn.dataset["plaqueId"] = id;
      btn.textContent = PLAQUE_LABELS[id];
      Object.assign(btn.style, {
        padding: "10px 8px",
        background: PLAQUE_BG[id],
        color: "#fff5dc",
        border: `2px solid ${intToHex(PLAQUE_FRAME[id])}`,
        borderRadius: "5px", cursor: "pointer",
        font: "inherit", fontSize: "12px", fontWeight: "700",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => { this.style.plaqueStyle = id; this.refreshSelections(); this.repaintPreview(); };
      row.appendChild(btn);
    }
    return row;
  }

  /** Re-highlight the currently-selected radio in each row. Cheap; runs
   * on every option change. */
  private refreshSelections(): void {
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>("[data-font-id]")) {
      const on = btn.dataset["fontId"] === this.style.font;
      btn.style.outline = on ? "2px solid #f5c14a" : "none";
      btn.style.background = on ? "rgba(245, 193, 74, 0.18)" : "rgba(255,245,220,0.06)";
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>("[data-color-id]")) {
      const on = btn.dataset["colorId"] === this.style.textColor;
      btn.style.outline = on ? "3px solid #fff5dc" : COLOUR_SWATCH_BORDER;
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>("[data-plaque-id]")) {
      const on = btn.dataset["plaqueId"] === this.style.plaqueStyle;
      btn.style.outline = on ? "2px solid #f5c14a" : "none";
    }
  }

  /** Repaint the preview canvas with the current name + style. Same
   * recipe as WorldScene.repaintSignCanvas so the player sees exactly
   * what the in-world plaque will look like. */
  private repaintPreview(): void {
    if (!this.previewCanvas) return;
    const ctx = this.previewCanvas.getContext("2d");
    if (!ctx) return;
    const w = this.previewCanvas.width;
    const h = this.previewCanvas.height;
    const bg = PLAQUE_BG[this.style.plaqueStyle] ?? PLAQUE_BG.dark;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const accent = TEXT_COLORS[this.style.textColor] ?? TEXT_COLORS.cream;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.strokeRect(12, 12, w - 24, h - 24);
    ctx.fillStyle = accent;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fontFamily = FONT_FAMILIES[this.style.font] ?? FONT_FAMILIES.serif;
    const fontWeight = this.style.font === "display" ? "900" : "700";
    let size = 80;
    const display = this.name.trim().length > 0 ? this.name : "Cozy Bistro";
    do {
      ctx.font = `${fontWeight} ${size}px ${fontFamily}`;
      if (ctx.measureText(display).width < w - 50) break;
      size -= 4;
    } while (size > 24);
    ctx.fillText(display, w / 2, h / 2 + 4);
  }
}
