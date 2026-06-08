import * as THREE from "three";

/**
 * Phase H.A — Cloud-derived plate-on-table visualizer.
 *
 * Listens to active_guest cloud rows. Whenever a guest's state is
 * "eating", renders a plate at (plateX, tableTop, plateZ) on the
 * guest's seat floor. Removes the plate as soon as the state moves
 * on (course done → next state, or guest leaves).
 *
 * Replaces (in visit mode) the host's local-sim `showPlateForGuest`
 * + `removePlateForGuest` pair in GuestSpawner. H.D will plug this
 * into the host's view too so both viewers see the same plate.
 *
 * Position fidelity: plateX/Z come from the server's active_guest
 * row (added in H.A). Y is a constant TABLE_TOP_Y per storey — the
 * host's getTableTopForGuest queries the registry for the seat's
 * specific table-top height, but for visit-mode purposes a constant
 * is close enough (tables in the game are all ~0.74 m tall).
 *
 * Food blob color: kept generic (single warm color) — distinguishing
 * by recipe requires the order_recipes CSV which isn't in the slim
 * ActiveGuestRow yet. Can be added later if needed.
 */

const TABLE_TOP_Y = 0.74;
const STOREY_HEIGHT = 3;

/** Shared geometry so all plates reuse the same allocation across
 * every visualizer instance. */
let plateGeo: THREE.CylinderGeometry | null = null;
let plateMat: THREE.MeshStandardMaterial | null = null;
let foodGeo: THREE.SphereGeometry | null = null;
let foodMat: THREE.MeshStandardMaterial | null = null;

function ensureMeshes(): void {
  if (!plateGeo) {
    plateGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.02, 18);
    plateMat = new THREE.MeshStandardMaterial({ color: 0xfaf2e2, roughness: 0.4 });
  }
  if (!foodGeo) {
    foodGeo = new THREE.SphereGeometry(0.09, 10, 8);
    foodMat = new THREE.MeshStandardMaterial({ color: 0xc28a52, roughness: 0.7 });
  }
}

function buildPlate(): THREE.Mesh {
  ensureMeshes();
  const plate = new THREE.Mesh(plateGeo!, plateMat!);
  plate.castShadow = true;
  plate.receiveShadow = true;
  const food = new THREE.Mesh(foodGeo!, foodMat!);
  food.position.set(0, 0.05, 0);
  food.scale.y = 0.6;
  plate.add(food);
  return plate;
}

export class SeatPlateVisualizer {
  /** guestId (as string for stable map key) → attached mesh. */
  private plates = new Map<string, THREE.Mesh>();
  /** Where to mount each plate by floor index. Caller provides this
   * via setStoreyMount; falls back to a single root if unset. */
  private storeyMounts = new Map<number, THREE.Object3D>();
  private fallbackRoot: THREE.Object3D | null = null;

  /** Register the mount group for a given floor. Visitors set one
   * mount (visitorRoot) for floor 0; multi-storey worlds wire one
   * per floor so plates inherit per-storey visibility groups. */
  setStoreyMount(floor: number, mount: THREE.Object3D | null): void {
    if (mount) this.storeyMounts.set(floor, mount);
    else this.storeyMounts.delete(floor);
  }

  /** Single root used when setStoreyMount isn't called per-floor. */
  setFallbackRoot(root: THREE.Object3D | null): void {
    this.fallbackRoot = root;
  }

  /** A guest row arrived (insert) or updated. Reconcile by deciding
   * whether the plate should be visible. */
  onGuest(row: {
    id: bigint;
    state: string;
    plateX: number;
    plateZ: number;
    seatFloor: number;
  }): void {
    const key = String(row.id);
    if (row.state === "eating") {
      this.show(key, row.plateX, row.plateZ, row.seatFloor);
    } else {
      this.hide(key);
    }
  }

  /** A guest row vanished. Drop their plate. */
  onGuestDelete(id: bigint): void {
    this.hide(String(id));
  }

  /** Drop everything. Visit-mode teardown. */
  dispose(): void {
    for (const key of Array.from(this.plates.keys())) this.hide(key);
    this.storeyMounts.clear();
    this.fallbackRoot = null;
  }

  // ─── Internals ──────────────────────────────────────────────────

  private show(key: string, plateX: number, plateZ: number, floor: number): void {
    const mount = this.storeyMounts.get(floor) ?? this.fallbackRoot;
    if (!mount) return;
    let plate = this.plates.get(key);
    if (!plate) {
      plate = buildPlate();
      this.plates.set(key, plate);
      mount.add(plate);
    } else if (plate.parent !== mount) {
      // Floor changed mid-eat (rare). Re-parent.
      plate.parent?.remove(plate);
      mount.add(plate);
    }
    plate.position.set(plateX, TABLE_TOP_Y + floor * STOREY_HEIGHT, plateZ);
  }

  private hide(key: string): void {
    const plate = this.plates.get(key);
    if (!plate) return;
    plate.parent?.remove(plate);
    this.plates.delete(key);
  }
}
