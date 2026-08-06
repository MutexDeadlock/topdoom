# WAD loading, merging and the start menu

`src/wad/`, `src/ui/menu.ts`, `src/wad/library.ts`, `plugins/wad-manifest.ts`

## Loading and merging

`WadFile` (`wad.ts`) parses one physical file (header + lump directory). `Wad` concatenates several
`WadFile`s into the single merged lump directory the rest of the engine reads, with **later files
winning on name collisions** — that one rule gives PWAD overrides for free (a replaced `MAP01` marker
resolves to the add-on, and its map lumps follow it contiguously).

Two deliberate deviations from vanilla lump-lookup semantics, both load-bearing:

- **Marker ranges** (`F_START`/`F_END` for flats) nest and every file may open its own, so
  `Wad.markedRange` counts depth instead of spanning first-marker-to-last-marker.
- **Texture definitions are merged by name across all files' `TEXTURE1`/`TEXTURE2`**
  (`graphics.ts: readAllTextures`), not resolved by last-lump-wins like vanilla. Vanilla treats a
  PWAD's `TEXTURE1` as a full replacement of the IWAD's, which breaks IWAD/PWAD pairings the PWAD
  wasn't built for. Patch indices inside each texture are still per-file, resolved through that file's
  own `PNAMES` at merge time.

**Lump names end at the first NUL** (`reader.ts: name8`) — editors don't always zero the remaining
bytes of the 8-byte name field, so trailing bytes can be leftovers from a previous edit. Reading past
the first NUL silently corrupts names (e.g. turns `"-"` into `"-GRAY7"`) and breaks texture resolution
for real PWADs. This was found by testing against community PWADs, not synthetic data, so don't assume
synthetic WADs will catch a regression here.

## Player start

`World.playerStart` uses the **last** doomednum-1 thing in the map, not the first. Vanilla's
`P_SpawnMapThing` calls `P_SpawnPlayer` for *every* player-1 thing it encounters and each call
overwrites `players[0].mo`, so whichever comes last in the thing list is where the player actually
ends up; every earlier one becomes an orphaned "voodoo doll" mobj still sitting on the map (a mapping
trick for scripted effects like crusher-triggered linedefs). Picking the first one instead spawns the
player on top of a voodoo doll — repro: oku2v31.wad MAP01 has 27 doomednum-1 things, 26 of them a
voodoo-doll row and the 27th the real start.

## Start menu

The Vite plugin scans `public/wads/{iwad,pwad}/`, reading each file's header and directory (a few KB
even for a 14 MB IWAD) and serving it as `/wads/index.json` (dev middleware and build-time `emitFile`),
so the menu can list types/sizes/map counts without downloading anything. **The folder a file sits in
decides how it's served, regardless of its own IWAD/PWAD signature** — a mod placed in `wads/iwad/`
becomes a selectable game WAD (useful for a PWAD that carries its own maps); the plugin warns on
mismatch but still serves it.

Menu semantics worth knowing before touching `menu.ts`:

- **Game WAD** list (`renderIwads`) only offers sources with `type === 'IWAD'`. A PWAD mapset can still
  be *played* as the game WAD (via file upload through the IWAD picker, or `?wad=`), but it no longer
  appears in this list to pick from directly.
- **Add-ons** list (`renderPwads`) excludes anything of `type === 'IWAD'` and whichever source is
  currently selected as the game WAD (even a PWAD-typed one uploaded through the IWAD picker) —
  otherwise it would show up twice.
- Files dropped/uploaded from disk are parsed in the browser and behave identically to server-side
  ones; a file uploaded via the "game WAD" picker becomes the game WAD regardless of its declared type,
  a file uploaded via "add-on" is added as an add-on.
- `?wad=&pwad=&map=` preselect and skip the menu entirely. `?pos=x,y` additionally drops the player at
  those DOOM map coordinates instead of the map's own player start, applied *before* fog of war is
  seeded so the reveal shows exactly what is visible from there. **That is the practical way to check a
  specific spot in a level** — the room with MAP01's big window is several rooms away from the spawn, so
  scripting a walk to it is far more work than `?map=MAP01&pos=800,600`.
- **Add-ons are filtered by game** (`library.ts: mapStyle`): a WAD's own maps say which game it belongs
  to (`ExMy` → DOOM 1, `MAPxx` → DOOM II; the two never mix within one game), and an add-on whose style
  conflicts with the selected game WAD is rendered **disabled** rather than hidden — a mapset that's
  simply for the other game is still worth seeing in the list, just not pickable. Switching the game WAD
  calls `pruneIncompatiblePwads` to drop any already-ticked add-on that no longer matches, so the merged
  map list (`mergedMaps`) never silently mixes an E1M1 with a MAP01 mapset. An add-on with no maps of
  its own (textures, sounds, …) has no style and stays selectable regardless — `describeSource` shows
  its lump count instead of a map count, so it doesn't read as an empty file.

`VERSION` (`constants.ts`) is shown bottom-right on the menu, prefixed with `v`; a static credit sits
bottom-left in `index.html`/`menu.css`.
