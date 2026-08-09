# WAD loading and merging

`src/wad/`, `src/wad/library.ts`, `plugins/wad-manifest.ts` — the menu that drives all this is
docs/menu.md

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

## Level names

`levelnames.ts` answers "what is this map called" for the level card (docs/items.md § Level card)
and for the menu's level list (docs/menu.md § Picking a WAD set). A map lump name is not an answer
on its own: DOOM II, Plutonia and TNT all ship `MAP01`-`MAP32` with completely different titles, and
a PWAD's `MAP01` is not the IWAD's level of that name at all.

Two entry points over the same rules. `levelTitleFor` returns the level's **title alone** or
`undefined` — that's what the menu appends after the lump name it already prints. `levelNameFor`
turns the same lookup into something always printable, for the card, which shows one line and no
lump name. Titles are stored and returned bare (`Hangar`, not `E1M1: Hangar`): every place one is
shown either prints the lump name itself or has just come from a screen that did.

Ahead of both, for the card only, is **the WAD's own level-name graphic**: `LevelNames.graphicFor`
returns the `CWILV`/`WILV` lump vanilla's intermission prints a level's name with, and the card
blits that instead of drawing text (docs/items.md § Level card). `levelNamePatch` builds the name
the way `WI_loadData` (`wi_stuff.c`) does — `CWILV%2.2d` over a 0-based map index, `WILV%d%d` over
0-based episode and map, so `MAP07` is `CWILV06` and `E1M1` is `WILV00`. A patch is only used when
it *belongs* to the map: one from a different file than the map counts only if the map came from
the IWAD (a graphics add-on replacing the base game's name patches), so a PWAD that replaces
`MAP01` without replacing `CWILV00` doesn't announce itself with the IWAD's name for a different
level — the same trap rule 2 below exists for.

Text resolution order, highest authority first:

1. **The WAD set's own MAPINFO** (`mapinfo.ts`). `UMAPINFO`, `ZMAPINFO` and `MAPINFO` lumps are read
   by one tokenizer covering every syntax that names a level: ZDoom's `map MAP01 "Title"` (with or
   without a `{ … }` block), UMAPINFO's `map MAP01 { levelname = "Title" }`, and Hexen-format
   numeric `map 01 "Title"`. `map MAP01 lookup HUSTR_1` names no literal and is **skipped**, falling
   through to the table below — which is the same string it was pointing at. Property blocks are
   walked brace-by-brace rather than by keyword, so a `map` *property* nested in one can't be
   mistaken for the next level. Later files win, matching the merged directory; within one file
   `ZMAPINFO` suppresses that file's `MAPINFO`, as in ZDoom. A MAPINFO title applies even to a map
   the IWAD provides — renaming the base game's levels is what the lump is for.
2. **The vanilla title table**, but only for a map the *IWAD* provides. `LEVEL_NAMES` is all 132
   `HUSTR_*`/`PHUSTR_*`/`THUSTR_*` strings from `linuxdoom-1.10/d_englsh.h`, generated from that
   header rather than transcribed by hand, TNT MAP05's "hanger" included — with two deliberate
   edits, both because a title here is never the only thing on screen: the leading identifier is
   stripped (`"level 1: entryway"` → `"Entryway"`), and the first letter is capitalized, since id
   wrote DOOM 1's strings capitalized and the other three lowercase and the menu prints them as
   plain DOM text. Which of the four tables applies comes from the IWAD's **file name**, the same
   sniff vanilla's own `D_IdentifyVersion` (`d_main.c`) does. The match is on the whole name, never
   a substring: `freedoom2.wad` is not `doom2.wad` and must not inherit titles for maps it names
   nothing like.

With no title from either, there is nothing to append in the menu, and the card falls back to
`<file> <lump>` for a PWAD-provided map (`SCYTHE.WAD MAP05` — which file it came from is the only
true thing left to say about it) or the bare lump name for anything else: an unrecognised IWAD, or a
map outside its mission's table such as `E5M1`.

`LevelNames` is built once per `Game`: both the MAPINFO parse and the IWAD identification depend on
the loaded file set, not on which map is current. The menu can't build one — it hasn't downloaded
anything yet — so it resolves off the manifest instead, which is why `WadManifestEntry` carries each
file's own MAPINFO titles (§ The `public/wads/` manifest) and `mergedMaps` (`library.ts`) merges
them the same way, later files winning.

## The `public/wads/` manifest

The Vite plugin scans `public/wads/{iwad,pwad}/`, reading each file's header and directory (a few KB
even for a 14 MB IWAD) plus its MAPINFO lump if it has one, and serving that as `/wads/index.json`
(dev middleware and build-time `emitFile`), so the menu can list types/sizes/map counts and name
levels without downloading anything. Bytes are only fetched when a level actually starts, and
`library.ts: serverSource` memoizes them, so restarting the same WAD set costs no download. A WAD
picked from disk has no manifest entry, so `uploadedSource` parses its MAPINFO itself — the bytes
are already in memory by then.

**The folder a file sits in decides how it's served, regardless of its own IWAD/PWAD signature** — a
mod placed in `wads/iwad/` becomes a selectable game WAD (useful for a PWAD that carries its own
maps); the plugin warns on mismatch but still serves it.

**A WAD's own maps say which game it belongs to** (`library.ts: mapStyle`): `ExMy` → DOOM 1,
`MAPxx` → DOOM II, and the two never mix within one game. A WAD with no maps of its own (textures,
sounds, …) has no style and fits either — `describeSource` shows its lump count instead of a map
count so it doesn't read as an empty file. What the menu *does* with that is docs/menu.md
§ Picking a WAD set.
