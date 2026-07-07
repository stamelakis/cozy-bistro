/**
 * Restaurant interior color presets. Each theme bundles a wall + floor
 * color so the player can re-skin the bistro with one click instead of
 * shipping dozens of "wallpaper" / "flooring" SKUs (which is how the
 * 2D version's furniture catalog handled it).
 *
 * Themes are TIERED like furniture (T1–T5): higher tiers unlock as the
 * restaurant's luxury tier rises, cost more, and give a bigger appeal
 * bonus (attraction → spawn rate, ratingBonus → rating), mirroring the
 * decoration furniture. The default (T1, free) theme is the baseline and
 * carries no appeal — you buy a fancier theme to raise the vibe. Applying
 * a non-default theme to a floor adds that theme's appeal to the
 * restaurant aggregate (see server_furniture_aggregates + getAggregateStats).
 */

export interface RestaurantTheme {
  id: string;
  name: string;
  /** Hex RGB for the wall material. */
  wallColor: number;
  /** Hex RGB for the floor material. */
  floorColor: number;
  /** Cost to apply (in coins). Rises with tier. */
  cost: number;
  /** Quality tier 1–5. Gates the picker (locked above the restaurant's
   * luxury tier) and drives the appeal a floor gains from this theme. */
  tier: 1 | 2 | 3 | 4 | 5;
  /** Spawn-rate appeal added while this theme is active on a floor. 0 for
   * the T1 default (baseline). Mirrors furniture attractionBonus. */
  attractionBonus: number;
  /** Rating appeal added while this theme is active on a floor. Mirrors
   * furniture ratingBonus. */
  ratingBonus: number;
  /** 1-line vibe description shown in the panel. */
  description: string;
}

export const RESTAURANT_THEMES: readonly RestaurantTheme[] = [
  {
    id: "plain-white",
    name: "Plain White",
    wallColor: 0xfafafa,
    floorColor: 0xf2f2f0,
    cost: 0,
    tier: 1, attractionBonus: 0, ratingBonus: 0,
    description: "Blank canvas walls + floor (default starter).",
  },
  {
    id: "cozy-default",
    name: "Cozy Cottage",
    wallColor: 0xe8a98a,
    floorColor: 0xe7d4ad,
    cost: 180,
    tier: 2, attractionBonus: 2, ratingBonus: 0.02,
    description: "Warm peach walls, tan floor.",
  },
  {
    id: "modern-monochrome",
    name: "Modern Monochrome",
    wallColor: 0xf2f2f0,
    floorColor: 0x6f6a64,
    cost: 190,
    tier: 2, attractionBonus: 2, ratingBonus: 0.02,
    description: "Bright white walls, slate gray floor.",
  },
  {
    id: "mediterranean",
    name: "Mediterranean",
    wallColor: 0xf3eadb,
    floorColor: 0xc99268,
    cost: 200,
    tier: 2, attractionBonus: 2, ratingBonus: 0.02,
    description: "Cream stucco + terracotta tile.",
  },
  {
    id: "garden-fresh",
    name: "Garden Fresh",
    wallColor: 0xbfd4a8,
    floorColor: 0xe8dfc4,
    cost: 210,
    tier: 2, attractionBonus: 2, ratingBonus: 0.02,
    description: "Sage green walls, pale linen floor.",
  },
  {
    id: "coastal-breeze",
    name: "Coastal Breeze",
    wallColor: 0xeaf2f5,
    floorColor: 0xa8c0c8,
    cost: 220,
    tier: 2, attractionBonus: 2, ratingBonus: 0.02,
    description: "Crisp white walls, weathered seafoam floor.",
  },
  {
    id: "rustic-tavern",
    name: "Rustic Tavern",
    wallColor: 0x8a624a,
    floorColor: 0x5e3d28,
    cost: 300,
    tier: 3, attractionBonus: 3, ratingBonus: 0.03,
    description: "Mahogany walls + reclaimed dark wood floor.",
  },
  {
    id: "diner-classic",
    name: "Classic Diner",
    wallColor: 0xf2e0d0,
    floorColor: 0x222831,
    cost: 300,
    tier: 3, attractionBonus: 3, ratingBonus: 0.03,
    description: "Cream walls, black-and-white checker floor (visually).",
  },
  {
    id: "industrial-loft",
    name: "Industrial Loft",
    wallColor: 0x9a6a52,
    floorColor: 0x595550,
    cost: 320,
    tier: 3, attractionBonus: 3, ratingBonus: 0.03,
    description: "Exposed brick walls, polished concrete floor.",
  },
  {
    id: "parisian-cafe",
    name: "Parisian Café",
    wallColor: 0xf0e6d2,
    floorColor: 0x46413a,
    cost: 340,
    tier: 3, attractionBonus: 3, ratingBonus: 0.03,
    description: "Soft cream walls, dark bistro tile.",
  },
  {
    id: "autumn-harvest",
    name: "Autumn Harvest",
    wallColor: 0xd9a066,
    floorColor: 0x4a2e1c,
    cost: 320,
    tier: 3, attractionBonus: 3, ratingBonus: 0.03,
    description: "Amber walls, rich walnut floor.",
  },
  {
    id: "pastel-bakery",
    name: "Pastel Bakery",
    wallColor: 0xf5d8de,
    floorColor: 0xd6e8da,
    cost: 300,
    tier: 3, attractionBonus: 3, ratingBonus: 0.03,
    description: "Blush-pink walls, soft mint floor.",
  },
  {
    id: "japanese-zen",
    name: "Japanese Zen",
    wallColor: 0xeadfc8,
    floorColor: 0x8a7048,
    cost: 480,
    tier: 4, attractionBonus: 4, ratingBonus: 0.04,
    description: "Warm rice-paper walls, tatami-toned wood.",
  },
  {
    id: "fine-dining",
    name: "Fine Dining",
    wallColor: 0x1f1816,
    floorColor: 0x3a2c24,
    cost: 500,
    tier: 4, attractionBonus: 4, ratingBonus: 0.04,
    description: "Espresso walls, dark walnut floor.",
  },
  {
    id: "emerald-lounge",
    name: "Emerald Lounge",
    wallColor: 0x1e3a2e,
    floorColor: 0x2e2418,
    cost: 650,
    tier: 5, attractionBonus: 5, ratingBonus: 0.05,
    description: "Deep emerald walls, dark oak floor.",
  },
  {
    id: "midnight-jazz",
    name: "Midnight Jazz",
    wallColor: 0x2a3040,
    floorColor: 0x1a1d24,
    cost: 680,
    tier: 5, attractionBonus: 5, ratingBonus: 0.05,
    description: "Moody navy walls, near-black floor.",
  },
];

/** Appeal (attraction, ratingBonus) a floor gains from an active theme id.
 * (0, 0) for the default / unknown. Shared by the client aggregate mirror
 * and — hardcoded to match — the server's server_furniture_aggregates. */
export function themeAppeal(id: string): { attractionBonus: number; ratingBonus: number } {
  const t = RESTAURANT_THEMES.find((x) => x.id === id);
  return { attractionBonus: t?.attractionBonus ?? 0, ratingBonus: t?.ratingBonus ?? 0 };
}
