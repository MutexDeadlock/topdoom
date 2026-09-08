# Lighting

`src/render/sectorlight.ts`, `src/render/wallshadow.ts`, `src/render/skytint.ts`, the shader patches
in `src/render/textures.ts`

What a sector's light does to a surface and how it falls off with depth (vanilla's own lighting),
and the two cues this engine lays on top of it: the shading a wall casts at its foot and the tint an
outdoor sky lends what stands under it. GLDEFS dynamic lights are docs/lights.md; the mesh the
attributes ride on is docs/render.md.

## Sector lighting (`sectorlight.ts: lightToColor`)

This is vanilla's own lighting, and it is what lights everything by default. GZDoom's GLDEFS
dynamic lights sit *on top* of it — a second, additive term patched into these same materials'
shaders and into the sprite tints below. They are docs/lights.md; nothing in this section changes
for them.


Walls, flats and sprites are all tinted by a sector's light level through this one function, so it
decides how the whole game reads. Two things about it are easy to get wrong, and both were shipped
bugs.

*Which* sector's, though, is not always the surface's own: Boom's 213/261 hand a floor or a ceiling
another sector's light, and each of the three consumers reads a different one — flats take
`floorLight`/`ceilingLight`, walls take the sector's own level untransferred, and sprites take the
average of the two. The rules and their vanilla sources are in
docs/specials-transfers.md § Transferred lighting; what the renderer carries for them is
`FlatSurface.lightSector`, the sector a fan's colour actually came from, which is also what
`MoverGeometry` files its relight index under. On a map with no transfer line all three are the
sector's own light and nothing about this changes.

**The ramp is vanilla's own `COLORMAP`, measured from the lump rather than modelled.** Vanilla never
multiplies a colour by the light level: it picks one of `COLORMAP`'s 32 rows and remaps every
palette index through it, and that ramp is nothing like linear in light level. `COLORMAP_GAIN` is
the mean linear-luminance ratio of each row, measured across the PLAYPAL colours — the same "confirm
it against the real lump" discipline as the sprite and death-frame tables. DOOM.WAD's and
DOOM2.WAD's COLORMAPs are byte-identical and Freedoom's is within 0.003, so one baked table serves
all three; per-colour spread is ~12% of the mean (the ramp desaturates slightly as it darkens),
close enough for a single scalar per row. An earlier hand-tuned curve (`pow(l, 0.85) * 0.9 + 0.1`)
was both far too bright and far too flat.

Vanilla builds the row index as `startmap - scale/DISTMAP` (`r_main.c`), where
`startmap = (15 - lightnum) * 4` and the subtracted term grows as a surface gets *closer* — so in
vanilla the light level really sets how fast a surface falls off with distance, not a flat
brightness, and the term is re-sampled per fragment from each surface's own depth
(§ Distance lighting). `REFERENCE_STEPS` (4, ≈ 320 map units) is one fixed sample of it, kept for
the two places that need a depth and have none: what the light-amplification visor flattens the
level to, and what `litColor` answers when called without one. It is **not** a brightness knob —
`BRIGHTNESS_LIFT` (`constants.ts`) is that.

At the reference the ramp puts a uniform ~0.12 of display brightness between adjacent light
segments across light 112-208, which is 88% of every sector in the stock IWADs. Both ends
necessarily saturate: vanilla spends 4 rows per light segment, so its 16 segments want 64 rows
where only 32 exist.

**Nothing about brightness is stored per vertex.** A map vertex carries its light *segment*
(`aLightSeg`, one byte) and an alpha the faders own; its RGB is a flat 1. Sector light reaches the
screen only through the shader, so the ramp, `BRIGHTNESS_LIFT` and the distance term all live in
exactly one place, and relighting a sector is one byte per vertex rather than a colour and a
segment that have to agree.

**Light is quantized to DOOM's own 16 segments (`light >> 4`)**, so two sectors whose levels differ
by less than 16 are genuinely identical on screen, as in vanilla. Every stock map's sector lights
are multiples of 16 anyway. This is also what makes the fake-contrast offset work out: `addWall`
passes ±16, which after the shift is exactly the ±1 *segment* nudge vanilla applies (`lightnum--`/
`lightnum++`). Vanilla **darkens** east-west walls and **brightens** north-south ones
(`r_segs.c: R_StoreWallRange`) so corners stay legible under flat sector lighting — this engine had
that sign inverted for a long time.

**The returned value is linear-light, not a display value.** Sprite tints (per instance, and
`material.color.setScalar` for non-batched ones) and the map shader's own `liftedGain` are consumed
as-is, and the renderer's `outputColorSpace` (`SRGBColorSpace`) encodes the final fragment to sRGB
on the way out. Returning a display-space value gets it gamma-encoded a second time, which
disproportionately brightens the dark end.

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
`SpecialsController`), and geometry always reflects that immediately via
`MoverGeometry.recolorSector`. A sprite must match: `game/things/defs.ts`'s `PosedThing` has no
`light` field precisely so nothing can cache one — every map thing (items, decorations, corpses,
barrels, monster drops, dormant or actively chasing monsters alike) reads `p.sector?.light` at the
moment it's batched, not at spawn time. The same discipline applies to anything that moves through
space across a frame: `ProjectileLayer.update` re-resolves `world.sectorAt` at the projectile's
*current* position every frame rather than reusing its launch-sector light, and the arch-vile's
warning flame (`SpriteFxLayer`'s `followTargetId` case) re-resolves it every time it re-derives its
position from the target it's tracking. A stationary one-shot effect (blood, puffs, teleport fog,
impact explosions) only needs the single lookup `spawn` already does, since it never moves and its
lifetime is short enough that a mid-flight relight isn't worth chasing.

### Distance lighting (`sectorlight.ts: diminishRows`, `DISTANCE_LIGHT_GLSL`)

Vanilla's own depth cue: a surface darkens as it recedes, one `COLORMAP` row at a time, and a dim
room's far wall is still readable because the ramp is the palette's, not a fade to black. The term
is `DIMINISH_SCALE / depth` rows subtracted from `startmap`, capped at `MAX_DIMINISH_ROWS` —
unrounded, § The term is continuous, the ramp is not:

- **`DIMINISH_SCALE` is 1280 map units**, from `scalelight`'s index `rw_scale >> LIGHTSCALESHIFT`
  with `rw_scale = projection / rw_distance` and `projection` = 160 at 320 wide (`r_segs.c`,
  `r_main.c`), over `DISTMAP` = 2. The cap is `MAXLIGHTSCALE - 1` over `DISTMAP`. Sprites index
  the same table by `spryscale` (`r_things.c`), so they take the same term.
- **Planes use one formula with walls here, a deliberate deviation.** Vanilla's `zlight` indexes
  by `distance >> LIGHTZSHIFT` (16-unit steps) and divides 160 by that, which rounds differently
  from the wall term and has no cap; within the depths this camera frames the two agree to a row,
  and one formula is what lets a floor and the wall standing on it darken together.
- **Depth is view depth** — the distance along the camera's axis, `-mvPosition.z` in the shader
  and `viewDepthAt` on the CPU — which is what vanilla's `rw_distance` and plane `distance` both
  are; not the Euclidean distance to the eye.
- **The term saturates by 1280 units**, so the whole effect lives inside that depth; at the
  default framing (docs/camera.md) the frame's near edge sits ~285 units from the eye (4 rows, the
  reference) and the player 480 (2.7 rows), so a frame spans about one light segment top to bottom.

**The geometry does the whole ramp per fragment.** Every vertex carries `aLightSeg` (`Batch.segs`,
a plain byte) and nothing else about its light; the fragment turns that into `startmap`, subtracts
the rows its own depth earns, and multiplies `diffuseColor` by the lifted gain it lands on. The
wall shade and the sky tint still scale the vertex colour on the way through, so they compose with
it untouched.

Relighting a sector is therefore `mapmesh/build.ts: relightRange` writing **one byte per vertex** —
`applyFlatRefresh` and `MoverGeometry.recolorSector` both go through it, and `refreshMoverMesh`
rebuilds the array from its `Batch`. There is no second value to keep in step: the class of bug
where a surface is relit but keeps sampling the row its sector used to have cannot be written.
A geometry without the attribute reads segment 0, the darkest. The dynamic-light sum is added
*after* the multiply and never diminishes: vanilla has no such light to diminish.

#### The term is continuous, the ramp is not

**`floor` is left off the row count — a deliberate deviation.** Vanilla's term is a table index, so
it steps: `floor(1280 / depth)`. Depth is measured along the camera axis, so each of those steps is
a line of constant depth straight across the view, and from overhead it lands mid-floor and reads as
a sector boundary rather than as a depth cue. First person it is masked by perspective, distance and
walls; here it isn't.

So `diminishRows` and the shader keep the quotient whole, and `colormapGain` / `liftedGain` read
**between** two `COLORMAP` rows, lerping. An integer row is exactly the lump's own entry, so nothing
else moves: the ramp, the segments, `startmap`, the cap and the reference sample are unchanged, and
the per-sector quantization to 16 light segments (§ Sector lighting) stays vanilla-exact — only
*depth* became smooth. `BRIGHTNESS_LIFT` is affine in the gain, so lifting after the lerp and
lerping lifted values are the same number.

**Sprites take it on the CPU, one depth per sprite**, as vanilla takes one colormap per sprite:
`litColor(light, contrast, depth)` samples the ramp at the depth `viewDepthAt` gives the
sprite's own position, for the thing batches (`things.ts`), the effects (`spritefx.ts`) and the
player's actor (`sprites.ts`). `beginViewDepth` opens the frame in `game.ts`'s `draw` on the line
after the camera is posed — module-level begin-then-read, the `beginWallShade`/`wallShadeAt`
idiom, so no signature carries a value every sprite in the frame shares. It reads the camera's
`matrixWorldInverse`, which `applyToCamera`'s own `updateMatrixWorld` has just refreshed, so
nothing is inverted twice. A fullbright frame skips the depth entirely: its `startmap` is row 0,
which the term cannot move, as in vanilla.

#### It has no setting

Unlike the contact shading, the sky tint and the void fog, this is not switchable: it is vanilla's
own lighting rather than an effect laid on top, and with no brightness in the vertex buffer there
is nothing left to fall back to — switching it off would mean choosing a fixed depth to light the
whole level at, which is a look, not an absence. The visor does exactly that, and `REFERENCE_STEPS`
is the depth it picks. Measured at 1920×1080 on E1M1 and DOOM2 MAP01, the term costs
**0.2–0.3 ms of GPU** on a 1.5–1.8 ms frame.

One known deviation sits here: **a dynamic light does not diminish**, being added after the
multiply. Vanilla has none to diminish, so there is no vanilla answer to match.

#### The light-amplification visor flattens it

While the visor is held the term contributes nothing and every surface draws at its baked
reference sample, as vanilla does: `P_PlayerThink` sets `fixedcolormap` to row 1 ("almost full
bright") for `pw_infrared`, `R_SetupFrame` then fills every `scalelightfixed` entry with that one
row, and the plane and sprite draws test `fixedcolormap` themselves — so depth selects nothing
anywhere (`p_user.c`, `r_main.c`, `r_plane.c`, `r_things.c`).

- **`uDiminish` picks between the two samples rather than driving the rows to zero.** The fragment
  is one `mix` from the reference gain to the depth's own; driving `rows` to 0 would instead draw
  everything at `startmap`, *darker* than an undiminished surface, which is not what flattening
  means.
- **`litColor` reads the same flag** for the sprites the CPU lights, so a thing and the floor
  under it flatten together.
- **It is driven per frame from `ui/hud/screeneffects.ts`**, off the same `hasPower` answer the
  exposure lift reads, so the visor's two halves cannot disagree about whether it is up. That also
  means it needs no teardown of its own on level change, and `reset` clears it anyway because the
  renderer outlives the `Game`.

Vanilla's visor also ignores the *sector's* light, drawing row 1 everywhere; this engine keeps the
`toneMappingExposure` lift as the stand-in for that half (docs/hud.md § Screen effects), so a dark
room under the visor stays darker than a lit one.

## Wall contact shading (`wallshadow.ts`)

Floors darken toward the walls standing on them: an occlusion amount per flat vertex, baked at mesh
build time into the `aWallShade` attribute and scaled in the vertex shader by one live uniform
(`textures.ts` patches `color_vertex`). **This engine's own, not vanilla's** — vanilla lighting is
flat within a sector, which from overhead reads as a cutout rather than as a room.

- **The top of a solid structure takes none of it** (`FlatSpec.wallShaded`): a lid and a pocket's
  roof are not a floor meeting a wall but the structure's own top, and the lines around them are
  its sides, which `risesAbove` counts as rising past every height because they are one-sided. Left
  on, every lid darkens toward its own edge and a pocket's roof carries a band across the top face
  it was just made flush with (docs/render-solids.md).
- **A fan is shaded from its own sector's lines**, which is where a wall bounding it can stand — a
  pillar's ring included, its one-sided lines facing that sector. Filtered once per leaf against the
  leaf's bounding box grown by `RADIUS`, so the per-vertex scan is a handful of segments.
- **Only where a wall actually rises on this floor**: void across the line, a step of `MAX_STEP_UP`
  (`game/world.ts`, vanilla's `MAXSTEPSIZE` — what the player walks up) or more, or a ceiling
  across it already down at this floor. A ledge dropping *away* casts nothing, which is what keeps
  E1M1's outdoor walkway unshaded; nor does a neighbour whose ceiling merely hangs lower, since that
  wall never reaches the floor.
- **`RADIUS` cannot go below the flat dicing.** The amount lives at flat vertices, which sit on the
  `FLAT_GRID_LEN` grid (~90 units) plus the leaf outline, so under that spacing only the outline
  vertices ever carry any and the ramp is whatever the dicing happens to be. Same relationship as
  `FADE_RADIUS` to `WALL_CHUNK_LEN` (docs/render-occlusion.md § The fade is a hole, not a wall).
- **Walls and ceilings carry none.** 0 is the attribute's default and means unshaded, so geometry
  built without it — anything but the map's own batches — is simply unaffected.

Two leaves either side of a BSP split agree at their shared vertices by construction: the bounding
box is grown by the same radius both times, so a wall in reach of the vertex is in both candidate
sets, and both compute the same distance.

**A mover keeps the shading it was built with until its next full rebuild.** `refreshMoverMesh`
rewrites positions, UVs and colours and never `aWallShade` — the same rule as `aLightCell`
(docs/render.md § Mover meshes), but weaker: a footprint really is fixed, while a lift's shading is
only right at the height it was last built at. Rebaking per tic would mean re-dicing every flat,
which is the cost docs/render.md § Mover meshes exists to avoid. What saves it is that the case that
would show — a lift arriving flush with the floor it serves, still wearing the band its shaft cast
on it — is exactly a rebuild: the lower step's quad stops existing there, the refresh refuses on the
changed batch, and the fresh build bakes the new height. Stale shading is a travelling lift's, not a
parked one's.

Costs a whole-map build about a fifth of its time — GoingDown MAP01's 2232 leaves go 13.6 to
17.4 ms, MAP03 11.2 to 12.3 — and per frame one multiply in the vertex shader over a buffer of
4 bytes per vertex (0.37 MB for that map's 92k).

### Turning it off

Settings / Visuals / Lighting switches it off, labelled *Ambient occlusion* — what a graphics
menu calls this — on the `wallShade` setting (docs/menu.md § Persisted settings). The strength
is a uniform every map material shares, so the switch reaches the level already running without
rebuilding anything; off is that uniform at zero, and the baked amount stays in the buffers.

## Outdoor sky tint (`skytint.ts`)

Every surface facing a sector roofed with `F_SKY1` is tinted toward that level's own sky: the
camera never shows the sky, so without it a courtyard and a corridor are the same picture. Marked
per vertex at build time (`aSkyLit`, 1 outdoors) and coloured by one live uniform, the same split
as § Wall contact shading; a wall takes the marking of the room it *faces into*, which is the
sector its light came from, so the two sides of a courtyard wall differ.

**This engine's own**, and the one place it invents rather than measures: vanilla has no such tint,
and the sky texture is not drawn here at all.

Which sky a map stands under is the set's MAPINFO where it names one, and vanilla's own rule off the
map's name otherwise (docs/wad.md § The sky texture). What that texture lends is `skyTintOf`, in
three steps:

- **The average of its pixels, at luminance 1** — a colour shift, never a brightness one, so an
  outdoor floor never reads as a brighter indoor one. Both blends below preserve that, luminance
  being linear in the channels.
- **A sky with no colour of its own lends a cool daylight instead** (`COLOURLESS_SKY`), blended in
  by how little chroma it has. DOOM's `SKY1` averages to flat grey — 143/143/142 over the lump — so
  taking its hue faithfully tints E1's courtyards by nothing at all, which is not a cue.
- **`STRENGTH` of the way from neutral, clamped to `LIMIT`.** The clamp binds on the hell skies:
  DOOM II's `SKY3` averages 2.6 times as much red as green, and unclamped it paints every outdoor
  surface of MAP21-32 crimson.

Resolved once per level, since the sky cannot change within one; a set with no such texture leaves
the uniform neutral.

**Sprites take the same tint**, so a monster standing in a courtyard belongs to it rather than
reading as cut out of an indoor room. A sprite's colour is recomputed every frame anyway, so where a
surface is marked at build time a sprite simply asks `skyLitSector` for the sector it stands in —
`ThingLayer`'s things and drops, `SpriteFxLayer`'s projectiles and one-shot effects (off the leaf
their light was offered at), and the player's own billboard. Two things it deliberately does not
reach: a **fullbright frame**, which lights itself and takes no sector light to tint, and a
**dynamic light's** contribution, which keeps its own colour — the tint lands on the sector's own
light, exactly as it does on a surface.

### Turning the tint off

Settings / Visuals / Lighting, labelled *Outdoor sky tint*, on the `skyTint` setting
(docs/menu.md § Persisted settings). The colour is a uniform every map material shares, so the
switch reaches a level already running; off is that uniform at white.
