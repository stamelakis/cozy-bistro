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

/** A compact dishwasher — chrome box with a porthole. */
function dishwasher(): THREE.Group {
  const g = new THREE.Group();
  // Body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.9, 0.85),
    new THREE.MeshStandardMaterial({ color: 0xc8cdd2, roughness: 0.35, metalness: 0.6 }),
  );
  body.position.y = 0.45;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Front porthole
  const porthole = new THREE.Mesh(
    new THREE.CircleGeometry(0.18, 16),
    new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.2, emissive: 0x4488cc, emissiveIntensity: 0.15 }),
  );
  porthole.position.set(0, 0.5, 0.43);
  g.add(porthole);
  // Top control strip
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.06, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x1a1d20, roughness: 0.7 }),
  );
  strip.position.set(0, 0.85, 0.42);
  g.add(strip);
  return g;
}

/** A pro-grade dishwasher line. */
function dishwasherPro(): THREE.Group {
  const g = new THREE.Group();
  // Wider stainless body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 1.0, 0.85),
    new THREE.MeshStandardMaterial({ color: 0xb3bbc3, roughness: 0.25, metalness: 0.75 }),
  );
  body.position.y = 0.5;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Twin portholes
  const portMat = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.2, emissive: 0x4488cc, emissiveIntensity: 0.25 });
  for (const x of [-0.22, 0.22]) {
    const port = new THREE.Mesh(new THREE.CircleGeometry(0.17, 16), portMat);
    port.position.set(x, 0.55, 0.43);
    g.add(port);
  }
  // Steam stack on top — small glowing cylinder
  const stack = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 0.25, 10),
    new THREE.MeshStandardMaterial({ color: 0xe0e6ec, emissive: 0xffffff, emissiveIntensity: 0.2, transparent: true, opacity: 0.85 }),
  );
  stack.position.set(0.3, 1.1, 0);
  g.add(stack);
  return g;
}

/**
 * A door with a separate frame + hinged panel. The panel is exposed
 * via group.userData.panel so the animator can rotate JUST the panel
 * (around its hinge) while the frame stays put.
 *
 * Sized to fit a 1×1 tile: frame is 0.95 wide × 2.0 tall × 0.12 thick.
 * Door panel is 0.85 wide × 1.85 tall, hinged on the left edge.
 */
function frontDoor(): THREE.Group {
  const g = new THREE.Group();
  const frameWidth = 0.95;
  const frameHeight = 2.0;
  const panelWidth = 0.85;
  const panelHeight = 1.85;
  const panelThick = 0.04;
  const frameThick = 0.12;
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x4a3020, roughness: 0.7 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x7a4e30, roughness: 0.55 });
  const knobMat = new THREE.MeshStandardMaterial({ color: 0xc4a060, roughness: 0.3, metalness: 0.7 });

  // Top of frame.
  const top = new THREE.Mesh(new THREE.BoxGeometry(frameWidth, 0.12, frameThick), frameMat);
  top.position.set(0, frameHeight - 0.06, 0);
  top.castShadow = true;
  g.add(top);
  // Left jamb.
  const leftJamb = new THREE.Mesh(new THREE.BoxGeometry(0.08, frameHeight, frameThick), frameMat);
  leftJamb.position.set(-frameWidth / 2 + 0.04, frameHeight / 2, 0);
  leftJamb.castShadow = true;
  g.add(leftJamb);
  // Right jamb.
  const rightJamb = new THREE.Mesh(new THREE.BoxGeometry(0.08, frameHeight, frameThick), frameMat);
  rightJamb.position.set(frameWidth / 2 - 0.04, frameHeight / 2, 0);
  rightJamb.castShadow = true;
  g.add(rightJamb);

  // Door panel — pivoted via a wrapper Group hinged at its LEFT edge
  // so rotating .userData.panel makes it swing open inward like a real
  // door.  The visible mesh sits offset +panelWidth/2 inside the wrapper.
  const hinge = new THREE.Group();
  hinge.position.set(-panelWidth / 2 + 0.04, 0, 0); // hinge at left jamb
  const panel = new THREE.Mesh(new THREE.BoxGeometry(panelWidth, panelHeight, panelThick), panelMat);
  panel.position.set(panelWidth / 2, panelHeight / 2 + 0.04, 0);
  panel.castShadow = true;
  panel.receiveShadow = true;
  hinge.add(panel);
  // Knob + trim — attached to the HINGE (not the panel) because their
  // coordinates were authored in the hinge's frame. Adding them as
  // children of `panel` made them inherit panel's +panelWidth/2 offset,
  // which pushed both outside the panel on the right side — hence the
  // "two bars and a dot floating next to the door" visual.
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), knobMat);
  knob.position.set(panelWidth - 0.08, panelHeight / 2, panelThick / 2 + 0.04);
  hinge.add(knob);
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x5a3722, roughness: 0.7 });
  for (let i = 0; i < 2; i += 1) {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(panelWidth - 0.18, 0.04, 0.005), trimMat);
    trim.position.set(panelWidth / 2 - 0.04, panelHeight * (i === 0 ? 0.3 : 0.7), panelThick / 2 + 0.001);
    hinge.add(trim);
  }
  g.add(hinge);
  // Expose the hinge so WorldScene can rotate it.
  g.userData.panel = hinge;

  return g;
}

// === Internal partitions (edge-placed). =====================================

const WALL_MAT = new THREE.MeshStandardMaterial({ color: 0xf5efe2, roughness: 0.85 });
const WALL_TRIM_MAT = new THREE.MeshStandardMaterial({ color: 0xc8b894, roughness: 0.7 });

/** Interior wall section — thin slab 1 tile long, ~2.4 m tall, ~0.12 m
 * thick. Centered on the grid line between two cells when placed in
 * "edge" mode by BuildMenu. */
function internalWall(): THREE.Group {
  const g = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1.0, 2.4, 0.12), WALL_MAT);
  slab.position.y = 1.2;
  slab.castShadow = true;
  slab.receiveShadow = true;
  g.add(slab);
  // Top trim — adds shadow / contrast against the ceiling.
  const trim = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.06, 0.14), WALL_TRIM_MAT);
  trim.position.y = 2.43;
  g.add(trim);
  return g;
}

/** Half-height interior wall — like a banquette divider. */
function internalWallHalf(): THREE.Group {
  const g = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.1, 0.12), WALL_MAT);
  slab.position.y = 0.55;
  slab.castShadow = true;
  slab.receiveShadow = true;
  g.add(slab);
  const trim = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.05, 0.14), WALL_TRIM_MAT);
  trim.position.y = 1.13;
  g.add(trim);
  return g;
}

/** Internal doorway — wall section with a doorway opening in the middle. */
function internalDoorway(): THREE.Group {
  const g = new THREE.Group();
  const sideW = 0.18;
  const openingW = 1.0 - sideW * 2;
  // Side jambs (full height).
  for (const sx of [-0.5 + sideW / 2, 0.5 - sideW / 2]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(sideW, 2.4, 0.12), WALL_MAT);
    jamb.position.set(sx, 1.2, 0);
    jamb.castShadow = true;
    jamb.receiveShadow = true;
    g.add(jamb);
  }
  // Lintel (above the doorway).
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(openingW, 0.4, 0.12), WALL_MAT);
  lintel.position.set(0, 2.2, 0);
  lintel.castShadow = true;
  g.add(lintel);
  // Top trim runs across the whole 1-tile span.
  const trim = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.06, 0.14), WALL_TRIM_MAT);
  trim.position.y = 2.43;
  g.add(trim);
  return g;
}

/** Interior window — wall section with a glass panel up high. */
function internalWindow(): THREE.Group {
  const g = new THREE.Group();
  // Top + bottom wall slabs framing the glass.
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 0.12), WALL_MAT);
  bottom.position.y = 0.45;
  bottom.castShadow = true;
  g.add(bottom);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 0.12), WALL_MAT);
  top.position.y = 2.15;
  top.castShadow = true;
  g.add(top);
  // Glass pane.
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.86, 1.0, 0.04),
    new THREE.MeshStandardMaterial({
      color: 0xb8d4e0, roughness: 0.1, metalness: 0.2,
      transparent: true, opacity: 0.35, depthWrite: false,
    }),
  );
  glass.position.y = 1.4;
  g.add(glass);
  // Frame trim.
  for (const yy of [0.9, 1.9]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.04, 0.14), WALL_TRIM_MAT);
    t.position.y = yy;
    g.add(t);
  }
  const trim = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.06, 0.14), WALL_TRIM_MAT);
  trim.position.y = 2.43;
  g.add(trim);
  return g;
}

// === Fancy decor (fountain / aquarium / planter / hanging plant / dessert case). ===

/** Two-tier indoor fountain — round basin with a column + water droplet. */
function fountain(): THREE.Group {
  const g = new THREE.Group();
  // Outer basin (low, wide).
  const basin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.0, 0.25, 24),
    new THREE.MeshStandardMaterial({ color: 0xb5a99a, roughness: 0.6 }),
  );
  basin.position.y = 0.125;
  basin.castShadow = true;
  basin.receiveShadow = true;
  g.add(basin);
  // Water surface.
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(0.82, 0.82, 0.04, 24),
    new THREE.MeshStandardMaterial({
      color: 0x6fa8c4, roughness: 0.15, metalness: 0.2,
      transparent: true, opacity: 0.85,
      emissive: 0x3a6c8a, emissiveIntensity: 0.25,
    }),
  );
  water.position.y = 0.26;
  g.add(water);
  // Central column.
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.22, 0.55, 16),
    new THREE.MeshStandardMaterial({ color: 0xd6cdb8, roughness: 0.55 }),
  );
  column.position.y = 0.55;
  column.castShadow = true;
  g.add(column);
  // Upper bowl.
  const upper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.32, 0.1, 20),
    new THREE.MeshStandardMaterial({ color: 0xd6cdb8, roughness: 0.55 }),
  );
  upper.position.y = 0.88;
  upper.castShadow = true;
  g.add(upper);
  // Water droplet on top.
  const drop = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 12, 12),
    new THREE.MeshStandardMaterial({
      color: 0x6fa8c4, emissive: 0x3a6c8a, emissiveIntensity: 0.4,
      transparent: true, opacity: 0.85,
    }),
  );
  drop.position.y = 1.05;
  g.add(drop);
  return g;
}

/** Aquarium — long glass tank on a wooden stand, faint blue interior glow. */
function aquarium(): THREE.Group {
  const g = new THREE.Group();
  // Wooden stand.
  const stand = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.55, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x5a3e26, roughness: 0.75 }),
  );
  stand.position.y = 0.275;
  stand.castShadow = true;
  stand.receiveShadow = true;
  g.add(stand);
  // Tank base.
  const tankFloor = new THREE.Mesh(
    new THREE.BoxGeometry(1.75, 0.04, 0.55),
    new THREE.MeshStandardMaterial({ color: 0x2a2218, roughness: 0.6 }),
  );
  tankFloor.position.y = 0.575;
  g.add(tankFloor);
  // Glass walls (thin boxes around the perimeter).
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9ec8d6, roughness: 0.1, metalness: 0.2,
    transparent: true, opacity: 0.3, depthWrite: false,
  });
  const gx = [-0.875, 0.875]; // left/right faces
  for (const x of gx) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.55, 0.55), glassMat);
    wall.position.set(x, 0.875, 0);
    g.add(wall);
  }
  const gz = [-0.275, 0.275]; // front/back faces
  for (const z of gz) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.55, 0.04), glassMat);
    wall.position.set(0, 0.875, z);
    g.add(wall);
  }
  // Water + glow inside the tank.
  const water = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.45, 0.5),
    new THREE.MeshStandardMaterial({
      color: 0x4a90b0, roughness: 0.3,
      emissive: 0x2a6080, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.6, depthWrite: false,
    }),
  );
  water.position.y = 0.85;
  g.add(water);
  const innerLight = new THREE.PointLight(0x6fb8d8, 0.8, 3, 2);
  innerLight.position.set(0, 1.0, 0);
  g.add(innerLight);
  // Top trim.
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(1.78, 0.06, 0.58),
    new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.7 }),
  );
  trim.position.y = 1.17;
  g.add(trim);
  return g;
}

/** Planter box — long wooden box with three small green tufts. */
function planterBox(): THREE.Group {
  const g = new THREE.Group();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1.85, 0.32, 0.55),
    new THREE.MeshStandardMaterial({ color: 0x6a4828, roughness: 0.8 }),
  );
  box.position.y = 0.16;
  box.castShadow = true;
  box.receiveShadow = true;
  g.add(box);
  // Soil top.
  const soil = new THREE.Mesh(
    new THREE.BoxGeometry(1.78, 0.04, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x382010, roughness: 1.0 }),
  );
  soil.position.y = 0.34;
  g.add(soil);
  // Three small foliage tufts.
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4a7028, roughness: 0.85 });
  for (let i = 0; i < 3; i += 1) {
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.45, 6), leafMat);
    t.position.set(-0.6 + i * 0.6, 0.56, 0);
    t.castShadow = true;
    g.add(t);
  }
  return g;
}

/** Hanging plant — chain + pot suspended from ceiling height. */
function hangingPlant(): THREE.Group {
  const g = new THREE.Group();
  // "Chain" — thin pillar from ceiling.
  const chain = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 1.6, 6),
    new THREE.MeshStandardMaterial({ color: 0x5a5550, roughness: 0.5, metalness: 0.6 }),
  );
  chain.position.y = 2.0;
  g.add(chain);
  // Pot.
  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.16, 0.22, 16),
    new THREE.MeshStandardMaterial({ color: 0x9a5a3a, roughness: 0.8 }),
  );
  pot.position.y = 1.1;
  pot.castShadow = true;
  g.add(pot);
  // Cascading leaves (overhanging cone going down).
  const leaves = new THREE.Mesh(
    new THREE.ConeGeometry(0.32, 0.6, 8),
    new THREE.MeshStandardMaterial({ color: 0x5a8038, roughness: 0.85 }),
  );
  leaves.position.y = 0.85;
  leaves.rotation.x = Math.PI; // point down
  leaves.castShadow = true;
  g.add(leaves);
  return g;
}

/** Dessert display case — glass-fronted pastry cabinet with two shelves
 * of colored "cakes" inside. */
function dessertDisplay(): THREE.Group {
  const g = new THREE.Group();
  // Base cabinet.
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.5, 0.55),
    new THREE.MeshStandardMaterial({ color: 0xc2a988, roughness: 0.7 }),
  );
  base.position.y = 0.25;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);
  // Display body (glass).
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xdde8ee, roughness: 0.1, metalness: 0.2,
    transparent: true, opacity: 0.4, depthWrite: false,
  });
  const glassBody = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 0.55), glassMat);
  glassBody.position.y = 0.95;
  g.add(glassBody);
  // Frame.
  for (const yy of [0.55, 1.4]) {
    const t = new THREE.Mesh(
      new THREE.BoxGeometry(0.87, 0.04, 0.57),
      new THREE.MeshStandardMaterial({ color: 0x6a4220, roughness: 0.7 }),
    );
    t.position.y = yy;
    g.add(t);
  }
  // Internal warm light + cakes.
  const inner = new THREE.PointLight(0xffd99c, 0.5, 1.5, 2);
  inner.position.set(0, 1.0, 0);
  g.add(inner);
  const cakeColors = [0xf2c4a8, 0xf5d894, 0xd68a78, 0xa2c4c8];
  for (let i = 0; i < 4; i += 1) {
    const cake = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.07, 12),
      new THREE.MeshStandardMaterial({
        color: cakeColors[i], roughness: 0.6,
        emissive: cakeColors[i], emissiveIntensity: 0.1,
      }),
    );
    const row = Math.floor(i / 2);
    const col = i % 2;
    cake.position.set(-0.16 + col * 0.32, 0.7 + row * 0.32, 0);
    cake.castShadow = true;
    g.add(cake);
  }
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
  "dishwasher": () => dishwasher(),
  "dishwasher-pro": () => dishwasherPro(),
  "front-door": () => frontDoor(),
  "int-wall": () => internalWall(),
  "int-wall-half": () => internalWallHalf(),
  "int-doorway": () => internalDoorway(),
  "int-window": () => internalWindow(),
  "fountain": () => fountain(),
  "aquarium": () => aquarium(),
  "planter-box": () => planterBox(),
  "hanging-plant": () => hangingPlant(),
  "dessert-display": () => dessertDisplay(),
};
