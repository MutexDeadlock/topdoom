/**
 * Plays the level's `D_*` track: an OPL rendering of a MUS or MIDI score, or a container format
 * handed straight to the browser. The one entry point into `audio/music/`. See docs/music.md.
 */
import type { MusicBank } from '../wad/music.ts';
import { storedVolume } from './volume.ts';
import { decodeMidi } from './music/midi.ts';
import { decodeMus } from './music/mus.ts';
import { OplChip } from './music/opl.ts';
import { OplSynth } from './music/synth.ts';
import { finaleMusicFor, intermissionMusicFor, vanillaMusicFor } from './music/tables.ts';
import type { Song } from './music/defs.ts';

/**
 * Default music volume. **Tuned by feel**, and deliberately below the sfx default: music sits
 * under the game rather than beside it, and a shot or a monster's wake-up has to cut through it.
 */
const DEFAULT_VOLUME = 0.6;

/**
 * Where the bus' safety curve starts bending, and how finely it is sampled.
 * **Tuned by feel.** A dense track's transients leave the chip past full scale
 * — drum hits in DOOM 2's `D_RUNNIN` reach nearly twice it — and this is what
 * catches them, *after* the volume rather than before: at any normal setting
 * the signal never reaches the bend, so those transients arrive intact, and
 * only someone running the music at full volume trades a little shaping for
 * not clipping. Shaping inside the chip instead costs every drum hit whatever
 * the volume is set to. See docs/music.md § Volume.
 */
const SOFT_CLIP_KNEE = 0.7;
const SOFT_CLIP_STEPS = 4096;

const VOLUME_STORAGE_KEY = 'topdoom.musicVolume';

/**
 * How much audio is rendered at a time and how far ahead of the clock the
 * scheduler keeps. Both **tuned by feel**, and they answer different questions.
 *
 * The chunk is a *burst* of main-thread work — a dense track costs about 2 ms
 * of synthesis per quarter second — so it stays short enough to disappear into
 * a frame. It costs nothing in quality to keep it short: the chip renders at
 * the context's own rate, so consecutive chunks are sample-exact continuations
 * of each other rather than separately resampled fragments.
 *
 * The lookahead is the opposite concern: a queue that runs dry is an audible
 * dropout, so it covers the longest stall the main thread can have — a level
 * load, a big GC, or a background tab throttling this timer to one call a
 * second. Stopping is unaffected by it: the scheduled sources are stopped
 * outright rather than left to run out.
 */
const CHUNK_SECONDS = 0.25;
const LOOKAHEAD_SECONDS = 2.5;
const PUMP_INTERVAL_MS = 150;

/** The chip's own state plus where the song being fed to it has got to. */
interface Playback {
  chip: OplChip;
  synth: OplSynth;
  song: Song;
  /** Index of the next event to apply. */
  event: number;
  /** Seconds of the song rendered so far, wrapping at its duration. */
  time: number;
  /** Context time the next chunk is scheduled at. */
  nextChunkAt: number;
  /**
   * Frames per chunk, at the context's own sample rate — the chip renders
   * straight to it, so nothing is resampled between here and the speakers. An
   * exact frame count is also what keeps consecutive chunks butting up against
   * each other instead of drifting apart by a rounding error each time.
   */
  chunkFrames: number;
  sources: Set<AudioBufferSourceNode>;
}

/**
 * The bus' transfer curve: straight through below `SOFT_CLIP_KNEE`, asymptotic
 * above it. A `WaveShaperNode` clamps its input to -1..1 before looking up, so
 * the curve's ends are also the ceiling — anything past full scale lands there
 * softly instead of squaring off.
 */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(SOFT_CLIP_STEPS);
  for (let i = 0; i < SOFT_CLIP_STEPS; i++) {
    const x = (i / (SOFT_CLIP_STEPS - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    const over = (magnitude - SOFT_CLIP_KNEE) / (1 - SOFT_CLIP_KNEE);
    curve[i] =
      magnitude <= SOFT_CLIP_KNEE
        ? x
        : Math.sign(x) * (SOFT_CLIP_KNEE + (1 - SOFT_CLIP_KNEE) * Math.tanh(over));
  }
  return curve;
}

/**
 * The music side of the audio engine: one track at a time, looping, on its own
 * gain node so it sits beside the sfx bus rather than under it.
 *
 * MUS and MIDI are synthesized here (`music/opl.ts` and the WAD's own `GENMIDI`
 * bank), rendered in chunks on the main thread and scheduled onto the
 * `AudioContext` — no worklet, because the chip is cheap next to a frame of
 * this renderer and a worklet would need its own build step (docs/music.md
 * § Getting it to the speakers). An Ogg/FLAC/MP3/WAV track skips all of that
 * and loops as a plain `AudioBufferSourceNode`.
 *
 * Volume 0 stops playback outright, the way `AudioEngine`'s own 0 does, and
 * raising it again restarts the track from the top.
 */
export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private bank: MusicBank | null = null;

  /** What `play` was last given, kept so the context or the bank arriving late can still start it. */
  private track: string | null = null;
  private playback: Playback | null = null;
  /** The looping source of an already-decoded container track. */
  private encoded: AudioBufferSourceNode | null = null;
  /** Guards against a `decodeAudioData` that lands after the track was changed. */
  private decodeToken = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Rendering time not yet handed to the profiler — see `takeRenderMs`. */
  private renderMs = 0;

  private _volume: number;

  constructor() {
    this._volume = storedVolume(VOLUME_STORAGE_KEY, DEFAULT_VOLUME);
  }

  /** Called by `AudioEngine` once its context exists; `destination` is the master gain. */
  attach(ctx: AudioContext, destination: AudioNode): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = this._volume;
    // Volume first, then the safety curve — the order is the whole point of
    // having the curve here rather than in the chip (see `SOFT_CLIP_KNEE`).
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve();
    this.bus.connect(shaper).connect(destination);
    // A level started before the first user gesture unlocked audio: its track
    // was recorded and starts here instead.
    if (this.track) this.start();
  }

  get volume(): number {
    return this._volume;
  }

  /**
   * 0-1; persisted, so it survives a reload. As with sfx there is no separate
   * mute: 0 stops the track outright rather than rendering a chip nobody can
   * hear, and coming back up starts it again from the beginning.
   */
  setVolume(value: number): void {
    const previous = this._volume;
    this._volume = Math.max(0, Math.min(1, value));
    globalThis.localStorage?.setItem(VOLUME_STORAGE_KEY, String(this._volume));
    if (this.bus) this.bus.gain.value = this._volume;
    if (this._volume === 0) this.stopPlayback();
    else if (previous === 0) this.start();
  }

  /** The WAD set's music lumps, for as long as a level owns them. Stops whatever was playing. */
  setBank(bank: MusicBank | null): void {
    this.stopPlayback();
    this.track = null;
    this.bank = bank;
  }

  /** Starts a `D_*` lump by name, or stops the music entirely with null. Re-playing the same track is a no-op. */
  play(track: string | null): void {
    const wanted = track ? track.toUpperCase() : null;
    if (wanted === this.track) return;
    this.stopPlayback();
    this.track = wanted;
    this.start();
  }

  /** Everything stops and the current track is forgotten — a level being torn down. */
  stop(): void {
    this.play(null);
  }

  /**
   * Main-thread milliseconds spent synthesizing since the last call, zeroed by
   * the read. This work is driven by a timer rather than the frame loop, so the
   * frame that follows it reports it (`FrameProfiler.offFrame`, DEVMODE's
   * `Music` bar) — a chunk costs about two milliseconds and lands every quarter
   * second, a burst the profiler spreads over frames into the per-frame average
   * it really is (docs/menu.md § Profiling overlay). Zero for a
   * container-format track, which the browser decodes.
   */
  takeRenderMs(): number {
    const ms = this.renderMs;
    this.renderMs = 0;
    return ms;
  }

  private start(): void {
    const ctx = this.ctx;
    const lump = this.track && this.bank ? this.bank.get(this.track) : null;
    if (!ctx || !this.bus || !lump || this._volume === 0) return;

    if (lump.kind === 'encoded') {
      const token = ++this.decodeToken;
      // `decodeAudioData` detaches the buffer it is given, and the lump's bytes
      // are a view into the whole WAD file — so it gets a copy, not that view.
      void ctx
        .decodeAudioData(lump.bytes.slice().buffer)
        .then((buffer) => {
          if (token !== this.decodeToken || !this.bus) return;
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.loop = true;
          source.connect(this.bus);
          source.start();
          this.encoded = source;
        })
        .catch((err: unknown) => console.warn(`${this.track}: unsupported music format`, err));
      return;
    }

    const instruments = this.bank?.genmidi();
    if (!instruments) {
      // No instrument bank, no synthesis — a bare PWAD loaded without an IWAD's
      // `GENMIDI`. Silent, like a missing sound lump is.
      console.warn(`${this.track}: no GENMIDI in this WAD set, music stays silent`);
      return;
    }
    const song = lump.kind === 'mus' ? decodeMus(lump.bytes) : decodeMidi(lump.bytes);
    // A score with no events, or with all of them at time zero, has no loop to
    // walk — and `renderChunk` would spin restarting it.
    if (!song || song.events.length === 0 || song.duration <= 0) return;

    const chip = new OplChip(ctx.sampleRate);
    this.playback = {
      chip,
      synth: new OplSynth(chip, instruments),
      song,
      event: 0,
      time: 0,
      // Half a chunk of slack, so the first buffer is queued before the clock reaches it.
      nextChunkAt: ctx.currentTime + CHUNK_SECONDS / 2,
      chunkFrames: Math.round(CHUNK_SECONDS * ctx.sampleRate),
      sources: new Set(),
    };
    this.pump();
    this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
  }

  private stopPlayback(): void {
    this.decodeToken++;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.encoded) {
      try {
        this.encoded.stop();
      } catch {
        // Never started (the context was suspended when it was scheduled).
      }
      this.encoded.disconnect();
      this.encoded = null;
    }
    if (this.playback) {
      for (const source of this.playback.sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already finished; its `onended` had removed it from the set anyway.
        }
        source.disconnect();
      }
      this.playback = null;
    }
  }

  /**
   * Keeps the scheduled audio a lookahead ahead of the context clock. A
   * suspended context (the menu is open) stops advancing `currentTime`, so this
   * naturally stops queueing and the music resumes where it left off.
   */
  private pump(): void {
    const ctx = this.ctx;
    const playback = this.playback;
    if (!ctx || !playback || !this.bus) return;
    // Scheduling in the past would play the chunk immediately and stack the
    // song on top of itself — a tab asleep long enough for that resyncs instead.
    if (playback.nextChunkAt < ctx.currentTime) playback.nextChunkAt = ctx.currentTime;
    while (playback.nextChunkAt < ctx.currentTime + LOOKAHEAD_SECONDS) {
      const t0 = performance.now();
      const buffer = this.renderChunk(playback, ctx);
      // Only the synthesis itself, not the scheduling around it — see `takeRenderMs`.
      this.renderMs += performance.now() - t0;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.bus);
      source.start(playback.nextChunkAt);
      playback.sources.add(source);
      source.onended = () => {
        playback.sources.delete(source);
        source.disconnect();
      };
      // By the buffer's own frame count, not by `CHUNK_SECONDS`: the two agree
      // to a rounding error, and it is the frames that decide where the audio
      // actually ends — a chunk starting a few microseconds early or late leaves
      // a seam right in the middle of whatever note spans it.
      playback.nextChunkAt += playback.chunkFrames / ctx.sampleRate;
    }
  }

  /**
   * One chunk of chip output, with the song's events applied at the sample they
   * fall on: render up to the next event, apply every event due at that moment,
   * repeat. Reaching the end wraps to the start — every DOOM track loops
   * (`I_PlaySong(handle, looping)`) — and takes the chip's voices with it, so a
   * note still held at the last event can't hang over the loop.
   */
  private renderChunk(playback: Playback, ctx: AudioContext): AudioBuffer {
    const total = playback.chunkFrames;
    const rate = ctx.sampleRate;
    // Stereo: the chip pans whole channels to a side, as the OPL3 does.
    const buffer = ctx.createBuffer(2, total, rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const { song, synth, chip } = playback;

    let written = 0;
    while (written < total) {
      if (playback.event >= song.events.length) {
        // Render the tail after the last event before restarting, so a track
        // that ends on a held chord keeps it rather than cutting to the top.
        const remaining = Math.max(0, Math.round((song.duration - playback.time) * rate));
        const count = Math.min(total - written, remaining);
        if (count > 0) {
          chip.render(left.subarray(written, written + count), right.subarray(written, written + count), count);
          written += count;
          playback.time += count / rate;
        }
        if (count === remaining) {
          synth.reset();
          playback.event = 0;
          playback.time = 0;
        }
        continue;
      }
      const due = song.events[playback.event];
      const samples = Math.round((due.time - playback.time) * rate);
      if (samples <= 0) {
        synth.handle(due);
        playback.event++;
        continue;
      }
      const count = Math.min(total - written, samples);
      chip.render(left.subarray(written, written + count), right.subarray(written, written + count), count);
      written += count;
      playback.time += count / rate;
    }
    return buffer;
  }
}

/**
 * Which `D_*` lump a map plays — the same resolver shape as `LevelNames` and
 * `LevelProgression`: `Game` holds one of these and asks one question. The
 * chain is the set's own MAPINFO first, then vanilla's `S_Start` choice, then
 * a lump named after the map itself — the convention a PWAD with map names of
 * its own follows — each gated on the lump actually existing.
 * docs/music.md § Which track a level plays.
 */
export class LevelMusic {
  /** Only `has` is needed of the bank — structural, so tests can pass a plain lump-name set. */
  private bank: Pick<MusicBank, 'has'>;
  /** `MapInfo.music`'s map-name → track projection of the set's MAPINFO. */
  private byMap: Map<string, string>;

  constructor(bank: Pick<MusicBank, 'has'>, byMap: Map<string, string>) {
    this.bank = bank;
    this.byMap = byMap;
  }

  /** The map's own track, or null for a level without music. */
  trackFor(mapName: string): string | null {
    const custom = this.byMap.get(mapName);
    if (custom && this.bank.has(custom)) return custom;
    const vanilla = vanillaMusicFor(mapName);
    if (vanilla && this.bank.has(vanilla)) return vanilla;
    const own = `D_${mapName}`;
    return this.bank.has(own) ? own : null;
  }

  /**
   * The track the intermission after `mapName` plays — vanilla's own
   * `S_ChangeMusic(mus_inter)` — or null to keep the level's track when the
   * set carries no such lump.
   */
  intermissionTrackFor(mapName: string): string | null {
    const track = intermissionMusicFor(mapName);
    return this.bank.has(track) ? track : null;
  }

  /**
   * The track the end card after `mapName` plays — `F_StartFinale`'s `mus_victor`/`mus_read_m` —
   * or null to keep whatever is playing when the set carries no such lump.
   */
  finaleTrackFor(mapName: string): string | null {
    const track = finaleMusicFor(mapName);
    return this.bank.has(track) ? track : null;
  }
}
