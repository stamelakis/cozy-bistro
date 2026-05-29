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
  { id: "sunny",    emoji: "☀️",  label: "Sunny",        spawnRateMultiplier: 1.0,  tipMultiplier: 1.0,  weight: 40 },
  { id: "cloudy",   emoji: "⛅",  label: "Cloudy",       spawnRateMultiplier: 1.0,  tipMultiplier: 1.0,  weight: 30 },
  { id: "rainy",    emoji: "🌧️",  label: "Rainy",        spawnRateMultiplier: 1.8,  tipMultiplier: 1.0,  weight: 15 },
  { id: "festival", emoji: "🎉",  label: "Festival Day", spawnRateMultiplier: 0.65, tipMultiplier: 1.25, weight: 10 },
  { id: "cold",     emoji: "🥶",  label: "Cold Snap",    spawnRateMultiplier: 1.4,  tipMultiplier: 1.2,  weight:  5 },
];

export class WeatherSystem {
  private current: WeatherType;

  constructor() {
    // Sunny on day 1 so the player isn't immediately confused by rain.
    this.current = WEATHER_TYPES[0];
  }

  getCurrent(): WeatherType {
    return this.current;
  }

  /** Pick a fresh weather for the next day. */
  rollForNewDay(): void {
    const total = WEATHER_TYPES.reduce((sum, w) => sum + w.weight, 0);
    let pick = Math.random() * total;
    for (const w of WEATHER_TYPES) {
      pick -= w.weight;
      if (pick <= 0) { this.current = w; return; }
    }
    this.current = WEATHER_TYPES[0];
  }

  /** Admin / dev tool: force a specific weather for the current day,
   * skipping the next roll. Used by the AdminModal weather buttons to
   * preview rain / snow / festival visuals without waiting for the
   * day-end roll. Silently no-ops if the id isn't in WEATHER_TYPES. */
  setById(id: string): void {
    const next = WEATHER_TYPES.find((w) => w.id === id);
    if (next) this.current = next;
  }
}
