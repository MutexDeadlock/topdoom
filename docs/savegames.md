# Savegames

A save is two things: a `SaveMeta` (which WAD set, which map, which skill, a small JPEG thumbnail)
and a `GameSnapshot` — the full mutable state of the running level, down to the random-table
cursors — stored separately so that listing saves reads metas alone (§ Storage).
Loading one rebuilds the level through the ordinary `Game.loadMapByIndex` funnel and then
overwrites the mutable state, so everything the constructors derive (BSP polys, meshes, spatial
grids) is always derived from restored data rather than patched afterwards. The store lives in
`game/savegames.ts` over `game/savestore.ts`'s IndexedDB backend and byte codecs, the payload
types and encoding helpers in `game/snapshot.ts`, the menu surface in `ui/menu/savegames.ts`
(docs/menu-saves.md § Save and Load tabs).

## The format and its version

`SaveGame` = `SaveMeta` (ID, `version`, ISO date, display name, map lump name, skill, the WAD list,
level time, `thumb` data URL) + `state: GameSnapshot`. The snapshot serializes as JSON with four
deliberate encodings, all owned by `game/snapshot.ts`:

- **`Infinity` → `-1`** (`encodeSeconds`/`decodeSeconds`): `JSON.stringify(Infinity)` silently
  yields `null`, and the berserk/computer-map powers genuinely hold `Infinity`.
- **Sets and Maps → arrays** (`keys`, `weapons`, `usedOnce` as plain arrays; `movers`,
  `lightStates`, `switchFlashes` as `[key, value][]` entries).
- **The fog bitmap → run lengths** (`encodeRuns`/`decodeRuns`): alternating run lengths starting
  with zeros, JSON-native numbers rather than base64 so Node tests need no `atob`.
- **Things → only the changed ones** (`ThingsSnapshot.changed`, `[id, state][]`): the same idea one
  layer over, and the same reason — a restore re-spawns the map, so a thing nothing has touched is
  already correct (§ What is saved and what is deliberately not).
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

**`SAVE_VERSION` stays 1** through the thing-list change, deliberately: before v1.0 there are no
saves worth a version, and the number is being kept for the first break that costs real players
something. A save written before the change simply does not load, and nothing was added to explain
it — the only such saves were made by development builds. Everything else added since is still the
optional-field rule: absence means the old behaviour, the `teleportFogs` pattern. Breaking saves at
all is the user's decision, not a free move (CLAUDE.md § Project-wide rules).

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
then restores to something else. Six defaults aren't constants and are decided in
`snapshotThings` instead (`MONSTER_KEYS_WITH_DEFAULTS` is the rest): `health` compares against
`spawnHealthFor` (per type), `angle` against `facingDeg` in radians (already in every
`ThingState`), `homingBias` — whose spawn value is a random draw — is always saved, and the three
`spawn*` fields (`mobj->spawnpoint`, which only a nightmare respawn reads —
docs/monster-ai.md § Respawning monsters) compare against the `x`/`y`/`facingDeg` the same
`ThingState` already carries, since a thing's spawn point *is* where it is until it moves. Those
three were added after release and cost no `SAVE_VERSION` bump for the usual two reasons: they are
optional, so a save written before them restores a corpse with its spawn point set to wherever it
lies (it would come back where it fell rather than where the map placed it — visible on nightmare
alone, on a save made before the feature existed), and an older reader ignores keys it doesn't
know. Two
fields are derived on restore rather than saved at all: `dead` (⟺ `health <= 0`; every death
branch in `damageThing` and `reviveCorpse`'s full-health reset maintain the equivalence) and
`deathFrameCount` (recomputed by `enterDeathPose` for a restored corpse, spawn `0` otherwise). A
fully-populated pre-sparse block still restores identically — every listed key is simply present,
and unlisted keys are ignored — which is why the sparse encoding shipped without a `SAVE_VERSION`
bump (pinned in `tests/game/things-snapshot.test.ts`).

Object references never serialize as references: a thing's `sector`, the world's
`soundAlertedSectors` and a spawn cube's `target` are saved as indices and re-resolved against the
freshly loaded map — **a thing's from its saved position** (`applyThingState` → `refreshSector`),
since the spawn loop cached the sector under its *spawn* point and a corpse never moves again to
re-derive it. Without that the floor ride (`ThingLayer.update`'s non-AI branch) snaps every
restored corpse to its spawn sector's floor each tic: GoingDown MAP07's terraces, 27 corpses hoisted
to 88 on load, pinned in `tests/game/things-snapshot.test.ts` (the reference-equality hazard is real: `ThingLayer.monstersInSectors` compares
`Sector` objects by identity). Cross-*thing* references (`targetId`, `sourceId`) were already IDs —
`PosedThing.id` is its index in `posed`, and the saved thing list keeps that order, which is why a
restore must never skip an entry (`buildThingSprites` throws on missing art instead).

`SAVE_VERSION` is a single integer, bumped on any change a version-1 reader would misread. The
loader refuses any other version; the Load tab still lists such saves (grayed, with the version
named) so they can be deleted or downloaded, just not loaded. This is deliberately unlike every
other persisted setting (docs/menu.md § Persisted settings): a settings scalar degrades
safely under structural validation, a snapshot's schema genuinely evolves and half-reading an old
one produces a subtly wrong level rather than a default. It versions the snapshot's *content*
only: the move to IndexedDB with split, gzipped records shipped without a bump, because how the
bytes are stored is the separately-versioned `STATE_ENCODING`'s job (§ Storage) and
the snapshot inside is unchanged.

## What is saved and what is deliberately not

Saved: the cheats currently switched on (`cheats`, **optional** for the same no-bump reason
`teleportFogs` is, and written only while one is on: absent means neither, which is what a save
from before cheats existed also means — docs/cheats.md § Saves and best times), the player
(position, velocities, private knockback), inventory (whose exact card/skull
keys ride the optional `keySlots` — the always-written `keys` colors keep the save readable by
pre-slot builds, and a save without `keySlots` restores each color as both slots, exactly the
merged semantics those builds had), teleport fogs still
playing, `WeaponSystem`'s fire timing (including the super shotgun's reload clock, `reloadTic`, and
`chainEnding`, whether a fire chain is still waiting for its `A_ReFire` — both **optional** for the
same no-bump reason `teleportFogs` is: absent means neither is in flight) and
its per-slot selection memory (`slotWeapon`, optional the same way: absent means only the restored
weapon's own slot is remembered, docs/weapons.md § Slot keys),
the *changed* sectors' mutable fields (`floorHeight`/`ceilHeight`/`light`/`special`/
`floorTex`, plus the optional `ceilTex` only Boom's generalized ceiling changes rewrite —
`DoomMap` is mutated in place at runtime by specials and secrets), the specials controller (movers
mid-motion, `usedOnce`, switch flashes, light states, the two shared sound/damage clocks,
`prevX`/`prevY`, the optional `stairFlips` — the line indices Boom's retrigger alternation
currently has flipped, restored as a plain Set since the map itself is never mutated
(docs/specials.md § Generalized linedefs) — and the optional `ceilingMovers`, the second of the two
per-sector mover slots Boom keeps apart. **That one is read back by `mover.kind`, not by which
field it arrived in**: a save written before the split holds every kind in `movers`, so sorting on
restore covers both shapes without a bump (docs/specials.md § One mover per sector)),
secrets found + damage-floor timer (an older save's `dollTimer` beside it, from the removed
per-doll damage pass, is simply ignored), fog of war's `explored`, sound-alerted
sectors, every thing, the Icon of Sin, projectiles in flight, the optional `voodoo` block — where
each of the level's dolls has been carried to and the momentum it is carrying, absent in any save
from before dolls existed, which leaves them standing on their own player starts exactly as a fresh
load does (docs/specials-forces.md § Voodoo dolls) — the optional `scrollers` block (the
accelerative scrollers' built-up speed, below), level time, camera yaw,
`cheated` (so a `?pos=` run, a cheat or a taken-over replay can't launder its level's eligibility
through a save), and the RNG cursors.

**The player's external momentum is still stored as `knockVelX`/`knockVelY`.** That channel widened
past knockback into the general one conveyors and pushers feed (`Player.momX`/`momY`,
docs/movement.md § External momentum), and the wire names were deliberately left alone: renaming
them would orphan every existing save for a field whose meaning only grew.

**Scroller state is saved only where it isn't presentation.** A plain scroller's offset *is*
presentation — where a waterfall's texture happens to be — and a displacement one re-derives its
rate the next time its control sector moves, so neither is stored: what a restore loses is the
phase of a scrolling texture, and nothing else. **The accelerative scrollers are the exception**,
because their integrator is not visual — an accelerative conveyor (216/217) keeps carrying at its
built-up speed with the control sector standing still, so dropping it on load would park everything
on the belt until that sector moved again. The optional `scrollers` block holds those integrators
and only those: `[scrollerIndex, vdx, vdy]` per scroller that has built up any, indexed against the
level's spawn order, absent when none has (`Forces.snapshot`, docs/specials-forces.md § Scrollers
and conveyors). `lastHeight` — what a displacement scroller watches — needs no field at all, because
`Forces` is constructed *after* `applySectors` (§ Apply order, step 6).

**The render transfers are not saved either, and need no field.** 213/242/260/261 are read straight
off the map at load (docs/specials-transfers.md § Render transfers), and the one thing about them
that can change at runtime — a 242 control sector's floor height, which sets the water level — is
already an ordinary `SectorEntry.floorHeight`. The apply order does the rest: `applySectors` runs
before `buildMapMesh`, so a restored save bakes its water surfaces at the heights it was saved with.

**`transfersOf` is nevertheless called before `applySectors`**, once, purely to fix the two scans in
`Transfers`' constructor that compare sector heights — `markFakeFloors` and `markPools`. Those
classify the map as *authored*; run against restored heights instead, a saved mover reads at the
height it stopped at and a raised pool bottom comes back as a sector that never had water over it
(docs/specials-transfers.md § Deep water). Everything read from the table afterwards is a live
height lookup, so nothing else about it depends on when it was built — `transfersOf` memoizes per
map, and the later call in `beginLevel` gets the same instance.

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
- **Transient `playOnce` poses**, with one exception: a pain flinch (4-12 tics) is dropped and the
  monster restarts from its walk cycle. A restored corpse replays its death sequence fast-forwarded
  by `deadTime`; the replay goes through `enterDeathPose`, the same function `damageThing` uses —
  `P_KillMobj`'s overkill-gib rule has exactly one implementation, so a corpse can't look different
  after a load than before it (docs/death.md § Monster death). This is why `health` is saved with
  its negative overkill intact — and why the corpse's `crushed` flag *is* an ordinary AI-block
  field: a squashed corpse's pool is `enterDeathPose`'s answer like any other pose
  (docs/specials-crushers.md § Crushed corpses). It defaults to false, so a save written before it
  existed restores an uncrushed corpse and needs no `SAVE_VERSION` bump. **The exception is an
  attack pose with shots still pending** (`restoreAttackPose`), replayed and fast-forwarded the same
  way off `AttackStats.duration - attackPause` — the same "long enough to save inside and notice"
  argument the teleport fog above makes, and for the same reason it is the *only* pose that gets it:
  the arch-vile's cast is 94 tics, most of them after its warning flame appears, so a save taken
  mid-cast otherwise loaded a vile standing in its idle frame with a flame burning on the player
  (docs/monster-archvile.md § The windup flame). `burstLeft > 0` is the test — something pending
  only ever means an attack under way, never its tail or the arch-vile's deliberately poseless
  `S_VILE_HEAL` hold — and `swinging` says whether it is a melee chain or a missile one, which only
  the revenant animates differently. Saved-field-wise this is free: the pose is re-derived from
  `attackPause`/`burstLeft`/`swinging`, all of them ordinary AI-block fields.
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
  `game/things.ts`); its `homingBias` coin flip is re-seeded on restore, invisible before first
  contact. The idle look-around it used to lose with it is no longer per-monster at all — one
  cadence off the level clock, which the save already carries (docs/monster-ai.md § Waking up). This plus the sparse encoding is what keeps a 10k-monster
  map's save inside the quota (§ Storage).
- **A save's thing list keeps only what the run changed**: `changed` holds `[id, state]` pairs for
  the things no longer as the map spawned them, in ascending id. There is one restore path and it
  always starts from the map — the spawn pass runs, `spawnBaseline` records what it made, and the
  save is read over it; an id past the spawn count is a thing the run itself created and is pushed
  in order, which is what keeps the index the id. A MAP15 save on entering the level is 1.4 kB where
  the whole list was 4.2 kB, and 2.1 kB after a fight.
- **`applyThingState` sets `angle` from `facingDeg`**, since the spawn underneath it is the *map's*
  angle rather than this save's, and a monster block omits `angle` precisely when the two agree.
  Without it a restored monster faces where the map placed it, not where the run left it.
- **`applyThingState` also re-seats `prev`**, the point the walk's line-crossing test measures from,
  which `pushThing` seeded at the map's spawn point. Without it the first tic after a load tests a
  segment running from a restored monster's spawn all the way to where the save left it. The
  candidates are still only the walk lines within `MONSTER_CROSS_RADIUS` of where it now stands
  (`SpecialsController.crossLines`), so what fires is one of those the long segment happens to pass
  through — a monster restored just past a teleporter it spawned on the far side of teleports on
  load without having walked anywhere.
- **Saving is refused mid-intermission, mid-exit and while dead** (`Game.saveRefusal`), which keeps
  the intermission/exit cascade out of the format entirely. `captureSave` *throws* that refusal
  rather than returning a sentinel, so the whole save path has one refusal convention and the
  player is told which of the three applies instead of all of them. The menu also asks the same
  question *before* the click, to disable Save and Overwrite and name the reason (docs/menu-saves.md
  § Save and Load tabs) — the throw is still what enforces it.

## Apply order

`loadMapByIndex(index, restore)` runs its normal construction and interleaves the restore at fixed
points. The order is load-bearing; the two rules are **geometry before anything that reads
heights** and **RNG cursors dead last**.

**A `GameSnapshot` is read-only to the restore, and the same object may be applied any number of
times.** Every step below copies scalars, rebuilds through the ordinary spawner, or
`structuredClone`s (`specials.restore`'s movers and light states, `projectiles.restore`) — none
keeps a live reference into the snapshot for the running level to mutate. That is what lets `R`
replay the same in-memory snapshot after each death (docs/death.md § Player death); a store-backed
load gets a fresh object per read either way and does not depend on it.

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
5. `scanSectors(map)`'s two sets **unioned with every saved mover's sector** — a mid-motion mover
   whose authored sector special was consumed would otherwise land back in the static batch. The
   union is handed to both `buildMapMesh` and the `SpecialsController` constructor.
6. `buildMapMesh` / faders, unchanged, over restored geometry — then `new Forces(map, world)` →
   `forces.restore(...)` and `new VoodooDolls(world)` → `voodoo.restore(...)`. **Both after step
   3**: a displacement scroller samples its control sector's height at spawn, so building it against
   the authored heights would make the first restored tic read the whole saved-to-authored
   difference as one tic of movement. Only the accelerative integrators need the explicit restore on
   top.
7. `new Player(world)` → `player.restore(...)`; camera yaw from the snapshot rather than the spawn
   angle, and `camera.snapTo` on the restored position so the view doesn't fly in from the outgoing
   level (docs/camera.md § The camera is simulation state).
8. `new FogOfWar(...)` → `restoreExplored(...)` (the constructor's spawn-seeded reveal is
   overwritten wholesale, not ORed in).
9. `new SpecialsController(...)` → `specials.restore(...)`. Switch on-textures are flipped *here*,
   not in step 3: `findSwitchEntries` reads the authored sidedef as the off state, so flipping
   before that scan would invert every pair.
10. `world.restoreSoundAlerted(...)`.
11. `buildThingSprites(world, { restore, … })` — the spawn loop is skipped and `posed` rebuilt
    from the save in order.
12. `new IconOfSin(...)` → `icon.restore(...)`.
13. `projectiles.restore(...)` — into the layer step 4's `beginLevel` already cleared — then
    `cheats.restore(...)`, order-free: nothing else reads the toggles during a load
    (docs/cheats.md § Saves and best times).
14. Inventory deserialized, then `weaponSystem.restore(..., inventory)` — **in that order, and it
    takes the restored inventory**. `WeaponSystem.beginLevel` ran back at the top of the load
    against the *outgoing* inventory, so `weaponLastFrame` is left pointing at whatever weapon was
    in hand before, which is why it is derived from `inventory.currentWeapon` here rather than
    saved (see § What is saved and what is deliberately not). (`levelTime` is taken back in step 3's block, with the sector
    state.)
15. `levelCard.show(...)` — **skipped on a restore**: the card announces *entering* a level, and a
    save resumes one already under way (docs/hud.md § Level card). The checkpoint restart is a
    restore like any other here, so it raises no card either (§ The checkpoint).
16. `setRandomCursors(...)` — after every construction-time `pRandom` draw (`makeLightState`
    seeding, `pushThing`'s `homingBias`) has already happened and been overwritten, so the first
    *simulation* draw after a load is exactly the one the save would have made next.

## Storage

Saves live in IndexedDB (database `topdoom`, `game/savestore.ts`), split across two object stores
keyed by save ID: `saves-meta` holds each `SaveMeta` as a plain structured-clone object, and
`saves-state` holds the snapshot as **gzipped JSON bytes** (`CompressionStream`, native in browser
and Node alike) tagged with a `STATE_ENCODING` number. The split is the point: `listSaves` is one
`getAll` over metas and never touches a state, so the save list costs thumbnails, not snapshots.
The trade-off is deliberate and cuts both ways — a save whose *state* record is missing or corrupt
lists as loadable and only fails (readably) at load, because finding out earlier would mean
decompressing every save to draw a list. `STATE_ENCODING` is versioned separately from
`SAVE_VERSION`: one names the byte encoding, the other the snapshot's content, and they evolve
independently.

`idbBackend` is parameterized by database name and store prefix: the replays keep the same
meta/bytes split in their own database (docs/replays.md § Storage), and nothing about a save's
meaning lives in that layer.

Two rules in `savestore.ts` are load-bearing. An IndexedDB transaction auto-commits as soon as
control returns to the event loop with no request pending, so compression finishes *before*
`putSave` opens its transaction, and both puts (meta + state) are issued synchronously inside one
`readwrite` transaction — an abort rolls both back, so a quota failure can't leave an orphan meta.
And a failed database *open* is un-cached, so a transient refusal (private mode, storage pressure)
is retried the next time the menu lists — including a browser with no `indexedDB` at all, which
`idbOpener` rejects ahead of the cache rather than storing the rejection for the tab's lifetime.

The request plumbing under both rules — `asPromise`, `txDone` and the lazily-opened, un-cached-on-
failure handle from `idbOpener` — lives in `util/idb.ts`, shared with the WAD library's own database
(docs/wad.md § The player's own library) and the best-time records' (docs/hud.md § The store). The
three databases stay **separate**, so an upgrade that fails for one can't take the others down; only
the plumbing is shared.

Reads are validated per meta in the `besttimes.ts` style: a malformed record renders as unloadable
rather than taking the list down. **The save list has no count limit**: storage is bounded by the
origin's quota alone, and nothing evicts a save the player did not delete. `overwriteSave` refills a
slot keeping its ID and name, and `renameSave` touches the name only (`at` included, so the list
can't reorder under the cursor — and the meta record only, so renaming never rewrites state bytes).
A `QuotaExceededError` out of the write transaction surfaces as a
readable message in the menu (mapped in `savestore.ts`'s `putStored`, above the backend, so the
tests' in-memory backend exercises the same translation — and the replays' write takes the same
path). Quota pressure is far lower than under localStorage's
~5 MB: the origin budget is typically hundreds of MB, and gzip takes several-fold off the
snapshot JSON on top of the pristine-thing, sparse-block, sparse-sector, float-rounding and
fog-RLE encodings it compresses. The uncompressed sizes for scale: DOOM2 MAP15 ~40 KB untouched
(~24 KB of that would be sectors without the diff), a disturbed monster ~350 bytes, a corpse ~200,
NUTS.WAD with all 10k monsters wounded ~3 MB.

## The checkpoint

Advancing into a level writes a **checkpoint**: an ordinary save, under the reserved ID
`AUTOSAVE_ID` (`'auto'`), taken by `Game.enterLevel` immediately *after* `loadMapByIndex` has built
the new level. Dying and pressing `R` reloads it, so a death costs the level and not the run's
inventory (docs/death.md § Player death) — unless the level has a savegame of its own, which `R`
prefers: `Game.savedState` holds the snapshot the level was loaded from plus any manual save
`saveVia` has since stored, and only a level with neither falls back to the checkpoint.
Both ways of arriving at the next level go through
`enterLevel` — the exit the player took, and IDCLEV's warp, which would otherwise leave
a level with no checkpoint to restart from. The session's *first* level is deliberately not one of
them: nothing was advanced into, so `R` there restarts as it always did.

The reserved ID is the whole mechanism, and that is deliberate: hiding a save by *ID* needs no
`SaveMeta` field, so the format is unchanged and `SAVE_VERSION` did not move. The ID is also what
makes it self-overwriting — the same key replaces both records, so there is only ever one — and
`freshId` (`savestore.ts`: a base-36 timestamp plus a counter, shared with the replays) can never
collide with it. Two consequences the code has to honor, both in `savegames.ts`:

- `listSaves` filters the row out. It is the engine's save, not the player's, and both tabs list
  through that one function, so one filter keeps it out of Save and Load alike.
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

## Naming

**A blank name falls back to `defaultName`: the WAD that supplied the map with its extension
dropped, then the map — `DOOM2 MAP05`, `NUTS MAP01`.** The provider is the file `mapWad` names,
the game WAD where the set names none, and the bare map where there is no set at all. No date is in
it: the row already shows `at`. `game/savegames.ts` owns the rule and **replays share it**
(docs/replays.md § Recording), so the two lists read alike.

## Download and import

A downloaded save is `<name>.topdoomsave.json` (`saveFileName`) — the save's own name, anything a
filesystem could object to replaced, so the file on disk is the row the player clicked. The suffix
pairs with the replays' `.topdoomreplay.json`; both come from `downloadFileName`, and it is what
`Menu.installDropTarget` routes a dropped file by (docs/menu-saves.md § Replays tab). A save
downloaded before the suffix existed still imports: the drop rule takes any other `.json` as a save,
and the importer reads content, not names.

`node scripts/inspect-save.ts <file>` reads a downloaded save headlessly — meta, WAD roles, the
player's position out of the decoded state, and `--state`/`--thumb` dumps — through the same codec
the game stores with, so a reported save can be examined without a browser.

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
*decoded* bytes verbatim rather than recompressing, under a fresh ID (importing the same file
twice must make two saves, never overwrite) and a meta rebuilt through `asMeta` so no extra
top-level keys are smuggled into storage. The pre-IndexedDB export shape (`state` as a plain JSON
object) is refused: the format is unreleased, so it gets no compat path.

## WAD-set identity

A save embeds its whole WAD set as **one list in load order**, `wads[0]` the game WAD, plus
`mapWad` — the content ID of the file that supplied the saved map's lumps. A `SaveWad` is exactly
what `wadSetId(wad)` produces and `mapWad` exactly what `wadId(wad.providerOf(map))` does — nothing
is added on the way into the store — and a `SaveWad`'s two fields have sharply different jobs:

- **`id`** — `wadId`'s content hash (docs/wad.md § Content ID, designed for exactly this). **This
  is the file's identity**, and the only thing a load matches on.
- **`name`** — what the file was called at save time. Purely for the player: it names the file to
  go and find. Nothing keys through it, so a renamed WAD still loads.

**Identity is content, never location.** A library key (`WadSource.key`) is an address, and
addresses are the unstable part: a rename changes one, and the same bytes have *different* keys
as a server file (`DOOM2.WAD`) and as an upload (`upload:DOOM2.WAD:14604584`). Saves used to store
that key and resolve through it, which meant a save made against an uploaded IWAD could never load
from the server's byte-identical copy. Matching on `id` fixes both, and it is why `Game.captureSave`
needs to know nothing about the library the files came from — the capture *is* the format.

Matching by ID requires every `WadSource` to know its own ID up front, since the save list resolves
synchronously on every render and must not download anything. So **the manifest carries each
server WAD's ID**, computed in `plugins/wad-manifest.ts`, whose `describeWad` already holds the
whole file in memory; an upload is hashed once as it is added. The two must produce the same string
for the same bytes — the plugin hashes a Node `Buffer`, the runtime an `ArrayBuffer` — or every
load would refuse, so `tests/wad/checksum.test.ts` pins that agreement directly.

**A load requires two files, not the whole set.** Everything a snapshot stores keys through an
index into *one map's* lumps — a sector index, a `posed` index, a subsector index for the fog — so
the only files that can change what a stored index means are the game WAD and whatever supplied
that map. An add-on which supplied neither gave the session textures, sprites, sounds or MAPINFO at
most: without it the level looks or sounds different, but every index still points at the same
thing. `requiredWads(wads, mapWad, patchWads)` is that rule, positionally, and it is why a save made
with a test PWAD loaded still loads when the map came from the IWAD. Where the map came from the
add-on instead, the same reasoning frees the game WAD as well and another may stand in for it —
§ A stand-in game WAD.

**A file carrying a `DEHACKED` lump is the exception**, and the optional `patchWads` names those.
A patch rewrites the stat tables a restore re-derives every monster from, so dropping it changes
what the save *means* rather than only how it looks — and `snapshotThings`' `health` elision runs
against `spawnHealthFor`, a patched value. Requiring the file back is what keeps that baseline the
same one the save was written against. Absent means no patch was applied, which is exactly what
every save written before the field existed meant, so an older save keeps the looser rule and stays
loadable at `SAVE_VERSION` 1. docs/dehacked.md § Savegames and patched tables.

Its hedge is also what keeps the field **compatible**, at `SAVE_VERSION` 1: `requiresWholeSet` — a
`mapWad` that is blank or names no entry in the set — puts a save back under the old whole-set
rule. A save written before the field has no `mapWad` (`asMeta` reads it as `''`) and so is gated
exactly as it was when it was written, and a damaged field can only ever be too strict, never too
lax. That condition has **one** spelling, in that function, because it is the branch every gate
turns on: two spellings of it (`mapWad === ''` in one place, "matches no entry" in another) disagree
precisely on the damaged saves it exists to protect.

Being lenient about the rest is deliberate, and it costs the exactness of what is *drawn*: a level
restored without the add-on that only skinned it comes back with the game WAD's textures and
sounds. That is a visible difference the player can see and fix (load the file, load again), where
refusing was an invisible one they could not.

`Menu.resolveSaveWads` resolves the **whole set at once**, in load order, and is the only place that
happens: the save row (`describeSave`) and the load path (`main.ts`'s `loadSave`) both call it, so a
row reporting no problem can't be followed by a load that fails on one. It also does the
*diagnosis*: no ID match, but a file of the same name present, means the same WAD in a different
version. The wording for every outcome — required or not — comes from this module and nowhere else,
in two lengths that are written together: `missingWadLabel` names the file and the problem for the
save row, which has ~55 characters before it ellipsizes, and `missingWadText` says what to do about
it for the surfaces with a whole line — the load error and the row's tooltip. Both kinds are a
warning on the row, in two colours: the accent's red for a required file, amber for the rest, since
red is what says *this save can't be loaded* and using it for one that loads fine would read as a
refusal that isn't there. `asMeta` *blanks* a damaged entry instead of dropping it (`asWad`):
dropping one would shift every later file into the wrong role, where a blank fails loudly instead.

Loading resolves every entry before anything is torn down, so the running level survives a load
that can't happen — only a *required* missing file stops it (`blockingWad`); the rest are simply
left out of the assembled set. That refusal is the gate, not the greyed-out Load button the row
also grows: the button asks `blockingWad` the same question ahead of the click, and is a courtesy
in the same way the Save/Overwrite disabling is (docs/menu-saves.md § Save and Load tabs).

**`wadSetRefusal` is then the gate itself, and the only statement of it.** It takes plain facts
rather than a `Wad` — the save, `wadSetId`'s list for the set in hand, and a lookup naming that
set's provider for a map (a lookup, not one provider, because a replay's stand-in gate asks about
every level it visited — § A stand-in game WAD) — so the rule lives in the format module with the
field it reads, and returns the refusal message or null. `verifySaveWads` (`main.ts`, on the shared `startLevel` path — see
docs/session.md § Session lifecycle) throws what it returns; `Game.matchesSession`, the checkpoint's
fit test, compares it to null, so a checkpoint cannot refuse where a manual load would work. Both
feed it freshly re-hashed bytes (`wadSetId`, `mapProvider` in `wad/checksum.ts`) even though
resolution already matched IDs: a manifest ID is a build-time claim, and re-hashing what is
actually in hand is what catches a manifest left stale by a changed file.

## A stand-in game WAD

**`wads[0]` is required back only when it also supplied the map.** Where `mapWad` names an add-on,
nothing the snapshot indexes through — a sector index, a `posed` index, the fog's subsector index —
was read out of the game WAD at all: it supplied textures, flats, sprites, sounds and music.
Another game WAD may therefore stand in for it, and a replay recorded on `DOOM2.WAD` + `NUTS.WAD`
plays on `freedoom2.wad` + `NUTS.WAD`. `substitutableIwad(wads, mapWad)` is that condition; a blank
or unmatched `mapWad` is under the whole-set rule (`requiresWholeSet`) and so is never
substitutable.

**`requiredWads` does not read it.** Whether the game WAD is needed back turns on a stand-in having
actually been *found*, which takes the library — so `requiredWads` keeps saying `[0]` is required,
and `Menu.resolveSaveWads` is the one place that releases it, by writing `required: false` on the
entry that names the file which stood in.

**Which file may stand in is a question about maps, not IDs.** A DOOM II map needs a DOOM II asset
set, so `Menu.substituteIwad` takes an IWAD whose own maps follow the same scheme as the *saved map
name* — `mapNameStyle` (`wad/library/defs.ts`), the one spelling of `E<n>M<n>` vs. `MAP<nn>`, which
`mapStyle` also reads. Among those, **a file under the saved name wins**: the same IWAD in another
version is what the player still means by it, where anything else is a guess. A candidate needs no
content ID: nothing matches it by identity, which is the point. `wadSetRefusal` sees content hashes only and so accepts *any* file at
index 0 in this regime — the compatibility question is settled where the set was resolved, and
`Game.matchesSession` inherits the same answer, so a checkpoint cannot refuse where a manual load
would work.

**The stand-in is never silent.** `MissingWad.substitute` carries the file standing in, which makes
the row's line `Stand-in for DOOM2.WAD: freedoom2.wad` in amber (`required` is false — the load
proceeds). It is the one entry `missingWadText` adds no advice to: naming the file that stood in is
the whole of it, and there is nothing for the player to go and do. A stand-in under the file's *own*
name is left without a `substitute` at all — `resolveSaveWads` omits it, since that is the file in
another version and the existing `Other version: DOOM2.WAD` says so; naming a file as a stand-in for
itself would only puzzle. **The producer decides that, not the label**: `substitute` means one thing
wherever it is set. Where no candidate is found the entry keeps `required: true` and the plain
`Missing IWAD: …`: the load has nothing to run on.

**A record that walked out of the add-on's maps refuses the stand-in.** A replay can advance the
campaign into levels no add-on supplied — NUTS.WAD's MAP01, then DOOM2.WAD's own MAP02 — and there
the game WAD did provide a level that ran, so a stand-in would play *its* version of it.
`standInBlocker(maps, iwad, providerOf)` names the first such map, and is the **one statement** of
that rule: `wadSetRefusal` asks it with content IDs over the loaded set, `Menu.substituteIwad` with
library labels over `mergedMaps` (which attributes by label), so the row and the load cannot
disagree about which stand-in is safe.

**Two reasons block it, and they are not one sentence.** A map the assembled set provides *nowhere*
is blocked too — the record played it from somewhere, and that somewhere is gone — but that is a
different fact from the game WAD supplying it, and only the first is fixed by loading the game WAD
back. `StandInBlocker.fromIwad` carries which, so each says the true thing: `this recording plays
MAP02 from the game WAD it was made with` against `the loaded WADs have no map MAP99` (the same
sentence the single-map check below already uses), and in the row `— it provides MAP02; load it
from disk first` against `— no loaded WAD provides MAP99`. Collapsing the two sends the player
after a file that does not have the level.

The maps come from `SaveWadSet.maps`, which `replayWadSet` fills from the replay's level markers
(`ReplayMeta.levels`, already stored — no format change). A save has one map and leaves it out.
Where a candidate existed and a map stopped it, `MissingWad.blockedBy` carries the blocker so the
red line can say which: without it the same library plays one record and refuses another under one
identical sentence.

**What a stand-in can still cost is what spawns.** A thing whose sprite the merged set has no lumps for is not
spawned at all (docs/wad.md § Art a WAD set doesn't have), which shifts every later `posed` index
and changes the kill/item totals — so a stand-in short one sprite changes what the save means, not
only how it looks. That cannot be checked when the row is drawn: resolution is synchronous and must
download nothing, so all it knows about a candidate is its manifest entry. It surfaces at load
instead, where the lumps are in hand: `missingArtMessage` puts the count on screen beside the
console's list of doomednums.
