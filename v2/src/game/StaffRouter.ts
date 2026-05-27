import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";

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
  home: THREE.Vector2; // where they return to when idle
  state: "idle" | "movingToWork" | "working" | "returningHome";
  /** What they're working on (a ticket id). */
  ticketId: string | null;
  /** Move target while not at home. */
  target: THREE.Vector2;
  /** Per-state timer. */
  clock: number;
}

const WALK_SPEED = 2.2; // staff move faster than guests for visibility
const ARRIVAL_THRESHOLD = 0.18;

export class StaffRouter {
  /** Public queue: GuestSpawner enqueues, GuestSpawner polls for DELIVERED. */
  readonly tickets: Ticket[] = [];

  private readonly chefs: StaffActor[] = [];
  private readonly waiters: StaffActor[] = [];

  /** Where the chef cooks (next to the stove). */
  private readonly stovePos: THREE.Vector2;
  /** Where the waiter picks up plates from the chef. */
  private readonly pickupPos: THREE.Vector2;

  constructor(
    chefChar: AnimatedCharacter,
    waiterChar: AnimatedCharacter,
    stovePos: THREE.Vector2,
    pickupPos: THREE.Vector2,
  ) {
    this.stovePos = stovePos.clone();
    this.pickupPos = pickupPos.clone();
    this.addChef(chefChar);
    this.addWaiter(waiterChar);
  }

  /** Append a chef to the pool. Their current ground position becomes home. */
  addChef(char: AnimatedCharacter): void {
    this.chefs.push({
      character: char,
      home: char.groundPos.clone(),
      state: "idle",
      ticketId: null,
      target: char.groundPos.clone(),
      clock: 0,
    });
  }

  addWaiter(char: AnimatedCharacter): void {
    this.waiters.push({
      character: char,
      home: char.groundPos.clone(),
      state: "idle",
      ticketId: null,
      target: char.groundPos.clone(),
      clock: 0,
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
    pool.splice(idx, 1);
    return removed.character;
  }

  getChefCount(): number { return this.chefs.length; }
  getWaiterCount(): number { return this.waiters.length; }

  /** True if at least one chef is currently in their "working" (cooking)
   * state. Used to drive the visible stove flame. */
  isAnyChefCooking(): boolean {
    return this.chefs.some((c) => c.state === "working");
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
  }

  // === Chef state machine ===

  private tickChef(c: StaffActor, dt: number): void {
    c.clock += dt;

    switch (c.state) {
      case "idle": {
        const ticket = this.tickets.find((t) => t.state === "queued");
        if (ticket) {
          ticket.state = "cooking";
          ticket.clock = 0;
          c.ticketId = ticket.id;
          c.target = this.stovePos.clone();
          c.state = "movingToWork";
          c.clock = 0;
          c.character.action = "walk";
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
        if (!ticket) { // guest left, abandon the cook
          c.target = c.home.clone();
          c.state = "returningHome";
          c.character.action = "walk";
          c.clock = 0;
          c.ticketId = null;
          break;
        }
        if (c.clock >= ticket.cookSeconds) {
          ticket.state = "ready";
          ticket.clock = 0;
          c.target = c.home.clone();
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
          w.state = "movingToWork"; // movingToWork = first goes to kitchen, then to seat
          w.clock = 0;
          w.character.action = "walk";
        }
        break;
      }
      case "movingToWork": {
        this.moveActor(w, dt);
        if (this.distance(w.character.groundPos, w.target) < ARRIVAL_THRESHOLD) {
          const ticket = this.tickets.find((t) => t.id === w.ticketId);
          if (!ticket) {
            w.target = w.home.clone();
            w.state = "returningHome";
            w.character.action = "walk";
            w.ticketId = null;
            w.clock = 0;
            break;
          }
          // Picked up the plate — now head to the seat. carry pose reads
          // as holding something while walking.
          w.character.action = "carry";
          w.target = ticket.seatPos.clone();
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
          w.target = w.home.clone();
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
    const dx = a.target.x - pos.x;
    const dz = a.target.y - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return;
    const step = Math.min(dist, WALK_SPEED * dt);
    pos.x += (dx / dist) * step;
    pos.y += (dz / dist) * step;
    a.character.facingY = Math.atan2(dx, dz);
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
