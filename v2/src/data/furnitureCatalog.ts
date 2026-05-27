/**
 * Maps logical furniture IDs (matching the 2D game's furniture.ts ids where
 * possible) to Kenney GLB model paths. Lets the WorldBuilder swap from
 * placeholder cubes to real 3D models without touching scene code.
 *
 * Models live under v2/public/assets/kenney/ (Vite serves them at
 * /assets/kenney/<file>.glb at runtime).
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
}

export const furnitureCatalog: readonly FurnitureDef[] = [
  // Tables
  { id: "small-table",  name: "Small Table",  category: "table",
    modelPath: "assets/kenney/cabinetBedDrawerTable.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 24 },
  { id: "round-table",  name: "Round Table",  category: "table",
    modelPath: "assets/kenney/tableRound.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 32 },
  { id: "dining-table", name: "Dining Table", category: "table",
    modelPath: "assets/kenney/table.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 48 },
  { id: "fancy-table",  name: "Linen Table",  category: "table",
    modelPath: "assets/kenney/tableCrossCloth.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 64 },
  { id: "coffee-table", name: "Coffee Table", category: "table",
    modelPath: "assets/kenney/tableCoffee.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 28 },

  // Chairs
  { id: "wooden-chair",   name: "Wooden Chair",  category: "chair",
    modelPath: "assets/kenney/chair.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 16 },
  { id: "cushion-chair",  name: "Cushion Chair", category: "chair",
    modelPath: "assets/kenney/chairCushion.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 22 },
  { id: "modern-chair",   name: "Modern Chair",  category: "chair",
    modelPath: "assets/kenney/chairModernCushion.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 32 },
  { id: "rounded-chair",  name: "Rounded Chair", category: "chair",
    modelPath: "assets/kenney/chairRounded.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 28 },
  { id: "bar-stool",      name: "Bar Stool",     category: "chair",
    modelPath: "assets/kenney/stoolBar.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 20 },
  { id: "lounge-chair",   name: "Lounge Chair",  category: "chair",
    modelPath: "assets/kenney/loungeChair.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 56 },
  { id: "bench-cushion",  name: "Cushion Bench", category: "chair",
    modelPath: "assets/kenney/benchCushion.glb", scale: 1, size: { width: 2, depth: 1 }, cost: 64 },

  // Kitchen line
  { id: "stove",          name: "Gas Stove",       category: "stove",
    modelPath: "assets/kenney/kitchenStove.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 240 },
  { id: "stove-electric", name: "Electric Stove",  category: "stove",
    modelPath: "assets/kenney/kitchenStoveElectric.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 320 },
  { id: "sink",           name: "Sink",            category: "stove",
    modelPath: "assets/kenney/kitchenSink.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 180 },
  { id: "microwave",      name: "Microwave",       category: "counter",
    modelPath: "assets/kenney/kitchenMicrowave.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 80 },
  { id: "fridge",         name: "Fridge",          category: "counter",
    modelPath: "assets/kenney/kitchenFridge.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 360 },
  { id: "fridge-large",   name: "Walk-in Fridge",  category: "counter",
    modelPath: "assets/kenney/kitchenFridgeLarge.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 540 },
  { id: "counter",        name: "Counter",         category: "counter",
    modelPath: "assets/kenney/kitchenCabinet.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 90 },
  { id: "coffee-machine", name: "Coffee Machine",  category: "counter",
    modelPath: "assets/kenney/kitchenCoffeeMachine.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 140 },
  { id: "blender",        name: "Blender",         category: "counter",
    modelPath: "assets/kenney/kitchenBlender.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 60 },
  { id: "toaster",        name: "Toaster",         category: "counter",
    modelPath: "assets/kenney/toaster.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 35 },
  { id: "kitchen-hood",   name: "Range Hood",      category: "decoration",
    modelPath: "assets/kenney/hoodModern.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 110 },

  // Decor & plants
  { id: "plant-small",    name: "Small Plant",     category: "plant",
    modelPath: "assets/kenney/plantSmall1.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 12 },
  { id: "plant-medium",   name: "Medium Plant",    category: "plant",
    modelPath: "assets/kenney/plantSmall2.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 18 },
  { id: "plant-tall",     name: "Tall Plant",      category: "plant",
    modelPath: "assets/kenney/plantSmall3.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 24 },
  { id: "potted-plant",   name: "Potted Plant",    category: "plant",
    modelPath: "assets/kenney/pottedPlant.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 30 },
  { id: "bookcase",       name: "Bookcase",        category: "decoration",
    modelPath: "assets/kenney/bookcaseClosedDoors.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 75 },
  { id: "bookcase-open",  name: "Open Bookcase",   category: "decoration",
    modelPath: "assets/kenney/bookcaseOpen.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 55 },
  { id: "coat-rack",      name: "Coat Rack",       category: "decoration",
    modelPath: "assets/kenney/coatRackStanding.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 22 },
  { id: "rug-rectangle",  name: "Rectangular Rug", category: "decoration",
    modelPath: "assets/kenney/rugRectangle.glb", scale: 1, size: { width: 2, depth: 1 }, cost: 35 },
  { id: "rug-round",      name: "Round Rug",       category: "decoration",
    modelPath: "assets/kenney/rugRound.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 28 },

  // Lighting
  { id: "floor-lamp",     name: "Round Floor Lamp",  category: "lamp",
    modelPath: "assets/kenney/lampRoundFloor.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 28 },
  { id: "floor-lamp-sq",  name: "Square Floor Lamp", category: "lamp",
    modelPath: "assets/kenney/lampSquareFloor.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 30 },
  { id: "ceiling-lamp",   name: "Ceiling Lamp",      category: "lamp",
    modelPath: "assets/kenney/lampSquareCeiling.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 22 },
  { id: "table-lamp",     name: "Table Lamp",        category: "lamp",
    modelPath: "assets/kenney/lampSquareTable.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 18 },
  { id: "wall-lamp",      name: "Wall Sconce",       category: "lamp",
    modelPath: "assets/kenney/lampWall.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 20 },

  // Doors
  { id: "door",      name: "Doorway",       category: "door",
    modelPath: "assets/kenney/doorway.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 60 },
  { id: "door-open", name: "Open Doorway",  category: "door",
    modelPath: "assets/kenney/doorwayOpen.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 70 },
  { id: "door-front", name: "Front Door",   category: "door",
    modelPath: "assets/kenney/doorwayFront.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 90 },
];

export function getFurnitureDef(id: string): FurnitureDef | undefined {
  return furnitureCatalog.find((f) => f.id === id);
}
