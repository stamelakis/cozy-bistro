import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";

/**
 * Recipe menu picker (center-bottom). Lists every unlocked recipe with
 * a checkbox; toggling it adds/removes from the live menu. Guests can
 * only order recipes that are currently on the menu.
 *
 * Collapsible so it doesn't dominate the screen — click the title to
 * expand.
 */
export class MenuPanel {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private collapsed = true;

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      left: "50%",
      transform: "translateX(-50%)",
      bottom: "12px",
      maxWidth: "640px",
      width: "min(640px, calc(100vw - 480px))",
      padding: "8px 12px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "8px",
      pointerEvents: "auto",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
      cursor: "pointer",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const title = document.createElement("div");
    title.textContent = "MENU ▾  (click to expand)";
    Object.assign(title.style, { fontWeight: "600", fontSize: "13px" } as Partial<CSSStyleDeclaration>);
    title.onclick = () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? "none" : "grid";
      title.textContent = this.collapsed ? "MENU ▾  (click to expand)" : "MENU ▴  (click to collapse)";
    };
    this.root.appendChild(title);

    this.body = document.createElement("div");
    Object.assign(this.body.style, {
      display: "none",
      gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
      gap: "4px 12px",
      marginTop: "8px",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);
  }

  update(): void {
    const unlocked = this.game.cooking.getUnlockedRecipeIds();
    const onMenu = new Set(this.game.cooking.getMenuRecipeIds());
    if (this.body.children.length !== unlocked.length) {
      this.body.innerHTML = "";
      for (const id of unlocked) {
        const recipe = recipes.find((r) => r.id === id);
        if (!recipe) continue;
        const label = document.createElement("label");
        Object.assign(label.style, { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" } as Partial<CSSStyleDeclaration>);
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.id = id;
        cb.checked = onMenu.has(id);
        cb.onchange = (e) => {
          e.stopPropagation();
          const checked = (cb).checked;
          if (checked) this.game.cooking.addToMenu(id);
          else this.game.cooking.removeFromMenu(id);
        };
        const text = document.createElement("span");
        text.textContent = `${recipe.name} ($${recipe.sellPrice})`;
        text.style.flex = "1";
        const cat = document.createElement("span");
        cat.textContent = recipe.category[0].toUpperCase();
        Object.assign(cat.style, {
          fontSize: "10px", padding: "1px 5px", borderRadius: "3px",
          background: this.colorForCategory(recipe.category), color: "#1b1410",
        } as Partial<CSSStyleDeclaration>);
        label.appendChild(cb);
        label.appendChild(text);
        label.appendChild(cat);
        this.body.appendChild(label);
      }
    }
    // Refresh checkboxes (in case other systems toggled them).
    Array.from(this.body.querySelectorAll("input[type=checkbox]")).forEach((cb) => {
      const id = (cb as HTMLInputElement).dataset.id!;
      (cb as HTMLInputElement).checked = onMenu.has(id);
    });
  }

  private colorForCategory(c: string): string {
    return c === "appetizer" ? "#f6d36a"
      : c === "main"      ? "#f0a070"
      : c === "dessert"   ? "#f0a0d0"
      : c === "drink"     ? "#a0d8f0"
      : "#cccccc"; // side
  }
}
