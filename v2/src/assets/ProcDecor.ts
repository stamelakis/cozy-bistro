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

// Wall items used to author their meshes at local y = 1.5 to "float at
// chest height" assuming the model anchor stayed at the floor — but the
// placement path independently sets model.position.y = placementY('wall')
// = 1.5, so the offsets compounded and the frame sat at world y = 3 (the
// wall top). Authors are now at local y ≈ 0 so the single chest-height
// offset comes from placementY, not from inside the builder.
//
// makeBaseStand removed: these defs are placement: "wall" only, so the
// floor-level stand was both invisible (covered by the wall mount) and,
// for wall placement, ended up floating at chest height as a stray
// dark slab.

/** A framed picture — dark wood frame around a colored canvas. */
function framedArt(canvasColor: number, label = ""): THREE.Group {
  void label; // reserved for future label-painting via canvas texture
  const g = new THREE.Group();
  const w = 0.7, h = 0.5;
  // Frame — centred at local y=0 so placementY=1.5 lands the centre at
  // world chest height.
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.7 }),
  );
  frame.castShadow = true;
  frame.receiveShadow = true;
  g.add(frame);
  // Canvas (the colored bit), inset 4 cm in FRONT of the frame. Wall-
  // mount rotation puts model −Z toward the room, so the canvas sits on
  // the −Z side. If it were at +0.04 the canvas would face the wall and
  // the player would see the back of the frame from inside the room.
  const canvas = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.02),
    new THREE.MeshStandardMaterial({ color: canvasColor, roughness: 0.5, emissive: canvasColor, emissiveIntensity: 0.15 }),
  );
  canvas.position.set(0, 0, -0.04);
  g.add(canvas);
  return g;
}

/** A chalk-board specials sign. */
function menuBoard(): THREE.Group {
  const g = new THREE.Group();
  // Slightly dipped (−0.1) so the board reads as hung a touch below
  // chest height — feels more natural for a menu you read at eye level
  // from a counter than a frame painting at exact chest.
  const yOff = -0.1;
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.1, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75 }),
  );
  frame.position.y = yOff;
  frame.castShadow = true;
  g.add(frame);
  // Chalkboard interior + chalk lines sit on the −Z side so the painted
  // surface faces the room after the wall-mount rotation. +Z would face
  // the wall and the player would only see the back of the frame.
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.78, 0.98, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x1d2820, roughness: 0.9 }),
  );
  board.position.set(0, yOff, -0.04);
  g.add(board);
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2ead8, emissive: 0xf2ead8, emissiveIntensity: 0.4 });
  for (let i = 0; i < 5; i += 1) {
    const len = 0.4 + Math.random() * 0.25;
    const line = new THREE.Mesh(new THREE.BoxGeometry(len, 0.025, 0.005), lineMat);
    line.position.set(-0.1, yOff + 0.35 - i * 0.16, -0.06);
    g.add(line);
  }
  return g;
}

/** A neon "OPEN" sign. */
function neonSign(): THREE.Group {
  const g = new THREE.Group();
  // Lifted (+0.1) above chest so the neon reads as "above the door /
  // above eye-level" rather than dead-centre on the wall.
  const yOff = 0.1;
  const tube = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.25, 0.05),
    new THREE.MeshStandardMaterial({
      color: 0xff3a8a, emissive: 0xff3a8a, emissiveIntensity: 1.8, roughness: 0.3,
    }),
  );
  tube.position.y = yOff;
  g.add(tube);
  // Back panel sits on +Z (against the wall) so the tube glows out into
  // the room. The PointLight goes to −Z (room side) so the falloff lands
  // INSIDE the building instead of leaking through the wall to the lawn.
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.35, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.8 }),
  );
  back.position.set(0, yOff, 0.02);
  g.add(back);
  // Perf: emissive-only. The tube material above is emissive, so the sign
  // glows without a cast PointLight (which would swing the scene's active
  // light count on every floor reveal → shader recompile on weak GPUs).
  return g;
}

/** A wine wall — rows of bottle "shelf" cylinders mounted on the wall.
 * Authored for placement="wall": children sit at local y=0..~1.4 so
 * once the world placement adds the wall's 1.5 m chest-height offset,
 * the rack hangs from chest height up to ~y=2.9 (just below the
 * ceiling). No base stand — it's literally on the wall, not on a stand. */
function wineWall(): THREE.Group {
  const g = new THREE.Group();
  // Back panel — sits flush against the wall. Authored at +Z so the
  // model's max.z is near the wall plane (the BuildMenu mount logic
  // rotates the model so its +Z faces the wall and offsets by 0.07).
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.4, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x4a2e1c, roughness: 0.75 }),
  );
  back.position.set(0, 0.7, 0.025);
  back.castShadow = true;
  back.receiveShadow = true;
  g.add(back);
  // Bottle slots — 4 rows × 4 columns of dark green cylinders extending
  // toward the room (-Z) so the bottle ends face the player.
  const bottleMat = new THREE.MeshStandardMaterial({ color: 0x2a4a28, roughness: 0.4 });
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 8), bottleMat);
      bottle.rotation.x = Math.PI / 2;
      bottle.position.set(
        -0.4 + col * 0.27,
        0.22 + row * 0.32,
        -0.09,
      );
      g.add(bottle);
    }
  }
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

/** Internal doorway — wall section with a hinged door panel that swings
 * open when a guest is near. The door panel is exposed via
 * .userData.panel so WorldScene can rotate it (same pattern as the
 * procedural front door). */
function internalDoorway(): THREE.Group {
  const g = new THREE.Group();
  const sideW = 0.18;
  const openingW = 1.0 - sideW * 2;
  const panelH = 2.0;
  const panelW = openingW - 0.04; // small clearance so the panel doesn't bind on the jambs
  const panelThick = 0.04;
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
  lintel.position.set(0, panelH + 0.2, 0);
  lintel.castShadow = true;
  g.add(lintel);
  // Top trim runs across the whole 1-tile span.
  const trim = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.06, 0.14), WALL_TRIM_MAT);
  trim.position.y = 2.43;
  g.add(trim);
  // Door panel — hinged at the left jamb edge so .userData.panel can
  // swing the door open inward when a guest is near. Lighter wood than
  // the wall so it reads as a separate object.
  const doorMat = new THREE.MeshStandardMaterial({ color: 0xb88a5e, roughness: 0.55 });
  const knobMat = new THREE.MeshStandardMaterial({ color: 0xc4a060, roughness: 0.3, metalness: 0.7 });
  const hinge = new THREE.Group();
  // Hinge sits at the left jamb's inner edge: x = -0.5 + sideW.
  hinge.position.set(-0.5 + sideW, 0, 0);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(panelW, panelH, panelThick), doorMat);
  panel.position.set(panelW / 2, panelH / 2, 0);
  panel.castShadow = true;
  panel.receiveShadow = true;
  hinge.add(panel);
  // Door knob on the panel's right edge (handles authored in hinge frame
  // for the same reason as the front door — see frontDoor() comment).
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), knobMat);
  knob.position.set(panelW - 0.08, panelH / 2, panelThick / 2 + 0.03);
  hinge.add(knob);
  g.add(hinge);
  // Expose so consumers (WorldScene's per-door open/close animator)
  // can rotate it. Same convention as front door's userData.panel.
  g.userData.panel = hinge;
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
      emissive: 0x2a6080, emissiveIntensity: 0.85,
      transparent: true, opacity: 0.6, depthWrite: false,
    }),
  );
  water.position.y = 0.85;
  g.add(water);
  // Perf: emissive-only — the water mesh's emissive (bumped above) carries
  // the glow without a cast PointLight that would swing the active count.
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
  // Perf: emissive-only — cakes read fine under ambient + lamp light
  // without a dedicated cast PointLight (which would swing the count).
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

// === Cooking stations (spread the kitchen across dedicated equipment). ===
// All floor-standing 1×1 (pizza oven 2×1), authored from y=0 up like the
// other floor props. They live in the "stove" build-menu category but the
// per-stove flame system is id-gated (def.id === "stove"/"stove-electric")
// so these don't pick up gas-burner flames — each carries its own glow.

/** Flat-top grill — dark griddle with red ember glow between the bars. */
function grillStation(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.82, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6 }),
  );
  body.position.y = 0.41;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Griddle plate.
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.84, 0.05, 0.72),
    new THREE.MeshStandardMaterial({ color: 0x17191b, roughness: 0.8, metalness: 0.4 }),
  );
  plate.position.y = 0.84;
  g.add(plate);
  // Ember strips (emissive-only — no cast light, per the perf rule).
  const emberMat = new THREE.MeshStandardMaterial({ color: 0xff5a1e, emissive: 0xff4a14, emissiveIntensity: 0.9, roughness: 0.7 });
  for (let i = 0; i < 4; i += 1) {
    const ember = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.012, 0.04), emberMat);
    ember.position.set(0, 0.865, -0.27 + i * 0.18);
    g.add(ember);
  }
  // Grate bars over the embers.
  const barMat = new THREE.MeshStandardMaterial({ color: 0x101214, roughness: 0.6, metalness: 0.5 });
  for (let i = 0; i < 7; i += 1) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.02, 0.025), barMat);
    bar.position.set(0, 0.885, -0.3 + i * 0.1);
    g.add(bar);
  }
  return g;
}

/** Convection oven — stainless box with a warm glowing glass door + dials. */
function ovenStation(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.95, 0.8),
    new THREE.MeshStandardMaterial({ color: 0xd6d9dc, roughness: 0.4, metalness: 0.5 }),
  );
  body.position.y = 0.475;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Glass door with warm interior glow.
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.5, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.2, emissive: 0xff8a2a, emissiveIntensity: 0.55, transparent: true, opacity: 0.85 }),
  );
  door.position.set(0, 0.4, 0.41);
  g.add(door);
  // Control strip + dials.
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(0.72, 0.16, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x33363a, roughness: 0.6 }),
  );
  panel.position.set(0, 0.85, 0.41);
  g.add(panel);
  const dialMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.4, metalness: 0.5 });
  for (let i = 0; i < 3; i += 1) {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 12), dialMat);
    d.rotation.x = Math.PI / 2;
    d.position.set(-0.2 + i * 0.2, 0.85, 0.44);
    g.add(d);
  }
  // Handle.
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.04, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x44474b, metalness: 0.7, roughness: 0.3 }),
  );
  handle.position.set(0, 0.68, 0.44);
  g.add(handle);
  return g;
}

/** Deep fryer — twin oil vats with a golden glow + basket handles. */
function fryerStation(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.85, 0.78),
    new THREE.MeshStandardMaterial({ color: 0xc3c9cf, roughness: 0.3, metalness: 0.7 }),
  );
  body.position.y = 0.425;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  const oilMat = new THREE.MeshStandardMaterial({ color: 0xd9a23a, roughness: 0.3, emissive: 0xc88a1e, emissiveIntensity: 0.45, transparent: true, opacity: 0.9 });
  const handleMat = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, metalness: 0.6, roughness: 0.4 });
  for (const x of [-0.2, 0.2]) {
    const vat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.5), oilMat);
    vat.position.set(x, 0.86, 0);
    g.add(vat);
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.06, 0.54),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.3 }),
    );
    rim.position.set(x, 0.83, 0);
    g.add(rim);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.18, 0.04), handleMat);
    handle.position.set(x, 0.96, 0.3);
    g.add(handle);
  }
  return g;
}

/** Wood-fired pizza oven — domed brick oven with a fiery mouth + chimney. 2×1. */
function pizzaOven(): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.7, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x9a5a3a, roughness: 0.85 }),
  );
  base.position.y = 0.35;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xb56a44, roughness: 0.8 }),
  );
  dome.position.set(0, 0.7, 0);
  dome.scale.set(1.4, 1.0, 0.95);
  dome.castShadow = true;
  g.add(dome);
  // Arched mouth with fire glow.
  const mouth = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.32, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x1a0e06, roughness: 0.6, emissive: 0xff6a1e, emissiveIntensity: 1.1 }),
  );
  mouth.position.set(0, 0.84, 0.4);
  g.add(mouth);
  const chimney = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.12, 0.5, 12),
    new THREE.MeshStandardMaterial({ color: 0x7a4a30, roughness: 0.85 }),
  );
  chimney.position.set(-0.55, 1.32, -0.12);
  chimney.castShadow = true;
  g.add(chimney);
  return g;
}

// === Cozy decor (procedural — no GLB needed). ===

/** Stone fireplace with a live fire glow + mantel. Floor, 2×1. */
function fireplace(): THREE.Group {
  const g = new THREE.Group();
  const surround = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 1.5, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x8a8278, roughness: 0.9 }),
  );
  surround.position.y = 0.75;
  surround.castShadow = true;
  surround.receiveShadow = true;
  g.add(surround);
  // Dark firebox recess.
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.8, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x16100a, roughness: 1.0 }),
  );
  box.position.set(0, 0.6, 0.18);
  g.add(box);
  // Flames (emissive-only).
  const fireMat = new THREE.MeshStandardMaterial({ color: 0xff6a1e, emissive: 0xff5212, emissiveIntensity: 1.3, roughness: 0.6 });
  for (let i = 0; i < 4; i += 1) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.35 + Math.random() * 0.15, 7), fireMat);
    flame.position.set(-0.3 + i * 0.2, 0.5, 0.2);
    g.add(flame);
  }
  // Logs.
  const logMat = new THREE.MeshStandardMaterial({ color: 0x4a2e1a, roughness: 0.9 });
  for (let i = 0; i < 2; i += 1) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8), logMat);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = i * 0.35;
    log.position.set(0, 0.3 + i * 0.1, 0.2);
    g.add(log);
  }
  // Mantel shelf.
  const mantel = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.1, 0.6),
    new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.7 }),
  );
  mantel.position.set(0, 1.16, 0.06);
  g.add(mantel);
  return g;
}

/** Large potted indoor tree — trunk + layered green canopy. Floor, 1×1. */
function pottedTree(): THREE.Group {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.22, 0.42, 16),
    new THREE.MeshStandardMaterial({ color: 0xb5734a, roughness: 0.8 }),
  );
  pot.position.y = 0.21;
  pot.castShadow = true;
  pot.receiveShadow = true;
  g.add(pot);
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 1.0, 8),
    new THREE.MeshStandardMaterial({ color: 0x6a4830, roughness: 0.85 }),
  );
  trunk.position.y = 0.85;
  trunk.castShadow = true;
  g.add(trunk);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4a7834, roughness: 0.85 });
  const tiers = [
    { y: 1.25, r: 0.42, h: 0.5 },
    { y: 1.6, r: 0.34, h: 0.45 },
    { y: 1.9, r: 0.24, h: 0.4 },
  ];
  for (const t of tiers) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(t.r, t.h, 10), leafMat);
    cone.position.y = t.y;
    cone.castShadow = true;
    g.add(cone);
  }
  return g;
}

/** Vintage grandfather clock — tall wooden case with a glowing pendulum. */
function grandfatherClock(): THREE.Group {
  const g = new THREE.Group();
  const caseMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.9, 0.3), caseMat);
  body.position.y = 0.95;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Clock face.
  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 0.04, 20),
    new THREE.MeshStandardMaterial({ color: 0xf2ead2, roughness: 0.5, emissive: 0x3a3020, emissiveIntensity: 0.12 }),
  );
  face.rotation.x = Math.PI / 2;
  face.position.set(0, 1.6, 0.16);
  g.add(face);
  // Hands.
  const handMat = new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.5 });
  const hh = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.09, 0.01), handMat);
  hh.position.set(0, 1.63, 0.185);
  g.add(hh);
  const mh = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.13, 0.01), handMat);
  mh.position.set(0.03, 1.59, 0.185);
  mh.rotation.z = -0.6;
  g.add(mh);
  // Pendulum (brass, faint glow).
  const pend = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 0.03, 16),
    new THREE.MeshStandardMaterial({ color: 0xc4a44a, metalness: 0.8, roughness: 0.3, emissive: 0x4a3a10, emissiveIntensity: 0.2 }),
  );
  pend.rotation.x = Math.PI / 2;
  pend.position.set(0, 0.7, 0.155);
  g.add(pend);
  // Crown.
  const crown = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.36), caseMat);
  crown.position.y = 1.96;
  g.add(crown);
  return g;
}

/** Living plant wall — a lush green panel of foliage. Wall-mounted. */
function livingWall(): THREE.Group {
  const g = new THREE.Group();
  // Backing panel sits flush against the wall (+Z toward the wall).
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 1.4, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x2e3a24, roughness: 0.9 }),
  );
  back.position.set(0, 0.7, 0.025);
  back.castShadow = true;
  back.receiveShadow = true;
  g.add(back);
  // Foliage tufts in a staggered grid, facing the room (-Z).
  const greens = [0x4a7834, 0x5a8a3e, 0x3e6a2c, 0x6a9a48];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const mat = new THREE.MeshStandardMaterial({ color: greens[(row + col) % greens.length], roughness: 0.85 });
      const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), mat);
      tuft.position.set(-0.4 + col * 0.27, 0.18 + row * 0.28, -0.08);
      tuft.scale.set(1, 0.8, 0.6);
      g.add(tuft);
    }
  }
  return g;
}

/** Back-bar liquor shelf — lit shelves of colorful bottles. Wall-mounted. */
function barBackShelf(): THREE.Group {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.7 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.3, 0.05), frameMat);
  back.position.set(0, 0.65, 0.025);
  back.castShadow = true;
  back.receiveShadow = true;
  g.add(back);
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.6 });
  const bottleColors = [0x2a6a3a, 0xa83a2a, 0xc4a44a, 0x3a5a9a, 0x7a3a6a, 0xd6c068];
  for (let row = 0; row < 3; row += 1) {
    const shelfY = 0.25 + row * 0.42;
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.04, 0.16), shelfMat);
    shelf.position.set(0, shelfY, -0.07);
    g.add(shelf);
    // Backlight strip (emissive-only).
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.02, 0.01),
      new THREE.MeshStandardMaterial({ color: 0xffe0a0, emissive: 0xffd890, emissiveIntensity: 0.8 }),
    );
    glow.position.set(0, shelfY + 0.34, -0.02);
    g.add(glow);
    for (let i = 0; i < 6; i += 1) {
      const mat = new THREE.MeshStandardMaterial({ color: bottleColors[(row * 6 + i) % bottleColors.length], roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.9 });
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.28, 8), mat);
      bottle.position.set(-0.46 + i * 0.185, shelfY + 0.16, -0.07);
      g.add(bottle);
    }
  }
  return g;
}

/** Framed vintage travel poster — warm-toned wall art. Wall-mounted. */
function vintagePoster(): THREE.Group {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.86, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.6 }),
  );
  frame.castShadow = true;
  g.add(frame);
  // Poster face (-Z toward the room), banded like a retro print.
  const bands = [0xe0a85a, 0xd6743a, 0x6a9a8a, 0x3a5a6a];
  for (let i = 0; i < 4; i += 1) {
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.19, 0.02),
      new THREE.MeshStandardMaterial({ color: bands[i], roughness: 0.6, emissive: bands[i], emissiveIntensity: 0.1 }),
    );
    band.position.set(0, 0.3 - i * 0.2, -0.035);
    g.add(band);
  }
  return g;
}

/** Ornate round wall clock. Wall-mounted. */
function wallClock(): THREE.Group {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.26, 0.035, 10, 24),
    new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.6 }),
  );
  rim.position.z = -0.04;
  g.add(rim);
  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.24, 0.03, 28),
    new THREE.MeshStandardMaterial({ color: 0xf4eeda, roughness: 0.5, emissive: 0x322a18, emissiveIntensity: 0.1 }),
  );
  face.rotation.x = Math.PI / 2;
  face.position.z = -0.05;
  g.add(face);
  const handMat = new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.5 });
  const hh = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.13, 0.01), handMat);
  hh.position.set(0, 0.03, -0.075);
  g.add(hh);
  const mh = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.19, 0.01), handMat);
  mh.position.set(0.05, -0.02, -0.075);
  mh.rotation.z = -0.7;
  g.add(mh);
  return g;
}

/** Persian-style rug — flat ornamental floor covering. */
function persianRug(): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.02, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x7a2a24, roughness: 0.95 }),
  );
  base.receiveShadow = true;
  g.add(base);
  // Border.
  const border = new THREE.Mesh(
    new THREE.BoxGeometry(0.86, 0.022, 0.58),
    new THREE.MeshStandardMaterial({ color: 0x244a5a, roughness: 0.95 }),
  );
  border.position.y = 0.001;
  g.add(border);
  // Center medallion.
  const medallion = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.024, 0.28),
    new THREE.MeshStandardMaterial({ color: 0xc4a44a, roughness: 0.9 }),
  );
  medallion.position.y = 0.002;
  g.add(medallion);
  return g;
}

/** A cluster of three lit candles on a base. Sits on a table/surface. */
function candleCenterpiece(): THREE.Group {
  const g = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.14, 0.03, 16),
    new THREE.MeshStandardMaterial({ color: 0x8a6a3a, metalness: 0.5, roughness: 0.4 }),
  );
  plate.position.y = 0.015;
  g.add(plate);
  const waxMat = new THREE.MeshStandardMaterial({ color: 0xf2e6c8, roughness: 0.6 });
  const flameMat = new THREE.MeshStandardMaterial({ color: 0xffd060, emissive: 0xffc23a, emissiveIntensity: 1.6, roughness: 0.4 });
  const spots = [
    { x: 0, z: 0, h: 0.18 },
    { x: -0.07, z: 0.05, h: 0.12 },
    { x: 0.07, z: 0.05, h: 0.14 },
  ];
  for (const s of spots) {
    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, s.h, 10), waxMat);
    candle.position.set(s.x, 0.03 + s.h / 2, s.z);
    g.add(candle);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 7), flameMat);
    flame.position.set(s.x, 0.03 + s.h + 0.03, s.z);
    g.add(flame);
  }
  return g;
}

/** Elegant chandelier — brass ring of candle-bulbs. Ceiling-mounted.
 * Authored bottom-at-y=0 so placementY("ceiling") hangs its top at the
 * ceiling and the body drops ~0.5 m into the room (mirrors hanging-plant). */
function chandelier(): THREE.Group {
  const g = new THREE.Group();
  const brass = new THREE.MeshStandardMaterial({ color: 0xc4a44a, metalness: 0.8, roughness: 0.3 });
  // Drop rod from the ceiling.
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 8), brass);
  rod.position.y = 0.65;
  g.add(rod);
  // Ring.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.025, 8, 22), brass);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.4;
  g.add(ring);
  // Arms + candle bulbs (emissive-only).
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xffe49a, emissiveIntensity: 1.5, roughness: 0.4 });
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 6), brass);
    arm.position.set(Math.cos(a) * 0.16, 0.42, Math.sin(a) * 0.16);
    arm.rotation.z = Math.PI / 2;
    arm.rotation.y = -a;
    g.add(arm);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.03, 0.05, 8), brass);
    cup.position.set(Math.cos(a) * 0.32, 0.44, Math.sin(a) * 0.32);
    g.add(cup);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), bulbMat);
    bulb.position.set(Math.cos(a) * 0.32, 0.51, Math.sin(a) * 0.32);
    g.add(bulb);
  }
  return g;
}

/** A swag of warm string lights. Ceiling-mounted; drapes a gentle catenary. */
function stringLights(): THREE.Group {
  const g = new THREE.Group();
  const wireMat = new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.6 });
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffe6a0, emissive: 0xffd87a, emissiveIntensity: 1.3, roughness: 0.4 });
  // 9 bulbs strung in a shallow droop across the tile, near the ceiling.
  const n = 9;
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const x = -0.45 + t * 0.9;
    // Catenary-ish droop, deepest in the middle.
    const droop = Math.sin(t * Math.PI) * 0.18;
    const y = 0.55 - droop;
    const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.13, 5), wireMat);
    wire.position.set(x, y + 0.06, 0);
    g.add(wire);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), bulbMat);
    bulb.position.set(x, y, 0);
    g.add(bulb);
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
  // Cooking stations.
  "grill-station": () => grillStation(),
  "oven-station": () => ovenStation(),
  "fryer-station": () => fryerStation(),
  "pizza-oven": () => pizzaOven(),
  // Cozy decor.
  "fireplace": () => fireplace(),
  "potted-tree": () => pottedTree(),
  "grandfather-clock": () => grandfatherClock(),
  "living-wall": () => livingWall(),
  "bar-back-shelf": () => barBackShelf(),
  "vintage-poster": () => vintagePoster(),
  "wall-clock": () => wallClock(),
  "persian-rug": () => persianRug(),
  "candle-centerpiece": () => candleCenterpiece(),
  "chandelier": () => chandelier(),
  "string-lights": () => stringLights(),
};
