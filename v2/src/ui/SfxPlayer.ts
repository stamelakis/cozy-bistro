/**
 * Procedural sound effects + ambient background music using the Web
 * Audio API. Zero external assets — every sound is synthesised from
 * oscillators, noise buffers, and envelopes at play time.
 *
 * Two independent volume gates:
 *   - SFX (chimes, kitchen loops, water, etc.) — toggle in HUD
 *   - Music (background bistro ambient pad) — separate toggle
 *
 * Browser autoplay rules require user interaction before audio plays,
 * so the AudioContext is created lazily on the first call. Calls
 * before that just no-op.
 */

const STORAGE_KEY_SFX = "cozy-bistro-3d-sfx-muted";
const STORAGE_KEY_MUSIC = "cozy-bistro-3d-music-muted";

/** Per-appliance loop synth profile. Each variant gets a specialised
 * synthesis chain rather than the old single bandpass-on-noise that
 * the player rightly called "TV with no signal". */
type LoopId = "gas-stove" | "electric-stove" | "microwave" | "coffee"
            | "blender" | "toaster" | "hood" | "sink" | "bathtub" | "dishwasher";

interface LoopHandle {
  nodes: AudioNode[];          // root-level nodes so we can disconnect on stop
  gain: GainNode;              // the final output gain (ramp for fade in/out)
  variant: LoopId;
  /** Optional per-tick driver — called from AudioContext when we want
   * irregular events (bubble pops, gurgles) layered on top of the
   * continuous noise base. */
  ticker?: number;
}

/** Phase of the music day-night cycle — flipped by Engine.update from
 * the current DayCycleSystem progress. */
export type MusicPhase = "day" | "night";

export class SfxPlayer {
  private ctx: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxMuted = false;
  private musicMuted = false;
  /** Active named loops keyed by LoopId. setLoopActive flips them on
   * and off independently — multiple appliances can run at once. */
  private loops = new Map<LoopId, LoopHandle>();
  /** Streaming MP3 tracks for the daytime + nighttime restaurant
   * ambience. Files live in `public/audio/{daytime,nighttime}.mp3` and
   * Vite ships them as static assets under BASE_URL. Failed loads are
   * silent — startMusic just plays the available track (or stays
   * quiet if neither resolves). */
  private dayAudio?: HTMLAudioElement;
  private nightAudio?: HTMLAudioElement;
  private musicPhase: MusicPhase = "day";
  private musicStarted = false;
  /** Cached file-availability flags — set in the constructor's load
   * probe so startMusic doesn't try to play a 404. */
  private dayAudioReady = false;
  private nightAudioReady = false;

  constructor() {
    try {
      this.sfxMuted = localStorage.getItem(STORAGE_KEY_SFX) === "1";
      this.musicMuted = localStorage.getItem(STORAGE_KEY_MUSIC) === "1";
    } catch {
      this.sfxMuted = false;
      this.musicMuted = false;
    }
    // Lazily build the two background-music streams. HTMLAudioElement
    // runs on its own audio thread, separate from the WebAudio SFX
    // context, so no resource fight with the appliance loops. canplay
    // marks the track as actually usable; error keeps the flag false
    // so we never try to play a 404-ing stream.
    try {
      const base = (typeof import.meta !== "undefined" && (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL) || "/";
      const mk = (file: string, onReady: () => void): HTMLAudioElement => {
        const a = new Audio(`${base}audio/${file}`);
        a.loop = true;
        a.volume = 0.55;
        a.preload = "auto";
        a.addEventListener("canplaythrough", onReady, { once: true });
        return a;
      };
      this.dayAudio   = mk("daytime.mp3",   () => { this.dayAudioReady = true; this.maybeRestartMusic(); });
      this.nightAudio = mk("nighttime.mp3", () => { this.nightAudioReady = true; this.maybeRestartMusic(); });
    } catch {
      // Audio constructor blocked or `import.meta` shape unexpected —
      // skip music. SFX still works.
    }
  }

  // === Public mute toggles ============================================

  isMuted(): boolean { return this.sfxMuted; }
  setMuted(m: boolean): void {
    this.sfxMuted = m;
    try { localStorage.setItem(STORAGE_KEY_SFX, m ? "1" : "0"); } catch { /* ignore */ }
    if (m) this.stopAllLoops();
    // Hot-swap the SFX bus gain so already-running loops fall silent
    // immediately without a tear-down race.
    if (this.sfxBus && this.ctx) {
      this.sfxBus.gain.cancelScheduledValues(this.ctx.currentTime);
      this.sfxBus.gain.setValueAtTime(m ? 0 : 0.22, this.ctx.currentTime);
    }
  }
  isMusicMuted(): boolean { return this.musicMuted; }
  setMusicMuted(m: boolean): void {
    this.musicMuted = m;
    try { localStorage.setItem(STORAGE_KEY_MUSIC, m ? "1" : "0"); } catch { /* ignore */ }
    if (m) {
      // Pause WITHOUT clearing musicStarted — flipping the toggle back
      // off should resume the same track, not re-prompt for the user
      // gesture flow.
      if (this.dayAudio)   try { this.dayAudio.pause();   } catch { /* */ }
      if (this.nightAudio) try { this.nightAudio.pause(); } catch { /* */ }
    } else if (this.musicStarted) {
      this.playActiveTrack();
    }
  }

  // === One-shot SFX (called from gameplay) =============================

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

  /** Toilet flush — short downward whoosh + tail gurgle. */
  toiletFlush(): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfxBus) return;
    // Whoosh: noise band swept down in pitch over ~1.2 s.
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(2.0);
    noise.loop = false;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1600, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 1.2);
    filter.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.4);
    noise.connect(filter); filter.connect(g); g.connect(this.sfxBus);
    noise.start();
    noise.stop(ctx.currentTime + 1.5);
    // Tail gurgle: bubbly low oscillation after the main whoosh.
    setTimeout(() => this.tone({ freq: 110, type: "sine", attack: 0.05, decay: 0.6, gain: 0.3 }), 900);
  }

  /** Single drip — used for sink dwell completions etc. */
  drip(): void {
    this.tone({ freq: 1500, type: "sine", attack: 0.002, decay: 0.04, gain: 0.35 });
    setTimeout(() => this.tone({ freq: 600, type: "sine", attack: 0.002, decay: 0.06, gain: 0.25 }), 40);
  }

  // === Loop control (called every Engine tick) =========================

  /** Enable / disable a named appliance loop. Idempotent — calling
   * with the same value twice has no effect. */
  setLoopActive(id: LoopId, on: boolean): void {
    if (on) this.startLoop(id);
    else this.stopLoop(id);
  }

  /** Stop every active loop — used on global mute. */
  stopAllLoops(): void {
    for (const id of Array.from(this.loops.keys())) this.stopLoop(id);
  }

  // === Background music ================================================
  //
  // Music is two pre-rendered MP3s — one for daytime, one for night —
  // streamed via HTMLAudioElement. Engine flips the phase from the
  // DayCycleSystem progress; we crossfade by pausing one track and
  // starting the other from its last position (looped).

  startMusic(): void {
    if (this.musicMuted) return;
    this.musicStarted = true;
    this.playActiveTrack();
  }

  stopMusic(): void {
    this.musicStarted = false;
    if (this.dayAudio)   try { this.dayAudio.pause();   } catch { /* */ }
    if (this.nightAudio) try { this.nightAudio.pause(); } catch { /* */ }
  }

  /** Tell the player whether it's daytime or nighttime in-game. The
   * Engine calls this from update() based on the DayCycleSystem
   * progress; when the phase flips and music is playing we swap to
   * the other track. No-op when the requested phase is already
   * active. */
  setMusicPhase(phase: MusicPhase): void {
    if (this.musicPhase === phase) return;
    this.musicPhase = phase;
    if (this.musicStarted) this.playActiveTrack();
  }

  /** Play whichever track matches the current phase, pause the other.
   * Tracks resume from wherever they were last paused so a phase
   * flip mid-day doesn't always restart from the intro. */
  private playActiveTrack(): void {
    if (this.musicMuted) return;
    const active = this.musicPhase === "day" ? this.dayAudio : this.nightAudio;
    const inactive = this.musicPhase === "day" ? this.nightAudio : this.dayAudio;
    const activeReady = this.musicPhase === "day" ? this.dayAudioReady : this.nightAudioReady;
    if (inactive) try { inactive.pause(); } catch { /* */ }
    if (active && activeReady) {
      // play() may reject due to autoplay policy on the very first
      // call — silently swallow; kickAudio's user-interaction handler
      // is the standard retry path.
      active.play().catch(() => { /* autoplay blocked, will retry on user gesture */ });
    }
  }

  /** Called from the canplaythrough handler when one of the MP3s
   * finishes loading. If the player has already asked for music to
   * start but we couldn't play because the file wasn't ready yet,
   * kick it now. */
  private maybeRestartMusic(): void {
    if (this.musicStarted && !this.musicMuted) this.playActiveTrack();
  }

  // === Internals =======================================================

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxMuted ? 0 : 0.22;
      this.sfxBus.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.4;  // music is mixed at its own level
      this.musicBus.connect(this.ctx.destination);
      return this.ctx;
    } catch {
      return null;
    }
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i += 1) data[i] = (Math.random() * 2 - 1) * 0.6;
    return buf;
  }

  private tone(opts: { freq: number; type: OscillatorType; attack: number; decay: number; gain: number }): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfxBus || this.sfxMuted) return;
    const osc = ctx.createOscillator();
    osc.type = opts.type;
    osc.frequency.value = opts.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(opts.gain, ctx.currentTime + opts.attack);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + opts.attack + opts.decay);
    osc.connect(g);
    g.connect(this.sfxBus);
    osc.start();
    osc.stop(ctx.currentTime + opts.attack + opts.decay + 0.02);
  }

  private startLoop(id: LoopId): void {
    if (this.sfxMuted) return;
    if (this.loops.has(id)) return;
    const ctx = this.ensure();
    if (!ctx || !this.sfxBus) return;
    const handle = this.makeLoop(id, ctx, this.sfxBus);
    if (handle) this.loops.set(id, handle);
  }

  private stopLoop(id: LoopId): void {
    const h = this.loops.get(id);
    if (!h) return;
    const ctx = this.ctx;
    if (ctx) {
      h.gain.gain.cancelScheduledValues(ctx.currentTime);
      h.gain.gain.setValueAtTime(h.gain.gain.value, ctx.currentTime);
      h.gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      const nodes = h.nodes;
      window.setTimeout(() => {
        for (const n of nodes) {
          try {
            if ((n as AudioScheduledSourceNode).stop) (n as AudioScheduledSourceNode).stop();
            n.disconnect();
          } catch { /* already gone */ }
        }
      }, 240);
    }
    if (h.ticker !== undefined) window.clearInterval(h.ticker);
    this.loops.delete(id);
  }

  /** Build the per-variant synthesis chain. Each one connects through a
   * fade-in gain → sfxBus and returns the handle for later teardown. */
  private makeLoop(id: LoopId, ctx: AudioContext, bus: GainNode): LoopHandle | null {
    // Fade-in envelope shared by every loop.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    const nodes: AudioNode[] = [gain];

    const ensureLoopSource = (durSec: number, loopFlag = true): AudioBufferSourceNode => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(durSec);
      src.loop = loopFlag;
      src.start();
      nodes.push(src);
      return src;
    };
    const peak = (v: number) => {
      gain.gain.exponentialRampToValueAtTime(v, ctx.currentTime + 0.20);
    };

    switch (id) {
      case "gas-stove": {
        // Layered: low whoosh body (filtered noise around 200 Hz) +
        // mid sizzle (bandpass ~900 Hz) + crackles via random tone
        // bursts. Reads as a real flame instead of TV static.
        const body = ensureLoopSource(2);
        const bodyFilt = ctx.createBiquadFilter();
        bodyFilt.type = "bandpass"; bodyFilt.frequency.value = 230; bodyFilt.Q.value = 0.8;
        const bodyG = ctx.createGain(); bodyG.gain.value = 0.7;
        body.connect(bodyFilt); bodyFilt.connect(bodyG); bodyG.connect(gain);
        nodes.push(bodyFilt, bodyG);
        const sizz = ensureLoopSource(2);
        const sizzFilt = ctx.createBiquadFilter();
        sizzFilt.type = "bandpass"; sizzFilt.frequency.value = 900; sizzFilt.Q.value = 1.4;
        const sizzG = ctx.createGain(); sizzG.gain.value = 0.35;
        sizz.connect(sizzFilt); sizzFilt.connect(sizzG); sizzG.connect(gain);
        nodes.push(sizzFilt, sizzG);
        peak(0.055);
        // Random crackle pops every 0.6-1.6s for the "something's
        // cooking" feel.
        const ticker = window.setInterval(() => {
          if (Math.random() < 0.6) this.crackle();
        }, 700);
        gain.connect(bus);
        return { nodes, gain, variant: id, ticker };
      }
      case "electric-stove": {
        // Induction-style: NO flame whoosh body, just two slowly-beating
        // sine tones (~440 + 444 Hz) that give the "magnetic field
        // humming" character + a quiet electrical buzz. Distinctly
        // different from the gas stove's noise-based sizzle so the
        // player can tell which appliance is on by ear.
        const o1 = ctx.createOscillator(); o1.type = "sine"; o1.frequency.value = 440;
        const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = 444;
        const oG = ctx.createGain(); oG.gain.value = 0.18;
        o1.connect(oG); o2.connect(oG); oG.connect(gain);
        o1.start(); o2.start();
        nodes.push(o1, o2, oG);
        // Quiet 60 Hz buzz layered underneath for the electric feel.
        const buzz = ctx.createOscillator();
        buzz.type = "square"; buzz.frequency.value = 120;
        const buzzG = ctx.createGain(); buzzG.gain.value = 0.04;
        buzz.connect(buzzG); buzzG.connect(gain); buzz.start();
        nodes.push(buzz, buzzG);
        peak(0.06);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "microwave": {
        // Steady fan + low electrical hum. Two oscillators offset by a
        // few hertz to give the moving-air subtle beat.
        const o1 = ctx.createOscillator(); o1.type = "sine"; o1.frequency.value = 120;
        const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = 124;
        const noise = ensureLoopSource(2);
        const noiseFilt = ctx.createBiquadFilter();
        noiseFilt.type = "lowpass"; noiseFilt.frequency.value = 600;
        noise.connect(noiseFilt);
        const noiseG = ctx.createGain(); noiseG.gain.value = 0.15;
        noiseFilt.connect(noiseG);
        o1.connect(gain); o2.connect(gain); noiseG.connect(gain);
        o1.start(); o2.start();
        nodes.push(o1, o2, noiseFilt, noiseG);
        peak(0.04);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "coffee": {
        // High-pressure steam: bright filtered noise + intermittent
        // gurgle bursts that bubble through the bed.
        const noise = ensureLoopSource(2);
        const hi = ctx.createBiquadFilter();
        hi.type = "bandpass"; hi.frequency.value = 3200; hi.Q.value = 1.0;
        noise.connect(hi); hi.connect(gain);
        nodes.push(hi);
        peak(0.05);
        const ticker = window.setInterval(() => {
          // Occasional bubble.
          this.tone({ freq: 320 + Math.random() * 200, type: "sine", attack: 0.005, decay: 0.10, gain: 0.20 });
        }, 600);
        gain.connect(bus);
        return { nodes, gain, variant: id, ticker };
      }
      case "blender": {
        // Loud motor whine: layered sawtooth + harmonic + noise burst
        // on top. Sounds like the motor is genuinely working hard.
        const motor = ctx.createOscillator(); motor.type = "sawtooth"; motor.frequency.value = 280;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
        const motorG = ctx.createGain(); motorG.gain.value = 0.6;
        motor.connect(lp); lp.connect(motorG); motorG.connect(gain);
        motor.start();
        nodes.push(motor, lp, motorG);
        // Higher-pitched whine harmonic.
        const whine = ctx.createOscillator(); whine.type = "sawtooth"; whine.frequency.value = 840;
        const whineG = ctx.createGain(); whineG.gain.value = 0.10;
        whine.connect(whineG); whineG.connect(gain); whine.start();
        nodes.push(whine, whineG);
        // Noise on top — frothy / chopping character.
        const noise = ensureLoopSource(2);
        const noiseBp = ctx.createBiquadFilter(); noiseBp.type = "bandpass"; noiseBp.frequency.value = 1800; noiseBp.Q.value = 0.7;
        const noiseG = ctx.createGain(); noiseG.gain.value = 0.25;
        noise.connect(noiseBp); noiseBp.connect(noiseG); noiseG.connect(gain);
        nodes.push(noiseBp, noiseG);
        // LFO on motor frequency for "load changes" character.
        const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 6;
        const lfoG = ctx.createGain(); lfoG.gain.value = 18;
        lfo.connect(lfoG); lfoG.connect(motor.frequency); lfo.start();
        nodes.push(lfo, lfoG);
        peak(0.085);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "toaster": {
        // Heating-coil hiss + electrical hum. The hum alone was so
        // quiet it read as silence — pair it with a high-frequency
        // noise layer (filtered around 5 kHz) that sells the "coils
        // are glowing" character, plus the occasional crackle for
        // the bread-toasting feel.
        const hum = ctx.createOscillator(); hum.type = "sine"; hum.frequency.value = 60;
        const humG = ctx.createGain(); humG.gain.value = 0.5;
        hum.connect(humG); humG.connect(gain); hum.start();
        const harm = ctx.createOscillator(); harm.type = "sine"; harm.frequency.value = 240;
        const harmG = ctx.createGain(); harmG.gain.value = 0.25;
        harm.connect(harmG); harmG.connect(gain); harm.start();
        nodes.push(hum, harm, humG, harmG);
        // Coil-hiss layer — high-band noise.
        const noise = ensureLoopSource(2);
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 5000; bp.Q.value = 1.2;
        const noiseG = ctx.createGain(); noiseG.gain.value = 0.4;
        noise.connect(bp); bp.connect(noiseG); noiseG.connect(gain);
        nodes.push(bp, noiseG);
        peak(0.07);
        // Occasional pop / crackle while the bread browns.
        const ticker = window.setInterval(() => {
          if (Math.random() < 0.25) this.crackle();
        }, 900);
        gain.connect(bus);
        return { nodes, gain, variant: id, ticker };
      }
      case "hood": {
        // Fan: wide-band noise centred mid frequency.
        const noise = ensureLoopSource(2);
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 600; bp.Q.value = 0.6;
        noise.connect(bp); bp.connect(gain);
        nodes.push(bp);
        peak(0.04);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "sink": {
        // Running water: layered noise (mid + high bands) with a
        // bigger gain so it actually reads as a tap running. Original
        // was too quiet to register over the gas-stove sizzle.
        const noise = ensureLoopSource(2);
        const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 700;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 5500;
        const bodyG = ctx.createGain(); bodyG.gain.value = 0.85;
        noise.connect(hp); hp.connect(lp); lp.connect(bodyG); bodyG.connect(gain);
        nodes.push(hp, lp, bodyG);
        // Splash layer — narrower bandpass around 2 kHz gives the
        // water-hitting-basin character distinct from the body.
        const splash = ensureLoopSource(2);
        const splashBp = ctx.createBiquadFilter(); splashBp.type = "bandpass"; splashBp.frequency.value = 2000; splashBp.Q.value = 0.6;
        const splashG = ctx.createGain(); splashG.gain.value = 0.4;
        splash.connect(splashBp); splashBp.connect(splashG); splashG.connect(gain);
        nodes.push(splashBp, splashG);
        peak(0.11);
        const ticker = window.setInterval(() => {
          if (Math.random() < 0.5) this.tone({ freq: 700 + Math.random() * 600, type: "sine", attack: 0.002, decay: 0.06, gain: 0.25 });
        }, 300);
        gain.connect(bus);
        return { nodes, gain, variant: id, ticker };
      }
      case "bathtub": {
        // Slower, gentler water: noise + lower band, slower bubbles.
        const noise = ensureLoopSource(2);
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = 0.6;
        noise.connect(bp); bp.connect(gain);
        nodes.push(bp);
        peak(0.05);
        const ticker = window.setInterval(() => {
          if (Math.random() < 0.5) this.tone({ freq: 300 + Math.random() * 200, type: "sine", attack: 0.005, decay: 0.18, gain: 0.18 });
        }, 800);
        gain.connect(bus);
        return { nodes, gain, variant: id, ticker };
      }
      case "dishwasher": {
        // Continuous wash: low motor rumble + water swoosh + soft
        // rhythmic surges every couple of seconds for the "spray arm
        // turning" feel.
        const motor = ctx.createOscillator(); motor.type = "sine"; motor.frequency.value = 80;
        const motorG = ctx.createGain(); motorG.gain.value = 0.2;
        motor.connect(motorG); motorG.connect(gain); motor.start();
        nodes.push(motor, motorG);
        const water = ensureLoopSource(2);
        const wbp = ctx.createBiquadFilter(); wbp.type = "bandpass"; wbp.frequency.value = 1200; wbp.Q.value = 0.5;
        water.connect(wbp); wbp.connect(gain);
        nodes.push(wbp);
        peak(0.05);
        // Rhythmic surge — LFO on the motor gain.
        const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 0.4;
        const lfoG = ctx.createGain(); lfoG.gain.value = 0.08;
        lfo.connect(lfoG); lfoG.connect(motorG.gain); lfo.start();
        nodes.push(lfo, lfoG);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
    }
    return null;
  }

  /** One-off crackle pop — short noise burst for stove ambience. */
  private crackle(): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfxBus || this.sfxMuted) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.05);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
    src.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    src.start();
    src.stop(ctx.currentTime + 0.06);
  }
}
