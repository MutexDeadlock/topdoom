# BSP polygon reconstruction (`bsp.ts`)

`src/render/bsp.ts`, `src/render/sectorprobe.ts`

How the subsector polygons every flat, wall cell and fog leaf stands on are rebuilt from a WAD's
nodes — and the four repairs a node builder's output needs before a polygon per leaf can draw what
vanilla's span renderer drew. What is built on them is docs/render.md.

`SEGS` only stores edges that lie on real linedefs — the edges created by BSP splits aren't in the
WAD. `buildSubSectorPolys` rebuilds each subsector by taking a quad covering the whole map and
clipping it (Sutherland-Hodgman) against every partition line on the path from the BSP root down to
that leaf, then against the subsector's own segs — skipping the minisegs a GL BSP closes its leaves
with, which lie on partitions the cell has already been clipped by (docs/wad.md § GL nodes), and any
seg with no length, which can answer none of the questions the clip asks of one. The
result is convex, so a triangle fan is enough.
Traversal is iterative (stack-based), not recursive — some maps have deep BSP trees.
`sectorOfSubSector` resolves a subsector's sector via its first seg → linedef → sidedef.

## Cracks between subsectors

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

**Only a seg the cell is already cut along gets any slack** (`cellCutAlong`): an edge of the cell
has to run within `PARTITION_MATCH` (2 units) of both of the seg's endpoints, which is what a
partition built from the seg's own linedef leaves behind. That is the whole premise of the slack —
two boundaries that are meant to be the same line, disagreeing by rounding. Where the cell has *no*
boundary on that line, the seg is the only thing bounding it there, no drift can have happened, and
the clip is exact: slack only leaves floor standing past the wall. Repros: DOOM1 E1M6's closet at
`(3448, -1536)`, an 80 × 128 room whose leaf gets the whole east of the map as its cell because
nothing out there needs a partition — scaled, its floor stood 11 to 22 units past all four walls,
in the open void, under a camera that looks over a 72-unit wall; and DOOM2 MAP01's wall along
`y = 1664` west of `x = 64`, where a flat 4 units left subsector 183 ending 4 units past the leaf
beside it, which a partition had cut on the wall exactly — a step in the floor's edge, in plain
view from the level's second room.

**The wall's line is the seg's linedef, not the seg** (`linedefLine`, oriented by `Seg.direction`).
A seg the node builder split ends on a vertex rounded to the integer grid, so the line through its
own endpoints sits up to √2/2 units off the wall; clipped exactly along *that*, a leaf loses a
hairline of floor at the wall's foot wherever the rounding fell inward — every long diagonal
one-sided wall in the stock maps has some (E1M8's outer walls, MAP20's). The linedef's vertices are
the wall itself, and the wall mesh stands on them. Every *side* question runs along that line — the
clip, the wrong-side judgement (§ Segs on the wrong side of their leaf), the preview of what a
spared cut would keep (§ Walls that stop inside their cell) — so they cannot disagree about which
side of the wall the cell is on. The seg's own endpoints keep only the *extent* questions: the
partition match and the slack's reach, which are about the rounded endpoints the partition was
built through, and the span a wall covers along its line.

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
leaves already fail to cover, which the slack was papering over with a neighbour's floor. Exact
along the linedef on an uncut seg, censused the same way, removes the overhang past such walls and
opens no crack; exact along the *seg* opens the hairlines above.

## Walls that stop inside their cell

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
segs on that line cover (`lineCoverage`: a seg of the same linedef by definition, one of another
linedef within `COLLINEAR_EPS`) — a wall that spans its cell is clipped by as before. There, the
ground just past the covered end is probed, a little onto the side the clip would remove: **this
sector's floor there means the wall has ended and the leaf carries on around it**, so the cut is
spared. Void or another sector means the level's own outer wall, which is what the seg clips are
*for*, and the cut stands. The probe is geometric (nearest linedef, and which side of it) rather
than a BSP lookup — the tree is what is being rebuilt, so it cannot be the authority on where a
point is. It lives in `sectorprobe.ts` as `SectorProbe`, which buckets the linedefs at 256 units so
a probe scans a neighbourhood, and is built lazily: most maps have neither a stub nor a
self-referencing sector and never ask it anything.

A spared cut keeps the floor *under* the stub's structure too — the test case is a 64-unit block
standing in a 512-unit cell, and the whole cell survives. On screen that reads right only because
`solids.ts` lids such a block (docs/render-solids.md); where it declines a ring,
the floor now paints through the structure rather than leaving the old hole.

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

## Segs on the wrong side of their leaf

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

## Self-referencing sectors

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
`mapmesh.ts`'s mover meshes, which key their flats off it. A self-referencing sector that is itself
a mover (an invisible lift is the stock example) therefore contributes no flats of its own to raise:
its leaves are baked into the enclosing sector's static flats, which is what vanilla shows too,
since none of them were ever drawn.

## Leaf adjacency (`bsp.ts: buildLeafGraph`)

Which leaves border which — what `closedHoleFill` walks. GZDoom reads it off `seg_t.PartnerSeg`;
vanilla SEGS carry no minisegs, so a leaf's splits into the rest of its own sector have no seg to
read a partner off at all, and the neighbour has to be recovered geometrically: half a map unit past
the midpoint of every polygon edge, resolved with `subsectorAtPoint` (vanilla's
`R_PointInSubsector`). Built once per map, weak on it, beside the polygons.

The probe is what makes it approximate, and the two ways it can be wrong pull in opposite
directions. A leaf thinner than the probe distance is stepped over, so an edge can name the leaf
*behind* the neighbour; and `segClipTolerance` lets a polygon overhang its true cell by up to 32
units (§ Cracks between subsectors), so an edge midpoint may already sit outside the leaf it belongs
to. Both cost a link or add a wrong one; neither is load-bearing anywhere the graph is used, since
`closedHoleFill` treats an unexplained neighbour as grounds to give the whole region up.

## Islands (`bsp.ts: buildIslands`)

Which leaves form one connected region, as an island id per leaf — what the fog draws and hides by
(docs/fogofwar.md § Islands). Two rules union, and **both err toward connected**: a spurious link
only fails to hide something, a missing one is a permanent black hole in the view.

- **Every two-sided seg** joins whatever `subsectorAtPoint` finds `NEIGHBOUR_PROBE` past its
  midpoint on *both* sides. Neither side is necessarily the leaf the seg was filed under: a seg can
  sit anywhere along its line.
- **A leaf-adjacency neighbour** (§ Leaf adjacency) whose physical sector is the same, or is one a
  two-sided line joins to it anywhere on the map. A BSP split inside a sector leaves no seg between
  the halves at all, so the first rule cannot see it; the sector-pair test is what keeps the probe
  from stepping across a void into an unrelated room.

Rejecting an adjacency the way `closedHoleFill` does — a one-sided line cutting the probe pair —
**must not** be used instead: `segClipTolerance` lets a polygon overhang its cell by up to 32 units
(§ Cracks between subsectors), so an edge midpoint can sit outside the leaf it belongs to, and every
stock map measured came apart into single-leaf islands.

The partition is checked against sight, which cannot cross a one-sided wall: a leaf revealed from a
vantage in another island is an error. With a vantage on every leaf centroid, 0 errors on E1M1,
E1M3, DOOM2 MAP01/MAP02/MAP15/MAP29/MAP30, freedoom1 E1M1, freedoom2 MAP03/MAP16, BOOMEDIT MAP01,
mbfedit!.wad and GoingDown MAP01/MAP03. Every stock map is one island; BOOMEDIT MAP01 is 27, DOOM2
MAP30 three.

Built once per map, weak on it, beside the polygons. The union passes cost 0.5 ms on DOOM2 MAP15's
875 leaves, 2.1 ms on BOOMEDIT MAP01's 1549 and 3.7 ms on GoingDown MAP01's 2232; the leaf graph
they walk is the one `mapmesh.ts` already builds.

**How many a level came apart into is on `game.ts`'s level-load line**, as `N islands` — the ids
`buildIslands` hands out are dense, so `islandCount` is the highest plus one. It reads the memo the
fog grid's own build filled, and never partitions a second time.
