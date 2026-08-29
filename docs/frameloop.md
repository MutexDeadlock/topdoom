# The frame loop (`game.ts`)

`src/game.ts: frame`, `tic`, `draw`, `dueThisFrame`, `resume`, `pause`, `stillFrame`, `stop`

Who starts and stops a session around this loop is docs/menu.md § Session lifecycle.

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
- **`accumulator` is zeroed by `resume` and by `loadMapByIndex`.** Time spent paused or loading is
  not simulation time; without it the level would run a catch-up burst the moment the menu closes.

A tic that swaps the level (an exit, a restart) makes every reference the rest of the frame holds
stale, so `tic` reports it and `frame` returns immediately.

## What runs in a tic (`game.ts: tic`)

The whole simulation, in the order it has always run — several orderings are load-bearing:

- `specials.update` runs **before** `player.update`, so a lift or door underfoot has already moved
  by the time `groundFloor` samples it.
- the aim ray runs **before** `player.update`, so `player.angle` is this tic's.
- `projectiles.update` runs **before** `effects.updateImpacts`, so an explosion spawned by an
  arrival this tic is drawn on the very next frame rather than one late.
- `forces.tick` runs **after** the movers, since a displacement scroller's rate is the height change
  its control sector just made this tic; the voodoo dolls run after *that*, so a conveyor's impulse
  and the walk lines it pushes a doll across land in the same tic
  (docs/specials.md § Scrollers and conveyors, § Voodoo dolls).

Only the *visual* half of scrolling stays on the frame clock — `Forces.advanceOffsets`, drawn by
`SurfaceScroller` — so a waterfall doesn't step at 35 Hz. Nothing the simulation reads is
frame-paced; `Forces.tick` takes no delta at all.

Also in the tic, and worth knowing because they look like presentation: the **camera**
(docs/camera.md § The camera is simulation state), the **fog-of-war reveal scan**
(docs/fogofwar.md § What gameplay reads), and `SpriteAnimator.advance` — vanilla's frame durations
are tic counts, so animation belongs on the tic clock.

### Input runs on the tic

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

Nothing else has to be re-posed. `pickMonster` tests the ray against each thing's billboard
**analytically** (`intersectBillboard`, `render/sprites.ts`) from the thing's own tic state and the
tic-exact `viewerAngleDeg` — it reads no render state at all, so the sprite batches can stay
wherever the last frame left them. They used to be re-filled at alpha 1 for a `THREE.Raycaster` to
hit, a fill instrumented as `Sprites (aim)` that measured ~1.4 ms/frame on NUTS.WAD (10,617 things)
and scaled with tics per frame — ~6.4 ms at 3 tics/frame, exactly when the machine could least
afford it. The analytic pick is a linear scan with a cheap broad phase (`BILLBOARD_MAX_REACH`) and
measures ~0.09 ms on the same scene, so it no longer earns its own profiler block.

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

## What runs in a frame (`game.ts: draw`)

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
  player** freezes only `player.update`, which is what writes `prev*`, so `damagePlayer` collapses
  that one window with `syncInterpolation` on the killing hit. Both shipped as a visible shake.

**Movers are deliberately not interpolated.** Doors, lifts, floors and crushers write
`sector.floorHeight`/`ceilHeight` and rebuild geometry per tic — which is exactly the rate vanilla
ran them at, and a lift is a large slow object where 35 Hz reads far less than it does on a sprite.
docs/specials.md § Lights covers the light patterns' own tic timing.

## The FPS cap (`game.ts: dueThisFrame`, `getFpsCap`)

A settings-menu limit of 30, 60 or 120 fps, or `0` for none — the default. It is enforced by
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
