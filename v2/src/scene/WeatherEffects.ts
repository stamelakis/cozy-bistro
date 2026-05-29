import * as THREE from "three";

/**
 * Procedural weather visuals layered over the iso scene.
 *
 * Three particle systems share a single Points-based representation:
 *   - rain    : fast pale-blue droplets falling straight down (rainy)
 *   - snow    : slow drifting white flakes (cold snap)
 *   - confetti: multicoloured slow drifters (festival day)
 *
 * Only one is visible at a time, picked by setWeather(id). Each system
 * is recentred on the camera every update so the particle volume tracks
 * wherever the player is looking, no matter how far the camera pans.
 *
 * Particles are pure GPU-friendly THREE.Points geometry. No textures,
 * no shaders to author — the visual is intentionally toy / cozy so it
 * sits next to the Kenney furniture without out-of-place realism.
 *
 * Lighting tints (sun colour, ambient, sky background) are NOT done
 * here — they live in WorldScene.applyDayNight where the day-night
 * code already mixes them, so the weather modifiers stack cleanly on
 * top of the existing dayness ramp.
 */

/** Catalog ids in WeatherSystem. Kept as a wide string so the system
 * still works if a future weather id arrives the renderer doesn't yet
 * know how to draw. */
export type WeatherKind = string;

export class WeatherEffects {
  private readonly scene: THREE.Scene;
  private current: WeatherKind = "sunny";

  // === Rain ===
  // 800 droplets in a 36×36 m volume centred on the camera. Each has
  // its own fall speed so the column reads as motion rather than a
  // sheet sliding down. Reset to the top of the volume when they hit
  // the ground.
  private rain?: THREE.Points;
  private rainVelocities!: Float32Array;
  private static readonly RAIN_COUNT = 800;

  // === Snow ===
  // 500 flakes; slower; each gets a sine-wave horizontal drift driven
  // by a per-particle phase + a shared time accumulator so the sheet
  // feels alive.
  private snow?: THREE.Points;
  private snowPhases!: Float32Array;
  private static readonly SNOW_COUNT = 500;

  // === Confetti (festival) ===
  // 240 multicoloured square-ish dots drifting down with sway. Per-
  // particle colour set on the BufferGeometry so each piece keeps its
  // hue across resets — the eye reads a confetti shower instead of a
  // uniform spray.
  private confetti?: THREE.Points;
  private confettiPhases!: Float32Array;
  private static readonly CONFETTI_COUNT = 240;

  /** Shared horizontal/vertical extents. The play area is 10×10 m
   * (perimeter -4.5..5.5); 36×36 covers the building plus a generous
   * lawn margin so particles entering at the volume edge still appear
   * to fall WITHIN the visible frame. */
  private static readonly AREA_HALF = 18;
  private static readonly CEILING_Y = 14;

  /** Time accumulator for sine-wave sways. */
  private clock = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.buildRain();
    this.buildSnow();
    this.buildConfetti();
    this.setWeather("sunny");
  }

  /** Show only the particle system that matches the current weather
   * id; hide everything else. Cheap — toggles a single visibility
   * flag per system. */
  setWeather(id: WeatherKind): void {
    this.current = id;
    if (this.rain)     this.rain.visible     = (id === "rainy");
    if (this.snow)     this.snow.visible     = (id === "cold");
    if (this.confetti) this.confetti.visible = (id === "festival");
  }

  /** Advance whichever particle system is active. Other systems sit
   * idle (no geometry updates) when hidden.
   *
   * cameraPos is consumed so the particle volume follows the player's
   * camera — without that, a long-running session leaves rain spawning
   * 50 m off-screen where the camera started. */
  update(dt: number, cameraPos: THREE.Vector3): void {
    this.clock += dt;
    switch (this.current) {
      case "rainy":    this.updateRain(dt, cameraPos);    break;
      case "cold":     this.updateSnow(dt, cameraPos);    break;
      case "festival": this.updateConfetti(dt, cameraPos); break;
    }
  }

  // === Builders ====================================================

  private buildRain(): void {
    const n = WeatherEffects.RAIN_COUNT;
    const half = WeatherEffects.AREA_HALF;
    const positions = new Float32Array(n * 3);
    this.rainVelocities = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      positions[i * 3]     = (Math.random() - 0.5) * half * 2;
      positions[i * 3 + 1] = Math.random() * WeatherEffects.CEILING_Y;
      positions[i * 3 + 2] = (Math.random() - 0.5) * half * 2;
      // 12-19 units/s — fast enough to read as rain, slow enough to
      // see the streak rather than blur.
      this.rainVelocities[i] = 12 + Math.random() * 7;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xb8d4ec,
      size: 0.10,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.rain = new THREE.Points(geom, mat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.renderOrder = 2;
    this.scene.add(this.rain);
  }

  private buildSnow(): void {
    const n = WeatherEffects.SNOW_COUNT;
    const half = WeatherEffects.AREA_HALF;
    const positions = new Float32Array(n * 3);
    this.snowPhases = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      positions[i * 3]     = (Math.random() - 0.5) * half * 2;
      positions[i * 3 + 1] = Math.random() * WeatherEffects.CEILING_Y;
      positions[i * 3 + 2] = (Math.random() - 0.5) * half * 2;
      this.snowPhases[i] = Math.random() * Math.PI * 2;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xfaf7f1,
      size: 0.16,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.snow = new THREE.Points(geom, mat);
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    this.snow.renderOrder = 2;
    this.scene.add(this.snow);
  }

  private buildConfetti(): void {
    const n = WeatherEffects.CONFETTI_COUNT;
    const half = WeatherEffects.AREA_HALF;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    this.confettiPhases = new Float32Array(n);
    // Festive palette — bright pop colours.
    const palette = [
      [0xff, 0x6b, 0x6b],
      [0xff, 0xc8, 0x4a],
      [0x6b, 0xc8, 0xff],
      [0xa8, 0xe2, 0x80],
      [0xff, 0x90, 0xd8],
      [0xff, 0xf0, 0x6b],
    ];
    for (let i = 0; i < n; i += 1) {
      positions[i * 3]     = (Math.random() - 0.5) * half * 2;
      positions[i * 3 + 1] = Math.random() * WeatherEffects.CEILING_Y;
      positions[i * 3 + 2] = (Math.random() - 0.5) * half * 2;
      const c = palette[i % palette.length];
      colors[i * 3]     = c[0] / 255;
      colors[i * 3 + 1] = c[1] / 255;
      colors[i * 3 + 2] = c[2] / 255;
      this.confettiPhases[i] = Math.random() * Math.PI * 2;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.20,
      transparent: true,
      opacity: 0.92,
      vertexColors: true,
      depthWrite: false,
    });
    this.confetti = new THREE.Points(geom, mat);
    this.confetti.frustumCulled = false;
    this.confetti.visible = false;
    this.confetti.renderOrder = 2;
    this.scene.add(this.confetti);
  }

  // === Per-frame updaters =========================================

  private updateRain(dt: number, cam: THREE.Vector3): void {
    if (!this.rain) return;
    const attr = this.rain.geometry.attributes.position as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    const n = WeatherEffects.RAIN_COUNT;
    const half = WeatherEffects.AREA_HALF;
    for (let i = 0; i < n; i += 1) {
      const base = i * 3;
      pos[base + 1] -= this.rainVelocities[i] * dt;
      // Hit ground OR drifted out of the camera's box → respawn at top
      // inside the camera's current footprint.
      if (pos[base + 1] < 0
          || Math.abs(pos[base]     - cam.x) > half
          || Math.abs(pos[base + 2] - cam.z) > half) {
        pos[base]     = cam.x + (Math.random() - 0.5) * half * 2;
        pos[base + 1] = WeatherEffects.CEILING_Y;
        pos[base + 2] = cam.z + (Math.random() - 0.5) * half * 2;
      }
    }
    attr.needsUpdate = true;
  }

  private updateSnow(dt: number, cam: THREE.Vector3): void {
    if (!this.snow) return;
    const attr = this.snow.geometry.attributes.position as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    const n = WeatherEffects.SNOW_COUNT;
    const half = WeatherEffects.AREA_HALF;
    const t = this.clock;
    for (let i = 0; i < n; i += 1) {
      const base = i * 3;
      // 0.9 - 1.4 m/s drop with mild horizontal sway driven by a per-
      // particle phase. Pure sine wave is fine — readers don't pixel-
      // perfect inspect a snowfall.
      pos[base + 1] -= 1.1 * dt;
      pos[base]     += Math.sin(t * 0.7 + this.snowPhases[i]) * 0.35 * dt;
      pos[base + 2] += Math.cos(t * 0.6 + this.snowPhases[i]) * 0.35 * dt;
      if (pos[base + 1] < 0
          || Math.abs(pos[base]     - cam.x) > half
          || Math.abs(pos[base + 2] - cam.z) > half) {
        pos[base]     = cam.x + (Math.random() - 0.5) * half * 2;
        pos[base + 1] = WeatherEffects.CEILING_Y;
        pos[base + 2] = cam.z + (Math.random() - 0.5) * half * 2;
      }
    }
    attr.needsUpdate = true;
  }

  private updateConfetti(dt: number, cam: THREE.Vector3): void {
    if (!this.confetti) return;
    const attr = this.confetti.geometry.attributes.position as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    const n = WeatherEffects.CONFETTI_COUNT;
    const half = WeatherEffects.AREA_HALF;
    const t = this.clock;
    for (let i = 0; i < n; i += 1) {
      const base = i * 3;
      // Slower than snow, wider sway. Reads as floating, party-style.
      pos[base + 1] -= 0.65 * dt;
      pos[base]     += Math.sin(t * 1.1 + this.confettiPhases[i]) * 0.55 * dt;
      pos[base + 2] += Math.cos(t * 0.9 + this.confettiPhases[i]) * 0.55 * dt;
      if (pos[base + 1] < 0
          || Math.abs(pos[base]     - cam.x) > half
          || Math.abs(pos[base + 2] - cam.z) > half) {
        pos[base]     = cam.x + (Math.random() - 0.5) * half * 2;
        pos[base + 1] = WeatherEffects.CEILING_Y;
        pos[base + 2] = cam.z + (Math.random() - 0.5) * half * 2;
      }
    }
    attr.needsUpdate = true;
  }
}
