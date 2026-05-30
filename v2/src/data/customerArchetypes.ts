/**
 * Customer personality archetypes. Each guest is assigned one on
 * spawn; the archetype modifies patience, tip generosity, and order
 * size. Adds variety to the guest stream so two consecutive guests
 * don't behave identically.
 *
 * Probabilities (`weight`) sum to 100 — used by rollArchetype to pick
 * one. Higher-weight archetypes are more common.
 */

export interface CustomerArchetype {
  id: string;
  name: string;
  /** Selection weight (0-100). All weights sum to ~100. */
  weight: number;
  /** Multiplied into both ORDER_PATIENCE_BASE_SECONDS and
   * SERVE_PATIENCE_BASE_SECONDS — same scalar for both phases of the
   * customer's wait. Quick Lunch (0.6×) is impatient at every step;
   * Foodie (1.3×) is forgiving at every step. */
  patienceMultiplier: number;
  /** Multiplied into the tip computed from the star rating. */
  tipMultiplier: number;
  /** -1 = wants fewer courses than average, +1 = wants more. */
  orderSizeBias: -1 | 0 | 1;
  /** Short emoji + label shown in the guest's status bubble. */
  shortLabel: string;
  /** 0..1 probability this archetype will visit the WC during their
   * meal. Foodies / dates linger so they need a break; quick-lunch
   * customers are in/out and rarely use it. WC users care strongly
   * about the bathroom score in their final rating; non-users still
   * care a little (the bathroom door is visible from the floor). */
  wcUseChance: number;
}

export const customerArchetypes: readonly CustomerArchetype[] = [
  { id: "casual",      name: "Casual Diner",  weight: 33, patienceMultiplier: 1.0,  tipMultiplier: 1.0, orderSizeBias:  0, shortLabel: "🙂", wcUseChance: 0.40 },
  { id: "quick-lunch", name: "Quick Lunch",   weight: 20, patienceMultiplier: 0.6,  tipMultiplier: 0.8, orderSizeBias: -1, shortLabel: "⚡", wcUseChance: 0.15 },
  { id: "foodie",      name: "Foodie",        weight: 15, patienceMultiplier: 1.3,  tipMultiplier: 1.5, orderSizeBias:  1, shortLabel: "🍷", wcUseChance: 0.55 },
  { id: "tourist",     name: "Tourist",       weight: 15, patienceMultiplier: 0.85, tipMultiplier: 1.3, orderSizeBias:  0, shortLabel: "📸", wcUseChance: 0.45 },
  { id: "date-night",  name: "Date Night",    weight: 10, patienceMultiplier: 1.2,  tipMultiplier: 1.4, orderSizeBias:  1, shortLabel: "💕", wcUseChance: 0.50 },
  { id: "grump",       name: "Grumpy Critic", weight:  5, patienceMultiplier: 0.7,  tipMultiplier: 0.4, orderSizeBias:  0, shortLabel: "😠", wcUseChance: 0.40 },
  // Rare: food critic whose rating counts triple but tips huge if pleased.
  { id: "critic",      name: "Food Critic",   weight:  2, patienceMultiplier: 0.9,  tipMultiplier: 3.0, orderSizeBias:  1, shortLabel: "🕵️", wcUseChance: 0.55 },
];

/** Pick one archetype weighted by its `weight` field. */
export function rollArchetype(): CustomerArchetype {
  const total = customerArchetypes.reduce((sum, a) => sum + a.weight, 0);
  let pick = Math.random() * total;
  for (const a of customerArchetypes) {
    pick -= a.weight;
    if (pick <= 0) return a;
  }
  return customerArchetypes[0]; // fallback (shouldn't hit)
}
