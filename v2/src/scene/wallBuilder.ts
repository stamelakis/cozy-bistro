import * as THREE from "three";

/** Slim shape of a furniture catalog entry, narrowed to what the
 * opening extractor actually reads. Both FurnitureDef (catalog) and
 * FurnitureDefinition (data/types) satisfy this — keeps wallBuilder
 * free of a hard dep on either struct so the two callers don't pull
 * each other in transitively. */
interface FurnitureLike {
  id: string;
  category: string;
}

/**
 * Shared perimeter-wall geometry pipeline. Extracted out of
 * WorldScene so the visit-mode visualization (VisitMode.ts) can
 * render the same wall + door + window cuts the host sees on their
 * own restaurant — keeping the two views structurally identical.
 *
 * The host's WorldScene.rebuildPerimeterWall still owns mesh
 * tracking + the per-face material array + the camera-aware
 * solid/ghost swap; this module owns the geometry math + opening
 * loop + a generic "build segments into a parent" path that visit
 * mode can call with a single material (no ghost-wall transparency
 * needed there — visitors view restaurants from above).
 *
 * Coords match the host's canonical 10×10 footprint exactly:
 * walls span axis ∈ [WALL_AXIS_MIN, WALL_AXIS_MAX]. Each storey
 * sits at yOffset = floorIdx × STOREY_HEIGHT, same as
 * WorldScene.STOREY_HEIGHT (3 m).
 */

/** Which of the four perimeter walls. */
export type WallDir = "front" | "back" | "left" | "right";

/** Axis bounds for the perimeter walls (matches the 10×10 footprint
 * shifted by +0.5 to align with the tile grid centres). */
export const WALL_AXIS_MIN = -4.5;
export const WALL_AXIS_MAX = 5.5;
/** Half-tile gap each opening punches in the wall. */
export const OPENING_HALF = 0.5;
/** Sill / lintel heights for a window opening. Sill = 0 → 0.9 m,
 * window itself runs 0.9 → 2.2 m, lintel = 2.2 → 3.0 m. */
export const WINDOW_SILL_TOP = 0.9;
export const WINDOW_LINTEL_BOTTOM = 2.2;
/** Storey height in meters; matches WorldScene's STOREY_HEIGHT. */
export const STOREY_HEIGHT = 3.0;

/** Geometry for a single wall segment box. Direction picks which
 * axis the width sits along — front/back stretch along X, left/right
 * along Z — keeping the 0.2 m thickness on the perpendicular axis. */
export function wallBoxGeometry(dir: WallDir, span: number, yHeight: number): THREE.BoxGeometry {
  if (dir === "front" || dir === "back") {
    return new THREE.BoxGeometry(span, yHeight, 0.2);
  }
  return new THREE.BoxGeometry(0.2, yHeight, span);
}

/** World-space position of a wall segment given its centre along the
 * wall axis and its centre Y. Building interior is shifted by (0.5,
 * 0.5) to match the tile grid, but the perimeter coords are absolute. */
export function wallSegmentWorldPosition(dir: WallDir, axisCentre: number, yCentre: number): THREE.Vector3 {
  switch (dir) {
    case "front": return new THREE.Vector3(axisCentre, yCentre,  5.5);
    case "back":  return new THREE.Vector3(axisCentre, yCentre, -4.5);
    case "left":  return new THREE.Vector3(-4.5, yCentre, axisCentre);
    case "right": return new THREE.Vector3( 5.5, yCentre, axisCentre);
  }
}

/** Options for buildPerimeterWallSegments. */
export interface BuildPerimeterWallOptions {
  /** Y offset applied to every segment (= floorIdx × STOREY_HEIGHT). */
  yOffset: number;
  /** Resolver for the segment material. Visit mode passes a single
   * `() => sharedMat`; the host passes its solid-or-ghost array
   * resolver. Called once per segment. */
  resolveMaterial: () => THREE.Material | THREE.Material[];
  /** Mesh shadow flags. Visit mode + host both want both true. */
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** Camera-relative kind ("solid" or "ghost") for a single wall —
 * returns "ghost" when the camera is on the wall's outdoor side
 * (positive dot with the outward normal). Shared with the host's
 * WorldScene.updateWallVisibility logic so visit mode + host pick the
 * same two walls to ghost from any given camera angle.
 *
 * cameraPos is the camera's position EXPRESSED IN THE PLOT'S LOCAL
 * COORDS — visit mode subtracts the plot offset before calling.
 * (The host's plot is at world origin, so cameraPos works as-is.) */
export function wallKindForCamera(
  dir: WallDir,
  cameraPos: { x: number; z: number },
): "solid" | "ghost" {
  // Outward normal for each wall. Building is centred on (0.5, 0.5)
  // but the perimeter walls sit at ±4.5/5.5 with the +0.5 shift; the
  // normal direction is the same regardless.
  const normal = dir === "back" ? { x: 0, z: -1 }
    : dir === "front" ? { x: 0, z: 1 }
    : dir === "left" ? { x: -1, z: 0 }
    : { x: 1, z: 0 };
  const dot = normal.x * cameraPos.x + normal.z * cameraPos.z;
  return dot > 0 ? "ghost" : "solid";
}

/** Build wall segments around the supplied openings into `parent`.
 * Returns the created meshes (host calls this to track for teardown;
 * visit mode tosses them when the visitor root is disposed).
 *
 * The algorithm walks openings left-to-right along the wall axis,
 * emitting a full-height segment between each opening, then a lintel
 * (door) or sill+lintel pair (window) inside each opening's footprint.
 * Tiny segments (< 4 cm) are skipped so back-to-back openings don't
 * leave a sliver mesh.
 *
 * Mirror of WorldScene.rebuildPerimeterWall's inner loop, restated
 * as a pure function so visit mode can share it without duplicating
 * the math or risking divergence. */
export function buildPerimeterWallSegments(
  parent: THREE.Object3D,
  dir: WallDir,
  doorEdges: number[],
  windowEdges: number[],
  options: BuildPerimeterWallOptions,
): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const { yOffset, resolveMaterial } = options;
  const castShadow = options.castShadow ?? true;
  const receiveShadow = options.receiveShadow ?? true;

  // Sorted opening list with type tags so the loop walks left-to-right.
  const openings: { center: number; type: "door" | "window" }[] = [
    ...doorEdges.filter((c) => c > WALL_AXIS_MIN && c < WALL_AXIS_MAX).map((c) => ({ center: c, type: "door" as const })),
    ...windowEdges.filter((c) => c > WALL_AXIS_MIN && c < WALL_AXIS_MAX).map((c) => ({ center: c, type: "window" as const })),
  ].sort((a, b) => a.center - b.center);

  const addBox = (
    axisFrom: number, axisTo: number,
    yCenter: number, yHeight: number,
  ): void => {
    const span = axisTo - axisFrom;
    if (span < 0.04 || yHeight < 0.04) return;
    const center = (axisFrom + axisTo) / 2;
    const geom = wallBoxGeometry(dir, span, yHeight);
    const mat = resolveMaterial();
    const mesh = new THREE.Mesh(geom, mat);
    const pos = wallSegmentWorldPosition(dir, center, yCenter + yOffset);
    mesh.position.copy(pos);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    parent.add(mesh);
    out.push(mesh);
  };

  let segStart = WALL_AXIS_MIN;
  for (const op of openings) {
    const gapStart = op.center - OPENING_HALF;
    const gapEnd = op.center + OPENING_HALF;
    // Continuous wall segment up to this opening.
    addBox(segStart, gapStart, 1.5, 3.0);
    if (op.type === "door") {
      // Full-height gap with a 1 m lintel sitting at the top.
      addBox(gapStart, gapEnd, 2.5, 1.0);
    } else {
      // Window: sill below, lintel above, middle band open so the
      // placed window mesh shows through.
      addBox(gapStart, gapEnd, WINDOW_SILL_TOP / 2, WINDOW_SILL_TOP);
      const lintelH = 3 - WINDOW_LINTEL_BOTTOM;
      addBox(gapStart, gapEnd, WINDOW_LINTEL_BOTTOM + lintelH / 2, lintelH);
    }
    segStart = gapEnd;
  }
  addBox(segStart, WALL_AXIS_MAX, 1.5, 3.0);
  return out;
}

/** Per-direction opening lists for one floor. */
export interface FloorOpenings {
  front: { doors: number[]; windows: number[] };
  back: { doors: number[]; windows: number[] };
  left: { doors: number[]; windows: number[] };
  right: { doors: number[]; windows: number[] };
}

/** Shape every callsite that constructs FloorOpenings should use. */
export function emptyFloorOpenings(): FloorOpenings {
  return {
    front: { doors: [], windows: [] },
    back: { doors: [], windows: [] },
    left: { doors: [], windows: [] },
    right: { doors: [], windows: [] },
  };
}

/** Furniture-placement shape the openings extractor accepts. Matches
 * both the host's registry items (defId + x + z + floor) and the
 * save snapshot's saved-furniture entries (furnitureId + position +
 * floor). Caller normalizes to this shape. */
export interface OpeningSourcePlacement {
  defId: string;
  x: number;
  z: number;
  floor: number;
}

/** Group door / window placements by floor + which perimeter wall.
 * Mirrors Engine.allPerimeterOpenings, restated as a pure function so
 * VisitMode can extract the same openings from the save snapshot.
 *
 * A placement is classified by its position relative to the wall:
 *   front  → z ≈  5.5  (axis = x)
 *   back   → z ≈ -4.5  (axis = x)
 *   left   → x ≈ -4.5  (axis = z)
 *   right  → x ≈  5.5  (axis = z)
 * Tolerance of 0.1 m matches the host.
 *
 * `getDef` is the standard furniture-catalog lookup; returns undefined
 * for unknown ids (kept defensive — old saves can reference
 * removed defs).
 *
 * Note: the host only places windows on back/left/right walls today;
 * front carries doors AND windows. We allow doors on every wall here
 * so the extractor is forward-compatible if the placement rules
 * loosen later. */
export function extractWallOpenings(
  placements: readonly OpeningSourcePlacement[],
  getDef: (id: string) => FurnitureLike | undefined,
): Map<number, FloorOpenings> {
  const out = new Map<number, FloorOpenings>();
  const getFloor = (floor: number): FloorOpenings => {
    let entry = out.get(floor);
    if (!entry) {
      entry = emptyFloorOpenings();
      out.set(floor, entry);
    }
    return entry;
  };
  for (const p of placements) {
    const def = getDef(p.defId);
    // Runtime category for door/window furniture is the string "door"
    // (see furnitureCatalog.ts) — the FurnitureCategory union in
    // data/types.ts has drifted from the actual catalog. Match the
    // host's pattern (Engine.allPerimeterOpenings uses the same
    // string compare) by widening the LHS to string.
    if (!def || def.category !== "door") continue;
    const isWindow = def.id.startsWith("window");
    const floor = getFloor(p.floor);
    if (Math.abs(p.z - 5.5) < 0.1) {
      if (isWindow) floor.front.windows.push(p.x);
      else floor.front.doors.push(p.x);
      continue;
    }
    if (Math.abs(p.z + 4.5) < 0.1) {
      if (isWindow) floor.back.windows.push(p.x);
      else floor.back.doors.push(p.x);
      continue;
    }
    if (Math.abs(p.x + 4.5) < 0.1) {
      if (isWindow) floor.left.windows.push(p.z);
      else floor.left.doors.push(p.z);
      continue;
    }
    if (Math.abs(p.x - 5.5) < 0.1) {
      if (isWindow) floor.right.windows.push(p.z);
      else floor.right.doors.push(p.z);
      continue;
    }
  }
  return out;
}
