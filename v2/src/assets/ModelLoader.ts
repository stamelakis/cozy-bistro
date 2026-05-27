import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PROC_BUILDERS } from "./ProcDecor";

/**
 * Loads GLB models from `/assets/`. Caches by path so multiple instances of
 * the same model share a single load. Clones the scene graph per use so
 * consumers can position/transform without mutating the cached source.
 *
 * Special prefix: paths starting with "proc:" are not loaded from disk;
 * they're built procedurally via ProcDecor (wall decorations, signage).
 */
export class ModelLoader {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<THREE.Group>>();
  private readonly base: string;

  constructor(base = import.meta.env.BASE_URL ?? "/") {
    this.base = base.endsWith("/") ? base : `${base}/`;
  }

  /** Load a GLB and return a CLONE of its root scene. Safe to mutate. */
  async load(relPath: string): Promise<THREE.Group> {
    // Procedurally generated meshes (no disk fetch).
    if (relPath.startsWith("proc:")) {
      const key = relPath.slice("proc:".length);
      const builder = PROC_BUILDERS[key];
      if (!builder) throw new Error(`Unknown procedural decor: ${key}`);
      return builder();
    }
    const cached = this.cache.get(relPath);
    if (cached) {
      const source = await cached;
      return this.cloneScene(source);
    }
    const url = `${this.base}${relPath.replace(/^\//, "")}`;
    const promise = new Promise<THREE.Group>((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          this.prepareScene(gltf.scene);
          resolve(gltf.scene);
        },
        undefined,
        (err) => reject(err),
      );
    });
    this.cache.set(relPath, promise);
    const source = await promise;
    return this.cloneScene(source);
  }

  /** Enable shadows and ensure materials respond to lighting properly. */
  private prepareScene(root: THREE.Object3D): void {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
  }

  private cloneScene(source: THREE.Group): THREE.Group {
    // SkeletonUtils handles rigged models; for now plain clone works for
    // furniture. Switch to SkeletonUtils.clone() when we add characters.
    const clone = source.clone(true);
    return clone;
  }
}
