import * as THREE from "three";

/**
 * DEBUG-ONLY skinned/animated test character, loaded from Mixamo FBX exports
 * (each file = the full rigged mesh + one clip). Spun up on demand via the
 * `window.cozyTestChar()` console hook in Engine — it is NOT part of normal
 * play and nothing references it unless you call that hook.
 *
 * This is the FIRST skeletal-animation path in the game: every existing
 * character is a static TripoSR mesh faked alive by the procedural
 * CharacterAnimator. The point here is to evaluate a real rigged character
 * (and prove the FBX + AnimationMixer pipeline works in-scene) before any
 * production integration into the guest/staff systems.
 */

const FILES: { name: string; file: string }[] = [
  { name: "walking",     file: "walking.fbx" },
  { name: "sittingIdle", file: "sitting-idle.fbx" },
  { name: "standToSit",  file: "stand-to-sit.fbx" },
  { name: "sitToStand",  file: "sit-to-stand.fbx" },
];

/** Auto-cycle so you see all four without typing: walk → sit down → sit idle
 * → stand up → (repeat). Loop steps hold for `hold` seconds; the one-shot
 * transitions run for their full clip duration. */
const SEQUENCE: { name: string; hold: number; loop: boolean }[] = [
  { name: "walking",     hold: 4, loop: true  },
  { name: "standToSit",  hold: 0, loop: false },
  { name: "sittingIdle", hold: 4, loop: true  },
  { name: "sitToStand",  hold: 0, loop: false },
];

export interface TestCharHandle {
  root: THREE.Object3D;
  /** Drive the AnimationMixer — call once per frame with real seconds. */
  update(dt: number): void;
  /** Manually hold one clip on loop (stops the auto-cycle). */
  setAnim(name: string): void;
  /** Resume the auto-cycle. */
  cycle(): void;
  clipNames(): string[];
  /** Reposition (restaurant-LOCAL x,z) so you can drop him on clear floor. */
  moveTo(x: number, z: number): void;
  dispose(): void;
}

/** Load the test character, parent it under `parent` at `localPos`, and
 * return a handle. The caller owns calling update(dt) each frame. */
export async function spawnTestCharacter(
  parent: THREE.Object3D,
  localPos: THREE.Vector3,
  baseUrl: string,
): Promise<TestCharHandle> {
  // Code-split: FBXLoader (and its fflate dep) only load when this is called.
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  const loader = new FBXLoader();
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const fbxs = await Promise.all(
    FILES.map((f) => loader.loadAsync(`${base}assets/test-char/${f.file}`)),
  );

  // First file is the rendered body (mesh + skeleton). Collect EVERY file's
  // clip — they share the same Mixamo rig, so they all retarget onto this one
  // skeleton. Mixamo names every clip "mixamo.com", so rename by source file.
  const body = fbxs[0];
  const clips: THREE.AnimationClip[] = [];
  fbxs.forEach((fbx, i) => {
    const clip = fbx.animations[0];
    if (clip) { clip.name = FILES[i].name; clips.push(clip); }
  });

  // Mixamo exports in centimetres → scale to metres (~1.8m, matching the
  // game's ~1.7m characters). Then drop the feet to the parent's local y=0.
  body.scale.setScalar(0.01);
  body.updateWorldMatrix(true, true);
  const bbox = new THREE.Box3().setFromObject(body);
  const feetLift = Number.isFinite(bbox.min.y) ? -bbox.min.y : 0;
  body.position.set(localPos.x, localPos.y + feetLift, localPos.z);
  body.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
  parent.add(body);

  const mixer = new THREE.AnimationMixer(body);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of clips) actions.set(clip.name, mixer.clipAction(clip));

  let manual = false;
  let stepIdx = 0;
  let stepTime = 0;
  let current: THREE.AnimationAction | null = null;

  const clipDuration = (name: string): number =>
    clips.find((c) => c.name === name)?.duration ?? 1;

  const fadeTo = (name: string, loop: boolean): void => {
    const action = actions.get(name);
    if (!action) return;
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.enabled = true;
    if (current && current !== action) current.crossFadeTo(action, 0.3, false);
    action.play();
    current = action;
  };

  const playStep = (idx: number): void => {
    fadeTo(SEQUENCE[idx].name, SEQUENCE[idx].loop);
    stepTime = 0;
  };
  playStep(0);

  return {
    root: body,
    update(dt: number) {
      mixer.update(dt);
      if (manual) return;
      stepTime += dt;
      const step = SEQUENCE[stepIdx];
      const dur = step.loop ? step.hold : clipDuration(step.name);
      if (stepTime >= dur) {
        stepIdx = (stepIdx + 1) % SEQUENCE.length;
        playStep(stepIdx);
      }
    },
    setAnim(name: string) { manual = true; fadeTo(name, true); },
    cycle() { manual = false; playStep(stepIdx); },
    clipNames() { return clips.map((c) => c.name); },
    moveTo(x, z) { body.position.x = x; body.position.z = z; },
    dispose() {
      mixer.stopAllAction();
      parent.remove(body);
      body.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
      });
    },
  };
}
