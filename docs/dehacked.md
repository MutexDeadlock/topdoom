# DEHACKED and BEX patches

DEH predates BOOM: it patched `doom.exe` in place in 1994, editing the data tables the exe shipped
with. BEX is BOOM's own extension of that format (`d_deh.c`'s "begin BOOM Extensions" —
`[STRINGS]`, `[PARS]`, `[CODEPTR]`, `[HELPER]`), and BOOM is where a WAD-embedded `DEHACKED` lump
became the normal way to ship one. None of it touches the map format, which is why the BOOM work
was complete without it.

`game/dehacked.ts` is the layer's one entry point; `game/dehacked/` holds the parser, the index
bridges and the classifiers.

## Scope

Read and applied: `Thing` records (stats, `Bits`, sounds, the eight frame pointers), `Frame`
records (sprite, subnumber, duration, next frame, MBF's two `Unknown` fields — § Frames), `Pointer`
and `[CODEPTR]` repoints (§ Action pointers), `Weapon` records (ammo type and all five state
pointers, § Weapon, Ammo and Misc), `Ammo`, `Misc`, vanilla `Text` substitutions, and BEX
`[STRINGS]`, `[PARS]`, `[SOUNDS]`, `[MUSIC]` and `[SPRITES]`. States past vanilla's own table —
MBF's 109, and the ones a patch grows the table into — are addressable (§ Extended states).

Deliberately out: `ID #`, extended `mobjinfo` rows, MBF21's own fields, and `A_RandomJump` of the
action pointers. See § What is not supported for why each, and what it would cost.

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
widening the `public/game/` manifest, `WadSource`, `loadWadFiles` and the menu's upload filter,
none of which a WAD-embedded lump needs.

## The two entry points

This layer has **two** public entry points rather than the one docs/conventions.md's rule would
give it, and the split is by audience:

| Entry | Exports | Who imports it |
|---|---|---|
| `game/dehacked.ts` | `readDehacked`, `parseDehacked`, `describeDehacked`, the record types | `wad/library.ts`, `plugins/wad-manifest.ts`, `scripts/inspect-wad.ts`, `game.ts` |
| `game/dehacked/apply.ts` | `applyDehacked`, `resetDehacked`, `thingStatsPatched` | `game.ts`, `things.ts` |

`dehacked/frames.ts` sits outside that split: it is the pure walker the *game tables themselves*
import at load (§ Frames), so it deliberately depends on neither entry point and on no game table.

The reason for the split is that **reading a patch and applying one have very different dependency
graphs.**
Parsing needs the index bridges (`dehacked/tables.ts`) and nothing else; applying needs
`monsters/tables`, `things/tables`, `spritefx/tables`, `weapons` and `inventory`, and takes a
`structuredClone` snapshot of all of them at import (§ Applying: reset, then patch).

Two of the three readers only ever want a patch's *text* — the menu's WAD library wants level
titles for the picker, and the build-time manifest plugin wants the same titles plus par times.
Neither has a `Game`. While `game/dehacked.ts` re-exported the applier, importing it for a level
title pulled the whole table graph in behind it and ran that snapshot before any `Game` existed —
ES re-exports are eager, so there was no way to ask for half of it. The plugin worked around this
by reaching into `game/dehacked/parse.ts` directly, which is exactly the kind of past-the-front-door
import the one-entry-point rule is meant to prevent.

Splitting by audience is what lets both rules hold: nobody reaches into a submodule, and nobody
pays for the applier to read a level name. `tests/docs/dehackedlayers.test.ts` pins it — the
value-import graph reachable from `wad/library.ts` must not contain `apply.ts`.

The DEH domain stays under `game/` rather than moving beside `campaign/mapinfo.ts`, even though
`wad/library.ts` importing `game/` is the wrong direction on paper. `dehacked/tables.ts` is a
bridge onto **this engine's own keys** — `SfxId`, `WeaponId`, `AmmoType`, `InventoryLimits` fields,
`MISC_SINKS`' weapon field — so filing it under `wad/` would misplace it, and `parse.ts` cannot be
moved without it. Doing so would also trade the `wad/` → `game/` edge for a `wad/` → `audio/` one,
against an `audio/` → `wad/sound.ts` edge that already exists. One light edge in the wrong direction
beat inverting a package.

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

The eight frame-pointer fields (`Initial frame` … `Respawn frame`) land on `DehThingEdit.states` as
`states[]` indices and are resolved by the frame walker — § Frames. A value of 0 is `S_NULL`,
"this type has no such state", and is carried as written rather than dropped: a patch that points a
monster's `Respawn frame` at 0 is taking its resurrection away.

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
derived through the walk loop's tic count — so a patched walker speed is applied by **scaling** the
derived value by `deh / vanilla`, which preserves the loop factor, rather than by recomputing it
from scratch. When the loop itself is retimed by a `Frame` record, the frame walker rescales the
same field by the loop factor's own change (§ Frames), so the two compose in either order and
neither disturbs the three types whose shipped loop factor the walker reads differently.

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

- **A real sink**: `MF_SOLID` **and not `MF_SHOOTABLE`** → `SOLID_DECORATION_TYPES`, `MF_SHOOTABLE`
  → `MONSTER_TYPES`,
  `MF_COUNTKILL`/`MF_COUNTITEM` → their `Set`s, `MF_SHADOW` → `FUZZ_TYPES`, `MF_SPAWNCEILING` →
  `CEILING_HUNG_HEIGHT`, and `MF_FLOAT` **together with** `MF_NOGRAVITY` → `MonsterStats.flies`.
  `MF_MISSILE` is not a sink of its own; it decides how this record's `Speed` is read.

  The pair on the `MF_SOLID` row is the one sink that isn't a single bit, and it is load-bearing:
  `SOLID_DECORATION_TYPES` means *solid and not shootable* — `things.ts` skips its members in the
  hitscan, projectile and splash paths (docs/movement.md § Solid decorations). Every monster in
  `info.c` carries `MF_SOLID` as well, so keying membership on that bit alone made **any** `Bits`
  line on a monster unkillable and 16 units wide. `Width` reads the same predicate over the record's
  own mask rather than the current membership, because `Bits` is applied last — a record that turns
  a prop solid and resizes it in one go has to write the radius override too.
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

## Frames

Vanilla animates everything through one `states[]` array — 967 rows of sprite, frame letter (with
`FF_FULLBRIGHT` in bit 15), tics, action pointer and next state — and each `mobjinfo` row is eight
entry points into it. This engine has no such array at runtime: a monster is per-type letter lists
in `things/tables.ts` with flat durations, and its attack and pain *lengths* are summed tics in
`monsters/tables.ts`.

**Those tables are not written out — they are walked out of `states[]` at import.** The letter
lists, both attack poses, the flat decoration rates, the missiles' flight and impact art, the
barrel's chains, and `MONSTER_STATS`' `speed`/`chaseInterval`/`painDuration` and per-attack
`duration`/`shots`/`shotInterval`/`startDelaySeconds` are all filled by the walker as
`things/tables.ts`, `monsters/tables.ts`, `spritefx/tables.ts` and `things/defs.ts` evaluate. A row
in `MONSTER_SEED` therefore carries only what no state chain can say — health, radius, mass, the
damage rolls, the sounds. A `Frame` record is then applied by re-deriving the same tables from a
patched copy of the frame table, not by stepping states: same walker, different input.

`dehacked/states.ts` is the data: `STATES`, `SPRITE_NAMES` and `MOBJ_STATES` (the eight pointers
per `mobjinfo` row, index-aligned with `MOBJ_INFO`), generated mechanically from `info.c`/`info.h`
and never edited by hand. It is read-side and import-free, because the parser classifies a `Frame`
by the state it names (below). Each row keeps its `A_*` action **name** — not to run it, but
because the derivations read it: the walk loop's chase count, an attack chain's shots and what it
fires, the barrel's `A_Explode`. That column is also what an action-pointer record edits
(§ Action pointers).

`dehacked/frames.ts` is the walker, and it is **pure** — it reads `states.ts` and `MOBJ_INFO` and
imports no game table, which is what lets the game tables build themselves from it without a cycle.
`patchStates` writes the `Frame` edits and the `Thing` pointers into copies; `deriveFrameTables`
walks every chain; `pristineFrameTables` memoizes the unpatched reading. The diff-and-write half
lives in `dehacked/apply.ts`, which is the only side that touches the tables.

Because the walker classifies a row before it can consult any table it fills, it decides row kind
from read-side data alone: a monster is a row with both a pain and a death chain (exactly the twenty
types `MONSTER_STATS` and `INERT_SHOOTABLE` cover), read off **pristine** `MOBJ_STATES` so a patch
that clears a `painstate` cannot silently turn a monster into a decoration, and the three
`mobjinfo` rows this engine draws no sprite for (`NOT_DRAWN`: teleport destination, spawn spot,
spawn shooter) are skipped by number.

**The chain rules**, each matched against the hand transcription (the anchor tests below):

- A chain follows `next` until it loops, steps to `S_NULL`, reaches a `tics: -1` state, or — for a
  pain, attack or raise chain — re-enters the walk loop (or, for a type with no `seestate`, its held
  stand frame). Vanilla's pain and attack chains end by stepping back into `S_*_RUN1`, which is
  what makes this the boundary.
- **Letters are kept distinct, in first-appearance order.** Vanilla holds a pose by repeating its
  frame across states; against a flat per-frame rate that repeat is a no-op, and it is how the
  pose tables were written. A decoration's idle loop is the exception and is taken as written —
  the evil eye's `A,B,C,B` is a real wobble.
- **Attack** is the melee chain's letters, then the missile chain's, distinct, minus the walk
  cycle's — `SKEL`'s two attacks become one sequence, and `SPID`/`BSPI`'s `A_FaceTarget` frame
  reuses their idle letter.
- **Durations** are summed tics over 35. A chain that loops back through an `A_*Refire` counts
  only the loop (one pass of a chaingunner's attack); any other loop is the whole chain held — the
  lost soul cycles `S_SKULL_ATK3`/`ATK4` for as long as its charge flies.
- **The walk loop** gives `chaseInterval` (loop tics over chase calls over 35) and the factor
  `mobjinfo.speed` is multiplied by; a chase call is `A_Chase`, `A_VileChase`, or one of
  `p_enemy.c`'s three footstep wrappers (`A_Hoof`, `A_Metal`, `A_BabyMetal`), each of which plays
  its sound and then calls `A_Chase`.
- **Death** that steps to `S_NULL` rather than holding puts the type in `MONSTER_CORPSE_VANISHES`;
  a death chain whose first state draws another sprite writes `MONSTER_DEATH_SPRITE_OVERRIDE`, the
  seam the barrel's `BEXP` already uses — EPIC.WAD aims a hanging body at the imp's gib chain. A
  death pointed at `S_NULL` outright deletes the type's death entry, and `enterDeathPose` then hides
  the corpse, which is what vanilla's immediate `P_RemoveMobj` looks like.
- **A decoration's** idle loop is one flat rate, the loop's mean tics with ties rounding down —
  the rule the hand transcription turns out to have used (`POL6`'s 6/8 → 7, `ARM1`'s 6/7 → 6,
  `GOR1`'s 10/15/8/6 → 10). A single held frame that isn't `A` is a one-letter entry.
- **A missile's** spawn loop is its flight art, its death chain its impact, both under the pristine
  flight sprite's key. A patched flight sprite moves the missile to the new key in every
  sprite-keyed table — `AttackStats.projectile.sprite`, `WeaponDef.projectileSprite`,
  `PROJECTILE_RADIUS` and `PROJECTILE_SOUNDS` carried over — because that is `applyMissile`'s
  fan-out and a missile here *is* its sprite name.
- **The barrel's** chains are `BARREL_CHAIN`, one mutable record: idle loop, death letters and
  sprite, and the blast delay, which is the tics before the first `A_Explode` state. Re-reading that
  chain is what found vanilla's action on `S_BEXP4`, fifteen tics in, where a hand-written comment
  had put it on the third state.
- **The crushed corpse's** pool is `CORPSE_GIB`, the same shape. It is the one entry point resolved
  by **state name** rather than by walking a `mobjinfo` chain: nothing in `MOBJ_INFO` points at
  `S_GIBS`, so the walk over the thing rows never reaches it. The index is stable under a patch —
  a `Frame` record addresses rows by number and `patchStates` never rewrites a row's name — so
  repointing the state moves the pool. docs/specials.md § Crushed corpses.

**The four overrides.** Where the walker's rule and the hand transcription genuinely disagree, the
shipped reading wins and says so at its declaration — `FRAME_OVERRIDES` in `monsters/tables.ts` plus
the one pose override in `things/tables.ts`. That list is the complete inventory, and a new row on
it is a decision, never a shrug:

- the **Wolfenstein SS's** attack length, pose and windup. Its two `A_FaceTarget` states sit ahead
  of the `A_CPosRefire` loop and the walker measures the loop alone — correct for the chaingunner
  and the two spiders, but here it drops the `E` the SS visibly winds up on. All three follow the
  same span, so they move together.
- the **lost soul's and pain elemental's** windup: a charge and a spawn both return straight out of
  `beginRangedAttack`, so the burst timer `startDelaySeconds` is read through never runs.
- the **cacodemon's melee**: its `meleestate` is `S_NULL` — `A_HeadAttack` bites from inside the
  missile chain — so there is no chain to measure the bite's length or its windup from. Both are
  written out as the missile chain's own.

**Derive twice, write the difference.** For a *patch*, `applyFrames` derives from vanilla's table
and from the patched one and writes only the entries that differ. On an unpatched set nothing is
written at all, and a patch that touches one type leaves the other nineteen byte-identical. A patch
that edits an overridden type overrides it: the diff writes off the walker, which is what the patch
is asking for.

**The anchor is two tests, and `tests/fixtures/frametables.ts` is what they anchor to.** That
fixture holds the pose, letter and duration tables *as they were hand-transcribed from `info.c`*,
frozen — a second, independent reading of the same source. It is never regenerated from the walker;
that would make the check circular and throw away the only thing it is for.

1. **The walker reproduces it.** Deriving from pristine `STATES` must equal the fixture — every pose
   list, `painDuration`, both attack durations, `chaseInterval` and `speed` for all twenty monster
   types, `THING_SPRITES`, every `THING_ANIM_FRAMES` entry, the nine missiles, the barrel and the
   crushed corpse's pool — bar the overrides above, which it lists and requires to still differ.
2. **The tables the engine uses are the shipped reading**, overrides included. Without this second
   test a divergence the walker is *expected* to have would reach the game silently: deriving
   `MONSTER_ATTACK_POSE` dropped the SS's wind-up frame exactly that way, and test 1 passed
   throughout.

Writing the first is what found two transcription errors, both fixed toward `info.c`: every raise
sequence was one letter short (each `S_*_RAISE` chain ends on the type's first death frame), and the
barrel's blast delay above.

**What a patched chain can't reach**, all residuals rather than bugs: `AttackStats.refire` — which
is a `nextstate` pointing back at itself, not a position — stays as the stat table has it (the
windup, shot count and shot spacing around it are all derived — docs/monster-ai.md § The windup);
the flat per-frame rates (`MONSTER_DEATH_FRAME_SECONDS`, `IMPACT_FRAME_SECONDS`,
`BARREL_CHAIN.deathFrameSeconds`) stay flat; puff, blood and teleport-fog art is not derived; the
player's own `PLAYER_*` letters are constants; a pain, attack or raise chain is drawn in the type's
own sprite even if its states name another (`playOnce` takes no sprite — only death does). A
weapon's bob, raise and lower chains have no sink either — nothing here draws a gun.

**A `Frame` is classified by the state it names.** A world state applies, and so does a
**fire-chain** state: the 40-odd states from each weapon's `atkstate` to the `A_ReFire` that closes
it are exactly this engine's fire rates (docs/weapons.md § Fire rates), so a patch retuning a gun by
editing its durations lands. Every other psprite state — the ones `p_pspr.c` steps between
`S_LIGHTDONE` and `S_BFGFLASH2` — is `noTarget`: a muzzle flash (`isFlashState`, by `statenum_t`
name because the super shotgun's flash draws the gun's own `SHT2` lump) has nothing here to flash,
and a bob, raise or lower state nothing to draw. `fireChainStates` (`dehacked/states.ts`) is what
splits the two, and it lives beside the data because the classifier and the walker must not disagree
about where a fire chain ends. freedoom2's seven `Frame` records are five fullbright bits on firing
frames and two super-shotgun flash durations, which report.

**`[CODEPTR]` bodies are field lines.** `Frame 185 = A_PosAttack` carries an `=`, and a `Word N`
candidate with one is never a record header — reading it as one opened an empty `Frame` record per
line of the section (harmlessly, while `Frame` was skipped outright).

## Extended states

`STATES` is **1076 rows**: vanilla's 967, then MBF's 109. A `Frame N` is an index into that table
and not into `info.c`'s, because that is the table every patch is written against.

MBF's 109 (`info.c` from `S_TNT1` on) are the invisible state, killough's grenade and
variable-damage explosion, the marine's dog, and the dummy beta BFG, plasma, bonus-item and
lost-soul chains prboom carries "for dehacked compatibility". No `MOBJ_INFO` or `WEAPON_STATES` row
reaches one, so nothing derives off them until a patch points at one — which is what patches use the
range for. nosp4.wad builds a monster on the dog and beta-BFG rows.

`SPRITE_NAMES` is 245 for the same reason: vanilla's 138, MBF's seven, and prboom's hundred `SP00`
spare names, which is what a patch's own art draws through.

**Past 1076 the table grows.** `dsda_GetDehState` extends it to hold whatever index a record
addresses, and `dsda_EnsureCapacity` **doubles** rather than growing to fit — so the rows between
the highest index a patch names and that power of two exist too, and a pointer landing in them is
valid.
`stateTableSize` reproduces the doubling; `DehPatch.stateCount` is where a patch's own size travels,
merged across a set's lumps as the maximum. `MAX_STATE_INDEX` caps it, which dsda does not: an index
is an allocation.

A row the patch grew into is `freshState` — the invisible sprite, `tics` of -1, `nextstate` pointing
at itself, no action and no `statenum_t` name, exactly what `dsda_ResetStates` leaves. Every row a
patch cares about is then written by a `Frame` record of its own.

**Addressing a row grows the table; pointing at one does not.** A `Frame N` header, a
`Pointer N (Frame mm)` header, that record's own `Codep Frame` and a `[CODEPTR]`'s `FRAME n` each
address a row. A `Thing`'s eight pointers, a `Weapon`'s five and a `Frame`'s `Next frame` only point
into it, and dsda follows those long after the whole patch is read — so they are checked against the
size the finished patch left, not the one that existed when the line was met. `StateTable`
(`dehacked/parse.ts`) holds both halves; without the deferral a `Weapon` record naming a state its
own patch defines further down would be rejected for a record order the format does not require.

Two rules stop at `MBF_STATES_START`, and both would otherwise change the **unpatched** game:

- `isPspriteState`. `S_OLDBFG*` draws `SPR_BFGG` but sits in no `weaponinfo[]` chain, so a `Frame`
  on one of those rows is world data, not a gun being held.
- the `FULLBRIGHT_FRAMES` vote (`things/tables.ts`), which takes MBF's rows only where a `Frame`
  record wrote one. Vanilla has one bright `SKUL F` against MBF's two dim beta-lost-soul rows, so
  letting them vote unasked takes the glow off the charging lost soul.

`A_FireOldBFG`, `A_BetaSkullAttack` and `A_Stop` sit on those rows and are **not** in
`deh_bexptrs[]`, so no patch can name one. `ACTIONS` carries them anyway, marked `unnameable`:
`lookupAction` refuses them, and a repoint that clears one reports under its name.

Still out: **extended `mobjinfo`**. `Thing 138` and up name no row here, so a patch that builds a
new *thing* on extended states — as nosp4.wad's does — gets the states and not the type. MBF21's
`Args1`..`Args8` and `MBF21 Bits` are likewise unread.

## Action pointers

`Pointer` and `[CODEPTR]` move which `A_*` function a state runs, and MBF's whole addition to the
DEH format is ten new ones to move (`d_deh.c`'s `deh_bexptrs[]`: `A_Detonate`, `A_Mushroom`,
`A_Die`, `A_Spawn`, `A_Turn`, `A_Face`, `A_Scratch`, `A_PlaySound`, `A_RandomJump`,
`A_LineEffect`). `A_FireOldBFG`, `A_BetaSkullAttack` and `A_Stop` exist in MBF's code but are not
in that array, so no patch can name them.

Nothing steps `states[]` at runtime here, so **an action reaches this engine exactly one way: the
walker reads the action column, and a repoint is an edit to the copy it walks** (§ Frames).
`patchStates` writes the repoints into that copy before `deriveFrameTables` walks it; everything
downstream is the derivation that was already there. Moving `A_CPosAttack` onto a chain changes
that chain's shot count, windup and interval without a line of new runtime code.

Both record spellings land in `DehPointerEdit`, and they differ in where the action comes from:

- `Pointer N (Frame mm)` with `Codep Frame = yy` gives state `mm` the action state `yy` carries.
  `N` is DeHackEd's own cross-reference number and names nothing here — the target is the
  parenthesised frame. The action is read off **pristine** `STATES`, which is `d_deh.c`'s
  `deh_codeptr[]` snapshot: two repoints in sequence must not chain through each other.
- `[CODEPTR]`'s `FRAME nnn = Mnemonic` names the action itself. `deh_procBexCodePointers` prefixes
  `A_` before the lookup, so `Chase` and `A_Chase` are one line; `A_NULL` clears the action, which
  is a meaningful edit rather than a no-op.

`dehacked/actions.ts` is the table both sides read: every `deh_bexptrs[]` name under the **role**
the walker gives it. A role *is* a sink, and these six are what the derivations key off — named in
one place now, instead of three name sets inside the walker:

| Role | What reads it |
|---|---|
| `chase` | the walk loop's `chaseInterval` and speed factor |
| `firing` | an attack chain's shot count, windup, shot interval — and what the attack *is* (below) |
| `weaponFire` | how many shots one pass of a fire chain makes (docs/weapons.md § Fire rates) |
| `refire` | which part of a looping attack chain `spanOf` measures |
| `sound` | `A_PlaySound`: the sound of whichever chain it sits in |
| `drop` | `A_Spawn` on a death chain: what the type leaves behind (`MONSTER_DROPS`) |

**A repointed attack is a different attack, not a retimed one.** The chain says which action it now
fires (`MonsterFrames.rangedAction`); `ATTACK_ACTION_SOURCES` (`dehacked/tables.ts`) says which
monster owns that action in vanilla, and the applier copies *that type's* `AttackStats` — roll,
projectile, splash — onto the repointed one before the chain's own timings are written over it. A
bridge and not a second table of rolls, for `MISSILE_SINKS`' reason: those figures are already
written once in `MONSTER_SEED` with their `p_enemy.c` citations, and a copy here would be the drift
the one-home rule exists to prevent. Three rules fall out of that:

- The copy is taken **after** `applyThing`, so a patch that retunes the cyberdemon's rocket and then
  borrows `A_CyberAttack` gets the retuned figure — in vanilla the two share one `mobjinfo`.
- Where the owning type has no attack in *this* slot, its other one is taken: vanilla's actions
  don't care which chain they sit in, so `A_PosAttack` in a melee chain still fires bullets, gated
  by the melee range the chain is entered at.
- An action that is not an attack at all leaves the type's attack alone rather than clearing it;
  only a chain whose firing action is **gone** (`A_NULL`) loses its attack.

**A repointed fire chain is the same rule on the player's side.** `WeaponFrames.action` is the
first of `p_pspr.c`'s nine the chain now carries, `WEAPON_ACTION_SOURCES` says which weapon owns it,
and the applier copies that weapon's `WeaponDef` — kind, roll, spread, ammo cost, projectile,
splash, sounds — onto the repointed one. Three fields never come with it: `ammoType` is the `Weapon`
record's own line, `cooldown` is walked off the chain itself, and `iconLump` is the pickup's art.
The ordering and the two fallbacks are the monster side's, unchanged: the copy is taken after
`applyWeapon` and `applyMisc`, and an action the bridge doesn't name leaves the weapon's shot alone.
Only the first firing action counts — a `WeaponDef` holds one shot shape and not a per-shot
schedule, the same reason `cooldown` is a mean over the pass. nosp4.wad's Super Rocket Launcher is
the case this exists for: the chainsaw slot, `Ammo type = 3`, and a fire chain past the end of the
table carrying `A_FireMissile`.

The player's own art rides along: `WeaponDef.skinWeapon` is borrowed with the shot, so that chainsaw
is drawn in the launcher's hands. A shot that resolves to no weapon clears it and stands the whole
shipped skin set down — docs/sprites.md § When a patch moves a weapon's shot.

**A missile chain is read for every firing action it carries, not only its first.** Vanilla never
needs that — its multi-shot chains repeat one action — but a patch can make a chain fire two
different ones, and NoSp2.wad's cybruiser does: `A_CyberAttack` then `A_BruisAttack`, a rocket and
then the baron's green ball. `MonsterFrames.rangedActions` lists them in firing order and each
resolves through `ATTACK_ACTION_SOURCES` exactly as the chain's own does, giving
`AttackStats.shotAttacks` — one attack per shot, built only where the actions have different
owners. docs/monster-attacks.md § A volley of unlike shots.

**A repoint is classified as an edit, not as an action** (`classifyDehackedPointer`). Four rules,
and the first is what keeps a report readable:

1. A patch restating the action a state already has raises **nothing** and files no edit. Whole
   `[CODEPTR]` blocks are written that way.
2. A repoint with a role on **either** side is `applied` — the derived tables move. That covers
   clearing an `A_Chase` as much as adding one.
3. A role that only reaches a sink from certain chains is checked against the chains the target
   state actually belongs to (`chainKindsOf`, walked over **pristine** `MOBJ_STATES`). `A_Spawn` on
   a melee chain reports `noTarget` naming the chains it would have needed; a state can belong to
   several at once, which is why membership is a list — the imp's `S_TROO_ATK3` is both its melee
   and its missile chain.
4. Anything else reports under the **target action's** name, so the row says which pointer a patch
   wanted.

`Unknown 1` and `Unknown 2` — `state_t`'s `misc1`/`misc2` — are carried on `DehFrameEdit.args`,
dense and positional, index 0 first, and reach the walker as `PatchedStates.args`. That is a side
map rather than two more columns on `StateRow` because **`linuxdoom-1.10` has no such fields at
all**: DeHackEd invented them and MBF gave them meanings, so vanilla's reading is "absent", not
"zero on 967 rows". MBF21's `Args1`..`Args8` are the same slots widened and would extend the array
rather than replace it.

### What MBF's ten reach

| Pointer | Here |
|---|---|
| `A_Scratch` | **applied** — a melee attack of its own: `misc1` flat damage (written as a one-sided die), `misc2` the swing's sound |
| `A_PlaySound` | **applied** — `misc1` becomes the melee, missile, pain or death chain's own sound (the melee chain's is the *connecting* sound, `MonsterSounds.melee`; a `Thing`'s `Attack sound` line is what reaches `meleeWindup`) |
| `A_Spawn` | **applied on a death chain** — `misc1` is a 1-based `mobjinfo` index, and what it names becomes this type's `MONSTER_DROPS` entry. Elsewhere it would need a state clock |
| `A_Detonate`, `A_Mushroom` | no sink: the barrel is the only type this engine explodes, off its own chain |
| `A_Die` | fires at a point in a chain, and nothing steps states here to reach that point |
| `A_Turn`, `A_Face` | an actor's angle is AI-driven here, not something a state sets |
| `A_LineEffect` | **unsupported** — triggering a tagged linedef effect from a state is reachable (the specials layer has the seam) and deliberately not built |
| `A_RandomJump` | **unsupported** — § What is not supported |

The deliberate reading in that table is `A_Spawn`'s. MBF spawns the thing where the actor stands,
at the moment the chain reaches that state; a drop lands on death and only one is modelled. That is
the same effect at the resolution this engine has, and the alternative was no support at all.

## Sprite renames

BEX `[SPRITES]` — and before it, a vanilla `Text 4 4` whose old string is a sprite name, which
`d_deh.c`'s `deh_procText` checks for first — renames the four characters a sprite's lumps start
with: `POSS = ZOMB` draws the zombieman from `ZOMB*`. Both prboom-plus's and Eternity's
`deh_procBexSprites` match the key against the **pristine** `sprnames[]`, snapshotted before any
patch runs, so a rename never chains through an earlier one, and later entries win per key.

The sink is `wad/sprites.ts`, applied when a `SpriteBank` is built: a renamed sprite's lumps are
indexed under the name things ask for as well as their own, so `lookup` pays nothing per call. That
indexing happens in a pass of its own, ahead of the own-name lumps, so a rename outranks them
whatever the load order — otherwise `POSS = ZOMB` would lose to any `POSS*` lump the set still
carries (docs/sprites.md § Rotation 0 against directional frames). `game.ts` builds the bank after
`applyDehacked`, which is the ordering this rests on. Derivation, the pose tables and
`FULLBRIGHT_FRAMES` all keep the logical name — only lump resolution moves.

A numeric `Sprite N` record is `noTarget`, like `Sound N`: it moves a pointer into the exe's own
string table.

## Weapon, Ammo and Misc

A `Weapon` record reaches **everything vanilla stores**, which is an ammo type and five state
pointers: `d_deh.c`'s `deh_weapon[]` has no damage and no fire rate, because in vanilla a weapon's
rate *is* the durations of the chain `Shooting frame` points at. So a patch retunes a gun either by
editing that chain's `Frame` records or by repointing it, and both land the same way — the rate is
re-walked (docs/weapons.md § Fire rates). The other four pointers are carried so the record reads
whole; only `Shooting frame` changes anything, there being no first-person weapon here to raise,
lower or bob.

Two spellings to know, both `d_deh.c`'s: `Deselect frame` is `upstate` and `Select frame` is
`downstate` — the two the wrong way round. `WEAPON_STATE_FIELDS` keeps the patch's spellings and
`WEAPON_STATES` the struct's, so neither side has to remember the swap.

An `Ammo type` line is the only one that can *clear* something, so its absence is load-bearing: a
record that only repoints frames leaves the weapon's ammo class alone rather than disarming it. It
lands twice: on what the weapon spends, and on what its map pickup hands over. `P_GiveWeapon` reads
the one `weaponinfo` field for both — two clips of the class unless it is `am_noammo` — while this
engine keys the grant by doomednum in `WEAPON_PICKUPS`, so `applyWeapon` writes both. Without that
a patch's re-armed chainsaw is picked up empty.

What the chain now *fires* is the `Shooting frame`'s business rather than this record's —
§ Action pointers.

`Ammo` reaches both of vanilla's tables, `maxammo[]` and `clipammo[]`. The second matters more than
it looks: `P_GiveAmmo` multiplies a pickup's `num` by `clipammo[type]`, so `Per ammo` drives what
every ammo pickup is worth, not just the backpack maths. `inventory/tables.ts`'s `AMMO_PICKUPS` and
`WEAPON_PICKUPS` therefore hold **clip counts rather than amounts** — a clip is one, a box is five,
a weapon hands over two — which is vanilla's own indirection, and is what lets `setClipAmmo` reach
the pickups without re-deriving anything.

`Misc` reaches the health/armor limits, `BFG Cells/Shot`, and the rows belonging to the cheats this
engine has — `God Mode Health` and `IDKFA Armor`/`IDKFA Armor Class` (docs/cheats.md). The `IDFA`
rows have no target because that cheat isn't implemented, and `Monsters Infight` none because
infighting here is not a single global switch (docs/monster-ai.md § Infighting).

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

`SFX_ORDER` bridges `sfxenum_t` onto this engine's names.

`SFX_ORDER` is **derived** from `audio/sfx.ts`'s `SFX` rather than transcribed a second time: that
table already *is* `S_sfx[]` in `sounds.h` order, and a second copy of 108 names would only be a
thing that could drift. What that costs is a dependency on `SFX`'s declaration order staying
vanilla's, which is exactly what the pinned indices in `tests/game/dehacked-tables.test.ts` catch.
Slot 0 is `sfx_None` and is `null`: a patch setting a sound field to 0 is asking for silence, and
`MonsterSounds`' fields are already optional, so that maps to deleting the field.

There is no `musicenum_t` bridge: a numeric `Music N` record only moves a pointer into the exe's
own string table, so it classifies `noTarget` outright (below) and only BEX's `[MUSIC]` mnemonic
form names a lump this engine can resolve. A `Music N` sink would need one composed out of
`audio/music/tables.ts`' `DOOM1_MUSIC`/`DOOM2_MUSIC` the way `SFX_ORDER` composes `SFX`.

A `Thing` record's five sound fields resolve through `SFX_ORDER` onto `MonsterSounds` (and onto
`INERT_SHOOTABLE`'s own pain/death sounds for the two types that carry them outside the stat table).
EPIC.WAD uses this.

BEX's `[SOUNDS]` and `[MUSIC]` redirect **which lump a name resolves to**, through an indirection
in `audio/sfx.ts` (`soundLumpName`) and `audio/music/tables.ts` (`musicLumpName`). Both are empty
unless a patch said otherwise, so with none loaded each is exactly the template literal vanilla's
`i_sound.c` builds.

The value on either side is a **name, not a lump name**: `d_deh.c`'s `deh_procBexSounds`/`Music`
write it into `S_sfx[].name`/`S_music[].name` — capped at six characters for exactly this reason —
and the prefix is what `I_GetSfxLumpNum`/`S_ChangeMusic` then put in front of it. So `pistol =
newgun` means lump `DSNEWGUN`, and `DS` is prepended unconditionally: `dshtgn` is a real sfx name,
so a "don't double the prefix" rule would silently mean the super shotgun's lump instead.
`[MUSIC]` is the one that can afford that tolerance — no `mus_*` mnemonic begins with `d_` — and
takes it, so a patch writing `runnin = D_OTHER` gets what it plainly meant rather than `D_D_OTHER`.

A `[SOUNDS]` key is held against `S_sfx[]`'s own names before it is stored, the way a `[SPRITES]`
key is held against `sprnames[]`. Unchecked, a key naming nothing is stored under itself and
counted `applied` — a redirect no `soundLumpName` lookup can reach, reported as a win. nosp4.wad
writes six of them as raw `sfxenum_t` indices. `[MUSIC]` has no such check yet: it would need the
mnemonic list `audio/music/tables.ts` holds in four separate consts.

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

## Obituaries

`OB_*` replaces the death overlay's killer line — the one under "YOU DIED" — whole.
`dehacked/tables.ts`'s `OBITUARY_SINKS` maps each mnemonic onto the `DamageCause` whose line it
takes over, and `things/tables.ts`'s `OBITUARIES` holds the lines themselves.

**The table is keyed by whole sentence for this reason.** It used to be `THING_NAMES`, a doomednum
to `"an Arch-Vile"`, with `obituary` interpolating `You were killed by …` around it. A patch's
string is a complete line and there is no fragment in it for that to slot into, so the interpolation
had to go: `OBITUARIES` now holds `You were killed by an Arch-Vile` in full, plus `'crush'`,
`'slime'`, `'self'` and a `'default'` key that is not a `DamageCause` at all but the fallback for an
unattributed death.

**Two reference sets, both accepted.** Vanilla DOOM has no obituaries, and the two ports that
define them disagree about scope: Eternity's BEX string mnemonics table has only the attacker-less
causes (`OB_CRUSH`, `OB_SLIME`, `OB_BARREL`, `OB_ROCKET_SELF`, `OB_DEFAULT`), while ZDoom's
`LANGUAGE` adds a per-monster set (`OB_VILE`, `OB_ZOMBIE`, `OB_CYBORG`, …). Both are read. Where
the two name one sink twice — `OB_ROCKET_SELF` and ZDoom's `OB_R_SPLASH` — they are aliases, and
the order of `OBITUARY_SINKS` decides rather than the order of the patch: a patch that sets both
meant the same thing by them.

**The `*HIT` melee variants are `noTarget`, except two.** A `DamageCause` is the killer's doomednum
and nothing else; it does not carry which of that type's attacks landed, so `OB_IMPHIT` has nowhere
to go that `OB_IMP` isn't already. `OB_DEMONHIT` and `OB_SPECTREHIT` do apply, because the demon
and the spectre never attack at range and ZDoom gives them no other mnemonic. Three types have no
mnemonic in either set and so keep this engine's wording unconditionally: the pain elemental,
Commander Keen and the Icon of Sin.

**A patched line is put into the second person, so it reads like the engine's own.** The text is
written about a third-person victim — ZDoom's `%o was squished.` — and `%o` *is* that victim, who
here is only ever the one player the line is being shown to. So `%o` resolves to `you`, and
`%g`/`%h`/`%p`/`%s` to `you`/`you`/`your`/`yours`, with `%hself` matched ahead of `%h` so it reads
`yourself`. The result is capitalised wherever `%o` left it, which for every stock string in either
set is the front: `You were squished.`

**No subject is invented for a string that names none.** Eternity's table lists the bare predicate
(`was squished`) because its port prepends the player's name; this engine has no name to prepend and
does not guess one, so such a line shows as written — `Was squished`. Every real patch measured here
writes `%o`, freedoom2's forty-eight `OB_*` lines included.

**One verb correction, and the corpus says one is enough.** `you was` becomes `you were`, the only
disagreement either reference set produces on a mnemonic that has a sink. Everything else they write
is past tense (`stood in awe of`, `went boom`, `met a Nazi`, `got trilo-bitten`, `died`) or a modal
(`couldn't evade`, `should have stood back`), and those read the same in either person. The
third-person-singular forms that *would* need more — `suicides`, `admires` — sit only on
`OB_SUICIDE` and mnemonics with no sink here, so they never reach this. If that stops being true the
answer is to widen the audit, not to reach for a conjugator.

## Locked-door lines

`PD_*` replaces the center message a locked door or switch raises. All fifteen apply — vanilla's six
color lines (`PD_BLUEK`/`PD_BLUEO` and their red and yellow twins, the "open this door" against
"activate this object" split) and Boom's nine generalized ones (`PD_*C`, `PD_*S`, `PD_ANY`,
`PD_ALL3`, `PD_ALL6`). `specials/tables.ts`'s `LOCKED_LINES` holds them keyed by mnemonic, verbatim
from `d_englsh.h`, and `lockedLine` resolves a `LockRule` to one.

**No transform on the way in**, unlike § Obituaries: these strings are already whole second-person
sentences addressed to the player, with no format tokens and no third-person victim to convert.

**The color words survive a patch** because they are found rather than composed.
`ui/hud/message.ts: lockedLineMessage` used to build
`['You need a ', blue, ' key to open this door']` as three runs, which is precisely why `PD_*` could
not be honored: a patch writes one string and there was no seam in it for the colored fragment. Now
the finished line is split on whole color words — `blue`, `red`, `yellow` in their key colors,
`green` in `ARM1A0`'s green for a patch that names a color DOOM has no key for — so a rewritten line
still colors correctly, and one that names no color simply draws in the message's own yellow.

**Why the table is in `src/game/` and not beside the module that draws it.** `dehacked/apply.ts`
writes it, and nothing under `src/game/` may import `src/ui/`. The mirror of that constraint is that
`dehacked/tables.ts` cannot import the specials tables either — it is on the read side, where the
menu classifies a patch with no `Game` (§ The two entry points) — so it spells the fifteen mnemonics
out itself and a test cross-checks the two lists.

## Cheat responses

`STSTR_*` replaces the line a cheat code prints. Five of them apply — `STSTR_DQDON`/`STSTR_DQDOFF`,
`STSTR_KFAADDED`, `STSTR_NCON`/`STSTR_NCOFF` — the responses of the three cheats this engine has
(docs/cheats.md). `game/cheats.ts`'s `CHEAT_MESSAGES` holds them keyed by mnemonic, verbatim from
`d_englsh.h`, and `replaceByMnemonic` — the one applier § Locked-door lines also goes through —
replaces one by name: no transform, because these too are finished lines.

The rest of the family — `STSTR_FAADDED`, `STSTR_BEHOLD`, `STSTR_MUS`, `STSTR_CLEV`,
`STSTR_CHOPPERS` and the others — stays `noTarget`: the cheats they answer aren't implemented, so
there is nothing to write them onto. The `STSTR_` prefix row in `dehacked/tables.ts` covers those,
and the five above are whole keys ahead of it — the same prefix-plus-exceptions shape the `PD_*`
mnemonics use, spelled out on the read side for the same reason and cross-checked by the same test.

## Par times

`[PARS]` is read in both forms the format allows — `par <map> <secs>` and
`par <episode> <map> <secs>` — with a trailing `#` comment stripped first, because freedoom2 puts
one on every line.

The table it overrides, and the deliberate episode-4 deviation, are in docs/wad.md § Par times. The
display rule is docs/hud.md § Intermission.

## What is not supported

**Two action pointers.** `A_RandomJump` branches a chain on a random draw, and the walker reads a
chain as one linear run with nothing stepping states at runtime to jump; the walk follows the
fall-through `next` and the patch is reported. `A_LineEffect` would trigger a tagged linedef effect
from a state — the specials layer has the seam for it, which is what makes this out of scope rather
than absent. Every other pointer either lands or names the per-type property that holds its
behavior instead — § Action pointers.

**Extended `mobjinfo`, and MBF21's own fields.** A patch may address states past vanilla's table
(§ Extended states) but not *things* past `mobjinfo`'s 137 rows, so one that builds a new monster
out of extended states gets its frames and no type to hang them on — nosp4.wad's six new monsters
are exactly that. MBF21's `Args1`..`Args8`, its `MBF21 Bits` on a `Thing` or `Weapon`, and its own
action pointers (`A_MonsterProjectile`, `A_HealChase`, `A_JumpIfTargetInSight`, …) are unread for
the same reason the extended things are: each is its own table, not a bound.

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
no automap; `CC_*` because there is no cast call; `OB_MP*` and the deathmatch weapon obituaries
because there is no deathmatch. **This paragraph and the `noTarget` rows of `STRING_PREFIXES` are
where that list lives** — the reader is told once, here, rather than on every run (§ The coverage
report).

Every prefix still on that list has nowhere to go at all. The two that had a real sink and were
merely awkward to reach — `OB_*` and `PD_*` — are done: see § Obituaries and § Locked-door lines,
which both had to hold whole lines rather than interpolated fragments before a patch had anything
to replace.

**Every shipped patch's report, for the record.** freedoom2's lands everything but two
super-shotgun flash durations (`noTarget`). EPIC.WAD's lands everything but its misspelled
`Radius` — and its one repointed death, on a hanging body whose `Bits` line drops `MF_SHOOTABLE`,
is applied and unreachable.

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
| `vile.ts`'s `vileWindupTrackSeconds()` | reads `MONSTER_STATS` at its one call site, which runs once per windup. |
| `FULLBRIGHT_FRAMES` | a `Set` refilled by `rebuildFullbrightFrames` from the patched or pristine frame table. |
| `WEAPON_CYCLE`, `SFX_NAMES` | nothing: DEH has no slot concept and never adds a sound. |

The frame walker's sinks — `THING_SPRITES`, `THING_ANIM_FRAMES`, the seven pose tables,
`MONSTER_DEATH_SPRITE_OVERRIDE`, `PROJECTILE_FRAMES`, `IMPACT_EFFECTS`, `PROJECTILE_SOUNDS`,
`BARREL_CHAIN` — are registered like the stat tables, and `MONSTER_CORPSE_VANISHES` joins the flag
`Set`s. `applyFrames` runs after the `Thing` loop (whose `Speed` scaling it composes with) and
before `rebuildDerivedMonsterStats` (which derives from the durations it writes).

The inventory's tables are not reached into either: `inventory/tables.ts` is read-only data, and the
values a patch does move (`AMMO_MAX`, `CLIP_AMMO`, `LIMITS`) stay in `inventory.ts` beside the
`setMaxAmmo`, `setClipAmmo`, `setInventoryLimits` and `resetInventoryLimits` that own their
derivations. `audio/sfx.ts`, `audio/music/tables.ts` and `wad/sprites.ts` do the
same for their lump redirects.

The patch has to land **before `buildThingSprites`**, which resolves the stat table once per level
and snapshots each thing's radius and height at spawn, before the `SoundBank`, which pre-decodes on
construction, and before the `SpriteBank`, which indexes `[SPRITES]` renames as it is built. It also
has to land before the session's `createInventory()`, which reads `Misc`'s `Initial Health` and
`Initial Bullets` off `LIMITS` — which is why `Game.inventory` is assigned in the constructor
**body** and not as a field initializer: those run first, and did, so the starting kit came from
whatever the previous session left behind.

## Savegames and patched tables

Two things needed handling, and **neither needed a `SAVE_VERSION` bump** — both are the
optional-field-whose-absence-means-the-old-behavior pattern (docs/savegames.md § The format and its
version).

A PWAD carrying a `DEHACKED` lump is now a **required** WAD. Without that it would be droppable with
a warning row, and dropping it would silently revert every patched table under a save written
against it — a change in what the save *means*, not just how it looks. `SaveMeta` carries an
optional `patchWads` naming those files' content IDs; its absence means no patch was applied, which
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
- **`unsupported`** — deliberately out of scope even though a target exists or could (action
  pointers, `ID #`).
- **`unknown`** — not recognised at all.

The distinction between the middle two is the one worth keeping: only `unsupported` is ever worth
revisiting.

Warnings are **deduped by `(record, field, support)` and counted**, so a patch whose seven `Thing`
frame fields all miss is one row saying seven and not seven rows. `support` is in the key because
one record word can land differently by index — a `Frame` on a muzzle flash has no target, one past
the table is unknown — and a row says one thing.

**A `[STRINGS]` shortfall is reported only when it is `unknown`.** A recognised mnemonic this engine
has no home for — `GOT*`, `CC_*`, `AMSTR_*`, the deathmatch obituaries — is passed over in silence.
It went the other way first, one grouped row per family, and that was wrong twice over. It was
**noise**: freedoom2's patch produced sixteen rows whose entire content was a restatement of the
scope this document already fixes, burying the one `Frame` row a reader can act on. And once a
family became *partly* applied it was **misleading**: 31 obituary mnemonics reporting "no string
this engine has anywhere to show" read as though obituaries were unimplemented, when in fact every
one naming a killer this engine has had landed. Freedoom2's report is now a single `Frame` line.

The rule: **the report names what a reader can act on.** `unknown` qualifies — the parser did not
recognise the mnemonic, which is either a patch this engine should learn or a bug in the reader.
`unsupported` qualifies, since it is the list of things worth revisiting. A `noTarget` string does
not: the answer is "this engine is single-player and has no cast call", it will not change, and the
tables in `dehacked/tables.ts` are where that list belongs — not in every run's output.

`noTarget` still classifies, and still reports for the record kinds where it is *specific* rather
than categorical (a `Thing` field on a type with no table row, a `Misc` cheat value). What was
dropped is the per-family string row, not the class.

Three surfaces:

1. **The console**, once per `Game` — one line for what applied, one for what didn't.
2. **`scripts/inspect-wad.ts`**, a final block parallel to the specials one. It reports and never
   exits non-zero, like that one.
3. **The menu's WAD row**, which shows `DEHACKED` as a **presence** badge only. That is all it
   honestly can: a server file is listed from the build-time manifest, and knowing what a patch
   actually lands needs bytes the menu has not downloaded.
