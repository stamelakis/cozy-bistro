import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Pathfinding, PathStep } from "./Pathfinding";
import { PATH_ARRIVAL_THRESHOLD } from "./Pathfinding";
import type { DishKind } from "../data/dishwareCatalog";

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
  /** Seconds the chef needs to "cook" before READY (from recipe). */
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
}

/** Snapshot of a dirty piece's id + world position + kind (plate vs
 * glass). The waiter wash loop receives a list of these and picks
 * the closest free one. */
export interface DirtyPickupInfo {
  id: number;
  kind: DishKind;
  pos: THREE.Vector2;
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
}

/** Waiter wash trip state. The waiter walks from idle → pickup the
 * specified dirty piece → wash at the specified station → home. */
interface WashTrip {
  dirtyId: number;
  dirtyPos: THREE.Vector2;
  kind: DishKind;
  stationUid: string;
  /** Catalog id of the wash station ("sink", "dishwasher",
   * "dishwasher-pro"). Drives the dwell-completion branch in the
   * working state — sinks wash immediately, dishwashers load. */
  stationDefId: string;
  stationPos: THREE.Vector2;
  dwell: number;
  phase: "pickup" | "wash";
}

interface StaffActor {
  character: AnimatedCharacter;
  /** Which pool this actor belongs to. Used by moveActor to apply the
   * right training-upgrade speed multiplier. */
  role: "chef" | "waiter";
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
   * to direct movement so the actor still does SOMETHING. */
  path: PathStep[];
  /** Seconds accumulated since the last replan. Drives the periodic
   * re-route in moveActor so a stale path computed before the player
   * placed an obstacle gets refreshed on the next tick — without this,
   * a waiter mid-delivery follows their original waypoints straight
   * through a newly-placed wall or table. */
  replanAccum: number;
  /** Chef only: uid of the stove this chef is currently reserving while
   * cooking. Released on finish/abandon/fire so another chef can take
   * it. null between cooks. */
  assignedStoveUid?: string | null;
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
const WAITER_SPEED = 1.44; // +20% over CHEF_SPEED

/** Flip to true (or rebuild) to log every actor's per-frame movement
 * sample (`[Router/move] state now @ (x, y) target …`). Was on by
 * default while diagnosing "are the chefs actually moving?" — at ~5%
 * sampling per moving actor it dominates the console once everyone's
 * working. Off in production; the once-per-event logs (enqueued, chef
 * picked up, etc.) still fire so you can trace ticket flow without it. */
const DEBUG_ROUTER_LOGS = false;
const ARRIVAL_THRESHOLD = 0.18;

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

  private readonly chefs: StaffActor[] = [];
  private readonly waiters: StaffActor[] = [];

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

  /** Phase C.2 + 7d: reserve the first cook station whose `provides`
   * matches the recipe's required appliance, isn't already busy, AND
   * sits on the chef's home floor. Returns null when no matching
   * station exists or every one of them is busy (the chef stays idle
   * and the ticket waits). Falls back to the legacy stove pool when
   * the requested appliance is "stove" but the cook-stations callback
   * hasn't been wired — keeps the old save-compat path alive. */
  private claimFreeStation(appliance: string, homeFloor = 0): StationInfo | null {
    if (this.getCookStations) {
      for (const s of this.getCookStations()) {
        if (s.provides !== appliance) continue;
        if (s.floor !== homeFloor) continue;
        if (this.busyStoveUids.has(s.uid)) continue;
        this.busyStoveUids.add(s.uid);
        return s;
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

  /** A loiter spot for a chef who isn't cooking right now. If the chef
   * has a remembered last stove (and it's still placed), drift a small
   * random offset around that stove's stand position. Otherwise fall
   * back to their original home. Mirrors the errand helper's
   * pickIdleSpot — keeps chefs near the appliance they're "assigned"
   * to in the player's eyes. */
  private pickChefIdleSpot(c: StaffActor): THREE.Vector2 {
    if (c.lastStoveUid) {
      // Phase C.2: the "last station" might be any cook station, not
      // just a stove. Search the broader cook-stations pool first, fall
      // back to the legacy stove pool so old save state stays valid.
      const fromStations = this.getCookStations?.().find((s) => s.uid === c.lastStoveUid);
      const fromStoves = !fromStations
        ? this.getStoves?.().find((s) => s.uid === c.lastStoveUid)
        : undefined;
      const station = fromStations ?? fromStoves;
      if (station) {
        const base = this.chefStandPosFor(station);
        base.x += (Math.random() - 0.5) * 1.2;
        base.y += (Math.random() - 0.5) * 0.8;
        return base;
      }
      // The station was sold/moved — forget it so we don't keep
      // searching for a ghost next tick.
      c.lastStoveUid = null;
    }
    return c.home.clone();
  }

  /** Recompute the path from the actor's current position to its
   * target. Called whenever the state machine writes a fresh
   * a.target. Falls back to a single direct waypoint when the
   * pathfinder is missing or returns nothing useful. */
  private planPath(a: StaffActor): void {
    if (!this.pathfind) {
      a.path = [a.target.clone()];
      return;
    }
    a.path = this.pathfind.findPath(
      a.character.groundPos.x, a.character.groundPos.y,
      a.target.x, a.target.y,
    );
    if (a.path.length === 0) a.path = [a.target.clone()];
  }

  /** Append a chef to the pool. Their current ground position becomes home. */
  addChef(char: AnimatedCharacter, memberId: string, homeFloor = 0): void {
    this.chefs.push({
      character: char,
      role: "chef",
      memberId,
      homeFloor,
      home: char.groundPos.clone(),
      state: "idle",
      ticketId: null,
      target: char.groundPos.clone(),
      clock: 0,
      speed: CHEF_SPEED,
      path: [],
      replanAccum: 0,
      assignedStoveUid: null,
      lastStoveUid: null,
    });
  }

  addWaiter(char: AnimatedCharacter, memberId: string, homeFloor = 0): void {
    this.waiters.push({
      character: char,
      role: "waiter",
      memberId,
      homeFloor,
      home: char.groundPos.clone(),
      state: "idle",
      ticketId: null,
      target: char.groundPos.clone(),
      clock: 0,
      speed: WAITER_SPEED,
      path: [],
      replanAccum: 0,
      washTrip: null,
    });
  }

  /** Pop a chef out of the pool. Returns the AnimatedCharacter so the
   * caller (Engine) can remove its model from the scene. Prefers idle
   * chefs so we don't strand an in-progress ticket. Returns null if the
   * pool is empty. */
  removeChef(): AnimatedCharacter | null {
    return this.popPreferIdle(this.chefs);
  }
  removeWaiter(): AnimatedCharacter | null {
    return this.popPreferIdle(this.waiters);
  }

  /** Find the AnimatedCharacter wired to a specific HiredStaffMember.id
   * across both pools. Returns null if no actor maps to that id
   * (e.g. the spawn promise hasn't resolved yet). Used by Engine when
   * the player reassigns a member's home floor — the visual model
   * needs to be re-parented + Y-shifted to the new storey. */
  getCharacterByMemberId(id: string): AnimatedCharacter | null {
    for (const pool of [this.chefs, this.waiters]) {
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
    for (const pool of [this.chefs, this.waiters]) {
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
      }
    }
  }

  private popPreferIdle(pool: StaffActor[]): AnimatedCharacter | null {
    if (pool.length === 0) return null;
    const idleIdx = pool.findIndex((a) => a.state === "idle");
    const idx = idleIdx >= 0 ? idleIdx : pool.length - 1;
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
      this.dishwareLogger?.(`staff-removed mid-washTrip(phase=${removed.washTrip.phase}, kind=${removed.washTrip.kind})`);
      if (removed.washTrip.phase === "wash") {
        this.washCallbacks?.washOne(removed.washTrip.kind);
      } else {
        this.washCallbacks?.releaseDirtyPickup(removed.washTrip.dirtyId);
      }
      this.busyWashUids.delete(removed.washTrip.stationUid);
      removed.washTrip = null;
    }
    pool.splice(idx, 1);
    return removed.character;
  }

  getChefCount(): number { return this.chefs.length; }
  getWaiterCount(): number { return this.waiters.length; }

  /** Look up the animated character that represents a specific
   * HiredStaffMember — Engine uses this to anchor floating-text
   * confirmations over the right actor when training completes. */
  findCharacterByMemberId(memberId: string): AnimatedCharacter | null {
    for (const c of this.chefs) if (c.memberId === memberId) return c.character;
    for (const w of this.waiters) if (w.memberId === memberId) return w.character;
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
  snapshotStatus(): { character: AnimatedCharacter; role: "chef" | "waiter"; label: string }[] {
    const out: { character: AnimatedCharacter; role: "chef" | "waiter"; label: string }[] = [];
    for (const c of this.chefs) out.push({ character: c.character, role: "chef", label: chefLabel(c.state) });
    for (const w of this.waiters) out.push({ character: w.character, role: "waiter", label: waiterLabel(w.state) });
    return out;
  }

  /** Called by GuestSpawner when a guest places an order. */
  enqueueOrder(
    guestId: string, recipeId: string, seatPos: THREE.Vector2, cookSeconds: number,
    appliance: string = "stove",
    seatFloor: number = 0,
  ): string {
    const id = `t-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.tickets.push({
      id, guestId, recipeId, state: "queued",
      seatPos: seatPos.clone(), clock: 0, cookSeconds, appliance, seatFloor,
    });
    console.log(`[Router] enqueued ${id} for ${guestId} (${recipeId}@${appliance}, ${cookSeconds}s cook) — ${this.tickets.length} ticket(s) total, ${this.chefs.filter((c) => c.state === "idle").length} idle chef(s)`);
    return id;
  }

  /** GuestSpawner calls this to learn if its ticket has been delivered. */
  popDeliveredFor(guestId: string): boolean {
    const i = this.tickets.findIndex((t) => t.guestId === guestId && t.state === "delivered");
    if (i < 0) return false;
    this.tickets.splice(i, 1);
    return true;
  }

  update(dt: number): void {
    for (const c of this.chefs) this.tickChef(c, dt);
    for (const w of this.waiters) this.tickWaiter(w, dt);
    this.recoverStalledTickets(dt);
    this.logHeartbeatIfDue(dt);
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
    }
  }

  // === Chef state machine ===

  private tickChef(c: StaffActor, dt: number): void {
    c.clock += dt;

    switch (c.state) {
      case "idle": {
        // Phase 7d: a chef only cooks for tickets where the guest sits
        // on this chef's home floor. Until multi-floor pathfinding
        // ships, cooking for a guest on a different storey would mean
        // the chef teleports through walls / floors to the stove and
        // back; cleaner to let an idle chef on the right floor pick it
        // up, or leave the ticket queued until one is hired.
        const ticket = this.tickets.find((t) => t.state === "queued" && t.seatFloor === c.homeFloor);
        if (!ticket) break;
        // Pick a station that provides the recipe's required appliance.
        // The chef defers (stays idle) when no matching station is free,
        // so a recipe that needs the toaster can't get cooked at the
        // stove just because the stove happens to be open. Pre-Phase-C
        // tickets without an appliance default to "stove" — keeps old
        // saves alive while we migrate.
        const needed = ticket.appliance || "stove";
        const station = this.claimFreeStation(needed, c.homeFloor);
        let target: THREE.Vector2;
        if (station) {
          c.assignedStoveUid = station.uid;
          target = this.chefStandPosFor(station);
        } else if (needed === "stove" && this.getStoves && this.getStoves().length === 0) {
          // No stoves placed AND the recipe needs stove — fall back to
          // the legacy shared cooking spot so the kitchen still
          // functions in a degenerate "no appliance" save. No
          // reservation possible here; multiple chefs may pile on.
          c.assignedStoveUid = null;
          target = this.stovePos.clone();
        } else {
          // Matching station exists but all are busy, OR the player
          // hasn't built the appliance this recipe needs (e.g. a
          // counter recipe with no counter placed). Wait it out — the
          // ticket stays queued and the chef stays idle.
          break;
        }
        ticket.state = "cooking";
        ticket.clock = 0;
        // Apply THIS chef's cook-time multiplier on pickup so the
        // timer the kitchen counts down matches the chef who's
        // actually doing the work.
        const chefMult = this.getChefCookMultiplier?.(c.memberId) ?? 1;
        ticket.cookSeconds = Math.max(1, ticket.cookSeconds * chefMult);
        c.ticketId = ticket.id;
        c.target = target;
        this.planPath(c);
        c.state = "movingToWork";
        c.clock = 0;
        c.character.action = "walk";
        console.log(`[Router] chef picked up ${ticket.id} (${needed}) → walking to ${station ? `${station.provides} ${station.uid}` : "fallback stovePos"} (mult ${chefMult.toFixed(2)})`);
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
        if (!ticket) { // guest left, abandon the cook
          this.releaseStove(c);
          c.target = this.pickChefIdleSpot(c);
          this.planPath(c);
          c.state = "returningHome";
          c.character.action = "walk";
          c.clock = 0;
          c.ticketId = null;
          break;
        }
        if (c.clock >= ticket.cookSeconds) {
          ticket.state = "ready";
          ticket.clock = 0;
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

  private tickWaiter(w: StaffActor, dt: number): void {
    w.clock += dt;

    switch (w.state) {
      case "idle": {
        // Priority 1: deliver a ready ticket. Plates that are already
        // cooked and waiting on the pass take precedence over wash
        // work — keep customers fed first. Phase 7d: this waiter only
        // serves seats on their home floor (multi-floor pathfinding is
        // still pending, so a Floor-1 waiter can't navigate stairs).
        const ticket = this.tickets.find((t) => t.state === "ready" && t.seatFloor === w.homeFloor);
        if (ticket) {
          ticket.state = "delivering";
          ticket.clock = 0;
          w.ticketId = ticket.id;
          w.target = this.pickupPos.clone();
          this.planPath(w);
          w.state = "movingToWork";
          w.clock = 0;
          w.character.action = "walk";
          console.log(`[Router] waiter picked up ${ticket.id} → walking to pickup`);
          break;
        }
        // Priority 2: bus a dirty plate to the sink.
        const trip = this.tryStartWashTrip(w);
        if (trip) {
          w.washTrip = trip;
          w.target = trip.dirtyPos.clone();
          this.planPath(w);
          w.state = "movingToWork";
          w.clock = 0;
          w.character.action = "walk";
        }
        break;
      }
      case "movingToWork": {
        this.moveActor(w, dt);
        if (this.distance(w.character.groundPos, w.target) < ARRIVAL_THRESHOLD) {
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
              // Show the held-plate mesh as a "carrying dirty" cue.
              if (!w.heldPlate) {
                w.heldPlate = makePlate();
                w.character.root.add(w.heldPlate);
              }
              w.heldPlate.visible = true;
              w.character.action = "carry";
              w.washTrip.phase = "wash";
              w.target = w.washTrip.stationPos.clone();
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
            w.target = w.home.clone();
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
          this.planPath(w);
          w.state = "working";
          w.clock = 0;
        }
        break;
      }
      case "working": {
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
            if (isDishwasher) {
              this.washCallbacks?.loadDishwasher(trip.stationUid, trip.stationDefId, trip.kind);
              // Dishwashers don't lock — clearing busyWashUids is a
              // safety net for legacy code paths that may still have
              // claimed it.
              this.busyWashUids.delete(trip.stationUid);
            } else {
              this.washCallbacks?.washOne(trip.kind);
              this.busyWashUids.delete(trip.stationUid);
            }
            if (w.heldPlate) w.heldPlate.visible = false;
            w.washTrip = null;
            w.target = w.home.clone();
            this.planPath(w);
            w.state = "returningHome";
            w.character.action = "walk";
            w.clock = 0;
          }
          break;
        }
        // Serve flow: walking the plate to the seat.
        this.moveActor(w, dt);
        if (this.distance(w.character.groundPos, w.target) < ARRIVAL_THRESHOLD) {
          const ticket = this.tickets.find((t) => t.id === w.ticketId);
          if (ticket) ticket.state = "delivered";
          if (w.heldPlate) w.heldPlate.visible = false;
          w.target = w.home.clone();
          this.planPath(w);
          w.state = "returningHome";
          w.character.action = "walk";
          w.ticketId = null;
          w.clock = 0;
        }
        break;
      }
      case "returningHome": {
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

  /** Try to start a wash trip for this idle waiter. Picks the closest
   * unclaimed dirty piece + the closest free wash station, claims
   * both, and returns the trip. Returns null when any prereq is
   * missing (no callbacks wired, no dirty plates, no free station).
   *
   * Distance is straight-line ground distance — good enough for
   * picking "nearest" since the pathfinder takes over once we hand
   * off the trip; a slightly-suboptimal pick is fine. */
  private tryStartWashTrip(w: StaffActor): WashTrip | null {
    if (!this.washCallbacks) return null;
    const stations = this.washCallbacks.getWashStations();
    if (stations.length === 0) return null;
    const dirties = this.washCallbacks.getDirtyPickups();
    if (dirties.length === 0) return null;
    const here = w.character.groundPos;
    // Nearest unclaimed dirty piece.
    let pickedDirty: DirtyPickupInfo | null = null;
    let pickedDirtyDist = Infinity;
    for (const d of dirties) {
      const dist = Math.hypot(d.pos.x - here.x, d.pos.y - here.y);
      if (dist < pickedDirtyDist) { pickedDirty = d; pickedDirtyDist = dist; }
    }
    if (!pickedDirty) return null;
    // Nearest free wash station. Two kinds of "free":
    //   • sink: only one waiter at a time (busyWashUids gate)
    //   • dishwasher: many waiters can drop into the same unit, but
    //     each dishwasher has a per-kind capacity (10 plates / 5
    //     glasses); reject when this kind's bin is already full.
    let pickedStation: WashStationInfo | null = null;
    let pickedStationDist = Infinity;
    for (const s of stations) {
      const isDishwasher = s.defId.startsWith("dishwasher");
      if (isDishwasher) {
        if (!this.washCallbacks.canDishwasherLoad(s.uid, pickedDirty.kind)) continue;
      } else {
        if (this.busyWashUids.has(s.uid)) continue;
      }
      const dist = Math.hypot(s.standPos.x - here.x, s.standPos.y - here.y);
      if (dist < pickedStationDist) { pickedStation = s; pickedStationDist = dist; }
    }
    if (!pickedStation) return null;
    if (!this.washCallbacks.claimDirtyPickup(pickedDirty.id, w.memberId)) return null;
    // Dishwashers stay unclaimed — capacity already enforces the
    // limit; sinks get the busy-set claim so a second waiter doesn't
    // queue up at the same basin.
    const isSink = !pickedStation.defId.startsWith("dishwasher");
    if (isSink) this.busyWashUids.add(pickedStation.uid);
    return {
      dirtyId: pickedDirty.id,
      dirtyPos: pickedDirty.pos.clone(),
      kind: pickedDirty.kind,
      stationUid: pickedStation.uid,
      stationDefId: pickedStation.defId,
      stationPos: pickedStation.standPos.clone(),
      dwell: pickedStation.dwell,
      phase: "pickup",
    };
  }

  /** Release any in-flight wash claims and reset the waiter to
   * returningHome. Used when the dirty mesh vanished between claim and
   * arrival (e.g. save reload), or when the waiter was just fired. */
  private abandonWashTrip(w: StaffActor): void {
    if (w.washTrip) {
      this.washCallbacks?.releaseDirtyPickup(w.washTrip.dirtyId);
      this.busyWashUids.delete(w.washTrip.stationUid);
      w.washTrip = null;
    }
    if (w.heldPlate) w.heldPlate.visible = false;
    w.target = w.home.clone();
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
    if (a.replanAccum >= 0.8 && this.distance(pos, a.target) >= ARRIVAL_THRESHOLD) {
      a.replanAccum = 0;
      this.planPath(a);
    }
    while (a.path.length > 0 && this.distance(pos, a.path[0]) < PATH_ARRIVAL_THRESHOLD) {
      a.path.shift();
    }
    const wp = a.path[0] ?? a.target;
    const dx = wp.x - pos.x;
    const dz = wp.y - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return;
    // Apply this MEMBER's training multiplier (waiter serve speed,
    // for now — chef cook speed is applied to ticket.cookSeconds when
    // they pick up). The getSpeedMultiplier callback returns 1.0 for
    // unknown ids so an unwired actor still moves at base speed.
    const speedMult = this.getSpeedMultiplier?.(a.memberId) ?? 1;
    const step = Math.min(dist, a.speed * speedMult * dt);
    pos.x += (dx / dist) * step;
    pos.y += (dz / dist) * step;
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
    case "returningHome": return "← back";
    default:              return "";
  }
}

function waiterLabel(state: StaffActor["state"]): string {
  switch (state) {
    case "movingToWork": return "→ pickup";
    case "working":       return "🍽️ serving";
    case "returningHome": return "← back";
    default:              return "";
  }
}
