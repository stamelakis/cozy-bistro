import * as THREE from "three";
import type { ModelLoader } from "../assets/ModelLoader";
import { furnitureRefundValue, getFurnitureDef, scaledCost, type FurnitureDef, type SeatSlot } from "../data/furnitureCatalog";
import { fitFurniture, placementY, snapToAdjacentWall } from "../assets/fitFurniture";
import { isServerSim } from "./featureFlags";

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
  /** Storey index the item lives on. 0 = ground floor (always visible
   * in the main scene). 1..NUM_STOREYS-1 = upper floors (parented to
   * that storey's group so focus + tier visibility apply). Default 0
   * for any item placed before multi-storey shipped. */
  floor: number;
  /** The live Object3D in the scene. Not persisted — rebuilt on load. */
  model: THREE.Object3D;
  /** For surface-placed items: the host's uid. The item rides along when
   * the host moves and is cascade-removed when the host is sold. */
  parentUid?: string;
  /** For surface-placed items: which entry in the host def's surfaceSlots
   * array this item occupies. Reserves the slot against further placements
   * on the same host. */
  slotIndex?: number;
  /** For surface-placed items: the rotation the user chose RELATIVE to
   * the host's rotation. Stored separately so a host-move resync can
   * preserve the player's R-key spins instead of snapping every child
   * back to the host's facing. Effective world rotY is
   * `host.rotY + localRotY`. */
  localRotY?: number;
}

export interface PersistedPlacement {
  uid: string;
  defId: string;
  x: number;
  z: number;
  rotY: number;
  /** Storey index — see PlacedFurnitureItem.floor. Absent in saves
   * predating multi-storey; loader treats missing as floor 0. */
  floor?: number;
  /** Optional host link for surface-placed items. On restore, the surface
   * item is re-snapped to the host's current top after the host loads. */
  parentUid?: string;
  slotIndex?: number;
  /** Surface items: see PlacedFurnitureItem.localRotY. */
  localRotY?: number;
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
  /** Storey the table sits on (0 = ground). Phase 8 uses this to route
   * guests to the correct floor based on their drink/food preference. */
  floor: number;
  /** What this table is good for — "food" tables serve any course; "drink"
   * tables only serve drink-only orders. Mirrors the def's surface flag
   * (default "food" when unset). */
  surface: "food" | "drink";
  /** True when the underlying furniture is a bar-category piece (the
   * customer is sitting AT the bar counter, not a regular drink table
   * like a coffee table). Drives the barman-vs-waiter routing: bar-
   * seat orders + bar-seat deliveries go through the barman pool. */
  atBar: boolean;
}

let nextUidCounter = 1;
function makeUid(): string {
  return `fp-${Date.now().toString(36)}-${(nextUidCounter++).toString(36)}`;
}

/** Wrap an angle into (-π, π]. Used so a stored localRotY stays in a
 * canonical range regardless of how many R-spins the player chained
 * during placement. Keeps the addition in repositionSurfaceChildren
 * predictable when the host's rotation also wraps. */
function normaliseAngle(theta: number): number {
  const TAU = Math.PI * 2;
  let t = theta % TAU;
  if (t > Math.PI) t -= TAU;
  if (t <= -Math.PI) t += TAU;
  return t;
}

export class FurnitureRegistry {
  private readonly items: PlacedFurnitureItem[] = [];
  private readonly scene: THREE.Scene;
  private readonly loader: ModelLoader;
  /** Current luxury tier (1..5). Used by getResolvedSeatSlots(true) to
   * filter out seats on still-locked storeys (defensive — players
   * normally can't place there). Defaults to 5 so legacy callers
   * that don't wire setLuxuryTier still get every seat. Engine calls
   * setLuxuryTier whenever the player buys an expansion. */
  private currentLuxuryTier = 5;
  /** Lookup for the THREE.Object3D each storey's items should be parented
   * to. Falls back to the main scene when the engine wasn't wired up
   * with one (e.g. older tests that constructed the registry directly). */
  private readonly storeyMount?: (floor: number) => THREE.Object3D;
  /** Vertical gap between adjacent floor slabs. Added to model.position.y
   * at register / restore time so an item placed at (x, z, floor=2)
   * renders at world Y = placementY + 2 × storeyHeight. */
  private readonly storeyHeight: number;

  /** Phase F — Engine wires this so the registry's place/move/sell
   * paths can mirror the corresponding placed_furniture cloud reducer
   * when isServerSim("furniture") is on. Null in tests / pre-cloud
   * boot. Helpers below bail silently when unset. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;

  constructor(
    scene: THREE.Scene,
    loader: ModelLoader,
    storeyMount?: (floor: number) => THREE.Object3D,
    storeyHeight = 3,
  ) {
    this.scene = scene;
    this.loader = loader;
    this.storeyMount = storeyMount;
    this.storeyHeight = storeyHeight;
  }

  /** Return the parent the model for `floor` should sit inside. Ground
   * floor (0) returns the main scene. Upper floors return the storey's
   * group so visibility (focus + tier) follows automatically. */
  private mountFor(floor: number): THREE.Object3D {
    return this.storeyMount?.(floor) ?? this.scene;
  }

  /** Y offset added to a placement's base Y to lift it onto its storey
   * slab. Floor 0 = 0, Floor 1 = storeyHeight, etc. */
  floorYOffset(floor: number): number {
    return Math.max(0, floor) * this.storeyHeight;
  }

  /** Append a record for an already-placed model. Returns the new uid.
   * Surface items pass parentUid + slotIndex so the registry can track
   * the host link for move/sell cascades and slot reservation. The
   * `floor` argument records which storey the item lives on (defaults
   * to 0 = ground). Surface items inherit the host's floor automatically
   * when a parent link is provided. */
  register(
    defId: string,
    x: number,
    z: number,
    rotY: number,
    model: THREE.Object3D,
    parent?: { parentUid: string; slotIndex: number },
    floor = 0,
    fromStorage = false,
  ): string {
    const uid = makeUid();
    const item: PlacedFurnitureItem = { uid, defId, x, z, rotY, floor, model };
    if (parent) {
      item.parentUid = parent.parentUid;
      item.slotIndex = parent.slotIndex;
      // Capture the player's chosen rotation RELATIVE to the host's
      // current rotation. repositionSurfaceChildren reads this so a
      // toaster the player turned 90° with R stays at 90° even after
      // the counter is later moved or rotated — without this the child
      // got snapped back to the host's facing on every move.
      const host = this.items.find((it) => it.uid === parent.parentUid);
      if (host) {
        item.localRotY = normaliseAngle(rotY - host.rotY);
        // Surface items sit on the host's top; if the caller didn't
        // override, inherit the host's floor so a toaster placed on a
        // Floor 2 counter records floor=2.
        if (floor === 0) item.floor = host.floor;
      }
    }
    this.items.push(item);
    this.mirrorFurniturePlace(item, fromStorage);
    return uid;
  }

  // ======================================================================
  //                Phase F.3 — server-mirror helpers
  // ======================================================================
  // When isServerSim("furniture") is on, every place/move/sell on the
  // local registry also fires the matching reducer so the cloud's
  // placed_furniture table tracks the same layout. All three helpers
  // bail silently when the flag is off OR cloud isn't wired.

  private mirrorFurniturePlace(item: PlacedFurnitureItem, fromStorage = false): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("furniture") || !this.cloud) return;
    const args = {
      uid: item.uid,
      defId: item.defId,
      x: item.x,
      z: item.z,
      rotY: item.rotY,
      floor: item.floor,
      parentUid: item.parentUid ?? "",
      slotIndex: item.slotIndex ?? -1,
      localRotY: item.localRotY ?? 0,
    };
    // Storage re-place routes to place_from_inventory (free + decrements
    // the stored qty) instead of place_furniture.
    if (fromStorage) this.cloud.placeFromInventory(args);
    else this.cloud.placeFurniture(args);
    this.mirrorAggregates(); // H.28
  }

  private mirrorFurnitureMove(item: PlacedFurnitureItem): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("furniture") || !this.cloud) return;
    this.cloud.moveFurniture({
      uid: item.uid,
      x: item.x,
      z: item.z,
      rotY: item.rotY,
      floor: item.floor,
      parentUid: item.parentUid ?? "",
      slotIndex: item.slotIndex ?? -1,
      localRotY: item.localRotY ?? 0,
    });
    // Move doesn't change stats sums, but recompute anyway in case
    // bathroom_score's visibility check (isVisibleInScene) flipped
    // due to a floor-tier reveal. Cheap relative to the move itself.
    this.mirrorAggregates(); // H.28
  }

  private mirrorFurnitureSell(uid: string): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("furniture") || !this.cloud) return;
    this.cloud.sellFurniture(uid);
    this.mirrorAggregates(); // H.28
  }

  /** QoL storage — like mirrorFurnitureSell but banks the item into the
   * storage room (no refund) so it can be re-placed for free later. */
  private mirrorFurnitureStore(uid: string): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("furniture") || !this.cloud) return;
    this.cloud.storeFurniture(uid);
    this.mirrorAggregates(); // H.28
  }

  /** Stored (owned-but-unplaced) furniture for this restaurant — the
   * storage room contents, as {defId, qty}. */
  listStorage(): { defId: string; qty: number }[] {
    return this.cloud?.listFurnitureInventory() ?? [];
  }

  /** Build menu's storage-list refresh callback, fired by the post-connect
   * inventory subscription wired in subscribeToCloudChanges. */
  private storageChangeCb: (() => void) | null = null;

  /** Register the build menu's storage-list refresh. The actual inventory
   * subscription is established post-connect (subscribeToCloudChanges), so
   * this works no matter when the menu was built. */
  onStorageChanged(cb: () => void): void {
    this.storageChangeCb = cb;
  }

  // ---- QoL layout presets (save / load with storage-based reconcile) ----

  /** Serialize the current layout (PersistedPlacement[]) to JSON for a preset. */
  captureLayout(): string {
    return JSON.stringify(this.snapshot());
  }

  /** Programmatically place one item at an absolute pose on any floor,
   * mirroring it like a normal placement (no ghost/click). `fromStorage`
   * routes the mirror to place_from_inventory (free). Returns the new uid
   * (null on unknown def / load failure). Mirrors applyCloudInsert's
   * placement so any-floor mounting + Y are correct. */
  async placeProgrammatic(
    defId: string, x: number, z: number, rotY: number, floor: number,
    parent: { parentUid: string; slotIndex: number } | undefined,
    fromStorage: boolean,
  ): Promise<string | null> {
    const def = getFurnitureDef(defId);
    if (!def) return null;
    try {
      const model = await this.loader.load(def.modelPath);
      fitFurniture(model, def);
      const f = Math.max(0, floor);
      model.position.set(x, placementY(model, def) + this.floorYOffset(f), z);
      model.rotation.y = rotY;
      snapToAdjacentWall(model, def);
      this.mountFor(f).add(model);
      return this.register(defId, x, z, rotY, model, parent, f, fromStorage);
    } catch (err) {
      console.warn(`[FurnitureRegistry] placeProgrammatic failed (${defId}):`, err);
      return null;
    }
  }

  /** QoL layout LOAD — reconcile the floor to a saved layout WITHOUT
   * conjuring free furniture: STORE everything currently placed, then
   * re-place the preset from storage (free) or by buying the shortfall.
   * `tryBuy(defId)` charges for + approves a purchase (false = unaffordable
   * → that item is skipped). Returns counts for a result toast. */
  async applyLayout(
    placements: PersistedPlacement[],
    tryBuy: (defId: string) => boolean,
  ): Promise<{ fromStore: number; bought: number; skipped: number }> {
    // Items placeable WITHOUT buying = existing storage + everything on the
    // floor now (about to be stored). Tracked locally because the SDK
    // inventory cache won't update mid-batch.
    const pool = new Map<string, number>();
    for (const s of this.listStorage()) pool.set(s.defId, (pool.get(s.defId) ?? 0) + s.qty);
    const current = this.snapshot();
    for (const it of current) pool.set(it.defId, (pool.get(it.defId) ?? 0) + 1);
    // 1) Store everything currently placed (banks to inventory, no money).
    //    removeAtByUid cascades surface children + is null-safe on re-hits.
    for (const it of current) this.removeAtByUid(it.uid, true);
    // 2) Place the preset. Hosts (non-parented) first so surface children
    //    can remap their parent uid to the freshly-placed host.
    const sorted = [...placements].sort((a, b) => (a.parentUid ? 1 : 0) - (b.parentUid ? 1 : 0));
    const uidMap = new Map<string, string>();
    let fromStore = 0, bought = 0, skipped = 0;
    for (const p of sorted) {
      if (!getFurnitureDef(p.defId)) { skipped += 1; continue; }
      const have = pool.get(p.defId) ?? 0;
      let useStore = false;
      if (have > 0) { useStore = true; pool.set(p.defId, have - 1); fromStore += 1; }
      else if (tryBuy(p.defId)) { bought += 1; }
      else { skipped += 1; continue; }
      const parent = (p.parentUid && uidMap.has(p.parentUid) && typeof p.slotIndex === "number")
        ? { parentUid: uidMap.get(p.parentUid)!, slotIndex: p.slotIndex }
        : undefined;
      const newUid = await this.placeProgrammatic(p.defId, p.x, p.z, p.rotY, p.floor ?? 0, parent, useStore);
      if (newUid) uidMap.set(p.uid, newUid);
    }
    // 3) Snap any surface children onto their re-placed hosts.
    for (const u of uidMap.values()) this.reseatSurfaceChildren(u);
    return { fromStore, bought, skipped };
  }

  /** Saved layout presets for this restaurant. */
  listLayouts(): { name: string; layoutJson: string }[] {
    return this.cloud?.listLayoutPresets() ?? [];
  }

  /** Save/overwrite a named preset capturing the current layout. */
  saveLayout(name: string): void {
    this.cloud?.saveLayoutPreset(name, this.captureLayout());
  }

  /** Delete a named layout preset. */
  deleteLayout(name: string): void {
    this.cloud?.deleteLayoutPreset(name);
  }

  /** Register the build menu's layout-list refresh, fired by the
   * post-connect subscription wired in subscribeToCloudChanges. */
  onLayoutChanged(cb: () => void): void {
    this.layoutChangeCb = cb;
  }
  private layoutChangeCb: (() => void) | null = null;

  /** H.28 — Recompute aggregate furniture stats and push them to the
   * server's Restaurant row cache. The server uses these to apply
   * vibe + bathroom rating modifiers to backgrounded guests in
   * accumulate_pending_visit_rollup. Fired from each of the three
   * mirror helpers above so the cache stays in sync with every
   * mutation. O(N) over placed items; fine for typical N (~50). */
  private mirrorAggregates(): void {
    if (this.suppressMirrorForReload) return;
    if (!isServerSim("furniture") || !this.cloud) return;
    // Phase 9.7 — mirror the REAL seat list so the server assigns
    // guests to actual chair-at-table slots instead of guessing from
    // def_ids (the guess matched the TABLES: phantom one-seat-per-
    // table capacity, guests rendered on tabletops, and seat uids
    // the client's occupancy map could never match). Only slots with
    // a chair actually parked in them count as sittable. Uid format
    // MUST stay `${tableUid}#${slotIndex}` — the makeSeatId shape
    // GuestSpawner keys occupiedSeats on.
    const slotEntries: string[] = [];
    for (const s of this.getResolvedSeatSlots()) {
      if (!s.chairUid) continue;
      // Phase 9.62 — positions ONLY. The server computes per-seat taste
      // appeal (decor/window/surface) itself from placed_furniture +
      // furniture_meta; the client just resolves WHERE the chairs are
      // (catalog geometry, the one thing that must stay client-side).
      slotEntries.push([
        `${s.tableUid}#${s.slotIndex}`,
        s.x.toFixed(3), s.z.toFixed(3),
        String(s.floor),
        s.facingY.toFixed(4),
        s.platePos.x.toFixed(3), s.platePos.z.toFixed(3),
        s.atBar ? "1" : "0",
      ].join(";"));
    }
    this.cloud.replaceSeatSlots(slotEntries.join("|"));
    const stats = this.getAggregateStats();
    const bath = this.getBathroomScore();
    this.cloud.updateRestaurantAggregates(
      stats.style * 100,
      stats.comfort * 100,
      stats.ratingBonus * 100,
      bath.quality * 100,
      // Phase 6.6 — attractionBonus feeds the server-side offline
      // spawn rate adjustment in try_server_spawn_guest. Pre-multiplied
      // by 100 to match the rest of the reducer's integer units.
      stats.attractionBonus * 100,
    );
  }

  /** Phase 9.7 — public one-shot for Engine's retry loop: push the
   * current aggregates + seat slots even when no placement mutation
   * has fired this session (plain reload). Without this, a freshly
   * deployed server (or one whose seat_slot rows predate a layout
   * change made on another device) would keep assigning from a
   * stale/empty slot list until the player happened to move a chair. */
  mirrorSeatSlotsNow(): void {
    this.mirrorAggregates();
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
      // Preserve any per-child rotation the player set with R during
      // placement. Falls back to 0 (i.e. matches the host) for items
      // placed before localRotY existed or registered without a parent
      // rotation diff.
      child.rotY = host.rotY + (child.localRotY ?? 0);
      child.model.position.set(wx, child.model.position.y, wz);
      child.model.rotation.y = child.rotY;
    }
  }

  /** Bulk-register many existing models (e.g. the demo placements that
   * WorldScene puts in directly). Skips cells already occupied. Demo
   * placements are always on the ground floor — pass `floor` on each
   * item only if a future tier-2+ demo wants to seed an upper floor. */
  registerExisting(items: { defId: string; x: number; z: number; rotY: number; model: THREE.Object3D; floor?: number }[]): void {
    for (const it of items) {
      if (this.isOccupied(it.x, it.z)) continue;
      this.register(it.defId, it.x, it.z, it.rotY, it.model, undefined, it.floor ?? 0);
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
   *              floor item underneath a hanging lamp doesn't block.
   * `floor` filters by storey — only items on the same floor block.
   * Without it, a ground-floor chair at (0,0) would block placement
   * on Floor 1 at the same XZ, even though they're 3 m apart. */
  isOccupied(x: number, z: number, excludeUid?: string, layer: "tile" | "ceiling" = "tile", floor?: number): boolean {
    return this.findIndexNear(x, z, excludeUid, layer, floor) >= 0;
  }

  /** True if any same-layer item's FOOTPRINT covers the integer cell
   * (cellX, cellZ). Differs from {@link isOccupied} in that it honours
   * the placed item's footprint mask — an L-shaped corner sofa's open
   * elbow doesn't count as occupied, so the player can drop a coffee
   * table into the open corner without the simple ±0.6 tolerance check
   * falsely blocking it. This is the right per-cell test when you've
   * already enumerated the would-be placement's footprint cells via
   * {@link footprintCells} and need to verify each one is clear. */
  isCellBlocked(cellX: number, cellZ: number, excludeUid: string | undefined, layer: "tile" | "ceiling", floor?: number): boolean {
    for (const it of this.items) {
      if (excludeUid && it.uid === excludeUid) continue;
      // Multi-storey: an item only blocks placements on the SAME
      // storey. A ground-floor chair doesn't stop you putting a chair
      // directly above it on Floor 1.
      if (typeof floor === "number" && it.floor !== floor) continue;
      const def = getFurnitureDef(it.defId);
      if (!def) continue;
      const placement = def.placement ?? "tile";
      if (placement !== layer) continue;
      // Flat ground decor (rugs, doormats) never blocks anything — by
      // design any tile-layer item can land on top of a rug. The rug's
      // own placement also skips this loop entirely via the BuildMenu
      // gate, so two rugs may overlap too.
      if (def.flat) continue;
      if (footprintCoversCell(it, def, cellX, cellZ)) return true;
    }
    return false;
  }

  /** Find a placed item near the given snapped cell. Uses ±0.6 tolerance
   * so demo placements at fractional coords (chairs around table centers)
   * can still be picked by Move/Sell mode. Most recently-placed wins.
   * Considers ALL placement layers so Sell mode can target walls,
   * ceilings, and floor items by clicking the cell. */
  findAt(x: number, z: number, excludeUid?: string, floor?: number): PlacedFurnitureItem | null {
    const i = this.findIndexNear(x, z, excludeUid, "any", floor);
    return i >= 0 ? this.items[i] : null;
  }

  /** Internal: return the index of the nearest item within ±0.6 of (x, z),
   * or -1. Searches newest-first so player placements beat demo.
   *   - layer="tile": consider only tile-claiming floor items (skip
   *     edge/wall/ceiling).
   *   - layer="ceiling": consider only ceiling items.
   *   - layer="any": include every item (used by Move/Sell pickup). */
  private findIndexNear(x: number, z: number, excludeUid: string | undefined, layer: "tile" | "ceiling" | "any", floor?: number): number {
    const TOL = 0.6;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const it = this.items[i];
      if (excludeUid && it.uid === excludeUid) continue;
      // Multi-storey: when the caller passes a `floor`, only consider
      // items on that storey. Without this, a chair on Floor 0 at
      // (X,Z) would still register as "occupied" when the player is
      // trying to place a chair at the SAME (X,Z) on Floor 1.
      if (typeof floor === "number" && it.floor !== floor) continue;
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
    // Remove from whichever parent the model lives in (main scene for
    // floor 0, a storey group for upper floors). model.removeFromParent
    // is a no-op if it's already detached.
    item.model.removeFromParent();
    this.disposeIfProc(item);
    this.items.splice(idx, 1);
    this.surfaceExtentCache.delete(item.uid);
    this.mirrorFurnitureSell(item.uid);
    const def = getFurnitureDef(item.defId);
    if (!def) return { defId: item.defId, refund: 0 };
    // Sell-back value — see furnitureRefundValue. The identical formula is
    // seeded server-side (furniture_cost.refund_cents) so the money cutover
    // credits the same amount the client shows here.
    const refund = furnitureRefundValue(def);
    return { defId: item.defId, refund };
  }

  /** Move an item to a different storey: re-parent the model to the
   * new floor's mount and shift its Y by the storey-height delta. Used
   * by MOVE mode when the player picks an item up on Floor 0 and drops
   * it on Floor 2 (or vice versa). Cascade-applies to any surface
   * children so a counter taken upstairs takes its toaster along.
   * Returns true if anything changed. */
  setItemFloor(uid: string, newFloor: number): boolean {
    const item = this.items.find((it) => it.uid === uid);
    if (!item) return false;
    const oldFloor = item.floor;
    if (oldFloor === newFloor) return false;
    const dy = this.floorYOffset(newFloor) - this.floorYOffset(oldFloor);
    item.floor = newFloor;
    item.model.position.y += dy;
    const newParent = this.mountFor(newFloor);
    if (item.model.parent !== newParent) newParent.add(item.model);
    this.mirrorFurnitureMove(item);
    // Cascade to surface children — keep them riding along.
    for (const child of this.items) {
      if (child.parentUid !== uid) continue;
      child.floor = newFloor;
      child.model.position.y += dy;
      if (child.model.parent !== newParent) newParent.add(child.model);
      this.mirrorFurnitureMove(child);
    }
    return true;
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
    // Surface items: re-derive localRotY (the rotation offset relative
    // to the host) from the new rotation. Without this, R-rotating a
    // microwave in MOVE mode updates the in-scene rotation but the
    // persisted localRotY stays at its old value — save+load then
    // applies host.rotY + OLD_localRotY and the rotation reverts.
    if (item.parentUid) {
      const host = this.items.find((it) => it.uid === item.parentUid);
      if (host) item.localRotY = normaliseAngle(rotY - host.rotY);
    }
    // If this item is a host (has children with parentUid === uid),
    // ride its surface-placed items along to the new pose.
    this.reseatSurfaceChildren(uid);
    this.mirrorFurnitureMove(item);
    return true;
  }

  /** Remove a specific placed item by uid. Returns the def + refund value
   * (mirrors removeAt) or null. Used by undo of a `place`. If the removed
   * item is a host of any surface items, those are removed too and their
   * refunds folded into the returned value — the caller (BuildMenu sell)
   * pays out the whole stack in one go. */
  removeAtByUid(uid: string, store = false): { defId: string; refund: number } | null {
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
      // Use removeFromParent so the call works whether the model lives
      // in the main scene (floor 0) or a storey group (upper floor).
      // The legacy scene.remove only detaches direct children of the
      // main scene and was silently no-op'ing for upper-floor items
      // — sell appeared to work (refund paid) but the mesh stayed.
      child.model.removeFromParent();
      this.disposeIfProc(child);
      this.items.splice(cIdx, 1);
      // 100% refund for undo-of-place (vs the 50% sell refund) — the
      // player gets back exactly what they paid, which is the scaled
      // tier price, not the raw base cost.
      const cDef = getFurnitureDef(child.defId);
      totalChildRefund += cDef ? scaledCost(cDef) : 0;
    }
    // Re-find the host's index since the splices above shifted entries.
    const finalIdx = this.items.findIndex((it) => it.uid === uid);
    if (finalIdx >= 0) {
      this.disposeIfProc(this.items[finalIdx]);
      this.items[finalIdx].model.removeFromParent();
      this.items.splice(finalIdx, 1);
    }
    // Drop the cached surface extent for both the host and any
    // cascaded surface children so the map doesn't grow unbounded.
    this.surfaceExtentCache.delete(uid);
    for (const child of children) this.surfaceExtentCache.delete(child.uid);
    // Mirror the cascade-sell — every child uid first (so the order
    // matches the local splice order), then the host. cancel/idempotent
    // semantics server-side handle re-runs safely.
    for (const child of children) {
      if (store) this.mirrorFurnitureStore(child.uid); else this.mirrorFurnitureSell(child.uid);
    }
    if (store) this.mirrorFurnitureStore(uid); else this.mirrorFurnitureSell(uid);
    const def = getFurnitureDef(item.defId);
    return { defId: item.defId, refund: (def ? scaledCost(def) : 0) + totalChildRefund };
  }

  /** Free GPU buffers for a removed item's model — but ONLY for
   * procedurally-built (`proc:`) models. GLB-backed models share their
   * geometry + materials with ModelLoader's per-path cache (every clone
   * reuses the cached source's buffers), so disposing those would corrupt
   * every other live instance of the same model. `proc:` models are built
   * fresh per placement (ModelLoader does NOT cache them), so once the model
   * is detached nothing else references its buffers — skipping dispose
   * leaked them on every place-then-sell of decor/walls/appliances. Undo of
   * a sell/place reloads a fresh model (see BuildMenu), so this is safe. */
  private disposeIfProc(item: PlacedFurnitureItem): void {
    const def = getFurnitureDef(item.defId);
    if (!def || !def.modelPath.startsWith("proc:")) return;
    item.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
  }

  /** Read-only snapshot of every placed item (used by BuildMenu auto-arrange
   * to diff before/after). Models are included by reference so callers
   * must not mutate them. */
  /** Update the cached luxury tier. Engine wires this to
   * Game.onLuxuryTierChanged so getResolvedSeatSlots(true) immediately
   * starts including / excluding seats on the (un)locked storey. */
  setLuxuryTier(tier: number): void {
    this.currentLuxuryTier = Math.max(1, Math.min(5, Math.floor(tier)));
  }

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
    this.mirrorFurnitureMove(item);
    return true;
  }

  /** Count placed items by category on a given floor. Phase 8's seat
   * selection uses this to break ties between candidate floors —
   * "more decor / windows wins". Returns a tiny stat record per call
   * so the GuestSpawner can score floors without re-iterating items
   * itself.
   *
   * `decor`  = anything with `category: "decoration"`
   * `window` = the perimeter-window items (id starts with "window") +
   *            the interior-window placements (id starts with
   *            "int-window"). Mirrors the id-prefix recognition the
   *            wall builder uses.
   */
  countFloorFeatures(floor: number): { decor: number; window: number } {
    let decor = 0;
    let window = 0;
    for (const it of this.items) {
      if (it.floor !== floor) continue;
      const def = getFurnitureDef(it.defId);
      if (!def) continue;
      if (def.category === "decoration") decor += 1;
      if (it.defId.startsWith("window") || it.defId.startsWith("int-window")) window += 1;
    }
    return { decor, window };
  }

  /** Snapshot for save. Strips the model ref. parentUid / slotIndex
   * are persisted so surface items re-snap to their hosts on load.
   * floor is only emitted when non-zero — keeps ground-floor saves
   * byte-compatible with the pre-multi-storey format. */
  snapshot(): PersistedPlacement[] {
    return this.items.map((it) => {
      const p: PersistedPlacement = { uid: it.uid, defId: it.defId, x: it.x, z: it.z, rotY: it.rotY };
      if (it.parentUid) p.parentUid = it.parentUid;
      if (typeof it.slotIndex === "number") p.slotIndex = it.slotIndex;
      // Persist the user-chosen surface rotation offset so a save+load
      // round-trip doesn't reset a rotated toaster back to the
      // counter's facing.
      if (typeof it.localRotY === "number") p.localRotY = it.localRotY;
      if (it.floor > 0) p.floor = it.floor;
      return p;
    });
  }

  /** Wired by Engine → Game.getActiveThemeAppeal(). Active interior themes
   * contribute their tiered appeal to the aggregate, exactly like decoration
   * furniture. Kept as a provider so the registry stays furniture-only and the
   * theme state lives in Game. */
  themeAppealProvider?: () => { attractionBonus: number; ratingBonus: number };

  /** Aggregated stat bonuses across all placed furniture PLUS active interior
   * themes. Used by the Game to adjust guest spawn rate, satisfaction, and
   * rating (and mirrored to the server as the pre-seed fallback). */
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
    const theme = this.themeAppealProvider?.();
    if (theme) {
      attractionBonus += theme.attractionBonus;
      ratingBonus += theme.ratingBonus;
    }
    return { style, comfort, attractionBonus, ratingBonus };
  }

  // === Seat-slot integration ===

  /** Return every placed table, resolved with its seat slots in world space
   * and whether each slot is filled by a correctly-oriented chair. Pass
   * `onlyVisible: true` to skip slots whose floor is NOT YET UNLOCKED by
   * the player's luxury tier (a defensive filter — players can't normally
   * place furniture on a locked floor, but if a tier regression ever
   * happens we don't want guests trying to walk to seats that no longer
   * exist gameplay-wise). Pass `excludeUid` to ignore a specific chair
   * when computing occupancy (used during move so a moving chair doesn't
   * appear to occupy its own old slot).
   *
   * NOTE: this used to check the table's mesh visibility (.visible chain).
   * That conflated tier-locked storeys (truly unavailable) with
   * focus-hidden storeys (currently camera-hidden but still functional)
   * — switching the FloorSelector to ground floor was making every
   * upper-floor seat read as "doesn't exist" and the guest system
   * stopped routing customers to those seats. Tier check fixes it. */
  getResolvedSeatSlots(onlyVisible = false, excludeUid?: string): ResolvedSeatSlot[] {
    const out: ResolvedSeatSlot[] = [];
    for (const it of this.items) {
      if (onlyVisible && (it.floor ?? 0) + 1 > this.currentLuxuryTier) continue;
      const def = getFurnitureDef(it.defId);
      if (!def?.seatSlots) continue;
      for (let i = 0; i < def.seatSlots.length; i += 1) {
        const slot = def.seatSlots[i];
        const world = this.rotateSlotOffset(slot, it);
        const sx = it.x + world.dx;
        const sz = it.z + world.dz;
        // Reject only seats that fall essentially OUTSIDE the interior box (a
        // slot past a wall reads as "sitting on nothing"). Margin loosened
        // 0.35 → 0.15: players legitimately place tables flush against a wall
        // and expect the wall-side chairs to work — a guest's back overlapping
        // the wall a little is fine; sitting fully through it is not. Bounds =
        // StaffRouter's interior box [-4.2, 5.2] minus 0.15. Filtering here —
        // the single seat source — keeps invalid slots out of the server mirror.
        if (sx < -4.05 || sx > 5.05 || sz < -4.05 || sz > 5.05) continue;
        // Also reject seats sitting in the ground-floor ENTRANCE doorway.
        // Guests walk in/out through the south-wall opening at (x≈0, z≈5.45);
        // the wall-clearance loosening above re-allowed a table's wall-side
        // slot to land right in that gap, so the guest renders "sitting on
        // nothing" in the doorway. Exclude a ~0.9 m bubble around the door,
        // FLOOR 0 ONLY — upper storeys have no entrance (just stairs), so
        // their south-wall seats stay valid.
        if (it.floor === 0) {
          const ddx = sx - 0.0;
          const ddz = sz - 5.45;
          if (ddx * ddx + ddz * ddz < 0.9 * 0.9) continue;
        }
        out.push({
          tableUid: it.uid,
          slotIndex: i,
          x: sx,
          z: sz,
          facingY: this.normalizeAngle(slot.facingY + it.rotY),
          platePos: { x: it.x + world.platePos.dx, z: it.z + world.platePos.dz },
          chairUid: this.findChairAtSlot(sx, sz, this.normalizeAngle(slot.facingY + it.rotY), excludeUid, it.floor),
          floor: it.floor,
          surface: def.surface ?? "food",
          atBar: def.category === "bar",
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
   * nothing in range. Used by BuildMenu's chair auto-snap behaviour.
   * Optional `floor` filter restricts the search to one storey so a chair
   * being placed on Floor 1 doesn't snap to a Floor 0 coffee table's seat
   * (and vice versa) — without it, the (x, z) match happens regardless
   * of Y and the chair lands at the right XZ for the wrong storey. */
  findNearestSeatSlot(x: number, z: number, range = 1.4, excludeChairUid?: string, floor?: number): ResolvedSeatSlot | null {
    let best: ResolvedSeatSlot | null = null;
    let bestD2 = range * range;
    for (const s of this.getResolvedSeatSlots(false, excludeChairUid)) {
      if (typeof floor === "number" && s.floor !== floor) continue;
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
   * isChairAtAnySlot.
   *
   * `tableFloor` scopes the lookup to chairs on the same storey as the
   * table whose slot is being resolved — otherwise a Floor 0 chair
   * sitting directly under a Floor 1 table's seat would mark that
   * Floor 1 seat as filled, and a customer assigned to it would
   * silently never get a chair to sit on. */
  private findChairAtSlot(slotX: number, slotZ: number, _slotFacing: number, excludeUid?: string, tableFloor?: number): string | null {
    const cellX = Math.round(slotX);
    const cellZ = Math.round(slotZ);
    for (const it of this.items) {
      if (excludeUid && it.uid === excludeUid) continue;
      if (typeof tableFloor === "number" && it.floor !== tableFloor) continue;
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "chair") continue;
      if (footprintCoversCell(it, def, cellX, cellZ)) return it.uid;
    }
    return null;
  }

  /** Which kind of orders a placed serving surface accepts. Returns
   * null for items that aren't a serving surface or unknown uids. Used
   * by GuestSpawner.buildOrder to restrict drink-only coffee tables
   * (and bar counters) to the drink menu.
   *
   * "Serving surface" = any def with seatSlots. The bar counter is a
   * "counter" category but it ALSO seats customers, so we can't gate
   * on category === "table" anymore. seatSlots is the right invariant
   * — if customers can sit at it, the def declares what gets served. */
  getTableSurface(tableUid: string): "food" | "drink" | null {
    const it = this.items.find((x) => x.uid === tableUid);
    if (!it) return null;
    const def = getFurnitureDef(it.defId);
    if (!def?.seatSlots) return null;
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
  getToilets(): { uid: string; x: number; z: number; rotY: number; standPos: THREE.Vector2; floor: number }[] {
    const out: { uid: string; x: number; z: number; rotY: number; standPos: THREE.Vector2; floor: number }[] = [];
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
      out.push({ uid: it.uid, x: it.x, z: it.z, rotY: it.rotY, standPos, floor: it.floor });
    }
    return out;
  }

  /** Every visible placed bathroom sink (id starting with
   * "bathroom-sink"). GuestSpawner routes WC visitors to a free sink
   * after the toilet step so the wash-hands quality also feeds back
   * into the rating. Same +Z-stand-spot convention as toilets. */
  getBathroomSinks(): { uid: string; x: number; z: number; rotY: number; standPos: THREE.Vector2; floor: number }[] {
    const out: { uid: string; x: number; z: number; rotY: number; standPos: THREE.Vector2; floor: number }[] = [];
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (def?.category !== "bathroom") continue;
      if (!def.id.startsWith("bathroom-sink")) continue;
      if (!this.isVisibleInScene(it.model)) continue;
      const standPos = new THREE.Vector2(
        it.x + Math.sin(it.rotY),
        it.z + Math.cos(it.rotY),
      );
      out.push({ uid: it.uid, x: it.x, z: it.z, rotY: it.rotY, standPos, floor: it.floor });
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
  getWashStations(): { uid: string; defId: string; x: number; z: number; rotY: number; standPos: THREE.Vector2; dwell: number; floor: number }[] {
    const out: { uid: string; defId: string; x: number; z: number; rotY: number; standPos: THREE.Vector2; dwell: number; floor: number }[] = [];
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
      out.push({ uid: it.uid, defId: it.defId, x: it.x, z: it.z, rotY: it.rotY, standPos, dwell, floor: it.floor });
    }
    return out;
  }

  getStoves(): { uid: string; x: number; z: number; rotY: number; floor: number }[] {
    const out: { uid: string; x: number; z: number; rotY: number; floor: number }[] = [];
    for (const it of this.items) {
      if (it.defId !== "stove" && it.defId !== "stove-electric") continue;
      if (!this.isVisibleInScene(it.model)) continue;
      out.push({ uid: it.uid, x: it.x, z: it.z, rotY: it.rotY, floor: it.floor });
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
  /** Yield every placed furniture's root model for callers that
   * need to walk descendants (e.g. the graphics-quality toggle
   * that flips castShadow on every placed mesh). Kept as a
   * function rather than exposing the items array so callers
   * can't accidentally mutate the registry's state. */
  forEachPlacedModel(cb: (model: THREE.Object3D) => void): void {
    for (const it of this.items) cb(it.model);
  }

  getCookStations(): { uid: string; defId: string; model: THREE.Object3D; provides: string; x: number; z: number; rotY: number; floor: number }[] {
    const out: { uid: string; defId: string; model: THREE.Object3D; provides: string; x: number; z: number; rotY: number; floor: number }[] = [];
    for (const it of this.items) {
      const def = getFurnitureDef(it.defId);
      if (!def?.provides) continue;
      if (!this.isVisibleInScene(it.model)) continue;
      out.push({ uid: it.uid, defId: it.defId, model: it.model, provides: def.provides, x: it.x, z: it.z, rotY: it.rotY, floor: it.floor });
    }
    return out;
  }

  /** Re-instantiate placements from the cloud's placed_furniture
   * table. Used by Engine on a second-device login when
   * isServerSim("furniture") is on — the cloud rows take precedence
   * over whatever the JSON save_snapshot loaded. Wipes the local
   * items array first (so we don't end up with duplicates) and then
   * delegates to the existing restore() path. Idempotent — safe to
   * call multiple times.
   *
   * NOTE: this is the INITIAL load only. Live diff from other
   * clients (someone else's place / move / sell coming in via the
   * subscription) is a separate future pass — for now we trust that
   * a single client is editing at any one moment, and a refresh
   * picks up changes that happened while the player was away. */
  async restoreFromCloud(): Promise<void> {
    if (!this.cloud) return;
    const rows = this.cloud.listPlacedFurniture();
    // Phase I (H.75) — Empty cloud + populated local = ONE-TIME
    // BACKFILL.  H.66 made cloud authoritative when it had rows,
    // but completely missed the case where the cloud was simply
    // never populated (legacy save predates the placed_furniture
    // mirror, OR a publish nuked the table).  For those users
    // every restoreFromCloud was a no-op and the server saw zero
    // furniture forever — meaning auto_claim_queued_tickets could
    // never find a stove, guests timed out, etc.
    //
    // When cloud is empty and local has items, push the local set
    // up to cloud one piece at a time.  mirrorFurniturePlace is
    // already idempotent server-side (placeFurniture upserts by
    // uid).  Aggregates get pushed once at the end so the
    // attraction-layer free_seats counter is correct.
    if (rows.length === 0) {
      if (this.items.length === 0) return;
      console.log(`[H.75] cloud has 0 furniture rows but local has ${this.items.length} — backfilling cloud.`);
      let pushed = 0;
      for (const it of this.items) {
        this.mirrorFurniturePlace(it);
        pushed += 1;
      }
      console.log(`[H.75] backfill complete — pushed ${pushed} furniture rows to cloud.`);
      return;
    }
    // Phase I (H.66) — CLOUD IS AUTHORITATIVE.  The legacy guard
    // here used to bail out if local had any items, preserving the
    // localStorage save's positions over the cloud's.  That was the
    // root cause of the "move a table, refresh, position reverts"
    // bug: the user's last move went to cloud, but local save (last
    // autosaved before the move) still had the old position.  On
    // reload, restoreFromCloud saw items.length > 0 and refused to
    // apply cloud, then mirrorFurniturePlace pushed the STALE local
    // positions BACK UP to cloud, permanently replacing the move.
    //
    // With server-authoritative state, cloud rows always win when
    // they exist.  The local save is treated as a write-only offline
    // cache (still produced by saveNowSync on beforeunload as a
    // belt-and-suspenders if the cloud connection is unreachable on
    // next reload), but on connect we ALWAYS prefer cloud.
    //
    // Engine.ts now sequences `restoreFromCloud()` after the local
    // `registry.restore(save)` promise (see the comment in
    // setupRunningGame).  So by the time we reach this method, the
    // save's items have already been instantiated; we wipe them and
    // re-instantiate from cloud.  Slightly wasteful in load time
    // (double GLB loads in the common case), but eliminates the
    // race entirely and the user's `move-then-refresh` flow now
    // shows the moved position every time.
    console.log(`[FurnitureRegistry] restoreFromCloud: cloud has ${rows.length} rows — applying as authoritative (replacing any local-save items).`);
    // Wipe local state. Detach models from the scene; the new restore
    // call will reload each item from scratch with a fresh model
    // instance (cheaper than diffing what we'd keep).
    for (const it of this.items) it.model.removeFromParent();
    this.items.length = 0;
    this.surfaceExtentCache.clear();
    // Map cloud rows to the PersistedPlacement shape restore() wants.
    // restoreFromCloud is also called by Engine ONLY when the flag is
    // on, so the mirror inside restore()'s downstream paths fires
    // back — guarded against by suspending mirror callbacks during
    // the reload (set a flag so register() skips mirrorFurniturePlace).
    const placements: PersistedPlacement[] = rows.map((r) => {
      const p: PersistedPlacement = {
        uid: r.uid, defId: r.defId, x: r.x, z: r.z, rotY: r.rotY,
      };
      if (r.parentUid) p.parentUid = r.parentUid;
      if (r.slotIndex >= 0) p.slotIndex = r.slotIndex;
      if (r.localRotY !== 0) p.localRotY = r.localRotY;
      if (r.floor > 0) p.floor = r.floor;
      return p;
    });
    this.suppressMirrorForReload = true;
    try {
      await this.restore(placements);
    } finally {
      this.suppressMirrorForReload = false;
    }
    console.log(`[FurnitureRegistry] restoreFromCloud → ${placements.length} items`);
  }

  /** Latch set during restoreFromCloud so the per-mutation mirror
   * doesn't re-publish the rows we're loading IN FROM the cloud (which
   * would be a no-op upsert but burns reducer calls + risks the
   * default-clobber problem). */
  private suppressMirrorForReload = false;

  // Phase I (H.66) — `expectedItemCount` removed.  It was the
  // stale-cloud guard's race-detector; the guard is gone now that
  // cloud is always authoritative.  See restoreFromCloud's comment.

  /** Subscribe to live placed_furniture changes from the cloud. Engine
   * calls this once after restoreFromCloud completes. From then on,
   * any other client's place/move/sell shows up in this restaurant
   * within a fraction of a second — no refresh needed.
   *
   * Bails when the flag is off or the cloud isn't wired. Subscriptions
   * persist for the session (no unsubscribe yet — would only matter
   * if we let the flag toggle mid-session, which we don't). */
  subscribeToCloudChanges(): void {
    if (!isServerSim("furniture") || !this.cloud) return;
    this.cloud.subscribePlacedFurnitureChanges({
      onInsert: (row) => { void this.applyCloudInsert(row); },
      onUpdate: (row) => { this.applyCloudUpdate(row); },
      onDelete: (uid) => { this.applyCloudDelete(uid); },
    });
    // QoL storage — drive the build menu's storage-list refresh from the
    // same post-connect point so it's reliably live (the menu may have
    // been built before the cloud finished connecting).
    this.cloud.subscribeFurnitureInventoryChanges(() => this.storageChangeCb?.());
    this.cloud.subscribeLayoutPresetChanges(() => this.layoutChangeCb?.());
  }

  /** Insert event from the subscription. Skips when the uid is
   * already in this.items (i.e., we just created it locally — the
   * mirror loop bounces the row back through our own subscription).
   * Otherwise async-loads the GLB and spawns. */
  private async applyCloudInsert(row: import("../cloud/SpacetimeClient").PlacedFurnitureRow): Promise<void> {
    if (this.items.some((it) => it.uid === row.uid)) return;
    const def = getFurnitureDef(row.defId);
    if (!def) return;
    try {
      const model = await this.loader.load(def.modelPath);
      fitFurniture(model, def);
      const floor = Math.max(0, row.floor);
      model.position.set(row.x, placementY(model, def) + this.floorYOffset(floor), row.z);
      model.rotation.y = row.rotY;
      snapToAdjacentWall(model, def);
      this.mountFor(floor).add(model);
      const item: PlacedFurnitureItem = {
        uid: row.uid, defId: row.defId,
        x: row.x, z: row.z, rotY: row.rotY,
        floor, model,
      };
      if (row.parentUid) item.parentUid = row.parentUid;
      if (row.slotIndex >= 0) item.slotIndex = row.slotIndex;
      if (row.localRotY !== 0) item.localRotY = row.localRotY;
      this.items.push(item);
      // The cascade-reseat for any surface child that landed BEFORE
      // its host runs in restoreFromCloud's second pass; live inserts
      // come one at a time so we just reseat this item's children if
      // it happens to be a host.
      this.reseatSurfaceChildren(row.uid);
      console.log(`[FurnitureRegistry] cloud insert → ${row.defId} @ (${row.x}, ${row.z}, F${floor})`);
    } catch (err) {
      console.warn(`[FurnitureRegistry] failed to apply cloud insert (${row.defId}):`, err);
    }
  }

  /** Update event. Diff against our current row; only apply when the
   * pose actually changed (server upserts can be no-ops). */
  private applyCloudUpdate(row: import("../cloud/SpacetimeClient").PlacedFurnitureRow): void {
    const item = this.items.find((it) => it.uid === row.uid);
    if (!item) {
      // Edge case: an update arrives before its matching insert (race
      // when the subscription cache replays history). Treat as an
      // insert so we don't drop the row entirely.
      void this.applyCloudInsert(row);
      return;
    }
    const samePose = item.x === row.x && item.z === row.z
        && item.rotY === row.rotY && item.floor === row.floor;
    if (samePose) return;
    // Use the existing setPose path — handles the cascade reseat for
    // surface children + the localRotY recompute. The mirror inside
    // setPose fires another moveFurniture reducer back to the server;
    // that's a no-op upsert (the row already has these values), so
    // we suppress it during apply to avoid the round-trip.
    this.suppressMirrorForReload = true;
    try {
      this.setPose(row.uid, row.x, row.z, row.rotY);
      // setPose doesn't change floor — handle that case separately.
      if (item.floor !== row.floor) {
        this.setItemFloor(row.uid, row.floor);
      }
    } finally {
      this.suppressMirrorForReload = false;
    }
    console.log(`[FurnitureRegistry] cloud update → ${row.uid} now (${row.x}, ${row.z}, F${row.floor})`);
  }

  /** Delete event. Skip when the uid isn't here (we already removed
   * it locally) — same idempotency guard as insert. */
  private applyCloudDelete(uid: string): void {
    const idx = this.items.findIndex((it) => it.uid === uid);
    if (idx < 0) return;
    const item = this.items[idx];
    item.model.removeFromParent();
    this.items.splice(idx, 1);
    this.surfaceExtentCache.delete(uid);
    console.log(`[FurnitureRegistry] cloud delete → ${uid}`);
  }

  /** Re-instantiate placements from a save. Resolves once every model
   * is loaded (or skipped if unknown id / load error). Surface-placed
   * items override their Y from the host's measured top after the host
   * loads, since placementY's "floor" default would otherwise drop them
   * to y=0. */
  async restore(saved: PersistedPlacement[]): Promise<void> {
    // Phase I (H.66) — expectedItemCount removed; cloud is the
    // source of truth and restoreFromCloud unconditionally replaces
    // whatever this method loaded.
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
        // exists. Y is also lifted by floor*storeyHeight so an item
        // saved on Floor 2 lands on Floor 2's slab instead of the
        // ground.
        const floor = Math.max(0, p.floor ?? 0);
        model.position.set(p.x, placementY(model, def) + this.floorYOffset(floor), p.z);
        model.rotation.y = p.rotY;
        // Same wall-hug pass the BuildMenu place handler runs, so a
        // save round-trip keeps the kitchen line flush against the
        // wall instead of drifting back into "uneven gap" territory.
        snapToAdjacentWall(model, def);
        this.mountFor(floor).add(model);
        const item: PlacedFurnitureItem = { uid: p.uid, defId: p.defId, x: p.x, z: p.z, rotY: p.rotY, floor, model };
        if (p.parentUid) item.parentUid = p.parentUid;
        if (typeof p.slotIndex === "number") item.slotIndex = p.slotIndex;
        if (typeof p.localRotY === "number") item.localRotY = p.localRotY;
        this.items.push(item);
      } catch (err) {
        console.warn(`Failed to restore placed furniture ${def.id}`, err);
      }
    }));
    // Second pass: surface items get their Y from the host's measured
    // top and a fresh pose computed from the host's current (x, z, rotY).
    // This survives the host having been moved / rotated between save
    // and load — the slot offset is in the host's local frame.
    //
    // LEGACY SAVE RESCUE: saves written before the parentUid/slotIndex
    // fields were persisted lose the host link on reload. Surface
    // items in those saves come back here with no parentUid and we
    // used to leave them at y=0 — the visible "appliances falling
    // through the counters every patch" bug. Below, for any surface-
    // placed item still missing a parentUid, we scan placed hosts
    // looking for a surfaceSlot whose world-space (x,z) matches the
    // surface item's stored position; the first match becomes the
    // inferred parent.
    for (const child of this.items) {
      const childDef = getFurnitureDef(child.defId);
      if (childDef?.placement !== "surface") continue;
      // Patch up missing host link from a legacy save.
      if (!child.parentUid || typeof child.slotIndex !== "number") {
        for (const candidate of this.items) {
          if (candidate.uid === child.uid) continue;
          const cDef = getFurnitureDef(candidate.defId);
          const slots = cDef?.surfaceSlots;
          if (!slots || slots.length === 0) continue;
          const ccos = Math.cos(candidate.rotY), csin = Math.sin(candidate.rotY);
          let matched = false;
          for (let i = 0; i < slots.length; i += 1) {
            const slot = slots[i];
            const wx = candidate.x + slot.dx * ccos + slot.dz * csin;
            const wz = candidate.z - slot.dx * csin + slot.dz * ccos;
            if (Math.abs(wx - child.x) < 0.25 && Math.abs(wz - child.z) < 0.25) {
              child.parentUid = candidate.uid;
              child.slotIndex = i;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
      }
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
      child.model.position.set(wx, topY, wz);
      // Honour the player's per-child rotation offset (localRotY) so a
      // microwave turned 90° via R survives a save+load round-trip.
      // Two paths:
      //   - NEW save (localRotY persisted): use host.rotY + localRotY,
      //     which equals the absolute rotation the user saw at save
      //     time and matches the first-pass model.rotation.y.
      //   - LEGACY save (localRotY missing): infer the offset from
      //     child.rotY - host.rotY so even old saves without the
      //     field hang on to their rotation instead of snapping back
      //     to host.rotY. This also self-heals the in-memory item —
      //     future saves write a proper localRotY.
      if (typeof child.localRotY !== "number") {
        child.localRotY = normaliseAngle(child.rotY - host.rotY);
      }
      const finalRotY = host.rotY + child.localRotY;
      child.rotY = finalRotY;
      child.model.rotation.y = finalRotY;
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
