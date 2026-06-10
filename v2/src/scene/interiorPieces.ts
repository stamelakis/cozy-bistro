import * as THREE from "three";

/**
 * Shared procedural interior pieces — staircase flights, supply
 * counter, and lamp lights. Extracted out of WorldScene so visit
 * mode (VisitMode.ts) can render the same fixtures the host sees on
 * their own restaurant, keeping the two views structurally identical
 * for multi-storey buildings and lit interiors.
 *
 * Each function takes a target Three.js parent and writes meshes /
 * lights into it. No instance state — pure procedural geometry with
 * the host's canonical coords (10×10 footprint shifted by +0.5, back-
 * left staircase, back-wall supply counter).
 */

/** Meters between adjacent floor slabs — mirrors
 * WorldScene.STOREY_HEIGHT and wallBuilder's STOREY_HEIGHT. */
const STOREY_HEIGHT = 3.0;

/** Visual staircase flight rising from the floor below `baseY` up to
 * a slab at `baseY`. Mirrors WorldScene.addStaircaseSegment exactly:
 * 10 steps along the back-left corner, banister rail rotated to match
 * the slope, two end posts. Materials are tan / dark-tan procedural
 * stand-ins for a wooden staircase.
 *
 * Parented under `parent` (the host parents under each storey group;
 * visit mode uses the visitorRoot directly). Coords are local to the
 * parent — both the host's storey groups and visit mode's visitorRoot
 * share the same +0.5 / +0.5 footprint shift on their child meshes,
 * so the same numbers produce a visually identical staircase. */
export function buildStaircaseFlight(parent: THREE.Object3D, baseY: number): void {
  const STEP_COUNT = 10;
  const STEP_WIDTH = 1.0;                              // X span
  const STEP_DEPTH = 0.3;                              // Z span per step → 3 m total run, 45° slope
  const STEP_RISE  = STOREY_HEIGHT / STEP_COUNT;       // 0.3 m (matches depth for a 1:1 ratio)
  const X_CENTER   = -3.9;                             // flush against the left interior wall (X=-4.4)
  // The TOP of the flight sits at the back-left corner so the climber
  // walks INTO the corner. With STEP_DEPTH=0.3 and 10 steps the top
  // step's centre lands at Z=-4.3 — right against the back wall
  // (interior face at Z=-4.4). Bottom of the flight extends 3 m
  // south into the open floor (down to Z≈-1.5).
  const Z_BOTTOM   = -1.45;                            // low end, ~3 m south of back wall
  const runLen     = STEP_COUNT * STEP_DEPTH;          // 3 m total run
  const lowerY     = baseY - STOREY_HEIGHT;
  const stepMat = new THREE.MeshStandardMaterial({
    color: 0xb0967a, roughness: 0.78, metalness: 0,
  });
  for (let i = 0; i < STEP_COUNT; i += 1) {
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(STEP_WIDTH, STEP_RISE, STEP_DEPTH),
      stepMat,
    );
    step.position.set(
      X_CENTER,
      lowerY + STEP_RISE * (i + 0.5),
      Z_BOTTOM - STEP_DEPTH * (i + 0.5),
    );
    step.castShadow = true;
    step.receiveShadow = true;
    parent.add(step);
  }
  // Slim banister along the open (east-facing) edge so the stairs
  // read as a staircase from the iso angle, not just stacked slabs.
  const banisterMat = new THREE.MeshStandardMaterial({
    color: 0x8a6e54, roughness: 0.7,
  });
  const railX = X_CENTER + STEP_WIDTH / 2 - 0.04;
  const railLen = Math.sqrt(runLen * runLen + STOREY_HEIGHT * STOREY_HEIGHT);
  const railThickness = 0.04;
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(railThickness, railThickness, railLen),
    banisterMat,
  );
  rail.position.set(
    railX,
    lowerY + STOREY_HEIGHT / 2 + 0.85,
    Z_BOTTOM - runLen / 2,
  );
  rail.rotation.x = Math.atan2(STOREY_HEIGHT, runLen);
  rail.castShadow = true;
  parent.add(rail);
  for (const t of [0, 1]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(railThickness, 0.95, railThickness),
      banisterMat,
    );
    post.position.set(
      railX,
      lowerY + t * STOREY_HEIGHT + 0.45,
      Z_BOTTOM - t * runLen,
    );
    post.castShadow = true;
    parent.add(post);
  }
}

/** Back-wall supply counter mesh — the errand helper reports here
 * after each shopping trip. Cabinet body + lighter wooden top + two
 * small crates. Position hugs the back wall at the canonical
 * stoveFurniturePos offset (= (0, -4) minus (3, 0.05)).
 *
 * The host uses this.stoveFurniturePos for the offset; visit mode
 * uses the same hardcoded canonical layout since every restaurant in
 * v1 shares the same kitchen position. */
export function buildSupplyCounterMesh(parent: THREE.Object3D): void {
  const counter = new THREE.Group();
  // Same offset the host applies: stoveFurniturePos (0, -4) minus
  // (3, 0.05) → back-left of the kitchen line at the back wall.
  counter.position.set(-3, 0, -4.05);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.85, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x9a7a55, roughness: 0.85 }),
  );
  body.position.set(0, 0.425, 0.15);
  body.castShadow = true;
  body.receiveShadow = true;
  counter.add(body);
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.06, 0.75),
    new THREE.MeshStandardMaterial({ color: 0xcfb48a, roughness: 0.6 }),
  );
  top.position.set(0, 0.88, 0.15);
  top.castShadow = true;
  counter.add(top);
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x8c6a40, roughness: 0.9 });
  const crate1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.28), crateMat);
  crate1.position.set(-0.25, 1.02, 0.10);
  crate1.castShadow = true;
  counter.add(crate1);
  const crate2 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.22), crateMat);
  crate2.position.set(0.20, 1.00, 0.20);
  crate2.castShadow = true;
  counter.add(crate2);
  parent.add(counter);
}

/** Furniture def ids that count as "lamps" — anything that should
 * emit warm light from the bulb position. Matches the host's
 * registerLamp dispatch (which keys off `def.category === "lighting"`
 * plus a few specific ids); visit mode lookups against this set
 * instead of going through the catalog lookup so the helper stays
 * self-contained. Keep in sync with data/furnitureCatalog if new
 * lamp defs are added. */
const LAMP_DEF_IDS = new Set<string>([
  "lamp", "lamp-floor", "lamp-table", "lamp-hanging",
  "pendant", "pendant-light", "chandelier",
  "wall-sconce", "sconce",
]);

/** True if the given furniture def id should get a warm point light
 * attached when loaded. */
export function isLampDefId(defId: string): boolean {
  return LAMP_DEF_IDS.has(defId);
}

/** Attach a warm point light to a placed lamp's model.  Adds the
 * light as a child of the model so it inherits the lamp's world
 * position automatically.  Light is a simple stand-in (no host-side
 * pool / no max-lamps cap / no day-night dimming) — visit mode is
 * read-only and one-shot, the host's full lighting management isn't
 * needed.  Returns the created light (caller can keep a reference
 * for later disposal if wanted; visit mode just lets the scene-
 * graph teardown handle it). */
export function attachLampLight(model: THREE.Object3D, defId: string): THREE.PointLight | null {
  if (!isLampDefId(defId)) return null;
  const light = new THREE.PointLight(0xffd6a0, 1.6, 5.0, 1.8);
  // Lift the light to roughly bulb height. Different lamps have
  // bulbs at different positions; 1.3 m is a reasonable average for
  // table + floor + pendant lamps without a per-def lookup.
  light.position.set(0, 1.3, 0);
  light.castShadow = false; // visit mode renders many models; skip shadows for perf.
  model.add(light);
  return light;
}
