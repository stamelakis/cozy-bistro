export type FurnitureCategory =
  | "table"
  | "chair"
  | "stove"
  | "counter"
  | "decoration"
  | "plant"
  | "wallDecoration"
  | "lighting"
  | "flooring";

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

export type LuxuryTier = 1 | 2 | 3 | 4 | 5;

export interface FurnitureDefinition {
  id: string;
  name: string;
  cost: number;
  luxuryTier?: LuxuryTier;
  size: Size;
  comfort: number;
  style: number;
  category: FurnitureCategory;
  functionality: FunctionalityType;
  color: number;
  cookingSlots?: number;
  seatingCapacity?: number;
  tableSeatCapacity?: number;
  serviceSpeedBonus?: number;
  ratingBonus?: number;
  attractionBonus?: number;
}

export interface PlacedFurniture {
  uid: string;
  furnitureId: string;
  position: GridPosition;
  rotation?: number;
  disabledSeatIndexes?: number[];
}

export interface RecipeDefinition {
  id: string;
  name: string;
  category: "appetizer" | "main" | "dessert" | "drink" | "side";
  luxuryTier?: LuxuryTier;
  ingredients: string[];
  preparationTimeSeconds: number;
  stationNeeded: "stove" | "counter";
  sellPrice: number;
  satisfactionEffect: number;
  unlockedByDefault: boolean;
  activeByDefault?: boolean;
}

export interface IngredientStock {
  id: string;
  name: string;
  quantity: number;
}

export interface HiredStaff {
  chefs: number;
  waiters: number;
  errandBoys?: number;
}

export interface AdminSettings {
  payrollPerStaffPerMinute?: number;
  ingredientUnitCost?: number;
  starterRecipeProfit?: number;
  itemCostMultiplier?: number;
  baseDailyRent?: number;
  rentPerExpansion?: number;
  firstExpansionCost?: number;
  expansionCostMultiplier?: number;
  trashDropChance?: number;
}

export interface SavedGuestState {
  id: string;
  chairUid: string;
  seatUid?: string;
  orderRecipeIds: string[];
  state: "waitingToOrder" | "waitingForFood";
  patience: number;
}

export interface SavedTicketState {
  id: string;
  guestId: string;
  recipeId: string;
  state: "ordering" | "queued" | "ready" | "delivered";
  preferredWaiterId?: string;
}

export interface SavedStaffActorState {
  role: "chef" | "waiter" | "errand";
  index: number;
  x: number;
  y: number;
}

export interface SavedPavementTrashState {
  id: string;
  kind: string;
  t: number;
  lane: number;
  droppedAt: number;
}

export interface TransactionLogEntry {
  at: number;
  transaction: string;
  amount: number;
  balance: number;
}

export interface SaveGameState {
  money: number;
  reputation: number;
  dayNumber: number;
  unlockedRecipeIds: string[];
  menuRecipeIds?: string[];
  recipeUpgradeLevels?: Record<string, number>;
  furniture: PlacedFurniture[];
  ingredients?: IngredientStock[];
  preparedServings?: Record<string, number>;
  dirtySeatUids?: string[];
  dirtyDishCount?: number;
  staff?: HiredStaff;
  adminSettings?: AdminSettings;
  restaurantOpen?: boolean;
  autoShopEnabled?: boolean;
  stockTarget?: number;
  ratingTotal?: number;
  ratingCount?: number;
  ratingHistory?: number[];
  dailyServed?: number;
  dailyLost?: number;
  dailyRevenue?: number;
  dailyExpenses?: number;
  rentElapsedSeconds?: number;
  totalPlaySeconds?: number;
  expansionLevel?: number;
  /** Per-day history snapshots (one per completed day). v2-specific. */
  dayHistory?: unknown[];
  lastSavedAt?: number;
  staffActors?: SavedStaffActorState[];
  guests?: SavedGuestState[];
  tickets?: SavedTicketState[];
  pavementTrash?: SavedPavementTrashState[];
  transactionLog?: TransactionLogEntry[];
}
