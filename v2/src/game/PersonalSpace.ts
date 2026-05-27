import type { AnimatedCharacter } from "../scene/CharacterAnimator";

/**
 * Soft-body push pass so wandering characters (guests walking in/out,
 * pedestrians, errand helpers) don't overlap. Each frame, every pair
 * within MIN_DISTANCE gets a tiny lateral push apart.
 *
 * Seated characters and characters with a fixed working anchor (chefs
 * at the stove, waiters at the pickup spot) are excluded — they're
 * authoritative about their position.
 */

const MIN_DISTANCE = 0.55; // start pushing apart at this xz separation
const PUSH_STRENGTH = 0.9; // per second; multiplied by dt by caller

export interface MovableActor {
  character: AnimatedCharacter;
  /** Skip-condition flag — true if this actor should NOT be pushed
   * (e.g. seated, cooking, stationary at home). */
  pinned?: boolean;
}

export class PersonalSpace {
  /** Push any two unpinned actors apart if they're within MIN_DISTANCE. */
  static apply(actors: readonly MovableActor[], dt: number): void {
    const n = actors.length;
    for (let i = 0; i < n; i += 1) {
      const a = actors[i];
      if (a.pinned) continue;
      for (let j = i + 1; j < n; j += 1) {
        const b = actors[j];
        if (b.pinned) continue;
        const ax = a.character.groundPos.x, az = a.character.groundPos.y;
        const bx = b.character.groundPos.x, bz = b.character.groundPos.y;
        const dx = ax - bx, dz = az - bz;
        const distSq = dx * dx + dz * dz;
        if (distSq >= MIN_DISTANCE * MIN_DISTANCE) continue;
        const dist = Math.max(0.001, Math.sqrt(distSq));
        // Push each one half the overlap distance.
        const overlap = MIN_DISTANCE - dist;
        const pushX = (dx / dist) * overlap * 0.5 * PUSH_STRENGTH * dt;
        const pushZ = (dz / dist) * overlap * 0.5 * PUSH_STRENGTH * dt;
        a.character.groundPos.x += pushX;
        a.character.groundPos.y += pushZ;
        b.character.groundPos.x -= pushX;
        b.character.groundPos.y -= pushZ;
      }
    }
  }
}
