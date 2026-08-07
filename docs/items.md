# Pickups, inventory, HUD and powerups

`src/game/inventory.ts`, `src/ui/hud.ts`, `src/game/things.ts: ThingLayer.tryPickup`,
`src/ui/screeneffects.ts`, `src/game/sectoreffects.ts`, `src/game.ts`

## Inventory

`Inventory` (health, armor + armor type, four ammo classes, collected keys, weapons, powers) is a
plain struct owned by `Game` in `game.ts`, **not by `Player`** — nothing about resting height or
movement needs it, and keeping it separate is what makes `finishLevel` a one-line call at map load
rather than something `Player`'s constructor has to reason about.

Weapon ownership and ammo land in `Inventory.weapons`/`Inventory.ammo`, read by `game/weapons.ts` for
selection and firing. `Inventory.currentWeapon` lives here for the same reason the rest of the struct
does: `game.ts` owns it, and the HUD reads it off the same struct it already reads health/ammo/keys
from. Picking up a weapon **not already owned** selects it, matching `P_GiveWeapon`; re-picking one
you have doesn't yank the selection away. `fist` and `pistol` are in `WeaponId` even though neither
has a map pickup — every game starts owning both, and they still need ids to be `currentWeapon`-able.

`applyPickup` follows `P_TouchSpecialThing`: most importantly, a Stimpack/Medikit at full health, an
armor pickup weaker than what's worn, or a weapon whose ammo type is already capped and which is
already owned **isn't consumed** (returns `false`), leaving the item on the ground exactly like
vanilla rather than silently vanishing for no visible effect. Health/armor *bonus* items (health
bonus, soulsphere, megasphere, armor bonus) are the exception vanilla itself carves out — they push
past the normal 100/100 cap up to 200 and are always consumed. A weapon's ammo grant follows
`P_GiveWeapon`: `2 × clipammo[type]`, twice a single ammo pickup of that type, since a map-placed
weapon gives full while a monster-dropped one gives half (see `dropped`, below).

**Keys and powerups don't survive a level transition; health/armor/ammo and the backpack's raised
caps do** (`finishLevel`, called from `loadMapByIndex` before the new map loads) — matching
`G_PlayerFinishLevel`, which clears `player->cards` and `player->powers` (and drops `MF_SHADOW`) but
nothing else; `player->backpack`/`maxammo` are deliberately not among them. This does mean a locked
door on the far side of a transition needs its key collected again, same as vanilla requires.

## Collecting things

Removing a picked-up item from the world is `ThingLayer`'s job, not `Inventory`'s: each posed thing
already carries its doomednum and position, so `tryPickup(x, y, z, radius, consume)` tests distance
and calls back into `applyPickup`, hiding the mesh and marking it `picked` only if `consume` reports
the pickup actually happened. `picked` short-circuits `ThingLayer.update` before it touches
fog-of-war visibility — without that, a subsector coming into view after its item was picked would
make `fogAlphaOf` flip the permanently-hidden mesh back to visible.

**`tryPickup`'s `z` check** exists because 2D distance alone lets a player standing at the *base* of a
not-yet-lowered pillar collect an item still on top of it — DOOM2 MAP04's blue key does exactly this.
Matching `PIT_CheckThing`'s overhead gate, a pickup more than `PLAYER_HEIGHT` above or below the
player is skipped regardless of 2D range. That in turn requires a thing's height to track its
sector's *live* `floorHeight` rather than a value cached at load: `PosedThing` stores the `Sector`
reference itself (the same mutable object `SpecialsController` writes `floorHeight`/`light` onto)
instead of a frozen `z`, and both `ThingLayer.update` and `tryPickup` read `sector.floorHeight` fresh
every call. Without this, an item on a lift would hang frozen in its original position while the
floor moved past it, and stay permanently out of reach even after the pillar carrying it lowered.

## Making monster drops readable

A monster's death drop (`MONSTER_DROPS`) was nearly invisible, because it spawns at *exactly* the
corpse's own position: the two upright sprite planes are coplanar, so the depth test resolves them
by draw order and the clip ends up buried inside the corpse art. Three things fix it together
(`game/things.ts`, all tuned by feel), and each covers a case the others don't:

- **A drop is drawn hovering `DROP_HOVER` above the floor, bobbing `DROP_BOB` either side of it.** A
  corpse's silhouette is ground-hugging, so lifting the item clears most of it geometrically — and
  where the item does overlap, it mostly overlaps *transparent* corpse pixels, which alpha-test away
  without writing depth. This is **render-only**: `tryPickup` and everything else still work off the
  thing's real `z`, so hovering can't put an item out of reach.
- **Drops draw through their own `SpriteBatch`, constructed with `DROP_DEPTH_BIAS`** — a
  `polygonOffset` that pulls their fragments a few depth-buffer units toward the camera. That is what
  settles the coplanar tie above, deterministically and in the item's favour. It is deliberately far
  too small to punch through geometry genuinely in front of the item; **don't raise it** to solve a
  different problem, or drops start showing through walls. It matters *more* now that drops are
  translucent: a transparent material draws after all opaque geometry but is still depth-tested, and
  an exact tie fails a `LESS` test outright. Costs no extra draw calls either way — batching is
  per-lump anyway and a drop never shares a lump with a monster.
- **A drop pulses in and out**, fading between `DROP_OPACITY_MIN` and `DROP_OPACITY_MAX` over
  `DROP_PULSE_SECONDS` (`SpriteBatch.setOpacity`). What catches the eye is the *change*, so nothing
  has to be brightened or recoloured and the item still looks like its own art. The fade is
  **batch-wide, not per-instance** — `instanceColor` has no alpha channel, so per-sprite opacity
  would need a custom shader — meaning every drop on screen pulses in step. The hover bob is
  per-instance phased, which keeps two drops side by side from looking like one object.

**Only drops get any of this** — `PosedThing.dropped` is the whole test. Items the map placed sit
where the mapper put them, unlit and unmoved: nothing is lying underneath them, and singling out
every clip and health bonus in the level reads as noise rather than information.

## Locked doors and use triggers

**Locked doors check the matching key** (`specials.ts: SpecialsController.trigger`).
`wad/specials.ts`'s keyed door specials (26-28, 32-34, 99, 133-137) each carry a `requiredKey` colour
on their `DoorEffect` — resolved per-special against `P_UseSpecialLine` rather than guessed, since the
two manual-door groups don't share an ordering (26/27/28 are Blue/Yellow/Red, 32/33/34 are
Blue/Red/Yellow). `trigger` checks `ownedKeys.has(requiredKey)` before doing anything else — no
flashing switch texture, no `usedOnce` mark — so a player without the key can walk off, find it, and
press the same line later, matching vanilla functionally (there's no on-screen message system yet to
show the text). `ownedKeys` is threaded from `Game.frame` as `this.inventory.keys` on every
`SpecialsController.update` call, same as `playerX`/`playerY`.

Getting the key check to fire surfaced a second bug in the same table: 99 and 133-137 were missing or
mismarked `manual: true`. Unlike 26-34 (real D1 manual doors, which open the *linedef's own* back
sector and ignore tag entirely), 99/133-137 are S1/SR switches that target sectors by tag — confirmed
by scanning every stock map, where every 99/133-137 linedef's tag exactly matches the sector(s) it
opens. The concrete bug: DOOM2 MAP04's blue door (special 99, missing from the table) never opened at
all, key or no key.

**A `use` trigger only fires from a linedef's front (right-sidedef) side** — `isFrontSide`, confirmed
against `p_switch.c`'s `P_UseSpecialLine`, which unconditionally rejects every use-triggered special
from the back side except an unused one (124). `handleUseTrigger` computes the player's side of each
candidate line (via `P_PointOnLineSide`'s cross-product test) and skips any line the player is behind,
same as `PTR_UseTraverse`. Walk triggers get no such check — `P_CrossSpecialLine` has none — so this
is `use`-only. Without it, a manual door or switch mounted on an ordinary-looking wall (a disguised
"push wall" secret) could be opened from *either* side, letting a player skip the switch a mapper hid
elsewhere; E1M2's sector 21 secret is exactly this shape.

## The HUD

The HUD draws its icons from the same WAD pickup-sprite graphics the world renders items with
(`MEDIA0`, `ARM1A0`/`ARM2A0`, `CLIPA0`, … via `GraphicsBank.picture`) rather than hand-drawn icons,
decoded once into `<canvas>` elements whose markup lives statically in `index.html` (`#game-hud`)
whether or not that WAD's graphics are loaded yet — `Hud`'s constructor draws into them once per
`Game` instance. Finding the right lump names surfaced a pre-existing bug: the rocket pickup
(doomednum 2010) was mapped to sprite `RCKT`, which isn't a real lump — the actual sprite is `ROCK`,
so rockets were invisible in the world.

**The weapon icon is not decoration.** Unlike the original's status bar, where the weapon fills the
bottom third of the screen, this game's player sprite looks identical whatever it's holding — `PLAY`
has no per-weapon art, and at this camera distance it wouldn't read anyway. The HUD icon is therefore
the *only* indication of what's selected. Its markup is built in `Hud`'s constructor from
`WEAPON_CYCLE` rather than written into `index.html` like the other panels: the weapon list is a
compile-time constant in `weapons.ts`, so duplicating it as static markup would be two lists to keep
in sync. Icons reuse each weapon's own ground-pickup sprite (`WeaponDef.iconLump`); fist and pistol
have no pickup, so they fall back to their first-person `PUNGA0`/`PISGA0` frames.

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

- **Kills** — `thingdefs.ts`'s `COUNTKILL_TYPES` is `MONSTER_TYPES` minus the lost soul (3006) and
  the Icon of Sin's brain (88), neither of which carries vanilla's `MF_COUNTKILL`. `totalKills` is
  counted once, at map load, in `things.ts`'s `buildThingSprites` spawn loop (mirrors
  `P_SpawnMapThing`'s own `if (mobj->flags & MF_COUNTKILL) totalkills++`); `kills` increments in
  `ThingLayer.damage`'s death branch with **no** "already counted" guard, matching vanilla's
  `P_KillMobj` exactly — an arch-vile-resurrected monster killed a second time legitimately counts
  twice, the same reason vanilla's own kill percentage can read over 100%.
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

### Level timer

`#hud-timer`, the third column of `#hud-bar`'s grid (mirroring `#hud-levelstats` on the opposite
side, flush against `#game-hud`'s right edge via `justify-self: start`), shows time spent in the
level as `hh:mm:ss`, drawn with the same `WadFont` used for the strip's labels (native STCFN red,
no recolor). `Game.levelTime` accumulates `dt` in `frame`, gated the same way `tickPowers` is —
frozen once `playerDead` — and reset to 0 in `loadMapByIndex`. It also never advances on the frame
an exit trigger fires: that frame already returns early once `pendingExit` is set (see that field's
own doc in `game.ts`), before reaching the increment, so no separate "level complete" check is
needed on top of the death check. This repo has no intermission screen, so that frozen instant isn't
currently visible — the very next frame loads the next map with a fresh zeroed timer — but the
behavior is in place for if one is added later.

### `WadFont` (`src/ui/wadfont.ts`)

The strip is drawn with the IWAD's own font graphics rather than DOM text, and built as a reusable
primitive rather than a one-off, since more WAD-font text is expected later. `WadFont` wraps
`STCFN033`-`STCFN095` (`'!'`-`'_'`, vanilla's `hu_stuff.h` `HU_FONTSTART`/`HU_FONTEND` — the same
lumps vanilla's own on-screen messages use). In its default proportional mode, layout matches
`hu_lib.c`'s `HUlib_drawTextLine` exactly: each glyph advances by its own patch width with zero
kerning, a space or unknown character advances a flat 4px, text is uppercased first (the font has no
lowercase glyphs). `measure()`/`draw()` let a caller compose multiple runs (different colors, even
different `WadFont` instances) onto one canvas — `draw()` returns the cursor x just past the last
glyph, so a second call can continue from there.

STCFN's own pixels are already vanilla's HUD-message red, so the red `"M: "`/`"I: "`/`"S: "` labels
need no recoloring. There is no full-charset yellow font in vanilla WADs (`WINUM`/`STYSNUM` are
digits-only, and mixing font families within one line would visibly mismatch STCFN's glyph height),
so the strip's numbers instead recolor STCFN itself — `WadFont`'s optional `recolor` — tinted to
`STYSNUM1`'s own sampled yellow (`255,255,115`), so the color still comes from the WAD rather than
being invented. Recoloring is **not** a flat fill: each opaque pixel is scaled by its own brightness
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

**The mouse cursor is the health readout too.** `src/ui/crosshair.ts`'s `Crosshair` sets the game
canvas's OS cursor to a plus-shaped reticle (an inline SVG data URI, since the built-in `crosshair`
keyword can't be recolored) whose color reports health at a glance: blue above 100, sliding from
green at 100 through yellow down to red at 0 below that. This is TopDoom's own convention, not a
vanilla one — vanilla's status bar has a `%`; the cursor doubles as the aim reticle here (`game.ts`'s
mouse-aim raycast), so there's screen real estate to spend on it that vanilla never had. `update()`
skips rebuilding the cursor image when the computed color hasn't changed, since it's called every
frame from the same `Game.frame` loop as `Hud.update`.

## Powerups and the backpack

`Inventory.powers` holds seconds remaining per `PowerId`, ticked by `tickPowers`, which `game.ts`
calls only while alive (matching `P_PlayerThink` handing off to `P_DeathThink` before it reaches
them). Durations are vanilla's `INVULNTICS`/`INVISTICS`/`IRONTICS`/`INFRATICS` over 35 — plain
constants that survive conversion out of tics intact, unlike `weapons.ts`'s fire rates. Berserk and
the computer area map are `Infinity`: vanilla stores them as a flag that never counts down, and
`finishLevel` clears them along with every other power anyway.

`givePower` reproduces `P_GivePower`'s three-way split rather than treating the six uniformly: the
four timed ones always take and **restart** their clock (they never stack), berserk always takes and
additionally tops health back up to the normal 100 cap (`P_GiveBody`, never past it the way a bonus
item would) and switches to the fist, and the computer area map is the only one that can be
**refused** — it falls into `P_GivePower`'s generic "already got it" branch, so a second one stays on
the ground.

Where each effect lives is the load-bearing part, since only two of the seven are inventory
arithmetic:

- **Backpack** (`ammoMax`) doubles every cap permanently and hands over one `CLIP_AMMO` of each class.
  Every cap check in `inventory.ts` routes through `ammoMax` rather than reading `AMMO_MAX` — a weapon
  pickup's own ammo grant respects the raised cap too. It is always consumed, even at full ammo,
  unlike every other ammo pickup.
- **Invulnerability** is checked in `applyDamage`, in the same place and with the same `damage < 1000`
  threshold `P_DamageMobj` uses.
- **Radiation suit** gates `SectorEffects.update`'s damage through `suitBlocks`, and vanilla is deliberately not
  uniform here: `DamageFloorEffect.suit` is per sector type — nukage/hellslime are blocked outright,
  the two 20-damage slimes share a `case` reading `!pw_ironfeet || (P_Random()<5)` so a suit still
  leaks `SUIT_LEAK_CHANCE` of hits, and E1M8's finale type (11) never consults the suit at all. The
  interval keeps running while a hit is blocked (vanilla's clock is the global `leveltime&0x1f`), so
  the suit skips damage rather than banking it up for the moment it expires.
- **Berserk**'s ×10 is applied in `WeaponSystem.update`, to the **fist only** — `A_Punch` reads
  `pw_strength` and `A_Saw` deliberately doesn't.
- **Computer area map** is the one whose whole effect lives outside `Inventory`: `FogOfWar.revealAll`,
  watched for by doomednum (`COMPUTER_MAP_TYPE`) in `game.ts`'s pickup callback. Here that *is*
  vanilla's `pw_allmap` — this engine's play view and its map view are the same view, so revealing the
  geometry is exactly what filling in the automap does. It sets only the `explored` flags, not
  `alpha`, so the ordinary reveal lerp fades the level in rather than snapping it on.
- **Partial invisibility** is two things, neither of them a rule about being seen:
  `INVISIBILITY_OPACITY` on the player sprite, and `applyShadowAim` throwing a monster's *ranged* shot
  off-aim by vanilla's own `A_FaceTarget` fuzz (`(P_Random()-P_Random())<<21`, up to ±44.8°,
  `SHADOW_AIM_SPREAD_DEG`). That fuzz is the entire vanilla mechanic — `MF_SHADOW` never touches
  `P_CheckSight`, waking, or a monster's willingness to attack, so none of those are gated on it here
  either. Applied per shot (each bullet of a burst goes its own way) and only to a shot aimed at the
  player (`targetId === null`): nothing else carries `MF_SHADOW`, and an infight shouldn't go wide
  because the player drank something. Melee is deliberately unaffected, matching vanilla, whose melee
  lands on `P_CheckMeleeRange` rather than the fuzzed angle.
- **Light amplification visor** rides `WebGLRenderer.toneMappingExposure` (`LIGHT_VISOR_EXPOSURE`).
  `render/viewport.ts`'s `Viewport` sets `toneMapping = LinearToneMapping` **once**, at construction:
  changing `toneMapping`
  itself recompiles every material's shader, while the exposure is a plain uniform, and
  `LinearToneMapping` at exposure 1 is `saturate(color)` — bit-identical to `NoToneMapping` for
  anything already in range, so it costs nothing until the visor turns it up. A flat multiply is an
  approximation of vanilla's "force the brightest colormap row everywhere"; matching that exactly
  would mean rebuilding every surface's baked vertex lighting.

## Screen effects

The two screen tints (`#screen-tint`, `menu.css`) are CSS on the composited frame rather than
anything in the render pipeline. Invulnerability uses `backdrop-filter: grayscale(1) invert(1)` —
vanilla's `INVULNERABILITYMAP` really is a *grayscale* inverse of the palette, not a colour inversion
— and the suit a flat green wash. The element sits at `z-index: 5`: above the canvas, below every HUD
layer (10+), so the world recolours and the readouts over it don't. Everything in this section lives
in `ui/screeneffects.ts`, driven off inventory state every frame rather than toggled on
pickup/expiry, so clearing the powers needs no teardown path of its own. **`Game.dispose` has to call
`ScreenEffects.reset`**, since the `Viewport` and these overlay elements outlive a `Game` —
otherwise the menu, and the next level started from it, inherit whatever powerup was running.

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
