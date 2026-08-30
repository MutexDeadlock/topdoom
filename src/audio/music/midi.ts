/**
 * Decodes a standard MIDI file (freedoom2's and many PWADs' `D_*` lumps) into the shared event
 * stream, resolving its tempo map on the way. See docs/music.md § MIDI.
 */
import { buildSong, type MusicController, type MusicEvent, type Song } from './defs.ts';

/** 120 bpm, the tempo a file without a tempo meta event runs at (MIDI's own default). */
const DEFAULT_TEMPO = 500000;

/** MIDI's controller numbers, which are *not* MUS's — see `mus.ts`'s own table. */
const CONTROLLERS: Record<number, MusicController> = {
  7: 'volume',
  10: 'pan',
  11: 'expression',
  64: 'sustain',
  120: 'allSoundOff',
  121: 'resetControllers',
  123: 'allNotesOff',
};

/** An event still on the file's own tick clock, before the tempo map turns ticks into seconds. */
interface TickedEvent {
  tick: number;
  /** Microseconds per quarter note this event sets, or 0 for anything else. */
  tempo: number;
  /** Null for a tempo change, which exists only to move the clock. `time` is filled in later. */
  event: MusicEvent | null;
}

/**
 * A standard MIDI file's events with absolute times, or null when the bytes
 * aren't one. Every track is read onto the shared tick clock and merged, then
 * walked once to apply the tempo map — a tempo change sits in track 0 of a
 * format-1 file but governs all of them, so times can only be resolved after
 * the merge.
 */
export function decodeMidi(bytes: Uint8Array): Song | null {
  if (bytes.length < 14) return null;
  const r = new MidiReader(bytes);
  if (r.ascii(4) !== 'MThd') return null;
  const headerLength = r.u32();
  r.u16(); // format: 0, 1 and 2 are all just tracks to be merged here
  const trackCount = r.u16();
  const division = r.u16();
  r.pos = 8 + headerLength;

  const ticked: TickedEvent[] = [];
  for (let i = 0; i < trackCount && !r.eof; i++) {
    const id = r.ascii(4);
    const length = r.u32();
    const end = Math.min(bytes.length, r.pos + length);
    // Anything that isn't an `MTrk` is a chunk type this reader doesn't know;
    // the header's own length field is how the format says to skip it.
    if (id === 'MTrk') readTrack(r, end, ticked);
    r.pos = end;
  }
  // Stable, so events sharing a tick keep track order — a program change and
  // the note that uses it routinely do.
  ticked.sort((a, b) => a.tick - b.tick);

  /**
   * SMPTE timing (the division's high bit) fixes seconds per tick outright:
   * frames per second in the high byte, as a negative number, and ticks per
   * frame in the low. Otherwise a tick is a fraction of a quarter note and the
   * tempo map decides how long that is.
   */
  const smpte = (division & 0x8000) !== 0;
  const ticksPerQuarter = smpte ? 0 : division;
  const smpteSeconds = smpte ? 1 / (((0x100 - (division >> 8)) & 0xff) * (division & 0xff)) : 0;

  const events: MusicEvent[] = [];
  let tempo = DEFAULT_TEMPO;
  let lastTick = 0;
  let time = 0;
  for (const entry of ticked) {
    const secondsPerTick = smpte ? smpteSeconds : tempo / 1e6 / Math.max(1, ticksPerQuarter);
    time += (entry.tick - lastTick) * secondsPerTick;
    lastTick = entry.tick;
    if (entry.event) {
      entry.event.time = time;
      events.push(entry.event);
    } else if (entry.tempo > 0) {
      tempo = entry.tempo;
    }
  }
  return buildSong(events, time);
}

/** Big-endian cursor — MIDI files are, unlike everything else in a WAD. */
class MidiReader {
  private view: DataView;
  private bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  u8(): number {
    return this.bytes[this.pos++];
  }

  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  /** MIDI's variable-length quantity: 7 bits per byte, high bit continues. */
  varint(): number {
    let value = 0;
    for (let i = 0; i < 4 && !this.eof; i++) {
      const b = this.u8();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return value;
  }

  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

/**
 * One `MTrk` chunk's events on the file's tick clock. Running status (an event
 * that omits its status byte and reuses the last one) is the one piece of the
 * format that can't be skipped past, since it decides how many data bytes
 * follow.
 */
function readTrack(r: MidiReader, end: number, out: TickedEvent[]): void {
  let tick = 0;
  let status = 0;
  while (r.pos < end) {
    tick += r.varint();
    let byte = r.u8();
    if (byte < 0x80) {
      // Running status: this byte is already the first data byte.
      r.pos--;
      byte = status;
    } else if (byte < 0xf0) {
      status = byte;
    }
    const channel = byte & 0x0f;

    if (byte === 0xff) {
      const type = r.u8();
      const length = r.varint();
      const at = r.pos;
      if (type === 0x51 && length === 3) {
        out.push({ tick, tempo: (r.u8() << 16) | (r.u8() << 8) | r.u8(), event: null });
      }
      r.pos = at + length;
      if (type === 0x2f) return; // end of track
      continue;
    }
    if (byte === 0xf0 || byte === 0xf7) {
      r.pos += r.varint(); // sysex, nothing here can act on it
      continue;
    }

    switch (byte & 0xf0) {
      case 0x80: {
        const note = r.u8() & 0x7f;
        r.u8();
        out.push({ tick, tempo: 0, event: { time: 0, kind: 'noteOff', channel, note } });
        break;
      }
      case 0x90: {
        const note = r.u8() & 0x7f;
        const velocity = r.u8() & 0x7f;
        // A note-on at velocity 0 is a note-off, and files really do rely on it
        // — it is what makes running status worth using for a run of notes.
        out.push(
          velocity === 0
            ? { tick, tempo: 0, event: { time: 0, kind: 'noteOff', channel, note } }
            : { tick, tempo: 0, event: { time: 0, kind: 'noteOn', channel, note, velocity } },
        );
        break;
      }
      case 0xb0: {
        const number = r.u8() & 0x7f;
        const value = r.u8() & 0x7f;
        const controller = CONTROLLERS[number];
        if (controller) out.push({ tick, tempo: 0, event: { time: 0, kind: 'controller', channel, controller, value } });
        break;
      }
      case 0xc0: {
        out.push({ tick, tempo: 0, event: { time: 0, kind: 'program', channel, program: r.u8() & 0x7f } });
        break;
      }
      case 0xe0: {
        const low = r.u8() & 0x7f;
        const high = r.u8() & 0x7f;
        out.push({
          tick,
          tempo: 0,
          event: { time: 0, kind: 'pitchBend', channel, value: ((high << 7) | low) / 8192 - 1 },
        });
        break;
      }
      // Aftertouch (0xA0, 0xD0): read past the data bytes and drop it — an OPL
      // voice has nothing to apply it to.
      case 0xa0:
        r.pos += 2;
        break;
      case 0xd0:
        r.pos += 1;
        break;
      default:
        return; // an unreadable status byte: the rest of this track is not parseable
    }
  }
}

