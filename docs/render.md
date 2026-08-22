# Rendering

`src/render/bsp.ts`, `src/render/solids.ts`, `src/render/mapmesh.ts`, `src/render/occlusion.ts`,
`src/render/camera.ts`, `src/render/textures.ts`, `src/render/textureanim.ts`

The level's own geometry: rebuilding it, lighting it, fading it and framing it. Things drawn *in*
that level are docs/sprites.md; the loop that drives a frame is docs/frameloop.md.

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
records field-by-field — the faders hold both the arrays and per-quad smoothing state indexed into
them, so replacing either would restart a moving wall's fade. It returns false, changing nothing,
whenever the sector's batches no longer line up with the buffers they were built from (a quad
appearing or vanishing — an upper step shrinking to nothing as a door finishes opening); only then
does `rebuild` throw the mesh away and build a fresh one. Which means the fresh-build path stays the
definition of correct geometry: the refresh is only ever allowed to reproduce it exactly.

Repro for both: literalism.wad MAP18, whose voodoo-doll scripts (docs/specials.md § Voodoo dolls)
keep ~95 sectors moving per tic over 10.6k subsectors and 14.5k linedefs. Before the two, that map
spent the entire frame in `rebuildAround` and the DEVMODE profiler's "Specials" row read in the
hundreds of milliseconds.

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
convex-only `pointNearConvexPolygon`. Triangles keep that contract, so a structure between the
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

`WallFader.update` also takes an `openingOf` callback (`World.openingOf`, threaded through so this
class needs no `World` reference) and skips fading any quad whose own `[botH, topH]` sits *inside*
its line's vertical opening — a masked middle texture (grate, fence, barred window) is built inside
that opening (§ Mesh building), so a quad living inside it is the passable gap itself: a shot and a look
already pass straight through it, so fading it has nothing left to reveal. This has to be a
**per-quad** check, not a per-*line* one — an earlier version gated on `World.blocksSight(line)` for
the whole line, which wrongly also suppressed fading for that line's upper/lower step quads (they sit
*outside* the opening — the riser exposed where the neighbouring floor/ceiling falls short — and are
genuinely solid regardless). DOOM2 MAP01's east imp closet (sector 38) is the concrete case: its
fence's masked-middle quad used to fade to near-invisible the moment the imp inside woke, reading as
the closet wall vanishing rather than "you can see the imp through the bars." `FlatFader` has no
equivalent gate — floors have no comparable "visually-solid-but-actually-passable" case.

`FlatFader` is the same test for a horizontal plane: a raised floor sitting between the camera and a
target standing below it. Only floors above the target's own height are candidates, which excludes
the floor being stood on by construction — no "which subsector am I in" tracking needed. The
sightline crosses a given floor height at exactly one (x, y) point, but the BSP routinely splits one
physical platform into several subsector polygons, and a plain point-in-polygon test faded only
whichever fragment contained the crossing, leaving its siblings solid beside it (DOOM2 MAP05's
rocket-ammo balcony: one platform, 3 subsectors). `pointNearConvexPolygon` inflates the test by
`PLAYER_RADIUS` so fragments within the player's own width of the sightline fade together.

**A flat with a base alpha below 1 is exempt from the fade entirely.** The only one is a 242 water
surface (§ Deep water), which is translucent precisely so a submerged player stays visible through
it — there is nothing left for a fade to reveal, and fading punches a *hole*: only the fans the
sightline actually crosses dissolve, so the sheet loses a patch around the player while the rest of
it stays. The `PLAYER_RADIUS` inflation above widens that patch but cannot close it, since a pool is
many subsectors wide. Repro: wade into any BOOMEDIT MAP01 pool and watch the water break up
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
(the dither test is a strict `<`).

**Three inputs share that one channel, and `commit` writes their product.** Occlusion fading and
fog of war are the two that change per frame; the third is a surface's *base* alpha, fixed at build
time — a Boom 260 midtexture's 66% (`WallOccluder.baseAlpha`) or a deep-water surface's
`WATER_SURFACE_ALPHA` (`FlatSurface.baseAlpha`). Being constant, it costs nothing: `commit` already
skips a surface whose alpha has not moved. Note that a midtexture quad is exempted from occlusion
fading by `update`'s passable-gap test, so for a 260 grate the base is usually the only factor
below 1.

### Skipping invisible mover meshes

Because that product is what decides whether a surface shows at all, `commit` also records the
highest alpha it resolved per mesh key (`maxAlphaByKey` on both faders). A mover mesh whose every
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

## Camera orbit and camera-relative movement (`camera.ts`, `game/input.ts`, `game/player.ts`)

`TopDownCamera.yawDeg` lets the camera orbit around the followed point by pressing `Q`/`E`
(`KEY_YAW_STEP`, a 45° step per press). Tilt and distance are unaffected, so the camera always stays
the same amount off vertical.

**Orbiting is keyboard-only on purpose.** A right-mouse drag used to rotate it too, and that fought
the cursor: the mouse is the aiming hand, so a drag that swings the world underneath the crosshair
moves the aim point as a side effect of turning. The freed right button is now a menu-bound action
instead (docs/menu.md § Right mouse button).

`viewerAngleDeg` (`yawDeg - 90`) is the DOOM-space bearing from the followed point to the camera, and
is what sprite rendering and player movement both key off — at the default `yawDeg = 0` it's `-90`,
matching the old fixed south-facing camera exactly, so nothing downstream needed a special case for
"not yet orbited."

A `stepYaw` call (Q/E) queues its step as a `targetYawDeg` for `tick` to animate `yawDeg` towards
(`YAW_STEP_SMOOTH_RATE`) rather than jumping. Plain assignment (`camera.yawDeg = ...`, whose only
remaining caller is the instant reorient on spawn/teleport) still jumps immediately: the `yawDeg`
setter keeps `targetYawDeg` in lockstep so nothing left over from a prior Q/E animates after an
instant set. **Nothing may assign `yawDeg` unconditionally every frame** — even a no-op `-= 0` snaps
`targetYawDeg` back to the current (still mid-animation) value and cancels a Q/E step after one frame
of smoothing, which is what forced the removed drag handler to guard on a nonzero delta.

All of that input handling lives in `TopDownCamera.applyYawInput`, which `game.ts` calls once a
**tic**. Holding Q/E auto-repeats the same 45° `stepYaw` every `KEY_YAW_REPEAT_INTERVAL` —
`qHoldTime`/`eHoldTime` accumulate `dt` while `Input.held` is true and fire+reset once the interval
is reached, alongside the immediate step fired on `Input.pressed`. The interval is tuned to roughly
the time one step's smoothing takes to settle, so a hold reads as continuous rotation made of chained
steps.

Movement (`Player.update`'s `forwardDeg`, passed as `camera.viewerAngleDeg + 180`) is camera-relative
rather than DOOM-axis-relative: `W` always moves the player away from the camera *on screen*,
regardless of orbit. `game.ts` recomputes this every tic from the live camera angle.

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

Two angles come out of this, and mixing them up is the easy mistake. `viewerAngleDeg` is **tic-exact**
and is what the simulation reads; `viewAngleDeg` is the interpolated pose actually drawn, and is what
billboards must orient to — using the tic-exact one there leaves every sprite a fraction of a yaw snap
out of line with the walls behind it. docs/frameloop.md § Interpolation.

**The camera outlives the level**, since it belongs to the `Viewport` and a load only replaces the
`Game` — so the follow point's exponential smoother still holds the *outgoing* level's position when
the next one starts. `loadMapByIndex` therefore ends the player's placement with `snapTo`, which puts
the smoothed point, the interpolation source and the `THREE` camera itself on the new player position
at once; without it a level change or a save restore opens with the camera gliding in from wherever
the last level left it. It poses the `THREE` camera immediately rather than leaving that to the next
`applyToCamera` because two paths render without one (the pause loop's `stillFrame`, and
`captureThumbnail`). The yaw has had this since the beginning — the `yawDeg` setter is the same
collapse for the orbit angle — which is why `snapTo` is called *after* whichever branch set the yaw.

**A teleport is the same discontinuity** and takes the same pair, in the same order (docs/specials.md
§ Teleporters). It used to snap only the yaw, which left the camera flying to the landing spot over
roughly a third of a second while the player was already there and shooting. What still glides after
either snap is the aim lead alone — `tick` re-applies it to the fresh target on the very next tic —
which is bounded by `maxLead` and is the intended follow-the-cursor feel rather than a leftover.

## Aim lead

The follow point is nudged `aimLead` (0.18) of the way from the player toward the cursor, capped at
`maxLead` 220 units so the player never leaves the screen. **What it leads toward is always the
cursor's own aim-plane point (`pointerToPlane`), never what auto-aim locked onto**, and the two are
not the same place: the lock returns the monster's anchor, which for a billboard under the pointer
sits somewhere else entirely than where that pointer meets the plane. Feeding `tick` the lock made
the view lurch every time the cursor crossed a monster and again when it left — motion the player
never asked for, from a system that is supposed to be invisible. `game.ts: updateLivingPlayer`
therefore returns the plane point specifically, while `Player.angle` and the shot keep the lock
(docs/combat.md § Auto-aim).

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
(64/400) and `AHEAD_NEAR`/`FAR` (128/640). They cannot share one: a median runs roughly half of
what the cosine-weighted mean does, so a window that suits one saturates the other. Both were
picked off measured distributions rather than guessed — sampling every thing position in E1M1,
DOOM2 MAP01/MAP07 and EPIC MAP01 — which is also how the original 192/960 was caught leaving the
wide end of the framing unreachable on every one of those maps. The eye test above left both
windows where they were — on maps built out of rooms, whose walls close in 2D anyway, it barely
moves the distributions at all. What it changes is the maps that aren't.

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

## View distance (`constants.ts: VIEW_DISTANCE`, `game.ts`)

How far the player can see is the scene's **distance fog**, not a clipping plane: `game.ts` sets
`THREE.Fog` to the same near-black as the scene background, hazing in from
`VIEW_DISTANCE * FOG_START_FRACTION` and fully opaque at `VIEW_DISTANCE` (16000 map units) — both
dials sit in `constants.ts`, the fraction beside the distance it is a fraction of. Geometry
past it is black however lit or fog-of-war-revealed it happens to be, so **`VIEW_DISTANCE` is the
one dial for how much *already-explored* level is on screen** — the fade start follows it as a
fraction rather than being its own number.

Fog range is measured from the camera *eye*, which hangs `TopDownCamera.distance` (480 in manual
mode, 360–720 under the auto camera) back from the player, so the view actually reaches that much
less than `VIEW_DISTANCE` out in front.

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
