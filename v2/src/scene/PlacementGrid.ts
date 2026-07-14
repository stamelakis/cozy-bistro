import * as THREE from "three";

/**
 * PlacementGrid — a mobile placement aid (Phase 1: floor / "tile" items).
 *
 * During tap-to-place it lights up every VALID cell for the item currently
 * being placed as a translucent tile drawn ON TOP of the scene (depthTest off,
 * high renderOrder), so the player can see exactly where a tap will land
 * instead of dragging a ghost around an iso view. BuildMenu owns occupancy /
 * footprint, so it computes the valid cells and hands them here to render; this
 * class is purely visual (taps are resolved by BuildMenu's raycast).
 */
export class PlacementGrid {
  private readonly group = new THREE.Group();
  private readonly fillGeom = new THREE.PlaneGeometry(0.92, 0.92);
  private readonly fillMat = new THREE.MeshBasicMaterial({
    color: 0x74e08a, transparent: true, opacity: 0.30,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  private readonly edgeMat = new THREE.LineBasicMaterial({
    color: 0xa9ffc0, transparent: true, opacity: 0.85, depthTest: false,
  });
  private readonly edgeGeom: THREE.BufferGeometry;

  constructor() {
    this.group.name = "placement-grid";
    this.group.renderOrder = 9990;
    // Square outline (LineLoop auto-closes the 4 corners) for a crisp tile edge.
    const h = 0.46;
    this.edgeGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-h, 0, -h), new THREE.Vector3(h, 0, -h),
      new THREE.Vector3(h, 0, h), new THREE.Vector3(-h, 0, h),
    ]);
  }

  /** Render one tile per cell, parented to `mount` (the focused storey's mount,
   * so coords + visibility match where items actually land), at local height y.
   * Replaces any previously-shown grid. */
  show(mount: THREE.Object3D, cells: ReadonlyArray<{ x: number; z: number }>, y: number): void {
    this.clear();
    for (const c of cells) {
      const fill = new THREE.Mesh(this.fillGeom, this.fillMat);
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(c.x, y, c.z);
      fill.renderOrder = 9990;
      this.group.add(fill);
      // NOTE: edgeGeom's corners are already authored in the XZ (floor) plane,
      // so — unlike the PlaneGeometry fill — it must NOT be rotated, or the
      // outline stands up vertically instead of lying flat on the ground.
      const edge = new THREE.LineLoop(this.edgeGeom, this.edgeMat);
      edge.position.set(c.x, y + 0.002, c.z);
      edge.renderOrder = 9991;
      this.group.add(edge);
    }
    if (this.group.parent !== mount) {
      this.group.parent?.remove(this.group);
      mount.add(this.group);
    }
    this.group.visible = cells.length > 0;
  }

  hide(): void {
    this.clear();
    this.group.parent?.remove(this.group);
    this.group.visible = false;
  }

  private clear(): void {
    while (this.group.children.length > 0) this.group.remove(this.group.children[0]);
  }

  dispose(): void {
    this.hide();
    this.fillGeom.dispose();
    this.fillMat.dispose();
    this.edgeGeom.dispose();
    this.edgeMat.dispose();
  }
}
