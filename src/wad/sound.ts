/**
 * Decodes `DS*` sound lumps: vanilla's DMX PCM, or a browser-decodable container a modern
 * replacement PWAD ships. See docs/audio.md § Sound lumps.
 */
import type { Lump, Wad } from './wad.ts';

/**
 * A sound lump's payload, in whichever of the two shapes WADs actually carry:
 *
 * - `'pcm'` — vanilla's DMX format, decoded here (it is 8 bytes of header plus
 *   raw unsigned 8-bit samples; nothing a browser knows how to read).
 * - `'encoded'` — a container the browser decodes itself (Ogg Vorbis, WAV,
 *   FLAC, MP3). Not vanilla, but the convention every modern port follows and
 *   what a sound-replacement PWAD built in the last two decades will hold, so
 *   the bytes are handed on untouched for `AudioContext.decodeAudioData`.
 *
 * See docs/audio.md § Sound lumps.
 */
export type SoundLump =
  | { kind: 'pcm'; sampleRate: number; samples: Float32Array }
  | { kind: 'encoded'; bytes: Uint8Array };

/** DMX sound-lump magic (`0x0003`) in the first two bytes — vanilla's only sound format. */
const DMX_FORMAT = 3;
/** Bytes of DMX header (format, sample rate, sample count) before the samples themselves. */
const DMX_HEADER_SIZE = 8;

/**
 * Sample rates a `Float32Array` can actually become an `AudioBuffer` at — the
 * Web Audio spec's own required range. A malformed or non-DMX-but-`0x0003`
 * lump can carry anything here, and `createBuffer` throws rather than clamping,
 * so an out-of-range rate falls back to vanilla's own 11025.
 */
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 96000;
const VANILLA_SAMPLE_RATE = 11025;

/**
 * Every sound lump the loaded WAD set carries, keyed by vanilla sfx name
 * (`'pistol'` → lump `DSPISTOL`), decoded on first use and cached.
 *
 * A name the WAD set has no lump for resolves to `null` and stays silent —
 * deliberately *not* vanilla's own behavior, which substitutes `DSPISTOL` for
 * anything missing (`i_sound.c: getsfx`) because `sounds.c` isn't gamemode
 * aware. That made shareware DOOM play pistol shots for cacodemon deaths;
 * silence is the better failure, and `DOOM1.WAD` (49 of the 107 sound lumps)
 * is a WAD this engine is expected to run.
 */
export class SoundBank {
  private wad: Wad;
  private cache = new Map<string, SoundLump | null>();

  constructor(wad: Wad) {
    this.wad = wad;
  }

  /** Lump name for a vanilla sfx name, matching `i_sound.c`'s own `sprintf(name, "ds%s", sfxname)`. */
  private static lumpName(name: string): string {
    return `DS${name.toUpperCase()}`;
  }

  get(name: string): SoundLump | null {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    const lump = this.wad.find(SoundBank.lumpName(name));
    const decoded = lump ? this.decode(lump) : null;
    this.cache.set(name, decoded);
    return decoded;
  }

  /** Whether the WAD set carries this sfx at all, without decoding it. */
  has(name: string): boolean {
    return this.wad.find(SoundBank.lumpName(name)) !== undefined;
  }

  /**
   * Sfx names whose lump is in a browser-decodable container rather than DMX
   * — the ones an `AudioEngine` has to hand to the (asynchronous)
   * `decodeAudioData` and therefore wants to start on ahead of time, so the
   * first shot of a sound-replacement PWAD isn't silent while it decodes.
   * Checked from the header alone, which is why this doesn't decode anything.
   */
  encodedNames<T extends string>(sfxNames: readonly T[]): T[] {
    const out: T[] = [];
    for (const name of sfxNames) {
      const lump = this.wad.find(SoundBank.lumpName(name));
      if (lump && lump.size >= 2 && this.wad.reader(lump).u16() !== DMX_FORMAT) out.push(name);
    }
    return out;
  }

  private decode(lump: Lump): SoundLump | null {
    if (lump.size < DMX_HEADER_SIZE) return null;
    const r = this.wad.reader(lump);
    if (r.u16() !== DMX_FORMAT) return { kind: 'encoded', bytes: this.wad.data(lump) };

    const rate = r.u16();
    const declared = r.u32();
    // Vanilla ignores the count field entirely and plays `lumpsize - 8` bytes;
    // the count is trusted here only as far as the lump actually reaches, since
    // a truncated or over-declared lump is a real thing in the wild.
    const available = lump.size - DMX_HEADER_SIZE;
    const count = Math.min(declared > 0 ? declared : available, available);
    if (count <= 0) return null;

    const bytes = this.wad.data(lump);
    const samples = new Float32Array(count);
    // Unsigned 8-bit, silence at 128 — the 16 padding samples id's own sounds
    // carry at each end sit at that level, so they're inaudible and kept
    // rather than trimmed, exactly as vanilla plays them.
    for (let i = 0; i < count; i++) samples[i] = (bytes[DMX_HEADER_SIZE + i] - 128) / 128;
    return {
      kind: 'pcm',
      sampleRate: rate >= MIN_SAMPLE_RATE && rate <= MAX_SAMPLE_RATE ? rate : VANILLA_SAMPLE_RATE,
      samples,
    };
  }
}
