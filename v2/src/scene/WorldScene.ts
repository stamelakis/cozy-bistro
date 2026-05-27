import * as THREE from "three";
import { CharacterLoader } from "../assets/CharacterLoader";
import { ModelLoader } from "../assets/ModelLoader";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { CharacterAnimator, type AnimatedCharacter, type CharacterAction } from "./CharacterAnimator";

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
  private readonly loader = new ModelLoader();
  private readonly characterLoader = new CharacterLoader(this.loader);
  private readonly animator = new CharacterAnimator();
  /** Demo state: a character that walks back and forth on a fixed path. */
  private demoWalker?: { c: AnimatedCharacter; pathA: THREE.Vector2; pathB: THREE.Vector2; tElapsed: number };

  constructor() {
    this.threeScene.fog = new THREE.Fog(0xd8c4a3, 30, 80);
    this.addLighting();
    this.addBuilding();
    void this.populateDemoRestaurant();
  }

  update(dt: number): void {
    // Demo: bounce the waiter back and forth between two points.
    if (this.demoWalker) {
      const w = this.demoWalker;
      w.tElapsed += dt;
      const period = 6; // seconds for a full A→B→A loop
      const phase = (w.tElapsed % period) / period; // 0..1
      const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2; // ping-pong 0..1..0
      w.c.groundPos.x = THREE.MathUtils.lerp(w.pathA.x, w.pathB.x, t);
      w.c.groundPos.y = THREE.MathUtils.lerp(w.pathA.y, w.pathB.y, t);
      // Face the direction of motion (positive on A→B half, negative on return)
      const dir = phase < 0.5 ? 1 : -1;
      const dx = (w.pathB.x - w.pathA.x) * dir;
      const dz = (w.pathB.y - w.pathA.y) * dir;
      w.c.facingY = Math.atan2(dx, dz);
    }
    this.animator.update(dt);
  }

  private addLighting(): void {
    this.threeScene.add(new THREE.AmbientLight(0xfff1d6, 0.55));

    const sun = new THREE.DirectionalLight(0xffeac2, 1.1);
    sun.position.set(8, 14, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0005;
    this.threeScene.add(sun);

    const fill = new THREE.DirectionalLight(0xb8c8e0, 0.25);
    fill.position.set(-6, 10, -4);
    this.threeScene.add(fill);
  }

  private addBuilding(): void {
    // Floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0xe7d4ad, roughness: 0.95, metalness: 0 }),
    );
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
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8a98a, roughness: 0.85 });
    const wallBack = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 0.2), wallMat);
    wallBack.position.set(0, 1.5, -5);
    wallBack.castShadow = true;
    wallBack.receiveShadow = true;
    this.threeScene.add(wallBack);

    const wallSide = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 10), wallMat);
    wallSide.position.set(-5, 1.5, 0);
    wallSide.castShadow = true;
    wallSide.receiveShadow = true;
    this.threeScene.add(wallSide);
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

      // Dining: 2 tables with chairs around each
      { id: "small-table",   x: -2,   z: 1 },
      { id: "wooden-chair",  x: -2.9, z: 1, rotY: Math.PI / 2 },
      { id: "wooden-chair",  x: -1.1, z: 1, rotY: -Math.PI / 2 },
      { id: "wooden-chair",  x: -2,   z: 0.1, rotY: 0 },
      { id: "wooden-chair",  x: -2,   z: 1.9, rotY: Math.PI },

      { id: "small-table",   x: 2,    z: 1 },
      { id: "cushion-chair", x: 1.1,  z: 1, rotY: -Math.PI / 2 },
      { id: "cushion-chair", x: 2.9,  z: 1, rotY: Math.PI / 2 },
      { id: "cushion-chair", x: 2,    z: 0.1, rotY: 0 },
      { id: "cushion-chair", x: 2,    z: 1.9, rotY: Math.PI },

      // Decor
      { id: "plant-medium",  x: -4.5, z: -4 },
      { id: "plant-small",   x:  4,   z: -4 },
      { id: "floor-lamp",    x: -4,   z:  3 },
      { id: "floor-lamp",    x:  4,   z:  3 },
      { id: "door",          x:  0,   z:  5, rotY: Math.PI },
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

  /** Drop one of every TripoSR-generated character into the scene with
   * representative animations so quality + animation feel are both
   * immediately visible. */
  private async populateCharacters(): Promise<void> {
    // Position + action recipe for each character. Action drives the
    // procedural animation: walk = bobbing+rotation, sit = lowered+tilted,
    // carry = walk+pitched, idle = breathing+sway.
    const characters: {
      id: string;
      x: number;
      z: number;
      facingY: number;
      action: CharacterAction;
    }[] = [
      // Kitchen line: chef cooking (idle), errand carrying, waiter walking
      { id: "chef",   x: -0.5, z: -3.4, facingY: 0,           action: "idle" },
      { id: "errand", x:  3.5, z: -3.4, facingY: -Math.PI / 2, action: "carry" },

      // Dining: guests seated around the two tables (4 seats each)
      { id: "guest-v0", x: -2.9, z:  1.0, facingY:  Math.PI / 2, action: "sit" },
      { id: "guest-v1", x: -1.1, z:  1.0, facingY: -Math.PI / 2, action: "sit" },
      { id: "guest-v2", x: -2,   z:  0.1, facingY:  Math.PI,     action: "sit" },
      { id: "guest-v3", x: -2,   z:  1.9, facingY:  0,           action: "sit" },

      { id: "guest-v4", x:  1.1, z:  1.0, facingY:  Math.PI / 2, action: "sit" },
      { id: "guest-v5", x:  2.9, z:  1.0, facingY: -Math.PI / 2, action: "sit" },
      { id: "guest-v6", x:  2,   z:  0.1, facingY:  Math.PI,     action: "sit" },
    ];

    await Promise.all(characters.map(async (c) => {
      try {
        const model = await this.characterLoader.load(c.id);
        const animated: AnimatedCharacter = {
          root: model,
          groundPos: new THREE.Vector2(c.x, c.z),
          facingY: c.facingY,
          action: c.action,
          phase: Math.random() * 5,
          // The Kenney chair seat sits ~0.5m above the floor. Sit-mode lowers
          // the character to this height so they appear to sit on the chair.
          seatHeight: 0.5,
        };
        this.threeScene.add(model);
        this.animator.add(animated);
      } catch (err) {
        console.warn(`Character ${c.id} unavailable:`, err);
      }
    }));

    // The waiter walks back and forth between the kitchen line and the
    // dining area so the walk animation is visible while the rest of the
    // scene is static.
    try {
      const waiter = await this.characterLoader.load("waiter");
      const animated: AnimatedCharacter = {
        root: waiter,
        groundPos: new THREE.Vector2(1.5, -3.4),
        facingY: 0,
        action: "walk",
        phase: 0,
      };
      this.threeScene.add(waiter);
      this.animator.add(animated);
      this.demoWalker = {
        c: animated,
        pathA: new THREE.Vector2(1.5, -3.0),
        pathB: new THREE.Vector2(1.5,  0.5),
        tElapsed: 0,
      };
    } catch (err) {
      console.warn("Waiter unavailable for walking demo:", err);
    }
  }
}
