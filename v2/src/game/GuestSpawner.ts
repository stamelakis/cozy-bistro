import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Game } from "./Game";
import type { StaffRouter } from "./StaffRouter";
import type { FloatingText } from "../ui/FloatingText";
import { recipes } from "../data/recipes";
import type { RecipeDefinition } from "../data/types";
import { pick, between, clamp } from "../data/util";
import { type CustomerArchetype, rollArchetype } from "../data/customerArchetypes";

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
  // Personality archetype rolled on spawn. Affects patience, order size,
  // and tip multiplier.
  archetype: CustomerArchetype;
}

const GUEST_VARIANT_IDS = ["guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6"];

// Where guests enter the room from (just outside the door)
const DOOR_POSITION = new THREE.Vector2(0, 5);
// Where guests exit to when leaving
const EXIT_POSITION = new THREE.Vector2(0, 6.5);

// 8 chair seats (matches the 2 dining tables in WorldScene). platePos is
// where the food plate appears on the table in front of this seat.
const SEATS: { pos: THREE.Vector2; facingY: number; platePos: THREE.Vector2 }[] = [
  { pos: new THREE.Vector2(-2.9, 1.0), facingY:  Math.PI / 2, platePos: new THREE.Vector2(-2.45, 1.0) }, // left table, west chair
  { pos: new THREE.Vector2(-1.1, 1.0), facingY: -Math.PI / 2, platePos: new THREE.Vector2(-1.55, 1.0) }, // left table, east chair
  { pos: new THREE.Vector2(-2,   0.1), facingY:  Math.PI,     platePos: new THREE.Vector2(-2.0,  0.55) }, // left table, north chair
  { pos: new THREE.Vector2(-2,   1.9), facingY:  0,           platePos: new THREE.Vector2(-2.0,  1.45) }, // left table, south chair
  { pos: new THREE.Vector2( 1.1, 1.0), facingY:  Math.PI / 2, platePos: new THREE.Vector2( 1.55, 1.0) },  // right table, west chair
  { pos: new THREE.Vector2( 2.9, 1.0), facingY: -Math.PI / 2, platePos: new THREE.Vector2( 2.45, 1.0) },  // right table, east chair
  { pos: new THREE.Vector2( 2,   0.1), facingY:  Math.PI,     platePos: new THREE.Vector2( 2.0,  0.55) },  // right table, north chair
  { pos: new THREE.Vector2( 2,   1.9), facingY:  0,           platePos: new THREE.Vector2( 2.0,  1.45) },  // right table, south chair
];
/** Approximate table-surface height (Kenney small-table) used for plate Y. */
const TABLE_HEIGHT_Y = 0.52;

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

/** Per-state guest label for the status-bubble layer. Returns empty
 * string while walking in/out (the bubble layer hides empty labels).
 * Prefixes the archetype emoji so the player can tell who's who. */
function guestLabel(g: ActiveGuest): string {
  const prefix = g.archetype.shortLabel;
  switch (g.state) {
    case "walkingIn":      return "";
    case "seated":         return g.order.length === 0 ? `${prefix} 📋` : `${prefix} ⏳`;
    case "waitingForFood": {
      // Show patience countdown so the player feels the urgency.
      const secs = Math.max(0, Math.ceil(g.patience));
      return `${prefix} ⏳ ${secs}s`;
    }
    case "eating":         return `${prefix} 🍴`;
    case "walkingOut":     return "";
  }
}

/** Cheap color hash so different recipes look different on the plate
 * without us shipping per-recipe textures. */
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
  private occupiedSeats = new Set<number>();
  /** seatIndex → wall-clock seconds when the seat becomes clean again. */
  private dirtyUntil = new Map<number, number>();
  /** guestId → live Object3D for the plate sitting on their table.
   * Spawned when food is delivered, removed when the guest stands up. */
  private readonly tablePlates = new Map<string, THREE.Object3D>();
  /** Shared plate geometry/material so we don't re-allocate per plate. */
  private static plateGeo?: THREE.CylinderGeometry;
  private static plateMat?: THREE.MeshStandardMaterial;
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
      // Apply weather multiplier first, then halve if a paid boost is on.
      // Weather values >1 slow spawning (rainy), <1 speed it up (festival).
      const weatherMult = this.game.weather.getCurrent().spawnRateMultiplier;
      const boostMult = this.game.isBoostActive() ? 0.5 : 1;
      this.spawnCooldown = SPAWN_INTERVAL_SECONDS * weatherMult * boostMult;
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

  /** Snapshot used by the UI status-bubble layer. Returns one entry per
   * guest with a label + a panic flag so the bubble can flash red. */
  snapshotStatus(): { id: string; character: AnimatedCharacter; label: string; panic: boolean }[] {
    return this.guests.map((g) => ({
      id: g.id,
      character: g.character,
      label: guestLabel(g),
      panic: (g.state === "seated" || g.state === "waitingForFood") && g.patience < 12,
    }));
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

      const archetype = rollArchetype();
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
        patience: PATIENCE_BASE_SECONDS * archetype.patienceMultiplier,
        totalPaid: 0,
        totalSatisfaction: 0,
        archetype,
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
    // Clear any plate left on their table when they walk out.
    this.removePlateForGuest(g.id);
    // Seat needs cleanup before the next guest can use it. Pop a small
    // marker above the seat to show the player why it's not taking guests.
    this.dirtyUntil.set(g.seatIndex, this.elapsed + SEAT_CLEAN_SECONDS);
    const seat = SEATS[g.seatIndex];
    this.floatingText?.pop(seat.pos.x, seat.pos.y, "🧹 cleaning", "#f0c8a0");
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
    const seat = SEATS[g.seatIndex];
    plate.position.set(seat.platePos.x, TABLE_HEIGHT_Y, seat.platePos.y);
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
          g.order = this.buildOrder(g.archetype);
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
          this.showPlateForGuest(g);
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
   * possible; falls back to whatever's on menu. The archetype's orderSizeBias
   * shifts appetizer/dessert chances up (foodies, dates) or down (quick lunch). */
  private buildOrder(archetype: CustomerArchetype): RecipeDefinition[] {
    const menu = this.game.cooking.getMenuRecipeIds();
    const onMenu = menu.length > 0
      ? menu.map((id) => recipes.find((r) => r.id === id)).filter((r): r is RecipeDefinition => !!r)
      : recipes.filter((r) => r.unlockedByDefault);
    if (onMenu.length === 0) return [];
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
