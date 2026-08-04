# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A top-down DOOM built on the original IWADs. The camera hangs above the player, tilted
slightly off vertical. Level geometry, textures and flats are parsed straight out of
`DOOM.WAD` / `DOOM2.WAD` (or any PWAD); the game logic (movement, collision, camera) is
entirely new — none of vanilla DOOM's game code is ported.

## Commands

```bash
npm install
npm run dev         # vite dev server, http://localhost:5173
npm run typecheck   # tsc --noEmit
npm run build       # tsc --noEmit && vite build
npm run preview     # serve the production build
```

There is no test suite (`npm test` is an unset placeholder). Validate changes with
`npm run typecheck` and, for anything touching WAD parsing/geometry/collision, the headless
inspector below.

WADs are not part of the repo. Place game WADs in `public/wads/iwad/` and add-ons in
`public/wads/pwad/` (both gitignored except `.gitkeep`) — see "Start menu" below for why the
folder matters.

### Headless WAD inspection

```bash
node scripts/inspect-wad.ts public/wads/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/wads/iwad/DOOM2.WAD MAP05 public/wads/pwad/SCYTHE.WAD
```

Runs directly via Node's native TS support (no flag needed on Node 22+) — no browser
required. Reports lump/map counts, which file a map's lumps came from, any textures the map
references but the WAD set lacks, how many subsector polygons came out degenerate, and
whether the player start is walkable. This is the fastest way to sanity-check a change to the
WAD parser, texture merging, or BSP reconstruction, and the way to reproduce a bug against a
specific real-world WAD without spinning up a browser. For collision/movement logic bugs,
prefer writing a small throwaway synthetic-map script (see the pattern used for the
edge-falling fix: a hand-built `DoomMap` with a couple of sectors) over probing a real map,
where nearby unrelated geometry makes results hard to interpret.

## Toolchain constraints

- Node's native TS stripping (used by both `scripts/inspect-wad.ts` and any dev tooling
  invoked directly via `node`) does **not** support constructor parameter-property shorthand
  (`constructor(private x: T)`). Declare fields explicitly and assign in the constructor body
  everywhere in `src/`, since anything there may be imported by a script run this way.
- All relative imports need explicit `.ts` extensions (`allowImportingTsExtensions` +
  Node ESM resolution) — `from './wad/reader'` will fail to resolve, `from './wad/reader.ts'`
  works.
- `tsconfig.json` has `noUnusedLocals`/`noUnusedParameters` on; `npm run typecheck` is the
  cheapest way to catch this before running anything.
- The pinned `tsc` has a control-flow narrowing quirk: reading a nullable `this`-field directly
  after several intervening method calls (any of which may reassign it) can stay typed as its
  last-seen literal instead of widening back to the declared union — surfaced by
  `SpecialsController.lastTeleport` in `game/specials.ts`. Routing the read through a trivial
  getter (`consumeLastTeleport`) works around it; reach for that pattern rather than fighting the
  checker if the same shape of bug shows up elsewhere.

## Documentation maintenance

- After finishing a task in topdoom that changes behavior, architecture, controls, or anything
else **CLAUDE.md/README.md** document, check whether those docs need updating and update them —
don't wait for the user to separately ask "check and update documentation."
- **README.md**: Don't let it get as bloated as CLAUDE.md. This should only contain a project overview, setup steps, and instructions for starting and playing the game.

## Architecture

```
src/wad/       WAD files, merged lump directory, map lumps, graphics + sprite decoding
src/render/    BSP polygon reconstruction, mesh building, materials, occlusion fading,
               sprite billboards + their instanced batching, shot tracers, camera
src/game/      spatial queries, collision, player controller, input, thing→sprite table,
               thing/monster world state (AI, pickups, damage), fog of war, inventory/pickups,
               weapons and firing, damage/death
src/ui/        start menu, HUD, DEVMODE profiling overlay
src/util/      small helpers shared across layers (2D geometry, damped-lerp smoothing,
               per-frame profiling)
src/constants.ts   Genuinely cross-cutting values only (VERSION, DEVMODE) — see below
src/types.ts       Structural position types shared across layers (Pos2/Pos3/Placement) — see below
plugins/       Vite plugin publishing the public/wads/{iwad,pwad} manifest
scripts/       headless WAD inspection (node scripts/inspect-wad.ts)
```

### WAD loading and merging (`src/wad/`)

`WadFile` (`wad.ts`) parses one physical file (header + lump directory). `Wad` concatenates
several `WadFile`s into the single merged lump directory the rest of the engine reads, with
**later files winning on name collisions** — that one rule gives PWAD overrides for free (a
replaced `MAP01` marker resolves to the add-on, and its map lumps follow it contiguously).

Two deliberate deviations from vanilla lump-lookup semantics, both load-bearing:

- **Marker ranges** (`F_START`/`F_END` for flats) nest and every file may open its own, so
  `Wad.markedRange` counts depth instead of spanning first-marker-to-last-marker.
- **Texture definitions are merged by name across all files' `TEXTURE1`/`TEXTURE2`**
  (`graphics.ts: readAllTextures`), not resolved by last-lump-wins like vanilla. Vanilla
  treats a PWAD's `TEXTURE1` as a full replacement of the IWAD's, which breaks IWAD/PWAD
  pairings the PWAD wasn't built for. Patch indices inside each texture are still per-file,
  resolved through that file's own `PNAMES` at merge time.

**Lump names end at the first NUL** (`reader.ts: name8`) — editors don't always zero the
remaining bytes of the 8-byte name field, so trailing bytes can be leftovers from a previous
edit. Reading past the first NUL silently corrupts names (e.g. turns `"-"` into `"-GRAY7"`)
and breaks texture resolution for real PWADs; this was found via testing against community
PWADs, not synthetic data, so don't assume synthetic WADs will catch a regression here.

### BSP polygon reconstruction (`src/render/bsp.ts`)

`SEGS` only stores edges that lie on real linedefs — the edges created by BSP splits aren't
in the WAD. `buildSubSectorPolys` rebuilds each subsector by taking a quad covering the whole
map and clipping it (Sutherland-Hodgman) against every partition line on the path from the
BSP root down to that leaf, then against the subsector's own segs. The result is convex, so a
triangle fan is enough. Traversal is iterative (stack-based), not recursive — some maps have
deep BSP trees. `sectorOfSubSector` resolves a subsector's sector via its first seg → linedef
→ sidedef.

### Mesh building (`src/render/mapmesh.ts`)

Walls are built per linedef from sidedefs: one-sided lines get their middle texture over the
full sector height; two-sided lines get upper/lower steps plus an optional masked middle,
following DOOM's pegging rules (`UPPER_UNPEGGED`/`LOWER_UNPEGGED`) for vertical alignment.
Walls are drawn single-sided (facing DOOM's defined front), which is what culls walls between
the camera and the player and produces the open dollhouse look — no extra logic needed.
`F_SKY1` flats are skipped. Coordinates: DOOM's `(x, y, z)` becomes three.js `(x, z, -y)`, so
the map plane is XZ and Y is up.

### Sector lighting (`src/render/mapmesh.ts: lightToColor`)

Walls, flats and sprites are all tinted by their sector's light level through this one
function, so it decides how the whole game reads. Two things about it are easy to get wrong,
and both were shipped bugs.

**The ramp is vanilla's own `COLORMAP`, measured from the lump rather than modelled.** Vanilla
never multiplies a colour by the light level: it picks one of `COLORMAP`'s 32 rows and remaps
every palette index through it, and that ramp is nothing like linear in light level.
`COLORMAP_GAIN` is the mean linear-luminance ratio of each row, measured across the PLAYPAL
colours — the same "confirm it against the real lump" discipline as the sprite and death-frame
tables. DOOM.WAD's and DOOM2.WAD's COLORMAPs are byte-identical and Freedoom's is within 0.003,
so one baked table serves all three; per-colour spread is ~12% of the mean (the ramp
desaturates slightly as it darkens), which is close enough for a single scalar per row.
An earlier hand-tuned curve (`pow(l, 0.85) * 0.9 + 0.1`) was both far too bright and far too
flat — it put only ~0.05 of display brightness between adjacent light levels where vanilla puts
~0.12, so a room's step shading was barely readable, and it rendered DOOM2 MAP01's light-112
start room at 0.55 display brightness instead of 0.15.

Vanilla builds the row index as `startmap - scale/DISTMAP` (`r_main.c`), where
`startmap = (15 - lightnum) * 4` and the subtracted term grows as a surface gets *closer* — so
in vanilla the light level really sets how fast a surface falls off with distance, not a flat
brightness. This engine has no distance lighting (the camera hangs at a near-constant distance
from everything it draws), so the ramp is sampled once at a fixed reference distance:
`REFERENCE_STEPS` is that subtracted term, and it is **the knob to turn if the game reads too
dark or too bright.** 4 (≈ a 300-unit viewing distance) is chosen because it puts a uniform
~0.12 of display brightness between adjacent light segments across light 112-208, which is 88%
of every sector in the stock IWADs. Both ends necessarily saturate — vanilla spends 4 rows per
light segment, so its 16 segments want 64 rows where only 32 exist, and light ≤ 96 (2.8% of
stock sectors) bottoms out together as do 224/240 (9%). That is vanilla's ramp rather than a
shortcut; it just never shows up in vanilla, where distance fills the range back in.

**Light is quantized to DOOM's own 16 segments (`light >> 4`)**, so two sectors whose levels
differ by less than 16 are genuinely identical on screen — as they are in vanilla. Every stock
map's sector lights are multiples of 16 anyway. This is also what makes the fake-contrast offset
work out: `addWall` passes ±16, which after the shift is exactly the ±1 *segment* nudge vanilla
applies (`lightnum--`/`lightnum++`). Vanilla **darkens** east-west walls and **brightens**
north-south ones (`r_segs.c: R_StoreWallRange`) so corners stay legible under flat sector
lighting — this engine had that sign inverted for a long time.

**The returned value is linear-light, not a display value.** Vertex colours (and
`material.color.setScalar`, for the non-batched sprites) are consumed as-is by the shader, and
the renderer's `outputColorSpace` (`SRGBColorSpace`, `game.ts`) encodes the final fragment to
sRGB on the way out. Returning a display-space value gets it gamma-encoded a second time, which
disproportionately brightens the dark end — the other half of why dark sectors used to glow.

**A vanilla-exact ramp is still too dark for this camera, so there's a fixed brightness lift on
top of it, `BRIGHTNESS_LIFT` in `constants.ts`.** Vanilla's ramp assumes a first-person view a
few dozen units from what it's lighting, broken up by nearby bright surfaces and real depth
cues; this camera looks down on an entire dim room at once with neither, so a faithfully dark
room reads as murkier here than vanilla ever intended it to. `applyBrightnessLift(linear, lift)`
(`mapmesh.ts`) pushes a value toward 1 by a fraction `lift` of its remaining headroom
`(1 - linear)`, so black brightens by the full amount and already-bright surfaces barely move —
brighten the dark end, taper off toward the bright end, not a flat multiply. `lightToColor`
itself is left untouched by this (still pure, still exactly vanilla) — `litColor` is
`lightToColor` plus `BRIGHTNESS_LIFT`, and is what every real draw call (walls, flats, sprites)
uses. `BRIGHTNESS_LIFT` was found by feel via a temporary in-HUD slider (not vanilla-derived,
same honesty as `player.ts`'s `GRAVITY`) and lives in `constants.ts` on its own — not because it
meets that file's own >2-file bar, but because it's the one number in this whole scheme meant to
be hand-retuned later, and `constants.ts` is where this project already keeps that kind of knob
easy to find.

### Wall occlusion fading (`src/render/occlusion.ts`, `src/render/textures.ts`)

Single-sided back-face culling (above) only removes walls facing away from the camera; it
does nothing about a wall that legitimately faces the camera but sits directly on the
camera→player sightline (e.g. a pillar in front of the player). `WallFader` tests every wall
quad's 2D footprint against that sightline each frame and fades the ones that cross it, rather
than the coarser fix of drawing the player on top of everything, which would also show it
through walls that genuinely separate it from the camera.

`WallFader.update`/`FlatFader.update` take a *list* of sightline targets (`FadeTarget[]`), not
just the player — `game.ts` passes the player plus every currently-**awake** monster
(`ThingLayer.awakeMonsters`, the same `alerted` flag `awakeMonsterCount` already exposed for the
debug HUD) within `MONSTER_FADE_RANGE` (`game.ts`, a plain 2D distance cap, tuned by feel to
roughly a room/corridor's length), and a quad fades if it sits on any one of those sightlines.
Both gates matter: a sleeping monster isn't being tracked yet, so there's no reason for a wall to
reveal it early; and without the range cap, an alerted monster dead-reckoning toward the player
from clear across the level would fade every wall along that long a straight line, none of which
have anything to do with what the player can currently see happening. The range cap is
deliberately a plain distance, not a `hasLineOfSight` check — an earlier version required
unobstructed line of sight instead, which made the fade a no-op for exactly the case it exists
for (a wall genuinely hiding a nearby monster also means `hasLineOfSight` is false, so the
monster never became a fade target and the wall in front of it stopped fading, concretely
breaking a zombieman approaching down a corridor one wall away).
`SpecialsController.updateFading` (mover geometry — doors, lifts) takes the same target list,
since it reuses the identical `WallFader`/`FlatFader` machinery for its own meshes.

`WallFader.update` also takes an `openingOf` callback (`World.openingOf`, threaded through so this
class needs no `World` reference of its own) and skips fading any quad whose own `[botH, topH]`
sits *inside* its line's vertical opening — a masked middle texture (grate, fence, barred window)
is built (`mapmesh.ts: addTwoSidedSide`) to span exactly that opening, so a quad living inside it
is the passable gap itself: a shot (and a look) already passes straight through it, same as
`World.blocksSight`/`blocksShot` already treat it elsewhere, so fading it too has nothing left to
usefully reveal. This has to be a **per-quad** check, not a per-*line* one — an earlier version
gated on `World.blocksSight(line)` for the whole line, which wrongly also suppressed fading for
that same line's upper/lower step quads (they sit *outside* the opening — the riser exposed where
the neighbouring sector's floor/ceiling falls short — and are genuinely solid regardless of
whether the line has an opening elsewhere), breaking the ordinary case of an approaching monster
hidden behind a two-sided step in a corridor. DOOM2 MAP01's east imp closet (sector 38) is the
concrete case the quad-level version fixes — its fence's masked-middle quad used to fade to
near-invisible the moment the imp inside woke up, reading as the closet wall vanishing rather than
"you can see the imp through the bars." `FlatFader` has no equivalent gate — floors have no
comparable "visually-solid-but-actually-passable" case.

**`awakeMonsters` only returns monsters fog of war is actually drawing** (`p.actor.mesh.visible`,
which `ThingLayer.update` sets from `fogAlphaOf` earlier in the same frame). A monster in a
subsector the player has never had sight of isn't rendered at all, so fading the wall in front of
it reveals an empty dark room and nothing else — concretely, a MAP01 secret compartment's wall
dithered away whenever the imps sealed inside woke up, with the imps themselves still invisible.
This is also why `WallFader.update` needs no "only fade if this is the *sole* wall in the way"
rule: whether fading actually reveals anything is settled here, upstream. A blocker-counting
version of `update` was written first for this same symptom and fixed nothing — that wall had
only one blocker; its monsters simply weren't being drawn.

The fade is a **dithered discard**, not real alpha blending: wall quads are batched one mesh
per texture across the whole map, three.js sorts transparent objects back-to-front per mesh,
and with a mesh spanning the entire level that order is meaningless — plus both meshes still
write depth by default, so whichever draws first can win the depth test and blank out the
other. `MaterialBank` instead injects a fragment-shader snippet (`onBeforeCompile`) that
discards a per-pixel fraction of fragments using interleaved-gradient-noise dithering, keyed
off a per-vertex alpha `WallFader` writes into the (otherwise unused) 4th color channel. That
keeps walls in the ordinary opaque, depth-tested/written pass — no batching or sort-order
concerns, just fewer pixels drawn. `holes` textures (masked middles) already alpha-test on the
*combined* texture × vertex alpha, so a faded grate discards outright instead of dithering.

Fade amount is exponentially smoothed (`FADE_SPEED`) so walls don't pop in/out, but a pure
exponential lerp never actually reaches its target — `WallFader.update` snaps once the
remaining gap drops below a threshold, otherwise a wall settles a hair short of fully opaque
forever and shows a permanent faint speckle (the dither test is a strict `<`).

### Camera orbit and camera-relative movement (`src/render/camera.ts`, `src/game/input.ts`, `src/game/player.ts`)

`TopDownCamera.yawDeg` lets the camera orbit around the followed point on right-mouse drag
(`Input.consumeDragYaw`, accumulated via `pointermove` with `setPointerCapture` so the drag
survives leaving the canvas mid-move) or by pressing `Q`/`E` (`game.ts`'s `KEY_YAW_STEP`, a
45° step per press, signed to match the same rotation direction as dragging left/right
respectively); tilt and distance are unaffected, so the camera always stays the same amount
off vertical. `viewerAngleDeg` (`yawDeg - 90`) is the DOOM-space bearing from the followed
point to the camera, and is what sprite rendering (above) and player movement both key off —
at the default `yawDeg = 0` it's `-90`, matching the old fixed south-facing camera exactly,
so nothing downstream needed a special case for "not yet orbited."

A `stepYaw` call (Q/E) queues its step as a `targetYawDeg` for `TopDownCamera.update` to
animate `yawDeg` towards (`YAW_STEP_SMOOTH_RATE`) rather than jumping instantly — fast enough
to feel snappy, but smooth rather than a hard cut. Plain assignment (`camera.yawDeg = ...`,
used for the instant reorient on spawn/teleport, and by right-drag) still jumps immediately:
the `yawDeg` setter keeps `targetYawDeg` in lockstep so nothing left over from a prior Q/E
animates after an instant set. `game.ts`'s drag-handling line only assigns `camera.yawDeg` when
`Input.consumeDragYaw()` is actually nonzero — calling the setter unconditionally every frame,
even as a no-op `-= 0`, would snap `targetYawDeg` back to the current (still mid-animation)
value and cancel a Q/E step after just one frame of smoothing, which is exactly the bug this
guard fixes.

Holding Q/E (rather than tapping) auto-repeats the same 45° `stepYaw` every
`KEY_YAW_REPEAT_INTERVAL` — `game.ts`'s `qHoldTime`/`eHoldTime` accumulate `dt` while
`Input.held` is true and fire+reset once the interval is reached, alongside the immediate
step already fired on `Input.pressed`. The interval is tuned to roughly the time one step's
smoothing takes to settle, so a hold reads as continuous rotation made of chained 45° steps
rather than a single tap that then does nothing until released and pressed again.

Movement (`Player.update`'s `forwardDeg` param, passed as `camera.viewerAngleDeg + 180`) is
camera-relative rather than DOOM-axis-relative: `W` always moves the player away from the
camera *on screen*, regardless of which way the camera has been orbited to face. `game.ts`
recomputes this every frame from the live camera angle before calling `player.update`.

### Collision (`src/game/world.ts`)

`World` provides spatial queries over a `DoomMap`: a 128-unit grid buckets linedefs for
`linesNear`, and `subsectorAt`/`sectorAt` walk the BSP tree the same way the renderer does.

The subtlest part is **`groundFloor`**, and it exists to fix a specific class of bug (falling
off a ledge permanently deadlocking movement): the height a body should rest at is not simply
the point-sampled sector floor. DOOM pins a mover's `floorz` to a straddled ledge's *high*
side for as long as its collision circle still spans that ledge's linedef (see `P_TryMove`'s
`tmfloorz` accumulation) — only once fully clear does the floor, and so `z`, drop to the low
side. `groundFloor` reproduces this: it's the max of the local sector's floor and the
opening-bottom of any two-sided line the circle is currently straddling (`crossesLine` tests
straddling — spanning both sides of the infinite line — not mere proximity, matching DOOM's
`P_BoxOnLineSide`). Player `z` must be snapped from `groundFloor`, not `floorAt`, or the very
next frame's step-up test compares a freshly-dropped `z` against a still-high opening bottom
and blocks every further move near that edge, forever.

Relatedly, `circleBlocked` only applies a two-sided line's opening (step-height, headroom)
gate while the circle actually straddles it (`crossesLine`); solid walls (`isSolidWall`:
one-sided or `LF.BLOCKING`) block on mere proximity regardless of side, since real physical
walls stop you from any direction. Conflating "near" with "straddling" for passable openings
is exactly what causes the deadlock above.

`slideMove` moves a circle by trying the two axes separately and retrying the blocked axis
from the new position, so the player rounds convex corners smoothly instead of stopping dead.

### Vertical physics: stairs, falling, gap-crossing (`src/game/player.ts`)

`Player.update` compares the current `z` against the freshly-recomputed `groundFloor` (above)
each frame rather than always snapping straight to it:

- **`z <= groundFloor`** (on the ground, or a step-up onto a higher tread within
  `MAX_STEP_UP` — already gated by `circleBlocked`/`blocksMovement`) snaps instantly, matching
  vanilla, which doesn't animate climbing a stair riser either; walking across a real
  staircase already reads as smooth because each tread is a separate sector crossed one
  frame at a time.
- **`z > groundFloor`** (the ground dropped out from under the player — walked off a ledge)
  is airborne: `velZ` accumulates at a constant `GRAVITY` and `z` integrates from it every
  frame, clamped to `groundFloor` once reached, instead of teleporting straight down. `velZ`
  is only ever negative — there's no jump input, so gravity is the only thing that ever moves
  `z` away from `groundFloor` in the first place.

`GRAVITY`'s value is tuned by feel (roughly a body height of fall in a third of a second),
not converted from vanilla's fixed-point tics-per-second gravity constant, which doesn't
translate cleanly to a dt-scaled model.

Crossing a short chasm without falling in — DOOM's own "gap narrower than the player" quirk —
falls out of `groundFloor` for free rather than needing separate jump logic: a gap narrower
than `2*PLAYER_RADIUS` (32 units) keeps the collision circle straddling *both* edges for the
entire crossing, so `groundFloor` reports the high (walkable) side throughout and the low pit
floor in between is never sampled. A wider gap does lose that straddle partway across, and the
player falls in under the gravity above — there's no actual jump input to clear it, unlike
some later source ports.

### Things as sprites (`src/wad/sprites.ts`, `src/render/sprites.ts`, `src/game/things.ts`, `src/game/thingdefs.ts`)

`SpriteBank` (`wad/sprites.ts`) indexes `S_START`/`S_END` lumps by sprite name + frame
letter, resolving DOOM's `SSSSFR` / `SSSSFRfr` naming (a frame can list a second
frame+rotation meaning "this same lump, mirrored, is also that rotation" — the usual way
DOOM halves the art needed for symmetric actors). `thingdefs.ts` maps THING doomednums to
their sprite name; a type absent from that table renders nothing, same as DOOM's own
invisible spawn markers (player starts, deathmatch spots, teleport landings).

**The split between `render/sprites.ts` and `game/things.ts` follows the same rendering/game
divide as the rest of the tree.** `render/sprites.ts` only knows how to turn a
(sprite name, frame letter, viewer angle) into a posed plane — `SpriteAnimator`/`SpriteActor`/
`SpriteMaterialCache`, no knowledge of maps, AI, health, or pickups. `game/things.ts` owns
`ThingLayer`/`PosedThing`/`buildThingSprites`: which map things exist, their per-instance
game state (health, alerted/ambush/AI fields, picked/dropped flags), and the update loop that
ticks monster AI, applies pickups/damage, and drives drops — it calls into the sprite layer to
actually draw each frame, but the game-state bookkeeping itself has nothing to do with
rendering.

**Map things are drawn batched, not one mesh each** (`render/spritebatch.ts: SpriteBatch`),
and this is a hard performance requirement rather than a refinement. A stress-test map like
NUTS.WAD has 10,696 things in a single 69-subsector open arena, so essentially all of them are
on screen and fog-of-war-revealed at once; one `THREE.Mesh` each meant ~10k draw calls per
frame and a ~2fps slideshow with the renderer dominating the DEVMODE profiler. `SpriteBatch`
keys one `InstancedMesh` per cached (lump, mirrored) pair and rebuilds the instance buffers
every frame — measured on that map, **10,693 sprites in 19 draw calls**.

Rebuilding wholesale each frame rather than maintaining instances incrementally is deliberate:
which lump a thing uses changes constantly (every monster re-picks its rotation frame as the
camera orbits *and* as its own facing changes, with its walk cycle advancing on top), so batch
membership isn't stable across frames and there's nothing worth preserving. Two properties keep
the per-sprite write cheap enough to do unconditionally:

- **Every sprite shares one rotation.** The planes never tilt and all track the same camera yaw
  (above), so the yaw's sin/cos are computed once per frame in `begin` and each instance matrix
  is written into the buffer as plain scalars — no per-sprite `Matrix4`/`Quaternion` allocation
  or `compose` call. (Verified against three.js's own `compose` on all of NUTS.WAD's things:
  worst element error 1e-8, i.e. float32 rounding.)
- **Sector light rides along as a per-instance color**, which *fixes* a pre-existing bug rather
  than merely preserving behavior: the one-mesh-each path tints by mutating the lump's **shared**
  material, so wherever several things shared a lump the last one posed each frame decided the
  light for all of them.

That per-instance color needs one non-obvious thing. three.js's fragment shader only multiplies
`vColor` in under `USE_COLOR` — i.e. `material.vertexColors` — while `USE_INSTANCING_COLOR`
alone populates `vColor` in the *vertex* shader and is then ignored downstream. So the batch's
materials are clones with `vertexColors: true` and a white base color, and
`SpriteMaterialCache` gives every sprite geometry an all-white `color` attribute, without which
WebGL's default (0,0,0) generic attribute would render every batched sprite black. The
non-instanced material ignores that attribute entirely (`vertexColors` stays false there).

The batches set `frustumCulled = false`: a batch's instances are scattered across the whole
map, so culling it as one object could only ever cull nothing while costing a per-frame bounds
recompute to decide that — off-screen instances are clipped by the GPU for the price of a
4-vertex vertex shader instead. That in turn means the bounding sphere three.js lazily computes
and caches for *raycasting* would go stale as instances move, so `end()` nulls it each frame.

`SpriteAnimator` is what makes both paths possible: it owns the frame cycle and the
state→(geometry, material) lookup with **no `THREE.Object3D` of its own**. `SpriteActor` wraps
one in a `THREE.Mesh` for the handful of sprites that genuinely are standalone (the player,
teleport fog, projectiles, impact explosions — a dozen at a time, where batching would buy
nothing); `PosedThing` holds a bare `SpriteAnimator` and feeds `SpriteBatch`. Because a batched
thing has no mesh of its own, `PosedThing.visible` replaces what used to be read back off
`mesh.visible`, and `ThingLayer.pickMonster` routes its auto-aim raycast through
`SpriteBatch.raycast`, which maps an `instanceId` hit back to the owning thing. That raycast
skips (rather than being blocked by) instances its predicate rejects, so a decoration standing
in front of a monster still doesn't make it untargetable — matching the behavior from when only
monster meshes were in the raycast set at all.

**`game/skill.ts: isMultiplayerOnly`** filters out things carrying THING flag bit `0x10`
before `buildThingSprites` (`game/things.ts`) poses them — vanilla's own `P_SpawnMapThing`
reads `if (!netgame && (options & 16)) return NULL;`, i.e. the bit hides a thing whenever no
other players are present. This engine has no multiplayer mode, so `netgame` is always false
and the bit always applies. Mappers use it to stash deathmatch-only weapons/ammo without
cluttering single-player — E1M1 has two `SHOT` (shotgun) things at different spots; only the
one *without* the bit is the "real" single-player pickup, the other is deathmatch-only and
was rendering (and, once pickups existed, collectible) before this filter existed.

Things render as upright planes (`render/sprites.ts: SpriteActor`/`SpriteMaterialCache`),
not `THREE.Sprite` billboards. A few decisions here are non-obvious enough to be worth
knowing before touching this file:

- **Planes turn to face the camera's yaw, but never tilt.** `TopDownCamera` can orbit in yaw
  (right-drag, see below) but only ever tilts a fixed amount off vertical — it never pitches
  further down or up. So a plane only ever needs to rotate around its vertical axis to track
  `camera.viewerAngleDeg` (`SpriteActor.setPose`'s `viewerAngleDeg` param, called every frame
  from `game.ts`); it never needs a true billboard rotation. `VIEWER_ANGLE_DEG` is just the
  default/fallback for callers that don't pass a live angle. A `THREE.Sprite`'s full
  camera-facing rotation would be both wasted work and actively wrong here: it tips flat as
  the camera tilts toward straight-down, making standing figures read as lying on the floor.
  An always-upright plane avoids that and is cheaper.
- **`DataTexture` can't use `flipY`.** WAD bitmaps start at their top row; a plane's default
  UVs put `v=0` at the bottom, so art arrives upside down. Setting `texture.flipY` does
  nothing — WebGL only honours `UNPACK_FLIP_Y_WEBGL` for image-source uploads, not the typed
  array every `DataTexture` uses — so the V axis is inverted through `texture.repeat`/`offset`
  instead. (Wall/flat UVs in `mapmesh.ts` dodge this a different way: they're built by hand
  with V running downward.)
- **The patch's `top` hotspot is not trusted for floor placement.** DOOM anchors a sprite at
  `thing.z + top`, and gets away with any slack that leaves below the sprite because its
  software renderer floor-clips every column and the camera sits near floor height anyway.
  Neither safety net exists in an unclipped 3D top-down view, so a patch whose `top` is less
  than its full height (common, worst on small pickups) would draw with its feet visibly
  below the floor. The bottom edge is anchored to the floor outright instead of trusting the
  offset; `left` is still used as-is for horizontal centring, which had no such problem.
- **Rotation frame (which of the 8 sprite angles) is picked from the live viewer angle**
  every frame (`pickRotationDigit`), same as the plane's own yaw above — both track
  `camera.viewerAngleDeg`, not a hardcoded constant, now that the camera orbits.
- **Ammo/health/armor/keys/powerups/decorations render `PICKUP_SCALE` (1.4×) larger than
  their native WAD pixel size; monsters and weapons don't.** Vanilla's 1:1 unit-per-pixel
  sizing suits a ground-level first-person view; from this game's far, tilted top-down camera
  the same pixel size reads much smaller, and small collectibles (a clip, a shell box) are
  what actually gets lost — monsters are already large enough to read and weapons already
  stand out, so both are deliberately left at native size while everything smaller gets
  bumped up. Applied as `actor.mesh.scale.setScalar(...)` rather than baked into the shared
  per-lump geometry (`SpriteMaterialCache`'s cache), since scale needs to vary by thing type
  even when two types happen to reuse art. It composes safely with the floor-anchoring
  above: geometry is translated so the plane's bottom-center sits at local `(0, 0)` *before*
  `mesh.scale` is applied, so scaling stretches the plane upward and outward from that point
  instead of moving its anchor — a scaled item still sits exactly on the floor, still
  horizontally centred on its own `(x, y)`.

Animation (`SpriteActor.setPose`'s `animFrames`/`animating`) is a plain frame-letter cycle
with no separate idle art, matching DOOM itself: the player's `PLAY` sprite reuses `A,B,C,D`
as its walk cycle and simply holds `A` while not moving. Every other thing still defaults to
a single held frame — giving monsters their own idle animation needs DOOM's actual per-type
state tables (which frames are "idle" vs. attack/pain/death), not a guessed frame range, so
that's deferred to the combat/monster milestone rather than approximated now.

### Item pickups and HUD (`src/game/inventory.ts`, `src/ui/hud.ts`, `game/things.ts: ThingLayer.tryPickup`)

The HUD's powerup strip (`.hud-powers`, built from `STRIP_POWER_IDS` the same way `.hud-weapon`
is built from `WEAPON_CYCLE`) exists for the same reason the weapon icon does: a running
powerup has no other on-screen presence at all — no number that changes, no door that opens —
so without it there's no way to know one is active or how much of it is left. Each row shows
that powerup's own ground-pickup sprite plus a countdown, blank for the one remaining
`Infinity`-duration entry (a countdown there would only ever read the same number). The
backpack shares the strip: same kind of "you have this now" status, also with no number of its
own. The whole panel collapses via `.hud-stat.hidden` while nothing is active, so `#game-hud`'s
flex `gap` doesn't leave a hole.

**Berserk is deliberately not in the strip at all** (`STRIP_POWER_IDS` = `POWER_IDS` minus
`'berserk'`) — it already has an on-screen presence the other five don't: the health icon
itself swaps from `MEDIA0` to berserk's own `PSTRA0` while it's held, the same idea as the
armor icon already swapping between its green/blue art by `armorType`. Two `<canvas>`
elements sit in `.hud-health` (`.icon-normal`/`.icon-berserk`), toggled by `.hidden` off
`hasPower(inv, 'berserk')` — no separate countdown needed, since berserk is one of the
`Infinity`-duration powers anyway.

`Inventory` (health, armor + armor type, four ammo classes, collected keys) is a plain
struct owned by `Game` in `game.ts`, not by `Player` — nothing about resting height or
movement needs it, and keeping it separate is what makes `finishLevel` (below) a one-line
call at map load rather than something `Player`'s constructor has to reason about.

Health, armor, ammo, keys, weapons, the backpack and all six powerups are collectible — see
"Powerups" below for the powerup half, which is the only category whose effect lives outside
this struct's own numbers. Weapon ownership and ammo land in
`Inventory.weapons`/`Inventory.ammo`, and are read by `game/weapons.ts` (below) for
selection and firing. `Inventory.currentWeapon` lives here rather than in `WeaponSystem` for
the same reason the rest of the struct does: `game.ts` owns it, and the HUD reads it straight
off the same struct it already reads health/ammo/keys from. Picking up a weapon **not already
owned** selects it, matching vanilla's `P_GiveWeapon`; re-picking one you already have doesn't
yank the selection away. `fist` and `pistol` are in `WeaponId` even though neither has a map
pickup — every game starts owning both, and they still need ids to be `currentWeapon`-able.

`applyPickup` (`game/inventory.ts`) follows vanilla's `P_TouchSpecialThing` for that
subset — most importantly, a Stimpack/Medikit at full health, an armor pickup weaker than
what's already worn, or a weapon whose ammo type is already capped and which is already
owned, **isn't** consumed (`applyPickup` returns `false`), leaving the item on the ground
exactly like vanilla, rather than a pickup silently vanishing for no visible effect.
Health/armor *bonus* items (health bonus, soulsphere, megasphere, armor bonus) are the
exception vanilla itself carves out — they push past the normal 100/100 cap up to 200 and
are always consumed. A weapon's ammo grant follows vanilla's `P_GiveWeapon` too: it's
`2 × clipammo[type]` — twice a single ammo pickup of that type — since every weapon here is
placed directly on the map rather than dropped by a dead monster (which only vanilla-gives
half); there are no monster drops yet for that distinction to matter.

**Keys and powerups don't survive a level transition; health/armor/ammo and the backpack's
raised caps do** (`finishLevel`, called from `game.ts: loadMapByIndex` before the new map
loads) — matching vanilla's own `G_PlayerFinishLevel`, which clears `player->cards` and
`player->powers` (and drops `MF_SHADOW`) but nothing else; `player->backpack`/`maxammo` are
deliberately not among them. This does mean a locked door on the far side of a level
transition needs its key collected again on the new map, same as vanilla itself requires.

**Locked doors check the matching key** (`game/specials.ts: SpecialsController.trigger`).
`wad/specials.ts`'s keyed door specials (26-28, 32-34, 99, 133-137) each carry a `requiredKey`
color on their `DoorEffect` — resolved per-special against vanilla's `P_UseSpecialLine`
source rather than guessed, since the two manual-door groups don't share an ordering
(26/27/28 are Blue/Yellow/Red, 32/33/34 are Blue/Red/Yellow). `trigger` checks
`ownedKeys.has(requiredKey)` before doing anything else — no flashing switch texture, no
`usedOnce` mark — so a player who doesn't have the key yet can walk off, find it, and press
the same line again later, matching vanilla's own "you need the X key" behavior functionally
(there's no on-screen message system yet to show the text itself). `ownedKeys` is threaded
through from `Game.frame` as `this.inventory.keys` on every call to `SpecialsController.update`,
same as `playerX`/`playerY` — inventory is a `game.ts`-owned struct, not something
`SpecialsController` reaches for on its own (see `Inventory` above for why).

Getting the key check to actually fire surfaced a second, unrelated bug in the same table:
99 and 133-137 were missing or mismarked `manual: true`. Unlike 26-34 (real D1 manual doors,
which open the *linedef's own* back sector and ignore tag entirely), 99/133-137 are S1/SR
switches that target sectors by tag like any other remote door — confirmed by scanning every
stock DOOM/DOOM2 map, where every 99/133-137 linedef's tag exactly matches the sector(s) it
opens. `wad/specials.ts`'s own doc comment has the numbers; the concrete bug this caused was
DOOM2 MAP04's blue door (special 99, missing from the table until this fix) never opening at
all, key or no key.

**A `use` trigger only fires from a linedef's front (right-sidedef) side** —
`game/specials.ts: isFrontSide`, confirmed against `linuxdoom-1.10/p_switch.c`'s
`P_UseSpecialLine`, which unconditionally rejects every use-triggered special from the back
side except an unused one (124, a "sliding door" case never used as a `use` special in
`LINE_SPECIALS`). `handleUseTrigger` computes the player's side of each candidate line (via
`P_PointOnLineSide`'s own cross-product test) and skips any line the player is on the back of,
same as vanilla's `PTR_UseTraverse` computing `side` from the player's position before calling
`P_UseSpecialLine`. Walk triggers get no such check — `P_CrossSpecialLine` has none — so this
is `use`-only. Without it, a manual door or switch mounted on an ordinary-looking wall (a
disguised "push wall" secret, the common case for a D1 manual-door special like 31) could be
opened from *either* side, letting a player skip the switch a mapper hid elsewhere and open a
secret from the wrong direction entirely; E1M2's sector 21 secret is exactly this shape — a
manual door usable only from its intended (front) side, with a remote switch in a separate
secret room as the other, tag-based way in.

Removing a picked-up item from the world is `ThingLayer`'s job, not `Inventory`'s: each
posed thing already carries its doomednum and position (added alongside the existing
per-thing pose data), so `tryPickup(x, y, z, radius, consume)` can test distance and call
back into `applyPickup` itself, hiding the mesh and marking it `picked` only if `consume`
reports the pickup actually happened. `picked` short-circuits `ThingLayer.update` before it
touches fog-of-war visibility — without that, a subsector coming into view after its item
was already picked would make `fogAlphaOf` flip the (permanently hidden) mesh back to
`visible = true`.

`tryPickup`'s `z` check exists because 2D distance alone lets a player standing at the *base*
of a not-yet-lowered pillar collect an item still sitting on top of it — DOOM2 MAP04's blue
key does exactly this (sits on a pillar a switch must lower first). Matching vanilla's
`PIT_CheckThing` overhead gate, a pickup more than `PLAYER_HEIGHT` above or below the player
is skipped regardless of 2D range. That in turn requires a thing's height to track its
sector's *live* `floorHeight` rather than a value cached at load — `PosedThing` stores the
`Sector` reference itself (the same mutable object `SpecialsController` writes
`floorHeight`/`light` onto) instead of a frozen `z` number, and both `ThingLayer.update` and
`tryPickup` read `sector.floorHeight` fresh every call. Without this, an item on a lift/floor
mover would hang frozen in its original position while the floor moved past it, and — worse
— stay permanently out of reach even after the pillar carrying it actually lowered, since the
height check would still be comparing against the stale load-time value.

The HUD itself (`src/ui/hud.ts`) draws its icons from the same WAD pickup-sprite graphics
the world renders items with (`MEDIA0`, `ARM1A0`/`ARM2A0`, `CLIPA0`, etc., via
`GraphicsBank.picture`) rather than hand-drawn icons, decoded once into `<canvas>` elements
whose markup lives statically in `index.html` (`#game-hud`) whether or not that WAD's
graphics happen to be loaded yet — `Hud`'s constructor draws into it once per `Game`
instance (a WAD's graphics can only be decoded after the WAD is loaded, unlike the marker
divs above them). Finding the right icon lump names surfaced a pre-existing bug: the rocket
pickup (`doomednum` 2010) was mapped to sprite `RCKT` in `game/thingdefs.ts`, which isn't a
real lump — the actual sprite is `ROCK`, so rockets were invisible in the world before this
fix (their pickup radius still worked; only their being visible before pickup didn't).

**The weapon icon is not decoration.** Unlike the original's status bar, where the weapon in
your hands fills the bottom third of the screen, this game's player sprite looks identical
whatever it's holding — `PLAY` has no per-weapon art, and at this camera distance it wouldn't
read anyway. The HUD icon is therefore the *only* indication of what's selected, which is why
it exists at all. Its markup is built in `Hud`'s constructor from `WEAPON_CYCLE` rather than
written into `index.html` like the other panels: the weapon list is a compile-time constant in
`game/weapons.ts`, so duplicating it as static markup would be two lists to keep in sync.
Icons reuse each weapon's own ground-pickup sprite (`WeaponDef.iconLump`); fist and pistol have
no pickup, so they fall back to their first-person `PUNGA0`/`PISGA0` frames.

Both dynamically-built panels (`.hud-weapon` and `.hud-powers` below) `replaceChildren()` before
filling themselves. `Hud` is constructed per `Game`, against the *same* static `#game-hud`
element — so a second game started from the menu would otherwise stack a second full set of
icons on top of the first's.

### Powerups and the backpack (`src/game/inventory.ts`, `src/game.ts`, `src/ui/hud.ts`)

`Inventory.powers` holds seconds remaining per `PowerId`, ticked by `tickPowers` (which
`game.ts` calls only while alive, matching vanilla's `P_PlayerThink` handing off to
`P_DeathThink` before it reaches them). Durations are vanilla's own `INVULNTICS`/`INVISTICS`/
`IRONTICS`/`INFRATICS` over 35 — plain constants that survive conversion out of tics intact,
unlike `weapons.ts`'s fire rates. Berserk and the computer area map are `Infinity`: vanilla
stores them as a flag that never counts down, and `finishLevel` clears them along with every
other power at the end of the level anyway.

`givePower` reproduces `P_GivePower`'s three-way split rather than treating the six uniformly:
the four timed ones always take and **restart** their clock (they never stack), berserk always
takes and additionally tops health back up to the normal 100 cap (`P_GiveBody`, never past it
the way a bonus item would) and switches to the fist, and the computer area map is the only one
that can be **refused** — it falls into `P_GivePower`'s generic "already got it" branch, so a
second one stays on the ground rather than silently vanishing.

Where each effect actually lives is the load-bearing part, since only two of the seven are
inventory arithmetic:

- **Backpack** (`ammoMax`) doubles every cap permanently and hands over one `CLIP_AMMO` of each
  class. Every cap check in `inventory.ts` routes through `ammoMax` rather than reading
  `AMMO_MAX` — a weapon pickup's own ammo grant respects the raised cap too, not just plain
  ammo pickups. It is always consumed, even at full ammo, unlike every other ammo pickup.
- **Invulnerability** is checked in `applyDamage`, in the same place and with the same
  `damage < 1000` threshold vanilla's `P_DamageMobj` uses.
- **Radiation suit** gates `game.ts: updateDamageFloor` through `suitBlocks`, and vanilla is
  deliberately not uniform here either — `DamageFloorEffect.suit` is per sector type: nukage/
  hellslime are blocked outright, the two 20-damage slimes share a `case` reading
  `!pw_ironfeet || (P_Random()<5)` so a suit still leaks `SUIT_LEAK_CHANCE` of hits, and E1M8's
  finale type (11) never consults the suit at all. The interval keeps running while a hit is
  blocked (vanilla's clock is the global `leveltime&0x1f`), so the suit skips damage rather
  than banking it up for the moment it expires.
- **Berserk**'s ×10 is applied in `WeaponSystem.update`, to the **fist only** — vanilla's
  `A_Punch` reads `pw_strength` and `A_Saw` deliberately doesn't.
- **Computer area map** is the one whose whole effect lives outside `Inventory`:
  `FogOfWar.revealAll`, watched for by doomednum (`COMPUTER_MAP_TYPE`) in `game.ts`'s pickup
  callback. Here that *is* vanilla's `pw_allmap` — this engine's play view and its map view are
  the same view, so revealing the geometry is exactly what filling in the automap does. It sets
  only the `explored` flags, not `alpha`, so the ordinary reveal lerp fades the level in rather
  than snapping it on.
- **Partial invisibility** is two things, neither of them a rule about being seen:
  `INVISIBILITY_OPACITY` on the player sprite, and `game.ts: applyShadowAim` throwing a
  monster's *ranged* shot off-aim by vanilla's own `A_FaceTarget` fuzz
  (`(P_Random()-P_Random())<<21`, i.e. up to ±44.8°, `SHADOW_AIM_SPREAD_DEG`). That fuzz is the
  entire vanilla mechanic — `MF_SHADOW` never touches `P_CheckSight`, waking, or a monster's
  willingness to attack, so none of those are gated on it here either. It's applied per shot
  (each bullet of a burst goes its own way) and only to a shot aimed at the player
  (`targetId === null`): nothing else here carries `MF_SHADOW`, and an infight shouldn't go wide
  because the player drank something. Melee is deliberately unaffected, matching vanilla, whose
  melee lands on `P_CheckMeleeRange` rather than on the fuzzed angle.
- **Light amplification visor** rides `WebGLRenderer.toneMappingExposure`
  (`LIGHT_VISOR_EXPOSURE`). `Viewport` sets `toneMapping = LinearToneMapping` **once**, at
  construction: changing `toneMapping` itself recompiles every material's shader, while the
  exposure is a plain uniform, and `LinearToneMapping` at exposure 1 is `saturate(color)` —
  bit-identical to `NoToneMapping` for anything already in range, so it costs nothing until the
  visor turns it up. A flat multiply is an approximation of vanilla's "force the brightest
  colormap row everywhere"; matching that exactly would mean rebuilding every surface's baked
  vertex lighting (see "Sector lighting"), which is far more than the effect is worth.

The two screen tints (`#screen-tint`, `menu.css`) are CSS on the composited frame rather than
anything in the render pipeline. Invulnerability uses `backdrop-filter: grayscale(1) invert(1)`
— vanilla's `INVULNERABILITYMAP` really is a *grayscale* inverse of the palette, not a colour
inversion — and the suit a flat green wash. The element sits at `z-index: 5`: above the canvas,
below every HUD layer (all at 10+), so the world recolours and the readouts over it don't.
`Game.dispose` has to clear both classes and reset the exposure, since the `Viewport` and these
overlay elements outlive a `Game` — otherwise the menu, and the next level started from it,
inherit whatever powerup was running when the last one ended.

`SpriteActor.setOpacity` (`render/sprites.ts`) draws through a per-actor **clone** of the shared
cached material rather than mutating it: `SpriteMaterialCache` hands out one material per
(lump, mirrored) pair to everything drawing that lump. Only the player ever uses this, and
`PLAY` happens to be the player's alone, but relying on that would be a trap the first time
something else reuses a lump. The clone drops `alphaTest` from 0.5 to 0.01 — the test is against
`texture.a * opacity`, so at 0.35 opacity the 0.5 threshold would discard the *entire* sprite;
WAD sprite alpha is binary (0 or 255, and `NearestFilter` never blends between them), so any
threshold below the opacity in use cuts exactly the same silhouette. It's the stand-in for
vanilla's `fuzz` colormap (a per-column smear of what's behind the sprite, a software-renderer
trick with no direct equivalent here) and deliberately errs toward still being findable on
screen: in vanilla the invisible thing is *you*, seen from your own eyes; here it's a sprite you
have to keep track of.

### Weapons, firing and auto-aim (`src/game/weapons.ts`, `src/game/world.ts: shotPath`, `src/render/tracer.ts`, `src/game.ts`)

`WeaponSystem` (`game/weapons.ts`) owns weapon selection and fire timing/ammo, and
**deliberately knows nothing about three.js**: `update` returns a list of `Shot`s describing
what was fired this frame (one per hitscan pellet, one per projectile launched, or one per
melee swing), and `game.ts` turns those into tracer lines and flying sprites. That's the same split as
`game/specials.ts`'s line triggers vs. `game.ts`'s teleport-fog puffs, and it's what lets fire
rates and ammo costs be tested headlessly against a synthetic map.

Fire rates and spread are tuned by feel rather than converted from vanilla's tic-based weapon
state tables — same reasoning as `player.ts`'s `GRAVITY`, they don't translate to a dt-scaled
model. Ammo-per-shot has no such problem and is lifted straight from vanilla, since it's what
decides how long a pickup's ammo lasts — as are the damage dice, including the fist's and
chainsaw's shared 2-20 (`(P_Random()%10+1)<<1`). **A melee swing is resolved entirely
differently from every other shot**: `spawnShot` returns before `shotPath` even runs, and just
raycasts `PLAYER_MELEE_RANGE` (vanilla's own `MELEERANGE`, 64) along the aim angle — a swing
doesn't travel, so it needs none of `shotPath`'s wall/step blocking, matching vanilla's
`A_Punch`/`A_Saw`, which trace `MELEERANGE` from the player and damage whatever is there. It
needs no lock-on case either: `player.angle` is already set from the same `aim` the lock uses,
so the ray finds a hovered monster on its own, and simply can't reach one further off than the
swing's own range. Hitscan spread uses vanilla's own `P_Random - P_Random`
trick (two uniform draws subtracted → triangular distribution centred on the aim line).

**Slot keys toggle within a slot, they don't select "the best".** `WEAPON_SLOTS` lists each
digit's weapons best-first, but pressing a digit already showing one of that slot's weapons
advances to the *next* one owned rather than re-picking the best. Without this, slots 1 and 3
(fist/chainsaw, shotgun/super shotgun) made their weaker weapon permanently unreachable once
the upgrade was owned — which presented as "shotgun and super shotgun are the same weapon".

**`shotPath` (`game/world.ts`) decides where a shot ends up**, for both tracer endpoints and
how far a projectile may fly. It has two modes, and the difference is the whole reason it takes
a `target` rather than just an angle:

- **Free shot** (no target): flat at the player's fire height, out to `WEAPON_RANGE`. Blocked by
  a line with no opening at all (a genuinely one-sided wall, or a two-sided line whose opening
  has closed, like a shut door) **and** by a two-sided line whose vertical opening the shot's
  height doesn't fit through. Neither test alone is enough — `blocksSight` alone lets a shot
  through a shut door (vanilla never flags those `BLOCKING`, so `blocksSight`'s own no-opening
  test is what actually catches them), and omitting the height test entirely lets a rocket sail
  through a knee-high step because the opening beyond it was tall enough for *sight*.
  Deliberately **not** `isSolidWall`, and this one bit — reusing the movement-blocking predicate
  for shots — was a real, shipped bug: it made a shot treat a `BLOCKING`-flagged two-sided line
  (a barred window/railing) as impassable the same as a real wall, when vanilla's own hitscan/
  projectile trace (`PTR_ShootTraverse`) never reads `ML_BLOCKING` at all — only movement does.
  Concretely, DOOM2 MAP01's east imp closet (sector 38)'s fence is exactly this kind of line, and
  the bug blocked *both* the player's own shots at the imp and the imp's fireballs at the player
  through it, when vanilla lets bullets and fireballs pass through bars just fine (see
  `blocksShot`'s doc in `game/world.ts`).
- **Locked-on shot** (auto-aim target, or a monster's own fired shot at the player): slopes from
  the shooter's fire height to the target's over exactly the distance between them, and stops
  *at* the target. A separate `skipHeightTest` parameter (default: on whenever a `target` is
  given, preserving the player auto-aim behavior below) controls whether the height test above
  still applies on top of that slope — deliberately **skipped** for the player's own auto-aimed
  shot: it's angled over intervening steps on purpose, and leaving the height test on meant a
  shot at a monster on a ledge got cut off at the ledge's near edge, which (since the returned
  height is "wherever it stopped") presented as the shot going flat and ignoring the click
  entirely. A monster's own fired shot (`game.ts`'s `spawnMonsterProjectile`) needs the same
  slope-toward-target-height behavior but explicitly passes `skipHeightTest: false`, since the
  player has no "auto-aim" convenience to justify a monster's fireball clearing a low or high
  step it shouldn't.

Both modes start at the shooter's own height, never the target's — using the target's height for
the origin made tracers and projectiles visibly begin in mid-air rather than at the gun. Blocking
is evaluated at the interpolated height where the ray crosses each candidate line, not one height
for the whole flight. Candidate lines are extended `WALL_OVERLAP` past both ends for the same
reason `FogOfWar` extends its sight blockers: two walls meeting at a shared vertex otherwise let
a shot aimed at that corner slip between them.

**`shotPath`'s returned `lineIndex` — whichever line actually stopped the shot, or null if it
reached its target/`WEAPON_RANGE` unobstructed — is what drives `wad/specials.ts`'s three
shoot-triggered ("impact") specials, 24/46/47** (`SpecialsController.triggerShot`), vanilla's
`P_ShootSpecialLine`. A hitscan pellet's trigger fires immediately in `spawnShot`/
`resolveMonsterHitscan` (it's resolved and gone within the same frame, matching vanilla's own
instant `PTR_ShootTraverse` call), but a projectile's is deferred to the frame it actually
*arrives* at that wall in `updateProjectiles` rather than firing back at launch — vanilla calls
`P_ShootSpecialLine` for a missile from `PIT_CheckLine`, which only runs once the missile's own
movement reaches the line, not when it's fired — so `Projectile.lineIndex` carries the line
found at launch (safe to resolve early, same as `maxDist` itself: static geometry doesn't move
mid-flight, and this project already accepts that approximation elsewhere) forward to the
explosion branch. Either way, the special only fires if nothing closer — a monster's body,
or the player — actually absorbed the shot first: `hitMonsterId`/`reachedPlayer`/`struck` all
take priority over the wall.

24 and 47 reuse the plain `FloorEffect` machinery already built for their walkover/switch
siblings (5/64/91/101 and 20/68/22/95 respectively — same targets, same speeds), just
tag-triggered by a shot instead. **Only 46 can be triggered by a monster's own shot** —
`SpecialDef.monsterCanTrigger`, reproducing a hardcoded, per-number exception in vanilla's
`P_ShootSpecialLine` itself (`if (!thing->player)` rejects every case *except* 46) rather than
some general property of shoot-triggers; a monster's hitscan bolt or fireball that happens to
stop dead against a 24 or 47 line does nothing, exactly as in vanilla. Getting 46's own
repeatability backwards was a real mistake caught while adding the other two: vanilla's
`P_ChangeSwitchTexture(line, useAgain)` clears `line->special` when `useAgain` is falsy, and
46 passes `1` (stays repeatable — GR) while 24 and 47 both pass `0` (one-shot — G1), which is
the opposite of what an early version of this table had for 46.

**Auto-aim is click-to-target, not vanilla's autoaim cone** — this game has a mouse pointer,
so "aim at that one" is expressible directly. `ThingLayer.pickMonster` raycasts the cursor
against monster sprite meshes (`MONSTER_TYPES` in `game/thingdefs.ts`, filtered to
currently-`visible` meshes so a fog-of-war-hidden monster can't be targeted through the
geometry hiding it) and returns the hit monster's position *and* its sector's live floor
height. `game.ts` uses that as both the aim point and the shot's end height.

The lock applies **on hover, not on click**. Gating it to `input.mouseDown` made `aim` — which
drives `player.angle` *and* the camera's aim-lead — switch sources the instant a click landed,
and since a monster is normally much nearer than the cursor's floor-plane projection, the
camera's lead offset collapsed at that moment and read as the camera lurching backwards. Aim
has always been set from the cursor unconditionally, click or no; the lock has to follow the
same rule to stay continuous.

Impact explosions and the teleport-fog puff share one mechanism in `game.ts`
(`OneShotEffect`/`spawnEffect`/`updateEffects`): a transient sprite animation playing once at a
fixed spot, outside `ThingLayer` since neither is a real map `Thing`. `IMPACT_EFFECTS` maps a
projectile's flight sprite to its explosion — vanilla reuses `MISL` frames B–D for the rocket's
own blast, while the plasma bolt and BFG ball explode into dedicated `PLSE`/`BFE1` sprites.

### Monster AI (`src/game/monsters.ts`, `src/game/things.ts`)

Every `MONSTER_TYPES` entry except Commander Keen (72) and the boss brain (88) — neither attacks
or moves in vanilla either (Keen's "death" is a pain cascade with no real combat state, the boss
brain is a stationary cube-spawner with no player-facing attack this engine models) — now wakes,
chases and attacks the player. The split follows the same shape as `WeaponSystem`/`SpecialsController`
elsewhere: `game/monsters.ts`'s `stepMonsterAI` (chasing/attacking) and `tryWake` (waking up) are
pure functions that read/write a monster's own mutable state and return *what happened* (a fired
`MonsterAttack`, or whether it woke); `ThingLayer.update` (`game/things.ts`) is where that state
actually lives (each `PosedThing` carries its own AI fields alongside the pose/health/drop fields
it already had) and owns the throttle that calls `tryWake` — the wake *decision* itself (FOV,
sight, sound, ambush rules) lives in `monsters.ts` alongside `stepMonsterAI`, not in `things.ts`.
`Game.frame` (`src/game.ts`) turns a returned attack into damage and, for a ranged one, a tracer.

**A monster stays inert until it spots the player, checked on a throttle rather than every
frame** — `ThingLayer.update`'s `LOOK_INTERVAL` (~0.3s) mirrors vanilla's own idle `A_Look`,
which vanilla itself only runs every 10 tics, not continuously; `tryWake` is what runs each time
the throttle fires. That check is gated by `game/monsters.ts: canSpotPlayer` *before*
`hasLineOfSight` even runs: vanilla's own
`P_LookForPlayers` only lets a monster notice the player within roughly its forward 180° (the
map-placed thing angle, unchanged until the monster actually wakes), unless the player is within
melee range regardless of facing. Skipping this meant a monster facing away from the player at
spawn — most of a level's population, at the moment the level loads — still "saw" the player and
attacked instantly the moment there was an unobstructed line between them, which reads exactly
backwards: the monster visibly isn't looking at you. Once alerted (by sight, by sound, or by
taking any damage at all — `reactToDamage` sets it unconditionally, matching vanilla's own
`P_DamageMobj` setting `target` regardless of prior sight or facing) a monster is alerted for
good and the FOV gate no longer applies — matching vanilla's own `A_Chase`, which never re-checks
it once hunting; there's no "lost the scent and went back to sleep" in vanilla either.

**Monsters also wake from gunfire, without needing sight, via `World.noiseAlert`/`isSoundAlerted`
(`game/world.ts`)** — confirmed against the actual `linuxdoom-1.10` source
([`p_enemy.c`](https://github.com/id-Software/DOOM/blob/master/linuxdoom-1.10/p_enemy.c),
[`p_pspr.c`](https://github.com/id-Software/DOOM/blob/master/linuxdoom-1.10/p_pspr.c)) rather than
assumed, the same rigor as this file's line-special tables. `game.ts` calls `noiseAlert` at the
player's position whenever a shot actually fires (matching vanilla's `P_FireWeapon`, which calls
`P_NoiseAlert` for every successful weapon fire, melee included — `P_FireWeapon` is the same
entry point for every weapon, so swinging a fist in an empty room wakes the neighbours the same
as firing a pistol would). `noiseAlert` floods outward sector-by-sector through two-sided lines, matching vanilla's
`P_RecursiveSound` exactly: a fully closed door (zero vertical opening) stops it outright, an
`LF.BLOCK_SOUND`-flagged line softens it once (crossable, but a *second* such line on the same
path stops it), and every other two-sided line passes it through unchanged. Once a sector is
marked (`isSoundAlerted`), it stays marked for the rest of the level, matching vanilla's own
`sector->soundtarget`, which is never cleared — a monster that only wanders into an already-noisy
sector later still wakes, not just whoever was standing there at the moment of the shot. A
sound-alerted monster wakes with **no FOV or sight check at all** (matching vanilla's `A_Look`,
which `goto seeyou`s straight off `soundtarget` for anything not "ambush"-flagged) — this is
deliberately more permissive than the sight-based wake above; a gunshot two rooms over should pull
monsters even where they can't yet see the shooter. **Ambush-flagged things** (`game/skill.ts:
isAmbush`, vanilla's `MF_AMBUSH`/editor "deaf") are the one exception: they ignore the sector flag
entirely unless they can actually see the source (still with no FOV restriction, matching
vanilla precisely), falling back to the same ordinary FOV+sight check every monster gets — a
mapper's "won't come running at gunfire, but still spots you normally" ambush setup works exactly
as intended.

**Every timing value in `MONSTER_STATS` is lifted from vanilla's own `info.c`; only the damage
dice are tuned by feel.** This is the opposite of the split `weapons.ts`'s fire rates and
`player.ts`'s `GRAVITY` make, and deliberately so — those genuinely don't survive conversion out
of vanilla's per-tic accumulation model, whereas a monster's walk speed, attack length, pain
length and chase cadence are all plain constants that do. Vanilla moves a monster exactly
`mobjinfo.speed` units per `A_Chase` call and calls `A_Chase` once per state of its own walk
loop, so `MonsterStats.speed` in units/sec is just
`speed × (A_Chase states in the loop) × 35 / (tics in the loop)` — nothing to lose in
translation, and the per-loop state count genuinely matters (the arachnotron and spider
mastermind spend 2-3 of their 12 walk states on footstep-sound actions that don't move them, the
cyberdemon 2 of 8). An earlier pass eyeballed these at roughly 2-3× vanilla, which is the single
biggest reason monsters didn't feel like DOOM's: it both flattened the gap between a shambling
zombieman (70 units/sec) and a charging demon (175), and let nearly everything keep pace with a
running player, when in vanilla the fastest monster in the game — the arch-vile at 262 — is
still barely half the player's own run speed. `MonsterStats.chaseInterval` (the same loop's
seconds per `A_Chase` call) comes out of the same arithmetic and is what the rest of the AI
clock is quantized to below.

**A newly-alerted monster starts moving immediately but can't fire until its `reactiontime`
elapses** — vanilla's own field, which is 8 for every monster in the game. `tryWake` seeds
`MonsterBody.reactionTicks` with `REACTION_CHASES` (8), and `runChaseCall` decrements it once per
chase call exactly as vanilla's `A_Chase` does — so it's measured in chase calls, not seconds,
and a zombieman's hesitation (8 × 0.114s ≈ 0.91s) really does last twice as long as a demon's
(8 × 0.057s ≈ 0.46s) purely because their `chaseInterval`s differ, the same as every other
vanilla-derived timing in this file. Without any such delay a monster with a long sightline fired
the exact frame it came into view, with no perceptible reaction. It gates **ranged attacks only**
(`checkMissileRange` reads it, melee does not) — vanilla reads `reactiontime` nowhere except
`P_CheckMissileRange`, so a demon woken at arm's length bites on the spot. A monster alerted by
taking damage has `reactionTicks` zeroed outright (`reactToDamage`, vanilla's own "we're awake
now") rather than waiting it out, same as vanilla doesn't re-delay an already-awake monster.

**Movement is vanilla's `P_NewChaseDir`, on vanilla's eight directions** (`game/monsters.ts`'s
`newChaseDir`/`tryWalk`), not a beeline. A monster only ever walks along E/NE/N/NW/W/SW/S/SE,
commits to a heading for `movecount` chase calls, and re-routes when that expires or a move gets
refused — trying the direct diagonal first, then the two cardinals (longer axis first, with
vanilla's ~22% random swap), then its previous heading, then a full scan from a randomly chosen
end, and only as a last resort the about-face it has been avoiding throughout. That
refuse-to-turn-around rule is what stops a blocked monster oscillating, and the random scan
direction is what eventually unwedges two monsters stuck in the same doorway. There is still no
pathfinding, matching vanilla, which also routinely gets monsters stuck on complex geometry — but
this *is* vanilla's actual algorithm rather than the "if it hasn't moved in half a second, blend
in a random lateral angle" heuristic an earlier version used, which produced a visibly different
gait: a drifting curve into a wall instead of DOOM's flat commit-and-re-route.

Two consequences worth knowing. Monster movement **deliberately doesn't use `slideMove`**:
vanilla's `P_Move` is all-or-nothing (only the player gets `P_SlideMove`), and re-routing rather
than sliding along a wall is exactly what produces the zig-zag. And the walk itself is
**interpolated per frame** along whatever `movedir` the last chase call settled on, rather than
jumping a full `speed` units per call the way vanilla does — same distance covered and same
8-way path, but vanilla's jump reads as continuous only because it renders at 35fps, and at this
engine's frame rate it would visibly stutter. Everything else (`groundFloor`, gravity
integration once airborne via `settleVertical`) still mirrors `Player.update` exactly, so a
chasing monster steps up onto low ledges the same way the player does.

Two deliberate differences from the player's own movement, both passed as extra arguments to
`slideMove`/`circleBlocked`/`groundFloor` (`game/world.ts`) that the player's own movement calls
never set:

- **`forMonster: true`** makes `isSolidWall` additionally treat an `LF.BLOCK_MONSTERS`-flagged
  line as solid — vanilla's own `ML_BLOCKMONSTERS`, used to fence monsters out of an area (or off
  a ledge) while the player can still walk through freely.
- **`avoidDropoff: true`** (for every monster type except the cacodemon, lost soul and pain
  elemental — vanilla's actual floating/hovering monsters, `MonsterStats.flies`) makes a monster
  refuse to step into a position where `groundFloor`'s rest height would sit more than
  `MAX_STEP_UP` above `World.dropoffFloor`'s lowest touched floor — i.e. it won't walk out over a
  drop deeper than a step, matching vanilla's own `P_TryMove` dropoff rule (confirmed against the
  real `linuxdoom-1.10` source: identical 24-unit threshold, and the identical `MF_DROPOFF`/
  `MF_FLOAT` exemption, here narrowed to just the three flying types). This is why a grounded
  monster won't simply walk off a high ledge chasing the player the way the player's own falling
  physics lets *them* do — the player's own ability to walk off a ledge and fall under gravity is
  a deliberate, already-shipped feature of this engine (see `player.ts`), not something monsters
  get too. `tryWalk` (above) treats a dropoff-refused step exactly like a wall-refused one — it's
  just another `circleBlocked` failure — so `newChaseDir`'s ordinary re-routing already handles a
  monster balking at a ledge; no separate fallback is needed for it.

**A monster always keeps closing distance until it physically runs into its target — it never
"keeps its distance."** Vanilla has no such instinct either: a ranged monster (zombieman,
cyberdemon, ...) walks right up to the player if nothing stops it, the same as a melee one. What
stops it is real contact, not a rule: every monster and the player are solid bodies
(`World.ThingBlocker`), so a monster closes until it bumps into you. An earlier version had no
thing-vs-thing collision at all and used `MELEE_RANGE` as a stand-in "personal space" distance,
which both let monsters walk clean through each other and through the player, and — without any
stop rule at all — let a monster overshoot its target and oscillate past it. Line of sight
(`hasLineOfSight`, genuinely 3D-aware — see "Damage, monster death and player death" below for
why) gates whether an attack can land; without sight a monster keeps heading toward its target's
*actual* current position (no separate remembered last-known-position state) rather than firing
blind.

**Bodies block bodies, using vanilla's box test.** `circleBlocked`/`slideMove` (`game/world.ts`)
take an optional `blockers` list, and `blockedByThings` reproduces `PIT_CheckThing`'s overlap
check exactly: an axis-aligned **box** on the summed radii (`abs(dx) < r1+r2 && abs(dy) < r1+r2`),
not the circle test the rest of this file's collision uses, and with **no height comparison at
all** — vanilla's solid-blocking path returns before any z check, which is the well-known
"infinitely tall actors" behavior. Both deviations from the surrounding code are deliberate:
rounding the box off would change every contact range by up to ~40% on the diagonal, and adding a
height check would quietly break the map geometry that (accidentally or not) relies on the
vanilla rule. `ThingLayer.solidBodies` is the outward-facing half, handed to `Player.update` by
`game.ts`; monsters get the equivalent list built for them internally (`blockersFor`). The player
still *slides* along bodies (`slideMove`) while monsters don't, matching vanilla exactly — the
player is the one thing in DOOM that gets `P_SlideMove`, so scraping past a demon in a corridor
works, while the demon itself re-routes around you.

`blockersFor` reads a **uniform grid of living monsters** (`blockerGrid`, rebuilt once per
`ThingLayer.update`) rather than scanning every thing on the map, for the same reason vanilla has
a blockmap: the naive version is O(monsters²) per frame — fine at a stock level's population,
catastrophic past it, since NUTS.WAD's 10,696 things work out to ~114 million distance checks per
frame the moment they all wake up (measured: 690k of those pairs are real neighbours, so ~166×
of the work was wasted). Verified as returning exactly the same neighbour set as the linear scan
across all 10,696 of that map's real positions.

Four details of it are load-bearing, and each was measured — together they took monster AI on
that map from **578 ms/frame to 11 ms**:

- **The search box is sized per monster**, from `ownRadius + maxBlockerRadius + BLOCKER_MARGIN`,
  and per *pair* from the two radii actually involved. `blockedByThings` can never report an
  overlap outside `r1 + r2`, so a fixed box is guaranteed waste — and specifically the wrong
  shape of waste here, because NUTS.WAD contains 795 spider masterminds (radius 128) whose mere
  presence would otherwise widen every 20-unit grunt's search too.
- **`BLOCKER_MARGIN` is the sum of two independent maxima**, not the max of a per-type sum: the
  monster doing the probing (`tryWalk` tests a full `speed × chaseInterval` step ahead) and the
  monster that drifted since the grid was built (`speed × MAX_FRAME_DT`) are *different*
  monsters, so the worst case pairs the longest probe with the fastest other monster's drift.
- **The grid is a flat array**, not a `Map`. At ~15 cell lookups per monster per frame, `Map.get`
  on a packed numeric key cost more than everything it was guarding.
- **`PosedThing.blockRadius` is resolved once at spawn.** `MONSTER_STATS` is a `Record` with
  sparse numeric keys, so V8 backs it with a dictionary — one hash lookup per *candidate* per
  monster per frame was more expensive than the collision arithmetic.

**The same grid backs `monstersNear` and `raycastMonster`**, and neither can afford to be the
linear scan it started as, because both are called *per shot in flight*, not per frame:

- `monstersNear` runs once per airborne projectile per frame (`game.ts`'s `monsterStruckBy`,
  which re-tests every monster projectile against everything it might clip). On NUTS.WAD monsters
  launch ~29 projectiles per frame, so well over a thousand can be in the air at once — as a
  linear scan over all 10,693 things that measured 0.080 ms *per call*, i.e. over a hundred
  milliseconds a frame on its own. Grid-backed it is 0.002 ms.
- `raycastMonster` runs once per monster hitscan (~59/frame on that map): 0.071 → 0.011 ms.
  Its query is a ray rather than a box, so `forEachMonsterAlongRay` steps the ray by half a cell
  and sweeps each step's 3×3 cell neighbourhood — deliberately simpler than
  `World.forEachLineAlongSegment`'s exact DDA, and conservative by a wide margin (a full 128-unit
  cell of clearance either side against a ~24-unit hit radius). Monsters are deduped with a stamp
  on `PosedThing.queryStamp` rather than a `Set`, since consecutive steps overlap heavily.

Both were verified to return results identical to the linear scans over 2,400 queries across
NUTS.WAD, DOOM2 MAP07 and DOOM E1M7. `monstersInSector` is deliberately left linear — it runs on
a crusher tick, not per frame.

For the same reason, `game.ts` caps occlusion-fade targets at `MAX_FADE_TARGETS` (nearest first):
`WallFader`/`FlatFader` cost is quads × targets, and a map can have hundreds of monsters awake
inside `MONSTER_FADE_RANGE` at once. It's purely a cost bound — past a couple of dozen nearby
monsters, every wall any of them stands behind is already being faded by a nearer one.

**But walking and attacking are mutually exclusive: a monster plants itself for the whole length
of its attack.** This is the one part of the above vanilla genuinely enforces rather than merely
tends toward — an attack is a state sequence of its own, and `A_Chase` (the only thing that ever
calls `P_Move`) doesn't run again until that sequence ends. `AttackStats.duration` is that
sequence's summed tics over 35, read straight off `info.c`, and `MonsterBody.attackPause` holds
the monster still for exactly that long. It ranges from 0.43s (a cacodemon's bite/spit) to 2.7s
(an arch-vile), and its absence was very visible: monsters slid toward the player at full speed
while firing, so a mancubus never planted for its volley and a zombieman never stopped to raise
its pistol. What the paragraph above rules out is a monster stopping *before* it has anything to
fire — not this.

Multi-shot attacks fall out of the same field. `AttackStats.shots`/`shotInterval` reproduce the
attacks where vanilla fires several times from inside one `missilestate` rather than making a
fresh `A_Chase` decision per shot: the cyberdemon's three rockets (12 tics apart), the mancubus's
three volleys, the chaingunner's and spider mastermind's paired bullets. `AttackStats.refire` is
the extreme case — vanilla's `A_CPosRefire`/`A_SpidRefire` (chaingunner, spider mastermind,
arachnotron) jump the attack state straight back into itself and only break out when the target
stops being visible, never re-rolling `P_CheckMissileRange`. So those three plant themselves and
hose continuously for as long as they can see the player, which combined with the attack pause
above is what finally makes a chaingunner read like vanilla's rather than a strolling pea-shooter.

**A ranged attack's own firing chance falls off with distance, so a monster shoots far less often
from across a room than up close** — vanilla's `A_Chase`/`P_CheckMissileRange`, now run as the
real per-chase-call decision rather than converted into a cooldown. Three gates stand between one
shot and the next, and `runChaseCall` applies each on the same cadence vanilla does:

1. `MF_JUSTATTACKED` — the call right after an attack always re-routes instead of attacking
   ("do not attack twice in a row").
2. The **`movecount` gate**, the heavyweight: `A_Chase` refuses to even *consider* a missile
   while `movecount` is nonzero, and `P_TryWalk` reseeds it to `P_Random() & 15` (0-15) every
   time the monster commits to a direction. So a monster only gets a chance to fire roughly
   every 8-9 chase calls. Missing this entirely was the original "monsters shoot far more than
   vanilla" bug.
3. `P_CheckMissileRange`'s roll — `P_Random() < dist` *suppresses* the shot, so the fire chance
   is `(256 - dist) / 256` and shrinks with distance. A failed roll falls into `P_NewChaseDir`
   and so pays gate 2 all over again.

An intermediate version modelled 2 and 3 statistically, converting an expected attempt count into
a seconds-long cooldown, because sampling a per-attempt probability every render frame (far more
often than vanilla's own ~3-tic cadence) would resolve it almost immediately no matter how small
it is. Running the chase logic on a discrete `chaseInterval` tick removes that problem at the
source — the roll is now sampled exactly as many times as vanilla samples it, so it can just be
the roll. `AttackStats.ranged`'s `rangeFalloffScale`/`Cap` reproduce vanilla's
own per-type offset/halving/clamp (halved for exactly the types vanilla special-cases —
cyberdemon, spider mastermind, revenant, lost soul — making them noticeably more willing to fire
from far away than everything else; the cyberdemon alone gets an extra-tight 160-unit cap on
top). `MF_JUSTHIT` short-circuits all of it: a monster that just took a hit fires back
immediately, regardless of distance.

**Ranged attacks have no maximum range**, and giving them one was a mistake worth recording.
Vanilla's `P_CheckMissileRange` never rejects a shot for being too far — the falloff above is the
*whole* mechanism — and there are exactly two real distance gates in the game, both per-type and
both measured on the *offset* distance (after `P_CheckMissileRange`'s own -64/-192 subtraction,
which is where vanilla applies them): the revenant won't fire its missile inside 196 units
(`minOffsetDist`, vanilla's `MT_UNDEAD` rule — its internal name from when the revenant was
"Undead" in development), preferring to close to melee range instead of lobbing one from just
outside fist's reach, and the arch-vile won't fire beyond `14*64` = 896 (`maxOffsetDist`).
Hand-picked 1000-2400 unit caps stood in for the falloff before it was modelled properly; once
it was, all they did was make monsters stop firing at distances vanilla is perfectly willing to
shoot from. A hitscan attack otherwise reaches `WEAPON_RANGE` (vanilla's `MISSILERANGE`, 2048)
and a projectile simply flies until it hits something.

**Ranged attacks are either an instant hitscan-style bolt or a real flying projectile sprite,
matching which one vanilla actually uses per monster type** (`game/monsters.ts`'s
`AttackStats.ranged.projectile`, `game.ts`'s `spawnMonsterProjectile`/`PROJECTILE_FRAMES`/
`IMPACT_EFFECTS`). The human gunners (zombieman, shotgun guy, chaingunner, Wolfenstein SS) and
the spider mastermind really do fire vanilla hitscan bullets, so they keep the tracer (colored
red to read as "hostile", distinct from either of the player's own tracer colors); the imp
(`BAL1`), cacodemon (`BAL2`), baron/hell knight (`BAL7`), mancubus (`MANF`), arachnotron (`APLS`),
revenant (`FATB`) and cyberdemon (`MISL`, the same sprite the player's own rocket launcher uses)
throw a real projectile instead, sprite names and frame counts confirmed by dumping the actual
`DOOM2.WAD` sprite lumps and cross-checked against `linuxdoom-1.10`'s `info.c` mobjinfo/state
tables rather than assumed — including the mancubus's genuine vanilla oddity of exploding with
the *rocket's* `MISL` frames instead of any dedicated art of its own (`MANF` has no explosion
frames in the WAD at all). The pain elemental and arch-vile stay on the hitscan-tracer stand-in
despite not matching vanilla exactly, and the revenant's missile flies straight rather than
homing — see `MONSTER_STATS`'s doc for why each of those specific gaps was left alone rather than
built out further. A monster projectile reuses the same `Projectile`/`updateProjectiles` machinery
the player's own rocket/plasma/BFG shots already use, distinguished by a non-null `sourceId`
(vanilla's own doomednum tags along as `sourceType`, for the species check below): it's still
launched via `shotPath` exactly like a player's locked-on shot (stopped early only by a real
wall), aimed at whichever target the monster actually fired at — the player, or another monster
if this is an infight (`atk.targetId`, resolved live via `ThingLayer.monsterById` rather than
trusted from launch time). Unlike a player's shot — whose target (a monster) never moves
mid-flight — its arrival is re-checked every frame against both the player's *live* position
(`MONSTER_PROJECTILE_HIT_RADIUS`/`_HEIGHT`) and every other living monster it might clip along the
way (`monsterStruckBy`, `sameSpecies`-gated the same as a hitscan bolt), not just the wall-stop
distance computed at launch, so stepping behind cover or outrunning a slower fireball after it's
already fired actually works — for whoever it's flying at. Damage dice are the one
thing here still tuned for feel/balance rather than lifted from vanilla's per-monster tables (see
the timing note at the top of this section for why they're the exception, not the rule) — so a
monster's *rhythm* is vanilla's while its bite is deliberately softer.

**Monsters fight each other**, and the mechanism is exactly vanilla's: nothing about being hurt
is player-specific. `ThingLayer.damage` takes an optional `source`, and a monster hit by another
monster re-points its `targetId` at the attacker (`monsters.ts: shouldRetarget`/`commitTarget`);
`stepMonsterAI` takes a plain `target` position and never learns whether it's chasing the player
or a baron. `game.ts` is where a shot finds out who it hit — `resolveMonsterHitscan` traces the
bolt and damages the first body along it (vanilla's `PTR_ShootTraverse` has no notion of an
intended target and no species check whatsoever, which is why one zombieman firing past another
starts a fight), and `monsterStruckBy` does the same per frame for a projectile in flight.

Three vanilla rules keep that from degenerating, all reproduced:
- **A committed monster ignores new attackers** for `BASE_THRESHOLD` (100) chase calls
  (`MonsterBody.threshold`, vanilla's own). Without it a brawl in a crowded room turns into
  everyone spinning to face the last stray hit and nobody landing a second blow.
- **Nothing ever retaliates against an arch-vile**, and an arch-vile re-targets even while
  committed — vanilla singles out `MT_VILE` in both directions of the rule, so its
  resurrect/flame behavior can't start a fight with the monsters it is meant to be helping.
- **A projectile passes harmlessly through the shooter's own species** (`sameSpecies`, vanilla's
  `PIT_CheckThing` rule), with baron and hell knight counting as one species in both directions —
  vanilla's single hardcoded cross-type pairing. A pack of imps can therefore throw fireballs
  across each other all day without infighting, while one imp fireball landing on a demon
  absolutely does start something. Note this applies to **projectiles only**: hitscan attacks
  have no species check in vanilla at all, so zombiemen really do gun each other down.

A target that dies hands the monster's attention straight back to the player (`resolveTarget`),
matching vanilla's `A_Chase`, which falls back to `P_LookForPlayers` once `target->health <= 0`.

**The lost soul is the third kind of attack: it throws itself.** Vanilla's `A_SkullAttack` gives
it no projectile at all — it sets `MF_SKULLFLY` and launches the monster along its own facing at
`SKULLSPEED` (20 units/tic, 700 units/sec), dealing contact damage through `PIT_CheckThing` when
it reaches the target and clearing the flag on any blocked move. `AttackStats.charge` plus
`stepCharge` (`game/monsters.ts`) reproduces that, and it's the reason the lost soul can carry
vanilla's real chase speed — 46.7 units/sec, by far the slowest in the game, less than a fifth of
a walking player. Modelling it as an ordinary fast melee walker (which is what an eyeballed
260 units/sec amounted to) got the threat roughly right by getting both halves wrong; with the
charge in place the vanilla numbers work, because a lost soul is meant to drift harmlessly and
then commit. `stepCharge` is deliberately the one movement in this file that doesn't use
`slideMove`: a charge that rounded corners would home in on the player, and being able to
sidestep a committed lost soul is the whole reason the attack is fair.

**`painChance` is vanilla's `mobjinfo.painchance` over 256 exactly, and `painDuration` its
`painstate` chain's tics over 35.** Both are plain constants in the same table `MONSTER_HEALTH`
already lifts from, so there was never anything to convert; an earlier eyeballed set had the imp
and demon shrugging off roughly half the hits that stagger them in vanilla, and flattened pain
length to one shared value where vanilla ranges from 4 tics (imp, demon, baron barely flinch) to
12 (cacodemon, pain elemental recoil visibly). A stagger also *aborts* whatever attack was under
way rather than letting it resume — including the unfired shots of a volley — matching vanilla's
pain state replacing the attack state outright.

**Animation reuses the walk-cycle convention (`A`-`D`, held on `A` while idle) `PLAY`'s own idle
sprite already established**, rather than inventing dedicated attack/pain frame art: unlike the
death frames (`MONSTER_DEATH_FRAMES`), which are derivable straight from the WAD because death
art is structurally the rotation-0-only tail of a sprite's frame set, attack and pain frames are
ordinary rotation 1-8 frames indistinguishable from walk frames by structure alone — the split
is only known from vanilla's own (well-documented, but not WAD-derivable) `info.c` state tables.
Guessing specific letters risked silently wrong art the same way `SpriteActor`'s own doc already
argues against for monster idle animation; a fired ranged attack's tracer is the actual
"it's attacking" visual cue instead.

### Damage, monster death and player death (`src/game/thingdefs.ts`, `src/game/things.ts`, `src/game/inventory.ts`, `src/game/world.ts: hasLineOfSight`, `src/game.ts`)

Shots, explosions and — now that monster AI exists (see above) — monster melee/ranged attacks
all hurt and kill. The other source of player damage that isn't a weapon at all is
crushers/crushing floors/crushing stairs (see "Crushers and teleporters" below).

**A shot deals direct damage two different ways, depending on whether one was locked on.** A
locked-on shot (a monster was under the cursor when it fired) resolves hit-or-miss against that
exact target: `game.ts`'s `spawnShot` compares `shotPath`'s returned distance against the
straight-line distance to the target to know whether something (a wall) cut the shot short
before it got there. A *free* shot (nothing under the cursor) instead tests its straight flight
path against every monster's body — `ThingLayer.raycastMonster` — the way any real hitscan or
projectile trace would, so a monster standing between the player and a wall they're shooting at
still gets hit even though it was never clicked; only the nearer of "a wall/step" (`shotPath`)
and "a monster in the way" (`raycastMonster`) actually stops the shot. `raycastMonster` tests a
single approximate hitbox (`MONSTER_HIT_RADIUS`/`_HEIGHT` in `game/things.ts`) rather than
each monster's real, and quite varied (16-128 units), vanilla radius — modelling that accurately
would need a whole per-species size table for a check this approximate to begin with. Either way,
for a hitscan pellet damage is applied immediately (an instant line has no travel time to wait
out); for a projectile it's carried on the `Projectile` object and applied in `updateProjectiles`
once the sprite visually reaches its (possibly shot-short-by-a-monster) `maxDist` — monster
positions never change mid-flight (no AI), so resolving hit/miss at launch and only *applying* it
on arrival is safe and doesn't need a second raycast.

**Splash damage is separate from a direct hit, and reaches everyone nearby regardless of what
(if anything) was targeted** — a rocket or BFG shot fired at a bare wall still explodes and can
still hurt a monster standing close by, matching vanilla. `game.ts`'s `applyRadiusDamage` walks
every living monster `ThingLayer.monstersNear` returns within the blast radius, skips anyone
`hasLineOfSight` (`game/world.ts`, a straight-line reuse of the sight-blocking test `FogOfWar`
uses for reveal — not `shotPath`, which models a directed weapon's own blocking rules, not "does
this omnidirectional blast reach that point") says is blocked by a wall, and applies damage
falling off linearly to 0 at the radius edge, matching vanilla's own `P_RadiusAttack`.

**`hasLineOfSight` also checks floor/ceiling, not just walls** — without this, a monster standing
in a room genuinely *underneath* a ledge the player is standing on — with no shared two-sided line
anywhere near the straight 2D path between them, since the floor is what separates them, not a
wall — registered as fully visible (and shootable) purely because the line-crossing test never
found anything to block: a monster that chased around to end up under a ledge could keep hitting
the player through the floor even after losing any real sightline. Every caller (monster AI's
`canSee`/`tryWake`, `applyRadiusDamage` above) passes real heights rather than the flat
`MONSTER_ENGAGE_HEIGHT` guess an earlier version used in `stepMonsterAI`'s `canSee` — now redundant
and removed, since a proper 3D sight check makes a separate flat vertical cap both unnecessary and,
for a genuinely tall open room, wrong (vanilla itself has no such cap at all).

**The floor/ceiling check is a sight *wedge* from a fixed eye height, matching vanilla's own
`P_CheckSight` (`sightzstart`/`topslope`/`bottomslope`) — not a straight line interpolated from
`z1` to `z2`.** An earlier version did exactly that: sampled points along the path
(`SIGHT_HEIGHT_SAMPLE_STEP`) and rejected if the straight line's own height at any sample, linearly
interpolated between the two *feet* heights, fell outside that sample's sector's floor..ceiling
range. That's wrong the moment the two ends stand at different floor heights, which is most of the
time in a real level: a monster on a raised platform and the player one step below it, in an
otherwise completely open room, produces a line that dips below the *platform's own floor* almost
immediately — it's heading toward the lower end over the *entire* distance, not just at the actual
step — so the platform's own floor was misreported as blocking sight to the monster standing on it.
Confirmed as a real, shipped bug against DOOM.WAD's E1M1: a pair of zombiemen one step up on a
24-unit platform never woke no matter how long the player stood in plain view of them. `SIGHT_EYE_HEIGHT`
(`3/4` of `PLAYER_HEIGHT`, vanilla's own fraction — this engine has no per-species heights to draw
on, so both ends reuse the player's) fixes the origin at `z1 + SIGHT_EYE_HEIGHT` instead of sliding
it toward `z2`, and narrows `[bottomSlope, topSlope]` against each sampled sector's floor/ceiling
the way vanilla narrows its wedge crossing each line's opening — the target bound uses the full
`[z2, z2 + PLAYER_HEIGHT]` span (feet to head) rather than a single point, so any part of that range
clearing every sampled opening is enough, same as vanilla. This is still a coarser stand-in for the
real thing — vanilla walks the BSP and narrows the wedge at every actual line crossing, this samples
discrete points along the path instead — but the *shape* of the check now matches vanilla's, which
is what the ordinary-step case needed.

**`hasLineOfSight` is the most performance-sensitive query in the engine**, and two things keep it
affordable. Both were verified to produce **bit-identical results** to the straightforward version
across 21,240 sightline pairs on six maps (DOOM2 MAP01/03/07, DOOM E1M1/E1M7, NUTS.WAD) — this is
pure optimization, not an approximation traded for speed:

- **Wall candidates come from `World.forEachLineAlongSegment`, not `linesNear`.** `linesNear`
  takes a *radius*, so covering a sightline with it means a box half the line's length on a
  side — O(dist²) grid cells to test a thin segment. Walking only the cells the segment actually
  crosses is O(dist), and is sound because `buildGrid` buckets each line into every cell its
  bounding box touches: if a line genuinely crosses the segment, their intersection lies in a
  cell that both pass through. On NUTS.WAD (median sightline ~4400 units, p90 ~11700) the box
  query scanned up to ~8300 cells where the segment crosses ~90, and this one change took
  `hasLineOfSight` across that map's monsters from **164 ms/frame to 8.7 ms**.
- **`SIGHT_MAX_HEIGHT_SAMPLES` caps the floor/ceiling sampling** so the step stretches past
  `SIGHT_HEIGHT_SAMPLE_STEP` instead of the sample count growing without bound. 32 is chosen so
  nothing within `WEAPON_RANGE` (2048, vanilla's `MISSILERANGE`, and the furthest anything here
  can shoot) changes at all — 2048/64 is exactly 32 — while a monster 12,000 units away stops
  costing ~180 BSP walks per frame to answer a question no attack could act on.

Relatedly, `stepMonsterAI` resolves sight **lazily, at most once per call**: it's only consumed by
the refire loop and by `runChaseCall`, and the chase call is quantized to `chaseInterval`
(~0.11-0.29s) while `stepMonsterAI` itself runs every rendered frame — so evaluating it eagerly
threw the answer away most frames. Vanilla has the same structure for the same reason,
`P_CheckSight` being called from inside `A_Chase` rather than once per tic per thinker.

Both `forEachLineAlongSegment` and the lazy accessor exist because these run thousands of times a
frame: the segment walk dedupes through a per-linedef stamp array rather than allocating a `Set`
and spreading it per call, the way `linesNear` does. (An equivalent allocation-free `linesNear`
for the *collision* callers was tried and measured as **no faster** — the callback makes that call
site megamorphic and costs the early-out — so `groundFloor`/`dropoffFloor`/`circleBlocked`
deliberately still use the plain array-returning `linesNear`. Don't "fix" that without measuring.)

**A rocket that explodes against a wall sits its own impact point exactly on that wall**, which
broke splash to everyone else the instant it happened: a raw segment-intersection test between
the blast and a nearby monster reports the ray blocked by the very wall it started on (the ray's
own origin is a valid crossing point, at parameter `t≈0`), so `hasLineOfSight` said "blocked" in
every direction, including straight out into the open room the explosion plainly sits in — splash
only ever worked when a shot connected directly with a monster (out in open space, never exactly
on a wall) and never when it hit geometry instead, which for a *free* shot is the common case.
`SELF_HIT_MARGIN` skips a crossing within 1 unit of the ray's own start, the same "nudge off the
geometry you're standing on" idea `WALL_OVERLAP`/`BLOCKER_OVERLAP` already use elsewhere — just
applied to the ray's near end instead of extending its target. The tradeoff: a rocket that
explodes directly against a *closed door* could in principle leak a sliver of splash through to
whatever's just beyond it, since the door's own self-hit is now the one crossing being ignored —
accepted as the same order of approximation those other margins already are, in exchange for
splash actually working at all against ordinary walls.

**A splash's radius and damage are a fixed pair on the weapon, independent of that shot's own
random direct-hit roll** — `WeaponDef.splash` (`game/weapons.ts`), not derived from
`damageDiceSides`/`Multiplier` the way an earlier version of this wrongly assumed. Vanilla's
rocket explosion (`A_Explode`) really does pass a constant 128/128 to `P_RadiusAttack`, entirely
separate from the missile's own `(P_Random()%8+1)*20` contact-damage roll used for a direct hit;
conflating the two made splash swing with the same small, unreliable random roll as contact
damage, when vanilla's is always a reliable, fixed 128 units.

**`hitsPlayer` gates whether a splash can hurt the player who fired it, and it's the fix for a
BFG kill also killing the player standing merely "near" the monster it killed.** The rocket sets
it `true` — vanilla really does let a rocket's own blast hurt whoever fired it (the classic
"rocket jump" self-damage), so `applyRadiusDamage` includes the player as a splash candidate the
same as any monster. The BFG sets it `false`: vanilla's BFG ball never calls `A_Explode` at all —
its real damage is the "spray" mechanic (`A_BFGSpray`), 40 individually autoaimed hitscans fired
*from* the shooter at nearby visible things, which by construction can never land back on the
shooter itself. Implementing that spray exactly is far more code than this milestone justifies,
so it's approximated as a plain radius splash instead (bigger than the rocket's, to feel
appropriately devastating for its 40-cell cost) — but `hitsPlayer: false` is what keeps that
approximation from introducing damage vanilla's own BFG could never actually deal.

**`tracers` (also `WeaponDef.splash`, true only for the BFG) draws a thin green line from the
impact to every monster that splash actually damaged**, reusing `render/tracer.ts`'s `Tracer` —
the exact same primitive a hitscan weapon's own tracer already is, just a different color
(`BFG_TRACER_COLOR`) to read as "spray," not "bullet." This isn't vanilla — vanilla's real spray
rays are pure math, never rendered — but the approximated splash above was otherwise completely
invisible: nothing on screen showed *which* nearby monsters the blast actually caught, unlike a
locked hitscan/projectile hit, which always draws something. Giving the BFG's own approximation
the same "show what a shot hit" treatment this engine already uses everywhere else was a more
consistent fix than leaving it silent. The rocket leaves `tracers` off; its explosion sprite is
already vanilla's whole visual for what it hit.

Self-splash, crush damage (see "Crushers and teleporters" below) and monster melee/ranged
attacks (see "Monster AI" above) are the paths through which the player takes damage. Per-weapon
direct-hit damage rolls follow vanilla's own `((rand % sides) + 1) * multiplier` shape and are
lifted rather than tuned by feel, the same reasoning ammo-per-shot already used — they decide how
tough a fight actually is.

**Monster health and death-frame sequences are confirmed against the actual lump names in
DOOM.WAD/DOOM2.WAD**, not guessed, the same rigor as `THING_SPRITES`/`TFOG`/rocket-sprite fixes
elsewhere in this file. Health values themselves aren't in the WAD (they're vanilla's own
`mobjinfo` constants), but the death *frame letters* are derivable from the WAD directly: death
art in vanilla is rotation-0 (omnidirectional) only, so the point where a sprite's directional
(rotation 1-8) frames stop and its rotation-0 tail begins marks exactly where movement/attack/
pain art ends and death art starts — confirmed by dumping every monster sprite's frame/rotation
pairs from the real IWADs and cross-checking the resulting counts against known vanilla death-
state counts (e.g. POSS's rotation-0 tail is 14 letters long, split 5 DIE + 9 XDIE, matching
vanilla's zombieman exactly). `game/thingdefs.ts`'s `MONSTER_DEATH_FRAMES` takes the DIE (front)
half of that tail; `MONSTER_XDEATH_FRAMES` takes the XDIE (gib, back) half where one exists at
all — only five monster types in stock DOOM actually have gib art (the human grunts and the
imp), everything else, including similarly-sized monsters like the demon, simply has no
`xdeathstate` in vanilla and always plays its plain death regardless of overkill. `ThingLayer.
damage` picks between the two exactly the way vanilla's `P_KillMobj` does: gib only if the
killing blow pushed health below *minus* the monster's own max health (`MONSTER_HEALTH`) *and*
gib art actually exists for that type — otherwise the plain death, same as vanilla falling back
when a type has no `xdeathstate` regardless of how far past 0 the health went. Commander Keen (a
pain-cascade "death" with no distinct DIE state) and the boss brain (2 sprite frames total, no
death art at all) are deliberately absent from both tables — `ThingLayer.damage` falls back to
just hiding a killed monster with no entry there, same as an unrecognized lump elsewhere in the
renderer.

A monster's death is a permanent, one-way animation switch, not a new actor: `SpriteActor.die`
overrides the normal alive walk-cycle with a one-shot sequence that advances forward and holds
on its last frame forever, reusing the same mesh/materials rather than spawning a second object
to swap in — cheaper, and it means a corpse still participates in fog-of-war fading exactly like
it did alive. `ThingLayer.damage(id, amount)` — `id` being the stable index `pickMonster`/
`monstersNear` hand back — subtracts health and calls `die` once it reaches 0; `pickMonster`
skips anything already dead so a corpse can't be re-targeted.

**A killed monster can drop an item, lifted straight from vanilla's `P_KillMobj`** — which has
exactly three `switch` cases, so only three monster types actually drop anything at all: the
zombieman and Wolfenstein SS both drop a clip, the shotgun guy a shotgun, the chaingunner a
chaingun (`game/thingdefs.ts`'s `MONSTER_DROPS`). Everything else, including monsters that feel
like they obviously should (the imp, the demon), drops nothing in vanilla and doesn't here
either. `ThingLayer.damage` spawns the drop itself, inline, the moment it marks a monster dead —
via a `spawnDrop` helper that's just the same pose/push the initial map-load loop does, for one
instance instead of every map THING — so a drop appears no matter *how* the kill happened (direct
hit, splash, gib, or even a crusher via `monstersInSector`/`onCrush`), matching vanilla, which
drops from that same one `P_KillMobj` regardless of cause. Each `PosedThing` carries its own
`dropped` flag, seeded `true` only for a `spawnDrop`-spawned instance and threaded through
`tryPickup`'s `consume` callback into `Inventory.applyPickup`'s own `dropped` param — vanilla's
`P_GiveAmmo`/`P_GiveWeapon` give a dropped pickup's ammo at exactly half the rate of a map-placed
one (a dropped clip's 5 bullets vs. a map one's 10; a dropped shotgun's 4 shells vs. a map one's
8), and `applyPickup` reproduces that halving precisely rather than treating every clip/shotgun/
chaingun pickup identically regardless of where it came from.

**The player's own death reuses the exact same mechanism** on `game.ts`'s single persistent
`playerActor`: `PLAYER_DEATH_FRAMES` (`H`-`N`) is `PLAY`'s own confirmed DIE half, the same way
monster tables were derived. `Inventory.applyDamage` (`game/inventory.ts`) is vanilla's own
`P_DamageMobj` armor formula — green armor absorbs a third of the damage, blue half, spending
armor points 1-for-1 with whatever it absorbed and falling back to bare once it runs out
mid-hit — reused for the player specifically since monsters have no armor to absorb anything.
Health hitting 0 sets `Game.playerDead`, which freezes movement/aim/firing/pickups in `frame`
(fog of war, effects, faders and rendering all keep ticking — a rocket already in flight when
the player dies still lands and can still deal splash) and shows a `#death-overlay` div. `R`
calls `restart`: a fresh `Inventory` and a `loadMapByIndex` reload of the current map, which
already resets the player/world/specials/fog for a normal level transition and, via its own
top-of-function reset, `playerDead`/the overlay/`playerActor`'s animation state too — restart
isn't a special case, just the ordinary map-load path with a clean inventory.

### Crushers and teleporters (`src/wad/specials.ts`, `src/game/specials.ts`, `src/game.ts`)

The vanilla-only line special table (doors/lifts/floors above, plus these two) is confirmed
against the Doom wiki's linedef type table rather than assumed, after a first pass briefly (and
wrongly) listed 174 as a vanilla S1 teleport — it's Boom-only. Same story for crusher stop: 58
looks like it could be a third stop-crusher alongside 57/74, but is an unrelated "floor up 24"
special.

**Crushers** (start: 6/25/49/73/77/141, stop: 57/74) are pure ceiling geometry — repeatedly
lower to floor+8, reverse, return to the sector's *own* start height (not neighbor-derived, unlike
a door's open height), forever, with no hold/rest state in between. They (and the vanilla
`raiseFloorCrush` floor family — 55/56/65/94) now deal `CRUSH_DAMAGE` every
`CRUSH_DAMAGE_INTERVAL` (vanilla's own 10 HP every 4 tics) to the player or any monster standing
in their sector, via `SpecialsController`'s `onCrush` callback into `game.ts: applyCrushDamage` —
the same callback-into-game.ts pattern as `onExit`/`onTeleport`, since `SpecialsController`
mutates geometry but has no idea where anyone is standing. `ThingLayer.monstersInSector` finds
monster candidates by comparing against the exact same mutable `Sector` object reference
`PosedThing.sector` was seeded from, the same trick `tryPickup`'s live-height read already relies
on. The turbo-16 stair specials (100/127) are deliberately *not* included, even though the Doom
wiki names them "...and Crush" — the actual vanilla `EV_BuildStairs` source (p_floor.c) never
sets a crush flag on the floor movers it spawns, so real vanilla turbo stairs don't crush either;
caught by checking the source directly after the wiki's naming turned out misleading, same
discipline as the 174/58/40 catches elsewhere in this file. This is a real behavior gap from vanilla,
noted deliberately rather than missed: nothing here actually *blocks* a mover on contact (no
thing/mover collision check exists), so a crusher never stops, reverses early, or gets "stuck" —
it just keeps hurting whoever's in the way every interval until they leave or die, which is the
part of the vanilla feel that actually matters for a crusher reading as a hazard.

**Teleporters** (39/97 for either the player or a monster; Doom II's 125/126 for monsters only).
The destination is the first doomednum-14 landing thing found inside a tag-matched sector
(`SpecialsController.findTeleportDestination`); reaching it calls back into `game.ts` to move the
player (`Player.teleportTo`) and snap the camera yaw to match, the same as the initial spawn.

**Monsters cross walk triggers too**, via `SpecialsController.crossMonster` — `ThingLayer` keeps
each monster's own `prevX`/`prevY` and hands the segment it just walked to a `crossLines`
callback, the same "system reports, `game.ts` realizes" shape as `fogAlphaOf` and the crush
callback. Vanilla runs `P_CrossSpecialLine` for *any* thing, not just the player, but gates
non-players to a very short allow-list, reproduced verbatim as `MONSTER_CROSSABLE`: 39/97/125/126
(teleports), 4 (raise door) and 10/88 (the two down-wait-up-stay lifts). Everything else — exit
lines, stair builders, most doors and floors — does nothing under a monster's feet, which is why
a level's monsters can't wander around rearranging its geometry. 125/126 are the monster-only
pair: vanilla lists them *only* in the non-player branch, so a player walking one does nothing at
all, which is what makes the classic monster-closet setup work (a pack behind a line only they
can trigger, teleporting into the arena the moment they start chasing). A monster's teleport
deliberately does **not** touch `lastTeleport` — that exists solely to reseed the *player's* own
walk-trigger tracking (see its doc), and where a monster jumped to says nothing about where the
player just walked — but it does get the same `TFOG` puff at both ends, since vanilla spawns that
for any thing that teleports.

Teleporting moves the player an arbitrary distance in a single frame, which breaks
`SpecialsController`'s own walk-trigger detection: it tracks `prevX`/`prevY` to know what segment
the player just crossed, and naively leaving those at the pre-teleport position would make the
very next frame test a segment from the old spot all the way to the teleport pad — long enough to
cross, and wrongly re-trigger, unrelated lines along the way. `lastTeleport` is set once inside
`trigger` and consumed at the end of `update` to reseed `prevX`/`prevY` from the destination
instead.

Vanilla also spawns a one-shot `MT_TFOG` fog puff at both ends of a teleport (where the player
stood, and 20 units ahead of the landing spot along the direction it faces). That isn't a real
map `Thing`, so it isn't modeled through `ThingLayer` — `game.ts` owns a small list of transient
`SpriteActor`s instead, each playing through the `TFOG` sprite's frames (`A`-`J`, confirmed
against the actual lump names in `DOOM.WAD`/`DOOM2.WAD` — all rotation-0, i.e. omnidirectional,
so no facing logic is needed) once before removing itself. Map transitions clear any still-active
puffs explicitly, the same way `built.group`/`things.group` are torn down, since a teleport onto
an exit line could otherwise cut an animation short and leave its plane glued into the next
level's scene.

### One-way ceiling movers, delayed doors, instant light changes, and the donut (`src/wad/specials.ts`, `src/game/specials.ts`)

The remaining vanilla line/sector specials this table didn't originally cover, closed out in one
pass by auditing `linuxdoom-1.10`'s `p_floor.c`/`p_ceilng.c`/`p_doors.c`/`p_lights.c` directly
against this table's keys rather than assumed — the same discipline the rest of this file already
holds itself to.

**A ceiling can now move on its own** (`CeilingEffect`/`CeilingMover`), separately from a door's
ceiling raise or a crusher's repeating cycle: it moves once to a target and stops, no hold, no
reversal. Special 40 ("RaiseCeilingLowerFloor") is the one vanilla case that needs it —
`raiseToHighest`, to the highest neighboring ceiling — but **this engine deliberately only
implements 40's ceiling half**, because real vanilla's own floor half never actually runs. Tracing
`EV_DoCeiling`/`EV_DoFloor`'s own source: both guard on the same per-sector `specialdata` "already
busy" pointer, `case 40`'s handler calls `EV_DoCeiling` before `EV_DoFloor`, and since they target
the exact same tag-matched sectors, `EV_DoCeiling` claims `specialdata` first — so by the time
`EV_DoFloor` runs, every one of those sectors is already busy and it does nothing, every time, in
real vanilla. Special 44/72 ("Ceiling Crush", `lowerAndCrush`) is the other user of
`CeilingMover`, lowering once to floor+8 and stopping — and despite the name, confirmed against
`p_ceilng.c` that it **never actually deals crush damage**: `EV_DoCeiling`'s `switch` sets
`ceiling->crush = true` only for the *cyclic* crush types (`crushAndRaise` family) and
`lowerAndCrush` is a separate `case` label positioned just past that assignment, so jumping to it
directly skips setting the flag — `ceiling->crush` stays at its default `false`. `CeilingMover`
has no crush/damage handling at all as a result; there's no real vanilla case that would ever
need it.

**`raiseToTexture` (30/96) and `lowerAndChange` (37/84)** are both plain `FloorMover`s under the
hood, just with trigger-time logic too specific to fit the neighbor-height `MoveTarget` model
every other floor family uses (`SpecialsController.triggerRaiseToTexture`/`triggerLowerAndChange`).
`raiseToTexture` rises by the shortest bottom-texture pixel height found among the sector's
neighboring two-sided lines — checking *both* sidedefs of each line, not just the far side,
confirmed against `p_floor.c` — resolved via `MaterialBank.textureHeight`, which decodes (and,
same as every other texture lookup, caches) the full bitmap just for its height; firing rarely
enough that this isn't worth a second, header-only lookup path. `lowerAndChange` searches the
sector's own two-sided neighbors for the first one whose floor already sits exactly at the
destination height, and copies *that* neighbor's floor texture and `special` — a different
texture-source rule from the existing `changeTexture` family (which always copies the triggering
*line's* own front sector) — and, confirmed against `T_MoveFloor`, applies it only once the mover
actually **arrives**, not at trigger time. `FloorMover.arrivalTexture` carries that (texture,
special) pair from trigger time to whichever tick flips `state` to `'done'`.

**Delayed doors** cover two different vanilla mechanisms that both boil down to "wait, then move
once, unprompted." Line specials 16/76 (`DoorMode: 'closeThenOpen'`) close immediately, wait
`DOOR_CLOSE_WAIT_SECONDS` (30s) at the bottom, then reopen once to wherever they already were —
confirmed against `p_doors.c`: `door->topheight = sec->ceilingheight` at trigger time, unlike
every other `DoorMode` here, which always computes a fresh neighbor-ceiling target — and stay open
for good after that. Sector types 10/14 (`SECTOR_DOOR_SPECIALS`) skip the trigger entirely: a
`DoorMover` is spawned straight into `SpecialsController`'s constructor the moment the map loads,
assumed already open (10, closes once after 30s and stays shut) or already closed (14, opens once
after `DOOR_RAISE_WAIT_SECONDS` = 5 minutes, then runs one ordinary open-wait-close cycle and
settles shut for good, since nothing ever re-triggers it). Both reuse existing `DoorState`s rather
than needing their own: 10 is seeded straight into `'hold'` (already exactly "wait, then lower,
then stop"), 14 into a new `'holdClosed'` state — the wait-at-the-*bottom* mirror of `'hold'`,
which `16/76`'s post-close wait also uses — that transitions to `'raising'` once its timer expires.

**Instant/switch-triggered light changes** (`LightChangeEffect`) are the runtime-triggered
counterpart to the sector-type blink patterns already documented under "Fog of war"'s neighbor —
`sector.special` assigns an ongoing pattern once at map load, these mutate (or start animating) a
*tag-matched* sector's light on demand instead. `'setLevel'` (13/35/79/81/138/139) is a literal
light value; `'brightestNeighbor'` (12/80) is vanilla's own "bright = 0 means search" rule — the
max level among immediate two-sided neighbors, or pitch black if there are none, confirmed against
`EV_LightTurnOn`; `'darkestNeighbor'` (104, `EV_TurnTagLightsOff`) is the min of the sector's own
*current* level and its neighbors', which — unlike `'brightestNeighbor'` — never brightens a
sector, only ever darkens or leaves it unchanged; `'startStrobe'` (17, `EV_StartLightStrobing`)
spawns the same slow, non-synced `blink1` pattern a sector-type-3 sector gets at map load, skipped
if the sector already has an active mover (vanilla's own `specialdata` guard — light thinkers and
movers share that one slot in real vanilla, this engine's own `lightStates`/`movers` maps are
already independent, but the *trigger* still respects the same guard vanilla's own function does).
Because any of these can now target a sector that was never a light-pattern sector to begin with,
`indexLightGeometry` — previously scoped to just the load-time blink sectors — now indexes every
sector's static-batch occluders/flats unconditionally, a one-time load cost. Still static-batch
only, the same pre-existing limitation the blink-pattern feature already had: a sector that's also
a mover has its geometry in its own per-mover mesh, out of `recolorSector`'s reach either way.

**The donut** (special 9, `DonutEffect`) is vanilla's `EV_DoDonut`: the tagged sector (the "hole")
lowers while a second sector surrounding it (the "ring") rises, both toward a *third*, outer
sector's floor height, with the ring additionally taking that outer sector's floor texture on
arrival (the same deferred-copy mechanism as `lowerAndChange`, `arrivalTexture`). Neither the ring
nor the outer sector is tag-matched — both are discovered dynamically by walking neighbors outward
from the hole (`SpecialsController.triggerDonut`/`neighborSectorIndices`, and mirrored at map-load
time in `computeMovableSectors` so the ring's own geometry is correctly pulled out of the static
batch too), which is exactly as arbitrary as vanilla's own search (whichever neighbor happens to
be first in the sector's own line list — reproduced here by walking `map.linedefs` in ascending
index order, matching vanilla's own `P_GroupLines`, which builds `sector->lines[]` the same way).
One vanilla wrinkle is deliberately *not* reproduced: the real `EV_DoDonut` excludes "the line
leading back to the hole" from the ring's own outer search via `!s2->lines[i]->flags &
ML_TWOSIDED`, which — due to C operator precedence (`!` binds tighter than `&`) — always evaluates
to zero, so that half of the check is dead code and real vanilla's own two-sidedness filtering
silently never fires. This engine does the two-sided check *correctly* instead, since blindly
porting the bug risks dereferencing a one-sided line's absent back sector — a real crash for a
special this rare not to be worth reproducing. Checked against the two real donut sectors in the
shipped IWADs (E1M2 tag 8, E2M2 tag 1; `DOOM2.WAD` has none) — both resolve to sane, non-degenerate
ring/outer sectors.

### Damage floors and scrolling textures (`src/wad/specials.ts`, `src/game.ts`, `src/render/occlusion.ts`)

The last two vanilla mechanisms this table's own header comment used to call out-of-scope, both
outside `LINE_SPECIALS`'s trigger/mover model entirely — one because it's driven by the player's
position rather than a trigger, the other because it's a continuous cosmetic animation with no
trigger at all.

**Damage floors** (`SECTOR_DAMAGE_SPECIALS`) are vanilla's `P_PlayerInSpecialSector` — nukage (7,
5 HP), hellslime (5, 10 HP), super hellslime (16, 20 HP) and strobe-hurt (4, 20 HP), all every
`DAMAGE_FLOOR_INTERVAL`, plus E1M8's finale special (11, 20 HP, and ends the level once it drops
the player to 10 HP or below — vanilla's own inline `G_ExitLevel()` call in that same switch case).
Player-only, matching vanilla, which passes a `player_t*` and never damages monsters this way.
Dealt directly in `game.ts: updateDamageFloor` rather than through `SpecialsController` — a damage
floor has no mover, nothing for `SpecialsController`'s machinery to own, just `sector.special` plus
the player's live position, so it's checked once a frame straight off `World.sectorAt`. Gated on
`player.z === sector.floorHeight` (vanilla's `mo->z != sector->floorheight` guard, skipping a
player still falling into the sector) — deliberately the *local* 2D-position sector's own floor,
not `World.groundFloor` (which reads a straddled ledge's higher side), so standing on a ledge next
to a damage pit doesn't damage the player until they actually step down into it. Special 4
("STROBE FAST/DEATH SLIME") is *also* one of the sector-type light-blink specials
(`SECTOR_LIGHT_SPECIALS`) — vanilla spawns the same non-synced fast strobe sector type 2 gets and
then explicitly restores `sector->special = 4` afterward so the damage check still sees it; this
engine never clears `sector.special` after seeding a light pattern in the first place, so 4 living
in both tables "just works" without needing to reproduce that restore step. A radiation suit
gates the damage per type (`DamageFloorEffect.suit`, `game.ts: suitBlocks`) exactly the way
vanilla's own `P_PlayerInSpecialSector` does — see "Powerups and the backpack" above for why
the five types don't all treat it the same.

**Scrolling textures** (`SCROLL_LINE_SPECIAL` = 48, `render/occlusion.ts: TextureScroller`) are
vanilla's `P_UpdateSpecials`: a linedef with this special scrolls its front sidedef's texture
35 map-units/second (`FRACUNIT`/tic), forever, no trigger, active from the moment the map loads —
used surprisingly often in the stock IWADs (250 linedefs across both games, not a rare effect) for
waterfalls, lava streams and conveyor-look walls. Mechanically the same shape as
`WallFader`/`FlatFader`: index the affected quads' vertex ranges once, rewrite one attribute on
them every frame — here the `uv` attribute's U component instead of vertex-alpha, computed from
each quad's own texture width (`MaterialBank.size`) so a narrow texture's pattern visibly cycles
faster than a wide one for the same 35 units/sec, matching vanilla's own offset-over-width UV math.
`WallOccluder` gained `line`/`frontSide` fields (threaded through `mapmesh.ts`'s `processLine`/
`addTwoSidedSide`/`addWall`) so `TextureScroller` can find exactly the linedef's *front* (vanilla's
`sidenum[0]`) quad — the only side vanilla ever scrolls — among the batched geometry. **Static-batch
geometry only**, the same pre-existing limitation `SpecialsController.recolorSector`'s light
changes already accept: a scroll-48 line whose sector is also a specials mover has its geometry
rebuilt wholesale instead of living in the shared static batch this indexes. In practice this never
actually excludes anything real — a mapper only puts 48 on a purely decorative wall, never one
whose own sector also needs to move. The accumulated scroll offset is wrapped to `[0, 1)` before
being written into the (single-precision) `uv` buffer, purely to avoid float32 precision loss over
a long session — three.js's `RepeatWrapping` (`MaterialBank.toTexture`) already renders an
unwrapped UV outside `[0, 1]` correctly on its own, so the wrap isn't needed for correctness.

### Fog of war (`src/game/fogofwar.ts`, `src/render/occlusion.ts`, `src/render/mapmesh.ts`)

The dollhouse camera can see the entire level at once, including rooms the player hasn't
reached and secrets that a wide top-down view would spoil. `FogOfWar` reveals a
region once the player has line of sight to it, tested with a straight 2D raycast (reusing the
segment-intersection primitive `WallFader` uses for its camera-player sightline, factored out
to `src/util/geom.ts`) against the sight-blocking lines near the player.

**State is per subsector, not per sector**, and that distinction is load-bearing. A DOOM
sector is a logical grouping, not a place: one sector number routinely covers scattered,
disconnected chunks of a map, and even a connected one can be enormous. DOOM2 MAP02's inner
water ring is a single sector spanning 21 subsectors and 18% of the map's floor area — keyed
per sector, glimpsing any one corner of it lit the whole ring at spawn (measured: 36.9% of
MAP02 revealed before the fix, 19.8% after). Subsectors are the BSP's convex leaves, i.e.
actual places, so they reveal one at a time.

**Sight blocking is `World.blocksSight`, deliberately not `isSolidWall`** — the movement
predicate is wrong for sight in *both* directions:
- A **closed door** is a two-sided line whose sectors leave no vertical gap (the door sector's
  ceiling winched down to its floor). Vanilla never flags those `BLOCKING` — it can't, they
  must become passable when the door opens — so `isSolidWall` calls them passable and sight
  sails through into the room beyond. All 24 of MAP01's openingless two-sided lines are
  unflagged, which is exactly why the room behind the locked door showed from the corridor.
- A **window or railing** is two-sided *and* `BLOCKING`: it stops a body, not an eye. Treating
  it as sight-blocking would black out a courtyard the player is plainly looking into.

So the test is the vertical opening (`opening.top <= opening.bottom`), which is what vanilla's
own `P_CheckSight` keys off. The blocker set is rebuilt each frame rather than cached at load,
because it reads live sector heights — once doors move, an opening door must stop blocking on
the next frame.

**Reveal is sticky on sight**: a subsector once seen stays lit, like DOOM's automap filling in
as you explore. An earlier design kept sight-only reveals transient (fading back to black out
of view) and made just the sectors walked *through* permanent — but at subsector granularity
"walked through" is a one-subsector-wide trail, so a room would go dark behind the player
except a thin lit path, and every camera orbit would flicker subsectors in and out.

**Sight is the only reveal rule — `sector.special === 9` (secret) gets no special case**, and
an earlier version that excluded secrets from sight reveal was wrong. That special means
"counts toward the secret tally when entered", not "hidden from view", and mappers apply it to
places in plain sight: MAP01's secret is the outdoor grass strip you look straight down onto
through the big window, with non-secret water beyond it, so excluding it punched a black hole
out of the middle of a view the player plainly had — water visible, the ground between window
and water not. What actually hides a secret is geometry, and `blocksSight` already models that:
across DOOM E1M1–E1M8 and DOOM2 MAP01–MAP10, **none of the 197 secret subsectors is visible
from the player start**, so nothing is given away before the player walks up and looks at it.

Each subsector is sampled at its centroid first (one ray settles the common case, and the
search stops at the first sample that comes back clear, so the rest cost nothing in the common
case), then at every corner *and every edge midpoint*, each pulled slightly inward. Corners
alone leave holes: a long subsector seen edge-on through a doorway typically has its centroid
and all its corners outside the visible wedge while its edges cross it (adding edge midpoints
cut wrongly-dark subsectors roughly in half — MAP03 84 → 40, E1M1 82 → 29, measured against a
dense ground-truth sampling of each polygon).

Sight blockers are stored **a quarter-unit overlong at both ends**. Where two of them meet at a
shared vertex — a door leaf and its frame — a ray aimed near that point passes just outside the
end of both and neither reports an intersection, so sight squirts through the pinhole into the
room beyond (measured: a sample beside MAP02's closed door cleared the frame corner by 0.1 map
units and lit the room behind it). A quarter unit closes those junctions and stays far under
the width of any real opening; going to a half unit starts clipping sight that legitimately
grazes along a wall, for no further leak closed.

Explored subsectors are skipped forever after, so the per-frame cost falls as a level is
explored; the worst case (nothing explored yet) measures ~0.5 ms on DOOM2 MAP02.

Reveal drives the *same* per-vertex alpha channel the dithered-discard rendering technique
already reads (see "Wall occlusion fading" above) — extended here to flats too (`textures.ts`'s
`onBeforeCompile` injection is no longer wall-only). For walls that means two independent
systems write one channel: `WallFader.update` only computes its sightline occlusion factor and
stops short of touching geometry; `WallFader.commit` writes the *product* of that factor and
the fog alpha once both are known for the frame. Flats have no occlusion pass of their own
(only walls can stand between camera and player), so `applyFogToFlats` writes fog alpha
directly.

Which subsector a given surface belongs to is resolved differently per surface type, because
only some of them know it natively. `FlatSurface` (the new `WallOccluder` counterpart for
floor/ceiling triangle fans) carries its subsector straight from the BSP polygon it was built
from, and things resolve theirs with `subsectorAt`. Wall quads can't: they're built per
linedef, so `FogOfWar` derives each one itself by nudging the quad's midpoint
`WALL_PROBE_OFFSET` along its front normal (`mapmesh` builds every quad facing right of
`a->b`) and asking the BSP what's there — which is why `WallFader.commit` takes a callback
keyed by *occluder index* rather than by sector, and why `mapmesh.ts` carries no fog-specific
field at all. Thing sprites get the simplest treatment: `ThingLayer.update` takes an optional
`fogAlphaOf` and just toggles `mesh.visible`, since a monster or item doesn't need a smooth
per-pixel fade the way geometry does.

### Start menu (`src/ui/menu.ts`, `src/wad/library.ts`, `plugins/wad-manifest.ts`)

The Vite plugin scans `public/wads/{iwad,pwad}/`, reading each file's header and directory
(a few KB even for a 14 MB IWAD) and serving it as `/wads/index.json` (dev middleware and
build-time `emitFile`), so the menu can list types/sizes/map counts without downloading
anything. **The folder a file sits in decides how it's served, regardless of its own
IWAD/PWAD signature** — a mod placed in `wads/iwad/` becomes a selectable game WAD (useful
for a PWAD that carries its own maps); the plugin warns on mismatch but still serves it.

Menu semantics worth knowing before touching `menu.ts`:
- **Game WAD** list (`renderIwads`) only offers sources with `type === 'IWAD'`. A PWAD
  mapset can still be *played* as the game WAD (e.g. via file upload through the IWAD
  picker, or `?wad=`), but it no longer appears in this list to pick from directly.
- **Add-ons** list (`renderPwads`) excludes anything of `type === 'IWAD'` and whichever
  source is currently selected as the game WAD (even a PWAD-typed one uploaded through the
  IWAD picker) — otherwise it would show up twice.
- Files dropped/uploaded from disk are parsed in the browser and behave identically to
  server-side ones; a file uploaded via the "game WAD" picker becomes the game WAD regardless
  of its own declared type, a file uploaded via "add-on" is added as an add-on.
- `?wad=&pwad=&map=` query params preselect and skip the menu entirely. `?pos=x,y` additionally
  drops the player at those DOOM map coordinates instead of the map's own player start, applied
  *before* fog of war is seeded so the reveal shows exactly what is visible from there. That is
  the practical way to check a specific spot in a level — the room with MAP01's big window is
  several rooms and a still-unimplemented door away from the spawn, so scripting a walk to it
  is far more work than `?map=MAP01&pos=800,600`.
- **Add-ons are filtered by game (`wad/library.ts: mapStyle`)**: a WAD's own maps say which
  game it belongs to (`ExMy` → DOOM 1, `MAPxx` → DOOM II never mix within one game), and an
  add-on whose style conflicts with the selected game WAD is rendered disabled in
  `renderPwads` rather than hidden — a mapset that's simply for the other game is still worth
  seeing in the list, just not pickable. Switching the game WAD calls
  `pruneIncompatiblePwads` to drop any already-ticked add-on that no longer matches, so the
  merged map list (`mergedMaps`) never silently mixes an E1M1 with a MAP01 mapset. An add-on
  with no maps of its own (textures, sounds, ...) has no style and stays selectable
  regardless — `describeSource` shows its lump count in that case instead of a map count, so
  it doesn't read as an empty file.

`VERSION` (`src/constants.ts`) is shown bottom-right on the menu, prefixed with `v`
(`ui/menu.ts`); a static credit sits bottom-left in `index.html`/`menu.css`, next to it.

### Shared position types (`src/types.ts`)

`Pos2` (`{x, y}`), `Pos3` (`+z`) and `Placement` (`{x, y, angle}`) replace the inline
`{ x: number; y: number; z: number }` that used to be spelled out in a dozen signatures each,
and the loose scalar parameter runs (`x, y, z, …`) that went with them. Always **DOOM map
space** (x east, y north, z up = feet height), never three.js space — `mapmesh.ts:
doomToWorld` is the one place the two meet. Nothing here is a direction or velocity: those
stay separate `velX`/`velY`/`velZ` fields, and headings are plain `angle` numbers.

They're **structural**, and that's the whole reason taking one as a parameter is safe even in
per-frame code: `Player` (which now `implements Pos3`), `PosedThing`, `MonsterBody` and the
WAD's own `Thing` already carry `x`/`y`(/`z`), so a caller passes the object it already has
with **no conversion and no allocation** — `things.update(…, this.player, …)` and
`solidBodies(this.player)` are strictly cheaper than the per-frame `{x, y, z}` literals they
replaced. `MonsterRef` (`game/things.ts`, `Pos3 + id + type`) is the same idea one layer up:
every `ThingLayer` monster lookup (`pickMonster`, `monstersNear`, `monsterById`,
`monstersInSector`, `raycastMonster`) hands back that one shape.

**Deliberately *not* applied to the tight scalar loops**: `util/geom.ts`'s primitives, and
`World`'s point queries (`linesNear`, `subsectorAt`, `sectorAt`, `floorAt`, `groundFloor`,
`circleBlocked`). Their callers compute loose scalars on the fly — `circleBlocked(world, x +
dx, y, …)` inside `slideMove`, a fog-of-war sample sweeping a polygon's edges — so a
`Pos2` parameter there would force a fresh object per call in exactly the code that runs
thousands of times a frame. The rule is: take a `Pos2`/`Pos3` where callers already hold a
point object, keep scalars where they're computing coordinates inline. `slideMove` itself sits
on the right side of that line (one caller, `Player.update`, which passes `this`) and
destructures `from` once at the top, so nothing downstream changed.

`Placement.angle` is **radians**, matching `Player.angle`/`MonsterBody.angle` rather than the
WAD's own degrees — both producers (`World.playerStart`,
`SpecialsController.findTeleportDestination`) already converted on the way out. Naming the
type is what surfaced a real shipped bug: two consumers of the previously-untyped
`{x, y, angle}` (`game.ts: monsterCrossedLines`, `things.ts`'s monster-teleport branch)
converted a *second* time on the way back in, so a monster that teleported through a walk
trigger came out facing an angle scaled by π/180 and its destination `TFOG` puff was offset
along that wrong heading. The player's own teleport path (`onTeleport` → `Player.teleportTo`)
never had the bug, which is why it went unnoticed.

### Dev mode (`src/constants.ts`, `src/game.ts`)

`constants.ts` stays deliberately small — only values genuinely shared across more than a
couple of files belong there. `PLAYER_RADIUS`/`PLAYER_HEIGHT` and `NO_SIDE`/`LF`/
`SUBSECTOR_BIT` briefly lived here during a consolidation pass and were moved back to
`game/player.ts` and `wad/map.ts` respectively once it was clear they belong with the code
that owns their meaning (player tuning values; WAD binary-format constants next to the
`DoomMap` types that describe that format) rather than in a generic bucket — don't re-add
constants here just because they're imported in two or three places; a constant used in
>2 files that isn't otherwise identity-coupled to one module is the actual bar.

`DEVMODE` reads `import.meta.env.VITE_DEVMODE`, defaulting to `false`; set
`VITE_DEVMODE=true` in a git-ignored `.env.local` at the repo root to turn it on (Vite loads
`.env.local` itself, no plugin needed). It gates three things in `game.ts`, all because a
player has no legitimate reason to reach for them:
- **The debug overlay** (`updateHud`) — off, `#hud` shows only the fps counter; on, the full
  map/pos/sector/camera-state/awake-monster-count block plus the hotkey hint lines.
- **The profiling overlay** (`#profiler-hud`, see below) — visibility toggled once at startup.
- **`N`/`P` (jump to next/prev map), `+`/`-` (camera distance) and `[`/`]` (camera tilt)** in
  `handleHotkeys` — early-return on `!DEVMODE`, so these hotkeys are simply inert outside dev
  mode.

Ceilings are never rendered — `render/mapmesh.ts: buildMapMesh`'s `renderCeilings` option
still exists and defaults to (and, with the removal of the debug toggle that used to flip it,
is now always) `false`. From directly above, a rendered ceiling would hide everything under
it, so this is a permanent view choice, not a debug convenience. `updateHud`'s debug block
also reports `ThingLayer.awakeMonsterCount()` — the number of living monsters currently
alerted (chasing/attacking, or mid-`reactionTicks` delay) — useful for judging whether a
level's population has actually noticed the player.

### Profiling overlay (`src/util/profiler.ts`, `src/ui/profilerhud.ts`, `src/game.ts`)

A third DEVMODE-gated panel, top-right, breaks a frame's own cost down by category —
`Specials`, `Player`, `Weapons`, `Fog of War`, `Monsters`, `Effects`, `Fading`, `Render`, plus
an `Other` bucket for whatever wasn't explicitly measured (input handling, HUD text, the
player sprite's own pose) — so a slow frame can be traced to *which* system is responsible
rather than just how many fps it costs overall.

`FrameProfiler` (`util/profiler.ts`) is a plain per-frame timer, not tied to rendering or game
state: `beginFrame()`, any number of `time(label, fn)`/`add(label, ms)` calls (the same label
can be used more than once per frame — e.g. `game.ts`'s "Player" bucket covers both the
movement block and the later pickup/damage-floor block, non-contiguous in `frame()` — and
accumulates), then `endFrame()`. Every label is smoothed with a plain exponential moving
average rather than shown raw, the same reasoning as `util/damping.ts`'s `dampen`: a single
frame's timing is noisy (GC pauses, OS scheduling), and an unsmoothed bar graph would flicker
faster than it could be read. Measurement itself is **not** gated behind `DEVMODE` —
`performance.now()` calls are cheap enough not to bother branching around, the same call as
`fps` above already makes — only the DOM panel's visibility (toggled once in `Game`'s
constructor, since `DEVMODE` never changes at runtime) and whether `updateHud` bothers pushing
samples to it are.

`ProfilerHud` (`ui/profilerhud.ts`) renders each category as a horizontal bar sized against
one 60fps frame's budget (16.6ms) rather than against each other — a bar reaching full width
means that category *alone* would miss the budget, which is a more directly actionable signal
for spotting a bottleneck than relative proportions would be, and turns amber/red past
25%/100% of that budget so the worst offender is visible without reading the numbers. Rows are
created once per label (first-seen order from `FrameProfiler`) and reused after that, the same
"build the DOM once, update fields every frame" approach `Hud` already uses for its icons —
and re-sorted worst-first on every `update()` call via `appendChild` on the already-existing
row (which reorders rather than duplicating), so the biggest cost always lands at the top
without needing to tear down and rebuild anything.

## Current state

Playable as a walkable level viewer: geometry, textures, sector lighting, collision with
step-up/headroom rules, gravity-based falling off ledges, vanilla's narrow-gap-crossing quirk,
floor following, map switching, PWAD loading, and a camera that can orbit in yaw (right-drag
or `Q`/`E`) around the player with dithered wall-occlusion fading so it never hides the player,
or an awake monster, behind geometry. Subsector-based fog of war (`game/fogofwar.ts`) hides
whatever the player has not yet had line of sight to — geometry and things reveal permanently
once seen, which keeps unreached rooms and secrets dark until they are actually in view.
THINGS render as upright
sprite billboards (monsters, weapons, ammo, health/armor, keys, powerups and common
decorations — see the thing table in `game/thingdefs.ts`), batched into one `InstancedMesh` per
sprite lump so a map with ten thousand of them stays playable (`render/spritebatch.ts`), and the
player is drawn as the real `PLAY` sprite with a facing-driven rotation frame and a walk-cycle
animation, both tracking the live camera angle. Health, armor, ammo, key, weapon, backpack and
powerup pickups are all collectible
(`game/inventory.ts`) and drive a HUD (`src/ui/hud.ts`) drawn from the same WAD pickup-sprite
graphics the world renders items with. All six powerups do what vanilla's do — invulnerability,
berserk, partial invisibility, radiation suit, computer area map and light amplification visor,
on vanilla's own timers — as does the backpack (see "Powerups and the backpack" above).
Multiplayer-only things
(deathmatch weapon/ammo stashes) correctly don't spawn (`game/skill.ts: isMultiplayerOnly`).
All nine weapons can be selected (`1`-`7`, or the mouse wheel) and fired (`game/weapons.ts`):
hitscan weapons draw a flashing tracer line to what they hit, the rocket launcher/plasma
rifle/BFG launch a flying sprite that explodes on arrival, the fist and chainsaw swing at
whatever is within `PLAYER_MELEE_RANGE` in front of the player, and hovering the cursor over a
monster locks aim onto it, angling the shot to its actual position and height
(`ThingLayer.pickMonster`, `world.ts: shotPath`). The selected weapon shows in the HUD, since
the player sprite looks the same whatever it holds. A locked-on shot that lands, or anyone
caught in a rocket/BFG blast's splash (including the player themselves), takes real damage —
monster health is vanilla's own, death plays that monster's confirmed WAD death animation, and
the player's own death freezes the game behind a `#death-overlay` until `R` restarts the level
(`game/thingdefs.ts`, `render/sprites.ts: SpriteActor.die`, `game/inventory.ts: applyDamage`,
`game.ts`). Doors, lifts, floor movers, crushers, stair builders, switches and teleporters all
work (`game/specials.ts`), including locked doors, which require the matching key to be collected
first, and teleporters, which reproduce vanilla's teleport-fog puff at both ends of the jump
(`game.ts`). Shoot-triggered specials (24/46/47) fire off whatever a hitscan pellet or projectile
actually lands on — a monster's own shot can trigger 46 too, matching vanilla's one hardcoded
exception for it (`world.ts: shotPath`'s returned `lineIndex`, `SpecialsController.triggerShot`).
The floor-mover table also covers vanilla's "raise to next highest floor" family at both normal
and turbo speed (18/69/119/128/129-132) and its fixed-height raises (58/59/92/93's own +24,
140's +512, and 14/15/66/67's +24/+32 — the latter four are a different vanilla code path,
`EV_DoPlat`'s `raiseAndChange`, but land on the exact same triggering-line-front-sector texture
copy the existing `changeTexture` family already models, so no new mechanism was needed for
them). One-way ceiling movers, `raiseToTexture`, `lowerAndChange`, delayed doors (both the
linedef and sector-type varieties), instant/switch-triggered light changes, and the donut effect
are all modeled too (see "One-way ceiling movers, delayed doors, instant light changes, and the
donut" above), and so are the two vanilla mechanisms that sit outside the linedef-trigger model
entirely: damage-floor sector specials and continuously scrolling wall textures (see "Damage
floors and scrolling textures" above) — closing out every vanilla (non-Boom) linedef/sector
special this engine's own audit against the real source found. `wad/specials.ts`'s own table
comments have the full vanilla-numbers-to-mechanism mapping. Crushers and the crushing floor
family (55/56/65/94 — not the turbo-16 stairs, which
never crush even in vanilla) deal periodic damage to the player or any monster caught in their
sector, though a *mover* (crusher, door, lift) still doesn't detect or stop for a thing in its way
the way vanilla does — a separate, still-open gap from the thing-vs-thing collision described
next, which is about two things walking into each other, not a moving sector hitting one. Monsters
now wake, chase and attack the player (`game/monsters.ts`, see "Monster AI" above): they use the
same movement physics as the player (collision, step-up, gravity) but on vanilla's real 8-direction
`P_NewChaseDir` pathing rather than a beeline, every type keeps closing until it physically runs
into its target — monsters and the player are solid bodies that block one another on contact,
vanilla's `PIT_CheckThing` box test — and stands still for the length of whatever attack it fires.
Taking damage always alerts (and sometimes staggers) a monster regardless of whether it had
spotted its attacker yet, and re-targets it onto whoever dealt the damage if nothing else already
has its attention — vanilla's infighting, complete with threshold commitment, arch-vile exemptions
and same-species projectile immunity, so a shot that clips the wrong monster can turn it on the
shooter. Gunfire wakes monsters within sound-propagation range even without sight
(`World.noiseAlert`, respecting closed doors and `BLOCK_SOUND` lines the same way vanilla does),
and a monster walks the same walk triggers vanilla lets it (teleports, including the monster-only
125/126 pair, one door type, two lift types), so a mapper's monster-closet setup works. Remaining
known deviations, all deliberate: monster *damage* values are tuned softer than vanilla's, a
monster's own projectile carries no splash (so a cyberdemon's rocket doesn't blast what it lands
next to), the revenant's missile flies straight instead of homing, and the pain elemental and
arch-vile use a hitscan stand-in for attacks vanilla implements differently. Not yet implemented:
actual audio (the noise-alert *mechanic* above works off vanilla's sound-propagation rules, but
nothing in this engine plays a sound yet).
