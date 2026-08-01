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

## Architecture

```
src/wad/       WAD files, merged lump directory, map lumps, graphics + sprite decoding
src/render/    BSP polygon reconstruction, mesh building, materials, occlusion fading,
               sprite billboards, camera
src/game/      spatial queries, collision, player controller, input, thing→sprite table,
               fog of war
src/ui/        start menu
src/util/      small pure helpers shared across layers (2D geometry, damped-lerp smoothing)
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

### Wall occlusion fading (`src/render/occlusion.ts`, `src/render/textures.ts`)

Single-sided back-face culling (above) only removes walls facing away from the camera; it
does nothing about a wall that legitimately faces the camera but sits directly on the
camera→player sightline (e.g. a pillar in front of the player). `WallFader` tests every wall
quad's 2D footprint against that sightline each frame and fades the ones that cross it, rather
than the coarser fix of drawing the player on top of everything, which would also show it
through walls that genuinely separate it from the camera.

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
survives leaving the canvas mid-move); tilt and distance are unaffected, so the camera always
stays the same amount off vertical. `viewerAngleDeg` (`yawDeg - 90`) is the DOOM-space bearing
from the followed point to the camera, and is what sprite rendering (above) and player
movement both key off — at the default `yawDeg = 0` it's `-90`, matching the old fixed
south-facing camera exactly, so nothing downstream needed a special case for "not yet
orbited."

Movement (`Player.update`'s `forwardDeg` param, passed as `camera.viewerAngleDeg + 180`) is
camera-relative rather than DOOM-axis-relative: `W` always moves the player away from the
camera *on screen*, regardless of which way the camera has been orbited to face. `main.ts`
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

### Things as sprites (`src/wad/sprites.ts`, `src/render/sprites.ts`, `src/game/thingdefs.ts`)

`SpriteBank` (`wad/sprites.ts`) indexes `S_START`/`S_END` lumps by sprite name + frame
letter, resolving DOOM's `SSSSFR` / `SSSSFRfr` naming (a frame can list a second
frame+rotation meaning "this same lump, mirrored, is also that rotation" — the usual way
DOOM halves the art needed for symmetric actors). `thingdefs.ts` maps THING doomednums to
their sprite name; a type absent from that table renders nothing, same as DOOM's own
invisible spawn markers (player starts, deathmatch spots, teleport landings).

Things render as upright planes (`render/sprites.ts: SpriteActor`/`SpriteMaterialCache`),
not `THREE.Sprite` billboards. A few decisions here are non-obvious enough to be worth
knowing before touching this file:

- **Planes turn to face the camera's yaw, but never tilt.** `TopDownCamera` can orbit in yaw
  (right-drag, see below) but only ever tilts a fixed amount off vertical — it never pitches
  further down or up. So a plane only ever needs to rotate around its vertical axis to track
  `camera.viewerAngleDeg` (`SpriteActor.setPose`'s `viewerAngleDeg` param, called every frame
  from `main.ts`); it never needs a true billboard rotation. `VIEWER_ANGLE_DEG` is just the
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

Animation (`SpriteActor.setPose`'s `animFrames`/`animating`) is a plain frame-letter cycle
with no separate idle art, matching DOOM itself: the player's `PLAY` sprite reuses `A,B,C,D`
as its walk cycle and simply holds `A` while not moving. Every other thing still defaults to
a single held frame — giving monsters their own idle animation needs DOOM's actual per-type
state tables (which frames are "idle" vs. attack/pain/death), not a guessed frame range, so
that's deferred to the combat/monster milestone rather than approximated now.

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

## Current state

Playable as a walkable level viewer: geometry, textures, sector lighting, collision with
step-up/headroom rules, floor following, map switching, PWAD loading, and a camera that can
orbit in yaw (right-drag) around the player with dithered wall-occlusion fading so it never
hides the player behind geometry. Subsector-based fog of war (`game/fogofwar.ts`) hides
whatever the player has not yet had line of sight to — geometry and things reveal permanently
once seen, which keeps unreached rooms and secrets dark until they are actually in view.
THINGS render as upright
sprite billboards (monsters, weapons, ammo, health/armor, keys, powerups and common
decorations — see the thing table in `game/thingdefs.ts`), and the player is drawn as the
real `PLAY` sprite with a facing-driven rotation frame and a walk-cycle animation, both
tracking the live camera angle. Not yet implemented: monster AI/combat, weapons, doors and
lifts, pickup collection, sound.
