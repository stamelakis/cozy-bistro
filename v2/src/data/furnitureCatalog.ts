/**
 * Maps logical furniture IDs (matching the 2D game's furniture.ts ids where
 * possible) to Kenney GLB model paths. Lets the WorldBuilder swap from
 * placeholder cubes to real 3D models without touching scene code.
 *
 * Models live under v2/public/assets/kenney/ (Vite serves them at
 * /assets/kenney/<file>.glb at runtime).
 *
 * SCALE SEMANTICS (changed when we moved to per-tile auto-fit, see
 * fitFurniture.ts). `scale` is now a FILL RATIO of the assigned tile
 * footprint, not a raw mesh multiplier:
 *   1.0  → the item fills its assigned tile(s) completely
 *   0.7  → the item fills ~70% of its tile(s), with margin around it
 *   0.4  → small decorative prop centered in a tile
 * Auto-fit handles the actual mesh→world unit conversion per-asset, so
 * an authored 0.7 here means 0.7 visually regardless of whether the
 * raw Kenney mesh ships at 0.5 or 2.5 units wide.
 *
 * Procedural items (modelPath starts with "proc:") bypass auto-fit
 * because they author meshes at exact tile size already.
 */

/**
 * One sitting position around a table. Offsets are relative to the table's
 * center; facingY is the chair's required rotation (Three.js Y, where
 * 0 = -Z, π/2 = +X, π = +Z, -π/2 = -X). platePos is where the served plate
 * sits on the tabletop for this seat.
 *
 * A chair placed at (table.x + dx, table.z + dz) with rotation facingY
 * becomes a FUNCTIONAL seat — a customer can sit there to eat. Chairs
 * placed elsewhere are only useful as overflow / waiting seats.
 */
export interface SeatSlot {
  dx: number;
  dz: number;
  facingY: number;
  platePos: { dx: number; dz: number };
}

export interface FurnitureDef {
  /** Stable id, matches the 2D furniture.ts id when possible. */
  id: string;
  /** Human label for the build menu. */
  name: string;
  /** Game category (mirrors 2D categories). */
  category: "table" | "chair" | "stove" | "wash" | "appliance" | "counter" | "bar" | "storage" | "decoration" | "plant" | "lamp" | "door" | "bathroom" | "wall";
  /** Relative path under v2/public — fed to ModelLoader.load(). */
  modelPath: string;
  /** Fill ratio used by fitFurniture as a multiplier on top of the
   * tile-fit scale. 1.0 means "fill the assigned tile(s)"; 0.7 means
   * "fill 70%". See fitFurniture.ts header for the full semantics. */
  scale: number;
  /** Footprint in grid cells. A 2×2 dining table that seats 4 should be
   * size {width: 2, depth: 2} so it visually covers all four cells. */
  size: { width: number; depth: number };
  /** Cost in coins. */
  cost: number;
  /** Optional rotation offset (radians) if the model points the wrong way. */
  rotationOffset?: number;
  /** How the item snaps to the grid:
   *   - "tile" (default): centered in a cell, occupies the cell
   *   - "edge": sits ON a grid line between two cells, doesn't claim
   *     either cell. Internal walls, internal doorways, decorative
   *     partitions. The tiles either side stay placeable.
   *   - "wall": mounted ON an existing wall (any edge-placed wall item
   *     already in the scene). Picks the nearest placed wall to the
   *     cursor, snaps to its centre at chest height (~1.5m), and
   *     copies its rotation so the item face matches the wall face.
   *     Used for art, mirrors, menu boards, signage, sconces.
   *   - "ceiling": hangs from the top of the wall (y=3). Snaps to
   *     integer tile centers like "tile" placement, but the ceiling
   *     and floor are independent layers — a ceiling lamp at (3, 2)
   *     does NOT block a chair from going on the floor tile below it.
   *     Ceiling-lamp, ceiling-fan, hanging-plant.
   *   - "surface": sits ON TOP of another placed item that exposes
   *     surfaceSlots (a counter, table, etc.). Snaps to the nearest
   *     free slot on the hovered host; doesn't claim a floor tile.
   *     When the host moves, surface items follow; when the host is
   *     sold, surface items are sold too. Used for table lamps,
   *     toasters, radios, coffee machines, etc.
   *   - "wall-shelf": mounts on a wall like "wall" but at upper-cabinet
   *     height (~1.7m). Requires the cell IN FRONT OF the wall to be
   *     empty or to contain an item ≤1.2m tall (a counter / sink /
   *     stove), so the cabinet has clearance above whatever's below.
   *     Used for upper / corner kitchen cabinets. */
  placement?: "tile" | "edge" | "wall" | "ceiling" | "surface" | "wall-shelf";
  /** Host items declare an array of local-frame offsets where
   * surface-placed items can sit. dx/dz are in the host's NATURAL
   * orientation (rotY=0); the host's rotation is applied to derive
   * world coords. A table with 4 placeable spots on its corners would
   * set surfaceSlots: [{dx: -0.4, dz: -0.4}, {dx: 0.4, dz: -0.4}, ...].
   * The Y position is computed from the host model's measured top. */
  surfaceSlots?: readonly { dx: number; dz: number }[];
  /** Optional realistic world-space height (in units ≈ metres). When set,
   * fitFurniture independently stretches Y so the placed item lands at
   * this height regardless of the raw mesh's proportions. Without it
   * Kenney chairs look stubby and Kenney tables look like coffee tables
   * because their XZ-fit uniform scale leaves them too short. */
  targetHeight?: number;
  /** Tables: the sitting positions around this table. Chairs placed at one
   * of these become functional seats for the dining loop. */
  seatSlots?: readonly SeatSlot[];
  /** What kind of orders this item serves.
   *   - "food" (default): full menu — appetizer + main + dessert
   *   - "drink": drinks-only. On TABLES it changes the order pool
   *     (coffee tables seat 4 around a shared tabletop for drinks only).
   *     On CHAIRS it's a UI hint — the build menu shows a "🥤 Drinks
   *     only" badge so players know sofas / benches / corner sofas
   *     belong in a lounge setup. Chair behavior is identical
   *     regardless. */
  surface?: "food" | "drink";
  /** Optional explicit per-cell footprint mask in the def's NATURAL
   * orientation (rotY = 0). Rows index Z (depth), columns index X
   * (width). A value of 1 means the cell is occupied; 0 means it's
   * open. Used by the L-shaped corner sofas — their `size` is 2×2 but
   * one tile of the L is intentionally open. When absent, the
   * footprint defaults to a solid rectangle of size.width × size.depth.
   * The mask rotates with the placed item (axis-aligned only). */
  footprint?: readonly (readonly (0 | 1)[])[];
  /** Force fitFurniture to scale X and Z independently so the model
   * fills its full footprint even when the raw mesh's aspect ratio
   * doesn't match. Used on the Long Sofa — the Kenney mesh is roughly
   * 1:1 in XZ but we want it to span 2 tiles wide; without this flag
   * the uniform-XZ "min" rule compresses it down to a single tile. The
   * model gets visibly stretched horizontally, but a 1.7× horizontal
   * stretch on cushion meshes is way better than a sofa that reads as
   * a regular sofa. */
  stretchFootprint?: boolean;
  /** Flat ground decor (rugs, doormats). Skips the occupancy check
   * BOTH ways — a flat item can be placed under anything, and any
   * tile-layer item can be placed on top of a flat item. Visually
   * fine because flat items have targetHeight ≈ 0.04 so they sit
   * essentially on the floor under everything else. */
  flat?: boolean;
  /** Skip the standard FOOTPRINT_MARGIN (the 4% breathing room around
   * each tile) so the mesh fills the entire footprint with no visible
   * gap to adjacent placements. Used by run-together pieces (bar
   * counter + bar end, future kitchen counter runs) where the player
   * expects neighbouring items to abut cleanly without a seam. */
  fillTile?: boolean;
  /** Push the mesh toward one X-axis tile edge instead of centring it
   * in the tile. Bar ends use this so the FLAT side of the end cap
   * lands at the tile boundary where the bar counter connects, and the
   * ROUNDED side faces outward at the opposite tile edge. The shift is
   * applied in model-local X, so it rotates with the placed item:
   *   "x+" → flat side at the +X edge of the natural orientation
   *   "x-" → flat side at the −X edge of the natural orientation
   * Rotating the item 180° flips which world tile-edge the flat side
   * lands on, so the player can mirror the same model for left vs
   * right end caps. */
  anchorEdge?: "x+" | "x-";

  // === Gameplay stats (Game.getFurnitureBonuses sums these across all placed) ===
  style?: number;
  comfort?: number;
  attractionBonus?: number;
  ratingBonus?: number;
  seatingCapacity?: number;
  /** Kitchen appliance this item provides. Used by the recipe gating
   * system: a recipe with `appliances: ["toaster"]` is only orderable
   * when at least one placed item has `provides: "toaster"`. Items
   * without `provides` don't contribute to any recipe's makeability. */
  provides?: import("./types").ApplianceId;
  /** Hand-curated BuildMenu tier (1 = starter diner … 5 = flagship/luxury).
   * When set, overrides the inferQualityTier cost+ratingBonus heuristic.
   * Use this whenever the cost ladder doesn't match the item's visual
   * vibe — e.g. a $40 tablecloth-top table that reads as a clear step
   * up from a $48 bare wood table. Unset means "fall back to the
   * heuristic", which is fine for items where cost is a decent proxy. */
  tier?: 1 | 2 | 3 | 4 | 5;
  /** How many extra units of pantry stock this piece adds to the
   * restaurant's max stock per ingredient. Fridges contribute the most,
   * shelves/cabinets a smaller amount. Game sums this across all placed
   * items and uses it to scale the auto-shop's stock target. */
  stockCapacity?: number;
  /** How many plates / glasses this piece can hold. Non-fridge storage
   * (cabinets, drawers, bar counters) contributes; fridges deliberately
   * don't, since cold dish storage is silly. DishwareSystem sums this
   * across placed items + a base of BASE_DISH_CAPACITY for the global
   * dish cap. */
  dishCapacity?: number;
}

/** Seat slots for a 1×1 coffee table — chairs go on all four sides and
 * each gets a tiny offset on the tabletop for their drink. Coffee tables
 * are anchored at an integer cell (1×1 → cell center) and the four
 * adjacent cells become the seats. Each customer faces the table center,
 * so drinks read as belonging to one person but the actual plate
 * positions cluster around the centre of the small table — exactly the
 * "everyone shares the tabletop" vibe the player asked for. */
const COFFEE_TABLE_SEAT_SLOTS: readonly SeatSlot[] = [
  // North seat (above the table, looking south at the table).
  { dx:  0, dz: -1, facingY:  Math.PI,     platePos: { dx:  0,    dz: -0.22 } },
  // South seat.
  { dx:  0, dz:  1, facingY:  0,           platePos: { dx:  0,    dz:  0.22 } },
  // East seat (right of the table, looking west).
  { dx:  1, dz:  0, facingY:  Math.PI / 2, platePos: { dx:  0.22, dz:  0    } },
  // West seat.
  { dx: -1, dz:  0, facingY: -Math.PI / 2, platePos: { dx: -0.22, dz:  0    } },
];

/** Seat layout for a 2-tile-wide bar counter: two stools on the +Z
 * (customer-facing) long side, both facing -Z toward the bar. The
 * stools land at integer tile centers (dx=±0.5, dz=+1) for a 2×1 bar
 * anchored at a half-integer X cross-section, so they line up with
 * the surface slots on the bar top. The platePos is the drink
 * position on the bar top in front of each customer — rotateSlotOffset
 * clamps it to the bar's edge so the drink reads as being just inside
 * the front lip rather than at the very edge.
 *
 * For default rot=0:
 *   left stool   at world (bar.x - 0.5, bar.z + 1) facing north
 *   right stool  at world (bar.x + 0.5, bar.z + 1) facing north
 * Rotate the bar 180° to put the stool side on the opposite face. */
const BAR_COUNTER_SEAT_SLOTS: readonly SeatSlot[] = [
  { dx: -0.5, dz:  1, facingY: 0, platePos: { dx: -0.5, dz: 0.4 } },
  { dx:  0.5, dz:  1, facingY: 0, platePos: { dx:  0.5, dz: 0.4 } },
];

/** Bench-style seat layout for a 2×2 dining table that seats 4: TWO
 * chairs on each LONG side (north and south of the table at default
 * rotation), zero chairs on the short sides. Pairs the seats up like
 * the bench example the player gave — the player can drop a wall or
 * a window against either short end without losing seats, and chairs
 * sit shoulder-to-shoulder per side instead of one-per-cardinal.
 *
 * For a table anchored at (0.5, 1.5) the four chair world coords are
 * (0, 0), (1, 0), (0, 3), (1, 3) — all integer cell centers.
 *
 * Customer facings:
 *   north seats (z=-1.5)  → face +Z (south, toward table) → θ = π
 *   south seats (z=+1.5)  → face -Z (north, toward table) → θ = 0
 *
 * Plate offsets sit just inside the long edge of the table top
 * (dz = ±0.8), aligned with each chair's x so the plate reads as
 * belonging to that seat. The plate's WORLD Y comes from the placed
 * table's bounding box at runtime so different table meshes can have
 * different top heights without the plate floating. */
const STANDARD_TABLE_SEAT_SLOTS: readonly SeatSlot[] = [
  // North side — 2 seats facing south.
  { dx: -0.5, dz: -1.5, facingY: Math.PI, platePos: { dx: -0.5, dz: -0.8 } },
  { dx:  0.5, dz: -1.5, facingY: Math.PI, platePos: { dx:  0.5, dz: -0.8 } },
  // South side — 2 seats facing north.
  { dx: -0.5, dz:  1.5, facingY: 0,       platePos: { dx: -0.5, dz:  0.8 } },
  { dx:  0.5, dz:  1.5, facingY: 0,       platePos: { dx:  0.5, dz:  0.8 } },
];

// Per-category fill ratios. See "SCALE SEMANTICS" in the file header —
// these are NOT raw mesh multipliers anymore, they're "how much of the
// assigned tile this category should visually occupy".
const S_TABLE = 1.0;   // dining tables fill their tile
const S_CHAIR = 0.7;   // chair smaller than tile so it can sit beside a table without overlap
/** Fill ratio for multi-tile seating (sofas, benches). The default
 * S_CHAIR=0.7 reads as a SHRUNK single chair when applied to a 2-or-3
 * wide piece of furniture, so the sofa visually fits into a single tile
 * even though its footprint is supposed to span the whole length. We
 * bump these to ~0.92 so they look the size their footprint claims —
 * still a hair of margin so they don't visibly z-fight an adjacent
 * placement. */
const S_SOFA_WIDE = 0.92;
const S_KITCHEN = 1.0; // appliances fill their tile (stove, sink, fridge)
const S_DECOR = 0.55;  // crates / books / small props well below tile size
const S_PLANT = 0.55;  // potted plants — leaves the pot reading as decoration
const S_LAMP = 0.5;    // lamps are slim; auto-fit would otherwise inflate them
const S_DOOR = 1.0;    // door frame fills its tile
const S_PROC = 1.0;    // procedurals bypass auto-fit; this is their raw multiplier

/** Realistic dining-table height (≈ 0.75 m). The Y stretch in fitFurniture
 * lifts the table top here even though the XZ-fit would otherwise leave
 * it stubby. Plate offsets pick this height up via the registered model's
 * bounding box, so food doesn't float above an empty void. Other
 * categories use the per-category defaults in fitFurniture's
 * DEFAULT_HEIGHTS — no need to repeat them here unless an individual
 * piece wants to override (e.g. a bar stool vs a dining chair). */
const H_TABLE = 0.75;

export const furnitureCatalog: readonly FurnitureDef[] = [
  // Tables. Dining tables are 2×2 tiles so they have a real seat for
  // each of the 4 chairs that pack around them. Coffee tables stay 1×1
  // since they're not dining seating.
  // Small Table is 2×2 tiles but the Kenney mesh ships ~1.88:1 — the
  // uniform-min auto-fit fills the width and leaves the depth at ≈1.0 m,
  // so the table reads as a 2×1 plank stuck to the cross-section line
  // between the two depth rows. stretchFootprint scales X and Z
  // independently so the top covers all four cells. Some leg/top
  // proportion change is visible vs the raw mesh (Z stretches ~1.87×
  // more than X), but a square small table is a legit silhouette and
  // is way preferable to half the footprint visibly empty.
  { id: "small-table",   name: "Small Table",   category: "table",
    modelPath: "assets/kenney/table.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 22, style: 1,
    tier: 1, stretchFootprint: true,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "round-table",   name: "Round Table",   category: "table",
    modelPath: "assets/kenney/tableRound.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 80, style: 2, ratingBonus: 0.02,
    tier: 2,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "dining-table",  name: "Dining Table",  category: "table",
    modelPath: "assets/kenney/tableCross.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 110, style: 3, ratingBonus: 0.03,
    tier: 2,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS,
    // MVP surface slot for Phase B: one centre spot so a Table Lamp or
    // similar can sit on the table. Real per-host slot layouts (corners,
    // centerpiece, etc.) come in the catalog audit pass.
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "fancy-table",   name: "Linen Table",   category: "table",
    modelPath: "assets/kenney/tableCrossCloth.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 850, style: 5, ratingBonus: 0.08,
    tier: 4,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "cloth-table",   name: "Tablecloth Top", category: "table",
    modelPath: "assets/kenney/tableCloth.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 260, style: 4, ratingBonus: 0.05,
    tier: 3,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "glass-table",   name: "Glass Table",   category: "table",
    modelPath: "assets/kenney/tableGlass.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 650, style: 4, ratingBonus: 0.07,
    tier: 4,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  // Coffee tables are DRINK surfaces — seats on all 4 sides share the
  // tabletop so up to 4 customers can park their drinks here, but the
  // menu is restricted to drinks (no main / appetizer / dessert).
  // Visually that reads as a lounge corner; mechanically it's quicker
  // turnover at lower revenue.
  { id: "coffee-table",  name: "Coffee Table",  category: "table",
    modelPath: "assets/kenney/tableCoffee.glb", scale: S_TABLE * 0.85, size: { width: 1, depth: 1 }, cost: 28, style: 2,
    tier: 1, surface: "drink", targetHeight: 0.42, seatSlots: COFFEE_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "coffee-glass",  name: "Glass Coffee Table", category: "table",
    modelPath: "assets/kenney/tableCoffeeGlass.glb", scale: S_TABLE * 0.85, size: { width: 1, depth: 1 }, cost: 70, style: 3, ratingBonus: 0.01,
    tier: 2, surface: "drink", targetHeight: 0.42, seatSlots: COFFEE_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },

  // Chairs
  { id: "wooden-chair",   name: "Wooden Chair",  category: "chair",
    modelPath: "assets/kenney/chair.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 18, comfort: 1, style: 1,
    tier: 1 },
  { id: "cushion-chair",  name: "Cushion Chair", category: "chair",
    modelPath: "assets/kenney/chairCushion.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 55, comfort: 2, style: 2, ratingBonus: 0.01,
    tier: 2 },
  { id: "modern-chair",   name: "Modern Chair",  category: "chair",
    modelPath: "assets/kenney/chairModernCushion.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 170, comfort: 3, style: 3, ratingBonus: 0.04,
    tier: 3 },
  { id: "rounded-chair",  name: "Rounded Chair", category: "chair",
    modelPath: "assets/kenney/chairRounded.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 75, comfort: 3, style: 2, ratingBonus: 0.02,
    tier: 2 },
  { id: "bar-stool",      name: "Bar Stool",     category: "chair",
    modelPath: "assets/kenney/stoolBar.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 22, comfort: 1, style: 1,
    tier: 1, surface: "drink", targetHeight: 0.75 },
  { id: "lounge-chair",   name: "Lounge Chair",  category: "chair",
    modelPath: "assets/kenney/loungeChair.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 220, comfort: 4, style: 3, ratingBonus: 0.05,
    tier: 3 },
  { id: "bench-cushion",  name: "Cushion Bench", category: "chair",
    modelPath: "assets/kenney/benchCushion.glb", scale: S_SOFA_WIDE, size: { width: 2, depth: 1 }, cost: 290, comfort: 3, style: 2, ratingBonus: 0.05, seatingCapacity: 2,
    tier: 3 },
  { id: "bench-cushion-low", name: "Low Cushion Bench", category: "chair",
    modelPath: "assets/kenney/benchCushionLow.glb", scale: S_SOFA_WIDE, size: { width: 2, depth: 1 }, cost: 130, comfort: 2, style: 2, ratingBonus: 0.03, seatingCapacity: 2,
    tier: 2, targetHeight: 0.55 },
  { id: "bench-plain",    name: "Wooden Bench",  category: "chair",
    modelPath: "assets/kenney/bench.glb", scale: S_SOFA_WIDE, size: { width: 2, depth: 1 }, cost: 48, comfort: 1, style: 1, ratingBonus: 0.01, seatingCapacity: 2,
    tier: 1, targetHeight: 0.55 },
  { id: "bar-stool-sq",   name: "Square Bar Stool", category: "chair",
    modelPath: "assets/kenney/stoolBarSquare.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 60, comfort: 1, style: 2, ratingBonus: 0.01,
    tier: 2, surface: "drink", targetHeight: 0.75 },
  // Lounge chairs are tier-4 statement pieces. Their raw Kenney meshes
  // have different aspect ratios (relax is 0.49×0.67, design is
  // 0.73×0.41), so the previous stretchFootprint kept them at full tile
  // coverage but smashed both to a square ≈0.64×0.64 — and a square
  // chair has no visible "front" so pressing R looked like a no-op.
  // Drop stretchFootprint and bump the scale to ≈1.0 so uniform-min
  // fit lets each chair keep its natural aspect ratio while still
  // landing close to tile-filling on at least one axis. Rotation is
  // now visible because the chair silhouette is asymmetric.
  { id: "lounge-relax",   name: "Relax Lounge",  category: "chair",
    modelPath: "assets/kenney/loungeChairRelax.glb", scale: 1.0, size: { width: 1, depth: 1 }, cost: 480, comfort: 5, style: 4, ratingBonus: 0.07,
    tier: 4 },
  { id: "lounge-design",  name: "Designer Lounge Chair", category: "chair",
    modelPath: "assets/kenney/loungeDesignChair.glb", scale: 1.0, size: { width: 1, depth: 1 }, cost: 620, comfort: 4, style: 5, ratingBonus: 0.07,
    tier: 4 },
  { id: "sofa",           name: "Sofa",          category: "chair",
    modelPath: "assets/kenney/loungeSofa.glb", scale: S_SOFA_WIDE, size: { width: 2, depth: 1 }, cost: 370, comfort: 5, style: 3, ratingBonus: 0.06, seatingCapacity: 2,
    tier: 3, surface: "drink" },
  // Long sofa: the Kenney raw mesh is almost square (0.98 W × 0.82 D)
  // so uniform-XZ auto-fit was compressing it down to a single tile.
  // stretchFootprint lets fitFurniture scale X independently so the
  // sofa actually spans 2 tiles wide, like a proper bench sofa.
  { id: "sofa-long",      name: "Long Sofa",     category: "chair",
    modelPath: "assets/kenney/loungeSofaLong.glb", scale: S_SOFA_WIDE, size: { width: 2, depth: 1 }, cost: 780, comfort: 5, style: 3, ratingBonus: 0.08, seatingCapacity: 2,
    tier: 4, stretchFootprint: true, surface: "drink" },
  // Corner sofa is an L — 3 of 4 tiles in a 2×2 footprint are occupied,
  // the 4th (the inner elbow of the L) is intentionally open so the
  // player can drop a coffee table inside it. Same 2-customer capacity
  // as a regular sofa, but the extra style + comfort + attraction make
  // it the showpiece of a lounge corner.
  // Mask orientation derived from a vertex-density scan of the Kenney
  // mesh: 290 verts split (0, 98, 98, 94) across the (TL, TR, BL, BR)
  // raw quadrants, so the empty (TL) is at raw (near 0, near 0). After
  // fitFurniture's recenter + scale that empty quadrant lands at world
  // cell (0, 1) — index (mi=0, mj=1) — making mask[1][0] = 0. Solid
  // cells are (0, 0), (1, 0), (1, 1).
  { id: "sofa-corner",    name: "Corner Sofa",   category: "chair",
    modelPath: "assets/kenney/loungeSofaCorner.glb", scale: S_SOFA_WIDE, size: { width: 2, depth: 2 }, cost: 950, comfort: 6, style: 4, ratingBonus: 0.08, seatingCapacity: 2,
    tier: 4, footprint: [[1, 1], [0, 1]], surface: "drink" },
  // Designer Sofa — same fix as Long Sofa: its Kenney raw mesh is
  // nearly square, so uniform-min auto-fit shrank it to about one tile
  // and the 2-tile footprint visibly "stuck to one side", which read
  // as the sofa being anchored to the cross-section line. With
  // stretchFootprint the mesh spans both claimed tiles and recenters
  // on the 2-tile span like the long sofa already does.
  { id: "sofa-design",    name: "Designer Sofa", category: "chair",
    modelPath: "assets/kenney/loungeDesignSofa.glb", scale: S_SOFA_WIDE, size: { width: 2, depth: 1 }, cost: 1800, comfort: 5, style: 6, ratingBonus: 0.09, seatingCapacity: 2,
    tier: 5, stretchFootprint: true, surface: "drink" },

  // Kitchen — cooking burners ("stove" category). Sinks and dishwashers
  // live in "wash" below so the chef-assignment + per-stove flame
  // systems only see actual burners.
  { id: "stove",          name: "Gas Stove",       category: "stove",
    modelPath: "assets/kenney/kitchenStove.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 240,
    tier: 2, provides: "stove" },
  { id: "stove-electric", name: "Electric Stove",  category: "stove",
    modelPath: "assets/kenney/kitchenStoveElectric.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 480,
    tier: 3, provides: "stove" },
  // Dishwashing — sinks + dishwashers ("wash" category). Each placed
  // item reduces the dirty-dish wash interval; the chef never claims
  // these as cook stations.
  { id: "sink",           name: "Sink",            category: "wash",
    modelPath: "assets/kenney/kitchenSink.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 100,
    tier: 1 },
  { id: "dishwasher",     name: "Dishwasher",      category: "wash",
    modelPath: "proc:dishwasher", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 450,
    tier: 3 },
  { id: "dishwasher-pro", name: "Pro Dishwasher Line", category: "wash",
    modelPath: "proc:dishwasher-pro", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 1500,
    tier: 5 },
  { id: "microwave",      name: "Microwave",       category: "appliance",
    modelPath: "assets/kenney/kitchenMicrowave.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 100,
    tier: 1, placement: "surface", provides: "microwave" },
  { id: "fridge",         name: "Fridge",          category: "storage",
    modelPath: "assets/kenney/kitchenFridge.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 400,
    tier: 2, stockCapacity: 4, targetHeight: 1.75, surfaceSlots: [{ dx: 0, dz: 0 }] },
  // Double fridge — T4 between built-in (T3) and walk-in (T5). 2-tile
  // wide, full height; uses the regular fridge mesh with
  // stretchFootprint so the model spans both tiles instead of leaving
  // half the footprint empty.
  { id: "fridge-double",  name: "Double Fridge",   category: "storage",
    modelPath: "assets/kenney/kitchenFridge.glb", scale: S_KITCHEN, size: { width: 2, depth: 1 }, cost: 1500,
    tier: 4, targetHeight: 2.0, stockCapacity: 18, stretchFootprint: true,
    surfaceSlots: [{ dx: -0.5, dz: 0 }, { dx: 0.5, dz: 0 }] },
  // Walk-in is a "room" — 2×2 tiles, stretched tall. Top tier flagship
  // for serious kitchens; carries by far the most stock of any single
  // unit. Top is broad enough for two surface items.
  { id: "fridge-large",   name: "Walk-in Fridge",  category: "storage",
    modelPath: "assets/kenney/kitchenFridgeLarge.glb", scale: S_KITCHEN, size: { width: 2, depth: 2 }, cost: 3000,
    tier: 5, targetHeight: 2.2, stockCapacity: 45,
    surfaceSlots: [{ dx: -0.5, dz: 0 }, { dx: 0.5, dz: 0 }] },
  { id: "counter",        name: "Counter",         category: "counter",
    modelPath: "assets/kenney/kitchenCabinet.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 90,
    tier: 1, dishCapacity: 4, surfaceSlots: [{ dx: 0, dz: 0 }], provides: "counter" },
  { id: "coffee-machine", name: "Coffee Machine",  category: "appliance",
    modelPath: "assets/kenney/kitchenCoffeeMachine.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 250,
    tier: 1, placement: "surface", provides: "coffee" },
  { id: "blender",        name: "Blender",         category: "appliance",
    modelPath: "assets/kenney/kitchenBlender.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 80,
    tier: 1, placement: "surface", provides: "blender" },
  { id: "toaster",        name: "Toaster",         category: "appliance",
    modelPath: "assets/kenney/toaster.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 40,
    tier: 1, placement: "surface", provides: "toaster" },
  // Hoods mount at upper-cabinet height (wall-shelf) so they hang above
  // a stove or counter rather than taking a floor tile of their own.
  // Same clearance rule as upper cabinets: cell below must be ≤1.2m, so
  // a stove (0.92m) qualifies and a fridge (≥2m) doesn't.
  // Hood vents authored with their visible face on +Z, so without a
  // flip the rotation lands them with the suction face pointing into
  // the wall and the duct hardware facing the room.
  { id: "kitchen-hood",   name: "Range Hood",      category: "appliance",
    modelPath: "assets/kenney/hoodModern.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 60,
    tier: 1, placement: "wall-shelf", provides: "hood", rotationOffset: Math.PI },
  { id: "kitchen-hood-l", name: "Large Range Hood", category: "appliance",
    modelPath: "assets/kenney/hoodLarge.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 140, ratingBonus: 0.01,
    tier: 2, placement: "wall-shelf", provides: "hood", rotationOffset: Math.PI },
  // Bar counter + bar end are a run-together set. fillTile drops the
  // standard 4% breathing margin so the bar counter actually reaches
  // its tile boundaries on the long side (was 1.84 m of a 2.0 m span,
  // leaving 8 cm gaps that read as "the bar doesn't touch the end
  // cap"). The bar end is a thin slab (raw 0.10 m wide); without an
  // anchor edge it sat centred in a 1.0 m tile, leaving ~0.25 m of
  // air between it and the bar counter's edge. anchorEdge:"x+" pushes
  // the bar end's mesh so the flat side lands at the +X tile edge,
  // which is where the bar counter abuts when the player places them
  // adjacent. Rotating the bar end 180° flips it to the right-hand
  // end cap (flat side at −X, rounded outward to +X).
  // Bar counter doubles as drink-serving seating: 2 bar stools tuck up
  // to the +Z long side, customers face north toward the bar top, and
  // drinks land on the front edge in front of each stool. surface:
  // "drink" gates the order pool to the bar menu (no apps / mains /
  // desserts), same way coffee tables do. Despite the "counter"
  // category, GuestSpawner treats anything with seatSlots as a serving
  // surface — see getTableSurface in FurnitureRegistry.
  // Moved to the new "bar" build category. bar-counter ALSO provides
  // the "bar" appliance — that's the only station a barman will cook
  // at and the only one any drink recipe will route to. Without this,
  // drinks would queue forever once the chef pool was filtered to
  // exclude bar tickets.
  { id: "bar-counter",    name: "Bar Counter",     category: "bar",
    modelPath: "assets/kenney/kitchenBar.glb", scale: S_KITCHEN, size: { width: 2, depth: 1 }, cost: 300, ratingBonus: 0.03,
    tier: 3, fillTile: true, dishCapacity: 8, surface: "drink",
    provides: "bar",
    seatSlots: BAR_COUNTER_SEAT_SLOTS,
    surfaceSlots: [{ dx: -0.5, dz: 0 }, { dx: 0.5, dz: 0 }] },
  { id: "bar-end",        name: "Bar End",         category: "bar",
    modelPath: "assets/kenney/kitchenBarEnd.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 250, ratingBonus: 0.04,
    // Surface slot shifted to dx=0.25 so anything placed on the bar end
    // sits ON the shifted mesh rather than floating where the tile centre
    // used to be. dz=0 stays at the depth midline. rotateSlotOffset
    // applies model.rotation.y to this, so a 180°-rotated bar end gets
    // its surface slot mirrored to dx=−0.25 along with the mesh.
    // Doesn't provide "bar" itself — only the main counter does the
    // cooking work, the end is decorative.
    tier: 3, fillTile: true, anchorEdge: "x+", dishCapacity: 4, surfaceSlots: [{ dx: 0.25, dz: 0 }] },
  // Built-in slots into a cabinet run flush with the wall — reads as
  // bigger/taller than a free-standing fridge for the same footprint.
  { id: "fridge-built-in", name: "Built-in Fridge", category: "storage",
    modelPath: "assets/kenney/kitchenFridgeBuiltIn.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 700,
    tier: 3, stockCapacity: 7, targetHeight: 2.0 },
  { id: "fridge-small",   name: "Mini Fridge",     category: "storage",
    modelPath: "assets/kenney/kitchenFridgeSmall.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 180,
    tier: 1, stockCapacity: 2 },
  { id: "counter-drawer", name: "Drawer Counter",  category: "counter",
    modelPath: "assets/kenney/kitchenCabinetDrawer.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 120,
    tier: 2, dishCapacity: 6, surfaceSlots: [{ dx: 0, dz: 0 }], provides: "counter" },

  // Decor
  { id: "cardboard-box",  name: "Supply Crate",    category: "decoration",
    modelPath: "assets/kenney/cardboardBoxClosed.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 8,
    tier: 1 },
  { id: "cardboard-open", name: "Open Crate",      category: "decoration",
    modelPath: "assets/kenney/cardboardBoxOpen.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 10,
    tier: 1 },
  { id: "books",          name: "Stack of Books",  category: "decoration",
    modelPath: "assets/kenney/books.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 6,
    tier: 1, placement: "surface" },
  { id: "side-table",     name: "Side Table",      category: "decoration",
    modelPath: "assets/kenney/sideTable.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 35,
    tier: 2, targetHeight: 0.6, surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "side-table-d",   name: "Side Table w/ Drawer", category: "decoration",
    modelPath: "assets/kenney/sideTableDrawers.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 45, ratingBonus: 0.01,
    tier: 2, targetHeight: 0.6, surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "ceiling-fan",    name: "Ceiling Fan",     category: "decoration",
    modelPath: "assets/kenney/ceilingFan.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 80, ratingBonus: 0.01,
    tier: 2, placement: "ceiling" },
  { id: "trashcan",       name: "Trash Can",       category: "decoration",
    modelPath: "assets/kenney/trashcan.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 14,
    tier: 1 },
  // Cushions / pillows removed — they were pure decor with no clear
  // placement story (where do you sit a cushion?) and added catalog
  // noise. Old saves silently skip the unknown ids.

  // Wall art / signage (procedural, no GLB). All wall-mounted — snap
  // to the nearest placed wall instead of taking up a floor tile.
  { id: "framed-art-warm", name: "Framed Art (Warm)", category: "decoration",
    modelPath: "proc:framed-art-warm", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 50, style: 4, attractionBonus: 2, ratingBonus: 0.01,
    tier: 2, placement: "wall" },
  { id: "framed-art-cool", name: "Framed Art (Cool)", category: "decoration",
    modelPath: "proc:framed-art-cool", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 50, style: 4, attractionBonus: 2, ratingBonus: 0.01,
    tier: 2, placement: "wall" },
  { id: "framed-art-mint", name: "Framed Art (Mint)", category: "decoration",
    modelPath: "proc:framed-art-mint", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 50, style: 4, attractionBonus: 2, ratingBonus: 0.01,
    tier: 2, placement: "wall" },
  { id: "menu-board",      name: "Chalk Menu Board",  category: "decoration",
    modelPath: "proc:menu-board", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 75, style: 3, attractionBonus: 3, ratingBonus: 0.02,
    tier: 2, placement: "wall" },
  { id: "neon-sign",       name: "Neon OPEN Sign",    category: "decoration",
    modelPath: "proc:neon-sign", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 110, style: 4, attractionBonus: 6, ratingBonus: 0.02,
    tier: 2, placement: "wall" },
  { id: "wine-wall",       name: "Wine Wall",         category: "decoration",
    modelPath: "proc:wine-wall", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 550, style: 6, ratingBonus: 0.06, attractionBonus: 3,
    tier: 4, placement: "wall" },

  // Plants — explicit targetHeight per variant so Small / Medium /
  // Tall actually read as a height progression instead of all landing
  // at the same category default.
  { id: "plant-small",    name: "Small Plant",     category: "plant",
    modelPath: "assets/kenney/plantSmall1.glb", scale: S_PLANT, size: { width: 1, depth: 1 }, cost: 12, attractionBonus: 1, style: 1,
    tier: 1, targetHeight: 0.5 },
  { id: "plant-medium",   name: "Medium Plant",    category: "plant",
    modelPath: "assets/kenney/plantSmall2.glb", scale: S_PLANT, size: { width: 1, depth: 1 }, cost: 18, attractionBonus: 2, style: 1,
    tier: 1, targetHeight: 0.8 },
  { id: "plant-tall",     name: "Tall Plant",      category: "plant",
    modelPath: "assets/kenney/plantSmall3.glb", scale: S_PLANT, size: { width: 1, depth: 1 }, cost: 25, attractionBonus: 2, style: 2,
    tier: 1, targetHeight: 1.3 },
  { id: "potted-plant",   name: "Potted Plant",    category: "plant",
    modelPath: "assets/kenney/pottedPlant.glb", scale: S_PLANT, size: { width: 1, depth: 1 }, cost: 55, attractionBonus: 3, style: 2, ratingBonus: 0.01,
    tier: 2 },
  { id: "bookcase",       name: "Bookcase",        category: "decoration",
    modelPath: "assets/kenney/bookcaseClosedDoors.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 100, style: 4, attractionBonus: 2, ratingBonus: 0.02,
    tier: 2, targetHeight: 1.65, surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "bookcase-open",  name: "Open Bookcase",   category: "decoration",
    modelPath: "assets/kenney/bookcaseOpen.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 60, style: 3, attractionBonus: 2, ratingBonus: 0.01,
    tier: 2, targetHeight: 1.65, surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "coat-rack",      name: "Coat Rack",       category: "decoration",
    modelPath: "assets/kenney/coatRackStanding.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 22, style: 1,
    tier: 1, targetHeight: 1.7 },
  // Rugs are flat — without an explicit override the decoration default
  // (0.55m) puffs them into 55cm-tall blocks. They stay 1×1 footprint
  // so they snap to a tile CENTER (odd-sized snap rule); the scale > 1
  // lets them visually overhang into neighbouring tiles, which is fine
  // because rugs don't block movement or placement.
  { id: "rug-rectangle",  name: "Rectangular Rug", category: "decoration",
    modelPath: "assets/kenney/rugRectangle.glb", scale: 1.6, size: { width: 1, depth: 1 }, cost: 40, style: 3, comfort: 1, ratingBonus: 0.01,
    tier: 2, targetHeight: 0.04, flat: true },
  // Round rug: scale 2.0 → ~2-tile diameter, the player gets a
  // centrepiece that visually covers ~4 tiles around the snapped tile.
  { id: "rug-round",      name: "Round Rug",       category: "decoration",
    modelPath: "assets/kenney/rugRound.glb", scale: 2.0, size: { width: 1, depth: 1 }, cost: 30, style: 2, comfort: 1,
    tier: 1, targetHeight: 0.04, flat: true },

  // Lighting
  { id: "floor-lamp",     name: "Round Floor Lamp",  category: "lamp",
    modelPath: "assets/kenney/lampRoundFloor.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 55, style: 2, attractionBonus: 1, ratingBonus: 0.01,
    tier: 2 },
  { id: "floor-lamp-sq",  name: "Square Floor Lamp", category: "lamp",
    modelPath: "assets/kenney/lampSquareFloor.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 65, style: 2, attractionBonus: 1, ratingBonus: 0.02,
    tier: 2 },
  { id: "ceiling-lamp",   name: "Ceiling Lamp",      category: "lamp",
    modelPath: "assets/kenney/lampSquareCeiling.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 30, style: 1, attractionBonus: 1, ratingBonus: 0.01,
    tier: 1, placement: "ceiling" },
  { id: "table-lamp",     name: "Table Lamp",        category: "lamp",
    modelPath: "assets/kenney/lampSquareTable.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 20, style: 2,
    tier: 1, placement: "surface", targetHeight: 0.4 },
  // Kenney lampWall.glb authors the visible bulb on the +Z face; our
  // wall-mount rotation puts the model's −Z toward the room, so without
  // a flip the player sees the bulb-less back of the sconce. rotationOffset
  // π flips the model in its own frame so the bulb ends up facing the
  // room. Same fix bathroomMirror + coatRack already had.
  { id: "wall-lamp",      name: "Wall Sconce",       category: "lamp",
    modelPath: "assets/kenney/lampWall.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 25, style: 2, attractionBonus: 1,
    tier: 1, placement: "wall", targetHeight: 0.3, rotationOffset: Math.PI },

  // Doors & windows. The "door" id is a procedural door with a separate
  // hinged panel so we can swing the panel without moving the frame.
  // Edge-placed: doors sit ON grid lines (between two tiles), exactly
  // like internal walls. That way the front door snaps to the front
  // wall plane rather than dropping the frame in the middle of a tile.
  { id: "door",         name: "Front Door",    category: "door",
    modelPath: "proc:front-door", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 50,
    tier: 1, placement: "edge" },
  // All door + window variants are edge-placed: they sit on a grid
  // line (between two tiles) so the frame lands ON the wall plane,
  // not in the middle of a tile. Items in the "door" category also
  // trigger the front-wall rebuild and are gated to perimeter walls;
  // windows stay decoration so they can be dropped on any wall
  // (internal partitions included) without punching a hole.
  { id: "door-kenney",  name: "Kenney Doorway", category: "door",
    modelPath: "assets/kenney/doorway.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 60,
    tier: 1, placement: "edge" },
  { id: "door-open",    name: "Open Doorway",  category: "door",
    modelPath: "assets/kenney/doorwayOpen.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 90, ratingBonus: 0.01,
    tier: 2, placement: "edge" },
  { id: "door-front",   name: "Front Door",    category: "door",
    modelPath: "assets/kenney/doorwayFront.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 130, ratingBonus: 0.02,
    tier: 2, placement: "edge" },
  { id: "wall-doorway", name: "Wall Doorway",  category: "door",
    modelPath: "assets/kenney/wallDoorway.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 200, ratingBonus: 0.03,
    tier: 3, placement: "edge" },
  { id: "wall-doorway-w", name: "Wide Doorway", category: "door",
    modelPath: "assets/kenney/wallDoorwayWide.glb", scale: S_DOOR, size: { width: 2, depth: 1 }, cost: 280, ratingBonus: 0.04,
    tier: 3, placement: "edge" },
  // Windows live alongside doors and doorways in the build menu now —
  // they were buried under "decoration" before, where players didn't
  // think to look. They're still edge-placed (same mechanism walls /
  // doors use) so the placement logic doesn't need to change.
  // Windows: targetHeight sized to fit the sill+lintel opening cut into
  // the perimeter wall. The wall rebuild punches a band between sill top
  // (y=0.9) and lintel bottom (y=2.2) — 1.3m of vertical clearance — so
  // the window mesh stretches Y to match instead of poking into the
  // sill/lintel boxes above and below.
  { id: "window",       name: "Window",        category: "door",
    modelPath: "assets/kenney/wallWindow.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 90, ratingBonus: 0.01,
    tier: 2, placement: "edge", targetHeight: 1.3 },
  { id: "window-slide", name: "Sliding Window", category: "door",
    modelPath: "assets/kenney/wallWindowSlide.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 130, ratingBonus: 0.02,
    tier: 2, placement: "edge", targetHeight: 1.3 },

  // === Bathroom — needed for the toilet-use customer loop. ===
  // Toilets sit in a small partitioned room; sinks for handwashing.
  { id: "toilet",         name: "Toilet",          category: "bathroom",
    modelPath: "assets/kenney/toilet.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 100, style: 2, ratingBonus: 0.01,
    tier: 1 },
  { id: "toilet-square",  name: "Square Toilet",   category: "bathroom",
    modelPath: "assets/kenney/toiletSquare.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 280, style: 3, ratingBonus: 0.03,
    tier: 2 },
  { id: "bathroom-sink",  name: "Bathroom Sink",   category: "bathroom",
    modelPath: "assets/kenney/bathroomSink.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 80, style: 2,
    tier: 1 },
  { id: "bathroom-sink-sq", name: "Square Bath Sink", category: "bathroom",
    modelPath: "assets/kenney/bathroomSinkSquare.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 220, style: 3, ratingBonus: 0.02,
    tier: 2 },
  { id: "bathroom-mirror", name: "Bathroom Mirror", category: "bathroom",
    modelPath: "assets/kenney/bathroomMirror.glb", scale: 0.7, size: { width: 1, depth: 1 }, cost: 40, style: 2, attractionBonus: 1,
    tier: 1,
    // Kenney's bathroomMirror.glb has its reflective face on +Z, but
    // our wall-mount logic assumes the standard "GLB front = -Z". Flip
    // 180° so the mirror's glass faces the room instead of the wall.
    placement: "wall", rotationOffset: Math.PI },
  { id: "bathroom-cabinet", name: "Bath Cabinet",  category: "bathroom",
    modelPath: "assets/kenney/bathroomCabinet.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 140, style: 2, ratingBonus: 0.01,
    tier: 2, surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "bathroom-cabinet-d", name: "Bath Cabinet (Drawer)", category: "bathroom",
    modelPath: "assets/kenney/bathroomCabinetDrawer.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 250, style: 3, ratingBonus: 0.02,
    tier: 2, surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "bathtub",        name: "Bathtub",         category: "bathroom",
    modelPath: "assets/kenney/bathtub.glb", scale: 0.95, size: { width: 2, depth: 1 }, cost: 750, style: 4, attractionBonus: 3, ratingBonus: 0.07,
    tier: 4, targetHeight: 0.6 },
  { id: "shower",         name: "Shower",          category: "bathroom",
    modelPath: "assets/kenney/shower.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 450, style: 3, attractionBonus: 1, ratingBonus: 0.05,
    tier: 3, targetHeight: 2.0 },
  { id: "shower-round",   name: "Round Shower",    category: "bathroom",
    modelPath: "assets/kenney/showerRound.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 900, style: 4, attractionBonus: 2, ratingBonus: 0.08,
    tier: 4, targetHeight: 2.0 },

  // === Internal walls + doorways — edge-placed, don't claim tiles. ===
  // These snap to grid lines instead of tile centers so the player can
  // partition off rooms (bathroom, private dining, kitchen line, etc.)
  // without losing the floor area to wall thickness.
  { id: "int-wall",       name: "Wall Section",    category: "wall",
    modelPath: "proc:int-wall", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 18,
    tier: 1, placement: "edge" },
  { id: "int-wall-half",  name: "Half Wall",       category: "wall",
    modelPath: "proc:int-wall-half", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 14, style: 1,
    tier: 1, placement: "edge" },
  { id: "int-doorway",    name: "Internal Doorway", category: "wall",
    modelPath: "proc:int-doorway", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 40, style: 2, ratingBonus: 0.01,
    tier: 2, placement: "edge" },
  { id: "int-window",     name: "Interior Window", category: "wall",
    modelPath: "proc:int-window", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 50, style: 2, attractionBonus: 1, ratingBonus: 0.02,
    tier: 2, placement: "edge" },

  // === More tables: coffee variants for lounge corners. ===
  // Same drinks-only behaviour as the round coffee tables above.
  { id: "coffee-square",  name: "Square Coffee Table", category: "table",
    modelPath: "assets/kenney/tableCoffeeSquare.glb", scale: S_TABLE * 0.85, size: { width: 1, depth: 1 }, cost: 32, style: 2, ratingBonus: 0.01,
    tier: 1, surface: "drink", targetHeight: 0.42, seatSlots: COFFEE_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "coffee-glass-sq", name: "Glass Square Coffee", category: "table",
    modelPath: "assets/kenney/tableCoffeeGlassSquare.glb", scale: S_TABLE * 0.85, size: { width: 1, depth: 1 }, cost: 90, style: 3, ratingBonus: 0.02,
    tier: 2, surface: "drink", targetHeight: 0.42, seatSlots: COFFEE_TABLE_SEAT_SLOTS,
    surfaceSlots: [{ dx: 0, dz: 0 }] },

  // === More chairs / desks. ===
  { id: "chair-desk",     name: "Desk Chair",      category: "chair",
    modelPath: "assets/kenney/chairDesk.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 65, comfort: 2, style: 2, ratingBonus: 0.02,
    tier: 2 },
  { id: "chair-modern-fr", name: "Frame Chair",    category: "chair",
    modelPath: "assets/kenney/chairModernFrameCushion.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 190, comfort: 3, style: 3, ratingBonus: 0.04,
    tier: 3 },
  { id: "sofa-ottoman",   name: "Sofa Ottoman",    category: "chair",
    modelPath: "assets/kenney/loungeSofaOttoman.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 260, comfort: 4, style: 3, ratingBonus: 0.05,
    tier: 3 },
  { id: "sofa-design-c",  name: "Designer Corner Sofa", category: "chair",
    modelPath: "assets/kenney/loungeDesignSofaCorner.glb", scale: S_SOFA_WIDE, size: { width: 2, depth: 2 }, cost: 2400, comfort: 6, style: 6, ratingBonus: 0.10, seatingCapacity: 2,
    tier: 5, footprint: [[1, 1], [0, 1]], surface: "drink" },

  // === More kitchen cabinets + corner pieces (storage). ===
  // These are upper / corner cabinets — currently placed as floor items
  // but conceptually "storage". Future Phase: convert to a wall-shelf
  // placement that mounts above shorter counters.
  // Upper cabinets all authored with the door / open face on +Z, so the
  // wall-mount rotation pinned the cabinet doors INTO the wall and the
  // unfinished back at the room. Flip in the model frame so the visible
  // door / shelf side ends up facing the kitchen line.
  { id: "kitchen-upper",  name: "Upper Cabinet",   category: "storage",
    modelPath: "assets/kenney/kitchenCabinetUpper.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 80, style: 1,
    tier: 1, stockCapacity: 2, dishCapacity: 6, placement: "wall-shelf", rotationOffset: Math.PI },
  { id: "kitchen-upper-d", name: "Upper Cabinet Double", category: "storage",
    modelPath: "assets/kenney/kitchenCabinetUpperDouble.glb", scale: S_KITCHEN, size: { width: 2, depth: 1 }, cost: 130, style: 1,
    tier: 2, stockCapacity: 4, dishCapacity: 12, placement: "wall-shelf", rotationOffset: Math.PI },
  { id: "kitchen-upper-l", name: "Upper Cabinet Low", category: "storage",
    modelPath: "assets/kenney/kitchenCabinetUpperLow.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 60, style: 1,
    tier: 1, stockCapacity: 2, dishCapacity: 4, targetHeight: 0.55, placement: "wall-shelf", rotationOffset: Math.PI },
  // Corner cabinets are FULL-HEIGHT base units (counter line), not
  // upper wall-shelf cabinets — they fit at the corner of a counter
  // run on the floor. Surface slot on top so the player can put a
  // toaster / blender / coffee machine on them like a regular counter.
  { id: "kitchen-corner-i", name: "Inner Corner Cabinet", category: "storage",
    modelPath: "assets/kenney/kitchenCabinetCornerInner.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 120, style: 1,
    tier: 2, stockCapacity: 2, dishCapacity: 8,
    surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "kitchen-corner-r", name: "Round Corner Cabinet", category: "storage",
    modelPath: "assets/kenney/kitchenCabinetCornerRound.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 150, style: 2,
    tier: 2, stockCapacity: 2, dishCapacity: 8,
    surfaceSlots: [{ dx: 0, dz: 0 }] },

  // === Entertainment / TV / electronics. ===
  { id: "tv-modern",      name: "Modern TV",       category: "decoration",
    modelPath: "assets/kenney/televisionModern.glb", scale: 0.95, size: { width: 1, depth: 1 }, cost: 260, style: 4, attractionBonus: 3, ratingBonus: 0.04,
    tier: 3, placement: "surface" },
  { id: "tv-vintage",     name: "Vintage TV",      category: "decoration",
    modelPath: "assets/kenney/televisionVintage.glb", scale: 0.7, size: { width: 1, depth: 1 }, cost: 180, style: 3, attractionBonus: 2, ratingBonus: 0.03,
    tier: 3, placement: "surface" },
  { id: "tv-antenna",     name: "Antenna TV",      category: "decoration",
    modelPath: "assets/kenney/televisionAntenna.glb", scale: 0.65, size: { width: 1, depth: 1 }, cost: 120, style: 2, ratingBonus: 0.01,
    tier: 2, placement: "surface" },
  { id: "tv-cabinet",     name: "TV Cabinet",      category: "decoration",
    modelPath: "assets/kenney/cabinetTelevision.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 90, style: 2, ratingBonus: 0.01,
    tier: 2, surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "tv-cabinet-d",   name: "TV Cabinet (Doors)", category: "decoration",
    modelPath: "assets/kenney/cabinetTelevisionDoors.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 130, style: 3, ratingBonus: 0.02,
    tier: 2, surfaceSlots: [{ dx: 0, dz: 0 }] },
  { id: "radio",          name: "Radio",           category: "decoration",
    modelPath: "assets/kenney/radio.glb", scale: S_DECOR * 0.7, size: { width: 1, depth: 1 }, cost: 50, style: 2, ratingBonus: 0.01,
    tier: 2, placement: "surface" },
  { id: "speaker",        name: "Speaker",         category: "decoration",
    modelPath: "assets/kenney/speaker.glb", scale: S_DECOR * 0.6, size: { width: 1, depth: 1 }, cost: 70, style: 3, attractionBonus: 1, ratingBonus: 0.01,
    tier: 2, targetHeight: 1.0 },
  { id: "speaker-small",  name: "Small Speaker",   category: "decoration",
    modelPath: "assets/kenney/speakerSmall.glb", scale: S_DECOR * 0.5, size: { width: 1, depth: 1 }, cost: 28, style: 1,
    tier: 1, placement: "surface" },
  { id: "laptop",         name: "Laptop",          category: "decoration",
    modelPath: "assets/kenney/laptop.glb", scale: S_DECOR * 0.6, size: { width: 1, depth: 1 }, cost: 70, style: 2, ratingBonus: 0.01,
    tier: 2, placement: "surface" },

  // === More soft furnishings (rugs). ===
  // Same flat-height override as the other rugs above. 1×1 footprint
  // so they snap to a tile centre; scale > 1 lets them visually
  // overhang into neighbouring tiles.
  { id: "rug-doormat",    name: "Doormat",         category: "decoration",
    modelPath: "assets/kenney/rugDoormat.glb", scale: 1.0, size: { width: 1, depth: 1 }, cost: 18, style: 1,
    tier: 1, targetHeight: 0.04, flat: true },
  { id: "rug-rounded",    name: "Rounded Rug",     category: "decoration",
    modelPath: "assets/kenney/rugRounded.glb", scale: 1.6, size: { width: 1, depth: 1 }, cost: 45, style: 3, comfort: 1, ratingBonus: 0.01,
    tier: 2, targetHeight: 0.04, flat: true },
  // Square rug: scale 1.4 → ~2 tile area, covers the center tile fully
  // plus a strip of each neighbour.
  { id: "rug-square",     name: "Square Rug",      category: "decoration",
    modelPath: "assets/kenney/rugSquare.glb", scale: 1.4, size: { width: 1, depth: 1 }, cost: 70, style: 3, comfort: 1, attractionBonus: 1, ratingBonus: 0.02,
    tier: 2, targetHeight: 0.04, flat: true },

  // === Cute/quirky decor. ===
  // Kenney bear.glb's face sits on the +Z side of the mesh; without the
  // π flip the wall-mount rotation aimed the back of the bear at the
  // room. Same fix the coat rack + mirror needed.
  { id: "teddy-bear",     name: "Teddy Bear",      category: "decoration",
    modelPath: "assets/kenney/bear.glb", scale: S_DECOR * 0.7, size: { width: 1, depth: 1 }, cost: 22, attractionBonus: 1, style: 2,
    tier: 1, placement: "wall", rotationOffset: Math.PI },
  // Kenney's coatRack.glb has its hooks on the +Z face. Our wall-mount
  // convention is "GLB front = -Z", so without an explicit flip the
  // hooks end up jammed into the wall instead of facing the room.
  // rotationOffset spins it 180° in the model's own frame, so external
  // wall-rotation stacks on top correctly for any wall orientation.
  { id: "coat-rack-wall", name: "Wall Coat Rack",  category: "decoration",
    modelPath: "assets/kenney/coatRack.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 16, style: 1,
    tier: 1, placement: "wall", rotationOffset: Math.PI },

  // === Procedural fancy decor — inspired by polished restaurant sims. ===
  { id: "fountain",       name: "Indoor Fountain", category: "decoration",
    modelPath: "proc:fountain", scale: S_PROC, size: { width: 2, depth: 2 }, cost: 550, style: 6, attractionBonus: 6, ratingBonus: 0.06,
    tier: 4 },
  { id: "aquarium",       name: "Aquarium",        category: "decoration",
    modelPath: "proc:aquarium", scale: S_PROC, size: { width: 2, depth: 1 }, cost: 450, style: 5, attractionBonus: 5, ratingBonus: 0.05,
    tier: 4 },
  { id: "planter-box",    name: "Planter Box",     category: "plant",
    modelPath: "proc:planter-box", scale: S_PROC, size: { width: 2, depth: 1 }, cost: 80, style: 2, attractionBonus: 4, ratingBonus: 0.02,
    tier: 2 },
  { id: "hanging-plant",  name: "Hanging Plant",   category: "plant",
    modelPath: "proc:hanging-plant", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 50, style: 2, attractionBonus: 2, ratingBonus: 0.01,
    tier: 2, placement: "ceiling" },
  { id: "dessert-display", name: "Dessert Case",   category: "decoration",
    modelPath: "proc:dessert-display", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 250, style: 4, attractionBonus: 4, ratingBonus: 0.04,
    tier: 3 },
];

export function getFurnitureDef(id: string): FurnitureDef | undefined {
  return furnitureCatalog.find((f) => f.id === id);
}

/** Group a furniture item into one of the 5 quality tiers (1 = basic,
 * 5 = luxury) for display in the build menu's tier tabs. Prefers the
 * def's hand-curated `tier` field when present — that's the explicit
 * "where this piece belongs" signal we set as we audit each category.
 * Falls back to a cost+ratingBonus heuristic for anything not stamped
 * yet, so newly-added defs still land somewhere reasonable without a
 * manual pass. */
export function inferQualityTier(def: FurnitureDef): 1 | 2 | 3 | 4 | 5 {
  if (def.tier) return def.tier;
  // Strong "luxury" signal: explicit rating bonus pieces always land
  // in the prestige tiers regardless of price.
  if ((def.ratingBonus ?? 0) >= 0.06) return 5;
  if ((def.ratingBonus ?? 0) > 0)     return 4;
  // Otherwise fall back to a cost ladder. Thresholds are tuned so the
  // cheapest functional stove ($240) lands in T3 rather than getting
  // pushed up just because cooking gear costs more than dining gear.
  const cost = def.cost;
  if (cost <  50) return 1;
  if (cost < 150) return 2;
  if (cost < 300) return 3;
  if (cost < 500) return 4;
  return 5;
}

// ============================================================================
//                              TIER PRICE SCALER
// ============================================================================
// `def.cost` in the catalog is the BASE price (what a T1 version of the item
// would cost). The build-menu purchase + refund flows multiply that by a tier
// curve so higher-tier gear costs meaningfully more — without this, the late
// game offers $3,000 T5 fridges that a mid-game restaurant can afford with a
// single busy day.
//
// Variant A1 (user pick): cost × tier^1.2. T5 ≈ ×6.9.
//
// Snapped UP to the nearest $10 so the displayed price reads cleanly. T1
// items skip both the multiplier and the rounding so chairs stay at $18 etc.
// instead of getting bumped to $20 by ceiling rounding.
// ============================================================================

const TIER_PRICE_EXPONENT = 1.2;

export function scaledCost(def: FurnitureDef): number {
  const tier = inferQualityTier(def);
  if (tier <= 1) return def.cost;
  const raw = def.cost * Math.pow(tier, TIER_PRICE_EXPONENT);
  return Math.ceil(raw / 10) * 10;
}
