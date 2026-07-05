import * as THREE from "three";
import { isServerSim } from "./featureFlags";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Pathfinding, MultiFloorPathStep } from "./Pathfinding";
import { PATH_ARRIVAL_THRESHOLD, nearStairTile } from "./Pathfinding";
import type { DishKind } from "../data/dishwareCatalog";
import { recipes } from "../data/recipes";

/**
 * Drives staff (chef + waiter) movement & state machines so they actually
 * work the kitchen instead of standing still.
 *
 * Coordination is via a shared Ticket queue:
 *  - GuestSpawner creates a ticket when a guest orders.
 *  - Any idle chef pulls the oldest QUEUED ticket, walks to the stove,
 *    "cooks" for recipe.preparationTime seconds, marks ticket READY
 *    (a plate exists at the chef station).
 *  - Any idle waiter watches for READY tickets, walks to the chef station
 *    to pick up the plate, walks to the seat, places it (ticket
 *    DELIVERED), then walks back to idle position.
 *  - GuestSpawner watches for DELIVERED tickets matching its guests and
 *    transitions them to EATING.
 *
 * Each role is a pool of actors that share the same queue. Hiring an
 * extra chef adds another worker to the chef pool; multiple tickets can
 * cook in parallel. Same for waiters.
 *
 * Movement is direct A->B at WALK_SPEED. CharacterAnimator handles the
 * walk/idle/carry/sit poses.
 */

export type TicketState = "queued" | "cooking" | "ready" | "delivering" | "delivered";

export interface Ticket {
  id: string;
  guestId: string;
  recipeId: string;
  state: TicketState;
  /** World position of the seat the plate should be delivered to. */
  seatPos: THREE.Vector2;
  /** Per-state timer (seconds). */
  clock: number;
  /** BASE cook time from the recipe, before any chef-specific
   * multiplier. Immutable across the ticket's lifetime — kept separate
   * so re-pickups (chef fired mid-cook, recoverStalledTickets bounce)
   * don't compound the multiplier. The legacy `cookSeconds` field is
   * the LIVE timer-target for the current chef, recomputed from base
   * on each pickup. */
  baseCookSeconds: number;
  /** Seconds the chef needs to "cook" before READY (from recipe). Set
   * at pickup as baseCookSeconds × thisChef.cookMultiplier so the
   * current cook attempt matches who's actually doing the work. */
  cookSeconds: number;
  /** Which appliance the chef must claim to cook this recipe — the
   * recipe's first appliances entry, or "stove" / "counter" derived
   * from stationNeeded. claimFreeStation walks the cook-station list
   * looking for a match. */
  appliance: string;
  /** Storey the seated guest is on. Phase 7d: chefs and waiters only
   * claim tickets whose seat floor matches their home floor — keeps a
   * Floor-1 chef from trying to cook for a ground-floor guest while
   * multi-floor pathfinding is still pending. Defaults to 0 for
   * tickets created before this field existed. */
  seatFloor: number;
  /** World position where the waiter picks up the finished plate /
   * glass. Set when the cook (chef or barman) marks the ticket
   * "ready" — the cook's stand-in-front spot at the station they
   * used. Falls back to the router's legacy `pickupPos` if unset
   * (e.g. degenerate cook path with no assigned station). Critical
   * for bar drinks: a barman cooks at the bar counter, not at the
   * fixed kitchen pickup spot, so the waiter has to walk to the
   * actual counter to grab the glass. */
  pickupPos?: THREE.Vector2;
  /** Storey the pickup spot lives on. Same purpose as pickupPos —
   * lets a cross-floor pickup (Floor 1 barman → Floor 0 waiter)
   * generate a stair segment. */
  pickupFloor?: number;
  /** True when the seat lives at a bar counter — i.e. the customer
   * is sitting at the same furniture piece the barman cooks at. Used
   * to ROUTE the post-cook step: bar-seated tickets get delivered
   * directly by the barman (no waiter trip), regular tickets get
   * marked "ready" for the waiter to pick up. Defaults to false for
   * tickets created before this field existed. */
  seatAtBar?: boolean;
  /** Per-chef backlog routing: which chef this ticket is reserved
   * for. Set by the waiter when they call enqueueOrder — the waiter
   * picks the chef with the shortest backlog on the seat's floor,
   * spilling over to other floors only when every same-floor chef
   * is at HIGH_DEMAND_BACKLOG or more.
   *
   * Null = legacy / unassigned (e.g. the chef who owned this ticket
   * got fired). The chef idle handler treats null-assigned tickets
   * as "anyone can cook" — same behaviour as before per-chef backlog
   * existed. Bar tickets are always null (barmen don't have
   * per-individual backlogs). */
  assignedChefId?: string | null;
  /** Phase C.3b — server-side mirror auto-inc id, once resolved
   * after a successful place_order reducer call. Populated by
   * mirrorTicketPlace's setTimeout poll; null until the row appears
   * in the subscription cache (typical 50-150 ms). Used by the
   * subsequent lifecycle mirror calls (claim, finish, pickup,
   * deliver, cancel) to address the right server row. */
  serverMirrorId?: bigint;
}

/** A seated guest who hasn't placed their order yet. GuestSpawner
 * pushes one of these when the guest reaches the seated state and is
 * ready to order; an idle waiter walks to the seat, dwells briefly
 * "taking the order", then signals back via takeOrderCallback so the
 * spawner builds the recipe list and enqueues a cooking ticket.
 *
 * `claimedBy` holds the memberId of the waiter currently walking
 * toward this seat, so a second waiter doesn't double-up on the same
 * customer. Cleared when the trip completes / is abandoned. */
export interface OrderRequest {
  guestId: string;
  seatPos: THREE.Vector2;
  seatFloor: number;
  claimedBy: string | null;
  /** True when the seat is at a bar counter. Bar-seat orders are
   * claimed by barmen instead of waiters — the customer is at the
   * bar, the barman is at the bar, no waiter trip needed. */
  atBar?: boolean;
}

/** Snapshot of a dirty piece's id + world position + kind (plate vs
 * glass). The waiter wash loop receives a list of these and picks
 * the closest free one. */
export interface DirtyPickupInfo {
  id: number;
  kind: DishKind;
  pos: THREE.Vector2;
  /** Storey the dirty piece sits on. Needed by the multi-floor wash
   * trip so a waiter on Floor 1 actually descends the stair to grab a
   * Floor 0 dirty plate instead of teleporting to its XZ on Floor 1. */
  floor: number;
}

/** Snapshot of a placed wash station — sink or dishwasher. `dwell` is
 * how many seconds the waiter scrubs / loads at the station before
 * walking home. For SINKS dwell is the scrub time and the piece is
 * clean the moment dwell ends. For DISHWASHERS dwell is the brief
 * "load and walk" time and the actual wash happens asynchronously
 * inside DishwareSystem's batch cycle. `defId` lets the trip decide
 * which path to take when dwell finishes. */
export interface WashStationInfo {
  uid: string;
  defId: string;
  standPos: THREE.Vector2;
  dwell: number;
  /** Storey the wash station is placed on. Lets the waiter take the
   * stair to a different-floor sink / dishwasher instead of standing
   * on the right XZ but the wrong elevation. */
  floor: number;
}

/** Waiter wash trip state. The waiter walks from idle → pickup the
 * specified dirty piece → wash at the specified station → home.
 *
 * Phase I (H.95) — Batch carry. `extraDirtyIds` holds additional
 * dirty pieces claimed at trip-start time that the waiter picks up
 * alongside the primary one and loads at the same station. Reduces
 * the per-piece round-trip cost from O(1 plate / 5 s) to O(N plates
 * / 5 s) where N = 1 + extras (max 4 total). */
interface WashTrip {
  dirtyId: number;
  dirtyPos: THREE.Vector2;
  /** Storey the dirty piece sits on. The "pickup" phase routes through
   * the stair when this differs from the waiter's currentFloor. */
  dirtyFloor: number;
  kind: DishKind;
  /** H.95 — additional dirty ids the waiter is carrying with them.
   * Their visual meshes are removed in the same pickup step as the
   * primary; loaded sequentially at the wash station. */
  extraDirtyIds: number[];
  stationUid: string;
  /** Catalog id of the wash station ("sink", "dishwasher",
   * "dishwasher-pro"). Drives the dwell-completion branch in the
   * working state — sinks wash immediately, dishwashers load. */
  stationDefId: string;
  stationPos: THREE.Vector2;
  /** Storey the wash station sits on. The "wash" phase routes through
   * the stair when this differs from the waiter's currentFloor at the
   * moment they pick up the dirty piece. */
  stationFloor: number;
  dwell: number;
  phase: "pickup" | "wash";
}

/** H.95 — Max dishes a waiter can carry in one trip. 4 plates is
 * a reasonable serving-tray equivalent and gives ~4× throughput
 * without making the waiter unrealistic. */
const WASH_MAX_CARRY = 4;
/** H.95 — Max distance (metres) from the primary dirty piece at
 * which extras can be claimed in the same trip. Small enough that
 * the visual "extras vanish as the waiter passes" reads as the
 * waiter scooping nearby plates, not teleporting them. */
const WASH_BATCH_RADIUS = 4.0;

/** Seconds a staff actor may stall (no real movement) while it SHOULD be
 * walking toward its target before we assume it clipped onto furniture (a
 * chair/table it can't path off) and snap it back onto a clear tile + re-plan. */
const STAFF_STUCK_SECONDS = 2.5;
/** Body-collision radius for the per-frame furniture push-out. Smaller than a
 * half-tile (0.5) so a staffer standing a full tile in front of its station
 * isn't shoved off it, but large enough that the body never visibly overlaps
 * an item. */
const STAFF_BODY_RADIUS = 0.35;

interface StaffActor {
  character: AnimatedCharacter;
  /** Which pool this actor belongs to. Used by moveActor to apply the
   * right training-upgrade speed multiplier. */
  role: "chef" | "waiter" | "barman";
  /** HiredStaffMember id this actor represents — links the physical
   * character in the world to the trainable record in StaffSystem.
   * Multiplier callbacks key off this. */
  memberId: string;
  /** Storey the actor is assigned to. Chefs only claim stations on
   * this floor; waiters only deliver to seats on this floor. Defaults
   * to 0 (ground) which matches every actor's pre-multi-storey home. */
  homeFloor: number;
  home: THREE.Vector2; // where they return to when idle
  state: "idle" | "movingToWork" | "working" | "returningHome";
  /** What they're working on (a ticket id). */
  ticketId: string | null;
  /** Move target while not at home. */
  target: THREE.Vector2;
  /** Per-state timer. */
  clock: number;
  /** Small plate mesh held above their hands while delivering. Created
   * lazily on first delivery, then shown/hidden via .visible. */
  heldPlate?: THREE.Mesh;
  /** Walk speed in units/sec — set per role at register-time so chef
   * and waiter can move at different speeds without branching in the
   * shared moveActor. */
  speed: number;
  /** Remaining waypoints (in world coords) from the most recent
   * pathfind to a.target. Empty array = no plan; moveActor falls back
   * to direct movement so the actor still does SOMETHING. Each step
   * carries its floor + fromStair flag so deliveries that cross
   * storeys drive the smooth Y ride up the staircase. */
  path: MultiFloorPathStep[];
  /** Storey the actor's body is currently rendered on. Starts at
   * homeFloor and updates whenever moveActor consumes a fromStair-
   * flagged waypoint. Anchors the body Y between stair walks. */
  currentFloor: number;
  /** Phase 9.65 (staff migration Pass 6) — latest authoritative pose from
   * the staff_actor cloud row, stashed by reconcileCloudStaffActor. When
   * ?serverSim=staffMove is on, update() lerps the body toward (cloudX,
   * cloudZ), adopts cloudFloor, and animates from cloudState — the server
   * fully owns locomotion. Undefined until the first cloud row arrives. */
  cloudX?: number;
  cloudZ?: number;
  cloudFloor?: number;
  cloudState?: string;
  /** Phase M.13 — server-mirrored task fields so the bubble label reflects
   * what a SERVER-DRIVEN staffer is ACTUALLY doing (the old label read
   * client-local fields that server actors never had). */
  cloudDeliveryPhase?: string | null; // "pickup" (→ fetch) | "deliver" (→ serve) | null
  cloudTakeOrderActive?: boolean;
  cloudWashPhase?: string;            // "" | "pickup" (grab dirty) | "scrub" (at sink)
  cloudCleanActive?: boolean;
  /** Phase 9.70 — snapshot-interp for the staffMove render: the pose BEFORE
   * the latest cloud update + a 0→1 clock advanced each frame, so the body
   * glides between the two most recent 2 Hz server poses instead of catching
   * up fast then stalling (the "teleport forward, pause" stutter). */
  cloudPrevX?: number;
  cloudPrevZ?: number;
  cloudInterp?: number;
  /** Phase M.17 — while a server-driven stair hop is in progress this holds
   * the storey the body is climbing FROM, so renderActorFromServer ramps Y
   * from that floor to cloudFloor over the pose's interp instead of snapping
   * the storey. Undefined when not on the stairs. */
  stairFromFloor?: number;
  /** Last consumed waypoint — used to anchor the start of a stair
   * Y interpolation. */
  prevWaypoint?: MultiFloorPathStep;
  /** Storey the actor is currently routing TOWARD (target's floor).
   * Mirrors a.target's XZ — set by the state machine whenever
   * a.target is reassigned. Drives the multi-floor pathfind. */
  targetFloor: number;
  /** Seconds the actor has been idle WITHOUT any home-floor work
   * available. Increments while idle with no matching home-floor
   * ticket / wash job; resets to 0 whenever home-floor work is picked
   * up. Cross-floor fallback only kicks in once this passes
   * CROSS_FLOOR_WAIT_SECONDS — gives a local chef / waiter a moment
   * to free up before the staff member crosses the stair to handle
   * someone else's floor. */
  homeWorkWaitClock: number;
  /** Seconds accumulated since the last replan. Drives the periodic
   * re-route in moveActor so a stale path computed before the player
   * placed an obstacle gets refreshed on the next tick — without this,
   * a waiter mid-delivery follows their original waypoints straight
   * through a newly-placed wall or table. */
  replanAccum: number;
  /** Stuck-recovery: the last position where the actor made real movement
   * progress, plus seconds stalled since. When it stalls while it should be
   * walking (clipped onto furniture, can't path off the blocked cell it's
   * standing in), snap it onto a clear tile + re-plan. */
  lastStuckPos?: THREE.Vector2;
  stuckClock?: number;
  /** Chef only: uid of the stove this chef is currently reserving while
   * cooking. Released on finish/abandon/fire so another chef can take
   * it. null between cooks. */
  assignedStoveUid?: string | null;
  /** Phase M.8 — server-computed facing (radians) to hold WHILE WORKING at
   * the station, so a chef/barman faces the stove/bar instead of freezing on
   * their last-walk direction. Mirrored from StaffActor.face_y. */
  faceY?: number;
  /** Chef only: uid of the most recent stove they cooked at. Used as
   * the anchor for their idle "loiter" zone — same vibe as the errand
   * helper hanging out near the supply counter. */
  lastStoveUid?: string | null;
  /** Waiter only: current wash trip, or null when on a serve task /
   * idle. While set, the state machine's movingToWork / working
   * states reinterpret to mean "walking the wash trip" / "scrubbing
   * at the station" instead of "going to pick up a plate" / "carrying
   * to a seat". */
  washTrip?: WashTrip | null;
  /** Waiter only: active take-order task. While set, the state
   * machine's movingToWork / working reinterpret to mean "walking to
   * the seated guest" / "dwelling at the seat to take the order".
   * Cleared on completion / abandonment. Mutually exclusive with
   * washTrip and ticketId (the waiter is only ever doing one thing). */
  takeOrderRequest?: OrderRequest | null;
  /** Waiter only (Phase 9.45) — seat_uid of the dirty seat this waiter
   * is bussing on a server-dispatched STRICT clean trip. While set,
   * movingToWork / working reinterpret to "walking to the dirty seat" /
   * "clearing the plates"; completion is server-driven (the bridge's
   * release case fires when staff_actor.clean_seat_uid clears). Purely
   * cosmetic locomotion locally — the dirty_pile rows are server-
   * canonical and vanish via subscription when the server deletes them.
   * Mutually exclusive with washTrip / takeOrderRequest / ticketId. */
  cleanSeatUid?: string | null;
  /** Last mirror fingerprint published to the cloud — a compact
   * "state|ticketId|targetX|targetZ" string. streamActorsToCloud
   * uses this to skip the mirror reducer call when nothing material
   * has changed since the last publish, AND to fire mirrors
   * immediately when something HAS changed (rather than waiting for
   * the next 1-second tick). Saves bandwidth on idle actors AND
   * makes visit-mode catch state changes in < 100ms instead of < 1s.
   *
   * Undefined until the first mirror — that ensures the very first
   * publish always fires regardless of values. */
  lastMirrorFingerprint?: string;
  /** Diagnostics — cumulative ms spent in each waiter activity, keyed by
   * waiterActivityKey(). Filled by accumulateWaiterActivity each frame from the
   * (server-mirrored) state so time bottlenecks are visible via waiterTimes(). */
  activityMs?: Record<string, number>;
}

/** Snapshot of a placed stove the router can assign a chef to. */
export interface StoveInfo {
  uid: string;
  x: number;
  z: number;
  rotY: number;
  /** Storey the stove sits on. Phase 7d uses this so a Floor-1 chef
   * only claims Floor-1 stoves. */
  floor: number;
}

/** Snapshot of any cook station — stove, counter, toaster, etc.
 * `provides` tags it with the appliance type so the chef can pick the
 * right one for the recipe at hand. */
export interface StationInfo {
  uid: string;
  provides: string;
  x: number;
  z: number;
  rotY: number;
  /** Storey the station sits on. Same floor filter as StoveInfo. */
  floor: number;
}

// Chef stays slow so the visible "shuffle to the stove" reads at the
// shorter walks the kitchen makes. Waiter is +20% over that — their
// deliveries cross the dining room and they need to keep up with
// ticket flow.
const CHEF_SPEED = 1.2;
// Waiter is 200% of CHEF_SPEED — the take-order step added a second
// dining-room trip on top of delivery, and a 4-floor building stretches
// out their average route. 2.4 is faster than the customer WALK_SPEED
// (1.8) so a waiter delivering visibly overtakes a customer walking
// past, which reads as "hustling" rather than "matched pace". Keeps
// per-customer wait times sane even when one waiter is covering
// multiple floors.
const WAITER_SPEED = 2.4;

/** Player-restaurant interior bounds — the floor plane is
 * PlaneGeometry(10, 10) centered at (+0.5, +0.5), spanning X ∈
 * [-4.5, +5.5] and Z ∈ [-4.5, +5.5]. Waiters / chefs / barmen are
 * "indoor staff" and must NEVER end up outside those walls.
 *
 * The bug this stops: PersonalSpace pushes overlapping actors
 * apart each frame; near the door (south wall, z=+5.5) waiters and
 * arriving customers cluster, and the cumulative outward push
 * eventually drove an idle waiter through the wall onto the
 * pavement / mid-air outside upper floors.
 *
 * Clamp values are inset by 0.30 m from the wall plane so the
 * character body (≈0.45 m wide) doesn't visibly clip the wall
 * from the outside. */
const INTERIOR_MIN_X = -4.20;
const INTERIOR_MAX_X = +5.20;
const INTERIOR_MIN_Z = -4.20;
const INTERIOR_MAX_Z = +5.20;
/** How long an idle waiter (or chef) will wait for HOME-FLOOR work
 * before falling back to cross-floor work. Tuned for ~2s so a local
 * chef / waiter has a moment to free up before the staff member
 * crosses the stair to handle someone else's floor — strictly local
 * setups stay local, mixed setups still get cross-floor coverage when
 * the local pool is dry for more than a couple of seconds. */
const CROSS_FLOOR_WAIT_SECONDS = 2.0;
/** How long a waiter dwells at a seated guest's table "taking the
 * order" before the kitchen ticket is enqueued. Short on purpose —
 * the visible beat reads as a brief stop, and any longer makes the
 * customer's patience timer punish realistic staffing levels. */
const TAKE_ORDER_DWELL_SECONDS = 1.5;

/** Phase 9.45 — defensive cap on how long a waiter holds the bussing
 * pose before self-releasing home, used ONLY if the server's clean-trip
 * release never arrives (e.g. disconnect mid-trip). In normal operation
 * the server clears clean_seat_uid first (after its 1.5 s dwell) and the
 * bridge release fires well before this. Generous so it never pre-empts
 * the authoritative completion. */
const SEAT_CLEAN_FALLBACK_SECONDS = 6.0;

/** Flip to true (or rebuild) to log every actor's per-frame movement
 * sample (`[Router/move] state now @ (x, y) target …`). Was on by
 * default while diagnosing "are the chefs actually moving?" — at ~5%
 * sampling per moving actor it dominates the console once everyone's
 * working. Off in production; the once-per-event logs (enqueued, chef
 * picked up, etc.) still fire so you can trace ticket flow without it. */
const DEBUG_ROUTER_LOGS = false;
const ARRIVAL_THRESHOLD = 0.18;
/** Take-order trips stop this far from the guest's seat so the waiter ends up
 * standing BESIDE the seated guest (and turns to face them) instead of walking
 * right onto / inside them. ~0.75 m ≈ one body-width of clearance. */
const ORDER_STAND_DISTANCE = 0.75;

/** Shared geometry/material so all waiters reuse the same allocation. */
let sharedPlateGeo: THREE.CylinderGeometry | undefined;
let sharedPlateMat: THREE.MeshStandardMaterial | undefined;
function makePlate(): THREE.Mesh {
  if (!sharedPlateGeo) {
    sharedPlateGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.018, 14);
    sharedPlateMat = new THREE.MeshStandardMaterial({ color: 0xfaf2e2, roughness: 0.4 });
  }
  const plate = new THREE.Mesh(sharedPlateGeo, sharedPlateMat!);
  // Carry the plate roughly at belly height, slightly forward of the
  // body — like someone holding a tray with two hands. We used to put
  // it at y=1.0 but the parent character has scale 1.7, so the plate
  // ended up floating well above the waiter's head. y=0.55 puts it
  // around scaled-belly height (0.55 * 1.7 ≈ 0.93 in world units).
  plate.position.set(0, 0.55, 0.18);
  plate.castShadow = true;
  plate.visible = false;
  return plate;
}

export class StaffRouter {
  /** Public queue: GuestSpawner enqueues, GuestSpawner polls for DELIVERED. */
  readonly tickets: Ticket[] = [];

  /** Public queue of guests waiting for a waiter to take their order.
   * GuestSpawner pushes when a guest reaches the seated state; waiters
   * drain it in their idle handler. Removed when the order-taking
   * trip completes successfully or is cancelled. */
  readonly orderRequests: OrderRequest[] = [];

  /** Engine wires this — fires when a waiter completes the dwell at a
   * seated guest's table. GuestSpawner's handler builds the recipe
   * list and calls enqueueOrder. Returns nothing; the spawner's call
   * to enqueueOrder writes the resulting ticket id back onto the
   * guest. If the guest has already left, the spawner's handler is
   * expected to no-op. */
  takeOrderCallback?: (guestId: string) => void;

  /** Engine wires this to GuestSpawner.getGuestPatience so the staff
   * router can sort work candidates by remaining customer patience.
   * Returns seconds-of-patience-left (lower = more urgent); returns
   * undefined when the guest can't be found (stale ticket, just
   * despawned). Used by the chef / waiter / barman idle handlers
   * to pick the most-urgent ticket instead of the oldest one. */
  getGuestPatience?: (guestId: string) => number | undefined;

  /** Phase C.3b — when isServerSim("tickets") is on, the StaffRouter
   * MIRRORS its local Ticket lifecycle to the SpacetimeDB
   * active_ticket table via this cloud client. Engine sets it after
   * construction; null in tests / pre-cloud boot paths. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;

  /** Resolves a local guest id ("guest-7") to its server-side
   * active_guest auto-inc u64. Engine wires this to
   * GuestSpawner.lookupGuestServerId so placeOrder can supply
   * the correct guest_id FK. Returns undefined when the guest
   * isn't (yet) mirrored — the calling mirror helper bails. */
  lookupGuestServerId?: (localGuestId: string) => bigint | undefined;

  /** Phase H Phase 3c — reverse of lookupGuestServerId.  Engine wires
   * this to GuestSpawner.findLocalGuestIdByServerId so the cloud
   * bridge can materialize a server-spawned Ticket (clientTempId
   * starts with "srv-") and attach it to the right local Guest. */
  lookupLocalGuestId?: (serverGuestId: bigint) => string | undefined;

  private readonly chefs: StaffActor[] = [];
  private readonly waiters: StaffActor[] = [];
  /** Barmen pool. Behave like chefs but only cook drink-category
   * recipes, and only at bar-counter stations. Bar-seated guests'
   * order requests route here instead of to the waiter pool — the
   * barman handles both the take-order and the serve trip directly,
   * since the customer is already standing at the bar counter and
   * the barman doesn't have to walk anywhere meaningful. */
  private readonly barmen: StaffActor[] = [];

  /** Where the chef cooks (next to the stove). */
  private readonly stovePos: THREE.Vector2;
  /** Where the waiter picks up plates from the chef. */
  private readonly pickupPos: THREE.Vector2;

  /** Optional pathfinder — when set, every target assignment recomputes
   * a path that routes around blocking furniture. Without it, staff
   * fall back to direct A→B movement (the pre-pathfinding behaviour). */
  private readonly pathfind?: Pathfinding;

  /** Live snapshot of placed stoves. Each chef reserves one before
   * walking over so two chefs can't pile on the same appliance. When
   * the callback returns an empty list (no stove placed anywhere) we
   * fall back to the legacy shared {@link stovePos}. */
  private readonly getStoves?: () => readonly StoveInfo[];
  /** Live snapshot of every cook station — anything with a `provides`
   * value (stoves, counters, toaster, coffee machine, blender, etc.).
   * Phase C.2: the chef picks a station whose `provides` matches the
   * recipe's required appliance. Falls back to the legacy stove pool
   * when no station provides the appliance the recipe asks for. */
  private readonly getCookStations?: () => readonly StationInfo[];

  /** Per-MEMBER walking speed multiplier (was per-role before the
   * per-staff refactor). Applied each tick in moveActor so a waiter
   * trained mid-shift speeds up on the next frame. Returns 1.0 by
   * default — the base CHEF_SPEED / WAITER_SPEED constants stand. */
  private readonly getSpeedMultiplier?: (memberId: string) => number;

  /** Per-MEMBER chef cook-time multiplier — applied to the ticket the
   * moment a chef picks it up so the chef counting down the timer
   * matches THAT chef's training. */
  private readonly getChefCookMultiplier?: (memberId: string) => number;

  /** uids of stoves currently reserved by a chef in cooking flight.
   * Cleared when the chef leaves the "working" state OR when they're
   * fired mid-cook. */
  private readonly busyStoveUids = new Set<string>();

  /** uids of wash stations currently occupied by a waiter mid-trip.
   * Same pattern as busyStoveUids — prevents two waiters from piling
   * onto the same sink. Cleared when the wash trip ends OR when the
   * waiter gets fired mid-wash. */
  private readonly busyWashUids = new Set<string>();

  /** Engine wires a dev-mode logger here so wash-trip lifecycle events
   * (pickup, completion, fired-mid-carry) flow into the leak watcher's
   * ring buffer. Off by default — no instrumentation cost in normal
   * play. */
  setDishwareLogger(fn: ((msg: string) => void) | undefined): void {
    this.dishwareLogger = fn;
  }
  private dishwareLogger?: (msg: string) => void;

  /** Wash-loop callbacks — wired by Engine after GuestSpawner + the
   * dishware system exist. When unset, the waiter never tries to
   * wash and dirty plates simply pile up on the tables. */
  /** Hook for re-parenting a staff character to a different storey's
   * mount group when they cross the staircase. Engine wires this to
   * WorldScene.reparentCharacterToFloor so the model lives under the
   * right floor's visibility group while the mover handles the body Y
   * interpolation across the steps. */
  reparentCharacter?: (character: AnimatedCharacter, toFloor: number) => void;
  washCallbacks?: {
    getDirtyPickups: () => DirtyPickupInfo[];
    claimDirtyPickup: (id: number, memberId: string) => boolean;
    releaseDirtyPickup: (id: number) => void;
    pickupDirty: (id: number) => DishKind | null;
    getWashStations: () => WashStationInfo[];
    /** Sink path: scrub one dirty piece of `kind` into clean. Picks
     * the highest-tier dirty piece globally. */
    washOne: (kind: DishKind) => void;
    /** Dishwasher path: can this station accept one more piece of
     * this kind? Drives the start-of-trip station picker — full
     * dishwashers are skipped in favour of empty ones or sinks. */
    canDishwasherLoad: (uid: string, kind: DishKind) => boolean;
    /** H.95 — How many MORE pieces of `kind` can this dishwasher
     * accept right now (cap N). Used by the batch-pickup planner
     * to decide how many extras a waiter can claim for one trip
     * before the target station fills up. Returns min(remaining
     * capacity, max). */
    canDishwasherLoadN: (uid: string, kind: DishKind, max: number) => number;
    /** Dishwasher path: drop the piece in. Returns false if the
     * batch is full (rare — the canDishwasherLoad check should keep
     * trips from reaching here on a full unit, but waiters in flight
     * can race so we still bail gracefully). */
    loadDishwasher: (uid: string, defId: string, kind: DishKind) => boolean;
  };

  constructor(
    chefChar: AnimatedCharacter,
    chefMemberId: string,
    waiterChar: AnimatedCharacter,
    waiterMemberId: string,
    stovePos: THREE.Vector2,
    pickupPos: THREE.Vector2,
    pathfind?: Pathfinding,
    getStoves?: () => readonly StoveInfo[],
    getSpeedMultiplier?: (memberId: string) => number,
    getChefCookMultiplier?: (memberId: string) => number,
    getCookStations?: () => readonly StationInfo[],
  ) {
    this.stovePos = stovePos.clone();
    this.pickupPos = pickupPos.clone();
    this.pathfind = pathfind;
    this.getStoves = getStoves;
    this.getSpeedMultiplier = getSpeedMultiplier;
    this.getChefCookMultiplier = getChefCookMultiplier;
    this.getCookStations = getCookStations;
    this.addChef(chefChar, chefMemberId);
    this.addWaiter(waiterChar, waiterMemberId);
  }

  /** Compute the chef's standing position one tile in front of a stove.
   * Stove models face their +Z axis by default, so the chef's spot is
   * (stove.x + sin rotY, stove.z + cos rotY). */
  private chefStandPosFor(stove: StoveInfo): THREE.Vector2 {
    return new THREE.Vector2(
      stove.x + Math.sin(stove.rotY),
      stove.z + Math.cos(stove.rotY),
    );
  }

  /** Reserve the first stove that isn't already in {@link busyStoveUids}.
   * Returns null when every stove is busy. Callers should defer the
   * cook (stay idle) when this returns null so a second chef doesn't
   * walk to a stove already in use. `homeFloor` restricts the claim
   * to stoves on the chef's assigned storey — a Floor-1 chef won't
   * snatch a ground-floor stove (and vice versa). */
  private claimFreeStove(homeFloor = 0): StoveInfo | null {
    if (!this.getStoves) return null;
    const stoves = this.getStoves();
    for (const s of stoves) {
      if (s.floor !== homeFloor) continue;
      if (!this.busyStoveUids.has(s.uid)) {
        this.busyStoveUids.add(s.uid);
        return s;
      }
    }
    return null;
  }

  /** Reserve a cook station whose `provides` matches the recipe's
   * required appliance, isn't already busy, AND sits on the chef's
   * home floor. When `originPos` is supplied, picks the CLOSEST
   * matching station to that position instead of the first one in
   * the array (C4 — chef no longer walks past three free stoves to
   * claim the northmost). Falls back to the legacy stove pool when
   * the requested appliance is "stove" but the cook-stations
   * callback hasn't been wired — keeps old save compat alive. */
  private claimFreeStation(appliance: string, homeFloor = 0, originPos?: THREE.Vector2, allowCrossFloor = false): StationInfo | null {
    if (this.getCookStations) {
      // Pass 1: same-floor preferred. The chef's home floor is the
      // first pick so we avoid unnecessary cross-floor walks.
      let bestStation: StationInfo | null = null;
      let bestDist = Infinity;
      for (const s of this.getCookStations()) {
        if (s.provides !== appliance) continue;
        if (s.floor !== homeFloor) continue;
        if (this.busyStoveUids.has(s.uid)) continue;
        if (!originPos) { bestStation = s; break; }
        const standPos = this.chefStandPosFor(s);
        const dist = Math.hypot(standPos.x - originPos.x, standPos.y - originPos.y);
        if (dist < bestDist) { bestStation = s; bestDist = dist; }
      }
      if (bestStation) {
        this.busyStoveUids.add(bestStation.uid);
        return bestStation;
      }
      // Pass 2: any floor — only when the caller opted in (orphan-
      // pickup cross-floor branch). Without this, a chef on Floor 0
      // can't reach a Floor 1 toaster even when nobody else can cook
      // it. Cross-floor adds a ~20s round-trip walk (stair climb,
      // cook, walk back) so we gate it behind the wait timer that
      // the orphan branch already enforces.
      if (allowCrossFloor) {
        bestDist = Infinity;
        for (const s of this.getCookStations()) {
          if (s.provides !== appliance) continue;
          if (this.busyStoveUids.has(s.uid)) continue;
          if (!originPos) { bestStation = s; break; }
          const standPos = this.chefStandPosFor(s);
          const dist = Math.hypot(standPos.x - originPos.x, standPos.y - originPos.y);
          if (dist < bestDist) { bestStation = s; bestDist = dist; }
        }
        if (bestStation) {
          this.busyStoveUids.add(bestStation.uid);
          return bestStation;
        }
      }
    }
    // Last-ditch fallback for "stove" specifically — keeps the chef
    // working when an old save only wired the stove callback.
    if (appliance === "stove") {
      const s = this.claimFreeStove(homeFloor);
      if (s) return { ...s, provides: "stove" };
    }
    return null;
  }

  /** A loiter spot for a chef who isn't cooking right now. Priority
   * (top wins):
   *   1. Their LAST station (if it still exists) — preserves the
   *      "this chef cooks here" association the player just saw.
   *   2. Any STOVE on the chef's home floor — stoves outrank other
   *      appliances because they're the iconic "I'm a cook" station.
   *   3. Any cook station on the home floor (counter, toaster, etc.)
   *      — chefs gather near appliances even if no stove is placed.
   *   4. Their original spawn home — fallback when the kitchen is
   *      empty of cooking gear.
   * In every case a small random jitter is added so multiple idle
   * chefs don't stack on the exact same tile. */
  /** Nudge an idle/home spot off any furniture or wall it landed on so staff
   * don't stand inside objects. Snaps to the nearest clear nav-grid tile;
   * no-op without a pathfinder or when the spot is already clear. */
  private snapIdleClear(v: THREE.Vector2, floor: number): THREE.Vector2 {
    // Keep idle spots INSIDE the building. The nav grid treats cells BEYOND the
    // walls as clear (no furniture out there), so a station near a wall + a
    // crowded interior could otherwise snap a staffer OUTSIDE — and the server
    // then walks them to that out-of-bounds target (seen live: an idle waiter
    // at x=7.25 targeting x=8.1, past INTERIOR_MAX_X=5.2). Clamp the anchor
    // before the snap AND the result after it.
    const cx = Math.max(INTERIOR_MIN_X, Math.min(INTERIOR_MAX_X, v.x));
    const cz = Math.max(INTERIOR_MIN_Z, Math.min(INTERIOR_MAX_Z, v.y));
    if (!this.pathfind) { v.set(cx, cz); return v; }
    const s = this.pathfind.snapToClear(cx, cz, floor);
    v.set(
      Math.max(INTERIOR_MIN_X, Math.min(INTERIOR_MAX_X, s.x)),
      Math.max(INTERIOR_MIN_Z, Math.min(INTERIOR_MAX_Z, s.z)),
    );
    return v;
  }

  private pickChefIdleSpot(c: StaffActor): THREE.Vector2 {
    return this.snapIdleClear(this.pickChefIdleSpotRaw(c), c.homeFloor);
  }
  private pickChefIdleSpotRaw(c: StaffActor): THREE.Vector2 {
    const jitter = (v: THREE.Vector2): THREE.Vector2 => {
      v.x += (Math.random() - 0.5) * 1.2;
      v.y += (Math.random() - 0.5) * 0.8;
      return v;
    };
    // 1. Last station they cooked at (Phase C.2: any cook station,
    // not just a stove — search broader pool first, then stoves so
    // old save state remains valid).
    if (c.lastStoveUid) {
      const fromStations = this.getCookStations?.().find((s) => s.uid === c.lastStoveUid);
      const fromStoves = !fromStations
        ? this.getStoves?.().find((s) => s.uid === c.lastStoveUid)
        : undefined;
      const station = fromStations ?? fromStoves;
      if (station) return jitter(this.chefStandPosFor(station));
      // The station was sold/moved — forget it so we don't keep
      // searching for a ghost next tick.
      c.lastStoveUid = null;
    }
    // 2. Any STOVE on this chef's home floor — stoves are the
    // default "chef station" so gravitate there before counters.
    if (this.getCookStations) {
      const stove = this.getCookStations().find((s) => s.provides === "stove" && s.floor === c.homeFloor);
      if (stove) return jitter(this.chefStandPosFor(stove));
    }
    if (this.getStoves) {
      const stove = this.getStoves().find((s) => s.floor === c.homeFloor);
      if (stove) return jitter(this.chefStandPosFor(stove));
    }
    // 3. Any cook station on the home floor (toaster, counter,
    // blender, coffee machine, etc.) — chef should be near the
    // appliance they'd next pick up from.
    if (this.getCookStations) {
      const station = this.getCookStations().find((s) => s.floor === c.homeFloor);
      if (station) return jitter(this.chefStandPosFor(station));
    }
    // 4. Fallback — original spawn home.
    return c.home.clone();
  }

  /** Recompute the path from the actor's current position to its
   * target. Called whenever the state machine writes a fresh
   * a.target. Falls back to a single direct waypoint when the
   * pathfinder is missing or returns nothing useful. */
  private planPath(a: StaffActor): void {
    if (!this.pathfind) {
      a.path = [{ x: a.target.x, z: a.target.y, floor: a.targetFloor }];
      return;
    }
    // Keep the DESTINATION off furniture. A target on a blocked cell — most
    // often a staff home spot the player later dropped an appliance/chair onto
    // (homes are fixed at hire, never re-checked; e.g. a waiter home at
    // (3.9,-1) with a coffee machine at (4,-1)) — is unreachable: the actor
    // walks up, can't path onto the cell, and stalls there playing the walk
    // loop ("stands in the chair / coffee machine"). Snap the target onto the
    // nearest clear tile first. Reachable targets (seats, station fronts) are
    // already clear, so this is a no-op for them.
    const st = this.pathfind.snapToClear(a.target.x, a.target.y, a.targetFloor);
    // ...and keep the target INSIDE the building. The snap can land beyond a
    // wall (the nav grid has no cells out there, so empty outdoor tiles read as
    // "clear"); a target outside walks the staffer onto the street / in through
    // a wall. Same 10x10 footprint on every floor.
    a.target.set(
      Math.max(INTERIOR_MIN_X, Math.min(INTERIOR_MAX_X, st.x)),
      Math.max(INTERIOR_MIN_Z, Math.min(INTERIOR_MAX_Z, st.z)),
    );
    a.path = this.pathfind.findMultiFloorPath(
      { x: a.character.groundPos.x, z: a.character.groundPos.y, floor: a.currentFloor },
      { x: a.target.x, z: a.target.y, floor: a.targetFloor },
    );
    if (a.path.length === 0) {
      a.path = [{ x: a.target.x, z: a.target.y, floor: a.targetFloor }];
    }
    // Diagnostic: log every cross-floor plan so we can see the stair leg
    // actually being emitted. Trimmed to one console line per plan.
    if (a.currentFloor !== a.targetFloor) {
      const hop = a.path.find((s) => s.fromStair);
      console.log(`[Router] ${a.role} plan F${a.currentFloor}→F${a.targetFloor} from (${a.character.groundPos.x.toFixed(1)},${a.character.groundPos.y.toFixed(1)}) to (${a.target.x.toFixed(1)},${a.target.y.toFixed(1)}): ${a.path.length} waypoints, stair=${hop ? `(${hop.x},${hop.z},F${hop.floor})` : "MISSING"}`);
    }
  }

  // ======================================================================
  //              Phase I.1 — H.48 cloud hydrate on reconnect
  // ======================================================================
  //
  // Mirror-shape of H.47 but for staff actors.  The local sim seeds
  // staff from the save's HiredStaffMember list (their last-saved
  // positions and state), but the server's staff_actor table has the
  // CURRENT state after any H.6/H.8/H.34/H.35 dispatches the server
  // tick fired while we were offline.  hydrateFromCloud updates each
  // local actor in place to match.

  /** True once hydrateFromCloud has run at least once.  Re-runs are
   * idempotent but tracked to keep the log noise down. */
  private cloudHydratedStaff = false;

  /** Look up a local actor across all role pools by HiredStaffMember
   * id.  Returns undefined when the actor hasn't been added to the
   * router yet (member hired but character GLB still loading). */
  private findActorByMemberId(memberId: string): StaffActor | undefined {
    for (const c of this.chefs) if (c.memberId === memberId) return c;
    for (const w of this.waiters) if (w.memberId === memberId) return w;
    for (const b of this.barmen) if (b.memberId === memberId) return b;
    return undefined;
  }

  /** Phase I.1 (H.48b) — Reconstruct local Ticket rows from cloud's
   * active_ticket table.  Bridges the gap between save (which has
   * tickets at the last autosave time — potentially stale or absent
   * if the server cooked them through during offline) and the live
   * server state.
   *
   * Caller supplies a guestServerId → localId lookup (the GuestSpawner
   * owns the mapping); rows whose cloud guest_id has no matching
   * local guest are skipped (their guest was either already settled
   * or doesn't exist on this client). */
  hydrateTicketsFromCloud(
    guestLocalIdByServerId: (serverId: bigint) => string | undefined,
  ): void {
    if (!this.cloud) return;
    const rows = this.cloud.listActiveTickets();
    if (rows.length === 0) {
      // Phase 9.2 — log once, not on every 5 Hz retry tick.
      if (!this.loggedEmptyTicketHydrate) {
        this.loggedEmptyTicketHydrate = true;
        console.log("[H.48b] hydrateTicketsFromCloud: no cloud active_ticket rows");
      }
      return;
    }
    // Build local server-id set so we don't double-import.
    const localServerIds = new Set<bigint>();
    for (const t of this.tickets) {
      if (t.serverMirrorId != null) localServerIds.add(t.serverMirrorId);
    }
    let imported = 0;
    let skippedNoGuest = 0;
    for (const row of rows) {
      if (localServerIds.has(row.id)) continue;
      const localGuestId = guestLocalIdByServerId(row.guestId);
      if (!localGuestId) {
        skippedNoGuest += 1;
        continue;
      }
      // Look up recipe for the base cook time + appliance fallback.
      const recipe = recipes.find((r) => r.id === row.recipeId);
      const appliance = recipe?.appliances?.[0]
        ?? recipe?.stationNeeded
        ?? "stove";
      const baseCookSeconds = recipe?.preparationTimeSeconds ?? 5;
      // Map cloud ticket state to local TicketState.  Server has
      // "queued"/"cooking"/"ready"/"delivering"; local has the same
      // set + "delivered" terminal which the server reaches by
      // deleting the row (so we never see it here).
      const state: TicketState =
        (row.state === "queued" || row.state === "cooking"
         || row.state === "ready" || row.state === "delivering")
          ? row.state : "queued";
      const ticket: Ticket = {
        id: `cloud-tk-${row.id}`,
        guestId: localGuestId,
        recipeId: row.recipeId,
        state,
        seatPos: new THREE.Vector2(row.seatX, row.seatZ),
        clock: Number(row.stateClockMs) / 1000,
        baseCookSeconds,
        cookSeconds: Number(row.cookSeconds) / 1000 || baseCookSeconds,
        appliance,
        seatFloor: row.seatFloor,
        pickupPos: new THREE.Vector2(row.pickupX, row.pickupZ),
        pickupFloor: row.pickupFloor,
        seatAtBar: row.seatAtBar,
        assignedChefId: row.assignedChefId || null,
        serverMirrorId: row.id,
      };
      this.tickets.push(ticket);
      imported += 1;
    }
    // Phase 9.2 — only log when something actually imported; the
    // 5 Hz retry loop calls this repeatedly and an all-deduped pass
    // is the steady-state, not news.
    if (imported > 0) {
      console.log(
        `[H.48b] hydrateTicketsFromCloud: ${imported} tickets imported` +
        (skippedNoGuest > 0 ? ` (${skippedNoGuest} skipped — no matching local guest)` : ""),
      );
    }
  }

  /** Apply cloud staff_actor state to every matching local actor.
   * Save-restored positions get overwritten with whatever the
   * server's mid-trip state was when we reconnected.  Mid-trip
   * detail (wash trip dirty-piece lookup, ticket binding) is best-
   * effort — Phase I.1 covers visual continuity; H.49 will close
   * the remaining gaps via live subscriptions. */
  hydrateFromCloud(): void {
    if (!this.cloud) return;
    if (this.cloudHydratedStaff) return;
    // Phase 9.2 — Boot-race guard: don't latch on the empty answer
    // listStaffActors gives before conn + restaurantId resolve.
    // Engine retries at 1 Hz until the context exists.
    if (!this.cloud.hasRestaurantContext()) return;
    const rows = this.cloud.listStaffActors();
    if (rows.length === 0) {
      // Context is up (conn + restaurantId) but the staff_actor rows
      // haven't landed in the subscription cache yet. DON'T latch on this
      // empty answer — otherwise the staff stay frozen at their default
      // spawn spots forever (hydrate is once-latched and never re-runs).
      // Retry on the next 1 Hz tick.
      return;
    }
    this.cloudHydratedStaff = true;
    let updated = 0;
    let missing = 0;
    for (const row of rows) {
      const actor = this.findActorByMemberId(row.memberId);
      if (!actor) {
        missing += 1;
        continue;
      }
      // ---- Body position + floor ----
      // Clamp the hydrated body into the building — a stale server row can
      // carry an out-of-bounds x/z, and without this the staffer renders
      // OUTSIDE on reload, then walks in through the wall to its next task.
      actor.character.groundPos.set(
        Math.max(INTERIOR_MIN_X, Math.min(INTERIOR_MAX_X, row.x)),
        Math.max(INTERIOR_MIN_Z, Math.min(INTERIOR_MAX_Z, row.z)),
      );
      actor.currentFloor = row.floor;
      actor.target.set(row.targetX, row.targetZ);
      actor.targetFloor = row.targetFloor;
      // Re-parent the character to its current storey so visit-mode
      // -style floor focus shows them on the right slab.
      if (this.reparentCharacter && row.floor > 0) {
        this.reparentCharacter(actor.character, row.floor);
      }
      // ---- State machine ----
      const cloudState = row.state;
      const knownState = cloudState === "idle" || cloudState === "movingToWork"
          || cloudState === "working" || cloudState === "returningHome";
      actor.state = knownState ? cloudState : "idle"; // unknown defaults safe
      // ---- Work assignment ----
      // An actor forced to idle from an UNKNOWN cloud state must not keep a
      // stale ticket / stove binding — that left an idle actor "holding" a
      // ticket on reconnect, which can read as busy and stall dispatch. Only
      // adopt bindings for a recognised state.
      actor.ticketId = (knownState && row.ticketId != null)
        ? `cloud-tk-${row.ticketId}`
        : null;
      if (knownState && row.assignedStoveUid && (actor.role === "chef" || actor.role === "barman")) {
        actor.assignedStoveUid = row.assignedStoveUid;
      }
      // Phase M.8 — server-computed work-facing (toward the station).
      actor.faceY = row.faceY;
      // ---- Wash trip ----
      // Best-effort: cloud only exposes the station uid + phase.  We
      // can't reconstruct the full WashTrip (needs dirty piece +
      // station def_id + position + dwell).  Leave null and let the
      // next StaffRouter dispatch tick re-claim if appropriate.
      if (actor.role === "waiter") {
        actor.washTrip = null;
      }
      // ---- Action / animation ----
      actor.character.action = (actor.state === "idle"
                                || actor.state === "returningHome") ? "idle" : "walk";
      updated += 1;
    }
    // The server's straight-line position model can park a body INSIDE a
    // furniture footprint (it ignores walls + items). Snapping straight to
    // row.x/z therefore drops staff inside counters/tables on reload — push
    // every body out to a walkable cell NOW, instead of waiting for the
    // per-frame clamp to crawl them out after the veil has already lifted
    // (which is what left waiters standing in objects on load).
    this.clampAllStaffToInterior();
    console.log(
      `[H.48] hydrateFromCloud: ${updated} staff actors updated from cloud` +
      (missing > 0 ? ` (${missing} cloud rows skipped — local actor not found)` : ""),
    );
  }

  /** Append a chef to the pool. Their current ground position becomes home. */
  addChef(char: AnimatedCharacter, memberId: string, homeFloor = 0): void {
    this.cacheFeetLift(char, homeFloor);
    const actor: StaffActor = {
      character: char,
      role: "chef",
      memberId,
      homeFloor,
      currentFloor: homeFloor,
      targetFloor: homeFloor,
      home: char.groundPos.clone(),
      state: "idle",
      ticketId: null,
      target: char.groundPos.clone(),
      clock: 0,
      speed: CHEF_SPEED,
      path: [],
      replanAccum: 0,
      homeWorkWaitClock: 0,
      assignedStoveUid: null,
      lastStoveUid: null,
    };
    this.chefs.push(actor);
    this.mirrorActorRegister(actor);
  }

  addWaiter(char: AnimatedCharacter, memberId: string, homeFloor = 0): void {
    this.cacheFeetLift(char, homeFloor);
    const actor: StaffActor = {
      character: char,
      role: "waiter",
      memberId,
      homeFloor,
      currentFloor: homeFloor,
      targetFloor: homeFloor,
      home: char.groundPos.clone(),
      state: "idle",
      ticketId: null,
      target: char.groundPos.clone(),
      clock: 0,
      speed: WAITER_SPEED,
      path: [],
      replanAccum: 0,
      homeWorkWaitClock: 0,
      washTrip: null,
      cleanSeatUid: null, // Phase 9.45 — not bussing at register
    };
    this.waiters.push(actor);
    this.mirrorActorRegister(actor);
  }

  /** Append a barman. Behaves like a chef internally (state machine,
   * cook-station claim) but only operates on bar-counter stations and
   * drink recipes. Movement speed matches the chef — they barely walk,
   * but when they do it's the same slow tend-the-station shuffle. */
  addBarman(char: AnimatedCharacter, memberId: string, homeFloor = 0): void {
    this.cacheFeetLift(char, homeFloor);
    const actor: StaffActor = {
      character: char,
      role: "barman",
      memberId,
      homeFloor,
      currentFloor: homeFloor,
      targetFloor: homeFloor,
      home: char.groundPos.clone(),
      state: "idle",
      ticketId: null,
      target: char.groundPos.clone(),
      clock: 0,
      speed: CHEF_SPEED,
      path: [],
      replanAccum: 0,
      homeWorkWaitClock: 0,
      assignedStoveUid: null,
      lastStoveUid: null,
    };
    this.barmen.push(actor);
    this.mirrorActorRegister(actor);
  }

  /** Cache the character's raw feet-lift (offset above the floor slab,
   * independent of which storey they're standing on). _baseY captured
   * by the animator already bakes in homeFloor × STOREY for upper-floor
   * staff (the spawn code lifts them onto their slab); subtracting it
   * back out gives us the floor-agnostic offset every mover needs to
   * compute Y when the actor crosses to a different storey. */
  private cacheFeetLift(char: AnimatedCharacter, homeFloor: number): void {
    const STOREY = 3;
    const captured = char._baseY ?? char.root.position.y;
    char._feetLift = captured - homeFloor * STOREY;
  }

  /** Pop a chef out of the pool. Returns the AnimatedCharacter so the
   * caller (Engine) can remove its model from the scene. Prefers idle
   * chefs so we don't strand an in-progress ticket. Returns null if the
   * pool is empty. */
  /** Pin every indoor staff member's XZ position back inside the
   * building's walls. Engine calls this once per frame AFTER the
   * PersonalSpace push pass — without it, two waiters jostling each
   * other near the door can be incrementally shoved through the
   * south wall over a few seconds (the bug that put idle waiters
   * on the exterior wall surface of upper floors).
   *
   * Cheap: just three array walks with two compare-and-assign
   * branches per actor; safe to call every frame. */
  clampAllStaffToInterior(): void {
    // Cache the blocked-cell set per floor so computeBlocked runs at most once
    // per occupied storey per frame, not once per actor.
    const blockedByFloor = new Map<number, Set<string>>();
    const blockedFor = (floor: number): Set<string> | undefined => {
      if (!this.pathfind) return undefined;
      let s = blockedByFloor.get(floor);
      if (!s) { s = this.pathfind.blockedCells(floor); blockedByFloor.set(floor, s); }
      return s;
    };
    const clampInterior = (v: THREE.Vector2): void => {
      if (v.x < INTERIOR_MIN_X) v.x = INTERIOR_MIN_X;
      else if (v.x > INTERIOR_MAX_X) v.x = INTERIOR_MAX_X;
      if (v.y < INTERIOR_MIN_Z) v.y = INTERIOR_MIN_Z;
      else if (v.y > INTERIOR_MAX_Z) v.y = INTERIOR_MAX_Z;
    };
    const clampOne = (a: StaffActor): void => {
      // HARD body constraint — clamp into the building + eject from any
      // furniture it overlaps.
      const p = a.character.groundPos;
      clampInterior(p);
      const cells = blockedFor(a.currentFloor);
      if (cells) this.pushOutOfCells(p, cells);
      // HARD TARGET constraint — the body is walked toward a.target every
      // frame by the local sim, and under the server cutover that target is
      // the SERVER's straight-line goal, which ignores walls + furniture and
      // can sit outside the building or inside a counter. Clamping only the
      // body then just fights the sim (jitter at the wall, stuck against an
      // item, drifting mid-air over the grass on upper floors). Constrain the
      // destination to a reachable interior cell so the body has somewhere
      // valid to go. Legitimate work spots (stand-in-front-of-stove, pickup,
      // a seat) are already in clear cells, so this is a no-op for them and
      // only rescues the bad server targets.
      const t = a.target;
      clampInterior(t);
      const tcells = blockedFor(a.targetFloor);
      if (tcells) this.pushOutOfCells(t, tcells);
    };
    for (const a of this.chefs) clampOne(a);
    for (const a of this.waiters) clampOne(a);
    for (const a of this.barmen) clampOne(a);
  }

  /** Push a body circle (STAFF_BODY_RADIUS) OUT of any blocked furniture cells
   * it overlaps — circle-vs-AABB resolution, 2 relaxation passes so a body
   * wedged in a corner between two cells settles outside both. The pathfinder
   * routes around blocked CELLS, but the body has radius and personal-space
   * separation can shove a staffer into a counter/table; this runs every frame
   * AFTER both (via clampAllStaffToInterior) so they're never left standing in
   * an item. Walking along the path (cell centres, 0.5 from any blocked edge)
   * doesn't trigger it, so it doesn't fight normal movement. */
  private pushOutOfCells(p: THREE.Vector2, cells: Set<string>): void {
    if (cells.size === 0) return;
    const r = STAFF_BODY_RADIUS;
    for (let pass = 0; pass < 2; pass++) {
      const cx0 = Math.round(p.x), cz0 = Math.round(p.y);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cx = cx0 + dx, cz = cz0 + dz;
          if (!cells.has(`${cx},${cz}`)) continue;
          // Closest point on the 1x1 cell AABB to the body centre.
          const nx = Math.max(cx - 0.5, Math.min(p.x, cx + 0.5));
          const nz = Math.max(cz - 0.5, Math.min(p.y, cz + 0.5));
          const ox = p.x - nx, oz = p.y - nz;
          const d2 = ox * ox + oz * oz;
          if (d2 >= r * r) continue; // not overlapping this cell
          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const push = (r - d) / d;
            p.x += ox * push;
            p.y += oz * push;
          } else {
            // Centre is inside the cell — eject along the shallowest edge.
            const left = p.x - (cx - 0.5), right = (cx + 0.5) - p.x;
            const down = p.y - (cz - 0.5), upp = (cz + 0.5) - p.y;
            if (Math.min(left, right) <= Math.min(down, upp)) {
              p.x += left < right ? -(left + r) : (right + r);
            } else {
              p.y += down < upp ? -(down + r) : (upp + r);
            }
          }
        }
      }
    }
  }

  removeChef(): AnimatedCharacter | null {
    // Grab the actor BEFORE the splice so we still know their
    // memberId — needed to release any queued tickets they had
    // pending in their backlog. popPreferIdle picks the actual
    // chef (prefer-idle policy) and runs all the cleanup; we just
    // need to know who they were.
    const target = this.chefs.find((a) => a.state === "idle") ?? this.chefs[this.chefs.length - 1];
    const id = target?.memberId ?? null;
    const removed = this.popPreferIdle(this.chefs);
    if (id) {
      this.releaseBacklogForChef(id);
      this.mirrorActorUnregister(id);
    }
    return removed;
  }

  /** Drop the chef's claim on every queued ticket in their backlog
   * — sets assignedChefId=null on each so the chef idle handler
   * picks them up as orphan tickets via the same-floor / cross-
   * floor fallback. Tickets the chef was actively COOKING get
   * released separately by popPreferIdle (stove freed, ticket
   * bounced back to queued). */
  private releaseBacklogForChef(chefMemberId: string): void {
    for (const t of this.tickets) {
      if (t.assignedChefId === chefMemberId && t.state === "queued") {
        t.assignedChefId = null;
      }
    }
  }
  /** Pop a barman out of the pool. Same pattern as removeChef —
   * prefers idle members so an in-flight drink doesn't get stranded
   * when the player fires one. */
  removeBarman(): AnimatedCharacter | null {
    const target = this.barmen.find((a) => a.state === "idle") ?? this.barmen[this.barmen.length - 1];
    const id = target?.memberId ?? null;
    const removed = this.popPreferIdle(this.barmen);
    if (id) this.mirrorActorUnregister(id);
    return removed;
  }
  removeWaiter(): AnimatedCharacter | null {
    const target = this.waiters.find((a) => a.state === "idle") ?? this.waiters[this.waiters.length - 1];
    const id = target?.memberId ?? null;
    const removed = this.popPreferIdle(this.waiters);
    if (id) this.mirrorActorUnregister(id);
    return removed;
  }

  /** Remove a specific staff member by their HiredStaffMember.id —
   * walks every pool, runs the same cleanup (ticket rollback, stove
   * release, wash-trip recovery, take-order claim release) that the
   * LIFO removeChef/Waiter/Barman path runs, and returns the
   * AnimatedCharacter so Engine can drop the model. Returns null
   * if no actor in any pool maps to this memberId (e.g. the spawn
   * promise hasn't resolved yet — fall back to the legacy LIFO
   * remover in that case). */
  removeMemberById(memberId: string): AnimatedCharacter | null {
    for (const pool of [this.chefs, this.waiters, this.barmen]) {
      const idx = pool.findIndex((a) => a.memberId === memberId);
      if (idx >= 0) {
        const wasChef = pool === this.chefs;
        const removed = this.popPreferIdle(pool, idx);
        // Release any tickets the chef had pending in their
        // backlog so other chefs (or the orphan-fallback in the
        // idle handler) can pick them up.
        if (wasChef) this.releaseBacklogForChef(memberId);
        this.mirrorActorUnregister(memberId);
        return removed;
      }
    }
    return null;
  }

  /** Find the AnimatedCharacter wired to a specific HiredStaffMember.id
   * across both pools. Returns null if no actor maps to that id
   * (e.g. the spawn promise hasn't resolved yet). Used by Engine when
   * the player reassigns a member's home floor — the visual model
   * needs to be re-parented + Y-shifted to the new storey. */
  getCharacterByMemberId(id: string): AnimatedCharacter | null {
    for (const pool of [this.chefs, this.waiters, this.barmen]) {
      for (const a of pool) {
        if (a.memberId === id) return a.character;
      }
    }
    return null;
  }

  /** Update the cached home + target for the actor whose memberId
   * matches. Called right after Engine moves the model vertically so
   * the router stops trying to walk back to a now-stale Y. (X/Z stay
   * the same — only the world frame's parent changes.) */
  updateActorHomeFloor(memberId: string, fromFloor: number, toFloor: number, storeyHeight: number): void {
    void fromFloor; void storeyHeight;
    for (const pool of [this.chefs, this.waiters, this.barmen]) {
      for (const a of pool) {
        if (a.memberId !== memberId) continue;
        a.homeFloor = toFloor;
        // Drop any active assignment so the chef doesn't continue
        // cooking on / waiting on a station from the old floor that
        // is no longer reachable for them under the floor filter.
        if (a.ticketId !== null) {
          const t = this.tickets.find((tk) => tk.id === a.ticketId);
          if (t) {
            if (t.state === "cooking") t.state = "queued";
            else if (t.state === "delivering") t.state = "ready";
          }
          a.ticketId = null;
        }
        if (a.assignedStoveUid) {
          this.busyStoveUids.delete(a.assignedStoveUid);
          a.assignedStoveUid = null;
        }
        a.state = "idle";
        a.path = [];
        a.replanAccum = 0;
        a.target.copy(a.character.groundPos);
        // Floor reassignment teleports the body to the new storey via
        // the caller; sync currentFloor + targetFloor so the next path
        // anchors the actor's Y to the right slab from the get-go.
        a.currentFloor = toFloor;
        a.targetFloor = toFloor;
        // Phase 9.55 — PUSH the new home_floor to the server. The server
        // now dispatches staff strictly by assigned floor, so it must
        // learn the reassignment or it'd keep this member glued to the
        // old floor's work (or refuse them the new floor's). register_
        // staff_actor's re-register branch updates home_floor + resets
        // the row to idle on the new storey. Without this the whole
        // "player moves staff between floors" contract is broken.
        this.mirrorActorRegister(a);
      }
    }
  }

  /** Pull one actor out of the pool, running the full cleanup
   * pipeline (ticket rollback, stove release, wash-trip recovery,
   * take-order claim release) and returning their visible
   * character so Engine can detach the model.
   *
   * `targetIdx` lets a caller (removeMemberById) pin a specific
   * actor; without it the default policy is "prefer idle, else
   * pop the most-recently-hired". */
  private popPreferIdle(pool: StaffActor[], targetIdx: number | null = null): AnimatedCharacter | null {
    if (pool.length === 0) return null;
    let idx: number;
    if (targetIdx !== null) {
      if (targetIdx < 0 || targetIdx >= pool.length) return null;
      idx = targetIdx;
    } else {
      const idleIdx = pool.findIndex((a) => a.state === "idle");
      idx = idleIdx >= 0 ? idleIdx : pool.length - 1;
    }
    const removed = pool[idx];
    // If they were mid-task, mark the ticket back to its previous queue state
    // so another staffer can pick it up.
    if (removed.ticketId) {
      const t = this.tickets.find((tk) => tk.id === removed.ticketId);
      if (t) {
        if (t.state === "cooking") t.state = "queued";
        else if (t.state === "delivering") t.state = "ready";
      }
    }
    // Release any stove this chef had reserved so the next chef can
    // claim it. (Waiters won't have one set, the field is just unused.)
    if (removed.assignedStoveUid) {
      this.busyStoveUids.delete(removed.assignedStoveUid);
      removed.assignedStoveUid = null;
    }
    // Release any wash-trip claims — without this a fired waiter
    // permanently locks up the dirty plate AND the sink they were
    // heading for.
    //
    // If the waiter was already CARRYING the dish (phase === "wash"),
    // the mesh + dirtyTableMeshes entry are already gone but the
    // DishwareSystem still counts that piece as dirty. Without an
    // explicit washOne the dirty count stays stuck forever (no mesh
    // for any future wash trip to claim), and the inventory looks like
    // it's leaking pieces. Treat the carried dish as auto-washed:
    // the fired waiter dropped it in the sink on the way out.
    if (removed.washTrip) {
      this.dishwareLogger?.(`staff-removed mid-washTrip(phase=${removed.washTrip.phase}, kind=${removed.washTrip.kind}, extras=${removed.washTrip.extraDirtyIds.length})`);
      // H.95 — Per-piece total includes the batched extras. Each
      // gets the same treatment as the primary: auto-wash if
      // carried, release if still claimed-but-not-picked-up.
      const totalPieces = 1 + removed.washTrip.extraDirtyIds.length;
      if (removed.washTrip.phase === "wash") {
        for (let i = 0; i < totalPieces; i++) {
          this.washCallbacks?.washOne(removed.washTrip.kind);
        }
      } else {
        this.washCallbacks?.releaseDirtyPickup(removed.washTrip.dirtyId);
        for (const id of removed.washTrip.extraDirtyIds) {
          this.washCallbacks?.releaseDirtyPickup(id);
        }
      }
      this.busyWashUids.delete(removed.washTrip.stationUid);
      removed.washTrip = null;
    }
    // Release any take-order claim — the request goes back to the
    // queue so another waiter can pick it up. Without this, firing
    // the only waiter mid-walk-to-table leaves the request claimed
    // forever and no future waiter takes it.
    if (removed.takeOrderRequest) {
      const req = this.orderRequests.find((o) => o.guestId === removed.takeOrderRequest!.guestId);
      if (req) req.claimedBy = null;
      removed.takeOrderRequest = null;
    }
    pool.splice(idx, 1);
    return removed.character;
  }

  /** Personal-space snapshot so idle / walking staff get pushed apart like
   * guests do. Without this, idle waiters/chefs/barmen — which never re-walk
   * once parked on their shared rest spot — stack permanently into a visible
   * "blob" on the floor. WORKING staff come back pinned: they're anchored at a
   * station/seat for a task and must not be shoved off it. */
  snapshotMovable(): { character: AnimatedCharacter; pinned: boolean }[] {
    const out: { character: AnimatedCharacter; pinned: boolean }[] = [];
    for (const a of this.chefs) out.push({ character: a.character, pinned: a.state === "working" });
    for (const a of this.waiters) out.push({ character: a.character, pinned: a.state === "working" });
    for (const a of this.barmen) out.push({ character: a.character, pinned: a.state === "working" });
    return out;
  }

  getChefCount(): number { return this.chefs.length; }
  getWaiterCount(): number { return this.waiters.length; }
  getBarmanCount(): number { return this.barmen.length; }

  /** Look up the animated character that represents a specific
   * HiredStaffMember — Engine uses this to anchor floating-text
   * confirmations over the right actor when training completes. */
  findCharacterByMemberId(memberId: string): AnimatedCharacter | null {
    for (const c of this.chefs) if (c.memberId === memberId) return c.character;
    for (const w of this.waiters) if (w.memberId === memberId) return w.character;
    for (const b of this.barmen) if (b.memberId === memberId) return b.character;
    return null;
  }

  /** True if at least one chef is currently in their "working" (cooking)
   * state. Used to drive the visible stove flame. */
  isAnyChefCooking(): boolean {
    return this.chefs.some((c) => c.state === "working");
  }

  /** Uids of every stove that has a chef ACTIVELY cooking on it right
   * now (state="working", not just walking there). WorldScene drives
   * per-stove flame visibility from this set, so each stove only lights
   * up while its own chef is at the burner. Chefs cooking on the legacy
   * fallback shared stovePos (no assignedStoveUid) contribute nothing
   * here — that path is degenerate anyway. */
  getCookingStoveUids(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const c of this.chefs) {
      if (c.state === "working" && c.assignedStoveUid) out.add(c.assignedStoveUid);
    }
    return out;
  }

  /** Snapshot used by the UI status-bubble layer. Returns one entry per
   * staff member with their current activity label. Empty label = no bubble. */
  snapshotStatus(): { character: AnimatedCharacter; role: "chef" | "waiter" | "barman"; label: string }[] {
    const out: { character: AnimatedCharacter; role: "chef" | "waiter" | "barman"; label: string }[] = [];
    for (const c of this.chefs) out.push({ character: c.character, role: "chef", label: chefLabel(c.state) });
    for (const w of this.waiters) {
      // A food ticket flips to "delivering" the instant the plate is picked
      // up at the pass, so it tells the fetch leg from the carry leg.
      const carrying = w.ticketId != null
        && this.tickets.some((t) => t.id === w.ticketId && t.state === "delivering");
      out.push({ character: w.character, role: "waiter", label: waiterLabel(w, carrying) });
    }
    for (const b of this.barmen) out.push({ character: b.character, role: "barman", label: barmanLabel(b) });
    return out;
  }

  /** Called by GuestSpawner when a guest reaches the seated state and
   * is ready to order. The router routes a waiter to the seat; on
   * arrival + brief dwell the takeOrderCallback fires and the spawner
   * builds the recipe list + calls enqueueOrder. Pre-existing request
   * for the same guest is replaced (defensive — shouldn't happen
   * given the spawner's orderRequested latch). */
  enqueueOrderRequest(guestId: string, seatPos: THREE.Vector2, seatFloor: number = 0, atBar: boolean = false): void {
    // Drop any prior request for this guest first so a re-seat between
    // toilet trips doesn't strand a stale claim.
    this.cancelOrderRequest(guestId);
    this.orderRequests.push({
      guestId,
      seatPos: seatPos.clone(),
      seatFloor,
      claimedBy: null,
      atBar,
    });
    console.log(`[Router] order request enqueued for ${guestId} (floor ${seatFloor}, atBar=${atBar}) — ${this.orderRequests.length} pending`);
  }

  /** Drop a pending or in-flight order request for `guestId`. If a
   * waiter is currently walking toward / dwelling at the seat, they
   * get pulled off and sent home. Called from cancelTicket (guest
   * left mid-meal) and directly when a guest's seated trip aborts
   * before any cooking ticket exists. */
  cancelOrderRequest(guestId: string): boolean {
    const idx = this.orderRequests.findIndex((o) => o.guestId === guestId);
    if (idx < 0) return false;
    const req = this.orderRequests[idx];
    if (req.claimedBy) {
      const waiter = this.waiters.find((w) => w.memberId === req.claimedBy);
      if (waiter && waiter.takeOrderRequest?.guestId === guestId) {
        waiter.takeOrderRequest = null;
        const rest = this.pickWaiterIdleSpot(waiter);
        waiter.target = rest.pos;
        waiter.targetFloor = rest.floor;
        this.planPath(waiter);
        waiter.state = "returningHome";
        waiter.character.action = "walk";
        waiter.clock = 0;
      }
    }
    this.orderRequests.splice(idx, 1);
    return true;
  }

  /** Called by GuestSpawner when a guest places an order. */
  enqueueOrder(
    guestId: string, recipeId: string, seatPos: THREE.Vector2, cookSeconds: number,
    appliance: string = "stove",
    seatFloor: number = 0,
    seatAtBar: boolean = false,
  ): string {
    const id = `t-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    // Pre-assign a chef so this ticket lands in someone's specific
    // backlog. Bar tickets go to the barman pool by appliance filter,
    // so we leave assignedChefId null for those. Non-bar tickets get
    // routed to the chef with the shortest backlog on the seat's
    // floor (strong preference), spilling to other floors only when
    // every same-floor chef is loaded past HIGH_DEMAND_BACKLOG.
    const assignedChefId = (appliance === "bar")
      ? null
      : this.pickChefForTicket(seatFloor, appliance);
    const ticket: Ticket = {
      id, guestId, recipeId, state: "queued",
      seatPos: seatPos.clone(), clock: 0,
      baseCookSeconds: cookSeconds,
      cookSeconds, appliance, seatFloor,
      seatAtBar,
      assignedChefId,
    };
    this.tickets.push(ticket);
    console.log(`[Router] enqueued ${id} for ${guestId} (${recipeId}@${appliance}, ${cookSeconds}s cook, chef=${assignedChefId ?? "any"}) — ${this.tickets.length} ticket(s), ${this.chefs.filter((c) => c.state === "idle").length} idle chef(s)`);
    this.mirrorTicketPlace(ticket);
    return id;
  }

  // ======================================================================
  //                Phase C.3b — server-mirror helpers
  // ======================================================================
  // Six helpers, one per lifecycle transition the local Ticket goes
  // through. All bail silently when isServerSim("tickets") is off OR
  // when the cloud client isn't wired. mirrorTicketPlace also schedules
  // a setTimeout poll to resolve the server-side auto-inc id back to
  // ticket.serverMirrorId so subsequent transitions can address it.

  private mirrorTicketPlace(ticket: Ticket): void {
    if (!isServerSim("tickets") || !this.cloud) return;
    const guestServerId = this.lookupGuestServerId?.(ticket.guestId);
    if (guestServerId == null) {
      // The guest hasn't been mirrored yet (flag off, or pre-resolve
      // window). Skip — we'd otherwise create a ticket with no parent.
      return;
    }
    this.cloud.placeOrder({
      guestId: guestServerId,
      clientTempId: ticket.id,
      recipeId: ticket.recipeId,
      baseCookSecondsMs: BigInt(Math.round(ticket.baseCookSeconds * 1000)),
      appliance: ticket.appliance,
      seatX: ticket.seatPos.x,
      seatZ: ticket.seatPos.y,
      seatFloor: ticket.seatFloor,
      seatAtBar: !!ticket.seatAtBar,
    });
    // Resolve the auto-inc id once the row lands. Same 250 ms wait
    // we use for guest mirroring.
    window.setTimeout(() => {
      if (!this.cloud) return;
      const id = this.cloud.findActiveTicketIdByClientTempId(ticket.id);
      if (id != null) ticket.serverMirrorId = id;
    }, 250);
  }

  private mirrorTicketClaim(ticket: Ticket, chefMemberId: string): void {
    if (!isServerSim("tickets") || !this.cloud) return;
    if (ticket.serverMirrorId == null) {
      ticket.serverMirrorId = this.cloud
        .findActiveTicketIdByClientTempId(ticket.id) ?? undefined;
    }
    if (ticket.serverMirrorId == null) return;
    this.cloud.claimTicket(
      ticket.serverMirrorId,
      chefMemberId,
      BigInt(Math.round(ticket.cookSeconds * 1000)),
    );
  }

  private mirrorTicketFinish(ticket: Ticket, pickup: THREE.Vector2 | undefined, pickupFloor: number): void {
    if (!isServerSim("tickets") || !this.cloud) return;
    if (ticket.serverMirrorId == null) {
      ticket.serverMirrorId = this.cloud
        .findActiveTicketIdByClientTempId(ticket.id) ?? undefined;
    }
    if (ticket.serverMirrorId == null) return;
    const px = pickup?.x ?? ticket.seatPos.x;
    const pz = pickup?.y ?? ticket.seatPos.y;
    this.cloud.finishCooking(ticket.serverMirrorId, px, pz, pickupFloor);
  }

  private mirrorTicketPickup(ticket: Ticket): void {
    if (!isServerSim("tickets") || !this.cloud) return;
    if (ticket.serverMirrorId == null) return;
    this.cloud.pickupTicket(ticket.serverMirrorId);
  }

  private mirrorTicketDeliver(ticket: Ticket): void {
    if (!isServerSim("tickets") || !this.cloud) return;
    if (ticket.serverMirrorId == null) return;
    this.cloud.deliverTicket(ticket.serverMirrorId);
  }

  private mirrorTicketCancel(ticket: Ticket): void {
    if (!isServerSim("tickets") || !this.cloud) return;
    if (ticket.serverMirrorId == null) return;
    this.cloud.cancelTicket(ticket.serverMirrorId);
  }

  // ======================================================================
  //          Phase H Phase 1 — server-authoritative bridge
  // ======================================================================
  // Reconciles local Ticket + StaffActor state to the server's
  // authoritative decisions (auto_claim_queued_tickets,
  // auto_assign_ready_tickets, tick_ticket_state). The bridge is the
  // ONLY path that transitions a chef from idle → cooking, a waiter
  // from idle → delivering, and a chef from cooking → returningHome.
  // Local idle handlers used to make those decisions too; they're now
  // gated off via serverOwnsTicketDispatch().
  //
  // The local sim STILL drives:
  //   - Take-order trips (waiter walks to a seated guest)
  //   - Wash trips (waiter walks to dirty plate → station)
  //   - Movement smoothing (lerp toward target every frame)
  //   - Bar-seated tickets in their entirety (barman cook + serve dwell)
  //     — server-side bar handling is a later-phase gap.
  //
  // Rollback path: ?serverSim=off disables the feature flag, which
  // both stops cloud mirror calls AND re-enables local deciders below.

  /** True when the server is the sole decider of ticket dispatch (chef-
   * claim, waiter-pickup) for THIS restaurant. Local handlers consult
   * this and skip their decision branches when on. Requires both the
   * "tickets" feature flag (?serverSim=tickets,...) AND a live cloud
   * connection — disconnected mode falls back to local sim so the
   * kitchen still works offline. */
  private serverOwnsTicketDispatch(): boolean {
    return isServerSim("tickets") && this.cloud?.isConnectionLive() === true;
  }

  /** Find a local ticket by its server-side auto-inc id. Returns
   * undefined if no local ticket has been stamped with that
   * serverMirrorId yet (race during the ~250 ms post-place_order
   * resolve window). */
  private findLocalTicketByServerId(id: bigint): Ticket | undefined {
    for (const t of this.tickets) {
      if (t.serverMirrorId === id) return t;
    }
    return undefined;
  }

  /** Find any local actor (chef / waiter / barman) by their hired
   * member id. Returns undefined if the actor isn't registered locally
   * (e.g. a coworker's chef in a co-op restaurant). */
  private findLocalActor(memberId: string): StaffActor | undefined {
    for (const c of this.chefs) if (c.memberId === memberId) return c;
    for (const w of this.waiters) if (w.memberId === memberId) return w;
    for (const b of this.barmen) if (b.memberId === memberId) return b;
    return undefined;
  }

  /** Attach the cloud subscription bridge. Called once after the
   * router's cloud handle is wired. No-op if already attached or no
   * cloud handle present. */
  attachServerBridge(): void {
    if (!this.cloud || this.serverBridgeAttached) return;
    // Phase 9.2 — Boot-race guard. The subscribe calls below silently
    // register nothing when the websocket or restaurantId isn't
    // resolved yet; latching serverBridgeAttached on that no-op left
    // the bridge permanently dead whenever the staffReady GLB chain
    // beat the auth flow. Engine retries at 1 Hz until ready.
    if (!this.cloud.hasRestaurantContext()) return;
    this.serverBridgeAttached = true;
    this.cloud.subscribeActiveTicketChanges({
      onInsert: (row) => this.reconcileCloudTicket(row),
      onUpdate: (row) => this.reconcileCloudTicket(row),
      onDelete: (id) => this.reconcileCloudTicketDelete(id),
    });
    this.cloud.subscribeStaffActorChanges({
      // Phase M.16 — reconcile on INSERT too, not just UPDATE. The initial
      // subscription delivers existing rows as INSERTS, and idle staff rows
      // rarely change afterwards, so an onUpdate-only bridge left their
      // cloudX/cloudZ/cloudFloor unstashed after a reload. renderActorFromServer
      // then early-returned on the missing pose, `_baseY` stayed unset, and the
      // animator's floor gate dumped an idle upper-floor chef/waiter/barman
      // onto the ground floor ("staff standing on the wrong floor"). Same fix
      // shape as seeding the guest cloud pose at import; reconcile is idempotent
      // so the extra call is harmless. (The ticket bridge above already does this.)
      onInsert: (row) => this.reconcileCloudStaffActor(row),
      onUpdate: (row) => this.reconcileCloudStaffActor(row),
    });
    console.log("[Router/Bridge] server-authoritative bridge attached");
  }

  private serverBridgeAttached = false;
  /** Phase 9.2 — one-shot guard for the empty-ticket-hydrate log so
   * the 5 Hz retry loop doesn't spam the console. */
  private loggedEmptyTicketHydrate = false;

  /** Apply a cloud active_ticket row's state to our local Ticket. */
  private reconcileCloudTicket(row: import("../cloud/SpacetimeClient").ActiveTicketRow): void {
    // Resolve local. On insert (echo of our place_order) the local
    // ticket exists with id == clientTempId; subsequent updates address
    // by serverMirrorId once it's stamped.
    let local = this.findLocalTicketByServerId(row.id);
    if (!local) {
      // Try by clientTempId — this is the typical insert path before
      // mirrorTicketPlace's setTimeout finishes the auto-inc resolve.
      for (const t of this.tickets) {
        if (t.id === row.clientTempId) { local = t; break; }
      }
    }
    if (!local) {
      // Phase H Phase 3c — server-spawned tickets (auto_place_next_course
      // creates them with a "srv-{guest_id}-{idx}" clientTempId) have
      // no local origin. Materialize one so popDeliveredFor + waiter
      // pickup work normally. Tickets we DIDN'T create locally only get
      // imported when:
      //   - the clientTempId looks server-generated (excludes echoes of
      //     local place_order races on un-resolved serverMirrorId), AND
      //   - we can map row.guestId back to a local Guest (the cloud row
      //     belongs to a guest we know about — H.47 hydrate may not have
      //     finished, or the row is for a different player's restaurant
      //     entirely if subscription leaked).
      if (!row.clientTempId.startsWith("srv-")) return;
      const localGuestId = this.lookupLocalGuestId?.(row.guestId);
      if (!localGuestId) return;
      const cookSec = Number(row.cookSeconds) / 1000;
      const newTicket: Ticket = {
        id: row.clientTempId,
        guestId: localGuestId,
        recipeId: row.recipeId,
        state: row.state as TicketState,
        seatPos: new THREE.Vector2(row.seatX, row.seatZ),
        seatFloor: row.seatFloor,
        seatAtBar: row.seatAtBar,
        clock: Number(row.stateClockMs) / 1000,
        baseCookSeconds: cookSec > 0 ? cookSec : 5,
        cookSeconds: cookSec > 0 ? cookSec : 5,
        appliance: row.appliance,
        assignedChefId: row.assignedChefId || null,
        serverMirrorId: row.id,
      };
      if ((row.state === "ready" || row.state === "delivering")
          && (row.pickupX !== 0 || row.pickupZ !== 0)) {
        newTicket.pickupPos = new THREE.Vector2(row.pickupX, row.pickupZ);
        newTicket.pickupFloor = row.pickupFloor;
      }
      this.tickets.push(newTicket);
      console.log(`[Router/Bridge] materialized server-only ticket ${row.clientTempId} (guest ${localGuestId}, ${row.recipeId})`);
      return;
    }
    if (local.serverMirrorId !== row.id) local.serverMirrorId = row.id;

    // State reconciliation — cloud is authority. Reset clock on
    // transition; lerp it on no-transition only if it drifted hard.
    if (local.state !== row.state) {
      console.log(`[Router/Bridge] ticket ${local.id} state ${local.state} → ${row.state}`);
      local.state = row.state as TicketState;
      local.clock = Number(row.stateClockMs) / 1000;
    }

    // Cook time may differ (chef multiplier applied server-side).
    if (row.cookSeconds > 0n) {
      const seconds = Number(row.cookSeconds) / 1000;
      if (Math.abs(local.cookSeconds - seconds) > 0.05) {
        local.cookSeconds = seconds;
      }
    }

    // Chef assignment — server decides on claim.
    if (row.assignedChefId && row.assignedChefId !== (local.assignedChefId ?? "")) {
      local.assignedChefId = row.assignedChefId;
    }

    // Pickup position — server stamps when cooking finishes (Phase 1
    // server fix sets these from chef.x/z/floor). Sync to local so the
    // waiter walks to the right spot.
    if ((row.state === "ready" || row.state === "delivering")
        && (row.pickupX !== 0 || row.pickupZ !== 0)) {
      const px = row.pickupX;
      const pz = row.pickupZ;
      const drift = !local.pickupPos
        || Math.abs(local.pickupPos.x - px) > 0.1
        || Math.abs(local.pickupPos.y - pz) > 0.1;
      if (drift) {
        local.pickupPos = new THREE.Vector2(px, pz);
        local.pickupFloor = row.pickupFloor;
      }
    }
  }

  /** Remove the local ticket whose serverMirrorId matches the deleted
   * cloud row. */
  private reconcileCloudTicketDelete(id: bigint): void {
    const idx = this.tickets.findIndex((t) => t.serverMirrorId === id);
    if (idx < 0) return;
    const ticket = this.tickets[idx];
    console.log(`[Router/Bridge] ticket ${ticket.id} removed (cloud delete)`);
    // Free any actor still pinned to this ticket so they go home.
    for (const a of [...this.chefs, ...this.waiters, ...this.barmen]) {
      if (a.ticketId === ticket.id) a.ticketId = null;
    }
    this.tickets.splice(idx, 1);
  }

  /** Apply a cloud staff_actor row to the local actor. The big case is
   * "server just claimed a ticket for this actor while local sim was
   * still in idle" — we transition the local actor to movingToWork
   * with the target the server picked. Other cases (position lerp,
   * floor change) we leave to the local sim because they'd fight
   * smooth interpolation. */
  private reconcileCloudStaffActor(row: import("../cloud/SpacetimeClient").StaffActorRow): void {
    const actor = this.findLocalActor(row.memberId);
    if (!actor) return;

    // Phase 9.65 (staff migration Pass 6) — stash the authoritative server
    // pose so update()'s staffMove render loop can lerp the body toward it
    // and animate from the server state. Cheap; unused while staffMove off.
    // Snapshot-interp (Phase 9.70): when the pose actually moves, shift the
    // previous-pose anchor + reset the 0→1 interp clock so update() glides
    // from the old pose to this one over the ~500 ms tick instead of snapping
    // then stalling. First update (no prior pose) starts settled (interp 1).
    if (actor.cloudX === undefined
        || Math.hypot(row.x - actor.cloudX, row.z - (actor.cloudZ ?? row.z)) > 1e-4) {
      actor.cloudPrevX = actor.cloudX ?? row.x;
      actor.cloudPrevZ = actor.cloudZ ?? row.z;
      actor.cloudInterp = actor.cloudX === undefined ? 1 : 0;
    }
    actor.cloudX = row.x;
    actor.cloudZ = row.z;
    actor.cloudFloor = row.floor;
    actor.cloudState = row.state;
    // Phase M.13 — mirror the server task fields so the bubble label reads
    // the REAL job (take order / fetch / serve / wash / clear), not a guess.
    actor.cloudDeliveryPhase = row.deliveryPhase;
    actor.cloudTakeOrderActive = row.takeOrderGuestId != null;
    actor.cloudWashPhase = row.washPhase;
    actor.cloudCleanActive = row.cleanSeatUid != null;

    // Case: server made a chef-claim / waiter-pickup decision for an
    // actor that is locally idle. With Phase 1's gating, the local idle
    // handler no longer makes this decision itself — the bridge is the
    // ONLY way an actor transitions out of idle for ticket work.
    if (row.ticketId != null && actor.ticketId == null && actor.state === "idle") {
      const ticket = this.findLocalTicketByServerId(row.ticketId);
      if (ticket) {
        actor.ticketId = ticket.id;
        actor.target = new THREE.Vector2(row.targetX, row.targetZ);
        actor.targetFloor = row.targetFloor;
        if (row.assignedStoveUid) actor.assignedStoveUid = row.assignedStoveUid;
        actor.state = "movingToWork";
        actor.clock = 0;
        actor.character.action = "walk";
        actor.homeWorkWaitClock = 0;
        this.planPath(actor);
        console.log(`[Router/Bridge] cloud-claim: ${actor.role} ${actor.memberId} → ticket ${ticket.id} (target ${row.targetX.toFixed(1)},${row.targetZ.toFixed(1)} F${row.targetFloor})`);
      }
    }

    // Case: server released the actor from their ticket. Happens when
    // tick_ticket_state flips cooking→ready (release_chef_from_ticket),
    // or when a guest leaves mid-delivery (release_waiter_from_ticket).
    // Local actor is still in working / movingToWork; bridge transitions
    // to returningHome with the home target the server picked. Without
    // this branch the local chef would stay at the station forever after
    // server-side cook completion.
    if (row.ticketId == null && actor.ticketId != null
        && (actor.state === "working" || actor.state === "movingToWork")) {
      if (actor.role === "chef" || actor.role === "barman") {
        this.releaseStove(actor);
      }
      actor.ticketId = null;
      actor.target = new THREE.Vector2(row.targetX, row.targetZ);
      actor.targetFloor = row.targetFloor;
      actor.state = "returningHome";
      actor.clock = 0;
      actor.character.action = "walk";
      this.planPath(actor);
      console.log(`[Router/Bridge] cloud-release: ${actor.role} ${actor.memberId} → home (${row.targetX.toFixed(1)},${row.targetZ.toFixed(1)} F${row.targetFloor})`);
    }

    // Phase H Phase 4 — server-driven take-order dispatch. Same shape
    // as the chef-claim case but keyed off take_order_guest_id instead
    // of ticket_id. Server's try_dispatch_take_order picks a waiter,
    // sets staff_actor.take_order_guest_id + target=seat. Bridge sees
    // it here, attaches a local OrderRequest, transitions waiter to
    // movingToWork. On dwell completion server clears the field +
    // flips guest state to waitingForFood; that's the "release" case
    // below.
    if (actor.role === "waiter") {
      if (row.takeOrderGuestId != null && actor.takeOrderRequest == null
          && actor.state === "idle") {
        const localGuestId = this.lookupLocalGuestId?.(row.takeOrderGuestId);
        if (localGuestId) {
          // The OrderRequest may already exist locally (the seated
          // guest enqueued one), or we may need to fabricate one if
          // the server raced our enqueueOrderRequest call. Either way
          // attach actor.takeOrderRequest so the working-state dwell
          // visual fires correctly.
          let req = this.orderRequests.find((o) => o.guestId === localGuestId);
          if (!req) {
            req = {
              guestId: localGuestId,
              seatPos: new THREE.Vector2(row.targetX, row.targetZ),
              seatFloor: row.targetFloor,
              claimedBy: actor.memberId,
              atBar: false,
            };
            this.orderRequests.push(req);
          } else {
            req.claimedBy = actor.memberId;
          }
          actor.takeOrderRequest = req;
          actor.target = new THREE.Vector2(row.targetX, row.targetZ);
          actor.targetFloor = row.targetFloor;
          actor.state = "movingToWork";
          actor.clock = 0;
          actor.character.action = "walk";
          actor.homeWorkWaitClock = 0;
          this.planPath(actor);
          console.log(`[Router/Bridge] cloud-takeorder: waiter ${actor.memberId} → guest ${localGuestId} (target ${row.targetX.toFixed(1)},${row.targetZ.toFixed(1)} F${row.targetFloor})`);
        }
      } else if (row.takeOrderGuestId == null && actor.takeOrderRequest != null
                 && (actor.state === "working" || actor.state === "movingToWork")) {
        // Server completed the take-order dwell + cleared the field.
        // Local waiter winds down; the corresponding guest's state
        // has been (or will be) flipped to waitingForFood server-side,
        // and auto_place_next_course enqueues the ticket. Drop the
        // local OrderRequest entry so a second waiter doesn't pick it.
        const guestId = actor.takeOrderRequest.guestId;
        const reqIdx = this.orderRequests.findIndex((o) => o.guestId === guestId);
        if (reqIdx >= 0) this.orderRequests.splice(reqIdx, 1);
        actor.takeOrderRequest = null;
        actor.target = new THREE.Vector2(row.targetX, row.targetZ);
        actor.targetFloor = row.targetFloor;
        actor.state = "returningHome";
        actor.clock = 0;
        actor.character.action = "walk";
        this.planPath(actor);
        console.log(`[Router/Bridge] cloud-takeorder done: waiter ${actor.memberId} (guest ${guestId})`);
      }

      // Phase H Phase 4w — server-driven wash trip dispatch. Server
      // picks waiter + station; bridge picks the closest unclaimed
      // local dirty piece compatible with that station, synthesizes
      // a WashTrip object, transitions waiter to movingToWork toward
      // the dirty piece. Local working-state completion fires
      // washOne / loadDishwasher (inventory motion stays local —
      // server's tick_wash_trip is cosmetic). If server clears
      // wash_target_uid before local trip completes (rare; would
      // require a pathfind hang), bridge fires the inventory motion
      // itself to keep dish counts balanced.
      if (row.washTargetUid.length > 0 && actor.washTrip == null
          && actor.state === "idle" && this.washCallbacks) {
        const stationUid = row.washTargetUid;
        const station = this.washCallbacks.getWashStations().find((s) => s.uid === stationUid);
        if (station) {
          const isDishwasher = station.defId.startsWith("dishwasher");
          // Find the closest unclaimed dirty piece that this station
          // can accept. For dishwashers, kind-specific capacity. For
          // sinks, any unclaimed piece works.
          const dirties = this.washCallbacks.getDirtyPickups();
          const here = actor.character.groundPos;
          let bestDirty: import("./StaffRouter").DirtyPickupInfo | undefined;
          let bestDist = Infinity;
          for (const d of dirties) {
            if (isDishwasher && !this.washCallbacks.canDishwasherLoad(station.uid, d.kind)) continue;
            const dist = Math.hypot(d.pos.x - here.x, d.pos.y - here.y)
              + (d.floor !== station.floor ? 15 : 0); // stair penalty
            if (dist < bestDist) { bestDist = dist; bestDirty = d; }
          }
          if (bestDirty && this.washCallbacks.claimDirtyPickup(bestDirty.id, actor.memberId)) {
            if (!isDishwasher) this.busyWashUids.add(station.uid);
            const trip: WashTrip = {
              dirtyId: bestDirty.id,
              dirtyPos: bestDirty.pos.clone(),
              dirtyFloor: bestDirty.floor,
              kind: bestDirty.kind,
              extraDirtyIds: [],
              stationUid: station.uid,
              stationDefId: station.defId,
              stationPos: station.standPos.clone(),
              stationFloor: station.floor,
              dwell: station.dwell,
              phase: "pickup",
            };
            actor.washTrip = trip;
            actor.target = bestDirty.pos.clone();
            actor.targetFloor = bestDirty.floor;
            actor.state = "movingToWork";
            actor.clock = 0;
            actor.character.action = "walk";
            actor.homeWorkWaitClock = 0;
            this.planPath(actor);
            console.log(`[Router/Bridge] cloud-wash: waiter ${actor.memberId} → dirty ${bestDirty.id} (${bestDirty.kind}) → station ${station.uid} (${station.defId})`);
          }
        }
      } else if (row.washTargetUid.length === 0 && actor.washTrip != null
                 && (actor.state === "movingToWork" || actor.state === "working")) {
        // Server completed the trip before local did (rare). Fire
        // the inventory motion that the local working-state branch
        // would have done, then release the trip + return home.
        const trip = actor.washTrip;
        // If we're still in the "pickup" phase (mid-walk to dirty)
        // the dirty mesh is still in the world — remove it now so
        // the inventory matches what the player sees. Without this
        // pickupDirty call the dirty plate would persist visually
        // after the count moved (1 plate on table but pool says
        // washed = 0 dirty).
        if (trip.phase === "pickup") {
          this.washCallbacks?.pickupDirty(trip.dirtyId);
          for (const id of trip.extraDirtyIds) {
            this.washCallbacks?.pickupDirty(id);
          }
        }
        const isDishwasher = trip.stationDefId.startsWith("dishwasher");
        const totalPieces = 1 + trip.extraDirtyIds.length;
        // Phase 9.6 — server's tick_wash_trip moves the inventory at
        // drop completion now; running washOne/loadDishwasher here
        // too would double-clean. The pool subscription delivers the
        // server's counts; this branch keeps only the local visuals.
        if (!isServerSim("dishware")) {
          for (let i = 0; i < totalPieces; i++) {
            if (isDishwasher) {
              const ok = this.washCallbacks?.loadDishwasher(trip.stationUid, trip.stationDefId, trip.kind) ?? false;
              if (!ok) this.washCallbacks?.washOne(trip.kind);
            } else {
              this.washCallbacks?.washOne(trip.kind);
            }
          }
        }
        this.busyWashUids.delete(trip.stationUid);
        if (actor.heldPlate) actor.heldPlate.visible = false;
        actor.washTrip = null;
        actor.target = new THREE.Vector2(row.targetX, row.targetZ);
        actor.targetFloor = row.targetFloor;
        actor.state = "returningHome";
        actor.clock = 0;
        actor.character.action = "walk";
        this.planPath(actor);
        console.log(`[Router/Bridge] cloud-wash early-complete: waiter ${actor.memberId} (${trip.kind}, ${totalPieces} pieces)`);
      }

      // Phase 9.45 — server-driven STRICT clean trip. Same shape as the
      // wash/take-order bridge cases. Server's try_dispatch_seat_clean
      // picks an idle waiter + a dirty seat and sets staff_actor.clean_
      // seat_uid + target=seat. Bridge adopts it: local waiter walks to
      // the seat (movingToWork) and holds the bussing pose (working).
      // The walk MUST be locally driven so the mirrored body position
      // converges with the server's arrival check — otherwise the server
      // would step the body while the local sim kept it idle at home and
      // mirrored that back, freezing the trip.
      if (row.cleanSeatUid != null && actor.cleanSeatUid == null
          && actor.ticketId == null && actor.washTrip == null
          && actor.takeOrderRequest == null && actor.state === "idle") {
        actor.cleanSeatUid = row.cleanSeatUid;
        actor.target = new THREE.Vector2(row.targetX, row.targetZ);
        actor.targetFloor = row.targetFloor;
        actor.state = "movingToWork";
        actor.clock = 0;
        actor.character.action = "walk";
        actor.homeWorkWaitClock = 0;
        this.planPath(actor);
        console.log(`[Router/Bridge] cloud-clean: waiter ${actor.memberId} → bus seat ${row.cleanSeatUid} (target ${row.targetX.toFixed(1)},${row.targetZ.toFixed(1)} F${row.targetFloor})`);
      } else if (row.cleanSeatUid == null && actor.cleanSeatUid != null
                 && (actor.state === "movingToWork" || actor.state === "working")) {
        // Server finished bussing (deleted the pile rows + cleared the
        // field). Release the local waiter to the home target the
        // server picked.
        actor.cleanSeatUid = null;
        actor.target = new THREE.Vector2(row.targetX, row.targetZ);
        actor.targetFloor = row.targetFloor;
        actor.state = "returningHome";
        actor.clock = 0;
        actor.character.action = "walk";
        this.planPath(actor);
        console.log(`[Router/Bridge] cloud-clean done: waiter ${actor.memberId}`);
      }
    }
  }

  /** Number of queued+cooking tickets currently in a chef's backlog.
   * Engine + StaffPanel read this for the per-row indicator that
   * lets the player see who's drowning. O(N) over the ticket list,
   * which is fine — the list is short (≤ N seats). */
  getChefBacklog(chefMemberId: string): number {
    let count = 0;
    for (const t of this.tickets) {
      if (t.assignedChefId !== chefMemberId) continue;
      if (t.appliance === "bar") continue; // those count under barman
      if (t.state === "queued" || t.state === "cooking") count += 1;
    }
    return count;
  }

  /** Phase I (H.72) — barman version of getChefBacklog.  Counts
   * queued+cooking bar-appliance tickets assigned to this barman.
   * The Router's ticket dispatcher writes `assignedChefId` for
   * barmen too (the field is just "this is whose station it
   * is"); filtering by appliance==="bar" tells barman queue from
   * chef queue.  Same O(N) over a short ticket list. */
  getBarmanBacklog(barmanMemberId: string): number {
    let count = 0;
    for (const t of this.tickets) {
      if (t.assignedChefId !== barmanMemberId) continue;
      if (t.appliance !== "bar") continue;
      if (t.state === "queued" || t.state === "cooking") count += 1;
    }
    // Path B fallback — under serverOwnsTicketDispatch the local barman
    // never runs tryClaimDrinkForBarman (which is what stamps
    // ticket.assignedChefId = barman). Instead the staff_actor bridge
    // (reconcileCloudStaffActor) drives the barman: it sets actor.ticketId
    // + actor.state on a cloud-claim, and the local state machine carries
    // them movingToWork → working → returningHome. If the ticket-scan
    // above found nothing (assignedChefId came back as the SERVER's id,
    // not the local barman id), treat a busy actor as ≥1 so the badge
    // tracks reality the same way chefs do.
    if (count === 0) {
      const b = this.barmen.find((x) => x.memberId === barmanMemberId);
      if (b && (b.ticketId != null || b.state === "movingToWork" || b.state === "working")) {
        count = 1;
      }
    }
    return count;
  }

  /** Phase I (H.72) — waiter workload indicator.  Counts the
   * concurrent tasks this waiter owns: a meal being delivered, an
   * active wash trip, or a take-order trip in flight.  Each is
   * O(1) lookup against their StaffActor row; no list scan needed.
   * Returns 0 when fully idle. */
  getWaiterBacklog(waiterMemberId: string): number {
    const w = this.waiters.find((x) => x.memberId === waiterMemberId);
    if (!w) return 0;
    let count = 0;
    if (w.ticketId) count += 1;
    if (w.washTrip) count += 1;
    if (w.takeOrderRequest) count += 1;
    // Path B fallback — under serverOwnsTicketDispatch the local waiter's
    // delivery / take-order / wash trips are all started by the
    // staff_actor bridge (reconcileCloudStaffActor) rather than the local
    // idle picker. The bridge always drives actor.state to movingToWork
    // and the local state machine advances it through working, but the
    // specific trip FIELD it sets depends on what local context exists
    // (e.g. the cloud-wash branch needs a LOCAL dirty mesh, which Path B
    // no longer spawns on the host — so washTrip can be null while the
    // waiter is genuinely off doing server-side wash work). Count any
    // non-idle, non-returning-home actor as ≥1 so a busy waiter shows a
    // badge even when none of the three trip fields happen to be set.
    if (count === 0 && (w.state === "movingToWork" || w.state === "working")) {
      count = 1;
    }
    return count;
  }

  /** Pick which chef gets a freshly-enqueued ticket. Policy:
   *   1. Filter to chefs whose homeFloor matches the seat's floor.
   *   2. Sort by their current backlog (queued+cooking assigned to
   *      them), ascending. Tiebreak: insertion order (stable sort).
   *   3. Return the same-floor chef with the shortest backlog —
   *      UNLESS every same-floor chef is at or above
   *      HIGH_DEMAND_BACKLOG, in which case look at all chefs and
   *      pick the shortest overall.
   *   4. If no chef is on the seat's floor at all, fall back to the
   *      globally shortest backlog.
   *   5. Returns null when there are zero chefs hired (ticket
   *      remains unassigned; chef idle handler accepts null-
   *      assigned tickets as a legacy fallback). */
  private pickChefForTicket(seatFloor: number, appliance: string = "stove"): string | null {
    if (this.chefs.length === 0) return null;
    const HIGH_DEMAND_BACKLOG = 4;
    // Filter chefs to those who can ACTUALLY claim a station for this
    // recipe — i.e. a station of `appliance` exists on their home
    // floor. claimFreeStation enforces `s.floor === homeFloor`, so a
    // chef on floor 0 assigned to a recipe whose only matching station
    // is on floor 1 would sit forever waiting to claim. Pre-flight
    // that filter here so the assignment can't deadlock.
    //
    // No getCookStations callback (legacy boot path) → fall back to
    // the original "any chef" behaviour. Same for appliance values
    // we can't resolve.
    const cookableChefIds = this.cookableChefIdsFor(appliance);
    const eligible = cookableChefIds === null
      ? this.chefs
      : this.chefs.filter((c) => cookableChefIds.has(c.memberId));
    if (eligible.length === 0) {
      // No chef can reach this appliance — leave the ticket unassigned
      // so the orphan-pickup fallback (chef idle handler) considers
      // it. Better than locking the ticket to a chef who can't cook
      // it.
      return null;
    }
    const sameFloor = eligible.filter((c) => c.homeFloor === seatFloor);
    if (sameFloor.length > 0) {
      // Same-floor chefs sorted by current backlog, shortest first.
      const sorted = sameFloor
        .map((c) => ({ id: c.memberId, n: this.getChefBacklog(c.memberId) }))
        .sort((a, b) => a.n - b.n);
      const shortestOnFloor = sorted[0];
      if (shortestOnFloor.n < HIGH_DEMAND_BACKLOG) {
        return shortestOnFloor.id;
      }
      // High demand on this floor — spill to whichever (eligible)
      // chef anywhere has the lightest queue right now.
      const allSorted = eligible
        .map((c) => ({ id: c.memberId, n: this.getChefBacklog(c.memberId) }))
        .sort((a, b) => a.n - b.n);
      return allSorted[0].id;
    }
    // No eligible chef on the seat's floor — assign to whoever's
    // lightest overall (still restricted to chefs who CAN claim the
    // appliance).
    const allSorted = eligible
      .map((c) => ({ id: c.memberId, n: this.getChefBacklog(c.memberId) }))
      .sort((a, b) => a.n - b.n);
    return allSorted[0].id;
  }

  /** Set of chef memberIds whose home floor has at least one station
   * providing the given appliance. Returns null when getCookStations
   * isn't wired (legacy / test boot) so callers can fall back to
   * the unfiltered chef list. */
  private cookableChefIdsFor(appliance: string): Set<string> | null {
    if (!this.getCookStations) return null;
    const stations = this.getCookStations();
    // Set of floors that have any matching station.
    const floorsWithApp = new Set<number>();
    for (const s of stations) {
      if (s.provides === appliance) floorsWithApp.add(s.floor);
    }
    // Legacy fallback: "stove" appliance also matches getStoves() —
    // claimFreeStation has the same fallback at line 583.
    if (appliance === "stove" && this.getStoves) {
      for (const s of this.getStoves()) floorsWithApp.add(s.floor);
    }
    if (floorsWithApp.size === 0) return new Set(); // nobody can cook
    const out = new Set<string>();
    for (const c of this.chefs) {
      if (floorsWithApp.has(c.homeFloor)) out.add(c.memberId);
    }
    return out;
  }

  /** GuestSpawner calls this when a guest leaves (angry / table sold /
   * any premature exit) so the in-flight ticket doesn't strand a chef
   * cooking for a ghost or a waiter carrying a plate to an empty
   * seat. Without this, the ticket lingered in the array forever:
   *   - cooking → chef finishes, ticket becomes 'ready', no guest
   *     to deliver to, waiter walks the plate to an empty seat
   *   - ready → never cleared; eventually a waiter picks it up and
   *     wastes a walk to nowhere
   *   - delivering → waiter arrives at empty seat, drops invisible
   *     plate, walks home — only state that was self-cleaning.
   *
   * Detaches the staff actor from the ticket (releases stove, hides
   * plate visual, sends them home) before splicing it out so they
   * don't keep `c.ticketId` / `w.ticketId` referencing a dead id. */
  cancelTicket(guestId: string): boolean {
    // Always drop any pending order request first — guests can leave
    // before they get to enqueue a cooking ticket (no waiter ever
    // came, customer gave up while seated), and the order-request
    // queue would otherwise strand a stale entry that a future waiter
    // would walk toward.
    this.cancelOrderRequest(guestId);
    const idx = this.tickets.findIndex((t) => t.guestId === guestId);
    if (idx < 0) return false;
    const ticket = this.tickets[idx];
    // Detach any chef currently working on it.
    for (const c of this.chefs) {
      if (c.ticketId !== ticket.id) continue;
      this.releaseStove(c);
      c.ticketId = null;
      // Route them home via the loiter spot — cheaper than restarting
      // their state machine and lets the working/moveActor branches
      // gracefully unwind.
      c.target = this.pickChefIdleSpot(c);
      this.planPath(c);
      c.state = "returningHome";
      c.character.action = "walk";
      c.clock = 0;
    }
    // Detach any waiter currently delivering it.
    for (const w of this.waiters) {
      if (w.ticketId !== ticket.id) continue;
      w.ticketId = null;
      if (w.heldPlate) w.heldPlate.visible = false;
      {
        const rest = this.pickWaiterIdleSpot(w);
        w.target = rest.pos;
        w.targetFloor = rest.floor;
        this.planPath(w);
      }
      w.state = "returningHome";
      w.character.action = "walk";
      w.clock = 0;
    }
    this.readyStallLogged.delete(ticket.id);
    this.mirrorTicketCancel(ticket);
    this.tickets.splice(idx, 1);
    console.log(`[Router] cancelTicket ${ticket.id} (guest ${guestId}) — was ${ticket.state}`);
    return true;
  }

  /** GuestSpawner calls this to learn if its ticket has been delivered. */
  popDeliveredFor(guestId: string): boolean {
    const i = this.tickets.findIndex((t) => t.guestId === guestId && t.state === "delivered");
    if (i < 0) return false;
    this.readyStallLogged.delete(this.tickets[i].id);
    this.tickets.splice(i, 1);
    return true;
  }

  /** Phase 9.65 (staff migration Pass 6) — render one staff actor purely
   * from its server row when ?serverSim=staffMove is on. The server owns
   * the state machine + pathfinding (Passes 1-5); here we just lerp the
   * body toward the latest cloud pose, reparent on a floor change, anchor
   * body Y to the floor slab, face the travel direction, and animate from
   * the server state. No local pathfinding, no streaming — so the client
   * can't fight the server (the root of the mirror-mode "stranded outside
   * / stuck looping" reports). */
  private renderActorFromServer(a: StaffActor, dt: number): void {
    if (a.cloudX === undefined || a.cloudZ === undefined) return; // no row yet
    const STOREY = 3;
    if (a.cloudFloor !== undefined && a.cloudFloor !== a.currentFloor) {
      // Phase M.17 — a cross-floor server hop lands on a stair tile; record the
      // storey being LEFT so the body ramps up the stairs over this pose's
      // interp (below) instead of snapping the whole storey. A non-stair floor
      // change (e.g. a reload reparent) has no stair tile → snap as before.
      a.stairFromFloor = nearStairTile(a.cloudX, a.cloudZ) ? a.currentFloor : undefined;
      a.currentFloor = a.cloudFloor;
      this.reparentCharacter?.(a.character, a.cloudFloor);
    }
    const pos = a.character.groundPos;
    // Snapshot interpolation: glide from the previous server pose to the
    // latest over the 2 Hz tick interval (interp 0→1), so the body moves at a
    // steady speed instead of the old exponential lerp that covered the
    // ~1.4 m/tick gap in ~250 ms and then stalled ("teleport + pause").
    const prevX = a.cloudPrevX ?? a.cloudX;
    const prevZ = a.cloudPrevZ ?? a.cloudZ;
    const STAFF_TICK_S = 0.5; // server staff tick = 2 Hz
    a.cloudInterp = Math.min(1, (a.cloudInterp ?? 1) + dt / STAFF_TICK_S);
    const t = a.cloudInterp;
    const tx = prevX + (a.cloudX - prevX) * t;
    const tz = prevZ + (a.cloudZ - prevZ) * t;
    // Snap on a real teleport / floor change; otherwise ease toward the
    // (already-smooth) interpolated point to absorb any update jitter.
    // Phase M.17 — DON'T snap during a stair climb; let the snapshot interp
    // glide the body from the stair entry to the exit landing so it visibly
    // walks up the steps (paired with the Y ramp below).
    const jump = Math.hypot(a.cloudX - pos.x, a.cloudZ - pos.y);
    if (jump > 2.5 && a.stairFromFloor === undefined) {
      pos.set(a.cloudX, a.cloudZ);
    } else {
      const alpha = Math.min(1, dt * 16);
      pos.x += (tx - pos.x) * alpha;
      pos.y += (tz - pos.y) * alpha;
    }
    // Containment belt-and-braces (the server already clamps to the box).
    if (pos.x < INTERIOR_MIN_X) pos.x = INTERIOR_MIN_X;
    else if (pos.x > INTERIOR_MAX_X) pos.x = INTERIOR_MAX_X;
    if (pos.y < INTERIOR_MIN_Z) pos.y = INTERIOR_MIN_Z;
    else if (pos.y > INTERIOR_MAX_Z) pos.y = INTERIOR_MAX_Z;
    // Anchor body Y to the floor slab (moveActor normally does this).
    // Phase M.17 — during a stair hop, RAMP Y from the departing storey to the
    // arrival storey over the pose interp so the body visibly climbs instead of
    // popping up. Cleared once the climb completes (t≥1) or the cloud pose
    // leaves the stair (the actor walks on toward its destination).
    const feetLift = a.character._feetLift ?? 0;
    let anchorY: number;
    if (a.stairFromFloor !== undefined) {
      const climbFloor = a.stairFromFloor + (a.currentFloor - a.stairFromFloor) * t;
      anchorY = climbFloor * STOREY + feetLift;
      if (t >= 1 || !nearStairTile(a.cloudX, a.cloudZ)) a.stairFromFloor = undefined;
    } else {
      anchorY = a.currentFloor * STOREY + feetLift;
    }
    a.character.root.position.y = anchorY;
    a.character._baseY = anchorY;
    // Face + animate from the current segment's travel direction. "moving" =
    // still gliding along a non-trivial segment; once arrived (t=1) with no
    // new pose, the actor reads as stopped.
    const segX = a.cloudX - prevX;
    const segZ = a.cloudZ - prevZ;
    const moving = Math.hypot(segX, segZ) > 0.03 && t < 1;
    if (moving) a.character.facingY = Math.atan2(-segX, -segZ);
    // Animate from the server state: working-at-station = the work gesture
    // ("carry"), anything in motion = walk, otherwise idle.
    if (a.cloudState === "working" && !moving) {
      a.character.action = "carry";
      // Phase M.8 — face what they're working ON (server-computed toward the
      // station) instead of the frozen last-walk direction. Guarded on the
      // station binding so it only applies to a chef/barman at their station,
      // the only actors face_y is set for.
      if (a.assignedStoveUid && a.faceY !== undefined) {
        a.character.facingY = a.faceY;
      }
    } else {
      a.character.action = moving ? "walk" : "idle";
    }
    // Keep local state in sync for any reader (snapshotMovable pins
    // "working" actors so the camera doesn't shove them mid-cook).
    if (a.cloudState === "idle" || a.cloudState === "movingToWork"
        || a.cloudState === "working" || a.cloudState === "returningHome") {
      a.state = a.cloudState;
    }
  }

  private waiterActivityLogTimer = 0;
  private waiterActivityGlobalSet = false;

  /** Add this frame's dt to the waiter's current-activity bucket. */
  private accumulateWaiterActivity(w: StaffActor, dt: number): void {
    const carrying = w.ticketId != null
      && this.tickets.some((t) => t.id === w.ticketId && t.state === "delivering");
    const key = waiterActivityKey(w, carrying);
    const m = (w.activityMs ??= {});
    m[key] = (m[key] ?? 0) + dt * 1000;
  }

  /** Install the console hook once + auto-dump the breakdown every ~90s. */
  private maybeLogWaiterActivity(dt: number): void {
    if (!this.waiterActivityGlobalSet) {
      (globalThis as unknown as { waiterTimes?: () => void }).waiterTimes = () => this.logWaiterActivity();
      this.waiterActivityGlobalSet = true;
    }
    this.waiterActivityLogTimer += dt;
    if (this.waiterActivityLogTimer >= 90) {
      this.waiterActivityLogTimer = 0;
      this.logWaiterActivity();
    }
  }

  /** Console breakdown of where waiter time goes: an AGGREGATE table (spot the
   * bottleneck) + a per-waiter table. Percentages are of tracked time. Reload
   * the page to reset the counters. */
  logWaiterActivity(): void {
    if (this.waiters.length === 0) { console.log("[waiterTimes] no waiters yet"); return; }
    const agg: Record<string, number> = {};
    let grand = 0;
    for (const w of this.waiters) {
      for (const [k, v] of Object.entries(w.activityMs ?? {})) { agg[k] = (agg[k] ?? 0) + v; grand += v; }
    }
    if (grand === 0) { console.log("[waiterTimes] nothing tracked yet — wait a bit"); return; }
    const aggTable: Record<string, { seconds: number; percent: string }> = {};
    for (const [k, v] of Object.entries(agg).sort((a, b) => b[1] - a[1])) {
      aggTable[k] = { seconds: Math.round(v / 1000), percent: `${((v / grand) * 100).toFixed(1)}%` };
    }
    console.log(`[waiterTimes] ${this.waiters.length} waiter(s), ${Math.round(grand / 1000)}s tracked — where the time goes:`);
    console.table(aggTable);
    const perWaiter: Record<string, Record<string, string>> = {};
    this.waiters.forEach((w, i) => {
      const m = w.activityMs ?? {};
      const tot = Object.values(m).reduce((a, b) => a + b, 0) || 1;
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1])) row[k] = `${((v / tot) * 100).toFixed(0)}%`;
      perWaiter[w.memberId ?? `waiter-${i}`] = row;
    });
    console.table(perWaiter);
  }

  update(dt: number): void {
    // Phase 9.65 (staff migration Pass 6) — full server ownership. The
    // server runs the staff state machine + pathfinding (Passes 1-5); the
    // client just lerps each body toward its staff_actor row + adopts the
    // server state for animation. No local sim, no client pathfinding, no
    // position streaming (the early return skips streamActorsToCloud
    // below). Opt-in: ?serverSim=all (roll back by removing the URL param).
    // Skipping the local ticks + clamp + stream is the whole point — those
    // are what fight the server in mirror mode.
    if (isServerSim("staffMove")) {
      for (const c of this.chefs) this.renderActorFromServer(c, dt);
      for (const b of this.barmen) this.renderActorFromServer(b, dt);
      for (const w of this.waiters) this.renderActorFromServer(w, dt);
      // Diagnostics — accumulate where each waiter's time goes (from the
      // mirrored server state) so bottlenecks surface. Call waiterTimes() in
      // the browser console for a breakdown; also auto-logged every ~90s.
      for (const w of this.waiters) this.accumulateWaiterActivity(w, dt);
      this.maybeLogWaiterActivity(dt);
      return;
    }
    // ⚠ DEAD IN PRODUCTION since 2026-06-27 (commit 460f442): staffMove is
    // DEFAULT-ON (featureFlags.ts), so the early return above ALWAYS fires and
    // everything below — the pre-cutover client staff sim (tickChef/tickBarman/
    // tickWaiter + clamp/recover/stampWork + streamActorsToCloud + the client
    // dispatch/assignment helpers that call planPath) — never runs. The server
    // now owns staff dispatch + pathfinding + state (Passes 1-6; restaurant_sim.rs
    // tick_staff_actor / auto_claim_queued_tickets).
    //
    // KEPT ONLY as the staffMove ROLLBACK: set DEFAULTS.staffMove=false in
    // featureFlags.ts and the client drives staff again if a server staff bug
    // surfaces. SCHEDULED FOR DELETION once the cutover is proven in real play
    // (~2-3k lines, most of this file). All-or-nothing: tsconfig noUnusedLocals
    // is true, so deleting this branch makes tsc flag every now-unused method —
    // delete what it lists, re-run tsc, repeat until clean (no dangling refs,
    // forced-complete). Runtime-safe (prod already skips this). See memory
    // cozy-bistro-staff-legacy-cleanup.
    for (const c of this.chefs) this.tickChef(c, dt);
    for (const b of this.barmen) this.tickBarman(b, dt);
    for (const w of this.waiters) this.tickWaiter(w, dt);
    // HARD interior clamp — EVERY frame, EVERY non-errand actor, regardless of
    // state. moveActor only clamps the body while an actor is MOVING; an IDLE
    // waiter / chef / barman stranded outside (a diverging local-sim target, or
    // an idle home that's never re-issued) would otherwise just stand on the
    // grass forever — "that guy outside" the player keeps seeing. Snap body AND
    // target into the interior box so it can never render or walk out. Errands
    // legitimately go out to shop, so they aren't in these lists. Mirrors the
    // server's tick_staff_actor clamp (restaurant_sim.rs).
    const clampInside = (a: StaffActor): void => {
      // Target always into the box (cheap; stops them pathing back out).
      a.target.x = Math.max(INTERIOR_MIN_X, Math.min(INTERIOR_MAX_X, a.target.x));
      a.target.y = Math.max(INTERIOR_MIN_Z, Math.min(INTERIOR_MAX_Z, a.target.y));
      const p = a.character.groundPos;
      let cx = Math.max(INTERIOR_MIN_X, Math.min(INTERIOR_MAX_X, p.x));
      let cz = Math.max(INTERIOR_MIN_Z, Math.min(INTERIOR_MAX_Z, p.y));
      // Also snap OFF furniture — a plain box-clamp can land an out-of-bounds
      // actor on a wall-edge lamp/cabinet ("stuck in the lamp"). snapToClear is
      // a no-op when already on a walkable tile (chef at a stove, waiter beside
      // a seat), so only a genuinely clipped / outside actor is moved.
      if (this.pathfind) {
        const s = this.pathfind.snapToClear(cx, cz, a.currentFloor);
        cx = Math.max(INTERIOR_MIN_X, Math.min(INTERIOR_MAX_X, s.x));
        cz = Math.max(INTERIOR_MIN_Z, Math.min(INTERIOR_MAX_Z, s.z));
      }
      // Only write when it actually moved — never disturb a normally-walking actor.
      if (Math.abs(cx - p.x) > 1e-4 || Math.abs(cz - p.y) > 1e-4) p.set(cx, cz);
    };
    for (const c of this.chefs) clampInside(c);
    for (const b of this.barmen) clampInside(b);
    for (const w of this.waiters) clampInside(w);
    // Rigged staff play their WORK gesture (cook / mix / serve at a station)
    // ONLY while actually AT the station working — the RiggedController keys
    // off action "carry". Set it from the authoritative state here (after the
    // ticks) rather than threading it through every branch, but respect two
    // things the old blanket "working → carry" got wrong:
    //   • A "working" actor still FAR from its target is in TRANSIT — a waiter
    //     carrying a plate to the seat — so it must WALK, not mime the serve
    //     gesture the whole way ("serving on the way to the customer"). Only
    //     gesture once arrived at the target tile.
    //   • A dwell the tick deliberately marked "idle" (take-order beside the
    //     guest, table-bussing) must KEEP idle so it plays the stand-idle clip
    //     instead of miming work while standing still.
    const stampWork = (a: StaffActor): void => {
      if (a.state !== "working" || a.character.action === "idle") return;
      a.character.action =
        this.distance(a.character.groundPos, a.target) > ARRIVAL_THRESHOLD ? "walk" : "carry";
    };
    for (const c of this.chefs) stampWork(c);
    for (const b of this.barmen) stampWork(b);
    for (const w of this.waiters) stampWork(w);
    // Stuck-staff recovery. An actor that should be walking toward its target
    // but hasn't made progress for a few seconds has clipped onto furniture
    // (e.g. a chair) — pathfinding can't route off a blocked start cell, so it
    // just plays the walk loop in place, facing a wall. Snap it onto the
    // nearest clear tile + re-plan. (Actors AT their target — a chef cooking,
    // an idle waiter — stand still legitimately and are skipped.)
    const recoverStuck = (a: StaffActor): void => {
      if (this.distance(a.character.groundPos, a.target) <= ARRIVAL_THRESHOLD) {
        a.stuckClock = 0;
        a.lastStuckPos = undefined;
        return;
      }
      if (!a.lastStuckPos || this.distance(a.character.groundPos, a.lastStuckPos) > 0.1) {
        a.lastStuckPos = (a.lastStuckPos ?? new THREE.Vector2()).copy(a.character.groundPos);
        a.stuckClock = 0;
        return;
      }
      a.stuckClock = (a.stuckClock ?? 0) + dt;
      if (a.stuckClock < STAFF_STUCK_SECONDS) return;
      a.stuckClock = 0;
      a.lastStuckPos = undefined;
      if (this.pathfind) {
        const sp = this.pathfind.snapToClear(a.character.groundPos.x, a.character.groundPos.y, a.currentFloor);
        a.character.groundPos.set(
          Math.max(INTERIOR_MIN_X, Math.min(INTERIOR_MAX_X, sp.x)),
          Math.max(INTERIOR_MIN_Z, Math.min(INTERIOR_MAX_Z, sp.z)),
        );
        // Re-validate the DESTINATION too, not just the body — otherwise the
        // actor loops: snapped off the furniture, then re-planned straight
        // back onto it because its TARGET is itself a blocked cell. The usual
        // culprit is the home spot (set once at hire, never re-checked) with a
        // chair/table later placed on it. Snap home + target onto clear tiles.
        const sh = this.pathfind.snapToClear(a.home.x, a.home.y, a.homeFloor);
        a.home.set(sh.x, sh.z);
        const st = this.pathfind.snapToClear(a.target.x, a.target.y, a.targetFloor);
        a.target.set(st.x, st.z);
      }
      this.planPath(a);
    };
    for (const c of this.chefs) recoverStuck(c);
    for (const b of this.barmen) recoverStuck(b);
    for (const w of this.waiters) recoverStuck(w);
    this.recoverStalledTickets(dt);
    this.logHeartbeatIfDue(dt);
    this.streamActorsToCloud(dt);
  }

  /** Accumulator for the ~1 Hz position publish. Same throttle the
   * GuestSpawner uses; one reducer call per actor per second is cheap
   * + keeps the active_guest / active_ticket subscribers in step with
   * actual movement without flooding the wire.
   *
   * Phase H cutover (commit 8bff1c1 era): with isServerSim("staff")
   * on, the server's tick_staff_actor (commit d806c47) steps
   * positions every 100 ms. The client's ~1 Hz stream then OVERWRITES
   * the server's interpolated position with the client's locally
   * computed one — undoing the server's work and creating a small
   * visual jitter at the mirror tick for any subscriber (visit mode,
   * cross-device). We now skip the periodic stream entirely under
   * the flag: per-event mirrorActorUpdate calls (already wired on
   * state transitions) keep targets fresh, and the server
   * interpolates between target changes. Net effect: server-driven
   * smooth motion, no client overrides. */
  /** Accumulator for the ~1 Hz position publish. Same throttle the
   * GuestSpawner uses; one reducer call per actor per second is cheap
   * + keeps the active_guest / active_ticket subscribers in step with
   * actual movement without flooding the wire.
   *
   * Why we still stream under Phase H: the server's tick_staff_actor
   * (commit d806c47) steps position toward target_x/z, but the
   * TARGET ONLY moves when the client publishes a new one. Without
   * the periodic stream the server has no way to learn that the
   * chef who finished cooking now wants to walk back to home — the
   * StaffRouter state machine doesn't yet wire per-event mirrors
   * at every target change. The 1Hz overwrite is the price of
   * keeping target+state fresh until those per-event hooks land. */
  private cloudActorAccum = 0;
  private streamActorsToCloud(dt: number): void {
    if (!isServerSim("staff") || !this.cloud) return;
    // Per-frame change detection: walk every actor, compute a
    // fingerprint of (state, ticketId, target_x, target_z). Fire the
    // mirror reducer immediately when the fingerprint differs from
    // the last published value. Cuts the visit-mode lag from <1 s
    // down to <100 ms for state + target changes without needing
    // mirror calls scattered across 40+ transition sites.
    //
    // Periodic floor: still fire every 1 s even when unchanged so
    // position drift (from the local sim's continuous movement)
    // reaches subscribers. The fingerprint check sits BEFORE the
    // periodic fire so a state-change publish on this frame
    // satisfies the "did we mirror recently?" requirement.
    this.cloudActorAccum += dt;
    const periodicFire = this.cloudActorAccum >= 1.0;
    if (periodicFire) this.cloudActorAccum = 0;
    // Phase 9.59 — snapshot the server's home_floor for every actor once
    // per periodic pass so the loop can self-heal any that drifted from
    // the player's assignment (cheap O(actors), built once not per-actor).
    const serverFloors = periodicFire && this.cloud
      ? this.cloud.getServerHomeFloorMap()
      : null;
    for (const pool of [this.chefs, this.waiters, this.barmen]) {
      for (const a of pool) {
        const fingerprint = `${a.state}|${a.ticketId ?? ""}|${a.target.x.toFixed(2)}|${a.target.y.toFixed(2)}`;
        if (fingerprint !== a.lastMirrorFingerprint) {
          this.mirrorActorUpdate(a);
          a.lastMirrorFingerprint = fingerprint;
          continue;
        }
        if (periodicFire) {
          this.mirrorActorUpdate(a);
          this.healHomeFloorIfStale(a, serverFloors);
        }
      }
    }
  }

  /** Per-member cooldown (ms epoch) so the self-heal doesn't re-push every
   * 1 s tick during the ~100 ms the server takes to apply a correction. */
  private homeFloorHealAt = new Map<string, number>();

  /** Phase 9.59 — home_floor self-heal. The player's StaffSystem floor
   * assignment is canonical; the server's staff_actor.home_floor must
   * match it or the strict per-floor dispatch (9.55) routes work to the
   * wrong floor — the exact "I set 3/3 but the server thinks 4/2" drift.
   * If an IDLE actor's server floor differs, re-register to correct it
   * (the register branch resets the row to idle on the right storey,
   * harmless for an already-idle actor). Idle-only so an actor mid-cook
   * or mid-delivery is never disturbed — it heals when it next goes idle. */
  private healHomeFloorIfStale(
    a: StaffActor,
    serverFloors: Map<string, number> | null,
  ): void {
    if (!serverFloors || a.state !== "idle") return;
    const sf = serverFloors.get(a.memberId);
    if (sf == null || sf === a.homeFloor) return;
    const now = Date.now();
    if (now < (this.homeFloorHealAt.get(a.memberId) ?? 0)) return;
    this.homeFloorHealAt.set(a.memberId, now + 4000);
    this.mirrorActorRegister(a);
    console.log(
      `[Sync] home_floor self-heal: ${a.role} ${a.memberId} server F${sf} → assigned F${a.homeFloor}`,
    );
  }

  private mirrorActorRegister(a: StaffActor): void {
    if (!isServerSim("staff") || !this.cloud) return;
    this.cloud.registerStaffActor({
      memberId: a.memberId,
      role: a.role,
      homeFloor: a.homeFloor,
      homeX: a.home.x,
      homeZ: a.home.y,
      spawnX: a.character.groundPos.x,
      spawnZ: a.character.groundPos.y,
      spawnFloor: a.currentFloor,
    });
  }

  /** Phase I (H.74) — Re-register every actor currently in the
   * router (all chefs / waiters / barmen) up to cloud's
   * `staff_actor` table.  Used at connect-ready to backfill any
   * actors that exist locally but never made it to cloud (e.g.
   * because the staff_actor register code landed AFTER they were
   * first hired into the local save).  Idempotent — the server
   * reducer's existing-row branch refreshes metadata on re-register
   * without disturbing in-flight state. */
  resyncAllActorsToCloud(): void {
    if (!isServerSim("staff") || !this.cloud) return;
    let n = 0;
    for (const c of this.chefs) { this.mirrorActorRegister(c); n += 1; }
    for (const w of this.waiters) { this.mirrorActorRegister(w); n += 1; }
    for (const b of this.barmen) { this.mirrorActorRegister(b); n += 1; }
    if (n > 0) {
      console.log(`[H.74] re-registered ${n} staff actor(s) to cloud staff_actor`);
    }
  }

  private mirrorActorUnregister(memberId: string): void {
    if (!isServerSim("staff") || !this.cloud) return;
    this.cloud.unregisterStaffActor(memberId);
  }

  private mirrorActorUpdate(a: StaffActor): void {
    if (!isServerSim("staff") || !this.cloud) return;
    // Map local Ticket id (string) to the server's u64 via the
    // matching ticket's serverMirrorId. Cheap O(N) scan — tickets
    // array is short. Null when not bound or not yet mirrored.
    let serverTicketId: bigint | null = null;
    if (a.ticketId) {
      const t = this.tickets.find((t) => t.id === a.ticketId);
      serverTicketId = t?.serverMirrorId ?? null;
    }
    // Phase H bug fix — map the local takeOrderRequest's guestId
    // (a local string like "guest-7") to the server's u64 via the
    // existing lookupGuestServerId callback. Previously this was
    // hardcoded to null, which meant the periodic 1 Hz mirror
    // CLOBBERED the server's freshly-set take_order_guest_id back
    // to null seconds after try_dispatch_take_order set it. The
    // server's waiter_finished_taking_order then couldn't match
    // the waiter to the guest (filter is
    // `take_order_guest_id == Some(guest_id)`), so the guest sat
    // in "ordering" state until ORDERING_FALLBACK_MS (10s) elapsed.
    // User-visible symptom: idle-looking waiter not walking to a
    // patiently-waiting guest with declining patience timer.
    let serverTakeOrderGuestId: bigint | null = null;
    if (a.takeOrderRequest && this.lookupGuestServerId) {
      serverTakeOrderGuestId = this.lookupGuestServerId(a.takeOrderRequest.guestId) ?? null;
    }
    const trip = a.washTrip ?? null;
    this.cloud.updateStaffActor({
      memberId: a.memberId,
      state: a.state,
      ticketId: serverTicketId,
      x: a.character.groundPos.x,
      z: a.character.groundPos.y,
      floor: a.currentFloor,
      targetX: a.target.x,
      targetZ: a.target.y,
      targetFloor: a.targetFloor,
      assignedStoveUid: a.assignedStoveUid ?? "",
      lastStoveUid: a.lastStoveUid ?? "",
      washTargetUid: trip?.stationUid ?? "",
      washDirtyId: BigInt(trip?.dirtyId ?? -1),
      washPhase: trip?.phase ?? "",
      takeOrderGuestId: serverTakeOrderGuestId,
    });
  }

  /** Every 5 sim-seconds, dump one line summarizing what the kitchen is
   * actually doing right now. Includes each staffer's CURRENT world
   * position so we can tell the difference between "stuck in idle" and
   * "moving but the player's eye missed it". */
  private heartbeatElapsed = 0;
  private logHeartbeatIfDue(dt: number): void {
    this.heartbeatElapsed += dt;
    if (this.heartbeatElapsed < 5) return;
    this.heartbeatElapsed = 0;
    const fmt = (a: StaffActor): string => {
      const p = a.character.groundPos;
      return `${a.state}@(${p.x.toFixed(2)},${p.y.toFixed(2)})`;
    };
    const chefs = this.chefs.map(fmt).join(" | ");
    const waiters = this.waiters.map(fmt).join(" | ");
    const ticketStates: Record<string, number> = {};
    for (const t of this.tickets) ticketStates[t.state] = (ticketStates[t.state] ?? 0) + 1;
    const ticketSummary = Object.entries(ticketStates).map(([s, n]) => `${n} ${s}`).join(", ") || "none";
    console.log(`[Router/💓] chefs:[${chefs}] · waiters:[${waiters}] · tickets:{${ticketSummary}}`);
  }

  /** Re-queue tickets that are stuck in a transient state because the
   * worker handling them was removed or wandered off. Without this a
   * pool-shrink during a delivery could orphan a guest forever. */
  private recoverStalledTickets(dt: number): void {
    for (const t of this.tickets) {
      t.clock += dt;
      // Queued for >10s with no chef having picked it up — the
      // pre-assigned chef likely can't reach a matching station
      // (cross-floor appliance gap). Null out assignedChefId so the
      // orphan-pickup fallback in the chef idle handler considers it
      // for cross-floor pickup after CROSS_FLOOR_WAIT_SECONDS.
      // Bar tickets are skipped — they intentionally have null
      // assignedChefId and route via the barman pool.
      if (t.state === "queued" && t.appliance !== "bar"
          && t.assignedChefId != null && t.clock > 10) {
        console.warn(`[Router] ticket ${t.id} queued >10s under chef ${t.assignedChefId} — unassigning so orphan pickup kicks in`);
        t.assignedChefId = null;
        t.clock = 0;
      }
      // Cooking should finish within cookSeconds + ~5s slop. If it's been
      // way longer (no chef holding the assignment), boot it back to queued.
      if (t.state === "cooking" && t.clock > t.cookSeconds + 12) {
        const owner = this.chefs.find((c) => c.ticketId === t.id);
        if (!owner) { t.state = "queued"; t.clock = 0; }
      }
      // Delivering should finish in a few seconds. If 15+ have passed and
      // no waiter is on it, mark ready again for another waiter.
      if (t.state === "delivering" && t.clock > 15) {
        const owner = this.waiters.find((w) => w.ticketId === t.id);
        if (!owner) { t.state = "ready"; t.clock = 0; }
      }
      // 'ready' has no auto-recovery (no chef/waiter is "stuck" on it
      // by definition — it's waiting in the pickup queue) but a ticket
      // that sits ready for 30s+ tells us the waiter pool is starved
      // or blocked. The customer's own patience drives the abandon path
      // — this log just helps diagnose "why is no waiter picking up?"
      // during playtesting. Logs once per stall, not every tick.
      if (t.state === "ready" && t.clock > 30 && !this.readyStallLogged.has(t.id)) {
        this.readyStallLogged.add(t.id);
        const idle = this.waiters.filter((w) => w.state === "idle").length;
        console.warn(`[Router] ticket ${t.id} has been READY for >30s — ${idle}/${this.waiters.length} waiters idle. Pool starved?`);
      }
    }
  }
  /** Set of ticket ids we've already logged a 'ready stall' warning for,
   * so the warn doesn't spam every tick. Entries are dropped when the
   * ticket leaves the array (popDeliveredFor / cancelTicket). */
  private readonly readyStallLogged = new Set<string>();

  // === Chef state machine ===

  private tickChef(c: StaffActor, dt: number): void {
    c.clock += dt;

    switch (c.state) {
      case "idle": {
        // Phase H Phase 1 — when the server owns ticket dispatch, the
        // chef stays idle until the auto_claim_queued_tickets server
        // tick assigns them a ticket. The reconcileCloudStaffActor
        // bridge then transitions us to movingToWork. Skipping the
        // local picker means a 0–500ms wait (server tick interval)
        // before the first chef-claim each cycle. Worth it: the local
        // picker would race the server, win most of the time, and the
        // resulting state-write would be reconciled back to whatever
        // the server picked anyway. Now the decision lives in one
        // place.
        if (this.serverOwnsTicketDispatch()) break;

        // Chef ignores bar tickets — those belong to the barman pool.
        // Without the appliance filter a chef would call
        // claimFreeStation("bar") and happily cook a drink at a bar
        // counter, defeating the "drinks require a barman" rule.
        // Per-chef backlog: this chef ONLY cooks tickets assigned to
        // them (or unassigned legacy tickets — see fallback below).
        // Other chefs' assigned tickets are off-limits, even if this
        // chef is idle and the other chef is busy — that's the whole
        // point of the per-chef queue.
        const isMyTicket = (t: Ticket): boolean =>
          t.state === "queued"
          && t.appliance !== "bar"
          && t.assignedChefId === c.memberId;
        // sortByUrgency reorders so the most-impatient customer goes
        // first inside this chef's backlog.
        const myTickets = this.sortByUrgency(this.tickets.filter(isMyTicket));
        if (myTickets.length > 0) {
          c.homeWorkWaitClock = 0;
          if (this.tryClaimCookForChef(c, myTickets)) break;
          break;
        }
        // Fallback: cook UNASSIGNED tickets (a chef got fired and
        // their pending tickets had their assignedChefId reset to
        // null in handleStaffMemberFired). Prefer same-floor first,
        // then anywhere after the cross-floor wait — same logic the
        // legacy chef idle loop used.
        const isOrphan = (t: Ticket): boolean =>
          t.state === "queued"
          && t.appliance !== "bar"
          && (t.assignedChefId == null || !this.chefs.some((cc) => cc.memberId === t.assignedChefId));
        const homeOrphans = this.sortByUrgency(this.tickets.filter((t) => isOrphan(t) && t.seatFloor === c.homeFloor));
        if (homeOrphans.length > 0) {
          c.homeWorkWaitClock = 0;
          if (this.tryClaimCookForChef(c, homeOrphans)) break;
          break;
        }
        c.homeWorkWaitClock += dt;
        if (c.homeWorkWaitClock < CROSS_FLOOR_WAIT_SECONDS) break;
        const anyOrphans = this.sortByUrgency(this.tickets.filter((t) =>
          isOrphan(t) && !this.hasIdleHomeChef(t.seatFloor, c)));
        if (anyOrphans.length > 0) {
          // allowCrossFloor=true so a chef on Floor 0 can claim a
          // Floor 1 toaster when the orphan ticket needs one and no
          // chef has a toaster on their home floor. Without this the
          // ticket sits forever even after the orphan-pickup branch
          // grabs it.
          this.tryClaimCookForChef(c, anyOrphans, /* allowCrossFloor */ true);
        }
        break;
      }
      case "movingToWork": {
        this.moveActor(c, dt);
        if (this.distance(c.character.groundPos, c.target) < ARRIVAL_THRESHOLD) {
          c.character.action = "carry"; // forward pitch reads as "cooking"
          c.state = "working";
          c.clock = 0;
        }
        break;
      }
      case "working": {
        const ticket = this.tickets.find((t) => t.id === c.ticketId);
        // C5 — defensive guards for state desync. The ticket can vanish
        // (cancelTicket from a despawn), get bounced back to "queued"
        // by recoverStalledTickets, or transition to "ready"/"delivering"
        // via some external path. In any case where it isn't still
        // "cooking" for THIS chef, drop the cook and return home.
        // Another chef (or this one) will re-pick it via the idle
        // handler next tick if it's still queued.
        if (!ticket || ticket.state !== "cooking") {
          this.releaseStove(c);
          c.target = this.pickChefIdleSpot(c);
          this.planPath(c);
          c.state = "returningHome";
          c.character.action = "walk";
          c.clock = 0;
          c.ticketId = null;
          break;
        }
        // Phase H Phase 1 — when server owns dispatch, only the server
        // flips cooking → ready (via tick_ticket_state's cook_seconds_ms
        // check). Local sim just advances c.clock visually; the bridge's
        // chef-release case handles the transition to returningHome
        // when the server's release_chef_from_ticket fires.
        if (c.clock >= ticket.cookSeconds && !this.serverOwnsTicketDispatch()) {
          ticket.state = "ready";
          ticket.clock = 0;
          // Record where the plate is sitting so the waiter walks to
          // THIS station to pick it up instead of the legacy fixed
          // pickup spot. Uses the chef's current ground pose since
          // they're standing in front of the station they just cooked
          // at; same floor as the chef (no cross-floor cooking).
          ticket.pickupPos = c.character.groundPos.clone();
          ticket.pickupFloor = c.currentFloor;
          this.mirrorTicketFinish(ticket, ticket.pickupPos, ticket.pickupFloor);
          this.releaseStove(c);
          c.target = this.pickChefIdleSpot(c);
          this.planPath(c);
          c.state = "returningHome";
          c.character.action = "walk";
          c.ticketId = null;
          c.clock = 0;
        }
        break;
      }
      case "returningHome": {
        // Same interrupt as the waiter: if a queued ticket assigned
        // to THIS chef is sitting in their backlog, abort the loiter
        // walk and start cooking from where we are. Bar tickets are
        // excluded — chef never touches them. Per-chef backlog rule
        // applies here too — no poaching from another chef's queue.
        //
        // Phase H Phase 1 — server picks chefs at server-tick rate.
        // Skipping the local interrupt-claim means a chef finishing one
        // cook walks all the way home before being eligible for the
        // next ticket. The auto_claim picker then assigns them on the
        // next tick. Worst case +500ms vs. the legacy interrupt; the
        // wait stays bounded because home is small.
        if (!this.serverOwnsTicketDispatch()) {
          const interruptTickets = this.sortByUrgency(this.tickets.filter((t) =>
            t.state === "queued" && t.appliance !== "bar" && t.assignedChefId === c.memberId));
          if (interruptTickets.length > 0 && this.tryClaimCookForChef(c, interruptTickets)) {
            break;
          }
        }
        this.moveActor(c, dt);
        if (this.distance(c.character.groundPos, c.target) < ARRIVAL_THRESHOLD) {
          c.character.action = "idle";
          c.state = "idle";
          c.clock = 0;
        }
        break;
      }
    }
  }

  // === Barman state machine ===
  //
  // The barman mirrors the chef closely — same idle/move/work/return
  // cycle, same station-claim flow, same recovery on guest-bail — but
  // restricted to bar tickets (recipe.appliance === "bar") and bar
  // counter stations (provides === "bar"). Sharing tickets with the
  // chef pool would let a chef pick up a drink ticket that needs a
  // bar counter; the appliance filter on claimFreeStation already
  // prevents that mismatch, but routing drink tickets exclusively
  // through the barmen pool keeps the chef from even seeing them and
  // makes "no barman hired" visibly fail instead of silently waiting.
  //
  // Bar-seated guests get a DIRECT serve path (the customer is at the
  // counter, the barman is at the counter, no waiter trip needed) —
  // see the "ready" handler below.
  private tickBarman(b: StaffActor, dt: number): void {
    b.clock += dt;
    switch (b.state) {
      case "idle": {
        // Barmen are HARD-PINNED to their home floor — they're tied
        // to their bar counter physically and never cross to another
        // floor's bar, even if it's unstaffed. (Chefs and waiters
        // have a CROSS_FLOOR_WAIT_SECONDS fallback that kicks in
        // when their own floor is quiet; the barman explicitly
        // doesn't get that fallback so each bar floor needs its own
        // hire.) Priority for the barman:
        //   1. Home-floor bar customer waiting to order → walk to
        //      their stool, dwell, fire callback.
        //   2. Home-floor queued bar ticket → cook at the bar.
        // Nothing else. No cross-floor poach.
        const homeOrder = this.sortByUrgency(this.orderRequests.filter((o) =>
          o.claimedBy === null && o.atBar && o.seatFloor === b.homeFloor))[0];
        if (homeOrder) {
          this.startBarmanTakeOrder(b, homeOrder);
          break;
        }
        const homeTickets = this.sortByUrgency(this.tickets.filter((t) =>
          t.state === "queued" && t.appliance === "bar" && t.seatFloor === b.homeFloor));
        if (homeTickets.length > 0) {
          this.tryClaimDrinkForBarman(b, homeTickets);
        }
        break;
      }
      case "movingToWork": {
        this.moveActor(b, dt);
        if (this.distance(b.character.groundPos, b.target) < ARRIVAL_THRESHOLD) {
          // Take-order arrival — stand at the seat for the dwell, no
          // "mixing" pose since we're just chatting.
          if (b.takeOrderRequest) {
            b.character.action = "idle";
            b.state = "working";
            b.clock = 0;
            break;
          }
          // Deliver-arrival — barman walked the finished drink to a
          // bar customer's stool. Mark delivered + go home; no dwell.
          const deliveringTicket = b.ticketId
            ? this.tickets.find((t) => t.id === b.ticketId && t.state === "delivering")
            : undefined;
          if (deliveringTicket) {
            deliveringTicket.state = "delivered";
            this.mirrorTicketDeliver(deliveringTicket);
            b.ticketId = null;
            b.target = this.pickBarmanIdleSpot(b);
            this.planPath(b);
            b.state = "returningHome";
            b.character.action = "walk";
            b.clock = 0;
            break;
          }
          // Normal cooking arrival.
          b.character.action = "carry"; // forward pitch reads as "mixing"
          b.state = "working";
          b.clock = 0;
        }
        break;
      }
      case "working": {
        // Take-order dwell — same timer the waiter uses. Fire the
        // spawner callback on completion so it builds the recipe
        // list + enqueues the cooking ticket; the barman then picks
        // that ticket up next tick via the idle handler.
        if (b.takeOrderRequest) {
          if (b.clock >= TAKE_ORDER_DWELL_SECONDS) {
            const req = b.takeOrderRequest;
            this.takeOrderCallback?.(req.guestId);
            const reqIdx = this.orderRequests.findIndex((o) => o.guestId === req.guestId);
            if (reqIdx >= 0) this.orderRequests.splice(reqIdx, 1);
            b.takeOrderRequest = null;
            b.target = this.pickBarmanIdleSpot(b);
            this.planPath(b);
            b.state = "returningHome";
            b.character.action = "walk";
            b.clock = 0;
          }
          break;
        }
        const ticket = this.tickets.find((t) => t.id === b.ticketId);
        // Phase I — bar-only deliver dwell.  When cooking completes
        // for a bar-seated customer, the upstream branch flips the
        // ticket to "delivering" + sets the barman's pose to "carry"
        // WITHOUT moving them away from the cook stand.  Dwell here
        // for BAR_DELIVER_DWELL_SECONDS so the player visually
        // registers the handoff, then mark delivered + return to
        // idle.  Without this branch the desync guard below would
        // bounce the barman home the instant ticket.state flipped
        // off "cooking", and the "carry" pose would flash for one
        // frame.  Dunnin: barmen "stay and operate from BEHIND the
        // bar only" — this is the enforcement.
        const BAR_DELIVER_DWELL_SECONDS = 0.8;
        if (ticket && ticket.state === "delivering" && ticket.seatAtBar) {
          if (b.clock >= BAR_DELIVER_DWELL_SECONDS) {
            ticket.state = "delivered";
            this.mirrorTicketDeliver(ticket);
            b.ticketId = null;
            b.target = this.pickBarmanIdleSpot(b);
            this.planPath(b);
            b.state = "returningHome";
            b.character.action = "walk";
            b.clock = 0;
          }
          break;
        }
        // C5 — same defensive desync guard as the chef. Ticket
        // vanished OR bounced out of "cooking" → drop the station
        // and return home; the bar idle handler will re-pick it
        // next tick if it's still queued.
        if (!ticket || ticket.state !== "cooking") {
          this.releaseStove(b);
          b.target = this.pickBarmanIdleSpot(b);
          this.planPath(b);
          b.state = "returningHome";
          b.character.action = "walk";
          b.clock = 0;
          b.ticketId = null;
          break;
        }
        if (b.clock >= ticket.cookSeconds) {
          // Pickup is right here at the bar counter — see chef branch
          // for the same pattern. Critical for bar drinks where the
          // "pickup" is the bar counter, not the kitchen line.
          ticket.pickupPos = b.character.groundPos.clone();
          ticket.pickupFloor = b.currentFloor;
          this.releaseStove(b);
          // Bar-seated customers get a direct serve from the barman —
          // no waiter trip, the bar IS the pickup AND the seat. Other
          // customers (table seats) get the ticket marked "ready" so
          // the waiter pool picks it up.
          if (ticket.seatAtBar) {
            // For bar tickets the barman is also the delivery agent,
            // so the server sees a single "ready→delivering" hop. Fire
            // both mirror calls to keep the cloud state consistent.
            this.mirrorTicketFinish(ticket, ticket.pickupPos, ticket.pickupFloor);
            ticket.state = "delivering";
            ticket.clock = 0;
            this.mirrorTicketPickup(ticket);
            // Dunnin's design note (from in-game chat): barmen
            // "stay and operate from BEHIND the bar only".  Don't
            // walk around to ticket.seatPos (the customer's stool
            // on the +Z side of the counter).  Instead, hold a
            // brief "carry" pose at the cook stand — the drink
            // visually appears at the seat via the customer's
            // eat animation while the barman stays put.  The
            // tickBarman working-branch deliver dwell handles the
            // transition to "delivered" + returningHome below.
            //
            // No state flip needed — already in "working".  We just
            // reset the clock so the deliver dwell timer is fresh,
            // and switch the pose so the player gets a visual cue.
            b.character.action = "carry";
            b.clock = 0;
          } else {
            ticket.state = "ready";
            ticket.clock = 0;
            this.mirrorTicketFinish(ticket, ticket.pickupPos, ticket.pickupFloor ?? 0);
            b.target = this.pickBarmanIdleSpot(b);
            this.planPath(b);
            b.state = "returningHome";
            b.character.action = "walk";
            b.ticketId = null;
            b.clock = 0;
          }
        }
        break;
      }
      case "returningHome": {
        // Same interrupt as the chef — but also catch a fresh bar
        // order request (customer just sat down at the bar) so we
        // don't make them wait for the round-trip back to the home
        // spot before flagging us down.
        const interruptOrder = this.sortByUrgency(this.orderRequests.filter((o) =>
          o.claimedBy === null && o.atBar && o.seatFloor === b.homeFloor))[0];
        if (interruptOrder) {
          this.startBarmanTakeOrder(b, interruptOrder);
          break;
        }
        const interruptTickets = this.sortByUrgency(this.tickets.filter((t) =>
          t.state === "queued" && t.appliance === "bar" && t.seatFloor === b.homeFloor));
        if (interruptTickets.length > 0 && this.tryClaimDrinkForBarman(b, interruptTickets)) {
          break;
        }
        this.moveActor(b, dt);
        if (this.distance(b.character.groundPos, b.target) < ARRIVAL_THRESHOLD) {
          b.character.action = "idle";
          b.state = "idle";
          b.clock = 0;
        }
        break;
      }
    }
  }

  /** Bar variant of startWaiterTakeOrder — claim the request so two
   * barmen don't race for the same bar customer, point at the seat,
   * flip into movingToWork. Reuses the actor's takeOrderRequest
   * field; the working state handles the dwell + callback. */
  private startBarmanTakeOrder(b: StaffActor, req: OrderRequest): void {
    req.claimedBy = b.memberId;
    b.takeOrderRequest = req;
    b.target = req.seatPos.clone();
    b.targetFloor = req.seatFloor;
    this.planPath(b);
    b.state = "movingToWork";
    b.clock = 0;
    b.character.action = "walk";
    b.homeWorkWaitClock = 0;
    console.log(`[Router] barman taking bar order from ${req.guestId} (floor ${req.seatFloor})`);
  }

  /** Bar-counter variant of tryClaimCookForChef — same iterate-until-
   * a-station-is-free pattern, but the only valid appliance is "bar"
   * and there's no legacy fallback (no bar counter means no drinks). */
  private tryClaimDrinkForBarman(b: StaffActor, candidates: readonly Ticket[]): boolean {
    for (const ticket of candidates) {
      const station = this.claimFreeStation("bar", b.homeFloor, b.character.groundPos);
      if (!station) continue;
      b.assignedStoveUid = station.uid;
      // Phase I (H.79) — Cook stand uses the centroid-aware "inside"
      // picker (same as the idle spot) so the barman walks BEHIND
      // the bar to mix instead of around to the customer side.
      const allBars = this.getCookStations?.()
        .filter((s) => s.provides === "bar" && s.floor === b.homeFloor) ?? [station];
      const target = this.barmanInsideStandFor(station, allBars);
      ticket.state = "cooking";
      ticket.clock = 0;
      // Phase I (H.97) — Set assignedChefId on the LOCAL ticket so
      // getBarmanBacklog can attribute it. Bar tickets enqueue with
      // assignedChefId=null (line 1302) because the chef-pool picker
      // doesn't apply to barmen, but without this assignment after
      // claim the per-member badge query would never find them
      // (filter is assignedChefId === barmanMemberId) and the
      // "1 working" header would be visible while no individual
      // barman row had a badge.
      ticket.assignedChefId = b.memberId;
      const chefMult = this.getChefCookMultiplier?.(b.memberId) ?? 1;
      ticket.cookSeconds = Math.max(1, ticket.baseCookSeconds * chefMult);
      this.mirrorTicketClaim(ticket, b.memberId);
      b.ticketId = ticket.id;
      b.target = target;
      this.planPath(b);
      b.state = "movingToWork";
      b.clock = 0;
      b.character.action = "walk";
      b.homeWorkWaitClock = 0;
      console.log(`[Router] barman picked up ${ticket.id} (bar) → ${station.uid} (mult ${chefMult.toFixed(2)})`);
      return true;
    }
    return false;
  }

  /** Phase I (H.79) — Compute the "behind the bar" stand position for
   * a given bar tile, using the centroid of ALL bar tiles on the
   * floor to detect which side is "inside".  Replaces the naive
   * chefStandPosFor(station) for barman positions.
   *
   * For a U / O-shaped bar: centroid is INSIDE the ring, so the
   * candidate (front or back) closer to the centroid is the
   * barman-side regardless of which way the player rotated the
   * individual tile.
   *
   * For a single straight bar tile: both candidates are equidistant
   * to the centroid (= the tile itself), so we tiebreak to BACK
   * (-rotY side).  Bar counter defs put their seats on the +rotY
   * face, so the back is the natural barman side.
   *
   * Returns the world-position the barman should stand at to be
   * BEHIND that bar tile from the customer's POV. */
  private barmanInsideStandFor(station: StationInfo, allBars: readonly StationInfo[]): THREE.Vector2 {
    const sin = Math.sin(station.rotY);
    const cos = Math.cos(station.rotY);
    const front = new THREE.Vector2(station.x + sin, station.z + cos);
    const back  = new THREE.Vector2(station.x - sin, station.z - cos);
    if (allBars.length <= 1) return back; // single bar → barman side = back
    let cx = 0, cz = 0;
    for (const s of allBars) { cx += s.x; cz += s.z; }
    cx /= allBars.length;
    cz /= allBars.length;
    const dFront = Math.hypot(front.x - cx, front.y - cz);
    const dBack  = Math.hypot(back.x  - cx, back.y  - cz);
    return dFront < dBack ? front : back;
  }

  /** Barman loiter spot — prefers their last bar counter, then any
   * bar counter on home floor, then the spawn home. Mirrors
   * pickChefIdleSpot but locked to "bar" stations + uses the
   * centroid-aware "inside" picker so the barman lands BEHIND the
   * bar instead of on the customer side. */
  private pickBarmanIdleSpot(b: StaffActor): THREE.Vector2 {
    return this.snapIdleClear(this.pickBarmanIdleSpotRaw(b), b.homeFloor);
  }
  private pickBarmanIdleSpotRaw(b: StaffActor): THREE.Vector2 {
    const jitter = (v: THREE.Vector2): THREE.Vector2 => {
      v.x += (Math.random() - 0.5) * 1.2;
      v.y += (Math.random() - 0.5) * 0.8;
      return v;
    };
    if (!this.getCookStations) return b.home.clone();
    const bars = this.getCookStations()
      .filter((s) => s.provides === "bar" && s.floor === b.homeFloor);
    if (bars.length === 0) {
      b.lastStoveUid = null;
      return b.home.clone();
    }
    let pickStation = bars[0];
    if (b.lastStoveUid) {
      const last = bars.find((s) => s.uid === b.lastStoveUid);
      if (last) pickStation = last;
      else b.lastStoveUid = null;
    }
    return jitter(this.barmanInsideStandFor(pickStation, bars));
  }

  /** Walk a list of candidate queued tickets and start cooking the
   * first one whose required station is free (or whose required
   * appliance is "stove" and no stoves are placed — degenerate
   * fallback to the legacy stovePos). Returns true when a cook was
   * started, false when nothing in the list could be claimed.
   *
   * Shared by the idle-pickup and returningHome-interrupt paths so
   * both behave identically when the queue head is uncookable: skip
   * to the next candidate instead of giving up. Without iteration,
   * one toaster-needs-no-toaster ticket at position 0 would freeze
   * the chef even when position 1's stove ticket was ready to go. */
  private tryClaimCookForChef(c: StaffActor, candidates: readonly Ticket[], allowCrossFloor = false): boolean {
    for (const ticket of candidates) {
      const needed = ticket.appliance || "stove";
      const station = this.claimFreeStation(needed, c.homeFloor, c.character.groundPos, allowCrossFloor);
      let target: THREE.Vector2;
      // Default the target floor to the chef's home — covers both the
      // same-floor station path AND the legacy stovePos fallback.
      // Cross-floor stations override below.
      let targetFloor = c.homeFloor;
      if (station) {
        c.assignedStoveUid = station.uid;
        target = this.chefStandPosFor(station);
        // Critical for cross-floor cooking: the pathfinder reads
        // targetFloor to know which storey the destination lives on.
        // Without this update a chef on Floor 0 claiming a Floor 1
        // station would pathfind to a (x,z) coord on Floor 0 (target
        // floor stale = homeFloor), arrive at the wrong storey, and
        // enter "working" state without actually being at the
        // station. ticket.pickupFloor would then inherit that wrong
        // floor and the waiter would walk to nothing. Caught by
        // post-5c92e96 audit.
        targetFloor = station.floor;
      } else if (needed === "stove" && this.getStoves && this.getStoves().length === 0) {
        // No stoves placed AND the recipe needs stove — fall back to
        // the legacy shared cooking spot so the kitchen still
        // functions in a degenerate "no appliance" save. No
        // reservation possible here; multiple chefs may pile on.
        c.assignedStoveUid = null;
        target = this.stovePos.clone();
      } else {
        // Matching station exists but all are busy, OR the player
        // hasn't built the appliance this recipe needs. Try the next
        // candidate.
        continue;
      }
      ticket.state = "cooking";
      ticket.clock = 0;
      const chefMult = this.getChefCookMultiplier?.(c.memberId) ?? 1;
      ticket.cookSeconds = Math.max(1, ticket.baseCookSeconds * chefMult);
      this.mirrorTicketClaim(ticket, c.memberId);
      c.ticketId = ticket.id;
      c.target = target;
      c.targetFloor = targetFloor;
      this.planPath(c);
      c.state = "movingToWork";
      c.clock = 0;
      c.character.action = "walk";
      c.homeWorkWaitClock = 0;
      console.log(`[Router] chef picked up ${ticket.id} (${needed}) → walking to ${station ? `${station.provides} ${station.uid} (F${station.floor})` : "fallback stovePos"} (mult ${chefMult.toFixed(2)})`);
      return true;
    }
    return false;
  }

  /** Release the chef's stove reservation and remember it as their
   * last-used stove for loiter targeting. Safe to call when the chef
   * was on the fallback stovePos (no assignment to clear). */
  private releaseStove(c: StaffActor): void {
    if (c.assignedStoveUid) {
      this.busyStoveUids.delete(c.assignedStoveUid);
      c.lastStoveUid = c.assignedStoveUid;
      c.assignedStoveUid = null;
    }
  }

  // === Waiter state machine ===

  /** Shared "begin delivery" transition — used by both the idle work
   * picker and the returningHome interrupt. Moves the ticket to
   * 'delivering', targets the pickup spot (always Floor 0 — the
   * kitchen lives there), and flips the waiter into movingToWork. */
  private startWaiterDelivery(w: StaffActor, ticket: Ticket): void {
    ticket.state = "delivering";
    ticket.clock = 0;
    this.mirrorTicketPickup(ticket);
    w.ticketId = ticket.id;
    // Walk to the SPECIFIC station the cook stood at when they marked
    // the ticket ready — for bar drinks that's the bar counter, for
    // regular dishes that's wherever the chef cooked. Falls back to
    // the legacy fixed pickupPos if the ticket somehow has no
    // pickupPos (defensive — every ready-transition sets it now).
    const pickupPos = ticket.pickupPos ?? this.pickupPos;
    const pickupFloor = ticket.pickupFloor ?? 0;
    // Clamp the pickup target INSIDE the building before pathing. The raw
    // pickup pos is the chef's spot at the station; for a station against an
    // outer wall, planPath's snapToClear can land the waiter on a "clear" cell
    // BEYOND the wall (the nav grid reads empty outdoor tiles as clear), which
    // strands him on the floor edge over the gap — exactly the waiter seen
    // hanging off the upper floor. snapIdleClear clamps the anchor FIRST so the
    // snap searches inward to a real walkable cell (the same dual-clamp the
    // idle/home targets already get).
    w.target = this.snapIdleClear(pickupPos.clone(), pickupFloor);
    w.targetFloor = pickupFloor;
    this.planPath(w);
    w.state = "movingToWork";
    w.clock = 0;
    w.character.action = "walk";
    w.homeWorkWaitClock = 0;
    console.log(`[Router] waiter picked up ${ticket.id} (seatFloor=${ticket.seatFloor}, homeFloor=${w.homeFloor}, pickupFloor=${pickupFloor}) → walking to pickup`);
  }

  /** True if any waiter currently in the "idle" state has the given
   * floor as their homeFloor (and isn't `exclude`). Used in the
   * cross-floor fallback to STOP a non-home waiter from poaching
   * work the home-floor waiter is about to claim on their own tick.
   * Without this, tick order in the for-loop decides who wins the
   * race, which is exactly the "Floor-1 waiter took the Floor-0
   * order while a Floor-0 waiter sat idle" bug. */
  private hasIdleHomeWaiter(floor: number, exclude: StaffActor): boolean {
    for (const other of this.waiters) {
      if (other === exclude) continue;
      if (other.state !== "idle") continue;
      if (other.homeFloor !== floor) continue;
      return true;
    }
    return false;
  }

  /** Chef pool variant of hasIdleHomeWaiter. Same race fix — a
   * Floor-1 chef whose wait clock crossed CROSS_FLOOR_WAIT_SECONDS
   * shouldn't grab a Floor-0 ticket when a Floor-0 chef is idle. */
  private hasIdleHomeChef(floor: number, exclude: StaffActor): boolean {
    for (const other of this.chefs) {
      if (other === exclude) continue;
      if (other.state !== "idle") continue;
      if (other.homeFloor !== floor) continue;
      return true;
    }
    return false;
  }

  /** Sort an array of guest-bearing work items (tickets, order
   * requests) by remaining customer PATIENCE ascending — lowest
   * patience comes first. Used by every "pick the next thing to
   * work on" call site so a Quick Lunch with 5s of patience left
   * beats a Foodie with 60s left, regardless of which order was
   * enqueued first. Items whose guest has vanished (despawn race)
   * sort to the END so they never starve a real customer. */
  private sortByUrgency<T extends { guestId: string }>(items: readonly T[]): T[] {
    if (!this.getGuestPatience) return items.slice();
    return items.slice().sort((a, b) => {
      const pa = this.getGuestPatience!(a.guestId) ?? Infinity;
      const pb = this.getGuestPatience!(b.guestId) ?? Infinity;
      return pa - pb;
    });
  }

  /** Pick a "rest spot" for an idle waiter.
   *   - If they're already on their home floor, they STAY IN PLACE
   *     (current ground position) — no pointless trek back to their
   *     spawn point every time a delivery finishes.
   *   - If they're on a different floor (just finished cross-floor
   *     work), they drift back to the stair landing on their home
   *     floor. Random jitter prevents multiple waiters from stacking
   *     on the exact same landing tile.
   * Returns the {pos, floor} pair callers feed into target +
   * targetFloor + planPath. */
  private pickWaiterIdleSpot(w: StaffActor): { pos: THREE.Vector2; floor: number } {
    const r = this.pickWaiterIdleSpotRaw(w);
    return { pos: this.snapIdleClear(r.pos, r.floor), floor: r.floor };
  }
  private pickWaiterIdleSpotRaw(w: StaffActor): { pos: THREE.Vector2; floor: number } {
    // Phase I (H.68) — player-pinned rest spot.  Reads the current
    // cloud value (null if unset).  When set, ALL waiters target the
    // same spot; small per-waiter jitter avoids them landing on the
    // exact same tile and t-posing through each other (PersonalSpace
    // already pushes them apart but the jitter reads more natural).
    //
    // The spot may live on a different floor than the waiter is
    // currently on — that's fine, the returningHome state machine
    // already handles cross-floor traversal via the stairs.
    const rest = this.cloud?.getWaiterRestSpot();
    if (rest) {
      const pos = new THREE.Vector2(
        rest.x + (Math.random() - 0.5) * 0.8,
        rest.z + (Math.random() - 0.5) * 0.8,
      );
      return { pos, floor: rest.floor };
    }
    // Idle by the SERVICE area so the waiter waits next to its next pickup:
    // anchor at a bar counter on the home floor (stands by the barman), else
    // any cook station, else a stove. Jitter spreads multiple waiters; the
    // wrapper then snaps the result to the nearest FREE tile, so they land on
    // the closest open tiles around the bar/kitchen — NOT inside it, and not
    // on the old fixed z=-1 spawn home an appliance may have been placed on.
    // The returningHome state machine handles any stair descent to homeFloor.
    const floor = w.homeFloor;
    const station =
      this.getCookStations?.().find((s) => s.provides === "bar" && s.floor === floor)
      ?? this.getCookStations?.().find((s) => s.floor === floor)
      ?? this.getStoves?.().find((s) => s.floor === floor);
    if (station) {
      const pos = new THREE.Vector2(
        station.x + (Math.random() - 0.5) * 1.8,
        station.z + (Math.random() - 0.5) * 1.8,
      );
      return { pos, floor };
    }
    // No stations on this floor — stay where we are (snapped to a clear tile).
    return { pos: w.character.groundPos.clone(), floor };
  }

  /** Shared "begin take-order trip" transition — claim the request
   * (so two waiters don't race for the same seat), point the waiter
   * at the guest's seat, and flip into movingToWork. The dwell +
   * callback fires later in working state. */
  private startWaiterTakeOrder(w: StaffActor, req: OrderRequest): void {
    req.claimedBy = w.memberId;
    w.takeOrderRequest = req;
    w.target = req.seatPos.clone();
    w.targetFloor = req.seatFloor;
    this.planPath(w);
    w.state = "movingToWork";
    w.clock = 0;
    w.character.action = "walk";
    w.homeWorkWaitClock = 0;
    console.log(`[Router] waiter taking order from ${req.guestId} (floor ${req.seatFloor})`);
  }

  /** Shared "begin wash trip" transition — used by the idle picker
   * and (potentially) the returningHome interrupt. */
  private startWaiterWashTrip(w: StaffActor, trip: WashTrip): void {
    w.washTrip = trip;
    w.target = trip.dirtyPos.clone();
    w.targetFloor = trip.dirtyFloor;
    this.planPath(w);
    w.state = "movingToWork";
    w.clock = 0;
    w.character.action = "walk";
    w.homeWorkWaitClock = 0;
  }

  private tickWaiter(w: StaffActor, dt: number): void {
    w.clock += dt;

    switch (w.state) {
      case "idle": {
        // Waiter work selection priority (top to bottom):
        //   1. Home-floor READY ticket → deliver (food is cooling)
        //   2. Home-floor pending ORDER REQUEST → take order (seated
        //      customer waiting to order; patience already ticking)
        //   3. Home-floor DIRTY plate → wash trip (inventory)
        //   4. Home-floor pipeline (queued/cooking ticket) → stay put.
        //      Don't cross to another floor when our own kitchen is
        //      about to hand us food.
        //   5. After CROSS_FLOOR_WAIT_SECONDS of TRULY nothing local,
        //      consider cross-floor work in the same delivery →
        //      take-order → wash order.
        // Waiter skips bar-seat work — the barman handles the entire
        // round trip for customers sitting at the bar counter.
        // Pick the MOST-IMPATIENT eligible ticket / order request
        // (X3 — lowest remaining patience wins, not oldest enqueued).
        //
        // Phase H Phase 1 — when server owns ticket dispatch, the
        // ready→delivering decision is server-side
        // (auto_assign_ready_tickets). Skip the local pickup branch;
        // the bridge transitions the waiter to movingToWork when the
        // server picks them. Take-order trips + wash trips stay local
        // because those subsystems aren't in Phase 1.
        const serverPickup = this.serverOwnsTicketDispatch();
        const homeTicket = serverPickup ? undefined : this.sortByUrgency(this.tickets.filter((t) =>
          t.state === "ready" && t.seatFloor === w.homeFloor && !t.seatAtBar))[0];
        if (homeTicket) {
          this.startWaiterDelivery(w, homeTicket);
          break;
        }
        // Phase H Phase 4 — when server owns dispatch, take-order
        // selection runs via try_dispatch_take_order; the bridge
        // transitions the waiter when the server picks one. Skip the
        // local picker so we don't race.
        const homeOrderReq = serverPickup ? undefined : this.sortByUrgency(this.orderRequests.filter((o) =>
          o.claimedBy === null && o.seatFloor === w.homeFloor && !o.atBar))[0];
        if (homeOrderReq) {
          this.startWaiterTakeOrder(w, homeOrderReq);
          break;
        }
        // Phase H Phase 4w — when server owns dispatch, the
        // try_dispatch_wash_trip server tick picks the waiter +
        // station; the bridge synthesizes the local WashTrip when
        // the staff_actor row's wash_target_uid lands. Skip the
        // local picker so we don't race.
        const homeTrip = serverPickup ? null : this.tryStartWashTrip(w, w.homeFloor);
        if (homeTrip) {
          this.startWaiterWashTrip(w, homeTrip);
          break;
        }
        // Is there future home-floor work coming our way? (queued or
        // cooking ticket on our floor, or an unclaimed order request).
        // If yes, stay put — we'll grab it the moment it's ready.
        const homePipeline =
          this.tickets.some((t) => t.seatFloor === w.homeFloor && (t.state === "queued" || t.state === "cooking"));
        if (homePipeline) {
          // Reset the cross-floor wait so a brief 'pipeline gap' just
          // before the next batch arrives doesn't bleed into the
          // cross-floor fallback timer.
          w.homeWorkWaitClock = 0;
          break;
        }
        // Genuinely nothing local. Tick the wait clock and only fall
        // back to cross-floor work once it crosses the threshold.
        w.homeWorkWaitClock += dt;
        if (w.homeWorkWaitClock < CROSS_FLOOR_WAIT_SECONDS) break;
        // Cross-floor fallback — same priority order as home, and same
        // bar-seat exclusion (bar work is barman-only, never waiter).
        // NEW: skip any cross-floor candidate where an idle home-floor
        // waiter exists. Without this, a Floor-1 waiter whose wait
        // clock crossed 2s while everything was quiet POACHES the
        // first Floor-0 ticket that lands, even though a Floor-0
        // waiter standing right next to the customer was about to
        // claim it on their own idle tick. Tick order is insertion-
        // order, so whoever was hired first wins races — the poach
        // happens any time the cross-floor waiter ticks BEFORE the
        // home-floor one in the array.
        const anyTicket = serverPickup ? undefined : this.sortByUrgency(this.tickets.filter((t) =>
          t.state === "ready" && !t.seatAtBar && !this.hasIdleHomeWaiter(t.seatFloor, w)))[0];
        if (anyTicket) {
          this.startWaiterDelivery(w, anyTicket);
          break;
        }
        const anyOrderReq = serverPickup ? undefined : this.sortByUrgency(this.orderRequests.filter((o) =>
          o.claimedBy === null && !o.atBar && !this.hasIdleHomeWaiter(o.seatFloor, w)))[0];
        if (anyOrderReq) {
          this.startWaiterTakeOrder(w, anyOrderReq);
          break;
        }
        const anyTrip = serverPickup ? null : this.tryStartWashTrip(w);
        if (anyTrip) {
          this.startWaiterWashTrip(w, anyTrip);
        }
        break;
      }
      case "movingToWork": {
        this.moveActor(w, dt);
        // Take-order trips stop SHORT of the seat (ORDER_STAND_DISTANCE) so the
        // waiter stands BESIDE the seated guest rather than walking onto / into
        // them; every other trip arrives right at the target tile.
        const arriveDist = w.takeOrderRequest ? ORDER_STAND_DISTANCE : ARRIVAL_THRESHOLD;
        if (this.distance(w.character.groundPos, w.target) < arriveDist) {
          // Take-order trip reinterprets movingToWork → "walking to
          // seated guest". On arrival, turn to face the guest (the seat is
          // w.target; GLB forward = -Z), then enter the dwell state; working
          // handles the timer + callback.
          if (w.takeOrderRequest) {
            const dx = w.target.x - w.character.groundPos.x;
            const dz = w.target.y - w.character.groundPos.y;
            if (dx * dx + dz * dz > 1e-6) w.character.facingY = Math.atan2(-dx, -dz);
            w.character.action = "idle"; // "standing beside the guest"
            w.state = "working";
            w.clock = 0;
            break;
          }
          // Phase 9.45 — clean trip reinterprets movingToWork → "walking
          // to the dirty seat". On arrival enter the bussing dwell;
          // completion is server-driven (bridge release clears it). This
          // MUST precede the serve-flow fallback below, which would send
          // a ticket-less actor straight home.
          if (w.cleanSeatUid) {
            w.character.action = "idle"; // "clearing the table"
            w.state = "working";
            w.clock = 0;
            break;
          }
          // Wash trips reinterpret movingToWork — same shared walking
          // code, branch on whether we're heading to a dirty pickup or
          // to the wash station after picking up.
          if (w.washTrip) {
            if (w.washTrip.phase === "pickup") {
              // Reached the dirty table. "Pick up" by removing the mesh
              // from the world, then walk to the station carrying it.
              const removed = this.washCallbacks?.pickupDirty(w.washTrip.dirtyId);
              if (!removed) {
                // Mesh disappeared between claim and arrival (e.g. a
                // save reload). Bail out cleanly.
                this.abandonWashTrip(w);
                break;
              }
              // H.95 — Also "pick up" all batched extras. Their
              // visual meshes vanish at the same moment (visually
              // the waiter scoops nearby plates as they pass). If
              // any extra's mesh is already gone (mid-wash race),
              // skip it but keep the rest of the trip going.
              if (w.washTrip.extraDirtyIds.length > 0) {
                const survivingExtras: number[] = [];
                for (const id of w.washTrip.extraDirtyIds) {
                  if (this.washCallbacks?.pickupDirty(id)) {
                    survivingExtras.push(id);
                  }
                }
                w.washTrip.extraDirtyIds = survivingExtras;
              }
              // Show the held-plate mesh as a "carrying dirty" cue.
              if (!w.heldPlate) {
                w.heldPlate = makePlate();
                w.character.root.add(w.heldPlate);
              }
              w.heldPlate.visible = true;
              w.character.action = "carry";
              w.washTrip.phase = "wash";
              w.target = w.washTrip.stationPos.clone();
              // Target the station's floor — pickup may have been on
              // a different storey than the station (e.g. Floor 1
              // dirty plate carried down to a Floor 0 dishwasher).
              w.targetFloor = w.washTrip.stationFloor;
              this.planPath(w);
              break; // stay in movingToWork
            }
            // Reached the wash station — start the dwell timer.
            w.state = "working";
            w.clock = 0;
            break;
          }
          // Serve flow: arrived at the chef pickup.
          const ticket = this.tickets.find((t) => t.id === w.ticketId);
          if (!ticket) {
            w.target = this.pickWaiterIdleSpot(w).pos;
            w.targetFloor = w.homeFloor;
            this.planPath(w);
            w.state = "returningHome";
            w.character.action = "walk";
            w.ticketId = null;
            w.clock = 0;
            break;
          }
          // Picked up the plate — now head to the seat. carry pose reads
          // as holding something while walking. Mount + show the held-
          // plate mesh so the player sees the food in transit.
          w.character.action = "carry";
          if (!w.heldPlate) {
            w.heldPlate = makePlate();
            w.character.root.add(w.heldPlate);
          }
          w.heldPlate.visible = true;
          w.target = ticket.seatPos.clone();
          // Delivery target floor = seat's storey. The path planner
          // will walk to the staircase, ride up, and emerge near the
          // seat on the upper slab when the ticket lives upstairs.
          w.targetFloor = ticket.seatFloor;
          this.planPath(w);
          w.state = "working";
          w.clock = 0;
        }
        break;
      }
      case "working": {
        // Take-order dwell — wait TAKE_ORDER_DWELL_SECONDS at the
        // seated guest's table, then fire the spawner's callback so it
        // builds the recipe list + enqueues the cooking ticket.
        if (w.takeOrderRequest) {
          // Phase H Phase 4b — when server owns dispatch, the
          // bridge's release case handles the trip completion (sets
          // waiter to returningHome when staff_actor.take_order_guest_id
          // is cleared server-side). Skipping the local dwell-complete
          // callback prevents a double-enqueue: server's
          // auto_place_next_course fires when guest hits
          // waitingForFood, and a local takeOrderCallback would
          // ALSO call enqueueOrder via the spawner.
          if (this.serverOwnsTicketDispatch()) break;
          if (w.clock >= TAKE_ORDER_DWELL_SECONDS) {
            const req = w.takeOrderRequest;
            this.takeOrderCallback?.(req.guestId);
            // Remove the request from the queue — spawner may have
            // already done it inside the callback, but a defensive
            // splice keeps the queue clean if the callback's wiring
            // is missing or the guest left before the splice.
            const reqIdx = this.orderRequests.findIndex((o) => o.guestId === req.guestId);
            if (reqIdx >= 0) this.orderRequests.splice(reqIdx, 1);
            w.takeOrderRequest = null;
            w.target = this.pickWaiterIdleSpot(w).pos;
            w.targetFloor = w.homeFloor;
            this.planPath(w);
            w.state = "returningHome";
            w.character.action = "walk";
            w.clock = 0;
          }
          break;
        }
        if (w.washTrip) {
          // Dwelling at the wash station. Two paths split here:
          //   SINK: dwell is the full scrub time. When it ends the
          //     piece goes straight to the clean pool (washOne picks
          //     the tier from the global dirty pool).
          //   DISHWASHER: dwell is the brief "load and leave" time.
          //     The piece gets pushed into that dishwasher's batch
          //     state; DishwareSystem.update finishes the wash in the
          //     background. Multiple waiters can use the same
          //     dishwasher back-to-back since they only dwell for
          //     half a second each.
          if (w.clock >= w.washTrip.dwell) {
            const trip = w.washTrip;
            const isDishwasher = trip.stationDefId.startsWith("dishwasher");
            // H.95 — Total pieces to deposit at this station =
            // primary + extras the waiter scooped up at pickup.
            const totalPieces = 1 + trip.extraDirtyIds.length;
            if (isDishwasher) {
              // The carried dirty piece(s) were already removed from
              // the world by pickupDirty. Each loadDishwasher call
              // moves one piece from pool[dirty] into the batch. If
              // loadDishwasher fails (batch filled up between trip-
              // start and arrival, or the dishwasher was sold mid-
              // walk), fall back to washOne so the piece still
              // becomes clean ("waiter dumped it in the sink on the
              // way past"). Without this fallback, the loaded dish
              // would silently leak from the inventory.
              // Phase 9.6 — inventory motion is server-side now (the
              // drop-completion in tick_wash_trip washes the pieces);
              // local loads would double-clean. Visual-only here.
              let loadedCount = 0;
              if (!isServerSim("dishware")) {
                for (let i = 0; i < totalPieces; i++) {
                  const ok = this.washCallbacks?.loadDishwasher(trip.stationUid, trip.stationDefId, trip.kind) ?? false;
                  if (ok) {
                    loadedCount++;
                  } else {
                    this.dishwareLogger?.(`dishwasher-load-failed kind=${trip.kind} uid=${trip.stationUid} (piece ${i + 1}/${totalPieces}) → washOne fallback`);
                    this.washCallbacks?.washOne(trip.kind);
                  }
                }
                if (loadedCount < totalPieces) {
                  this.dishwareLogger?.(`batch-trip partial: ${loadedCount}/${totalPieces} into dishwasher, rest sink-fallback`);
                }
              }
              // Dishwashers don't lock — clearing busyWashUids is a
              // safety net for legacy code paths that may still have
              // claimed it.
              this.busyWashUids.delete(trip.stationUid);
            } else {
              // Sink path: scrub each carried piece into clean.
              for (let i = 0; i < totalPieces; i++) {
                this.washCallbacks?.washOne(trip.kind);
              }
              this.busyWashUids.delete(trip.stationUid);
            }
            if (w.heldPlate) w.heldPlate.visible = false;
            w.washTrip = null;
            w.target = this.pickWaiterIdleSpot(w).pos;
            w.targetFloor = w.homeFloor;
            this.planPath(w);
            w.state = "returningHome";
            w.character.action = "walk";
            w.clock = 0;
          }
          break;
        }
        // Phase 9.45 — clean-trip bussing dwell. Completion is server-
        // authoritative: the bridge's release case flips us to
        // returningHome the moment the server clears clean_seat_uid
        // (after deleting the pile rows). So under server dispatch we
        // just hold the pose and wait; the SEAT_CLEAN_FALLBACK timer
        // only fires if that release never arrives (disconnect), so a
        // waiter can never freeze mid-bus.
        if (w.cleanSeatUid) {
          if (this.serverOwnsTicketDispatch() && w.clock < SEAT_CLEAN_FALLBACK_SECONDS) {
            break;
          }
          w.cleanSeatUid = null;
          w.target = this.pickWaiterIdleSpot(w).pos;
          w.targetFloor = w.homeFloor;
          this.planPath(w);
          w.state = "returningHome";
          w.character.action = "walk";
          w.clock = 0;
          break;
        }
        // Serve flow: walking the plate to the seat.
        this.moveActor(w, dt);
        if (this.distance(w.character.groundPos, w.target) < ARRIVAL_THRESHOLD) {
          const ticket = this.tickets.find((t) => t.id === w.ticketId);
          if (ticket) {
            ticket.state = "delivered";
            this.mirrorTicketDeliver(ticket);
          }
          if (w.heldPlate) w.heldPlate.visible = false;
          w.target = this.pickWaiterIdleSpot(w).pos;
          w.targetFloor = w.homeFloor;
          this.planPath(w);
          w.state = "returningHome";
          w.character.action = "walk";
          w.ticketId = null;
          w.clock = 0;
        }
        break;
      }
      case "returningHome": {
        // Mid-return interrupt: home-floor ticket just became ready —
        // skip the walk-back-then-walk-out round trip and start the
        // delivery NOW. Same idea for a freshly-seated guest waiting
        // to order: starting the take-order now instead of after the
        // home loop saves several seconds of customer wait time.
        //
        // Phase H Phase 1 — when server owns ticket dispatch, the
        // server's auto_assign_ready_tickets handles waiter-pickup
        // selection. Skipping the local interrupt-deliver means the
        // waiter walks home before being eligible for the next ticket.
        const interruptTicket = this.serverOwnsTicketDispatch()
          ? undefined
          : this.sortByUrgency(this.tickets.filter((t) =>
            t.state === "ready" && t.seatFloor === w.homeFloor && !t.seatAtBar))[0];
        if (interruptTicket) {
          this.startWaiterDelivery(w, interruptTicket);
          break;
        }
        const interruptOrder = this.serverOwnsTicketDispatch()
          ? undefined
          : this.sortByUrgency(this.orderRequests.filter((o) =>
            o.claimedBy === null && o.seatFloor === w.homeFloor && !o.atBar))[0];
        if (interruptOrder) {
          this.startWaiterTakeOrder(w, interruptOrder);
          break;
        }
        // W5 — also interrupt for a nearby home-floor wash trip.
        // Without this a dirty plate two tiles from the returning
        // waiter got ignored until they reached home and ticked
        // idle. Same urgency rank (we use best-pair selection),
        // just no patience-sort since wash trips aren't guest-
        // attached.
        const interruptWash = this.serverOwnsTicketDispatch()
          ? null
          : this.tryStartWashTrip(w, w.homeFloor);
        if (interruptWash) {
          this.startWaiterWashTrip(w, interruptWash);
          break;
        }
        this.moveActor(w, dt);
        if (this.distance(w.character.groundPos, w.target) < ARRIVAL_THRESHOLD) {
          w.character.action = "idle";
          w.state = "idle";
          w.clock = 0;
        }
        break;
      }
    }
  }

  /** Try to start a wash trip for this idle waiter. Picks the
   * (dirty, station) PAIR that minimises TOTAL walking distance
   * (W6 — old code picked nearest dirty and nearest station
   * independently, which could miss a much better pair like
   * "farther dirty next to its own perfect station"). Iterates
   * pairs in best-first order and retries on claim failure so a
   * tick-race with another waiter for the same dirty just moves
   * on to the next-best pair (W4 — old code returned null and
   * the waiter sat idle).
   *
   * Returns null when no callbacks are wired, no dirty plates
   * exist, no free station exists, or every candidate pair lost
   * the claim race. */
  private tryStartWashTrip(w: StaffActor, restrictToFloor?: number): WashTrip | null {
    if (!this.washCallbacks) return null;
    const allStations = this.washCallbacks.getWashStations();
    if (allStations.length === 0) return null;
    const allDirties = this.washCallbacks.getDirtyPickups();
    if (allDirties.length === 0) return null;
    // Optional floor restriction — used by the idle handler to prefer
    // home-floor work before falling back to cross-floor. With it set,
    // both the dirty piece AND the station must live on the same floor
    // so the waiter handles the whole trip without crossing a stair.
    const dirties = restrictToFloor === undefined
      ? allDirties
      : allDirties.filter((d) => d.floor === restrictToFloor);
    if (dirties.length === 0) return null;
    const stations = restrictToFloor === undefined
      ? allStations
      : allStations.filter((s) => s.floor === restrictToFloor);
    if (stations.length === 0) return null;
    const here = w.character.groundPos;
    // Build every viable (dirty, station) pair with its total
    // walking cost = waiter→dirty + dirty→station. Skip pairs
    // where the station can't accept this dirty's kind (full
    // dishwasher) or is already locked (busy sink).
    interface Pair { dirty: DirtyPickupInfo; station: WashStationInfo; total: number; }
    const pairs: Pair[] = [];
    for (const d of dirties) {
      const waiterToDirty = Math.hypot(d.pos.x - here.x, d.pos.y - here.y);
      for (const s of stations) {
        const isDishwasher = s.defId.startsWith("dishwasher");
        if (isDishwasher) {
          if (!this.washCallbacks.canDishwasherLoad(s.uid, d.kind)) continue;
        } else {
          if (this.busyWashUids.has(s.uid)) continue;
        }
        const dirtyToStation = Math.hypot(s.standPos.x - d.pos.x, s.standPos.y - d.pos.y);
        pairs.push({ dirty: d, station: s, total: waiterToDirty + dirtyToStation });
      }
    }
    if (pairs.length === 0) return null;
    // Best-first iteration: try to claim the lowest-total pair
    // first. On dirty-claim failure (another waiter beat us to it
    // in the same frame), skip and try the next-lowest pair.
    pairs.sort((a, b) => a.total - b.total);
    for (const pair of pairs) {
      if (!this.washCallbacks.claimDirtyPickup(pair.dirty.id, w.memberId)) continue;
      // Dishwashers stay unclaimed — capacity already enforces the
      // limit; sinks get the busy-set claim so a second waiter
      // doesn't queue up at the same basin.
      const isSink = !pair.station.defId.startsWith("dishwasher");
      const isDishwasher = !isSink;
      if (isSink) this.busyWashUids.add(pair.station.uid);

      // H.95 — Opportunistically claim additional nearby dirties
      // of the SAME KIND, same floor, within WASH_BATCH_RADIUS of
      // the primary. Cap at WASH_MAX_CARRY total. For dishwashers
      // we also gate on per-piece capacity — claiming 4 plates
      // when the target only has room for 2 would strand the
      // overflow. Sinks are unbounded so we always claim up to the
      // tray cap there.
      const extraIds: number[] = [];
      let capacityBudget = isDishwasher
        ? this.washCallbacks.canDishwasherLoadN(pair.station.uid, pair.dirty.kind, WASH_MAX_CARRY)
        : WASH_MAX_CARRY;
      // The primary itself uses one capacity slot.
      capacityBudget = Math.max(0, capacityBudget - 1);
      if (capacityBudget > 0) {
        for (const d of dirties) {
          if (extraIds.length >= capacityBudget) break;
          if (d.id === pair.dirty.id) continue;
          if (d.kind !== pair.dirty.kind) continue;
          if (d.floor !== pair.dirty.floor) continue;
          const dx = d.pos.x - pair.dirty.pos.x;
          const dz = d.pos.y - pair.dirty.pos.y;
          if (dx * dx + dz * dz > WASH_BATCH_RADIUS * WASH_BATCH_RADIUS) continue;
          if (!this.washCallbacks.claimDirtyPickup(d.id, w.memberId)) continue;
          extraIds.push(d.id);
        }
      }

      return {
        dirtyId: pair.dirty.id,
        dirtyPos: pair.dirty.pos.clone(),
        dirtyFloor: pair.dirty.floor,
        kind: pair.dirty.kind,
        extraDirtyIds: extraIds,
        stationUid: pair.station.uid,
        stationDefId: pair.station.defId,
        stationPos: pair.station.standPos.clone(),
        stationFloor: pair.station.floor,
        // H.95 — Slight dwell scale per extra piece so loading 4
        // plates takes a bit longer than 1 (not 4× longer — the
        // bottleneck was always the walk, not the loading itself).
        dwell: pair.station.dwell * (1 + extraIds.length * 0.25),
        phase: "pickup",
      };
    }
    return null;
  }

  /** Release any in-flight wash claims and reset the waiter to
   * returningHome. Used when the dirty mesh vanished between claim and
   * arrival (e.g. save reload), or when the waiter was just fired. */
  private abandonWashTrip(w: StaffActor): void {
    if (w.washTrip) {
      this.washCallbacks?.releaseDirtyPickup(w.washTrip.dirtyId);
      // H.95 — Release any extras claimed alongside the primary so
      // another waiter can pick them up. Without this, a bailed
      // trip would leave nearby dirties claimed-but-untouched
      // until a save reload.
      for (const id of w.washTrip.extraDirtyIds) {
        this.washCallbacks?.releaseDirtyPickup(id);
      }
      this.busyWashUids.delete(w.washTrip.stationUid);
      w.washTrip = null;
    }
    if (w.heldPlate) w.heldPlate.visible = false;
    w.target = this.pickWaiterIdleSpot(w).pos;
    w.targetFloor = w.homeFloor;
    this.planPath(w);
    w.state = "returningHome";
    w.character.action = "walk";
    w.clock = 0;
  }

  // === Shared movement ===

  private moveActor(a: StaffActor, dt: number): void {
    const pos = a.character.groundPos;
    // Path-driven movement — walk toward the next waypoint, advance
    // when it's reached, and fall back to direct movement against
    // a.target when no path is set.
    if (a.path.length === 0 && this.distance(pos, a.target) >= ARRIVAL_THRESHOLD) {
      // Re-plan if we lost our path mid-step (e.g. obstacles changed
      // mid-frame). Cheap and self-correcting.
      this.planPath(a);
    }
    // Periodic replan: a path was computed at state-transition time
    // and stays cached until the actor reaches its target. If the
    // player drops a wall or table in the middle of that path, the
    // cached waypoints take the actor straight through it. Re-plan
    // every ~0.8s while in motion so a fresh obstacle is picked up
    // within one second. Cheap (sub-ms over a 10×10 grid) and only
    // runs while actually walking somewhere.
    a.replanAccum += dt;
    // Don't replan mid-stair — the next waypoint is the stair landing on
    // the upper floor and currentFloor hasn't promoted yet, so a fresh
    // findMultiFloorPath from the actor's mid-stair XZ at the OLD floor
    // would route them BACK to the stair entry and create an endless
    // south-then-north loop on the steps. Once we cross the fromStair
    // waypoint and consume it, currentFloor flips and the next replan
    // works normally.
    const midStair = a.path.length > 0 && a.path[0].fromStair === true;
    if (!midStair && a.replanAccum >= 0.8 && this.distance(pos, a.target) >= ARRIVAL_THRESHOLD) {
      a.replanAccum = 0;
      this.planPath(a);
    }
    // Consume reached waypoints. Stair-end waypoints promote the
    // actor's currentFloor so the body Y anchors to the new slab.
    const STOREY = 3;
    const feetLift = a.character._feetLift ?? 0;
    while (a.path.length > 0 && Math.hypot(a.path[0].x - pos.x, a.path[0].z - pos.y) < PATH_ARRIVAL_THRESHOLD) {
      const consumed = a.path.shift()!;
      a.prevWaypoint = consumed;
      if (consumed.fromStair) {
        a.currentFloor = consumed.floor;
        const anchorY = consumed.floor * STOREY + feetLift;
        a.character.root.position.y = anchorY;
        // Sync _baseY so the animator's per-frame reset doesn't snap
        // the body back to its starting storey on the next tick.
        a.character._baseY = anchorY;
        // Move the model under the new floor's storey group so the
        // storey-focus visibility shows it on the right floor. Without
        // this, a Floor 1 → Floor 0 descent leaves the waiter parented
        // to Floor 1's group (hidden when the player focuses on Floor
        // 0) — they deliver invisibly and the plate appears as if the
        // waiter walked through the ceiling.
        this.reparentCharacter?.(a.character, consumed.floor);
      }
    }
    const wp = a.path[0] ?? { x: a.target.x, z: a.target.y, floor: a.targetFloor };
    const dx = wp.x - pos.x;
    const dz = wp.z - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) {
      const anchorY = a.currentFloor * STOREY + feetLift;
      a.character.root.position.y = anchorY;
      a.character._baseY = anchorY;
      return;
    }
    // Apply this MEMBER's training multiplier (waiter serve speed,
    // for now — chef cook speed is applied to ticket.cookSeconds when
    // they pick up). The getSpeedMultiplier callback returns 1.0 for
    // unknown ids so an unwired actor still moves at base speed.
    const speedMult = this.getSpeedMultiplier?.(a.memberId) ?? 1;
    const step = Math.min(dist, a.speed * speedMult * dt);
    pos.x += (dx / dist) * step;
    pos.y += (dz / dist) * step;
    // Containment clamp — under no circumstance should an indoor
    // staff member's body cross the building wall. Even a momentary
    // stale path or floating-point drift gets pinned back inside.
    if (pos.x < INTERIOR_MIN_X) pos.x = INTERIOR_MIN_X;
    else if (pos.x > INTERIOR_MAX_X) pos.x = INTERIOR_MAX_X;
    if (pos.y < INTERIOR_MIN_Z) pos.y = INTERIOR_MIN_Z;
    else if (pos.y > INTERIOR_MAX_Z) pos.y = INTERIOR_MAX_Z;
    // Stair walk Y — lerp between the previous waypoint's slab anchor
    // and the next waypoint's slab anchor based on XZ progress across
    // the stair span. Slab anchor = floor*STOREY + feetLift (not _baseY,
    // which would double-count any pre-baked homeFloor offset). _baseY
    // is also updated each tick so the animator's reset doesn't snap
    // the body back to its starting storey mid-climb.
    if (wp.fromStair && a.prevWaypoint) {
      const segStartX = a.prevWaypoint.x;
      const segStartZ = a.prevWaypoint.z;
      const segLen = Math.hypot(wp.x - segStartX, wp.z - segStartZ);
      const trav = Math.hypot(pos.x - segStartX, pos.y - segStartZ);
      const t = segLen > 0.01 ? Math.max(0, Math.min(1, trav / segLen)) : 0;
      const startY = a.prevWaypoint.floor * STOREY + feetLift;
      const endY   = wp.floor * STOREY + feetLift;
      const interpY = startY + (endY - startY) * t;
      a.character.root.position.y = interpY;
      a.character._baseY = interpY;
    } else {
      const anchorY = a.currentFloor * STOREY + feetLift;
      a.character.root.position.y = anchorY;
      a.character._baseY = anchorY;
    }
    // GLB default forward is -Z (three.js standard) — confirmed by the
    // seat-slot facing values that demonstrably point customers at the
    // table. For R_y(θ) * (0, 0, -1) to equal the movement vector
    // (dx, 0, dz), we need -sin θ = dx and -cos θ = dz, i.e.
    // θ = atan2(-dx, -dz). Earlier formulas:
    //   atan2(dx, -dz)  → backward in X (east/west reversed)
    //   atan2(-dz, dx)  → 90° crab with right side leading
    // The correct atan2(-dx, -dz) leaves the seat/hardcoded values
    // alone and matches them all to GLB -Z.
    a.character.facingY = Math.atan2(-dx, -dz);
    // Sanity logging — confirms in DevTools that groundPos IS being
    // mutated. Gated because at ~5% per moving actor it floods the
    // console once everyone is working. Flip DEBUG_ROUTER_LOGS at the
    // top of the file if you need to re-verify movement.
    if (DEBUG_ROUTER_LOGS && Math.random() < 0.05) {
      console.log(`[Router/move] ${a.state} now @ (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}), target (${a.target.x.toFixed(2)}, ${a.target.y.toFixed(2)}), step=${step.toFixed(3)}`);
    }
  }

  private distance(a: THREE.Vector2, b: THREE.Vector2): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

function chefLabel(state: StaffActor["state"]): string {
  switch (state) {
    case "movingToWork": return "→ stove";
    case "working":       return "🍳 cooking";
    // Phase 9.28 — returningHome is winding down, not working. Empty
    // label → no status bubble + not counted as "working" on the
    // staff panel (getStaffWorkingCount counts non-empty labels).
    case "returningHome": return "";
    default:              return "";
  }
}

function barmanLabel(b: StaffActor): string {
  switch (b.state) {
    case "movingToWork": return "→ bar";
    case "working":       return "🍸 mixing";
    case "returningHome": return ""; // Phase 9.28 — winding down = idle
    default:              return "";
  }
}

/** Stable diagnostic key for a waiter's current activity — mirrors
 * waiterLabel's branching, consumed by accumulateWaiterActivity. */
function waiterActivityKey(w: StaffActor, carrying: boolean): string {
  switch (w.state) {
    case "movingToWork":
      if (w.takeOrderRequest) return "→ take order";
      if (w.washTrip) return w.washTrip.phase === "pickup" ? "→ grab dirty" : "→ to sink";
      if (w.cleanSeatUid) return "→ clear table";
      return carrying ? "→ serve (carrying)" : "→ fetch dish";
    case "working":
      if (w.takeOrderRequest) return "taking order";
      if (w.washTrip) return "washing";
      if (w.cleanSeatUid) return "clearing table";
      return "serving";
    case "returningHome": return "returning";
    default: return "idle";
  }
}

function waiterLabel(w: StaffActor, carrying: boolean): string {
  // Spell out each of the waiter's jobs — take an order, fetch then serve a
  // dish, bus a dirty table, wash up — so the player can read at a glance
  // what a waiter is doing instead of a bare "pickup" / "serving".
  // Phase M.13 — derive from the SERVER-mirrored task fields so the label
  // matches what a SERVER-DRIVEN waiter is actually doing. The old logic read
  // client-local fields (takeOrderRequest / washTrip) that server waiters
  // never had — so a waiter walking to TAKE AN ORDER mislabeled as "fetch
  // dish", and fetch-vs-serve was guessed from the ticket state (true for
  // BOTH legs) rather than the real delivery leg. Fall back to the local
  // fields for any pure-local-sim path.
  // Phase M.16 — under staffMove (the shipped default) read the SERVER-mirrored
  // fields ONLY. The local fields (takeOrderRequest / washTrip / cleanSeatUid)
  // are maintained by the local sim, which no longer RUNS under staffMove, so
  // they go stale and never clear: a waiter that finished a take-order
  // server-side kept the "📋 taking order" bubble because the stale local
  // takeOrderRequest OR'd it back true even though cloudTakeOrderActive was
  // correctly false (confirmed via live staff_actor: no waiter held a take-order
  // yet one rendered "taking order"). Only consult the local fields on the
  // pure-local-sim path (staffMove off).
  const serverDriven = isServerSim("staffMove");
  const takingOrder = serverDriven ? !!w.cloudTakeOrderActive : (w.cloudTakeOrderActive || !!w.takeOrderRequest);
  const washPhase = (w.cloudWashPhase && w.cloudWashPhase.length > 0)
    ? w.cloudWashPhase
    : (serverDriven ? "" : (w.washTrip ? w.washTrip.phase : ""));
  const washing = washPhase.length > 0;
  const clearing = serverDriven ? !!w.cloudCleanActive : (w.cloudCleanActive || !!w.cleanSeatUid);
  // Real delivery leg: "deliver" = carrying to the seat, "pickup"/null = going
  // to the kitchen to fetch. Fall back to `carrying` only when the server
  // phase isn't mirrored (pure local sim).
  const serving = w.cloudDeliveryPhase != null
    ? w.cloudDeliveryPhase === "deliver"
    : carrying;
  switch (w.state) {
    case "movingToWork":
      if (takingOrder) return "📋 → take order";
      if (washing) return washPhase === "pickup" ? "🧽 → grab dirty dish" : "🧼 → to sink";
      if (clearing) return "🧽 → clear table";
      return serving ? "🍽️ → serve table" : "🍳 → fetch dish";
    case "working":
      if (takingOrder) return "📋 taking order";
      if (washing) return "🧼 washing up";
      if (clearing) return "🧹 clearing table";
      return "🍽️ serving dish";
    // Phase 9.28 — walking back to rest reads as idle: no bubble, not
    // counted as "working" on the panel.
    case "returningHome": return "";
    default:              return "";
  }
}
