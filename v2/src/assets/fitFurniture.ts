import * as THREE from "three";
import type { FurnitureDef } from "../data/furnitureCatalog";

/**
 * Apply a furniture model's per-catalog scale and then lift it so its
 * lowest vertex sits at y=0 (i.e. on the floor). Replaces the earlier
 * auto-fit version which was inferring scale from the model's bounding
 * box — that turned out to be inconsistent across Kenney models and
 * caused tables to shrink or disappear.
 *
 * Returns the applied scale (always def.scale).
 */
export function fitFurniture(model: THREE.Object3D, def: FurnitureDef): number {
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.setScalar(def.scale);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  // Lift the model so its lowest point sits on the ground plane (y=0).
  if (Number.isFinite(box.min.y) && box.min.y !== 0) {
    model.position.y -= box.min.y;
  }
  return def.scale;
}

/** World-space height of a placed model — useful for putting plates on
 * the actual table surface. */
export function fittedHeight(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  return box.max.y - box.min.y;
}
