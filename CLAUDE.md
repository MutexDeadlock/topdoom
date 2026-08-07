# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A top-down DOOM built on the original IWADs. The camera hangs above the player, tilted
slightly off vertical. Level geometry, textures and flats are parsed straight out of
`DOOM.WAD` / `DOOM2.WAD` (or any PWAD); the game logic (movement, collision, camera) is
entirely new — none of vanilla DOOM's game code is ported.

## Commands

```bash
npm install
npm run dev         # vite dev server, http://localhost:5173
npm run typecheck   # tsc --noEmit
npm run build       # tsc --noEmit && vite build
npm run preview     # serve the production build
```

There is no test suite (`npm test` is an unset placeholder). Validate changes with
`npm run typecheck` and, for anything touching WAD parsing/geometry/collision, the headless
inspector below.

WADs are not part of the repo. Place game WADs in `public/wads/iwad/` and add-ons in
`public/wads/pwad/` (both gitignored except `.gitkeep`) — see [docs/wad.md](docs/wad.md) for why
the folder matters.

### Headless WAD inspection

```bash
node scripts/inspect-wad.ts public/wads/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/wads/iwad/DOOM2.WAD MAP05 public/wads/pwad/SCYTHE.WAD
```

Runs directly via Node's native TS support (no flag needed on Node 22+) — no browser
required. Reports lump/map counts, which file a map's lumps came from, any textures the map
references but the WAD set lacks, how many subsector polygons came out degenerate, and
whether the player start is walkable. This is the fastest way to sanity-check a change to the
WAD parser, texture merging, or BSP reconstruction, and the way to reproduce a bug against a
specific real-world WAD without spinning up a browser.

For collision/movement logic bugs, prefer writing a small throwaway synthetic-map script (a
hand-built `DoomMap` with a couple of sectors) over probing a real map, where nearby unrelated
geometry makes results hard to interpret. Scratch scripts go in the scratchpad, never in `src/`.

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
- The pinned `tsc` has a control-flow narrowing quirk: reading a nullable `this`-field directly
  after several intervening method calls (any of which may reassign it) can stay typed as its
  last-seen literal instead of widening back to the declared union — surfaced by
  `SpecialsController.lastTeleport` in `game/specials.ts`. Routing the read through a trivial
  getter (`consumeLastTeleport`) works around it; reach for that pattern rather than fighting the
  checker if the same shape of bug shows up elsewhere.

## Architecture

```
src/wad/       WAD files, merged lump directory, map lumps, graphics + sprite + sound decoding
src/render/    BSP polygon reconstruction, mesh building, materials, occlusion fading,
               sprite billboards + their instanced batching, shot tracers, camera, viewport
src/game/      spatial queries, collision, player controller, input, thing→sprite table,
               thing/monster world state (AI, pickups, damage), fog of war, inventory/pickups,
               weapons and firing, shots in flight + splash, damage/death, projectile/effect
               tables, transient effects (fog puffs, explosions, tracers), mover obstruction,
               damage floors + secrets
src/audio/     vanilla's sound table, the emitter game systems raise sounds through,
               WebAudio playback (channels, attenuation, pan, volume)
src/ui/        start menu, HUD, screen tints/pain flash, DEVMODE hud + profiling overlay
src/util/      small helpers shared across layers (2D geometry, damped-lerp smoothing,
               per-frame profiling)
src/constants.ts   genuinely cross-cutting values only (VERSION, DEVMODE, BRIGHTNESS_LIFT)
src/types.ts       structural position types shared across layers (Pos2/Pos3/Placement)
plugins/       Vite plugin publishing the public/wads/{iwad,pwad} manifest
scripts/       headless WAD inspection (node scripts/inspect-wad.ts)
```

## Subsystem documentation

Each file below documents how one part actually works and, more importantly, which of its
non-obvious decisions are load-bearing. **Read the relevant one before changing that subsystem** —
several record rules that look like accidents and aren't.

| Doc | Covers |
|---|---|
| [docs/wad.md](docs/wad.md) | WAD parsing, lump merging, PWAD override rules, the `public/wads/` manifest |
| [docs/menu.md](docs/menu.md) | The menu as launcher and pause screen, difficulty prompt, persisted settings, URL parameters, `main.ts`'s session lifecycle |
| [docs/render.md](docs/render.md) | BSP polygons, mesh building, sector lighting, wall occlusion fading, camera orbit, sprites and their batching |
| [docs/movement.md](docs/movement.md) | Collision, `groundFloor`, `slideMove`, straferunning, gravity/falling, knockback |
| [docs/combat.md](docs/combat.md) | Weapons, `shotPath`, auto-aim, `hasLineOfSight`, splash, the BFG, monster/player death, barrels |
| [docs/monsters.md](docs/monsters.md) | Waking, chase pathing, attacks, infighting, per-type quirks, spatial indexing |
| [docs/items.md](docs/items.md) | Pickups, inventory, keys/locked doors, the HUD, powerups, screen effects |
| [docs/specials.md](docs/specials.md) | Doors, lifts, floors, crushers, teleporters, lights, the donut, damage floors, scrolling textures |
| [docs/fogofwar.md](docs/fogofwar.md) | Subsector-based reveal, sight blocking, how alpha reaches the geometry |
| [docs/audio.md](docs/audio.md) | Sound lumps, the vanilla mixer model, which sound every event plays, volume/mute |
| [docs/devmode.md](docs/devmode.md) | `DEVMODE` gating, debug hotkeys, the profiling overlay |

For what is and isn't implemented, see [README.md](README.md#state) and [CHANGELOG](CHANGELOG).

## Project-wide rules

These apply no matter which file you're in.

**Vanilla fidelity is confirmed, never guessed.** Where this engine reproduces a DOOM behavior, the
rule comes from the real `linuxdoom-1.10` source or from the actual WAD lumps — not from the Doom
wiki alone (which has been wrong here: linedef 174, crusher-stop 58, and the turbo stairs' "and
Crush" naming all needed the source to settle), and not from what seems reasonable. Several shipped
bugs came from eyeballing a table that could have been read off `info.c`. When you add or change one
of these, cite where it came from.

**Constants fall into exactly two marked categories.** Values derived from vanilla carry their
source citation as a comment at the declaration (`g_game.c`'s ticcmd tables, `info.c`'s mobjinfo
fields, `P_RadiusAttack`'s literal 128). Values tuned by feel say so explicitly — currently
`GRAVITY` and `ACCELERATION` (`player.ts`), `BRIGHTNESS_LIFT` (`constants.ts`), the weapon fire
rates and spread (`weapons.ts`), `MONSTER_FADE_RANGE` (`render/occlusion.ts`) and the pain-flash
alpha (`game.ts`). Never
introduce a third, unmarked category: a bare number with no note is indistinguishable from a
transcription error.

**`constants.ts` stays small.** A constant used in more than two files that isn't otherwise
identity-coupled to one module is the bar. `PLAYER_RADIUS`/`PLAYER_HEIGHT` and `NO_SIDE`/`LF`/
`SUBSECTOR_BIT` briefly lived there during a consolidation pass and were moved back to
`game/player.ts` and `wad/map.ts` once it was clear they belong with the code that owns their
meaning. Don't re-add constants there just because they're imported in two or three places.

**Position types (`src/types.ts`).** `Pos2` (`{x, y}`), `Pos3` (`+z`) and `Placement`
(`{x, y, angle}`) are **structural**, and always **DOOM map space** (x east, y north, z up = feet
height), never three.js space — `mapmesh.ts: doomToWorld` is the one place the two meet. Nothing
here is a direction or velocity: those stay separate `velX`/`velY`/`velZ` fields, and headings are
plain `angle` numbers. `Placement.angle` is **radians**, matching `Player.angle`/`MonsterBody.angle`
rather than the WAD's own degrees — naming this type is what surfaced a shipped double-conversion
bug in two consumers.

The rule for parameters: **take a `Pos2`/`Pos3` where callers already hold a point object, keep
scalars where they're computing coordinates inline.** `Player`, `PosedThing`, `MonsterBody` and the
WAD's `Thing` already carry `x`/`y`(/`z`), so passing them costs no conversion and no allocation.
But `util/geom.ts`'s primitives and `World`'s point queries (`linesNear`, `subsectorAt`, `sectorAt`,
`floorAt`, `groundFloor`, `circleBlocked`) deliberately stay on scalars — their callers compute
coordinates on the fly, so a point parameter there would force a fresh object per call in exactly
the code that runs thousands of times a frame.

**Hot paths are measured, not reasoned about.** `hasLineOfSight`, `circleBlocked`, the monster grids
and the sprite batches all carry non-obvious shapes that exist because the obvious version was
measured and was too slow — and at least one obvious-looking optimization (an allocation-free
`linesNear` for the collision callers) was measured and was *not* faster. Don't "simplify" these
without measuring; the relevant docs say which is which.

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

## Code comments

A rule that a subsystem doc covers is written **once**, in the doc. Two copies drift, and the code
copy is the one nobody re-reads. Comments fall into three tiers by what breaks if they're missing:

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
