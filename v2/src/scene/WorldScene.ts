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
   * StaffRouter to send chef/waiter to the right places. */
  readonly stovePos = new THREE.Vector2(0, -3.0);
  readonly pickupPos = new THREE.Vector2(0.5, -2.8);
  /** Where the errand helper walks to when fetching ingredients (front door). */
  readonly doorPos = new THREE.Vector2(0, 5);
  /** Resolves once the staff characters are loaded — so Engine can build
   * the StaffRouter at the right moment. */
  staffReady: Promise<void> = Promise.resolve();
  /** Resolves once the demo restaurant furniture is in the scene — so
   * Engine can register every demo piece in the FurnitureRegistry and
   * therefore make them moveable / sellable like player-placed items. */
  demoReady: Promise<void> = Promise.resolve();
  /** Snapshot of the demo placements (id + cell + rotation + model)
   * filled in by populateDemoRestaurant. */
  readonly demoPlacements: { defId: string; x: number; z: number; rotY: number; model: THREE.Object3D }[] = [];

  constructor() {
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

  /** Build the stove flame (orange emissive sphere + point light) once.
   * Default hidden — Engine toggles visibility based on chef state. */
  private addStoveFlame(): void {
    const group = new THREE.Group();
    group.position.set(this.stovePos.x, 0.55, this.stovePos.y);
    group.visible = false;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 12),
      new THREE.MeshStandardMaterial({
        color: 0xff7a3c,
        emissive: 0xff5500,
        emissiveIntensity: 1.8,
        transparent: true,
        opacity: 0.85,
      }),
    );
    group.add(mesh);
    const light = new THREE.PointLight(0xff8844, 1.6, 4, 2);
    light.position.set(0, 0.05, 0);
    group.add(light);
    this.threeScene.add(group);
    this.stoveFlameGroup = group;
    this.stoveFlameMesh = mesh;
    this.stoveFlameLight = light;
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
    this.floorMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.95, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.0; // sits above grass
    floor.receiveShadow = true;
    this.threeScene.add(floor);

    // Grid overlay so the iso "tile" feel reads (interior only).
    const grid = new THREE.GridHelper(10, 10, 0xa68969, 0xc4ab85);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    grid.position.y = 0.002;
    this.threeScene.add(grid);

    // === Walls ===
    // Solid back + left walls.
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.85 });
    const wallBack = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 0.2), this.wallMat);
    wallBack.position.set(0, 1.5, -5);
    wallBack.castShadow = true;
    wallBack.receiveShadow = true;
    this.threeScene.add(wallBack);

    const wallSide = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 10), this.wallMat);
    wallSide.position.set(-5, 1.5, 0);
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
    wallRight.position.set(5, 1.5, 0);
    this.threeScene.add(wallRight);
    // Front wall is split into two segments leaving a 1-tile doorway
    // open at x=-0.5..+0.5 (matches the 1×1 door footprint).
    const frontLeft = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3, 0.2), ghostMat);
    frontLeft.position.set(-2.75, 1.5, 5);
    this.threeScene.add(frontLeft);
    const frontRight = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3, 0.2), ghostMat);
    frontRight.position.set(2.75, 1.5, 5);
    this.threeScene.add(frontRight);
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
    let resolveDemoReady: () => void = () => {};
    this.demoReady = new Promise((r) => { resolveDemoReady = r; });
    // Bare-minimum starter restaurant: front door, one cooking station,
    // one sink (so dishwashing has a baseline), one 4-top dining table.
    // Everything else — extra tables, fridge / microwave / counters,
    // plants, lamps, decor, sidewalk props — is something the player
    // earns and chooses from the build menu. This keeps a fresh save's
    // canvas clean instead of pre-populating it with an entire bistro.
    const placements: { id: string; x: number; z: number; rotY?: number; tier?: number }[] = [
      // Front door (entrance — guests spawn outside and walk through it).
      { id: "door",         x:  0, z:  5, rotY: Math.PI },
      // Essential appliances — stove + sink along the back wall.
      { id: "stove",        x:  0, z: -4 },
      { id: "sink",         x: -1, z: -4 },
      // One starter dining table with its 4 chairs.
      { id: "small-table",  x:  0, z:  1, tier: 1 },
      { id: "wooden-chair", x: -0.9, z: 1,    rotY:  Math.PI / 2, tier: 1 },
      { id: "wooden-chair", x:  0.9, z: 1,    rotY: -Math.PI / 2, tier: 1 },
      { id: "wooden-chair", x:  0,   z: 0.1,  rotY: 0,            tier: 1 },
      { id: "wooden-chair", x:  0,   z: 1.9,  rotY: Math.PI,      tier: 1 },
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
        if (p.id === "door" && p.x === 0 && p.z === 5) {
          const panel = model.userData?.panel as THREE.Object3D | undefined;
          if (panel) this.doorPanel = panel;
        }
      } catch (err) {
        console.error(`Failed to load ${def.id} (${def.modelPath})`, err);
      }
    }));

    this.buildTierMarkers();
    resolveDemoReady();
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
    const homeByRole: Record<"chef" | "waiter" | "errand", { x: number; z: number; facingY: number; action: CharacterAction }> = {
      chef:   { x: -0.5, z: -2.6, facingY: 0,            action: "idle" },
      waiter: { x:  1.5, z: -2.6, facingY: 0,            action: "idle" },
      errand: { x:  3.5, z: -2.6, facingY: -Math.PI / 2, action: "idle" },
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
    const staff: { id: string; x: number; z: number; facingY: number; action: CharacterAction }[] = [
      { id: "chef",   x: -0.5, z: -2.6, facingY: 0,            action: "idle"  },
      { id: "waiter", x:  1.5, z: -2.6, facingY: 0,            action: "idle"  },
      { id: "errand", x:  3.5, z: -2.6, facingY: -Math.PI / 2, action: "carry" },
    ];

    let resolveStaffReady: () => void = () => {};
    this.staffReady = new Promise((r) => { resolveStaffReady = r; });

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
    resolveStaffReady();
  }
}
