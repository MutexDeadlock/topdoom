# TopDoom

A top-down DOOM built on the original IWADs. The camera hangs above the player and is
tilted slightly off vertical, so walls show some of their height and levels read as
spaces rather than floor plans; it can also orbit around the player on right-drag or `Q`/`E`. Level
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

Everything under `public/wads/iwad/` and `public/wads/pwad/` shows up automatically: a Vite
plugin reads each file's header and directory — a few kilobytes even for a 14 MB IWAD — and
publishes them as `/wads/index.json`, so the menu can list types, sizes and map counts
without downloading anything. The same manifest is baked into the output on `npm run build`.

- **Game WAD** — offered from `public/wads/iwad/`. Normally an IWAD, but a PWAD carrying
  maps works too if you put it there.
- **Add-ons** — offered from `public/wads/pwad/`, any number, merged in the order they were
  ticked. The level list updates as you tick them and names the file a map came from when an
  add-on took it over. An add-on whose own maps are `ExMy` (DOOM 1) or `MAPxx` (DOOM II) is
  disabled once it conflicts with the selected game WAD's own naming scheme, and any already
  ticked when you switch game WAD is unticked automatically; add-ons with no maps of their
  own (textures, sounds, ...) always stay selectable, showing their lump count instead of a
  map count so they don't read as empty.
- **Level** — every map in the resulting set, grouped by episode for DOOM 1.

The folder a file sits in decides how it's served, regardless of its own IWAD/PWAD
signature — a mod placed in `wads/iwad/` becomes a selectable game WAD, matching the "PWAD
carrying maps" case above. The dev server logs a warning if a file's signature disagrees
with its folder, but still serves it.

Files outside `public/wads/` go through *Load from disk* or by dropping them on the window;
they are parsed in the browser and behave exactly like server-side ones. A file that
declares itself an IWAD becomes the game WAD, a PWAD is added as an add-on.

`Esc` returns to the menu and pauses; `Esc` again resumes where you left off.

`?wad=DOOM2.WAD&pwad=SCYTHE.WAD&map=MAP05` preselects and skips the menu.

The current version and a credit line sit in the bottom corners of the menu.

## Dev mode

Set `VITE_DEVMODE=true` in a `.env.local` file at the repo root (git-ignored, create it
yourself) and restart `npm run dev` to turn on:

- the debug overlay in the top-left corner (map name, position, sector, camera state,
  hotkey hints — without it, only the fps counter shows)
- the `N` / `P`, `+` / `-` and `[` / `]` hotkeys below

Without it those hotkeys are simply inert. `C` (ceiling toggle) always works either way.

## Controls

| Key | |
|---|---|
| `W` `A` `S` `D` | move (screen-relative: `W` always moves away from the camera) |
| `Shift` | run |
| mouse | aim; the view leads slightly towards the cursor |
| left mouse | fire (hold to keep firing) |
| `1`–`7` | select weapon; pressing a slot again toggles within it (fist/chainsaw, shotgun/super shotgun) |
| mouse wheel | cycle through the weapons you own |
| right-drag / `Q` `E` | orbit the camera around the player |
| `N` / `P` | next / previous map *(dev mode only)* |
| `C` | toggle ceilings |
| `+` / `-` | camera distance *(dev mode only)* |
| `[` / `]` | camera tilt *(dev mode only)* |
| `R` | restart the level (once dead) |
| `Esc` | menu / resume |

Ceilings are off by default — from above they would hide everything underneath. See
[Dev mode](#dev-mode) for the keys marked above.

Forward and sideways are separate speeds that are never blended into one, exactly as in
vanilla — so **straferunning works**. Running forward and sideways at once (`W`+`D`+`Shift`)
moves you faster than either alone: SR40, 1.28× plain running, matching vanilla's ratio.

## HUD

Walking within range of a health, armor, ammo, key, weapon, backpack or powerup pickup
collects it automatically — no key press needed. The bar along the bottom of the screen shows
the running totals: a medikit icon and health, an armor icon (green or blue, matching
whichever armor you're wearing — blank while you have none) and its value, all four ammo
counts, one slot per key color that lights up once collected, and the weapon you currently
have selected. That last one matters here in a way it doesn't in the original: the player
sprite looks the same whatever it's holding, so the HUD icon is the only thing telling you
what you're about to fire. Every icon is decoded from the loaded WAD's own pickup art rather
than hand-drawn, so it matches whatever WAD set is in use.

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

Picking a weapon up selects it, as in the original, and grants twice one ammo pickup's worth
of its ammo. `1`–`7` pick a slot; pressing the same slot again toggles between the two weapons
that share it (fist/chainsaw, shotgun/super shotgun) rather than always jumping to the better
one, which would otherwise make the weaker weapon unreachable. The mouse wheel cycles through
everything you own.

Holding the left mouse button fires at the weapon's own rate, spending ammo. Hitscan weapons
(pistol, shotgun, super shotgun, chaingun) draw a thin line from the player to whatever they
hit, flashing for a fraction of a second; the shotguns throw a spread of pellets rather than a
single line. The rocket launcher, plasma rifle and BFG launch a sprite that flies to its target
and plays the original's own explosion animation on impact. The fist and chainsaw swing at
whatever is within arm's reach in front of you, for the original's own 2–20 damage — ten times
that for the fist while berserk is running.

**Aiming is by mouse, and putting the cursor on a monster locks onto it.** The shot is then
aimed at that monster's actual position and height instead of at wherever the cursor's
projection onto the floor plane happens to land — so shooting an enemy up on a ledge angles
the shot to reach it, rather than firing flat and stopping against the step. It's the
pointer-driven equivalent of DOOM's own auto-aim, which had no cursor to work from. The lock
follows the cursor rather than waiting for the click, so the aim doesn't jump the moment you
fire. Real walls and closed doors still stop a shot short and explode it there.

**A shot that lands deals real damage**, using monster health values and the same random damage
rolls as vanilla; a monster's health hitting 0 plays its own confirmed WAD death animation and it
stops being targetable. Overkill it by enough — vanilla's own rule, only for the handful of
monster types (the human grunts and the imp) that actually have gib art — and it gibs instead of
dying normally. Three monster types drop something when killed, matching vanilla exactly: the
zombieman and Wolfenstein SS drop a clip, the shotgun guy a shotgun, the chaingunner a chaingun —
everyone else, gibbed or not, drops nothing. A drop grants half the ammo a map-placed pickup of
the same thing would, same as picking up a real dropped item always has. A locked-on shot hits whatever it was aimed at; an unlocked one still
hits any monster its straight path crosses on the way to a wall, the way a real shot would — you
don't have to click something for it to be in the way. A rocket's blast also splashes everyone
nearby, falling off with distance the same way vanilla's own explosions do — including the
player, so firing one at your own feet hurts you too, exactly like the original. A BFG blast
splashes nearby monsters as well, but — unlike the rocket — never the player who fired it,
matching the original's own BFG, which doesn't damage through a radius explosion at all. A thin
green line draws from the impact to everything the BFG's splash actually caught, the same
tracer a hitscan shot draws to its own target, so it's visible which nearby monsters it hit.

**Barrels explode.** Shoot one, punch one, or catch it in a blast, and it detonates a moment
later for the same 128-radius, 128-damage splash a rocket deals — hurting the player and any
monster nearby, and, if another barrel is close enough, setting that one off too, chaining as
far as the barrels reach. You can also lock onto a barrel with the cursor the same way as a
monster.

**Monsters wake, hunt and shoot back.** One notices the player by sight — only within roughly its
forward 180°, so a monster facing away doesn't spot you behind its back — or by hearing gunfire,
which spreads room to room the way the original's does, stopped by closed doors and softened by
the sound-blocking lines mappers use for exactly that. Monsters marked "deaf" in the editor ignore
the noise, as intended. Once alerted, one hesitates for a beat and then closes on the player,
stepping up onto low ledges and sliding around corners with the same physics the player moves
with; it won't walk off a drop it couldn't survive, unless it's one of the three types that float.

Every timing that decides how a monster *feels* — how fast it walks, how long its attack takes,
how often it can fire from a given distance, how long a hit staggers it — is taken from the
original's own tables rather than tuned by hand, so the pecking order carries over: a zombieman
shambles, a demon rushes, and nothing in the game can quite keep up with a running player. A
monster stands still for the whole length of an attack instead of shooting on the move, which is
what makes a mancubus plant itself for its volley and a chaingunner hold position and hose you
until you break line of sight. Lost souls drift slowly and then hurl themselves at you, and can
be sidestepped once committed. Damage numbers are the deliberate exception — they're tuned softer
than the original's, so the rhythm matches but the bite doesn't.

Monsters walk the original's eight movement directions rather than heading straight at you,
committing to a heading and re-routing when it stops working, which is where DOOM's characteristic
zig-zag approach comes from. They're solid: they block each other and they block you, so a demon
in a corridor is something to squeeze past rather than walk through. And they will absolutely
fight each other — a shot that clips the wrong monster on its way to you turns that monster on
whoever fired it, with the original's own rules about who can be provoked (a monster already
committed to a fight ignores new attackers for a while, nobody picks a fight with an arch-vile,
and a fireball passes harmlessly through the shooter's own kind, barons and hell knights counting
as one). Monster closets work too: monsters trigger the teleport lines, doors and lifts the
original lets them, including the teleporters only they can use.

Worn armor absorbs part of any hit the player takes (a third for green, half for blue, same as
the original) before it reaches health. Health hitting 0 ends the level with a death screen —
press `R` to restart it, with a clean inventory.

## Layout

```
src/wad/       WAD files, merged lump directory, map lumps, graphics decoding
src/render/    BSP polygon reconstruction, mesh building, materials, occlusion fading,
               sprites, shot tracers, camera
src/game/      spatial queries, collision, player controller, input, inventory/pickups,
               weapons and shooting
src/ui/        start menu, HUD
src/constants.ts   cross-cutting constants (VERSION, DEVMODE)
plugins/       Vite plugin publishing the public/wads/{iwad,pwad} manifest
scripts/       headless WAD inspection (node scripts/inspect-wad.ts)
```

For how any of this actually works under the hood — WAD merging rules, BSP polygon
reconstruction, occlusion fading, collision, fog of war, shot/damage resolution, and so on —
see [CLAUDE.md](CLAUDE.md), which documents the implementation in depth.

## Checking a WAD without a browser

```bash
node scripts/inspect-wad.ts public/wads/iwad/DOOM.WAD E1M1
node scripts/inspect-wad.ts public/wads/iwad/DOOM2.WAD MAP05 public/wads/pwad/SCYTHE.WAD
```

Reports lump and map counts, which file a map came from, any textures it references but the
WAD set lacks, how many subsector polygons came out degenerate, and whether the player start
is walkable.

## State

Playable as a walkable level viewer you can fight in: geometry, textures, sector lighting,
collision with step-up/headroom rules and vanilla's own wall-sliding, straferunning,
gravity-based falling off ledges, vanilla's
narrow-gap-crossing quirk, floor following, map switching, PWAD loading, and an orbitable
camera (right-drag or `Q`/`E`) with wall-occlusion fading. Fog of war hides rooms and secrets
until the player has actually seen them. THINGS render as upright sprites (monsters, weapons,
ammo, health/armor, keys, powerups and common decorations), and the player is drawn as the
real `PLAY` sprite with a facing-driven rotation frame and a walk-cycle animation. Health,
armor, ammo, keys, weapons, the backpack and all six powerups are collectible and tracked on a
HUD (see [Powerups](#powerups) above); doors, lifts, floor
movers, crushers, switches and teleporters all work, including locked doors, which require
the matching key. All nine weapons can be selected (`1`–`7` or the wheel) and fired, with
hitscan tracers, flying projectiles, impact explosions and click-to-target auto-aim.

Monsters wake, hunt, walk the original's 8-direction pathing, fight back and fight each
other — see [Weapons](#weapons) above for the full rundown. Locked-on shots, explosion
splash and monster attacks all deal real damage, killing monsters (with their own confirmed
WAD death animation) and the player, whose armor absorbs part of any hit first; health
hitting 0 shows a death screen `R` restarts from. Crushers and the crushing-floor family
also hurt anyone caught underneath, matching the original. Not yet: sound (the
sound-propagation rules that alert monsters to gunfire are modeled, but nothing actually plays
audio).
