import * as THREE from "three";

/**
 * Orthographic camera with an isometric-style angle. Keeps the iso/Stardew
 * feel of the 2D game while letting us rotate the view freely and pan/zoom.
 *
 * Standard iso angles: 30° down from horizontal, 45° around vertical.
 *
 * Zoom range is very wide (1.5 → 200 world-unit half-heights) so the
 * player can either pull in tight on a single seat OR pull all the way
 * out to scan the entire city map for plots / other players' buildings.
 * The UI's CameraControls reads MIN_ZOOM / MAX_ZOOM to draw a percentage.
 */
export class IsoCamera {
  /** Tightest zoom — half-view shows ~3 world units (one chair). */
  static readonly MIN_ZOOM = 1.5;
  /** Loosest zoom — half-view shows ~400 world units (whole city + buffer). */
  static readonly MAX_ZOOM = 200;
  /** Default zoom on game start — comfortable mid-iso view of the restaurant. */
  static readonly DEFAULT_ZOOM = 12;
  /** Default azimuth angle (45° = classic iso facing northeast). */
  static readonly DEFAULT_AZIMUTH = Math.PI / 4;

  readonly threeCamera: THREE.OrthographicCamera;
  private target = new THREE.Vector3(0, 0, 0);
  private zoom = IsoCamera.DEFAULT_ZOOM; // half-height of view in world units
  private azimuth = IsoCamera.DEFAULT_AZIMUTH; // 45°
  private elevation = Math.atan(1 / Math.SQRT2); // ~35.26°, true iso

  private dragging = false;
  private dragLastX = 0;
  private dragLastY = 0;

  // Floor-focus tween: when the player presses a floor button on the
  // FloorSelector the camera glides its look-at target up/down to the
  // matching storey instead of snapping. We blend `target.y` from the
  // current value toward `tweenEndY` over `tweenDur` real seconds.
  private tweenStartY = 0;
  private tweenEndY = 0;
  private tweenElapsed = 0;
  private tweenDur = 0;

  /** Vertical asymmetry on the orthographic frustum. Top and bottom
   * extend (zoom × TOP_FRAC) and (zoom × BOT_FRAC) above/below the
   * look-at target, respectively. With a symmetric (1, 1) frustum at
   * iso angle, half the viewport's rays project to BELOW Y=0 — the
   * camera "wastes" the entire bottom half of the screen on void
   * because there's no geometry below the ground. Biasing the
   * frustum upward (TOP > BOT) puts the target near the bottom of
   * the screen and frees the bulk of the viewport for world content
   * above the ground.  The 1.7/0.3 split positions the target 15%
   * from the bottom of the screen, which reads as a natural "looking
   * across the city toward the player" composition.  Total vertical
   * span (TOP + BOT) is still 2.0 so the wheel/zoom math doesn't
   * need to change. */
  private static readonly FRUSTUM_TOP_FRAC = 1.7;
  private static readonly FRUSTUM_BOT_FRAC = 0.3;

  constructor(viewW: number, viewH: number) {
    const aspect = viewW / viewH;
    this.threeCamera = new THREE.OrthographicCamera(
      -this.zoom * aspect, this.zoom * aspect,
      this.zoom * IsoCamera.FRUSTUM_TOP_FRAC,
      -this.zoom * IsoCamera.FRUSTUM_BOT_FRAC,
      0.1, 1000,
    );
    // Initial framing — center the world origin (the player's
    // restaurant) on the screen the same way the Home button does.
    // Without this the asymmetric frustum (target lands 15 % from
    // the bottom) put the building down in the lower strip on
    // first render, so the player saw a wide expanse of sky above
    // their restaurant on reload. Same XZ offset as goHome.
    this.setTargetCenteredOnScreen(0, 0, 0);
    this.updatePose();
  }

  /** Set the camera target so that (worldX, floorY, worldZ) lands
   * at the visual center of the screen, compensating for the
   * asymmetric frustum (TOP_FRAC/BOT_FRAC). The shift is
   * restricted to the XZ plane so target.y stays exactly on
   * `floorY` — important for FloorSelector semantics.
   *
   * Math: with TOP=1.7, BOT=0.3, the midpoint of the visible
   * frustum is at camera-space y = (TOP - BOT)/2 × zoom = 0.7 × zoom
   * above the look-at target. Shifting the target by S along the
   * world XZ component of camera_up makes the desired world point
   * appear at camera-space y = sin(elev) × S. Solve for S so that
   * = 0.7 × zoom → S = 0.7 × zoom / sin(elev), direction
   * (cos azimuth, 0, sin azimuth). */
  private setTargetCenteredOnScreen(worldX: number, floorY: number, worldZ: number): void {
    const verticalBias = (IsoCamera.FRUSTUM_TOP_FRAC - IsoCamera.FRUSTUM_BOT_FRAC) / 2 * this.zoom;
    const sinEl = Math.sin(this.elevation);
    const k = sinEl > 1e-3 ? verticalBias / sinEl : 0;
    this.target.x = worldX + k * Math.cos(this.azimuth);
    this.target.y = floorY;
    this.target.z = worldZ + k * Math.sin(this.azimuth);
  }

  /** Attach pointer + wheel handlers to the canvas for pan/zoom/rotate. */
  attachInputTo(el: HTMLElement): void {
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  resize(w: number, h: number): void {
    const aspect = w / h;
    this.threeCamera.left = -this.zoom * aspect;
    this.threeCamera.right = this.zoom * aspect;
    this.threeCamera.top = this.zoom * IsoCamera.FRUSTUM_TOP_FRAC;
    this.threeCamera.bottom = -this.zoom * IsoCamera.FRUSTUM_BOT_FRAC;
    this.threeCamera.updateProjectionMatrix();
  }

  update(dt: number): void {
    // Drive the floor-focus tween if one is running. Calling
    // `tweenTargetY` while a tween is mid-flight extends it from the
    // current eased position (we sample target.y at the new "start").
    if (this.tweenDur > 0) {
      this.tweenElapsed = Math.min(this.tweenElapsed + dt, this.tweenDur);
      const t = this.tweenElapsed / this.tweenDur;
      // Smoothstep ease for a gentle in/out — no overshoot so the camera
      // doesn't punch through the storey above/below the destination.
      const eased = t * t * (3 - 2 * t);
      this.target.y = this.tweenStartY + (this.tweenEndY - this.tweenStartY) * eased;
      this.updatePose();
      if (this.tweenElapsed >= this.tweenDur) {
        this.target.y = this.tweenEndY;
        this.tweenDur = 0;
        this.tweenElapsed = 0;
      }
    }
  }

  /** Smoothly glide the camera look-at target's Y to the requested
   * height over `durationSec` seconds. Pass 0 for an instant snap.
   * Called by FloorSelector when a new floor is picked — the X/Z
   * components of the target are left untouched so the player's pan
   * is preserved. */
  tweenTargetY(y: number, durationSec = 0.45): void {
    if (durationSec <= 0) {
      this.target.y = y;
      this.tweenDur = 0;
      this.updatePose();
      return;
    }
    this.tweenStartY = this.target.y;
    this.tweenEndY = y;
    this.tweenElapsed = 0;
    this.tweenDur = durationSec;
  }

  /** Read the look-at target's Y — used by FloorSelector to know
   * whether the camera is already at the requested floor. */
  getTargetY(): number {
    return this.target.y;
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Wheel zoom uses an exponential factor so each tick of the wheel
    // multiplies the zoom by a constant ratio — feels natural across
    // the full 1.5..200 range without the "stuck" feeling a linear
    // step gives at the far ends. Rate scaled up from the original
    // 0.0015 so a similar number of wheel ticks covers the wider
    // zoom range (~17 ticks min↔max instead of ~33).
    const factor = Math.exp(e.deltaY * 0.0030);
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, IsoCamera.MIN_ZOOM, IsoCamera.MAX_ZOOM);
    this.resize(window.innerWidth, window.innerHeight);
    // Zoom can force a steeper elevation via the minElevForNoVoid
    // floor — recompute camera position so the angle catches up.
    this.updatePose();
  };

  // ─── Public read-only accessors for the on-screen CameraControls ───
  // The HUD's CameraControls widget reads these every frame to draw the
  // zoom percent + a cardinal-direction rotation indicator. They never
  // mutate state, so they're cheap to poll.

  /** Current zoom (half-view height in world units). */
  getZoom(): number {
    return this.zoom;
  }

  /**
   * Zoom expressed as a 0..1 value where 0 = MAX_ZOOM (most pulled
   * out) and 1 = MIN_ZOOM (most zoomed in). Used by the UI to render
   * a slider-style "100% / 30% / 5%" readout that increases as the
   * player zooms IN — which is the mental model most players have.
   */
  getZoomPercent(): number {
    // Log-scale so the percentage moves linearly with wheel ticks
    // (which are also exponential). Otherwise 90% of the slider would
    // be crammed into the lower half of the zoom range.
    const t = Math.log(this.zoom / IsoCamera.MIN_ZOOM) /
              Math.log(IsoCamera.MAX_ZOOM / IsoCamera.MIN_ZOOM);
    return 1 - THREE.MathUtils.clamp(t, 0, 1);
  }

  /** Current azimuth in radians, normalised to [0, 2π). */
  getAzimuth(): number {
    const two = Math.PI * 2;
    return ((this.azimuth % two) + two) % two;
  }

  /** Azimuth in degrees [0, 360). */
  getAzimuthDegrees(): number {
    return (this.getAzimuth() * 180) / Math.PI;
  }

  /**
   * Compass-style cardinal label for the camera's "forward" axis. The
   * isometric camera looks toward the origin from the +X/+Z quadrant
   * at azimuth = π/4, so the on-screen "up" direction roughly aligns
   * with -X / -Z (north-west-ish). We map azimuth to one of 8 cardinal
   * sectors based on which world direction is at the top of the screen.
   */
  getCardinalLabel(): string {
    // Top-of-screen world direction = -(cos(az), sin(az)). Convert to
    // a compass bearing where 0° = N, increasing clockwise.
    const az = this.getAzimuth();
    // The default azimuth (π/4 = 45°) reads as North on the on-screen
    // compass — that's the orientation players grew up with from the
    // legacy iso build. So we offset by -π/4 and invert.
    const bearing = ((-(az - IsoCamera.DEFAULT_AZIMUTH) * 180) / Math.PI + 360) % 360;
    const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const idx = Math.round(bearing / 45) % 8;
    return labels[idx];
  }

  // ─── Public mutators for the CameraControls buttons ────────────────

  /** Multiply the zoom by `factor` (clamped). Used by zoom buttons:
   * factor < 1 zooms IN (smaller half-view), factor > 1 zooms OUT. */
  zoomBy(factor: number): void {
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, IsoCamera.MIN_ZOOM, IsoCamera.MAX_ZOOM);
    this.resize(window.innerWidth, window.innerHeight);
    this.updatePose();
  }

  /** Snap the zoom to its default starting value. */
  resetZoom(): void {
    this.zoom = IsoCamera.DEFAULT_ZOOM;
    this.resize(window.innerWidth, window.innerHeight);
    this.updatePose();
  }

  /** Rotate the camera around the vertical axis by `deltaRad` radians.
   * Positive = counter-clockwise (compass east → north). */
  rotateBy(deltaRad: number): void {
    this.azimuth += deltaRad;
    this.updatePose();
  }

  /** Snap the rotation back to the default 45° iso azimuth. */
  resetRotation(): void {
    this.azimuth = IsoCamera.DEFAULT_AZIMUTH;
    this.updatePose();
  }

  /** Instantly set the look-at target's X / Z (preserves Y so the
   * player's current floor focus survives the move). */
  setTargetXZ(x: number, z: number): void {
    this.target.x = x;
    this.target.z = z;
    this.updatePose();
  }

  /** Read the look-at target's world (X, Z). Used by Engine to
   * snapshot the camera state before entering visit mode so it can
   * restore on exit. */
  getTargetXZ(): { x: number; z: number } {
    return { x: this.target.x, z: this.target.z };
  }

  /** Instantly set the camera zoom (clamped to [MIN_ZOOM, MAX_ZOOM])
   * and re-apply the projection. Used by visit mode to drop the
   * camera to a "look at this plot" zoom without a wheel ramp. */
  setZoom(z: number): void {
    this.zoom = THREE.MathUtils.clamp(z, IsoCamera.MIN_ZOOM, IsoCamera.MAX_ZOOM);
    this.resize(window.innerWidth, window.innerHeight);
    this.updatePose();
  }

  /** Instantly set the azimuth (rotation around Y). Used by visit
   * mode so the visited plot is shown at the default iso angle even
   * if the player had rotated their own view. */
  setAzimuth(rad: number): void {
    this.azimuth = rad;
    this.updatePose();
  }

  /** Reset target to (x, floorY, z), restore default zoom, restore
   * default azimuth + iso elevation. The caller passes floorY so the
   * floor selection is respected explicitly — previously we just left
   * target.y untouched, but the left-drag pan bug could push y to
   * weird values, and "preserve current y" then carried that garbage
   * forward. Now Home always snaps y to a known floor height. Used
   * by the CameraControls Home button.
   *
   * Centers (x, floorY, z) on the SCREEN, not on the look-at axis.
   * The asymmetric frustum (TOP_FRAC=1.7, BOT_FRAC=0.3) means the
   * raw look-at target lands ~15% from the bottom of the screen, so
   * a naive `target = (x, floorY, z)` puts the player's building
   * down in the lower strip. We compensate by sliding the target in
   * the XZ plane along the camera-up projection so the building lands
   * at the visual midpoint while target.y stays on the chosen floor
   * (preserves FloorSelector semantics — switching floors only moves
   * target.y, the centered-offset on X/Z carries over). */
  goHome(x: number, z: number, floorY: number): void {
    this.zoom = IsoCamera.DEFAULT_ZOOM;
    this.azimuth = IsoCamera.DEFAULT_AZIMUTH;
    this.elevation = Math.atan(1 / Math.SQRT2); // ~35.26°, the constructor default
    // Use the shared centering helper so Home and the initial
    // page-load framing always match. See setTargetCenteredOnScreen
    // for the math derivation.
    this.setTargetCenteredOnScreen(x, floorY, z);
    // Cancel any in-flight floor tween so the snap actually sticks.
    this.tweenDur = 0;
    this.resize(window.innerWidth, window.innerHeight);
    this.updatePose();
  }

  private dragButton = 0; // which mouse button started the drag
  private dragMoved = 0;  // total px moved during this drag

  private onPointerDown = (e: PointerEvent): void => {
    // Left = pan, Right = rotate, Middle = rotate.
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      this.dragging = true;
      this.dragButton = e.button;
      this.dragMoved = 0;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragLastX;
    const dy = e.clientY - this.dragLastY;
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;
    this.dragMoved += Math.abs(dx) + Math.abs(dy);

    if (this.dragButton === 2 || this.dragButton === 1 || e.shiftKey) {
      // Right / middle / Shift+left = rotate.
      this.azimuth -= dx * 0.005;
      // The user can tilt down to π/8 (22.5°) for close-up shots;
      // the per-frame auto-elevation floor in updatePose() then
      // raises the EFFECTIVE elevation back up as needed when the
      // player zooms out, so void can't reappear at low manual
      // angles + wide zoom.
      this.elevation = THREE.MathUtils.clamp(this.elevation - dy * 0.005, Math.PI / 8, Math.PI / 2 - 0.05);
    } else {
      // Plain left-drag = pan. The camera's local +Y axis has a non-
      // zero world-Y component at iso angle, so naively panning along
      // it drifts target.y every vertical drag — over a couple of pans
      // the camera ends up looking up at sky or down at void. Pan in
      // the GROUND plane (XZ) only: project camera-right and camera-up
      // onto Y=0, renormalise, and use those as the screen-right /
      // screen-up directions for the pan delta. target.y stays put,
      // so the floor selection survives any amount of dragging.
      const panScale = this.zoom * 0.0025;
      const right = new THREE.Vector3().setFromMatrixColumn(this.threeCamera.matrix, 0);
      right.y = 0;
      if (right.lengthSq() > 1e-6) right.normalize();
      const screenUp = new THREE.Vector3().setFromMatrixColumn(this.threeCamera.matrix, 1);
      screenUp.y = 0;
      if (screenUp.lengthSq() > 1e-6) screenUp.normalize();
      this.target.addScaledVector(right, -dx * panScale);
      this.target.addScaledVector(screenUp, dy * panScale);
    }
    this.updatePose();
  };

  /** Returns true if the most recent drag was a true drag (moved more
   * than ~6 px) — used by BuildMenu to suppress the place-click. */
  wasDragging(): boolean {
    return this.dragMoved > 6;
  }

  private onPointerUp = (_e: PointerEvent): void => {
    this.dragging = false;
  };

  /** Minimum elevation that keeps the bottom-of-screen ray pointing
   * at or above the ground plane (Y=0) for the current zoom. Derived
   * from the asymmetric frustum geometry:
   *   bottom ray start Y = r·sin(elev) − bot_frac·zoom·cos(elev)
   * We need that > 0 → tan(elev) > bot_frac·zoom / r.
   * As the player zooms out (zoom rises), the required elevation
   * climbs — at max zoom (200) we need ~63° to look near-straight
   * down. Returns the bare angle; updatePose adds a small safety
   * margin on top so the bottom isn't exactly at the horizon. */
  private minElevForNoVoid(): number {
    const r = 30;
    const ratio = (IsoCamera.FRUSTUM_BOT_FRAC * this.zoom) / r;
    return Math.atan(ratio);
  }

  private updatePose(): void {
    const r = 30;
    // Use the steeper of (a) the user's manual elevation and (b) the
    // minimum elevation that the current zoom requires to keep the
    // bottom of the screen on the ground. At default zoom the user's
    // setting wins; as they zoom out, the floor kicks in and tilts the
    // camera toward straight-down so void never appears.
    const minSafe = this.minElevForNoVoid() + Math.PI / 36; // +5° safety
    const effectiveElev = Math.max(this.elevation, Math.min(Math.PI / 2 - 0.05, minSafe));
    const x = r * Math.cos(effectiveElev) * Math.cos(this.azimuth);
    const z = r * Math.cos(effectiveElev) * Math.sin(this.azimuth);
    const y = r * Math.sin(effectiveElev);
    this.threeCamera.position.set(this.target.x + x, this.target.y + y, this.target.z + z);
    this.threeCamera.lookAt(this.target);
    this.threeCamera.up.set(0, 1, 0);
  }
}
