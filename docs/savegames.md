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
level time, health, `thumb` data URL, the menu source keys) + `state: GameSnapshot`. The payload is
plain JSON with three deliberate encodings, all owned by `game/snapshot.ts`:

- **`Infinity` → `-1`** (`encodeSeconds`/`decodeSeconds`): `JSON.stringify(Infinity)` silently
  yields `null`, and the berserk/computer-map powers genuinely hold `Infinity`.
- **Sets and Maps → arrays** (`keys`, `weapons`, `usedOnce` as plain arrays; `movers`,
  `lightStates`, `switchFlashes` as `[key, value][]` entries).
- **The fog bitmap → run lengths** (`encodeRuns`/`decodeRuns`): alternating run lengths starting
  with zeros, JSON-native numbers rather than base64 so Node tests need no `atob`.

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
timing, every sector's mutable fields (`floorHeight`/`ceilHeight`/`light`/`special`/`floorTex` —
`DoomMap` is mutated in place at runtime by specials and secrets), the specials controller (movers
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
  sequence fast-forwarded by `deadTime`, but a live monster restarts from its walk cycle.
- **`SpecialsController`'s one-frame flags** (`lastTeleport`, `lockedLine`) and the derived
  `moveSoundDue`/`crushDamageDue` booleans.
- **A pristine killable thing's AI block**: a monster still exactly in its spawn state saves 9
  fields, not ~40 (`isPristine` in `game/things.ts`); its `lookTimer` phase and `homingBias` coin
  flip are re-seeded on restore, both invisible before first contact. This is what keeps a
  10k-monster map's save inside the quota (§ Storage and the cap).
- **Saving is refused mid-intermission, mid-exit and while dead** (`Game.canSave`), which keeps
  the intermission/exit cascade out of the format entirely.

## Apply order

`loadMapByIndex(index, restore)` runs its normal construction and interleaves the restore at fixed
points. The order is load-bearing; the two rules are **geometry before anything that reads
heights** and **RNG cursors dead last**.

1. Normal preamble: `clearRandom`, `finishLevel`, `weaponSystem.beginLevel`, overlay clears,
   `loadMap`.
2. `new SectorEffects(map)` — *before* the sector snapshot, so `totalSecrets` counts the map's
   authored secrets (a consumed secret zeroes its sector's `special`).
3. `applySectors` writes the saved sector fields into the fresh `DoomMap` in place. Everything
   built after this step bakes restored geometry — no rebuild/recolor pass exists anywhere below.
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
13. Inventory deserialized, `weaponSystem.restore(...)`, `sectorEffects.restore(...)`,
    `levelTime`.
14. `levelCard.show(...)` as on any load.
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
normal map is a similar order of magnitude thanks to the pristine-thing and fog-RLE encodings
(measured: DOOM2 MAP15 is ~40 KB untouched, ~140 KB with every monster damaged). The known limit
is a slaughter map with most of its monsters *disturbed* — NUTS.WAD with all 10k wounded is ~6 MB,
past the quota on its own — where the write fails with the quota message rather than corrupting
anything.

## WAD-set identity

A save embeds `wadSetId(wad)` — every loaded file's `{ name, id }` content hash in load order
(docs/wad.md § Content id, designed for exactly this) — plus the menu's own source keys so the
files can be re-resolved from the library. Loading re-fetches the files by key, then verifies each
`wadId` against the saved list and refuses on the first mismatch, *naming the file*. A save made
against an uploaded WAD survives a reload of the page only after the same file is loaded from disk
again; the error says which file to bring back.
