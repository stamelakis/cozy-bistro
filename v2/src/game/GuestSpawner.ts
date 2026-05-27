import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Game } from "./Game";
import type { StaffRouter } from "./StaffRouter";
import type { FloatingText } from "../ui/FloatingText";
import { recipes } from "../data/recipes";
import type { RecipeDefinition } from "../data/types";
import { pick, between, clamp } from "../data/util";

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

type GuestState = "walkingIn" | "seated" | "waitingForFood" | "eating" | "walkingOut";

interface ActiveGuest {
  id: string;
  variantId: string; // "guest-v0".."guest-v6"
  state: GuestState;
  character: AnimatedCharacter;
  seatIndex: number;
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
}

const GUEST_VARIANT_IDS = ["guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6"];

// Where guests enter the room from (just outside the door)
const DOOR_POSITION = new THREE.Vector2(0, 5);
// Where guests exit to when leaving
const EXIT_POSITION = new THREE.Vector2(0, 6.5);

// 8 chair seats (matches the 2 dining tables in WorldScene)
const SEATS: { pos: THREE.Vector2; facingY: number }[] = [
  { pos: new THREE.Vector2(-2.9, 1.0), facingY:  Math.PI / 2 },  // left table, west chair
  { pos: new THREE.Vector2(-1.1, 1.0), facingY: -Math.PI / 2 },  // left table, east chair
  { pos: new THREE.Vector2(-2,   0.1), facingY:  Math.PI       }, // left table, north chair
  { pos: new THREE.Vector2(-2,   1.9), facingY:  0             }, // left table, south chair
  { pos: new THREE.Vector2( 1.1, 1.0), facingY:  Math.PI / 2 },  // right table, west chair
  { pos: new THREE.Vector2( 2.9, 1.0), facingY: -Math.PI / 2 },  // right table, east chair
  { pos: new THREE.Vector2( 2,   0.1), facingY:  Math.PI       }, // right table, north chair
  { pos: new THREE.Vector2( 2,   1.9), facingY:  0             }, // right table, south chair
];

const WALK_SPEED = 1.8; // world units / second
const ARRIVAL_THRESHOLD = 0.15;
const TIME_TO_ORDER = 3.0;
const TIME_TO_EAT = 8.0;
const SPAWN_INTERVAL_SECONDS = 6.0; // a new guest every N seconds if seats free
/** Guests give up if not served within this many seconds total. Scaled by
 * the recipe's cook time so slow recipes don't unfairly anger guests. */
const PATIENCE_BASE_SECONDS = 35;

/** Seats stay dirty for this many seconds after a guest leaves before a
 * new guest can sit. Adds a visible turnaround beat between meals. */
const SEAT_CLEAN_SECONDS = 4.0;

export class GuestSpawner {
  private readonly scene: THREE.Scene;
  private readonly characterLoader: CharacterLoader;
  private readonly animator: CharacterAnimator;
  private readonly game: Game;
  private readonly router: StaffRouter;
  private readonly guests: ActiveGuest[] = [];
  private occupiedSeats = new Set<number>();
  /** seatIndex → wall-clock seconds when the seat becomes clean again. */
  private dirtyUntil = new Map<number, number>();
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

  /** Per-frame tick. Spawns guests, advances their state machines, moves
   * characters toward their targets. */
  update(dt: number): void {
    this.elapsed += dt;
    this.spawnCooldown -= dt;
    // Expire dirty-seat timers — once a seat's cleanup window is up, it
    // becomes available to the next guest.
    if (this.dirtyUntil.size > 0) {
      for (const [seatIdx, cleanAt] of this.dirtyUntil) {
        if (cleanAt <= this.elapsed) this.dirtyUntil.delete(seatIdx);
      }
    }
    if (this.restaurantOpen && this.spawnCooldown <= 0 && this.countAvailableSeats() > 0) {
      void this.spawnGuest();
      // Boosted: spawn at double rate while the timer's running.
      const interval = this.game.isBoostActive()
        ? SPAWN_INTERVAL_SECONDS * 0.5
        : SPAWN_INTERVAL_SECONDS;
      this.spawnCooldown = interval;
    }

    // Tick each guest's state machine.
    for (let i = this.guests.length - 1; i >= 0; i -= 1) {
      const g = this.guests[i];
      this.tickPatience(g, dt);
      this.tickGuest(g, dt);
      // Remove guest if they finished walking out.
      if (g.state === "walkingOut" && this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
        this.despawnGuest(i);
      }
    }
  }

  /** Count down patience while the guest is waiting. If it hits zero they
   * give up: record a lost customer, ding the rating, and walk them out. */
  private tickPatience(g: ActiveGuest, dt: number): void {
    if (g.state !== "seated" && g.state !== "waitingForFood") return;
    g.patience -= dt;
    if (g.patience > 0) return;
    // Patience exhausted — angry exit.
    this.game.customers.recordLost(1);
    this.game.reputation.recordRating(1);
    g.character.action = "walk";
    g.target = EXIT_POSITION.clone();
    g.state = "walkingOut";
    g.stateClock = 0;
  }

  getActiveGuestCount(): number {
    return this.guests.length;
  }

  /** Count of seats that are neither occupied nor in the dirty-cleanup window. */
  private countAvailableSeats(): number {
    let n = 0;
    for (let i = 0; i < SEATS.length; i += 1) {
      if (!this.occupiedSeats.has(i) && !this.dirtyUntil.has(i)) n += 1;
    }
    return n;
  }

  private async spawnGuest(): Promise<void> {
    // Find a free seat that isn't currently being cleaned.
    let seatIndex = -1;
    for (let i = 0; i < SEATS.length; i += 1) {
      if (!this.occupiedSeats.has(i) && !this.dirtyUntil.has(i)) { seatIndex = i; break; }
    }
    if (seatIndex < 0) return;
    this.occupiedSeats.add(seatIndex);

    const variantId = pick(GUEST_VARIANT_IDS);
    const id = `guest-${this.nextGuestNum++}`;
    try {
      const model = await this.characterLoader.load(variantId);
      this.scene.add(model);
      const character: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(DOOR_POSITION.x, DOOR_POSITION.y),
        facingY: Math.PI, // facing into the room (negative Z)
        action: "walk",
        phase: Math.random() * 5,
        seatHeight: 0.5,
      };
      this.animator.add(character);

      this.guests.push({
        id,
        variantId,
        state: "walkingIn",
        character,
        seatIndex,
        target: SEATS[seatIndex].pos.clone(),
        stateClock: 0,
        order: [],
        orderIndex: 0,
        ticketId: null,
        patience: PATIENCE_BASE_SECONDS,
        totalPaid: 0,
        totalSatisfaction: 0,
      });
    } catch (err) {
      console.warn(`Could not spawn ${variantId}:`, err);
      this.occupiedSeats.delete(seatIndex);
    }
  }

  private despawnGuest(idx: number): void {
    const g = this.guests[idx];
    this.scene.remove(g.character.root);
    this.animator.remove(g.character.root);
    this.occupiedSeats.delete(g.seatIndex);
    // Seat needs cleanup before the next guest can use it. Pop a small
    // marker above the seat to show the player why it's not taking guests.
    this.dirtyUntil.set(g.seatIndex, this.elapsed + SEAT_CLEAN_SECONDS);
    const seat = SEATS[g.seatIndex];
    this.floatingText?.pop(seat.pos.x, seat.pos.y, "🧹 cleaning", "#f0c8a0");
    this.guests.splice(idx, 1);
  }

  private tickGuest(g: ActiveGuest, dt: number): void {
    g.stateClock += dt;

    switch (g.state) {
      case "walkingIn": {
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
          g.character.groundPos.copy(SEATS[g.seatIndex].pos);
          g.character.facingY = SEATS[g.seatIndex].facingY;
          g.character.action = "sit";
          g.state = "seated";
          g.stateClock = 0;
        }
        break;
      }
      case "seated": {
        // Brief moment to "look at menu" — then build a multi-course
        // order (1-3 dishes typically) and start the first course.
        if (g.stateClock >= TIME_TO_ORDER && g.order.length === 0) {
          g.order = this.buildOrder();
          if (g.order.length === 0) {
            this.markLostAndExit(g);
            break;
          }
          this.beginNextCourse(g);
        }
        break;
      }
      case "waitingForFood": {
        // Wait until the waiter delivers the current course's plate.
        if (this.router.popDeliveredFor(g.id)) {
          g.state = "eating";
          g.stateClock = 0;
        }
        break;
      }
      case "eating": {
        if (g.stateClock >= TIME_TO_EAT) {
          // Finished THIS course. Record payment + satisfaction.
          this.creditCourse(g);
          g.orderIndex += 1;
          if (g.orderIndex < g.order.length) {
            // Move to next course — go back to seated for a moment
            // (the guest considers what they ordered next, then waits).
            g.patience = PATIENCE_BASE_SECONDS;
            this.beginNextCourse(g);
          } else {
            // Full order complete — leave a single averaged rating + walk out.
            this.finalizeVisit(g);
            g.character.action = "walk";
            g.target = EXIT_POSITION.clone();
            g.state = "walkingOut";
            g.stateClock = 0;
          }
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
    const dx = g.target.x - pos.x;
    const dz = g.target.y - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return;
    const step = Math.min(dist, WALK_SPEED * dt);
    pos.x += (dx / dist) * step;
    pos.y += (dz / dist) * step;
    // Face the direction of motion (atan2 takes y, x of the screen-aligned vector)
    g.character.facingY = Math.atan2(dx, dz);
    g.character.action = "walk";
  }

  private distanceToTarget(g: ActiveGuest): number {
    return Math.hypot(g.target.x - g.character.groundPos.x, g.target.y - g.character.groundPos.y);
  }

  /** Pick a multi-course order (1-3 dishes) based on the guest's category
   * expectation. Tries to include an appetizer + main + dessert pattern when
   * possible; falls back to whatever's on menu. */
  private buildOrder(): RecipeDefinition[] {
    const menu = this.game.cooking.getMenuRecipeIds();
    const onMenu = menu.length > 0
      ? menu.map((id) => recipes.find((r) => r.id === id)).filter((r): r is RecipeDefinition => !!r)
      : recipes.filter((r) => r.unlockedByDefault);
    if (onMenu.length === 0) return [];
    const expectation = this.game.customers.rollCustomerExpectation();
    const order: RecipeDefinition[] = [];
    // 60% chance of trying for an appetizer.
    if (Math.random() < 0.6) {
      const apps = onMenu.filter((r) => r.category === "appetizer");
      if (apps.length > 0) order.push(apps[between(0, apps.length - 1)]);
    }
    // Always try for a main matching expectation (fallback: any main, then any).
    const matching = onMenu.filter((r) => r.category === expectation.category);
    const mains = matching.length > 0 ? matching : onMenu.filter((r) => r.category === "main");
    const mainPool = mains.length > 0 ? mains : onMenu;
    order.push(mainPool[between(0, mainPool.length - 1)]);
    // 35% chance of a dessert.
    if (Math.random() < 0.35) {
      const desserts = onMenu.filter((r) => r.category === "dessert");
      if (desserts.length > 0) order.push(desserts[between(0, desserts.length - 1)]);
    }
    return order;
  }

  /** Kick off the (next) course: consume ingredients + queue a ticket. */
  private beginNextCourse(g: ActiveGuest): void {
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
        g.target = EXIT_POSITION.clone();
        g.state = "walkingOut";
        g.stateClock = 0;
      }
      return;
    }
    this.game.cooking.consumeIngredients(recipe);
    g.ticketId = this.router.enqueueOrder(
      g.id, recipe.id, SEATS[g.seatIndex].pos, recipe.preparationTimeSeconds,
    );
    g.state = "waitingForFood";
    g.stateClock = 0;
  }


  /** Guest gives up (ran out of patience OR couldn't be served) — record
   * the loss + dock the rating, then walk them out. */
  private markLostAndExit(g: ActiveGuest): void {
    this.game.customers.recordLost(1);
    this.game.reputation.recordRating(1);
    this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, "-1★", "#ff9a9a");
    g.character.action = "walk";
    g.target = EXIT_POSITION.clone();
    g.state = "walkingOut";
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
    const avgSat = g.order.length > 0 ? g.totalSatisfaction / g.order.length : 4;
    const base = clamp(2 + avgSat / 2, 1, 5);
    const jitter = (Math.random() - 0.5) * 0.8;
    const rating = clamp(Math.round(base + jitter), 1, 5);
    this.game.reputation.recordRating(rating);

    // Tip: 0% at 1-2 stars, 5% at 3, 15% at 4, 30% at 5. Round to whole dollars.
    const tipMultByRating: Record<number, number> = { 1: 0, 2: 0, 3: 0.05, 4: 0.15, 5: 0.30 };
    const tip = Math.round(g.totalPaid * (tipMultByRating[rating] ?? 0));
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
