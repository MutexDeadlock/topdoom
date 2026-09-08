import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { MusicBank, parseGenMidi, PERCUSSION_FIRST_NOTE } from '../../src/wad/music.ts';
import { decodeMus } from '../../src/audio/music/mus.ts';
import { decodeMidi } from '../../src/audio/music/midi.ts';
import { channelRegisters, OplChip, OPL_CHANNELS, OPL_RATE } from '../../src/audio/music/opl.ts';
import { blockAndFnum, OplSynth } from '../../src/audio/music/synth.ts';
import { vanillaMusicFor } from '../../src/audio/music/tables.ts';
import { LevelMusic } from '../../src/audio/music.ts';
import { fixtureWad, wadFile } from '../fixtures/wadfile.ts';

/**
 * The music subsystem, whose fidelity reference is Chocolate Doom's `i_oplmusic.c` rather than
 * `linuxdoom-1.10` (docs/music.md § Fidelity). What is worth pinning is therefore the arithmetic
 * that reproduces DMX — the frequency an octave above the note, the per-map table — plus each
 * score format's own decoding, which is where a silent track usually comes from.
 */

/** `doom1_lumps.wad`: the shareware IWAD's own `GENMIDI` and `D_E1M1`, the two lumps asserted against below. */
const doom1 = (): Wad => new Wad([fixtureWad('doom1_lumps.wad')]);

/** A MUS score from event bytes, with the header this engine's decoder reads. */
function musLump(score: number[]): Uint8Array {
  const header = [0x4d, 0x55, 0x53, 0x1a, score.length & 0xff, score.length >> 8, 16, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([...header, ...score]);
}

/** A one-track format-0 MIDI file from event bytes, at `division` ticks per quarter note. */
function midiLump(track: number[], division = 96): Uint8Array {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, division >> 8, division & 0xff];
  const length = track.length;
  const chunk = [0x4d, 0x54, 0x72, 0x6b, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];
  return new Uint8Array([...header, ...chunk, ...track]);
}

describe('Music · MUS scores', () => {
  test('a note keeps the last volume when the event omits one', () => {
    const song = decodeMus(
      musLump([
        0x10, 0x80 | 60, 100, // play note, channel 0, note 60 with volume 100
        0x90, 62, 35, // play note, no volume byte, then a 35-tick delay
        0x00, 62, // release note 62
        0x60, 0, // score end
      ]),
    )!;
    assert.equal(song.events.length, 3);
    assert.deepEqual(song.events[0], { time: 0, kind: 'noteOn', channel: 0, note: 60, velocity: 100 });
    assert.deepEqual(song.events[1], { time: 0, kind: 'noteOn', channel: 0, note: 62, velocity: 100 });
    // 35 of MUS's 140 Hz ticks is a quarter of a second.
    assert.equal(song.events[2].time, 0.25);
  });

  test('a multi-byte delay is seven bits per byte', () => {
    const song = decodeMus(musLump([0x90, 60, 0x81, 0x1c, 0x00, 60, 0x60, 0]))!;
    // 0x81 0x1c is (1 << 7) | 28 = 156 ticks.
    assert.equal(song.events[1].time, 156 / 140);
  });

  test('MUS channel 15 becomes MIDI percussion channel 9, and 9 becomes 15', () => {
    const song = decodeMus(musLump([0x1f, 0x80 | 40, 100, 0x99, 50, 0x60, 0]))!;
    assert.equal(song.events[0].channel, 9);
    assert.equal(song.events[1].channel, 15);
  });

  test('pitch bend is centred on 128 and controllers are mapped by MUS numbering', () => {
    const song = decodeMus(musLump([0x20, 192, 0x40, 3, 64, 0x60, 0]))!;
    assert.deepEqual(song.events[0], { time: 0, kind: 'pitchBend', channel: 0, value: 0.5 });
    // MUS controller 3 is volume; in MIDI's own numbering 3 is nothing at all.
    assert.deepEqual(song.events[1], { time: 0, kind: 'controller', channel: 0, controller: 'volume', value: 64 });
  });

  test("DOOM1's D_E1M1 decodes to the riff it is", () => {
    const lump = new MusicBank(doom1()).get('D_E1M1')!;
    assert.equal(lump.kind, 'mus');
    const song = decodeMus(lump.bytes)!;
    const melody = song.events.filter((e) => e.kind === 'noteOn' && e.channel === 1).slice(0, 8);
    // E2 E2 E3 E2 E2 D3 E2 E2 — "At Doom's Gate", straight off the lump.
    assert.deepEqual(
      melody.map((e) => (e.kind === 'noteOn' ? e.note : 0)),
      [40, 40, 52, 40, 40, 50, 40, 40],
    );
    assert.ok(song.duration > 60, `a whole loop, got ${song.duration}s`);
  });
});

describe('Music · MIDI files', () => {
  test('running status, a velocity-0 note-off and the tempo map', () => {
    const song = decodeMidi(
      midiLump([
        0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo: 500000 µs per quarter note
        0x00, 0x90, 60, 100, // note on
        0x60, 62, 100, // running status: another note on, 96 ticks later
        0x00, 62, 0, // running status again, velocity 0 = note off
        0x00, 0xff, 0x2f, 0x00,
      ]),
    )!;
    assert.deepEqual(
      song.events.map((e) => e.kind),
      ['noteOn', 'noteOn', 'noteOff'],
    );
    // 96 ticks is one quarter note, and 500000 µs is half a second of it.
    assert.equal(song.events[1].time, 0.5);
  });

  test('a tempo change applies to the events after it', () => {
    const song = decodeMidi(
      midiLump([
        0x00, 0x90, 60, 100,
        0x60, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40, // half speed from here
        0x60, 0x90, 62, 100,
        0x00, 0xff, 0x2f, 0x00,
      ]),
    )!;
    assert.equal(song.events[0].time, 0);
    assert.equal(song.events[1].time, 1.5); // 0.5s at the old tempo, then 1.0s at the new one
  });

  test('tracks are merged onto one clock', () => {
    // Format 1, two tracks: the second one's note has to land between the first's.
    const track = (events: number[]) => {
      const chunk = [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, events.length];
      return [...chunk, ...events];
    };
    const bytes = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0, 96,
      ...track([0x00, 0x90, 60, 100, 0x60, 62, 100, 0x00, 0xff, 0x2f, 0x00]),
      ...track([0x30, 0x91, 64, 100, 0x00, 0xff, 0x2f, 0x00]),
    ]);
    const song = decodeMidi(bytes)!;
    assert.deepEqual(
      song.events.map((e) => (e.kind === 'noteOn' ? e.note : 0)),
      [60, 64, 62],
    );
  });

  test('a lump that is neither format decodes to nothing rather than throwing', () => {
    assert.equal(decodeMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])), null);
    assert.equal(decodeMus(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])), null);
  });
});

describe('Music · the WAD side', () => {
  test('a track is classified by its magic', () => {
    const wad = new Wad([
      wadFile('PWAD', 'test.wad', [
        { name: 'D_OGG', bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]) },
        { name: 'D_MIDI', bytes: midiLump([0x00, 0xff, 0x2f, 0x00]) },
        { name: 'D_MUS', bytes: musLump([0x60, 0]) },
      ]),
    ]);
    const bank = new MusicBank(wad);
    assert.equal(bank.get('D_OGG')!.kind, 'encoded');
    assert.equal(bank.get('D_MIDI')!.kind, 'midi');
    assert.equal(bank.get('D_MUS')!.kind, 'mus');
    assert.equal(bank.get('D_NOPE'), null);
    // No `GENMIDI` in this set: MUS and MIDI can't be synthesized at all.
    assert.equal(bank.genmidi(), null);
  });

  test("DOOM1's GENMIDI is 128 melodic instruments and 47 percussion entries", () => {
    const instruments = new MusicBank(doom1()).genmidi()!;
    assert.equal(instruments.length, 175);
    // Almost every percussion entry plays its own note whatever the score asks
    // for — the three that don't (MIDI notes 58, 70 and 78) are the lump's own
    // oddity, not a parse error, and they follow the played note like a melodic
    // instrument does.
    const free = [];
    for (let i = 128; i < 175; i++) {
      if (instruments[i].fixedPitch) assert.ok(instruments[i].fixedNote > 0, `entry ${i - 128} names a note`);
      else free.push(PERCUSSION_FIRST_NOTE + i - 128);
    }
    assert.deepEqual(free, [58, 70, 78]);
    // The bank's 33 two-voice instruments all get their second voice, or a note plays half an
    // instrument.
    assert.equal(instruments.filter((i) => i.voices.length === 2).length, 33);
    // The record's fields land where they should: DOOM's grand piano, whose
    // modulator carries a key-scale-level of 0x40 and a level of 20.
    const piano = instruments[0].voices[0];
    assert.equal(piano.modulator.scale, 0x40);
    assert.equal(piano.modulator.level, 20);
    assert.equal(piano.baseNoteOffset, 0);
    assert.equal(instruments[0].fineTuning, 0x80, 'no detune');
  });

  test('a lump that is not a GENMIDI bank is refused rather than half-read', () => {
    assert.equal(parseGenMidi(new Uint8Array(11908)), null);
    assert.equal(parseGenMidi(new Uint8Array([0x23, 0x4f, 0x50, 0x4c, 0x5f, 0x49, 0x49, 0x23])), null);
  });
});

describe('Music · which track a level plays', () => {
  test("vanilla's own per-map choice", () => {
    assert.equal(vanillaMusicFor('MAP01'), 'D_RUNNIN');
    assert.equal(vanillaMusicFor('MAP08'), 'D_DDTBLU');
    assert.equal(vanillaMusicFor('MAP32'), 'D_ULTIMA');
    assert.equal(vanillaMusicFor('E1M1'), 'D_E1M1');
    assert.equal(vanillaMusicFor('E3M9'), 'D_E3M9');
    // Episode 4 has no music of its own — `S_Start`'s `spmus[]`.
    assert.equal(vanillaMusicFor('E4M1'), 'D_E3M4');
    assert.equal(vanillaMusicFor('E4M9'), 'D_E1M9');
  });

  test('a megawad past the end of the table wraps instead of running off it', () => {
    assert.equal(vanillaMusicFor('MAP33'), 'D_RUNNIN');
    assert.equal(vanillaMusicFor('E5M1'), 'D_E2M1');
  });

  test('a map name in neither shape has no vanilla track', () => {
    assert.equal(vanillaMusicFor('TITLEMAP'), null);
    assert.equal(vanillaMusicFor('MAP1'), null);
  });

  /** A `LevelMusic` bank holding exactly these lumps. */
  const bank = (...names: string[]) => {
    const set = new Set(names);
    return { has: (name: string) => set.has(name.toUpperCase()) };
  };

  test('MAPINFO wins over the vanilla table, but only for a lump the set has', () => {
    const byMap = new Map([['E1M1', 'D_CUSTOM']]);
    assert.equal(new LevelMusic(bank('D_CUSTOM', 'D_E1M1'), byMap).trackFor('E1M1'), 'D_CUSTOM');
    assert.equal(new LevelMusic(bank('D_E1M1'), byMap).trackFor('E1M1'), 'D_E1M1');
  });

  test("a PWAD map name falls back to the lump named after it, or to no music at all", () => {
    const music = new LevelMusic(bank('D_CANYON'), new Map());
    assert.equal(music.trackFor('CANYON'), 'D_CANYON');
    assert.equal(music.trackFor('GORGE'), null);
  });

  test('the intermission track follows the map-name shape, and a set without one keeps the level track', () => {
    const music = new LevelMusic(bank('D_INTER', 'D_DM2INT'), new Map());
    assert.equal(music.intermissionTrackFor('MAP01'), 'D_DM2INT');
    assert.equal(music.intermissionTrackFor('E1M1'), 'D_INTER');
    assert.equal(new LevelMusic(bank(), new Map()).intermissionTrackFor('E1M1'), null);
  });
});

/**
 * Renders `frames` and hands back both channels plus their RMS. Nothing here pans, so left and
 * right carry the same signal — `stereo` is the test that says so.
 */
function render(chip: OplChip, frames: number): { left: Float32Array; right: Float32Array; rms: number } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  chip.render(left, right, frames);
  return { left, right, rms: Math.sqrt(left.reduce((sum, v) => sum + v * v, 0) / frames) };
}

describe('Music · the synth', () => {
  test('a note is programmed an octave above itself, as DMX does', () => {
    // DMX's own frequency table puts MIDI note 69 (A4) at block 5, F-number 580
    // — 880 Hz, an octave up, which GENMIDI's ×0.5 carrier multiplier halves back.
    assert.deepEqual(blockAndFnum(880), { block: 5, fnum: 580 });
    assert.deepEqual(blockAndFnum(440), { block: 4, fnum: 580 });
    // The F-number stays in the top half of its range, which is where the chip's resolution is.
    for (let note = 12; note < 96; note++) {
      const { fnum, block } = blockAndFnum(880 * Math.pow(2, (note - 69) / 12));
      assert.ok(fnum >= 512 && fnum < 1024, `note ${note}: fnum ${fnum}`);
      assert.ok(block >= 0 && block <= 7, `note ${note}: block ${block}`);
    }
  });

  test('a held note sounds, a released one falls silent, and nothing else makes noise', () => {
    const instruments = new MusicBank(doom1()).genmidi()!;
    const chip = new OplChip();
    const synth = new OplSynth(chip, instruments);
    const frames = Math.round(OPL_RATE / 10);
    assert.equal(render(chip, frames).rms, 0, 'a chip with no notes is silent');

    synth.handle({ time: 0, kind: 'program', channel: 0, program: 30 });
    synth.handle({ time: 0, kind: 'noteOn', channel: 0, note: 60, velocity: 127 });
    const held = render(chip, frames).rms;
    assert.ok(held > 0.01, `a held note sounds, got ${held}`);

    synth.handle({ time: 0, kind: 'noteOff', channel: 0, note: 60 });
    // Long enough for any release to run out — this instrument's is far shorter.
    let after = 0;
    for (let i = 0; i < 20; i++) after = render(chip, frames).rms;
    assert.ok(after < held / 100, 'a released note stops');
  });

  test('the render rate changes nothing about what is heard', () => {
    const instruments = new MusicBank(doom1()).genmidi()!;
    /** Magnitude at `freq`, by Goertzel — the note's own pitch has to survive the rate change. */
    const magnitude = (pcm: Float32Array, freq: number, rate: number) => {
      const w = (2 * Math.PI * freq) / rate;
      let re = 0;
      let im = 0;
      for (let i = 0; i < pcm.length; i++) {
        re += pcm[i] * Math.cos(w * i);
        im += pcm[i] * Math.sin(w * i);
      }
      return Math.hypot(re, im) / pcm.length;
    };
    const played = (rate: number) => {
      const chip = new OplChip(rate);
      const synth = new OplSynth(chip, instruments);
      synth.handle({ time: 0, kind: 'program', channel: 0, program: 0 });
      synth.handle({ time: 0, kind: 'noteOn', channel: 0, note: 69, velocity: 127 });
      // Past the attack, where the note is at its steady pitch.
      const body = render(chip, Math.round(rate / 4)).left.subarray(Math.round(rate / 12));
      const rms = Math.sqrt(body.reduce((sum, v) => sum + v * v, 0) / body.length);
      return { a440: magnitude(body, 440, rate), a220: magnitude(body, 220, rate), rms };
    };
    const chipRate = played(OPL_RATE);
    // A note's pitch is a property of the F-number, so it must not move with the
    // rate the samples happen to come out at — the whole point of rendering at
    // the context's rate rather than the chip's (docs/music.md § The chip).
    for (const rate of [48000, 44100]) {
      const at = played(rate);
      assert.ok(Math.abs(at.a440 - chipRate.a440) < chipRate.a440 * 0.05, `440 Hz at ${rate}: ${at.a440}`);
      assert.ok(at.a220 < at.a440 / 10, `no octave shift at ${rate}: ${at.a220} at 220 Hz`);
      assert.ok(Math.abs(at.rms - chipRate.rms) < chipRate.rms * 0.05, `level at ${rate}: ${at.rms}`);
    }
  });

  test('a percussion note plays the drum bank, and a note outside it plays nothing', () => {
    const instruments = new MusicBank(doom1()).genmidi()!;
    const chip = new OplChip();
    const synth = new OplSynth(chip, instruments);
    const frames = Math.round(OPL_RATE / 20);

    synth.handle({ time: 0, kind: 'noteOn', channel: 9, note: PERCUSSION_FIRST_NOTE, velocity: 127 });
    assert.ok(render(chip, frames).rms > 0.01, 'the bass drum sounds');

    synth.reset();
    synth.handle({ time: 0, kind: 'noteOn', channel: 9, note: 20, velocity: 127 });
    assert.equal(render(chip, frames).rms, 0, 'a note the drum bank has no entry for is dropped');
  });

  test('rendering in chunks is identical to rendering in one pass', () => {
    // `MusicPlayer` renders a chunk at a time and schedules the pieces
    // back-to-back, so the chip's output must not depend on where those calls
    // fall. It did once: an operator's envelope and feedback history only moved
    // on the samples its channel was collected as live, which differs with the
    // block size. docs/music.md § The chip.
    // freedoom2's `D_RUNNIN` and its own `GENMIDI`: a real MIDI-format score,
    // dense enough that a chunk boundary lands mid-envelope many times over.
    const bank = new MusicBank(new Wad([fixtureWad('freedoom_d_runnin.wad')]));
    const song = decodeMidi(bank.get('D_RUNNIN')!.bytes)!;
    const instruments = bank.genmidi()!;
    const rate = 48000;
    const frames = 3 * rate;

    /** Plays `song` into one buffer, rendering at most `block` samples per call. */
    const play = (block: number) => {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      const chip = new OplChip(rate);
      const synth = new OplSynth(chip, instruments);
      let written = 0;
      let time = 0;
      let index = 0;
      while (written < frames && index < song.events.length) {
        const due = song.events[index];
        const samples = Math.round((due.time - time) * rate);
        if (samples <= 0) {
          synth.handle(due);
          index++;
          continue;
        }
        const count = Math.min(frames - written, samples, block);
        chip.render(left.subarray(written, written + count), right.subarray(written, written + count), count);
        written += count;
        time += count / rate;
      }
      return { left, right };
    };

    const whole = play(frames);
    const chunked = play(Math.round(rate / 20));
    // A plain scan, then one assert: a per-sample `assert.equal` builds its message on every
    // passing sample too, 576k times over.
    let differs = -1;
    for (let i = 0; i < frames && differs < 0; i++) {
      if (chunked.left[i] !== whole.left[i] || chunked.right[i] !== whole.right[i]) {
        differs = i;
      }
    }
    assert.equal(differs, -1, `chunked output differs from one-pass output at sample ${differs}`);
  });

  test("channels 6-8 receive their operator writes like any other channel", () => {
    // A bank's operator slots 0x10-0x15 (channels 6-8) cross the address
    // nibble: their writes land at 0x30-0x35, 0x50-0x55, 0x70-0x75, 0x90-0x95,
    // 0xF0-0xF5. Dispatching on the high nibble dropped all of them, leaving a
    // third of the chip permanently silent at its power-up attack rate of 0 —
    // heard as MAP01's hi-hat dying the moment a drum fill pushed it onto
    // channel 6. Identical programming of a low and a high channel must render
    // identically.
    const played = (index: number) => {
      const chip = new OplChip();
      const regs = channelRegisters(index);
      chip.write(0x20 | regs.modulator, 0x01);
      chip.write(0x60 | regs.modulator, 0xf5);
      chip.write(0x80 | regs.modulator, 0x77);
      chip.write(0xe0 | regs.modulator, 0x00);
      chip.write(0x40 | regs.modulator, 0x10);
      chip.write(0x20 | regs.carrier, 0x01);
      chip.write(0x60 | regs.carrier, 0xf5);
      chip.write(0x80 | regs.carrier, 0x77);
      chip.write(0xe0 | regs.carrier, 0x00);
      chip.write(0x40 | regs.carrier, 0x00);
      chip.write(0xc0 | regs.channel, 0x30);
      chip.write(0xa0 | regs.channel, 0x44);
      chip.write(0xb0 | regs.channel, 0x32); // key on, block 4
      return render(chip, Math.round(OPL_RATE / 50));
    };
    const low = played(2);
    const high = played(7);
    assert.ok(low.rms > 0.01, `channel 2 sounds, got ${low.rms}`);
    assert.equal(high.rms, low.rms, 'channel 7 renders identically to channel 2');
    for (let i = 0; i < low.left.length; i++) {
      assert.equal(high.left[i], low.left[i], `sample ${i} differs`);
    }
  });

  test('every channel has register addresses of its own', () => {
    // The chip runs more channels than an OPL3 has (`OPL_CHANNELS`), addressed
    // in further banks of nine. Two channels sharing an address would have one
    // note silently reprogramming another's operators.
    const seen = new Set<number>();
    for (let i = 0; i < OPL_CHANNELS; i++) {
      const regs = channelRegisters(i);
      assert.equal(regs.carrier - regs.modulator, 3, `channel ${i}: the carrier sits three past the modulator`);
      // The channel's own registers live in a different group from its
      // operators', so they are tagged apart before being pooled here.
      for (const address of [regs.channel | 0x1000, regs.modulator, regs.carrier]) {
        assert.ok(!seen.has(address), `channel ${i} reuses register ${address.toString(16)}`);
        seen.add(address);
      }
    }
  });

  test("a released drum's tail rings on while later hits take other channels", () => {
    // Allocation re-keys the *least audible* free channel: a key-off frees the
    // channel while its release envelope still sounds, and key-on cuts whatever
    // rings there — so a run of short hits must not land on the channel a crash
    // is still ringing out on. Both fixed orders failed this audibly on MAP01
    // (docs/music.md § From notes to registers).
    const instruments = new MusicBank(doom1()).genmidi()!;
    const crash = PERCUSSION_FIRST_NOTE + 14; // MIDI note 49, crash cymbal — rings for seconds
    const kick = PERCUSSION_FIRST_NOTE; // 35, bass drum — decays in well under half a second
    const tick = Math.round(OPL_RATE / 140); // one MUS tick, the score's own hit length
    const tail = (withCrash: boolean) => {
      const chip = new OplChip();
      const synth = new OplSynth(chip, instruments);
      if (withCrash) synth.handle({ time: 0, kind: 'noteOn', channel: 9, note: crash, velocity: 127 });
      render(chip, tick);
      if (withCrash) synth.handle({ time: 0, kind: 'noteOff', channel: 9, note: crash });
      // Eight kicks at MAP01's own hit spacing, ~80 ms — under a fixed
      // allocation order one of them re-keys the crash's channel and cuts it.
      for (let hit = 0; hit < 8; hit++) {
        synth.handle({ time: 0, kind: 'noteOn', channel: 9, note: kick, velocity: 127 });
        render(chip, tick);
        synth.handle({ time: 0, kind: 'noteOff', channel: 9, note: kick });
        render(chip, Math.round(OPL_RATE * 0.08));
      }
      render(chip, Math.round(OPL_RATE * 0.7));
      return render(chip, Math.round(OPL_RATE / 10)).rms;
    };
    // 0.7 s after the last kick, the kicks have died away; what remains must be the crash.
    assert.ok(tail(true) > tail(false) * 5, `the crash still rings: ${tail(true)} vs ${tail(false)}`);
  });

  test("a note reclaims the channel its MIDI channel just released, a drum only its own", () => {
    // The reclaim rule: a repeated note or a chord change re-keys the channel
    // its predecessor just released, cutting exactly the tail it supersedes —
    // without it every repeated note doubles briefly against its own ring
    // (MAP01's organ chords and intro chug audibly smeared). On the percussion
    // channel the note must match, so a kick never cuts a cymbal.
    // docs/music.md § From notes to registers.
    const instruments = new MusicBank(doom1()).genmidi()!;
    const chip = new OplChip();
    const synth = new OplSynth(chip, instruments);
    const voices = () =>
      (synth as unknown as { voices: ({ midiChannel: number; note: number } | null)[] }).voices;
    const channelOf = (note: number) => voices().findIndex((v) => v && v.note === note);
    const tick = Math.round(OPL_RATE / 140);

    synth.handle({ time: 0, kind: 'program', channel: 0, program: 18 });
    synth.handle({ time: 0, kind: 'noteOn', channel: 0, note: 64, velocity: 110 });
    const first = channelOf(64);
    render(chip, tick);
    synth.handle({ time: 0, kind: 'noteOff', channel: 0, note: 64 });
    render(chip, tick);
    // The same note re-struck, a tick later, its tail still ringing.
    synth.handle({ time: 0, kind: 'noteOn', channel: 0, note: 64, velocity: 110 });
    assert.equal(channelOf(64), first, 'a repeated note takes its own channel back');
    render(chip, tick);
    synth.handle({ time: 0, kind: 'noteOff', channel: 0, note: 64 });
    render(chip, tick);
    // A chord change: the new note replaces the one this channel just released.
    synth.handle({ time: 0, kind: 'noteOn', channel: 0, note: 66, velocity: 110 });
    assert.equal(channelOf(66), first, "a chord change replaces its predecessor's channel");
    // A drum on channel 9 must not reclaim a melodic channel's release.
    synth.handle({ time: 0, kind: 'noteOff', channel: 0, note: 66 });
    synth.handle({ time: 0, kind: 'noteOn', channel: 9, note: PERCUSSION_FIRST_NOTE, velocity: 110 });
    assert.notEqual(channelOf(PERCUSSION_FIRST_NOTE), first, 'a drum leaves the melodic tail alone');
  });

  test('running out of voices costs the highest MIDI channel, not the melody', () => {
    const instruments = new MusicBank(doom1()).genmidi()!;
    const chip = new OplChip();
    const synth = new OplSynth(chip, instruments);
    // Both single-voice patches; channel 15's releases in a millisecond, so
    // what is left at the end is only what is still held.
    synth.handle({ time: 0, kind: 'program', channel: 0, program: 0 });
    synth.handle({ time: 0, kind: 'program', channel: 15, program: 30 });

    // The melody note first, so age alone would make it the next victim.
    synth.handle({ time: 0, kind: 'noteOn', channel: 0, note: 60, velocity: 127 });
    for (let i = 1; i < OPL_CHANNELS; i++) {
      synth.handle({ time: 0, kind: 'noteOn', channel: 15, note: 36 + i, velocity: 127 });
    }
    // One past capacity: something has to go, and it must not be channel 0's.
    synth.handle({ time: 0, kind: 'noteOn', channel: 15, note: 100, velocity: 127 });

    for (let i = 1; i < OPL_CHANNELS; i++) synth.handle({ time: 0, kind: 'noteOff', channel: 15, note: 36 + i });
    synth.handle({ time: 0, kind: 'noteOff', channel: 15, note: 100 });
    // Long enough for those releases to finish; only a surviving held note sounds.
    render(chip, Math.round(OPL_RATE / 10));
    assert.ok(render(chip, Math.round(OPL_RATE / 10)).rms > 0.005, 'the first note is still playing');
  });

  test('a loud passage leaves the chip past full scale rather than clipped', () => {
    // The chip deliberately does not limit: the volume control comes after it,
    // so a transient clipped here would be clipped however quietly the music is
    // playing — which cost DOOM 2 MAP01's drums up to 5 dB whenever the organ
    // was holding. The bus carries the safety curve instead, after the volume.
    // docs/music.md § Volume.
    const instruments = new MusicBank(doom1()).genmidi()!;
    const chip = new OplChip();
    const synth = new OplSynth(chip, instruments);
    for (let channel = 0; channel < 8; channel++) {
      synth.handle({ time: 0, kind: 'program', channel, program: 30 });
      for (const note of [48, 55]) synth.handle({ time: 0, kind: 'noteOn', channel, note, velocity: 127 });
    }
    const { left, right } = render(chip, Math.round(OPL_RATE / 20));
    let peak = 0;
    for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    assert.ok(peak > 1, `sixteen voices at full velocity should exceed full scale, got ${peak.toFixed(2)}`);
  });

  test('pan puts a channel on one side of the stereo image', () => {
    const instruments = new MusicBank(doom1()).genmidi()!;
    const sides = (pan: number) => {
      const chip = new OplChip();
      const synth = new OplSynth(chip, instruments);
      synth.handle({ time: 0, kind: 'controller', channel: 0, controller: 'pan', value: pan });
      synth.handle({ time: 0, kind: 'noteOn', channel: 0, note: 60, velocity: 127 });
      const { left, right } = render(chip, Math.round(OPL_RATE / 20));
      const energy = (data: Float32Array) => data.reduce((sum, v) => sum + v * v, 0);
      return { left: energy(left), right: energy(right) };
    };
    // MIDI pan is 0 left, 64 centre, 127 right — and the score's left really is
    // the left here, unlike DMX, whose two sides are swapped
    // (docs/music.md § From notes to registers).
    const hardLeft = sides(0);
    assert.ok(hardLeft.left > 0 && hardLeft.right < hardLeft.left / 1e6, 'pan 0 is left');
    const hardRight = sides(127);
    assert.ok(hardRight.right > 0 && hardRight.left < hardRight.right / 1e6, 'pan 127 is right');
    const centre = sides(64);
    assert.ok(centre.left > 0 && centre.left === centre.right, 'pan 64 is centred');

    // The case that matters: E1M1's two guitars ask for 24 and 104, and DMX's
    // three-position gate puts one entirely in each ear — which is heard as the
    // riff losing notes, not as width. Off to one side, but plainly there on
    // the other.
    const guitar = sides(24);
    assert.ok(guitar.left > guitar.right * 2, 'panned to the left');
    assert.ok(guitar.right > guitar.left / 20, 'and still audible on the right');
  });

  test('channel volume and velocity both scale a note, DMX-fashion', () => {
    const instruments = new MusicBank(doom1()).genmidi()!;
    const at = (volume: number, velocity: number) => {
      const chip = new OplChip();
      const synth = new OplSynth(chip, instruments);
      synth.handle({ time: 0, kind: 'controller', channel: 0, controller: 'volume', value: volume });
      synth.handle({ time: 0, kind: 'noteOn', channel: 0, note: 60, velocity });
      return render(chip, Math.round(OPL_RATE / 20)).rms;
    };
    // Volume 0 is the carrier's full 0x3f of attenuation, which is 47 dB down
    // rather than digital silence — the chip's own floor, and DMX's too.
    assert.ok(at(0, 127) < at(127, 127) / 100, 'volume 0 is inaudible');
    assert.ok(at(127, 127) > at(64, 127), 'a louder channel is louder');
    assert.ok(at(127, 127) > at(127, 40), 'a harder-struck note is louder');
  });
});
