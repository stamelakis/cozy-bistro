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
  category: "table" | "chair" | "stove" | "counter" | "decoration" | "plant" | "lamp" | "door" | "bathroom" | "wall";
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
   * Edge items use a separate snap path in BuildMenu. */
  placement?: "tile" | "edge";
  /** Optional realistic world-space height (in units ≈ metres). When set,
   * fitFurniture independently stretches Y so the placed item lands at
   * this height regardless of the raw mesh's proportions. Without it
   * Kenney chairs look stubby and Kenney tables look like coffee tables
   * because their XZ-fit uniform scale leaves them too short. */
  targetHeight?: number;
  /** Tables: the sitting positions around this table. Chairs placed at one
   * of these become functional seats for the dining loop. */
  seatSlots?: readonly SeatSlot[];

  // === Gameplay stats (Game.getFurnitureBonuses sums these across all placed) ===
  style?: number;
  comfort?: number;
  attractionBonus?: number;
  ratingBonus?: number;
  seatingCapacity?: number;
}

/** Default 4-side seat slot pattern for a 2×2 dining table that seats 4.
 *
 * The table anchor is at the cross-section of 4 cells (half-integer
 * coords in world space). Each chair sits in one of the 4 adjacent
 * cells; offsets are tuned so chair-center → cell-center under the
 * half-integer anchor (e.g. dx=-1.5 from anchor 0.5 → chair at -1, a
 * cell center). The layout is intentionally asymmetric (one chair per
 * side, all rotated 90° from the next) — that way every chair lands
 * on a real tile center instead of sitting at a tile border. Looks
 * like a normal 4-top and respects the per-tile grid the player sees.
 *
 * Plate offsets sit ~half-way between the chair and the table center
 * (closer to the chair) so served food reads as belonging to that
 * seat. The plate's WORLD Y comes from the placed table's bounding
 * box at runtime (FurnitureRegistry.getPlateHeightFor or similar), so
 * different table meshes can have different top heights without the
 * plate floating. */
const STANDARD_TABLE_SEAT_SLOTS: readonly SeatSlot[] = [
  // Top chair: cell at table_anchor + (-0.5, -1.5). Faces +Z.
  { dx: -0.5, dz: -1.5, facingY:  Math.PI,     platePos: { dx: -0.3, dz: -0.7 } },
  // Right chair: cell at (+1.5, -0.5). Faces -X.
  { dx:  1.5, dz: -0.5, facingY: -Math.PI / 2, platePos: { dx:  0.7, dz: -0.3 } },
  // Bottom chair: cell at (+0.5, +1.5). Faces -Z (facingY=0 baseline).
  { dx:  0.5, dz:  1.5, facingY:  0,           platePos: { dx:  0.3, dz:  0.7 } },
  // Left chair: cell at (-1.5, +0.5). Faces +X.
  { dx: -1.5, dz:  0.5, facingY:  Math.PI / 2, platePos: { dx: -0.7, dz:  0.3 } },
];

// Per-category fill ratios. See "SCALE SEMANTICS" in the file header —
// these are NOT raw mesh multipliers anymore, they're "how much of the
// assigned tile this category should visually occupy".
const S_TABLE = 1.0;   // dining tables fill their tile
const S_CHAIR = 0.7;   // chair smaller than tile so it can sit beside a table without overlap
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
  { id: "small-table",   name: "Small Table",   category: "table",
    modelPath: "assets/kenney/table.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 24, style: 1,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS },
  { id: "round-table",   name: "Round Table",   category: "table",
    modelPath: "assets/kenney/tableRound.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 32, style: 2,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS },
  { id: "dining-table",  name: "Dining Table",  category: "table",
    modelPath: "assets/kenney/tableCross.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 48, style: 3,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS },
  { id: "fancy-table",   name: "Linen Table",   category: "table",
    modelPath: "assets/kenney/tableCrossCloth.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 64, style: 5, ratingBonus: 0.05,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS },
  { id: "cloth-table",   name: "Tablecloth Top", category: "table",
    modelPath: "assets/kenney/tableCloth.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 40, style: 4,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS },
  { id: "glass-table",   name: "Glass Table",   category: "table",
    modelPath: "assets/kenney/tableGlass.glb", scale: S_TABLE, size: { width: 2, depth: 2 }, cost: 56, style: 4, ratingBonus: 0.04,
    targetHeight: H_TABLE, seatSlots: STANDARD_TABLE_SEAT_SLOTS },
  // Coffee tables are non-dining; intentionally no seatSlots — chairs near
  // them are always "yellow" overflow seating.
  { id: "coffee-table",  name: "Coffee Table",  category: "table",
    modelPath: "assets/kenney/tableCoffee.glb", scale: S_TABLE * 0.85, size: { width: 1, depth: 1 }, cost: 28, style: 2 },
  { id: "coffee-glass",  name: "Glass Coffee Table", category: "table",
    modelPath: "assets/kenney/tableCoffeeGlass.glb", scale: S_TABLE * 0.85, size: { width: 1, depth: 1 }, cost: 38, style: 3 },

  // Chairs
  { id: "wooden-chair",   name: "Wooden Chair",  category: "chair",
    modelPath: "assets/kenney/chair.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 16, comfort: 1, style: 1 },
  { id: "cushion-chair",  name: "Cushion Chair", category: "chair",
    modelPath: "assets/kenney/chairCushion.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 22, comfort: 2, style: 2 },
  { id: "modern-chair",   name: "Modern Chair",  category: "chair",
    modelPath: "assets/kenney/chairModernCushion.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 32, comfort: 3, style: 3 },
  { id: "rounded-chair",  name: "Rounded Chair", category: "chair",
    modelPath: "assets/kenney/chairRounded.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 28, comfort: 3, style: 2 },
  { id: "bar-stool",      name: "Bar Stool",     category: "chair",
    modelPath: "assets/kenney/stoolBar.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 20, comfort: 1, style: 1 },
  { id: "lounge-chair",   name: "Lounge Chair",  category: "chair",
    modelPath: "assets/kenney/loungeChair.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 56, comfort: 4, style: 3 },
  { id: "bench-cushion",  name: "Cushion Bench", category: "chair",
    modelPath: "assets/kenney/benchCushion.glb", scale: S_CHAIR, size: { width: 2, depth: 1 }, cost: 64, comfort: 3, style: 2, seatingCapacity: 2 },
  { id: "bench-cushion-low", name: "Low Cushion Bench", category: "chair",
    modelPath: "assets/kenney/benchCushionLow.glb", scale: S_CHAIR, size: { width: 2, depth: 1 }, cost: 48, comfort: 2, style: 2, seatingCapacity: 2 },
  { id: "bench-plain",    name: "Wooden Bench",  category: "chair",
    modelPath: "assets/kenney/bench.glb", scale: S_CHAIR, size: { width: 2, depth: 1 }, cost: 40, comfort: 1, style: 1, seatingCapacity: 2 },
  { id: "bar-stool-sq",   name: "Square Bar Stool", category: "chair",
    modelPath: "assets/kenney/stoolBarSquare.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 22, comfort: 1, style: 2 },
  { id: "lounge-relax",   name: "Relax Lounge",  category: "chair",
    modelPath: "assets/kenney/loungeChairRelax.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 72, comfort: 5, style: 4 },
  { id: "lounge-design",  name: "Designer Lounge", category: "chair",
    modelPath: "assets/kenney/loungeDesignChair.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 88, comfort: 4, style: 5, ratingBonus: 0.05 },
  { id: "sofa",           name: "Sofa",          category: "chair",
    modelPath: "assets/kenney/loungeSofa.glb", scale: S_CHAIR, size: { width: 2, depth: 1 }, cost: 120, comfort: 5, style: 3, seatingCapacity: 2 },
  { id: "sofa-long",      name: "Long Sofa",     category: "chair",
    modelPath: "assets/kenney/loungeSofaLong.glb", scale: S_CHAIR, size: { width: 3, depth: 1 }, cost: 170, comfort: 5, style: 3, seatingCapacity: 3 },
  { id: "sofa-corner",    name: "Corner Sofa",   category: "chair",
    modelPath: "assets/kenney/loungeSofaCorner.glb", scale: S_CHAIR, size: { width: 2, depth: 2 }, cost: 200, comfort: 6, style: 4, seatingCapacity: 3 },
  { id: "sofa-design",    name: "Designer Sofa", category: "chair",
    modelPath: "assets/kenney/loungeDesignSofa.glb", scale: S_CHAIR, size: { width: 2, depth: 1 }, cost: 240, comfort: 5, style: 6, ratingBonus: 0.08, seatingCapacity: 2 },

  // Kitchen / cooking
  { id: "stove",          name: "Gas Stove",       category: "stove",
    modelPath: "assets/kenney/kitchenStove.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 240 },
  { id: "stove-electric", name: "Electric Stove",  category: "stove",
    modelPath: "assets/kenney/kitchenStoveElectric.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 320 },
  { id: "sink",           name: "Sink",            category: "stove",
    modelPath: "assets/kenney/kitchenSink.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 180 },
  { id: "dishwasher",     name: "Dishwasher",      category: "stove",
    modelPath: "proc:dishwasher", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 320 },
  { id: "dishwasher-pro", name: "Pro Dishwasher Line", category: "stove",
    modelPath: "proc:dishwasher-pro", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 540 },
  { id: "microwave",      name: "Microwave",       category: "counter",
    modelPath: "assets/kenney/kitchenMicrowave.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 80 },
  { id: "fridge",         name: "Fridge",          category: "counter",
    modelPath: "assets/kenney/kitchenFridge.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 360 },
  { id: "fridge-large",   name: "Walk-in Fridge",  category: "counter",
    modelPath: "assets/kenney/kitchenFridgeLarge.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 540 },
  { id: "counter",        name: "Counter",         category: "counter",
    modelPath: "assets/kenney/kitchenCabinet.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 90 },
  { id: "coffee-machine", name: "Coffee Machine",  category: "counter",
    modelPath: "assets/kenney/kitchenCoffeeMachine.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 140 },
  { id: "blender",        name: "Blender",         category: "counter",
    modelPath: "assets/kenney/kitchenBlender.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 60 },
  { id: "toaster",        name: "Toaster",         category: "counter",
    modelPath: "assets/kenney/toaster.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 35 },
  { id: "kitchen-hood",   name: "Range Hood",      category: "decoration",
    modelPath: "assets/kenney/hoodModern.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 110 },
  { id: "kitchen-hood-l", name: "Large Range Hood", category: "decoration",
    modelPath: "assets/kenney/hoodLarge.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 160 },
  { id: "bar-counter",    name: "Bar Counter",     category: "counter",
    modelPath: "assets/kenney/kitchenBar.glb", scale: S_KITCHEN, size: { width: 2, depth: 1 }, cost: 220 },
  { id: "bar-end",        name: "Bar End",         category: "counter",
    modelPath: "assets/kenney/kitchenBarEnd.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 120 },
  { id: "fridge-built-in", name: "Built-in Fridge", category: "counter",
    modelPath: "assets/kenney/kitchenFridgeBuiltIn.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 380 },
  { id: "fridge-small",   name: "Mini Fridge",     category: "counter",
    modelPath: "assets/kenney/kitchenFridgeSmall.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 180 },
  { id: "counter-drawer", name: "Drawer Counter",  category: "counter",
    modelPath: "assets/kenney/kitchenCabinetDrawer.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 110 },

  // Decor
  { id: "cardboard-box",  name: "Supply Crate",    category: "decoration",
    modelPath: "assets/kenney/cardboardBoxClosed.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 8 },
  { id: "cardboard-open", name: "Open Crate",      category: "decoration",
    modelPath: "assets/kenney/cardboardBoxOpen.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 10 },
  { id: "books",          name: "Stack of Books",  category: "decoration",
    modelPath: "assets/kenney/books.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 6 },
  { id: "side-table",     name: "Side Table",      category: "decoration",
    modelPath: "assets/kenney/sideTable.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 32 },
  { id: "side-table-d",   name: "Side Table w/ Drawer", category: "decoration",
    modelPath: "assets/kenney/sideTableDrawers.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 42 },
  { id: "ceiling-fan",    name: "Ceiling Fan",     category: "decoration",
    modelPath: "assets/kenney/ceilingFan.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 65 },
  { id: "trashcan",       name: "Trash Can",       category: "decoration",
    modelPath: "assets/kenney/trashcan.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 14 },
  { id: "pillow",         name: "Cushion",         category: "decoration",
    modelPath: "assets/kenney/pillow.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 8 },
  { id: "pillow-blue",    name: "Blue Cushion",    category: "decoration",
    modelPath: "assets/kenney/pillowBlue.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 10 },

  // Wall art / signage (procedural, no GLB)
  { id: "framed-art-warm", name: "Framed Art (Warm)", category: "decoration",
    modelPath: "proc:framed-art-warm", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 45, style: 4, attractionBonus: 2 },
  { id: "framed-art-cool", name: "Framed Art (Cool)", category: "decoration",
    modelPath: "proc:framed-art-cool", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 45, style: 4, attractionBonus: 2 },
  { id: "framed-art-mint", name: "Framed Art (Mint)", category: "decoration",
    modelPath: "proc:framed-art-mint", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 45, style: 4, attractionBonus: 2 },
  { id: "menu-board",      name: "Chalk Menu Board",  category: "decoration",
    modelPath: "proc:menu-board", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 60, style: 3, attractionBonus: 3 },
  { id: "neon-sign",       name: "Neon OPEN Sign",    category: "decoration",
    modelPath: "proc:neon-sign", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 85, style: 4, attractionBonus: 6 },
  { id: "wine-wall",       name: "Wine Wall",         category: "decoration",
    modelPath: "proc:wine-wall", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 140, style: 6, ratingBonus: 0.06, attractionBonus: 3 },

  // Plants
  { id: "plant-small",    name: "Small Plant",     category: "plant",
    modelPath: "assets/kenney/plantSmall1.glb", scale: S_PLANT, size: { width: 1, depth: 1 }, cost: 12, attractionBonus: 1, style: 1 },
  { id: "plant-medium",   name: "Medium Plant",    category: "plant",
    modelPath: "assets/kenney/plantSmall2.glb", scale: S_PLANT, size: { width: 1, depth: 1 }, cost: 18, attractionBonus: 2, style: 1 },
  { id: "plant-tall",     name: "Tall Plant",      category: "plant",
    modelPath: "assets/kenney/plantSmall3.glb", scale: S_PLANT, size: { width: 1, depth: 1 }, cost: 24, attractionBonus: 2, style: 2 },
  { id: "potted-plant",   name: "Potted Plant",    category: "plant",
    modelPath: "assets/kenney/pottedPlant.glb", scale: S_PLANT, size: { width: 1, depth: 1 }, cost: 30, attractionBonus: 3, style: 2 },
  { id: "bookcase",       name: "Bookcase",        category: "decoration",
    modelPath: "assets/kenney/bookcaseClosedDoors.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 75, style: 4, attractionBonus: 2 },
  { id: "bookcase-open",  name: "Open Bookcase",   category: "decoration",
    modelPath: "assets/kenney/bookcaseOpen.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 55, style: 3, attractionBonus: 2 },
  { id: "coat-rack",      name: "Coat Rack",       category: "decoration",
    modelPath: "assets/kenney/coatRackStanding.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 22, style: 1 },
  { id: "rug-rectangle",  name: "Rectangular Rug", category: "decoration",
    modelPath: "assets/kenney/rugRectangle.glb", scale: S_DECOR, size: { width: 2, depth: 1 }, cost: 35, style: 3, comfort: 1 },
  { id: "rug-round",      name: "Round Rug",       category: "decoration",
    modelPath: "assets/kenney/rugRound.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 28, style: 2, comfort: 1 },

  // Lighting
  { id: "floor-lamp",     name: "Round Floor Lamp",  category: "lamp",
    modelPath: "assets/kenney/lampRoundFloor.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 28, style: 2, attractionBonus: 1 },
  { id: "floor-lamp-sq",  name: "Square Floor Lamp", category: "lamp",
    modelPath: "assets/kenney/lampSquareFloor.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 30, style: 2, attractionBonus: 1 },
  { id: "ceiling-lamp",   name: "Ceiling Lamp",      category: "lamp",
    modelPath: "assets/kenney/lampSquareCeiling.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 22, style: 1, attractionBonus: 1 },
  { id: "table-lamp",     name: "Table Lamp",        category: "lamp",
    modelPath: "assets/kenney/lampSquareTable.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 18, style: 2 },
  { id: "wall-lamp",      name: "Wall Sconce",       category: "lamp",
    modelPath: "assets/kenney/lampWall.glb", scale: S_LAMP, size: { width: 1, depth: 1 }, cost: 20, style: 2, attractionBonus: 1 },

  // Doors & windows. The "door" id is a procedural door with a separate
  // hinged panel so we can swing the panel without moving the frame.
  { id: "door",         name: "Front Door",    category: "door",
    modelPath: "proc:front-door", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 60 },
  { id: "door-kenney",  name: "Kenney Doorway", category: "door",
    modelPath: "assets/kenney/doorway.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 60 },
  { id: "door-open",    name: "Open Doorway",  category: "door",
    modelPath: "assets/kenney/doorwayOpen.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 70 },
  { id: "door-front",   name: "Front Door",    category: "door",
    modelPath: "assets/kenney/doorwayFront.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 90 },
  { id: "wall-doorway", name: "Wall Doorway",  category: "door",
    modelPath: "assets/kenney/wallDoorway.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 110 },
  { id: "wall-doorway-w", name: "Wide Doorway", category: "door",
    modelPath: "assets/kenney/wallDoorwayWide.glb", scale: S_DOOR, size: { width: 2, depth: 1 }, cost: 140 },
  { id: "window",       name: "Window",        category: "decoration",
    modelPath: "assets/kenney/wallWindow.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 75 },
  { id: "window-slide", name: "Sliding Window", category: "decoration",
    modelPath: "assets/kenney/wallWindowSlide.glb", scale: S_DOOR, size: { width: 1, depth: 1 }, cost: 95 },

  // === Bathroom — needed for the toilet-use customer loop. ===
  // Toilets sit in a small partitioned room; sinks for handwashing.
  { id: "toilet",         name: "Toilet",          category: "bathroom",
    modelPath: "assets/kenney/toilet.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 140, style: 2 },
  { id: "toilet-square",  name: "Square Toilet",   category: "bathroom",
    modelPath: "assets/kenney/toiletSquare.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 160, style: 3 },
  { id: "bathroom-sink",  name: "Bathroom Sink",   category: "bathroom",
    modelPath: "assets/kenney/bathroomSink.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 120, style: 2 },
  { id: "bathroom-sink-sq", name: "Square Bath Sink", category: "bathroom",
    modelPath: "assets/kenney/bathroomSinkSquare.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 140, style: 3 },
  { id: "bathroom-mirror", name: "Bathroom Mirror", category: "bathroom",
    modelPath: "assets/kenney/bathroomMirror.glb", scale: 0.7, size: { width: 1, depth: 1 }, cost: 60, style: 2, attractionBonus: 1 },
  { id: "bathroom-cabinet", name: "Bath Cabinet",  category: "bathroom",
    modelPath: "assets/kenney/bathroomCabinet.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 110, style: 2 },
  { id: "bathroom-cabinet-d", name: "Bath Cabinet (Drawer)", category: "bathroom",
    modelPath: "assets/kenney/bathroomCabinetDrawer.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 130, style: 3 },
  { id: "bathtub",        name: "Bathtub",         category: "bathroom",
    modelPath: "assets/kenney/bathtub.glb", scale: 0.95, size: { width: 2, depth: 1 }, cost: 280, style: 4, attractionBonus: 3 },
  { id: "shower",         name: "Shower",          category: "bathroom",
    modelPath: "assets/kenney/shower.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 200, style: 3 },
  { id: "shower-round",   name: "Round Shower",    category: "bathroom",
    modelPath: "assets/kenney/showerRound.glb", scale: 0.85, size: { width: 1, depth: 1 }, cost: 240, style: 4, ratingBonus: 0.03 },

  // === Internal walls + doorways — edge-placed, don't claim tiles. ===
  // These snap to grid lines instead of tile centers so the player can
  // partition off rooms (bathroom, private dining, kitchen line, etc.)
  // without losing the floor area to wall thickness.
  { id: "int-wall",       name: "Wall Section",    category: "wall",
    modelPath: "proc:int-wall", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 18, placement: "edge" },
  { id: "int-wall-half",  name: "Half Wall",       category: "wall",
    modelPath: "proc:int-wall-half", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 14, placement: "edge", style: 1 },
  { id: "int-doorway",    name: "Internal Doorway", category: "wall",
    modelPath: "proc:int-doorway", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 36, placement: "edge", style: 2 },
  { id: "int-window",     name: "Interior Window", category: "wall",
    modelPath: "proc:int-window", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 28, placement: "edge", style: 2, attractionBonus: 1 },

  // === More tables: coffee variants for lounge corners. ===
  { id: "coffee-square",  name: "Square Coffee Table", category: "table",
    modelPath: "assets/kenney/tableCoffeeSquare.glb", scale: S_TABLE * 0.85, size: { width: 1, depth: 1 }, cost: 30, style: 2 },
  { id: "coffee-glass-sq", name: "Glass Square Coffee", category: "table",
    modelPath: "assets/kenney/tableCoffeeGlassSquare.glb", scale: S_TABLE * 0.85, size: { width: 1, depth: 1 }, cost: 42, style: 3 },

  // === More chairs / desks. ===
  { id: "chair-desk",     name: "Desk Chair",      category: "chair",
    modelPath: "assets/kenney/chairDesk.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 26, comfort: 2, style: 2 },
  { id: "chair-modern-fr", name: "Frame Chair",    category: "chair",
    modelPath: "assets/kenney/chairModernFrameCushion.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 36, comfort: 3, style: 3 },
  { id: "sofa-ottoman",   name: "Sofa Ottoman",    category: "chair",
    modelPath: "assets/kenney/loungeSofaOttoman.glb", scale: S_CHAIR, size: { width: 1, depth: 1 }, cost: 70, comfort: 4, style: 3 },
  { id: "sofa-design-c",  name: "Designer Corner Sofa", category: "chair",
    modelPath: "assets/kenney/loungeDesignSofaCorner.glb", scale: S_CHAIR, size: { width: 2, depth: 2 }, cost: 280, comfort: 6, style: 6, ratingBonus: 0.08, seatingCapacity: 4 },

  // === More kitchen cabinets + corner pieces. ===
  { id: "kitchen-upper",  name: "Upper Cabinet",   category: "counter",
    modelPath: "assets/kenney/kitchenCabinetUpper.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 70, style: 1 },
  { id: "kitchen-upper-d", name: "Upper Cabinet Double", category: "counter",
    modelPath: "assets/kenney/kitchenCabinetUpperDouble.glb", scale: S_KITCHEN, size: { width: 2, depth: 1 }, cost: 110, style: 1 },
  { id: "kitchen-upper-l", name: "Upper Cabinet Low", category: "counter",
    modelPath: "assets/kenney/kitchenCabinetUpperLow.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 60, style: 1 },
  { id: "kitchen-corner-i", name: "Inner Corner Cabinet", category: "counter",
    modelPath: "assets/kenney/kitchenCabinetCornerInner.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 95, style: 1 },
  { id: "kitchen-corner-r", name: "Round Corner Cabinet", category: "counter",
    modelPath: "assets/kenney/kitchenCabinetCornerRound.glb", scale: S_KITCHEN, size: { width: 1, depth: 1 }, cost: 110, style: 2 },

  // === Entertainment / TV / electronics. ===
  { id: "tv-modern",      name: "Modern TV",       category: "decoration",
    modelPath: "assets/kenney/televisionModern.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 180, style: 4, attractionBonus: 3 },
  { id: "tv-vintage",     name: "Vintage TV",      category: "decoration",
    modelPath: "assets/kenney/televisionVintage.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 120, style: 3, attractionBonus: 2 },
  { id: "tv-antenna",     name: "Antenna TV",      category: "decoration",
    modelPath: "assets/kenney/televisionAntenna.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 90, style: 2 },
  { id: "tv-cabinet",     name: "TV Cabinet",      category: "decoration",
    modelPath: "assets/kenney/cabinetTelevision.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 75, style: 2 },
  { id: "tv-cabinet-d",   name: "TV Cabinet (Doors)", category: "decoration",
    modelPath: "assets/kenney/cabinetTelevisionDoors.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 95, style: 3 },
  { id: "radio",          name: "Radio",           category: "decoration",
    modelPath: "assets/kenney/radio.glb", scale: S_DECOR * 0.7, size: { width: 1, depth: 1 }, cost: 45, style: 2 },
  { id: "speaker",        name: "Speaker",         category: "decoration",
    modelPath: "assets/kenney/speaker.glb", scale: S_DECOR * 0.6, size: { width: 1, depth: 1 }, cost: 55, style: 3, attractionBonus: 1 },
  { id: "speaker-small",  name: "Small Speaker",   category: "decoration",
    modelPath: "assets/kenney/speakerSmall.glb", scale: S_DECOR * 0.5, size: { width: 1, depth: 1 }, cost: 28, style: 1 },
  { id: "laptop",         name: "Laptop",          category: "decoration",
    modelPath: "assets/kenney/laptop.glb", scale: S_DECOR * 0.6, size: { width: 1, depth: 1 }, cost: 60, style: 2 },

  // === More soft furnishings (pillows + rugs). ===
  { id: "pillow-long",    name: "Long Pillow",     category: "decoration",
    modelPath: "assets/kenney/pillowLong.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 14 },
  { id: "pillow-blue-long", name: "Long Blue Pillow", category: "decoration",
    modelPath: "assets/kenney/pillowBlueLong.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 18 },
  { id: "rug-doormat",    name: "Doormat",         category: "decoration",
    modelPath: "assets/kenney/rugDoormat.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 18, style: 1 },
  { id: "rug-rounded",    name: "Rounded Rug",     category: "decoration",
    modelPath: "assets/kenney/rugRounded.glb", scale: S_DECOR, size: { width: 2, depth: 1 }, cost: 38, style: 3, comfort: 1 },
  { id: "rug-square",     name: "Square Rug",      category: "decoration",
    modelPath: "assets/kenney/rugSquare.glb", scale: S_DECOR, size: { width: 2, depth: 2 }, cost: 52, style: 3, comfort: 1, attractionBonus: 1 },

  // === Cute/quirky decor. ===
  { id: "teddy-bear",     name: "Teddy Bear",      category: "decoration",
    modelPath: "assets/kenney/bear.glb", scale: S_DECOR * 0.55, size: { width: 1, depth: 1 }, cost: 22, attractionBonus: 1, style: 2 },
  { id: "coat-rack-wall", name: "Wall Coat Rack",  category: "decoration",
    modelPath: "assets/kenney/coatRack.glb", scale: S_DECOR, size: { width: 1, depth: 1 }, cost: 16, style: 1 },

  // === Procedural fancy decor — inspired by polished restaurant sims. ===
  { id: "fountain",       name: "Indoor Fountain", category: "decoration",
    modelPath: "proc:fountain", scale: S_PROC, size: { width: 2, depth: 2 }, cost: 240, style: 6, attractionBonus: 6, ratingBonus: 0.05 },
  { id: "aquarium",       name: "Aquarium",        category: "decoration",
    modelPath: "proc:aquarium", scale: S_PROC, size: { width: 2, depth: 1 }, cost: 280, style: 5, attractionBonus: 5, ratingBonus: 0.04 },
  { id: "planter-box",    name: "Planter Box",     category: "plant",
    modelPath: "proc:planter-box", scale: S_PROC, size: { width: 2, depth: 1 }, cost: 60, style: 2, attractionBonus: 2 },
  { id: "hanging-plant",  name: "Hanging Plant",   category: "plant",
    modelPath: "proc:hanging-plant", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 35, style: 2, attractionBonus: 1 },
  { id: "dessert-display", name: "Dessert Case",   category: "decoration",
    modelPath: "proc:dessert-display", scale: S_PROC, size: { width: 1, depth: 1 }, cost: 180, style: 4, attractionBonus: 4, ratingBonus: 0.03 },
];

export function getFurnitureDef(id: string): FurnitureDef | undefined {
  return furnitureCatalog.find((f) => f.id === id);
}
