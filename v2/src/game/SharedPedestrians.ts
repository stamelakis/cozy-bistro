import * as THREE from "three";
import type { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter, type SkeletalDriver } from "../scene/CharacterAnimator";
import { sharedRiggedLoader, riggedCustomerForKey } from "../scene/RiggedCharacter";

/** Server-side row shape returned by SpacetimeClient.listPedestrians. */
export interface ServerPedestrian {
  id: bigint;
  variant: string;
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  /** Milliseconds since epoch (already converted from SDK Timestamp). */
  spawnAtMs: number;
  durationMs: number;
  /** Plot id this pedestrian intends to enter when their trajectory
   * ends. 0n = ambient walker (no intent). When non-zero, the
   * SharedPedestrians renderer fires onArrival on the frame the
   * pedestrian's trajectory hits t=1 so Engine can deliver the
   * customer to that plot's local GuestSpawner. */
  targetPlotId: bigint;
}

interface RenderedPedestrian {
  id: bigint;
  character: AnimatedCharacter;
  start: THREE.Vector2;
  end: THREE.Vector2;
  spawnAtMs: number;
  durationMs: number;
  /** Cached facing — computed once at spawn from end - start
   * direction. The character's facingY is reapplied each frame so
   * the animator doesn't snap it back to a default value. */
  facingY: number;
  /** Non-zero when this pedestrian is heading for a specific plot's
   * door. Used by SharedPedestrians.update to fire onArrival when
   * the trajectory completes. */
  targetPlotId: bigint;
  /** Set to true the first time onArrival fires so we don't notify
   * twice for the same pedestrian (the server's despawn lags the
   * trajectory end by a couple of seconds — until then the row is
   * still in the listPedestrians snapshot). */
  arrivalFired: boolean;
  /** Cached variant string so onArrival can echo it back to the
   * GuestSpawner — visual continuity between the walker and the
   * customer that just sat down. */
  variant: string;
}

/**
 * P5 — renders the SHARED pedestrians the server maintains in the
 * pedestrian table. Replaces the legacy per-client PedestrianSpawner
 * (which had each browser invent its own crowd).
 *
 * Per frame: walk the current server pedestrian list, instantiate a
 * character model for each new row, drop models for deleted rows,
 * and update positions via lerp(start, end, t) where
 * t = (now - spawnAt) / duration. Characters parent to
 * `worldRoot` so the player's plot offset shifts them onto the right
 * visual avenue (same trick the rest of the shared city uses).
 */
export class SharedPedestrians {
  private readonly parent: THREE.Group;
  private readonly loader: CharacterLoader;
  private readonly animator: CharacterAnimator;
  private readonly rendered = new Map<string, RenderedPedestrian>();
  /** Set of pending loads keyed by pedestrian id so concurrent updates
   * don't spawn two models for the same id while the GLB is in flight. */
  private readonly loading = new Set<string>();
  /** Ids of pedestrians whose trajectory finished and which we removed locally
   * while the server's despawn lags. Suppresses re-spawning them as a frozen
   * statue; cleared once the server finally drops the row from its snapshot. */
  private readonly retired = new Set<string>();

  /** Engine wires this to know when a target-bound pedestrian has
   * reached the door of the plot they were heading for. Engine
   * checks the targetPlotId against its own ownedPlotId and, if it
   * matches, calls GuestSpawner.triggerExternalArrival so the
   * customer flows into the local gameplay simulation. Fires exactly
   * once per pedestrian (gated by RenderedPedestrian.arrivalFired). */
  onArrival?: (targetPlotId: bigint, variant: string) => void;

  constructor(parent: THREE.Group, loader: CharacterLoader, animator: CharacterAnimator) {
    this.parent = parent;
    this.loader = loader;
    this.animator = animator;
  }

  /** Reconcile against the current server list + step positions. Call
   * every frame from Engine.tick with the live server snapshot. */
  update(serverList: readonly ServerPedestrian[], _dt: number): void {
    const seenIds = new Set<string>();
    const nowMs = Date.now();
    // Pass 1 — handle adds, position updates, and completed-trajectory cleanup.
    for (const sp of serverList) {
      const key = sp.id.toString();
      seenIds.add(key);
      const existing = this.rendered.get(key);
      const t = sp.durationMs > 0 ? (nowMs - sp.spawnAtMs) / sp.durationMs : 1;
      if (t < 1) {
        // Still walking — spawn if new, else step its lerp position.
        if (existing) this.updatePosition(existing, nowMs);
        else if (!this.loading.has(key) && !this.retired.has(key)) void this.spawn(sp);
        continue;
      }
      // Trajectory COMPLETE (t >= 1). The server keeps the row until its own
      // despawn tick fires — meant to be ~2 s, but under load it lags badly and
      // the walker stands frozen in place as a "statue", filling the street.
      // Deliver the customer (once) for a plot-bound walker, drop the model
      // now, and retire the id so it isn't re-spawned during the lag.
      const firedAlready = existing ? existing.arrivalFired : this.retired.has(key);
      if (!firedAlready && sp.targetPlotId !== 0n) {
        try { this.onArrival?.(sp.targetPlotId, sp.variant); }
        catch (err) { console.warn("[SharedPedestrians] onArrival handler threw:", err); }
      }
      if (existing) {
        this.parent.remove(existing.character.root);
        this.animator.remove(existing.character.root);
        this.rendered.delete(key);
      }
      this.retired.add(key);
    }
    // Pass 2 — drop pedestrians the server removed.
    for (const [key, r] of this.rendered) {
      if (seenIds.has(key)) continue;
      this.parent.remove(r.character.root);
      this.animator.remove(r.character.root);
      this.rendered.delete(key);
    }
    // Forget retirements the server has finally dropped from its snapshot.
    for (const key of this.retired) if (!seenIds.has(key)) this.retired.delete(key);
  }

  /** Snapshot for the PersonalSpace pass. Shared pedestrians are
   * all movable but not pinned — same shape the legacy spawner
   * exposed so PersonalSpaceSystem doesn't need to change. */
  snapshotMovable(): { character: AnimatedCharacter; pinned: boolean }[] {
    return Array.from(this.rendered.values()).map((r) => ({ character: r.character, pinned: false }));
  }

  private async spawn(sp: ServerPedestrian): Promise<void> {
    const key = sp.id.toString();
    this.loading.add(key);
    try {
      // Rigged GLB customer (one of 8, by id hash) — replaces the static mesh;
      // falls back to the static placeholder if a rigged GLB fails to load.
      let model: THREE.Object3D;
      let controller: SkeletalDriver | undefined;
      try {
        const inst = await sharedRiggedLoader.createInstance(riggedCustomerForKey(key));
        model = inst.root; controller = inst.controller;
      } catch (e) {
        console.warn("[SharedPedestrians] rigged customer load failed; using placeholder:", e);
        model = await this.loader.load(sp.variant);
      }
      // Server might have removed the row while the GLB was loading —
      // bail without parenting if so.
      if (this.loading.has(key) === false) return;
      this.parent.add(model);
      const dx = sp.endX - sp.startX;
      const dz = sp.endZ - sp.startZ;
      // Facing: atan2 against world-axis convention used by the
      // legacy spawner. East = -π/2, West = π/2, South = 0, North = π.
      let facingY: number;
      if (Math.abs(dx) > Math.abs(dz)) {
        facingY = dx > 0 ? -Math.PI / 2 : Math.PI / 2;
      } else {
        facingY = dz > 0 ? 0 : Math.PI;
      }
      const animated: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(sp.startX, sp.startZ),
        facingY,
        action: "walk",
        phase: Math.random() * 5,
        skeletal: controller,
      };
      this.animator.add(animated);
      this.rendered.set(key, {
        id: sp.id,
        character: animated,
        start: new THREE.Vector2(sp.startX, sp.startZ),
        end: new THREE.Vector2(sp.endX, sp.endZ),
        spawnAtMs: sp.spawnAtMs,
        durationMs: sp.durationMs,
        facingY,
        targetPlotId: sp.targetPlotId,
        arrivalFired: false,
        variant: sp.variant,
      });
      // Set initial position immediately to avoid a frame at default Y.
      this.updatePosition(this.rendered.get(key)!, Date.now());
    } catch (err) {
      console.warn(`[SharedPedestrians] failed to load ${sp.variant}:`, err);
    } finally {
      this.loading.delete(key);
    }
  }

  private updatePosition(r: RenderedPedestrian, nowMs: number): void {
    const elapsed = nowMs - r.spawnAtMs;
    const t = r.durationMs > 0 ? Math.max(0, Math.min(1, elapsed / r.durationMs)) : 0;
    r.character.groundPos.x = r.start.x + (r.end.x - r.start.x) * t;
    r.character.groundPos.y = r.start.y + (r.end.y - r.start.y) * t;
    r.character.facingY = r.facingY;
    // Arrival event — fires once when a target-bound pedestrian has
    // reached its plot's door. The server keeps the row for another
    // tick or two (until the next pedestrian_tick despawns it), but
    // we want the customer to enter the gameplay the MOMENT the
    // walker visually arrives.
    if (!r.arrivalFired && r.targetPlotId !== 0n && t >= 1) {
      r.arrivalFired = true;
      try {
        this.onArrival?.(r.targetPlotId, r.variant);
      } catch (err) {
        console.warn("[SharedPedestrians] onArrival handler threw:", err);
      }
    }
  }
}
