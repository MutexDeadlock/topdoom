# Session lifecycle and the loading screen

`src/main.ts`, `src/ui/loading.ts` + `loading.html` + `loading.css`, `src/game.ts`

What `boot()` builds once for the whole page, and what every level start tears down and replaces.
The frame loop inside a running `Game` is docs/frameloop.md; the menu that starts one is
docs/menu.md.

## Session lifecycle (`main.ts`)

`boot()` creates everything that must outlive a level exactly once — `Viewport` (one WebGL context
and one canvas for the whole page), `AudioEngine` (one `AudioContext`), the `Menu`, and the `ESC`
listener — and holds a single mutable `game: Game | null`. A `Game` is per-WAD-set/per-level and is
built to be thrown away and replaced.

Rules that hold this together:

- **The page boots showing `#loading`, not the HUD.** Every other overlay is in the markup already
  `hidden`; the boot screen (`ui/loading.html`) is the one that starts visible, because the static
  HUD markup would otherwise be what the player sees — placeholder `100` health over an empty
  level — for as long as the WAD manifest takes. `boot` takes it down once whatever replaces it is
  up: the menu, or a `?map=` level, which is why that branch **awaits** `menu.submit()` — the deep
  link never opens the menu, so the same overlay covers its WAD load, and `startLevel` has already
  raised and lowered it by the time `boot` calls `hide` (§ The loading screen). The failure path
  needs no call of its own: `#fatal-error` is a rung above `#loading`. The launcher branch also
  brings the welcome popup up over the menu (docs/menu.md § Welcome popup).
- **`new Viewport` is wrapped in `try`/`catch`** and routed to `#fatal-error`: three.js throws a raw
  `Error` when the browser can't create a WebGL2 context, and without this the page is left sitting
  on `Loading …` forever, which reads as "hung" rather than "your browser can't run this". The
  GPU-specific message is only shown when the error actually looks like a WebGL failure, so an
  unrelated bug isn't misreported as a GPU problem.
- **A finished campaign ends the session.** `Game` takes an `onCampaignEnd` port beside its
  checkpoint store, called when the end card's continue key has nowhere left to go (docs/hud.md
  § End card). The handler nulls `game` *before* disposing it — the call arrives from inside that
  very `Game`'s tic — and reopens the menu with `open(false)`, as a launcher: there is no returning
  to a run that is over.
- **`audio.resume()` runs synchronously before `startLevel`'s first `await`**, while still inside
  the click handler — the only moment a browser reliably lets an `AudioContext` start. A `?map=`
  deep link never gets that click, so `boot` also arms one-shot `pointerdown`/`keydown` unlockers.
- **The `game` slot is cleared before the old level is disposed.** A `Game` constructor that throws
  (a WAD with no maps, a mesh build failure) would otherwise leave `game` pointing at a *disposed*
  instance, and both "Return to game" and the `ESC` handler key off it being non-null — resuming it
  restarts a render loop over released GPU resources. On failure the menu stays open, shows the
  error, and is re-synced with `open(game !== null)` so it stops offering a return.
- **"Return to game" is disabled for the duration of a start** (`startWithSkill`), since the level
  it would return to is disposed part-way through.
- **A replay is the same `startLevel` too**, given the replay as a third argument: its WAD set is
  resolved by `playReplay` exactly as `loadSave` resolves a save's, and `Game` gets snapshot 0 as
  `restore` plus the replay as `playback` (docs/replays.md § Playback). Every teardown of a `Game`
  stores whatever it was still recording first (`storeRecording`), so a recording survives the
  level start or campaign end that ends it.
- **A load is the same `startLevel`**, given the save as a second argument: it verifies the
  assembled set's game WAD and map provider against the save's own IDs (`verifySaveWads`, over
  `wadSetRefusal` — docs/savegames.md § WAD-set identity) and hands `Game` the snapshot instead of
  `?pos=`. Everything above — the audio gesture, the dispose ordering, the failure re-sync — is one
  copy, so a lifecycle fix can't reach the new-game path and miss the load path. `loadSave` only
  re-resolves each `wads` entry to a `WadSource` by content ID first, and a *required* file the
  library can't supply fails *there*, before anything is torn down, so the running level survives a
  load that can't happen; an add-on that supplied neither the map nor the game WAD is left out of
  the set instead.
- A second `Game` builds against the *same* static DOM, so anything holding generated children must
  replace rather than append, and per-level screen state must be cleared — see docs/hud.md
  § The HUD and docs/hud.md § Screen effects. `dispose` clears the center message, the level card
  and the intermission popup for that reason: all three are static markup that outlives the `Game`
  that raised them.
- `ESC` works during the intermission popup too. `pause()`/`stillFrame` keep drawing, the menu sits
  over the popup, and `resume()`'s `input.reset()` drops the keypress that would otherwise dismiss
  it the moment the game comes back.

## The loading screen

`#loading` (`ui/loading.ts`) is one overlay with two jobs: the boot screen that is up from the first
paint, and what covers every level load after it. It sits at `--z-loading`, above the menu, so
starting a game covers the menu rather than closing it first.

**Starting a game shows the download, not a spinner.** `startLevel` puts the overlay up and feeds it
`loadWadFiles`' aggregate progress — bytes arrived over bytes expected, across the whole selected
set at once, because several files download in parallel and one bar is what the player can read. The
total comes from each source's manifest `size`, so it is known before the first byte and never
moves. Two consequences worth knowing:

- **A source already in memory reports nothing and is left out of the total.** Restarting the same
  WAD set is served from `serverSource`'s memo, so the bar never appears rather than flashing to
  100%.
- **Only a download streams.** `bytes()` reads the body in chunks only when a progress callback is
  given; without one it stays on `res.arrayBuffer()`, which saves reassembling up to 28 MB.

The bar covers the WAD set alone. `topdoom.wad` (docs/wad.md § The WAD the engine ships) loads in
the same `Promise.all` and is not counted — 651 KB against a 14 MB IWAD would only make the number
lie in the other direction.

**A level load shows nothing unless it is predicted to be slow.** `Game.loadLevel` is the one
decision point — an exit, `R` after death, a checkpoint reload and the DEVMODE map jump all go
through it — and it estimates the build from the map's `LINEDEFS` lump size (`mapLinedefBytes`, a
directory lookup; a UDMF map's `TEXTMAP` size scaled to the same unit) times `buildMsPerKb`. Only
above `SLOW_LOAD_MS` does the overlay go up. An ordinary level change is a few frames, and an
overlay up that briefly is a flicker, not feedback.

**The estimate exists because the build cannot be interrupted.** `loadMapByIndex` is one synchronous
block, so nothing paints while it runs and a "show it if it takes long" timer would fire into a
frozen main thread. The decision therefore has to be made *before* the build, from what is cheap to
know. Four rules follow:

- **The load is parked, not awaited.** `pendingLoad` holds the caller's own body as a thunk; the tic
  ends, the browser paints, and the next `frame` runs it. Merely awaiting would let the loop keep
  simulating tics into a level about to be replaced. `main.ts` has no loop of its own yet, so its
  own first load uses `LoadingScreen.painted` instead — the same "let it paint first" rule, one
  frame at a time rather than one load.
- **That frame runs ahead of the FPS cap**, or a capped frame would skip it and leave the overlay up
  for nothing.
- **It resyncs the frame clock afterwards** (`resyncClock`, shared with `resume`): build time is not
  simulation time, and `accumulator` must not pay it back as a burst of tics.
- **`pause` flushes a parked load** rather than leaving the overlay — which outranks the menu —
  covering the screen the pause exists to show.

`buildMsPerKb` is re-measured from every build, so after the first level the prediction is the
player's own machine rather than the one `BUILD_MS_PER_KB` was measured on.
