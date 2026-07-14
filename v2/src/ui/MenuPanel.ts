import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier, maxActiveRecipesPerCategory } from "../systems/CookingSystem";
import { APPLIANCE_LABELS } from "../data/types";
import type { ApplianceId, RecipeDefinition } from "../data/types";
import { attachTooltip } from "./tooltip";
import { recipeIcon, ingredientIcon, recipeImage } from "./foodIcons";

/** Display order + labels for the five courses. Swiping up / down the
 * carousel moves between these; the internal category keys are singular
 * ("appetizer"/"main"/…) so we map them to plural course headers here. */
const COURSES: { key: RecipeDefinition["category"]; label: string }[] = [
  { key: "appetizer", label: "Appetizers" },
  { key: "main",      label: "Mains"      },
  { key: "side",      label: "Sides"      },
  { key: "dessert",   label: "Desserts"   },
  { key: "drink",     label: "Drinks"     },
];

interface Course {
  key: RecipeDefinition["category"];
  label: string;
  dishes: RecipeDefinition[];
}

/**
 * Recipe menu — a focused carousel (replaces the old tier-tab list).
 *
 * One dish sits front-and-centre with its plate art; the neighbours
 * peek at the edges. Swipe / arrow LEFT-RIGHT to move through the
 * course (dishes run Tier 1 → Tier 5 as you go right); the big course
 * buttons (or swipe UP-DOWN) move between courses. Everything about
 * the focused dish — price, profit, guest-joy, ingredients, the
 * appliance it needs, and its on-menu toggle — sits directly below.
 *
 * Collapsed by default — click the title to expand.
 */
export class MenuPanel {
  private readonly game: Game;
  private readonly onUpgrade?: () => void;
  readonly root: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly body: HTMLElement;

  /** Precomputed per-course dish lists, deduped by id and sorted
   * Tier 1 → 5. `getRecipeLuxuryTier` is a pure function of the recipe
   * definition, so this never changes at runtime and is built once. */
  private readonly courses: Course[];

  private collapsed = true;
  private ci = 0; // course index (0..4)
  private di = 0; // dish index within the course

  // Persistent element refs — built once, mutated by render(). Keeping
  // the interactive controls (arrows, course buttons, toggle, upgrade)
  // stable means a click can never race with a re-render tearing the
  // button out from under the pointer.
  private catnameEl!: HTMLElement;
  private catposEl!: HTMLElement;
  private upLbl!: HTMLElement;
  private dnLbl!: HTMLElement;
  private tierBadge!: HTMLElement;
  private focusWrap!: HTMLElement;
  private focusImg!: HTMLImageElement;
  private focusEmoji!: HTMLElement;
  private peekL!: HTMLImageElement;
  private peekR!: HTMLImageElement;
  private arrowL!: HTMLElement;
  private arrowR!: HTMLElement;
  private lockov!: HTMLElement;
  private rail!: HTMLElement;
  private fname!: HTMLElement;
  private dots!: HTMLElement;
  private tog!: HTMLButtonElement;
  private detailDyn!: HTMLElement;
  private upBtn!: HTMLButtonElement;

  /** Lazily-built "Your menu" customer-view overlay (backdrop + content host). */
  private customerMenuBack?: HTMLElement;
  private customerMenuHost?: HTMLElement;

  /** Signature of the last render so the 5 Hz update() tick skips work
   * when nothing visible changed. */
  private lastSig = "";

  constructor(parent: HTMLElement, game: Game, onUpgrade?: () => void) {
    this.game = game;
    this.onUpgrade = onUpgrade;
    this.courses = COURSES.map((c) => {
      const seen = new Set<string>();
      const dishes = recipes
        .filter((r) => r.category === c.key)
        // Dedupe: recipes.ts has a couple of duplicate ids (chocolate-cake,
        // apple-pie). Keep the first so the carousel shows each dish once.
        .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
        .sort((a, b) =>
          (getRecipeLuxuryTier(a) - getRecipeLuxuryTier(b)) ||
          (a.sellPrice - b.sellPrice) ||
          a.name.localeCompare(b.name));
      return { key: c.key, label: c.label, dishes };
    });

    this.injectStyle();

    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      left: "50%",
      transform: "translateX(-50%)",
      bottom: "12px",
      width: "min(468px, calc(100vw - 24px))",
      maxWidth: "468px",
      padding: "8px 12px",
      background: "rgba(20, 14, 10, 0.82)",
      color: "#fff5dc",
      font: "12px/1.35 system-ui, sans-serif",
      borderRadius: "10px",
      pointerEvents: "auto",
      boxShadow: "0 4px 18px rgba(0,0,0,0.4)",
      zIndex: "100",
    } as Partial<CSSStyleDeclaration>);
    this.root.classList.add("cb-menupanel");
    parent.appendChild(this.root);

    const header = document.createElement("div");
    header.className = "cbm-header";
    const title = document.createElement("div");
    title.textContent = "MENU ▾  (click to expand)";
    Object.assign(title.style, { fontWeight: "600", fontSize: "13px", cursor: "pointer", flex: "1" } as Partial<CSSStyleDeclaration>);
    title.onclick = () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? "none" : "block";
      title.textContent = this.collapsed ? "MENU ▾  (click to expand)" : "MENU ▴  (click to collapse)";
      if (!this.collapsed) { this.lastSig = ""; this.render(); }
    };
    this.titleEl = title;
    header.appendChild(title);
    // "Your menu" — preview the on-menu dishes the way a seated customer reads
    // them. Stops propagation so it doesn't toggle the panel collapse.
    const yourMenuBtn = document.createElement("button");
    yourMenuBtn.className = "cbm-yourmenu";
    yourMenuBtn.textContent = "📖 Your menu";
    yourMenuBtn.onclick = (e) => { e.stopPropagation(); this.showCustomerMenu(); };
    attachTooltip(yourMenuBtn, "See your menu the way a seated customer reads it before ordering.");
    header.appendChild(yourMenuBtn);
    this.root.appendChild(header);
    attachTooltip(title,
      "MENU — the dishes your restaurant serves.\n" +
      "Swipe or use the ‹ › arrows to move through a course; dishes run Tier 1 → Tier 5 as you go right. " +
      "Use the big ▲ ▼ course buttons (or swipe up / down) to switch course.\n" +
      "Tap the pill under a dish to put it on the menu (max 3 per course) — customers order it, the chef " +
      "cooks it from pantry ingredients, and you earn its sell price. Higher tiers unlock as your luxury " +
      "tier rises; some dishes need a specific appliance (shown on the right) before they can be served."
    );

    this.body = document.createElement("div");
    Object.assign(this.body.style, {
      display: "none", marginTop: "8px", maxHeight: "82vh", overflowY: "auto",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);

    this.buildCarousel();
    this.render();
  }

  /** One-time scoped stylesheet for the carousel. Kept out of the TS as
   * a <style> block (same approach as MobileUI) so the render code reads
   * as structure, not 300 lines of inline Object.assign. */
  private injectStyle(): void {
    if (document.getElementById("cb-menu-style")) return;
    const s = document.createElement("style");
    s.id = "cb-menu-style";
    s.textContent = `
.cbm-wrap{max-width:452px;margin:0 auto}
.cbm-cathead{text-align:center;margin:2px 0 0}
.cbm-catname{font-size:16px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#ffd986}
.cbm-catpos{font-size:10px;color:rgba(255,245,220,.5);letter-spacing:.03em}
.cbm-course{display:flex;align-items:center;justify-content:center;gap:8px;flex:1;min-width:0;font:inherit;font-size:14px;font-weight:600;color:#fff5dc;background:rgba(255,245,220,.05);border:1px solid rgba(255,245,220,.14);border-radius:11px;padding:8px 12px;cursor:pointer}
.cbm-course:hover{border-color:#ffd986;color:#ffd986}
.cbm-course .cchev{font-size:19px;color:#ffd986;line-height:1}
.cbm-stage{position:relative;height:196px;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:pan-y}
.cbm-tier{position:absolute;top:2px;left:2px;z-index:5;font-size:10px;font-weight:700;letter-spacing:.07em;color:#1b1410;background:#ffd986;padding:2px 9px;border-radius:7px}
.cbm-tier.lk{background:rgba(255,140,120,.92);color:#2a0f0a}
.cbm-focus{position:relative;z-index:2;text-align:center}
.cbm-focus img{width:172px;height:172px;object-fit:contain;filter:drop-shadow(0 8px 14px rgba(0,0,0,.5))}
.cbm-focus.locked img{filter:grayscale(.8) brightness(.6)}
.cbm-femoji{font-size:118px;line-height:172px;display:none}
.cbm-peek{position:absolute;top:50%;transform:translateY(-50%) scale(.58);opacity:.3;z-index:1;pointer-events:none}
.cbm-peek img{width:140px;height:140px;object-fit:contain}
.cbm-peek.l{left:-46px}.cbm-peek.r{right:-46px}
.cbm-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:4;width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,245,220,.16);background:rgba(18,12,8,.82);color:#fff5dc;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.cbm-arrow:hover{border-color:#ffd986;color:#ffd986}
.cbm-arrow.l{left:0}.cbm-arrow.r{right:0}
.cbm-lockov{position:absolute;inset:0;z-index:3;display:none;align-items:center;justify-content:center;pointer-events:none}
.cbm-lockcircle{background:rgba(12,8,6,.74);border:1px solid rgba(255,215,150,.4);border-radius:12px;padding:8px 14px;text-align:center;font-size:22px}
.cbm-lockcircle span{display:block;font-size:11px;letter-spacing:.05em;margin-top:1px;color:#fff5dc}
.cbm-rail{position:absolute;right:-1px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;z-index:5}
.cbm-rdot{width:5px;height:5px;border-radius:50%;background:rgba(255,245,220,.2)}
.cbm-rdot.on{background:#ffd986;height:14px;border-radius:3px}
.cbm-fname{font-size:15px;font-weight:700;text-align:center;margin-top:1px}
.cbm-dots{display:flex;gap:5px;justify-content:center;flex-wrap:wrap;margin:6px 0 2px}
.cbm-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,245,220,.22)}
.cbm-dot.on{background:#ffd986;transform:scale(1.3)}
.cbm-dot.lk{background:rgba(255,140,120,.35)}
.cbm-tiercap{text-align:center;font-size:10px;color:rgba(255,245,220,.5);margin-bottom:7px}
.cbm-tog{display:block;margin:0 auto;font:inherit;font-size:12px;font-weight:600;padding:7px 16px;border-radius:18px;cursor:pointer;border:1px solid rgba(120,200,120,.45);background:rgba(120,200,120,.16);color:#a8e2a8}
.cbm-tog.off{border-color:rgba(255,245,220,.14);background:rgba(255,245,220,.05);color:rgba(255,245,220,.6)}
.cbm-tog.lock{border-color:rgba(255,180,120,.5);background:rgba(255,180,120,.12);color:#ffd986;cursor:default}
.cbm-tog.need{border-color:rgba(230,120,110,.5);background:rgba(230,120,110,.14);color:#f0b6ac;cursor:default}
.cbm-detail{margin-top:10px;border-top:1px solid rgba(255,245,220,.14);padding-top:10px}
.cbm-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:11px}
.cbm-stat{background:rgba(255,245,220,.04);border-radius:8px;padding:6px 8px;text-align:center}
.cbm-stat .sl{display:block;font-size:10px;color:rgba(255,245,220,.5)}
.cbm-stat .sv{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.cbm-stat .sv.good{color:#a8e2a8}
.cbm-cols{display:grid;grid-template-columns:1.5fr 1fr;gap:12px;margin-bottom:11px}
.cbm-col.r{border-left:1px solid rgba(255,245,220,.14);padding-left:12px}
.cbm-il{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:rgba(255,245,220,.5);margin-bottom:6px}
.cbm-chips{display:flex;gap:5px;flex-wrap:wrap;align-content:flex-start;min-height:48px}
.cbm-chip{font-size:11px;background:rgba(255,245,220,.05);border:1px solid rgba(255,245,220,.14);padding:2px 8px;border-radius:7px;text-transform:capitalize;white-space:nowrap}
.cbm-chip.appl{background:rgba(120,200,120,.16);color:#cbe6cb;border-color:rgba(120,200,120,.4);text-transform:none}
.cbm-chip.miss{background:rgba(200,90,90,.2);color:#f0c8c8;border-color:rgba(200,90,90,.4);text-transform:none}
.cbm-lvl{font-size:10px;color:rgba(255,245,220,.5);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
.cbm-up{width:100%;font:inherit;font-size:12px;padding:8px;border-radius:8px;background:transparent;border:1px solid #ffd986;color:#ffd986;cursor:pointer}
.cbm-up:hover{background:rgba(255,217,134,.12)}
.cbm-coursebar{display:flex;gap:8px;margin:6px auto 2px;max-width:452px}
.cbm-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cbm-yourmenu{font:inherit;font-size:11px;font-weight:600;padding:4px 10px;border-radius:8px;border:1px solid rgba(255,217,134,.5);background:rgba(255,217,134,.12);color:#ffd986;cursor:pointer;white-space:nowrap;flex-shrink:0}
.cbm-yourmenu:hover{background:rgba(255,217,134,.22)}
.cbm-cmback{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:1300;display:none;align-items:center;justify-content:center;padding:20px}
.cbm-cmcard{position:relative;width:min(560px,calc(100vw - 40px));max-height:88vh;overflow-y:auto;background:#f5ecd6;color:#3a2c1a;border-radius:5px;padding:32px 40px 38px;box-shadow:0 14px 46px rgba(0,0,0,.6);border:1px solid #d8c39a}
.cbm-cmclose{position:absolute;top:10px;right:13px;background:transparent;border:none;color:#9a7d4f;font-size:20px;cursor:pointer;line-height:1;font-family:system-ui,sans-serif}
.cbm-cmhead{text-align:center;border-bottom:2px solid #a8895c;padding-bottom:14px;margin-bottom:4px}
.cbm-cmname{font-family:Georgia,'Times New Roman',serif;font-size:29px;font-weight:700;letter-spacing:.03em;color:#4a3216}
.cbm-cmsub{font-family:Georgia,serif;font-style:italic;font-size:11px;color:#8a6f45;margin-top:5px;letter-spacing:.24em;text-transform:uppercase}
.cbm-cmcourse{margin:18px 0 4px}
.cbm-cmcoursetitle{font-family:Georgia,serif;font-size:14px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:#7a5a2c;text-align:center}
.cbm-cmrow{display:flex;align-items:baseline;gap:6px;margin:13px 2px 0}
.cbm-cmdish{font-family:Georgia,serif;font-size:16px;font-weight:600;color:#3a2c1a}
.cbm-cmlead{flex:1;border-bottom:1px dotted #b09a6e;transform:translateY(-4px)}
.cbm-cmprice{font-family:Georgia,serif;font-size:16px;font-weight:700;color:#5a4326;white-space:nowrap}
.cbm-cmdesc{font-family:Georgia,serif;font-style:italic;font-size:11.5px;color:#8a6f45;margin:2px 2px 0;max-width:80%}
.cbm-cmempty{text-align:center;font-family:Georgia,serif;font-style:italic;font-size:14px;color:#8a6f45;padding:34px 12px;line-height:1.6}
`;
    document.head.appendChild(s);
  }

  private el(tag: string, cls?: string): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  private buildCarousel(): void {
    const wrap = this.el("div", "cbm-wrap");

    const cathead = this.el("div", "cbm-cathead");
    this.catnameEl = this.el("div", "cbm-catname");
    this.catposEl = this.el("div", "cbm-catpos");
    cathead.append(this.catnameEl, this.catposEl);
    wrap.appendChild(cathead);

    // Course navigation — previous (▲) + next (▼) sit SIDE BY SIDE at the top.
    const courseBar = this.el("div", "cbm-coursebar");
    const up = this.el("button", "cbm-course");
    const upChev = this.el("span", "cchev"); upChev.textContent = "▲";
    this.upLbl = this.el("span");
    up.append(upChev, this.upLbl);
    up.onclick = () => this.moveCourse(-1);
    courseBar.appendChild(up);
    const dn = this.el("button", "cbm-course");
    this.dnLbl = this.el("span");
    const dnChev = this.el("span", "cchev"); dnChev.textContent = "▼";
    dn.append(this.dnLbl, dnChev);
    dn.onclick = () => this.moveCourse(1);
    courseBar.appendChild(dn);
    wrap.appendChild(courseBar);

    // Stage: tier badge + arrows + peeks + focus + lock overlay + rail
    const stage = this.el("div", "cbm-stage");
    this.tierBadge = this.el("div", "cbm-tier");
    this.arrowL = this.el("button", "cbm-arrow l"); this.arrowL.textContent = "‹";
    this.arrowR = this.el("button", "cbm-arrow r"); this.arrowR.textContent = "›";
    this.arrowL.onclick = () => this.moveDish(-1);
    this.arrowR.onclick = () => this.moveDish(1);
    const peekLwrap = this.el("div", "cbm-peek l");
    this.peekL = document.createElement("img"); peekLwrap.appendChild(this.peekL);
    const peekRwrap = this.el("div", "cbm-peek r");
    this.peekR = document.createElement("img"); peekRwrap.appendChild(this.peekR);
    this.focusWrap = this.el("div", "cbm-focus");
    this.focusImg = document.createElement("img");
    this.focusEmoji = this.el("span", "cbm-femoji");
    this.focusWrap.append(this.focusImg, this.focusEmoji);
    this.lockov = this.el("div", "cbm-lockov");
    this.rail = this.el("div", "cbm-rail");
    stage.append(this.tierBadge, this.arrowL, peekLwrap, this.focusWrap, peekRwrap, this.arrowR, this.lockov, this.rail);
    // Touch swipe: horizontal = dish, vertical = course.
    let sx = 0, sy = 0;
    stage.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > Math.abs(dy)) { if (dx > 28) this.moveDish(-1); else if (dx < -28) this.moveDish(1); }
      else { if (dy > 28) this.moveCourse(-1); else if (dy < -28) this.moveCourse(1); }
    }, { passive: true });
    wrap.appendChild(stage);

    this.fname = this.el("div", "cbm-fname");
    wrap.appendChild(this.fname);
    this.dots = this.el("div", "cbm-dots");
    wrap.appendChild(this.dots);
    const cap = this.el("div", "cbm-tiercap"); cap.textContent = "Tier rises as you scroll right →";
    wrap.appendChild(cap);

    this.tog = document.createElement("button"); this.tog.className = "cbm-tog";
    this.tog.onclick = () => this.toggleFocused();
    wrap.appendChild(this.tog);

    const detail = this.el("div", "cbm-detail");
    this.detailDyn = this.el("div");
    this.upBtn = document.createElement("button"); this.upBtn.className = "cbm-up";
    this.upBtn.textContent = "Upgrade this dish";
    this.upBtn.onclick = () => this.onUpgrade?.();
    detail.append(this.detailDyn, this.upBtn);
    wrap.appendChild(detail);

    this.body.appendChild(wrap);
  }

  private moveDish(delta: number): void {
    const n = this.courses[this.ci].dishes.length;
    if (n <= 1) return;
    this.di = (this.di + delta + n) % n;
    this.render();
  }

  private moveCourse(delta: number): void {
    this.ci = (this.ci + delta + this.courses.length) % this.courses.length;
    this.di = 0;
    this.render();
  }

  /** Put the focused dish on / off the menu. Removing always works
   * (even a dish whose appliance was later sold). Adding is gated on
   * unlocked tier + all appliances present + the per-course cap of 3. */
  private toggleFocused(): void {
    const recipe = this.courses[this.ci].dishes[this.di];
    if (!recipe) return;
    const onMenu = new Set(this.game.cooking.getMenuRecipeIds());
    if (onMenu.has(recipe.id)) {
      this.game.cooking.removeFromMenu(recipe.id);
      this.lastSig = ""; this.render();
      return;
    }
    if (getRecipeLuxuryTier(recipe) > this.game.getLuxuryTier()) return; // tier-locked
    const provided = this.game.getProvidedAppliances?.();
    const missing = provided
      ? this.game.cooking.getRecipeAppliances(recipe).filter((a) => !provided.has(a))
      : [];
    if (missing.length > 0) return; // appliance missing
    const added = this.game.cooking.addToMenu(recipe.id);
    if (!added) { this.flashCap(); return; } // per-course cap hit
    this.lastSig = ""; this.render();
  }

  /** Briefly turn the toggle into a "course full" warning, then let the
   * next render restore it. */
  private flashCap(): void {
    this.tog.className = "cbm-tog need";
    this.tog.textContent = `Only ${maxActiveRecipesPerCategory} dishes per course`;
    window.setTimeout(() => { this.lastSig = ""; this.render(); }, 1200);
  }

  update(): void {
    if (this.collapsed) return;
    if (this.computeSig() === this.lastSig) return;
    this.render();
  }

  private computeSig(): string {
    const recipe = this.courses[this.ci]?.dishes[this.di];
    if (!recipe) return `${this.ci}|${this.di}`;
    const playerTier = this.game.getLuxuryTier();
    const provided = this.game.getProvidedAppliances?.();
    const provKey = provided ? Array.from(provided).sort().join(",") : "";
    const onMenu = this.game.cooking.getMenuRecipeIds().slice().sort().join(",");
    const level = this.game.cooking.getRecipeUpgradeLevel(recipe);
    const price = this.game.getEffectiveSellPrice(recipe);
    const sat = Math.round(this.game.getEffectiveSatisfaction(recipe));
    return `${this.ci}|${this.di}|${playerTier}|${provKey}|${onMenu}|${recipe.id}|${level}|${price}|${sat}`;
  }

  private setImg(img: HTMLImageElement, id: string, onFail?: () => void): void {
    img.style.visibility = "";
    img.onerror = () => { if (onFail) onFail(); else img.style.visibility = "hidden"; };
    img.src = recipeImage(id);
  }

  private render(): void {
    const course = this.courses[this.ci];
    const dishes = course.dishes;
    const n = dishes.length;
    if (this.di >= n) this.di = 0;
    const recipe = dishes[this.di];

    const tier = getRecipeLuxuryTier(recipe);
    const playerTier = this.game.getLuxuryTier();
    const provided = this.game.getProvidedAppliances?.();
    const appliances = this.game.cooking.getRecipeAppliances(recipe);
    const missing = provided ? appliances.filter((a) => !provided.has(a)) : [];
    const lockedByTier = tier > playerTier;
    const makeable = missing.length === 0;
    const on = new Set(this.game.cooking.getMenuRecipeIds()).has(recipe.id);

    // Course header
    this.catnameEl.textContent = course.label;
    const active = this.game.cooking.getActiveRecipeCountForCategory(course.key);
    this.catposEl.textContent =
      `Course ${this.ci + 1} of ${this.courses.length}  ·  ${active}/${maxActiveRecipesPerCategory} on menu`;
    this.upLbl.textContent = this.courses[(this.ci - 1 + this.courses.length) % this.courses.length].label;
    this.dnLbl.textContent = this.courses[(this.ci + 1) % this.courses.length].label;

    // Focus plate (emoji fallback if the PNG is missing)
    this.focusImg.style.display = "";
    this.focusEmoji.style.display = "none";
    this.setImg(this.focusImg, recipe.id, () => {
      this.focusImg.style.display = "none";
      this.focusEmoji.style.display = "inline-block";
      this.focusEmoji.textContent = recipeIcon(recipe.id);
    });
    this.focusWrap.classList.toggle("locked", lockedByTier);

    // Peeks
    if (n > 1) {
      this.arrowL.style.display = ""; this.arrowR.style.display = "";
      this.peekL.parentElement!.style.display = ""; this.peekR.parentElement!.style.display = "";
      this.setImg(this.peekL, dishes[(this.di - 1 + n) % n].id);
      this.setImg(this.peekR, dishes[(this.di + 1) % n].id);
    } else {
      this.arrowL.style.display = "none"; this.arrowR.style.display = "none";
      this.peekL.parentElement!.style.display = "none"; this.peekR.parentElement!.style.display = "none";
    }

    // Tier badge + lock overlay
    this.tierBadge.textContent = `TIER ${tier}`;
    this.tierBadge.className = "cbm-tier" + (lockedByTier ? " lk" : "");
    this.lockov.style.display = lockedByTier ? "flex" : "none";
    this.lockov.innerHTML = lockedByTier
      ? `<div class="cbm-lockcircle">🔒<span>Tier ${tier}</span></div>` : "";

    // Dish dots (locked ones tinted) + course rail
    this.dots.innerHTML = dishes.map((d, k) =>
      `<span class="cbm-dot${k === this.di ? " on" : ""}${getRecipeLuxuryTier(d) > playerTier ? " lk" : ""}"></span>`).join("");
    this.rail.innerHTML = this.courses.map((_, k) =>
      `<span class="cbm-rdot${k === this.ci ? " on" : ""}"></span>`).join("");

    this.fname.textContent = recipe.name;

    // Toggle pill
    if (lockedByTier) {
      this.tog.className = "cbm-tog lock";
      this.tog.textContent = `🔒 Reach Tier ${tier} to unlock`;
    } else if (!makeable) {
      this.tog.className = "cbm-tog need";
      this.tog.textContent = `Needs ${missing.map((a) => APPLIANCE_LABELS[a]).join(", ")}`;
    } else if (on) {
      this.tog.className = "cbm-tog";
      this.tog.textContent = "✓ On the menu";
    } else {
      this.tog.className = "cbm-tog off";
      this.tog.textContent = "+ Add to menu";
    }

    // Detail: stats + ingredients / appliance columns + level
    const price = this.game.getEffectiveSellPrice(recipe);
    const profit = this.game.getEffectiveProfit(recipe);
    const sat = Math.round(this.game.getEffectiveSatisfaction(recipe));
    const level = this.game.cooking.getRecipeUpgradeLevel(recipe);
    const ingChips = recipe.ingredients
      .map((id) => `<span class="cbm-chip">${ingredientIcon(id)} ${this.pretty(id)}</span>`)
      .join("");
    const applList: string[] = appliances.length ? appliances.slice() : [recipe.stationNeeded];
    const applChips = applList.map((a) => {
      const label = APPLIANCE_LABELS[a as ApplianceId] ?? this.pretty(a);
      const isMissing = provided ? missing.includes(a as ApplianceId) : false;
      return `<span class="cbm-chip ${isMissing ? "miss" : "appl"}">${label}</span>`;
    }).join("");
    this.detailDyn.innerHTML =
      `<div class="cbm-stats">` +
      `<div class="cbm-stat"><span class="sl">Price</span><span class="sv">$${price}</span></div>` +
      `<div class="cbm-stat"><span class="sl">Profit</span><span class="sv good">+$${profit}</span></div>` +
      `<div class="cbm-stat"><span class="sl">Guest joy</span><span class="sv">${sat}</span></div></div>` +
      `<div class="cbm-cols">` +
      `<div class="cbm-col"><div class="cbm-il">Ingredients</div><div class="cbm-chips">${ingChips}</div></div>` +
      `<div class="cbm-col r"><div class="cbm-il">Appliance</div><div class="cbm-chips">${applChips}</div></div>` +
      `</div>` +
      `<div class="cbm-lvl">Level ${level}</div>`;

    this.lastSig = this.computeSig();
  }

  private pretty(id: string): string {
    return id.replace(/[-_]/g, " ");
  }

  /** Open the customer-facing menu preview — the dishes currently ON the menu,
   * laid out like a printed restaurant menu: grouped by course, dish name with
   * a dotted leader to the price, and the ingredients as an italic descriptor.
   * Built lazily; repopulated each open so it reflects live menu edits. */
  private showCustomerMenu(): void {
    if (!this.customerMenuBack) {
      const back = this.el("div", "cbm-cmback");
      // It's a read-only preview — tapping ANYWHERE dismisses it (a scroll
      // gesture is a drag, not a click, so reading still works). The old
      // target===back check only closed on a direct backdrop hit, which barely
      // exists on a phone where the card fills the screen.
      back.onclick = () => { back.style.display = "none"; };
      const card = this.el("div", "cbm-cmcard");
      const close = document.createElement("button");
      close.className = "cbm-cmclose";
      close.textContent = "✕";
      close.onclick = () => { back.style.display = "none"; };
      const host = this.el("div");
      card.append(close, host);
      back.appendChild(card);
      document.body.appendChild(back);
      this.customerMenuBack = back;
      this.customerMenuHost = host;
    }
    this.renderCustomerMenu(this.customerMenuHost!);
    this.customerMenuBack.style.display = "flex";
  }

  private renderCustomerMenu(host: HTMLElement): void {
    const onMenu = new Set(this.game.cooking.getMenuRecipeIds());
    const parts: string[] = [];
    parts.push(
      `<div class="cbm-cmhead">` +
      `<div class="cbm-cmname">${escapeHtml(this.game.getRestaurantName())}</div>` +
      `<div class="cbm-cmsub">Menu</div></div>`,
    );
    let any = false;
    for (const course of this.courses) {
      const dishes = course.dishes
        .filter((d) => onMenu.has(d.id))
        .sort((a, b) =>
          (getRecipeLuxuryTier(a) - getRecipeLuxuryTier(b)) || (a.sellPrice - b.sellPrice));
      if (dishes.length === 0) continue;
      any = true;
      parts.push(`<div class="cbm-cmcourse"><div class="cbm-cmcoursetitle">${escapeHtml(course.label)}</div>`);
      for (const d of dishes) {
        const price = this.game.getEffectiveSellPrice(d);
        const desc = d.ingredients.map((id) => this.pretty(id)).join(", ");
        parts.push(
          `<div class="cbm-cmrow">` +
          `<span class="cbm-cmdish">${escapeHtml(d.name)}</span>` +
          `<span class="cbm-cmlead"></span>` +
          `<span class="cbm-cmprice">$${price}</span></div>` +
          (desc ? `<div class="cbm-cmdesc">${escapeHtml(capitalize(desc))}</div>` : ""),
        );
      }
      parts.push(`</div>`);
    }
    if (!any) {
      parts.push(
        `<div class="cbm-cmempty">Your menu is empty.<br>` +
        `Add dishes below and they'll appear here — exactly as your customers will see them.</div>`,
      );
    }
    host.innerHTML = parts.join("");
  }
}

/** Escape user/recipe text before it goes into the menu innerHTML (the
 * restaurant name is player-set, so it must be escaped). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;");
}

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
