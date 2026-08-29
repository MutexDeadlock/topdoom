# World queries (`world.ts`)

`src/game/world.ts`

`World` is the level's read side: everything that asks the geometry a question rather than
moving something through it. Collision and the movement queries are docs/movement.md; the shot
queries (`shotPath`, `Range`) are docs/combat.md. This file holds the two that no single
subsystem owns — both are called from combat, AI, fog of war and the specials alike.

**What is a method and what stays a free function is a rule, not an accident.** Anything that reads
the level *through* a `World` is a method on it — `hasLineOfSight`, `checkPosition`,
`positionBlocked`, `slideMove`, `shotPath`, `projectileStepBlocker`, the neighbour-height family.
Two kinds of thing stay free, and neither can be folded in:

- **Map-keyed static topology** — `sectorLines`, `sectorsByTag`, `linesByTag`,
  `neighborSectorIndices`, `nextSectorIndices`. `render/` reaches these without a `World`
  (§ Neighbor-height queries has the argument), so they are memoized against the `DoomMap`.
- **Pure helpers that never touch a `World`** — `bodyFloor`, `playerShotRange`, `openingRefuses`,
  `blockedByThings`. They take scalars and blocker lists, and a `this` would only obscure that.

Converting the first group to methods was measured, not assumed: `positionBlocked`,
`hasLineOfSight`, `slideMove` and `shotPath` benchmarked identical before and after, inside
run-to-run noise.

## The collider

Every collision query takes the position being tested as bare `x`/`y` and everything *about the
asker* as one `Collider` — radius, feet height, body height, `forMonster`, the blockers around it,
and where it currently stands. The split follows the caller's shape: one body probes many candidate
positions, so the positions stay scalar (docs/conventions.md § Named arguments) and the body is
built once. `slideMove` builds one and reuses it across up to ten probes; a chasing monster's rides
on its `Chase` context, since `newChaseDir` probes up to eight destinations.

**`makeCollider` is the only place one is built, and every field is required.** Both halves are
load-bearing, and neither is style: `checkPosition` and `blockedByThings` read these fields in the
engine's hottest loop, so every collider reaching them has to share one V8 hidden class. Literals
at call sites do not — an omitted optional, or the same fields written in another order, is a
different map, and the property loads in that loop go megamorphic. Measured on DOOM2 MAP01, 120
imps chasing for 200 tics: 13.2 ms with one shape, 14.6 ms with several. The required fields are
what makes the type checker refuse a hand-built literal.

A caller that probes repeatedly keeps its record and rewrites the fields that move rather than
making a fresh one — `Chase.collider`'s feet height per probe, `standingCollider` here, and the
per-call scratches `monsters/ai.ts`, `things.ts` and `things/grid.ts` each keep for their own
probes.

## hasLineOfSight

**It checks floor/ceiling, not just walls.** Without this, a monster standing in a room genuinely
*underneath* a ledge the player is on — with no shared two-sided line anywhere near the straight 2D
path, since the floor is what separates them — registered as fully visible and shootable, so a
monster that chased around under a ledge kept hitting the player through the floor. Every caller
(`canSee`/`tryWake`, `applyRadiusDamage`) passes real heights rather than the flat
`MONSTER_ENGAGE_HEIGHT` guess an earlier version used, which a proper 3D check makes both redundant
and, in a tall open room, wrong (vanilla has no such cap at all).

**The floor/ceiling check is a sight *wedge* from a fixed eye height, matching `P_CheckSight`
(`sightzstart`/`topslope`/`bottomslope`) — not a straight line interpolated from `z1` to `z2`.** An
earlier version did exactly that, and it's wrong the moment the two ends stand at different floor
heights, which is most of a real level: a monster on a raised platform and the player one step below
it, in an otherwise open room, produces a line that dips below the *platform's own floor* almost
immediately — it heads toward the lower end over the *entire* distance, not just at the step — so
the platform's floor was misreported as blocking sight to the monster standing on it. This was a
shipped bug: a pair of E1M1 zombiemen one step up on a 24-unit platform never woke no matter how
long the player stood in plain view.

The origin is fixed at `from.z + SIGHT_EYE_HEIGHT` (vanilla's own `sightzstart` fraction — this
engine has no per-species heights, so both ends reuse the player's) instead of sliding toward `z2`.
That constant lives in `player.ts` beside `PLAYER_HEIGHT` it derives from, and is read *inside*
`hasLineOfSight`'s body: `world.ts` and `player.ts` import from each other, so a `player.ts` value
hoisted to module scope in `world.ts` would be read during that cycle's initialization. It is not
`EYE_HEIGHT`, the view height a unit below it — `game/autocamera.ts`'s probe wants that one
(docs/camera.md § Auto camera), a sight trace wants this one. The target bound uses the full
`[z2, z2 + PLAYER_HEIGHT]` span rather than a single point, so any part of that range clearing every
opening crossed is enough.

**The wedge narrows at two different things, and both are load-bearing.** The primary one walks the
same line candidates `forEachLineAlongSegment` already finds for the wall-blocking test and, for
every *open* two-sided line among them (skipping a flat pass-through — equal floors and equal
ceilings on both sides can't narrow anything, matching `P_SightTraverse`'s own
frontsector/backsector inequality guards), narrows `[bottomSlope, topSlope]` against that line's
real opening (`World.openingOf`: min ceiling, max floor of its two sides) at the exact distance it's
crossed — this *is* vanilla's own `P_SightTraverse`, not an approximation of it. A **periodic
fallback** additionally samples `sectorAt` every `SIGHT_HEIGHT_SAMPLE_STEP` map units (capped at
`SIGHT_MAX_HEIGHT_SAMPLES` samples total) and narrows against whatever sector each sample lands in,
for the one thing a line-crossing walk can't see: two points whose straight 2D path never crosses a
two-sided line at all yet still cross between differently-elevated footprints (the classic "monster
under a ledge" fake-3D construction) — the reason this doc originally gave for the check existing.
Both narrow the same wedge monotonically, so running both is always at least as strict as either
alone, never more permissive.

**The line-crossing narrowing is the one that makes melee range work at all.**
`MELEE_RANGE`/vanilla's own `MELEERANGE` (64-72 map units) is well inside `SIGHT_HEIGHT_SAMPLE_STEP`
(64), so the periodic sampler alone never places a single interior sample on a short sightline —
`Math.ceil(72/64)` is `1`, and the loop that walks samples `1..steps-1` never runs. Before the
line-crossing narrowing existed, that meant a monster standing at the base of *any* ledge more than
`MAX_STEP_UP` (24 units) tall, close enough to be in melee range, always passed `hasLineOfSight`
regardless of the ledge between it and its target — a demon could bite straight through the drop.
`tests/fixtures/wads/pinky_above_test.wad` MAP01 reproduces it directly: two sectors sharing one
line, floors 0 and 88, a demon on the high side and the player on the low side just below it.

**It is the most performance-sensitive query in the engine**, and two things keep the base cost
affordable. Both were verified to produce **bit-identical results** to the straightforward version
across 21,240 sightline pairs on six maps — this is pure optimization, not an approximation traded
for speed:

- **Wall candidates come from `World.forEachLineAlongSegment`, not `linesNear`.** `linesNear` takes
  a *radius*, so covering a sightline with it means a box half the line's length on a side —
  O(dist²) grid cells to test a thin segment. Walking only the cells the segment actually crosses is
  O(dist), and is sound because `buildGrid` buckets each line into every cell its bounding box
  touches: if a line genuinely crosses the segment, their intersection lies in a cell both pass
  through. On NUTS.WAD this one change took `hasLineOfSight` from dominating the frame to a small
  fraction of it. `slideMove`'s corner traces run on it too (docs/movement.md § slideMove) — and
  need no ordering from it, because `PTR_SlideTraverse`'s blocking decision reads nothing but the
  line itself, so a running minimum over the grid's own order finds the same nearest wall a sorted
  traversal would.
- **`SIGHT_MAX_HEIGHT_SAMPLES` caps the floor/ceiling sampling** so the step stretches past
  `SIGHT_HEIGHT_SAMPLE_STEP` instead of the sample count growing without bound. 32 is chosen so
  nothing within `WEAPON_RANGE` (2048, the furthest a monster can shoot, and no player shot's
  outcome is decided here — `shotPath` walks openings itself) changes at all — 2048/64 is
  exactly 32 — while a monster 12,000 units away stops costing ~180 BSP walks per frame to answer a
  question no attack could act on.

Relatedly, `stepMonsterAI` resolves sight **lazily, at most once per call**: it's only consumed by
the refire loop and by `runChaseCall`, and the chase call is quantized to `chaseInterval` while
`stepMonsterAI` runs every rendered frame, so evaluating it eagerly threw the answer away most
frames. Vanilla has the same structure for the same reason.

**`forEachLineAlongSegment` returns what the walk cost** — cells stepped plus lines handed to the
visitor. Only `FogOfWar`'s reveal sweep reads it, to cap how much sight testing one tic may do
(docs/fogofwar.md § Sight testing); the alternative was for the fog to estimate that figure from the
grid's cell size, which is this module's own tuning knob and would have mis-charged silently if it
ever changed. Everyone else ignores the return.

**Every ray-vs-wall crossing tests against `World.lineOverlapEnds`**, the per-linedef table of
endpoints extended `WALL_OVERLAP` (0.25) past both ends: two walls meeting at a shared vertex
otherwise let a ray aimed right at that point pass outside the end of both and hit neither. It is
precomputed with the rest of the per-linedef geometry because vertexes never move — shots
(docs/combat.md), projectile steps and the fog's sight rays all read the same table rather than each
running the normalize-and-extend per candidate line, which is what they used to do.

Both `forEachLineAlongSegment` and the lazy accessor exist because these run thousands of times a
frame: the segment walk dedupes through a per-linedef stamp array rather than allocating a `Set` and
spreading it per call, the way `linesNear` does. **An equivalent allocation-free `linesNear` for the
*collision* callers was tried and measured as no faster** — the callback makes that call site
megamorphic and costs the early-out — so `checkPosition`, the one collision caller left,
deliberately still uses the plain array-returning `linesNear`. Don't "fix" that without measuring.

`forEachLineNear` is that callback form, kept for the one caller the measurement above does not
cover: `LightVisibility.castShadows` (docs/lights.md § Shadows), which runs once per committed light
per frame, has no early-out to lose, and is the method's only call site — so it stays monomorphic
where the collision path would not. The collision callers keep `linesNear`; the two coexist on
purpose.

**`SELF_HIT_MARGIN`**: a rocket that explodes against a wall sits its own impact point exactly on
that wall, and a raw segment-intersection test then reports the blast blocked by the very wall it
started on (the ray's own origin is a valid crossing at `t≈0`) — so `hasLineOfSight` said "blocked"
in every direction, including straight out into the open room. Splash only ever worked when a shot
connected directly with a monster and never when it hit geometry, which for a free shot is the
common case. The margin skips a crossing within 1 unit of the ray's start, the far-end counterpart
to `WALL_OVERLAP`'s "nudge off the geometry you're standing on". Tradeoff: a rocket exploding
against a *closed door* can in principle leak a sliver of splash through, since the door's self-hit
is now the crossing being ignored — accepted as the same order of approximation.

## Point-to-sector lookups

`subsectorAt` descends the BSP; everything that wants a *sector* for a point goes through it and
then resolves subsector -> sector. That second half is a table: `World.subsectorSector`, an
`Int32Array` filled once in the constructor, so the resolution is one typed-array read.
`sectorIndexOfSubsector` is the accessor; `sectorIndexAt`/`sectorAt` and the `floorAt`/`ceilingAt`
over them, `sectorOfSubsector`, and the REJECT probe below all route through it.

**The table comes from `buildSubSectorPolys`, not from `sectorOfSubSector` alone.** Vanilla's
`subsector->sector` is the seg -> linedef -> sidedef walk `sectorOfSubSector` does, and that is what
the table holds for all but a handful of leaves: the exception is a leaf a node builder filed under
its *neighbour's* sector, which only the polygon rebuild can recognise, since only it knows where
the leaf's cell actually lies. `SubSectorPoly.physicalSector` carries that repair (docs/render.md §
Segs on the wrong side of their leaf) and the table takes it, so the sector under the player's feet
is the one whose flat is drawn there. This is the only reason `world.ts` reaches into `render/`, and
it costs nothing per frame — the lookup is the same single `Int32Array` read either way. At load the
rebuild is shared with the mesh and the fog grid (`buildSubSectorPolys` memoizes on the map), so
adding this reader took a level's poly building from two builds to one.

**The table is built for every map, not only ones with a REJECT table.** It arrived for the REJECT
probe, but the per-frame sector lookups — damage floors, the sector under the player, sprite
lighting, every mover's blocking test — pay the same walk, and that walk is unbounded: it scans a
subsector's segs until one names a sidedef, so a subsector whose early segs are miniseg-like costs
several linedef and sidedef derefs per query. The table is `4 * numsubsectors` bytes, well under a
map's other load-time derivations.

**`subsectorsAlongSegment` is the segment form of that descent**, appending a `t0, t1, subsector`
triple per leaf a segment passes through and merging adjacent runs naming the same one. It lives
here, beside `subsectorAt`, so the node side test is written once — its one caller is
`LightVisibility`, where a subsector polygon edge can border several leaves at once and a point
probe answers for only one of them (docs/lights.md § The adjacency graph).

**A subsector index the map doesn't have answers sector 0**, matching what the seg walk returned for
one — `subsectorAt` can produce an out-of-range index on a map with broken nodes, and sector 0 is a
real sector, so the guard keeps that path from reading past the array. `sightRejected` does *not*
use the accessor for exactly this reason: an out-of-range hint there must reject nothing rather than
answer for sector 0's row, so it bounds-checks the table itself.

**`openingInto(line, out)` is the allocation-free form of `openingOf`**, writing vanilla's
`P_LineOpening` pair into a caller-owned record. `openingOf` is the wrapper that hands out a fresh
one, and `blocksSight` — which runs per candidate line inside the fog sweep — is a predicate over
it, as is the auto camera's own `blocksProbe` (docs/camera.md § Auto camera), which brings its own
record rather than a third `World` scratch. The point is that the min-ceiling/max-floor rule is
written once:
the copies that remain inline (`checkPosition`'s, and the sector pair `hasLineOfSight` resolves for
its wedge narrowing) are there because those callers need the sectors themselves, not just the
opening.

## Sectors under a body

`sectorsTouching(x, y, radius, out)` answers **every** sector a body of that radius overlaps, not
just the one under its centre — vanilla's `touching_sectorlist`, built by `P_CreateSecNodeList` and
`PIT_GetSectors`. It walks `linesNear` and keeps a line under exactly the two filters vanilla's own
iterator applies: the body's box must overlap the line's bounding box, and `boxOnLineSide` must not
put the box wholly on one side. Both sectors of a surviving line join the list, centre sector first.

Every force that belongs to a *sector* rather than a point reads this (docs/specials.md § Friction,
§ Scrollers and conveyors, § Pushers), and it exists because the centre-point answer is genuinely
wrong for them: a player straddling the edge of a conveyor or an ice patch is standing on it in
vanilla, and `sectorAt` alone would say they aren't. That is the same straddle rule `groundFloor`
already follows for heights, arrived at from the other direction.

The result is written into a caller-owned array so the per-tic queries reuse one; the membership
check inside is a linear `includes` rather than a `Set`, since the list is a handful of entries even
on pathological geometry.

`sectorsTouchingCached` is the same query behind a per-body `SectorTouchCache`: the list is a pure
function of (x, y, radius) over static line geometry, so it stays valid for as long as the body
stands still, and the force queries all take the calling body's own cache rather than a shared
scratch. What made this worth having, and the memo built on top of it for bodies a conveyor pins
against a wall, is docs/movement.md § Pinned-body memo.

## REJECT

`hasLineOfSight` opens with vanilla's own first test in `P_CheckSight`: the WAD's REJECT matrix
(docs/wad.md § REJECT) carries one bit per ordered sector pair, set when those two sectors can never
see each other, and a set bit returns `false` before any tracing happens. `World.sightRejected` is
that lookup, and it takes **subsector** indices rather than sector ones because vanilla's own
indexing is `t1->subsector->sector` — the subsector is what a thing already knows about itself.

**The bit only ever answers "definitely not".** A clear bit says nothing at all, so this is a pure
early-out: every `true` still comes from the full wall/wedge trace below it, and a map with no
usable table (`DoomMap.reject === undefined`) behaves exactly as it did before REJECT existed. That
is also why a table can't go stale as doors and lifts move: it is computed over the linedefs, which
are static, and it can only *remove* sight the geometry would otherwise have allowed.

An RMB-built table that deliberately blinds monsters in part of a map is therefore honored rather
than worked around — the same gameplay effect vanilla gets from it.

**The subsector hints are load-bearing on the wake sweep.** `hasLineOfSight`'s
`fromSubsector`/`toSubsector` may be `-1` ("look it up"), and looking both up costs two BSP descents
on every *non*-rejected call — a large enough share of a sight check to turn a thin table into a net
loss. The one caller that runs at scale, `ThingLayer.update`'s idle wake sweep, therefore passes
`PosedThing.subsector` (already kept current) and one player subsector resolved once per frame;
`tryWake` threads both through. The occasional callers — splash damage, the arch-vile, the Icon of
Sin, projectile checks — pass `-1` and take the lookup, which their call volume makes irrelevant.
A map with no table returns before either hint is read, so it pays nothing anywhere.

What REJECT is worth is a property of the WAD, not of the engine: a table's density ranges from
all-zero (SCYTHE.WAD, every map) through ~15% of sector pairs (DOOM2.WAD) to ~88% (freedoom2.wad).
`scripts/inspect-wad.ts` reports the loaded map's. Note that it buys least where sight checks cost
most — a huge open arena is one sector, so NUTS.WAD MAP01's 11-sector map rejects nothing.

## Neighbor-height queries

`World.lowestNeighborFloor`/`highestNeighborFloor`/`nextHigherFloor`/`nextLowerFloor`/
`lowestNeighborCeiling`/`highestNeighborCeiling` are vanilla's `P_FindLowestFloorSurrounding`
family — how a mover resolves its target height.

**They are methods, while the adjacency underneath them is a free memoized function, and the split
is not stylistic.** These read a sector's *live* heights and light, so only a running level asks
them and every caller (`game/specials.ts`) already holds a `World`. The walks they run on —
`sectorLines`, `neighborSectorIndices`, `nextSectorIndices`, `sectorsByTag`, `linesByTag` — are
static topology memoized against the `DoomMap`, and must stay callable **without** a `World`,
because the renderer reaches them without one: `game/specials/movergeometry.ts` supplies
`MoverIndex.linesOf` from `sectorLines`, and `render/mapmesh.ts` takes `subsectorAt` as an injected
callback rather than importing `World`, so `render/` keeps no import edge into `game/`.
`transfersOf` is memoized on map identity for a related reason — one `Transfers` shared by
`game.ts`, `things.ts`, `forces.ts` and the mesh builder, which the mesh tests construct with no
`World` at all.

**Construction order is not the reason.** `World`'s constructor reads only static topology
(vertexes, linedefs, sidedefs, subsectors, bounds) and no sector height, light or special, so it
could be built immediately after `loadMap` — before `transfersOf` and `applySectors` — without
changing an answer. It is built later only because nothing needs it sooner. Moving it up would not
let the adjacency become methods; the layer direction is what forbids that.

**Each falls back to the sector's own current height only when it has no two-sided neighbors at
all**, never leaving a mover with nowhere to go. The fallback must *not* kick in merely because the
sector's own height is already the most extreme value, which is why these track a `found` flag
rather than seeding the reduction with the sector's own height: a closed door's sector has floor ==
ceiling, so seeding a *lowest* ceiling search with it makes every real neighbor lose, pinning the
door's "open" target at its own closed height instead of the corridor's actual ceiling.

**`darkestNeighborLight` is the exception, and seeds.** It is `P_FindMinSurroundingLight`, which
vanilla never calls with anything but the sector's own light level as its `max` — so it only ever
lowers from there, and a sector surrounded entirely by brighter ones dims to its own level rather
than *up* to the darkest neighbour. Nothing here is left with nowhere to go, since a light pattern
with min == max is a legal outcome — one the strobes then override (docs/specials.md § Lights).

### Self-referencing lines

`World.neighborSectors` — `getNextSector` — **skips a line whose two sidedefs name the same
sector**, so such a line never makes a sector its own neighbour. This is Boom's reading, not
vanilla's: `linuxdoom-1.10`'s `getNextSector` returns `line->backsector` unconditionally once
`line->frontsector == sec`, which for a self-referencing line is `sec` itself. Boom's own comment at
the change says why (`p_spec.c`, jff 5/3/98): *"don't retn sec unless compatibility — fixes an
intra-sector line breaking functions like floor->highest floor."* PrBoom keeps vanilla's answer only
behind `comp[comp_model]`, for demo sync.

Without it a sector fenced off by self-referencing lines — the standard Boom trick for an invisible
platform edge or a deep-water boundary — is its own highest and lowest neighbour, so every mover
targeting a neighbour height resolves to the height it already sits at and goes nowhere.
**NoSp2.wad MAP04, sector 102** (a platform lowered by the switch on linedef 445, special 71): its
four self-referencing lines 740–743 made `highestNeighborFloor` return the platform's own 64 rather
than the room's 0. `tests/regression/self-referencing-neighbor.test.ts` pins it.

The rule belongs to `getNextSector` and not to adjacency generally, so `world.ts` exports the walk
in both forms and the rule has exactly one home: **`nextSectorIndices`** applies it and
**`neighborSectorIndices`** is the plain adjacency underneath (`specials/mapscan.ts` re-exports both
rather than keeping a copy). It therefore reaches exactly the searches whose vanilla source calls
`getNextSector` — the six neighbour-height queries and `darkestNeighborLight` here, the donut's
ring/outer walk and the two surrounding-light searches in the specials layer.
`P_FindModelFloorSector`, which walks `twoSided`/`getSector` instead, stays on
`neighborSectorIndices` and still sees the sector itself.

Across `DOOM.WAD` and `DOOM2.WAD` the rule moves a neighbour height in 46 sectors and not one of
them is targeted by a special that reads the query that moved, so no stock map behaves differently.

### The sector→lines index

All of them — plus `neighborSectorIndices`/`nextSectorIndices`, `findStairChain` and the
shortest-texture scans in the specials layer — walk one sector's bordering linedefs through
**`sectorLines(map, sectorIndex)`**, never the whole `map.linedefs` array. It is vanilla's
`P_GroupLines` `sec->lines[]`: every line touching the sector, one- and two-sided alike, in
ascending linedef order, which is the order several specials react to (`lowerAndChange`'s model
search, the donut's ring walk). Callers keep their own two-sided filters, so filtering a subset
preserves exactly the order and membership the full scan produced.

The index is built once per `DoomMap` and memoized against it in a `WeakMap`. That is safe for the
same reason the heights above are *not* cached: nothing at runtime writes `LineDef.left`/`right` or
`SideDef.sector`, so a map's adjacency is fixed the moment it loads, while its heights change every
tic. Keyed by the map object rather than held on `World` because the load-time scans reach it
before any `World` exists (`scanSectors`, whose answer `mapmesh.ts` is given).

**This is a measured change, not a reasoned one** (CLAUDE.md § Hot paths): on EPIC.WAD MAP03
(11,205 lines, 1,093 sectors) running one neighbor query per sector went from ~31 ms to ~0.3 ms,
and a stair-chain walk from every sector from ~51 ms to ~0.4 ms; building the index costs ~0.45 ms
once, against `loadMap`'s own ~3.4 ms. It matters because a single Boom generalized trigger can run
three of these scans *per tagged sector* (target resolution, the shortest-texture scan, and the
numeric change model), so a tag spanning tens of sectors was a multi-millisecond hitch on one
switch press.

### The tag indexes

`sectorsByTag(map, tag)` and `linesByTag(map, tag)` are vanilla's `P_FindSectorFromLineTag` and
`P_FindLineFromLineTag`, which both linear-scan their whole array on every call. Same `WeakMap`
memo, same static-data argument as above: `Sector.tag` and `LineDef.tag` are written once by
`loadMap`'s parse and never again. Both return **ascending index order**, matching those scans —
"whichever match comes first" is the actual rule for a line-to-line teleport's destination, so the
order is behavior, not an implementation detail.

Because they are memoized, **a tag written after the first lookup is invisible** — which is fine for
the engine (nothing writes one at runtime) but is a real trap for a test hanging specials on a
`gridMap`: set tags before the rig is built, and vary something else if a test needs the
destination to appear mid-run.

`sectorsByTag` backs `resolveTargets` (`specials/mapscan.ts`), which every tag-driven trigger goes
through, and the boss-death `triggerTag`. `linesByTag` exists for Boom's line-to-line teleporters
(docs/specials.md § Silent and line-to-line teleporters), the one family whose tag names a linedef
rather than a sector.

Measured on the same EPIC.WAD MAP03: resolving one tag per tagged special line (218 of them, what
`scanSectors` does at load and what every trigger repeats at runtime) went from 0.35 ms
to 0.007 ms, against a 0.04 ms build.

**Tag 0 is deliberately absent from both.** Every caller already refuses it upstream —
`resolveTargets` returns nothing, `SpecialDef.requiresTag` rejects the line, and vanilla's own
`P_CheckTag` allows a zero tag only for a listed handful — while on a real map most sectors and
most lines carry tag 0, so indexing it would build the one bucket nobody ever reads. Keeping the
skip inside the index makes it one rule instead of two that have to agree.
