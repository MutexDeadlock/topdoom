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

## Architecture

```
src/wad/       WAD files, merged lump directory, map lumps, graphics + sprite decoding
src/render/    BSP polygon reconstruction, mesh building, materials, occlusion fading,
               sprite billboards, shot tracers, camera
src/game/      spatial queries, collision, player controller, input, thing→sprite table,
               fog of war, inventory/pickups, weapons and firing, damage/death
src/ui/        start menu, HUD
src/util/      small pure helpers shared across layers (2D geometry, damped-lerp smoothing)
src/constants.ts   Genuinely cross-cutting values only (VERSION, DEVMODE) — see below
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
survives leaving the canvas mid-move) or by holding `Q`/`E` (`main.ts`'s `KEY_YAW_SPEED`,
degrees/sec, signed to match the same rotation direction as dragging left/right respectively);
tilt and distance are unaffected, so the camera always stays the same amount off vertical.
`viewerAngleDeg` (`yawDeg - 90`) is the DOOM-space bearing from the followed point to the
camera, and is what sprite rendering (above) and player movement both key off — at the
default `yawDeg = 0` it's `-90`, matching the old fixed south-facing camera exactly, so
nothing downstream needed a special case for "not yet orbited."

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

### Things as sprites (`src/wad/sprites.ts`, `src/render/sprites.ts`, `src/game/thingdefs.ts`)

`SpriteBank` (`wad/sprites.ts`) indexes `S_START`/`S_END` lumps by sprite name + frame
letter, resolving DOOM's `SSSSFR` / `SSSSFRfr` naming (a frame can list a second
frame+rotation meaning "this same lump, mirrored, is also that rotation" — the usual way
DOOM halves the art needed for symmetric actors). `thingdefs.ts` maps THING doomednums to
their sprite name; a type absent from that table renders nothing, same as DOOM's own
invisible spawn markers (player starts, deathmatch spots, teleport landings).

**`game/skill.ts: isMultiplayerOnly`** filters out things carrying THING flag bit `0x10`
before `buildThingSprites` poses them — vanilla's own `P_SpawnMapThing` reads
`if (!netgame && (options & 16)) return NULL;`, i.e. the bit hides a thing whenever no other
players are present. This engine has no multiplayer mode, so `netgame` is always false and
the bit always applies. Mappers use it to stash deathmatch-only weapons/ammo without
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

### Item pickups and HUD (`src/game/inventory.ts`, `src/ui/hud.ts`, `render/sprites.ts: ThingLayer.tryPickup`)

`Inventory` (health, armor + armor type, four ammo classes, collected keys) is a plain
struct owned by `Game` in `main.ts`, not by `Player` — nothing about resting height or
movement needs it, and keeping it separate is what makes `finishLevel` (below) a one-line
call at map load rather than something `Player`'s constructor has to reason about.

Health, armor, ammo, keys and weapons are collectible; powerups are the one category still
left alone (still rendered, still decorative) since there's no player-status-effect system
yet to give picking one up any meaning. Weapon ownership and ammo land in
`Inventory.weapons`/`Inventory.ammo`, and are read by `game/weapons.ts` (below) for
selection and firing. `Inventory.currentWeapon` lives here rather than in `WeaponSystem` for
the same reason the rest of the struct does: `main.ts` owns it, and the HUD reads it straight
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

**Keys don't survive a level transition; health/armor/ammo do** (`finishLevel`, called from
`main.ts: loadMapByIndex` before the new map loads) — matching vanilla's own
`G_PlayerFinishLevel`, which clears `player->cards` but nothing else. This does mean a locked
door on the far side of a level transition needs its key collected again on the new map, same
as vanilla itself requires.

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
same as `playerX`/`playerY` — inventory is a `main.ts`-owned struct, not something
`SpecialsController` reaches for on its own (see `Inventory` above for why).

Getting the key check to actually fire surfaced a second, unrelated bug in the same table:
99 and 133-137 were missing or mismarked `manual: true`. Unlike 26-34 (real D1 manual doors,
which open the *linedef's own* back sector and ignore tag entirely), 99/133-137 are S1/SR
switches that target sectors by tag like any other remote door — confirmed by scanning every
stock DOOM/DOOM2 map, where every 99/133-137 linedef's tag exactly matches the sector(s) it
opens. `wad/specials.ts`'s own doc comment has the numbers; the concrete bug this caused was
DOOM2 MAP04's blue door (special 99, missing from the table until this fix) never opening at
all, key or no key.

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

### Weapons, firing and auto-aim (`src/game/weapons.ts`, `src/game/world.ts: shotPath`, `src/render/tracer.ts`, `src/main.ts`)

`WeaponSystem` (`game/weapons.ts`) owns weapon selection and fire timing/ammo, and
**deliberately knows nothing about three.js**: `update` returns a list of `Shot`s describing
what was fired this frame (one per hitscan pellet, or one per projectile launched), and
`main.ts` turns those into tracer lines and flying sprites. That's the same split as
`game/specials.ts`'s line triggers vs. `main.ts`'s teleport-fog puffs, and it's what lets fire
rates and ammo costs be tested headlessly against a synthetic map.

Fire rates and spread are tuned by feel rather than converted from vanilla's tic-based weapon
state tables — same reasoning as `player.ts`'s `GRAVITY`, they don't translate to a dt-scaled
model. Ammo-per-shot has no such problem and is lifted straight from vanilla, since it's what
decides how long a pickup's ammo lasts. Hitscan spread uses vanilla's own `P_Random - P_Random`
trick (two uniform draws subtracted → triangular distribution centred on the aim line).

**Slot keys toggle within a slot, they don't select "the best".** `WEAPON_SLOTS` lists each
digit's weapons best-first, but pressing a digit already showing one of that slot's weapons
advances to the *next* one owned rather than re-picking the best. Without this, slots 1 and 3
(fist/chainsaw, shotgun/super shotgun) made their weaker weapon permanently unreachable once
the upgrade was owned — which presented as "shotgun and super shotgun are the same weapon".

**`shotPath` (`game/world.ts`) decides where a shot ends up**, for both tracer endpoints and
how far a projectile may fly. It has two modes, and the difference is the whole reason it takes
a `target` rather than just an angle:

- **Free shot** (no target): flat at the player's fire height, out to `WEAPON_RANGE`. Blocked
  by `isSolidWall` **and** by a two-sided line whose vertical opening the shot's height doesn't
  fit through. Neither test alone is enough — `blocksSight` alone lets a shot through a
  BLOCKING railing (it has a real opening), `isSolidWall` alone lets one through a shut door
  (vanilla never flags those BLOCKING), and omitting the height test entirely lets a rocket
  sail through a knee-high step because the opening beyond it was tall enough for *sight*.
- **Locked-on shot** (auto-aim target): slopes from the player's fire height to the target's
  over exactly the distance between them, and stops *at* the target. Here the height test is
  deliberately **skipped** — the shot is angled over intervening steps on purpose. Leaving it
  on meant a shot at a monster on a ledge got cut off at the ledge's near edge, and since the
  returned height is "wherever it stopped", that presented as the shot going flat and ignoring
  the click entirely.

Both modes start at the player's own height, never the target's — using the target's height
for the origin made tracers and projectiles visibly begin in mid-air rather than at the gun.
Blocking is evaluated at the interpolated height where the ray crosses each candidate line, not
one height for the whole flight. Candidate lines are extended `WALL_OVERLAP` past both ends for
the same reason `FogOfWar` extends its sight blockers: two walls meeting at a shared vertex
otherwise let a shot aimed at that corner slip between them.

**Auto-aim is click-to-target, not vanilla's autoaim cone** — this game has a mouse pointer,
so "aim at that one" is expressible directly. `ThingLayer.pickMonster` raycasts the cursor
against monster sprite meshes (`MONSTER_TYPES` in `game/thingdefs.ts`, filtered to
currently-`visible` meshes so a fog-of-war-hidden monster can't be targeted through the
geometry hiding it) and returns the hit monster's position *and* its sector's live floor
height. `main.ts` uses that as both the aim point and the shot's end height.

The lock applies **on hover, not on click**. Gating it to `input.mouseDown` made `aim` — which
drives `player.angle` *and* the camera's aim-lead — switch sources the instant a click landed,
and since a monster is normally much nearer than the cursor's floor-plane projection, the
camera's lead offset collapsed at that moment and read as the camera lurching backwards. Aim
has always been set from the cursor unconditionally, click or no; the lock has to follow the
same rule to stay continuous.

Impact explosions and the teleport-fog puff share one mechanism in `main.ts`
(`OneShotEffect`/`spawnEffect`/`updateEffects`): a transient sprite animation playing once at a
fixed spot, outside `ThingLayer` since neither is a real map `Thing`. `IMPACT_EFFECTS` maps a
projectile's flight sprite to its explosion — vanilla reuses `MISL` frames B–D for the rocket's
own blast, while the plasma bolt and BFG ball explode into dedicated `PLSE`/`BFE1` sprites.

### Damage, monster death and player death (`src/game/thingdefs.ts`, `src/render/sprites.ts`, `src/game/inventory.ts`, `src/game/world.ts: hasLineOfSight`, `src/main.ts`)

Shots and explosions hurt and kill; there is still no monster AI, so nothing shoots back except
a rocket/BFG blast splashing the shooter — that, and a monster's own death, are the only ways
the player currently takes damage.

**A shot deals direct damage two different ways, depending on whether one was locked on.** A
locked-on shot (a monster was under the cursor when it fired) resolves hit-or-miss against that
exact target: `main.ts`'s `spawnShot` compares `shotPath`'s returned distance against the
straight-line distance to the target to know whether something (a wall) cut the shot short
before it got there. A *free* shot (nothing under the cursor) instead tests its straight flight
path against every monster's body — `ThingLayer.raycastMonster` — the way any real hitscan or
projectile trace would, so a monster standing between the player and a wall they're shooting at
still gets hit even though it was never clicked; only the nearer of "a wall/step" (`shotPath`)
and "a monster in the way" (`raycastMonster`) actually stops the shot. `raycastMonster` tests a
single approximate hitbox (`MONSTER_HIT_RADIUS`/`_HEIGHT` in `render/sprites.ts`) rather than
each monster's real, and quite varied (16-128 units), vanilla radius — modelling that accurately
would need a whole per-species size table for a check this approximate to begin with. Either way,
for a hitscan pellet damage is applied immediately (an instant line has no travel time to wait
out); for a projectile it's carried on the `Projectile` object and applied in `updateProjectiles`
once the sprite visually reaches its (possibly shot-short-by-a-monster) `maxDist` — monster
positions never change mid-flight (no AI), so resolving hit/miss at launch and only *applying* it
on arrival is safe and doesn't need a second raycast.

**Splash damage is separate from a direct hit, and reaches everyone nearby regardless of what
(if anything) was targeted** — a rocket or BFG shot fired at a bare wall still explodes and can
still hurt a monster standing close by, matching vanilla. `main.ts`'s `applyRadiusDamage` walks
every living monster `ThingLayer.monstersNear` returns within the blast radius, skips anyone
`hasLineOfSight` (`game/world.ts`, a straight-line reuse of the sight-blocking test `FogOfWar`
uses for reveal — not `shotPath`, which models a directed weapon's own blocking rules, not "does
this omnidirectional blast reach that point") says is blocked by a wall, and applies damage
falling off linearly to 0 at the radius edge, matching vanilla's own `P_RadiusAttack`.

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

Self-splash is otherwise the only path through which the player takes damage at all right now,
since there's no monster AI to attack back. Per-weapon direct-hit damage rolls follow vanilla's
own `((rand % sides) + 1) * multiplier` shape and are lifted rather than tuned by feel, the same
reasoning ammo-per-shot already used — they decide how tough a fight actually is.

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

**The player's own death reuses the exact same mechanism** on `main.ts`'s single persistent
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

### Crushers and teleporters (`src/wad/specials.ts`, `src/game/specials.ts`, `src/main.ts`)

The vanilla-only line special table (doors/lifts/floors above, plus these two) is confirmed
against the Doom wiki's linedef type table rather than assumed, after a first pass briefly (and
wrongly) listed 174 as a vanilla S1 teleport — it's Boom-only. Same story for crusher stop: 58
looks like it could be a third stop-crusher alongside 57/74, but is an unrelated "floor up 24"
special.

**Crushers** (start: 6/25/49/73/77/141, stop: 57/74) are pure ceiling geometry — repeatedly
lower to floor+8, reverse, return to the sector's *own* start height (not neighbor-derived, unlike
a door's open height), forever, with no hold/rest state in between. Deliberately still no player
damage, even though a health/death pipeline exists now (see "Damage, monster death and player
death" above): a crusher's own repeat/reverse timing has no "what happens after the player dies
underneath it" story yet (`restart` reloads the whole map, which would also un-crush anything
mid-squeeze), unlike a single weapon hit, so wiring it in here would be a half-built feature.

**Teleporters** (39/97 trigger for the player; Doom II's 125/126 are monster-only and never fire
— there's no monster AI to walk them, the same outcome vanilla's own player-vs-monster gate gives
them today). The destination is the first doomednum-14 landing thing found inside a tag-matched
sector (`SpecialsController.findTeleportDestination`); reaching it calls back into `main.ts` to
move the player (`Player.teleportTo`) and snap the camera yaw to match, the same as the initial
spawn.

Teleporting moves the player an arbitrary distance in a single frame, which breaks
`SpecialsController`'s own walk-trigger detection: it tracks `prevX`/`prevY` to know what segment
the player just crossed, and naively leaving those at the pre-teleport position would make the
very next frame test a segment from the old spot all the way to the teleport pad — long enough to
cross, and wrongly re-trigger, unrelated lines along the way. `lastTeleport` is set once inside
`trigger` and consumed at the end of `update` to reseed `prevX`/`prevY` from the destination
instead.

Vanilla also spawns a one-shot `MT_TFOG` fog puff at both ends of a teleport (where the player
stood, and 20 units ahead of the landing spot along the direction it faces). That isn't a real
map `Thing`, so it isn't modeled through `ThingLayer` — `main.ts` owns a small list of transient
`SpriteActor`s instead, each playing through the `TFOG` sprite's frames (`A`-`J`, confirmed
against the actual lump names in `DOOM.WAD`/`DOOM2.WAD` — all rotation-0, i.e. omnidirectional,
so no facing logic is needed) once before removing itself. Map transitions clear any still-active
puffs explicitly, the same way `built.group`/`things.group` are torn down, since a teleport onto
an exit line could otherwise cut an animation short and leave its plane glued into the next
level's scene.

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

### Dev mode (`src/constants.ts`, `src/main.ts`)

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
`.env.local` itself, no plugin needed). It gates two things in `main.ts`, both because a
player has no legitimate reason to reach for them:
- **The debug overlay** (`updateHud`) — off, `#hud` shows only the fps counter; on, the full
  map/pos/sector/camera-state block plus the hotkey hint lines.
- **`N`/`P` (jump to next/prev map), `+`/`-` (camera distance) and `[`/`]` (camera tilt)** in
  `handleHotkeys` — early-return on `!DEVMODE`, so these hotkeys are simply inert outside dev
  mode.

`C` (ceiling toggle) is deliberately *not* gated — from directly above, a rendered ceiling
would hide everything under it, so leaving it off by default is a real, permanent view
choice, not a debug convenience, and it works regardless of `DEVMODE`.

**`C` rebuilds geometry in place rather than reloading the map.** `renderCeilings` only
changes which flat triangles `render/mapmesh.ts: buildMapMesh` emits — it has no bearing on
the player, world state, fog-of-war reveal, mover positions or picked-up items. An earlier
version routed the toggle through `loadMapByIndex` (the same path map transitions and `N`/`P`
use) to get a rebuilt mesh, which reset all of that from scratch — pressing `C` looked
indistinguishable from the level restarting: player snapped back to spawn, opened doors
closed again, collected items reappeared. `main.ts: toggleCeilings` instead only rebuilds the
static mesh and both faders, then calls `SpecialsController.setBuilt` with the fresh
`BuiltMap` so movable-sector meshes (doors/lifts/crushers) get rebuilt too — `buildMoverMesh`
also reads `meshOptions.renderCeilings`, and rebuilding from the still-live `this.map` sector
heights (the same object `SpecialsController` mutates directly for movers) preserves each
mover's current position exactly the way `rebuildAround` already does after an ordinary
height change. `setBuilt` also re-runs `indexLightGeometry`, which points a light-flicker
sector at the specific occluder/flat objects it recolors each tick (`sectorOccluders`/
`sectorFlats`); those are derived from `built.occluders`/`built.flatSurfaces` at construction
time, so without re-deriving them they'd stay pointed at the pre-toggle geometry — e.g. a
newly-added ceiling flat in a blinking sector would never pick up the blink.

## Current state

Playable as a walkable level viewer: geometry, textures, sector lighting, collision with
step-up/headroom rules, gravity-based falling off ledges, vanilla's narrow-gap-crossing quirk,
floor following, map switching, PWAD loading, and a camera that can orbit in yaw (right-drag
or `Q`/`E`) around the player with dithered wall-occlusion fading so it never hides the player
behind geometry. Subsector-based fog of war (`game/fogofwar.ts`) hides
whatever the player has not yet had line of sight to — geometry and things reveal permanently
once seen, which keeps unreached rooms and secrets dark until they are actually in view.
THINGS render as upright
sprite billboards (monsters, weapons, ammo, health/armor, keys, powerups and common
decorations — see the thing table in `game/thingdefs.ts`), and the player is drawn as the
real `PLAY` sprite with a facing-driven rotation frame and a walk-cycle animation, both
tracking the live camera angle. Health, armor, ammo, key and weapon pickups are collectible
(`game/inventory.ts`) and drive a HUD (`src/ui/hud.ts`) drawn from the same WAD pickup-sprite
graphics the world renders items with; powerups stay decorative-only. Multiplayer-only things
(deathmatch weapon/ammo stashes) correctly don't spawn (`game/skill.ts: isMultiplayerOnly`).
All nine weapons can be selected (`1`-`7`, or the mouse wheel) and fired (`game/weapons.ts`):
hitscan weapons draw a flashing tracer line to what they hit, the rocket launcher/plasma
rifle/BFG launch a flying sprite that explodes on arrival, and hovering the cursor over a
monster locks aim onto it, angling the shot to its actual position and height
(`ThingLayer.pickMonster`, `world.ts: shotPath`). The selected weapon shows in the HUD, since
the player sprite looks the same whatever it holds. A locked-on shot that lands, or anyone
caught in a rocket/BFG blast's splash (including the player themselves), takes real damage —
monster health is vanilla's own, death plays that monster's confirmed WAD death animation, and
the player's own death freezes the game behind a `#death-overlay` until `R` restarts the level
(`game/thingdefs.ts`, `render/sprites.ts: SpriteActor.die`, `game/inventory.ts: applyDamage`,
`main.ts`). Doors, lifts, floor movers, crushers, switches and teleporters all work
(`game/specials.ts`), including locked doors, which require the matching key to be collected
first, and teleporters, which reproduce vanilla's teleport-fog puff at both ends of the jump
(`main.ts`). Not yet implemented: monster AI (nothing moves or fights back — the only way the
player takes damage today is a rocket/BFG blast catching them too), crushers still don't hurt
the player, powerup effects, sound.
