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
    for (const c of this.characters) {
      if (cull) {
        // Sphere centred on the character's head (groundPos + ~0.9 m
        // up the body) so a tall character isn't false-culled when
        // their feet are below the bottom plane.
        const baseY = c._baseY ?? 0;
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
