import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";

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
  | "walkingToRoadEdge"   // door → pavement edge (about to disappear)
  | "offscreen"           // invisible, "shopping" timer
  | "walkingFromRoadEdge" // pavement edge → door (now carrying)
  | "walkingToCounter"    // door → supply counter (drop point)
  | "atCounter"           // brief dwell, payload delivered
  | "returningHome";      // counter → home

interface ErrandActor {
  character: AnimatedCharacter;
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
}

const WALK_SPEED = 2.4; // a hair faster than other staff
const ARRIVAL_THRESHOLD = 0.18;
/** Pause at the supply counter (seconds) to suggest signing for the delivery. */
const COUNTER_DWELL_SECONDS = 0.8;
/** How long the helper is invisible "at the shop" before walking back. */
const OFFSCREEN_SHOP_SECONDS = 10.0;
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
  /** Where the helper enters/exits the building. The interior side of
   * the front door — see WorldScene.doorPos. */
  private readonly doorInteriorPos: THREE.Vector2;
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

  constructor(helperChar: AnimatedCharacter, doorPos: THREE.Vector2, counterPos: THREE.Vector2) {
    this.doorInteriorPos = doorPos.clone();
    this.counterPos = counterPos.clone();
    this.addHelper(helperChar);
  }

  addHelper(char: AnimatedCharacter): void {
    char.action = "idle"; // override the default "carry" pose
    char.root.visible = true; // belt-and-suspenders in case of a recycled char
    // Snap them to a fresh randomized loiter spot near the counter so
    // they don't all line up at the same coord when more than one is
    // hired.
    const home = this.pickIdleSpot();
    char.groundPos.copy(home);
    this.helpers.push({
      character: char,
      home,
      state: "idle",
      target: home.clone(),
      clock: 0,
      payload: null,
      roadEdge: null,
    });
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
  removeHelper(): AnimatedCharacter | null {
    if (this.helpers.length === 0) return null;
    const idleIdx = this.helpers.findIndex((h) => h.state === "idle");
    const idx = idleIdx >= 0 ? idleIdx : this.helpers.length - 1;
    const removed = this.helpers[idx];
    if (removed.payload && this.pendingTrips.length < MAX_PENDING_TRIPS) {
      this.pendingTrips.unshift(removed.payload);
    }
    // Make sure the model is visible before handing it back — if they
    // were offscreen, the engine will remove the model anyway, but a
    // stray invisible root makes debugging miserable.
    removed.character.root.visible = true;
    this.helpers.splice(idx, 1);
    return removed.character;
  }

  getHelperCount(): number { return this.helpers.length; }

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

  update(dt: number): void {
    for (const h of this.helpers) this.tickHelper(h, dt);
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
          h.state = "walkingToDoor";
          h.clock = 0;
          h.character.action = "walk";
        }
        break;
      }
      case "walkingToDoor": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          // At the door — now head along the pavement toward the edge.
          h.target = (h.roadEdge ?? new THREE.Vector2(ROAD_EDGE_X, ROAD_EDGE_Z)).clone();
          h.state = "walkingToRoadEdge";
          h.clock = 0;
        }
        break;
      }
      case "walkingToRoadEdge": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          // Hide the helper entirely — they've "left the screen" to shop.
          h.character.root.visible = false;
          h.state = "offscreen";
          h.clock = 0;
          h.character.action = "idle";
        }
        break;
      }
      case "offscreen": {
        if (h.clock >= OFFSCREEN_SHOP_SECONDS) {
          // Pop back into view at the same pavement edge, now carrying.
          h.character.root.visible = true;
          h.target = this.doorInteriorPos.clone();
          h.state = "walkingFromRoadEdge";
          h.clock = 0;
          h.character.action = "carry";
        }
        break;
      }
      case "walkingFromRoadEdge": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          // Through the door — head to the supply counter to drop off.
          h.target = this.counterPos.clone();
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
          h.character.action = "idle";
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
    const dx = a.target.x - pos.x;
    const dz = a.target.y - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return;
    const step = Math.min(dist, WALK_SPEED * dt);
    pos.x += (dx / dist) * step;
    pos.y += (dz / dist) * step;
    // facingY=0 → -Z, π/2 → +X, π → +Z, -π/2 → -X. atan2(dx, -dz) maps.
    a.character.facingY = Math.atan2(dx, -dz);
  }

  private distance(a: THREE.Vector2, b: THREE.Vector2): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

function errandLabel(state: ErrandState): string {
  switch (state) {
    case "walkingToDoor":       return "📦 leaving";
    case "walkingToRoadEdge":   return "📦 to shop";
    case "walkingFromRoadEdge": return "📦 returning";
    case "walkingToCounter":    return "📦 → counter";
    case "atCounter":           return "📦 dropping off";
    case "returningHome":       return "← back";
    default:                    return "";
  }
}
