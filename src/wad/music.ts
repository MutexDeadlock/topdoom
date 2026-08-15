/**
 * Decodes the two music-side lumps: a `D_*` track (MUS, MIDI, or a container the browser plays
 * itself) and `GENMIDI`, the OPL instrument bank the synth plays those through.
 * See docs/music.md § Lumps.
 */
import type { Wad } from './wad.ts';
import { Reader } from './reader.ts';

/**
 * A music lump's payload, in the three shapes WADs actually carry:
 *
 * - `'mus'` — DMX's own compact MIDI variant, what every id-era `D_*` lump is.
 * - `'midi'` — a standard MIDI file, what a lot of post-2000 PWADs (and
 *   freedoom2) ship instead, since every source port reads both.
 * - `'encoded'` — Ogg Vorbis, FLAC, MP3 or WAV, handed to `decodeAudioData`
 *   untouched exactly as `SoundLump`'s own `'encoded'` is.
 *
 * See docs/music.md § Lumps.
 */
export type MusicLump =
  | { kind: 'mus'; bytes: Uint8Array }
  | { kind: 'midi'; bytes: Uint8Array }
  | { kind: 'encoded'; bytes: Uint8Array };

/** `MUS\x1a` and `MThd`, each format's own magic, as bytes. */
const MUS_MAGIC = [0x4d, 0x55, 0x53, 0x1a];
const MIDI_MAGIC = [0x4d, 0x54, 0x68, 0x64];

/** `GENMIDI`'s header, and the record counts the DMX bank is fixed at. */
const GENMIDI_MAGIC = '#OPL_II#';
const GENMIDI_HEADER_SIZE = 8;
/** 128 General MIDI programs followed by 47 percussion entries, MIDI notes 35..81. */
export const GENMIDI_MELODIC = 128;
const GENMIDI_PERCUSSION = 47;
const GENMIDI_RECORDS = GENMIDI_MELODIC + GENMIDI_PERCUSSION;
const GENMIDI_RECORD_SIZE = 36;

/** The lowest and highest MIDI note the percussion half of the bank covers. */
export const PERCUSSION_FIRST_NOTE = 35;
export const PERCUSSION_LAST_NOTE = PERCUSSION_FIRST_NOTE + GENMIDI_PERCUSSION - 1;

/** `flags` bit 0: play `fixedNote` whatever note arrives — every percussion entry sets it. */
const FLAG_FIXED_PITCH = 0x0001;
/** `flags` bit 2: the entry's second voice is meant to sound alongside the first. */
const FLAG_TWO_VOICE = 0x0004;

/**
 * One operator's six register bytes, in the order the lump stores them and with
 * the bit layout the chip expects — they are written to the OPL as-is, which is
 * what DMX itself does. See docs/music.md § Instruments.
 */
export interface GenMidiOperator {
  /** Reg 0x20: tremolo, vibrato, sustaining-envelope, key-scale-rate, frequency multiplier. */
  tremolo: number;
  /** Reg 0x60: attack rate in the high nibble, decay rate in the low. */
  attack: number;
  /** Reg 0x80: sustain level in the high nibble, release rate in the low. */
  sustain: number;
  /** Reg 0xE0: waveform select. */
  waveform: number;
  /** Reg 0x40's key-scale-level bits, already in place (0xC0). */
  scale: number;
  /** Reg 0x40's total-level bits (0x3F). Not an absolute volume — see `OplSynth.voiceVolume`. */
  level: number;
}

/** One OPL patch: its two operators, the channel's feedback/connection byte, and a note offset. */
export interface GenMidiVoice {
  modulator: GenMidiOperator;
  /** Reg 0xC0: feedback in bits 1-3, the FM/AM connection bit in bit 0. */
  feedback: number;
  carrier: GenMidiOperator;
  /** Semitones added to the note before it becomes a frequency, signed. */
  baseNoteOffset: number;
}

/** One of the bank's 175 instruments. */
export interface GenMidiInstrument {
  fixedPitch: boolean;
  /** Voice 2's detune, 0x80 being none — a fine offset, not a semitone count. */
  fineTuning: number;
  /** The note a `fixedPitch` entry always plays, whatever the score asked for. */
  fixedNote: number;
  /** One voice, or two when the record's `FLAG_TWO_VOICE` is set — never empty. */
  voices: GenMidiVoice[];
}

function readOperator(r: Reader): GenMidiOperator {
  return {
    tremolo: r.u8(),
    attack: r.u8(),
    sustain: r.u8(),
    waveform: r.u8(),
    scale: r.u8(),
    level: r.u8(),
  };
}

function readVoice(r: Reader): GenMidiVoice {
  const modulator = readOperator(r);
  const feedback = r.u8();
  const carrier = readOperator(r);
  r.u8(); // the record's one unused byte
  return { modulator, feedback, carrier, baseNoteOffset: r.i16() };
}

/** The 175 instruments a `GENMIDI` lump's bytes carry, or null if it isn't one. */
export function parseGenMidi(bytes: Uint8Array): GenMidiInstrument[] | null {
  if (bytes.length < GENMIDI_HEADER_SIZE + GENMIDI_RECORDS * GENMIDI_RECORD_SIZE) return null;
  for (let i = 0; i < GENMIDI_MAGIC.length; i++) {
    if (bytes[i] !== GENMIDI_MAGIC.charCodeAt(i)) return null;
  }
  const r = new Reader(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: GenMidiInstrument[] = [];
  for (let i = 0; i < GENMIDI_RECORDS; i++) {
    r.seek(GENMIDI_HEADER_SIZE + i * GENMIDI_RECORD_SIZE);
    const flags = r.u16();
    const fineTuning = r.u8();
    const fixedNote = r.u8();
    const voices = [readVoice(r)];
    if (flags & FLAG_TWO_VOICE) voices.push(readVoice(r));
    out.push({ fixedPitch: (flags & FLAG_FIXED_PITCH) !== 0, fineTuning, fixedNote, voices });
  }
  return out;
}

/**
 * The loaded WAD set's music: a `D_*` track by lump name, and the `GENMIDI`
 * bank behind it. A PWAD replaces either one by name collision alone, like
 * every other lump (docs/wad.md § Loading and merging) — which is how a music
 * PWAD works, and how the DMXOPL instrument banks people ship work too.
 *
 * A set with no `GENMIDI` (a bare PWAD loaded on its own, most Doom-engine
 * shovelware) leaves `genmidi` null, and `MusicPlayer` then plays only the
 * tracks the browser decodes itself. See docs/music.md § Lumps.
 */
export class MusicBank {
  private wad: Wad;
  private cache = new Map<string, MusicLump | null>();
  private instruments: GenMidiInstrument[] | null | undefined;

  constructor(wad: Wad) {
    this.wad = wad;
  }

  /** By lump name (`'D_RUNNIN'`), not by the sfx-style bare name — `S_music[]` stores these whole. */
  get(name: string): MusicLump | null {
    const key = name.toUpperCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const lump = this.wad.find(key);
    const decoded = lump && lump.size > 4 ? classify(this.wad.data(lump)) : null;
    this.cache.set(key, decoded);
    return decoded;
  }

  has(name: string): boolean {
    return this.wad.find(name.toUpperCase()) !== undefined;
  }

  /** The set's instrument bank, parsed once; null when it carries no usable `GENMIDI`. */
  genmidi(): GenMidiInstrument[] | null {
    if (this.instruments === undefined) {
      const lump = this.wad.find('GENMIDI');
      this.instruments = lump ? parseGenMidi(this.wad.data(lump)) : null;
    }
    return this.instruments;
  }
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Which of the three shapes a track is in, from its magic alone. Anything that
 * is neither MUS nor MIDI is assumed to be a container and handed to the
 * browser — guessing Ogg/FLAC/MP3/WAV apart here would buy nothing, since
 * `decodeAudioData` rejects what it can't play and the track is skipped either
 * way.
 */
function classify(bytes: Uint8Array): MusicLump {
  if (startsWith(bytes, MUS_MAGIC)) return { kind: 'mus', bytes };
  if (startsWith(bytes, MIDI_MAGIC)) return { kind: 'midi', bytes };
  return { kind: 'encoded', bytes };
}
