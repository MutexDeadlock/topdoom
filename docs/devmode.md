# Dev mode, the status text and the profiling overlay

`src/constants.ts: DEVMODE`, `src/ui/hud/debug.ts`, `src/ui/hud/profiler.ts`,
`src/util/profiler.ts`, `src/render/gputimer.ts`

The three diagnostics drawn over a running level — the fps counter, the debug block behind it and
the profiling overlay — each its own checkbox under Settings → General → `Debug / Dev`
(docs/menu.md § Settings tab).

## Dev mode (`DEVMODE`)

`DEVMODE` reads `import.meta.env.VITE_DEVMODE`, defaulting to `false`; set `VITE_DEVMODE=true` in a
git-ignored `.env.local` at the repo root to turn it on (Vite loads `.env.local` itself, no plugin
needed).

**It gates nothing, and that is the whole of it.** It is the *default* of those three checkboxes —
a dev build opens with all three on, a shipped one with none — and a stored choice overrides it
either way, so every diagnostic here is reachable in any build. No key, no cheat and no game
behavior is behind it: jumping to another map is IDCLEV (docs/cheats.md § IDCLEV), and the camera's
`+`/`-` and `[`/`]` are player-facing framing controls, held for every build beside the camera mode
they read (docs/camera.md § Auto camera).

## FPS counter

`#hud`, top-left, carries two independent settings: **`Show FPS counter`**, the `N fps` figure, and
**`Show debug infos`**, the block behind it — map, triangles, awake monsters, position, sector,
sound channels, camera. Either one alone keeps the element up, and with the counter off the debug
block simply omits its figure (`Presenter.debugLines` takes `fps: number | null`).

Both are `debug.ts`'s own (`fps`, `getFpsVisible`/`setFpsVisible`; `debuginfo`,
`getDebugInfo`/`setDebugInfo`), both **default to `DEVMODE`**, and both are memoized: `DebugHud.update`
asks each every frame. That is the rule the profiling overlay follows too, and for the same reason:
all three are diagnostics a player may want and none should be on top of a shipped game unasked.

`applyHudVisible` is the single writer of `#hud`'s `visible` class and reads both settings, called by
`DebugHud`'s constructor to seed it for the level starting and by either checkbox to change it live;
debug.css shows the element by that same class, and **`DebugHud.update` early-returns on it**, so
a hidden text costs no per-frame DOM write and never runs the `details` closure. The frame
*counting* ahead of that return is not gated — three arithmetic operations, and skipping them would
make a counter switched on mid-level read a rate built from its first half second.

**Everything the block prints is live state.** Its last line is the auto camera's own readout —
`AutoCamera.readout` in `game/autocamera.ts`, which owns the smoothed state it prints rather than
exposing it to `game.ts` (docs/camera.md § Auto camera), and reads `manual` in the other camera
mode. Under a playback it reads `replay camera: recording`/`manual` instead: the camera comes from
the record there, so the auto camera's dials stand still and printing them would be a readout of
nothing (docs/replays.md § Playback). The block used to end with two static hotkey hint lines as
well, which were the game's only controls reference and so invisible to exactly the players who
needed them; that list is now the menu's Settings tab (docs/menu.md § Settings tab).

`Presenter.debugLines` reports `ThingLayer.awakeMonsterCount()` — the number of living monsters
currently alerted (chasing/attacking, or mid-`reactionTicks` delay) — useful for judging whether a
level's population has actually noticed the player. Its sound-channel line is
`AudioEngine.channelUsage` — voices in flight over the pool size (`CHANNELS`, docs/audio.md § The
mixer model) — which is how you see a scene running the pool dry and cutting sounds off. The count
beside it is how many copies the same-tic start budget has turned away since the level loaded
(docs/audio.md § Same-tic bursts): it climbing while the pool sits half empty is the burst rule
working, not a scene in trouble.

## Profiling overlay

A panel of its own, top-right, breaks a frame's cost down by category — `Specials`, `Player`,
`Weapons`, `Fog of War`, `Monsters`, `Effects`, `Fading`, `Render`, `Music`, plus an `Other` bucket
for whatever wasn't explicitly measured (input handling, HUD text, the player sprite's own pose) —
so a slow frame can be traced to *which* system is responsible rather than just how many fps it
costs.

**Every row is CPU; the GPU gets one number of its own.** The rows and their total time main-thread
wall clock between `beginFrame()` and `endFrame()`, both inside the same `requestAnimationFrame`
callback — which cannot see the GPU, whose work finishes long after that callback returns. That is
why the total says `cpu`, and why the overlay carries a second line. The two bracket the category
rows — `cpu` above them, since they add up to it, and `gpu` below, since it is a separate number:

```
cpu 4.5 ms  (220 fps eq.)
Render   [====      ]  3.10
Monsters [=         ]  0.80
...
gpu 20.1 ms  (49 fps eq.)
```

That layout is `profiler.html`'s, not the class's: the panel ships the two total lines and the
`#profiler-rows` container between them as static markup, and `ProfilerHud` only fills them in — so
moving a line is an edit to the markup rather than to append order in `update()`.

**The two are concurrent, not cumulative — the larger one is what sets the frame rate.** A frame
like the one above is GPU-bound, and no amount of work on any row above it will help; docs/render.md
§ What a frame costs is where to take the GPU side apart. Without this line the CPU total reads as a
frame rate and a GPU-bound scene looks like a four-figure "fps eq." next to a HUD counter saying 50,
which is exactly the report this was added for.

`GpuTimer` (`render/gputimer.ts`) is where that number comes from: one `TIME_ELAPSED_EXT` query
around `renderer.render`, through `EXT_disjoint_timer_query_webgl2`. Four things about it:

- **It reads back late.** A query's result lands a frame or two after the frame it measured, so the
  timer keeps a small pool of them in flight and claims each when the driver has it. The pool is
  capped, which is what stops a driver that never answers from queueing one query per frame for the
  rest of the session.
- **A full pool must never be the end of it.** `end` collects finished results **whether or not
  this frame opened a query of its own**, and a pool that stays full for `STALL_FRAMES` is given up
  on and reused. Both exist because a frame opens no query exactly when the pool is already full:
  collecting only alongside a query of the frame's own deadlocks the timer at the first stall long
  enough to fill it, and the reading then stands unchanged for the rest of the session. A resize
  with the bloom chain on is the case that reaches it — the scene target and the whole blur pyramid
  are reallocated in one frame (docs/lights.md § Bloom).
- **A *disjoint* drops the whole batch.** The GPU having been reset invalidates every query in
  flight, not one of them, and reading the flag is what clears it — so it is read once per harvest
  and every result in that pass is discarded when it is set.
- **`gpu n/a` is an ordinary outcome, not a failure.** Browsers have disabled the extension on and
  off for side-channel reasons and some drivers lack it outright, so the overlay says so rather
  than showing a zero that would read as "the GPU is free".
- **It only runs while the overlay is up.** A timer query is cheap but not free, and nothing reads
  the answer otherwise — `game.ts` skips `begin`/`end` entirely when the panel is hidden.

`FrameProfiler` (`util/profiler.ts`) is a plain per-frame timer, not tied to rendering or game
state: `beginFrame()`, any number of `time(label, fn)`/`add(label, ms)` calls (the same label can be
used more than once per frame — `game.ts`'s "Player" bucket covers both the movement block and the
later pickup/damage-floor block, non-contiguous in `frame()` — and accumulates), then `endFrame()`.

**`Music` is the one category measured outside the frame**, because the music synth renders on its
own timer in the gaps between frames (docs/music.md § Getting it to the speakers). `MusicPlayer`
accumulates what it spent and the next frame hands it over with `offFrame(label, ms)`, which counts
it towards the frame total as well as its own label — otherwise a category that never ran inside
`beginFrame`/`endFrame` would be silently subtracted from `Other`. It only appears once a track is
actually being synthesized: a container-format track costs nothing here, and `offFrame` registers no
label for a zero.

Because that work arrives in **bursts** — a chunk every pump interval, a whole lookahead at track
start — `offFrame` pools it and `endFrame` charges the pool a fraction per frame
(`OFF_FRAME_SPREAD`) instead of dumping each burst on the frame that follows it. Dumped, every burst
spiked the total, and the header's "fps eq." — which divides by that total — visibly lurched with
each one and cratered at every track start. The pool is also capped (`OFF_FRAME_PENDING_CAP`): live
play never accrues more than a pump interval's chunks between two frames, so anything bigger is a
stall's backlog — a tab hidden without the menu open keeps the synth timer running with no frame to
drain it — and is dropped the way the frame loop drops its accumulator debt, not replayed against
frames that didn't do the work. The pause path separately discards what accumulated behind the menu
(`Game.resume`), so the first frame back isn't charged for it at all.

Every label is smoothed with a plain exponential moving average rather than shown raw, the same
reasoning as `util/damping.ts`'s `dampen`: a single frame's timing is noisy (GC pauses, OS
scheduling), and an unsmoothed bar graph would flicker faster than it could be read.

**Measurement itself is not gated** — `performance.now()` calls are cheap enough not to bother
branching around, the same call the fps counter already makes. The `visible` class is the only skip,
and `ProfilerHud.update` takes the `FrameProfiler` rather than its `samples()` so that a hidden
panel does not build the array and its per-label objects every frame — which is the default outside
dev mode. `Presenter.debugLines` is a closure for the same shape of reason: its body walks the
BSP for the player's sector and must not run when the *debug* text is off.

**The checkbox alone decides whether the panel is up** — General's `Debug / Dev` section
(`#profiler-checkbox`), in every build, since the overlay covers the top-right corner of the level.
The setting is `profiler.ts`'s own (`profiler`,
`getProfilerVisible`/`setProfilerVisible`) and **defaults to `DEVMODE`**: on in a dev build, as it
behaved before the checkbox existed, off in a shipped one — a stored `true`/`false` overrides that
either way. `applyProfilerVisible` is the single writer of `#profiler-hud`'s `visible` class, called
by `ProfilerHud`'s constructor to seed it for the level starting and by the checkbox to change it
live. **That class is also what `ProfilerHud.update` early-returns on**, so a hidden panel costs no
per-frame DOM writes and the CSS and the render path can't disagree about whether the overlay is up.
`Presenter` owns both this panel and the status text beside it, and reads the same setting to
decide whether to run the GPU timer query at all.

`ProfilerHud` renders each category as a horizontal bar sized against one 60fps frame's budget
(16.6ms) rather than against each other — a bar reaching full width means that category *alone*
would miss the budget, a more directly actionable signal than relative proportions, and it turns
amber/red past 25%/100% of that budget so the worst offender is visible without reading the numbers.
Rows are created once per label (first-seen order) and reused after that, the same "build the DOM
once, update fields every frame" approach `Hud` uses for its icons — and re-sorted worst-first on
every `update()` via `appendChild` on the already-existing row (which reorders rather than
duplicating), so the biggest cost lands at the top without tearing anything down.
