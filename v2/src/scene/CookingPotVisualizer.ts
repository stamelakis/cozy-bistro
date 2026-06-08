import * as THREE from "three";

/**
 * Phase H.A — Cloud-derived cooking-pot visualizer.
 *
 * Listens to active_ticket + staff_actor cloud rows. Whenever a
 * ticket is in "cooking" state, finds the chef who claimed it via
 * ticket.assignedChefId → staff_actor → the chef's current
 * groundPos, and attaches a small bubbling-pot mesh at that
 * position. Removes the pot when the ticket transitions out of
 * cooking.
 *
 * Position fidelity: anchored to the chef's character instead of
 * the specific stove uid. Since the chef is at their stove while
 * cooking (state == "working"), the pot reads as "on the stove
 * next to the chef" without us needing to query placed_furniture
 * for the station's coords. Trade-off: if the chef's character
 * lags a frame behind the server position, the pot lags too —
 * fine for visit mode.
 *
 * Bar drinks (appliance === "bar") are excluded; the barman's
 * mixing animation is the visual cue there, no pot needed.
 *
 * Lifecycle: pot mesh is attached to the chef's character root via
 * setHost(memberId, host). Same VisualHost contract as
 * HeldItemVisualizer.
 */

/** Subset of THREE that the consumer side provides. Keeps this
 * module independent of the AnimatedCharacter type. */
export interface VisualHost {
  root: THREE.Object3D;
}

let potGeo: THREE.CylinderGeometry | null = null;
let potMat: THREE.MeshStandardMaterial | null = null;
let steamGeo: THREE.SphereGeometry | null = null;
let steamMat: THREE.MeshStandardMaterial | null = null;

function ensureMeshes(): void {
  if (!potGeo) {
    potGeo = new THREE.CylinderGeometry(0.14, 0.12, 0.18, 14);
    potMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.3, metalness: 0.6 });
  }
  if (!steamGeo) {
    steamGeo = new THREE.SphereGeometry(0.08, 10, 8);
    steamMat = new THREE.MeshStandardMaterial({
      color: 0xeeeeee, roughness: 0.9, transparent: true, opacity: 0.5,
    });
  }
}

function buildPot(): THREE.Group {
  ensureMeshes();
  const group = new THREE.Group();
  const pot = new THREE.Mesh(potGeo!, potMat!);
  // Position just in front of the chef and roughly at workbench
  // height (chef scale ≈ 1.7×; 0.55 × 1.7 ≈ 0.93 m world). Slightly
  // forward (z = 0.20) so the pot looks like it's on the stove
  // they're facing.
  pot.position.set(0, 0.55, 0.20);
  pot.castShadow = true;
  group.add(pot);
  // Steam puff above the pot for the "actively cooking" cue.
  const steam = new THREE.Mesh(steamGeo!, steamMat!);
  steam.position.set(0, 0.72, 0.20);
  group.add(steam);
  return group;
}

export class CookingPotVisualizer {
  /** ticketId → cached state + appliance + assignedChefId. */
  private ticketInfo = new Map<bigint, {
    state: string;
    appliance: string;
    assignedChefId: string;
  }>();
  /** memberId → current ticketId (from staff_actor.ticketId). */
  private memberTicket = new Map<string, bigint | null>();
  /** memberId → VisualHost (character root). */
  private hosts = new Map<string, VisualHost>();
  /** memberId → attached pot mesh, if any. */
  private attached = new Map<string, THREE.Group>();

  setHost(memberId: string, host: VisualHost | null): void {
    if (host) {
      this.hosts.set(memberId, host);
    } else {
      this.detach(memberId);
      this.hosts.delete(memberId);
    }
    this.reconcile(memberId);
  }

  onStaffActor(memberId: string, ticketId: bigint | null): void {
    this.memberTicket.set(memberId, ticketId);
    this.reconcile(memberId);
  }

  onStaffActorDelete(memberId: string): void {
    this.detach(memberId);
    this.memberTicket.delete(memberId);
  }

  onTicket(id: bigint, state: string, appliance: string, assignedChefId: string): void {
    this.ticketInfo.set(id, { state, appliance, assignedChefId });
    // Reconcile any member whose ticketId is this ticket.
    for (const [memberId, ticketId] of this.memberTicket) {
      if (ticketId === id) this.reconcile(memberId);
    }
    // Also reconcile the assigned chef directly — they might have
    // a stale ticketId in staff_actor (race between insert events).
    if (assignedChefId) this.reconcile(assignedChefId);
  }

  onTicketDelete(id: bigint): void {
    this.ticketInfo.delete(id);
    for (const [memberId, ticketId] of this.memberTicket) {
      if (ticketId === id) this.reconcile(memberId);
    }
  }

  dispose(): void {
    for (const memberId of Array.from(this.attached.keys())) this.detach(memberId);
    this.ticketInfo.clear();
    this.memberTicket.clear();
    this.hosts.clear();
  }

  // ─── Internals ──────────────────────────────────────────────────

  private reconcile(memberId: string): void {
    const host = this.hosts.get(memberId);
    if (!host) {
      this.detach(memberId);
      return;
    }
    if (!this.shouldShow(memberId)) {
      this.detach(memberId);
      return;
    }
    if (this.attached.has(memberId)) {
      // Already attached — make sure the parent is still correct.
      const existing = this.attached.get(memberId)!;
      if (existing.parent !== host.root) host.root.add(existing);
      return;
    }
    const pot = buildPot();
    host.root.add(pot);
    this.attached.set(memberId, pot);
  }

  /** Show a pot for this member when EITHER:
   *   a) they have a ticketId pointing at a cooking ticket, OR
   *   b) any cooking ticket lists them as assignedChefId.
   * (b) catches the brief window where the ticket has been
   * claimed but staff_actor.ticketId hasn't echoed back yet. */
  private shouldShow(memberId: string): boolean {
    const ticketId = this.memberTicket.get(memberId);
    if (ticketId != null) {
      const info = this.ticketInfo.get(ticketId);
      if (info && info.state === "cooking" && info.appliance !== "bar") {
        return true;
      }
    }
    for (const info of this.ticketInfo.values()) {
      if (info.state === "cooking" && info.appliance !== "bar"
          && info.assignedChefId === memberId) {
        return true;
      }
    }
    return false;
  }

  private detach(memberId: string): void {
    const pot = this.attached.get(memberId);
    if (!pot) return;
    pot.parent?.remove(pot);
    this.attached.delete(memberId);
  }
}
