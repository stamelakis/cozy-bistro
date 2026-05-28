import * as THREE from "three";
import type { ModelLoader } from "../assets/ModelLoader";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { fitFurniture } from "../assets/fitFurniture";

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

  /** Bulk-register many existing models (e.g. the demo placements that
   * WorldScene puts in directly). Skips cells already occupied. */
  registerExisting(items: { defId: string; x: number; z: number; rotY: number; model: THREE.Object3D }[]): void {
    for (const it of items) {
      if (this.isOccupied(it.x, it.z)) continue;
      this.register(it.defId, it.x, it.z, it.rotY, it.model);
    }
  }

  /** True if any item is already at the given snapped cell. Allows a half-
   * cell tolerance so chairs placed at fractional coords (e.g. -2.9, 1.0)
   * register as occupying the nearest integer cell too. */
  isOccupied(x: number, z: number): boolean {
    return this.findIndexNear(x, z) >= 0;
  }

  /** Find a placed item near the given snapped cell. Uses ±0.6 tolerance
   * so demo placements at fractional coords (chairs around table centers)
   * can still be picked by Move/Sell mode. Most recently-placed wins. */
  findAt(x: number, z: number): PlacedFurnitureItem | null {
    const i = this.findIndexNear(x, z);
    return i >= 0 ? this.items[i] : null;
  }

  /** Internal: return the index of the nearest item within ±0.6 of (x, z),
   * or -1. Searches newest-first so player placements beat demo. */
  private findIndexNear(x: number, z: number): number {
    const TOL = 0.6;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const it = this.items[i];
      const dx = it.x - x;
      const dz = it.z - z;
      const d2 = dx * dx + dz * dz;
      if (Math.abs(dx) <= TOL && Math.abs(dz) <= TOL && d2 < bestDist) {
        bestDist = d2;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /** Remove the item at the given cell and return its def + refund value.
   * Refund = 50% of base cost, plus small bonuses for premium stats so
   * selling a Linen Table doesn't punish the player as hard as selling a
   * plain wooden chair. Returns null if nothing was there. */
  removeAt(x: number, z: number): { defId: string; refund: number } | null {
    const idx = this.findIndexNear(x, z);
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

  /** Move an existing item to a new cell. Returns true on success
   * (item exists, new cell is free or the same). */
  relocate(uid: string, x: number, z: number): boolean {
    const item = this.items.find((it) => it.uid === uid);
    if (!item) return false;
    if (item.x === x && item.z === z) return true;
    if (this.isOccupied(x, z)) return false;
    item.x = x; item.z = z;
    item.model.position.set(x, 0, z);
    return true;
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

  /** Count of placed items of a specific id. Used to detect sinks /
   * dishwashers for the wash-rate calculation. */
  countById(defId: string): number {
    let n = 0;
    for (const it of this.items) if (it.defId === defId) n += 1;
    return n;
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
        fitFurniture(model, def);
        model.position.set(p.x, model.position.y, p.z);
        model.rotation.y = p.rotY;
        this.scene.add(model);
        this.items.push({ uid: p.uid, defId: p.defId, x: p.x, z: p.z, rotY: p.rotY, model });
      } catch (err) {
        console.warn(`Failed to restore placed furniture ${def.id}`, err);
      }
    }));
  }
}
