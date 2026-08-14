# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A top-down DOOM built on the original IWADs. The camera hangs above the player, tilted
slightly off vertical. Level geometry, textures and flats are parsed straight out of
`DOOM.WAD` / `DOOM2.WAD` (or any PWAD); the game logic (movement, collision, camera) is
entirely new — none of vanilla DOOM's game code is ported.

## Commands

`npm test` (Node's own runner, no deps) and `npm run typecheck` are the two gates; both must be
clean. For anything touching WAD parsing/geometry/collision, also use the headless inspector below.
See [docs/testing.md](docs/testing.md) for what is covered, the ASCII-grid map fixture, and how to
add a test.

`DOOM.WAD` and `DOOM2.WAD` are gitignored; every other WAD under `public/wads/` is committed. Place
game WADs in `public/wads/iwad/` and add-ons in `public/wads/pwad/` — see
[docs/wad.md](docs/wad.md) for why the folder matters.

### Headless WAD inspection

```bash
node scripts/inspect-wad.ts public/wads/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/wads/iwad/DOOM2.WAD MAP05 public/wads/pwad/SCYTHE.WAD
```

Runs under Node's native TS support, no browser. It reports lump/map counts, lump provenance,
missing textures, degenerate subsector polygons and whether the player start is walkable — the
fastest check on a WAD-parsing, texture-merging or BSP change, and the way to reproduce a bug
against a specific real-world WAD.

For collision/movement bugs prefer synthetic geometry, where unrelated nearby geometry can't muddy
the result: `tests/fixtures/gridmap.ts` builds a real `DoomMap` from ASCII art. A throwaway script
is still right for a one-off investigation — those go in the scratchpad, never in `src/`.

## Toolchain constraints

- Node's native TS stripping (used by both `scripts/inspect-wad.ts` and any dev tooling
  invoked directly via `node`) does **not** support constructor parameter-property shorthand
  (`constructor(private x: T)`). Declare fields explicitly and assign in the constructor body
  everywhere in `src/`, since anything there may be imported by a script run this way.
- All relative imports need explicit `.ts` extensions (`allowImportingTsExtensions` +
  Node ESM resolution) — `from './wad/reader'` will fail to resolve, `from './wad/reader.ts'`
  works.
- `tsconfig.json` has `noUnusedLocals`/`noUnusedParameters` on; `npm run typecheck` is the
  cheapest way to catch this before running anything.
- The pinned `tsc` has a control-flow narrowing quirk: a nullable `this`-field read after several
  intervening method calls (any of which may reassign it) can stay typed as its last-seen literal
  instead of the declared union. Route the read through a trivial getter
  (`SpecialsController.consumeLastTeleport` in `game/specials.ts` is the precedent) rather than
  fighting the checker.

## Architecture

```
src/wad/       WAD files, merged lump directory, content ids, map lumps, graphics + sprite + sound
               decoding, MAPINFO + the vanilla level-title tables
src/render/    BSP polygon reconstruction, mesh building, materials, occlusion fading,
               sprite billboards + their instanced batching, shot tracers, camera, viewport
src/game/      spatial queries + collision, player controller, input, the named doomednums every
               type-keyed table keys through (thingtypes), thing world state, fog of war,
               inventory/pickups, weapons and firing, shots in flight + splash, damage/death,
               transient effects, mover obstruction + crush damage, damage floors + secrets,
               best times, the Icon of Sin's cube spitter, savegames
src/game/monsters/   tables + record shapes (defs), chase/attack decisions (ai), attack resolution
               (attacks), the arch-vile (vile)
src/game/things/     the thing layer's record shapes + its own tables (defs), monster/corpse
               spatial index (grid)
src/game/specials/   load-time map analysis (mapscan), mover meshes + relighting (movergeometry)
src/audio/     vanilla's sound table, the emitter game systems raise sounds through,
               WebAudio playback (channels, attenuation, pan, volume)
src/ui/        the page's own chrome (base styles + tokens, the fatal-error screen)
src/ui/hud/          everything over the running level: HUD, level card, intermission, center
               messages, screen tints/pain flash, crosshair, WadFont glyph rasterizing
src/ui/menu/         start menu + changelog popup
src/ui/devmode/      DEVMODE hud + profiling overlay
src/util/      small helpers shared across layers: 2D geometry, damped-lerp smoothing, per-frame
               profiling, vanilla's random table — the engine's only entropy source
src/constants.ts   cross-cutting values and the feel dials (VERSION, DEVMODE, DOOM_TIC,
                   BRIGHTNESS_LIFT, PICKUP_SCALE + PICKUP_SCALE_TYPES, VIEW_DISTANCE)
src/types.ts       structural position types shared across layers (Pos2/Pos3/Placement)
src/styles.css     the stylesheet index.html links; @imports the .css beside each ui module
plugins/       Vite plugin publishing the public/wads/{iwad,pwad} manifest
scripts/       headless WAD inspection (node scripts/inspect-wad.ts)
```

## Subsystem documentation

Each file below documents how one part actually works and, more importantly, which of its
non-obvious decisions are load-bearing. **Read the relevant one before changing that subsystem** —
several record rules that look like accidents and aren't.

| Doc | Covers |
|---|---|
| [docs/wad.md](docs/wad.md) | WAD parsing, lump merging, PWAD override rules, level names, the `public/wads/` manifest |
| [docs/menu.md](docs/menu.md) | The menu as launcher and pause screen, difficulty, persisted settings, URL parameters, `main.ts`'s session lifecycle, `DEVMODE` and the profiler |
| [docs/frameloop.md](docs/frameloop.md) | `game.ts`'s frame: the delta, the FPS cap, pausing |
| [docs/render.md](docs/render.md) | BSP polygons, mesh building, sector lighting, wall occlusion fading, camera orbit, view distance, texture animation |
| [docs/sprites.md](docs/sprites.md) | The named doomednums (`ThingType`) every type-keyed table keys through; things as sprites: billboards, instanced batching, which things spawn, monster poses |
| [docs/movement.md](docs/movement.md) | Collision, `groundFloor`, `slideMove`, straferunning, gravity/falling, knockback |
| [docs/world.md](docs/world.md) | `world.ts`'s shared queries: `hasLineOfSight`, the neighbor-height lookups |
| [docs/random.md](docs/random.md) | `rndtable` and the two cursors, the triangular draw, what `clearRandom` does and doesn't guarantee |
| [docs/weapons.md](docs/weapons.md) | Weapon selection, fire rates, spread, damage rolls |
| [docs/combat.md](docs/combat.md) | `shotPath`, range, auto-aim, what a shot hits, blood/puffs, splash and the BFG |
| [docs/death.md](docs/death.md) | Monster death, telefrag, player death, exploding barrels, boss-death triggers |
| [docs/monster-ai.md](docs/monster-ai.md) | Waking, chase pathing, the decision to attack, infighting, per-type quirks, spatial indexing |
| [docs/monster-attacks.md](docs/monster-attacks.md) | Realizing a fired attack: hitscan vs. projectile, monster missiles in flight, the revenant's homing |
| [docs/monster-archvile.md](docs/monster-archvile.md) | The one monster that breaks the `MONSTER_STATS` model: raising corpses, the blast attack |
| [docs/monster-iconofsin.md](docs/monster-iconofsin.md) | MAP30's boss: the spitter, the spawn cube, the brain's death |
| [docs/items.md](docs/items.md) | Pickups, inventory, keys/locked doors, monster drops, powerups |
| [docs/hud.md](docs/hud.md) | The HUD, level stats and timer, level card, intermission, best times, center messages, `WadFont`, screen effects |
| [docs/styles.md](docs/styles.md) | Which stylesheet owns what, the `styles.css` entry, the palette/stacking tokens |
| [docs/savegames.md](docs/savegames.md) | The save format and its version, the snapshot apply order, the IndexedDB store, download/import, WAD-set identity |
| [docs/specials.md](docs/specials.md) | Doors, lifts, floors, crushers, teleporters, lights, the donut, damage floors, secrets |
| [docs/fogofwar.md](docs/fogofwar.md) | Subsector-based reveal, sight blocking, how alpha reaches the geometry |
| [docs/audio.md](docs/audio.md) | Sound lumps, the vanilla mixer model, which sound every event plays, volume/mute |
| [docs/testing.md](docs/testing.md) | The test suite: runner, the ASCII-grid map fixture, which WADs are committed, the doc-pointer guard |

For what is and isn't implemented, see [README.md](README.md#state) and [CHANGELOG](CHANGELOG).

## Project-wide rules

These apply no matter which file you're in.

**Vanilla fidelity is confirmed, never guessed.** Where this engine reproduces a DOOM behavior, the
rule comes from the real `linuxdoom-1.10` source or from the actual WAD lumps — not from the Doom
wiki alone (which has been wrong here: linedef 174, crusher-stop 58, and the turbo stairs' "and
Crush" naming all needed the source to settle), and not from what seems reasonable. When you add or
change one of these, cite where it came from.

**A change that would break existing saves must be flagged to the user first.** `SAVE_VERSION`
(`game/savegames.ts`) is meant to stay at its current value: released saves exist, and a bump
orphans them all. When a change would make the current reader misread a stored `GameSnapshot` — a
renamed/re-encoded field, a changed spawn default the sparse encodings elide against, a reordered
`posed`/thing identity — say so explicitly *before* implementing, and prefer a compatible extension
(an optional field whose absence means the old behavior, the `teleportFogs` pattern —
docs/savegames.md § The format and its version) whenever one exists.

**A deliberate deviation is fine; an undocumented one is not.** Where this engine knowingly departs
from vanilla, the departure says so at the declaration, names what it follows instead, and explains
why — `meleeReachesVertically` (`game/monsters/defs.ts`, follows ZDoom's `MF5_NOVERTICALMELEERANGE`
rather than vanilla's no-vertical-check melee), solid bodies having a real height by default rather
than vanilla's infinitely tall actors (`game/world.ts`, docs/movement.md § Collision),
`PLAYER_WEAPON_RANGE`, `CHANNELS` = 32, and a missing sound lump being silent rather than
`DSPISTOL`. The rule above bans *guessing* at vanilla, not choosing against it on purpose.

**Constants fall into exactly two marked categories.** Values derived from vanilla carry their
source citation as a comment at the declaration (`g_game.c`'s ticcmd tables, `info.c`'s mobjinfo
fields, `P_RadiusAttack`'s literal 128). Values tuned by feel say so explicitly, in those words at
the declaration — `grep -rn "tuned by feel" src/` is the current list; no roster is kept here.
Prefer digging out the exact vanilla source over declaring a number tuned: every `weapons.ts` rate,
spread and damage turned out to have one (docs/weapons.md § Fire rates). Never introduce a third,
unmarked category: a bare number with no note is indistinguishable from a transcription error.

**`constants.ts` stays small**, and admits a constant on exactly one of two grounds. Either it is
used in more than two files and isn't identity-coupled to any one module (`DOOM_TIC`), or it is a
**feel dial** — a tuned-by-feel presentation number parked somewhere obvious so it stays easy to
retune, however few files read it (`BRIGHTNESS_LIFT`, `PICKUP_SCALE`, `VIEW_DISTANCE`, each read by
one or two). A dial brings its own scope with it when the two are retuned together and separating
them would hide half the decision — `PICKUP_SCALE_TYPES`, the whitelist of what `PICKUP_SCALE`
applies to, is the one such table here and stays the exception, not a licence for tables generally.
Nothing else: a constant identity-coupled to one module lives in that module
(`PLAYER_RADIUS` in `game/player.ts`, `SUBSECTOR_BIT` in `wad/map.ts`), however many files import it.

**Position types (`src/types.ts`).** `Pos2` (`{x, y}`), `Pos3` (`+z`) and `Placement`
(`{x, y, angle}`) are **structural**, and always **DOOM map space** (x east, y north, z up = feet
height), never three.js space — `mapmesh.ts: doomToWorld` is the one place the two meet. Nothing
here is a direction or velocity: those stay separate `velX`/`velY`/`velZ` fields, and headings are
plain `angle` numbers. `Placement.angle` is **radians**, matching `Player.angle`/`MonsterBody.angle`
rather than the WAD's own degrees.

The rule for parameters: **take a `Pos2`/`Pos3` where callers already hold a point object, keep
scalars where they're computing coordinates inline.** `Player`, `PosedThing`, `MonsterBody` and the
WAD's `Thing` already carry `x`/`y`(/`z`), so passing them costs no conversion and no allocation.
But `util/geom.ts`'s primitives and `World`'s point queries (`linesNear`, `subsectorAt`, `sectorAt`,
`floorAt`, `groundFloor`, `positionBlocked`) deliberately stay on scalars — their callers compute
coordinates on the fly, so a point parameter there would force a fresh object per call in exactly
the code that runs thousands of times a frame.

**Hot paths are measured, not reasoned about.** `hasLineOfSight`, `positionBlocked`, the monster grids
and the sprite batches all carry non-obvious shapes because the obvious version measured too slow —
and at least one obvious-looking optimization (an allocation-free `linesNear`) measured *slower*.
Don't "simplify" these without measuring; the relevant docs say which is which.

## Documentation maintenance

- After finishing a task that changes behavior, architecture, controls, or anything else these docs
  describe, update the affected doc — don't wait to be asked separately.
- **Detail goes in `docs/`, not here.** CLAUDE.md is a router plus the project-wide rules above, and
  is loaded into context on every single turn; keep it under ~200 lines. If what you want to add is
  specific to one subsystem, it belongs in that subsystem's doc.
- **Record the rule, not the story.** What prevents a regression is the invariant plus a clause on
  what breaks without it — and a concrete repro case (a map and sector number) where one exists. The
  full narrative of how a bug was found, and benchmark digits behind a decision already made, belong
  in the commit message.
- **README.md** should only contain a project overview, setup steps, and instructions for starting
  and playing the game. Don't let it accumulate implementation detail — link to `docs/` instead.
- **`docs/` is flat, and a group of related docs shares a name prefix** (`monster-ai`,
  `monster-attacks`, …) rather than living in a subdirectory: half these docs are cited from two or
  more subsystems, and a flat prefix keeps every pointer one path segment — the shape
  `tests/docs/references.test.ts` and the hundreds of pointers in `src/` are written against.

## Code comments

**Every `src/` file opens with a short header comment** — one to three sentences on what the file
owns and where it sits, ending in a pointer to its subsystem doc(s). It is the router into `docs/`
at the point of reading; keep it to purpose, not a table of contents.

Beyond the header, comments are minimal. A rule that a subsystem doc covers is written **once**, in
the doc. Two copies drift, and the code copy is the one nobody re-reads. Comments fall into three
tiers by what breaks if they're missing:

1. **Doc-owned** — any invariant a `docs/` file covers: vanilla fidelity, why an algorithm has the
   shape it does, bug history. The comment states what the thing returns or does in a sentence or
   two, names the rule, and points at `docs/x.md § heading` for the argument. It does not reproduce
   the argument, paste vanilla C, or retell how the bug was found.
2. **Site-local** — hazards about *this code's shape* that no subsystem doc is the right home for:
   the `world.ts`/`player.ts` import-cycle workaround, the `tsc` narrowing quirk, a deliberate
   allocation. These stay inline and stay short — there is nowhere else for them to live.
3. **Citations** — the `info.c`/`g_game.c` source note or the "tuned by feel" note the constants
   rule already requires. Unchanged.

When a doc-owned comment holds something the doc lacks, move it into the doc rather than keeping it
in both places.
