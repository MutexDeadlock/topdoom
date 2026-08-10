# Line and sector specials

`src/wad/specials.ts`, `src/game/specials.ts`, `src/game/specials/mapscan.ts`,
`src/game/specials/movergeometry.ts`, `src/game/moverblocking.ts`, `src/game/sectoreffects.ts`,
`src/game.ts`, `src/render/occlusion.ts`

**The three files.** `specials.ts` is `SpecialsController`: the movers, the trigger dispatch, the
switch flashes and the light thinkers — everything with runtime state. `specials/mapscan.ts` is the
load-time analysis of a map (`computeMovableSectors`, `findStairChain`, `bossDeathTriggersFor`, …),
pure functions of the `DoomMap` with no controller involved, which is why `mapmesh.ts` can call one
before the controller exists. `specials/movergeometry.ts` (`MoverGeometry`) is everything a height or
light change means for what is actually *drawn*: the per-sector mover meshes, their faders, and
`recolorSector`. The controller mutates `Sector` fields and tells `MoverGeometry` which sectors went
stale; it holds no THREE object of its own.

The vanilla-only line special table is confirmed against the Doom wiki's linedef type table **and,
where the two disagree, against the real `linuxdoom-1.10` source** — after a first pass briefly (and
wrongly) listed 174 as a vanilla S1 teleport, which is Boom-only. Same story for crusher stop: 58
looks like it could be a third stop-crusher alongside 57/74, but is an unrelated "floor up 24".
`wad/specials.ts`'s own table comments carry the full numbers-to-mechanism mapping.

**Use triggers fire on `Space` *or* the right mouse button**, the latter only while it is bound to
`use`, which is not the default (docs/menu.md § Right mouse button). `handleUseTrigger` asks
`Input.rightMousePressed('use')` rather than reading the setting, and both sources are edge-triggered,
so a held button activates a switch exactly once.

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
`CRUSH_DAMAGE_INTERVAL` (vanilla's 10 HP every 4 tics) to the player or any monster in their sector
that the current headroom doesn't fit (`sector.ceilHeight - sector.floorHeight` against
`PLAYER_HEIGHT`/`MONSTER_HIT_HEIGHT`), via `SpecialsController`'s `onCrush` callback into
`moverblocking.ts: applyCrushDamage` — the same "hand back a sector index, let someone else work out
who is standing in it" split as the two obstruction callbacks beside it, since `SpecialsController`
mutates geometry but has no idea where anyone is. `ThingLayer.
monstersInSector` finds candidates by comparing against the exact same mutable `Sector` object
reference `PosedThing.sector` was seeded from, the same trick `tryPickup`'s live-height read relies
on. The headroom gate matters even for someone in the mover's own sector footprint: standing under a
crusher parked at the top of its swing, or before it's descended far enough to reach you, must not
deal damage — `PIT_ChangeSector` (`p_map.c`) only damages a thing `P_ThingHeightClip` reports as not
fitting, never everyone the sector's blockmap iteration happens to touch.

**A barrel takes the same crush damage as a monster**, via `crushablesInSector` (`monstersInSector`
plus any living barrel in the sector) — vanilla's `PIT_ChangeSector` doesn't distinguish `MT_BARREL`
from any other `MF_SHOOTABLE` mobj, so a barrel under a crusher dies and explodes exactly as if it'd
been shot (docs/death.md § Exploding barrels covers the death→explode delay itself). The
headroom-blocked check other movers use (`game/moverblocking.ts`) deliberately stays on
`monstersInSector` alone — whether a barrel should also stall a closing door is a separate question
this change doesn't touch.

**Only a *lowering* `CrusherMover` deals damage, matching `T_MoveCeiling`** (`p_ceilng.c`): its raise
call always passes a hardcoded `crush=false` to `T_MovePlane` regardless of the mover's own crush
flag, so `P_ChangeSector`'s `crushchange` is false and the damage branch never runs on the way back
up, even while the gap is still too small. `tickCrusher` captures its direction before the tick's
move (and any end-of-travel state flip) and only calls `tickCrush` when that was `'lowering'`. The
`raiseFloorCrush` floor family has no such asymmetry — `T_MoveFloor` always passes the mover's real
`crush` flag regardless of direction, and a floor crusher only ever moves one way (up) per trigger
anyway — so `tickFloor` calls `tickCrush` unconditionally while `mover.crush` is set and moving.

**The damage pulse itself is one clock shared by every crushing mover on the map, not a per-mover
countdown** — `SpecialsController.crushDamageTimer`/`crushDamageDue`, computed once in `update` the
same way `moveSoundDue` already is for the shared grind sound (§ above this one, `MOVE_SOUND_INTERVAL`).
This reproduces vanilla's literal `leveltime&3` — one level-wide clock every crusher's
`PIT_ChangeSector` call checks, so two crushers running at once always pulse on the same tic. A
per-mover countdown, reset to `CRUSH_DAMAGE_INTERVAL` on each fire, was tried first and drifts out of
phase with the level's real tic count over a long-running crusher — caught by testing
`crusher_test.wad`'s WR fast crusher against GZDoom side by side, which came out one `CRUSH_DAMAGE` hit
lower than this engine over the same run.

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
`applyCrushDamage`, in the same file and directly below it, keeps the cheap point test on purpose —
a crusher's sector is typically the whole room, where the blind spot barely matters.

Both take prospective heights as explicit parameters rather than reading `player.z`/`m.z`: the caller
is always asking about the height a boundary is *about* to move to, matching `P_ThingHeightClip`
re-syncing a grounded thing's `z` to the new floor before testing it.

**`blocksFloorRise` also checks `World.groundCeiling` at the player's position**, beyond
`headroomBlocked`'s own-sector-only test — straddling half onto a rising lift/floor and half into a
static neighbor sector with a lower ceiling is a case `headroomBlocked` alone misses, since it only
compares against the *rising* sector's own ceiling and the neighbor's lower one never enters the
check. See docs/movement.md § Collision for `groundCeiling` itself.

## One mover per sector

**A sector already running a mover refuses every new trigger** — `SpecialsController.sectorActive`,
vanilla's `sec->specialdata`. `EV_DoFloor`, `EV_DoPlat`, `EV_DoCeiling`, `EV_DoDonut` and
`EV_BuildStairs` all `continue` past such a sector, so the second trigger does nothing at all rather
than replacing what's running. Every `trigger*` method asks before creating a mover.

"Active" is about *state*, not presence. Vanilla removes a thinker and clears `specialdata` the
instant it stops; this engine keeps the finished record in `movers` (a lift re-triggers off its own
`restHeight`), so `sectorActive` reads the state: a `'done'` floor/ceiling, a `'rest'` lift, a
`'stopped'` crusher and an `'open'`/`'closed'` door are all free to be triggered again. The two
re-triggers vanilla *does* honor are handled by their own callers before this is consulted — a door
reverses (`EV_VerticalDoor`) and a stopped crusher restarts (`P_ActivateInStasis`).

**Repro: DOOM2 MAP30's central pillar (sector 12, tag 2).** It carries two specials — a one-shot S1
switch (140, `plus512`) that raises it from −96 to 416 over 14.6 s, and its own four sides (62), a
repeatable lift. Using the lift while the switch's slow rise was still running replaced the
`FloorMover` with a `LiftMover` whose `restHeight` was captured from the *current* height, so the
pillar was stranded at whatever it had reached — around 128, the ledge with the radiation suits, for
a player who walks straight over after pressing the switch. The guard was previously per-mover-kind
and inconsistent: `triggerFloor` only refused another *floor*, and `triggerLift` refused nothing.

## Teleporters

39/97 for either the player or a monster; Doom II's 125/126 for monsters only. The destination is the
first doomednum-14 landing thing found inside a tag-matched sector (`findTeleportDestination`);
reaching it calls back into `game.ts` to move the player (`Player.teleportTo`) and snap the camera yaw
to match, same as the initial spawn.

**A crossing from the *back* of the line never teleports** — `EV_Teleport`'s own `if (side == 1)
return 0;`, commented there as "so you can get out of teleporter". Without it, stepping off the pad
you just landed on crosses that pad's own teleport line and bounces you straight back, forever.
Repro: freedoom2 MAP01's two-way pair, sectors 167 (tag 3) and 133 (tag 5), whose 97 lines all have
the pad on their back side; covered by `tests/regression/teleport-back-side.test.ts`.

The side is vanilla's `P_CrossSpecialLine` `side` argument, which `P_TryMove` fills with **`oldside`**
— the side the thing occupied *before* the move, not after — so `trigger`'s `fromBackSide` is computed
from `prevX`/`prevY` (the player) or `prev` (a monster), not the current position. Teleports are the
only consumer: tracing `P_CrossSpecialLine`, `side` reaches nothing but `EV_Teleport`, so no other
special is direction-gated this way. `handleUseTrigger`'s own front-side test is a separate vanilla
rule (`P_UseSpecialLine`) that happens to share `isFrontSide`.

**A blocked teleport still consumes a one-shot line.** Vanilla's `case 39` is
`EV_Teleport(...); line->special = 0;` — the clear is unconditional, so a W1 teleport crossed from
the back (or one whose tag matches no landing thing) is spent all the same, and `trigger` adds to
`usedOnce` before returning. The monster-only pair is the one exception: 125's clear sits *inside*
its `if (!thing->player)`, so a player walking one leaves it intact, which is why the `monsterOnly`
gate returns before the consume.

**Monsters cross walk triggers too**, via `crossMonster` — `ThingLayer` keeps each monster's own
`prevX`/`prevY` and hands the segment it just walked to a `crossLines` callback, the same "system
reports, `game.ts` realizes" shape as `fogAlphaOf` and the crush callback. Vanilla runs
`P_CrossSpecialLine` for *any* thing but gates non-players to a very short allow-list, reproduced
verbatim as `MONSTER_CROSSABLE`: 39/97/125/126 (teleports), 4 (raise door) and 10/88 (the two
down-wait-up-stay lifts). Everything else — exit lines, stair builders, most doors and floors — does
nothing under a monster's feet, which is why a level's monsters can't wander around rearranging its
geometry. **125/126 are the monster-only pair**: vanilla lists them *only* in the non-player branch,
so a player walking one does nothing, which is what makes the classic monster-closet setup work.

The lookup around a monster is **radius-bounded** at `MONSTER_CROSS_RADIUS` (136) — the widest body
in the game, the spider mastermind's 128, plus slack. A monster wider than that would start missing
its own walk triggers, silently, so the constant is coupled to the widest `MONSTER_STATS.radius`
rather than being free.

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
`ThingLayer` — the pair comes from `SpriteFxLayer.spawnTeleportPair` (game/spritefx.ts), which owns the
20-unit offset so the player's trip and a monster's can't drift apart; only the landing `z` differs
between the two callers, and each passes its own. Each puff is a transient `OneShotEffect` playing
through the `TFOG` sprite's frames (`A`-`J`, confirmed against the actual
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
occluders/flats unconditionally, a one-time load cost.

### Relighting mover geometry

`recolorSector` (`specials/movergeometry.ts`) rewrites the RGB of every surface lit by a sector, in
two places: the static batches
(`sectorOccluders`/`sectorFlats`) and, via `recolorMoverGeometry`, any mover mesh holding that sector's
geometry. Both are needed because a mover mesh carries its own sector's flats **plus** wall quads from
*both* sides of every bordering line — so a sector that moves, and a static sector next to one, each
have geometry that `indexLightGeometry` cannot see. `moverLightTargets` (filled in `createMoverMesh`
from each quad's/fan's own `sector` field) is the sector → owning-mover-meshes index that makes the
second pass cheap; a rebuild never changes which sectors a mesh covers, so it only grows once.

The invariant: **a sector's light must reach its geometry whether or not that geometry is currently in
a mover mesh.** Without the mover pass a strobing lift only relights while it happens to be *moving* —
a height change rebuilds the mesh from the live `sector.light` anyway, which is exactly what masked the
bug. Repro: DOOM1 E1M5 sectors 2 and 32, the tag-1 strobing lifts (also E1M5 sector 91, tag 2), covered
by `tests/regression/strobing-lift-light.test.ts`.

This covers **every** light effect, since `updateLights` (all the sector-type patterns) and
`triggerLightChange` (the runtime line specials above) both funnel through `recolorSector` — and the
combination is not rare: 7 maps in DOOM1.WAD, 18 in DOOM2.WAD, 14 in Freedoom 2 and 8 in SCYTHE.WAD
have at least one light-driven mover, `glow` being the most common by a wide margin.

Only RGB is written (`setXYZ`); vertex alpha belongs to `WallFader`/`FlatFader` (render/occlusion.ts)
and the two must not clobber each other.

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
`map.sectors`, mirroring vanilla `P_SpawnSpecials`' own `case 9: totalsecret++`. See docs/hud.md §
Level stats for where these numbers surface on screen.

`update` reports the entry back to `game.ts` (`SectorEffectResult.secretFound`, true on that one
frame only) rather than just bumping the counter, because finding a secret also announces itself —
a center-screen message and `radio`, neither of which vanilla does. docs/hud.md § Center messages.
