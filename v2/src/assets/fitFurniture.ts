import * as THREE from "three";
import type { FurnitureDef } from "../data/furnitureCatalog";

/**
 * Auto-fit a loaded furniture model so it covers exactly the cells in
 * its def.size. Kenney models are authored at varying natural sizes,
 * which is why hand-tuned `def.scale` values look inconsistent — a
 * 1.9× table can still look smaller than a 1.7× chair if their natural
 * meshes differ.
 *
 * Strategy: measure the model's horizontal bounding box at its natural
 * scale, then apply a uniform scale so the larger horizontal dimension
 * matches the bigger of (width, depth) tiles minus a small visual
 * gap (so adjacent items don't quite touch).
 *
 * Per-category "fill factor" tweaks how aggressively to fill the tile:
 *   table  → 0.95 (essentially fills the cell)
 *   chair  → 0.85 (slightly inset for chair-to-table breathing room)
 *   stove / counter → 0.95
 *   plant / decor / lamp → 0.7 (these read as accents, not cell-fillers)
 *   door → 0.95
 */

const FILL_FACTOR: Record<FurnitureDef["category"], number> = {
  table: 0.95,
  chair: 0.85,
  stove: 0.95,
  counter: 0.95,
  decoration: 0.7,
  plant: 0.7,
  lamp: 0.7,
  door: 0.95,
};

/** Apply auto-fit scale to a model just loaded by ModelLoader. Returns
 * the scale that was applied (in case the caller needs to know). */
export function fitFurniture(model: THREE.Object3D, def: FurnitureDef): number {
  // Reset to base scale first so repeated calls are idempotent.
  model.scale.set(1, 1, 1);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxHoriz = Math.max(size.x, size.z);
  if (maxHoriz < 0.001) {
    // Degenerate model — fall back to def.scale.
    model.scale.setScalar(def.scale);
    return def.scale;
  }
  const factor = FILL_FACTOR[def.category] ?? 0.9;
  const targetMax = Math.max(def.size.width, def.size.depth) * factor;
  const scale = targetMax / maxHoriz;
  model.scale.setScalar(scale);
  // Re-measure and snap down to ground so the base sits on y=0.
  model.updateMatrixWorld(true);
  const fittedBox = new THREE.Box3().setFromObject(model);
  if (fittedBox.min.y !== 0) {
    model.position.y -= fittedBox.min.y;
  }
  return scale;
}

/** Get the world-space height (y-extent) of a fitted model — useful
 * for placing items on table surfaces, etc. */
export function fittedHeight(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  return box.max.y - box.min.y;
}
