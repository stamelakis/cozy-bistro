import * as THREE from "three";

/**
 * The 3D world. For now a placeholder scene with a ground, a couple of cubes
 * acting as stand-in furniture, and lighting. Will grow into the real
 * restaurant world (grid placement, furniture, characters, etc.) as we port
 * each system from the 2D version.
 */
export class WorldScene {
  readonly threeScene = new THREE.Scene();

  constructor() {
    this.threeScene.fog = new THREE.Fog(0xd8c4a3, 30, 80);
    this.addLighting();
    this.addGround();
    this.addPlaceholderFurniture();
  }

  update(_dt: number): void {
    // Per-frame logic goes here once we have moving entities.
  }

  private addLighting(): void {
    // Soft ambient so shadows aren't pitch black.
    this.threeScene.add(new THREE.AmbientLight(0xfff1d6, 0.55));

    // Key sun light, casting shadows.
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

    // Cool fill from the opposite side to soften shadow contrast.
    const fill = new THREE.DirectionalLight(0xb8c8e0, 0.25);
    fill.position.set(-6, 10, -4);
    this.threeScene.add(fill);
  }

  private addGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({
        color: 0xe7d4ad,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.threeScene.add(ground);

    // Tile grid overlay so the iso "grid" feel is still legible.
    const grid = new THREE.GridHelper(40, 40, 0xa68969, 0xc4ab85);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.y = 0.001; // sit just above the ground to avoid z-fighting
    this.threeScene.add(grid);
  }

  private addPlaceholderFurniture(): void {
    // Three cubes standing in for: a table, a chair, a person.
    // These will be replaced with real Kenney models + Meshy characters once
    // the asset pipeline is wired in (Phase 2).
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.75, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x8c6a4a, roughness: 0.8 }),
    );
    table.position.set(0, 0.375, 0);
    table.castShadow = true;
    table.receiveShadow = true;
    this.threeScene.add(table);

    const chairColor = 0xb38a5e;
    for (let i = 0; i < 4; i += 1) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const chair = new THREE.Group();
      const seat = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.08, 0.45),
        new THREE.MeshStandardMaterial({ color: chairColor, roughness: 0.85 }),
      );
      seat.position.y = 0.46;
      seat.castShadow = true;
      seat.receiveShadow = true;
      const back = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.55, 0.06),
        new THREE.MeshStandardMaterial({ color: chairColor, roughness: 0.85 }),
      );
      back.position.set(0, 0.78, -0.2);
      back.castShadow = true;
      chair.add(seat, back);
      // Legs
      for (const [lx, lz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]] as const) {
        const leg = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, 0.46, 0.06),
          new THREE.MeshStandardMaterial({ color: chairColor, roughness: 0.85 }),
        );
        leg.position.set(lx, 0.23, lz);
        leg.castShadow = true;
        chair.add(leg);
      }
      const r = 1.1;
      chair.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
      chair.rotation.y = -angle + Math.PI / 2; // chair back faces table
      this.threeScene.add(chair);
    }

    // A "person" placeholder — a capsule, seated next to one chair.
    const personMat = new THREE.MeshStandardMaterial({ color: 0x4a5e7a, roughness: 0.7 });
    const person = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.45, 4, 8), personMat);
    person.position.set(1.1, 0.65, 0);
    person.castShadow = true;
    this.threeScene.add(person);
  }
}
