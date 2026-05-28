/**
 * Restaurant interior color presets. Each theme bundles a wall + floor
 * color so the player can re-skin the bistro with one click instead of
 * shipping dozens of "wallpaper" / "flooring" SKUs (which is how the
 * 2D version's furniture catalog handled it).
 *
 * Costs are flat — pay once per theme switch.
 */

export interface RestaurantTheme {
  id: string;
  name: string;
  /** Hex RGB for the wall material. */
  wallColor: number;
  /** Hex RGB for the floor material. */
  floorColor: number;
  /** Cost to apply (in coins). */
  cost: number;
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
    description: "Blank canvas walls + floor (default starter).",
  },
  {
    id: "cozy-default",
    name: "Cozy Cottage",
    wallColor: 0xe8a98a,
    floorColor: 0xe7d4ad,
    cost: 180,
    description: "Warm peach walls, tan floor.",
  },
  {
    id: "modern-monochrome",
    name: "Modern Monochrome",
    wallColor: 0xf2f2f0,
    floorColor: 0x6f6a64,
    cost: 200,
    description: "Bright white walls, slate gray floor.",
  },
  {
    id: "rustic-tavern",
    name: "Rustic Tavern",
    wallColor: 0x8a624a,
    floorColor: 0x5e3d28,
    cost: 250,
    description: "Mahogany walls + reclaimed dark wood floor.",
  },
  {
    id: "mediterranean",
    name: "Mediterranean",
    wallColor: 0xf3eadb,
    floorColor: 0xc99268,
    cost: 220,
    description: "Cream stucco + terracotta tile.",
  },
  {
    id: "garden-fresh",
    name: "Garden Fresh",
    wallColor: 0xbfd4a8,
    floorColor: 0xe8dfc4,
    cost: 240,
    description: "Sage green walls, pale linen floor.",
  },
  {
    id: "diner-classic",
    name: "Classic Diner",
    wallColor: 0xf2e0d0,
    floorColor: 0x222831,
    cost: 280,
    description: "Cream walls, black-and-white checker floor (visually).",
  },
  {
    id: "fine-dining",
    name: "Fine Dining",
    wallColor: 0x1f1816,
    floorColor: 0x3a2c24,
    cost: 480,
    description: "Espresso walls, dark walnut floor.",
  },
];
