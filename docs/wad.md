# WAD loading and merging

`src/wad/`, `src/wad/library.ts`, `plugins/wad-manifest.ts` — the menu that drives all this is
docs/menu-wads.md

## Loading and merging

`WadFile` (`wad.ts`) parses one physical file (header + lump directory). `Wad` concatenates several
`WadFile`s into the single merged lump directory the rest of the engine reads, with **later files
winning on name collisions** — that one rule gives PWAD overrides for free (a replaced `MAP01`
marker resolves to the add-on, and its map lumps follow it contiguously).

Two deliberate deviations from vanilla lump-lookup semantics, both load-bearing:

- **Marker ranges** (`F_START`/`F_END` for flats) nest and every file may open its own, so
  `Wad.markedRange` counts depth instead of spanning first-marker-to-last-marker.
- **Texture definitions are merged by name across all files' `TEXTURE1`/`TEXTURE2`**
  (`graphics.ts: readAllTextures`), not resolved by last-lump-wins like vanilla. Vanilla treats a
  PWAD's `TEXTURE1` as a full replacement of the IWAD's, which breaks IWAD/PWAD pairings the PWAD
  wasn't built for. Patch indices inside each texture are still per-file, resolved through that
  file's own `PNAMES` at merge time.

**Lump names end at the first NUL** (`reader.ts: name8`) — editors don't always zero the remaining
bytes of the 8-byte name field, so trailing bytes can be leftovers from a previous edit. Reading
past the first NUL silently corrupts names (e.g. turns `"-"` into `"-GRAY7"`) and breaks texture
resolution for real PWADs. This was found by testing against community PWADs, not synthetic data, so
don't assume synthetic WADs will catch a regression here.

## Map formats

`map.ts` is the layer's one entry point and `map/` holds the rest, split by what a file owns rather
than by role: `defs.ts` the records themselves (`Vertex`, `Sector`, `SideDef`, `LineDef`, `Seg`,
`SubSector`, `Node`, `Thing`, `DoomMap`) plus the sentinels the WAD encodes them with (`NO_SIDE`,
`NO_LINE`, `SUBSECTOR_BIT`, `SKY_FLAT`, `LF`), and `hexen.ts`/`udmf.ts`/`nodes.ts` one lump format
each. `defs.ts` imports nothing, which is what lets all three seams take their records from it;
`map.ts` re-exports the lot, so nothing outside `map/` names a file inside it.

Beside the BSP encoding, a map has a **lump format**: Doom, Hexen or UDMF, `DoomMap.format`. A
**TEXTMAP** lump directly after the marker is UDMF (§ UDMF), tested first — a UDMF map may carry a
BEHAVIOR lump too. Otherwise detection is the presence of a **BEHAVIOR** lump in the map's own lump
group, which is how gzdoom's `LoadLevel` tells Doom from Hexen and the only reliable signal —
several Hexen maps' LINEDEFS lump size divides evenly by 14 as well as 16, so record-size
arithmetic alone mis-detects them (`Mock2.wad` MAP26 and MAP34 both do). Read wrong, a Hexen map is
not subtly off: linedefs come out pointing at vertexes and sidedefs that don't exist, and the map
draws as garbage while sectors, sidedefs, vertexes and nodes all look perfectly sane. That
asymmetry is the tell.

Only **LINEDEFS** and **THINGS** differ. SECTORS, SIDEDEFS, VERTEXES, SEGS, SSECTORS, NODES, REJECT
and BLOCKMAP are byte-identical in both, so a Hexen map still gets the full node-format treatment
above. `wad/map/hexen.ts` owns those two lumps and normalizes them to the same records and flag bits
a Doom map yields — the same seam `map/nodes.ts` is for the BSP, so `loadMap` branches once per lump
and nothing downstream sees a format difference. The two record layouts are gzdoom `doomdata.h`'s
`maplinedef2_t` and `mapthinghexen_t`:

- **Linedef, 16 bytes**: `v1` `v2` `flags` (u16 each), `special` (u8), `args[5]` (u8), `sidenum[2]`
  (u16) — where Doom's 14-byte record has `special` and `tag` as u16s and no args.
- **Thing, 20 bytes**: `tid` `x` `y` `z` `angle` `type` (i16 each), `flags` (u16), `special` (u8),
  `args[5]` (u8) — where Doom's 10-byte record has no `tid`, `z`, `special` or `args`.

### Flags are translated, not copied

Both flag words overlap Doom's only in their low bits, and the parts that don't overlap collide with
bits that mean something else here — so `loadMap` rewrites them rather than storing them raw. Get
this wrong and the failure is silent.

**Linedef flags**: `ML_BLOCKING` through `ML_MAPPED` (0x0001-0x0100) are shared verbatim. From
0x0200 up they are not: `ML_REPEAT_SPECIAL` (0x0200) sits exactly where Boom put `ML_PASSUSE`, and
`ML_SPAC_MASK` (0x1c00) is the activation field. Those are dropped. `ML_BLOCK_PLAYERS` (0x4000) and
`ML_BLOCKEVERYTHING` (0x8000) both become plain `LF.BLOCKING` — a **deliberate deviation**, since
there is no `LF` bit for "blocks the player but not monsters"; a line drawn as solid stays solid,
at the cost of also stopping monsters ZDoom would let through.

**Thing flags**: the skill bits and `MTF_AMBUSH` (0x0001-0x0008) are shared. Doom's `MTF_NOTSINGLE`
bit is Hexen's `MTF_DORMANT` at the same 0x0010, and Hexen names the modes a thing *is* in
(`MTF_SINGLE` 0x0100) instead of the ones it is kept out of — so the single-player gate **inverts**:
a Hexen thing without `MTF_SINGLE` is exactly a Doom thing with `MTF_NOTSINGLE`, which is the same
correspondence gzdoom's `LoadThings` writes in the other direction (a Doom thing gets every mode
bit, then loses `MTF_SINGLE` for `BTF_NOTSINGLE`). `MTF_DORMANT` and the `MTF_CLASS_MASK`
player-class bits are dropped: there are neither dormant things nor player classes here, and a
dormant monster spawning awake beats it not spawning at all.

### What a Hexen map does not get

**Action specials do not run.** A Hexen line's special is a ZDoom number in a namespace of its own —
62 is `Plat_DownWaitUpStay` there and "SR lower floor" in Doom's table — so passing it through would
fire an unrelated effect rather than none. `LineDef.special` and `.tag` are therefore forced to 0
and the raw number and args are parked in `LineDef.action`, which nothing dispatches;
`inspect-wad`'s coverage report reads it so a map can still say what it asks for. The same goes for
a **thing's** special and args, and for BEHAVIOR itself: that lump is compiled ACS bytecode, and
there is no ACS VM here, so a map whose progression runs through `ACS_Execute` cannot be finished. A
Hexen map draws, collides and fights correctly; its doors, lifts and switches do not move.

A Hexen thing's **`z`** (its height above the floor) is also ignored — things spawn on the floor, or
under the ceiling for the `MF_SPAWNCEILING` types, exactly as in a Doom map.

## UDMF

A UDMF map (UDMF spec v1.1, `udmf.txt`) replaces the binary geometry lumps with one text lump: the
group is **marker, TEXTMAP, any lumps at all, ENDMAP** (§ II.B — ENDMAP is required, and `loadMap`
refuses a group without it, since nothing else says where the map's lumps stop). `mapLumps` and
`describe.ts`'s walk both read a group this way the moment TEXTMAP directly follows the marker;
binary groups keep the `MAP_LUMPS` list. `wad/map/udmf.ts` is the format's seam beside `hexen.ts`
and `nodes.ts`: a single-pass parser (no token list — a TEXTMAP can run to tens of MB) that
normalizes blocks to the same records and flag bits a Doom map yields, in declaration order, which
*is* each record's index (§ II.A) and therefore the identity savegames and the first-match-wins
scans key on. Field names, defaults and the flag translation are the spec's § III tables: linedef
flag keys land on the `ML_` bits in the same order, `sideback` −1 becomes `NO_SIDE`, absent *and
empty* textures become `-` (one spelling of "no texture" past the seam), `lightlevel` defaults to
160, quoted names are upper-cased (every texture lookup keys on upper case), and a thing's `single`
inverts to `MTF_NOTSINGLE` exactly as a Hexen thing's does. Unknown keys and blocks are skipped, as
§ I requires of a compliant parser.

**The namespace decides where specials go** (§ II.C). In `doom` (defined as v1.9 plus every Boom
and MBF special) and `ZDoomTranslated` (gzdoom's `udmf_zdoom.txt` § II.C: "uses Doom-type
specials"), `special` and the tag (`id`, written as both `id` and `arg0` by every compliant
converter — § III's Tag/ID note) feed the vanilla/Boom tables and the map plays in full. Every
other namespace — `zdoom`, `hexen`, `dsda` (a *subset of zdoom*, not of doom — dsda-doom's own
`udmf.md`), `heretic`/`strife` (Doom-shaped fields, their own games' special numbers), or none
— parks `special`+`args` in `LineDef.action` with `special`/`tag` zeroed, exactly the Hexen
treatment above: the map draws, collides and fights; its doors and lifts do not move. Sector `id`
stays the tag in every namespace, so tag-only rules (the 666/667 boss-death scan) still fire.

**The BSP must ship in ZNODES.** A UDMF map's nodes arrive as one `ZNODES` lump behind any of the
eight extended signatures (`readBspZnodes` — there is no second lump to disambiguate against, so
the one buffer is probed against the whole table). There is no node builder here: a UDMF map saved
without ZNODES is `noBsp` (§ Will it run?), the same policy as a nodeless binary map. Ultimate Doom
Builder writes ZNODES on save by default, so released UDMF WADs generally carry them.

Free-form marker names (any lump followed by TEXTMAP) are **out of scope**: map discovery stays
`MAP_MARKER` (`E#M#`/`MAP##`), so a UDMF map under another name is invisible, as before.

## Node formats

`wad/map/nodes.ts` reads the three BSP lumps (SEGS/SSECTORS/NODES) in every encoding Boom- and
ZDoom-era maps actually ship, detected by signature per PrBoom+ `p_setup.c` and gzdoom
`maploader.cpp: LoadExtendedNodes`:

- **Vanilla**: 16-bit records, exactly what `linuxdoom-1.10` reads.
- **DeePBSP V4**: 32-bit vertex indices in segs, 32-bit `firstseg`, 32-bit node children
  (PrBoom+ `doomdata.h`: `mapseg_v4_t` / `mapsubsector_v4_t` / `mapnode_v4_t`). Signs NODES with
  `xNd4\0\0\0\0`.
- **XNOD**: replaces the SEGS/SSECTORS content wholesale — the payload carries its own split
  vertexes in 16.16 fixed point (appended to the map's `vertexes`, so vertex coordinates can be
  fractional), per-subsector seg counts with the start index implicit, and segs that store no
  angle/offset (nothing in the engine reads either; they load as 0). Signs NODES.
- **ZNOD**: XNOD with the payload zlib-compressed. Decoded by `util/inflate.ts`, which exists
  because `loadMap` is synchronous all the way up through session start and therefore cannot await
  a `DecompressionStream`.
- **XGLN / XGL2 / XGL3** and their `ZGL*` compressed twins: the GL family, below. They sign
  SSECTORS.

The eight extended signatures are one table in `nodes.ts` (`EXTENDED`), each saying whether it is
compressed and its GL level — which lump signs it, which seg record it uses and how precise its
partition line is all follow from that level — so the eight differ in two fields rather than in
eight readers. **NODES is tested before SSECTORS**, the order gzdoom's `LoadLevel` uses: a
map built with both (`zdbsp -g -X`) ships XNOD in NODES beside XGLN in SSECTORS, and the plain
nodes are the ones it means for an engine not drawing from GL segs.

**`Node` is a class, never a literal shape.** V8 gives every object literal of one field count a
shared transition tree, so a runtime literal opening with the same fields that stores a double where
a node holds an integer — `ShotPath` (six fields, `x`, `y` first) against
`{x, y, dx, dy, rightChild, leftChild}` — generalizes the shared ancestor and deprecates the node
map. A load never migrates a deprecated map, so `subsectorAt`'s feedback stays unusable and every
caller inlining it re-deoptimizes for the rest of the level: on NUTS.WAD a quarter of the monster
tic. A class has a tree of its own (docs/conventions.md § Named arguments). The other map records
stay literals; `Thing`'s map is deprecated the same way and harmlessly, nothing reading it after
spawn — a record that gains a per-tic reader gets the same treatment.

### GL nodes

A GL BSP differs from a plain one in that its subsectors are **closed**: the node builder adds the
edges its own splits introduced, which no linedef backs. Three things follow, and they are the whole
of what the GL family costs.

**A seg's second vertex is not stored.** A leaf's segs run in order around its boundary, so each
one's `v2` is the next one's `v1`, wrapping at the end of the leaf — the rule gzdoom's `LoadGLZSegs`
reconstructs them by, and what `tests/wad/glnodes.test.ts` pins by checking that every seg on a real
line has *both* ends on that line. The `partner` field beside it is read past; nothing here walks
between leaves.

**A miniseg — an edge on no linedef — loads with `linedef` = `NO_LINE`** (-1, not either format's
own `0xFFFF`/`0xFFFFFFFF`, so it indexes `linedefs` as `undefined` whatever the map's line count).
`render/bsp.ts` then drops minisegs from the leaf's wall list entirely: a miniseg lies on the
ancestor partition the cell has already been clipped by, so clipping by it again is measured to
change no polygon on E1M1, and every repair that follows — the wall that stops inside its leaf, the
wrong-side seg, the self-referencing leaf — asks a question about a *linedef*, which a miniseg has
none of. Nothing else in `src/` reads `Seg.linedef`.

**XGL3 stores the partition line in 16.16 fixed point**, where XGLN and XGL2 store whole units; and
XGL2 and XGL3 name a seg's line in a u32 where XGLN uses a u16. Those two fields are the only
record differences between the three levels.

A GL payload whose seg count disagrees with what its subsectors claim is refused rather than read
past — gzdoom's own check, and the alternative is every seg index past the first short leaf naming
a different edge than the file does.

Everything is normalized at read time to **one in-memory convention**: node children are 32-bit
with `SUBSECTOR_BIT = 0x80000000` marking subsector references, whatever the disk stored. Vanilla's
quirks are folded in the way PrBoom+ `P_LoadNodes` does it — a `0xFFFF` child resolves to
subsector 0 (where PrBoom's `-1` lands in `R_PointInSubsector`), an out-of-range subsector index is
clamped to 0 — so `World.subsectorAt` and `render/bsp.ts` never see a format difference.

## REJECT

`loadMap` decodes every map lump the engine reads straight into `DoomMap`; REJECT is the one that
carries a policy with it. It is a bitmap of `numSectors²` bits, one per **ordered** pair, the bit at
`s1 * numSectors + s2` set when a sight line between those two sectors is impossible — vanilla's
`P_CheckSight` early-out, and what `World.sightRejected` reads (docs/world.md § REJECT).

`readReject` hands over `undefined` — "reject nothing" — in three cases, and only the first is what
vanilla does:

- **Absent.** No REJECT lump for the map.
- **Shorter than `ceil(numSectors² / 8)` bytes.** A deliberate departure: vanilla indexes
  `rejectmatrix` with no bounds check whatsoever (`p_sight.c`), so a truncated table there reads
  whatever happens to follow it in memory and blinds monsters at random. A short lump is a build
  error rather than data, and dropping it is the safe reading.
- **All-zero.** Behaviorally identical to keeping it — every bit is clear, so nothing is ever
  rejected — but recognizing it at load keeps the check off the hot path entirely. Not a corner
  case: SCYTHE.WAD ships correctly sized, entirely zero tables on all 32 maps, as node builders that
  skip reject computation generally do.

`scripts/inspect-wad.ts` prints the loaded map's table and how much of it is set.

## ANIMATED and SWITCHES

Boom's two table lumps, both a WAD's own replacement for a table the engine otherwise hardcodes.
`wad/animated.ts` and `wad/switches.ts` decode them; both are read once per WAD set in `game.ts`'s
constructor, beside the graphics bank, since neither depends on which map is loaded. Absent — which
is every stock IWAD — the built-in tables stand.

Record layouts, both byte-packed (`p_spec.c: animdef_t`, `p_spec.h: switchlist_t`):

| Lump | Record | Terminator |
|---|---|---|
| `ANIMATED` | 23 B — `int8 istexture`, `char endname[9]`, `char startname[9]`, `int32 speed` | `istexture == -1` |
| `SWITCHES` | 20 B — `char name1[9]`, `char name2[9]`, `int16 episode` | `episode == 0` |

Three things about these that are easy to get wrong:

- **The names are 9-byte NUL-terminated, not the directory's 8-byte padded form**, so `Reader.name8`
  does not fit; `Reader.name(width)` is the shared implementation both use. The upper-casing it does
  is load-bearing — every texture and flat lookup keys on upper case.
- **The terminator can be a partial record.** BOOMEDIT.WAD's `ANIMATED` is 510 bytes: 22 whole
  records plus 4. So the reader tests the `istexture` byte *before* requiring the rest of its
  record.
- **`ANIMATED` replaces the built-in table, it does not merge.** `P_InitPicAnims` builds its whole
  list from the one lump, and `Wad.find` returning the last definition is exactly that rule. A PWAD
  shipping a partial `ANIMATED` really does lose the vanilla animations — real Boom behavior, not
  something to paper over. (Contrast `TEXTUREx`, which this engine *does* merge across files —
  § Loading and merging.)

**SWITCHES' `episode` field is deliberately ignored.** Vanilla filters on it (1 = shareware,
2 = registered, 3 = commercial) to keep switches whose textures the running IWAD lacks out of the
list — but PrBoom+ already drops unknown-texture entries outright, and texture existence is the only
thing that number was ever a proxy for. `switchPairs` applies the existence check against the
graphics bank and skips the episode. Honouring it would make switch behavior depend on the IWAD's
*file name* (`missionOf`, already null for any renamed IWAD), a strictly worse signal.

The decoded pairs become a bidirectional lookup replacing `switchPairTexture`'s `SW1`/`SW2` name
convention — Boom pairs need not share a suffix, which is the whole reason a table beats the
convention. It is threaded as a parameter through `findSwitchEntries` and `scanSectors`
rather than held as a module singleton, so both stay pure functions of the map; the controller takes
the same lookup for the same "must not disagree" reason it takes `movableSectors`
(docs/specials.md § A switch only flips when it acts).

## DEHACKED

A `DEHACKED` lump is a text patch over the engine's own data tables — level titles, par times,
monster stats — in the same family as § ANIMATED and SWITCHES, where a WAD's own data replaces the
built-in table. It differs in one way worth knowing here: `DEHACKED` lumps **merge cumulatively**
across the set rather than the last one winning, because DEH patches stack in every engine that
reads them. Later files still win per key.

`game/dehacked.ts` owns the reading and docs/dehacked.md the format. Only the in-WAD lump is read;
standalone `.deh`/`.bex` files are not loadable.

## GLDEFS

A `GLDEFS` (or `DOOMDEFS`) lump defines GZDoom's dynamic lights and binds them to sprite frames.
Like `DEHACKED` and unlike the MAPINFO family (§ Level names), **every** such lump in the set is
read, in load order, layering: a later definition of the same light name or frame binding replaces
the earlier one, which is GZDoom's own rule (`gldefs.cpp: LoadGLDefs`). They layer over the stock
definitions the engine ships (§ The WAD the engine ships) rather than replacing them wholesale.

`wad/gldefs.ts` owns the reading and docs/lights.md the format, including which of GZDoom's block
types are read and which are skipped.

## The WAD the engine ships

Three things no game WAD provides — GZDoom's stock light definitions, the secret chime
(docs/audio.md § Player and pickups), and the weapon-matching player sprites
(docs/sprites.md § Weapon-matching player sprites) — ship as one PWAD, `topdoom.wad`, fetched once
per session by `wad/shipped.ts`.

**It is never merged into the loaded set.** It is a `WadFile` of its own, read by name, so nothing
in it can override a lump a player supplied — and nothing a player supplies can shadow it. That is
also why the sprites keep their own `S_START`..`S_END` block: it is what `SpriteBank` indexes, and
the other two lumps must stay outside it.

**Nothing is committed.** The three sources stay editable under `assets/` (`gldefs.txt`,
`secret.ogg`, `playerskins.wad`, the last built from a PK3 by `scripts/build-playerskins.ts`), and
`plugins/game-wad.ts` folds them into `/game/topdoom.wad` — served live in dev, emitted at build,
using `wad/write.ts`. It shares the `/game/` prefix with the served WAD folders and the manifest
(§ The `public/game/` manifest) but is not a file under `public/`. Lump names and the served path
are `wad/shipped.ts`'s constants, imported by the plugin, so producer and consumer cannot drift.

**Every reader degrades on its own.** A load that fails leaves lights off, the player drawing the
set's own `PLAY` art, and secrets silent; none of it may keep a level from starting.

## Colormap lumps

Beside `COLORMAP` itself, a Boom WAD can ship **named colormap lumps** — 34 rows of 256 palette
indexes each (32 light levels, the invulnerability row, one spare) — and point a 242 line's sidedef
at them to recolour the view inside, under or over that sector
(docs/specials-transfers.md § Deep water). BOOMEDIT.WAD ships seven (`BLUMAP`, `REDMAP`, `GRNMAP`,
…).

`wad/colormaps.ts: colormapTint` decodes one to a single **per-channel multiplier**, not to a
remap table: for each of the 256 palette entries it sums the channel through row 0 and without it,
and returns the ratio. A blue water colormap pushes the whole palette toward its blues, so its red
and green sums collapse while blue holds — which is exactly the multiply a full-screen tint wants.
The full remap is a per-pixel palette lookup an RGBA renderer has no place for; the cast is the part
that survives into RGB, and the plain IWAD `COLORMAP` correctly comes out as no tint at all.

Lookup is by name against the whole merged directory rather than by scanning the `C_START`/`C_END`
markers vanilla's `R_ColormapNumForName` uses — this engine has no lump namespaces — with the
34×256 length as the check. A name that resolves to nothing, or to a lump of the wrong size, is an
ordinary texture name instead, which is the same fallback Boom applies (`p_setup.c:
P_LoadSideDefs2`). That is also what keeps those names out of the missing-texture report.

## Art a WAD set doesn't have

A thing whose sprite the merged set carries no lumps for is **skipped, and the level says so**:
`buildThingSprites` collects `ThingLayer.missingArt` (`"<doomednum> (<sprite>)"`), which `game.ts`
warns about at load beside its missing-texture warning, and puts on screen as a center message
(`missingArtMessage`, docs/hud.md § Center messages) — the console names the doomednums, the message
says how many. Vanilla `I_Error`s on startup instead, so skipping is the better behavior — but
skipping *silently* is not, because from the outside the monster simply isn't in the level and
nothing explains why.

Skipping also **shifts every later `posed` index and the kill/item totals**, which is why it is what
a stand-in game WAD can cost a save or replay (docs/savegames.md § A stand-in game WAD).

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
ends up; every earlier one becomes an orphaned "voodoo doll" mobj still sitting on the map (a
mapping trick for scripted effects like crusher-triggered linedefs). Picking the first one instead
spawns the player on top of a voodoo doll — repro: oku2v31.wad MAP01 has 27 doomednum-1 things, 26
of them a voodoo-doll row and the 27th the real start.

## Level names

`campaign/names.ts` answers "what is this map called" for the level card (docs/hud.md § Level card)
and for the menu's level list (docs/menu-wads.md § Picking a WAD set). A map lump name is not an
answer on its own: DOOM II, Plutonia and TNT all ship `MAP01`-`MAP32` with completely different
titles, and a PWAD's `MAP01` is not the IWAD's level of that name at all.

A file may ship several MAPINFO flavours (`UMAPINFO`, `ZMAPINFO`, `MAPINFO`), which are alternatives
for different engines rather than layers, so **exactly one of them is read per file** — the first
`MAPINFO_LUMPS` lists, most preferred first (`preferredMapInfoLump`). That subsumes ZDoom's own
`ZMAPINFO`-instead-of-`MAPINFO` rule without a special case. It matters that `campaign/mapinfo.ts`
and `plugins/wad-manifest.ts` share the function rather than each implementing the order: they were
once separate, one iterating the WAD's directory and one iterating the array, so a file carrying
both `UMAPINFO` and `MAPINFO` could show one title in the menu and a different one on the level
card. Across files the ordinary rule still applies — later files win, like the merged directory
itself.

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
level — the same trap rule 3 below exists for.

Text resolution order, highest authority first:

1. **The WAD set's own MAPINFO** (`campaign/mapinfo.ts`). `UMAPINFO`, `ZMAPINFO` and `MAPINFO` lumps
   are read by one tokenizer covering every syntax that names a level: ZDoom's `map MAP01 "Title"`
   (with or without a `{ … }` block), UMAPINFO's `map MAP01 { levelname = "Title" }`, and
   Hexen-format numeric `map 01 "Title"`. `map MAP01 lookup HUSTR_1` names no literal and is
   **skipped**, falling through to the table below — which is the same string it was pointing at.
   Property blocks are walked brace-by-brace rather than by keyword, so a `map` *property* nested in
   one can't be mistaken for the next level. Later files win, matching the merged directory, and a
   later entry replaces an earlier one outright rather than merging field by field — a PWAD
   redefining a level defines all of it, rather than inheriting half a progression. Within one file
   `ZMAPINFO` suppresses that file's `MAPINFO`, as in ZDoom. A MAPINFO title applies even to a map
   the IWAD provides — renaming the base game's levels is what the lump is for.
2. **A DEHACKED/BEX patch in the set** (docs/dehacked.md § Strings), whether from a BEX `[STRINGS]`
   mnemonic or a vanilla `Text` substitution. Like a MAPINFO title and unlike the table below, it
   applies to any map the set provides, because renaming the base game's levels is exactly what
   such a patch is for. MAPINFO beats it, matching UMAPINFO's own spec.
3. **The vanilla title table**, but only for a map the *IWAD* provides. `LEVEL_NAMES` is all 132
   `HUSTR_*`/`PHUSTR_*`/`THUSTR_*` strings from `linuxdoom-1.10/d_englsh.h`, generated from that
   header rather than transcribed by hand, TNT MAP05's "hanger" included — with two deliberate
   edits, both because a title here is never the only thing on screen: the leading identifier is
   stripped (`"level 1: entryway"` → `"Entryway"`), and the first letter is capitalized, since id
   wrote DOOM 1's strings capitalized and the other three lowercase and the menu prints them as
   plain DOM text. Which of the four tables applies comes from the IWAD's **file name**, the same
   sniff vanilla's own `D_IdentifyVersion` (`d_main.c`) does. The match is on the whole name, never
   a substring: `freedoom2.wad` is not `doom2.wad` and must not inherit titles for maps it names
   nothing like.

The one exception to rules 1 and 2: **every title carries which file defined it
(`TitleFrom.fromIwad`), and the IWAD's own titles name only maps the IWAD still provides** — rule
3's guard, applied to the two above. Without it an IWAD that names its levels in MAPINFO or
DEHACKED announces its own level over an add-on's replacement: repro freedoom2.wad + NUTS.WAD,
whose MAP01 read `Hydroelectric Plant` instead of `NUTS.WAD MAP01`. An add-on's titles are
unaffected and still reach every map in the set. Provenance travels with the title from wherever
the merge across files happens — on the winning entry in `MapInfo`, from
`LoadedDehacked.stringSources` per string — and a DEH string whose source isn't known counts as an
add-on's.

The name graphic is that same precondition at a stricter setting: for a PWAD-provided map, a
foreign file's contribution counts only if it is the same file (`patchFor`), where a title counts
unless it is the IWAD's — a `CWILV` lump is bound to a level slot, while a MAPINFO or DEH title is
written to rename someone's levels. So EPIC.WAD's `MAP01` — which it provides itself, without a
`CWILV00` — declines the IWAD's graphic and falls through to the text where its DEH title is.

The menu names levels off the manifest alone, and gets the same answer. A file's `levelNames` holds
what its MAPINFO says and, for the maps MAPINFO leaves unnamed, what its `DEHACKED` patch says —
merged in that order when the manifest is built, so `mergedMaps` needs no order of its own; it does
tag each title with whether the IWAD is the file that carried it, which is the guard above. That
merge is `campaign/names.ts`' `mergeLevelTitles`, reached through the one `describe.ts: describeWad`
the build-time plugin and `library.ts` both call — for the same reason `preferredMapInfoLump` is
read there: stated in two places, the same file could list one way uploaded and another way served.
docs/dehacked.md § Strings covers the one case where the two can differ.

With no title from any of the three, there is nothing to append in the menu, and the card falls back
to `<file> <lump>` for a PWAD-provided map (`SCYTHE.WAD MAP05` — which file it came from is the only
true thing left to say about it) or the bare lump name for anything else: an unrecognised IWAD, or a
map outside its mission's table such as `E5M1`.

`LevelNames` is built once per `Game`, from a `MapInfo` built alongside it: both the MAPINFO parse
and the IWAD identification depend on the loaded file set, not on which map is current. `MapInfo`
reads the set's lumps **once** and projects them — titles for `LevelNames`, exits for
`LevelProgression`, `D_*` lumps for `LevelMusic` (docs/music.md § Which track a level plays) — so
the three consumers of one lump family don't each re-tokenize it. The menu can't build one — it
hasn't downloaded anything yet — so it resolves off the manifest instead, which is why
`ManifestEntry` carries each file's own MAPINFO titles (§ The `public/game/` manifest) and
`mergedMaps` (`library.ts`) merges them the same way, later files winning.

## What game mode a set is

`campaign/gamemode.ts` answers vanilla's `gamemode`: `shareware`, `registered` or `commercial`.
Vanilla reads it off the IWAD's file name (`d_main.c: IdentifyVersion` — `doom1.wad`, `doom.wad`,
`doomu.wad`), which nothing here can trust: a set is whatever files the player picked, under
whatever names. The set's **map list** decides instead.

| The set provides | Mode |
|---|---|
| any `MAPxx` | `commercial` |
| any `ExMy` past episode 1 | `registered` |
| `E1Mx` only | `shareware` |
| neither scheme (a total conversion's own names), or an empty list | `registered` |

Episode 2 as the registered marker is vanilla's own test: `D_DoomMain` checks `e2m1`-`e3m9` before
believing a WAD is the registered version. Its four companion sprite lumps
(`dphoof`/`bfgga0`/`heada1`/`cybra1`) are deliberately not read — a WAD's art never decides what a
tic does. `retail` is folded into `registered`: nothing here reads Ultimate DOOM's fourth episode
apart from the first three.

An unidentifiable set reads as `registered` on purpose: the mode withholds nothing a DOOM 1 set can
have, so a total conversion is never quietly taken a weapon away from. The only reader so far is
IDKFA's weapon roster (docs/cheats.md § IDKFA); IDCLEV's two spellings are ordered by the *current
map's* name instead, which is a different question (§ Level names).

## Par times

`campaign/pars.ts` answers "how fast was this level meant to be finished", for the intermission's
par row (docs/hud.md § Intermission). It mirrors § Level names: a mission-keyed vanilla table plus a
`ParSources` resolver, keying off the same IWAD identification — `LevelNames.levelMission` exposes
it rather than each identifying the IWAD separately, which is how the two would drift.

The tables are `linuxdoom-1.10/g_game.c`'s two, flattened onto lump names. `pars[4][10]` covers
E1M1-E3M9 and `cpars[32]` covers MAP01-MAP32; `G_DoCompleted` picks between them on
`gamemode == commercial`, which is why Plutonia and TNT use `cpars` too — Final Doom shipped on an
unchanged `doom2.exe`.

**Episode 4 has no par time, deliberately.** `pars` has four rows and `gameepisode` is 4 on Ultimate
Doom's E4, so vanilla evaluates `pars[4][gamemap]` — one row past its own array. That is an
out-of-bounds read rather than a value worth reproducing, so `E4M*` resolves to undefined and the
intermission omits the row.

Resolution order is a DEHACKED/BEX `[PARS]` section first (docs/dehacked.md § Par times), then
the vanilla table.
Unlike a title, the vanilla table is **not** gated on the map coming from the IWAD: a par time is a
target rather than a name, and `G_DoCompleted` has no provenance check — vanilla applies `cpars` to
whatever `MAP01` is loaded.

## The sky texture (`campaign/sky.ts`)

**A set's own MAPINFO wins where it names one** — ZDoom's `sky1` or UMAPINFO's `skytexture`, read
into `MapInfoEntry.sky` — and only where the WAD actually carries that texture; otherwise the
vanilla rule below stands. `sky1` is where the token-by-token walk had to learn to consume a value:
GoingDown writes `sky1 SKY1 0`, whose value is the key's own name, so read naively the scroll speed
became the sky.

Vanilla itself has none of that. It reads the sky off the map's own name
(`g_game.c: G_InitNew`). DOOM II switches at maps 12 and 21 (`SKY1`/`SKY2`/`SKY3`), an episode takes
its own number, and Ultimate DOOM's `E4` clamps to `SKY4`. A name in neither scheme — a PWAD with
its own — answers `SKY1`, which every set has.

`levelSkyArt` composes the two, over the caller's own lookup: a name may be a composite texture or
the bare patch lump a set can ship one as — vanilla accepts only the first, and a mapper naming the
second gets the sky they meant. Where neither name resolves, `render/skytint.ts`, the one consumer,
simply drops the tint.

## Level progression

Which level an exit leads to (`campaign/progression.ts`). Vanilla keeps this nowhere in the WAD: it
is two hard-coded tables in `G_DoCompleted` (`g_game.c`), which is why the rules live beside the
title tables rather than being read off a lump. `LevelProgression` is built once per `Game`, next to
`LevelNames` and for the same reason — it depends on the loaded file set, not on the current map.

A level has **two** exits, and until the flag was routed through they behaved identically. The four
vanilla exit linedefs (11, 51, 52, 124 — `game/specials/tables.ts`) already carried `effect.secret`;
`game.ts` dropped it on the floor and advanced by index, so MAP15's secret exit led to MAP16 and
MAP31 was reachable only from the level select.

Resolution order for `nextMap(map, secret)`, highest authority first:

1. **The WAD set's own MAPINFO** — `next` for the normal exit, `secretnext` (ZDoom) or `nextsecret`
   (UMAPINFO) for the secret one, both spellings read. `parseMapInfo` picks them up in the `{ … }`
   block form and in the old brace-less ZDoom form, with or without the `=`. A value is only used
   if it names a map **the loaded set actually has**: a `next` pointing at a level nobody provides
   would strand the player. ZDoom's finale keywords (`next = EndGame`/`EndPic`/`EndBunny`/`EndCast`)
   and UMAPINFO's own `endgame`/`endpic`/`endbunny`/`endcast` keys name no map on purpose and are
   read as one value, `MAPINFO_END` — the set saying the campaign ends here, which needs no map to
   exist for it. This engine runs no finale of its own (docs/hud.md § End card), so which of the
   four a set asked for makes no difference; only an explicit `endgame = false` records nothing.
2. **Vanilla's tables** (`vanillaNextMap`), applied by map-name scheme, again only when the level
   they name is in the set. `MAP<nn>` follows DOOM II: MAP15's secret exit leads to MAP31, MAP31's
   to MAP32, and a normal exit out of either secret level returns to MAP16. `E<x>M<y>` follows the
   episodes: any secret exit leads to `E<x>M9`, and M9's normal exit returns to the level *after*
   the one hiding its entrance — E1M4, E2M6, E3M7, E4M3, one per episode.
3. **Nothing**, and *which* nothing is the point.

The answer is a `NextLevel`, and its three cases must stay distinct — collapsing the last two into
one `null` is what sent MAP30 to MAP31 and E1M8 to E1M9:

- `{ kind: 'map' }` — load that level.
- `{ kind: 'end' }` — **vanilla ends the run here**: `G_DoCompleted`'s `case 8: gameaction =
  ga_victory` for every `E<x>M8`, and its missing MAP30 case (the Icon of Sin's death *is* the
  ending). `scope` says which of the two, and `next` carries the following episode's first map
  (`E1M8` → `E2M1`) — named unconditionally and uncapped by the table, then kept only if the loaded
  set provides it, so Ultimate DOOM's E1M8 continues into E2M1 while shareware's ends there. That
  is a deliberate deviation: vanilla returns to the title screen and makes the player pick the next
  episode (docs/hud.md § End card).
- `{ kind: 'unknown' }` — no rule at all, for a PWAD naming its maps its own way.

`case 8` sits **before** `G_DoCompleted` reads `secretexit`, so *either* exit out of an `E<x>M8`
ends the episode — a secret exit there never reaches M9. No stock map has one, but a PWAD's E1M8
might, and the table's order says so.

A secret exit that resolves to nothing falls back to the normal one rather than doing nothing —
`G_SecretExitLevel`'s own check, written for the German edition of DOOM II, which shipped without
the two Wolfenstein levels: with no MAP31 present the secret switch still ends the level, it just
doesn't lead anywhere special. Here the same rule covers every PWAD that defines part of a
progression.

Only on `unknown` does `Game.resolveExit` advance to the **next map in load order**, which is what
every exit did before there was a progression at all. An `end` raises the end card instead
(docs/hud.md § End card), and loads `next` after it where the set had one — this engine still runs
no vanilla finale, no victory text and no cast call, but ending the run is no longer something it
cannot do.

## Content ID

`checksum.ts` gives a `WadFile` a **content ID**: a hash of its whole byte range, memoized in a
`WeakMap` keyed on the underlying `ArrayBuffer` rather than on the `WadFile` — the same bytes get
wrapped more than once (`loadWadFiles` wraps the buffer an upload already hashed, a restart re-wraps
the memoized fetch), and a wrapper-keyed memo misses every time,
re-walking ~14 MB on the level-start path. **Everything that needs an ID goes through `idOf` (or
`wadId`, which is `idOf` over the file's buffer), never `hashBytes` directly** — the menu hashes an
upload's bytes long before the level start wraps that same buffer, and a direct call leaves the memo
empty for the wrapper to miss on exactly the path the memo exists for. It is what per-level best
times are keyed on (docs/hud.md § Best times), and it is what a saved game stores as its WAD set —
`wadSetId(wad)` returns every loaded file's `{ name, id }` in load order, a list rather than one
combined hash so a mismatch can name *which* file is wrong. `mapProvider(wad, map)` is the same pair
for the one file supplying a map — a save's `mapWad`, and what best times are keyed on. A save uses
the ID as the file's **identity**, not merely as a check: it is what `loadSave` re-resolves the
library against, so a renamed WAD still loads and the same bytes match whether they come from the
server or from disk (docs/savegames.md § WAD-set identity). That is also why
`plugins/wad-manifest.ts` publishes each server WAD's ID — the menu has to know a file's identity
without downloading it.

Two rules hold this up:

- **The ID follows the bytes, not the file name.** Renaming a WAD keeps its records; editing one
  loses them, which is correct — an edited WAD is a different WAD.
- **The hash is synchronous, and deliberately not `crypto.subtle`.** `crypto.subtle` is undefined
  outside a secure context, and the Vite dev server reached over a plain-http LAN address is not
  one. An ID that depended on how the page was opened would cost a record here and would make a
  save refuse to load once saves key off the same function, so there is one scheme everywhere.
  What that scheme is: two FNV-1a-shaped lanes with different basis and multiplier, run in one pass
  and concatenated to 16 hex chars, with the byte length folded in so a truncated file can't
  collide with the whole one. 13ms for the 14 MB `DOOM2.WAD`.

`Game`'s constructor primes the ID for every loaded file, so the cost lands in a load that is
already building every mesh in the level rather than on the frame a level ends.

**When each kind of source pays for it** follows from that 13ms/14 MB, and the three answers
differ on purpose:

- A **server file** is hashed at build time by the manifest plugin, whose bytes are in memory
  anyway — the alternative is downloading every WAD in `public/game/` to draw the save list.
- An **upload** is hashed as it is added, in `uploadedSource`: the bytes are already in memory, and
  the save list matches by ID and renders synchronously.
- A **library file** is hashed only when it is picked (`library.ts: ensureWadId`, then
  `rememberLibraryId` writing it back to the scan memo), because its folder may hold hundreds of
  files that will never be loaded — § The player's own library. Until then its `WadSource.id` is
  `''`, which is the same "matches no savegame rather than matching wrongly" degrade a manifest
  predating the field gets. Picking is strictly before a file can appear in a save, so the deferral
  is invisible: no save is ever written against an unidentified WAD.

## The player's own library

A folder on the player's disk, listed in the menu beside the server's own WADs and remembered
between visits — `library/disk.ts` and `library/store.ts`, driven by `ui/menu/library.ts`
(docs/menu-wads.md § WAD Library).

`library.ts` is the layer's one entry point and re-exports everything under `library/`; nothing
outside the directory imports into it. The split is by where a source comes from, over the shapes
they share:

| File | Owns |
|---|---|
| `library/defs.ts` | `WadSource`, `ManifestEntry`, `Progress`, and the pure rules over them — `servedFolder`, `mapStyle`, `fitsGameWad`, `pwadsFor` |
| `library/manifest.ts` | the server's own files: `WAD_DIR`, `MANIFEST_PATH`, `fetchLibrary`, the streaming download |
| `library/disk.ts` | the player's folder: picking it, the permission, the scan |
| `library/store.ts` | where that folder and its scan memo are remembered |
| `library/textfile.ts` | the `.txt` beside a WAD — § The text file beside a WAD |
| `library.ts` | uploads, `ensureWadId`, `mergedMaps`, `loadWadFiles` |

**The shapes live in `defs.ts`, not in the parent.** A child taking `WadSource` from `library.ts`
would import back out of its own entry point, and `library.ts` imports every child — a cycle that
only survived because the edge was `import type` and got erased.

**Storage is IndexedDB, and there is no choice about it.** A `FileSystemDirectoryHandle` is
structured-cloneable but not JSON-serializable — `JSON.stringify(handle)` yields `{}` — so
`localStorage` cannot hold one, which is why this is the one persisted thing in the menu that isn't
a field of the settings object (docs/menu.md § Persisted settings). It gets its **own** database,
`topdoom-wadlibrary`, rather than a `DB_VERSION` bump on the one holding savegames
(`game/savestore.ts`): a failed upgrade here must not be able to take saves down with it. The
request plumbing *is* shared — `asPromise`, `txDone` and `idbOpener` come from `util/idb.ts`; the
databases are what stay apart. Every call in `library/store.ts` is best-effort — a browser with
IndexedDB disabled degrades to "no remembered folder" rather than throwing on the boot path.

Two stores. `root` holds the handle. `descriptors` is the **scan memo**, keyed by path relative to
the root and validated on read against size and mtime — the same shape `plugins/wad-manifest.ts`
memoizes with server-side, and for the same reason: re-opening the overlay must not re-read the
folder. A file whose size or mtime moved is re-described; everything else is free.

**Chromium only remembers.** `showDirectoryPicker()` is the File System Access API, which Firefox
and Safari don't implement. Those go through `<input type="file" webkitdirectory>`, whose flat
`FileList` carries the folder structure in each file's `webkitRelativePath`, so the tree and the
rows are identical — but there is no handle, so nothing is written to the memo and the folder must
be picked again after a reload. `pickerBlock()` is the split, and the overlay says which side the
player is on rather than leaving them to discover it.

**The method existing on `window` is not enough to know it can be called.** The pickers run in a
top-level document or a *same-origin* frame only; a cross-origin frame gets a `SecurityError`. So
`pickerBlock` also asks `inCrossOriginFrame()`, which compares the framing page's origin and
treats the read *throwing* as the answer, since that read is itself blocked cross-origin. The case
that hits real users is **VS Code's Simple Browser**, which loads the dev server into an `<iframe>`
inside a `vscode-webview://` page: everything else about the library works there, and without this
check the overlay would offer the picker, the call would throw, and the button would read as dead.
`LibraryUi.choose` falls back to the plain input on a throw as well, so an embedding neither check
anticipates still gets a working — if unremembered — folder rather than an error.

`pickerBlock()` is what the overlay actually reads: `''`, `'unsupported'` or `'framed'`, kept apart
because they ask different things of the player. A browser without the API is nothing they can do
anything about; a framed window is fixed by opening the game in a tab of its own, and saying so is
the only way they'd know. `''` doubles as "this browser remembers the folder": the persistence and
the picker are the same API, so they stay one predicate rather than two names for it.

Three rules that are easy to get wrong:

- **A missing permission method is not a refusal.** `queryPermission`/`requestPermission` are
  non-standard and absent in some implementations — Electron's partial File System Access is the one
  that bites, and VS Code is Electron. Absent means there is nothing to ask, not that the answer is
  no: the handle came out of a picker the player just used, so `ensureLibraryAccess` treats it as
  usable and lets a real read fail with a real reason. Reading it the other way refused a working
  handle and made the pick appear to do nothing.
- **A scan that reads nothing says why it read nothing.** `describeAll` drops a file that won't open
  or won't parse rather than failing the whole scan — one junk `.wad` must not cost the folder — but
  keeps the reason in `state.skipped`, which `librarySkips()` exposes and the overlay quotes. An
  empty folder and a folder whose every WAD was unreadable are the same picture in the tree and call
  for opposite responses; discarding the reasons made them indistinguishable.
- **A restore never prompts.** `restoreLibrary` runs on the boot path, inside `Menu.init`, where a
  permission dialog would be an ambush; it reads the handle and the memo and stops. The rows list
  from the memo alone. `ensureLibraryAccess` is what actually asks, and **must be reached from a
  user gesture** — a browser refuses a file-permission request outside one. That is why
  `Menu.startWithSkill` calls it synchronously before its first `await`, the same
  transient-activation trick `main.ts` uses for `audio.resume()` (docs/session.md § Session
  lifecycle).
- **Boot rescans, but only where the permission already stands.** `Menu.init` chains
  `rescanIfPermitted` onto the restore, so a WAD dropped into the folder between visits is listed
  without the player opening the overlay first — the memo made the stale-until-rescanned list the
  common case. `readPermissionStands` is the *query-only* half of the rule above, shared with
  `ensureLibraryAccess` rather than restated: it never requests, because that would be the ambush
  the previous rule forbids and outside a user gesture it is refused anyway. The boot cost is the
  walk plus one `getFile()` per file — `describeAll` opens each before it can compare size and
  mtime — and only a file whose stamp moved is described again; a scan that changed nothing writes
  no memo. `rescanLibrary` logs its file count, how many it re-read and how long it
  took, so a slow folder is visible rather than guessed at.
- **Nothing is restored where there is no handle.** On the fallback path the memo would list files
  the page has no way to read, which is worse than an empty library.
- **A rescan builds fresh `WadSource` objects**, and the selection holds sources by identity — so
  `Menu.setLibrarySources` re-resolves the picks by key rather than letting a file still sitting in
  the folder silently untick itself.

The walk is depth-capped at 8 and count-capped at 2000, so a player who points this at their home
directory gets a truncated list rather than a hung menu. `.wad` files only, case-insensitively —
the same filter `scanFolder` applies to `public/game/`. A folder's `.txt` names ride along as a
listing rather than as files to describe, and only one a WAD actually claimed is kept
(§ The text file beside a WAD), so the caps still bound everything held. On the `webkitdirectory` path all three caps
are `acceptableWads`, exported so the overlay can say how many files it is about to read **by the
rule the scan itself applies**: a count taken by a second, looser copy promises files the scan then
drops.

Files are described `SCAN_WIDTH` (12) at a time rather than one after another. Each costs a
`getFile()` plus up to four short slice reads, all of them round trips the thread waits on rather
than works through, and at the 2000-file cap that wait is the one the player watches. Results are
written by index, not pushed, so a pool finishing out of order doesn't scramble the sorted list.

## The text file beside a WAD

A release's `.txt` — `SCYTHE.TXT` next to `SCYTHE.WAD` — offered from the info column of both WAD
lists and read in the popup (docs/menu-wads.md § The text file popup). `wad/library/textfile.ts`
owns both halves: `siblingTextFile` finds the name, `decodeTextFile` turns the bytes into text. It
reaches the menu as `WadSource.textFile`, a name plus a `read()`.

- **Matched on the base name, case-insensitively, in the WAD's own folder.** `DOOM2.WAD` takes
  `doom2.txt` as readily as `DOOM2.TXT`, and the name that comes back is the one spelled on disk —
  it is the name the fetch or the file handle then has to ask for.
- **Presence comes from a listing, never from a read.** The manifest carries the name
  (`ManifestEntry.textFile`), a library scan takes it from the folder walk, an upload from the batch
  it arrived in. Nothing is read until the player opens it, so the column costs a row nothing.
- **It is a property of the folder, not of the WAD's bytes**, so neither scan memo holds it: both
  merge the current listing's answer onto whatever the memo said — `scanFolder` in
  `plugins/wad-manifest.ts`, `describeAll` in `library/disk.ts`. A `.txt` dropped in later leaves
  every WAD's mtime alone, so a memo that held it would go on saying there is none, and one that
  keyed on it would re-read a whole WAD to learn a name from the directory.
- **An upload's sibling can only arrive in the same pick.** An upload sits in no folder, so
  `Menu.addFiles` pairs the batch's `.txt`s with the WADs beside them and `#file-input` accepts
  `.txt` for it. A `.txt` matching no WAD in the batch is dropped rather than reported as a WAD that
  failed to parse — and the `File` itself is what `uploadedSource` takes, so the read stays where
  every other source has it. The `webkitdirectory` path keeps a matched `.txt` in `state.files` for
  the same reason: it has no handle to reopen the folder with (§ The player's own library).
- **UTF-8 first, CP437 second.** `decodeTextFile` tries a fatal UTF-8 decode and falls back to code
  page 437, because these files are DOS-era: the standard idgames template is ASCII, but the banners
  and rules drawn over it are CP437 box art, which no `TextDecoder` label covers (the encoding
  standard dropped the page) and which latin-1 renders as stray accented letters. A file that
  decodes as UTF-8 at all was written as one — a CP437 banner's high bytes are not valid sequences.
  Line endings are normalised and the DOS end-of-file byte dropped.

## Describing a file without loading it

Three places need to know what a WAD *is* — its type, its maps, its lump count, whether it carries a
DEHACKED patch, and the level titles it names — without building a `Wad` and without the engine's
tables: the build-time manifest, a file the player drops on the menu, and a scan of their own
library folder. `wad/describe.ts: describeWad` is the one implementation, and it is one
deliberately.

The header must be read before the directory, but the MAPINFO and `DEHACKED` bodies the directory
points at depend on nothing but it — so they are read in one `Promise.all`. Over a library scan that
is the difference between one round trip per lump and one per file.
The manifest and the upload path used to state the same rules separately, each carrying a comment
saying the two must not drift, and they had already drifted: `lumpCount` was the header's `numLumps`
served and `entries.length` uploaded.

It reads through a **`ByteRanges`** — `{ size, read(offset, length) }` — rather than taking a
buffer, because a library scan describes hundreds of files it will never load. Over a `File`
(`bytesOfFile`) that resolves to `slice().arrayBuffer()`, so describing a 14 MB IWAD reads the
12-byte header, the directory, at most two lumps, and the first 1 KB of each TEXTMAP (the UDMF
namespace sniff, § Will it run?): a few hundred KB, not the file. `bytesOf` wraps bytes already in
memory, which is what the manifest plugin and an upload hand it.

What it does **not** do is hash. The content ID is a pass over every byte (§ Content ID), and the
three callers want it at three different moments — see there.

Failures are `throw`n, with `WadFile`'s own messages, because an upload has someone waiting on an
answer: `Menu.addFiles` turns the message into the status line. The manifest plugin and the library
scan catch it and leave the file out of the listing instead.

## Will it run?

`wad/support.ts` answers one question about a file the menu has not loaded: **can this engine run
what it ships?** The answer is a `WadSupport` — every reason it can't, worst first, each naming the
maps that raise it — and it is what the WAD Library's support column shows (docs/menu-wads.md § WAD
Library). `describeWad` computes it, so every listing path gets the same verdict.

The `ok`/`partial`/`broken` level is **derived** (`supportLevel`), never stored. Both persisted
copies hold the reasons alone, so reclassifying a code in `SUPPORT_ISSUES` takes effect on rows
written before the change, and no stored record can assert a level its own reasons contradict.

The whole check runs **off the lump directory** — with one exception: a UDMF map's verdict needs
its namespace, which lives in the lump body, so `describeWad` reads the first 1 KB of each TEXTMAP
(the `namespace` assignment is the file's first statement, udmf.txt § II.C) alongside the MAPINFO
and DEHACKED lumps it already reads. Nothing else in a map is read. That constraint is what the
rule set is chosen under, not an implementation detail: a library scan describes hundreds of files
it will never load (§ Describing a file without loading it), so anything needing LINEDEFS or
SECTORS is out — including the linedef/sector special coverage `inspect-wad` reports, which is the
sharper answer and stays the inspector's job. This column says whether a map **loads** and whether
its **format** is one this engine plays fully; the inspector says which of its specials land.

Which lumps belong to a map is `map.ts: MAP_LUMPS` — the same list `loadMap` reads a level by, not
a second copy. A UDMF group is bracketed instead (TEXTMAP … ENDMAP, any lump names between — §
UDMF), which both walks handle as their own state; `MAP_GROUP_LUMPS` widens the binary list with
the stragglers a Hexen map trails after BEHAVIOR (SCRIPTS, DIALOGUE).

**`broken` — the map will not run as its author built it.** One per map, first match winning, and a
UDMF map is judged by its own lumps rather than the missing binary ones that follow from its format:

| Code | Signal | Why |
|---|---|---|
| `incomplete` | THINGS, LINEDEFS, SIDEDEFS, VERTEXES or SECTORS missing or zero-length; for a UDMF map, no ENDMAP | There is no level without them, and no player start without THINGS. ENDMAP is UDMF's required closing lump (udmf.txt § II.B) and `loadMap` refuses a group without it. |
| `noBsp` | **both** NODES and SSECTORS empty; for a UDMF map, ZNODES missing or empty | A map left for the port to build nodes for — or one whose GL nodes ship in a `GL_<map>` group of their own, which this engine does not read. Either binary lump alone is enough: an extended BSP fills one of them and leaves the other empty (NODES for XNOD/ZNOD, SSECTORS for the GL family), and a map convex enough to be a single subsector has no NODES record to write. A UDMF map's whole BSP rides in ZNODES (§ UDMF). |
| `udmf` **(`loads`)** | a `TEXTMAP` whose namespace is not a Doom-specials one | The map draws, collides and fights, but its action specials park undispatched (§ UDMF), so its progression cannot be played through. A `doom`/`ZDoomTranslated` map raises nothing — it plays in full. Only raised for a map that isn't already refused. |

**`loads` is the one qualifier on a broken code**, and `udmf` is its only holder: the map *does*
load and is walkable, and is flagged red for what will not run in it rather than for failing to
open. So it is left out of `nothingLoads`'s refusal count — **the file stays pickable**, the player
choosing to walk a map whose doors won't open — and out of the tooltip's "will not load" headline,
which such a file would make a lie. Everything else `broken` yields an empty world: a level with no
floor to stand on.

**`partial` — it loads and plays, but not as its author built it.**

| Code | Signal | Why |
|---|---|---|
| `hexen` | a `BEHAVIOR` lump in a binary group | The map draws, collides and fights correctly, but its action specials and ACS do not run (§ What a Hexen map does not get), so anything gated behind a switch or a script cannot be reached. Only raised for a map that isn't already `broken`. |
| `dehacked` | the patch raises a `DehSupport` **`unsupported`** warning | Action pointers and the MBF flags: things that change how an actor behaves. `noTarget` and `unknown` are deliberately **not** counted — the first is a finale screen or a pickup message, the second a line the parser didn't recognise, and neither changes how a level plays. Counting them turned EPIC.WAD amber over one misspelt `Radius` line. |

A file's level is its worst issue, and a file with no maps at all (a texture or sound pack) is `ok`
unless its patch says otherwise.

**An empty verdict and no verdict are different things.** `[]` is a file that was checked and found
fine; *absent* is unknown, and a row carrying it draws **no glyph** rather than a green one.
`ManifestEntry.support` and `LibraryDescriptor.support` are therefore optional only to tolerate an
`index.json` or a scan memo written before the field existed; both producers write the verdict on
**every** file, empty ones included. Omitting the empty case to keep the manifest short is exactly
the bug that costs every supported file its tick, and it hides in plain sight: the files that *do*
get a glyph are the ones that are broken, so the column looks like it works. The library memo goes
further and re-describes a file whose row has no verdict, since re-reading a directory is cheap and
a permanent blank is not.

## The `public/game/` manifest

**The folder is named once.** `library/manifest.ts` declares `WAD_DIR` and `MANIFEST_PATH`, and
`plugins/wad-manifest.ts` imports both — for the folder it scans (`public/<WAD_DIR>`), the URL it
answers on and the name it emits — the same producer-imports-from-consumer rule `ManifestEntry`
follows, and for the same reason: a plugin serving from one folder while the menu fetches from
another lists files it cannot load. `shipped.ts`'s own path repeats the segment on purpose
(§ The WAD the engine ships). `public/game/replay/` is a third folder under the same prefix with a
manifest of its own, in the same two halves — docs/replays.md § Stock replays. Both halves *are*
one implementation: `plugins/manifest.ts` owns the dev middleware, the `emitFile` and the mtime/size
memo, and each plugin brings only its own scan (`jsonManifest`, `statMemo`).

The Vite plugin scans `public/game/{iwad,pwad}/`, parsing each file's header and directory plus its
MAPINFO and `DEHACKED` lumps if it has them, and hashing its bytes for the content ID (§ Content ID)
— the file is already in memory, so the ID costs one pass and nothing extra to read. That is served
as `/game/index.json` (dev middleware and build-time `emitFile`), so the menu can list
types/sizes/map counts, name levels, and know each file's *identity* without downloading anything —
the last being what lets a savegame's WAD set resolve while the save list renders (docs/savegames.md
§ WAD-set identity). The dev middleware re-scans on every request for the manifest, so `describeWad`
is memoized on each file's mtime and size (`statMemo`; `statSync` is already being called for the
listing):
without it every page reload would re-read and re-hash every WAD in `public/game/` — tens of MB, on
the path that gates `Menu.init`. Editing a WAD still re-describes it. Bytes are only fetched when a
level actually starts, and `library.ts: serverSource` memoizes them, so restarting the same WAD set
costs no download. A WAD picked from disk has no manifest entry, so `uploadedSource` parses its
MAPINFO and `DEHACKED` itself — the bytes are already in memory by then, and the two paths have to
produce the same `WadSource` fields or an uploaded file would list differently from the same file on
disk.

`levelNames` holds finished titles from both sources, MAPINFO first — a patch fills gaps rather
than overriding, matching `levelTitleFor`'s own order. See § Level names.

**The folder a file sits in decides how it's served, regardless of its own IWAD/PWAD signature** — a
mod placed in `wads/iwad/` becomes a selectable game WAD (useful for a PWAD that carries its own
maps); the plugin warns on mismatch but still serves it.

**Both roots are scanned recursively**, depth-capped at 8, and `ManifestEntry.folder` is the path
relative to `public/game/` rather than one segment — `pwad`, or `pwad/megawads`. It is still exactly
the URL the file is served from, so a subfolder costs no extra bookkeeping; `serverSource` encodes
each segment separately so the separators survive. What it buys is that a collection can be filed on
disk the way it is thought about, and the menu shows it as a tree (docs/menu-wads.md § WAD Library)
— the same shape the player's own library folder already had. Only the **first** segment decides
iwad-vs-pwad, so everything under `pwad/` is an add-on however deeply it is nested. `servedFolder`
is the one place that split is made — the menu groups by the two halves it hands back rather than
decoding the path itself.

**`ManifestEntry` is declared once**, in `src/wad/library/defs.ts` — beside the `WadSource` the
module that casts the fetched JSON to it produces — and `plugins/wad-manifest.ts` imports that same
interface through `library.ts` rather than restating it. The
two used to be separate declarations and had already drifted on `folder` (the producer emitting
paths while the consumer's type still said `'iwad' | 'pwad'`), which nothing could catch: a shape a
consumer casts raw JSON to is one the producer has to be checked against.

**A WAD's own maps say which game it belongs to** (`library/defs.ts: mapStyle`): `ExMy` → DOOM 1,
`MAPxx` → DOOM II, and the two never mix within one game. A WAD with no maps of its own (textures, sounds,
…) has no style and fits either — `describeSource` (`ui/menu/labels.ts`) shows its lump count
instead of a map count so it doesn't read as an empty file. What the menu *does* with that is
docs/menu-wads.md § Picking a WAD set.
