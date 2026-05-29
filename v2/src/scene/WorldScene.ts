import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { ModelLoader } from "../assets/ModelLoader";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { CharacterAnimator, type AnimatedCharacter, type CharacterAction } from "./CharacterAnimator";
import { fitFurniture } from "../assets/fitFurniture";

/** Linearly interpolate between two RGB integers by t in [0,1]. */
function mixColors(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * The 3D world. A minimal demo restaurant: floor, walls, and a few pieces
 * of Kenney furniture placed at fixed positions so we can verify the GLTF
 * loader and confirm the overall scene reads as "restaurant".
 *
 * Phase 3+ will replace the hard-coded placements with a proper
 * grid-driven building system that mirrors the 2D game.
 */
/** Perimeter wall direction — picks which axis the wall runs along
 * (front / back are X-axis at z=±5.5; left / right are Z-axis at
 * x=±5.5 / -4.5) and which face of the box geometry is the outdoor
 * face when building the multi-material array. */
type WallDir = "front" | "back" | "left" | "right";

/** Live state for one perimeter wall. Walls are rebuilt as a stack of
 * segment + lintel + sill meshes around each door (full-height cut)
 * and window (sill + lintel partial cut). currentMat tracks whether
 * the wall is currently rendered solid (interior+exterior multi-mat)
 * or as the ghost see-through, so the camera-driven swap doesn't
 * thrash. */
interface PerimeterWallState {
  meshes: THREE.Mesh[];
  currentMat: "solid" | "ghost";
  doors: number[];
  windows: number[];
}

export class WorldScene {
  readonly threeScene = new THREE.Scene();
  readonly loader = new ModelLoader();
  readonly characterLoader = new CharacterLoader(this.loader);
  readonly animator = new CharacterAnimator();
  /** Exposed for StaffRouter to drive their state machines. Populated
   * asynchronously during populateCharacters — may be undefined for the
   * first frame or two while GLBs load. */
  chefChar?: AnimatedCharacter;
  waiterChar?: AnimatedCharacter;
  errandChar?: AnimatedCharacter;
  /** Per-station visual effects, keyed by furniture uid. Every cook
   * station gets a small group pinned to the top of its model;
   * Engine.update reconciles the map each frame via syncStationEffects,
   * then setActiveStations(uids) flips the per-station visibility based
   * on which chefs are actively working there. Each variant has its own
   * mesh / light layout and animation in update(dt):
   *  - gas stove   → orange flame + flicker
   *  - electric    → blue induction glow + flicker
   *  - toaster     → red coil glow on top, pulses while in use
   *  - coffee      → 3 white steam puffs rising in sequence
   *  - blender     → small wobble of the model's top accessory
   *  - microwave   → soft yellow inside-light glow (currently unused —
   *                  no recipe gates on microwave yet) */
  private stationEffects = new Map<string, {
    group: THREE.Group;
    variant: "gas" | "electric" | "toaster" | "coffee" | "blender" | "microwave";
    flameMesh?: THREE.Mesh;
    flameLight?: THREE.PointLight;
    // Steam puffs for coffee: each has a phase offset so they rise in
    // sequence rather than as a single blob.
    steamPuffs?: { mesh: THREE.Mesh; phase: number }[];
    // Wobble accessory for blender: a small disc that rotates + pulses.
    wobbleMesh?: THREE.Mesh;
  }>();
  private stationEffectPhase = 0;
  /** The hinged door panel (sub-object of the procedural front-door
   * group, exposed via userData.panel). Rotating this swings the door
   * around its hinge while the frame stays put. */
  private doorPanel?: THREE.Object3D;
  /** Door open amount [0,1] — lerps toward doorOpenTarget every frame. */
  private doorOpenAmount = 0;
  private doorOpenTarget = 0;
  /** World position of the stove and the plate-pickup spot. Used by the
   * StaffRouter to send chef/waiter to the right places. The chef stands
   * here (z=-3, one tile in front of the stove furniture) to "cook". */
  readonly stovePos = new THREE.Vector2(0, -3.0);
  readonly pickupPos = new THREE.Vector2(0.5, -2.8);
  /** The actual stove furniture's world position (z=-4, back wall). Used
   * to position the cooking flame ON the stove, not in front of where
   * the chef stands. */
  readonly stoveFurniturePos = new THREE.Vector2(0, -4);
  /** Where the errand helper drops off groceries when they return —
   * a small supply counter at the back-left of the room (see
   * buildSupplyCounter in addBuilding). */
  readonly supplyCounterPos = new THREE.Vector2(-3, -3.2);
  /** Front door world spot. Used both for the "anyone near door" check
   * (which swings the door open) and as the errand helper's entry/exit
   * waypoint — they walk through here on their way to the pavement
   * and again on the way back. */
  readonly doorPos = new THREE.Vector2(0, 5);
  /** Resolves once the staff characters are loaded — so Engine can build
   * the StaffRouter at the right moment. Created synchronously in the
   * constructor so any code that grabs the reference right after
   * `new WorldScene()` waits for the REAL load, not an already-resolved
   * sentinel. (We hit this exact bug — Engine's `.then(...)` was firing
   * on the resolved placeholder before chefChar/waiterChar even existed,
   * leaving the stub router active forever.) */
  staffReady!: Promise<void>;
  private resolveStaffReady!: () => void;
  /** Resolves once the demo restaurant furniture is in the scene — so
   * Engine can register every demo piece in the FurnitureRegistry and
   * therefore make them moveable / sellable like player-placed items.
   * Same constructor-init pattern as staffReady — see above. */
  demoReady!: Promise<void>;
  private resolveDemoReady!: () => void;
  /** Snapshot of the demo placements (id + cell + rotation + model)
   * filled in by populateDemoRestaurant. */
  readonly demoPlacements: { defId: string; x: number; z: number; rotY: number; model: THREE.Object3D }[] = [];

  constructor() {
    // Create the staff/demo "ready" promises SYNCHRONOUSLY here, before
    // any other code can grab a reference. The async populate functions
    // resolve them when their work is done. We used to lazily assign new
    // promises inside the async functions, which left any synchronous
    // consumer holding a permanently-resolved `Promise.resolve()` sentinel
    // — Engine then fired its staffReady.then(...) immediately, found no
    // chefChar/waiterChar yet, and pinned itself to the stub router.
    this.staffReady = new Promise((r) => { this.resolveStaffReady = r; });
    this.demoReady = new Promise((r) => { this.resolveDemoReady = r; });

    this.threeScene.fog = new THREE.Fog(0xd8c4a3, 30, 80);
    this.addLighting();
    this.addBuilding();
    // Per-station effects (flames, toaster glow, coffee steam, etc.)
    // are created lazily by syncStationEffects() once each station
    // is placed — no global state to set up here.
    void this.populateDemoRestaurant();
  }

  update(dt: number): void {
    this.animator.update(dt);
    // Per-station effect animation — dispatched by variant so a stove
    // flickers, a coffee machine puffs steam, a blender wobbles, etc.
    // Single phase drives them all so kitchen visuals feel synchronized.
    if (this.stationEffects.size > 0) {
      this.stationEffectPhase += dt;
      const flick = 0.85 + Math.sin(this.stationEffectPhase * 22) * 0.1 + Math.random() * 0.1;
      const flameLightInt = 1.6 + Math.sin(this.stationEffectPhase * 18) * 0.3;
      for (const e of this.stationEffects.values()) {
        if (!e.group.visible) continue;
        switch (e.variant) {
          case "gas":
          case "electric": {
            if (e.flameMesh) e.flameMesh.scale.setScalar(flick);
            if (e.flameLight) e.flameLight.intensity = flameLightInt;
            break;
          }
          case "toaster": {
            // Pulse the coil glow — slow breathing on top of the burner
            // colour so it reads as "heating" rather than just "on".
            if (e.flameMesh) {
              const mat = e.flameMesh.material as THREE.MeshStandardMaterial;
              if (mat && "emissiveIntensity" in mat) {
                mat.emissiveIntensity = 1.6 + Math.sin(this.stationEffectPhase * 7) * 0.6;
              }
            }
            if (e.flameLight) {
              e.flameLight.intensity = 0.6 + Math.sin(this.stationEffectPhase * 7) * 0.3;
            }
            break;
          }
          case "coffee": {
            // Steam puffs rise + fade + reset. Each puff has its own
            // phase offset so they leave the spout in sequence.
            if (e.steamPuffs) {
              for (const puff of e.steamPuffs) {
                puff.phase += dt * 0.8;
                if (puff.phase > 1) puff.phase -= 1;
                const p = puff.phase;
                puff.mesh.position.y = 0.1 + p * 0.45;
                puff.mesh.scale.setScalar(0.6 + p * 0.9);
                const mat = puff.mesh.material as THREE.MeshStandardMaterial;
                if (mat && "opacity" in mat) {
                  mat.opacity = Math.max(0, 0.55 * (1 - p));
                }
              }
            }
            break;
          }
          case "blender": {
            // Spin the accessory disc + a slight Y-bounce so the
            // model reads as actively blending.
            if (e.wobbleMesh) {
              e.wobbleMesh.rotation.y = this.stationEffectPhase * 14;
              e.wobbleMesh.position.y = 0.08 + Math.sin(this.stationEffectPhase * 24) * 0.015;
            }
            break;
          }
          case "microwave": {
            // Soft inside-light pulse — currently no recipe gates on
            // microwave but the effect is here so the system is
            // complete and players who pre-emptively buy one see it
            // light up if a chef ever uses it.
            if (e.flameLight) {
              e.flameLight.intensity = 0.5 + Math.sin(this.stationEffectPhase * 3) * 0.2;
            }
            break;
          }
        }
      }
    }
    // Lerp door open amount toward target and apply rotation to the
    // hinged panel only (the frame stays put).
    if (this.doorPanel) {
      const lerpSpeed = 3.0; // ~0.3s open/close
      const diff = this.doorOpenTarget - this.doorOpenAmount;
      const step = Math.sign(diff) * Math.min(Math.abs(diff), lerpSpeed * dt);
      this.doorOpenAmount += step;
      // Panel hinge swings -90° (opens inward). Negative because the hinge
      // is at the left edge and we want the right edge to swing into the room.
      this.doorPanel.rotation.y = -this.doorOpenAmount * Math.PI / 2;
    }
  }

  /** Tell the front door to open (true) or close (false). Engine calls
   * this every frame based on whether any character is near the door. */
  setDoorOpen(open: boolean): void {
    this.doorOpenTarget = open ? 1 : 0;
  }

  /** Re-capture the door panel reference from a freshly-loaded door
   * model. Needed when a save is restored: the demo's door (and its
   * panel) is removed from the scene, and the save's restored door
   * comes in without going through populateDemoRestaurant — so without
   * this call, setDoorOpen mutates an orphaned mesh and the door looks
   * stuck shut. */
  /** Per-doorway state for the placed `int-doorway` items — each one
   * is animated independently based on whether any character is
   * standing close to it. The panel ref is captured lazily from the
   * model's userData (same convention as the front door). */
  private internalDoorState = new Map<string, { panel: THREE.Object3D; openAmount: number }>();

  /** Reconcile the placed-interior-doorway list and animate each
   * panel toward the requested open / closed state. Engine calls
   * this once per frame after walking the registry — we don't poll
   * the registry from inside the scene because Engine already has a
   * cheap proximity test against guests + staff. */
  updateInternalDoors(doors: readonly { uid: string; model: THREE.Object3D; open: boolean }[], dt: number): void {
    const live = new Set<string>();
    for (const d of doors) {
      live.add(d.uid);
      let entry = this.internalDoorState.get(d.uid);
      if (!entry) {
        const panel = (d.model.userData as { panel?: THREE.Object3D }).panel;
        if (!panel) continue;
        entry = { panel, openAmount: 0 };
        this.internalDoorState.set(d.uid, entry);
      }
      const target = d.open ? 1 : 0;
      // Lerp toward the target. 6/sec means the door is open in ~0.17s
      // — feels snappy enough that the guest doesn't visibly clip it.
      const speed = 6;
      entry.openAmount += (target - entry.openAmount) * Math.min(1, dt * speed);
      entry.panel.rotation.y = -entry.openAmount * Math.PI / 2;
    }
    for (const uid of [...this.internalDoorState.keys()]) {
      if (!live.has(uid)) this.internalDoorState.delete(uid);
    }
  }

  attachDoorPanel(model: THREE.Object3D): void {
    const panel = model.userData?.panel as THREE.Object3D | undefined;
    if (panel) {
      this.doorPanel = panel;
      // Reset open state so the new panel doesn't snap to whatever
      // angle the previous one was at.
      this.doorOpenAmount = 0;
      this.doorOpenTarget = 0;
      panel.rotation.y = 0;
    }
  }

  /** Reconcile the per-station effect map with the registry's current
   * cook-station list. Engine calls this each frame; it builds the
   * right variant effect for every newly-placed station and removes
   * effects for stations that have been sold or moved. */
  syncStationEffects(stations: readonly { uid: string; defId: string; model: THREE.Object3D }[]): void {
    const live = new Set(stations.map((s) => s.uid));
    for (const uid of [...this.stationEffects.keys()]) {
      if (!live.has(uid)) {
        const f = this.stationEffects.get(uid)!;
        this.threeScene.remove(f.group);
        this.stationEffects.delete(uid);
      }
    }
    for (const s of stations) {
      if (this.stationEffects.has(s.uid)) {
        // Already have an effect for this station — but the model
        // might have been moved (move-mode) or its host repositioned
        // (surface placement). Refresh the world anchor.
        this.alignEffectToModel(this.stationEffects.get(s.uid)!.group, s.model);
        continue;
      }
      const effect = this.buildStationEffect(s.defId);
      if (!effect) continue;
      this.alignEffectToModel(effect.group, s.model);
      this.threeScene.add(effect.group);
      this.stationEffects.set(s.uid, effect);
    }
  }

  /** Flip per-station effect visibility. `uids` is the set of stations
   * with a chef ACTIVELY cooking (router.getCookingStoveUids()).
   * Stations outside the set go dark / idle. */
  setActiveStations(uids: ReadonlySet<string>): void {
    for (const [uid, f] of this.stationEffects) {
      f.group.visible = uids.has(uid);
    }
  }

  /** True if at least one station effect is currently visible — i.e.
   * a chef is cooking somewhere right now. Engine uses this to drive
   * the kitchen sizzle SFX loop. */
  isAnyStationActive(): boolean {
    for (const f of this.stationEffects.values()) if (f.group.visible) return true;
    return false;
  }

  /** Build the per-variant effect group for a given station defId.
   * Returns undefined for ids without a built-in visual (e.g. counter
   * — the chef just stands there chopping, no glow needed). */
  private buildStationEffect(defId: string): {
    group: THREE.Group;
    variant: "gas" | "electric" | "toaster" | "coffee" | "blender" | "microwave";
    flameMesh?: THREE.Mesh;
    flameLight?: THREE.PointLight;
    steamPuffs?: { mesh: THREE.Mesh; phase: number }[];
    wobbleMesh?: THREE.Mesh;
  } | undefined {
    switch (defId) {
      case "stove": return this.buildStoveFlameEffect("gas");
      case "stove-electric": return this.buildStoveFlameEffect("electric");
      case "toaster": return this.buildToasterGlowEffect();
      case "coffee-machine": return this.buildCoffeeSteamEffect();
      case "blender": return this.buildBlenderWobbleEffect();
      case "microwave": return this.buildMicrowaveGlowEffect();
      default: return undefined;
    }
  }

  /** Gas / electric stove flame — sphere + point light. Gas reads
   * warm-orange, electric reads cool-blue induction so the player can
   * tell at a glance which appliance is which. */
  private buildStoveFlameEffect(variant: "gas" | "electric") {
    const palette = variant === "electric"
      ? { color: 0x4d8eff, emissive: 0x1d4fc8, light: 0x88aaff }
      : { color: 0xff7a3c, emissive: 0xff5500, light: 0xff8844 };
    const group = new THREE.Group();
    group.visible = false;
    const flameMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 12),
      new THREE.MeshStandardMaterial({
        color: palette.color,
        emissive: palette.emissive,
        emissiveIntensity: 1.8,
        transparent: true,
        opacity: 0.85,
      }),
    );
    group.add(flameMesh);
    const flameLight = new THREE.PointLight(palette.light, 1.2, 2.5, 2);
    flameLight.position.set(0, 0.05, 0);
    group.add(flameLight);
    return { group, variant, flameMesh, flameLight };
  }

  /** Toaster glow — a thin red plane on top of the slot, pulsing as
   * if the coils inside are heating up. Plus a small warm point light
   * so the surrounding counter top picks up the colour. */
  private buildToasterGlowEffect() {
    const group = new THREE.Group();
    group.visible = false;
    const flameMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 0.08),
      new THREE.MeshStandardMaterial({
        color: 0xff5a30,
        emissive: 0xff3a10,
        emissiveIntensity: 2.0,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      }),
    );
    // Lie flat looking up; sits a hair above the toaster's top.
    flameMesh.rotation.x = -Math.PI / 2;
    group.add(flameMesh);
    const flameLight = new THREE.PointLight(0xff8866, 0.7, 1.5, 2);
    flameLight.position.set(0, 0.05, 0);
    group.add(flameLight);
    return { group, variant: "toaster" as const, flameMesh, flameLight };
  }

  /** Coffee steam — three small white spheres that rise + fade in
   * sequence so the spout looks like it's continuously puffing. */
  private buildCoffeeSteamEffect() {
    const group = new THREE.Group();
    group.visible = false;
    const geom = new THREE.SphereGeometry(0.05, 8, 8);
    const steamPuffs: { mesh: THREE.Mesh; phase: number }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const mesh = new THREE.Mesh(
        geom,
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.55,
          emissive: 0xf0f0f0,
          emissiveIntensity: 0.4,
        }),
      );
      // Initial vertical offset so puffs aren't stacked.
      mesh.position.set(0, 0.05 + i * 0.12, 0);
      group.add(mesh);
      steamPuffs.push({ mesh, phase: i / 3 });
    }
    return { group, variant: "coffee" as const, steamPuffs };
  }

  /** Blender wobble — a small dark accessory disc on top of the model
   * that spins while in use. */
  private buildBlenderWobbleEffect() {
    const group = new THREE.Group();
    group.visible = false;
    const wobbleMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.02, 12),
      new THREE.MeshStandardMaterial({
        color: 0x2a2a2a,
        emissive: 0x444444,
        emissiveIntensity: 0.3,
      }),
    );
    wobbleMesh.position.set(0, 0.08, 0);
    group.add(wobbleMesh);
    return { group, variant: "blender" as const, wobbleMesh };
  }

  /** Microwave inside-glow — a soft yellow point light just above the
   * model's top surface. Currently no recipe gates on microwave so
   * this rarely fires, but having it ready means the visual lights up
   * the moment we add a microwave recipe later. */
  private buildMicrowaveGlowEffect() {
    const group = new THREE.Group();
    group.visible = false;
    const flameLight = new THREE.PointLight(0xffcc66, 0.5, 1.2, 2);
    flameLight.position.set(0, 0.02, 0);
    group.add(flameLight);
    return { group, variant: "microwave" as const, flameLight };
  }

  /** Pin an effect group to a station model's measured top. Same
   * bounding-box maths as the previous per-stove flame anchoring;
   * works for stoves, toasters, coffee machines, etc. regardless of
   * how tall the model is. */
  private alignEffectToModel(group: THREE.Group, model: THREE.Object3D): void {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const topY = box.max.y + 0.03;
    group.position.set(cx, topY, cz);
  }

  /** Exposed for Engine to drive the day-night cycle each frame. */
  ambientLight!: THREE.AmbientLight;
  sunLight!: THREE.DirectionalLight;
  fillLight!: THREE.DirectionalLight;

  private addLighting(): void {
    this.ambientLight = new THREE.AmbientLight(0xfff1d6, 0.55);
    this.threeScene.add(this.ambientLight);

    this.sunLight = new THREE.DirectionalLight(0xffeac2, 1.1);
    this.sunLight.position.set(8, 14, 6);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -20;
    this.sunLight.shadow.camera.right = 20;
    this.sunLight.shadow.camera.top = 20;
    this.sunLight.shadow.camera.bottom = -20;
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 60;
    this.sunLight.shadow.bias = -0.0005;
    this.threeScene.add(this.sunLight);

    this.fillLight = new THREE.DirectionalLight(0xb8c8e0, 0.25);
    this.fillLight.position.set(-6, 10, -4);
    this.threeScene.add(this.fillLight);
  }

  // === Placed lamps (lighting items registered via registerLamp) ===
  // Each entry holds the placed model and the warm point-light child
  // we attach to it. updateLamps() walks the list every frame and
  // ramps the intensity with how dark the sky is. Cap is enforced
  // implicitly by the player's furniture budget.
  private placedLamps: { model: THREE.Object3D; light: THREE.PointLight; bulb: THREE.Mesh }[] = [];
  /** Most recently computed nightAmount in [0, 1] — used so a freshly
   * registered lamp picks up the current darkness immediately, not on
   * the next applyDayNight tick. */
  private currentNightAmount = 0;

  /** Attach a warm point light + small emissive bulb to a placed lamp
   * model so it actually illuminates the area at night. Returns silently
   * if the same model is already registered.
   *
   * Critical: the bulb + light are children of the model, which already
   * has fitFurniture's non-uniform scale baked in (often 3-8x for the
   * small Kenney lamp GLBs). A hardcoded local Y of 1.5 would get
   * multiplied by that scale and throw the bulb 5-12 units into the
   * sky. We instead anchor the bulb just below the model's measured
   * top in WORLD units and translate that back into the model's local
   * frame, and inverse-scale the bulb mesh so it stays the authored
   * 0.08 radius regardless of how stretched the parent model is. */
  registerLamp(model: THREE.Object3D): void {
    if (this.placedLamps.some((lp) => lp.model === model)) return;
    // Measure the lamp's world-space top so we know where "bulb height"
    // really is for THIS model. Wall sconces are mounted at y≈1.5
    // (BuildMenu pre-positions them), floor lamps have their feet at
    // y=0; either way the top of the model is the natural bulb anchor.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const worldTopY = Number.isFinite(box.max.y) ? box.max.y : 1.5;
    const bulbWorldY = Math.max(0.3, worldTopY - 0.12);
    // For wall sconces fitFurniture shifts the model so its +Z face
    // sits flush with the wall — that means the model origin is at
    // the WALL plane, and the candle / sconce body sticks out in -Z.
    // Anchoring the bulb at local (0, _, 0) parked it at the wall
    // plane, so the light pooled on the wall right behind the candle
    // instead of on the candle itself. Use the model's measured
    // bounding-box centre in world space, converted back to local,
    // so the bulb sits inside the sconce body for wall lamps and
    // stays at the model origin for floor / table / ceiling lamps
    // (whose centroid is already at the origin).
    const worldCentre = new THREE.Vector3(
      Number.isFinite(box.min.x) ? (box.min.x + box.max.x) / 2 : model.position.x,
      bulbWorldY,
      Number.isFinite(box.min.z) ? (box.min.z + box.max.z) / 2 : model.position.z,
    );
    const localCentre = model.worldToLocal(worldCentre.clone());

    const sx = model.scale.x || 1;
    const sy = model.scale.y || 1;
    const sz = model.scale.z || 1;

    const light = new THREE.PointLight(0xffd6a0, 0, 4.5, 1.7);
    light.position.copy(localCentre);
    light.castShadow = false; // shadow maps for many lamps tank perf
    model.add(light);
    // A tiny emissive sphere makes the bulb itself visibly "lit" at
    // night even when the player can't see the cone of illumination.
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 10, 10),
      new THREE.MeshStandardMaterial({
        color: 0xfff4cc, emissive: 0xfff4cc, emissiveIntensity: 0,
        transparent: true, opacity: 0.0,
      }),
    );
    bulb.position.copy(localCentre);
    // Inverse-scale so the bulb's WORLD radius stays at 0.08 even when
    // the parent lamp is stretched 8x vertically by fitFurniture.
    bulb.scale.set(1 / sx, 1 / sy, 1 / sz);
    model.add(bulb);
    this.placedLamps.push({ model, light, bulb });
    // Apply current darkness immediately so newly placed lamps come on
    // at the right brightness instead of waiting a frame.
    this.applyLampIntensity(light, bulb, this.currentNightAmount);
  }

  /** Remove a lamp from the active list (sell mode, undo, etc.). The
   * point light is disposed; the bulb mesh is removed too. */
  unregisterLamp(model: THREE.Object3D): void {
    const i = this.placedLamps.findIndex((lp) => lp.model === model);
    if (i < 0) return;
    const lp = this.placedLamps[i];
    model.remove(lp.light);
    model.remove(lp.bulb);
    lp.bulb.geometry.dispose();
    (lp.bulb.material as THREE.Material).dispose();
    this.placedLamps.splice(i, 1);
  }

  /** Walk every registered lamp and ramp its intensity + bulb emissive
   * with the current darkness. */
  private updateLamps(nightAmount: number): void {
    this.currentNightAmount = nightAmount;
    for (const lp of this.placedLamps) {
      this.applyLampIntensity(lp.light, lp.bulb, nightAmount);
    }
  }
  private applyLampIntensity(light: THREE.PointLight, bulb: THREE.Mesh, nightAmount: number): void {
    // Up to 1.8 intensity at full night — bright enough to read the
    // floor under each lamp but not so bright that an indoor scene
    // turns into floodlit daylight when the player drops a dozen lamps.
    light.intensity = nightAmount * 1.8;
    const bulbMat = bulb.material as THREE.MeshStandardMaterial;
    bulbMat.emissiveIntensity = nightAmount * 1.4;
    bulbMat.opacity = Math.min(1, nightAmount * 1.5);
  }

  /** Drive lighting + sky tint by time of day. progress is 0..1 over a
   * 24h game-day, divided as 8h night + 4h dawn/dusk + 12h day:
   *   0.000 – 0.083  dawn  (2h, brightening)
   *   0.083 – 0.583  day   (12h, full sun)
   *   0.583 – 0.667  dusk  (2h, darkening)
   *   0.667 – 1.000  night (8h, dark)
   * Engine ticks this every frame. */
  applyDayNight(progress: number): { skyColor: number } {
    const DAWN_END = 0.083;
    const DAY_END = 0.583;
    const DUSK_END = 0.667;
    // "dayness" is 0 in deep night, 1 in full daylight, ramping on
    // dawn + ramping off dusk. Drives sun + ambient.
    let dayness: number;
    if (progress < DAWN_END) {
      dayness = progress / DAWN_END;            // 0 → 1
    } else if (progress < DAY_END) {
      dayness = 1;
    } else if (progress < DUSK_END) {
      dayness = 1 - (progress - DAY_END) / (DUSK_END - DAY_END); // 1 → 0
    } else {
      dayness = 0;
    }

    // Sun: bright during day, dim during dawn/dusk, very dark at night.
    // Cap night sun way lower than before so the bistro genuinely
    // dims when it's supposed to be dark.
    const sunIntensity = 0.12 + dayness * 1.7;
    this.sunLight.intensity = sunIntensity;
    this.sunLight.color.setHex(mixColors(0xaab8d6, 0xfff4d8, dayness));

    // Ambient: warm bright during day, cool blue at night. Lower the
    // night floor here too so corners actually feel dark before lamps
    // are turned on.
    this.ambientLight.color.setHex(mixColors(0x8a98b8, 0xfff1d6, dayness));
    this.ambientLight.intensity = 0.32 + dayness * 0.68;

    // Fill (sky bounce) — fades with daylight but never to zero.
    this.fillLight.intensity = 0.18 + dayness * 0.32;

    // Sky color — sunrise/sunset orange during the transitions, deep
    // navy at night, cream during the day.
    let skyColor: number;
    if (progress < DAWN_END) {
      // night → orange dawn → day
      const t = progress / DAWN_END;
      skyColor = t < 0.5
        ? mixColors(0x12162a, 0xb27a52, t / 0.5)
        : mixColors(0xb27a52, 0xd8c4a3, (t - 0.5) / 0.5);
    } else if (progress < DAY_END) {
      skyColor = 0xd8c4a3;
    } else if (progress < DUSK_END) {
      // day → orange dusk → night
      const t = (progress - DAY_END) / (DUSK_END - DAY_END);
      skyColor = t < 0.5
        ? mixColors(0xd8c4a3, 0xb27a52, t / 0.5)
        : mixColors(0xb27a52, 0x12162a, (t - 0.5) / 0.5);
    } else {
      skyColor = 0x12162a; // darker than the old 0x1f2a48
    }

    // Lamp intensity tracks `1 - dayness` so bulbs warm up over the
    // dusk window, stay lit through deep night, then dim out across
    // the dawn window.
    this.updateLamps(1 - dayness);
    return { skyColor };
  }

  /** Exposed so the DecorPanel can swap colors when the player picks a
   * different theme. */
  floorMat!: THREE.MeshStandardMaterial;
  wallMat!: THREE.MeshStandardMaterial;
  /** Transparent "glass" version of wallMat used for walls between the
   * camera and the room interior. Color is intentionally not themed —
   * the peach tint reads as a CSS-cutaway hint rather than an actual
   * wall colour. */
  private wallGhostMat!: THREE.MeshStandardMaterial;
  // wallBack / wallLeft / wallRight removed — every perimeter wall
  // is now stored in the perimeterWalls map below.
  /** Exterior-facing wall material. Each wall segment uses a 6-material
   * array so the inside face is wallMat and the outside face is this.
   * Lets a window cut through and show the interior cream on the room
   * side and the building beige on the outside. */
  private wallExteriorMat!: THREE.MeshStandardMaterial;
  /** Per-direction state for the four perimeter walls — all dynamic
   * now so windows + doors can cut them. Single-mesh back/left/right
   * walls were replaced with a segmented system identical to the
   * front wall. */
  private readonly perimeterWalls: Map<WallDir, PerimeterWallState> = new Map([
    ["front", { meshes: [], currentMat: "ghost", doors: [] as number[], windows: [] as number[] }],
    ["back",  { meshes: [], currentMat: "solid", doors: [] as number[], windows: [] as number[] }],
    ["left",  { meshes: [], currentMat: "solid", doors: [] as number[], windows: [] as number[] }],
    ["right", { meshes: [], currentMat: "ghost", doors: [] as number[], windows: [] as number[] }],
  ]);

  private addBuilding(): void {
    // === Exterior ground layers ===
    // Grass surrounds everything — uses per-vertex color noise so it
    // doesn't look like a flat green sheet. ~3600 verts at 60×60 res.
    const grassGeo = new THREE.PlaneGeometry(60, 60, 60, 60);
    const colors = new Float32Array(grassGeo.attributes.position.count * 3);
    for (let i = 0; i < grassGeo.attributes.position.count; i += 1) {
      // Mix three greens with a per-vertex random.
      const r = Math.random();
      let c: { r: number; g: number; b: number };
      if (r < 0.55) c = { r: 0.32, g: 0.50, b: 0.22 };   // mid green
      else if (r < 0.85) c = { r: 0.40, g: 0.58, b: 0.28 }; // light green
      else c = { r: 0.24, g: 0.40, b: 0.18 };               // dark green
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    grassGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const grass = new THREE.Mesh(
      grassGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0 }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.01;
    grass.receiveShadow = true;
    this.threeScene.add(grass);
    // Scatter ~400 small grass tufts using instanced cones — adds 3D
    // detail without thousands of draw calls.
    const tuftGeo = new THREE.ConeGeometry(0.06, 0.22, 5);
    const tuftMat = new THREE.MeshStandardMaterial({ color: 0x4a6b30, roughness: 0.95 });
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, 400);
    const tmp = new THREE.Object3D();
    let placed = 0;
    while (placed < 400) {
      const tx = (Math.random() - 0.5) * 58;
      const tz = (Math.random() - 0.5) * 58;
      // Skip indoors (-5..5 x and z) and the road/pavement strip in front.
      const insideBuilding = tx > -5.5 && tx < 5.5 && tz > -5.5 && tz < 5.5;
      const onSidewalkOrRoad = tz > 4.5 && tz < 16.5 && tx > -15 && tx < 15;
      if (insideBuilding || onSidewalkOrRoad) continue;
      tmp.position.set(tx, 0.11, tz);
      tmp.rotation.y = Math.random() * Math.PI * 2;
      tmp.scale.setScalar(0.7 + Math.random() * 0.6);
      tmp.updateMatrix();
      tufts.setMatrixAt(placed, tmp.matrix);
      placed += 1;
    }
    tufts.castShadow = false;
    tufts.receiveShadow = true;
    this.threeScene.add(tufts);
    // Pavement strip in front of the door (z=5 to z=10).
    const pavement = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 5),
      new THREE.MeshStandardMaterial({ color: 0xb2a692, roughness: 0.9 }),
    );
    pavement.rotation.x = -Math.PI / 2;
    pavement.position.set(0, 0, 7.5);
    pavement.receiveShadow = true;
    this.threeScene.add(pavement);
    // Road beyond the pavement (z=10 to z=16).
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.95 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, 13);
    road.receiveShadow = true;
    this.threeScene.add(road);
    // Painted lane lines down the middle of the road.
    const laneMat = new THREE.MeshStandardMaterial({ color: 0xe6e0c4, roughness: 0.85, emissive: 0xe6e0c4, emissiveIntensity: 0.05 });
    for (let x = -14; x <= 14; x += 4) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.18), laneMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(x, 0.005, 13);
      this.threeScene.add(dash);
    }
    // Curb between pavement + road.
    const curb = new THREE.Mesh(
      new THREE.BoxGeometry(30, 0.12, 0.18),
      new THREE.MeshStandardMaterial({ color: 0x807468, roughness: 0.9 }),
    );
    curb.position.set(0, 0.06, 10);
    curb.castShadow = true;
    curb.receiveShadow = true;
    this.threeScene.add(curb);

    // === Interior floor ===
    // Default starter colors are intentionally bare white — the warm
    // tones moved into purchasable themes the player picks in the Decor
    // menu. See data/themes.ts.
    //
    // Floor + walls + grid are all shifted by (+0.5, +0.5) so they
    // enclose the same area as the grid (which has lines at half-integer
    // coords so items placed at integer coords appear inside tiles).
    // Before this shift the floor extended 0.5 past the grid on the
    // back/left, which the player saw as "floor leaking outside the
    // restaurant".
    this.floorMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.95, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0.5, 0.0, 0.5); // sits above grass; +0.5 shift to align with tile-center convention
    floor.receiveShadow = true;
    this.threeScene.add(floor);

    // Grid overlay so the iso "tile" feel reads (interior only). Lines
    // at half-integer coords so items at integer snap visually sit
    // inside cells. See the floor comment above for why the (0.5, 0.5)
    // shift exists at all.
    const grid = new THREE.GridHelper(10, 10, 0xa68969, 0xc4ab85);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    grid.position.set(0.5, 0.002, 0.5);
    this.threeScene.add(grid);

    // === Walls ===
    // Three materials:
    //   wallMat       — interior cream colour, room-facing face
    //   wallExtMat    — exterior beige, outside-facing face
    //   wallGhostMat  — see-through used when the camera is on this
    //                   wall's outdoor side so it doesn't block the
    //                   view of the dining room
    // updateWallVisibility picks solid vs ghost per wall every frame.
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.85 });
    this.wallExteriorMat = new THREE.MeshStandardMaterial({ color: 0xc8a878, roughness: 0.78 });
    this.wallGhostMat = new THREE.MeshStandardMaterial({
      color: 0xe8a98a, roughness: 0.6,
      transparent: true, opacity: 0.15, depthWrite: false,
    });
    // All 4 perimeter walls are dynamic segmented meshes now —
    // doors cut a full-height gap (+ lintel), windows cut a sill +
    // lintel partial gap so the player can see in / out through them
    // from either side. Default door list is empty; the engine
    // refills both lists from the registry as the player builds.
    this.rebuildPerimeterWall("front", [], []);
    this.rebuildPerimeterWall("back",  [], []);
    this.rebuildPerimeterWall("left",  [], []);
    this.rebuildPerimeterWall("right", [], []);
    // Restaurant rating sign mounted on the lintel — a small marquee
    // that shows the current ★ rating, just like a real bistro
    // entrance. Hooked up by updateRatingSign() from Engine.
    this.buildRatingSign();

    // Supply / receiving counter at the back-left wall — the errand
    // helper reports here with each delivery instead of walking out
    // the front door (which got in the customers' way and didn't read
    // as the back-of-house workflow it actually is). Procedural so it
    // shows for both new and existing saves regardless of registry state.
    this.buildSupplyCounter();
  }

  // === Dynamic perimeter walls ===============================================
  // All four perimeter walls are segmented now. Doors cut a full-height
  // gap with a lintel above; windows cut a sill + lintel partial gap so
  // the player can see through them from either side. Each wall has a
  // multi-material box geometry so the inside face wears the interior
  // colour and the outside face wears the building's exterior colour —
  // until the camera lands on the wall's outdoor side, at which point
  // the whole wall (every segment) flips to the ghost see-through.

  /** Outdoor-axis end coordinates for each wall (along the wall's main
   * axis). Together these give the building a 10×10 interior. */
  private static readonly WALL_AXIS_MIN = -4.5;
  private static readonly WALL_AXIS_MAX = 5.5;
  /** Half-tile gap each opening punches in the wall. */
  private static readonly OPENING_HALF = 0.5;
  /** Sill / lintel heights for a window opening. Sill = 0 → 0.9 m,
   * window itself runs 0.9 → 2.2 m, lintel = 2.2 → 3.0 m. */
  private static readonly WINDOW_SILL_TOP = 0.9;
  private static readonly WINDOW_LINTEL_BOTTOM = 2.2;

  /** Rebuild one perimeter wall from scratch around the supplied
   * openings. Door positions are along the wall's main axis (X for
   * front/back, Z for left/right) and produce a full-height gap with
   * a 1 m lintel above. Window positions produce a sill + window
   * opening + lintel, leaving the middle band see-through so the
   * actual window mesh placed on top is what the player looks
   * through. */
  rebuildPerimeterWall(dir: WallDir, doorEdges: number[], windowEdges: number[]): void {
    const state = this.perimeterWalls.get(dir);
    if (!state) return;
    state.doors = [...doorEdges];
    state.windows = [...windowEdges];
    // Tear down every existing mesh + free its geometry.
    for (const m of state.meshes) {
      this.threeScene.remove(m);
      m.geometry.dispose();
    }
    state.meshes.length = 0;

    const axisMin = WorldScene.WALL_AXIS_MIN;
    const axisMax = WorldScene.WALL_AXIS_MAX;
    const halfGap = WorldScene.OPENING_HALF;
    const sillTop = WorldScene.WINDOW_SILL_TOP;
    const lintelBottom = WorldScene.WINDOW_LINTEL_BOTTOM;

    // Build a sorted list of openings (mixed door + window) so the
    // segment loop walks them left-to-right exactly once.
    const openings: { center: number; type: "door" | "window" }[] = [
      ...doorEdges.filter((c) => c > axisMin && c < axisMax).map((c) => ({ center: c, type: "door" as const })),
      ...windowEdges.filter((c) => c > axisMin && c < axisMax).map((c) => ({ center: c, type: "window" as const })),
    ].sort((a, b) => a.center - b.center);

    const mats = this.materialsFor(dir, state.currentMat);
    const addBox = (
      axisFrom: number, axisTo: number,
      yCenter: number, yHeight: number,
    ): void => {
      const span = axisTo - axisFrom;
      if (span < 0.04 || yHeight < 0.04) return;
      const center = (axisFrom + axisTo) / 2;
      const geom = this.wallBoxFor(dir, span, yHeight);
      const mesh = new THREE.Mesh(geom, mats);
      const pos = this.wallSegmentPosition(dir, center, yCenter);
      mesh.position.copy(pos);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.threeScene.add(mesh);
      state.meshes.push(mesh);
    };

    let segStart = axisMin;
    for (const op of openings) {
      const gapStart = op.center - halfGap;
      const gapEnd = op.center + halfGap;
      // Continuous wall segment up to this opening.
      addBox(segStart, gapStart, 1.5, 3.0);
      if (op.type === "door") {
        // Full-height gap with a 1 m lintel sitting at the top.
        addBox(gapStart, gapEnd, 2.5, 1.0);
      } else {
        // Window: 0..sillTop is the sill, lintelBottom..3 is the lintel,
        // the middle band stays open so the placed window mesh shows.
        addBox(gapStart, gapEnd, sillTop / 2, sillTop);
        const lintelH = 3 - lintelBottom;
        addBox(gapStart, gapEnd, lintelBottom + lintelH / 2, lintelH);
      }
      segStart = gapEnd;
    }
    addBox(segStart, axisMax, 1.5, 3.0);
  }

  /** Geometry for a single wall box. Direction picks which axis the
   * width sits along — front/back stretch along X, left/right along
   * Z — keeping the 0.2 m thickness on the perpendicular axis. */
  private wallBoxFor(dir: WallDir, span: number, yHeight: number): THREE.BoxGeometry {
    if (dir === "front" || dir === "back") {
      return new THREE.BoxGeometry(span, yHeight, 0.2);
    }
    return new THREE.BoxGeometry(0.2, yHeight, span);
  }

  /** World position of a wall segment given its centre along the wall
   * axis and its centre Y. Building interior is shifted by (0.5, 0.5)
   * to match the tile grid, but the perimeter coords are absolute. */
  private wallSegmentPosition(dir: WallDir, axisCentre: number, yCentre: number): THREE.Vector3 {
    switch (dir) {
      case "front": return new THREE.Vector3(axisCentre, yCentre,  5.5);
      case "back":  return new THREE.Vector3(axisCentre, yCentre, -4.5);
      case "left":  return new THREE.Vector3(-4.5, yCentre, axisCentre);
      case "right": return new THREE.Vector3( 5.5, yCentre, axisCentre);
    }
  }

  /** Per-face material array for a wall box. Inside face uses
   * wallMat, outside face uses wallExteriorMat, top / bottom / end-
   * caps fall back to wallMat. Returns six copies of wallGhostMat
   * when the wall is currently ghost-faded (camera on its outside). */
  private materialsFor(dir: WallDir, kind: "solid" | "ghost"): THREE.Material[] {
    if (kind === "ghost") {
      return [
        this.wallGhostMat, this.wallGhostMat, this.wallGhostMat,
        this.wallGhostMat, this.wallGhostMat, this.wallGhostMat,
      ];
    }
    const int = this.wallMat;
    const ext = this.wallExteriorMat;
    // BoxGeometry face order: [+X, -X, +Y, -Y, +Z, -Z].
    switch (dir) {
      case "front": return [int, int, int, int, ext, int];
      case "back":  return [int, int, int, int, int, ext];
      case "left":  return [int, ext, int, int, int, int];
      case "right": return [ext, int, int, int, int, int];
    }
  }

  /** Legacy entry-point — Engine still calls this when only doors
   * changed. Forwards into the new system with the wall's current
   * window list preserved. */
  rebuildFrontWall(doorXs: readonly number[]): void {
    const state = this.perimeterWalls.get("front");
    if (!state) return;
    this.rebuildPerimeterWall("front", [...doorXs], state.windows);
  }

  /** Re-render every perimeter wall from the supplied openings.
   * Engine calls this after a door OR window changes anywhere on the
   * building — cheap because each wall ignores updates to its own
   * inputs when nothing changed. */
  rebuildAllPerimeterWalls(openings: Record<WallDir, { doors: number[]; windows: number[] }>): void {
    this.rebuildPerimeterWall("front", openings.front.doors, openings.front.windows);
    this.rebuildPerimeterWall("back",  openings.back.doors,  openings.back.windows);
    this.rebuildPerimeterWall("left",  openings.left.doors,  openings.left.windows);
    this.rebuildPerimeterWall("right", openings.right.doors, openings.right.windows);
  }

  /** Swap wall materials so the two walls closest to the camera become
   * the transparent ghost and the two far walls stay solid. Driven by
   * the dot product of each wall's outward normal with the camera's
   * world position relative to the building centre — positive means the
   * camera is on the wall's outer face. */
  updateWallVisibility(cameraPos: THREE.Vector3): void {
    if (!this.wallMat || !this.wallGhostMat) return;
    const kindFor = (normalX: number, normalZ: number): "solid" | "ghost" => {
      const dot = normalX * cameraPos.x + normalZ * cameraPos.z;
      return dot > 0 ? "ghost" : "solid";
    };
    this.applyWallKind("back",  kindFor(0, -1));
    this.applyWallKind("left",  kindFor(-1, 0));
    this.applyWallKind("right", kindFor(1, 0));
    this.applyWallKind("front", kindFor(0, 1));
  }

  /** Switch one wall's segments between solid (multi-mat) and ghost. */
  private applyWallKind(dir: WallDir, kind: "solid" | "ghost"): void {
    const state = this.perimeterWalls.get(dir);
    if (!state || state.currentMat === kind) return;
    state.currentMat = kind;
    const mats = this.materialsFor(dir, kind);
    for (const m of state.meshes) m.material = mats;
  }

  /** Wood-and-metal "back of house" counter where the errand helper
   * drops off groceries. Static — not registered, not sellable. */
  private buildSupplyCounter(): void {
    const counter = new THREE.Group();
    // Position relative to the back wall (z = -4.5 after the (+0.5, +0.5)
    // shift). Counter back face hugs the wall; the helper's drop-off
    // standing spot (supplyCounterPos) sits one tile to the south.
    counter.position.set(this.stoveFurniturePos.x - 3, 0, this.stoveFurniturePos.y - 0.05);
    // Cabinet body — 1 unit wide, ~0.85 tall, 0.7 deep, hugging the back wall.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.85, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x9a7a55, roughness: 0.85 }),
    );
    body.position.set(0, 0.425, 0.15); // back face against wall (wall at z=-5)
    body.castShadow = true;
    body.receiveShadow = true;
    counter.add(body);
    // Lighter top — looks like a worn worktop where bags get dropped.
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(1.05, 0.06, 0.75),
      new THREE.MeshStandardMaterial({ color: 0xcfb48a, roughness: 0.6 }),
    );
    top.position.set(0, 0.88, 0.15);
    top.castShadow = true;
    counter.add(top);
    // A couple of small crates on top so the player can tell at a
    // glance "this is the supply counter".
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x8c6a40, roughness: 0.9 });
    const crate1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.28), crateMat);
    crate1.position.set(-0.25, 1.02, 0.10);
    crate1.castShadow = true;
    counter.add(crate1);
    const crate2 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.22), crateMat);
    crate2.position.set(0.20, 1.00, 0.20);
    crate2.castShadow = true;
    counter.add(crate2);
    this.threeScene.add(counter);
  }

  // === Rating sign on the door lintel ===

  /** The 5 mounted star mini-meshes — each is "lit" (gold + emissive) or
   * "off" (slate). updateRatingSign sets which are lit based on the
   * current average rating. */
  private ratingStars: { mesh: THREE.Mesh; litMat: THREE.MeshStandardMaterial; offMat: THREE.MeshStandardMaterial }[] = [];

  private buildRatingSign(): void {
    // Backboard — a small dark plaque on the lintel, slightly proud of
    // the wall so it casts a shadow and reads as physical.
    const boardMat = new THREE.MeshStandardMaterial({ color: 0x1d1813, roughness: 0.75 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.45, 0.04), boardMat);
    board.position.set(0, 2.5, 5.63);
    board.castShadow = true;
    this.threeScene.add(board);
    // 5 star slots evenly spaced. Each star is a thin disc with a gold
    // material when lit, slate when off, so updateRatingSign can flip
    // them as the rating changes.
    const litMatTemplate = new THREE.MeshStandardMaterial({
      color: 0xf5c14a, roughness: 0.4, metalness: 0.4,
      emissive: 0xf5c14a, emissiveIntensity: 0.5,
    });
    const offMatTemplate = new THREE.MeshStandardMaterial({
      color: 0x474039, roughness: 0.85,
    });
    for (let i = 0; i < 5; i += 1) {
      const litMat = litMatTemplate.clone();
      const offMat = offMatTemplate.clone();
      const star = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), offMat);
      // Star x positions evenly across the board's 0.8 usable width.
      star.position.set(-0.32 + i * 0.16, 2.5, 5.66);
      this.threeScene.add(star);
      this.ratingStars.push({ mesh: star, litMat, offMat });
    }
  }

  /** Update the rating-sign lit-count from a 1-5 average. Called by
   * Engine on every HUD tick — cheap enough (5 ref swaps max). */
  updateRatingSign(rating: number): void {
    // A 4.3 rating lights 4 full stars + the 5th stays off (we treat
    // half-stars as off so the sign reads cleanly). Cap at 1..5.
    const litCount = Math.max(0, Math.min(5, Math.round(rating)));
    for (let i = 0; i < this.ratingStars.length; i += 1) {
      const s = this.ratingStars[i];
      const wantLit = i < litCount;
      const cur = s.mesh.material as THREE.Material;
      const want = wantLit ? s.litMat : s.offMat;
      if (cur !== want) s.mesh.material = want;
    }
  }

  /** Apply a theme color set to the existing wall + floor materials.
   * Used by the DecorPanel — the player picks one of a handful of
   * pre-curated palettes. */
  setTheme(theme: { wallColor: number; floorColor: number }): void {
    if (this.wallMat) this.wallMat.color.setHex(theme.wallColor);
    if (this.floorMat) this.floorMat.color.setHex(theme.floorColor);
  }

  /** Map demo placements → their tier section so we can show / hide as
   * the player expands. Tier 0 = always visible (kitchen, door, decor).
   * Tier 1 = the starter dining (tables 1 + 2). Tier 2..4 = the
   * progressively-unlocked dining tables. */
  private readonly tierGroups = new Map<number, THREE.Object3D[]>();
  private currentTierVisible = 5;

  private async populateDemoRestaurant(): Promise<void> {
    // NOTE: demoReady/staffReady promises are created in the constructor
    // — see the field declarations. We only RESOLVE them here, never
    // re-create them, so the engine's `.then(...)` references stay live.
    // Bare-minimum starter restaurant: front door, one cooking station,
    // one sink (so dishwashing has a baseline), one 4-top dining table.
    // Everything else — extra tables, fridge / microwave / counters,
    // plants, lamps, decor, sidewalk props — is something the player
    // earns and chooses from the build menu. This keeps a fresh save's
    // canvas clean instead of pre-populating it with an entire bistro.
    const placements: { id: string; x: number; z: number; rotY?: number; tier?: number }[] = [
      // Front door (entrance — guests spawn outside and walk through it).
      // z=5.5 lines up with the (+0.5, +0.5)-shifted front wall.
      // Anchored at half-integer here because the door mesh's frame is
      // centered at its local origin and needs to sit ON the wall plane
      // rather than half a tile inside the building.
      { id: "door",         x:  0, z:  5.5, rotY: Math.PI },
      // Essential appliances — stove + sink along the back wall.
      { id: "stove",        x:  0, z: -4 },
      { id: "sink",         x: -1, z: -4 },
      // Starter 4-top: 2×2 table anchored at (0.5, 1.5). Chairs go
      // in the four corner-adjacent cells (pinwheel pattern) so each
      // chair sits AT a tile center rather than straddling tile
      // borders. Each chair gets its own corner of the table top for
      // the plate, so there's no plate conflict between adjacent seats.
      { id: "small-table",  x:  0.5, z:  1.5, tier: 1 },
      // Bench-style chairs around the 2×2 table — 2 on the north side
      // (z=0) and 2 on the south side (z=3). Matches the bench layout
      // shown in the player's reference. Kenney chair GLB has its back
      // at -Z by default; for the back to point AWAY from the table,
      // north chairs use rotY = 0 (back at -Z, customer facing south),
      // south chairs use rotY = π (back at +Z, customer facing north).
      { id: "wooden-chair", x:  0,   z:  0,   rotY: 0,        tier: 1 },
      { id: "wooden-chair", x:  1,   z:  0,   rotY: 0,        tier: 1 },
      { id: "wooden-chair", x:  0,   z:  3,   rotY: Math.PI,  tier: 1 },
      { id: "wooden-chair", x:  1,   z:  3,   rotY: Math.PI,  tier: 1 },
    ];

    await Promise.all(placements.map(async (p) => {
      const def = getFurnitureDef(p.id);
      if (!def) {
        console.warn(`Unknown furniture id: ${p.id}`);
        return;
      }
      try {
        const model = await this.loader.load(def.modelPath);
        fitFurniture(model, def);
        model.position.set(p.x, model.position.y, p.z);
        if (p.rotY != null) model.rotation.y = p.rotY;
        this.threeScene.add(model);
        this.demoPlacements.push({ defId: p.id, x: p.x, z: p.z, rotY: p.rotY ?? 0, model });
        // Group by tier so we can hide locked sections.
        const tier = p.tier ?? 0;
        if (!this.tierGroups.has(tier)) this.tierGroups.set(tier, []);
        this.tierGroups.get(tier)!.push(model);
        // Capture the front-door's hinge sub-object for open/close animation.
        // The procedural front-door exposes the panel hinge via userData.panel.
        if (p.id === "door" && p.x === 0 && p.z === 5.5) {
          const panel = model.userData?.panel as THREE.Object3D | undefined;
          if (panel) this.doorPanel = panel;
        }
        // Per-stove flames are reconciled every frame by the Engine via
        // syncStoveFlames(registry.getCookingStoves()) — no need to pin
        // one here. Demo-stove placements show up in the registry just
        // like player placements and are picked up on the next frame.
      } catch (err) {
        console.error(`Failed to load ${def.id} (${def.modelPath})`, err);
      }
    }));

    this.buildTierMarkers();
    this.resolveDemoReady();
    await this.populateCharacters();
  }

  /** Tier-lock markers (the colored discs + glowing pillars) were removed
   * in the starter-restaurant revamp — they only made sense alongside
   * the pre-placed demo dining sections, which no longer exist. The
   * field is kept (empty) for save-time backwards compatibility, but
   * nothing is rendered. */
  private buildTierMarkers(): void {
    // Intentionally empty.
  }

  /** Show/hide tier-locked dining sections based on the player's current
   * expansion. Called by Engine on init and after Game.buyExpansion. */
  setLuxuryTier(tier: number): void {
    this.currentTierVisible = tier;
    for (const [tierKey, items] of this.tierGroups) {
      if (tierKey === 0) continue;
      const visible = tierKey <= tier;
      for (const obj of items) obj.visible = visible;
    }
  }

  /** Current applied tier (used by the door animator). */
  getLuxuryTier(): number {
    return this.currentTierVisible;
  }

  /** Spawn an extra staff character at runtime (when player hires another).
   * Slots them in just to the right of the existing crew so they don't
   * overlap. Returns the AnimatedCharacter, or null if the GLB failed
   * to load. */
  async spawnExtraStaff(role: "chef" | "waiter" | "errand", offsetSlot: number): Promise<AnimatedCharacter | null> {
    // Matches the new starter homes in populateCharacters — further south
    // so the walking distance to the kitchen line is large enough to read.
    const homeByRole: Record<"chef" | "waiter" | "errand", { x: number; z: number; facingY: number; action: CharacterAction }> = {
      // Reverted to original facingY values — the formula tweaks made
      // crab walking worse instead of better.
      chef:   { x: -1.5, z: -1.0, facingY: 0,            action: "idle" },
      waiter: { x:  1.5, z: -1.0, facingY: 0,            action: "idle" },
      errand: { x:  3.5, z: -1.0, facingY: -Math.PI / 2, action: "idle" },
    };
    const base = homeByRole[role];
    // Stagger each new hire 0.6 units further along the kitchen line.
    const x = base.x + offsetSlot * 0.6;
    try {
      const model = await this.characterLoader.load(role);
      const animated: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(x, base.z),
        facingY: base.facingY,
        action: base.action,
        phase: Math.random() * 5,
        seatHeight: 0.5,
      };
      this.threeScene.add(model);
      this.animator.add(animated);
      return animated;
    } catch (err) {
      console.warn(`Failed to spawn extra ${role}:`, err);
      return null;
    }
  }

  /** Place the static staff models (chef + waiter + errand) at the kitchen
   * line. Guests are spawned dynamically by GuestSpawner — they're not
   * placed here. */
  private async populateCharacters(): Promise<void> {
    // Spread the kitchen crew further apart and out into the dining-side
    // of the room. With everyone clustered at z=-2.6 (one row away from
    // the stove at z=-3) the chef's working walks were ~0.6 units, easy
    // to miss. New home positions put the chef ~2 units south of the
    // stove and the waiter ~2.5 from the pickup point — every ticket now
    // forces a clearly visible cross-kitchen trip.
    const staff: { id: string; x: number; z: number; facingY: number; action: CharacterAction }[] = [
      // Reverted to original facingY values — see spawnExtraStaff above.
      { id: "chef",   x: -1.5, z: -1.0, facingY: 0,            action: "idle"  },
      { id: "waiter", x:  1.5, z: -1.0, facingY: 0,            action: "idle"  },
      { id: "errand", x:  3.5, z: -1.0, facingY: -Math.PI / 2, action: "idle"  },
    ];

    // staffReady promise is created in the constructor (above) so any
    // synchronous consumer that grabbed the reference up-front waits for
    // this resolution rather than the initial sentinel. We only resolve
    // it here.

    await Promise.all(staff.map(async (c) => {
      try {
        const model = await this.characterLoader.load(c.id);
        const animated: AnimatedCharacter = {
          root: model,
          groundPos: new THREE.Vector2(c.x, c.z),
          facingY: c.facingY,
          action: c.action,
          phase: Math.random() * 5,
          seatHeight: 0.5,
        };
        this.threeScene.add(model);
        this.animator.add(animated);
        if (c.id === "chef") this.chefChar = animated;
        if (c.id === "waiter") this.waiterChar = animated;
        if (c.id === "errand") this.errandChar = animated;
      } catch (err) {
        console.warn(`Character ${c.id} unavailable:`, err);
      }
    }));
    console.log(`[WorldScene] populateCharacters done: chef=${this.chefChar ? "OK" : "MISSING"} waiter=${this.waiterChar ? "OK" : "MISSING"} errand=${this.errandChar ? "OK" : "MISSING"} — resolving staffReady`);
    this.resolveStaffReady();
  }
}
