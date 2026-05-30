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

// ============================================================================
//                            PER-GUEST TASTE
// ============================================================================
// Each spawned guest rolls a CustomerTaste in addition to their archetype.
// The taste drives WHERE they choose to sit (replaces the old "first seat
// near the door" rule) and biases what they order. Archetype provides the
// statistical priors (foodies favour main courses, date-nights like window
// seats, quick-lunch crowds don't care about decor) — the taste is what
// actually gets stamped on the individual guest.
// ============================================================================

export type DietKind = "food" | "drink" | "both";
export type RecipeCategoryPref = "appetizer" | "main" | "dessert" | "drink" | "side";

export interface CustomerTaste {
  /** What they came in for. Hard filter on seat surface — a "drink"
   * customer only sits at a drink-surface seat (bar counter, coffee
   * table); a "food" customer only at food surfaces; "both" can use
   * either. Replaces the old `wantsDrinks` field. */
  diet: DietKind;
  /** Theme id (matches RestaurantTheme.id in data/themes.ts) this
   * guest prefers. Seats on a floor styled with this theme score
   * higher. Rolled uniformly across the available themes so adding
   * a new theme automatically pulls customer interest. */
  preferredTheme: string;
  /** 0..1 — how much they care about decor quality (style + rating
   * of nearby decoration items). 0 = oblivious; 1 = swing factor in
   * seat choice. Multiplied into the per-seat decor density score. */
  decorAffinity: number;
  /** Their favourite recipe category. buildOrder weights this 2x in
   * recipe selection; creditCourse adds a small satisfaction bonus
   * when a served dish matches it. Doesn't affect seat choice. */
  preferredCategory: RecipeCategoryPref;
  /** Party size 1-4. Currently affects SEAT preference only (favour
   * a 2-top for a couple, 4-top for a group). Visual multi-character
   * party-walks-in-together is a future upgrade — one model per
   * guest for now, but a group-of-3 guest prefers tables sized for
   * 3+ over a 2-top so the table type reads as "made for groups". */
  groupSize: number;
  /** 0..1 — likes window seats. Bonus when the seat's host table
   * sits adjacent to a wall with a window placed on it. */
  windowAffinity: number;
  /** −1..+1 — privacy axis. −1 wants central / loud (people-watch
   * energy), 0 doesn't care, +1 wants a quiet corner. Penalises
   * seats near the kitchen line / bathroom corridor. */
  privacyBias: number;
  /** 0..1 — wants to sit AT the bar specifically. Bonus for bar-
   * counter seats. Overlaps with diet="drink" but separate: a
   * "both" customer with high barAffinity will still gravitate to
   * a bar stool over a regular drink table. */
  barAffinity: number;
}

/** Roll a fresh taste for a guest, biased by their archetype. The
 * archetype provides the statistical prior (e.g. foodies tend to
 * have high decorAffinity), but every taste field is sampled per
 * guest so two foodies sitting next to each other can still want
 * different themes / window seats / etc. */
export function rollCustomerTaste(archetype: CustomerArchetype, availableThemes: readonly string[]): CustomerTaste {
  const r = Math.random;
  // Diet — 25% drink-only, 50% food, 25% both. Date-night and
  // foodies skew toward "both" (multi-course experience); quick-
  // lunch skews toward "food" (in/out).
  const dietRoll = r();
  let diet: DietKind;
  if (archetype.id === "quick-lunch") {
    diet = dietRoll < 0.85 ? "food" : "drink";
  } else if (archetype.id === "date-night" || archetype.id === "foodie") {
    diet = dietRoll < 0.7 ? "both" : (dietRoll < 0.9 ? "food" : "drink");
  } else {
    diet = dietRoll < 0.25 ? "drink" : (dietRoll < 0.75 ? "food" : "both");
  }
  // Preferred theme — uniform pick from whatever's in the catalog
  // so adding a new theme spreads customer interest automatically.
  const preferredTheme = availableThemes.length > 0
    ? availableThemes[Math.floor(r() * availableThemes.length)]
    : "plain-white";
  // Decor affinity — foodies / dates / critics care a lot; quick-
  // lunch barely notices.
  const decorBase =
    archetype.id === "quick-lunch" ? 0.15 :
    archetype.id === "foodie" || archetype.id === "date-night" || archetype.id === "critic" ? 0.7 :
    0.4;
  const decorAffinity = clamp01(decorBase + (r() - 0.5) * 0.3);
  // Preferred category — quick-lunch loves mains, foodie spreads
  // across all, drinkers prefer drinks.
  const catRoll = r();
  let preferredCategory: RecipeCategoryPref;
  if (diet === "drink") {
    preferredCategory = "drink";
  } else if (archetype.id === "quick-lunch") {
    preferredCategory = catRoll < 0.7 ? "main" : (catRoll < 0.9 ? "side" : "appetizer");
  } else if (archetype.id === "foodie" || archetype.id === "critic") {
    preferredCategory = catRoll < 0.3 ? "main" : (catRoll < 0.55 ? "dessert" : (catRoll < 0.8 ? "appetizer" : "side"));
  } else {
    preferredCategory = catRoll < 0.45 ? "main" : (catRoll < 0.7 ? "dessert" : (catRoll < 0.85 ? "appetizer" : (catRoll < 0.95 ? "side" : "drink")));
  }
  // Group size 1-4 — most solo / pair, occasional group.
  const groupRoll = r();
  const groupSize = groupRoll < 0.5 ? 1 : (groupRoll < 0.85 ? 2 : (groupRoll < 0.97 ? 3 : 4));
  // Window — date-nights almost always want one, quick-lunch
  // doesn't care, casual is middle.
  const windowBase =
    archetype.id === "date-night" ? 0.85 :
    archetype.id === "quick-lunch" ? 0.15 :
    archetype.id === "foodie" || archetype.id === "tourist" ? 0.55 :
    0.4;
  const windowAffinity = clamp01(windowBase + (r() - 0.5) * 0.3);
  // Privacy — date-nights want corners, tourists want central,
  // grumps want quiet, others normal.
  const privacyBase =
    archetype.id === "date-night" ? 0.7 :
    archetype.id === "tourist" ? -0.4 :
    archetype.id === "grump" ? 0.5 :
    0;
  const privacyBias = clamp(privacyBase + (r() - 0.5) * 0.4, -1, 1);
  // Bar affinity — small base; archetype doesn't strongly predict
  // it, more about personality than crowd shape. Drink-only customers
  // get an automatic bump (the bar is where their fixture lives).
  const barBase = diet === "drink" ? 0.55 : 0.15;
  const barAffinity = clamp01(barBase + (r() - 0.5) * 0.4);
  return {
    diet, preferredTheme, decorAffinity, preferredCategory,
    groupSize, windowAffinity, privacyBias, barAffinity,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
