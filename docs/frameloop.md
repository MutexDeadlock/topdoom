# The frame loop (`game.ts`)

`src/game.ts: frame`, `tic`, `dueThisFrame`, `resume`, `pause`, `stillFrame`, `stop`; the frame's
drawing in `src/game/presenter.ts: draw`

Who starts and stops a session around this loop is docs/session.md § Session lifecycle.

**The simulation runs at a fixed 35 Hz and the display runs as fast as it can.** Every gameplay
system advances by exactly `DOOM_TIC`, vanilla's own 35 Hz clock, and never by a frame
delta, so the same inputs produce the same run on a 60 Hz laptop and a 144 Hz monitor. Rendering
then poses everything part-way between the last two tics so motion still looks smooth.

What that buys and what it does not: the simulation is **framerate-independent**, which is the
prerequisite for replays, verified times and eventually demo playback. It is *not* portable
determinism — `Math.sin`/`cos`/`atan2`/`exp` are implementation-defined precision and differ between
browsers — and it is not vanilla demo compatibility, which additionally needs fixed-point arithmetic
and a port of vanilla's own game code. docs/random.md § What this does not buy makes the same point
about the RNG.

## The accumulator (`game.ts: frame`)

Real elapsed time is *banked*, not consumed. Each frame adds `rawDt` to `accumulator`, spends it in
whole `DOOM_TIC` steps, and hands whatever is left over to `draw` as the interpolation alpha:

```ts
const rawDt = Math.max(0, (now - this.lastTime) / 1000);
this.accumulator += rawDt;
if (this.accumulator > MAX_TICS_PER_FRAME * DOOM_TIC) this.accumulator = MAX_TICS_PER_FRAME * DOOM_TIC;
while (this.accumulator >= DOOM_TIC && ran < MAX_TICS_PER_FRAME) { this.accumulator -= DOOM_TIC; this.tic(...); }
this.draw(this.accumulator / DOOM_TIC, rawDt);
```

Three rules hold it together:

- **The lower clamp on `rawDt` is load-bearing**, not defensive. `resume` stamps `lastTime` with
  `performance.now()` while `frame` gets the timestamp of the rendering opportunity it belongs to,
  and when `resume` runs inside a frame's own input task (a Start click whose WAD is already cached,
  so nothing awaits long enough to yield) that timestamp *predates* the stamp. Without the clamp the
  accumulator runs backwards.

  **It belongs at the source, not on the accumulator alone.** `rawDt` is also handed to `draw`, and
  from there to the overlays, the fog fade and both texture animators — a negative wall-clock delta
  is meaningless to every one of them, and `AnimatedTextures` keeps a running total of it that it
  *indexes an array by*. A negative total floors to a negative tic, JS's `%` keeps the sign, and
  `names[-1]` is `undefined`: that crashed `GraphicsBank.flat` and killed the rAF chain, hanging the
  game on a level's first frame. Reported against BOOMEDIT.WAD, whose `ANIMATED` runs two sequences
  at 2 tics/frame rather than vanilla's uniform 8 — the threshold is `-2 × speedTics/35` seconds, so
  its faster sequences reach it four times sooner. Covered by
  `tests/regression/animated-negative-dt.test.ts`; `AnimatedTextures` also clamps its own
  accumulator, since it owns the invariant the index depends on.
- **A stall drops its debt rather than paying it back.** `MAX_TICS_PER_FRAME` caps both the burst
  after a backgrounded tab and the worst-case cost of one frame. This is the same "never take a
  giant step" the old `dt` clamp bought, expressed in tics.
- **`accumulator` is zeroed by `resume` and by `buildLevel`.** Time spent paused or loading is
  not simulation time; without it the level would run a catch-up burst the moment the menu closes.

A tic that swaps the level (an exit, a restart) makes every reference the rest of the frame holds
stale, so `tic` reports it and `frame` returns immediately.

## What runs in a tic (`game.ts: tic`)

The whole simulation, in the order it has always run — several orderings are load-bearing:

- `specials.beginTic` runs **before** `player.update`, so a lift or door underfoot has already
  moved by the time `groundFloor` samples it; each living slot's `specials.activate` follows, and
  `specials.endTic` (switch flashes, light patterns) runs once every slot has acted —
  docs/multiplayer.md § What a slot's tic does.
- the aim ray runs **before** `player.update`, so `player.angle` is this tic's.
- `projectiles.update` runs **before** `effects.updateImpacts`, so an explosion spawned by an
  arrival this tic is drawn on the very next frame rather than one late.
- `forces.tick` runs **after** the movers, since a displacement scroller's rate is the height change
  its control sector just made this tic; the voodoo dolls run after *that*, so a conveyor's impulse
  and the walk lines it pushes a doll across land in the same tic
  (docs/specials-forces.md § Scrollers and conveyors, § Voodoo dolls).

Only the *visual* half of scrolling stays on the frame clock — `Forces.advanceOffsets`, drawn by
`SurfaceScroller` — so a waterfall doesn't step at 35 Hz. Nothing the simulation reads is
frame-paced; `Forces.tick` takes no delta at all.

Also in the tic, and worth knowing because they look like presentation: the **camera**
(docs/camera.md § The camera is simulation state), the **fog-of-war reveal scan**
(docs/fogofwar.md § What gameplay reads), and `SpriteAnimator.advance` — vanilla's frame durations
are tic counts, so animation belongs on the tic clock.

### Input runs on the tic

The tic reads a **`TicInput`**, not the concrete `Input`: live play passes the `Input`, a
recording passes a recorder wrapping it, a playback passes the record itself
(docs/replays.md § The TicInput seam). Nothing in a tic reads the pointer — it asks for the aim
*point* instead.

`Input`'s edge latches (`pressed`, `rightMousePressed`) hold "went down since the last **tic**", and
`endTic` is the only thing that clears them. Rendering runs several times per tic, so clearing at
frame cadence would drop most presses before a tic ever saw them — every door, weapon-switch digit
and respawn key. A frame that runs no tics must not touch input state at all.

`consumeWheel` was already an accumulate-and-drain channel and needed only to move to the tic.

**A key going to a focused form control is not the game's** (`isTyping`, `game/input.ts`): `keydown`
is listened for on `window`, and it both latches the key and preventDefaults `Space` and the arrows,
so without the guard the menu's name fields could not contain a space or move their caret, and its
dropdowns could not be arrowed through. Only `keydown` is guarded — a key held from the canvas into
a field must still see its `keyup`, and clearing one that was never latched costs nothing.

The other half of that rule is **`Menu.close` blurring whatever it still holds**: focus survives the
menu closing, so a dropdown or button clicked on the way out would keep taking the game's keys for
the rest of the level. Nothing outside the menu is focusable, which is what makes the guard's own
"only while the menu is up" true.

### Posing for the aim ray

The ray is cast **toward the aim point** (`rayToward`), not through the pointer, so a replay's
recorded point casts the ray the recording cast — docs/replays.md § The TicInput seam. Everything
below is about the pose it is cast from.

The aim ray is cast through the **live `THREE` camera**, which the last rendered frame left at an
*interpolated* pose — a function of frame timing. Casting through it as it stands makes what
auto-aim locks onto depend on framerate, and since auto-aim sets `player.angle`, that is the angle
every shot is fired at.

So the tic calls `applyToCamera(1)`, putting the camera back on the previous tic's exact pose, and
it does so **immediately before the ray**. The placement is the whole trick and it is easy to get
wrong: posing at the *end* of the tic instead looks equivalent and is not, because `draw` runs
afterwards and overwrites it. With one tic per frame — the normal case — that end-of-tic pose is
never read by anything, and the ray goes back to reading an interpolated camera. It shipped that way
once.

Nothing else has to be re-posed. `pickMonster` tests the ray against each body's **`mobjinfo` box**
(`util/geom.ts: rayEntersBox`) from the thing's own tic state — it reads no render state at all, and
since the box is engine table data rather than art it needs neither the sprite lump nor the viewer
angle. So the sprite batches can stay wherever the last frame left them. They used to be re-filled
at alpha 1 for a `THREE.Raycaster` to hit, a fill instrumented as `Sprites (aim)` that measured
~1.4 ms/frame on NUTS.WAD (10,617 things) and scaled with tics per frame — ~6.4 ms at 3 tics/frame,
exactly when the machine could least afford it. A slab test per candidate is a linear scan of
arithmetic alone and measures 0.064 ms on the same scene, so the pick no longer earns its own
profiler block. Most of that came from `rayEntersBox` bailing out **per axis** rather than once at
the end: nearly every body on a crowded map misses on the first slab, and deciding that there is
what took it from 0.22 ms to 0.06 ms.

The pick is skipped entirely while the player is dead, since nothing aims then.

### Keeping real time under load

The old model clamped `dt` to 0.05 s, so **below 20 fps the game silently ran in slow motion** —
every system stepped less simulated time than had really passed. Measured on NUTS.WAD at 15 fps:
0.77× speed, i.e. the level clock lost about a quarter of every second. The accumulator fixes this
by running the extra tics instead of shortening them, and measures 1.00× on the same scene.

That is not a cosmetic difference. It is why a heavy fight now escalates at the rate it should:
NUTS.WAD's ~7,700-monster infight cascade resolves several times faster than it used to, because it
is no longer being run at three-quarters speed. `MAX_TICS_PER_FRAME` is the bound on how far this
can go — past 5 tics of debt the engine gives up and drops the rest, and *then* it does slow down.

## Playback speed and pause

A replay banks `rawDt × speed` instead of `rawDt`, and nothing at all while its bar's pause is on
or its stream is spent; both of those draw at alpha 1, the frozen-simulation rule above. That pause
is **not** the menu's — the frame loop keeps running so the bar stays live, and `ESC` still pauses
the game as it always did. `MAX_TICS_PER_FRAME` bounds what a speed can actually reach on a slow
frame, so the top step, 4×, holds only down to 28 fps. docs/replays.md § Playback.

A **network game holds the frame** the same way while a peer's row for the next tic is missing, or
a snapshot it is to restore is still on its way: nothing is banked, so no catch-up burst follows the
wait (docs/multiplayer-net.md § Lockstep). Its menu does not pause at all — `pause` only marks the
menu up, and the local rows go out idle meanwhile.

A **seek owns the frame**: `ReplayDriver.runSeek` banks no time, runs its own tics for up to `SEEK_BUDGET_MS`
and **draws nothing at all** until the target lands — the frame before the jump stays on screen,
with only the bar and its marker updated over it. Landing draws at alpha 1, except on a tic that
swapped the level, which ends the frame undrawn like the tic loop's own does. `resyncClock` is what
keeps the catch-up's real seconds from becoming a burst of tics afterwards.
docs/replays.md § Seeking.

## What runs in a frame (`game/presenter.ts: draw`)

Presentation only — it advances no gameplay state. The camera pose, the sprite batches, the HUD and
overlays, the occlusion and fog *fades*, the texture scroller and animator, and the render call.
These take `rawDt`, not `DOOM_TIC`: they are measuring real frames.

## Interpolation

Everything drawn carries where it was at the end of the previous tic, and `draw` emits
`prev + (curr - prev) * alpha`.

| Carrier | Fields |
|---|---|
| `Player` | `prevX/Y/Z/prevAngle`, plus `syncInterpolation()` for teleports |
| `PosedThing` | `drawPrevX/Y/Z` — written for *every* thing every tic |
| `Projectile` | `drawPrevX/Y/Z` + `drawX/Y/Z` |
| `OneShotEffect`, `SpawnCube` | `drawPrevX/Y/Z` |
| `TopDownCamera` | `prevSmoothed`, `prevYawDeg`, plus `snapTo()` for level loads |
| moving sectors | `SpecialsController.moverLerp` — `prevFloor/prevCeil` per sector, see below |

Five rules:

- **`PosedThing.prev` is not an interpolation source.** It exists for `crossLines`' walk triggers
  and is maintained only on the alerted-with-a-target path, but knockback, corpse gravity and a
  ceiling-hung prop riding a closing door all move a thing that never runs that path. Hence the
  separate `drawPrev*`, written unconditionally at the top of the per-thing loop.
- **Every discontinuous move must collapse the window.** A teleport that leaves a stale `prev`
  behind is drawn as a glide across the map. `Player.syncInterpolation`, `TopDownCamera`'s `yawDeg`
  setter and `TopDownCamera.snapTo` are the three that matter; a freshly spawned thing seeds
  `drawPrev*` to its spawn point for the same reason. The camera's case is the widest, because it
  outlives the level: `snapTo` collapses the *smoother* as well as the window, or a level load —
  a discontinuous move of the follow point if ever there was one — opens with the camera flying in
  from the previous level's position (docs/camera.md § The camera is simulation state).
- **Sprite *facing* is not interpolated.** It is quantised to 8 directions, so lerping it is work
  that changes nothing. Positions only — except the player's own billboard, whose facing is
  continuous and so uses a shortest-arc lerp.
- **Angles need shortest-arc**, or a shot across the ±π seam spins the billboard the long way round.
- **Anything that stops being simulated must not be left mid-window.** Interpolation assumes another
  tic is coming; when none is, the last two tics stay apart forever while `alpha` — the leftover
  accumulator — keeps changing every frame, so the still subject jitters between them at frame
  cadence. Two cases exist and each closes it at its own scope: the **intermission** freezes the
  whole simulation, so `frame` draws it at `alpha` 1 outright (the tic-exact pose); a **dead
  player** freezes only `player.update`, which is what writes `prev*`, so `damageSlot` collapses
  that one window with `syncInterpolation` on the killing hit. Both shipped as a visible shake.

**Movers interpolate through the map itself.** Doors, lifts, floors and crushers write
`sector.floorHeight`/`ceilHeight` per tic; `SpecialsController.moverLerp` keeps each moving
sector's previous-tic heights, and `drawMovers(alpha)` — called by `draw` ahead of the fade pass —
writes the lerped heights into the sectors, refreshes their meshes (`MoverGeometry.rebuildAround`,
docs/render.md § Mover meshes), and restores the tic-exact values before returning. The simulation
never sees a fractional-tic plane; collision, saves and `moverblocking` all read exact heights. The
fade pass is the one presentation reader that needs the drawn ones back, and asks
`drawnOpeningInto` for them (docs/render-occlusion.md § Which sightlines a wall fades for). A
one-tic jump — a toggle plat's stroke, `T_MovePlane`'s clamp branch — collapses its window and
draws as the instant move vanilla shows (rule two above); `trackPlaneMove` detects it as a tic
that travelled further than the mover's own speed allows, so no per-branch marking exists to
forget. A frozen
simulation is covered by the alpha-1 rule: `drawMovers(1)` is the tic-exact pose, and a window
whose ends match is skipped, not re-refreshed. docs/specials-lights.md § Lights covers the light
patterns' own tic timing.

## The FPS cap (`game.ts: dueThisFrame`, `getFpsCap`)

A settings-menu limit of 30, 60 or 120 fps, or `0` for none. **60 is the default** — the simulation
runs at 35 Hz whatever the cap, so more frames buy little and cost battery. It is enforced by
**skipping whole rendering opportunities**: a frame that isn't due yet re-arms
`requestAnimationFrame` without drawing.

It returns *before* `lastTime = now`, so a skipped opportunity keeps its elapsed time for the next
real frame. That is exactly right for an accumulator, and it is why capping to 30 fps still runs a
true 35 Hz simulation instead of slowing the game down — the cap costs frames, never tics.

Two rules make the rate come out right on displays whose refresh isn't a multiple of the cap:

- **A frame is due at the vsync nearest its deadline**, not the first one past it — `now + period/2`
  is what's compared, where `period` is the interval between the last two rAF callbacks. A strict
  `now >= deadline` test halves the frame rate whenever the display runs at exactly the capped rate,
  because sub-millisecond vsync jitter makes it miss almost every deadline by a hair.
- **Deadlines advance by whole intervals** rather than being restamped from `now`, so the *average*
  holds at the cap when the display can only bracket it: 144 Hz capped to 120 drops every sixth
  frame, 75 Hz capped to 60 every fifth. Falling more than one interval behind resyncs off `now`
  instead of paying the debt back as a burst of frames.

A cap at or above the refresh rate is a no-op. The setting is read **live, once per frame**, so
changing it mid-level applies to the level already running; `resume` clears the deadline so the
first frame back is always due.

## Pausing (`game.ts: pause`, `stillFrame`, `stop`)

A paused level is frozen but **still being drawn**: `pause` stops the simulation loop and starts
`stillFrame`, which only calls `renderer.render` — no tics, no input, no profiling — and only every
~50 ms, since a static scene has no reason to cost 60 fps. Without it the canvas would just be
showing its last composited frame, which goes stale the moment anything invalidates it (a window
resize resizes the canvas, a DPR change, a tab restore), and the menu now draws *over* the level
(`ui/menu/menu.css: #menu.ingame`, docs/styles.md) instead of hiding it.

**`dispose` calls `stop`, not `pause`.** Both clear `running`, but `pause` sets `paused` and
schedules `stillFrame`; going through it from `dispose` would leave that loop redrawing a scene
whose geometry and materials have just been released.

**`pause` flushes a parked level load** before it freezes, and `resume` shares `resyncClock` with
the frame that performs one — see § A parked level load.

**A frame that advances no tic advances no player animation either.** `frame`'s `still` — an
intermission or end card up, or a playback paused or spent — already draws at alpha 1 (§ Interpolation);
it also hands `posePlayer` a `dt` of 0, so the sprite holds the stride it was on instead of walking
on the spot behind a frozen scene. `animating` stays *true* there: at `dt` 0 the actor keeps its
frame, where false would snap it to standing, and a pause is not a stop. Everything else in the
frame keeps its real `dt` — the HUD, the replay bar and the fades are presentation the frozen scene
still wants (docs/replays.md § Playback).

## A parked level load (`game.ts: loadLevel`, `pendingLoad`)

A level whose build is predicted to be slow is not built inside the tic that asked for it: the
loading screen goes up, the load is parked as a thunk, and the **next** `frame` runs it before
anything else — deliberately ahead of `dueThisFrame`, since a capped frame skipping it would leave
the overlay up over nothing. That frame then calls `resyncClock`, for the same reason `resume` does:
the build is real time but not simulation time, and `accumulator` must not run it back as a burst
of tics.

Reordering `frame` must keep both properties — the check ahead of the cap, and the resync after the
build. Why the load is parked rather than awaited, and what decides "slow", is
docs/session.md § The loading screen.
