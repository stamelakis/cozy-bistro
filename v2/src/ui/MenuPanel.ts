import type { Game } from "../game/Game";
import { recipes } from "../data/recipes";
import { getRecipeLuxuryTier, maxActiveRecipesPerCategory } from "../systems/CookingSystem";
import { getIngredientCost } from "../data/ingredients";
import { APPLIANCE_LABELS } from "../data/types";
import type { ApplianceId, LuxuryTier, RecipeDefinition } from "../data/types";
import { attachTooltip } from "./tooltip";
import { recipeIcon, ingredientIcon } from "./foodIcons";

/** Section order for the right-side summary panel — owner asked for
 * Appetizers, Main, Side, Drinks, Dessert in that order. Internally
 * the data uses singular "appetizer"/"main"/"side"/"drink"/"dessert"
 * keys; this maps them to plural display headers. */
const SUMMARY_SECTIONS: { key: RecipeDefinition["category"]; label: string }[] = [
  { key: "appetizer", label: "Appetizers" },
  { key: "main",      label: "Main"       },
  { key: "side",      label: "Side"       },
  { key: "drink",     label: "Drinks"     },
  { key: "dessert",   label: "Dessert"    },
];

/** Per-tier badge colours for the summary panel's dish chips.
 * Reads as a rarity ladder — green → blue → purple → orange → gold —
 * the same vocabulary players already know from loot games, so a
 * glance at the summary tells you both what's on the menu AND how
 * pricey the line-up skews. Index = tier − 1. */
const TIER_BADGE_BG: readonly string[] = [
  "#5fa650", // T1 — fresh green
  "#4a8cd0", // T2 — solid blue
  "#9462c8", // T3 — refined purple
  "#d68b3a", // T4 — premium orange
  "#d6b441", // T5 — luxury gold
];

/**
 * Recipe menu picker (center-bottom). 5 tier tabs — each tab shows the
 * recipes of that tier, locked tabs are grayed and uncheckable. Each
 * row shows: checkbox, name (Lvl), effective $sell, satisfaction, and
 * ingredient list (with per-unit costs).
 *
 * Collapsed by default — click the title to expand.
 */
export class MenuPanel {
  private readonly game: Game;
  /** Root panel element — exposed so the engine can make it
   * draggable + resizable after construction. */
  readonly root: HTMLElement;
  /** Title bar — used as the drag handle by PanelDragResize. */
  readonly titleEl: HTMLElement;
  /** Body wrapper — display:none when collapsed. Exposed so
   * PanelDragResize can watch it as the collapse sentinel. */
  readonly body: HTMLElement;
  private readonly tabsRow: HTMLElement;
  private readonly content: HTMLElement;
  /** Right-side summary panel — sits next to the recipe list when
   * the menu is expanded, showing which recipes the player has on
   * the active menu grouped by category with x/3 counts. Always
   * rendered into the same body container so collapsing the menu
   * also hides the summary. */
  private readonly summaryPanel: HTMLElement;
  /** Cached section bodies keyed by category — re-populated each
   * render but the section container itself is built once. */
  private readonly summarySections = new Map<RecipeDefinition["category"], { header: HTMLElement; list: HTMLElement }>();
  /** Signature of the last-rendered summary so we skip rebuilds
   * when nothing visible to that panel has changed. */
  private lastSummarySig = "";
  private collapsed = true;
  private selectedTier: LuxuryTier = 1;
  /** Persistent tab buttons — built once in the constructor and only
   * restyled by update(), not destroyed and rebuilt. Earlier versions
   * cleared `tabsRow.innerHTML` every 200 ms (the HUD update cadence),
   * which raced with the player's clicks: tap a tab inside the same
   * window and the button gets ripped out from under your pointer, so
   * the click never resolves. With a stable button identity the click
   * always lands. */
  private tabBtns: HTMLButtonElement[] = [];
  /** Signature of the last-rendered content state. Recomputed every
   * update; we only walk the DOM when it actually changes. Same goal
   * as the persistent tabs — avoid throwing away DOM that the player
   * is in the middle of interacting with. */
  private lastContentSig = "";

  constructor(parent: HTMLElement, game: Game) {
    this.game = game;
    this.root = document.createElement("div");
    // 500 max (was 580 → 760 historically). The panel is centered
    // horizontally, so on common laptop viewports (~1500 px wide)
    // 580 still bled into the chat at left:280 by ~80 px even
    // though the menu's own content fit fine. Dropping the max to
    // 500 pushes the left edge ~40 px further right when centered;
    // the recipe column shrinks from ~360 → ~280 (still readable
    // for the longest recipe text), summary panel keeps its 180 px
    // column, 10 px gap stays. Calc floor still lets the panel
    // shrink further on narrow viewports.
    Object.assign(this.root.style, {
      position: "fixed",
      left: "50%",
      transform: "translateX(-50%)",
      bottom: "12px",
      maxWidth: "500px",
      width: "min(500px, calc(100vw - 480px))",
      padding: "8px 12px",
      background: "rgba(20, 14, 10, 0.78)",
      color: "#fff5dc",
      font: "12px/1.3 system-ui, sans-serif",
      borderRadius: "8px",
      pointerEvents: "auto",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.root);

    const title = document.createElement("div");
    title.textContent = "MENU ▾  (click to expand)";
    Object.assign(title.style, { fontWeight: "600", fontSize: "13px", cursor: "pointer" } as Partial<CSSStyleDeclaration>);
    title.onclick = () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? "none" : "block";
      title.textContent = this.collapsed ? "MENU ▾  (click to expand)" : "MENU ▴  (click to collapse)";
    };
    this.titleEl = title;
    this.root.appendChild(title);
    attachTooltip(title,
      "MENU — the dishes your restaurant serves.\n" +
      "Each tier (T1 → T5) holds a set of recipes. Tick a recipe to put it on the menu — customers " +
      "order it, the chef cooks it from pantry ingredients, and you earn its sell price.\n" +
      "Higher tiers unlock as your overall luxury tier rises (matched to the priciest furniture you own). " +
      "Each recipe can be upgraded for higher profit + satisfaction; some require specific appliances " +
      "(stove, microwave, coffee, blender, toaster). Recipes appear locked when an appliance is missing."
    );

    this.body = document.createElement("div");
    Object.assign(this.body.style, { display: "none", marginTop: "8px" } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.body);

    this.tabsRow = document.createElement("div");
    Object.assign(this.tabsRow.style, { display: "flex", gap: "4px", marginBottom: "8px" } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(this.tabsRow);

    // Two-column flex inside the body: recipe list (flex:1) + summary
    // panel (fixed 180px). Tabs row stays above both, full width.
    const splitRow = document.createElement("div");
    Object.assign(splitRow.style, {
      display: "flex", gap: "10px", alignItems: "stretch",
    } as Partial<CSSStyleDeclaration>);
    this.body.appendChild(splitRow);

    this.content = document.createElement("div");
    Object.assign(this.content.style, {
      flex: "1 1 auto",
      minWidth: "0",
      maxHeight: "30vh", overflowY: "auto", paddingRight: "4px",
    } as Partial<CSSStyleDeclaration>);
    splitRow.appendChild(this.content);

    this.summaryPanel = document.createElement("div");
    Object.assign(this.summaryPanel.style, {
      flex: "0 0 180px",
      maxHeight: "30vh", overflowY: "auto",
      paddingLeft: "10px",
      borderLeft: "1px solid rgba(255,245,220,0.15)",
      display: "flex", flexDirection: "column", gap: "6px",
      fontSize: "11px",
    } as Partial<CSSStyleDeclaration>);
    splitRow.appendChild(this.summaryPanel);
    this.buildSummarySections();

    // Build the tier-tab buttons ONCE — `update()` later only restyles
    // them. See `tabBtns` doc for why we don't rebuild every 200 ms.
    this.buildTabs();
  }

  /** Build the persistent header + list container for each category
   * section in the summary panel. Built once; renderSummary() then
   * mutates header text + list children each tick. */
  private buildSummarySections(): void {
    for (const sec of SUMMARY_SECTIONS) {
      const wrap = document.createElement("div");
      Object.assign(wrap.style, {
        display: "flex", flexDirection: "column", gap: "2px",
      } as Partial<CSSStyleDeclaration>);
      const header = document.createElement("div");
      Object.assign(header.style, {
        fontSize: "10px", fontWeight: "700", letterSpacing: "0.04em",
        textTransform: "uppercase", opacity: "0.85",
      } as Partial<CSSStyleDeclaration>);
      wrap.appendChild(header);
      const list = document.createElement("div");
      Object.assign(list.style, {
        display: "flex", flexDirection: "column", gap: "1px",
        paddingLeft: "8px",
      } as Partial<CSSStyleDeclaration>);
      wrap.appendChild(list);
      this.summaryPanel.appendChild(wrap);
      this.summarySections.set(sec.key, { header, list });
    }
  }

  /** Briefly flash the matching summary section header red to
   * surface the "category is full" feedback. The header's color
   * gets restored on the next renderSummary tick. */
  private flashCapWarning(category: RecipeDefinition["category"]): void {
    const refs = this.summarySections.get(category);
    if (!refs) return;
    refs.header.style.color = "#ff9a9a";
    refs.header.style.transition = "color 0.5s ease";
    window.setTimeout(() => {
      // Force the next renderSummary to recompute the header color.
      this.lastSummarySig = "";
      this.renderSummary();
    }, 600);
  }

  /** Mutate the existing summary sections to reflect the current
   * menu. Uses a signature check so the DOM is only touched when
   * something visibly changed — same defensive pattern as
   * renderContent. */
  private renderSummary(): void {
    const onMenu = this.game.cooking.getMenuRecipeIds();
    const sig = onMenu.slice().sort().join(",");
    if (sig === this.lastSummarySig) return;
    this.lastSummarySig = sig;
    const onMenuSet = new Set(onMenu);
    for (const sec of SUMMARY_SECTIONS) {
      const refs = this.summarySections.get(sec.key);
      if (!refs) continue;
      const items = recipes.filter((r) => r.category === sec.key && onMenuSet.has(r.id));
      const count = items.length;
      const max = maxActiveRecipesPerCategory;
      const headerColor = count >= max ? "#ffd986" : count === 0 ? "rgba(255,245,220,0.55)" : "#fff5dc";
      refs.header.style.color = headerColor;
      refs.header.textContent = `${sec.label} (${count}/${max}):`;
      // Rebuild list contents — small enough that diffing isn't worth it.
      refs.list.innerHTML = "";
      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = "—";
        Object.assign(empty.style, {
          opacity: "0.4", fontStyle: "italic",
        } as Partial<CSSStyleDeclaration>);
        refs.list.appendChild(empty);
      } else {
        for (const r of items) {
          const line = document.createElement("div");
          // Flex row: coloured tier chip + dish name. The chip serves
          // as the visual list marker (no bullet character needed)
          // and tells the player at a glance how pricey each picked
          // dish is — useful when the menu mixes tiers and the player
          // is trying to balance a starter T1 against a flagship T4.
          Object.assign(line.style, {
            display: "flex", alignItems: "center", gap: "5px",
            whiteSpace: "nowrap", overflow: "hidden",
          } as Partial<CSSStyleDeclaration>);
          const tier = getRecipeLuxuryTier(r);
          const badge = document.createElement("span");
          badge.textContent = `T${tier}`;
          const bg = TIER_BADGE_BG[Math.max(0, Math.min(TIER_BADGE_BG.length - 1, tier - 1))];
          Object.assign(badge.style, {
            display: "inline-block",
            background: bg,
            color: "#fff",
            fontSize: "9px",
            fontWeight: "700",
            letterSpacing: "0.04em",
            padding: "1px 5px",
            borderRadius: "3px",
            flex: "0 0 auto",
            // Slight inset shadow gives the chip a subtle pill look
            // against the dark summary background.
            boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.25)",
          } as Partial<CSSStyleDeclaration>);
          line.appendChild(badge);
          const name = document.createElement("span");
          name.textContent = r.name;
          Object.assign(name.style, {
            flex: "1 1 auto",
            minWidth: "0",
            overflow: "hidden",
            textOverflow: "ellipsis",
          } as Partial<CSSStyleDeclaration>);
          line.appendChild(name);
          refs.list.appendChild(line);
        }
      }
    }
  }

  /** Build the 5 tier-tab buttons one time. Each button's click handler
   * is a closure over a fixed tier value; subsequent restyles in
   * `refreshTabs` never touch the click handler or the button identity,
   * so a tap can't race with a re-render. */
  private buildTabs(): void {
    const baseProfits = [3, 4, 5, 6, 7];
    for (let t = 1; t <= 5; t += 1) {
      const tier = t as LuxuryTier;
      const btn = document.createElement("button");
      Object.assign(btn.style, {
        flex: "1",
        padding: "5px 4px",
        borderRadius: "4px",
        font: "inherit",
        fontSize: "11px",
      } as Partial<CSSStyleDeclaration>);
      btn.title = `Base profit per dish at L1: $${baseProfits[t - 1]}`;
      btn.onclick = () => {
        if (btn.disabled) return;
        if (this.selectedTier === tier) return;
        this.selectedTier = tier;
        this.refreshTabs();
        // Force a content rebuild on tier change — the signature would
        // catch it next tick anyway, but we don't want a 200 ms flash
        // of stale rows.
        this.lastContentSig = "";
        this.renderContent();
      };
      this.tabBtns.push(btn);
      this.tabsRow.appendChild(btn);
    }
  }

  update(): void {
    if (this.collapsed) return; // skip work when hidden
    this.refreshTabs();
    this.renderContent();
    this.renderSummary();
  }

  /** Mutate the existing tab buttons' styles + labels to match the
   * current player tier + active selection. No DOM destruction; the
   * tab the player is clicking right now is never ripped out from
   * under their pointer. */
  private refreshTabs(): void {
    const playerTier = this.game.getLuxuryTier();
    const baseProfits = [3, 4, 5, 6, 7];
    for (let i = 0; i < this.tabBtns.length; i += 1) {
      const tier = (i + 1) as LuxuryTier;
      const locked = tier > playerTier;
      const active = tier === this.selectedTier;
      const btn = this.tabBtns[i];
      btn.textContent = `Tier ${tier}${locked ? " 🔒" : ""}  ·  $${baseProfits[i]}/dish`;
      btn.style.background = active
        ? "rgba(120, 200, 120, 0.30)"
        : locked
          ? "rgba(255,245,220,0.04)"
          : "rgba(255,245,220,0.10)";
      btn.style.color = locked ? "rgba(255,245,220,0.4)" : "#fff5dc";
      btn.style.border = active
        ? "1px solid rgba(120, 200, 120, 0.7)"
        : "1px solid rgba(255,245,220,0.18)";
      btn.style.cursor = locked ? "not-allowed" : "pointer";
      btn.style.fontWeight = active ? "700" : "500";
      btn.disabled = locked;
      btn.title = locked ? `Unlock with Tier ${tier} expansion` : `Base profit per dish at L1: $${baseProfits[i]}`;
    }
  }

  private renderContent(): void {
    // Cheap signature of the everything that drives the rendered HTML.
    // When nothing has changed (the common case — the player isn't
    // touching menus 5×/s) we skip the rebuild entirely, which avoids
    // throwing away the row checkboxes the player might be about to
    // click. Without this, every 200 ms tick destroys + recreates the
    // whole recipe list, costing both real CPU and any in-flight click.
    const sig = this.computeContentSig();
    if (sig === this.lastContentSig) return;
    this.lastContentSig = sig;
    this.content.innerHTML = "";
    const inTier = recipes.filter((r) => getRecipeLuxuryTier(r) === this.selectedTier);
    if (inTier.length === 0) {
      this.content.textContent = "No recipes in this tier.";
      return;
    }
    const onMenu = new Set(this.game.cooking.getMenuRecipeIds());
    const playerTier = this.game.getLuxuryTier();
    const tierUnlocked = this.selectedTier <= playerTier;
    // Snapshot the currently-provided appliances ONCE per render so
    // every row checks against the same set (and we don't walk the
    // registry n times).
    const provided = this.game.getProvidedAppliances?.();
    // Sort within tier by category (appetizer, main, dessert, drink, side) then name.
    const order = { appetizer: 0, main: 1, dessert: 2, drink: 3, side: 4 } as const;
    inTier.sort((a, b) => (order[a.category] - order[b.category]) || a.name.localeCompare(b.name));
    for (const recipe of inTier) {
      this.content.appendChild(this.renderRecipe(recipe, onMenu.has(recipe.id), tierUnlocked, provided));
    }
  }

  private renderRecipe(
    recipe: RecipeDefinition, on: boolean, unlocked: boolean,
    provided: ReadonlySet<string> | undefined,
  ): HTMLElement {
    // Recipes whose required appliances aren't all placed in the
    // restaurant can't be put on the menu. The row still renders so
    // the player knows the recipe exists and what they need to build
    // to unlock it.
    const appliances = this.game.cooking.getRecipeAppliances(recipe);
    const missing: ApplianceId[] = [];
    if (provided) {
      for (const a of appliances) if (!provided.has(a)) missing.push(a);
    }
    const makeable = missing.length === 0;
    const usable = unlocked && makeable;

    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      // Tighter inter-column gap (was 8) — keeps the price chip
      // visually close to the ingredient line instead of floating
      // off in the right margin.
      gap: "10px",
      // justify-content default (flex-start) + left's `flex: 0 1
      // auto` means the row packs everything from the left with
      // only the configured gap between elements. Any leftover
      // horizontal space sits at the row's far right, not BETWEEN
      // the description and the price.
      justifyContent: "flex-start",
      padding: "4px 6px",
      borderBottom: "1px solid rgba(255,245,220,0.06)",
      opacity: usable ? "1" : "0.45",
    } as Partial<CSSStyleDeclaration>);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.disabled = !usable;
    // Tooltip on the checkbox itself so the player knows WHY it's disabled.
    if (!unlocked) {
      cb.title = `Locked — unlock with Tier ${this.selectedTier} expansion`;
    } else if (!makeable) {
      cb.title = `Needs: ${missing.map((a) => APPLIANCE_LABELS[a]).join(", ")}`;
    }
    cb.onchange = () => {
      if (cb.checked) {
        const added = this.game.cooking.addToMenu(recipe.id);
        if (!added) {
          // addToMenu refuses when the per-category cap of 3 is
          // already met OR the recipe is somehow already on. Roll
          // the checkbox state back so the UI stays truthful, and
          // ping the title with a brief tooltip so the player knows
          // why nothing happened.
          cb.checked = false;
          const onCount = this.game.cooking.getActiveRecipeCountForCategory(recipe.category);
          if (onCount >= maxActiveRecipesPerCategory) {
            this.flashCapWarning(recipe.category);
          }
        }
      } else {
        this.game.cooking.removeFromMenu(recipe.id);
      }
      // Force the summary panel to redraw immediately so the new
      // count + bullet shows without waiting for the 200 ms tick.
      this.lastSummarySig = "";
      this.renderSummary();
    };
    row.appendChild(cb);

    const left = document.createElement("div");
    // flex: 0 1 auto (shrink to content, no grow) — was flex: 1 which
    // expanded the description column to fill ALL remaining row
    // width, pushing the price chip to the far-right edge with a
    // huge empty gap between. Now the price sits ~10 px from the
    // ingredient line.
    Object.assign(left.style, { flex: "0 1 auto", minWidth: "0" } as Partial<CSSStyleDeclaration>);
    const nameRow = document.createElement("div");
    Object.assign(nameRow.style, { display: "flex", alignItems: "center", gap: "6px" } as Partial<CSSStyleDeclaration>);
    // Plate icon — gives the player an immediate visual cue for what
    // the dish looks like before they read the name. Same map is used
    // in UpgradeModal so identical recipes look identical across the
    // two panels.
    const icon = document.createElement("span");
    icon.textContent = recipeIcon(recipe.id);
    Object.assign(icon.style, {
      fontSize: "16px", lineHeight: "1", flex: "0 0 auto",
    } as Partial<CSSStyleDeclaration>);
    nameRow.appendChild(icon);
    const cat = document.createElement("span");
    cat.textContent = this.shortForCategory(recipe.category);
    Object.assign(cat.style, {
      fontSize: "9px", padding: "1px 4px", borderRadius: "3px",
      background: this.colorForCategory(recipe.category), color: "#1b1410",
      fontWeight: "700", minWidth: "18px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    cat.title = recipe.category[0].toUpperCase() + recipe.category.slice(1);
    nameRow.appendChild(cat);
    const level = this.game.cooking.getRecipeUpgradeLevel(recipe);
    // Level badge — same styling as the category chip so the L number is
    // unmissable instead of buried as plain trailing text on the name.
    const lvlBadge = document.createElement("span");
    lvlBadge.textContent = `L${level}`;
    Object.assign(lvlBadge.style, {
      fontSize: "9px", padding: "1px 5px", borderRadius: "3px",
      background: level >= 10 ? "#f5c14a" : level > 1 ? "#7a9a6a" : "#4a4137",
      color: level > 1 ? "#fff" : "#cbb",
      fontWeight: "700", minWidth: "18px", textAlign: "center",
    } as Partial<CSSStyleDeclaration>);
    nameRow.appendChild(lvlBadge);
    const name = document.createElement("span");
    name.textContent = recipe.name;
    Object.assign(name.style, { fontWeight: "600", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as Partial<CSSStyleDeclaration>);
    nameRow.appendChild(name);
    // ACTIVE pill — bright green chip so the player can see at a glance
    // which recipes are on the active menu without scanning the row's
    // leftmost checkbox.
    if (on) {
      const activeBadge = document.createElement("span");
      activeBadge.textContent = "ACTIVE";
      Object.assign(activeBadge.style, {
        fontSize: "9px", padding: "1px 5px", borderRadius: "3px",
        background: "rgba(120, 200, 120, 0.85)", color: "#1b1410",
        fontWeight: "700", marginLeft: "2px",
      } as Partial<CSSStyleDeclaration>);
      nameRow.appendChild(activeBadge);
    }
    left.appendChild(nameRow);
    // Appliance requirements — one chip per appliance the recipe needs.
    // Provided ones render green, missing ones render dim red so the
    // player can see at a glance "this recipe needs a toaster I don't
    // own". Skip the row entirely when the recipe only needs whichever
    // station has historically been universal so it doesn't add noise
    // for the basic counter / stove recipes.
    if (appliances.length > 0) {
      const applLine = document.createElement("div");
      Object.assign(applLine.style, {
        display: "flex", gap: "3px", marginTop: "2px", flexWrap: "wrap",
      } as Partial<CSSStyleDeclaration>);
      for (const a of appliances) {
        const have = provided ? provided.has(a) : true;
        const chip = document.createElement("span");
        chip.textContent = APPLIANCE_LABELS[a];
        Object.assign(chip.style, {
          fontSize: "9px", padding: "1px 5px", borderRadius: "3px",
          background: have ? "rgba(120, 200, 120, 0.30)" : "rgba(200, 90, 90, 0.25)",
          color: have ? "#cbe6cb" : "#f0c8c8",
          fontWeight: "600",
        } as Partial<CSSStyleDeclaration>);
        applLine.appendChild(chip);
      }
      left.appendChild(applLine);
    }
    // Ingredient line — list every ingredient with its per-unit cost.
    // Each entry leads with its emoji so the line is visually scannable
    // (a row full of 🍅 🍝 🧀 reads as Italian at a glance).
    const ingLine = document.createElement("div");
    ingLine.textContent = recipe.ingredients
      .map((id) => `${ingredientIcon(id)} ${this.prettyIng(id)}($${getIngredientCost(id)})`)
      .join(" + ");
    Object.assign(ingLine.style, { fontSize: "10px", opacity: "0.7", marginTop: "1px" } as Partial<CSSStyleDeclaration>);
    left.appendChild(ingLine);
    row.appendChild(left);

    const stats = document.createElement("div");
    Object.assign(stats.style, { textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } as Partial<CSSStyleDeclaration>);
    const price = this.game.getEffectiveSellPrice(recipe);
    const profit = this.game.getEffectiveProfit(recipe);
    const sat = this.game.getEffectiveSatisfaction(recipe).toFixed(0);
    const priceLine = document.createElement("div");
    priceLine.innerHTML = `$${price} <span style="opacity:0.55">(+$${profit})</span>`;
    Object.assign(priceLine.style, { fontWeight: "600", fontSize: "12px", color: "#a8e2a8" } as Partial<CSSStyleDeclaration>);
    stats.appendChild(priceLine);
    const satLine = document.createElement("div");
    satLine.textContent = `${sat}😋`;
    Object.assign(satLine.style, { fontSize: "10px", opacity: "0.75" } as Partial<CSSStyleDeclaration>);
    stats.appendChild(satLine);
    row.appendChild(stats);

    return row;
  }

  /** Hash everything that affects the rendered recipe rows into a
   * short string. The render-content path compares this against the
   * last-rendered signature and bails when they match, so the 5 Hz
   * update tick stays free when nothing visible has changed. */
  private computeContentSig(): string {
    const playerTier = this.game.getLuxuryTier();
    const inTier = recipes.filter((r) => getRecipeLuxuryTier(r) === this.selectedTier);
    const onMenu = this.game.cooking.getMenuRecipeIds();
    const provided = this.game.getProvidedAppliances?.();
    const provKey = provided ? Array.from(provided).sort().join(",") : "";
    const onMenuKey = Array.from(onMenu).sort().join(",");
    // Per-recipe: upgrade level + effective price (covers global cook
    // multipliers / staff bonuses changing the displayed $price).
    const recipeKey = inTier.map((r) =>
      `${r.id}:${this.game.cooking.getRecipeUpgradeLevel(r)}:${this.game.getEffectiveSellPrice(r)}:${this.game.getEffectiveSatisfaction(r).toFixed(0)}`
    ).join("|");
    return `${this.selectedTier}|${playerTier}|${onMenuKey}|${provKey}|${recipeKey}`;
  }

  private prettyIng(id: string): string {
    return id.replace(/[-_]/g, " ");
  }

  private colorForCategory(c: string): string {
    return c === "appetizer" ? "#f6d36a"
      : c === "main"      ? "#f0a070"
      : c === "dessert"   ? "#f0a0d0"
      : c === "drink"     ? "#a0d8f0"
      : "#cccccc"; // side
  }
  private shortForCategory(c: string): string {
    return c === "appetizer" ? "Ap"
      : c === "main"      ? "Ma"
      : c === "dessert"   ? "De"
      : c === "drink"     ? "Dr"
      : "Si";
  }
}
