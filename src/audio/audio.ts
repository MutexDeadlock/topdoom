import type { SoundBank } from '../wad/sound.ts';
import type { Pos2 } from '../types.ts';
import { randomPlaybackRate, SFX, SFX_NAMES, type SfxId, type SoundEmitter } from './sfx.ts';

/**
 * Sounds that may play at once. **Tuned by feel**, not vanilla: `snd_channels`
 * defaults to 8 there, sized for a first-person view that can only ever see one
 * room of a fight. This camera looks down on the whole room and a corridor's
 * worth of the next one, so 8 channels have monsters cutting each other off
 * inside the frame they're visible in. The eviction rule they're allocated by
 * is still vanilla's own (`allocate`).
 */
const CHANNELS = 16;

/**
 * Vanilla's `S_CLIPPING_DIST`/`S_CLOSE_DIST`/`S_ATTENUATOR` (`s_sound.c`), in
 * map units: full volume within 160, falling off linearly to silence at 1200,
 * beyond which the sound isn't started at all. Distance is a true `hypot` here
 * rather than vanilla's octagonal `adx + ady - min/2` approximation, which
 * exists only to avoid a fixed-point square root.
 */
const CLIPPING_DIST = 1200;
const CLOSE_DIST = 160;
const ATTENUATOR = CLIPPING_DIST - CLOSE_DIST;

/**
 * Vanilla's `S_STEREO_SWING` as a fraction of full pan: 96 of the 128 units
 * either side of `NORM_SEP`, so a sound directly beside the listener still
 * carries a quarter of its volume in the far ear rather than hard-panning.
 */
const STEREO_SWING = 96 / 128;

/** Default sfx volume — vanilla's own starting `snd_SfxVolume` of 8 out of 15. */
const DEFAULT_VOLUME = 8 / 15;

const VOLUME_STORAGE_KEY = 'topdoom.sfxVolume';

interface Voice {
  /** `SoundEmitter.play`'s origin key, or undefined for a positional sound with no origin. */
  origin: number | undefined;
  /** This sfx's `SFX` priority, which is what `allocate` evicts by. */
  priority: number;
  source: AudioBufferSourceNode;
  /** Disconnects this voice's whole chain. Called once, by whichever comes first: the sound ending or being evicted. */
  release: () => void;
}

/**
 * Plays the WAD's own sound lumps through Web Audio, reproducing vanilla's
 * mixer model rather than a 3D audio scene: per-sound distance attenuation and
 * stereo pan computed exactly as `S_AdjustSoundParams` computes them, a fixed
 * pool of channels allocated by `S_getChannel`'s priority rule, and vanilla's
 * random pitch wobble per instance. See docs/audio.md.
 *
 * Session-level, like `Viewport`: one `AudioContext` outlives every level and
 * every WAD set (`setBank` swaps the lumps). The context is created lazily on
 * the first `resume`, since a browser only lets one start from a user gesture
 * — which is exactly what starting a level is.
 */
export class AudioEngine implements SoundEmitter {
  private ctx: AudioContext | null = null;
  /** Set if constructing the `AudioContext` threw; nothing retries after that. */
  private failed = false;
  private master: GainNode | null = null;
  /**
   * Where sfx voices connect. Separate from `master` so music can later join
   * it as a sibling bus with its own volume, rather than needing this graph
   * rearranged — see docs/audio.md § Room for music.
   */
  private sfxBus: GainNode | null = null;

  private bank: SoundBank | null = null;
  private buffers = new Map<SfxId, AudioBuffer | null>();
  /** Names whose async `decodeAudioData` is in flight, so a second play doesn't start a second decode. */
  private decoding = new Set<SfxId>();

  private voices: (Voice | null)[] = new Array(CHANNELS).fill(null);

  private listenerX = 0;
  private listenerY = 0;
  /** Listener facing as its own cosine/sine, so `play` needs no trig of its own. */
  private forwardCos = 0;
  private forwardSin = 1;

  private _volume: number;
  private _muted = false;

  constructor() {
    // `getItem` returns null when unset, and `Number(null)` is 0 — which would
    // read as a stored volume of "silent" rather than as "no preference yet".
    const stored = globalThis.localStorage?.getItem(VOLUME_STORAGE_KEY);
    const parsed = stored === null || stored === undefined ? NaN : Number(stored);
    this._volume = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_VOLUME;
  }

  get volume(): number {
    return this._volume;
  }

  /** 0-1; persisted, so it survives a reload. */
  setVolume(value: number): void {
    this._volume = Math.max(0, Math.min(1, value));
    this._muted = false;
    globalThis.localStorage?.setItem(VOLUME_STORAGE_KEY, String(this._volume));
    this.applyVolume();
  }

  get muted(): boolean {
    return this._muted;
  }

  /** Returns the new state, so the caller can report it. */
  toggleMute(): boolean {
    this._muted = !this._muted;
    if (this._muted) this.stopAll();
    this.applyVolume();
    return this._muted;
  }

  private applyVolume(): void {
    if (this.master) this.master.gain.value = this._muted ? 0 : this._volume;
  }

  /**
   * Which WAD set's lumps to play. Called per level load, and cheap: only the
   * decoded-buffer cache is dropped, and the (asynchronous) decode of any
   * browser-container lumps the set carries is kicked off here so a
   * sound-replacement PWAD's first shot isn't silent.
   */
  setBank(bank: SoundBank | null): void {
    this.stopAll();
    this.bank = bank;
    this.buffers.clear();
    this.decoding.clear();
    if (bank && this.ctx) for (const name of bank.encodedNames(SFX_NAMES)) this.decodeEncoded(name);
  }

  /**
   * The point sounds are heard from and the DOOM-space bearing "up the screen"
   * — the player's position, but the **camera's** orientation, not the
   * player's own facing vanilla uses. Aim is mouse-driven here and swings
   * freely while the view doesn't, so panning off the player's facing would
   * have a fight's sounds swap ears while nothing on screen moved.
   */
  setListener(pos: Pos2, forwardDeg: number): void {
    this.listenerX = pos.x;
    this.listenerY = pos.y;
    const rad = (forwardDeg * Math.PI) / 180;
    this.forwardCos = Math.cos(rad);
    this.forwardSin = Math.sin(rad);
  }

  /** Starts the context (first call) or wakes it after `suspend`. Must be reached from a user gesture. */
  resume(): void {
    const ctx = this.ensureContext();
    if (ctx && ctx.state !== 'running') void ctx.resume();
  }

  suspend(): void {
    this.stopAll();
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  stopAll(): void {
    for (let i = 0; i < this.voices.length; i++) this.stopVoice(i);
  }

  play(id: SfxId, at?: Pos2 | null, origin?: number): void {
    if (this._muted || this._volume === 0) return;
    const ctx = this.ctx;
    // Not started yet, or paused: dropping the sound is right either way —
    // a suspended context would otherwise queue it up and fire the whole
    // backlog at once on resume.
    if (!ctx || ctx.state !== 'running' || !this.sfxBus) return;

    let gain = 1;
    let pan = 0;
    if (at) {
      const dx = at.x - this.listenerX;
      const dy = at.y - this.listenerY;
      const dist = Math.hypot(dx, dy);
      if (dist > CLIPPING_DIST) return;
      gain = dist < CLOSE_DIST ? 1 : (CLIPPING_DIST - dist) / ATTENUATOR;
      // `S_AdjustSoundParams`'s own stereo separation, as a -1..1 pan: the
      // sine of the source's bearing relative to where the listener faces.
      // Vanilla centres a sound sitting exactly on the listener; here `dist`
      // being 0 does that on its own.
      if (dist > 0) pan = (-STEREO_SWING * (dy * this.forwardCos - dx * this.forwardSin)) / dist;
    }

    const buffer = this.bufferFor(id);
    if (!buffer) return;
    const channel = this.allocate(origin, SFX[id]);
    if (channel < 0) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = randomPlaybackRate(id);
    const gainNode = ctx.createGain();
    gainNode.gain.value = gain;
    const chain: AudioNode[] = [source, gainNode];
    if (pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      chain.push(panner);
      source.connect(gainNode).connect(panner).connect(this.sfxBus);
    } else {
      source.connect(gainNode).connect(this.sfxBus);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const node of chain) node.disconnect();
    };
    this.voices[channel] = { origin, priority: SFX[id], source, release };
    source.onended = () => {
      // Only clear the slot if this voice still owns it: eviction hands the
      // channel to someone else before this fires.
      if (this.voices[channel]?.source === source) this.voices[channel] = null;
      release();
    };
    source.start();
  }

  /**
   * Vanilla's `S_StartSound`'s channel choice, in its own order: stop whatever
   * this origin was already playing (`S_StopSound(origin)`), take a free
   * channel, and otherwise evict the **first** channel whose priority is no
   * higher than this sound's (`S_getChannel`) — with no channel left to take,
   * the sound is simply dropped. That "first, not quietest or oldest" rule is
   * vanilla's, and is what keeps a crowd of same-priority sight sounds fighting
   * over one channel instead of flushing the whole pool.
   */
  private allocate(origin: number | undefined, priority: number): number {
    if (origin !== undefined) {
      for (let i = 0; i < this.voices.length; i++) {
        if (this.voices[i]?.origin === origin) this.stopVoice(i);
      }
    }
    for (let i = 0; i < this.voices.length; i++) {
      if (!this.voices[i]) return i;
    }
    for (let i = 0; i < this.voices.length; i++) {
      if ((this.voices[i]?.priority ?? 0) >= priority) {
        this.stopVoice(i);
        return i;
      }
    }
    return -1;
  }

  private stopVoice(channel: number): void {
    const voice = this.voices[channel];
    if (!voice) return;
    this.voices[channel] = null;
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      // Already ended between its own `onended` and here; nothing to stop.
    }
    voice.release();
  }

  /**
   * The decoded buffer for `id`, or null while there isn't one — a lump the WAD
   * set doesn't carry (stays null forever, see `SoundBank`) or a
   * browser-container lump still decoding. `decodeAudioData` is asynchronous
   * and there is nothing useful to do about that: the sound is dropped this
   * once and plays from the cache from then on.
   */
  private bufferFor(id: SfxId): AudioBuffer | null {
    const cached = this.buffers.get(id);
    if (cached !== undefined) return cached;
    const ctx = this.ctx;
    const lump = this.bank?.get(id);
    if (!ctx || !lump) {
      this.buffers.set(id, null);
      return null;
    }
    if (lump.kind === 'encoded') {
      this.decodeEncoded(id);
      return null;
    }
    const buffer = ctx.createBuffer(1, lump.samples.length, lump.sampleRate);
    // `getChannelData(…).set` rather than `copyToChannel`: same copy, and it
    // doesn't care which kind of ArrayBuffer backs the decoded samples.
    buffer.getChannelData(0).set(lump.samples);
    this.buffers.set(id, buffer);
    return buffer;
  }

  private decodeEncoded(id: SfxId): void {
    const ctx = this.ctx;
    const lump = this.bank?.get(id);
    if (!ctx || !lump || lump.kind !== 'encoded' || this.decoding.has(id) || this.buffers.has(id)) return;
    this.decoding.add(id);
    // `decodeAudioData` detaches the buffer it's given, and the lump's bytes
    // are a view into the whole WAD file — so it gets a copy, not that view.
    void ctx
      .decodeAudioData(lump.bytes.slice().buffer)
      .then((buffer) => this.buffers.set(id, buffer))
      .catch((err: unknown) => {
        console.warn(`DS${id.toUpperCase()}: unsupported sound format`, err);
        this.buffers.set(id, null);
      })
      .finally(() => this.decoding.delete(id));
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx || this.failed) return this.ctx;
    try {
      this.ctx = new AudioContext();
    } catch (err) {
      // No Web Audio (or the browser refused one): the game stays playable and
      // silent, which is why every emitter call is fire-and-forget.
      console.warn('audio unavailable', err);
      this.failed = true;
      return null;
    }
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
    this.applyVolume();
    // The bank was set before the context existed (a level loaded, then the
    // first resume created this) — start its container-format decodes now.
    if (this.bank) for (const name of this.bank.encodedNames(SFX_NAMES)) this.decodeEncoded(name);
    return this.ctx;
  }
}
