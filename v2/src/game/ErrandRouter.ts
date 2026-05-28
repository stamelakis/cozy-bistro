import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";

/**
 * Drives the errand-helper characters so the auto-shop has a visible
 * "someone is doing the work" beat. Whenever the kitchen restocks an
 * ingredient, the next idle helper walks from their home position to
 * the front door, pauses briefly (as if collecting the delivery), then
 * walks back.
 *
 * Trips are queued — many auto-shop events fired in quick succession
 * stack into a single visible trip rather than spamming overlapping
 * walks. Multiple helpers in the pool each peel one trip off the
 * queue, so a busy kitchen with extra helpers chews through pending
 * deliveries in parallel.
 */

interface ErrandActor {
  character: AnimatedCharacter;
  home: THREE.Vector2;
  state: "idle" | "walkingToDoor" | "atDoor" | "returningHome";
  target: THREE.Vector2;
  clock: number;
}

const WALK_SPEED = 2.4; // a hair faster than other staff
const ARRIVAL_THRESHOLD = 0.18;
/** Pause at door (seconds) to suggest picking up the delivery. */
const DOOR_DWELL_SECONDS = 0.8;
/** Cap on queued trips so a long shortage doesn't queue dozens. */
const MAX_PENDING_TRIPS = 6;

export class ErrandRouter {
  private readonly helpers: ErrandActor[] = [];
  private readonly doorPos: THREE.Vector2;
  /** Pending trips. Each idle helper consumes one per tick. */
  private pendingTrips = 0;

  constructor(helperChar: AnimatedCharacter, doorPos: THREE.Vector2) {
    this.doorPos = doorPos.clone();
    this.addHelper(helperChar);
  }

  addHelper(char: AnimatedCharacter): void {
    char.action = "idle"; // override the default "carry" pose
    this.helpers.push({
      character: char,
      home: char.groundPos.clone(),
      state: "idle",
      target: char.groundPos.clone(),
      clock: 0,
    });
  }

  /** Pop one helper out of the pool. Prefers an idle helper so we don't
   * abandon a trip mid-flight. Returns the character so Engine can drop
   * its model from the scene. */
  removeHelper(): AnimatedCharacter | null {
    if (this.helpers.length === 0) return null;
    const idleIdx = this.helpers.findIndex((h) => h.state === "idle");
    const idx = idleIdx >= 0 ? idleIdx : this.helpers.length - 1;
    const removed = this.helpers[idx];
    this.helpers.splice(idx, 1);
    return removed.character;
  }

  getHelperCount(): number { return this.helpers.length; }

  /** Snapshot for the status-bubble layer. */
  snapshotStatus(): { character: AnimatedCharacter; label: string }[] {
    return this.helpers.map((h) => ({
      character: h.character,
      label: errandLabel(h.state),
    }));
  }

  /** Queue one trip to the door. */
  triggerRun(): void {
    this.pendingTrips = Math.min(this.pendingTrips + 1, MAX_PENDING_TRIPS);
  }

  update(dt: number): void {
    for (const h of this.helpers) this.tickHelper(h, dt);
  }

  private tickHelper(h: ErrandActor, dt: number): void {
    h.clock += dt;

    switch (h.state) {
      case "idle": {
        if (this.pendingTrips > 0) {
          this.pendingTrips -= 1;
          h.target = this.doorPos.clone();
          h.state = "walkingToDoor";
          h.clock = 0;
          h.character.action = "walk";
        }
        break;
      }
      case "walkingToDoor": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
          h.state = "atDoor";
          h.clock = 0;
          h.character.action = "idle";
        }
        break;
      }
      case "atDoor": {
        if (h.clock >= DOOR_DWELL_SECONDS) {
          h.target = h.home.clone();
          h.state = "returningHome";
          h.clock = 0;
          // Carry pose on the way back — they're holding the delivery.
          h.character.action = "carry";
        }
        break;
      }
      case "returningHome": {
        this.moveActor(h, dt);
        if (this.distance(h.character.groundPos, h.target) < ARRIVAL_THRESHOLD) {
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

function errandLabel(state: ErrandActor["state"]): string {
  switch (state) {
    case "walkingToDoor": return "📦 fetching";
    case "atDoor":        return "📦 at door";
    case "returningHome": return "📦 returning";
    default:              return "";
  }
}
