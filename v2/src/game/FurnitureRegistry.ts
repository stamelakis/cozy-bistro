import * as THREE from "three";
import type { ModelLoader } from "../assets/ModelLoader";
import { getFurnitureDef, type FurnitureDef, type SeatSlot } from "../data/furnitureCatalog";
import { fitFurniture, placementY } from "../assets/fitFurniture";

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
  /** For surface-placed items: the host's uid. The item rides along when
   * the host moves and is cascade-removed when the host is sold. */
  parentUid?: string;
  /** For surface-placed items: which entry in the host def's surfaceSlots
   * array this item occupies. Reserves the slot against further placements
   * on the same host. */
  slotIndex?: number;
}

export interface PersistedPlacement {
  uid: string;
  defId: string;
  x: number;
  z: number;
  rotY: number;
  /** Optional host link for surface-placed items. On restore, the surface
   * item is re-snapped to the host's current top after the host loads. */
  parentUid?: string;
  slotIndex?: number;
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

  /** Append a record for an already-placed model. Returns the new uid.
   * Surface items pass parentUid + slotIndex so the registry can track
   * the host link for move/sell cascades and slot reservation. */
  register(
    defId: string,
    x: number,
    z: number,
    rotY: number,
    model: THREE.Object3D,
    parent?: { parentUid: string; slotIndex: number },
  ): string {
    const uid = makeUid();
    const item: PlacedFurnitureItem = { uid, defId, x, z, rotY, model };
    if (parent) {
      item.parentUid = parent.parentUid;
      item.slotIndex = parent.slotIndex;
    }
    this.items.push(item);
    return uid;
  }

  /** Indices into a host's surfaceSlots that are currently occupied by
   * a surface-placed child. BuildMenu uses this to find the nearest
   * FREE slot when previewing a surface-item placement. */
  getOccupiedSurfaceSlots(hostUid: string, excludeUid?: string): Set<number> {
    const out = new Set<number>();
    for (const it of this.items) {
      if (it.uid === excludeUid) continue;
      if (it.parentUid === hostUid && typeof it.slotIndex === "number") {
        out.add(it.slotIndex);
      }
    }
    return out;
  }

  /** Walk a host's surface children and reposition / rotate each to
   * track the host's new pose. The local (dx, dz) offsets from the
   * host def's surfaceSlots array are rotated into world by the host's
   * rotY. Y stays the same — surface items sit on the host's top, which
   * doesn't change when the host moves horizontally. */
  private reseatSurfaceChildren(hostUid: string): void {
    const host = this.items.find((it) => it.uid === hostUid);
    if (!host) return;
    const hostDef = getFurnitureDef(host.defId);
    const slots = hostDef?.surfaceSlots;
    if (!slots || slots.length === 0) return;
    const cos = Math.cos(host.rotY), sin = Math.sin(host.rotY);
    for (const child of this.items) {
      if (child.parentUid !== hostUid) continue;
      if (typeof child.slotIndex !== "number") continue;
      const slot = slots[child.slotIndex];
      if (!slot) continue;
      // Rotate the host-local (dx, dz) offset into world, then add the
      // host's centre. Standard R_y(rotY) * (dx, 0, dz).
      const wx = host.x + slot.dx * cos + slot.dz * sin;
      const wz = host.z - slot.dx * sin + slot.dz * cos;
      child.x = wx;
      child.z = wz;
      child.rotY = host.rotY;
      child.model.position.set(wx, child.model.position.y, wz);
      child.model.rotation.y = host.rotY;
    }
  }

  /** Bulk-register many existing models (e.g. the demo placements that
   * WorldScene puts in directly). Skips cells already occupied. */
  registerExisting(items: { defId: string; x: number; z: number; rotY: number; model: THREE.Object3D }[]): void {
    for (const it of items) {
      if (this.isOccupied(it.x, it.z)) continue;
      this.register(it.defId, it.x, it.z, it.rotY, it.model);
    }
  }

  /** True if an item on the SAME placement layer is already at the
   * given cell. Allows a half-cell tolerance so chairs placed at
   * fractional coords (e.g. -2.9, 1.0) register as occupying the
   * nearest integer cell too. Pass `excludeUid` to skip a specific
   * item (used during move mode so an item doesn't block its own
   * destination). The `layer` decides which placement plane to check:
   *   - "tile"   (default): floor furniture. Skips edge/wall items
   *              (they don't claim a tile) AND skips ceiling items
   *              (different plane).
   *   - "ceiling": only checks other ceiling items at this cell. A
   *              floor item underneath a hanging lamp doesn't block. */
  isOccupied(x: number, z: number, excludeUid?: string, layer: "tile" | "ceiling" = "tile"): boolean {
    return this.findIndexNear(x, z, excludeUid, layer) >= 0;
  }

  /** True if any same-layer item's FOOTPRINT covers the integer cell
   * (cellX, cellZ). Differs from {@link isOccupied} in that it honours
   * the placed item's footprint mask — an L-shaped corner sofa's open
   * elbow doesn't count as occupied, so the player can drop a coffee
   * table into the open corner without the simple ±0.6 tolerance check
   * falsely blocking it. This is the right per-cell test when you've
   * already enumerated the would-be placement's footprint cells via
   * {@link footprintCells} and need to verify each one is clear. */
  isCellBlocked(cellX: number, cellZ: number, excludeUid: string | undefined, layer: "tile" | "ceiling"): boolean {
    for (const it of this.items) {
      if (excludeUid && it.uid === excludeUid) continue;
      const def = getFurnitureDef(it.defId);
      if (!def) continue;
      const placement = def.placement ?? "tile";
      if (placement !== layer) continue;
      if (footprintCoversCell(it, def, cellX, cellZ)) return true;
    }
    return false;
  }

  /** Find a placed item near the given snapped cell. Uses ±0.6 tolerance
   * so demo placements at fractional coords (chairs around table centers)
   * can still be picked by Move/Sell mode. Most recently-placed wins.
   * Considers ALL placement layers so Sell mode can target walls,
   * ceilings, and floor items by clicking the cell. */
  findAt(x: number, z: number, excludeUid?: string): PlacedFurnitureItem | null {
    const i = this.findIndexNear(x, z, excludeUid, "any");
    return i >= 0 ? this.items[i] : null;
  }

  /** Internal: return the index of the nearest item within ±0.6 of (x, z),
   * or -1. Searches newest-first so player placements beat demo.
   *   - layer="tile": consider only tile-claiming floor items (skip
   *     edge/wall/ceiling).
   *   - layer="ceiling": consider only ceiling items.
   *   - layer="any": include every item (used by Move/Sell pickup). */
  private findIndexNear(x: number, z: number, excludeUid: string | undefined, layer: "tile" | "ceiling" | "any"): number {
    const TOL = 0.6;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const it = this.items[i];
      if (excludeUid && it.uid === excludeUid) continue;
      if (layer !== "any") {
        const placement = getFurnitureDef(it.defId)?.placement ?? "tile";
        if (layer === "tile") {
          // Floor layer: skip everything that isn't "tile".
          if (placement !== "tile") continue;
        } else {
          // Ceiling layer: skip everything that isn't "ceiling".
          if (placement !== "ceiling") continue;
        }
      }
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
    // Sell mode should be able to target walls / wall-mounted items /
    // ceiling items too, so include all placements here (layer="any").
    const idx = this.findIndexNear(x, z, undefined, "any");
    if (idx < 0) return null;
    const item = this.items[idx];
    this.scene.remove(item.model);
    this.items.splice(idx, 1);
    this.surfaceExtentCache.delete(item.uid);
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
    // If this item is a host (has children with parentUid === uid),
    // ride its surface-placed items along to the new pose.
    this.reseatSurfaceChildren(uid);
    return true;
  }

  /** Remove a specific placed item by uid. Returns the def + refund value
   * (mirrors removeAt) or null. Used by undo of a `place`. If the removed
   * item is a host of any surface items, those are removed too and their
   * refunds folded into the returned value — the caller (BuildMenu sell)
   * pays out the whole stack in one go. */
  removeAtByUid(uid: string): { defId: string; refund: number } | null {
    const idx = this.items.findIndex((it) => it.uid === uid);
    if (idx < 0) return null;
    const item = this.items[idx];
    // Cascade: drop any surface-placed children first so their slots and
    // refunds are released alongside the host. Walk a copy since the
    // splice below mutates this.items.
    const children = this.items.filter((c) => c.parentUid === uid);
    let totalChildRefund = 0;
    for (const child of children) {
      const cIdx = this.items.findIndex((it) => it.uid === child.uid);
      if (cIdx < 0) continue;
      this.scene.remove(child.model);
      this.items.splice(cIdx, 1);
      const cDef = getFurnitureDef(child.defId);
      totalChildRefund += cDef?.cost ?? 0;
    }
    // Re-find the host's index since the splices above shifted entries.
    const finalIdx = this.items.findIndex((it) => it.uid === uid);
    if (finalIdx >= 0) {
      this.scene.remove(this.items[finalIdx].model);
      this.items.splice(finalIdx, 1);
    }
    // Drop the cached surface extent for both the host and any
    // cascaded surface children so the map doesn't grow unbounded.
    this.surfaceExtentCache.delete(uid);
    for (const child of children) this.surfaceExtentCache.delete(child.uid);
    const def = getFurnitureDef(item.defId);
    return { defId: item.defId, refund: (def?.cost ?? 0) + totalChildRefund };
  }

  /** Read-only snapshot of every placed item (used by BuildMenu auto-arrange
   * to diff before/after). Models are included by reference so callers
   * must not mutate them. */
  snapshotItems(): readonly PlacedFurnitureItem[] {
    return this.items;
  }

  /** Move an existing item to a new cell. Returns true on success
   * (item exists, new cell is free or the same). Checks occupancy on
   * the same placement layer using the full footprint so a corner sofa
   * moving INTO a spot whose elbow already has a coffee table still
   * relocates (the elbow cell is mask = 0). */
  relocate(uid: string, x: number, z: number): boolean {
    const item = this.items.find((it) => it.uid === uid);
    if (!item) return false;
    if (item.x === x && item.z === z) return true;
    const def = getFurnitureDef(item.defId);
    if (!def) return false;
    const layer: "tile" | "ceiling" = def.placement === "ceiling" ? "ceiling" : "tile";
    const cells = footprintCells({ x, z, rotY: item.rotY }, def);
    for (const cell of cells) {
      if (this.isCellBlocked(cell.x, cell.z, uid, layer)) return false;
    }
    item.x = x; item.z = z;
    // Preserve the model's Y — relocating a ceiling lamp keeps it on
    // the ceiling, a floor table keeps its floor Y.
    item.model.position.set(x, item.model.position.y, z);
    // Cascade surface children to the new host pose.
    this.reseatSurfaceChildren(uid);
    return true;
  }

  /** Snapshot for save. Strips the model ref. parentUid / slotIndex
   * are persisted so surface items re-snap to their hosts on load. */
  snapshot(): PersistedPlacement[] {
    return this.items.map((it) => {
      const p: PersistedPlacement = { uid: it.uid, defId: it.defId, x: it.x, z: it.z, rotY: it.rotY };
      if (it.parentUid) p.parentUid = it.parentUid;
      if (typeof it.slotIndex === "number") p.slotIndex = it.slotIndex;
      return p;
    });
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

  /** Internal: find the uid of a chair AT a slot. We check whether the
   * chair's FOOTPRINT covers the slot's tile — that way a 2-tile sofa
   * placed across two adjacent slots fills BOTH of them with the same
   * sofa uid (so 2 customers can sit on a single sofa). For 1×1 chairs
   * this reduces to a position match like before. The footprint check
   * honours the chair's rotation and any explicit footprint mask (e.g.
   * the L-shape corner sofa). Position-only — we deliberately don't
   * gate on chair rotation orientation, see the long comment in
   * isChairAtAnySlot. */
  private findChairAtSlot(slotX: number, slotZ: number, _slotFacing: number, excludeUid?: string): string | null {
    const cellX = Math.round(slotX);
    const cellZ = Math.round(slotZ);
    for (const it of this.items) {
      if (excludeUid && it.uid === excludeUid) continue;
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "chair") continue;
      if (footprintCoversCell(it, def, cellX, cellZ)) return it.uid;
    }
    return null;
  }

  /** Which kind of orders a placed TABLE accepts. Returns null for
   * non-tables or unknown ids. Used by GuestSpawner.buildOrder to
   * restrict drink-only coffee tables to the drink menu. */
  getTableSurface(tableUid: string): "food" | "drink" | null {
    const it = this.items.find((x) => x.uid === tableUid);
    if (!it) return null;
    const def = getFurnitureDef(it.defId);
    if (def?.category !== "table") return null;
    return def.surface ?? "food";
  }

  /** World-Y of the top surface of a placed table, derived from the
   * model's actual bounding box. Used by GuestSpawner to land plates
   * and dirty leftovers ON the table instead of at a hard-coded
   * height — coffee tables (~0.42m) and dining tables (0.75m) now
   * both look right. Returns null for an unknown uid. */
  getTableTopY(tableUid: string): number | null {
    const it = this.items.find((x) => x.uid === tableUid);
    if (!it) return null;
    it.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(it.model);
    if (!Number.isFinite(box.max.y)) return null;
    return box.max.y;
  }

  /** Public wrapper around the cached local-frame half-extents. Lets
   * GuestSpawner clamp leftover plates onto the actual tabletop
   * regardless of how rectangular the Kenney mesh's aspect comes in.
   * Returns null when the uid isn't known. */
  getTableSurfaceExtent(tableUid: string): { halfW: number; halfD: number } | null {
    const it = this.items.find((x) => x.uid === tableUid);
    if (!it) return null;
    return this.getLocalSurfaceExtent(it);
  }

  /** All integer cells this placed item's footprint actually occupies.
   * Multi-tile items expand to all their cells; L-shaped items honour
   * their explicit footprint mask. Caller cares about the cells either
   * for blocking (pathfinding) or for slot matching (chair detection). */
  getFootprintCells(item: PlacedFurnitureItem, def: FurnitureDef): { x: number; z: number }[] {
    return footprintCells(item, def);
  }

  /** Required chair.rotY for a chair to sit at a slot with the
   * customer facing slot.facingY toward the table.
   *
   * The Kenney chair GLB has its back at -Z by default. The customer's
   * BODY back is the opposite of the customer's facing direction, so
   * for the chair's back to coincide with the customer's body back, the
   * chair rotation needs to differ from the customer's by 180° —
   * chair.rotY = slot.facingY + π. */
  static chairRotForSlot(slotFacingY: number): number {
    return slotFacingY + Math.PI;
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
      // Multi-tile sofas/benches don't snap to a single slot — see the
      // matching gate in BuildMenu. Leave them where the player put them.
      if (def.size.width > 1 || def.size.depth > 1) continue;
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

  /** Is this chair currently filling any of its tables' slots? Uses the
   * footprint check so a 2-tile sofa parked across two slots reports
   * "yes, I'm at a slot" even when its anchor sits between them. */
  private isChairAtAnySlot(chair: PlacedFurnitureItem): boolean {
    const def = getFurnitureDef(chair.defId);
    if (!def) return false;
    for (const slot of this.getResolvedSeatSlots()) {
      if (footprintCoversCell(chair, def, Math.round(slot.x), Math.round(slot.z))) return true;
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

  /** Cached per-table local-frame half-extents of the actual placed
   * model. Lets rotateSlotOffset derive plate positions from the
   * table's ACTUAL visible size instead of hard-coded seat-slot
   * offsets — which only happened to fit a fully-square 2×2 model and
   * left plates floating in mid-air on tables whose Kenney mesh
   * comes in with a more rectangular aspect ratio. Rotation-invariant
   * by construction so the cache survives a setPose. */
  private readonly surfaceExtentCache = new Map<string, { halfW: number; halfD: number }>();

  /** Measure the placed model's local-frame surface half-extents. The
   * scene-graph world box is what THREE.Box3 gives us cheaply; because
   * items snap to 90° increments we can recover the natural-frame
   * (rotY=0) extents by swapping X/Z when the item is at π/2 or 3π/2. */
  private getLocalSurfaceExtent(item: PlacedFurnitureItem): { halfW: number; halfD: number } {
    const cached = this.surfaceExtentCache.get(item.uid);
    if (cached) return cached;
    item.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(item.model);
    if (!Number.isFinite(box.max.x) || box.max.x === -Infinity) {
      // Model hasn't loaded yet — return a sensible fallback derived
      // from the footprint and DON'T cache (so we retry next call).
      const def = getFurnitureDef(item.defId);
      const halfW = def ? def.size.width / 2 - 0.05 : 0.5;
      const halfD = def ? def.size.depth / 2 - 0.05 : 0.5;
      return { halfW, halfD };
    }
    const worldHalfX = (box.max.x - box.min.x) / 2;
    const worldHalfZ = (box.max.z - box.min.z) / 2;
    const swap = Math.abs(Math.sin(item.rotY)) > 0.5;
    const result = {
      halfW: swap ? worldHalfZ : worldHalfX,
      halfD: swap ? worldHalfX : worldHalfZ,
    };
    this.surfaceExtentCache.set(item.uid, result);
    return result;
  }

  /** Internal: apply the table's rotation to a slot offset so a rotated
   * table's seats still land in the right world positions.
   *
   * Plate position is COMPUTED from the table's measured local-frame
   * surface extent (not the seat slot's static platePos). The seat's
   * (dx, dz) tells us which side of the table the chair sits on; the
   * plate is placed on that edge of the actual model, PLATE_MARGIN
   * inside. That way a rectangular Kenney dining-table mesh with a
   * 2-tile footprint gets plates ON its tabletop instead of floating
   * 30 cm off the short edge. */
  private rotateSlotOffset(slot: SeatSlot, table: PlacedFurnitureItem):
    { dx: number; dz: number; platePos: { dx: number; dz: number } } {
    const c = Math.cos(table.rotY);
    const s = Math.sin(table.rotY);
    const rot = (dx: number, dz: number): { dx: number; dz: number } => ({
      dx: c * dx + s * dz,
      dz: -s * dx + c * dz,
    });
    const seat = rot(slot.dx, slot.dz);

    const extent = this.getLocalSurfaceExtent(table);
    const PLATE_MARGIN = 0.15;
    const maxX = Math.max(0, extent.halfW - PLATE_MARGIN);
    const maxZ = Math.max(0, extent.halfD - PLATE_MARGIN);
    let plateDx: number;
    let plateDz: number;
    if (Math.abs(slot.dz) >= Math.abs(slot.dx)) {
      // Chair is more N/S of centre than E/W — plate sits on the
      // table's near Z-edge.
      plateDz = Math.sign(slot.dz) * maxZ;
      plateDx = Math.max(-maxX, Math.min(maxX, slot.dx));
    } else {
      plateDx = Math.sign(slot.dx) * maxX;
      plateDz = Math.max(-maxZ, Math.min(maxZ, slot.dz));
    }
    const plate = rot(plateDx, plateDz);

    return { dx: seat.dx, dz: seat.dz, platePos: { dx: plate.dx, dz: plate.dz } };
  }

  /** Normalize an angle into (-π, π] so |delta| math is meaningful. */
  private normalizeAngle(a: number): number {
    let v = a % (Math.PI * 2);
    if (v > Math.PI) v -= Math.PI * 2;
    if (v <= -Math.PI) v += Math.PI * 2;
    return v;
  }

  /** Every visible placed toilet (id starting with "toilet"). Used by
   * GuestSpawner to route WC-needing customers to the nearest free
   * fixture. The "standing spot" is one tile in front of the toilet
   * along its facing axis — that's where the customer stops. */
  getToilets(): { uid: string; x: number; z: number; rotY: number; standPos: THREE.Vector2 }[] {
    const out: { uid: string; x: number; z: number; rotY: number; standPos: THREE.Vector2 }[] = [];
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "bathroom") continue;
      if (!def.id.startsWith("toilet")) continue;
      if (!this.isVisibleInScene(it.model)) continue;
      // Same +Z-front convention as stoves: rotate the unit +Z by rotY
      // to get the customer's stand-in-front spot.
      const standPos = new THREE.Vector2(
        it.x + Math.sin(it.rotY),
        it.z + Math.cos(it.rotY),
      );
      out.push({ uid: it.uid, x: it.x, z: it.z, rotY: it.rotY, standPos });
    }
    return out;
  }

  /** Every visible placed bathroom sink (id starting with
   * "bathroom-sink"). GuestSpawner routes WC visitors to a free sink
   * after the toilet step so the wash-hands quality also feeds back
   * into the rating. Same +Z-stand-spot convention as toilets. */
  getBathroomSinks(): { uid: string; x: number; z: number; rotY: number; standPos: THREE.Vector2 }[] {
    const out: { uid: string; x: number; z: number; rotY: number; standPos: THREE.Vector2 }[] = [];
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "bathroom") continue;
      if (!def.id.startsWith("bathroom-sink")) continue;
      if (!this.isVisibleInScene(it.model)) continue;
      const standPos = new THREE.Vector2(
        it.x + Math.sin(it.rotY),
        it.z + Math.cos(it.rotY),
      );
      out.push({ uid: it.uid, x: it.x, z: it.z, rotY: it.rotY, standPos });
    }
    return out;
  }

  /** A "quality" snapshot of the placed bathroom. Tracks toilet AND
   * sink counts separately so GuestSpawner.finalizeVisit can blend
   * the wash-hands step into the rating alongside the toilet step.
   * `quality` is a heuristic across every bathroom-category item. A
   * plain 1-toilet + 1-sink bathroom scores ~4 quality; a full setup
   * (toilet-sq + sink-sq + mirror + shower + cabinet) scores ~18-22. */
  getBathroomScore(): { toiletCount: number; sinkCount: number; quality: number } {
    let toiletCount = 0;
    let sinkCount = 0;
    let quality = 0;
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (!def) continue;
      if (def.category !== "bathroom") continue;
      if (!this.isVisibleInScene(it.model)) continue;
      if (def.id.startsWith("toilet")) toiletCount += 1;
      if (def.id.startsWith("bathroom-sink")) sinkCount += 1;
      quality += (def.style ?? 0) + (def.comfort ?? 0) +
                 (def.attractionBonus ?? 0) * 2 +
                 (def.ratingBonus ?? 0) * 20;
    }
    return { toiletCount, sinkCount, quality };
  }

  /** Every visible placed stove the chef can actually COOK at — i.e.
   * the gas/electric stoves themselves, NOT the kitchen sink or
   * dishwasher (both share the "stove" category but are appliances,
   * not burners). StaffRouter uses this to assign chefs 1-to-1; the
   * world position is the stove's footprint centre and rotY is its
   * model rotation (used to compute the chef standing position one
   * tile in front of it). */
  /** Every placed kitchen wash station — basic sinks plus dishwashers.
   * Each carries a `dwell` (seconds the waiter actually stays at the
   * station) which has different meaning per type:
   *   - sink: full scrub time. When dwell ends the piece is clean.
   *   - dishwasher / dishwasher-pro: just "load and walk away" time.
   *     The actual wash happens asynchronously inside DishwareSystem's
   *     dishwasher batch cycle; the waiter has already left.
   * standPos puts the waiter one tile in front (+Z) of the unit,
   * matching the toilet / sink stand convention. */
  getWashStations(): { uid: string; defId: string; x: number; z: number; rotY: number; standPos: THREE.Vector2; dwell: number }[] {
    const out: { uid: string; defId: string; x: number; z: number; rotY: number; standPos: THREE.Vector2; dwell: number }[] = [];
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "wash") continue;
      if (!this.isVisibleInScene(it.model)) continue;
      const dwell = it.defId === "dishwasher-pro" ? 0.3
        : it.defId === "dishwasher" ? 0.5
        : 3.0; // sink — manual scrub takes longest
      const standPos = new THREE.Vector2(
        it.x + Math.sin(it.rotY),
        it.z + Math.cos(it.rotY),
      );
      out.push({ uid: it.uid, defId: it.defId, x: it.x, z: it.z, rotY: it.rotY, standPos, dwell });
    }
    return out;
  }

  getStoves(): { uid: string; x: number; z: number; rotY: number }[] {
    const out: { uid: string; x: number; z: number; rotY: number }[] = [];
    for (const it of this.items) {
      if (it.defId !== "stove" && it.defId !== "stove-electric") continue;
      if (!this.isVisibleInScene(it.model)) continue;
      out.push({ uid: it.uid, x: it.x, z: it.z, rotY: it.rotY });
    }
    return out;
  }

  /** @deprecated Phase C.2 superseded this with the broader
   * {@link getCookStations}. Kept for one revision in case any
   * external caller still references it. */
  getCookingStoves(): { uid: string; defId: string; model: THREE.Object3D }[] {
    return this.getCookStations().filter((s) => s.defId === "stove" || s.defId === "stove-electric");
  }

  /** Count of placed items of a specific id. Used to detect sinks /
   * dishwashers for the wash-rate calculation. */
  countById(defId: string): number {
    let n = 0;
    for (const it of this.items) if (it.defId === defId) n += 1;
    return n;
  }

  /** Set of every appliance id at least one placed item provides.
   * Used by the cooking system to gate recipes by their required
   * equipment — a recipe with appliances: ["toaster"] is only
   * makeable when this set contains "toaster". */
  getProvidedAppliances(): Set<string> {
    const out = new Set<string>();
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (def?.provides) out.add(def.provides);
    }
    return out;
  }

  /** Every placed item that can serve as a cook station — anything
   * with a `provides` value in its def. StaffRouter uses this to match
   * a recipe's required appliance to a specific place in the kitchen
   * so chefs walk to the toaster for toast, the coffee machine for a
   * latte, etc. The defId + model fields let WorldScene pin a
   * per-variant visual effect (flame, toaster glow, coffee steam, etc.)
   * to each station model. */
  getCookStations(): { uid: string; defId: string; model: THREE.Object3D; provides: string; x: number; z: number; rotY: number }[] {
    const out: { uid: string; defId: string; model: THREE.Object3D; provides: string; x: number; z: number; rotY: number }[] = [];
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (!def?.provides) continue;
      if (!this.isVisibleInScene(it.model)) continue;
      out.push({ uid: it.uid, defId: it.defId, model: it.model, provides: def.provides, x: it.x, z: it.z, rotY: it.rotY });
    }
    return out;
  }

  /** Re-instantiate placements from a save. Resolves once every model
   * is loaded (or skipped if unknown id / load error). Surface-placed
   * items override their Y from the host's measured top after the host
   * loads, since placementY's "floor" default would otherwise drop them
   * to y=0. */
  async restore(saved: PersistedPlacement[]): Promise<void> {
    // Load every item first — order doesn't matter for tile/wall/edge/
    // ceiling items, and the surface re-snap happens AFTER everything
    // is in place so each surface child can look up its host.
    await Promise.all(saved.map(async (p) => {
      const def = getFurnitureDef(p.defId);
      if (!def) {
        console.warn(`Skipping unknown placed furniture id: ${p.defId}`);
        return;
      }
      try {
        const model = await this.loader.load(def.modelPath);
        fitFurniture(model, def);
        // Use the shared placementY helper so a save round-trip puts
        // ceiling lamps back on the ceiling, wall sconces at chest
        // height, and floor items on the ground — matches the
        // BuildMenu place handler exactly. Surface items get a
        // placeholder Y and are corrected below once every host model
        // exists.
        model.position.set(p.x, placementY(model, def), p.z);
        model.rotation.y = p.rotY;
        this.scene.add(model);
        const item: PlacedFurnitureItem = { uid: p.uid, defId: p.defId, x: p.x, z: p.z, rotY: p.rotY, model };
        if (p.parentUid) item.parentUid = p.parentUid;
        if (typeof p.slotIndex === "number") item.slotIndex = p.slotIndex;
        this.items.push(item);
      } catch (err) {
        console.warn(`Failed to restore placed furniture ${def.id}`, err);
      }
    }));
    // Second pass: surface items get their Y from the host's measured
    // top and a fresh pose computed from the host's current (x, z, rotY).
    // This survives the host having been moved / rotated between save
    // and load — the slot offset is in the host's local frame.
    for (const child of this.items) {
      if (!child.parentUid || typeof child.slotIndex !== "number") continue;
      const host = this.items.find((it) => it.uid === child.parentUid);
      if (!host) continue;
      const hostDef = getFurnitureDef(host.defId);
      const slot = hostDef?.surfaceSlots?.[child.slotIndex];
      if (!slot) continue;
      host.model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(host.model);
      const topY = box.max.y;
      const cos = Math.cos(host.rotY), sin = Math.sin(host.rotY);
      const wx = host.x + slot.dx * cos + slot.dz * sin;
      const wz = host.z - slot.dx * sin + slot.dz * cos;
      child.x = wx;
      child.z = wz;
      child.rotY = host.rotY;
      child.model.position.set(wx, topY, wz);
      child.model.rotation.y = host.rotY;
    }
  }
}

// === Footprint helpers ===================================================
// A placed item's "footprint" is the set of integer floor cells it
// covers. By default it's a solid rectangle of def.size.{width, depth};
// items with an explicit def.footprint mask (L-shaped corner sofas) opt
// into a per-cell pattern. The mask is authored at rotY=0 with rows
// indexing Z and columns indexing X; it rotates with the item for
// axis-aligned rotations.

/** Bucket the item's rotation into one of {0°, 90°, 180°, 270°} for
 * footprint math. Players rotate by π/2 increments via R, so this is
 * lossless in practice. */
function axisAlignedSinCos(rotY: number): { sin: -1 | 0 | 1; cos: -1 | 0 | 1 } {
  const sin = Math.round(Math.sin(rotY));
  const cos = Math.round(Math.cos(rotY));
  // Math.round handles ±0; clamp to the three expected magnitudes.
  return {
    sin: (sin === 0 ? 0 : sin > 0 ? 1 : -1) as -1 | 0 | 1,
    cos: (cos === 0 ? 0 : cos > 0 ? 1 : -1) as -1 | 0 | 1,
  };
}

/** True if the integer cell (cellX, cellZ) lies inside this item's
 * footprint, after rotation. Handles both the default solid rectangle
 * and the optional def.footprint mask. Exported so Pathfinding can
 * mark blocked cells without re-implementing the L-shape math. */
export function footprintCoversCell(item: { x: number; z: number; rotY: number }, def: FurnitureDef, cellX: number, cellZ: number): boolean {
  const { sin, cos } = axisAlignedSinCos(item.rotY);
  const swapped = sin !== 0;
  const W = def.size.width;
  const D = def.size.depth;
  const effW = swapped ? D : W;
  const effD = swapped ? W : D;
  // Integer-cell extents covered by the rotated footprint rectangle.
  const minX = Math.round(item.x - effW / 2 + 0.5);
  const maxX = Math.round(item.x + effW / 2 - 0.5);
  const minZ = Math.round(item.z - effD / 2 + 0.5);
  const maxZ = Math.round(item.z + effD / 2 - 0.5);
  if (cellX < minX || cellX > maxX) return false;
  if (cellZ < minZ || cellZ > maxZ) return false;
  if (!def.footprint) return true;
  // (i, j) is the cell's position WITHIN the rotated effective grid;
  // translate back into the original (rotY=0) mask coordinates.
  const i = cellX - minX;
  const j = cellZ - minZ;
  let mi: number, mj: number;
  if (sin === 0 && cos === 1) {        // 0°
    mi = i;          mj = j;
  } else if (sin === 1 && cos === 0) { // R_y(+π/2) — sin = +1
    mi = W - 1 - j;  mj = i;
  } else if (sin === 0 && cos === -1) {// 180°
    mi = W - 1 - i;  mj = D - 1 - j;
  } else {                              // R_y(-π/2) — sin = -1
    mi = j;          mj = D - 1 - i;
  }
  return def.footprint[mj]?.[mi] !== 0;
}

/** Every integer cell this item's footprint covers, honouring rotation
 * + mask. Used by Pathfinding to mark blocked cells for A*. */
export function footprintCells(item: { x: number; z: number; rotY: number }, def: FurnitureDef): { x: number; z: number }[] {
  const { sin } = axisAlignedSinCos(item.rotY);
  const swapped = sin !== 0;
  const effW = swapped ? def.size.depth : def.size.width;
  const effD = swapped ? def.size.width : def.size.depth;
  const minX = Math.round(item.x - effW / 2 + 0.5);
  const maxX = Math.round(item.x + effW / 2 - 0.5);
  const minZ = Math.round(item.z - effD / 2 + 0.5);
  const maxZ = Math.round(item.z + effD / 2 - 0.5);
  const out: { x: number; z: number }[] = [];
  for (let cx = minX; cx <= maxX; cx += 1) {
    for (let cz = minZ; cz <= maxZ; cz += 1) {
      if (footprintCoversCell(item, def, cx, cz)) out.push({ x: cx, z: cz });
    }
  }
  return out;
}
