import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";

/**
 * Drives the errand-helper character so the auto-shop has a visible
 * "someone is doing the work" beat. Whenever the kitchen restocks an
 * ingredient, the helper walks from their home position to the front
 * door, pauses briefly (as if collecting the delivery), then walks back.
 *
 * Trips are queued — many auto-shop events fired in quick succession
 * stack into a single visible trip rather than spamming overlapping walks.
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

export class ErrandRouter {
  private readonly helper: ErrandActor;
  private readonly doorPos: THREE.Vector2;
  /** Pending trips. Each call to triggerRun() bumps this by 1; one trip
   * = one walk-to-door-and-back cycle. */
  private pendingTrips = 0;

  constructor(helperChar: AnimatedCharacter, doorPos: THREE.Vector2) {
    this.doorPos = doorPos.clone();
    this.helper = {
      character: helperChar,
      home: helperChar.groundPos.clone(),
      state: "idle",
      target: helperChar.groundPos.clone(),
      clock: 0,
    };
    // Override the default "carry" action — they're idle until called.
    helperChar.action = "idle";
  }

  /** Queue one trip to the door. Idempotent-safe: many calls just mean
   * more trips will play out one after another. */
  triggerRun(): void {
    // Cap so a long shortage doesn't queue 40 trips.
    this.pendingTrips = Math.min(this.pendingTrips + 1, 4);
  }

  update(dt: number): void {
    const h = this.helper;
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
    a.character.facingY = Math.atan2(dx, dz);
  }

  private distance(a: THREE.Vector2, b: THREE.Vector2): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
