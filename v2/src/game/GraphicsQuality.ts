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
}

export const GRAPHICS_PRESETS: Record<GraphicsQuality, GraphicsPreset> = {
  low:    { pixelRatio: 1.0, sunShadows: false, furnitureShadows: false },
  medium: { pixelRatio: 1.5, sunShadows: true,  furnitureShadows: true  },
  high:   { pixelRatio: 2.0, sunShadows: true,  furnitureShadows: true  },
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
