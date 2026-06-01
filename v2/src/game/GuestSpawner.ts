import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Game } from "./Game";
import type { StaffRouter } from "./StaffRouter";
import { isServerSim } from "./featureFlags";
import type { FloatingText } from "../ui/FloatingText";
import type { SfxPlayer } from "../ui/SfxPlayer";
import type { FurnitureRegistry, ResolvedSeatSlot } from "./FurnitureRegistry";
import { recipes } from "../data/recipes";
import { getFurnitureDef } from "../data/furnitureCatalog";
import type { DishKind } from "../data/dishwareCatalog";
import type { RecipeDefinition } from "../data/types";
import { pick, between, clamp } from "../data/util";
import { type CustomerArchetype, type CustomerTaste, type DietKind, rollArchetype, rollCustomerTaste } from "../data/customerArchetypes";
import { RESTAURANT_THEMES } from "../data/themes";
import type { Pathfinding, MultiFloorPathStep } from "./Pathfinding";
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
  /** Storey the dirty piece sits on (= the seat's floor). Wash trips
   * route through the stairs when the waiter's currentFloor doesn't
   * match this — without the floor, a Floor 0 waiter would walk to
   * the Floor 1 dirty XZ on Floor 0 and pretend to pick it up. */
  floor: number;
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
  floor: number;
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
  /** Storey the seat is on (0 = ground). Phase 8 lifts the guest's
   * world Y by floor × storey height when they sit so they appear on
   * the right slab even before the stair-climbing path lands. */
  seatFloor: number;
  /** True when the guest is seated AT a bar counter (vs. a regular
   * dining or coffee table). Routes their order request to the
   * barman pool instead of the waiter pool, and the cooked drink
   * gets delivered directly by the barman without a waiter trip. */
  seatAtBar?: boolean;
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
  /** Full taste profile rolled at spawn (see CustomerTaste in
   * data/customerArchetypes.ts). Drives seat scoring, order bias,
   * and satisfaction bonuses. Diet (food/drink/both) is the hard
   * filter; the rest are scoring inputs. Replaces the old
   * wantsDrinks single-axis field. */
  taste: CustomerTaste;
  /** Remaining waypoints from the most recent pathfind. Re-planned each
   * time the guest's target changes. Each step carries its floor so
   * the mover can drive the smooth Y ride across stair transitions
   * (`fromStair: true` flags the step where the actor lands on the
   * new floor after walking the stair). */
  path: MultiFloorPathStep[];
  /** Storey the guest's body is currently rendered on. Starts at 0
   * (they spawn outside, walk through the ground-floor door), updates
   * to wp.floor whenever the mover consumes a `fromStair`-flagged
   * waypoint. Used to anchor the character's Y when not actively
   * crossing a stair span. */
  currentFloor: number;
  /** Last waypoint the mover consumed — needed when interpolating the
   * Y across a stair segment so we know where the climb started. */
  prevWaypoint?: MultiFloorPathStep;
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
  /** Storey the reserved toilet lives on. Drives pickPathTargetFloor
   * for the walkingToToilet leg so a Floor 0 guest assigned a Floor 1
   * toilet actually takes the stair instead of pretending to walk
   * through the slab. Cleared alongside toiletUid. */
  toiletFloor?: number;
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
  /** Storey the reserved sink lives on. Same purpose as toiletFloor —
   * lets a cross-floor handwash trip pick up the stair leg. */
  sinkFloor?: number;
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
  /** Pre-meal handwash flag. Distinct from willUseToilet — a wash-only
   * guest goes straight to the bathroom sink (no toilet leg) before
   * ordering. If no sink exists or every one is busy long enough to
   * give up, finalizeVisit applies a "wanted to wash but couldn't"
   * penalty. Rolled at spawn alongside willUseToilet, mutually
   * exclusive (toilet users wash AFTER the toilet, no separate trip). */
  willWashOnly?: boolean;
  /** Patience clock for waiting for a free sink during a wash-only
   * trip. Same shape as toiletWaitRemaining. */
  washWaitRemaining?: number;
  /** Latches once the wash-only attempt has resolved one way or the
   * other (washed, or gave up waiting). Stops the seated block
   * re-entering the wash beat. */
  washAttemptComplete?: boolean;
  /** Pre-visit seat pose so they snap back to it after returning. */
  returnSeatPos?: THREE.Vector2;
  /** True once the spawner has pushed an order request into
   * StaffRouter.orderRequests for this guest. Stops the seated block
   * from re-enqueueing every tick. Cleared (by virtue of being a
   * one-shot flag) when the request fires its callback OR is
   * cancelled by cancelOrderRequest. */
  orderRequested?: boolean;
  /** True once a waiter has completed the take-order dwell and the
   * spawner's takeOrder callback has built g.order. Drives the
   * transition into beginNextCourse — without this latch the seated
   * block would try to build the order on its own timer fallback. */
  orderTaken?: boolean;
  /** Phase B.3b — server-side mirror id, once resolved. Populated by
   * mirrorGuestSpawn after a short delay (the spawn_guest reducer
   * round-trip is ~50-150 ms; the helper polls
   * findActiveGuestIdByClientTempId until the row appears). Null
   * until the cloud row materialises; mirror-leave skips when still
   * null (the cloud row's patience countdown will despawn it on its
   * own). */
  serverMirrorId?: bigint;
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
 * on to their seat.
 *
 * The X coordinate is randomised at spawn time within
 * ENTRY_SPAWN_X_RANGE so guests appear up the street and walk along
 * the pavement before peeling off to the door — instead of popping
 * into existence at the doorstep. The Z is fixed at 8 (the south
 * pavement strip, between the building and the asphalt road). */
const ENTRY_SPAWN = new THREE.Vector2(0, 8);
/** Half-range of the X jitter for the entry spawn (so guests appear
 * anywhere from x = -ENTRY_SPAWN_X_RANGE to +ENTRY_SPAWN_X_RANGE on
 * the pavement). Wide enough to overlap the city's pedestrian flow
 * so the player reads each customer as "that pedestrian peeled off
 * the sidewalk and headed for my door" rather than spawning at the
 * doorstep. 60 m ≈ half the visible street length. */
const ENTRY_SPAWN_X_RANGE = 60;
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
// 60s per course. Gives every meal a real "sit and chew" presence —
// the dining room reads as occupied instead of churning. Patience
// resets between courses so the longer eating beat costs the player
// nothing in customer anger; it just slows seat turnover (and grows
// average concurrent customer count proportionally for the same
// spawn rate).
const TIME_TO_EAT = 60.0;
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
// 5.5 s (was 6.67) — extra +20% bump on top of the previous one to
// compensate for the new STRICT diet filter. Drink-only customers
// now refuse food seats (and vice versa); if you've only built
// food tables, every drink-only roll is a missed spawn. The extra
// throughput gives the player a reasonable customer flow even with
// a single-surface restaurant. A well-balanced bar + dining setup
// will see fewer rejections and so handle the full bumped rate.
// Math: 5.5 s base * ~0.5 attraction-mod * ~0.7 weather = ~1.9 s/
// spawn = ~31/min, fillable across 75-150 concurrent seats under
// peak modifiers. Below ~4 s the chef pipeline starts to choke at
// typical staff levels.
const SPAWN_INTERVAL_SECONDS = 5.5;
/** Guests give up if not served within this many seconds total. Scaled by
 * the recipe's cook time so slow recipes don't unfairly anger guests. */
// Two-phase patience budget. Was a single PATIENCE_BASE_SECONDS pool
// reused for both "waiting for the waiter to take my order" and
// "waiting for the food to arrive". Splitting them gives the player
// finer-grained signal about WHY a guest left:
//   - ORDER_PATIENCE exhausted = waiter pool is too thin / too far
//     (the customer never got someone to flag down).
//   - SERVE_PATIENCE exhausted = kitchen throughput is the bottleneck
//     (chefs / appliances couldn't keep up).
// Both are multiplied by the archetype's patienceMultiplier (0.6×
// Quick Lunch → 1.3× Foodie). SERVE patience resets at the start of
// every course so multi-course orders don't accumulate pressure.
const ORDER_PATIENCE_BASE_SECONDS = 60;
const SERVE_PATIENCE_BASE_SECONDS = 90;

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
      const tasteIcons = formatTasteIcons(g.taste);
      if (g.order.length === 0) {
        // Order not taken yet — show the order-patience countdown so
        // the player can see "this customer is about to leave because
        // no waiter came to take their order." Only visible once
        // they've actually flagged a waiter (orderRequested); the
        // pre-flag 3s settle beat just shows the menu icon. Taste
        // icons trail so the player can spot WHY a customer picked
        // this seat (🎨 = decor-sensitive, 🪟 = window lover, etc.)
        const secs = Math.max(0, Math.ceil(g.patience));
        const base = g.orderRequested ? `${prefix} ${menuIcon} ${secs}s` : `${prefix} ${menuIcon}`;
        return tasteIcons ? `${base} ${tasteIcons}` : base;
      }
      return `${prefix} ⏳`;
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

/** Compact icon string for the guest's STRONG taste preferences.
 * Empty when nothing crosses the threshold so casual guests don't
 * carry visual noise. Order: decor, window, privacy, bar. Player
 * uses it to understand at a glance why a customer parked at a
 * specific seat (e.g. 🎨🪟 → they wanted decor AND a window). */
function formatTasteIcons(taste: ActiveGuest["taste"]): string {
  const parts: string[] = [];
  if (taste.decorAffinity > 0.6) parts.push("🎨");
  if (taste.windowAffinity > 0.6) parts.push("🪟");
  if (taste.privacyBias > 0.4) parts.push("🤫");
  if (taste.barAffinity > 0.6) parts.push("🍸");
  return parts.join("");
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
  /** Optional: hook for re-parenting a guest character to a different
   * storey's mount group when they cross the staircase. Without this
   * wire, guests stay parented to the main scene (always visible) for
   * their entire visit — a Floor 1 customer would be visible from
   * the ground floor view because their parent ignores storey focus.
   * Engine wires this to WorldScene.reparentCharacterToFloor. */
  reparentCharacter?: (character: AnimatedCharacter, toFloor: number) => void;
  /** Returns the appropriate scene parent for a static prop (plate,
   * leftover, etc.) that lives on the given floor. Engine wires this
   * to WorldScene.getStoreyMount so plates inherit the storey
   * group's visibility — fixes the "served-food icon visible
   * through floors below" bug. */
  getStoreyMount?: (floor: number) => THREE.Object3D;

  /** Phase B.3b — when the `serverSim.guests` flag is on, GuestSpawner
   * MIRRORS local guest lifecycle events to the SpacetimeDB
   * active_guest table via this cloud client. The local sim still
   * drives gameplay; the cloud row exists so other clients (P4 visit
   * mode, future co-owner views) can render the same customer set.
   * Set by Engine after construction; null in tests / pre-cloud
   * boot paths. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;

  /** Per-frame accumulator used to throttle position publish calls to
   * roughly 1 Hz — see streamGuestPositionsToCloud. */
  private cloudPositionAccum = 0;

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
   * Uses the multi-floor pathfinder so a Floor 1 seat triggers a route
   * down the building → up the staircase → across the upper slab. The
   * target floor is the guest's seatFloor for state transitions that
   * move them toward their seat (walkingIn, returningFromToilet, etc).
   * For exit / bathroom trips the target stays on the guest's current
   * floor — we don't drag them across stairs to leave through a
   * ground-floor door yet (Phase 8d MVP: guests come back DOWN the
   * stair when leaving, but that path is planned naturally from
   * currentFloor → 0 when their state targets the door).
   *
   * Falls back to a direct waypoint when no pathfinder is wired. */
  private planPath(g: ActiveGuest): void {
    if (!this.pathfind) {
      g.path = [{ x: g.target.x, z: g.target.y, floor: g.currentFloor }];
      return;
    }
    const targetFloor = this.pickPathTargetFloor(g);
    g.path = this.pathfind.findMultiFloorPath(
      { x: g.character.groundPos.x, z: g.character.groundPos.y, floor: g.currentFloor },
      { x: g.target.x, z: g.target.y, floor: targetFloor },
    );
    if (g.path.length === 0) {
      g.path = [{ x: g.target.x, z: g.target.y, floor: targetFloor }];
    }
    // Diagnostic: log every cross-floor guest plan so we can see if the
    // stair waypoint is being emitted on ascent (door→upper-floor seat)
    // or descent (toilet/return paths). One line per plan, only when
    // currentFloor != targetFloor so normal same-floor walks stay quiet.
    if (g.currentFloor !== targetFloor) {
      const hop = g.path.find((s) => s.fromStair);
      console.log(`[Guest] ${g.id} plan F${g.currentFloor}→F${targetFloor} state=${g.state} from (${g.character.groundPos.x.toFixed(1)},${g.character.groundPos.y.toFixed(1)}) to (${g.target.x.toFixed(1)},${g.target.y.toFixed(1)}): ${g.path.length} waypoints, stair=${hop ? `(${hop.x},${hop.z},F${hop.floor})` : "MISSING"}`);
    }
  }

  /** Decide which storey the guest's `target` lives on. walkingIn
   * covers THREE legs that need different target floors:
   *   1. Outside → door exterior — target on Floor 0 (door is ground
   *      floor; the guest is approaching from the lawn).
   *   2. Door exterior → door interior — still Floor 0.
   *   3. Door interior → assigned seat — target on g.seatFloor (the
   *      multi-floor planner inserts the stair if seatFloor > 0).
   *
   * Without the per-leg check, leg 1 / 2 above sent an upper-floor
   * guest's planner from {outside, floor:0} to {door, floor:1},
   * which generated an ascent path "via the stair" to the door —
   * routing the guest into the building, up the stairs, then trying
   * to walk to a XZ that lives outside the building on Floor 1. The
   * guest got stuck mid-stair because the destination wasn't on a
   * reachable Floor 1 cell. */
  private pickPathTargetFloor(g: ActiveGuest): number {
    switch (g.state) {
      case "walkingIn":
        // Door approach legs stay on Floor 0; seat leg jumps to
        // seatFloor once we've passed the interior door.
        return g.passedDoor ? g.seatFloor : 0;
      case "walkingToToilet":
        // Cross-floor toilet trips: pickFreeToilet may assign a
        // fixture on another storey, so target that storey explicitly
        // — without this the planner aimed at the toilet's XZ on
        // g.currentFloor and the guest pretended to walk through
        // the slab.
        return g.toiletFloor ?? g.currentFloor;
      case "walkingToSink":
        // Same idea for the sink leg.
        return g.sinkFloor ?? g.currentFloor;
      case "returningFromToilet":
        return g.seatFloor;
      case "walkingToDoor":
      case "walkingOut":
      case "exitingDoor":
        return 0;
      default:
        return g.currentFloor;
    }
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
      // Floor 0.35 (was 0.45). Lets a heavily-decorated late-game
      // restaurant pull spawn intervals close to 35% of base, which —
      // combined with the lower base — gets close to the 1 s/spawn
      // needed to fill ~100 concurrent seats. Cap on the attraction
      // input stays at 0.65 (max 65% reduction).
      const attractionMult = Math.max(0.35, 1 - Math.min(0.65, attraction * 0.015));
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
    // Phase B.3b — mirror live guest positions to the cloud at ~1 Hz
    // so the active_guest row tracks where the rendered model is.
    // Cheap (one reducer call per guest per second) and useful for
    // P4 visit mode + future co-owner mirroring. No-op when the
    // serverSim.guests flag is off.
    this.streamGuestPositionsToCloud(dt);
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
    // Cancel any pending order request / in-flight cooking ticket up
    // front so a waiter walking toward the now-empty seat gets pulled
    // off immediately instead of completing a wasted trip and
    // dwelling at the empty chair for 1.5s. (despawnGuest also calls
    // cancelTicket as a safety net.)
    this.router.cancelTicket(g.id);
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
   * by exactly the in-flight count.
   *
   * IMPORTANT: skip guests whose `dishesSettled` flag is already true.
   * settleGuestDishes moves each eaten reservation into the DIRTY pool
   * but doesn't clear reservedDishTiers (other code reads it — leftover
   * mesh spawning, save / debug snapshot). Counting them as in-flight
   * AFTER settlement double-counts the same plate: once in dirty,
   * once in this in-flight total. The displayed HUD denominator was
   * spiking up by 1-3 every time a guest finished a course (between
   * finalizeVisit → settleGuestDishes and the despawnGuest tick that
   * removes them from this.guests). */
  getInFlightDishCount(): number {
    let n = 0;
    for (const g of this.guests) {
      if (g.dishesSettled) continue;
      n += g.reservedDishTiers.length;
    }
    return n;
  }

  /** Per-kind per-tier breakdown of in-flight reservations — used by
   * SaveSystem so a refresh / cloud-load doesn't permanently lose any
   * plates that were "in a guest's hands" at save time. Guests are
   * NOT persisted, so without this every mid-meal reservation would
   * vanish on the next load. The hydrate path adds these back to the
   * clean pool — equivalent to "the guest left at save time, leaving
   * the plate behind". */
  getInFlightByKindTier(): Array<{ kind: DishKind; tier: number; count: number }> {
    const byKey = new Map<string, number>();
    for (const g of this.guests) {
      // Same dishesSettled guard as getInFlightDishCount — settled
      // reservations are already in the dirty pool, listing them here
      // would dupe them in the save's recovery path.
      if (g.dishesSettled) continue;
      for (let i = 0; i < g.reservedDishTiers.length; i += 1) {
        const recipe = g.order[i];
        if (!recipe) continue;
        const kind: DishKind = recipe.category === "drink" ? "glass" : "plate";
        const tier = g.reservedDishTiers[i];
        const key = `${kind}-${tier}`;
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
      }
    }
    const out: Array<{ kind: DishKind; tier: number; count: number }> = [];
    for (const [key, count] of byKey) {
      const [kindRaw, tierStr] = key.split("-");
      const kind: DishKind = kindRaw === "glass" ? "glass" : "plate";
      out.push({ kind, tier: parseInt(tierStr, 10), count });
    }
    return out;
  }

  /** Engine wires a logger here so settleGuestDishes can push context-
   * rich entries into the leak watcher's ring buffer (guest id, state,
   * orderIndex, reservation count) alongside the raw DishwareSystem
   * mutations. Off by default. */
  setDishwareLogger(fn: ((msg: string) => void) | undefined): void {
    this.dishwareLogger = fn;
  }
  private dishwareLogger?: (msg: string) => void;

  /** Remaining patience (seconds) for a guest, or undefined if no
   * such guest exists right now. StaffRouter calls this to sort
   * ticket / order-request candidates by urgency so the most-
   * impatient customer gets served first instead of the oldest
   * one. Undefined returns sort to the back of the queue (treated
   * as Infinity) — a vanished guest can't poach work from a real
   * one. */
  getGuestPatience(guestId: string): number | undefined {
    const g = this.guests.find((x) => x.id === guestId);
    return g?.patience;
  }

  /** Called by StaffRouter when a waiter completes the take-order
   * dwell at a seated guest's table. Builds the recipe list (the
   * old auto-order path used to do this inside the seated state
   * machine) and latches g.orderTaken so the next seated tick calls
   * beginNextCourse. No-op if the guest has left in the meantime. */
  onWaiterTookOrder(guestId: string): void {
    const g = this.guests.find((x) => x.id === guestId);
    if (!g) return;
    g.orderTaken = true;
    if (g.order.length === 0) {
      const surface = this.tableSurfaceForGuest(g);
      g.order = this.buildOrder(g.archetype, surface, g.taste);
    }
    // Order is in — flip from the order-patience budget to the longer
    // serve-patience budget so the kitchen has its full window to
    // cook + deliver. Without this, a customer whose order was taken
    // at the 55s mark of a 60s order budget would only have 5s left
    // for the entire kitchen pipeline.
    g.patience = SERVE_PATIENCE_BASE_SECONDS * g.archetype.patienceMultiplier;
  }

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

  /** Every functional seat that's currently unclaimed (free + clean
   * + not in-flight). Used by the taste-driven picker to score
   * candidates. */
  private listFreeSeats(): ResolvedSeatSlot[] {
    return this.listFunctionalSeats().filter((s) => {
      const id = makeSeatId(s);
      if (this.occupiedSeats.has(id)) return false;
      if (this.dirtyUntil.has(id)) return false;
      if (this.inFlightSpawnSeats.has(id)) return false;
      return true;
    });
  }

  /** Score a free seat for a guest with the given taste. Higher =
   * better. NEGATIVE INFINITY means "diet doesn't match — invalid
   * candidate; reject" (the caller filters those out).
   *
   * The score is a weighted sum of:
   *   - theme match: +30 if the seat's floor uses the guest's
   *     preferred theme
   *   - decor density: per-seat decor + plant + lamp items within
   *     ~6 tiles, weighted by decorAffinity. Max ≈ +60.
   *   - window adjacency: +20 × windowAffinity if a window is placed
   *     within ~2 tiles of the seat
   *   - privacy: ±30 × privacyBias. Penalises proximity to "loud"
   *     kitchen items (stove, sink, dishwasher) when privacyBias > 0;
   *     bonuses it when negative (extrovert wants the bustle).
   *   - bar affinity: +30 × barAffinity if the seat is AT the bar
   *   - group fit: +15 if the host table has ≥ groupSize seats
   *   - entrance pull: −2 per floor up from ground (small tiebreaker
   *     so we don't make a casual guest climb 4 floors for a 5%
   *     prettier seat) */
  private scoreSeat(seat: ResolvedSeatSlot, taste: CustomerTaste): number {
    if (!this.dietMatchesSeat(seat, taste.diet)) return -Infinity;
    let score = 0;
    // Theme match.
    const themeId = this.game.getThemeForFloor?.(seat.floor)?.id ?? "plain-white";
    if (themeId === taste.preferredTheme) score += 30;
    // Decor density around the seat.
    const decorScore = this.computeNearbyDecorScore(seat);
    score += decorScore * taste.decorAffinity;
    // Window adjacency.
    if (this.isSeatWindowAdjacent(seat)) score += 20 * taste.windowAffinity;
    // Privacy / noise — distance to nearest loud kitchen station.
    const noise = this.computeKitchenProximity(seat);
    // noise is 0..1 (1 = right next to a stove); privacy +1 wants
    // away from it, −1 wants close to it.
    score += -noise * 30 * taste.privacyBias;
    // Bar affinity — bonus if seat is AT the bar.
    if (seat.atBar) score += 30 * taste.barAffinity;
    // Group fit — bonus if the table has enough seats.
    const tableSeats = this.tableSeatCount(seat.tableUid);
    if (tableSeats >= taste.groupSize) score += 15;
    // Small entrance pull tiebreaker (negligible for taste-driven
    // picks, decisive when two seats score identically).
    score -= 2 * seat.floor;
    return score;
  }

  /** Hard filter — drink-only guest can only sit at a "drink"
   * surface (bar counter / coffee table); food-only can only sit
   * at a "food" surface (regular dining table); "both" can use
   * either. Strict per user spec; spawn rate is bumped elsewhere
   * to compensate for the resulting rejection rate. */
  private dietMatchesSeat(seat: ResolvedSeatSlot, diet: DietKind): boolean {
    if (diet === "both") return true;
    if (diet === "drink") return seat.surface === "drink";
    return seat.surface === "food";
  }

  /** Sum decor "quality" within ~6 tiles of the seat. Each decor /
   * plant / lamp item on the SAME floor contributes (style + 10 ×
   * ratingBonus) weighted by 1 / (1 + d²) where d is distance in
   * tiles. Caps at ~+60 total for a heavily decorated corner. */
  private computeNearbyDecorScore(seat: ResolvedSeatSlot): number {
    if (!this.registry) return 0;
    let score = 0;
    for (const it of this.registry.snapshotItems()) {
      if (it.floor !== seat.floor) continue;
      const def = getFurnitureDef(it.defId);
      if (!def) continue;
      if (def.category !== "decoration" && def.category !== "plant" && def.category !== "lamp") continue;
      const dx = it.x - seat.x;
      const dz = it.z - seat.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 6) continue;
      const quality = (def.style ?? 1) + 10 * (def.ratingBonus ?? 0);
      score += quality / (1 + dist * dist);
    }
    return Math.min(60, score * 4);
  }

  /** True if a window is placed on a wall within ~2 tiles of the
   * seat. Approximates "seat by the window" without actually
   * computing which wall segment the seat looks at. */
  private isSeatWindowAdjacent(seat: ResolvedSeatSlot): boolean {
    if (!this.registry) return false;
    for (const it of this.registry.snapshotItems()) {
      if (it.floor !== seat.floor) continue;
      if (!it.defId.startsWith("window") && !it.defId.startsWith("int-window")) continue;
      const dx = it.x - seat.x;
      const dz = it.z - seat.z;
      if (Math.hypot(dx, dz) < 2.5) return true;
    }
    return false;
  }

  /** 0..1 — how close the seat is to a "loud" kitchen station
   * (stove, sink, dishwasher). 1 = right next to one, 0 = >5 tiles
   * away. Drives the privacy / noise scoring. */
  private computeKitchenProximity(seat: ResolvedSeatSlot): number {
    if (!this.registry) return 0;
    let minDist = Infinity;
    for (const it of this.registry.snapshotItems()) {
      if (it.floor !== seat.floor) continue;
      const def = getFurnitureDef(it.defId);
      if (!def) continue;
      if (def.category !== "stove" && def.category !== "wash") continue;
      const d = Math.hypot(it.x - seat.x, it.z - seat.z);
      if (d < minDist) minDist = d;
    }
    if (!Number.isFinite(minDist)) return 0;
    if (minDist >= 5) return 0;
    return 1 - minDist / 5;
  }

  /** Number of seat slots on the seat's host table. Caches per
   * tableUid would help if we hit hot paths but seat picking runs
   * once per spawn so the linear scan is fine. */
  private tableSeatCount(tableUid: string): number {
    if (!this.registry) return 1;
    const all = this.registry.getResolvedSeatSlots();
    let n = 0;
    for (const s of all) if (s.tableUid === tableUid) n += 1;
    return n;
  }

  /** Score every free seat against the taste, return the highest-
   * scoring one. Returns null when no valid seat exists (every
   * candidate failed the diet filter — strict mode means the guest
   * is rejected and the spawn slot is skipped). */
  private pickBestSeatForTaste(taste: CustomerTaste): ResolvedSeatSlot | null {
    const free = this.listFreeSeats();
    let best: ResolvedSeatSlot | null = null;
    let bestScore = -Infinity;
    for (const s of free) {
      const score = this.scoreSeat(s, taste);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
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
          this.router.cancelTicket(g.id);
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
      // Retroactive floor reconciliation. Seated guests SHOULD live
      // under their seatFloor's storey group so storey-focus visibility
      // hides them when the player looks at another floor. Guests
      // spawned BEFORE the reparent fix shipped (or anything else that
      // could leave a guest parented to the wrong floor) get repaired
      // here. The reparent callback compares parents internally and
      // no-ops when they already match, so this is just a cheap
      // pointer check most of the time. Currents floor is also synced
      // so the next path leg anchors Y to the right slab.
      if (g.state === "seated" || g.state === "waitingForFood" || g.state === "eating") {
        if (g.currentFloor !== g.seatFloor) g.currentFloor = g.seatFloor;
        this.reparentCharacter?.(g.character, g.seatFloor);
      }
      if (g.state === "walkingIn" && g.passedDoor) {
        // Only re-plan when the seat ACTUALLY moved. The previous
        // version copied g.seatPos to g.target every tick and called
        // planPath unconditionally — fine for single-floor walks (the
        // generated path was the same), but with multi-floor pathing
        // every tick generated a fresh 3-waypoint path that started
        // with the stair-landing tile, which the consume loop then
        // ate before the next replan rebuilt it again, looping the
        // guest in place near the stair landing. Compare to detect a
        // real move (table relocation) and only re-plan then. Door
        // approach legs (passedDoor=false) don't need this — they
        // target DOOR_POSITION, not the seat.
        const moved =
          Math.abs(g.target.x - g.seatPos.x) > 0.01 ||
          Math.abs(g.target.y - g.seatPos.y) > 0.01;
        if (moved) {
          g.target.copy(g.seatPos);
          this.planPath(g);
        }
      }
      // If the guest is currently HEADED back to the seat after the
      // bathroom, retarget them too so they don't aim for empty floor.
      // Same "only on actual move" guard for the same reason.
      if (g.state === "returningFromToilet") {
        const moved =
          Math.abs(g.target.x - g.seatPos.x) > 0.01 ||
          Math.abs(g.target.y - g.seatPos.y) > 0.01;
        if (moved) {
          g.target.copy(g.seatPos);
          this.planPath(g);
        }
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

  /** Nearest UNRESERVED toilet, ranked by **walking pathway distance**
   * from the supplied guest's current position. Falls back to straight-
   * line distance when no pathfinder is wired. Cross-floor candidates
   * are considered (the multi-floor planner handles the stair leg) —
   * a Floor 0 guest will go upstairs when the only free toilet is on
   * Floor 1, but the small per-stair penalty keeps a slightly-farther
   * same-floor toilet from losing to a barely-closer upstairs one.
   *
   * Returns the uid, rotY (so the guest can face outward when sitting),
   * the toilet's centre (snap-on-bowl point), the stand-in-front walk
   * target, AND the toilet's storey so the spawner can drive the walk
   * path to the right floor. Null when either no toilet exists or
   * every one is busy. */
  private findFreeToilet(g: ActiveGuest): {
    uid: string;
    rotY: number;
    center: THREE.Vector2;
    standPos: THREE.Vector2;
    floor: number;
  } | null {
    if (!this.registry) return null;
    const toilets = this.registry.getToilets().filter((t) => !this.reservedToilets.has(t.uid));
    if (toilets.length === 0) return null;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < toilets.length; i += 1) {
      const t = toilets[i];
      const dist = this.pathwayDistance(g, t.standPos, t.floor);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    const t = toilets[bestIdx];
    return {
      uid: t.uid,
      rotY: t.rotY,
      center: new THREE.Vector2(t.x, t.z),
      standPos: t.standPos.clone(),
      floor: t.floor,
    };
  }

  /** Nearest UNRESERVED sink, same pathway-distance ranking as
   * findFreeToilet. Returns rotY too so atSink can face the guest
   * toward the basin, and the sink's floor so the trip path targets
   * the right storey. */
  private findFreeSink(g: ActiveGuest): { uid: string; rotY: number; standPos: THREE.Vector2; floor: number } | null {
    if (!this.registry) return null;
    const sinks = this.registry.getBathroomSinks().filter((s) => !this.reservedSinks.has(s.uid));
    if (sinks.length === 0) return null;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < sinks.length; i += 1) {
      const s = sinks[i];
      const dist = this.pathwayDistance(g, s.standPos, s.floor);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    const s = sinks[bestIdx];
    return { uid: s.uid, rotY: s.rotY, standPos: s.standPos.clone(), floor: s.floor };
  }

  /** Walking distance from a guest's current position to a fixed XZ
   * on a specified floor. Uses the multi-floor pathfinder when
   * available so a Floor 0 guest ranking a Floor 1 toilet pays the
   * stair cost honestly; falls back to straight-line + per-floor
   * penalty when no pathfinder is wired (e.g. early Engine boot).
   *
   * STAIR_PENALTY is added per floor crossed so a tied-distance same-
   * floor toilet beats an upstairs one (matches the "guest gravitates
   * to their own floor's bathroom" intuition). Tuned to ~3 units =
   * roughly 1.5 seconds of walking, enough to break ties without
   * disqualifying genuinely-closer upstairs fixtures. */
  private pathwayDistance(g: ActiveGuest, to: THREE.Vector2, toFloor: number): number {
    const STAIR_PENALTY = 3;
    const from = g.character.groundPos;
    const fromFloor = g.currentFloor;
    if (!this.pathfind) {
      const flat = Math.hypot(to.x - from.x, to.y - from.y);
      return flat + Math.abs(toFloor - fromFloor) * STAIR_PENALTY;
    }
    const path = this.pathfind.findMultiFloorPath(
      { x: from.x, z: from.y, floor: fromFloor },
      { x: to.x, z: to.y, floor: toFloor },
    );
    if (path.length === 0) {
      return Math.hypot(to.x - from.x, to.y - from.y) + Math.abs(toFloor - fromFloor) * STAIR_PENALTY;
    }
    let length = 0;
    let prevX = from.x, prevZ = from.y;
    for (const step of path) {
      if (step.fromStair) {
        length += STAIR_PENALTY;
      } else {
        length += Math.hypot(step.x - prevX, step.z - prevZ);
      }
      prevX = step.x; prevZ = step.z;
    }
    return length;
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

  /** P5 — external arrival entry point. SharedPedestrians fires this
   * via Engine when a target-bound walker reaches the player's plot
   * door. Bypasses spawnCooldown (the pedestrian's 30+ second walk
   * already served as the cool-off) but still defers to spawnGuest's
   * seat availability check — no seat = customer turned away by the
   * existing waiting-chair / silent-decline logic.
   *
   * variantHint is the GLB id of the walker that just arrived so the
   * customer that materialises inside matches the character the
   * player watched approach the door (visual continuity). When
   * absent or unknown, spawnGuest falls back to its random pick. */
  triggerExternalArrival(variantHint?: string): void {
    if (!this.restaurantOpen) return;
    if (this.countAvailableSeats() <= 0 && !this.canAcceptWaitingGuest()) return;
    void this.spawnGuest(variantHint);
    // Pause the local cooldown briefly so the external arrival
    // "counts" against the upcoming auto-spawn. Without this the
    // local timer keeps firing on its usual interval AND the
    // external arrivals stack on top, double-booking the restaurant
    // any time other plots' walkers head this way.
    this.spawnCooldown = Math.max(this.spawnCooldown, 8.0);
  }

  private async spawnGuest(variantHint?: string): Promise<void> {
    // Roll archetype + full taste BEFORE picking a seat — the
    // scorer needs every field. Diet is the only hard filter; the
    // rest of the taste shapes seat scoring (theme, decor, window,
    // privacy, bar, group fit). If NO seat matches the strict diet
    // filter the spawn is skipped (the customer is rejected at the
    // door; bumped spawn rate compensates).
    const archetype = rollArchetype();
    const themeIds = RESTAURANT_THEMES.map((t) => t.id);
    const taste = rollCustomerTaste(archetype, themeIds);
    const available = this.pickBestSeatForTaste(taste);
    // One-line spawn diagnostic — surfaces the rolled taste and the
    // resulting seat so the player can tie an observed "why did
    // they sit there" to the actual scoring. Off-floor visits, bar
    // grabs, etc., show up immediately in DevTools.
    if (DEBUG_GUEST_LOGS || !available) {
      const seatTag = available ? `seat=${available.tableUid}#${available.slotIndex}(F${available.floor},${available.surface}${available.atBar ? ",bar" : ""})` : "seat=NONE";
      console.log(`[Guest spawn] ${archetype.id} diet=${taste.diet} cat=${taste.preferredCategory} theme=${taste.preferredTheme} decor=${taste.decorAffinity.toFixed(2)} win=${taste.windowAffinity.toFixed(2)} priv=${taste.privacyBias.toFixed(2)} bar=${taste.barAffinity.toFixed(2)} group=${taste.groupSize} → ${seatTag}`);
    }
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

    // Variant — prefer the walker's variant when this spawn was
    // triggered by an external pedestrian arrival (visual continuity);
    // otherwise pick at random from the catalog. variantHint is
    // validated against the known list so a bad hint doesn't crash
    // the loader.
    const variantId = (variantHint && GUEST_VARIANT_IDS.includes(variantHint))
      ? variantHint
      : pick(GUEST_VARIANT_IDS);
    const id = `guest-${this.nextGuestNum++}`;
    try {
      const model = await this.characterLoader.load(variantId);
      this.scene.add(model);
      // Pick a random X along the pavement so they appear to arrive
      // from up the street rather than popping into existence right
      // outside the door. The pathfinder then walks them from this
      // pavement position to DOOR_EXTERIOR_POSITION (still the first
      // waypoint below) before the existing door dance kicks in —
      // visually they read as a passing pedestrian who turned in.
      const spawnX = (Math.random() - 0.5) * 2 * ENTRY_SPAWN_X_RANGE;
      const character: AnimatedCharacter = {
        root: model,
        // Spawn outside the building; the walkingIn handler will route us
        // via the door before continuing on to the seat.
        groundPos: new THREE.Vector2(spawnX, ENTRY_SPAWN.y),
        facingY: Math.PI, // into the room — reverted to original value
        action: "walk",
        phase: Math.random() * 5,
        // Seat surface height (Kenney chair at S_CHAIR=1.7).
        seatHeight: 0.62,
      };
      this.animator.add(character);

      // Loud announcement for a food critic so the player knows to ace it.
      // (archetype + taste were rolled before the seat pick above.)
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
        seatFloor: available?.floor ?? 0,
        seatAtBar: available?.atBar ?? false,
        platePos,
        target: targetPos,
        passedDoor: false,
        passedExterior: false,
        stateClock: 0,
        order: [],
        orderIndex: 0,
        ticketId: null,
        // Fresh spawn → waiting for a waiter to take their order, so
        // start on the ORDER patience budget. Gets reset to the longer
        // SERVE budget the moment a waiter completes the take-order
        // dwell (onWaiterTookOrder) and again at each course transition
        // (beginNextCourse).
        patience: ORDER_PATIENCE_BASE_SECONDS * archetype.patienceMultiplier,
        totalPaid: 0,
        totalSatisfaction: 0,
        archetype,
        taste,
        path: [],
        currentFloor: 0,
        replanAccum: 0,
        willUseToilet: false,           // assigned just below
        willWashOnly: false,             // assigned just below
        usedToilet: false,
        reservedDishTiers: [],
      };
      // Split the archetype's bathroom-going tendency:
      //   20% of it → actual toilet use (toilet + post-wash chain)
      //   80% of it → pre-meal wash-only trip (sink straight away)
      // The bathroom remains relevant for ~the same proportion of
      // guests overall, but most of them are now just washing — the
      // realistic "wash hands before eating" beat the user asked for.
      // Toilet path takes priority because that already includes a
      // handwash, so willWashOnly is only rolled when the toilet
      // didn't fire.
      const bathTendency = archetype.wcUseChance;
      guest.willUseToilet = Math.random() < bathTendency * 0.2;
      if (!guest.willUseToilet) {
        guest.willWashOnly = Math.random() < bathTendency * 0.8;
      }
      if (DEBUG_GUEST_LOGS) {
        console.log(`[Guest ${id}] spawned · archetype=${archetype.id} · willUseToilet=${guest.willUseToilet} · willWashOnly=${guest.willWashOnly} (wcChance=${archetype.wcUseChance.toFixed(2)})`);
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
      this.mirrorGuestSpawn(guest);
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

  // ======================================================================
  //                Phase B.3b — server-mirror helpers
  // ======================================================================
  // When isServerSim("guests") is on, the local sim still drives everything
  // but we ALSO write a parallel record to the cloud's active_guest table.
  // Three integration points: spawn (insert), despawn (mark leaving),
  // and per-frame position stream. All bail silently when the flag is
  // off OR when the cloud client isn't wired (tests, pre-auth boot).

  /** Fire the spawn_guest reducer with the just-spawned local guest's
   * taste + body so the cloud row materialises. The auto-inc server id
   * is resolved a few frames later via findActiveGuestIdByClientTempId
   * — keeping that lookup async means spawn doesn't block on the
   * network round-trip. */
  private mirrorGuestSpawn(g: ActiveGuest): void {
    if (!isServerSim("guests") || !this.cloud) return;
    this.cloud.spawnGuest({
      clientTempId: g.id,
      variant: g.variantId,
      archetype: g.archetype.id,
      tasteDiet: g.taste.diet,
      tasteDecorPref: g.taste.decorAffinity,
      tasteWindowPref: g.taste.windowAffinity,
      tasteCuisineBias: typeof g.taste.preferredCategory === "string"
        ? g.taste.preferredCategory : "",
      // No 1:1 client field for drink tolerance — leave at 0 for now.
      tasteDrinkTolerance: 0,
      willUseToilet: g.willUseToilet ?? false,
      doorX: g.character.groundPos.x,
      doorZ: g.character.groundPos.y,
      doorFloor: g.currentFloor,
    });
    // Resolve the server-side auto-inc id once the subscription cache
    // catches up. 250 ms is comfortably above the typical reducer
    // round-trip; if we miss the window we'll just lose mirror-leave
    // for THIS guest (the cloud's patience timer will despawn the
    // row regardless).
    window.setTimeout(() => {
      if (!this.cloud) return;
      const id = this.cloud.findActiveGuestIdByClientTempId(g.id);
      if (id != null) g.serverMirrorId = id;
    }, 250);
  }

  /** Push state="leaving" to the cloud row so its dwell-then-delete
   * timer matches our local despawn. Idempotent server-side. */
  private mirrorGuestLeaving(g: ActiveGuest): void {
    if (!isServerSim("guests") || !this.cloud) return;
    // Late resolve in case the 250 ms timeout above didn't land in
    // time (very-short visits — patience-out before subscription
    // caught up).
    if (g.serverMirrorId == null) {
      g.serverMirrorId = this.cloud.findActiveGuestIdByClientTempId(g.id) ?? undefined;
    }
    if (g.serverMirrorId == null) return;
    this.cloud.markGuestLeaving(g.serverMirrorId);
  }

  /** Throttled per-frame: every ~1 s, push each guest's body coords +
   * current target to the server so subscribed clients (visit mode,
   * future co-owner views) can lerp the same body in their own scene.
   * Skip guests whose serverMirrorId hasn't been resolved yet — the
   * spawn-side polling timeout owns that handshake. */
  private streamGuestPositionsToCloud(dt: number): void {
    if (!isServerSim("guests") || !this.cloud) return;
    this.cloudPositionAccum += dt;
    if (this.cloudPositionAccum < 1.0) return;
    this.cloudPositionAccum = 0;
    for (const g of this.guests) {
      if (g.serverMirrorId == null) continue;
      this.cloud.updateGuestPosition(
        g.serverMirrorId,
        g.character.groundPos.x,
        g.character.groundPos.y,
        g.currentFloor,
        g.target.x,
        g.target.y,
        g.currentFloor,
      );
    }
  }

  private despawnGuest(idx: number): void {
    const g = this.guests[idx];
    // Phase B.3b — mirror the leaving event to the cloud row before
    // we tear down the local guest. Async fire-and-forget; helper
    // bails silently when the flag is off or no cloud row was created.
    this.mirrorGuestLeaving(g);
    // Safety net — if some upstream path forgot to reconcile the
    // reservations (or a future state transition is added without one),
    // this catches them here. settleGuestDishes is idempotent so calling
    // it twice is harmless.
    this.settleGuestDishes(g);
    // Cancel any in-flight order so a chef doesn't keep cooking for a
    // ghost and a waiter doesn't walk a plate to an empty seat. Safe
    // to call when the ticket already completed (returns false) or was
    // never created (g.ticketId null) — cancelTicket finds-by-guestId.
    this.router.cancelTicket(g.id);
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
    // Parent the plate to its FLOOR'S group (not the root scene)
    // so it inherits the per-storey visibility — plates on Floor 2
    // disappear when the player focuses Floor 0 instead of showing
    // through the ceiling.
    const mount = this.getStoreyMount?.(g.seatFloor) ?? this.scene;
    mount.add(plate);
    this.tablePlates.set(g.id, plate);
  }

  private removePlateForGuest(guestId: string): void {
    const plate = this.tablePlates.get(guestId);
    if (!plate) return;
    // Use the plate's actual parent — it might be a storey group
    // (post the per-floor parenting fix above) or the legacy
    // scene root if the spawner wasn't wired with getStoreyMount.
    plate.parent?.remove(plate);
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
      // Parent leftover plates/glasses to the SEAT's floor group so
      // they hide with that storey — same fix as showPlateForGuest
      // for the served-food icons bleeding through floors below.
      const mount = this.getStoreyMount?.(g.seatFloor) ?? this.scene;
      mount.add(mesh);
      this.dirtyTableMeshes.push({
        id: this.nextDirtyId, mesh, kind, claimedBy: null,
        pos: new THREE.Vector2(x, z),
        floor: g.seatFloor,
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
      out.push({ id: d.id, kind: d.kind, pos: d.pos.clone(), floor: d.floor });
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
    // Post per-floor-parenting fix the mesh might live in a storey
    // group rather than scene root; remove from its actual parent.
    entry.mesh.parent?.remove(entry.mesh);
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
    // Post per-floor-parenting fix the mesh might live in a storey
    // group rather than scene root; remove from its actual parent.
    entry.mesh.parent?.remove(entry.mesh);
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
            // Stair walk (P8d) has already brought the guest up to the
            // right slab via moveToward's smooth Y interpolation; just
            // make sure currentFloor reflects the seat's storey in case
            // the path's last fromStair waypoint was already consumed
            // by an earlier tick.
            g.currentFloor = g.seatFloor;
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
          const toilet = this.findFreeToilet(g);
          // Log once per attempt — the first time we enter this block.
          // toiletWaitRemaining is only set on busy retries, so its
          // undefined state is a clean "first attempt" signal.
          if (DEBUG_GUEST_LOGS && g.toiletWaitRemaining === undefined) {
            const toiletCountTotal = this.registry?.getToilets().length ?? 0;
            const sinkCountTotal = this.registry?.getBathroomSinks().length ?? 0;
            console.log(`[Guest ${g.id}] WC user — toilet search: ${toilet ? `uid=${toilet.uid} (F${toilet.floor})` : `null (${toiletCountTotal} toilets placed, ${this.reservedToilets.size} reserved)`} · sinks placed: ${sinkCountTotal}`);
          }
          if (toilet) {
            this.reservedToilets.add(toilet.uid);
            g.toiletUid = toilet.uid;
            g.toiletRotY = toilet.rotY;
            g.toiletCenter = toilet.center;
            g.toiletFloor = toilet.floor;
            g.returnSeatPos = g.seatPos.clone();
            g.target = toilet.standPos.clone();
            // Set state BEFORE planPath so pickPathTargetFloor reads
            // walkingToToilet and routes to g.toiletFloor.
            g.state = "walkingToToilet";
            this.planPath(g);
            g.character.action = "walk";
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
        // Pre-meal handwash trip — separate from the toilet flow. Most
        // guests now just walk straight to a bathroom sink before
        // ordering. Same patience-and-give-up shape as the toilet
        // branch above; finalizeVisit's penalty fires if they wanted
        // to wash and there was no sink (or every one stayed busy).
        if (g.willWashOnly && !g.washedHands && !g.washAttemptComplete) {
          const sink = this.findFreeSink(g);
          if (DEBUG_GUEST_LOGS && g.washWaitRemaining === undefined) {
            const sinkCountTotal = this.registry?.getBathroomSinks().length ?? 0;
            console.log(`[Guest ${g.id}] wash-only — sink search: ${sink ? `uid=${sink.uid} (F${sink.floor})` : `null (${sinkCountTotal} sinks placed, ${this.reservedSinks.size} reserved)`}`);
          }
          if (sink) {
            this.reservedSinks.add(sink.uid);
            g.sinkUid = sink.uid;
            g.sinkRotY = sink.rotY;
            g.sinkFloor = sink.floor;
            g.returnSeatPos = g.seatPos.clone();
            g.target = sink.standPos.clone();
            g.state = "walkingToSink";
            this.planPath(g);
            g.character.action = "walk";
            g.stateClock = 0;
            g.washWaitRemaining = undefined;
            break;
          }
          // No free sink. Wait WC_PATIENCE_SECONDS, then give up so the
          // order beat below can still fire; finalizeVisit will apply
          // the "wanted to wash but couldn't" penalty.
          if (g.washWaitRemaining === undefined) {
            g.washWaitRemaining = WC_PATIENCE_SECONDS;
          }
          g.washWaitRemaining -= dt;
          if (g.washWaitRemaining > 0) {
            // Hold here — same as the toilet branch.
            break;
          }
          g.washAttemptComplete = true;
        }
        // Waiter-takes-order flow. After the post-sit settling beat
        // (TIME_TO_ORDER doubles as "guest looks at menu" so the
        // request doesn't fire the very first frame they sit down),
        // push an order request into the router. A waiter walks over,
        // dwells, and triggers the takeOrderCallback below — which is
        // the only place g.order gets built. Until then the guest sits
        // patiently with patience ticking (drives the "waiter is too
        // slow" angry-exit path naturally).
        if (g.stateClock >= TIME_TO_ORDER && !g.orderRequested && !g.orderTaken) {
          g.orderRequested = true;
          // Bar-seated guests flag their order as atBar so the
          // barman pool picks it up (the waiter pool filters atBar
          // requests out — see StaffRouter.tickWaiter idle).
          this.router.enqueueOrderRequest(g.id, g.seatPos, g.seatFloor, g.seatAtBar ?? false);
        }
        if (g.orderTaken && g.order.length === 0) {
          // Callback was supposed to populate g.order. Defensive: if
          // it didn't (callback wiring missing) build one here so the
          // guest doesn't get stuck. Same surface-aware build the old
          // path used.
          const surface = this.tableSurfaceForGuest(g);
          g.order = this.buildOrder(g.archetype, surface, g.taste);
          if (g.order.length === 0) {
            this.markLostAndExit(g);
            break;
          }
        }
        if (g.orderTaken && g.order.length > 0) {
          // Try to start the first course. beginNextCourse returns
          // false when the kitchen is out of clean plates / glasses;
          // we stay in "seated" and retry on the next tick while the
          // guest's patience runs down. Success transitions to
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
          // Flush plays as the guest stands up — gives the visit a
          // satisfying audible punctuation in addition to the visual
          // pose change.
          this.sfx?.toiletFlush();
          if (g.toiletUid) this.reservedToilets.delete(g.toiletUid);
          g.toiletUid = undefined;
          g.toiletCenter = undefined;
          g.toiletRotY = undefined;
          g.toiletFloor = undefined;
          g.usedToilet = true;
          g.toiletAttemptComplete = true;
          // Restore the chair-sized seatHeight for the rest of the
          // trip — the next "sit" will be back at the dining table.
          if (g.originalSeatHeight !== undefined) {
            g.character.seatHeight = g.originalSeatHeight;
            g.originalSeatHeight = undefined;
          }
          const sink = this.findFreeSink(g);
          if (DEBUG_GUEST_LOGS) {
            const sinkCountTotal = this.registry?.getBathroomSinks().length ?? 0;
            console.log(`[Guest ${g.id}] left toilet → findFreeSink: ${sink ? `uid=${sink.uid} (F${sink.floor}) at (${sink.standPos.x.toFixed(2)}, ${sink.standPos.y.toFixed(2)})` : `null (${sinkCountTotal} placed, ${this.reservedSinks.size} reserved)`}`);
          }
          if (sink) {
            this.reservedSinks.add(sink.uid);
            g.sinkUid = sink.uid;
            g.sinkRotY = sink.rotY;
            g.sinkFloor = sink.floor;
            g.target = sink.standPos.clone();
            g.state = "walkingToSink";
            this.planPath(g);
            g.character.action = "walk";
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
          g.sinkFloor = undefined;
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
            // Next course — same dish stack the waiter already wrote
            // down at the take-order step, no second waiter visit. Use
            // the SERVE budget directly so a slow kitchen on course 2
            // gets the full plate-arrival window.
            g.patience = SERVE_PATIENCE_BASE_SECONDS * g.archetype.patienceMultiplier;
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
    // Skip replan while the guest is mid-stair — same reasoning as in
    // StaffRouter.moveActor: a replan from a mid-stair XZ at the OLD
    // floor routes the guest BACK to the stair entry before going up,
    // creating an infinite loop on the steps.
    const midStair = g.path.length > 0 && g.path[0].fromStair === true;
    if (!midStair && g.replanAccum >= 0.8 && this.distanceToTarget(g) >= ARRIVAL_THRESHOLD) {
      g.replanAccum = 0;
      this.planPath(g);
    }
    // Consume waypoints we're already within range of. When a consumed
    // step is fromStair-flagged, the guest has just landed on the upper
    // (or lower) floor — promote currentFloor so the next walk leg
    // anchors the body's Y to the new slab.
    const STOREY = 3;
    // Lazily compute the guest's raw feet-lift the first time we need
    // it. Guests spawn at the Floor 0 door so _baseY captured by the
    // animator IS the raw lift (no homeFloor pre-bake) — but we cache
    // it as _feetLift so the formulas below stay consistent with how
    // staff handle the same maths.
    if (g.character._feetLift == null) {
      g.character._feetLift = g.character._baseY ?? g.character.root.position.y;
    }
    const feetLift = g.character._feetLift;
    while (g.path.length > 0 && Math.hypot(g.path[0].x - pos.x, g.path[0].z - pos.y) < PATH_ARRIVAL_THRESHOLD) {
      const consumed = g.path.shift()!;
      g.prevWaypoint = consumed;
      if (consumed.fromStair) {
        g.currentFloor = consumed.floor;
        const anchorY = consumed.floor * STOREY + feetLift;
        g.character.root.position.y = anchorY;
        // Sync _baseY so the animator's per-frame reset doesn't snap
        // the body back to the storey it was on when the path started.
        g.character._baseY = anchorY;
        // Re-parent into the new floor's storey group so the storey-
        // focus visibility hides the guest when the player is looking
        // at a different floor. Without this, the guest stays parented
        // to the main scene (always visible) for the entire visit and
        // a Floor 1 customer leaks into the ground floor view.
        this.reparentCharacter?.(g.character, consumed.floor);
      }
    }
    const wp = g.path[0] ?? { x: g.target.x, z: g.target.y, floor: g.currentFloor };
    const dx = wp.x - pos.x;
    const dz = wp.z - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) {
      const anchorY = g.currentFloor * STOREY + feetLift;
      g.character.root.position.y = anchorY;
      g.character._baseY = anchorY;
      return;
    }
    const step = Math.min(dist, WALK_SPEED * dt);
    pos.x += (dx / dist) * step;
    pos.y += (dz / dist) * step;
    if (wp.fromStair && g.prevWaypoint) {
      const segStartX = g.prevWaypoint.x;
      const segStartZ = g.prevWaypoint.z;
      const segLen = Math.hypot(wp.x - segStartX, wp.z - segStartZ);
      const trav = Math.hypot(pos.x - segStartX, pos.y - segStartZ);
      const t = segLen > 0.01 ? Math.max(0, Math.min(1, trav / segLen)) : 0;
      const startY = g.prevWaypoint.floor * STOREY + feetLift;
      const endY   = wp.floor * STOREY + feetLift;
      const interpY = startY + (endY - startY) * t;
      g.character.root.position.y = interpY;
      g.character._baseY = interpY;
    } else {
      const anchorY = g.currentFloor * STOREY + feetLift;
      g.character.root.position.y = anchorY;
      g.character._baseY = anchorY;
    }
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
  private buildOrder(archetype: CustomerArchetype, surface: "food" | "drink" = "food", taste?: CustomerTaste): RecipeDefinition[] {
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
    // Cuisine taste bias — 60% of the time, override the rolled
    // expectation with the guest's preferred category for the main
    // slot. Foodies / dessert-lovers / appetizer-seekers actually
    // get more of their preferred category. The other 40% still
    // uses the global expectation so menu variety stays alive.
    const tasteOverride = taste && taste.preferredCategory !== "drink" && Math.random() < 0.6;
    const targetCat = tasteOverride ? taste!.preferredCategory : expectation.category;
    // Appetizer chance, with a bump when the guest specifically
    // prefers appetizers (they'll order one even if they're a
    // quick-lunch type).
    let appChance = 0.6 + archetype.orderSizeBias * 0.2;
    if (taste?.preferredCategory === "appetizer") appChance = Math.min(0.95, appChance + 0.25);
    if (Math.random() < appChance) {
      const apps = onMenu.filter((r) => r.category === "appetizer");
      if (apps.length > 0) order.push(apps[between(0, apps.length - 1)]);
    }
    // Main course: prefer the targetCat (taste override or
    // expectation); fall back to any main; then any recipe.
    const matching = onMenu.filter((r) => r.category === targetCat);
    const mains = matching.length > 0 ? matching : onMenu.filter((r) => r.category === "main");
    const mainPool = mains.length > 0 ? mains : onMenu;
    order.push(mainPool[between(0, mainPool.length - 1)]);
    // Dessert chance, with bump for dessert-preferring guests.
    let dessertChance = 0.35 + archetype.orderSizeBias * 0.2;
    if (taste?.preferredCategory === "dessert") dessertChance = Math.min(0.95, dessertChance + 0.3);
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
    // Force every drink-category recipe to route through the bar
    // appliance, regardless of what its individual `appliances` list
    // declares. Player's design decision: drinks are made at the bar
    // counter by the barman, not by the chef at a stove / blender /
    // coffee machine. Recipe data still carries the old appliance
    // tags so the menu UI's "needs X" hints stay accurate for the
    // INGREDIENT prep story (you still need a coffee machine in
    // visual terms), but ticket routing is bar-only.
    const primaryAppliance: import("../data/types").ApplianceId =
      recipe.category === "drink" ? "bar" : (apps[0] ?? recipe.stationNeeded ?? "stove");
    g.ticketId = this.router.enqueueOrder(
      g.id, recipe.id, g.seatPos, this.game.getBaseCookSeconds(recipe),
      primaryAppliance, g.seatFloor, g.seatAtBar ?? false,
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
    // Drop any pending order request / in-flight ticket so a waiter
    // doesn't keep walking toward this guest's seat after they bail.
    this.router.cancelTicket(g.id);
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
    let satisfaction = this.game.getEffectiveSatisfaction(recipe);
    // Cuisine taste bonus — if the served dish's category matches
    // the guest's preferredCategory, they're extra-pleased. Small
    // additive bump (+2) so it nudges the final star rating without
    // dominating recipe quality / staff training / decor inputs.
    if (recipe.category === g.taste.preferredCategory) {
      satisfaction += 2;
      this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y + 0.2, "♥ taste", "#ffd47a");
    }
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
    } else if (g.willWashOnly) {
      // Pre-meal wash-only trip. The toilet doesn't enter into it, but
      // sink availability matters a lot — diners EXPECT to be able to
      // wash before eating.
      if (bathroom.sinkCount === 0) {
        // Wanted to wash and there was no sink at all — player didn't
        // provide. Significant negative, same scale as the toilet
        // "wanted but couldn't" case.
        toiletDelta = -0.5;
      } else if (!g.washedHands) {
        // Sink existed but every one was busy long enough they gave
        // up. Less the venue's fault — moderate negative.
        toiletDelta = -0.2;
      } else {
        // Actually washed before eating. Quality of the bathroom adds
        // a small bump on top of the base "clean place" credit.
        toiletDelta = 0.15 + qNorm * 0.2;
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
