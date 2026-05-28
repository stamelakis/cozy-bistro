import * as THREE from "three";
import type { ModelLoader } from "../assets/ModelLoader";
import { getFurnitureDef, type SeatSlot } from "../data/furnitureCatalog";
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

/** A resolved seat-slot from a placed table — world coords for chair and plate. */
export interface ResolvedSeatSlot {
  /** uid of the table this slot belongs to. */
  tableUid: string;
  /** Index into table.def.seatSlots — lets the GuestSpawner stamp persistent
   * ids per slot ("table-X#slot-2") so it can track occupancy across frames. */
  slotIndex: number;
  /** World chair position. */
  x: number;
  z: number;
  /** Required chair facing (radians). */
  facingY: number;
  /** Where the plate goes on the table. */
  platePos: { x: number; z: number };
  /** uid of the chair currently sitting in this slot, or null if none. */
  chairUid: string | null;
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
   * register as occupying the nearest integer cell too. Pass `excludeUid`
   * to skip a specific item (used during move mode so an item doesn't
   * block its own destination). */
  isOccupied(x: number, z: number, excludeUid?: string): boolean {
    return this.findIndexNear(x, z, excludeUid) >= 0;
  }

  /** Find a placed item near the given snapped cell. Uses ±0.6 tolerance
   * so demo placements at fractional coords (chairs around table centers)
   * can still be picked by Move/Sell mode. Most recently-placed wins. */
  findAt(x: number, z: number, excludeUid?: string): PlacedFurnitureItem | null {
    const i = this.findIndexNear(x, z, excludeUid);
    return i >= 0 ? this.items[i] : null;
  }

  /** Internal: return the index of the nearest item within ±0.6 of (x, z),
   * or -1. Searches newest-first so player placements beat demo. */
  private findIndexNear(x: number, z: number, excludeUid?: string): number {
    const TOL = 0.6;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const it = this.items[i];
      if (excludeUid && it.uid === excludeUid) continue;
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

  /** Direct setter for pose (used by undo / auto-arrange). Skips the
   * occupied-cell check intentionally so a rollback can drop the item
   * back where it was even if the player has placed something there
   * since. */
  setPose(uid: string, x: number, z: number, rotY: number): boolean {
    const item = this.items.find((it) => it.uid === uid);
    if (!item) return false;
    item.x = x; item.z = z; item.rotY = rotY;
    item.model.position.set(x, item.model.position.y, z);
    item.model.rotation.y = rotY;
    return true;
  }

  /** Remove a specific placed item by uid. Returns the def + refund value
   * (mirrors removeAt) or null. Used by undo of a `place`. */
  removeAtByUid(uid: string): { defId: string; refund: number } | null {
    const idx = this.items.findIndex((it) => it.uid === uid);
    if (idx < 0) return null;
    const item = this.items[idx];
    this.scene.remove(item.model);
    this.items.splice(idx, 1);
    const def = getFurnitureDef(item.defId);
    return { defId: item.defId, refund: def?.cost ?? 0 };
  }

  /** Read-only snapshot of every placed item (used by BuildMenu auto-arrange
   * to diff before/after). Models are included by reference so callers
   * must not mutate them. */
  snapshotItems(): readonly PlacedFurnitureItem[] {
    return this.items;
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

  // === Seat-slot integration ===

  /** Tolerance for matching a chair to its table's seat slot. Position-
   * only — see findChairAtSlot for why we intentionally don't gate on
   * chair rotation. */
  private static readonly SEAT_POSITION_TOL = 0.35;

  /** Return every placed table, resolved with its seat slots in world space
   * and whether each slot is filled by a correctly-oriented chair. Pass
   * `onlyVisible: true` to skip slots whose table is currently hidden by
   * the luxury-tier visibility groups in WorldScene. Pass `excludeUid`
   * to ignore a specific chair when computing occupancy (used during move
   * so a moving chair doesn't appear to occupy its own old slot). */
  getResolvedSeatSlots(onlyVisible = false, excludeUid?: string): ResolvedSeatSlot[] {
    const out: ResolvedSeatSlot[] = [];
    for (const it of this.items) {
      if (onlyVisible && !this.isVisibleInScene(it.model)) continue;
      const def = getFurnitureDef(it.defId);
      if (!def?.seatSlots) continue;
      for (let i = 0; i < def.seatSlots.length; i += 1) {
        const slot = def.seatSlots[i];
        const world = this.rotateSlotOffset(slot, it);
        out.push({
          tableUid: it.uid,
          slotIndex: i,
          x: it.x + world.dx,
          z: it.z + world.dz,
          facingY: this.normalizeAngle(slot.facingY + it.rotY),
          platePos: { x: it.x + world.platePos.dx, z: it.z + world.platePos.dz },
          chairUid: this.findChairAtSlot(it.x + world.dx, it.z + world.dz, this.normalizeAngle(slot.facingY + it.rotY), excludeUid),
        });
      }
    }
    return out;
  }

  /** True if this object3D (or any of its ancestors) is currently visible.
   * The scene tier-visibility groups toggle `.visible = false` on locked
   * table models — guests should ignore the seats on hidden tables. */
  private isVisibleInScene(model: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = model;
    while (cur) {
      if (cur.visible === false) return false;
      cur = cur.parent;
    }
    return true;
  }

  /** Chairs not currently aligned with any table seat slot. These are the
   * "yellow" overflow chairs the waiting queue uses when no proper seat
   * is free. Only visible (non-locked) chairs are returned. */
  getOverflowChairs(): PlacedFurnitureItem[] {
    const out: PlacedFurnitureItem[] = [];
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "chair") continue;
      if (!this.isVisibleInScene(it.model)) continue;
      if (this.isChairAtAnySlot(it)) continue;
      out.push(it);
    }
    return out;
  }

  /** Find the seat slot closest to (x, z) within snap range. Returns null if
   * nothing in range. Used by BuildMenu's chair auto-snap behaviour. */
  findNearestSeatSlot(x: number, z: number, range = 1.4, excludeChairUid?: string): ResolvedSeatSlot | null {
    let best: ResolvedSeatSlot | null = null;
    let bestD2 = range * range;
    for (const s of this.getResolvedSeatSlots(false, excludeChairUid)) {
      const dx = s.x - x;
      const dz = s.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
  }

  /** Internal: find the uid of a chair AT a slot. Position-only — we
   * deliberately don't gate on chair rotation here. Many saved chairs
   * were placed with the old auto-snap logic at the "wrong" rotation
   * (the chair model's seat faces the customer correctly only when
   * chair.rotY = π - slot.facingY, but a lot of pre-fix chairs are stuck
   * at slot.facingY). Requiring an exact rotation match would silently
   * mark all of them non-functional and customers stop spawning.
   *
   * The seated customer's facing comes from slot.facingY (not the chair),
   * so they still look correctly oriented even when the chair behind
   * them is rotated 180° off — and the player can run AUTO-ARRANGE to
   * fix the visual whenever they want. */
  private findChairAtSlot(slotX: number, slotZ: number, _slotFacing: number, excludeUid?: string): string | null {
    const TOL = FurnitureRegistry.SEAT_POSITION_TOL;
    for (const it of this.items) {
      if (excludeUid && it.uid === excludeUid) continue;
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "chair") continue;
      const dx = it.x - slotX;
      const dz = it.z - slotZ;
      if (Math.abs(dx) > TOL || Math.abs(dz) > TOL) continue;
      return it.uid;
    }
    return null;
  }

  /** Required chair.rotY to make the customer face slot.facingY. Exposed
   * so BuildMenu auto-snap and auto-arrange can place the chair so that
   * the customer sitting in it faces the right way. */
  static chairRotForSlot(slotFacingY: number): number {
    return Math.PI - slotFacingY;
  }

  /** Snap each placed chair to its nearest empty seat slot within range.
   * Returns the count of chairs moved. Skips chairs already at a slot.
   * Used by the BuildMenu "Auto-Arrange" button to fix up existing or
   * saved restaurants so they line up with the new placement standard. */
  autoArrangeChairs(range = 2.0): number {
    let moved = 0;
    // Snapshot of taken positions so we don't double-claim a slot in a
    // single pass.
    const claimed = new Set<string>();
    // Existing chairs already at slots are auto-claimed so we don't kick
    // them out.
    for (const slot of this.getResolvedSeatSlots()) {
      if (slot.chairUid) claimed.add(`${slot.tableUid}#${slot.slotIndex}`);
    }
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "chair") continue;
      // Skip chairs already correctly seated.
      if (this.isChairAtAnySlot(it)) continue;
      // Find nearest empty slot.
      const target = this.findNearestEmptySlot(it.x, it.z, range, claimed);
      if (!target) continue;
      const newKey = `${target.tableUid}#${target.slotIndex}`;
      const chairRotY = FurnitureRegistry.chairRotForSlot(target.facingY);
      it.x = target.x;
      it.z = target.z;
      it.rotY = chairRotY;
      it.model.position.set(target.x, it.model.position.y, target.z);
      it.model.rotation.y = chairRotY;
      claimed.add(newKey);
      moved += 1;
    }
    return moved;
  }

  /** Is this chair currently within tolerance of any of its tables' slots?
   * Position-only — see findChairAtSlot for why rotation is intentionally
   * ignored. */
  private isChairAtAnySlot(chair: PlacedFurnitureItem): boolean {
    const TOL = FurnitureRegistry.SEAT_POSITION_TOL;
    for (const slot of this.getResolvedSeatSlots()) {
      if (Math.abs(slot.x - chair.x) > TOL) continue;
      if (Math.abs(slot.z - chair.z) > TOL) continue;
      return true;
    }
    return false;
  }

  /** Find the closest empty (not in `claimed`) slot within range. */
  private findNearestEmptySlot(
    x: number,
    z: number,
    range: number,
    claimed: Set<string>,
  ): ResolvedSeatSlot | null {
    let best: ResolvedSeatSlot | null = null;
    let bestD2 = range * range;
    for (const slot of this.getResolvedSeatSlots()) {
      const key = `${slot.tableUid}#${slot.slotIndex}`;
      if (claimed.has(key)) continue;
      const dx = slot.x - x;
      const dz = slot.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = slot; }
    }
    return best;
  }

  /** Internal: apply the table's rotation to a slot offset so a rotated
   * table's seats still land in the right world positions. */
  private rotateSlotOffset(slot: SeatSlot, table: PlacedFurnitureItem):
    { dx: number; dz: number; platePos: { dx: number; dz: number } } {
    const c = Math.cos(table.rotY);
    const s = Math.sin(table.rotY);
    const rot = (dx: number, dz: number): { dx: number; dz: number } => ({
      dx: c * dx + s * dz,
      dz: -s * dx + c * dz,
    });
    const seat = rot(slot.dx, slot.dz);
    const plate = rot(slot.platePos.dx, slot.platePos.dz);
    return { dx: seat.dx, dz: seat.dz, platePos: { dx: plate.dx, dz: plate.dz } };
  }

  /** Normalize an angle into (-π, π] so |delta| math is meaningful. */
  private normalizeAngle(a: number): number {
    let v = a % (Math.PI * 2);
    if (v > Math.PI) v -= Math.PI * 2;
    if (v <= -Math.PI) v += Math.PI * 2;
    return v;
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
