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
  /** Which storey the item sits on. 0 = ground floor (default for any
   * save predating multi-storey). 1..NUM_STOREYS-1 = upper floors. The
   * item's world Y is offset by floor × STOREY_HEIGHT at mount time so
   * a placement at (x, z, floor=2) renders on Floor 2's slab. */
  floor?: number;
  disabledSeatIndexes?: number[];
  /** Surface-placed items only — uid of the host they sit on (a
   * counter, table, etc.). Persisted so save/load can re-snap the
   * surface item to the host's measured top instead of dropping it
   * to y=0 (which is what we got before — toasters and coffee
   * machines visibly "fell through" their counters after every
   * reload). */
  parentUid?: string;
  /** Surface-placed items only — index into the host def's
   * surfaceSlots array (which dx/dz on the host the item sits at). */
  slotIndex?: number;
  /** Surface-placed items only — the player's chosen rotation OFFSET
   * relative to the host (radians, normalised to (-π, π]). Without
   * this, the registry's surface-snap pass on restore force-resets
   * the child to host.rotY and any R-key rotation the player applied
   * (e.g. spinning a microwave 90° on a counter) is lost on reload. */
  localRotY?: number;
}

/** Kitchen appliance types a recipe can require. Each id is provided
 * by one or more catalog items via FurnitureDef.provides. A recipe is
 * "makeable" iff every appliance in its `appliances` list is provided
 * by at least one placed item. */
export type ApplianceId = "stove" | "counter" | "toaster" | "coffee" | "blender" | "microwave" | "hood";

/** Human labels for the appliance ids — used by the menu UI to show
 * "needs Toaster + Counter" badges on each recipe row. */
export const APPLIANCE_LABELS: Record<ApplianceId, string> = {
  stove: "Stove",
  counter: "Counter",
  toaster: "Toaster",
  coffee: "Coffee Machine",
  blender: "Blender",
  microwave: "Microwave",
  hood: "Range Hood",
};

export interface RecipeDefinition {
  id: string;
  name: string;
  category: "appetizer" | "main" | "dessert" | "drink" | "side";
  luxuryTier?: LuxuryTier;
  ingredients: string[];
  preparationTimeSeconds: number;
  /** @deprecated kept for save compatibility — use `appliances` instead. */
  stationNeeded: "stove" | "counter";
  /** Every appliance that must be placed in the restaurant for the
   * recipe to be makeable. Empty / undefined falls back to deriving
   * one from stationNeeded. */
  appliances?: readonly ApplianceId[];
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

/** A single hired staff member. The aggregate {@link HiredStaff}
 * counts are derived from filtering this list by role — this is the
 * source of truth. Each member has their own training level so the
 * player can mentor specific stars instead of buffing the whole role
 * at once. */
export interface HiredStaffMember {
  id: string;
  role: "chef" | "waiter" | "errand";
  name: string;
  upgradeLevel: number;
  /** Total playtime (seconds) at which the in-flight training
   * completes and the member's level ticks up. Absent when the
   * member is idle / not currently training. */
  trainingCompletesAt?: number;
  /** Storey the staff member calls home — they spawn at, idle on, and
   * work tasks for this floor. Default 0 (ground) for any save written
   * before the multi-storey expansion. Players reassign via the
   * StaffPanel floor selector once an upper storey is unlocked. */
  homeFloor?: number;
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
  /** Wall-clock deadlines (ms since epoch) for recipe upgrades that
   * are currently in progress. Only one entry at a time because the
   * kitchen can only test one new dish at once. Absent or empty when
   * no recipe is being developed. */
  recipeTrainingCompletesAt?: Record<string, number>;
  furniture: PlacedFurniture[];
  ingredients?: IngredientStock[];
  preparedServings?: Record<string, number>;
  dirtySeatUids?: string[];
  /** @deprecated Use `dishware` instead. Retained as a save-compat
   * field so old saves still load; ignored on write. */
  dirtyDishCount?: number;
  /** Per-tier plate + glass pools. Each entry is [tier, clean, dirty].
   * Absent / empty on a save predating the dishware feature; the
   * DishwareSystem hydrate seeds the starter inventory in that case. */
  dishware?: {
    plates?: Array<[number, number, number]>;
    glasses?: Array<[number, number, number]>;
  };
  staff?: HiredStaff;
  /** Per-role training upgrade levels (legacy / fallback for saves
   * predating per-member training). Used only if staffMembers is
   * absent. Each level applied to the corresponding role's roster
   * when the save loads. */
  staffUpgrades?: { chef?: number; waiter?: number; errand?: number };
  /** Source of truth for hired staff — one record per member with
   * their own id, name, and training level. {@link staff} counts are
   * derived from this list when present. */
  staffMembers?: HiredStaffMember[];
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
  /** Unlocked achievement ids. v2-specific. */
  achievements?: string[];
  /** Selected interior theme id — legacy single-theme field. Still
   * written on save so old loaders keep working; for new saves this
   * holds the GROUND floor's theme, and `themeByFloor` carries the
   * per-storey overrides. */
  themeId?: string;
  /** Per-floor theme ids (key = storey index 0..NUM_STOREYS-1). Absent
   * in saves predating multi-storey; loader rehydrates floor 0 from
   * `themeId` and leaves upper floors on the default. */
  themeByFloor?: Record<number, string>;
  /** Player-customised restaurant name for the door plaque. */
  restaurantName?: string;
  /** Per-axis catalog ids for the plaque visual style. */
  signStyle?: { font?: string; textColor?: string; plaqueStyle?: string };
  /** Plates / glasses currently RESERVED by mid-meal guests at save
   * time. Guests aren't persisted so without this every in-flight
   * reservation would vanish on the next load — the player would see
   * the inventory permanently shrink each refresh. On hydrate we add
   * each entry back to the clean pool: "the guest left at save time,
   * the plate's back in the kitchen". */
  inFlightDishes?: Array<{ kind: string; tier: number; count: number }>;
  /** Per-kind "high-water" total pieces ever added to the inventory.
   * Persisted so the next load can detect leaks (current owned <
   * persisted total) and TOP UP the clean pool with the missing
   * pieces. Acts as the source of truth: regardless of what got
   * silently dropped during the previous session, the inventory comes
   * back equal to or greater than this number. */
  dishwareLifetime?: { plate?: number; glass?: number };
  lastSavedAt?: number;
  staffActors?: SavedStaffActorState[];
  guests?: SavedGuestState[];
  tickets?: SavedTicketState[];
  pavementTrash?: SavedPavementTrashState[];
  transactionLog?: TransactionLogEntry[];
}
