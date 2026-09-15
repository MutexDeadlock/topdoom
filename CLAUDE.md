# CLAUDE.md

## What this is

A top-down DOOM built on the original IWADs. The camera hangs above the player, tilted slightly
off vertical. Level geometry, textures and flats are parsed straight out of `DOOM.WAD` /
`DOOM2.WAD` (or any PWAD).

**No vanilla C is transliterated — but little of the behavior is invented.** Movement, collision
and the camera are this engine's own, because the view needs them to be; nearly everything else is
written fresh and matched to `linuxdoom-1.10` and Boom/MBF *by behavior* — the specials tables,
`mobjinfo` stats, weapon rates, `P_RadiusAttack`, the random table, `GENMIDI`.

## Commands

`npm test` (Node's own runner, no deps) and `npm run typecheck` are the two gates; both must be
clean. See [docs/testing.md](docs/testing.md) for what is covered and how to add a test.

### Headless WAD inspection

Game WADs go in `public/game/iwad/`, add-ons in `public/game/pwad/` — see [docs/wad.md](docs/wad.md)
for why the folder matters.

```bash
node scripts/inspect-wad.ts public/game/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/game/iwad/DOOM2.WAD MAP05 public/game/pwad/SCYTHE.WAD
```

Headless: lump/map counts and provenance, each file's support verdict, the map and node formats,
missing textures, degenerate subsector polygons, whether the player start is walkable, and the two
coverage reports — every linedef/sector special known/no-op/unknown (the Boom-compat acceptance
gate), every DEHACKED record applied/no-target/unsupported. Run it after any WAD-parsing,
texture-merging or BSP change.

For collision/movement bugs prefer synthetic geometry: `tests/fixtures/gridmap.ts` builds a real
`DoomMap` from ASCII art. A throwaway script for a one-off investigation goes in the scratchpad,
never in `src/`.

## Toolchain constraints

- Node's native TS stripping (used by `scripts/*.ts` and anything else run directly via `node`)
  does **not** support constructor parameter-property shorthand (`constructor(private x: T)`).
  Declare fields explicitly and assign them in the constructor body everywhere in `src/`: anything
  there may be imported by a script run this way.
- All relative imports need explicit `.ts` extensions (`allowImportingTsExtensions` + Node ESM
  resolution) — `from './wad/reader'` fails to resolve, `from './wad/reader.ts'` works.
- `tsconfig.json` has `noUnusedLocals`/`noUnusedParameters` on; `npm run typecheck` is the cheapest
  way to catch this before running anything.
- The pinned `tsc` has a control-flow narrowing quirk: a nullable `this`-field read after several
  intervening method calls (any of which may reassign it) can stay typed as its last-seen literal
  instead of the declared union. Route the read through a trivial getter
  (`SpecialsController.consumeLastTeleport` in `game/specials.ts`) rather than fighting it.

## Architecture

```
src/wad/       WAD files, merged lump directory, content IDs (checksum), map lumps (map), graphics
               + sprite + sound + music decoding, Boom's ANIMATED/SWITCHES/colormap lumps, GZDoom's
               dynamic-light definitions (gldefs), the text lumps' shared grammar (textlump),
               whether this engine can run a file (support), what a file holds unloaded (describe),
               the engine's own WAD (shipped) and writing one (write), the shipped player art and
               when it stands in (playerskin), the players' armour colours (playercolor), the menu's
               WAD library, and the campaign lumps — MAPINFO, level names, par times, the sky, the
               game mode, the level progression (campaign/)
src/render/    BSP polygon reconstruction (bsp, sectorprobe), the solids a map draws as void
               (solids), mesh building (mapmesh/), sector light + depth falloff (sectorlight),
               materials + texture animation, occlusion fading (occlusion/), the midtextures that
               hide what is past them from the fog's draw gate (midcover), Boom's scrolling
               surfaces (scroller), sprite billboards + batching (sprites/), drawable player skins
               (playerskin), the blob shadow (playershadow), wall contact shading (wallshadow), the
               sky tint (skytint), the void fog (voidfloor), bloom, GLDEFS dynamic lights (lights/),
               shot tracers, camera, viewport, the GPU's own frame time (gputimer)
src/game/      the loaded level (level), what a frame draws (presenter), spatial queries +
               collision, player controller, player slots (playerslot), input, where players start
               (playerstarts), the auto camera, what each skill level changes (skill), thing world
               state, monsters (AI, attacks, the
               arch-vile), fog of war, inventory/pickups, weapons and firing, shots in flight +
               splash, damage/death, transient effects (spritefx), voodoo dolls, DEHACKED/BEX
               patches (dehacked), netgame rules (rules), cheat codes (cheats), best times, savegames (the
               snapshot shape, the IndexedDB store), replays (the record, the recorder and playback
               behind the tic's input, their per-tic row codec, their own store), the network (net)
src/audio/     vanilla's sound table, the emitter game systems raise sounds through, WebAudio
               playback (channels, attenuation, pan, volume), the level's music
src/ui/        the page's own chrome (base styles + tokens, the loading and fatal-error screens);
               hud/ the in-game overlays (status bar, crosshair, level card, intermission, end
               card, death overlay, center message, the message feed, screen effects, the replay
               bar), menu/ the
               launcher and pause screen (WAD Library, Save/Load, Replays, settings), devmode/ the
               status text and debug hotkeys
src/util/      helpers shared across layers: 2D geometry plus the aim ray's box test (geom), the
               smoothing curves (damping: the damped-lerp approach and the Hermite ease), GLSL
               float literals (glsl), per-frame profiling, IndexedDB request plumbing (idb, shared
               by the save store and the WAD library), the one localStorage object every setting
               is a field of (storage), raw DEFLATE (inflate, for compressed nodes), union-find
               (unionfind, the islands' and the fog backstage's leaf partitions), the five
               approximated Math functions in software so a tic runs the same on every engine
               (fdlibm), vanilla's random table — the engine's only entropy source
src/constants.ts   cross-cutting values, feel dials and deployment defaults (the constants rule below)
src/types.ts       structural position types shared across layers (Pos2/Pos3/Placement)
src/styles.css     the stylesheet index.html links; @imports the .css beside each ui module
index.html         the page skeleton; @includes the .html beside each one
plugins/       Vite plugins: the public/game/{iwad,pwad} manifest and public/game/replay's
               (replay-manifest) over the shell both serve and emit through (manifest), the WAD
               built from assets/ (game-wad), index.html's @include expansion
assets/        the sources that WAD is built from: gldefs.txt, secret.ogg, playerskins.wad
scripts/       headless inspection of a WAD (inspect-wad.ts), of a savegame file
               (inspect-save.ts) and of a replay (inspect-replay.ts); building assets/
               playerskins.wad (build-playerskins.ts)
server/        the relay, its own package: Node (`npm run relay`) or a Cloudflare Worker (cloudflare/)
```

## Subsystem documentation

**Read the relevant one before changing that subsystem** — several rules there look like accidents
and aren't. A row naming a family links its lead doc, which names the siblings.

| Doc | Covers |
|---|---|
| [wad.md](docs/wad.md) | WAD parsing, lump merging, PWAD override rules, level names, the `public/game/` manifest |
| [dehacked.md](docs/dehacked.md) | DEHACKED/BEX patches: the record grammar, the index bridges, units, `Bits`, the unsupported corners |
| [menu.md](docs/menu.md) → docs/menu-wads.md, docs/menu-saves.md | Launcher and pause screen, panel sizing, settings and their storage, URL parameters; the WAD Library and what a set is; the Save/Load/Replays tabs |
| [session.md](docs/session.md) | `main.ts`: boot, what a level start tears down, the loading screen |
| [devmode.md](docs/devmode.md) | `DEVMODE`, the FPS counter, the profiling overlay and the GPU timer |
| [frameloop.md](docs/frameloop.md) | `game.ts`'s frame: the delta, the FPS cap, pausing |
| [render.md](docs/render.md) | Mesh building, mover meshes, closed holes, deep water, what a frame costs, view distance, texture animation |
| docs/render-bsp.md, -solids, -lighting, -occlusion | Subsector polygons and the leaf repairs; lids on crates and pillars; the `COLORMAP` ramp, wall shading, the sky tint; the fade that keeps the player visible through a wall |
| [camera.md](docs/camera.md) | Camera orbit and camera-relative movement, the camera as simulation state, aim lead, the auto camera and its framing |
| [lights.md](docs/lights.md) | GLDEFS dynamic lights: the grammar, what emits, the two lighting paths, the GZDoom deviations |
| [sprites.md](docs/sprites.md) | The named doomednums (`ThingType`) every type-keyed table keys through; billboards, instanced batching, which things spawn |
| [movement.md](docs/movement.md) | Collision, `groundFloor`, `slideMove`, straferunning, gravity/falling, knockback |
| [world.md](docs/world.md) | `world.ts`'s shared queries: `hasLineOfSight`, `groundReach`, the neighbor-height lookups |
| [random.md](docs/random.md) | `rndtable` and the two cursors, the triangular draw, what `clearRandom` does and doesn't promise |
| [weapons.md](docs/weapons.md) | Weapon selection, fire rates, spread, damage rolls |
| [combat.md](docs/combat.md) | `shotPath`, range, auto-aim, what a shot hits, blood/puffs, splash and the BFG |
| [death.md](docs/death.md) | Monster death, telefrag, player death, exploding barrels, boss-death triggers |
| docs/monster-ai.md, -attacks, -archvile, -iconofsin | Waking, chase pathing, infighting, spatial indexing; hitscan vs. projectile and the revenant's homing; the two monsters that break the `MONSTER_STATS` model |
| [items.md](docs/items.md) | Pickups, inventory, keys/locked doors, monster drops, powerups |
| [cheats.md](docs/cheats.md) | IDDQD, IDKFA, IDCLIP: typing one, what each does, saves and best times |
| [hud.md](docs/hud.md) | The HUD, level stats and timer, level card, intermission, best times, center messages, `WadFont`, screen effects |
| [styles.md](docs/styles.md) | Which `.html`/`.css` owns which element, the `index.html`/`styles.css` entries, the palette/stacking tokens |
| [savegames.md](docs/savegames.md) | The save format and its version, the snapshot apply order, the store, download/import, WAD-set identity |
| [replays.md](docs/replays.md) | Recording and playing back a run: the `TicInput` seam, the record, restore events, the store, the playback bar |
| [specials.md](docs/specials.md) → docs/specials-movers.md, -crushers, -teleporters, -lights, -forces, -transfers | Which number means what and who may trigger it, damage floors, secrets; then the movers, the crusher, teleporters, light patterns, scrollers/friction/pushers/dolls, Boom's deep water |
| [fogofwar.md](docs/fogofwar.md) | Subsector-based reveal, sight blocking, how alpha reaches the geometry |
| [multiplayer.md](docs/multiplayer.md) → docs/multiplayer-coop.md, -deathmatch, -net | Player slots, per-slot vs. level-global, slot addressing, player vs. session settings, a slot's tic; coop's netgame rules; deathmatch's starts, frags, item respawn, limits, friendly fire; the relay, lockstep, snapshots, the Multiplayer tab |
| [audio.md](docs/audio.md) | Sound lumps, the vanilla mixer model, which sound every event plays, volume/mute |
| [music.md](docs/music.md) | The OPL chip and `GENMIDI`, MUS/MIDI decoding, which track a level plays, music volume |
| [testing.md](docs/testing.md) | The runner, the ASCII-grid map fixture, the fixture WADs, the tree-wide guards |
| [conventions.md](docs/conventions.md) | File and directory naming, the `defs`/`tables` roles, source order, named arguments, comment shape, how to find the pending deviations |

For what is and isn't implemented, see [README.md](README.md#state) and [CHANGELOG](CHANGELOG).

## Project-wide rules

These apply no matter which file you're in.

**Vanilla fidelity is confirmed, never guessed.** Where this engine reproduces a DOOM behavior, the
rule comes from the real `linuxdoom-1.10` source or from the actual WAD lumps — not from what seems
reasonable, and not from the Doom wiki alone (which has been wrong here: linedef 174, crusher-stop
58, the turbo stairs' "and Crush" naming). When you add or change one of these, cite where it
came from.

**A change that would break existing saves must be flagged to the user first — every time.** When a
change would make the current reader misread a stored `GameSnapshot` — a renamed/re-encoded field, a
changed spawn default the sparse encodings elide against, a reordered `posed`/thing identity — say
so *before* implementing, and say what it would cost to avoid. **Avoiding the break is still the
goal**, and a compatible extension (an optional field whose absence means the old behavior, the
`teleportFogs` pattern) is the first thing to reach for: never break a format merely because saves
are cheap to break right now. Only where compatibility would cost a second read path is the
standing answer, **until v1.0**, to break instead and keep one format — the user decides that, per
change. `SAVE_VERSION` (`game/savegames.ts`) **stays 1** through such a break, kept for the first
change that orphans real players' saves, and the broken case gets no explaining machinery: a save
only a development build wrote just fails.

**A change to what a tic does bumps `COMPAT` (`game/replay/defs.ts`)** — the simulation epoch that
warns a replay recorded under older rules that it may desync. Nothing detects a missed bump, so ask
it of every change under `src/game/`: could an old recording run differently now? Say in the report
whether it raised the epoch and why. A release, rendering, the HUD, the menu and the camera never
do. docs/replays.md § Compatibility.

**A WAD's art never decides what a tic does.** A tic reads map geometry and the engine's own
tables; sprite lumps are drawn, never asked. Auto-aim's pick tested the billboard once, which made
the loaded game WAD's pixel widths a simulation input and desynced a replay played on a stand-in
IWAD — docs/combat.md § Auto-aim. The one deliberate exception is `pushThing` skipping a thing whose
sprite the set lacks (docs/wad.md § Art a WAD set doesn't have). Nothing detects a new one.

**A save or replay that can't be used says why, where the player is looking.** A greyed Load or
Play always carries the reason in red beside the row — `SaveListEntry.refusal` /
`ReplayListEntry.refusal`, the same sentence the read would have thrown. Greying alone is the bug:
a disabled button shows no tooltip. docs/menu-saves.md § Save and Load tabs.

**A deliberate deviation is fine; an undocumented one is not.** Where this engine knowingly departs
from vanilla, the departure says so at the declaration, names what it follows instead, and explains
why — `meleeReachesVertically` (`game/monsters/defs.ts`, follows ZDoom's `MF5_NOVERTICALMELEERANGE`
rather than vanilla's no-vertical-check melee), solid bodies having a real height by default rather
than vanilla's infinitely tall actors (`game/world.ts`, docs/movement.md § Collision),
`PLAYER_WEAPON_RANGE`, `CHANNELS` = 32, and a missing sound lump being silent rather than
`DSPISTOL`. The rule above bans *guessing* at vanilla, not choosing against it on purpose.

**Constants fall into exactly two marked categories.** Values derived from vanilla carry their
source citation at the declaration (`g_game.c`'s ticcmd tables, `info.c`'s mobjinfo fields,
`P_RadiusAttack`'s literal 128). Values tuned by feel say so at the declaration, in those words —
`grep -rn "tuned by feel" src/` is the list; no roster is kept here. Dig for the vanilla source
before declaring a number tuned: every `weapons.ts` rate, spread and damage has one
(docs/weapons.md § Fire rates). Never a third, unmarked category: a bare number with no note is
indistinguishable from a transcription error.

**`constants.ts` stays small**, and admits a constant on exactly one of three grounds: it is used in
more than two files and isn't identity-coupled to any one module (`DOOM_TIC`), or it is a **feel
dial** — a tuned-by-feel presentation number parked somewhere obvious so it stays easy to retune,
however few files read it (`BRIGHTNESS_LIFT`, `DEFAULT_PICKUP_SCALE`, `VIEW_DISTANCE`), or it is a
**deployment default** — decided by the deployment rather than the code, however few files read it
(`FIRST_RUN_WADS`, `DEFAULT_RELAY_URL`). A dial
brings its own scope with it when the two are retuned together and separating them would hide half
the decision — `PICKUP_SCALE`, the per-type factors and so the whitelist of what scales at all, is
the one such table here and stays the exception, not a licence for tables generally. Nothing else: a constant
identity-coupled to one module lives in that module (`PLAYER_RADIUS` in `game/player.ts`,
`SUBSECTOR_BIT` in `wad/map.ts`), however many files import it.

**Position types (`src/types.ts`).** `Pos2` (`{x, y}`), `Pos3` (`+z`) and `Placement`
(`{x, y, angle}`) are **structural**, and always **DOOM map space** (x east, y north, z up = feet
height), never three.js space — `mapmesh.ts`'s `doomToWorld`/`worldToDoom` is the one place the two
meet. Nothing here is a direction or velocity: those stay separate `velX`/`velY`/`velZ` fields, and
headings are plain `angle` numbers — `Placement.angle` in **radians**, like
`Player.angle`/`MonsterBody.angle` and unlike the WAD's own degrees. When a signature takes one
rather than staying on scalars is docs/conventions.md § Named arguments.

**Hot paths are measured, not reasoned about.** `hasLineOfSight`, `positionBlocked`, the monster
grids and the sprite batches carry non-obvious shapes because the obvious version measured slower.
Don't "simplify" these without measuring; the relevant docs say which is which.

**A new file's name, layout and comments follow docs/conventions.md.** Read it before adding a
file, and re-check the finished one against § Source order inside a file (public surface, subject,
private support, in that order), § Inline `if` and § Comment shape — the three it is not enough to
know about in the abstract. A file that doesn't conform is fixed when next touched, never in a
sweep; `.claude/hooks/conventions.mjs` is the list.

## Documentation maintenance

- After a task that changes behavior, architecture, controls or anything else these docs describe,
  update the affected doc — don't wait to be asked.
- **Detail goes in `docs/`, not here.** CLAUDE.md is a router plus the project-wide rules above,
  loaded into context on every single turn; keep it under 20 kb. Anything specific to one subsystem
  belongs in that subsystem's doc.
- **Record the rule, not the story.** What prevents a regression is the invariant plus a clause on
  what breaks without it, and a concrete repro case (a map and sector number) where one exists. The
  narrative of how a bug was found, and benchmark digits behind a settled decision, belong in the
  commit message.
- **README.md** holds the overview, setup steps and how to play. Keep implementation detail out of
  it — link to `docs/` instead.
- **`docs/` is flat, and a family shares a name prefix** (`specials-movers`, `menu-wads`, …) rather
  than living in a subdirectory: a flat prefix keeps every pointer one path segment, which
  `tests/docs/references.test.ts` and the thousand pointers in `src/` are written against. A bare
  `§` points inside its own doc, and that test checks it too.

## Code comments

**Every `src/` file opens with a short header comment** ending in a pointer to its subsystem
doc(s) — the router into `docs/` at the point of reading. Beyond the header, comments are minimal:
a rule a subsystem doc covers is written **once**, in the doc, and the code names it and points at
`docs/x.md § heading`. The three tiers, the header's shape and the rest of what a comment may say
are docs/conventions.md § Comment shape.
