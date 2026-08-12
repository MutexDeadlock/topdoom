# TopDoom

A top-down DOOM built on the original IWADs. The camera hangs above the player and is
tilted slightly off vertical, so walls show some of their height and levels read as
spaces rather than floor plans; it can also orbit around the player with `Q`/`E`. Level
geometry, textures and flats come straight out of `DOOM.WAD` / `DOOM2.WAD`; the game logic
is new.

## Running it

```bash
npm install
cp /path/to/DOOM.WAD public/wads/iwad/       # the game WADs
cp /path/to/SomeMod.wad public/wads/pwad/    # any add-ons you want on the menu
npm run dev                                  # http://localhost:5173
```

WADs are not part of the repo.

## Start menu

Everything under `public/wads/iwad/` and `public/wads/pwad/` shows up on the **New Game** tab
automatically:

- **Game WAD** — offered from `public/wads/iwad/`. Normally an IWAD, but a PWAD carrying maps
  works too if you put it there.
- **Add-ons** — offered from `public/wads/pwad/`, any number, merged in the order they were
  ticked. An add-on whose maps clash with the selected game WAD's naming scheme is disabled
  automatically; ones with no maps of their own (textures, sounds, ...) always stay selectable.
- **Level** — every map in the resulting set, grouped by episode for DOOM 1.
- **Difficulty** — the five vanilla skills; **Start new game** runs the level at the one picked.
  Skill decides which monsters are placed at all, and — as in the original — halves the damage you
  take on *I'm Too Young to Die*, doubles ammo pickups on that skill and on *Nightmare!*, and on
  *Nightmare!* runs the demons at double speed and brings every monster you kill back again.

Your game WAD, add-ons, level and difficulty are remembered for the next visit. Files outside `public/wads/` go through
*Load from disk* or by dropping them on the window.

`Esc` pauses and brings up the menu over the level; **Return to game** or `Esc` again resumes
where you left off. `?wad=DOOM2.WAD&pwad=SCYTHE.WAD&map=MAP05` preselects and skips the menu.

See [docs/menu.md](docs/menu.md) for the WAD manifest, settings persistence and URL parameters.

## Controls

The same list is in the menu's **Settings** tab, along with the two settings that change what a key
does (autorun and the right mouse button), so both are there while you play — `Esc` pauses.

| Key | |
|---|---|
| `W` `A` `S` `D` or the arrow keys | move (screen-relative: `W` always moves away from the camera) |
| `Shift` | run |
| `Space` | use — opens doors, throws switches, calls lifts |
| right mouse | switch to your previous weapon, use, or nothing — pick one in the menu's Settings tab (default: previous weapon) |
| mouse | aim; the view leads slightly towards the cursor |
| left mouse | fire (hold to keep firing) |
| `1`–`7` | select weapon; pressing a slot again toggles within it (fist/chainsaw, shotgun/super shotgun) |
| mouse wheel | cycle through the weapons you own |
| `Q` / `E` | orbit the camera around the player |
| `+` / `-` | camera distance |
| `[` / `]` | camera tilt |
| `N` / `P` | next / previous map *(dev mode only)* |
| `R` | restart the level (once dead) |
| `Esc` | menu / resume |

Ceilings are never rendered — from directly above, one would hide everything underneath it. See
[Dev mode](#dev-mode) below for the keys marked as needing it.

**Straferunning works.** Forward and sideways are separate speeds that are never blended into
one, exactly as in vanilla, so running forward and sideways at once (`W`+`D`+`Shift`) moves you
faster than either alone. See [docs/movement.md](docs/movement.md).

## Dev mode

Set `VITE_DEVMODE=true` in a `.env.local` file at the repo root (git-ignored, create it
yourself) and restart `npm run dev` to turn on the debug overlay and the hotkeys marked
*(dev mode only)* above. Without it those keys are simply inert.
See [docs/menu.md](docs/menu.md#dev-mode-devmode).

## Sound

Sound effects are decoded from the loaded WAD, so they match whichever set is in use — and an
add-on that replaces individual `DS*` lumps replaces those sounds, including modern Ogg/WAV/FLAC
ones. Shareware `DOOM1.WAD` only carries 49 of the 108 sounds, so parts of it are quiet.

Volume lives on the start menu and is remembered between sessions; drag it to 0 for silence. There
is no music yet. See [docs/audio.md](docs/audio.md).

## HUD

Walking within range of a health, armor, ammo, key, weapon, backpack or powerup pickup collects
it automatically — no key press needed. The bar along the bottom shows health, armor, all four
ammo counts, one slot per key color, and the weapon you currently have selected. That last one
matters here in a way it doesn't in the original: the player sprite looks the same whatever it's
holding, so the HUD icon is the only thing telling you what you're about to fire. See
[docs/items.md](docs/items.md) and [docs/hud.md](docs/hud.md).

## Powerups

All six spheres and the backpack work, on the original's own timers:

| Pickup | Effect |
| --- | --- |
| Invulnerability (30s) | Nothing can hurt you; the screen goes inverted, as in the original |
| Berserk (rest of the level) | Heals you to 100, switches to the fist and makes it hit ten times as hard |
| Partial invisibility (60s) | You're drawn semi-transparent and monsters shoot wide of you |
| Radiation suit (60s) | Nukage/slime floors stop hurting; the screen tints green |
| Computer area map (rest of the level) | Reveals the whole level's geometry at once (this game's fog of war *is* its automap) |
| Light amplification visor (120s) | Brightens the whole view |
| Backpack | Doubles every ammo cap and hands over a clip of each; kept across levels |

Powerups (but not the backpack) run out at the end of a level, exactly as in the original.

## Weapons

All nine weapons work. Picking one up selects it, as in the original; `1`–`7` pick a slot and
pressing the same slot again toggles between the two weapons that share it, and the mouse wheel
cycles through everything you own. Hold the left mouse button to fire at the weapon's own rate.

**Aiming is by mouse, and putting the cursor on a monster locks onto it.** The shot is then aimed
at that monster's actual position and height instead of at wherever the cursor's projection onto
the floor plane lands — so shooting an enemy up on a ledge angles the shot to reach it. It's the
pointer-driven equivalent of DOOM's own auto-aim, which had no cursor to work from. Real walls
and closed doors still stop a shot short and explode it there.

**Monsters wake, hunt, shoot back and fight each other**, walking the original's
eight-direction pathing and blocking both you and one another. Damage, gibbing, monster drops,
explosion splash and knockback all follow vanilla's own rules and tables — the one deliberate
exception is the damage numbers, tuned softer than the original's so the rhythm matches but the
bite doesn't.

See [docs/weapons.md](docs/weapons.md), [docs/combat.md](docs/combat.md) and
[docs/monster-ai.md](docs/monster-ai.md) for how any of it
actually works.

## Layout

[CLAUDE.md](CLAUDE.md) has the source tree and the project-wide conventions. For how any one
part actually works under the hood, `docs/` documents each subsystem in depth:

| Doc | Covers |
|---|---|
| [docs/wad.md](docs/wad.md) | WAD parsing, lump merging, PWAD overrides, the `public/wads/` manifest |
| [docs/menu.md](docs/menu.md) | The menu, settings persistence, URL parameters, session lifecycle, dev mode |
| [docs/render.md](docs/render.md) | BSP polygons, mesh building, sector lighting, occlusion fading, camera |
| [docs/sprites.md](docs/sprites.md) | Things drawn as sprites, and how thousands of them are batched |
| [docs/frameloop.md](docs/frameloop.md) | The frame delta, the FPS cap, pausing |
| [docs/movement.md](docs/movement.md) | Collision, wall sliding, straferunning, falling, knockback |
| [docs/weapons.md](docs/weapons.md) | Weapon selection, fire rates, spread, damage rolls |
| [docs/combat.md](docs/combat.md) | Shot resolution, auto-aim, blood and puffs, splash and the BFG |
| [docs/death.md](docs/death.md) | Monster and player death, telefrag, barrels, boss triggers |
| [docs/world.md](docs/world.md) | The shared `world.ts` queries: line of sight, neighbor heights |
| [docs/monster-ai.md](docs/monster-ai.md) | Waking, chase pathing, attacks, infighting, per-type quirks |
| [docs/monster-attacks.md](docs/monster-attacks.md) | Realizing a fired attack: hitscan, projectiles, the revenant's homing |
| [docs/monster-archvile.md](docs/monster-archvile.md) | The arch-vile: raising corpses, the blast attack |
| [docs/monster-iconofsin.md](docs/monster-iconofsin.md) | MAP30's boss: the spitter, the spawn cube, the brain's death |
| [docs/items.md](docs/items.md) | Pickups, inventory, keys, powerups |
| [docs/hud.md](docs/hud.md) | The HUD, level card, intermission, best times, screen effects |
| [docs/specials.md](docs/specials.md) | Doors, lifts, floors, crushers, teleporters, lights, damage floors |
| [docs/fogofwar.md](docs/fogofwar.md) | Subsector-based reveal and sight blocking |

## Checking a WAD without a browser

```bash
node scripts/inspect-wad.ts public/wads/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/wads/iwad/DOOM2.WAD MAP05 public/wads/pwad/SCYTHE.WAD
```

Reports lump and map counts, which file a map came from, any textures it references but the
WAD set lacks, how many subsector polygons came out degenerate, and whether the player start
is walkable.

## Running the tests

```bash
npm test
npm run typecheck
```

Both must be clean. The suite uses Node's built-in test runner — no extra dependencies, no
browser. See [docs/testing.md](docs/testing.md).

## State

Playable as a walkable level viewer you can fight in: geometry, textures, sector lighting,
collision and movement with vanilla's own wall-sliding, straferunning and falling, map switching,
PWAD loading, and an orbitable camera with wall-occlusion fading. Fog of war hides rooms and
secrets until the player has actually seen them. THINGS render as upright sprites, and the player
is drawn as the real `PLAY` sprite. Health, armor, ammo, keys, weapons, the backpack and all six
powerups are collectible and tracked on a HUD (see [Powerups](#powerups) above); doors, lifts,
floor movers, crushers, switches and teleporters all work, including locked doors. All nine
weapons fire, and every stock monster is in — including both DOOM II oddities, Commander Keen and
the Icon of Sin. Sound effects come out of the loaded WAD (see [Sound](#sound) above).

Not yet: music.
