import * as THREE from "three";

/**
 * PlacementGrid — the mobile tap-to-place overlay.
 *
 * Two marker styles, drawn ON TOP of the scene (depthTest off, high renderOrder):
 *  - FLOOR cells (tile / ceiling items): flat translucent squares on the ground.
 *    The tap is resolved by BuildMenu's floor-plane raycast.
 *  - WALL stripes (wall / edge / wall-shelf items): vertical panels standing on
 *    the wall at each valid mount, oriented into the room. These are PICKABLE —
 *    each carries its placement plan in userData, and the tap raycasts the
 *    stripes directly (a floor raycast would land a diagonal tile low).
 *
 * BuildMenu owns validity/snapping; this class only renders + exposes pickables.
 */
export class PlacementGrid {
  private readonly group = new THREE.Group();
  // Floor markers.
  private readonly fillGeom = new THREE.PlaneGeometry(0.92, 0.92);
  private readonly fillMat = new THREE.MeshBasicMaterial({
    color: 0x74e08a, transparent: true, opacity: 0.30,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  private readonly edgeMat = new THREE.LineBasicMaterial({
    color: 0xa9ffc0, transparent: true, opacity: 0.85, depthTest: false,
  });
  private readonly edgeGeom: THREE.BufferGeometry;
  // Wall markers (vertical stripe).
  private readonly stripeGeom = new THREE.PlaneGeometry(0.9, 2.0);
  private readonly stripeMat = new THREE.MeshBasicMaterial({
    color: 0x74e08a, transparent: true, opacity: 0.34,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  /** Wall-stripe meshes for the tap raycast; empty when showing the floor grid. */
  private readonly pickables: THREE.Object3D[] = [];

  constructor() {
    this.group.name = "placement-grid";
    this.group.renderOrder = 9990;
    const h = 0.46;
    this.edgeGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-h, 0, -h), new THREE.Vector3(h, 0, -h),
      new THREE.Vector3(h, 0, h), new THREE.Vector3(-h, 0, h),
    ]);
  }

  /** Flat floor tiles at each cell (tile / ceiling items). */
  show(mount: THREE.Object3D, cells: ReadonlyArray<{ x: number; z: number }>, y: number): void {
    this.clear();
    for (const c of cells) {
      const fill = new THREE.Mesh(this.fillGeom, this.fillMat);
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(c.x, y, c.z);
      fill.renderOrder = 9990;
      this.group.add(fill);
      // edgeGeom corners are authored flat in XZ, so NO rotation (else vertical).
      const edge = new THREE.LineLoop(this.edgeGeom, this.edgeMat);
      edge.position.set(c.x, y + 0.002, c.z);
      edge.renderOrder = 9991;
      this.group.add(edge);
    }
    this.parentTo(mount, cells.length > 0);
  }

  /** Vertical wall stripes at each valid mount (wall / edge / wall-shelf). Each
   * stripe stores its plan in userData.plan for BuildMenu's tap raycast. */
  showWall(mount: THREE.Object3D, marks: ReadonlyArray<{ x: number; z: number; rotY: number; plan: unknown }>, baseY: number): void {
    this.clear();
    for (const m of marks) {
      const stripe = new THREE.Mesh(this.stripeGeom, this.stripeMat);
      stripe.position.set(m.x, baseY + 1.15, m.z);
      stripe.rotation.y = m.rotY;
      stripe.renderOrder = 9990;
      stripe.userData.plan = m.plan;
      this.group.add(stripe);
      this.pickables.push(stripe);
    }
    this.parentTo(mount, marks.length > 0);
  }

  /** The wall-stripe meshes to raycast a tap against (empty for the floor grid). */
  getPickables(): readonly THREE.Object3D[] { return this.pickables; }

  hide(): void {
    this.clear();
    this.group.parent?.remove(this.group);
    this.group.visible = false;
  }

  private parentTo(mount: THREE.Object3D, visible: boolean): void {
    if (this.group.parent !== mount) {
      this.group.parent?.remove(this.group);
      mount.add(this.group);
    }
    this.group.visible = visible;
  }

  private clear(): void {
    while (this.group.children.length > 0) this.group.remove(this.group.children[0]);
    this.pickables.length = 0;
  }

  dispose(): void {
    this.hide();
    this.fillGeom.dispose();
    this.fillMat.dispose();
    this.edgeGeom.dispose();
    this.edgeMat.dispose();
    this.stripeGeom.dispose();
    this.stripeMat.dispose();
  }
}
