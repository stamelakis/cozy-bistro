import * as THREE from "three";
import { sharedRiggedLoader, riggedStaffModel } from "../scene/RiggedCharacter";
import type { StaffRole } from "../systems/StaffSystem";

/**
 * LIVE idle portraits of the real rigged staff models, for the staff tiles.
 *
 * Staff models are per-ROLE (every chef is the same "chef" GLB), so we keep ONE
 * animated instance per role and BLIT its render into every tile canvas showing
 * that role. Cost is therefore 4 small renders per frame no matter how big the
 * roster gets — and the loop only runs while the panel is actually on screen.
 *
 * A dedicated tiny offscreen WebGLRenderer (its own GL context) keeps this off
 * the main game renderer, same as FurnitureThumbnails. The character plays its
 * real "idle" clip, so the body breathes/shifts slightly instead of being a
 * frozen cut-out.
 *
 * Degrades quietly: if WebGL or the GLB fails, canvases just stay empty and the
 * tile's role emoji (drawn underneath) shows through.
 */

const SIZE = 128;
/** Portrait framerate — the idle clip is a slow breathe, so 20 is plenty and
 * keeps this well clear of the main renderer's budget. */
const FPS = 20;
/** Camera direction from the model's centre. The rig faces -Z in world terms
 * (RiggedCharacter applies a π FORWARD_OFFSET to the Mixamo +Z rigs), so the
 * camera has to sit on the -Z side to see the FRONT of them. Slight X/Y offset
 * gives a friendly three-quarter view rather than a passport photo. */
const VIEW_DIR = new THREE.Vector3(0.34, 0.14, -1).normalize();

/**
 * Framing is computed from KNOWN rig numbers, never from Box3.setFromObject:
 * that reads the BIND pose, which RiggedCharacter warns is "hip-centred, which
 * misleads a bbox/bone computation into floating the body ~0.9 m" — doing it
 * that way centred on the hips and cut every head off.
 *
 * The animated truth: clips are authored FEET-AT-ORIGIN, and RIGGED_SCALE 0.9
 * on a ~2 m GLB lands them ~1.8 m tall. So the body occupies y ∈ [0, 1.8].
 */
const RIG_HEIGHT = 1.8;
/** Waist-up bust — the face + uniform are what identify the role, and they fill
 * the short portrait strip instead of shrinking a whole body into 84 px. */
const FRAME_CENTER_Y = RIG_HEIGHT * 0.76; // ≈1.37, chest/head
const FRAME_HALF = RIG_HEIGHT * 0.30;     // ≈0.54 → shows y ≈ 0.83 … 1.91

interface RoleRig {
  scene: THREE.Scene;
  cam: THREE.OrthographicCamera;
  controller: { update(dt: number, action: "idle"): void };
  targets: HTMLCanvasElement[];
}

export class StaffPortraits {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly rigs = new Map<StaffRole, RoleRig>();
  private readonly rigPromises = new Map<StaffRole, Promise<RoleRig | null>>();
  private raf = 0;
  private lastMs = 0;
  private acc = 0;
  private running = false;

  /** Point a tile's canvas at a role's portrait. Safe to call before the GLB
   * has loaded — the canvas is wired up when the rig resolves. */
  attach(role: StaffRole, canvas: HTMLCanvasElement): void {
    void this.ensureRig(role).then((rig) => {
      if (rig && !rig.targets.includes(canvas)) rig.targets.push(canvas);
    }).catch(() => { /* no portrait — the emoji fallback shows */ });
  }

  /** Drop every tile canvas. The panel calls this before rebuilding its grid so
   * we don't keep painting into detached nodes. */
  detachAll(): void {
    for (const rig of this.rigs.values()) rig.targets.length = 0;
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

  private ensureRenderer(): THREE.WebGLRenderer | null {
    if (this.renderer) return this.renderer;
    try {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      r.setSize(SIZE, SIZE);
      r.setPixelRatio(1);
      r.setClearColor(0x000000, 0);
      r.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer = r;
      return r;
    } catch {
      return null; // no GL context to spare — fall back to the emoji
    }
  }

  private ensureRig(role: StaffRole): Promise<RoleRig | null> {
    let p = this.rigPromises.get(role);
    if (!p) { p = this.buildRig(role); this.rigPromises.set(role, p); }
    return p;
  }

  private async buildRig(role: StaffRole): Promise<RoleRig | null> {
    const modelId = riggedStaffModel(role);
    if (!modelId || !this.ensureRenderer()) return null;
    const { root, controller } = await sharedRiggedLoader.createInstance(modelId);

    const scene = new THREE.Scene();
    scene.add(root);
    scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const key = new THREE.DirectionalLight(0xfff4e2, 1.2);
    key.position.set(3, 6, -5); // in front (see VIEW_DIR) so the face is lit
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xdfe8ff, 0.4);
    rim.position.set(-4, 3, 4);
    scene.add(rim);

    // Fixed frame from the rig's known animated dimensions (see the constants).
    // The idle clip only shifts the body a couple of centimetres, so a static
    // frame never clips them.
    root.updateMatrixWorld(true);
    const target = new THREE.Vector3(0, FRAME_CENTER_Y, 0);
    const dist = 8;
    const cam = new THREE.OrthographicCamera(
      -FRAME_HALF, FRAME_HALF, FRAME_HALF, -FRAME_HALF, 0.01, dist * 2 + 20,
    );
    cam.up.set(0, 1, 0);
    cam.position.copy(target).addScaledVector(VIEW_DIR, dist);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const rig: RoleRig = { scene, cam, controller, targets: [] };
    this.rigs.set(role, rig);
    return rig;
  }

  private readonly loop = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastMs) / 1000);
    this.lastMs = now;
    this.acc += dt;
    if (this.acc < 1 / FPS) return; // throttle: the idle clip is a slow breathe
    const step = this.acc;
    this.acc = 0;
    const renderer = this.renderer;
    if (!renderer) return;
    for (const rig of this.rigs.values()) {
      // Skip roles whose tiles aren't on screen — nothing to pay for.
      const live = rig.targets.filter((c) => c.isConnected);
      if (live.length === 0) continue;
      rig.controller.update(step, "idle");
      renderer.render(rig.scene, rig.cam);
      for (const c of live) {
        const ctx = c.getContext("2d");
        if (!ctx) continue;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(renderer.domElement, 0, 0, c.width, c.height);
      }
    }
  };

  dispose(): void {
    this.stop();
    this.renderer?.dispose();
    this.renderer = null;
    this.rigs.clear();
    this.rigPromises.clear();
  }
}
