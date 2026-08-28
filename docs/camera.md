# The camera

`src/render/camera.ts`, `src/game/autocamera.ts`, `src/game/input.ts`, `src/game/player.ts`

Where the view hangs, what it frames and what it leads toward. The camera is the reason this engine
exists, and it is *simulation* state rather than presentation: the pointer ray cast through it sets
the angle every shot is fired at, and its bearing is the basis WASD is rotated into. What it looks
at — the geometry, its lighting and its fading — is docs/render.md; the loop that drives a frame is
docs/frameloop.md.

## Camera orbit and camera-relative movement (`camera.ts`, `game/input.ts`, `game/player.ts`)

`TopDownCamera.yawDeg` lets the camera orbit around the followed point by pressing `Q`/`E`
(`KEY_YAW_STEP`, a 45° step per press). Tilt and distance are unaffected, so the camera always stays
the same amount off vertical.

**Orbiting is keyboard-only on purpose.** A right-mouse drag used to rotate it too, and that fought
the cursor: the mouse is the aiming hand, so a drag that swings the world underneath the crosshair
moves the aim point as a side effect of turning. The freed right button is now a menu-bound action
instead (docs/menu.md § Right mouse button).

`viewerAngleDeg` (`yawDeg - 90`) is the DOOM-space bearing from the followed point to the camera,
and is what sprite rendering and player movement both key off — at the default `yawDeg = 0` it's
`-90`, matching the old fixed south-facing camera exactly, so nothing downstream needed a special
case for "not yet orbited."

A `stepYaw` call (Q/E) queues its step as a `targetYawDeg` for `tick` to animate `yawDeg` towards
(`YAW_STEP_SMOOTH_RATE`) rather than jumping. Plain assignment (`camera.yawDeg = ...`, whose only
remaining caller is the instant reorient on spawn/teleport) still jumps immediately: the `yawDeg`
setter keeps `targetYawDeg` in lockstep so nothing left over from a prior Q/E animates after an
instant set. **Nothing may assign `yawDeg` unconditionally every frame** — even a no-op `-= 0` snaps
`targetYawDeg` back to the current (still mid-animation) value and cancels a Q/E step after one
frame of smoothing, which is what forced the removed drag handler to guard on a nonzero delta.

All of that input handling lives in `TopDownCamera.applyYawInput`, which `game.ts` calls once a
**tic**. Holding Q/E auto-repeats the same 45° `stepYaw` every `KEY_YAW_REPEAT_INTERVAL` —
`qHoldTime`/`eHoldTime` accumulate `dt` while `Input.held` is true and fire+reset once the interval
is reached, alongside the immediate step fired on `Input.pressed`. The interval is tuned to roughly
the time one step's smoothing takes to settle, so a hold reads as continuous rotation made of
chained steps.

Movement (`Player.update`'s `forwardDeg`, passed as `camera.viewerAngleDeg + 180`) is
camera-relative rather than DOOM-axis-relative: `W` always moves the player away from the camera *on
screen*, regardless of orbit. `game.ts` recomputes this every tic from the live camera angle.

## The camera is simulation state

`TopDownCamera` splits into `tick(dt, pos, cursor)` — which advances the smoothed follow point and
`yawDeg` — and `applyToCamera(alpha)`, which interpolates between the last two tics and is the only
thing that moves the `THREE` camera. **`tick` runs on the simulation clock**, which is unusual for
something in `src/render/` and is forced rather than stylistic:

- the pointer ray is cast through this camera (`rayFor` → `pickMonster`, `pointerToPlane`), and
  where that ray lands sets `Player.angle` — the angle every shot is fired at;
- `viewerAngleDeg` is the basis WASD movement is rotated into, so it decides *which direction the
  player moves*.

Both would otherwise be functions of how many times the render loop had smoothed the camera, i.e. of
framerate. Feel is unchanged: both smoothers are `1 - exp(-rate * dt)`, framerate-independent by
construction, so sampling at 35 Hz and interpolating traces the same curve.

Two angles come out of this, and mixing them up is the easy mistake. `viewerAngleDeg` is
**tic-exact** and is what the simulation reads; `viewAngleDeg` is the interpolated pose actually
drawn, and is what billboards must orient to — using the tic-exact one there leaves every sprite a
fraction of a yaw snap out of line with the walls behind it. docs/frameloop.md § Interpolation.

**The camera outlives the level**, since it belongs to the `Viewport` and a load only replaces the
`Game` — so the follow point's exponential smoother still holds the *outgoing* level's position when
the next one starts. `loadMapByIndex` therefore ends the player's placement with `snapTo`, which
puts the smoothed point, the interpolation source and the `THREE` camera itself on the new player
position at once; without it a level change or a save restore opens with the camera gliding in from
wherever the last level left it. It poses the `THREE` camera immediately rather than leaving that to
the next `applyToCamera` because two paths render without one (the pause loop's `stillFrame`, and
`captureThumbnail`). The yaw has had this since the beginning — the `yawDeg` setter is the same
collapse for the orbit angle — which is why `snapTo` is called *after* whichever branch set the yaw.

**A teleport is the same discontinuity** and takes the same pair, in the same order
(docs/specials.md § Teleporters). It used to snap only the yaw, which left the camera flying to the
landing spot over roughly a third of a second while the player was already there and shooting. What
still glides after either snap is the aim lead alone — `tick` re-applies it to the fresh target on
the very next tic — which is bounded by `MAX_AIM_LEAD` and is the intended follow-the-cursor feel
rather than a leftover.

## Aim lead

The follow point is nudged `aimLead` (0.18) of the way from the player toward the cursor, capped at
`MAX_AIM_LEAD` (220 units) so the player never leaves the screen. **What it leads toward is always
the cursor's own aim-plane point (`pointerToPlane`), never what auto-aim locked onto**, and the two
are not the same place: the lock returns the monster's anchor, which for a billboard under the
pointer sits somewhere else entirely than where that pointer meets the plane. Feeding `tick` the
lock made the view lurch every time the cursor crossed a monster and again when it left — motion the
player never asked for, from a system that is supposed to be invisible.
`game.ts: updateLivingPlayer` therefore returns the plane point specifically, while `Player.angle`
and the shot keep the lock (docs/combat.md § Auto-aim).

**The aim plane sits at `TopDownCamera.followHeight`, not at the player's own `z`.** The two are the
same height once the follow smoother has caught up — the camera is handed `eyeZ` and the plane sits
`AIM_HEIGHT_OFFSET` below that — but they part company during a fall, and that is exactly when it
matters: the camera lags by up to the whole drop for about a third of a second, so a plane pinned to
the player's live `z` drifts away from the camera under it, moving the cursor's world point and
turning the player toward it. Deriving the plane from the camera locks the two together, so a fall
pans the view and changes nothing else. Boom's deep water (docs/specials.md § Deep water) is what
surfaced this: 242 is render-only, so walking into a pool drawn as a flat sheet of water still drops
the player up to 200 units, with nothing on screen to explain the swing.

## Auto camera (`game/autocamera.ts`, `camera.ts`)

The default camera mode frames the view from the space around the player: shut-in geometry pulls
the camera down to `AUTO_NARROW_DISTANCE`/`AUTO_NARROW_TILT` (350u / 50°), open areas push it out
to `AUTO_WIDE_DISTANCE`/`AUTO_WIDE_TILT` (720u / 70°). The "Camera mode" menu setting
(`topdoom.cameraMode`, owned by `game/autocamera.ts`) switches between `auto` and `manual`;
manual keeps the 480u / 60° constructor defaults and the `+ - [ ]` keys. **The framing keys are
inert in auto mode** — they act only while the mode is manual, the same inert-not-error shape the
DEVMODE map keys have outside dev mode.

**The probe** (`measureOpenness`) casts `OPENNESS_RAY_COUNT` (24) rays from the player, every 15°
at **fixed world angles**. Each ray walks the linedef grid
(`World.forEachLineAlongSegment` + `segmentCrossT` over `lineOverlapEnds`, the
`projectileStepBlocker` shape) out to `OPENNESS_RANGE` (1280u) and stops at the nearest line whose
opening no longer straddles the player's eye (`blocksProbe`). Sector heights are read live, so a
door opening widens the framing on the next tic; `isSolidWall` (movement) and `blocksShot`
(bullets pass railings) are both deliberately not it. The full fan costs ~0.04 ms per tic on
NUTS.WAD MAP01, runs under the `Camera` profiler label, and in manual mode never runs at all.

**The fan runs at the player's eye, not flat through the map.** It starts at `player.ts`'s
`EYE_HEIGHT` over the feet — the same eye `Player.eyeZ` gives the camera to follow — and a ray
ends at the first line whose opening lies wholly above or wholly below it. `World.blocksSight` is
**not** the test, even though it is the one the fog of war uses: it asks only whether a line has
*any* vertical opening, which on a map built out of height steps rather than closed rooms is
nearly never. EPIC.WAD MAP02 at `(-4018, -3014)` is the case this was found on — a railed pen 48
to 144 units below the ground around it, where every one of the 24 rays ran the full 1280 units
over the pen wall and pinned both dials at 1, framing a two-cell pen as wide open. With the eye
test the same spot reads `spread` 0.43 / `ahead` 0.16. A step **down** still reads open, which is
right: the player really can see out over a drop.

The camera does see over that pen wall, and that is not a contradiction: these two dials answer
how much *room the player has*, not how much is on screen. The fog of war is the query that
answers the latter, which is why it keeps the height-blind test (docs/fogofwar.md § Sight
blocking).

**Two aggregates come out of that one fan, and each drives one dial**, because the two dials do
different jobs:

- **`spread`**, the **median** ray, drives the **zoom**. How much room surrounds the player is a
  property of the place, not of where they happen to be looking. It is a median and not a mean
  because a mean is dominated by whichever few directions happen to be long: standing in the
  north-west corner of DOOM2 MAP01's opening room, 15 of the 24 rays stop inside 256 units and
  six run 1100–1540 down the length of the room, which pulls the *mean* to 478 (zoom 603u, as
  open as a hall) while the median is 128 (zoom 420u, correctly boxed in). The median reads as
  "the radius within which half of all directions are walled off", which is the question the zoom
  is actually asking. Order statistics are continuous in their inputs, so it cannot pop as the
  player walks and the ray ordering churns.
- **`ahead`**, the mean weighted by `max(0, cos)` of each ray's angle off the bearing the camera
  looks along, drives the **tilt**. Tilt is what trades a top-down view of the player's
  surroundings for reach up the screen, so it is inherently directional: an open room ahead is
  worth leaning into, a wall two steps ahead is not. A single undirected measure cannot express
  that, and measurably did not — standing in E1M1's corridor at (1516, -2503), opening the door
  into the room east moves `spread` from 0.00 to 0.15 but `ahead` from 0.00 to 0.50, and turning
  the camera 180° to face the near wall drops `ahead` back to 0.06 with `spread` untouched.

**The rays stay world-fixed; only the `ahead` weights rotate.** That is what keeps the
measurement steady: no ray ever sweeps across a doorjamb as the camera turns, and the cosine lobe
falls off smoothly rather than at a cone edge, so a Q/E step glides instead of popping. The
bearing is `camera.viewerAngleDeg + 180` — the camera's own orbit, the same expression the
movement basis and the audio listener take, **not** the player's facing, which follows the mouse
and would twitch the framing with every flick of the crosshair. `ahead` is normalised by the
weight actually used rather than a constant, since a cosine lobe's sum over a fixed ray fan
ripples slightly as the lobe rotates between rays.

Each aggregate maps to 0..1 through **its own** shut-in/wide-open window — `SPREAD_NEAR`/`FAR`
(60/600) and `AHEAD_NEAR`/`FAR` (90/1200). They cannot share one: a median runs roughly half of
what the cosine-weighted mean does, so a window that suits one saturates the other. Both were
picked off measured distributions rather than guessed — sampling every thing position in E1M1,
DOOM2 MAP01/MAP07 and EPIC MAP01 — which is also how the original 192/960 was caught leaving the
wide end of the framing unreachable on every one of those maps. The eye test above left both
windows where they were — on maps built out of rooms, whose walls close in 2D anyway, it barely
moves the distributions at all. What it changes is the maps that aren't.

**A framing pulled in leans further over.** At the narrow end of the envelope a camera at the
openness mapping's own tilt looks nearly straight down the player's back: it shows the ground
around them and almost nothing they are walking into — which is the half a shut-in place actually
needs. `nearTiltLean` therefore adds up to `NEAR_TILT_LEAN` (10°, **tuned by feel**) of extra tilt,
nothing at `AUTO_NARROW_DISTANCE` and the whole of it once the zoom is at `AUTO_OCCLUDED_DISTANCE`
or nearer, easing linearly between. It is a pure function of the distance the cap and the rescue
settled on, so it adds no state; the occlusion cap is deliberately **not** re-measured through it,
since the cap decides how near the camera comes and the lean rides on that answer — re-tracing
would let a few degrees of lean quietly widen the framing the cap had chosen. EPIC.WAD MAP02 at
(-4184, -2611) is the case it was added for: 250u at 52° framed the pit walls, 250u at 62° frames
the room the player is about to walk into.

**Two smoothing rates on purpose.** Both measured opennesses are damped at `OPENNESS_SMOOTH_RATE`
(1.5/s) inside `AutoCamera` — the ~1 s "breathing" of the framing — while the camera's own
`distance`/`tiltDeg` chase their targets at the much faster `FRAMING_SMOOTH_RATE` (10/s,
`camera.ts`). The split keeps the two dials independent: manual-mode key response stays snappy
while auto stays gentle.

**Framing is simulation state**, exactly like the follow point and yaw (§ The camera is
simulation state): `AutoCamera.tick` runs on the tic clock — after movement, so the probe sees
this tic's position, and before `camera.tick`, whose damping step advances toward the fresh
target — and `TopDownCamera` interpolates `prevDistance`/`prevTiltDeg` per frame in
`applyToCamera`. The aim ray reads last tic's settled framing at alpha 1, the same one-tic lag
the yaw has. `distance`/`tiltDeg` are read-only, and have the two routes `yawDeg` has:
`snapFraming(distance, tiltDeg)` **jumps** (value, target and prev together, the framing twin of
`snapTo`), `targetDistance`/`targetTiltDeg` glide.

**A level load seeds, a teleport glides.** `AutoCamera.seed` clears `initialised` and delegates to
`tick` — which is what makes that one measurement unsmoothed — then `snapFraming`s the result,
called after the spawn yaw is set (so `ahead` already looks the way
the level opens) and before the follow point's `snapTo` so the snap poses the
camera already framed and a level never opens mid-zoom. `seed` and `tick` are both no-ops in
manual mode, so the mode gate lives with the setting's owner rather than at each call site. A
teleport deliberately does *not* re-seed: the position must cut, but a zoom/tilt cut is itself a
lurch, and the damped settle to the destination's framing reads as intended.

**Framing is not in the save format**, and does not need to be in auto mode: it is a pure
function of world state, position and yaw, so a restore recomputes it through `seed`. In manual
mode it is a player choice that simply isn't persisted — a restore keeps whatever the session's
camera already holds, since the camera outlives the level.

The hard envelope — `MIN/MAX_CAMERA_DISTANCE` (200/2400), `MIN/MAX_TILT_DEG` (10/70) — is
enforced by `TopDownCamera` itself, on both the jump route (`snapFraming`) and the glide route
(`targetDistance`/`targetTiltDeg`), so no writer has to remember it: the
manual keys just add their step and saturate. The auto camera's own endpoints sit inside it, so
in practice only the manual keys ever reach it.

**One route has a lower floor**, and it is the reason there are three rather than two.
`autoDistance` is `targetDistance` clamped to `MIN_RESCUE_DISTANCE` (64) instead, and `snapFraming`
takes the same floor since `AutoCamera.seed` is its only caller. Everything the auto camera writes
goes through those two; `targetDistance` is left as exactly "the route the manual keys share", which
is the framing 200 was always there to protect. The rescue below is what needs the lower floor: a
distance a player would never dial by hand, asked for by geometry rather than by taste.

### Framing past an occluder

A wall standing between the camera and the player is not a failure — it is the ordinary case in a
top-down view of a game built out of rooms, and docs/render.md § The fade is a hole, not a wall is
what handles it. What the fade cannot do is make the player *big*: it opens a hole by discarding a
fraction of the
occluder's pixels, so what shows through is the player seen past a fifth of a wall, and at the wide
end of the framing that is a thirty-pixel sprite behind a dither. So while something the camera
cannot see over is drawn across the sightline the zoom comes **inside it** — `nearestObstruction`
returns how far off it stands, and the framing takes that less `OCCLUDER_STANDOFF`, floored at
`AUTO_OCCLUDED_DISTANCE` (250u), nearer than `AUTO_NARROW_DISTANCE` ever goes.

**The floor is a floor, not the answer**, and the difference is the whole point. A wall at the
player's shoulder can never be got in front of, so the framing stops at 250 and accepts being read
through a dither: EPIC.WAD MAP02 at (-4184, -2611) is that case, the player in an unlit side room
behind one wall, unreadable at 400u and plain at 250u. A wall half a level off costs almost nothing
— EPIC.WAD MAP05 at (3248, -5361) stands in open sand with a tower ring 561 units out, and coming to
505 clears it while a flat 250u cap threw away a third of the view for no reason anyone standing
there could see. That asymmetry is why one ray returning a *distance* beats the same ray returning a
verdict; it costs nothing extra, since the crossing distances along the ray do not depend on how far
out it was cast. Measured over every thing position at eight yaws, the framing moves on 0–17% of
poses for a mean of roughly 120 units, and on about four fifths of those the occluder really is
nearer than the floor — the back-off-a-little case is the minority, and the one nobody can see a
reason for.

**Height is the other half of "can it hide the player", and the camera's own eye is what settles
it.** A wall whose top the eye only just clears is seen along its face at a grazing angle: it
stretches most of the way from the camera to the player, and the fade's fixed-size hole — a ball of
`FADE_RADIUS` around the crossing, docs/render.md § The fade is a hole, not a wall — cannot dissolve
enough of it. A wall the eye hangs well over is seen from above, covers little, and the fade has it
comfortably.
So `standsOver` counts a band only if its top reaches to within `OCCLUDER_HEADROOM` (64u) of where
the eye would be at the framing under test. EPIC.WAD MAP02 at (-4380, -1837) is the case this came
from: a 128-high wall 177 units out that the camera at 720u looks over by 115, dissolved by the fade
without trouble, and pulling the framing to 250 there threw away most of the view for something
nobody could point at. The same test keeps the two cases that do need it — EPIC MAP05's tower ring
is cleared by 31 and EPIC MAP02's side room by 16 — and it is what takes the framing from moving on
10–33% of poses to 0–17%.

**Facing is what makes the test usable, and is easy to leave out.** Wall materials are
`THREE.FrontSide` (`render/textures.ts`) and `addWall` hangs each quad on one sidedef, so a wall is
drawn for the side it belongs to and is simply not there from behind. A room's own wall between the
player inside it and a camera hanging outside therefore hides nothing — what faces the camera is its
missing back. Without that half the test fires on 35–56% of poses and pulls DOOM2 MAP01's opening
room in from a view that is perfectly clear; with it and the height half together, 0–17%, and
MAP01's start reads as unobstructed, which it is. **Which quads exist, and how tall they stand, is
not decided here at all**: `hidesFromCamera` calls `mapmesh.ts`'s `twoSidedBands`, the same function
`addTwoSidedSide` sizes its quads from — the lower on the **lower-floored** side, the upper on the
**higher-ceilinged** side, the upper not at all when both sides are sky, and ceilings never, so
nothing above the top of a wall can hide anything.

That shared call is the point, not a convenience. The heights those bands are measured between are
the **drawn** ones, resolved through Boom's 242 transfers (`Transfers.drawnFloor`, `ceilingFacing`),
and they part company with the raw sector heights exactly where deep water is: the wall across from
a 242 sector is drawn down to its *control* sector's ceiling, so a room facing one draws an upper
reaching far below the `ceilHeight` that sector carries. Read off the raw heights the camera was
blind to that whole stretch — a sightline crossing it found nothing standing there while the mesh
was drawing a wall — which is what having two copies of the rule cost. `AutoCamera` is handed the
level's transfers for this; a caller with none (tests, tools) gets `ownTransfers`, every sector
drawing itself, the same default the mesh builder takes.

**Middle textures are left out on purpose**: a railing must not pull the camera in, and a solid one
hung in an opening is now the fade's business (docs/render.md § The fade is a hole, not a wall),
which needs no help from the framing. Heights are read live off `map.sectors`, so a door or a lift
needs no case of its own.

**The zoom stays undirected; the cap does not, and cannot.** § Auto camera's rule — that `spread`
drives the zoom because how much room surrounds the player is a property of the place rather than of
where they are looking — is about the *framing*. Whether a wall hides the player is inherently a
question about the direction the camera hangs in, so this cap rides on top of that framing rather
than inside it, and a Q/E step can change it. `tests/game/autocamera.test.ts` still pins the
undirected framing itself, and passes: a dead end faced from outside registers no occluder at all,
which is the facing rule doing its job.

**It breathes at the openness rate rather than stepping.** Walking on and off a sightline is abrupt,
and the raw answer flips roughly every 400 units walked. `smoothedFraming` damps the distance itself
at `OPENNESS_SMOOTH_RATE`, the same unhurried breathing the two openness dials have — so what a
flicker produces is a framing that drifts, never a step. The buried-eye rescue below runs on top of
whatever this leaves, with its own faster damper, because being underground is not something to ease
out of.

### The buried-eye rescue

A camera hanging 350–720 units back can end up with its eye **under a floor** — beside a plateau,
in a pit, under a lift that has risen past it. Nothing can be done with that view from where it is:
the ground the eye is inside is drawn, and what the eye then looks through is the underside of it.
So `AutoCamera.tick` **searches both framing dials** for the nearest zoom-and-tilt pair whose eye is
clear, writing the distance through `autoDistance` and its lower floor and the tilt through
`targetTiltDeg`.

**This is only about being buried, and deliberately not about being blocked.** A wall standing
between the camera and the player is the *normal* case in a top-down view of a game built out of
rooms — it is what docs/render.md § The fade is a hole, not a wall exists for, and a rescue that
fired on it would fire constantly. Measured over every thing position at eight yaws: a "the
sightline crosses drawn
geometry" rescue fires on 35–56% of poses and pulls DOOM2 MAP01's start from 435u to the 64u floor
in a spot whose view is perfect. The buried test fires on 0% of poses on DOOM2 MAP01/MAP02/MAP07 and
E1M1, 0.1% on E1M3, and 5.8% on EPIC MAP05, a map built out of plateaus — which is the shape a last
resort should have. Two intermediate criteria were tried and rejected on counter-examples from the
same sweep: how far the sightline runs through solid (38u at the case that prompted this, less than
an ordinary room wall) and how many drawn faces it crosses (MAP01's nukage secret at (528, 2624)
crosses two and looks fine).

**Ceilings are what make the asymmetry right.** `mapmesh.ts` never emits them (`renderCeilings`),
so an eye above a room's ceiling sees straight down into it and only a floor can bury it.
`eyeBuried` therefore reads floor heights alone — live ones, off `map.sectors`, so a lift rising
into the camera reads on the next tic and mover geometry needs no special case. It has one known
gap: a void solid drawn as a cap (`render/solids.ts`) has no sector to read a floor from, so an eye
inside a pillar is not caught.

**One ray of candidates covers every distance.** The eye at distance `d` is
`playerEye + d * u` for the direction the current tilt and yaw give, so the whole family of
candidate positions lies on a single ray out of the eye and backing off is a walk down it in
`CLEARANCE_STEP` (24u) steps — the first clear step is the answer, and the common case costs one
lookup because the framed distance is already clear. The eye must clear the ground by
`CLEARANCE_MARGIN` (32u): an eye scraping the surface sees a plane edge-on through an 8-unit near
plane, which reads no better than being under it. The ray is cast from the player's eye, so it
ignores the aim lead's offset of the follow point (up to 220u) — the rescue is a floor on the
framing, not a promise about a particular pixel.

**Nothing deciding the framing may read the pose the camera is currently gliding through.** The
rescue steers the tilt, so a rule that read `camera.tiltDeg` back would close a loop around a step
function — the search's answer changes in 5° jumps — and a damper gliding across one of those
thresholds reverses itself: the tilt limit-cycles instead of settling. `tick`'s occlusion trace,
its lean and its rescue therefore all run at `mapTilt()`'s own angle, which depends only on the
place, the yaw and the two smoothed opennesses. The cap is then measured a few degrees off where the
camera ends up; that inaccuracy is bounded by `NEAR_TILT_LEAN` and stable, which is the right way
round. `tests/game/autocamera.test.ts` pins it: dragging the camera's *current* pose to either end
of the tilt envelope and taking one more tic must give the same targets.

**Searching beats moving in one hand-picked direction, because which direction even exists is
geometry.** Coming *nearer* clears a plateau the camera would otherwise hang over. Backing *off*
clears the rim of a shaft the player stands at the bottom of, since the eye rises along its own ray.
Changing the *tilt* trades one against the other, a steeper look needing more distance to reach the
same height. Each of the three was tried alone while this was built, and each fixed one map while
breaking another: the zoom-only rescue collapsed DOOM E1M2's lift at (-1534, 1584) to its 64u floor
— near-first-person for a player standing on a lift — while a tilt-only response traded EPIC MAP05's
approved 505u ring framing for a flat look across the ring's top. `rescueFraming` therefore searches
distance from `MIN_RESCUE_DISTANCE` to `limit` and tilt across the camera's whole envelope, rejects
anything `framingBuried`, and takes the survivor **nearest the framing the openness dials asked
for**. At that lift it lands on 400u at the mapped 53°, an eye 33 units over the rim.

**The tilt half only ever leans further off vertical, never back toward top-down.** Turning overhead
is the cheap way to lift a buried eye — it beats any distance change on cost, and measured over
every thing position at eight yaws an unrestricted search takes it on up to 1.2% of poses and by as
much as 45°. But it buys that height by spending exactly what a shut-in framing is already short of:
sight of what the player is walking into. It also pulls against the near-tilt lean (§ Auto camera),
which leans the other way for the same reason. So the rescue leans over or holds, and where neither
that nor the distance clears — a cliff the camera can only get above by going overhead — pulling in
is the fallback rather than a plan view. With the restriction the same sweep tilts down on 0% of
poses everywhere and up on at most 0.45%.

**Nearness weighs a degree against a unit by each dial's own span** — 370 units of distance
(`AUTO_NARROW_DISTANCE`..`AUTO_WIDE_DISTANCE`) against 20° of tilt
(`AUTO_NARROW_TILT`..`AUTO_WIDE_TILT`) — so one full swing of the zoom costs the same as one full
swing of the tilt. Those are the ranges `spread` and `ahead` themselves sweep, which makes the trade
a statement about the framing rather than a tuned number. The walk visits candidates in ascending
cost on each axis and breaks as soon as an axis alone is dearer than the best so far, so a clear
framing costs one lookup and a rescued one a few dozen — and the rescue runs at all on 0–5.8% of
poses.

`limit` is `AUTO_WIDE_DISTANCE` (the widest framing the openness mapping would ever pick on its own
— `MAX_CAMERA_DISTANCE` is the manual envelope, not a framing anyone chose) **capped at the
occlusion cap's own distance**, since zooming out past a wall the framing just came inside of would
re-hide the player: EPIC MAP05's tower ring stays at its trimmed 505u because the ring is its
outward limit. A wall at the player's shoulder can put `limit` under `MIN_RESCUE_DISTANCE`, leaving
the search no candidate at all; pulling in (`measureClearance`) is the fallback for that, and for
the vanishingly rare burial nothing in the envelope escapes. While the search owns a burial the
inward clamp is skipped, so the two never fight over one; its escape is damped at
`CLEARANCE_IN_RATE` — the eye is inside the ground *now* — and both dials ease back at the openness
rate once the burial is gone.

**The clamp is damped asymmetrically**: in at `CLEARANCE_IN_RATE` (8/s) so a real burial clears
before the player has walked out of it, out at `CLEARANCE_OUT_RATE` (1.5/s), the same unhurried
breathing as the openness dials, so a candidate grazing a step edge for a tic or two barely moves
the framing. Because the answer does not depend on the camera's *current* distance, the clamp cannot
hunt: it is a property of the place and the direction, not a feedback loop.

