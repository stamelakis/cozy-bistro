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
  /** `speed` (m/s, optional) scales the walk clip's playback so the stride
   * matches the ground travel — no foot-skating / moon-walking. */
  update(dt: number, action: CharacterAction, speed?: number): void;
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
  /** Internal: previous-frame groundPos, so the animator can tell whether a
   * character actually MOVED and gate the walk clip — a stuck "walk" staffer
   * (the server says "working", but it can't reach its target) otherwise
   * moonwalks in place against the furniture. */
  _animPrevX?: number;
  _animPrevZ?: number;
  /** Phase M.21 — smoothed ground speed (m/s), and how long the body has been
   * essentially still (ms). The walk clip's playback rate is scaled by _speed
   * so the stride matches the travel (no skating), and the walk→idle gate waits
   * out _stillMs so a brief position stall between 2 Hz server ticks doesn't
   * flip to idle and restart the walk cycle ("momentary glitch"). */
  _speed?: number;
  _stillMs?: number;
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
  /** Phase M.17 — true while the actor is actively climbing a flight (mirrors
   * the server on_stair flag). Exempts the character from the floor-focus gate
   * so the WHOLE climb stays visible, instead of vanishing at the midpoint when
   * its height crosses into the upper storey's bucket ("goes halfway up then
   * disappears"). */
  _onStair?: boolean;
  /** Phase M.19 — last body opacity the animator applied [0,1]. Lets the
   * stair-fade skip re-traversing a character whose opacity hasn't changed. */
  _opacity?: number;
  /** Phase M.19 — set once the character's GLB materials have been cloned into
   * per-instance copies (so fading THIS body doesn't fade every other guest
   * sharing the model's materials — SkeletonUtils.clone shares them). Only a
   * character that has actually faded (climbed a stair) ever pays this. */
  _matCloned?: boolean;
}

/** Phase M.19/M.20 — stair-fade band, in storeys of feet-height above the
 * focused floor. A climbing body is fully opaque until it's STAIR_FADE_START up
 * the flight, then dissolves LINEARLY, fully gone by STAIR_FADE_END. The fade
 * MUST finish before the top (END < 1): the whole climb happens in the focused
 * floor's always-visible mount, but at the top landing the body reparents into
 * the upper storey's GROUP, which is hidden while this floor is focused — so a
 * fade tail past the top can't render. A flight takes ~2 s to climb (sqrt(10)
 * units at walk speed), so this band is a steady, clearly-visible ~1.4 s
 * dissolve. LINEAR, not eased — a smoothstep compressed the perceptible drop
 * into a blink near the middle ("too fast to notice"). Symmetric below, so a
 * body descending into the focused floor fades back in. */
const STAIR_FADE_START = 0.3;
const STAIR_FADE_END = 0.95;

/** Phase M.21 — walk-animation smoothing. Server pushes body positions at 2 Hz;
 * the client interpolates, but a late tick briefly stalls the body. WALK_STILL_SQ
 * is the per-frame travel² below which the body counts as "not moving"; the
 * walk→idle switch only fires after WALK_IDLE_GRACE_MS of continuous stillness,
 * so an inter-tick stall doesn't flip to idle and reset the walk cycle.
 * SPEED_SMOOTH_S is the EMA time-constant for the ground speed that drives the
 * walk clip's timeScale. */
const WALK_STILL_SQ = 0.000025; // (5 mm/frame)² — same threshold as before
const WALK_IDLE_GRACE_MS = 280;
const SPEED_SMOOTH_S = 0.12;

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

  /** Phase M.6 — is any live character within `radius` metres of world
   * (x, z) on `floor`? The entrance-door proximity check uses this so the
   * door opens for SERVER-driven guests + staff, which are rendered here
   * but no longer live in the client spawner/router lists that the old
   * check read (so the door had stopped opening for real customers).
   * Floor-gated via _baseY so an upper-storey character directly above the
   * door doesn't trigger it. */
  anyNear(x: number, z: number, radius: number, floor: number, storeyHeight: number): boolean {
    const rSq = radius * radius;
    const h = storeyHeight > 0 ? storeyHeight : 3;
    for (const c of this.characters) {
      if (c._keepHidden) continue;
      if (Math.round((c._baseY ?? 0) / h) !== floor) continue;
      const dx = c.groundPos.x - x;
      const dz = c.groundPos.y - z;
      if (dx * dx + dz * dz <= rSq) return true;
    }
    return false;
  }

  /** Phase M.31 — ground positions + storey of every rendered (non-hidden,
   * non-seated) character. The per-door proximity check in Engine reads this so
   * doors respond to the ACTUAL rendered actors under the server-driven cutover
   * (the local spawner/router lists it used to read are empty then). Seated
   * actors are skipped — they're parked by intent and shouldn't flap a door. */
  snapshotPositions(): { x: number; z: number; floor: number }[] {
    const h = this.getStoreyHeight?.() ?? 3;
    const out: { x: number; z: number; floor: number }[] = [];
    for (const c of this.characters) {
      if (c._keepHidden) continue;
      if (c.action === "sit") continue;
      out.push({ x: c.groundPos.x, z: c.groundPos.y, floor: Math.round((c._baseY ?? 0) / h) });
    }
    return out;
  }

  /** Phase M.19 — set a character's whole-body opacity [0,1] for the stair
   * fade. The first time a body actually fades, its GLB materials are cloned
   * into per-instance copies — SkeletonUtils.clone SHARES materials across
   * every guest of the same model, so mutating a shared material would fade
   * them all. Skips the work when opacity is unchanged, and only flips the
   * `transparent` flag (a shader recompile) at the fade's start/end, never
   * per-frame — the intermediate frames just tween `opacity`. */
  private applyCharacterOpacity(c: AnimatedCharacter, opacity: number): void {
    const o = Math.max(0, Math.min(1, opacity));
    const prev = c._opacity ?? 1;
    if (prev === o) return;
    // A never-faded body being (re)set to opaque needs nothing — its shared
    // materials are already opaque; don't clone them just to write opacity=1.
    if (o >= 1 && !c._matCloned) { c._opacity = 1; return; }
    if (!c._matCloned) {
      c.root.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = Array.isArray(m.material)
          ? m.material.map((mm) => mm.clone())
          : (m.material as THREE.Material).clone();
      });
      c._matCloned = true;
    }
    const transparent = o < 1;
    const toggle = transparent !== (prev < 1);
    c.root.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mm of mats as THREE.Material[]) {
        mm.opacity = o;
        if (toggle) { mm.transparent = transparent; mm.needsUpdate = true; }
      }
    });
    c._opacity = o;
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
      // Movement gate for the walk clip. Compare groundPos to last frame: a
      // character with a stale action="walk" that ISN'T actually moving (the
      // server says "working" but it's stuck / idle in place) renders as
      // "idle" instead of moonwalking against the furniture. Only "walk" is
      // gated — carry / sit / cook poses are legitimately stationary. < ~5 mm
      // of travel/frame = stationary; real walking moves far more at any sane
      // framerate (>=2 cm/frame even at 144 fps), so it's never mis-gated.
      // Tracked for every character (even hidden) so re-showing doesn't jump.
      const prevX = c._animPrevX ?? c.groundPos.x;
      const prevZ = c._animPrevZ ?? c.groundPos.y;
      const movedSq = (c.groundPos.x - prevX) ** 2 + (c.groundPos.y - prevZ) ** 2;
      c._animPrevX = c.groundPos.x;
      c._animPrevZ = c.groundPos.y;
      // Phase M.21 — smoothed ground speed (drives the walk clip's playback rate
      // so the stride matches the travel) + a stillness timer with hysteresis.
      const instSpeed = dt > 0 ? Math.sqrt(movedSq) / dt : 0;
      c._speed = (c._speed ?? instSpeed)
        + (instSpeed - (c._speed ?? instSpeed)) * Math.min(1, dt / SPEED_SMOOTH_S);
      if (movedSq < WALK_STILL_SQ) c._stillMs = (c._stillMs ?? 0) + dt * 1000;
      else c._stillMs = 0;
      // Only fall back to "idle" once the body has been still for a sustained
      // stretch — a brief stall between 2 Hz server ticks keeps playing "walk"
      // (previously it flipped every stall, reset()-ing the walk cycle → the
      // "restart the animation / momentary glitch" the player saw).
      // Two symmetric corrections, both gated on the stillness timer:
      //   walk that ISN'T moving  → idle (stale "walk", already handled)
      //   sit  that IS   moving   → walk
      // The second fixes the "sitting at the sink": a guest returning from the
      // handwash sink is flipped to a seated table-state server-side BEFORE it
      // reaches the chair (the return walk is the client's job), so without this
      // it slides home in a sitting pose. Any sit-pose body that's travelling
      // renders as walking until it parks (≥ grace), then sits.
      const effAction: CharacterAction =
        c.action === "walk" && (c._stillMs ?? 0) >= WALK_IDLE_GRACE_MS ? "idle"
        : c.action === "sit" && (c._stillMs ?? WALK_IDLE_GRACE_MS) < WALK_IDLE_GRACE_MS ? "walk"
        : c.action;
      c.root.position.set(c.groundPos.x, baseY, c.groundPos.y);
      c.root.rotation.set(0, c.facingY, 0);
      // SEATED YAW CORRECTION (rigged): the "Sitting_Idle" Mixamo clip is
      // authored a quarter-turn off the walk clip, so a seated guest whose
      // facingY correctly points at their table still RENDERS 90° sideways.
      // Verified via server data: seat_facing_y points AT the table, yet seated
      // bodies read sideways while WALKERS (identical facingY→rotation path)
      // read correctly — so it's the sit clip's orientation, not the facing.
      // Rotate the seated body back a quarter turn. TUNABLE: if seated guests
      // end up facing the OTHER sideways, negate this.
      if (effAction === "sit") c.root.rotation.y += Math.PI / 2;

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
      // Phase M.17 — a climbing body stays visible through the WHOLE flight
      // (exempt from the hard floor-focus gate, which would otherwise pop it out
      // at the half-way point as baseY crossed into the upper storey's bucket).
      // Phase M.19/M.20 — and rather than popping at the top, it DISSOLVES: a
      // linear opacity ramp over STAIR_FADE_START..END of the flight (in storeys
      // above the focused slab) as the body passes up through the ceiling, fully
      // gone JUST BEFORE the top. The whole fade runs while the body is still in
      // the focused floor's always-visible mount; at the landing it reparents
      // into the upper storey's group (hidden while this floor is focused), so
      // the ramp deliberately finishes before then. Symmetric below → a body
      // descending into view fades back in. Non-climbing characters keep the
      // instant hard 0/1 gate, so opacity/material work only touches climbers.
      let bodyFade = 1;
      let show: boolean;
      if (c._keepHidden) {
        show = false;
      } else if (gateFloor === undefined) {
        show = true;                    // exterior view — every floor renders
      } else if (c._onStair) {
        // Feet-height above the focused slab, in storeys (0 = on it, 1 = a full
        // storey up at the ceiling it exits through).
        const rel = Math.abs(baseY / gateStoreyH - gateFloor);
        bodyFade = 1 - Math.max(0, Math.min(1,
          (rel - STAIR_FADE_START) / (STAIR_FADE_END - STAIR_FADE_START)));
        show = bodyFade > 0.02;
      } else {
        show = Math.round(baseY / gateStoreyH) === gateFloor;
      }
      if (!show) {
        if (c.root.visible) c.root.visible = false;
        // Phase M.2 — a hidden SKINNED character keeps advancing its mixer
        // + sit/stand phase machine so it tracks the server action while
        // off-screen. Without this the rigged controller freezes at its
        // last pose (phase "up"), and every guest that arrived + sat on an
        // unfocused floor snaps through the stand→sit transition ALL AT
        // ONCE the moment the player switches to that floor. Keeping the
        // mixer alive means a guest that sat off-screen is already in the
        // seated loop on reveal. Static meshes hold their sculpted pose, so
        // they need nothing here. This is CPU-only while hidden
        // (root.visible=false → three.js skips the GPU skinning/draw), and
        // skinned characters are a bounded minority (customers + staff in
        // the restaurant), so the per-frame cost is small.
        if (c.skeletal) c.skeletal.update(dt, effAction, c._speed);
        continue;
      }
      if (!c.root.visible) c.root.visible = true;
      // Phase M.19 — apply the stair dissolve, or restore full opacity for a
      // body that faded on a previous climb (matCloned). A never-faded, fully
      // opaque character skips this entirely — zero cost on the common path.
      if (c._matCloned || bodyFade < 1) this.applyCharacterOpacity(c, bodyFade);

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
        c.skeletal.update(dt, effAction, c._speed);
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
