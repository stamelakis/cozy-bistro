import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Pathfinding, PathStep } from "./Pathfinding";
import { PATH_ARRIVAL_THRESHOLD } from "./Pathfinding";

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
}

/** Snapshot of a placed stove the router can assign a chef to. */
export interface StoveInfo {
  uid: string;
  x: number;
  z: number;
  rotY: number;
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
  ) {
    this.stovePos = stovePos.clone();
    this.pickupPos = pickupPos.clone();
    this.pathfind = pathfind;
    this.getStoves = getStoves;
    this.getSpeedMultiplier = getSpeedMultiplier;
    this.getChefCookMultiplier = getChefCookMultiplier;
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
   * walk to a stove already in use. */
  private claimFreeStove(): StoveInfo | null {
    if (!this.getStoves) return null;
    const stoves = this.getStoves();
    for (const s of stoves) {
      if (!this.busyStoveUids.has(s.uid)) {
        this.busyStoveUids.add(s.uid);
        return s;
      }
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
    if (c.lastStoveUid && this.getStoves) {
      const stove = this.getStoves().find((s) => s.uid === c.lastStoveUid);
      if (stove) {
        const base = this.chefStandPosFor(stove);
        base.x += (Math.random() - 0.5) * 1.2;
        base.y += (Math.random() - 0.5) * 0.8;
        return base;
      }
      // The stove was sold/moved — forget it so we don't keep
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
  addChef(char: AnimatedCharacter, memberId: string): void {
    this.chefs.push({
      character: char,
      role: "chef",
      memberId,
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

  addWaiter(char: AnimatedCharacter, memberId: string): void {
    this.waiters.push({
      character: char,
      role: "waiter",
      memberId,
      home: char.groundPos.clone(),
      state: "idle",
      ticketId: null,
      target: char.groundPos.clone(),
      clock: 0,
      speed: WAITER_SPEED,
      path: [],
      replanAccum: 0,
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
  enqueueOrder(guestId: string, recipeId: string, seatPos: THREE.Vector2, cookSeconds: number): string {
    const id = `t-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.tickets.push({
      id, guestId, recipeId, state: "queued",
      seatPos: seatPos.clone(), clock: 0, cookSeconds,
    });
    console.log(`[Router] enqueued ${id} for ${guestId} (${recipeId}, ${cookSeconds}s cook) — ${this.tickets.length} ticket(s) total, ${this.chefs.filter((c) => c.state === "idle").length} idle chef(s)`);
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
        const ticket = this.tickets.find((t) => t.state === "queued");
        if (!ticket) break;
        // Reserve a free stove before taking the ticket. If every
        // placed stove is busy, defer — another idle chef can't sneak
        // ahead because each tickChef runs serially and the busy set
        // is updated before the next chef looks.
        const stove = this.claimFreeStove();
        let target: THREE.Vector2;
        const stoveCount = this.getStoves ? this.getStoves().length : 0;
        if (stove) {
          c.assignedStoveUid = stove.uid;
          target = this.chefStandPosFor(stove);
        } else if (stoveCount === 0) {
          // No stoves placed anywhere — fall back to the legacy
          // shared cooking spot so the kitchen still functions in a
          // degenerate "no appliance" save. No reservation possible
          // here; multiple chefs may pile on this fallback.
          c.assignedStoveUid = null;
          target = this.stovePos.clone();
        } else {
          // Stoves exist but they're all taken — wait it out.
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
        console.log(`[Router] chef picked up ${ticket.id} → walking to ${stove ? `stove ${stove.uid}` : "fallback stovePos"} (mult ${chefMult.toFixed(2)})`);
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
        const ticket = this.tickets.find((t) => t.state === "ready");
        if (ticket) {
          ticket.state = "delivering";
          ticket.clock = 0;
          w.ticketId = ticket.id;
          w.target = this.pickupPos.clone();
          this.planPath(w);
          w.state = "movingToWork"; // movingToWork = first goes to kitchen, then to seat
          w.clock = 0;
          w.character.action = "walk";
          console.log(`[Router] waiter picked up ${ticket.id} → walking to pickup`);
        }
        break;
      }
      case "movingToWork": {
        this.moveActor(w, dt);
        if (this.distance(w.character.groundPos, w.target) < ARRIVAL_THRESHOLD) {
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
        // "working" for the waiter = walking to seat carrying the plate.
        this.moveActor(w, dt);
        if (this.distance(w.character.groundPos, w.target) < ARRIVAL_THRESHOLD) {
          const ticket = this.tickets.find((t) => t.id === w.ticketId);
          if (ticket) ticket.state = "delivered";
          // Plate handed off — hide the held plate; the table-plate
          // spawned by GuestSpawner takes over the visual.
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
