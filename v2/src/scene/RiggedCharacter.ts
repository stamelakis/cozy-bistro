import * as THREE from "three";
import type { CharacterAction } from "./CharacterAnimator";

/**
 * Production rigged-character path: the new skinned GLB models that replace the
 * static placeholder meshes. Each GLB is a single skinned mesh with embedded
 * clips — customers carry a sit cycle (Walking / Stand_To_Sit / Sitting_Idle /
 * Sit_To_Stand), staff carry Walking + one work gesture. One load per model id
 * (cached); a fresh skeleton clone per instance.
 *
 * The GLBs are EXT_meshopt_compressed (optimised ~8 MB → ~1.2 MB each), so the
 * GLTFLoader is wired with the Meshopt decoder.
 */

/** The 8 customer models (street pedestrians + seated guests). */
export const RIGGED_CUSTOMER_IDS = [
  "businessman", "carreerwoman", "oldlady", "oldman",
  "bohemiangirl", "bohemianboy", "teenboy", "teengirl",
] as const;

/** Staff role → model id. */
export const RIGGED_STAFF_IDS = {
  chef: "chef",
  waiter: "waiter",
  errand: "errandboy",
  barman: "barman",
} as const;

/** Rigged model id for a staff role, or undefined when there's no model. */
export function riggedStaffModel(role: string): string | undefined {
  return role === "chef" ? RIGGED_STAFF_IDS.chef
    : role === "waiter" ? RIGGED_STAFF_IDS.waiter
    : role === "errand" ? RIGGED_STAFF_IDS.errand
    : role === "barman" ? RIGGED_STAFF_IDS.barman
    : undefined;
}

// Tuning (verified in-engine on the businessman model). The GLBs are ~2 m tall
// at scale 1; 0.9 lands them ~1.8 m, matching the furniture. These are Mixamo
// rigs that face +Z, so π flips that onto the game's "facingY 0 = -Z" forward
// (same as the FBX guy). Their clips are authored standing on y=0, so no
// feet-lift is needed.
const RIGGED_SCALE = 0.9;
const FORWARD_OFFSET = Math.PI;

/** Map a clip's GLB name to the controller's canonical state name. */
function normalizeClip(name: string): string {
  const n = name.toLowerCase().replace(/[\s_]+/g, "");
  if (n.includes("walk")) return "walk";
  if (n.includes("standtosit")) return "standToSit";
  if (n.includes("sittostand")) return "sitToStand";
  if (n.includes("sit")) return "sittingIdle"; // Sitting / Sitting_Idle (seated)
  if (n.includes("idle")) return "idle"; // standing idle (the new stand-idle clip)
  return "work"; // Using_A_Fax_Machine / Pick_Fruit / any other gesture
}

/** Pick a deterministic customer model for a given key (guest id / ped id) so
 * the same character always renders as the same model. */
export function riggedCustomerForKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return RIGGED_CUSTOMER_IDS[h % RIGGED_CUSTOMER_IDS.length];
}

/**
 * Drives one instance's AnimationMixer from the game's action enum. Adapts to
 * the clips the model actually has:
 *   customers (sit cycle): walk when moving, stand-idle when still; sit →
 *                          standToSit→sittingIdle; rise → sitToStand.
 *   staff / NPCs:          work gesture while working, walk when moving,
 *                          stand-idle when still.
 * Models with no stand-idle clip fall back to the walk loop when still.
 */
export class RiggedController {
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = "";
  private readonly hasSit: boolean;
  private readonly hasWork: boolean;
  private readonly hasIdle: boolean;
  private phase: "up" | "sittingDown" | "sitting" | "standingUp" = "up";
  private transitionLeft = 0;

  constructor(
    private readonly mixer: THREE.AnimationMixer,
    private readonly clips: THREE.AnimationClip[],
  ) {
    for (const c of clips) this.actions.set(c.name, mixer.clipAction(c));
    this.hasSit = this.actions.has("standToSit") && this.actions.has("sittingIdle");
    this.hasWork = this.actions.has("work");
    this.hasIdle = this.actions.has("idle");
    this.fadeTo(this.standClip(), true);
  }

  /** Clip to play when standing still: the new stand-idle if the model has it,
   * else the walk loop (older models without an idle clip). */
  private standClip(): string {
    return this.hasIdle ? "idle" : "walk";
  }

  private dur(name: string): number {
    return this.clips.find((c) => c.name === name)?.duration ?? 0.5;
  }

  private fadeTo(name: string, loop: boolean): void {
    if (name === this.currentName && this.current) return; // already playing
    const a = this.actions.get(name);
    if (!a) return;
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.enabled = true;
    if (this.current && this.current !== a) this.current.crossFadeTo(a, 0.25, false);
    a.play();
    this.current = a;
    this.currentName = name;
  }

  /** Called each visible frame by CharacterAnimator (after cull). */
  update(dt: number, action: CharacterAction): void {
    this.mixer.update(dt);
    if (!this.hasSit) {
      // Staff / standing NPCs: the work gesture (cook / mix / serve at a
      // station) plays only while working (StaffRouter sets action "carry");
      // walking plays the walk loop; standing still plays the stand-idle clip.
      const clip = action === "carry" && this.hasWork ? "work"
        : action === "walk" ? "walk"
        : this.standClip();
      this.fadeTo(clip, true);
      return;
    }
    const wantSit = action === "sit";
    switch (this.phase) {
      case "up":
        if (wantSit) { this.fadeTo("standToSit", false); this.phase = "sittingDown"; this.transitionLeft = this.dur("standToSit"); }
        else this.fadeTo(action === "walk" ? "walk" : this.standClip(), true);
        break;
      case "sittingDown":
        this.transitionLeft -= dt;
        if (this.transitionLeft <= 0) { this.fadeTo("sittingIdle", true); this.phase = "sitting"; }
        break;
      case "sitting":
        if (!wantSit) { this.fadeTo("sitToStand", false); this.phase = "standingUp"; this.transitionLeft = this.dur("sitToStand"); }
        break;
      case "standingUp":
        this.transitionLeft -= dt;
        if (this.transitionLeft <= 0) { this.fadeTo("walk", true); this.phase = "up"; }
        break;
    }
  }

  /** True while a one-shot transition (sit-down / stand-up) is mid-play, so the
   * mover holds the body still — otherwise it slides across the floor while the
   * character is getting up or down. Loops (walk/idle/work/seated) aren't
   * transitions. */
  isTransitioning(): boolean {
    return this.phase === "sittingDown" || this.phase === "standingUp";
  }

  stop(): void { this.mixer.stopAllAction(); }
}

/** Loads a rigged GLB once (cached) and stamps out per-instance skeleton clones. */
export class RiggedCharacterLoader {
  private readonly cache = new Map<string, Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[]; feetLift: number }>>();
  private loaderPromise: Promise<import("three/examples/jsm/loaders/GLTFLoader.js").GLTFLoader> | null = null;

  constructor(private readonly baseUrl: string) {}

  private getLoader() {
    if (!this.loaderPromise) {
      this.loaderPromise = (async () => {
        const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
        const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        return loader;
      })();
    }
    return this.loaderPromise;
  }

  private load(modelId: string) {
    let p = this.cache.get(modelId);
    if (!p) {
      p = (async () => {
        const loader = await this.getLoader();
        const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
        const gltf = await loader.loadAsync(`${base}assets/characters/rigged/${modelId}.glb`);
        const scene = gltf.scene;
        scene.scale.setScalar(RIGGED_SCALE);
        // Every clip (which always plays) is authored standing feet-at-origin,
        // so no feet-lift is needed — verified: feet land exactly on the floor
        // with 0. (The bind pose is hip-centred, which misleads a bbox/bone
        // computation into floating the body ~0.9 m.)
        const feetLift = 0;
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        const clips = gltf.animations.map((c) => { c.name = normalizeClip(c.name); return c; });
        return { scene, clips, feetLift };
      })();
      this.cache.set(modelId, p);
    }
    return p;
  }

  /** Warm a model's GLB in the background so the first spawn doesn't stall. */
  prewarm(modelId: string): void { void this.load(modelId).catch(() => { /* surfaced on first real use */ }); }

  /** Build one instance: a wrapper Group (what CharacterAnimator moves/rotates)
   * holding a fresh skeleton clone, plus its controller. */
  async createInstance(modelId: string): Promise<{ root: THREE.Group; controller: RiggedController }> {
    const { scene, clips, feetLift } = await this.load(modelId);
    const { clone } = await import("three/examples/jsm/utils/SkeletonUtils.js");
    const inner = clone(scene) as THREE.Object3D;
    inner.rotation.y = FORWARD_OFFSET;
    inner.position.y = feetLift;
    const wrapper = new THREE.Group();
    wrapper.add(inner);
    const mixer = new THREE.AnimationMixer(inner);
    return { root: wrapper, controller: new RiggedController(mixer, clips) };
  }
}

/** Process-wide shared loader so guests, pedestrians, and staff all hit ONE GLB
 * cache — each model file is fetched + parsed only once. */
export const sharedRiggedLoader = new RiggedCharacterLoader(import.meta.env.BASE_URL ?? "/");
