/**
 * Picks today's weather, which scales guest spawn rate and (sometimes)
 * tip generosity. Rolls once per day on rollover so the player sees a
 * consistent vibe through the whole day, not a frenetic flip every
 * few minutes.
 *
 * Engine reads this; GuestSpawner queries the spawn multiplier; HUD
 * surfaces the emoji + label at the top of the screen.
 */

export interface WeatherType {
  id: string;
  emoji: string;
  label: string;
  /** Multiplier applied to the GuestSpawner spawn interval (lower = faster). */
  spawnRateMultiplier: number;
  /** Multiplier applied to tips after the meal. */
  tipMultiplier: number;
  /** Selection weight (sums to ~100). */
  weight: number;
}

export const WEATHER_TYPES: readonly WeatherType[] = [
  { id: "sunny",       emoji: "☀️",  label: "Sunny",        spawnRateMultiplier: 1.0,  tipMultiplier: 1.0,  weight: 35 },
  { id: "cloudy",      emoji: "⛅",  label: "Cloudy",       spawnRateMultiplier: 1.0,  tipMultiplier: 1.0,  weight: 25 },
  { id: "rainy",       emoji: "🌧️",  label: "Rainy",        spawnRateMultiplier: 1.8,  tipMultiplier: 1.0,  weight: 14 },
  { id: "heavy-rain",  emoji: "⛈️",  label: "Heavy Rain",   spawnRateMultiplier: 2.6,  tipMultiplier: 1.1,  weight:  6 },
  { id: "festival",    emoji: "🎉",  label: "Festival Day", spawnRateMultiplier: 0.65, tipMultiplier: 1.25, weight:  8 },
  { id: "cold",        emoji: "🥶",  label: "Cold Snap",    spawnRateMultiplier: 1.4,  tipMultiplier: 1.2,  weight:  6 },
  { id: "snowy",       emoji: "❄️",  label: "Snowy",        spawnRateMultiplier: 1.9,  tipMultiplier: 1.15, weight:  6 },
];

export class WeatherSystem {
  /** Local fallback used when no cloud provider is wired or the
   * cloud cache hasn't landed yet. Once the cloud provider is set
   * AND returns a known kind, getCurrent() reads from there and
   * this field is ignored. */
  private localFallback: WeatherType;
  /** Optional source of truth — when set, getCurrent() consults
   * this callback. Engine wires it to SpacetimeClient.getCurrentWeatherKind
   * so weather is GLOBAL across every connected client (rolled
   * server-side by the weather_roll reducer). When the callback
   * returns null/unknown, we fall back to localFallback so offline
   * play still shows a sky. */
  private cloudProvider?: () => string | null;

  constructor() {
    // Sunny on day 1 so the player isn't immediately confused by rain.
    this.localFallback = WEATHER_TYPES[0];
  }

  /** Engine calls this once after the cloud connects so weather
   * reads route through the server. Pass undefined to detach. */
  setCloudProvider(fn: (() => string | null) | undefined): void {
    this.cloudProvider = fn;
  }

  getCurrent(): WeatherType {
    if (this.cloudProvider) {
      const id = this.cloudProvider();
      if (id) {
        const match = WEATHER_TYPES.find((w) => w.id === id);
        if (match) return match;
      }
    }
    return this.localFallback;
  }

  /** Pick a fresh weather for the next day — OFFLINE PATH ONLY.
   * When a cloud provider is wired this is a no-op: weather is
   * rolled server-side every ~8 real minutes and synced to every
   * client. */
  rollForNewDay(): void {
    if (this.cloudProvider) return;
    const total = WEATHER_TYPES.reduce((sum, w) => sum + w.weight, 0);
    let pick = Math.random() * total;
    for (const w of WEATHER_TYPES) {
      pick -= w.weight;
      if (pick <= 0) { this.localFallback = w; return; }
    }
    this.localFallback = WEATHER_TYPES[0];
  }

  /** Admin / dev tool: force a specific weather kind. With a cloud
   * provider wired this is a NO-OP — the admin should use
   * SpacetimeClient.adminSetWeather instead so the change syncs
   * to everyone. Kept for the offline-only code path. */
  setById(id: string): void {
    if (this.cloudProvider) return;
    const next = WEATHER_TYPES.find((w) => w.id === id);
    if (next) this.localFallback = next;
  }
}
