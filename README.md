# TopDoom

A top-down DOOM built on the original IWADs. The camera hangs above the player and is
tilted slightly off vertical, so walls show some of their height and levels read as
spaces rather than floor plans; it can also orbit around the player with `Q`/`E`. Level
geometry, textures and flats come straight out of `DOOM.WAD` / `DOOM2.WAD`. The code is new —
no vanilla C is ported — but the behavior is vanilla's wherever a WAD can tell the difference:
monster stats, weapon rates, the specials, even the random table are reproduced from the original
source. Movement, collision and the camera are the deliberate exceptions, rebuilt for the view.

## Running it

```bash
npm install
cp /path/to/DOOM.WAD public/game/iwad/       # the game WADs
cp /path/to/SomeMod.wad public/game/pwad/    # any add-ons you want on the menu
npm run dev                                  # http://localhost:5173
```

WADs are not part of the repo. Copying them in is optional — the **WAD Library** on the start menu
can point at a folder of your own instead, without anything being moved or uploaded.

## Start menu

Everything under `public/game/iwad/` and `public/game/pwad/` shows up on the **New Game** tab
automatically:

- **Game WAD** — offered from `public/game/iwad/`. Normally an IWAD, but a PWAD carrying maps
  works too if you put it there.
- **Add-ons** — offered from `public/game/pwad/`, any number, merged in the order they were
  ticked. An add-on whose maps clash with the selected game WAD's naming scheme is disabled
  automatically; ones with no maps of their own (textures, sounds, ...) always stay selectable.
- **Level** — every map in the resulting set, grouped by episode for DOOM 1.
- **Difficulty** — the five vanilla skills; **Start new game** runs the level at the one picked.
  Skill decides which monsters are placed at all, and — as in the original — halves the damage you
  take on *I'm Too Young to Die*, doubles ammo pickups on that skill and on *Nightmare!*, and on
  *Nightmare!* runs the demons at double speed and brings every monster you kill back again.

**WAD Library** opens a browser over everything on offer: the folders above, plus one on your own
disk that you nominate once. It lists each file's size, map count and whether it carries a DEHACKED
patch, and ticking a row picks it straight into the lists above. Chrome and Edge remember the folder
between visits; Firefox and Safari have no way to, so it has to be picked again after a reload.
Dropping a WAD on the window still works for one-off files.

Your game WAD, add-ons, level and difficulty are remembered for the next visit.

`ESC` pauses and brings up the menu over the level; **Return to game** or `ESC` again resumes
where you left off. `?wad=DOOM2.WAD&pwad=SCYTHE.WAD&map=MAP05` preselects and skips the menu.

See [docs/menu.md](docs/menu.md) for the WAD manifest, settings persistence and URL parameters.

## Controls

The same list is in the menu's **Settings** tab, along with the two settings that change what a key
does (autorun and the right mouse button), so both are there while you play — `ESC` pauses.

| Key | |
|---|---|
| `W` `A` `S` `D` or the arrow keys | move |
| `Shift` | run |
| `Space` | use — opens doors, throws switches, calls lifts |
| right mouse | switch to your previous weapon, use, or nothing — pick one in the menu's Settings tab (default: previous weapon) |
| mouse | aim; the view leads slightly towards the cursor |
| left mouse | fire (hold to keep firing) |
| `1`–`7` | select weapon; pressing a slot again toggles within it (fist/chainsaw, shotgun/super shotgun) |
| mouse wheel | cycle through the weapons you own |
| `Q` / `E` | orbit the camera around the player |
| `+` / `-` | camera distance *(manual camera mode)* |
| `[` / `]` | camera tilt *(manual camera mode)* |
| `N` / `P` | next / previous map *(dev mode only)* |
| `R` | restart the level (once dead) |
| `ESC` | menu / resume |

Ceilings are never rendered — from directly above, one would hide everything underneath it. See
[Dev mode](#dev-mode) below for the keys marked as needing it.

**The camera frames itself.** By default it opens up in wide rooms, pulls in when you are shut in
and leans towards where you are heading; the distance and tilt keys above take over in manual mode.
See [docs/camera.md](docs/camera.md).

**The classic cheats work.** Type `IDDQD` (god mode), `IDKFA` (all weapons, ammo and keys) or
`IDCLIP` (walk through walls) while playing — no console, no key to press first. A cheated session
sets no best times, and its end-of-level screen says `You cheated` instead of showing how the level
went. See [docs/cheats.md](docs/cheats.md).

**Straferunning works.** Forward and sideways are separate speeds that are never blended into
one, exactly as in vanilla, so running forward and sideways at once (`W`+`D`+`Shift`) moves you
faster than either alone. See [docs/movement.md](docs/movement.md).

## Dev mode

Set `VITE_DEVMODE=true` in a `.env.local` file at the repo root (git-ignored, create it
yourself) and restart `npm run dev` to turn on the debug overlay and the hotkeys marked
*(dev mode only)* above. Without it those keys are simply inert.
See [docs/menu.md](docs/menu.md#dev-mode-devmode).

## Sound and music

Sound effects are decoded from the loaded WAD, so they match whichever set is in use — and an
add-on that replaces individual `DS*` lumps replaces those sounds, including modern Ogg/WAV/FLAC
ones. Shareware `DOOM1.WAD` only carries 49 of the 108 sounds, so parts of it are quiet.

Each level plays its own music, synthesized the way DOS DOOM did it: the `D_*` score is played on
an emulated OPL2/OPL3 FM chip using the WAD's own `GENMIDI` instrument bank, so nothing outside the
WAD is needed. MUS and MIDI lumps both play, and a music PWAD shipping Ogg/FLAC/MP3/WAV plays those
directly.

Both volumes live on the start menu and are remembered between sessions; drag one to 0 for silence.
See [docs/audio.md](docs/audio.md) and [docs/music.md](docs/music.md).

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
pressing the same slot again toggles between the two weapons that share it — coming back to a slot
later returns whichever of them you last used. The mouse wheel cycles through everything you own.
Hold the left mouse button to fire at the weapon's own rate.

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

[CLAUDE.md](CLAUDE.md) has the source tree, the project-wide conventions and the full index of
`docs/`, where every subsystem — WAD parsing, rendering, movement, combat, the monsters, specials,
saves — is documented in depth.

## Checking a WAD without a browser

```bash
node scripts/inspect-wad.ts public/game/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/game/iwad/DOOM2.WAD MAP05 public/game/pwad/SCYTHE.WAD
```

Reports lump and map counts, which file a map came from, whether this engine can run each file,
any textures a map references but the WAD set lacks, how many subsector polygons came out
degenerate, whether the player start is walkable, and two coverage reports — every linedef and
sector special the map uses, and every record of a `DEHACKED` patch it ships, each classified by
whether this engine understands it.

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
the Icon of Sin. Three of vanilla's cheat codes are typed in as they always were
(see [Controls](#controls) above). Sound effects and music both come out of the loaded WAD (see
[Sound and music](#sound-and-music) above).

**BOOM-format maps load and play** (experimental): extended BSP nodes, generalized linedefs and
sector types, the extended linedef numbers, six-slot keys and generalized locks, elevators,
silent and line-to-line teleporters, a WAD's own `ANIMATED` and `SWITCHES` tables, scrolling
surfaces, conveyors, friction, wind and pushers, voodoo dolls, deep water, transfer lighting,
translucent midtextures and custom colormaps. What is deliberately **not** in: MBF's sky transfer —
nothing draws sky in a top-down view. See [docs/specials.md](docs/specials.md) for the per-number
detail.

**UDMF maps load** (experimental): a `TEXTMAP` map parses into the same records a binary map
yields, with its BSP read from the `ZNODES` lump — there is no node builder, so a map saved
without nodes won't load. A map in the `doom` namespace plays in full, Boom specials included;
other namespaces (`zdoom` and friends) draw, collide and fight, but their ZDoom-style action
specials don't run — so the WAD is flagged red in the library while staying **pickable**, for
walking a map whose doors won't open. See [docs/wad.md](docs/wad.md#udmf).

**`DEHACKED`/BEX patches are read** from a WAD that ships one: level titles, par times, monster,
weapon and ammo stats, `Frame` records and repointed monster and weapon frames — applied by
re-deriving the engine's sprite lists and its fire rates from vanilla's frame table — and
`[SPRITES]` renames. **Action pointers (`Pointer`, `[CODEPTR]`) apply too**, including MBF's own:
a repointed chain fires the attack that pointer belongs to, at the timing its chain implies, and
`A_Scratch`, `A_PlaySound` and `A_Spawn` land as well. What a pointer can't reach here is named per
action rather than skipped as a class. A patch asking for something out of scope still loads and
plays; what was skipped is reported rather than dropped silently. See
[docs/dehacked.md](docs/dehacked.md).

## License

The engine is **GPL-2.0** — see [LICENSE](LICENSE). That is less a choice than a consequence: no
vanilla C is ported, but the data tables are transcribed from
[id Software's Doom source](https://github.com/id-Software/DOOM) — `states[]`/`sprnames[]` and the
`mobjinfo` state pointers ([src/game/dehacked/states.ts](src/game/dehacked/states.ts)), the monster
stats, the linedef and sector specials, `rndtable`, `S_music[]` — and a transcription is still a
derivative work. id relicensed that source under the GPL in 1999. Its per-file headers were never
rewritten and still name the older DOOM Source Code License; the repository's own `LICENSE.TXT` is
the GPL, and is what governs.

`three` (MIT) is the only dependency bundled into a build.

### What it does not cover

The GPL applies to this engine's own source. **Game content is not ours to license, and none of it
is covered:**

- **Your IWADs.** `DOOM.WAD` and `DOOM2.WAD` are id Software's commercial data. They are not in
  this repo and never will be — you supply them, as [Running it](#running-it) describes.
- **[Freedoom](https://freedoom.github.io/)**, which is what ships as playable content, is under
  its own BSD 3-clause terms: redistributable, but the copyright notice travels with it.
  `public/og.jpg`, the link-preview card, is a Freedoom screenshot and carries the same.
- **The shareware `DOOM1.WAD`**, where it is bundled, stays under id Software's shareware terms.
- **`assets/playerskins.wad`**, the weapon-matching player sprites, is the ZDoom community's
  *WeaponMatchingPlayerSkin* pack converted to WAD lumps — edits of id's own marine art by Mark
  Quinn, Xenaero, Grimm, Xim, Anthony Cole, CaptainToenail, TokeGameInfo and the Skulltag team,
  credited on the About screen. Same footing as the shareware data above.
