/**
 * Lightweight procedural sound effects using the Web Audio API. Zero
 * external assets — every sound is synthesized from oscillators +
 * envelopes at play time. Good enough for the small "ding / chime /
 * cha-ching" feedback the gameplay needs.
 *
 * Browser autoplay rules require user interaction before audio plays,
 * so the AudioContext is created lazily on the first call. Calls
 * before that just no-op. A "mute" toggle (persisted to localStorage)
 * lets the player turn it all off.
 */

const STORAGE_KEY = "cozy-bistro-3d-sfx-muted";

/** Per-stove-type sizzle profile. Tunes the bandpass center + Q so a gas
 * stove sounds like an open flame ("whoosh"), an electric coil sounds
 * like steady-state hiss, etc. Gas is the default if a stove id isn't
 * in the table. */
const SIZZLE_PROFILES: Record<string, { freq: number; q: number; gain: number }> = {
  stove:          { freq: 1400, q: 0.5, gain: 0.06 }, // gas — broader / lower
  "stove-electric": { freq: 2400, q: 0.8, gain: 0.05 }, // electric — narrower / higher
  microwave:      { freq: 900,  q: 1.5, gain: 0.04 }, // hum, not sizzle
};
const DEFAULT_SIZZLE = SIZZLE_PROFILES.stove;

export class SfxPlayer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private muted = false;
  /** Active cooking-loop graph (only one at a time — sums all active
   * chefs into a single source so we don't stack identical noise loops). */
  private cookingLoop: {
    source: AudioBufferSourceNode;
    filter: BiquadFilterNode;
    gain: GainNode;
    profileId: string;
  } | null = null;

  constructor() {
    try {
      this.muted = localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      this.muted = false;
    }
  }

  isMuted(): boolean { return this.muted; }
  setMuted(m: boolean): void {
    this.muted = m;
    try { localStorage.setItem(STORAGE_KEY, m ? "1" : "0"); } catch { /* ignore */ }
    // Tear down the cooking loop on mute so it doesn't keep sizzling
    // after the player silences everything else.
    if (m) this.stopCookingLoop();
  }

  /** Lazy-init the AudioContext. Returns null if creation fails. */
  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (this.ctx) return this.ctx;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.22; // overall softness — these are background blips
      this.masterGain.connect(this.ctx.destination);
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Soft bell — guest arrived. */
  ding(): void {
    this.tone({ freq: 880, type: "sine", attack: 0.005, decay: 0.18, gain: 0.6 });
    this.tone({ freq: 1320, type: "sine", attack: 0.01, decay: 0.18, gain: 0.4 });
  }

  /** Plate-set chime — food delivered to seat. */
  chime(): void {
    this.tone({ freq: 1320, type: "triangle", attack: 0.005, decay: 0.15, gain: 0.5 });
    setTimeout(() => this.tone({ freq: 1760, type: "triangle", attack: 0.005, decay: 0.18, gain: 0.45 }), 90);
  }

  /** Cha-ching — money earned. */
  chaching(): void {
    this.tone({ freq: 1568, type: "square", attack: 0.005, decay: 0.06, gain: 0.45 });
    setTimeout(() => this.tone({ freq: 2349, type: "square", attack: 0.005, decay: 0.15, gain: 0.4 }), 80);
  }

  /** Soft gong — end of day. */
  gong(): void {
    this.tone({ freq: 200, type: "sine", attack: 0.02, decay: 1.4, gain: 0.7 });
    this.tone({ freq: 280, type: "sine", attack: 0.02, decay: 1.2, gain: 0.45 });
  }

  /** Alert — critic arrived. */
  alert(): void {
    this.tone({ freq: 660, type: "sawtooth", attack: 0.01, decay: 0.18, gain: 0.5 });
    setTimeout(() => this.tone({ freq: 990, type: "sawtooth", attack: 0.01, decay: 0.22, gain: 0.45 }), 130);
  }

  /** Negative beep — guest left angry. */
  thud(): void {
    this.tone({ freq: 220, type: "square", attack: 0.005, decay: 0.18, gain: 0.55 });
    this.tone({ freq: 165, type: "square", attack: 0.005, decay: 0.20, gain: 0.45 });
  }

  /** Start (or update) a continuous sizzling/cooking loop. Idempotent —
   * calling repeatedly with the same stove id leaves the existing loop
   * running; calling with a different id rebuilds the filter chain so
   * the timbre swaps to match the active appliance. Pass null/no-arg
   * to use the default gas-stove profile. */
  startCookingLoop(stoveId: string = "stove"): void {
    const ctx = this.ensure();
    if (!ctx || !this.masterGain) return;
    // Already running with the right profile — nothing to do.
    if (this.cookingLoop && this.cookingLoop.profileId === stoveId) return;
    // Running with a different profile — restart so the new timbre applies.
    if (this.cookingLoop) this.stopCookingLoop();
    const profile = SIZZLE_PROFILES[stoveId] ?? DEFAULT_SIZZLE;
    // White-noise buffer, ~2 seconds, looped forever.
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i += 1) data[i] = (Math.random() * 2 - 1) * 0.6;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    // Bandpass filter shapes the noise into the chosen sizzle timbre.
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = profile.freq;
    filter.Q.value = profile.q;
    // Smooth fade-in to avoid a click on start.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(profile.gain, ctx.currentTime + 0.15);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    source.start();
    this.cookingLoop = { source, filter, gain, profileId: stoveId };
  }

  /** Fade out + tear down the active sizzling loop, if any. */
  stopCookingLoop(): void {
    if (!this.cookingLoop) return;
    const ctx = this.ctx;
    if (!ctx) { this.cookingLoop = null; return; }
    const { source, gain } = this.cookingLoop;
    // Snapshot current gain so the ramp starts from the live value
    // (not the original peak), then fade out smoothly.
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    // Hold the reference long enough for the ramp to land, then stop.
    setTimeout(() => { try { source.stop(); } catch { /* already stopped */ } }, 200);
    this.cookingLoop = null;
  }

  /** Internal: play a single tone with an exponential decay envelope. */
  private tone(opts: { freq: number; type: OscillatorType; attack: number; decay: number; gain: number }): void {
    const ctx = this.ensure();
    if (!ctx || !this.masterGain) return;
    const osc = ctx.createOscillator();
    osc.type = opts.type;
    osc.frequency.value = opts.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(opts.gain, ctx.currentTime + opts.attack);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + opts.attack + opts.decay);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start();
    osc.stop(ctx.currentTime + opts.attack + opts.decay + 0.02);
  }
}
