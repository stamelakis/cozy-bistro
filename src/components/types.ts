export type FurnitureCategory =
  | "table"
  | "chair"
  | "stove"
  | "counter"
  | "decoration"
  | "plant"
  | "wallDecoration";

export type FunctionalityType =
  | "seating"
  | "cooking"
  | "serving"
  | "decor"
  | "wall";

export interface GridPosition {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface FurnitureDefinition {
  id: string;
  name: string;
  cost: number;
  size: Size;
  comfort: number;
  style: number;
  category: FurnitureCategory;
  functionality: FunctionalityType;
  color: number;
}

export interface PlacedFurniture {
  uid: string;
  furnitureId: string;
  position: GridPosition;
}

export interface RecipeDefinition {
  id: string;
  name: string;
  ingredients: string[];
  preparationTimeSeconds: number;
  stationNeeded: "stove" | "counter";
  sellPrice: number;
  satisfactionEffect: number;
  unlockedByDefault: boolean;
}

export interface SaveGameState {
  money: number;
  reputation: number;
  dayNumber: number;
  unlockedRecipeIds: string[];
  furniture: PlacedFurniture[];
}
