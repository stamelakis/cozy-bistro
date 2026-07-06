import * as THREE from "three";
import { fitFurniture } from "../assets/fitFurniture";
import type { ModelLoader } from "../assets/ModelLoader";
import type { FurnitureDef } from "../data/furnitureCatalog";

/**
 * Renders a small isometric PNG thumbnail of the REAL 3-D furniture model for
 * each catalog item, so the build menu can show tiles picturing the actual
 * piece instead of a text list.
 *
 * A dedicated tiny offscreen WebGLRenderer (its own GL context, so it never
 * fights the main game renderer) draws each model once onto a transparent
 * square and hands back a data: URL. Results are cached per def id; identical
 * in-flight requests share one promise. Framing = tight square around the
 * model's bounding box from a fixed iso angle, matching how the piece reads
 * in-world.
 */
export class FurnitureThumbnails {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();
  private static readonly SIZE = 168;
  /** Fixed iso view direction (camera sits along this from the model centre). */
  private static readonly VIEW_DIR = new THREE.Vector3(1, 0.82, 1).normalize();

  constructor(private readonly loader: ModelLoader) {}

  /** Thumbnail data URL for a def — cached; renders on first request. */
  get(def: FurnitureDef): Promise<string> {
    const cached = this.cache.get(def.id);
    if (cached) return Promise.resolve(cached);
    const inflight = this.pending.get(def.id);
    if (inflight) return inflight;
    const p = this.render(def)
      .then((url) => { this.cache.set(def.id, url); this.pending.delete(def.id); return url; })
      .catch((e) => { this.pending.delete(def.id); throw e; });
    this.pending.set(def.id, p);
    return p;
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    if (this.renderer) return this.renderer;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setSize(FurnitureThumbnails.SIZE, FurnitureThumbnails.SIZE);
    r.setPixelRatio(1);
    r.setClearColor(0x000000, 0); // transparent — the tile bg shows through
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    return r;
  }

  private async render(def: FurnitureDef): Promise<string> {
    const renderer = this.ensureRenderer();
    // load() already returns a fresh mutable clone (GLB) / fresh proc build.
    const model = await this.loader.load(def.modelPath);
    try { fitFurniture(model, def); } catch { /* proc items self-size */ }
    model.updateMatrixWorld(true);

    const scene = new THREE.Scene();
    scene.add(model);
    scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const key = new THREE.DirectionalLight(0xfff4e2, 1.15);
    key.position.set(4, 7, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xdfe8ff, 0.35);
    rim.position.set(-5, 3, -4);
    scene.add(rim);

    // Frame: tight square around the bounding box from the fixed iso angle.
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) throw new Error(`empty bbox for ${def.id}`);
    const center = box.getCenter(new THREE.Vector3());
    const diag = box.getSize(new THREE.Vector3()).length() || 1;
    const dist = diag * 2 + 2;

    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, dist * 2 + 20);
    cam.up.set(0, 1, 0);
    cam.position.copy(center).addScaledVector(FurnitureThumbnails.VIEW_DIR, dist);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);

    // Project the 8 bbox corners onto the camera's right/up axes to size the
    // ortho frustum so the model fills the frame regardless of orientation.
    const forward = new THREE.Vector3().subVectors(center, cam.position).normalize();
    const right = new THREE.Vector3().crossVectors(forward, cam.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    let maxR = 0, maxU = 0;
    for (let i = 0; i < 8; i += 1) {
      const c = new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).sub(center);
      maxR = Math.max(maxR, Math.abs(c.dot(right)));
      maxU = Math.max(maxU, Math.abs(c.dot(up)));
    }
    const half = (Math.max(maxR, maxU) || 1) * 1.14; // ~14% padding
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.updateProjectionMatrix();

    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL("image/png");
    // Drop the model from the scene; geometry/materials are shared with the
    // loader cache (GLB) or single-use (proc), so we don't dispose them here.
    scene.remove(model);
    return url;
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.cache.clear();
    this.pending.clear();
  }
}
