# TopDoom

A top-down DOOM built on the original IWADs. The camera hangs above the player and is tilted
slightly off vertical, so walls show some of their height and levels read as spaces rather than
floor plans. Level geometry, textures and flats come straight out of the loaded WAD — `DOOM.WAD`,
`DOOM2.WAD`, Freedoom or any PWAD. The code is new — no vanilla C is ported — but the behavior is
vanilla's wherever a WAD can tell the difference: monster stats, weapon rates, the specials, even
the random table are reproduced from the original source. Movement, collision and the camera are
the deliberate exceptions, rebuilt for the view.

## Hop right in

I provide an current, running build right here:
https://topdoom.vercel.app

## Running it on our machine

After cloning this repo:

```bash
npm install

# optional: copy your favorite WADs
cp /path/to/DOOM.WAD public/game/iwad/
cp /path/to/SomeMod.wad public/game/pwad/

# run development server (http://localhost:5173)
npm run dev
# ... or make a build, which lands in dist/
npm run build
```

**Freedoom** and the shareware `DOOM1.WAD` ship with the repo, so it plays as soon as it starts.
The copies above are one of three ways to add your own: the **WAD Library** on the start menu reads
a folder anywhere on your disk, and a WAD dropped on the window plays straight away. Nothing is
moved or uploaded either way.

## Start menu

The **New Game** tab is what a run is made of:

- **Game WAD** — the files under `public/game/iwad/`. Normally an IWAD, but a PWAD carrying maps
  works too if you put it there.
- **Add-ons** — the ones you have picked, any number, merged in the order you picked them. An
  add-on whose maps clash with the selected game WAD's naming scheme is greyed out rather than
  dropped, so switching game WAD and back leaves your set intact; ones with no maps of their own
  (textures, sounds, ...) always fit. The checkbox switches one off for a run without losing its
  place in the order.
- **Level** — every map in the resulting set, grouped by episode for DOOM 1.
- **Difficulty** — the five vanilla skills, changing everything they change in the original: which
  monsters are placed at all, the damage and ammo multipliers at either end, and *Nightmare!*'s
  fast, respawning demons.

**WAD Library** is where those come from: a browser over `public/game/iwad/`, `public/game/pwad/`,
a folder on your own disk that you nominate once, and anything dropped on the window. Each row says
what the file is — size, how many maps, whether it ships a DEHACKED patch or a text file to read,
and whether this engine can run it — and ticking one picks it into the lists above. Chrome and
Edge remember your folder between visits; Firefox and Safari have no way to, so it has to be
picked again after a reload.

Your game WAD, add-ons, level and difficulty are remembered for the next visit.

`ESC` pauses and brings up the menu over the level; **Return to game** or `ESC` again resumes
where you left off. `?wad=DOOM2.WAD&pwad=SCYTHE.WAD&map=MAP05` preselects and skips the menu.

See [docs/menu-wads.md](docs/menu-wads.md) for the WAD manifest and [docs/menu.md](docs/menu.md) for
settings persistence and URL parameters.

## Controls

The same list is in the menu's **Settings** tab, along with the two settings that change what a key
does (autorun and the right mouse button), so both are there while you play — `ESC` pauses.

| Key | |
|---|---|
| `W` `A` `S` `D` or the arrow keys | move; the arrows skip a replay five seconds while one plays |
| `Shift` | run |
| `Space` | use — opens doors, throws switches, calls lifts; pauses a replay while one plays (a click on the level does too) |
| right mouse | switch to your previous weapon, use, or nothing — pick one in the menu's Settings tab (default: previous weapon) |
| mouse | aim; the view leads slightly towards the cursor |
| left mouse | fire (hold to keep firing) |
| `1`–`7` | select weapon; pressing a slot again toggles within it (fist/chainsaw, shotgun/super shotgun) |
| mouse wheel | cycle through the weapons you own |
| `Q` / `E` | orbit the camera around the player |
| `+` / `-` | camera distance *(manual camera mode)* |
| `[` / `]` | camera tilt *(manual camera mode)* |
| `R` | reload the level from your save, or from the checkpoint it wrote on the way in (once dead) |
| `F2` / `F3` / `F4` | menu on Save / Load / Settings |
| `ESC` | menu / resume |

Ceilings are never rendered — from directly above, one would hide everything underneath it.

**The camera frames itself.** By default it opens up in wide rooms, pulls in when you are shut in
and leans towards where you are heading; the distance and tilt keys above take over in manual mode.
See [docs/camera.md](docs/camera.md).

**The classic cheats work.** Type `IDDQD` (god mode), `IDKFA` (all weapons, ammo and keys),
`IDCLIP` (walk through walls) or `IDCLEV12` (warp to `MAP12`, or `E1M2` outside DOOM II) while
playing — no console, no key to press first. A cheated session
sets no best times, and its end-of-level screen says `You cheated` instead of showing how the level
went. See [docs/cheats.md](docs/cheats.md).


## Gameplay

It plays like DOOM because the rules are DOOM's: monster stats, weapon rates, damage rolls, powerup
timers and the random table all come out of the original source. All nine weapons are in, on the
number keys or the mouse wheel. Every stock monster is in — DOOM II's Commander Keen and Icon of
Sin included — and they wake, hunt, shoot back and fight each other on vanilla's own eight-direction
pathing. Health, armor, ammo, keys, weapons, the backpack and all six powerups are collected by
walking into them, and the bar along the bottom tracks what you are carrying.

**Aiming is by mouse, and putting the cursor on a monster locks onto it.** The shot is then aimed
at that monster's actual position and height instead of at wherever the cursor's projection onto
the floor plane lands — so shooting an enemy up on a ledge angles the shot to reach it. It's the
pointer-driven equivalent of DOOM's own auto-aim, which had no cursor to work from. Real walls
and closed doors still stop a shot short and explode it there.

**The player sprite shows the weapon you are holding** — the art shipped with the engine is the
ZDoom community's weapon-matching marine — so what you have out reads off the level and not only
off the bar. A WAD that draws the player its own way is left alone, and the skins have an off
switch under Settings -> Visuals.

See [docs/items.md](docs/items.md), [docs/weapons.md](docs/weapons.md),
[docs/combat.md](docs/combat.md), [docs/monster-ai.md](docs/monster-ai.md) and
[docs/hud.md](docs/hud.md).

## Saves and best times

`F2` and `F3` open the menu on **Save** and **Load** (`F4` on Settings); both tabs are also on the
pause menu. A save carries a thumbnail, the level and the time on the clock, keeps the WAD set it
was made with, and downloads as a `.topdoomsave.json` file you can drop back on the window. A row
whose WADs the library can no longer supply says so in red rather than failing on the click.

Entering a level also writes a checkpoint of its own, so `R` after a death costs you the level and
not the run — unless you saved in that level, which `R` prefers. Finishing a level records its
**best time**, shown on the end-of-level screen and beaten in green; a cheated run and a replay
both set none. See [docs/savegames.md](docs/savegames.md) and [docs/hud.md](docs/hud.md).

## Replays

The **Replays** tab records a run and plays it back. Flip the New Game tab's **Replay** toggle to
*● Recording* to record from the start, or press *Record from here* on the pause menu's Replays tab
to record from where you are; *Stop and save recording* keeps the run, *Cancel recording* (held
down) throws it away and plays on. A stored replay carries a name, a player and a description you
can edit, and downloads as a `.topdoomreplay.json` file you can share and import back. Replays
copied into `public/game/replay/` are offered on that tab too, marked *included*: they play and
download like any other, but can't be renamed or deleted.

Playing one shows a bar along the bottom: hover it for pause, playback speed, the crosshair and
camera toggles, and *Take over*, which hands the level back to you right there and saves the game as
it does. Click or drag the track to jump anywhere in the run; `Space` or a click on the level pauses
and resumes, and the arrow keys skip five seconds either way. Switching the camera to *manual* lets
you orbit and zoom around the recorded run with the usual keys without changing what the run itself
does. A replay never sets a best time.

**A replay plays back the same in any browser**: the simulation computes its own trigonometry
instead of asking the JavaScript engine, which is free to round it differently. What can still
differ is the build — a run recorded under older game rules is flagged as such, and the bar reports
where one actually diverged. See [docs/replays.md](docs/replays.md).

## Sound and music

Sound comes out of the loaded WAD, so it matches whichever set is in use — an add-on replacing
individual sounds replaces those, modern Ogg/WAV/FLAC ones included. Shareware `DOOM1.WAD` only
carries 49 of the 108 sounds, so parts of it are quiet.

Each level plays its own music, and **the OPL2/OPL3 chip is emulated** to play it: the score is
synthesized from the WAD's own instrument bank the way a DOS Sound Blaster did it, so nothing
outside the WAD is needed. A music PWAD shipping Ogg/FLAC/MP3/WAV plays that directly instead.

Both volumes live on the start menu and are remembered between sessions.
See [docs/audio.md](docs/audio.md) and [docs/music.md](docs/music.md).

## State

A level is walkable, fightable and finishable, start to end of the campaign:

- **Levels** — geometry, textures, flats, sector lighting, animated textures and switches, off the
  WAD's own nodes. Map switching and PWAD merging work; fog of war hides a room until you have
  seen it, and doubles as the automap.
- **Movement** — vanilla's wall-sliding, straferunning and falling over this engine's own
  collision ([docs/movement.md](docs/movement.md)), under an orbitable camera that fades the walls
  between you and it.
- **Fighting and items** — every weapon, monster and pickup, on vanilla's own tables
  (see [Gameplay](#gameplay) above).
- **Specials** — doors, lifts, floor movers, crushers, switches, teleporters, locked doors,
  damage floors and secrets.
- **Around the level** — sound and music out of the loaded WAD, savegames and best times, replays,
  and three of vanilla's cheat codes typed in as they always were.

**BOOM-format maps load and play**: extended BSP nodes, generalized linedefs and sector types, the
extended linedef numbers, six-slot keys and generalized locks, elevators, silent and line-to-line
teleporters, a WAD's own `ANIMATED` and `SWITCHES` tables, scrolling surfaces,
conveyors, friction, wind and pushers, voodoo dolls, deep water, transfer lighting, translucent
midtextures and custom colormaps. The one number deliberately left out is MBF's sky transfer —
nothing draws sky in a top-down view. `inspect-wad` classifies every special a map uses, so what a
particular WAD would lose is answerable before you play it.
See [docs/specials.md](docs/specials.md).

**UDMF maps load** (experimental): a `TEXTMAP` map parses into the same records a binary map
yields, with its BSP read from the `ZNODES` lump — there is no node builder, so a map saved without
nodes won't load. A map in the `doom` or `ZDoomTranslated` namespace plays in full, Boom specials
included; other namespaces draw, collide and fight, but their ZDoom-style action specials don't run
— the library flags such a WAD red and still lets you pick it, for walking a map whose doors won't
open.
See [docs/wad.md](docs/wad.md#udmf).

**`DEHACKED`/BEX patches are read** from a WAD that ships one: level titles, par times, monster,
weapon and ammo stats, `Frame` records, repointed frames and `[SPRITES]` renames — and **action
pointers (`Pointer`, `[CODEPTR]`), MBF's included**, so a repointed chain fires the attack that
pointer belongs to at the timing the chain implies. A patch asking for something out of scope
still loads and plays, and what was skipped is reported rather than dropped silently.
See [docs/dehacked.md](docs/dehacked.md).

## Dev mode

Set `VITE_DEVMODE=true` in a `.env.local` file at the repo root (git-ignored, create it
yourself) and restart `npm run dev` to turn on the debug overlay's full readout and the profiler's
default. No key is dev-only. See [docs/devmode.md](docs/devmode.md).

## Working on it

[CLAUDE.md](CLAUDE.md) has the source tree, the project-wide conventions and the index of `docs/`,
where every subsystem — WAD parsing, rendering, movement, combat, the monsters, specials, saves —
is documented in depth.

```bash
npm test          # Node's own runner: no extra dependencies, no browser
npm run typecheck # both must be clean

# what a WAD holds and whether this engine can run it, down to the specials and
# DEHACKED records each map uses — headless, no browser
node scripts/inspect-wad.ts public/game/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/game/iwad/DOOM2.WAD MAP05 public/game/pwad/SCYTHE.WAD
```

See [docs/testing.md](docs/testing.md), and [CLAUDE.md](CLAUDE.md) for what every line of the
inspection report means.

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
