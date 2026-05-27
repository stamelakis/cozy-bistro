import Phaser from "phaser";
import type {
  AdminSettings,
  FurnitureDefinition,
  GridPosition,
  HiredStaff,
  IngredientStock,
  LuxuryTier,
  PlacedFurniture,
  RecipeDefinition,
  SaveGameState,
  SavedGuestState,
  SavedPavementTrashState,
  SavedStaffActorState,
} from "../components/types";
import { furnitureCatalog, getFurnitureDefinition } from "../data/furniture";
import { graphicsTheme } from "../data/graphicsTheme";
import { recipes } from "../data/recipes";
import {
  characterVariantCount,
  getFurnitureFrameMetadata,
  getCharacterSpriteFrame,
  getFurnitureSpriteFrame,
  getFurnitureSpriteOrigin,
  getFurnitureSpriteVisual,
  type CharacterVisualAction,
  type CharacterVisualRole,
} from "../data/visualAssets";
import { CookingSystem, getRecipeLuxuryTier, maxRecipeUpgradeLevel } from "../systems/CookingSystem";
import { CustomerSystem, type CustomerExpectation } from "../systems/CustomerSystem";
import { DayCycleSystem, rentIntervalSeconds } from "../systems/DayCycleSystem";
import { EconomySystem, type EarnReason, type ForceSpendReason, type SpendReason } from "../systems/EconomySystem";
import { FurniturePlacementSystem } from "../systems/FurniturePlacementSystem";
import { hydrateRatingHistoryFromSave, maxRatingHistory, ReputationSystem } from "../systems/ReputationSystem";
import { RestaurantGridSystem } from "../systems/RestaurantGridSystem";
import { SaveSystem } from "../systems/SaveSystem";
import { defaultPayrollPerStaffPerMinute, StaffSystem, type StaffRole } from "../systems/StaffSystem";

const furnitureAtlasImage = new URL("../assets/atlases/furniture.png", import.meta.url).href;
const furnitureAtlasData = new URL("../assets/atlases/furniture.json", import.meta.url).href;
const charactersAtlasImage = new URL("../assets/atlases/characters.png", import.meta.url).href;
const charactersAtlasData = new URL("../assets/atlases/characters.json", import.meta.url).href;
const environmentAtlasImage = new URL("../assets/atlases/environment.png", import.meta.url).href;
const environmentAtlasData = new URL("../assets/atlases/environment.json", import.meta.url).href;
const uiIconsAtlasImage = new URL("../assets/atlases/ui-icons.png", import.meta.url).href;
const uiIconsAtlasData = new URL("../assets/atlases/ui-icons.json", import.meta.url).href;
const maxPedestrians = 8;
const pedestrianWalkPixelsPerSecond = 68;
const pedestrianSpawnMinMs = 900;
const pedestrianSpawnMaxMs = 2100;
const maxPavementTrash = 30;
const trashRecycleReward = 2;
const defaultTrashDropChance = 0.05;
const offlineTrashDropMs = 3 * 60 * 1000;

type InteractionMode = "build" | "move" | "remove" | "seat" | "cook";
type StaffTask = "idle" | "cooking" | "serving" | "cleaning" | "payment" | "errand" | "relocating" | "receivingOrder";
type CustomerState = "entering" | "waitingToOrder" | "waitingForFood" | "served" | "paying" | "leaving";
type RightPanelTab = "ops" | "menu" | "stock";
type BuildTab = "furniture" | "kitchen" | "decor" | "walls";
type BuildSubTab =
  | "tables"
  | "chairs"
  | "stoves"
  | "counters"
  | "dishwashing"
  | "plants"
  | "decorations"
  | "lighting"
  | "wallFinishes"
  | "windows"
  | "doors"
  | "walls"
  | "flooring";
type PersonFacing =
  | "down"
  | "up"
  | "left"
  | "right"
  | "down-right"
  | "down-left"
  | "up-right"
  | "up-left";
type MapViewMode = "inside" | "street";

type ScrollbarTarget = "build" | "recipe" | "ingredient" | "inNeed" | "pantry" | "stock";
type PavementSnackKind = "cup" | "wrapper" | "bottle" | "carton";

interface ScrollbarRegion {
  target: ScrollbarTarget;
  x: number;
  y: number;
  width: number;
  height: number;
  maxOffset: number;
  currentOffset: number;
}

interface ActiveScrollbarDrag {
  target: ScrollbarTarget;
  grabOffsetY: number;
}

interface PersonColors {
  skin: number;
  shirt: number;
  pants: number;
  hair: number;
  apron: boolean;
  tie?: boolean;
}

interface Actor {
  id: string;
  role: StaffRole;
  task: StaffTask;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  legs: Phaser.GameObjects.Graphics;
  sprite?: Phaser.GameObjects.Image;
  bubble: Phaser.GameObjects.Text;
  busyUntil: number;
  walkTween?: Phaser.Tweens.Tween;
  actionTween?: Phaser.Tweens.Tween;
  flame?: Phaser.GameObjects.Graphics;
  carriedPlate?: Phaser.GameObjects.Graphics;
}

interface ChefHandoffCandidate {
  chef: Actor;
  stationIndex: number;
  station: Phaser.Math.Vector2;
  handoffPoint: Phaser.Math.Vector2;
}

interface WaiterPickupAssignment {
  waiter: Actor;
  pickupPoint: Phaser.Math.Vector2;
}

interface Guest {
  id: string;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  legs: Phaser.GameObjects.Graphics;
  sprite?: Phaser.GameObjects.Image;
  bubble: Phaser.GameObjects.Text;
  state: CustomerState;
  order: RecipeDefinition;
  orderItems: RecipeDefinition[];
  seatUid: string;
  chairUid: string;
  tableUid: string | null;
  seat: Phaser.Math.Vector2;
  serviceSpot: Phaser.Math.Vector2;
  cleanupSpot: Phaser.Math.Vector2;
  seatedFacing: PersonFacing;
  patience: number;
  seatedAt: number;
  orderedAt: number;
  paidAt: number;
  idealExperienceSeconds: number;
  billDue?: number;
  billedTicketIds?: string[];
  lockedPaymentDue?: number;
  lockedPaymentTicketIds?: string[];
  finishedEating?: boolean;
  eatingTween?: Phaser.Tweens.Tween;
  eatingOverlay?: Phaser.GameObjects.Graphics;
}

interface Pedestrian {
  id: string;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  legs: Phaser.GameObjects.Graphics;
  sprite?: Phaser.GameObjects.Image;
  bubble: Phaser.GameObjects.Text;
  routeEnd: Phaser.Math.Vector2;
  entering: boolean;
  snackKind?: PavementSnackKind;
  snackGraphic?: Phaser.GameObjects.Graphics;
  trashDropTimer?: Phaser.Time.TimerEvent;
}

interface PavementTrash {
  id: string;
  kind: PavementSnackKind;
  t: number;
  lane: number;
  droppedAt: number;
  container: Phaser.GameObjects.Container;
  icon: Phaser.GameObjects.Text;
}

interface TransientVisitor {
  id: string;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  legs: Phaser.GameObjects.Graphics;
  sprite?: Phaser.GameObjects.Image;
  bubble: Phaser.GameObjects.Text;
}

interface MealTicket {
  id: string;
  guestId: string;
  recipe: RecipeDefinition;
  state: "ordering" | "queued" | "cooking" | "ready" | "serving" | "delivered";
  readyAt: number;
  preferredWaiterId?: string;
  serviceKind?: "order" | "food";
  serviceStartedAt?: number;
  readyPlate?: Phaser.GameObjects.Graphics;
  stationIndex?: number;
}

interface DiningSeat {
  seatUid: string;
  chairUid: string;
  chairFurnitureId: string;
  seatIndex: number;
  disabled: boolean;
  tableUid: string | null;
  tableFurnitureId: string | null;
  seat: Phaser.Math.Vector2;
  serviceSpot: Phaser.Math.Vector2;
  cleanupSpot: Phaser.Math.Vector2;
  seatedFacing: PersonFacing;
  chairBackRotation: number;
}

interface IngredientOrderButton {
  ingredientId: string;
  amount: number;
  button: Phaser.GameObjects.Text;
}

interface RecipeMenuButton {
  recipeId: string;
  button: Phaser.GameObjects.Text;
  badge: Phaser.GameObjects.Container;
  upgradeButton: Phaser.GameObjects.Text;
}

interface RecipeCategoryHeader {
  category: RecipeDefinition["category"];
  text: Phaser.GameObjects.Text;
}

interface RateSample {
  time: number;
  quantity: number;
}

interface BuildButton {
  furnitureId: string;
  button: Phaser.GameObjects.Text;
  badge: Phaser.GameObjects.Container;
}

interface ExpansionDefinition {
  level: number;
  name: string;
  kind: "interior" | "yard";
  direction: "north" | "right" | "left";
  cells: GridPosition[];
  signPosition: GridPosition;
}

type BoundarySide = "north" | "south" | "west" | "east";

interface BoundaryRun {
  side: BoundarySide;
  fixed: number;
  start: number;
  end: number;
}

interface WallPlacementTarget {
  side: BoundarySide;
  position: GridPosition;
  rotation: number;
  span: number;
  distance: number;
}

interface IsoPrismSpec {
  top: Phaser.Math.Vector2[];
  height: number;
  topColor: number;
  frontColor?: number;
  sideColor?: number;
  outlineColor?: number;
  shadowAlpha?: number;
}

interface FurnitureVisualContext {
  definition: FurnitureDefinition;
  item: PlacedFurniture;
  size: { width: number; height: number };
  top: Phaser.Math.Vector2[];
  bottom: Phaser.Math.Vector2[];
  center: Phaser.Math.Vector2;
  height: number;
  baseY: number;
  visualRotation: number;
  tier: LuxuryTier;
}

interface PersonVisualTarget {
  id: string;
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  legs: Phaser.GameObjects.Graphics;
  sprite?: Phaser.GameObjects.Image;
  bubble?: Phaser.GameObjects.Text;
  carriedPlate?: Phaser.GameObjects.Graphics;
  seated: boolean;
  moving: boolean;
}

const defaultIngredientUnitCost = 5;
const defaultStarterRecipeProfit = 3;
const defaultItemCostMultiplier = 1;
const maxErrandOrderItems = 12;
const starterMoney = 520;
const starterGrantTarget = 220;
const pastaUnlockCost = 160;
const leftPanelX = 28;
const rightPanelX = 1314;
const gameWidth = 1600;
const gameHeight = 900;
const maxChairsPerTable = 4;
const customerWalkPixelsPerSecond = 90;
const staffWalkPixelsPerSecond = 125;
const orderHandOffSeconds = 0.8;
const eatingSecondsPerVisit = 30;
const paymentSeconds = 0.75;
const cleaningSeconds = 0.8;
const manualDishwashingSeconds = 2.8;
const dishwasherSeconds = 2.2;
const defaultBaseDailyRent = 0;
const defaultRentPerExpansion = 0;
const starterExpansionLevel = 0;
const legacyExpansionLevel = 2;
const maxExpansionLevel = 8;
const defaultFirstExpansionCost = 5000;
const defaultExpansionCostMultiplier = 2;
const panelFill = 0xfff4dc;
const panelStroke = 0xd8b98f;
const panelHeader = 0xead0a0;
const recipeScrollX = rightPanelX + 4;
const recipeScrollY = 252;
const recipeScrollWidth = 246;
const recipeScrollHeight = 580;
const ingredientScrollX = rightPanelX + 4;
const ingredientScrollY = 246;
const ingredientScrollWidth = 246;
const ingredientScrollHeight = 170;
const buildScrollX = leftPanelX + 4;
const buildScrollY = 692;
const buildScrollWidth = 292;
const buildScrollHeight = 136;
const pantryScrollX = rightPanelX + 4;
const pantryScrollY = 590;
const pantryScrollWidth = 246;
const pantryScrollHeight = 124;
const stockTabScrollX = rightPanelX - 10;
const stockTabScrollY = 164;
const stockTabScrollWidth = 274;
const stockTabScrollHeight = 714;
const inNeedPanelY = 394;
const inNeedScrollX = rightPanelX + 4;
const inNeedScrollY = inNeedPanelY + 40;
const inNeedScrollWidth = 246;
const inNeedScrollHeight = 82;
const stockOnHandPanelY = 552;
const kitchenTicketsPanelY = 736;
const panelScrollbarWidth = 8;
const restaurantZoomMin = 0.34;
const restaurantZoomMax = 3;
const restaurantZoomStep = 0.1;
const restaurantZoomCenter = new Phaser.Math.Vector2(826, 500);
const restaurantCameraYScale = 1;
const roomShellOutsetPixels = 0;
const standingPersonalSpaceRadius = 24;
const seatedPersonalSpaceRadius = 16;
const maxStandingPersonalOffset = 15;
const maxSeatedPersonalOffset = 2;
const statusBubbleLocalY = -114;
const statusBubbleVisibleMs = 760;
const statusBubbleFadeMs = 120;
const kitchenPickupCell: GridPosition = { x: 8, y: 4 };
const waiterHomeCell: GridPosition = { x: 7, y: 8 };
const errandHomeCell: GridPosition = { x: 8, y: 8 };
const restaurantExitCell: GridPosition = { x: 7, y: 10 };
const sinkFurnitureIds = ["tin-sink", "manual-sink", "porcelain-sink", "copper-sink", "double-basin-sink"];
const dishwasherFurnitureIds = ["dishwasher", "compact-dishwasher", "steam-dishwasher", "quiet-dishwasher", "auto-dishwasher-line"];
const serviceCounterFurnitureIds = ["service-counter", "prep-station", "cash-counter", "espresso-counter", "wooden-counter", "marble-counter", "host-stand"];
const backgroundDepth = -100;
const mapDepth = 0;
const uiDepth = 1000;
const mapViewport = {
  x: 350,
  y: 166,
  width: 928,
  height: 690,
};
const furnitureRenderCoalesceMs = 32;
const statsRefreshMs = 250;
const serviceAssignmentMs = 200;
const kitchenAssignmentMs = 200;
const recoveryCheckMs = 1000;
const autoShopCheckMs = 500;
const chefSyncMs = 1000;
const personalSpaceMs = 90;
const quietSaveDebounceMs = 2200;

export class GameScene extends Phaser.Scene {
  private grid!: RestaurantGridSystem;
  private economy!: EconomySystem;
  private reputation!: ReputationSystem;
  private placement!: FurniturePlacementSystem;
  private cooking!: CookingSystem;
  private customers!: CustomerSystem;
  private dayCycle!: DayCycleSystem;
  private saveSystem!: SaveSystem;
  private staffSystem!: StaffSystem;
  /** Read-only view of staff headcount delegated to staffSystem (kept as a getter so existing `this.staff.chefs` reads still work). */
  private get staff(): HiredStaff {
    return this.staffSystem.getStaff();
  }
  private mode: InteractionMode = "build";
  private restaurantLayer!: Phaser.GameObjects.Container;
  private streetLayer!: Phaser.GameObjects.Container;
  private mapViewMode: MapViewMode = "inside";
  private restaurantZoom = 1;
  private restaurantViewRotationStep = 0;
  private zoomText!: Phaser.GameObjects.Text;
  private viewRotationText!: Phaser.GameObjects.Text;
  private streetButton!: Phaser.GameObjects.Text;
  private restaurantShell: Phaser.GameObjects.Graphics | null = null;
  private restaurantForegroundShell: Phaser.GameObjects.Graphics | null = null;
  private gridGraphics: Phaser.GameObjects.Graphics | null = null;
  private expansionOverlayLayer!: Phaser.GameObjects.Container;
  private foregroundShellLayer!: Phaser.GameObjects.Container;
  private exteriorForegroundLayer!: Phaser.GameObjects.Container;
  private expansionSignLayer!: Phaser.GameObjects.Container;
  private furnitureLayer!: Phaser.GameObjects.Container;
  private actorLayer!: Phaser.GameObjects.Container;
  private chairBackOverlayLayer!: Phaser.GameObjects.Container;
  private preview!: Phaser.GameObjects.Graphics;
  private previewSprite!: Phaser.GameObjects.Image;
  private previewHint!: Phaser.GameObjects.Text;
  private ratingBox!: Phaser.GameObjects.Container;
  private ratingBoxBackground!: Phaser.GameObjects.Graphics;
  private ratingStarGraphics!: Phaser.GameObjects.Graphics;
  private ratingValueText!: Phaser.GameObjects.Text;
  private ratingVoteText!: Phaser.GameObjects.Text;
  private ratingHoverTimer: Phaser.Time.TimerEvent | null = null;
  private messageText!: Phaser.GameObjects.Text;
  private statsText!: Phaser.GameObjects.Text;
  private statsTextRight!: Phaser.GameObjects.Text;
  private modeText!: Phaser.GameObjects.Text;
  private selectedText!: Phaser.GameObjects.Text;
  private buildScrollContainer!: Phaser.GameObjects.Container;
  private buildScrollbar!: Phaser.GameObjects.Graphics;
  private cookText!: Phaser.GameObjects.Text;
  private staffText!: Phaser.GameObjects.Text;
  private staffTeamText!: Phaser.GameObjects.Text;
  private staffServiceText!: Phaser.GameObjects.Text;
  private staffStockText!: Phaser.GameObjects.Text;
  private recipeScrollContainer!: Phaser.GameObjects.Container;
  private recipeScrollbar!: Phaser.GameObjects.Graphics;
  private ingredientScrollContainer!: Phaser.GameObjects.Container;
  private ingredientScrollbar!: Phaser.GameObjects.Graphics;
  private ingredientMaskShape!: Phaser.GameObjects.Rectangle;
  private pantryText!: Phaser.GameObjects.Text;
  private pantryScrollContainer!: Phaser.GameObjects.Container;
  private pantryScrollbar!: Phaser.GameObjects.Graphics;
  private pantryMaskShape!: Phaser.GameObjects.Rectangle;
  private stockScrollContainer!: Phaser.GameObjects.Container;
  private stockScrollbar!: Phaser.GameObjects.Graphics;
  private inNeedScrollContainer!: Phaser.GameObjects.Container;
  private inNeedScrollbar!: Phaser.GameObjects.Graphics;
  private inNeedMaskShape!: Phaser.GameObjects.Rectangle;
  private inNeedText!: Phaser.GameObjects.Text;
  private queueText!: Phaser.GameObjects.Text;
  private errandOrderText!: Phaser.GameObjects.Text;
  private autoShopButton!: Phaser.GameObjects.Text;
  private stockTargetText!: Phaser.GameObjects.Text;
  private guideText!: Phaser.GameObjects.Text;
  private tooltipText!: Phaser.GameObjects.Text;
  private toastContainer: Phaser.GameObjects.Container | null = null;
  private saveModal: Phaser.GameObjects.Container | null = null;
  private adminModal: Phaser.GameObjects.Container | null = null;
  private expansionConfirmModal: Phaser.GameObjects.Container | null = null;
  private recipeUpgradeModal: Phaser.GameObjects.Container | null = null;
  private debugText!: Phaser.GameObjects.Text;
  private hireChefButton!: Phaser.GameObjects.Text;
  private hireWaiterButton!: Phaser.GameObjects.Text;
  private hireErrandButton!: Phaser.GameObjects.Text;
  private fireChefButton!: Phaser.GameObjects.Text;
  private fireWaiterButton!: Phaser.GameObjects.Text;
  private fireErrandButton!: Phaser.GameObjects.Text;
  private adminButton!: Phaser.GameObjects.Text;
  private publicToggleButton!: Phaser.GameObjects.Text;
  private buildTabButtons: Record<BuildTab, Phaser.GameObjects.Text> | null = null;
  private buildSubTabButtons: Partial<Record<BuildSubTab, Phaser.GameObjects.Text>> = {};
  private buildButtons: BuildButton[] = [];
  private menuButtons: RecipeMenuButton[] = [];
  private menuCategoryHeaders: RecipeCategoryHeader[] = [];
  private ingredientButtons: IngredientOrderButton[] = [];
  private rightTabButtons: Record<RightPanelTab, Phaser.GameObjects.Text> | null = null;
  private rightPanelContent: Record<RightPanelTab, Phaser.GameObjects.GameObject[]> = {
    ops: [],
    menu: [],
    stock: [],
  };
  private stockActionButtons: Phaser.GameObjects.Text[] = [];
  private activeRightTab: RightPanelTab = "ops";
  private activeBuildTab: BuildTab = "furniture";
  private activeBuildSubTab: BuildSubTab = "tables";
  private adminSettings: Required<AdminSettings> = {
    payrollPerStaffPerMinute: defaultPayrollPerStaffPerMinute,
    ingredientUnitCost: defaultIngredientUnitCost,
    starterRecipeProfit: defaultStarterRecipeProfit,
    itemCostMultiplier: defaultItemCostMultiplier,
    baseDailyRent: defaultBaseDailyRent,
    rentPerExpansion: defaultRentPerExpansion,
    firstExpansionCost: defaultFirstExpansionCost,
    expansionCostMultiplier: defaultExpansionCostMultiplier,
    trashDropChance: defaultTrashDropChance,
  };
  private recipeScrollOffset = 0;
  private recipeScrollContentHeight = 0;
  private buildScrollOffset = 0;
  private buildScrollContentHeight = 0;
  private ingredientScrollOffset = 0;
  private inNeedScrollOffset = 0;
  private pantryScrollOffset = 0;
  private stockScrollOffset = 0;
  private stockScrollContentHeight = 0;
  private autoShopEnabled = false;
  private restaurantOpen = true;
  private stockTarget = 20;
  private actors: Actor[] = [];
  private guests: Guest[] = [];
  private pedestrians: Pedestrian[] = [];
  private pavementTrash: PavementTrash[] = [];
  private transientVisitors: TransientVisitor[] = [];
  private tickets: MealTicket[] = [];
  private dirtySeatUids = new Set<string>();
  private cleaningSeatUids = new Set<string>();
  private dirtyDishCount = 0;
  private dishwasherBusy = false;
  private manualDishwashingBusy = false;
  private nextGuestAt = 0;
  private nextPedestrianAt = 0;
  private recentIngredientUse: RateSample[] = [];
  private recentRestockDeliveries: RateSample[] = [];
  private recentGuestEntries: RateSample[] = [];
  private recentTurnaways: RateSample[] = [];
  private recentServedGuests: RateSample[] = [];
  private recentLostGuests: RateSample[] = [];
  private recentRevenue: RateSample[] = [];
  private recentExpenses: RateSample[] = [];
  private recentCookedDishes: RateSample[] = [];
  private recentDeliveredDishes: RateSample[] = [];
  private lastAutoPersistAt = 0;
  private lastStatsUpdateAt = 0;
  private lastStatsUpdateMs = 0;
  private offlineSummaryMessage = "";
  private skipSavedGuestsRestore = false;
  private currentSaveSlot = 1;
  private lastDebugUpdateAt = 0;
  private lastFurnitureRenderAt = Number.NEGATIVE_INFINITY;
  private lastFurnitureRenderMs = 0;
  private furnitureRenderCount = 0;
  private furnitureRenderRate = 0;
  private furnitureRenderRateWindowStartedAt = 0;
  private showVisualAnchorOverlay = false;
  private pendingFurnitureRender = false;
  private pendingFurnitureRenderReasons = new Set<string>();
  private pendingQuietSave = false;
  private quietSaveDueAt = 0;
  private lastSaveMs = 0;
  private lastSaveBytes = 0;
  private pathDistanceCache = new Map<string, number>();
  private lastPathfindingMs = 0;
  private pathfindingWindowMs = 0;
  private pathfindingWindowCalls = 0;
  private pathfindingAverageMs = 0;
  private diningSeatsCacheKey = "";
  private diningSeatsCache: DiningSeat[] = [];
  private lastServiceAssignmentAt = 0;
  private lastKitchenAssignmentAt = 0;
  private lastRecoveryCheckAt = 0;
  private lastAutoShopCheckAt = 0;
  private lastChefSyncAt = 0;
  private lastPersonalSpaceAt = 0;
  private pendingPersonalSpaceDelta = 0;
  private expansionLevel = starterExpansionLevel;
  private lastPaintedFloorCellKey: string | null = null;
  private panStartPointer: Phaser.Math.Vector2 | null = null;
  private panStartLayer: Phaser.Math.Vector2 | null = null;
  private isPanningRestaurant = false;
  private activeScrollbarDrag: ActiveScrollbarDrag | null = null;
  private updateError: string | null = null;

  constructor() {
    super("GameScene");
  }

  preload(): void {
    this.load.atlas("furniture", furnitureAtlasImage, furnitureAtlasData);
    this.load.atlas("characters", charactersAtlasImage, charactersAtlasData);
    this.load.atlas("environment", environmentAtlasImage, environmentAtlasData);
    this.load.atlas("ui-icons", uiIconsAtlasImage, uiIconsAtlasData);
  }

  create(): void {
    this.saveSystem = new SaveSystem();
    this.currentSaveSlot = this.registry.get("currentSaveSlot") ?? 1;
    const save = this.saveSystem.load(this.currentSaveSlot);
    const initialFurniture = save?.furniture ?? this.getStarterFurniture();

    this.grid = new RestaurantGridSystem(30, 22, 58, new Phaser.Math.Vector2(420, 220), -8, -13);
    this.economy = new EconomySystem(save?.money ?? starterMoney);
    this.reputation = new ReputationSystem(save?.reputation ?? 1);
    this.expansionLevel = this.hydrateExpansionLevel(save, initialFurniture);
    this.adminSettings = this.hydrateAdminSettings(save?.adminSettings);
    this.placement = new FurniturePlacementSystem(
      this.grid,
      this.economy,
      initialFurniture,
      (definition) => this.getFurniturePurchaseCost(definition),
    );
    this.normalizeWallMountedFurnitureToCurrentWalls();
    this.cooking = new CookingSystem();
    this.customers = new CustomerSystem();
    this.dayCycle = new DayCycleSystem(save?.dayNumber ?? 1);
    this.staffSystem = new StaffSystem();
    this.staffSystem.hydrate(save);
    if (!save?.staff) {
      // Starter team for a brand-new game.
      this.staffSystem.addStaff("chef");
      this.staffSystem.addStaff("waiter");
      this.staffSystem.addStaff("errand");
    }
    this.dirtySeatUids = new Set(save?.dirtySeatUids ?? []);
    this.dirtyDishCount = save?.dirtyDishCount ?? 0;
    this.restaurantOpen = save?.restaurantOpen ?? true;
    this.cooking.hydrate(save, this.getUnlockedLuxuryTier());
    this.autoShopEnabled = save?.autoShopEnabled ?? false;
    this.stockTarget = save?.stockTarget ?? 20;
    this.reputation.hydrate(save);
    this.customers.hydrate(save);
    this.dayCycle.hydrate(save);
    this.economy.hydrate(save);
    if (this.economy.getTransactionLog().length === 0) {
      this.economy.recordTransaction("Log started from loaded balance", 0);
    }
    this.applyOfflineProgress(save);

    this.drawBackground();
    this.restaurantLayer = this.add.container(0, 0);
    this.restaurantLayer.setDepth(mapDepth);
    this.streetLayer = this.add.container(0, 0);
    this.streetLayer.setDepth(mapDepth + 1).setVisible(false);
    this.drawStreetView();
    this.createRestaurantViewportMask();
    this.expansionOverlayLayer = this.add.container(0, 0);
    this.foregroundShellLayer = this.add.container(0, 0);
    this.exteriorForegroundLayer = this.add.container(0, 0);
    this.expansionSignLayer = this.add.container(0, 0);
    this.refreshRestaurantShellAndGrid();
    this.furnitureLayer = this.add.container(0, 0);
    this.actorLayer = this.add.container(0, 0);
    this.chairBackOverlayLayer = this.add.container(0, 0);
    this.preview = this.add.graphics();
    this.previewSprite = this.add.image(0, 0, "furniture", "round-table-r0").setVisible(false).setAlpha(0.72);
    this.previewHint = this.add
      .text(0, 0, "", {
        fontFamily: "Arial",
        fontSize: "12px",
        color: "#fff5dc",
        backgroundColor: "rgba(72, 49, 38, 0.72)",
        padding: { left: 6, right: 6, top: 3, bottom: 3 },
      })
      .setDepth(20)
      .setVisible(false);
    this.restaurantLayer.add([
      this.furnitureLayer,
      this.actorLayer,
      this.chairBackOverlayLayer,
      this.foregroundShellLayer,
      this.exteriorForegroundLayer,
      this.expansionSignLayer,
      this.previewSprite,
      this.preview,
      this.previewHint,
    ]);
    this.hydratePavementTrash(save);
    this.createUi();
    this.createDebugOverlay();
    this.renderFurniture();
    this.applySceneDepths();
    this.frameRestaurantMap();
    this.rebuildStaffActors();
    this.restoreStaffActorPositions(save);
    this.restoreActiveGuests(save);
    this.updateStats(this.offlineSummaryMessage || "Welcome shift ready: a chef, waiter, seats, and pantry are already set up.");
    if (this.offlineSummaryMessage) {
      this.persistQuietly();
    }

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => this.handlePointerMove(pointer));
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.handlePointerDown(pointer));
    this.input.on("pointerup", () => {
      this.lastPaintedFloorCellKey = null;
      this.panStartPointer = null;
      this.panStartLayer = null;
      this.isPanningRestaurant = false;
      this.activeScrollbarDrag = null;
    });
    this.input.on("wheel", (pointer: Phaser.Input.Pointer, _objects: Phaser.GameObjects.GameObject[], _deltaX: number, deltaY: number) =>
      this.handlePanelWheel(pointer, deltaY),
    );
    this.input.keyboard?.on("keydown-ESC", () => {
      this.deselectSelection();
    });
    this.input.keyboard?.on("keydown-R", () => this.rotateSelection());
    this.input.keyboard?.on("keydown-S", () => this.saveGame());

    const flushBeforePageExit = () => this.flushQuietSave();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        this.flushQuietSave();
      }
    };
    window.addEventListener("beforeunload", flushBeforePageExit);
    document.addEventListener("visibilitychange", flushWhenHidden);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.flushQuietSave();
      window.removeEventListener("beforeunload", flushBeforePageExit);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    });
  }

  update(time: number, delta: number): void {
    if (this.updateError) {
      return;
    }

    try {
      const tickResult = this.dayCycle.tick(delta / 1000);
      if (tickResult.dayEnded) {
        this.handleDayEnded();
      }
      this.updatePedestrians(time);
      this.spawnGuests(time);
      this.updateGuests(time, delta / 1000);
      this.processPendingStaffFirings();
      if (time - this.lastRecoveryCheckAt >= recoveryCheckMs) {
        this.lastRecoveryCheckAt = time;
        this.recoverStalledOrderHandoffs(time);
        this.recoverStalledFoodDeliveries(time);
        this.recoverOrphanedServiceTickets();
        this.recoverStalledGuestPayments();
        this.recoverStalledCleaningReservations();
      }
      if (time - this.lastKitchenAssignmentAt >= kitchenAssignmentMs) {
        this.lastKitchenAssignmentAt = time;
        this.assignKitchenWork(time);
      }
      if (time - this.lastServiceAssignmentAt >= serviceAssignmentMs) {
        this.lastServiceAssignmentAt = time;
        this.assignServiceWork(time);
      }
      if (time - this.lastAutoShopCheckAt >= autoShopCheckMs) {
        this.lastAutoShopCheckAt = time;
        this.runAutoShop();
      }
      this.runDishwasher();
      this.chargeStaffSalaries(time);
      this.chargeRent();
      if (time - this.lastChefSyncAt >= chefSyncMs) {
        this.lastChefSyncAt = time;
        this.syncChefStations();
      }
      this.pendingPersonalSpaceDelta += delta / 1000;
      if (time - this.lastPersonalSpaceAt >= personalSpaceMs) {
        this.lastPersonalSpaceAt = time;
        this.updatePersonalSpace(this.pendingPersonalSpaceDelta);
        this.pendingPersonalSpaceDelta = 0;
      }
      this.sortActorDepths();
      this.flushQueuedFurnitureRender(time);
      this.flushQuietSaveIfDue(time);
      this.updateStats();
      this.updateDebugOverlay(time, delta);
    } catch (error) {
      this.updateError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.setTextIfChanged(this.debugText, `UPDATE ERROR\n${this.updateError}`);
      this.debugText.setBackgroundColor("#8f2f2f");
      throw error;
    }
  }

  private drawBackground(): void {
    this.add.rectangle(gameWidth / 2, gameHeight / 2, gameWidth, gameHeight, 0xf4d79f).setData("background", true);
    this.add.rectangle(gameWidth / 2, 66, gameWidth, 132, 0x8fc7cd).setData("background", true);
    this.add.rectangle(gameWidth / 2, 126, gameWidth, 64, 0x6c9fa8).setData("background", true);

    this.add.rectangle(170, 518, 326, 748, 0xf4d79f).setData("background", true);
    this.add.rectangle(1454, 518, 292, 748, 0xf4d79f).setData("background", true);

    this.add.text(682, 24, "COZY BISTRO", {
      color: "#3b2a21",
      fontFamily: "Georgia, serif",
      fontSize: "38px",
      fontStyle: "bold",
    });
    this.add.text(690, 72, "a tiny restaurant built for two", {
      color: "#5e473a",
      fontSize: "16px",
      fontFamily: "Arial, sans-serif",
    });
    this.createRatingWidget();

    this.add.rectangle(gameWidth / 2, 870, gameWidth, 60, 0x8e705d).setData("background", true);
  }

  private createRatingWidget(): void {
    const width = 344;
    const height = 42;
    this.ratingBox = this.add.container(gameWidth - width - 28, 50).setDepth(uiDepth + 10);
    this.ratingBoxBackground = this.add.graphics();
    this.ratingStarGraphics = this.add.graphics();
    const label = this.add.text(14, 12, "Rating", {
      color: "#3b2a21",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "14px",
      fontStyle: "bold",
    });
    this.ratingValueText = this.add.text(70, 12, "", {
      color: "#3b2a21",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "14px",
      fontStyle: "bold",
    });
    this.ratingVoteText = this.add.text(246, 13, "", {
      color: "#5e473a",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "12px",
    });

    this.ratingBox.add([this.ratingBoxBackground, label, this.ratingStarGraphics, this.ratingValueText, this.ratingVoteText]);
    this.ratingBox.setSize(width, height);
    this.ratingBox.setInteractive(new Phaser.Geom.Rectangle(0, 0, width, height), Phaser.Geom.Rectangle.Contains);
    this.ratingBox.on("pointerover", (pointer: Phaser.Input.Pointer) => this.queueRatingTooltip(pointer));
    this.ratingBox.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (this.tooltipText?.visible) {
        this.positionRatingTooltip(pointer.x, pointer.y);
      }
    });
    this.ratingBox.on("pointerout", () => {
      this.clearRatingTooltipTimer();
      this.hideTooltip();
    });
    this.updateRatingWidget();
  }

  private drawRestaurantShell(): Phaser.GameObjects.Graphics {
    const graphics = this.add.graphics();
    const cells = this.getUnlockedExpansionCells();
    const cellKeys = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    const wallFace = 0xfffbf0;
    const wallSide = 0xefe5d6;
    const wallTrim = 0xc9b9a6;
    const wallHeight = 134;
    const entranceCells = new Set(["6,8", "7,8"]);

    this.drawExteriorStreetScene(graphics);

    const bounds = this.getIsoBounds(cells);
    graphics.fillStyle(0x8a6049, 0.2);
    graphics.fillEllipse(
      (bounds.minX + bounds.maxX) / 2,
      bounds.maxY + 34,
      Math.max(1, bounds.maxX - bounds.minX) * 0.86,
      52,
    );

    const wallRuns = this.getBoundaryRuns(cells, cellKeys, entranceCells);
    wallRuns
      .filter((run) => !this.isBoundaryRunNearCamera(run))
      .forEach((run) => {
        const { a, b } = this.getVisualBoundaryRunEndpoints(run);
        const fill = run.side === "north" || run.side === "south" ? wallFace : wallSide;
        this.drawIsoWallPlane(graphics, a, b, wallHeight, fill, wallTrim);
      });

    if (!this.isEntranceEdgeNearCamera()) {
      this.drawEntrancePortal(graphics);
    }

    return graphics;
  }

  private drawRestaurantForegroundShell(): Phaser.GameObjects.Graphics {
    const graphics = this.add.graphics();
    const cells = this.getUnlockedExpansionCells();
    const cellKeys = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    const entranceCells = new Set(["6,8", "7,8"]);
    const wallRuns = this.getBoundaryRuns(cells, cellKeys, entranceCells);

    wallRuns
      .filter((run) => this.isBoundaryRunNearCamera(run))
      .forEach((run) => {
        const { a, b } = this.getVisualBoundaryRunEndpoints(run);
        this.drawIsoTransparentFrontWall(graphics, a, b, 22, 0xfffbf0, 0xc9b9a6);
      });

    if (this.isEntranceEdgeNearCamera()) {
      this.drawTransparentEntrancePortal(graphics);
    }
    return graphics;
  }

  private drawExteriorStreetScene(graphics: Phaser.GameObjects.Graphics): void {
    const bounds = this.getUnlockedExpansionBounds();
    const frontRun: BoundaryRun = {
      side: "south",
      fixed: bounds.maxY,
      start: bounds.minX - 3,
      end: bounds.maxX + 2,
    };
    const { a, b } = this.getVisualBoundaryRunEndpoints(frontRun, roomShellOutsetPixels + 8);
    const outward = this.getBoundaryOutwardOffset(frontRun, 1);
    const along = b.clone().subtract(a);
    if (outward.lengthSq() === 0 || along.lengthSq() === 0) {
      return;
    }

    const sidewalkInner = 12;
    const sidewalkOuter = 94;
    const roadOuter = 206;
    const curbWidth = 8;
    const sidewalkA = a.clone().add(outward.clone().scale(sidewalkInner));
    const sidewalkB = b.clone().add(outward.clone().scale(sidewalkInner));
    const curbA = a.clone().add(outward.clone().scale(sidewalkOuter));
    const curbB = b.clone().add(outward.clone().scale(sidewalkOuter));
    const roadA = a.clone().add(outward.clone().scale(roadOuter));
    const roadB = b.clone().add(outward.clone().scale(roadOuter));
    const curbOuterA = a.clone().add(outward.clone().scale(sidewalkOuter + curbWidth));
    const curbOuterB = b.clone().add(outward.clone().scale(sidewalkOuter + curbWidth));
    const sidewalk = [sidewalkA, sidewalkB, curbB, curbA];
    const road = [curbOuterA, curbOuterB, roadB, roadA];
    const curb = [curbA, curbB, curbOuterB, curbOuterA];

    graphics.fillStyle(0x7e6f61, 0.14);
    graphics.fillPoints(road.map((point) => new Phaser.Math.Vector2(point.x + 12, point.y + 18)), true);
    graphics.fillStyle(0x6f7270, 0.98);
    graphics.fillPoints(road, true);
    graphics.lineStyle(2, 0x545958, 0.62);
    graphics.strokePoints(road, true);

    const laneA = this.lerpPoint(curbOuterA, roadA, 0.52);
    const laneB = this.lerpPoint(curbOuterB, roadB, 0.52);
    for (let ratio = 0.08; ratio < 0.96; ratio += 0.16) {
      const dashStart = this.lerpPoint(laneA, laneB, ratio);
      const dashEnd = this.lerpPoint(laneA, laneB, Math.min(0.98, ratio + 0.07));
      graphics.lineStyle(4, 0xf4ead8, 0.72);
      graphics.lineBetween(dashStart.x, dashStart.y, dashEnd.x, dashEnd.y);
    }

    graphics.fillStyle(0xc8b99f, 1);
    graphics.fillPoints(curb, true);
    graphics.lineStyle(2, 0xf3e7d0, 0.75);
    graphics.lineBetween(curbA.x, curbA.y, curbB.x, curbB.y);
    graphics.lineStyle(2, 0x8e7c67, 0.75);
    graphics.lineBetween(curbOuterA.x, curbOuterA.y, curbOuterB.x, curbOuterB.y);

    graphics.fillStyle(0xd8c8aa, 0.98);
    graphics.fillPoints(sidewalk, true);
    graphics.lineStyle(2, 0xf8edd8, 0.7);
    graphics.strokePoints(sidewalk, true);
    graphics.lineStyle(1, 0xa89273, 0.34);
    for (let ratio = 0.08; ratio < 1; ratio += 0.08) {
      const innerPoint = this.lerpPoint(sidewalkA, sidewalkB, ratio);
      const outerPoint = this.lerpPoint(curbA, curbB, ratio);
      graphics.lineBetween(innerPoint.x, innerPoint.y, outerPoint.x, outerPoint.y);
    }
    for (const ratio of [0.32, 0.64]) {
      const left = this.lerpPoint(sidewalkA, curbA, ratio);
      const right = this.lerpPoint(sidewalkB, curbB, ratio);
      graphics.lineStyle(1, 0xf4e6ce, 0.56);
      graphics.lineBetween(left.x, left.y, right.x, right.y);
    }

    [0.44, 0.49, 0.51, 0.56].forEach((ratio) => {
      const bollardBase = this.lerpPoint(curbA, curbB, ratio).add(outward.clone().scale(-4));
      graphics.fillStyle(0x46362d, 0.1);
      graphics.fillEllipse(bollardBase.x + 4, bollardBase.y + 7, 18, 7);
    });
  }

  private drawExteriorForegroundScene(): void {
    [...this.exteriorForegroundLayer.list]
      .filter((child) => child.getData?.("exteriorStreetProp") === true)
      .forEach((child) => child.destroy());

    const bounds = this.getUnlockedExpansionBounds();
    const frontRun: BoundaryRun = {
      side: "south",
      fixed: bounds.maxY,
      start: bounds.minX - 3,
      end: bounds.maxX + 2,
    };
    const { a, b } = this.getVisualBoundaryRunEndpoints(frontRun, roomShellOutsetPixels + 8);
    const outward = this.getBoundaryOutwardOffset(frontRun, 1);
    const along = b.clone().subtract(a);
    if (outward.lengthSq() === 0 || along.lengthSq() === 0) {
      return;
    }

    const sidewalkInner = 12;
    const sidewalkOuter = 94;
    const sidewalkA = a.clone().add(outward.clone().scale(sidewalkInner));
    const sidewalkB = b.clone().add(outward.clone().scale(sidewalkInner));
    const curbA = a.clone().add(outward.clone().scale(sidewalkOuter));
    const curbB = b.clone().add(outward.clone().scale(sidewalkOuter));
    const props: Array<{
      base: Phaser.Math.Vector2;
      kind: "lamp" | "planter" | "bollard";
    }> = [
      { kind: "lamp", base: this.lerpPoint(sidewalkA, sidewalkB, 0.16).add(outward.clone().scale(42)) },
      { kind: "lamp", base: this.lerpPoint(sidewalkA, sidewalkB, 0.84).add(outward.clone().scale(42)) },
      { kind: "planter", base: this.lerpPoint(sidewalkA, sidewalkB, 0.31).add(outward.clone().scale(60)) },
      { kind: "planter", base: this.lerpPoint(sidewalkA, sidewalkB, 0.69).add(outward.clone().scale(60)) },
      ...[0.44, 0.49, 0.51, 0.56].map((ratio) => ({
        kind: "bollard" as const,
        base: this.lerpPoint(curbA, curbB, ratio).add(outward.clone().scale(-4)),
      })),
    ];

    props.forEach(({ base, kind }) => {
      const prop = this.add.graphics();
      if (kind === "lamp") {
        this.drawPavementLamp(prop, base);
      } else if (kind === "planter") {
        this.drawPavementPlanter(prop, base);
      } else {
        this.drawPavementBollard(prop, base);
      }
      prop.setData("sortY", base.y + (kind === "lamp" ? 3 : 8));
      prop.setData("worldSortKind", kind === "lamp" ? 1 : 0);
      prop.setData("exteriorStreetProp", true);
      this.exteriorForegroundLayer.add(prop);
    });
    this.sortExteriorForegroundDepths();
  }

  private drawPavementLamp(graphics: Phaser.GameObjects.Graphics, base: Phaser.Math.Vector2): void {
    graphics.fillStyle(0x46362d, 0.18);
    graphics.fillEllipse(base.x + 9, base.y + 9, 34, 13);
    graphics.fillStyle(0x50443b, 1);
    graphics.fillEllipse(base.x, base.y + 3, 20, 9);
    graphics.fillStyle(0x2e2f31, 1);
    graphics.fillRoundedRect(base.x - 3, base.y - 54, 6, 58, 3);
    graphics.fillStyle(0x737372, 1);
    graphics.fillRoundedRect(base.x - 1, base.y - 52, 2, 52, 1);
    graphics.fillStyle(0xfff1a8, 0.28);
    graphics.fillEllipse(base.x, base.y - 62, 40, 24);
    graphics.fillStyle(0x3c4140, 1);
    graphics.fillRoundedRect(base.x - 10, base.y - 71, 20, 16, 4);
    graphics.fillStyle(0xffe6a6, 1);
    graphics.fillRoundedRect(base.x - 7, base.y - 67, 14, 10, 3);
    graphics.lineStyle(2, 0x262829, 0.9);
    graphics.strokeRoundedRect(base.x - 10, base.y - 71, 20, 16, 4);
  }

  private drawPavementBollard(graphics: Phaser.GameObjects.Graphics, base: Phaser.Math.Vector2): void {
    graphics.fillStyle(0x46362d, 0.16);
    graphics.fillEllipse(base.x + 4, base.y + 7, 18, 7);
    graphics.fillStyle(0x5b4a3e, 1);
    graphics.fillRoundedRect(base.x - 4, base.y - 20, 8, 24, 3);
    graphics.fillStyle(0xf3d58a, 0.9);
    graphics.fillRect(base.x - 3, base.y - 13, 6, 4);
    graphics.fillStyle(0x372b25, 0.9);
    graphics.fillEllipse(base.x, base.y - 20, 9, 5);
  }

  private drawPavementPlanter(graphics: Phaser.GameObjects.Graphics, base: Phaser.Math.Vector2): void {
    graphics.fillStyle(0x46362d, 0.13);
    graphics.fillEllipse(base.x + 7, base.y + 12, 42, 15);
    const planterTop = [
      new Phaser.Math.Vector2(base.x - 22, base.y - 4),
      new Phaser.Math.Vector2(base.x + 20, base.y - 7),
      new Phaser.Math.Vector2(base.x + 26, base.y + 8),
      new Phaser.Math.Vector2(base.x - 16, base.y + 12),
    ];
    const planterBottom = planterTop.map((point) => new Phaser.Math.Vector2(point.x, point.y + 15));
    graphics.fillStyle(0x7d5a43, 1);
    graphics.fillPoints([planterTop[3], planterTop[2], planterBottom[2], planterBottom[3]], true);
    graphics.fillStyle(0x9b6d4f, 1);
    graphics.fillPoints(planterTop, true);
    graphics.lineStyle(2, 0x5b4033, 0.9);
    graphics.strokePoints(planterTop, true);
    graphics.fillStyle(0x4f8a5b, 1);
    for (const offset of [-14, -5, 5, 14]) {
      graphics.fillEllipse(base.x + offset, base.y - 12 - Math.abs(offset) * 0.15, 15, 22);
    }
    graphics.fillStyle(0x73aa67, 1);
    for (const offset of [-10, 0, 10]) {
      graphics.fillEllipse(base.x + offset, base.y - 19, 10, 18);
    }
  }

  private drawEntranceGroundDetail(
    graphics: Phaser.GameObjects.Graphics,
    left: Phaser.Math.Vector2,
    right: Phaser.Math.Vector2,
    openingLeftT: number,
    openingRightT: number,
    alpha = 1,
  ): void {
    const run: BoundaryRun = { side: "south", fixed: 8, start: 6, end: 7 };
    const outward = this.getBoundaryOutwardOffset(run, 1);
    const along = right.clone().subtract(left);
    if (outward.lengthSq() === 0 || along.lengthSq() === 0) {
      return;
    }

    outward.normalize();
    along.normalize();
    const baseLeft = this.lerpPoint(left, right, openingLeftT - 0.04);
    const baseRight = this.lerpPoint(left, right, openingRightT + 0.04);
    const farLeft = baseLeft.clone().add(outward.clone().scale(102)).subtract(along.clone().scale(18));
    const farRight = baseRight.clone().add(outward.clone().scale(102)).add(along.clone().scale(18));
    const nearLeft = baseLeft.clone().add(outward.clone().scale(12)).add(along.clone().scale(7));
    const nearRight = baseRight.clone().add(outward.clone().scale(12)).subtract(along.clone().scale(7));

    graphics.fillStyle(0x4b352c, 0.1 * alpha);
    graphics.fillPoints([nearLeft, nearRight, farRight, farLeft], true);
    graphics.fillStyle(0x4b352c, 0.06 * alpha);
    graphics.fillEllipse(
      (farLeft.x + farRight.x) / 2,
      (farLeft.y + farRight.y) / 2 + 4,
      Phaser.Math.Distance.Between(farLeft.x, farLeft.y, farRight.x, farRight.y) * 0.78,
      26,
    );

    const thresholdInnerLeft = baseLeft.clone().add(outward.clone().scale(-3));
    const thresholdInnerRight = baseRight.clone().add(outward.clone().scale(-3));
    const thresholdOuterRight = baseRight.clone().add(outward.clone().scale(28));
    const thresholdOuterLeft = baseLeft.clone().add(outward.clone().scale(28));
    const threshold = [thresholdInnerLeft, thresholdInnerRight, thresholdOuterRight, thresholdOuterLeft];
    graphics.fillStyle(0xd7c8ab, 0.88 * alpha);
    graphics.fillPoints(threshold, true);
    graphics.lineStyle(2, 0xf8edd8, 0.72 * alpha);
    graphics.lineBetween(thresholdInnerLeft.x, thresholdInnerLeft.y, thresholdInnerRight.x, thresholdInnerRight.y);
    graphics.lineStyle(2, 0x9f8b70, 0.48 * alpha);
    graphics.strokePoints(threshold, true);
    graphics.lineStyle(1, 0xf4e6ce, 0.54 * alpha);
    [0.33, 0.66].forEach((ratio) => {
      const inner = this.lerpPoint(thresholdInnerLeft, thresholdOuterLeft, ratio);
      const outer = this.lerpPoint(thresholdInnerRight, thresholdOuterRight, ratio);
      graphics.lineBetween(inner.x, inner.y, outer.x, outer.y);
    });
  }

  private drawEntrancePortal(graphics: Phaser.GameObjects.Graphics): void {
    const { a: right, b: left } = this.getVisualBoundaryRunEndpoints({ side: "south", fixed: 8, start: 6, end: 7 });
    const wallHeight = 134;
    const doorHeight = 88;
    const openingLeftT = 0.18;
    const openingRightT = 0.82;
    const wallFace = 0xfffbf0;
    const wallSide = 0xeee2d1;
    const wallTrim = 0xc9b9a6;
    const pointAt = (ratio: number, yOffset = 0): Phaser.Math.Vector2 => {
      const point = this.lerpPoint(left, right, ratio);
      return new Phaser.Math.Vector2(point.x, point.y + yOffset);
    };
    const topAt = (ratio: number) => pointAt(ratio, -wallHeight);
    const doorTopAt = (ratio: number) => pointAt(ratio, -doorHeight);
    const baseAt = (ratio: number) => pointAt(ratio, 0);
    const drawWallPanel = (panel: Phaser.Math.Vector2[], fill = wallFace, alpha = 1): void => {
      graphics.fillStyle(fill, alpha);
      graphics.fillPoints(panel, true);
      graphics.lineStyle(2, wallTrim, 0.95);
      graphics.strokePoints(panel, true);
    };

    this.drawEntranceGroundDetail(graphics, left, right, openingLeftT, openingRightT);

    const capLift = 12;
    drawWallPanel([
      new Phaser.Math.Vector2(topAt(0).x, topAt(0).y - capLift),
      new Phaser.Math.Vector2(topAt(1).x, topAt(1).y - capLift),
      topAt(1),
      topAt(0),
    ], wallSide);
    drawWallPanel([topAt(0), topAt(openingLeftT), baseAt(openingLeftT), baseAt(0)]);
    drawWallPanel([topAt(openingRightT), topAt(1), baseAt(1), baseAt(openingRightT)]);
    drawWallPanel([topAt(openingLeftT), topAt(openingRightT), doorTopAt(openingRightT), doorTopAt(openingLeftT)]);

    graphics.lineStyle(7, 0xe1d2be, 0.95);
    graphics.lineBetween(baseAt(0).x, baseAt(0).y - 4, baseAt(openingLeftT).x, baseAt(openingLeftT).y - 4);
    graphics.lineBetween(baseAt(openingRightT).x, baseAt(openingRightT).y - 4, baseAt(1).x, baseAt(1).y - 4);
    graphics.lineStyle(4, 0xe1d2be, 0.95);
    graphics.lineBetween(doorTopAt(openingLeftT).x, doorTopAt(openingLeftT).y, doorTopAt(openingRightT).x, doorTopAt(openingRightT).y);
    graphics.lineStyle(3, 0xbca890, 0.9);
    graphics.lineBetween(topAt(0).x, topAt(0).y + 9, topAt(1).x, topAt(1).y + 9);

    const doorPanel = [
      doorTopAt(openingLeftT + 0.04),
      doorTopAt(openingRightT - 0.04),
      pointAt(openingRightT - 0.04, 7),
      pointAt(openingLeftT + 0.04, 7),
    ];
    const entranceDoor = this.getEntranceDoorDefinition();
    this.drawIsoDoorOnPanel(graphics, doorPanel, this.getFurnitureLuxuryTier(entranceDoor), entranceDoor);

    graphics.lineStyle(8, 0xfffbf0, 1);
    graphics.lineBetween(doorTopAt(openingLeftT).x, doorTopAt(openingLeftT).y, baseAt(openingLeftT).x, baseAt(openingLeftT).y + 6);
    graphics.lineBetween(doorTopAt(openingRightT).x, doorTopAt(openingRightT).y, baseAt(openingRightT).x, baseAt(openingRightT).y + 6);
    graphics.lineStyle(2, wallTrim, 0.95);
    graphics.lineBetween(doorTopAt(openingLeftT).x, doorTopAt(openingLeftT).y, baseAt(openingLeftT).x, baseAt(openingLeftT).y + 6);
    graphics.lineBetween(doorTopAt(openingRightT).x, doorTopAt(openingRightT).y, baseAt(openingRightT).x, baseAt(openingRightT).y + 6);
  }

  private drawTransparentEntrancePortal(graphics: Phaser.GameObjects.Graphics): void {
    const { a: right, b: left } = this.getVisualBoundaryRunEndpoints({ side: "south", fixed: 8, start: 6, end: 7 });
    const openingLeftT = 0.18;
    const openingRightT = 0.82;
    const ghostHeight = 42;
    const pointAt = (ratio: number, yOffset = 0): Phaser.Math.Vector2 => {
      const point = this.lerpPoint(left, right, ratio);
      return new Phaser.Math.Vector2(point.x, point.y + yOffset);
    };
    const topAt = (ratio: number) => pointAt(ratio, -ghostHeight);
    const baseAt = (ratio: number) => pointAt(ratio, 0);

    this.drawIsoTransparentFrontWall(graphics, left, right, 18, 0xfffbf0, 0xc9b9a6);

    this.drawEntranceGroundDetail(graphics, left, right, openingLeftT, openingRightT, 0.42);

    const glassPanel = [
      topAt(openingLeftT),
      topAt(openingRightT),
      baseAt(openingRightT),
      baseAt(openingLeftT),
    ];
    graphics.fillStyle(0xbfe6ef, 0.12);
    graphics.fillPoints(glassPanel, true);
    graphics.lineStyle(4, 0xffffff, 0.3);
    graphics.strokePoints(glassPanel, true);
    graphics.lineStyle(2, 0x9cb2b7, 0.28);
    graphics.lineBetween(topAt(openingLeftT).x, topAt(openingLeftT).y, baseAt(openingLeftT).x, baseAt(openingLeftT).y + 4);
    graphics.lineBetween(topAt(openingRightT).x, topAt(openingRightT).y, baseAt(openingRightT).x, baseAt(openingRightT).y + 4);
    graphics.lineBetween(topAt(openingLeftT).x, topAt(openingLeftT).y, topAt(openingRightT).x, topAt(openingRightT).y);
  }

  private getBoundaryRuns(cells: GridPosition[], cellKeys: Set<string>, entranceCells: Set<string>): BoundaryRun[] {
    const bySideAndFixed = new Map<string, number[]>();
    const push = (side: BoundarySide, fixed: number, variable: number): void => {
      const key = `${side}:${fixed}`;
      bySideAndFixed.set(key, [...(bySideAndFixed.get(key) ?? []), variable]);
    };

    cells.forEach((cell) => {
      if (!cellKeys.has(`${cell.x},${cell.y - 1}`)) {
        push("north", cell.y, cell.x);
      }
      if (!cellKeys.has(`${cell.x},${cell.y + 1}`) && !entranceCells.has(`${cell.x},${cell.y}`)) {
        push("south", cell.y, cell.x);
      }
      if (!cellKeys.has(`${cell.x - 1},${cell.y}`)) {
        push("west", cell.x, cell.y);
      }
      if (!cellKeys.has(`${cell.x + 1},${cell.y}`)) {
        push("east", cell.x, cell.y);
      }
    });

    const runs: BoundaryRun[] = [];
    bySideAndFixed.forEach((values, key) => {
      const [side, fixedText] = key.split(":") as [BoundarySide, string];
      const fixed = Number(fixedText);
      const sorted = [...new Set(values)].sort((a, b) => a - b);
      let start = sorted[0];
      let previous = sorted[0];
      for (let index = 1; index <= sorted.length; index += 1) {
        const value = sorted[index];
        if (value === previous + 1) {
          previous = value;
          continue;
        }

        if (start !== undefined && previous !== undefined) {
          runs.push({ side, fixed, start, end: previous });
        }
        start = value;
        previous = value;
      }
    });

    return runs;
  }

  private getBoundaryRunEndpoints(run: BoundaryRun): { a: Phaser.Math.Vector2; b: Phaser.Math.Vector2 } {
    if (run.side === "north") {
      return {
        a: this.grid.gridToWorld({ x: run.start, y: run.fixed }),
        b: this.grid.gridToWorld({ x: run.end + 1, y: run.fixed }),
      };
    }

    if (run.side === "south") {
      return {
        a: this.grid.gridToWorld({ x: run.end + 1, y: run.fixed + 1 }),
        b: this.grid.gridToWorld({ x: run.start, y: run.fixed + 1 }),
      };
    }

    if (run.side === "west") {
      return {
        a: this.grid.gridToWorld({ x: run.fixed, y: run.end + 1 }),
        b: this.grid.gridToWorld({ x: run.fixed, y: run.start }),
      };
    }

    return {
      a: this.grid.gridToWorld({ x: run.fixed + 1, y: run.start }),
      b: this.grid.gridToWorld({ x: run.fixed + 1, y: run.end + 1 }),
    };
  }

  private getVisualBoundaryRunEndpoints(
    run: BoundaryRun,
    outsetPixels = roomShellOutsetPixels,
  ): { a: Phaser.Math.Vector2; b: Phaser.Math.Vector2 } {
    const { a, b } = this.getBoundaryRunEndpoints(run);
    const outward = this.getBoundaryOutwardOffset(run, outsetPixels);
    return {
      a: a.clone().add(outward),
      b: b.clone().add(outward),
    };
  }

  private getBoundaryOutwardOffset(run: BoundaryRun, pixels: number): Phaser.Math.Vector2 {
    const sample = this.getBoundaryRunCameraSample(run);
    const outward = sample.outside.clone().subtract(sample.inside);
    if (outward.lengthSq() === 0) {
      return new Phaser.Math.Vector2(0, 0);
    }

    return outward.normalize().scale(pixels);
  }

  private isBoundaryRunNearCamera(run: BoundaryRun): boolean {
    const sample = this.getBoundaryRunCameraSample(run);
    return sample.outside.y > sample.inside.y + 0.5;
  }

  private isEntranceEdgeNearCamera(): boolean {
    return this.isBoundaryRunNearCamera({ side: "south", fixed: 8, start: 6, end: 7 });
  }

  private getBoundaryRunCameraSample(run: BoundaryRun): { inside: Phaser.Math.Vector2; outside: Phaser.Math.Vector2 } {
    const middle = (run.start + run.end + 1) / 2;

    if (run.side === "north") {
      return {
        inside: this.grid.gridToWorld({ x: middle, y: run.fixed + 0.5 }),
        outside: this.grid.gridToWorld({ x: middle, y: run.fixed - 0.5 }),
      };
    }

    if (run.side === "south") {
      return {
        inside: this.grid.gridToWorld({ x: middle, y: run.fixed + 0.5 }),
        outside: this.grid.gridToWorld({ x: middle, y: run.fixed + 1.5 }),
      };
    }

    if (run.side === "west") {
      return {
        inside: this.grid.gridToWorld({ x: run.fixed + 0.5, y: middle }),
        outside: this.grid.gridToWorld({ x: run.fixed - 0.5, y: middle }),
      };
    }

    return {
      inside: this.grid.gridToWorld({ x: run.fixed + 0.5, y: middle }),
      outside: this.grid.gridToWorld({ x: run.fixed + 1.5, y: middle }),
    };
  }

  private getWallPlacementTarget(
    definition: FurnitureDefinition,
    point: Phaser.Math.Vector2,
  ): WallPlacementTarget | null {
    if (this.isDoorFurniture(definition.id)) {
      return this.getEntranceDoorPlacementTarget(point);
    }

    const cells = this.getUnlockedExpansionCells();
    const cellKeys = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    const entranceCells = this.isWallFinishFurniture(definition.id) ? new Set<string>() : new Set(["6,8", "7,8"]);
    const span = Math.max(1, definition.size.width);
    const wallHeight = 134;

    const candidates = this.getBoundaryRuns(cells, cellKeys, entranceCells)
      .filter((run) => !this.isBoundaryRunNearCamera(run))
      .filter((run) => run.end - run.start + 1 >= span)
      .map((run) => {
        const { a, b } = this.getVisualBoundaryRunEndpoints(run);
        const topA = new Phaser.Math.Vector2(a.x, a.y - wallHeight);
        const topB = new Phaser.Math.Vector2(b.x, b.y - wallHeight);
        const wallPanel = [topA, topB, b, a];
        const distance = this.getPointToPolygonDistance(point, wallPanel);
        const segment = b.clone().subtract(a);
        const segmentLengthSq = Math.max(1, segment.lengthSq());
        const rawRatio = Phaser.Math.Clamp(point.clone().subtract(a).dot(segment) / segmentLengthSq, 0, 1);
        const logicalRatio = run.side === "south" || run.side === "west" ? 1 - rawRatio : rawRatio;
        const runLength = run.end - run.start + 1;
        const centeredVariable = run.start + logicalRatio * runLength;
        const slotStart = Phaser.Math.Clamp(
          Math.round(centeredVariable - span / 2),
          run.start,
          run.end - span + 1,
        );
        return {
          side: run.side,
          position: this.getWallSlotPosition(run, slotStart),
          rotation: this.getWallRotationForSide(run.side),
          span,
          distance,
        };
      })
      .sort((a, b) => a.distance - b.distance);

    const best = candidates[0];
    if (!best || best.distance > 74) {
      return null;
    }

    return best;
  }

  private getEntranceDoorPlacementTarget(point: Phaser.Math.Vector2): WallPlacementTarget | null {
    const { a: right, b: left } = this.getVisualBoundaryRunEndpoints({ side: "south", fixed: 8, start: 6, end: 7 });
    const wallHeight = 134;
    const openingLeftT = 0.18;
    const openingRightT = 0.82;
    const pointAt = (ratio: number, yOffset = 0): Phaser.Math.Vector2 => {
      const base = this.lerpPoint(left, right, ratio);
      return new Phaser.Math.Vector2(base.x, base.y + yOffset);
    };
    const doorPanel = [
      pointAt(openingLeftT, -wallHeight),
      pointAt(openingRightT, -wallHeight),
      pointAt(openingRightT, 10),
      pointAt(openingLeftT, 10),
    ];
    const distance = this.getPointToPolygonDistance(point, doorPanel);
    if (distance > 96) {
      return null;
    }

    return {
      side: "south",
      position: this.getEntranceDoorSlotPosition(),
      rotation: 180,
      span: 2,
      distance,
    };
  }

  private getEntranceDoorSlotPosition(): GridPosition {
    return { x: 6, y: 8 };
  }

  private getEntranceDoorItem(): PlacedFurniture | null {
    return this.placement
      .getFurniture()
      .filter((item) => this.isDoorFurniture(item.furnitureId))
      .sort((a, b) => this.getFurnitureLuxuryTier(getFurnitureDefinition(b.furnitureId)) - this.getFurnitureLuxuryTier(getFurnitureDefinition(a.furnitureId)))[0] ?? null;
  }

  private getEntranceDoorDefinition(): FurnitureDefinition {
    const installedDoor = this.getEntranceDoorItem();
    return installedDoor ? getFurnitureDefinition(installedDoor.furnitureId) : getFurnitureDefinition("plain-door");
  }

  private getWallSlotPosition(run: BoundaryRun, slotStart: number): GridPosition {
    if (run.side === "north" || run.side === "south") {
      return { x: slotStart, y: run.fixed };
    }

    return { x: run.fixed, y: slotStart };
  }

  private getWallRotationForSide(side: BoundarySide): number {
    if (side === "east") {
      return 90;
    }
    if (side === "south") {
      return 180;
    }
    if (side === "west") {
      return 270;
    }
    return 0;
  }

  private isWallDecorationOnHiddenWall(item: PlacedFurniture, definition = getFurnitureDefinition(item.furnitureId)): boolean {
    const side = this.getWallDecorationLogicalSide(item);
    if (!side) {
      return false;
    }

    return this.isBoundaryRunNearCamera(this.getWallDecorationBoundaryRun(item, definition, side));
  }

  private getWallDecorationLogicalSide(item: PlacedFurniture): BoundarySide | null {
    const definition = getFurnitureDefinition(item.furnitureId);
    if (definition.category !== "wallDecoration") {
      return null;
    }

    const rotationSide = this.getWallSideForRotation(item.rotation ?? 0);
    if (this.isBoundaryRunOnExteriorWall(this.getWallDecorationBoundaryRun(item, definition, rotationSide))) {
      return rotationSide;
    }

    const position = item.position;
    if (!this.isGridPositionUnlocked({ x: position.x, y: position.y - 1 })) {
      return "north";
    }
    if (!this.isGridPositionUnlocked({ x: position.x - 1, y: position.y })) {
      return "west";
    }
    if (!this.isGridPositionUnlocked({ x: position.x + 1, y: position.y })) {
      return "east";
    }
    if (!this.isGridPositionUnlocked({ x: position.x, y: position.y + 1 })) {
      return "south";
    }

    return rotationSide;
  }

  private getWallSideForRotation(rotation: number): BoundarySide {
    const normalizedRotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
    if (normalizedRotation === 90) {
      return "east";
    }
    if (normalizedRotation === 180) {
      return "south";
    }
    if (normalizedRotation === 270) {
      return "west";
    }
    return "north";
  }

  private isWallMountedFurniture(definition: FurnitureDefinition): boolean {
    return definition.category === "wallDecoration";
  }

  private getExteriorWallRuns(): BoundaryRun[] {
    const cells = this.getUnlockedExpansionCells();
    const cellKeys = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
    const entranceCells = new Set(["6,8", "7,8"]);
    return this.getBoundaryRuns(cells, cellKeys, entranceCells);
  }

  private getProjectedWallMountedTarget(item: PlacedFurniture, definition: FurnitureDefinition): WallPlacementTarget | null {
    if (!this.isWallMountedFurniture(definition)) {
      return null;
    }

    if (this.isDoorFurniture(definition.id)) {
      return {
        side: "south",
        position: this.getEntranceDoorSlotPosition(),
        rotation: 180,
        span: Math.max(1, definition.size.width),
        distance: 0,
      };
    }

    const side = this.getWallDecorationLogicalSide(item) ?? this.getWallSideForRotation(item.rotation ?? 0);
    const span = Math.max(1, definition.size.width);
    const axis = side === "north" || side === "south" ? item.position.x : item.position.y;
    const fixedAxis = side === "north" || side === "south" ? item.position.y : item.position.x;
    const candidates = this.getExteriorWallRuns()
      .filter((run) => run.side === side && run.end - run.start + 1 >= span)
      .map((run) => {
        const maxStart = run.end - span + 1;
        const slotStart = Phaser.Math.Clamp(Math.round(axis), run.start, maxStart);
        const withinDistance = axis < run.start ? run.start - axis : axis > maxStart ? axis - maxStart : 0;
        const fixedDistance = Math.abs(run.fixed - fixedAxis) * 0.15;
        return {
          side,
          position: this.getWallSlotPosition(run, slotStart),
          rotation: this.getWallRotationForSide(side),
          span,
          distance: withinDistance + fixedDistance,
        };
      })
      .sort((a, b) => a.distance - b.distance);

    return candidates[0] ?? null;
  }

  private isBoundaryRunOnExteriorWall(run: BoundaryRun): boolean {
    return this.getExteriorWallRuns().some(
      (exterior) =>
        exterior.side === run.side &&
        exterior.fixed === run.fixed &&
        run.start <= exterior.end &&
        run.end >= exterior.start,
    );
  }

  private getWallMountedRenderItem(item: PlacedFurniture, definition = getFurnitureDefinition(item.furnitureId)): PlacedFurniture {
    const target = this.getProjectedWallMountedTarget(item, definition);
    if (!target) {
      return item;
    }

    if (
      target.position.x === item.position.x &&
      target.position.y === item.position.y &&
      target.rotation === (item.rotation ?? 0)
    ) {
      return item;
    }

    return {
      ...item,
      position: target.position,
      rotation: target.rotation,
    };
  }

  private normalizeWallMountedFurnitureToCurrentWalls(): void {
    const furniture = this.placement.getFurniture();
    let changed = false;
    const normalized = furniture.map((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      const renderItem = this.getWallMountedRenderItem(item, definition);
      if (
        renderItem.position.x !== item.position.x ||
        renderItem.position.y !== item.position.y ||
        (renderItem.rotation ?? 0) !== (item.rotation ?? 0)
      ) {
        changed = true;
      }

      return renderItem;
    });

    const doorItems = normalized
      .filter((item) => this.isDoorFurniture(item.furnitureId))
      .sort((a, b) => this.getFurnitureLuxuryTier(getFurnitureDefinition(b.furnitureId)) - this.getFurnitureLuxuryTier(getFurnitureDefinition(a.furnitureId)));
    const keptDoorUid = doorItems[0]?.uid ?? null;
    const normalizedWithSingleDoor = normalized.filter((item) => !this.isDoorFurniture(item.furnitureId) || item.uid === keptDoorUid);
    if (normalizedWithSingleDoor.length !== normalized.length) {
      changed = true;
    }

    if (changed) {
      this.placement.setFurniture(normalizedWithSingleDoor);
      this.diningSeatsCacheKey = "";
      this.pathDistanceCache.clear();
    }
  }

  private getWallDecorationBoundaryRun(
    item: PlacedFurniture,
    definition: FurnitureDefinition,
    side: BoundarySide,
  ): BoundaryRun {
    const size = this.grid.getRotatedSize(definition, item.rotation ?? 0);
    if (side === "north" || side === "south") {
      return {
        side,
        fixed: item.position.y,
        start: item.position.x,
        end: item.position.x + size.width - 1,
      };
    }

    return {
      side,
      fixed: item.position.x,
      start: item.position.y,
      end: item.position.y + size.height - 1,
    };
  }

  private drawIsoWallPlane(
    graphics: Phaser.GameObjects.Graphics,
    a: Phaser.Math.Vector2,
    b: Phaser.Math.Vector2,
    height: number,
    fill: number,
    stroke: number,
  ): void {
    const topA = new Phaser.Math.Vector2(a.x, a.y - height);
    const topB = new Phaser.Math.Vector2(b.x, b.y - height);
    const capLift = 12;
    const capA = new Phaser.Math.Vector2(topA.x, topA.y - capLift);
    const capB = new Phaser.Math.Vector2(topB.x, topB.y - capLift);
    graphics.fillStyle(0x3f2d24, 0.1);
    graphics.fillPoints([
      new Phaser.Math.Vector2(topA.x + 7, topA.y + 8),
      new Phaser.Math.Vector2(topB.x + 7, topB.y + 8),
      new Phaser.Math.Vector2(b.x + 7, b.y + 8),
      new Phaser.Math.Vector2(a.x + 7, a.y + 8),
    ], true);
    graphics.fillStyle(0xe7dac9, 1);
    graphics.fillPoints([capA, capB, topB, topA], true);
    graphics.lineStyle(2, 0xc2af99, 0.95);
    graphics.strokePoints([capA, capB, topB, topA], true);
    graphics.fillStyle(fill, 1);
    graphics.fillPoints([topA, topB, b, a], true);
    graphics.lineStyle(3, stroke, 1);
    graphics.strokePoints([topA, topB, b, a], true);
    graphics.lineStyle(8, 0xddcfbe, 1);
    graphics.lineBetween(a.x, a.y, b.x, b.y);
    graphics.lineStyle(3, 0xbca890, 1);
    graphics.lineBetween(a.x, a.y - 7, b.x, b.y - 7);
  }

  private drawIsoLowFrontWall(
    graphics: Phaser.GameObjects.Graphics,
    a: Phaser.Math.Vector2,
    b: Phaser.Math.Vector2,
    height: number,
    fill: number,
    stroke: number,
  ): void {
    const bottomA = new Phaser.Math.Vector2(a.x, a.y + height);
    const bottomB = new Phaser.Math.Vector2(b.x, b.y + height);
    graphics.fillStyle(fill, 1);
    graphics.fillPoints([a, b, bottomB, bottomA], true);
    graphics.lineStyle(3, stroke, 1);
    graphics.strokePoints([a, b, bottomB, bottomA], true);
    graphics.lineStyle(6, 0xddcfbe, 1);
    graphics.lineBetween(a.x, a.y, b.x, b.y);
  }

  private drawIsoTransparentFrontWall(
    graphics: Phaser.GameObjects.Graphics,
    a: Phaser.Math.Vector2,
    b: Phaser.Math.Vector2,
    height: number,
    fill: number,
    stroke: number,
  ): void {
    const bottomA = new Phaser.Math.Vector2(a.x, a.y + height);
    const bottomB = new Phaser.Math.Vector2(b.x, b.y + height);
    const baseA = this.lerpPoint(a, bottomA, 0.5);
    const baseB = this.lerpPoint(b, bottomB, 0.5);
    graphics.fillStyle(fill, 0.1);
    graphics.fillPoints([a, b, bottomB, bottomA], true);
    graphics.fillStyle(0xf3ead9, 0.24);
    graphics.fillPoints([baseA, baseB, bottomB, bottomA], true);
    graphics.lineStyle(2, stroke, 0.42);
    graphics.strokePoints([a, b, bottomB, bottomA], true);
    graphics.lineStyle(5, 0xffffff, 0.5);
    graphics.lineBetween(a.x, a.y, b.x, b.y);
    graphics.lineStyle(3, 0xddcfbe, 0.36);
    graphics.lineBetween(baseA.x, baseA.y - 2, baseB.x, baseB.y - 2);
    graphics.lineStyle(2, 0xbca890, 0.42);
    graphics.lineBetween(bottomA.x, bottomA.y - 4, bottomB.x, bottomB.y - 4);
  }

  private drawStreetView(): void {
    this.streetLayer.removeAll(true);

    const background = this.add.graphics();
    background.fillStyle(0xbfd7aa, 1);
    background.fillRect(mapViewport.x, mapViewport.y, mapViewport.width, mapViewport.height);
    background.fillStyle(0x9fbf88, 1);
    for (let x = mapViewport.x; x < mapViewport.x + mapViewport.width; x += 42) {
      for (let y = mapViewport.y; y < mapViewport.y + mapViewport.height; y += 42) {
        background.lineStyle(1, 0x8eaa76, 0.55);
        background.strokeRect(x, y, 40, 40);
      }
    }

    background.fillStyle(0x6f6a62, 1);
    background.fillRect(mapViewport.x, mapViewport.y + 300, mapViewport.width, 138);
    background.fillStyle(0xddd0aa, 1);
    background.fillRect(mapViewport.x, mapViewport.y + 364, mapViewport.width, 8);
    for (let x = mapViewport.x + 36; x < mapViewport.x + mapViewport.width; x += 110) {
      background.fillRect(x, mapViewport.y + 368, 52, 4);
    }

    background.fillStyle(0xe7d2a5, 1);
    background.fillRect(mapViewport.x, mapViewport.y + 250, mapViewport.width, 34);
    background.fillRect(mapViewport.x, mapViewport.y + 454, mapViewport.width, 34);
    this.streetLayer.add(background);

    this.drawOtherRestaurantFacade(470, 214, "Future Bistro", 0x8aa3a0);
    this.drawOtherRestaurantFacade(880, 214, "Online Cafe", 0xb98a6a);
    this.drawOtherRestaurantFacade(1095, 556, "Friend's Place", 0x9d8fbd);
    this.drawPlayerRestaurantFacade();

    const hint = this.add.text(mapViewport.x + mapViewport.width / 2, mapViewport.y + mapViewport.height - 34, "Street view: click your restaurant to go back inside. Future multiplayer restaurants will appear across the street.", {
      color: "#3b2a21",
      backgroundColor: "#fff8e8",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "14px",
      padding: { x: 10, y: 6 },
    }).setOrigin(0.5);
    this.streetLayer.add(hint);
  }

  private drawOtherRestaurantFacade(x: number, y: number, name: string, color: number): void {
    const facade = this.add.graphics();
    facade.fillStyle(color, 1);
    facade.fillRoundedRect(x, y, 180, 112, 6);
    facade.fillStyle(0x6e4d3e, 1);
    facade.fillRect(x - 8, y + 96, 196, 12);
    facade.fillStyle(0xf8e0a8, 1);
    facade.fillRect(x + 18, y + 24, 44, 38);
    facade.fillRect(x + 118, y + 24, 44, 38);
    facade.fillStyle(0x4b352c, 1);
    facade.fillRect(x + 74, y + 52, 34, 56);
    const label = this.add.text(x + 90, y + 126, name, {
      color: "#3b2a21",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "13px",
      fontStyle: "bold",
      backgroundColor: "#fff8e8",
      padding: { x: 6, y: 3 },
    }).setOrigin(0.5);
    this.streetLayer.add([facade, label]);
  }

  private drawPlayerRestaurantFacade(): void {
    const x = mapViewport.x + mapViewport.width / 2 - 150;
    const y = mapViewport.y + 492;
    const facade = this.add.graphics();
    facade.fillStyle(0xc8865c, 1);
    facade.fillRoundedRect(x, y, 300, 148, 8);
    facade.fillStyle(0xf3c98a, 1);
    facade.fillRect(x + 18, y + 18, 264, 44);
    facade.fillStyle(0x6e4d3e, 1);
    facade.fillRect(x - 14, y + 136, 328, 16);
    facade.fillStyle(0xfff1c9, 1);
    facade.fillRect(x + 38, y + 78, 58, 42);
    facade.fillRect(x + 204, y + 78, 58, 42);
    facade.fillStyle(0x4b352c, 1);
    facade.fillRect(x + 126, y + 82, 48, 68);
    facade.fillStyle(0x2f3437, 1);
    facade.fillRect(x + 40, y + 28, 220, 22);
    this.streetLayer.add(facade);

    const sign = this.add.text(x + 150, y + 38, "COZY BISTRO", {
      color: "#fff4dc",
      fontFamily: "Georgia, serif",
      fontSize: "20px",
      fontStyle: "bold",
    }).setOrigin(0.5);
    const prompt = this.add.text(x + 150, y + 170, "Your restaurant - click to enter", {
      color: "#3b2a21",
      backgroundColor: "#fff8e8",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "14px",
      fontStyle: "bold",
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5);
    const hitArea = this.add.zone(x, y, 300, 170).setOrigin(0).setInteractive({ useHandCursor: true });
    hitArea.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.setMapViewMode("inside");
    });
    this.streetLayer.add([sign, prompt, hitArea]);
  }

  private createRestaurantViewportMask(): void {
    const maskGraphics = this.make.graphics({ x: 0, y: 0 }, false);
    maskGraphics.fillStyle(0xffffff, 1);
    maskGraphics.fillRect(mapViewport.x, mapViewport.y, mapViewport.width, mapViewport.height);
    this.restaurantLayer.setMask(maskGraphics.createGeometryMask());
  }

  private refreshRestaurantShellAndGrid(): void {
    this.restaurantShell?.destroy();
    this.gridGraphics?.destroy();
    this.foregroundShellLayer.removeAll(true);
    this.restaurantShell = this.drawRestaurantShell();
    this.restaurantForegroundShell = this.drawRestaurantForegroundShell();
    this.drawExteriorForegroundScene();
    this.repositionPavementTrash();
    this.updateExteriorForegroundOcclusion();
    this.gridGraphics = this.grid.draw(
      this,
      (cell) => this.isGridPositionVisible(cell),
      (cell) => this.getExpansionCellFill(cell),
    );
    this.drawGrassTileDetails(this.gridGraphics);
    this.restaurantLayer.addAt(this.gridGraphics, 0);
    this.restaurantLayer.addAt(this.expansionOverlayLayer, 1);
    this.restaurantLayer.addAt(this.restaurantShell, 2);
    this.foregroundShellLayer.add(this.restaurantForegroundShell);
  }

  private updateExteriorForegroundOcclusion(): void {
    if (!this.exteriorForegroundLayer) {
      return;
    }

    const entranceSideFacesCamera = this.isEntranceEdgeNearCamera();
    this.exteriorForegroundLayer.setVisible(this.mapViewMode === "inside" && entranceSideFacesCamera);
  }

  private setMapViewMode(mode: MapViewMode): void {
    this.mapViewMode = mode;
    const inside = mode === "inside";
    this.restaurantLayer.setVisible(inside);
    this.streetLayer.setVisible(!inside);
    this.updateExteriorForegroundOcclusion();
    this.preview.setVisible(false);
    this.previewSprite.setVisible(false);
    this.previewHint.setVisible(false);
    this.hideTooltip();
    this.setTextIfChanged(this.streetButton, inside ? "Go to street" : "Go inside");
    this.updateStats(inside ? "Back inside your restaurant" : "Street view");
  }

  private getVisibleExpansionBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const cells = this.getVisibleExpansionCells();
    return {
      minX: Math.min(...cells.map((cell) => cell.x)),
      minY: Math.min(...cells.map((cell) => cell.y)),
      maxX: Math.max(...cells.map((cell) => cell.x)),
      maxY: Math.max(...cells.map((cell) => cell.y)),
    };
  }

  private getExpansionCellFill(position: GridPosition): number {
    if (!this.isGridPositionUnlocked(position)) {
      return 0xb9d49a;
    }

    return 0xfff4dc;
  }

  private drawGrassTileDetails(graphics: Phaser.GameObjects.Graphics): void {
    for (let y = this.grid.minY; y <= this.grid.maxY; y += 1) {
      for (let x = this.grid.minX; x <= this.grid.maxX; x += 1) {
        const cell = { x, y };
        if (!this.isGridPositionVisible(cell) || this.isGridPositionUnlocked(cell)) {
          continue;
        }

        this.drawSingleGrassTileDetails(graphics, cell, this.grid.getCellDiamond(cell));
      }
    }
  }

  private drawSingleGrassTileDetails(
    graphics: Phaser.GameObjects.Graphics,
    cell: GridPosition,
    diamond: Phaser.Math.Vector2[],
  ): void {
    const center = this.getPolygonCenter(diamond);
    const inner = this.insetPolygon(diamond, 0.12);

    graphics.fillStyle(0xc7dfaa, 0.18);
    graphics.fillPoints(inner, true);
    graphics.lineStyle(1, 0x6f965c, 0.18);
    graphics.lineBetween(
      this.lerpPoint(diamond[3], diamond[0], 0.48).x,
      this.lerpPoint(diamond[3], diamond[0], 0.48).y,
      this.lerpPoint(diamond[2], diamond[1], 0.48).x,
      this.lerpPoint(diamond[2], diamond[1], 0.48).y,
    );

    const clumpCount = this.seededCellUnit(cell, 3) > 0.7 ? 4 : 3;
    for (let index = 0; index < clumpCount; index += 1) {
      const u = 0.18 + this.seededCellUnit(cell, index * 7 + 11) * 0.64;
      const v = 0.22 + this.seededCellUnit(cell, index * 7 + 17) * 0.58;
      const base = this.getPointInTileDiamond(diamond, u, v);
      const scale = 0.75 + this.seededCellUnit(cell, index * 7 + 23) * 0.55;
      this.drawGrassClump(graphics, base, scale, this.seededCellUnit(cell, index * 7 + 31));
    }

    if (this.seededCellUnit(cell, 41) > 0.72) {
      const leafPoint = this.getPointInTileDiamond(diamond, 0.32 + this.seededCellUnit(cell, 43) * 0.36, 0.36 + this.seededCellUnit(cell, 47) * 0.24);
      graphics.fillStyle(0x86b65f, 0.5);
      graphics.fillEllipse(leafPoint.x, leafPoint.y - 1, 9, 4);
      graphics.fillStyle(0xf0d889, 0.38);
      graphics.fillCircle(leafPoint.x + 3, leafPoint.y - 3, 2);
    }

    graphics.fillStyle(0x5f7f4f, 0.08);
    graphics.fillEllipse(center.x + 6, center.y + 10, 28, 6);
  }

  private drawGrassClump(
    graphics: Phaser.GameObjects.Graphics,
    base: Phaser.Math.Vector2,
    scale: number,
    seed: number,
  ): void {
    graphics.fillStyle(0x405f35, 0.12);
    graphics.fillEllipse(base.x + 2, base.y + 3, 13 * scale, 4 * scale);

    const bladeColors = [0x4f8140, 0x6fa35a, 0x8ebe6f];
    const bladeCount = 4 + Math.floor(seed * 3);
    for (let index = 0; index < bladeCount; index += 1) {
      const spread = (index - (bladeCount - 1) / 2) * 2.5 * scale;
      const lean = (seed - 0.5) * 4 + (index % 2 === 0 ? -1 : 1) * 2;
      const height = (7 + (index % 3) * 2) * scale;
      const start = new Phaser.Math.Vector2(base.x + spread * 0.45, base.y + Math.abs(spread) * 0.08);
      const tip = new Phaser.Math.Vector2(base.x + spread + lean, base.y - height);
      const color = bladeColors[index % bladeColors.length];

      graphics.lineStyle(Math.max(1, Math.round(1.4 * scale)), color, 0.78);
      graphics.lineBetween(start.x, start.y, tip.x, tip.y);

      if (index % 2 === 0) {
        const mid = this.lerpPoint(start, tip, 0.55);
        graphics.fillStyle(this.shadeColor(color, 16), 0.68);
        graphics.fillPoints(
          [
            new Phaser.Math.Vector2(mid.x, mid.y - 1 * scale),
            new Phaser.Math.Vector2(mid.x + 4 * scale, mid.y + 1 * scale),
            new Phaser.Math.Vector2(start.x + 1 * scale, start.y + 1 * scale),
          ],
          true,
        );
      }
    }
  }

  private getPointInTileDiamond(
    diamond: Phaser.Math.Vector2[],
    horizontal: number,
    vertical: number,
  ): Phaser.Math.Vector2 {
    const left = this.lerpPoint(diamond[3], diamond[0], vertical);
    const right = this.lerpPoint(diamond[2], diamond[1], vertical);
    return this.lerpPoint(left, right, horizontal);
  }

  private seededCellUnit(cell: GridPosition, salt: number): number {
    const raw = Math.imul(cell.x + 32768, 73856093) ^ Math.imul(cell.y + 32768, 19349663) ^ Math.imul(salt + 101, 83492791);
    return ((raw >>> 0) % 10000) / 10000;
  }

  private applySceneDepths(): void {
    this.children.list.forEach((child) => {
      if (child === this.restaurantLayer) {
        (child as Phaser.GameObjects.GameObject & { setDepth: (depth: number) => void }).setDepth(mapDepth);
        return;
      }

      if (child === this.streetLayer) {
        (child as Phaser.GameObjects.GameObject & { setDepth: (depth: number) => void }).setDepth(mapDepth + 1);
        return;
      }

      const gameObject = child as Phaser.GameObjects.GameObject & {
        getData?: (key: string) => unknown;
        setDepth?: (depth: number) => void;
      };
      if (!gameObject.setDepth) {
        return;
      }

      if (gameObject.getData?.("background")) {
        gameObject.setDepth(backgroundDepth);
        return;
      }

      const currentDepth = (gameObject as Phaser.GameObjects.GameObject & { depth?: number }).depth ?? 0;
      gameObject.setDepth(currentDepth > uiDepth ? currentDepth : uiDepth);
    });
  }

  private frameRestaurantMap(): void {
    // Include the rotated street/sidewalk area in the bounds we frame so the
    // camera leaves room for pedestrians at any view rotation. Without this
    // we use room-only bounds, and after 90/180 rotation the logical-south
    // edge (which holds the street) lands outside the framed viewport.
    const cellPoints = this.getVisibleExpansionCells().flatMap((cell) => this.grid.getCellDiamond(cell));
    const streetEdgePoints = this.getStreetEdgeSamplePoints();
    const allPoints = cellPoints.concat(streetEdgePoints);
    const bounds = this.getPointBounds(allPoints);
    const fitPaddingX = 220;
    const fitPaddingY = 190;
    const worldWidth = bounds.maxX - bounds.minX;
    const worldHeight = (bounds.maxY - bounds.minY) * restaurantCameraYScale;
    const zoom = Phaser.Math.Clamp(
      Math.min(
        mapViewport.width / Math.max(1, worldWidth + fitPaddingX),
        mapViewport.height / Math.max(1, worldHeight + fitPaddingY * 2),
      ),
      restaurantZoomMin,
      0.62,
    );
    const worldCenter = new Phaser.Math.Vector2(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
    );
    const viewCenter = new Phaser.Math.Vector2(mapViewport.x + mapViewport.width / 2, mapViewport.y + mapViewport.height / 2);

    this.restaurantZoom = zoom;
    this.applyRestaurantCameraTransform(worldCenter, viewCenter);
    if (this.zoomText) {
      this.setTextIfChanged(this.zoomText, `${Math.round(this.restaurantZoom * 100)}%`);
    }
  }

  private getIsoBounds(cells: GridPosition[]): { minX: number; minY: number; maxX: number; maxY: number } {
    const points = cells.flatMap((cell) => this.grid.getCellDiamond(cell));
    return this.getPointBounds(points);
  }

  private getPointBounds(points: Phaser.Math.Vector2[]): { minX: number; minY: number; maxX: number; maxY: number } {
    if (points.length === 0) {
      return { minX: 0, minY: 0, maxX: this.grid.tileSize, maxY: this.grid.tileHeight };
    }

    return {
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    };
  }

  private getStreetEdgeSamplePoints(): Phaser.Math.Vector2[] {
    // Returns sample points covering the entire street + pedestrian sidewalk
    // strip on whichever side the logical-south boundary maps to under the
    // current view rotation. Used by the framing math so the camera leaves
    // room for the street and any pedestrians walking along it, regardless of
    // view rotation. Pedestrians spawn at extended route ends 120px past the
    // boundary endpoints, so we also include those extended positions.
    const bounds = this.getUnlockedExpansionBounds();
    const frontRun: BoundaryRun = {
      side: "south",
      fixed: bounds.maxY,
      start: bounds.minX - 3,
      end: bounds.maxX + 2,
    };
    const { a, b } = this.getVisualBoundaryRunEndpoints(frontRun, roomShellOutsetPixels + 8);
    const outward = this.getBoundaryOutwardOffset(frontRun, 1);
    if (outward.lengthSq() === 0) {
      return [];
    }
    const along = b.clone().subtract(a);
    if (along.lengthSq() === 0) {
      return [];
    }

    // Match drawExteriorStreetScene's roadOuter (206) plus a margin so the
    // outer edge of the road has breathing room around it.
    const roadOuter = 206;
    const margin = 40;
    const outOffset = outward.clone().scale(roadOuter + margin);
    const alongUnit = along.clone().normalize();
    const routeExtension = alongUnit.clone().scale(140);

    // Sample the four "outer corners" of the road + sidewalk strip: each
    // boundary endpoint pushed outward, extended along the street, in both
    // directions. Covers the full visible span of pedestrian motion.
    return [
      a.clone().add(outOffset).subtract(routeExtension),
      a.clone().subtract(routeExtension),
      b.clone().add(outOffset).add(routeExtension),
      b.clone().add(routeExtension),
    ];
  }

  private applyRestaurantCameraTransform(worldCenter: Phaser.Math.Vector2, viewCenter: Phaser.Math.Vector2): void {
    const centerOffset = this.getRestaurantWorldScreenOffset(worldCenter, this.restaurantZoom);
    this.restaurantLayer.setRotation(0);
    this.restaurantLayer.setScale(this.restaurantZoom, this.restaurantZoom * restaurantCameraYScale);
    this.restaurantLayer.setPosition(
      viewCenter.x - centerOffset.x,
      viewCenter.y - centerOffset.y,
    );
    this.updateRestaurantReadableTextRotation();
  }

  private getRestaurantViewRotationRadians(): number {
    return 0;
  }

  private getRestaurantWorldScreenOffset(worldPoint: Phaser.Math.Vector2, zoom = this.restaurantZoom): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2(worldPoint.x * zoom, worldPoint.y * zoom * restaurantCameraYScale);
  }

  private getRestaurantScreenPositionToWorld(screenX: number, screenY: number): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2(
      (screenX - this.restaurantLayer.x) / this.restaurantZoom,
      (screenY - this.restaurantLayer.y) / (this.restaurantZoom * restaurantCameraYScale),
    );
  }

  private updateRestaurantReadableTextRotation(): void {
    if (!this.restaurantLayer) {
      return;
    }

    const inverseRotation = -this.getRestaurantViewRotationRadians();
    const visit = (gameObject: Phaser.GameObjects.GameObject): void => {
      if (gameObject instanceof Phaser.GameObjects.Text) {
        gameObject.setRotation(inverseRotation);
      }

      if (gameObject instanceof Phaser.GameObjects.Container) {
        gameObject.list.forEach((child) => visit(child as Phaser.GameObjects.GameObject));
      }
    };

    this.restaurantLayer.list.forEach((child) => visit(child as Phaser.GameObjects.GameObject));
  }

  private getUnlockedExpansionBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const cells = this.getUnlockedExpansionCells();
    return {
      minX: Math.min(...cells.map((cell) => cell.x)),
      minY: Math.min(...cells.map((cell) => cell.y)),
      maxX: Math.max(...cells.map((cell) => cell.x)),
      maxY: Math.max(...cells.map((cell) => cell.y)),
    };
  }

  private hydrateAdminSettings(settings?: AdminSettings): Required<AdminSettings> {
    return {
      payrollPerStaffPerMinute: Phaser.Math.Clamp(
        Math.round(settings?.payrollPerStaffPerMinute ?? defaultPayrollPerStaffPerMinute),
        0,
        100,
      ),
      ingredientUnitCost: Phaser.Math.Clamp(
        Math.round(settings?.ingredientUnitCost ?? defaultIngredientUnitCost),
        1,
        250,
      ),
      starterRecipeProfit: Phaser.Math.Clamp(
        Math.round(settings?.starterRecipeProfit ?? defaultStarterRecipeProfit),
        0,
        1000,
      ),
      itemCostMultiplier: Phaser.Math.Clamp(
        Math.round((settings?.itemCostMultiplier ?? defaultItemCostMultiplier) * 10) / 10,
        0.1,
        10,
      ),
      baseDailyRent: Phaser.Math.Clamp(
        Math.round(settings?.baseDailyRent ?? defaultBaseDailyRent),
        0,
        1000000,
      ),
      rentPerExpansion: Phaser.Math.Clamp(
        Math.round(settings?.rentPerExpansion ?? defaultRentPerExpansion),
        0,
        1000000,
      ),
      firstExpansionCost: Phaser.Math.Clamp(
        Math.round(settings?.firstExpansionCost ?? defaultFirstExpansionCost),
        0,
        10000000,
      ),
      expansionCostMultiplier: Phaser.Math.Clamp(
        Math.round((settings?.expansionCostMultiplier ?? defaultExpansionCostMultiplier) * 100) / 100,
        1,
        20,
      ),
      trashDropChance: Phaser.Math.Clamp(
        Math.round((settings?.trashDropChance ?? defaultTrashDropChance) * 100) / 100,
        0,
        1,
      ),
    };
  }

  private getIngredientUnitCost(): number {
    return this.adminSettings.ingredientUnitCost;
  }

  private getStarterRecipeProfit(): number {
    return this.adminSettings.starterRecipeProfit;
  }

  private getFurniturePurchaseCost(definition: FurnitureDefinition): number {
    return Math.max(0, Math.round(definition.cost * this.adminSettings.itemCostMultiplier));
  }

  private getPayrollPerStaffPerMinute(): number {
    return this.adminSettings.payrollPerStaffPerMinute;
  }

  private getTrashDropChance(): number {
    return this.adminSettings.trashDropChance;
  }

  private formatItemCostMultiplier(): string {
    return `${Math.round(this.adminSettings.itemCostMultiplier * 100)}%`;
  }

  private formatExpansionCostMultiplier(): string {
    return `${this.adminSettings.expansionCostMultiplier}x`;
  }

  private formatTrashDropChance(): string {
    return `${Math.round(this.adminSettings.trashDropChance * 100)}%`;
  }

  private hydrateExpansionLevel(save: SaveGameState | null, furniture: PlacedFurniture[]): number {
    if (typeof save?.expansionLevel === "number") {
      return Phaser.Math.Clamp(Math.floor(save.expansionLevel), starterExpansionLevel, maxExpansionLevel);
    }

    if (save) {
      return legacyExpansionLevel;
    }

    const hasFurnitureOutsideStarter = furniture.some((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      return this.grid
        .getOccupiedCells(definition, item.position, item.rotation ?? 0)
        .some((cell) => !this.isStarterCell(cell));
    });
    return hasFurnitureOutsideStarter ? legacyExpansionLevel : starterExpansionLevel;
  }

  private getExpansionDefinitions(): ExpansionDefinition[] {
    return [
      {
        level: 1,
        name: "North Room",
        kind: "interior",
        direction: "north",
        cells: this.getRectCells(0, 0, 10, 3),
        signPosition: { x: 4, y: 1 },
      },
      {
        level: 2,
        name: "Right Room",
        kind: "interior",
        direction: "right",
        cells: this.getRectCells(10, 0, 4, 9),
        signPosition: { x: 11, y: 4 },
      },
      {
        level: 3,
        name: "Left Room",
        kind: "interior",
        direction: "left",
        cells: this.getRectCells(-4, 0, 4, 9),
        signPosition: { x: -3, y: 4 },
      },
      {
        level: 4,
        name: "North Room",
        kind: "interior",
        direction: "north",
        cells: this.getRectCells(-4, -4, 18, 4),
        signPosition: { x: 4, y: -2 },
      },
      {
        level: 5,
        name: "Garden Yard",
        kind: "yard",
        direction: "right",
        cells: this.getRectCells(14, -4, 4, 13),
        signPosition: { x: 15, y: 2 },
      },
      {
        level: 6,
        name: "Left Room",
        kind: "interior",
        direction: "left",
        cells: this.getRectCells(-8, -4, 4, 13),
        signPosition: { x: -7, y: 2 },
      },
      {
        level: 7,
        name: "North Room",
        kind: "interior",
        direction: "north",
        cells: this.getRectCells(-8, -8, 26, 4),
        signPosition: { x: 4, y: -6 },
      },
      {
        level: 8,
        name: "Garden Yard",
        kind: "yard",
        direction: "right",
        cells: this.getRectCells(18, -8, 4, 17),
        signPosition: { x: 19, y: 0 },
      },
    ];
  }

  private getRectCells(x: number, y: number, width: number, height: number): GridPosition[] {
    const cells: GridPosition[] = [];
    for (let yy = y; yy < y + height; yy += 1) {
      for (let xx = x; xx < x + width; xx += 1) {
        cells.push({ x: xx, y: yy });
      }
    }
    return cells;
  }

  private isStarterCell(position: GridPosition): boolean {
    return position.x >= 0 && position.x < 10 && position.y >= 3 && position.y < 9;
  }

  private isGridPositionUnlocked(position: GridPosition): boolean {
    if (this.isStarterCell(position)) {
      return true;
    }

    return this.getExpansionDefinitions()
      .filter((definition) => definition.level <= this.expansionLevel)
      .some((definition) => definition.cells.some((cell) => cell.x === position.x && cell.y === position.y));
  }

  private getVisibleExpansionCells(): GridPosition[] {
    return [
      ...this.getUnlockedExpansionCells(),
      ...this.getExpansionDefinitions()
        .filter((definition) => definition.level > this.expansionLevel)
        .flatMap((definition) => definition.cells),
    ];
  }

  private getUnlockedExpansionCells(): GridPosition[] {
    return [
      ...this.getRectCells(0, 3, 10, 6),
      ...this.getExpansionDefinitions()
        .filter((definition) => definition.level <= this.expansionLevel)
        .flatMap((definition) => definition.cells),
    ];
  }

  private isGridPositionVisible(position: GridPosition): boolean {
    return this.getVisibleExpansionCells().some((cell) => cell.x === position.x && cell.y === position.y);
  }

  private isFurnitureWithinUnlockedArea(furnitureId: string, position: GridPosition, rotation = 0): boolean {
    const definition = getFurnitureDefinition(furnitureId);
    return this.grid
      .getOccupiedCells(definition, position, rotation)
      .every((cell) => this.isGridPositionUnlocked(cell));
  }

  private getExpansionCost(level: number): number {
    const exponent = Math.max(0, level - 1);
    return Math.max(0, Math.round(this.adminSettings.firstExpansionCost * this.adminSettings.expansionCostMultiplier ** exponent));
  }

  private requestExpansionPurchase(level: number): void {
    const definition = this.getExpansionDefinitions().find((item) => item.level === level);
    if (!definition || level !== this.expansionLevel + 1) {
      return;
    }

    const cost = this.getExpansionCost(level);
    if (!this.economy.canAfford(cost)) {
      const shortfall = Math.max(0, cost - this.economy.getMoney());
      this.showToast(`Cannot afford ${definition.name}: need $${shortfall} more`, "error");
      this.updateStats(`Cannot afford ${definition.name}: need $${shortfall} more`);
      return;
    }

    this.openExpansionConfirmModal(definition);
  }

  private openExpansionConfirmModal(definition: ExpansionDefinition): void {
    this.closeExpansionConfirmModal();
    this.closeSaveModal();
    this.closeAdminModal();
    this.closeRecipeUpgradeModal();

    const cost = this.getExpansionCost(definition.level);
    const modal = this.add.container(0, 0).setDepth(3100);
    const shade = this.add
      .rectangle(gameWidth / 2, gameHeight / 2, gameWidth, gameHeight, 0x1f2528, 0.38)
      .setInteractive();
    shade.on("pointerdown", (
      _pointer: Phaser.Input.Pointer,
      _localX: number,
      _localY: number,
      event?: Phaser.Types.Input.EventData,
    ) => event?.stopPropagation());

    const panelX = 520;
    const panelY = 302;
    const panelWidth = 560;
    const panelHeight = 232;
    const panel = this.add.graphics();
    panel.fillStyle(panelFill, 1);
    panel.fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 10);
    panel.fillStyle(panelHeader, 1);
    panel.fillRoundedRect(panelX, panelY, panelWidth, 44, 10);
    panel.fillRect(panelX, panelY + 30, panelWidth, 14);
    panel.lineStyle(2, panelStroke, 1);
    panel.strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 10);

    const title = this.add.text(panelX + 24, panelY + 10, "Confirm Expansion", this.sectionTitleStyle());
    const body = this.add
      .text(
        panelX + 24,
        panelY + 66,
        `Expand ${definition.name} for $${cost}?\n\nThis spends money immediately, unlocks the next space, and moves exterior wall items to the new wall line.`,
        this.panelTextStyle(15),
      )
      .setWordWrapWidth(panelWidth - 48)
      .setLineSpacing(5);
    const cancel = this.createActionButton("Cancel", panelX + 236, panelY + 176, () => this.closeExpansionConfirmModal(), 118, 32, 14);
    const confirm = this.createActionButton(`Expand $${cost}`, panelX + 372, panelY + 176, () => {
      this.closeExpansionConfirmModal();
      this.buyExpansion(definition.level);
    }, 150, 32, 14);

    modal.add([shade, panel, title, body, cancel, confirm]);
    this.expansionConfirmModal = modal;
  }

  private closeExpansionConfirmModal(): void {
    this.expansionConfirmModal?.destroy();
    this.expansionConfirmModal = null;
  }

  private openRecipeUpgradeModal(recipeId: string): void {
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe) {
      return;
    }

    this.closeExpansionConfirmModal();
    this.closeSaveModal();
    this.closeAdminModal();
    this.closeRecipeUpgradeModal();

    const level = this.getRecipeUpgradeLevel(recipe);
    const nextLevel = Math.min(maxRecipeUpgradeLevel, level + 1);
    const upgradeCost = this.getRecipeUpgradeCost(recipe);
    const canUpgrade = this.isRecipeUnlocked(recipe) && level < maxRecipeUpgradeLevel;
    const canAfford = canUpgrade && this.canAffordRecipeUpgrade(recipe);
    const costLines = Object.entries(upgradeCost).map(([ingredientId, quantity]) => {
      const have = this.getIngredientQuantity(ingredientId);
      const enough = have >= quantity;
      return `${enough ? "✓" : "!"} ${this.getIngredientIcon(ingredientId)} ${this.getIngredientName(ingredientId)} x${quantity}  have ${have}`;
    });
    const currentPrice = this.getRecipeSellPrice(recipe);
    const currentProfit = this.getRecipeProfit(recipe);
    const currentAppeal = this.getRecipeSatisfactionEffect(recipe);
    const nextProfit = this.getRecipeProfit(recipe, nextLevel);
    const nextPrice = this.getRecipeIngredientCost(recipe) + nextProfit;
    const nextAppeal = recipe.satisfactionEffect + (nextLevel - 1) * 2;

    const modal = this.add.container(0, 0).setDepth(3120);
    const shade = this.add
      .rectangle(gameWidth / 2, gameHeight / 2, gameWidth, gameHeight, 0x1f2528, 0.38)
      .setInteractive();
    shade.on("pointerdown", (
      _pointer: Phaser.Input.Pointer,
      _localX: number,
      _localY: number,
      event?: Phaser.Types.Input.EventData,
    ) => event?.stopPropagation());

    const panelX = 520;
    const panelY = 250;
    const panelWidth = 560;
    const panelHeight = 360;
    const panel = this.add.graphics();
    panel.fillStyle(panelFill, 1);
    panel.fillRoundedRect(panelX, panelY, panelWidth, panelHeight, 10);
    panel.fillStyle(panelHeader, 1);
    panel.fillRoundedRect(panelX, panelY, panelWidth, 44, 10);
    panel.fillRect(panelX, panelY + 30, panelWidth, 14);
    panel.lineStyle(2, panelStroke, 1);
    panel.strokeRoundedRect(panelX, panelY, panelWidth, panelHeight, 10);

    const title = this.add.text(panelX + 24, panelY + 10, "Upgrade Recipe", this.sectionTitleStyle());
    const bodyText = canUpgrade
      ? [
        `${recipe.name}: level ${level} → ${nextLevel}`,
        `Price $${currentPrice} → $${nextPrice}    Profit +$${currentProfit} → +$${nextProfit}`,
        `Appeal +${currentAppeal} → +${nextAppeal}`,
        "",
        `Upgrade cost: ${level * level} of each cooking ingredient`,
        ...costLines,
      ].join("\n")
      : level >= maxRecipeUpgradeLevel
        ? `${recipe.name} is already level ${maxRecipeUpgradeLevel}.`
        : this.getLuxuryLockText(recipe.name, this.getRecipeLuxuryTier(recipe));
    const body = this.add
      .text(panelX + 24, panelY + 66, bodyText, this.panelTextStyle(15))
      .setWordWrapWidth(panelWidth - 48)
      .setLineSpacing(5);
    const cancel = this.createActionButton("Cancel", panelX + 254, panelY + 304, () => this.closeRecipeUpgradeModal(), 118, 32, 14);
    const confirm = this.createActionButton(
      canUpgrade ? `Upgrade to L${nextLevel}` : "Max Level",
      panelX + 390,
      panelY + 304,
      () => this.upgradeRecipe(recipe.id),
      150,
      32,
      14,
    );
    if (!canAfford) {
      confirm.setBackgroundColor("#8a7a64");
    }

    modal.add([shade, panel, title, body, cancel, confirm]);
    this.recipeUpgradeModal = modal;
  }

  private closeRecipeUpgradeModal(): void {
    this.recipeUpgradeModal?.destroy(true);
    this.recipeUpgradeModal = null;
  }

  private upgradeRecipe(recipeId: string): void {
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe) {
      return;
    }

    if (!this.isRecipeUnlocked(recipe)) {
      const message = this.getLuxuryLockText(recipe.name, this.getRecipeLuxuryTier(recipe));
      this.showToast(message, "error");
      this.updateStats(message);
      return;
    }

    const level = this.getRecipeUpgradeLevel(recipe);
    if (level >= maxRecipeUpgradeLevel) {
      const message = `${recipe.name} is already level ${maxRecipeUpgradeLevel}`;
      this.showToast(message, "info");
      this.updateStats(message);
      return;
    }

    const cost = this.getRecipeUpgradeCost(recipe);
    const missing = Object.entries(cost)
      .filter(([ingredientId, quantity]) => this.getIngredientQuantity(ingredientId) < quantity)
      .map(([ingredientId, quantity]) => `${this.getIngredientName(ingredientId)} x${quantity - this.getIngredientQuantity(ingredientId)}`);
    if (missing.length > 0) {
      const message = `Need ${missing.slice(0, 3).join(", ")} to upgrade ${recipe.name}`;
      this.showToast(message, "error");
      this.updateStats(message);
      this.openRecipeUpgradeModal(recipe.id);
      return;
    }

    let consumed = 0;
    Object.entries(cost).forEach(([ingredientId, quantity]) => {
      const stock = this.cooking.getPantryRaw().find((item) => item.id === ingredientId);
      if (stock) {
        stock.quantity = Math.max(0, stock.quantity - quantity);
        consumed += quantity;
      }
    });
    if (consumed > 0) {
      this.recordIngredientUse(consumed);
    }

    this.cooking.setRecipeUpgradeLevel(recipe.id, level + 1);
    this.persistQuietly();
    this.refreshCatalogUiIfReady();
    const message = `${recipe.name} upgraded to level ${level + 1}`;
    this.showToast(message, "success");
    this.updateStats(message);
    this.closeRecipeUpgradeModal();
  }

  private buyExpansion(level: number): void {
    const definition = this.getExpansionDefinitions().find((item) => item.level === level);
    if (!definition || level !== this.expansionLevel + 1) {
      return;
    }

    const cost = this.getExpansionCost(level);
    if (!this.spendMoney(cost, "decor")) {
      const shortfall = Math.max(0, cost - this.economy.getMoney());
      this.showToast(`Cannot afford ${definition.name}: need $${shortfall} more`, "error");
      this.updateStats(`Cannot afford ${definition.name}: need $${shortfall} more`);
      return;
    }

    this.expansionLevel = level;
    this.syncLuxuryUnlocks();
    this.normalizeWallMountedFurnitureToCurrentWalls();
    this.refreshRestaurantShellAndGrid();
    this.renderFurniture();
    this.refreshCatalogUiIfReady();
    this.persistQuietly();
    this.showToast(`${definition.name} unlocked for $${cost}. Luxury tier ${this.getUnlockedLuxuryTier()} available.`, "success");
    this.updateStats(`${definition.name} unlocked. Tier ${this.getUnlockedLuxuryTier()} items available.`);
  }

  private getUnlockedLuxuryTier(): LuxuryTier {
    return Phaser.Math.Clamp(this.expansionLevel + 1, 1, 5) as LuxuryTier;
  }

  private getExpansionRequiredForTier(tier: LuxuryTier): number {
    return Math.max(0, tier - 1);
  }

  private syncLuxuryUnlocks(): void {
    this.cooking.syncLuxuryUnlocks(this.getUnlockedLuxuryTier());
  }

  private isRecipeUnlocked(recipe: RecipeDefinition): boolean {
    return this.cooking.isRecipeUnlocked(recipe, this.getUnlockedLuxuryTier());
  }

  private isFurnitureUnlocked(furniture: FurnitureDefinition): boolean {
    return this.getFurnitureLuxuryTier(furniture) <= this.getUnlockedLuxuryTier();
  }

  private getFurnitureLuxuryTier(furniture: FurnitureDefinition): LuxuryTier {
    if (furniture.luxuryTier) {
      return furniture.luxuryTier;
    }

    const value = furniture.cost + furniture.style * 16 + furniture.comfort * 10 + (furniture.ratingBonus ?? 0) * 500 + (furniture.attractionBonus ?? 0) * 8;
    if (value >= 420) {
      return 5;
    }
    if (value >= 250) {
      return 4;
    }
    if (value >= 135) {
      return 3;
    }
    if (value >= 65) {
      return 2;
    }
    return 1;
  }

  private getLuxuryLockText(name: string, tier: LuxuryTier): string {
    return `${name} is luxury tier ${tier}. Unlock expansion ${this.getExpansionRequiredForTier(tier)} to use it.`;
  }

  private createUi(): void {
    this.drawPanelBox(leftPanelX - 10, 102, 318, 122, "Game");
    this.createActionButton("New Game", leftPanelX + 4, 142, () => this.startNewGame(), 92, 32, 13);
    this.createActionButton("Save", leftPanelX + 104, 142, () => this.openSaveModal("save"), 58, 32, 13);
    this.createActionButton("Load", leftPanelX + 170, 142, () => this.openSaveModal("load"), 58, 32, 13);
    this.adminButton = this.createActionButton("Admin", leftPanelX + 236, 142, () => this.openAdminModal(), 60, 32, 13);
    this.createActionButton("Starter Grant", leftPanelX + 4, 180, () => this.claimStarterGrant(), 96, 32, 13);
    this.streetButton = this.createActionButton("Go to street", leftPanelX + 108, 180, () => this.setMapViewMode(this.mapViewMode === "inside" ? "street" : "inside"), 104, 32, 13);
    this.publicToggleButton = this.createActionButton("Close", leftPanelX + 220, 180, () => this.toggleRestaurantOpen(), 76, 32, 13);

    this.drawPanelBox(leftPanelX - 10, 240, 318, 202, "Status");
    this.statsText = this.add.text(leftPanelX + 4, 280, "", this.panelTextStyle(12)).setLineSpacing(5).setWordWrapWidth(138);
    this.statsTextRight = this.add.text(leftPanelX + 154, 280, "", this.panelTextStyle(12)).setLineSpacing(5).setWordWrapWidth(136);

    this.drawPanelBox(leftPanelX - 10, 456, 318, 128, "Action");
    this.modeText = this.add.text(leftPanelX + 4, 494, "", this.panelTextStyle(13));
    this.createActionButton("Deselect", leftPanelX + 204, 494, () => this.deselectSelection(), 92, 28, 13);
    this.selectedText = this.add.text(leftPanelX + 4, 520, "", this.panelTextStyle(12)).setWordWrapWidth(280).setLineSpacing(1);
    this.messageText = this.add.text(leftPanelX + 4, 546, "", this.panelTextStyle(11)).setWordWrapWidth(280).setLineSpacing(0);

    this.drawPanelBox(leftPanelX - 10, 596, 318, 276, "Build");
    this.createBuildTabs();
    this.createBuildScrollList();
    this.drawBuildFooter();
    this.createModeButton("Build", leftPanelX + 4, 840, "build", undefined, 62);
    this.createModeButton("Move", leftPanelX + 76, 840, "move", undefined, 62);
    this.createModeButton("Sell", leftPanelX + 148, 840, "remove", undefined, 62);
    this.createModeButton("Seats", leftPanelX + 220, 840, "seat", undefined, 62);
    this.createZoomControls();

    this.createRightTabs();

    this.addRightContent("ops", this.drawPanelBox(rightPanelX - 10, 164, 274, 492, "Staff"));
    this.addRightContent("ops", this.drawInnerPanelBox(rightPanelX + 2, 204, 250, 144, "Team"));
    this.staffTeamText = this.addRightContent(
      "ops",
      this.add.text(rightPanelX + 14, 236, "", this.panelTextStyle(13)).setWordWrapWidth(224).setLineSpacing(4),
    ) as Phaser.GameObjects.Text;
    this.addRightContent("ops", this.drawInnerPanelBox(rightPanelX + 2, 358, 250, 136, "Service"));
    this.staffServiceText = this.addRightContent(
      "ops",
      this.add.text(rightPanelX + 14, 390, "", this.panelTextStyle(13)).setWordWrapWidth(224).setLineSpacing(4),
    ) as Phaser.GameObjects.Text;
    this.addRightContent("ops", this.drawInnerPanelBox(rightPanelX + 2, 504, 250, 126, "Stock"));
    this.staffStockText = this.addRightContent(
      "ops",
      this.add.text(rightPanelX + 14, 536, "", this.panelTextStyle(13)).setWordWrapWidth(224).setLineSpacing(4),
    ) as Phaser.GameObjects.Text;
    this.addRightContent("ops", this.drawPanelBox(rightPanelX - 10, 672, 274, 174, "Staff Actions"));
    this.hireChefButton = this.addRightContent("ops", this.createActionButton("", rightPanelX + 4, 712, () => this.hireStaff("chef"), 118, 30, 13)) as Phaser.GameObjects.Text;
    this.fireChefButton = this.addRightContent("ops", this.createActionButton("", rightPanelX + 132, 712, () => this.fireStaff("chef"), 118, 30, 13)) as Phaser.GameObjects.Text;
    this.hireWaiterButton = this.addRightContent("ops", this.createActionButton("", rightPanelX + 4, 750, () => this.hireStaff("waiter"), 118, 30, 13)) as Phaser.GameObjects.Text;
    this.fireWaiterButton = this.addRightContent("ops", this.createActionButton("", rightPanelX + 132, 750, () => this.fireStaff("waiter"), 118, 30, 13)) as Phaser.GameObjects.Text;
    this.hireErrandButton = this.addRightContent("ops", this.createActionButton("", rightPanelX + 4, 788, () => this.hireStaff("errand"), 118, 30, 13)) as Phaser.GameObjects.Text;
    this.fireErrandButton = this.addRightContent("ops", this.createActionButton("", rightPanelX + 132, 788, () => this.fireStaff("errand"), 118, 30, 13)) as Phaser.GameObjects.Text;

    this.addRightContent("menu", this.drawPanelBox(rightPanelX - 10, 164, 274, 708, "Recipe Menu"));
    this.addRightContent(
      "menu",
      this.add.text(rightPanelX + 4, 204, "Pick up to 3 active recipes in each category.", this.panelTextStyle(14)).setWordWrapWidth(246),
    );
    this.createRecipeMenuButtons();

    this.createStockScrollArea();
    this.addStockContent(this.drawPanelBox(rightPanelX - 10, 164, 274, 206, "Auto-Shop"));
    this.addStockContent(
      this.add.text(
        rightPanelX + 4,
        204,
        "Errand helpers restock ingredients for active menu recipes.",
        this.panelTextStyle(13),
      ).setWordWrapWidth(246),
    );
    this.autoShopButton = this.addStockActionButton(
      this.createActionButton("Auto-Shop Off", rightPanelX + 4, 246, () => this.toggleAutoShop(), 246),
    ) as Phaser.GameObjects.Text;
    this.addStockActionButton(this.createActionButton("- Target", rightPanelX + 4, 284, () => this.adjustStockTarget(-1), 76, 28, 12));
    this.stockTargetText = this.addStockContent(
      this.add.text(rightPanelX + 88, 288, "", this.panelTextStyle(13)).setWordWrapWidth(76),
    ) as Phaser.GameObjects.Text;
    this.addStockActionButton(this.createActionButton("+ Target", rightPanelX + 174, 284, () => this.adjustStockTarget(1), 76, 28, 12));
    this.errandOrderText = this.addStockContent(
      this.add.text(rightPanelX + 4, 326, "", this.panelTextStyle(12)).setWordWrapWidth(246).setLineSpacing(0),
    ) as Phaser.GameObjects.Text;

    this.addStockContent(this.drawPanelBox(rightPanelX - 10, inNeedPanelY, 274, 130, "In Need"));
    this.createInNeedScrollList();

    this.addStockContent(this.drawPanelBox(rightPanelX - 10, stockOnHandPanelY, 274, 176, "Stock On Hand"));
    this.createPantryScrollList();
    this.addStockContent(this.drawPanelBox(rightPanelX - 10, kitchenTicketsPanelY, 274, 98, "Kitchen Tickets"));
    this.queueText = this.addStockContent(
      this.add.text(rightPanelX + 4, kitchenTicketsPanelY + 38, "", this.panelTextStyle(12)).setWordWrapWidth(246).setLineSpacing(2),
    ) as Phaser.GameObjects.Text;
    this.stockScrollContentHeight = kitchenTicketsPanelY + 112 - stockTabScrollY;
    this.clampStockScroll();
    this.add.rectangle(mapViewport.x + 285, 122, 570, 26, 0xfff8e8, 0.92).setStrokeStyle(1, panelStroke, 0.75);
    this.guideText = this.add.text(
      mapViewport.x + 16,
      114,
      "Chairs work beside tables. Better furniture raises ratings and attracts fuller orders.",
      this.panelTextStyle(12),
    ).setFixedSize(538, 26).setAlign("center").setPadding(0, 5, 0, 0);
    this.tooltipText = this.add
      .text(0, 0, "", {
        color: "#3b2a21",
        backgroundColor: "#fff8e8",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        padding: { x: 8, y: 6 },
      })
      .setWordWrapWidth(260)
      .setLineSpacing(0)
      .setDepth(2000)
      .setVisible(false);
    this.setRightTab("ops");
  }

  private createDebugOverlay(): void {
    this.debugText = this.add
      .text(1142, 92, "", {
        color: "#fffaf0",
        backgroundColor: "rgba(57, 43, 35, 0.78)",
        fontFamily: "Consolas, monospace",
        fontSize: "11px",
        padding: { x: 8, y: 5 },
      })
      .setDepth(5000)
      .setVisible(false);
  }

  private updateDebugOverlay(time: number, delta: number): void {
    if (time - this.lastDebugUpdateAt < 1000 || !this.debugText) {
      return;
    }

    this.lastDebugUpdateAt = time;
    const tweenCount = this.tweens.getTweens().length;
    const eventCount = (this.time as Phaser.Time.Clock & { _active?: unknown[] })._active?.length ?? 0;
    const movingActors = this.actors.filter((actor) => actor.container.getData("motionTween")).length;
    const text = [
      `FPS ${Math.round(1000 / Math.max(1, delta))}`,
      `Actors ${this.actors.length}`,
      `Guests ${this.guests.length}`,
      `Jobs ${this.tickets.length}`,
      `Move ${movingActors}`,
      `Tweens ${tweenCount}`,
      `Timers ${eventCount}`,
      `Draw ${this.furnitureRenderRate}/s ${this.lastFurnitureRenderMs.toFixed(1)}ms`,
      `Save ${this.lastSaveMs.toFixed(1)}ms`,
      `Path ${this.pathfindingAverageMs.toFixed(2)}ms`,
    ].join("  ");
    this.setTextIfChanged(this.debugText, text);
  }

  private createFurnitureButton(furniture: FurnitureDefinition, x: number, y: number): void {
    const button = this.add.text(x, y, `${furniture.name}  $${this.getFurniturePurchaseCost(furniture)}`, {
      color: "#38251d",
      backgroundColor: "#fff8e8",
      fixedWidth: 300,
      fixedHeight: 26,
      padding: { x: 8, y: 4 },
      fontFamily: "Arial, sans-serif",
      fontSize: "15px",
    });

    button.setInteractive({ useHandCursor: true });
    button.on("pointerdown", () => {
      this.mode = "build";
      this.placement.selectCatalogItem(furniture.id);
      this.updateStats(`${furniture.name} selected`);
    });
  }

  private createBuildTabs(): void {
    this.buildTabButtons = {
      furniture: this.createBuildTabButton("Furniture", leftPanelX + 4, 632, "furniture"),
      kitchen: this.createBuildTabButton("Kitchen", leftPanelX + 82, 632, "kitchen"),
      decor: this.createBuildTabButton("Decor", leftPanelX + 160, 632, "decor"),
      walls: this.createBuildTabButton("Walls", leftPanelX + 238, 632, "walls"),
    };
    this.refreshBuildSubTabs();
  }

  private createZoomControls(): void {
    const controlsX = mapViewport.x + 600;
    const controlsY = 112;
    this.add.text(controlsX, controlsY + 8, "Zoom", this.panelTextStyle(12)).setDepth(1200);
    this.createActionButton("-", controlsX + 44, controlsY, () => this.adjustRestaurantZoom(-restaurantZoomStep), 28, 28, 16).setDepth(1200);
    this.zoomText = this.add
      .text(controlsX + 78, controlsY + 6, "100%", {
        color: "#3b2a21",
        backgroundColor: "#fff8e8",
        fixedWidth: 54,
        fixedHeight: 22,
        align: "center",
        padding: { x: 4, y: 4 },
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
      })
      .setDepth(1200);
    this.createActionButton("+", controlsX + 138, controlsY, () => this.adjustRestaurantZoom(restaurantZoomStep), 28, 28, 16).setDepth(1200);
    this.add.text(controlsX + 196, controlsY + 8, "View", this.panelTextStyle(12)).setDepth(1200);
    this.createActionButton("<", controlsX + 240, controlsY, () => this.rotateRestaurantView(-1), 28, 28, 16).setDepth(1200);
    this.viewRotationText = this.add
      .text(controlsX + 274, controlsY + 6, "0", {
        color: "#3b2a21",
        backgroundColor: "#fff8e8",
        fixedWidth: 46,
        fixedHeight: 22,
        align: "center",
        padding: { x: 4, y: 4 },
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
      })
      .setDepth(1200);
    this.createActionButton(">", controlsX + 326, controlsY, () => this.rotateRestaurantView(1), 28, 28, 16).setDepth(1200);
  }

  private createBuildTabButton(label: string, x: number, y: number, tab: BuildTab): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, {
      color: "#fffaf0",
      backgroundColor: "#715741",
      fixedWidth: 72,
      fixedHeight: 24,
      align: "center",
      padding: { x: 5, y: 4 },
      fontFamily: "Arial, sans-serif",
      fontSize: "12px",
    });
    button.setInteractive({ useHandCursor: true });
    button.setDepth(uiDepth + 2);
    button.on("pointerdown", () => {
      this.activeBuildTab = tab;
      this.activeBuildSubTab = this.getBuildSubTabs(tab)[0];
      this.buildScrollOffset = 0;
      this.refreshBuildSubTabs();
      this.refreshBuildList();
    });
    return button;
  }

  private refreshBuildSubTabs(): void {
    Object.values(this.buildSubTabButtons).forEach((button) => button?.destroy());
    this.buildSubTabButtons = {};
    const subTabs = this.getBuildSubTabs(this.activeBuildTab);
    const gap = 6;
    const subTabWidth = Math.floor((292 - gap * (subTabs.length - 1)) / subTabs.length);
    subTabs.forEach((subTab, index) => {
      const button = this.add.text(leftPanelX + 4 + index * (subTabWidth + gap), 662, this.getBuildSubTabLabel(subTab), {
        color: "#fffaf0",
        backgroundColor: "#a0715f",
        fixedWidth: subTabWidth,
        fixedHeight: 24,
        align: "center",
        padding: { x: 3, y: 5 },
        fontFamily: "Arial, sans-serif",
        fontSize: subTabs.length > 4 ? "10px" : "11px",
      });
      button.setInteractive({ useHandCursor: true });
      button.setDepth(uiDepth + 3);
      button.on("pointerdown", () => {
        this.activeBuildSubTab = subTab;
        this.buildScrollOffset = 0;
        this.refreshBuildList();
      });
      this.buildSubTabButtons[subTab] = button;
    });
    this.updateBuildTabStyles();
  }

  private createBuildScrollList(): void {
    this.buildScrollContainer = this.add.container(buildScrollX, buildScrollY);
    this.buildScrollContainer.setDepth(uiDepth + 1);
    const maskShape = this.add.rectangle(buildScrollX, buildScrollY, buildScrollWidth - 16, buildScrollHeight, 0xffffff).setOrigin(0);
    maskShape.setVisible(false);
    maskShape.setDepth(uiDepth + 1);
    this.buildScrollContainer.setMask(maskShape.createGeometryMask());
    this.buildScrollbar = this.add.graphics();
    this.buildScrollbar.setDepth(uiDepth + 2);
    this.refreshBuildList();
  }

  private drawBuildFooter(): void {
    const footer = this.add.graphics();
    footer.fillStyle(panelFill, 1);
    footer.fillRoundedRect(leftPanelX - 2, 830, 300, 36, 5);
    footer.lineStyle(1, panelStroke, 0.55);
    footer.lineBetween(leftPanelX + 2, 830, leftPanelX + 292, 830);
    footer.setDepth(uiDepth + 2);
  }

  private refreshBuildList(): void {
    if (!this.buildScrollContainer) {
      return;
    }

    this.buildScrollContainer.removeAll(true);
    this.buildButtons = [];
    const items = this.getBuildCatalogItems();
    items.forEach((furniture, index) => {
      const unlocked = this.isFurnitureUnlocked(furniture);
      const tier = this.getFurnitureLuxuryTier(furniture);
      const button = this.createLocalActionButton(
        `${furniture.name}  $${this.getFurniturePurchaseCost(furniture)}`,
        0,
        index * 28,
        () => {
          if (!this.isFurnitureUnlocked(furniture)) {
            const message = this.getLuxuryLockText(furniture.name, this.getFurnitureLuxuryTier(furniture));
            this.showToast(message, "error");
            this.updateStats(message);
            return;
          }

          this.mode = "build";
          this.placement.selectCatalogItem(furniture.id);
          this.updateStats(`${furniture.name} selected`);
        },
        buildScrollWidth - 18,
        24,
        12,
        (pointer) => this.isPointInside(pointer, buildScrollX, buildScrollY, buildScrollWidth, buildScrollHeight),
      );
      button.setColor(unlocked ? "#3b2a21" : "#70675e");
      button.setAlpha(unlocked ? 1 : 0.62);
      button.setBackgroundColor(unlocked ? "#f3dfbd" : "#d7d0c2");
      button.on("pointerover", (pointer: Phaser.Input.Pointer) => {
        this.showFurnitureTooltip(furniture, pointer.x, pointer.y);
      });
      button.on("pointermove", (pointer: Phaser.Input.Pointer) => {
        this.moveTooltip(pointer.x, pointer.y);
      });
      button.on("pointerout", () => this.hideTooltip());
      const badge = this.createRankBadge(buildScrollWidth - 42, index * 28 + 12, tier, unlocked);
      this.buildScrollContainer.add(button);
      this.buildScrollContainer.add(badge);
      this.buildButtons.push({ furnitureId: furniture.id, button, badge });
    });
    this.buildScrollContentHeight = items.length * 28;
    this.clampBuildScroll();
    this.updateBuildTabStyles();
  }

  private getBuildCatalogItems(): FurnitureDefinition[] {
    return furnitureCatalog
      .filter((furniture) => this.getBuildSubTabForFurniture(furniture) === this.activeBuildSubTab)
      .sort((a, b) => this.getFurnitureLuxuryTier(a) - this.getFurnitureLuxuryTier(b) || a.cost - b.cost || a.name.localeCompare(b.name));
  }

  private getBuildSubTabs(tab: BuildTab): BuildSubTab[] {
    const tabs: Record<BuildTab, BuildSubTab[]> = {
      furniture: ["tables", "chairs"],
      kitchen: ["stoves", "counters", "dishwashing"],
      decor: ["plants", "decorations", "lighting", "wallFinishes"],
      walls: ["wallFinishes", "windows", "doors", "walls", "flooring"],
    };
    return tabs[tab];
  }

  private getBuildSubTabForFurniture(furniture: FurnitureDefinition): BuildSubTab {
    const mapping: Record<FurnitureDefinition["category"], BuildSubTab> = {
      table: "tables",
      chair: "chairs",
      stove: "stoves",
      counter: this.isDishwashingFurniture(furniture.id) ? "dishwashing" : "counters",
      plant: "plants",
      decoration: "decorations",
      lighting: "lighting",
      wallDecoration: this.isWallFinishFurniture(furniture.id)
        ? "wallFinishes"
        : this.isWindowFurniture(furniture.id)
          ? "windows"
          : this.isDoorFurniture(furniture.id)
            ? "doors"
            : "walls",
      flooring: "flooring",
    };
    return mapping[furniture.category];
  }

  private isWallFinishFurniture(furnitureId: string): boolean {
    return furnitureId.includes("paint") || furnitureId.includes("wallpaper");
  }

  private isEntranceDoorWallFinish(item: PlacedFurniture, definition = getFurnitureDefinition(item.furnitureId)): boolean {
    if (definition.category !== "wallDecoration" || !this.isWallFinishFurniture(definition.id)) {
      return false;
    }

    const rotation = ((Math.round((item.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
    if (rotation !== 180) {
      return false;
    }

    const entranceCells = new Set(["6,8", "7,8"]);
    return this.grid
      .getOccupiedCells(definition, item.position, item.rotation ?? 0)
      .some((cell) => entranceCells.has(`${cell.x},${cell.y}`));
  }

  private isWindowFurniture(furnitureId: string): boolean {
    return furnitureId.includes("window");
  }

  private isDoorFurniture(furnitureId: string): boolean {
    return furnitureId.includes("door");
  }

  private isMenuBoardFurniture(furnitureId: string): boolean {
    return furnitureId === "menu-board" || furnitureId === "paper-menu" || furnitureId === "chalk-specials";
  }

  private getBuildSubTabLabel(tab: BuildSubTab): string {
    const labels: Record<BuildSubTab, string> = {
      tables: "Tables",
      chairs: "Chairs",
      stoves: "Stoves",
      counters: "Counters",
      dishwashing: "Dishes",
      plants: "Plants",
      decorations: "Decor",
      lighting: "Lights",
      wallFinishes: "Paints",
      windows: "Windows",
      doors: "Doors",
      walls: "Walls",
      flooring: "Floors",
    };
    return labels[tab];
  }

  private updateBuildTabStyles(): void {
    if (this.buildTabButtons) {
      (Object.keys(this.buildTabButtons) as BuildTab[]).forEach((tab) => {
        this.buildTabButtons?.[tab].setBackgroundColor(tab === this.activeBuildTab ? "#5f7f5f" : "#715741");
      });
    }
    Object.entries(this.buildSubTabButtons).forEach(([tab, button]) => {
      button?.setBackgroundColor(tab === this.activeBuildSubTab ? "#47734f" : "#a0715f");
    });
  }

  private drawPanelBox(x: number, y: number, width: number, height: number, title: string): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const graphics = this.add.graphics();
    graphics.fillStyle(panelFill, 1);
    graphics.fillRoundedRect(0, 0, width, height, 8);
    graphics.fillStyle(panelHeader, 1);
    graphics.fillRoundedRect(0, 0, width, 32, 8);
    graphics.fillRect(0, 20, width, 12);
    graphics.lineStyle(2, panelStroke, 1);
    graphics.strokeRoundedRect(0, 0, width, height, 8);
    const label = this.add.text(14, 6, title, this.sectionTitleStyle());
    container.add([graphics, label]);
    return container;
  }

  private drawInnerPanelBox(x: number, y: number, width: number, height: number, title: string): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const graphics = this.add.graphics();
    graphics.fillStyle(0xfff8e8, 1);
    graphics.fillRoundedRect(0, 0, width, height, 6);
    graphics.fillStyle(0xf0d8a8, 1);
    graphics.fillRoundedRect(0, 0, width, 26, 6);
    graphics.fillRect(0, 16, width, 10);
    graphics.lineStyle(1, panelStroke, 0.85);
    graphics.strokeRoundedRect(0, 0, width, height, 6);
    const label = this.add.text(10, 4, title, this.sectionTitleStyle());
    container.add([graphics, label]);
    return container;
  }

  private createModeButton(
    label: string,
    x: number,
    y: number,
    mode: InteractionMode,
    onClick?: () => void,
    width = 70,
  ): void {
    const button = this.add.text(x, y, label, {
      color: "#fffaf0",
      backgroundColor: "#715741",
      fixedWidth: width,
      fixedHeight: 28,
      align: "center",
      padding: { x: 8, y: 5 },
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
    });

    button.setInteractive({ useHandCursor: true });
    button.setDepth(uiDepth + 4);
    button.on("pointerdown", () => {
      this.mode = mode;
      if (mode !== "build") {
        this.placement.clearSelection();
      }
      onClick?.();
      this.updateStats(`${label} mode`);
    });
  }

  private createActionButton(
    label: string,
    x: number,
    y: number,
    onClick: () => void,
    width = 210,
    height = 32,
    fontSize = 15,
  ): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, {
      color: "#fffaf0",
      backgroundColor: "#8f6251",
      fixedWidth: width,
      fixedHeight: height,
      padding: { x: 8, y: height <= 24 ? 4 : 7 },
      fontFamily: "Arial, sans-serif",
      fontSize: `${fontSize}px`,
    });

    button.setInteractive({ useHandCursor: true });
    button.on("pointerdown", (
      _pointer: Phaser.Input.Pointer,
      _localX: number,
      _localY: number,
      event?: Phaser.Types.Input.EventData,
    ) => {
      event?.stopPropagation();
      onClick();
    });
    return button;
  }

  private createRankBadge(x: number, y: number, tier: number, unlocked: boolean): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const circle = this.add.graphics();
    circle.fillStyle(unlocked ? 0x5f7f5f : 0x8a7a64, 1);
    circle.fillCircle(0, 0, 10);
    circle.lineStyle(1, 0xfff8e8, 0.9);
    circle.strokeCircle(0, 0, 10);
    const label = this.add.text(0, 0, `${tier}`, {
      color: "#fffaf0",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "11px",
      fontStyle: "bold",
    }).setOrigin(0.5);
    container.add([circle, label]);
    container.setData("circle", circle);
    container.setData("label", label);
    container.setAlpha(unlocked ? 1 : 0.62);
    return container;
  }

  private updateRankBadge(badge: Phaser.GameObjects.Container, value: number, unlocked: boolean): void {
    const label = badge.getData("label") as Phaser.GameObjects.Text | undefined;
    const circle = badge.getData("circle") as Phaser.GameObjects.Graphics | undefined;
    if (label) {
      this.setTextIfChanged(label, `${value}`);
    }
    if (circle) {
      circle.clear();
      circle.fillStyle(unlocked ? 0x5f7f5f : 0x8a7a64, 1);
      circle.fillCircle(0, 0, 10);
      circle.lineStyle(1, 0xfff8e8, 0.9);
      circle.strokeCircle(0, 0, 10);
    }
    badge.setAlpha(unlocked ? 1 : 0.62);
  }

  private deselectSelection(): void {
    this.placement.clearSelection();
    this.hideTooltip();
    this.updateStats("Selection cleared");
  }

  private showFurnitureTooltip(furniture: FurnitureDefinition, x: number, y: number): void {
    if (!this.tooltipText) {
      return;
    }

    const functionLabel = this.formatFunctionality(furniture.functionality);
    const tier = this.getFurnitureLuxuryTier(furniture);
    const unlocked = this.isFurnitureUnlocked(furniture);
    const upgradeHint =
      !unlocked
        ? this.getLuxuryLockText(furniture.name, tier)
        :
      furniture.functionality === "decor"
        ? "Higher style and comfort raise attractiveness."
        : furniture.functionality === "cooking"
          ? "More cooking stations let more chefs work."
          : furniture.functionality === "seating"
            ? "Seats only count beside a table, max 4 chairs per table."
            : "Supports service and restaurant flow.";
    this.tooltipText
      .setStyle({
        color: "#3b2a21",
        backgroundColor: "#fff8e8",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        padding: { x: 8, y: 6 },
      })
      .setWordWrapWidth(260)
      .setLineSpacing(0)
      .setText(
        [
          furniture.name,
          `Luxury tier ${tier}${unlocked ? "" : ` | locked until expansion ${this.getExpansionRequiredForTier(tier)}`}`,
          `$${this.getFurniturePurchaseCost(furniture)} | ${furniture.size.width}x${furniture.size.height}`,
          `Comfort ${furniture.comfort} | Style ${furniture.style}`,
          `Use: ${functionLabel}`,
          ...this.getFurnitureEffectLines(furniture),
          upgradeHint,
        ].join("\n"),
      )
      .setVisible(true);
    this.moveTooltip(x, y);
  }

  private moveTooltip(x: number, y: number): void {
    if (!this.tooltipText?.visible) {
      return;
    }

    const tooltipWidth = Math.max(260, this.tooltipText.width);
    const tooltipHeight = Math.max(120, this.tooltipText.height);
    this.tooltipText.setPosition(
      Phaser.Math.Clamp(x + 16, 12, gameWidth - tooltipWidth - 12),
      Phaser.Math.Clamp(y + 16, 12, gameHeight - tooltipHeight - 12),
    );
  }

  private hideTooltip(): void {
    this.clearRatingTooltipTimer();
    this.tooltipText?.setVisible(false);
  }

  private updatePlacedFurnitureHover(pointer: Phaser.Input.Pointer): void {
    if (!this.isPointerInRestaurantView(pointer)) {
      return;
    }

    const localPointer = this.getRestaurantPointerPosition(pointer);
    const hovered = this.getPlacedFurnitureAtWorld(localPointer.x, localPointer.y);
    if (!hovered) {
      this.hideTooltip();
      return;
    }

    const definition = getFurnitureDefinition(hovered.furnitureId);
    if (definition.category !== "counter" || !serviceCounterFurnitureIds.includes(definition.id)) {
      this.hideTooltip();
      return;
    }

    this.showCounterStorageTooltip(definition, pointer.x, pointer.y);
  }

  private getPlacedFurnitureAtWorld(worldX: number, worldY: number): PlacedFurniture | null {
    const position = this.grid.worldToGrid(worldX, worldY);
    if (!position) {
      return null;
    }

    return this.placement.getFurnitureAt(position, { includeFlooring: false });
  }

  private showCounterStorageTooltip(furniture: FurnitureDefinition, x: number, y: number): void {
    if (!this.tooltipText) {
      return;
    }

    const storedLines = this.getStoredReadyMealLines();
    this.tooltipText
      .setStyle({
        color: "#3b2a21",
        backgroundColor: "#fff8e8",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        padding: { x: 8, y: 6 },
      })
      .setWordWrapWidth(260)
      .setLineSpacing(0)
      .setText(
        [
          furniture.name,
          "Counter storage",
          storedLines.length > 0 ? "Stored ready meals:" : "No stored ready meals.",
          ...storedLines,
          "Fresh ready dishes stay visible on stoves until picked up.",
        ].join("\n"),
      )
      .setVisible(true);
    this.moveTooltip(x, y);
  }

  private getStoredReadyMealLines(): string[] {
    return Object.entries(this.cooking.getPreparedServings())
      .filter(([, count]) => count > 0)
      .sort(([recipeA], [recipeB]) => {
        const nameA = recipes.find((recipe) => recipe.id === recipeA)?.name ?? recipeA;
        const nameB = recipes.find((recipe) => recipe.id === recipeB)?.name ?? recipeB;
        return nameA.localeCompare(nameB);
      })
      .slice(0, 8)
      .map(([recipeId, count]) => {
        const recipe = recipes.find((item) => item.id === recipeId);
        return `${recipe?.name ?? recipeId}: x${count}`;
      });
  }

  private showRecipeTooltip(recipe: RecipeDefinition, x: number, y: number): void {
    if (!this.tooltipText) {
      return;
    }

    const tier = this.getRecipeLuxuryTier(recipe);
    const unlocked = this.isRecipeUnlocked(recipe);
    const missingIngredients = this.getMissingIngredientsForRecipe(recipe);
    const active = this.cooking.isOnMenu(recipe.id);
    const preparedCount = this.cooking.getPreparedServingCount(recipe.id);
    const recipeLevel = this.getRecipeUpgradeLevel(recipe);
    const ingredientCost = this.getRecipeIngredientCost(recipe);
    const profit = this.getRecipeProfit(recipe);
    const sellPrice = this.getRecipeSellPrice(recipe);
    const satisfaction = this.getRecipeSatisfactionEffect(recipe);
    const categoryCount = this.getActiveRecipeCountForCategory(recipe.category);
    const actionText = !unlocked
      ? this.getLuxuryLockText(recipe.name, tier)
      : active
        ? "Click to remove from active menu."
        : categoryCount >= 3
          ? `Remove another ${this.formatRecipeCategory(recipe.category).toLowerCase()} first.`
          : "Click to add to active menu.";
    const ingredientLines = recipe.ingredients.map((ingredient) => {
      const name = this.shortIngredientName(this.getIngredientName(ingredient));
      const quantity = this.getIngredientQuantity(ingredient);
      return `${name} ${quantity}`;
    });
    const missingText = missingIngredients.length > 0 && unlocked
      ? `Need: ${missingIngredients.map((ingredient) => this.shortIngredientName(this.getIngredientName(ingredient))).join(", ")}`
      : "";
    const lines = [
      `${recipe.name}  T${tier}  L${recipeLevel}`,
      `${this.formatRecipeCategory(recipe.category)} | ${active ? "On menu" : "Off menu"} | Ready x${preparedCount}`,
      `[Money] Sell $${sellPrice} | Cost $${ingredientCost} | +$${profit}`,
      `[Kitchen] ${recipe.stationNeeded} | ${recipe.preparationTimeSeconds}s | Appeal +${satisfaction}`,
      `[Stock] ${ingredientLines.join("  |  ")}`,
      missingText,
      `[Action] ${actionText}  Use arrow to upgrade.`,
    ].filter(Boolean);

    this.tooltipText
      .setStyle({
        color: "#3b2a21",
        backgroundColor: missingIngredients.length > 0 && unlocked ? "#f6ead7" : active ? "#eef5e8" : "#fff8e8",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        padding: { x: 8, y: 6 },
      })
      .setWordWrapWidth(238)
      .setLineSpacing(0)
      .setText(lines.join("\n"))
      .setVisible(true);
    this.moveTooltip(x, y);
  }

  private getRecipeIngredientCost(recipe: RecipeDefinition): number {
    return recipe.ingredients.length * this.getIngredientUnitCost();
  }

  private getRecipeUpgradeLevel(recipe: RecipeDefinition | string): number {
    return this.cooking.getRecipeUpgradeLevel(recipe);
  }

  private getRecipeLuxuryTier(recipe: RecipeDefinition): LuxuryTier {
    return getRecipeLuxuryTier(recipe);
  }

  /**
   * Profit per dish. Tier acts as a +$1-per-tier bonus to the per-level profit base,
   * so the tier advantage compounds with upgrade level: a tier-N recipe earns
   * `(starterProfit + (N - 1)) * upgradeLevel`. At level 1 each tier is $1 ahead of
   * the previous; at level 10 each tier is $10 ahead.
   */
  private getRecipeProfit(recipe: RecipeDefinition, levelOverride?: number): number {
    const level = levelOverride ?? this.getRecipeUpgradeLevel(recipe);
    const tierBonus = getRecipeLuxuryTier(recipe) - 1;
    return (this.getStarterRecipeProfit() + tierBonus) * level;
  }

  private getRecipeSellPrice(recipe: RecipeDefinition): number {
    return this.getRecipeIngredientCost(recipe) + this.getRecipeProfit(recipe);
  }

  private getRecipeSatisfactionEffect(recipe: RecipeDefinition): number {
    return recipe.satisfactionEffect + (this.getRecipeUpgradeLevel(recipe) - 1) * 2;
  }

  private getRecipeUpgradeCost(recipe: RecipeDefinition): Record<string, number> {
    const level = this.getRecipeUpgradeLevel(recipe);
    if (level >= maxRecipeUpgradeLevel) {
      return {};
    }

    const perIngredient = level * level;
    return recipe.ingredients.reduce<Record<string, number>>((cost, ingredientId) => {
      cost[ingredientId] = (cost[ingredientId] ?? 0) + perIngredient;
      return cost;
    }, {});
  }

  private canAffordRecipeUpgrade(recipe: RecipeDefinition): boolean {
    return Object.entries(this.getRecipeUpgradeCost(recipe)).every(
      ([ingredientId, quantity]) => this.getIngredientQuantity(ingredientId) >= quantity,
    );
  }

  private formatFunctionality(functionality: FurnitureDefinition["functionality"]): string {
    const labels: Record<FurnitureDefinition["functionality"], string> = {
      seating: "seating",
      cooking: "cooking station",
      serving: "service",
      decor: "decoration",
      wall: "wall decor",
    };
    return labels[functionality];
  }

  private getFurnitureEffectLines(furniture: FurnitureDefinition): string[] {
    const lines: string[] = [];
    if (furniture.cookingSlots) {
      lines.push(`Cooking slots: ${furniture.cookingSlots}`);
    }
    if (furniture.seatingCapacity) {
      lines.push(`Seats: ${furniture.seatingCapacity}`);
    }
    if (furniture.tableSeatCapacity) {
      lines.push(`Table capacity: ${furniture.tableSeatCapacity}`);
    }
    if (furniture.serviceSpeedBonus) {
      lines.push(`Service speed: +${Math.round(furniture.serviceSpeedBonus * 100)}%`);
    }
    if (furniture.ratingBonus) {
      lines.push(`Guest rating: +${furniture.ratingBonus.toFixed(2)} stars`);
    }
    if (furniture.attractionBonus) {
      lines.push(`Attraction: +${furniture.attractionBonus}`);
    }
    return lines;
  }

  private createRecipeMenuButtons(): void {
    this.recipeScrollContainer = this.add.container(recipeScrollX, recipeScrollY);
    this.menuButtons = [];
    this.menuCategoryHeaders = [];
    let y = 0;
    const categories: RecipeDefinition["category"][] = ["appetizer", "main", "dessert", "drink", "side"];
    categories.forEach((category) => {
      const header = this.add.text(0, y, "", {
        color: "#3b2a21",
        backgroundColor: "#ead0a0",
        fixedWidth: recipeScrollWidth - 18,
        fixedHeight: 24,
        padding: { x: 7, y: 4 },
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: "12px",
        fontStyle: "bold",
      });
      this.recipeScrollContainer.add(header);
      this.menuCategoryHeaders.push({ category, text: header });
      y += 28;

      recipes
        .filter((recipe) => recipe.category === category)
        .sort((a, b) => this.getRecipeLuxuryTier(a) - this.getRecipeLuxuryTier(b) || this.getRecipeSellPrice(a) - this.getRecipeSellPrice(b) || a.name.localeCompare(b.name))
        .forEach((recipe) => {
          const unlocked = this.isRecipeUnlocked(recipe);
          const active = this.cooking.isOnMenu(recipe.id);
          const level = unlocked ? this.getRecipeUpgradeLevel(recipe) : this.getRecipeLuxuryTier(recipe);
          const button = this.createLocalActionButton(
            this.getRecipeMenuLabel(recipe, unlocked, active),
            0,
            y,
            () => this.toggleRecipeOnMenu(recipe.id),
            recipeScrollWidth - 18,
            30,
            12,
            (pointer) => this.activeRightTab === "menu" && this.isPointInside(pointer, recipeScrollX, recipeScrollY, recipeScrollWidth, recipeScrollHeight),
          );
          button.on("pointerover", (pointer: Phaser.Input.Pointer) => {
            this.showRecipeTooltip(recipe, pointer.x, pointer.y);
          });
          button.on("pointermove", (pointer: Phaser.Input.Pointer) => {
            this.moveTooltip(pointer.x, pointer.y);
          });
          button.on("pointerout", () => this.hideTooltip());
          const badge = this.createRankBadge(recipeScrollWidth - 68, y + 15, level, unlocked);
          const upgradeButton = this.createLocalActionButton(
            "⬆",
            recipeScrollWidth - 43,
            y + 3,
            () => this.openRecipeUpgradeModal(recipe.id),
            24,
            24,
            15,
            (pointer) => this.activeRightTab === "menu" && this.isPointInside(pointer, recipeScrollX, recipeScrollY, recipeScrollWidth, recipeScrollHeight),
          );
          upgradeButton.setAlign("center");
          upgradeButton.setPadding(0, 0, 0, 0);
          upgradeButton.on("pointerover", (pointer: Phaser.Input.Pointer) => {
            this.showRecipeTooltip(recipe, pointer.x, pointer.y);
          });
          upgradeButton.on("pointermove", (pointer: Phaser.Input.Pointer) => {
            this.moveTooltip(pointer.x, pointer.y);
          });
          upgradeButton.on("pointerout", () => this.hideTooltip());
          this.recipeScrollContainer.add(button);
          this.recipeScrollContainer.add(badge);
          this.recipeScrollContainer.add(upgradeButton);
          this.menuButtons.push({ recipeId: recipe.id, button, badge, upgradeButton });
          y += 34;
        });
      y += 6;
    });
    this.recipeScrollContentHeight = y;

    const maskShape = this.add.rectangle(recipeScrollX, recipeScrollY, recipeScrollWidth - 16, recipeScrollHeight, 0xffffff).setOrigin(0);
    maskShape.setVisible(false);
    this.recipeScrollContainer.setMask(maskShape.createGeometryMask());
    this.recipeScrollbar = this.add.graphics();
    this.addRightContent("menu", this.recipeScrollbar);
    this.addRightContent("menu", this.recipeScrollContainer);
    this.drawScrollBar(this.recipeScrollbar, recipeScrollX, recipeScrollY, recipeScrollWidth, recipeScrollHeight, this.recipeScrollOffset, this.getRecipeScrollMax());
  }

  private createIngredientButtons(): void {
    this.ingredientButtons = [];
    this.ingredientScrollContainer = this.add.container(ingredientScrollX, ingredientScrollY);
    this.cooking.getPantry().forEach((ingredient, index) => {
      const y = index * 24;
      [
        { amount: 1, x: 0, width: 116 },
        { amount: 3, x: 120, width: 54 },
        { amount: 12, x: 178, width: 50 },
      ].forEach(({ amount, x, width }) => {
        const label = amount === 1 ? `${this.getIngredientIcon(ingredient.id)} ${this.shortIngredientName(ingredient.name)} +1` : `+${amount}`;
        const button = this.createLocalActionButton(
          label,
          x,
          y,
          () => this.addIngredientToErrandOrder(ingredient.id, amount),
          width,
          22,
          12,
          (pointer) => this.activeRightTab === "stock" && this.isPointInsideStockContent(pointer, ingredientScrollX, ingredientScrollY, ingredientScrollWidth, ingredientScrollHeight),
        );
        this.ingredientScrollContainer.add(button);
        this.ingredientButtons.push({ ingredientId: ingredient.id, amount, button });
      });
    });

    this.ingredientMaskShape = this.add
      .rectangle(ingredientScrollX, ingredientScrollY, ingredientScrollWidth - 16, ingredientScrollHeight, 0xffffff)
      .setOrigin(0)
      .setVisible(false);
    this.ingredientScrollContainer.setMask(this.ingredientMaskShape.createGeometryMask());
    this.ingredientScrollbar = this.add.graphics();
    this.addStockContent(this.ingredientScrollbar);
    this.addStockContent(this.ingredientScrollContainer);
    this.drawScrollBar(
      this.ingredientScrollbar,
      ingredientScrollX,
      ingredientScrollY,
      ingredientScrollWidth,
      ingredientScrollHeight,
      this.ingredientScrollOffset,
      this.getIngredientScrollMax(),
    );
  }

  private createLocalActionButton(
    label: string,
    x: number,
    y: number,
    onClick: () => void,
    width: number,
    height: number,
    fontSize: number,
    canClick?: (pointer: Phaser.Input.Pointer) => boolean,
  ): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, {
      color: "#fffaf0",
      backgroundColor: "#8f6251",
      fixedWidth: width,
      fixedHeight: height,
      padding: { x: 7, y: height <= 24 ? 4 : 7 },
      fontFamily: "Arial, sans-serif",
      fontSize: `${fontSize}px`,
    });
    button.setInteractive({ useHandCursor: true });
    button.on("pointerdown", (
      pointer: Phaser.Input.Pointer,
      _localX: number,
      _localY: number,
      event?: Phaser.Types.Input.EventData,
    ) => {
      event?.stopPropagation();
      if (canClick && !canClick(pointer)) {
        return;
      }

      onClick();
    });
    return button;
  }

  private createPantryScrollList(): void {
    this.pantryScrollContainer = this.add.container(pantryScrollX, pantryScrollY);
    this.pantryText = this.add.text(0, 0, "", this.panelTextStyle(13)).setWordWrapWidth(pantryScrollWidth - 24).setLineSpacing(3);
    this.pantryScrollContainer.add(this.pantryText);

    this.pantryMaskShape = this.add
      .rectangle(pantryScrollX, pantryScrollY, pantryScrollWidth - 16, pantryScrollHeight, 0xffffff)
      .setOrigin(0)
      .setVisible(false);
    this.pantryScrollContainer.setMask(this.pantryMaskShape.createGeometryMask());

    this.pantryScrollbar = this.add.graphics();
    this.addStockContent(this.pantryScrollbar);
    this.addStockContent(this.pantryScrollContainer);
    this.drawScrollBar(
      this.pantryScrollbar,
      pantryScrollX,
      pantryScrollY,
      pantryScrollWidth,
      pantryScrollHeight,
      this.pantryScrollOffset,
      this.getPantryScrollMax(),
    );
  }

  private createInNeedScrollList(): void {
    this.inNeedScrollContainer = this.add.container(inNeedScrollX, inNeedScrollY);
    this.inNeedText = this.add.text(0, 0, "", this.panelTextStyle(12)).setWordWrapWidth(inNeedScrollWidth - 24).setLineSpacing(2);
    this.inNeedScrollContainer.add(this.inNeedText);

    this.inNeedMaskShape = this.add
      .rectangle(inNeedScrollX, inNeedScrollY, inNeedScrollWidth - 16, inNeedScrollHeight, 0xffffff)
      .setOrigin(0)
      .setVisible(false);
    this.inNeedScrollContainer.setMask(this.inNeedMaskShape.createGeometryMask());

    this.inNeedScrollbar = this.add.graphics();
    this.addStockContent(this.inNeedScrollbar);
    this.addStockContent(this.inNeedScrollContainer);
    this.drawScrollBar(
      this.inNeedScrollbar,
      inNeedScrollX,
      inNeedScrollY,
      inNeedScrollWidth,
      inNeedScrollHeight,
      this.inNeedScrollOffset,
      this.getInNeedScrollMax(),
    );
  }

  private createRightTabs(): void {
    this.rightTabButtons = {
      ops: this.createTabButton("Ops", rightPanelX - 10, 116, "ops"),
      menu: this.createTabButton("Menu", rightPanelX + 82, 116, "menu"),
      stock: this.createTabButton("Stock", rightPanelX + 174, 116, "stock"),
    };
  }

  private createTabButton(label: string, x: number, y: number, tab: RightPanelTab): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, {
      color: "#fffaf0",
      backgroundColor: "#715741",
      fixedWidth: 84,
      fixedHeight: 30,
      align: "center",
      padding: { x: 8, y: 6 },
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
    });
    button.setInteractive({ useHandCursor: true });
    button.on("pointerdown", () => this.setRightTab(tab));
    return button;
  }

  private createStockScrollArea(): void {
    this.stockScrollContainer = this.add.container(0, 0).setDepth(1000);
    const maskShape = this.add
      .rectangle(stockTabScrollX - 2, stockTabScrollY, stockTabScrollWidth + 4, stockTabScrollHeight, 0xffffff)
      .setOrigin(0)
      .setVisible(false);
    this.stockScrollContainer.setMask(maskShape.createGeometryMask());
    this.stockScrollbar = this.add.graphics().setDepth(1200);
    this.addRightContent("stock", this.stockScrollContainer);
    this.addRightContent("stock", this.stockScrollbar);
  }

  private addRightContent(tab: RightPanelTab, object: Phaser.GameObjects.GameObject): Phaser.GameObjects.GameObject {
    this.rightPanelContent[tab].push(object);
    return object;
  }

  private addStockContent(object: Phaser.GameObjects.GameObject): Phaser.GameObjects.GameObject {
    this.stockScrollContainer.add(object);
    return object;
  }

  private addStockActionButton(button: Phaser.GameObjects.Text): Phaser.GameObjects.Text {
    this.stockActionButtons.push(button);
    this.addStockContent(button);
    return button;
  }

  private setRightTab(tab: RightPanelTab): void {
    this.activeRightTab = tab;
    (Object.keys(this.rightPanelContent) as RightPanelTab[]).forEach((panelTab) => {
      this.rightPanelContent[panelTab].forEach((object) => {
        (object as Phaser.GameObjects.GameObject & { setVisible: (visible: boolean) => void }).setVisible(panelTab === tab);
      });
    });

    if (this.rightTabButtons) {
      (Object.keys(this.rightTabButtons) as RightPanelTab[]).forEach((buttonTab) => {
        this.rightTabButtons?.[buttonTab].setBackgroundColor(buttonTab === tab ? "#5f7f5f" : "#715741");
      });
    }
    this.updateRecipeButtonInteractivity();
    this.updateIngredientButtonInteractivity();
    this.updateStockActionButtonInteractivity();
    if (tab === "stock") {
      this.clampStockScroll();
    }
  }

  private handlePanelWheel(pointer: Phaser.Input.Pointer, deltaY: number): void {
    if (this.isPointInside(pointer, buildScrollX, buildScrollY, buildScrollWidth, buildScrollHeight)) {
      this.buildScrollOffset += deltaY > 0 ? 20 : -20;
      this.clampBuildScroll();
      return;
    }

    if (this.activeRightTab === "menu" && this.isPointInside(pointer, recipeScrollX, recipeScrollY, recipeScrollWidth, recipeScrollHeight)) {
      this.recipeScrollOffset += deltaY > 0 ? 22 : -22;
      this.clampRecipeScroll();
      return;
    }

    if (this.activeRightTab === "stock" && this.isPointInsideStockContent(pointer, inNeedScrollX, inNeedScrollY, inNeedScrollWidth, inNeedScrollHeight)) {
      this.inNeedScrollOffset += deltaY > 0 ? 18 : -18;
      this.clampInNeedScroll();
      return;
    }

    if (this.activeRightTab === "stock" && this.isPointInsideStockContent(pointer, pantryScrollX, pantryScrollY, pantryScrollWidth, pantryScrollHeight)) {
      this.pantryScrollOffset += deltaY > 0 ? 18 : -18;
      this.clampPantryScroll();
      return;
    }

    if (this.activeRightTab === "stock" && this.isPointInside(pointer, stockTabScrollX, stockTabScrollY, stockTabScrollWidth, stockTabScrollHeight)) {
      this.stockScrollOffset += deltaY > 0 ? 30 : -30;
      this.clampStockScroll();
      return;
    }

    if (this.mapViewMode === "inside" && this.isPointerInRestaurantView(pointer)) {
      this.adjustRestaurantZoom(deltaY > 0 ? -restaurantZoomStep : restaurantZoomStep, pointer);
    }
  }

  private adjustRestaurantZoom(delta: number, anchorPointer?: Phaser.Input.Pointer): void {
    this.setRestaurantZoom(this.restaurantZoom + delta, anchorPointer);
  }

  private setRestaurantZoom(zoom: number, anchorPointer?: Phaser.Input.Pointer): void {
    const nextZoom = Phaser.Math.Clamp(zoom, restaurantZoomMin, restaurantZoomMax);
    const anchorWorld = anchorPointer ? this.getRestaurantPointerPosition(anchorPointer) : null;

    this.restaurantZoom = nextZoom;
    if (anchorPointer && anchorWorld) {
      const anchorOffset = this.getRestaurantWorldScreenOffset(anchorWorld, this.restaurantZoom);
      this.restaurantLayer.setScale(this.restaurantZoom, this.restaurantZoom * restaurantCameraYScale);
      this.restaurantLayer.setPosition(
        anchorPointer.x - anchorOffset.x,
        anchorPointer.y - anchorOffset.y,
      );
      this.updateRestaurantReadableTextRotation();
    } else {
      this.applyRestaurantCameraTransform(restaurantZoomCenter, restaurantZoomCenter);
    }
    if (this.zoomText) {
      this.setTextIfChanged(this.zoomText, `${Math.round(this.restaurantZoom * 100)}%`);
    }
    this.updatePreview(this.input.activePointer);
  }

  private getRestaurantPointerPosition(pointer: Phaser.Input.Pointer): Phaser.Math.Vector2 {
    return this.getRestaurantScreenPositionToWorld(pointer.x, pointer.y);
  }

  private rotateRestaurantView(deltaSteps: number): void {
    const actorCells = new Map(this.actors.map((actor) => [actor.id, this.grid.worldToGrid(actor.container.x, actor.container.y)]));
    const guestCells = new Map(this.guests.map((guest) => [guest.id, this.grid.worldToGrid(guest.container.x, guest.container.y)]));
    this.clearPedestrians();
    this.clearTransientVisitors();
    this.stabilizePeopleForViewRotation();
    this.restaurantViewRotationStep = Phaser.Math.Wrap(this.restaurantViewRotationStep + deltaSteps, 0, 4);
    this.grid.setViewRotationStep(this.restaurantViewRotationStep);
    this.invalidateSpatialCaches();
    this.refreshRestaurantShellAndGrid();
    this.reprojectPeopleForCurrentView(actorCells, guestCells);
    this.renderFurniture();
    this.frameRestaurantMap();
    if (this.viewRotationText) {
      this.setTextIfChanged(this.viewRotationText, `${this.restaurantViewRotationStep * 90}`);
    }
    this.updatePreview(this.input.activePointer);
    this.updateStats(`View rotated ${this.restaurantViewRotationStep * 90} degrees`);
  }

  private invalidateSpatialCaches(): void {
    this.diningSeatsCacheKey = "";
    this.diningSeatsCache = [];
    this.pathDistanceCache.clear();
  }

  private stabilizePeopleForViewRotation(): void {
    const activeGuestIds = new Set<string>();
    const guestsToRemove = new Set<string>();

    this.cleaningSeatUids.clear();
    this.guests.forEach((guest) => {
      this.stopPersonMotion(guest.container, guest.body);
      guest.container.setAlpha(1);

      if (guest.state === "leaving") {
        guestsToRemove.add(guest.id);
        guest.container.destroy();
        return;
      }

      if (guest.state === "entering") {
        guest.state = "waitingToOrder";
        guest.bubble.setText("Ready to order");
        guest.seatedAt = this.time.now;
        guest.patience = this.getGuestPatienceSeconds(guest);
      } else if (guest.state === "paying") {
        this.stopGuestEatingAnimation(guest);
        guest.state = "served";
        guest.bubble.setText("Payment pending");
      }

      activeGuestIds.add(guest.id);
    });

    if (guestsToRemove.size > 0) {
      this.guests = this.guests.filter((guest) => !guestsToRemove.has(guest.id));
    }

    this.tickets = this.tickets
      .filter((ticket) => activeGuestIds.has(ticket.guestId))
      .map((ticket) => {
        if (ticket.state !== "serving") {
          return ticket;
        }

        ticket.state = ticket.serviceKind === "order" ? "ordering" : "ready";
        ticket.serviceKind = undefined;
        ticket.serviceStartedAt = undefined;
        ticket.preferredWaiterId = undefined;
        return ticket;
      });

    this.actors.forEach((actor) => {
      this.stopPersonMotion(actor.container, actor.body);
      if (actor.role !== "chef" || actor.task !== "cooking") {
        this.showWaiterCarriedPlate(actor, false);
      }
    });
  }

  private reprojectPeopleForCurrentView(
    actorCells: Map<string, GridPosition | null>,
    guestCells: Map<string, GridPosition | null>,
  ): void {
    const diningSeats = this.getDiningSeats();
    const seatsByUid = new Map(diningSeats.map((seat) => [seat.seatUid, seat]));
    const cookingTicketsByStation = new Map<number, MealTicket>();
    this.tickets.forEach((ticket) => {
      if (ticket.state === "cooking" && typeof ticket.stationIndex === "number") {
        cookingTicketsByStation.set(ticket.stationIndex, ticket);
      }
    });

    const guestsToRemove = new Set<string>();
    this.guests.forEach((guest) => {
      const seat = seatsByUid.get(guest.seatUid);
      const previousCell = guestCells.get(guest.id);
      if (!seat && !previousCell) {
        guestsToRemove.add(guest.id);
        guest.container.destroy();
        return;
      }

      if (seat) {
        guest.seat = seat.seat;
        guest.serviceSpot = seat.serviceSpot;
        guest.cleanupSpot = seat.cleanupSpot;
        guest.seatedFacing = seat.seatedFacing;
      }

      if (seat && guest.state !== "leaving") {
        guest.container.setPosition(seat.seat.x, seat.seat.y);
        this.drawPersonPose(guest.body, guest.legs, guest.seatedFacing, 0, true);
      } else if (previousCell) {
        const point = this.getCellCenter(previousCell);
        guest.container.setPosition(point.x, point.y);
      }
    });
    if (guestsToRemove.size > 0) {
      this.guests = this.guests.filter((guest) => !guestsToRemove.has(guest.id));
      this.tickets = this.tickets.filter((ticket) => !guestsToRemove.has(ticket.guestId));
    }

    (["chef", "waiter", "errand"] as StaffRole[]).forEach((role) => {
      const roleActors = this.actors.filter((actor) => actor.role === role);
      roleActors.forEach((actor, index) => {
        this.stopPersonMotion(actor.container, actor.body);
        this.stopChefCookingAnimation(actor);
        const cookingTicket = role === "chef" ? cookingTicketsByStation.get(index) : undefined;
        const previousCell = actorCells.get(actor.id);
        const fallbackPoint =
          role === "chef"
            ? this.getChefStationPoint(index)
            : role === "waiter"
              ? this.getWaiterHomePoint(index)
              : this.getErrandHomePoint(index);
        const point = cookingTicket
          ? this.getChefStationPoint(index)
          : previousCell && role !== "chef"
            ? this.getCellCenter(previousCell)
            : fallbackPoint;
        actor.container.setPosition(point.x, point.y);
        actor.task = cookingTicket ? "cooking" : "idle";
        actor.busyUntil = this.time.now + 350;
        actor.bubble.setText(
          cookingTicket
            ? `Cooking ${cookingTicket.recipe.name}`
            : role === "chef" && index >= this.getStoveCount()
              ? "Need stove"
              : "Ready",
        );
        this.drawPersonPose(actor.body, actor.legs, role === "chef" ? "up" : "down", 0, false);
        if (cookingTicket) {
          this.startChefCookingAnimation(actor, index);
        }
      });
    });

    this.getPersonVisualTargets().forEach((person) => {
      person.container.setData("personalOffsetX", 0);
      person.container.setData("personalOffsetY", 0);
      this.applyPersonVisualOffset(person, new Phaser.Math.Vector2(0, 0));
    });

    this.tickets.forEach((ticket) => {
      ticket.readyPlate?.destroy();
      delete ticket.readyPlate;
      if (ticket.state === "ready") {
        const platePoint = this.getReadyTicketPlatePoint(ticket);
        ticket.readyPlate = this.createReadyFoodPlateAt(platePoint.x, platePoint.y, 1, this.getReadyPlateSortY(ticket.stationIndex));
      }
    });
  }

  private stopPersonMotion(container: Phaser.GameObjects.Container, body: Phaser.GameObjects.Graphics): void {
    const motionTween = container.getData("motionTween") as Phaser.Tweens.Tween | undefined;
    motionTween?.stop();
    container.setData("motionTween", undefined);
    this.stopWalkingAnimation(container, body);
  }

  private isPointerInRestaurantView(pointer: Phaser.Input.Pointer): boolean {
    if (!this.restaurantLayer) {
      return false;
    }

    const local = this.getRestaurantPointerPosition(pointer);
    const bounds = this.getIsoBounds(this.getVisibleExpansionCells());
    const screenInViewport =
      pointer.x >= mapViewport.x &&
      pointer.x <= mapViewport.x + mapViewport.width &&
      pointer.y >= mapViewport.y &&
      pointer.y <= mapViewport.y + mapViewport.height;
    if (!screenInViewport) {
      return false;
    }

    const left = bounds.minX - 140;
    const top = bounds.minY - 180;
    const right = bounds.maxX + 140;
    const bottom = bounds.maxY + 180;
    return local.x >= left && local.x <= right && local.y >= top && local.y <= bottom;
  }

  private handleScrollbarPointer(pointer: Phaser.Input.Pointer): boolean {
    const region = this.getScrollbarRegions().find((candidate) => this.isPointerInsideScrollbar(pointer, candidate));
    if (!region) {
      return false;
    }

    if (region.maxOffset <= 0) {
      return true;
    }

    const metrics = this.getScrollbarThumbMetrics(region);
    const insideThumb = pointer.y >= metrics.thumbY && pointer.y <= metrics.thumbY + metrics.thumbHeight;
    const grabOffsetY = insideThumb ? pointer.y - metrics.thumbY : metrics.thumbHeight / 2;
    this.activeScrollbarDrag = { target: region.target, grabOffsetY };
    this.setScrollbarOffsetFromPointer(region, pointer.y, grabOffsetY);
    return true;
  }

  private dragActiveScrollbar(pointer: Phaser.Input.Pointer): void {
    if (!this.activeScrollbarDrag) {
      return;
    }

    const region = this.getScrollbarRegionByTarget(this.activeScrollbarDrag.target);
    if (!region) {
      this.activeScrollbarDrag = null;
      return;
    }

    this.setScrollbarOffsetFromPointer(region, pointer.y, this.activeScrollbarDrag.grabOffsetY);
  }

  private getScrollbarRegionByTarget(target: ScrollbarTarget): ScrollbarRegion | null {
    return this.getScrollbarRegions().find((region) => region.target === target) ?? null;
  }

  private getScrollbarRegions(): ScrollbarRegion[] {
    const regions: ScrollbarRegion[] = [
      {
        target: "build",
        x: buildScrollX,
        y: buildScrollY,
        width: buildScrollWidth,
        height: buildScrollHeight,
        maxOffset: this.getBuildScrollMax(),
        currentOffset: this.buildScrollOffset,
      },
    ];

    if (this.activeRightTab === "menu") {
      regions.push({
        target: "recipe",
        x: recipeScrollX,
        y: recipeScrollY,
        width: recipeScrollWidth,
        height: recipeScrollHeight,
        maxOffset: this.getRecipeScrollMax(),
        currentOffset: this.recipeScrollOffset,
      });
    }

    if (this.activeRightTab === "stock") {
      regions.push(
        {
          target: "inNeed",
          x: inNeedScrollX,
          y: this.getStockContentScreenY(inNeedScrollY),
          width: inNeedScrollWidth,
          height: inNeedScrollHeight,
          maxOffset: this.getInNeedScrollMax(),
          currentOffset: this.inNeedScrollOffset,
        },
        {
          target: "pantry",
          x: pantryScrollX,
          y: this.getStockContentScreenY(pantryScrollY),
          width: pantryScrollWidth,
          height: pantryScrollHeight,
          maxOffset: this.getPantryScrollMax(),
          currentOffset: this.pantryScrollOffset,
        },
        {
          target: "stock",
          x: stockTabScrollX,
          y: stockTabScrollY,
          width: stockTabScrollWidth,
          height: stockTabScrollHeight,
          maxOffset: this.getStockScrollMax(),
          currentOffset: this.stockScrollOffset,
        },
      );
    }

    return regions;
  }

  private isPointerInsideScrollbar(pointer: Phaser.Input.Pointer, region: ScrollbarRegion): boolean {
    const scrollbarX = region.x + region.width - panelScrollbarWidth - 4;
    const insideTrack =
      pointer.x >= scrollbarX - 4 &&
      pointer.x <= scrollbarX + panelScrollbarWidth + 4 &&
      pointer.y >= region.y &&
      pointer.y <= region.y + region.height;
    if (!insideTrack) {
      return false;
    }

    if (["ingredient", "inNeed", "pantry"].includes(region.target)) {
      return pointer.y >= stockTabScrollY && pointer.y <= stockTabScrollY + stockTabScrollHeight;
    }

    return true;
  }

  private getScrollbarThumbMetrics(region: ScrollbarRegion): { thumbY: number; thumbHeight: number; thumbTravel: number } {
    const contentHeight = region.height + region.maxOffset;
    const thumbHeight = region.maxOffset <= 0 ? region.height : Math.max(24, (region.height / contentHeight) * region.height);
    const thumbTravel = region.height - thumbHeight;
    const thumbY = region.y + (region.maxOffset <= 0 ? 0 : (region.currentOffset / region.maxOffset) * thumbTravel);
    return { thumbY, thumbHeight, thumbTravel };
  }

  private setScrollbarOffsetFromPointer(region: ScrollbarRegion, pointerY: number, grabOffsetY: number): void {
    if (region.maxOffset <= 0) {
      return;
    }

    const { thumbTravel } = this.getScrollbarThumbMetrics(region);
    const thumbY = Phaser.Math.Clamp(pointerY - grabOffsetY, region.y, region.y + thumbTravel);
    const percent = thumbTravel <= 0 ? 0 : (thumbY - region.y) / thumbTravel;
    this.setScrollbarOffset(region.target, region.maxOffset * percent);
  }

  private setScrollbarOffset(target: ScrollbarTarget, offset: number): void {
    switch (target) {
      case "build":
        this.buildScrollOffset = offset;
        this.clampBuildScroll();
        break;
      case "recipe":
        this.recipeScrollOffset = offset;
        this.clampRecipeScroll();
        break;
      case "ingredient":
        this.ingredientScrollOffset = offset;
        this.clampIngredientScroll();
        break;
      case "inNeed":
        this.inNeedScrollOffset = offset;
        this.clampInNeedScroll();
        break;
      case "pantry":
        this.pantryScrollOffset = offset;
        this.clampPantryScroll();
        break;
      case "stock":
        this.stockScrollOffset = offset;
        this.clampStockScroll();
        break;
    }
  }

  private isPointInside(pointer: Phaser.Input.Pointer, x: number, y: number, width: number, height: number): boolean {
    return pointer.x >= x && pointer.x <= x + width && pointer.y >= y && pointer.y <= y + height;
  }

  private getStockContentScreenY(y: number): number {
    return y - this.stockScrollOffset;
  }

  private isPointInsideStockContent(pointer: Phaser.Input.Pointer, x: number, y: number, width: number, height: number): boolean {
    return this.isPointInside(pointer, x, this.getStockContentScreenY(y), width, height);
  }

  private clampRecipeScroll(): void {
    this.recipeScrollOffset = Phaser.Math.Clamp(this.recipeScrollOffset, 0, this.getRecipeScrollMax());
    this.recipeScrollContainer.setY(recipeScrollY - this.recipeScrollOffset);
    this.updateRecipeButtonInteractivity();
    this.drawScrollBar(
      this.recipeScrollbar,
      recipeScrollX,
      recipeScrollY,
      recipeScrollWidth,
      recipeScrollHeight,
      this.recipeScrollOffset,
      this.getRecipeScrollMax(),
    );
  }

  private clampBuildScroll(): void {
    if (!this.buildScrollContainer) {
      return;
    }

    this.buildScrollOffset = Phaser.Math.Clamp(this.buildScrollOffset, 0, this.getBuildScrollMax());
    this.buildScrollContainer.setY(buildScrollY - this.buildScrollOffset);
    this.updateBuildButtonInteractivity();
    this.drawScrollBar(
      this.buildScrollbar,
      buildScrollX,
      buildScrollY,
      buildScrollWidth,
      buildScrollHeight,
      this.buildScrollOffset,
      this.getBuildScrollMax(),
    );
  }

  private clampIngredientScroll(): void {
    if (!this.ingredientScrollContainer || !this.ingredientScrollbar) {
      return;
    }

    this.ingredientScrollOffset = Phaser.Math.Clamp(this.ingredientScrollOffset, 0, this.getIngredientScrollMax());
    this.ingredientScrollContainer.setY(ingredientScrollY - this.ingredientScrollOffset);
    this.updateStockInnerMasks();
    this.updateIngredientButtonInteractivity();
    this.drawScrollBar(
      this.ingredientScrollbar,
      ingredientScrollX,
      ingredientScrollY,
      ingredientScrollWidth,
      ingredientScrollHeight,
      this.ingredientScrollOffset,
      this.getIngredientScrollMax(),
    );
  }

  private clampInNeedScroll(): void {
    this.inNeedScrollOffset = Phaser.Math.Clamp(this.inNeedScrollOffset, 0, this.getInNeedScrollMax());
    this.inNeedText.setY(-this.inNeedScrollOffset);
    this.updateStockInnerMasks();
    this.drawScrollBar(
      this.inNeedScrollbar,
      inNeedScrollX,
      inNeedScrollY,
      inNeedScrollWidth,
      inNeedScrollHeight,
      this.inNeedScrollOffset,
      this.getInNeedScrollMax(),
    );
  }

  private clampPantryScroll(): void {
    this.pantryScrollOffset = Phaser.Math.Clamp(this.pantryScrollOffset, 0, this.getPantryScrollMax());
    this.pantryText.setY(-this.pantryScrollOffset);
    this.updateStockInnerMasks();
    this.drawScrollBar(
      this.pantryScrollbar,
      pantryScrollX,
      pantryScrollY,
      pantryScrollWidth,
      pantryScrollHeight,
      this.pantryScrollOffset,
      this.getPantryScrollMax(),
    );
  }

  private clampStockScroll(): void {
    if (!this.stockScrollContainer) {
      return;
    }

    this.stockScrollOffset = Phaser.Math.Clamp(this.stockScrollOffset, 0, this.getStockScrollMax());
    this.stockScrollContainer.setY(-this.stockScrollOffset);
    this.updateStockInnerMasks();
    this.updateStockActionButtonInteractivity();
    this.drawScrollBar(
      this.stockScrollbar,
      stockTabScrollX,
      stockTabScrollY,
      stockTabScrollWidth,
      stockTabScrollHeight,
      this.stockScrollOffset,
      this.getStockScrollMax(),
    );
  }

  private updateStockInnerMasks(): void {
    if (this.ingredientMaskShape) {
      this.ingredientMaskShape.setPosition(ingredientScrollX, this.getStockContentScreenY(ingredientScrollY));
    }
    if (this.inNeedMaskShape) {
      this.inNeedMaskShape.setPosition(inNeedScrollX, this.getStockContentScreenY(inNeedScrollY));
    }
    if (this.pantryMaskShape) {
      this.pantryMaskShape.setPosition(pantryScrollX, this.getStockContentScreenY(pantryScrollY));
    }
  }

  private drawScrollBar(
    scrollbar: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    offset: number,
    maxOffset: number,
  ): void {
    if (!scrollbar) {
      return;
    }

    const contentHeight = height + maxOffset;
    const scrollbarX = x + width - panelScrollbarWidth - 4;
    const thumbHeight = maxOffset <= 0 ? height : Math.max(24, (height / contentHeight) * height);
    const thumbTravel = height - thumbHeight;
    const thumbY = y + (maxOffset <= 0 ? 0 : (offset / maxOffset) * thumbTravel);

    scrollbar.clear();
    scrollbar.fillStyle(0xe7d2aa, 1);
    scrollbar.fillRoundedRect(scrollbarX, y, panelScrollbarWidth, height, 4);
    scrollbar.fillStyle(maxOffset <= 0 ? 0xc9ac7e : 0x8f6251, 1);
    scrollbar.fillRoundedRect(scrollbarX, thumbY, panelScrollbarWidth, thumbHeight, 4);
  }

  private getRecipeScrollMax(): number {
    return Math.max(0, this.recipeScrollContentHeight - recipeScrollHeight);
  }

  private getBuildScrollMax(): number {
    return Math.max(0, this.buildScrollContentHeight - buildScrollHeight);
  }

  private getIngredientScrollMax(): number {
    return Math.max(0, this.cooking.getPantry().length * 24 - ingredientScrollHeight);
  }

  private getInNeedScrollMax(): number {
    return Math.max(0, this.inNeedText.height - inNeedScrollHeight);
  }

  private getPantryScrollMax(): number {
    return Math.max(0, this.pantryText.height - pantryScrollHeight);
  }

  private getStockScrollMax(): number {
    return Math.max(0, this.stockScrollContentHeight - stockTabScrollHeight);
  }

  private updateRecipeButtonInteractivity(): void {
    this.menuButtons.forEach(({ button, upgradeButton }) => {
      const top = this.recipeScrollContainer.y + button.y;
      const bottom = top + button.height;
      const visible = this.activeRightTab === "menu" && bottom > recipeScrollY && top < recipeScrollY + recipeScrollHeight;
      if (visible) {
        button.setInteractive({ useHandCursor: true });
        upgradeButton.setInteractive({ useHandCursor: true });
      } else {
        button.disableInteractive();
        upgradeButton.disableInteractive();
      }
    });
  }

  private updateBuildButtonInteractivity(): void {
    this.buildButtons.forEach(({ button }) => {
      const top = this.buildScrollContainer.y + button.y;
      const bottom = top + button.height;
      const visible = bottom > buildScrollY && top < buildScrollY + buildScrollHeight;
      if (visible) {
        button.setInteractive({ useHandCursor: true });
      } else {
        button.disableInteractive();
      }
    });
  }

  private updateIngredientButtonInteractivity(): void {
    this.ingredientButtons.forEach(({ button }) => {
      const top = this.getStockContentScreenY(this.ingredientScrollContainer.y + button.y);
      const bottom = top + button.height;
      const listTop = this.getStockContentScreenY(ingredientScrollY);
      const listBottom = listTop + ingredientScrollHeight;
      const tabBottom = stockTabScrollY + stockTabScrollHeight;
      const visible =
        this.activeRightTab === "stock" &&
        bottom > listTop &&
        top < listBottom &&
        bottom > stockTabScrollY &&
        top < tabBottom;
      if (visible) {
        button.setInteractive({ useHandCursor: true });
      } else {
        button.disableInteractive();
      }
    });
  }

  private updateStockActionButtonInteractivity(): void {
    this.stockActionButtons.forEach((button) => {
      const top = this.getStockContentScreenY(button.y);
      const bottom = top + button.height;
      const visible = this.activeRightTab === "stock" && bottom > stockTabScrollY && top < stockTabScrollY + stockTabScrollHeight;
      if (visible) {
        button.setInteractive({ useHandCursor: true });
      } else {
        button.disableInteractive();
      }
    });
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.handleScrollbarPointer(pointer)) {
      return;
    }

    if (this.mapViewMode !== "inside") {
      return;
    }

    if (!this.isPointerInRestaurantView(pointer)) {
      return;
    }

    this.panStartPointer = new Phaser.Math.Vector2(pointer.x, pointer.y);
    this.panStartLayer = new Phaser.Math.Vector2(this.restaurantLayer.x, this.restaurantLayer.y);
    this.isPanningRestaurant = false;

    const localPointer = this.getRestaurantPointerPosition(pointer);
    if (this.handleExpansionSignClick(localPointer.x, localPointer.y)) {
      return;
    }

    if (this.mode === "move" && !this.placement.getSelectedPlacedFurniture()) {
      const wallMountedItem = this.getMovableWallMountedFurnitureAtPoint(localPointer);
      if (wallMountedItem) {
        const result = this.placement.selectPlacedFurniture(wallMountedItem.uid);
        this.updatePreview(pointer);
        this.updateStats(result.message);
        return;
      }
    }

    const activeWallDefinition = this.getActiveWallPlacementDefinition();
    if (activeWallDefinition) {
      const result = this.applyWallPlacementAction(activeWallDefinition, localPointer);
      if (result.ok) {
        this.renderFurniture();
        this.persistQuietly();
      }
      this.updateStats(result.message);
      return;
    }

    const gridPosition = this.grid.worldToGrid(localPointer.x, localPointer.y);
    if (!gridPosition) {
      return;
    }

    if (this.mode === "seat") {
      const result = this.toggleSeatAt(localPointer.x, localPointer.y);
      if (result.ok) {
        this.renderFurniture();
        this.persistQuietly();
      }
      this.updateStats(result.message);
      return;
    }

    if (this.isFloorPaintingSelected()) {
      this.paintFloorAt(gridPosition);
      return;
    }

    const result = this.applyGridAction(gridPosition);
    if (result.ok) {
      this.renderFurniture();
      this.syncChefStations(true);
      this.persistQuietly();
    }

    this.updateStats(result.message);
  }

  private getMovableWallMountedFurnitureAtPoint(point: Phaser.Math.Vector2): PlacedFurniture | null {
    const candidates = this.getFurnitureRenderOrder()
      .filter((item) => {
        const definition = getFurnitureDefinition(item.furnitureId);
        const renderItem = this.getWallMountedRenderItem(item, definition);
        return definition.category === "wallDecoration" &&
          this.isWallMountedFurniture(definition) &&
          !this.isDoorFurniture(definition.id) &&
          !this.isWallDecorationOnHiddenWall(renderItem, definition);
      })
      .reverse();

    return candidates.find((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      const renderItem = this.getWallMountedRenderItem(item, definition);
      const context = this.createFurnitureVisualContext(
        definition,
        renderItem,
        this.getViewAdjustedFurnitureRotation(renderItem.rotation ?? 0),
      );
      return this.getPointToPolygonDistance(point, this.getWallDecorationPanel(context)) <= 10;
    }) ?? null;
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.activeScrollbarDrag) {
      this.dragActiveScrollbar(pointer);
      return;
    }

    if (this.mapViewMode !== "inside") {
      this.preview?.setVisible(false);
      this.previewHint?.setVisible(false);
      return;
    }

    this.updatePreview(pointer);
    this.updatePlacedFurnitureHover(pointer);
    if (pointer.isDown && this.panStartPointer && this.panStartLayer && !this.isFloorPaintingSelected()) {
      const dragX = pointer.x - this.panStartPointer.x;
      const dragY = pointer.y - this.panStartPointer.y;
      if (this.isPanningRestaurant || Math.abs(dragX) + Math.abs(dragY) > 8) {
        this.isPanningRestaurant = true;
        this.restaurantLayer.setPosition(this.panStartLayer.x + dragX, this.panStartLayer.y + dragY);
        this.updatePreview(pointer);
        return;
      }
    }

    if (!pointer.isDown || !this.isFloorPaintingSelected()) {
      return;
    }

    if (!this.isPointerInRestaurantView(pointer)) {
      return;
    }

    const localPointer = this.getRestaurantPointerPosition(pointer);
    const gridPosition = this.grid.worldToGrid(localPointer.x, localPointer.y);
    if (!gridPosition) {
      return;
    }

    this.paintFloorAt(gridPosition);
  }

  private isFloorPaintingSelected(): boolean {
    if (this.mode !== "build") {
      return false;
    }

    const selectedId = this.placement.getSelectedFurnitureId();
    return Boolean(selectedId && getFurnitureDefinition(selectedId).category === "flooring");
  }

  private paintFloorAt(position: GridPosition): void {
    const cellKey = `${position.x},${position.y}`;
    if (this.lastPaintedFloorCellKey === cellKey) {
      return;
    }

    this.lastPaintedFloorCellKey = cellKey;
    const result = this.applyGridAction(position);
    if (result.ok) {
      this.renderFurniture();
      this.persistQuietly();
    }
    this.updateStats(result.message);
  }

  private getActiveWallPlacementDefinition(): FurnitureDefinition | null {
    if (this.mode !== "build" && this.mode !== "move") {
      return null;
    }

    const furnitureId = this.mode === "move"
      ? this.placement.getSelectedPlacedFurniture()?.furnitureId ?? null
      : this.placement.getSelectedFurnitureId();
    if (!furnitureId) {
      return null;
    }

    const definition = getFurnitureDefinition(furnitureId);
    return this.isWallMountedFurniture(definition) ? definition : null;
  }

  private applyWallPlacementAction(
    definition: FurnitureDefinition,
    localPointer: Phaser.Math.Vector2,
  ): { ok: boolean; message: string } {
    const target = this.getWallPlacementTarget(definition, localPointer);
    if (!target) {
      const message = this.isDoorFurniture(definition.id)
        ? "Doors replace the front entrance only"
        : `Choose a wall for ${definition.name}`;
      if (this.isDoorFurniture(definition.id)) {
        this.showToast(message, "error");
      }
      return { ok: false, message };
    }

    if (this.isDoorFurniture(definition.id)) {
      return this.replaceEntranceDoor(definition, target);
    }

    this.placement.setSelectedRotation(target.rotation);
    const ignoreUid = this.mode === "move" ? this.placement.getSelectedPlacedUid() ?? undefined : undefined;
    const hasSpace = this.grid.canPlace(definition, target.position, this.placement.getFurniture(), ignoreUid, {
      ignoreFlooring: true,
      rotation: target.rotation,
    });
    if (!hasSpace) {
      return { ok: false, message: "That wall spot already has decor" };
    }

    if (this.mode === "move") {
      return this.placement.tryMoveSelected(target.position);
    }

    const cost = this.getFurniturePurchaseCost(definition);
    if (!this.economy.canAfford(cost)) {
      const shortfall = Math.max(0, cost - this.economy.getMoney());
      return { ok: false, message: `Not enough money: need $${shortfall} more for ${definition.name}` };
    }

    return this.placement.tryPlaceSelected(target.position);
  }

  private replaceEntranceDoor(definition: FurnitureDefinition, target: WallPlacementTarget): { ok: boolean; message: string } {
    const currentDoor = this.getEntranceDoorItem();
    const position = this.getEntranceDoorSlotPosition();
    const normalizedDoor: PlacedFurniture = {
      uid: currentDoor?.uid ?? Phaser.Math.RND.uuid(),
      furnitureId: definition.id,
      position,
      rotation: target.rotation,
    };

    if (currentDoor?.furnitureId === definition.id || (!currentDoor && definition.id === "plain-door")) {
      const changed = currentDoor
        ? currentDoor.position.x !== position.x ||
          currentDoor.position.y !== position.y ||
          (currentDoor.rotation ?? 0) !== target.rotation
        : false;
      if (changed) {
        this.placement.setFurniture([
          ...this.placement.getFurniture().filter((item) => !this.isDoorFurniture(item.furnitureId)),
          normalizedDoor,
        ]);
        this.refreshRestaurantShellAndGrid();
        this.requestFurnitureRender("entrance-door-normalized");
        this.persistQuietly();
      }
      this.placement.clearSelection();
      const message = `${definition.name} is already installed`;
      this.showToast(message, "info");
      return { ok: true, message };
    }

    const cost = this.getFurniturePurchaseCost(definition);
    if (!this.spendMoney(cost, "decor")) {
      const shortfall = Math.max(0, cost - this.economy.getMoney());
      const message = `Not enough money: need $${shortfall} more for ${definition.name}`;
      this.showToast(message, "error");
      return { ok: false, message };
    }

    this.placement.setFurniture([
      ...this.placement.getFurniture().filter((item) => !this.isDoorFurniture(item.furnitureId)),
      normalizedDoor,
    ]);
    this.placement.clearSelection();
    this.diningSeatsCacheKey = "";
    this.pathDistanceCache.clear();
    this.refreshRestaurantShellAndGrid();
    this.requestFurnitureRender("entrance-door-replaced");
    this.persistQuietly();

    const message = `${definition.name} installed at the entrance`;
    this.showToast(message, "success");
    return { ok: true, message };
  }

  private applyGridAction(position: GridPosition): { ok: boolean; message: string } {
    if (this.mode === "remove") {
      return this.placement.removeAt(position);
    }

    if (this.mode === "move") {
      const moveValidation = this.validateSelectedMove(position);
      if (!moveValidation.ok) {
        return moveValidation;
      }

      const moveResult = this.placement.tryMoveSelected(position);
      if (moveResult.ok) {
        return moveResult;
      }

      return this.placement.tryPlaceSelected(position);
    }

    if (this.mode === "cook") {
      this.spawnGuests(this.time.now, true);
      return { ok: true, message: "A guest was invited in for service testing" };
    }

    const placementValidation = this.validateSelectedPlacement(position);
    if (!placementValidation.ok) {
      return placementValidation;
    }

    const selectedId = this.placement.getSelectedFurnitureId();
    if (selectedId) {
      const definition = getFurnitureDefinition(selectedId);
      const cost = this.getFurniturePurchaseCost(definition);
      if (this.canPlaceSelectedAt(definition, position) && !this.economy.canAfford(cost)) {
        const shortfall = Math.max(0, cost - this.economy.getMoney());
        return { ok: false, message: `Not enough money: need $${shortfall} more for ${definition.name}` };
      }
    }

    return this.placement.tryPlaceSelected(position);
  }

  private canPlaceSelectedAt(definition: FurnitureDefinition, position: GridPosition): boolean {
    const ruleValidation = this.validateSelectedPlacement(position);
    return this.grid.canPlace(definition, position, this.placement.getFurniture(), undefined, {
      ignoreFlooring: definition.category !== "flooring",
      rotation: this.placement.getSelectedRotation(),
    }) && ruleValidation.ok;
  }

  private getBuildPlacementPreview(definition: FurnitureDefinition, position: GridPosition): {
    ok: boolean;
    affordable: boolean;
    message: string;
  } {
    const ruleValidation = this.validateSelectedPlacement(position);
    if (!ruleValidation.ok) {
      return { ok: false, affordable: true, message: ruleValidation.message || "Blocked" };
    }

    const hasSpace = this.grid.canPlace(definition, position, this.placement.getFurniture(), undefined, {
      ignoreFlooring: definition.category !== "flooring",
      rotation: this.placement.getSelectedRotation(),
    });
    if (!hasSpace) {
      return { ok: false, affordable: true, message: "Blocked" };
    }

    const cost = this.getFurniturePurchaseCost(definition);
    if (!this.economy.canAfford(cost)) {
      const shortfall = Math.max(0, cost - this.economy.getMoney());
      return { ok: true, affordable: false, message: `Need $${shortfall} more` };
    }

    return { ok: true, affordable: true, message: "R rotate" };
  }

  private getMovePlacementPreview(definition: FurnitureDefinition, position: GridPosition): {
    ok: boolean;
    affordable: boolean;
    message: string;
  } {
    const placed = this.placement.getSelectedPlacedFurniture();
    if (!placed) {
      return { ok: false, affordable: true, message: "Select furniture first" };
    }

    const ruleValidation = this.validateSelectedMove(position);
    if (!ruleValidation.ok) {
      return { ok: false, affordable: true, message: ruleValidation.message || "Blocked" };
    }

    const hasSpace = this.grid.canPlace(definition, position, this.placement.getFurniture(), placed.uid, {
      ignoreFlooring: definition.category !== "flooring",
      rotation: this.placement.getSelectedRotation(),
    });
    if (!hasSpace) {
      return { ok: false, affordable: true, message: "Spot occupied" };
    }

    return { ok: true, affordable: true, message: "R rotate" };
  }

  private canMoveSelectedAt(position: GridPosition): boolean {
    const placed = this.placement.getSelectedPlacedFurniture();
    if (!placed) {
      return false;
    }

    const definition = getFurnitureDefinition(placed.furnitureId);
    return this.getMovePlacementPreview(definition, position).ok;
  }

  private rotateSelection(): void {
    if (this.getActiveWallPlacementDefinition()) {
      this.updatePreview(this.input.activePointer);
      this.updateStats("Wall items rotate automatically");
      return;
    }

    if (this.mode === "move") {
      const result = this.placement.rotateSelectedPlaced();
      this.updatePreview(this.input.activePointer);
      this.updateStats(result.message);
      return;
    }

    if (this.mode === "build" && this.placement.getSelectedFurnitureId()) {
      const rotation = this.placement.rotateSelectedCatalog();
      this.updatePreview(this.input.activePointer);
      this.updateStats(`Rotation: ${rotation} degrees`);
    }
  }

  private validateSelectedPlacement(position: GridPosition): { ok: boolean; message: string } {
    const selectedId = this.placement.getSelectedFurnitureId();
    if (!selectedId) {
      return { ok: true, message: "" };
    }

    if (!this.isFurnitureWithinUnlockedArea(selectedId, position, this.placement.getSelectedRotation())) {
      return { ok: false, message: "Buy expansion first" };
    }

    const ruleValidation = this.validateFurnitureRules(selectedId, position);
    if (!ruleValidation.ok) {
      return ruleValidation;
    }

    return this.validateAccessRules(selectedId, position, this.placement.getSelectedRotation());
  }

  private validateSelectedMove(position: GridPosition): { ok: boolean; message: string } {
    const selectedUid = this.placement.getSelectedPlacedUid();
    const placed = this.placement.getFurniture().find((item) => item.uid === selectedUid);
    if (!placed) {
      return { ok: true, message: "" };
    }

    if (!this.isFurnitureWithinUnlockedArea(placed.furnitureId, position, this.placement.getSelectedRotation())) {
      return { ok: false, message: "Buy expansion first" };
    }

    const ruleValidation = this.validateFurnitureRules(placed.furnitureId, position, placed.uid);
    if (!ruleValidation.ok) {
      return ruleValidation;
    }

    return this.validateAccessRules(placed.furnitureId, position, this.placement.getSelectedRotation(), placed.uid);
  }

  private validateFurnitureRules(furnitureId: string, position: GridPosition, ignoreUid?: string): { ok: boolean; message: string } {
    const definition = getFurnitureDefinition(furnitureId);
    if (definition.category !== "chair") {
      return { ok: true, message: "" };
    }

    const rotation = this.placement.getSelectedRotation();
    const previewChair = { uid: "placement-preview", furnitureId, position, rotation };
    const furnitureWithPreview = this.getFurnitureWithCandidate(furnitureId, position, rotation, ignoreUid);
    const tables = furnitureWithPreview.filter((item) => getFurnitureDefinition(item.furnitureId).category === "table");
    const nearbyTables = this.getNearbyTables(previewChair, tables);
    if (nearbyTables.length === 0) {
      return { ok: true, message: "" };
    }

    const assignedSeats = this.getDiningSeats(furnitureWithPreview).filter((seat) => seat.chairUid === previewChair.uid);
    if (assignedSeats.length > 0) {
      return { ok: true, message: "" };
    }

    const largestTable = nearbyTables
      .map((table) => ({
        definition: getFurnitureDefinition(table.furnitureId),
        capacity: this.getTableSeatCapacity(getFurnitureDefinition(table.furnitureId)),
      }))
      .sort((a, b) => b.capacity - a.capacity)[0];

    return {
      ok: false,
      message: largestTable
        ? `Nearby tables are full (${largestTable.definition.name}: ${largestTable.capacity} seats)`
        : "Nearby tables are full",
    };
  }

  private validateAccessRules(
    furnitureId: string,
    position: GridPosition,
    rotation: number,
    ignoreUid?: string,
  ): { ok: boolean; message: string } {
    const definition = getFurnitureDefinition(furnitureId);
    if (this.isWalkableFurniture(definition)) {
      return { ok: true, message: "" };
    }

    if (definition.category === "chair" || definition.category === "table") {
      return { ok: true, message: "" };
    }

    const baseFurniture = this.placement.getFurniture().filter((item) => item.uid !== ignoreUid);
    const candidateFurniture = this.getFurnitureWithCandidate(furnitureId, position, rotation, ignoreUid);
    const waiterHomePoint = this.getWaiterHomePoint();
    const baseRouteAnchorPoint = this.getStaffRouteAnchorPoint(baseFurniture);
    const candidateRouteAnchorPoint = this.getStaffRouteAnchorPoint(candidateFurniture);
    const restaurantExitPoint = this.getRestaurantExitPoint();
    const kitchenReachable =
      this.canReachPoint(waiterHomePoint, candidateRouteAnchorPoint, candidateFurniture) &&
      this.canReachPoint(candidateRouteAnchorPoint, restaurantExitPoint, candidateFurniture, true);
    const kitchenWasReachable =
      this.canReachPoint(waiterHomePoint, baseRouteAnchorPoint, baseFurniture) &&
      this.canReachPoint(baseRouteAnchorPoint, restaurantExitPoint, baseFurniture, true);
    if (kitchenWasReachable && !kitchenReachable) {
      return { ok: false, message: "Blocks staff route to kitchen" };
    }

    const baseChefStations = this.getChefStations(baseFurniture);
    const candidateChefStations = this.getChefStations(candidateFurniture);
    const blockedChef = candidateChefStations.some((station, index) => {
      const wasReachable = index >= baseChefStations.length || this.canReachPoint(baseRouteAnchorPoint, baseChefStations[index], baseFurniture);
      return wasReachable && !this.canReachPoint(candidateRouteAnchorPoint, station, candidateFurniture);
    });
    if (blockedChef) {
      return { ok: false, message: "Blocks waiter route to chef" };
    }

    const baseReachableSeats = new Set(
      this.getDiningSeats(baseFurniture)
        .filter((seat) => this.canReachPoint(baseRouteAnchorPoint, seat.serviceSpot, baseFurniture))
        .map((seat) => seat.seatUid),
    );
    const blockedSeat = this.getDiningSeats(candidateFurniture).some(
      (seat) => baseReachableSeats.has(seat.seatUid) && !this.canReachPoint(candidateRouteAnchorPoint, seat.serviceSpot, candidateFurniture),
    );
    if (blockedSeat) {
      return { ok: false, message: "Blocks waiter route to table" };
    }

    return { ok: true, message: "" };
  }

  private getFurnitureWithCandidate(
    furnitureId: string,
    position: GridPosition,
    rotation: number,
    ignoreUid?: string,
  ): PlacedFurniture[] {
    const candidate = { uid: "placement-preview", furnitureId, position, rotation };
    return [...this.placement.getFurniture().filter((item) => item.uid !== ignoreUid), candidate];
  }

  private toggleSeatAt(worldX: number, worldY: number): { ok: boolean; message: string } {
    const seats = this.getDiningSeats();
    const nearest = seats
      .map((seat) => ({
        seat,
        distance: Phaser.Math.Distance.Between(worldX, worldY, seat.seat.x, seat.seat.y),
      }))
      .sort((a, b) => a.distance - b.distance)[0];

    if (!nearest || nearest.distance > 34) {
      return { ok: false, message: "Click directly on a chair seat to disable or enable it" };
    }

    const occupiedSeats = this.getOccupiedSeatUids();
    if (occupiedSeats.has(nearest.seat.seatUid)) {
      return { ok: false, message: "That seat is occupied right now" };
    }

    const chair = this.placement.getFurniture().find((item) => item.uid === nearest.seat.chairUid);
    if (!chair) {
      return { ok: false, message: "Seat no longer exists" };
    }

    const disabled = new Set(chair.disabledSeatIndexes ?? []);
    if (disabled.has(nearest.seat.seatIndex)) {
      disabled.delete(nearest.seat.seatIndex);
    } else {
      disabled.add(nearest.seat.seatIndex);
    }

    chair.disabledSeatIndexes = [...disabled].sort((a, b) => a - b);
    if (chair.disabledSeatIndexes.length === 0) {
      delete chair.disabledSeatIndexes;
    }

    return {
      ok: true,
      message: disabled.has(nearest.seat.seatIndex) ? "Seat disabled" : "Seat enabled",
    };
  }

  private requestFurnitureRender(reason = "update"): void {
    this.pendingFurnitureRender = true;
    if (this.pendingFurnitureRenderReasons.size < 6) {
      this.pendingFurnitureRenderReasons.add(reason);
    }
  }

  private flushQueuedFurnitureRender(time = this.time.now): void {
    if (!this.pendingFurnitureRender) {
      return;
    }

    this.renderFurniture(true, time);
  }

  private renderFurniture(force = false, time = this.time.now): void {
    if (!force && time - this.lastFurnitureRenderAt < furnitureRenderCoalesceMs) {
      this.requestFurnitureRender("coalesced");
      return;
    }

    const startedAt = performance.now();
    this.pendingFurnitureRender = false;
    this.pendingFurnitureRenderReasons.clear();
    this.lastFurnitureRenderAt = time;
    this.pathDistanceCache.clear();
    this.diningSeatsCacheKey = "";
    this.furnitureLayer.removeAll(true);
    this.chairBackOverlayLayer.removeAll(true);
    this.clearSortableFurnitureRenders();
    this.expansionOverlayLayer.removeAll(true);
    this.expansionSignLayer.removeAll(true);
    this.renderExpansionOverlays();
    const occupiedSeatUids = this.getOccupiedSeatUids();
    const diningSeats = this.getDiningSeats();
    const diningSeatsByChair = new Map<string, DiningSeat[]>();
    diningSeats.forEach((seat) => {
      diningSeatsByChair.set(seat.chairUid, [...(diningSeatsByChair.get(seat.chairUid) ?? []), seat]);
    });
    this.getFurnitureRenderOrder().forEach((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      if (this.isDoorFurniture(definition.id)) {
        return;
      }
      const renderItem = this.getWallMountedRenderItem(item, definition);
      if (definition.category === "wallDecoration" && this.isWallDecorationOnHiddenWall(renderItem, definition)) {
        return;
      }

      const graphics = this.add.graphics();
      if (this.placement.isSelected(item.uid)) {
        const selectionGraphics = this.add.graphics();
        this.drawFurnitureFootprintHighlight(
          selectionGraphics,
          definition,
          renderItem.position,
          renderItem.rotation ?? 0,
          0xfff5a8,
          0xfff5a8,
          0.08,
          1,
          3,
        );
        this.furnitureLayer.add(selectionGraphics);
      }

      const visualRotation =
        definition.category === "chair"
          ? this.getChairBackRotationForSeats(diningSeatsByChair.get(item.uid) ?? [], renderItem.rotation ?? 0)
          : this.getViewAdjustedFurnitureRotation(renderItem.rotation ?? 0);
      const context = this.createFurnitureVisualContext(definition, renderItem, visualRotation);

      const spriteRender = this.createFurnitureSpriteRender(context);
      const sortInWorld = this.shouldDepthSortFurniture(definition);
      const furnitureSortY = this.getFurnitureWorldSortY(context);
      if (spriteRender) {
        if (sortInWorld) {
          this.addSortableFurnitureRender(spriteRender, furnitureSortY, 0);
        } else {
          this.furnitureLayer.add(spriteRender);
        }
      } else {
        this.drawIsoFurniture(graphics, context);
      }
      if (definition.category === "chair") {
        const seats = diningSeatsByChair.get(item.uid) ?? [];
        // Chair-back overlay was designed for the thin procedural character
        // silhouette — drawing chair posts on top of them made the figure
        // look "between" the posts. AI character sprites are fully rendered
        // 3D figures, so overlaying chair posts on top reads as the chair
        // back being IN FRONT of the seated guest. Skip the overlay.
        if (seats.length === 0) {
          this.drawChairSeatMarker(graphics, this.getChairSeatMarkerPoint(context), "unpaired");
        }
        seats.forEach((seat) => {
          const markerPoint = this.getChairSeatMarkerPoint(context, seat);
          const occupied = occupiedSeatUids.has(seat.seatUid);
          if (occupied && !seat.disabled) {
            this.drawChairSeatMarker(graphics, markerPoint, "occupied");
            return;
          }

          this.drawChairSeatMarker(graphics, markerPoint, seat.disabled ? "disabled" : "available");
        });
      }
      if (this.showVisualAnchorOverlay) {
        this.drawFurnitureVisualAnchorOverlay(graphics, context);
      }

      const needsAuxiliaryGraphics = !spriteRender || definition.category === "chair" || this.showVisualAnchorOverlay;
      if (!needsAuxiliaryGraphics) {
        graphics.destroy();
      } else if (sortInWorld) {
        this.addSortableFurnitureRender(graphics, furnitureSortY + 0.15, 1);
      } else {
        this.furnitureLayer.add(graphics);
      }
    });
    this.renderTablePlates(diningSeats);
    this.renderDirtyDishStack();
    this.updateRestaurantReadableTextRotation();
    this.sortActorDepths();
    this.refreshSeatedGuestFacings(diningSeats);
    this.recordFurnitureRender(performance.now() - startedAt, time);
  }

  // Re-derive each currently-seated guest's facing from the live diningSeat
  // data. Without this, a guest who sat down before the facing-computation
  // logic changed would keep their stale stored facing forever.
  private refreshSeatedGuestFacings(diningSeats: DiningSeat[]): void {
    const seatsByUid = new Map(diningSeats.map((seat) => [seat.seatUid, seat]));
    this.guests.forEach((guest) => {
      if (guest.state === "entering" || guest.state === "leaving") {
        return;
      }
      const seat = seatsByUid.get(guest.seatUid);
      if (!seat || seat.seatedFacing === guest.seatedFacing) {
        return;
      }
      guest.seatedFacing = seat.seatedFacing;
      this.drawPersonPose(guest.body, guest.legs, guest.seatedFacing, 0, true);
    });
  }

  private recordFurnitureRender(durationMs: number, time = this.time.now): void {
    this.lastFurnitureRenderMs = durationMs;
    if (this.furnitureRenderRateWindowStartedAt <= 0) {
      this.furnitureRenderRateWindowStartedAt = time;
    }

    this.furnitureRenderCount += 1;
    const elapsedSeconds = (time - this.furnitureRenderRateWindowStartedAt) / 1000;
    if (elapsedSeconds >= 1) {
      this.furnitureRenderRate = Math.round(this.furnitureRenderCount / elapsedSeconds);
      this.furnitureRenderCount = 0;
      this.furnitureRenderRateWindowStartedAt = time;
    }
  }

  private clearSortableFurnitureRenders(): void {
    [...this.actorLayer.list]
      .filter((child) => child.getData?.("sortableFurnitureRender") === true || child.getData?.("chairBackOverlay") === true)
      .forEach((child) => child.destroy());
  }

  private shouldDepthSortFurniture(definition: FurnitureDefinition): boolean {
    return definition.category !== "flooring" && definition.category !== "wallDecoration" && !this.isFlatFloorDecor(definition);
  }

  private getFurnitureWorldSortY(context: FurnitureVisualContext): number {
    const baseY = context.baseY;
    switch (context.definition.category) {
      case "stove":
      case "counter":
        return baseY - Math.max(8, context.height * 0.35);
      case "table":
        return baseY - Math.max(4, context.height * 0.25);
      case "chair":
        return baseY - 3;
      case "plant":
      case "lighting":
        return baseY - Math.max(2, context.height * 0.2);
      case "decoration":
        return baseY - 2;
      default:
        return baseY;
    }
  }

  private addSortableFurnitureRender(
    object: Phaser.GameObjects.GameObject,
    sortY: number,
    sortKind = 0,
  ): void {
    object.setData("sortableFurnitureRender", true);
    object.setData("sortY", sortY);
    object.setData("worldSortKind", sortKind);
    this.actorLayer.add(object);
  }

  private createSortedChairBackOverlay(context: FurnitureVisualContext, seat?: DiningSeat): void {
    const graphics = this.add.graphics();
    if (!this.drawOccupiedChairBackOverlay(graphics, context, seat)) {
      graphics.destroy();
      return;
    }

    graphics.setData("chairBackOverlay", true);
    graphics.setData("sortY", this.getChairBackOverlaySortY(context, seat));
    graphics.setData("worldSortKind", 3);
    this.actorLayer.add(graphics);
  }

  private getChairBackOverlaySortY(context: FurnitureVisualContext, seat?: DiningSeat): number {
    const seatTop = this.insetPolygon(context.bottom, context.definition.id === "bench-seat" ? 0.14 : 0.3);
    const edges = this.getChairBackAndFrontEdges(seatTop, context.visualRotation);
    const backCenter = this.lerpPoint(edges.back[0], edges.back[1], 0.5);
    return this.mapFurnitureGeometryPointToRenderedSprite(context, backCenter).y + 8;
  }

  private drawOccupiedChairBackOverlay(
    graphics: Phaser.GameObjects.Graphics,
    context: FurnitureVisualContext,
    seat?: DiningSeat,
  ): boolean {
    const seatTop = this.insetPolygon(context.bottom, context.definition.id === "bench-seat" ? 0.14 : 0.3);
    const edges = this.getChairBackAndFrontEdges(seatTop, context.visualRotation);
    const backCenter = this.mapFurnitureGeometryPointToRenderedSprite(
      context,
      this.lerpPoint(edges.back[0], edges.back[1], 0.5),
    );
    const frontCenter = this.mapFurnitureGeometryPointToRenderedSprite(
      context,
      this.lerpPoint(edges.front[0], edges.front[1], 0.5),
    );
    const markerPoint = this.getChairSeatMarkerPoint(context, seat);
    const backIsCameraSide = backCenter.y >= Math.min(frontCenter.y, markerPoint.y) - 2;

    if (!backIsCameraSide) {
      return false;
    }

    const tier = context.tier;
    const visual = getFurnitureSpriteVisual(context.definition);
    const backHeight = context.definition.id === "bench-seat" ? 42 : 30 + tier * 5;
    const scaledBackHeight = backHeight * visual.scale * visual.sourceScale;
    const left = this.mapFurnitureGeometryPointToRenderedSprite(
      context,
      this.lerpPoint(edges.back[0], edges.back[1], context.definition.id === "bench-seat" ? 0.06 : 0.12),
    );
    const right = this.mapFurnitureGeometryPointToRenderedSprite(
      context,
      this.lerpPoint(edges.back[0], edges.back[1], context.definition.id === "bench-seat" ? 0.94 : 0.88),
    );
    const leftTop = new Phaser.Math.Vector2(left.x, left.y - scaledBackHeight);
    const rightTop = new Phaser.Math.Vector2(right.x, right.y - scaledBackHeight);
    const color = context.definition.color;
    const faceColor = this.shadeColor(color, tier >= 4 ? 18 : 6);
    const sideColor = this.shadeColor(color, -34);
    const railColor = this.shadeColor(color, tier >= 3 ? 44 : 28);
    const outline = 0x5b4033;

    graphics.fillStyle(sideColor, 0.98);
    graphics.fillPoints([leftTop, rightTop, right, left], true);
    graphics.lineStyle(2, outline, 0.96);
    graphics.strokePoints([leftTop, rightTop, right, left], true);

    graphics.lineStyle(5, faceColor, 1);
    graphics.lineBetween(leftTop.x, leftTop.y, rightTop.x, rightTop.y);
    const midLeft = this.lerpPoint(leftTop, left, 0.5);
    const midRight = this.lerpPoint(rightTop, right, 0.5);
    graphics.lineStyle(4, faceColor, 1);
    graphics.lineBetween(midLeft.x, midLeft.y, midRight.x, midRight.y);
    const lowLeft = this.lerpPoint(leftTop, left, 0.76);
    const lowRight = this.lerpPoint(rightTop, right, 0.76);
    graphics.lineStyle(2, this.shadeColor(color, -22), 0.78);
    graphics.lineBetween(lowLeft.x, lowLeft.y, lowRight.x, lowRight.y);

    const slatCount = tier >= 3 || context.definition.id === "bench-seat" ? 3 : 2;
    graphics.lineStyle(3, railColor, 0.95);
    for (let index = 0; index < slatCount; index += 1) {
      const ratio = (index + 1) / (slatCount + 1);
      const topPoint = this.lerpPoint(leftTop, rightTop, ratio);
      const bottomPoint = this.lerpPoint(lowLeft, lowRight, ratio);
      graphics.lineBetween(topPoint.x, topPoint.y + 4, bottomPoint.x, bottomPoint.y - 2);
    }

    if (tier >= 4) {
      const cushionTopLeft = this.lerpPoint(leftTop, rightTop, 0.18);
      const cushionTopRight = this.lerpPoint(leftTop, rightTop, 0.82);
      const cushionBottomRight = this.lerpPoint(midLeft, midRight, 0.82);
      const cushionBottomLeft = this.lerpPoint(midLeft, midRight, 0.18);
      graphics.fillStyle(this.shadeColor(color, 28), 0.9);
      graphics.fillPoints([cushionTopLeft, cushionTopRight, cushionBottomRight, cushionBottomLeft], true);
      graphics.lineStyle(1, outline, 0.45);
      graphics.strokePoints([cushionTopLeft, cushionTopRight, cushionBottomRight, cushionBottomLeft], true);
    }

    return true;
  }

  private getChairBackRotationForSeats(seats: DiningSeat[], fallbackRotation: number): number {
    const primarySeat = seats.find((seat) => !seat.disabled) ?? seats[0];
    if (!primarySeat) {
      return this.getViewAdjustedFurnitureRotation(fallbackRotation);
    }

    return this.getViewAdjustedFurnitureRotation(primarySeat.chairBackRotation);
  }

  private getChairSeatMarkerPoint(context: FurnitureVisualContext, seat?: DiningSeat): Phaser.Math.Vector2 {
    return this.getChairSeatSurfacePoint(
      context,
      context.definition.seatingCapacity ?? 1,
      seat?.seatIndex ?? 0,
    );
  }

  private getChairSeatSurfacePoint(
    context: FurnitureVisualContext,
    seatCount = 1,
    seatIndex = 0,
  ): Phaser.Math.Vector2 {
    const clampedSeatIndex = Phaser.Math.Clamp(seatIndex, 0, Math.max(0, seatCount - 1));
    const frame = getFurnitureSpriteFrame(context.definition, context.visualRotation);
    const metadata = getFurnitureFrameMetadata(frame);
    if (metadata?.seatSurfacePx?.length) {
      const seatPoint = metadata.seatSurfacePx[Math.min(clampedSeatIndex, metadata.seatSurfacePx.length - 1)];
      return this.mapFurnitureFramePointToRenderedSprite(context, seatPoint);
    }

    const isLongSeat = context.definition.id === "bench-seat" || context.definition.id === "banquette-seat";
    const seatTop = this.insetPolygon(context.bottom, isLongSeat ? 0.2 : 0.28);
    const edges = this.getChairBackAndFrontEdges(seatTop, context.visualRotation);
    const ratio = seatCount <= 1 ? 0.5 : (clampedSeatIndex + 1) / (seatCount + 1);
    const backPoint = this.lerpPoint(edges.back[0], edges.back[1], ratio);
    const frontPoint = this.lerpPoint(edges.front[0], edges.front[1], ratio);
    const seatDepth = isLongSeat ? 0.5 : 0.48;
    const unscaledSurface = this.lerpPoint(backPoint, frontPoint, seatDepth);
    unscaledSurface.y += isLongSeat ? 1 : 0;
    return this.mapFurnitureGeometryPointToRenderedSprite(context, unscaledSurface);
  }

  private mapFurnitureFramePointToRenderedSprite(
    context: FurnitureVisualContext,
    point: { x: number; y: number },
  ): Phaser.Math.Vector2 {
    const visual = getFurnitureSpriteVisual(context.definition);
    const frame = getFurnitureSpriteFrame(context.definition, context.visualRotation);
    const metadata = getFurnitureFrameMetadata(frame);
    const anchor = metadata?.anchorPx;
    if (!anchor || !this.hasAtlasFrame(visual.atlas, frame)) {
      return context.center.clone();
    }

    const position = this.getFurnitureSpritePosition(context);
    return new Phaser.Math.Vector2(
      position.x + visual.xOffset + (point.x - anchor.x) * visual.scale,
      position.y + visual.yOffset + (point.y - anchor.y) * visual.scale,
    );
  }

  private mapFurnitureGeometryPointToRenderedSprite(
    context: FurnitureVisualContext,
    point: Phaser.Math.Vector2,
  ): Phaser.Math.Vector2 {
    const visual = getFurnitureSpriteVisual(context.definition);
    const frame = getFurnitureSpriteFrame(context.definition, context.visualRotation);
    if (!this.hasAtlasFrame(visual.atlas, frame)) {
      return point;
    }

    const geometryOrigin = this.getFurnitureSpritePosition(context);
    const renderedOrigin = new Phaser.Math.Vector2(
      geometryOrigin.x + visual.xOffset,
      geometryOrigin.y + visual.yOffset,
    );
    return renderedOrigin.add(point.clone().subtract(geometryOrigin).scale(visual.scale * visual.sourceScale));
  }

  private getChairBackAndFrontEdges(
    top: Phaser.Math.Vector2[],
    rotation: number,
  ): { back: [Phaser.Math.Vector2, Phaser.Math.Vector2]; front: [Phaser.Math.Vector2, Phaser.Math.Vector2] } {
    const normalizedRotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
    if (normalizedRotation === 90) {
      return { back: [top[1], top[2]], front: [top[0], top[3]] };
    }
    if (normalizedRotation === 180) {
      return { back: [top[2], top[3]], front: [top[1], top[0]] };
    }
    if (normalizedRotation === 270) {
      return { back: [top[3], top[0]], front: [top[2], top[1]] };
    }

    return { back: [top[0], top[1]], front: [top[3], top[2]] };
  }

  private drawChairSeatMarker(
    graphics: Phaser.GameObjects.Graphics,
    point: Phaser.Math.Vector2,
    state: "available" | "occupied" | "disabled" | "unpaired",
  ): void {
    const stroke = state === "unpaired" ? 0xd29b43 : 0x3e8a65;
    const fill = state === "occupied" ? 0x3e6f52 : state === "unpaired" ? 0xf1c56b : 0xf6edd8;
    const fillAlpha = state === "occupied" ? 0.7 : state === "unpaired" ? 0.28 : 0.14;
    const width = state === "unpaired" ? 14 : 15;
    const height = state === "unpaired" ? 6 : 7;

    graphics.fillStyle(fill, fillAlpha);
    graphics.fillEllipse(point.x, point.y, width, height);
    graphics.lineStyle(2, stroke, state === "occupied" ? 0.82 : 0.7);
    graphics.strokeEllipse(point.x, point.y, width, height);

    if (state === "disabled") {
      graphics.lineStyle(2, stroke, 0.82);
      graphics.lineBetween(point.x - 5, point.y + 3, point.x + 5, point.y - 3);
    }
  }

  private drawFurnitureVisualAnchorOverlay(
    graphics: Phaser.GameObjects.Graphics,
    context: FurnitureVisualContext,
  ): void {
    if (context.definition.category === "wallDecoration") {
      return;
    }

    const spriteAnchor = this.getFurnitureSpritePosition(context);
    const footprintCenter = context.center;
    graphics.lineStyle(2, 0xffd34f, 0.9);
    graphics.lineBetween(footprintCenter.x - 8, footprintCenter.y, footprintCenter.x + 8, footprintCenter.y);
    graphics.lineBetween(footprintCenter.x, footprintCenter.y - 8, footprintCenter.x, footprintCenter.y + 8);
    graphics.fillStyle(0xffd34f, 0.9);
    graphics.fillCircle(spriteAnchor.x, spriteAnchor.y, 3);

    const frame = getFurnitureSpriteFrame(context.definition, context.visualRotation);
    const metadata = getFurnitureFrameMetadata(frame);
    metadata?.seatSurfacePx?.forEach((point) => {
      const worldPoint = this.mapFurnitureFramePointToRenderedSprite(context, point);
      graphics.lineStyle(1, 0x1b7f4a, 0.9);
      graphics.strokeEllipse(worldPoint.x, worldPoint.y, 18, 9);
    });
    metadata?.tableServicePx?.forEach((point) => {
      const worldPoint = this.mapFurnitureFramePointToRenderedSprite(context, point);
      graphics.fillStyle(0xff8a3d, 0.8);
      graphics.fillCircle(worldPoint.x, worldPoint.y, 3);
    });
  }

  private drawFurnitureFootprintHighlight(
    graphics: Phaser.GameObjects.Graphics,
    definition: FurnitureDefinition,
    position: GridPosition,
    rotation: number,
    fillColor: number,
    strokeColor: number,
    fillAlpha = 0.18,
    strokeAlpha = 0.95,
    lineWidth = 3,
  ): void {
    const cells = this.grid.getOccupiedCells(definition, position, rotation);
    graphics.fillStyle(fillColor, fillAlpha);
    cells.forEach((cell) => {
      graphics.fillPoints(this.grid.getCellDiamond(cell), true);
    });

    graphics.lineStyle(lineWidth, strokeColor, strokeAlpha);
    cells.forEach((cell) => {
      graphics.strokePoints(this.grid.getCellDiamond(cell), true);
    });
  }

  private getViewAdjustedFurnitureRotation(rotation: number): number {
    return ((rotation + this.restaurantViewRotationStep * 90) % 360 + 360) % 360;
  }

  private renderExpansionOverlays(): void {
    const graphics = this.add.graphics();
    for (let y = this.grid.minY; y <= this.grid.maxY; y += 1) {
      for (let x = this.grid.minX; x <= this.grid.maxX; x += 1) {
        if (!this.isGridPositionVisible({ x, y }) || this.isGridPositionUnlocked({ x, y })) {
          continue;
        }

        const diamond = this.grid.getCellDiamond({ x, y });
        graphics.fillStyle(0x5f4a3d, 0.18);
        graphics.fillPoints(diamond, true);
        graphics.lineStyle(1, 0x8f6251, 0.3);
        graphics.strokePoints(diamond, true);
      }
    }
    this.expansionOverlayLayer.add(graphics);

    const nextExpansion = this.getExpansionDefinitions().find((definition) => definition.level === this.expansionLevel + 1);
    if (!nextExpansion) {
      return;
    }

    const signPoint = this.getExpansionSignWorldPoint(nextExpansion);
    this.renderExpansionSign(signPoint.x, signPoint.y, nextExpansion);
  }

  private renderExpansionSign(centerX: number, centerY: number, expansion: ExpansionDefinition, label = expansion.name): void {
    const { width: signWidth, plaqueHeight: signHeight, totalHeight } = this.getExpansionSignMetrics();
    const sign = this.add.container(centerX - signWidth / 2, centerY - signHeight / 2);
    const signBg = this.hasAtlasFrame("environment", "expansion-sign")
      ? this.add.image(signWidth / 2, signHeight / 2 + 28, "environment", "expansion-sign").setScale(0.9)
      : this.add.graphics();
    if (signBg instanceof Phaser.GameObjects.Graphics) {
      signBg.fillStyle(0x6e4931, 1);
      signBg.fillRect(signWidth / 2 - 5, signHeight - 2, 10, 30);
      signBg.fillStyle(0x5f7f5f, 0.95);
      signBg.fillEllipse(signWidth / 2, signHeight + 30, 82, 24);
      signBg.fillStyle(0x8f6251, 1);
      signBg.fillRoundedRect(0, 0, signWidth, signHeight, 7);
      signBg.lineStyle(2, 0x5b4033, 1);
      signBg.strokeRoundedRect(0, 0, signWidth, signHeight, 7);
      signBg.fillStyle(0xcaa06d, 1);
      signBg.fillCircle(18, 13, 5);
      signBg.fillCircle(signWidth - 18, 13, 5);
      signBg.lineStyle(1, 0x5b4033, 0.45);
      signBg.lineBetween(34, 12, signWidth - 34, 12);
    }
    const text = this.add.text(signWidth / 2 - 1, 13, `${label}\n$${this.getExpansionCost(expansion.level)}`, {
      color: "#fff4dc",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "10px",
      fontStyle: "bold",
      align: "center",
      fixedWidth: signWidth - 42,
      lineSpacing: -1,
    }).setOrigin(0.5, 0);
    sign.add([signBg, text]);
    sign.setSize(signWidth, totalHeight);
    sign.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, signWidth, totalHeight),
      (_hitArea: Phaser.Geom.Rectangle, localX: number, localY: number) => this.isExpansionSignLocalHit(localX, localY),
    );
    sign.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      const worldPoint = this.getRestaurantPointerPosition(_pointer);
      if (!this.isExpansionSignWorldHit(worldPoint.x, worldPoint.y, expansion)) {
        return;
      }
      this.requestExpansionPurchase(expansion.level);
    });
    this.expansionOverlayLayer.add(sign);
  }

  private handleExpansionSignClick(worldX: number, worldY: number): boolean {
    const expansion = this.getExpansionDefinitions().find((definition) => definition.level === this.expansionLevel + 1);
    if (!expansion) {
      return false;
    }

    if (!this.isExpansionSignWorldHit(worldX, worldY, expansion)) {
      return false;
    }

    this.requestExpansionPurchase(expansion.level);
    return true;
  }

  private getExpansionSignMetrics(): { width: number; plaqueHeight: number; postWidth: number; postHeight: number; totalHeight: number } {
    return {
      width: 158,
      plaqueHeight: 48,
      postWidth: 18,
      postHeight: 32,
      totalHeight: 88,
    };
  }

  private isExpansionSignWorldHit(worldX: number, worldY: number, expansion: ExpansionDefinition): boolean {
    const { width, plaqueHeight } = this.getExpansionSignMetrics();
    const signPoint = this.getExpansionSignWorldPoint(expansion);
    const localX = worldX - (signPoint.x - width / 2);
    const localY = worldY - (signPoint.y - plaqueHeight / 2);
    if (!this.isExpansionSignLocalHit(localX, localY)) {
      return false;
    }

    const gridPosition = this.grid.worldToGrid(worldX, worldY);
    if (gridPosition && this.isGridPositionUnlocked(gridPosition)) {
      return false;
    }

    return !this.getPlacedFurnitureAtWorld(worldX, worldY);
  }

  private isExpansionSignLocalHit(localX: number, localY: number): boolean {
    const { width, plaqueHeight, postWidth, postHeight } = this.getExpansionSignMetrics();
    const plaqueHit = localX >= 0 && localX <= width && localY >= 0 && localY <= plaqueHeight;
    const postHit =
      localX >= width / 2 - postWidth / 2 &&
      localX <= width / 2 + postWidth / 2 &&
      localY >= plaqueHeight - 2 &&
      localY <= plaqueHeight + postHeight;

    return plaqueHit || postHit;
  }

  private getExpansionCenter(expansion: ExpansionDefinition): Phaser.Math.Vector2 {
    if (expansion.cells.length === 0) {
      return this.grid.getCellCenter(expansion.signPosition);
    }

    const points = expansion.cells.map((cell) => this.grid.getCellCenter(cell));
    return new Phaser.Math.Vector2(
      points.reduce((sum, point) => sum + point.x, 0) / points.length,
      points.reduce((sum, point) => sum + point.y, 0) / points.length,
    );
  }

  private getExpansionSignWorldPoint(expansion: ExpansionDefinition): Phaser.Math.Vector2 {
    const signCell = this.getExpansionSignCell(expansion);
    const signCenter = this.grid.getCellCenter(signCell);
    const outward = this.getExpansionSignOutwardVector(expansion, signCell);
    return signCenter.add(outward.scale(this.grid.tileSize * 1.15));
  }

  private getExpansionSignCell(expansion: ExpansionDefinition): GridPosition {
    if (expansion.cells.length === 0) {
      return expansion.signPosition;
    }

    if (expansion.direction === "north") {
      const edgeY = Math.min(...expansion.cells.map((cell) => cell.y));
      return this.getNearestExpansionCell(expansion.cells.filter((cell) => cell.y === edgeY), expansion.signPosition);
    }

    if (expansion.direction === "left") {
      const edgeX = Math.min(...expansion.cells.map((cell) => cell.x));
      return this.getNearestExpansionCell(expansion.cells.filter((cell) => cell.x === edgeX), expansion.signPosition);
    }

    const edgeX = Math.max(...expansion.cells.map((cell) => cell.x));
    return this.getNearestExpansionCell(expansion.cells.filter((cell) => cell.x === edgeX), expansion.signPosition);
  }

  private getNearestExpansionCell(cells: GridPosition[], target: GridPosition): GridPosition {
    return [...cells].sort((a, b) => {
      const aDistance = Math.abs(a.x - target.x) + Math.abs(a.y - target.y);
      const bDistance = Math.abs(b.x - target.x) + Math.abs(b.y - target.y);
      return aDistance - bDistance;
    })[0] ?? target;
  }

  private getExpansionSignOutwardVector(expansion: ExpansionDefinition, signCell: GridPosition): Phaser.Math.Vector2 {
    const inwardCell =
      expansion.direction === "north"
        ? { x: signCell.x, y: signCell.y + 1 }
        : expansion.direction === "left"
          ? { x: signCell.x + 1, y: signCell.y }
          : { x: signCell.x - 1, y: signCell.y };
    const outward = this.grid.getCellCenter(signCell).subtract(this.grid.getCellCenter(inwardCell));
    if (outward.lengthSq() === 0) {
      return new Phaser.Math.Vector2(0, -1);
    }

    return outward.normalize();
  }

  private renderDirtyDishStack(): void {
    if (this.dirtyDishCount <= 0) {
      return;
    }

    const point = this.getDishStationPoint("counter");
    const container = this.add.container(0, 0);
    const graphics = this.add.graphics();
    const count = Math.min(this.dirtyDishCount, 5);
    for (let index = 0; index < count; index += 1) {
      this.drawLargePlate(graphics, point.x - 18 + index * 8, point.y - 26 - index * 3, "dirty", 0.62);
    }
    const label = this.add.text(point.x + 18, point.y - 40, `x${this.dirtyDishCount}`, {
      color: "#3b2a21",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "12px",
      fontStyle: "bold",
      backgroundColor: "rgba(255,248,232,0.85)",
      padding: { x: 4, y: 2 },
    });
    container.add([graphics, label]);
    this.addSortableFurnitureRender(container, point.y + 12, 1);
  }

  private renderTablePlates(diningSeats: DiningSeat[]): void {
    diningSeats.forEach((seat) => {
      if (this.dirtySeatUids.has(seat.seatUid) || this.cleaningSeatUids.has(seat.seatUid)) {
        this.renderTablePlateIcon(seat, "dirty");
      }
    });

    this.guests
      .filter((guest) => guest.state !== "leaving")
      .forEach((guest) => {
        const seat = diningSeats.find((item) => item.seatUid === guest.seatUid);
        if (!seat) {
          return;
        }

        const deliveredTickets = this.tickets.filter((ticket) => ticket.guestId === guest.id && ticket.state === "delivered");
        deliveredTickets.forEach((_, index) => {
          this.renderTablePlateIcon(seat, guest.finishedEating ? "dirty" : "food", index, deliveredTickets.length);
        });
      });
  }

  private renderTablePlateIcon(
    seat: DiningSeat,
    state: "food" | "dirty",
    index = 0,
    total = 1,
  ): void {
    const graphics = this.add.graphics();
    this.drawTablePlateIcon(graphics, seat, state, index, total);
    this.addSortableFurnitureRender(graphics, this.getTablePlateSortY(seat), 1);
  }

  private drawTablePlateIcon(
    graphics: Phaser.GameObjects.Graphics,
    seat: DiningSeat,
    state: "food" | "dirty",
    index = 0,
    total = 1,
  ): void {
    const tableCenter = seat.cleanupSpot;
    const table = seat.tableUid ? this.placement.getFurniture().find((item) => item.uid === seat.tableUid) : null;
    const tableDefinition = table ? getFurnitureDefinition(table.furnitureId) : null;
    const metadataPlate = table && tableDefinition
      ? this.getTableServicePlatePoint(table, tableDefinition, seat, index, total)
      : null;
    if (metadataPlate) {
      this.drawLargePlate(graphics, metadataPlate.x, metadataPlate.y, state, 0.78);
      return;
    }

    const tableSize = table && tableDefinition ? this.grid.getRotatedSize(tableDefinition, table.rotation ?? 0) : null;
    const tableFootprint = table && tableSize ? this.grid.getAreaDiamond(table.position, tableSize) : null;
    const tableTop = tableDefinition && tableFootprint ? this.getFurnitureVisualTop(tableDefinition, tableFootprint) : tableFootprint;
    const actualTableCenter = tableTop ? this.getPolygonCenter(tableTop) : tableCenter;
    const directionFromTable = seat.seat.clone().subtract(tableCenter);
    if (directionFromTable.lengthSq() === 0) {
      directionFromTable.set(0, 1);
    }
    directionFromTable.normalize();

    let plate = actualTableCenter.clone().add(directionFromTable.clone().scale(18));
    if (tableTop) {
      const columns = total <= 1 ? 1 : Math.min(2, total);
      const row = Math.floor(index / columns);
      const column = index % columns;
      const perpendicular = new Phaser.Math.Vector2(-directionFromTable.y, directionFromTable.x);
      const edgeDistance = this.getRayPolygonEdgeDistance(actualTableCenter, directionFromTable, tableTop) ?? 28;
      const inwardRows = Math.min(row, 2);
      const distanceFromCenter = Phaser.Math.Clamp(edgeDistance - 13 - inwardRows * 9, 7, Math.max(7, edgeDistance - 8));
      const lateralSpread = Math.min(12, Math.max(5, edgeDistance * 0.32));
      plate = actualTableCenter
        .clone()
        .add(directionFromTable.clone().scale(distanceFromCenter))
        .add(perpendicular.scale((column - (columns - 1) / 2) * lateralSpread));
    } else if (total > 1) {
      const perpendicular = new Phaser.Math.Vector2(-directionFromTable.y, directionFromTable.x);
      plate.add(perpendicular.scale((index - (total - 1) / 2) * 18));
    }

    this.drawLargePlate(graphics, plate.x, plate.y, state, 0.78);
  }

  private getTablePlateSortY(seat: DiningSeat): number {
    const table = seat.tableUid ? this.placement.getFurniture().find((item) => item.uid === seat.tableUid) : null;
    const tableDefinition = table ? getFurnitureDefinition(table.furnitureId) : null;
    if (!table || !tableDefinition) {
      return seat.cleanupSpot.y;
    }

    const renderItem = this.getWallMountedRenderItem(table, tableDefinition);
    const visualRotation = this.getViewAdjustedFurnitureRotation(renderItem.rotation ?? 0);
    const context = this.createFurnitureVisualContext(tableDefinition, renderItem, visualRotation);
    return this.getFurnitureWorldSortY(context) + 0.45;
  }

  private getTableServicePlatePoint(
    table: PlacedFurniture,
    tableDefinition: FurnitureDefinition,
    seat: DiningSeat,
    index: number,
    total: number,
  ): Phaser.Math.Vector2 | null {
    const renderItem = this.getWallMountedRenderItem(table, tableDefinition);
    const visualRotation = this.getViewAdjustedFurnitureRotation(renderItem.rotation ?? 0);
    const frame = getFurnitureSpriteFrame(tableDefinition, visualRotation);
    const metadata = getFurnitureFrameMetadata(frame);
    if (!metadata?.tableServicePx?.length || !this.hasAtlasFrame("furniture", frame)) {
      return null;
    }

    const context = this.createFurnitureVisualContext(tableDefinition, renderItem, visualRotation);
    const servicePoints = metadata.tableServicePx
      .map((point) => this.mapFurnitureFramePointToRenderedSprite(context, point))
      .sort((a, b) =>
        Phaser.Math.Distance.Between(a.x, a.y, seat.seat.x, seat.seat.y) -
        Phaser.Math.Distance.Between(b.x, b.y, seat.seat.x, seat.seat.y),
      );
    const base = servicePoints[index % servicePoints.length]?.clone() ?? servicePoints[0]?.clone();
    if (!base) {
      return null;
    }

    if (total <= 1) {
      return base;
    }

    const tableCenter = context.center;
    const direction = seat.seat.clone().subtract(tableCenter);
    if (direction.lengthSq() === 0) {
      direction.set(0, 1);
    }
    direction.normalize();
    const perpendicular = new Phaser.Math.Vector2(-direction.y, direction.x);
    const clusterIndex = Math.floor(index / servicePoints.length);
    return base.add(perpendicular.scale((clusterIndex - Math.floor(total / servicePoints.length) / 2) * 8));
  }

  private getRayPolygonEdgeDistance(
    origin: Phaser.Math.Vector2,
    direction: Phaser.Math.Vector2,
    polygon: Phaser.Math.Vector2[],
  ): number | null {
    let nearest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const edge = end.clone().subtract(start);
      const denominator = direction.x * edge.y - direction.y * edge.x;
      if (Math.abs(denominator) < 0.001) {
        continue;
      }

      const diff = start.clone().subtract(origin);
      const rayDistance = (diff.x * edge.y - diff.y * edge.x) / denominator;
      const edgeRatio = (diff.x * direction.y - diff.y * direction.x) / denominator;
      if (rayDistance > 0 && edgeRatio >= -0.001 && edgeRatio <= 1.001) {
        nearest = Math.min(nearest, rayDistance);
      }
    }

    return Number.isFinite(nearest) ? nearest : null;
  }

  private createReadyFoodPlateAt(x: number, y: number, scale = 1, sortY?: number): Phaser.GameObjects.Graphics {
    const graphics = this.add.graphics();
    this.drawLargePlate(graphics, 0, 0, "food", scale);
    graphics.setPosition(x, y);
    graphics.setData("sortY", sortY ?? y + 18);
    graphics.setData("worldSortKind", 1);
    this.actorLayer.add(graphics);
    return graphics;
  }

  private showWaiterCarriedPlate(waiter: Actor, visible: boolean, state: "food" | "dirty" = "food"): void {
    waiter.carriedPlate?.destroy();
    delete waiter.carriedPlate;
    waiter.body.setData("characterAction", visible ? state === "dirty" ? "clean" : "carry" : undefined);
    this.drawPersonPose(
      waiter.body,
      waiter.legs,
      (waiter.body.getData("facing") as PersonFacing | undefined) ?? "down",
      0,
      false,
    );
    if (!visible) {
      return;
    }

    const graphics = this.add.graphics();
    this.drawLargePlate(graphics, 0, 0, state, 0.78);
    graphics.setPosition(13, -18);
    graphics.setData("baseLocalX", 13);
    graphics.setData("baseLocalY", -18);
    waiter.container.add(graphics);
    waiter.carriedPlate = graphics;
  }

  private drawLargePlate(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    state: "food" | "dirty",
    scale = 1,
  ): void {
    const width = 40 * scale;
    const height = 20 * scale;
    const rimWidth = Math.max(1, 2 * scale);
    graphics.fillStyle(0x3f2d24, 0.13);
    graphics.fillEllipse(x + 4 * scale, y + 5 * scale, width * 0.9, height * 0.48);
    graphics.fillStyle(0xffffff, 1);
    graphics.fillEllipse(x, y, width, height);
    graphics.lineStyle(rimWidth, 0x8b7764, 0.92);
    graphics.strokeEllipse(x, y, width, height);
    graphics.fillStyle(0xf4ead4, 1);
    graphics.fillEllipse(x, y + 1 * scale, width * 0.66, height * 0.54);
    graphics.lineStyle(Math.max(1, 1.2 * scale), 0xd1bd94, 0.95);
    graphics.strokeEllipse(x, y + 1 * scale, width * 0.66, height * 0.54);
    graphics.lineStyle(Math.max(1, 1.2 * scale), 0xd8c09c, 0.9);
    graphics.lineBetween(x - 18 * scale, y + 8 * scale, x - 4 * scale, y + 3 * scale);
    graphics.lineBetween(x + 15 * scale, y + 6 * scale, x + 21 * scale, y + 1 * scale);

    if (state === "food") {
      graphics.fillStyle(0xc16f43, 1);
      graphics.fillEllipse(x - 7 * scale, y + 2 * scale, 13 * scale, 6 * scale);
      graphics.fillStyle(0x6da05e, 1);
      graphics.fillEllipse(x + 5 * scale, y - 2 * scale, 12 * scale, 6 * scale);
      graphics.fillStyle(0xf2c866, 1);
      graphics.fillEllipse(x + 5 * scale, y + 5 * scale, 14 * scale, 5 * scale);
      graphics.fillStyle(0xfff0a8, 0.95);
      graphics.fillEllipse(x - 1 * scale, y - 5 * scale, 6 * scale, 4 * scale);
      graphics.fillStyle(0xffffff, 0.35);
      graphics.fillEllipse(x - 11 * scale, y - 5 * scale, 10 * scale, 3 * scale);
      return;
    }

    graphics.fillStyle(0x8c6a45, 0.95);
    graphics.fillEllipse(x - 4 * scale, y + 3 * scale, 8 * scale, 4 * scale);
    graphics.fillEllipse(x + 5 * scale, y - 3 * scale, 6 * scale, 3 * scale);
    graphics.lineStyle(Math.max(1, 2 * scale), 0x8c6a45, 0.82);
    graphics.lineBetween(x + 8 * scale, y - 5 * scale, x + 15 * scale, y - 10 * scale);
    graphics.lineBetween(x + 10 * scale, y - 3 * scale, x + 17 * scale, y - 8 * scale);
  }

  private getFurnitureRenderOrder(): PlacedFurniture[] {
    return [...this.placement.getFurniture()].sort((a, b) => {
      const definitionA = getFurnitureDefinition(a.furnitureId);
      const definitionB = getFurnitureDefinition(b.furnitureId);
      const weightA = this.getFurnitureRenderWeight(definitionA);
      const weightB = this.getFurnitureRenderWeight(definitionB);
      return weightA - weightB || this.getFurnitureBaseY(a) - this.getFurnitureBaseY(b);
    });
  }

  private getFurnitureRenderWeight(definition: FurnitureDefinition): number {
    if (definition.category === "flooring") {
      return 0;
    }
    if (definition.category === "wallDecoration" && this.isWallFinishFurniture(definition.id)) {
      return 0.75;
    }
    if (this.isFlatFloorDecor(definition) || definition.category === "wallDecoration") {
      return 1;
    }
    return 2;
  }

  private getFurnitureBaseY(item: PlacedFurniture): number {
    const definition = getFurnitureDefinition(item.furnitureId);
    const renderItem = this.getWallMountedRenderItem(item, definition);
    const size = this.grid.getRotatedSize(definition, renderItem.rotation ?? 0);
    const top = this.grid.getAreaDiamond(renderItem.position, size);
    return Math.max(...top.map((point) => point.y)) + this.getFurnitureVisualHeight(definition);
  }

  private createFurnitureVisualContext(
    definition: FurnitureDefinition,
    item: PlacedFurniture,
    visualRotation: number,
  ): FurnitureVisualContext {
    const size = this.grid.getRotatedSize(definition, item.rotation ?? 0);
    const height = this.getFurnitureVisualHeight(definition);
    const footprint = this.grid.getAreaDiamond(item.position, size);
    const top = this.getFurnitureVisualTop(definition, footprint);
    const bottom = this.hasRaisedFurnitureVisual(definition)
      ? footprint
      : top.map((point) => new Phaser.Math.Vector2(point.x, point.y + height));
    return {
      definition,
      item,
      size,
      top,
      bottom,
      center: this.getPolygonCenter(footprint),
      height,
      baseY: Math.max(...bottom.map((point) => point.y)),
      visualRotation,
      tier: this.getFurnitureLuxuryTier(definition),
    };
  }

  private getFurnitureVisualTop(
    definition: FurnitureDefinition,
    footprint: Phaser.Math.Vector2[],
  ): Phaser.Math.Vector2[] {
    if (!this.hasRaisedFurnitureVisual(definition)) {
      return footprint;
    }

    const height = this.getFurnitureVisualHeight(definition);
    return footprint.map((point) => new Phaser.Math.Vector2(point.x, point.y - height));
  }

  private hasRaisedFurnitureVisual(definition: FurnitureDefinition): boolean {
    return (
      definition.category !== "flooring" &&
      definition.category !== "wallDecoration" &&
      !this.isFlatFloorDecor(definition) &&
      this.getFurnitureVisualHeight(definition) > 0
    );
  }

  private getFurnitureVisualHeight(definition: FurnitureDefinition): number {
    if (this.isFlatFloorDecor(definition)) {
      return 0;
    }

    const heightByCategory: Record<FurnitureDefinition["category"], number> = {
      table: 26,
      chair: 16,
      stove: 34,
      counter: 34,
      decoration: 20,
      plant: 26,
      lighting: 44,
      wallDecoration: 0,
      flooring: 0,
    };

    return heightByCategory[definition.category] ?? 18;
  }

  private isFlatFloorDecor(definition: FurnitureDefinition): boolean {
    return definition.category === "decoration" && /rug|mat|carpet/.test(definition.id);
  }

  private createFurnitureSpriteRender(context: FurnitureVisualContext): Phaser.GameObjects.Image | null {
    if (context.definition.category === "wallDecoration") {
      return null;
    }

    const visual = getFurnitureSpriteVisual(context.definition);
    const frame = getFurnitureSpriteFrame(context.definition, context.visualRotation);
    if (!this.hasAtlasFrame(visual.atlas, frame)) {
      return null;
    }

    const sprite = this.add.image(0, 0, visual.atlas, frame);
    this.configureFurnitureSprite(sprite, context, visual, frame);
    return sprite;
  }

  private configureFurnitureSprite(
    sprite: Phaser.GameObjects.Image,
    context: FurnitureVisualContext,
    visual = getFurnitureSpriteVisual(context.definition),
    frame = getFurnitureSpriteFrame(context.definition, context.visualRotation),
  ): boolean {
    if (context.definition.category === "wallDecoration" || !this.hasAtlasFrame(visual.atlas, frame)) {
      return false;
    }

    const position = this.getFurnitureSpritePosition(context);
    const origin = getFurnitureSpriteOrigin(frame, visual.origin);
    sprite
      .setTexture(visual.atlas, frame)
      .setPosition(position.x + visual.xOffset, position.y + visual.yOffset)
      .setOrigin(origin.x, origin.y)
      .setScale(visual.scale)
      .setData("baseY", context.baseY);
    return true;
  }

  private getFurnitureSpritePosition(context: FurnitureVisualContext): Phaser.Math.Vector2 {
    if (context.definition.category === "flooring" || this.isFlatFloorDecor(context.definition)) {
      return context.center.clone();
    }

    if (context.definition.category === "wallDecoration") {
      const edge = this.getWallDecorationEdge(context.item, context.top);
      return this.lerpPoint(edge[0], edge[1], 0.5).add(new Phaser.Math.Vector2(0, -4));
    }

    return context.center.clone();
  }

  private hasAtlasFrame(textureKey: string, frameKey: string): boolean {
    if (!this.textures.exists(textureKey)) {
      return false;
    }

    return this.textures.get(textureKey).has(frameKey);
  }

  private drawIsoFurniture(graphics: Phaser.GameObjects.Graphics, context: FurnitureVisualContext): void {
    const { definition, top, bottom, height } = context;

    if (definition.category === "flooring") {
      this.drawIsoFloorTile(graphics, definition, top);
      return;
    }

    if (definition.category === "wallDecoration") {
      this.drawIsoWallDecoration(graphics, context);
      return;
    }

    if (this.isFlatFloorDecor(definition)) {
      this.drawIsoTextileDecor(graphics, definition, top, context.tier);
      return;
    }

    this.drawIsoPrism(graphics, {
      top,
      height,
      topColor: definition.color,
      frontColor: this.shadeColor(definition.color, -46),
      sideColor: this.shadeColor(definition.color, -26),
      outlineColor: 0x5b4033,
      shadowAlpha: definition.category === "plant" ? 0.1 : 0.14,
    });

    if (definition.category === "table") {
      this.drawIsoTableDetails(graphics, context);
      return;
    }

    if (definition.category === "chair") {
      this.drawIsoChairDetails(graphics, context);
      return;
    }

    if (definition.category === "stove") {
      this.drawIsoStoveDetails(graphics, context);
      return;
    }

    if (definition.category === "counter") {
      this.drawIsoCounterDetails(graphics, context);
      return;
    }

    if (definition.category === "plant" || definition.category === "decoration") {
      this.drawIsoDecorDetails(graphics, context);
      return;
    }

    if (definition.category === "lighting") {
      this.drawIsoLightingDetails(graphics, context);
    }
  }

  private drawIsoPrism(graphics: Phaser.GameObjects.Graphics, spec: IsoPrismSpec): void {
    const bottom = spec.top.map((point) => new Phaser.Math.Vector2(point.x, point.y + spec.height));
    if (spec.shadowAlpha && spec.shadowAlpha > 0) {
      this.drawNeutralIsoShadow(graphics, bottom, spec.shadowAlpha);
    }

    graphics.fillStyle(spec.sideColor ?? this.shadeColor(spec.topColor, -24), 1);
    graphics.fillPoints([spec.top[1], spec.top[2], bottom[2], bottom[1]], true);
    graphics.fillStyle(spec.frontColor ?? this.shadeColor(spec.topColor, -44), 1);
    graphics.fillPoints([spec.top[2], spec.top[3], bottom[3], bottom[2]], true);
    graphics.fillStyle(spec.topColor, 1);
    graphics.fillPoints(spec.top, true);

    graphics.lineStyle(2, spec.outlineColor ?? 0x5b4033, 0.9);
    graphics.strokePoints(spec.top, true);
    graphics.lineStyle(1, spec.outlineColor ?? 0x5b4033, 0.48);
    graphics.strokePoints([spec.top[1], spec.top[2], bottom[2], bottom[1]], true);
    graphics.strokePoints([spec.top[2], spec.top[3], bottom[3], bottom[2]], true);
    graphics.lineStyle(1, this.shadeColor(spec.topColor, 45), 0.38);
    graphics.lineBetween(spec.top[3].x + 5, spec.top[3].y, spec.top[0].x, spec.top[0].y + 3);
  }

  private drawNeutralIsoShadow(graphics: Phaser.GameObjects.Graphics, bottom: Phaser.Math.Vector2[], alpha: number): void {
    const center = this.getPolygonCenter(bottom);
    const width = Math.max(...bottom.map((point) => point.x)) - Math.min(...bottom.map((point) => point.x));
    const height = Math.max(...bottom.map((point) => point.y)) - Math.min(...bottom.map((point) => point.y));
    graphics.fillStyle(0x3f2d24, alpha);
    graphics.fillEllipse(center.x + 8, center.y + 7, Math.max(20, width * 0.82), Math.max(10, height * 0.5));
  }

  private drawIsoFloorTile(graphics: Phaser.GameObjects.Graphics, definition: FurnitureDefinition, top: Phaser.Math.Vector2[]): void {
    graphics.fillStyle(definition.color, 0.96);
    graphics.fillPoints(top, true);
    const inset = this.insetPolygon(top, 0.08);
    graphics.lineStyle(1, 0xffffff, 0.22);
    graphics.strokePoints(inset, true);
    graphics.lineStyle(1, 0x6f4d3d, 0.12);
    graphics.strokePoints(top, true);

    if (definition.id.includes("wood")) {
      graphics.lineStyle(1, this.shadeColor(definition.color, -22), 0.18);
      graphics.lineBetween(this.lerpPoint(top[3], top[0], 0.45).x, this.lerpPoint(top[3], top[0], 0.45).y, this.lerpPoint(top[2], top[1], 0.45).x, this.lerpPoint(top[2], top[1], 0.45).y);
    }
  }

  private drawIsoTextileDecor(
    graphics: Phaser.GameObjects.Graphics,
    definition: FurnitureDefinition,
    top: Phaser.Math.Vector2[],
    tier: number,
  ): void {
    const center = this.getPolygonCenter(top);
    const inset = this.insetPolygon(top, 0.1);
    graphics.fillStyle(this.shadeColor(definition.color, 18), 0.95);
    graphics.fillPoints(top, true);
    graphics.fillStyle(definition.color, 0.98);
    graphics.fillPoints(inset, true);
    graphics.lineStyle(2, this.shadeColor(definition.color, -36), 0.74);
    graphics.strokePoints(top, true);
    graphics.lineStyle(1, 0xfff1d2, 0.34 + tier * 0.05);
    graphics.strokePoints(this.insetPolygon(top, 0.2), true);
    graphics.lineStyle(2, 0xfff1d2, 0.48);
    graphics.lineBetween(inset[3].x + 8, inset[3].y, inset[1].x - 8, inset[1].y);
    if (definition.id.includes("checker")) {
      [0.34, 0.66].forEach((ratio) => {
        const left = this.lerpPoint(top[3], top[0], ratio);
        const right = this.lerpPoint(top[2], top[1], ratio);
        graphics.lineStyle(1, this.shadeColor(definition.color, 44), 0.42);
        graphics.lineBetween(left.x, left.y, right.x, right.y);
      });
    } else {
      graphics.fillStyle(0xfff8e8, 0.16);
      graphics.fillEllipse(center.x, center.y, 34 + tier * 4, 13 + tier);
    }
  }

  private drawIsoWallDecoration(graphics: Phaser.GameObjects.Graphics, context: FurnitureVisualContext): void {
    const { definition } = context;
    const panel = this.getWallDecorationPanel(context);
    if (this.isWallFinishFurniture(definition.id)) {
      this.drawIsoWallFinishPanel(graphics, panel, definition, context.tier, context.item);
      return;
    }

    const [topLeft, topRight, baseRight, baseLeft] = panel;
    if (this.isWindowFurniture(definition.id)) {
      const frameQuad = this.getPanelInsetQuad(panel, 0.04, 0.96, 0.04, 0.96);
      const frameDark = this.shadeColor(definition.color, -42);
      const frameLight = this.shadeColor(definition.color, 24);

      graphics.fillStyle(0x2b211b, 0.12);
      graphics.fillPoints(frameQuad.map((point) => new Phaser.Math.Vector2(point.x + 4, point.y + 5)), true);
      graphics.fillStyle(definition.color, 1);
      graphics.fillPoints(frameQuad, true);
      graphics.lineStyle(3, frameDark, 0.96);
      graphics.strokePoints(frameQuad, true);
      graphics.lineStyle(2, frameLight, 0.55);
      graphics.lineBetween(frameQuad[3].x + 3, frameQuad[3].y - 2, frameQuad[0].x + 4, frameQuad[0].y + 4);
      graphics.lineBetween(frameQuad[0].x + 4, frameQuad[0].y + 4, frameQuad[1].x - 5, frameQuad[1].y + 4);

      const glassInset = this.getPanelInsetQuad(frameQuad, 0.18, 0.82, 0.18, 0.84);
      graphics.fillStyle(context.tier >= 4 ? 0x9fd6e8 : 0xb9dce6, 0.96);
      graphics.fillPoints(glassInset, true);
      graphics.lineStyle(2, 0xfffbf0, 0.9);
      graphics.strokePoints(glassInset, true);

      const verticalTop = this.lerpPoint(glassInset[0], glassInset[1], 0.5);
      const verticalBottom = this.lerpPoint(glassInset[3], glassInset[2], 0.5);
      const horizontalLeft = this.lerpPoint(glassInset[0], glassInset[3], 0.52);
      const horizontalRight = this.lerpPoint(glassInset[1], glassInset[2], 0.52);
      graphics.lineStyle(2, 0xfffbf0, 0.95);
      graphics.lineBetween(verticalTop.x, verticalTop.y, verticalBottom.x, verticalBottom.y);
      graphics.lineBetween(horizontalLeft.x, horizontalLeft.y, horizontalRight.x, horizontalRight.y);
      graphics.lineStyle(2, 0xffffff, 0.55);
      graphics.lineBetween(glassInset[0].x + 4, glassInset[0].y + 6, verticalTop.x - 3, verticalTop.y + 4);
      graphics.lineBetween(verticalTop.x + 5, verticalTop.y + 4, glassInset[1].x - 5, glassInset[1].y + 7);

      if (definition.id.includes("curtain") || context.tier >= 3) {
        const curtainColor = context.tier >= 5 ? 0xd7a958 : context.tier >= 4 ? 0xa76b87 : 0xe2aa79;
        const leftCurtain = [
          frameQuad[0],
          this.lerpPoint(frameQuad[0], frameQuad[1], 0.18),
          this.lerpPoint(frameQuad[3], frameQuad[2], 0.22),
          frameQuad[3],
        ];
        const rightCurtain = [
          this.lerpPoint(frameQuad[0], frameQuad[1], 0.82),
          frameQuad[1],
          frameQuad[2],
          this.lerpPoint(frameQuad[3], frameQuad[2], 0.78),
        ];
        graphics.fillStyle(curtainColor, 0.72);
        graphics.fillPoints(leftCurtain, true);
        graphics.fillPoints(rightCurtain, true);
      }

      if (definition.id.includes("arched")) {
        const crown = this.lerpPoint(topLeft, topRight, 0.5);
        graphics.lineStyle(3, 0xfffbf0, 0.88);
        const start = new Phaser.Math.Vector2(frameQuad[0].x, frameQuad[0].y + 8);
        let previous = start.clone();
        const control = new Phaser.Math.Vector2(crown.x, crown.y - 12);
        const end = new Phaser.Math.Vector2(frameQuad[1].x, frameQuad[1].y + 8);
        for (let step = 1; step <= 8; step += 1) {
          const t = step / 8;
          const oneMinusT = 1 - t;
          const next = new Phaser.Math.Vector2(
            oneMinusT * oneMinusT * start.x + 2 * oneMinusT * t * control.x + t * t * end.x,
            oneMinusT * oneMinusT * start.y + 2 * oneMinusT * t * control.y + t * t * end.y,
          );
          graphics.lineBetween(previous.x, previous.y, next.x, next.y);
          previous = next;
        }
      }

      if (definition.id.includes("stained")) {
        const shardA = this.lerpPoint(glassInset[0], glassInset[2], 0.45);
        const shardB = this.lerpPoint(glassInset[1], glassInset[3], 0.45);
        graphics.lineStyle(2, 0xcaa06d, 0.82);
        graphics.lineBetween(glassInset[0].x, glassInset[0].y, shardB.x, shardB.y);
        graphics.lineBetween(glassInset[1].x, glassInset[1].y, shardA.x, shardA.y);
        graphics.fillStyle(0xf1c76f, 0.38);
        graphics.fillCircle((shardA.x + shardB.x) / 2, (shardA.y + shardB.y) / 2, 8);
      }
      return;
    }

    graphics.fillStyle(0xfaf6ee, 1);
    graphics.fillPoints(panel, true);
    graphics.lineStyle(2, 0xc9b9a6, 0.9);
    graphics.strokePoints(panel, true);
    const artInset = this.getPanelInsetQuad(panel, 0.12, 0.88, 0.12, 0.88);
    graphics.fillStyle(definition.color, 1);
    graphics.fillPoints(artInset, true);

    if (this.isDoorFurniture(definition.id)) {
      this.drawIsoDoorOnPanel(graphics, panel, context.tier, definition);
      return;
    }

    if (this.isMenuBoardFurniture(definition.id)) {
      this.drawIsoMenuBoardOnPanel(graphics, panel, definition.id, context.tier);
      return;
    }

    if (this.isWindowFurniture(definition.id)) {
      graphics.lineStyle(4, this.shadeColor(definition.color, -42), 0.95);
      graphics.strokePoints(artInset, true);

      const glassInset = this.insetPolygon(artInset, 0.16);
      graphics.fillStyle(context.tier >= 4 ? 0x9fd6e8 : 0xb9dce6, 0.96);
      graphics.fillPoints(glassInset, true);
      graphics.lineStyle(2, 0xfffbf0, 0.9);
      graphics.strokePoints(glassInset, true);

      const verticalTop = this.lerpPoint(glassInset[0], glassInset[1], 0.5);
      const verticalBottom = this.lerpPoint(glassInset[3], glassInset[2], 0.5);
      const horizontalLeft = this.lerpPoint(glassInset[0], glassInset[3], 0.52);
      const horizontalRight = this.lerpPoint(glassInset[1], glassInset[2], 0.52);
      graphics.lineStyle(2, 0xfffbf0, 0.95);
      graphics.lineBetween(verticalTop.x, verticalTop.y, verticalBottom.x, verticalBottom.y);
      graphics.lineBetween(horizontalLeft.x, horizontalLeft.y, horizontalRight.x, horizontalRight.y);
      graphics.lineStyle(2, 0xffffff, 0.55);
      graphics.lineBetween(glassInset[0].x + 4, glassInset[0].y + 6, verticalTop.x - 3, verticalTop.y + 4);
      graphics.lineBetween(verticalTop.x + 5, verticalTop.y + 4, glassInset[1].x - 5, glassInset[1].y + 7);

      if (definition.id.includes("curtain") || context.tier >= 3) {
        const curtainColor = context.tier >= 5 ? 0xd7a958 : context.tier >= 4 ? 0xa76b87 : 0xe2aa79;
        const leftCurtain = [
          artInset[0],
          this.lerpPoint(artInset[0], artInset[1], 0.18),
          this.lerpPoint(artInset[3], artInset[2], 0.22),
          artInset[3],
        ];
        const rightCurtain = [
          this.lerpPoint(artInset[0], artInset[1], 0.82),
          artInset[1],
          artInset[2],
          this.lerpPoint(artInset[3], artInset[2], 0.78),
        ];
        graphics.fillStyle(curtainColor, 0.72);
        graphics.fillPoints(leftCurtain, true);
        graphics.fillPoints(rightCurtain, true);
      }

      if (definition.id.includes("arched")) {
        const crown = this.lerpPoint(topLeft, topRight, 0.5);
        graphics.lineStyle(3, 0xfffbf0, 0.88);
        const start = new Phaser.Math.Vector2(artInset[0].x, artInset[0].y + 8);
        let previous = start.clone();
        const control = new Phaser.Math.Vector2(crown.x, crown.y - 12);
        const end = new Phaser.Math.Vector2(artInset[1].x, artInset[1].y + 8);
        for (let step = 1; step <= 8; step += 1) {
          const t = step / 8;
          const oneMinusT = 1 - t;
          const next = new Phaser.Math.Vector2(
            oneMinusT * oneMinusT * start.x + 2 * oneMinusT * t * control.x + t * t * end.x,
            oneMinusT * oneMinusT * start.y + 2 * oneMinusT * t * control.y + t * t * end.y,
          );
          graphics.lineBetween(previous.x, previous.y, next.x, next.y);
          previous = next;
        }
      }

      if (definition.id.includes("stained")) {
        const shardA = this.lerpPoint(glassInset[0], glassInset[2], 0.45);
        const shardB = this.lerpPoint(glassInset[1], glassInset[3], 0.45);
        graphics.lineStyle(2, 0xcaa06d, 0.82);
        graphics.lineBetween(glassInset[0].x, glassInset[0].y, shardB.x, shardB.y);
        graphics.lineBetween(glassInset[1].x, glassInset[1].y, shardA.x, shardA.y);
        graphics.fillStyle(0xf1c76f, 0.38);
        graphics.fillCircle((shardA.x + shardB.x) / 2, (shardA.y + shardB.y) / 2, 8);
      }
      return;
    }

    graphics.lineStyle(1, 0xffffff, 0.35);
    graphics.lineBetween(artInset[0].x + 3, artInset[0].y + 3, artInset[1].x - 3, artInset[1].y + 3);
  }

  private drawIsoWallFinishPanel(
    graphics: Phaser.GameObjects.Graphics,
    panel: Phaser.Math.Vector2[],
    definition: FurnitureDefinition,
    tier: number,
    item?: PlacedFurniture,
  ): void {
    const pointAt = (horizontal: number, vertical: number): Phaser.Math.Vector2 => this.getPanelPoint(panel, horizontal, vertical);
    const quad = (left: number, right: number, top: number, bottom: number): Phaser.Math.Vector2[] => [
      pointAt(left, top),
      pointAt(right, top),
      pointAt(right, bottom),
      pointAt(left, bottom),
    ];
    const isWallpaper = definition.id.includes("wallpaper");
    const baseColor = definition.color;
    const highlight = this.shadeColor(baseColor, 24);
    const shadow = this.shadeColor(baseColor, -18);
    const trimColor = tier >= 4 ? 0xe4d8c8 : 0xd8c9b6;
    const leavesEntranceDoorClear = item ? this.isEntranceDoorWallFinish(item, definition) : false;

    if (leavesEntranceDoorClear) {
      graphics.fillStyle(baseColor, 1);
      graphics.fillPoints(quad(0.02, 0.98, 0.02, 0.26), true);
      graphics.fillStyle(highlight, 0.22);
      graphics.fillPoints(quad(0.02, 0.98, 0.02, 0.09), true);
      graphics.lineStyle(2, trimColor, 0.82);
      const trimLeft = pointAt(0.02, 0.26);
      const trimRight = pointAt(0.98, 0.26);
      graphics.lineBetween(trimLeft.x, trimLeft.y, trimRight.x, trimRight.y);
      return;
    }

    graphics.fillStyle(baseColor, 1);
    graphics.fillPoints(panel, true);

    if (!isWallpaper) {
      const stripCount = 4;
      for (let index = 0; index < stripCount; index += 1) {
        const left = index / stripCount;
        const right = (index + 1) / stripCount;
        graphics.fillStyle(index % 2 === 0 ? highlight : shadow, index % 2 === 0 ? 0.12 : 0.08);
        graphics.fillPoints(quad(left, right, 0.02, 0.98), true);
      }
      graphics.lineStyle(1, 0xffffff, 0.16);
      [0.25, 0.5, 0.75].forEach((ratio) => {
        const top = pointAt(ratio, 0.04);
        const bottom = pointAt(ratio, 0.94);
        graphics.lineBetween(top.x, top.y, bottom.x, bottom.y);
      });
    } else if (definition.id.includes("gingham")) {
      graphics.fillStyle(0xffffff, 0.2);
      for (let ratio = 0.12; ratio < 0.96; ratio += 0.22) {
        graphics.fillPoints(quad(ratio, Math.min(0.98, ratio + 0.08), 0.02, 0.98), true);
        graphics.fillPoints(quad(0.02, 0.98, ratio, Math.min(0.98, ratio + 0.08)), true);
      }
      graphics.lineStyle(1, this.shadeColor(baseColor, -34), 0.18);
      for (let ratio = 0.08; ratio < 1; ratio += 0.11) {
        const verticalTop = pointAt(ratio, 0.02);
        const verticalBottom = pointAt(ratio, 0.98);
        graphics.lineBetween(verticalTop.x, verticalTop.y, verticalBottom.x, verticalBottom.y);
        const horizontalLeft = pointAt(0.02, ratio);
        const horizontalRight = pointAt(0.98, ratio);
        graphics.lineBetween(horizontalLeft.x, horizontalLeft.y, horizontalRight.x, horizontalRight.y);
      }
    } else if (definition.id.includes("stripe")) {
      for (let ratio = 0; ratio < 1; ratio += 0.16) {
        graphics.fillStyle(ratio % 0.32 < 0.16 ? 0xffffff : this.shadeColor(baseColor, -28), ratio % 0.32 < 0.16 ? 0.22 : 0.14);
        graphics.fillPoints(quad(ratio, Math.min(1, ratio + 0.075), 0, 1), true);
      }
      graphics.lineStyle(2, 0xffffff, 0.18);
      const top = pointAt(0.08, 0.14);
      const bottom = pointAt(0.92, 0.86);
      graphics.lineBetween(top.x, top.y, bottom.x, bottom.y);
    } else if (definition.id.includes("botanical")) {
      graphics.fillStyle(0xffffff, 0.1);
      graphics.fillPoints(quad(0, 1, 0, 1), true);
      for (let index = 0; index < 7; index += 1) {
        const root = pointAt(0.12 + index * 0.14, 0.88);
        const tip = pointAt(0.18 + index * 0.13, 0.3 + (index % 2) * 0.1);
        graphics.lineStyle(2, 0x5d8d61, 0.55);
        graphics.lineBetween(root.x, root.y, tip.x, tip.y);
        [0.36, 0.52, 0.68].forEach((v, leafIndex) => {
          const stem = pointAt(0.13 + index * 0.14, v);
          graphics.fillStyle(leafIndex % 2 === 0 ? 0x6fa86d : 0x86b878, 0.52);
          graphics.fillEllipse(stem.x + (leafIndex % 2 === 0 ? 5 : -5), stem.y, 12, 6);
        });
      }
    } else if (definition.id.includes("linen")) {
      graphics.fillStyle(0xffffff, 0.12);
      graphics.fillPoints(quad(0, 1, 0, 1), true);
      graphics.lineStyle(1, this.shadeColor(baseColor, -35), 0.22);
      for (let ratio = 0.05; ratio < 1; ratio += 0.08) {
        const verticalTop = pointAt(ratio, 0);
        const verticalBottom = pointAt(ratio, 1);
        graphics.lineBetween(verticalTop.x, verticalTop.y, verticalBottom.x, verticalBottom.y);
      }
      graphics.lineStyle(1, 0xffffff, 0.22);
      for (let ratio = 0.07; ratio < 1; ratio += 0.1) {
        const horizontalLeft = pointAt(0, ratio);
        const horizontalRight = pointAt(1, ratio);
        graphics.lineBetween(horizontalLeft.x, horizontalLeft.y, horizontalRight.x, horizontalRight.y);
      }
    } else if (definition.id.includes("tile")) {
      graphics.fillStyle(0xffffff, 0.22);
      graphics.fillPoints(quad(0.02, 0.98, 0.04, 0.96), true);
      graphics.lineStyle(2, this.shadeColor(baseColor, -35), 0.35);
      for (let ratio = 0.18; ratio < 1; ratio += 0.2) {
        const verticalTop = pointAt(ratio, 0.04);
        const verticalBottom = pointAt(ratio, 0.96);
        graphics.lineBetween(verticalTop.x, verticalTop.y, verticalBottom.x, verticalBottom.y);
        const horizontalLeft = pointAt(0.02, ratio);
        const horizontalRight = pointAt(0.98, ratio);
        graphics.lineBetween(horizontalLeft.x, horizontalLeft.y, horizontalRight.x, horizontalRight.y);
      }
      [0.18, 0.38, 0.58, 0.78].forEach((ratio, index) => {
        const center = pointAt(ratio, 0.5);
        graphics.fillStyle(index % 2 === 0 ? 0xf0cf7a : 0x78a6b7, 0.42);
        graphics.fillCircle(center.x, center.y, 5);
      });
    } else if (definition.id.includes("damask") || definition.id.includes("mural")) {
      graphics.fillStyle(0xffffff, 0.1);
      graphics.fillPoints(quad(0.02, 0.98, 0.02, 0.98), true);
      const accent = definition.id.includes("mural") ? 0x7d9b6f : 0xe0c16a;
      for (let index = 0; index < 5; index += 1) {
        const center = pointAt(0.16 + index * 0.18, 0.45 + (index % 2) * 0.1);
        graphics.lineStyle(2, accent, 0.58);
        graphics.strokeEllipse(center.x, center.y, 24, 13);
        graphics.strokeEllipse(center.x, center.y, 10, 24);
        graphics.fillStyle(accent, 0.28);
        graphics.fillCircle(center.x, center.y, 5);
      }
      graphics.lineStyle(2, 0xffffff, 0.18);
      const topLeft = pointAt(0.05, 0.18);
      const topRight = pointAt(0.95, 0.18);
      const bottomLeft = pointAt(0.05, 0.82);
      const bottomRight = pointAt(0.95, 0.82);
      graphics.lineBetween(topLeft.x, topLeft.y, topRight.x, topRight.y);
      graphics.lineBetween(bottomLeft.x, bottomLeft.y, bottomRight.x, bottomRight.y);
    }

    graphics.lineStyle(3, trimColor, 0.72);
    const baseLeft = pointAt(0, 0.98);
    const baseRight = pointAt(1, 0.98);
    graphics.lineBetween(baseLeft.x, baseLeft.y, baseRight.x, baseRight.y);
    graphics.lineStyle(2, 0xffffff, 0.18);
    const topLeft = pointAt(0, 0.02);
    const topRight = pointAt(1, 0.02);
    graphics.lineBetween(topLeft.x, topLeft.y, topRight.x, topRight.y);
  }

  private drawIsoMenuBoardOnPanel(
    graphics: Phaser.GameObjects.Graphics,
    panel: Phaser.Math.Vector2[],
    furnitureId: string,
    tier: number,
  ): void {
    const [topLeft, topRight, baseRight, baseLeft] = panel;
    const pointAt = (horizontal: number, vertical: number): Phaser.Math.Vector2 => {
      const left = this.lerpPoint(topLeft, baseLeft, vertical);
      const right = this.lerpPoint(topRight, baseRight, vertical);
      return this.lerpPoint(left, right, horizontal);
    };
    const quad = (left: number, right: number, top: number, bottom: number): Phaser.Math.Vector2[] => [
      pointAt(left, top),
      pointAt(right, top),
      pointAt(right, bottom),
      pointAt(left, bottom),
    ];
    const raisedQuad = (shape: Phaser.Math.Vector2[], lift: Phaser.Math.Vector2): Phaser.Math.Vector2[] =>
      shape.map((point) => point.clone().add(lift));

    const thickness = new Phaser.Math.Vector2(7, 8);
    const mount = quad(0.07, 0.93, 0.06, 0.96);
    const front = raisedQuad(mount, new Phaser.Math.Vector2(-3, -5));
    const frontColor = furnitureId === "paper-menu" ? 0xf2c778 : furnitureId === "chalk-specials" ? 0x3b4a47 : 0xd49a4a;
    const innerColor = furnitureId === "chalk-specials" ? 0x2f3a38 : furnitureId === "paper-menu" ? 0xffe2a2 : 0xf6b84f;
    const sideColor = this.shadeColor(frontColor, -42);
    const trimColor = tier >= 4 ? 0xf0d28a : 0x6b4731;

    graphics.fillStyle(0x3f2d24, 0.16);
    graphics.fillPoints(raisedQuad(mount, new Phaser.Math.Vector2(8, 10)), true);

    graphics.fillStyle(sideColor, 1);
    graphics.fillPoints([front[1], front[1].clone().add(thickness), front[2].clone().add(thickness), front[2]], true);
    graphics.fillStyle(this.shadeColor(sideColor, -18), 1);
    graphics.fillPoints([front[3], front[2], front[2].clone().add(thickness), front[3].clone().add(thickness)], true);

    graphics.fillStyle(frontColor, 1);
    graphics.fillPoints(front, true);
    graphics.lineStyle(2, 0x4b3429, 0.95);
    graphics.strokePoints(front, true);

    const crown = quad(0.18, 0.82, 0.03, 0.2).map((point) => point.clone().add(new Phaser.Math.Vector2(-3, -7)));
    graphics.fillStyle(this.shadeColor(frontColor, 18), 1);
    graphics.fillPoints(crown, true);
    graphics.lineStyle(2, trimColor, 0.75);
    graphics.strokePoints(crown, true);

    const inset = quad(0.17, 0.83, 0.24, 0.82).map((point) => point.clone().add(new Phaser.Math.Vector2(-3, -5)));
    graphics.fillStyle(innerColor, 1);
    graphics.fillPoints(inset, true);
    graphics.lineStyle(2, trimColor, 0.9);
    graphics.strokePoints(inset, true);

    const lineColor = furnitureId === "chalk-specials" ? 0xf8f0d8 : 0x70452c;
    graphics.lineStyle(2, lineColor, 0.86);
    [0.36, 0.5, 0.64].forEach((vertical, index) => {
      const left = pointAt(0.27, vertical).add(new Phaser.Math.Vector2(-3, -5));
      const right = pointAt(index === 1 ? 0.7 : 0.75, vertical).add(new Phaser.Math.Vector2(-3, -5));
      graphics.lineBetween(left.x, left.y, right.x, right.y);
    });

    graphics.fillStyle(furnitureId === "chalk-specials" ? 0xf2d37c : 0x8f3f2b, 0.95);
    const iconCenter = pointAt(0.5, 0.2).add(new Phaser.Math.Vector2(-3, -5));
    graphics.fillCircle(iconCenter.x, iconCenter.y, 5 + tier * 0.4);
    graphics.fillStyle(0xffffff, 0.52);
    graphics.fillEllipse(iconCenter.x - 2, iconCenter.y - 2, 6, 3);

    if (tier >= 3 || furnitureId === "menu-board") {
      const shelf = quad(0.21, 0.79, 0.86, 0.94).map((point) => point.clone().add(new Phaser.Math.Vector2(-3, -5)));
      graphics.fillStyle(0x704a35, 1);
      graphics.fillPoints(shelf, true);
      graphics.fillStyle(0xf3ddad, 0.95);
      [0.34, 0.5, 0.66].forEach((horizontal) => {
        const dish = pointAt(horizontal, 0.86).add(new Phaser.Math.Vector2(-3, -6));
        graphics.fillEllipse(dish.x, dish.y, 9, 4);
      });
    }

    graphics.lineStyle(2, 0xffffff, 0.42);
    const shineStart = pointAt(0.22, 0.19).add(new Phaser.Math.Vector2(-3, -5));
    const shineEnd = pointAt(0.42, 0.14).add(new Phaser.Math.Vector2(-3, -5));
    graphics.lineBetween(shineStart.x, shineStart.y, shineEnd.x, shineEnd.y);
  }

  private drawIsoDoorOnPanel(
    graphics: Phaser.GameObjects.Graphics,
    panel: Phaser.Math.Vector2[],
    tier: number,
    definition?: FurnitureDefinition,
  ): void {
    const [topLeft, topRight, baseRight, baseLeft] = panel;
    const pointAt = (horizontal: number, vertical: number): Phaser.Math.Vector2 => {
      const left = this.lerpPoint(topLeft, baseLeft, vertical);
      const right = this.lerpPoint(topRight, baseRight, vertical);
      return this.lerpPoint(left, right, horizontal);
    };
    const quad = (left: number, right: number, top: number, bottom: number): Phaser.Math.Vector2[] => [
      pointAt(left, top),
      pointAt(right, top),
      pointAt(right, bottom),
      pointAt(left, bottom),
    ];

    const frameColor = tier >= 5 ? 0x7b5730 : tier >= 4 ? 0x6d5847 : 0x6b4a38;
    const doorColor = definition?.color ?? (tier >= 5 ? 0x6f3f2e : tier >= 4 ? 0x4b6570 : tier >= 3 ? 0x8d4f43 : tier >= 2 ? 0x9a6545 : 0x8a5b3f);
    const trimColor = tier >= 5 ? 0xd7b76a : tier >= 4 ? 0xf1dfbf : 0xe8c18f;
    const glassColor = tier >= 4 ? 0xa9dce6 : 0xb8d8df;

    graphics.fillStyle(frameColor, 1);
    graphics.fillPoints(panel, true);
    graphics.lineStyle(2, 0x4b3429, 0.95);
    graphics.strokePoints(panel, true);

    const doorLeaf = quad(0.08, 0.92, 0.08, 0.98);
    graphics.fillStyle(doorColor, 1);
    graphics.fillPoints(doorLeaf, true);
    graphics.lineStyle(2, 0x3b2a21, 0.78);
    graphics.strokePoints(doorLeaf, true);

    graphics.lineStyle(3, trimColor, 0.9);
    graphics.strokePoints(quad(0.16, 0.84, 0.15, 0.9), true);

    if (tier >= 2) {
      const glass = quad(0.2, 0.8, 0.2, tier >= 4 ? 0.72 : 0.58);
      graphics.fillStyle(glassColor, 0.82);
      graphics.fillPoints(glass, true);
      graphics.lineStyle(2, 0xf8f2e8, 0.88);
      graphics.strokePoints(glass, true);
      graphics.lineStyle(2, 0xf8f2e8, 0.62);
      const centerTop = pointAt(0.5, 0.22);
      const centerBottom = pointAt(0.5, tier >= 4 ? 0.7 : 0.56);
      graphics.lineBetween(centerTop.x, centerTop.y, centerBottom.x, centerBottom.y);
      if (tier >= 3) {
        const crossLeft = pointAt(0.22, 0.42);
        const crossRight = pointAt(0.78, 0.42);
        graphics.lineBetween(crossLeft.x, crossLeft.y, crossRight.x, crossRight.y);
      }
    }

    const lowerPanels = tier >= 4 ? [quad(0.2, 0.44, 0.72, 0.9), quad(0.56, 0.8, 0.72, 0.9)] : [quad(0.2, 0.8, 0.64, 0.88)];
    lowerPanels.forEach((panelQuad) => {
      graphics.fillStyle(this.shadeColor(doorColor, -20), 0.42);
      graphics.fillPoints(panelQuad, true);
      graphics.lineStyle(2, trimColor, 0.66);
      graphics.strokePoints(panelQuad, true);
    });

    if (tier >= 3) {
      const archTop = pointAt(0.5, 0.12);
      const archLeft = pointAt(0.2, 0.24);
      const archRight = pointAt(0.8, 0.24);
      graphics.lineStyle(3, trimColor, 0.9);
      let previous = archLeft;
      for (let step = 1; step <= 10; step += 1) {
        const t = step / 10;
        const oneMinusT = 1 - t;
        const next = new Phaser.Math.Vector2(
          oneMinusT * oneMinusT * archLeft.x + 2 * oneMinusT * t * archTop.x + t * t * archRight.x,
          oneMinusT * oneMinusT * archLeft.y + 2 * oneMinusT * t * (archTop.y - 12) + t * t * archRight.y,
        );
        graphics.lineBetween(previous.x, previous.y, next.x, next.y);
        previous = next;
      }
    }

    const handle = pointAt(0.76, 0.58);
    graphics.fillStyle(trimColor, 1);
    graphics.fillCircle(handle.x, handle.y, tier >= 5 ? 5 : 4);
    graphics.lineStyle(2, 0xffffff, 0.45);
    graphics.lineBetween(pointAt(0.24, 0.24).x, pointAt(0.24, 0.24).y, pointAt(0.42, 0.2).x, pointAt(0.42, 0.2).y);
  }

  private getWallDecorationPanel(context: FurnitureVisualContext): Phaser.Math.Vector2[] {
    const edge = this.getWallDecorationEdge(context.item, context.top);
    if (this.isWallFinishFurniture(context.definition.id)) {
      const height = 132;
      const topLeft = new Phaser.Math.Vector2(edge[0].x, edge[0].y - height);
      const topRight = new Phaser.Math.Vector2(edge[1].x, edge[1].y - height);
      return [topLeft, topRight, edge[1].clone(), edge[0].clone()];
    }

    const isDoor = this.isDoorFurniture(context.definition.id);
    const isWindow = this.isWindowFurniture(context.definition.id);
    const baseLift = isWindow ? 40 : 0;
    const baseLeft = this.lerpPoint(edge[0], edge[1], isDoor ? 0.1 : isWindow ? 0.12 : 0.2).add(new Phaser.Math.Vector2(0, -baseLift));
    const baseRight = this.lerpPoint(edge[0], edge[1], isDoor ? 0.9 : isWindow ? 0.88 : 0.8).add(new Phaser.Math.Vector2(0, -baseLift));
    const height = isDoor ? 78 + context.tier * 5 : isWindow ? 62 + context.tier * 5 : 52 + context.tier * 4;
    const topLeft = new Phaser.Math.Vector2(baseLeft.x, baseLeft.y - height);
    const topRight = new Phaser.Math.Vector2(baseRight.x, baseRight.y - height);
    return [topLeft, topRight, baseRight, baseLeft];
  }

  private getPanelPoint(panel: Phaser.Math.Vector2[], horizontal: number, vertical: number): Phaser.Math.Vector2 {
    const [topLeft, topRight, baseRight, baseLeft] = panel;
    const left = this.lerpPoint(topLeft, baseLeft, vertical);
    const right = this.lerpPoint(topRight, baseRight, vertical);
    return this.lerpPoint(left, right, horizontal);
  }

  private getPanelInsetQuad(
    panel: Phaser.Math.Vector2[],
    left: number,
    right: number,
    top: number,
    bottom: number,
  ): Phaser.Math.Vector2[] {
    return [
      this.getPanelPoint(panel, left, top),
      this.getPanelPoint(panel, right, top),
      this.getPanelPoint(panel, right, bottom),
      this.getPanelPoint(panel, left, bottom),
    ];
  }

  private getWallDecorationEdge(item: PlacedFurniture, top: Phaser.Math.Vector2[]): [Phaser.Math.Vector2, Phaser.Math.Vector2] {
    const position = item.position;
    const definition = getFurnitureDefinition(item.furnitureId);
    if (this.isWallMountedFurniture(definition)) {
      return this.getWallDecorationEdgeByRotation(top, item.rotation ?? 0);
    }

    if (!this.isGridPositionUnlocked({ x: position.x, y: position.y - 1 })) {
      return [top[0], top[1]];
    }
    if (!this.isGridPositionUnlocked({ x: position.x - 1, y: position.y })) {
      return [top[3], top[0]];
    }
    if (!this.isGridPositionUnlocked({ x: position.x + 1, y: position.y })) {
      return [top[1], top[2]];
    }
    return [top[0], top[1]];
  }

  private getWallDecorationEdgeByRotation(top: Phaser.Math.Vector2[], rotation: number): [Phaser.Math.Vector2, Phaser.Math.Vector2] {
    const normalizedRotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
    if (normalizedRotation === 90) {
      return [top[1], top[2]];
    }
    if (normalizedRotation === 180) {
      return [top[2], top[3]];
    }
    if (normalizedRotation === 270) {
      return [top[3], top[0]];
    }
    return [top[0], top[1]];
  }

  private drawIsoTableDetails(graphics: Phaser.GameObjects.Graphics, context: FurnitureVisualContext): void {
    const { definition, top, bottom, center, tier } = context;
    const inset = this.insetPolygon(top, 0.16);
    graphics.lineStyle(2, this.shadeColor(definition.color, tier >= 4 ? 70 : 38), 0.5);
    graphics.strokePoints(inset, true);

    const markerCount = definition.id === "two-top-table" ? 2 : definition.id === "booth-table" || definition.id === "family-table" ? 3 : 1;
    graphics.fillStyle(tier >= 4 ? 0xfff8e8 : 0xfff3d8, 1);
    for (let index = 0; index < markerCount; index += 1) {
      const offset = (index - (markerCount - 1) / 2) * 16;
      graphics.fillCircle(center.x + offset, center.y + offset * 0.24, tier >= 4 ? 7 : 6);
    }

    graphics.fillStyle(0x4d3428, 0.92);
    [0.18, 0.82].forEach((ratio) => {
      const front = this.lerpPoint(bottom[3], bottom[2], ratio);
      const back = this.lerpPoint(bottom[0], bottom[1], ratio);
      graphics.fillRoundedRect(front.x - 3, front.y - 2, 6, 16, 3);
      graphics.fillRoundedRect(back.x - 2, back.y - 2, 4, 11, 2);
    });

    if (definition.id.includes("linen")) {
      graphics.fillStyle(0xfffbf0, 0.74);
      graphics.fillPoints(this.insetPolygon(top, 0.08), true);
    }
  }

  private drawIsoChairDetails(graphics: Phaser.GameObjects.Graphics, context: FurnitureVisualContext): void {
    const { definition, top, bottom, center, visualRotation, tier } = context;
    const facing = ((visualRotation % 360) + 360) % 360;
    const backEdge =
      facing === 0 ? [top[0], top[1]] :
      facing === 90 ? [top[1], top[2]] :
      facing === 180 ? [top[2], top[3]] :
      [top[3], top[0]];
    const backHeight = 30 + tier * 2;
    const left = this.lerpPoint(backEdge[0], backEdge[1], 0.14);
    const right = this.lerpPoint(backEdge[0], backEdge[1], 0.86);
    const leftTop = new Phaser.Math.Vector2(left.x, left.y - backHeight);
    const rightTop = new Phaser.Math.Vector2(right.x, right.y - backHeight);
    graphics.fillStyle(this.shadeColor(definition.color, -34), 1);
    graphics.fillPoints([leftTop, rightTop, right, left], true);
    graphics.lineStyle(2, 0x5b4033, 0.9);
    graphics.strokePoints([leftTop, rightTop, right, left], true);
    graphics.lineStyle(2, this.shadeColor(definition.color, 44), 0.55);
    graphics.lineBetween(leftTop.x + 5, leftTop.y + 7, rightTop.x - 5, rightTop.y + 7);

    graphics.fillStyle(tier >= 3 ? this.shadeColor(definition.color, 24) : 0xf0b5a6, tier >= 3 ? 1 : 0.32);
    graphics.fillEllipse(center.x, center.y + 2, 22, 13);
    graphics.fillStyle(0x4d3428, 0.85);
    [0.2, 0.8].forEach((ratio) => {
      const foot = this.lerpPoint(bottom[3], bottom[2], ratio);
      graphics.fillRoundedRect(foot.x - 2, foot.y - 2, 4, 10, 2);
    });
  }

  private drawIsoStoveDetails(graphics: Phaser.GameObjects.Graphics, context: FurnitureVisualContext): void {
    const { definition, top, center, size, tier } = context;
    const burners = definition.cookingSlots ?? 1;
    const edges = this.getStoveLongEdges(top, size);
    const cookLineA = this.lerpPoint(edges.backA, edges.frontA, 0.53);
    const cookLineB = this.lerpPoint(edges.backB, edges.frontB, 0.53);
    const stripBackA = this.lerpPoint(edges.backA, edges.frontA, 0.28);
    const stripBackB = this.lerpPoint(edges.backB, edges.frontB, 0.28);
    const stripFrontB = this.lerpPoint(edges.backB, edges.frontB, 0.78);
    const stripFrontA = this.lerpPoint(edges.backA, edges.frontA, 0.78);
    graphics.fillStyle(0x2f383e, 0.92);
    graphics.fillPoints([stripBackA, stripBackB, stripFrontB, stripFrontA], true);
    graphics.lineStyle(3, 0xaeb9bd, 0.75);
    graphics.lineBetween(
      this.lerpPoint(edges.backA, edges.frontA, 0.18).x,
      this.lerpPoint(edges.backA, edges.frontA, 0.18).y,
      this.lerpPoint(edges.backB, edges.frontB, 0.18).x,
      this.lerpPoint(edges.backB, edges.frontB, 0.18).y,
    );
    for (let index = 0; index < burners; index += 1) {
      const burner = this.lerpPoint(cookLineA, cookLineB, (index + 1) / (burners + 1));
      graphics.fillStyle(0x31383d, 1);
      graphics.fillEllipse(burner.x, burner.y, 18, 12);
      graphics.fillStyle(tier >= 4 ? 0xffb45c : 0xffcf7d, 1);
      graphics.fillEllipse(burner.x, burner.y, 8, 5);
    }
    graphics.fillStyle(0x2f3b40, 0.95);
    graphics.fillRoundedRect(center.x - 18, center.y + 9, 36, 10, 4);
  }

  private getStoveLongEdges(
    top: Phaser.Math.Vector2[],
    size: { width: number; height: number },
  ): { backA: Phaser.Math.Vector2; backB: Phaser.Math.Vector2; frontA: Phaser.Math.Vector2; frontB: Phaser.Math.Vector2 } {
    if (size.width >= size.height) {
      return { backA: top[0], backB: top[1], frontA: top[3], frontB: top[2] };
    }

    return { backA: top[0], backB: top[3], frontA: top[1], frontB: top[2] };
  }

  private drawIsoCounterDetails(graphics: Phaser.GameObjects.Graphics, context: FurnitureVisualContext): void {
    const { definition, top, center, height, tier } = context;
    graphics.lineStyle(2, tier >= 4 ? 0xffffff : 0xffe0b2, 0.86);
    graphics.lineBetween(top[3].x + 10, top[3].y, top[1].x - 10, top[1].y);
    if (this.isSinkFurniture(definition.id) || this.isDishwasherFurniture(definition.id)) {
      graphics.fillStyle(0xd8f0ef, 1);
      graphics.fillRoundedRect(center.x - 24, center.y - 11, 48, 19, 5);
      graphics.lineStyle(2, 0x65747d, 0.9);
      graphics.strokeRoundedRect(center.x - 24, center.y - 11, 48, 19, 5);
      if (this.isDishwasherFurniture(definition.id)) {
        graphics.fillStyle(0xbcc6ce, 1);
        graphics.fillCircle(center.x - 16, center.y + 17, 3);
        graphics.fillCircle(center.x + 16, center.y + 17, 3);
      }
    } else {
      graphics.fillStyle(this.shadeColor(definition.color, -58), 0.9);
      graphics.fillRoundedRect(center.x - 18, center.y + 8, 36, 14, 4);
      graphics.fillStyle(0xd7c080, 1);
      graphics.fillCircle(center.x, center.y + 15, 5);
    }
    graphics.lineStyle(1, 0x5b4033, 0.45);
    graphics.lineBetween(top[3].x + 8, top[3].y + height * 0.55, top[2].x - 8, top[2].y + height * 0.55);
  }

  private drawIsoDecorDetails(graphics: Phaser.GameObjects.Graphics, context: FurnitureVisualContext): void {
    const { definition, center, tier } = context;
    if (definition.category === "plant") {
      graphics.fillStyle(0x8c5a3c, 1);
      graphics.fillRoundedRect(center.x - 12, center.y + 4, 24, 13, 4);
      graphics.fillStyle(this.shadeColor(definition.color, -18), 1);
      graphics.fillEllipse(center.x, center.y + 1, 22, 12);
      graphics.fillStyle(definition.color, 1);
      graphics.fillCircle(center.x, center.y - 15, 12 + tier);
      graphics.fillCircle(center.x - 11, center.y - 7, 8 + tier * 0.6);
      graphics.fillCircle(center.x + 11, center.y - 7, 8 + tier * 0.6);
      return;
    }

    graphics.fillStyle(this.shadeColor(definition.color, 24), 1);
    graphics.fillRoundedRect(center.x - 17, center.y - 8, 34, 18 + tier * 2, 5);
    graphics.lineStyle(2, 0x5b4033, 0.65);
    graphics.strokeRoundedRect(center.x - 17, center.y - 8, 34, 18 + tier * 2, 5);
  }

  private drawIsoLightingDetails(graphics: Phaser.GameObjects.Graphics, context: FurnitureVisualContext): void {
    const { center, tier } = context;
    graphics.lineStyle(2, 0x5b4033, 0.65);
    graphics.lineBetween(center.x, center.y + 6, center.x, center.y - 30 - tier * 3);
    graphics.fillStyle(0xf6d67a, 0.9);
    graphics.fillCircle(center.x, center.y - 34 - tier * 3, 8 + tier);
  }

  private getPolygonCenter(points: Phaser.Math.Vector2[]): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2(
      points.reduce((sum, point) => sum + point.x, 0) / points.length,
      points.reduce((sum, point) => sum + point.y, 0) / points.length,
    );
  }

  private getPointToPolygonDistance(point: Phaser.Math.Vector2, polygon: Phaser.Math.Vector2[]): number {
    if (this.isPointInPolygon(point, polygon)) {
      return 0;
    }

    return polygon.reduce((nearest, start, index) => {
      const end = polygon[(index + 1) % polygon.length];
      return Math.min(nearest, this.getPointToSegmentDistance(point, start, end));
    }, Number.POSITIVE_INFINITY);
  }

  private getPointToSegmentDistance(point: Phaser.Math.Vector2, start: Phaser.Math.Vector2, end: Phaser.Math.Vector2): number {
    const segment = end.clone().subtract(start);
    const segmentLengthSq = segment.lengthSq();
    if (segmentLengthSq <= 0.001) {
      return Phaser.Math.Distance.Between(point.x, point.y, start.x, start.y);
    }

    const t = Phaser.Math.Clamp(point.clone().subtract(start).dot(segment) / segmentLengthSq, 0, 1);
    const nearest = new Phaser.Math.Vector2(start.x + segment.x * t, start.y + segment.y * t);
    return Phaser.Math.Distance.Between(point.x, point.y, nearest.x, nearest.y);
  }

  private isPointInPolygon(point: Phaser.Math.Vector2, polygon: Phaser.Math.Vector2[]): boolean {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
      const currentPoint = polygon[index];
      const previousPoint = polygon[previous];
      const intersects =
        currentPoint.y > point.y !== previousPoint.y > point.y &&
        point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
      if (intersects) {
        inside = !inside;
      }
    }

    return inside;
  }

  private insetPolygon(points: Phaser.Math.Vector2[], amount: number): Phaser.Math.Vector2[] {
    const center = this.getPolygonCenter(points);
    return points.map((point) => this.lerpPoint(point, center, amount));
  }

  private lerpPoint(a: Phaser.Math.Vector2, b: Phaser.Math.Vector2, t: number): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2(Phaser.Math.Linear(a.x, b.x, t), Phaser.Math.Linear(a.y, b.y, t));
  }

  private drawFurniture(
    graphics: Phaser.GameObjects.Graphics,
    definition: FurnitureDefinition,
    x: number,
    y: number,
    width: number,
    height: number,
    rotation = 0,
  ): void {
    if (definition.category !== "flooring" && definition.category !== "wallDecoration") {
      this.drawObjectShadow(graphics, x, y, width, height, definition.category);
    }

    graphics.fillStyle(definition.color, 1);
    graphics.lineStyle(2, 0x5b4033, 1);

    if (definition.category === "table") {
      const top = this.drawRaisedRoundedBlock(graphics, x + 4, y + 2, width - 8, height - 5, definition.color, 16, 14);
      this.drawTableLegs(graphics, top, 14);
      if (definition.id === "two-top-table") {
        graphics.fillStyle(0xfff3d8, 1);
        graphics.fillCircle(top.x + top.width / 2, top.y + top.height * 0.34, 5);
        graphics.fillCircle(top.x + top.width / 2, top.y + top.height * 0.66, 5);
        return;
      }

      if (definition.id === "square-table") {
        graphics.lineStyle(1, 0x6f4d3d, 0.5);
        graphics.lineBetween(top.x + top.width / 2, top.y + 6, top.x + top.width / 2, top.y + top.height - 6);
        graphics.lineBetween(top.x + 6, top.y + top.height / 2, top.x + top.width - 6, top.y + top.height / 2);
        graphics.fillStyle(0xfff3d8, 1);
        graphics.fillCircle(top.x + top.width / 2, top.y + top.height / 2, 7);
        return;
      }

      if (definition.id === "booth-table") {
        graphics.fillStyle(0x6e4939, 1);
        graphics.fillRoundedRect(top.x + 3, top.y + 2, top.width - 6, 10, 5);
        graphics.fillRoundedRect(top.x + 3, top.y + top.height - 12, top.width - 6, 10, 5);
        graphics.fillStyle(0xfff3d8, 1);
        graphics.fillCircle(top.x + top.width / 2, top.y + top.height / 2, 8);
        return;
      }

      if (definition.id === "marble-table") {
        graphics.lineStyle(1, 0x9f9a90, 0.65);
        graphics.lineBetween(top.x + 14, top.y + 14, top.x + top.width - 14, top.y + top.height - 16);
        graphics.lineBetween(top.x + 28, top.y + top.height - 12, top.x + top.width - 22, top.y + 16);
        graphics.fillStyle(0xf8f4ea, 1);
        graphics.fillCircle(top.x + top.width / 2, top.y + top.height / 2, 9);
        return;
      }

      graphics.fillStyle(0xfff3d8, 1);
      graphics.fillCircle(top.x + top.width / 2, top.y + top.height / 2, 8);
      return;
    }

    if (definition.category === "chair") {
      const normalizedChairRotation = ((rotation % 360) + 360) % 360;
      if (normalizedChairRotation === 0 || normalizedChairRotation === 90 || normalizedChairRotation === 270) {
        this.drawChairBackrest(graphics, x + 8, y + 3, width - 16, height - 14, definition.color, normalizedChairRotation);
      }
      const top = this.drawChairSeat(graphics, x + 8, y + 13, width - 16, height - 15, definition.color, normalizedChairRotation);
      if (normalizedChairRotation === 180) {
        this.drawChairBackrest(graphics, x + 8, y + 3, width - 16, height - 14, definition.color, normalizedChairRotation);
      }
      if (definition.id === "wooden-chair") {
        return;
      }

      if (definition.id === "padded-chair") {
        graphics.fillStyle(0xf0b5a6, 1);
        graphics.fillRoundedRect(top.x + 4, top.y + 4, top.width - 8, Math.max(6, top.height - 7), 7);
        return;
      }

      if (definition.id === "bench-seat") {
        graphics.fillStyle(0x9d5450, 1);
        graphics.fillRoundedRect(x + 6, y + 4, width - 12, 12, 5);
        return;
      }

      if (definition.id === "velvet-chair") {
        graphics.fillStyle(0xc995b2, 1);
        graphics.fillCircle(top.x + top.width / 2, top.y + top.height / 2 + 3, 9);
        graphics.fillStyle(0xe5c0d3, 1);
        graphics.fillCircle(top.x + top.width / 2, top.y + 6, 5);
        return;
      }

      return;
    }

    if (definition.category === "stove") {
      const top = this.drawRaisedRoundedBlock(graphics, x, y, width, height, definition.color, 18, 6);
      this.drawFrontPanelLines(graphics, top, 18, 0x263238);
      graphics.fillStyle(0x31383d, 1);
      const burners = definition.cookingSlots ?? 1;
      for (let index = 0; index < burners; index += 1) {
        const burnerX = top.x + ((index + 1) / (burners + 1)) * top.width;
        graphics.fillCircle(burnerX, top.y + top.height / 2, 9);
        graphics.fillStyle(0xffcf7d, 1);
        graphics.fillCircle(burnerX, top.y + top.height / 2, 4);
        graphics.fillStyle(0x31383d, 1);
      }
      if (definition.id === "chef-range") {
        graphics.fillStyle(0xb8c7cf, 1);
        graphics.fillRect(top.x + 10, top.y + 7, top.width - 20, 5);
      }
      if (definition.id === "double-stove") {
        graphics.lineStyle(2, 0x20272c, 1);
        graphics.lineBetween(top.x + top.width / 2, top.y + 6, top.x + top.width / 2, top.y + top.height - 6);
      }
      return;
    }

    if (definition.category === "counter") {
      const top = this.drawRaisedRoundedBlock(graphics, x, y, width, height, definition.color, 18, 6);
      this.drawFrontPanelLines(graphics, top, 18, 0x7a4d38);
      if (this.isSinkFurniture(definition.id)) {
        graphics.fillStyle(definition.id === "copper-sink" ? 0xe0a878 : 0xd8f0ef, 1);
        graphics.fillRoundedRect(top.x + 9, top.y + 8, top.width - 18, top.height - 14, 6);
        graphics.lineStyle(2, definition.id === "copper-sink" ? 0x8f5638 : 0x5d7f80, 1);
        graphics.strokeRoundedRect(top.x + 9, top.y + 8, top.width - 18, top.height - 14, 6);
        graphics.fillStyle(0x6f8d8f, 1);
        graphics.fillRect(top.x + top.width / 2 - 3, top.y + 5, 6, 12);
        graphics.fillCircle(top.x + top.width / 2 + 8, top.y + 15, 3);
        return;
      }

      if (this.isDishwasherFurniture(definition.id)) {
        graphics.fillStyle(definition.id === "quiet-dishwasher" ? 0xd9e0e4 : 0xc7d0d6, 1);
        graphics.fillRoundedRect(top.x + 8, top.y + 7, top.width - 16, top.height - 13, 4);
        graphics.lineStyle(2, 0x65747d, 1);
        graphics.strokeRoundedRect(top.x + 8, top.y + 7, top.width - 16, top.height - 13, 4);
        graphics.fillStyle(0x65747d, 1);
        graphics.fillCircle(top.x + top.width - 18, top.y + 16, 4);
        graphics.fillRect(top.x + 16, top.y + top.height - 10, top.width - 32, 3);
        return;
      }

      if (definition.id === "prep-station") {
        graphics.fillStyle(0xe7b98e, 1);
        graphics.fillRect(top.x + 8, top.y + 7, top.width - 16, 8);
        graphics.fillStyle(0x6b8f69, 1);
        graphics.fillCircle(top.x + top.width - 22, top.y + top.height / 2, 6);
        return;
      }

      if (definition.id === "cash-counter") {
        graphics.fillStyle(0x3f4a52, 1);
        graphics.fillRoundedRect(top.x + top.width - 36, top.y + 8, 26, top.height - 13, 4);
        graphics.fillStyle(0xffe0b2, 1);
        graphics.fillRect(top.x + 8, top.y + 8, top.width - 52, 8);
        return;
      }

      if (definition.id === "espresso-counter") {
        graphics.fillStyle(0x2f363a, 1);
        graphics.fillRoundedRect(top.x + 12, top.y + 7, 28, top.height - 13, 4);
        graphics.fillStyle(0xd7b77a, 1);
        graphics.fillCircle(top.x + 54, top.y + top.height / 2, 6);
        graphics.fillRect(top.x + 70, top.y + 9, top.width - 84, 7);
        return;
      }

      graphics.fillStyle(0xffe0b2, 1);
      graphics.fillRect(top.x + 8, top.y + 8, top.width - 16, 8);
      return;
    }

    if (definition.category === "plant") {
      if (definition.id === "fern-planter") {
        graphics.fillStyle(0x8c5a3c, 1);
        graphics.fillRoundedRect(x + 10, y + 28, width - 20, 12, 4);
        graphics.lineStyle(4, 0x4f9d72, 1);
        graphics.lineBetween(x + width / 2, y + 28, x + 12, y + 10);
        graphics.lineBetween(x + width / 2, y + 28, x + width - 12, y + 10);
        graphics.lineBetween(x + width / 2, y + 28, x + width / 2, y + 6);
        return;
      }

      if (definition.id === "flower-pot") {
        graphics.fillStyle(0x8c5a3c, 1);
        graphics.fillRoundedRect(x + 12, y + 25, width - 24, 14, 4);
        graphics.fillStyle(0xd0708d, 1);
        graphics.fillCircle(x + width / 2 - 8, y + 18, 6);
        graphics.fillCircle(x + width / 2 + 8, y + 18, 6);
        graphics.fillCircle(x + width / 2, y + 10, 6);
        graphics.fillStyle(0x4e9d63, 1);
        graphics.fillCircle(x + width / 2, y + 24, 8);
        return;
      }

      graphics.fillStyle(0x8c5a3c, 1);
      graphics.fillRoundedRect(x + 12, y + 25, width - 24, 14, 4);
      graphics.fillStyle(0x4e9d63, 1);
      graphics.fillCircle(x + width / 2, y + 19, 12);
      graphics.fillCircle(x + width / 2 - 8, y + 25, 8);
      graphics.fillCircle(x + width / 2 + 8, y + 25, 8);
      return;
    }

    if (definition.category === "wallDecoration") {
      const isWallFinish = this.isWallFinishFurniture(definition.id);
      graphics.fillStyle(0x3b2a21, 0.14);
      graphics.fillRoundedRect(x + 6, y + height - 8, width - 12, 8, 4);
      graphics.fillStyle(0xe2aa79, 1);
      graphics.fillRoundedRect(x + 4, y + 4, width - 8, height - 14, 5);
      graphics.lineStyle(2, 0x7d4f3a, 0.9);
      graphics.strokeRoundedRect(x + 4, y + 4, width - 8, height - 14, 5);
      graphics.fillStyle(definition.color, 1);
      if (isWallFinish) {
        graphics.fillRoundedRect(x + 7, y + 7, width - 14, height - 20, 4);
        graphics.strokeRoundedRect(x + 7, y + 7, width - 14, height - 20, 4);
        graphics.lineStyle(1, 0xffffff, 0.42);
        if (definition.id.includes("wallpaper")) {
          for (let stripeX = x + 13; stripeX < x + width - 10; stripeX += 12) {
            graphics.lineBetween(stripeX, y + 10, stripeX - 8, y + height - 16);
          }
        } else {
          graphics.fillStyle(0xffffff, 0.28);
          graphics.fillRect(x + 12, y + 12, width - 24, 5);
        }
        return;
      }

      if (this.isWindowFurniture(definition.id)) {
        graphics.fillStyle(definition.color, 1);
        graphics.fillRoundedRect(x + 8, y + 7, width - 16, height - 21, 5);
        graphics.lineStyle(2, 0x6d4f3d, 1);
        graphics.strokeRoundedRect(x + 8, y + 7, width - 16, height - 21, 5);
        graphics.fillStyle(0xb9dce6, 1);
        graphics.fillRoundedRect(x + 13, y + 12, width - 26, height - 31, 4);
        graphics.lineStyle(2, 0xfffbf0, 0.95);
        graphics.strokeRoundedRect(x + 13, y + 12, width - 26, height - 31, 4);
        graphics.lineBetween(x + width / 2, y + 13, x + width / 2, y + height - 20);
        graphics.lineBetween(x + 14, y + height / 2, x + width - 14, y + height / 2);
        if (definition.id.includes("curtain") || definition.id.includes("arched") || definition.id.includes("stained")) {
          graphics.fillStyle(definition.id.includes("stained") ? 0xf1c76f : 0xa76b87, 0.7);
          graphics.fillRect(x + 13, y + 12, 8, height - 31);
          graphics.fillRect(x + width - 21, y + 12, 8, height - 31);
        }
        return;
      }

      if (definition.id === "framed-art") {
        graphics.fillRoundedRect(x + 8, y + 8, width - 16, height - 22, 4);
        graphics.strokeRoundedRect(x + 8, y + 8, width - 16, height - 22, 4);
        graphics.fillStyle(0xf3d7b5, 1);
        graphics.fillTriangle(x + 18, y + height - 18, x + width / 2, y + 18, x + width - 18, y + height - 18);
        return;
      }

      if (definition.id === "chalk-specials") {
        graphics.fillRoundedRect(x + 8, y + 10, width - 16, height - 24, 4);
        graphics.strokeRoundedRect(x + 8, y + 10, width - 16, height - 24, 4);
        graphics.lineStyle(2, 0xf5ecd5, 1);
        graphics.lineBetween(x + 14, y + 18, x + width - 14, y + 18);
        graphics.lineBetween(x + 18, y + 28, x + width - 28, y + 28);
        return;
      }

      graphics.fillRoundedRect(x + 8, y + 10, width - 16, height - 24, 4);
      graphics.strokeRoundedRect(x + 8, y + 10, width - 16, height - 24, 4);
      graphics.fillStyle(0xfff3d8, 1);
      graphics.fillRect(x + 14, y + 18, width - 28, 4);
      return;
    }

    if (definition.category === "lighting") {
      if (definition.id === "chandelier") {
        graphics.fillStyle(0x7f6245, 1);
        graphics.fillRect(x + width / 2 - 2, y + 6, 4, 12);
        graphics.lineStyle(3, 0xe9c15c, 1);
        graphics.lineBetween(x + width / 2, y + 18, x + 16, y + height - 12);
        graphics.lineBetween(x + width / 2, y + 18, x + width - 16, y + height - 12);
        graphics.fillStyle(0xffe8a6, 1);
        graphics.fillCircle(x + 16, y + height - 12, 7);
        graphics.fillCircle(x + width / 2, y + height - 18, 7);
        graphics.fillCircle(x + width - 16, y + height - 12, 7);
        return;
      }

      graphics.fillStyle(0x7f6245, 1);
      graphics.fillRoundedRect(x + width / 2 - 6, y + 20, 12, height - 24, 5);
      graphics.fillStyle(definition.id === "floor-candles" ? 0xffe1a1 : 0xf1c76f, 1);
      graphics.fillCircle(x + width / 2, y + 16, 12);
      return;
    }

    if (definition.category === "flooring") {
      graphics.fillStyle(definition.color, 0.72);
      graphics.fillRect(x - 2, y - 2, width + 4, height + 4);
      graphics.lineStyle(1, 0xffffff, 0.28);
      const step = definition.id === "mosaic-floor" ? 14 : 24;
      for (let tx = x + step; tx < x + width; tx += step) {
        graphics.lineBetween(tx, y - 1, tx, y + height + 1);
      }
      for (let ty = y + step; ty < y + height; ty += step) {
        graphics.lineBetween(x - 1, ty, x + width + 1, ty);
      }
      return;
    }

    graphics.fillRoundedRect(x, y + 8, width, height - 16, 12);
    graphics.strokeRoundedRect(x, y + 8, width, height - 16, 12);
  }

  private drawObjectShadow(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    category: FurnitureDefinition["category"],
  ): void {
    const inset = category === "plant" || category === "lighting" ? 10 : 4;
    const shadowHeight = category === "table" || category === "counter" || category === "stove" ? 12 : 8;
    graphics.fillStyle(0x3b2a21, 0.16);
    graphics.fillRoundedRect(
      x + inset,
      y + height - shadowHeight + 4,
      Math.max(8, width - inset * 2),
      shadowHeight,
      shadowHeight / 2,
    );
  }

  private drawRaisedRoundedBlock(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
    lift: number,
    radius: number,
  ): { x: number; y: number; width: number; height: number } {
    const topHeight = Math.max(8, height - lift);
    const frontColor = this.shadeColor(color, -54);
    const sideColor = this.shadeColor(color, -36);
    const highlightColor = this.shadeColor(color, 36);
    const sideWidth = Math.min(14, Math.max(7, width * 0.14));

    graphics.fillStyle(sideColor, 1);
    graphics.fillRoundedRect(x + width - sideWidth, y + 3, sideWidth, topHeight + lift, 4);
    graphics.lineStyle(1, 0x4f3529, 0.55);
    graphics.lineBetween(x + width - sideWidth, y + 6, x + width - sideWidth, y + topHeight + lift - 3);
    graphics.fillStyle(frontColor, 1);
    graphics.fillRoundedRect(x, y + topHeight - 1, width, lift + 2, Math.min(radius, 8));
    graphics.lineStyle(1, 0x4f3529, 0.65);
    graphics.lineBetween(x + 3, y + topHeight, x + width - 3, y + topHeight);

    graphics.fillStyle(color, 1);
    graphics.fillRoundedRect(x, y, width, topHeight, radius);
    graphics.lineStyle(2, 0x5b4033, 1);
    graphics.strokeRoundedRect(x, y, width, topHeight, radius);
    graphics.fillStyle(highlightColor, 0.35);
    graphics.fillRoundedRect(x + 7, y + 6, Math.max(8, width - 14), Math.min(6, topHeight * 0.22), 3);

    return { x, y, width, height: topHeight };
  }

  private drawTableLegs(
    graphics: Phaser.GameObjects.Graphics,
    top: { x: number; y: number; width: number; height: number },
    legHeight: number,
  ): void {
    const legColor = 0x5b4033;
    const frontY = top.y + top.height - 1;
    const backY = top.y + Math.max(8, top.height * 0.28);
    const positions = [
      { x: top.x + 12, y: frontY, alpha: 1 },
      { x: top.x + top.width - 16, y: frontY, alpha: 1 },
      { x: top.x + 14, y: backY, alpha: 0.45 },
      { x: top.x + top.width - 18, y: backY, alpha: 0.45 },
    ];

    positions.forEach((leg) => {
      graphics.fillStyle(legColor, leg.alpha);
      graphics.fillRoundedRect(leg.x, leg.y, 6, legHeight, 3);
      graphics.fillStyle(0x2e211b, leg.alpha * 0.8);
      graphics.fillRect(leg.x + 4, leg.y + 1, 2, legHeight - 2);
    });
  }

  private drawChairBackrest(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
    rotation: number,
  ): void {
    const backHeight = Math.max(12, height * 0.44);
    const sideColor = this.shadeColor(color, -42);
    const highlightColor = this.shadeColor(color, 34);
    graphics.fillStyle(sideColor, 1);
    if (rotation === 90) {
      graphics.fillRoundedRect(x + width - 8, y + 6, 16, height - 8, 5);
      graphics.fillStyle(color, 1);
      graphics.fillRoundedRect(x + width - 16, y + 3, 16, height - 13, 5);
      graphics.fillStyle(highlightColor, 0.28);
      graphics.fillRect(x + width - 13, y + 9, 4, Math.max(6, height - 25));
      graphics.lineStyle(2, 0x5b4033, 0.9);
      graphics.strokeRoundedRect(x + width - 16, y + 3, 16, height - 13, 5);
      return;
    }

    if (rotation === 270) {
      graphics.fillRoundedRect(x - 8, y + 6, 16, height - 8, 5);
      graphics.fillStyle(color, 1);
      graphics.fillRoundedRect(x, y + 3, 16, height - 13, 5);
      graphics.fillStyle(highlightColor, 0.28);
      graphics.fillRect(x + 5, y + 9, 4, Math.max(6, height - 25));
      graphics.lineStyle(2, 0x5b4033, 0.9);
      graphics.strokeRoundedRect(x, y + 3, 16, height - 13, 5);
      return;
    }

    const backY = rotation === 180 ? y + height - backHeight + 8 : y - 8;
    graphics.fillRoundedRect(x + 2, backY + 4, width - 4, backHeight + 8, 6);
    graphics.fillStyle(color, 1);
    graphics.fillRoundedRect(x, backY, width - 5, backHeight, 6);
    graphics.lineStyle(2, 0x5b4033, 0.9);
    graphics.strokeRoundedRect(x, backY, width - 5, backHeight, 6);
    graphics.fillStyle(highlightColor, 0.32);
    graphics.fillRect(x + 5, backY + 4, Math.max(6, width - 16), 4);
  }

  private drawChairSeat(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
    rotation: number,
  ): { x: number; y: number; width: number; height: number } {
    if (rotation === 90 || rotation === 270) {
      const offset = rotation === 90 ? -5 : 5;
      return this.drawRaisedRoundedBlock(graphics, x + offset + 4, y + 8, width - 8, height - 10, color, 9, 7);
    }

    return this.drawRaisedRoundedBlock(graphics, x, y, width, height, color, 10, 7);
  }

  private drawFrontPanelLines(
    graphics: Phaser.GameObjects.Graphics,
    top: { x: number; y: number; width: number; height: number },
    lift: number,
    color: number,
  ): void {
    const panelY = top.y + top.height + 4;
    graphics.lineStyle(1, color, 0.42);
    graphics.lineBetween(top.x + 8, panelY, top.x + top.width - 8, panelY);
    graphics.lineBetween(top.x + 10, panelY + lift * 0.45, top.x + top.width - 12, panelY + lift * 0.45);
    graphics.fillStyle(0xffffff, 0.16);
    graphics.fillRect(top.x + 10, panelY - 2, Math.max(8, top.width - 20), 3);
  }

  private shadeColor(color: number, amount: number): number {
    const red = Phaser.Math.Clamp(((color >> 16) & 0xff) + amount, 0, 255);
    const green = Phaser.Math.Clamp(((color >> 8) & 0xff) + amount, 0, 255);
    const blue = Phaser.Math.Clamp((color & 0xff) + amount, 0, 255);
    return (red << 16) + (green << 8) + blue;
  }

  private drawObjectVolumeBase(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    category: FurnitureDefinition["category"],
  ): void {
    const extrusion = category === "table" || category === "counter" || category === "stove" ? 20 : category === "chair" ? 13 : 10;
    const inset = category === "chair" ? 7 : 3;
    const left = x + inset;
    const right = x + width - inset;
    const top = y + inset;
    const bottom = y + height - inset;

    graphics.fillStyle(0x5b4033, category === "chair" ? 0.28 : 0.42);
    graphics.fillPoints(
      [
        new Phaser.Math.Vector2(left, bottom),
        new Phaser.Math.Vector2(right, bottom),
        new Phaser.Math.Vector2(right + extrusion, bottom + extrusion * 0.62),
        new Phaser.Math.Vector2(left + extrusion, bottom + extrusion * 0.62),
      ],
      true,
    );
    graphics.fillStyle(0x6f4d3d, category === "chair" ? 0.24 : 0.36);
    graphics.fillPoints(
      [
        new Phaser.Math.Vector2(right, top),
        new Phaser.Math.Vector2(right, bottom),
        new Phaser.Math.Vector2(right + extrusion, bottom + extrusion * 0.62),
        new Phaser.Math.Vector2(right + extrusion, top + extrusion * 0.62),
      ],
      true,
    );
    graphics.fillStyle(0xffffff, 0.12);
    graphics.fillRoundedRect(left + 3, top + 2, Math.max(8, width - inset * 2 - 4), 5, 3);
  }

  private drawChairFacingCue(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    rotation: number,
    color: number,
  ): void {
    const normalizedRotation = ((rotation % 360) + 360) % 360;
    graphics.lineStyle(4, color, 1);

    if (normalizedRotation === 90) {
      graphics.lineBetween(x + width - 7, y + 10, x + width - 7, y + height - 10);
      graphics.lineBetween(x + width - 11, y + 12, x + width - 3, y + 12);
      graphics.lineBetween(x + width - 11, y + height - 12, x + width - 3, y + height - 12);
      return;
    }

    if (normalizedRotation === 180) {
      graphics.lineBetween(x + 10, y + height - 7, x + width - 10, y + height - 7);
      graphics.lineBetween(x + 12, y + height - 11, x + 12, y + height - 3);
      graphics.lineBetween(x + width - 12, y + height - 11, x + width - 12, y + height - 3);
      return;
    }

    if (normalizedRotation === 270) {
      graphics.lineBetween(x + 7, y + 10, x + 7, y + height - 10);
      graphics.lineBetween(x + 3, y + 12, x + 11, y + 12);
      graphics.lineBetween(x + 3, y + height - 12, x + 11, y + height - 12);
      return;
    }

    graphics.lineBetween(x + 10, y + 7, x + width - 10, y + 7);
    graphics.lineBetween(x + 12, y + 3, x + 12, y + 11);
    graphics.lineBetween(x + width - 12, y + 3, x + width - 12, y + 11);
  }

  private updatePreview(pointer: Phaser.Input.Pointer): void {
    this.preview.clear();
    this.previewSprite.setVisible(false);
    this.previewHint.setVisible(false);
    if (!this.isPointerInRestaurantView(pointer)) {
      this.preview.setVisible(false);
      return;
    }

    const localPointer = this.getRestaurantPointerPosition(pointer);
    const selectedId = this.mode === "move"
      ? this.placement.getSelectedPlacedFurniture()?.furnitureId ?? null
      : this.placement.getSelectedFurnitureId();
    if (!selectedId || (this.mode !== "build" && this.mode !== "move")) {
      this.preview.setVisible(false);
      return;
    }

    const definition = getFurnitureDefinition(selectedId);
    if (this.isWallMountedFurniture(definition)) {
      this.updateWallPlacementPreview(definition, localPointer);
      return;
    }

    const gridPosition = this.grid.worldToGrid(localPointer.x, localPointer.y);
    if (!gridPosition) {
      this.preview.setVisible(false);
      return;
    }

    const rotation = this.mode === "move"
      ? this.placement.getSelectedRotation()
      : this.placement.getSelectedRotation();
    const previewState = this.mode === "move"
      ? this.getMovePlacementPreview(definition, gridPosition)
      : this.getBuildPlacementPreview(definition, gridPosition);
    const size = this.grid.getRotatedSize(definition, rotation);
    const top = this.grid.getAreaDiamond(gridPosition, size);
    const center = this.getPolygonCenter(top);
    const previewFill = !previewState.ok ? 0xd66b6b : previewState.affordable ? 0x8fcf9b : 0xe7b75a;
    const previewStroke = !previewState.ok ? 0xff2f2f : previewState.affordable ? 0x42b968 : 0xd88a17;
    const previewItem: PlacedFurniture = {
      uid: "placement-preview",
      furnitureId: definition.id,
      position: gridPosition,
      rotation,
    };

    this.preview.setVisible(true);
    const visualRotation = this.getPreviewFurnitureVisualRotation(definition, previewItem);
    const previewContext = this.createFurnitureVisualContext(definition, previewItem, visualRotation);
    const hasSpritePreview = this.configureFurnitureSprite(this.previewSprite, previewContext);
    if (hasSpritePreview) {
      this.previewSprite
        .setAlpha(0.68)
        .setVisible(true);
    } else {
      this.preview.setAlpha(0.55);
      this.drawIsoFurniture(this.preview, previewContext);
    }
    this.preview.setAlpha(1);
    this.drawFurnitureFootprintHighlight(
      this.preview,
      definition,
      gridPosition,
      rotation,
      previewFill,
      previewStroke,
    );
    this.previewHint
      .setText(previewState.message)
      .setPosition(center.x + this.grid.tileSize * 0.55, center.y - this.grid.tileHeight * 0.85)
      .setVisible(true);
  }

  private updateWallPlacementPreview(definition: FurnitureDefinition, localPointer: Phaser.Math.Vector2): void {
    const target = this.getWallPlacementTarget(definition, localPointer);
    if (!target) {
      this.preview.setVisible(false);
      this.previewHint
        .setText(this.isDoorFurniture(definition.id) ? "Choose the front entrance" : "Choose a wall")
        .setPosition(localPointer.x + 18, localPointer.y - 24)
        .setVisible(true);
      return;
    }

    this.placement.setSelectedRotation(target.rotation);
    const ignoreUid = this.mode === "move" ? this.placement.getSelectedPlacedUid() ?? undefined : undefined;
    const hasSpace = this.isDoorFurniture(definition.id)
      ? true
      : this.grid.canPlace(definition, target.position, this.placement.getFurniture(), ignoreUid, {
        ignoreFlooring: true,
        rotation: target.rotation,
      });
    const cost = this.getFurniturePurchaseCost(definition);
    const affordable = this.mode === "move" || this.economy.canAfford(cost);
    const message = !hasSpace
      ? "Wall spot taken"
      : this.isDoorFurniture(definition.id)
        ? affordable
          ? "Replace entrance door"
          : `Need $${Math.max(0, cost - this.economy.getMoney())} more`
        : affordable
          ? "Wall snap"
        : `Need $${Math.max(0, cost - this.economy.getMoney())} more`;
    const previewFill = !hasSpace ? 0xd66b6b : affordable ? 0x8fcf9b : 0xe7b75a;
    const previewStroke = !hasSpace ? 0xff2f2f : affordable ? 0x42b968 : 0xd88a17;
    const previewItem: PlacedFurniture = {
      uid: "placement-preview",
      furnitureId: definition.id,
      position: target.position,
      rotation: target.rotation,
    };
    const context = this.createFurnitureVisualContext(definition, previewItem, target.rotation);
    const panel = this.getWallDecorationPanel(context);
    const center = this.getPolygonCenter(panel);

    this.preview.setVisible(true);
    this.preview.fillStyle(previewFill, 0.18);
    this.preview.fillPoints(panel, true);
    this.preview.setAlpha(0.68);
    this.drawIsoFurniture(this.preview, context);
    this.preview.setAlpha(1);
    this.preview.lineStyle(3, previewStroke, 0.95);
    this.preview.strokePoints(panel, true);
    this.previewHint
      .setText(message)
      .setPosition(center.x + 18, center.y - 18)
      .setVisible(true);
  }

  private getPreviewFurnitureVisualRotation(definition: FurnitureDefinition, previewItem: PlacedFurniture): number {
    const rotation = previewItem.rotation ?? 0;
    if (definition.category !== "chair") {
      return this.getViewAdjustedFurnitureRotation(rotation);
    }

    const selectedMoveItem = this.mode === "move" ? this.placement.getSelectedPlacedFurniture() : null;
    const furnitureWithPreview = this.getFurnitureWithCandidate(
      previewItem.furnitureId,
      previewItem.position,
      rotation,
      selectedMoveItem?.uid,
    );
    const previewSeats = this.getDiningSeats(furnitureWithPreview).filter((seat) => seat.chairUid === previewItem.uid);
    return this.getChairBackRotationForSeats(previewSeats, rotation);
  }

  private hireStaff(role: StaffRole): void {
    const cost = this.getStaffHireCost(role);
    if (!this.spendMoney(cost, "staff")) {
      this.updateStats(`Need $${cost} to hire a ${role}`);
      return;
    }

    const newStaffIndex = this.staffSystem.addStaff(role);
    this.addStaffActor(role, newStaffIndex);
    this.persistQuietly();
    this.updateStats(`${this.staffSystem.getStaffRoleLabel(role)} hired`);
  }

  private fireStaff(role: StaffRole): void {
    const cost = this.getStaffFireCost(role);
    const roleLabel = this.getStaffRoleLabel(role).toLowerCase();
    const remainingAfterQueuedFire = this.getStaffCount(role) - this.staffSystem.getPendingFirings(role) - 1;
    if (role === "chef" && remainingAfterQueuedFire < 1) {
      this.showToast("Keep at least one chef on the team", "error");
      this.updateStats("Keep at least one chef");
      return;
    }

    if (role === "waiter" && remainingAfterQueuedFire < 1) {
      this.showToast("Keep at least one waiter on the team", "error");
      this.updateStats("Keep at least one waiter");
      return;
    }

    if (remainingAfterQueuedFire < 0) {
      const message = `No ${roleLabel} available to fire`;
      this.showToast(message, "error");
      this.updateStats(message);
      return;
    }

    if (!this.spendMoney(cost, "staff")) {
      const message = `Need $${cost} to fire this ${roleLabel}`;
      this.showToast(message, "error");
      this.updateStats(message);
      return;
    }

    const actor = [...this.actors].reverse().find((item) => item.role === role && item.task === "idle");
    if (actor) {
      this.removeStaffActorForFiring(role, actor);
      this.persistQuietly();
      const message = `${this.getStaffRoleLabel(role)} fired for $${cost}`;
      this.showToast(message, "success");
      this.updateStats(message);
      return;
    }

    this.staffSystem.queueFiring(role);
    this.persistQuietly();
    const message = `${this.getStaffRoleLabel(role)} firing queued. They will leave after the current job.`;
    this.showToast(message, "info");
    this.updateStats(message);
  }

  private processPendingStaffFirings(): void {
    (["chef", "waiter", "errand"] as StaffRole[]).forEach((role) => {
      while (this.staffSystem.getPendingFirings(role) > 0) {
        const actor = [...this.actors].reverse().find((item) => item.role === role && item.task === "idle");
        if (!actor) {
          return;
        }

        this.staffSystem.drainPendingFiring(role);
        this.removeStaffActorForFiring(role, actor);
        const message = `${this.getStaffRoleLabel(role)} finished their job and left.`;
        this.showToast(message, "success");
        this.updateStats(message);
        this.persistQuietly();
      }
    });
  }

  private removeStaffActorForFiring(role: StaffRole, actor: Actor): void {
    this.staffSystem.removeStaff(role);
    actor.container.destroy();
    this.actors = this.actors.filter((item) => item !== actor);
    this.syncChefStations(true);
  }

  private getStaffRoleLabel(role: StaffRole): string {
    return this.staffSystem.getStaffRoleLabel(role);
  }

  private getStaffHireCost(role: StaffRole): number {
    return this.staffSystem.getStaffHireCost(role);
  }

  private getStaffFireCost(role: StaffRole): number {
    return this.staffSystem.getStaffFireCost(role);
  }

  private getStaffSalaryPerMinute(_role: StaffRole): number {
    return this.getPayrollPerStaffPerMinute();
  }

  private getStaffCount(role: StaffRole): number {
    return this.staffSystem.getStaffCount(role);
  }

  private getPayrollPerMinute(): number {
    return this.staffSystem.getTotalStaff() * this.getPayrollPerStaffPerMinute();
  }

  private chargeStaffSalaries(time: number): void {
    const { charge } = this.staffSystem.tickSalary(time, this.getPayrollPerStaffPerMinute());
    if (charge <= 0) {
      return;
    }

    const paid = Math.min(charge, this.economy.getMoney());
    if (paid > 0) {
      this.spendMoney(paid, "staff");
    }
  }

  private chargeRent(): void {
    const periodsDue = this.dayCycle.consumePendingRentPeriods();
    if (periodsDue === 0) {
      return;
    }

    const rentDue = this.getDailyRent() * periodsDue;
    this.forceSpendMoney(rentDue);
    const balance = this.economy.getMoney();
    this.updateStats(balance < 0 ? `Daily rent charged: $${rentDue}. Balance is -$${Math.abs(balance)}.` : `Daily rent paid: $${rentDue}`);
    this.persistQuietly();
  }

  /**
   * Fired the frame the in-game day timer crosses its threshold. Captures the day's
   * stats for the player, resets per-day counters across systems, and advances the
   * day counter.
   */
  private handleDayEnded(): void {
    const day = this.dayCycle.getDayNumber();
    const served = this.customers.getDailyServed();
    const lost = this.customers.getDailyLost();
    const revenue = this.economy.getDailyRevenue();
    const expenses = this.economy.getDailyExpenses();
    const net = revenue - expenses;
    const netLabel = net >= 0 ? `+$${net}` : `-$${Math.abs(net)}`;
    this.updateStats(
      `Day ${day} ended: served ${served}, lost ${lost}, revenue $${revenue}, expenses $${expenses} (net ${netLabel}).`,
    );
    this.economy.resetDailyTotals();
    this.customers.resetDailyTotals();
    this.dayCycle.rollOverDay();
    this.persistQuietly();
  }

  private getDailyRent(): number {
    return Math.max(0, Math.round(this.adminSettings.baseDailyRent + this.expansionLevel * this.adminSettings.rentPerExpansion));
  }

  private getRentHoursRemaining(): number {
    return this.dayCycle.getRentHoursRemaining();
  }

  private formatPlaytime(seconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
  }

  private toggleRestaurantOpen(): void {
    this.restaurantOpen = !this.restaurantOpen;
    if (this.restaurantOpen) {
      this.nextGuestAt = Math.min(this.nextGuestAt, this.time.now + 1200);
    }
    this.persistQuietly();
    this.updateStats(this.restaurantOpen ? "Restaurant opened to the public" : "Restaurant closed to new guests");
  }

  private startNewGame(): void {
    this.closeExpansionConfirmModal();
    this.pendingQuietSave = false;
    this.quietSaveDueAt = 0;
    this.saveSystem.clear(this.currentSaveSlot);
    this.scene.restart();
  }

  private loadSavedGame(): void {
    if (!this.saveSystem.load(this.currentSaveSlot)) {
      this.updateStats("No saved game found");
      return;
    }

    this.pendingQuietSave = false;
    this.quietSaveDueAt = 0;
    this.scene.restart();
  }

  private openSaveModal(mode: "save" | "load"): void {
    this.closeExpansionConfirmModal();
    this.closeSaveModal();
    this.closeAdminModal();
    this.closeRecipeUpgradeModal();
    const modal = this.add.container(0, 0).setDepth(3000);
    const shade = this.add.rectangle(gameWidth / 2, gameHeight / 2, gameWidth, gameHeight, 0x1f2528, 0.55);
    const panel = this.add.graphics();
    panel.fillStyle(panelFill, 1);
    panel.fillRoundedRect(500, 188, 600, 420, 10);
    panel.fillStyle(panelHeader, 1);
    panel.fillRoundedRect(500, 188, 600, 44, 10);
    panel.fillRect(500, 218, 600, 14);
    panel.lineStyle(2, panelStroke, 1);
    panel.strokeRoundedRect(500, 188, 600, 420, 10);
    const title = this.add.text(526, 200, mode === "save" ? "Save Game" : "Load Game", this.headingStyle());
    const close = this.createActionButton("Close", 990, 198, () => this.closeSaveModal(), 82, 28, 13);
    modal.add([shade, panel, title, close]);

    this.saveSystem.listSlots().forEach(({ slot, save }, index) => {
      const y = 258 + index * 96;
      const selected = slot === this.currentSaveSlot ? "Current" : `Slot ${slot}`;
      const summary = save
        ? `${selected}: Day ${save.dayNumber}, $${save.money}, Rating ${this.formatSavedRating(save)}`
        : `${selected}: Empty`;
      const detail = save?.lastSavedAt ? `Saved ${new Date(save.lastSavedAt).toLocaleString()}` : "No save data yet";
      const slotBox = this.add.graphics();
      slotBox.fillStyle(0xfff8e8, 1);
      slotBox.fillRoundedRect(526, y, 548, 74, 6);
      slotBox.lineStyle(1, panelStroke, 1);
      slotBox.strokeRoundedRect(526, y, 548, 74, 6);
      const summaryText = this.add.text(542, y + 10, summary, this.panelTextStyle(15)).setWordWrapWidth(350);
      const detailText = this.add.text(542, y + 38, detail, this.panelTextStyle(12)).setWordWrapWidth(350);
      const action = this.createActionButton(
        mode === "save" ? "Save Here" : "Load",
        944,
        y + 20,
        () => (mode === "save" ? this.saveToSlot(slot) : this.loadFromSlot(slot)),
        104,
        30,
        13,
      );
      if (mode === "load" && !save) {
        action.setText("Empty");
        action.setBackgroundColor("#8a7a64");
      }
      modal.add([slotBox, summaryText, detailText, action]);
    });

    this.saveModal = modal;
  }

  private closeSaveModal(): void {
    this.saveModal?.destroy(true);
    this.saveModal = null;
  }

  private openAdminModal(): void {
    this.closeExpansionConfirmModal();
    this.closeSaveModal();
    this.closeAdminModal();
    this.closeRecipeUpgradeModal();

    const modal = this.add.container(0, 0).setDepth(3200);
    const shade = this.add.rectangle(gameWidth / 2, gameHeight / 2, gameWidth, gameHeight, 0x1f2528, 0.45);
    const panel = this.add.graphics();
    panel.fillStyle(panelFill, 1);
    panel.fillRoundedRect(520, 124, 560, 744, 10);
    panel.fillStyle(panelHeader, 1);
    panel.fillRoundedRect(520, 124, 560, 44, 10);
    panel.fillRect(520, 154, 560, 14);
    panel.lineStyle(2, panelStroke, 1);
    panel.strokeRoundedRect(520, 124, 560, 744, 10);

    const title = this.add.text(546, 136, "Admin Settings", this.headingStyle());
    const close = this.createActionButton("Close", 970, 134, () => this.closeAdminModal(), 84, 28, 13);
    const intro = this.add
      .text(546, 178, "Tune prototype economy values. Changes save immediately and affect new purchases/orders.", this.panelTextStyle(13))
      .setWordWrapWidth(500);

    modal.add([shade, panel, title, close, intro]);
    this.addAdminSettingRow(
      modal,
      226,
      "Payroll",
      `$${this.adminSettings.payrollPerStaffPerMinute}/staff/min`,
      () => this.adjustAdminPayroll(-1),
      () => this.adjustAdminPayroll(1),
    );
    this.addAdminSettingRow(
      modal,
      284,
      "Starter Profit",
      `$${this.adminSettings.starterRecipeProfit}/level`,
      () => this.adjustAdminStarterProfit(-1),
      () => this.adjustAdminStarterProfit(1),
    );
    this.addAdminSettingRow(
      modal,
      342,
      "Item Costs",
      this.formatItemCostMultiplier(),
      () => this.adjustAdminItemCostMultiplier(-0.1),
      () => this.adjustAdminItemCostMultiplier(0.1),
    );
    this.addAdminSettingRow(
      modal,
      400,
      "Base Rent",
      `$${this.adminSettings.baseDailyRent}/day`,
      () => this.adjustAdminBaseRent(-250),
      () => this.adjustAdminBaseRent(250),
    );
    this.addAdminSettingRow(
      modal,
      458,
      "Rent / Expansion",
      `$${this.adminSettings.rentPerExpansion}/space`,
      () => this.adjustAdminRentPerExpansion(-250),
      () => this.adjustAdminRentPerExpansion(250),
    );
    this.addAdminSettingRow(
      modal,
      516,
      "First Expansion",
      `$${this.adminSettings.firstExpansionCost}`,
      () => this.adjustAdminFirstExpansionCost(-500),
      () => this.adjustAdminFirstExpansionCost(500),
    );
    this.addAdminSettingRow(
      modal,
      574,
      "Expansion Mult.",
      this.formatExpansionCostMultiplier(),
      () => this.adjustAdminExpansionCostMultiplier(-0.25),
      () => this.adjustAdminExpansionCostMultiplier(0.25),
    );
    this.addAdminSettingRow(
      modal,
      632,
      "Trash Drop",
      this.formatTrashDropChance(),
      () => this.adjustAdminTrashDropChance(-0.05),
      () => this.adjustAdminTrashDropChance(0.05),
    );
    this.addAdminPerformanceBox(modal);
    const ledger = this.createActionButton("Open Log", 546, 818, () => this.openTransactionLogSheet(), 104, 30, 13);
    const repair = this.createActionButton("Repair Save", 666, 818, () => this.repairCurrentSave(), 118, 30, 13);
    const undoExpansion = this.createActionButton("Undo Space", 800, 818, () => this.undoLastExpansion(), 108, 30, 13);
    const reset = this.createActionButton("Defaults", 924, 818, () => this.resetAdminSettings(), 104, 30, 13);
    modal.add([ledger, repair, undoExpansion, reset]);

    this.adminModal = modal;
  }

  private addAdminPerformanceBox(modal: Phaser.GameObjects.Container): void {
    const box = this.add.graphics();
    box.fillStyle(0xfff8e8, 1);
    box.fillRoundedRect(546, 692, 508, 106, 6);
    box.lineStyle(1, panelStroke, 0.85);
    box.strokeRoundedRect(546, 692, 508, 106, 6);
    const title = this.add.text(566, 700, "Performance", this.panelTextStyle(15)).setFixedSize(150, 22);
    const visualGuides = this.createActionButton(
      this.showVisualAnchorOverlay ? "Hide Guides" : "Show Guides",
      926,
      698,
      () => this.toggleVisualAnchorOverlay(),
      104,
      26,
      12,
    );
    const diagnostics = this.add
      .text(566, 728, this.getPerformanceDiagnosticsText(), {
        color: "#3b2a21",
        fontFamily: "Consolas, monospace",
        fontSize: "10px",
      })
      .setLineSpacing(1)
      .setWordWrapWidth(468);
    modal.add([box, title, visualGuides, diagnostics]);
  }

  private toggleVisualAnchorOverlay(): void {
    this.showVisualAnchorOverlay = !this.showVisualAnchorOverlay;
    this.renderFurniture(true);
    this.updateStats(this.showVisualAnchorOverlay ? "Visual anchor guides enabled" : "Visual anchor guides hidden");
    this.openAdminModal();
  }

  private getPerformanceDiagnosticsText(): string {
    const saveBytes = this.lastSaveBytes || this.saveSystem.getSaveSizeBytes(this.currentSaveSlot);
    const movingActors = this.actors.filter((actor) => actor.container.getData("motionTween")).length;
    const pathAverage = this.pathfindingWindowCalls > 0
      ? this.pathfindingWindowMs / this.pathfindingWindowCalls
      : this.pathfindingAverageMs;
    return [
      `Furniture ${this.placement.getFurniture().length}  Actors ${this.actors.length}  Guests ${this.guests.length}`,
      `Tickets ${this.tickets.length}  Moving ${movingActors}  Tweens ${this.tweens.getTweens().length}`,
      `Furniture draw ${this.furnitureRenderRate}/s, last ${this.lastFurnitureRenderMs.toFixed(1)}ms`,
      `Stats ${this.lastStatsUpdateMs.toFixed(1)}ms  Path avg ${pathAverage.toFixed(2)}ms`,
      `Save ${this.formatBytes(saveBytes)}, last ${this.lastSaveMs.toFixed(1)}ms${this.pendingQuietSave ? " pending" : ""}`,
      `Repair removes stale guests, tickets, and transient reservations only.`,
    ].join("\n");
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes >= 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${bytes} B`;
  }

  private openTransactionLogSheet(): void {
    const csv = this.createTransactionLogCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, "_blank");

    if (!opened) {
      const link = document.createElement("a");
      link.href = url;
      link.download = `cozy-bistro-transaction-log-slot-${this.currentSaveSlot}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      this.showToast("Transaction log downloaded.", "success");
    } else {
      this.showToast("Transaction log opened.", "success");
    }

    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    this.updateStats("Transaction log exported");
  }

  private createTransactionLogCsv(): string {
    const rows = [
      ["Transaction", "Balance"],
      ...this.economy.getTransactionLog().map((entry) => [
        `${new Date(entry.at).toLocaleString()} - ${entry.transaction}`,
        `$${entry.balance}`,
      ]),
    ];

    return rows.map((row) => row.map((cell) => this.escapeCsvCell(cell)).join(",")).join("\r\n");
  }

  private escapeCsvCell(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private repairCurrentSave(): void {
    const before = {
      guests: this.guests.length,
      tickets: this.tickets.length,
      dirtySeats: this.dirtySeatUids.size,
      cleaningSeats: this.cleaningSeatUids.size,
    };
    const activeGuestIds = new Set(
      this.guests
        .filter((guest) => guest.container.active && guest.state !== "leaving")
        .map((guest) => guest.id),
    );
    this.tickets
      .filter((ticket) => !activeGuestIds.has(ticket.guestId))
      .forEach((ticket) => ticket.readyPlate?.destroy());
    this.tickets = this.tickets.filter((ticket) => activeGuestIds.has(ticket.guestId));
    this.guests = this.guests.filter((guest) => guest.container.active && guest.state !== "leaving");

    const validSeatUids = new Set(this.getDiningSeats().map((seat) => seat.seatUid));
    this.dirtySeatUids = new Set([...this.dirtySeatUids].filter((seatUid) => validSeatUids.has(seatUid)));
    this.cleaningSeatUids = new Set([...this.cleaningSeatUids].filter((seatUid) => validSeatUids.has(seatUid)));
    this.cooking.prunePreparedServings();
    this.cooking.pruneErrandInTransit();
    this.reputation.reconcileRatingHistory();

    this.requestFurnitureRender("repair save");
    this.persistImmediately();
    const removedGuests = before.guests - this.guests.length;
    const removedTickets = before.tickets - this.tickets.length;
    const releasedSeats = before.dirtySeats + before.cleaningSeats - this.dirtySeatUids.size - this.cleaningSeatUids.size;
    const message = `Repair complete: removed ${removedGuests} stale guests, ${removedTickets} stale tickets, released ${Math.max(0, releasedSeats)} seats.`;
    this.showToast(message, "success");
    this.updateStats(message);
    this.openAdminModal();
  }

  private undoLastExpansion(): void {
    if (this.expansionLevel <= starterExpansionLevel) {
      const message = "No expansion to undo.";
      this.showToast(message, "info");
      this.updateStats(message);
      this.openAdminModal();
      return;
    }

    const expansion = this.getExpansionDefinitions().find((definition) => definition.level === this.expansionLevel);
    if (!expansion) {
      const message = "Could not find the current expansion.";
      this.showToast(message, "error");
      this.updateStats(message);
      this.openAdminModal();
      return;
    }

    const blockingFurniture = this.getExpansionUndoBlockers(expansion);
    if (blockingFurniture.length > 0) {
      const itemWord = blockingFurniture.length === 1 ? "item" : "items";
      const message = `Move or sell ${blockingFurniture.length} ${itemWord} in ${expansion.name} first.`;
      this.showToast(message, "error");
      this.updateStats(message);
      this.openAdminModal();
      return;
    }

    const wallItemsToMove = this.getWallMountedFurnitureInExpansion(expansion).length;
    const refund = this.getExpansionCost(expansion.level);
    this.expansionLevel -= 1;
    this.placement.clearSelection();
    this.syncLuxuryUnlocks();
    this.normalizeWallMountedFurnitureToCurrentWalls();
    this.refreshRestaurantShellAndGrid();
    this.renderFurniture(true);
    this.refreshCatalogUiIfReady();
    this.earnMoney(refund, "refund");
    this.persistImmediately();

    const message = wallItemsToMove > 0
      ? `${expansion.name} expansion undone. ${wallItemsToMove} wall item${wallItemsToMove === 1 ? "" : "s"} moved with the wall. Refunded $${refund}.`
      : `${expansion.name} expansion undone. Refunded $${refund}.`;
    this.showToast(message, "success");
    this.updateStats(message);
    this.openAdminModal();
  }

  private getExpansionUndoBlockers(expansion: ExpansionDefinition): PlacedFurniture[] {
    return this.getFurnitureInExpansion(expansion).filter((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      return !this.isWallMountedFurniture(definition);
    });
  }

  private getWallMountedFurnitureInExpansion(expansion: ExpansionDefinition): PlacedFurniture[] {
    return this.getFurnitureInExpansion(expansion).filter((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      return this.isWallMountedFurniture(definition);
    });
  }

  private getFurnitureInExpansion(expansion: ExpansionDefinition): PlacedFurniture[] {
    const expansionCells = new Set(expansion.cells.map((cell) => this.cellKey(cell)));
    return this.placement.getFurniture().filter((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      return this.grid
        .getOccupiedCells(definition, item.position, item.rotation ?? 0)
        .some((cell) => expansionCells.has(this.cellKey(cell)));
    });
  }

  private addAdminSettingRow(
    modal: Phaser.GameObjects.Container,
    y: number,
    label: string,
    value: string,
    onMinus: () => void,
    onPlus: () => void,
  ): void {
    const box = this.add.graphics();
    box.fillStyle(0xfff8e8, 1);
    box.fillRoundedRect(546, y, 508, 54, 6);
    box.lineStyle(1, panelStroke, 0.85);
    box.strokeRoundedRect(546, y, 508, 54, 6);
    const labelText = this.add.text(566, y + 10, label, this.panelTextStyle(15)).setFixedSize(150, 26);
    const valueText = this.add.text(724, y + 10, value, this.panelTextStyle(15)).setFixedSize(120, 26);
    const minus = this.createActionButton("-", 884, y + 11, onMinus, 44, 28, 16);
    const plus = this.createActionButton("+", 946, y + 11, onPlus, 44, 28, 16);

    modal.add([box, labelText, valueText, minus, plus]);
  }

  private adjustAdminPayroll(delta: number): void {
    this.adminSettings.payrollPerStaffPerMinute = Phaser.Math.Clamp(
      Math.round(this.adminSettings.payrollPerStaffPerMinute + delta),
      0,
      100,
    );
    this.applyAdminSettingsChange("Payroll updated");
  }

  private adjustAdminIngredientCost(delta: number): void {
    this.adminSettings.ingredientUnitCost = Phaser.Math.Clamp(
      Math.round(this.adminSettings.ingredientUnitCost + delta),
      1,
      250,
    );
    this.applyAdminSettingsChange("Ingredient cost updated");
  }

  private adjustAdminStarterProfit(delta: number): void {
    this.adminSettings.starterRecipeProfit = Phaser.Math.Clamp(
      Math.round(this.adminSettings.starterRecipeProfit + delta),
      0,
      1000,
    );
    this.applyAdminSettingsChange("Starter recipe profit updated");
  }

  private adjustAdminItemCostMultiplier(delta: number): void {
    this.adminSettings.itemCostMultiplier = Phaser.Math.Clamp(
      Math.round((this.adminSettings.itemCostMultiplier + delta) * 10) / 10,
      0.1,
      10,
    );
    this.applyAdminSettingsChange("Item cost multiplier updated");
  }

  private adjustAdminBaseRent(delta: number): void {
    this.adminSettings.baseDailyRent = Phaser.Math.Clamp(
      Math.round(this.adminSettings.baseDailyRent + delta),
      0,
      1000000,
    );
    this.applyAdminSettingsChange("Base rent updated");
  }

  private adjustAdminRentPerExpansion(delta: number): void {
    this.adminSettings.rentPerExpansion = Phaser.Math.Clamp(
      Math.round(this.adminSettings.rentPerExpansion + delta),
      0,
      1000000,
    );
    this.applyAdminSettingsChange("Expansion rent updated");
  }

  private adjustAdminFirstExpansionCost(delta: number): void {
    this.adminSettings.firstExpansionCost = Phaser.Math.Clamp(
      Math.round(this.adminSettings.firstExpansionCost + delta),
      0,
      10000000,
    );
    this.applyAdminSettingsChange("First expansion cost updated");
  }

  private adjustAdminExpansionCostMultiplier(delta: number): void {
    this.adminSettings.expansionCostMultiplier = Phaser.Math.Clamp(
      Math.round((this.adminSettings.expansionCostMultiplier + delta) * 100) / 100,
      1,
      20,
    );
    this.applyAdminSettingsChange("Expansion cost multiplier updated");
  }

  private adjustAdminTrashDropChance(delta: number): void {
    this.adminSettings.trashDropChance = Phaser.Math.Clamp(
      Math.round((this.adminSettings.trashDropChance + delta) * 100) / 100,
      0,
      1,
    );
    this.applyAdminSettingsChange(`Trash drop rate set to ${this.formatTrashDropChance()}`);
  }

  private resetAdminSettings(): void {
    this.adminSettings = {
      payrollPerStaffPerMinute: defaultPayrollPerStaffPerMinute,
      ingredientUnitCost: defaultIngredientUnitCost,
      starterRecipeProfit: defaultStarterRecipeProfit,
      itemCostMultiplier: defaultItemCostMultiplier,
      baseDailyRent: defaultBaseDailyRent,
      rentPerExpansion: defaultRentPerExpansion,
      firstExpansionCost: defaultFirstExpansionCost,
      expansionCostMultiplier: defaultExpansionCostMultiplier,
      trashDropChance: defaultTrashDropChance,
    };
    this.applyAdminSettingsChange("Admin settings reset");
  }

  private applyAdminSettingsChange(message: string): void {
    this.persistImmediately();
    this.refreshCatalogUiIfReady();
    this.expansionOverlayLayer.removeAll(true);
    this.renderExpansionOverlays();
    this.updateStats(message);
    this.openAdminModal();
  }

  private closeAdminModal(): void {
    this.adminModal?.destroy(true);
    this.adminModal = null;
  }

  private saveToSlot(slot: number): void {
    this.currentSaveSlot = slot;
    this.registry.set("currentSaveSlot", slot);
    this.persistImmediately();
    this.closeSaveModal();
    this.updateStats(`Saved game to slot ${slot}`);
  }

  private loadFromSlot(slot: number): void {
    if (!this.saveSystem.load(slot)) {
      this.updateStats(`Slot ${slot} is empty`);
      return;
    }

    this.flushQuietSave();
    this.currentSaveSlot = slot;
    this.registry.set("currentSaveSlot", slot);
    this.pendingQuietSave = false;
    this.quietSaveDueAt = 0;
    this.closeSaveModal();
    this.scene.restart();
  }

  private formatSavedRating(save: SaveGameState): string {
    const history = hydrateRatingHistoryFromSave(save);
    const votes = history.length;
    const average = votes === 0 ? 3 : history.reduce((sum, rating) => sum + rating, 0) / votes;
    return `${average.toFixed(1)}/5 (${votes} recent votes)`;
  }

  private claimStarterGrant(): void {
    const money = this.economy.getMoney();
    if (money >= starterGrantTarget) {
      this.updateStats("Starter Grant is only available below $220");
      return;
    }

    const grant = starterGrantTarget - money;
    this.earnMoney(grant, "grant");
    this.persistQuietly();
    this.updateStats(`Starter Grant added $${grant}`);
  }

  private earnMoney(amount: number, reason: EarnReason = "payment"): void {
    this.economy.earnMoney(amount, reason);
    if (reason === "payment") {
      this.recordRateSample(this.recentRevenue, amount);
    }
  }

  private spendMoney(amount: number, reason: SpendReason = "ingredients"): boolean {
    const spent = this.economy.spendMoney(amount, reason);
    if (spent) {
      this.recordRateSample(this.recentExpenses, amount);
    }
    return spent;
  }

  private forceSpendMoney(amount: number, reason: ForceSpendReason = "rent"): void {
    this.economy.forceSpendMoney(amount, reason);
    this.recordRateSample(this.recentExpenses, amount);
  }

  private rebuildStaffActors(): void {
    this.actors.forEach((actor) => {
      this.stopChefCookingAnimation(actor);
      actor.container.destroy();
    });
    this.actors = [];

    for (let index = 0; index < this.staff.chefs; index += 1) {
      this.addStaffActor("chef", index);
    }

    for (let index = 0; index < this.staff.waiters; index += 1) {
      this.addStaffActor("waiter", index);
    }

    for (let index = 0; index < (this.staff.errandBoys ?? 0); index += 1) {
      this.addStaffActor("errand", index);
    }
  }

  private addStaffActor(role: StaffRole, index: number): void {
    const variant = this.getStaffCharacterVariant(role, index);
    if (role === "chef") {
      const station = this.getChefStationPoint(index);
      const hasStove = index < this.getStoveCount();
      const chef = this.createStaffActor("chef", station.x, station.y, variant);
      chef.bubble.setText(hasStove ? "Ready" : "Need stove");
      this.actors.push(chef);
      return;
    }

    if (role === "waiter") {
      const home = this.getWaiterHomePoint(index);
      this.actors.push(this.createStaffActor("waiter", home.x, home.y, variant));
      return;
    }

    const home = this.getErrandHomePoint(index);
    this.actors.push(this.createStaffActor("errand", home.x, home.y, variant));
  }

  private getStaffCharacterVariant(role: StaffRole, index: number): number {
    const roleOffset: Record<StaffRole, number> = {
      chef: 1,
      waiter: 3,
      errand: 5,
    };
    return (index + roleOffset[role]) % characterVariantCount;
  }

  private getRandomCharacterVariant(): number {
    return Phaser.Math.Between(0, characterVariantCount - 1);
  }

  private restoreStaffActorPositions(save?: SaveGameState | null): void {
    if (!save?.staffActors?.length) {
      return;
    }

    (["chef", "waiter", "errand"] as StaffRole[]).forEach((role) => {
      const actors = this.actors.filter((actor) => actor.role === role);
      const savedActors = save.staffActors?.filter((actor) => actor.role === role) ?? [];
      actors.forEach((actor, index) => {
        const savedActor = savedActors.find((item) => item.index === index);
        if (!savedActor) {
          return;
        }

        const restorePoint = this.getSafeStaffRestorePoint(role, index, new Phaser.Math.Vector2(savedActor.x, savedActor.y));
        actor.container.setPosition(restorePoint.x, restorePoint.y);
        actor.task = "idle";
        actor.busyUntil = this.time.now + 300;
        actor.bubble.setText(role === "chef" && index >= this.getStoveCount() ? "Need stove" : "Ready");
      });
    });
  }

  private getSafeStaffRestorePoint(role: StaffRole, index: number, savedPoint: Phaser.Math.Vector2): Phaser.Math.Vector2 {
    const cell = this.grid.worldToGrid(savedPoint.x, savedPoint.y);
    if (cell && this.isWalkableCell(cell)) {
      return savedPoint;
    }

    if (role === "chef") {
      return this.getChefStationPoint(index);
    }

    const fallback = role === "waiter" ? this.getWaiterHomePoint(index) : this.getErrandHomePoint(index);
    const fallbackCell = this.grid.worldToGrid(fallback.x, fallback.y);
    if (fallbackCell && this.isWalkableCell(fallbackCell)) {
      return fallback;
    }

    const nearest = fallbackCell ? this.findNearestWalkableCell(fallbackCell) : null;
    return nearest ? this.getCellCenter(nearest) : this.getCellCenter({ x: 6, y: 8 });
  }

  private createCharacterSprite(
    role: CharacterVisualRole,
    action: CharacterVisualAction,
    facing: PersonFacing,
    phase: number,
    variant: number,
  ): Phaser.GameObjects.Image | null {
    const visual = getCharacterSpriteFrame(role, action, facing, phase, variant);
    if (!this.hasAtlasFrame(visual.atlas, visual.frame)) {
      return null;
    }

    const sprite = this.add.image(visual.xOffset, visual.yOffset, visual.atlas, visual.frame);
    sprite.setOrigin(visual.origin.x, visual.origin.y);
    sprite.setScale(visual.scale);
    sprite.setData("baseLocalX", visual.xOffset);
    sprite.setData("baseLocalY", visual.yOffset);
    return sprite;
  }

  private updateCharacterSprite(
    body: Phaser.GameObjects.Graphics,
    facing: PersonFacing,
    phase: number,
    seated: boolean,
  ): boolean {
    const sprite = body.getData("sprite") as Phaser.GameObjects.Image | undefined;
    const role = body.getData("characterRole") as CharacterVisualRole | undefined;
    if (!sprite || !role) {
      return false;
    }

    const explicitAction = body.getData("characterAction") as CharacterVisualAction | undefined;
    const action: CharacterVisualAction = seated ? "sit" : explicitAction ?? (phase === 0 ? "idle" : "walk");
    const variant = (body.getData("characterVariant") as number | undefined) ?? 0;
    const visual = getCharacterSpriteFrame(role, action, facing, phase, variant);
    if (!this.hasAtlasFrame(visual.atlas, visual.frame)) {
      return false;
    }

    sprite.setTexture(visual.atlas, visual.frame);
    sprite.setPosition(visual.xOffset, visual.yOffset);
    sprite.setOrigin(visual.origin.x, visual.origin.y);
    sprite.setScale(visual.scale);
    sprite.setData("baseLocalX", visual.xOffset);
    sprite.setData("baseLocalY", visual.yOffset);
    sprite.setVisible(true);
    return true;
  }

  private createStaffActor(role: StaffRole, x: number, y: number, variant: number): Actor {
    const container = this.add.container(x, y);
    const legs = this.add.graphics();
    const body = this.add.graphics();
    const colors: PersonColors = {
      skin: 0xffd2aa,
      shirt: role === "chef" ? 0xfaf5e8 : role === "waiter" ? 0x456b82 : 0x7b8b45,
      pants: role === "chef" ? 0x59656b : role === "waiter" ? 0x263f52 : 0x5d5132,
      hair: role === "chef" ? 0xffffff : 0x4b2d22,
      apron: role === "chef",
      tie: role === "waiter",
    };
    body.setData("baseLocalX", 0);
    body.setData("baseLocalY", 0);
    legs.setData("baseLocalX", 0);
    legs.setData("baseLocalY", 0);
    body.setData("colors", colors);
    body.setData("characterRole", role);
    body.setData("characterVariant", variant);
    legs.setData("pantsColor", colors.pants);
    const sprite = this.createCharacterSprite(role, "idle", "down", 0, variant);
    if (sprite) {
      body.setData("sprite", sprite);
      body.setVisible(false);
      legs.setVisible(false);
    }
    this.drawPersonPose(body, legs, "down", 0, false);
    const bubble = this.createStatusBubble(0, statusBubbleLocalY, role === "chef" ? "Ready" : "Ready");
    container.add(sprite ? [legs, body, sprite, bubble] : [legs, body, bubble]);
    this.actorLayer.add(container);

    return {
      id: Phaser.Math.RND.uuid(),
      role,
      task: "idle",
      container,
      body,
      legs,
      sprite: sprite ?? undefined,
      bubble,
      busyUntil: 0,
    };
  }

  private createStatusBubble(x: number, y: number, initialText = ""): Phaser.GameObjects.Text {
    const bubble = this.add
      .text(x, y, "", this.actorBubbleStyle())
      .setOrigin(0.5)
      .setScale(1, 1 / restaurantCameraYScale)
      .setRotation(-this.getRestaurantViewRotationRadians())
      .setVisible(false);
    bubble.setData("baseLocalX", x);
    bubble.setData("baseLocalY", y);
    const originalSetText = bubble.setText.bind(bubble);
    const showForMs = statusBubbleVisibleMs;

    bubble.setText = ((value: string | string[]) => {
      const text = Array.isArray(value) ? value.join("\n") : value;
      const iconText = this.getStatusBubbleIcon(text);
      bubble.setData("rawText", text);
      originalSetText(iconText);
      const existingTimer = bubble.getData("hideTimer") as Phaser.Time.TimerEvent | undefined;
      existingTimer?.remove(false);

      if (text.trim().length === 0) {
        bubble.setVisible(false);
        return bubble;
      }

      bubble.setVisible(true).setAlpha(1);
      const timer = this.time.delayedCall(showForMs, () => {
        if (bubble.active && bubble.getData("rawText") === text) {
          this.tweens.add({
            targets: bubble,
            alpha: 0,
            duration: statusBubbleFadeMs,
            onComplete: () => {
              if (bubble.active && bubble.getData("rawText") === text) {
                bubble.setVisible(false).setAlpha(1);
              }
            },
          });
        }
      });
      bubble.setData("hideTimer", timer);
      return bubble;
    }) as typeof bubble.setText;

    if (initialText) {
      bubble.setText(initialText);
    }

    return bubble;
  }

  private getStatusBubbleIcon(text: string): string {
    const status = text.trim();
    const lower = status.toLowerCase();
    const itemCount = this.getStatusItemCount(status);

    if (status.length === 0) {
      return "";
    }

    if (lower.startsWith("wants") || lower.startsWith("ordered")) {
      return this.withBubbleCount("ORD", itemCount);
    }

    if (lower.startsWith("got ") || lower === "eating") {
      return "EAT";
    }

    if (lower.includes("/5")) {
      return this.getRatingBubbleIcon(status);
    }

    if (lower.startsWith("no ")) {
      return "NO";
    }

    if (lower.startsWith("cooking")) {
      return "HOT";
    }

    if (lower.includes("stove")) {
      return lower.startsWith("need") ? "! HOT" : "HOT+";
    }

    if (lower.includes("chef busy")) {
      return "WAIT";
    }

    if (lower.includes("receiving order") || lower.includes("give order") || lower.includes("order in") || lower.includes("to chef")) {
      return "TKT>";
    }

    if (lower.includes("taking order") || lower.includes("ready to order")) {
      return "TKT";
    }

    if (lower.includes("pickup") || lower.includes("ready plate") || lower.includes("partial ready")) {
      return "PICK";
    }

    if (lower.includes("serving")) {
      return "SERV";
    }

    if (lower.includes("payment") || lower.includes("paying") || lower.includes("pay") || lower.includes("cashier")) {
      return "$";
    }

    if (lower.includes("cleaning")) {
      return "CLR";
    }

    if (lower.includes("taking dishes")) {
      return "DISH";
    }

    if (lower.includes("washing")) {
      return "WASH";
    }

    if (lower.includes("shopping")) {
      return this.withBubbleCount("SHOP", itemCount);
    }

    if (lower.includes("delivered")) {
      return "BOX";
    }

    if (lower.includes("stored")) {
      return "HOLD";
    }

    if (lower.includes("waiting for food")) {
      return "WAIT";
    }

    if (lower === "ready") {
      return "OK";
    }

    return ".";
  }

  private getStatusItemCount(text: string): number | null {
    const explicitCount = text.match(/x\s*(\d+)/i);
    if (explicitCount) {
      return Number(explicitCount[1]);
    }

    const itemCount = text.match(/(\d+)\s+items?/i);
    if (itemCount) {
      return Number(itemCount[1]);
    }

    return null;
  }

  private withBubbleCount(icon: string, count: number | null): string {
    return count && count > 1 ? `${icon} x${count}` : icon;
  }

  private getRatingBubbleIcon(text: string): string {
    const ratingMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
    const rating = ratingMatch ? Math.round(Number(ratingMatch[1])) : 0;
    if (rating <= 1) {
      return "*1";
    }
    if (rating === 2) {
      return "*2";
    }
    if (rating === 3) {
      return "*3";
    }
    if (rating === 4) {
      return "*4";
    }
    return "*5";
  }

  private createGuest(
    x: number,
    y: number,
    diningSeat: DiningSeat,
    orderItems: RecipeDefinition[],
    visual?: { colors: PersonColors; variant: number },
  ): Guest {
    const primaryOrder = orderItems[0];
    const container = this.add.container(x, y);
    const legs = this.add.graphics();
    const body = this.add.graphics();
    const colors = visual?.colors ?? this.getRandomGuestColors();
    body.setData("baseLocalX", 0);
    body.setData("baseLocalY", 0);
    legs.setData("baseLocalX", 0);
    legs.setData("baseLocalY", 0);
    body.setData("colors", colors);
    body.setData("characterRole", "guest");
    const variant = visual?.variant ?? this.getRandomCharacterVariant();
    body.setData("characterVariant", variant);
    legs.setData("pantsColor", colors.pants);
    const sprite = this.createCharacterSprite("guest", "idle", "down", 0, variant);
    if (sprite) {
      body.setData("sprite", sprite);
      body.setVisible(false);
      legs.setVisible(false);
    }
    this.drawPersonPose(body, legs, "down", 0, false);
    const bubble = this.createStatusBubble(0, statusBubbleLocalY, `Wants ${this.getOrderSummary(orderItems)}`);
    container.add(sprite ? [legs, body, sprite, bubble] : [legs, body, bubble]);
    this.actorLayer.add(container);

    return {
      id: Phaser.Math.RND.uuid(),
      container,
      body,
      legs,
      sprite: sprite ?? undefined,
      bubble,
      state: "entering",
      order: primaryOrder,
      orderItems,
      seatUid: diningSeat.seatUid,
      chairUid: diningSeat.chairUid,
      tableUid: diningSeat.tableUid,
      seat: diningSeat.seat,
      serviceSpot: diningSeat.serviceSpot,
      cleanupSpot: diningSeat.cleanupSpot,
      seatedFacing: diningSeat.seatedFacing,
      patience: 60,
      seatedAt: this.time.now,
      orderedAt: 0,
      paidAt: 0,
      idealExperienceSeconds: this.getIdealExperienceSeconds(diningSeat, orderItems),
    };
  }

  private getRandomGuestColors(): PersonColors {
    return {
      skin: 0xffd0a6,
      shirt: Phaser.Display.Color.GetColor(
        Phaser.Math.Between(125, 230),
        Phaser.Math.Between(95, 180),
        Phaser.Math.Between(95, 170),
      ),
      pants: 0x4f5d6b,
      hair: Phaser.Display.Color.GetColor(70, Phaser.Math.Between(38, 62), Phaser.Math.Between(24, 45)),
      apron: false,
      tie: false,
    };
  }

  private updatePedestrians(time: number): void {
    this.pedestrians = this.pedestrians.filter((pedestrian) => pedestrian.container.active);
    if (this.mapViewMode !== "inside") {
      return;
    }

    if (this.pedestrians.length >= maxPedestrians || time < this.nextPedestrianAt) {
      return;
    }

    this.spawnPedestrian(false);
    this.nextPedestrianAt = time + Phaser.Math.Between(pedestrianSpawnMinMs, pedestrianSpawnMaxMs);
  }

  private spawnPedestrian(nearEntrance: boolean): Pedestrian | null {
    const direction = Phaser.Math.Between(0, 1) === 0 ? 1 : -1;
    const laneOffset = Phaser.Math.Between(-14, 14);
    const route = this.getPedestrianRoute(direction, laneOffset);
    if (!route) {
      return null;
    }

    let start = route.start.clone();
    if (nearEntrance) {
      const along = route.end.clone().subtract(route.start);
      if (along.lengthSq() > 0) {
        along.normalize();
        start = route.door.clone().subtract(along.scale(Phaser.Math.Between(90, 150)));
      }
    }

    const pedestrian = this.createPedestrian(start.x, start.y, route.end);
    this.pedestrians.push(pedestrian);
    this.movePersonDirect(
      pedestrian.container,
      pedestrian.body,
      pedestrian.legs,
      route.end,
      pedestrianWalkPixelsPerSecond,
      () => this.destroyPedestrian(pedestrian),
    );
    return pedestrian;
  }

  private createPedestrian(x: number, y: number, routeEnd: Phaser.Math.Vector2): Pedestrian {
    const container = this.add.container(x, y);
    const legs = this.add.graphics();
    const body = this.add.graphics();
    const colors = this.getRandomGuestColors();
    const variant = this.getRandomCharacterVariant();
    const facing = this.getFacingForVector(routeEnd.x - x, routeEnd.y - y);
    body.setData("baseLocalX", 0);
    body.setData("baseLocalY", 0);
    legs.setData("baseLocalX", 0);
    legs.setData("baseLocalY", 0);
    body.setData("colors", colors);
    body.setData("characterRole", "guest");
    body.setData("characterVariant", variant);
    legs.setData("pantsColor", colors.pants);
    const sprite = this.createCharacterSprite("guest", "walk", facing, 0, variant);
    if (sprite) {
      body.setData("sprite", sprite);
      body.setVisible(false);
      legs.setVisible(false);
    }
    this.drawPersonPose(body, legs, facing, 0, false);
    const bubble = this.createStatusBubble(0, statusBubbleLocalY, "");
    const snackKind = Math.random() < this.getTrashDropChance() ? this.getRandomPavementSnackKind() : undefined;
    const snackGraphic = snackKind ? this.createPedestrianSnackGraphic(snackKind, facing) : undefined;
    if (snackGraphic) {
      snackGraphic.setData("baseLocalX", snackGraphic.x);
      snackGraphic.setData("baseLocalY", snackGraphic.y);
    }
    container.add(sprite ? [legs, body, sprite, ...(snackGraphic ? [snackGraphic] : []), bubble] : [legs, body, ...(snackGraphic ? [snackGraphic] : []), bubble]);
    this.exteriorForegroundLayer.add(container);
    const pedestrian: Pedestrian = {
      id: Phaser.Math.RND.uuid(),
      container,
      body,
      legs,
      sprite: sprite ?? undefined,
      bubble,
      routeEnd,
      entering: false,
      snackKind,
      snackGraphic,
    };
    if (snackKind) {
      const delay = Phaser.Math.Between(1300, 4800);
      pedestrian.trashDropTimer = this.time.delayedCall(delay, () => this.finishPedestrianSnack(pedestrian));
    }
    return pedestrian;
  }

  private getPedestrianRoute(
    direction: 1 | -1,
    laneOffset = 0,
  ): { start: Phaser.Math.Vector2; end: Phaser.Math.Vector2; door: Phaser.Math.Vector2 } | null {
    const bounds = this.getUnlockedExpansionBounds();
    const frontRun: BoundaryRun = {
      side: "south",
      fixed: bounds.maxY,
      start: bounds.minX - 3,
      end: bounds.maxX + 2,
    };
    const { a, b } = this.getVisualBoundaryRunEndpoints(frontRun, roomShellOutsetPixels + 8);
    const outward = this.getBoundaryOutwardOffset(frontRun, 1);
    const along = b.clone().subtract(a);
    if (outward.lengthSq() === 0 || along.lengthSq() === 0) {
      return null;
    }

    along.normalize();
    const sidewalkLane = 54 + laneOffset;
    const routeA = a.clone().add(outward.clone().scale(sidewalkLane)).subtract(along.clone().scale(120));
    const routeB = b.clone().add(outward.clone().scale(sidewalkLane)).add(along.clone().scale(120));
    const door = this.getRestaurantExitPoint().add(outward.clone().scale(56 + laneOffset * 0.2));
    return direction === 1
      ? { start: routeA, end: routeB, door }
      : { start: routeB, end: routeA, door };
  }

  private getPedestrianForEntrance(): { point: Phaser.Math.Vector2; visual?: { colors: PersonColors; variant: number } } {
    const pedestrian = this.findPedestrianNearEntrance() ?? this.spawnPedestrian(true);
    if (!pedestrian) {
      return { point: this.getRestaurantExitPoint() };
    }

    pedestrian.entering = true;
    const point = new Phaser.Math.Vector2(pedestrian.container.x, pedestrian.container.y);
    const colors = pedestrian.body.getData("colors") as PersonColors | undefined;
    const variant = pedestrian.body.getData("characterVariant") as number | undefined;
    const visual = colors ? { colors, variant: variant ?? 0 } : undefined;
    this.destroyPedestrian(pedestrian);
    return { point, visual };
  }

  private findPedestrianNearEntrance(): Pedestrian | null {
    const door = this.getRestaurantExitPoint();
    const candidates = this.pedestrians
      .filter((pedestrian) => pedestrian.container.active && !pedestrian.entering)
      .map((pedestrian) => ({
        pedestrian,
        distance: Phaser.Math.Distance.Between(pedestrian.container.x, pedestrian.container.y, door.x, door.y),
      }))
      .filter((candidate) => candidate.distance <= this.grid.tileSize * 5)
      .sort((a, b) => a.distance - b.distance);
    return candidates[0]?.pedestrian ?? null;
  }

  private markPasserbyTurnaway(expectation: CustomerExpectation): boolean {
    const pedestrian = this.findPedestrianNearEntrance() ?? this.spawnPedestrian(true);
    if (!pedestrian) {
      return false;
    }

    pedestrian.bubble.setText(`No ${this.formatRecipeCategory(expectation.category).toLowerCase()}`);
    return true;
  }

  private destroyPedestrian(pedestrian: Pedestrian): void {
    pedestrian.trashDropTimer?.remove(false);
    this.stopPersonMotion(pedestrian.container, pedestrian.body);
    pedestrian.container.destroy();
    this.pedestrians = this.pedestrians.filter((item) => item !== pedestrian);
  }

  private clearPedestrians(): void {
    [...this.pedestrians].forEach((pedestrian) => this.destroyPedestrian(pedestrian));
    this.pedestrians = [];
    this.nextPedestrianAt = this.time.now + 600;
  }

  private getRandomPavementSnackKind(): PavementSnackKind {
    return Phaser.Math.RND.pick(["cup", "wrapper", "bottle", "carton"] as PavementSnackKind[]);
  }

  private createPedestrianSnackGraphic(kind: PavementSnackKind, facing: PersonFacing): Phaser.GameObjects.Graphics {
    const graphic = this.add.graphics();
    const sideOffset = facing === "left" ? -16 : facing === "right" ? 16 : 12;
    graphic.setPosition(sideOffset, -30);
    this.drawSnackItem(graphic, kind, 0, 0, 1);
    return graphic;
  }

  private finishPedestrianSnack(pedestrian: Pedestrian): void {
    if (!pedestrian.container.active || pedestrian.entering || !pedestrian.snackKind) {
      return;
    }

    const snackKind = pedestrian.snackKind;
    pedestrian.snackKind = undefined;
    pedestrian.snackGraphic?.destroy();
    pedestrian.snackGraphic = undefined;
    this.createPavementTrashFromWorldPoint(new Phaser.Math.Vector2(pedestrian.container.x, pedestrian.container.y), snackKind);
    pedestrian.bubble.setText("Trash");
  }

  private createPavementTrashFromWorldPoint(point: Phaser.Math.Vector2, kind: PavementSnackKind): void {
    if (this.pavementTrash.length >= maxPavementTrash) {
      return;
    }

    const descriptor = this.getPavementTrashDescriptor(point);
    this.createPavementTrash({
      id: Phaser.Math.RND.uuid(),
      kind,
      t: descriptor.t,
      lane: descriptor.lane,
      droppedAt: Date.now(),
    });
    this.persistQuietly();
  }

  private hydratePavementTrash(save?: SaveGameState | null): void {
    this.clearPavementTrash();
    const savedTrash = (save?.pavementTrash ?? [])
      .slice(0, maxPavementTrash)
      .map((item) => this.normalizeSavedPavementTrash(item))
      .filter((item): item is SavedPavementTrashState => Boolean(item));

    const generatedTrash = this.generateOfflinePavementTrash(save?.lastSavedAt ?? 0, savedTrash.length);
    [...savedTrash, ...generatedTrash].slice(0, maxPavementTrash).forEach((item) => this.createPavementTrash(item, false));
    if (generatedTrash.length > 0) {
      this.persistQuietly();
    }
  }

  private clearPavementTrash(): void {
    this.pavementTrash.forEach((trash) => trash.container.destroy());
    this.pavementTrash = [];
  }

  private normalizeSavedPavementTrash(item: SavedPavementTrashState): SavedPavementTrashState | null {
    const kind = this.toPavementSnackKind(item.kind);
    if (!kind) {
      return null;
    }

    return {
      id: item.id || Phaser.Math.RND.uuid(),
      kind,
      t: Phaser.Math.Clamp(Number(item.t) || 0.5, -0.15, 1.15),
      lane: Phaser.Math.Clamp(Number(item.lane) || 60, 18, 108),
      droppedAt: Number(item.droppedAt) || Date.now(),
    };
  }

  private toPavementSnackKind(kind: string): PavementSnackKind | null {
    return kind === "cup" || kind === "wrapper" || kind === "bottle" || kind === "carton" ? kind : null;
  }

  private generateOfflinePavementTrash(lastSavedAt: number, existingCount: number): SavedPavementTrashState[] {
    if (!lastSavedAt || existingCount >= maxPavementTrash) {
      return [];
    }

    const elapsed = Date.now() - lastSavedAt;
    if (elapsed < offlineTrashDropMs) {
      return [];
    }

    const dropChance = this.getTrashDropChance();
    if (dropChance <= 0) {
      return [];
    }

    const capacity = maxPavementTrash - existingCount;
    const count = Math.min(capacity, Math.floor((elapsed / offlineTrashDropMs) * dropChance));
    return Array.from({ length: count }, (_unused, index) => ({
      id: Phaser.Math.RND.uuid(),
      kind: this.getRandomPavementSnackKind(),
      t: Phaser.Math.FloatBetween(0.06, 0.94),
      lane: Phaser.Math.Between(34, 88),
      droppedAt: Date.now() - (count - index) * offlineTrashDropMs,
    }));
  }

  private createPavementTrash(saved: SavedPavementTrashState, persist = true): void {
    if (this.pavementTrash.length >= maxPavementTrash) {
      return;
    }

    const kind = this.toPavementSnackKind(saved.kind) ?? "cup";
    const point = this.getPavementTrashWorldPoint(saved.t, saved.lane);
    const container = this.add.container(point.x, point.y);
    container.setSize(34, 30);
    container.setData("sortY", point.y + 8);
    container.setData("worldSortKind", 1);
    container.setData("pavementTrash", true);
    const graphic = this.add.graphics();
    this.drawDroppedTrash(graphic, kind);
    const icon = this.add.text(0, -30, "♻", {
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "24px",
      color: "#247a45",
      stroke: "#fff7dc",
      strokeThickness: 4,
    }).setOrigin(0.5).setVisible(false);
    container.add([graphic, icon]);
    container.setInteractive(new Phaser.Geom.Rectangle(-18, -18, 36, 36), Phaser.Geom.Rectangle.Contains);
    if (container.input) {
      container.input.cursor = "pointer";
    }
    container.on("pointerover", () => icon.setVisible(true));
    container.on("pointerout", () => icon.setVisible(false));
    container.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.recyclePavementTrash(saved.id);
    });
    this.exteriorForegroundLayer.add(container);
    this.pavementTrash.push({
      id: saved.id,
      kind,
      t: saved.t,
      lane: saved.lane,
      droppedAt: saved.droppedAt,
      container,
      icon,
    });
    this.sortExteriorForegroundDepths();
    if (persist) {
      this.persistQuietly();
    }
  }

  private recyclePavementTrash(id: string): void {
    const trash = this.pavementTrash.find((item) => item.id === id);
    if (!trash) {
      return;
    }

    trash.container.destroy();
    this.pavementTrash = this.pavementTrash.filter((item) => item.id !== id);
    this.earnMoney(trashRecycleReward, "grant");
    this.updateStats(`Recycled litter +$${trashRecycleReward}`);
    this.persistQuietly();
  }

  private repositionPavementTrash(): void {
    if (!this.pavementTrash.length) {
      return;
    }

    this.pavementTrash.forEach((trash) => {
      const point = this.getPavementTrashWorldPoint(trash.t, trash.lane);
      trash.container.setPosition(point.x, point.y);
      trash.container.setData("sortY", point.y + 8);
    });
    this.sortExteriorForegroundDepths();
  }

  private getPavementTrashDescriptor(point: Phaser.Math.Vector2): { t: number; lane: number } {
    const route = this.getPavementBasis();
    if (!route) {
      return { t: Phaser.Math.FloatBetween(0.12, 0.88), lane: Phaser.Math.Between(44, 86) };
    }

    const relative = point.clone().subtract(route.a);
    const t = Phaser.Math.Clamp(relative.dot(route.along) / route.length, -0.12, 1.12);
    const lane = Phaser.Math.Clamp(relative.dot(route.outward), 24, 104);
    return { t, lane };
  }

  private getPavementTrashWorldPoint(t: number, lane: number): Phaser.Math.Vector2 {
    const route = this.getPavementBasis();
    if (!route) {
      return this.getRestaurantExitPoint();
    }

    return route.a.clone().add(route.along.clone().scale(route.length * t)).add(route.outward.clone().scale(lane));
  }

  private getPavementBasis(): { a: Phaser.Math.Vector2; along: Phaser.Math.Vector2; outward: Phaser.Math.Vector2; length: number } | null {
    const bounds = this.getUnlockedExpansionBounds();
    const frontRun: BoundaryRun = {
      side: "south",
      fixed: bounds.maxY,
      start: bounds.minX - 3,
      end: bounds.maxX + 2,
    };
    const { a, b } = this.getVisualBoundaryRunEndpoints(frontRun, roomShellOutsetPixels + 8);
    const outward = this.getBoundaryOutwardOffset(frontRun, 1);
    const along = b.clone().subtract(a);
    const length = along.length();
    if (length <= 0 || outward.lengthSq() === 0) {
      return null;
    }

    along.normalize();
    outward.normalize();
    return { a, along, outward, length };
  }

  private drawSnackItem(
    graphic: Phaser.GameObjects.Graphics,
    kind: PavementSnackKind,
    x: number,
    y: number,
    scale = 1,
    clearBeforeDraw = true,
  ): void {
    if (clearBeforeDraw) {
      graphic.clear();
    }
    if (kind === "cup") {
      graphic.fillStyle(0xffffff, 1);
      graphic.fillRoundedRect(x - 5 * scale, y - 8 * scale, 10 * scale, 15 * scale, 3 * scale);
      graphic.lineStyle(2 * scale, 0x7dc8d8, 1);
      graphic.lineBetween(x - 3 * scale, y - 5 * scale, x + 5 * scale, y - 10 * scale);
      graphic.strokeRoundedRect(x - 5 * scale, y - 8 * scale, 10 * scale, 15 * scale, 3 * scale);
      return;
    }

    if (kind === "wrapper") {
      graphic.fillStyle(0xd6a34d, 1);
      graphic.fillTriangle(x - 9 * scale, y - 4 * scale, x + 8 * scale, y - 8 * scale, x + 5 * scale, y + 7 * scale);
      graphic.lineStyle(1 * scale, 0x7d5134, 1);
      graphic.strokeTriangle(x - 9 * scale, y - 4 * scale, x + 8 * scale, y - 8 * scale, x + 5 * scale, y + 7 * scale);
      return;
    }

    if (kind === "bottle") {
      graphic.fillStyle(0x7cc6b6, 1);
      graphic.fillRoundedRect(x - 4 * scale, y - 11 * scale, 8 * scale, 20 * scale, 4 * scale);
      graphic.fillStyle(0xe7fbff, 0.9);
      graphic.fillRoundedRect(x - 3 * scale, y - 3 * scale, 6 * scale, 5 * scale, 2 * scale);
      graphic.fillStyle(0x4e8c83, 1);
      graphic.fillRect(x - 3 * scale, y - 14 * scale, 6 * scale, 4 * scale);
      return;
    }

    graphic.fillStyle(0xf0d66e, 1);
    graphic.fillRoundedRect(x - 8 * scale, y - 8 * scale, 16 * scale, 15 * scale, 2 * scale);
    graphic.lineStyle(2 * scale, 0xa76f42, 1);
    graphic.lineBetween(x - 6 * scale, y - 3 * scale, x + 6 * scale, y - 6 * scale);
    graphic.strokeRoundedRect(x - 8 * scale, y - 8 * scale, 16 * scale, 15 * scale, 2 * scale);
  }

  private drawDroppedTrash(graphic: Phaser.GameObjects.Graphics, kind: PavementSnackKind): void {
    graphic.clear();
    graphic.fillStyle(0x392d25, 0.13);
    graphic.fillEllipse(1, 7, 25, 9);
    graphic.save();
    graphic.translateCanvas(0, 1);
    graphic.rotateCanvas(Phaser.Math.DegToRad(kind === "bottle" ? -24 : kind === "wrapper" ? 14 : -12));
    this.drawSnackItem(graphic, kind, 0, 0, 1, false);
    graphic.restore();
  }

  private restoreActiveGuests(save?: SaveGameState | null): void {
    if (this.skipSavedGuestsRestore) {
      return;
    }

    if (!save?.guests?.length) {
      return;
    }

    const diningSeats = this.getDiningSeats();
    const restoredGuestIds = new Set<string>();
    const restoredSeatUids = new Set<string>();
    save.guests.forEach((savedGuest) => {
      const diningSeat = diningSeats.find(
        (seat) =>
          !restoredSeatUids.has(seat.seatUid) &&
          (savedGuest.seatUid ? seat.seatUid === savedGuest.seatUid : seat.chairUid === savedGuest.chairUid),
      );
      const orderItems = savedGuest.orderRecipeIds
        .map((recipeId) => recipes.find((recipe) => recipe.id === recipeId))
        .filter((recipe): recipe is RecipeDefinition => Boolean(recipe));
      if (!diningSeat || orderItems.length === 0 || restoredGuestIds.has(savedGuest.id)) {
        return;
      }

      const guest = this.createGuest(diningSeat.seat.x, diningSeat.seat.y, diningSeat, orderItems);
      guest.id = savedGuest.id;
      guest.state = savedGuest.state;
      guest.patience = Math.max(8, savedGuest.patience);
      guest.seatedAt = this.time.now;
      guest.orderedAt = savedGuest.state === "waitingForFood" ? this.time.now : 0;
      guest.bubble.setText(savedGuest.state === "waitingToOrder" ? "Ready to order" : "Waiting for food");
      this.drawPersonPose(guest.body, guest.legs, guest.seatedFacing, 0, true);
      this.guests.push(guest);
      restoredGuestIds.add(savedGuest.id);
      restoredSeatUids.add(diningSeat.seatUid);
    });

    this.tickets = [];
    (save.tickets ?? [])
      .filter((ticket) => restoredGuestIds.has(ticket.guestId))
      .forEach((ticket) => {
        const recipe = recipes.find((item) => item.id === ticket.recipeId);
        if (!recipe) {
          return;
        }

        this.tickets.push({
          id: ticket.id,
          guestId: ticket.guestId,
          recipe,
          state: ticket.state,
          readyAt: ticket.state === "ready" ? this.time.now : 0,
          preferredWaiterId: ticket.preferredWaiterId,
        });
      });

    this.guests.forEach((guest) => {
      const guestTickets = this.tickets.filter((ticket) => ticket.guestId === guest.id);
      if (guestTickets.length === 0) {
        this.tickets.push(
          ...guest.orderItems.map((recipe) => ({
            id: Phaser.Math.RND.uuid(),
            guestId: guest.id,
            recipe,
            state: guest.state === "waitingToOrder" ? ("ordering" as const) : ("queued" as const),
            readyAt: 0,
          })),
        );
        return;
      }

      guestTickets.forEach((ticket) => {
        if (guest.state === "waitingToOrder" && ticket.state !== "delivered") {
          ticket.state = "ordering";
          ticket.readyAt = 0;
          return;
        }

        if (guest.state === "waitingForFood" && (ticket.state === "ordering" || ticket.state === "serving")) {
          ticket.state = "queued";
          ticket.readyAt = 0;
        }
      });
    });

    this.renderFurniture();
  }

  private applyOfflineProgress(save?: SaveGameState | null): void {
    if (!save?.lastSavedAt) {
      return;
    }

    const elapsedSeconds = Math.floor((Date.now() - save.lastSavedAt) / 1000);
    if (elapsedSeconds < 60) {
      return;
    }

    const cappedSeconds = Math.min(elapsedSeconds, 6 * 60 * 60);
    const offlineMinutes = cappedSeconds / 60;
    if (!this.restaurantOpen) {
      if (this.autoShopEnabled && (this.staff.errandBoys ?? 0) > 0) {
        this.applyOfflineShopping(Math.floor(this.getShoppingIngredientsPerMinute() * offlineMinutes));
      }
      this.offlineSummaryMessage = `Away for ${this.formatOfflineDuration(cappedSeconds)}. Restaurant was closed, so no new guests entered.`;
      return;
    }
    const activeRecipes = this.getActiveMenuRecipes();
    const diningSeats = this.getDiningSeats().filter((seat) => !seat.disabled).length;
    const stoves = this.getStoveCount();
    const activeChefs = Math.min(this.staff.chefs, stoves);
    const chefOutput = this.getChefOutputPerMinute(activeChefs);
    const expectedDishesPerCustomer = this.getExpectedDishesPerCustomer();
    const averageServiceSeconds = this.getAverageWaiterServiceSeconds(expectedDishesPerCustomer);
    const waiterOutput = averageServiceSeconds > 0 ? Math.floor((this.staff.waiters * 60 * expectedDishesPerCustomer) / averageServiceSeconds) : 0;
    const attractiveness = this.reputation.getAttractiveness(this.placement.getFurniture());
    const spawnRate = this.customers.estimateSpawnRate(attractiveness, diningSeats, this.cooking.getUnlockedRecipeIds().length, this.getAverageRating());
    const demand = Math.round(this.getCurrentCustomerDemandPerMinute(diningSeats, 0, spawnRate) * expectedDishesPerCustomer);
    const capacityPerMinute = Math.max(0, Math.min(demand, chefOutput, waiterOutput));
    if (activeRecipes.length === 0 || capacityPerMinute <= 0) {
      this.offlineSummaryMessage = `Away for ${this.formatOfflineDuration(cappedSeconds)}. No service progress: add seats, chefs/stoves, waiters, or menu recipes.`;
      return;
    }

    if (this.autoShopEnabled && (this.staff.errandBoys ?? 0) > 0) {
      this.applyOfflineShopping(Math.floor(this.getShoppingIngredientsPerMinute() * offlineMinutes));
    }

    const maxServed = Math.min(500, Math.floor(capacityPerMinute * offlineMinutes));
    let served = 0;
    let revenue = 0;
    for (let index = 0; index < maxServed; index += 1) {
      const recipe = activeRecipes[index % activeRecipes.length];
      if (!this.hasIngredients(recipe)) {
        break;
      }

      this.consumeIngredients(recipe, false);
      const payment = this.getRecipeSellPrice(recipe);
      this.earnMoney(payment, "offline");
      revenue += payment;
      served += 1;
      this.recordGuestRating(this.getOfflineRating(capacityPerMinute, demand, chefOutput, waiterOutput));
    }

    this.customers.recordServed(served);
    this.guests.forEach((guest) => guest.container.destroy());
    this.guests = [];
    this.tickets = [];
    this.skipSavedGuestsRestore = served > 0 || maxServed > 0;
    this.offlineSummaryMessage =
      served > 0
        ? `Away for ${this.formatOfflineDuration(cappedSeconds)}. Staff served ${served} guests and earned $${revenue}.`
        : `Away for ${this.formatOfflineDuration(cappedSeconds)}. No guests were served because ingredients ran out.`;
  }

  private applyOfflineShopping(maxItems: number): void {
    const autoShopIngredients = this.getAutoShopIngredientIds();
    if (autoShopIngredients.size === 0) {
      return;
    }

    for (let index = 0; index < maxItems; index += 1) {
      const ingredient = [...this.cooking.getPantry()]
        .filter((item) => autoShopIngredients.has(item.id))
        .filter((item) => item.quantity < this.stockTarget)
        .sort((a, b) => a.quantity - b.quantity)[0];
      if (!ingredient || !this.spendMoney(this.getIngredientUnitCost(), "ingredients")) {
        return;
      }

      ingredient.quantity += 1;
    }
  }

  private getOfflineRating(capacity: number, demand: number, chefOutput: number, waiterOutput: number): number {
    if (capacity >= demand) {
      return 5;
    }

    if (chefOutput < demand || waiterOutput < demand) {
      return capacity >= demand * 0.75 ? 4 : capacity >= demand * 0.5 ? 3 : 2;
    }

    return 4;
  }

  private formatOfflineDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
  }

  private drawPersonPose(
    body: Phaser.GameObjects.Graphics,
    legs: Phaser.GameObjects.Graphics,
    facing: PersonFacing,
    phase: number,
    seated: boolean,
    colorsOverride?: PersonColors,
  ): void {
    const colors = colorsOverride ?? body.getData("colors") as PersonColors;
    body.setData("colors", colors);
    body.setData("facing", facing);
    body.setData("seated", seated);
    // Depth fix for seated guests: chair sprite extends into the floor-diamond
    // bottom vertex so its sort-Y ends up ~10px past the chair's anchor.
    // Default character sort-Y is container.y + 17 which lands BEHIND the
    // chair, so the chair renders on top of the seated character. Add a
    // sortYOffset to seated containers so they always sort after their chair.
    const container = body.parentContainer;
    if (container) {
      container.setData("sortYOffset", seated ? 32 : 0);
    }
    if (this.updateCharacterSprite(body, facing, phase, seated)) {
      body.clear().setVisible(false);
      legs.clear().setVisible(false);
      return;
    }

    body.setVisible(true);
    legs.setVisible(true);
    this.drawHuman(body, colors, facing, seated);
    this.drawLegs(legs, colors.pants, phase, facing, seated);
  }

  private sortActorDepths(): void {
    this.sortWorldContainerByDepth(this.actorLayer);
    this.sortExteriorForegroundDepths();
  }

  private sortExteriorForegroundDepths(): void {
    if (!this.exteriorForegroundLayer) {
      return;
    }

    this.sortWorldContainerByDepth(this.exteriorForegroundLayer);
  }

  private sortWorldContainerByDepth(container: Phaser.GameObjects.Container): void {
    container.list.sort((a, b) => {
      const yDelta = this.getActorLayerBaseY(a) - this.getActorLayerBaseY(b);
      if (Math.abs(yDelta) > 0.001) {
        return yDelta;
      }

      return this.getWorldSortKind(a) - this.getWorldSortKind(b);
    });
  }

  private updatePersonalSpace(deltaSeconds: number): void {
    const people = this.getPersonVisualTargets();
    const offsets = new Map(people.map((person) => [person.id, new Phaser.Math.Vector2(0, 0)]));
    const bucketSize = standingPersonalSpaceRadius * 2.2;
    const buckets = new Map<string, number[]>();
    people.forEach((person, index) => {
      const bucketX = Math.floor(person.container.x / bucketSize);
      const bucketY = Math.floor(person.container.y / bucketSize);
      const key = `${bucketX},${bucketY}`;
      buckets.set(key, [...(buckets.get(key) ?? []), index]);
    });

    for (let i = 0; i < people.length; i += 1) {
      const person = people[i];
      const bucketX = Math.floor(person.container.x / bucketSize);
      const bucketY = Math.floor(person.container.y / bucketSize);
      const nearbyIndexes = new Set<number>();
      for (let y = bucketY - 1; y <= bucketY + 1; y += 1) {
        for (let x = bucketX - 1; x <= bucketX + 1; x += 1) {
          (buckets.get(`${x},${y}`) ?? []).forEach((index) => nearbyIndexes.add(index));
        }
      }

      nearbyIndexes.forEach((j) => {
        if (j <= i) {
          return;
        }
        const a = people[i];
        const b = people[j];
        // Seated guests are pinned to their chair seat by design. Pushing
        // them around with personal space displaces them off the chair and
        // exposes the seat marker next to them. Skip the adjustment when
        // both parties are seated.
        if (a.seated && b.seated) {
          return;
        }
        const baseRadius = a.seated && b.seated ? seatedPersonalSpaceRadius : standingPersonalSpaceRadius;
        const radius = baseRadius + (a.moving || b.moving ? 5 : 0);
        const dx = a.container.x - b.container.x;
        const dy = (a.container.y - b.container.y) * 1.18;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance >= radius) {
          return;
        }

        let direction = new Phaser.Math.Vector2(dx, dy / 1.18);
        if (direction.lengthSq() < 0.001) {
          const angle = Phaser.Math.DegToRad((i * 137 + j * 73) % 360);
          direction = new Phaser.Math.Vector2(Math.cos(angle), Math.sin(angle) * 0.72);
        }
        direction.normalize();

        const overlap = radius - distance;
        const aWeight = a.seated ? 0.38 : 1;
        const bWeight = b.seated ? 0.38 : 1;
        const totalWeight = aWeight + bWeight;
        const push = Math.min(12, overlap * 0.58);
        offsets.get(a.id)?.add(direction.clone().scale(push * (bWeight / totalWeight)));
        offsets.get(b.id)?.subtract(direction.clone().scale(push * (aWeight / totalWeight)));
      });
    }

    const smoothing = Phaser.Math.Clamp(deltaSeconds * 12, 0, 1);
    people.forEach((person) => {
      const targetOffset = offsets.get(person.id) ?? new Phaser.Math.Vector2(0, 0);
      const maxOffset = person.seated ? maxSeatedPersonalOffset : maxStandingPersonalOffset;
      if (targetOffset.length() > maxOffset) {
        targetOffset.normalize().scale(maxOffset);
      }

      const currentOffset = new Phaser.Math.Vector2(
        Number(person.container.getData("personalOffsetX") ?? 0),
        Number(person.container.getData("personalOffsetY") ?? 0),
      );
      const nextOffset = new Phaser.Math.Vector2(
        Phaser.Math.Linear(currentOffset.x, targetOffset.x, smoothing),
        Phaser.Math.Linear(currentOffset.y, targetOffset.y, smoothing),
      );
      if (nextOffset.lengthSq() < 0.04) {
        nextOffset.set(0, 0);
      }

      person.container.setData("personalOffsetX", nextOffset.x);
      person.container.setData("personalOffsetY", nextOffset.y);
      this.applyPersonVisualOffset(person, nextOffset);
    });
  }

  private getPersonVisualTargets(): PersonVisualTarget[] {
    const actorTargets = this.actors
      .filter((actor) => actor.container.active)
      .map((actor): PersonVisualTarget => ({
        id: actor.id,
        container: actor.container,
        body: actor.body,
        legs: actor.legs,
        sprite: actor.sprite,
        bubble: actor.bubble,
        carriedPlate: actor.carriedPlate,
        seated: false,
        moving: Boolean(actor.container.getData("motionTween")),
      }));

    const guestTargets = this.guests
      .filter((guest) => guest.container.active)
      .map((guest): PersonVisualTarget => ({
        id: guest.id,
        container: guest.container,
        body: guest.body,
        legs: guest.legs,
        sprite: guest.sprite,
        bubble: guest.bubble,
        seated: guest.state !== "entering" && guest.state !== "leaving" && (guest.state !== "paying" || this.isGuestEating(guest)),
        moving: Boolean(guest.container.getData("motionTween")),
      }));

    const pedestrianTargets = this.pedestrians
      .filter((pedestrian) => pedestrian.container.active)
      .map((pedestrian): PersonVisualTarget => ({
        id: pedestrian.id,
        container: pedestrian.container,
        body: pedestrian.body,
        legs: pedestrian.legs,
        sprite: pedestrian.sprite,
        bubble: pedestrian.bubble,
        carriedPlate: pedestrian.snackGraphic,
        seated: false,
        moving: Boolean(pedestrian.container.getData("motionTween")),
      }));

    const transientVisitorTargets = this.transientVisitors
      .filter((visitor) => visitor.container.active)
      .map((visitor): PersonVisualTarget => ({
        id: visitor.id,
        container: visitor.container,
        body: visitor.body,
        legs: visitor.legs,
        sprite: visitor.sprite,
        bubble: visitor.bubble,
        seated: false,
        moving: Boolean(visitor.container.getData("motionTween")),
      }));

    return [...actorTargets, ...guestTargets, ...pedestrianTargets, ...transientVisitorTargets];
  }

  private applyPersonVisualOffset(person: PersonVisualTarget, offset: Phaser.Math.Vector2): void {
    this.setLocalVisualOffset(person.body, offset);
    this.setLocalVisualOffset(person.legs, offset);
    if (person.sprite) {
      this.setLocalVisualOffset(person.sprite, offset);
    }
    if (person.bubble) {
      this.setLocalVisualOffset(person.bubble, offset);
    }
    if (person.carriedPlate) {
      this.setLocalVisualOffset(person.carriedPlate, offset);
    }
  }

  private setLocalVisualOffset(
    object: Phaser.GameObjects.GameObject & {
      x: number;
      y: number;
      setPosition: (x?: number, y?: number) => unknown;
      getData: (key: string) => unknown;
      setData: (key: string, value: unknown) => unknown;
    },
    offset: Phaser.Math.Vector2,
  ): void {
    const baseX = typeof object.getData("baseLocalX") === "number" ? Number(object.getData("baseLocalX")) : object.x;
    const baseY = typeof object.getData("baseLocalY") === "number" ? Number(object.getData("baseLocalY")) : object.y;
    object.setData("baseLocalX", baseX);
    object.setData("baseLocalY", baseY);
    object.setPosition(baseX + offset.x, baseY + offset.y);
  }

  private getActorLayerBaseY(object: Phaser.GameObjects.GameObject): number {
    const positioned = object as Phaser.GameObjects.GameObject & { y?: number; getBounds?: () => Phaser.Geom.Rectangle };
    const sortY = object.getData("sortY");
    if (typeof sortY === "number") {
      return sortY;
    }
    if (object instanceof Phaser.GameObjects.Container) {
      const personalOffsetY = Number(object.getData("personalOffsetY") ?? 0);
      const sortYOffset = Number(object.getData("sortYOffset") ?? 0);
      return object.y + this.getContainerVisualBaseLocalY(object) + personalOffsetY + sortYOffset;
    }
    if (typeof positioned.y === "number") {
      return positioned.y;
    }
    return positioned.getBounds?.().bottom ?? 0;
  }

  private getContainerVisualBaseLocalY(container: Phaser.GameObjects.Container): number {
    return container.list.reduce((maxY, child) => {
      const gameObject = child as Phaser.GameObjects.GameObject & { y?: number; getData?: (key: string) => unknown };
      const visualBase = gameObject.getData?.("visualBaseLocalY");
      if (typeof visualBase === "number") {
        return Math.max(maxY, visualBase);
      }

      const baseLocalY = gameObject.getData?.("baseLocalY");
      if (typeof baseLocalY === "number") {
        return Math.max(maxY, baseLocalY);
      }

      return Math.max(maxY, typeof gameObject.y === "number" ? gameObject.y : 0);
    }, 0);
  }

  private getWorldSortKind(object: Phaser.GameObjects.GameObject): number {
    const sortKind = object.getData("worldSortKind");
    return typeof sortKind === "number" ? sortKind : 2;
  }

  private drawHuman(
    graphics: Phaser.GameObjects.Graphics,
    colors: PersonColors,
    facing: PersonFacing = "down",
    seated = false,
  ): void {
    graphics.clear();
    const side = facing === "left" || facing === "right";
    const back = facing === "up";
    const headX = side ? (facing === "right" ? 4 : -4) : 0;
    const headY = seated ? -31 : -38;
    const bodyY = seated ? -20 : -27;
    const bodyWidth = side ? 17 : 22;
    const bodyHeight = seated ? 19 : 25;
    const headRadius = 11;

    graphics.lineStyle(2, 0x3f3029, 1);
    graphics.fillStyle(colors.skin, 1);
    graphics.fillCircle(headX, headY, headRadius);
    graphics.strokeCircle(headX, headY, headRadius);

    graphics.fillStyle(colors.hair, 1);
    if (colors.apron) {
      graphics.fillStyle(0xffffff, 1);
      graphics.fillCircle(headX - 7, headY - 12, 6);
      graphics.fillCircle(headX, headY - 15, 7);
      graphics.fillCircle(headX + 7, headY - 12, 6);
      graphics.fillRoundedRect(headX - 9, headY - 12, 18, 8, 4);
      graphics.lineStyle(1, 0xd8d8d8, 1);
      graphics.strokeRoundedRect(headX - 9, headY - 12, 18, 8, 4);
    } else {
      graphics.fillCircle(headX, headY - 6, 9);
      if (side) {
        graphics.fillCircle(headX + (facing === "right" ? -5 : 5), headY - 3, 6);
      } else if (!back) {
        graphics.fillRoundedRect(headX - 8, headY - 9, 16, 6, 4);
      }
    }

    if (!back) {
      graphics.fillStyle(colors.skin, 1);
      graphics.fillCircle(headX, headY, 9);
      if (side) {
        graphics.fillStyle(0x3f3029, 1);
        graphics.fillCircle(headX + (facing === "right" ? 5 : -5), headY - 1, 1.7);
        graphics.lineStyle(1, 0x7a4e3c, 0.7);
        graphics.lineBetween(headX + (facing === "right" ? 3 : -3), headY + 5, headX + (facing === "right" ? 7 : -7), headY + 5);
      } else {
        graphics.fillStyle(0x3f3029, 1);
        graphics.fillCircle(-4, headY - 1, 1.5);
        graphics.fillCircle(4, headY - 1, 1.5);
        graphics.lineStyle(1, 0x7a4e3c, 0.7);
        graphics.lineBetween(-4, headY + 6, 4, headY + 6);
      }
    }

    graphics.fillStyle(colors.shirt, 1);
    graphics.fillRoundedRect(-bodyWidth / 2, bodyY, bodyWidth, bodyHeight, 7);
    graphics.strokeRoundedRect(-bodyWidth / 2, bodyY, bodyWidth, bodyHeight, 7);

    if (colors.apron) {
      graphics.fillStyle(0xffffff, 1);
      graphics.fillRoundedRect(-7, bodyY + 5, 14, bodyHeight - 6, 3);
      graphics.lineStyle(1, 0xdedede, 0.9);
      graphics.lineBetween(-6, bodyY + 10, 6, bodyY + 10);
    }

    if (colors.tie && !back) {
      graphics.fillStyle(0xf4e6ce, 1);
      graphics.fillTriangle(-5, bodyY + 3, 0, bodyY + 9, 5, bodyY + 3);
      graphics.fillStyle(0x7b2530, 1);
      if (side) {
        const tieX = facing === "right" ? 5 : -5;
        graphics.fillTriangle(tieX - 2, bodyY + 6, tieX + 2, bodyY + 6, tieX, bodyY + 20);
      } else {
        graphics.fillTriangle(-4, bodyY + 7, 4, bodyY + 7, 0, bodyY + 21);
      }
    }

    graphics.lineStyle(4, colors.skin, 1);
    if (side) {
      const armX = facing === "right" ? 11 : -11;
      graphics.lineBetween(armX * 0.55, bodyY + 7, armX, bodyY + (seated ? 16 : 20));
    } else {
      graphics.lineBetween(-bodyWidth / 2, bodyY + 7, -17, bodyY + (seated ? 16 : 21));
      graphics.lineBetween(bodyWidth / 2, bodyY + 7, 17, bodyY + (seated ? 16 : 21));
    }

  }

  private drawLegs(
    graphics: Phaser.GameObjects.Graphics,
    pantsColor: number,
    phase: number,
    facing: PersonFacing = "down",
    seated = false,
  ): void {
    graphics.setData("pantsColor", pantsColor);
    graphics.clear();
    graphics.setData("facing", facing);
    graphics.setData("seated", seated);
    if (seated) {
      graphics.lineStyle(5, pantsColor, 1);
      if (facing === "left" || facing === "right") {
        const direction = facing === "right" ? 1 : -1;
        graphics.setData("visualBaseLocalY", 15);
        graphics.lineBetween(-2, -2, direction * 8, 8);
        graphics.lineBetween(3, -2, direction * 8, 15);
        graphics.lineStyle(3, 0x2f2926, 1);
        graphics.lineBetween(direction * 8, 15, direction * 15, 15);
        return;
      }

      const footY = facing === "up" ? 8 : 13;
      graphics.setData("visualBaseLocalY", footY);
      graphics.lineBetween(-4, -2, -5, footY);
      graphics.lineBetween(4, -2, 5, footY);
      graphics.lineStyle(3, 0x2f2926, 1);
      graphics.lineBetween(-8, footY, -1, footY);
      graphics.lineBetween(1, footY, 8, footY);
      return;
    }

    const stride = Math.sin(phase);
    const lateral = facing === "left" || facing === "right";
    const direction = facing === "left" || facing === "up" ? -1 : 1;
    const frontDepth = lateral ? 24 + stride * 2 : 25 + stride * 7 * direction;
    const backDepth = lateral ? 24 - stride * 2 : 25 - stride * 7 * direction;
    const frontOffset = lateral ? direction * (9 + stride * 7) : 5;
    const backOffset = lateral ? -direction * (7 - stride * 7) : -5;
    graphics.setData("visualBaseLocalY", Math.max(frontDepth, backDepth));

    graphics.lineStyle(5, 0x202020, 0.25);
    graphics.lineBetween(0, 0, backOffset, backDepth - 3);

    graphics.lineStyle(5, pantsColor, 1);
    graphics.lineBetween(-4, 0, backOffset, backDepth);
    graphics.lineStyle(3, 0x2f2926, 1);
    graphics.lineBetween(backOffset - 5, backDepth, backOffset + 5, backDepth);

    graphics.lineStyle(6, pantsColor, 1);
    graphics.lineBetween(4, 0, frontOffset, frontDepth);
    graphics.lineStyle(3, 0x2f2926, 1);
    graphics.lineBetween(frontOffset - 6, frontDepth, frontOffset + 7, frontDepth);
  }

  private spawnGuests(time: number, force = false): void {
    if (!force && time < this.nextGuestAt) {
      return;
    }

    if (!force && !this.restaurantOpen) {
      this.nextGuestAt = time + 2500;
      return;
    }

    const diningSeats = this.getDiningSeats();
    const availableSeats = this.getAvailableDiningSeats();
    const activeSeated = this.guests.filter((guest) => guest.state !== "leaving").length;
    const hasService = this.staff.chefs > 0 && this.staff.waiters > 0;
    if (diningSeats.length === 0 || activeSeated >= diningSeats.length || availableSeats.length === 0 || (!force && !hasService)) {
      this.nextGuestAt = time + 2500;
      return;
    }

    const entryPoint = this.getRestaurantExitPoint();
    const diningSeat = availableSeats.find(
      (seat) => this.canPersonReachPoint(entryPoint, seat.seat, true, true) && this.canSeatReceiveService(seat),
    );
    if (!diningSeat) {
      this.nextGuestAt = time + 2500;
      this.updateStats("No reachable service seats");
      return;
    }
    const availableRecipes = this.getActiveMenuRecipes();
    if (availableRecipes.length === 0) {
      this.nextGuestAt = time + 2500;
      this.updateStats("Activate at least one recipe in the Recipe Menu");
      return;
    }

    const expectation = this.rollCustomerExpectation();
    const expectedRecipes = availableRecipes.filter((recipe) => recipe.category === expectation.category);
    if (expectedRecipes.length === 0 && !force) {
      this.turnAwayCustomerAtDoor(expectation);
      this.customers.recordLost();
      this.recordRateSample(this.recentLostGuests, 1);
      this.recordRateSample(this.recentTurnaways, 1);
      this.nextGuestAt = time + 2200;
      this.updateStats(`Visitor wanted ${this.formatRecipeCategory(expectation.category).toLowerCase()}, but it is not on the menu`);
      return;
    }

    const orderItems = this.chooseGuestOrder(availableRecipes, diningSeat, expectation);
    const entryPedestrian = this.getPedestrianForEntrance();
    const guest = this.createGuest(entryPedestrian.point.x, entryPedestrian.point.y, diningSeat, orderItems, entryPedestrian.visual);
    this.guests.push(guest);
    this.recordRateSample(this.recentGuestEntries, 1);
    this.requestFurnitureRender("guest seated");
    this.tickets.push(
      ...orderItems.map((recipe) => ({
        id: Phaser.Math.RND.uuid(),
        guestId: guest.id,
        recipe,
        state: "ordering" as const,
        readyAt: 0,
      })),
    );

    const entered = this.movePerson(guest.container, guest.body, guest.legs, diningSeat.seat, customerWalkPixelsPerSecond, () => {
        guest.state = "waitingToOrder";
        guest.bubble.setText("Ready to order");
        guest.seatedAt = this.time.now;
        guest.patience = this.getGuestPatienceSeconds(guest);
        this.drawPersonPose(guest.body, guest.legs, guest.seatedFacing, 0, true);
        this.persistQuietly();
    }, true);
    if (!entered) {
      guest.container.destroy();
      this.guests = this.guests.filter((item) => item !== guest);
      this.tickets = this.tickets.filter((ticket) => ticket.guestId !== guest.id);
      this.nextGuestAt = time + 2500;
      this.updateStats("Entrance route blocked");
      return;
    }

    const enabledSeatCount = this.getDiningSeats().filter((seat) => !seat.disabled).length;
    const attractiveness = this.reputation.getAttractiveness(this.placement.getFurniture());
    const spawnRate = this.customers.estimateSpawnRate(attractiveness, enabledSeatCount, availableRecipes.length, this.getAverageRating());
    const intervalMs = spawnRate > 0 ? 60000 / spawnRate : 9500;
    this.nextGuestAt = time + Phaser.Math.Clamp(intervalMs * 1.35, 2200, 15000);
  }

  private updateGuests(time: number, deltaSeconds: number): void {
    this.guests.forEach((guest) => {
      if (guest.state !== "waitingToOrder" && guest.state !== "waitingForFood") {
        return;
      }

      if (guest.state === "waitingForFood" && this.areAllGuestItemsDelivered(guest.id)) {
        this.startGuestEating(guest);
        return;
      }

      guest.patience -= deltaSeconds;
      const ticket = this.tickets.find((item) => item.guestId === guest.id);
      if (guest.patience <= 0 && ticket?.state !== "serving") {
        if (this.hasDeliveredItems(guest.id)) {
          this.cancelUndeliveredGuestTickets(guest.id);
          guest.state = "served";
          guest.bubble.setText("Paying early");
        } else {
          this.customers.recordLost();
          this.recordRateSample(this.recentLostGuests, 1);
          this.leaveRestaurant(guest, false);
        }
        this.persistQuietly();
      }
    });

    this.guests = this.guests.filter((guest) => guest.state !== "leaving" || guest.container.active);
    this.tickets = this.tickets.filter((ticket) => this.guests.some((guest) => guest.id === ticket.guestId));
  }

  private assignKitchenWork(time: number): void {
    this.assignPreparedServingsToQueuedTickets();
    let startedAny = false;
    this.getWorkingChefActors().forEach((chef, stationIndex) => {
      if (chef.task !== "idle" || time < chef.busyUntil) {
        return;
      }

      const ticket = this.tickets.find((item) => item.state === "queued" && this.hasIngredients(item.recipe));
      if (!ticket) {
        return;
      }

      startedAny = true;
      this.startCookingTicket(chef, stationIndex, ticket);
    });

    if (!startedAny && this.tickets.some((item) => item.state === "queued") && this.getWorkingChefActors().some((chef) => chef.task === "idle")) {
      this.getWorkingChefActors()
        .filter((chef) => chef.task === "idle")
        .forEach((chef) => chef.bubble.setText("Need ingredients"));
    }
  }

  private startCookingTicket(chef: Actor, stationIndex: number, ticket: MealTicket): void {
    this.consumeIngredients(ticket.recipe);
    ticket.state = "cooking";
    ticket.serviceKind = undefined;
    ticket.serviceStartedAt = undefined;
    ticket.stationIndex = stationIndex;
    chef.task = "cooking";
    chef.bubble.setText(`Cooking ${ticket.recipe.name}`);
    this.startChefCookingAnimation(chef, stationIndex);
    this.time.delayedCall(ticket.recipe.preparationTimeSeconds * 1000, () => {
      if (!this.tickets.some((item) => item.id === ticket.id)) {
        chef.task = "idle";
        chef.busyUntil = this.time.now + 400;
        chef.bubble.setText("Ready");
        this.stopChefCookingAnimation(chef);
        return;
      }

      if (!this.guests.some((guest) => guest.id === ticket.guestId && guest.state !== "leaving")) {
        this.storePreparedServing(ticket.recipe.id);
        ticket.readyPlate?.destroy();
        this.tickets = this.tickets.filter((item) => item.id !== ticket.id);
        chef.task = "idle";
        chef.busyUntil = this.time.now + 400;
        chef.bubble.setText("Stored extra");
        this.stopChefCookingAnimation(chef);
        this.persistQuietly();
        return;
      }

      ticket.state = "ready";
      ticket.serviceKind = undefined;
      ticket.serviceStartedAt = undefined;
      ticket.readyAt = this.time.now;
      const stovePlatePoint = this.getChefStationPlatePoint(ticket.stationIndex ?? stationIndex);
      ticket.readyPlate = this.createReadyFoodPlateAt(
        stovePlatePoint.x,
        stovePlatePoint.y,
        0.82,
        this.getReadyPlateSortY(ticket.stationIndex ?? stationIndex),
      );
      this.recordRateSample(this.recentCookedDishes, 1);
      chef.task = "idle";
      chef.busyUntil = this.time.now + 400;
      chef.bubble.setText("Ready");
      this.stopChefCookingAnimation(chef);
    });
  }

  private assignServiceWork(time: number): void {
    const assignedWaiters = new Set<string>();
    const assignReadyFoodJobs = () => {
      this.getReadyFoodJobs().forEach((ticket) => {
        const guest = this.guests.find((item) => item.id === ticket.guestId);
        if (!guest || guest.state !== "waitingForFood") {
          return;
        }

        const assignment = this.getPreferredOrClosestWaiterForReadyTicket(ticket, time, assignedWaiters);
        if (!assignment) {
          return;
        }

        assignedWaiters.add(assignment.waiter.id);
        this.deliverReadyTicket(assignment.waiter, guest, ticket, assignment.pickupPoint);
      });
    };
    const assignOrderingJobs = () => {
      this.getOrderingJobs().forEach((guest) => {
        const waiter = this.getClosestAvailableWaiter(guest.serviceSpot, time, assignedWaiters);
        if (!waiter) {
          return;
        }

        assignedWaiters.add(waiter.id);
        this.takeGuestOrder(waiter, guest);
      });
    };

    assignReadyFoodJobs();
    const idleChefCount = this.getWorkingChefActors().filter((chef) => chef.task === "idle" && time >= chef.busyUntil).length;
    const activeKitchenBacklog = this.tickets.filter(
      (ticket) =>
        ticket.state === "queued" ||
        ticket.state === "cooking" ||
        (ticket.state === "serving" && ticket.serviceKind === "order"),
    ).length;
    if (idleChefCount > 0 && activeKitchenBacklog < idleChefCount && this.getOrderingJobs().length > 0) {
      assignOrderingJobs();
    }

    this.getPaymentJobs().forEach((guest) => {
      const waiter = this.getClosestAvailableWaiter(guest.cleanupSpot, time, assignedWaiters);
      if (!waiter) {
        return;
      }

      assignedWaiters.add(waiter.id);
      this.receivePayment(waiter, guest);
    });

    this.getDirtySeatJobs().forEach((seat) => {
      const waiter = this.getClosestAvailableWaiter(seat.cleanupSpot, time, assignedWaiters);
      if (!waiter) {
        return;
      }

      assignedWaiters.add(waiter.id);
      this.cleanSeat(waiter, seat);
    });

    if (this.dirtyDishCount > 0 && this.hasManualSink() && !this.manualDishwashingBusy) {
      const sinkPoint = this.getDishStationPoint("sink");
      const waiter = this.getClosestAvailableWaiter(sinkPoint, time, assignedWaiters);
      if (waiter) {
        assignedWaiters.add(waiter.id);
        this.washStoredDishesAtSink(waiter);
      }
    }

    assignOrderingJobs();
  }

  private getPaymentJobs(): Guest[] {
    return this.guests
      .filter((guest) => guest.state === "served" && this.hasPayableBill(guest))
      .sort((a, b) => a.paidAt - b.paidAt);
  }

  private getOrderingJobs(): Guest[] {
    return this.guests
      .filter((guest) => guest.state === "waitingToOrder" && this.tickets.some((ticket) => ticket.guestId === guest.id && ticket.state === "ordering"))
      .sort((a, b) => a.seatedAt - b.seatedAt);
  }

  private getReadyFoodJobs(): MealTicket[] {
    return this.tickets
      .filter((ticket) => ticket.state === "ready")
      .sort((a, b) => a.readyAt - b.readyAt);
  }

  private getDirtySeatJobs(): DiningSeat[] {
    return this.getDiningSeats()
      .filter((seat) => this.dirtySeatUids.has(seat.seatUid) && !this.cleaningSeatUids.has(seat.seatUid));
  }

  private cleanSeat(waiter: Actor, seat: DiningSeat): void {
    this.cleaningSeatUids.add(seat.seatUid);
    waiter.task = "cleaning";
    waiter.bubble.setText("Cleaning");
    this.requestFurnitureRender("cleaning reserved");
    this.moveActor(waiter, seat.cleanupSpot, () => {
      this.time.delayedCall(cleaningSeconds * 1000, () => {
        this.dirtySeatUids.delete(seat.seatUid);
        this.cleaningSeatUids.delete(seat.seatUid);
        this.showWaiterCarriedPlate(waiter, true, "dirty");
        waiter.task = "cleaning";
        waiter.busyUntil = this.time.now + 2000;
        waiter.bubble.setText("Taking dishes");
        this.requestFurnitureRender("seat cleaned");
        this.moveActor(
          waiter,
          this.getDishStationPoint(),
          () => this.dropOrWashDirtyDish(waiter),
          false,
          () => {
            this.showWaiterCarriedPlate(waiter, false);
            this.dirtyDishCount += 1;
            this.requestFurnitureRender("dirty dish stored");
            this.runDishwasher();
          },
        );
        this.persistQuietly();
      });
    }, false, () => {
      this.cleaningSeatUids.delete(seat.seatUid);
      this.requestFurnitureRender("cleaning canceled");
    });
  }

  private dropOrWashDirtyDish(waiter: Actor): void {
    if (this.hasManualSink() && !this.hasDishwasher()) {
      waiter.task = "cleaning";
      waiter.bubble.setText("Washing");
      this.time.delayedCall(manualDishwashingSeconds * 1000, () => {
        this.showWaiterCarriedPlate(waiter, false);
        waiter.task = "idle";
        waiter.busyUntil = this.time.now + 300;
        waiter.bubble.setText("Ready");
        this.moveActor(waiter, this.getWaiterHomePoint());
      });
      return;
    }

    this.showWaiterCarriedPlate(waiter, false);
    this.dirtyDishCount += 1;
    this.requestFurnitureRender("dirty dish stored");
    this.runDishwasher();
    waiter.task = "idle";
    waiter.busyUntil = this.time.now + 300;
    waiter.bubble.setText("Ready");
    this.moveActor(waiter, this.getWaiterHomePoint());
  }

  private washStoredDishesAtSink(waiter: Actor): void {
    this.manualDishwashingBusy = true;
    waiter.task = "cleaning";
    waiter.bubble.setText("Washing dishes");
    this.moveActor(waiter, this.getDishStationPoint("sink"), () => {
      this.showWaiterCarriedPlate(waiter, true, "dirty");
      this.time.delayedCall(manualDishwashingSeconds * 1000, () => {
        this.dirtyDishCount = Math.max(0, this.dirtyDishCount - 1);
        this.manualDishwashingBusy = false;
        this.showWaiterCarriedPlate(waiter, false);
        waiter.task = "idle";
        waiter.busyUntil = this.time.now + 300;
        waiter.bubble.setText("Ready");
        this.requestFurnitureRender("sink washed dish");
        this.moveActor(waiter, this.getWaiterHomePoint());
        this.persistQuietly();
      });
    }, false, () => {
      this.manualDishwashingBusy = false;
      waiter.bubble.setText("Blocked");
    });
  }

  private runDishwasher(): void {
    if (this.dishwasherBusy || this.dirtyDishCount <= 0 || !this.hasDishwasher()) {
      return;
    }

    this.dishwasherBusy = true;
    this.time.delayedCall(dishwasherSeconds * 1000, () => {
      this.dirtyDishCount = Math.max(0, this.dirtyDishCount - 1);
      this.dishwasherBusy = false;
      this.requestFurnitureRender("dishwasher washed dish");
      this.persistQuietly();
      this.runDishwasher();
    });
  }

  private assignPreparedServingsToQueuedTickets(): void {
    this.tickets
      .filter((ticket) => ticket.state === "queued" && this.cooking.getPreparedServingCount(ticket.recipe.id) > 0)
      .forEach((ticket) => {
        this.cooking.consumePreparedServing(ticket.recipe.id);
        ticket.state = "ready";
        ticket.serviceKind = undefined;
        ticket.serviceStartedAt = undefined;
        ticket.readyAt = this.time.now;
        const platePoint = this.getReadyTicketPlatePoint(ticket);
        ticket.readyPlate = this.createReadyFoodPlateAt(platePoint.x, platePoint.y, 1, this.getReadyPlateSortY(ticket.stationIndex));
      });
  }

  private getReadyTicketPlatePoint(ticket: MealTicket): Phaser.Math.Vector2 {
    if (ticket.readyPlate) {
      return new Phaser.Math.Vector2(ticket.readyPlate.x, ticket.readyPlate.y);
    }

    if (typeof ticket.stationIndex === "number") {
      return this.getChefStationPlatePoint(ticket.stationIndex);
    }

    const counterPoint = this.getDishStationPoint("counter");
    return new Phaser.Math.Vector2(counterPoint.x, counterPoint.y - 26);
  }

  private getReadyTicketPickupPoint(ticket: MealTicket): Phaser.Math.Vector2 {
    return this.getReadyTicketPickupCandidates(ticket)[0] ?? this.getReadyTicketPlatePoint(ticket);
  }

  private getReadyTicketPickupCandidates(ticket: MealTicket): Phaser.Math.Vector2[] {
    const candidates: Phaser.Math.Vector2[] = [];
    const addCandidate = (point: Phaser.Math.Vector2) => {
      const key = `${Math.round(point.x)},${Math.round(point.y)}`;
      if (candidates.some((candidate) => `${Math.round(candidate.x)},${Math.round(candidate.y)}` === key)) {
        return;
      }
      candidates.push(point);
    };

    if (typeof ticket.stationIndex === "number") {
      const station = this.getChefStationPoint(ticket.stationIndex);
      const sideStep = this.grid.tileSize * 0.38;
      addCandidate(new Phaser.Math.Vector2(station.x, station.y));
      addCandidate(new Phaser.Math.Vector2(station.x, station.y + this.grid.tileSize * 0.18));
      addCandidate(new Phaser.Math.Vector2(station.x + sideStep, station.y));
      addCandidate(new Phaser.Math.Vector2(station.x - sideStep, station.y));
    }

    const platePoint = this.getReadyTicketPlatePoint(ticket);
    addCandidate(new Phaser.Math.Vector2(platePoint.x, platePoint.y + 18));

    const counterPoint = this.getDishStationPoint("counter");
    addCandidate(new Phaser.Math.Vector2(counterPoint.x, counterPoint.y));

    return candidates;
  }

  private getReachableReadyTicketPickupPoint(
    ticket: MealTicket,
    waiterStart: Phaser.Math.Vector2,
  ): { point: Phaser.Math.Vector2; distance: number } | null {
    return this.getReadyTicketPickupCandidates(ticket)
      .map((point) => ({
        point,
        distance: this.getReachablePathDistance(waiterStart, point, false, false),
      }))
      .filter((candidate) => Number.isFinite(candidate.distance))
      .sort((a, b) => a.distance - b.distance)[0] ?? null;
  }

  private getClosestAvailableWaiter(target: Phaser.Math.Vector2, time: number, excludedWaiterIds = new Set<string>()): Actor | null {
    return this.getActiveStaffActors("waiter")
      .filter((actor) => actor.task === "idle" && time >= actor.busyUntil && !excludedWaiterIds.has(actor.id))
      .map((actor) => {
        const start = new Phaser.Math.Vector2(actor.container.x, actor.container.y);
        return { actor, distance: this.getReachablePathDistance(start, target, false, false) };
      })
      .filter((item) => Number.isFinite(item.distance))
      .sort((a, b) => a.distance - b.distance)[0]?.actor ?? null;
  }

  private getPreferredOrClosestWaiterForReadyTicket(
    ticket: MealTicket,
    time: number,
    excludedWaiterIds = new Set<string>(),
  ): WaiterPickupAssignment | null {
    const preferredWaiter = ticket.preferredWaiterId
      ? this.actors.find(
        (actor) =>
          actor.id === ticket.preferredWaiterId &&
          actor.role === "waiter" &&
          actor.task === "idle" &&
          time >= actor.busyUntil &&
          !excludedWaiterIds.has(actor.id),
      )
      : null;

    if (preferredWaiter) {
      const start = new Phaser.Math.Vector2(preferredWaiter.container.x, preferredWaiter.container.y);
      const pickup = this.getReachableReadyTicketPickupPoint(ticket, start);
      if (pickup) {
        return { waiter: preferredWaiter, pickupPoint: pickup.point };
      }
    }

    return this.getActiveStaffActors("waiter")
      .filter((actor) => actor.task === "idle" && time >= actor.busyUntil && !excludedWaiterIds.has(actor.id))
      .map((waiter) => {
        const start = new Phaser.Math.Vector2(waiter.container.x, waiter.container.y);
        const pickup = this.getReachableReadyTicketPickupPoint(ticket, start);
        return pickup ? { waiter, pickupPoint: pickup.point, distance: pickup.distance } : null;
      })
      .filter((candidate): candidate is WaiterPickupAssignment & { distance: number } => Boolean(candidate))
      .sort((a, b) => a.distance - b.distance)[0] ?? null;
  }

  private takeGuestOrder(waiter: Actor, guest: Guest): void {
    const orderTickets = this.tickets.filter((item) => item.guestId === guest.id && item.state === "ordering");
    if (orderTickets.length === 0) {
      return;
    }

    orderTickets.forEach((item) => {
      item.state = "serving";
      item.preferredWaiterId = waiter.id;
      item.serviceKind = "order";
      item.serviceStartedAt = this.time.now;
    });
    waiter.task = "serving";
    waiter.bubble.setText("Taking order");
    this.moveActor(waiter, guest.serviceSpot, () => {
      guest.bubble.setText(`Ordered ${guest.orderItems.length} item${guest.orderItems.length === 1 ? "" : "s"}`);
      this.time.delayedCall(orderHandOffSeconds * 1000, () => {
        this.routeOrderAfterTaking(waiter, guest);
      });
    }, false, () => {
      orderTickets.forEach((item) => {
        item.state = "ordering";
        item.serviceKind = undefined;
        item.serviceStartedAt = undefined;
      });
    });
  }

  private routeOrderAfterTaking(waiter: Actor, guest: Guest): void {
    const orderTickets = this.tickets.filter((item) => item.guestId === guest.id && item.state === "serving");
    if (orderTickets.length === 0 || guest.state === "leaving") {
      waiter.task = "idle";
      waiter.busyUntil = this.time.now + 250;
      waiter.bubble.setText("Ready");
      return;
    }

    orderTickets.forEach((ticket) => {
      if (!this.cooking.consumePreparedServing(ticket.recipe.id)) {
        return;
      }
      ticket.state = "ready";
      ticket.readyAt = this.time.now;
      ticket.preferredWaiterId = waiter.id;
      ticket.serviceKind = undefined;
      ticket.serviceStartedAt = undefined;
    });

    guest.state = "waitingForFood";
    guest.orderedAt = this.time.now;
    guest.patience = Math.max(guest.patience, this.getGuestPatienceSeconds(guest) * 0.75);
    this.refreshCatalogUiIfReady();
    this.requestFurnitureRender("prepared serving assigned");

    const readyTicket = this.tickets.find((item) => item.guestId === guest.id && item.state === "ready" && item.preferredWaiterId === waiter.id);
    const remainingTickets = this.tickets.filter((item) => item.guestId === guest.id && item.state === "serving");
    if (readyTicket && remainingTickets.length === 0) {
      waiter.bubble.setText("Pickup ready plate");
      this.deliverReadyTicket(waiter, guest, readyTicket);
      return;
    }

    if (remainingTickets.length > 0) {
      waiter.bubble.setText(readyTicket ? "Partial ready" : "To chef");
      this.handoffOrderToChef(waiter, guest);
      return;
    }

    waiter.task = "idle";
    waiter.busyUntil = this.time.now + 250;
    waiter.bubble.setText("Ready");
  }

  private deliverReadyTicket(
    waiter: Actor,
    guest: Guest,
    ticket: MealTicket,
    pickupPointOverride?: Phaser.Math.Vector2,
  ): void {
    const waiterStart = new Phaser.Math.Vector2(waiter.container.x, waiter.container.y);
    const pickupPoint = pickupPointOverride ?? this.getReachableReadyTicketPickupPoint(ticket, waiterStart)?.point ?? null;
    if (!pickupPoint) {
      ticket.state = "ready";
      ticket.serviceKind = undefined;
      ticket.serviceStartedAt = undefined;
      ticket.readyAt = this.time.now;
      waiter.task = "idle";
      waiter.busyUntil = this.time.now + 350;
      waiter.bubble.setText("Pickup blocked");
      return;
    }

    ticket.state = "serving";
    ticket.preferredWaiterId = waiter.id;
    ticket.serviceKind = "food";
    ticket.serviceStartedAt = this.time.now;
    waiter.task = "serving";
    waiter.bubble.setText("Pickup");
    this.moveActor(waiter, pickupPoint, () => {
      ticket.readyPlate?.destroy();
      delete ticket.readyPlate;
      this.showWaiterCarriedPlate(waiter, true);
      waiter.bubble.setText("Serving");
      const preferredMarker = ticket.preferredWaiterId === waiter.id ? "" : " (handoff)";
      if (preferredMarker) {
        waiter.bubble.setText(`Serving${preferredMarker}`);
      }
      this.moveActor(waiter, guest.serviceSpot, () => {
        ticket.state = "delivered";
        ticket.serviceKind = undefined;
        ticket.serviceStartedAt = undefined;
        this.addGuestBillForTicket(guest, ticket);
        this.showWaiterCarriedPlate(waiter, false);
        this.recordRateSample(this.recentDeliveredDishes, 1);
        const remainingItems = this.tickets.filter((item) => item.guestId === guest.id && item.state !== "delivered").length;
        guest.bubble.setText(remainingItems > 0 ? `Got ${ticket.recipe.name}` : "Eating");
        this.requestFurnitureRender("dish delivered");
        if (remainingItems === 0) {
          this.startGuestEating(guest);
        }
        this.time.delayedCall(orderHandOffSeconds * 1000, () => {
          if (this.areAllGuestItemsDelivered(guest.id)) {
            waiter.task = "idle";
            waiter.busyUntil = this.time.now + 250;
            waiter.bubble.setText("Ready");
            return;
          }

          waiter.task = "idle";
          waiter.busyUntil = this.time.now + 250;
          waiter.bubble.setText("Ready");
        });
      }, false, () => {
        ticket.state = "ready";
        ticket.serviceKind = undefined;
        ticket.serviceStartedAt = undefined;
        ticket.readyAt = this.time.now;
        this.showWaiterCarriedPlate(waiter, false);
        const platePoint = this.getReadyTicketPlatePoint(ticket);
        ticket.readyPlate = ticket.readyPlate ?? this.createReadyFoodPlateAt(platePoint.x, platePoint.y, 1, this.getReadyPlateSortY(ticket.stationIndex));
        this.requestFurnitureRender("delivery blocked");
      }, true);
    }, false, () => {
      ticket.state = "ready";
      ticket.serviceKind = undefined;
      ticket.serviceStartedAt = undefined;
      ticket.readyAt = this.time.now;
      this.showWaiterCarriedPlate(waiter, false);
      const platePoint = this.getReadyTicketPlatePoint(ticket);
      ticket.readyPlate = ticket.readyPlate ?? this.createReadyFoodPlateAt(platePoint.x, platePoint.y, 1, this.getReadyPlateSortY(ticket.stationIndex));
    });
  }

  private startGuestEating(guest: Guest): void {
    guest.state = "paying";
    guest.finishedEating = false;
    guest.bubble.setText("Eating");
    this.startGuestEatingAnimation(guest);
    this.time.delayedCall(eatingSecondsPerVisit * 1000, () => {
      if (guest.state !== "paying") {
        return;
      }

      this.stopGuestEatingAnimation(guest);
      guest.finishedEating = true;
      guest.state = "served";
      guest.bubble.setText("Ready to pay");
      this.requestFurnitureRender("guest finished eating");
    });
  }

  private startGuestEatingAnimation(guest: Guest): void {
    this.stopGuestEatingAnimation(guest);
    this.drawPersonPose(guest.body, guest.legs, guest.seatedFacing, 0, true);

    const overlay = this.add.graphics();
    overlay.setData("baseLocalX", 0);
    overlay.setData("baseLocalY", 0);
    guest.container.add(overlay);
    guest.eatingOverlay = overlay;

    guest.eatingTween = this.tweens.addCounter({
      from: 0,
      to: Math.PI * 2,
      duration: 920,
      repeat: -1,
      onUpdate: (tween) => {
        const phase = tween.getValue() ?? 0;
        const lean = Math.max(0, Math.sin(phase));
        guest.sprite?.setAngle(Math.sin(phase) * 1.6);
        guest.body.setAngle(Math.sin(phase) * 1.6);
        guest.body.setY(-lean * 1.4);
        guest.sprite?.setY(((guest.sprite.getData("baseLocalY") as number | undefined) ?? guest.sprite.y) - lean * 1.4);
        this.drawGuestEatingOverlay(overlay, guest.seatedFacing, phase);
      },
    });
  }

  private stopGuestEatingAnimation(guest: Guest): void {
    guest.eatingTween?.stop();
    guest.eatingTween = undefined;
    guest.eatingOverlay?.destroy();
    guest.eatingOverlay = undefined;
    guest.body.setAngle(0);
    guest.body.setY(0);
    guest.sprite?.setAngle(0);
    const spriteBaseY = guest.sprite?.getData("baseLocalY");
    if (guest.sprite && typeof spriteBaseY === "number") {
      guest.sprite.setY(spriteBaseY);
    }
  }

  private isGuestEating(guest: Guest): boolean {
    return guest.state === "paying" && !guest.finishedEating && Boolean(guest.eatingTween);
  }

  private drawGuestEatingOverlay(graphics: Phaser.GameObjects.Graphics, facing: PersonFacing, phase: number): void {
    graphics.clear();

    const biteProgress = Math.max(0, Math.sin(phase));
    const side = facing === "left" || facing === "right";
    const direction = facing === "left" ? -1 : 1;
    const mouth = this.getEatingMouthPoint(facing);
    const plate = this.getEatingPlatePoint(facing);
    const bite = new Phaser.Math.Vector2(
      Phaser.Math.Linear(plate.x, mouth.x, biteProgress),
      Phaser.Math.Linear(plate.y, mouth.y, biteProgress),
    );

    graphics.lineStyle(2, 0x8b7764, 0.95);
    if (side) {
      graphics.lineBetween(bite.x - direction * 9, bite.y + 5, bite.x, bite.y);
      graphics.lineBetween(bite.x - direction * 3, bite.y - 2, bite.x + direction * 4, bite.y - 7);
    } else {
      graphics.lineBetween(bite.x - 6, bite.y + 5, bite.x + 6, bite.y - 2);
      graphics.lineBetween(bite.x + 1, bite.y - 3, bite.x + 7, bite.y - 8);
    }

    graphics.fillStyle(0xf2c866, 1);
    graphics.fillEllipse(bite.x + direction * 2, bite.y - 3, 7, 4);
    graphics.fillStyle(0x6da05e, 1);
    graphics.fillCircle(bite.x - direction * 2, bite.y - 4, 2.2);

    if (biteProgress > 0.72) {
      graphics.fillStyle(0xfff0a8, 0.78);
      graphics.fillCircle(mouth.x + direction * 5, mouth.y - 3, 2.5);
    }
  }

  private getEatingMouthPoint(facing: PersonFacing): Phaser.Math.Vector2 {
    if (facing === "up") {
      return new Phaser.Math.Vector2(-4, -36);
    }
    if (facing === "left") {
      return new Phaser.Math.Vector2(-12, -31);
    }
    if (facing === "right") {
      return new Phaser.Math.Vector2(12, -31);
    }

    return new Phaser.Math.Vector2(2, -29);
  }

  private getEatingPlatePoint(facing: PersonFacing): Phaser.Math.Vector2 {
    if (facing === "up") {
      return new Phaser.Math.Vector2(-8, -19);
    }
    if (facing === "left") {
      return new Phaser.Math.Vector2(-22, -18);
    }
    if (facing === "right") {
      return new Phaser.Math.Vector2(22, -18);
    }

    return new Phaser.Math.Vector2(10, -17);
  }

  private handoffOrderToChef(waiter: Actor, guest: Guest): void {
    const orderTickets = this.tickets.filter((item) => item.guestId === guest.id && item.state === "serving");
    if (guest.state === "leaving" || orderTickets.length === 0) {
      waiter.task = "idle";
      waiter.busyUntil = this.time.now + 250;
      waiter.bubble.setText("Ready");
      return;
    }

    const availableChef = this.getClosestAvailableChefAtStation(waiter.container.x, waiter.container.y);
    if (!availableChef) {
      const idleChefExists = this.getWorkingChefActors().some((chef) => chef.task === "idle" && this.time.now >= chef.busyUntil);
      const workingChefCount = this.getWorkingChefActors().length;
      if (workingChefCount === 0) {
        orderTickets.forEach((item) => {
          item.state = "ordering";
        });
        guest.state = "waitingToOrder";
        waiter.task = "idle";
        waiter.busyUntil = this.time.now + 500;
        waiter.bubble.setText("Need chef");
        return;
      }

      if (idleChefExists) {
        orderTickets.forEach((item) => {
          item.state = "queued";
          item.preferredWaiterId = waiter.id;
          item.serviceKind = undefined;
          item.serviceStartedAt = undefined;
        });
        guest.state = "waitingForFood";
        guest.orderedAt = this.time.now;
        guest.patience = Math.max(guest.patience, this.getGuestPatienceSeconds(guest) * 0.75);
        waiter.task = "idle";
        waiter.busyUntil = this.time.now + 300;
        waiter.bubble.setText("Order queued");
        return;
      }

      waiter.bubble.setText("Chef busy");
      this.time.delayedCall(650, () => this.handoffOrderToChef(waiter, guest));
      return;
    }

    this.snapChefToStationIfNeeded(availableChef.chef, availableChef.station, availableChef.stationIndex);
    availableChef.chef.task = "receivingOrder";
    availableChef.chef.bubble.setText("Receiving order");
    waiter.bubble.setText("Give order");
    this.moveActor(waiter, availableChef.handoffPoint, () => {
      orderTickets.forEach((item) => {
        item.state = "queued";
        item.preferredWaiterId = waiter.id;
        item.serviceKind = undefined;
        item.serviceStartedAt = undefined;
      });
      guest.state = "waitingForFood";
      guest.orderedAt = this.time.now;
      guest.patience = Math.max(guest.patience, this.getGuestPatienceSeconds(guest) * 0.75);
      availableChef.chef.bubble.setText("Order in");
      availableChef.chef.task = "idle";
      availableChef.chef.busyUntil = this.time.now + 150;
      this.drawPersonPose(availableChef.chef.body, availableChef.chef.legs, "up", 0, false);
      waiter.task = "idle";
      waiter.busyUntil = this.time.now + 300;
      waiter.bubble.setText("Ready");
      this.persistQuietly();
    }, false, () => {
      orderTickets.forEach((item) => {
        item.state = "ordering";
        item.serviceKind = undefined;
        item.serviceStartedAt = undefined;
      });
      guest.state = "waitingToOrder";
      availableChef.chef.task = "idle";
      availableChef.chef.busyUntil = this.time.now + 300;
      availableChef.chef.bubble.setText("Ready");
    });
  }

  private getClosestAvailableChefAtStation(x: number, y: number): ChefHandoffCandidate | null {
    const stations = this.getChefStations();
    const waiterPosition = new Phaser.Math.Vector2(x, y);
    return this.getWorkingChefActors()
      .map((chef, stationIndex) => ({ chef, stationIndex, station: stations[stationIndex] }))
      .filter(({ chef, station }) => {
        if (!station || chef.task !== "idle" || this.time.now < chef.busyUntil) {
          return false;
        }

        return true;
      })
      .map(({ chef, station, stationIndex }) => {
        const handoffPoint = this.getChefHandoffPoint(station);
        return {
          chef,
          stationIndex,
          station,
          handoffPoint,
          distance: this.getReachablePathDistance(waiterPosition, handoffPoint, false, false),
        };
      })
      .filter((item) => Number.isFinite(item.distance))
      .sort((a, b) => a.distance - b.distance)[0] ?? null;
  }

  private getChefHandoffPoint(station: Phaser.Math.Vector2): Phaser.Math.Vector2 {
    const stationCell = this.grid.worldToGrid(station.x, station.y);
    if (stationCell && this.isWalkableCell(stationCell)) {
      return this.getCellCenter(stationCell);
    }

    const nearestWalkable = stationCell ? this.findNearestWalkableCell(stationCell) : null;
    return nearestWalkable ? this.getCellCenter(nearestWalkable) : new Phaser.Math.Vector2(station.x, station.y + 22);
  }

  private snapChefToStationIfNeeded(chef: Actor, station: Phaser.Math.Vector2, stationIndex: number): void {
    if (Phaser.Math.Distance.Between(chef.container.x, chef.container.y, station.x, station.y) < 12) {
      return;
    }

    chef.container.setPosition(station.x, station.y);
    chef.bubble.setText(stationIndex < this.getStoveCount() ? "Ready" : "Need stove");
    this.drawPersonPose(chef.body, chef.legs, "up", 0, false);
  }

  private recoverOrphanedServiceTickets(): void {
    if (this.actors.some((actor) => actor.role === "waiter" && actor.task === "serving")) {
      return;
    }

    this.tickets.forEach((ticket) => {
      if (ticket.state !== "serving") {
        return;
      }

      const guest = this.guests.find((item) => item.id === ticket.guestId);
      if (guest?.state === "waitingToOrder") {
        ticket.state = "ordering";
        ticket.serviceKind = undefined;
        ticket.serviceStartedAt = undefined;
      } else if (guest?.state === "waitingForFood") {
        ticket.state = "ready";
        ticket.serviceKind = undefined;
        ticket.serviceStartedAt = undefined;
        ticket.readyAt = this.time.now;
        const platePoint = this.getReadyTicketPlatePoint(ticket);
        ticket.readyPlate = ticket.readyPlate ?? this.createReadyFoodPlateAt(platePoint.x, platePoint.y, 1, this.getReadyPlateSortY(ticket.stationIndex));
      }
    });
  }

  private recoverStalledFoodDeliveries(time: number): void {
    const staleFoodDeliveryMs = 10000;
    const hardStaleFoodDeliveryMs = 30000;
    this.tickets
      .filter(
        (ticket) =>
          ticket.state === "serving" &&
          ticket.serviceKind === "food" &&
          typeof ticket.serviceStartedAt === "number" &&
          time - ticket.serviceStartedAt > staleFoodDeliveryMs,
      )
      .forEach((ticket) => {
        const waiter = ticket.preferredWaiterId
          ? this.actors.find((actor) => actor.id === ticket.preferredWaiterId && actor.role === "waiter")
          : null;
        const waiterStillMoving = Boolean(waiter?.container.getData("motionTween"));
        if (waiterStillMoving && time - (ticket.serviceStartedAt ?? time) < hardStaleFoodDeliveryMs) {
          return;
        }

        ticket.state = "ready";
        ticket.serviceKind = undefined;
        ticket.serviceStartedAt = undefined;
        ticket.readyAt = time;
        const platePoint = this.getReadyTicketPlatePoint(ticket);
        ticket.readyPlate = ticket.readyPlate ?? this.createReadyFoodPlateAt(platePoint.x, platePoint.y, 1, this.getReadyPlateSortY(ticket.stationIndex));

        if (waiter) {
          this.stopPersonMotion(waiter.container, waiter.body);
          this.showWaiterCarriedPlate(waiter, false);
          waiter.task = "idle";
          waiter.busyUntil = time + 350;
          waiter.bubble.setText("Retry serving");
        }
      });
  }

  private recoverStalledOrderHandoffs(time: number): void {
    const staleOrderHandoffMs = 8500;
    const idleChefAvailable = this.getWorkingChefActors().some((chef) => chef.task === "idle" && time >= chef.busyUntil);
    if (!idleChefAvailable) {
      return;
    }

    const staleTickets = this.tickets.filter(
      (ticket) =>
        ticket.state === "serving" &&
        ticket.serviceKind === "order" &&
        typeof ticket.serviceStartedAt === "number" &&
        time - ticket.serviceStartedAt > staleOrderHandoffMs,
    );
    if (staleTickets.length === 0) {
      return;
    }

    const releasedWaiterIds = new Set<string>();
    staleTickets.forEach((ticket) => {
      const guest = this.guests.find((item) => item.id === ticket.guestId);
      if (!guest || guest.state === "leaving") {
        return;
      }

      ticket.state = "queued";
      ticket.serviceKind = undefined;
      ticket.serviceStartedAt = undefined;
      guest.state = "waitingForFood";
      guest.orderedAt = guest.orderedAt || time;
      guest.patience = Math.max(guest.patience, this.getGuestPatienceSeconds(guest) * 0.75);
      if (ticket.preferredWaiterId) {
        releasedWaiterIds.add(ticket.preferredWaiterId);
      }
    });

    releasedWaiterIds.forEach((waiterId) => {
      const waiter = this.actors.find((actor) => actor.id === waiterId && actor.role === "waiter" && actor.task === "serving");
      if (!waiter) {
        return;
      }

      const waiterStillHasFood = this.tickets.some(
        (ticket) => ticket.preferredWaiterId === waiterId && ticket.state === "serving" && ticket.serviceKind === "food",
      );
      if (waiterStillHasFood) {
        return;
      }

      this.stopPersonMotion(waiter.container, waiter.body);
      this.showWaiterCarriedPlate(waiter, false);
      waiter.task = "idle";
      waiter.busyUntil = time + 250;
      waiter.bubble.setText("Order queued");
    });
  }

  private recoverStalledGuestPayments(): void {
    const hasPaymentWaiter = this.getActiveStaffActors("waiter").some((actor) => actor.task === "payment");
    if (hasPaymentWaiter) {
      return;
    }

    this.guests.forEach((guest) => {
      if (guest.state !== "paying" || !guest.finishedEating) {
        return;
      }

      guest.state = "served";
      this.clearGuestPaymentLock(guest);
      guest.bubble.setText("Ready to pay");
    });
  }

  private recoverStalledCleaningReservations(): void {
    if (this.cleaningSeatUids.size === 0) {
      return;
    }

    const hasCleaner = this.getActiveStaffActors("waiter").some((actor) => actor.task === "cleaning");
    if (hasCleaner) {
      return;
    }

    this.cleaningSeatUids.clear();
    this.requestFurnitureRender("cleaning reservations recovered");
  }

  private getWorkingChefActors(): Actor[] {
    return this.getActiveStaffActors("chef").slice(0, Math.min(this.staff.chefs, this.getStoveCount()));
  }

  private getActiveStaffActors(role: StaffRole): Actor[] {
    return this.actors.filter((actor) => actor.role === role).slice(0, this.getStaffCount(role));
  }

  private getStoveCount(): number {
    return this.getChefStations().length;
  }

  private getChefStationPoint(index: number): Phaser.Math.Vector2 {
    const station = this.getChefStations()[index];
    if (!station) {
      const fallback = this.getKitchenPickupPoint();
      return new Phaser.Math.Vector2(fallback.x + index * 28, fallback.y - 12);
    }

    return station;
  }

  private getChefStationPlatePoint(index: number): Phaser.Math.Vector2 {
    let seenSlots = 0;
    for (const stove of this.placement.getFurniture().filter((item) => getFurnitureDefinition(item.furnitureId).category === "stove")) {
      const definition = getFurnitureDefinition(stove.furnitureId);
      const slots = definition.cookingSlots ?? 1;
      const size = this.grid.getRotatedSize(definition, stove.rotation ?? 0);
      const footprint = this.grid.getAreaDiamond(stove.position, size);
      const top = this.getFurnitureVisualTop(definition, footprint);
      if (index < seenSlots + slots) {
        const localIndex = index - seenSlots;
        const edges = this.getStoveLongEdges(top, size);
        const cookLineA = this.lerpPoint(edges.backA, edges.frontA, 0.53);
        const cookLineB = this.lerpPoint(edges.backB, edges.frontB, 0.53);
        const point = this.lerpPoint(cookLineA, cookLineB, (localIndex + 1) / (slots + 1));
        return new Phaser.Math.Vector2(point.x, point.y - 10);
      }
      seenSlots += slots;
    }

    const station = this.getChefStationPoint(index);
    return new Phaser.Math.Vector2(station.x, station.y - this.grid.tileSize * 0.86);
  }

  private getChefStationBurnerPoint(index: number): Phaser.Math.Vector2 {
    let seenSlots = 0;
    for (const stove of this.placement.getFurniture().filter((item) => getFurnitureDefinition(item.furnitureId).category === "stove")) {
      const definition = getFurnitureDefinition(stove.furnitureId);
      const slots = definition.cookingSlots ?? 1;
      const size = this.grid.getRotatedSize(definition, stove.rotation ?? 0);
      const footprint = this.grid.getAreaDiamond(stove.position, size);
      const top = this.getFurnitureVisualTop(definition, footprint);
      if (index < seenSlots + slots) {
        const localIndex = index - seenSlots;
        const edges = this.getStoveLongEdges(top, size);
        const cookLineA = this.lerpPoint(edges.backA, edges.frontA, 0.53);
        const cookLineB = this.lerpPoint(edges.backB, edges.frontB, 0.53);
        const burner = this.lerpPoint(cookLineA, cookLineB, (localIndex + 1) / (slots + 1));
        return new Phaser.Math.Vector2(burner.x, burner.y + 5);
      }
      seenSlots += slots;
    }

    return this.getChefStationPlatePoint(index);
  }

  private getReadyPlateSortY(stationIndex?: number): number | undefined {
    if (typeof stationIndex !== "number") {
      return undefined;
    }

    const context = this.getStoveVisualContextForStationIndex(stationIndex);
    if (!context) {
      return this.getChefStationPlatePoint(stationIndex).y + 6;
    }

    return this.getFurnitureWorldSortY(context) + 0.6;
  }

  private getStoveVisualContextForStationIndex(index: number): FurnitureVisualContext | null {
    let seenSlots = 0;
    for (const stove of this.placement.getFurniture().filter((item) => getFurnitureDefinition(item.furnitureId).category === "stove")) {
      const definition = getFurnitureDefinition(stove.furnitureId);
      const slots = definition.cookingSlots ?? 1;
      if (index < seenSlots + slots) {
        const renderItem = this.getWallMountedRenderItem(stove, definition);
        const visualRotation = this.getViewAdjustedFurnitureRotation(renderItem.rotation ?? 0);
        return this.createFurnitureVisualContext(definition, renderItem, visualRotation);
      }
      seenSlots += slots;
    }

    return null;
  }

  private getChefStations(furniture = this.placement.getFurniture()): Phaser.Math.Vector2[] {
    return furniture
      .filter((item) => getFurnitureDefinition(item.furnitureId).category === "stove")
      .flatMap((stove) => {
        const definition = getFurnitureDefinition(stove.furnitureId);
        const slots = definition.cookingSlots ?? 1;
        const size = this.grid.getRotatedSize(definition, stove.rotation ?? 0);
        const top = this.grid.getAreaDiamond(stove.position, size);
        const edges = this.getStoveLongEdges(top, size);
        const frontCenter = this.lerpPoint(edges.frontA, edges.frontB, 0.5);
        const topCenter = this.getPolygonCenter(top);
        const outward = frontCenter.clone().subtract(topCenter);
        if (outward.lengthSq() > 0) {
          outward.normalize();
        }
        return Array.from({ length: slots }, (_, index) => {
          const point = this.lerpPoint(edges.frontA, edges.frontB, (index + 1) / (slots + 1));
          return new Phaser.Math.Vector2(point.x + outward.x * 36, point.y + outward.y * 36);
        });
      });
  }

  private getPaymentPoint(): Phaser.Math.Vector2 {
    const counters = this.placement
      .getFurniture()
      .filter((item) => {
        const definition = getFurnitureDefinition(item.furnitureId);
        return definition.category === "counter";
      })
      .sort((a, b) => this.getCounterPaymentPriority(a.furnitureId) - this.getCounterPaymentPriority(b.furnitureId));

    const counter = counters[0];
    if (!counter) {
      return this.getKitchenPickupPoint();
    }

    const definition = getFurnitureDefinition(counter.furnitureId);
    const size = this.grid.getRotatedSize(definition, counter.rotation ?? 0);
    const top = this.grid.getAreaDiamond(counter.position, size);
    const frontCenter = this.lerpPoint(top[3], top[2], 0.5);
    return new Phaser.Math.Vector2(frontCenter.x, frontCenter.y + 26);
  }

  private getCounterPaymentPriority(furnitureId: string): number {
    if (furnitureId === "cash-counter") {
      return 0;
    }
    if (furnitureId === "service-counter") {
      return 1;
    }
    if (furnitureId === "espresso-counter") {
      return 2;
    }
    return 3;
  }

  private hasManualSink(): boolean {
    return this.placement.getFurniture().some((item) => this.isSinkFurniture(item.furnitureId));
  }

  private hasDishwasher(): boolean {
    return this.placement.getFurniture().some((item) => this.isDishwasherFurniture(item.furnitureId));
  }

  private getDishStationPoint(preferred: "dishwasher" | "sink" | "counter" = "dishwasher"): Phaser.Math.Vector2 {
    const priorities =
      preferred === "sink"
        ? [...sinkFurnitureIds, ...dishwasherFurnitureIds, ...serviceCounterFurnitureIds]
        : preferred === "counter"
          ? [...serviceCounterFurnitureIds, ...sinkFurnitureIds, ...dishwasherFurnitureIds]
          : [...dishwasherFurnitureIds, ...sinkFurnitureIds, ...serviceCounterFurnitureIds];

    for (const furnitureId of priorities) {
      const item = this.placement.getFurniture().find((placed) => placed.furnitureId === furnitureId);
      if (item) {
        const definition = getFurnitureDefinition(item.furnitureId);
        const size = this.grid.getRotatedSize(definition, item.rotation ?? 0);
        const top = this.grid.getAreaDiamond(item.position, size);
        const frontCenter = this.lerpPoint(top[3], top[2], 0.5);
        return new Phaser.Math.Vector2(frontCenter.x, frontCenter.y + 26);
      }
    }

    return this.getKitchenPickupPoint();
  }

  private isSinkFurniture(furnitureId: string): boolean {
    return sinkFurnitureIds.includes(furnitureId);
  }

  private isDishwasherFurniture(furnitureId: string): boolean {
    return dishwasherFurnitureIds.includes(furnitureId);
  }

  private isDishwashingFurniture(furnitureId: string): boolean {
    return this.isSinkFurniture(furnitureId) || this.isDishwasherFurniture(furnitureId);
  }

  private startChefCookingAnimation(chef: Actor, stationIndex: number): void {
    this.stopChefCookingAnimation(chef);
    const burnerPoint = this.getChefStationBurnerPoint(stationIndex);
    chef.body.setData("characterAction", "cook");
    this.drawPersonPose(chef.body, chef.legs, "up", 0, false);

    const flame = this.add.graphics();
    flame.setPosition(burnerPoint.x, burnerPoint.y);
    flame.setData("sortY", this.getReadyPlateSortY(stationIndex) ?? burnerPoint.y + 20);
    flame.setData("worldSortKind", 1);
    this.drawCookingFlame(flame, 1);
    this.actorLayer.add(flame);
    chef.flame = flame;

    chef.actionTween = this.tweens.addCounter({
      from: 0,
      to: Math.PI * 2,
      duration: 700,
      repeat: -1,
      onUpdate: (tween) => {
        const phase = tween.getValue() ?? 0;
        const cookFrame = Math.sin(phase) >= 0 ? 1 : 2;
        if (chef.body.getData("cookFrame") !== cookFrame) {
          chef.body.setData("cookFrame", cookFrame);
          this.updateCharacterSprite(chef.body, "up", phase, false);
        }
        chef.body.setAngle(Math.sin(phase) * 3);
        chef.body.setX(Math.sin(phase * 1.6) * 1.5);
        chef.sprite?.setAngle(Math.sin(phase) * 3);
        chef.sprite?.setX(Math.sin(phase * 1.6) * 1.5);
        chef.legs.setX(Math.sin(phase * 1.6) * 0.6);
        this.drawCookingFlame(flame, 0.96 + Math.abs(Math.sin(phase)) * 0.08);
      },
    });
  }

  private stopChefCookingAnimation(chef: Actor): void {
    chef.actionTween?.stop();
    chef.actionTween = undefined;
    chef.flame?.destroy();
    chef.flame = undefined;
    chef.body.setAngle(0);
    chef.body.setX(0);
    chef.sprite?.setAngle(0);
    chef.sprite?.setX(0);
    chef.legs.setX(0);
    chef.body.setData("cookFrame", undefined);
    chef.body.setData("characterAction", undefined);
    if (chef.role === "chef") {
      this.drawPersonPose(chef.body, chef.legs, "up", 0, false);
    }
  }

  private drawCookingFlame(graphics: Phaser.GameObjects.Graphics, fireScale: number): void {
    const flameScale = Phaser.Math.Clamp(fireScale, 0.92, 1.08);
    graphics.clear();

    graphics.fillStyle(0x0f171a, 0.32);
    graphics.fillEllipse(2, 9, 34, 12);

    graphics.fillStyle(0xff9f2e, 0.9);
    graphics.fillTriangle(-12, 9, -6, -3 * flameScale, 0, 9);
    graphics.fillTriangle(-2, 10, 5, -5 * flameScale, 12, 10);
    graphics.fillStyle(0xffd978, 0.92);
    graphics.fillTriangle(-7, 8, -3, 0 - 4 * flameScale, 1, 8);
    graphics.fillTriangle(3, 8, 7, -1 - 4 * flameScale, 11, 8);

    graphics.lineStyle(5, 0x263238, 1);
    graphics.lineBetween(11, -5, 29, -12);
    graphics.lineStyle(2, 0x77858a, 0.75);
    graphics.lineBetween(12, -6, 27, -12);

    graphics.fillStyle(0x263238, 1);
    graphics.fillEllipse(0, -4, 32, 14);
    graphics.fillStyle(0x58666c, 1);
    graphics.fillEllipse(0, -7, 28, 11);
    graphics.fillStyle(0xd8d2c6, 1);
    graphics.fillEllipse(0, -8, 23, 8);
    graphics.lineStyle(2, 0x172024, 0.9);
    graphics.strokeEllipse(0, -7, 30, 12);
    graphics.fillStyle(0xf2d48b, 0.9);
    graphics.fillEllipse(-1, -8, 13, 4);
  }

  private syncChefStations(force = false): void {
    const chefs = this.getActiveStaffActors("chef");
    chefs.forEach((chef, index) => {
      if (chef.task === "cooking" || chef.task === "relocating") {
        return;
      }

      if (this.time.now < chef.busyUntil) {
        return;
      }

      const target = this.getChefStationPoint(index);
      const distance = Phaser.Math.Distance.Between(chef.container.x, chef.container.y, target.x, target.y);
      if (!force && distance < 8) {
        return;
      }

      chef.task = "relocating";
      chef.bubble.setText(index < this.getStoveCount() ? "New stove" : "Need stove");
      this.moveActor(chef, target, () => {
        chef.task = "idle";
        chef.busyUntil = this.time.now + 250;
        chef.bubble.setText(index < this.getStoveCount() ? "Ready" : "Need stove");
        if (index < this.getStoveCount()) {
          this.drawPersonPose(chef.body, chef.legs, "up", 0, false);
        }
      }, false, () => {
        chef.container.setPosition(target.x, target.y);
        chef.task = "idle";
        chef.busyUntil = this.time.now + 250;
        chef.bubble.setText(index < this.getStoveCount() ? "Ready" : "Need stove");
        if (index < this.getStoveCount()) {
          this.drawPersonPose(chef.body, chef.legs, "up", 0, false);
        }
      }, true);
    });
  }

  private updateIdleStaffBubbles(activeChefs: number): void {
    const chefs = this.getActiveStaffActors("chef");
    chefs.forEach((chef, index) => {
      if (chef.task !== "idle") {
        return;
      }

      this.setTextIfChanged(chef.bubble, index < activeChefs ? "Ready" : "Need stove");
    });

    this.getActiveStaffActors("waiter")
      .filter((actor) => actor.task === "idle")
      .forEach((waiter) => this.setTextIfChanged(waiter.bubble, "Ready"));

    this.getActiveStaffActors("errand")
      .filter((actor) => actor.task === "idle")
      .forEach((errandBoy) => this.setTextIfChanged(errandBoy.bubble, "Ready"));
  }

  private getNextActionLabel(
    chefOutput: number,
    waiterOutput: number,
    dishDemand: number,
    diningSeats: number,
    spawnRate: number,
    ingredientConsumption: number,
    shoppingOutput: number,
  ): string {
    if (dishDemand === 0) {
      return "Add usable table seats";
    }

    if (ingredientConsumption > shoppingOutput) {
      return "Raise stock target or hire errand";
    }

    if (chefOutput < dishDemand && chefOutput <= waiterOutput) {
      return "Add chef + stove";
    }

    if (waiterOutput < dishDemand && waiterOutput < chefOutput) {
      return "Hire waiter or shorten routes";
    }

    if (diningSeats <= spawnRate) {
      return "Add tables/chairs";
    }

    return "Improve decor/menu";
  }

  private getAverageWaiterServiceSeconds(expectedItemsPerCustomer = this.getExpectedDishesPerCustomer()): number {
    const seats = this.getDiningSeats();
    if (seats.length === 0) {
      return 0;
    }

    const serviceMultiplier = 1 - this.getServiceSpeedBonus();
    const waiterHomePoint = this.getWaiterHomePoint();
    const kitchenPickupPoint = this.getKitchenPickupPoint();

    const totalSeconds = seats.reduce((sum, seat) => {
      const orderRoutePixels =
        Phaser.Math.Distance.Between(waiterHomePoint.x, waiterHomePoint.y, seat.serviceSpot.x, seat.serviceSpot.y) +
        Phaser.Math.Distance.Between(seat.serviceSpot.x, seat.serviceSpot.y, kitchenPickupPoint.x, kitchenPickupPoint.y);
      const foodRoutePixels =
        Phaser.Math.Distance.Between(kitchenPickupPoint.x, kitchenPickupPoint.y, seat.serviceSpot.x, seat.serviceSpot.y) +
        Phaser.Math.Distance.Between(seat.serviceSpot.x, seat.serviceSpot.y, kitchenPickupPoint.x, kitchenPickupPoint.y);
      const paymentRoutePixels =
        Phaser.Math.Distance.Between(kitchenPickupPoint.x, kitchenPickupPoint.y, seat.serviceSpot.x, seat.serviceSpot.y) +
        Phaser.Math.Distance.Between(seat.serviceSpot.x, seat.serviceSpot.y, seat.cleanupSpot.x, seat.cleanupSpot.y) +
        Phaser.Math.Distance.Between(seat.cleanupSpot.x, seat.cleanupSpot.y, waiterHomePoint.x, waiterHomePoint.y);

      const handlingSeconds = (orderHandOffSeconds * (expectedItemsPerCustomer + 1) + paymentSeconds + cleaningSeconds) * serviceMultiplier;
      return sum + (orderRoutePixels + foodRoutePixels * expectedItemsPerCustomer + paymentRoutePixels) / staffWalkPixelsPerSecond + handlingSeconds;
    }, 0);

    return totalSeconds / seats.length;
  }

  private getServiceSpeedBonus(): number {
    const bonus = this.placement.getFurniture().reduce((sum, item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      return sum + (definition.serviceSpeedBonus ?? 0);
    }, 0);
    return Phaser.Math.Clamp(bonus, 0, 0.35);
  }

  private getGuestPatienceSeconds(guest?: Guest): number {
    const averageServiceSeconds = this.getAverageWaiterServiceSeconds();
    const orderItems = guest?.orderItems ?? this.getActiveMenuRecipes().slice(0, 1);
    const cookSeconds = orderItems.reduce((sum, recipe) => sum + recipe.preparationTimeSeconds, 0);
    return Phaser.Math.Clamp(averageServiceSeconds + cookSeconds + 55 + orderItems.length * 14, 90, 260);
  }

  private getIngredientConsumptionPerMinute(dishesPerMinute: number): number {
    const cookableRecipes = this.getActiveMenuRecipes().filter((recipe) => this.hasIngredients(recipe));
    if (cookableRecipes.length === 0) {
      return 0;
    }

    const averageIngredients = cookableRecipes.reduce((sum, recipe) => sum + recipe.ingredients.length, 0) / cookableRecipes.length;
    return Math.round(dishesPerMinute * averageIngredients);
  }

  private getCurrentCustomerDemandPerMinute(enabledSeats: number, occupiedSeats: number, attractionFlow: number): number {
    if (enabledSeats <= 0 || attractionFlow <= 0) {
      return 0;
    }

    const openSeats = Math.max(0, enabledSeats - occupiedSeats);
    const seatPressure = Phaser.Math.Clamp(openSeats / Math.max(1, enabledSeats), 0.1, 1);
    return Math.round(Math.min(attractionFlow, openSeats + occupiedSeats * 0.25) * seatPressure);
  }

  private getStoredDishBufferPerMinute(): number {
    const storedServings = this.cooking.getTotalPreparedServings();
    return Math.min(storedServings, 6);
  }

  private getCookedDishDemandPerMinute(dishDemand: number): number {
    return Math.max(0, dishDemand - this.getStoredDishBufferPerMinute());
  }

  private getChefOutputPerMinute(activeChefs: number): number {
    const cookableRecipes = this.getActiveMenuRecipes().filter((recipe) => this.hasIngredients(recipe));
    if (activeChefs === 0 || cookableRecipes.length === 0) {
      return 0;
    }

    const averagePrepSeconds = cookableRecipes.reduce((sum, recipe) => sum + recipe.preparationTimeSeconds, 0) / cookableRecipes.length;
    return Math.round((activeChefs * 60) / Math.max(1, averagePrepSeconds));
  }

  private getExpectedDishesPerCustomer(): number {
    const seats = this.getDiningSeats().filter((seat) => !seat.disabled);
    if (seats.length === 0) {
      return 1;
    }

    const total = seats.reduce((sum, seat) => sum + this.getExpectedOrderItemsForSeat(seat), 0);
    return total / seats.length;
  }

  private getExpectedOrderItemsForSeat(diningSeat: DiningSeat): number {
    const seatQuality = this.getDiningSeatQuality(diningSeat);
    const fullCourseBias = Phaser.Math.Clamp((seatQuality - 6) * 6, -18, 28);
    const firstThreshold = Phaser.Math.Clamp(42 - fullCourseBias, 0, 100);
    const secondThreshold = Phaser.Math.Clamp(76 - fullCourseBias * 0.5, firstThreshold, 100);
    const thirdThreshold = Phaser.Math.Clamp(93 - fullCourseBias * 0.15, secondThreshold, 100);
    const oneItem = firstThreshold / 100;
    const twoItems = (secondThreshold - firstThreshold) / 100;
    const threeItems = (thirdThreshold - secondThreshold) / 100;
    const fourItems = (100 - thirdThreshold) / 100;

    return oneItem + twoItems * 2 + threeItems * 3 + fourItems * 4;
  }

  private rollCustomerExpectation(): CustomerExpectation {
    return this.customers.rollCustomerExpectation();
  }

  private turnAwayCustomerAtDoor(expectation: CustomerExpectation): void {
    if (this.markPasserbyTurnaway(expectation)) {
      return;
    }

    const exitPoint = this.getRestaurantExitPoint();
    const doorPoint = this.getRestaurantDoorPoint();
    const visitor = this.createVisitorActor(exitPoint.x, exitPoint.y, `Wanted ${this.formatRecipeCategory(expectation.category).toLowerCase()}`);
    const reachedDoor = this.movePerson(visitor.container, visitor.body, visitor.legs, doorPoint, customerWalkPixelsPerSecond, () => {
      visitor.bubble.setText(`No ${this.formatRecipeCategory(expectation.category).toLowerCase()}`);
      this.time.delayedCall(600, () => {
        const left = this.movePerson(
          visitor.container,
          visitor.body,
          visitor.legs,
          exitPoint,
          customerWalkPixelsPerSecond,
          () => this.destroyTransientVisitor(visitor),
        );
        if (!left) {
          this.destroyTransientVisitor(visitor);
        }
      });
    });
    if (!reachedDoor) {
      this.destroyTransientVisitor(visitor);
    }
  }

  private createVisitorActor(x: number, y: number, bubbleText: string): TransientVisitor {
    const body = this.add.graphics();
    const legs = this.add.graphics();
    const variant = this.getRandomCharacterVariant();
    body.setData("characterRole", "guest");
    body.setData("characterVariant", variant);
    body.setData("colors", this.getRandomGuestColors());
    legs.setData("pantsColor", (body.getData("colors") as PersonColors).pants);
    const sprite = this.createCharacterSprite("guest", "idle", "up", 0, variant);
    if (sprite) {
      body.setData("sprite", sprite);
      body.setVisible(false);
      legs.setVisible(false);
    }
    const bubble = this.createStatusBubble(0, statusBubbleLocalY, bubbleText);
    const container = this.add.container(x, y, sprite ? [legs, body, sprite, bubble] : [legs, body, bubble]);
    this.actorLayer.add(container);
    this.drawPersonPose(body, legs, "up", 0, false);
    const visitor = {
      id: Phaser.Math.RND.uuid(),
      container,
      body,
      legs,
      sprite: sprite ?? undefined,
      bubble,
    };
    this.transientVisitors.push(visitor);
    return visitor;
  }

  private destroyTransientVisitor(visitor: TransientVisitor): void {
    if (visitor.container.active) {
      this.stopPersonMotion(visitor.container, visitor.body);
      visitor.container.destroy();
    }
    this.transientVisitors = this.transientVisitors.filter((item) => item !== visitor);
  }

  private clearTransientVisitors(): void {
    [...this.transientVisitors].forEach((visitor) => this.destroyTransientVisitor(visitor));
    this.transientVisitors = [];
  }

  private chooseGuestOrder(
    availableRecipes: RecipeDefinition[],
    diningSeat?: DiningSeat,
    expectation?: CustomerExpectation,
  ): RecipeDefinition[] {
    const seatQuality = diningSeat ? this.getDiningSeatQuality(diningSeat) : 4;
    return this.customers.chooseGuestOrder(availableRecipes, seatQuality, expectation);
  }

  private getDiningSeatQuality(seat: DiningSeat): number {
    const furniture = this.placement.getFurniture();
    const chair = furniture.find((item) => item.uid === seat.chairUid);
    const table = seat.tableUid ? furniture.find((item) => item.uid === seat.tableUid) : null;
    const chairDefinition = chair ? getFurnitureDefinition(chair.furnitureId) : getFurnitureDefinition(seat.chairFurnitureId);
    const tableDefinition =
      table ? getFurnitureDefinition(table.furnitureId) : seat.tableFurnitureId ? getFurnitureDefinition(seat.tableFurnitureId) : null;

    const chairScore = chairDefinition.comfort + chairDefinition.style + (chairDefinition.ratingBonus ?? 0) * 8;
    const tableScore = tableDefinition
      ? tableDefinition.comfort + tableDefinition.style + (tableDefinition.ratingBonus ?? 0) * 8
      : 0;

    return Phaser.Math.Clamp(chairScore + tableScore, 1, 16);
  }

  private getOrderSummary(orderItems: RecipeDefinition[]): string {
    if (orderItems.length === 1) {
      return orderItems[0].name;
    }

    return `${orderItems.length} items`;
  }

  private getIdealExperienceSeconds(seat: DiningSeat, orderItems: RecipeDefinition[]): number {
    const waiterHomePoint = this.getWaiterHomePoint();
    const kitchenPickupPoint = this.getKitchenPickupPoint();
    const orderRouteSeconds =
      (Phaser.Math.Distance.Between(waiterHomePoint.x, waiterHomePoint.y, seat.serviceSpot.x, seat.serviceSpot.y) +
        Phaser.Math.Distance.Between(seat.serviceSpot.x, seat.serviceSpot.y, kitchenPickupPoint.x, kitchenPickupPoint.y)) /
      staffWalkPixelsPerSecond;
    const foodRouteSeconds =
      (Phaser.Math.Distance.Between(kitchenPickupPoint.x, kitchenPickupPoint.y, seat.serviceSpot.x, seat.serviceSpot.y) +
        Phaser.Math.Distance.Between(seat.serviceSpot.x, seat.serviceSpot.y, kitchenPickupPoint.x, kitchenPickupPoint.y)) /
      staffWalkPixelsPerSecond;
    const cookSeconds = orderItems.reduce((sum, recipe) => sum + recipe.preparationTimeSeconds, 0);
    return orderRouteSeconds + cookSeconds + foodRouteSeconds * orderItems.length + orderHandOffSeconds * (orderItems.length + 1) + paymentSeconds + eatingSecondsPerVisit;
  }

  private areAllGuestItemsDelivered(guestId: string): boolean {
    const guestTickets = this.tickets.filter((item) => item.guestId === guestId);
    return guestTickets.length > 0 && guestTickets.every((item) => item.state === "delivered");
  }

  private hasDeliveredItems(guestId: string): boolean {
    return this.getDeliveredTicketsForGuest(guestId).length > 0;
  }

  private hasPayableBill(guest: Guest): boolean {
    return this.getGuestBillDue(guest) > 0;
  }

  private getDeliveredTicketsForGuest(guestId: string): MealTicket[] {
    return this.tickets.filter((item) => item.guestId === guestId && item.state === "delivered");
  }

  private getDeliveredTicketValue(tickets: MealTicket[]): number {
    return tickets.reduce((sum, item) => sum + this.getRecipeSellPrice(item.recipe), 0);
  }

  private getGuestBillDue(guest: Guest): number {
    if ((guest.billDue ?? 0) > 0) {
      return guest.billDue ?? 0;
    }

    return this.getDeliveredTicketValue(this.getDeliveredTicketsForGuest(guest.id));
  }

  private addGuestBillForTicket(guest: Guest, ticket: MealTicket): void {
    const billedTicketIds = guest.billedTicketIds ?? [];
    if (billedTicketIds.includes(ticket.id)) {
      return;
    }

    guest.billedTicketIds = [...billedTicketIds, ticket.id];
    guest.billDue = (guest.billDue ?? 0) + this.getRecipeSellPrice(ticket.recipe);
  }

  private clearGuestPaymentLock(guest: Guest): void {
    guest.lockedPaymentDue = undefined;
    guest.lockedPaymentTicketIds = undefined;
  }

  private clearGuestBill(guest: Guest): void {
    guest.billDue = undefined;
    guest.billedTicketIds = undefined;
    this.clearGuestPaymentLock(guest);
  }

  private cancelUndeliveredGuestTickets(guestId: string): void {
    this.salvageAbandonedTickets(guestId);
    this.tickets = this.tickets.filter((item) => item.guestId !== guestId || item.state === "delivered");
  }

  private salvageAbandonedTickets(guestId: string): void {
    this.tickets
      .filter((ticket) => ticket.guestId === guestId && (ticket.state === "ready" || ticket.state === "cooking"))
      .forEach((ticket) => {
        ticket.readyPlate?.destroy();
        this.storePreparedServing(ticket.recipe.id);
      });
  }

  private getUnpaidServedGuest(): Guest | null {
    return this.guests.find((guest) => guest.state === "served" && this.hasPayableBill(guest)) ?? null;
  }

  private getShoppingIngredientsPerMinute(): number {
    if (!this.autoShopEnabled) {
      return 0;
    }

    const helpers = this.staff.errandBoys ?? 0;
    const restockNeed = this.getAutoShopRestockNeed();
    const cashLimitedNeed = Math.min(restockNeed, Math.max(0, Math.floor(this.economy.getMoney() / this.getIngredientUnitCost())));
    if (helpers === 0 || cashLimitedNeed <= 0) {
      return 0;
    }

    const cycleSeconds = this.getAverageErrandCycleSeconds(maxErrandOrderItems);
    const capacityPerMinute = (helpers * maxErrandOrderItems * 60) / cycleSeconds;
    const neededThisCycle = (cashLimitedNeed * 60) / cycleSeconds;
    return Math.round(Math.min(capacityPerMinute, neededThisCycle));
  }

  private getShoppingCapacityPerMinute(): number {
    const helpers = this.staff.errandBoys ?? 0;
    if (helpers === 0) {
      return 0;
    }

    return Math.round((helpers * maxErrandOrderItems * 60) / this.getAverageErrandCycleSeconds(maxErrandOrderItems));
  }

  private getAverageErrandCycleSeconds(itemCount: number): number {
    const shoppingSeconds = (2500 + itemCount * 350) / 1000;
    const groceryCounterPoint = this.getGroceryCounterPoint();
    const errandHomePoint = this.getErrandHomePoint();
    const restaurantExitPoint = this.getRestaurantExitPoint();
    const routeSeconds =
      Phaser.Math.Distance.Between(errandHomePoint.x, errandHomePoint.y, groceryCounterPoint.x, groceryCounterPoint.y) / staffWalkPixelsPerSecond +
      Phaser.Math.Distance.Between(groceryCounterPoint.x, groceryCounterPoint.y, restaurantExitPoint.x, restaurantExitPoint.y) / staffWalkPixelsPerSecond +
      Phaser.Math.Distance.Between(restaurantExitPoint.x, restaurantExitPoint.y, groceryCounterPoint.x, groceryCounterPoint.y) / staffWalkPixelsPerSecond +
      Phaser.Math.Distance.Between(groceryCounterPoint.x, groceryCounterPoint.y, errandHomePoint.x, errandHomePoint.y) / staffWalkPixelsPerSecond;

    return shoppingSeconds + routeSeconds;
  }

  private getGroceryCounterPoint(): Phaser.Math.Vector2 {
    return this.getDishStationPoint("counter");
  }

  private getAutoShopRestockNeed(): number {
    const autoShopIngredients = this.getAutoShopIngredientIds();
    return this.cooking.getPantry()
      .filter((ingredient) => autoShopIngredients.has(ingredient.id))
      .reduce((sum, ingredient) => {
        const projected = ingredient.quantity + (this.cooking.getErrandInTransitQuantity(ingredient.id));
        return sum + Math.max(0, this.stockTarget - projected);
      }, 0);
  }

  private getInNeedIngredientLines(): string[] {
    const trackedIngredients = this.getAutoShopIngredientIds();
    if (trackedIngredients.size === 0) {
      return ["No active recipes to track."];
    }

    const shortages = this.cooking.getPantry()
      .filter((ingredient) => trackedIngredients.has(ingredient.id))
      .map((ingredient) => {
        const inTransit = this.cooking.getErrandInTransitQuantity(ingredient.id);
        const projected = ingredient.quantity + inTransit;
        return {
          ingredient,
          inTransit,
          shortage: Math.max(0, this.stockTarget - projected),
        };
      })
      .filter((item) => item.shortage > 0)
      .sort((a, b) => b.shortage - a.shortage || a.ingredient.name.localeCompare(b.ingredient.name));

    if (shortages.length === 0) {
      return ["All active-menu ingredients are at target."];
    }

    return shortages.map(({ ingredient, inTransit, shortage }) => {
      const transitText = inTransit > 0 ? `, way ${inTransit}` : "";
      return `${this.getIngredientIcon(ingredient.id)} ${ingredient.name}: need ${shortage} (have ${ingredient.quantity}${transitText})`;
    });
  }

  private getInTransitIngredientCount(): number {
    return this.cooking.getTotalErrandInTransit();
  }

  private receivePayment(waiter: Actor, guest: Guest): void {
    if (guest.state === "paying" || guest.state === "leaving") {
      waiter.task = "idle";
      waiter.busyUntil = this.time.now + 250;
      waiter.bubble.setText("Ready");
      return;
    }

    const deliveredTickets = this.getDeliveredTicketsForGuest(guest.id);
    const lockedPayment = guest.lockedPaymentDue ?? this.getGuestBillDue(guest);
    const lockedTicketIds = guest.lockedPaymentTicketIds ?? guest.billedTicketIds ?? deliveredTickets.map((ticket) => ticket.id);
    if (lockedPayment <= 0 || lockedTicketIds.length === 0) {
      this.clearGuestPaymentLock(guest);
      waiter.task = "idle";
      waiter.busyUntil = this.time.now + 250;
      waiter.bubble.setText("No bill");
      guest.bubble.setText("Waiting for bill");
      return;
    }

    guest.state = "paying";
    guest.lockedPaymentDue = lockedPayment;
    guest.lockedPaymentTicketIds = lockedTicketIds;
    waiter.task = "payment";
    waiter.bubble.setText("Payment");
    const paymentPoint = this.getPaymentPoint();
    const waiterStart = new Phaser.Math.Vector2(waiter.container.x, waiter.container.y);
    const guestStart = new Phaser.Math.Vector2(guest.container.x, guest.container.y);
    if (!this.canPersonReachPoint(waiterStart, paymentPoint, false, false) || !this.canPersonReachPoint(guestStart, paymentPoint, false, false)) {
      guest.state = "served";
      this.clearGuestPaymentLock(guest);
      waiter.task = "idle";
      waiter.busyUntil = this.time.now + 500;
      waiter.bubble.setText("Payment blocked");
      return;
    }

    guest.bubble.setText("To cashier");
    const guestMoving = this.movePerson(guest.container, guest.body, guest.legs, paymentPoint, customerWalkPixelsPerSecond, () => {
      guest.bubble.setText("Paying");
    }, false, false);
    if (!guestMoving) {
      guest.state = "served";
      this.clearGuestPaymentLock(guest);
      waiter.task = "idle";
      waiter.busyUntil = this.time.now + 500;
      waiter.bubble.setText("Payment blocked");
      return;
    }

    this.moveActor(waiter, paymentPoint, () => {
      this.time.delayedCall(paymentSeconds * 1000, () => {
        if (guest.state === "leaving") {
          waiter.task = "idle";
          waiter.busyUntil = this.time.now + 250;
          waiter.bubble.setText("Ready");
          return;
        }

        const payment = guest.lockedPaymentDue ?? this.getGuestBillDue(guest);
        if (payment <= 0) {
          guest.state = "served";
          this.clearGuestPaymentLock(guest);
          waiter.task = "idle";
          waiter.busyUntil = this.time.now + 250;
          waiter.bubble.setText("No bill");
          guest.bubble.setText("Ready to pay");
          return;
        }

        this.earnMoney(payment, "payment");
        this.updateStats(`Payment collected +$${payment}`);
        this.customers.recordServed();
        this.recordRateSample(this.recentServedGuests, 1);
        guest.paidAt = this.time.now;
        this.clearGuestBill(guest);
        this.persistQuietly();
        this.leaveRestaurant(guest, true);
        this.tickets = this.tickets.filter((item) => item.guestId !== guest.id);
        const seat = this.getDiningSeats().find((item) => item.seatUid === guest.seatUid);
        if (seat) {
          this.cleanSeat(waiter, seat);
        }
      });
    }, false, () => {
      this.stopPersonMotion(guest.container, guest.body);
      guest.state = "served";
      this.clearGuestPaymentLock(guest);
      waiter.bubble.setText("Payment blocked");
    });
  }

  private leaveRestaurant(guest: Guest, happy: boolean): void {
    if (guest.state === "leaving") {
      return;
    }

    this.stopGuestEatingAnimation(guest);

    if (!happy) {
      this.salvageAbandonedTickets(guest.id);
      this.tickets = this.tickets.filter((ticket) => ticket.guestId !== guest.id);
    }

    this.markSeatDirty(guest.seatUid);
    guest.state = "leaving";
    const rating = this.rateGuestExperience(guest, happy);
    this.recordGuestRating(rating);
    guest.bubble.setText(`${this.getMoodIcon(rating)} ${rating}/5`);
    this.tweens.add({ targets: guest.container, alpha: 0.2, duration: 400 });
    const leaving = this.movePerson(guest.container, guest.body, guest.legs, this.getRestaurantExitPoint(), customerWalkPixelsPerSecond, () => {
        guest.container.destroy();
        this.requestFurnitureRender("guest left");
    });
    if (!leaving) {
      guest.container.destroy();
      this.requestFurnitureRender("guest removed");
    }
  }

  private markSeatDirty(seatUid: string): void {
    if (!seatUid) {
      return;
    }

    this.dirtySeatUids.add(seatUid);
    this.requestFurnitureRender("seat marked dirty");
  }

  private rateGuestExperience(guest: Guest, happy: boolean): number {
    if (!happy) {
      const elapsed = Math.max(1, (this.time.now - guest.seatedAt) / 1000);
      return elapsed > guest.idealExperienceSeconds * 0.85 ? 2 : 1;
    }

    const elapsed = Math.max(1, ((guest.paidAt || this.time.now) - guest.seatedAt) / 1000);
    const delayRatio = elapsed / Math.max(1, guest.idealExperienceSeconds);
    const foodScore =
      guest.orderItems.reduce((sum, recipe) => sum + this.getRecipeSatisfactionEffect(recipe), 0) / Math.max(1, guest.orderItems.length);
    const foodBonus = foodScore >= 12 ? 0.35 : foodScore >= 8 ? 0.15 : 0;
    const furnitureBonus = this.getFurnitureRatingBonus();
    const rating = delayRatio <= 1
      ? 5
      : delayRatio <= 1.25
        ? 4
        : delayRatio <= 1.6
          ? 3
          : delayRatio <= 2.1
            ? 2
            : 1;

    return Phaser.Math.Clamp(Math.round(rating + foodBonus + furnitureBonus), 1, 5);
  }

  private getFurnitureRatingBonus(): number {
    const bonus = this.placement.getFurniture().reduce((sum, item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      return sum + (definition.ratingBonus ?? 0) + definition.comfort * 0.006 + definition.style * 0.004;
    }, 0);
    return Phaser.Math.Clamp(bonus, 0, 0.8);
  }

  private recordGuestRating(rating: number): void {
    this.reputation.recordRating(rating);
  }

  private getAverageRating(): number {
    return this.reputation.getAverageRating();
  }

  private updateRatingWidget(): void {
    if (!this.ratingBoxBackground || !this.ratingStarGraphics) {
      return;
    }

    const average = this.getAverageRating();
    const width = 344;
    const height = 42;
    this.ratingBoxBackground.clear();
    this.ratingBoxBackground.fillStyle(panelFill, 0.98);
    this.ratingBoxBackground.fillRoundedRect(0, 0, width, height, 8);
    this.ratingBoxBackground.lineStyle(2, panelStroke, 1);
    this.ratingBoxBackground.strokeRoundedRect(0, 0, width, height, 8);
    this.ratingBoxBackground.lineStyle(1, 0xffffff, 0.72);
    this.ratingBoxBackground.strokeRoundedRect(3, 3, width - 6, height - 6, 6);

    this.setTextIfChanged(this.ratingValueText, `${average.toFixed(1)}/5`);
    this.setTextIfChanged(this.ratingVoteText, `(${this.reputation.getRatingCount()}/${maxRatingHistory})`);
    this.drawRatingStars(this.ratingStarGraphics, 132, 21, average, 9, 3);
  }

  private drawRatingStars(
    graphics: Phaser.GameObjects.Graphics,
    left: number,
    centerY: number,
    rating: number,
    outerRadius: number,
    gap: number,
  ): void {
    graphics.clear();
    const innerRadius = outerRadius * 0.48;
    for (let index = 0; index < 5; index += 1) {
      const centerX = left + outerRadius + index * (outerRadius * 2 + gap);
      const points = this.getStarPolygon(centerX, centerY, outerRadius, innerRadius);
      graphics.fillStyle(0xd9c9a7, 1);
      this.fillPolygon(graphics, points);
      const fillAmount = Phaser.Math.Clamp(rating - index, 0, 1);
      if (fillAmount > 0) {
        const clipped = this.clipPolygonToMaxX(points, centerX - outerRadius + fillAmount * outerRadius * 2);
        graphics.fillStyle(0xf5c84b, 1);
        this.fillPolygon(graphics, clipped);
      }
      graphics.lineStyle(1.5, 0x8a6534, 1);
      this.strokePolygon(graphics, points);
    }
  }

  private getStarPolygon(centerX: number, centerY: number, outerRadius: number, innerRadius: number): Phaser.Math.Vector2[] {
    const points: Phaser.Math.Vector2[] = [];
    for (let index = 0; index < 10; index += 1) {
      const radius = index % 2 === 0 ? outerRadius : innerRadius;
      const angle = Phaser.Math.DegToRad(-90 + index * 36);
      points.push(new Phaser.Math.Vector2(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius));
    }
    return points;
  }

  private fillPolygon(graphics: Phaser.GameObjects.Graphics, points: Phaser.Math.Vector2[]): void {
    if (points.length < 3) {
      return;
    }
    graphics.beginPath();
    graphics.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => graphics.lineTo(point.x, point.y));
    graphics.closePath();
    graphics.fillPath();
  }

  private strokePolygon(graphics: Phaser.GameObjects.Graphics, points: Phaser.Math.Vector2[]): void {
    if (points.length < 3) {
      return;
    }
    graphics.beginPath();
    graphics.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => graphics.lineTo(point.x, point.y));
    graphics.closePath();
    graphics.strokePath();
  }

  private clipPolygonToMaxX(points: Phaser.Math.Vector2[], maxX: number): Phaser.Math.Vector2[] {
    const clipped: Phaser.Math.Vector2[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      const startInside = start.x <= maxX;
      const endInside = end.x <= maxX;

      if (startInside && endInside) {
        clipped.push(end.clone());
      } else if (startInside && !endInside) {
        clipped.push(this.getVerticalClipIntersection(start, end, maxX));
      } else if (!startInside && endInside) {
        clipped.push(this.getVerticalClipIntersection(start, end, maxX), end.clone());
      }
    }
    return clipped;
  }

  private getVerticalClipIntersection(start: Phaser.Math.Vector2, end: Phaser.Math.Vector2, x: number): Phaser.Math.Vector2 {
    const dx = end.x - start.x;
    if (Math.abs(dx) < 0.001) {
      return new Phaser.Math.Vector2(x, start.y);
    }
    const t = Phaser.Math.Clamp((x - start.x) / dx, 0, 1);
    return new Phaser.Math.Vector2(x, Phaser.Math.Linear(start.y, end.y, t));
  }

  private queueRatingTooltip(pointer: Phaser.Input.Pointer): void {
    this.clearRatingTooltipTimer();
    this.ratingHoverTimer = this.time.delayedCall(1000, () => {
      this.ratingHoverTimer = null;
      const activePointer = this.input.activePointer ?? pointer;
      this.showRatingTooltip(activePointer.x, activePointer.y);
    });
  }

  private clearRatingTooltipTimer(): void {
    this.ratingHoverTimer?.remove(false);
    this.ratingHoverTimer = null;
  }

  private showRatingTooltip(x: number, y: number): void {
    if (!this.tooltipText) {
      return;
    }

    this.tooltipText
      .setStyle({
        color: "#3b2a21",
        backgroundColor: "#fff8e8",
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: "12px",
        padding: { x: 9, y: 7 },
      })
      .setWordWrapWidth(330)
      .setLineSpacing(2)
      .setText(this.getRatingTooltipText())
      .setVisible(true);
    this.positionRatingTooltip(x, y);
  }

  private positionRatingTooltip(x: number, _y: number): void {
    if (!this.tooltipText?.visible) {
      return;
    }

    const tooltipWidth = Math.max(330, this.tooltipText.width);
    const tooltipHeight = Math.max(190, this.tooltipText.height);
    this.tooltipText.setPosition(
      Phaser.Math.Clamp(x - 16, 12, gameWidth - tooltipWidth - 12),
      Phaser.Math.Clamp(94, 12, gameHeight - tooltipHeight - 12),
    );
  }

  private getRatingTooltipText(): string {
    const ratingHistory = this.reputation.getRatingHistory();
    const votes = ratingHistory.length;
    const average = this.getAverageRating();
    const countsByRating = new Map<number, number>();
    ratingHistory.forEach((rating) => countsByRating.set(rating, (countsByRating.get(rating) ?? 0) + 1));
    const five = countsByRating.get(5) ?? 0;
    const four = countsByRating.get(4) ?? 0;
    const three = countsByRating.get(3) ?? 0;
    const two = countsByRating.get(2) ?? 0;
    const one = countsByRating.get(1) ?? 0;
    const positive = four + five;
    const negative = one + two;
    const furniture = this.placement.getFurniture();
    const decorationScore = this.reputation.getDecorationScore(furniture);
    const attractiveness = this.reputation.getAttractiveness(furniture);
    const cleanSeats = this.getAvailableDiningSeats().length;
    const activeRecipes = this.getActiveMenuRecipes().length;

    return [
      `Recent rating: ${average.toFixed(1)}/5`,
      `Votes: ${votes}/${maxRatingHistory} recent`,
      `Positive: ${positive} | Neutral: ${three} | Negative: ${negative}`,
      `5 star ${five}   4 star ${four}   3 star ${three}`,
      `2 star ${two}   1 star ${one}`,
      "",
      "What affects it now:",
      `Decor ${decorationScore}/5 | Attract ${attractiveness}/5`,
      `Clean seats ${cleanSeats} | Active dishes ${activeRecipes}`,
      `Served today ${this.customers.getDailyServed()} | Lost today ${this.customers.getDailyLost()}`,
      "",
      negative > positive
        ? "Improve service speed, stock, clean seats, and decor to push new votes upward."
        : "Keep service quick and keep upgrading decor to protect the rating.",
    ].join("\n");
  }

  private getMoodIcon(rating: number): string {
    if (rating >= 4) {
      return ":)";
    }

    if (rating >= 3) {
      return ":|";
    }

    return ":(";
  }

  private moveActor(
    actor: Actor,
    target: Phaser.Math.Vector2,
    onComplete?: () => void,
    allowExterior = false,
    onFail?: () => void,
    allowBlockedFinalStep = false,
  ): boolean {
    const moved = this.movePerson(
      actor.container,
      actor.body,
      actor.legs,
      target,
      staffWalkPixelsPerSecond,
      onComplete,
      allowBlockedFinalStep,
      allowExterior,
    );
    if (!moved) {
      actor.task = "idle";
      actor.busyUntil = this.time.now + 600;
      actor.bubble.setText("Blocked");
      onFail?.();
    }
    return moved;
  }

  private movePerson(
    container: Phaser.GameObjects.Container,
    body: Phaser.GameObjects.Graphics,
    legs: Phaser.GameObjects.Graphics,
    target: Phaser.Math.Vector2,
    pixelsPerSecond: number,
    onComplete?: () => void,
    allowBlockedFinalStep = false,
    allowExterior = true,
  ): boolean {
    if (!container.active) {
      return false;
    }

    const start = new Phaser.Math.Vector2(container.x, container.y);
    const waypoints = this.getPathWaypoints(start, target, allowBlockedFinalStep, allowExterior);
    if (waypoints.length === 0 && Phaser.Math.Distance.Between(start.x, start.y, target.x, target.y) > 1) {
      return false;
    }
    this.stopWalkingAnimation(container, body);
    this.moveAlongWaypoints(container, body, legs, waypoints, pixelsPerSecond, onComplete);
    return true;
  }

  private movePersonDirect(
    container: Phaser.GameObjects.Container,
    body: Phaser.GameObjects.Graphics,
    legs: Phaser.GameObjects.Graphics,
    target: Phaser.Math.Vector2,
    pixelsPerSecond: number,
    onComplete?: () => void,
  ): void {
    if (!container.active) {
      return;
    }

    const existingMotionTween = container.getData("motionTween") as Phaser.Tweens.Tween | undefined;
    existingMotionTween?.stop();
    this.stopWalkingAnimation(container, body);

    const start = new Phaser.Math.Vector2(container.x, container.y);
    const totalDistance = Phaser.Math.Distance.Between(start.x, start.y, target.x, target.y);
    if (totalDistance <= 1) {
      onComplete?.();
      return;
    }

    const progress = { distance: 0 };
    const motionTween = this.tweens.add({
      targets: progress,
      distance: totalDistance,
      duration: Math.max(250, (totalDistance / pixelsPerSecond) * 1000),
      ease: "Linear",
      onUpdate: () => {
        const t = Phaser.Math.Clamp(progress.distance / totalDistance, 0, 1);
        const facing = this.getFacingForVector(target.x - start.x, target.y - start.y);
        const poseFrame = Math.floor(progress.distance / 18);
        if (body.getData("poseFacing") !== facing || body.getData("poseFrame") !== poseFrame) {
          body.setData("poseFacing", facing);
          body.setData("poseFrame", poseFrame);
          this.drawPersonPose(body, legs, facing, progress.distance / 12, false);
        }
        container.setPosition(Phaser.Math.Linear(start.x, target.x, t), Phaser.Math.Linear(start.y, target.y, t));
      },
      onComplete: () => {
        container.setData("motionTween", undefined);
        this.stopWalkingAnimation(container, body);
        this.drawPersonPose(body, legs, (body.getData("facing") as PersonFacing | undefined) ?? "down", 0, false);
        onComplete?.();
      },
    });
    container.setData("motionTween", motionTween);
  }

  private canPersonReachPoint(
    start: Phaser.Math.Vector2,
    target: Phaser.Math.Vector2,
    allowBlockedFinalStep = false,
    allowExterior = true,
  ): boolean {
    const waypoints = this.getPathWaypoints(start, target, allowBlockedFinalStep, allowExterior);
    return waypoints.length > 0 || Phaser.Math.Distance.Between(start.x, start.y, target.x, target.y) <= 1;
  }

  private moveAlongWaypoints(
    container: Phaser.GameObjects.Container,
    body: Phaser.GameObjects.Graphics,
    legs: Phaser.GameObjects.Graphics,
    waypoints: Phaser.Math.Vector2[],
    pixelsPerSecond: number,
    onComplete?: () => void,
  ): void {
    const existingMotionTween = container.getData("motionTween") as Phaser.Tweens.Tween | undefined;
    existingMotionTween?.stop();

    const points = [new Phaser.Math.Vector2(container.x, container.y), ...waypoints];
    const segmentLengths = points.slice(1).map((point, index) => Phaser.Math.Distance.Between(points[index].x, points[index].y, point.x, point.y));
    const totalDistance = segmentLengths.reduce((sum, distance) => sum + distance, 0);
    if (totalDistance <= 1) {
      this.stopWalkingAnimation(container, body);
      this.drawPersonPose(body, legs, (body.getData("facing") as PersonFacing | undefined) ?? "down", 0, false);
      onComplete?.();
      return;
    }

    const progress = { distance: 0 };
    const motionTween = this.tweens.add({
      targets: progress,
      distance: totalDistance,
      duration: Math.max(250, (totalDistance / pixelsPerSecond) * 1000),
      ease: "Linear",
      onUpdate: () => {
        let traveled = progress.distance;
        for (let index = 0; index < segmentLengths.length; index += 1) {
          const length = segmentLengths[index];
          if (traveled > length) {
            traveled -= length;
            continue;
          }

          const from = points[index];
          const to = points[index + 1];
          const t = length === 0 ? 1 : traveled / length;
          const facing = this.getFacingForVector(to.x - from.x, to.y - from.y);
          const poseFrame = Math.floor(progress.distance / 18);
          if (body.getData("poseFacing") !== facing || body.getData("poseFrame") !== poseFrame) {
            body.setData("poseFacing", facing);
            body.setData("poseFrame", poseFrame);
            this.drawPersonPose(body, legs, facing, progress.distance / 12, false);
          }
          container.setPosition(Phaser.Math.Linear(from.x, to.x, t), Phaser.Math.Linear(from.y, to.y, t));
          return;
        }

        const finalPoint = points[points.length - 1];
        container.setPosition(finalPoint.x, finalPoint.y);
      },
      onComplete: () => {
        container.setData("motionTween", undefined);
        this.stopWalkingAnimation(container, body);
        this.drawPersonPose(body, legs, (body.getData("facing") as PersonFacing | undefined) ?? "down", 0, false);
        onComplete?.();
      },
    });
    container.setData("motionTween", motionTween);
  }

  private startWalkingAnimation(
    container: Phaser.GameObjects.Container,
    body: Phaser.GameObjects.Graphics,
    _legs: Phaser.GameObjects.Graphics,
  ): void {
    this.stopWalkingAnimation(container, body);
    container.setData("walkTweens", undefined);
  }

  private stopWalkingAnimation(container: Phaser.GameObjects.Container, body: Phaser.GameObjects.Graphics): void {
    const tweens = container.getData("walkTweens") as Phaser.Tweens.Tween[] | undefined;
    tweens?.forEach((tween) => tween.stop());
    container.setScale(1);
    body.setAngle(0);
    const sprite = body.getData("sprite") as Phaser.GameObjects.Image | undefined;
    sprite?.setAngle(0);
    container.setData("walkTweens", undefined);
  }

  private getFacingForVector(dx: number, dy: number): PersonFacing {
    // 8-way octant split based on angle. A movement vector close to a
    // cardinal axis (|dx| >> |dy| or vice versa) yields the cardinal facing;
    // a roughly diagonal vector yields one of the four diagonal facings.
    // Threshold of 2.414 (tan(67.5°)) keeps the cardinal "wedge" 45° wide,
    // matching standard 8-direction sprite intervals.
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < 0.0001 && ay < 0.0001) {
      return "down";
    }
    const diagonalThreshold = 2.414;
    const horizontalCardinal = ax > ay * diagonalThreshold;
    const verticalCardinal = ay > ax * diagonalThreshold;
    if (horizontalCardinal) {
      return dx >= 0 ? "right" : "left";
    }
    if (verticalCardinal) {
      return dy >= 0 ? "down" : "up";
    }
    if (dy >= 0) {
      return dx >= 0 ? "down-right" : "down-left";
    }
    return dx >= 0 ? "up-right" : "up-left";
  }

  // Same as getFacingForVector but never returns a cardinal facing — used for
  // seated characters where only diagonal AI sprites exist.
  private getDiagonalFacingForVector(dx: number, dy: number): PersonFacing {
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) {
      return "down-right";
    }
    if (dy >= 0) {
      return dx >= 0 ? "down-right" : "down-left";
    }
    return dx >= 0 ? "up-right" : "up-left";
  }

  private getTravelDuration(
    container: Phaser.GameObjects.Container,
    target: Phaser.Math.Vector2,
    pixelsPerSecond: number,
  ): number {
    const distance = Phaser.Math.Distance.Between(container.x, container.y, target.x, target.y);
    return Phaser.Math.Clamp((distance / pixelsPerSecond) * 1000, 250, 5000);
  }

  private getPathWaypoints(
    start: Phaser.Math.Vector2,
    target: Phaser.Math.Vector2,
    allowBlockedFinalStep = false,
    allowExterior = true,
  ): Phaser.Math.Vector2[] {
    const rawStartCell = this.grid.worldToGrid(start.x, start.y);
    const rawTargetCell = this.grid.worldToGrid(target.x, target.y);
    const startEndpoint = this.resolvePathEndpoint(rawStartCell, start, allowExterior);
    const targetEndpoint = this.resolvePathEndpoint(rawTargetCell, target, allowExterior, undefined, allowBlockedFinalStep);
    if (!startEndpoint.cell || !targetEndpoint.cell) {
      return [];
    }

    const path = this.findGridPath(startEndpoint.cell, targetEndpoint.cell);
    if (path.length === 0) {
      return [];
    }

    const startsOnWalkableCell = rawStartCell && this.isGridPositionUnlocked(rawStartCell) && this.isWalkableCell(rawStartCell);
    const waypoints = startsOnWalkableCell ? [] : [this.getCellCenter(startEndpoint.cell)];
    waypoints.push(...path.slice(1).map((cell) => this.getCellCenter(cell)));
    if (targetEndpoint.appendExactTarget) {
      waypoints.push(target);
    }
    return waypoints;
  }

  private getWaypointDistance(start: Phaser.Math.Vector2, waypoints: Phaser.Math.Vector2[]): number {
    if (waypoints.length === 0) {
      return Number.POSITIVE_INFINITY;
    }

    return [start, ...waypoints].slice(1).reduce((sum, point, index, points) => {
      const previous = index === 0 ? start : points[index - 1];
      return sum + Phaser.Math.Distance.Between(previous.x, previous.y, point.x, point.y);
    }, 0);
  }

  private getReachablePathDistance(
    start: Phaser.Math.Vector2,
    target: Phaser.Math.Vector2,
    allowBlockedFinalStep = false,
    allowExterior = true,
  ): number {
    const cacheKey = [
      Math.round(start.x),
      Math.round(start.y),
      Math.round(target.x),
      Math.round(target.y),
      allowBlockedFinalStep ? 1 : 0,
      allowExterior ? 1 : 0,
    ].join(":");
    const cached = this.pathDistanceCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const startedAt = performance.now();
    const waypoints = this.getPathWaypoints(start, target, allowBlockedFinalStep, allowExterior);
    const distance = waypoints.length > 0
      ? this.getWaypointDistance(start, waypoints)
      : Phaser.Math.Distance.Between(start.x, start.y, target.x, target.y) <= 1
      ? 0
      : Number.POSITIVE_INFINITY;
    this.recordPathfindingTime(performance.now() - startedAt);
    if (this.pathDistanceCache.size > 1600) {
      this.pathDistanceCache.clear();
    }
    this.pathDistanceCache.set(cacheKey, distance);
    return distance;
  }

  private recordPathfindingTime(durationMs: number): void {
    this.lastPathfindingMs = durationMs;
    this.pathfindingWindowMs += durationMs;
    this.pathfindingWindowCalls += 1;
    if (this.pathfindingWindowCalls >= 80) {
      this.pathfindingAverageMs = this.pathfindingWindowMs / this.pathfindingWindowCalls;
      this.pathfindingWindowMs = 0;
      this.pathfindingWindowCalls = 0;
    }
  }

  private canReachPoint(start: Phaser.Math.Vector2, target: Phaser.Math.Vector2, furniture: PlacedFurniture[], allowExterior = false): boolean {
    const rawStartCell = this.grid.worldToGrid(start.x, start.y);
    const rawTargetCell = this.grid.worldToGrid(target.x, target.y);
    const startEndpoint = this.resolvePathEndpoint(rawStartCell, start, allowExterior, furniture);
    const targetEndpoint = this.resolvePathEndpoint(rawTargetCell, target, allowExterior, furniture);
    if (!startEndpoint.cell || !targetEndpoint.cell) {
      return false;
    }

    return this.findGridPath(startEndpoint.cell, targetEndpoint.cell, furniture).length > 0;
  }

  private resolvePathEndpoint(
    rawCell: GridPosition | null,
    point: Phaser.Math.Vector2,
    allowBottomExterior: boolean,
    furniture = this.placement.getFurniture(),
    allowBlockedFinalStep = false,
  ): { cell: GridPosition | null; appendExactTarget: boolean } {
    if (rawCell && this.isGridPositionUnlocked(rawCell)) {
      if (this.isWalkableCell(rawCell, furniture)) {
        return { cell: rawCell, appendExactTarget: true };
      }

      return { cell: this.findNearestWalkableCell(rawCell, furniture), appendExactTarget: allowBlockedFinalStep };
    }

    if (allowBottomExterior && this.isBottomExteriorPoint(point)) {
      return { cell: this.getDoorwayCell(furniture), appendExactTarget: true };
    }

    if (!allowBottomExterior) {
      return { cell: null, appendExactTarget: false };
    }

    const doorwayCell = this.getDoorwayCell(furniture);
    return { cell: doorwayCell, appendExactTarget: false };
  }

  private getDoorwayCell(furniture = this.placement.getFurniture()): GridPosition | null {
    const doorwayCells = [
      { x: 6, y: 8 },
      { x: 7, y: 8 },
    ];
    return doorwayCells.find((cell) => this.isWalkableCell(cell, furniture)) ?? this.findNearestWalkableCell({ x: 6, y: 8 }, furniture);
  }

  private isBottomExteriorPoint(point: Phaser.Math.Vector2): boolean {
    const exitPoint = this.getRestaurantExitPoint();
    return Phaser.Math.Distance.Between(point.x, point.y, exitPoint.x, exitPoint.y) <= this.grid.tileSize * 2.5;
  }

  private findGridPath(start: GridPosition, target: GridPosition, furniture = this.placement.getFurniture()): GridPosition[] {
    const queue: GridPosition[] = [start];
    const cameFrom = new Map<string, string | null>([[this.cellKey(start), null]]);
    const targetKey = this.cellKey(target);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (this.cellKey(current) === targetKey) {
        break;
      }

      this.getWalkableNeighbors(current, target, furniture).forEach((neighbor) => {
        const key = this.cellKey(neighbor);
        if (cameFrom.has(key)) {
          return;
        }

        cameFrom.set(key, this.cellKey(current));
        queue.push(neighbor);
      });
    }

    if (!cameFrom.has(targetKey)) {
      return [];
    }

    const path: GridPosition[] = [];
    let cursor: string | null = targetKey;
    while (cursor) {
      const [x, y] = cursor.split(",").map(Number);
      path.unshift({ x, y });
      cursor = cameFrom.get(cursor) ?? null;
    }

    return path;
  }

  private getWalkableNeighbors(cell: GridPosition, target: GridPosition, furniture = this.placement.getFurniture()): GridPosition[] {
    return [
      { x: cell.x + 1, y: cell.y },
      { x: cell.x - 1, y: cell.y },
      { x: cell.x, y: cell.y + 1 },
      { x: cell.x, y: cell.y - 1 },
    ].filter((neighbor) => this.grid.isInside(neighbor) && this.isWalkableCell(neighbor, furniture));
  }

  private findNearestWalkableCell(cell: GridPosition, furniture = this.placement.getFurniture()): GridPosition | null {
    const candidates: GridPosition[] = [];
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let y = cell.y - radius; y <= cell.y + radius; y += 1) {
        for (let x = cell.x - radius; x <= cell.x + radius; x += 1) {
          const candidate = { x, y };
          if (this.grid.isInside(candidate) && this.isWalkableCell(candidate, furniture)) {
            candidates.push(candidate);
          }
        }
      }

      if (candidates.length > 0) {
        return candidates.sort((a, b) => Math.abs(a.x - cell.x) + Math.abs(a.y - cell.y) - (Math.abs(b.x - cell.x) + Math.abs(b.y - cell.y)))[0];
      }
    }

    return null;
  }

  private isWalkableCell(cell: GridPosition, furniture = this.placement.getFurniture()): boolean {
    if (!this.isGridPositionUnlocked(cell)) {
      return false;
    }

    const occupied = furniture
      .filter((item) => !this.isWalkableFurniture(getFurnitureDefinition(item.furnitureId)))
      .flatMap((item) => this.grid.getOccupiedCells(getFurnitureDefinition(item.furnitureId), item.position, item.rotation ?? 0));
    return !occupied.some((item) => item.x === cell.x && item.y === cell.y);
  }

  private isWalkableFurniture(definition: FurnitureDefinition): boolean {
    return definition.category === "flooring" || definition.category === "wallDecoration" || this.isFlatFloorDecor(definition);
  }

  private getCellCenter(cell: GridPosition): Phaser.Math.Vector2 {
    return this.grid.getCellCenter(cell);
  }

  private getKitchenPickupPoint(): Phaser.Math.Vector2 {
    return this.grid.getCellCenter(kitchenPickupCell);
  }

  private getStaffRouteAnchorPoint(furniture = this.placement.getFurniture()): Phaser.Math.Vector2 {
    const cell = this.getStaffRouteAnchorCell(furniture);
    return cell ? this.getCellCenter(cell) : this.getKitchenPickupPoint();
  }

  private getStaffRouteAnchorCell(furniture = this.placement.getFurniture()): GridPosition | null {
    const preferredCells = [
      kitchenPickupCell,
      waiterHomeCell,
      errandHomeCell,
      { x: 7, y: 8 },
      { x: 6, y: 8 },
    ];

    for (const cell of preferredCells) {
      if (this.isGridPositionUnlocked(cell) && this.isWalkableCell(cell, furniture)) {
        return cell;
      }
    }

    for (const cell of preferredCells) {
      if (!this.isGridPositionUnlocked(cell)) {
        continue;
      }

      const nearest = this.findNearestWalkableCell(cell, furniture);
      if (nearest) {
        return nearest;
      }
    }

    const kitchenCenter = this.grid.getCellCenter(kitchenPickupCell);
    return this.getUnlockedExpansionCells()
      .filter((cell) => this.grid.isInside(cell) && this.isWalkableCell(cell, furniture))
      .sort((a, b) => {
        const aPoint = this.getCellCenter(a);
        const bPoint = this.getCellCenter(b);
        return Phaser.Math.Distance.Between(aPoint.x, aPoint.y, kitchenCenter.x, kitchenCenter.y) -
          Phaser.Math.Distance.Between(bPoint.x, bPoint.y, kitchenCenter.x, kitchenCenter.y);
      })[0] ?? null;
  }

  private getWaiterHomePoint(index = 0): Phaser.Math.Vector2 {
    const home = this.grid.getCellCenter(waiterHomeCell);
    return new Phaser.Math.Vector2(home.x + index * 20, home.y);
  }

  private getErrandHomePoint(index = 0): Phaser.Math.Vector2 {
    const home = this.grid.getCellCenter(errandHomeCell);
    return new Phaser.Math.Vector2(home.x + index * 20, home.y);
  }

  private getRestaurantExitPoint(): Phaser.Math.Vector2 {
    return this.grid.getCellCenter(restaurantExitCell);
  }

  private getRestaurantDoorPoint(): Phaser.Math.Vector2 {
    return this.grid.getCellCenter({ x: 7, y: 8 });
  }

  private cellKey(cell: GridPosition): string {
    return `${cell.x},${cell.y}`;
  }

  private hasIngredients(recipe: RecipeDefinition): boolean {
    return this.cooking.hasIngredients(recipe);
  }

  private canFulfillRecipe(recipe: RecipeDefinition): boolean {
    return this.cooking.canFulfillRecipe(recipe);
  }

  private consumeIngredients(recipe: RecipeDefinition, recordRate = true): void {
    const consumed = this.cooking.consumeIngredients(recipe);
    if (consumed > 0 && recordRate) {
      this.recordIngredientUse(consumed);
    }
    this.refreshCatalogUiIfReady();
  }

  private recordIngredientUse(quantity: number): void {
    this.recordRateSample(this.recentIngredientUse, quantity);
  }

  private recordRestockDelivery(quantity: number): void {
    this.recordRateSample(this.recentRestockDeliveries, quantity);
  }

  private recordRateSample(samples: RateSample[], quantity: number): void {
    samples.push({ time: this.time.now, quantity });
    this.pruneRecentRateSamples();
  }

  private pruneRecentRateSamples(): void {
    const cutoff = this.time.now - 60000;
    const prune = (samples: RateSample[]): RateSample[] => samples.filter((sample) => sample.time >= cutoff);
    this.recentIngredientUse = prune(this.recentIngredientUse);
    this.recentRestockDeliveries = prune(this.recentRestockDeliveries);
    this.recentGuestEntries = prune(this.recentGuestEntries);
    this.recentTurnaways = prune(this.recentTurnaways);
    this.recentServedGuests = prune(this.recentServedGuests);
    this.recentLostGuests = prune(this.recentLostGuests);
    this.recentRevenue = prune(this.recentRevenue);
    this.recentExpenses = prune(this.recentExpenses);
    this.recentCookedDishes = prune(this.recentCookedDishes);
    this.recentDeliveredDishes = prune(this.recentDeliveredDishes);
  }

  private getRecentRatePerMinute(samples: RateSample[]): number {
    this.pruneRecentRateSamples();
    return samples.reduce((sum, sample) => sum + sample.quantity, 0);
  }

  private getMissingIngredientsForRecipe(recipe: RecipeDefinition): string[] {
    return this.cooking.getMissingIngredientsForRecipe(recipe);
  }

  private getIngredientName(ingredientId: string): string {
    return this.cooking.getIngredientName(ingredientId);
  }

  private getIngredientQuantity(ingredientId: string): number {
    return this.cooking.getIngredientQuantity(ingredientId);
  }

  private storePreparedServing(recipeId: string): void {
    this.cooking.storePreparedServing(recipeId);
    this.refreshCatalogUiIfReady();
  }

  private getUnpaidDeliveredValue(): number {
    return this.guests
      .filter((guest) => guest.state !== "leaving")
      .reduce((sum, guest) => sum + this.getGuestBillDue(guest), 0);
  }

  private addIngredientToErrandOrder(ingredientId: string, amount: number): void {
    const ingredient = this.cooking.getPantry().find((item) => item.id === ingredientId);
    if (!ingredient) {
      return;
    }

    const itemCount = this.getErrandOrderItemCount();
    if (itemCount >= maxErrandOrderItems) {
      this.updateStats(`Errand order is full (${maxErrandOrderItems} items max)`);
      return;
    }

    const added = Math.min(amount, maxErrandOrderItems - itemCount);
    this.cooking.queueErrand(ingredientId, added);
    this.updateStats(`${ingredient.name} +${added} added to errand order`);
  }

  private clearErrandOrder(): void {
    this.cooking.clearErrandOrder();
    this.updateStats("Errand order cleared");
  }

  private toggleAutoShop(): void {
    this.autoShopEnabled = !this.autoShopEnabled;
    this.persistQuietly();
    this.updateStats(this.autoShopEnabled ? "Auto-shop on: errand helpers will keep restocking." : "Auto-shop off");
  }

  private adjustStockTarget(delta: number): void {
    this.stockTarget = Phaser.Math.Clamp(this.stockTarget + delta, 3, 200);
    this.persistQuietly();
    this.updateStats(`Auto-shop stock target set to ${this.stockTarget}`);
  }

  private runAutoShop(): void {
    if (!this.autoShopEnabled) {
      return;
    }

    const idleErrandBoys = this.getActiveStaffActors("errand").filter((actor) => actor.task === "idle");
    if (idleErrandBoys.length === 0) {
      return;
    }

    idleErrandBoys.forEach(() => {
      const order = this.createBalancedErrandOrder(maxErrandOrderItems);
      const itemCount = order.reduce((sum, item) => sum + item.quantity, 0);
      const cost = itemCount * this.getIngredientUnitCost();
      if (itemCount === 0) {
        return;
      }

      if (!this.spendMoney(cost, "ingredients")) {
        return;
      }
      if (!this.sendErrand(order, "Auto-shop")) {
        this.earnMoney(cost, "refund");
        this.economy.refundDailyExpenses(cost);
      }
    });
  }

  private sendErrandOrder(): void {
    const itemCount = this.getErrandOrderItemCount();
    if (itemCount === 0) {
      this.updateStats("Add ingredients before sending an errand");
      return;
    }

    const cost = itemCount * this.getIngredientUnitCost();
    if (!this.spendMoney(cost, "ingredients")) {
      this.updateStats(`Need $${cost} for this errand order`);
      return;
    }

    const order = this.cooking.getErrandOrderEntries()
      .filter(([, quantity]) => quantity > 0)
      .map(([ingredientId, quantity]) => ({ ingredientId, quantity }));

    if (!this.sendErrand(order)) {
      this.earnMoney(cost, "refund");
      this.economy.refundDailyExpenses(cost);
      return;
    }

    this.cooking.clearErrandOrder();
  }

  private createBalancedErrandOrder(maxItems: number): Array<{ ingredientId: string; quantity: number }> {
    const autoShopIngredients = this.getAutoShopIngredientIds();
    if (autoShopIngredients.size === 0) {
      return [];
    }

    const quantities = new Map<string, number>();
    for (let index = 0; index < maxItems; index += 1) {
      const blockingDemand = this.getBlockingIngredientDemandForActiveMenu(quantities);
      const ingredient = [...this.cooking.getPantry()]
        .filter((item) => autoShopIngredients.has(item.id))
        .filter((item) => item.quantity + (this.cooking.getErrandInTransitQuantity(item.id)) + (quantities.get(item.id) ?? 0) < this.stockTarget)
        .sort((a, b) => {
          const quantityA = a.quantity + (this.cooking.getErrandInTransitQuantity(a.id)) + (quantities.get(a.id) ?? 0);
          const quantityB = b.quantity + (this.cooking.getErrandInTransitQuantity(b.id)) + (quantities.get(b.id) ?? 0);
          const priorityA = this.getIngredientRestockPriority(a.id, quantityA, blockingDemand);
          const priorityB = this.getIngredientRestockPriority(b.id, quantityB, blockingDemand);
          if (priorityA !== priorityB) {
            return priorityB - priorityA;
          }

          return quantityA - quantityB;
        })[0];
      if (!ingredient) {
        break;
      }

      quantities.set(ingredient.id, (quantities.get(ingredient.id) ?? 0) + 1);
    }

    return [...quantities.entries()].map(([ingredientId, quantity]) => ({ ingredientId, quantity }));
  }

  private getAutoShopIngredientIds(): Set<string> {
    const activeRecipeIngredients = this.getStockPlanningMenuRecipes().flatMap((recipe) => recipe.ingredients);
    return new Set(activeRecipeIngredients);
  }

  private getStockPlanningMenuRecipes(): RecipeDefinition[] {
    return recipes.filter((recipe) => this.isRecipeUnlocked(recipe) && this.cooking.isOnMenu(recipe.id));
  }

  private getBlockingIngredientDemandForActiveMenu(plannedQuantities = new Map<string, number>()): Map<string, number> {
    const demand = new Map<string, number>();
    this.getStockPlanningMenuRecipes().forEach((recipe) => {
      if ((this.cooking.getPreparedServingCount(recipe.id)) > 0) {
        return;
      }

      recipe.ingredients.forEach((ingredientId) => {
        const projected = this.getIngredientQuantity(ingredientId) + (this.cooking.getErrandInTransitQuantity(ingredientId)) + (plannedQuantities.get(ingredientId) ?? 0);
        if (projected <= 0) {
          demand.set(ingredientId, (demand.get(ingredientId) ?? 0) + 1);
        }
      });
    });
    return demand;
  }

  private getIngredientRestockPriority(ingredientId: string, projectedQuantity: number, blockingDemand: Map<string, number>): number {
    const blockedRecipes = blockingDemand.get(ingredientId) ?? 0;
    if (blockedRecipes <= 0) {
      return 0;
    }

    const emergencyBoost = projectedQuantity <= 0 ? 1000 : 100;
    return emergencyBoost + blockedRecipes * 25;
  }

  private getErrandOrderItemCount(): number {
    return this.cooking.getTotalErrandOrderQuantity();
  }

  private getErrandOrderSummary(): string {
    const inTransitCount = this.cooking.getTotalErrandInTransit();
    return `In transit: ${inTransitCount} items`;
  }

  private sendErrand(order: Array<{ ingredientId: string; quantity: number }>, source = "Errand"): boolean {
    const errandBoy = this.getActiveStaffActors("errand").find((actor) => actor.task === "idle");
    if (!errandBoy) {
      this.updateStats("Hire or wait for an errand helper");
      return false;
    }

    const itemCount = order.reduce((sum, item) => sum + item.quantity, 0);
    const duration = 2500 + itemCount * 350;
    order.forEach((item) => {
      this.cooking.recordErrandInTransit(item.ingredientId, item.quantity);
    });
    const cancelTransitAndRefund = () => {
      order.forEach((item) => {
        this.cooking.removeErrandInTransit(item.ingredientId, item.quantity);
      });
      const refund = itemCount * this.getIngredientUnitCost();
      this.earnMoney(refund, "refund");
      this.economy.refundDailyExpenses(refund);
      this.updateStats(`${source} blocked and refunded`);
    };

    errandBoy.task = "errand";
    errandBoy.bubble.setText(`Shopping x${itemCount}`);
    const departureCounterPoint = this.getGroceryCounterPoint();
    this.moveActor(errandBoy, departureCounterPoint, () => {
      const exitPoint = this.getRestaurantExitPoint();
      this.moveActor(errandBoy, exitPoint, () => {
        errandBoy.container.setAlpha(0.25);
        this.time.delayedCall(duration, () => {
          order.forEach((item) => {
            this.cooking.removeErrandInTransit(item.ingredientId, item.quantity);
            this.cooking.addPantryStock(item.ingredientId, item.quantity);
          });
          this.recordRestockDelivery(itemCount);

          errandBoy.container.setAlpha(1);
          const returnPoint = this.getRestaurantExitPoint();
          errandBoy.container.setPosition(returnPoint.x, returnPoint.y);
          errandBoy.bubble.setText("Delivered");
          const deliveryCounterPoint = this.getGroceryCounterPoint();
          this.moveActor(errandBoy, deliveryCounterPoint, () => {
            this.moveActor(errandBoy, this.getErrandHomePoint(), () => {
              errandBoy.task = "idle";
              errandBoy.bubble.setText("Ready");
              this.persistQuietly();
              this.updateStats(`${source} delivered ${itemCount} items`);
            });
          }, true, () => {
            errandBoy.task = "idle";
            errandBoy.busyUntil = this.time.now + 300;
            errandBoy.bubble.setText("Delivered");
            this.persistQuietly();
            this.updateStats(`${source} delivered ${itemCount} items`);
          });
        });
      }, true, cancelTransitAndRefund);
    }, false, cancelTransitAndRefund);

    this.persistQuietly();
    this.updateStats(`${source} sent for ${itemCount} items`);
    return true;
  }

  private toggleRecipeOnMenu(recipeId: string): void {
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe) {
      return;
    }

    if (!this.isRecipeUnlocked(recipe)) {
      const message = this.getLuxuryLockText(recipe.name, this.getRecipeLuxuryTier(recipe));
      this.showToast(message, "error");
      this.updateStats(message);
      return;
    }

    if (this.cooking.isOnMenu(recipeId)) {
      const result = this.cooking.removeFromMenu(recipeId);
      if (result === "lastItem") {
        this.updateStats("Keep at least one dish active");
        return;
      }
      this.persistQuietly();
      this.updateStats(`${recipe.name} removed from active menu`);
      return;
    }

    if (this.getActiveRecipeCountForCategory(recipe.category) >= 3) {
      this.updateStats(`Only 3 active ${this.formatRecipeCategory(recipe.category)} recipes allowed`);
      return;
    }

    this.cooking.addToMenu(recipeId);
    this.persistQuietly();
    this.updateStats(`${recipe.name} added to active menu`);
  }

  private getActiveRecipeCountForCategory(category: RecipeDefinition["category"]): number {
    return this.cooking.getActiveRecipeCountForCategory(category);
  }

  private getActiveMenuRecipes(): RecipeDefinition[] {
    return recipes.filter(
      (recipe) =>
        this.isRecipeUnlocked(recipe) && this.cooking.isOnMenu(recipe.id) && this.canFulfillRecipe(recipe),
    );
  }

  private getDiningSeats(furniture = this.placement.getFurniture()): DiningSeat[] {
    const canUseCache = furniture === this.placement.getFurniture();
    const cacheKey = canUseCache ? this.getDiningSeatCacheKey(furniture) : "";
    if (canUseCache && cacheKey === this.diningSeatsCacheKey) {
      return this.diningSeatsCache;
    }

    const tables = furniture.filter((item) => getFurnitureDefinition(item.furnitureId).category === "table");
    const chairs = furniture.filter((item) => getFurnitureDefinition(item.furnitureId).category === "chair");
    const seatsByTable = new Map<string, number>();

    const seats = chairs
      .flatMap((chair): DiningSeat[] => {
        const table = this.findTableForChair(chair, tables, seatsByTable);
        if (!table) {
          return [];
        }

        const chairDefinition = getFurnitureDefinition(chair.furnitureId);
        const tableDefinition = getFurnitureDefinition(table.furnitureId);
        const tableCapacity = this.getTableSeatCapacity(tableDefinition);
        const currentSeats = seatsByTable.get(table.uid) ?? 0;
        const seatsToCreate = this.getChairSeatingCapacity(chairDefinition);
        if (currentSeats + seatsToCreate > tableCapacity) {
          return [];
        }
        seatsByTable.set(table.uid, currentSeats + seatsToCreate);

        const tableSize = this.grid.getRotatedSize(tableDefinition, table.rotation ?? 0);
        const tableCenter = this.getPolygonCenter(this.grid.getAreaDiamond(table.position, tableSize));

        const chairBackRotation = this.getLogicalChairBackRotationTowardTable(
          chair,
          chairDefinition,
          table,
          tableDefinition,
        );

        return Array.from({ length: seatsToCreate }, (_, seatIndex) => {
          const seat = this.getSeatPointOnChair(chair, chairDefinition, seatsToCreate, seatIndex, chairBackRotation);
          const serviceSpot = this.getServiceSpotForSeat(seat, tableCenter, furniture);
          // Seated characters only have AI art for the 4 diagonal facings, so
          // always pick a diagonal here even when the seat<->table vector is
          // close to a cardinal axis. Picking a cardinal would force the AI
          // loader to fall back to a wrong-direction diagonal sprite.
          const facingToTable = this.getDiagonalFacingForVector(tableCenter.x - seat.x, tableCenter.y - seat.y);
          const disabledSeatIndexes = new Set(chair.disabledSeatIndexes ?? []);

          return {
            seatUid: `${chair.uid}:${seatIndex}`,
            chairUid: chair.uid,
            chairFurnitureId: chair.furnitureId,
            seatIndex,
            disabled: disabledSeatIndexes.has(seatIndex),
            tableUid: table.uid,
            tableFurnitureId: table.furnitureId,
            seat,
            serviceSpot,
            cleanupSpot: tableCenter,
            seatedFacing: facingToTable,
            chairBackRotation,
          };
        });
      });

    if (canUseCache) {
      this.diningSeatsCacheKey = cacheKey;
      this.diningSeatsCache = seats;
    }

    return seats;
  }

  private getDiningSeatCacheKey(furniture: PlacedFurniture[]): string {
    return [
      `view:${this.grid.getViewRotationStep()}`,
      ...furniture
      .map((item) =>
        [
          item.uid,
          item.furnitureId,
          item.position.x,
          item.position.y,
          item.rotation ?? 0,
          item.disabledSeatIndexes?.join(".") ?? "",
        ].join(":"),
      ),
    ].join("|");
  }

  private getLogicalChairBackRotationTowardTable(
    chair: PlacedFurniture,
    chairDefinition: FurnitureDefinition,
    table: PlacedFurniture,
    tableDefinition: FurnitureDefinition,
  ): number {
    const chairCells = this.grid.getOccupiedCells(chairDefinition, chair.position, chair.rotation ?? 0);
    const tableCells = this.grid.getOccupiedCells(tableDefinition, table.position, table.rotation ?? 0);
    let bestDelta = { x: 0, y: 1 };
    let bestDistance = Number.POSITIVE_INFINITY;

    chairCells.forEach((chairCell) => {
      tableCells.forEach((tableCell) => {
        const dx = tableCell.x - chairCell.x;
        const dy = tableCell.y - chairCell.y;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance < bestDistance && distance > 0) {
          bestDistance = distance;
          bestDelta = { x: dx, y: dy };
        }
      });
    });

    if (Math.abs(bestDelta.x) > Math.abs(bestDelta.y)) {
      return bestDelta.x > 0 ? 270 : 90;
    }

    return bestDelta.y > 0 ? 0 : 180;
  }

  private getServiceSpotForSeat(
    seat: Phaser.Math.Vector2,
    tableCenter: Phaser.Math.Vector2,
    furniture: PlacedFurniture[],
  ): Phaser.Math.Vector2 {
    const direction = seat.clone().subtract(tableCenter);
    if (direction.lengthSq() === 0) {
      return seat.clone();
    }

    direction.normalize();
    const preferredSpot = seat.clone().add(direction.clone().scale(32));
    const preferredCell = this.grid.worldToGrid(preferredSpot.x, preferredSpot.y);
    if (preferredCell && this.isWalkableCell(preferredCell, furniture)) {
      return preferredSpot;
    }

    if (preferredCell && this.isChairCell(preferredCell, furniture)) {
      const step = this.getMajorDirectionStep(direction);
      const reachOverCell = { x: preferredCell.x + step.x, y: preferredCell.y + step.y };
      if (this.isWalkableCell(reachOverCell, furniture)) {
        return this.getCellCenter(reachOverCell);
      }
    }

    const seatCell = this.grid.worldToGrid(seat.x, seat.y);
    const fallbackCell = seatCell ? this.getNearestServiceCellAroundSeat(seatCell, tableCenter, furniture) : null;
    return fallbackCell ? this.getCellCenter(fallbackCell) : seat.clone();
  }

  private getNearestServiceCellAroundSeat(
    seatCell: GridPosition,
    tableCenter: Phaser.Math.Vector2,
    furniture: PlacedFurniture[],
  ): GridPosition | null {
    return [
      { x: seatCell.x + 1, y: seatCell.y },
      { x: seatCell.x - 1, y: seatCell.y },
      { x: seatCell.x, y: seatCell.y + 1 },
      { x: seatCell.x, y: seatCell.y - 1 },
    ]
      .filter((cell) => this.grid.isInside(cell) && this.isWalkableCell(cell, furniture))
      .sort((a, b) => {
        const aPoint = this.getCellCenter(a);
        const bPoint = this.getCellCenter(b);
        return Phaser.Math.Distance.Between(aPoint.x, aPoint.y, tableCenter.x, tableCenter.y) -
          Phaser.Math.Distance.Between(bPoint.x, bPoint.y, tableCenter.x, tableCenter.y);
      })[0] ?? null;
  }

  private getMajorDirectionStep(direction: Phaser.Math.Vector2): GridPosition {
    if (Math.abs(direction.x) > Math.abs(direction.y)) {
      return { x: direction.x >= 0 ? 1 : -1, y: 0 };
    }

    return { x: 0, y: direction.y >= 0 ? 1 : -1 };
  }

  private isChairCell(cell: GridPosition, furniture = this.placement.getFurniture()): boolean {
    return furniture.some((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      if (definition.category !== "chair") {
        return false;
      }

      return this.grid
        .getOccupiedCells(definition, item.position, item.rotation ?? 0)
        .some((occupiedCell) => occupiedCell.x === cell.x && occupiedCell.y === cell.y);
    });
  }

  private getSeatPointOnChair(
    chair: PlacedFurniture,
    chairDefinition: FurnitureDefinition,
    seatCount: number,
    seatIndex: number,
    chairBackRotation = chair.rotation ?? 0,
  ): Phaser.Math.Vector2 {
    const cells = this.grid.getOccupiedCells(chairDefinition, chair.position, chair.rotation ?? 0);
    if (cells.length === 0) {
      return this.grid.getCellCenter(chair.position);
    }

    const visualRotation = this.getViewAdjustedFurnitureRotation(chairBackRotation);
    const context = this.createFurnitureVisualContext(chairDefinition, chair, visualRotation);
    return this.getChairSeatSurfacePoint(context, seatCount, seatIndex);
  }

  private getSeatCountForTable(tableUid: string, ignoreUid?: string): number {
    const table = this.placement.getFurniture().find((item) => item.uid === tableUid);
    if (!table) {
      return 0;
    }

    return this.placement
      .getFurniture()
      .filter((item) => getFurnitureDefinition(item.furnitureId).category === "chair" && item.uid !== ignoreUid)
      .filter((chair) => this.findNearestTable(chair, [table])?.uid === tableUid)
      .reduce((sum, chair) => sum + this.getChairSeatingCapacity(getFurnitureDefinition(chair.furnitureId)), 0);
  }

  private getAvailableDiningSeats(): DiningSeat[] {
    const occupiedSeatUids = this.getOccupiedSeatUids();
    return this.getDiningSeats().filter(
      (seat) =>
        !seat.disabled &&
        !occupiedSeatUids.has(seat.seatUid) &&
        !this.dirtySeatUids.has(seat.seatUid) &&
        !this.cleaningSeatUids.has(seat.seatUid),
    );
  }

  private canSeatReceiveService(seat: DiningSeat): boolean {
    const waiterOrigins = this.getActiveStaffActors("waiter").map((waiter) => new Phaser.Math.Vector2(waiter.container.x, waiter.container.y));
    waiterOrigins.push(this.getWaiterHomePoint());
    return waiterOrigins.some((origin) => this.canPersonReachPoint(origin, seat.serviceSpot, false, false));
  }

  private getOccupiedSeatUids(): Set<string> {
    return new Set(
      this.guests
        .filter((guest) => guest.state !== "leaving")
        .map((guest) => guest.seatUid),
    );
  }

  private getChairSeatingCapacity(definition: FurnitureDefinition): number {
    return Math.max(1, definition.seatingCapacity ?? 1);
  }

  private getTableSeatCapacity(definition: FurnitureDefinition): number {
    return Math.max(1, definition.tableSeatCapacity ?? maxChairsPerTable);
  }

  private findNearestTable(chair: PlacedFurniture, tables: PlacedFurniture[]): PlacedFurniture | null {
    return this.getNearbyTables(chair, tables)[0] ?? null;
  }

  private findTableForChair(
    chair: PlacedFurniture,
    tables: PlacedFurniture[],
    seatsByTable: Map<string, number>,
  ): PlacedFurniture | null {
    const chairDefinition = getFurnitureDefinition(chair.furnitureId);
    const seatsNeeded = this.getChairSeatingCapacity(chairDefinition);
    return this.getNearbyTables(chair, tables).find((table) => {
      const tableDefinition = getFurnitureDefinition(table.furnitureId);
      const tableCapacity = this.getTableSeatCapacity(tableDefinition);
      const currentSeats = seatsByTable.get(table.uid) ?? 0;
      return currentSeats + seatsNeeded <= tableCapacity;
    }) ?? null;
  }

  private getNearbyTables(chair: PlacedFurniture, tables: PlacedFurniture[]): PlacedFurniture[] {
    return tables
      .map((table) => ({
        table,
        distance: this.getChairToTableDistance(chair, table),
      }))
      .filter((item) => item.distance <= 1)
      .sort((a, b) => a.distance - b.distance)
      .map((item) => item.table);
  }

  private getChairToTableDistance(chair: PlacedFurniture, table: PlacedFurniture): number {
    const chairDefinition = getFurnitureDefinition(chair.furnitureId);
    const tableDefinition = getFurnitureDefinition(table.furnitureId);
    const chairCells = this.grid.getOccupiedCells(chairDefinition, chair.position, chair.rotation ?? 0);
    const tableCells = this.grid.getOccupiedCells(tableDefinition, table.position, table.rotation ?? 0);
    return Math.min(
      ...chairCells.flatMap((chairCell) =>
        tableCells.map((tableCell) => Math.abs(tableCell.x - chairCell.x) + Math.abs(tableCell.y - chairCell.y)),
      ),
    );
  }

  private updateStats(message?: string): void {
    const now = this.time.now;
    if (!message && now - this.lastStatsUpdateAt < statsRefreshMs) {
      return;
    }
    this.lastStatsUpdateAt = now;
    const startedAt = performance.now();
    const fullRefresh = Boolean(message);

    const furniture = this.placement.getFurniture();
    const decorationScore = this.reputation.getDecorationScore(furniture);
    const attractiveness = this.reputation.getAttractiveness(furniture);
    const chairs = this.customers.getAvailableSeatCount(furniture);
    const tables = furniture.filter((item) => getFurnitureDefinition(item.furnitureId).category === "table").length;
    const allDiningSeats = this.getDiningSeats();
    const diningSeats = allDiningSeats.filter((seat) => !seat.disabled).length;
    const disabledSeats = allDiningSeats.length - diningSeats;
    const occupiedSeats = this.getOccupiedSeatUids().size;
    const averageRating = this.getAverageRating();
    const spawnRate = this.restaurantOpen
      ? this.customers.estimateSpawnRate(attractiveness, diningSeats, this.cooking.getUnlockedRecipeIds().length, averageRating)
      : 0;
    const stoves = this.getStoveCount();
    const activeChefs = Math.min(this.staff.chefs, stoves);
    const chefOutput = this.getChefOutputPerMinute(activeChefs);
    const customerDemand = this.getCurrentCustomerDemandPerMinute(diningSeats, occupiedSeats, spawnRate);
    const expectedDishesPerCustomer = this.getExpectedDishesPerCustomer();
    const dishDemand = Math.round(customerDemand * expectedDishesPerCustomer);
    const cookDemand = this.getCookedDishDemandPerMinute(dishDemand);
    const averageServiceSeconds = this.getAverageWaiterServiceSeconds(expectedDishesPerCustomer);
    const waiterOutput = averageServiceSeconds > 0 ? Math.round((this.staff.waiters * 60 * expectedDishesPerCustomer) / averageServiceSeconds) : 0;
    const projectedIngredientConsumption = this.getIngredientConsumptionPerMinute(Math.min(chefOutput, cookDemand));
    const actualIngredientConsumption = this.getRecentRatePerMinute(this.recentIngredientUse);
    const effectiveShoppingOutput = this.getShoppingIngredientsPerMinute();
    const actualRestockOutput = this.getRecentRatePerMinute(this.recentRestockDeliveries);
    const actualGuestEntries = this.getRecentRatePerMinute(this.recentGuestEntries);
    const actualTurnaways = this.getRecentRatePerMinute(this.recentTurnaways);
    const actualCustomerDemand = actualGuestEntries + actualTurnaways;
    const actualServedGuests = this.getRecentRatePerMinute(this.recentServedGuests);
    const actualLostGuests = this.getRecentRatePerMinute(this.recentLostGuests);
    const actualRevenue = this.getRecentRatePerMinute(this.recentRevenue);
    const actualExpenses = this.getRecentRatePerMinute(this.recentExpenses);
    const actualCookedDishes = this.getRecentRatePerMinute(this.recentCookedDishes);
    const actualDeliveredDishes = this.getRecentRatePerMinute(this.recentDeliveredDishes);
    const shoppingCapacity = this.getShoppingCapacityPerMinute();
    const restockNeed = this.getAutoShopRestockNeed();
    const inTransitIngredients = this.getInTransitIngredientCount();
    const selectedId = this.placement.getSelectedFurnitureId();
    const selected = selectedId ? getFurnitureDefinition(selectedId) : null;
    const placedSelection = this.placement.getSelectedPlacedFurniture();
    const placedSelectionDefinition = placedSelection ? getFurnitureDefinition(placedSelection.furnitureId) : null;
    const selectionRotation = selected || placedSelection ? this.placement.getSelectedRotation() : 0;
    const activeGuests = this.guests.filter((guest) => guest.state !== "leaving").length;
    const chefActors = this.getActiveStaffActors("chef");
    const waiterActors = this.getActiveStaffActors("waiter");
    const errandStaffCount = this.staff.errandBoys ?? 0;
    const errandActors = this.getActiveStaffActors("errand");
    const busyChefs = chefActors.filter((actor) => actor.task !== "idle").length;
    const freeChefs = Math.max(0, this.staff.chefs - busyChefs);
    const busyWaiters = waiterActors.filter((actor) => actor.task !== "idle").length;
    const freeWaiters = Math.max(0, this.staff.waiters - busyWaiters);
    const busyErrandBoys = errandActors.filter((actor) => actor.task !== "idle").length;
    const freeErrandBoys = Math.max(0, errandStaffCount - busyErrandBoys);
    const orderingTickets = this.tickets.filter((ticket) => ticket.state === "ordering").length;
    const queuedTickets = this.tickets.filter((ticket) => ticket.state === "queued").length;
    const cookingTickets = this.tickets.filter((ticket) => ticket.state === "cooking").length;
    const readyTickets = this.tickets.filter((ticket) => ticket.state === "ready").length;
    const deliveredTickets = this.tickets.filter((ticket) => ticket.state === "delivered").length;
    const storedServings = this.cooking.getTotalPreparedServings();
    const unpaidValue = this.getUnpaidDeliveredValue();
    const netCash = this.economy.getDailyRevenue() - this.economy.getDailyExpenses();

    this.setTextIfChanged(
      this.statsText,
      [
        `Money: $${this.economy.getMoney()}`,
        `Rating: ${averageRating.toFixed(1)}/5`,
        `Decor: ${decorationScore}/5`,
        `Attract: ${attractiveness}/5`,
        `Guests: ${activeGuests}`,
        `Seats: ${occupiedSeats}/${diningSeats}`,
        `Open clean: ${this.getAvailableDiningSeats().length}`,
      ].join("\n"),
    );
    this.setTextIfChanged(
      this.statsTextRight,
      [
        `Flow: ${actualGuestEntries}/min`,
        `Public: ${this.restaurantOpen ? "Open" : "Closed"}`,
        `Lost: ${this.customers.getDailyLost()}`,
        `Tables: ${tables}`,
        `Playtime: ${this.formatPlaytime(this.dayCycle.getTotalPlaySeconds())}`,
        `Rent: $${this.getDailyRent()} in ${this.getRentHoursRemaining().toFixed(1)}h`,
        `Space: ${this.expansionLevel}/${maxExpansionLevel}`,
        `Disabled: ${disabledSeats}`,
      ].join("\n"),
    );
    this.updateRatingWidget();
    this.setTextIfChanged(this.publicToggleButton, this.restaurantOpen ? "Close" : "Open");
    this.publicToggleButton.setBackgroundColor(this.restaurantOpen ? "#5f7f5f" : "#8f6251");
    this.setTextIfChanged(this.modeText, `Mode: ${this.mode.toUpperCase()}`);
    this.setTextIfChanged(
      this.selectedText,
      selected || placedSelectionDefinition
        ? `Selected: ${(selected ?? placedSelectionDefinition)?.name} R${selectionRotation} (${(selected ?? placedSelectionDefinition)?.size.width}x${(selected ?? placedSelectionDefinition)?.size.height})`
        : "Selected: none",
    );
    this.setTextIfChanged(
      this.staffTeamText,
      [
        `Chefs: ${this.staff.chefs} (${busyChefs} busy, ${freeChefs} free)`,
        `Cook stations: ${activeChefs}/${stoves} staffed`,
        `Waiters: ${this.staff.waiters} (${busyWaiters} busy, ${freeWaiters} free)`,
        `Errand helpers: ${errandStaffCount} (${busyErrandBoys} busy, ${freeErrandBoys} free)`,
        `Payroll: $${this.getPayrollPerMinute()}/min`,
      ].join("\n"),
    );
    this.setTextIfChanged(
      this.staffServiceText,
      [
        `Guests inside: ${activeGuests}`,
        `Cooking: ${actualCookedDishes}/min (cap ${chefOutput})`,
        `Serving: ${actualDeliveredDishes}/min (cap ${waiterOutput})`,
        `Demand: ${actualCustomerDemand}/min`,
        `Avg service: ${averageServiceSeconds.toFixed(0)}s`,
      ].join("\n"),
    );
    this.setTextIfChanged(
      this.staffStockText,
      [
        `Use: ${actualIngredientConsumption}/min`,
        `Restock: ${actualRestockOutput}/min`,
        `Shopping needed: ${restockNeed}`,
        `On the way: ${inTransitIngredients}`,
      ].join("\n"),
    );
    this.refreshStaffActionLabels();
    this.updateIdleStaffBubbles(activeChefs);
    if (fullRefresh) {
      this.refreshCatalogUi();
    }
    this.setTextIfChanged(this.autoShopButton, this.autoShopEnabled ? "Auto-Shop On" : "Auto-Shop Off");
    this.autoShopButton.setBackgroundColor(this.autoShopEnabled ? "#5f7f5f" : "#8f6251");
    this.setTextIfChanged(this.stockTargetText, `Max ${this.stockTarget}`);
    this.setTextIfChanged(this.errandOrderText, this.getErrandOrderSummary());
    this.setTextIfChanged(this.inNeedText, this.getInNeedIngredientLines().join("\n"));
    this.setTextIfChanged(
      this.pantryText,
      [...this.cooking.getPantry()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((item) => `${this.getIngredientIcon(item.id)} ${item.name}: ${item.quantity}`)
        .join("\n"),
    );
    this.clampInNeedScroll();
    if (fullRefresh) {
      this.clampPantryScroll();
      this.clampStockScroll();
    }
    this.setTextIfChanged(
      this.queueText,
      `Orders: ${orderingTickets} ordering / ${queuedTickets} queued / ${cookingTickets} cooking / ${readyTickets} ready / ${deliveredTickets} unpaid / ${storedServings} stored`,
    );

      if (message) {
        this.setTextIfChanged(this.messageText, this.formatActionMessage(message));
      }
    this.lastStatsUpdateMs = performance.now() - startedAt;
  }

  private refreshCatalogUi(): void {
    this.menuCategoryHeaders.forEach(({ category, text }) => {
      this.setTextIfChanged(text, `${this.formatRecipeCategory(category)} recipes ${this.getActiveRecipeCountForCategory(category)}/3 active`);
    });
    this.menuButtons.forEach(({ recipeId, button, badge, upgradeButton }) => {
      const recipe = recipes.find((item) => item.id === recipeId);
      if (!recipe) {
        return;
      }
      const unlocked = this.isRecipeUnlocked(recipe);
      const active = this.cooking.isOnMenu(recipe.id);
      const missingIngredients = this.getMissingIngredientsForRecipe(recipe);
      const preparedCount = this.cooking.getPreparedServingCount(recipe.id);
      const level = this.getRecipeUpgradeLevel(recipe);
      this.setTextIfChanged(button, this.getRecipeMenuLabel(recipe, unlocked, active, missingIngredients));
      button.setColor(unlocked ? "#fffaf0" : "#e1d6c9");
      button.setAlpha(unlocked ? 1 : 0.58);
      this.updateRankBadge(badge, unlocked ? level : this.getRecipeLuxuryTier(recipe), unlocked);
      button.setBackgroundColor(!unlocked ? "#7a7167" : missingIngredients.length > 0 && preparedCount === 0 ? "#77736a" : active ? "#5f7f5f" : "#8f6251");
      upgradeButton.setAlpha(unlocked ? 1 : 0.48);
      upgradeButton.setBackgroundColor(!unlocked ? "#7a7167" : level >= maxRecipeUpgradeLevel ? "#6f6a5f" : this.canAffordRecipeUpgrade(recipe) ? "#b0703d" : "#8f6251");
    });
    this.clampRecipeScroll();
    this.clampIngredientScroll();
    this.buildButtons.forEach(({ furnitureId, button, badge }) => {
      const furniture = getFurnitureDefinition(furnitureId);
      const unlocked = this.isFurnitureUnlocked(furniture);
      const label = unlocked ? `${furniture.name}  $${this.getFurniturePurchaseCost(furniture)}` : `${furniture.name}  tier ${this.getFurnitureLuxuryTier(furniture)}`;
      this.setTextIfChanged(button, label);
      button.setColor(unlocked ? "#3b2a21" : "#70675e");
      button.setAlpha(unlocked ? 1 : 0.62);
      badge.setAlpha(unlocked ? 1 : 0.62);
      button.setBackgroundColor(unlocked ? "#f3dfbd" : "#d7d0c2");
    });
    this.clampBuildScroll();
    const errandOrderIsFull = this.getErrandOrderItemCount() >= maxErrandOrderItems;
    this.ingredientButtons.forEach(({ ingredientId, amount, button }) => {
      const ingredient = this.cooking.getPantry().find((item) => item.id === ingredientId);
      if (!ingredient) {
        return;
      }
      const ordered = this.cooking.getErrandOrder()[ingredient.id] ?? 0;
      const suffix = ordered > 0 && amount === 1 ? ` (${ordered})` : "";
      const label = amount === 1 ? `${this.getIngredientIcon(ingredient.id)} ${this.shortIngredientName(ingredient.name)} +1${suffix}` : `+${amount}`;
      this.setTextIfChanged(button, label);
      button.setBackgroundColor(errandOrderIsFull ? "#8a7a64" : "#8f6251");
    });
  }

  private refreshStaffActionLabels(): void {
    if (!this.hireChefButton) {
      return;
    }

    this.setTextIfChanged(this.hireChefButton, `Hire Chef $${this.getStaffHireCost("chef")}`);
    this.setTextIfChanged(this.fireChefButton, `Fire Chef $${this.getStaffFireCost("chef")}`);
    this.setTextIfChanged(this.hireWaiterButton, `Hire Waiter $${this.getStaffHireCost("waiter")}`);
    this.setTextIfChanged(this.fireWaiterButton, `Fire Waiter $${this.getStaffFireCost("waiter")}`);
    this.setTextIfChanged(this.hireErrandButton, `Hire Errand $${this.getStaffHireCost("errand")}`);
    this.setTextIfChanged(this.fireErrandButton, `Fire Errand $${this.getStaffFireCost("errand")}`);
  }

  private refreshCatalogUiIfReady(): void {
    if (!this.recipeScrollContainer || this.menuButtons.length === 0) {
      return;
    }

    this.refreshCatalogUi();
  }

  private getRecipeMenuLabel(
    recipe: RecipeDefinition,
    unlocked: boolean,
    active: boolean,
    missingIngredients = this.getMissingIngredientsForRecipe(recipe),
  ): string {
    if (!unlocked) {
      return `Locked T${this.getRecipeLuxuryTier(recipe)}: ${recipe.name}`;
    }

    const prefix = active ? "On" : "Off";
    const preparedCount = this.cooking.getPreparedServingCount(recipe.id);
    const price = this.getRecipeSellPrice(recipe);
    if (preparedCount > 0) {
      return `${prefix}: ${recipe.name} $${price} ready x${preparedCount}`;
    }

    if (missingIngredients.length === 0) {
      return `${prefix}: ${recipe.name} $${price}`;
    }

    const missingText = missingIngredients
      .slice(0, 2)
      .map((ingredientId) => this.shortIngredientName(this.getIngredientName(ingredientId)))
      .join(", ");
    return `${prefix}: ${recipe.name} - need ${missingText}`;
  }

  private setTextIfChanged(text: Phaser.GameObjects.Text, value: string): void {
    const currentValue = (text.getData("rawText") as string | undefined) ?? text.text;
    if (currentValue !== value) {
      text.setText(value);
    }
  }

  private formatActionMessage(message: string): string {
    return message.length > 74 ? `${message.slice(0, 71)}...` : message;
  }

  private showToast(message: string, tone: "info" | "success" | "error" = "info"): void {
    this.toastContainer?.destroy(true);

    const width = 470;
    const height = 46;
    const x = mapViewport.x + mapViewport.width / 2 - width / 2;
    const y = 156;
    const container = this.add.container(x, y).setDepth(uiDepth + 500);
    const background = this.add.graphics();
    const fill = tone === "error" ? 0x8f4f43 : tone === "success" ? 0x5f7f5f : 0x715741;
    background.fillStyle(fill, 0.96);
    background.fillRoundedRect(0, 0, width, height, 8);
    background.lineStyle(2, 0xfff4dc, 0.9);
    background.strokeRoundedRect(0, 0, width, height, 8);
    const text = this.add.text(16, 12, message, {
      color: "#fffaf0",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "15px",
      fontStyle: "bold",
    }).setWordWrapWidth(width - 32);
    container.add([background, text]);
    this.toastContainer = container;

    this.tweens.add({
      targets: container,
      alpha: 0,
      delay: 2600,
      duration: 450,
      onComplete: () => {
        if (this.toastContainer === container) {
          this.toastContainer = null;
        }
        container.destroy(true);
      },
    });
  }

  private saveGame(): void {
    this.openSaveModal("save");
  }

  private persistActiveShiftOccasionally(time: number): void {
    if (time - this.lastAutoPersistAt < 30000) {
      return;
    }

    this.lastAutoPersistAt = time;
    this.persistQuietly();
  }

  private persistQuietly(): void {
    if (!this.pendingQuietSave) {
      this.quietSaveDueAt = this.time.now + quietSaveDebounceMs;
    }
    this.pendingQuietSave = true;
  }

  private flushQuietSaveIfDue(time = this.time.now): void {
    if (!this.pendingQuietSave || time < this.quietSaveDueAt) {
      return;
    }

    this.persistImmediately();
  }

  private flushQuietSave(): void {
    if (this.pendingQuietSave) {
      this.persistImmediately();
    }
  }

  private persistImmediately(): void {
    this.pendingQuietSave = false;
    this.quietSaveDueAt = 0;
    const result = this.saveSystem.save(this.createSaveState(), this.currentSaveSlot);
    this.lastSaveBytes = result.bytes;
    this.lastSaveMs = result.durationMs;
  }

  private createSaveState(): SaveGameState {
    return {
      money: this.economy.getMoney(),
      reputation: this.reputation.getReputation(),
      dayNumber: this.dayCycle.getDayNumber(),
      unlockedRecipeIds: this.cooking.getUnlockedRecipeIdsSnapshot(),
      menuRecipeIds: this.cooking.getMenuRecipeIdsSnapshot(),
      recipeUpgradeLevels: this.cooking.getRecipeUpgradeLevelsSnapshot(),
      furniture: this.placement.getFurniture(),
      ingredients: this.cooking.getPantrySnapshot(),
      preparedServings: this.cooking.getPreparedServingsSnapshot(),
      dirtySeatUids: [...this.dirtySeatUids],
      dirtyDishCount: this.dirtyDishCount,
      staff: this.staffSystem.getStaff(),
      adminSettings: this.adminSettings,
      restaurantOpen: this.restaurantOpen,
      autoShopEnabled: this.autoShopEnabled,
      stockTarget: this.stockTarget,
      ratingTotal: this.reputation.getRatingTotal(),
      ratingCount: this.reputation.getRatingCount(),
      ratingHistory: this.reputation.getRatingHistorySnapshot(),
      dailyServed: this.customers.getDailyServed(),
      dailyLost: this.customers.getDailyLost(),
      dailyRevenue: this.economy.getDailyRevenue(),
      dailyExpenses: this.economy.getDailyExpenses(),
      rentElapsedSeconds: this.dayCycle.getRentElapsedSeconds(),
      totalPlaySeconds: this.dayCycle.getTotalPlaySeconds(),
      expansionLevel: this.expansionLevel,
      lastSavedAt: Date.now(),
      staffActors: this.getSavedStaffActors(),
      guests: this.getSavedGuests(),
      tickets: this.getSavedTickets(),
      pavementTrash: this.getSavedPavementTrash(),
      transactionLog: this.economy.getTransactionLogForSave(),
    };
  }

  private getSavedPavementTrash(): SavedPavementTrashState[] {
    return this.pavementTrash.slice(0, maxPavementTrash).map((trash) => ({
      id: trash.id,
      kind: trash.kind,
      t: Number(trash.t.toFixed(4)),
      lane: Math.round(trash.lane),
      droppedAt: trash.droppedAt,
    }));
  }

  private getSavedStaffActors(): SavedStaffActorState[] {
    return (["chef", "waiter", "errand"] as StaffRole[]).flatMap((role) =>
      this.actors
        .filter((actor) => actor.role === role)
        .map((actor, index) => ({
          role,
          index,
          x: Math.round(actor.container.x),
          y: Math.round(actor.container.y),
        })),
    );
  }

  private getSavedGuests(): SavedGuestState[] {
    return this.guests
      .filter((guest): guest is Guest & { state: "waitingToOrder" | "waitingForFood" } =>
        guest.state === "waitingToOrder" || guest.state === "waitingForFood",
      )
      .map((guest) => ({
        id: guest.id,
        chairUid: guest.chairUid,
        seatUid: guest.seatUid,
        orderRecipeIds: guest.orderItems.map((recipe) => recipe.id),
        state: guest.state,
        patience: Math.max(8, Math.round(guest.patience)),
      }));
  }

  private getSavedTickets(): SaveGameState["tickets"] {
    const activeGuestIds = new Set(this.getSavedGuests().map((guest) => guest.id));
    return this.tickets
      .filter((ticket) => activeGuestIds.has(ticket.guestId))
      .map((ticket) => ({
        id: ticket.id,
        guestId: ticket.guestId,
        recipeId: ticket.recipe.id,
        state: ticket.state === "delivered" || ticket.state === "ready" ? ticket.state : ticket.state === "ordering" ? "ordering" : "queued",
        preferredWaiterId: ticket.preferredWaiterId,
      }));
  }

  private getStarterFurniture(): PlacedFurniture[] {
    return [
      { uid: "starter-counter", furnitureId: "service-counter", position: { x: 8, y: 3 } },
      { uid: "starter-stove", furnitureId: "tiny-stove", position: { x: 8, y: 5 } },
      { uid: "starter-table", furnitureId: "round-table", position: { x: 3, y: 5 } },
      { uid: "starter-chair-a", furnitureId: "cafe-chair", position: { x: 3, y: 7 } },
      { uid: "starter-chair-b", furnitureId: "cafe-chair", position: { x: 4, y: 4 } },
      { uid: "starter-plant", furnitureId: "potted-herbs", position: { x: 1, y: 8 } },
      { uid: "starter-board", furnitureId: "menu-board", position: { x: 1, y: 3 } },
    ];
  }



  private shortIngredientName(name: string): string {
    const aliases: Record<string, string> = {
      Vegetables: "Veg",
    };

    return aliases[name] ?? name;
  }

  private getIngredientIcon(ingredientId: string): string {
    const ingredientIcons: Record<string, string> = {
      bread: "\u{1f35e}",
      butter: "\u{1f9c8}",
      stock: "\u{1f963}",
      vegetables: "\u{1f955}",
      herbs: "\u{1f33f}",
      pasta: "\u{1f35d}",
      tomato: "\u{1f345}",
      cheese: "\u{1f9c0}",
      lettuce: "\u{1f96c}",
      oil: "\u{1f4a7}",
      flour: "\u{1f35a}",
      sugar: "\u{1f36c}",
      chicken: "\u{1f357}",
      rice: "\u{1f35a}",
      spices: "\u{1f336}",
      beef: "\u{1f969}",
      potato: "\u{1f954}",
      fish: "\u{1f41f}",
      mushroom: "\u{1f344}",
      egg: "\u{1f95a}",
      berries: "\u{1f353}",
      cocoa: "\u{1f36b}",
      milk: "\u{1f95b}",
      cream: "\u{1f366}",
      apple: "\u{1f34e}",
      lemon: "\u{1f34b}",
      tea: "\u{1f375}",
      coffee: "\u{2615}",
      orange: "\u{1f34a}",
      salt: "\u{1f9c2}",
      lentils: "\u{1f9c6}",
      yogurt: "\u{1f963}",
      honey: "\u{1f36f}",
      mint: "\u{1f33f}",
      turkey: "\u{1f983}",
      pumpkin: "\u{1f383}",
      carrot: "\u{1f955}",
      "sweet-potato": "\u{1f360}",
      salmon: "\u{1f41f}",
      pear: "\u{1f350}",
      matcha: "\u{1f375}",
      "goat-cheese": "\u{1f9c0}",
      shrimp: "\u{1f990}",
      duck: "\u{1f986}",
      corn: "\u{1f33d}",
      pistachio: "\u{1f95c}",
      rose: "\u{1f339}",
      asparagus: "\u{1f966}",
      truffle: "\u{1f344}",
      filet: "\u{1f969}",
      vanilla: "\u{1f366}",
      saffron: "\u{1f33c}",
      caviar: "\u{1f95a}",
    };

    return ingredientIcons[ingredientId] ?? "\u{2022}";

    const textIcons: Record<string, string> = {
      bread: "B",
      butter: "Bt",
      stock: "St",
      vegetables: "Vg",
      herbs: "Hb",
      pasta: "Pa",
      tomato: "To",
      cheese: "Ch",
      lettuce: "Lt",
      oil: "Ol",
      flour: "Fl",
      sugar: "Sg",
      chicken: "Ck",
      rice: "Rc",
      spices: "Sp",
      beef: "Bf",
      potato: "Pt",
      fish: "Fs",
      mushroom: "Mu",
      egg: "Eg",
      berries: "Br",
      cocoa: "Co",
      milk: "Mk",
      cream: "Cr",
      apple: "Ap",
      lemon: "Le",
      tea: "Te",
      coffee: "Cf",
      orange: "Or",
      salt: "Sa",
    };

    return textIcons[ingredientId] ?? "*";

    const icons: Record<string, string> = {
      bread: "🍞",
      butter: "🧈",
      stock: "🥣",
      vegetables: "🥕",
      herbs: "🌿",
      pasta: "🍝",
      tomato: "🍅",
      cheese: "🧀",
    };

    return icons[ingredientId] ?? "•";
  }

  private formatRecipeCategory(category: RecipeDefinition["category"]): string {
    const labels: Record<RecipeDefinition["category"], string> = {
      appetizer: "App",
      main: "Main",
      dessert: "Dessert",
      drink: "Drink",
      side: "Side",
    };

    return labels[category];
  }

  private panelTextStyle(fontSize: number): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      color: graphicsTheme.ink,
      fontSize: `${fontSize}px`,
      fontFamily: "Arial, Helvetica, sans-serif",
    };
  }

  private headingStyle(): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      color: graphicsTheme.ink,
      fontSize: "24px",
      fontStyle: "bold",
      fontFamily: "Arial, Helvetica, sans-serif",
    };
  }

  private sectionTitleStyle(): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      color: graphicsTheme.ink,
      fontSize: "16px",
      fontStyle: "bold",
      fontFamily: "Arial, Helvetica, sans-serif",
    };
  }

  private zoneLabelStyle(): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      color: graphicsTheme.inkSoft,
      fontSize: "16px",
      fontStyle: "bold",
      fontFamily: "Arial, Helvetica, sans-serif",
    };
  }

  private actorBubbleStyle(): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      color: graphicsTheme.bubbleText,
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "14px",
      fontStyle: "bold",
      backgroundColor: graphicsTheme.bubbleFill,
      stroke: graphicsTheme.bubbleStroke,
      strokeThickness: 2,
      padding: { x: 5, y: 2 },
    };
  }
}
