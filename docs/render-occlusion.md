# Wall occlusion fading (`occlusion/`, `textures.ts`)

`src/render/occlusion.ts` + `occlusion/`, `src/render/textures.ts`,
`src/game/specials/movergeometry.ts`

How a wall or a raised floor between the camera and a body dissolves so the body stays visible:
the hole, the two passes that open it, what it aims at, and what keeps it cheap on a map of
hundreds of thousands of quads. The mesh it fades is docs/render.md; fog of war, which shares the
alpha channel, is docs/fogofwar.md.

`occlusion.ts` is the entry point and holds `FadePass` and `collectFadeTargets`.
`occlusion/defs.ts` holds the hole the ramp shapes, the sight boxes and the crossings bag both
faders file into; `walls.ts` and `flats.ts` hold the two faders.

Single-sided back-face culling only removes walls facing away from the camera; it does nothing about
a wall that legitimately faces the camera but sits directly on the camera→player sightline (a pillar
in front of the player). `WallFader` tests every wall quad's 2D footprint against that sightline
each frame and fades the ones that cross it, rather than the coarser fix of drawing the player on
top of everything, which would also show it through walls that genuinely separate it from the
camera.

## The fade is a hole, not a wall

Fading a wall as one unit dissolved a whole room's wall to show a player standing at one end of it.
So **`addWall` cuts every wall into chunks of at most `WALL_CHUNK_LEN` (128 units) in *both*
directions** — along the wall and up it — and every chunk carries its own alpha at each of its four
corners. `update` then runs in two passes:

1. **Where is the view actually blocked.** Per line side, `segmentCrossT` against each target's
   camera→target sightline; a crossing counts only where some non-passable quad's `[botH, topH]`
   spans the crossing height. Each such crossing is filed as a point `(x, y, h)` plus the index of
   the target it was stopped for, once per line side per target however many tiers it passes
   through — everything else about the hole is a property of that target and lives with it
   (`TargetPlanes`).
2. **Dissolve a ball around each crossing, cut off at the target.** Every chunk corner within that
   crossing's own radius, and on the camera's side of the plane through the target, is pulled toward
   its floor: full strength inside half that radius, eased out by the whole of it. Each corner
   measures from its **own height**, so the hole rounds off vertically as well as along the wall.
   Where several crossings reach one corner, the lowest alpha wins.

**The hole stops at the target, and does not carry on past it.** A ball centred on the crossing
reaches as far behind the target as in front of it, and everything it dissolves back there was never
hiding anything: the target is already in front of it. In a small room that is the whole room — DOOM
E1M2 at (-1906, 1056) stands in a 72-unit-high closet whose east wall is crossed 50 units away, and
a 192-wide ball around that crossing took the west wall (linedefs 696 and 884, the ones the player
is *facing*) with it, leaving a room with no walls and a floor that ran on into the next one. So
each target carries the plane its own sprite stands in (`TargetPlanes`), and a corner past that
plane is skipped outright rather than folded (§ The target is the billboard, for which plane that is
and why it is vertical).

**Both cuts are load-bearing, and the vertical one is easy to forget.** With alpha written only at a
quad's left and right edges the hole is a disc in plan view, which on screen is a full-height band
of wall with hard vertical sides — indistinguishable from the whole-wall fade it replaced, and the
first thing a player notices. Banding the wall is what gives that gradient somewhere to turn over.
Where a wall does not get it, a tall one cannot be faded at all: its corners are hundreds of units
from any sightline crossing its middle, and the ramp is 192 wide. That is the one place a mover
mesh had to withhold it, and docs/render.md § A mover dices vertically only where nothing moves is
how far that now goes.

**The split between the passes is the point.** An earlier version ramped along the crossed line
instead — distance from the crossing measured *within that linedef* — and DOOM walls are built from
many short linedefs, so the hole was clipped to one panel: measured over 72 camera poses at the
`fading1-E1M3` savegame's position, 79% of faded line sides faded end to end and 78% of them butted
straight against a line left fully solid, giving a hard-edged rectangular hole. Half those lines
were shorter than a single chunk, so no amount of chunking could have helped. With the ball the
same measurement gives 4%, and what is left is mostly a genuine step up to a wall in a different
height band rather than a seam.

Continuity is by construction rather than by bookkeeping: adjacent chunks share their common corner
position, and so do adjacent *linedefs* at a shared vertex, so every wall meeting at a point
computes its alpha from the same distance and the gradient crosses both kinds of joint smoothly.

**`FADE_RADIUS` and `FADE_CORE` are the two dials for the size of the hole the *player* opens** —
its outer edge and its full-strength middle — and both faders read both, so a hole spanning a floor
and the wall behind it is one shape rather than two. `holeAlpha` takes the radius per crossing and
cores at `FADE_CORE_FRACTION` of it, so a target that opens a narrower hole (§ Which sightlines a
wall fades for) opens the same shape scaled rather than a second one. That fraction is where the
core is actually set: `FADE_CORE` is the player's radius *through* it, exported for the tests, so
the ramp and the constant they assert against cannot drift apart. They are feel dials in the strict
sense: `tests/render/occlusion-fade.test.ts` **imports them and sizes its fixtures from them**
rather than mirroring their values, so either can be retuned without a test going red. A test that
reddens on a retune is pinning the dial, and is a bug in the test.

**One relationship is not optional, and was learned the hard way.** Alpha only exists at chunk
corners, so a crossing lands `WALL_CHUNK_LEN / 2` from the nearest one at worst, and a `FADE_CORE`
under that cannot open a hole wider than a single chunk however the ramp is shaped. On a short wall
one chunk is a perfectly good hole. On a **tall occluder seen at a grazing angle** it is a slit:
EPIC.WAD MAP05 at (3273, -5737) stands beside a 256-unit ring wall whose top the camera eye clears
by 35 units, so the wall fills the frame and one chunk of hole across it showed a staircase and no
player at all. `FADE_RADIUS` is therefore sized off the chunk — `WALL_CHUNK_LEN * 1.5`, so
`FADE_CORE` is `WALL_CHUNK_LEN * 0.75` — rather than set as a bare number. The old 96/48 sat
*below* the relationship this paragraph has always described. Measured at that spot: 96 and 128 hide
the player, 160 shows him through heavy dither, 192 shows him cleanly, and 400 turns the level to
swiss cheese. DOOM2 MAP01's opening room and E1M1's corridor are indistinguishable at 192 from what
they were at 96. The flats half has the same shape (§ Flats), and the test asserts whichever of the
two applies at the current setting rather than picking one.

The real invariant is elsewhere: the crossing point is *not* `segmentCrossT`'s return value — that
parameter runs along the sightline, not along the wall; `update` interpolates the point from it.
That one is pinned down in `tests/render/occlusion-fade.test.ts`.

**Neither fader looks at geometry no sightline can reach.** Every sightline this frame runs from
the camera to one of the targets, so all of them lie inside the bounding box of the camera plus the
targets — and a line side (or a fan's bounding circle) outside that box cannot be crossed by any of
them. That is exact, not a heuristic, and on a map with tens of thousands of quads the camera holds
a few hundred units of it, so the box rejects nearly everything.

`WallFader` takes it per line side, ahead of the `openingInto` lookup and the `n` crossing tests
that would follow. `FlatFader` takes it *once for the frame* rather than per target, which matters
more: what it replaced was a walk over every fan on the map per target, with no index of any kind
(`WallFader` got its grid in the same work and `FlatFader` did not). The per-frame filters — a
ceiling, a fan above the camera, a fan already translucent — fold into the same pass, leaving the
per-target loop carrying only what varies with the target.

Measured on EPIC.WAD MAP05 (24,052 occluders, 8,324 fans) at 49 targets: `WallFader.update` 1.12 →
0.32 ms, `FlatFader.update` 0.97 → 0.10 ms.

Whether a quad is its line's **passable gap** rides on the same idea. It used to be decided for
every quad every frame, up front; it is now asked lazily — of the quads a sightline crosses in pass
one and the quads a crossing reaches in pass two — and at most once per quad per frame. On a frame
where the camera holds a few hundred units of a big level almost no quad is asked at all.

Pass two would be quadratic scanned naively, so `WallFader` buckets quads by midpoint into a
uniform grid (cell = `FADE_RADIUS` + the longest half-chunk, which is what lets a query stop at
3×3) and each crossing only visits the quads around it. Below `GRID_MIN_OCCLUDERS` it scans instead,
the cell walk costing more than a short list's scan. A mover fader is not excluded and a big one
does build a grid: the buckets are keyed on quad midpoints, and `refreshMoverMesh` changes heights,
never a quad's footprint — a rebuild that *does* reshape the mesh builds a fresh fader with it.

**Mover geometry is never banded vertically** (`addWall`'s `bandVertically`). A mover's walls change
height on every refresh, so a height-derived band count would change with them, and `refreshMoverMesh` may
only rewrite buffers whose quad count held still (docs/render.md § Mover meshes) — banding them
would force a full rebuild per refresh and restart every fade mid-motion. Doors and lifts are short
enough that one band is what they would get anyway.

Measured on EPIC.WAD MAP02 (the heaviest map to hand: 6,582 line sides), both cuts together take
wall quads from 6,795 to 11,602 and the whole fade pass from 1.10 to 1.16 ms/frame at 25 targets;
level mesh build goes 21 → 57 ms, once per load.

### Nothing per-frame is per-quad

The sight box, the lazy passable test and the grid all bound the *work a crossing does*. Three
whole-array walks were left over that a huge map still paid in full, and Sunder 2512 MAP20 is where
they stopped being invisible: **408,705 wall quads**, of which a frame fades a few dozen.

- **Pass one walks line sides, not quads.** The box test and the crossing solve were always per
  line side; the loop under them was per quad, so a rejected side still cost one iteration for each
  chunk and tier it had been cut into. `WallFader` records the runs of quads sharing a line side
  once (`buildRuns` — `addWall` emits them consecutively) and pass one walks *those*, reaching a
  run's quads only once its own segment is inside the box.
- **Only unsettled quads are reset and damped.** `wanted.fill(1)` and the damping sweep both ran
  over every corner on the map. A quad is on the `active` list from the moment a crossing folds it
  until it has relaxed all the way back to 1, and those two passes now walk only that list. A
  settled quad is held one extra frame (`settledStamp`) so the `commit` that follows still writes
  the value it came to rest on — dropping it the same frame would leave that last write unmade.
- **`commit` writes what changed, not what exists.** Its two inputs move in known places: this
  frame's fade knows its own quads (the `active` list) and fog of war names the ones a reveal
  moved (docs/fogofwar.md § Which walls a reveal moved), so `commit` visits their union. It falls
  back to every quad when a partial pass can't be trusted — the first commit after a build
  (`lastCombined` starts NaN), a `trackVisibility` fader (`maxAlphaByKey` is only as complete as
  what the pass visits, which is why the mover faders still walk their own quads in full), or a
  caller that passes no change list at all.

Measured on that map at the MAP20 player start, 1 target: `WallFader.update` 6.36 → 0.30 ms/frame,
`WallFader.commit` 5.50 → 0.01 ms/frame. DOOM2 MAP01 is unchanged at both (already under 0.05 ms).

## One hole, whichever mesh it lands in

A level's walls are not in one mesh. The static batches hold most of them and **every movable
sector owns its own** (docs/render.md § Mover meshes), and each of those carries its own
`WallFader`/`FlatFader`. Pass one is per fader — it can only cross the sightline against the walls
that fader holds — so a fader that owns none of what a sightline was stopped by files nothing, and
pass two over its own empty bag dissolves nothing. A door built into a wall a few units from where
the sightline crosses it was therefore the one slab that stayed solid, in a hole that opened
everywhere around it.

So **the crossings are the frame's, not the fader's**, and **`FadePass` owns that order** rather
than the frame loop: it holds the static wall/flat faders and one `FadeCrossings` for each, and its
`run` resets both bags, runs `collectCrossings`/`collectPierces` on the static faders *and* every
mover mesh (`MoverGeometry.collectFadeHits`) into them, and only then lets
`applyCrossings`/`applyPierces` fold. The mover meshes reach it as a `FadeParticipant` — structural,
so the render layer keeps no import edge into `game/specials.ts`, the `ScrollOffsets` rule — and fog
of war as a `FadeReveal`. Two bags rather than one: a wall crossing and a floor pierce are different
points and fold different geometry (a pierce is matched against a fan's exact height).

Keeping the sequence in one method is the point: a reset that a caller forgets, or a `collect` that
lands after someone else's `apply`, is exactly the bug this section is about, and nothing in the
signature would have caught it. The movers' own pass two runs there too, ahead of the scrollers and
texture animation it used to sit behind — it reads `changedBounds`, whose fallback flag is separate
from the `changedWalls` one the wall commit consumes (docs/fogofwar.md), so the two are order-free.
`game.ts` is left with one call.

Sunder 2512 MAP22 at (-560, 219) is the case — the wall at x = -512 the camera looks over is five
short line sides, of which the middle one (linedef 60) is lift sector 90, and the player's crossing
lands at y 219 in the static line beside it.

Two rules keep that from costing what it looks like it should. **The reach gate is unchanged and
still exact**: a crossing lies on a sightline, so inside the sight box, and folds nothing further
than its own radius — which is what `fadeReach` already grows the box by, so a mover mesh outside it
can be skipped by a shared bag exactly as it was by its own. And **a fader rejects a crossing
against its whole footprint first** (`WallFader.footprint`, boxed as `buildRuns` walks the quads
since a refresh never moves a quad's footprint): mover faders are small, numerous, and hold no grid,
so without that box each of them would walk all its quads per crossing.

The bag carries **its own bound** (`FadeCrossings.bounds`, grown in `push`), which is what makes the
sharing pay for itself in both halves. `applyCrossings` tests the fader's footprint against the
whole bag once and skips the fold entirely when nothing can reach it — the case sharing created, a
mover awake only because it is still damping, which used to be handed its own empty bag and would
otherwise walk every crossing on the map to throw them all away. What it must *not* skip is the
damping that follows: that is what such a fader is awake for, and returning early there strands a
faded mover part-way. `FlatFader` gets no footprint box, because its fan loop cannot be skipped for
the same reason — but `applyPierces` tests each fan's bound circle against the bag's box once, which
is the per-pierce circle test it already ran hoisted out of the pierce loop. That was worth taking
on its own: a map diced to tens of thousands of fans used to pay one compare per fan per pierce on
the whole map. Deriving that box per fader instead would have cost a walk of the bag per mesh.

`WallFader.update`/`FlatFader.update` still run both halves over the fader's own bag — the right
thing for a fader that is the only one on the map, which is what the tests build. Nothing in `src/`
calls them, so that bag is allocated on first use: a level's thousands of mover faders never take
it.

Measured on Sunder 2512 MAP19 (340,372 wall quads, 54,388 fans, 748 mover meshes) at the player
start with 25 targets, medians of 300: sharing costs the wall half 0.46 → 0.54 ms, which is the
crossings the movers file now reaching the static batches — the fix, not overhead. The flat half
goes 0.87 → 0.45 ms on the bag box, so the pass as a whole comes out ahead: 1.43 → 0.99 ms. MAP20
(1,533 movers) measures the same either way, and DOOM2 MAP01 stays under 0.03 ms either way.

## The target is the billboard

**Both faders aim at an upright rectangle, not at a point.** A thing is drawn as a plane fixed
upright in the world that only turns about its vertical axis (`SpriteMaterialCache`,
docs/sprites.md), and `FadeTarget` says so: `z` is the middle of that rectangle and `halfHeight` how
far it reaches either side. Two rules follow, and both were bugs before they were rules —
`BOOMEDIT.WAD` MAP01 at (-1664, 713), looking south over the scrolling-texture block at y 768..800,
is the case they were found on.

**Every target's rectangle is its own body.** A monster carries its `mobjinfo.height` — 56 for an
imp to 110 for a cyberdemon — from `MONSTER_STATS` through `PosedThing.bodyHeight` and out of
`ThingLayer.awakeMonsters` as `StandingBody.height`; the player gets `PLAYER_HEIGHT`. Either way
`FadeTarget.z` is the middle of that span and `halfHeight` reaches from there to the feet and to the
crown, so the wedge covers the body exactly. It is the same centre-and-half-extent `shotPath` locks
onto (`ShotLock.halfHeight`, docs/combat.md § Auto-aim) built from the same field, and it is
DEHACKED-aware for free: a patch that retunes a height moves the fade with it. One shared
player-sized band was the earlier shape, and it failed the very case this section exists for — a lid
covering only a cyberdemon's head sits well above where that band reached.

The height is the **collision** height, not the drawn sprite's. The sprite lump's own height is what
the billboard measures on screen and is often the taller of the two, but `mobjinfo.height` is what
every other "where is this body" question in the engine already answers with, and a fade disagreeing
with the shot that follows it would be worse than one running a few units short.

**The cut plane is vertical.** Nothing behind the plane an upright sprite stands in can draw over
that sprite, so a corner past it is skipped; the plane is `TargetPlanes`' `(nx, ny, d0)`, the
camera→target offset *in plan*. A plane tilted to face the camera instead leans back over the target
by the camera's own pitch, so geometry that is well past the target but tall counts as in front of
it: at that MAP01 spot the boundary wall 73 units *behind* the player (linedef 148, `BROWN1`) had
its top corners 11 units on the camera side of a tilted plane, and dithered away to reveal the void
behind it. The normal is deliberately **not** unit length: every test compares two dot products
taken against that same normal, so scaling it changes neither side, and skipping the normalise
matters at the thousand-odd mover faders a frame refills. Being vertical, it also costs one dot
product per quad *end* rather than one per corner, since a quad's four corners share their two ends'
answer.

**And the sightline is a wedge, not a ray** — from the eye to the whole rectangle, so it is the
sprite's own half-height thick at the target and nothing at the camera. `WallFader` counts a
crossing where a quad's `[botH, topH]` meets that wedge rather than the centre ray alone;
`FlatFader` crosses a floor's height plane over a *span* of the camera→target line — nearest the
target for the sprite's top, furthest for its feet — and pierces where that span meets a fan
(`segmentMeetsConvexPolygon`), rather than at the single point the centre ray lands on. Without it
anything covering only the upper half of a sprite is invisible to the fade: at that MAP01 spot, with
the camera around 40° off vertical, the lid on top of the block (docs/render-solids.md § Solid
structures) cut the player's head off while the wall under it dissolved, because the ray to the
player's *middle* passes under that lid and only the ray to their head goes through it.

The pierce is still filed at the point the centre ray lands on, not at whichever end of the span a
fan happened to catch: the dedup that lets one platform split into many fans file a single pierce
turns on a point that depends only on the height and the target (§ Flats), and an end clamped per
fan would file one pierce per fan instead.

Neither rule costs anything overall. Measured on the same EPIC.WAD MAP05 map the numbers above are
taken on, at 49 targets, medians of 200 updates: `WallFader.update` 0.86 → 0.76 ms — the vertical
plane is two multiplies per *quad* cheaper (the old tilted one already shared its height term across
a quad's four corners), and a quad's four corners now share its two ends' answer — against
`FlatFader.update` 0.062 → 0.108 ms for the span, which pays for the two extra crossings and the
edge walk that replaces a point test.

Three things keep that second figure from being worse, and all three are load-bearing where the
per-fan loop runs candidates × targets a frame. The three heights the span needs **share one
reciprocal each per target**, so the per-fan work is a multiply rather than a divide. The
bounding-circle reject **runs on the span's parameters, not its endpoints** — a fan's centre is
projected onto the camera→target line and clamped to `[tFar, tNear]`, which is seven multiplies and
no divide, and means a rejected fan never builds the four coordinates only the footprint walk wants.
And each fan's **winding is memoised** in `buildLayout` beside its bound circle (`windSign`),
because `segmentMeetsConvexPolygon` needs to know it and a shoelace pass per fan per target per
frame would re-derive it over rings that only a mover rebuild reshapes.

## Which sightlines a wall fades for

`WallFader.update`/`FlatFader.update` take a *list* of sightline targets (`FadeTarget[]`), not just
the player — `collectFadeTargets` (same file, called from `game.ts` with `Game.fadeBodies`:
`ThingLayer.awakeMonsters` and every other living player slot) returns the player plus every
currently-**awake** monster or other player
within `MONSTER_FADE_RANGE` (a plain 2D distance cap, tuned by feel to
roughly a room/corridor's length), nearest first and truncated to `MAX_FADE_TARGETS` (48) — the
per-frame cost is quads times targets, so the cap is what stops a crowded room from being the
expensive case. A quad fades if it sits on any one of those sightlines. Both
gates matter: a sleeping monster isn't being tracked yet, so there's no reason for a wall to reveal
it early; and without the range cap, an alerted monster dead-reckoning toward the player from across
the level would fade every wall along that line. The range cap is deliberately a plain distance, not
a `hasLineOfSight` check — an earlier version required unobstructed line of sight, which made the
fade a no-op for exactly the case it exists for (a wall genuinely hiding a nearby monster also means
`hasLineOfSight` is false, so the monster never became a fade target and the wall stopped fading).
`MoverGeometry.updateFading` (doors, lifts — reached through `SpecialsController.fadeParticipant`)
takes the same target list, reusing the identical machinery for its own meshes.

**Each target carries its own strength** (`FadeTarget.fadeFloor`, how far down it alone pulls what
hides it). The player is always `FADE_ALPHA`; a monster's eases linearly from that at the player's
own position back to 1 — no fade at all — at `MONSTER_FADE_RANGE`. Two dozen awake monsters
fanning sightlines out from one camera used to gut a room between them, each at full strength; and
a flat cap fading at full strength right up to its edge popped a wall the moment a monster crossed
it. Where several targets cover one edge, the lowest alpha wins.

**And its own height** (`FadeTarget.halfHeight`) — a monster's `mobjinfo.height`, the player's
`PLAYER_HEIGHT`, so each sightline is a wedge fitted to the body it aims at (§ The target is the
billboard).

**And its own hole size** (`FadeTarget.fadeRadius`), which for a monster is half the player's
(`MONSTER_FADE_RADIUS`). The reason is not cost. The player's hole is centred on the one place the
view has to be readable, so what it dissolves is what you were looking at anyway; a monster's is
centred somewhere else entirely, and everything it dissolves is context you wanted. EPIC.WAD MAP02
at (-4368, -2576) is the case: standing at a skull switch with a spectre 311 units off directly
beyond the wall it is on, the monster's sightline crosses that wall a few units from the player, and
a `FADE_RADIUS`-wide hole there took the switch with it. The narrower hole gives up the whole-chunk
guarantee § The fade is a hole, not a wall insists on — a monster behind a tall wall seen edge-on is
read through a slit — and that is the right trade for a target you need to *notice* rather than to
frame.

`WallFader.update` also takes an `openingInto` callback (`World.openingInto`, threaded through so
this class needs no `World` reference — the allocation-free form, since chunking made a per-quad
record allocation per frame expensive) and skips fading any quad whose own `[botH, topH]` sits
*inside* its line's vertical opening **and whose texture is masked** — a grate, fence or barred
window is built inside that opening (docs/render.md § Mesh building), so a quad living inside it is
the passable gap itself: a shot and a look already pass straight through it, so fading it has
nothing left to reveal.

**The masked half used to be assumed rather than asked, and that was the bug.** Nothing stops a map
hanging a *solid* texture in a full-height opening and calling it a wall — EPIC.WAD MAP05 at
(3231, -5243) is screened by a curved run of two-sided lines carrying `EBIGBRIK` over a 0..1288
opening, and with the premise unchecked it was the one thing on the map that never faded at all,
which reads as the fade being broken rather than exempt. `WallFader.masked` reads it off the batch's
own material: `MaterialBank.get` sets a non-zero `alphaTest` for exactly the bitmaps with fully
transparent texels, and `setFrame` deliberately holds that across an animation's frames, so it is
stable to read and worth memoising per batch key. Censused over the maps to hand, what changes is
only the fake walls: DOOM2 MAP01 keeps both its masked middles (`MIDBARS3` — the imp closet below —
and `BRNSMAL1`) exempt and has no solid ones at all, MAP02 and MAP07 have no middles, and on EPIC
MAP05 the vines, rails and windows stay exempt while `ESTEP02`, `EBIGBRIK` and the rest of the
mapper's fake walls start fading. It is not free: at that spot, fading goes 0.98 → 1.31 ms and the
frame 3.6 → 4.5 ms CPU, which is what a wall that large joining in costs.

The lookup is per line, but the test it feeds has to be a **per-quad** check, not a per-*line* one —
an earlier version gated on `World.blocksSight(line)` for the whole line, which wrongly also
suppressed fading for that line's upper/lower step quads (they sit *outside* the opening — the riser
exposed where the neighbouring floor/ceiling falls short — and are genuinely solid regardless).
DOOM2 MAP01's east imp closet (sector 38) is the concrete case: its fence's masked-middle quad used
to fade to near-invisible the moment the imp inside woke, reading as the closet wall vanishing
rather than "you can see the imp through the bars." `FlatFader` has no equivalent gate — floors have
no comparable "visually-solid-but-actually-passable" case.

## Flats

`FlatFader` is the same idea for a horizontal plane: a raised floor sitting between the camera and a
target standing below it. Only floors above the target's own height are candidates, which excludes
the floor being stood on by construction — no "which subsector am I in" tracking needed. That gate
stays on the sprite's **centre** even though everything below it works over the sprite's whole
height, and deliberately: lowering it to the feet would generalize the span cleanly but pull back in
the floor the target is standing on, which is exactly what it is here to exclude. The cost is the
asymmetry — a floor between the feet and the centre, one hiding only the legs, is never a candidate.
The sightline crosses a candidate's height along one segment of the camera→target line (§ The target
is the billboard), and alpha falls off radially from the point its middle lands on, on the **same
`FADE_CORE`/`FADE_RADIUS` ramp the walls use**, so a hole that spans a floor and the wall behind it
is one shape rather than two.

**It runs the same two passes `WallFader` does, and pass one is what keeps a floor beside the
sightline standing.** A floor's height is a *plane*, and the plane is infinite while the floor is
not: `collectPierces` keeps a crossing only where that segment meets some fan's own footprint
(`segmentMeetsConvexPolygon` against `FlatSurface.points`), then pass two dissolves the ball around
the point it files.
Without that gate a step up *next to* the target fades, because the sightline meets its height a
couple of units short of the target — over open floor, on the far side of the step's edge — and the
step's own fans are then well inside `FADE_RADIUS` of that point. It is not a rare geometry: every
DOOM stair and ledge is that case, and a floor just above the target's centre is always crossed
within a few units of the target. Repro: DOOM2 MAP02 sector 1, stood at (1008, 1592) with the camera
due north — the whole grey platform dithered while the sightline never touched it.

A pierce is filed under the **height** it landed at, and pass two only dissolves fans standing at
that same height. That is what lets the hole spread across a platform split into many subsector fans
(the pierce point can only ever land in one of them) while never reaching a different level of
geometry that merely happens to be near it — and it is why the containment test is exact rather than
inflated by a radius, as an earlier per-fan version had to be.

A subsector fan's only vertices are its corners, which is nowhere to put a gradient — so
`addFlatFan` dices each fan triangle on a barycentric grid until no edge outruns `WALL_CHUNK_LEN`,
and `FlatSurface.vertexXY` records where every vertex it drew ended up. `FlatFader` then fades **per
drawn vertex**, measuring from that vertex's own position. Without the dicing a pierced platform
faded whole — a hard-edged slab, the flats half of the same artifact the wall chunks fix.

That bound is also what puts the floor directly over the player fully into the hole: in a triangle
whose every edge is at most `WALL_CHUNK_LEN`, an interior point is never further than half that from
some vertex — so a `FADE_CORE` of at least `WALL_CHUNK_LEN / 2` always has a drawn vertex inside it,
and a smaller one leaves that point on the ramp instead. An earlier version instead fell back on
fading the whole containing fan whenever the crossing landed inside it; dicing removes the need, and
with it the seam that override left along the fan's edges.

Two costs come with the finer fans, both paid for. A fan is walked per target, so each carries a
centre and radius and a crossing outside that reach skips it whole. And walking every vertex of
every fan, on a map with hundreds of thousands of them, is the entire frame cost — so **both passes
skip a fan that has nothing to do**: `update` tracks whether any of a fan's vertices is currently
below 1, and one that is reached by no pierce *and* is not currently faded needs no damping (damping
a settled vertex toward 1 returns 1); `commit` in turn flags the fans `update` actually moved, and
a settled fan under unchanged fog is written without touching a vertex.

**A flat with a base alpha below 1 is exempt from the fade entirely.** The only one is a 242 water
surface (docs/render.md § Deep water), which is translucent precisely so a submerged player stays
visible through it — there is nothing left for a fade to reveal, and fading punches a *hole*: only
the fans the sightline actually crosses dissolve, so the sheet loses a patch around the player while
the rest of it stays. Repro: wade into any BOOMEDIT MAP01 pool and watch the water break up
overhead.

**`awakeMonsters` only returns monsters fog of war is actually drawing** (`p.actor.mesh.visible`,
which `ThingLayer.update` sets from `fogAlphaOf` earlier in the same frame). A monster in a
subsector the player has never had sight of isn't rendered at all, so fading the wall in front of it
reveals an empty dark room and nothing else — concretely, a MAP01 secret compartment's wall dithered
away whenever the imps sealed inside woke, with the imps still invisible. This is also why
`WallFader.update` needs no "only fade if this is the *sole* wall in the way" rule: whether fading
reveals anything is settled here, upstream. A blocker-counting version was written first for this
same symptom and fixed nothing — that wall had only one blocker; its monsters simply weren't drawn.

**The fade is a dithered discard, not real alpha blending.** Wall quads are batched one mesh per
texture across the whole map, three.js sorts transparent objects back-to-front per mesh, and with a
mesh spanning the entire level that order is meaningless — plus both meshes still write depth by
default, so whichever draws first can win the depth test and blank out the other. `MaterialBank`
instead injects a fragment-shader snippet (`onBeforeCompile`) that discards a per-pixel fraction of
fragments using interleaved-gradient-noise dithering, keyed off a per-vertex alpha `WallFader`
writes into the 4th colour channel. That keeps walls in the ordinary opaque, depth-tested/written
pass — no batching or sort-order concerns, just fewer pixels drawn. `holes` textures (masked
middles) already alpha-test on the *combined* texture × vertex alpha, so a faded grate discards
outright instead of dithering.

Fade amount is exponentially smoothed (`FADE_SPEED`) so walls don't pop, but a pure exponential lerp
never actually reaches its target — `update` snaps once the remaining gap drops below a threshold,
otherwise a wall settles a hair short of fully opaque forever and shows a permanent faint speckle
(the dither test is a strict `<`). Smoothing state is per chunk edge and per footprint point, held
in the fader's own arrays rather than on the records — which is what lets `refreshMoverMesh` rewrite
those records field by field mid-motion without restarting a fade (docs/render.md § Mover meshes).
The lerp factor is hoisted per frame (`dampenWith`), since rate and `dt` are the same for every one
of them.

**Three inputs share that one channel, and `commit` writes their product.** Occlusion fading and
fog of war are the two that change per frame; the third is a surface's *base* alpha, fixed at build
time — a Boom 260 midtexture's 66% (`WallOccluder.baseAlpha`) or a deep-water surface's
`WATER_SURFACE_ALPHA` (`FlatSurface.baseAlpha`). Being constant, it costs nothing: `commit` already
skips a surface whose alpha has not moved. Note that a midtexture quad is exempted from occlusion
fading by `update`'s passable-gap test, so for a 260 grate the base is usually the only factor
below 1.

That skip compares against what `commit` itself last wrote (`lastCombined`, NaN-initialised so the
first frame always lands), not against a vertex read back off the buffer: with a gradient across a
quad or fan, no single vertex stands for the whole of it any more.

## Skipping invisible mover meshes

Because that product is what decides whether a surface shows at all, `commit` also records the
highest alpha it resolved per mesh key (`maxAlphaByKey` on both faders) — the max over a quad's two
edges and a fan's points, since either can vary across the surface. A mover mesh whose every
quad came out at 0 — fog of war has not revealed the sector, or view distance has faded it out —
draws nothing, and `MoverGeometry.updateFading` sets `visible = false` on it rather than paying a
draw call for no pixels. One mesh can hold both wall quads and flat fans, so both faders' verdicts
are consulted. The flag is set immediately before the frame's render (`game.ts: draw` calls
`updateFading` and then `renderer.render`), so it is never a frame stale.

Two details are load-bearing. The max is accumulated **before** `commit`'s unchanged-alpha
early-out: a mesh whose alpha simply did not move this frame is as visible as it was, and taking
the early-out first would report it invisible and blink it out. And the tracking is **opt-in**
(`trackVisibility`, on only for the mover faders): the static batches are per texture across the
whole map (docs/render.md § Mesh building), so one is almost never wholly invisible, and keeping the
map for them costs a lookup per quad per frame across tens of thousands of quads for an answer
nobody reads.

Why it matters is a mover-count problem rather than a geometry one: a Boom map's movable sectors
each get their own small mesh (docs/render.md § Mover meshes), so literalism.wad MAP18's 973 of them
add ~2,150 meshes averaging 8 triangles. Measured there at spawn, 2,144 of those 2,147 were fully
transparent while ~1,600 draw calls a frame were still being issued for them.

## Mover meshes a frame cannot touch

The same mover count is a per-frame CPU problem too, and for the same reason: each mover mesh
carries its own pair of faders, so Sunder 2512 MAP20's **1,633 movers** meant 1,633 × (both fade
passes, two `commit`s, a visibility walk) every frame over ~11,500 quads and ~4,900 fans in
total — seven quads a mesh, and the call overhead was the whole cost. `collectFadeHits` decides
per mesh (`MoverEntry.fading`) and `updateFading` skips it outright — both halves, so the two
agree — when nothing that could change it happened:

- **Nothing can reach it.** `fadeReach` is the sight box grown by the widest hole any target opens
  (§ Nothing per-frame is per-quad); a crossing lies on a sightline, so geometry whose footprint
  misses that box cannot be folded this frame — by the frame's shared bag exactly as by the mesh's
  own (§ One hole, whichever mesh it lands in). The mesh's own footprint is fixed at build time — a
  refresh moves heights, not where quads stand.
- **Nothing in it is still relaxing.** `WallFader.idle`/`FlatFader.idle` — a mesh that was faded
  and has since been left behind must keep damping back to 1, and freezing it mid-fade leaves a
  hole in a wall that never closes. That is the escape a skip on reach alone gets wrong.
- **Fog of war moved nothing near it.** `FogOfWar.changedBounds` is one box around every subsector
  whose reveal alpha moved (docs/fogofwar.md § Which walls a reveal moved) — coarse on purpose,
  since the question is only whether this mesh *might* be affected.
- **It has committed at least once.** A fader starts with nothing written at all, so a mesh built
  in a quiet corner of the level would otherwise keep whatever alpha the *builder* left in its
  buffer.

That last rule extends to a refresh, and the reason is worth stating on its own because it was a
bug on its own: **`refreshMoverMesh` rewrites the mesh's whole colour attribute, alpha channel
included** (docs/render.md § Mover meshes), so what the faders last wrote is gone from the buffer
while their own `lastCombined` still claims it — and `commit`'s unchanged-alpha skip then leaves the
*builder's* alpha standing. A lift moving through fog of war it has never lifted drew solid for the
whole stroke. `MoverGeometry.rebuild` calls `invalidateWritten()` on both faders after a successful
refresh, which is what makes the next commit write rather than recognize.

`invalidateWritten()` carries a second job: **re-resolving each quad's and fan's colour buffer**.
Both faders hold those buffers directly rather than looking them up by batch key on every commit,
and a refresh can move a quad to a different batch — `copyRefreshedQuad`'s `Object.assign` copies
`key`. A refresh that swaps two quads' textures leaves the batch set and every buffer length
unchanged, so it is accepted in place; without the re-resolve the fader would go on writing into
the batch the quad no longer draws in. Pinned by
`tests/regression/fader-rebatched-quad.test.ts`.

Measured on Sunder 2512 MAP20 at the player start, timing each part of `game.ts: updatePresentation`
separately: `MoverGeometry.updateFading` 3.34 → 0.19 ms/frame, and with the wall-fader work
above the block as a whole 18.2 → 1.8 ms/frame. What is left of it is the flat fader, which still
walks its 49,716 fans a frame behind per-fan early-outs (§ Flats).
