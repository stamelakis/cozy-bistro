import * as THREE from "three";

const TEXTURE_KEYS = [
  "map", "normalMap", "roughnessMap", "metalnessMap",
  "emissiveMap", "aoMap", "alphaMap", "bumpMap", "displacementMap",
] as const;

/**
 * Deep-dispose an Object3D's GPU resources — every descendant mesh's
 * geometry, material(s), and any texture maps those materials hold —
 * skipping anything present in `keep`.
 *
 * Pass shared / cached singletons in `keep` so they are never freed while
 * other live objects still reference them (disposing a shared geometry or
 * material corrupts every other instance that uses it). Detach the object
 * from the scene graph BEFORE calling: this frees GPU memory, it does not
 * remove the object from its parent.
 *
 * Use ONLY for objects whose resources are unique to that instance
 * (procedural builds, per-spawn meshes). GLB clones share their cached
 * source buffers and must NOT be passed here.
 */
export function disposeObject3D(root: THREE.Object3D, keep?: ReadonlySet<unknown>): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (geom && typeof geom.dispose === "function" && !keep?.has(geom)) {
      geom.dispose();
    }
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
      if (!m || keep?.has(m)) continue;
      for (const key of TEXTURE_KEYS) {
        const tex = (m as unknown as Record<string, unknown>)[key];
        if (tex instanceof THREE.Texture) tex.dispose();
      }
      m.dispose();
    }
  });
}
