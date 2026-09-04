# Replays

`src/game/replay.ts` (store, player name) over `src/game/replay/` — `defs.ts` (format), `keys.ts`,
`settings.ts`, `recorder.ts`, `playback.ts`; the seam in `game.ts`; the bar in
`ui/hud/replaybar.ts`; the tab in `ui/menu/replays.ts` (docs/menu.md § Replays tab).

A replay is **the level's state at one moment plus one input record per tic**, played back through
the same `Game.tic`. It rests on the fixed 35 Hz simulation (docs/frameloop.md) and the table RNG
(docs/random.md); nothing is transliterated from vanilla's DEMO format, and none of it is readable
by another port.

## The TicInput seam

`Game.tic` reads a `TicInput` (`game/input.ts`), never the concrete `Input`: live play hands it the
`Input`, a recording a `ReplayRecorder` wrapping it, a playback a `ReplayPlayback`. The surface is
`held`, `pressed`, `typed`, `mouseDown`, `rightMousePressed`, `consumeWheel`, `aim`, `endTic`.

**The pointer is never read in a tic.** `aim(camera, planeZ)` answers where the player aims on the
aim plane, in map space, and the pick ray is cast *toward* that point (`TopDownCamera.rayToward`)
rather than through the pointer — so the record is independent of the viewport's aspect, and the
ray a playback casts is the one the recording cast. Two consequences, both deliberate:

- the aim point is quantized to `AIM_QUANTUM` (1/64 unit) before the simulation sees it, always,
  so what is stored is exactly what ran;
- a pointer that misses the plane (above the horizon — unreachable in practice at `MAX_TILT_DEG`)
  picks nothing, where the pointer ray used to be able to lock a monster there.

`aim` is asked at most once per tic, immediately after `applyToCamera(1)` (docs/frameloop.md
§ Posing for the aim ray).

## The record

Per tic, in `ReplayData.tics` as columns: `held` and `pressed` as bit masks over `BOUND_KEYS`
(`replay/keys.ts` — every code the simulation asks for, in a fixed bit order; append, never
reorder; `tests/game/replay-keys.test.ts` pins the table against the tree), `buttons` (fire held,
right-button edge), `wheel` (the sign — `handleSwitching` reads nothing else), `aimX`/`aimY` in
`AIM_QUANTUM` units or null, and the camera pose the tic was read at in `POSE_QUANTUM` units
(§ Camera state). Typed characters ride sparsely in `typed`.

**A snapshot's thing list keeps only what changed**, savegames and keyframes alike — the format is
the savegame's, and docs/savegames.md § The format and its version owns the rule. On MAP15 that is
nothing at all in the opening snapshot and 10 pairs of 333 things after a minute of play.

**The smooth columns are stored as differences** (`packTics`/`unpackTics`, applied at the store
boundary so everything above it reads plain values): the aim point and the pose crawl by a unit or
two a tic, and the differences gzip to about half what the absolute values do. The mask columns
are left alone — differencing measured *worse* on those. The wheel is handed to the
live tic as its sign too, so the recording sees what the playback will.

Around the tics: `snapshots` (`[0]` the start, the rest restore and seek targets), `keyframes`
(§ Seeking), `settings`, `devmode`, `events`, `checks`. `ReplayMeta` carries the WAD set plus the build, the JS engine, the
tic count and the level markers — nothing derivable from another field: the map recording began on
is `levels[0].map` (`replayMap`), and `replayWadSet` is what hands the meta to the savegames' WAD
gate (`wadSetRefusal` and friends) in the `SaveWadSet` shape they take.

**`REPLAY_VERSION` moves with `SAVE_VERSION`.** The record embeds savegame snapshots, so a save
format change is a replay format change; no second version field records it, and
`tests/game/replaystore.test.ts` fails on a bump of either literal alone.

**Floats are not rounded.** The savegames' six-decimal replacer would make snapshot 0 restore a
state the recording never ran; a shortest-roundtrip double reads back bit-identical.

## Camera state

**The camera is an input, not a computation.** It is simulation state — `viewerAngleDeg` is the
movement basis and the camera's position is the pick ray's origin — so a recording stores the pose
each tic was read at (`CameraPose`: orbit, follow point, distance, tilt) and a playback puts the
camera *at* it (`TopDownCamera.setPose`) before the tic runs. Under a playback the camera's own
advance is skipped entirely: neither `AutoCamera.tick` nor `camera.tick` runs, since either would
leave the next tic interpolating out of a pose nothing ever saw.

That is what makes a replay survive a change to how the camera behaves. Retune the auto camera and
an old recording still plays through the framing its player saw, and — because the camera feeds
auto-aim and movement — still plays out the same run. Nothing else about a replay is immune this
way (§ What breaks determinism).

The pose is snapped onto `POSE_QUANTUM` **before the recording's own tic reads it**
(`quantizePose`, then `TopDownCamera.roundPose`), the same rule the aim point follows: what a
replay stores is exactly what ran, with no rounding left between the two. `roundPose` and not
`setPose`: a pose is where the camera *is*, and the targets a Q/E step or a framing key set are
where it is heading. Writing those every tic ends each glide on the tic it started — a 45° orbit
arrives one damped step per press, and a recording's camera turns in stutters.

Nothing else about the camera is stored. The dampers a full `TopDownCamera.snapshot` carries are
only wanted where the camera starts computing again, and there are two such moments, neither of
which needs them from the file: `startRecording` keeps the live snapshot in hand across its own
reload, and a playback **taken over** re-seeds the auto camera where the view already stands
(`AutoCamera.seed`, the same call a level load makes) rather than gliding in from a stale one.
Keeping a second copy of the camera in the file would be one more thing to keep true.

## Settings are frozen per tic

Six persisted settings reach the simulation: autorun, automatic weapon switching, the right
button's binding, the camera mode, infinitely tall actors, pistol start. Each owner has an
`override*(value | null)` beside its setter that pins the module value without writing storage.
`replay/settings.ts` captures all six (`captureSimSettings`) and pins them (`applySimSettings`).

A playback pins them **before every tic**, not once: the menu's setters write the same variables,
and a toggle made during a paused playback would otherwise stand. A recording diffs them at tic
start and writes a change as a `settings` event, so a change made in the menu is stamped "apply
before tic k". `releaseSimSettings` puts the stored values back when a playback ends.

## Restore events

`R` while dead reloads the level from a snapshot the replay does not otherwise hold, and one of
its three routes lands asynchronously (docs/death.md § Player death). Every route ends in
`Game.reloadLevel`, which tells the recorder *what* was restored (the snapshot, or null for a
fresh reload with a fresh inventory) at the tic count it lands on: **an event at tic k is applied
before tic k**. All three routes land between tics, a parked load included.

In a playback `restart` is a no-op and `replayBeginTic` performs the event's reload synchronously,
through `loadMapByIndex` directly — never `loadLevel`, which may park a load. Level exits are not
events: they follow from the input deterministically.

## Recording

`Game.startRecording` captures the moment like a save (`captureSave`), then **reloads the level
from that capture** — so the run being recorded is exactly what a playback restores, dropped
transients and all, and a mid-level start costs no guessing about which of them matter. The reload
builds a fresh camera and a fresh `AutoCamera`, so both are put back over it
(`TopDownCamera.snapshot`/`restore`, `AutoCamera.snapshot`/`restore`): this is the one place either
snapshot is still used, and without it pressing Record mid-glide would hop the framing under the
player. Nothing is stored — the recorded run carries its camera per tic (§ Camera state). Refused (`recordingRefusal`) during a playback, while already recording,
with a cheat code half typed (no snapshot holds the buffer), and at every moment a save is refused
(`Game.blockedMoment` — the one list of moments, said in each caller's own words, so a player who
pressed Record is told about recording rather than about saving).

Started by the New Game tab's "Record a replay" (`Selection.record`, right after construction and
before the first tic) or the pause menu's "Record from here". Ended by "Stop recording", or by the
session — a new start, the campaign's end — which stores whatever was still recording before the
`Game` is disposed (`main.ts: storeRecording`). Each restore event that targets a new snapshot
embeds it whole; the same snapshot restored twice is stored once.

An unnamed recording is named as an unnamed save is — the map's WAD without its extension, then
the map (`DOOM2 MAP01`), from `defaultName` in `game/savegames.ts`
(docs/savegames.md § Naming).

A stored replay is credited to `playerName` (`game/replay.ts`), which is **whatever a replay row's
Player field was last filled in with** — entered once on a recording, inherited by every later one.
Blank is not remembered: clearing one row's credit drops that row's, not the persisted name. No
setting writes it — the Settings tab has no player-name field.

**A running recording shows a red light in two places**: beside the level clock in the HUD
(`#hud-recording`, docs/hud.md § The HUD) and on the menu's Replays tab
(`#menu .tab.recording`, set by `ReplaysUi.refreshRecordButton`, docs/menu.md § Replays tab). Two,
because the menu covers the HUD: opening it must not hide the one fact the tab is about, and the
tab carries it from every tab rather than only from the Replays panel. Both pulse on the same
cadence and neither shows during a playback.

Every `CHECK_INTERVAL` tics the recorder samples the player's position and the P_Random cursor.

## Playback

`GameOptions.playback`: the level is built from snapshot 0 as a restore, then the camera and the
settings are applied. `handleHotkeys` takes the record's own `devmode`, so a recording that jumped
levels with `N`/`P` jumps on any build — and one made without dev mode never jumps on a build that
has it.

**A replay claims no best time and accuses nobody.** `recordCompletion` returns null outright while
one is playing, so nothing is written and no record line is drawn — the intermission shows the
recording player's own time and stats like any other. `cheated` is *not* forced on:
snapshot 0 carries the recording's own value and a cheat typed in the record flips it exactly as it
did when recorded, so the "you cheated" screen appears when that player cheated and not merely
because this is a replay (docs/hud.md § Best times).

The frame loop banks `rawDt × speed`, and nothing while the bar's pause is on or the stream is
spent; both draw at alpha 1 like a popup. The bar's pause is not the menu's — the frame keeps
running so the bar stays live; ESC still pauses the game as always. `MAX_TICS_PER_FRAME` caps
the speed a slow frame can reach (about 4.3× under a 30 fps cap) — not raised.

Before each tic `replayBeginTic` applies the due events, pins the settings and compares the
recording's check sample; the first disagreement is `desyncedAt`, shown by the bar, and playback
continues. The stream's end freezes the level at its last tic.

**A playback answers none of the popups' keys**, so neither offers one: a death during one raises
the overlay with its killer line and no `R` hint (docs/death.md § Player death), and the
intermission and end card drop "Press SPACE to continue" (docs/hud.md § Intermission) — those keys
belong to the record's input, while the viewer's `Space` pauses the playback. **Taking over puts
all three back** (`Game.takeOver`, through each popup's own setter): the keys are the viewer's from
that moment, and a popup already on screen does not redraw itself. DEVMODE's status text says `replay camera: recording`/`manual` for
the same reason — the auto camera is not driving, so its dials would be a frozen readout
(docs/menu.md § Dev mode).

**The simulation keeps a camera of its own** (`Game.simCamera`, the viewport's outside a replay).
The camera is simulation state — `viewerAngleDeg` is the movement basis and the camera's position
is the pick ray's origin — so a viewer moving the camera would change what auto-aim locks onto.
A playback therefore evolves a private `TopDownCamera` from the record and `syncViewCamera` brings
the drawn one up to it each tic: mirrored outright in the **recording** view, and in the **manual**
one driven by the viewer's own Q/E orbit and framing keys (`applyFramingKeys`, whatever camera mode
the replay was recorded under) around the same follow point and aim lead. Nothing in the manual
path reaches the simulation, so looking around cannot desync a run. A level load re-seeds the
viewer's camera from the simulation's; a teleport snaps both without touching a manual zoom; and
taking over hands the simulation back to the viewport's camera at the pose being drawn.

**`Space` pauses and resumes a playback**, and so does a press on the level itself — the canvas
only, since the bar, the menu and the overlays over a replay have their own controls. Either way
`#replay-flash` swells the glyph for the state the press put the playback *into* and fades: a press
on the level lights up no button, and a paused frame otherwise looks like a still one. **The arrow
keys skip `SKIP_SECONDS` either way**, counted from where the playback is already heading, so a
second press adds to the first instead of measuring from a cursor mid-catch-up. All of it is off
while the menu is up (`ReplayBar.setKeysActive`, driven by `Game.pause`/`resume`), so a key meant
for the menu does not reach the bar behind it; a replay's own keys belong to the record, these to
the viewer. Once the stream is spent, `Space` and the pause button **start the replay over** (a
seek to tic 0): there is nothing left to pause, and the run is right there to watch again.

The bar (`#replay-bar`, `--z-replaybar`): a track with one marker per level advanced into; on
hover the pause, the speed steps (`SPEED_STEPS`, 0.25×–5×), the crosshair and camera toggles, and **Take
over** (`Game.takeOver`): live input from the next tic, the settings released, `cheated`
set **for that level** — the run up to that point was not this player's, but the next level
entered through an exit is (docs/hud.md § Best times) — and **a savegame written on the way
in** (`GameOptions.autoSave`, named after the replay and the level clock). That save is the reason there
is no separate "save here" button: a player who wants this moment takes it over and has it. It also
moves `savedState`, so `R` after a death returns to the take-over point rather than to the replay's
last restore. The outcome goes to the center message, not the bar, which is gone by then; a moment
the capture refuses (an intermission, a corpse) says so there and stops nothing else.

The reticle is drawn where the recording aimed, projected through the interpolated camera each
frame; the pointer keeps the ordinary arrow meanwhile (`Crosshair.detach`), since the bar's
controls are clicked with it. **The aim point is interpolated between the last two tics'**
(`ReplayPlayback.aimAt`, at the frame's own `alpha` — the one every sprite is drawn at): the record
holds one point per tic, and a reticle stepping 35 times a second under a camera moving at the
refresh rate reads as stutter. The camera's aim lead still takes the tic's own `lastAim`, being a
per-tic reader. It is drawn at **half opacity**: it is where someone else aimed, not
where the viewer is pointing. The panel's **Crosshair** toggle takes it away entirely — named for
the state in force like the camera toggle beside it, marked while off so a missing reticle reads as
switched off rather than as a replay that aimed nowhere. It lasts the session, not the replay.

## Storage

Database `topdoom-replays`, over `savestore.ts`'s backend parameterized by database name and store
prefix — the same meta/bytes split as the saves, in a separate database like the WAD library's
(docs/savegames.md § Storage). `listReplays` reads metas alone; a damaged row lists, deletes and
downloads but does not play. Each entry carries a `refusal`, null when the row is playable and
otherwise the sentence `readReplay` would have thrown (the saves list does the same —
docs/menu.md § Save and Load tabs) — the format version (which covers the
savegame version with it), or a meta too damaged to read. The list prints it in red beside the row
and greys Play, so a row that cannot be played says why without being clicked.

`exportReplay` writes `<name>.topdoomreplay.json` (`replayFileName`, over the saves'
`downloadFileName` — docs/savegames.md § Download and import): the meta in the clear, `data` as the stored
gzip bytes base64'd; `importReplay` re-validates everything and stores under a fresh ID. The menu
routes a dropped file by that suffix, ahead of the `.json` save rule.

`node scripts/inspect-replay.ts <file>` reads such a download headlessly — meta, WAD roles, level
markers, the decoded record's settings, events and check samples, and a per-key input summary, plus
`--tics a-b` for a decoded tic range and `--data`/`--state` dumps.

## What breaks determinism

- **Another JavaScript engine.** `Math.sin`/`cos`/`atan2`/`exp`/`log` are implementation-
  approximated (docs/random.md § What this does not buy). The meta records the engine; the bar
  notes a mismatch and the check samples say where it diverged.
- **A changed simulation**, which is `COMPAT`'s whole job (§ Compatibility). The *build* number is
  not that signal and is never noted on the bar: every replay kept across a release was recorded on
  another build, and almost none of those releases moved a tic. The camera is carved out of the
  epoch too — its pose is recorded per tic (§ Camera state), so changing how the camera behaves
  moves no old recording.
- **`DEVMODE`** — covered by the recorded flag.
- A recording started while a cheat is half typed — refused.

## Compatibility

**`COMPAT` (`replay/defs.ts`) is the simulation epoch: one integer, bumped whenever a change to
what a tic does could make an old recording run differently.** Movement, collision, the specials
tables, `mobjinfo`, weapon rates and damage, monster AI, and who draws from the random table in what
order. **Not** bumped for a release, for rendering, for the HUD or for the menu — none of those
reach the tic — and not for the camera, whose pose is recorded rather than recomputed.

It is deliberately *not* `REPLAY_VERSION` and not `VERSION`:

| | asks | on a mismatch |
|---|---|---|
| `REPLAY_VERSION` | can this build **read** the file? | refuses to play, with `versionRefusal` |
| `COMPAT` | did this build's **simulation** record it? | plays, and warns it may desync |
| `build` (`VERSION`) | which release wrote it? | nothing — it is provenance, shown on the row |

`compatDrift(compat)` is the one comparison: `null` when the epochs agree, `'older'`/`'newer'`
otherwise — **not** "older than ours", since a replay from a later epoch (a file from a newer build,
this build rolled back) is equally suspect. `0` is a replay written before the field existed, which
is older than every epoch. The warning reads "older game rules — may desync" on the bar and
"Recorded under older game rules — it may desync." in amber in the Replays panel, amber because it
is a risk rather than a refusal. **`desyncedAt` remains the only verdict**: the epoch says a run
*may* have diverged, the check samples say whether it did and where (§ The record).

Two limits worth knowing. The bump is a **discipline** — nothing detects that a tic's behaviour
moved, so a forgotten bump leaves a replay claiming an epoch it did not run under, and only the
check samples catch it. And the epoch is **coarse**: a fix to one monster's homing flags every
replay of that epoch, including runs that never met one. Closing the first would take a golden
replay replayed in CI, which needs a headless simulation harness this engine does not have —
`Game` wants a viewport.

## Seeking

The track is the control: click or drag it, and the jump lands on release (seeking on every
pointer move would reload and re-run the level under the pointer). Hovering it marks where a jump
would land and names that moment's clock (`#replay-scrub`, `#replay-hover`, over the panel rather
than above the bar, which would move the HUD for a hover); a drag keeps the mark while the pointer
wanders off the track's few pixels.

A recording lays down a **keyframe** every `KEYFRAME_INTERVAL` tics — the world as a savegame holds
it, and the map it belongs to. No camera: the pose of the tic being landed on is already in the tic
columns (§ Camera state), and a jump snaps both cameras to it. `ReplayData.keyframes[0]` is the
recording's own start, which is what a playback builds its level from. A keyframe is only taken where the moment allows a capture at all (`saveRefusal`, and no
cheat half typed); a refused one waits for the next tic rather than being skipped, so the anchors
drift later but never go missing.

`Game.seekTo` restores the last keyframe at or before the target and then **runs the tics** from
there — a jump that stays ahead of the current position and passes no keyframe skips the reload and
runs on from where it is. The catch-up is spent `SEEK_BUDGET_MS` per frame (`advanceSeek`), so the
page still answers a click between slices; sound is off while it runs (`AudioEngine.setSilent`), or
a minute of fighting would arrive at once. A level swap ends the slice, so the next frame starts
clean on the new map.

**The damage flash is dropped where the jump lands** (`ScreenEffects.clearPain`), for the same
reason the sound is off: every hit the catch-up passed through added to it and nothing decayed it —
no frame was drawn — so the frame the jump lands on would open at full red over a fight the viewer
never saw. A hit taken after the landing flashes normally.

**The picture stands still until the target lands.** A catching-up frame draws nothing, so the last
frame before the jump stays on screen and `#replay-seek` pulses a double triangle over it, pointing
the way `ReplayPlayback.seekBack` says the viewer asked to go — not the way the tics run, which is
always forwards. Only the bar updates. Drawing the catch-up instead ran the level at several times
speed under a camera that only moves once the seek ends, which reads as a bug. Two details of the
marker are load-bearing: it pulses on `opacity`/`transform` alone, which the compositor animates
while the main thread grinds tics, and the keyframe restore waits one frame (`Game.seekAnchor`) so
the marker is painted before a level build blocks the page for as long as any map load.

What a jump has to put back beyond the snapshot: both cameras (`snapPose`, from the landing tic's
own recorded pose), `cheated` (the record's own verdict — a seek past a recorded cheat has to
arrive with it), the
pinned settings, and the playback's own forward-only cursors — `ReplayPlayback.seek` re-seats the
event and check indices and replays the settings events up to the target. A seek that re-anchors
clears `desyncedAt`: the state is the record's own again, so what had drifted before it is gone.

The cost is the interval. A jump of a minute of recording is a few frames of catch-up on an
ordinary level, and a level swap inside the span adds a map build. Keyframes cost about 4 kB
gzipped each, nearly all of it the snapshot.
