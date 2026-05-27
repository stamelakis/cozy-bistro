import * as THREE from "three";
import type { ModelLoader } from "../assets/ModelLoader";
import { getFurnitureDef } from "../data/furnitureCatalog";

/**
 * Tracks furniture the player has placed at runtime. Owns the model
 * references so it can:
 *  - persist a snapshot to the save file (id + position + rotation)
 *  - re-instantiate everything on load
 *  - remove (sell) at a given world cell, refunding 50% to the player
 *  - detect overlap so the BuildMenu doesn't let you stack two items
 *    on the same cell
 *
 * Coordinates are integer grid cells (1 cell = 1 world unit), the same
 * snapping rule BuildMenu already uses.
 */

export interface PlacedFurnitureItem {
  uid: string;
  defId: string;
  x: number;
  z: number;
  rotY: number;
  /** The live Object3D in the scene. Not persisted — rebuilt on load. */
  model: THREE.Object3D;
}

export interface PersistedPlacement {
  uid: string;
  defId: string;
  x: number;
  z: number;
  rotY: number;
}

let nextUidCounter = 1;
function makeUid(): string {
  return `fp-${Date.now().toString(36)}-${(nextUidCounter++).toString(36)}`;
}

export class FurnitureRegistry {
  private readonly items: PlacedFurnitureItem[] = [];
  private readonly scene: THREE.Scene;
  private readonly loader: ModelLoader;

  constructor(scene: THREE.Scene, loader: ModelLoader) {
    this.scene = scene;
    this.loader = loader;
  }

  /** Append a record for an already-placed model. Returns the new uid. */
  register(defId: string, x: number, z: number, rotY: number, model: THREE.Object3D): string {
    const uid = makeUid();
    this.items.push({ uid, defId, x, z, rotY, model });
    return uid;
  }

  /** True if any item is already at the given snapped cell. */
  isOccupied(x: number, z: number): boolean {
    return this.items.some((it) => it.x === x && it.z === z);
  }

  /** Find a placed item at the given cell; the most recently-placed wins
   * if multiple share a cell (shouldn't happen if isOccupied is checked). */
  findAt(x: number, z: number): PlacedFurnitureItem | null {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const it = this.items[i];
      if (it.x === x && it.z === z) return it;
    }
    return null;
  }

  /** Remove the item at the given cell and return its def + refund value.
   * Refund = 50% of base cost, plus small bonuses for premium stats so
   * selling a Linen Table doesn't punish the player as hard as selling a
   * plain wooden chair. Returns null if nothing was there. */
  removeAt(x: number, z: number): { defId: string; refund: number } | null {
    let idx = -1;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].x === x && this.items[i].z === z) { idx = i; break; }
    }
    if (idx < 0) return null;
    const item = this.items[idx];
    this.scene.remove(item.model);
    this.items.splice(idx, 1);
    const def = getFurnitureDef(item.defId);
    if (!def) return { defId: item.defId, refund: 0 };
    // Mirror of 2D's value formula, scaled down to roughly 50%-of-cost-plus-stats.
    const refund = Math.floor(
      def.cost * 0.5
      + (def.style ?? 0) * 4
      + (def.comfort ?? 0) * 3
      + (def.ratingBonus ?? 0) * 200
      + (def.attractionBonus ?? 0) * 2
    );
    return { defId: item.defId, refund };
  }

  /** Snapshot for save. Strips the model ref. */
  snapshot(): PersistedPlacement[] {
    return this.items.map((it) => ({
      uid: it.uid, defId: it.defId, x: it.x, z: it.z, rotY: it.rotY,
    }));
  }

  /** Aggregated stat bonuses across all placed furniture. Used by the
   * Game to adjust guest spawn rate, satisfaction, and rating. */
  getAggregateStats(): { style: number; comfort: number; attractionBonus: number; ratingBonus: number } {
    let style = 0, comfort = 0, attractionBonus = 0, ratingBonus = 0;
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (!def) continue;
      style += def.style ?? 0;
      comfort += def.comfort ?? 0;
      attractionBonus += def.attractionBonus ?? 0;
      ratingBonus += def.ratingBonus ?? 0;
    }
    return { style, comfort, attractionBonus, ratingBonus };
  }

  /** Re-instantiate placements from a save. Resolves once every model
   * is loaded (or skipped if unknown id / load error). */
  async restore(saved: PersistedPlacement[]): Promise<void> {
    await Promise.all(saved.map(async (p) => {
      const def = getFurnitureDef(p.defId);
      if (!def) {
        console.warn(`Skipping unknown placed furniture id: ${p.defId}`);
        return;
      }
      try {
        const model = await this.loader.load(def.modelPath);
        model.position.set(p.x, 0, p.z);
        model.rotation.y = p.rotY;
        model.scale.setScalar(def.scale);
        this.scene.add(model);
        this.items.push({ uid: p.uid, defId: p.defId, x: p.x, z: p.z, rotY: p.rotY, model });
      } catch (err) {
        console.warn(`Failed to restore placed furniture ${def.id}`, err);
      }
    }));
  }
}
