# Music

`src/audio/music.ts` and `src/audio/music/` (the chip, the two score decoders, the synth, the
tables), `src/wad/music.ts`, plus the level hooks in `game.ts` and the slider in `ui/menu/menu.ts`.

DOOM's music is not audio data. A `D_*` lump is a **score** — notes, instrument numbers, volumes —
and the sound came out of whatever synthesizer the sound card had. This engine reproduces the one
almost everybody heard: the **OPL2/OPL3 FM chip**, programmed from the WAD's own `GENMIDI`
instrument bank, emulated in `music/opl.ts`. Nothing is shipped alongside it — the instruments come
out of the same IWAD as the levels, exactly as they did in 1993.

Four layers, deliberately separate:

| File | Owns |
|---|---|
| `wad/music.ts` | Finding a `D_*` lump, telling MUS from MIDI from a container, parsing `GENMIDI`. No synthesis. |
| `music/mus.ts`, `music/midi.ts` | Turning a score into `music/defs.ts`'s event stream. No chip, no WAD. |
| `music/synth.ts` | Which chip channel plays what, and every note/volume/bend arithmetic. No Web Audio. |
| `music/opl.ts` | The chip: registers in, samples out. Knows nothing above it. |
| `audio/music.ts` | `MusicPlayer`: which track is playing, the volume, and getting samples to the speakers. |

## Lumps

A track is the lump `S_music[]` names, prefixed with `D_` (`i_sound.c`'s `sprintf(buf, "d_%s", …)`).
`MusicBank` classifies it by magic alone and hands on the bytes:

- **MUS** (`MUS\x1a`) — DMX's compact MIDI variant, what every id-era track is.
- **MIDI** (`MThd`) — a standard MIDI file. freedoom2 ships these, and so do a lot of PWADs; every
  source port reads both, so a WAD in the wild may hold either.
- **A browser container** — Ogg Vorbis, FLAC, MP3 or WAV, handed to `decodeAudioData` untouched,
  the same way `SoundBank` already treats a container-format sound. Music-replacement PWADs built
  in the last decade ship these, and they need none of the machinery below.

**Music replacement comes for free from the merged lump directory** (docs/wad.md § Loading and
merging): a PWAD's `D_RUNNIN` wins on name collision like any other lump — and so does its
`GENMIDI`, which is how a DMXOPL-style instrument-bank replacement takes effect with no code path
of its own.

## Instruments

`GENMIDI` is 175 records of 36 bytes: 128 melodic instruments in General MIDI program order,
followed by 47 percussion entries covering MIDI notes 35-81. Each record carries one or two
**voices**, and a voice is six register bytes per operator plus the channel's feedback/connection
byte and a semitone offset. Those bytes are written to the chip **verbatim** — the lump is
literally a list of OPL register values, which is why `GenMidiOperator` keeps them as the raw
`tremolo`/`attack`/`sustain`/`waveform`/`scale`/`level` bytes rather than unpacking them into
fields nobody would use.

Two flags matter: **fixed pitch** (bit 0), which makes the entry play its own note whatever the
score asked for — every percussion entry sets it — and **two voices** (bit 2), where a second
patch sounds alongside the first, detuned by the record's `fineTuning`. A two-voice instrument
therefore takes **two** of the chip's channels.

A WAD set with no `GENMIDI` (a bare PWAD loaded without an IWAD) can't synthesize anything, and its
MUS/MIDI tracks stay silent — the same way a missing sound lump is silent rather than substituted
(docs/audio.md § Sound lumps).

## The song stream

Both decoders produce the same thing: `MusicEvent[]` at absolute times **in seconds**, plus a
duration. Tempo is resolved while decoding, because it is a property of the file and of nothing
else — MUS runs at a fixed 140 Hz tick, a MIDI file carries a tempo map — and the synth has no use
for either once the times are real.

Controllers are carried **by name**, not by number: MUS and MIDI number them differently, so the
mapping is each decoder's own business and an unknown controller is simply never built.

The whole song is materialized up front rather than streamed, which is what makes looping and
seeking a matter of an index and a clock. A track is a few thousand events.

### MUS

Byte-per-event: a descriptor byte (last-in-group flag, 3-bit type, 4-bit channel), the event's own
one or two bytes, and — when the group ends — a variable-length delay in 140 Hz ticks. Two details
are worth knowing:

- **A note-on may omit its volume**, in which case it keeps whatever that channel last played at.
  That is what makes the format compact, and getting it wrong makes a track play at one volume.
- **MUS's percussion channel is 15, MIDI's is 9**, so the two swap places — the same remap
  `mus2mid` makes, and the reason the swap is a swap rather than a shift.

### MIDI

Standard MIDI files, format 0/1/2 alike: every `MTrk` is read onto the file's own tick clock and
the tracks are merged, then walked once to apply the tempo map. The merge has to come first — a
tempo change lives in track 0 of a format-1 file but governs all of them.

Running status (an event that omits its status byte and reuses the previous one) is the one part
that cannot be skipped past, since it decides how many data bytes follow. A note-on at velocity 0
is a note-off; files rely on it, because that is what makes running status worth using for a run of
notes.

## The chip

`OplChip` is an OPL emulation addressed exactly as the hardware is — register writes with the bank
in the high byte, the way the OPL3 puts its second bank at `0x100`. Everything above it programs
registers, so `GENMIDI`'s bytes reach the chip unmodified.

**It runs 36 two-operator channels, not the OPL3's 18, and that is a deliberate deviation.**
Eighteen is exactly where a busy score starts losing notes: DOOM 2's own tracks peak at 18 —
`D_RUNNIN` sits right on the ceiling with nothing to spare — and the MIDI tracks modern PWADs ship,
written for a synth with no polyphony limit, need up to 29 and lose 8% of their notes at 18.
Freedoom 2's are exactly that. Four banks of nine cover every WAD measured; nothing id shipped can
tell the difference, since none of those tracks ever asks for a 19th voice. It is the same
reasoning as `CHANNELS` = 32 for sfx (docs/audio.md § The mixer model), and it costs nothing —
`render` collects the channels that are actually sounding once per call, so a track pays for the
notes it plays and not for the channels it could have used.

**49716 Hz** (its 3.579545 MHz clock over 72) is the chip's own rate, and it stays the meaning of
an F-number — `blockAndFnum` converts against it — but the output is rendered at the
**`AudioContext`'s** rate instead, which is all `OplChip(sampleRate)` changes: the per-sample phase
and envelope steps carry the chip's timebase into the destination's. Handing Web Audio a buffer at
49716 Hz worked, but the browser then resamples every scheduled chunk *separately*, with its
interpolator starting cold at each buffer edge — a seam several times a second, and a duller mix
either side of it. Rendering at the destination rate removes the resampler from the path
altogether.

The model is a float one rather than a gate-level reproduction: a phase accumulator per operator, a
waveform table per `WS` setting, and every attenuation — envelope, total level, key scaling,
tremolo — in the envelope generator's own units of 1/16 of 1.5 dB, so they add and one table lookup
turns the sum into a gain. Full-scale modulator output shifts the carrier by **four** cycles, which
is what the hardware's 13-bit signed operator output (±4084) added as-is into a 10-bit phase
counter comes to; feedback averages the last two outputs shifted by `9 - FB`, landing at half the
modulation depth for `FB` 7. (An earlier reading dropped the sign bit and halved the modulation
index, which dulled every FM patch.)

**An idle channel costs nothing**: a channel with both operators off is skipped entirely, phases
included, since key-on resets the phase anyway. The live ones are collected at the top of `render`
rather than tested per sample — a silent channel can only come alive through a register write, and
those land between render calls. A whole track's cost is therefore the notes actually sounding —
around 1% of a core in practice, which is what makes the main-thread rendering below reasonable.

**Rendering must be identical however the output is cut into chunks**, since the player renders a
chunk at a time and the chunk length is nobody's musical decision. Two things enforce it, and both
were bugs first: the "live" test is *either* operator rather than only the ones that reach the
output, so a modulator still running under a finished carrier keeps advancing its envelope even
though it adds nothing to the mix; and key-on clears the feedback history along with the phase,
since an operator only writes it on the samples its channel is live for. Pinned by
`tests/audio/music.test.ts` § rendering in chunks is identical to rendering in one pass.

One thing sits after the channel sum, and it is not a register's doing: a one-pole **DC blocker** at
~15 Hz. Half the chip's waveforms are unipolar (`|sin|` and the half and quarter sines) and carry an
offset that spends headroom asymmetrically, which the AC-coupled output stage of every OPL card
removed.

**Nothing is limited here**, and a dense track's output really does leave the chip past full scale
— DOOM 2's `D_RUNNIN` peaks near 1.9. Clipping it at this point would be clipping it ahead of the
volume control, so the same transients would be shaved however quietly the music was playing; the
safety curve lives on the bus instead (§ Volume).

### Envelopes

The four-stage envelope is the chip's: attack approaches full volume exponentially, decay falls
linearly to the sustain level, and release falls linearly to silence. Two details are load-bearing:

- **A non-sustaining operator (`EGT` clear) does not wait for a key-off.** It carries straight on
  from the sustain level at its *release* rate, which is what makes percussion percussive.
- **Rates key-scale off the note.** The 6-bit rate index is `4 * R + ksr`, `ksr` being two bits
  taken from the block and the F-number's top bit — all four when `KSR` is set, the block's top two
  otherwise. High notes therefore decay faster, and a synth that skips this has every bass note
  ringing.

Times come from the YM3812 manual's own figures — 2.8 s down to 0.17 ms of attack, a 39 s to 2.4 ms
sweep for decay and release — halving for every further 4 of the rate index. A rate field of 0
never advances at all: that is the chip's "infinite", not a very slow rate, and an operator keyed on
with an attack rate of 0 stays silent.

## From notes to registers

`OplSynth` is the MIDI side: the chip's 36 channels, a `ChannelState` per MIDI channel, and a
voice per sounding note. It is modelled on Chocolate Doom's `i_oplmusic.c` — see § Fidelity for
why that, and not `linuxdoom-1.10`, is the reference here.

- **Which instrument**: the channel's program, except on MIDI channel 9, where the *note* selects a
  percussion entry. A note outside 35-81 has no entry and is dropped rather than substituted.
- **Which channel**: a key-off frees a channel while its envelope release is still sounding, and
  key-on cuts whatever rings there — so *which* free channel a note takes is audible, not
  bookkeeping, and `allocate` picks in two steps. A note first **reclaims** the channel its own
  MIDI channel released most recently (the same note re-struck, or a chord change replacing its
  predecessor), cutting exactly the tail it supersedes; on the percussion channel the note must
  match too, since there each note is a different drum — a re-struck hi-hat chokes its own ring,
  but a kick must not cut a crash. Anything else takes the **least audible** other free channel: a
  fully silent one outright, else the one whose tail has decayed furthest
  (`OplChip.channelAttenuation`, the synth's one read-back from the chip). Both halves are what
  DMX's *voice pressure* produced on its own: with 18 voices and `D_RUNNIN` holding exactly that
  many, the free list was near empty and the next note re-keyed the just-released channel. The 36
  channels removed the pressure, and every simpler order was audible on MAP01 — lowest-free
  chopped every tail ~80 ms after key-off (the drums went quiet under the organ; 0:16–1:52 leans
  on the 1.8 s open hi-hat and 2.4 s crashes), `i_oplmusic.c`'s FIFO rotation re-keyed
  still-ringing tails about once a second, and least-audible alone let every repeated note double
  briefly against its own 0.1–0.2 s tail (the organ chords and the intro chug smearing). With 36
  channels a score has to be written for an unlimited synth before there is no free channel at
  all. When there isn't, the voice that goes is picked by
  `victimScore` — Chocolate Doom's `ReplaceExistingVoice` rule: a voice only the sustain pedal is
  holding, then the **second voice of a two-voice instrument** (a thickener, not the note), then
  the **highest MIDI channel number**, and only then the oldest. Scores put the lead on a low
  channel and pads above it, so that ordering is what makes a saturated passage thin out instead
  of losing the tune.
- **Which frequency**: the note (or the instrument's fixed note), plus the patch's semitone offset,
  plus the channel's bend at MIDI's default ±2 semitones, plus the second voice's fine tuning —
  and then **an octave up**. That octave is not a bug: DMX's own frequency table puts A4 at 880 Hz,
  because `GENMIDI`'s patches are voiced with the carrier's frequency multiplier at ×0.5, which
  halves it back. `blockAndFnum` then picks the lowest block whose F-number still fits, arriving
  arithmetically at what DMX's 284-entry table stores.
- **Retriggering**: a note-on for a note already sounding on that channel restarts it rather than
  layering a second voice on top.
- **Which side**: the score's pan, as a constant-power position (`OplChip.setPan`), with the OPL3's
  own stereo gates still applied on top so a bank that writes them keeps its meaning. Two
  deliberate departures from DMX here, and the first one matters:

  **The pan value is used as it stands, not quantized to the chip's three positions.** The OPL3 has
  two gate bits per channel and nothing finer, so DMX rounds every pan to hard left, hard right or
  centre. On E1M1 that is not width but damage: its two guitars ask for 24 and 104 of 127, and the
  gate puts one *entirely* in each ear, so each side is left playing a riff full of holes. The
  quantization is a property of the hardware, not of the music, and the chip is emulated anyway.

  **The sides are not swapped.** DMX has them backwards — Chocolate Doom preserves that as a bug
  and undoes it with `opl_stereo_correct`; a score's left-panned instrument comes out on the left
  here, since a reversal is audible only as "wrong side".

### Volume

A voice's level is `SetVoiceVolume`'s arithmetic: note velocity and channel volume each through
`DMX_VOLUME_CURVE`, multiplied together, and subtracted from full attenuation. The instrument's
**own carrier level plays no part** — that is DMX's behavior, not an oversight, and it is why
`GENMIDI`'s carrier `level` field is read only for the additive case. An additive patch's
modulator is held at or below the carrier so it cannot shout over it.

One addition: **expression** (controller 11) is folded into the channel volume. DMX has no such
controller and MUS scores never send one, but the MIDI tracks modern PWADs ship lean on it, and
ignoring it plays their every fade at full blast.

The player's own volume is a **gain node**, not part of that arithmetic — a sibling of the sfx bus
under `master`, so the two sliders are independent (docs/audio.md § Volume and the context). As
with sfx there is no separate mute: 0 stops the track outright rather than rendering a chip nobody
can hear, and coming back up starts it again from the top. The value is persisted as
`musicVolume`, default **0.6 — tuned by feel**, and deliberately under the sfx default of
0.8: a shot or a monster waking has to cut through the track.

**The master slider gates this player too, and only gates it.** `AudioEngine` pushes its value in
through `setMasterVolume`; the gain is the master node's, downstream of this bus, so nothing here
applies it — but silence is silence whichever slider reached it, so `start`/`stopPlayback` test the
two multiplied. Without that, a master of 0 would leave the chip rendering a track nobody can hear,
which is the one thing this player's own 0 exists to prevent. The value is never stored here:
`masterVolume` has one owner.

**The bus' order is volume, then the safety curve** (a `WaveShaperNode`, transparent below 0.7 and
asymptotic above), and that order is the whole reason the curve is here rather than in the chip.
A dense track leaves the chip peaking near twice full scale, almost entirely on drum transients;
shaping those inside the chip took up to 5 dB off every hit *whatever the volume was set to*, and
it was audible as the drums vanishing under DOOM 2 MAP01's sustained organ. After the volume, the
0.6 default leaves `D_RUNNIN` clear of the bend altogether, and even at full volume only 0.001% of
its samples reach it, at a worst cut of 0.13 dB — the transients arrive intact, and the curve is
there for the track dense enough to need it rather than as a tone control.

**Music keeps playing while the game is paused**, as vanilla's does with the menu up:
`AudioEngine.suspend` cuts the sfx voices but deliberately leaves the `AudioContext` running, since
suspending it would freeze the music mid-bar. Nothing raises a sound while paused — the frame loop
is stopped — so there is nothing else to silence.

### What the synth ignores

Two things, each on purpose:

- **Percussion mode** (register 0xBD bits 0-5). DMX never used it: DOOM's drums are ordinary
  melodic voices playing a fixed note out of `GENMIDI`'s percussion half.
- **Aftertouch, bank select, modulation, reverb, chorus, soft pedal.** An OPL voice has nothing to
  apply them to.

One thing is accepted where the hardware would refuse: a 0xC0 write with **neither** stereo bit
set, which an OPL3 plays through no side at all. That is an OPL2-era write predating the bits, so
it plays through both — silence would be the letter of the spec and no use to anyone.

## Which track a level plays

`LevelMusic` (`audio/music.ts`) resolves it — the same resolver shape as `LevelNames` and
`LevelProgression`, so `Game` holds one object and asks one question. Three sources, in order,
each gated on the lump actually existing in the set:

1. **The set's MAPINFO**, if it names a `music` lump for this map (`MapInfo.music`, the same parse
   `LevelNames` and `LevelProgression` read — docs/wad.md § Level names) — how a modern PWAD ships
   its own soundtrack.
2. **Vanilla's own choice**, `S_Start`'s: `mus_runnin + gamemap - 1` for a `MAPxx` level, and
   `mus_e1m1 + (episode - 1) * 9 + map - 1` for `ExMy` — except **episode 4**, which has no music
   of its own and replays nine of the first three episodes' tracks in `spmus[]`'s order.
3. **A lump named after the map itself** (`D_<mapname>`), the convention a PWAD with map names of
   its own follows.

A map matching none of them is simply a level without music. One deviation, and it concerns maps
vanilla never had: a megawad's MAP33+ or a sixth episode runs off the end of the table, which
vanilla reads straight past into whatever follows it in memory; the index wraps instead.

`buildLevel` starts the track **before it builds the map**, so the build has something to play
over, and `play` is a no-op when the level being entered wants the one already running. The cost is
that a build which *throws* leaves the track playing with no `Game` to dispose it, so `startLevel`'s
`catch` in `session/session.ts` stops it — the level that started it never came to exist.

The **intermission** plays `D_INTER` (`D_DM2INT` on a `MAPxx` set — `intermissionMusicFor`,
reading the map-name shape the way `vanillaMusicFor` does), vanilla's own
`S_ChangeMusic(mus_inter)` — and keeps the level's track when the set carries no such lump.

The **end card** takes it one further with `F_StartFinale`'s own change: `D_VICTOR` after a DOOM
episode, `D_READ_M` after DOOM II (`finaleMusicFor`, keyed the same way), again keeping whatever is
playing when the lump is missing. The card is not vanilla's finale (docs/hud.md § End card), but it
is the screen standing in for it, so it takes that screen's music.

A BEX `[MUSIC]` entry redirects which lump a `mus_*` mnemonic resolves to, through
`musicLumpName` — the one place the `D_` prefix is applied, and empty unless a patch said
otherwise. It sits *below* MAPINFO in authority, since MAPINFO names a lump outright rather than
renaming one. A numeric `Music N` record has no effect: it moves a pointer into the exe's own
string table. docs/dehacked.md § Sounds and music.

**Every track in this file is held as a `mus_*` mnemonic and resolved through `musicLumpName`**,
the intermission's and the end card's four included. They were literal `D_*` names once, which
made them the one path a `[MUSIC]` redirect was counted as applying to and then silently ignored
on. Storing the mnemonic is what makes the redirect reach them by construction rather than at
whichever call site remembered to ask.

## Getting it to the speakers

There is no `AudioWorklet`. The chip renders **quarter-second chunks on the main thread**, each
into its own `AudioBuffer` scheduled back-to-back on the music bus, kept a 2.5 s lookahead ahead of
the context clock by a 150 ms timer. The reasons, in order of weight: the chip costs about 1% of a
core against a frame of this renderer, a worklet would need a build step of its own (Vite bundles
no `.ts` worklet module), and the scheduler falls out of the same `currentTime` arithmetic anyway.

The two lengths answer different questions. The **chunk** is a burst of main-thread work — some
2 ms of synthesis for a dense track — so it stays short enough to vanish into a frame; it costs
nothing in quality to keep it short, because the chip renders at the context's rate and
consecutive chunks are sample-exact continuations rather than separately resampled fragments. A
chunk also advances the clock by its own **frame count** (`chunkFrames / sampleRate`), never by
`CHUNK_SECONDS`: the frames decide where the audio really ends, and a rounding error per chunk
would walk the two apart. The **lookahead** is the opposite concern — a queue that runs dry is an
audible dropout, so it covers the longest stall the main thread can have: a level load, a big GC,
or a background tab throttling the timer to one call a second.

Events are applied **at the sample they fall on**, not at chunk boundaries: `renderChunk` renders up
to the next event, applies every event due at that moment, and repeats. Reaching the end of the
song wraps to the start — every DOOM track loops, `I_PlaySong(handle, looping)` — and resets the
synth with it, so a note still held at the last event can't hang across the loop.

A container-format track skips all of this and loops as a plain `AudioBufferSourceNode`.

That main-thread cost is visible: `MusicPlayer.takeRenderMs` hands what it spent to the next frame,
which reports it as the profiler overlay's **`Music`** bar (docs/devmode.md § Profiling overlay). A
chunk is a millisecond or two every quarter second — bursty, so the profiler spreads each report
over the following frames rather than charging it to one, and the bar shows the per-frame average
it really is (that section owns the spreading rule). The bar stays absent entirely for a container
track, which the browser decodes.

## Fidelity

**`linuxdoom-1.10` cannot settle anything in this subsystem**, and that is unusual enough to state
plainly. DOOM's own source calls `I_PlaySong`/`I_SetMusicVolume` into DMX, a proprietary library
that was never released; the DOS binary's behavior is known only through reverse engineering. So the
rules here are cited to **Chocolate Doom's `i_oplmusic.c`**, which is that reverse engineering
written down — the volume curve, the frequency table's octave, the instrument-load order, the voice
allocator. Vanilla's own source still settles the parts that live outside DMX: `S_music[]` and
`S_Start`'s per-map choice (`sounds.c`, `s_sound.c`), and the `d_`/`ds_` lump naming
(`i_sound.c`).

The chip itself is cited to the YM3812/YMF262 documentation — except where the datasheet is
silent: the modulation depth comes from the chip's reverse-engineered data path (Nuked OPL3's
operator-output width), the one figure here credited to an emulator. Where a number is picked by
ear rather than derived — the output scale, the chunk and lookahead lengths — it says so at the
declaration, as everything tuned by feel in this engine does.
