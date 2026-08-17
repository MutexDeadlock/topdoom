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

**The tolerance can never make two subsectors overlap**, which is why it can be this blunt. Node
clipping alone partitions the plane into disjoint cells, and a subsector's polygon is only ever that
cell with pieces cut away — so slack on the seg clip returns territory that belongs to this cell and
that no other subsector can draw. What it can do is leave floor standing past a wall, in space that
would otherwise be a hole: hidden behind the wall from this camera, and a straight improvement where
the hole was in the open. That is what `SEG_CLIP_MAX_TOLERANCE` bounds. The clip against the *node*
partitions stays exact — give that slack and neighbouring cells really would overlap.

Measured over `DOOM1.WAD`, `DOOM2.WAD` and the committed PWADs by sampling each map on a 4-unit grid
(crack = a point inside the map that no subsector polygon covers; overhang = a covered point outside
it), scaling the tolerance this way cuts total crack area by 29% against a flat 4 units — MAP24 by
74%, the `oku2` wedge to nothing — while average overhang goes from 4 units of floor past a wall to
about 5.

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
construct itself. Only the drawn sector moves — `sectorOfSubSector` still answers with the BSP
sector, and `game/world.ts` keeps using it, which is the trick's whole point: a monster standing in
the closet is *under* the drawn floor, exactly as invisible as vanilla makes it. A leaf with even
one ordinary seg is left alone; its real border is authoritative. Across the committed WADs only
BOOMEDIT MAP01 and EPIC MAP03-05 have such leaves at all; the stock IWADs are untouched.

`SubSectorPoly.sector` is the *drawn* sector, so everything reading it follows the remap — including
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
Its row 0 sits at the pegged anchor — the higher floor plus the texture height when `LOWER_UNPEGGED`
is set, the lower ceiling otherwise — plus the sidedef's y-offset, and the quad is that band
*clipped* to the opening (`r_segs.c: R_RenderMaskedSegRange`, which draws the texture once and lets
the seg's clip arrays cut it). So the offset moves the quad itself, and an offset that carries the
texture clear of the opening draws nothing at all: vanilla never tiles a midtexture vertically, and
mappers use exactly that to hide one. Sizing the quad to the opening and letting the offset run off
into the UVs instead makes a wrapped copy appear in the wrong place — BOOMEDIT.WAD MAP01 line 726's
`ICESIGN` (48 tall, y-offset −88, opening −16..128) drew up under the ceiling instead of at −8..40.
The opening a side is clipped to, and the neighbour's ceiling its upper stands on, are the **drawn**
ones: a Boom 242 sector hands out its control sector's ceiling (§ Deep water).

Coordinates: DOOM's `(x, y, z)` becomes three.js `(x, z, -y)`, so the map plane is XZ and Y is up.

Ceilings are never rendered — `buildMapMesh`'s `renderCeilings` option still exists and is always
`false`. From directly above, a rendered ceiling would hide everything under it; this is a permanent
view choice, not a debug convenience. It is also why the ceiling half of Boom's transfers has no
*plane* to show for itself: a 261 transfer only moves sprite light, and a 242 *fake ceiling* draws
no surface — though its height still sizes the walls across from it (§ Deep water).

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

## Deep water (`mapmesh.ts: processFlat`, `ceilingFacing`)

Boom's 242 makes a sector draw at another sector's heights. Vanilla picks one of two views by where
the eye is; this engine draws both at once — an opaque water surface would hide a player who waded
into it, which a camera looking straight down cannot afford. So a water subsector gets **two** fans:
the pool bottom at the real floor height wearing the control sector's flat and light, and a
translucent surface at the control sector's floor height wearing the sector's own. The full rule,
including which vanilla branch each fan comes from and when no surface is drawn at all, is in
docs/specials.md § Deep water.

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

- **The floor is not substituted**, because this engine draws the pool bottom at the real floor
  (above); walls sized to the control sector's floor instead would leave that bottom ringed by a
  hole. The ceiling half has no such conflict — ceilings are never rendered.
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

## View distance (`constants.ts: VIEW_DISTANCE`, `game.ts`)

How far the player can see is the scene's **distance fog**, not a clipping plane: `game.ts` sets
`THREE.Fog` to the same near-black as the scene background, hazing in from
`VIEW_DISTANCE * FOG_START_FRACTION` and fully opaque at `VIEW_DISTANCE` (12000 map units) — both
dials sit in `constants.ts`, the fraction beside the distance it is a fraction of. Geometry
past it is black however lit or fog-of-war-revealed it happens to be, so **`VIEW_DISTANCE` is the
one dial for how much *already-explored* level is on screen** — the fade start follows it as a
fraction rather than being its own number.

Fog range is measured from the camera *eye*, which hangs `TopDownCamera.distance` (480) back from
the player, so the view actually reaches ~480 units less than `VIEW_DISTANCE` out in front.

**The camera's far plane is `VIEW_DISTANCE` itself**, not a number of its own (`camera.ts`): a far
plane below it would clip geometry the fog hasn't finished hiding, and the two were once separately
maintained literals that drifted into being exactly equal by luck. Deriving it is what keeps raising
the dial safe.

**What bounds an *unexplored* view is `game/fogofwar.ts: SIGHT_RADIUS` (5100), not this.** The two
are independent: `SIGHT_RADIUS` is derived from what the camera frames on flat ground
(docs/fogofwar.md § Reveal radius), while `VIEW_DISTANCE` is a feel dial that sits far above it. So
raising `VIEW_DISTANCE` extends the view only through territory already revealed; unexplored
geometry past 5100 stays black either way, and a monster standing there is invisible *and*
unhittable because `ThingLayer` gates on fog alpha.

That gap is deliberate and was measured rather than assumed. `SIGHT_RADIUS` covers the framed ground
only where the player and what they are looking at stand at the same height; any drop pushes the
frustum's ground reach further out than the radius. On real geometry that almost never surfaces,
because walls bound reveal long before the radius does: sampling ~60 vantage points per map across
`DOOM1.WAD`, `DOOM2.WAD`, `SCYTHE.WAD` and `oku2v31.wad` for subsectors that are sight-clear, framed
*and* past 5100 finds **none at all in the stock DOOM, DOOM2 and SCYTHE map sets**. The exceptions
are all wide-open maps with a vantage over a drop — freedoom2 MAP16 (5465 units, a 144-unit drop),
NUTS.WAD MAP01 (7306, 300) and oku2v31 MAP01 (10679, 640). Closing those would mean roughly
quadrupling the sight-test area for three maps out of seventy-six, against the per-frame cost
`docs/fogofwar.md § Reveal radius` already measures for 3000 → 5100.

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
