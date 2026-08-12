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

## Art a WAD set doesn't have

A thing whose sprite the merged set carries no lumps for is **skipped, and the level says so**:
`buildThingSprites` collects `ThingLayer.missingArt` (`"<doomednum> (<sprite>)"`), which `game.ts`
warns about at load beside its missing-texture warning. Vanilla `I_Error`s on startup instead, so
skipping is the better behavior — but skipping *silently* is not, because from the outside the
monster simply isn't in the level and nothing explains why.

The case that hits real users is a **PWAD placing a monster its base WAD never had**: shareware
`DOOM1.WAD` has no `HEAD` lumps at all (the cacodemon appears in no episode-1 map), so a caco placed
on it can't be drawn and can't spawn. Load such a PWAD on `DOOM2.WAD` or `freedoom2.wad`.

Two fallbacks inside `readAllTextures` are silent by design and worth knowing about, because both
present as "some textures are missing" rather than as an error. **A file with `TEXTURE1`/`TEXTURE2`
but no `PNAMES` of its own borrows the last `PNAMES` seen** — texture packs routinely ship the
texture lumps alone and expect the IWAD's patch names. And **a malformed `TEXTUREx` is caught and
costs only that file's textures**, not the whole merged set, so one bad add-on can't take the level
down with it. Anything actually missing at the end still surfaces through the load-time
missing-texture warning.

## Player start

`World.playerStart` uses the **last** doomednum-1 thing in the map, not the first. Vanilla's
`P_SpawnMapThing` calls `P_SpawnPlayer` for *every* player-1 thing it encounters and each call
overwrites `players[0].mo`, so whichever comes last in the thing list is where the player actually
ends up; every earlier one becomes an orphaned "voodoo doll" mobj still sitting on the map (a mapping
trick for scripted effects like crusher-triggered linedefs). Picking the first one instead spawns the
player on top of a voodoo doll — repro: oku2v31.wad MAP01 has 27 doomednum-1 things, 26 of them a
voodoo-doll row and the 27th the real start.

## Level names

`levelnames.ts` answers "what is this map called" for the level card (docs/hud.md § Level card)
and for the menu's level list (docs/menu.md § Picking a WAD set). A map lump name is not an answer
on its own: DOOM II, Plutonia and TNT all ship `MAP01`-`MAP32` with completely different titles, and
a PWAD's `MAP01` is not the IWAD's level of that name at all.

A file may ship several MAPINFO flavours (`UMAPINFO`, `ZMAPINFO`, `MAPINFO`), which are alternatives
for different engines rather than layers, so **exactly one of them is read per file** — the first
`MAPINFO_LUMPS` lists, most preferred first (`preferredMapInfoLump`). That subsumes ZDoom's own
`ZMAPINFO`-instead-of-`MAPINFO` rule without a special case. It matters that `mapinfo.ts` and
`plugins/wad-manifest.ts` share the function rather than each implementing the order: they were once
separate, one iterating the WAD's directory and one iterating the array, so a file carrying both
`UMAPINFO` and `MAPINFO` could show one title in the menu and a different one on the level card.
Across files the ordinary rule still applies — later files win, like the merged directory itself.

Two entry points over the same rules. `levelTitleFor` returns the level's **title alone** or
`undefined` — that's what the menu appends after the lump name it already prints. `levelNameFor`
turns the same lookup into something always printable, for the card, which shows one line and no
lump name. Titles are stored and returned bare (`Hangar`, not `E1M1: Hangar`): every place one is
shown either prints the lump name itself or has just come from a screen that did.

Ahead of both, for the card only, is **the WAD's own level-name graphic**: `LevelNames.graphicFor`
returns the `CWILV`/`WILV` lump vanilla's intermission prints a level's name with, and the card
blits that instead of drawing text (docs/hud.md § Level card). `levelNamePatch` builds the name
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

## Level progression

Which level an exit leads to (`progression.ts`). Vanilla keeps this nowhere in the WAD: it is two
hard-coded tables in `G_DoCompleted` (`g_game.c`), which is why the rules live beside the title
tables rather than being read off a lump. `LevelProgression` is built once per `Game`, next to
`LevelNames` and for the same reason — it depends on the loaded file set, not on the current map.

A level has **two** exits, and until the flag was routed through they behaved identically. The four
vanilla exit linedefs (11, 51, 52, 124 — `wad/specials.ts`) already carried `effect.secret`;
`game.ts` dropped it on the floor and advanced by index, so MAP15's secret exit led to MAP16 and
MAP31 was reachable only from the level select.

Resolution order for `nextMap(map, secret)`, highest authority first:

1. **The WAD set's own MAPINFO** — `next` for the normal exit, `secretnext` (ZDoom) or `nextsecret`
   (UMAPINFO) for the secret one, both spellings read. `parseMapInfo` picks them up in the `{ … }`
   block form and in the old brace-less ZDoom form, with or without the `=`. A value is only used
   if it names a map **the loaded set actually has**: a `next` pointing at a level nobody provides
   would strand the player, and it also disposes of ZDoom's finale keywords (`next = EndGame`),
   which name no map and fall through to the rules below.
2. **Vanilla's tables** (`vanillaNextMap`), applied by map-name scheme, again only when the level
   they name is in the set. `MAP<nn>` follows DOOM II: MAP15's secret exit leads to MAP31, MAP31's
   to MAP32, and a normal exit out of either secret level returns to MAP16. `E<x>M<y>` follows the
   episodes: any secret exit leads to `E<x>M9`, and M9's normal exit returns to the level *after*
   the one hiding its entrance — E1M4, E2M6, E3M7, E4M3, one per episode.
3. **Nothing**, which is `null`. Vanilla ends the game at `MAP30` and at every `E<x>M8`; a PWAD map
   set simply runs out.

A secret exit that resolves to nothing falls back to the normal one rather than doing nothing —
`G_SecretExitLevel`'s own check, written for the German edition of DOOM II, which shipped without
the two Wolfenstein levels: with no MAP31 present the secret switch still ends the level, it just
doesn't lead anywhere special. Here the same rule covers every PWAD that defines part of a
progression.

Where `nextMap` returns null, `Game.resolveNextMap` advances to the **next map in load order**,
which is what every exit did before there was a progression at all. This engine has no finale to
run instead — no victory text, no cast call — so ending the game is not yet something it can do,
and killing the Icon of Sin drops the player into whatever map follows MAP30 in the set.

## Content id

`checksum.ts` gives a `WadFile` a **content id**: a hash of its whole byte range, memoized in a
`WeakMap` keyed on the underlying `ArrayBuffer` rather than on the `WadFile` — the same bytes get
wrapped more than once (an upload hashes its own `WadFile`, `loadWadFiles` builds another over the
same buffer, a restart re-wraps the memoized fetch), and a wrapper-keyed memo misses every time,
re-walking ~14 MB on the level-start path. It is what per-level best times are keyed on (docs/hud.md § Best times), and it is
what a saved game stores as its WAD set — `wadSetId(wad)` returns every loaded file's
`{ name, id }` in load order, a list rather than one combined hash so a mismatch can name *which*
file is wrong. A save uses the id as the file's **identity**, not merely as a check: it is what
`loadSave` re-resolves the library against, so a renamed WAD still loads and the same bytes match
whether they come from the server or from disk (docs/savegames.md § WAD-set identity). That is also
why `plugins/wad-manifest.ts` publishes each server WAD's id — the menu has to know a file's
identity without downloading it.

Two rules hold this up:

- **The id follows the bytes, not the file name.** Renaming a WAD keeps its records; editing one
  loses them, which is correct — an edited WAD is a different WAD.
- **The hash is synchronous, and deliberately not `crypto.subtle`.** `crypto.subtle` is undefined
  outside a secure context, and the Vite dev server reached over a plain-http LAN address is not
  one. An id that depended on how the page was opened would cost a record here and would make a
  save refuse to load once saves key off the same function, so there is one scheme everywhere.
  What that scheme is: two FNV-1a-shaped lanes with different basis and multiplier, run in one pass
  and concatenated to 16 hex chars, with the byte length folded in so a truncated file can't
  collide with the whole one. 13ms for the 14 MB `DOOM2.WAD`.

`Game`'s constructor primes the id for every loaded file, so the cost lands in a load that is
already building every mesh in the level rather than on the frame a level ends.

## The `public/wads/` manifest

The Vite plugin scans `public/wads/{iwad,pwad}/`, parsing each file's header and directory plus its
MAPINFO lump if it has one, and hashing its bytes for the content id (§ Content id) — the file is
already in memory, so the id costs one pass and nothing extra to read. That is served as
`/wads/index.json` (dev middleware and build-time `emitFile`), so the menu can list
types/sizes/map counts, name levels, and know each file's *identity* without downloading anything —
the last being what lets a savegame's WAD set resolve while the save list renders
(docs/savegames.md § WAD-set identity). The dev middleware re-scans on every request for the
manifest, so `describeWad` is memoized on each file's mtime and size (`statSync` is already being
called for the listing): without it every page reload would re-read and re-hash every WAD in
`public/wads/` — tens of MB, on the path that gates `Menu.init`. Editing a WAD still re-describes
it. Bytes are only fetched when a level actually starts, and
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
