/**
 * Plays a decoded song on the chip: instrument selection out of `GENMIDI`, voice allocation over
 * the chip's `OPL_CHANNELS` channels, and the note/volume/bend arithmetic that becomes register
 * writes. See docs/music.md § From notes to registers.
 */
import {
  GENMIDI_MELODIC,
  PERCUSSION_FIRST_NOTE,
  PERCUSSION_LAST_NOTE,
  type GenMidiInstrument,
  type GenMidiVoice,
} from '../../wad/music.ts';
import { channelRegisters, OPL_CHANNELS, OPL_RATE, type OplChip } from './opl.ts';
import { DMX_VOLUME_CURVE } from './tables.ts';
import type { MusicController, MusicEvent } from './defs.ts';

/** MIDI's percussion channel, which every score reserves for the drum bank. */
const PERCUSSION_CHANNEL = 9;
/**
 * The bend range DMX works in: its own `channel->bend` spans ±64 of the 32
 * steps-per-semitone frequency index, which is MIDI's default ±2 semitones.
 */
const BEND_SEMITONES = 2;
/** `TL`'s 6-bit range — full attenuation, and the units a voice's volume is expressed in. */
const TL_MAX = 0x3f;

/**
 * Each chip channel's register addresses, `channelRegisters` run once — read per score event below.
 */
const CHANNEL_REGS = Array.from({ length: OPL_CHANNELS }, (_, i) => channelRegisters(i));

/**
 * `2^(20 - block)` per block, computed once rather than per pitch write. The division by
 * `OPL_RATE` stays at the call: scaling by a power of two is exact, so multiplying first and
 * dividing after leaves the result one rounding away from exact instead of two.
 */
const BLOCK_SHIFT = Array.from({ length: 8 }, (_, block) => Math.pow(2, 20 - block));

/**
 * A frequency as the chip addresses it: a 3-bit block (an octave) and a 10-bit
 * F-number, `fnum = f * 2^(20 - block) / 49716`. The lowest block whose
 * F-number still fits is picked, which keeps it in the top half of its range
 * and so at the chip's best resolution — the same thing DMX's own frequency
 * table does, arrived at arithmetically rather than transcribed.
 */
export function blockAndFnum(frequency: number): { block: number; fnum: number } {
  for (let block = 0; block < 7; block++) {
    const fnum = Math.round((frequency * BLOCK_SHIFT[block]) / OPL_RATE);
    if (fnum < 1024) return { block, fnum: Math.max(0, fnum) };
  }
  const fnum = Math.round((frequency * BLOCK_SHIFT[7]) / OPL_RATE);
  return { block: 7, fnum: Math.max(0, Math.min(1023, fnum)) };
}

/**
 * Per-MIDI-channel state a note reads when it starts. Volume and expression
 * default to full: a score that never sends either (plenty do) must not play
 * silently, and MIDI's own power-up default for both is 127.
 */
interface ChannelState {
  program: number;
  volume: number;
  expression: number;
  /** -1..1, the score's pitch bend around centre. */
  bend: number;
  sustain: boolean;
  /** MIDI's 0-127, centre 64 — see `panBits`. */
  pan: number;
}

/** One sounding chip channel, and what it was started for. */
interface Voice {
  midiChannel: number;
  note: number;
  velocity: number;
  instrument: GenMidiInstrument;
  patch: GenMidiVoice;
  /** True for the second half of a two-voice instrument — it takes a chip channel of its own. */
  secondary: boolean;
  /** Held by the sustain pedal after its note-off, waiting for the pedal to lift. */
  sustained: boolean;
  /** Allocation counter, so the oldest voice is the one stolen. */
  order: number;
}

/**
 * The MIDI side of the synth: it owns the chip's channels and decides which
 * note gets one. Modelled on Chocolate Doom's `i_oplmusic.c`, the only public
 * account of what DMX did — DOOM's own source calls into DMX as a binary blob,
 * so `linuxdoom-1.10` cannot settle anything here (docs/music.md § Fidelity).
 */
export class OplSynth {
  private chip: OplChip;
  private instruments: GenMidiInstrument[];
  private channels: ChannelState[] = [];
  /** Indexed by chip channel; null when that channel is free. */
  private voices: (Voice | null)[] = new Array(OPL_CHANNELS).fill(null);
  /**
   * What each chip channel last played, left behind at release so a successor
   * note can **reclaim** the channel — see `allocate` for why that is audible
   * and not bookkeeping. Stale while the channel is occupied; only free
   * channels are ever read.
   */
  private lastReleased: ({ midiChannel: number; note: number; order: number } | null)[] = new Array(
    OPL_CHANNELS,
  ).fill(null);
  private order = 0;

  constructor(chip: OplChip, instruments: GenMidiInstrument[]) {
    this.chip = chip;
    this.instruments = instruments;
    this.reset();
  }

  /** Back to a silent chip with every channel at its power-up state. */
  reset(): void {
    this.chip.reset();
    this.channels = [];
    for (let i = 0; i < 16; i++) this.channels.push(newChannelState());
    this.voices.fill(null);
    this.lastReleased.fill(null);
    this.order = 0;
    // The OPL3's own enable bit, and the shallow tremolo/vibrato depths DMX
    // leaves 0xBD at. Both are what this chip already defaults to; writing them
    // keeps the startup state explicit rather than implied.
    this.chip.write(0x105, 0x01);
    this.chip.write(0xbd, 0x00);
  }

  handle(event: MusicEvent): void {
    switch (event.kind) {
      case 'noteOn':
        this.noteOn(event.channel, event.note, event.velocity);
        break;
      case 'noteOff':
        this.noteOff(event.channel, event.note);
        break;
      case 'program':
        this.channels[event.channel].program = event.program;
        break;
      case 'pitchBend':
        this.channels[event.channel].bend = event.value;
        this.retune(event.channel);
        break;
      case 'controller':
        this.controller(event.channel, event.controller, event.value);
        break;
      default:
        break;
    }
  }

  private controller(channel: number, controller: MusicController, value: number): void {
    const state = this.channels[channel];
    switch (controller) {
      case 'volume':
        state.volume = value;
        this.revolume(channel);
        break;
      case 'expression':
        state.expression = value;
        this.revolume(channel);
        break;
      case 'pan':
        state.pan = value;
        for (let i = 0; i < this.voices.length; i++) {
          if (this.voices[i]?.midiChannel === channel) this.chip.setPan(i, panPosition(value));
        }
        break;
      case 'sustain': {
        // A pedal is "down" from 64 up, MIDI's own threshold for a switch controller.
        const down = value >= 64;
        state.sustain = down;
        if (!down) {
          for (let i = 0; i < this.voices.length; i++) {
            if (this.voices[i]?.midiChannel === channel && this.voices[i]!.sustained) {
              this.release(i);
            }
          }
        }
        break;
      }
      case 'allNotesOff':
      case 'allSoundOff':
        for (let i = 0; i < this.voices.length; i++) {
          if (this.voices[i]?.midiChannel === channel) this.release(i);
        }
        break;
      case 'resetControllers': {
        const program = state.program;
        this.channels[channel] = newChannelState();
        // A reset clears the controllers, not the patch — the score expects to
        // keep playing on the instrument it selected.
        this.channels[channel].program = program;
        break;
      }
      default:
        break;
    }
  }

  /**
   * The instrument a note plays: the score's own program on a melodic channel,
   * and on channel 9 the percussion entry the *note* selects — the drum bank's
   * 47 entries cover MIDI notes 35-81 and a note outside that has no sound at
   * all, so it is dropped rather than substituted.
   */
  private instrumentFor(channel: number, note: number): GenMidiInstrument | null {
    if (channel === PERCUSSION_CHANNEL) {
      if (note < PERCUSSION_FIRST_NOTE || note > PERCUSSION_LAST_NOTE) return null;
      return this.instruments[GENMIDI_MELODIC + (note - PERCUSSION_FIRST_NOTE)] ?? null;
    }
    return this.instruments[this.channels[channel].program] ?? null;
  }

  private noteOn(channel: number, note: number, velocity: number): void {
    const instrument = this.instrumentFor(channel, note);
    if (!instrument) return;
    // A note already sounding on this channel is restarted rather than layered,
    // the way a keyboard would — two voices on one note only waste channels.
    this.noteOff(channel, note);
    for (let i = 0; i < instrument.voices.length; i++) {
      const chip = this.allocate(channel, note);
      this.voices[chip] = {
        midiChannel: channel,
        note,
        velocity,
        instrument,
        patch: instrument.voices[i],
        secondary: i === 1,
        sustained: false,
        order: this.order++,
      };
      this.start(chip);
    }
  }

  private noteOff(channel: number, note: number): void {
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i];
      if (!voice || voice.midiChannel !== channel || voice.note !== note) continue;
      // Held by the pedal: the key-off waits, but the voice is no longer a
      // candidate for this note, so a re-press starts a fresh one.
      if (this.channels[channel].sustain) voice.sustained = true;
      else this.release(i);
    }
  }

  /**
   * A chip channel for a note on `midiChannel`. Key-on cuts whatever still rings on the channel it
   * takes, so which free channel is taken is audible: **reclaim** the one this MIDI channel
   * released most recently, else the **least audible** free one, else drop the voice `victimScore`
   * ranks lowest. docs/music.md § From notes to registers has why each rule is there.
   */
  private allocate(midiChannel: number, note: number): number {
    let reclaim = -1;
    let reclaimOrder = -1;
    let silent = -1;
    let deepest = -1;
    let deepestAtten = -1;
    for (let i = 0; i < this.voices.length; i++) {
      if (this.voices[i]) continue;
      const last = this.lastReleased[i];
      if (
        last &&
        last.midiChannel === midiChannel &&
        (midiChannel !== PERCUSSION_CHANNEL || last.note === note) &&
        last.order > reclaimOrder
      ) {
        reclaim = i;
        reclaimOrder = last.order;
      }
      const atten = this.chip.channelAttenuation(i);
      if (atten === Infinity) {
        if (silent < 0) silent = i;
      } else if (atten > deepestAtten) {
        deepestAtten = atten;
        deepest = i;
      }
    }
    if (reclaim >= 0) return reclaim;
    if (silent >= 0) return silent;
    if (deepest >= 0) return deepest;
    let victim = -1;
    let best = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const score = victimScore(this.voices[i]!);
      if (score > best) {
        best = score;
        victim = i;
      }
    }
    this.release(victim);
    return victim;
  }

  /**
   * Key-off, and the channel is free again — the envelope's release still
   * sounds it out. Only the key bit is cleared, block and F-number stay as they
   * were (`VoiceKeyOff`): zeroing them would re-pitch the note while it fades.
   */
  private release(chip: number): void {
    const voice = this.voices[chip];
    if (!voice) return;
    this.frequency(chip, false);
    this.lastReleased[chip] = { midiChannel: voice.midiChannel, note: voice.note, order: this.order++ };
    this.voices[chip] = null;
  }

  /** Writes a voice's whole patch to its chip channel and keys it on. */
  private start(chip: number): void {
    const voice = this.voices[chip]!;
    const patch = voice.patch;
    const regs = CHANNEL_REGS[chip];
    const additive = (patch.feedback & 0x01) !== 0;

    this.chip.write(0x20 | regs.modulator, patch.modulator.tremolo);
    this.chip.write(0x60 | regs.modulator, patch.modulator.attack);
    this.chip.write(0x80 | regs.modulator, patch.modulator.sustain);
    this.chip.write(0xe0 | regs.modulator, patch.modulator.waveform);
    this.chip.write(0x20 | regs.carrier, patch.carrier.tremolo);
    this.chip.write(0x60 | regs.carrier, patch.carrier.attack);
    this.chip.write(0x80 | regs.carrier, patch.carrier.sustain);
    this.chip.write(0xe0 | regs.carrier, patch.carrier.waveform);
    // Both gates on, and the stereo position set beside them — see `panPosition`.
    this.chip.write(0xc0 | regs.channel, (patch.feedback & 0x0f) | 0x30);
    this.chip.setPan(chip, panPosition(this.channels[voice.midiChannel].pan));
    this.volume(chip, additive);
    this.frequency(chip, true);
  }

  /**
   * The carrier's total level, and the modulator's too when the patch is additive and therefore
   * audible in its own right — `SetVoiceVolume`'s arithmetic, plus expression (controller 11)
   * folded into the channel volume. docs/music.md § Volume.
   */
  private volume(chip: number, additive: boolean): void {
    const voice = this.voices[chip]!;
    const state = this.channels[voice.midiChannel];
    const regs = CHANNEL_REGS[chip];
    const channelVolume = Math.round((state.volume * state.expression) / 127);
    const midiVolume = 2 * (DMX_VOLUME_CURVE[clamp7(channelVolume)] + 1);
    const carrier = TL_MAX - ((DMX_VOLUME_CURVE[clamp7(voice.velocity)] * midiVolume) >> 9);
    this.chip.write(0x40 | regs.carrier, voice.patch.carrier.scale | carrier);
    const level = voice.patch.modulator.level & TL_MAX;
    const modulator = additive && level !== TL_MAX ? Math.max(level, carrier) : level;
    this.chip.write(0x40 | regs.modulator, (voice.patch.modulator.scale & 0xc0) | modulator);
  }

  /**
   * The channel's F-number and block, and optionally the key-on bit with them.
   * A fixed-pitch instrument (every drum) ignores the note it was played with;
   * everything else takes the patch's own semitone offset, the channel's bend,
   * and — for the second voice of a two-voice instrument — its fine tuning.
   */
  private frequency(chip: number, keyOn: boolean): void {
    const voice = this.voices[chip]!;
    const state = this.channels[voice.midiChannel];
    const regs = CHANNEL_REGS[chip];
    const instrument = voice.instrument;

    let note = instrument.fixedPitch ? instrument.fixedNote : voice.note + voice.patch.baseNoteOffset;
    note += state.bend * BEND_SEMITONES;
    // The chip's own range is 0..95 in semitones; DMX folds anything past
    // either end back by octaves rather than clamping it to a wrong note.
    while (note < 0) note += 12;
    while (note > 95) note -= 12;
    // Voice 2's detune, in the 1/32-semitone units `fineTuning` counts.
    if (voice.secondary) note += ((instrument.fineTuning >> 1) - 64) / 32;

    // An **octave above** the written note, which is what DMX's own frequency
    // table does (its A4 lands on 880 Hz): `GENMIDI`'s patches are voiced with
    // the carrier's frequency multiplier at ×0.5, which halves it back.
    // docs/music.md § From notes to registers.
    const { block, fnum } = blockAndFnum(880 * Math.pow(2, (note - 69) / 12));
    this.chip.write(0xa0 | regs.channel, fnum & 0xff);
    this.chip.write(0xb0 | regs.channel, ((fnum >> 8) & 0x03) | (block << 2) | (keyOn ? 0x20 : 0x00));
  }

  /** Re-pitches every voice on a channel, after its bend moved. */
  private retune(channel: number): void {
    for (let i = 0; i < this.voices.length; i++) {
      if (this.voices[i]?.midiChannel === channel) this.frequency(i, true);
    }
  }

  /** Re-levels every voice on a channel, after its volume or expression moved. */
  private revolume(channel: number): void {
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i];
      if (voice?.midiChannel === channel) this.volume(i, (voice.patch.feedback & 0x01) !== 0);
    }
  }
}

/** MIDI's own 0-127, which every table here is indexed by. */
function clamp7(value: number): number {
  return Math.max(0, Math.min(127, Math.round(value)));
}

function newChannelState(): ChannelState {
  return { program: 0, volume: 127, expression: 127, bend: 0, sustain: false, pan: 64 };
}

/**
 * How droppable a sounding voice is, highest first — Chocolate Doom's `ReplaceExistingVoice` rule,
 * made total so it orders any two voices: sustain-held, then the second voice of a two-voice
 * instrument, then the highest MIDI channel, then the oldest (docs/music.md § From notes to
 * registers). The four are packed into one number so `allocate` is a single pass, with the age term
 * small enough that it only breaks ties.
 */
function victimScore(voice: Voice): number {
  const sustained = voice.sustained ? 1 : 0;
  const secondary = voice.secondary ? 1 : 0;
  return sustained * 1e9 + secondary * 1e6 + voice.midiChannel * 1e4 - voice.order * 1e-6;
}

/**
 * A MIDI pan (0-127) as `OplChip.setPan`'s 0-1. Two deliberate departures from
 * DMX live here, both explained in docs/music.md § From notes to registers: the
 * score's value is used **as it stands** rather than quantized to the chip's
 * three gate positions, and the sides are **not swapped**, which DMX does and
 * Chocolate Doom preserves as a bug behind `opl_stereo_correct`.
 */
function panPosition(pan: number): number {
  // MIDI's centre is 64, not the midpoint of 0-127, so the balance is taken
  // either side of it and 0 lands a hair past hard left.
  const balance = Math.max(-1, Math.min(1, (clamp7(pan) - 64) / 63));
  return (balance + 1) / 2;
}
