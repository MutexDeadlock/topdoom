# DEHACKED and BEX patches

DEH predates BOOM: it patched `doom.exe` in place in 1994, editing the data tables the exe shipped
with. BEX is BOOM's own extension of that format (`d_deh.c`'s "begin BOOM Extensions" —
`[STRINGS]`, `[PARS]`, `[CODEPTR]`, `[HELPER]`), and BOOM is where a WAD-embedded `DEHACKED` lump
became the normal way to ship one. None of it touches the map format, which is why the BOOM work
was complete without it.

`game/dehacked.ts` is the layer's one entry point; `game/dehacked/` holds the parser, the index
bridges and the classifiers.

## Scope

Read and applied: `Thing` records (stats, `Bits`, sounds), `Weapon`, `Ammo`, `Misc`, vanilla `Text`
substitutions, and BEX `[STRINGS]`, `[PARS]`, `[SOUNDS]` and `[MUSIC]`.

Deliberately out: `Frame`, `Pointer`, `[CODEPTR]`, `Sprite`/`[SPRITES]`, and `ID #`. See § What is
not supported for why each, and what it would cost.

A patch that asks for something out of scope **still loads and still plays.** It is reported, never
refused — the WADs this matters for are ones that work today, and a refusal would be a regression
against them. § The coverage report is where the reporting lands.

## Where a patch comes from

`readDehacked(wad)` takes every `DEHACKED` lump in the loaded set, in load order, and merges them.

That merge is **cumulative**, which is the one place this differs from `campaign/mapinfo.ts`'s
one-lump-per-set rule: a MAPINFO is a file's whole statement about the campaign, so a later one
replaces an earlier one, but DEH patches stack in every engine that reads them — a patch that
retunes one monster does not repeal an earlier one that renamed the levels. Later files still win
**per key**, which falls out of the merge order.

Only the in-WAD lump is read. Standalone `.deh`/`.bex` files are not loadable: that would mean
widening the `public/wads/` manifest, `WadSource`, `loadWadFiles` and the menu's upload filter,
none of which a WAD-embedded lump needs.

## The record grammar

`parseDehacked(text, titleLookup)` is pure — a string in, a `DehPatch` out, no `Wad` — so tests and
tooling drive it directly.

**It never throws.** A line it can't read becomes a `DehWarning` and the walk continues, because a
patch that trips one line must not cost the level. That is `campaign/mapinfo.ts`'s discipline, for
the same reason.

The parser walks a **byte cursor**, not an array of lines, and that shape is load-bearing. A vanilla
`Text <oldlen> <newlen>` record is followed by two raw runs whose lengths it declares, and those
runs routinely contain newlines — every one of EPIC.WAD's 32 level renames does, because the old
and new strings are written back to back with the record's own line break inside the count. A
line-split parser has already chopped such a record apart before it can be read.

Two more shapes real patches have that the grammar has to allow for:

- **A repeated version header.** `Doom version` and `Patch format` are assignments that belong to no
  record and may appear anywhere; EPIC.WAD switches from `21` to `19` halfway through. They are
  skipped wherever they occur rather than closing whatever record is open.
- **A bracketed section runs until the next bracket or a *known* record word.** Without that rule
  `[PARS]`' own `par 1 30` lines parse as `Word N` record headers and eat the entire section.

A record the engine can't honour also swallows its own field lines. freedoom2's seven `Frame`
records would otherwise contribute a report row per distinct field name on top of the one row that
actually says something.

## Thing records

`Thing N` is a **1-based** index into `mobjinfo[]`, so `Thing 97` is `MOBJ_INFO[96]`. `MOBJ_INFO`
(`dehacked/tables.ts`) is all 137 rows transcribed mechanically from `linuxdoom-1.10/info.c` — the
checkable data twin of the `// MT_*` comments `things/doomednums.ts` already carries. A test
cross-checks the two: all 118 placeable rows name a doomednum `ThingType` knows.

The 19 rows with `doomednum` of -1 are the ones no map can place. Ten of those are missiles, and
they do have a sink: `MISSILE_SINKS` maps each to the **flight sprite** this engine keys a missile
by (`AttackStats.projectile.sprite`, `PROJECTILE_RADIUS`, `WeaponDef.projectileSprite`). Rewriting
every stat block naming `BAL1` is the faithful answer to a patched `MT_TROOPSHOT`, not an
approximation — in vanilla the imp's fireball *is* one shared `mobjinfo`. One `mobjinfo` can drive
several sinks at once, which is why `MISSILE_SINKS` is a record of optional sinks rather than a
union: `MT_ROCKET` is the rocket launcher's missile, the cyberdemon's missile, and its own flight
radius.

`MT_SPAWNSHOT` is the one missile deliberately absent — the Icon of Sin's cube carries its own
constants in `monsters/iconofsin.ts` rather than being sprite-keyed, so it has no sink.

The rest (puffs, blood, `MT_TFOG`, gibs) have no sink at all and classify `noTarget`.

### Units

DEH stores what the exe stored; this engine stores seconds and units per second. The conversions,
each from the vanilla site that fixes it:

| Field | Conversion | From |
|---|---|---|
| `Hit points`, `Mass`, `Missile damage` | none | `info.c` |
| `Pain chance` | `/ 256` | `P_DamageMobj` rolls `P_Random() < info->painchance` |
| `Width`, `Height` | fixed point → map units | `info.c` writes `n*FRACUNIT` |
| `Speed`, missile | fixed point → map units, then `/ DOOM_TIC` | `info.c` gives missiles map units per tic |
| `Speed`, walker | left as written | `info.c`'s plain map units per `A_Chase` |

A walker's speed stays in vanilla's terms on purpose. `MonsterStats.speed` is units per second
derived through the walk loop's tic count, and that tic count is stored nowhere — so a patched
walker speed is applied by **scaling** the derived value by `deh / vanilla`, which preserves the
loop factor, rather than by recomputing it from scratch.

`FIXED_POINT_THRESHOLD` (`dehacked/parse.ts`) is **a heuristic, not a vanilla rule**, and is
marked as such at the declaration. DeHackEd writes fixed point because that is what the exe held,
but a hand-edited patch writes map units — EPIC.WAD's `Radius = 2` means two map units. The two
ranges sit two orders of magnitude apart with nothing between them: the largest plain radius in
`info.c` is `MT_SPIDER`'s 128, and the smallest fixed-point one is `MT_TROOPSHOT`'s `6*FRACUNIT`.

### Bits

**A `Bits` value replaces the whole `mobjinfo.flags` mask; it is not a delta.** EPIC.WAD's
`Thing 130 / Bits = 768` deliberately *drops* `MF_SOLID|MF_SHOOTABLE` from a hanging body. So the
difference between an absent `Bits` and a zero one is load-bearing, and `DehThingEdit.bits` is
optional rather than defaulting to 0.

Both forms parse, because EPIC.WAD writes one of each: a numeric mask (`Bits = 768`) and Boom's
`+`/`|`/`,`-separated mnemonic list (`Bits = SOLID`, with a leading `MF_` stripped). A value with
no letters in it is numeric.

This engine has **no flags bitfield anywhere** — vanilla's flags live here as seven doomednum-keyed
`Set`s in `things/tables.ts` plus a field or two on `MonsterStats` — so applying a mask means
walking `MF_FLAGS` and adding or removing each row's sink. The three groups:

- **A real sink**: `MF_SOLID` → `SOLID_DECORATION_TYPES`, `MF_SHOOTABLE` → `MONSTER_TYPES`,
  `MF_COUNTKILL`/`MF_COUNTITEM` → their `Set`s, `MF_SHADOW` → `FUZZ_TYPES`, `MF_SPAWNCEILING` →
  `CEILING_HUNG_HEIGHT`, and `MF_FLOAT` **together with** `MF_NOGRAVITY` → `MonsterStats.flies`.
  `MF_MISSILE` is not a sink of its own; it decides how this record's `Speed` is read.
- **Quiet** (`FlagRow.quiet`, filtered out of the report): vanilla's own blockmap and sector
  bookkeeping, which this engine's monster grid replaces; per-actor runtime state that is zero in
  every `info.c` entry; `MF_AMBUSH`, which is a per-*thing* map flag rather than a type property;
  and the deathmatch and player-colour bits. A missing sink is the *right* answer for these, so
  reporting them would be noise.
- **Reported unsupported**: `MF_SPECIAL`, `MF_NOBLOOD`, `MF_NOCLIP` and the rest, plus Boom/MBF's
  own mnemonics, which are named individually so a report can say which one a patch wanted.

The report for that last group is raised by **`unhonoredFlags`, off the mask**, not off the field
name — and that is the load-bearing part. The `Bits` line itself always applies, so a filter keyed
on the warning's field could never see the individual flags the line dropped: for a while none of
them were reported at all. Reading the mask is the only place that knows what a patch asked for.
Each flag gets its own row (`Thing/Bits/NOBLOOD`) so the count is per flag rather than per `Bits`
line, and `quiet` rows are skipped at the source, so the console and `inspect-wad` cannot disagree
about what counts as noise.

Because a numeric mask can only be read back through its bits, **no two rows of `MF_FLAGS` may
share one** — `MF_TRANSLUCENT` was once transcribed onto `MF_FRIEND`'s bit, which would have
reported both names for either flag. Bits 28-31 are MBF's `p_mobj.h`: `MF_TOUCHY`, `MF_BOUNCES`,
`MF_FRIEND`, `MF_TRANSLUCENT`. A test pins the bits distinct.

## Weapon, Ammo and Misc

A `Weapon` record reaches **only its ammo type.** That is not a gap here: `d_deh.c`'s `deh_weapon[]`
is an ammo type and five state pointers, and vanilla's `weaponinfo[]` holds nothing else — no
damage, no fire rate. A patch that retunes a weapon does it by editing the frames' durations, which
is out of scope.

`Ammo` reaches both of vanilla's tables, `maxammo[]` and `clipammo[]`. The second matters more than
it looks: `P_GiveAmmo` multiplies a pickup's `num` by `clipammo[type]`, so `Per ammo` drives what
every ammo pickup is worth, not just the backpack maths. `inventory.ts`'s `AMMO_PICKUPS` and
`WEAPON_PICKUPS` therefore hold **clip counts rather than amounts** — a clip is one, a box is five,
a weapon hands over two — which is vanilla's own indirection, and is what lets `setClipAmmo` reach
the pickups without re-deriving anything.

`Misc` reaches the health/armor limits and `BFG Cells/Shot`. The cheat-related rows (`IDFA Armor`,
`God Mode Health`) have no target because this engine has no cheats, and `Monsters Infight` none
because infighting here is not a single global switch (docs/monster-ai.md § Infighting).

Each name's destination is one **typed** row of `MISC_SINKS` — either `{limit}`, an
`InventoryLimits` field, or `{weapon, field}`, which today is only `BFG Cells/Shot` →
`WEAPONS.bfg.ammoPerShot` (vanilla's `deh_bfgcells` writes `weaponinfo[wp_bfg].ammopershot`, so it
is the one `Misc` row that is not a limit at all). **A name is classified `applied` exactly when it
has a row here** — `MISC_FIELDS` derives those rows from this table rather than listing them
beside it. That coupling is the point: while the two were independent statements, `BFG Cells/Shot`
claimed `applied` and was assigned onto `LIMITS` under its raw DEH spelling, where nothing read it.
The parser therefore keys `DehPatch.misc` by the **DEH name as written**, leaving the sink lookup
to the applier, rather than half-resolving it on the way through.

## Sounds and music

`SFX_ORDER` and `MUSIC_ORDER` bridge `sfxenum_t` and `musicenum_t` onto this engine's names.

`SFX_ORDER` is **derived** from `audio/sfx.ts`'s `SFX` rather than transcribed a second time: that
table already *is* `S_sfx[]` in `sounds.h` order, and a second copy of 108 names would only be a
thing that could drift. What that costs is a dependency on `SFX`'s declaration order staying
vanilla's, which is exactly what the pinned indices in `tests/game/dehacked-tables.test.ts` catch.
Slot 0 is `sfx_None` and is `null`: a patch setting a sound field to 0 is asking for silence, and
`MonsterSounds`' fields are already optional, so that maps to deleting the field.

`MUSIC_ORDER` is **composed** the same way, out of `audio/music/tables.ts`' `DOOM1_MUSIC` and
`DOOM2_MUSIC`: those two hold 59 of its 67 names already, and only the entries between and after
them — the intermission, title and finale tracks — are listed at the bridge. It has no reader yet;
it is the index bridge a `Music N` sink would need, and the numeric form classifies `noTarget`
outright today (below).

A `Thing` record's five sound fields resolve through `SFX_ORDER` onto `MonsterSounds` (and onto
`INERT_SHOOTABLE`'s own pain/death sounds for the two types that carry them outside the stat table).
EPIC.WAD uses this.

BEX's `[SOUNDS]` and `[MUSIC]` redirect **which lump a name resolves to**, through an indirection
in `audio/sfx.ts` (`soundLumpName`) and `audio/music/tables.ts` (`musicLumpName`). Both are empty
unless a patch said otherwise, so with none loaded each is exactly the template literal vanilla's
`i_sound.c` builds.

A numeric `Sound N` or `Music N` record classifies `noTarget`: those move a pointer into the exe's
own string table, which means nothing outside it. Only the BEX mnemonic form names a lump.

## Strings

Two producers, one `Map` keyed by mnemonic: BEX `[STRINGS]` (`KEY = value`, backslash line
continuations, the usual C escapes) and vanilla `Text` byte-count substitution.

A `Text` record is a raw substitution rather than a keyed edit, so what it changes has to be
recognised from the old string alone. **Level titles are the one corpus this engine can act on.**
Normalized through `stripTitlePrefix`, a title from a patch is exactly a `LEVEL_NAMES` value, so a
table lookup stands in for reconstructing id's original bytes — which does work (it reproduces
EPIC's declared `oldlen`s exactly) but needs a second table and is less tolerant. Anything else a
`Text` record substitutes is reported, quoting what it tried to replace.

`stripTitlePrefix` lives in `campaign/names.ts`, beside `LEVEL_NAMES`, because it is exactly the
transform that table's own doc says the table was generated with: strip a leading `level 1:`,
`MAP01:` or `E1M1:` identifier and capitalize what is left. A title naming none of the three is
kept verbatim — EPIC.WAD's `1 - a fool's paradise` carries no level identifier at all.

`dehTitlesFor` projects mnemonics onto map lump names, and only under the mission they belong to:
`HUSTR_1` is `MAP01` under DOOM II, `PHUSTR_*` under Plutonia, `THUSTR_*` under TNT, `HUSTR_E1M1`
under DOOM. A **null mission** — an IWAD whose file name `missionOf` doesn't know, which is where
EPIC.WAD lands whenever the IWAD isn't literally `doom2.wad` — keeps the plain `HUSTR_*` set rather
than dropping every title the patch has.

Resolution order is in docs/wad.md § Level names: MAPINFO, then DEHACKED, then the vanilla table.
MAPINFO winning matches UMAPINFO's own spec. The "IWAD-provided map only" guard stays on the
vanilla table alone — a DEH title, like a MAPINFO title, applies to any map, because renaming the
base game's levels is exactly what such a patch is for.

A DEH title does not need a rule against the `CWILV` name graphic. `LevelNames.patchFor`'s existing
provenance check already declines a patch from a different file than the map when the map came from
a PWAD, so EPIC.WAD's `MAP01` falls through to the text where its DEH title is.

The menu's level list agrees. `plugins/wad-manifest.ts` parses each file's `DEHACKED` alongside its
MAPINFO and folds the titles into the one `levelNames` field the manifest already had — **filling
the gaps MAPINFO left, never overwriting them**, which is the order `levelTitleFor` applies in-game.
`uploadedSource` does the same for a file picked from disk, so the same WAD lists identically
whether it was uploaded or served.

The mission is taken from the file's **own name**. For an IWAD that is exactly right —
`plutonia.wad` picks its `PHUSTR_*` set — and for a PWAD it falls back to the plain `HUSTR_*` one,
which is what almost every patch writes. The one case that differs from in-game: a PWAD whose patch
defines *only* `PHUSTR_*` or `THUSTR_*` contributes no menu title, because at build time nothing
knows it will be loaded on Plutonia or TNT. It still names the level on the card, where the real
mission is known. A missing title, never a wrong one.

## Par times

`[PARS]` is read in both forms the format allows — `par <map> <secs>` and
`par <episode> <map> <secs>` — with a trailing `#` comment stripped first, because freedoom2 puts
one on every line.

The table it overrides, and the deliberate episode-4 deviation, are in docs/wad.md § Par times. The
display rule is docs/hud.md § Intermission.

## What is not supported

**Frames — `Frame`, `Pointer`, `[CODEPTR]`.** This is the one that fixes the scope. Vanilla animates
through a `states[]` array where each entry names a sprite, a duration, an action pointer and the
next state; a DEH patch builds a custom monster by reassigning those. This engine has no such
array — a monster's animation is per-type letter lists in `things/tables.ts` with one flat duration
each (docs/sprites.md) — so there is nothing to reassign. Supporting it means building a state
machine first, which is a different project from reading a patch.

**`Sprite` records and `[SPRITES]`.** Renaming sprites by index needs the same `sprnames[]`
ordering the state table indexes into.

**`ID #`.** Permanently out, not merely deferred. Re-keying a thing's doomednum would have to
rewrite ten type-keyed tables and seven `Set`s that are not all keyed by the same thing —
`PROJECTILE_RADIUS` is sprite-keyed, `WEAPON_PICKUPS` is doomednum-keyed but its values name
weapons. It also breaks the reset model in § Applying, since a re-key can collide with an existing
key, so a reset would have to restore key *sets* and not just values.

**`Radius`.** Reported `unknown`, and that is faithful rather than a gap: `d_deh.c`'s
`deh_mobjinfo[]` spells the field `Width`, and nothing in the format accepts `Radius` — prboom
ignores EPIC.WAD's `Radius = 2` line for the same reason this does.

**`Reaction time`.** `monsters/ai.ts` seeds one shared `REACTION_CHASES`, and vanilla's
`reactiontime` is 8 for every monster, so there is no per-type table to write into.

**Strings with no home.** `GOT*` pickup messages have nowhere to go because this engine shows
nothing on pickup; `E1TEXT`–`C6TEXT` because there is no finale screen; `AMSTR_*` because there is
no automap; `CC_*` because there is no cast call.

Two of these are the cheapest follow-ons and are worth naming as such. `PD_*` (the locked-door
lines, `ui/hud/message.ts`) and `OB_*` (obituaries, `things/tables.ts`'s `THING_NAMES`) both have a
real sink — but both are currently split into interpolated fragments rather than held as whole
format strings, so honoring them means restructuring those two sites first.

## Applying: reset, then patch

Patched tables are **mutated in place** (`dehacked/apply.ts`), with a pristine snapshot taken at
module init and a `resetDehacked()` that restores from it. Both run at the top of the `Game`
constructor, **reset first** — so a session reads the same tables whatever the previous one loaded,
which is the failure mode mutation is most exposed to. Resetting on the way *in* rather than
cleaning up on the way out also means a `Game` that throws mid-construction leaves nothing behind.

The snapshot is a `structuredClone`, and the restore clones on the way out too, so the pristine copy
is never handed to a mutator. That matters because `MonsterStats` nests three levels deep: a shallow
copy would survive one reset and fail the next, which is what
`tests/game/dehacked-apply.test.ts`'s two-round test exists to catch.

The alternative, threading a patched table set through the way `monsterStatsFor(fast)` does, was
rejected on size: `MONSTER_STATS` has 30-odd import sites outside `monsters/`, `inventory.ts`'s
tables are module-private with `applyPickup` a free function taking no context, and
`SfxId = keyof typeof SFX` makes the sound half a type-system refactor rather than a data one.
What mutation costs instead is a **known, enumerable** list of values derived at module init that
would otherwise go stale, each closed a different way:

| Derived value | How it is kept current |
|---|---|
| `FAST_MONSTER_STATS`, `TALLEST_BODY_HEIGHT` | `let`, rebuilt by `rebuildDerivedMonsterStats()`. `monsterStatsFor` is still the single accessor. |
| `things/grid.ts`'s `BLOCKER_MARGIN` | computed per grid instead — one reduce over forty entries, once per level. |
| `vile.ts`'s `VILE_WINDUP_TRACK_SECONDS` | read at its one use site, which runs once per windup. |
| `WEAPON_CYCLE`, `SFX_NAMES` | nothing: DEH has no slot concept and never adds a sound. |

`inventory.ts`'s tables are module-private, so the applier does not reach into them; that module
exposes `setMaxAmmo`, `setClipAmmo`, `setInventoryLimits` and `resetInventoryLimits` instead, each
owning its own derivations. `audio/sfx.ts` and `audio/music/tables.ts` do the same for their lump
redirects.

The patch has to land **before `createThingLayer`**, which resolves the stat table once per level
and snapshots each thing's radius and height at spawn, and before the `SoundBank`, which pre-decodes
on construction.

## Savegames and patched tables

Two things needed handling, and **neither needed a `SAVE_VERSION` bump** — both are the
optional-field-whose-absence-means-the-old-behavior pattern (docs/savegames.md § The format and its
version).

A PWAD carrying a `DEHACKED` lump is now a **required** WAD. Without that it would be droppable with
a warning row, and dropping it would silently revert every patched table under a save written
against it — a change in what the save *means*, not just how it looks. `SaveMeta` carries an
optional `patchWads` naming those files' content ids; its absence means no patch was applied, which
is exactly what every save written before the field existed meant.

`snapshotThings` elides a monster's `health` when it equals `spawnHealthFor(type, dropped)`, which
reads `MONSTER_HEALTH` — so that elision baseline is a patchable value. `patchWads` is what makes it
safe: the patch is guaranteed back on restore, so the baseline is the same one the comparison used.
As a second guard, `health` is written unconditionally once `thingStatsPatched()` is true; the
reader is unchanged, an absent key still means the spawn default, and the extra bytes appear only
on patched sets and only for things that were not pristine anyway.

**The one residual, which no fix prevents:** a save made *before* this shipped, on a set whose
DEHACKED patches `Hit points`, changes meaning now — the build that wrote it applied no patch. On
the content shipped here that is only EPIC.WAD's `Thing 130`, a hanging body, and its `Bits` line
drops `MF_SHOOTABLE` anyway, so the 40 HP it also sets is unreachable.

## The coverage report

Every record and field classifies as one of four `DehSupport` values, and the classifiers live in
`dehacked/tables.ts` beside the tables that decide them — the same arrangement `classifyLineSpecial`
has with the specials table, so a report can't drift out of step with what actually lands.

- **`applied`** — written into a real engine table.
- **`noTarget`** — understood, but this engine simply doesn't have the thing (a finale screen, a
  pickup message).
- **`unsupported`** — deliberately out of scope even though a target exists or could (frames,
  sprite renames, `ID #`).
- **`unknown`** — not recognised at all.

The distinction between the middle two is the one worth keeping: only `unsupported` is ever worth
revisiting.

Warnings are **deduped by `(record, field)` and counted**, and `[STRINGS]` rows group by
*category* rather than by mnemonic. Both exist for the same reason: freedoom2's patch sets 132
strings with no home and carries 7 `Frame` records, and a report that named each one would bury the
row that matters under 193 rows. Grouped, it is fourteen.

Three surfaces:

1. **The console**, once per `Game` — one line for what applied, one for what didn't.
2. **`scripts/inspect-wad.ts`**, a final block parallel to the specials one. It reports and never
   exits non-zero, like that one.
3. **The menu's WAD row**, which shows `DEHACKED` as a **presence** badge only. That is all it
   honestly can: a server file is listed from the build-time manifest, and knowing what a patch
   actually lands needs bytes the menu has not downloaded.
