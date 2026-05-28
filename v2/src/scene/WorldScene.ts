import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { ModelLoader } from "../assets/ModelLoader";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { CharacterAnimator, type AnimatedCharacter, type CharacterAction } from "./CharacterAnimator";

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
  /** World position of the stove and the plate-pickup spot. Used by the
   * StaffRouter to send chef/waiter to the right places. */
  readonly stovePos = new THREE.Vector2(0, -3.0);
  readonly pickupPos = new THREE.Vector2(0.5, -2.8);
  /** Where the errand helper walks to when fetching ingredients (front door). */
  readonly doorPos = new THREE.Vector2(0, 5);
  /** Resolves once the staff characters are loaded — so Engine can build
   * the StaffRouter at the right moment. */
  staffReady: Promise<void> = Promise.resolve();

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
      // Flicker scale + intensity so the flame looks alive.
      const flick = 0.85 + Math.sin(this.stoveFlamePhase * 22) * 0.1 + Math.random() * 0.1;
      if (this.stoveFlameMesh) this.stoveFlameMesh.scale.setScalar(flick);
      if (this.stoveFlameLight) this.stoveFlameLight.intensity = 1.6 + Math.sin(this.stoveFlamePhase * 18) * 0.3;
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
    // Sun intensity peaks at noon, drops to ~0.15 at edges; dives to ~0 at night.
    const sunIntensity = progress < 0.92
      ? 0.15 + noonish * 1.1
      : Math.max(0, 0.15 - (progress - 0.92) * 1.8);
    this.sunLight.intensity = sunIntensity;
    // Sun color: warm orange at low elevation, white at high.
    const sunColor = mixColors(0xffa860, 0xfff4d8, noonish);
    this.sunLight.color.setHex(sunColor);
    // Ambient: cool at night, warm during day.
    if (progress < 0.92) {
      this.ambientLight.color.setHex(mixColors(0xffd6a8, 0xfff1d6, noonish));
      this.ambientLight.intensity = 0.35 + noonish * 0.4;
    } else {
      // Night: low blue ambient
      this.ambientLight.color.setHex(0x5a6a8a);
      this.ambientLight.intensity = 0.25;
    }
    // Fill (sky bounce) — cooler at noon, warmer at edges.
    this.fillLight.intensity = 0.18 + noonish * 0.15;
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
    // Floor
    this.floorMat = new THREE.MeshStandardMaterial({ color: 0xe7d4ad, roughness: 0.95, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.threeScene.add(floor);

    // Grid overlay so the iso "tile" feel reads.
    const grid = new THREE.GridHelper(40, 40, 0xa68969, 0xc4ab85);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    grid.position.y = 0.001;
    this.threeScene.add(grid);

    // Two short walls to suggest the bistro interior corner.
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xe8a98a, roughness: 0.85 });
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
  }

  /** Apply a theme color set to the existing wall + floor materials.
   * Used by the DecorPanel — the player picks one of a handful of
   * pre-curated palettes. */
  setTheme(theme: { wallColor: number; floorColor: number }): void {
    if (this.wallMat) this.wallMat.color.setHex(theme.wallColor);
    if (this.floorMat) this.floorMat.color.setHex(theme.floorColor);
  }

  private async populateDemoRestaurant(): Promise<void> {
    // Place a few Kenney pieces to verify loading + look. Positions are in
    // world units (1 unit = 1 grid cell). Coords are (x, z) on the ground.
    const placements: { id: string; x: number; z: number; rotY?: number }[] = [
      // Kitchen line along the back wall
      { id: "fridge",     x: -3,   z: -4 },
      { id: "counter",    x: -2,   z: -4 },
      { id: "sink",       x: -1,   z: -4 },
      { id: "stove",      x:  0,   z: -4 },
      { id: "counter",    x:  1,   z: -4 },
      { id: "microwave",  x:  2,   z: -4 },

      // Dining: 2 tables with chairs tucked in (0.7 offset from table center).
      { id: "small-table",   x: -2,   z: 1 },
      { id: "wooden-chair",  x: -2.7, z: 1, rotY: Math.PI / 2 },
      { id: "wooden-chair",  x: -1.3, z: 1, rotY: -Math.PI / 2 },
      { id: "wooden-chair",  x: -2,   z: 0.3, rotY: 0 },
      { id: "wooden-chair",  x: -2,   z: 1.7, rotY: Math.PI },

      { id: "small-table",   x: 2,    z: 1 },
      { id: "cushion-chair", x: 1.3,  z: 1, rotY: -Math.PI / 2 },
      { id: "cushion-chair", x: 2.7,  z: 1, rotY: Math.PI / 2 },
      { id: "cushion-chair", x: 2,    z: 0.3, rotY: 0 },
      { id: "cushion-chair", x: 2,    z: 1.7, rotY: Math.PI },

      // Third table near the front so the restaurant doesn't feel half-empty.
      { id: "small-table",   x: 0,    z: 3 },
      { id: "modern-chair",  x: -0.7, z: 3, rotY: Math.PI / 2 },
      { id: "modern-chair",  x:  0.7, z: 3, rotY: -Math.PI / 2 },
      { id: "modern-chair",  x:  0,   z: 2.3, rotY: 0 },
      { id: "modern-chair",  x:  0,   z: 3.7, rotY: Math.PI },

      // Tier 3+ tables — placed to the sides, near the walls. GuestSpawner
      // gates seat availability by tier so these visually exist but only
      // start taking guests once luxury tier ≥ the unlock threshold.
      { id: "small-table",   x: -4,   z: 0 },
      { id: "cushion-chair", x: -4.7, z: 0, rotY: Math.PI / 2 },
      { id: "cushion-chair", x: -3.3, z: 0, rotY: -Math.PI / 2 },
      { id: "cushion-chair", x: -4,   z: -0.7, rotY: 0 },
      { id: "cushion-chair", x: -4,   z: 0.7, rotY: Math.PI },

      { id: "small-table",   x: 4,    z: 0 },
      { id: "cushion-chair", x: 4.7,  z: 0, rotY: -Math.PI / 2 },
      { id: "cushion-chair", x: 3.3,  z: 0, rotY: Math.PI / 2 },
      { id: "cushion-chair", x: 4,    z: -0.7, rotY: 0 },
      { id: "cushion-chair", x: 4,    z: 0.7, rotY: Math.PI },

      // Decor
      { id: "plant-medium",  x: -4.5, z: -4 },
      { id: "plant-small",   x:  4,   z: -4 },
      { id: "floor-lamp",    x: -4,   z:  3 },
      { id: "floor-lamp",    x:  4,   z:  3 },
      { id: "door",          x:  0,   z:  5, rotY: Math.PI },

      // Street props (z > 5 is outside the building) — sidewalk life.
      { id: "floor-lamp",    x: -7,   z:  7 },
      { id: "floor-lamp",    x:  7,   z:  7 },
      { id: "potted-plant",  x: -2.5, z:  6 },
      { id: "potted-plant",  x:  2.5, z:  6 },
      { id: "bench-plain",   x: -4,   z:  7, rotY: Math.PI },
      { id: "bench-plain",   x:  4,   z:  7, rotY: Math.PI },
      { id: "trashcan",      x:  6,   z:  6.5 },
      { id: "cardboard-box", x: -6,   z:  6.5 },
    ];

    await Promise.all(placements.map(async (p) => {
      const def = getFurnitureDef(p.id);
      if (!def) {
        console.warn(`Unknown furniture id: ${p.id}`);
        return;
      }
      try {
        const model = await this.loader.load(def.modelPath);
        model.position.set(p.x, 0, p.z);
        if (p.rotY != null) model.rotation.y = p.rotY;
        model.scale.setScalar(def.scale);
        this.threeScene.add(model);
      } catch (err) {
        console.error(`Failed to load ${def.id} (${def.modelPath})`, err);
      }
    }));

    await this.populateCharacters();
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
