# Dev mode and profiling

`src/constants.ts`, `src/ui/debughud.ts`, `src/game.ts`, `src/util/profiler.ts`,
`src/ui/profilerhud.ts`

## DEVMODE

`DEVMODE` reads `import.meta.env.VITE_DEVMODE`, defaulting to `false`; set `VITE_DEVMODE=true` in a
git-ignored `.env.local` at the repo root to turn it on (Vite loads `.env.local` itself, no plugin
needed). It gates four things — three in `ui/debughud.ts` and one in `ui/menu.ts` — all because a
player has no legitimate reason to reach for them:

- **The debug overlay** (`DebugHud.update`, whose lines come from `Game.debugLines`) — off, `#hud`
  shows only the fps counter; on, the full
  map/pos/sector/camera-state/awake-monster-count block. **Everything it prints is live state.** It
  used to end with two static hotkey hint lines as well, which were the game's only controls
  reference and so invisible to exactly the players who needed them; that list is now the menu's
  Settings tab (docs/menu.md § Settings tab).
- **The profiling overlay** (`#profiler-hud`, below) — visibility toggled once at startup.
- **The Settings tab's `#controls-dev` section**, the only place `N`/`P` is listed in the UI —
  revealed once in the `Menu` constructor, so a shipped build never advertises a key it ignores.
- **`N`/`P` (jump to next/prev map)** in `handleHotkeys` — behind the early-return on `!DEVMODE`, so
  they are simply inert outside dev mode. `+`/`-` (camera distance) and `[`/`]` (camera tilt)
  deliberately sit *ahead* of that gate: they are player-facing framing controls, not debug state,
  and gating them only meant a shipped player couldn't adjust how much of the level fits on screen.

`Game.debugLines` reports `ThingLayer.awakeMonsterCount()` — the number of living monsters
currently alerted (chasing/attacking, or mid-`reactionTicks` delay) — useful for judging whether a
level's population has actually noticed the player.

## Profiling overlay

A third DEVMODE-gated panel, top-right, breaks a frame's cost down by category — `Specials`, `Player`,
`Weapons`, `Fog of War`, `Monsters`, `Effects`, `Fading`, `Render`, plus an `Other` bucket for whatever
wasn't explicitly measured (input handling, HUD text, the player sprite's own pose) — so a slow frame
can be traced to *which* system is responsible rather than just how many fps it costs.

`FrameProfiler` (`util/profiler.ts`) is a plain per-frame timer, not tied to rendering or game state:
`beginFrame()`, any number of `time(label, fn)`/`add(label, ms)` calls (the same label can be used more
than once per frame — `game.ts`'s "Player" bucket covers both the movement block and the later
pickup/damage-floor block, non-contiguous in `frame()` — and accumulates), then `endFrame()`.

Every label is smoothed with a plain exponential moving average rather than shown raw, the same
reasoning as `util/damping.ts`'s `dampen`: a single frame's timing is noisy (GC pauses, OS scheduling),
and an unsmoothed bar graph would flicker faster than it could be read.

**Measurement itself is not gated behind `DEVMODE`** — `performance.now()` calls are cheap enough not to
bother branching around, the same call the fps counter already makes. Only the DOM panel's visibility
(toggled once in `DebugHud`'s constructor, since `DEVMODE` never changes at runtime) and whether
`DebugHud.update` bothers pushing samples to it are. `Game.debugLines` is passed as a closure for the
same reason: its body walks the BSP for the player's sector, and must not run when the panel is off.

`ProfilerHud` renders each category as a horizontal bar sized against one 60fps frame's budget (16.6ms)
rather than against each other — a bar reaching full width means that category *alone* would miss the
budget, a more directly actionable signal than relative proportions, and it turns amber/red past
25%/100% of that budget so the worst offender is visible without reading the numbers. Rows are created
once per label (first-seen order) and reused after that, the same "build the DOM once, update fields
every frame" approach `Hud` uses for its icons — and re-sorted worst-first on every `update()` via
`appendChild` on the already-existing row (which reorders rather than duplicating), so the biggest cost
lands at the top without tearing anything down.
