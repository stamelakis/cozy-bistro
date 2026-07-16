import * as THREE from "three";
import { sharedRiggedLoader, riggedStaffModel } from "../scene/RiggedCharacter";

/**
 * The tutorial's presenter — a large render of the CHEF model playing his real
 * idle clip, so the guide has a face and a bit of life instead of being a
 * faceless text overlay.
 *
 * Same approach as StaffPortraits (its own tiny offscreen GL context, blitted
 * into a plain 2-D canvas) but full-body and bigger. Degrades quietly to the
 * caller's fallback if WebGL or the GLB isn't available.
 */

const SIZE = 320;
/** The idle clip is a slow breathe; 20fps is plenty and stays well clear of the
 * main renderer's budget. */
const FPS = 20;
/** The rig faces -Z (RiggedCharacter applies a π FORWARD_OFFSET to the Mixamo
 * +Z rigs), so the camera sits on the -Z side to see his FRONT. Slight offset
 * gives a friendly three-quarter view. */
const VIEW_DIR = new THREE.Vector3(0.28, 0.10, -1).normalize();

/**
 * Framing comes from KNOWN rig numbers, never Box3.setFromObject — that reads
 * the BIND pose, which RiggedCharacter warns is "hip-centred, which misleads a
 * bbox/bone computation into floating the body ~0.9 m" (it cut every head off
 * when the staff portraits tried it). Animated truth: clips are authored
 * FEET-AT-ORIGIN and RIGGED_SCALE 0.9 on a ~2 m GLB lands ~1.8 m tall.
 */
const RIG_HEIGHT = 1.8;
/** Whole body, slightly loose so he never touches the frame edge. */
const FRAME_CENTER_Y = RIG_HEIGHT * 0.5;
const FRAME_HALF = RIG_HEIGHT * 0.62;

export class TutorialChef {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private cam: THREE.OrthographicCamera | null = null;
  private controller: { update(dt: number, action: "idle"): void } | null = null;
  private target: HTMLCanvasElement | null = null;
  private raf = 0;
  private lastMs = 0;
  private acc = 0;
  private running = false;

  /** Point the presenter at a canvas and begin loading the chef. */
  async mount(canvas: HTMLCanvasElement): Promise<boolean> {
    this.target = canvas;
    const modelId = riggedStaffModel("chef");
    if (!modelId) return false;
    try {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      r.setSize(SIZE, SIZE);
      r.setPixelRatio(1);
      r.setClearColor(0x000000, 0);
      r.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer = r;
    } catch {
      return false; // no GL context to spare
    }
    const { root, controller } = await sharedRiggedLoader.createInstance(modelId);
    this.controller = controller;

    const scene = new THREE.Scene();
    scene.add(root);
    scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const key = new THREE.DirectionalLight(0xfff4e2, 1.25);
    key.position.set(3, 6, -5); // in front, so his face is lit
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xdfe8ff, 0.45);
    rim.position.set(-4, 3, 4);
    scene.add(rim);
    this.scene = scene;

    const focus = new THREE.Vector3(0, FRAME_CENTER_Y, 0);
    const dist = 10;
    const cam = new THREE.OrthographicCamera(
      -FRAME_HALF, FRAME_HALF, FRAME_HALF, -FRAME_HALF, 0.01, dist * 2 + 20,
    );
    cam.up.set(0, 1, 0);
    cam.position.copy(focus).addScaledVector(VIEW_DIR, dist);
    cam.lookAt(focus);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.cam = cam;
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMs = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly loop = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastMs) / 1000);
    this.lastMs = now;
    this.acc += dt;
    if (this.acc < 1 / FPS) return;
    const step = this.acc;
    this.acc = 0;
    this.render(step);
  };

  /** One render+blit. Exposed so the step engine (and tests) can paint a frame
   * without waiting on rAF — the preview pane runs pages hidden, which pauses
   * rAF entirely. */
  render(dt: number): void {
    const { renderer, scene, cam, controller, target } = this;
    if (!renderer || !scene || !cam || !controller || !target || !target.isConnected) return;
    controller.update(dt, "idle");
    renderer.render(scene, cam);
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(renderer.domElement, 0, 0, target.width, target.height);
  }

  dispose(): void {
    this.stop();
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.cam = null;
    this.controller = null;
    this.target = null;
  }
}
