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
  /** Multiplied into the base PATIENCE_BASE_SECONDS. */
  patienceMultiplier: number;
  /** Multiplied into the tip computed from the star rating. */
  tipMultiplier: number;
  /** -1 = wants fewer courses than average, +1 = wants more. */
  orderSizeBias: -1 | 0 | 1;
  /** Short emoji + label shown in the guest's status bubble. */
  shortLabel: string;
}

export const customerArchetypes: readonly CustomerArchetype[] = [
  { id: "casual",      name: "Casual Diner",  weight: 35, patienceMultiplier: 1.0,  tipMultiplier: 1.0, orderSizeBias:  0, shortLabel: "🙂" },
  { id: "quick-lunch", name: "Quick Lunch",   weight: 20, patienceMultiplier: 0.6,  tipMultiplier: 0.8, orderSizeBias: -1, shortLabel: "⚡" },
  { id: "foodie",      name: "Foodie",        weight: 15, patienceMultiplier: 1.3,  tipMultiplier: 1.5, orderSizeBias:  1, shortLabel: "🍷" },
  { id: "tourist",     name: "Tourist",       weight: 15, patienceMultiplier: 0.85, tipMultiplier: 1.3, orderSizeBias:  0, shortLabel: "📸" },
  { id: "date-night",  name: "Date Night",    weight: 10, patienceMultiplier: 1.2,  tipMultiplier: 1.4, orderSizeBias:  1, shortLabel: "💕" },
  { id: "grump",       name: "Grumpy Critic", weight:  5, patienceMultiplier: 0.7,  tipMultiplier: 0.4, orderSizeBias:  0, shortLabel: "😠" },
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
