import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter } from "../scene/CharacterAnimator";
import type { Game } from "./Game";
import type { StaffRouter } from "./StaffRouter";
import type { FloatingText } from "../ui/FloatingText";
import type { SfxPlayer } from "../ui/SfxPlayer";
import type { FurnitureRegistry, ResolvedSeatSlot } from "./FurnitureRegistry";
import { recipes } from "../data/recipes";
import type { RecipeDefinition } from "../data/types";
import { pick, between, clamp } from "../data/util";
import { type CustomerArchetype, rollArchetype } from "../data/customerArchetypes";

/** Stable seat identifier: `${tableUid}#${slotIndex}`. Lets a seated guest
 * remember their slot even when other seats are added/removed by player
 * placement edits. */
type SeatId = string;
function makeSeatId(slot: ResolvedSeatSlot): SeatId {
  return `${slot.tableUid}#${slot.slotIndex}`;
}

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
  | "seated" | "waitingForFood" | "eating" | "walkingOut" | "walkingToDoor";

interface ActiveGuest {
  id: string;
  variantId: string; // "guest-v0".."guest-v6"
  state: GuestState;
  character: AnimatedCharacter;
  /** Stable id of the seat slot this guest is assigned to (or empty if
   * no functional seat was available and they were waitlisted). */
  seatId: SeatId;
  /** Latest cached pose of that seat in world space — refreshed each frame
   * via FurnitureRegistry so the guest follows even if the table is moved. */
  seatPos: THREE.Vector2;
  seatFacingY: number;
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
  // Personality archetype rolled on spawn. Affects patience, order size,
  // and tip multiplier.
  archetype: CustomerArchetype;
}

const GUEST_VARIANT_IDS = ["guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6"];

// Where guests enter the room from (just outside the door)
const DOOR_POSITION = new THREE.Vector2(0, 5);
// Where guests exit to when leaving
const EXIT_POSITION = new THREE.Vector2(0, 6.5);

/** Table-surface height (table.glb at S_TABLE=1.9 in the catalog). */
const TABLE_HEIGHT_Y = 0.95;

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
    case "walkingToWait":  return `${prefix} ⏳`;
    case "waitingForSeat": {
      const secs = g.waiting ? Math.max(0, Math.ceil(g.waiting.timeLeft)) : 0;
      return `${prefix} 🪑 ${secs}s`;
    }
    case "seated":         return g.order.length === 0 ? `${prefix} 📋` : `${prefix} ⏳`;
    case "waitingForFood": {
      // Show patience countdown so the player feels the urgency.
      const secs = Math.max(0, Math.ceil(g.patience));
      return `${prefix} ⏳ ${secs}s`;
    }
    case "eating":         return `${prefix} 🍴`;
    case "walkingToDoor":  return "";
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
  /** seatId ("tableUid#slotIndex") → reserved. Cleared on guest leave. */
  private occupiedSeats = new Set<SeatId>();
  /** seatId → wall-clock seconds when the seat becomes clean again. */
  private dirtyUntil = new Map<SeatId, number>();
  /** chairUid → guestId that's currently waiting at it. Cleared when the
   * waiting guest either takes a real seat or gives up. */
  private claimedWaitingChairs = new Map<string, string>();
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
  /** Optional: procedural sound cues on guest arrival / serve / leave / etc. */
  sfx?: SfxPlayer;
  /** Optional: registry of placed furniture. When provided, its stats
   * scale spawn rate, satisfaction, and rating. */
  registry?: FurnitureRegistry;

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
    if (this.restaurantOpen && this.spawnCooldown <= 0 && (this.countAvailableSeats() > 0 || this.canAcceptWaitingGuest())) {
      void this.spawnGuest();
      // Apply weather multiplier first, then halve if a paid boost is on.
      // Weather values >1 slow spawning (rainy), <1 speed it up (festival).
      const weatherMult = this.game.weather.getCurrent().spawnRateMultiplier;
      const boostMult = this.game.isBoostActive() ? 0.5 : 1;
      // Furniture attractionBonus speeds up spawning (capped so a hoarder
      // with 100 plants doesn't break the game).
      const attraction = this.registry?.getAggregateStats().attractionBonus ?? 0;
      const attractionMult = Math.max(0.45, 1 - Math.min(0.55, attraction * 0.015));
      // AdminPanel spawn-rate multiplier (1 = default).
      const adminMult = this.game.admin.spawnRateMultiplier;
      this.spawnCooldown = SPAWN_INTERVAL_SECONDS * weatherMult * boostMult * attractionMult * adminMult;
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
    // Patience exhausted — angry exit. Route via the door.
    this.game.customers.recordLost(1);
    this.game.reputation.recordRating(1);
    g.character.action = "walk";
    g.target = DOOR_POSITION.clone();
    g.state = "walkingToDoor";
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

  /** Snapshot for the PersonalSpace pass. Guests are pinned while seated;
   * walking guests are pushable. */
  snapshotMovable(): { character: AnimatedCharacter; pinned: boolean }[] {
    return this.guests.map((g) => ({
      character: g.character,
      pinned: g.state === "seated" || g.state === "waitingForFood" || g.state === "eating" || g.state === "waitingForSeat",
    }));
  }

  /** All functional seats (table seat slots with a correctly-placed chair)
   * across every visible table. Empty list if no registry yet. */
  private listFunctionalSeats(): ResolvedSeatSlot[] {
    if (!this.registry) return [];
    return this.registry.getResolvedSeatSlots(true).filter((s) => s.chairUid != null);
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
    for (const g of this.guests) {
      const slot = byId.get(g.seatId);
      if (!slot) {
        // Table sold under them. Walk them out gracefully.
        if (g.state === "seated" || g.state === "waitingForFood" || g.state === "eating") {
          g.target = DOOR_POSITION.clone();
          g.state = "walkingToDoor";
          g.character.action = "walk";
          g.stateClock = 0;
        }
        continue;
      }
      g.seatPos.set(slot.x, slot.z);
      g.seatFacingY = slot.facingY;
      g.platePos.set(slot.platePos.x, slot.platePos.z);
      if (g.state === "walkingIn") {
        g.target.copy(g.seatPos);
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
   * and route them over. Also expire waiting guests whose timer ran out. */
  private promoteWaitingGuests(): void {
    for (const g of this.guests) {
      if (!g.waiting) continue;
      // Time-out → angry exit.
      if (g.waiting.timeLeft <= 0 && g.state === "waitingForSeat") {
        this.claimedWaitingChairs.delete(g.waiting.chairUid);
        g.waiting = undefined;
        this.game.customers.recordLost(1);
        this.game.reputation.recordRating(1);
        this.floatingText?.pop(g.character.groundPos.x, g.character.groundPos.y, "-1★ (gave up)", "#ff9a9a");
        g.character.action = "walk";
        g.target = DOOR_POSITION.clone();
        g.state = "walkingToDoor";
        g.stateClock = 0;
        continue;
      }
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
      g.state = "walkingIn"; // reuse the existing walk-to-seat handler
      g.character.action = "walk";
      g.stateClock = 0;
    }
  }

  private async spawnGuest(): Promise<void> {
    // Prefer a real functional seat. If none, fall back to an overflow
    // chair (yellow) when attractiveness allows.
    const available = this.listFunctionalSeats().find((s) => {
      const id = makeSeatId(s);
      return !this.occupiedSeats.has(id) && !this.dirtyUntil.has(id);
    });
    const waitingChair = available ? null : this.findFreeOverflowChair();
    if (!available && !waitingChair) return;
    let seatId: SeatId = "";
    if (available) {
      seatId = makeSeatId(available);
      this.occupiedSeats.add(seatId);
    } else if (waitingChair) {
      this.claimedWaitingChairs.set(waitingChair.uid, "pending");
    }

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
        // Seat surface height (Kenney chair at S_CHAIR=1.7).
        seatHeight: 0.62,
      };
      this.animator.add(character);

      const archetype = rollArchetype();
      // Loud announcement for a food critic so the player knows to ace it.
      if (archetype.id === "critic") {
        this.floatingText?.pop(DOOR_POSITION.x, DOOR_POSITION.y, "🕵️ FOOD CRITIC!", "#ffd966");
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
      const targetPos = seatPos.clone();
      const guest: ActiveGuest = {
        id,
        variantId,
        state: available ? "walkingIn" : "walkingToWait",
        character,
        seatId,
        seatPos,
        seatFacingY: seatFacing,
        platePos,
        target: targetPos,
        stateClock: 0,
        order: [],
        orderIndex: 0,
        ticketId: null,
        patience: PATIENCE_BASE_SECONDS * archetype.patienceMultiplier,
        totalPaid: 0,
        totalSatisfaction: 0,
        archetype,
      };
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
    } catch (err) {
      console.warn(`Could not spawn ${variantId}:`, err);
      if (seatId) this.occupiedSeats.delete(seatId);
      if (waitingChair) this.claimedWaitingChairs.delete(waitingChair.uid);
    }
  }

  private despawnGuest(idx: number): void {
    const g = this.guests[idx];
    this.scene.remove(g.character.root);
    this.animator.remove(g.character.root);
    if (g.waiting) {
      // Waiting-overflow guests free their yellow chair, not a real seat.
      this.claimedWaitingChairs.delete(g.waiting.chairUid);
    } else if (g.seatId) {
      this.occupiedSeats.delete(g.seatId);
      // Real seat needs cleanup before the next guest can use it.
      this.dirtyUntil.set(g.seatId, this.elapsed + SEAT_CLEAN_SECONDS);
      this.floatingText?.pop(g.seatPos.x, g.seatPos.y, "🧹 cleaning", "#f0c8a0");
    }
    // Clear any plate left on their table when they walk out.
    this.removePlateForGuest(g.id);
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
    plate.position.set(g.platePos.x, TABLE_HEIGHT_Y, g.platePos.y);
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
          g.character.groundPos.copy(g.seatPos);
          g.character.facingY = g.seatFacingY;
          g.character.action = "sit";
          g.state = "seated";
          g.stateClock = 0;
        }
        break;
      }
      case "walkingToWait": {
        // Walking to a yellow / overflow chair.
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD && g.waiting) {
          g.character.groundPos.copy(g.waiting.chairPos);
          // Yellow chairs aren't ideally oriented; flip the chair's rotation
          // through the seat-direction relation so the guest faces "outward"
          // from the chair (good enough — they're just waiting).
          g.character.facingY = Math.PI - g.waiting.chairFacingY;
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
          this.sfx?.chime();
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
            // Full order complete — leave a single averaged rating + walk out via the door.
            this.finalizeVisit(g);
            g.character.action = "walk";
            g.target = DOOR_POSITION.clone();
            g.state = "walkingToDoor";
            g.stateClock = 0;
          }
        }
        break;
      }
      case "walkingToDoor": {
        // Walk to the door cell first so the guest passes through the
        // 1-tile gap in the front wall, then switch to walking-out.
        this.moveToward(g, dt);
        if (this.distanceToTarget(g) < ARRIVAL_THRESHOLD) {
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
    // Face the direction of motion. Convention: facingY=0 → -Z, π/2 → +X,
    // π → +Z, -π/2 → -X. atan2(dx, -dz) maps motion vector to facing.
    g.character.facingY = Math.atan2(dx, -dz);
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
        g.target = DOOR_POSITION.clone();
        g.state = "walkingToDoor";
        g.stateClock = 0;
      }
      return;
    }
    this.game.cooking.consumeIngredients(recipe);
    g.ticketId = this.router.enqueueOrder(
      g.id, recipe.id, g.seatPos, recipe.preparationTimeSeconds,
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
    this.sfx?.thud();
    g.character.action = "walk";
    g.target = DOOR_POSITION.clone();
    g.state = "walkingToDoor";
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
    const avgSat = g.order.length > 0 ? g.totalSatisfaction / g.order.length : 4;
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
    const jitter = (Math.random() - 0.5) * 0.8;
    const rating = clamp(Math.round(base + jitter), 1, 5);
    // Each course they ate becomes a dirty dish in the wash queue.
    this.game.addDirtyDish(g.orderIndex);
    // Food critics swing the rating average harder. Record their rating
    // three times — same direction, triple weight on overall reputation.
    const ratingsToRecord = g.archetype.id === "critic" ? 3 : 1;
    for (let i = 0; i < ratingsToRecord; i += 1) {
      this.game.reputation.recordRating(rating);
    }

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
