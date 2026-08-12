# Savegames

A save is two things: a `SaveMeta` (which WAD set, which map, which skill, a small JPEG thumbnail)
and a `GameSnapshot` — the full mutable state of the running level, down to the random-table
cursors — stored separately so that listing saves reads metas alone (§ Storage and the cap).
Loading one rebuilds the level through the ordinary `Game.loadMapByIndex` funnel and then
overwrites the mutable state, so everything the constructors derive (BSP polys, meshes, spatial
grids) is always derived from restored data rather than patched afterwards. The store lives in
`game/savegames.ts` over `game/savestore.ts`'s IndexedDB backend and byte codecs, the payload
types and encoding helpers in `game/snapshot.ts`, the menu surface in `ui/menu/savegames.ts`
(docs/menu.md § Save and Load tabs).

## The format and its version

`SaveGame` = `SaveMeta` (id, `version`, ISO date, display name, map lump name, skill, the WAD list,
level time, `thumb` data URL) + `state: GameSnapshot`. The snapshot serializes as JSON with four
deliberate encodings, all owned by `game/snapshot.ts`:

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
- **Floats → 6 decimals** (`roundFloat`): a `JSON.stringify` replacer, applied at the one place
  the snapshot is stringified (`encodeState`, feeding the compressor) — dt-accumulated doubles
  otherwise serialize with 17-digit tails, which are most of a float's JSON cost, and 1e-6 map
  units/radians/seconds is far below anything observable. Integers (sector heights, the RNG
  cursors, the `-1` sentinel) pass through exactly. A replacer rather than a pass over the tree:
  the rounding only ever matters in the serialized text, and a second copy of the largest object
  the feature builds is the last thing to allocate beside the quota this exists to protect.
  `Game.captureSave` hands over its state unrounded; the meta is stored as an object, where digits
  cost nothing, so only `levelTime` is rounded (in `createMeta`, because the export file
  stringifies the meta without a replacer).

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
other persisted `topdoom.*` value (docs/menu.md § Persisted settings): a settings scalar degrades
safely under structural validation, a snapshot's schema genuinely evolves and half-reading an old
one produces a subtly wrong level rather than a default. It versions the snapshot's *content*
only: the move to IndexedDB with split, gzipped records shipped without a bump, because how the
bytes are stored is the separately-versioned `STATE_ENCODING`'s job (§ Storage and the cap) and
the snapshot inside is unchanged.

## What is saved and what is deliberately not

Saved: the player (position, velocities, private knockback), inventory, teleport fogs still
playing, `WeaponSystem`'s fire timing, the *changed* sectors' mutable fields (`floorHeight`/`ceilHeight`/`light`/`special`/
`floorTex` — `DoomMap` is mutated in place at runtime by specials and secrets), the specials controller (movers
mid-motion, `usedOnce`, switch flashes, light states, the two shared sound/damage clocks,
`prevX`/`prevY`), secrets found + damage-floor timer, fog of war's `explored`, sound-alerted
sectors, every thing, the Icon of Sin, projectiles in flight, level time, camera yaw,
`recordsEligible` (so a `?pos=` run can't launder eligibility through a save), and the RNG cursors.

Deliberately not saved, each a sub-second transient whose absence on restore is invisible or
nearly so:

- **`SpriteFxLayer` except the teleport fogs** — impact puffs, blood, bullet puffs, the revenant's
  smoke trail, tracer lines and the arch-vile flame are all dropped. The vile's *attack state* rides
  in its thing's `attackPause`/AI fields; only the flame visual is lost. The **teleport fog is the
  exception, and the reason is its length**: 10 frames of 6 tics is ~1.7 s, long enough to save
  inside and notice the puffs vanish, where every other effect here is gone in a fraction of that.
  `snapshotTeleportFogs` saves a position and `elapsed` per puff; `restoreTeleportFogs` respawns
  through the ordinary `spawn` — so the animator, the sector light and `drawPrev*` are re-derived
  rather than stored — and then fast-forwards the animator by `elapsed` in one `advance`, whose own
  frame loop lands it on the frame the save was taken on. Silent on restore: `telept` played when
  the teleport happened, and a load is not a second teleport. Within a float epsilon of an exact
  frame boundary the restored puff can land one frame either side of where it was; that is one
  frame of a cosmetic transient at 35 Hz, and buying exactness would mean a seek API on
  `SpriteAnimator` for this one caller. Pinned by `tests/game/spritefx-snapshot.test.ts`.
  `GameSnapshot.teleportFogs` is **optional**, which is what let it ship without a `SAVE_VERSION`
  bump: absent means no fogs, exactly what a save from before it restored to.
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
  player is told which of the three applies instead of all of them. The menu also asks the same
  question *before* the click, to disable Save and Overwrite and name the reason (docs/menu.md
  § Save and Load tabs) — the throw is still what enforces it.

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
4. `new World(map)`, then `effects.beginLevel(world)` — which clears the layer — and
   `restoreTeleportFogs` refilling it. After step 3, so each puff re-samples its sector's *restored*
   light; after `beginLevel`, which would otherwise drop what was just restored.
   `projectiles.beginLevel()` also runs here, clearing that layer for step 13's restore.
5. `computeMovableSectors(map)` **unioned with every saved mover's sector** — a mid-motion mover
   whose authored sector special was consumed would otherwise land back in the static batch. The
   union is handed to both `buildMapMesh` and the `SpecialsController` constructor.
6. `buildMapMesh` / faders, unchanged, over restored geometry.
7. `new Player(world)` → `player.restore(...)`; camera yaw from the snapshot rather than the spawn
   angle, and `camera.snapTo` on the restored position so the view doesn't fly in from the outgoing
   level (docs/render.md § The camera is simulation state).
8. `new FogOfWar(...)` → `restoreExplored(...)` (the constructor's spawn-seeded reveal is
   overwritten wholesale, not ORed in).
9. `new SpecialsController(...)` → `specials.restore(...)`. Switch on-textures are flipped *here*,
   not in step 3: `findSwitchEntries` reads the authored sidedef as the off state, so flipping
   before that scan would invert every pair.
10. `world.restoreSoundAlerted(...)`.
11. `buildThingSprites(..., restore)` — the spawn loop is skipped and `posed` rebuilt from the
    save in order.
12. `new IconOfSin(...)` → `icon.restore(...)`.
13. `projectiles.restore(...)` — into the layer step 4's `beginLevel` already cleared.
14. Inventory deserialized, then `weaponSystem.restore(..., inventory)` — **in that order, and it
    takes the restored inventory**. `WeaponSystem.beginLevel` ran back at the top of the load
    against the *outgoing* inventory, so `weaponLastFrame` is left pointing at whatever weapon was
    in hand before, which is why it is derived from `inventory.currentWeapon` here rather than
    saved (see § What is not saved). (`levelTime` is taken back in step 3's block, with the sector
    state.)
15. `levelCard.show(...)` — **skipped on a restore**: the card announces *entering* a level, and a
    save resumes one already under way (docs/hud.md § Level card). The checkpoint restart is a
    restore like any other here, so it raises no card either (§ The checkpoint).
16. `setRandomCursors(...)` — after every construction-time `pRandom` draw (`makeLightState`
    seeding, `pushThing`'s `homingBias`) has already happened and been overwritten, so the first
    *simulation* draw after a load is exactly the one the save would have made next.

## Storage and the cap

Saves live in IndexedDB (database `topdoom`, `game/savestore.ts`), split across two object stores
keyed by save id: `saves-meta` holds each `SaveMeta` as a plain structured-clone object, and
`saves-state` holds the snapshot as **gzipped JSON bytes** (`CompressionStream`, native in browser
and Node alike) tagged with a `STATE_ENCODING` number. The split is the point: `listSaves` is one
`getAll` over metas and never touches a state, so the save list costs thumbnails, not snapshots.
The trade-off is deliberate and cuts both ways — a save whose *state* record is missing or corrupt
lists as loadable and only fails (readably) at load, because finding out earlier would mean
decompressing every save to draw a list. `STATE_ENCODING` is versioned separately from
`SAVE_VERSION`: one names the byte encoding, the other the snapshot's content, and they evolve
independently.

Two rules in `savestore.ts` are load-bearing. An IndexedDB transaction auto-commits as soon as
control returns to the event loop with no request pending, so compression finishes *before*
`putSave` opens its transaction, and both puts (meta + state) are issued synchronously inside one
`readwrite` transaction — an abort rolls both back, so a quota failure can't leave an orphan meta.
And a failed database *open* is un-cached, so a transient refusal (private mode, storage pressure)
is retried the next time the menu lists.

Reads are validated per meta in the `besttimes.ts` style: a malformed record renders as unloadable
rather than taking the list down. `MAX_SAVES` caps the count and the store *refuses* the write when
full — silently evicting somebody's save is worse than asking them to delete one. The cap belongs
to `writeSave` (and `importSave`) alone: `overwriteSave` (refill a slot, keeping its id and name)
and `renameSave` (the name only, `at` included so the list can't reorder under the cursor — and the
meta record only, so renaming never rewrites state bytes) add nothing to the count, and so must
keep working with a full list. A `QuotaExceededError` out of the write transaction surfaces as a
readable message in the menu (mapped in `savegames.ts`, not the backend, so the tests' in-memory
backend exercises the same translation). Quota pressure is far lower than under localStorage's
~5 MB: the origin budget is typically hundreds of MB, and gzip takes several-fold off the
snapshot JSON on top of the pristine-thing, sparse-block, sparse-sector, float-rounding and
fog-RLE encodings it compresses. The uncompressed sizes for scale: DOOM2 MAP15 ~40 KB untouched
(~24 KB of that would be sectors without the diff), a disturbed monster ~350 bytes, a corpse ~200,
NUTS.WAD with all 10k monsters wounded ~3 MB.

## The checkpoint

Advancing into a level writes a **checkpoint**: an ordinary save, under the reserved id
`AUTOSAVE_ID` (`'auto'`), taken by `Game.enterLevel` immediately *after* `loadMapByIndex` has built
the new level. Dying and pressing `R` reloads it, so a death costs the level and not the run's
inventory (docs/death.md § Player death). Both ways of arriving at the next level go through
`enterLevel` — the exit the player took, and the DEVMODE `N`/`P` jump, which would otherwise leave
a level with no checkpoint to restart from. The session's *first* level is deliberately not one of
them: nothing was advanced into, so `R` there restarts as it always did.

The reserved id is the whole mechanism, and that is deliberate: hiding a save by *id* needs no
`SaveMeta` field, so the format is unchanged and `SAVE_VERSION` did not move. The id is also what
makes it self-overwriting — the same key replaces both records, so there is only ever one — and
`freshId` (a base-36 timestamp plus a counter) can never collide with it. Three consequences the
code has to honor, all in `savegames.ts`:

- `listSaves` filters the row out. It is the engine's save, not the player's, and both tabs list
  through that one function, so one filter keeps it out of Save and Load alike.
- `countListed` discounts it, so the checkpoint never costs a player one of the `MAX_SAVES` slots.
  `writeAutosave` itself skips the cap, for `overwriteSave`'s reason: no new key appears.
- `readAutosave` collapses every refusal `readSave` can throw — missing, damaged, or written by a
  build with a different `SAVE_VERSION` — to `null`. None of them is worth a message, because the
  caller's fallback (a plain restart) is a perfectly good outcome.

The capture skips the thumbnail (`captureSave(false)`): nothing ever lists it, so the extra render
would be for a JPEG no one sees. Writing is fire-and-forget, and `Game.hasCheckpoint` only goes up
once the bytes are actually stored — a refused write (a full quota) must not take the level change
down with it, and must not leave a checkpoint that isn't there readable.

`hasCheckpoint` is *also* what scopes the checkpoint to the session. A `Game` spans every level of
a run, so the flag means "this run has advanced at least once"; without it, a run started on a map
that some earlier run happened to checkpoint would restore that run's inventory. `matchesSession`
then re-checks map, skill and the WAD set by content on top of it.

`Game` reaches the store through the injected `CheckpointStore` port, never directly — the same
split as `SaveHooks`: `main.ts` owns the library and the database, `Game` owns which moment is
worth capturing.

## Download and import

A downloaded save is **one JSON file**, tab-indented: every meta field in the clear — a person can
open it and read what it is — plus the state's stored gzip bytes, base64'd, as `state`, with the
record's encoding as `stateEncoding`. Base64 costs a third over the raw bytes and is still several
times smaller than the snapshot's plain JSON. `exportSave` deliberately does **no decompression**:
the bytes are handed over verbatim, so an unsupported-version save — and even one whose state no
longer decompresses — escapes to disk byte-exact, carrying its stored `version` untouched (only
`importSave` ever stamps `SAVE_VERSION`). The one thing that refuses to download is a save whose
state record is missing outright: there are no bytes left to hand over.

`importSave` re-validates everything a foreign file could get wrong — JSON, version (named both
ways on mismatch), meta shape, base64, gzip, the snapshot's own shape — and then stores the
*decoded* bytes verbatim rather than recompressing, under a fresh id (importing the same file
twice must make two saves, never overwrite) and a meta rebuilt through `asMeta` so no extra
top-level keys are smuggled into storage. The pre-IndexedDB export shape (`state` as a plain JSON
object) is refused: the format is unreleased, so it gets no compat path.

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
