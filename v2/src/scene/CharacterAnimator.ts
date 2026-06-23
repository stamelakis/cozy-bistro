import * as THREE from "three";

/**
 * Procedural pseudo-animation for static (un-rigged) character meshes.
 *
 * Our TripoSR-generated characters are unrigged statues — no bones, no
 * skeletal animation. So we fake "alive" with whole-body transforms:
 *   - Idle:  subtle breathing scale + tiny azimuthal sway
 *   - Walk:  vertical bob + facing the move direction + slight side lean
 *   - Sit:   rotated forward at the hip + lowered Y onto a chair seat
 *   - Carry: walk + small forward pitch
 *
 * This won't fool anyone up close but reads as "characters moving around
 * the restaurant" at iso distance, which is what we need for prototyping
 * gameplay. Real rigged animation is a polish-phase swap.
 */
export type CharacterAction = "idle" | "walk" | "sit" | "carry";

/** A rigged-character controller the animator drives instead of applying its
 * procedural pose. RiggedCharacter's RiggedController (the GLB cast) satisfies
 * this structurally, so the animator stays decoupled from the concrete class. */
export interface SkeletalDriver {
  update(dt: number, action: CharacterAction): void;
  stop(): void;
  /** True while a one-shot transition (sit-down / stand-up) is playing, so the
   * mover holds position instead of sliding the body through it. Optional —
   * drivers with no transitions can omit it. */
  isTransitioning?(): boolean;
}

export interface AnimatedCharacter {
  root: THREE.Object3D;
  /** Where the character's feet should be on the floor (xz). */
  groundPos: THREE.Vector2;
  /** Current facing in radians around Y. Three.js convention with our
   * models: 0 = facing -Z, π/2 = facing +X, π = facing +Z, -π/2 = facing
   * -X. To face a motion vector (dx, dz) use Math.atan2(dx, -dz). */
  facingY: number;
  /** What it's doing right now. */
  action: CharacterAction;
  /** Phase offset (seconds) so multiple characters don't sync. */
  phase: number;
  /** Optional: seat Y offset when action = sit (chair seat above floor). */
  seatHeight?: number;
  /** Present only for SKINNED characters (the rigged new guest). When set,
   * CharacterAnimator drives this mixer/controller from the action instead
   * of applying its procedural whole-body pose. Position/facing/visibility
   * still come from the animator, exactly like a static character. */
  skeletal?: SkeletalDriver;
  // Internal: cached base scale so breathing oscillates around it.
  _baseScale?: number;
  // Internal: cached "feet at floor" Y offset captured when the character
  // was added to the animator — preserves CharacterLoader.liftFeetToOrigin
  // through the per-frame position reset.
  _baseY?: number;
  /** Raw "lift the feet off the ground" offset, independent of any
   * storey-Y. Captured at add-time as (_baseY − homeFloor × STOREY)
   * for upper-floor staff, or simply _baseY for guests / ground-floor
   * staff. Movers compute world Y as currentFloor × STOREY + _feetLift
   * and update _baseY each frame so the animator's reset doesn't snap
   * the body back to its starting storey. */
  _feetLift?: number;
  /** Phase 9.29 — "keep hidden for a non-floor reason" flag. Owners
   * that need a character invisible regardless of the focused storey
   * (e.g. ErrandRouter while a helper is off-map shopping) set this
   * instead of writing root.visible directly, so the animator stays the
   * single authority for visibility and ANDs floor-focus with this. */
  _keepHidden?: boolean;
}

export class CharacterAnimator {
  private readonly characters: AnimatedCharacter[] = [];
  private elapsed = 0;

  // Phase I (perf) — frustum culling so off-screen characters skip
  // the per-frame pose update.  Engine calls setCullCamera() once
  // after the camera is constructed.  When unset, the cull is a
  // no-op (every character ticks every frame, original behaviour).
  //
  // Scaling: at the iso angle + typical FOV, ~30-50 % of all spawned
  // characters are off-camera at any moment (pedestrians on the
  // far side of the city, customers inside other plots etc.).  Skipping
  // tickCharacter for them saves a switch statement + 3 trig calls +
  // a position/rotation/scale write per skipped character per frame.
  private cullCamera?: THREE.Camera;
  private worldRoot?: THREE.Object3D;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreenMatrix = new THREE.Matrix4();
  // Reused sphere — character ~1.5 m tall + ~0.4 m wide, so radius
  // 0.9 covers both well.  intersectsSphere (not containsPoint) so
  // a character with feet just below the frustum but head visible
  // still ticks.
  private readonly cullSphere = new THREE.Sphere(new THREE.Vector3(), 0.9);

  // Phase 9.29 — floor-focus body gate. When the player is looking at
  // one storey (interior view via the FloorSelector), characters on
  // OTHER storeys hide so the view only shows the customers + staff on
  // the floor being looked at. Mirrors StatusBubbles' floor filter and
  // WorldScene.applyStoreyVisibility (which already hides upper storey
  // GROUPS) — characters are parented to the always-visible scene/world
  // root, so without this they'd leak across floors even though their
  // bubbles + the surrounding geometry are correctly floor-gated.
  // Engine wires these once; unset = no gating (every character shows).
  getFocusedFloor?: () => number;
  getStoreyHeight?: () => number;
  /** True when zoomed out to the exterior building view, where every
   * floor should render (no per-storey focus). */
  isExteriorView?: () => boolean;

  /** Phase I (perf) — wire the camera + worldRoot so update() can
   * frustum-cull off-screen characters.  worldRoot is needed because
   * character roots are children of it, so c.root.position is in
   * worldRoot-local space; we add worldRoot.position to get the
   * world coord that the camera frustum is in. */
  setCullCamera(camera: THREE.Camera, worldRoot: THREE.Object3D): void {
    this.cullCamera = camera;
    this.worldRoot = worldRoot;
  }

  add(c: AnimatedCharacter): void {
    c._baseScale = c.root.scale.x; // assume uniform scale
    c.phase = c.phase ?? Math.random() * 100;
    // Capture the "feet at floor" Y offset that CharacterLoader.liftFeetToOrigin
    // set on the root. The per-frame position reset below restores this Y,
    // not 0 — otherwise characters end up sunk into the floor by half their
    // bbox height.
    c._baseY = c.root.position.y;
    this.characters.push(c);
  }

  remove(root: THREE.Object3D): void {
    const i = this.characters.findIndex((c) => c.root === root);
    if (i >= 0) this.characters.splice(i, 1);
  }

  update(dt: number): void {
    this.elapsed += dt;
    // Phase I (perf) — recompute the frustum from the camera's
    // current projection × inverse-world matrix.  Three.js does
    // this once per render anyway; we duplicate the work here so
    // the cull decision uses the SAME frustum the renderer will
    // use moments later.  Sub-millisecond per frame.
    const cull = this.cullCamera && this.worldRoot;
    let wx = 0, wy = 0, wz = 0;
    if (cull) {
      this.cullCamera!.updateMatrixWorld();
      this.projScreenMatrix.multiplyMatrices(
        this.cullCamera!.projectionMatrix,
        this.cullCamera!.matrixWorldInverse,
      );
      this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
      wx = this.worldRoot!.position.x;
      wy = this.worldRoot!.position.y;
      wz = this.worldRoot!.position.z;
    }
    // Phase 9.29 — resolve the floor-focus gate once per frame. When an
    // interior storey is focused, `gateFloor` is that storey and any
    // character whose rounded floor differs is hidden below. Exterior
    // view (or unwired hooks) leaves gateFloor undefined → show all.
    const gateStoreyH = this.getStoreyHeight?.() ?? 3;
    const gateFloor = this.isExteriorView?.() ? undefined : this.getFocusedFloor?.();
    for (const c of this.characters) {
      // CRITICAL: ALWAYS sync root.position from groundPos BEFORE
      // the cull decision.  Three.js does its own frustum cull at
      // GPU-draw time using root.position; if root.position is
      // stale (because the previous frame skipped tickCharacter
      // for being off-frustum, or because the character was just
      // added and has never been ticked), three.js culls them at
      // their stale spot — which for a fresh spawn is the model's
      // (0, baseY, 0) origin in the kitchen, making everyone
      // "blob together" there.
      //
      // This is the cheap part of tickCharacter — three Vector3
      // writes per character, ~0.5 µs at N=50.  The expensive part
      // (breathing math, per-action switch + trig) is what we
      // actually skip via the cull below.
      const baseY = c._baseY ?? 0;
      c.root.position.set(c.groundPos.x, baseY, c.groundPos.y);
      c.root.rotation.set(0, c.facingY, 0);

      // Phase 9.29 — floor-focus body gate. A character is visible only
      // when it's on the focused storey (same maths as the status-bubble
      // filter) AND no owner has flagged it _keepHidden for a non-floor
      // reason (e.g. an errand helper off-map shopping). The animator is
      // the single writer of root.visible so those two conditions AND
      // cleanly instead of two systems fighting over the boolean.
      // Skipping the pose tick for hidden characters also reclaims the
      // work the cull would have done. A character mid-stair rounds
      // toward the nearer slab, so they pop in/out at the half-way point
      // — acceptable for a brief transit, and matches their bubble.
      const offFloor = gateFloor !== undefined && Math.round(baseY / gateStoreyH) !== gateFloor;
      if (offFloor || c._keepHidden) {
        if (c.root.visible) c.root.visible = false;
        continue;
      }
      if (!c.root.visible) c.root.visible = true;

      // Skinned guests must keep their mixer advancing on EVERY visible
      // frame, so they are handled BEFORE the frustum cull. The cull below
      // skips the per-frame pose for off-frustum characters — harmless for a
      // static mesh (it just holds its sculpted pose) but fatal for a skinned
      // one, which then freezes at mixer time 0 = its BIND POSE (the arms-out
      // T-pose). Skinned guests are a small minority (customers in/near the
      // restaurant), so we skip the cull for them and always tick. This also
      // sidesteps the cull sphere being mis-placed for reparented upper-floor
      // characters: it is centred on `baseY`, which is 0 for a skinned guest,
      // so the sphere sits at ground level even when the body renders a storey
      // up — that false-cull is exactly what froze on-screen skinned guests in
      // a T-pose when the camera focused the upper floor.
      if (c.skeletal) {
        // Tall seats (bar stools) sit higher than the rigged sit clip is
        // authored for, so without a lift a seated guest sinks below the
        // stool. seatHeight is 0 for a normal chair (the clip already lands
        // right) and the bar-stool lift for a bar seat; apply it only while
        // actually seated. root.position.y was set to baseY above; procedural
        // guests get the equivalent via the "sit" case in tickCharacter, which
        // the skeletal path skips.
        if (c.action === "sit" && c.seatHeight) c.root.position.y += c.seatHeight;
        c.skeletal.update(dt, c.action);
        continue;
      }

      if (cull) {
        // Sphere centred on the character's torso (groundPos + ~0.45 m
        // up the body) so a tall character isn't false-culled when
        // their feet are below the bottom plane.
        this.cullSphere.center.set(
          c.groundPos.x + wx,
          baseY + wy + 0.45,
          c.groundPos.y + wz,
        );
        if (!this.frustum.intersectsSphere(this.cullSphere)) continue;
      }
      this.tickCharacter(c);
    }
  }

  private tickCharacter(c: AnimatedCharacter): void {
    const t = this.elapsed + (c.phase ?? 0);
    const base = c._baseScale ?? 1;

    // Always-on subtle "breathing" — slightly oscillate vertical scale.
    const breath = 1 + Math.sin(t * 1.6) * 0.012;
    c.root.scale.set(base, base * breath, base);

    // Reset to neutral pose, then apply the action's transforms. Use the
    // cached _baseY (feet-at-floor offset from CharacterLoader) so the
    // characters don't sink half-way into the ground.
    const baseY = c._baseY ?? 0;
    c.root.position.set(c.groundPos.x, baseY, c.groundPos.y);
    c.root.rotation.set(0, c.facingY, 0);

    switch (c.action) {
      case "idle": {
        // Tiny lateral sway so they don't look completely frozen.
        c.root.rotation.y += Math.sin(t * 0.9) * 0.04;
        break;
      }
      case "walk": {
        // Bigger bob + lean than before — kitchen walks are short and we
        // need them to read instantly. Reads as footstep cadence.
        const bob = Math.abs(Math.sin(t * 6.5)) * 0.16;
        c.root.position.y += bob;
        c.root.rotation.z = Math.sin(t * 6.5) * 0.11;
        // Slight forward lean so they look purposeful, not strolling.
        c.root.rotation.x = 0.05;
        break;
      }
      case "carry": {
        // Cooking / carrying pose. Subtle forward lean with slight
        // breathing-rate variation — reads as "leaning over the stove"
        // or "holding a tray with focus". No bob: feet stay planted on
        // the ground. Used to bob + sway heavily and looked like the
        // chef was riding a pogo stick.
        c.root.rotation.x = 0.09 + Math.sin(t * 1.4) * 0.02;
        c.root.rotation.z = Math.sin(t * 1.1) * 0.015;
        break;
      }
      case "sit": {
        // Drop to seat height and tilt forward slightly to suggest the
        // hip bend. Static — no oscillation while seated.
        //
        // Floor-aware: the slab the character is sitting on lives at
        // _baseY - _feetLift (the multi-floor movers maintain _baseY =
        // currentFloor * STOREY + _feetLift). Adding seatHeight onto
        // that puts a Floor 1 seated guest at world y ≈ 3 + 0.45 =
        // 3.45 instead of the old 0.45 (which dropped them straight
        // through Floor 1's slab onto the ground floor).
        const slabY = (c._baseY ?? 0) - (c._feetLift ?? 0);
        c.root.position.y = slabY + (c.seatHeight ?? 0.45);
        c.root.rotation.x = 0.18;
        // Subtle hand/torso shift over time so they don't look completely
        // frozen (small azimuth wobble).
        c.root.rotation.y += Math.sin(t * 0.5) * 0.03;
        break;
      }
    }
  }
}
