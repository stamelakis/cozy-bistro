import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Pathfinding, PathStep } from "./Pathfinding";
import { PATH_ARRIVAL_THRESHOLD } from "./Pathfinding";
import { isServerSim } from "./featureFlags";

/**
 * Drives the errand-helper characters so the auto-shop has a visible
 * "someone is doing the work" beat.
 *
 * Trip phases (one full shopping run):
 *   1. home              → walk → door (interior)
 *   2. door (interior)   → walk → pavement edge
 *   3. invisible offscreen for OFFSCREEN_SHOP_SECONDS (the "shopping" beat)
 *   4. pavement edge     → walk → door (interior, now carrying goods)
 *   5. door              → walk → supply counter (drop point)
 *   6. counter           → walk → home
 *
 * The whole loop takes ~35-45 sim seconds — slow enough that a busy
 * kitchen has incentive to hire extra helpers, and dramatic enough that
 * "auto-shop" reads as a real workflow rather than a teleport.
 *
 * Trips are queued — many auto-shop events fired in quick succession
 * stack into a single visible trip rather than spamming overlapping
 * walks. Multiple helpers in the pool each peel one trip off the
 * queue, so a kitchen with extras chews through pending deliveries in
 * parallel.
 */

/** A frozen shopping list the helper is currently fetching, OR null
 * when they're free to take the next queued trip. */
type ShoppingList = Map<string, number>;

type ErrandState =
  | "idle"
  | "walkingToDoor"       // home → door (interior side)
  | "exitingDoor"         // door (interior) → door (exterior) — short pass through the wall
  | "walkingToRoadEdge"   // door (exterior) → pavement edge (about to disappear)
  | "offscreen"           // invisible, "shopping" timer
  | "walkingFromRoadEdge" // pavement edge → door (exterior)
  | "enteringDoor"        // door (exterior) → door (interior) — short pass back through
  | "walkingToCounter"    // door (interior) → supply counter (drop point)
  | "atCounter"           // brief dwell, payload delivered
  | "returningHome";      // counter → home

interface ErrandActor {
  character: AnimatedCharacter;
  /** Linked HiredStaffMember id. The auto-shop trip's carry capacity
   * uses the best-trained helper across the pool, so the helpers
   * don't need a per-actor lookup hook today — but the id lets the
   * UI surface "Helper Foo is on a trip" later. */
  memberId: string;
  home: THREE.Vector2;
  state: ErrandState;
  target: THREE.Vector2;
  clock: number;
  /** Which side of the pavement they left from — used so they re-enter
   * from the same spot for visual continuity. Picked at trip start. */
  roadEdge: THREE.Vector2 | null;
  /** What this helper is currently fetching — set when they leave home,
   * delivered (via onDelivery) when they hand off at the counter. */
  payload: ShoppingList | null;
  /** Remaining waypoints from the most recent pathfind. */
  path: PathStep[];
  /** Seconds since the last replan. moveActor refreshes the path every
   * ~0.8s of movement so a piece of furniture placed mid-trip doesn't
   * leave the helper following stale waypoints right through it. */
  replanAccum: number;
  /** Phase 8.3 — server-snapshot interpolation state. The bridge
   * records the last two cloud-reported positions; the per-frame
   * smoother LERPs between them based on elapsed wall-clock time
   * since the last snapshot. This is the standard "snapshot
   * interpolation" pattern used in networked games — guarantees
   * continuous on-screen motion that exactly traces what the server
   * said, with a fixed ~500 ms lag (one server tick). Lag matters
   * less than the previous teleport-every-tick visual; the helper
   * still arrives at the door / counter at the same moment it would
   * have, just smoothly. */
  prevServerPos: THREE.Vector2 | null;
  lastServerPos: THREE.Vector2 | null;
  /** performance.now() at the time lastServerPos was set. */
  lastServerStampMs: number;
}

const WALK_SPEED = 2.88; // +20% over the previous 2.4
const ARRIVAL_THRESHOLD = 0.18;
/** Pause at the supply counter (seconds) to suggest signing for the delivery. */
const COUNTER_DWELL_SECONDS = 0.8;
/** How long the helper is invisible "at the shop" before walking back. */
const OFFSCREEN_SHOP_SECONDS = 3.0;
/** Cap on queued trips so a long shortage doesn't queue dozens. */
const MAX_PENDING_TRIPS = 6;
/** How far past the pavement (in world units along the road) the helper
 * walks before disappearing. The pavement spans ~30 units in X centred on
 * the door, so 13 puts them right at the visible edge. */
const ROAD_EDGE_X = 13;
/** Z position of the helper's offscreen walk — roughly the middle of the
 * pavement so the walking-down-the-sidewalk gait reads cleanly. */
const ROAD_EDGE_Z = 7.5;
/** Half-width / half-depth of the idle "loitering" zone around the
 * supply counter. The helper picks a random spot inside this box every
 * time they return home, so they don't stand at one stiff waypoint. */
const IDLE_ZONE_HALF_X = 0.7;
const IDLE_ZONE_HALF_Z = 0.6;

export class ErrandRouter {
  private readonly helpers: ErrandActor[] = [];

  /** Phase I (H.65) — cloud handle for mirroring helper position +
   * state to the staff_actor table (role="errand").  Use setCloud()
   * to wire this after construction so already-added helpers get
   * registered too.
   *
   * Mirror cadence: 1 Hz (same as StaffRouter), driven from `update`.
   * Hydrate path applies cloud state on subscription ready so a
   * refresh mid-trip resumes from where the helper was. */
  private cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;
  /** 1Hz publish accumulator (matches StaffRouter.cloudActorAccum). */
  private cloudActorAccum = 0;

  /** Where the helper enters/exits the building. The interior side of
   * the front door — see WorldScene.doorPos. */
  private readonly doorInteriorPos: THREE.Vector2;
  /** A point on the OUTSIDE face of the front door, ~1 unit past the
   * wall. The helper always passes through this BEFORE heading to the
   * road edge (and through it again coming back). Without this the
   * diagonal direct line from doorInterior to the off-screen road edge
   * sliced through the side wall — the helper visibly clipped through
   * the building corner instead of using the door. */
  private readonly doorExteriorPos: THREE.Vector2;
  /** Where the helper drops off the goods after returning — see
   * WorldScene.supplyCounterPos. */
  private readonly counterPos: THREE.Vector2;
  /** Queue of shopping lists waiting for a helper. Each idle helper
   * peels one off per tick. Capped at MAX_PENDING_TRIPS — the Game's
   * auto-shop dispatcher knows to back off rather than queueing
   * indefinitely. */
  private pendingTrips: ShoppingList[] = [];
  /** Fired when a helper hands off their payload at the supply counter.
   * Engine wires this to Game.completeErrandDelivery so the units
   * actually land on the pantry shelves. */
  onDelivery?: (list: ShoppingList) => void;

  /** Optional pathfinder; when present, helper movements route around
   * blocking furniture. Falls back to direct movement otherwise. The
   * offscreen "shopping" segment and the road-edge legs aren't routed
   * (they're outside the playable grid). */
  private readonly pathfind?: Pathfinding;

  constructor(helperChar: AnimatedCharacter, helperMemberId: string, doorPos: THREE.Vector2, counterPos: THREE.Vector2, pathfind?: Pathfinding) {
    this.doorInteriorPos = doorPos.clone();
    // Exterior anchor sits 1 tile out from the interior point along the
    // door's normal (+Z, toward the front of the building). Front door
    // lives on the +Z exterior wall so +Z is "outside".
    this.doorExteriorPos = new THREE.Vector2(doorPos.x, doorPos.y + 1);
    this.counterPos = counterPos.clone();
    this.pathfind = pathfind;
    this.addHelper(helperChar, helperMemberId);
  }

  /** Plan the helper's path from current position to target. Falls
   * back to a single direct waypoint when no pathfinder is wired. */
  private planPath(h: ErrandActor): void {
    if (!this.pathfind) { h.path = [h.target.clone()]; return; }
    h.path = this.pathfind.findPath(
      h.character.groundPos.x, h.character.groundPos.y,
      h.target.x, h.target.y,
    );
    if (h.path.length === 0) h.path = [h.target.clone()];
  }

  addHelper(char: AnimatedCharacter, memberId: string): void {
    char.action = "idle"; // override the default "carry" pose
    // Belt-and-suspenders in case of a recycled char. Clear the
    // floor-gate's _keepHidden flag too (a prior life may have left it
    // set while offscreen); the animator owns root.visible from here.
    char.root.visible = true;
    char._keepHidden = false;
    // Snap them to a fresh randomized loiter spot near the counter so
    // they don't all line up at the same coord when more than one is
    // hired.
    const home = this.pickIdleSpot();
    char.groundPos.copy(home);
    const actor: ErrandActor = {
      character: char,
      memberId,
      home,
      state: "idle",
      target: home.clone(),
      clock: 0,
      payload: null,
      roadEdge: null,
      path: [],
      replanAccum: 0,
      prevServerPos: null,
      lastServerPos: null,
      lastServerStampMs: 0,
    };
    this.helpers.push(actor);
    // Phase I (H.65) — mirror to cloud so a refresh can hydrate the
    // helper's last-known pose.  Server's compute_waiter_transition
    // returns identity for unknown errand states (walkingToDoor etc.),
    // so the only server-side step is the position interpolation
    // toward target_x/z — which the 1Hz client mirror overrides
    // anyway.  Safe to layer on without server changes.
    this.mirrorActorRegister(actor);
  }

  /** Random point in the loiter zone near the supply counter. Picked
   * fresh every trip so the helper doesn't park at exactly the same
   * coord every time they return — feels more like a person on shift. */
  private pickIdleSpot(): THREE.Vector2 {
    const x = this.counterPos.x + (Math.random() - 0.5) * 2 * IDLE_ZONE_HALF_X;
    const z = this.counterPos.y + (Math.random() - 0.5) * 2 * IDLE_ZONE_HALF_Z;
    return new THREE.Vector2(x, z);
  }

  /** Pop one helper out of the pool. Prefers an idle helper so we don't
   * abandon a trip mid-flight. Returns the character so Engine can drop
   * its model from the scene. If the removed helper was carrying a
   * payload, it goes back onto the queue so another helper can fetch it. */
  /** Same LIFO + prefer-idle pop. Public API for the legacy
   * fire-by-role path; the by-id path calls removeHelperById. */
  removeHelper(): AnimatedCharacter | null {
    if (this.helpers.length === 0) return null;
    const idleIdx = this.helpers.findIndex((h) => h.state === "idle");
    const idx = idleIdx >= 0 ? idleIdx : this.helpers.length - 1;
    return this.removeHelperAt(idx);
  }

  /** Remove a specific helper by their HiredStaffMember.id. Runs the
   * same payload-recovery + visibility-restore the LIFO path runs,
   * so firing a specific errand mid-shopping doesn't strand their
   * pending grocery trip. Returns null if no helper matches. */
  removeHelperById(memberId: string): AnimatedCharacter | null {
    const idx = this.helpers.findIndex((h) => h.memberId === memberId);
    if (idx < 0) return null;
    return this.removeHelperAt(idx);
  }

  /** Shared cleanup + splice. Called by both removeHelper (LIFO)
   * and removeHelperById (specific actor). */
  private removeHelperAt(idx: number): AnimatedCharacter | null {
    if (idx < 0 || idx >= this.helpers.length) return null;
    const removed = this.helpers[idx];
    if (removed.payload && this.pendingTrips.length < MAX_PENDING_TRIPS) {
      this.pendingTrips.unshift(removed.payload);
    }
    // Make sure the model is visible before handing it back — if they
    // were offscreen, the engine will remove the model anyway, but a
    // stray invisible root makes debugging miserable.
    removed.character.root.visible = true;
    removed.character._keepHidden = false;
    this.helpers.splice(idx, 1);
    // H.65 — drop the cloud row so a re-hydrate after a fire doesn't
    // resurrect the just-fired helper at a stale position.
    this.mirrorActorUnregister(removed.memberId);
    return removed.character;
  }

  getHelperCount(): number { return this.helpers.length; }

  /** Look up the animated character that represents a specific
   * HiredStaffMember. Returns null when the helper is offscreen
   * (shopping). */
  findCharacterByMemberId(memberId: string): AnimatedCharacter | null {
    for (const h of this.helpers) if (h.memberId === memberId) return h.character;
    return null;
  }

  /** Phase I (H.72) — workload indicator for the StaffPanel "working"
   * badge.  Returns 1 if this helper is currently on a trip
   * (carrying / shopping / returning), 0 if they're idle by the
   * counter.  Same shape as StaffRouter.getWaiterBacklog so the
   * UI can render a single per-row badge uniformly across roles. */
  getHelperWorkload(memberId: string): number {
    const h = this.helpers.find((x) => x.memberId === memberId);
    if (!h) return 0;
    return h.state === "idle" ? 0 : 1;
  }

  /** Snapshot for the status-bubble layer. Skips offscreen helpers so
   * we don't render a bubble floating over the empty road. */
  snapshotStatus(): { character: AnimatedCharacter; label: string }[] {
    const out: { character: AnimatedCharacter; label: string }[] = [];
    for (const h of this.helpers) {
      if (h.state === "offscreen") continue;
      out.push({ character: h.character, label: errandLabel(h.state) });
    }
    return out;
  }

  /** Queue a trip carrying this shopping list. Caller is responsible for
   * having reserved those units via CookingSystem.addPendingErrandOrder
   * first. Drops the list if the queue is already at MAX_PENDING_TRIPS
   * (Game's dispatcher checks pending units so this is rarely hit). */
  triggerRun(list: ShoppingList): void {
    if (this.pendingTrips.length >= MAX_PENDING_TRIPS) return;
    this.pendingTrips.push(list);
  }

  /** How many trips are queued waiting for a helper. Engine surfaces
   * this for the UI ("X trips queued"). */
  getPendingTripCount(): number { return this.pendingTrips.length; }

  /** Total trips currently in motion or queued — one per busy helper
   * plus the explicit queue. Used by Game.dispatchAutoShopTrip to ask
   * "should I even bother dispatching another trip?". */
  getTotalTripsInProgress(): number {
    let busy = 0;
    for (const h of this.helpers) if (h.state !== "idle") busy += 1;
    return busy + this.pendingTrips.length;
  }

  /** True if another trip can be absorbed right now. Caps total in-
   * progress trips at the helper count so we don't queue 60 units of
   * shopping behind a single helper — which used to happen because the
   * dispatcher committed money/pending BEFORE asking the router, and
   * the router silently dropped excess trips (= leaked pending forever). */
  canAcceptTrip(): boolean {
    if (this.helpers.length === 0) return false;
    return this.getTotalTripsInProgress() < this.helpers.length;
  }

  /** Phase I (H.65) — wire the cloud handle.  Engine calls this once
   * the SpacetimeClient is connected.  Because the ErrandRouter's
   * constructor already added the base helper before the cloud handle
   * existed, this also mirrors every helper already in the pool.
   * Idempotent — calling twice with the same client just re-registers
   * the same rows. */
  setCloud(cloud: import("../cloud/SpacetimeClient").SpacetimeClient): void {
    this.cloud = cloud;
    for (const h of this.helpers) this.mirrorActorRegister(h);
  }

  /** Phase I (H.74) — Same as StaffRouter.resyncAllActorsToCloud.
   * Re-pushes every helper currently in the pool up to cloud's
   * `staff_actor` table so the server knows about them even if
   * the original add path predated the mirror code. */
  resyncAllActorsToCloud(): void {
    if (!this.cloud) return;
    let n = 0;
    for (const h of this.helpers) { this.mirrorActorRegister(h); n += 1; }
    if (n > 0) {
      console.log(`[H.74] re-registered ${n} errand helper(s) to cloud staff_actor`);
    }
  }

  update(dt: number): void {
    // Phase H Phase 5.4 — when server owns dispatch, the bridge
    // subscription is the SOLE driver of local helper STATE. The
    // local tickHelper would otherwise advance phases on its own
    // clock and write back to cloud, fighting the server's tick.
    if (!this.serverOwnsErrand()) {
      for (const h of this.helpers) this.tickHelper(h, dt);
      // Phase I (H.65) — periodic publish of helper pose to the cloud
      // so a refresh / cross-device session resumes from the same spot.
      this.streamActorsToCloud(dt);
    } else {
      // Phase 9.8 — Server decides the PHASE + TARGET; the local
      // pathfinder renders the walk. The 8.3 snapshot replay traced
      // the server's straight-line positions exactly, which meant
      // helpers clipped straight through furniture (the server has
      // no obstacle map). moveActor pathfinds around obstacles
      // toward the bridge-set target and computes facing; the
      // bridge re-anchors position on every phase transition (door,
      // road edge, counter — points both sims agree on), so drift
      // within a leg self-corrects at the next anchor.
      for (const h of this.helpers) {
        if (h.state === "offscreen" || h.state === "idle"
            || h.state === "atCounter") continue;
        this.moveActor(h, dt);
      }
    }
  }

  // Phase 9.8 — smoothFollowServer (8.3 snapshot replay) REMOVED:
  // replaying the server's straight-line positions made helpers clip
  // through furniture (the server has no obstacle map). update() now
  // runs the pathfound moveActor toward the bridge-set target; the
  // bridge's snapshot bookkeeping (prev/lastServerPos) remains for
  // the offscreen-return re-anchor only.

  /** Phase H Phase 5.4 — server-authoritative gate. Mirrors the
   * StaffRouter pattern; true when isServerSim("tickets") + cloud
   * connected. When on, the local tickHelper + mirrorErrandFields
   * are skipped and the bridge subscription becomes the sole driver
   * of local helper state. */
  private serverOwnsErrand(): boolean {
    return isServerSim("tickets") && this.cloud != null;
  }

  private errandBridgeAttached = false;

  /** Phase H Phase 5.4 — subscribe to staff_actor changes for our
   * errand helpers. When server's tick_errand_actor advances the
   * phase or position, mirror it onto the local helper so the
   * character animation + visibility match. */
  attachServerBridge(): void {
    if (!this.cloud || this.errandBridgeAttached) return;
    // Phase 9.2 — Boot-race guard: subscribeStaffActorChanges
    // registers nothing before conn + restaurantId resolve; latching
    // on the no-op left the bridge dead when GLB loads beat auth.
    // Engine retries at 1 Hz until ready.
    if (!this.cloud.hasRestaurantContext()) return;
    this.errandBridgeAttached = true;
    this.cloud.subscribeStaffActorChanges({
      onUpdate: (row) => this.reconcileCloudErrand(row),
    });
    console.log("[Errand/Bridge] errand cloud bridge attached");
  }

  /** Apply a cloud staff_actor row to the matching local helper.
   *
   * Phase 8.3 — feeds the snapshot-interpolation smoother
   * (smoothFollowServer). Each cloud update records (prev = last,
   * last = row.x/z, stamp = now). The smoother LERPs between the
   * two snapshots over the next 500 ms (one server tick), so the
   * on-screen motion exactly traces what the server walked, one
   * tick late. No drift snap needed — there's no possibility of
   * desync when the client is just replaying server snapshots. The
   * only direct groundPos write is when the helper re-appears from
   * offscreen (legitimate teleport from invisible to road edge);
   * for all other transitions the smoother handles the new
   * snapshot via the prev/last lerp. */
  private reconcileCloudErrand(row: import("../cloud/SpacetimeClient").StaffActorRow): void {
    if (row.role !== "errand") return;
    const h = this.helpers.find((helper) => helper.memberId === row.memberId);
    if (!h) return;
    // Roll snapshots forward: previous becomes the one we last
    // received, last becomes the one we just got. On the very
    // first tick after attach, prev is null — seed both to the
    // same position so velocity = 0 and facing stays put.
    if (h.lastServerPos == null) {
      h.lastServerPos = new THREE.Vector2(row.x, row.z);
      h.prevServerPos = h.lastServerPos.clone();
      // Seed groundPos so the very first render frame has SOMETHING
      // sensible; subsequent ticks update via the smoother.
      h.character.groundPos.set(row.x, row.z);
    } else {
      h.prevServerPos = h.lastServerPos.clone();
      h.lastServerPos.set(row.x, row.z);
    }
    h.lastServerStampMs = performance.now();
    // Keep target current — only used by the bubble UI + dispatch
    // bookkeeping; the smoother no longer reads it for motion.
    h.target.set(row.targetX, row.targetZ);
    // State sync. Phase 9.20 — the server keeps the trip phase in
    // the ERRAND_PHASE column ("walkingToCounter", "offscreen", …)
    // and writes GENERIC actor states ("movingToWork"/"working")
    // into `state`. The old check read only `state`, which never
    // matched an errand phase name — the bridge silently dropped
    // every transition, local helpers stayed posed "idle" forever,
    // and the panel showed "3 idle" while their server twins
    // shopped invisibly. Resolve the phase from errandPhase first;
    // fall back to `state` for legacy rows; treat a phase-less
    // "idle" row as the trip-complete signal.
    const resolved: ErrandState | null =
      row.errandPhase && isErrandState(row.errandPhase) ? row.errandPhase
      : isErrandState(row.state) ? row.state
      : row.state === "idle" ? "idle"
      : null;
    if (resolved != null) {
      const wasOffscreen = h.state === "offscreen";
      const isPhaseChange = h.state !== resolved;
      h.state = resolved;
      // Phase 9.29 — only "offscreen" forces a non-floor hide; the
      // animator ANDs this with floor-focus to set root.visible.
      h.character._keepHidden = resolved === "offscreen";
      h.character.action = errandPoseFor(resolved);
      // Coming back from offscreen is a legitimate teleport — the
      // helper was invisible at the offscreen anchor and now needs
      // to re-appear at row.x/z (road edge). Snap groundPos AND
      // seed both snapshots to row.x/z so the smoother doesn't
      // interpolate from the stale offscreen-pre-snapshot position
      // back to road edge for 500 ms.
      if (wasOffscreen) {
        h.character.groundPos.set(row.x, row.z);
        h.lastServerPos.set(row.x, row.z);
        h.prevServerPos?.set(row.x, row.z);
      }
      // Reset trip-internal flags on every phase transition.
      if (isPhaseChange || wasOffscreen) {
        h.clock = 0;
        h.replanAccum = 0;
        h.path = [];
      }
    }
  }

  /** Phase I (H.65) — 1 Hz position publish.  Matches StaffRouter's
   * cadence; one reducer call per helper per second is cheap and
   * keeps the staff_actor row in step with the local state machine. */
  private streamActorsToCloud(dt: number): void {
    if (!this.cloud) return;
    this.cloudActorAccum += dt;
    if (this.cloudActorAccum < 1.0) return;
    this.cloudActorAccum = 0;
    for (const h of this.helpers) this.mirrorActorUpdate(h);
  }

  private mirrorActorRegister(h: ErrandActor): void {
    if (!this.cloud) return;
    this.cloud.registerStaffActor({
      memberId: h.memberId,
      role: "errand",
      homeFloor: 0,
      homeX: h.home.x,
      homeZ: h.home.y,
      spawnX: h.character.groundPos.x,
      spawnZ: h.character.groundPos.y,
      spawnFloor: 0,
    });
  }

  private mirrorActorUnregister(memberId: string): void {
    if (!this.cloud) return;
    this.cloud.unregisterStaffActor(memberId);
  }

  private mirrorActorUpdate(h: ErrandActor): void {
    if (!this.cloud) return;
    this.cloud.updateStaffActor({
      memberId: h.memberId,
      state: h.state,
      ticketId: null,
      x: h.character.groundPos.x,
      z: h.character.groundPos.y,
      floor: 0,
      targetX: h.target.x,
      targetZ: h.target.y,
      targetFloor: 0,
      assignedStoveUid: "",
      lastStoveUid: "",
      washTargetUid: "",
      washDirtyId: BigInt(-1),
      washPhase: "",
      takeOrderGuestId: null,
    });
    // Phase H Phase 5.1+ — also stamp the dedicated errand fields so
    // visit-mode + co-owner views can render the trip phase + the
    // shopping list. updateStaffActor's `state` column already
    // carries the phase as a string, but the dedicated columns let
    // the server's future Phase 5.2 detector and the Phase 5.4
    // bridge handler discriminate errand state cleanly without
    // sniffing the generic `state` enum.
    this.mirrorErrandFields(h);
  }

  /** Serialize the trip's frozen list to "id:units,id:units" CSV, or
   * null when the helper isn't on a trip. */
  private serializeTripList(payload: ShoppingList | null): string | null {
    if (!payload || payload.size === 0) return null;
    const parts: string[] = [];
    for (const [id, units] of payload) parts.push(`${id}:${units}`);
    return parts.join(",");
  }

  /** Stamp the errand-only fields. Called both by the periodic
   * stream AND ad-hoc on each phase transition so visit-mode picks
   * up phase flips within ~50 ms instead of waiting for the 1 Hz
   * streamActorsToCloud tick. */
  private mirrorErrandFields(h: ErrandActor): void {
    if (!this.cloud) return;
    // Phase H Phase 5.4 — when server owns dispatch, the server is
    // the writer for errand_phase / trip_list_csv. Mirroring here
    // would race the server tick and stomp the freshly-written
    // server values with stale local ones.
    if (this.serverOwnsErrand()) return;
    const phase = h.state === "idle" ? null : h.state;
    const tripListCsv = this.serializeTripList(h.payload);
    // Offscreen-until: clock counts up from 0 within the offscreen
    // phase; OFFSCREEN_SHOP_SECONDS is the dwell. Compute
    // wall-clock-end = now + remaining seconds when in that phase,
    // else 0.
    let offscreenUntilMicros = 0n;
    if (h.state === "offscreen") {
      const remainingSec = Math.max(0, OFFSCREEN_SHOP_SECONDS - h.clock);
      offscreenUntilMicros = BigInt(Math.round(Date.now() * 1000 + remainingSec * 1_000_000));
    }
    this.cloud.setErrandState({
      memberId: h.memberId,
      phase,
      tripListCsv,
      offscreenUntilMicros,
    });
  }

  /** Phase I (H.65) — Apply cloud staff_actor rows (role="errand") to
   * local helpers.  Engine calls on subscription ready.  Restores
   * position + ErrandState so a refresh resumes from where the
   * helper was, not from home.
   *
   * Known caveat: the trip's `payload` (Map<ingredient,count>) is NOT
   * cloud-mirrored — it's a transient closure on the client.  A
   * helper resumed mid-trip will deliver an empty bag.  Game's
   * completeErrandDelivery handles an empty Map gracefully (no
   * units added).  Acceptable for now — the visible bug (teleport to
   * home) is the major complaint; the payload-loss only matters if
   * the user happens to refresh during an active shopping run. */
  /** Phase 9.2 — once-latch, set only when the cloud context is
   * actually live so a too-early call doesn't permanently no-op the
   * hydrate (same boot-race story as the bridges). */
  private cloudHydratedErrand = false;

  hydrateFromCloud(): void {
    if (!this.cloud) return;
    if (this.cloudHydratedErrand) return;
    if (!this.cloud.hasRestaurantContext()) return;
    this.cloudHydratedErrand = true;
    const rows = this.cloud.listStaffActors();
    let updated = 0;
    for (const row of rows) {
      if (row.role !== "errand") continue;
      const h = this.helpers.find((helper) => helper.memberId === row.memberId);
      if (!h) continue;
      h.character.groundPos.set(row.x, row.z);
      // Phase 9.20 — same column fix as the bridge: the server keeps
      // the trip phase in ERRAND_PHASE and writes generic states into
      // `state`, so reading only row.state never matched mid-trip
      // helpers and a reload froze them as idle statues.
      const st: ErrandState | null =
        row.errandPhase && isErrandState(row.errandPhase) ? row.errandPhase
        : isErrandState(row.state) ? row.state
        : row.state === "idle" ? "idle"
        : null;
      if (st != null) {
        h.state = st;
        h.target.set(row.targetX, row.targetZ);
        // Restore visibility — only "offscreen" hides the model. The
        // animator ANDs _keepHidden with floor-focus for root.visible.
        h.character._keepHidden = st === "offscreen";
        h.character.action = errandPoseFor(st);
        // Reset trip-internal flags that aren't persisted.
        h.clock = 0;
        h.replanAccum = 0;
        h.path = [];
        // For mid-trip resumes, re-plan now so moveActor has a path.
        if (isWalkingState(st)) this.planPath(h);
      }
      updated++;
    }
    if (updated > 0) {
      console.log(`[H.65] hydrateFromCloud: ${updated} errand actor(s) restored from cloud`);
    }
  }

  private tickHelper(h: ErrandActor, dt: number): void {
    h.clock += dt;

    switch (h.state) {
      case "idle": {
        if (this.pendingTrips.length > 0) {
          h.payload = this.pendingTrips.shift() ?? null;
          // Pick a random pavement edge for this trip — left or right of
          // the door. Same spot is used for departure + return so the
          // visual is consistent.
          const dir = Math.random() < 0.5 ? -1 : 1;
          h.roadEdge = new THREE.Vector2(ROAD_EDGE_X * dir, ROAD_EDGE_Z);
          h.target = this.doorInteriorPos.clone();
          this.planPath(h);
          h.state = "walkingToDoor";
          h.clock = 0;
          h.character.action = "walk";
        }
        break;
      }
      case "walkingToDoor": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          // Reached the inside of the door. Step straight through to the
          // exterior anchor before turning toward the pavement — this
          // 1-unit hop along the door normal is what keeps the helper
          // from slicing diagonally through the side wall on the way out.
          h.target = this.doorExteriorPos.clone();
          this.planPath(h);
          h.state = "exitingDoor";
          h.clock = 0;
        }
        break;
      }
      case "exitingDoor": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          // Now safely outside the front wall — head down the pavement.
          h.target = (h.roadEdge ?? new THREE.Vector2(ROAD_EDGE_X, ROAD_EDGE_Z)).clone();
          this.planPath(h);
          h.state = "walkingToRoadEdge";
          h.clock = 0;
        }
        break;
      }
      case "walkingToRoadEdge": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          // Hide the helper entirely — they've "left the screen" to shop.
          h.character._keepHidden = true;
          h.state = "offscreen";
          h.clock = 0;
          h.character.action = "idle";
        }
        break;
      }
      case "offscreen": {
        if (h.clock >= OFFSCREEN_SHOP_SECONDS) {
          // Pop back into view at the same pavement edge, now carrying.
          // Walk back to the EXTERIOR door anchor first; we'll step
          // through the wall from there.
          h.character._keepHidden = false;
          h.target = this.doorExteriorPos.clone();
          this.planPath(h);
          h.state = "walkingFromRoadEdge";
          h.clock = 0;
          // WALK back to the drop-off — don't play the deposit gesture
          // ("carry" → the Pick_Fruit work clip) the whole way in. The
          // gesture belongs AT the counter; see the atCounter case below.
          h.character.action = "walk";
        }
        break;
      }
      case "walkingFromRoadEdge": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          // At the outside of the door — step through to the interior
          // before heading to the supply counter. Mirror of exitingDoor.
          h.target = this.doorInteriorPos.clone();
          this.planPath(h);
          h.state = "enteringDoor";
          h.clock = 0;
        }
        break;
      }
      case "enteringDoor": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          // Now inside the building — continue to the drop-off counter.
          h.target = this.counterPos.clone();
          this.planPath(h);
          h.state = "walkingToCounter";
          h.clock = 0;
        }
        break;
      }
      case "walkingToCounter": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          h.state = "atCounter";
          h.clock = 0;
          // Reached the cupboard — NOW play the deposit gesture ("carry" →
          // the Pick_Fruit work clip) through the COUNTER_DWELL. Previously
          // this stood idle here while the gesture had already played during
          // the walk in — i.e. depositing before arriving.
          h.character.action = "carry";
        }
        break;
      }
      case "atCounter": {
        if (h.clock >= COUNTER_DWELL_SECONDS) {
          // Hand off the payload to the pantry the moment they finish
          // signing for it. This is the actual gameplay effect of the trip.
          if (h.payload && this.onDelivery) {
            try { this.onDelivery(h.payload); }
            catch (e) { console.warn("[Errand] delivery callback threw:", e); }
          }
          h.payload = null;
          // Re-randomize the loiter spot so they don't park at exactly
          // the same coord every cycle.
          h.home = this.pickIdleSpot();
          h.target = h.home.clone();
          this.planPath(h);
          h.state = "returningHome";
          h.clock = 0;
          h.character.action = "walk";
        }
        break;
      }
      case "returningHome": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          h.roadEdge = null;
          h.state = "idle";
          h.clock = 0;
          h.character.action = "idle";
        }
        break;
      }
    }
  }

  private moveActor(a: ErrandActor, dt: number): void {
    const pos = a.character.groundPos;
    // Plan a path on demand if we haven't yet (defensive — should
    // normally have been planned at state entry, but new helpers and
    // hot-reload paths can land here without one).
    if (a.path.length === 0 && this.distance(pos, a.target) >= ARRIVAL_THRESHOLD) {
      this.planPath(a);
    }
    // Periodic replan so a new wall or table placed during this trip
    // gets routed around within ~1s instead of being walked through.
    a.replanAccum += dt;
    if (a.replanAccum >= 0.8 && this.distance(pos, a.target) >= ARRIVAL_THRESHOLD) {
      a.replanAccum = 0;
      this.planPath(a);
    }
    // Consume waypoints we've already reached.
    while (a.path.length > 0 && this.distance(pos, a.path[0]) < PATH_ARRIVAL_THRESHOLD) {
      a.path.shift();
    }
    const wp = a.path[0] ?? a.target;
    const dx = wp.x - pos.x;
    const dz = wp.y - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return;
    const step = Math.min(dist, WALK_SPEED * dt);
    pos.x += (dx / dist) * step;
    pos.y += (dz / dist) * step;
    // GLB forward = -Z (three.js standard) → atan2(-dx, -dz). See
    // StaffRouter.moveActor for the derivation.
    a.character.facingY = Math.atan2(-dx, -dz);
  }

  private distance(a: THREE.Vector2, b: THREE.Vector2): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

/** Phase I (H.65) — type-narrowing guard for cloud-restored state.
 * The server stores `state` as a free-form String, so an unrecognized
 * value (e.g. an actor row left over from a chef/waiter that got its
 * role mis-set somewhere) returns false and the hydrate path skips
 * setting the local state machine — leaving it idle at the cloud's
 * x/z, which is the right defensive default. */
function isErrandState(s: string): s is ErrandState {
  return (
    s === "idle" ||
    s === "walkingToDoor" ||
    s === "exitingDoor" ||
    s === "walkingToRoadEdge" ||
    s === "offscreen" ||
    s === "walkingFromRoadEdge" ||
    s === "enteringDoor" ||
    s === "walkingToCounter" ||
    s === "atCounter" ||
    s === "returningHome"
  );
}

/** Walk-animation states — used by hydrate to pick the right pose. */
function isWalkingState(s: ErrandState): boolean {
  return (
    s === "walkingToDoor" ||
    s === "exitingDoor" ||
    s === "walkingToRoadEdge" ||
    s === "walkingFromRoadEdge" ||
    s === "enteringDoor" ||
    s === "walkingToCounter" ||
    s === "returningHome"
  );
}

/** Map ErrandState → AnimatedCharacter action for the hydrate path.
 * Mirrors the per-state action setters in tickHelper.  Empty-handed
 * legs play "walk"; loaded legs ("carry") apply once the helper has
 * the goods.  Stationary states ("idle"/"atCounter"/"offscreen") use
 * "idle" (offscreen also has visible=false, so the pose doesn't show). */
function errandPoseFor(s: ErrandState): "walk" | "carry" | "idle" {
  switch (s) {
    case "walkingToDoor":
    case "exitingDoor":
    case "walkingToRoadEdge":
    case "returningHome":
      return "walk";
    case "walkingFromRoadEdge":
    case "enteringDoor":
    case "walkingToCounter":
      return "carry";
    case "idle":
    case "offscreen":
    case "atCounter":
      return "idle";
  }
}

function errandLabel(state: ErrandState): string {
  switch (state) {
    case "walkingToDoor":       return "📦 leaving";
    case "exitingDoor":         return "📦 leaving";
    case "walkingToRoadEdge":   return "📦 to shop";
    case "walkingFromRoadEdge": return "📦 returning";
    case "enteringDoor":        return "📦 returning";
    case "walkingToCounter":    return "📦 → counter";
    case "atCounter":           return "📦 dropping off";
    case "returningHome":       return "← back";
    default:                    return "";
  }
}
