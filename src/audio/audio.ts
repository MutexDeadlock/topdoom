/**
 * WebAudio playback: the channel pool and vanilla's cutoff/priority model, distance attenuation,
 * pan, and volume/mute. See docs/audio.md § The mixer model.
 */
import { SHIPPED_SECRET, shippedLump } from '../wad/shipped.ts';
import type { SoundBank } from '../wad/sound.ts';
import type { Pos2 } from '../types.ts';
import {
  randomPlaybackRate,
  sampleGroup,
  SFX,
  SFX_NAMES,
  soundLumpName,
  type SfxId,
  type SoundEmitter,
} from './sfx.ts';
import { DOOM_TIC } from '../constants.ts';
import { MusicPlayer } from './music.ts';
import { storedVolume } from './volume.ts';
import { vecLength } from '../util/geom.ts';
import { writeStorageSoon } from '../util/storage.ts';

/**
 * Sounds that may play at once. **Tuned by feel**, not vanilla: `snd_channels` defaults to 8, sized
 * for a first-person view, and this camera shows a whole room and part of the next. The eviction
 * rule they are allocated by is still vanilla's own (`allocate`). docs/audio.md § The mixer model.
 */
const CHANNELS = 32;

/**
 * Copies of one sample that may *start* inside one tic. **Tuned by feel**, and not vanilla, which
 * limits nothing per sound: a whole region's monsters wake on a single frame, and a dozen copies of
 * a 1.2-second cry then own a third of `CHANNELS` for the length of it. Counting *starts per tic*
 * rather than voices in flight is what leaves a sound that layers across tics by design alone —
 * `plasma`, which carries no origin, stacks about six deep and never reaches this.
 * docs/audio.md § Same-tic bursts.
 */
const MAX_STARTS_PER_TIC = 6;

/**
 * How long "one tic" lasts for that budget — vanilla's own tic (`constants.ts`). The frame loop
 * runs at display rate, not 35 Hz, so a wake vanilla would put in a single tic can straddle two
 * frames; one `DOOM_TIC` covers both.
 */
const BURST_WINDOW = DOOM_TIC;

/**
 * Seconds between the copies a burst does admit. **Tuned by feel**, and not vanilla: identical
 * samples started at one instant comb-filter into a single loud copy rather than a crowd, and the
 * pitch wobble alone doesn't decorrelate them. docs/audio.md § Same-tic bursts.
 */
const BURST_STAGGER = 0.018;

/**
 * How close in pan two copies of a sample must sit to crowd each other, softening `burstVictim`'s
 * crowding sum — and, at a distance of zero, what keeps that sum finite so loudness still separates
 * copies sharing one pan. **Tuned by feel**. docs/audio.md § Same-tic bursts.
 */
const CROWD_FALLOFF = 0.15;

/**
 * Vanilla's `S_CLIPPING_DIST`/`S_CLOSE_DIST`/`S_ATTENUATOR` (`s_sound.c`), in map units — full
 * volume within 160, linear to silence at 1200, past which the sound isn't started at all.
 * Distance is a true `hypot` rather than vanilla's octagonal approximation.
 * docs/audio.md § The mixer model.
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

/**
 * Default sfx volume. **Tuned by feel**, and above vanilla's own starting `snd_SfxVolume` of
 * 8 of 15: this mixer has no analogue stage behind it, so vanilla's number lands quieter here
 * than it did on a Sound Blaster.
 */
const DEFAULT_VOLUME = 0.8;

/**
 * Default master volume: **unity**, not a tuned number. What the mix should sound like is the
 * business of the two channel defaults above and in `music.ts`; this slider exists to pull all of
 * it down at once, so it starts by doing nothing at all.
 */
const DEFAULT_MASTER_VOLUME = 1;

const VOLUME_STORAGE_KEY = 'sfxVolume';
const MASTER_VOLUME_STORAGE_KEY = 'masterVolume';

/**
 * Sounds this engine ships itself, as lumps of its own WAD (`wad/shipped.ts`) → the priority they
 * take in the same channel pool `SFX` priorities are read on. Not lumps of the *loaded set*: a
 * secret's chime has no vanilla original at all (docs/audio.md § Player and
 * pickups), so it cannot be an `SfxId` without a made-up name in what is
 * otherwise `sounds.c` verbatim. Decoded once, when the context
 * comes up — long before a level's first secret, so the first one isn't the
 * one that plays silently.
 */
const ASSETS = {
  /**
   * Entering a secret sector. Priority is `getpow`'s 60: an announcement, cut off by almost
   * nothing.
   */
  secret: { lump: SHIPPED_SECRET, priority: 60 },
} as const;

export type AssetSfxId = keyof typeof ASSETS;

/** What one channel is started with — see `AudioEngine.start`. */
interface VoiceSpec {
  /** `sampleGroup`'s key, which is what the same-tic start budget is spent from. */
  key: string;
  /** `SFX`'s own priority, which is what a full pool evicts by. */
  priority: number;
  /** Playback rate, vanilla's per-shot pitch wobble. */
  rate: number;
  gain: number;
  /** -1..1; 0 skips the panner node entirely. */
  pan: number;
  /** The emitter this belongs to, so a second sound from it takes the same channel. */
  origin: number | undefined;
}

interface Voice {
  /** `SoundEmitter.play`'s origin key, or undefined for a positional sound with no origin. */
  origin: number | undefined;
  /** This sfx's `SFX` priority, which is what `allocate` evicts by. */
  priority: number;
  /** `VoiceSpec.key`, and the gain and pan `burstVictim` rates this copy by. */
  key: string;
  gain: number;
  pan: number;
  /** When `play` raised this, in context time — *before* its stagger. `admitBurst`'s window. */
  raisedAt: number;
  /** This copy's place in its burst's stagger, inherited by whatever displaces it. */
  burstIndex: number;
  source: AudioBufferSourceNode;
  /**
   * Disconnects this voice's whole chain. Called once, by whichever comes first: the sound ending
   * or being evicted.
   */
  release: () => void;
}

/**
 * Which member of a same-tic burst is worth least, as an index into `members`: the highest
 * `crowding / gain`, where crowding sums `1 / (panDistance + CROWD_FALLOFF)` over every other
 * member. The sum, rather than the distance to the nearest neighbour alone, is what keeps a burst
 * spread: nearest-neighbour saturates once each side of the field holds two copies, and can no
 * longer tell a stack of three from a lone source. Gain divides it, so a crowd all in one
 * direction — where crowding is uniform — admits its nearest instead.
 *
 * Ties go to the **later** index, and `admitBurst` passes the newcomer last, so an over-budget
 * burst of copies that rate exactly alike turns nobody away for nothing.
 * docs/audio.md § Same-tic bursts.
 */
export function burstVictim(members: readonly { pan: number; gain: number }[]): number {
  let worst = 0;
  let worstScore = -Infinity;
  for (let i = 0; i < members.length; i++) {
    let crowding = 0;
    for (let j = 0; j < members.length; j++) {
      if (j !== i) crowding += 1 / (Math.abs(members[i].pan - members[j].pan) + CROWD_FALLOFF);
    }
    // `gain` is the distance attenuation, which `play` has already checked is above zero.
    const score = crowding / members[i].gain;
    if (score >= worstScore) {
      worstScore = score;
      worst = i;
    }
  }
  return worst;
}

/**
 * Plays the WAD's own sound lumps through Web Audio, reproducing vanilla's mixer model rather than
 * a 3D audio scene — docs/audio.md § The mixer model. Session-level, like `Viewport`: one
 * `AudioContext` outlives every level and every WAD set (`setBank` swaps the lumps), created lazily
 * on the first `resume` since a browser only lets one start from a user gesture.
 */
export class AudioEngine implements SoundEmitter {
  private ctx: AudioContext | null = null;
  /** Set if constructing the `AudioContext` threw; nothing retries after that. */
  private failed = false;
  private master: GainNode | null = null;
  /**
   * Where sfx voices connect. A sibling of the music player's own bus under
   * `master`, so the two volumes are independent — docs/music.md § Volume.
   */
  private sfxBus: GainNode | null = null;

  /**
   * The level's music, on its own bus. Owned here because it needs this
   * class's `AudioContext` and nothing else does; it stays silent until
   * `attach` hands it one. See docs/music.md.
   */
  readonly music = new MusicPlayer();

  private bank: SoundBank | null = null;
  private buffers = new Map<SfxId, AudioBuffer | null>();
  /**
   * Names whose async `decodeAudioData` is in flight, so a second play doesn't start a second
   * decode.
   */
  private decoding = new Set<SfxId>();
  /**
   * `ASSETS`' decoded buffers, null while one is still loading or failed to. Populated once per
   * context.
   */
  private assetBuffers = new Map<AssetSfxId, AudioBuffer | null>();

  private voices: (Voice | null)[] = new Array(CHANNELS).fill(null);
  /** Set while a replay's seek runs its tics — see `setSilent`. */
  private silent = false;
  /** Copies the same-tic budget has turned away since the level loaded — DEVMODE's status text. */
  private burstDropped = 0;

  private listenerX = 0;
  private listenerY = 0;
  /** Listener facing as its own cosine/sine, so `play` needs no trig of its own. */
  private forwardCos = 0;
  private forwardSin = 1;

  private _volume: number;
  private _masterVolume: number;

  constructor() {
    this._volume = storedVolume(VOLUME_STORAGE_KEY, DEFAULT_VOLUME);
    this._masterVolume = storedVolume(MASTER_VOLUME_STORAGE_KEY, DEFAULT_MASTER_VOLUME);
    // The music runs its own start/stop off the master too, and owns no copy of the stored value.
    this.music.setMasterVolume(this._masterVolume);
  }

  get volume(): number {
    return this._volume;
  }

  get masterVolume(): number {
    return this._masterVolume;
  }

  /** Voices in flight, the pool they came from, and `burstDropped` — DEVMODE's status text. */
  get channelUsage(): { playing: number; total: number; dropped: number } {
    let playing = 0;
    for (const voice of this.voices) {
      if (voice) playing++;
    }
    return { playing, total: this.voices.length, dropped: this.burstDropped };
  }

  /**
   * 0-1; persisted, so it survives a reload. There is no separate mute: 0 *is*
   * the mute, so it does everything mute did — `play` short-circuits on it
   * rather than starting inaudible sources, and reaching it cuts the voices
   * already in flight instead of letting a long sound run out silently and
   * resume mid-way if the slider comes back up.
   */
  setVolume(value: number): void {
    this._volume = Math.max(0, Math.min(1, value));
    writeStorageSoon(VOLUME_STORAGE_KEY, this._volume);
    if (this._volume === 0) this.stopAll();
    this.applyVolume();
  }

  /**
   * 0-1; persisted, and the one slider that rides *everything* — it is `master`'s own gain, with
   * the sfx and music buses hanging off it. 0 is the mute here too, and has to reach both buses to
   * be one: the voices in flight are cut, and the music player is told so it stops rendering a chip
   * nobody can hear rather than merely being turned down to nothing.
   */
  setMasterVolume(value: number): void {
    this._masterVolume = Math.max(0, Math.min(1, value));
    writeStorageSoon(MASTER_VOLUME_STORAGE_KEY, this._masterVolume);
    if (this._masterVolume === 0) this.stopAll();
    this.music.setMasterVolume(this._masterVolume);
    this.applyVolume();
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
    this.burstDropped = 0;
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

  /**
   * Starts the context, or wakes one the browser suspended on its own. Must be reached from a user
   * gesture.
   */
  resume(): void {
    const ctx = this.ensureContext();
    if (ctx && ctx.state !== 'running') void ctx.resume();
  }

  /**
   * Pausing. The sfx voices are cut, but the context is deliberately left
   * running: music sits on its own bus and plays on behind the menu the way
   * vanilla's does, and suspending the context would freeze it mid-bar. Nothing
   * raises a sound while paused — the frame loop is stopped — so there is
   * nothing else to silence. docs/music.md § Volume.
   */
  suspend(): void {
    this.stopAll();
  }

  stopAll(): void {
    for (let i = 0; i < this.voices.length; i++) this.stopVoice(i);
  }

  /**
   * Drops every sound raised while set, and stops what is ringing. For simulation that runs
   * without being watched — a replay catching up to a seek plays out minutes of fighting in a
   * fraction of a second, and every shot of it would arrive at once.
   * docs/replays.md § Seeking.
   */
  setSilent(on: boolean): void {
    this.silent = on;
    if (on) this.stopAll();
  }

  play(id: SfxId, at?: Pos2 | null, origin?: number): void {
    if (this.silent || this.sfxAudible === 0) return;
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
      const dist = vecLength(dx, dy);
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
    const rate = randomPlaybackRate(id);
    this.start(buffer, { key: sampleGroup(id), priority: SFX[id], rate, gain, pan, origin });
  }

  /**
   * One of the engine's own sounds (`ASSETS`) rather than a WAD lump, played
   * unattenuated and centred like a pickup: these announce something to the
   * player instead of happening somewhere in the world. Silent while the file
   * is still loading or failed to decode, the same way a missing lump is.
   */
  playAsset(id: AssetSfxId): void {
    if (this.silent || this.sfxAudible === 0) return;
    const buffer = this.assetBuffers.get(id);
    if (!buffer) return;
    const { priority } = ASSETS[id];
    // Prefixed: `ASSETS`' names and `sampleGroup`'s are separate spaces that share this one key.
    const key = `asset:${id}`;
    this.start(buffer, { key, priority, rate: 1, gain: 1, pan: 0, origin: undefined });
  }

  /**
   * What an sfx actually comes out at: the two sliders multiplied, and the thing 0 is tested on.
   */
  private get sfxAudible(): number {
    return this._volume * this._masterVolume;
  }

  /**
   * The sfx slider goes on the sfx bus, not on `master`: music hangs off `master` too, and putting
   * it there would have the sfx slider quietly ride the music as well. The master slider is the
   * one that *is* `master`.
   */
  private applyVolume(): void {
    if (this.sfxBus) this.sfxBus.gain.value = this._volume;
    if (this.master) this.master.gain.value = this._masterVolume;
  }

  /**
   * Takes a channel for `buffer` and starts it — the half of `play` that has nothing left to
   * decide. Two culls stand in front of the sound: the same-tic start budget (`admitBurst`) and
   * then the pool itself (`allocate`), either of which may drop it.
   */
  private start(buffer: AudioBuffer, voice: VoiceSpec): void {
    const { key, priority, rate, gain, pan, origin } = voice;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.sfxBus) return;
    const now = ctx.currentTime;
    const burstIndex = this.admitBurst(voice, now);
    if (burstIndex === null) return;
    const channel = this.allocate(origin, priority);
    if (channel < 0) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
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
    this.voices[channel] = { origin, priority, key, gain, pan, burstIndex, raisedAt: now, source, release };
    source.onended = () => {
      // Only clear the slot if this voice still owns it: eviction hands the
      // channel to someone else before this fires.
      if (this.voices[channel]?.source === source) this.voices[channel] = null;
      release();
    };
    source.start(now + burstIndex * BURST_STAGGER);
  }

  /**
   * The same-tic start budget, run in front of `allocate`: this copy's place in its burst's
   * stagger, or null to drop it. Under budget a copy queues behind the burst's existing members;
   * at budget it gets in only by displacing whichever member `burstVictim` rates lowest, and
   * inherits that member's place — so the burst keeps its even spacing however often it turns
   * over. A displaced copy whose staggered start hasn't come round yet never sounds at all.
   * docs/audio.md § Same-tic bursts.
   */
  private admitBurst(voice: VoiceSpec, now: number): number | null {
    const { key, gain, pan, origin } = voice;
    const peers: { channel: number; gain: number; pan: number; burstIndex: number }[] = [];
    for (let i = 0; i < this.voices.length; i++) {
      const peer = this.voices[i];
      if (!peer || peer.key !== key || now - peer.raisedAt >= BURST_WINDOW) continue;
      // `allocate` is about to cut this one for sharing our origin, so it is not competition.
      if (origin !== undefined && peer.origin === origin) continue;
      peers.push({ channel: i, gain: peer.gain, pan: peer.pan, burstIndex: peer.burstIndex });
    }
    if (peers.length < MAX_STARTS_PER_TIC) return peers.length;
    const victim = burstVictim([...peers, { gain, pan }]);
    if (victim === peers.length) {
      this.burstDropped++;
      return null;
    }
    this.stopVoice(peers[victim].channel);
    return peers[victim].burstIndex;
  }

  /**
   * Vanilla's `S_StartSound` channel choice, in its own order: stop whatever this origin was
   * already playing, take a free channel, else evict the **first** channel whose priority is no
   * higher than this sound's (`S_getChannel`), else drop the sound.
   * docs/audio.md § The mixer model.
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
        console.warn(`${soundLumpName(id)}: unsupported sound format`, err);
        this.buffers.set(id, null);
      })
      .finally(() => this.decoding.delete(id));
  }

  /**
   * Decodes `ASSETS` out of the shipped WAD once the context exists. Failure is
   * logged and cached as null, like an undecodable lump: the sound is simply
   * never heard.
   */
  private loadAssets(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const id of Object.keys(ASSETS) as AssetSfxId[]) {
      if (this.assetBuffers.has(id)) continue;
      this.assetBuffers.set(id, null);
      const name = ASSETS[id].lump;
      void shippedLump(name)
        .then((lump) => (lump ? ctx.decodeAudioData(lump) : Promise.reject(new Error('lump missing'))))
        .then((buffer) => this.assetBuffers.set(id, buffer))
        .catch((err: unknown) => console.warn(`${name}: could not be loaded`, err));
    }
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
    this.music.attach(this.ctx, this.master);
    this.applyVolume();
    // The bank was set before the context existed (a level loaded, then the
    // first resume created this) — start its container-format decodes now.
    if (this.bank) for (const name of this.bank.encodedNames(SFX_NAMES)) this.decodeEncoded(name);
    this.loadAssets();
    return this.ctx;
  }
}
