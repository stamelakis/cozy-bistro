/**
 * Catalog of plate + glass sets the player can buy from the dishware
 * panel. Each set is 4 pieces of one tier; the higher tiers cost more
 * per piece but lift the average customer satisfaction.
 *
 * The DishwareSystem tracks ownership as per-tier pools (clean + dirty
 * counts) so the player can mix tiers — a stack of cheap T1 plates for
 * the lunch rush plus a few T4 plates for VIPs.
 *
 * The starting kit is 20 T1 plates and 20 T1 glasses (5 sets each)
 * given to the player for free on a new save.
 */

import type { LuxuryTier } from "./types";

export type DishKind = "plate" | "glass";

export interface DishwareSetDef {
  /** Stable id for the catalog row + save format. e.g. "plate-t1". */
  id: string;
  kind: DishKind;
  /** Display name in the buy UI. */
  name: string;
  tier: LuxuryTier;
  /** Cost in coins for ONE SET. */
  cost: number;
  /** How many pieces are in a set. Always 4 in v1; surfaced as a field
   * for catalog clarity and in case future tiers ever ship in bulk. */
  setSize: number;
  /** Per-piece bonus added to the customer's satisfaction score when a
   * plate / glass of this tier is served. T1 = 0 (utility); higher tiers
   * lift base rating. Applied per course in finalizeVisit. */
  satisfactionPerPiece: number;
}

/** Plates: used for food courses (appetizer / main / dessert / side). */
export const PLATE_SETS: readonly DishwareSetDef[] = [
  { id: "plate-t1", kind: "plate", name: "Diner Plates",       tier: 1, cost:  12, setSize: 4, satisfactionPerPiece: 0    },
  { id: "plate-t2", kind: "plate", name: "Ceramic Plates",     tier: 2, cost:  36, setSize: 4, satisfactionPerPiece: 0.5  },
  { id: "plate-t3", kind: "plate", name: "Stoneware Plates",   tier: 3, cost:  90, setSize: 4, satisfactionPerPiece: 1.0  },
  { id: "plate-t4", kind: "plate", name: "Porcelain Plates",   tier: 4, cost: 220, setSize: 4, satisfactionPerPiece: 1.6  },
  { id: "plate-t5", kind: "plate", name: "Bone China Plates",  tier: 5, cost: 500, setSize: 4, satisfactionPerPiece: 2.2  },
];

/** Glasses / cups: used for drink courses. */
export const GLASS_SETS: readonly DishwareSetDef[] = [
  { id: "glass-t1", kind: "glass", name: "Tumblers",           tier: 1, cost:   8, setSize: 4, satisfactionPerPiece: 0    },
  { id: "glass-t2", kind: "glass", name: "Highball Glasses",   tier: 2, cost:  24, setSize: 4, satisfactionPerPiece: 0.4  },
  { id: "glass-t3", kind: "glass", name: "Stemmed Glasses",    tier: 3, cost:  70, setSize: 4, satisfactionPerPiece: 0.8  },
  { id: "glass-t4", kind: "glass", name: "Crystal Glasses",    tier: 4, cost: 180, setSize: 4, satisfactionPerPiece: 1.3  },
  { id: "glass-t5", kind: "glass", name: "Hand-blown Goblets", tier: 5, cost: 420, setSize: 4, satisfactionPerPiece: 1.9  },
];

export const ALL_DISHWARE_SETS: readonly DishwareSetDef[] = [
  ...PLATE_SETS,
  ...GLASS_SETS,
];

/** Look up a set by its stable id. Returns undefined for legacy / unknown ids
 * coming out of an old save so the loader can skip them gracefully. */
export function getDishwareSet(id: string): DishwareSetDef | undefined {
  return ALL_DISHWARE_SETS.find((d) => d.id === id);
}

/** Look up the satisfaction bonus paid per plate / glass of a given
 * tier. Returns 0 for tiers outside [1..5] so callers can pass an
 * already-clamped or even garbage value without crashing. */
export function dishSatisfactionForTier(kind: DishKind, tier: number): number {
  const list = kind === "plate" ? PLATE_SETS : GLASS_SETS;
  const set = list.find((s) => s.tier === tier);
  return set?.satisfactionPerPiece ?? 0;
}

/** Base dish-storage capacity the player has BEFORE placing any
 * cabinets — covers the starter 20 plates + 20 glasses without
 * forcing them to build a kitchen first. */
export const BASE_DISH_CAPACITY = 48;

/** New-game starting inventory: 20 T1 plates + 20 T1 glasses, all
 * clean. Bigger than a set (4) so the player can immediately serve a
 * busy first day before having to think about washing. */
export const STARTER_PLATE_COUNT = 20;
export const STARTER_GLASS_COUNT = 20;
