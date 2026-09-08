# Rendering

`src/render/mapmesh.ts` + `mapmesh/`, `src/render/viewport.ts`, `src/render/voidfloor.ts`,
`src/render/playershadow.ts`, `src/render/scroller.ts`, `src/render/textureanim.ts`

The level's own geometry: how the mesh is built from the subsector polygons and what a frame of it
costs. Four parts of the renderer have docs of their own: rebuilding those polygons from a WAD's
nodes is docs/render-bsp.md; the lids on crates and pillars are docs/render-solids.md; sector
light, wall shading and the sky tint are docs/render-lighting.md; the fade that keeps the player
visible through a wall is docs/render-occlusion.md. The camera that looks at it — orbit, aim lead,
the auto framing — is docs/camera.md; things drawn *in* the level are docs/sprites.md; the loop
that drives a frame is docs/frameloop.md.

## Mesh building (`mapmesh.ts`, `mapmesh/`)

`mapmesh.ts` is the entry point and holds `doomToWorld`/`worldToDoom`, `buildMapMesh` and the two
mover entries. `mapmesh/defs.ts` holds the shapes a built map is handed around as and the chunk
grid, `build.ts` the batches and the vertex push, `walls.ts` and `flats.ts` the two halves of a
build, `movers.ts` the rebuild-in-place of one moving sector.

Walls are built per linedef from sidedefs: one-sided lines get their middle texture over the full
sector height; two-sided lines get upper/lower steps plus an optional masked middle, following
DOOM's pegging rules (`UPPER_UNPEGGED`/`LOWER_UNPEGGED`) for vertical alignment. Walls are drawn
single-sided (facing DOOM's defined front), which is what culls walls between the camera and the
player and produces the open dollhouse look — no extra logic needed. `F_SKY1` flats are skipped.
Each of those surfaces is then cut lengthwise into quads of at most `WALL_CHUNK_LEN`, so the
occlusion fade can dissolve part of a wall rather than all of it (docs/render-occlusion.md § The
fade is a hole, not a wall) — a chunk is what a `WallOccluder` record and every per-quad rule below
mean by "quad".

**Which of the two steps a side draws, and between what heights, is `twoSidedBands` — exported,
because the auto camera asks the same question.** `addTwoSidedSide` sizes its quads from it and
`game/autocamera.ts`'s `hidesFromCamera` decides what can hide the player from it, so the rule has
one owner. It matters because the heights are the *drawn* ones, resolved through Boom's 242
transfers (§ Deep water) rather than read off the two sectors — the second copy that used the raw
heights went blind to the wall across from deep water (docs/camera.md § Framing past an occluder).

Every vertex carries three attributes beyond position and UV: the sector's baked light as a vertex
colour (docs/render-lighting.md § Sector lighting), the fade alpha both faders and fog of war write
(docs/render-occlusion.md), and **`aLightCell`, the BSP leaf that surface faces into** — a flat's
own, a wall's the one its face looks at, probed once by `fillWallCells` and recorded on the occluder
so fog of war can take the same answer. It is what lets a dynamic light stop at a wall
(docs/lights.md § Light stops at walls), and it is written once: a mover changes heights, never a
quad's footprint, so `refreshMoverMesh` leaves it alone.

Two more are optional: `aWallShade` and `aSkyLit` (docs/render-lighting.md § Wall contact shading,
§ Outdoor sky tint), both per-vertex amounts in [0, 1] — see § What the buffers cost.

Every builder threads one `Build` record: the map, the options resolved once, and the arrays each
appends to. A whole-map build and a mover's differ only in the `holdsStill`/`includeSide` predicates
on it (§ Mover meshes), so nothing below `buildMapMesh`/`buildMoverMesh` branches on which it is in.

### What the buffers cost

`aWallShade` and `aSkyLit` are uploaded as **normalized bytes, and only where some vertex in the
batch is non-zero** (`setUnitAttribute`). An attribute three never binds reads back as 0 in the
shader, which is what unshaded and indoors already mean, so a wall batch — never shaded — and a
level with no sky drop the buffer outright. 1/255 of the amount is under one level of the 0-255
colour it multiplies, so the quantization is not visible. `aLightSeg` (docs/render-lighting.md §
Distance lighting) is a plain byte too, but always bound: segment 0 is a real value, not the absence
of one — and it is the *only* record of how lit a surface is, since the vertex colour's RGB is a
flat 1.

Measured over DOOM2 MAP01/07/15/29 and GoingDown MAP01/15/30, 464k vertices in all: **3.54 MB of
attribute buffer becomes 0.65 MB**, 82% less.

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

### Ceiling trims

**A thin ceiling step over an opening the player walks under is not drawn** — `twoSidedBands`'
`upperTrimmed`, this engine's own and **a deliberate deviation** from vanilla, which draws every
upper the mapper textured. From overhead such a step is a ribbon floating in mid-air with nothing
under it: DOOM2 MAP01's platform (sector 23) carries an 8-unit `STEP2` upper along its whole outline
(lines 272-283), 176 units over the player's head, and it reads as clutter rather than as geometry.
A first-person view never has the problem — the step sits at the top of the frame, against the
ceiling it belongs to.

Two clauses (`trimsCeiling`), measured off the same `DrawnBands` record, so the drawn heights
(Boom's 242 transfers included) are the ones judged, and one exemption:

- **The step is at most `TRIM_MAX_HEIGHT` (16) tall.** Above that it is the wall over a doorway,
  which is what tells you where a room ends.
- **`TRIM_MIN_OPENING` (56, vanilla's `MT_PLAYER` height) is left under it**, measured from the
  higher of the two drawn floors. Under that the step is a window sill or a closed door's face,
  which is structure however thin.
- **A sign keeps its step.** A sign is a texture the map paints **whole** everywhere it draws it —
  every wall, riser and step carrying it is exactly the texture's own height (`TrimIndex.signs`) —
  hung in a sector no wider than `TRIM_MAX_SIGN` (64). An exit sign is a 16-tall texture on a
  16-unit step over an 8 x 32 box; a recess rim is a 128-tall wall texture cropped to 4 or 16
  units, and a ribbon runs round a room. Both halves are needed: GoingDown MAP08's `COMPSPAN`
  recesses (sectors 147, 153) show that texture nowhere else, so by use alone they are signage;
  and freedoom paints its 16-tall `STEP` riser textures only on 16-unit ribbons on some maps, so
  by wholeness alone those ribbons are signs.

The sign test needs the art, which the map does not carry. `beginBuild` is the only caller holding
a `MaterialBank`, so it is the one that seeds `trimIndex`; `trimsCeiling` only ever *reads* the
memo, which is what keeps the auto camera's rays on the verdict the mesh actually drew without
threading a set through `twoSidedBands`. A caller with no build behind it — tests, tools — hangs no
signs and trims every thin step. The heights are the sectors' own, not the drawn ones: a 242
transfer changes what a wall draws, not what the mapper sized a texture for.

**Nothing separates a sign from a recess by shape**, and nothing by texture *use* alone either —
the exemption needs the texture's height. Censused over 287 `EXIT*` sides and 30067 others, the
opening under the step, the neighbour's shallowest and widest dimension, the share of a texture's
uses that are walls, whether the recess wears the step's texture elsewhere, whether its ceiling
flat differs from the room's (every sign's does) and whether the texture is ever drawn as a wall or
riser (DOOM's editors set all three slots at once, so a sign's own lines carry it as an undrawn
lower, and MAP07's sign draws it as a 16-unit riser) all overlap. A size exemption on its own — a
neighbour no wider than 64 whose texture is on fewer than 48 steps — shipped first and kept what
the rule exists to remove: MAP08's 64 x 32 `COMPSPAN` recesses of 4 units and its 8-unit
`DOORTRAK` and `METAL` bits (sectors 174, 182, 184) floated over the warehouse floor like any
ribbon.

Both answers come out of one pass over the linedefs, built once per map (`trimIndex`, weak on it) —
a mover rebuilds through here every tic it runs and neither moves with a height. Art heights are
memoised by name inside that pass, not looked up per side: GoingDown MAP28, 11234 linedefs and the
largest committed map, draws 56 distinct textures over 13560 sides.

Censused over the committed WADs, as a share of the drawn upper sides: DOOM1 60 of 1200, DOOM2 639
of 4585, freedoom1 4917 of 18414, freedoom2 5957 of 18200, GoingDown 18524 of 51491. **Every
`EXIT*` upper in both id IWADs survives**, and 401 of the 451 across all five. The 50 that go are
what the rule says they are: GoingDown MAP09's six 16 x 16 octagons (sectors 364-369) carry 8-unit
slivers of the 72-tall `SW2EXIT` switch texture on 6-unit sides, decoration no one reads; MAP31
tiles `EXITSIGN` down a 128-unit wall (line 82), which makes it material there; and four banners
run along sectors wider than 64 — freedoom1 E1M9's 192-unit `EXITSGN2` strip, freedoom2 MAP28's
120, GoingDown MAP22's 344 and MAP24's 168. `TRIM_MAX_HEIGHT` at 32 takes 672 sides on DOOM2 and
starts on door lintels (63 `METAL` sides that are door frames); raising `TRIM_MAX_SIGN` saves the
banners one by one and keeps a whole-textured `STEP` ribbon for each.

**How many steps a level lost is on `game.ts`'s level-load line**, as `N ceiling trims` beside the
triangle count — `BuiltMap.trimmedUppers` plus `MoverGeometry.trimmedUppers`, since a line touching
a mover is built out of the static batches and would otherwise go uncounted. Read once, at load: a
mover rebuild moves its own tally and nothing reports it again. DOOM2 MAP01 25, MAP05 52, MAP29 25,
GoingDown MAP01 9.

**The whole rule is a setting** — *Visuals → Top-down extras → Hide thin ceiling steps*, on by
default, on the `ceilingTrims` setting (`getCeilingTrims`/`setCeilingTrims` in `mapmesh/walls.ts`).
Off, every upper the mapper textured is drawn. Read once per level, where `trimIndex` builds the
memo, and latched on it: a trim is baked into the static batches, so a toggle mid-level would leave
a mover rebuild disagreeing with them. The row says it takes the next level load.

**A step either of whose sectors can move keeps its upper** (`Build.holdsStill`, the same predicate
the vertical dicing asks). A door's upper shrinks as it opens, so without that a wide door sheds its
header the tic it passes 16 units, mid-travel.

**The trim still counts as drawn for the midtexture clip.** That clip follows vanilla's rule about
what the mapper *textured* (§ What cuts a midtexture), not this engine's about what it draws, so the
tier is asked for with `wallTextureSize` and simply not emitted — a barred gate hung in a trimmed
doorway is cut where vanilla cuts it.

**The verdict lives in `twoSidedBands` rather than in the mesh builder**, because the auto camera
reads the same record to decide what can hide the player (docs/camera.md § Framing past an
occluder): a quad that does not exist must not be an occluder either. The mover exemption above is
the one half the camera does not apply — it reads live heights and has no notion of a build's
movers, so a moving door's header is trim to it while it is drawn. `standsOver` also requires an
occluder to reach within 64 units of the eye, which a ceiling step under a camera hanging 585 units
up never does.

## Mover meshes (`mapmesh.ts: buildMoverMesh`, `refreshMoverMesh`)

Every sector a specials mover can drive is left out of the static batches entirely and drawn from
its own small mesh instead (`MapMeshOptions.movableSectors`, `specials/movergeometry.ts`), which
`MoverGeometry.rebuild` brings up to date each frame the sector's drawn height changed — at the
interpolated heights `SpecialsController.drawMovers` writes, docs/frameloop.md § Interpolation.

**A line touching a mover leaves the static batch on *both* its sides**, not just the one the mover
owns. DOOM puts a platform's visible front texture on the sidedef of the lower sector looking at it
— the static room's side of the line, not the lift's — so leaving that side static freezes the
lift's front wall at its raised height while the platform slides down behind it. Which of the two a
mover then builds is `Build.includeSide`.

That rebuild runs per frame for *every* moving sector at once, so two things about it are
load-bearing:

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
It returns false, changing nothing, whenever the sector's batches no longer line up with the
buffers they were built from (a quad appearing or vanishing — an upper step shrinking to nothing as
a door finishes opening); only then does `rebuild` throw the mesh away and build a fresh one. Which
means the fresh-build path stays the definition of correct geometry: the refresh is only ever
allowed to reproduce it exactly.

**Only the walls are rebuilt; the flats are moved.** A moving height changes which wall tiers exist
at all, so `buildMoverWalls` re-emits them from scratch on every refresh. A flat's footprint cannot change
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

Repro for both: literalism.wad MAP18, whose voodoo-doll scripts (docs/specials-forces.md § Voodoo
dolls) keep ~95 sectors moving per tic over 10.6k subsectors and 14.5k linedefs. Before the two,
that map spent the entire frame in `rebuildAround` and the profiler overlay's "Specials" row read in
the hundreds of milliseconds.

### A mover dices vertically only where nothing moves

`addWall` cuts a wall into bands of `WALL_CHUNK_LEN` **both ways**, and the occlusion fade needs the
vertical half as much as the horizontal one: alpha lives at quad corners, so a wall that is one quad
tall has no vertices anywhere near a sightline crossing its middle and no ball of fade can dissolve
it (docs/render-occlusion.md § The fade is a hole, not a wall).

A mover cannot always have that cut. The band count is `ceil(height / WALL_CHUNK_LEN)`, so a moving
height changes *how many quads a wall is* — and the refresh above may only rewrite buffers whose
count held still. So the rule is per quad, and it is about the sectors that **size** it rather than
the sector that owns it: a quad dices vertically when the floors and ceilings it is measured from
cannot move. A one-sided wall reads one sector; every tier of a two-sided side reads two (the lower
spans the two floors, the upper the two ceilings), so one moving neighbour is enough to leave that
whole side undiced. `Build.holdsStill` asks it, against
`MapMeshOptions.movingSectors`.

That set is deliberately **not** `movableSectors`. A sector leaves the static batch either because a
special drives its height *or* because a switch texture on one of its walls has to be swapped, and
only the first stops the dicing — `scanSectors` answers both in one pass
(`game/specials/mapscan.ts`): `moving` is the first half alone, `movable` is it plus the switch
hosts.

The distinction is not a corner case. One switch on one sidedef pulls its whole sector out of the
static batch, and on NUTS.WAD MAP01 that is the 12000-unit arena the player stands in *and* the pen
behind it, whose one-sided walls are 900 units tall — as single quads, the one thing on that map
that could never fade, and with the camera parked behind one at (-505, 6931) looking south the
player was simply gone. Treating a mover that only carries a switch as the static geometry it
actually is costs about a quarter more mover quads on a map with real movers (DOOM2 MAP01 137 →
169, EPIC MAP05 2515 → 3118) and turns NUTS MAP01's 689 into 4065, which is still nothing.

## Closed holes (`mapmesh/flats.ts: closedHoleFill`)

A region of leaves ringed entirely by two-sided drops with no lower texture is a hole the mapper
never meant anyone to look into. Vanilla HOMs it, which is invisible from the floor of a
first-person view; from overhead it is a black pit in the middle of the level, because the sides
draw nothing and the pit's own floor is too far down to be in view — a 64-wide, 128-deep pit needs a
ray steeper than `atan(128/64)` to show any of its bottom, and this camera's steepest is 57.5° below
horizontal. Repro: EPIC.WAD MAP01 sector 88, three 64×64 pits at floor −144 in the −16 grass of
sector 14, which line 585 (a `19` W1 "lower floor to highest" that, the floor being *below* its
neighbours already, snaps it up instead) fills in later.

So every leaf of the region is lidded with the surrounding sector's floor plane, drawn on top of its
real floor. **This follows GZDoom** (`hw_renderhacks.cpp: HandleMissingTextures` →
`DoOneSectorLower` → `AddOtherFloorPlane`), which is what the maps were checked against, and not
vanilla, which has no such hack.

### Finding the region (`floodClosedHole`)

A **seed** is a leaf with a two-sided seg drawing no lower texture — GZDoom's
`AddLowerMissingTexture`. Its plane is the highest floor those bare steps of its adjoin
(`MissingLowerTextures[i].Planez`), and the flood then spreads from it across the leaf graph
(docs/render-bsp.md § Leaf adjacency), giving up on the first sign that the region is a room:

- **a one-sided wall** anywhere in it,
- **a neighbour above the plane**, which is a step the lid could not span,
- **a neighbour at the plane whose step draws a lower texture** — that is ordinary geometry, not a
  hole's rim — or whose floor flat is sky,
- **a leaf standing at the plane's own height**: the lid goes *over* a hole, not level with one.

A neighbour **below** the plane is more of the same hole, whatever its step draws, and the flood
walks into it. That is what lets a hole span sectors at several depths — overboard.wad MAP02's
sunken boat is 16 sectors between −272 and −160, its inner walls fully textured, under a sea at 0.

A hole *inside a pool* is left alone by all of this — the flood declines the moment a 242 is
involved, Boom's idioms being built on missing textures. What it gets instead is the pool's own
surface drawn over it, docs/specials-transfers.md § Deep water's island rule.

**The test is per leaf, and the flood crosses BSP splits the SEGS lump cannot describe.** Scanning a
sector's linedefs instead is the same test with the recursion already done, and it was what this did
until overboard.wad MAP02: it cannot see a hole that spans depths, and a sector with **disconnected
pieces** is judged on all of them at once — the boat's sectors 10 and 105 each also own a walled
closet parked off the map at x≈7800, whose one-sided lines vetoed the boat 6000 units away. Going
per leaf brings back the false positive that drove the per-sector test, and only the leaf graph
holds it off: a leaf left holding a single seg reads as fully enclosed by it unless something
supplies the split its own sector continues through. Repro: DOOM2 MAP01 subsector 22, whose one seg
is line 335 (the barred alcove's floor, 48 units up), which lidded ~23,000 map units² of the
courtyard's grass with the alcove's flat.

### What the pass costs

Every hole on the map is redecided in one pass (`beginHoleFills`), and a mover runs the same
whole-map pass rather than one over its own sector. That is a **deliberate deviation** from GZDoom,
whose hack is per frame over whatever the wall pass just recorded, and it is what a rebuilt-per-tic
mover needs: a region is seeded from the leaf carrying the missing texture, and that leaf need not
be in the sector being rebuilt. Sector 112's leaves are the only ones of the boat's 16 sectors that
touch the sea, and all 16 are movers.

Two things keep that off the frame:

- **The seeds are found once per map** (`holeSeedLeaves`, weak on it). Which segs draw no lower
  texture is fixed geometry; only whether they are a *step* moves, and that is a height compare
  against the current floors.
- **The pass is skipped while no floor has moved**, on a signature over every sector's floor height
  (`floorSignature`). Without it a level of movers redoes the pass per mover per refresh: 16 sectors
  rebuilding through one door's tic cost 4.8 ms of a 5.7 ms frame on overboard.wad MAP02.

Three restrictions are this engine's, and each closes a way the baked lid could go stale or fight
something else:

- **No lid where a Boom 242 is involved**, on the hole or on its rim. A 242 draws its floors at
  borrowed heights and the invisible-platform idiom *wants* its missing textures.
- **No lid resting on a movable rim** from the static batches — its height is what the lid is baked
  at. A mover's own build lifts that (`Build.rebuiltWithNeighbours`): `MoverGeometry` already
  rebuilds a mover whenever a movable neighbour moves.
- **The lid is not gated on where the eye is.** GZDoom re-decides per frame and skips the hack when
  the viewpoint is *below* the fill height; baked geometry cannot. What covers the case is that the
  lid is an ordinary `FlatSurface`, so `FlatFader` dissolves it out of the way of a body underneath
  exactly as it does a solid structure's lid — a player who falls into the pit stays visible.

Nor is GZDoom's fallback path reproduced: where the flood gives up, GZDoom projects the floor
through the gap from the viewpoint (`CreateFloodPoly`, per frame, through a stencil) and this engine
leaves the hole black. From directly above that projection covers nothing, so there is no version of
it to port. What the flood does cover stays narrow on the stock IWADs — 5 leaves of DOOM1's 3,423
(E1M7 sectors 141/142), 6 of DOOM2's 13,253 — and opens up on WADs built around the idiom:
overboard.wad's 32 maps lid 716 leaves between them.

## Deep water (`mapmesh/flats.ts: processFlat`, `mapmesh/walls.ts: ceilingFacing`)

Boom's 242 makes a sector draw at another sector's heights. Vanilla picks one of two views by where
the eye is; this engine draws both at once — an opaque water surface would hide a player who waded
into it, which a camera looking straight down cannot afford. So a water subsector gets **two** fans:
the pool bottom at the real floor height wearing the control sector's flat and light, and a
translucent surface at the control sector's floor height wearing the sector's own. The full rule,
including which vanilla branch each fan comes from and when no surface is drawn at all, is in
docs/specials-transfers.md § Deep water. A control sector *below* the real floor is the other idiom
— an invisible platform, one fan at the fake floor and no surface at all (docs/specials-transfers.md
§ The fake floor).

Mechanically it is one extra `FlatSurface` reusing the same subsector index, so fog of war and
`FlatFader` need no notion of it, and the surface fades like any other raised floor. What it does
need is a rebuild edge: a water sector shares no linedef with its control sector, so `MoverGeometry`
links the two explicitly (`indexWaterDependents`, docs/specials-transfers.md § Deep water).

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
  docs/specials-transfers.md § The fake floor.
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
  (`NearestFilter`, docs/render-occlusion.md has the other half of that
  shader), and the occlusion fade discards whole fragments rather than shading partial coverage, so
  neither can use a coverage mask. Below ratio 2 there is no such supersampling and MSAA is kept —
  **unless the bloom chain is already on, which takes the multisampling over**: docs/lights.md §
  Bloom and the canvas's MSAA.

The clear and the canvas present are not a cost worth thinking about — 0.03 ms of a 14.7 MP frame.

**The CPU side of a frame is priced per draw call**, in three.js's binds, uniform refreshes and
attribute uploads, and only sprites can push that count up — the map is a few dozen batches
whatever the level. NUTS.WAD awake reached ~750 calls and 3.5 ms a frame keyed per lump; the atlas
holds it at a handful (docs/sprites.md § Batching).

**Measure this in a browser, not by reasoning.** In-game, the profiler overlay's `gpu` line is the
first place to look (docs/devmode.md § Profiling overlay): when it dwarfs the `cpu` line beside it,
no row above it is worth touching. For a real experiment — an A/B of two shader variants, a
resolution sweep — docs/lights.md § Profiling has the recipe
(`EXT_disjoint_timer_query_webgl2`, which GPU chromium is pointed at, sizing the drawing buffer like
the player's). Halving a number that turns out to be 4% of the frame is how time gets wasted here.

## The void floor (`voidfloor.ts`)

One plane under the whole level carrying a slow drift of fog, so the space around the map geometry
reads as unlit depth rather than as a hole. Without it a level is a lit cutout floating on
`game.ts`'s scene background, which is what an overhead camera shows most of: walls are drawn
single-sided facing into their sector (docs/render-solids.md), so past the
outermost one there is nothing to draw at all.

- **It sits below every authored sector floor** (`voidFloorHeight`), so no real floor can ever be
  under it and the two never z-fight. The clearance is what a Boom generalized "lower by 32" floor
  needs to stay above it; a floor driven lower than that clips through, which is cosmetic.
- **Its footprint is the map's own extent grown by `VIEW_DISTANCE`** (`voidFloorBounds`), the
  distance at which the scene fog is fully opaque (§ View distance) — so it still reaches past the
  horizon from a camera standing in the far corner, and no further.
- **It takes the scene fog like everything else**, which is what makes it fade into the background
  instead of ending at a visible rim.
- **Its noise tile is generated from a hash local to the file, never `util/random.ts`.** `rndtable`
  is the simulation's own entropy and every draw moves the game's sequence (docs/random.md); a
  decorative texture must not touch it.

**Density, not a surface.** A flat plane wearing a noise texture reads as a cheap floor: round
blobs, uniformly lit, dead still. Three things together stop it doing that, and dropping any one of
them brings the floor back.

- **The lookup is domain-warped** — a second, coarser noise field displaces where the density is
  sampled, which drags round blobs into filaments. This is what does most of the work.
- **The warp field itself drifts**, so the structures turn and curl rather than slide past. That is
  the wobble; sliding a static field looks like scrolling wallpaper.
- **Thin fog is the scene background**, so the plane has no edge and no constant tone anywhere. The
  two ends of that ramp are the dials for how much of this reads at all.

Three drift speeds on three headings, all far under the player's own, so the fog is alive when they
stand still and scenery when they run.

**It is a patch on `MeshBasicMaterial`'s `map_fragment`, not a `ShaderMaterial`**, so the scene fog,
tone mapping and output colour space three applies to every other surface apply here unchanged.
`vMapUv` is already world position in tiles — the plane is an axis-aligned quad whose UVs run 0..1
and whose texture `repeat` scales them — so the effect needs no varying of its own, and one RGBA
tile carries four independent noise fields so the whole thing costs three texture reads.

**Fragments past `fogFar` skip those reads.** The plane reaches `VIEW_DISTANCE` past the map on
every side, so on a big map much of its on-screen area is somewhere three's own `fog_fragment` will
mix to exactly `fogColor` whatever was computed. `smoothstep` is already saturated at that edge, so
the cutoff can leave no seam.

**It shows through unexplored geometry.** Fog of war discards unexplored surfaces outright
(docs/fogofwar.md), so where the level used to read as black it now reads as this plane. That is
the trade the feature makes, and it is why the thick end of the ramp has to stay well under the
darkest real floor — measured on DOOM 1 E1M1, mean brightness 12 against that map's dark start floor
at 23.

**What it costs**, measured on DOOM 2 MAP15 at 5120x2880 on a Radeon integrated GPU, five
interleaved passes against the plane hidden:

| Variant | Frame rate cost |
|---|---|
| The plane with a plain static texture | 8.1% |
| The plane with the drifting fog | 11.2% |

The plane's own fill is nearly all of it and the effect adds about three points. Lighter maps stay
pinned at the frame cap either way. Cutting the shader to two texture reads measured no faster,
which is what says the cost is fill rather than the lookups.

Built per level and dropped with it, because only its height and footprint depend on the map; the
drift advances on the frame clock beside the animated textures (`game.ts`), not on the tic, so it
is smooth rather than stepped at 35 Hz.

### The toggle

Settings / Visuals / Top-down extras switches the fog off, on the `voidFog` setting
(docs/menu.md § Persisted settings). The plane reads the flag in its per-frame `update` rather than
capturing it when the level is built, so switching it reaches the level already running; switched
off it is the plane that stops drawing, not the level that changes, so nothing about what is
revealed or shootable moves with it.

## The player's shadow (`playershadow.ts`)

A soft disc on the ground under the player, placed each frame from the same interpolated position
their billboard uses (`game.ts: posePlayer`).

**It is cast on `Player.groundZ`, not on the player's own feet** — this tic's own `groundFloor`
answer, the height they would stand at here, which is the height they will land at. So the disc
stays on the landing spot while a fall carries the body up off it, and the gap between sprite and
disc is the fall itself.

That height is kept by `Player` rather than asked again per drawn frame: `groundFloor` is
`checkPosition`, and asking it off the render path would run the engine's hottest query several
times per tic for a cosmetic disc. That is the
whole point of the feature: an overhead camera has no other way to say how far down the ground is.

**It darkens with that gap** (`shadowAlpha`): barely there while standing, ramping to its full
strength over a tall DOOM drop and holding. Standing is the common case and wants to be ignorable;
falling is the case that needs to be read at a glance.

Measured against the shadow switched off, in 0–255 levels of the darkest pixel it changes: on
E1M1's dark start floor a standing player moves 7 and a falling one 82; on the bright walkway
outside, a standing player moves 23. A shadow is a multiply toward black, so a near-black floor
inherently shows less of one.

Session-scoped, like the player's billboard: nothing about it depends on which map is loaded. The
screen effects that fade the billboard (the invisibility powerup) scale the disc with it, so the
shadow never outlives the body it belongs to.

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

## Scrolling textures (`scroller.ts`)

`SurfaceScroller` draws every scrolling surface: vanilla's linedef 48 (a front sidedef
scrolling 35 map-units/second forever, no trigger, active from map load — used surprisingly often in
the stock IWADs, 250 linedefs across both games, for waterfalls and lava streams) and Boom's whole
scroller family beside it, walls and floor/ceiling flats alike.

**It computes nothing.** Which surfaces scroll and by how much is simulation state owned by
`game/specials/forces.ts: Forces` (docs/specials-forces.md § Scrollers and conveyors); this class
indexes the affected geometry once and applies the offsets it is handed. The read side is the
structural `ScrollOffsets` interface declared there and satisfied by `Forces`, so the render layer
keeps no import edge into the game layer — the same shape as `SwitchPairLookup`. The geometry it
indexes arrives as one `ScrollableGeometry`, which `BuiltMap` satisfies.

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

The index holds each surface's `uv` buffer itself, resolved once when it is built rather than looked
up per frame through the mesh maps. Safe because the static meshes are built once per level and the
scroller is constructed with them (`game.ts`), so the buffer cannot go stale; a build that replaced
static geometry mid-level would have to rebuild the scroller with it.

**Static-batch geometry only** — unlike `recolorSector`, which also reaches mover meshes
(docs/specials-lights.md § Relighting mover geometry), this indexes the static batch alone, so a
sector that both scrolls and moves keeps its mover mesh unscrolled. In practice this excludes almost
nothing real: a mapper puts a scroller on decorative or conveyor geometry, rarely on a sector that
also has to move.

The accumulated offset is wrapped to `[0, 1)` before being written into the single-precision `uv`
buffer, purely to avoid float32 precision loss over a long session — `RepeatWrapping` already
renders an unwrapped UV outside `[0, 1]` correctly, so the wrap isn't needed for correctness.

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
(`mapmesh/build.ts: BatchSet`) — so animating a name just means repointing its already-built material at a
different bitmap each tic (`MaterialBank.setFrame`), and every quad using it picks up the new frame
for free. `MaterialBank.has` gates this to names some batch actually uses, so an animation with no
on-screen name in the current map costs nothing beyond the initial WAD-order lookup.

**Per-frame offset is counted from the sequence's own start (`i` = 0 at the first name), not
vanilla's absolute internal texture-table index.** Real vanilla computes
`pic = basepic + ((leveltime/speed + i) % numpics)` with `i` ranging over *absolute* texture
indices, so a sequence's apparent starting phase depends on where its first texture happens to land
in vanilla's internal table — a WAD-load-order artifact, not something meaningful to reproduce (this
engine doesn't build that same absolute index space at all). Using the in-sequence offset instead
changes only that arbitrary phase, never the cycle rate or frame order, and both are equally
arbitrary to a player with nothing to compare against.
