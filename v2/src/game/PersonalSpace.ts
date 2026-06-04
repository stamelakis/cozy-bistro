import type { AnimatedCharacter } from "../scene/CharacterAnimator";

/**
 * Soft-body push pass so wandering characters (guests walking in/out,
 * pedestrians, errand helpers) don't overlap. Each frame, every pair
 * within MIN_DISTANCE gets a tiny lateral push apart.
 *
 * Seated characters and characters with a fixed working anchor (chefs
 * at the stove, waiters at the pickup spot) are excluded — they're
 * authoritative about their position.
 *
 * Phase I (perf) — replaced the naive O(N²) all-pairs loop with a
 * spatial hash.  At a busy restaurant + visible pedestrians, N can
 * reach 50-80 actors, which is 1225-3160 distance checks per frame
 * — measurable in the profile.  With cells of size MIN_DISTANCE,
 * any pair within range lives in the same or an adjacent cell, so
 * we check only the 3x3 neighbourhood per actor.  Drops worst-case
 * to O(N) for typical density.
 */

const MIN_DISTANCE = 0.55; // start pushing apart at this xz separation
const PUSH_STRENGTH = 0.9; // per second; multiplied by dt by caller
const CELL_SIZE = MIN_DISTANCE; // one cell per push-radius

export interface MovableActor {
  character: AnimatedCharacter;
  /** Skip-condition flag — true if this actor should NOT be pushed
   * (e.g. seated, cooking, stationary at home). */
  pinned?: boolean;
}

// Pre-allocated bucket map reused across calls — avoids per-frame
// Map churn (the static apply() method has no instance state, so the
// cache lives at module scope).  Bucket arrays inside are reset by
// length-assignment to 0 to keep their backing storage.
const bucketCache: Map<number, number[]> = new Map();
const freeBuckets: number[][] = [];

/** Pack two int16-range cell coords into a single int32 key.  Cell
 * indices for a 50 m-wide play area at 0.55 m cells fit in ±100 —
 * well inside int16 range. */
function cellKey(cx: number, cz: number): number {
  // Bias to non-negative, then pack: 16 high bits = cx, low = cz.
  return ((cx + 0x4000) << 15) | ((cz + 0x4000) & 0x7fff);
}

export class PersonalSpace {
  /** Push any two unpinned actors apart if they're within MIN_DISTANCE. */
  static apply(actors: readonly MovableActor[], dt: number): void {
    const n = actors.length;
    if (n < 2) return;

    // Reset buckets — return their arrays to the free pool so we
    // don't allocate fresh ones every frame.
    for (const arr of bucketCache.values()) {
      arr.length = 0;
      freeBuckets.push(arr);
    }
    bucketCache.clear();

    // Pass 1: bin every actor into its cell.  We bin pinned actors
    // too so unpinned actors find them as collision partners (a
    // walking guest can still bump into a seated patron's edge of
    // the chair zone).
    for (let i = 0; i < n; i += 1) {
      const a = actors[i];
      const cx = Math.floor(a.character.groundPos.x / CELL_SIZE);
      const cz = Math.floor(a.character.groundPos.y / CELL_SIZE);
      const k = cellKey(cx, cz);
      let bucket = bucketCache.get(k);
      if (!bucket) {
        bucket = freeBuckets.pop() ?? [];
        bucketCache.set(k, bucket);
      }
      bucket.push(i);
    }

    // Pass 2: scan each unpinned actor's 3x3 neighbourhood.  Skip
    // pair (j ≤ i) so we only process each unordered pair once.
    const minSq = MIN_DISTANCE * MIN_DISTANCE;
    for (let i = 0; i < n; i += 1) {
      const a = actors[i];
      if (a.pinned) continue;
      const ax = a.character.groundPos.x;
      const az = a.character.groundPos.y;
      const cx = Math.floor(ax / CELL_SIZE);
      const cz = Math.floor(az / CELL_SIZE);

      for (let dxCell = -1; dxCell <= 1; dxCell += 1) {
        for (let dzCell = -1; dzCell <= 1; dzCell += 1) {
          const bucket = bucketCache.get(cellKey(cx + dxCell, cz + dzCell));
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi += 1) {
            const j = bucket[bi];
            if (j <= i) continue; // dedupe pairs + skip self
            const b = actors[j];
            if (b.pinned) continue;
            const bx = b.character.groundPos.x;
            const bz = b.character.groundPos.y;
            const dx = ax - bx;
            const dz = az - bz;
            const distSq = dx * dx + dz * dz;
            if (distSq >= minSq) continue;
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
  }
}
