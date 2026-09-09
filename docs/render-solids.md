# Solid structures (`solids.ts`)

`src/render/solids.ts`, `src/render/mapmesh/flats.ts`

A pillar, a crate, a lamp post: DOOM draws them as a closed ring of **one-sided** linedefs with no
sector inside at all. Vanilla never has to draw the top of one, because you can never get above it.
This camera always is. Walls are drawn single-sided facing into their sector — the whole reason the
level reads as a dollhouse — so from overhead you look straight into a structure, past the inside of
its near wall, and out through the far one: a black hole where a solid block should be.

`solids.ts: findSolidCaps` reconstructs those rings and `mapmesh/flats.ts: buildSolidCaps` lids them.
Seven rules decide what a lid looks like, and each has a reason:

- **A ring is only a structure if its sector is outside it.** The same shape — a closed ring of
  one-sided lines — is also how a room's outer wall is drawn, and lidding *that* would roof the
  level. The two are told apart by probing a map unit off the front side of the ring's longest edge:
  the front side is the side the sidedef faces, so where that probe lands says which side the sector
  is on.
- **The lid sits at the lowest ceiling the ring borders**, since that is where the shortest of its
  walls stops. Taking the highest floats it: DOOM1 E1M2's ring at (1148, 351) borders a 376-high
  hall, and a lid up there blankets half the level.
- **A face buried under the level beside it does not count** (`buriedFaces`): a wall whose ceiling
  is at or under the floor its neighbour *along the ring* stands on stops there because that level
  begins, not because the structure does. A run of faces sharing a front sector is one wall the
  mapper split and stands in one level, so where **any** of it meets the level beside it, all of it
  is buried — a segment the run's ends shield otherwise sets the lid and sinks it: GoingDown.wad
  MAP08's crate at (-397, 4) is three faces onto the nook it stands in and came out lidded at 64
  instead of the 128 its wooden upper half reaches, and the crate at (-28, -148) left its nook a
  hole for the same reason. Every lid this lifts is one sunk in a level the structure only passes
  through (DOOM2 MAP11's at -104 in a pit 440 below its top, MAP15's at 128 under a 432 tower).
  Without this a crate beside a step-up is lidded at the step's foot and reads as a box open at the
  top — GoingDown.wad MAP08's crate room, where most rings border two floor levels. Where *every*
  face is buried there is nothing left to ask and the plain lowest stands. **A face onto a sector
  with nothing between floor and ceiling is never buried**: a shut door, or the solid filler a
  mapper leaves between rooms, is not a level anything stands on, and its ceiling — being its own
  floor — meets the test against almost any neighbour.
  Counting one lifts the lid off the wall stubs welded into a level's wall network, which is where
  those sectors live: DOOM1 E1M2's 97-line ring runs 1280×1344 units through half the level and is
  held under the floors only by its closed sectors, at -16; without this it is roofed at 48, a slab
  over the rooms. **Each level a buried face stops at gets a cap of its own** below the lid
  (`lidLevels`), over the same footprint: from the tunnel that crate straddles its wall ends at the
  tunnel ceiling, and the lid up on the platform level would leave a hollow band under it. From
  above the lid hides them; from the side the wall does; only from the level they close are they
  seen. It is a rule for crates and next to nothing else.
- **The lid wears the ring's own wall texture**, not a flat. The bordering sector's ceiling flat is
  never drawn by this camera and so is free for the taking — but on the *lid* it is the wrong
  material: it is the room's ceiling, and GoingDown.wad MAP08's crate tops come out `RROCK14` rock,
  E1M1's pillar heads `FLAT20` slabs, where the wall texture reads as the same block continuing.
  **A cap under the lid takes it, though** (`capArt`): that one closes a level the structure only
  passes through, is seen from nowhere but that level, and the flat is exactly the surface vanilla
  draws there — in a crate room, `CRATOP1`/`CRATOP2`, the crate top the mapper already chose. On the
  ring's wall texture instead, crate *sides* lie flat in the gap, logos and all. It falls back to
  the wall texture where that ceiling is `F_SKY1`.
- **That texture is anchored to the structure, not to the world grid** (`capTextureOrigin`): `u` = 0
  at the footprint's west edge, `v` the row the wall shows at the lid's own height — the wall's peg
  (`walls.ts`) run on to `cap.height`, off the side wearing that texture whose own ceiling is
  nearest the lid (`SolidCap.line`) — the wall the lid sits level with. A flat aligns to the map
  origin because vanilla aligns one there; a wall texture stacks whole faces (CRATE3 is two 64×64
  crate faces), so aligning a lid the same way crops it mid-face at whatever phase the structure
  happens to stand on — GoingDown.wad MAP08's crates, half a UAC logo each.

- **A lid at or under the ground the ring stands on is not drawn at all** (`lowestFloor`): the
  structure is buried in the floor around it and closes nothing, and every cap below the lid is
  deeper still. The lid lands there when a face onto a closed sector sets it — the previous rule's
  case, seen from the other end — and the level's own void then shows it as a plate below the
  floors, which is what DOOM1 E1M2's 97-line ring drew at -16. The lids it drops are the welded
  runs, not the crates: a tenth of the lids, a fifth of the lidded area.
- **Its light comes from the walls it closes, not from whichever set its height** (`litFace`,
  `SolidCap.lightSector`). Two steps, both over the ring's faces *level with* the cap — the wall
  tops it actually closes. First the light the longest run of that perimeter carries: which face set
  the height is an artefact of the trace, and one short stretch of a 2,857-unit ring must not decide
  the whole top (DOOM2 MAP15's lid at (2095, -2961) came out 255 off 336 units against 1,059 at
  112). Then a lift to the brightest face within `SHADE_STEP` = 32 of that, two of DOOM's 16-unit
  light steps: a wall dimmer than its fellows around one structure stands in the shade the structure
  itself casts, which vanilla lays on the floor at its foot and never on the block — GoingDown.wad
  MAP08's crate stack, where a 112 strip against the level's 144 left one crate top lit in two
  halves. Past that step the brighter sector is a lit region of its own that the structure merely
  borders, and taking it blows out the top (MAP12's PIPE1 lid: 180 units of a 255 strip).

A ring that encloses **any floor at all** is dropped on top of those seven (`enclosesFloor`). A
building's outer wall is also a ring with its sector outside it, and the void inside that one is
just the wall's thickness, so roofing it would bury every room it contains: a solid block encloses
no subsector, a building encloses its rooms'. The question goes to the *subsectors* and not to the
raw vertexes — a WAD's `VERTEXES` lump carries plenty that belong to no linedef at all, and a
neighbour's corner can sit inside a diagonal block's bounding box with nothing standing there. A
subsector is convex, so the mean of its points is inside it.

A ring larger than **`MAX_CAP_AREA` = 16384 units²** — a 128×128 crate — is dropped as well **unless
every one of its walls ends at the lid** (`flushAtTop`): past that size a ring is the level's own
wall mass, not an object, and its walls end at as many heights as the rooms around it have ceilings,
so the lid at the lowest of them is a plate through the mass and reads as ground the player cannot
reach. DOOM1 E1M1's L-shaped mass beside the hexagon courtyard covers 87,296 units² and roofed a
quarter of the view at 176; E1M2's 33-face network west of (-27, 298) covers 48,000 and took its lid
from one face carrying 11% of its outline, 24 under the corridor walls in front of it. A mass with
no lip at all is a different thing: nothing stands above the lid, so it is the surface that closes
the structure however large it is — E1M6's two computer banks at (-224, -128) and (96, -128), 40,960
units² each with every face at 248. A face onto **sky** counts here like any other: a one-sided wall
is drawn floor to ceiling whatever its flat, so an outdoor ceiling's arbitrary height stands over
the lid as a lip like any other. Being flush is not a threshold on the lip but its absence: only
a fifth of rings end at one height all round, E1M1's four start-room columns measure lips of 48,
128, 48 and 128, and the courtyard mass misses being flush by 8. Counted over top lids
(`under: false`), the rule drops 34% of DOOM1.WAD's, 18% of DOOM2.WAD's, 17% of freedoom2.wad's and
2% of GoingDown.wad's, and no block cap — a block's footprint is its leaves, and none comes near
this.

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

## Revealing a cap

**Fog of war reveals a cap by the leaves around its ring**, not by one subsector: a cap belongs to
no leaf — the ring encloses void — so `SolidCap.probes` offers a point a map unit off *every* face,
each landing in the very leaf that face's own wall quad is revealed with, and a cap triangle is
shown by any of the probes within `CAP_REVEAL_REACH` of it (`revealSubsectors`,
`FlatSurface.revealedBy`). Probing only the longest edge puts the whole lid on the one leaf behind
the structure: GoingDown.wad MAP08's crates stand topless from the aisle and grow tops only once
the player walks around them. The reach is what keeps that local: a welded run of wall stubs, one
ring hundreds of units across, must not light up its far end because one end was seen.

## The pockets in them

**A pocket in a structure is roofed at the lid, and names what the lid wears** (`pocketsOf`,
`flatSpecsOf`, `capArt`). A nook cut into a crate stack is a real sector — GoingDown.wad MAP08's
sector 39, floor 0, ceiling 64, ceiling flat `CRATOP1` — walled by the stack's own faces, which are
buried faces of the rings around it (`SolidCap.buried`), and open to the room on one side. Two
things follow:

- **Its footprint is roofed at the height of the lid around it**, not at its own ceiling, and under
  **that lid's light**, not its own. The lid there is 128 and the nook's ceiling 64, so roofing at
  64 fills the hole 64 units *inside* the stack and it still reads as a hole from above; at the
  lid's height the structure's top face is unbroken — which is what it is: the solid between the
  nook's ceiling and the stack's top is real, and from the room its mouth is framed by the upper
  texture on the two-sided line. The light goes the same way: MAP08's nook is 112 against the
  stack's 144, and that dimness is the shade *under* the crate, which belongs to the nook's floor,
  not to the crate's top. Roofing at the pocket's own light leaves a dark patch cut out of the top
  face. That lid's light is its `lightSector`, so roof and lids read as one plane.
- **Its ceiling flat is what the lids around it wear.** That flat is the one surface of the crate
  this camera can never see and the mapper drew it anyway: `CRATOP1`, a crate top. It beats the
  ring's wall texture, which puts a crate *side* on the top face.

**A solid block's face onto what it stands over is a buried face too** (`findSolidBlocks`,
`SolidBlock.buried`): the side of that two-sided line that is not the block is the nook's. MAP08's
sector 257 is an 8-unit slot under the crate at (548, -100), open to the room, and without this it
is a slit down to the floor at the end of an otherwise closed top. A sector sealed *inside* a block
is capped with the block instead and is not offered as a pocket, or the two planes would coincide.

A sector qualifies when its buried structure walls are at least `POCKET_SHARE` = 0.2 of its whole
perimeter — a plain wall of the level counts against that like an opening does, rather than ruling
the sector out on its own: MAP08's nook at (136, 64) carries 32 units of the room's `SHAWN2` wall
and is a crate nook all the same. It must also be no bigger than
`POCKET_AREA` = 8,192 units² (a nook is small: every real one is under 6,000, and the next
candidates up are rooms from 12,544 to 254,976), and the structure beside it has **material over the
nook**: the lid stands at or above the nook's own ceiling and no more than `POCKET_RISE` = 64 above
it, and it does not reach past the ceiling the nook opens onto — counting only neighbours whose
ceiling is *above* its own, since one at the same height is the same space rather than a lid on it
(MAP08's nooks 36 and 165 open onto each other at 64 and are both roofed at the stack's 128).
The three heights are what tell a slot cut into a crate stack from a recess that merely has a crate
wall on it — DOOM2 MAP12's sector 132, a 15,360-unit room whose crates are lidded 160 *below* its
ceiling, and freedoom2 MAP17's sector 83, 336 under the lid of a tower it leans on. The
neighbour-across-a-two-sided-line form of the same idea — a sector whose ceiling sits at or under a
neighbour's floor — is **not** used: a sector pillar beside a room is enough to satisfy it, and it
flags whole rooms in E1M2. The roof is an ordinary `FlatSurface` facing up, so `FlatFader`
dissolves it for a body walking in underneath. Decided once at load, like the lids (`solidsOf`);
`scripts/inspect-wad.ts` counts them.

## Building the lids

Lids are built once, into the static batches only: a ring never moves, and if the ceiling *around*
one does, its lid keeps the height the level loaded with. A **block's** cap is the exception and is
redrawn per rebuild (§ Blocks built out of a sector).

The whole of it is a setting — *Visuals → Top-down extras → Tops on crates and pillars*
(`getSolidCaps`), on by default. Off, the lids, the block caps and the pocket roofs are all left
out and a structure reads as vanilla draws it. Read **once per level** in `solidsOf`, not per build:
the ring lids are baked into the static batches, so a toggle mid-level would leave a mover rebuild
disagreeing with them. docs/menu.md § Persisted settings.

Each lid is emitted as one `FlatSurface` **per triangle** (`THREE.ShapeUtils.triangulateShape`),
because these rings are frequently concave and `FlatFader` tests a surface's footprint with the
convex-only `segmentMeetsConvexPolygon` (docs/render-occlusion.md § Flats). Triangles keep that
contract, so a structure between the camera and the player dithers away exactly as a raised floor
does — without that, capping them would trade a hole for something worse: a pillar you cannot see
your own player behind.

## Blocks built out of a sector (`findSolidBlocks`)

Not every solid is void. A **roomless** sector — floor at or above its ceiling — is solid too, and
the level around it carries its material on up to its own ceiling in an upper texture:
GoingDown.wad MAP08's sector 1 is a 64×64 crate at floor 64 in a room whose ceiling is 128, drawn
`CRATE3` from 0 to 128 and open at the top from above. `findSolidBlocks` caps those; the art, the
reveal and the fader are the rules above.

Three rules pick a block out of the hundreds of roomless sectors a map carries (591 in DOOM2 alone):

- **It stands above the ground beside it** — its floor above the lowest neighbouring floor. A shut
  door is roomless in exactly the way a crate is, and is level with the floor it sits in.
- **It carries no one-sided wall of its own**, which is the doorway a door sits in. With the rule
  above, E1M2 — the map the welded wall runs make trouble on — has no block at all.
- **Its outside is a single loop** (`oneLoop`). More than one and it runs around something that is
  not part of it: a level's whole wall mass drawn as one roomless sector wraps every room on the map
  (GoingDown.wad MAP26's sector 257, 156 leaves over 2,976 × 2,560 units), and capping that fills
  the walls in. It is `enclosesFloor` asked of a block.

The cap sits at **the lowest ceiling around the block**, for the reason `lidLevels` takes the lowest
of a ring's, and takes its light from the level at that ceiling on `litFace`'s rule (`litOutside`).
**A neighbour whose ceiling is the sky is skipped**: the sky is not material a block's walls carry
up, and the height a mapper gives an outdoor ceiling is arbitrary — Sunder MAP19's courtyard is
10,240, and its wall stubs came out capped 9,216 units over the level. A block whose every
neighbour is sky gets no cap at all.

**A region of ordinary sectors sealed inside a block belongs to it** and is capped with it: the
light well in MAP08's sector 1 — sectors 0, 299 and 300, nested to grade the light, ceiling 64
against the block's floor of 64 — is 48×48 of a 64×64 crate, so capping the 8-unit rim alone leaves
the top a hole. **Enclosed is not sealed**: the blocks around the region must stand *over* it,
their lowest floor at or above **every** ceiling in it, or block and region are the same space and
the block is a wall around a room rather than a lid on one. GoingDown.wad MAP09's sector 55 is an
8-unit ring at height 8 around a 144-high library, and without that clause the whole library joins
the block — which then reads as one loop and gets its wall tops filled in. The test is put to the
whole region and not only to the sectors that touch a block, since one nested inside another
inherits nothing: Sunder MAP07's sector 13 rims a chamber whose ceilings step up to 176, well over
the 128 the ring stands at, and its rim alone would let the chamber through.

One cap per block, drawn by **every leaf of every sector it fills** on that leaf's own polygon
(`flatSpecsOf`), all of them wearing the same flat (`blockFlat`, `SolidBlockCap.flat`), picked in
this order:

1. **What the block stands over** — the ceiling flat of a neighbour whose ceiling is at or below the
   block's floor, by shared perimeter. That is where the mapper drew this block's underside, and it
   is the only drawing of the block there is: MAP08's block at (548, -100) stands over two crate
   nooks and comes out `CRATOP2`, a crate top, where its own ceiling is `RROCK14`, the warehouse
   ceiling that lays rock across a crate. Another roomless sector beside it is more of the same
   material and lends nothing.
2. **The block's own ceiling**, which nothing in the level can look at. It beats a wall texture laid
   flat far more often than not: MAP09's rock pedestals are `RROCK10` like everything around them,
   where the wall texture is `WOOD5` planks stretched over an octagon.
3. Failing both — several roomless sectors in one block disagreeing — the ring's wall texture, as a
   lid does, anchored to the **block's** footprint so its leaves share one texture run. No
   committed WAD reaches it.

A nook beside a block, under its material, is a pocket like one beside a ring (§ The pockets in
them): the block's faces onto it are its `buried` faces, and `pocketsOf` roofs it flush with the
block's cap.

The probes come off the block's *outside*: a leaf inside solid material is never revealed by being
looked at, since `scanSectors` denies the closed-sector waiver to anything a special can drive
(docs/fogofwar.md § Closed sectors), so its own leaf would stay dark.

**A block a mover sinks takes its cap with it.** Unlike a ring lid, a block's cap is emitted from
the flat path rather than baked into the static batches, so a mover-owned sector redraws it on every
rebuild and `blockCapHeight` re-asks the heights the level stands at now (a fifth of GoingDown's
blocks are mover-owned, and every one of Literalism MAP18's pillars sinks during play).

What that asks is **`materialReach` and nothing else**: whether the level around the block still
reaches over it. A block's *floor* is a selection rule, asked once (`solidReach`) — a lift that
drops a crate's floor leaves every bit of the crate above its ceiling standing, and opens a nook
under material that has not moved, which is roofed exactly as a nook in a crate stack is. It is the
block's **ceiling** rising to the level's own that ends the material, which is what a mapper pairs
with the floor drop to sink a pillar for good: Literalism MAP18 puts one `40` per cluster beside the
`38`/`219`. Reading the floor instead takes the lid off GoingDown.wad MAP08's crate the moment its
lift opens the secret inside, a crate with a hole in the top standing in plain sight.
Any one part losing its material drops the **whole** cap: the structure is one object, and half a
lid is worse than none.

Which means a block with a mover-owned sector has to be mover-owned **whole** (`movableBlocks`), and
has to rebuild whole: `scanSectors` unions every sector of such a block into its movable set
(`addBlockMates`, beside the water dependents it widens the same way, and run again by `game.ts`
over a mover a savegame restores that the scan never saw), and `MoverGeometry.indexBlockMates` links
them all so `rebuildAround` reaches every one in its single hop. Without either half, the sectors
left behind keep their share of the lid over the hole the driven one opens — GoingDown.wad MAP08's
crate at (-352, -272) is an 8-unit rim on a
lift around a sealed light well that carries no tag, and its 48×48 middle hung over the pit.

What is still decided once, at load, is which sectors *form* a block and what a pocket is
(`solidsOf`) — a block that is not one when the level loads never becomes one.
