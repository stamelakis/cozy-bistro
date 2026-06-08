import * as THREE from "three";

/**
 * Phase H.B — Cloud-derived dirty-pile visualizer.
 *
 * Listens to dirty_pile cloud rows (the H.B schema addition) and
 * renders a leftover plate (or empty glass) on the appropriate table
 * for each row. Removes the mesh when the row vanishes — typically
 * because a waiter picked it up.
 *
 * Replaces (in visit mode) the host's local-sim `dirtyTableMeshes`
 * array in GuestSpawner. H.D plugs this into the host's view too,
 * making the symmetric-rendering pattern complete.
 *
 * Visual: a slightly darker plate than the in-meal plate (so dirty
 * reads as distinct), and a small "crumb" mound on top to hint
 * "leftover food". Glass variant: a short translucent cylinder with
 * a thin "drink dregs" disk at the bottom.
 *
 * Position: comes straight from the cloud row (x, z, floor). Y is
 * the same TABLE_TOP_Y constant as the in-meal plate visualizer —
 * the host's getTableTopForGuest does a fancier per-table query but
 * the constant works for visit mode (all tables ~0.74 m).
 */

const TABLE_TOP_Y = 0.74;
const STOREY_HEIGHT = 3;

let plateGeo: THREE.CylinderGeometry | null = null;
let plateMat: THREE.MeshStandardMaterial | null = null;
let crumbGeo: THREE.SphereGeometry | null = null;
let crumbMat: THREE.MeshStandardMaterial | null = null;
let glassGeo: THREE.CylinderGeometry | null = null;
let glassMat: THREE.MeshStandardMaterial | null = null;
let dregsGeo: THREE.CylinderGeometry | null = null;
let dregsMat: THREE.MeshStandardMaterial | null = null;

function ensureMeshes(): void {
  if (!plateGeo) {
    plateGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.02, 18);
    // Slightly tan / used color, distinct from the clean food plate.
    plateMat = new THREE.MeshStandardMaterial({ color: 0xe8d6b8, roughness: 0.55 });
  }
  if (!crumbGeo) {
    crumbGeo = new THREE.SphereGeometry(0.06, 8, 6);
    crumbMat = new THREE.MeshStandardMaterial({ color: 0x6a4b2c, roughness: 0.9 });
  }
  if (!glassGeo) {
    glassGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.13, 12);
    glassMat = new THREE.MeshStandardMaterial({
      color: 0xc4d8e8, roughness: 0.2, transparent: true, opacity: 0.55,
    });
  }
  if (!dregsGeo) {
    dregsGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.015, 10);
    dregsMat = new THREE.MeshStandardMaterial({ color: 0x7a4a18, roughness: 0.8 });
  }
}

function buildPlatePile(): THREE.Group {
  ensureMeshes();
  const group = new THREE.Group();
  const plate = new THREE.Mesh(plateGeo!, plateMat!);
  plate.castShadow = true;
  group.add(plate);
  const crumb = new THREE.Mesh(crumbGeo!, crumbMat!);
  crumb.position.set(0, 0.03, 0);
  crumb.scale.y = 0.5; // squash into a mound
  group.add(crumb);
  return group;
}

function buildGlassPile(): THREE.Group {
  ensureMeshes();
  const group = new THREE.Group();
  const glass = new THREE.Mesh(glassGeo!, glassMat!);
  glass.position.set(0, 0.065, 0); // base of the cylinder sits on the table
  glass.castShadow = true;
  group.add(glass);
  const dregs = new THREE.Mesh(dregsGeo!, dregsMat!);
  dregs.position.set(0, 0.008, 0);
  group.add(dregs);
  return group;
}

export class DirtyPileVisualizer {
  /** rowId → attached mesh group. */
  private meshes = new Map<string, THREE.Group>();
  /** Per-floor mount group (or fallback root). */
  private storeyMounts = new Map<number, THREE.Object3D>();
  private fallbackRoot: THREE.Object3D | null = null;

  setStoreyMount(floor: number, mount: THREE.Object3D | null): void {
    if (mount) this.storeyMounts.set(floor, mount);
    else this.storeyMounts.delete(floor);
  }

  setFallbackRoot(root: THREE.Object3D | null): void {
    this.fallbackRoot = root;
  }

  /** A dirty_pile row arrived or updated. */
  onPile(row: {
    id: bigint;
    kind: string;
    floor: number;
    x: number;
    z: number;
  }): void {
    const mount = this.storeyMounts.get(row.floor) ?? this.fallbackRoot;
    if (!mount) return;
    const key = String(row.id);
    let group = this.meshes.get(key);
    if (!group) {
      group = row.kind === "glass" ? buildGlassPile() : buildPlatePile();
      this.meshes.set(key, group);
      mount.add(group);
    } else if (group.parent !== mount) {
      group.parent?.remove(group);
      mount.add(group);
    }
    group.position.set(row.x, TABLE_TOP_Y + row.floor * STOREY_HEIGHT, row.z);
  }

  /** A dirty_pile row vanished (waiter picked it up, or the
   * restaurant was deleted). */
  onPileDelete(id: bigint): void {
    const key = String(id);
    const group = this.meshes.get(key);
    if (!group) return;
    group.parent?.remove(group);
    this.meshes.delete(key);
  }

  dispose(): void {
    for (const key of Array.from(this.meshes.keys())) {
      const group = this.meshes.get(key);
      group?.parent?.remove(group);
    }
    this.meshes.clear();
    this.storeyMounts.clear();
    this.fallbackRoot = null;
  }
}
