# The frame loop (`game.ts`)

`src/game.ts: frame`, `resume`, `dueThisFrame`, `pause`, `stillFrame`, `stop`

Who starts and stops a session around this loop is docs/menu.md § Session lifecycle.

## The frame delta (`game.ts: frame`, `resume`)

`dt` is clamped to `[0, 0.05]`; `rawDt` (unclamped, for `DebugHud`'s fps only) is the real
wall-clock delta. The upper bound keeps physics/AI from taking a giant step after a stall. **The
lower bound is load-bearing**, not defensive noise: `resume` stamps `lastTime` with
`performance.now()`, while `frame` gets the timestamp of the rendering opportunity it belongs to —
and when `resume` is reached inside a frame's *input* task (a Start click whose WAD is already in
the browser cache, so nothing awaits long enough to yield), the rAF callback runs in that same
frame and its timestamp predates the stamp by the whole load. Every system then takes one negative
step; `AnimatedTextures` (§ Animated textures, docs/specials.md) turned that into a negative frame
index into its sequence and a hard crash — reproduced by starting any level, returning to the menu
and starting `oku2v31.wad`.

## The FPS cap (`game.ts: dueThisFrame`, `getFpsCap`)

A settings-menu limit of 30, 60 or 120 fps, or `0` for none — the default, and what every earlier
build did unconditionally. It is enforced by **skipping whole rendering opportunities**: a `frame`
that isn't due yet advances nothing at all and re-arms `requestAnimationFrame`, so no system sees a
partial step and the input that frame would have consumed simply arrives on the next one. `dt` is
the delta since the last frame that *ran*, and 30 fps (0.033 s) is still inside its 0.05 clamp, so
the slowest cap on offer can't turn into a clamped step.

Two rules make the rate come out right on displays whose refresh isn't a multiple of the cap:

- **A frame is due at the vsync nearest its deadline**, not the first one past it — `now + period/2`
  is what's compared, where `period` is the interval between the last two rAF callbacks (i.e. the
  display's own). A strict `now >= deadline` test halves the frame rate whenever the display runs at
  exactly the capped rate, because sub-millisecond vsync jitter makes it miss almost every deadline
  by a hair.
- **Deadlines advance by whole intervals** rather than being restamped from `now`, so the *average*
  holds at the cap when the display can only bracket it: 144 Hz capped to 120 drops every sixth
  frame, 75 Hz capped to 60 every fifth. Falling more than one interval behind (a stall, a
  backgrounded tab) resyncs off `now` instead of paying the debt back as a burst of frames.

A cap at or above the refresh rate is a no-op — 120 on a 60 Hz display still renders 60. The setting
is read **live, once per frame**, so changing it mid-level applies to the level already running;
`resume` clears the deadline so the first frame back is always due.

The paused loop (§ Pausing) ignores the cap: its own ~50 ms floor is already below every value on
offer. `DebugHud`'s fps counter reports the capped rate, since it measures the delta between frames
that actually ran.

## Pausing (`game.ts: pause`, `stillFrame`, `stop`)

A paused level is frozen but **still being drawn**: `pause` stops the simulation loop and starts
`stillFrame`, which only calls `renderer.render` — no `dt`, no input, no profiling — and only every
~50 ms, since a static scene has no reason to cost 60 fps. Without it the canvas would just be
showing its last composited frame, which goes stale the moment anything invalidates it (a window
resize resizes the canvas, a DPR change, a tab restore), and the menu now draws *over* the level
(`ui/menu/menu.css: #menu.ingame`, docs/styles.md) instead of hiding it, so a stale or blank backdrop is visible.

**`dispose` calls `stop`, not `pause`.** Both clear `running`, but `pause` sets `paused` and schedules
`stillFrame`; going through it from `dispose` would leave that loop redrawing a scene whose geometry
and materials have just been released.
