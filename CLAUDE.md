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
src/render/    BSP polygon reconstruction, mesh building, materials, sprite billboards, camera
src/game/      spatial queries, collision, player controller, input, thing→sprite table
src/ui/        start menu
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

- **Planes have a fixed orientation, not a computed one.** `TopDownCamera` never orbits —
  only tilt/zoom change — so the "face the viewer" direction is the *same constant world
  direction* for every actor, always (`VIEWER_ANGLE_DEG`). A `THREE.Sprite` recomputes a full
  camera-facing rotation every frame, which is not just wasted work here but actively wrong:
  it tips flat as the camera tilts toward straight-down, making standing figures read as
  lying on the floor. A plane baked once to stay vertical avoids that and is cheaper.
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
- **Rotation frame is picked once from a fixed viewer angle**, not recomputed per thing per
  frame from the actual camera position — consistent with the fixed-orientation billboard
  above, and cheap.

Animation (`SpriteActor.setPose`'s `animFrames`/`animating`) is a plain frame-letter cycle
with no separate idle art, matching DOOM itself: the player's `PLAY` sprite reuses `A,B,C,D`
as its walk cycle and simply holds `A` while not moving. Every other thing still defaults to
a single held frame — giving monsters their own idle animation needs DOOM's actual per-type
state tables (which frames are "idle" vs. attack/pain/death), not a guessed frame range, so
that's deferred to the combat/monster milestone rather than approximated now.

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
- `?wad=&pwad=&map=` query params preselect and skip the menu entirely.

## Current state

Playable as a walkable level viewer: geometry, textures, sector lighting, collision with
step-up/headroom rules, floor following, map switching, PWAD loading. THINGS render as
upright sprite billboards (monsters, weapons, ammo, health/armor, keys, powerups and common
decorations — see the thing table in `game/thingdefs.ts`), and the player is drawn as the
real `PLAY` sprite with a facing-driven rotation frame and a walk-cycle animation. Not yet
implemented: monster AI/combat, weapons, doors and lifts, pickup collection, sound.
