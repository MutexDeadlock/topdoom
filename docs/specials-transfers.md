# Specials: render transfers

`src/game/specials/transfers.ts`, `src/render/mapmesh/`, `src/game.ts`

The other half of Boom's parameter lines: four numbers that change how a sector or a line is
**drawn** rather than how it behaves. Like the movement ones (docs/specials-forces.md) they are
consumed once at level spawn and `lookupSpecial` returns null for all of them;
`specials/transfers.ts` (`Transfers`) owns them, the way `forces.ts` owns those. What the mesh
builder does with the heights they name is docs/render.md § Deep water.

## Render transfers

| # | Effect |
|---|---|
| 213 | tagged sectors draw their **floor** with the control sector's light level |
| 261 | tagged sectors draw their **ceiling** with the control sector's light level |
| 242 | tagged sectors draw at the control sector's **heights** — Boom's deep water |
| 260 | the line's **midtexture** draws translucent |

All three sector transfers name their model the same way — the control sector is the one behind the
special line's **front sidedef** (`sides[*l->sidenum].sector`, `p_spec.c: P_SpawnSpecials`), and the
targets are every sector carrying the line's tag. 260 is per-line instead: tag 0 affects only the
line it sits on, any other tag affects every line carrying it (`p_setup.c: P_LoadLineDefs2`).

`Transfers` is scanned from the map alone and never ticked — nothing here has runtime state, so
none of it is saved (docs/savegames.md). It is reached through `transfersOf(map)`, memoized against
the `DoomMap` exactly as `world.ts`'s tag indexes are, because the sprite-lighting sites that need
it are scattered across `game/` and the mesh builder needs it before any controller exists.

### Transferred lighting

`R_FakeFlat` resolves a surface's light as
`lightsec === -1 ? sector.light : sectors[lightsec].light`, per **surface**, which is why
`Transfers` exposes `floorLight`/`ceilingLight` rather than one "the sector's light". Three
consumers, each matching a different line of the vanilla renderer:

- **flats** take `floorLight` (`ceilingLight` for a ceiling) — `r_bsp.c`'s `R_Subsector`.
- **walls take the sector's own light, untransferred** — `rw_lightlevel` in `r_segs.c` reads
  `R_FakeFlat(frontsector)->lightlevel`, not the floor/ceiling values. A 213 lava floor lights
  itself and not the walls around it; that asymmetry is vanilla's.
- **sprites take the average of the two**, `(floorlightlevel + ceilinglightlevel) / 2`
  (`r_bsp.c: R_AddSprites`) — `Transfers.spriteLight`. On a map with no transfer lines both halves
  are the sector's own light, so the average is exactly what every sprite read before.

That average is the only visible effect **261** has here: ceilings are never drawn (docs/render.md §
Mesh building), so a transferred ceiling light can only move half the sprite light.

A transferred light is *live* — the control sector may be a strobe. The plumbing for that is
`FlatSurface.lightSector` (docs/render-lighting.md § Sector lighting): every fan records which
sector its colour actually came from, and `MoverGeometry` indexes by that instead of by the sector
the fan belongs to, so `recolorSector(control)` repaints its dependents with no extra bookkeeping
(docs/specials-lights.md § Relighting mover geometry).

### Deep water

A 242 sector is drawn at its control sector's heights. Vanilla picks **one** of two views by where
the eye is: above the surface it draws the floor at the control sector's floor height with the
sector's own flat and light; below it (`viewz <= control.floorheight`) it draws the real floor with
the *control* sector's flat and light, and hides or clips every sprite across the surface
(`r_things.c: R_ProjectSprite`).

**This engine draws both at once, and that is a deliberate deviation.** The camera is always above
the level, so vanilla's opaque surface would simply erase a player who waded in. Instead each
water sector gets two fans: the **pool bottom** at the real floor height with the control sector's
flat and light, and a translucent **surface** at the control sector's floor height with the
sector's own flat and light (`WATER_SURFACE_ALPHA`, a feel dial in `constants.ts` — vanilla has no
opacity to copy). Sprites are never clipped, so you can see yourself walk under water. The surface
is also exempt from occlusion fading, which would otherwise dissolve the fans right over a submerged
player (docs/render-occlusion.md).

**A pool bottom a mover raises out of the water keeps drawing as a pool bottom.** Once its floor
reaches the surface there is no water left over it, so `waterHeight` is null and one fan is drawn at
the real floor — but the flat and light still come from the control sector, not from the sector's
own, which in every deep-water setup is the *water* flat the surface wears. Boom draws that water
flat instead — `R_FakeFlat`'s plain branch keeps `sec`'s own `floorpic` and only moves the height to
`s->floorheight` (`r_bsp.c`) — so this is the same deviation the two fans above are, carried to the
case where the bottom has risen through the surface. `Transfers.poolBottom` is what remembers this:
`markPools` records at load which 242 sectors had water over them, since the live heights no longer
say so. Repro: BOOMEDIT MAP01's stairs in sector 35's pool (sectors 34, 37-40, 42, 43) — the top
step comes to rest exactly at the surface, and drew a patch of FWATER1 beside siblings still showing
their RROCK13. **The load-time half of that has to be resolved before a savegame's sector heights
are applied**, which is why `Game.beginLevel` calls `transfersOf` ahead of `applySectors`
(docs/savegames.md § Apply order); after it, a restored save classifies the risen step as a sector
that was never water.

**A sector walled in by a pool gets that pool's surface drawn over it**, even though it carries none
of the pool's tag. Boom draws water only for a tagged sector, so an untagged one inside a pool is a
square the sheet stops at — visible only from overhead, where this camera looks straight down at it.
`Transfers.markPoolIslands` finds them: no 242 of its own, and every side facing a 242 sector that
borrows the *same* control sector. The adjacency alone is settled at load; the two height tests stay
live in `processFlat` — the island's floor must be `WATER_MIN_DEPTH` under the surface, and its
**ceiling at or below** it, so a sealed chamber whose roof clears the water stays dry inside
whatever surrounds it. The surface fan wears the *pool* sector's flat and light, not the island's,
which is the whole point: the island's own floor keeps drawing underneath it, seen through the
water.

Repro: BOOMEDIT MAP01 sector 121, a closed 4-sided pillar in sector 93's pool, floor and ceiling
both at −80 with the surface at −16. It is a vanilla sky pit (a sky ceiling over a sky ceiling draws
no upper, so a first-person player sees sky through the water); ceilings and sky are never drawn
here at all, so the only choice this camera has is between a void-looking hole and water running
over it. It is the one sector across every committed WAD that qualifies — `inspect-wad`'s transfers
line counts them ("enclosed by a pool").

The surface fan is only built when the control sector's floor is at least `WATER_MIN_DEPTH` above
the sector's own — deep enough for the two planes to be worth drawing separately, and far enough
apart not to z-fight (BOOMEDIT MAP01 sector 405 is **one map unit** deep, and two fans that close
shimmer against each other). Anything shallower keeps vanilla's plain above-water view: one floor
drawn at the surface height wearing the sector's own flat.

**The underwater colormap is dropped, and that is a second deliberate deviation.** A 242 sidedef
names three colormaps and vanilla casts the whole view through the *bottom* one once the eye sinks
below the surface (`R_SetupFrame`). Here the camera stays above the water while the player wades in,
so most of what is on screen is still dry land — turning it all blue reads as a bug rather than as
submersion. `Presenter.viewColormap` applies only the mid and top colormaps and returns no tint below the
surface; the bottom name is never even decoded (docs/hud.md § Screen effects, docs/wad.md § Colormap
lumps).

Boom's other use of 242 is a *fake ceiling*, whose control sector sits at or below the sector's
floor (what its **floor** half then draws is § The fake floor below). Its ceiling is never
rendered, but the height still shows: the walls of every sector
**across a two-sided line from it** are sized against the control sector's ceiling, not the real one
(`r_bsp.c: R_AddLine` fakes the backsector of every seg). That is what makes BOOMEDIT MAP01
sector 111's `SFALL1` waterfall a single 256..32 band instead of an upper stopping at 192 with a
32-unit hole under it; the rule, and the two limits this engine puts on it, are
docs/render.md § Deep water. BOOMEDIT.WAD MAP01 has 13 fake-ceiling setups beside its 22 deep-water
ones.

**The player still falls in.** 242 changes nothing about collision, so a pool drawn as a flat sheet
of water is physically as deep as its real floor — the camera follows the player down, and on
BOOMEDIT's deepest pools that is 200+ map units. Vanilla has the same split (the view sinks while
the surface stays drawn above) and it reads as intended in first person; from overhead the descent
has no visible cause, which is worth knowing before reading it as a camera bug.

Water is render-only in Boom too — `heightsec` never reaches `p_map.c`, so collision, resting
heights and sight are untouched. The two places it *does* reach gameplay are the conveyor and
pusher channels (docs/specials-forces.md § Scrollers and conveyors, docs/specials-forces.md §
Pushers), which treat a submerged thing as being on the floor.

**Moving water works**: a control sector whose floor is dragged by a mover moves the drawn surface.
That costs two small load-time rules — `scanSectors` pulls a water sector in when its
control sector is movable (iterated to a fixpoint, since a water sector can itself control another),
and `MoverGeometry` links control → dependents so `rebuildAround` reaches geometry that shares no
linedef with what moved.

That second link reaches one step further than the dependent itself: **the dependent's movable
neighbours are on the same edge**, because their upper steps are sized against the pool's *drawn*
ceiling, i.e. the control sector's (§ Deep water's fake-ceiling paragraph above). A movable
neighbour owns its own side of that line, so a moving control sector left it drawing the old height
indefinitely — it never moves, the pool never moves, and neither shares a line with the control.
Repro: literalism.wad MAP18, sector 176's quads onto water sector 189 (control 187), covered by
`tests/game/moving-water.test.ts`.

The general rule those edges serve: **`MoverGeometry.rebuildAround` is the only way to invalidate a
mesh, and it takes the sectors that *changed*, not the meshes to rebuild.** Its `rebuild` is private
for that reason. It matters for more than heights — a 242 pool's bottom wears its control sector's
**flat**, so `EV_DoChange` and the arrival copies (`applyArrivalChange`, `applyFloorChange`) travel
the same edge with nothing moving at all. Any site that mutates a sector's geometry and then picks
the meshes to rebuild itself reintroduces the bug above, one texture at a time.

### The fake floor

A control sector **below** the sector's own floor is the other half of what 242 does, and vanilla
does not distinguish the two: `R_FakeFlat`'s plain branch assigns *both* heights from the control
sector unconditionally (`r_bsp.c`, `tempsec->floorheight = s->floorheight`). Used deliberately it is
Boom's **invisible platform** — a raised floor drawn flush with the room around it, which the player
then walks over as if on air. BOOMEDIT MAP01 sector 110 is the demo: a 32-unit platform inside
sector 115, tagged to 115 itself as its control.

**This engine substitutes only where every neighbour can follow the floor down** —
`Transfers.drawnFloor`. A sector qualifies when, across every two-sided line, the neighbour's floor
is at or below the fake floor *and* the neighbour carries no 242 of its own:

- **A neighbour above the fake floor** would need a lower reaching further down than before, and
  the maps that use 242 this way texture for the heights they expect to be drawn, not the real
  ones. BOOMEDIT MAP01 sector 80 is the case — it draws 8 above its control sector but sits beside
  sector 120 at the same height, whose sidedef has no lower at all.
- **A neighbour with its own 242** is not drawn at the floor this scan can read off it, and whether
  it is depends on a decision `markFakeFloors` may not have made yet. Excluding those costs the
  idiom nothing — no map here builds one out of two overlapping 242 sectors — and keeps the test on
  heights the map states outright.

The adjacency half is settled once at load (`markFakeFloors`, `neighboursFollow`) because nothing
moves it; **whether the control sector is still the lower of the two is compared live**, so a lift
that raises a sector past its own fake floor stops substituting rather than drawing its floor above
itself. BOOMEDIT MAP01 sector 110 is a lift, which is what makes that split worth having.

The heights the adjacency walk compares are load-time ones, so a mover that lifts a *neighbour*
above the fake floor afterwards keeps the substitution. No committed WAD has that case, and
re-running the walk per mesh rebuild would put it in `processFlat`'s path.

Where both clauses hold, no step the map has no texture for can open: the fake floor only ever moves
*down*, onto or below a neighbour already there, so every wall between them either shrinks or
disappears. The substitution reaches **both sides** of every line it touches — a sector's own drawn
floor as much as its neighbour's, unlike the ceiling half — but never a midtexture's peg anchor,
only the opening it is clipped to. docs/render.md § Deep water has both asymmetries and what each
one looks like applied wrongly.

Without it, BOOMEDIT MAP01's platform draws at 32 while sector 115 draws at 0 and lines 673-676
carry no lower texture — a 32-unit band of nothing under the platform's rim, which from overhead
reads as a black hole around the grass. Across every WAD committed here the rule fires 8 times:
BOOMEDIT MAP01 sector 110, literalism MAP06 sector 168, MAP09 sector 83 and MAP18 sectors
1826-1830. It declines 59 others, nearly all of them literalism MAP18's colormap transfers — one
control sector at floor -768 carrying `ZRICK10` to 661 sectors whose own floors run from -10000 to
+10000, none of which is describing a floor to draw.

### Translucent midtextures

A 260 line's masked middle texture draws at **66%** — `tran_filter_pct`'s default, the percentage
Boom's own `TRANMAP` is generated at. The alpha rides the same per-vertex channel occlusion fading
and fog-of-war already multiply into (docs/render-occlusion.md), so no material
becomes `transparent` and the batching rule holds.

Two deliberate simplifications:

- **Custom `TRANMAP` lumps are not read.** A 64 KB palette-blend table has no meaning to an RGBA
  renderer; every 260 line gets the same 66%. BOOMEDIT's `HTRANMAP` is the only one in a committed
  WAD.
- Boom overloads the **sidedef's midtexture name** on a 260 line to name that lump, and draws no
  midtexture when the name resolves to one (`p_setup.c: P_LoadSideDefs2`). That rule *is* modelled —
  without it `HTRANMAP` renders as a missing texture.
