import * as THREE from "three";
import type { FurnitureRegistry } from "../game/FurnitureRegistry";

/**
 * Faint visual markers showing every placed table's seat slots and plate
 * positions. Two kinds of markers:
 *
 *  - Floor disc at each seat-slot position. YELLOW when no chair is there
 *    yet (a hint: "put a chair here"), GREEN when a correctly-oriented
 *    chair is placed.
 *  - Table-top disc at each plate position — where customers' food lands.
 *
 * Engine calls refresh() every HUD tick. The class rebuilds its meshes
 * from FurnitureRegistry.getResolvedSeatSlots(), so any registry mutation
 * automatically reflects on the next refresh.
 */
const FLOOR_Y = 0.02;          // hair above the floor so it doesn't z-fight
const PLATE_Y = 0.66;          // sits on the table top (matches plate height)
const SEAT_RADIUS = 0.34;
const PLATE_RADIUS = 0.20;

export class SeatMarkers {
  private readonly scene: THREE.Scene;
  private readonly registry: FurnitureRegistry;
  /** Container we add/remove markers from, so we don't pollute scene root. */
  private readonly group: THREE.Group;
  private readonly seatGeometry: THREE.CircleGeometry;
  private readonly plateGeometry: THREE.CircleGeometry;
  private readonly seatEmptyMat: THREE.MeshBasicMaterial;
  private readonly seatFilledMat: THREE.MeshBasicMaterial;
  private readonly plateMat: THREE.MeshBasicMaterial;
  /** Storey the player is currently focused on. Wired from Engine — the
   * markers only render for tables on this storey. Without the filter,
   * every floor's seat hints show on the ground slab as the camera tweens
   * up and they read as "the upper floor's tables exist down here". */
  getFocusedFloor?: () => number;
  /** Metres per storey, used to lift the markers up to the focused
   * floor's slab plane. Falls back to the WorldScene constant if the
   * caller doesn't wire one. */
  getStoreyHeight?: () => number;
  /** Off by default — BuildMenu calls setEnabled(true) when entering
   * place/move mode and false again when leaving. */
  private enabled = false;

  constructor(scene: THREE.Scene, registry: FurnitureRegistry) {
    this.scene = scene;
    this.registry = registry;
    this.group = new THREE.Group();
    this.group.name = "seat-markers";
    this.scene.add(this.group);

    this.seatGeometry = new THREE.CircleGeometry(SEAT_RADIUS, 24);
    this.plateGeometry = new THREE.CircleGeometry(PLATE_RADIUS, 20);

    // Yellow tint for empty seats (a hint to the builder), green for
    // correctly-occupied slots, soft cream for plate positions. Transparent
    // so they read as "decals" rather than solid objects.
    this.seatEmptyMat = new THREE.MeshBasicMaterial({
      color: 0xffd47a, transparent: true, opacity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.seatFilledMat = new THREE.MeshBasicMaterial({
      color: 0x70e070, transparent: true, opacity: 0.40,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.plateMat = new THREE.MeshBasicMaterial({
      color: 0xfff5dc, transparent: true, opacity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
    });
  }

  /** Show/hide the markers entirely. Markers are only meant to appear
   * while the player is actively building or moving — they're a
   * placement aid, not permanent decor. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (!on) {
      // Drop the meshes so they don't sit around in the scene graph
      // (refresh re-creates them on the next enable).
      while (this.group.children.length > 0) {
        this.group.remove(this.group.children[0]);
      }
    }
  }

  isEnabled(): boolean { return this.enabled; }

  /** Rebuild every marker from the current registry state. Cheap enough
   * to call at 5 Hz — ~20 markers max at v1 catalog scale. */
  refresh(): void {
    if (!this.enabled) return;
    // Wipe old markers. Geometries + materials are shared across refreshes.
    while (this.group.children.length > 0) {
      const c = this.group.children[0];
      this.group.remove(c);
    }
    const focused = this.getFocusedFloor?.() ?? 0;
    const storeyH = this.getStoreyHeight?.() ?? 3;
    const slabY = focused * storeyH;
    const slots = this.registry.getResolvedSeatSlots();
    for (const slot of slots) {
      // Filter to the focused storey — Floor 1 markers should not appear
      // on the ground slab and vice versa. ResolvedSeatSlot.floor carries
      // the table's storey through from FurnitureRegistry.
      if (slot.floor !== focused) continue;
      const filled = slot.chairUid != null;
      // Floor disc — flat on ground, rotated to lie on the XZ plane.
      // Lifted by slabY so the disc sits ON the focused storey's slab
      // rather than the ground floor at y≈0.
      const seatMesh = new THREE.Mesh(this.seatGeometry, filled ? this.seatFilledMat : this.seatEmptyMat);
      seatMesh.rotation.x = -Math.PI / 2;
      seatMesh.position.set(slot.x, slabY + FLOOR_Y, slot.z);
      this.group.add(seatMesh);
      // Plate disc on the table top — same orientation, lifted Y.
      const plateMesh = new THREE.Mesh(this.plateGeometry, this.plateMat);
      plateMesh.rotation.x = -Math.PI / 2;
      plateMesh.position.set(slot.platePos.x, slabY + PLATE_Y, slot.platePos.z);
      this.group.add(plateMesh);
    }
  }

  /** Tear down completely (called on Engine.stop). */
  dispose(): void {
    this.scene.remove(this.group);
    this.seatGeometry.dispose();
    this.plateGeometry.dispose();
    this.seatEmptyMat.dispose();
    this.seatFilledMat.dispose();
    this.plateMat.dispose();
  }
}
