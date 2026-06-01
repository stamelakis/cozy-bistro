import * as THREE from "three";

/**
 * Procedural weather visuals layered over the iso scene.
 *
 * Five particle systems share a single show-the-right-one contract:
 *   - rain        : pale-blue droplets falling fast (rainy)
 *   - heavyRain   : ~4× more droplets, bigger + darker (heavy-rain)
 *   - snow        : light dusting (cold)
 *   - heavySnow   : thick snowfall (snowy)
 *   - confetti    : multicoloured slow drifters (festival)
 *
 * On top of that we have:
 *   - cloudShadows : 4 large soft-edged dark planes drifting across the
 *                    ground for cloudy / overcast / rainy / heavy-rain
 *                    / snowy. Sells "diffused sun behind moving clouds".
 *   - wetness      : 0..1 value the renderer reads to modify the floor
 *                    material (glossier + slightly darker = looks wet).
 *
 * Each volume tracks the camera per frame so a long-running session
 * doesn't end up with rain falling 50 m off-screen.
 *
 * Pure GPU-friendly THREE.Points + THREE.PlaneGeometry — no textures
 * shipped or shaders authored. The visual fits the cozy toy aesthetic
 * without out-of-place realism.
 */

/** Catalog ids in WeatherSystem. Kept as a wide string so the system
 * still works if a future weather id arrives the renderer doesn't yet
 * know how to draw. */
export type WeatherKind = string;

export class WeatherEffects {
  private readonly scene: THREE.Scene;
  private current: WeatherKind = "sunny";

  // === Rain ===
  private rain?: THREE.Points;
  private rainVelocities!: Float32Array;
  private static readonly RAIN_COUNT = 9000;

  // === Heavy rain (≈ 2× density + faster fall) ===
  private heavyRain?: THREE.Points;
  private heavyRainVelocities!: Float32Array;
  private static readonly HEAVY_RAIN_COUNT = 16000;

  // === Snow (light dusting) ===
  private snow?: THREE.Points;
  private snowPhases!: Float32Array;
  private static readonly SNOW_COUNT = 3600;

  // === Heavy snow (thick snowfall) ===
  private heavySnow?: THREE.Points;
  private heavySnowPhases!: Float32Array;
  private static readonly HEAVY_SNOW_COUNT = 11000;

  // === Festival confetti ===
  private confetti?: THREE.Points;
  private confettiPhases!: Float32Array;
  private static readonly CONFETTI_COUNT = 1500;

  // === Cloud shadows ===
  // Dark soft-edged blobs drifting across the ground. Each is a
  // ProceduralCanvas texture (irregular Gaussian-blob silhouette) so
  // the shadows read as organic clouds rather than tidy squares.
  // Visible for cloudy / rainy / heavy-rain / cold / snowy weather;
  // opacity scales with how overcast the weather is.
  private cloudShadows: THREE.Mesh[] = [];
  private cloudShadowDrifts!: { vx: number; vz: number; phaseY: number }[];
  private static readonly CLOUD_SHADOW_COUNT = 140;
  /** Wide spread so cloud shadows cover the whole visible map. */
  private static readonly CLOUD_AREA_HALF = 280;

  /** Shared horizontal/vertical extents centred on WORLD ORIGIN
   * (the player's own restaurant — worldRoot is offset to put it
   * there regardless of which plot the player owns). The volume
   * is STATIC: panning the camera no longer drags the storm
   * around. ±280 m covers the entire built city (±130 m of street
   * extent + scenery + a generous margin into the fog horizon),
   * so wherever the player pans, the rain / snow is always
   * already there — no more "patch that follows the camera".
   * CEILING_Y bumped so particles fall from above the tallest
   * scenery rooftop. */
  private static readonly AREA_HALF = 280;
  private static readonly CEILING_Y = 18;

  /** Time accumulator for sine-wave sways. */
  private clock = 0;

  /** Per-system wind velocity. Picked when the weather flips so each
   * storm has its own "the wind is blowing from over there" angle —
   * makes rain + snow fall at a believable slant instead of straight
   * down. Heavy weathers get a stronger wind. */
  private windX = 0;
  private windZ = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.buildRain();
    this.buildHeavyRain();
    this.buildSnow();
    this.buildHeavySnow();
    this.buildConfetti();
    this.buildCloudShadows();
    this.setWeather("sunny");
  }

  /** Show only the particle system that matches the current weather
   * id; hide everything else. Cloud shadows show for any "overcast"
   * weather. Also re-rolls the wind angle so each storm slants
   * differently — straight-down rain reads as artificial. */
  setWeather(id: WeatherKind): void {
    if (this.current === id) return;
    this.current = id;
    if (this.rain)        this.rain.visible        = (id === "rainy");
    if (this.heavyRain)   this.heavyRain.visible   = (id === "heavy-rain");
    if (this.snow)        this.snow.visible        = (id === "cold");
    if (this.heavySnow)   this.heavySnow.visible   = (id === "snowy");
    if (this.confetti)    this.confetti.visible    = (id === "festival");
    this.rollWind(id);
    // Cloud-shadow visibility is set per-frame in update() because we
    // also lerp the opacity into / out of the overcast set.
  }

  /** Pick a random wind direction + strength for the current weather.
   * Heavy variants get stronger gusts; light rain / snow get a gentle
   * slant. The angle is in the XZ plane so all particles get the same
   * horizontal drift this storm. */
  private rollWind(id: WeatherKind): void {
    const angle = Math.random() * Math.PI * 2;
    let strength = 0;
    switch (id) {
      case "rainy":      strength = 3.5 + Math.random() * 2;  break;
      case "heavy-rain": strength = 7.5 + Math.random() * 3;  break;
      case "cold":       strength = 1.5 + Math.random() * 1.5; break;
      case "snowy":      strength = 3.5 + Math.random() * 2;  break;
      case "festival":   strength = 1.0 + Math.random() * 1;  break;
      default:           strength = 0;                          break;
    }
    this.windX = Math.cos(angle) * strength;
    this.windZ = Math.sin(angle) * strength;
  }

  /** Wetness multiplier the renderer applies to the floor material.
   *   0   = bone dry (sunny / cold / festival)
   *   0.4 = puddly (rainy)
   *   1.0 = soaked (heavy-rain)
   * WorldScene reads this each tick and tweaks roughness + colour. */
  getWetness(): number {
    switch (this.current) {
      case "heavy-rain": return 1.0;
      case "rainy":      return 0.45;
      default:           return 0;
    }
  }

  /** Sky-overcast amount in [0, 1]. Drives the cloud-shadow plane
   * opacity so cloudy days have soft hints, heavy rain has dramatic
   * patches. */
  private getOvercast(): number {
    switch (this.current) {
      case "heavy-rain": return 1.0;
      case "rainy":      return 0.75;
      case "snowy":      return 0.85;
      case "cold":       return 0.50;
      case "cloudy":     return 0.65;
      default:           return 0;
    }
  }

  /** Advance whichever particle system is active. Other systems sit
   * idle (no geometry updates) when hidden. cameraPos is consumed so
   * the particle volume tracks the player's camera. */
  update(dt: number, cameraPos: THREE.Vector3): void {
    this.clock += dt;
    switch (this.current) {
      case "rainy":      this.updateRain(dt, cameraPos);      break;
      case "heavy-rain": this.updateHeavyRain(dt, cameraPos); break;
      case "cold":       this.updateSnow(dt, cameraPos);      break;
      case "snowy":      this.updateHeavySnow(dt, cameraPos); break;
      case "festival":   this.updateConfetti(dt, cameraPos);  break;
    }
    this.updateCloudShadows(dt, cameraPos);
  }

  // === Builders ====================================================

  private buildRain(): void {
    // Particle sizes are in WORLD units (sizeAttenuation on). Bumped
    // up another ~3× from the last pass so droplets read as clearly
    // visible streaks at iso distance instead of pinpricks.
    this.rain = this.makePoints(
      WeatherEffects.RAIN_COUNT,
      0xb8d4ec,
      1.50,
      0.85,
    );
    this.rainVelocities = this.makeVelocities(WeatherEffects.RAIN_COUNT, 14, 8);
    this.seedPositions(this.rain, WeatherEffects.RAIN_COUNT);
  }

  private buildHeavyRain(): void {
    this.heavyRain = this.makePoints(
      WeatherEffects.HEAVY_RAIN_COUNT,
      0x9cb8d4,
      2.20,
      0.95,
    );
    this.heavyRainVelocities = this.makeVelocities(WeatherEffects.HEAVY_RAIN_COUNT, 22, 10);
    this.seedPositions(this.heavyRain, WeatherEffects.HEAVY_RAIN_COUNT);
  }

  private buildSnow(): void {
    this.snow = this.makePoints(
      WeatherEffects.SNOW_COUNT,
      0xfaf7f1,
      1.70,
      0.90,
    );
    this.snowPhases = this.makePhases(WeatherEffects.SNOW_COUNT);
    this.seedPositions(this.snow, WeatherEffects.SNOW_COUNT);
  }

  private buildHeavySnow(): void {
    this.heavySnow = this.makePoints(
      WeatherEffects.HEAVY_SNOW_COUNT,
      0xffffff,
      2.40,
      0.95,
    );
    this.heavySnowPhases = this.makePhases(WeatherEffects.HEAVY_SNOW_COUNT);
    this.seedPositions(this.heavySnow, WeatherEffects.HEAVY_SNOW_COUNT);
  }

  private buildConfetti(): void {
    const n = WeatherEffects.CONFETTI_COUNT;
    const half = WeatherEffects.AREA_HALF;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    this.confettiPhases = new Float32Array(n);
    const palette = [
      [0xff, 0x6b, 0x6b], [0xff, 0xc8, 0x4a], [0x6b, 0xc8, 0xff],
      [0xa8, 0xe2, 0x80], [0xff, 0x90, 0xd8], [0xff, 0xf0, 0x6b],
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
      size: 1.40, transparent: true, opacity: 0.92,
      vertexColors: true, depthWrite: false,
    });
    this.confetti = new THREE.Points(geom, mat);
    this.confetti.frustumCulled = false;
    this.confetti.visible = false;
    this.confetti.renderOrder = 2;
    this.scene.add(this.confetti);
  }

  private buildCloudShadows(): void {
    this.cloudShadowDrifts = [];
    const half = WeatherEffects.CLOUD_AREA_HALF;
    for (let i = 0; i < WeatherEffects.CLOUD_SHADOW_COUNT; i += 1) {
      // Per-cloud procedural texture — composite of 10-14 overlapping
      // soft Gaussian blobs giving each plane a unique chaotic
      // silhouette instead of a clean square edge.
      const tex = WeatherEffects.makeCloudTexture();
      // 14-26 m plane — bigger than before so each cloud reads as a
      // whole patch of overcast rather than a tiny spot.
      const size = 14 + Math.random() * 12;
      const geom = new THREE.PlaneGeometry(size, size, 1, 1);
      geom.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        // White base so the texture's painted dark-grey alpha drives
        // the visible tone. opacity multiplies on top for the per-
        // weather overcast scale.
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      // Spread far + wide so 12 clouds cover the whole yard rather
      // than piling up. Tiny per-cloud y stagger prevents z-fight.
      mesh.position.set(
        (Math.random() - 0.5) * half * 2,
        0.02 + i * 0.001,
        (Math.random() - 0.5) * half * 2,
      );
      // Random Y-rotation so the silhouette doesn't read as a tiled
      // pattern across multiple clouds.
      mesh.rotation.y = Math.random() * Math.PI * 2;
      // Frustum-cull cloud shadows — each shadow is a 14-26 m world-
      // space patch sitting at fixed Y, so three.js's built-in bounding-
      // sphere test will reliably skip off-screen planes. Previously
      // disabled (`= false`) because confetti / Points particles must
      // stay uncullable, but a flat shadow plane has a proper bbox.
      // With ~12 shadows scattered across the map and the camera
      // typically seeing 3-4 at once, this saves ~8 draw calls per
      // frame when overcast is up.
      mesh.frustumCulled = true;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.cloudShadows.push(mesh);
      this.cloudShadowDrifts.push({
        vx: 0.4 + Math.random() * 0.5,
        vz: 0.2 + Math.random() * 0.3,
        phaseY: Math.random() * Math.PI * 2,
      });
    }
  }

  /** A single soft dark patch — that's all a cloud shadow is. We're
   * NOT painting a cloud silhouette here; the clouds themselves are
   * imagined to live in the sky above and only their shadows fall on
   * the ground. So each plane gets one large blurry blob that fades
   * to full transparency at the edge.
   *
   * Implementation: ONE big base radial gradient covering most of the
   * canvas, then 2-3 tiny offset blobs to nudge the silhouette away
   * from a perfect circle (real cloud shadows have slightly organic
   * edges). No internal mottling — a shadow doesn't have texture, it
   * just darkens what's underneath. */
  private static makeCloudTexture(): THREE.CanvasTexture {
    const sz = 256;
    const canvas = document.createElement("canvas");
    canvas.width = sz;
    canvas.height = sz;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, sz, sz);
    // Base patch — one big soft radial blob centred near the middle.
    // Radius leaves a generous transparent margin so the plane edge
    // is never visible.
    const cx0 = sz * (0.45 + Math.random() * 0.10);
    const cy0 = sz * (0.45 + Math.random() * 0.10);
    const r0  = sz * 0.42;
    const baseAlpha = 0.28 + Math.random() * 0.10;
    const grad0 = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, r0);
    grad0.addColorStop(0,    `rgba(40, 32, 24, ${baseAlpha.toFixed(3)})`);
    grad0.addColorStop(0.55, `rgba(40, 32, 24, ${(baseAlpha * 0.55).toFixed(3)})`);
    grad0.addColorStop(1.0,  `rgba(40, 32, 24, 0)`);
    ctx.fillStyle = grad0;
    ctx.fillRect(0, 0, sz, sz);
    // 2-3 small bumps to break up the perfect circular outline. Each
    // is significantly smaller than the base so it just nudges the
    // silhouette rather than adding visible spots.
    const bumps = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < bumps; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = sz * (0.18 + Math.random() * 0.12);
      const cx = cx0 + Math.cos(angle) * dist;
      const cy = cy0 + Math.sin(angle) * dist;
      const r  = sz * (0.16 + Math.random() * 0.08);
      const a  = baseAlpha * 0.5;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0,   `rgba(40, 32, 24, ${a.toFixed(3)})`);
      grad.addColorStop(1.0, `rgba(40, 32, 24, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, sz, sz);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }

  // === Per-frame updaters =========================================

  private updateRain(dt: number, cam: THREE.Vector3): void {
    this.updateRainLike(this.rain!, this.rainVelocities, dt, cam, WeatherEffects.RAIN_COUNT);
  }

  private updateHeavyRain(dt: number, cam: THREE.Vector3): void {
    this.updateRainLike(this.heavyRain!, this.heavyRainVelocities, dt, cam, WeatherEffects.HEAVY_RAIN_COUNT);
  }

  private updateRainLike(
    points: THREE.Points, velocities: Float32Array,
    dt: number, cam: THREE.Vector3, n: number,
  ): void {
    void cam; // STATIC volume now — see AREA_HALF doc-comment.
    const attr = points.geometry.attributes.position as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    const half = WeatherEffects.AREA_HALF;
    const wx = this.windX * dt;
    const wz = this.windZ * dt;
    for (let i = 0; i < n; i += 1) {
      const base = i * 3;
      pos[base + 1] -= velocities[i] * dt;
      // Apply shared wind for the slant + a small per-particle jitter
      // so the column doesn't look like a single rigid sheet.
      pos[base]     += wx + (Math.random() - 0.5) * 0.05;
      pos[base + 2] += wz + (Math.random() - 0.5) * 0.05;
      if (pos[base + 1] < 0
          || Math.abs(pos[base])     > half
          || Math.abs(pos[base + 2]) > half) {
        // Respawn ANYWHERE in the (static) volume so the storm
        // doesn't develop a hole around the camera path.
        pos[base]     = (Math.random() - 0.5) * half * 2;
        pos[base + 1] = WeatherEffects.CEILING_Y;
        pos[base + 2] = (Math.random() - 0.5) * half * 2;
      }
    }
    attr.needsUpdate = true;
  }

  private updateSnow(dt: number, cam: THREE.Vector3): void {
    this.updateSnowLike(this.snow!, this.snowPhases, dt, cam, WeatherEffects.SNOW_COUNT, 1.1, 0.35);
  }

  private updateHeavySnow(dt: number, cam: THREE.Vector3): void {
    this.updateSnowLike(this.heavySnow!, this.heavySnowPhases, dt, cam, WeatherEffects.HEAVY_SNOW_COUNT, 1.4, 0.5);
  }

  private updateSnowLike(
    points: THREE.Points, phases: Float32Array,
    dt: number, cam: THREE.Vector3, n: number,
    fallSpeed: number, swayAmplitude: number,
  ): void {
    void cam; // STATIC volume now — see AREA_HALF doc-comment.
    const attr = points.geometry.attributes.position as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    const half = WeatherEffects.AREA_HALF;
    const t = this.clock;
    const wx = this.windX * dt;
    const wz = this.windZ * dt;
    for (let i = 0; i < n; i += 1) {
      const base = i * 3;
      pos[base + 1] -= fallSpeed * dt;
      // Per-particle sway (keeps it organic) PLUS shared wind so the
      // overall snowfall slants in one direction.
      pos[base]     += wx + Math.sin(t * 0.7 + phases[i]) * swayAmplitude * dt;
      pos[base + 2] += wz + Math.cos(t * 0.6 + phases[i]) * swayAmplitude * dt;
      if (pos[base + 1] < 0
          || Math.abs(pos[base])     > half
          || Math.abs(pos[base + 2]) > half) {
        pos[base]     = (Math.random() - 0.5) * half * 2;
        pos[base + 1] = WeatherEffects.CEILING_Y;
        pos[base + 2] = (Math.random() - 0.5) * half * 2;
      }
    }
    attr.needsUpdate = true;
  }

  private updateConfetti(dt: number, cam: THREE.Vector3): void {
    if (!this.confetti) return;
    void cam; // STATIC volume now — see AREA_HALF doc-comment.
    const attr = this.confetti.geometry.attributes.position as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    const n = WeatherEffects.CONFETTI_COUNT;
    const half = WeatherEffects.AREA_HALF;
    const t = this.clock;
    for (let i = 0; i < n; i += 1) {
      const base = i * 3;
      pos[base + 1] -= 0.65 * dt;
      pos[base]     += Math.sin(t * 1.1 + this.confettiPhases[i]) * 0.55 * dt;
      pos[base + 2] += Math.cos(t * 0.9 + this.confettiPhases[i]) * 0.55 * dt;
      if (pos[base + 1] < 0
          || Math.abs(pos[base])     > half
          || Math.abs(pos[base + 2]) > half) {
        pos[base]     = (Math.random() - 0.5) * half * 2;
        pos[base + 1] = WeatherEffects.CEILING_Y;
        pos[base + 2] = (Math.random() - 0.5) * half * 2;
      }
    }
    attr.needsUpdate = true;
  }

  /** Drift cloud shadows across the ground + lerp each one's opacity
   * toward its overcast-driven target. Wraps around the WORLD ORIGIN
   * (player's restaurant) so the patches cover the whole built city
   * statically, regardless of where the camera pans. */
  private updateCloudShadows(dt: number, cam: THREE.Vector3): void {
    void cam; // STATIC volume now — wrap around world origin.
    const overcast = this.getOvercast();
    const half = WeatherEffects.CLOUD_AREA_HALF;
    const t = this.clock;
    for (let i = 0; i < this.cloudShadows.length; i += 1) {
      const mesh = this.cloudShadows[i];
      const drift = this.cloudShadowDrifts[i];
      mesh.position.x += drift.vx * dt;
      mesh.position.z += drift.vz * dt;
      if (mesh.position.x > half) mesh.position.x -= half * 2;
      if (mesh.position.x < -half) mesh.position.x += half * 2;
      if (mesh.position.z > half) mesh.position.z -= half * 2;
      if (mesh.position.z < -half) mesh.position.z += half * 2;
      // Per-cloud opacity wobble — gives the overcast a breathing feel.
      const wobble = 0.5 + 0.5 * Math.sin(t * 0.25 + drift.phaseY);
      // Material opacity scales the texture's already-fractional
      // alpha. Keep this very low — the new warm-dark texture reads
      // strongly even at low alpha and overdriving turns the shadow
      // into a sticker again. Range 0.35-0.65 of overcast lands in
      // "soft natural darkening" territory.
      const target = overcast * (0.35 + 0.30 * wobble);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = target;
      mesh.visible = target > 0.01;
    }
  }

  // === Helpers ===================================================

  private makePoints(count: number, color: number, size: number, opacity: number): THREE.Points {
    const positions = new Float32Array(count * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color, size,
      transparent: true, opacity,
      depthWrite: false,
    });
    const p = new THREE.Points(geom, mat);
    p.frustumCulled = false;
    p.visible = false;
    p.renderOrder = 2;
    this.scene.add(p);
    return p;
  }

  private makeVelocities(count: number, base: number, jitter: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) out[i] = base + Math.random() * jitter;
    return out;
  }

  private makePhases(count: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) out[i] = Math.random() * Math.PI * 2;
    return out;
  }

  /** Initial random seeding inside the shared XZ volume + the vertical
   * range from 0 to CEILING_Y. Without this every particle starts at
   * the origin and the first second of weather reads as a falling
   * needle instead of a spread sheet. */
  private seedPositions(points: THREE.Points, count: number): void {
    const half = WeatherEffects.AREA_HALF;
    const attr = points.geometry.attributes.position as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    for (let i = 0; i < count; i += 1) {
      pos[i * 3]     = (Math.random() - 0.5) * half * 2;
      pos[i * 3 + 1] = Math.random() * WeatherEffects.CEILING_Y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * half * 2;
    }
    attr.needsUpdate = true;
  }
}
