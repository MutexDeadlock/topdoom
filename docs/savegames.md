# Savegames

A save is one JSON document: identity metadata (which WAD set, which map, which skill), a small
JPEG thumbnail, and a `GameSnapshot` — the full mutable state of the running level, down to the
random-table cursors. Loading one rebuilds the level through the ordinary
`Game.loadMapByIndex` funnel and then overwrites the mutable state, so everything the constructors
derive (BSP polys, meshes, spatial grids) is always derived from restored data rather than patched
afterwards. The store lives in `game/savegames.ts`, the payload types and encoding helpers in
`game/snapshot.ts`, the menu surface in `ui/menu/savegames.ts` (docs/menu.md § Save and Load tabs).

## The format and its version

`SaveGame` = `SaveMeta` (id, `version`, ISO date, display name, map lump name, skill, the WAD list,
level time, `thumb` data URL, the menu source keys) + `state: GameSnapshot`. The payload is
plain JSON with four deliberate encodings, all owned by `game/snapshot.ts`:

- **`Infinity` → `-1`** (`encodeSeconds`/`decodeSeconds`): `JSON.stringify(Infinity)` silently
  yields `null`, and the berserk/computer-map powers genuinely hold `Infinity`.
- **Sets and Maps → arrays** (`keys`, `weapons`, `usedOnce` as plain arrays; `movers`,
  `lightStates`, `switchFlashes` as `[key, value][]` entries).
- **The fog bitmap → run lengths** (`encodeRuns`/`decodeRuns`): alternating run lengths starting
  with zeros, JSON-native numbers rather than base64 so Node tests need no `atob`.
- **Sectors → only the changed ones** (`snapshotSectors`/`applySectors`, `[index, fields][]`): a
  restore applies them to a *freshly loaded* map, so a sector no door, lift, light or secret has
  touched is already correct and is left out. `Game` takes the baseline to diff against straight
  out of `loadMap`, before anything runs — the same state a later load's `applySectors` writes
  into, which is what makes "absent" mean "unchanged". Writing all of them out costs ~24 KB of
  JSON on DOOM2 MAP15 (301 sectors), most of an untouched save.
- **Floats → 6 decimals** (`roundFloat`): a `JSON.stringify` replacer, applied by the store's own
  `put` — dt-accumulated doubles otherwise serialize with 17-digit tails, which are most of a
  float's JSON cost, and 1e-6 map units/radians/seconds is far below anything observable. Integers
  (sector heights, the RNG cursors, the `-1` sentinel) pass through exactly. A replacer rather
  than a pass over the tree: the rounding only ever matters in the stored text, and a second copy
  of the largest object the feature builds is the last thing to allocate beside the quota this
  exists to protect. `Game.captureSave` hands over its state unrounded.

A killable thing's AI block is the one part not written out field by field: `MONSTER_SAVE_KEYS`
names the `PosedThing` fields it can carry, `MonsterFields` is `Pick`ed off `PosedThing` with that
tuple, and `snapshotThings`/`restoreThings` both loop over it through `copyMonsterField`. One list,
so a field can't be saved and then not restored — the failure mode a hand-written pair has no
compiler check against, and the block is ~30 fields the AI keeps growing.

The block is also **sparse**: a field still equal to its `pushThing` spawn default is omitted
(`MONSTER_FIELD_DEFAULTS`, mapped over the same tuple so a new key without a decided default is a
compile error), and `copyMonsterField` skips absent keys on restore, letting the fresh spawn
default stand. `pushThing` **spreads that same table** into every thing it builds, so the elision
baseline *is* the spawn record rather than a second copy of it — the dangerous drift otherwise is
silent and one-directional: a default changed only in `pushThing` would elide a live field that
then restores to something else. Three defaults aren't constants and are decided in
`snapshotThings` instead (`MONSTER_KEYS_WITH_DEFAULTS` is the rest): `health` compares against
`spawnHealthFor` (per type), `angle` against `facingDeg` in radians (already in every
`ThingState`), and `homingBias` — whose spawn value is a random draw — is always saved. Two
fields are derived on restore rather than saved at all: `dead` (⟺ `health <= 0`; every death
branch in `damageThing` and `reviveCorpse`'s full-health reset maintain the equivalence) and
`deathFrameCount` (recomputed by `enterDeathPose` for a restored corpse, spawn `0` otherwise). A
fully-populated pre-sparse block still restores identically — every listed key is simply present,
and unlisted keys are ignored — which is why the sparse encoding shipped without a `SAVE_VERSION`
bump (pinned in `tests/game/things-snapshot.test.ts`).

Object references never serialize as references: a thing's `sector`, the world's
`soundAlertedSectors` and a spawn cube's `target` are saved as indices and re-resolved against the
freshly loaded map (the reference-equality hazard is real: `ThingLayer.monstersInSector` compares
`Sector` objects by identity). Cross-*thing* references (`targetId`, `sourceId`) were already ids —
`PosedThing.id` is its index in `posed`, and the saved thing list keeps that order, which is why a
restore must never skip an entry (`buildThingSprites` throws on missing art instead).

`SAVE_VERSION` is a single integer, bumped on any change a version-1 reader would misread. The
loader refuses any other version; the Load tab still lists such saves (grayed, with the version
named) so they can be deleted or downloaded, just not loaded. This is deliberately unlike every
other `topdoom.*` key (docs/menu.md § Persisted settings): a settings scalar degrades safely under
structural validation, a snapshot's schema genuinely evolves and half-reading an old one produces a
subtly wrong level rather than a default.

## What is saved and what is deliberately not

Saved: the player (position, velocities, private knockback), inventory, `WeaponSystem`'s fire
timing, the *changed* sectors' mutable fields (`floorHeight`/`ceilHeight`/`light`/`special`/
`floorTex` — `DoomMap` is mutated in place at runtime by specials and secrets), the specials controller (movers
mid-motion, `usedOnce`, switch flashes, light states, the two shared sound/damage clocks,
`prevX`/`prevY`), secrets found + damage-floor timer, fog of war's `explored`, sound-alerted
sectors, every thing, the Icon of Sin, projectiles in flight, level time, camera yaw,
`recordsEligible` (so a `?pos=` run can't launder eligibility through a save), and the RNG cursors.

Deliberately not saved, each a sub-second transient whose absence on restore is invisible or
nearly so:

- **`SpriteFxLayer` entirely** — teleport fogs, impact puffs, tracer lines, the arch-vile flame.
  The vile's *attack state* rides in its thing's `attackPause`/AI fields; only the flame visual is
  lost.
- **Transient `playOnce` poses** (pain flinch, attack frames): a restored corpse replays its death
  sequence fast-forwarded by `deadTime`, but a live monster restarts from its walk cycle. The replay
  goes through `enterDeathPose`, the same function `damageThing` uses — `P_KillMobj`'s overkill-gib
  rule has exactly one implementation, so a corpse can't look different after a load than before it
  (docs/death.md § Monster death). This is why `health` is saved with its negative overkill intact.
- **`SpecialsController`'s one-frame flags** (`lastTeleport`, `lockedLine`) and the derived
  `moveSoundDue`/`crushDamageDue` booleans.
- **`WeaponSystem.weaponLastFrame`** — derivable, not transient. `WeaponSystem.update` runs last in
  the frame, after both switch sources (`handleSwitching` and a pickup's `applyPickup`), so at the
  frame boundary a save is captured on it always equals `inventory.currentWeapon`; `restore` takes
  the restored inventory and reads it back off that. What makes this load-bearing rather than
  cosmetic is that `beginLevel` runs against the *outgoing* inventory (§ Apply order, step 13), so
  a `weaponLastFrame` left over from before the load reads as a switch that never happened on the
  first frame after it: a restored chainsaw announces itself with `sawup`, and the restored
  `previousWeapon` is overwritten with the pre-load weapon, sending the right-button toggle to the
  wrong one. Pinned by "restoring a saved weapon does not read as a switch on the next frame"
  (`tests/game/specials-snapshot.test.ts`).
- **A pristine killable thing's AI block**: a monster still exactly in its spawn state saves no
  block at all — not even the sparse block's always-saved `homingBias` (`isPristine` in
  `game/things.ts`); its `lookTimer` phase and `homingBias` coin flip are re-seeded on restore,
  both invisible before first contact. This plus the sparse encoding is what keeps a 10k-monster
  map's save inside the quota (§ Storage and the cap).
- **Saving is refused mid-intermission, mid-exit and while dead** (`Game.saveRefusal`), which keeps
  the intermission/exit cascade out of the format entirely. `captureSave` *throws* that refusal
  rather than returning a sentinel, so the whole save path has one refusal convention and the
  player is told which of the three applies instead of all of them (docs/menu.md § Save and Load
  tabs).

## Apply order

`loadMapByIndex(index, restore)` runs its normal construction and interleaves the restore at fixed
points. The order is load-bearing; the two rules are **geometry before anything that reads
heights** and **RNG cursors dead last**.

1. Normal preamble: `clearRandom`, `finishLevel`, `weaponSystem.beginLevel`, overlay clears,
   `loadMap`, then `sectorBaseline(map)` — taken here, off the untouched map, because that is
   precisely the state step 3 writes into and therefore the one a capture may omit.
2. `new SectorEffects(map)` — *before* the sector snapshot, so `totalSecrets` counts the map's
   authored secrets (a consumed secret zeroes its sector's `special`).
3. `applySectors` writes the saved sector fields into the fresh `DoomMap` in place, then
   `sectorEffects.restore(...)` — in that order, and both here, because the counters restored belong
   to the instance step 2 already built from the *authored* specials. Everything built after this
   step bakes restored geometry — no rebuild/recolor pass exists anywhere below.
4. `computeMovableSectors(map)` **unioned with every saved mover's sector** — a mid-motion mover
   whose authored sector special was consumed would otherwise land back in the static batch. The
   union is handed to both `buildMapMesh` and the `SpecialsController` constructor.
5. `buildMapMesh` / `World` / faders, unchanged, over restored geometry.
6. `new Player(world)` → `player.restore(...)`; camera yaw from the snapshot rather than the spawn
   angle.
7. `new FogOfWar(...)` → `restoreExplored(...)` (the constructor's spawn-seeded reveal is
   overwritten wholesale, not ORed in).
8. `new SpecialsController(...)` → `specials.restore(...)`. Switch on-textures are flipped *here*,
   not in step 3: `findSwitchEntries` reads the authored sidedef as the off state, so flipping
   before that scan would invert every pair.
9. `world.restoreSoundAlerted(...)`.
10. `buildThingSprites(..., restore)` — the spawn loop is skipped and `posed` rebuilt from the
    save in order.
11. `new IconOfSin(...)` → `icon.restore(...)`.
12. `projectiles.beginLevel()` → `projectiles.restore(...)`.
13. Inventory deserialized, then `weaponSystem.restore(..., inventory)` — **in that order, and it
    takes the restored inventory**. `WeaponSystem.beginLevel` ran back at the top of the load
    against the *outgoing* inventory, so `weaponLastFrame` is left pointing at whatever weapon was
    in hand before, which is why it is derived from `inventory.currentWeapon` here rather than
    saved (see § What is not saved). (`levelTime` is taken back in step 3's block, with the sector
    state.)
14. `levelCard.show(...)` — **skipped on a restore**: the card announces *entering* a level, and a
    save resumes one already under way (docs/hud.md § Level card).
15. `setRandomCursors(...)` — after every construction-time `pRandom` draw (`makeLightState`
    seeding, `pushThing`'s `homingBias`) has already happened and been overwritten, so the first
    *simulation* draw after a load is exactly the one the save would have made next.

## Storage and the cap

Saves live in localStorage, one key per save (`topdoom.save.<id>`), listed by prefix scan — no
index key to desync, deletion is one `removeItem`. Reads are validated per entry in the
`besttimes.ts` style: a malformed save renders as unloadable rather than taking the list down.
`MAX_SAVES` caps the count and the store *refuses* the write when full — silently evicting
somebody's save is worse than asking them to delete one. The cap belongs to `writeSave` alone:
`overwriteSave` (refill a slot, keeping its id and name) and `renameSave` (the name only, `at`
included so the list can't reorder under the cursor) reuse the same key, add nothing to the count,
and so must keep working with a full list. `setItem` is wrapped so a
`QuotaExceededError` (the origin's ~5 MB budget, shared with everything else) surfaces as a
readable message in the menu. Thumbnails are ~320 px JPEGs (tens of KB); the state payload for a
normal map is a similar order of magnitude thanks to the pristine-thing, sparse-block, sparse-
sector, float-rounding and fog-RLE encodings. Sectors alone were ~24 KB on MAP15 before the diff
against the loaded map, against a ~40 KB untouched save. A disturbed monster costs ~350 bytes at worst (wounded and
mid-chase) and ~200 as a corpse, roughly half of what the pre-sparse full block did — measured
pre-sparse: DOOM2 MAP15 ~40 KB untouched, ~140 KB with every monster damaged. The known limit is
still a slaughter map with most of its monsters *disturbed* — NUTS.WAD with all 10k wounded was
~6 MB pre-sparse, around half that now, so a worst case can still brush the quota — where the
write fails with the quota message rather than corrupting anything.

## WAD-set identity

A save embeds its whole WAD set as **one list in load order**, `wads[0]` the game WAD. A `SaveWad`
is exactly what `wadSetId(wad)` produces — nothing is added on the way into the store — and it
carries two fields with sharply different jobs:

- **`id`** — `wadId`'s content hash (docs/wad.md § Content id, designed for exactly this). **This
  is the file's identity**, and the only thing a load matches on.
- **`name`** — what the file was called at save time. Purely for the player: it names the file to
  go and find. Nothing keys through it, so a renamed WAD still loads.

**Identity is content, never location.** A library key (`WadSource.key`) is an address, and
addresses are the unstable part: a rename changes one, and the same bytes have *different* keys
as a server file (`DOOM2.WAD`) and as an upload (`upload:DOOM2.WAD:14604584`). Saves used to store
that key and resolve through it, which meant a save made against an uploaded IWAD could never load
from the server's byte-identical copy. Matching on `id` fixes both, and it is why `Game.captureSave`
needs to know nothing about the library the files came from — the capture *is* the format.

Matching by id requires every `WadSource` to know its own id up front, since the save list resolves
synchronously on every render and must not download anything. So **the manifest carries each
server WAD's id**, computed in `plugins/wad-manifest.ts`, whose `describeWad` already holds the
whole file in memory; an upload is hashed once as it is added. The two must produce the same string
for the same bytes — the plugin hashes a Node `Buffer`, the runtime an `ArrayBuffer` — or every
load would refuse, so `tests/wad/checksum.test.ts` pins that agreement directly.

`Menu.resolveSaveWads` resolves the **whole set at once**, in load order, and is the only place
that happens: the save row (`describeSave`) and the load path (`main.ts`'s `loadSave`) both call
it, so a row reporting no problem can't be followed by a load that fails on one. It also does the
*diagnosis*: no id match, but a file of the same name present, means the same WAD in a different
version. The sentence for either outcome is `missingWadText`'s alone, so the row and the load
error can't word the same problem differently. `asMeta` *blanks* a damaged entry instead of
dropping it (`asWad`): dropping one would shift every later file into the wrong role, where a
blank fails loudly instead.

Loading resolves every entry before anything is torn down, so the running level survives a load
that can't happen, then still verifies each `wadId` against the saved list (`verifyWadSet` in
`main.ts`, on the shared `startLevel` path — see docs/menu.md § Session lifecycle) and refuses on
the first mismatch, *naming the file*. That check stays even though resolution now matches ids: a
manifest id is a build-time claim, and re-hashing the bytes actually in hand is what catches a
manifest left stale by a changed file.
