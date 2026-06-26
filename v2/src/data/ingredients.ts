/**
 * Per-ingredient unit costs. Drives:
 *  - the auto-shop cost (used to be a flat $2/unit; now varies)
 *  - the recipe sell-price formula (price = base profit + ingredient cost)
 *  - recipe-upgrade material costs (you consume L units of each ingredient)
 *
 * Tuned so "staple" pantry items (bread, vegetables, oil) are dirt cheap
 * and prestige items (truffle, caviar, saffron) are expensive enough to
 * make a tier-5 dish meaningfully pricey to serve.
 */

export const INGREDIENT_COSTS: Record<string, number> = {
  // Tier 1 staples — $1-2
  bread: 1, butter: 1, oil: 1, salt: 1, herbs: 1,
  vegetables: 2, stock: 2, lettuce: 2, flour: 1, sugar: 1,
  egg: 2, milk: 2, pasta: 2, rice: 1, tomato: 2,
  potato: 1, lentils: 1, lemon: 2, mint: 1,
  bun: 1, onion: 1, dough: 2, basil: 1, "bbq-sauce": 2,
  // Tier 2 staples — $3-5
  cheese: 4, chicken: 5, mushroom: 3, tea: 3, coffee: 4,
  orange: 3, apple: 3, berries: 4, honey: 4, yogurt: 3,
  spices: 3, cream: 4, cocoa: 5,
  mozzarella: 4, sausage: 5,
  // Tier 3 — $6-9
  beef: 8, fish: 7, carrot: 4, "sweet-potato": 5,
  pumpkin: 5, turkey: 7, corn: 4, squid: 7,
  // Tier 4 — $9-14
  salmon: 12, duck: 11, "goat-cheese": 9, shrimp: 11,
  pear: 6, pistachio: 10, matcha: 9, ribs: 10,
  // Tier 5 prestige — $15-30
  filet: 18, truffle: 30, caviar: 28, saffron: 25,
  vanilla: 14, rose: 16, asparagus: 9,
};

/** Default if an ingredient isn't in the table (shouldn't happen). */
const DEFAULT_INGREDIENT_COST = 3;

export function getIngredientCost(id: string): number {
  return INGREDIENT_COSTS[id] ?? DEFAULT_INGREDIENT_COST;
}

/** Sum of per-unit costs for a recipe's full ingredient list. */
export function getRecipeIngredientCost(ingredients: readonly string[]): number {
  let total = 0;
  for (const id of ingredients) total += getIngredientCost(id);
  return total;
}
