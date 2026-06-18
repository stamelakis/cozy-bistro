import * as THREE from "three";
import type { CharacterAction } from "./CharacterAnimator";

/**
 * The game's FIRST rigged/skinned character path — a real customer with
 * skeletal animation, living alongside the static TripoSR guests that the
 * procedural CharacterAnimator fakes alive. Loaded from the Mixamo FBX
 * exports (each file = full rigged mesh + one clip); one shared load is
 * cloned (skeleton + all) per guest instance.
 *
 * NOTE: reuses the 4 test-char FBX (~24MB). Before this ships widely, bake
 * them into ONE slim GLB (mesh + 4 clips) and swap the loader to GLTFLoader.
 */

const FILES: { name: string; file: string }[] = [
  { name: "walking",     file: "walking.fbx" },
  { name: "sittingIdle", file: "sitting-idle.fbx" },
  { name: "standToSit",  file: "stand-to-sit.fbx" },
  { name: "sitToStand",  file: "sit-to-stand.fbx" },
];

// The game's static GLBs (and the mover's `facingY = atan2(-dx, -dz)`) use
// FORWARD = -Z. This Mixamo character's forward is +Z (its walk root motion
// travels +Z), i.e. the opposite, so rotate the inner mesh by π to flip +Z
// onto -Z. Then CharacterAnimator's facingY drives it exactly like a static
// guest and he faces his direction of travel.
const FORWARD_OFFSET = Math.PI;

/**
 * Drives one guest's AnimationMixer from the game's action enum:
 *   walk / idle  → walking (loop)        [no standing-idle clip yet]
 *   sit          → standToSit (once) → sittingIdle (loop)
 *   leaving sit  → sitToStand (once) → walking (loop)
 */
export class SkeletalController {
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private phase: "standing" | "sittingDown" | "sitting" | "standingUp" = "standing";
  private transitionLeft = 0;

  constructor(
    private readonly mixer: THREE.AnimationMixer,
    private readonly clips: THREE.AnimationClip[],
  ) {
    for (const c of clips) this.actions.set(c.name, mixer.clipAction(c));
    this.fadeTo("walking", true);
  }

  private dur(name: string): number {
    return this.clips.find((c) => c.name === name)?.duration ?? 0.5;
  }

  private fadeTo(name: string, loop: boolean): void {
    const a = this.actions.get(name);
    if (!a) return;
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.enabled = true;
    if (this.current && this.current !== a) this.current.crossFadeTo(a, 0.25, false);
    a.play();
    this.current = a;
  }

  /** Called each visible frame by CharacterAnimator (after cull). */
  update(dt: number, action: CharacterAction): void {
    this.mixer.update(dt);
    const wantSit = action === "sit";
    switch (this.phase) {
      case "standing":
        if (wantSit) { this.fadeTo("standToSit", false); this.phase = "sittingDown"; this.transitionLeft = this.dur("standToSit"); }
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
        if (this.transitionLeft <= 0) { this.fadeTo("walking", true); this.phase = "standing"; }
        break;
    }
  }

  stop(): void { this.mixer.stopAllAction(); }
}

/** Loads the rigged guest ONCE (cached) and stamps out per-guest clones. */
export class SkinnedCharacterLoader {
  private cache: Promise<{ base: THREE.Object3D; clips: THREE.AnimationClip[]; feetLift: number }> | null = null;

  constructor(private readonly baseUrl: string) {}

  private load() {
    if (!this.cache) {
      this.cache = (async () => {
        const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
        const loader = new FBXLoader();
        const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
        const fbxs = await Promise.all(FILES.map((f) => loader.loadAsync(`${base}assets/test-char/${f.file}`)));
        const mesh = fbxs[0];
        mesh.scale.setScalar(0.01); // Mixamo cm → metres (~1.8m)
        mesh.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(mesh);
        const feetLift = Number.isFinite(box.min.y) ? -box.min.y : 0;
        mesh.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
        const clips = fbxs
          .map((fbx, i) => { const c = fbx.animations[0]; if (c) c.name = FILES[i].name; return c; })
          .filter((c): c is THREE.AnimationClip => !!c);
        // The Mixamo clips carry ROOT MOTION: the Hips translate ~1.75 m
        // forward per walk cycle. The engine drives the character's XZ
        // position itself (via groundPos), so that root motion fights it —
        // the body lurches forward then snaps back each cycle, drifting off
        // the path and clipping through stairs / furniture. Pin the Hips X/Z
        // to their first-frame value so every clip plays IN PLACE
        // horizontally; keep Y (the vertical bob, and the sit-down drop the
        // sit clips legitimately need).
        for (const clip of clips) {
          for (const t of clip.tracks) {
            if (/Hips\.position$/i.test(t.name)) {
              const v = t.values;
              const x0 = v[0], z0 = v[2];
              for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
            }
          }
        }
        return { base: mesh, clips, feetLift };
      })();
    }
    return this.cache;
  }

  /** Kick off the (one-time, cached) load early so the first new-face guest
   * doesn't stall on the 24MB download mid-spawn. */
  prewarm(): void { void this.load().catch(() => { /* surfaced again on first use */ }); }

  /** Build one guest instance: a wrapper Group (what CharacterAnimator moves
   * + rotates) holding a fresh skeleton clone, plus its controller. */
  async createInstance(): Promise<{ root: THREE.Group; controller: SkeletalController }> {
    const { base, clips, feetLift } = await this.load();
    const { clone } = await import("three/examples/jsm/utils/SkeletonUtils.js");
    const inner = clone(base) as THREE.Object3D;
    inner.rotation.y = FORWARD_OFFSET;
    inner.position.y = feetLift; // lift feet to the wrapper's local y=0
    const wrapper = new THREE.Group();
    wrapper.add(inner);
    const mixer = new THREE.AnimationMixer(inner);
    return { root: wrapper, controller: new SkeletalController(mixer, clips) };
  }
}
