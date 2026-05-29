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
  counter: 0.92,
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
  const targetW = TILE * def.size.width * FOOTPRINT_MARGIN;
  const targetD = TILE * def.size.depth * FOOTPRINT_MARGIN;
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

/** Pick the world-space Y for a placed model based on its placement
 * kind. Shared by BuildMenu (place / preview), the undo handler, and
 * FurnitureRegistry.restore so a ceiling lamp lands at the same Y
 * however it got into the scene.
 *
 *   - "wall"    → 1.5 (chest height, set by the wall-mount logic)
 *   - "ceiling" → CEILING_Y minus the model's own height, so its TOP
 *                 touches the ceiling and the body hangs below
 *   - otherwise → whatever fitFurniture left model.position.y at (≈ 0) */
export function placementY(model: THREE.Object3D, def: FurnitureDef): number {
  if (def.placement === "wall") return 1.5;
  if (def.placement === "ceiling") {
    return Math.max(0, CEILING_Y - fittedHeight(model));
  }
  return model.position.y;
}
