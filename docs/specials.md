# Line and sector specials

`src/wad/specials.ts`, `src/game/specials.ts`, `src/game/moverblocking.ts`,
`src/game/sectoreffects.ts`, `src/game.ts`, `src/render/occlusion.ts`

The vanilla-only line special table is confirmed against the Doom wiki's linedef type table **and,
where the two disagree, against the real `linuxdoom-1.10` source** — after a first pass briefly (and
wrongly) listed 174 as a vanilla S1 teleport, which is Boom-only. Same story for crusher stop: 58
looks like it could be a third stop-crusher alongside 57/74, but is an unrelated "floor up 24".
`wad/specials.ts`'s own table comments carry the full numbers-to-mechanism mapping.

Every mover here also makes noise, and *which* noise is part of the mechanism: docs/audio.md §
Specials has the per-mover rules, including the shared 8-tic grind clock and the silent crusher
(141), whose sound is the only thing distinguishing it from 25.

**Scope: every vanilla DOOM/DOOM2 linedef and sector special, and nothing beyond.** The table's gaps
were closed by diffing every case in `P_CrossSpecialLine`/`P_UseSpecialLine` against its keys,
directly against `p_spec.c`/`p_switch.c`/`p_floor.c`/`p_plats.c`/`p_ceilng.c`/`p_doors.c`/
`p_lights.c` rather than assumed. That audit is what turned up `raiseToTexture`, `lowerAndChange`,
the one-way `CeilingEffect`, the delayed doors, the instant `LightChangeEffect`s and the donut — each
needing a genuinely new mechanism, all now modelled. Boom/MBF-only numbers (174, 195, the silent
crusher at 150) are deliberately out of scope. Nothing vanilla-scoped remains knowingly unmodelled;
if you find a gap, it's a bug, not a deferred decision.

## Crushers

Start 6/25/49/73/77/141, stop 57/74. Pure ceiling geometry: repeatedly lower to floor+8, reverse,
return to the sector's *own* start height (not neighbor-derived, unlike a door's open height),
forever, with no hold/rest state.

They — and the vanilla `raiseFloorCrush` floor family (55/56/65/94) — deal `CRUSH_DAMAGE` every
`CRUSH_DAMAGE_INTERVAL` (vanilla's 10 HP every 4 tics) to the player or any monster standing in their
sector, via `SpecialsController`'s `onCrush` callback into `game.ts: applyCrushDamage` — the same
callback-into-`game.ts` pattern as `onExit`/`onTeleport`, since `SpecialsController` mutates geometry
but has no idea where anyone is standing. `ThingLayer.monstersInSector` finds candidates by comparing
against the exact same mutable `Sector` object reference `PosedThing.sector` was seeded from, the same
trick `tryPickup`'s live-height read relies on.

The turbo-16 stair specials (100/127) are deliberately *not* included, even though the wiki names them
"...and Crush" — the actual `EV_BuildStairs` source never sets a crush flag on the floor movers it
spawns, so real vanilla turbo stairs don't crush either.

**Nothing blocks a genuine crusher on contact**, matching the `crush==true` branch of `T_MovePlane`
exactly: it keeps hurting whoever's in the way every interval until they leave or die, rather than
stopping, reversing early, or getting stuck. That grind-through behavior is the part of the vanilla
feel that matters for a crusher reading as a hazard.

## Every other mover stops instead

**The vastly more common case genuinely does stop rather than clip through whoever's in its way** —
vanilla's `T_MovePlane`/`PIT_ChangeSector` "un-crush" rule for `crush==false`. Checked against the
real source: vanilla's per-tic mover code reverts that tic's step outright whenever it would leave a
thing with `ceilingheight - floorheight < thing->height`, unconditionally *unless* `crush==true` —
which in practice only the crushing-floor family sets.

`tickDoor` already had this for a closing door; the same rule now also applies to a lowering
`CeilingMover` (real vanilla never sets `crush=true` for this mover) and to a rising `LiftMover` or
`crush: false` `FloorMover` (covering every ordinary raise, `raiseToTexture`, `lowerAndChange`, the
donut's ring, and stair builders — stairs never set `crush` either). Two callbacks carry this out —
`game/moverblocking.ts`'s `blocksCeilingLower`/`blocksFloorRise`, both routed through the shared
`headroomBlocked` helper there.

A door reverses direction outright (it already has a `raising` state to fall back into); a
`CeilingMover`/`FloorMover` has none, so it skips that tick's step and retries the next — reading as
the mover stalling until the obstruction clears, the same practical result as vanilla's per-tic retry.
That covers `T_MoveFloor`/`T_MoveCeiling`, neither of which does anything with a `crushed` result
beyond letting the next tic retry.

**`LiftMover` is the one exception, and it does reverse**: `T_PlatRaise`'s own `res == crushed &&
!plat->crush` branch sets `plat->status = down` (and plays `pstart`) the instant a rise is blocked,
rather than stalling — confirmed against `p_plats.c`. `tickLift`'s `'raising'` branch mirrors this
exactly: on `blocksFloorRise`, it flips `state` to `'lowering'` and plays `pstart`, so a lift a player
is standing under (or half-straddling into a lower-ceilinged neighbor — see docs/movement.md §
Collision's `groundCeiling`) backs off immediately instead of waiting at the ceiling for them to move.
A lowering `CeilingMover`/closing door stopped at their *own* obstruction check still just stalls —
this asymmetry (reverse vs. stall) is vanilla's own, not a simplification here.

**Deliberately asymmetric, matching vanilla**: only the direction that closes the gap on someone is
ever checked (a closing door/lowering ceiling, a rising lift/floor). The opposite direction is left
unchecked, since `P_ThingHeightClip` rides a grounded thing along with a receding floor/ceiling
automatically, so that direction essentially never traps anyone.

**`headroomBlocked` must test sector membership with `circleOverlapsSector`, not a bare
`sectorIndexAt` point test.** Walking up to a door leaves the collision circle straddling the frame —
the same straddling `World.groundFloor` accounts for — so the player's *center* still reads as the
corridor's sector while the door sector, the one actually about to close on them, is never checked at
all. A plain point test was the original bug here. The overlap is approximated the way `FogOfWar`
samples polygons: a ring of points around the circle's rim, ample for a doorway-sized sector.
`applyCrushDamage` keeps the cheap point test on purpose — a crusher's sector is typically the whole
room, where the blind spot barely matters.

Both take prospective heights as explicit parameters rather than reading `player.z`/`m.z`: the caller
is always asking about the height a boundary is *about* to move to, matching `P_ThingHeightClip`
re-syncing a grounded thing's `z` to the new floor before testing it.

**`blocksFloorRise` also checks `World.groundCeiling` at the player's position**, beyond
`headroomBlocked`'s own-sector-only test — straddling half onto a rising lift/floor and half into a
static neighbor sector with a lower ceiling is a case `headroomBlocked` alone misses, since it only
compares against the *rising* sector's own ceiling and the neighbor's lower one never enters the
check. See docs/movement.md § Collision for `groundCeiling` itself.

## Neighbor-height queries

`world.ts`'s `lowestNeighborFloor`/`highestNeighborFloor`/`nextHigher`/`nextLowerFloor`/
`lowestNeighborCeiling`/`highestNeighborCeiling`/`darkestNeighborLight` are vanilla's
`P_FindLowestFloorSurrounding` family — how a mover resolves its target height.

**Each falls back to the sector's own current height only when it has no two-sided neighbors at
all**, never leaving a mover with nowhere to go. The fallback must *not* kick in merely because the
sector's own height is already the most extreme value, which is why these track a `found` flag rather
than seeding the reduction with the sector's own height: a closed door's sector has floor ==
ceiling, so seeding a *lowest* ceiling search with it makes every real neighbor lose, pinning the
door's "open" target at its own closed height instead of the corridor's actual ceiling.

## Teleporters

39/97 for either the player or a monster; Doom II's 125/126 for monsters only. The destination is the
first doomednum-14 landing thing found inside a tag-matched sector (`findTeleportDestination`);
reaching it calls back into `game.ts` to move the player (`Player.teleportTo`) and snap the camera yaw
to match, same as the initial spawn.

**Monsters cross walk triggers too**, via `crossMonster` — `ThingLayer` keeps each monster's own
`prevX`/`prevY` and hands the segment it just walked to a `crossLines` callback, the same "system
reports, `game.ts` realizes" shape as `fogAlphaOf` and the crush callback. Vanilla runs
`P_CrossSpecialLine` for *any* thing but gates non-players to a very short allow-list, reproduced
verbatim as `MONSTER_CROSSABLE`: 39/97/125/126 (teleports), 4 (raise door) and 10/88 (the two
down-wait-up-stay lifts). Everything else — exit lines, stair builders, most doors and floors — does
nothing under a monster's feet, which is why a level's monsters can't wander around rearranging its
geometry. **125/126 are the monster-only pair**: vanilla lists them *only* in the non-player branch,
so a player walking one does nothing, which is what makes the classic monster-closet setup work.

A monster's teleport deliberately does **not** touch `lastTeleport` — that exists solely to reseed the
*player's* walk-trigger tracking — but it does get the same `TFOG` puff at both ends, since vanilla
spawns that for any thing that teleports.

**`lastTeleport`**: teleporting moves the player an arbitrary distance in a single frame, which breaks
`SpecialsController`'s own walk-trigger detection. It tracks `prevX`/`prevY` to know what segment the
player just crossed, and leaving those at the pre-teleport position would make the next frame test a
segment from the old spot all the way to the pad — long enough to cross, and wrongly re-trigger,
unrelated lines along the way. `lastTeleport` is set inside `trigger` and consumed at the end of
`update` to reseed `prevX`/`prevY` from the destination.

Vanilla also spawns a one-shot `MT_TFOG` puff at both ends (where the player stood, and 20 units ahead
of the landing spot along its facing). That isn't a real map `Thing`, so it isn't modeled through
`ThingLayer` — `game.ts` owns a small list of transient `OneShotEffect`s instead (drawn through
`effectBatch`), each playing through the `TFOG` sprite's frames (`A`-`J`, confirmed against the actual
lump names, all rotation-0 so no facing logic is needed) once before removing itself. Map transitions
clear any still-active puffs explicitly, since a teleport onto an exit line could otherwise leave one
animating over the next level.

## One-way ceiling movers

**A ceiling can move on its own** (`CeilingEffect`/`CeilingMover`), separately from a door's ceiling
raise or a crusher's cycle: once to a target and stop, no hold, no reversal.

Special 40 ("RaiseCeilingLowerFloor") is the one vanilla case that needs it — `raiseToHighest` — but
**this engine deliberately only implements 40's ceiling half, because real vanilla's floor half never
actually runs.** Tracing `EV_DoCeiling`/`EV_DoFloor`: both guard on the same per-sector `specialdata`
"already busy" pointer, `case 40`'s handler calls `EV_DoCeiling` before `EV_DoFloor`, and since they
target the same tag-matched sectors, `EV_DoCeiling` claims `specialdata` first — so `EV_DoFloor` does
nothing, every time.

Special 44/72 ("Ceiling Crush", `lowerAndCrush`) is the other user, lowering once to floor+8 and
stopping — and **despite the name it never deals crush damage**: `EV_DoCeiling`'s `switch` sets
`ceiling->crush = true` only for the *cyclic* crush types, and `lowerAndCrush` is a separate `case`
label positioned just past that assignment, so jumping to it skips the flag. `CeilingMover` has no
crush handling at all as a result; `crush==false` is exactly what makes a lowering `CeilingMover` stop
rather than grind through anyone underneath.

## raiseToTexture, lowerAndChange

Both (30/96 and 37/84) are plain `FloorMover`s with trigger-time logic too specific for the
neighbor-height `MoveTarget` model every other floor family uses.

`raiseToTexture` rises by the shortest bottom-texture pixel height among the sector's neighboring
two-sided lines — checking *both* sidedefs of each line, not just the far side, confirmed against
`p_floor.c` — resolved via `MaterialBank.textureHeight`, which decodes (and caches) the full bitmap
just for its height; it fires rarely enough that a second header-only lookup path isn't worth it.

`lowerAndChange` searches the sector's own two-sided neighbors for the first whose floor already sits
exactly at the destination height, and copies *that* neighbor's floor texture and `special` — a
different texture-source rule from the `changeTexture` family, which always copies the triggering
*line's* front sector — and, confirmed against `T_MoveFloor`, applies it only once the mover actually
**arrives**, not at trigger time. `FloorMover.arrivalTexture` carries that pair from trigger to
whichever tick flips `state` to `'done'`.

## Delayed doors

Two different vanilla mechanisms that both boil down to "wait, then move once, unprompted."

Line specials 16/76 (`DoorMode: 'closeThenOpen'`) close immediately, wait `DOOR_CLOSE_WAIT_SECONDS`
(30s) at the bottom, then reopen once to wherever they already were — confirmed against `p_doors.c`:
`door->topheight = sec->ceilingheight` at trigger time, unlike every other `DoorMode`, which computes
a fresh neighbor-ceiling target — and stay open for good.

Sector types 10/14 (`SECTOR_DOOR_SPECIALS`) skip the trigger entirely: a `DoorMover` is spawned
straight into `SpecialsController`'s constructor at map load, assumed already open (10, closes once
after 30s and stays shut) or already closed (14, opens once after `DOOR_RAISE_WAIT_SECONDS` = 5
minutes, then runs one ordinary open-wait-close cycle and settles shut, since nothing re-triggers it).

Both reuse existing `DoorState`s: 10 is seeded straight into `'hold'` (already "wait, then lower, then
stop"), 14 into a new `'holdClosed'` — the wait-at-the-*bottom* mirror of `'hold'`, which 16/76's
post-close wait also uses.

## Light changes

`LightChangeEffect` is the runtime-triggered counterpart to the sector-type blink patterns: those
assign an ongoing pattern once at map load, these mutate (or start animating) a *tag-matched* sector's
light on demand.

- `'setLevel'` (13/35/79/81/138/139) — a literal light value.
- `'brightestNeighbor'` (12/80) — vanilla's "bright = 0 means search" rule: the max level among
  immediate two-sided neighbors, or pitch black if there are none (`EV_LightTurnOn`).
- `'darkestNeighbor'` (104, `EV_TurnTagLightsOff`) — the min of the sector's own *current* level and
  its neighbors', which unlike `'brightestNeighbor'` never brightens, only darkens or leaves unchanged.
- `'startStrobe'` (17, `EV_StartLightStrobing`) — spawns the same slow, non-synced `blink1` pattern a
  sector-type-3 sector gets at load, skipped if the sector already has an active mover (vanilla's
  `specialdata` guard — light thinkers and movers share that slot in real vanilla; this engine's
  `lightStates`/`movers` maps are already independent, but the *trigger* still respects the guard).

Because any of these can target a sector that was never a light-pattern sector, `indexLightGeometry` —
previously scoped to just the load-time blink sectors — now indexes every sector's static-batch
occluders/flats unconditionally, a one-time load cost. **Still static-batch only**, the same
pre-existing limitation the blink feature had: a sector that's also a mover has its geometry in its own
per-mover mesh, out of `recolorSector`'s reach.

## The donut

Special 9 (`DonutEffect`) is `EV_DoDonut`: the tagged sector (the "hole") lowers while a second sector
surrounding it (the "ring") rises, both toward a *third*, outer sector's floor height, with the ring
additionally taking that outer sector's floor texture on arrival (the same deferred-copy mechanism as
`lowerAndChange`).

Neither the ring nor the outer sector is tag-matched — both are discovered dynamically by walking
neighbors outward from the hole (`triggerDonut`/`neighborSectorIndices`, mirrored at load time in
`computeMovableSectors` so the ring's geometry is pulled out of the static batch too), which is exactly
as arbitrary as vanilla's own search (whichever neighbor happens to be first in the sector's line list
— reproduced by walking `map.linedefs` in ascending index order, matching `P_GroupLines`).

**One vanilla wrinkle is deliberately not reproduced**: the real `EV_DoDonut` excludes "the line
leading back to the hole" via `!s2->lines[i]->flags & ML_TWOSIDED`, which — due to C operator
precedence (`!` binds tighter than `&`) — always evaluates to zero, so that check is dead code and
vanilla's two-sidedness filtering silently never fires. This engine does the check *correctly*, since
blindly porting the bug risks dereferencing a one-sided line's absent back sector. Checked against the
two real donut sectors in the shipped IWADs (E1M2 tag 8, E2M2 tag 1; DOOM2.WAD has none) — both
resolve to sane, non-degenerate ring/outer sectors.

## Damage floors

`SECTOR_DAMAGE_SPECIALS` is vanilla's `P_PlayerInSpecialSector`: nukage (7, 5 HP), hellslime (5,
10 HP), super hellslime (16, 20 HP) and strobe-hurt (4, 20 HP), all every `DAMAGE_FLOOR_INTERVAL`,
plus E1M8's finale special (11, 20 HP, which also ends the level once it drops the player to 10 HP or
below — vanilla's inline `G_ExitLevel()` in that same case).

**Player-only**, matching vanilla, which passes a `player_t*` and never damages monsters this way.
Dealt directly in `game/sectoreffects.ts: SectorEffects.update` rather than through `SpecialsController` — a damage
floor has no mover, nothing for that machinery to own, just `sector.special` plus the player's live
position, so it's checked once a frame off `World.sectorAt`. That same method also covers special 9
(§ Secret sectors below) — both are cases of the one vanilla switch this method reimplements.

Gated on `player.z === sector.floorHeight` (vanilla's `mo->z != sector->floorheight` guard, skipping a
player still falling in) — deliberately the *local* 2D-position sector's own floor, **not**
`World.groundFloor` (which reads a straddled ledge's higher side), so standing on a ledge next to a
damage pit doesn't damage the player until they step down into it.

Special 4 is *also* one of the sector-type light-blink specials: vanilla spawns the same non-synced
fast strobe sector type 2 gets and then explicitly restores `sector->special = 4` so the damage check
still sees it. This engine never clears `sector.special` after seeding a light pattern in the first
place, so 4 living in both tables works without reproducing that restore step.

A radiation suit gates the damage per type (`DamageFloorEffect.suit`, `game/sectoreffects.ts: suitBlocks`) exactly as
`P_PlayerInSpecialSector` does — see the powerups doc for why the five types don't all treat it the
same.

E1M8's finale is actually two mechanisms working together: § Boss death below is what lowers the
tag-666 floor that exposes this special-11 pit in the first place; this section is just what happens
once the player steps down into it.

## Secret sectors

`sector.special === 9` is vanilla's "SECRET SECTOR" — handled in the same `case` statement as the
damage floors above, by the same `game/sectoreffects.ts: SectorEffects.update`, under the same
`player.z === sector.floorHeight` guard. Entering it increments `SectorEffects.secretsFound` and clears
`sector.special` back to 0, matching vanilla's own `case 9: player->secretcount++; sector->special =
0;` exactly — the clear is also what prevents a second frame from double-counting, no separate
"already found" flag needed. `SectorEffects.totalSecrets` is counted once per level load, straight off
`map.sectors`, mirroring vanilla `P_SpawnSpecials`' own `case 9: totalsecret++`. See docs/items.md §
Level stats for where these numbers surface on screen.

## Boss death

`A_BossDeath` (`p_enemy.c`) is the one special this engine drives from a monster's death rather than
a linedef or a sector type: once every monster of a specific doomednum is dead **and** on a specific
map, it fires a level-wide action. Confirmed directly against the real source (fetched from
`raw.githubusercontent.com/id-Software/DOOM`) rather than assumed, tracing both the top-of-function
map/type gate and the victory-section action switch:

| Map (lump name) | Dies | Action |
|---|---|---|
| E1M8 | Baron (3003) | tag 666, `lowerFloorToLowest` |
| E2M8 | Cyberdemon (16) | exit level |
| E3M8 | Spider Mastermind (7) | exit level |
| E4M6 | Cyberdemon (16) | tag 666, blaze-open door |
| E4M8 | Spider Mastermind (7) | tag 666, `lowerFloorToLowest` |
| MAP07 | Mancubus (67) | tag 666, `lowerFloorToLowest` |
| MAP07 | Arachnotron (68) | tag 667, `raiseToTexture` |
| any other episode's map 8 (e.g. SIGIL's E5M8) | any of the above five | exit level |
| every other map | — | nothing |

The last row is real, not a guess: vanilla's `switch(gameepisode)` has a `default` case with no
per-type check at all, only `if (gamemap != 8) return;` — an unrecognized episode's map 8 exits on
whichever of the five boss types happens to die last. `bossDeathTriggersFor` (`game/specials.ts`) is a
pure function of `map.name` (`E1M8`, `MAP07`, …) that reproduces this whole table, gating on the map's
own lump name rather than which WAD supplied it — a PWAD's own MAP07 gets DOOM2's exact Mancubus/
Arachnotron triggers, matching vanilla, which only ever looks at `gamemap`.

**Split across three files, the same "system reports, `game.ts` realizes" shape as
`onCrush`/`onExit`/`crossLines`:**

- `game/things.ts`'s `damage()` death branch is the only place that can answer "is this the last
  living one of its type" — it already has `posed` in scope, the same array the pain elemental's
  triple-spawn special-case reads. It reproduces vanilla's own thinker scan (`posed.every(q => q.type
  !== p.type || q.dead)`) and, if true, calls the optional `onBossDeath` callback `buildThingSprites`
  was given — the same "callback bundle" shape `sfx: SoundEmitter` already uses there, not a return
  value threaded back through `ThingUpdateResult`, since a death can happen from any of `game.ts`'s
  many `things.damage()` call sites, not just inside `update()`.
- `game/specials.ts`'s `SpecialsController.notifyBossDeath` owns the actual per-map table
  (`bossDeathTriggers`, resolved once from `map.name` in the constructor) and dispatches to either
  `onExit(false)` or a new `triggerTag(tag, kind)`. `triggerTag` reuses the existing
  `triggerFloor`/`triggerRaiseToTexture`/`triggerDoor` movers exactly as a linedef special would,
  scanning `map.sectors` for the tag directly since there's no triggering linedef to run
  `resolveTargets` on. `triggerFloor`'s `line` parameter is optional for exactly this caller — it's
  only ever dereferenced for `changeTexture`, which a boss-death `lowerFloorToLowest` never sets.
- `game.ts` holds the player-alive gate (vanilla's "make sure there is a player alive for victory"),
  since `playerDead` is `Game`'s own state — the callback passed into `buildThingSprites` just checks
  `!this.playerDead` before calling `this.specials.notifyBossDeath(type)`.

## Scrolling textures

`SCROLL_LINE_SPECIAL` = 48 (`occlusion.ts: TextureScroller`) is vanilla's `P_UpdateSpecials`: a linedef
with this special scrolls its front sidedef's texture 35 map-units/second (`FRACUNIT`/tic), forever, no
trigger, active from map load. Used surprisingly often in the stock IWADs (250 linedefs across both
games) for waterfalls, lava streams and conveyor-look walls.

Mechanically the same shape as `WallFader`/`FlatFader`: index the affected quads' vertex ranges once,
rewrite one attribute on them every frame — here the `uv` attribute's U component instead of vertex
alpha, computed from each quad's own texture width (`MaterialBank.size`) so a narrow texture's pattern
visibly cycles faster than a wide one for the same 35 units/sec, matching vanilla's offset-over-width
UV math.

`WallOccluder` gained `line`/`frontSide` fields (threaded through `mapmesh.ts`'s
`processLine`/`addTwoSidedSide`/`addWall`) so `TextureScroller` can find exactly the linedef's *front*
(vanilla's `sidenum[0]`) quad — the only side vanilla ever scrolls — among the batched geometry.
**Static-batch geometry only**, the same limitation `recolorSector`'s light changes accept. In practice
this never excludes anything real: a mapper only puts 48 on a decorative wall, never one whose sector
also needs to move.

The accumulated offset is wrapped to `[0, 1)` before being written into the single-precision `uv`
buffer, purely to avoid float32 precision loss over a long session — `RepeatWrapping` already renders
an unwrapped UV outside `[0, 1]` correctly, so the wrap isn't needed for correctness.

## Animated textures

`render/textureanim.ts: AnimatedTextures` is the other half of `P_UpdateSpecials` — the "ANIMATE
FLATS AND TEXTURES GLOBALLY" loop, as opposed to scrolling's line-special loop above. Nukage, lava,
water and blood flats and the fire/blood/rock wall patterns all cycle through a fixed sequence of
named frames forever, no trigger, from map load, at 8 tics/frame (`animdefs[]`, `p_spec.c` —
every entry happens to share that speed).

Vanilla's own comment on that table says the in-between frames are "all the flats/textures between
the start and end entry, in the order found in the WAD file," not a naming pattern — confirmed
necessary by entries like `FIREWALA..FIREWALL` and `FIRELAV3..FIRELAVA`, whose start/end names don't
even sort the way a digit sequence would. `GraphicsBank.textureNamesInOrder`/`flatNamesInOrder`
expose the same WAD-lump-order lists vanilla's own texture/flat tables are built from
(`readAllTextures`'s `Map` insertion order, and `flats`'s), so a sequence is resolved once at load
time by slicing between the start/end indices. A sequence whose start name isn't in the loaded WAD
set (an episode-exclusive animation in the wrong IWAD) is dropped entirely, matching vanilla's own
`R_CheckTextureNumForName`/`W_CheckNumForName` skip.

**No geometry work needed.** This engine already keys one material per texture *name*
(`MaterialBank`), and every quad using that name shares that one material's mesh
(`mapmesh.ts: BatchSet`) — so animating a name just means repointing its already-built material at a
different bitmap each tic (`MaterialBank.setFrame`), and every quad using it picks up the new frame
for free. `MaterialBank.has` gates this to names some batch actually uses, so an animation with no
on-screen name in the current map costs nothing beyond the initial WAD-order lookup.

**Per-frame offset is counted from the sequence's own start (`i` = 0 at the first name), not
vanilla's absolute internal texture-table index.** Real vanilla computes `pic = basepic +
((leveltime/speed + i) % numpics)` with `i` ranging over *absolute* texture indices, so a sequence's
apparent starting phase depends on where its first texture happens to land in vanilla's internal
table — a WAD-load-order artifact, not something meaningful to reproduce (this engine doesn't build
that same absolute index space at all). Using the in-sequence offset instead changes only that
arbitrary phase, never the cycle rate or frame order, and both are equally arbitrary to a player with
nothing to compare against.
