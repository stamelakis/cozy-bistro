/**
 * Player-facing graphics-quality knob. Three preset tiers — Low /
 * Medium / High — flip a small set of renderer + scene settings.
 * Engine reads the saved tier on construct; the sidebar's dropdown
 * lets the player change it at runtime and the engine re-applies
 * immediately (no reload needed for any of the knobs we wire here).
 *
 * Preset shape:
 *   pixelRatio      — capped device-pixel ratio passed to the
 *                     renderer. Single biggest perf knob on
 *                     high-DPI displays.
 *   sunShadows      — whether the sun's shadow map is computed
 *                     each frame. Cheaper to disable wholesale
 *                     than to keep but unused.
 *   furnitureShadows — whether placed furniture meshes cast
 *                     shadows. Building structure (walls,
 *                     floors, mansard) still casts regardless.
 *
 * Auto-disable rule: even on Medium / High, Engine flips
 * sunLight.castShadow off when the player zooms out past the
 * exterior threshold — at that distance shadows aren't visible
 * anyway and the perf saving is significant.
 */

export type GraphicsQuality = "low" | "medium" | "high";

export interface GraphicsPreset {
  pixelRatio: number;
  sunShadows: boolean;
  furnitureShadows: boolean;
  /** Active lamp-light caps, tiered by quality and SPLIT by type so the
   * budget favours the player's own PLACED lamps (indoors) over exterior
   * street lamps. Total active = placed + street; kept near the ~32 ceiling
   * weak GPUs can still compile (the knob that froze them at high counts).
   * 0 = bulbs only, no halos. Applied at scene construction; a quality
   * change takes effect on reload. */
  placedLampPool: number;
  streetLampPool: number;
  /** Active cast-light pool for COOKING stations (stoves, toasters, etc.).
   * The flame meshes are emissive-only; this fixed pool gives the nearest few
   * ACTIVE stations a real warm halo so the kitchen lights up while cooking —
   * day AND night. Constant count, so it never recompiles the lit-material
   * shader when a stove starts/stops (the floor-reveal freeze). Active on
   * every tier — on Low it's the only light source (no lamps). */
  stoveLightPool: number;
}

export const GRAPHICS_PRESETS: Record<GraphicsQuality, GraphicsPreset> = {
  // Lamp pools per the player's spec: low = no lamps (just stove/appliance
  // glow), medium = enough to light the lamps on-screen on the current floor,
  // high = effectively all of a restaurant's lamps. HIGH IS HEAVY: ~56 active
  // lights is well past the count that froze weak GPUs (the GTX 1050 Ti) for
  // minutes while the lit-material shader compiled — fine on a modern GPU,
  // a long one-time load stall on a weak one. That's the player's call.
  low:    { pixelRatio: 1.0, sunShadows: false, furnitureShadows: false, placedLampPool: 0,  streetLampPool: 0,  stoveLightPool: 4 },
  medium: { pixelRatio: 1.5, sunShadows: true,  furnitureShadows: true,  placedLampPool: 24, streetLampPool: 6,  stoveLightPool: 6 },
  high:   { pixelRatio: 2.0, sunShadows: true,  furnitureShadows: true,  placedLampPool: 40, streetLampPool: 16, stoveLightPool: 8 },
};

const STORAGE_KEY = "cozy-bistro.graphics-quality";

/** Read the saved quality, defaulting to Medium for a clean install. */
export function getSavedGraphicsQuality(): GraphicsQuality {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "low" || raw === "medium" || raw === "high") return raw;
  } catch { /* private-mode storage — fall through */ }
  return "medium";
}

/** Persist the player's pick so the next session starts on the
 * right preset without needing to re-apply. Safe to call frequently
 * (the storage write is tiny). */
export function setSavedGraphicsQuality(q: GraphicsQuality): void {
  try {
    localStorage.setItem(STORAGE_KEY, q);
  } catch { /* ignore */ }
}

/** Shorthand for the preset matching the currently-saved quality. */
export function getCurrentGraphicsPreset(): GraphicsPreset {
  return GRAPHICS_PRESETS[getSavedGraphicsQuality()];
}

// =====================================================================
//                Phase I — FPS cap + on-screen counter
// =====================================================================
// Independent of the quality preset because cap / counter are usable
// at any quality (a Low-tier laptop might still want a 30 fps cap to
// reduce fan noise; a High-tier desktop might want the counter to
// verify their cap is holding).

/** Allowed cap values surfaced in the sidebar dropdown.  null = no
 * cap (run at the display's native refresh, the original behaviour). */
export const FPS_CAP_OPTIONS: readonly (number | null)[] = [null, 30, 60, 75, 120, 144];

const FPS_CAP_STORAGE_KEY = "cozy-bistro.fps-cap";
const FPS_SHOW_STORAGE_KEY = "cozy-bistro.fps-show";

/** Read the saved FPS cap; null = uncapped. */
export function loadSavedFpsCap(): number | null {
  try {
    const raw = localStorage.getItem(FPS_CAP_STORAGE_KEY);
    if (raw === null || raw === "" || raw === "none") return null;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 15 && n <= 360) return n;
  } catch { /* private mode — fall through */ }
  return null;
}

/** Persist the FPS cap.  Pass null to clear (uncapped). */
export function setSavedFpsCap(cap: number | null): void {
  try {
    if (cap === null) localStorage.removeItem(FPS_CAP_STORAGE_KEY);
    else localStorage.setItem(FPS_CAP_STORAGE_KEY, String(cap));
  } catch { /* ignore */ }
}

/** Read whether the FPS counter badge should be visible. */
export function loadSavedShowFps(): boolean {
  try {
    return localStorage.getItem(FPS_SHOW_STORAGE_KEY) === "1";
  } catch { return false; }
}

/** Persist the show-FPS toggle. */
export function setSavedShowFps(show: boolean): void {
  try {
    if (show) localStorage.setItem(FPS_SHOW_STORAGE_KEY, "1");
    else localStorage.removeItem(FPS_SHOW_STORAGE_KEY);
  } catch { /* ignore */ }
}
