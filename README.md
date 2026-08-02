# TopDoom

A top-down DOOM built on the original IWADs. The camera hangs above the player and is
tilted slightly off vertical, so walls show some of their height and levels read as
spaces rather than floor plans; it can also orbit around the player on right-drag or `Q`/`E`. Level
geometry, textures and flats come straight out of `DOOM.WAD` / `DOOM2.WAD`; the game logic
is new.

## Running it

```bash
npm install
cp /path/to/DOOM.WAD public/wads/iwad/       # the game WADs
cp /path/to/SomeMod.wad public/wads/pwad/    # any add-ons you want on the menu
npm run dev                                  # http://localhost:5173
```

WADs are not part of the repo.

## Start menu

Everything under `public/wads/iwad/` and `public/wads/pwad/` shows up automatically: a Vite
plugin reads each file's header and directory — a few kilobytes even for a 14 MB IWAD — and
publishes them as `/wads/index.json`, so the menu can list types, sizes and map counts
without downloading anything. The same manifest is baked into the output on `npm run build`.

- **Game WAD** — offered from `public/wads/iwad/`. Normally an IWAD, but a PWAD carrying
  maps works too if you put it there.
- **Add-ons** — offered from `public/wads/pwad/`, any number, merged in the order they were
  ticked. The level list updates as you tick them and names the file a map came from when an
  add-on took it over. An add-on whose own maps are `ExMy` (DOOM 1) or `MAPxx` (DOOM II) is
  disabled once it conflicts with the selected game WAD's own naming scheme, and any already
  ticked when you switch game WAD is unticked automatically; add-ons with no maps of their
  own (textures, sounds, ...) always stay selectable, showing their lump count instead of a
  map count so they don't read as empty.
- **Level** — every map in the resulting set, grouped by episode for DOOM 1.

The folder a file sits in decides how it's served, regardless of its own IWAD/PWAD
signature — a mod placed in `wads/iwad/` becomes a selectable game WAD, matching the "PWAD
carrying maps" case above. The dev server logs a warning if a file's signature disagrees
with its folder, but still serves it.

Files outside `public/wads/` go through *Load from disk* or by dropping them on the window;
they are parsed in the browser and behave exactly like server-side ones. A file that
declares itself an IWAD becomes the game WAD, a PWAD is added as an add-on.

`Esc` returns to the menu and pauses; `Esc` again resumes where you left off.

`?wad=DOOM2.WAD&pwad=SCYTHE.WAD&map=MAP05` preselects and skips the menu.

## Controls

| Key | |
|---|---|
| `W` `A` `S` `D` | move (screen-relative: `W` always moves away from the camera) |
| `Shift` | run |
| mouse | aim; the view leads slightly towards the cursor |
| right-drag / `Q` `E` | orbit the camera around the player |
| `N` / `P` | next / previous map |
| `C` | toggle ceilings |
| `+` / `-` | camera distance |
| `[` / `]` | camera tilt |
| `Esc` | menu / resume |

Ceilings are off by default — from above they would hide everything underneath.

## HUD

Walking within range of a health, armor, ammo, key or weapon pickup collects it automatically
— no key press needed. The bar along the bottom of the screen shows the running totals: a
medikit icon and health, an armor icon (green or blue, matching whichever armor you're wearing
— blank while you have none) and its value, all four ammo counts, and one slot per key color
that lights up once collected. Weapons disappear and grant their ammo like the real game, but
there's no weapon-select UI yet — ownership is tracked, not shown or usable — and powerups are
still just decoration; both wait on the Shooting milestone to mean anything.

## Layout

```
src/wad/       WAD files, merged lump directory, map lumps, graphics decoding
src/render/    BSP polygon reconstruction, mesh building, materials, occlusion fading, camera
src/game/      spatial queries, collision, player controller, input, inventory/pickups
src/ui/        start menu, HUD
plugins/       Vite plugin publishing the public/wads/{iwad,pwad} manifest
scripts/       headless WAD inspection (node scripts/inspect-wad.ts)
```

Some notes on the parts that are less obvious:

**Merging WADs.** `WadFile` parses one file; `Wad` concatenates several into the single
lump directory the engine reads, with later files winning on name collisions. That one rule
gives PWAD overrides for free: a replaced `MAP01` marker resolves to the add-on, and its map
lumps follow it contiguously, so nothing else needs to know a PWAD is involved.

Marker ranges are the exception — `F_START..F_END` can nest (`F1_START`) and every file may
open its own, so `markedRange` counts depth instead of spanning first to last marker.
Texture definitions are merged across files rather than replaced: vanilla treats a PWAD's
`TEXTURE1` as a full replacement, which breaks any pairing the PWAD wasn't built for.
Merging only ever adds names that would otherwise resolve to nothing. Patch indices are
per-file, so they are resolved through the defining file's `PNAMES` at load time.

**Lump names end at the first NUL.** Editors don't always zero the remaining bytes of an
8-byte name field, so anything after the terminator is leftover from a previous edit.
Reading it as part of the name turns `"-"` into `"-GRAY7"` and breaks real PWADs.

**Floors.** `SEGS` only stores edges that lie on real linedefs — the edges created by BSP
splits are not in the WAD. `render/bsp.ts` therefore rebuilds each subsector by taking a
quad covering the whole map and clipping it against every partition line on the path from
the root down to that leaf, then against the subsector's own segs. The result is convex,
so a triangle fan is enough.

**Walls.** Built per linedef from the sidedefs: one-sided lines get their middle texture
over the full sector height, two-sided lines get upper/lower steps plus an optional masked
middle. Vertical texture alignment follows DOOM's pegging rules (`LOWER_UNPEGGED` /
`UPPER_UNPEGGED`), so door tracks and step textures line up the way they do in the
original.

**No back faces.** Walls are drawn single-sided, facing the way DOOM defines as their
front. Walls between the camera and the player are therefore culled automatically, which
is what produces the open dollhouse look without any extra logic.

**Occlusion fading.** Back-face culling doesn't help when a wall legitimately faces the
camera but still sits on the camera→player sightline (a pillar in front of the player, say).
`render/occlusion.ts`'s `WallFader` tests every wall quad against that sightline each frame
and fades the ones crossing it — as a dithered per-pixel discard rather than real alpha
blending, since wall quads are batched per texture across the whole map and blending would
need a meaningless whole-level draw order. That keeps faded walls in the ordinary
depth-tested opaque pass.

**Coordinates.** Everything stays in DOOM map units. DOOM's `(x, y, z)` becomes three.js
`(x, z, -y)`, so the map plane is XZ and Y is up.

## Checking a WAD without a browser

```bash
node scripts/inspect-wad.ts public/wads/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/wads/iwad/DOOM2.WAD MAP05 public/wads/pwad/SCYTHE.WAD
```

Reports lump and map counts, which file a map came from, any textures it references but the
WAD set lacks, how many subsector polygons came out degenerate, and whether the player start
is walkable.

## State

Playable as a walkable level viewer: geometry, textures, sector lighting, collision with
step-up/headroom rules, gravity-based falling off ledges, vanilla's narrow-gap-crossing
quirk, floor following, map switching, PWAD loading, and an orbitable camera (right-drag or
`Q`/`E`) with wall-occlusion fading. Fog of war hides rooms and secrets until the player has actually seen
them. THINGS render as upright sprites (monsters, weapons, ammo, health/armor, keys,
powerups and common decorations), and the player is drawn as the real `PLAY` sprite with a
facing-driven rotation frame and a walk-cycle animation. Health, armor, ammo, keys and
weapons are collectible and tracked on a HUD (weapon ownership isn't usable yet — no select
UI or shooting); doors, lifts, floor movers, crushers, switches and teleporters all work,
including locked doors, which require the matching key. Not yet: monster AI/combat, weapon
switching/shooting, sound.
