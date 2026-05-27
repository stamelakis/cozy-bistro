import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Game } from "./Game";
import type { StaffRouter } from "./StaffRouter";
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
  // The recipe they ordered (null until seated long enough to order).
  recipe: RecipeDefinition | null;
  // The ticket id from the StaffRouter (null until ordered).
  ticketId: string | null;
  // Seconds remaining before guest gives up and leaves angry. Counts down
  // only while waiting (seated/waitingForFood). Resets on eating.
  patience: number;
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

export class GuestSpawner {
  private readonly scene: THREE.Scene;
  private readonly characterLoader: CharacterLoader;
  private readonly animator: CharacterAnimator;
  private readonly game: Game;
  private readonly router: StaffRouter;
  private readonly guests: ActiveGuest[] = [];
  private occupiedSeats = new Set<number>();
  private spawnCooldown = 1.0;
  private nextGuestNum = 0;
  /** Set false to stop new guests from arriving. Already-seated guests
   * finish their meal regardless. */
  restaurantOpen = true;

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
    this.spawnCooldown -= dt;
    if (this.restaurantOpen && this.spawnCooldown <= 0 && this.occupiedSeats.size < SEATS.length) {
      void this.spawnGuest();
      this.spawnCooldown = SPAWN_INTERVAL_SECONDS;
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

  private async spawnGuest(): Promise<void> {
    // Find a free seat.
    let seatIndex = -1;
    for (let i = 0; i < SEATS.length; i += 1) {
      if (!this.occupiedSeats.has(i)) { seatIndex = i; break; }
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
        recipe: null,
        ticketId: null,
        patience: PATIENCE_BASE_SECONDS,
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
        // Brief moment to "look at menu" — then place order with the
        // kitchen via the StaffRouter ticket queue.
        if (g.stateClock >= TIME_TO_ORDER && g.recipe == null) {
          g.recipe = this.pickRecipe();
          if (g.recipe == null) {
            // Nothing on menu — guest walks out unhappy.
            this.markLostAndExit(g);
            break;
          }
          // Consume ingredients up front (mirror's the 2D version's
          // pre-deduct behavior, so we don't double-promise stock).
          if (!this.game.cooking.canFulfillRecipe(g.recipe)) {
            this.markLostAndExit(g);
            break;
          }
          this.game.cooking.consumeIngredients(g.recipe);
          g.ticketId = this.router.enqueueOrder(
            g.id,
            g.recipe.id,
            SEATS[g.seatIndex].pos,
            g.recipe.preparationTimeSeconds,
          );
          g.state = "waitingForFood";
          g.stateClock = 0;
        }
        break;
      }
      case "waitingForFood": {
        // Wait until the waiter delivers the plate.
        if (this.router.popDeliveredFor(g.id)) {
          g.state = "eating";
          g.stateClock = 0;
        }
        break;
      }
      case "eating": {
        if (g.stateClock >= TIME_TO_EAT) {
          // Pay & leave.
          this.collectPayment(g);
          g.character.action = "walk";
          g.target = EXIT_POSITION.clone();
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

  private pickRecipe(): RecipeDefinition | null {
    const menu = this.game.cooking.getMenuRecipeIds();
    const onMenu = menu.length > 0
      ? menu.map((id) => recipes.find((r) => r.id === id)).filter((r): r is RecipeDefinition => !!r)
      : recipes.filter((r) => r.unlockedByDefault);
    if (onMenu.length === 0) return null;

    // CustomerSystem rolls a category expectation per arrival; honour it
    // when at least one recipe in that category is on the menu, otherwise
    // fall back to a random on-menu recipe.
    const expectation = this.game.customers.rollCustomerExpectation();
    const matching = onMenu.filter((r) => r.category === expectation.category);
    const candidates = matching.length > 0 ? matching : onMenu;
    return candidates[between(0, candidates.length - 1)];
  }

  /** Guest gives up (ran out of patience OR couldn't be served) — record
   * the loss + dock the rating, then walk them out. */
  private markLostAndExit(g: ActiveGuest): void {
    this.game.customers.recordLost(1);
    this.game.reputation.recordRating(1);
    g.character.action = "walk";
    g.target = EXIT_POSITION.clone();
    g.state = "walkingOut";
    g.stateClock = 0;
  }

  private collectPayment(g: ActiveGuest): void {
    if (!g.recipe) return;
    // Real recipe price (was a flat $18 placeholder before).
    this.game.economy.earnMoney(g.recipe.sellPrice, "payment");
    this.game.customers.recordServed(1);

    // Satisfaction-based rating: recipe.satisfactionEffect 4-7 = base of
    // ~3-5 stars. Slight random jitter so each guest isn't identical.
    const base = clamp(2 + g.recipe.satisfactionEffect / 2, 1, 5);
    const jitter = (Math.random() - 0.5) * 0.8;
    const rating = clamp(Math.round(base + jitter), 1, 5);
    this.game.reputation.recordRating(rating);
  }
}
