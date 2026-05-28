import * as THREE from "three";
import type { FurnitureDef } from "../data/furnitureCatalog";

/**
 * Scales + recenters a furniture model so it visually respects the grid
 * cell it's been placed into. Kenney meshes ship at wildly different
 * base sizes and arbitrary pivot points, so without this every dining
 * table overhangs its chairs, every stove juts into the next tile, and
 * the seat-slot math goes haywire. The fix has two parts:
 *
 *   1. AUTO-FIT — pick a uniform scale so the model's XZ footprint
 *      fits the assigned cell count (def.size.width × def.size.depth)
 *      with a small visual margin. def.scale acts as a fill ratio:
 *      1.0 means "fill the assigned tiles", 0.7 means "fill 70%".
 *
 *   2. RECENTER — shift the model's direct children so the visual
 *      center sits at the model's local origin (XZ) with feet on the
 *      floor (Y). This way callers can place at world (x, z) and the
 *      visible item lands exactly at that grid coordinate.
 *
 * Procedural decor (modelPath starts with "proc:") skips auto-fit —
 * those builders already author geometry at the right size and some
 * have hinged sub-objects (front door panel, etc.) whose math would
 * break if we resized + recentered them.
 *
 * Returns the final uniform scale applied (useful for placing
 * attachments like the stove flame in world units).
 */

const TILE = 1.0;
/** Visual breathing room around each tile — leaves 4% margin so
 * neighbouring items don't visibly touch and the grid lines stay
 * faintly readable between placements. */
const FOOTPRINT_MARGIN = 0.92;

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
  if (!Number.isFinite(w) || !Number.isFinite(d) || w === 0 || d === 0) {
    // Defensive fallback — model has degenerate bounds (empty / hidden).
    model.scale.setScalar(def.scale);
    return def.scale;
  }

  // === Auto-fit ===
  // Find the uniform scale that makes the larger XZ extent match the
  // tile target. Then multiply by def.scale (fill ratio) so the catalog
  // can intentionally shrink decorative items below cell size.
  const targetW = TILE * def.size.width * FOOTPRINT_MARGIN;
  const targetD = TILE * def.size.depth * FOOTPRINT_MARGIN;
  const fitScale = Math.min(targetW / w, targetD / d) * def.scale;
  model.scale.setScalar(fitScale);
  model.updateMatrixWorld(true);

  // === Recenter ===
  // Measure post-scale to find the new visual centroid, then shift the
  // direct children of the model so their world bottom sits at y=0 and
  // their XZ center sits at the model's local origin. We shift CHILDREN
  // (not model.position) so the caller's `model.position.set(x, y, z)`
  // doesn't clobber the centering — that's why every call site can
  // still do the same set-position dance.
  const box2 = new THREE.Box3().setFromObject(model);
  const cx = (box2.min.x + box2.max.x) / 2;
  const cz = (box2.min.z + box2.max.z) / 2;
  // box2 is in world units; convert to model-local by dividing by scale.
  const localShiftX = -cx / fitScale;
  const localShiftY = -box2.min.y / fitScale;
  const localShiftZ = -cz / fitScale;
  for (const child of model.children) {
    child.position.x += localShiftX;
    child.position.y += localShiftY;
    child.position.z += localShiftZ;
  }

  return fitScale;
}

/** World-space height of a placed model — useful for putting plates on
 * the actual table surface or anchoring the stove flame above its
 * burners. */
export function fittedHeight(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  return box.max.y - box.min.y;
}
