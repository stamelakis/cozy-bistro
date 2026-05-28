/**
 * Maps logical furniture IDs (matching the 2D game's furniture.ts ids where
 * possible) to Kenney GLB model paths. Lets the WorldBuilder swap from
 * placeholder cubes to real 3D models without touching scene code.
 *
 * Models live under v2/public/assets/kenney/ (Vite serves them at
 * /assets/kenney/<file>.glb at runtime).
 *
 * Scales are tuned per-category to match characters (which render at scale 1.7):
 *   tables  ≈ 1.9  (so a 4-top fills a cell + reads as dining height)
 *   chairs  ≈ 1.7  (so seat-back rises to character chest)
 *   stove / counter ≈ 1.6
 *   plants / decor / lamps ≈ 1.3
 *   procedurally-built items already self-scale (kept at 1.0).
 */

export interface FurnitureDef {
  /** Stable id, matches the 2D furniture.ts id when possible. */
  id: string;
  /** Human label for the build menu. */
  name: string;
  /** Game category (mirrors 2D categories). */
  category: "table" | "chair" | "stove" | "counter" | "decoration" | "plant" | "lamp" | "door";
  /** Relative path under v2/public — fed to ModelLoader.load(). */
  modelPath: string;
  /** Uniform scale applied to the loaded model. */
  scale: number;
  /** Footprint in grid cells. */
  size: { width: number; depth: number };
  /** Cost in coins. */
  cost: number;
  /** Optional rotation offset (radians) if the model points the wrong way. */
  rotationOffset?: number;

  // === Gameplay stats (Game.getFurnitureBonuses sums these across all placed) ===
  style?: number;
  comfort?: number;
  attractionBonus?: number;
  ratingBonus?: number;
  seatingCapacity?: number;
}

// Per-category scale defaults. Use these constants when authoring entries.
const S_TABLE = 1.9;
const S_CHAIR = 1.7;
const S_KITCHEN = 1.6;
const S_DECOR = 1.3;
const S_PLANT = 1.3;
const S_LAMP = 1.3;
const S_DOOR = 1.6;
const S_PROC = 1.0;

export const furnitureCatalog: readonly FurnitureDef[] = [
  // Tables (small-table now uses the proper dining table mesh — the old
  // cabinetBedDrawerTable was a bedside drawer, not a dining piece).
  { id: "small-table",   name: "Small Table",   category: "table",
    modelPath: "assets/kenney/table.glb", scale: S_TABLE, size: { width: 1, depth: 1 }, cost: 24, style: 1 },
  { id: "round-table",   name: "Round Table",   category: "table",
    modelPath: "assets/kenney/tableRound.glb", scale: S_TABLE, size: { width: 1, depth: 1 }, cost: 32, style: 2 },
  { id: "dining-table",  name: "Dining Table",  category: "table",
    modelPath: "assets/kenney/tableCross.glb", scale: S_TABLE, size: { width: 1, depth: 1 }, cost: 48, style: 3 },
  { id: "fancy-table",   name: "Linen Table",   category: "table",
    modelPath: "assets/kenney/tableCrossCloth.glb", scale: S_TABLE, size: { width: 1, depth: 1 }, cost: 64, style: 5, ratingBonus: 0.05 },
  { id: "cloth-table",   name: "Tablecloth Top", category: "table",
    modelPath: "assets/kenney/tableCloth.glb", scale: S_TABLE, size: { width: 1, depth: 1 }, cost: 40, style: 4 },
  { id: "glass-table",   name: "Glass Table",   category: "table",
    modelPath: "assets/kenney/tableGlass.glb", scale: S_TABLE, size: { width: 1, depth: 1 }, cost: 56, style: 4, ratingBonus: 0.04 },
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
];

export function getFurnitureDef(id: string): FurnitureDef | undefined {
  return furnitureCatalog.find((f) => f.id === id);
}
