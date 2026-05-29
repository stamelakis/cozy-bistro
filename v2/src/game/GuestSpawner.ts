import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Game } from "./Game";
import type { StaffRouter } from "./StaffRouter";
import type { FloatingText } from "../ui/FloatingText";
import type { SfxPlayer } from "../ui/SfxPlayer";
import type { FurnitureRegistry, ResolvedSeatSlot } from "./FurnitureRegistry";
import { recipes } from "../data/recipes";
import { getFurnitureDef } from "../data/furnitureCatalog";
import type { DishKind } from "../data/dishwareCatalog";
import type { RecipeDefinition } from "../data/types";
import { pick, between, clamp } from "../data/util";
import { type CustomerArchetype, rollArchetype } from "../data/customerArchetypes";
import type { Pathfinding, PathStep } from "./Pathfinding";
import { PATH_ARRIVAL_THRESHOLD } from "./Pathfinding";

/** A dirty plate or glass left on a table by a departed customer. The
 * waiter wash loop claims one by id, walks to its position to "pick it
 * up" (which removes the mesh), then walks to a wash station. The
 * `claimedBy` field prevents two waiters from chasing the same piece. */
interface DirtyTableMesh {
  id: number;
  mesh: THREE.Object3D;
  kind: DishKind;
  /** memberId of the waiter currently walking toward this piece, or
   * null while it's free for any waiter to claim. */
  claimedBy: string | null;
  pos: THREE.Vector2;
  /** Which seat (tableUid#slotIndex) the dirty piece belongs to.
   * spawnLeftoversForGuest reads back the COUNT of existing dirty
   * pieces with the same seatId so a second customer's plates start
   * past the first customer's pile instead of stacking on top. */
  seatId?: string;
}

/** Snapshot of a dirty piece for the wash router. */
export interface DirtyPickupInfo {
  id: number;
  kind: DishKind;
  pos: THREE.Vector2;
}

/** Stable seat identifier: `${tableUid}#${slotIndex}`. Lets a seated guest
 * remember their slot even when other seats are added/removed by player
 * placement edits. */
type SeatId = string;
function makeSeatId(slot: ResolvedSeatSlot): SeatId {
  return `${slot.tableUid}#${slot.slotIndex}`;
}

// ============================================================================
//                              DISH VISUALS
// ============================================================================
// Pluggable builders for the plate and glass meshes we drop on tables.
// Swap these out (or fork per-tier) when nicer art lands without touching
// the seat-slot or wash-trip code. Each builder declares its approximate
// world-space `radius` so the leftover layout below can space pieces by
// the right amount regardless of how big the model gets.
//
// build() must return a mesh whose visible origin lies at (0, tableTop, 0)
// — the spawner translates it into world position. The model can have a
// taller bounding box (glasses do), but its base should rest on y = 0
// of its own frame.
// ============================================================================

interface DishBuilder {
  /** Approximate world-space half-width of the piece, used to space
   * leftovers in the layout pattern below. */
  readonly radius: number;
  /** Builds one mesh. tier is the catalog tier of the inventory piece
   * being represented (1..5). Default builders ignore it; future
   * higher-fidelity builders can vary colour / shape per tier. */
  build(tier: number): THREE.Object3D;
}

/** Default leftover-plate look: cream cylinder with a dark crumb mound
 * in the middle. Replace with a textured Kenney plate (or per-tier
 * meshes) by swapping this binding in DISH_BUILDERS. */
const DEFAULT_PLATE_BUILDER: DishBuilder = {
  radius: 0.16,
  build: (_tier: number): THREE.Object3D => {
    if (!sharedDirtyPlateGeo) {
      sharedDirtyPlateGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.02, 18);
      sharedDirtyPlateMat = new THREE.MeshStandardMaterial({ color: 0xfaf2e2, roughness: 0.4 });
    }
    const plate = new THREE.Mesh(sharedDirtyPlateGeo, sharedDirtyPlateMat!);
    plate.castShadow = true;
    plate.receiveShadow = true;
    const crumbs = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x5a3a1f, roughness: 0.95 }),
    );
    crumbs.position.set(0, 0.025, 0);
    crumbs.scale.set(1.1, 0.25, 1.1);
    plate.add(crumbs);
    return plate;
  },
};

/** Default leftover-glass look: short transparent cylinder with a
 * yellowish puddle at the bottom (the "dregs"). */
const DEFAULT_GLASS_BUILDER: DishBuilder = {
  radius: 0.07,
  build: (_tier: number): THREE.Object3D => {
    const group = new THREE.Group();
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.065, 0.055, 0.14, 12, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xb8d0d8, roughness: 0.15, metalness: 0.05,
        transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      }),
    );
    glass.position.y = 0.07;
    glass.castShadow = true;
    group.add(glass);
    const dregs = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.02, 12),
      new THREE.MeshStandardMaterial({ color: 0xb88a3a, roughness: 0.6 }),
    );
    dregs.position.y = 0.015;
    group.add(dregs);
    return group;
  },
};

/** Lookup table the spawner reads. Swap entries here to change every
 * dirty plate / glass in one place. Future per-tier variants could
 * store an array keyed by tier; for now both kinds use a single
 * design across all tiers. */
const DISH_BUILDERS: Record<DishKind, DishBuilder> = {
  plate: DEFAULT_PLATE_BUILDER,
  glass: DEFAULT_GLASS_BUILDER,
};

/** Shared geometry / material for the default plate builder. Cached
 * outside the function so spawning N plates doesn't reallocate. */
let sharedDirtyPlateGeo: THREE.CylinderGeometry | undefined;
let sharedDirtyPlateMat: THREE.MeshStandardMaterial | undefined;

/** Layout pattern for leftover pieces piling up at a seat.
 *
 * Each entry is an offset in CUSTOMER-LOCAL frame (rightR = +1 means
 * "one piece-radius to the customer's right"; depthR = +1 means "one
 * piece-radius further INTO the table away from the customer"). The
 * spawner multiplies by the dish builder's radius so plates and
 * glasses each get spacing appropriate to their own size.
 *
 * Priority: slot 0 is closest to the customer (their plate). 1–2
 * spread sideways along the table edge; 3–5 push deeper into the
 * table for stack-overflow.
 *
 * Today a single customer orders at most:
 *   • food  → appetizer + main + dessert  = 3 plates
 *   • drink → drink + maybe a second drink = 2 glasses
 * so a single visit fills slots 0..2 at most. The extra slots (3..5)
 * exist so a SECOND customer arriving at the same seat before the
 * waiter has cleared the first pile keeps piling sideways/back
 * instead of stacking on top of the previous plates. */
const LEFTOVER_SLOTS: ReadonlyArray<{ rightR: number; depthR: number }> = [
  { rightR:  0,    depthR: 0    },
  { rightR: -2.1,  depthR: 0    },
  { rightR:  2.1,  depthR: 0    },
  { rightR:  0,    depthR: 2.1  },
  { rightR: -2.1,  depthR: 2.1  },
  { rightR:  2.1,  depthR: 2.1  },
];

/**
 * Drives the visible gameplay loop for guests:
 *   spawn → walk to seat → sit & order → wait for plate → eat → pay & leave.
 *
 * Each guest is a state machine that gets ticked from the main update.
 * Visual animation comes from CharacterAnimator (procedural pseudo-rig).
 *
 * For this first port we keep it simple:
 *   - Fixed door entry point + 8 fixed seats (matches the 2 demo tables)
 *   - Random guest variant per spawn (one of guest-v0..v6)
 *   - Random order picked from the menu
 *   - Cooking happens at the chef station as a timer; "plate" is invisible
 *   - Waiter walking is symbolic (we'll model real waiter pathing later)
 *
 * Numbers (walk speed, eat duration, etc.) are tuned for visibility, not
 * realism. This is meant to look ALIVE during prototyping; balance comes
 * with the gameplay-tuning phase.
 */

type GuestState =
  | "walkingIn"
  /** Walking to an overflow / "yellow" chair while waiting for a real seat. */
  | "walkingToWait"
  /** Sitting at an overflow chair, watching for a real seat to open up. */
  | "waitingForSeat"
  | "seated" | "waitingForFood" | "eating"
  /** Headed for the toilet stand-spot before ordering. */
  | "walkingToToilet"
  /** Standing at the toilet, on the dwell timer. */
  | "atToilet"
  /** Heading to a bathroom sink to wash hands after the toilet. */
  | "walkingToSink"
  /** Standing at the sink on the wash dwell timer. */
  | "atSink"
  /** Walking back to their seat from the toilet (after washing, or
   * straight from the toilet if no sink was available). */
  | "returningFromToilet"
  /** Headed for the interior side of the door before leaving. */
  | "walkingToDoor"
  /** Quick straight hop along the door axis from interior → exterior,
   * so the guest passes through the 1-tile front-wall gap instead of
   * cutting diagonally across a solid wall when nudged off-axis. */
  | "exitingDoor"
  /** Walking off-screen to despawn. */
  | "walkingOut";

interface ActiveGuest {
  id: string;
  variantId: string; // "guest-v0".."guest-v6"
  state: GuestState;
  character: AnimatedCharacter;
  /** True once a walkingIn guest has reached the door INTERIOR — their
   * target then flips to the seat. (Set after passing through the door
   * inward.) */
  passedDoor?: boolean;
  /** True once a walkingIn guest has reached the door EXTERIOR. From
   * there they hop straight through the wall to the interior anchor.
   * Distinct from passedDoor so we can tell "outside on the pavement"
   * from "already through the gap". */
  passedExterior?: boolean;
  /** Stable id of the seat slot this guest is assigned to (or empty if
   * no functional seat was available and they were waitlisted). */
  seatId: SeatId;
  /** Latest cached pose of that seat in world space — refreshed each frame
   * via FurnitureRegistry so the guest follows even if the table is moved. */
  seatPos: THREE.Vector2;
  seatFacingY: number;
  platePos: THREE.Vector2;
  /** If true, the guest entered the restaurant but no functional seat was
   * free, so they're parked at a yellow overflow chair until a real seat
   * opens up. They migrate to a real seat as soon as one becomes free. */
  waiting?: {
    chairUid: string;
    chairPos: THREE.Vector2;
    chairFacingY: number;
    /** Seconds left before they give up and walk out angry. */
    timeLeft: number;
  };
  // Target world position for walking. Reached when we get within
  // arrivalThreshold of it.
  target: THREE.Vector2;
  // Per-state timer (seconds).
  stateClock: number;
  // The list of dishes the guest wants. Multi-course orders deliver one
  // at a time; the guest stays seated until the last is eaten.
  order: RecipeDefinition[];
  // Index of the dish currently being cooked/delivered/eaten.
  orderIndex: number;
  // The ticket id from the StaffRouter (null between courses).
  ticketId: string | null;
  // Seconds remaining before guest gives up and leaves angry. Counts down
  // only while waiting (seated/waitingForFood). Resets between courses.
  patience: number;
  // Cumulative payment they'll leave (accumulates as each course is served).
  totalPaid: number;
  // Cumulative satisfaction across courses; final rating averages this.
  totalSatisfaction: number;
  /** Dishware tier reserved for each course already served / in flight.
   * Parallel to g.order — index N is the tier of the plate (or glass,
   * for drinks) reserved for the Nth course. Used by finalizeVisit to
   * mark the right tier dirty and to add the per-tier satisfaction
   * bump for each plate served. Empty when no course has been reserved
   * yet. */
  reservedDishTiers: number[];
  /** True once settleGuestDishes has run for this guest — every exit
   * path (finalize, patience, table-sold, any other premature despawn)
   * routes through it, but tracks the flag so the second call is a
   * no-op and dishes don't double-count. Without this a table-sold
   * guest's reservations would leak silently — the panel showed
   * dishes "disappearing" as the inventory drifted down. */
  dishesSettled?: boolean;
  // Personality archetype rolled on spawn. Affects patience, order size,
  // and tip multiplier.
  archetype: CustomerArchetype;
  /** Remaining waypoints from the most recent pathfind. Re-planned each
   * time the guest's target changes. */
  path: PathStep[];
  /** Seconds since the last replan. moveToward refreshes the path every
   * ~0.8s while moving so an obstacle placed mid-walk (a fresh wall,
   * table, etc.) gets routed around within a second instead of being
   * walked through to the cached target. */
  replanAccum: number;
  /** Rolled at spawn from the archetype's wcUseChance. Heavy users
   * trigger the bathroom-visit detour after sitting (between seated
   * and ordering); their final rating is significantly shaped by the
   * bathroom quality. Non-users still get a light bonus from having
   * a bathroom available — but they don't actually visit. */
  willUseToilet?: boolean;
  /** Set true after the bathroom visit completes so we don't repeat
   * it between courses. */
  usedToilet?: boolean;
  /** uid of the toilet they reserved while in walkingToToilet /
   * atToilet states. Cleared on visit complete or abandonment. */
  toiletUid?: string;
  /** Rotation (Y) of the reserved toilet. Used so atToilet snaps the
   * guest onto the bowl facing outward (away from the wall) instead of
   * facing wherever the last moveToward call left them looking. */
  toiletRotY?: number;
  /** World position of the reserved toilet's centre (NOT the stand-in-
   * front spot). atToilet snaps the guest here so they actually sit ON
   * the toilet during the dwell. */
  toiletCenter?: THREE.Vector2;
  /** Original seatHeight saved before we lower it for the toilet sit
   * pose. Restored when the guest stands up to walk to the sink / seat
   * so the next "sit" (back at the dining chair) lands at chair height. */
  originalSeatHeight?: number;
  /** uid of the sink they reserved while in walkingToSink / atSink.
   * Cleared after the wash dwell or on despawn. */
  sinkUid?: string;
  /** Rotation (Y) of the reserved sink so atSink can face the guest
   * toward the basin instead of leaving them looking sideways. */
  sinkRotY?: number;
  /** Set true after they successfully wash at a sink. Feeds back into
   * finalizeVisit so the cleanliness of the bathroom also shows up
   * in the rating, not just the toilet step. */
  washedHands?: boolean;
  /** Patience clock (seconds) for waiting for a free toilet. When >0
   * and every toilet is busy they stay seated and retry next tick.
   * On 0 they give up and proceed to ordering — finalizeVisit still
   * applies the "wanted to go" penalty. */
  toiletWaitRemaining?: number;
  /** Set true after the guest either successfully visited the toilet
   * OR gave up waiting. Keeps the seated block from re-entering the
   * "wait for a toilet" beat every tick, while leaving `willUseToilet`
   * untouched so finalizeVisit can still tell that they wanted to go. */
  toiletAttemptComplete?: boolean;
  /** Pre-visit seat pose so they snap back to it after returning. */
  returnSeatPos?: THREE.Vector2;
}

const GUEST_VARIANT_IDS = ["guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6"];

/** Interior anchor of the front door — guests step onto this cell
 * either right after passing through the door from outside, or right
 * before stepping out. */
const DOOR_POSITION = new THREE.Vector2(0, 5);
/** Exterior anchor of the front door, 1 unit outside the wall along
 * the door's +Z normal. Guests always pass through this point as the
 * 2nd waypoint of a 2-step door crossing so the actual movement
 * through the front-wall gap is a STRAIGHT 1-unit line — pathfinding
 * + personal-space can nudge them off the x=0 axis, and without this
 * anchor the corrective diagonal back to the interior cuts through
 * the solid wall next to the door. */
const DOOR_EXTERIOR_POSITION = new THREE.Vector2(0, 6);
/** Outside the building where new arrivals spawn. They first walk to
 * DOOR_EXTERIOR_POSITION, then straight through to DOOR_POSITION, then
 * on to their seat. */
const ENTRY_SPAWN = new THREE.Vector2(0, 8);
/** Off-frame target for departing guests after they've cleared the door.
 * walkingToDoor → DOOR_POSITION → exitingDoor → DOOR_EXTERIOR_POSITION →
 * walkingOut → EXIT_POSITION → despawn. */
const EXIT_POSITION = new THREE.Vector2(0, 10);

/** Fallback table-surface height. The live code path looks up the
 * actual placed-table model's bounding-box top via
 * registry.getTableTopY so dining tables (0.75m), coffee tables
 * (0.42m), and bar counters (0.92m) all get their plates and dirty
 * leftovers sitting ON the actual surface. This constant only kicks
 * in when the registry isn't wired or the table can't be found —
 * picked to match a standard 0.75m dining table plus a sliver of
 * plate thickness. */
const TABLE_HEIGHT_Y = 0.76;

const WALK_SPEED = 1.8; // world units / second
const ARRIVAL_THRESHOLD = 0.15;
const TIME_TO_ORDER = 3.0;
const TIME_TO_EAT = 8.0;
/** Dwell at a toilet (in seconds). Short enough that a busy restaurant
 * can cycle the same fixture among multiple guests, long enough that
 * the trip reads as deliberate when you watch a single guest do it. */
const TIME_AT_TOILET = 6.0;
/** Dwell at a sink (in seconds). Quick handwash beat — the visual is
 * just "stop and stand at the sink" so 3s is enough. */
const TIME_AT_SINK = 3.0;
/** Seat height (Y) the guest drops to while sitting on a toilet.
 * Lower than the dining chair value (0.62) because toilet seats are
 * physically lower; using the chair height would make the guest hover
 * above the bowl. */
const TOILET_SIT_HEIGHT = 0.42;
/** Flip to true (or rebuild after editing) to log every guest's
 * spawn/WC/sink/wash transition. Off in production — the per-tick
 * volume is too high for normal play. */
const DEBUG_GUEST_LOGS = false;
/** How long a WC-needing customer will wait for a busy toilet to free
 * up before giving up. Short on purpose — annoyance reads as a real
 * restaurant queue, not a 30s standoff. */
const WC_PATIENCE_SECONDS = 10.0;
/** Base wait between guest spawns. Was 6s — that meant a half-empty
 * starter restaurant filled up before the player could think. Bumped
 * to 18s so the early-game pace is "a new face every now and then"
 * rather than a constant queue; attractiveness, the boost mode, and
 * the admin spawn-rate slider all multiply this so a well-decorated
 * mid-game bistro still spawns nearly as often as before. */
const SPAWN_INTERVAL_SECONDS = 18.0;
/** Guests give up if not served within this many seconds total. Scaled by
 * the recipe's cook time so slow recipes don't unfairly anger guests. */
const PATIENCE_BASE_SECONDS = 35;

/** Seats stay dirty for this many seconds after a guest leaves before a
 * new guest can sit. Adds a visible turnaround beat between meals. */
const SEAT_CLEAN_SECONDS = 4.0;

/** Per-state guest label for the status-bubble layer. Returns empty
 * string while walking in/out (the bubble layer hides empty labels).
 * Prefixes the archetype emoji so the player can tell who's who, and
 * swaps the meal icons for a drink emoji when the guest is seated at
 * a drink-only table — that way the player can see at a glance which
 * customers are using the lounge / coffee corner. */
function guestLabel(g: ActiveGuest, drinkTable: boolean): string {
  const prefix = g.archetype.shortLabel;
  switch (g.state) {
    case "walkingIn":      return "";
    case "walkingToWait":  return `${prefix} ⏳`;
    case "waitingForSeat": {
      const secs = g.waiting ? Math.max(0, Math.ceil(g.waiting.timeLeft)) : 0;
      return `${prefix} 🪑 ${secs}s`;
    }
    case "seated": {
      const menuIcon = drinkTable ? "📋🥤" : "📋";
      return g.order.length === 0 ? `${prefix} ${menuIcon}` : `${prefix} ⏳`;
    }
    case "waitingForFood": {
      // Show patience countdown so the player feels the urgency.
      const secs = Math.max(0, Math.ceil(g.patience));
      const waitIcon = drinkTable ? "🥤" : "⏳";
      return `${prefix} ${waitIcon} ${secs}s`;
    }
    case "eating":         return `${prefix} ${drinkTable ? "🥤" : "🍴"}`;
    case "walkingToToilet": return `${prefix} 🚻`;
    case "atToilet":        return `${prefix} 🚻`;
    case "walkingToSink":   return `${prefix} 🧼`;
    case "atSink":          return `${prefix} 🧼`;
    case "returningFromToilet": return `${prefix} 🚻`;
    case "walkingToDoor":  return "";
    case "exitingDoor":    return "";
    case "walkingOut":     return "";
  }
}

/** Cheap color hash so different recipes look different on the plate
 * without us shipping per-recipe textures. */
// hashStr removed — the leftover layout no longer needs random jitter
// now that LEFTOVER_SLOTS gives every piece a deterministic spot.

function recipeFoodColor(recipe: RecipeDefinition): number {
  if (recipe.category === "dessert") return 0xe09acb;     // pink
  if (recipe.category === "drink")   return 0x8aa8c4;     // pale blue
  if (recipe.category === "appetizer") return 0xc8d68a;   // green
  if (recipe.category === "side")    return 0xd6b86a;     // yellow
  // mains — vary by recipe id hash so meat/fish/pasta look different
  let h = 0;
  for (let i = 0; i < recipe.id.length; i += 1) h = (h * 31 + recipe.id.charCodeAt(i)) >>> 0;
  const palette = [0xb5694a, 0xc4923a, 0x8a5236, 0xa07042, 0xd6824a];
  return palette[h % palette.length];
}

export class GuestSpawner {
  private readonly scene: THREE.Scene;
  private readonly characterLoader: CharacterLoader;
  private readonly animator: CharacterAnimator;
  private readonly game: Game;
  private readonly router: StaffRouter;
  private readonly guests: ActiveGuest[] = [];
  /** seatId ("tableUid#slotIndex") → reserved. Cleared on guest leave. */
  private occupiedSeats = new Set<SeatId>();
  /** seatId → wall-clock seconds when the seat becomes clean again. */
  private dirtyUntil = new Map<SeatId, number>();
  /** chairUid → guestId that's currently waiting at it. Cleared when the
   * waiting guest either takes a real seat or gives up. */
  private claimedWaitingChairs = new Map<string, string>();
  /** Seats reserved by a spawnGuest that hasn't pushed its guest into
   * this.guests yet (await on character GLB). reconcileOccupancy MUST
   * preserve these, otherwise a second spawnGuest fired during that
   * await would see the seat as free and two guests end up assigned to
   * the same chair. */
  private inFlightSpawnSeats = new Set<SeatId>();
  /** Toilet reservations — one guest per toilet uid. Cleared when the
   * guest returns to their seat or abandons the trip. */
  private reservedToilets = new Set<string>();
  /** Sink reservations — same pattern. Cleared on wash complete /
   * despawn so a fired guest doesn't deadlock the bathroom. */
  private reservedSinks = new Set<string>();
  /** Same protection for overflow-chair reservations during await. */
  private inFlightSpawnChairs = new Set<string>();
  /** guestId → live Object3D for the plate sitting on their table.
   * Spawned when food is delivered, removed when the guest stands up. */
  private readonly tablePlates = new Map<string, THREE.Object3D>();
  /** Shared plate geometry/material so we don't re-allocate per plate. */
  private static plateGeo?: THREE.CylinderGeometry;
  private static plateMat?: THREE.MeshStandardMaterial;
  /** Dirty plates / glasses left on tables after customers walk out.
   * Each carries a stable id used by the waiter wash loop to claim a
   * specific piece, a kind (plate vs glass) that picks the right
   * inventory pool when washed, the world position the waiter walks
   * to, and a `claimed` flag so two waiters can't grab the same
   * plate. Drained by either the waiter wash trip (real flow) or
   * DishwareSystem.onDishWashed (fallback when no waiter / no station,
   * which keeps the inventory in sync visually). */
  private readonly dirtyTableMeshes: Array<DirtyTableMesh> = [];
  private nextDirtyId = 1;
  /** Total elapsed seconds (matches Game.day.getTotalPlaySeconds vibe but
   * we don't need to share it — used only for dirty-seat timing). */
  private elapsed = 0;
  private spawnCooldown = 1.0;
  private nextGuestNum = 0;
  /** Set false to stop new guests from arriving. Already-seated guests
   * finish their meal regardless. */
  restaurantOpen = true;

  /** Optional: if provided, "+$N" / "-1★" labels pop above guests on key events. */
  floatingText?: FloatingText;
  /** Optional: procedural sound cues on guest arrival / serve / leave / etc. */
  sfx?: SfxPlayer;
  /** Optional: registry of placed furniture. When provided, its stats
   * scale spawn rate, satisfaction, and rating. */
  registry?: FurnitureRegistry;
  /** Optional: route around blocking furniture when set. Falls back to a
   * straight line otherwise. */
  pathfind?: Pathfinding;

  constructor(
    scene: THREE.Scene,
    characterLoader: CharacterLoader,
    animator: CharacterAnimator,
    game: Game,
    router: StaffRouter,
  ) {
    this.scene = scene;
    this.characterLoader = characterLoader;
    this.animator = animator;
    this.game = game;
    this.router = router;
  }

  /** Plan a guest's walking path from current pos to current target.
   * Falls back to a direct waypoint when no pathfinder is wired. */
  private planPath(g: ActiveGuest): void {
    if (!this.pathfind) { g.path = [g.target.clone()]; return; }
    g.path = this.pathfind.findPath(
      g.character.groundPos.x, g.character.groundPos.y,
      g.target.x, g.target.y,
    );
    if (g.path.length === 0) g.path = [g.target.clone()];
  }

  /** Per-frame tick. Spawns guests, advances their state machines, moves
   * characters toward their targets. */
  update(dt: number): void {
    this.elapsed += dt;
    this.spawnCooldown -= dt;
    // Expire dirty-seat timers — once a seat's cleanup window is up, it
    // becomes available to the next guest.
    if (this.dirtyUntil.size > 0) {
      for (const [seatId, cleanAt] of this.dirtyUntil) {
        if (cleanAt <= this.elapsed) this.dirtyUntil.delete(seatId);
      }
    }
    // Refresh each seated guest's cached seat pose so they follow if the
    // player moves a table mid-meal. If a seat disappeared entirely (table
    // sold) the guest will walk away on their next tick via missingSeatExit.
    this.refreshSeatedGuestPoses();
    // Walk waiting guests into real seats as those become available.
    this.promoteWaitingGuests();
    if (this.restaurantOpen && this.spawnCooldown <= 0 && (this.countAvailableSeats() > 0 || this.canAcceptWaitingGuest())) {
      void this.spawnGuest();
      // Apply weather multiplier first, then halve if a paid boost is on.
      // Weather values >1 slow spawning (rainy), <1 speed it up (festival).
      const weatherMult = this.game.weather.getCurrent().spawnRateMultiplier;
      const boostMult = this.game.isBoostActive() ? 0.5 : 1;
      // Furniture attractionBonus speeds up spawning (capped so a hoarder
      // with 100 plants doesn't break the game).
      const attraction = this.registry?.getAggregateStats().attractionBonus ?? 0;
      const attractionMult = Math.max(0.45, 1 - Math.min(0.55, attraction * 0.015));
      // AdminPanel spawn-rate multiplier (1 = default).
      const adminMult = this.game.admin.spawnRateMultiplier;
      this.spawnCooldown = SPAWN_INTERVAL_SECONDS * weatherMult * boostMult * attractionMult * adminMult;
    }

    // Tick each guest's state machine.
    for (let i = this.guests.length - 1; i >= 0; i -= 1) {
      const g = this.guests[i];
      this.tickPatience(g, dt);
      this.tickGuest(g, dt);
      // Remove guest if they finished walking out — OR if they've been
      // trying to leave for an absurd amount of time (got stuck in a
      // crowd, target unreachable, etc.). Without this safety, a stuck
      // walker holds their seat in `occupiedSeats` forever and the
      // restaurant slowly seizes up.
      const stuckLeaving =
        (g.state === "walkingOut" || g.state === "walkingToDoor" || g.state === "exitingDoor") && g.stateClock > 30;
      if (stuckLeaving ||
          (g.state === "walkingOut" && this.distanceToTarget(g) < ARRIVAL_THRESHOLD)) {
        this.despawnGuest(i);
      }
    }
    // Garbage-collect any stale occupiedSeats / claimedWaitingChairs
    // entries left behind by a crashed despawn or invalidated state. This
    // is what lets the restaurant recover on its own after long sessions.
    this.reconcileOccupancy();
    this.logSpawnDiagnosticIfDue();
  }

  /** Drop seat-occupancy entries that don't correspond to any live guest,
   * and drop waiting-chair claims with no matching guest. Cheap to run
   * every tick — these sets are tiny. Critically PRESERVES entries that
   * a still-in-flight spawnGuest reserved before its await; otherwise
   * the race window between "mark seat occupied" and "push guest to
   * this.guests" lets reconcile free the seat, and a second spawnGuest
   * grabs the same chair (two customers sitting on top of each other). */
  private reconcileOccupancy(): void {
    if (this.occupiedSeats.size > 0) {
      const live = new Set<SeatId>();
      for (const g of this.guests) if (g.seatId) live.add(g.seatId);
      for (const id of this.occupiedSeats) {
        if (!live.has(id) && !this.inFlightSpawnSeats.has(id)) {
          this.occupiedSeats.delete(id);
        }
      }
    }
    if (this.claimedWaitingChairs.size > 0) {
      const liveChairs = new Set<string>();
      for (const g of this.guests) if (g.waiting) liveChairs.add(g.waiting.chairUid);
      for (const chairUid of this.claimedWaitingChairs.keys()) {
        if (!liveChairs.has(chairUid) && !this.inFlightSpawnChairs.has(chairUid)) {
          this.claimedWaitingChairs.delete(chairUid);
        }
      }
    }
  }

  /** Once every ~10s, dump a single-line summary of the spawn loop so a
   * player who's confused why no customers show up can see the state in
   * DevTools. Cheap (one console.log + a tiny aggregation). */
  private lastSpawnLogElapsed = 0;
  private logSpawnDiagnosticIfDue(): void {
    if (this.elapsed - this.lastSpawnLogElapsed < 10) return;
    this.lastSpawnLogElapsed = this.elapsed;
    if (!this.registry) return;
    const functional = this.listFunctionalSeats().length;
    const avail = this.countAvailableSeats();
    const overflow = this.registry.getOverflowChairs().length;
    const attractiveness = this.game.getAttractiveness();
    const open = this.restaurantOpen ? "open" : "closed";
    console.log(
      `[Spawner] ${open} · ${this.guests.length} guest(s) · ` +
      `functional seats: ${avail}/${functional} avail (${this.occupiedSeats.size} occ, ${this.dirtyUntil.size} dirty) · ` +
      `${overflow} overflow chair(s) · attractiveness ${attractiveness.toFixed(2)} · cooldown ${this.spawnCooldown.toFixed(1)}s`,
    );
  }

  /** Count down patience while the guest is waiting. If it hits zero they
   * give up: record a lost customer, ding the rating, and walk them out.
   *
   * Critically: any plates / glasses they had RESERVED but not yet eaten
   * get returned to the clean pool. Without that step a customer who
   * gave up while waiting for food would permanently consume the
   * reserved piece — over a busy session the dishware inventory would
   * drift downward (and the legacy load path inflated it the other way
   * — that's how the player saw "23 plates without buying"). The
   * plates the customer ALREADY ate before patience ran out still
   * become dirty + show on the table the same as a finalized visit. */
  private tickPatience(g: ActiveGuest, dt: number): void {
    if (g.state !== "seated" && g.state !== "waitingForFood") return;
    g.patience -= dt;
    if (g.patience > 0) return;
    // Patience exhausted — angry exit. Route via the door.
    this.game.customers.recordLost(1);
    this.game.reputation.recordRating(1);
    // Route every reservation through the single chokepoint — eaten
    // courses become dirty, in-flight ones go back to clean.
    this.settleGuestDishes(g);
    if (g.orderIndex > 0) {
      this.removePlateForGuest(g.id);
      this.spawnLeftoversForGuest(g);
    }
    g.character.action = "walk";
    g.target = DOOR_POSITION.clone();
    this.planPath(g);
    g.state = "walkingToDoor";
    g.stateClock = 0;
  }

  /** Reconcile every reservation the guest still holds against the
   * dishware pool. Idempotent — calling twice for the same guest is
   * a no-op via the `dishesSettled` flag, so finalizeVisit /
   * tickPatience / table-sold / despawn safety net can all route
   * through it without double-counting.
   *
   *   - reservations 0..orderIndex-1  → marked dirty (those courses
   *     were eaten and the plates landed on the table)
   *   - reservations orderIndex..end  → returned to clean (in-flight
   *     plates the guest never got to use because they bailed out)
   *
   * Without this any premature exit (table sold under the guest,
   * stuck-leaving despawn, generic "give up") would orphan the clean
   * decrements and the dishware inventory drifted downward over time. */
  private settleGuestDishes(g: ActiveGuest): void {
    if (g.dishesSettled) return;
    g.dishesSettled = true;
    this.dishwareLogger?.(`settleGuestDishes(g${g.id}, state=${g.state}, orderIndex=${g.orderIndex}, reservations=${g.reservedDishTiers.length})`);
    // Eaten courses become dirty.
    for (let i = 0; i < g.orderIndex && i < g.reservedDishTiers.length; i += 1) {
      const recipe = g.order[i];
      if (!recipe) continue;
      const kind: DishKind = recipe.category === "drink" ? "glass" : "plate";
      this.game.dishware.markDirty(kind, g.reservedDishTiers[i]);
    }
    // In-flight (not-yet-eaten) reservations return to the clean pool.
    for (let i = g.orderIndex; i < g.reservedDishTiers.length; i += 1) {
      const recipe = g.order[i];
      if (!recipe) continue;
      const kind: DishKind = recipe.category === "drink" ? "glass" : "plate";
      this.game.dishware.addClean(kind, g.reservedDishTiers[i], 1);
    }
  }

  /** Count plates / glasses currently held by guests as reservations
   * — they're decremented from the clean pool at beginNextCourse but
   * not yet marked dirty (eating) or returned (giving up). Without
   * this number the leak watcher would see a phantom deficit any time
   * a guest is mid-meal: actual = clean + dirty would be < lifetime
   * by exactly the in-flight count. */
  getInFlightDishCount(): number {
    let n = 0;
    for (const g of this.guests) n += g.reservedDishTiers.length;
    return n;
  }

  /** Engine wires a logger here so settleGuestDishes can push context-
   * rich entries into the leak watcher's ring buffer (guest id, state,
   * orderIndex, reservation count) alongside the raw DishwareSystem
   * mutations. Off by default. */
  setDishwareLogger(fn: ((msg: string) => void) | undefined): void {
    this.dishwareLogger = fn;
  }
  private dishwareLogger?: (msg: string) => void;

  getActiveGuestCount(): number {
    return this.guests.length;
  }

  /** Stats snapshot for the live sidebar diagnostic strip. Cheap; safe
   * to call every HUD tick. */
  getSpawnerStats(): {
    customers: number; waiting: number;
    seatsAvail: number; seatsTotal: number;
    overflow: number; spawnInSec: number; open: boolean;
    tables: number; chairs: number; rawSlots: number;
    hasRegistry: boolean;
  } {
    let waiting = 0;
    for (const g of this.guests) if (g.waiting) waiting += 1;
    let tables = 0, chairs = 0, rawSlots = 0;
    if (this.registry) {
      const items = this.registry.snapshotItems();
      for (const it of items) {
        const cat = getFurnitureDef(it.defId)?.category;
        if (cat === "table") tables += 1;
        else if (cat === "chair") chairs += 1;
      }
      rawSlots = this.registry.getResolvedSeatSlots(false).length;
    }
    const total = this.listFunctionalSeats().length;
    return {
      customers: this.guests.length - waiting,
      waiting,
      seatsAvail: this.countAvailableSeats(),
      seatsTotal: total,
      overflow: this.registry?.getOverflowChairs().length ?? 0,
      spawnInSec: Math.max(0, this.spawnCooldown),
      open: this.restaurantOpen,
      tables, chairs, rawSlots,
      hasRegistry: this.registry != null,
    };
  }

  /** Snapshot used by the UI status-bubble layer. Returns one entry per
   * guest with a label + a panic flag so the bubble can flash red.
   * Looks up the seated table's surface so drink-table guests render
   * with the 🥤 icon instead of 🍴 / 📋. */
  snapshotStatus(): { id: string; character: AnimatedCharacter; label: string; panic: boolean }[] {
    return this.guests.map((g) => ({
      id: g.id,
      character: g.character,
      label: guestLabel(g, this.tableSurfaceForGuest(g) === "drink"),
      panic: (g.state === "seated" || g.state === "waitingForFood") && g.patience < 12,
    }));
  }

  /** Snapshot for the PersonalSpace pass. Guests are pinned while seated;
   * walking guests are pushable. */
  snapshotMovable(): { character: AnimatedCharacter; pinned: boolean }[] {
    return this.guests.map((g) => ({
      character: g.character,
      pinned: g.state === "seated" || g.state === "waitingForFood" || g.state === "eating" || g.state === "waitingForSeat" || g.state === "atToilet" || g.state === "atSink",
    }));
  }

  /** All functional seats (table seat slots with a correctly-placed chair)
   * across every visible table. Empty list if no registry yet. */
  private listFunctionalSeats(): ResolvedSeatSlot[] {
    if (!this.registry) return [];
    return this.registry.getResolvedSeatSlots(true).filter((s) => s.chairUid != null);
  }

  /** Count of functional seats not currently occupied + not in the dirty
   * cleanup window. The previous tier-gated SEATS array has been replaced
   * by the actual placed-chair situation. */
  private countAvailableSeats(): number {
    let n = 0;
    for (const s of this.listFunctionalSeats()) {
      const id = makeSeatId(s);
      if (!this.occupiedSeats.has(id) && !this.dirtyUntil.has(id)) n += 1;
    }
    return n;
  }

  /** Refresh each seated guest's cached pose from the registry. If their
   * seat slot has vanished (table sold while they were eating), eject them. */
  private refreshSeatedGuestPoses(): void {
    if (!this.registry) return;
    const byId = new Map<string, ResolvedSeatSlot>();
    for (const s of this.registry.getResolvedSeatSlots()) byId.set(makeSeatId(s), s);
    for (const g of this.guests) {
      const slot = byId.get(g.seatId);
      if (!slot) {
        // Table sold under them. Walk them out gracefully. Reconcile
        // any reserved plates BEFORE the walk so the dishware inventory
        // doesn't silently drift down — eaten courses become dirty,
        // in-flight ones go back to clean.
        if (g.state === "seated" || g.state === "waitingForFood" || g.state === "eating") {
          this.settleGuestDishes(g);
          g.target = DOOR_POSITION.clone();
          this.planPath(g);
          g.state = "walkingToDoor";
          g.character.action = "walk";
          g.stateClock = 0;
        }
        continue;
      }
      g.seatPos.set(slot.x, slot.z);
      g.seatFacingY = slot.facingY;
      g.platePos.set(slot.platePos.x, slot.platePos.z);
      // If the guest is currently on a bathroom side-trip (anywhere
      // between leaving the seat and returning to it), keep the
      // remembered "where to walk back to" target in sync with the
      // moved table. Without this, a table relocated during a 10s WC
      // visit would strand the guest at the table's OLD position.
      if (g.returnSeatPos) {
        g.returnSeatPos.copy(g.seatPos);
      }
      if (g.state === "walkingIn") {
        g.target.copy(g.seatPos);
        // Re-plan whenever the seat moves mid-walk so the guest still
        // routes around obstacles after a table relocation.
        this.planPath(g);
      }
      // If the guest is currently HEADED back to the seat after the
      // bathroom, retarget them too so they don't aim for empty floor.
      if (g.state === "returningFromToilet") {
        g.target.copy(g.seatPos);
        this.planPath(g);
      }
    }
  }

  /** Vibe params for the waiting queue. Scales by Game.getAttractiveness()
   * so a starter bistro has nobody queueing, a decked-out fancy place
   * gets a steady line. */
  private waitingPolicy(): { maxCount: number; maxSeconds: number } {
    const a = this.game.getAttractiveness();
    // Below 1.5 vibe → nobody waits. From 1.5 up, count grows steadily,
    // and willingness-to-wait time scales too.
    const span = Math.max(0, a - 1.5);
    const maxCount = Math.floor(span * 2.5);            // 0 at 1.5, 5 at 3.5, 8 at 4.7
    const maxSeconds = span <= 0 ? 0 : 15 + span * 15;  // 15s at 1.5, 30s at 2.5, 60s at 4.5
    return { maxCount, maxSeconds };
  }

  /** True if at least one yellow chair is free AND attractiveness allows
   * for at least one more waiter beyond what's already queued. */
  private canAcceptWaitingGuest(): boolean {
    const policy = this.waitingPolicy();
    if (policy.maxCount <= 0) return false;
    if (this.guests.filter((g) => g.waiting != null).length >= policy.maxCount) return false;
    return this.findFreeOverflowChair() != null;
  }

  /** First placed toilet not currently reserved by another guest.
   * Returns the uid, the rotY of the toilet (so the guest can face
   * outward when sitting), the toilet's centre (where they snap onto
   * the bowl), and the "stand in front" walk target. Null when either
   * no toilet exists or every one is busy. */
  private findFreeToilet(): {
    uid: string;
    rotY: number;
    center: THREE.Vector2;
    standPos: THREE.Vector2;
  } | null {
    if (!this.registry) return null;
    const toilets = this.registry.getToilets();
    for (const t of toilets) {
      if (this.reservedToilets.has(t.uid)) continue;
      return {
        uid: t.uid,
        rotY: t.rotY,
        center: new THREE.Vector2(t.x, t.z),
        standPos: t.standPos.clone(),
      };
    }
    return null;
  }

  /** First placed bathroom sink not currently reserved. Mirrors
   * findFreeToilet — returns rotY too so atSink can face the guest
   * toward the basin. */
  private findFreeSink(): { uid: string; rotY: number; standPos: THREE.Vector2 } | null {
    if (!this.registry) return null;
    const sinks = this.registry.getBathroomSinks();
    for (const s of sinks) {
      if (this.reservedSinks.has(s.uid)) continue;
      return { uid: s.uid, rotY: s.rotY, standPos: s.standPos.clone() };
    }
    return null;
  }

  /** Pick the first overflow chair not already claimed by another waiter. */
  private findFreeOverflowChair(): { uid: string; x: number; z: number; rotY: number } | null {
    if (!this.registry) return null;
    for (const c of this.registry.getOverflowChairs()) {
      if (!this.claimedWaitingChairs.has(c.uid)) {
        return { uid: c.uid, x: c.x, z: c.z, rotY: c.rotY };
      }
    }
    return null;
  }

  /** Each tick, look for waiting guests whose real seat just became free
   * and route them over. Also expire waiting guests whose timer ran out. */
  private promoteWaitingGuests(): void {
    for (const g of this.guests) {
      if (!g.waiting) continue;
      // Time-out → angry exit.
      if (g.waiting.timeLeft <= 0 && g.state === "waitingForSeat") {
        this.claimedWaitingChairs.delete(g.waiting.chairUid);
        g.waiting = undefined;
        this.game.customers.recordLost(1);
        this.game.reputation.recordRating(1);
        this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, "-1★ (gave up)", "#ff9a9a");
        g.character.action = "walk";
        g.target = DOOR_POSITION.clone();
        this.planPath(g);
        g.state = "walkingToDoor";
        g.stateClock = 0;
        continue;
      }
      // Only promote once the guest is actually parked at the chair.
      if (g.state !== "waitingForSeat") continue;
      const available = this.listFunctionalSeats().find((s) => {
        const id = makeSeatId(s);
        return !this.occupiedSeats.has(id) && !this.dirtyUntil.has(id);
      });
      if (!available) continue;
      // Free their yellow chair, claim the real seat, walk over.
      this.claimedWaitingChairs.delete(g.waiting.chairUid);
      g.waiting = undefined;
      const seatId = makeSeatId(available);
      this.occupiedSeats.add(seatId);
      g.seatId = seatId;
      g.seatPos.set(available.x, available.z);
      g.seatFacingY = available.facingY;
      g.platePos.set(available.platePos.x, available.platePos.z);
      g.target = new THREE.Vector2(available.x, available.z);
      this.planPath(g);
      // Reuse walkingIn for the chair-walk leg. The guest is already
      // inside the building, so mark both door waypoints as passed —
      // walkingIn will skip the door dance and head straight to the
      // seat.
      g.passedExterior = true;
      g.passedDoor = true;
      g.state = "walkingIn"; // reuse the existing walk-to-seat handler
      g.character.action = "walk";
      g.stateClock = 0;
    }
  }

  private async spawnGuest(): Promise<void> {
    // Prefer a real functional seat. If none, fall back to an overflow
    // chair (yellow) when attractiveness allows.
    const available = this.listFunctionalSeats().find((s) => {
      const id = makeSeatId(s);
      return !this.occupiedSeats.has(id) && !this.dirtyUntil.has(id);
    });
    const waitingChair = available ? null : this.findFreeOverflowChair();
    if (!available && !waitingChair) return;
    let seatId: SeatId = "";
    if (available) {
      seatId = makeSeatId(available);
      this.occupiedSeats.add(seatId);
      // Protect against reconcileOccupancy freeing this seat during the
      // upcoming await — the guest isn't in this.guests yet.
      this.inFlightSpawnSeats.add(seatId);
    } else if (waitingChair) {
      this.claimedWaitingChairs.set(waitingChair.uid, "pending");
      this.inFlightSpawnChairs.add(waitingChair.uid);
    }

    const variantId = pick(GUEST_VARIANT_IDS);
    const id = `guest-${this.nextGuestNum++}`;
    try {
      const model = await this.characterLoader.load(variantId);
      this.scene.add(model);
      const character: AnimatedCharacter = {
        root: model,
        // Spawn outside the building; the walkingIn handler will route us
        // via the door before continuing on to the seat.
        groundPos: new THREE.Vector2(ENTRY_SPAWN.x, ENTRY_SPAWN.y),
        facingY: Math.PI, // into the room — reverted to original value
        action: "walk",
        phase: Math.random() * 5,
        // Seat surface height (Kenney chair at S_CHAIR=1.7).
        seatHeight: 0.62,
      };
      this.animator.add(character);

      const archetype = rollArchetype();
      // Loud announcement for a food critic so the player knows to ace it.
      if (archetype.id === "critic") {
        this.floatingText?.pop(DOOR_POSITION.x, DOOR_POSITION.y, "🕵️ FOOD CRITIC!", "#ffd966");
        this.sfx?.alert();
      } else {
        this.sfx?.ding();
      }
      const policy = this.waitingPolicy();
      const seatPos = available
        ? new THREE.Vector2(available.x, available.z)
        : new THREE.Vector2(waitingChair!.x, waitingChair!.z);
      const seatFacing = available ? available.facingY : waitingChair!.rotY;
      const platePos = available
        ? new THREE.Vector2(available.platePos.x, available.platePos.z)
        : seatPos.clone();
      // Initial target is the door EXTERIOR waypoint. walkingIn then
      // advances exterior → interior → seat, so the actual step through
      // the front-wall gap is a straight 1-unit hop. Waiting guests
      // skip the door dance entirely and head straight to their
      // overflow chair (overflow chairs are dining-side by definition).
      const targetPos = available ? DOOR_EXTERIOR_POSITION.clone() : seatPos.clone();
      const guest: ActiveGuest = {
        id,
        variantId,
        state: available ? "walkingIn" : "walkingToWait",
        character,
        seatId,
        seatPos,
        seatFacingY: seatFacing,
        platePos,
        target: targetPos,
        passedDoor: false,
        passedExterior: false,
        stateClock: 0,
        order: [],
        orderIndex: 0,
        ticketId: null,
        patience: PATIENCE_BASE_SECONDS * archetype.patienceMultiplier,
        totalPaid: 0,
        totalSatisfaction: 0,
        archetype,
        path: [],
        replanAccum: 0,
        willUseToilet: Math.random() < archetype.wcUseChance,
        usedToilet: false,
        reservedDishTiers: [],
      };
      if (DEBUG_GUEST_LOGS) {
        console.log(`[Guest ${id}] spawned · archetype=${archetype.id} · willUseToilet=${guest.willUseToilet} (wcChance=${archetype.wcUseChance.toFixed(2)})`);
      }
      this.planPath(guest);
      if (!available && waitingChair) {
        guest.waiting = {
          chairUid: waitingChair.uid,
          chairPos: new THREE.Vector2(waitingChair.x, waitingChair.z),
          chairFacingY: waitingChair.rotY,
          timeLeft: policy.maxSeconds,
        };
        // Re-tag the claim with the real guest id (replacing the "pending" placeholder).
        this.claimedWaitingChairs.set(waitingChair.uid, id);
      }
      this.guests.push(guest);
    } catch (err) {
      console.warn(`Could not spawn ${variantId}:`, err);
      if (seatId) this.occupiedSeats.delete(seatId);
      if (waitingChair) this.claimedWaitingChairs.delete(waitingChair.uid);
    } finally {
      // Whether the spawn succeeded or failed, the await is over — the
      // reconcile pass can safely consider this seat/chair from now on.
      if (seatId) this.inFlightSpawnSeats.delete(seatId);
      if (waitingChair) this.inFlightSpawnChairs.delete(waitingChair.uid);
    }
  }

  private despawnGuest(idx: number): void {
    const g = this.guests[idx];
    // Safety net — if some upstream path forgot to reconcile the
    // reservations (or a future state transition is added without one),
    // this catches them here. settleGuestDishes is idempotent so calling
    // it twice is harmless.
    this.settleGuestDishes(g);
    this.scene.remove(g.character.root);
    this.animator.remove(g.character.root);
    if (g.waiting) {
      // Waiting-overflow guests free their yellow chair, not a real seat.
      this.claimedWaitingChairs.delete(g.waiting.chairUid);
    } else if (g.seatId) {
      this.occupiedSeats.delete(g.seatId);
      // Real seat needs cleanup before the next guest can use it.
      this.dirtyUntil.set(g.seatId, this.elapsed + SEAT_CLEAN_SECONDS);
      this.floatingText?.pop(g.seatPos.x, g.seatPos.y, "🧹 cleaning", "#f0c8a0");
    }
    // Release any toilet / sink reservation they were holding so
    // a guest fired mid-trip doesn't deadlock the bathroom. Also
    // restore the chair-sized seatHeight in case the guest left mid-
    // toilet-sit — harmless on the dead model but keeps the field
    // consistent if anyone introspects it post-despawn.
    if (g.toiletUid) this.reservedToilets.delete(g.toiletUid);
    if (g.sinkUid) this.reservedSinks.delete(g.sinkUid);
    if (g.originalSeatHeight !== undefined) {
      g.character.seatHeight = g.originalSeatHeight;
    }
    // Clear any plate left on their table when they walk out.
    this.removePlateForGuest(g.id);
    this.guests.splice(idx, 1);
  }

  /** Drop a small white plate onto the guest's table-spot. Replaces any
   * previous plate (e.g. between courses) so we don't accumulate. */
  private showPlateForGuest(g: ActiveGuest): void {
    this.removePlateForGuest(g.id);
    if (!GuestSpawner.plateGeo) {
      GuestSpawner.plateGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.02, 18);
      GuestSpawner.plateMat = new THREE.MeshStandardMaterial({ color: 0xfaf2e2, roughness: 0.4 });
    }
    const plate = new THREE.Mesh(GuestSpawner.plateGeo, GuestSpawner.plateMat!);
    plate.position.set(g.platePos.x, this.getTableTopForGuest(g), g.platePos.y);
    plate.castShadow = true;
    plate.receiveShadow = true;
    // Add a small food-color blob on top so it doesn't read as "empty plate".
    const recipe = g.order[g.orderIndex];
    const foodColor = recipe ? recipeFoodColor(recipe) : 0xc28a52;
    const food = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshStandardMaterial({ color: foodColor, roughness: 0.7 }),
    );
    food.position.set(0, 0.05, 0);
    food.scale.y = 0.6; // squash so it reads as a mound, not a ball
    plate.add(food);
    this.scene.add(plate);
    this.tablePlates.set(g.id, plate);
  }

  private removePlateForGuest(guestId: string): void {
    const plate = this.tablePlates.get(guestId);
    if (!plate) return;
    this.scene.remove(plate);
    // Children (the food sphere) are auto-removed with the parent.
    this.tablePlates.delete(guestId);
  }

  /** Spawn one "leftover" mesh per course this guest actually ate.
   * Used by finalizeVisit after the active plate has been cleared so
   * the dirty pieces stay visible on the table until a wash happens.
   * Each piece is positioned at the guest's platePos with a small per-
   * course jitter so multi-course customers leave a clearly-stacked
   * mess instead of one z-fighting blob. */
  private spawnLeftoversForGuest(g: ActiveGuest): void {
    const tableTop = this.getTableTopForGuest(g);
    // Customer-local frame.
    //   facing direction (= direction customer looks, towards table) is
    //   (-sin facingY, -cos facingY). Rotating that 90° CW gives the
    //   customer's right-hand axis: (-cos facingY, sin facingY). Slots
    //   use these so the layout "rotates" with the seat.
    const facingY = g.seatFacingY;
    const depthX = -Math.sin(facingY);
    const depthZ = -Math.cos(facingY);
    const rightX = -Math.cos(facingY);
    const rightZ =  Math.sin(facingY);

    // Skip past dirty pieces that already exist at this seat. That way
    // a second customer arriving at a seat before the waiter has
    // cleared the first customer's pile keeps building OUT instead of
    // dropping their plate on top of the existing one.
    const seatId = g.seatId;
    const startSlot = seatId
      ? this.dirtyTableMeshes.reduce((n, d) => d.seatId === seatId ? n + 1 : n, 0)
      : 0;

    for (let i = 0; i < g.orderIndex && i < g.reservedDishTiers.length; i += 1) {
      const recipe = g.order[i];
      if (!recipe) continue;
      const kind: DishKind = recipe.category === "drink" ? "glass" : "plate";
      const builder = DISH_BUILDERS[kind];
      const slot = LEFTOVER_SLOTS[Math.min(startSlot + i, LEFTOVER_SLOTS.length - 1)];
      const dx = slot.rightR * builder.radius * rightX + slot.depthR * builder.radius * depthX;
      const dz = slot.rightR * builder.radius * rightZ + slot.depthR * builder.radius * depthZ;
      const x = g.platePos.x + dx;
      const z = g.platePos.y + dz;
      const tier = g.reservedDishTiers[i];
      const mesh = builder.build(tier);
      mesh.position.set(x, tableTop, z);
      this.scene.add(mesh);
      this.dirtyTableMeshes.push({
        id: this.nextDirtyId, mesh, kind, claimedBy: null,
        pos: new THREE.Vector2(x, z),
        seatId,
      });
      this.nextDirtyId += 1;
    }
  }

  // === Waiter wash-trip API ===
  //
  // The waiter's wash loop in StaffRouter calls these to discover dirty
  // pieces, claim a specific one, then "pick it up" (mesh removed) once
  // they arrive. Two waiters can't grab the same plate because the
  // claim is tracked per-piece.

  /** Snapshot of every dirty piece currently free for any waiter to
   * claim. Sorted by id (oldest first) so plates clear in the order
   * they appeared. */
  getDirtyPickups(): DirtyPickupInfo[] {
    const out: DirtyPickupInfo[] = [];
    for (const d of this.dirtyTableMeshes) {
      if (d.claimedBy) continue;
      out.push({ id: d.id, kind: d.kind, pos: d.pos.clone() });
    }
    return out;
  }

  /** Try to mark a specific dirty piece as claimed by `memberId`.
   * Returns false if the piece doesn't exist or another waiter already
   * grabbed it — the caller (StaffRouter) then defers and tries again
   * next tick. */
  claimDirtyPickup(id: number, memberId: string): boolean {
    const d = this.dirtyTableMeshes.find((x) => x.id === id);
    if (!d || d.claimedBy) return false;
    d.claimedBy = memberId;
    return true;
  }

  /** Drop a claim without picking up — used when the waiter gets fired
   * mid-trip or the wash station they were heading to disappears. */
  releaseDirtyPickup(id: number): void {
    const d = this.dirtyTableMeshes.find((x) => x.id === id);
    if (d) d.claimedBy = null;
  }

  /** Waiter arrived at the table and "picked up" the plate — remove
   * the mesh from the world and the piece from the dirty list. The
   * waiter still has to walk to the sink before the inventory clean
   * count ticks up (StaffRouter will call dishware.washOne when they
   * finish dwelling at the station). */
  pickupDirty(id: number): DishKind | null {
    const idx = this.dirtyTableMeshes.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const entry = this.dirtyTableMeshes.splice(idx, 1)[0];
    this.scene.remove(entry.mesh);
    return entry.kind;
  }

  /** Build a single dirty piece's visual. Plates get a crumb mound
   * (small darker sphere); glasses get a short transparent cylinder
   * with a slick of leftover liquid. Reuses the shared plate geom for
   * plates so we don't churn through allocations during a busy
   * service. */
  // makeLeftoverMesh has been replaced by the DishBuilder records up
  // top of the file (DEFAULT_PLATE_BUILDER, DEFAULT_GLASS_BUILDER).
  // spawnLeftoversForGuest calls builder.build(tier) directly.

  /** Remove the oldest UNCLAIMED dirty mesh of the matching kind.
   * Used by DishwareSystem.onDishWashed when a wash event happens
   * outside the waiter trip system (e.g. a save/load orphan, or any
   * future "auto-wash via dishwasher" path). The waiter wash trip
   * uses pickupDirty(id) directly instead so it removes the SPECIFIC
   * piece it was sent for. */
  removeOneLeftover(kind: DishKind): void {
    const idx = this.dirtyTableMeshes.findIndex((d) => d.kind === kind && !d.claimedBy);
    if (idx < 0) return;
    const entry = this.dirtyTableMeshes.splice(idx, 1)[0];
    this.scene.remove(entry.mesh);
  }

  private tickGuest(g: ActiveGuest, dt: number): void {
    g.stateClock += dt;

    switch (g.state) {
      case "walkingIn": {
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
          if (!g.passedExterior) {
            // Reached the door exterior — straight hop along the door
            // axis to the interior anchor, threading the 1-tile gap.
            g.passedExterior = true;
            g.target = DOOR_POSITION.clone();
            this.planPath(g);
            g.stateClock = 0;
          } else if (!g.passedDoor) {
            // Now inside the building. Head to the assigned seat.
            g.passedDoor = true;
            g.target = g.seatPos.clone();
            this.planPath(g);
            g.stateClock = 0;
          } else {
            // Reached the seat.
            g.character.groundPos.copy(g.seatPos);
            g.character.facingY = g.seatFacingY;
            g.character.action = "sit";
            g.state = "seated";
            g.stateClock = 0;
          }
        }
        break;
      }
      case "walkingToWait": {
        // Walking to a yellow / overflow chair.
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD && g.waiting) {
          g.character.groundPos.copy(g.waiting.chairPos);
          // Yellow chairs aren't ideally oriented; flip the chair's rotation
          // through the seat-direction relation so the guest faces "outward"
          // from the chair (good enough — they're just waiting).
          g.character.facingY = Math.PI - g.waiting.chairFacingY;
          g.character.action = "sit";
          g.state = "waitingForSeat";
          g.stateClock = 0;
        }
        break;
      }
      case "waitingForSeat": {
        // Just sit and tick down the patience timer. Promotion to a real
        // seat is handled centrally in promoteWaitingGuests().
        if (g.waiting) {
          g.waiting.timeLeft -= dt;
        }
        break;
      }
      case "seated": {
        // First-thing-after-sitting: WC users excuse themselves to
        // the bathroom before ordering. Only triggers ONCE per visit.
        // toiletAttemptComplete latches once we've either gone OR
        // given up waiting — we DON'T clear willUseToilet on give-up
        // because finalizeVisit needs to know they wanted to go.
        if (g.willUseToilet && !g.usedToilet && !g.toiletAttemptComplete) {
          const toilet = this.findFreeToilet();
          // Log once per attempt — the first time we enter this block.
          // toiletWaitRemaining is only set on busy retries, so its
          // undefined state is a clean "first attempt" signal.
          if (DEBUG_GUEST_LOGS && g.toiletWaitRemaining === undefined) {
            const toiletCountTotal = this.registry?.getToilets().length ?? 0;
            const sinkCountTotal = this.registry?.getBathroomSinks().length ?? 0;
            console.log(`[Guest ${g.id}] WC user — toilet search: ${toilet ? `uid=${toilet.uid}` : `null (${toiletCountTotal} toilets placed, ${this.reservedToilets.size} reserved)`} · sinks placed: ${sinkCountTotal}`);
          }
          if (toilet) {
            this.reservedToilets.add(toilet.uid);
            g.toiletUid = toilet.uid;
            g.toiletRotY = toilet.rotY;
            g.toiletCenter = toilet.center;
            g.returnSeatPos = g.seatPos.clone();
            g.target = toilet.standPos.clone();
            this.planPath(g);
            g.character.action = "walk";
            g.state = "walkingToToilet";
            g.stateClock = 0;
            g.toiletWaitRemaining = undefined;
            break;
          }
          // Every toilet busy (or none placed) — start / continue the
          // patience clock and retry next tick. If nothing frees up
          // within WC_PATIENCE_SECONDS they give up; finalizeVisit
          // still applies the "wanted to go but couldn't" penalty.
          if (g.toiletWaitRemaining === undefined) {
            g.toiletWaitRemaining = WC_PATIENCE_SECONDS;
          }
          g.toiletWaitRemaining -= dt;
          if (g.toiletWaitRemaining > 0) {
            // Hold here — don't fall through to the order-building
            // block below.
            break;
          }
          // Time up. Latch attempt-complete (willUseToilet stays true
          // so finalizeVisit can apply the "wanted but couldn't" hit)
          // and let the rest of the seated block run.
          g.toiletAttemptComplete = true;
        }
        // Brief moment to "look at menu" — then build a multi-course
        // order (1-3 dishes typically) and start the first course.
        if (g.stateClock >= TIME_TO_ORDER) {
          if (g.order.length === 0) {
            // First tick past the order timer — build the order. Look
            // up the table's surface so drink-only coffee tables get a
            // drinks-only short order. Falls back to "food" if the
            // seat is somehow detached from a known table.
            const surface = this.tableSurfaceForGuest(g);
            g.order = this.buildOrder(g.archetype, surface);
            if (g.order.length === 0) {
              this.markLostAndExit(g);
              break;
            }
          }
          // Try to start the first course. beginNextCourse returns
          // false when the kitchen is out of clean plates / glasses;
          // we stay in "seated" and retry on the next tick while the
          // guest's patience runs down — that's the "delayed order"
          // UX the player picked. Success transitions to
          // waitingForFood.
          this.beginNextCourse(g);
        }
        break;
      }
      case "walkingToToilet": {
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
          // Snap the guest ONTO the toilet (not just the in-front
          // standing spot) so they look like they're actually using
          // it. Face them outward — i.e. away from the wall the
          // toilet is mounted to — and drop their seatHeight so the
          // sit pose lands on the bowl instead of hovering at chair
          // height. The original seatHeight is preserved so the next
          // "sit" (back at the dining chair) is at the right height.
          if (g.toiletCenter) g.character.groundPos.copy(g.toiletCenter);
          if (g.toiletRotY !== undefined) {
            g.character.facingY = g.toiletRotY + Math.PI;
          }
          if (g.originalSeatHeight === undefined) {
            g.originalSeatHeight = g.character.seatHeight;
          }
          g.character.seatHeight = TOILET_SIT_HEIGHT;
          g.character.action = "sit";
          g.state = "atToilet";
          g.stateClock = 0;
          if (DEBUG_GUEST_LOGS) console.log(`[Guest ${g.id}] arrived at toilet → atToilet (dwell ${TIME_AT_TOILET}s)`);
        }
        break;
      }
      case "atToilet": {
        if (g.stateClock >= TIME_AT_TOILET) {
          // Done with the toilet — release the reservation, then try
          // to chain a handwash at a free sink. If no sink is free,
          // skip straight back to the seat (washedHands stays false
          // so finalizeVisit can dock the rating for it).
          if (g.toiletUid) this.reservedToilets.delete(g.toiletUid);
          g.toiletUid = undefined;
          g.toiletCenter = undefined;
          g.toiletRotY = undefined;
          g.usedToilet = true;
          g.toiletAttemptComplete = true;
          // Restore the chair-sized seatHeight for the rest of the
          // trip — the next "sit" will be back at the dining table.
          if (g.originalSeatHeight !== undefined) {
            g.character.seatHeight = g.originalSeatHeight;
            g.originalSeatHeight = undefined;
          }
          const sink = this.findFreeSink();
          if (DEBUG_GUEST_LOGS) {
            const sinkCountTotal = this.registry?.getBathroomSinks().length ?? 0;
            console.log(`[Guest ${g.id}] left toilet → findFreeSink: ${sink ? `uid=${sink.uid} at (${sink.standPos.x.toFixed(2)}, ${sink.standPos.y.toFixed(2)})` : `null (${sinkCountTotal} placed, ${this.reservedSinks.size} reserved)`}`);
          }
          if (sink) {
            this.reservedSinks.add(sink.uid);
            g.sinkUid = sink.uid;
            g.sinkRotY = sink.rotY;
            g.target = sink.standPos.clone();
            this.planPath(g);
            g.character.action = "walk";
            g.state = "walkingToSink";
            g.stateClock = 0;
          } else {
            g.target = (g.returnSeatPos ?? g.seatPos).clone();
            g.returnSeatPos = undefined;
            this.planPath(g);
            g.character.action = "walk";
            g.state = "returningFromToilet";
            g.stateClock = 0;
          }
        }
        break;
      }
      case "walkingToSink": {
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
          // Snap the guest exactly to the sink stand position and
          // turn them to face the basin. Without the snap, a near-
          // but-not-equal arrival left them ~0.1 units off the sink
          // and PersonalSpace nudges could push them around even
          // before the pin took effect, making the pause invisible.
          g.character.groundPos.copy(g.target);
          if (g.sinkRotY !== undefined) {
            // The sink's standPos sits at +Z relative to the sink (its
            // rotated front face). To look back AT the sink, the guest
            // walks "into" -Z of the sink frame — which the character's
            // GLB-forward-is-(-Z) convention translates to facingY =
            // sink.rotY. (See StaffRouter.moveActor for the same
            // derivation in reverse.)
            g.character.facingY = g.sinkRotY;
          }
          g.character.action = "idle";
          g.state = "atSink";
          g.stateClock = 0;
          this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, "🧼 washing…", "#a8d8f0");
          if (DEBUG_GUEST_LOGS) console.log(`[Guest ${g.id}] arrived at sink → atSink (dwell ${TIME_AT_SINK}s)`);
        }
        break;
      }
      case "atSink": {
        if (g.stateClock >= TIME_AT_SINK) {
          // Wash done — release the sink, flag washedHands so the
          // final rating folds in the cleanliness step, and head
          // back to the seat via the existing return path.
          if (g.sinkUid) this.reservedSinks.delete(g.sinkUid);
          g.sinkUid = undefined;
          g.sinkRotY = undefined;
          g.washedHands = true;
          g.target = (g.returnSeatPos ?? g.seatPos).clone();
          g.returnSeatPos = undefined;
          this.planPath(g);
          g.character.action = "walk";
          g.state = "returningFromToilet";
          g.stateClock = 0;
          if (DEBUG_GUEST_LOGS) console.log(`[Guest ${g.id}] washed hands → returning to seat`);
        }
        break;
      }
      case "returningFromToilet": {
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
          // Snap back into the seat and resume the "considering the
          // menu" beat.
          g.character.groundPos.copy(g.seatPos);
          g.character.facingY = g.seatFacingY;
          g.character.action = "sit";
          g.state = "seated";
          g.stateClock = 0;
        }
        break;
      }
      case "waitingForFood": {
        // Wait until the waiter delivers the current course's plate.
        if (this.router.popDeliveredFor(g.id)) {
          g.state = "eating";
          g.stateClock = 0;
          this.showPlateForGuest(g);
          this.sfx?.chime();
        }
        break;
      }
      case "eating": {
        if (g.stateClock >= TIME_TO_EAT) {
          // Finished THIS course. Record payment + satisfaction, clear plate.
          this.creditCourse(g);
          this.removePlateForGuest(g.id);
          g.orderIndex += 1;
          if (g.orderIndex < g.order.length) {
            // Move to next course — go back to seated for a moment
            // (the guest considers what they ordered next, then waits).
            g.patience = PATIENCE_BASE_SECONDS * g.archetype.patienceMultiplier;
            this.beginNextCourse(g);
          } else {
            // Full order complete — leave a single averaged rating + walk out via the door.
            this.finalizeVisit(g);
            g.character.action = "walk";
            g.target = DOOR_POSITION.clone();
            this.planPath(g);
            g.state = "walkingToDoor";
            g.stateClock = 0;
          }
        }
        break;
      }
      case "walkingToDoor": {
        // First leg of leaving — walk to the INTERIOR side of the door
        // from wherever the seat was. Pathfinding handles routing past
        // furniture; the line into the door anchor stays inside.
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
          // Now thread the actual gap with a straight 1-unit hop to
          // the exterior anchor. Same trick as the errand helper.
          g.target = DOOR_EXTERIOR_POSITION.clone();
          this.planPath(g);
          g.state = "exitingDoor";
          g.stateClock = 0;
        }
        break;
      }
      case "exitingDoor": {
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
          // Through the gap. Now walk off-screen.
          g.target = EXIT_POSITION.clone();
          this.planPath(g);
          g.state = "walkingOut";
          g.stateClock = 0;
        }
        break;
      }
      case "walkingOut": {
        this.moveToward(g, dt);
        break;
      }
    }
  }

  private moveToward(g: ActiveGuest, dt: number): void {
    const pos = g.character.groundPos;
    // Defensive: plan a path on the fly if nothing's queued and we
    // still have ground to cover. Normally planPath() has run at the
    // state transition that set this target.
    if (g.path.length === 0 && this.distanceToTarget(g) >= ARRIVAL_THRESHOLD) {
      this.planPath(g);
    }
    // Periodic replan — same idea as StaffRouter.moveActor. The state
    // machine plans a path once per transition; if the player places a
    // chair or wall in the middle of the planned route, the cached
    // waypoints take the guest straight through it. Refreshing every
    // ~0.8s while in motion picks up the new obstacle within a second.
    g.replanAccum += dt;
    if (g.replanAccum >= 0.8 && this.distanceToTarget(g) >= ARRIVAL_THRESHOLD) {
      g.replanAccum = 0;
      this.planPath(g);
    }
    // Consume waypoints we're already within range of.
    while (g.path.length > 0 && Math.hypot(g.path[0].x - pos.x, g.path[0].y - pos.y) < PATH_ARRIVAL_THRESHOLD) {
      g.path.shift();
    }
    const wp = g.path[0] ?? g.target;
    const dx = wp.x - pos.x;
    const dz = wp.y - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return;
    const step = Math.min(dist, WALK_SPEED * dt);
    pos.x += (dx / dist) * step;
    pos.y += (dz / dist) * step;
    // GLB forward = -Z (three.js standard) → atan2(-dx, -dz). See
    // StaffRouter.moveActor for the derivation.
    g.character.facingY = Math.atan2(-dx, -dz);
    g.character.action = "walk";
  }

  private distanceToTarget(g: ActiveGuest): number {
    return Math.hypot(g.target.x - g.character.groundPos.x, g.target.y - g.character.groundPos.y);
  }

  /** Pick a multi-course order (1-3 dishes) based on the guest's category
   * expectation. Tries to include an appetizer + main + dessert pattern when
   * possible; falls back to whatever's on menu. The archetype's orderSizeBias
   * shifts appetizer/dessert chances up (foodies, dates) or down (quick lunch).
   *
   * `surface` controls the menu shape:
   *   - "food" (default): the classic appetizer + main + dessert run.
   *   - "drink": 1-2 drinks, no kitchen courses. Coffee tables seat
   *     guests for a quick beverage with much faster turnover. */
  private buildOrder(archetype: CustomerArchetype, surface: "food" | "drink" = "food"): RecipeDefinition[] {
    const menu = this.game.cooking.getMenuRecipeIds();
    const onMenu = menu.length > 0
      ? menu.map((id) => recipes.find((r) => r.id === id)).filter((r): r is RecipeDefinition => !!r)
      : recipes.filter((r) => r.unlockedByDefault);
    if (onMenu.length === 0) return [];

    if (surface === "drink") {
      // Drink-only short order: 1 guaranteed drink, with a small chance
      // of a second one (foodies / dates get an extra). No kitchen
      // course, no dessert — those go on food tables.
      const drinks = onMenu.filter((r) => r.category === "drink");
      if (drinks.length === 0) {
        // No drinks on the menu yet — drink table can't serve anyone.
        // Returning empty marks the guest as lost (markLostAndExit
        // handles the rating ding), which is the right signal: the
        // player needs at least one drink recipe enabled.
        return [];
      }
      const order: RecipeDefinition[] = [drinks[between(0, drinks.length - 1)]];
      const secondChance = 0.25 + archetype.orderSizeBias * 0.2;
      if (Math.random() < secondChance) {
        order.push(drinks[between(0, drinks.length - 1)]);
      }
      return order;
    }

    const expectation = this.game.customers.rollCustomerExpectation();
    const order: RecipeDefinition[] = [];
    // Bias-shifted appetizer chance: 0.4 for -1, 0.6 for 0, 0.8 for +1.
    const appChance = 0.6 + archetype.orderSizeBias * 0.2;
    if (Math.random() < appChance) {
      const apps = onMenu.filter((r) => r.category === "appetizer");
      if (apps.length > 0) order.push(apps[between(0, apps.length - 1)]);
    }
    // Always try for a main matching expectation (fallback: any main, then any).
    const matching = onMenu.filter((r) => r.category === expectation.category);
    const mains = matching.length > 0 ? matching : onMenu.filter((r) => r.category === "main");
    const mainPool = mains.length > 0 ? mains : onMenu;
    order.push(mainPool[between(0, mainPool.length - 1)]);
    // Dessert chance: 0.15 for -1, 0.35 for 0, 0.55 for +1.
    const dessertChance = 0.35 + archetype.orderSizeBias * 0.2;
    if (Math.random() < dessertChance) {
      const desserts = onMenu.filter((r) => r.category === "dessert");
      if (desserts.length > 0) order.push(desserts[between(0, desserts.length - 1)]);
    }
    return order;
  }

  /** Look up the surface (food vs drink) of the table this guest is
   * seated at. `g.seatId` is "tableUid#slotIndex"; the table uid is
   * everything before the #. Defaults to "food" when we can't resolve
   * (guest at an overflow chair, save-load races, etc.). */
  private tableSurfaceForGuest(g: ActiveGuest): "food" | "drink" {
    if (!this.registry || !g.seatId) return "food";
    const hashIdx = g.seatId.indexOf("#");
    if (hashIdx < 0) return "food";
    const tableUid = g.seatId.substring(0, hashIdx);
    return this.registry.getTableSurface(tableUid) ?? "food";
  }

  /** World-Y to land a plate / glass / leftover at on the guest's
   * table. Looks up the actual placed table model so dining tables
   * (0.75m), coffee tables (0.42m), bar counters (0.92m) all get
   * their dishes resting on the actual top instead of at a single
   * hard-coded height. Falls back to the legacy 0.76m if the table
   * can't be found (rare — guest is either offscreen or the slot
   * was deleted out from under them). */
  private getTableTopForGuest(g: ActiveGuest): number {
    if (this.registry && g.seatId) {
      const hashIdx = g.seatId.indexOf("#");
      if (hashIdx >= 0) {
        const tableUid = g.seatId.substring(0, hashIdx);
        const top = this.registry.getTableTopY(tableUid);
        if (top !== null) return top;
      }
    }
    return TABLE_HEIGHT_Y;
  }

  /** Kick off the (next) course: reserve a clean plate / glass,
   * consume ingredients, queue a ticket.
   *
   * Returns true when the course was successfully started, false when
   * something blocked it (pantry empty OR no clean dishware). On a
   * `false` return the guest's state is left as-is so the seated /
   * eating handler can retry on the next tick while the patience timer
   * keeps ticking — that's the "delayed order" UX the player picked
   * for the out-of-plates case. */
  private beginNextCourse(g: ActiveGuest): boolean {
    const recipe = g.order[g.orderIndex];
    if (!this.game.cooking.canFulfillRecipe(recipe)) {
      // Pantry ran out mid-meal — just shorten the order so the guest
      // pays for what they got and leaves rather than dragging on.
      g.order = g.order.slice(0, g.orderIndex);
      if (g.orderIndex === 0) {
        this.markLostAndExit(g);
      } else {
        this.finalizeVisit(g);
        g.character.action = "walk";
        g.target = DOOR_POSITION.clone();
        this.planPath(g);
        g.state = "walkingToDoor";
        g.stateClock = 0;
      }
      return false;
    }
    // Reserve a clean plate (or glass, for drink courses) before we
    // burn ingredients on a meal we can't actually serve. If nothing
    // clean is on the shelf, the order has to wait until the waiter
    // washes one — the guest stays in seated / eating with patience
    // ticking and we'll retry on the next tick. The recipe's category
    // picks plate vs glass; "drink" is the only glass case in v1.
    const kind: "plate" | "glass" = recipe.category === "drink" ? "glass" : "plate";
    const reservedTier = this.game.dishware.reserveOne(kind);
    if (reservedTier === null) {
      return false;
    }
    g.reservedDishTiers.push(reservedTier);
    this.game.cooking.consumeIngredients(recipe);
    // Enqueue with the BASE cook-seconds. The actual chef applies
    // their own training multiplier on pickup (StaffRouter does
    // that), so the timer reflects which specific chef takes the
    // ticket. The recipe's first required appliance steers the
    // chef to the right cook station (toaster vs stove vs coffee
    // machine etc.). Phase C lets multi-appliance recipes exist
    // but for now we only consume the head of the list — that's
    // enough since no current recipe declares more than one.
    const apps = this.game.cooking.getRecipeAppliances(recipe);
    const primaryAppliance = apps[0] ?? recipe.stationNeeded ?? "stove";
    g.ticketId = this.router.enqueueOrder(
      g.id, recipe.id, g.seatPos, this.game.getBaseCookSeconds(recipe),
      primaryAppliance,
    );
    g.state = "waitingForFood";
    g.stateClock = 0;
    return true;
  }


  /** Guest gives up (ran out of patience OR couldn't be served) — record
   * the loss + dock the rating, then walk them out. Reconciles any
   * reservations they were holding so the dishware inventory stays
   * balanced even when the give-up happens mid-course (e.g. pantry
   * runs out at orderIndex>0 followed by a fresh failure). */
  private markLostAndExit(g: ActiveGuest): void {
    this.game.customers.recordLost(1);
    this.game.reputation.recordRating(1);
    this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, "-1★", "#ff9a9a");
    this.sfx?.thud();
    this.settleGuestDishes(g);
    g.character.action = "walk";
    g.target = DOOR_POSITION.clone();
    this.planPath(g);
    g.state = "walkingToDoor";
    g.stateClock = 0;
  }

  /** Bank money + satisfaction for a single completed course. */
  private creditCourse(g: ActiveGuest): void {
    const recipe = g.order[g.orderIndex];
    if (!recipe) return;
    // Use upgrade-aware effective values (level 1 = base, +30%/+1.5 per level).
    const price = this.game.getEffectiveSellPrice(recipe);
    const satisfaction = this.game.getEffectiveSatisfaction(recipe);
    this.game.economy.earnMoney(price, "payment");
    g.totalPaid += price;
    g.totalSatisfaction += satisfaction;
    // Floating "+$N" above the guest.
    this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, `+$${price}`, "#a8e2a8");
    this.sfx?.chaching();
  }

  /** End-of-visit: record one served + one averaged rating across courses.
   *
   * Also pays out a tip scaled to satisfaction (0% at 1★, up to 30% at 5★)
   * and pops two floating labels above the guest: the star rating they left
   * and the tip amount. These are the player's main "I made someone happy"
   * feedback signal, so we want them very visible.
   */
  private finalizeVisit(g: ActiveGuest): void {
    this.game.customers.recordServed(1);
    // Plate / glass quality lifts the per-course satisfaction average:
    // each tier of dishware actually served adds its catalog
    // satisfactionPerPiece on top of the recipe's own value. T1 adds
    // nothing; T5 plates add ~+2 satisfaction per course.
    let dishSatBonus = 0;
    for (let i = 0; i < g.reservedDishTiers.length; i += 1) {
      const tier = g.reservedDishTiers[i];
      const recipe = g.order[i];
      if (!recipe) continue;
      const kind: "plate" | "glass" = recipe.category === "drink" ? "glass" : "plate";
      dishSatBonus += this.game.dishware.satisfactionFor(kind, tier);
    }
    const adjustedSatisfaction = g.totalSatisfaction + dishSatBonus;
    const avgSat = g.order.length > 0 ? adjustedSatisfaction / g.order.length : 4;
    let base = clamp(2 + avgSat / 2, 1, 5);
    // Penalty for a visibly dirty restaurant — drops the base rating by
    // 1 star so even an otherwise-good meal can drift to 3 stars.
    if (this.game.isDishPileOverwhelming()) {
      base = Math.max(1, base - 1);
    }
    // Furniture stats bump the rating. style + comfort/2 are summed into
    // a "vibe" score (capped at +1.0 star equivalent), plus direct
    // ratingBonus from prestige pieces (Linen Table, Designer Sofa).
    const stats = this.registry?.getAggregateStats();
    if (stats) {
      const vibe = (stats.style + stats.comfort * 0.5) * 0.012;
      base = clamp(base + Math.min(1.0, vibe) + stats.ratingBonus, 1, 5);
    }
    // Bathroom adjustment. WC users care strongly: their final rating
    // can swing meaningfully based on toilet quality + handwash. Non-
    // users still pick up a light bonus from a nice bathroom (the door
    // is visible from the floor) capped at ~+0.25.
    const bathroom = this.registry?.getBathroomScore() ?? { toiletCount: 0, sinkCount: 0, quality: 0 };
    // Normalize quality on roughly 0..18: a basic toilet+sink scores
    // ~4, a luxe bathroom (mirror + bathtub + shower-round + cabinet
    // + designer toilet) tops ~18+.
    const qNorm = Math.min(1, bathroom.quality / 18);
    let toiletDelta = 0;
    if (g.willUseToilet || g.usedToilet) {
      if (bathroom.toiletCount === 0) {
        // Wanted to go and there wasn't one — significant negative.
        toiletDelta = -0.8;
      } else if (!g.usedToilet) {
        // Wanted to go, but every toilet was busy long enough that
        // they gave up — moderate negative.
        toiletDelta = -0.35;
      } else {
        // Actually used it. Quality drives a -0.2..+0.6 swing,
        // handwash modifies on top:
        //   washed         → +0.15 (clean place vibe)
        //   no sink at all → -0.25 (player didn't provide)
        //   sink busy      → 0     (bad luck, not the venue's fault)
        let delta = -0.2 + qNorm * 0.8;
        if (g.washedHands) delta += 0.15;
        else if (bathroom.sinkCount === 0) delta -= 0.25;
        toiletDelta = delta;
      }
    } else if (bathroom.toiletCount > 0) {
      // Didn't visit, but a tidy bathroom is still part of the
      // overall impression. Light bonus; bumped slightly if the
      // bathroom is fully equipped (toilet + sink).
      toiletDelta = qNorm * 0.2;
      if (bathroom.sinkCount > 0) toiletDelta += 0.05;
    }
    base = clamp(base + toiletDelta, 1, 5);
    // Smoke penalty: a placed stove without a Range Hood above it
    // smokes up the dining room. The player needs one hood per stove
    // (matches real-life fire code, and keeps the math obvious). The
    // total penalty is capped at -0.5 stars so a player with a 6-stove
    // line and no hoods doesn't get rated to oblivion in one visit —
    // they'll still notice fast and build one.
    if (this.registry) {
      const stoveCount = this.registry.countById("stove") + this.registry.countById("stove-electric");
      const hoodCount = this.registry.countById("kitchen-hood") + this.registry.countById("kitchen-hood-l");
      const unhoodedStoves = Math.max(0, stoveCount - hoodCount);
      if (unhoodedStoves > 0) {
        const smokeDelta = Math.min(0.5, unhoodedStoves * 0.1);
        base = clamp(base - smokeDelta, 1, 5);
      }
    }
    const jitter = (Math.random() - 0.5) * 0.8;
    const rating = clamp(Math.round(base + jitter), 1, 5);
    // Single chokepoint — finalizeVisit only fires when every course
    // landed, so settleGuestDishes' "eaten" path covers them all and
    // the "in-flight" path is a no-op.
    this.settleGuestDishes(g);
    // The live "eating" plate is about to be subsumed by the leftover
    // meshes (which include the last course too). Clear it before we
    // spawn the leftovers so we don't draw both on top of each other.
    this.removePlateForGuest(g.id);
    this.spawnLeftoversForGuest(g);
    // Food critics swing the rating average harder. Record their rating
    // three times — same direction, triple weight on overall reputation.
    const ratingsToRecord = g.archetype.id === "critic" ? 3 : 1;
    for (let i = 0; i < ratingsToRecord; i += 1) {
      this.game.reputation.recordRating(rating);
    }

    // Tip: 0% at 1-2 stars, 5% at 3, 15% at 4, 30% at 5. Round to whole dollars.
    // Modifiers: archetype (generous +50% / grumpy -60%) and weather
    // (festival + cold snap make people tip a bit more).
    const tipMultByRating: Record<number, number> = { 1: 0, 2: 0, 3: 0.05, 4: 0.15, 5: 0.30 };
    const baseTipRate = tipMultByRating[rating] ?? 0;
    const weatherMult = this.game.weather.getCurrent().tipMultiplier;
    const tip = Math.round(g.totalPaid * baseTipRate * g.archetype.tipMultiplier * weatherMult);
    if (tip > 0) {
      this.game.economy.earnMoney(tip, "payment");
    }

    // Visible feedback: a star rating floats up above their seat as they leave.
    const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
    const ratingColor = rating >= 4 ? "#ffd966" : rating === 3 ? "#fff5dc" : "#ff9a9a";
    this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, stars, ratingColor);
    if (tip > 0) {
      // Stagger the tip label so it doesn't overlap the stars.
      setTimeout(() => {
        this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, `tip +$${tip}`, "#a8e2a8");
      }, 600);
    }
  }
}
