# The HUD, level card, intermission and screen effects

`src/ui/hud/hud.ts`, `src/ui/hud/wadfont.ts`, `src/ui/hud/levelcard.ts`, `src/ui/hud/intermission.ts`,
`src/ui/hud/message.ts`, `src/ui/hud/crosshair.ts`, `src/ui/hud/screeneffects.ts`, `src/game/besttimes.ts`,
`src/game.ts`

Everything on screen that isn't the world. What the readouts *report* — the inventory, pickups and
powerups behind them — is docs/items.md. The one other thing drawn over a running level,
`src/ui/hud/deathoverlay.ts`, is documented with what raises it: docs/death.md § Player death.

## The HUD

The HUD draws its icons from the same WAD pickup-sprite graphics the world renders items with
(`MEDIA0`, `ARM1A0`/`ARM2A0`, `CLIPA0`, … via `GraphicsBank.picture`) rather than hand-drawn icons,
decoded once into `<canvas>` elements whose markup lives statically in `hud.html` (`#game-hud`)
whether or not that WAD's graphics are loaded yet — `Hud`'s constructor draws into them once per
`Game` instance. Finding the right lump names surfaced a pre-existing bug: the rocket pickup
(doomednum 2010) was mapped to sprite `RCKT`, which isn't a real lump — the actual sprite is `ROCK`,
so rockets were invisible in the world.

**The key strip is one panel per color, lit when either of that color's slots is owned** (cards
and skulls are tracked separately — docs/items.md § Locked doors and use triggers). The panel
shows the keycard sprite by default and swaps to the skull sprite (`BSKUA0`/`RSKUA0`/`YSKUA0`)
while the skull is the only key of its color held, so what you see is what you actually carry.

**The weapon icon is not decoration.** Unlike the original's status bar, where the weapon fills the
bottom third of the screen, this game's player sprite looks identical whatever it's holding — `PLAY`
has no per-weapon art, and at this camera distance it wouldn't read anyway. The HUD icon is therefore
the *only* indication of what's selected. Its markup is built in `Hud`'s constructor from
`WEAPON_CYCLE` rather than written into `hud.html` like the other panels: the weapon list is a
compile-time constant in `weapons.ts`, so duplicating it as static markup would be two lists to keep
in sync. Icons reuse each weapon's own ground-pickup sprite (`WeaponDef.iconLump`); fist and pistol
have no pickup, so they fall back to their first-person `PUNGA0`/`PISGA0` frames.

Those sprites differ wildly in aspect — at the strip's 32px height DOOM2's `SHOTA0` renders 168px
wide against `PISGA0`'s 29px — so `.hud-weapon` is pinned to a **fixed 140px column** rather than
sized by its icon: otherwise `#game-hud` changes width on every weapon switch and every panel beside
it jumps. Icons narrower than the column are centred in it, and a wider one is scaled down to fit,
which is `object-fit: contain` on the canvas — `max-width` alone clamps the box but stretches the
content into it, since the canvas is a replaced element.

**The powerup strip** (`.hud-powers`, built from `STRIP_POWER_IDS` the same way) exists for the same
reason: a running powerup has no other on-screen presence at all — no number that changes, no door
that opens — so without it there's no way to know one is active or how much is left. Each row shows
that powerup's ground-pickup sprite plus a countdown, blank for the one remaining `Infinity`-duration
entry. The backpack shares the strip: same "you have this now" status, also with no number of its own.
The whole panel collapses via `.hud-stat.hidden` while nothing is active, so `#game-hud`'s flex `gap`
doesn't leave a hole.

**Berserk is deliberately not in the strip** (`STRIP_POWER_IDS` = `POWER_IDS` minus `'berserk'`) — it
already has an on-screen presence the others don't: the health icon swaps from `MEDIA0` to berserk's
own `PSTRA0` while held, the same idea as the armor icon swapping between its green/blue art by
`armorType`. Two `<canvas>` elements sit in `.hud-health` (`.icon-normal`/`.icon-berserk`), toggled by
`.hidden` — no countdown needed, since berserk is one of the `Infinity`-duration powers.

Both dynamically-built panels `replaceChildren()` before filling themselves: `Hud` is constructed per
`Game` against the *same* static `#game-hud` element, so a second game started from the menu would
otherwise stack a second full set of icons on the first's.

## Level stats (kills / items / secrets)

`#hud-levelstats` — a plain sibling of `#game-hud`'s own bordered box, both inside `#hud-bar`, sitting
immediately to its left rather than inside it — shows vanilla's classic three ratios —
`M: kills/totalKills`, `I: items/totalItems`, `S: secrets/totalSecrets` — confirmed against
`linuxdoom-1.10/info.c`'s `mobjinfo` table rather than assumed from doomednum lists that exist for
other purposes.

`#hud-bar` lays the pair out as a three-column grid (`1fr auto 1fr`), not a centered flex row: a
centered flex row centers the *pair's combined* bounding box, which would push `#game-hud` off the
true viewport center by half of `#hud-levelstats`'s own width. With the grid, the two `1fr` outer
tracks stay equal width regardless of what's in them, so the middle `auto` column — `#game-hud` —
always lands exactly on center; `#hud-levelstats` sits in the left track, right-aligned
(`justify-self: end`) so it's flush against `#game-hud`'s own left edge.

- **Kills** — `things/tables.ts`'s `COUNTKILL_TYPES` is `MONSTER_TYPES` minus the lost soul (3006) and
  the Icon of Sin's brain (88), neither of which carries vanilla's `MF_COUNTKILL`. `totalKills` is
  counted once, at map load, in `things.ts`'s `buildThingSprites` spawn loop (mirrors
  `P_SpawnMapThing`'s own `if (mobj->flags & MF_COUNTKILL) totalkills++`); `kills` increments in
  `ThingLayer.damage`'s death branch with **no** "already counted" guard, matching vanilla's
  `P_KillMobj` exactly — an arch-vile-resurrected monster killed a second time counts twice.
  **`ThingLayer.reviveCorpse` raises `totalKills` by one for every resurrection**, which is the one
  deliberate deviation in these counters: it follows ZDoom's `AActor::Revive` ("[RH] If it's a
  monster, it gets to count as another kill", `p_mobj.cpp`) rather than vanilla, whose `A_VileChase`
  touches neither counter and therefore reads over 100% — a real save on SCYTHE.WAD MAP11 showed
  75/67. With the raise counted, a monster raised *n* times costs *n* extra kills and adds *n* to
  the total, so clearing the level still ends at exactly 100%. The Icon of Sin's cube is **not**
  covered by this: `spawnMonster` deliberately leaves `totalKills` alone, so MAP30 keeps vanilla's
  own >100% (docs/monster-iconofsin.md § The spawn cube).
- **Items** — `COUNTITEM_TYPES` is the doomednums with vanilla's `MF_COUNTITEM` flag: health/armor
  bonus, soulsphere, invulnerability, berserk, invisibility, computer map, light visor, megasphere.
  Keys, the backpack, weapons, ammo and the radiation suit are deliberately excluded — none carry
  the flag in vanilla (the backpack not counting toward item% is a well-known vanilla quirk this
  reproduces on purpose, not an oversight). `totalItems` is counted the same spawn pass as
  `totalKills`; `items` increments in `ThingLayer.tryPickup`'s success branch.
- **Secrets** — `sector.special === 9` is vanilla's "SECRET SECTOR". `SectorEffects.update`
  (`game.ts`) is this repo's direct reimplementation of vanilla's `P_PlayerInSpecialSector`,
  covering both this case and the damage-floor cases below it in the same switch, gated by the same
  `player.z === sector.floorHeight` vanilla itself checks. Entering the sector increments
  `secretsFound` and clears `sector.special` to 0, exactly like vanilla — which is also what stops a
  second frame in the same sector from double-counting, no separate guard needed. `totalSecrets` is
  counted once at map load (`sector.special === 9` across `map.sectors`), the direct analog of
  vanilla `P_SpawnSpecials`' `case 9: totalsecret++`.

Both counts and the `Game.hud.update` stat object are assembled fresh every frame — cheap integer
reads, not worth caching.

Once a line's `found` reaches its `total`, `Hud.drawStatLine` switches that line's number run from
yellow to a green `WadFont` (sampled from `ARM1A0`, the green armor pickup). Vanilla has no
equivalent — its intermission screen prints every percentage in the same color regardless of
value — so this is a UI addition, not a fidelity reproduction; only the choice of *which* WAD asset
to sample the color from follows the same convention the yellow recolor already established.

## Level timer

`#hud-timer`, the third column of `#hud-bar`'s grid (mirroring `#hud-levelstats` on the opposite
side, flush against `#game-hud`'s right edge via `justify-self: start`), shows time spent in the
level as `hh:mm:ss`, drawn with the same `WadFont` used for the strip's labels (native STCFN red,
no recolor). `Game.levelTime` accumulates `dt` in `frame`, gated the same way `tickPowers` is —
frozen once `playerDead` — and reset to 0 in `loadMapByIndex`. It also never advances on the frame
an exit trigger fires: that frame already returns early once `pendingExit` is set (see that field's
own doc in `game.ts`), before reaching the increment, so no separate "level complete" check is
needed on top of the death check. That frozen instant is exactly what the intermission below shows,
and it stays frozen for as long as the popup is up: those frames return early too.

## Level card

`src/ui/hud/levelcard.ts` raises "Entering" over the level's name (`#level-card`, horizontally centered,
30% down so it clears `#hud-message`'s 40%) for 3.5 seconds after every map load that *enters* a
level — a normal exit, a `restart()` after death with nothing to reload, and the DEVMODE
`N`/`P` jump alike — fading out over the last second of that. **Loading a save is the one map load
that raises no card** (`loadMapByIndex`'s `restore` branch, docs/savegames.md § Apply order): it
resumes a level rather than entering one. A `restart()` that *does* reload something — the level's
savegame or its checkpoint — goes through that same branch, so it raises none either. The fade is
`opacity` driven from `update`'s own `dt`, not a CSS transition: a transition runs
on wall-clock time, so opening the menu on a fresh level would leave the card fading away behind it
and gone on return, while everything else about the frozen level waited. Two canvases rather than one: both hold
native-size art and `levelcard.css` gives them different heights, which is how the name draws at twice
the label's size without a second glyph set. The label is `WadFont` in STCFN's own red.

**The name is the WAD's own `CWILV`/`WILV` graphic wherever the set has one that belongs to this
map** (`LevelNames.graphicFor`, docs/wad.md § Level names) — the level's name as its artist drew it,
blitted with the same `drawIcon` the HUD uses for pickup sprites, at a CSS height that lands its
caps at the text's own size. Text is the fallback, for a map with no such lump (`E5M1`, a
single-map PWAD) or a WAD set where the only candidate patch belongs to a different level. It is
drawn in a grey sampled from `CWILV00`'s glyph body, so the two forms read as the same thing rather
than as two different announcements.

It is shown at the **end** of `loadMapByIndex` — that method clears every per-level overlay at its
top, so a card raised any earlier would be wiped by its own load. The text form shows the level's
bare title ("Hangar"), not its lump name, which the menu listed a moment earlier and the DEVMODE HUD
shows anyway.

Vanilla has no equivalent: there the level name belongs to the intermission screen you just left,
not to the level you arrive in. 3.5 seconds is **tuned by feel**, a little longer than a center
message's 3 since there is nothing else on screen to read yet.

## Intermission

`src/ui/hud/intermission.ts` (`#intermission`) is the end-of-level popup: the same three counts the HUD
strip carries, as vanilla's percentages this time, then the frozen level time, then the best-time
lines (§ Best times) and the continue hint. The three percentages are **right-aligned** against
each other, which the HUD strip's own numbers are not: the strip's are one glance among many, while
these three sit stacked as a block where a ragged right edge is the first thing you read. A value
wider than the `100%` the column is sized for — kills can pass 100% — widens the column rather than
being clipped. `Hud`'s other layout rules apply — a red label run, values from a shared column, and
the yellow→green switch at 100% — and `formatClock`/`percentOf` are shared with the HUD strip
(`ui/hud/hud.ts`) so the popup and the bar can never disagree about the same numbers. `percentOf`
truncates, matching `wi_stuff.c`'s C integer division, and reads 100% for a total of 0, where
vanilla would divide by zero.

Lines are centered in the panel, but the three stat lines sit in a `.stats` wrapper so they are
centered as **one block**: centering each on its own would stagger the labels and undo the very
column `drawStatLine` lines the numbers up in.

The control flow is the part worth knowing:

- `Game.pendingExit` no longer loads the next map. On the frame it is consumed (still right after
  `specials.update()` has returned — see that field's own doc for why the teardown can't happen
  inside the callback) it shows the popup and sets `popup` to `'intermission'`.
- While `popup` is set, a branch at the **top** of `frame` advances nothing at all — no clock, no
  specials, no monsters — and only re-renders the still scene under the popup. `Space`/`Enter`
  enters the next level, which clears the popup and the field along with every other per-level
  overlay. `popup` is **one field, not a flag per screen** (§ End card adds the second): the two are
  mutually exclusive, and a field makes that unrepresentable instead of merely documented.
- The popup ignores that key for its first `INTERMISSION_INPUT_DELAY` (`intermission.ts`). `Space`
  is *also* the use key, so without the delay a mashed exit switch dismisses the popup on the frame
  after it appears. The press that opened it can't leak through on its own — `Input.pressed` is
  edge-triggered and the exit frame ends with `endFrame()` — but a second tap would.
- Deliberately not any-key, and deliberately not `pause()`: `Escape` belongs to the menu (`main.ts`)
  and would otherwise both pause and dismiss the popup in one press, and a paused `Game` stops
  reading input, which is the one thing this state needs.

Secret exits still advance by `+1` like any other (the `secret` flag is dropped in `specials.ts`),
so there is no secret-level routing for the popup to announce.

## End card

`src/ui/hud/endcard.ts` (`#end-card`) is what the intermission hands over to when the exit just
taken was the campaign's last — `NextLevel`'s `end` case, which is DOOM's `E<x>M8`, DOOM II's MAP30,
or a MAPINFO finale keyword (docs/wad.md § Level progression). Three lines: `Episode complete` or
`Game complete` by the `scope` the progression reported, then the episode's own `M_EPI<x>` menu
graphic (`LevelNames.episodeGraphicFor`, under `graphicFor`'s provenance rule) falling back to the
WAD set's label, then a hint that names what the continue key will do.

**It is deliberately not vanilla's `f_finale.c`.** No typed-out `E1TEXT`/`C4TEXT` over a tiled flat,
no `HELP2`/`VICTORY2`/`ENDPIC`, no E3 bunny scroll, no DOOM II cast call. What is reproduced is the
one thing whose absence was a bug: that these exits end the run at all, instead of walking off the
end of the table into E1M9/MAP31. The finale's *music* is taken (`LevelMusic.finaleTrackFor` —
`F_StartFinale`'s `mus_victor`/`mus_read_m`), since the card is the screen standing in for it.

Two deliberate deviations from vanilla, both about where the player ends up:

- **The intermission still runs on `E<x>M8`.** `G_DoCompleted`'s `case 8: gameaction = ga_victory;
  return;` returns *before* `WI_Start`, so vanilla shows no stats screen for an episode's last
  level. This engine's intermission carries the level clock and best times, which vanilla's has no
  equivalent of, and skipping it would silently swallow a record set on the level that most deserves
  one. The card comes after it, on the same frozen level.
- **A DOOM episode end carries on into the next episode** (`E<x>M8` → `E<x+1>M1`) when the loaded
  set actually provides it, where vanilla drops to the title screen and makes the player pick.
  `LevelProgression` is what decides whether the set has that map; the card's hint says "continue"
  when it does and "return to the menu" when it doesn't, and the heading is unaffected either way —
  an episode ended regardless of what follows. It **pistol-starts**: crossing into a new episode is
  vanilla's `G_DeferedInitNew`, a new game rather than a level transition, so `enterLevel`'s
  `reborn` gives the player a fresh `Inventory` exactly as a death does. Both continues come through
  that one call, so which of them reborns is read off `pendingEnd` — what the *exit* ended — and not
  off which popup happens to be up.

Control flow, continuing § Intermission's:

- `Game.resolveExit` (still on the frame `pendingExit` is consumed, the last moment `currentMap`
  names the level being left) writes `nextMapIndex` — `-1` when nothing follows — and `pendingEnd`,
  which is *only* the scope. Everything else on the card is rebuilt in `showEndCard`, which still
  runs on the finished level, so there is no snapshot to keep in step.
- The intermission's own continue key raises the card instead of loading anything when `pendingEnd`
  is set (`showEndCard`), restarting the shared `intermissionTime` so that press can't carry through
  both popups.
- The card's continue key loads `nextMapIndex` where there is one, and otherwise calls `Game`'s
  `onCampaignEnd` port — the session layer's cue to dispose the `Game` and reopen the menu as a
  launcher (docs/menu.md § Session lifecycle).
- Both popups freeze the level identically — `tic` advances nothing, `frame` draws at the tic-exact
  pose, `saveRefusal` refuses both — and both print their lines with `hud.ts: drawText`, the shared
  half of every card in this directory.

## Best times

`src/game/besttimes.ts` persists one best completion time per level under `topdoom.bestTimes`
(docs/menu.md § Persisted settings), and the popup shows it: a `Best mm:ss` line on an ordinary run,
or a green `NEW BEST TIME!` with the beaten time as `Previous mm:ss` when the record falls. The
clock stays yellow either way — the record line is what announces one, and recoloring the number
too said the same thing twice. A first-ever completion is a record and so has no `Previous` line to
show.

**The key is the content id of the WAD file that *provides* the map, plus the map lump, plus the
skill** — `Game.recordCompletion` takes both from `mapProvider(wad, map)`
(docs/wad.md § Content id), the same lookup a save's `mapWad` is. Keying on the whole loaded set instead would orphan every record the
moment an unrelated add-on is loaded; keying on the file name alone would let two different WADs
that happen to share a basename fight over one record, and would lose every record on a rename.
Skill is in the key because a time set on skill 1 says nothing about one set on Ultra-Violence.

Two rules about what counts:

- **A `?pos=x,y` run never records.** That entry point can drop the player anywhere, the exit
  included, and one such run would leave an unbeatable time in the table. `Game.recordsEligible` is
  captured in the constructor, because `startPos` is nulled out once the first map has consumed it.
  Such a run shows no best-time lines at all rather than a record it can't touch.
- **A record is only written on an improvement**, so `recordBestTime` returning `previous` is what
  the popup renders either way — the store and the popup never form separate opinions about which
  time is the best one.

The table is one JSON blob, capped at `MAX_RECORDS` with the oldest evicted first, and validated per
entry on read: a single hand-edited or malformed record is dropped rather than the whole table,
since losing one level's time should not cost every other level's.

## Center messages

`src/ui/hud/message.ts`'s `CenterMessage` draws one short line of `WadFont` text over the middle of the
view (`#hud-message`, horizontally centered, 40% down so it clears the player sprite the camera
holds at dead center), for 3 seconds. Two callers so far:

- the secret announcement — `Game.collectPickupsAndSectorEffects` shows `SECRET_MESSAGE` (this
  module's own, since it is display text) and plays the `secret` chime on the frame `SectorEffects.update`
  reports `secretFound`;
- the locked door/switch line — `lockedKeyMessage(key, kind)` composes vanilla's own `PD_*K`/`PD_*O`
  text from the `LockedLine` `Game.frame` drained out of `specials` (docs/items.md § Locked doors
  and use triggers), and its `oof` was already played there.

`show` takes **runs**, not one string: a bare string draws in `COLOR_YELLOW`, a `{text, color}` run
in whatever color it names, and they're laid out left to right on one canvas — which is what lets
the locked-door line print the key's color word in that key's color. Each distinct color costs one
`WadFont` (all 63 `STCFN` patches decoded and retinted), so they're built on first use and cached
for the level rather than per message. The key colors themselves are sampled from the key pickup
sprites, the same convention `COLOR_YELLOW` and `LEVEL_STATS_GREEN` follow, with one documented
exception: `BKEYA0`'s brightest pixel is pure `0,0,255`, unreadable over the playfield at 0.75
opacity, so blue takes the light end of the same palette ramp instead.

Both halves of the secret announcement are this engine's own, not vanilla reproductions: vanilla
announces a secret nowhere at all (its status bar's `S` count just ticks up) and prints what
messages it does have in the top-left in STCFN's native red; the chime isn't a WAD lump either
(docs/audio.md § Player and pickups). Placement is
center-screen in `COLOR_YELLOW`, where a top-down player is already looking, and 3 seconds rather than
vanilla's 4-second `HU_MSGTIMEOUT` because text in the middle of the view outstays its welcome
faster than text in a corner. Its CSS size (`13px` glyph height, roughly the level-stats strip's
own) and `opacity: 0.75` are **tuned by feel** — it sits over the playfield, so it reads as an
overlay rather than competing with what's under it.

The timeout is ticked from `Game.frame`'s `dt`, so a paused game doesn't burn a message's display
time behind the menu; `loadMapByIndex` and `dispose` both `clear()` it, since the element is static
markup that outlives any one `Game` (the same reason `Hud`'s panels `replaceChildren()`).

## `WadFont` (`src/ui/hud/wadfont.ts`)

The strip is drawn with the IWAD's own font graphics rather than DOM text, and built as a reusable
primitive rather than a one-off, since more WAD-font text is expected later. `WadFont` wraps
`STCFN033`-`STCFN095` (`'!'`-`'_'`, vanilla's `hu_stuff.h` `HU_FONTSTART`/`HU_FONTEND` — the same
lumps vanilla's own on-screen messages use). In its default proportional mode, layout matches
`hu_lib.c`'s `HUlib_drawTextLine` exactly: each glyph advances by its own patch width with zero
kerning, a space or unknown character advances a flat 4px, text is uppercased first (the font has no
lowercase glyphs). `measure()`/`draw()` let a caller compose multiple runs (different colors, even
different `WadFont` instances) onto one canvas — `draw()` returns the cursor x just past the last
glyph, so a second call can continue from there.

**Each glyph is placed vertically by its own patch offset**, as `V_DrawPatch` does (`y - topoffset`),
and the line height is the tallest `top + height`, not the tallest patch. STCFN's short glyphs are
not full-height images with blank rows: `.` is a 3px patch with `topoffset` -4, `,` 4px with -3,
`-` 3px with -2. Drawing them all at the line's top — which is what happened before, and showed up
as the period in `SCYTHE.WAD MAP01` floating above the letters — puts every period, comma, hyphen
and underscore at cap height. Nothing else moves: every letter and digit has a zero offset, and
`Q`/`$`/`@` already made the box 8px tall.

STCFN's own pixels are already vanilla's HUD-message red, so the red `"M: "`/`"I: "`/`"S: "` labels
need no recoloring. There is no full-charset yellow font in vanilla WADs (`WINUM`/`STYSNUM` are
digits-only, and mixing font families within one line would visibly mismatch STCFN's glyph height),
so the strip's numbers instead recolor STCFN itself — `WadFont`'s optional `recolor` — tinted to
`STYSNUM1`'s own sampled yellow (`COLOR_YELLOW`, `255,255,115`, exported from `wadfont.ts` since the
center message recolors to it too), so the color still comes from the WAD rather than being
invented. Recoloring is **not** a flat fill: each opaque pixel is scaled by its own brightness
(`max(r,g,b)/255`) before tinting, so STCFN's anti-aliased edges (its glyphs shade from a dark red
core out to a brighter edge) still shade from a dark tint to a bright one rather than flattening to
one solid color — a flat fill was tried first and read as illegible pixel mush. This repo has no
palette-translation-table mechanism (`GraphicsBank` always blits through the one loaded palette),
which is why a second color needs this recolor path at all rather than a second baked-color lump set.

The font itself stays proportional (STCFN's own per-glyph widths, matching vanilla) rather than
monospacing every glyph to a fixed cell — a full-font monospace was tried first and read as too
sparse for a font this narrow. Instead, `Hud.drawStatLine` aligns just the *columns* that need to
line up: `labelColumnWidth` (the constructor's `Math.max` over all three labels' proportional
widths) is where every line's yellow run starts, regardless of how wide that line's own red label
measured — so "M: ", "I: " and "S: " each keep their natural width and stay flush left, while the
three numbers still form a flush column starting at the same x.

## The crosshair

**The mouse cursor is the health readout too.** `src/ui/hud/crosshair.ts`'s `Crosshair` sets the game
canvas's OS cursor to a plus-shaped reticle (an inline SVG data URI, since the built-in `crosshair`
keyword can't be recolored) whose color reports health at a glance: blue above 100, sliding from
green at 100 through yellow down to red at 0 below that. This is TopDoom's own convention, not a
vanilla one — vanilla's status bar has a `%`; the cursor doubles as the aim reticle here (`game.ts`'s
mouse-aim raycast), so there's screen real estate to spend on it that vanilla never had. `update()`
skips rebuilding the cursor image when the computed color hasn't changed, since it's called every
frame from the same `Game.frame` loop as `Hud.update`.

## Screen effects

The two screen tints (`#screen-tint`, `screeneffects.css`) are CSS on the composited frame rather than
anything in the render pipeline. Invulnerability uses `backdrop-filter: grayscale(1) invert(1)` —
vanilla's `INVULNERABILITYMAP` really is a *grayscale* inverse of the palette, not a colour inversion
— and the suit a flat green wash. The element sits at `--z-tint`: above the canvas, below every HUD
layer, so the world recolours and the readouts over it don't. Everything in this section lives
in `ui/hud/screeneffects.ts`, driven off inventory state every frame rather than toggled on
pickup/expiry, so clearing the powers needs no teardown path of its own. **`Game.dispose` has to call
`ScreenEffects.reset`**, since the `Viewport` and these overlay elements outlive a `Game` —
otherwise the menu, and the next level started from it, inherit whatever powerup was running.

Boom's 242 colormaps get a third element, `#colormap-tint`, at the same `--z-tint`. It differs from
the powerup tints in being a **multiply** blend rather than a wash, because that is all a colormap
can do — take light away — and in being driven from `game.ts` rather than from inventory state:
which of the control sector's three colormaps applies depends on the player's eye height against
that sector (docs/specials.md § Deep water). `Game.viewColormap` resolves it, `ScreenEffects.setColormapTint`
writes it, and `reset` clears it with the rest.

**Invulnerability's tint, the suit's tint and invisibility's sprite translucency all blink for their
last `POWER_BLINK_WARNING_SECONDS` (3s)**, via the shared `powerBlinkVisible(secondsLeft)`. Not a
vanilla mechanic (vanilla's own "running low" blink flickers a HUD number, not a screen effect) —
added because these are the powerups where losing track of the exact expiry is actually costly
(walking back into a hazard, or back into plain sight, a second early). The light visor is left out,
since a flickering exposure would look broken rather than read as a warning.
`floor(secondsLeft * POWER_BLINK_HZ) % 2` alternates as the remaining time counts down — a plain
on/off square wave with no separate phase timer, so it needs nothing reset on pickup or level change.

**A red damage flash (`#pain-flash`, its own element rather than a third `#screen-tint` class)** echoes
vanilla's palette-shift pain flash (`ST_doPaletteStuff`'s `damagecount`), raised from
`Game.damagePlayer` via `ScreenEffects.addPain`. Vanilla adds the raw damage to a counter clamped to 100 and ticks it down by 1
per tic; this mirrors that as a normalized `painFlash` (0-1, `+= amount / PAIN_FLASH_MAX_DAMAGE`,
clamped) decayed every frame by `dt / PAIN_FLASH_FADE_SECONDS` (100 tics over 35, vanilla's own
full-to-zero time) and written to the element's `opacity` (scaled by `PAIN_FLASH_MAX_ALPHA`, tuned by
feel since vanilla swaps palettes outright rather than blending an overlay). **It's a separate element
because its red has to blend with, not replace, the suit's persistent green wash** — two `background`s
on one element can't coexist, but two stacked elements can. `damagePlayer` bumps it on every hit,
lethal or not, and `loadMapByIndex`/`dispose` reset it alongside `playerDead`/the tint classes.

`SpriteActor.setOpacity` draws through a per-actor **clone** of the shared cached material rather than
mutating it: `SpriteMaterialCache` hands out one material per (lump, mirrored) pair to everything
drawing that lump. Only the player ever uses this, and `PLAY` happens to be the player's alone, but
relying on that would be a trap the first time something else reuses a lump. The clone drops
`alphaTest` from 0.5 to 0.01 — the test is against `texture.a * opacity`, so at 0.35 opacity the 0.5
threshold would discard the *entire* sprite; WAD sprite alpha is binary (0 or 255, and `NearestFilter`
never blends between them), so any threshold below the opacity in use cuts the same silhouette. It's
the stand-in for vanilla's `fuzz` colormap (a per-column smear of what's behind the sprite, with no
direct equivalent here) and deliberately errs toward still being findable: in vanilla the invisible
thing is *you*, seen from your own eyes; here it's a sprite you have to keep track of.
