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

export class SfxPlayer {
  private ctx: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxMuted = false;
  private musicMuted = false;
  /** Active named loops keyed by LoopId. setLoopActive flips them on
   * and off independently — multiple appliances can run at once. */
  private loops = new Map<LoopId, LoopHandle>();
  /** Background music chain (separate from sfxBus so the player can
   * silence either independently). */
  private music?: {
    schedulerInterval: number;
    masterGain: GainNode;
    nextTime: number;
    chordIndex: number;
  };

  constructor() {
    try {
      this.sfxMuted = localStorage.getItem(STORAGE_KEY_SFX) === "1";
      this.musicMuted = localStorage.getItem(STORAGE_KEY_MUSIC) === "1";
    } catch {
      this.sfxMuted = false;
      this.musicMuted = false;
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
    if (m) this.stopMusic();
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

  startMusic(): void {
    if (this.musicMuted) return;
    if (this.music) return;
    const ctx = this.ensure();
    if (!ctx || !this.musicBus) return;
    // Slow 4-chord progression: Cmaj7, Am7, Fmaj7, G7. Pleasant cosy
    // jazz-cafe palette. Each chord plays for ~6 seconds.
    const chords: number[][] = [
      [261.63, 329.63, 392.00, 493.88],  // C E G B
      [220.00, 261.63, 329.63, 392.00],  // A C E G
      [174.61, 220.00, 261.63, 349.23],  // F A C F (Fmaj7 voiced)
      [196.00, 246.94, 293.66, 392.00],  // G B D G (G7-ish)
    ];
    const master = ctx.createGain();
    master.gain.value = 0.20;
    master.connect(this.musicBus);
    const state = {
      schedulerInterval: 0,
      masterGain: master,
      nextTime: ctx.currentTime + 0.1,
      chordIndex: 0,
    };
    this.music = state;
    // Schedule chords ahead of time. Re-run every 250 ms to keep ~1.5 s
    // of audio scheduled in advance — survives tab-throttling without
    // glitching.
    const scheduleChord = (when: number, freqs: number[]): void => {
      const duration = 6.0;
      // Soft pad for each note: sine + a quieter octave-down for body.
      for (const f of freqs) {
        const o1 = ctx.createOscillator();
        o1.type = "sine";
        o1.frequency.value = f;
        const o2 = ctx.createOscillator();
        o2.type = "sine";
        o2.frequency.value = f / 2;
        const g = ctx.createGain();
        // Soft attack + long sustain + slow release. Volume per note
        // scaled so 4 voices don't sum into clipping.
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(0.14, when + 0.5);
        g.gain.setValueAtTime(0.14, when + duration - 1.0);
        g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
        // Low-pass to soften the sine tops — keeps the pad mellow.
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 1400;
        o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
        o1.start(when); o2.start(when);
        o1.stop(when + duration + 0.1);
        o2.stop(when + duration + 0.1);
      }
    };
    const tick = (): void => {
      if (!this.ctx || !this.music) return;
      while (this.music.nextTime < this.ctx.currentTime + 1.5) {
        scheduleChord(this.music.nextTime, chords[this.music.chordIndex]);
        this.music.nextTime += 6.0;
        this.music.chordIndex = (this.music.chordIndex + 1) % chords.length;
      }
    };
    tick();
    state.schedulerInterval = window.setInterval(tick, 250);
  }

  stopMusic(): void {
    if (!this.music) return;
    window.clearInterval(this.music.schedulerInterval);
    const ctx = this.ctx;
    if (ctx) {
      // Soft fade so the last chord doesn't cut off mid-note.
      this.music.masterGain.gain.cancelScheduledValues(ctx.currentTime);
      this.music.masterGain.gain.setValueAtTime(this.music.masterGain.gain.value, ctx.currentTime);
      this.music.masterGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.5);
      // Disconnect after the ramp completes.
      const m = this.music;
      window.setTimeout(() => { try { m.masterGain.disconnect(); } catch { /* */ } }, 1700);
    }
    this.music = undefined;
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
        // Cleaner: high bandpass + 50 Hz mains hum carrier.
        const noise = ensureLoopSource(2);
        const filt = ctx.createBiquadFilter();
        filt.type = "bandpass"; filt.frequency.value = 1900; filt.Q.value = 0.9;
        noise.connect(filt); filt.connect(gain);
        nodes.push(filt);
        const hum = ctx.createOscillator();
        hum.type = "sine"; hum.frequency.value = 60;
        const humG = ctx.createGain(); humG.gain.value = 0.06;
        hum.connect(humG); humG.connect(gain); hum.start();
        nodes.push(hum, humG);
        peak(0.045);
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
        // Loud motor whine: sawtooth + harmonic resonance.
        const motor = ctx.createOscillator(); motor.type = "sawtooth"; motor.frequency.value = 220;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1800;
        motor.connect(lp); lp.connect(gain);
        motor.start();
        nodes.push(motor, lp);
        // Slight modulation: LFO on the motor frequency for "load
        // changes" character.
        const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 6;
        const lfoG = ctx.createGain(); lfoG.gain.value = 12;
        lfo.connect(lfoG); lfoG.connect(motor.frequency); lfo.start();
        nodes.push(lfo, lfoG);
        peak(0.055);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "toaster": {
        // Quiet electrical hum.
        const hum = ctx.createOscillator(); hum.type = "sine"; hum.frequency.value = 60;
        const harm = ctx.createOscillator(); harm.type = "sine"; harm.frequency.value = 180;
        const harmG = ctx.createGain(); harmG.gain.value = 0.3;
        harm.connect(harmG); harmG.connect(gain);
        hum.connect(gain);
        hum.start(); harm.start();
        nodes.push(hum, harm, harmG);
        peak(0.035);
        gain.connect(bus);
        return { nodes, gain, variant: id };
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
        // Running water: noise with high-pass + random bubble pops.
        const noise = ensureLoopSource(2);
        const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 800;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 4500;
        noise.connect(hp); hp.connect(lp); lp.connect(gain);
        nodes.push(hp, lp);
        peak(0.055);
        const ticker = window.setInterval(() => {
          if (Math.random() < 0.4) this.tone({ freq: 700 + Math.random() * 600, type: "sine", attack: 0.002, decay: 0.06, gain: 0.18 });
        }, 350);
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
