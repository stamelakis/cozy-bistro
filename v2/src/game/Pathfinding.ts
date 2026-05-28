import * as THREE from "three";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { footprintCells } from "./FurnitureRegistry";

/**
 * Tile-based A* pathfinding so staff and customers walk around placed
 * furniture instead of through it. The grid is one cell per restaurant
 * tile (10×10 with the building shifted to (0.5, 0.5)) and recomputed
 * lazily by querying the FurnitureRegistry for blocking items each
 * time a path is requested.
 *
 * Blocking rule of thumb:
 *   - tables, chairs, stoves, counters, bathroom fixtures, kitchen
 *     decoration → block their cells
 *   - rugs, wall-mounted items, edge walls (no tile claim) → don't
 *     block
 *
 * The GOAL cell is treated as walkable even if it's blocked. That way
 * a customer can walk TO a chair (whose cell is blocked) without the
 * pathfinder refusing to route there.
 */

export interface PlacedItem {
  defId: string;
  x: number;
  z: number;
}

export type PathStep = THREE.Vector2;

/** Grid bounds inside the restaurant — cells (x, z) with both axes in
 * [-4, 5]. The building's exterior walls sit at half-integer
 * coordinates, so the playable tiles are exactly these 100. */
const GRID_MIN = -4;
const GRID_MAX = 5;

/** Search cap so a degenerate query (e.g. impossible goal in a fully
 * enclosed room) doesn't hang the frame. 500 nodes is plenty for a
 * 10×10 grid; anything beyond that is almost certainly a bug. */
const MAX_ITERATIONS = 500;

/** Distance below which the actor is considered "at" a waypoint and
 * the path advances. */
export const PATH_ARRIVAL_THRESHOLD = 0.2;

export class Pathfinding {
  constructor(private readonly getItems: () => readonly PlacedItem[]) {}

  /** Find a tile-aligned path from (fromX, fromZ) to (toX, toZ). The
   * returned array ALWAYS ends at the requested destination (not the
   * snapped cell center) so the actor lands exactly where the caller
   * asked. Returns a single-step direct path when no obstacles are in
   * the way and a multi-step route otherwise. Returns `[final]` as a
   * safe fallback if no path can be found at all — letting the actor
   * still attempt the move keeps the game from soft-locking when a
   * tight enclosure occasionally traps someone. */
  findPath(fromX: number, fromZ: number, toX: number, toZ: number): PathStep[] {
    const startX = Math.round(fromX);
    const startZ = Math.round(fromZ);
    const goalX = Math.round(toX);
    const goalZ = Math.round(toZ);
    const finalTarget = new THREE.Vector2(toX, toZ);

    if (startX === goalX && startZ === goalZ) return [finalTarget];

    const { cells: blocked, edges: blockedEdges } = this.computeBlocked();
    // Direct-line shortcut: if the two cells are colinear and the
    // intermediate cells are clear, skip A* entirely. Common case for
    // short trips with no obstacles between. We disable it whenever
    // any partition wall is in play — Bresenham steps can cross wall
    // edges diagonally and there's no safe way to interrogate that
    // without re-implementing the neighbour loop here, so we just
    // fall through to A* in that case.
    if (blockedEdges.size === 0 && this.directLineClear(startX, startZ, goalX, goalZ, blocked)) {
      return [finalTarget];
    }

    type Node = { x: number; z: number; f: number };
    const open: Node[] = [];
    const gScore = new Map<string, number>();
    const came = new Map<string, string>();
    const key = (x: number, z: number) => `${x},${z}`;
    const startKey = key(startX, startZ);
    const goalKey = key(goalX, goalZ);
    gScore.set(startKey, 0);
    open.push({ x: startX, z: startZ, f: heuristic(startX, startZ, goalX, goalZ) });

    let iter = 0;
    while (open.length > 0 && iter < MAX_ITERATIONS) {
      iter += 1;
      // Pop lowest-f node (linear scan — 100 cells max, sort isn't
      // worth the constant factor).
      let bestIdx = 0;
      for (let i = 1; i < open.length; i += 1) {
        if (open[i].f < open[bestIdx].f) bestIdx = i;
      }
      const current = open.splice(bestIdx, 1)[0];
      const currKey = key(current.x, current.z);

      if (currKey === goalKey) return reconstruct(came, startKey, goalKey, finalTarget);

      // 4-connected neighbours. 8-connected would let actors cut
      // corners through diagonally-touching obstacles, which looks bad.
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = current.x + dx;
        const nz = current.z + dz;
        if (nx < GRID_MIN || nx > GRID_MAX || nz < GRID_MIN || nz > GRID_MAX) continue;
        const nKey = key(nx, nz);
        const isGoal = nKey === goalKey;
        // Goal cell is always traversable so callers can route TO a
        // chair, stove, counter, etc.
        if (!isGoal && blocked.has(nKey)) continue;
        // Internal partition wall sitting on the EDGE between the two
        // cells? Reject the step — only int-doorway pieces allow
        // crossing. (For the goal-edge case we still respect the wall
        // — you can't end your path on the other side of a wall
        // unless there's a doorway.)
        if (blockedEdges.has(edgeKey(current.x, current.z, nx, nz))) continue;
        const tentativeG = (gScore.get(currKey) ?? Infinity) + 1;
        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          gScore.set(nKey, tentativeG);
          came.set(nKey, currKey);
          open.push({ x: nx, z: nz, f: tentativeG + heuristic(nx, nz, goalX, goalZ) });
        }
      }
    }
    // Fallback: just send them straight at the goal so they don't
    // freeze when the search exhausts. Better to clip through an
    // obstacle for one trip than to soft-lock a customer.
    return [finalTarget];
  }

  /** True if every cell on the straight line between (x1,z1) and
   * (x2,z2) — exclusive of both endpoints — is unblocked. Bresenham-
   * style traversal so the shortcut works for any pair of cells, not
   * just axis-aligned ones. */
  private directLineClear(x1: number, z1: number, x2: number, z2: number, blocked: Set<string>): boolean {
    const dx = Math.abs(x2 - x1), dz = Math.abs(z2 - z1);
    const sx = x1 < x2 ? 1 : -1;
    const sz = z1 < z2 ? 1 : -1;
    let err = dx - dz;
    let cx = x1, cz = z1;
    while (cx !== x2 || cz !== z2) {
      const e2 = err * 2;
      if (e2 > -dz) { err -= dz; cx += sx; }
      if (e2 < dx)  { err += dx; cz += sz; }
      // Skip checking the goal cell — caller wants to reach there
      // even if blocked.
      if (cx === x2 && cz === z2) break;
      if (blocked.has(`${cx},${cz}`)) return false;
    }
    return true;
  }

  /** Walk the registry and collect every cell occupied by a blocking
   * item, plus every edge (grid line) blocked by an internal partition
   * wall. Multi-tile items expand to all their cells; L-shaped items
   * (corner sofas) honour their explicit footprint mask so the open
   * elbow stays walkable. Internal walls / windows live on edges and
   * never claim a tile — only the doorway piece allows crossing. */
  private computeBlocked(): { cells: Set<string>; edges: Set<string> } {
    const cells = new Set<string>();
    const edges = new Set<string>();
    for (const it of this.getItems()) {
      const def = getFurnitureDef(it.defId);
      if (!def) continue;
      const rotY = (it as { rotY?: number }).rotY ?? 0;
      // Edge-placed partition walls + windows block the grid line
      // they sit on. Doorways stay passable so the partition has a
      // way through.
      if (def.placement === "edge" && isBlockingEdgeWall(it.defId)) {
        edges.add(edgeKeyFromWall(it.x, it.z, rotY));
        continue;
      }
      if (!isBlockingCategory(def.category, def.placement)) continue;
      for (const cell of footprintCells({ x: it.x, z: it.z, rotY }, def)) {
        cells.add(`${cell.x},${cell.z}`);
      }
    }
    return { cells, edges };
  }
}

/** Key for the edge between two 4-neighbour cells. We tag horizontal
 * vs vertical so the encoding is unique even if the two cells are
 * swapped, and so it lines up 1:1 with edgeKeyFromWall() below.
 * Horizontal step → vertical wall on the midpoint x; vertical step →
 * horizontal wall on the midpoint z. */
function edgeKey(ax: number, az: number, bx: number, bz: number): string {
  if (ax !== bx) {
    // East/west step. Vertical wall at midpoint x, same z.
    const midX = (ax + bx) / 2;
    return `v:${midX},${az}`;
  }
  // North/south step. Horizontal wall at midpoint z, same x.
  const midZ = (az + bz) / 2;
  return `h:${ax},${midZ}`;
}

/** Key for the edge a wall sits on. Walls placed by BuildMenu.snapToEdge
 * always land at exactly rotY=0 (runs along X — half-integer z, blocks
 * north-south movement) or rotY=π/2 (runs along Z — half-integer x,
 * blocks east-west movement). Reading sin/cos rather than === keeps us
 * tolerant if rotY ever gets an extra full turn from a move operation. */
function edgeKeyFromWall(wx: number, wz: number, rotY: number): string {
  const isVertical = Math.abs(Math.sin(rotY)) > 0.5;
  return isVertical ? `v:${wx},${wz}` : `h:${wx},${wz}`;
}

/** True if this edge-placed item should block movement across the
 * grid line it sits on. Doorways always allow passage; walls,
 * half-walls and windows all block. */
function isBlockingEdgeWall(defId: string): boolean {
  return defId === "int-wall" || defId === "int-wall-half" || defId === "int-window";
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

function heuristic(x1: number, z1: number, x2: number, z2: number): number {
  return Math.abs(x1 - x2) + Math.abs(z1 - z2);
}

function reconstruct(came: Map<string, string>, startKey: string, goalKey: string, finalTarget: THREE.Vector2): PathStep[] {
  const path: PathStep[] = [];
  let k = goalKey;
  while (k !== startKey) {
    const [x, z] = k.split(",").map(Number);
    path.unshift(new THREE.Vector2(x, z));
    const prev = came.get(k);
    if (!prev) break;
    k = prev;
  }
  // Replace the final waypoint with the requested destination so the
  // actor lands precisely there rather than at the cell center.
  if (path.length > 0) path[path.length - 1] = finalTarget;
  return path;
}

/** Decide whether a furniture category should block walking on its
 * cells. Mirrors the visual rule of thumb: solid furniture blocks;
 * rugs, wall-mounted decor, edge-placed walls/windows, and ceiling-
 * mounted items don't claim floor tiles. */
function isBlockingCategory(category: string, placement: string | undefined): boolean {
  if (placement === "edge" || placement === "wall" || placement === "ceiling") return false;
  switch (category) {
    case "table":
    case "chair":
    case "stove":
    case "counter":
    case "bathroom":
    case "plant":
      return true;
    case "decoration":
      // Most decorations sit on counters / wall and don't block paths.
      // We could fine-tune individual ids here later; for now err on
      // the permissive side so the world feels passable.
      return false;
    case "lamp":
    case "door":
    case "wall":
      return false;
    default:
      return false;
  }
}
