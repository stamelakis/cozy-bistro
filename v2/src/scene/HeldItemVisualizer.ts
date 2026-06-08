import * as THREE from "three";

/**
 * Phase H.A — Cloud-derived held-item visualizer.
 *
 * Listens to staff_actor + active_ticket cloud rows and attaches a
 * plate (or glass) mesh to the staff actor's character root whenever
 * they're currently transporting an order. Conditions:
 *
 *   1. staff_actor.ticketId is non-null
 *   2. the referenced active_ticket exists and is in a CARRY state
 *      ("delivering" — waiter walking to the table)
 *
 * State 3 — chefs holding a cooked plate between "ready" and
 * "delivering" — happens in less than a frame on the foreground sim
 * (the chef finishes, the ticket becomes "ready", a waiter claims
 * it as "delivering" almost immediately). Skipping that micro-state
 * here keeps the visualizer simple; we can extend later if we ever
 * want chefs visibly holding plates at their station.
 *
 * Drink tickets render as a glass; food tickets as a plate.
 * Distinguishing factor: ticket.appliance === "bar" → glass.
 *
 * Used by VisitMode today (visitors see the carried plate). H.D will
 * also plug it into the host's main view, replacing the legacy
 * `heldPlate.visible` toggling scattered through StaffRouter.
 *
 * The visualizer owns the meshes it creates; call `dispose()` on
 * teardown to release the shared geometry refcount + detach any
 * attached meshes from the scene.
 */

/** Subset of THREE that VisitMode + Engine both have on hand —
 * keeps this module decoupled from the AnimatedCharacter type. */
export interface VisualHost {
  root: THREE.Object3D;
}

export type HeldItemKind = "plate" | "glass";

interface MeshHandle {
  kind: HeldItemKind;
  mesh: THREE.Mesh;
}

/** Shared geometry/material — one allocation per kind, reused across
 * every visualizer instance (visit, host, future co-owner). */
let plateGeo: THREE.CylinderGeometry | null = null;
let plateMat: THREE.MeshStandardMaterial | null = null;
let glassGeo: THREE.CylinderGeometry | null = null;
let glassMat: THREE.MeshStandardMaterial | null = null;

function ensureMeshes(): void {
  if (!plateGeo) {
    plateGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.018, 14);
    plateMat = new THREE.MeshStandardMaterial({ color: 0xfaf2e2, roughness: 0.4 });
  }
  if (!glassGeo) {
    glassGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.14, 12);
    glassMat = new THREE.MeshStandardMaterial({
      color: 0xc4d8e8, roughness: 0.15, metalness: 0.05, transparent: true, opacity: 0.7,
    });
  }
}

function makePlateMesh(): THREE.Mesh {
  ensureMeshes();
  const m = new THREE.Mesh(plateGeo!, plateMat!);
  // Belly height on a 1.7×-scaled character; matches the legacy
  // StaffRouter.makePlate so visit-mode and host-mode positions look
  // identical at the same staff actor.
  m.position.set(0, 0.55, 0.18);
  m.castShadow = true;
  return m;
}

function makeGlassMesh(): THREE.Mesh {
  ensureMeshes();
  const m = new THREE.Mesh(glassGeo!, glassMat!);
  // Same anchor point; the difference is the glass's taller geometry
  // pokes up where the plate is flat.
  m.position.set(0, 0.62, 0.18);
  m.castShadow = true;
  return m;
}

export class HeldItemVisualizer {
  /** memberId → current ticketId (or null). Tracked from the most
   * recent staff_actor row we've seen for that member. */
  private memberToTicket = new Map<string, bigint | null>();
  /** ticketId → { state, appliance } from the most recent
   * active_ticket row. Used to look up the kind at decision time. */
  private ticketInfo = new Map<bigint, { state: string; appliance: string }>();
  /** memberId → currently attached mesh handle (or absent). */
  private attached = new Map<string, MeshHandle>();
  /** memberId → character host (resolver from outside). */
  private hosts = new Map<string, VisualHost>();

  /** Register / unregister the visual host for a staff member. Call
   * this when the corresponding live character GLB has loaded (or
   * when it's torn down). */
  setHost(memberId: string, host: VisualHost | null): void {
    if (host) {
      this.hosts.set(memberId, host);
    } else {
      // Detach any mesh that was hanging off the old host before
      // forgetting it.
      this.detach(memberId);
      this.hosts.delete(memberId);
    }
    this.reconcile(memberId);
  }

  /** A staff_actor row landed (insert or update). Update our cached
   * (member → ticket) mapping and reconcile. */
  onStaffActor(memberId: string, ticketId: bigint | null): void {
    this.memberToTicket.set(memberId, ticketId);
    this.reconcile(memberId);
  }

  /** A staff_actor row vanished. Drop any held mesh + cached state. */
  onStaffActorDelete(memberId: string): void {
    this.detach(memberId);
    this.memberToTicket.delete(memberId);
    // Don't forget the host — that's tracked separately and may
    // outlive a brief staff_actor flicker.
  }

  /** An active_ticket row landed. Cache its current state + appliance
   * and reconcile any members holding it. */
  onTicket(id: bigint, state: string, appliance: string): void {
    this.ticketInfo.set(id, { state, appliance });
    // Reconcile every staff member whose ticketId points at this id.
    for (const [memberId, ticketId] of this.memberToTicket) {
      if (ticketId === id) this.reconcile(memberId);
    }
  }

  /** A ticket vanished. Anyone "holding" it loses their mesh. */
  onTicketDelete(id: bigint): void {
    this.ticketInfo.delete(id);
    for (const [memberId, ticketId] of this.memberToTicket) {
      if (ticketId === id) this.reconcile(memberId);
    }
  }

  /** Drop everything. Call on visit-mode exit / engine shutdown. */
  dispose(): void {
    for (const memberId of Array.from(this.attached.keys())) {
      this.detach(memberId);
    }
    this.memberToTicket.clear();
    this.ticketInfo.clear();
    this.hosts.clear();
  }

  // ─── Internals ──────────────────────────────────────────────────

  /** Decide what mesh (if any) should be attached to this member
   * right now, and make it so. Idempotent — calling repeatedly with
   * the same state is a no-op. */
  private reconcile(memberId: string): void {
    const host = this.hosts.get(memberId);
    const ticketId = this.memberToTicket.get(memberId);
    const desiredKind = this.computeDesiredKind(ticketId);
    if (!host || desiredKind === null) {
      this.detach(memberId);
      return;
    }
    const current = this.attached.get(memberId);
    if (current && current.kind === desiredKind) {
      // Already correct — make sure it's still parented to the
      // current host (host may have been swapped on a re-spawn).
      if (current.mesh.parent !== host.root) {
        host.root.add(current.mesh);
      }
      return;
    }
    // Replace whatever was there (different kind, or nothing).
    if (current) this.detach(memberId);
    const mesh = desiredKind === "glass" ? makeGlassMesh() : makePlateMesh();
    host.root.add(mesh);
    this.attached.set(memberId, { kind: desiredKind, mesh });
  }

  /** Returns the mesh kind the member should be holding, or null
   * for "no mesh".  Encapsulates the "is this a carry state?"
   * predicate so the heuristic lives in one place. */
  private computeDesiredKind(ticketId: bigint | null | undefined): HeldItemKind | null {
    if (ticketId == null) return null;
    const info = this.ticketInfo.get(ticketId);
    if (!info) return null;
    if (info.state !== "delivering") return null;
    return info.appliance === "bar" ? "glass" : "plate";
  }

  private detach(memberId: string): void {
    const handle = this.attached.get(memberId);
    if (!handle) return;
    handle.mesh.parent?.remove(handle.mesh);
    // Geometry + material are shared — we don't dispose them here.
    this.attached.delete(memberId);
  }
}
