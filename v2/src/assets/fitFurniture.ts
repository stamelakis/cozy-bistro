import * as THREE from "three";
import type { FurnitureDef } from "../data/furnitureCatalog";

/**
 * Scales + recenters a furniture model so it visually respects the grid
 * cell(s) it's been placed into. Two-axis approach:
 *
 *   1. XZ AUTO-FIT — uniform scale picked so the model's footprint fits
 *      `def.size.{width, depth}` tiles with a small margin.
 *      `def.scale` is a fill ratio on top of that.
 *
 *   2. Y NON-UNIFORM STRETCH — independently sets the placed model's
 *      world-space height to `def.targetHeight` if set, else a
 *      sensible per-category default. Stops Kenney chairs from
 *      shooting up to 1.8 m tall and Kenney tables from shrinking
 *      to coffee-table height when their raw aspect is unbalanced.
 *
 *   3. RECENTER — shift the direct children so the visual XZ centroid
 *      sits at the model's local origin and the lowest point sits at
 *      y=0. Callers' subsequent `model.position.set(x, y, z)` then
 *      lands the visible item exactly at the placement coordinate.
 *
 * Procedural decor (`proc:` prefix) skips all of this — those builders
 * author at exact tile size and may have hand-placed pivots.
 *
 * Returns the X (footprint) scale applied — useful for sizing
 * attached props that should grow with the item's footprint, not its
 * stretched height.
 */

const TILE = 1.0;
/** Visual breathing room around each tile — leaves 4% margin so
 * neighbouring items don't visibly touch and the grid lines stay
 * faintly readable between placements. */
const FOOTPRINT_MARGIN = 0.92;

/** Per-category Y-target fallback when a FurnitureDef doesn't pin its
 * own `targetHeight`. Units are world ≈ metres, matching the 1.7 unit
 * character height. */
const DEFAULT_HEIGHTS: Record<FurnitureDef["category"], number> = {
  table: 0.75,        // realistic dining height — plates land here
  chair: 0.95,        // chair-back to character chest
  stove: 0.92,        // appliance height
  wash: 0.92,         // sinks + dishwashers — same kitchen-counter line
  appliance: 0.40,    // small tabletop kitchen tools (sit on counters)
  counter: 0.92,
  bar: 1.05,          // bar tops sit slightly taller than counters
  storage: 0.92,      // fridges + cabinets — match the counter line
  decoration: 0.55,   // small props (crates, books, pillows)
  plant: 0.85,        // potted plant + foliage
  lamp: 1.55,         // floor lamps tall, table lamps shorter (override per-id)
  door: 2.3,          // 2m + frame
  bathroom: 0.88,     // toilets / bathroom sinks roughly counter-height
  wall: 2.4,          // interior partition walls — match the procedural mesh
};

export function fitFurniture(model: THREE.Object3D, def: FurnitureDef): number {
  // Reset transforms before measuring so we get the raw mesh bounds.
  model.scale.setScalar(1);
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.updateMatrixWorld(true);

  // Procedural decor: keep the authored size + raw scale. Don't recenter
  // because some of them have authored anchor points (e.g. the front
  // door's hinge sits at one edge, not the center).
  if (def.modelPath.startsWith("proc:")) {
    model.scale.setScalar(def.scale);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    if (Number.isFinite(box.min.y) && box.min.y !== 0) {
      model.position.y -= box.min.y;
    }
    return def.scale;
  }

  const box = new THREE.Box3().setFromObject(model);
  const w = box.max.x - box.min.x;
  const d = box.max.z - box.min.z;
  const h = box.max.y - box.min.y;
  if (!Number.isFinite(w) || !Number.isFinite(d) || w === 0 || d === 0) {
    // Defensive fallback — model has degenerate bounds (empty / hidden).
    model.scale.setScalar(def.scale);
    return def.scale;
  }

  // === XZ auto-fit ===
  // Most items get the 4% breathing-room margin so neighbouring placements
  // don't visibly z-fight and the grid lines stay readable. Items in a
  // run-together set (bar counters that need to abut bar ends, kitchen
  // counter runs, etc.) opt in to `fillTile` which removes that margin
  // so adjacent placements actually touch without a visible seam.
  const margin = def.fillTile ? 1.0 : FOOTPRINT_MARGIN;
  const targetW = TILE * def.size.width * margin;
  const targetD = TILE * def.size.depth * margin;
  // Default: uniform XZ scale, sized so the mesh fits ENTIRELY inside
  // its footprint (use MIN of the two axis ratios). When def.stretchFoot­
  // print is on, scale X and Z independently so the mesh fills the
  // whole footprint — used when the raw aspect doesn't match the
  // catalog footprint (Long Sofa).
  let fitX: number, fitZ: number;
  if (def.stretchFootprint) {
    fitX = (targetW / w) * def.scale;
    fitZ = (targetD / d) * def.scale;
  } else {
    const fitXZ = Math.min(targetW / w, targetD / d) * def.scale;
    fitX = fitXZ;
    fitZ = fitXZ;
  }

  // === Y target ===
  // Independent height target. Lets a chair be cell-width-fitted while
  // its height locks to ~0.95m regardless of the raw mesh's aspect.
  // Without this, narrow Kenney chairs ended up nearly two metres tall
  // because the XZ uniform scale also stretched Y.
  let fitY = fitX;
  if (h > 0) {
    const targetH = def.targetHeight ?? DEFAULT_HEIGHTS[def.category];
    if (targetH) fitY = targetH / h;
  }

  model.scale.set(fitX, fitY, fitZ);
  model.updateMatrixWorld(true);

  // === Recenter ===
  const box2 = new THREE.Box3().setFromObject(model);
  const cx = (box2.min.x + box2.max.x) / 2;
  const cz = (box2.min.z + box2.max.z) / 2;
  // box2 is in world units; convert to model-local by dividing by the
  // axis scale that moved it there. With independent X/Z scales each
  // axis needs its own divisor.
  const localShiftX = -cx / fitX;
  const localShiftY = -box2.min.y / fitY;
  const localShiftZ = -cz / fitZ;
  for (const child of model.children) {
    child.position.x += localShiftX;
    child.position.y += localShiftY;
    child.position.z += localShiftZ;
  }

  // Anchor-edge shift — push the mesh toward one tile boundary instead
  // of leaving it centred. Bar ends are the canonical case: the mesh
  // is a thin slab and the player wants the FLAT face flush with the
  // tile edge that touches the abutting bar counter (so the two pieces
  // read as one continuous bar instead of two centred props with a gap
  // between them). The shift is applied in MODEL-LOCAL X so it rotates
  // with the placed item — anchorEdge "x+" pushes toward +X-after-rotation,
  // "x-" toward -X-after-rotation. Half-tile edge is def.size.width / 2.
  if (def.anchorEdge === "x+" || def.anchorEdge === "x-") {
    model.updateMatrixWorld(true);
    const bbE = new THREE.Box3().setFromObject(model);
    const halfTile = (TILE * def.size.width) / 2;
    const halfMesh = (bbE.max.x - bbE.min.x) / 2;
    const sign = def.anchorEdge === "x+" ? 1 : -1;
    const worldShift = sign * (halfTile - halfMesh);
    // Convert to local (children X is scaled by fitX in world).
    const localShift = worldShift / fitX;
    for (const child of model.children) {
      child.position.x += localShift;
    }
  }

  // Bake the def's rotationOffset into the model's internal frame so
  // callers can still treat `model.rotation.y` as the LOGICAL rotation
  // (the same value saved to disk and computed by the placement code).
  // This is the escape hatch for assets whose authored forward axis
  // disagrees with our "GLB front = -Z" convention — e.g. Kenney's
  // bathroomMirror, whose reflective face sits on +Z. Without this
  // bake, the wall-mount logic puts the back of the mirror facing the
  // room. We move the existing children into a wrapper group rotated
  // by the offset; external rotation stacks on top of that.
  let wrapper: THREE.Group | undefined;
  if (def.rotationOffset) {
    wrapper = new THREE.Group();
    wrapper.rotation.y = def.rotationOffset;
    // Snapshot first — wrapper.add() mutates model.children.
    const original = [...model.children];
    for (const child of original) wrapper.add(child);
    model.add(wrapper);
  }

  // Wall-mounted items: shift the model so its BACK face sits at z=0
  // in model-local space. The wall-mount code in BuildMenu positions
  // the model centre 0.07 units along the mount normal, which is fine
  // for a flat sconce but pushes the back of a thicker piece (mirror,
  // wall art) into the wall — sometimes all the way through. With this
  // shift, the back face anchors at the mount-offset plane and the
  // body extends INTO the room rather than across the wall.
  if (def.placement === "wall") {
    model.updateMatrixWorld(true);
    const box3 = new THREE.Box3().setFromObject(model);
    // External rotation aligns model -Z with the wall's outward normal,
    // so the model's +Z face (max.z) ends up against the wall. Shift
    // so that face lives at z=0.
    const shiftZ = -box3.max.z;
    if (shiftZ !== 0) {
      if (wrapper) {
        wrapper.position.z += shiftZ;
      } else {
        for (const child of model.children) child.position.z += shiftZ;
      }
    }
  }

  // Return the X-axis fit factor — callers (e.g. anchored props)
  // historically used this as a uniform reference. They'll match
  // along the width direction, which is the relevant one for
  // bench-style attached props.
  return fitX;
}

/** World-space height of a placed model — useful for putting plates on
 * the actual table surface or anchoring the stove flame above its
 * burners. */
export function fittedHeight(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  return box.max.y - box.min.y;
}

/** Top of the building envelope. Walls are 3 units tall (BoxGeometry y=3
 * centred at y=1.5), so the ceiling sits at y=3. Ceiling-mounted items
 * have their model TOP aligned with this. */
export const CEILING_Y = 3;

/** Sill height used by the perimeter-wall window cut. Windows sit ON
 * the sill, so their mesh bottom anchors here instead of at the floor.
 * Mirrors WorldScene.WINDOW_SILL_TOP — keep in sync if either side
 * moves. */
export const WINDOW_SILL_TOP = 0.9;

/** Perimeter wall positions used by snapToAdjacentWall. The building's
 * floor spans (-4.5, 5.5) on both axes and the walls sit on those
 * edges. A tile is "wall-adjacent" when its half-tile reaches one of
 * these planes. */
const WALL_BOUNDS = { minX: -4.5, maxX: 5.5, minZ: -4.5, maxZ: 5.5 };
/** Perimeter walls are 0.2 m thick BoxGeometry centred on the bounds
 * (see WorldScene.wallBoxFor + wallSegmentPosition). Half the thickness
 * lives on the interior side of the bounds plane — so the actual
 * INTERIOR FACE of the back wall (bound z=-4.5) is at z=-4.4, the
 * right wall (x=5.5) at x=5.4, etc. snapToAdjacentWall must aim for
 * this face, not the center plane, or the model's back ends up
 * clipping through the visible inside surface of the wall. */
const WALL_HALF_THICKNESS = 0.1;

/** Slide a tile-placed model toward any perimeter wall its cell
 * touches so the model's back face sits flush against the wall plane.
 * Without this, narrower meshes (sinks, cabinets, fridges with raw
 * mesh depth < 1 m) leave an uneven gap to the wall that varies per
 * item — visibly distracting along a kitchen run.
 *
 * The shift is VISUAL ONLY — the placement registry still tracks the
 * tile centre, so occupancy checks, surface slots, and seat-slot
 * resolution all stay aligned. The model itself just moves a few
 * centimetres inside its tile.
 *
 * Skipped for placements that aren't supposed to fill the tile
 * footprint (rugs, ceiling lamps, etc.) and for items whose footprint
 * already extends to / past the wall in that direction (so we never
 * push something OUT of its cell). */
export function snapToAdjacentWall(model: THREE.Object3D, def: FurnitureDef): void {
  // Only "natural floor" items snap. Wall / wall-shelf / ceiling /
  // edge / surface have their own positioning logic; rugs are flat
  // decor that doesn't care about wall alignment.
  const placement = def.placement ?? "tile";
  if (placement !== "tile") return;
  if (def.flat) return;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (!isFinite(box.min.x) || !isFinite(box.max.x)) return;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  // Adjacency check: is the model's CENTRE within one tile of a wall?
  // Using the centre (not the bbox edge) keeps the logic stable as
  // narrow vs wide meshes pass through here. The 1.0 m threshold
  // matches the tile size — only the row of tiles touching a wall
  // qualifies.
  const TILE = 1.0;
  // Snap to the wall's INTERIOR face — wall meshes are 0.2 m thick
  // centred on WALL_BOUNDS, so the face the room sees lives half a
  // thickness inside the bound plane.
  const maxXFace = WALL_BOUNDS.maxX - WALL_HALF_THICKNESS;
  const minXFace = WALL_BOUNDS.minX + WALL_HALF_THICKNESS;
  const maxZFace = WALL_BOUNDS.maxZ - WALL_HALF_THICKNESS;
  const minZFace = WALL_BOUNDS.minZ + WALL_HALF_THICKNESS;
  let dx = 0, dz = 0;
  if (WALL_BOUNDS.maxX - cx <= TILE / 2 + 0.01 && box.max.x < maxXFace) {
    dx = maxXFace - box.max.x;
  } else if (cx - WALL_BOUNDS.minX <= TILE / 2 + 0.01 && box.min.x > minXFace) {
    dx = minXFace - box.min.x;
  }
  if (WALL_BOUNDS.maxZ - cz <= TILE / 2 + 0.01 && box.max.z < maxZFace) {
    dz = maxZFace - box.max.z;
  } else if (cz - WALL_BOUNDS.minZ <= TILE / 2 + 0.01 && box.min.z > minZFace) {
    dz = minZFace - box.min.z;
  }
  if (dx !== 0 || dz !== 0) {
    model.position.x += dx;
    model.position.z += dz;
  }
}

/** Pick the world-space Y for a placed model based on its placement
 * kind. Shared by BuildMenu (place / preview), the undo handler, and
 * FurnitureRegistry.restore so a ceiling lamp lands at the same Y
 * however it got into the scene.
 *
 *   - "wall"    → 1.5 (chest height, set by the wall-mount logic)
 *   - "ceiling" → CEILING_Y minus the model's own height, so its TOP
 *                 touches the ceiling and the body hangs below
 *   - windows   → WINDOW_SILL_TOP so the mesh sits inside the sill +
 *                 lintel cut in the perimeter wall
 *   - otherwise → whatever fitFurniture left model.position.y at (≈ 0) */
export function placementY(model: THREE.Object3D, def: FurnitureDef): number {
  if (def.placement === "wall") return 1.5;
  if (def.placement === "wall-shelf") {
    // Upper cabinets sit chest+ height. 1.7m clears any counter / sink
    // / stove (≤1.2m by the wall-shelf placement constraint) and still
    // leaves head clearance under the 3m ceiling.
    return 1.7;
  }
  if (def.placement === "ceiling") {
    return Math.max(0, CEILING_Y - fittedHeight(model));
  }
  // Windows slot into the sill+lintel cut in the perimeter wall, so
  // their bottom lands on top of the sill instead of on the floor.
  // Internal-wall windows ("int-window") have their own procedural
  // builder that already authors the right Y, so this only affects
  // the perimeter "window" / "window-slide" entries.
  if (def.id.startsWith("window")) return WINDOW_SILL_TOP;
  return model.position.y;
}

/** The wall-shelf placement requires the floor cell below to be empty
 * or to host an item shorter than this many metres. Mirrors the rule
 * the player picked in the planning round: an upper cabinet over a
 * counter (0.92m) is fine, over a fridge (2.2m) is blocked. */
export const WALL_SHELF_MAX_BELOW_HEIGHT = 1.2;

/** Effective Y-height a def will render at — explicit targetHeight
 * if set, otherwise the per-category fallback. Used by the wall-shelf
 * clearance check (and any other "is this thing tall?" gate). */
export function defHeight(def: FurnitureDef): number {
  return def.targetHeight ?? DEFAULT_HEIGHTS[def.category];
}
