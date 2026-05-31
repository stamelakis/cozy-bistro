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
const STORAGE_KEY_SFX_VOLUME = "cozy-bistro-3d-sfx-volume";

/** Bus gain at sfxVolume = 1. Below 1 scales linearly toward silence.
 * Master ceiling halved from the previous 0.7 after user feedback
 * that the upper range was too loud overall. Default sfxVolume of
 * 0.3 (30% of max) lands the bus at ~0.105 — comfortably audible
 * without being aggressive. Slider all the way right tops out at
 * 0.35, which is roughly the old hardcoded "always-on" level. */
const SFX_BUS_MAX_GAIN = 0.35;
/** Same idea for music. HTMLAudio volume is 0..1; halved from the
 * previous 0.8 in lockstep with the SFX max so music and SFX scale
 * together at the same proportions. */
const MUSIC_MAX_VOLUME = 0.4;

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

/** 4-phase day cycle (matches WorldScene.applyDayNight boundaries).
 *   day  — full sun.        Daytime track loops at full volume.
 *   dusk — sun setting.     Daytime track no longer loops, linearly
 *                           fades to 0 over the dusk window. If the
 *                           track ends naturally before dusk does,
 *                           silence for the remainder.
 *   night — dark.           Nighttime track loops at full volume.
 *   dawn — sun rising.      Nighttime track no longer loops, linearly
 *                           fades to 0 over the dawn window. Same
 *                           "natural end = silence" rule as dusk. */
export type DayPhase = "day" | "dusk" | "night" | "dawn";

// Phase boundaries copied from WorldScene.applyDayNight. Kept in sync
// by code review — both files reference the same 4-phase 24h split.
const DAWN_END = 0.083;
const DAY_END  = 0.583;
const DUSK_END = 0.667;

export class SfxPlayer {
  private ctx: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxMuted = false;
  private musicMuted = false;
  /** Independent "the camera zoomed out past the interior threshold"
   * mute on the SFX bus only — driven by Engine.tick. Doesn't touch
   * the user's master mute, doesn't persist. Music keeps playing
   * (it's not an interior sound). */
  private exteriorMuted = false;
  /** Master volume slider value, 0..1. Drives both the SFX bus gain
   * (×SFX_BUS_MAX_GAIN) and the music audio element volume
   * (×MUSIC_MAX_VOLUME). Persisted across sessions. */
  private sfxVolume = 0.3;
  /** Active named loops keyed by LoopId. setLoopActive flips them on
   * and off independently — multiple appliances can run at once. */
  private loops = new Map<LoopId, LoopHandle>();
  /** Loop ids the dev admin panel is currently force-driving. The
   * engine's per-frame setLoopActive(...) calls are ignored for any id
   * in this set, so a test-panel "▶ Play" survives the engine's
   * immediate "no chef is cooking → stop this loop" override on the
   * very next frame. */
  private testLocks = new Set<LoopId>();
  /** Streaming MP3 tracks for the daytime + nighttime restaurant
   * ambience. Files live in `public/audio/{daytime,nighttime}.mp3` and
   * Vite ships them as static assets under BASE_URL. Failed loads are
   * silent — startMusic just plays the available track (or stays
   * quiet if neither resolves). */
  private dayAudio?: HTMLAudioElement;
  private nightAudio?: HTMLAudioElement;
  /** Last-known phase. `undefined` until setDayProgress is first
   * called — the first call always triggers a phase-enter transition
   * even when the answer is "day". */
  private musicPhase?: DayPhase;
  private musicStarted = false;
  /** Cached file-availability flags — set in the constructor's load
   * probe so startMusic doesn't try to play a 404. */
  private dayAudioReady = false;
  private nightAudioReady = false;

  constructor() {
    try {
      this.sfxMuted = localStorage.getItem(STORAGE_KEY_SFX) === "1";
      this.musicMuted = localStorage.getItem(STORAGE_KEY_MUSIC) === "1";
      const raw = localStorage.getItem(STORAGE_KEY_SFX_VOLUME);
      const parsed = raw === null ? NaN : Number(raw);
      if (Number.isFinite(parsed)) {
        this.sfxVolume = Math.max(0, Math.min(1, parsed));
      }
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
        a.volume = this.currentMusicVolume(1);
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
    this.applyBusGain();
  }

  /** Engine.tick calls this when the camera crosses the 40%-zoom
   * threshold. When `on=true` the SFX bus is silenced and any active
   * appliance loops stop so the restaurant goes quiet — even though
   * the user's master mute and the music keep their state. */
  setExteriorMuted(on: boolean): void {
    if (this.exteriorMuted === on) return;
    this.exteriorMuted = on;
    if (on) this.stopAllLoops();
    this.applyBusGain();
  }

  /** Volume slider value, 0..1. Drives the SFX bus gain when not muted.
   * Persisted across sessions. */
  getVolume(): number { return this.sfxVolume; }
  setVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(STORAGE_KEY_SFX_VOLUME, this.sfxVolume.toFixed(3)); } catch { /* ignore */ }
    this.applyBusGain();
  }

  /** Sync the AudioContext SFX bus gain AND the HTMLAudio music
   * elements to the current mute + volume state. Cheap; called from
   * any setter that affects either. Uses direct `.value =` assignment
   * (equivalent to cancelScheduledValues + setValueAtTime but more
   * obviously immediate). */
  private applyBusGain(): void {
    // SFX bus — only exists after the AudioContext is created on the
    // first user gesture. Silenced when EITHER the user master mute
    // or the exterior-mode mute is active.
    if (this.sfxBus) {
      const muted = this.sfxMuted || this.exteriorMuted;
      this.sfxBus.gain.value = muted ? 0 : this.sfxVolume * SFX_BUS_MAX_GAIN;
    }
    // Music — applyBusGain is for "user toggled mute or moved the
    // master slider" type events; we don't know the live dusk/dawn
    // fade ratio here, so just apply the steady-state volume. If we
    // happen to be mid-fade, the next setDayProgress tick (called
    // every Engine frame) overwrites with the correctly-interpolated
    // value within ~16ms.
    const target = this.currentMusicVolume(1);
    if (this.dayAudio)   this.dayAudio.volume   = target;
    if (this.nightAudio) this.nightAudio.volume = target;
  }

  /** Combine master slider + music mute + fade factor into the actual
   * HTMLAudio volume to apply. Range 0..1. */
  private currentMusicVolume(fade: number): number {
    if (this.musicMuted) return 0;
    const f = Math.max(0, Math.min(1, fade));
    return Math.max(0, Math.min(1, this.sfxVolume * MUSIC_MAX_VOLUME * f));
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
    } else if (this.musicStarted && this.musicPhase) {
      // Resume whatever the current phase wants. enterPhase is the
      // single source of truth for "what should be playing right now".
      this.enterPhase(this.musicPhase);
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

  /** Toilet flush — sustained gushing water with a downward pitch
   * drift. Pure water sound, no glug ticks (the previous sine-tone
   * bubbles read as unrelated drips on top of the flush). */
  toiletFlush(): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfxBus) return;
    const DURATION = 2.6;
    // Main water gush — wide noise band that drifts from upper-mid
    // (flush-start splash) down to low-mid (bowl emptying out).
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(DURATION + 0.5);
    noise.loop = false;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 500;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(3500, ctx.currentTime);
    lp.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + DURATION);
    noise.connect(hp); hp.connect(lp);
    const bodyG = ctx.createGain();
    bodyG.gain.setValueAtTime(0.0001, ctx.currentTime);
    bodyG.gain.exponentialRampToValueAtTime(0.55, ctx.currentTime + 0.15);
    bodyG.gain.setValueAtTime(0.55, ctx.currentTime + DURATION - 0.6);
    bodyG.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + DURATION);
    lp.connect(bodyG); bodyG.connect(this.sfxBus);
    noise.start();
    noise.stop(ctx.currentTime + DURATION + 0.1);
  }

  /** Single drip — used for sink dwell completions etc. */
  drip(): void {
    this.tone({ freq: 1500, type: "sine", attack: 0.002, decay: 0.04, gain: 0.35 });
    setTimeout(() => this.tone({ freq: 600, type: "sine", attack: 0.002, decay: 0.06, gain: 0.25 }), 40);
  }

  // === Loop control (called every Engine tick) =========================

  /** Enable / disable a named appliance loop. Idempotent — calling
   * with the same value twice has no effect. Calls from the engine's
   * per-frame update are ignored for any id currently locked by the
   * test panel; see setLoopTestActive. */
  setLoopActive(id: LoopId, on: boolean): void {
    if (this.testLocks.has(id)) return;
    if (on) this.startLoop(id);
    else this.stopLoop(id);
  }

  /** Test-panel control. Like setLoopActive but takes ownership of the
   * loop until explicitly cleared, blocking the engine from stopping
   * it. Pass on=false to release the lock + stop. */
  setLoopTestActive(id: LoopId, on: boolean): void {
    if (on) {
      this.testLocks.add(id);
      this.startLoop(id);
    } else {
      this.testLocks.delete(id);
      this.stopLoop(id);
    }
  }

  /** Stop every active loop — used on global mute. */
  stopAllLoops(): void {
    this.testLocks.clear();
    for (const id of Array.from(this.loops.keys())) this.stopLoop(id);
  }

  // === Background music ================================================
  //
  // Two pre-rendered MP3s in public/audio/, played via HTMLAudioElement.
  // Engine.update calls setDayProgress(progress) every frame. Internally
  // we maintain a 4-phase state machine:
  //
  //   day   → loop daytime.mp3 at full volume.
  //   dusk  → daytime.mp3 keeps playing but loop=false, volume linearly
  //           fades to 0 across the dusk window. If the track's natural
  //           end comes first, silence for the remainder of dusk.
  //   night → loop nighttime.mp3 at full volume.
  //   dawn  → nighttime.mp3 keeps playing but loop=false, volume linearly
  //           fades to 0 across the dawn window. Same natural-end rule.

  startMusic(): void {
    if (this.musicMuted) return;
    this.musicStarted = true;
    if (this.musicPhase) this.enterPhase(this.musicPhase);
    // If setDayProgress hasn't been called yet, the next call will
    // trigger enterPhase as soon as we know which phase we're in.
  }

  stopMusic(): void {
    this.musicStarted = false;
    if (this.dayAudio)   try { this.dayAudio.pause();   } catch { /* */ }
    if (this.nightAudio) try { this.nightAudio.pause(); } catch { /* */ }
  }

  /** Engine.update feeds the live day-cycle progress here. We pick the
   * matching phase, run enterPhase on transitions, and update the
   * dusk/dawn fade volume every frame. Idempotent within a phase. */
  setDayProgress(progress: number): void {
    const phase = SfxPlayer.phaseFor(progress);
    if (phase !== this.musicPhase) {
      this.musicPhase = phase;
      if (this.musicStarted) this.enterPhase(phase);
    }
    // Drive the linear fade ramp through the transition windows.
    // Only touches the track if it's currently playing — if the track
    // ended naturally we leave it paused (silence for the rest of the
    // window).
    if (this.musicMuted) return;
    if (phase === "dusk" && this.dayAudio && !this.dayAudio.paused) {
      const t = (progress - DAY_END) / (DUSK_END - DAY_END);
      this.dayAudio.volume = this.currentMusicVolume(1 - t);
    } else if (phase === "dawn" && this.nightAudio && !this.nightAudio.paused) {
      const t = progress / DAWN_END;
      this.nightAudio.volume = this.currentMusicVolume(1 - t);
    }
  }

  /** Apply the steady-state behavior for a phase: start the active
   * track from scratch if we're entering a loop phase, switch loop=false
   * on the active track if we're entering a fade phase. */
  private enterPhase(phase: DayPhase): void {
    if (!this.musicStarted || this.musicMuted) return;
    switch (phase) {
      case "day": {
        // Pause the night track (it may still be running from a
        // mid-dawn skip if the user fast-forwarded). Start the day
        // track from the top at full volume.
        if (this.nightAudio) try { this.nightAudio.pause(); } catch { /* */ }
        if (this.dayAudio && this.dayAudioReady) {
          this.dayAudio.loop = true;
          this.dayAudio.volume = this.currentMusicVolume(1);
          this.dayAudio.currentTime = 0;
          this.dayAudio.play().catch(() => { /* autoplay-policy; will retry on next user gesture */ });
        }
        break;
      }
      case "night": {
        if (this.dayAudio) try { this.dayAudio.pause(); } catch { /* */ }
        if (this.nightAudio && this.nightAudioReady) {
          this.nightAudio.loop = true;
          this.nightAudio.volume = this.currentMusicVolume(1);
          this.nightAudio.currentTime = 0;
          this.nightAudio.play().catch(() => { /* */ });
        }
        break;
      }
      case "dusk": {
        // Stop looping. The track keeps playing this iteration; the
        // fade volume comes from setDayProgress, and when the audio
        // ends (or its fade hits 0), it just stops. We do NOT pause it
        // here — that would cut the music off the second dusk begins
        // instead of letting it gracefully tail out.
        if (this.dayAudio) {
          this.dayAudio.loop = false;
          // Fresh page load OR un-mute mid-dusk: the track was never
          // started by a prior "day" phase, so it'd be silent for the
          // whole dusk window. Kick it off from the top — the user
          // explicitly wanted music from the get-go even when loading
          // into a transition phase. setDayProgress's next call will
          // clamp the volume to the correct fade ratio.
          if (this.dayAudioReady && this.dayAudio.paused) {
            this.dayAudio.currentTime = 0;
            this.dayAudio.volume = this.currentMusicVolume(1);
            this.dayAudio.play().catch(() => { /* autoplay-policy; will retry on next user gesture */ });
          }
        }
        if (this.nightAudio) try { this.nightAudio.pause(); } catch { /* */ }
        break;
      }
      case "dawn": {
        if (this.nightAudio) {
          this.nightAudio.loop = false;
          // Same "start the track on fresh load during a transition"
          // logic as dusk — see comment above.
          if (this.nightAudioReady && this.nightAudio.paused) {
            this.nightAudio.currentTime = 0;
            this.nightAudio.volume = this.currentMusicVolume(1);
            this.nightAudio.play().catch(() => { /* */ });
          }
        }
        if (this.dayAudio) try { this.dayAudio.pause(); } catch { /* */ }
        break;
      }
    }
  }

  /** Map a progress value (0..1) onto the 4-phase day cycle. */
  private static phaseFor(progress: number): DayPhase {
    if (progress < DAWN_END) return "dawn";
    if (progress < DAY_END)  return "day";
    if (progress < DUSK_END) return "dusk";
    return "night";
  }

  /** Called from the canplaythrough handler when one of the MP3s
   * finishes loading. If music is already running and we're in the
   * matching phase but the file wasn't ready earlier, retry now. */
  private maybeRestartMusic(): void {
    if (!this.musicStarted || this.musicMuted || !this.musicPhase) return;
    this.enterPhase(this.musicPhase);
  }

  // === Internals =======================================================

  private ensure(): AudioContext | null {
    if (this.ctx) {
      // Already created — but browsers can re-suspend an AudioContext
      // (tab background, autoplay policy, etc.). resume() is safe to
      // call when the state is already "running"; it just no-ops.
      // Without this, sounds queued into a suspended context play
      // silently and the user reports "sometimes I hear it, sometimes
      // not".
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => { /* */ });
      return this.ctx;
    }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxMuted ? 0 : this.sfxVolume * SFX_BUS_MAX_GAIN;
      this.sfxBus.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.4;  // music is mixed at its own level
      this.musicBus.connect(this.ctx.destination);
      // New contexts are typically created in suspended state until a
      // user gesture proves consent. ensure() is always called from
      // inside a click / keypress handler (gameplay sounds, admin test
      // buttons), so the resume() call has gesture coverage.
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => { /* */ });
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Force-resume the AudioContext. Exposed so the Engine can prime
   * the SFX pipe on first user gesture (matches the music auto-start
   * hook) — keeps the very first kitchen sizzle from being silent
   * because the context was still suspended when its loop tried to
   * start. */
  resumeContext(): void {
    this.ensure();
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
        // bursts.
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
        peak(0.18);
        // Random crackle pops every 0.6-1.6s for the "something's
        // cooking" feel.
        const ticker = window.setInterval(() => {
          if (Math.random() < 0.6) this.crackle();
        }, 700);
        gain.connect(bus);
        return { nodes, gain, variant: id, ticker };
      }
      case "electric-stove": {
        // Single steady sine + electrical buzz — no beat-frequency
        // amplitude modulation. The previous 440 + 444 Hz pair summed
        // into a 4 Hz pulsing envelope that read as a wobbling
        // "fluctuating" sound on top of the flat tone, per user
        // feedback. One sine is enough for the induction-hum character.
        const tone = ctx.createOscillator(); tone.type = "sine"; tone.frequency.value = 440;
        const toneG = ctx.createGain(); toneG.gain.value = 0.5;
        tone.connect(toneG); toneG.connect(gain); tone.start();
        nodes.push(tone, toneG);
        const buzz = ctx.createOscillator();
        buzz.type = "square"; buzz.frequency.value = 120;
        const buzzG = ctx.createGain(); buzzG.gain.value = 0.12;
        buzz.connect(buzzG); buzzG.connect(gain); buzz.start();
        nodes.push(buzz, buzzG);
        peak(0.18);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "microwave": {
        // Grounded electric whine: magnetron + heavy transformer hum +
        // mains buzz. Previous version had the magnetron at 700 Hz with
        // gain 0.55, which read as too sharp / piercing per user
        // feedback. Dropped the whine to 500 Hz and halved its level,
        // then boosted the 120 Hz transformer hum so the low-mid body
        // dominates the upper whine.
        const whine = ctx.createOscillator(); whine.type = "sine"; whine.frequency.value = 500;
        const whineG = ctx.createGain(); whineG.gain.value = 0.25;
        whine.connect(whineG); whineG.connect(gain); whine.start();
        // Transformer hum at 120 Hz — bumped to 0.55 so it leads.
        const hum = ctx.createOscillator(); hum.type = "sine"; hum.frequency.value = 120;
        const humG = ctx.createGain(); humG.gain.value = 0.55;
        hum.connect(humG); humG.connect(gain); hum.start();
        // 60 Hz mains buzz — bumped slightly for the same low-end
        // weighting.
        const mains = ctx.createOscillator(); mains.type = "square"; mains.frequency.value = 60;
        const mainsG = ctx.createGain(); mainsG.gain.value = 0.15;
        mains.connect(mainsG); mainsG.connect(gain); mains.start();
        nodes.push(whine, whineG, hum, humG, mains, mainsG);
        peak(0.16);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "coffee": {
        // Espresso machine: continuous steam jet + pump motor + a
        // low-mid water-flow band so the machine has more presence
        // than just the upper steam whistle.
        // Steam: bright high-frequency noise.
        const noise = ensureLoopSource(2);
        const hi = ctx.createBiquadFilter();
        hi.type = "bandpass"; hi.frequency.value = 3800; hi.Q.value = 0.6;
        const steamG = ctx.createGain(); steamG.gain.value = 0.75;
        noise.connect(hi); hi.connect(steamG); steamG.connect(gain);
        nodes.push(hi, steamG);
        // Water-flow band — same noise source through a separate
        // mid-band filter for the "brewing" rumble.
        const water = ensureLoopSource(2);
        const waterBp = ctx.createBiquadFilter();
        waterBp.type = "bandpass"; waterBp.frequency.value = 1000; waterBp.Q.value = 0.5;
        const waterG = ctx.createGain(); waterG.gain.value = 0.45;
        water.connect(waterBp); waterBp.connect(waterG); waterG.connect(gain);
        nodes.push(waterBp, waterG);
        // Pump motor: 220 Hz sine (was square — too buzzy) for a
        // smoother pumping note.
        const pump = ctx.createOscillator(); pump.type = "sine"; pump.frequency.value = 220;
        const pumpG = ctx.createGain(); pumpG.gain.value = 0.22;
        pump.connect(pumpG); pumpG.connect(gain); pump.start();
        nodes.push(pump, pumpG);
        peak(0.18);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "blender": {
        // Full redesign. Previous version (sawtooth 280 Hz + harmonic
        // 840 Hz + bandpass noise + 6 Hz frequency LFO) was rated
        // "sucks" — the LFO wobble in particular sounded more like a
        // sci-fi alarm than a kitchen appliance. New chain mimics a
        // real blender: high-pitched motor whine + broadband chopping
        // noise + low body rumble, all steady (no modulation).
        // Main motor: 600 Hz sawtooth through a lowpass — gives the
        // characteristic mid-pitched whirring without harshness.
        const motor = ctx.createOscillator(); motor.type = "sawtooth"; motor.frequency.value = 600;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000;
        const motorG = ctx.createGain(); motorG.gain.value = 0.45;
        motor.connect(lp); lp.connect(motorG); motorG.connect(gain);
        motor.start();
        nodes.push(motor, lp, motorG);
        // Upper whine harmonic — 1500 Hz square for the "this thing
        // is spinning fast" presence.
        const whine = ctx.createOscillator(); whine.type = "sawtooth"; whine.frequency.value = 1500;
        const whineG = ctx.createGain(); whineG.gain.value = 0.18;
        whine.connect(whineG); whineG.connect(gain); whine.start();
        nodes.push(whine, whineG);
        // Body rumble — 100 Hz sine so the blender feels physically
        // heavy on the counter.
        const rumble = ctx.createOscillator(); rumble.type = "sine"; rumble.frequency.value = 100;
        const rumbleG = ctx.createGain(); rumbleG.gain.value = 0.35;
        rumble.connect(rumbleG); rumbleG.connect(gain); rumble.start();
        nodes.push(rumble, rumbleG);
        // Chopping noise — wider mid-band so it reads as blade-on-ice
        // rather than a narrow tonal whistle.
        const noise = ensureLoopSource(2);
        const noiseBp = ctx.createBiquadFilter(); noiseBp.type = "bandpass"; noiseBp.frequency.value = 1200; noiseBp.Q.value = 0.3;
        const noiseG = ctx.createGain(); noiseG.gain.value = 0.55;
        noise.connect(noiseBp); noiseBp.connect(noiseG); noiseG.connect(gain);
        nodes.push(noiseBp, noiseG);
        peak(0.20);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "toaster": {
        // Heating-coil hiss + electrical hum + occasional crackle as
        // the bread browns. Added a second noise band around 800 Hz
        // (mid-range coil-radiation character) on top of the 5 kHz
        // upper hiss so it has a fuller spectrum instead of sounding
        // like just hum + air noise.
        const hum = ctx.createOscillator(); hum.type = "sine"; hum.frequency.value = 60;
        const humG = ctx.createGain(); humG.gain.value = 0.45;
        hum.connect(humG); humG.connect(gain); hum.start();
        const harm = ctx.createOscillator(); harm.type = "sine"; harm.frequency.value = 240;
        const harmG = ctx.createGain(); harmG.gain.value = 0.30;
        harm.connect(harmG); harmG.connect(gain); harm.start();
        nodes.push(hum, harm, humG, harmG);
        // Mid-range coil-radiation noise.
        const midNoise = ensureLoopSource(2);
        const midBp = ctx.createBiquadFilter(); midBp.type = "bandpass"; midBp.frequency.value = 800; midBp.Q.value = 0.8;
        const midG = ctx.createGain(); midG.gain.value = 0.35;
        midNoise.connect(midBp); midBp.connect(midG); midG.connect(gain);
        nodes.push(midBp, midG);
        // Upper coil-hiss layer — high-band noise around 5 kHz.
        const noise = ensureLoopSource(2);
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 5000; bp.Q.value = 1.2;
        const noiseG = ctx.createGain(); noiseG.gain.value = 0.5;
        noise.connect(bp); bp.connect(noiseG); noiseG.connect(gain);
        nodes.push(bp, noiseG);
        peak(0.18);
        // Occasional pop / crackle while the bread browns.
        const ticker = window.setInterval(() => {
          if (Math.random() < 0.25) this.crackle();
        }, 900);
        gain.connect(bus);
        return { nodes, gain, variant: id, ticker };
      }
      case "hood": {
        // Big extractor fan: rushing-air noise bed + a low-mid hum
        // from the motor. Boosted significantly — the original peak
        // 0.04 read as silence on laptop speakers.
        const noise = ensureLoopSource(2);
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 800; bp.Q.value = 0.5;
        const noiseG = ctx.createGain(); noiseG.gain.value = 0.8;
        noise.connect(bp); bp.connect(noiseG); noiseG.connect(gain);
        nodes.push(bp, noiseG);
        // Motor hum at 150 Hz.
        const motor = ctx.createOscillator(); motor.type = "sine"; motor.frequency.value = 150;
        const motorG = ctx.createGain(); motorG.gain.value = 0.12;
        motor.connect(motorG); motorG.connect(gain); motor.start();
        nodes.push(motor, motorG);
        peak(0.13);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "sink": {
        // Running water: layered noise (mid + high bands). NO sine-
        // tone drip ticker — the random tones read as a leaky faucet
        // dripping into a different basin, which is what the user
        // wanted gone.
        const noise = ensureLoopSource(2);
        const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 700;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 5500;
        const bodyG = ctx.createGain(); bodyG.gain.value = 0.9;
        noise.connect(hp); hp.connect(lp); lp.connect(bodyG); bodyG.connect(gain);
        nodes.push(hp, lp, bodyG);
        // Splash layer — narrower bandpass around 2 kHz gives the
        // water-hitting-basin character distinct from the body.
        const splash = ensureLoopSource(2);
        const splashBp = ctx.createBiquadFilter(); splashBp.type = "bandpass"; splashBp.frequency.value = 2000; splashBp.Q.value = 0.6;
        const splashG = ctx.createGain(); splashG.gain.value = 0.5;
        splash.connect(splashBp); splashBp.connect(splashG); splashG.connect(gain);
        nodes.push(splashBp, splashG);
        peak(0.14);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "bathtub": {
        // Slower, gentler water than the sink. NO sine-tone bubble
        // ticker — same reasoning as sink, the random pops read as
        // drips rather than tub-filling water.
        const noise = ensureLoopSource(2);
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = 0.5;
        const bodyG = ctx.createGain(); bodyG.gain.value = 0.95;
        noise.connect(bp); bp.connect(bodyG); bodyG.connect(gain);
        nodes.push(bp, bodyG);
        peak(0.16);
        gain.connect(bus);
        return { nodes, gain, variant: id };
      }
      case "dishwasher": {
        // Continuous wash. Motor + water + slow LFO surge for the
        // "spray arm turning" feel. Bumped to peak 0.18 — was still
        // too quiet at 0.12 to hear over a typical laptop fan.
        const motor = ctx.createOscillator(); motor.type = "sine"; motor.frequency.value = 160;
        const motorG = ctx.createGain(); motorG.gain.value = 0.45;
        motor.connect(motorG); motorG.connect(gain); motor.start();
        const harm = ctx.createOscillator(); harm.type = "sine"; harm.frequency.value = 320;
        const harmG = ctx.createGain(); harmG.gain.value = 0.25;
        harm.connect(harmG); harmG.connect(gain); harm.start();
        nodes.push(motor, motorG, harm, harmG);
        // Water: louder noise body across a wider band.
        const water = ensureLoopSource(2);
        const wbp = ctx.createBiquadFilter(); wbp.type = "bandpass"; wbp.frequency.value = 1500; wbp.Q.value = 0.5;
        const waterG = ctx.createGain(); waterG.gain.value = 0.85;
        water.connect(wbp); wbp.connect(waterG); waterG.connect(gain);
        nodes.push(wbp, waterG);
        peak(0.18);
        // Rhythmic surge — LFO on the motor gain for the "spray arm
        // turning" feel.
        const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 0.4;
        const lfoG = ctx.createGain(); lfoG.gain.value = 0.15;
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
