import * as THREE from "three";
import { disposeObject3D } from "../assets/disposeObject3D";
import { CharacterLoader } from "../assets/CharacterLoader";
import { riggedCustomerForKey, sharedRiggedLoader } from "../scene/RiggedCharacter";
import { CharacterAnimator, type AnimatedCharacter, type SkeletalDriver } from "../scene/CharacterAnimator";
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
import { type CustomerArchetype, type CustomerTaste, type DietKind, rollArchetype, rollCustomerTaste, customerArchetypes } from "../data/customerArchetypes";
import { RESTAURANT_THEMES } from "../data/themes";
import type { Pathfinding, MultiFloorPathStep } from "./Pathfinding";
import { PATH_ARRIVAL_THRESHOLD, STAIR_BOTTOM_TILE, STAIR_TOP_TILE } from "./Pathfinding";

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

/** Free a bussed dirty piece's GPU resources. Plate pieces reuse the
 * shared base geo+mat (kept), so only the fresh crumb mound is freed;
 * glasses are all-fresh and fully freed. Prevents a per-customer leak. */
function disposeDirtyPiece(mesh: THREE.Object3D): void {
  disposeObject3D(mesh, new Set([sharedDirtyPlateGeo, sharedDirtyPlateMat]));
}

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
  /** Anti-stuck watchdog bookkeeping: how long (ms) the guest has sat in one
   * spot while in a state that should be MOVING, and the last position it was
   * seen moving from. Lets tickStuckRecovery re-plan a wedged path so the guest
   * gets moving again instead of standing on the floor as a statue. */
  _stuckMs?: number;
  _stuckX?: number;
  _stuckZ?: number;
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
  /** Phase M.16 — guest cutover. Latest authoritative pose + state
   * stashed off the subscribed active_guest row by reconcileCloudGuest,
   * consumed by renderGuestFromServer when ?serverSim=guestMove is on.
   * Mirrors the cloudX/cloudZ/cloudFloor/cloudState the StaffRouter
   * stashes on a StaffActor (reconcileCloudStaffActor). cloudPrevX/Z +
   * cloudInterp are the snapshot-interpolation anchors: prev = the
   * pose we were gliding FROM, interp = the 0→1 clock across the ~0.5s
   * server tick. Undefined until the first row arrives; unused while
   * the flag is off. */
  cloudX?: number;
  cloudZ?: number;
  cloudFloor?: number;
  cloudState?: string;
  cloudPrevX?: number;
  cloudPrevZ?: number;
  cloudInterp?: number;
  /** Phase M.17 — an in-progress client-side stair CLIMB (fixed ~0.8 s). The
   * server hops the flight in one tick then walks the guest on, so the client
   * animates the walk up the steps itself, holding the body on the stairs
   * regardless of server pose rate. Undefined when not on the stairs. */
  stairClimb?: {
    fromX: number; fromZ: number; toX: number; toZ: number;
    fromFloor: number; toFloor: number; elapsed: number;
  };
  /** Compact "state|targetX|targetZ|floor" fingerprint of the last
   * mirror published to the cloud. streamGuestPositionsToCloud uses
   * this to fire the updateGuestPosition reducer immediately when
   * any of those fields change (state transition, new target) and
   * skip otherwise. Cuts visit-mode lag from < 1 s to < 100 ms.
   * Undefined until first mirror — guarantees the first publish
   * always fires. */
  lastMirrorFingerprint?: string;
  /** Audit fix (B.1) — true once the order CSV has been successfully
   * sent to the cloud via setGuestOrder. The mirror polls the
   * spawn-side serverMirrorId resolution; if that misses (slow net,
   * spawn timing), the order is lost and the server can't drive the
   * eating→leaving transition. streamGuestPositionsToCloud now
   * retries the order mirror on every 1 Hz periodic tick while
   * this flag is false, naturally backing off once it succeeds. */
  orderMirrored?: boolean;
  /** H.19 — true once the overflow waiting chair assignment + give-up
   * timer have been pushed to the cloud row via setGuestWaitingChair.
   * Same retry-on-periodic-tick discipline as orderMirrored so a
   * spawn-time mirror that races serverMirrorId resolution eventually
   * lands and wakes up the server's H.5 timeout branch. */
  waitingMirrored?: boolean;
  /** H.20 — last reserved-tiers CSV successfully pushed to the cloud
   * row. Compared against the freshly-joined `reservedDishTiers` CSV
   * each periodic tick; on mismatch the mirror fires. Undefined means
   * "nothing pushed yet" so a non-empty current value always pushes
   * once. Set to undefined on every push to force a re-send if the
   * list grew between the push site and the periodic check. */
  lastMirroredReservedTiers?: string;
}

const GUEST_VARIANT_IDS = ["guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6"];

/** "A new face in town" — the new RIGGED guest is a deterministic ~1-in-6 of
 * all guests, keyed by guest id so it's stable per-guest across frames and
 * reloads. Purely a client-side render choice: functionally a normal customer
 * (orders, sits, eats, pays), just drawn with the skinned/skeletal character
 * instead of a static one. Tune NEW_FACE_EVERY to change how often he shows. */
const NEW_FACE_EVERY = 6;
function isNewFaceGuest(id: string | number | bigint): boolean {
  const s = String(id);
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % NEW_FACE_EVERY === 0;
}

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

// ============================================================================
//         Phase I.1 (H.47) — Helpers for cloud→local guest hydrate
// ============================================================================

/** Look up a CustomerArchetype by its id string.  Falls back to
 * "casual" when the id is unknown (e.g. a future archetype that the
 * client catalog hasn't picked up yet). */
function archetypeFromId(id: string): CustomerArchetype {
  for (const a of customerArchetypes) {
    if (a.id === id) return a;
  }
  return customerArchetypes[0]; // "casual" fallback
}

/** Construct a CustomerTaste from a cloud HydratableGuestRow.  Diet,
 * decor/window prefs, cuisine bias, drink tolerance come straight
 * from the cloud columns.  Fields the server doesn't track yet
 * (preferredTheme, groupSize, privacyBias, barAffinity) get neutral
 * defaults — these only affect seat-pick scoring which is a one-time
 * decision the server already made; on hydrate the seat is already
 * assigned so the missing values don't matter for ongoing play. */
function tasteFromCloud(
  row: import("../cloud/SpacetimeClient").HydratableGuestRow,
): CustomerTaste {
  const diet: DietKind =
    row.tasteDiet === "drink" ? "drink"
    : row.tasteDiet === "both" ? "both"
    : "food";
  const cat = row.tasteCuisineBias as CustomerTaste["preferredCategory"];
  const okCat: CustomerTaste["preferredCategory"] =
    (cat === "appetizer" || cat === "main" || cat === "dessert"
     || cat === "drink" || cat === "side")
      ? cat : "main";
  return {
    diet,
    preferredTheme: RESTAURANT_THEMES[0]?.id ?? "",
    decorAffinity: clamp(row.tasteDecorPref, 0, 1),
    preferredCategory: okCat,
    groupSize: 1,
    windowAffinity: clamp(row.tasteWindowPref, 0, 1),
    privacyBias: 0,
    barAffinity: 0,
  };
}

/** Map server state strings to local GuestState.  Server has a coarser
 * set ("ordering" is absent locally — folded into "seated"); local
 * has a richer waiting/door subdivision the server doesn't model.
 * Unknown states fall through to "seated" as a safe sit-still default. */
function cloudStateToLocal(serverState: string): GuestState {
  switch (serverState) {
    case "walkingIn":          return "walkingIn";
    case "waiting":            return "waitingForSeat";
    case "seated":             return "seated";
    case "ordering":           return "seated"; // local treats this as a seated sub-phase
    case "waitingForFood":     return "waitingForFood";
    case "eating":             return "eating";
    case "wcWalking":          return "walkingToToilet";
    case "wcSitting":          return "atToilet";
    case "wcWashing":          return "atSink";
    case "returningFromToilet": return "returningFromToilet";
    case "leaving":
    case "walkingToDoor":      return "walkingToDoor";
    case "exitingDoor":        return "exitingDoor";
    case "walkingOut":
    case "done":               return "walkingOut";
    default:                   return "seated";
  }
}

/** States where the character should be in its "sit" pose.  Used both
 * for picking the animation action on import and for setting
 * seatHeight (a tiny chair lift so the model lands on the cushion). */
const SIT_STATES: Set<GuestState> = new Set([
  "seated", "waitingForFood", "eating", "atToilet", "atSink", "waitingForSeat",
]);

/** Pick the character animation action ("sit" / "walk" / "idle") for
 * a given local guest state.  Drives the CharacterAnimator's pose
 * selection — wrong action just looks weird, doesn't break gameplay. */
function actionFromState(state: GuestState): "sit" | "walk" | "idle" {
  if (SIT_STATES.has(state)) return "sit";
  return "walk";
}

/** Parse a comma-separated list of recipe ids into RecipeDefinition[].
 * Skips unknown / blank ids silently so a stale cloud row referencing
 * a deleted catalog recipe doesn't poison the import. */
function parseOrderRecipes(csv: string): RecipeDefinition[] {
  if (!csv) return [];
  const out: RecipeDefinition[] = [];
  for (const raw of csv.split(",")) {
    const id = raw.trim();
    if (!id) continue;
    const r = recipes.find((x) => x.id === id);
    if (r) out.push(r);
  }
  return out;
}

/** Parse a comma-separated tier list ("1,2,1") into number[].  Used
 * for reservedDishTiers on hydrate.  Bad entries default to 1. */
function parseTiersCsv(csv: string): number[] {
  if (!csv) return [];
  const out: number[] = [];
  for (const raw of csv.split(",")) {
    const n = parseInt(raw.trim(), 10);
    out.push(Number.isFinite(n) && n > 0 ? n : 1);
  }
  return out;
}


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
/** Rigged-guest toilet sit DELTA (off the clip's chair-height sit, which
 * CharacterAnimator adds to root.y). The bowl sits below a chair, so a rigged
 * guest drops by this much. The absolute TOILET_SIT_HEIGHT above is for the
 * legacy procedural sit only — applied as a delta it would LIFT a rigged
 * guest off the bowl (the "wrong place in the bathroom" bug). Tune if the
 * perch looks high/low. */
const TOILET_SIT_LIFT = -0.2;
/** Seconds a guest may spend walking to a WC fixture before the local sim
 * gives up and walks them back to the seat. Longer than any normal in-
 * restaurant walk (including a cross-floor stair climb) so it only fires for
 * a genuinely unreachable fixture — see the walkingToToilet/walkingToSink
 * rescue. The server owns the wc_completed outcome regardless. */
const WC_WALK_GIVEUP = 15;
/** Extra vertical lift for a guest seated at a BAR STOOL. The rigged sit clip
 * is authored for a standard dining chair, so on the taller bar stool
 * (furnitureCatalog `bar-stool` / `bar-stool-sq` targetHeight 0.75) a guest
 * sinks below the seat. Applied to skeletal guests only (they sit via the
 * clip; CharacterAnimator adds it to root.y while action === "sit"). Normal
 * chairs/benches sit at the clip baseline (lift 0). Tune here if the perch
 * reads high or low. */
const BAR_STOOL_LIFT = 0.2;
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

/** Phase I (H.99) — Pick the nearest fixture, with STRONG same-floor
 * preference. First partition candidates by `floor === currentFloor`;
 * only consider the cross-floor pool if NO same-floor option exists.
 * Within the chosen partition, pick the smallest `cost(item)`. Used
 * by findFreeToilet + findFreeSink so guests don't trek upstairs for
 * a bathroom when there's a closer one on their own storey. */
function pickNearestOnSameFloorFirst<T extends { floor: number }>(
  items: T[],
  currentFloor: number,
  cost: (item: T) => number,
): T | null {
  const sameFloor = items.filter((i) => i.floor === currentFloor);
  const pool = sameFloor.length > 0 ? sameFloor : items;
  if (pool.length === 0) return null;
  let best: T | null = null;
  let bestDist = Infinity;
  for (const it of pool) {
    const d = cost(it);
    if (d < bestDist) { bestDist = d; best = it; }
  }
  return best;
}
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
const SERVE_PATIENCE_BASE_SECONDS = 180; // DOUBLED (was 90) — twice as long to wait for food delivery. Mirror: server SERVE_PATIENCE_BASE_MS.

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
      // Order placed, waiting for the kitchen — show the serve-patience
      // countdown (was a bare ⏳ with no number, so the timer looked
      // frozen / invisible between ordering and the first plate landing).
      const serveSecs = Math.max(0, Math.ceil(g.patience));
      return `${prefix} ${drinkTable ? "🥤" : "⏳"} ${serveSecs}s`;
    }
    case "waitingForFood": {
      // Show patience countdown so the player feels the urgency.
      const secs = Math.max(0, Math.ceil(g.patience));
      const waitIcon = drinkTable ? "🥤" : "⏳";
      return `${prefix} ${waitIcon} ${secs}s`;
    }
    // Phase M.10 — actively consuming: distinct icon (🍽️ eating / 🍹 drinking)
    // + no timer, and the bubble layer tints it green. Clearly set apart from
    // the WAITING icons (⏳ / 🥤 + a ticking timer) so you can tell at a glance
    // who's served-and-happy vs who's still waiting.
    case "eating":         return `${prefix} ${drinkTable ? "🍹" : "🍽️"}`;
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
  /** Shared rigged-GLB loader (singleton) — same cache the pedestrian + staff
   * renderers use, so each model file is fetched once. */
  readonly riggedLoader = sharedRiggedLoader;
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

  // renderedServerGuests / reconcileServerGuests / spawnServerGuestForArrival
  // removed — they were the legacy Phase B.3c read-side stub that
  // bailed the local sim entirely. VisitMode's startLiveCustomerSubscription
  // handles the equivalent for visit mode; for the owner's session the
  // local sim is now always the source of truth (mirror-additive).

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

  /** DEBUG: drop one skinned guest at a restaurant-LOCAL (x,z) and walk it in
   * place, exercising the REAL rigged-guest path (loader → SkeletonUtils
   * clone → CharacterAnimator fork → SkeletalController) so you can eyeball
   * "the new face" without waiting for the ~1-in-6 id hash to land on a live
   * server guest. window hook: cozySkinnedGuest(). Returns a disposer + a sit
   * toggle. NOT part of normal play. */
  async debugSpawnSkinned(x = 0, z = 0): Promise<{ dispose: () => void; setSit: (sit: boolean) => void }> {
    const inst = await this.riggedLoader.createInstance("newface");
    this.scene.add(inst.root);
    const character: AnimatedCharacter = {
      root: inst.root,
      groundPos: new THREE.Vector2(x, z),
      facingY: 0,
      action: "walk",
      phase: 0,
      seatHeight: 0,
      skeletal: inst.controller,
    };
    this.animator.add(character);
    return {
      dispose: () => { inst.controller.stop(); inst.root.parent?.remove(inst.root); this.animator.remove(inst.root); },
      setSit: (sit: boolean) => { character.action = sit ? "sit" : "walk"; },
    };
  }

  /** DEBUG: drop one RIGGED GLB model at (x,z) to eyeball scale, facing, and
   * animation (and confirm the meshopt-compressed GLB rig survived) before the
   * cast is wired into the real spawners. window hook: cozyRiggedChar(id). */
  async debugSpawnRigged(modelId: string, x = 0, z = 2): Promise<{ dispose: () => void; setSit: (sit: boolean) => void }> {
    const inst = await this.riggedLoader.createInstance(modelId);
    this.scene.add(inst.root);
    const character: AnimatedCharacter = {
      root: inst.root,
      groundPos: new THREE.Vector2(x, z),
      facingY: 0,
      action: "walk",
      phase: 0,
      seatHeight: 0,
      skeletal: inst.controller,
    };
    this.animator.add(character);
    return {
      dispose: () => { inst.controller.stop(); inst.root.parent?.remove(inst.root); this.animator.remove(inst.root); },
      setSit: (sit: boolean) => { character.action = sit ? "sit" : "walk"; },
    };
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
    // Phase M.16 — guest cutover (mirrors staffMove in StaffRouter.update).
    // When ?serverSim=guestMove is on the SERVER fully owns guest spawning +
    // the state machine + patience + locomotion (tick_guest_state /
    // try_server_spawn_guest run every tick with no owner-online gate). The
    // client stops running its local sim entirely and just renders each guest
    // from its subscribed active_guest row: lerp the body toward the server
    // pose, drive the pose/bubble from the server state. This early return
    // skips the local spawn, the local state machine, the patience tick, AND
    // streamGuestPositionsToCloud below — so the client can no longer clobber
    // the server's authoritative state (the upward STATE mirror was the root
    // of the "0 guests eating" divergence). Server-spawned rows still
    // materialise locally via the onInsert → importCloudGuest bridge, and
    // onDelete despawns them; those are flag-independent. Opt-in (default
    // false); roll back by removing the URL param.
    if (isServerSim("guestMove")) {
      // Expire dirty-seat timers (pure local bookkeeping, never mirrored UP)
      // then render every guest straight from its server row. No local spawn,
      // no state machine, no patience tick, no position streaming — exactly
      // like StaffRouter's staffMove branch.
      if (this.dirtyUntil.size > 0) {
        for (const [seatId, cleanAt] of this.dirtyUntil) {
          if (cleanAt <= this.elapsed) this.dirtyUntil.delete(seatId);
        }
      }
      for (const g of this.guests) this.renderGuestFromServer(g, dt);
      return;
    }
    // Flag semantics rewritten: the original `isServerSim("guests")`
    // intent was "skip local sim, server is authoritative". Phase H
    // proved that doesn't work — the server-side state machine for
    // seat assignment / orders / plates isn't implemented, so flag-on
    // stopped customer spawning entirely (commit ec03b65 was the
    // emergency revert).
    //
    // New semantic: the flag means "additionally mirror to cloud" —
    // local sim continues to run as the source of truth, mirror
    // helpers (mirrorGuestSpawn, mirrorGuestLeaving, streamGuestPositionsToCloud)
    // populate active_guest rows for visit mode + future cutover.
    // reconcileServerGuests is no longer called from here — visit
    // mode has its own dedicated subscription path
    // (VisitMode.startLiveCustomerSubscription) so the legacy reconcile
    // loop is redundant.
    //
    // Net effect when the flag is ON:
    //   - Local sim runs unchanged (guests spawn, walk, eat, leave)
    //   - Mirror writes fire so the cloud row tracks each guest
    //   - Visitors see the live state via their own subscription
    // When OFF, mirror writes silently skip — same as before.
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
    // Phase 9.1 — Foreground client spawn is GATED OFF when server
    // owns spawning (the default since Phase 9.1 dropped the
    // try_server_spawn_guest owner_online check). Server runs
    // continuously and is the sole writer of active_guest rows;
    // the new server-driven onInsert subscription handler then calls
    // importCloudGuest so a server-spawned row materialises locally.
    //
    // Without this gate, the local spawn fires once a second AND the
    // server fires every ~5.5 s on its own clock — a double-spawn
    // race that filled the restaurant past capacity within seconds.
    //
    // The cooldown still advances so when serverOwnsGuestSpawn is
    // off (admin override / future flag) the original cadence
    // applies; only the spawn call itself is gated.
    // Phase M.16 — guestMove reaches here only if it's OFF (the early
    // return above bails when it's on), so this expression is unchanged in
    // practice; the extra term just documents that either flag hands spawn
    // ownership to the server.
    const serverOwnsGuestSpawn = (isServerSim("guests") || isServerSim("guestMove"))
      && this.cloud?.isConnectionLive() === true;
    if (this.restaurantOpen && this.spawnCooldown <= 0 && (this.countAvailableSeats() > 0 || this.canAcceptWaitingGuest())) {
      if (!serverOwnsGuestSpawn) {
        void this.spawnGuest();
      }
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
    //
    // Phase 6.1 — When the server owns guest state, its tick_guest_state
    // ticks patience_ms (all patience-active states: walkingIn, seated,
    // ordering, waitingForFood, eating) and flips the guest to "leaving"
    // when it hits zero. The bridge below (reconcileCloudGuest) catches
    // that transition and applies the local angry-leave side-effects
    // (record lost + rating ding + cancelTicket + settleGuestDishes +
    // optional leftover plate). Without this gate the LOCAL tickPatience
    // would race the server: both would countdown independently, double-
    // firing recordLost / recordRating, and the server's broader patience
    // coverage (ordering, eating) would never reach the local side
    // effects because tickPatience only handles seated + waitingForFood.
    const localOwnsPatience = !this.serverOwnsGuestStates();
    for (let i = this.guests.length - 1; i >= 0; i -= 1) {
      const g = this.guests[i];
      if (localOwnsPatience) this.tickPatience(g, dt);
      else this.tickPatienceDisplay(g, dt);
      this.tickGuest(g, dt);
      this.tickStuckRecovery(g, dt);
      // Remove guest if they finished walking out — OR if they've been
      // trying to leave for an absurd amount of time (got stuck in a
      // crowd, target unreachable, etc.). Without this safety, a stuck
      // walker holds their seat in `occupiedSeats` forever and the
      // restaurant slowly seizes up.
      const stuckLeaving =
        (g.state === "walkingOut" || g.state === "walkingToDoor" || g.state === "exitingDoor") && g.stateClock > 8;
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
  /** Phase 9.32 — Display-only patience countdown for server-canonical
   * mode. The server owns the authoritative patience_ms AND the
   * angry-leave transition; reconcileCloudGuest snaps g.patience to the
   * cloud value on every push. Between those ~500ms pushes we decrement
   * locally so the "Ns" above the guest ticks down smoothly each frame
   * instead of stepping in server-tick jumps. NEVER fires angry-leave —
   * that's the server's call. Clamped at 0 so the label shows "0s"
   * rather than going negative while the server's next tick flips them
   * to leaving. */
  private tickPatienceDisplay(g: ActiveGuest, dt: number): void {
    if (g.state !== "seated" && g.state !== "waitingForFood") return;
    if (g.patience > 0) g.patience = Math.max(0, g.patience - dt);
  }

  private tickPatience(g: ActiveGuest, dt: number): void {
    if (g.state !== "seated" && g.state !== "waitingForFood") return;
    g.patience -= dt;
    if (g.patience > 0) return;
    // Patience exhausted — angry exit. Route via the door. With
    // serverOwnsGuestStates() gating the caller, this path is dormant
    // in the new world; the bridge below fires applyServerAngryLeave
    // instead and tracks the broader set of patience-active states.
    this.applyAngryLeave(g);
  }

  /** Shared angry-exit side-effect pipeline used by both the legacy
   * local tickPatience and the Phase 6.1 server-bridge angry-leave
   * path. Extracted so the two callsites never drift.
   *
   * Side effects fired in order:
   *   - record one lost customer + 1★ rating ding
   *   - "-1★ (gave up)" pop + thud sfx so the player sees + hears it
   *   - cancel any pending order request / in-flight ticket so a
   *     waiter walking toward the now-empty seat gets pulled off
   *     immediately instead of completing a wasted trip
   *   - route every dishware reservation through settleGuestDishes
   *     (eaten courses → dirty, in-flight courses → clean pool)
   *   - if the guest ate at least one course, leave a dirty plate +
   *     leftover mesh on the table so the player can see what they
   *     missed
   *   - walk to the door + planPath + state = walkingToDoor so the
   *     position step animates the exit (server's leaving-variant
   *     dwell timer then deletes the cloud row)
   */
  private applyAngryLeave(g: ActiveGuest): void {
    this.game.customers.recordLost(1);
    // Phase 7.8 — Server's accumulate appends the 1★ angry rating to
    // cloud_rating_history_csv at despawn time; the cloud_rating
    // subscription handler flows it back into local ratingHistory.
    // Skipping the local recordRating here avoids double-recording.
    // We KEEP recordLost (it's just a daily counter that doesn't
    // round-trip through cloud_money_cents).
    if (!this.serverOwnsGuestStates()) {
      this.game.reputation.recordRating(1);
    }
    this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, "-1★ (gave up)", "#ff9a9a", g.currentFloor);
    this.sfx?.thud();
    this.router.cancelTicket(g.id);
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

  /** Phase 6.1 — server-bridge entry point for an angry leave. Skips
   * if the local guest is already on the walk-out path (idempotent
   * against reconnect re-deliveries of the same "leaving" row). The
   * server's "leaving" / "done" strings never reach a local guest's
   * state field — the bridge sets walkingToDoor on this path and the
   * client's leave handlers carry it through exitingDoor → walkingOut. */
  private applyServerAngryLeave(g: ActiveGuest): void {
    if (g.state === "walkingToDoor" || g.state === "exitingDoor"
        || g.state === "walkingOut") {
      return;
    }
    this.applyAngryLeave(g);
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
    // H.20 — claim the settle on the cloud row BEFORE the local
    // mutations so the server's despawn-time settle path becomes a
    // no-op when its turn arrives. Without this the client's pool
    // mirror (absolute counts via mirrorPool) and the server's
    // settle (deltas via bump_dishware) would both apply, double-
    // counting every eaten plate / refunded reservation.
    if (isServerSim("guests") && this.cloud && g.serverMirrorId != null) {
      this.cloud.markGuestDishesSettled(g.serverMirrorId);
    }
    // Eaten courses become dirty.
    for (let i = 0; i < g.orderIndex && i < g.reservedDishTiers.length; i += 1) {
      const recipe = g.order[i];
      if (!recipe) continue;
      const kind: DishKind = recipe.category === "drink" ? "glass" : "plate";
      this.game.dishware.markDirty(kind, g.reservedDishTiers[i]);
    }
    // In-flight (not-yet-eaten) reservations return to the clean pool.
    // Pass force=true so the cap check never drops the restored
    // reservation — these dishes were already counted in lifetime at
    // beginNextCourse's reserveOne. Without force, a guest leaving
    // while storage is at cap silently loses the unstarted course's
    // plate, which over many sessions surfaces as "LEAK N" in the
    // dishware tooltip.  See DishwareSystem.addClean for the cap
    // rationale.
    for (let i = g.orderIndex; i < g.reservedDishTiers.length; i += 1) {
      const recipe = g.order[i];
      if (!recipe) continue;
      const kind: DishKind = recipe.category === "drink" ? "glass" : "plate";
      this.game.dishware.addClean(kind, g.reservedDishTiers[i], 1, true);
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
    // H.11 — mirror the full course list to the server so the tick
    // reducer drives the eating cycle. Idempotent + bails when flag
    // is off OR the server id isn't resolved yet.
    this.mirrorGuestOrder(g);
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

  /** Phase C.3b — resolve a local guest id ("guest-7") to its
   * mirrored server-side auto-inc u64. Returns undefined when the
   * guest isn't mirrored (flag off, or pre-resolve window). The
   * Engine wires this onto StaffRouter so the ticket-mirror flow
   * can supply the server-side guest_id to placeOrder. */
  lookupGuestServerId(localGuestId: string): bigint | undefined {
    for (const g of this.guests) {
      if (g.id === localGuestId) return g.serverMirrorId;
    }
    return undefined;
  }

  /** Reverse of lookupGuestServerId: given a server-side u64 guest id,
   * return the matching local guest's string id (or undefined when
   * the guest isn't represented locally, e.g. the cloud row points
   * at a guest the H.47 hydrate hadn't yet imported).  Used by
   * StaffRouter.hydrateTicketsFromCloud to map active_ticket.guest_id
   * back to a local Guest. */
  findLocalGuestIdByServerId(serverId: bigint): string | undefined {
    for (const g of this.guests) {
      if (g.serverMirrorId === serverId) return g.id;
    }
    return undefined;
  }

  // ======================================================================
  //          Phase H Phase 3 — server-authoritative guest bridge
  // ======================================================================
  // Subscribes to active_guest cloud changes and applies server-driven
  // state transitions onto local guests, firing the matching visual
  // side effects (showPlateForGuest, chime, etc.). Mirrors the pattern
  // StaffRouter.attachServerBridge uses for tickets + staff.
  //
  // Coverage in Phase 3a (this commit):
  //   - waitingForFood → eating: show plate + chime.
  //
  // Out of scope until Phase 3b: course-advance side effects
  // (creditCourse, removePlate, beginNextCourse), leaving cascade,
  // WC trip transitions.

  /** True when the server is the sole owner of guest state transitions
   * (mirrors the chef/waiter gating pattern from Phase 1). */
  private serverOwnsGuestStates(): boolean {
    return isServerSim("guests") && this.cloud?.isConnectionLive() === true;
  }

  private guestServerBridgeAttached = false;

  /** Find a local guest by its server-side auto-inc id. */
  private findLocalGuestByServerId(id: bigint): ActiveGuest | undefined {
    for (const g of this.guests) {
      if (g.serverMirrorId === id) return g;
    }
    return undefined;
  }

  /** Attach the cloud subscription bridge. Called once after the
   * spawner's cloud handle is wired. No-op if already attached. */
  attachGuestServerBridge(): void {
    if (!this.cloud || this.guestServerBridgeAttached) return;
    // Phase 9.2 — Same boot-race guard as hydrateFromCloud. The
    // subscribe call below silently registers NOTHING when conn or
    // restaurantId is missing; latching the flag on that no-op left
    // the bridge permanently dead whenever GLB loads finished before
    // login did. Engine retries at 1 Hz until the context exists.
    if (!this.cloud.hasRestaurantContext()) return;
    this.guestServerBridgeAttached = true;
    this.cloud.subscribeActiveGuestChanges({
      // Phase 9.1 — Server is now the sole spawner (owner_online gate
      // dropped). New active_guest rows arrive via onInsert; we
      // materialise the corresponding local guest the same way
      // hydrateFromCloud does on reload. The lookup gate filters
      // duplicates: a row we already imported (or one a still-live
      // local spawn raced in before this flag flipped) doesn't get
      // a second character. The subscription handler only carries
      // the slim ActiveGuestRow; we re-fetch the row by id to get
      // the full HydratableGuestRow shape importCloudGuest needs
      // (taste columns, waiting columns, state-clock).
      onInsert: (row) => {
        if (this.findLocalGuestByServerId(row.id)) return;
        if (!this.cloud) return;
        const hydratable = this.cloud.getHydratableGuest(row.id);
        if (!hydratable) {
          // The slim subscription row can land a tick before the indexed
          // row getHydratableGuest reads — dropping here left a paid,
          // server-spawned customer invisible for the rest of the session.
          // Retry once shortly after; the dedup guard above prevents a
          // double import if the row resolves in the meantime.
          window.setTimeout(() => {
            if (!this.cloud || this.findLocalGuestByServerId(row.id)) return;
            const late = this.cloud.getHydratableGuest(row.id);
            if (!late) {
              console.warn(`[Spawner/Bridge] onInsert: row ${row.id} never resolved (dropped)`);
              return;
            }
            if (late.clientTempId && this.guests.some((g) => g.id === late.clientTempId)) return;
            void this.importCloudGuest(late).catch((e) =>
              console.warn("[Spawner/Bridge] importCloudGuest (deferred) failed:", e));
          }, 150);
          return;
        }
        if (hydratable.clientTempId
            && this.guests.some((g) => g.id === hydratable.clientTempId)) return;
        void this.importCloudGuest(hydratable).catch((e) =>
          console.warn("[Spawner/Bridge] importCloudGuest on insert failed:", e));
      },
      onUpdate: (row) => this.reconcileCloudGuest(row),
      // Phase 9.1 — Server-driven despawn. When the server deletes
      // an active_guest row (leaving dwell expired, etc.), the
      // local character vanishes too. Without this gate, a
      // server-despawned guest would linger locally as a ghost
      // until the next reload's hydrateFromCloud reconciliation.
      onDelete: (id) => {
        const idx = this.guests.findIndex((g) => g.serverMirrorId === id);
        if (idx >= 0) this.despawnGuest(idx);
      },
    });
    console.log("[Spawner/Bridge] guest cloud bridge attached (insert+update+delete)");
  }

  /** Apply a cloud active_guest row's state transitions to the local
   * guest. State writes are guarded on "differs from local" so the
   * bridge is idempotent — re-applying the same row is a no-op. */
  private reconcileCloudGuest(row: import("../cloud/SpacetimeClient").ActiveGuestRow): void {
    const g = this.findLocalGuestByServerId(row.id);
    if (!g) return; // no local guest yet — onInsert handles creation

    // Phase M.16 — guest cutover. Stash the authoritative server pose +
    // state so update()'s guestMove render loop (renderGuestFromServer)
    // can lerp the body toward it and drive the pose/bubble from the
    // server truth. Cheap; unused while guestMove is off (identical
    // discipline to reconcileCloudStaffActor). Snapshot-interp: when the
    // pose actually moves, shift the previous-pose anchor + reset the
    // 0→1 interp clock so the body glides from the old pose to this one
    // over the ~0.5s tick instead of snapping then stalling. First update
    // (no prior pose) starts settled (interp 1).
    if (g.cloudX === undefined
        || Math.hypot(row.x - g.cloudX, row.z - (g.cloudZ ?? row.z)) > 1e-4) {
      g.cloudPrevX = g.cloudX ?? row.x;
      g.cloudPrevZ = g.cloudZ ?? row.z;
      g.cloudInterp = g.cloudX === undefined ? 1 : 0;
    }
    g.cloudX = row.x;
    g.cloudZ = row.z;
    g.cloudFloor = row.floor;
    g.cloudState = row.state;

    // Phase 9.32 — keep the local patience clock in lockstep with the
    // server's authoritative patience_ms so the countdown above a
    // guest's head actually RUNS. In server-canonical mode the local
    // tickPatience decrement is gated off, and patience was previously
    // only written on hydrate + course transitions — so the on-screen
    // "Ns" froze at its last value. The server decrements patience_ms
    // each tick and pushes the row, so this refreshes the display every
    // update; tickPatienceDisplay smooths the gaps between pushes.
    if (this.serverOwnsGuestStates()) {
      g.patience = Number(row.patienceMs) / 1000;
    }

    // Phase H Phase 4d — populate local g.order from cloud's
    // order_recipes CSV when empty. With Phase 4b gating the local
    // buildOrder, foreground guests get their orders built
    // server-side (Phase 4c). The bridge mirrors the resulting CSV
    // back into local Recipe objects so creditCourse + the eating
    // visual cues (plate food color) work correctly.
    if (g.order.length === 0 && row.orderRecipes.length > 0) {
      const recipeIds = row.orderRecipes.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const builtOrder: import("../data/types").RecipeDefinition[] = [];
      for (const id of recipeIds) {
        const r = recipes.find((x) => x.id === id);
        if (r) builtOrder.push(r);
      }
      if (builtOrder.length > 0) {
        g.order = builtOrder;
        g.orderTaken = true;
        console.log(`[Spawner/Bridge] hydrated g.order for guest ${g.id} from cloud (${builtOrder.length} courses)`);
      }
    }

    // Phase 9.6 — server promoted a waiting guest onto a freed seat
    // (try_promote_waiting_guest flipped waiting → walkingIn with the
    // seat fields populated). Adopt the seat + walk them over. The
    // local promoteWaitingGuests is gated under serverOwnsGuestStates
    // so this bridge is the only promotion path.
    if (g.state === "waitingForSeat" && row.state === "walkingIn" && row.seatUid) {
      if (g.waiting) {
        this.claimedWaitingChairs.delete(g.waiting.chairUid);
        g.waiting = undefined;
      }
      g.seatId = row.seatUid as SeatId;
      g.seatPos.set(row.seatX, row.seatZ);
      g.seatFloor = row.seatFloor;
      g.platePos.set(row.seatX, row.seatZ);
      this.occupiedSeats.add(row.seatUid as SeatId);
      g.target = new THREE.Vector2(row.seatX, row.seatZ);
      this.planPath(g);
      g.passedExterior = true;
      g.passedDoor = true;
      g.state = "walkingIn";
      g.character.action = "walk";
      g.stateClock = 0;
      console.log(`[Spawner/Bridge] waiting guest ${g.id} promoted → seat ${row.seatUid}`);
    }

    // waitingForFood → eating: server saw a delivered ticket bound to
    // this guest. Fire the local "plate landed" effects. Without this
    // bridge step the local case "waitingForFood" handler runs the
    // same logic via popDeliveredFor; with serverOwnsGuestStates on,
    // the local handler is gated off and the bridge is the only path.
    if (g.state === "waitingForFood" && row.state === "eating") {
      g.state = "eating";
      g.stateClock = 0;
      this.showPlateForGuest(g);
      this.sfx?.chime();
      // Also drop the local Ticket entry for this guest so the
      // popDeliveredFor / cancelTicket bookkeeping stays clean.
      // StaffRouter's bridge will eventually do this when the cloud
      // ticket delete arrives, but doing it now keeps the local sim's
      // ticket array in sync with what the player sees.
      this.router.popDeliveredFor(g.id);
    }

    // Phase 6.1 — angry-leave bridge. Server's tick_guest_state flips
    // a guest to "leaving" via patience_ms hitting zero from any
    // patience-active state (walkingIn / seated / ordering /
    // waitingForFood / eating). The transitions below catch each
    // source-state → leaving combination that's UNAMBIGUOUSLY a
    // patience timeout (no other server path produces it) and fire the
    // same side effects the old local tickPatience used to:
    //   - record lost customer
    //   - record a 1★ rating
    //   - cancel any pending order request / in-flight ticket so a
    //     waiter doesn't keep walking toward the now-empty seat
    //   - settle reserved dishes (return in-flight clean to the pool,
    //     mark eaten ones dirty)
    //   - if any courses were already eaten, leave a dirty plate +
    //     leftover mesh on the table so the player sees what they
    //     missed
    //   - route the local walk to the door + flip local state to
    //     walkingToDoor so the position step animates the exit
    //
    // The `eating → leaving` case is AMBIGUOUS — either patience timed
    // out mid-meal (rare; "took too long between courses") OR the
    // final course finished naturally. patience_ms == 0n is the
    // discriminator: natural finish leaves patience > 0 (it decrements
    // during eating but doesn't get pinned to zero); patience-timeout
    // explicitly pins it to zero in the transition update. Falls
    // through to the existing finalize-visit happy path on patience > 0.
    if (row.state === "leaving") {
      // Local GuestState doesn't model "ordering" — local sim collapses
      // it into seated → waitingForFood — so the angry-from-ordering
      // case is naturally caught by `seated`.
      //
      // Phase 6.1b — Yellow-chair waiting timeout. Server's
      // is_waiting_state branch in tick_guest_state decrements
      // waiting_timeout_ms and flips waitingForSeat/walkingToWait →
      // leaving when it hits zero. Distinct from the patience timer
      // (waiting_timeout_ms is its own clock — patience doesn't tick
      // during waiting), so patience_ms isn't a signal here; we
      // dispatch on source state alone. Cleanup also has to release
      // the yellow chair claim + clear g.waiting before
      // applyServerAngryLeave runs the rest of the pipeline.
      const angryFromWaiting =
        g.state === "waitingForSeat" || g.state === "walkingToWait";
      const angryFromNonEating =
        g.state === "seated" || g.state === "waitingForFood"
          || g.state === "walkingIn";
      const angryFromEating = g.state === "eating" && row.patienceMs === 0n;
      if (angryFromWaiting) {
        if (g.waiting) {
          this.claimedWaitingChairs.delete(g.waiting.chairUid);
          g.waiting = undefined;
        }
        this.applyServerAngryLeave(g);
        return;
      }
      if (angryFromNonEating || angryFromEating) {
        this.applyServerAngryLeave(g);
        return;
      }
    }

    // eating → leaving (HAPPY finish): server saw EATING_DURATION_MS
    // elapse on the FINAL course (server's tick_guest_state checks
    // order_index + 1 == total_courses). Fire the visit-completion
    // cascade locally: credit the final course, clear the plate, run
    // finalize (rating, tip, leftover meshes), and start the walk to
    // the door. The patience-timeout branch above already short-
    // circuited the patience case via `return`, so this is the
    // natural-finish path only.
    if (g.state === "eating" && row.state === "leaving") {
      this.creditCourse(g);
      this.removePlateForGuest(g.id);
      g.orderIndex = Math.min(g.order.length, row.orderIndex);
      this.finalizeVisit(g);
      g.character.action = "walk";
      g.target = DOOR_POSITION.clone();
      this.planPath(g);
      g.state = "walkingToDoor";
      g.stateClock = 0;
    }

    // eating → waitingForFood (Phase 9.26 — was eating→seated): the
    // server's intermediate course advance. The waiter took the whole
    // order in one visit, so a finished course goes STRAIGHT to
    // waiting-for-the-next-plate (no re-order trip). The local handler
    // would have called beginNextCourse; with the server in charge
    // that's gated off, so the bridge fires the matching local effects:
    //   - credit the just-finished course
    //   - remove the plate
    //   - sync orderIndex from cloud (server bumped it)
    //   - patience reset
    //   - reserve a clean dish for the next course (local pool is still
    //     the dishware source)
    //   - mirror reserved tiers so settle_guest_dishes sees it on despawn
    // Skips enqueueOrder — server's auto_place_next_course already
    // created the next ticket when it flipped to waitingForFood. Guard
    // on g.orderIndex < row.orderIndex so this only fires on the COURSE
    // ADVANCE, not the ordinary waitingForFood the guest is already in.
    if (g.state === "eating" && row.state === "waitingForFood"
        && row.orderIndex > g.orderIndex) {
      this.creditCourse(g);
      this.removePlateForGuest(g.id);
      g.orderIndex = Math.min(g.order.length, row.orderIndex);
      g.patience = SERVE_PATIENCE_BASE_SECONDS * g.archetype.patienceMultiplier;
      const recipe = g.order[g.orderIndex];
      if (recipe) {
        const kind: "plate" | "glass" = recipe.category === "drink" ? "glass" : "plate";
        const reservedTier = this.game.dishware.reserveOne(kind);
        if (reservedTier !== null) {
          g.reservedDishTiers.push(reservedTier);
          g.lastMirroredReservedTiers = undefined;
          this.mirrorGuestReservedTiers(g);
        }
      }
      g.state = "waitingForFood";
      g.stateClock = 0;
    }

    // Phase H Phase 5w — WC trip transitions. Server's tick_guest_state
    // owns the seated → wcWalking → wcSitting → wcWashing → seated
    // sequence + the toilet/sink picking; bridge maps each transition
    // onto the local 6-state walk machine (seated → walkingToToilet →
    // atToilet → walkingToSink → atSink → returningFromToilet →
    // seated). The cloud row's target_x/z gives us the picked-fixture
    // position; the local sim still owns the actual walk via
    // moveToward + planPath, and the dwell-state arrival flips
    // (walkingToToilet → atToilet etc.) still fire on the local
    // arrival check. With this bridge plus the seated-handler /
    // atToilet-handler / atSink-handler gates below, every WC trip
    // decision lives server-side.

    // seated → wcWalking: server picked a fixture. Local walks toward
    // its position. willWashOnly guests skip the toilet leg and walk
    // straight to a sink.
    if (g.state === "seated" && row.state === "wcWalking") {
      g.returnSeatPos = g.seatPos.clone();
      g.target = new THREE.Vector2(row.targetX, row.targetZ);
      // Phase 9.22 — CRITICAL for cross-floor WC: tell the local
      // stair-aware pathfinder which floor the fixture is on. Without
      // this, pickPathTargetFloor defaults to the guest's CURRENT
      // floor and routes them flat to the fixture's x/z — they
      // "use" a bathroom a storey away instead of climbing the
      // stairs. row.targetFloor carries the server's fixture floor.
      if (g.willWashOnly) {
        g.sinkFloor = row.targetFloor;
        // Face the basin on arrival (atSink reads g.sinkRotY). The server only
        // sends the stand spot, so find the sink whose stand spot matches it.
        const sink = this.registry?.getBathroomSinks().find((s) =>
          s.floor === row.targetFloor
          && Math.hypot(s.standPos.x - row.targetX, s.standPos.y - row.targetZ) < 1.0);
        if (sink) g.sinkRotY = sink.rotY;
      } else {
        g.toiletFloor = row.targetFloor;
        // CRITICAL: the server only sends the in-front STAND spot (target_x/z),
        // NOT the bowl. Without g.toiletCenter the atToilet handler can't snap
        // the guest ONTO the toilet, so a server/visitor-driven guest sits in
        // FRONT of it (the "wrong place in the WC" bug). Find the toilet whose
        // stand spot matches the target and set its centre + facing so the
        // atToilet snap lands on the bowl.
        const toilet = this.registry?.getToilets().find((t) =>
          t.floor === row.targetFloor
          && Math.hypot(t.standPos.x - row.targetX, t.standPos.y - row.targetZ) < 1.0);
        if (toilet) {
          g.toiletCenter = new THREE.Vector2(toilet.x, toilet.z);
          g.toiletRotY = toilet.rotY;
          g.toiletUid = toilet.uid;
        }
      }
      g.state = g.willWashOnly ? "walkingToSink" : "walkingToToilet";
      g.stateClock = 0;
      g.character.action = "walk";
      this.planPath(g);
    }

    // wcSitting → wcWashing: server's "done with toilet, walk to sink"
    // transition. The cloud row's target_x/z just swapped from toilet
    // → sink. Local guest is at (or near) the toilet — flush, restore
    // chair-height, then walk to the server-picked sink. wash-only
    // guests don't go through wcSitting; this only fires for the
    // willUseToilet flow.
    //
    // Local-state check includes BOTH atToilet and walkingToToilet:
    // server's wcSitting dwell can elapse before the local 60 Hz sim
    // physically arrives at the toilet (server's position is 2 Hz
    // interpolated). When that race hits, the bridge needs to skip
    // ahead to walkingToSink rather than leaving the guest stuck
    // mid-walk to a toilet they'd never use. The transition's
    // condition naturally rate-limits itself: after firing, g.state
    // becomes walkingToSink and the OR clause is false on subsequent
    // ticks.
    // Require the local guest to have ACTUALLY arrived at the toilet
    // (atToilet) before advancing to the sink. The old version also accepted
    // walkingToToilet — and because the server's position model straight-
    // lines to the fixture (ignoring walls) and finishes the WC faster than
    // the client can route there, that teleported the guest on to the
    // sink/seat while it was still walking, so it "used the toilet from its
    // chair" without ever arriving. A guest that genuinely can't reach the
    // fixture is rescued by the WC_WALK_GIVEUP fallback in the walk handlers,
    // so waiting for real arrival here can't strand it.
    const onToiletSide = g.state === "atToilet";
    if (onToiletSide && row.state === "wcWashing") {
      this.sfx?.toiletFlush();
      if (g.originalSeatHeight !== undefined) {
        g.character.seatHeight = g.originalSeatHeight;
        g.originalSeatHeight = undefined;
      }
      g.usedToilet = true;
      g.toiletAttemptComplete = true;
      g.target = new THREE.Vector2(row.targetX, row.targetZ);
      // Phase 9.22 — the sink may be on a different floor than the
      // toilet; route the walk-to-sink leg with stairs too.
      g.sinkFloor = row.targetFloor;
      g.state = "walkingToSink";
      g.stateClock = 0;
      g.character.action = "walk";
      this.planPath(g);
    }

    // Catch-up: the server finished the WHOLE trip (seated) while the local
    // guest only just reached the toilet — there's no sink leg to walk to
    // (the row now targets the seat), so flush + head straight back rather
    // than holding at the bowl. Without this, requiring atToilet above could
    // strand a guest whose server-side wash elapsed before it arrived.
    if (g.state === "atToilet" && row.state === "seated") {
      this.sfx?.toiletFlush();
      if (g.originalSeatHeight !== undefined) {
        g.character.seatHeight = g.originalSeatHeight;
        g.originalSeatHeight = undefined;
      }
      g.usedToilet = true;
      g.toiletAttemptComplete = true;
      g.target = (g.returnSeatPos ?? g.seatPos).clone();
      g.returnSeatPos = undefined;
      g.state = "returningFromToilet";
      g.stateClock = 0;
      g.character.action = "walk";
      this.planPath(g);
    }

    // wcWashing → seated: server's "done washing, return to seat".
    // Local guest is at (or near) the sink. Flag washedHands, restore
    // walking pose, head back to the dining seat. Same mid-walk
    // robustness as above — include walkingToSink in the local-side
    // check so a race doesn't strand the guest.
    // Same "require real arrival" rule as the toilet leg above — was
    // atSink || walkingToSink, which skipped the wash for the same race.
    const onSinkSide = g.state === "atSink";
    if (onSinkSide && row.state === "seated") {
      g.washedHands = true;
      g.washAttemptComplete = true;
      g.target = (g.returnSeatPos ?? g.seatPos).clone();
      g.returnSeatPos = undefined;
      g.state = "returningFromToilet";
      g.stateClock = 0;
      g.character.action = "walk";
      this.planPath(g);
    }
  }

  // ======================================================================
  //              Phase I.1 — H.47 cloud hydrate on reconnect
  // ======================================================================
  //
  // Bridges the gap between save-snapshot restore and the live server
  // state.  On a fresh tab, the save brings back whatever guests existed
  // at the last autosave, but the server's active_guest table has the
  // CURRENT state (including any H.33-spawned offline guests + state
  // transitions the server ran while we were closed).  hydrateFromCloud
  // reconciles the two:
  //
  //   1. Local guests whose serverMirrorId is no longer in active_guest
  //      get despawned (server already settled them while offline).
  //   2. Cloud rows not represented locally get imported as functional
  //      Guests so the local sim picks up where the server left off.
  //
  // Engine calls this from onSubscriptionReady AFTER save load AND
  // spawner construction.  Idempotent on repeated calls (no-op when
  // local + cloud already agree).

  /** True once hydrateFromCloud has run at least once.  Stops repeat
   * calls (subscription re-readys, multi-tab swaps) from
   * double-importing.  Cleared by despawnAllForReset / equivalent
   * paths if we ever wire a "rejoin" flow. */
  private cloudHydrated = false;

  async hydrateFromCloud(): Promise<void> {
    if (!this.cloud) return;
    if (this.cloudHydrated) return;
    // Phase 9.2 — Don't latch during the boot window. Engine's
    // staffReady callback fires this on GLB load completion, which
    // races the auth + subscription flow; before restaurantId is
    // resolved listActiveGuests() returns [] unconditionally, and
    // latching on that empty answer left the hydrate permanently
    // dead (the "reload shows an empty restaurant" bug). Engine
    // retries at 1 Hz until the context exists.
    if (!this.cloud.hasRestaurantContext()) return;
    const cloudRows = this.cloud.listActiveGuests();
    // Don't latch on an EMPTY answer during the boot race. Guest rows can
    // lag the restaurant id into the subscription cache, and latching
    // there leaves the hydrate permanently dead — so guests trickle in
    // one-by-one walking from the door on reload instead of appearing
    // already at their seats. Staff rows co-arrive in the same snapshot
    // and every restaurant has staff, so their presence is a reliable
    // "snapshot applied" proxy: only treat an empty guest list as real
    // (and latch) once the snapshot has demonstrably landed.
    const snapshotApplied = this.cloud.listStaffActors().length > 0;
    if (cloudRows.length === 0 && !snapshotApplied) return; // retry next tick
    // Even if cloud is genuinely empty, mark hydrated so we don't retry.
    this.cloudHydrated = true;
    if (cloudRows.length === 0 && this.guests.length === 0) {
      return;
    }
    // ---- 1. Despawn locals whose cloud row vanished --------------
    const cloudIdSet = new Set<bigint>();
    for (const r of cloudRows) cloudIdSet.add(r.id);
    for (let i = this.guests.length - 1; i >= 0; i--) {
      const g = this.guests[i];
      if (g.serverMirrorId != null && !cloudIdSet.has(g.serverMirrorId)) {
        if (DEBUG_GUEST_LOGS) {
          console.log(`[H.47] despawn local guest ${g.id} (server already settled)`);
        }
        this.despawnGuest(i);
      }
    }
    // ---- 2. Import cloud rows not represented locally ------------
    const localServerIds = new Set<bigint>();
    const localTempIds = new Set<string>();
    for (const g of this.guests) {
      if (g.serverMirrorId != null) localServerIds.add(g.serverMirrorId);
      localTempIds.add(g.id);
    }
    const importPromises: Promise<void>[] = [];
    for (const row of cloudRows) {
      // Skip if already represented (by serverMirrorId or matching
      // client_temp_id from the save's local id namespace).
      if (localServerIds.has(row.id)) continue;
      if (row.clientTempId && localTempIds.has(row.clientTempId)) continue;
      importPromises.push(this.importCloudGuest(row));
    }
    const results = await Promise.allSettled(importPromises);
    let imported = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === "fulfilled") imported += 1;
      else failed += 1;
    }
    console.log(`[H.47] hydrateFromCloud: ${imported} guests imported, ${failed} failed (cloud had ${cloudRows.length} rows, local has ${this.guests.length})`);

    // Phase I (H.70) — post-hydrate kickstart.  Two fixes for the
    // user-reported "I log in, nothing changes" symptom:
    //
    //   1. Pre-warm spawnCooldown to 0 so the very next update tick
    //      fires a fresh spawn.  Without this the cooldown sat at
    //      its 1.0 s boot default and then re-armed to 5.5 s on the
    //      first spawn — meaning ~6.5 s of dead air after login
    //      where the only "customers" were ones from the prior
    //      session finishing up their meal.
    //
    //   2. Burst-spawn enough guests to bring the restaurant up to
    //      half its seat capacity (capped at 3 fresh spawns), so
    //      the room feels alive within ~1 second of login.  This
    //      approximates "the world kept going while you were gone"
    //      without needing actual server-side continuous spawning.
    //      Each spawn still respects countAvailableSeats / waiting
    //      capacity, so we can't over-fill.
    if (this.restaurantOpen) {
      this.spawnCooldown = 0;
      const liveGuests = this.guests.length;
      const seats = this.countAvailableSeats() + liveGuests;
      // Under server-authoritative spawning the server fills the room on
      // its own clock — a local burst here races it into over-capacity and
      // a doubled arrival rate, so skip the burst in that mode.
      // Phase M.16 — guestMove also hands spawning to the server, so treat
      // either flag as "server spawns" (matters when testing guestMove alone).
      const serverSpawns = (isServerSim("guests") || isServerSim("guestMove"))
        && this.cloud?.isConnectionLive() === true;
      const target = serverSpawns ? 0 : Math.min(3, Math.max(0, Math.floor(seats / 2) - liveGuests));
      let burstSpawned = 0;
      for (let i = 0; i < target; i += 1) {
        if (this.countAvailableSeats() <= 0 && !this.canAcceptWaitingGuest()) break;
        void this.spawnGuest();
        burstSpawned += 1;
      }
      if (burstSpawned > 0) {
        console.log(`[H.70] post-hydrate burst: spawned ${burstSpawned} guest(s) to fill the restaurant (was ${liveGuests}, target ${liveGuests + burstSpawned})`);
      }
    }
  }

  /** Build one local Guest from a cloud active_guest row.  Loads the
   * character GLB, constructs the AnimatedCharacter, fills in every
   * field with the cloud's value (or a reasonable default for things
   * the cloud doesn't track — plates, path waypoints, taste fields
   * not yet mirrored).  Appends to this.guests on success. */
  private async importCloudGuest(
    row: import("../cloud/SpacetimeClient").HydratableGuestRow,
  ): Promise<void> {
    // Skinned rendering is keyed purely on the guest-id hash, so the variant
    // string stays a real catalog id — we never leak "newface" into the
    // server's guest row (Option A: client-side render choice only).
    const newFace = isNewFaceGuest(row.id);
    const variant = (row.variant && GUEST_VARIANT_IDS.includes(row.variant)) ? row.variant : "guest-v0";
    let model: THREE.Object3D;
    let skeletal: SkeletalDriver | undefined;
    if (newFace) {
      const inst = await this.riggedLoader.createInstance("newface");
      model = inst.root; skeletal = inst.controller;
    } else {
      // Every other guest is now a rigged GLB customer (one of 8, picked by a
      // hash of the guest id) — replacing the old static placeholder meshes.
      // Falls back to the static placeholder if a rigged GLB fails to load.
      try {
        const inst = await this.riggedLoader.createInstance(riggedCustomerForKey(String(row.id)));
        model = inst.root; skeletal = inst.controller;
      } catch (e) {
        console.warn("[GuestSpawner] rigged customer load failed; using placeholder:", e);
        model = await this.characterLoader.load(variant);
      }
    }
    this.scene.add(model);

    const archetype = archetypeFromId(row.archetype);
    const taste = tasteFromCloud(row);
    const state = cloudStateToLocal(row.state);
    const action = actionFromState(state);
    const isSitting = SIT_STATES.has(state);

    // Seat height from action.  Toilet / sink seats use a lower
    // value but we don't differentiate here — that's a Phase I.2
    // fidelity issue.  0.62 matches the dining chair surface. Skinned
    // guests sit via their own clip, so they take no lift.
    // Skeletal guests (all of them now) sit via their own clip → no chair lift.
    const seatHeight = skeletal ? (row.seatAtBar ? BAR_STOOL_LIFT : 0) : (isSitting ? 0.62 : 0);
    // A seated guest must render AT its seat, not at the server's BODY x/z —
    // for a fresh server walk-in that body coord is still the door spawn spot,
    // so a just-seated guest would otherwise appear sitting in the doorway
    // until refreshSeatedGuestPoses resolves the seat (gated on furniture load).
    const atSeat = !!row.seatUid
      && (state === "seated" || state === "waitingForFood" || state === "eating");

    const character: AnimatedCharacter = {
      root: model,
      groundPos: new THREE.Vector2(atSeat ? row.seatX : row.x, atSeat ? row.seatZ : row.z),
      facingY: row.seatFacingY ?? 0,
      action,
      phase: Math.random() * 5,
      seatHeight,
      skeletal,
    };
    this.animator.add(character);

    // Re-parent to the correct storey group if cross-floor.
    if (this.reparentCharacter && row.floor > 0) {
      this.reparentCharacter(character, row.floor);
    }

    const localId = row.clientTempId || `cloud-${row.id}`;
    const order = parseOrderRecipes(row.orderRecipes);
    const reservedDishTiers = parseTiersCsv(row.reservedDishTiers);

    const guest: ActiveGuest = {
      id: localId,
      variantId: variant,
      state,
      character,
      seatId: row.seatUid as SeatId,
      seatPos: new THREE.Vector2(row.seatX, row.seatZ),
      seatFacingY: row.seatFacingY,
      seatFloor: row.seatFloor,
      seatAtBar: row.seatAtBar,
      platePos: new THREE.Vector2(row.plateX || row.seatX, row.plateZ || row.seatZ),
      target: new THREE.Vector2(row.targetX, row.targetZ),
      // A server-spawned guest that already has a seat is, per the server,
      // already inside heading to it — treat it as past the door. Otherwise
      // the (ungated) walkingIn handler walks it to the seat, then BACK to the
      // client door anchor (0,5) — which differs from the server's (0,0) —
      // then forward again, reading as a guest "idling inside" by the doorway.
      passedDoor: state !== "walkingIn" || !!row.seatUid,
      passedExterior: state !== "walkingIn" || !!row.seatUid,
      stateClock: Number(row.stateClockMs) / 1000,
      order,
      orderIndex: row.orderIndex,
      // Ticket id: the server-side u64 doesn't map cleanly to the
      // local StaffRouter id namespace ("ticket-N").  Leave null —
      // local will re-enqueue from the order on next state pass if
      // the cloud's ticket is still cooking; the server's
      // active_ticket hydrate (H.48b) will fix this properly.
      ticketId: null,
      patience: Number(row.patienceMs) / 1000,
      totalPaid: Number(row.totalPaidCents) / 100,
      totalSatisfaction: row.totalSatisfactionX100 / 100,
      archetype,
      taste,
      path: [],
      currentFloor: row.floor,
      replanAccum: 0,
      willUseToilet: row.willUseToilet,
      // Defaults for fields cloud doesn't expose in HydratableGuestRow.
      // The server's wash/toilet state is captured indirectly via
      // `state` (wcWalking → walkingToToilet, etc.).  Latches default
      // off — the sim re-derives them as the guest advances.
      usedToilet: false,
      reservedDishTiers,
      serverMirrorId: row.id,
      // Phase M.16 — seed the guest-cutover cloud pose/state from THIS row so
      // renderGuestFromServer (update()'s guestMove branch) anchors the body to
      // the correct FLOOR from frame one. Without this the cloud* fields are
      // undefined until the next active_guest onUpdate, so renderGuestFromServer
      // early-returns, `_baseY` is never set, and the animator's floor gate
      // (round(_baseY/storeyHeight)) defaults the guest to floor 0 — an
      // upper-storey guest imported on reload then "sits in a chair on the
      // ground floor". Settled interp (prev = cur, interp = 1) so the body
      // doesn't glide in from the origin on the first frame.
      cloudX: character.groundPos.x,
      cloudZ: character.groundPos.y,
      cloudFloor: row.floor,
      cloudState: row.state,
      cloudPrevX: character.groundPos.x,
      cloudPrevZ: character.groundPos.y,
      cloudInterp: 1,
      // Mark mirror flags as already-settled so periodic mirror
      // doesn't re-push.  Cloud already has these values.
      orderMirrored: order.length > 0,
      waitingMirrored: !!row.waitingChairUid,
      lastMirroredReservedTiers: row.reservedDishTiers,
    };

    if (row.waitingChairUid) {
      guest.waiting = {
        chairUid: row.waitingChairUid,
        chairPos: new THREE.Vector2(row.x, row.z),
        chairFacingY: 0,
        timeLeft: Number(row.waitingTimeoutMs) / 1000,
      };
      this.claimedWaitingChairs.set(row.waitingChairUid, localId);
    }

    // Mark seat occupancy so reconcileOccupancy doesn't trip.
    if (row.seatUid && !row.seatAtBar) {
      this.occupiedSeats.add(row.seatUid as SeatId);
    }

    this.guests.push(guest);
    // Task A — a guest IMPORTED already in "eating" state never crossed
    // the waitingForFood→eating transition in reconcileCloudGuest (which
    // is the only other place showPlateForGuest fires under Path B), so
    // their table would render empty even though they're mid-meal. Drop
    // the plate now that the guest is in this.guests + has its seat/
    // platePos resolved, mirroring the transition's side effect.
    if (state === "eating") {
      this.showPlateForGuest(guest);
    }
    if (DEBUG_GUEST_LOGS) {
      console.log(`[H.47] imported cloud guest ${localId} (server id ${row.id}) state=${state} seat=${row.seatUid || "none"}`);
    }
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
  snapshotStatus(): { id: string; character: AnimatedCharacter; label: string; panic: boolean; eating: boolean }[] {
    return this.guests.map((g) => ({
      id: g.id,
      character: g.character,
      label: guestLabel(g, this.tableSurfaceForGuest(g) === "drink"),
      panic: (g.state === "seated" || g.state === "waitingForFood") && g.patience < 12,
      // Phase M.10 — flag the consuming state so the bubble layer can tint it
      // green reliably (the old `label.startsWith("🍴")` check never matched —
      // the archetype prefix comes first).
      eating: g.state === "eating",
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
    // Phase 9.5 — ZERO resolved seats means the furniture hasn't
    // loaded yet (boot, mid-restore), not that the player sold every
    // table while guests were seated. Walking guests out on that
    // misread evicted the entire dining room during the post-reload
    // hydrate. A restaurant that truly has no seats also has no
    // seated guests to refresh, so skipping is always safe.
    if (byId.size === 0) return;
    for (const g of this.guests) {
      const slot = byId.get(g.seatId);
      if (!slot) {
        // Phase 9.5 — When the server owns guest states, the client
        // NEVER walks a guest out on its own. A missing local slot
        // here usually doesn't mean "table sold" — it means the
        // guest row has an empty/unknown seat_uid (legacy
        // client-spawned rows never mirrored seat_uid; a WC trip can
        // also transit with the seat field in flux) or the furniture
        // restore hasn't resolved that uid yet. Evicting locally
        // desyncs from the server, which keeps the guest seated and
        // keeps the meal running — the user-visible result was the
        // whole dining room "wandering to the door while the kitchen
        // works". The server's own grace logic despawns genuinely
        // seatless guests.
        if (this.serverOwnsGuestStates()) {
          // Seat not resolvable yet (uid unknown, or furniture still
          // restoring). Don't evict — the server keeps the meal running. But if
          // the guest is anchored AND sitting at the room ORIGIN (the (0,0) the
          // server can default seat coords to), hide it so it doesn't render as
          // a "blob" dead-centre on the floor; it pops back the instant its seat
          // resolves (snapped below). A guest at a VALID spot with a merely-
          // unresolvable uid stays visible — and a real central-table seat
          // always resolves, so legitimate diners are never hidden.
          if (g.state === "seated" || g.state === "waitingForFood" || g.state === "eating") {
            g.character._keepHidden =
              Math.abs(g.character.groundPos.x) < 1.0 && Math.abs(g.character.groundPos.y) < 1.0;
          }
          continue;
        }
        // Local-sim mode: table sold under them. Walk them out
        // gracefully. Reconcile any reserved plates BEFORE the walk
        // so the dishware inventory doesn't silently drift down —
        // eaten courses become dirty, in-flight ones go back to clean.
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
        // Snap the body onto the RESOLVED seat. A server-imported guest can be
        // carrying a bogus (0,0) body position (the server's seat default, or a
        // watchdog target); without this it sits dead-centre on the floor as a
        // "blob" until it next moves. Un-hide it if it was hidden above for
        // being mislaid at the origin.
        g.character.groundPos.copy(g.seatPos);
        if (g.character._keepHidden) g.character._keepHidden = false;
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
    // Phase I (H.99) — Same-floor STRONG preference. Pre-H.99 a tiny
    // STAIR_PENALTY in pathwayDistance only broke ties; an upstairs
    // toilet a few metres closer would still win, sending guests up
    // a flight of stairs to wash hands. Now we partition: try
    // same-floor first; only if NONE are available do we look
    // cross-floor. Within each partition, nearest by pathway dist.
    const best = pickNearestOnSameFloorFirst(
      toilets, g.currentFloor, (t) => this.pathwayDistance(g, t.standPos, t.floor),
    );
    if (!best) return null;
    return {
      uid: best.uid,
      rotY: best.rotY,
      center: new THREE.Vector2(best.x, best.z),
      standPos: best.standPos.clone(),
      floor: best.floor,
    };
  }

  /** Nearest UNRESERVED sink, same pathway-distance ranking as
   * findFreeToilet. Returns rotY too so atSink can face the guest
   * toward the basin, and the sink's floor so the trip path targets
   * the right storey. H.99 — same-floor strong preference applied
   * via the shared pickNearestOnSameFloorFirst helper. */
  private findFreeSink(g: ActiveGuest): { uid: string; rotY: number; standPos: THREE.Vector2; floor: number } | null {
    if (!this.registry) return null;
    const sinks = this.registry.getBathroomSinks().filter((s) => !this.reservedSinks.has(s.uid));
    if (sinks.length === 0) return null;
    const best = pickNearestOnSameFloorFirst(
      sinks, g.currentFloor, (s) => this.pathwayDistance(g, s.standPos, s.floor),
    );
    if (!best) return null;
    return { uid: best.uid, rotY: best.rotY, standPos: best.standPos.clone(), floor: best.floor };
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
   * and route them over. Also expire waiting guests whose timer ran out.
   *
   * Phase 6.1b — The timeout-driven angry exit is gated when the server
   * owns guest state. Server's tick_guest_state runs the same
   * waiting_timeout_ms decrement (restaurant_sim.rs: is_waiting_state
   * branch) and flips the guest to "leaving" when it hits zero; the
   * cloud-guest bridge below catches that and applies the local
   * side effects (yellow-chair release + recordLost + rating ding).
   * Promotion to a real seat still runs locally — that decision depends
   * on the client's occupiedSeats + furniture registry, which the
   * server doesn't model yet. */
  private promoteWaitingGuests(): void {
    const localOwnsWaitingTimeout = !this.serverOwnsGuestStates();
    for (const g of this.guests) {
      if (!g.waiting) continue;
      // Time-out → angry exit (local-only branch — server-bridge owns
      // this when serverOwnsGuestStates() is on).
      if (localOwnsWaitingTimeout
          && g.waiting.timeLeft <= 0 && g.state === "waitingForSeat") {
        this.claimedWaitingChairs.delete(g.waiting.chairUid);
        g.waiting = undefined;
        this.applyAngryLeave(g);
        continue;
      }
      // Phase 9.6 — promotion is server-owned now. The server's
      // try_promote_waiting_guest assigns the freed seat and flips
      // the row waiting → walkingIn; the bridge adopts it locally.
      // Promoting here too would race the server onto a DIFFERENT
      // seat and leave one of the two claims orphaned.
      if (this.serverOwnsGuestStates()) continue;
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
    // Phase 9.4 — Server owns the pedestrian→guest conversion now.
    // try_arrival_handoff (pedestrians.rs) converts EVERY arrival
    // walker into an active_guest row, online or off; the row lands
    // here via the onInsert bridge like any other server spawn.
    // This was the LAST client-side guest spawn path — firing it
    // would double-spawn against the server's conversion within a
    // couple of seconds.
    // Phase M.16 — guestMove also hands spawning to the server, so gate
    // this off when EITHER flag is on (testing ?serverSim=guestMove alone
    // has `guests` off, but the server still owns spawns under guestMove).
    if ((isServerSim("guests") || isServerSim("guestMove"))
        && this.cloud?.isConnectionLive() === true) return;
    // Legacy local-sim path (flag off / cloud absent only).
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
    const id = `guest-${this.nextGuestNum++}`;
    // Skinned render is keyed on the id hash; variant stays a real catalog id.
    const newFace = isNewFaceGuest(id);
    const variantId = (variantHint && GUEST_VARIANT_IDS.includes(variantHint)) ? variantHint : pick(GUEST_VARIANT_IDS);
    try {
      let model: THREE.Object3D;
      let skeletal: SkeletalDriver | undefined;
      if (newFace) {
        const inst = await this.riggedLoader.createInstance("newface");
        model = inst.root; skeletal = inst.controller;
      } else {
        const inst = await this.riggedLoader.createInstance(riggedCustomerForKey(id));
        model = inst.root; skeletal = inst.controller;
      }
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
        // Seat surface height (Kenney chair at S_CHAIR=1.7). Skinned guests
        // sit via their own clip, so they take no lift on a normal chair —
        // but a bar stool sits taller, so bar seats get BAR_STOOL_LIFT.
        seatHeight: skeletal ? (available?.atBar ? BAR_STOOL_LIFT : 0) : 0.62,
        skeletal,
      };
      this.animator.add(character);

      // Loud announcement for a food critic so the player knows to ace it.
      // (archetype + taste were rolled before the seat pick above.)
      if (archetype.id === "critic") {
        this.floatingText?.pop(DOOR_POSITION.x, DOOR_POSITION.y, "🕵️ FOOD CRITIC!", "#ffd966", 0);
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
      // H.17 — pass archetype patience scaling (× 100 → integer) so
      // the server's patience timer matches the client's. Heavy
      // customers wait longer; impatient ones leave faster. Clamped
      // server-side too as a defense in depth.
      patienceMultX100: Math.round(g.archetype.patienceMultiplier * 100),
      // H.24 — pre-meal handwash flag. Mirror so a backgrounded tab
      // still runs the sink trip via the server's seated → wcWalking
      // branch (with a sink target). Mutually exclusive with
      // willUseToilet — only one will ever be true.
      willWashOnly: g.willWashOnly ?? false,
    });
    // Resolve the server-side auto-inc id once the subscription cache
    // catches up. 250 ms is comfortably above the typical reducer
    // round-trip; if we miss the window we'll just lose mirror-leave
    // for THIS guest (the cloud's patience timer will despawn the
    // row regardless).
    window.setTimeout(() => {
      if (!this.cloud) return;
      const id = this.cloud.findActiveGuestIdByClientTempId(g.id);
      if (id != null) {
        g.serverMirrorId = id;
        // H.19 — push the waiting-chair assignment ASAP after the
        // serverMirrorId resolves. The periodic stream picks up the
        // retry if this firing somehow misses, but front-loading
        // it cuts ~1 s off the time before H.5 starts counting.
        if (g.waiting && !g.waitingMirrored) this.mirrorGuestWaiting(g);
      }
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

  /** H.11 — mirror the guest's full course list to the cloud so
   * the server's tick reducer can drive the multi-course eating
   * cycle (eating → seated → ... → leaving). Called once per guest
   * after their order is built.
   *
   * Audit fix (B.1): retries on the periodic position stream while
   * `orderMirrored` is false. The original single-shot was fragile
   * — if `serverMirrorId` hadn't resolved by the time
   * `onWaiterTookOrder` fired (slow net, spawn timing), the call
   * bailed and the order was lost forever. Now the stream loop
   * keeps trying until `serverMirrorId` resolves AND the call lands. */
  private mirrorGuestOrder(g: ActiveGuest): void {
    if (!isServerSim("guests") || !this.cloud) return;
    if (g.orderMirrored) return;
    if (g.order.length === 0) return;
    if (g.serverMirrorId == null) {
      g.serverMirrorId = this.cloud.findActiveGuestIdByClientTempId(g.id) ?? undefined;
    }
    if (g.serverMirrorId == null) return;
    const recipesCsv = g.order.map((r) => r.id).join(",");
    // H.14 — build parallel CSVs from recipe catalog so the server can
    // auto_place_next_course without the recipe data. Per-course
    // appliance is the same routing the client uses (bar for drinks,
    // recipe.appliances[0] otherwise). Cook time uses the BASE
    // (pre-chef-multiplier) value — the server's H.6 chef multiplier
    // is uniform (no training data on server) so we just pass base.
    const appliancesCsv = g.order
      .map((r) => {
        if (r.category === "drink") return "bar";
        const apps = this.game.cooking.getRecipeAppliances(r);
        return apps[0] ?? r.stationNeeded ?? "stove";
      })
      .join(",");
    const cookSecondsCsv = g.order
      .map((r) => Math.round(this.game.getBaseCookSeconds(r) * 1000))
      .join(",");
    // H.16 — per-course price (cents) + satisfaction (×100). Mirrors
    // creditCourse() exactly: getEffectiveSellPrice × 100, satisfaction
    // = getEffectiveSatisfaction + (+2 cuisine match bonus). Server uses
    // these to maintain its own total_paid_cents / total_satisfaction_x100
    // counters on each eating→{seated,leaving} transition.
    const pricesCsv = g.order
      .map((r) => Math.round(this.game.getEffectiveSellPrice(r) * 100))
      .join(",");
    const satisfactionsCsv = g.order
      .map((r) => {
        let sat = this.game.getEffectiveSatisfaction(r);
        if (r.category === g.taste.preferredCategory) sat += 2;
        return Math.round(sat * 100);
      })
      .join(",");
    this.cloud.setGuestOrder(
      g.serverMirrorId,
      recipesCsv,
      appliancesCsv,
      cookSecondsCsv,
      pricesCsv,
      satisfactionsCsv,
    );
    g.orderMirrored = true;
  }

  /** H.19 — Push the overflow waiting chair assignment to the server
   * so the cloud row's H.5 timeout-leave branch starts ticking. Called
   * by the periodic position stream while g.waitingMirrored is false
   * — same retry discipline as mirrorGuestOrder, since serverMirrorId
   * may not have resolved yet at spawn time. Once the guest is no
   * longer waiting (promoted to a seat OR gave up), this also fires
   * the clear path (empty chair + 0 timeout).
   *
   * Idempotent on the wire: the reducer no-ops when the row already
   * holds the same chair/timeout values. */
  private mirrorGuestWaiting(g: ActiveGuest): void {
    if (!isServerSim("guests") || !this.cloud) return;
    if (g.serverMirrorId == null) {
      g.serverMirrorId = this.cloud.findActiveGuestIdByClientTempId(g.id) ?? undefined;
    }
    if (g.serverMirrorId == null) return;
    if (g.waiting) {
      // Convert seconds → ms; the server stores i64 milliseconds.
      const timeoutMs = Math.max(0, Math.round(g.waiting.timeLeft * 1000));
      this.cloud.setGuestWaitingChair(g.serverMirrorId, g.waiting.chairUid, timeoutMs);
      g.waitingMirrored = true;
    } else if (!g.waitingMirrored) {
      // Already clear on both sides — nothing to do, but latch the
      // flag so we don't keep checking every periodic tick.
      g.waitingMirrored = true;
    } else {
      // Was mirrored as waiting; now they're not. Push the clear so
      // the server stops counting down the H.5 timeout.
      this.cloud.setGuestWaitingChair(g.serverMirrorId, "", 0);
      g.waitingMirrored = false; // re-arm for any future re-assignment
    }
  }

  /** H.20 — Push the current reservedDishTiers list to the cloud row.
   * Called once after each `g.reservedDishTiers.push(...)` AND on
   * every periodic stream tick (cheap idempotent re-send for the
   * spawn-race case where serverMirrorId wasn't ready). Skips empty
   * lists — the server rejects empty CSVs anyway to avoid clobbering
   * existing data.
   *
   * Tracks the last CSV we successfully pushed so the periodic stream
   * doesn't fire a redundant reducer call every second once the list
   * has stabilized at end-of-meal. */
  private mirrorGuestReservedTiers(g: ActiveGuest): void {
    if (!isServerSim("guests") || !this.cloud) return;
    if (g.reservedDishTiers.length === 0) return;
    if (g.serverMirrorId == null) {
      g.serverMirrorId = this.cloud.findActiveGuestIdByClientTempId(g.id) ?? undefined;
    }
    if (g.serverMirrorId == null) return;
    const csv = g.reservedDishTiers.join(",");
    if (g.lastMirroredReservedTiers === csv) return;
    this.cloud.setGuestReservedTiers(g.serverMirrorId, csv);
    g.lastMirroredReservedTiers = csv;
  }

  /** Throttled per-frame: every ~1 s, push each guest's body coords +
   * current target to the server so subscribed clients (visit mode,
   * future co-owner views) can lerp the same body in their own scene.
   * Skip guests whose serverMirrorId hasn't been resolved yet — the
   * spawn-side polling timeout owns that handshake.
   *
   * Still streams under Phase H: the GuestSpawner state machine
   * doesn't yet fire per-event mirror calls when a guest's target
   * changes (e.g. moving from door to seat, seat to leaving). Until
   * those hooks land, the 1Hz stream is the only way the server's
   * tick_guest_state learns where each guest wants to go. */
  private streamGuestPositionsToCloud(dt: number): void {
    if (!isServerSim("guests") || !this.cloud) return;
    // Change-detection mirror — same pattern as
    // StaffRouter.streamActorsToCloud (commit 0f1491c followup).
    // Fingerprint includes state + target so a guest changing target
    // (door → seat → leaving) propagates to the server in < 100 ms
    // instead of waiting up to a second for the periodic tick.
    // Periodic floor preserved at 1 s for position drift.
    this.cloudPositionAccum += dt;
    const periodicFire = this.cloudPositionAccum >= 1.0;
    if (periodicFire) this.cloudPositionAccum = 0;
    for (const g of this.guests) {
      if (g.serverMirrorId == null) continue;
      const fingerprint = `${g.state}|${g.target.x.toFixed(2)}|${g.target.y.toFixed(2)}|${g.currentFloor}`;
      const changed = fingerprint !== g.lastMirrorFingerprint;
      if (!changed && !periodicFire) continue;
      this.cloud.updateGuestPosition(
        g.serverMirrorId,
        g.character.groundPos.x,
        g.character.groundPos.y,
        g.currentFloor,
        g.target.x,
        g.target.y,
        g.currentFloor,
        g.state,
      );
      if (changed) g.lastMirrorFingerprint = fingerprint;
      // Audit fix (B.1) — retry the order CSV mirror on each periodic
      // tick if it hasn't landed yet. mirrorGuestOrder() short-circuits
      // when orderMirrored is true, so this is cheap once the first
      // successful send completes.
      if (periodicFire) this.mirrorGuestOrder(g);
      // H.19 — also retry the waiting-chair mirror on the same cadence.
      // Latches via waitingMirrored so a steady waiting state only
      // pushes once; if the local sim transitions out of waiting
      // (promoted or gave up), the mirror flips back and clears.
      if (periodicFire) this.mirrorGuestWaiting(g);
      // H.20 — retry the reserved-tiers mirror. Same cheap-once-stable
      // discipline as the order mirror: skips when lastMirroredReservedTiers
      // already equals the current join, so it's effectively free once
      // the guest's full order is in flight.
      if (periodicFire) this.mirrorGuestReservedTiers(g);
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
    // Anti-perf — remove from the ACTUAL parent, not the scene root. Guests
    // that climbed stairs / sat upstairs were reparented into an upper-floor
    // storey group; `this.scene.remove` only detaches direct children, so it
    // was a no-op for them and their meshes piled up inside that group —
    // exactly the group a floor change makes visible. parent?.remove handles
    // ground-floor (parent = scene) and upper floors (parent = group) alike.
    g.character.skeletal?.stop();
    g.character.root.parent?.remove(g.character.root);
    this.animator.remove(g.character.root);
    if (g.waiting) {
      // Waiting-overflow guests free their yellow chair, not a real seat.
      this.claimedWaitingChairs.delete(g.waiting.chairUid);
    } else if (g.seatId) {
      this.occupiedSeats.delete(g.seatId);
      // Real seat needs cleanup before the next guest can use it.
      this.dirtyUntil.set(g.seatId, this.elapsed + SEAT_CLEAN_SECONDS);
      this.floatingText?.pop(g.seatPos.x, g.seatPos.y, "🧹 cleaning", "#f0c8a0", g.seatFloor);
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
    // Resolve the guest's table surface FIRST. If it isn't registered yet
    // (offscreen, mid furniture-restore, or a server-assigned seat whose
    // furniture hasn't landed locally), DEFER the plate rather than dropping
    // it at the 0.76 fallback height where it floats with no surface beneath
    // it — the next course/show resolves it once the table is present.
    const topY = this.getTableTopForGuest(g);
    if (topY === null) return;
    if (!GuestSpawner.plateGeo) {
      GuestSpawner.plateGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.02, 18);
      GuestSpawner.plateMat = new THREE.MeshStandardMaterial({ color: 0xfaf2e2, roughness: 0.4 });
    }
    const plate = new THREE.Mesh(GuestSpawner.plateGeo, GuestSpawner.plateMat!);
    plate.position.set(g.platePos.x, topY, g.platePos.y);
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
    // Free the per-serve food mound (fresh geo+mat); keep the SHARED plate
    // base (plateGeo/plateMat) that every served plate reuses.
    disposeObject3D(plate, new Set([GuestSpawner.plateGeo, GuestSpawner.plateMat]));
    this.tablePlates.delete(guestId);
  }

  /** Spawn one "leftover" mesh per course this guest actually ate.
   * Used by finalizeVisit after the active plate has been cleared so
   * the dirty pieces stay visible on the table until a wash happens.
   * Each piece is positioned at the guest's platePos with a small per-
   * course jitter so multi-course customers leave a clearly-stacked
   * mess instead of one z-fighting blob. */
  private spawnLeftoversForGuest(g: ActiveGuest): void {
    // Defer if the table isn't resolvable (same as showPlateForGuest) so the
    // dirty pieces don't float at a fallback height with no surface under them.
    const tableTop = this.getTableTopForGuest(g);
    if (tableTop === null) return;
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
      // Task A — under Path B the host renders dirty piles from the
      // cloud dirty_pile table via Engine's DirtyPileVisualizer (same
      // path visitors use). Creating the LOCAL leftover mesh here too
      // would double-render the same pile at the same table spot, so
      // leave the local dirtyTableMeshes dormant and rely on the cloud
      // mirror below. The mirror (addDirtyPile) still fires so the
      // cloud row — and therefore both the host's own visualizer AND
      // any visitor's — shows the leftover. Flag OFF keeps the original
      // local-mesh renderer (no cloud visualizer is wired in that mode).
      if (!this.serverOwnsGuestStates()) {
        const mesh = builder.build(tier);
        mesh.position.set(x, tableTop, z);
        // Parent leftover plates/glasses to the SEAT's floor group so
        // they hide with that storey — same fix as showPlateForGuest
        // for the served-food icons bleeding through floors below.
        const mount = this.getStoreyMount?.(g.seatFloor) ?? this.scene;
        mount.add(mesh);
        const localId = this.nextDirtyId;
        this.dirtyTableMeshes.push({
          id: localId, mesh, kind, claimedBy: null,
          pos: new THREE.Vector2(x, z),
          floor: g.seatFloor,
          seatId,
        });
        this.nextDirtyId += 1;
      }
      // Phase H.B — Mirror to cloud so visitors (and the host's own
      // renderer under Path B) can see this pile.
      //
      // Phase 9.45 — but ONLY under Path A. Under Path B the SERVER's
      // settle_guest_dishes already writes one dirty_pile row per eaten
      // course; firing addDirtyPile here too would DOUBLE the rows and,
      // worse, if the local guest's seatId has diverged from the
      // server's, plant a pile on a seat the server thinks is clean —
      // making a good seat falsely unservable under strict cleaning.
      // Keep the client out of the server-owned pile lifecycle: render
      // from the dirty_pile subscription (DirtyPileVisualizer), never
      // mutate it.
      if (!this.serverOwnsGuestStates()) {
        this.cloud?.addDirtyPile({
          seatUid: seatId,
          kind,
          tier,
          slotIndex: Math.min(startSlot + i, LEFTOVER_SLOTS.length - 1),
          floor: g.seatFloor,
          x, z,
        });
      }
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
    disposeDirtyPiece(entry.mesh);
    // Phase H.B — Drain ONE matching cloud row so the mirror doesn't
    // accumulate. By-seat lookup because the cloud's auto_inc id
    // isn't threaded through the local pickup machinery; see server
    // reducer doc on pickup_dirty_pile_by_seat for the race notes.
    //
    // Phase 9.45 — Path A only. Under Path B the dirty_pile row is the
    // server's: it's deleted exclusively by a waiter's tick_seat_clean
    // trip. A client-side delete here would be an uncontrolled
    // auto-clean — a seat freed without a waiter ever bussing it —
    // which is precisely what strict mode forbids. (This branch is
    // already dormant under Path B since dirtyTableMeshes stays empty,
    // but gate it explicitly so a mode flip can't reopen the hole.)
    if (entry.seatId && !this.serverOwnsGuestStates()) {
      this.cloud?.pickupDirtyPileBySeat(entry.seatId, entry.kind);
    }
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
    disposeDirtyPiece(entry.mesh);
  }

  /** Anti-stuck watchdog. A guest in a should-be-MOVING state that hasn't
   * actually moved for a few seconds is wedged — usually a stale or now-blocked
   * queued path. Re-plan it periodically so it gets going again instead of
   * standing on the floor as a statue (and, if walkingIn, holding its seat). We
   * deliberately do NOT force-route it out from here: that would fight the
   * server-owned guest state under the cutover. Anything a re-plan can't rescue
   * is cleared by the leaving-watchdog (now 8 s) or the server's patience. */
  private tickStuckRecovery(g: ActiveGuest, dt: number): void {
    const movingState =
      g.state === "walkingIn" || g.state === "walkingToWait" ||
      g.state === "walkingToToilet" || g.state === "walkingToSink" ||
      g.state === "returningFromToilet" || g.state === "walkingToDoor" ||
      g.state === "exitingDoor" || g.state === "walkingOut";
    if (!movingState) { g._stuckMs = 0; return; }
    const x = g.character.groundPos.x, z = g.character.groundPos.y;
    if (g._stuckX === undefined ||
        Math.hypot(x - g._stuckX, z - (g._stuckZ ?? 0)) > 0.06) {
      // Moved this interval — not stuck. Remember where, reset the clock.
      g._stuckMs = 0; g._stuckX = x; g._stuckZ = z;
      return;
    }
    const prev = g._stuckMs ?? 0;
    g._stuckMs = prev + dt * 1000;
    // Every ~3 s wedged, re-plan toward the current target — that clears the
    // common cause (a stale / now-blocked queued path); moveToward picks the
    // fresh path up next frame. Safe: no state change, no despawn.
    if (Math.floor(g._stuckMs / 3000) > Math.floor(prev / 3000)) {
      this.planPath(g);
    }
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
          // A seated guest faces OUT of the chair: the chair back is at -Z by
          // default, so the customer faces chairRotY + π (the same +π relation
          // as chairRotForSlot). The old `π - chairFacingY` only happened to
          // match for N/S chairs and seated guests at E/W-rotated chairs
          // exactly backwards.
          g.character.facingY = g.waiting.chairFacingY + Math.PI;
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
        // Phase H Phase 5w — when server owns guest states, WC trip
        // initiation lives server-side. tick_guest_state checks
        // will_use_toilet / will_wash_only + picks a fixture +
        // transitions the guest to wcWalking. The cloud bridge maps
        // the resulting state changes onto the local walk machine.
        // Skip the local WC dispatch checks so we don't race the
        // server with a different fixture pick. The order-request
        // branch further down still runs as before (until Phase 4b
        // gates kick in there).
        const localOwnsWc = !this.serverOwnsGuestStates();
        // First-thing-after-sitting: WC users excuse themselves to
        // the bathroom before ordering. Only triggers ONCE per visit.
        // toiletAttemptComplete latches once we've either gone OR
        // given up waiting — we DON'T clear willUseToilet on give-up
        // because finalizeVisit needs to know they wanted to go.
        if (localOwnsWc && g.willUseToilet && !g.usedToilet && !g.toiletAttemptComplete) {
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
        if (localOwnsWc && g.willWashOnly && !g.washedHands && !g.washAttemptComplete) {
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
          // Phase H Phase 4b — when server owns guest states, the
          // server's tick_guest_state advances seated → ordering at
          // SEATED_DWELL_MS, and try_dispatch_take_order picks a
          // waiter via Phase 4 always-on dispatch. The bridge
          // synthesizes a local OrderRequest from the cloud row when
          // the server picks a waiter (StaffRouter
          // reconcileCloudStaffActor take-order claim case). Skipping
          // the local enqueueOrderRequest avoids racing the server's
          // pick + having two OrderRequest entries for the same
          // guest. Bar-seat requests still need local enqueueing —
          // server doesn't simulate the barman take-order path yet.
          if (this.serverOwnsGuestStates() && !(g.seatAtBar ?? false)) {
            // Local request skipped; server flow handles it.
          } else {
            this.router.enqueueOrderRequest(g.id, g.seatPos, g.seatFloor, g.seatAtBar ?? false);
          }
        }
        if (g.orderTaken && g.order.length === 0) {
          // Callback was supposed to populate g.order. Defensive: if
          // it didn't (callback wiring missing) build one here so the
          // guest doesn't get stuck. Same surface-aware build the old
          // path used. Also mirror the resulting order to the cloud.
          const surface = this.tableSurfaceForGuest(g);
          g.order = this.buildOrder(g.archetype, surface, g.taste);
          if (g.order.length === 0) {
            this.markLostAndExit(g);
            break;
          }
          this.mirrorGuestOrder(g);
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
        // Rescue: can't reach the toilet within WC_WALK_GIVEUP (walled off /
        // unreachable) — walk back to the seat rather than forever. The
        // server still drives the wc_completed outcome.
        if (g.stateClock > WC_WALK_GIVEUP) {
          if (g.toiletUid) { this.reservedToilets.delete(g.toiletUid); g.toiletUid = undefined; }
          if (g.originalSeatHeight !== undefined) {
            g.character.seatHeight = g.originalSeatHeight;
            g.originalSeatHeight = undefined;
          }
          g.target = (g.returnSeatPos ?? g.seatPos).clone();
          g.returnSeatPos = undefined;
          g.state = "returningFromToilet";
          g.stateClock = 0;
          g.character.action = "walk";
          this.planPath(g);
          break;
        }
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
          // Rigged guests sit via their clip and seatHeight is a DELTA added
          // to root.y, so the absolute TOILET_SIT_HEIGHT would lift them OFF
          // the bowl — use the negative bowl delta. Legacy procedural guests
          // keep the absolute lower height.
          g.character.seatHeight = g.character.skeletal ? TOILET_SIT_LIFT : TOILET_SIT_HEIGHT;
          g.character.action = "sit";
          g.state = "atToilet";
          g.stateClock = 0;
          if (DEBUG_GUEST_LOGS) console.log(`[Guest ${g.id}] arrived at toilet → atToilet (dwell ${TIME_AT_TOILET}s)`);
        }
        break;
      }
      case "atToilet": {
        // Phase H Phase 5w — when server owns guest states, the
        // bridge handles the wcSitting → wcWashing transition
        // (server picks the sink + targets the row to it; bridge
        // transitions local atToilet → walkingToSink with that
        // target). Local timer-based exit is gated off so we don't
        // race the bridge with our own sink pick.
        if (this.serverOwnsGuestStates()) break;
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
        // Same unreachable-fixture rescue as walkingToToilet.
        if (g.stateClock > WC_WALK_GIVEUP) {
          if (g.sinkUid) { this.reservedSinks.delete(g.sinkUid); g.sinkUid = undefined; }
          g.target = (g.returnSeatPos ?? g.seatPos).clone();
          g.returnSeatPos = undefined;
          g.state = "returningFromToilet";
          g.stateClock = 0;
          g.character.action = "walk";
          this.planPath(g);
          break;
        }
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
          this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, "🧼 washing…", "#a8d8f0", g.currentFloor);
          if (DEBUG_GUEST_LOGS) console.log(`[Guest ${g.id}] arrived at sink → atSink (dwell ${TIME_AT_SINK}s)`);
        }
        break;
      }
      case "atSink": {
        // Phase H Phase 5w — when server owns guest states, the
        // bridge handles the wcWashing → seated transition (server
        // targets the row back to the seat; bridge transitions
        // local atSink → returningFromToilet with that target).
        // Local timer-based exit is gated off so we don't race the
        // bridge with a different return path.
        if (this.serverOwnsGuestStates()) break;
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
        // Phase H Phase 3a — when server owns guest states, the cloud
        // active_guest subscription's waitingForFood→eating transition
        // (reconcileCloudGuest) is the only path that flips the local
        // guest to eating. Side effects (showPlateForGuest, chime)
        // fire from the bridge there. Without this gate the local
        // handler would race the bridge and either double-fire the
        // sound or skip it depending on the order.
        if (this.serverOwnsGuestStates()) break;
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
          // Phase H Phase 3b/3c — when server owns guest states, the
          // cloud bridge handles BOTH branches of this advance:
          //   eating → leaving (final course) → creditCourse +
          //     finalizeVisit + walk-to-door cascade.
          //   eating → seated (next course) → creditCourse +
          //     removePlate + orderIndex sync + dish reservation +
          //     patience reset. Server's auto_place_next_course then
          //     enqueues the next ticket when state hits
          //     waitingForFood again.
          // Local sim sits in "eating" with stateClock past TIME_TO_EAT
          // until the server tick (≤ 500ms) flips the cloud row and
          // the bridge mirrors locally.
          if (this.serverOwnsGuestStates()) break;

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
    // Hold position while a one-shot transition (sit-down / stand-up) is
    // playing — otherwise the guest slides across the floor mid-stand-up
    // ("walking while standing up"). Keep action="walk" so the rigged
    // controller runs its stand-up → walk sequence; just don't advance the
    // body until it finishes. Static-mesh guests have no skeletal driver, so
    // they're never gated.
    if (g.character.skeletal?.isTransitioning?.()) {
      g.character.action = "walk";
      return;
    }
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

  /** Phase M.16 — guest cutover. Render one guest purely from its
   * subscribed active_guest row when ?serverSim=guestMove is on. The
   * server owns the state machine + spawning + locomotion; here we just
   * lerp the body toward the latest cloud pose, reparent on a floor
   * change, anchor Y to the floor slab, face the travel direction, and
   * drive the pose (sit/walk/idle) + the status bubble from the server
   * state. Mirrors StaffRouter.renderActorFromServer. No local
   * pathfinding, no streaming — so the client can't fight the server.
   *
   * CRUCIALLY it sets g.state = cloudStateToLocal(cloudState) so the
   * status bubble (snapshotStatus / guestLabel) and the eating flag read
   * SERVER truth — that's what finally makes the 🍽️/🍹 eating icons
   * appear (the local sim used to say "seated/waiting" while the server
   * had the guest eating, the 0-eating divergence). */
  private renderGuestFromServer(g: ActiveGuest, dt: number): void {
    if (g.cloudX === undefined || g.cloudZ === undefined) return; // no row yet
    const STOREY = 3;
    // Reparent into the new floor's storey group on a floor change so
    // storey-focus visibility hides the guest when the player looks at a
    // different floor (same helper the local mover uses across stairs).
    if (g.cloudFloor !== undefined && g.cloudFloor !== g.currentFloor) {
      // Phase M.17 — ANY floor change under the cutover is a stair hop (the
      // server only flips `floor` at the stair). Animate a fixed ~0.8 s climb
      // from the body's current pos (it followed the walk TO the stair) up to
      // the fixed stair EXIT tile on the new floor — using the KNOWN tile, not
      // cloudX/Z, because the server may already have stepped the guest one
      // step past the stair before this pose was sampled (which left the old
      // nearStairTile check false → the climb snapped).
      const fromFloor = g.currentFloor;
      g.currentFloor = g.cloudFloor;
      this.reparentCharacter?.(g.character, g.cloudFloor);
      const exit = g.cloudFloor > fromFloor ? STAIR_TOP_TILE : STAIR_BOTTOM_TILE;
      g.stairClimb = {
        fromX: g.character.groundPos.x, fromZ: g.character.groundPos.y,
        toX: exit.x, toZ: exit.z, fromFloor, toFloor: g.cloudFloor, elapsed: 0,
      };
      console.log(`[stairClimb] guest ${g.id} F${fromFloor}->F${g.cloudFloor}`);
    }
    // Adopt the server state so the bubble/eating flag + pose read server truth.
    if (g.cloudState) g.state = cloudStateToLocal(g.cloudState);
    // Cache the raw feet-lift once (guests spawn at the Floor 0 door → _baseY is
    // the raw lift), consistent with the mover + the staff render.
    if (g.character._feetLift == null) {
      g.character._feetLift = g.character._baseY ?? g.character.root.position.y;
    }
    const feetLift = g.character._feetLift;
    // Active climb — drive the body up the steps over the fixed duration,
    // IGNORING the (already-past-the-stairs) server pose until it completes.
    if (g.stairClimb) {
      const c = g.stairClimb;
      c.elapsed += dt;
      const s = Math.min(1, c.elapsed / 0.8);
      const cpos = g.character.groundPos;
      cpos.x = c.fromX + (c.toX - c.fromX) * s;
      cpos.y = c.fromZ + (c.toZ - c.fromZ) * s;
      const cy = (c.fromFloor + (c.toFloor - c.fromFloor) * s) * STOREY + feetLift;
      g.character.root.position.y = cy;
      g.character._baseY = cy;
      const cdx = c.toX - c.fromX, cdz = c.toZ - c.fromZ;
      if (Math.hypot(cdx, cdz) > 0.01) g.character.facingY = Math.atan2(-cdx, -cdz);
      g.character.action = "walk";
      if (s >= 1) g.stairClimb = undefined;
      return; // ignore the server pose while climbing
    }
    const pos = g.character.groundPos;
    // Snapshot interpolation: glide from the previous server pose to the latest
    // over the ~2 Hz tick interval (interp 0→1) — steady speed, no teleport+stall.
    const prevX = g.cloudPrevX ?? g.cloudX;
    const prevZ = g.cloudPrevZ ?? g.cloudZ;
    const GUEST_TICK_S = 0.5; // server guest tick ≈ 2 Hz
    g.cloudInterp = Math.min(1, (g.cloudInterp ?? 1) + dt / GUEST_TICK_S);
    const t = g.cloudInterp;
    const tx = prevX + (g.cloudX - prevX) * t;
    const tz = prevZ + (g.cloudZ - prevZ) * t;
    // Snap on a real teleport; otherwise ease toward the interpolated point.
    const jump = Math.hypot(g.cloudX - pos.x, g.cloudZ - pos.y);
    if (jump > 2.5) {
      pos.set(g.cloudX, g.cloudZ);
    } else {
      const alpha = Math.min(1, dt * 16);
      pos.x += (tx - pos.x) * alpha;
      pos.y += (tz - pos.y) * alpha;
    }
    // Anchor body Y to the floor slab (moveToward normally does this).
    const anchorY = g.currentFloor * STOREY + feetLift;
    g.character.root.position.y = anchorY;
    g.character._baseY = anchorY;
    // Face + animate from the current segment's travel direction. "moving" =
    // still gliding along a non-trivial segment; once arrived (t=1) with no
    // new pose the guest reads as stopped.
    const segX = g.cloudX - prevX;
    const segZ = g.cloudZ - prevZ;
    const moving = Math.hypot(segX, segZ) > 0.03 && t < 1;
    if (moving) g.character.facingY = Math.atan2(-segX, -segZ);
    // Pose from the (now server-driven) local state: seated/eating/waiting →
    // "sit", anything mid-walk → "walk", otherwise "idle". SIT_STATES + the
    // seat lift keep a seated guest on the cushion; a seated guest that the
    // server still reports as slightly moving falls through to walk, which is
    // fine (it'll settle to sit once t hits 1).
    if (SIT_STATES.has(g.state) && !moving) {
      g.character.action = "sit";
      // Keep them facing the way the seat was set (seatFacingY) rather than a
      // stale last-walk heading, matching how importCloudGuest seats them.
      if (g.seatFacingY !== undefined) g.character.facingY = g.seatFacingY;
    } else {
      g.character.action = moving ? "walk" : "idle";
    }
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
   * hard-coded height. Returns null when the table can't be resolved
   * (offscreen, mid-restore, or a server seat whose furniture hasn't
   * landed locally) so callers DEFER the plate rather than floating it. */
  private getTableTopForGuest(g: ActiveGuest): number | null {
    if (this.registry && g.seatId) {
      const hashIdx = g.seatId.indexOf("#");
      const tableUid = hashIdx >= 0 ? g.seatId.substring(0, hashIdx) : g.seatId;
      const top = this.registry.getTableTopY(tableUid);
      if (top !== null) return top;
    }
    return null;
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
    // H.20 — mirror the new reservation CSV to the server right away
    // so settle_guest_dishes on a future despawn has the data. The
    // mirror is idempotent + retries on the periodic stream below
    // if serverMirrorId hasn't resolved yet.
    g.lastMirroredReservedTiers = undefined;
    this.mirrorGuestReservedTiers(g);
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
   * the loss + dock the rating, then walk them out. Delegates to
   * applyAngryLeave so the various give-up paths (legacy patience,
   * server-bridge angry-leave, pantry-empty bail) stay in lockstep. */
  private markLostAndExit(g: ActiveGuest): void {
    this.applyAngryLeave(g);
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
      this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y + 0.2, "♥ taste", "#ffd47a", g.currentFloor);
    }
    // Phase 7.8 — Server is the sole writer for visit money. When
    // serverOwnsGuestStates is on, the server's
    // accumulate_pending_visit_rollup credits tip + revenue to
    // cloud_money_cents at despawn time, and the Phase 7.7
    // delta-sync subscription handler flows it into local economy
    // money within ~50ms. Calling earnMoney here would double-credit
    // (local += price now, then cloud sub adds again). We KEEP the
    // local g.totalPaid / g.totalSatisfaction tracking + the visual
    // fx (floating text + sfx) because they're not money mutations —
    // totalPaid feeds the server's tip calc via the cloud row
    // (already mirrored), and the pop is just a "ka-ching" cue.
    if (!this.serverOwnsGuestStates()) {
      this.game.economy.earnMoney(price, "payment");
    }
    g.totalPaid += price;
    g.totalSatisfaction += satisfaction;
    // Floating "+$N" above the guest.
    this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, `+$${price}`, "#a8e2a8", g.currentFloor);
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
    // Phase 7.8 — Server is the sole writer for visit rating + tip.
    // accumulate_pending_visit_rollup appends the freshly-computed
    // rating to cloud_rating_history_csv and adds tip + revenue to
    // cloud_money_cents at despawn time; the foreground client's
    // cloud_rating_history_csv subscription handler hydrates the
    // local ratingHistory, and Phase 7.7's delta-sync subscription
    // flows the cash add into local economy.
    //
    // The food-critic "record N times" semantic is preserved
    // server-side: the server's accumulate uses the same rating
    // computation + a single CSV append per despawn. The critic's
    // extra weight isn't currently mirrored server-side (would need
    // archetype data on the cloud row). Accepted drift for now.
    //
    // Tip computation remains local-only as a UX display value (we
    // pop the "+$N tip" floating text below), but is NOT credited
    // to economy. Server's accumulate independently computes the
    // canonical tip + writes cloud_money_cents.
    const tipMultByRating: Record<number, number> = { 1: 0, 2: 0, 3: 0.05, 4: 0.15, 5: 0.30 };
    const baseTipRate = tipMultByRating[rating] ?? 0;
    const weatherMult = this.game.weather.getCurrent().tipMultiplier;
    const tip = Math.round(g.totalPaid * baseTipRate * g.archetype.tipMultiplier * weatherMult);
    if (!this.serverOwnsGuestStates()) {
      const ratingsToRecord = g.archetype.id === "critic" ? 3 : 1;
      for (let i = 0; i < ratingsToRecord; i += 1) {
        this.game.reputation.recordRating(rating);
      }
      if (tip > 0) {
        this.game.economy.earnMoney(tip, "payment");
      }
    }

    // Visible feedback: a star rating floats up above their seat as they leave.
    const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
    const ratingColor = rating >= 4 ? "#ffd966" : rating === 3 ? "#fff5dc" : "#ff9a9a";
    this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, stars, ratingColor, g.currentFloor);
    if (tip > 0) {
      // Stagger the tip label so it doesn't overlap the stars.
      setTimeout(() => {
        this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, `tip +$${tip}`, "#a8e2a8", g.currentFloor);
      }, 600);
    }
  }
}
