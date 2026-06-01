import * as THREE from "three";

/**
 * Off-thread procedural-texture helper. Routes paint requests through
 * a Web Worker (textureWorker.ts) using OffscreenCanvas, transfers the
 * resulting ImageBitmap back, and wraps it in a `THREE.CanvasTexture`
 * so the rest of the scene treats it the same as a synchronously
 * painted texture.
 *
 * Designed for scenery / decorative textures that aren't critical
 * for the first frame — at boot the meshes get a stub texture (or
 * the material starts with `map: null`) and swap in the real texture
 * once the worker delivers. Players see the signs pop in over the
 * first second or two, but the boot frame ships ~300 ms earlier.
 *
 * If the worker can't be constructed (very old browser, no
 * OffscreenCanvas), every request falls back to the legacy
 * main-thread `painter` callback so the caller still gets a usable
 * texture.
 */

type ShopSignRequest = { id: number; kind: "shop-sign"; name: string };
type Request = ShopSignRequest;

type Ok = { id: number; ok: true; bitmap: ImageBitmap };
type Err = { id: number; ok: false; error: string };
type Response = Ok | Err;

export class TextureService {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (res: Response) => void>();
  /** Cached "can the browser do OffscreenCanvas in a worker?" probe. */
  private readonly supported: boolean;

  constructor() {
    this.supported = typeof OffscreenCanvas !== "undefined"
      && typeof Worker !== "undefined";
    if (this.supported) {
      try {
        this.worker = new Worker(new URL("../workers/textureWorker.ts", import.meta.url), { type: "module" });
        this.worker.addEventListener("message", (ev: MessageEvent<Response>) => {
          const cb = this.pending.get(ev.data.id);
          if (!cb) return;
          this.pending.delete(ev.data.id);
          cb(ev.data);
        });
        this.worker.addEventListener("error", (e) => {
          console.warn("[TextureService] worker error:", e.message || e);
        });
      } catch (e) {
        console.warn("[TextureService] worker init failed, falling back to main thread:", e);
        this.worker = null;
      }
    }
  }

  /** True if the worker is up. False forces the caller to use its
   * own synchronous painter as a fallback. */
  isReady(): boolean { return this.worker != null; }

  /** Paint a shop sign off-thread. Returns a `THREE.CanvasTexture`
   * that starts EMPTY and updates in place once the worker delivers
   * the painted ImageBitmap. Callers can attach this to a material's
   * `map`/`emissiveMap` immediately and the texture will populate
   * itself a frame or two later. If the worker can't run, the
   * caller's `fallback` painter runs synchronously on the main
   * thread instead. */
  paintShopSign(name: string, fallback: () => THREE.CanvasTexture): THREE.Texture {
    if (!this.worker) return fallback();
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    const id = this.nextId++;
    this.pending.set(id, (res) => {
      if (!res.ok) {
        // Worker failed — swap in the main-thread fallback so the
        // sign isn't permanently blank.
        const fb = fallback();
        tex.image = fb.image;
        tex.needsUpdate = true;
        return;
      }
      // CSS `image-orientation: from-image` semantics aren't needed
      // here — ImageBitmap is the literal bitmap, no metadata
      // surprises. Just assign and flag for upload.
      tex.image = res.bitmap as unknown as HTMLImageElement;
      tex.needsUpdate = true;
    });
    const req: Request = { id, kind: "shop-sign", name };
    try {
      this.worker.postMessage(req);
    } catch (e) {
      this.pending.delete(id);
      console.warn("[TextureService] postMessage failed:", e);
      const fb = fallback();
      tex.image = fb.image;
      tex.needsUpdate = true;
    }
    return tex;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
