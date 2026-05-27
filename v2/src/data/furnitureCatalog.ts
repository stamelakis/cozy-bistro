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
  { id: "small-table", name: "Small Table", category: "table",
    modelPath: "assets/kenney/cabinetBedDrawerTable.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 24 },

  // Chairs
  { id: "wooden-chair", name: "Wooden Chair", category: "chair",
    modelPath: "assets/kenney/chair.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 16 },
  { id: "cushion-chair", name: "Cushion Chair", category: "chair",
    modelPath: "assets/kenney/chairCushion.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 22 },
  { id: "modern-chair", name: "Modern Chair", category: "chair",
    modelPath: "assets/kenney/chairModernCushion.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 32 },

  // Kitchen line
  { id: "stove", name: "Stove", category: "stove",
    modelPath: "assets/kenney/kitchenStove.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 240 },
  { id: "sink", name: "Sink", category: "stove",
    modelPath: "assets/kenney/kitchenSink.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 180 },
  { id: "microwave", name: "Microwave", category: "counter",
    modelPath: "assets/kenney/kitchenMicrowave.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 80 },
  { id: "fridge", name: "Fridge", category: "counter",
    modelPath: "assets/kenney/kitchenFridge.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 360 },
  { id: "counter", name: "Counter", category: "counter",
    modelPath: "assets/kenney/kitchenCabinet.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 90 },

  // Decor
  { id: "plant-small", name: "Small Plant", category: "plant",
    modelPath: "assets/kenney/plantSmall1.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 12 },
  { id: "plant-medium", name: "Medium Plant", category: "plant",
    modelPath: "assets/kenney/plantSmall2.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 18 },
  { id: "floor-lamp", name: "Floor Lamp", category: "lamp",
    modelPath: "assets/kenney/lampRoundFloor.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 28 },
  { id: "ceiling-lamp", name: "Ceiling Lamp", category: "lamp",
    modelPath: "assets/kenney/lampSquareCeiling.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 22 },

  // Doors
  { id: "door", name: "Doorway", category: "door",
    modelPath: "assets/kenney/doorway.glb", scale: 1, size: { width: 1, depth: 1 }, cost: 60 },
];

export function getFurnitureDef(id: string): FurnitureDef | undefined {
  return furnitureCatalog.find((f) => f.id === id);
}
