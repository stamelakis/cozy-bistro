import * as THREE from "three";

/**
 * Phase H.A — Cloud-derived dishwasher cycle-ring visualizer.
 *
 * Listens to dishwasher_batch cloud rows. For every batch with
 * cycle_time_remaining_ms > 0, renders a small countdown ring at
 * the dishwasher's footprint position. The ring's arc shrinks as
 * the cycle counts down; vanishes when the batch row is deleted
 * (cycle complete) or remaining is zero.
 *
 * NEW visual — host's local sim never rendered a cycle ring. Visit
 * mode + host's view will both render it once we wire this into
 * the host (H.D).
 *
 * Position: from placed_furniture for the dishwasher's uid. The
 * caller supplies a resolver `(uid) → {x, z, floor} | null` so
 * this module doesn't import the furniture registry directly —
 * keeps it usable from both VisitMode (uses placed_furniture
 * cloud rows) and the host's main view (uses FurnitureRegistry).
 *
 * Total cycle duration is unknown from the snapshot — we only get
 * cycle_time_remaining_ms. To draw a "% remaining" arc we cache
 * the largest value we've seen for each uid and treat that as the
 * baseline. Not perfect when a batch is mid-cycle on first
 * subscription, but close enough for a visual cue.
 */

const STOREY_HEIGHT = 3;

export interface FurniturePos {
  x: number;
  z: number;
  floor: number;
}

export type FurnitureResolver = (furnitureUid: string) => FurniturePos | null;

let ringGeo: THREE.RingGeometry | null = null;
let ringMatActive: THREE.MeshBasicMaterial | null = null;
let ringMatBg: THREE.MeshBasicMaterial | null = null;

function ensureMeshes(): void {
  if (!ringGeo) {
    // Ring with inner 0.18, outer 0.24 — small badge under the dishwasher.
    ringGeo = new THREE.RingGeometry(0.18, 0.24, 36, 1);
  }
  if (!ringMatActive) {
    ringMatActive = new THREE.MeshBasicMaterial({
      color: 0x8be3a8, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
    });
  }
  if (!ringMatBg) {
    ringMatBg = new THREE.MeshBasicMaterial({
      color: 0x444444, side: THREE.DoubleSide, transparent: true, opacity: 0.35,
    });
  }
}

interface RingHandle {
  bg: THREE.Mesh;
  active: THREE.Mesh;
  group: THREE.Group;
  /** Largest cycle_time_remaining_ms we've seen for this uid;
   * proxies the total cycle duration so the arc reads as "% left". */
  maxRemainingMs: number;
}

export class WashCycleRingVisualizer {
  private rings = new Map<string, RingHandle>();
  private root: THREE.Object3D | null = null;
  private resolver: FurnitureResolver | null = null;

  /** Where to mount the rings. Visitor mounts under visitorRoot;
   * host mounts under WorldScene.root. */
  setRoot(root: THREE.Object3D | null): void {
    if (!root) {
      // Mount changed/cleared — detach every ring; they'll re-attach
      // on next reconcile if the new root is set later.
      for (const r of this.rings.values()) {
        r.group.parent?.remove(r.group);
      }
    }
    this.root = root;
  }

  setResolver(resolver: FurnitureResolver | null): void {
    this.resolver = resolver;
  }

  /** A dishwasher_batch row arrived (insert or update). */
  onBatch(furnitureUid: string, remainingMs: number): void {
    if (remainingMs <= 0) {
      this.remove(furnitureUid);
      return;
    }
    if (!this.root || !this.resolver) return;
    const pos = this.resolver(furnitureUid);
    if (!pos) {
      // Furniture not in cache yet — drop the ring (it'll re-create
      // when the placed_furniture subscription arrives).
      this.remove(furnitureUid);
      return;
    }
    let handle = this.rings.get(furnitureUid);
    if (!handle) {
      ensureMeshes();
      const bg = new THREE.Mesh(ringGeo!, ringMatBg!);
      const active = new THREE.Mesh(ringGeo!, ringMatActive!);
      // Flat on the ground, just above floor to avoid z-fighting.
      bg.rotation.x = -Math.PI / 2;
      active.rotation.x = -Math.PI / 2;
      bg.position.y = 0.02;
      active.position.y = 0.025;
      const group = new THREE.Group();
      group.add(bg);
      group.add(active);
      this.root.add(group);
      handle = { bg, active, group, maxRemainingMs: remainingMs };
      this.rings.set(furnitureUid, handle);
    }
    if (remainingMs > handle.maxRemainingMs) {
      // Saw a higher value than before — adopt as the new max (fresh
      // cycle started; the arc resets to full on the next frame).
      handle.maxRemainingMs = remainingMs;
    }
    handle.group.position.set(pos.x, pos.floor * STOREY_HEIGHT, pos.z);
    // Compute arc fraction; clamp 0..1.
    const frac = Math.min(1, Math.max(0, remainingMs / handle.maxRemainingMs));
    // Replace the active ring's geometry with a partial arc.
    handle.active.geometry.dispose();
    handle.active.geometry = new THREE.RingGeometry(
      0.18, 0.24, 36, 1,
      0, frac * Math.PI * 2,
    );
  }

  /** A batch row vanished — cycle finished, dishwasher sold, etc. */
  onBatchDelete(furnitureUid: string): void {
    this.remove(furnitureUid);
  }

  /** Drop everything. */
  dispose(): void {
    for (const uid of Array.from(this.rings.keys())) this.remove(uid);
    this.root = null;
    this.resolver = null;
  }

  private remove(furnitureUid: string): void {
    const handle = this.rings.get(furnitureUid);
    if (!handle) return;
    handle.group.parent?.remove(handle.group);
    handle.active.geometry.dispose();
    // bg geometry is shared (ringGeo) — don't dispose.
    this.rings.delete(furnitureUid);
  }
}
