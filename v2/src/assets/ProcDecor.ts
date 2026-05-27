import * as THREE from "three";

/**
 * Procedural wall-decoration meshes. The Kenney pack doesn't ship
 * paintings / menu boards / signage, so we synthesize them from box
 * geometries + emissive panels. Each builder returns a Group sized
 * roughly to fit on a single grid cell.
 *
 * Pattern: small "frame" box + colored interior panel + optional
 * accent. All lifted to wall-mount height (y ≈ 1.5).
 */

const WALL_HEIGHT = 1.5; // y offset so it floats at chest height

/** Tiny stand at the base so the decoration doesn't appear to hover
 * when placed in open space. */
function makeBaseStand(width: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.04, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x2a201a, roughness: 0.8 }),
  );
  m.position.y = 0.02;
  m.castShadow = true;
  return m;
}

/** A framed picture — dark wood frame around a colored canvas. */
function framedArt(canvasColor: number, label = ""): THREE.Group {
  void label; // reserved for future label-painting via canvas texture
  const g = new THREE.Group();
  const w = 0.7, h = 0.5;
  // Frame
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.7 }),
  );
  frame.position.y = WALL_HEIGHT;
  frame.castShadow = true;
  frame.receiveShadow = true;
  g.add(frame);
  // Canvas (the colored bit)
  const canvas = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.02),
    new THREE.MeshStandardMaterial({ color: canvasColor, roughness: 0.5, emissive: canvasColor, emissiveIntensity: 0.15 }),
  );
  canvas.position.set(0, WALL_HEIGHT, 0.04);
  g.add(canvas);
  g.add(makeBaseStand(w + 0.1));
  return g;
}

/** A chalk-board specials sign. */
function menuBoard(): THREE.Group {
  const g = new THREE.Group();
  // Frame
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.1, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75 }),
  );
  frame.position.y = WALL_HEIGHT - 0.1;
  frame.castShadow = true;
  g.add(frame);
  // Chalkboard interior
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.78, 0.98, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x1d2820, roughness: 0.9 }),
  );
  board.position.set(0, WALL_HEIGHT - 0.1, 0.04);
  g.add(board);
  // A few thin "chalk line" highlights so it reads as a menu, not a void.
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2ead8, emissive: 0xf2ead8, emissiveIntensity: 0.4 });
  for (let i = 0; i < 5; i += 1) {
    const len = 0.4 + Math.random() * 0.25;
    const line = new THREE.Mesh(new THREE.BoxGeometry(len, 0.025, 0.005), lineMat);
    line.position.set(-0.1, WALL_HEIGHT - 0.1 + 0.35 - i * 0.16, 0.06);
    g.add(line);
  }
  g.add(makeBaseStand(1.0));
  return g;
}

/** A neon "OPEN" sign. */
function neonSign(): THREE.Group {
  const g = new THREE.Group();
  const tube = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.25, 0.05),
    new THREE.MeshStandardMaterial({
      color: 0xff3a8a, emissive: 0xff3a8a, emissiveIntensity: 1.8, roughness: 0.3,
    }),
  );
  tube.position.y = WALL_HEIGHT + 0.1;
  g.add(tube);
  // A subtle backboard
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.35, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.8 }),
  );
  back.position.set(0, WALL_HEIGHT + 0.1, -0.02);
  g.add(back);
  // Pinkish glow
  const light = new THREE.PointLight(0xff3a8a, 0.6, 3, 2);
  light.position.set(0, WALL_HEIGHT + 0.1, 0.15);
  g.add(light);
  g.add(makeBaseStand(0.7));
  return g;
}

/** A wine wall — rows of bottle "shelf" cylinders. */
function wineWall(): THREE.Group {
  const g = new THREE.Group();
  // Backing
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.4, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x4a2e1c, roughness: 0.75 }),
  );
  back.position.y = WALL_HEIGHT - 0.05;
  back.castShadow = true;
  back.receiveShadow = true;
  g.add(back);
  // Bottle slots — 4 rows × 4 columns of dark green cylinders
  const bottleMat = new THREE.MeshStandardMaterial({ color: 0x2a4a28, roughness: 0.4 });
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 8), bottleMat);
      bottle.rotation.x = Math.PI / 2;
      bottle.position.set(
        -0.4 + col * 0.27,
        WALL_HEIGHT - 0.5 + row * 0.32,
        0.06,
      );
      g.add(bottle);
    }
  }
  g.add(makeBaseStand(1.05));
  return g;
}

/** Map of "proc:" id suffix → builder. ModelLoader routes through this. */
export const PROC_BUILDERS: Record<string, () => THREE.Group> = {
  "framed-art-warm": () => framedArt(0xc97e4a, "warm"),
  "framed-art-cool": () => framedArt(0x4a78c9, "cool"),
  "framed-art-mint": () => framedArt(0x6dbb8a, "mint"),
  "menu-board": () => menuBoard(),
  "neon-sign": () => neonSign(),
  "wine-wall": () => wineWall(),
};
