/**
 * Decodes a MUS score — DMX's own compact MIDI variant, what every id-era `D_*` lump is — into
 * the shared event stream. See docs/music.md § MUS.
 */
import { buildSong, type MusicController, type MusicEvent, type Song } from './defs.ts';

/**
 * MUS runs on a fixed 140 Hz tick — vanilla's `TICRATE`, since DMX drives it off the same timer.
 */
const MUS_TICKS_PER_SECOND = 140;

/**
 * MUS's own controller numbers (the `changeController` event's first byte),
 * mapped onto the names {@link MusicEvent} carries. Deliberately **not** MIDI's
 * numbering: MUS renumbers them 0-9, so 3 is volume here and pitch bend
 * elsewhere. 0 (instrument) is handled as a program change before this table is
 * reached, and the four this maps to `null` are real controllers the OPL synth
 * has nothing to do with.
 */
const CONTROLLERS: (MusicController | null)[] = [
  null, // 0 instrument, handled as a program change
  null, // 1 bank select
  null, // 2 modulation
  'volume',
  'pan',
  'expression',
  null, // 6 reverb depth
  null, // 7 chorus depth
  'sustain',
  null, // 9 soft pedal
];

/**
 * MUS's system events (event type 3), which are MIDI's channel-mode messages
 * under their own numbering. Mono/poly (12/13) are meaningless to a synth that
 * is polyphonic per channel either way.
 */
const SYSTEM_EVENTS: Record<number, MusicController> = {
  10: 'allSoundOff',
  11: 'allNotesOff',
  14: 'resetControllers',
};

/**
 * A MUS score's events with absolute times. Returns null when the bytes aren't
 * a MUS lump or its header points outside them — a truncated score simply ends
 * where the bytes do, which is all a player can do about it.
 */
export function decodeMus(bytes: Uint8Array): Song | null {
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x1a53554d) return null; // 'MUS\x1a', little-endian
  const scoreLength = view.getUint16(4, true);
  const scoreStart = view.getUint16(6, true);
  if (scoreStart >= bytes.length) return null;
  const end = Math.min(bytes.length, scoreStart + scoreLength || bytes.length);

  const events: MusicEvent[] = [];
  /** Last per-channel note volume, for a play-note event that omits its own (bit 7 clear). */
  const lastVolume = new Uint8Array(16).fill(100);
  let tick = 0;
  let at = scoreStart;

  while (at < end) {
    const descriptor = bytes[at++];
    const last = (descriptor & 0x80) !== 0;
    const type = (descriptor >> 4) & 0x07;
    const channel = midiChannel(descriptor & 0x0f);
    const time = tick / MUS_TICKS_PER_SECOND;

    if (type === 6) break; // score end
    if (at > end) break;

    switch (type) {
      case 0: {
        events.push({ time, kind: 'noteOff', channel, note: bytes[at++] & 0x7f });
        break;
      }
      case 1: {
        const noteByte = bytes[at++];
        const note = noteByte & 0x7f;
        // Bit 7 says a volume byte follows; without one the note keeps whatever
        // this channel last played at, which is how MUS stays compact.
        if (noteByte & 0x80) lastVolume[channel] = bytes[at++] & 0x7f;
        events.push({ time, kind: 'noteOn', channel, note, velocity: lastVolume[channel] });
        break;
      }
      case 2: {
        // One byte for the whole bend range, 128 being centre — a MIDI bend's
        // two 7-bit halves compressed to eight bits.
        const bend = bytes[at++];
        events.push({ time, kind: 'pitchBend', channel, value: (bend - 128) / 128 });
        break;
      }
      case 3: {
        const controller = SYSTEM_EVENTS[bytes[at++]];
        if (controller) events.push({ time, kind: 'controller', channel, controller, value: 0 });
        break;
      }
      case 4: {
        const number = bytes[at++];
        const value = bytes[at++] & 0x7f;
        if (number === 0) events.push({ time, kind: 'program', channel, program: value });
        else {
          const controller = CONTROLLERS[number];
          if (controller) events.push({ time, kind: 'controller', channel, controller, value });
        }
        break;
      }
      default:
        // 5 and 7 are unassigned and carry no payload; skipping the descriptor
        // alone keeps the stream aligned, which is what every player does.
        break;
    }

    if (last) {
      // The delay to the next event: 7 bits per byte, high bit continues.
      let delay = 0;
      while (at < end) {
        const b = bytes[at++];
        delay = (delay << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      tick += delay;
    }
  }

  return buildSong(events, tick / MUS_TICKS_PER_SECOND);
}

/**
 * MUS reserves its **channel 15** for percussion where MIDI reserves channel 9,
 * so the two swap places — the same remap `mus2mid` makes. Every other channel
 * passes through, and the swap keeps the count at 16 rather than shifting a
 * whole block of channels around.
 */
function midiChannel(musChannel: number): number {
  if (musChannel === 15) return 9;
  if (musChannel === 9) return 15;
  return musChannel;
}
