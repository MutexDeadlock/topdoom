# Rendering

`src/render/bsp.ts`, `src/render/solids.ts`, `src/render/mapmesh.ts`, `src/render/occlusion.ts`,
`src/render/textures.ts`, `src/render/textureanim.ts`, `src/render/viewport.ts`

The level's own geometry: rebuilding it, lighting it, fading it and what a frame of it costs. The
camera that looks at it — orbit, aim lead, the auto framing — is docs/camera.md; things drawn *in*
the level are docs/sprites.md; the loop that drives a frame is docs/frameloop.md.

## BSP polygon reconstruction (`bsp.ts`)

`SEGS` only stores edges that lie on real linedefs — the edges created by BSP splits aren't in the
WAD. `buildSubSectorPolys` rebuilds each subsector by taking a quad covering the whole map and
clipping it (Sutherland-Hodgman) against every partition line on the path from the BSP root down to
that leaf, then against the subsector's own segs. The result is convex, so a triangle fan is enough.
Traversal is iterative (stack-based), not recursive — some maps have deep BSP trees.
`sectorOfSubSector` resolves a subsector's sector via its first seg → linedef → sidedef.

### Cracks between subsectors

The seg clip runs with slack: a seg's line only cuts the cell where the cell sticks out past it by
more than that seg's tolerance. Without it, thin wedges of floor go missing in the middle of a room
— DOOM2 MAP06 around `(-704, 896)`, between subsectors 253 and 254, is the case this was found on.

The cause is that a WAD's node partitions are stored as integer `(x, y, dx, dy)`, so a partition
built from a linedef is a hair off that linedef's own slope. The two subsectors either side of such
a node get their shared boundary from the partition, but the one whose segs lie on the linedef then
clips itself again against the linedef's *exact* line — which diverges from the partition as it runs
away from the seg, and shaves off a sliver its neighbour does not fill. In MAP06 the partition is
`(-628, 704) d(-75, 192)` where linedef 230 runs `d(-76, 192)`: 2 units of missing floor 192 units
along.

**A short seg scales that disagreement up, and the tolerance has to scale with it.** A seg's
endpoints round to the integer grid however long it is, so on a short one that same fraction of a
unit is a much larger angle: the line it implies drifts roughly a unit further off per length of
seg it is carried past its own endpoints. `segClipTolerance` is that ratio — the furthest cell
corner's distance from the seg, over the seg's length — clamped to `SEG_CLIP_TOLERANCE` (4 units,
the floor, which is what the MAP06 class of case needs) and `SEG_CLIP_MAX_TOLERANCE` (32 units, the
ceiling). Past the ceiling the seg's line says so little about where the cell ends that more slack
buys back no floor and only leaves more of it standing past a wall.

Two cases this is measured on, both far outside a flat 4 units: DOOM2 MAP24 sector 42, where
linedef 99's 8-unit seg cut a ~350 × 100 wedge out of the floor around `(-400, -3450)`; and
`oku2_mancubus_cliff.wad` MAP01 sector 200 around `(5550, 350)`, where linedef 101 — 6 units long,
and 1° off the partition that shares its corner — cut a ~500-unit-long wedge between subsectors 911
and 912, opening the floor onto the blood pit two sectors below it.

**Only a seg the cell is already cut along is scaled up** (`cellCutAlong`): an edge of the cell has
to run within `PARTITION_MATCH` (2 units) of both of the seg's endpoints, which is what a partition
built from the seg's own linedef leaves behind. That is the whole premise of the scaling — two
boundaries that are meant to be the same line, disagreeing by rounding. Where the cell has *no*
boundary on that line, the seg is the only thing bounding it there, no drift can have happened, and
slack only leaves floor standing past the wall. Repro: DOOM1 E1M6's closet at `(3448, -1536)`, an
80 × 128 room whose leaf gets the whole east of the map as its cell because nothing out there needs
a partition — its floor stood 11 to 22 units past all four walls, in the open void, under a camera
that looks over a 72-unit wall.

**The tolerance can never make two subsectors overlap**, which is why it can be this blunt. Node
clipping alone partitions the plane into disjoint cells, and a subsector's polygon is only ever that
cell with pieces cut away — so slack on the seg clip returns territory that belongs to this cell and
that no other subsector can draw. What it can do is leave floor standing past a wall, in space that
would otherwise be a hole — which is a straight improvement only where that hole was somewhere the
map has floor. That is what the gate above and `SEG_CLIP_MAX_TOLERANCE` between them bound. The clip
against the *node* partitions stays exact — give that slack and neighbouring cells really would
overlap.

Measured over `DOOM1.WAD`, `DOOM2.WAD` and the committed PWADs by sampling each map on a 4-unit grid
(crack = a point inside the map that no subsector polygon covers; overhang = a covered point outside
it), scaling the tolerance this way cuts total crack area by 29% against a flat 4 units — MAP24 by
74%, the `oku2` wedge to nothing — while average overhang goes from 4 units of floor past a wall to
about 5. Gating the scaling on `cellCutAlong` then removes 8.5M units² of that overhang across the
same WADs (2-unit sampling of every leaf whose polygon changed, counting only area no other leaf
draws) and opens 23k units² of new crack — 370:1, and the crack it opens is in places the map's own
leaves already fail to cover, which the slack was papering over with a neighbour's floor.

### Walls that stop inside their cell

Slack is not enough where the wall doesn't reach across the cell at all. A BSP leaf is convex and
disjoint from every other, but it is not free of walls: a node builder that never split along a
short wall stub leaves that stub sitting inside the leaf, with the *same sector's floor on both
sides* of where its line would run. Clipping by the stub's infinite line then takes the floor past
the wall's own end — a black patch in the middle of a lawn. Vanilla never notices, because a
one-sided wall masks the floor behind it only over the screen columns it actually occupies; a
polygon has no such per-column option. `BOOMEDIT.WAD` MAP01 leaf 206 is the case this was found on:
the leaf wraps around the outside corner of a diagonal block, and lines 104 and 110 each cut ~3200
units² of grass off it — the black spots reported in sector 0.

`wallBoundsCell` decides it, and only where the line crosses the cell beyond the span the leaf's own
segs on that line cover — a wall that spans its cell is clipped by as before. There, the ground just
past the covered end is probed, a little onto the side the clip would remove: **this sector's floor
there means the wall has ended and the leaf carries on around it**, so the cut is spared. Void or
another sector means the level's own outer wall, which is what the seg clips are *for*, and the cut
stands. The probe is geometric (nearest linedef, and which side of it) rather than a BSP lookup —
the tree is what is being rebuilt, so it cannot be the authority on where a point is. It lives in
`sectorprobe.ts` as `SectorProbe`, which buckets the linedefs at 256 units so a probe scans a
neighbourhood, and is built lazily: most maps have neither a stub nor a self-referencing sector and
never ask it anything.

A spared cut keeps the floor *under* the stub's structure too — the test case is a 64-unit block
standing in a 512-unit cell, and the whole cell survives. On screen that reads right only because
`solids.ts` lids such a block (§ Solid structures); where it declines a ring, the floor now paints
through the structure rather than leaving the old hole.

**A spared cut is spared whole**, since the cell has to stay convex, so it is only allowed while the
overhang it keeps could be this sector's floor at all: every corner of the removed piece has to fall
inside the sector's own extent, padded by `SEG_CLIP_MAX_TOLERANCE` so this can never cut into the
overshoot the tolerances above deliberately leave behind. Without that bound one fooled probe among
`EPIC.WAD` MAP03's bank of 8-unit sectors handed a 32-unit² sector a 192 × 96 floor (leaf 2192).

Measured the same way as the tolerances: over `DOOM1.WAD`, `freedoom2.wad` and the committed PWADs
this changes nothing at all except on the two maps that have such stubs — BOOMEDIT MAP01 recovers
4736 units² of floor with no new overhang, and EPIC MAP03 recovers 1152 for 5504 units² of overhang
spread over five leaves, none of it further past a wall than the overhangs already there. It costs
about 9 ms of level load on EPIC MAP03, the largest committed map, and under 2 ms elsewhere.

### Segs on the wrong side of their leaf

Some node builders file a seg into the child on the *wrong side* of its own line: the leaf's cell
lies entirely on the side the seg's clip discards, so the clip wipes the cell down to the tolerance
band and leaves the rest of it a hole no other leaf can fill — node cells are disjoint. Vanilla
never notices, for the same reason as the wall stubs above: flats are drawn as spans between wall
columns, so the neighbour's flat paints straight across the broken leaf. The case this was found on
is `ksutra.wad` MAP04's subsector 902, a trapezoid of sector 23 around `(-240, -610)` whose only
seg is a north-facing seg of linedef 75 while the cell sits south of that line — a black hole in
the floor, right where a savegame put the player.

`wallFacesAwayFromCell` detects it — no corner of the cell meaningfully past the seg's line on the
keep side (`PARTITION_MATCH`), real cell area beyond the discard threshold (`SEG_CLIP_TOLERANCE`) —
and such a seg's clip is skipped. The sparing has a reality check: every trustworthy clip runs
first, then the remaining cell's interior is sampled (`enclosingSectorOfCell` — centroid plus each
corner pulled toward it) with the same `SectorProbe` the other repairs use, and **any sample in the
void keeps every clip**, in the original order, bit-identical to not detecting at all. Without that
check the sparing stood a ~305k-unit² slab of floor out into the void beside ksutra MAP29's leaf
7000, whose cell is mostly beyond the map's outer wall.

A wrong-side seg's front names the *neighbour's* sector, so a spared leaf cannot take its drawn
sector from it either: the first correctly-filed seg speaks instead, and a leaf with none draws as
the sector the probe found around it.

**Gameplay follows this repair**, through `SubSectorPoly.physicalSector` — which `World` builds its
`subsector -> sector` table from, rather than `sectorOfSubSector`. A leaf filed under the wrong
sector is in the wrong sector for *every* purpose, not just for drawing: on ksutra MAP04's leaf 953
the BSP answers sector 12 (floor 16) across a 130k-unit² stretch of sector 38's water (floor -64),
so the player walked 80 units above the surface they could see. This is a **deliberate deviation** —
vanilla's `R_PointInSubsector` reports the misfiled sector there too, and GZDoom floats the same way
— taken because a top-down camera shows the disagreement between the floor drawn and the floor stood
on, which a first-person view mostly hides.

A leaf whose segs **all** lie on self-referencing lines is exempt: such a seg names one sector on
both sides, so it cannot have been filed under the wrong one, and the construct below needs gameplay
to keep the hidden sector. `physicalSector` never follows the self-referencing redirect either.

Measured over both IWADs, `freedoom2.wad` and the committed PWADs: the stock IWADs, SCYTHE and NUTS
change nothing at all (one zero-area BOOMEDIT MAP01 leaf changes only its invisible drawn sector);
ksutra — built with an era nodebuilder that misfiles often — heals ~50 leaves across 20 maps, every
healed cell's interior probing uniformly to its new drawn sector, and moves 30 of them across 12
maps for gameplay as well, each confirmed against an independent linedef-only probe of the cell's
centroid. Everywhere else 11.2M grid samples answer exactly as the BSP alone did.

### Self-referencing sectors

A Boom-era map hides things in plain sight by giving a line the *same* sector on both sides: the
line bounds a real sector (a monster closet, an invisible lift, a fake-water bed) whose leaves sit
in the middle of some other room. Vanilla never draws any of it — `r_bsp.c: R_AddLine` rejects a
seg whose two sides have identical flats and light, which two sides of one sector trivially do — so
no seg of the construct ever breaks the enclosing sector's floor spans, and the room's flat paints
straight across. A polygon per leaf has no spans to lean on: drawing such a leaf as its BSP sector
renders the *hidden* floor — `BOOMEDIT.WAD` MAP01's leaves 166/168, the middle of the sector-30
window sill, drew sector 33's floor as a bright 32-deep pit in the sill (the "invis areas" report).

So a leaf whose segs **all** lie on self-referencing lines takes its drawn sector from whatever
*encloses* it instead: the leaf's centroid is probed with the same `SectorProbe.sectorIndexAt` the
wall-stub sparing uses, skipping self-referencing lines so the probe cannot land back on the
construct itself. Only the drawn sector moves — `physicalSector` keeps the BSP sector, such a leaf
being exempt from the wrong-side repair above, which is the trick's whole point: a monster standing
in the closet is *under* the drawn floor, exactly as invisible as vanilla makes it. A leaf with even
one ordinary seg is left alone; its real border is authoritative. Across the committed WADs only
BOOMEDIT MAP01 and EPIC MAP03-05 have such leaves at all; the stock IWADs are untouched.

`SubSectorPoly.sector` is the *drawn* sector and `physicalSector` the one gameplay stands in; these
two part company exactly here. Everything reading `sector` follows the remap — including
`mapmesh.ts`'s mover meshes, which key their flats off it. A self-referencing sector that is itself a
mover (an invisible lift is the stock example) therefore contributes no flats of its own to raise:
its leaves are baked into the enclosing sector's static flats, which is what vanilla shows too,
since none of them were ever drawn.

## Mesh building (`mapmesh.ts`)

Walls are built per linedef from sidedefs: one-sided lines get their middle texture over the full
sector height; two-sided lines get upper/lower steps plus an optional masked middle, following DOOM's
pegging rules (`UPPER_UNPEGGED`/`LOWER_UNPEGGED`) for vertical alignment. Walls are drawn
single-sided (facing DOOM's defined front), which is what culls walls between the camera and the
player and produces the open dollhouse look — no extra logic needed. `F_SKY1` flats are skipped.
Each of those surfaces is then cut lengthwise into quads of at most `WALL_CHUNK_LEN`, so the
occlusion fade can dissolve part of a wall rather than all of it (§ The fade is a hole, not a wall)
— a chunk is what a `WallOccluder` record and every per-quad rule below mean by "quad".

**Which of the two steps a side draws, and between what heights, is `twoSidedBands` — exported,
because the auto camera asks the same question.** `addTwoSidedSide` sizes its quads from it and
`game/autocamera.ts`'s `hidesFromCamera` decides what can hide the player from it, so the rule has
one owner. It matters because the heights are the *drawn* ones, resolved through Boom's 242
transfers (§ Deep water) rather than read off the two sectors — the second copy that used the raw
heights went blind to the wall across from deep water (docs/camera.md § Framing past an occluder).

Every vertex carries three attributes beyond position and UV: the sector's baked light as a vertex
colour (§ Sector lighting), the fade alpha both faders and fog of war write (§ Wall occlusion
fading), and **`aLightCell`, the BSP leaf that surface faces into** — a flat's own, a wall's the one
its face looks at, probed once by `fillWallCells` and recorded on the occluder so fog of war can
take the same answer. It is what lets a dynamic light stop at a wall (docs/lights.md § Light stops
at walls), and it is written once: a mover changes heights, never a quad's footprint, so
`refreshMoverMesh` leaves it alone.

### Flats are diced on a world grid

A flat is cut up for the same reason a wall is — a fan whose only vertices are its corners has
nowhere to put a fade gradient — but **not** the same way. `addFlatFan` clips each convex leaf
polygon against a world-aligned grid of `FLAT_GRID_LEN` and fans each cell (`diceOnGrid`).

The cuts go through `util/geom.ts`'s `clipConvexPolygon`, the tree's one convex clip — the same one
`bsp.ts` builds every subsector polygon with. The four axis-aligned half-planes a grid needs are
that clip's degenerate cases, tabulated at `diceOnGrid`; it takes an `out` buffer so the dicing
loop reuses four arrays rather than allocating per cut. A vertex sitting exactly on a grid line
lands in both neighbouring cells, which is what makes their shared edge cut at the same points from
either side.

What it replaced was a fan of the whole polygon, each of those triangles then diced on a
barycentric grid sized by its **longest** edge. Fanning a convex polygon from one corner makes
slivers, and a sliver diced by its long edge spends the same subdivision across its short one, so
the vertex count followed the polygon's *perimeter* rather than its area: EPIC.WAD MAP05's flats
came to 1.04 M vertices where their area asks for a fifth of that, 41.7 MB of static buffers, and
396 k triangles resubmitted every frame — the batches are map-wide, so per-mesh frustum culling
removes almost none of it. On the grid the same map draws 528 k flat vertices and 224 k triangles,
and the mesh build drops from 142 to 91 ms.

`FLAT_GRID_LEN` is `WALL_CHUNK_LEN / √2` rather than `WALL_CHUNK_LEN` itself, and that is not a
tuning: a square cell split by its diagonal leaves that diagonal as its longest edge, so this is
the widest cell whose edges still obey the chunk length. What the fade actually needs is a vertex
near every point, and on that reading the grid is the *tighter* of the two — no point of a cell is
more than `WALL_CHUNK_LEN / 2` = 64 units from one of its corners, against the 74 the old dicing
left at worst. Because the grid is world-aligned rather than per-polygon, neighbouring leaves also
cut their shared edge at the same points instead of at each polygon's own subdivisions.

A cell the polygon only grazes comes back as three near-collinear points; below
`FLAT_CELL_MIN_AREA` it is dropped rather than emitted as a triangle that covers nothing and still
costs three vertices in every buffer.

A two-sided line's **masked middle texture** is one copy of the texture, not a fill of the opening.
Its row 0 sits at the pegged anchor — the higher **real** floor plus the texture height when
`LOWER_UNPEGGED` is set, the lower real ceiling otherwise (§ Deep water: the anchor is the one
height a 242 does *not* move) — plus the sidedef's y-offset, and the quad is that band *clipped* to
the range below (`r_segs.c: R_RenderMaskedSegRange`, which draws the texture once and lets the seg's
clip arrays cut it). So the offset moves the quad itself, and an offset that carries the texture
clear of that range draws nothing at all: vanilla never tiles a midtexture vertically, and mappers
use exactly that to hide one. Sizing the quad to the opening and letting the offset run off into the
UVs instead makes a wrapped copy appear in the wrong place — BOOMEDIT.WAD MAP01 line 726's `ICESIGN`
(48 tall, y-offset −88, opening −16..128) drew up under the ceiling instead of at −8..40.
The opening a side is measured against, and the neighbour's ceiling its upper stands on, are the
**drawn** ones: a Boom 242 sector hands out its control sector's ceiling (§ Deep water).

### What cuts a midtexture

**The opening cuts a midtexture only where the upper and lower steps are actually drawn.** Vanilla's
clip arrays are a side effect of drawing those tiers: `R_RenderSegLoop` sets `ceilingclip` to the
bottom of the upper wall it just drew, but to `yl - 1` — this sector's **own** ceiling — where the
sidedef has no upper texture, and symmetrically `floorclip` to `yh + 1` with no lower. So a step the
mapper left untextured cuts nothing, and the midtexture runs on past it to this sector's floor and
ceiling. Two sky ceilings are the one exception: `R_StoreWallRange`'s "hack to allow height changes
in outdoor areas" pulls `worldtop` down to the neighbour's ceiling before any tier is chosen, so
that is where the cut lands.

This is what the **barred gate** idiom is built on, and it inverts without it. `EPIC.WAD` MAP02
sector 14 (tag 6, opened by line 66) is a 4-unit door strip closed at ceiling 1 in a sector 72 tall,
carrying `MIDBARS3` — 72 tall, y-offset 72 — on the neighbour's side of lines 75/76 with no upper
texture. Closed, the bars hang from the door's underside at 1 up to 73 and fill the doorway; open at
68 they ride up to 68..140 and only a 4-unit sliver stays under the ceiling. Clipped to the opening
instead, both states draw a degenerate quad and the gate is a hole you can see through either way.
Nothing across the committed WADs loses a midtexture to this rule — it only ever widens the cut, on
about 15 quads per DOOM2-based set (MAP22's `METAL2`, MAP31's `MIDGRATE`) and 46 in EPIC.

Coordinates: DOOM's `(x, y, z)` becomes three.js `(x, z, -y)`, so the map plane is XZ and Y is up.

Ceilings are never rendered — `buildMapMesh`'s `renderCeilings` option still exists and is always
`false`. From directly above, a rendered ceiling would hide everything under it; this is a permanent
view choice, not a debug convenience. It is also why the ceiling half of Boom's transfers has no
*plane* to show for itself: a 261 transfer only moves sprite light, and a 242 *fake ceiling* draws
no surface — though its height still sizes the walls across from it (§ Deep water).

## Mover meshes (`mapmesh.ts: buildMoverMesh`, `refreshMoverMesh`)

Every sector a specials mover can drive is left out of the static batches entirely and drawn from
its own small mesh instead (`MapMeshOptions.movableSectors`, `specials/movergeometry.ts`), which
`MoverGeometry.rebuild` brings up to date on each tic the sector's height changed. That call is on
the tic path for *every* moving sector at once, so two things about it are load-bearing:

**A rebuild costs the sector's own size, never the map's.** `buildMoverMesh` walks a `MoverIndex`
rather than scanning: its subsectors, grouped once per level, and its linedefs, which are vanilla's
`sec->lines[]` straight off `World`'s memo (docs/world.md § Neighbor-height queries). The index is
declared structurally in `mapmesh.ts` and supplied by `specials/movergeometry.ts: buildMoverIndex`,
the same split `SectorTransfers` uses to keep the renderer free of `game/` imports. Scanning instead
means all subsectors and all linedefs per sector per tic — quadratic in exactly the situation that
matters, since a bigger map has both more geometry to scan and more movers scanning it.

**A moving sector rewrites its buffers instead of reallocating them.** `refreshMoverMesh` writes the
new positions/UVs/colours into the existing attributes and updates the `WallOccluder`/`FlatSurface`
records field-by-field — the faders hold both the arrays and smoothing state indexed into
them, so replacing either would restart a moving wall's fade. (A height change never alters how many
chunks a wall is cut into *along its length*, since that follows its 2D footprint — the vertical cut
is the one it does move, and § A mover dices vertically only where nothing moves is about that.)
It returns false, changing nothing,
whenever the sector's batches no longer line up with the buffers they were built from (a quad
appearing or vanishing — an upper step shrinking to nothing as a door finishes opening); only then
does `rebuild` throw the mesh away and build a fresh one. Which means the fresh-build path stays the
definition of correct geometry: the refresh is only ever allowed to reproduce it exactly.

**Only the walls are rebuilt; the flats are moved.** A moving height changes which wall tiers exist
at all, so `buildMoverWalls` re-emits them from scratch every tic. A flat's footprint cannot change
— that is the same invariant `aLightCell` and `copyRefreshedQuad` rest on — so re-dicing one is
pure waste, and it was nearly all of the cost: on EPIC.WAD MAP05's biggest sector (598 leaves,
87 k flat vertices) a refresh spent 9.46 ms of a 28.6 ms tic, almost all of it pushing flat
vertices into fresh arrays. `planFlatRefresh` instead re-runs only the *decisions* `processFlat`
makes — `flatSpecsOf`, which is `processFlat` with the emission taken out — and matches them
against the fans the mesh holds; `applyFlatRefresh` then writes the new plane into the position
attribute's Y lane and the new colour, leaving x, z, UV and `aLightCell` untouched. Same sector,
0.52 ms.

A fan whose plane and light both held still is skipped outright, and **both halves of that test read
the fan's own record** (`FlatSurface.height`, `FlatSurface.light`) — the common case for a mover's
ceiling while its floor runs. The light must be carried on the record rather than recovered from the
colour attribute: `litColor` returns a double and the buffer stores float32, so comparing the two
round-trips wrong for 224 of the 256 light levels and the skip never fires. Testing before the mesh
is looked up also keeps the skipped case off the map lookup and the two attribute fetches.

What a tic *can* change is which fans a leaf draws at all — a rising floor takes a 242 pool below
`WATER_MIN_DEPTH` and its surface fan stops existing — and any such change is a refusal, exactly as
a changed quad count is. (Measured over 900 refreshes across E1M1, MAP15 and EPIC MAP05: the split
refuses on the same 255 as the old rebuild-everything check, never more.) A leaf too degenerate to
have produced a vertex produced no fan either and never will, so it is skipped wherever the mesh
holds nothing for it.

Repro for both: literalism.wad MAP18, whose voodoo-doll scripts (docs/specials.md § Voodoo dolls)
keep ~95 sectors moving per tic over 10.6k subsectors and 14.5k linedefs. Before the two, that map
spent the entire frame in `rebuildAround` and the DEVMODE profiler's "Specials" row read in the
hundreds of milliseconds.

### A mover dices vertically only where nothing moves

`addWall` cuts a wall into bands of `WALL_CHUNK_LEN` **both ways**, and the occlusion fade needs the
vertical half as much as the horizontal one: alpha lives at quad corners, so a wall that is one quad
tall has no vertices anywhere near a sightline crossing its middle and no ball of fade can dissolve
it (§ The fade is a hole, not a wall).

A mover cannot always have that cut. The band count is `ceil(height / WALL_CHUNK_LEN)`, so a moving
height changes *how many quads a wall is* — and the refresh above may only rewrite buffers whose
count held still. So the rule is per quad, and it is about the sectors that **size** it rather than
the sector that owns it: a quad dices vertically when the floors and ceilings it is measured from
cannot move. A one-sided wall reads one sector; every tier of a two-sided side reads two (the lower
spans the two floors, the upper the two ceilings), so one moving neighbour is enough to leave that
whole side undiced. `processLine`'s `holdsStill` asks it, against
`MapMeshOptions.movingSectors`.

That set is deliberately **not** `movableSectors`. A sector leaves the static batch either because a
special drives its height *or* because a switch texture on one of its walls has to be swapped, and
only the first stops the dicing — `scanSectors` answers both in one pass (`game/specials/mapscan.ts`):
`moving` is the first half alone, `movable` is it plus the switch hosts.

The distinction is not a corner case. One switch on one sidedef pulls its whole sector out of the
static batch, and on NUTS.WAD MAP01 that is the 12000-unit arena the player stands in *and* the pen
behind it, whose one-sided walls are 900 units tall — as single quads, the one thing on that map
that could never fade, and with the camera parked behind one at (-505, 6931) looking south the
player was simply gone. Treating a mover that only carries a switch as the static geometry it
actually is costs about a quarter more mover quads on a map with real movers (DOOM2 MAP01 137 →
169, EPIC MAP05 2515 → 3118) and turns NUTS MAP01's 689 into 4065, which is still nothing.

## Solid structures (`solids.ts`)

A pillar, a crate, a lamp post: DOOM draws them as a closed ring of **one-sided** linedefs with no
sector inside at all. Vanilla never has to draw the top of one, because you can never get above it.
This camera always is. Walls are drawn single-sided facing into their sector — the whole reason the
level reads as a dollhouse — so from overhead you look straight into a structure, past the inside of
its near wall, and out through the far one: a black hole where a solid block should be.

`solids.ts: findSolidCaps` reconstructs those rings and `mapmesh.ts: buildSolidCaps` lids them.
Three rules decide what a lid looks like, and each has a reason:

- **A ring is only a structure if its sector is outside it.** The same shape — a closed ring of
  one-sided lines — is also how a room's outer wall is drawn, and lidding *that* would roof the
  level. The two are told apart by probing a map unit off the front side of the ring's longest edge:
  the front side is the side the sidedef faces, so where that probe lands says which side the sector
  is on.
- **The lid sits at the lowest ceiling the ring borders**, since that is where the shortest of its
  walls stops. Taking the highest would float the lid above a wall top and leave the gap open again.
- **It wears the ring's own wall texture**, not a flat: over half of these structures stand outdoors
  under `F_SKY1`, so there is no ceiling flat to continue, and a solid block's top reading as the
  same material as its sides is what the shape wants anyway.

A ring whose every vertex joins exactly two one-sided lines is walked directly. A structure welded
onto a wall, or onto another structure, shares a vertex with a third line, and there the walk has a
real choice to make, so it falls back to tracing the **void face**: a one-sided line has its sector
on the right of `v1 → v2`, so void is always on its left, and a structure's outline is the face
lying to the left of every line on it. Keeping to one face means taking the **rightmost turn** at
each vertex — hugging the face on the left is turning as far from it as the lines allow. Taking the
leftmost instead follows a welded stub straight out of the structure, which is what the fixture in
`solids.test.ts` pins: against a pillar corner's 90° turn, its stub offers 154°.

The face walk is a fallback, never a replacement. Over the committed WADs it reproduces all 6505
rings the simple walk closes, line for line, and closes 706 walks that one gives up on; but four
rings the simple walk closes are ones it declines, since a ring wound inconsistently has no single
void side to follow. Net over those WADs: 31 new lids, no lid lost, and none of the new ones covers
any floor — checked by sampling each footprint and resolving the sector by ray crossing, the same
way `freedoom2.wad` MAP19's 124-vertex structure was confirmed to be solid rather than a roofed
building.

Lids are built once, into the static batches only: a structure never moves, and if the ceiling
*around* one does, its lid keeps the height the level loaded with.

Each lid is emitted as one `FlatSurface` **per triangle** (`THREE.ShapeUtils.triangulateShape`),
because these rings are frequently concave and `FlatFader` tests a surface's footprint with the
convex-only `segmentMeetsConvexPolygon` (§ Flats). Triangles keep that contract, so a structure between the
camera and the player dithers away exactly as a raised floor does — without that, capping them would
trade a hole for something worse: a pillar you cannot see your own player behind.

## Closed holes (`mapmesh.ts: closedHoleFill`)

A sector whose **every** side is a two-sided drop with no lower texture is a hole the mapper never
meant anyone to look into. Vanilla HOMs it, which is invisible from the floor of a first-person
view; from overhead it is a black pit in the middle of the level, because the sides draw nothing and
the pit's own floor is too far down to be in view — a 64-wide, 128-deep pit needs a ray steeper than
`atan(128/64)` to show any of its bottom, and this camera's steepest is 57.5° below horizontal.
Repro: EPIC.WAD MAP01 sector 88, three 64×64 pits at floor −144 in the −16 grass of sector 14, which
line 585 (a `19` W1 "lower floor to highest" that, the floor being *below* its neighbours already,
snaps it up instead) fills in later.

So every leaf of that sector is lidded with the surrounding sector's floor plane, drawn on top of
its real floor. **This follows GZDoom** (`hw_renderhacks.cpp: HandleMissingTextures` →
`DoOneSectorLower` → `AddOtherFloorPlane`), which is what the map was checked against, and not
vanilla, which has no such hack. Its conditions are GZDoom's:

- every side two-sided, i.e. no one-sided wall anywhere on the sector,
- every neighbour's floor **above** this one and all of them at the **same** height — the lid is one
  plane, so one height,
- that step drawing **no** lower texture (a textured one is ordinary geometry), and the neighbour's
  floor flat not being sky.

A sector *inside a pool* is left alone by all of this — `closedHoleFill` declines the moment a
neighbour carries a 242, Boom's idioms being built on missing textures. What it gets instead is the
pool's own surface drawn over it, docs/specials.md § Deep water's island rule.

**The test is per sector, never per BSP leaf**, and that is what makes it safe rather than tidy.
GZDoom decides per leaf but then floods across minisegs into the rest of the sector
(`DoOneSectorLower` recurses through every partner seg) and gives up at the first one-sided wall it
reaches. Vanilla SEGS carry no minisegs, so a leaf's splits into the rest of its own sector are
simply *absent* here — a leaf left holding a single seg reads as fully enclosed by it, and an open
room gets its floor painted over at the neighbour's height. Repro: DOOM2 MAP01 subsector 22, whose
one seg is line 335 (the barred alcove's floor, 48 units up), which lidded ~23,000 map units² of the
courtyard's grass with the alcove's flat; DOOM2 MAP31 subsector 31 was a 128×1536 slab of the same.
Scanning the whole sector's linedefs instead is GZDoom's flood with the recursion already done —
stricter only for a sector whose leaves fall into disconnected pieces, where GZDoom would still lid
the enclosed piece and this does not.

Those linedefs are vanilla's `sec->lines[]`, reached through `MapMeshOptions.linesOf` — the same
structural seam `MoverIndex.linesOf` uses, and for the same reason: `game/world.ts: sectorLines`
already builds and memoizes the index per map, and the renderer keeps no import edge into `game/`.
A caller that supplies none (tests, tools) gets a plain local adjacency list, which is deliberately
*not* a second `sec->lines[]`: `closedHoleFill` reads each line from one sector's side and is
idempotent in it, so a line listed twice changes no answer and the `P_GroupLines` ordering/dedupe
rule keeps a single implementation.

Three restrictions are this engine's, and each closes a way the baked lid could go stale or fight
something else:

- **No lid where a Boom 242 is involved** on either side. A 242 draws its floors at borrowed heights
  and the invisible-platform idiom *wants* its missing textures.
- **No lid over a movable neighbour** from the static batches — its height is what the lid is baked
  at. A mover's own sector has no such guard (`buildMoverBatches` passes no set): `MoverGeometry`
  already rebuilds a mover whenever a movable neighbour moves.
- **The lid is not gated on where the eye is.** GZDoom re-decides per frame and skips the hack when
  the viewpoint is *below* the fill height; baked geometry cannot. What covers the case is that the
  lid is an ordinary `FlatSurface`, so `FlatFader` dissolves it out of the way of a body underneath
  exactly as it does a solid structure's lid — a player who falls into the pit stays visible.

Neither is GZDoom's fallback path reproduced: where the neighbours sit at *different* heights,
GZDoom projects one of the floors through the gap from the viewpoint (`CreateFloodPoly`, per frame,
through a stencil) and this engine leaves the hole black. It is rare — over every committed WAD the
lid fires on 6–43 leaves per WAD set (13 of DOOM2's 13,253, none of DOOM1's 3,423).

## Sector lighting (`mapmesh.ts: lightToColor`)

This is vanilla's own lighting, and it is what lights everything by default. GZDoom's GLDEFS
dynamic lights sit *on top* of it — a second, additive term patched into these same materials'
shaders and into the sprite tints below. They are docs/lights.md; nothing in this section changes
for them.


Walls, flats and sprites are all tinted by a sector's light level through this one function, so
it decides how the whole game reads. Two things about it are easy to get wrong, and both were shipped
bugs.

*Which* sector's, though, is not always the surface's own: Boom's 213/261 hand a floor or a ceiling
another sector's light, and each of the three consumers reads a different one — flats take
`floorLight`/`ceilingLight`, walls take the sector's own level untransferred, and sprites take the
average of the two. The rules and their vanilla sources are in
docs/specials.md § Transferred lighting; what the renderer carries for them is
`FlatSurface.lightSector`, the sector a fan's colour actually came from, which is also what
`MoverGeometry` files its relight index under. On a map with no transfer line all three are the
sector's own light and nothing about this changes.

**The ramp is vanilla's own `COLORMAP`, measured from the lump rather than modelled.** Vanilla never
multiplies a colour by the light level: it picks one of `COLORMAP`'s 32 rows and remaps every palette
index through it, and that ramp is nothing like linear in light level. `COLORMAP_GAIN` is the mean
linear-luminance ratio of each row, measured across the PLAYPAL colours — the same "confirm it
against the real lump" discipline as the sprite and death-frame tables. DOOM.WAD's and DOOM2.WAD's
COLORMAPs are byte-identical and Freedoom's is within 0.003, so one baked table serves all three;
per-colour spread is ~12% of the mean (the ramp desaturates slightly as it darkens), close enough for
a single scalar per row. An earlier hand-tuned curve (`pow(l, 0.85) * 0.9 + 0.1`) was both far too
bright and far too flat.

Vanilla builds the row index as `startmap - scale/DISTMAP` (`r_main.c`), where
`startmap = (15 - lightnum) * 4` and the subtracted term grows as a surface gets *closer* — so in
vanilla the light level really sets how fast a surface falls off with distance, not a flat
brightness. This engine has no distance lighting (the camera hangs at a near-constant distance from
everything it draws), so the ramp is sampled once at a fixed reference distance: **`REFERENCE_STEPS`
is that subtracted term, and it is the knob to turn if the game reads too dark or too bright.** 4
(≈ a 300-unit viewing distance) puts a uniform ~0.12 of display brightness between adjacent light
segments across light 112-208, which is 88% of every sector in the stock IWADs. Both ends necessarily
saturate — vanilla spends 4 rows per light segment, so its 16 segments want 64 rows where only 32
exist. That is vanilla's ramp rather than a shortcut; it just never shows up in vanilla, where
distance fills the range back in.

**Light is quantized to DOOM's own 16 segments (`light >> 4`)**, so two sectors whose levels differ by
less than 16 are genuinely identical on screen, as in vanilla. Every stock map's sector lights are
multiples of 16 anyway. This is also what makes the fake-contrast offset work out: `addWall` passes
±16, which after the shift is exactly the ±1 *segment* nudge vanilla applies (`lightnum--`/
`lightnum++`). Vanilla **darkens** east-west walls and **brightens** north-south ones (`r_segs.c:
R_StoreWallRange`) so corners stay legible under flat sector lighting — this engine had that sign
inverted for a long time.

**The returned value is linear-light, not a display value.** Vertex colours (and
`material.color.setScalar`, for non-batched sprites) are consumed as-is by the shader, and the
renderer's `outputColorSpace` (`SRGBColorSpace`) encodes the final fragment to sRGB on the way out.
Returning a display-space value gets it gamma-encoded a second time, which disproportionately
brightens the dark end.

**A vanilla-exact ramp is still too dark for this camera, so there's a fixed brightness lift on top,
`BRIGHTNESS_LIFT` in `constants.ts`.** Vanilla's ramp assumes a first-person view a few dozen units
from what it's lighting, broken up by nearby bright surfaces and real depth cues; this camera looks
down on an entire dim room at once with neither. `applyBrightnessLift(linear, lift)` pushes a value
toward 1 by a fraction `lift` of its remaining headroom `(1 - linear)`, so black brightens by the
full amount and already-bright surfaces barely move — brighten the dark end, taper toward the bright
end, not a flat multiply. `lightToColor` itself is left untouched (still pure, still exactly
vanilla); `litColor` is `lightToColor` plus `BRIGHTNESS_LIFT` and is what every real draw call uses.
`BRIGHTNESS_LIFT` was found by feel, and lives in `constants.ts` because it's the one number in this
scheme meant to be hand-retuned later.

**Every sprite reads its light live, never a cached snapshot.** Sector light is mutable at runtime
(blinking/strobing/glowing sectors, switch-triggered changes — `game/specials.ts`'s
`SpecialsController`), and geometry always reflects that immediately via `MoverGeometry.recolorSector`. A
sprite must match: `game/things/defs.ts`'s `PosedThing` has no `light` field precisely so nothing can cache
one — every map thing (items, decorations, corpses, barrels, monster drops, dormant or actively
chasing monsters alike) reads `p.sector?.light` at the moment it's batched, not at spawn time. The
same discipline applies to anything that moves through space across a frame: `ProjectileLayer.update`
re-resolves `world.sectorAt` at the projectile's *current* position every frame rather than reusing
its launch-sector light, and the arch-vile's warning flame (`SpriteFxLayer`'s `followTargetId` case)
re-resolves it every time it re-derives its position from the target it's tracking. A stationary
one-shot effect (blood, puffs, teleport fog, impact explosions) only needs the single lookup `spawn`
already does, since it never moves and its lifetime is short enough that a mid-flight relight isn't
worth chasing.

## Wall occlusion fading (`occlusion.ts`, `textures.ts`)

Single-sided back-face culling only removes walls facing away from the camera; it does nothing about
a wall that legitimately faces the camera but sits directly on the camera→player sightline (a pillar
in front of the player). `WallFader` tests every wall quad's 2D footprint against that sightline each
frame and fades the ones that cross it, rather than the coarser fix of drawing the player on top of
everything, which would also show it through walls that genuinely separate it from the camera.

### The fade is a hole, not a wall

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
mesh had to withhold it, and § A mover dices vertically only where nothing moves is how far that
now goes.

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
the ramp and the constant they assert against cannot drift apart. They are feel dials in the strict sense: `tests/render/occlusion-fade.test.ts`
**imports them and sizes its fixtures from them** rather than mirroring their values, so either can
be retuned without a test going red. A test that reddens on a retune is pinning the dial, and is a
bug in the test.

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
height every tic, so a height-derived band count would change with them, and `refreshMoverMesh` may
only rewrite buffers whose quad count held still (§ Mover meshes) — banding them would force a full
rebuild per tic and restart every fade mid-motion. Doors and lifts are short enough that one band is
what they would get anyway.

Measured on EPIC.WAD MAP02 (the heaviest map to hand: 6,582 line sides), both cuts together take
wall quads from 6,795 to 11,602 and the whole fade pass from 1.10 to 1.16 ms/frame at 25 targets;
level mesh build goes 21 → 57 ms, once per load.

#### Nothing per-frame is per-quad

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

### The target is the billboard

**Both faders aim at an upright rectangle, not at a point.** A thing is drawn as a plane fixed
upright in the world that only turns about its vertical axis (`SpriteMaterialCache`, docs/sprites.md),
and `FadeTarget` says so: `z` is the middle of that rectangle and `halfHeight` how far it reaches
either side. Two rules follow, and both were bugs before they were rules — `BOOMEDIT.WAD` MAP01 at
(-1664, 713), looking south over the scrolling-texture block at y 768..800, is the case they were
found on.

**Every target's rectangle is its own body.** A monster carries its `mobjinfo.height` — 56 for an imp
to 110 for a cyberdemon — from `MONSTER_STATS` through `PosedThing.bodyHeight` and out of
`ThingLayer.awakeMonsters` as `StandingBody.height`; the player gets `PLAYER_HEIGHT`. Either way
`FadeTarget.z` is the middle of that span and `halfHeight` reaches from there to the feet and to the
crown, so the wedge covers the body exactly. It is the same centre-and-half-extent `shotPath` locks
onto (`ShotLock.halfHeight`, docs/combat.md § Auto-aim) built from the same field, and it is
DEHACKED-aware for free: a patch that retunes a height moves the fade with it. One shared
player-sized band was the earlier shape, and it failed the very case this section exists for — a lid
covering only a cyberdemon's head sits well above where that band reached.

The height is the **collision** height, not the drawn sprite's. `CachedSprite.quad.height` is what the
billboard measures on screen and is often the taller of the two, but `mobjinfo.height` is what every
other "where is this body" question in the engine already answers with, and a fade disagreeing with
the shot that follows it would be worse than one running a few units short.

**The cut plane is vertical.** Nothing behind the plane an upright sprite stands in can draw over
that sprite, so a corner past it is skipped; the plane is `TargetPlanes`' `(nx, ny, d0)`, the
camera→target offset *in plan*. A plane tilted to face the camera instead leans back over the target
by the camera's own pitch, so geometry that is well past the target but tall counts as in front of
it: at that MAP01 spot the boundary wall 73 units *behind* the player (linedef 148, `BROWN1`) had its
top corners 11 units on the camera side of a tilted plane, and dithered away to reveal the void
behind it. The normal is deliberately **not** unit length: every test compares two dot products taken
against that same normal, so scaling it changes neither side, and skipping the normalise matters at
the thousand-odd mover faders a frame refills. Being vertical, it also costs one dot product per quad
*end* rather than one per corner, since a quad's four corners share their two ends' answer.

**And the sightline is a wedge, not a ray** — from the eye to the whole rectangle, so it is the
sprite's own half-height thick at the target and nothing at the camera. `WallFader` counts a
crossing where a quad's `[botH, topH]` meets that wedge rather than the centre ray alone;
`FlatFader` crosses a floor's height plane over a *span* of the camera→target line — nearest the
target for the sprite's top, furthest for its feet — and pierces where that span meets a fan
(`segmentMeetsConvexPolygon`), rather than at the single point the centre ray lands on. Without it
anything covering only the upper half of a sprite is invisible to the fade: at that MAP01 spot, with
the camera around 40° off vertical, the lid on top of the block (§ Solid structures) cut the player's
head off while the wall under it dissolved, because the ray to the player's *middle* passes under
that lid and only the ray to their head goes through it.

The pierce is still filed at the point the centre ray lands on, not at whichever end of the span a
fan happened to catch: the dedup that lets one platform split into many fans file a single pierce
turns on a point that depends only on the height and the target (§ Flats), and an end clamped per
fan would file one pierce per fan instead.

Neither rule costs anything overall. Measured on the same EPIC.WAD MAP05 map the numbers above are
taken on, at 49 targets, medians of 200 updates: `WallFader.update` 0.86 → 0.76 ms — the vertical
plane is two multiplies per *quad* cheaper (the old tilted one already shared its height term across
a quad's four corners), and a quad's four corners now share its two ends' answer — against
`FlatFader.update` 0.062 → 0.108 ms for the span, which pays for the two extra crossings and the edge
walk that replaces a point test.

Three things keep that second figure from being worse, and all three are load-bearing where the
per-fan loop runs candidates × targets a frame. The three heights the span needs **share one
reciprocal each per target**, so the per-fan work is a multiply rather than a divide. The
bounding-circle reject **runs on the span's parameters, not its endpoints** — a fan's centre is
projected onto the camera→target line and clamped to `[tFar, tNear]`, which is seven multiplies and
no divide, and means a rejected fan never builds the four coordinates only the footprint walk wants.
And each fan's **winding is memoised** in `buildLayout` beside its bound circle (`windSign`), because
`segmentMeetsConvexPolygon` needs to know it and a shoelace pass per fan per target per frame would
re-derive it over rings that only a mover rebuild reshapes.

### Which sightlines a wall fades for

`WallFader.update`/`FlatFader.update` take a *list* of sightline targets (`FadeTarget[]`), not just
the player — `collectFadeTargets` (same file, called from `game.ts` with `ThingLayer.awakeMonsters`)
returns the player plus every currently-**awake** monster
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
`SpecialsController.updateFading` (doors, lifts) takes the same target list, reusing the identical
machinery for its own meshes.

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
*inside*
its line's vertical opening **and whose texture is masked** — a grate, fence or barred window is
built inside that opening (§ Mesh building), so a quad living inside it is the passable gap itself:
a shot and a look already pass straight through it, so fading it has nothing left to reveal.

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

The lookup is per line, but the test it feeds has to be a
**per-quad** check, not a per-*line* one — an earlier version gated on `World.blocksSight(line)` for
the whole line, which wrongly also suppressed fading for that line's upper/lower step quads (they sit
*outside* the opening — the riser exposed where the neighbouring floor/ceiling falls short — and are
genuinely solid regardless). DOOM2 MAP01's east imp closet (sector 38) is the concrete case: its
fence's masked-middle quad used to fade to near-invisible the moment the imp inside woke, reading as
the closet wall vanishing rather than "you can see the imp through the bars." `FlatFader` has no
equivalent gate — floors have no comparable "visually-solid-but-actually-passable" case.

### Flats

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
surface (§ Deep water), which is translucent precisely so a submerged player stays visible through
it — there is nothing left for a fade to reveal, and fading punches a *hole*: only the fans the
sightline actually crosses dissolve, so the sheet loses a patch around the player while the rest of
it stays. Repro: wade into any BOOMEDIT MAP01 pool and watch the water break up
overhead.

**`awakeMonsters` only returns monsters fog of war is actually drawing** (`p.actor.mesh.visible`,
which `ThingLayer.update` sets from `fogAlphaOf` earlier in the same frame). A monster in a subsector
the player has never had sight of isn't rendered at all, so fading the wall in front of it reveals an
empty dark room and nothing else — concretely, a MAP01 secret compartment's wall dithered away
whenever the imps sealed inside woke, with the imps still invisible. This is also why
`WallFader.update` needs no "only fade if this is the *sole* wall in the way" rule: whether fading
reveals anything is settled here, upstream. A blocker-counting version was written first for this
same symptom and fixed nothing — that wall had only one blocker; its monsters simply weren't drawn.

**The fade is a dithered discard, not real alpha blending.** Wall quads are batched one mesh per
texture across the whole map, three.js sorts transparent objects back-to-front per mesh, and with a
mesh spanning the entire level that order is meaningless — plus both meshes still write depth by
default, so whichever draws first can win the depth test and blank out the other. `MaterialBank`
instead injects a fragment-shader snippet (`onBeforeCompile`) that discards a per-pixel fraction of
fragments using interleaved-gradient-noise dithering, keyed off a per-vertex alpha `WallFader` writes
into the 4th colour channel. That keeps walls in the ordinary opaque,
depth-tested/written pass — no batching or sort-order concerns, just fewer pixels drawn. `holes`
textures (masked middles) already alpha-test on the *combined* texture × vertex alpha, so a faded
grate discards outright instead of dithering.

Fade amount is exponentially smoothed (`FADE_SPEED`) so walls don't pop, but a pure exponential lerp
never actually reaches its target — `update` snaps once the remaining gap drops below a threshold,
otherwise a wall settles a hair short of fully opaque forever and shows a permanent faint speckle
(the dither test is a strict `<`). Smoothing state is per chunk edge and per footprint point, held
in the fader's own arrays rather than on the records — which is what lets `refreshMoverMesh` rewrite
those records field by field mid-motion without restarting a fade (§ Mover meshes). The lerp factor
is hoisted per frame (`dampenWith`), since rate and `dt` are the same for every one of them.

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

### Skipping invisible mover meshes

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
whole map (§ Mesh building), so one is almost never wholly invisible, and keeping the map for them
costs a lookup per quad per frame across tens of thousands of quads for an answer nobody reads.

Why it matters is a mover-count problem rather than a geometry one: a Boom map's movable sectors
each get their own small mesh (§ Mover meshes), so literalism.wad MAP18's 973 of them add ~2,150
meshes averaging 8 triangles. Measured there at spawn, 2,144 of those 2,147 were fully transparent
while ~1,600 draw calls a frame were still being issued for them.

### Mover meshes a frame cannot touch

The same mover count is a per-frame CPU problem too, and for the same reason: each mover mesh
carries its own pair of faders, so Sunder 2512 MAP20's **1,633 movers** meant 1,633 × (two
`update`s, two `commit`s, a visibility walk) every frame over ~11,500 quads and ~4,900 fans in
total — seven quads a mesh, and the call overhead was the whole cost. `updateFading` skips a mesh
outright when nothing that could change it happened:

- **Nothing can reach it.** `fadeReach` is the sight box grown by the widest hole any target opens
  (§ Nothing per-frame is per-quad); a crossing lies on a sightline, so geometry whose footprint
  misses that box cannot be folded this frame. The mesh's own footprint is fixed at build time — a
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
included** (§ Mover meshes), so what the faders last wrote is gone from the buffer while their own
`lastCombined` still claims it — and `commit`'s unchanged-alpha skip then leaves the *builder's*
alpha standing. A lift moving through fog of war it has never lifted drew solid for the whole
stroke. `MoverGeometry.rebuild` calls `invalidateWritten()` on both faders after a successful
refresh, which is what makes the next commit write rather than recognize.

Measured on Sunder 2512 MAP20 at the player start, timing each part of `game.ts: updateFading`
separately: `SpecialsController.updateFading` 3.34 → 0.19 ms/frame, and with the wall-fader work
above the block as a whole 18.2 → 1.8 ms/frame. What is left of it is the flat fader, which still
walks its 49,716 fans a frame behind per-fan early-outs (§ Flats).

## Deep water (`mapmesh.ts: processFlat`, `ceilingFacing`)

Boom's 242 makes a sector draw at another sector's heights. Vanilla picks one of two views by where
the eye is; this engine draws both at once — an opaque water surface would hide a player who waded
into it, which a camera looking straight down cannot afford. So a water subsector gets **two** fans:
the pool bottom at the real floor height wearing the control sector's flat and light, and a
translucent surface at the control sector's floor height wearing the sector's own. The full rule,
including which vanilla branch each fan comes from and when no surface is drawn at all, is in
docs/specials.md § Deep water. A control sector *below* the real floor is the other idiom — an
invisible platform, one fan at the fake floor and no surface at all (docs/specials.md § The fake
floor).

Mechanically it is one extra `FlatSurface` reusing the same subsector index, so fog of war and
`FlatFader` need no notion of it, and the surface fades like any other raised floor. What it does
need is a rebuild edge: a water sector shares no linedef with its control sector, so
`MoverGeometry` links the two explicitly (§ Wall occlusion fading's product is otherwise unaffected).

**242 reaches the walls too**, and not only the flats: `R_FakeFlat` replaces the drawn *ceiling* as
well as the floor, and `r_bsp.c: R_AddLine` runs it over the backsector of every seg. So a
two-sided line facing a 242 sector sizes its upper — and caps the midtexture's opening — against the
control sector's ceiling. `Transfers.drawnCeiling` resolves that height — the ceiling-side
counterpart of the `waterHeight` the fans use — and `ceilingFacing` is what each side asks in place
of reading `Sector.ceilHeight` off its neighbour. Without it BOOMEDIT MAP01 lines 677-680 leave a
32-unit hole in the middle of a waterfall: sector 111's real ceiling is 192 but it draws at 32, so
`SFALL1` has to run 256..32 as one tiled upper rather than stopping at 192 and handing the rest to a
midtexture whose −32 y-offset has already carried it below the gap.

Two limits on the substitution, both load-bearing:

- **The floor is not substituted upwards**, because this engine draws the pool bottom at the real
  floor (above); walls sized to the *surface* instead would leave that bottom ringed by a hole. A
  control sector **below** the real floor draws no bottom and no surface — only the fake floor — so
  there the walls do move, in step with the one fan `processFlat` puts at `Transfers.drawnFloor`.
  Which sectors that covers, and why it is not simply every one of them, is
  docs/specials.md § The fake floor.
- **A fake floor moves both sides of a line, a fake ceiling only the neighbour's.** Vanilla fakes
  front and back sector alike (`r_bsp.c: R_AddLine`); the ceiling half needs the exception above
  because its branch turns on where the eye is, and the floor half does not — `R_FakeFlat`'s plain
  branch assigns it whoever is looking. So `drawnFloor` resolves a side's *own* floor as well as its
  neighbour's, in the lower step, the midtexture opening and a one-sided wall's bottom. Sizing only
  the neighbour leaves each face of a fake-floor sector hanging at its real height while the room
  around it sits at the drawn one: on BOOMEDIT MAP01 sector 110 the `242TEXTA` sign on whichever of
  the four walls faces the camera sits 32 above its neighbours, and re-seats itself as the camera
  orbits past a corner and the opposite face takes over.
- **A midtexture's peg anchor is not substituted at all** — only the opening it is clipped to.
  `R_RenderMaskedSegRange` reads `curline->frontsector`/`->backsector` off the seg and calls
  `R_FakeFlat` purely for the light level (`r_segs.c`), so the band hangs from the *real* floors and
  ceilings while `sprbottomclip`/`sprtopclip` — built from the faked ones in `R_StoreWallRange` —
  decide how much of it survives. Pegging off the drawn floor instead drops all four of BOOMEDIT
  MAP01 sector 110's signs to the room's floor and leaves them there whatever height the platform's
  lift is at. The visible effect of the clip alone is literalism MAP06 line 1058, whose `MIDBARS3`
  grate keeps its top at 64 and now reaches down to the drawn floor at −16 instead of stopping at
  the real 24.
- **Only the neighbour is faked, and only for a side whose own sector has no 242.** Vanilla's choice
  of branch depends on where the eye is, which a mesh built once cannot follow; but a wall quad is
  only ever seen from the sector it faces into, and an eye *inside* a 242 sector takes
  `R_FakeFlat`'s above-ceiling branch, which returns the real ceiling. Faking unconditionally
  instead flattens BOOMEDIT MAP01's colormap room (sectors 444-452, whose control sectors sit at
  floor level only to carry `GRYMAP`/`REDMAP`/`BLUMAP`/`GRNMAP`) into a room with no walls.

## What a frame costs (`viewport.ts`)

**This renderer is fragment-bound end to end.** E1M1 draws 32 calls and 5450 triangles, and GPU time
scales exactly linearly with the drawing buffer — 0.9 MP to 14.7 MP is 0.90 ms to 10.92 ms on an
integrated GPU, the same scene either way. Nothing here is helped by touching geometry, batching or
draw calls; every lever is *pixels* or *what each pixel does*. A top-down camera is why: the floor
covers the whole screen, so flats are the bulk of it (4.4 ms of a 5.0 ms scene) and the walls, thin
on screen however tall they are in the map, are the rest.

Two settings in `Viewport`'s constructor decide the pixel count, and both are load-bearing:

- **`setPixelRatio` is capped at 2.** Cost is per fragment, so a ratio of 3 is triple the frame for
  pixels no panel this runs on can show apart.
- **`antialias` is off once the pixel ratio reaches 2**, and that is a measured decision, not a
  stylistic one. MSAA resolves the whole multisampled buffer every frame *whatever is on screen*:
  with the entire scene hidden, a 14.7 MP frame cost 5.64 ms with MSAA and 0.03 ms without. That is
  38% of a full frame, and at a ratio of 2 it buys nothing — four device pixels per CSS pixel is
  already the supersampling 4x MSAA would approximate, the textures are point-sampled
  (`NearestFilter`, § Wall occlusion fading has the other half of that shader), and the occlusion
  fade discards whole fragments rather than shading partial coverage, so neither can use a coverage
  mask. Below ratio 2 there is no such supersampling and MSAA is kept.

The clear and the canvas present are not a cost worth thinking about — 0.03 ms of a 14.7 MP frame.

**Measure this in a browser, not by reasoning.** In-game, the DEVMODE profiler's `gpu` line is the
first place to look (docs/menu.md § Profiling overlay): when it dwarfs the `cpu` line beside it, no
row above it is worth touching. For a real experiment — an A/B of two shader variants, a resolution
sweep — docs/lights.md § Profiling has the recipe
(`EXT_disjoint_timer_query_webgl2`, which GPU chromium is pointed at, sizing the drawing buffer like
the player's). Halving a number that turns out to be 4% of the frame is how time gets wasted here.

## View distance (`constants.ts: VIEW_DISTANCE`, `game.ts`)

How far the player can see is the scene's **distance fog**, not a clipping plane: `game.ts` sets
`THREE.Fog` to the same near-black as the scene background, hazing in from
`VIEW_DISTANCE * FOG_START_FRACTION` and fully opaque at `VIEW_DISTANCE` (16000 map units) — both
dials sit in `constants.ts`, the fraction beside the distance it is a fraction of. Geometry
past it is black however lit or fog-of-war-revealed it happens to be, so **`VIEW_DISTANCE` is the
one dial for how much *already-explored* level is on screen** — the fade start follows it as a
fraction rather than being its own number.

Fog range is measured from the camera *eye*, which hangs `TopDownCamera.distance` (480 in manual
mode, 360–720 under the auto camera — docs/camera.md § Auto camera) back from the player, so the
view actually reaches that much less than `VIEW_DISTANCE` out in front.

**The camera's far plane is `VIEW_DISTANCE` itself**, not a number of its own (`camera.ts`): a far
plane below it would clip geometry the fog hasn't finished hiding, and the two were once separately
maintained literals that drifted into being exactly equal by luck. Deriving it is what keeps raising
the dial safe.

**The fog of war's reveal is this same number** — `game/fogofwar.ts` reads this dial directly rather
than keeping a radius of its own — because the player shoots what they can see, so unexplored
geometry is revealed out to exactly where the view ends and no further. Moving this dial therefore
moves what is revealed — and, because `ThingLayer` gates rendering, `pickMonster` and
`raycastMonster` on fog alpha, what is shootable — not just how far the view fades. The argument for
the identity, and the ~5100-unit ceiling past which the camera's frame rather than the fog bounds
the view, are in docs/fogofwar.md § Reveal radius.

The reveal cost that identity implies was measured rather than assumed, and it is nearly flat in the
radius: on real geometry walls bound reveal long before the radius does. Sampling ~60 vantage points
per map across `DOOM1.WAD`, `DOOM2.WAD`, `SCYTHE.WAD` and `oku2v31.wad` for subsectors that are
sight-clear, framed *and* past 5100 finds **none at all in the stock DOOM, DOOM2 and SCYTHE map
sets** — the exceptions are all wide-open maps with a vantage over a drop: freedoom2 MAP16 (5465
units, a 144-unit drop), NUTS.WAD MAP01 (7306, 300) and oku2v31 MAP01 (10679, 640). Correspondingly,
raising the reveal 5100 → 12000 across eight maps moved the spawn seed sweep by under 0.5 ms and the
subsector count revealed at spawn not at all, except on NUTS MAP01 (8 → 21).

## Scrolling textures

`occlusion.ts: SurfaceScroller` draws every scrolling surface: vanilla's linedef 48 (a front sidedef
scrolling 35 map-units/second forever, no trigger, active from map load — used surprisingly often in
the stock IWADs, 250 linedefs across both games, for waterfalls and lava streams) and Boom's whole
scroller family beside it, walls and floor/ceiling flats alike.

**It computes nothing.** Which surfaces scroll and by how much is simulation state owned by
`game/specials/forces.ts: Forces` (docs/specials.md § Scrollers and conveyors); this class indexes
the affected geometry once and applies the offsets it is handed. The read side is the structural
`ScrollOffsets` interface declared here and satisfied by `Forces`, so the render layer keeps no
import edge into the game layer — the same shape as `SwitchPairLookup`.

Mechanically it is `WallFader`/`FlatFader` again: index the affected vertex ranges once, rewrite one
attribute every frame — here `uv` instead of vertex alpha. Walls convert map units to UV through
each quad's own texture size (`MaterialBank.size`), so a narrow texture's pattern visibly cycles
faster than a wide one at the same rate, matching vanilla's offset-over-dimension math; flats divide
by a flat 64, since every DOOM flat is 64×64 and `processFlat` built their UVs with the same
constant. Both U and V scroll — Boom's `sc_side` writes `rowoffset` as well as `textureoffset`.

`WallOccluder` carries `line`/`frontSide` (threaded through `mapmesh.ts`'s
`processLine`/`addTwoSidedSide`/`addWall`) so the linedef's *front* (vanilla's `sidenum[0]`) quads —
the only side any of these numbers ever scrolls — can be found among the batched geometry; flats are
found through `FlatSurface`'s `sector`/`isCeiling`. A flat fan is an arbitrary-length triangle fan
rather than a fixed quad, so its untouched UVs are kept whole in a `Float32Array` and every frame's
offset is added to that base.

**Static-batch geometry only** — unlike `recolorSector`, which also reaches mover meshes
(§ Relighting mover geometry), this indexes the static batch alone, so a sector that both scrolls and
moves keeps its mover mesh unscrolled. In practice this excludes almost nothing real: a mapper puts a
scroller on decorative or conveyor geometry, rarely on a sector that also has to move.

The accumulated offset is wrapped to `[0, 1)` before being written into the single-precision `uv`
buffer, purely to avoid float32 precision loss over a long session — `RepeatWrapping` already renders
an unwrapped UV outside `[0, 1]` correctly, so the wrap isn't needed for correctness.

Each indexed surface remembers the wrapped offset it last wrote and **skips both the rewrite and the
re-upload when it hasn't changed** — the same shape as `WallFader.commit`. That is not a
micro-optimization: a batch key is `<kind>:<texture>`, so one mesh covers every wall sharing a
texture and `needsUpdate` re-uploads that whole buffer. A displacement or accelerative scroller
(245-249 / 214-218) sits at rate 0 for as long as its control sector is idle, which without the skip
would pay that upload 60×/s to write the numbers already there.

Whether the offsets advance at all is gated on `Forces.hasScrollers`, not on this class finding
geometry: the two differ exactly in the static-batch case above, and gating the *simulation* on a
render-side index would freeze every other scrolling surface along with the one that has no mesh.

## Animated textures

`render/textureanim.ts: AnimatedTextures` is the other half of `P_UpdateSpecials` — the "ANIMATE
FLATS AND TEXTURES GLOBALLY" loop, as opposed to scrolling's line-special loop above. Nukage, lava,
water and blood flats and the fire/blood/rock wall patterns all cycle through a fixed sequence of
named frames forever, no trigger, from map load, at 8 tics/frame (`animdefs[]`, `p_spec.c` —
every entry happens to share that speed).

**A WAD set carrying Boom's `ANIMATED` lump supplies its own table instead**, decoded by
`wad/animated.ts` and handed to the constructor — which is why the table is a parameter rather than
a module constant. `AnimDef` itself is declared there rather than here: the lump is where an
animation is *defined*, so the record sits on the wad side of the line and this module imports it,
never the reverse. The lump **replaces** `ANIM_DEFS` outright rather than
adding to it, and its per-entry `speed` is honoured (real PWADs do vary it), so nothing else here
changes. docs/wad.md § ANIMATED and SWITCHES.

One known limit: `MaterialBank.setFrame` keeps whatever `alphaTest` a name's *first* frame decided
and does not re-derive it per swap. No vanilla sequence has holes partway through; a Boom `ANIMATED`
could legitimately author one, and that frame would render without its cutout. Re-deriving would
mean a full alpha scan plus a shader recompile every animation tic, which is exactly the cost that
comment rejects — so this is recorded rather than fixed.

Vanilla's own comment on that table says the in-between frames are "all the flats/textures between
the start and end entry, in the order found in the WAD file," not a naming pattern — confirmed
necessary by entries like `FIREWALA..FIREWALL` and `FIRELAV3..FIRELAVA`, whose start/end names don't
even sort the way a digit sequence would. `GraphicsBank.textureNamesInOrder`/`flatNamesInOrder`
expose the same WAD-lump-order lists vanilla's own texture/flat tables are built from
(`readAllTextures`'s `Map` insertion order, and `flats`'s), so a sequence is resolved once at load
time by slicing between the start/end indices. A sequence whose start name isn't in the loaded WAD
set (an episode-exclusive animation in the wrong IWAD) is dropped entirely, matching vanilla's own
`R_CheckTextureNumForName`/`W_CheckNumForName` skip.

**No geometry work needed.** This engine already keys one material per texture *name*
(`MaterialBank`), and every quad using that name shares that one material's mesh
(`mapmesh.ts: BatchSet`) — so animating a name just means repointing its already-built material at a
different bitmap each tic (`MaterialBank.setFrame`), and every quad using it picks up the new frame
for free. `MaterialBank.has` gates this to names some batch actually uses, so an animation with no
on-screen name in the current map costs nothing beyond the initial WAD-order lookup.

**Per-frame offset is counted from the sequence's own start (`i` = 0 at the first name), not
vanilla's absolute internal texture-table index.** Real vanilla computes `pic = basepic +
((leveltime/speed + i) % numpics)` with `i` ranging over *absolute* texture indices, so a sequence's
apparent starting phase depends on where its first texture happens to land in vanilla's internal
table — a WAD-load-order artifact, not something meaningful to reproduce (this engine doesn't build
that same absolute index space at all). Using the in-sequence offset instead changes only that
arbitrary phase, never the cycle rate or frame order, and both are equally arbitrary to a player with
nothing to compare against.
