/**
 * Emoji icons for ingredients + recipes. Used by the Pantry modal,
 * MenuPanel, and UpgradeModal so each row gets a small visual cue
 * matching its name (a carrot for "carrot", a steak plate for
 * "filet mignon").
 *
 * Why emoji rather than authored PNG / SVG icons:
 *  - Zero asset pipeline. Every modern browser renders them with the
 *    OS / browser emoji font.
 *  - Already match the toy / cozy aesthetic of the Kenney furniture.
 *  - Trivial to extend when a new ingredient or recipe lands.
 *
 * Both lookups fall back to a sensible default ("🍽️" for unknown
 * recipes, "🥗" for unknown ingredients) so newly-added catalog
 * entries don't render as blank icons.
 */

/** Per-ingredient emoji. Covers every id in INGREDIENT_COSTS. The id
 * keys are kept verbose (sweet-potato, goat-cheese) so they match
 * data/ingredients.ts exactly with no fuzzy lookups. */
const INGREDIENT_ICONS: Record<string, string> = {
  // Tier 1 staples
  bread: "🍞", butter: "🧈", oil: "🫒", salt: "🧂", herbs: "🌿",
  vegetables: "🥗", stock: "🥣", lettuce: "🥬", flour: "🌾", sugar: "🍬",
  egg: "🥚", milk: "🥛", pasta: "🍝", rice: "🍚", tomato: "🍅",
  potato: "🥔", lentils: "🫘", lemon: "🍋", mint: "🌱",
  // Tier 2 staples
  cheese: "🧀", chicken: "🍗", mushroom: "🍄", tea: "🍵", coffee: "☕",
  orange: "🍊", apple: "🍎", berries: "🫐", honey: "🍯", yogurt: "🥣",
  spices: "🌶️", cream: "🥛", cocoa: "🍫",
  // Tier 3
  beef: "🥩", fish: "🐟", carrot: "🥕", "sweet-potato": "🍠",
  pumpkin: "🎃", turkey: "🦃", corn: "🌽",
  // Tier 4
  salmon: "🐟", duck: "🦆", "goat-cheese": "🧀", shrimp: "🦐",
  pear: "🍐", pistachio: "🥜", matcha: "🍵",
  // Tier 5 prestige
  filet: "🥩", truffle: "🍄", caviar: "🥄", saffron: "🌶️",
  vanilla: "🍦", rose: "🌹", asparagus: "🥬",
};

/** Per-recipe plate emoji. Picked to read as "the dish on a plate"
 * for each one — e.g. butter-toast → 🍞, lemonade → 🍋, fish-tacos →
 * 🌮, filet-mignon → 🥩, pistachio-cream → 🍮. Anything not in the
 * map falls back to the generic 🍽️ plate. */
const RECIPE_ICONS: Record<string, string> = {
  // Appetizers
  toast: "🍞",
  "garden-salad": "🥗",
  bruschetta: "🍞",
  "stuffed-mushrooms": "🍄",
  "spring-rolls": "🥟",
  soup: "🍲",
  "house-pickles": "🥒",
  "tomato-skewers": "🍡",
  "pumpkin-crostini": "🎃",
  "shrimp-cups": "🦐",
  "truffle-bites": "🍄",
  // Mains
  pasta: "🍝",
  "chicken-rice": "🍛",
  "veggie-curry": "🍛",
  "beef-stew": "🍲",
  "fish-tacos": "🌮",
  "mushroom-risotto": "🍚",
  "cheese-omelet": "🍳",
  "lentil-bowl": "🥣",
  "turkey-sandwich": "🥪",
  "salmon-noodles": "🍜",
  "duck-polenta": "🍛",
  "filet-mignon": "🥩",
  "grilled-cheese": "🧀",
  "mac-and-cheese": "🍝",
  "veggie-stir-fry": "🥘",
  // Desserts
  pancakes: "🥞",
  "berry-tart": "🥧",
  "chocolate-cake": "🍰",
  "ice-cream": "🍨",
  "apple-pie": "🥧",
  "honey-yogurt": "🍯",
  "carrot-cake": "🍰",
  "pear-galette": "🥧",
  "pistachio-cream": "🍮",
  "golden-souffle": "🥮",
  // Drinks
  lemonade: "🍋",
  "iced-tea": "🧊",
  coffee: "☕",
  "berry-smoothie": "🥤",
  "orange-juice": "🍊",
  "mint-water": "💧",
  "spiced-cocoa": "🍫",
  "matcha-latte": "🍵",
  "rose-spritz": "🥂",
  "saffron-tea": "🍵",
  // Sides
  "garlic-bread": "🍞",
  fries: "🍟",
  "rice-bowl": "🍚",
  "roasted-veg": "🥕",
  "cheese-plate": "🧀",
  "buttered-corn": "🌽",
  "sweet-potatoes": "🍠",
  "goat-cheese-toast": "🧀",
  "asparagus-gratin": "🥬",
  "caviar-toast": "🥄",
};

export function ingredientIcon(id: string): string {
  return INGREDIENT_ICONS[id] ?? "🥗";
}

export function recipeIcon(id: string): string {
  return RECIPE_ICONS[id] ?? "🍽️";
}

/**
 * URL of a dish's authored plate art, e.g. `dishes/filet-mignon.png`.
 * These are transparent PNGs shipped as Vite static assets under
 * BASE_URL (prod base is `/cozy-bistro/cozy-bistro-3d/`), one per
 * recipe id. Not every id is guaranteed to have art, so callers that
 * render it in an <img> should wire an `onerror` that falls back to
 * `recipeIcon(id)` (the emoji) — the menu carousel does exactly this.
 */
export function recipeImage(id: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  return `${base}dishes/${id}.png`;
}
