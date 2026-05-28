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
  /** Glowing point light + emissive sphere over the stove. Toggled by
   * setStoveFlame(visible) based on whether a chef is actively cooking. */
  private stoveFlameGroup?: THREE.Group;
  private stoveFlameMesh?: THREE.Mesh;
  private stoveFlameLight?: THREE.PointLight;
  private stoveFlamePhase = 0;
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
    this.addStoveFlame();
    void this.populateDemoRestaurant();
  }

  update(dt: number): void {
    this.animator.update(dt);
    if (this.stoveFlameGroup && this.stoveFlameGroup.visible) {
      this.stoveFlamePhase += dt;
      const flick = 0.85 + Math.sin(this.stoveFlamePhase * 22) * 0.1 + Math.random() * 0.1;
      if (this.stoveFlameMesh) this.stoveFlameMesh.scale.setScalar(flick);
      if (this.stoveFlameLight) this.stoveFlameLight.intensity = 1.6 + Math.sin(this.stoveFlamePhase * 18) * 0.3;
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

  /** Show or hide the cooking flame above the stove. Engine calls this
   * every frame based on whether any chef is in "working" state. */
  setStoveFlame(visible: boolean): void {
    if (this.stoveFlameGroup) this.stoveFlameGroup.visible = visible;
  }

  /** Build the stove flame (small orange emissive bead + point light) once.
   * The flame is constructed empty at the origin; its actual world
   * position is patched in later by alignStoveFlameToStove() once the
   * stove model has loaded and we can read its real bounding box. This
   * avoids the prior hardcoded y=0.85 which only happened to look right
   * before furniture auto-fit landed (post-auto-fit the stove's top is
   * a different height per asset).
   *
   * TODO: differentiate per stove type (gas vs electric → blue vs orange
   * glow, plus different sound). For now the starter restaurant only has
   * the gas stove so a single flame is fine. */
  private addStoveFlame(): void {
    const group = new THREE.Group();
    group.visible = false;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 12),
      new THREE.MeshStandardMaterial({
        color: 0xff7a3c,
        emissive: 0xff5500,
        emissiveIntensity: 1.8,
        transparent: true,
        opacity: 0.85,
      }),
    );
    group.add(mesh);
    const light = new THREE.PointLight(0xff8844, 1.2, 2.5, 2);
    light.position.set(0, 0.05, 0);
    group.add(light);
    this.threeScene.add(group);
    this.stoveFlameGroup = group;
    this.stoveFlameMesh = mesh;
    this.stoveFlameLight = light;
  }

  /** Pin the stove flame to a specific stove model's measured top. Call
   * this whenever a stove is placed (demo restaurant, build-menu place,
   * save restore). If no stove model is provided we fall back to a
   * reasonable height above stoveFurniturePos. */
  alignStoveFlameToStove(stoveModel?: THREE.Object3D): void {
    if (!this.stoveFlameGroup) return;
    if (stoveModel) {
      // World-space top of the stove model — the flame sits a hair
      // above the burners. Use the model's bounding box so this works
      // regardless of which stove type the player has placed.
      stoveModel.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(stoveModel);
      // Center the flame on the stove's XZ footprint, not the chef-
      // standing waypoint — that's what made the flame visibly drift
      // off the burner.
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const topY = box.max.y + 0.03;
      this.stoveFlameGroup.position.set(cx, topY, cz);
    } else {
      // Fallback when we haven't seen a stove model yet — sit a bit
      // above where the back-wall stove would be.
      this.stoveFlameGroup.position.set(
        this.stoveFurniturePos.x, 0.55, this.stoveFurniturePos.y,
      );
    }
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

  /** Drive lighting + sky tint by time of day. progress is 0..1 from
   * dawn through dusk into night. Engine ticks this every frame. */
  applyDayNight(progress: number): { skyColor: number } {
    // Sun follows an arc: low/warm at dawn (0) and dusk (1), high/bright at noon (0.5).
    const noonish = 1 - Math.abs(progress - 0.5) * 2; // 0 at edges, 1 at noon
    // Sun: bright all day (0.9 → 1.8), softer at dawn/dusk but never dim,
    // and a calmer moonlight at night (0.35) so the bistro looks lit.
    const sunIntensity = progress < 0.92
      ? 0.9 + noonish * 0.9
      : Math.max(0.35, 0.35);
    this.sunLight.intensity = sunIntensity;
    const sunColor = progress < 0.92
      ? mixColors(0xffa860, 0xfff4d8, noonish)
      : mixColors(0xffa860, 0xaab8d6, (progress - 0.92) / 0.08);
    this.sunLight.color.setHex(sunColor);
    // Ambient: warm bright during day, cool blue at night.
    if (progress < 0.92) {
      this.ambientLight.color.setHex(mixColors(0xffd6a8, 0xfff1d6, noonish));
      this.ambientLight.intensity = 0.65 + noonish * 0.35;
    } else {
      this.ambientLight.color.setHex(0x8898b8);
      this.ambientLight.intensity = 0.6;
    }
    // Fill (sky bounce) — adds color and softens shadows.
    this.fillLight.intensity = Math.max(0.3, 0.3 + noonish * 0.15);
    // Sky color (engine sets renderer clear color from this).
    let skyColor: number;
    if (progress < 0.1) skyColor = mixColors(0xf7c08a, 0xd8c4a3, progress / 0.1); // dawn → day
    else if (progress < 0.85) skyColor = 0xd8c4a3; // day
    else if (progress < 0.95) skyColor = mixColors(0xd8c4a3, 0xb27a52, (progress - 0.85) / 0.1); // day → dusk
    else skyColor = mixColors(0xb27a52, 0x1f2a48, (progress - 0.95) / 0.05); // dusk → night
    return { skyColor };
  }

  /** Exposed so the DecorPanel can swap colors when the player picks a
   * different theme. */
  floorMat!: THREE.MeshStandardMaterial;
  wallMat!: THREE.MeshStandardMaterial;

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
    // Solid back + left walls. Same (+0.5, +0.5) shift as the floor so
    // the building envelope coincides with the tiled area.
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.85 });
    const wallBack = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 0.2), this.wallMat);
    wallBack.position.set(0.5, 1.5, -4.5);
    wallBack.castShadow = true;
    wallBack.receiveShadow = true;
    this.threeScene.add(wallBack);

    const wallSide = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 10), this.wallMat);
    wallSide.position.set(-4.5, 1.5, 0.5);
    wallSide.castShadow = true;
    wallSide.receiveShadow = true;
    this.threeScene.add(wallSide);

    // Transparent right + front walls (so the room is enclosed but the
    // camera can still see in). 15% opacity → barely visible glass-like.
    const ghostMat = new THREE.MeshStandardMaterial({
      color: 0xe8a98a, roughness: 0.6,
      transparent: true, opacity: 0.15, depthWrite: false,
    });
    const wallRight = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 10), ghostMat);
    wallRight.position.set(5.5, 1.5, 0.5);
    this.threeScene.add(wallRight);
    // Front wall is split into two segments leaving a 1-tile doorway
    // open at x=-0.5..+0.5 (matches the 1×1 door footprint at x=0).
    // X positions of these segments stay unshifted so the gap remains
    // centered on x=0 — that's where the demo door's tile lands.
    const frontLeft = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3, 0.2), ghostMat);
    frontLeft.position.set(-2.75, 1.5, 5.5);
    this.threeScene.add(frontLeft);
    const frontRight = new THREE.Mesh(new THREE.BoxGeometry(5.5, 3, 0.2), ghostMat);
    frontRight.position.set(3.25, 1.5, 5.5);
    this.threeScene.add(frontRight);
    // Door lintel — fills the gap above the doorway so the front wall
    // reads as enclosed (door panel is 2 units tall; lintel runs from
    // y=2 to y=3). 1.0 wide so it exactly meets frontLeft/frontRight.
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 0.2), ghostMat);
    lintel.position.set(0, 2.5, 5.5);
    this.threeScene.add(lintel);
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
      // Pinwheel chairs around the 2×2 table. The Kenney chair GLB has
      // its back at -Z (north) by default, so chair.rotY = θ puts the
      // back at R_y(θ) * (0, 0, -1). For the back to point AWAY from
      // the table, the offsets below resolve to:
      //   top-left  → back at -Z (north)        → rotY = 0
      //   top-right → back at +X (east)         → rotY = -π/2
      //   bottom-right → back at +Z (south)     → rotY = π
      //   bottom-left → back at -X (west)       → rotY = π/2
      { id: "wooden-chair", x:  0,   z:  0,   rotY: 0,            tier: 1 },
      { id: "wooden-chair", x:  2,   z:  1,   rotY: -Math.PI / 2, tier: 1 },
      { id: "wooden-chair", x:  1,   z:  3,   rotY: Math.PI,      tier: 1 },
      { id: "wooden-chair", x: -1,   z:  2,   rotY:  Math.PI / 2, tier: 1 },
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
        // Pin the cooking flame onto whichever stove just landed at the
        // canonical demo position so the flame reads as part of the
        // appliance instead of a separate floating ball.
        if ((p.id === "stove" || p.id === "stove-electric") &&
            p.x === this.stoveFurniturePos.x && p.z === this.stoveFurniturePos.y) {
          this.alignStoveFlameToStove(model);
        }
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
