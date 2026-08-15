/**
 * The decoded-song record shapes both score formats produce and the synth consumes, plus the
 * builder they share. See docs/music.md § The song stream.
 */

/**
 * The MIDI controllers this engine acts on, by name rather than by number: MUS
 * and MIDI number them differently, so mapping to names is the one place each
 * decoder's own numbering is dealt with, and an unknown controller is simply
 * never built.
 */
export type MusicController =
  | 'volume'
  | 'expression'
  | 'pan'
  | 'sustain'
  | 'allNotesOff'
  | 'allSoundOff'
  | 'resetControllers';

/**
 * One score event at an absolute time in **seconds** from the song's start.
 * Tempo is resolved while decoding rather than carried here: a MIDI file's
 * tempo map and MUS's fixed 140 Hz tick are each a property of the file, and
 * the synth has no use for either once times are real.
 *
 * `channel` is the MIDI channel 0-15, with 9 the percussion channel — MUS's
 * own channel 15 is remapped to it by the decoder.
 */
export type MusicEvent =
  | { time: number; kind: 'noteOn'; channel: number; note: number; velocity: number }
  | { time: number; kind: 'noteOff'; channel: number; note: number }
  | { time: number; kind: 'program'; channel: number; program: number }
  | { time: number; kind: 'controller'; channel: number; controller: MusicController; value: number }
  /** `value` is -1..1, MIDI's 14-bit bend around its own centre. */
  | { time: number; kind: 'pitchBend'; channel: number; value: number };

/**
 * A decoded score: every event in time order, and how long one pass through it
 * lasts. Both formats loop forever in DOOM (`I_PlaySong(handle, looping)` is
 * called with looping set for every track), so `duration` is the wrap point,
 * not an end — `MusicPlayer` restarts from 0 there.
 */
export interface Song {
  events: MusicEvent[];
  duration: number;
}

/**
 * Collects events and hands back a `Song`. Both decoders emit in per-track
 * order, so the sort is what merges a multi-track MIDI file; it has to be
 * stable, since a program change and the note that uses it share a time.
 * `Array.prototype.sort` is required to be stable, so the index tiebreak the
 * old engines needed is not.
 */
export function buildSong(events: MusicEvent[], duration: number): Song {
  events.sort((a, b) => a.time - b.time);
  return { events, duration: Math.max(duration, events.length > 0 ? events[events.length - 1].time : 0) };
}
