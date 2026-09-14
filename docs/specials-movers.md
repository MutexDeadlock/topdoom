# Specials: the movers

`src/game/specials.ts`, `src/game/specials/defs.ts`, `src/game/specials/tables.ts`,
`src/game/specials/moverblocking.ts`, `src/game/specials/movergeometry.ts`

Doors, lifts, floors, ceilings, elevators and the donut: what each trigger builds, what a blocked
one does, and what a finished one becomes when triggered again. What dispatches them is
docs/specials.md; the crusher, the one family that grinds through a body rather than stopping for
it, is docs/specials-crushers.md.

Every mover here also makes noise, and *which* noise is part of the mechanism: docs/audio.md §
Specials has the per-mover rules, including the shared 8-tic grind clock and the silent crusher
(141), whose sound is the only thing distinguishing it from 25.

## Elevators

Boom's `EV_DoElevator`/`T_MoveElevator` (`p_floor.c`, linedefs 227-238): floor and ceiling move
in lockstep, preserving the sector's gap, at `ELEVATOR_SPEED` (4 u/tic), to the next floor up,
the next floor down, or the activating line's front-sector floor height (`elevateCurrent`). The
leading plane is checked against the blocking predicate first — ceiling leads going down, floor
leads going up — and a blocked leader stalls the pair; an elevator never crushes. `ElevatorMover`
is the one genuinely new mover kind of the Boom work (`sectorActive` treats it like a floor);
older builds' savegame readers have never seen its shape, which is fine in the direction
`SAVE_VERSION` tracks (new builds read all old saves).

## Retriggering a door

**A finished door is rebuilt, never reused.** `triggerDoor`'s split is vanilla's
`if (sec->specialdata) continue;`: a sector whose ceiling mover is still *moving* refuses the
trigger outright, and one whose door record has settled (`'open'`/`'closed'` — a thinker vanilla
would have removed) gets a **fresh mover carrying the new trigger's own mode, speed and wait**.
Keeping the record around is this engine's own bookkeeping, and it must not leak the spent
trigger's terms into the next one.

**Repro: EPIC.WAD MAP01, sector 168 (tag 30)** — the 8×8 pillar that seals alcove 167, leaving
28-unit gaps either side, narrower than the player. Line 1148 (W1 blazing close) shuts it; line 1166
(S1 open-stay) is the switch that reopens it. Reusing the close's record left the reopened pillar on
`closeOnly`, so it rose, sat out `DOOR_WAIT` and shut again a few seconds later — sealing in anyone
who had stepped through, with the one-shot switch already spent. The same reuse ran the reopen at
the *blazing* speed and sound the close line had asked for.

**A closing door heads straight down.** `EV_DoDoor`'s `close`/`blazeClose`/`close30ThenOpen` set
`direction = -1` at trigger time (`p_doors.c`), so `closeOnly` starts in `'lowering'` — it never
moves to the open height first, and never waits there.

**Only a repeatable raise press takes over a live door.** `EV_DoDoor` `continue`s past a moving
sector and reports nothing, which leaves an S1 switch unflipped and unspent for the next attempt.
`EV_VerticalDoor` is the one path that takes over a door already in motion, and Boom narrowed even
that to the **repeatable raise** numbers it names literally — 1/26-28/117 (`p_doors.c`, cph
2001/04/05).

That set is **enumerated, not inferred**: `DoorEffect.reverseWhenMoving` is set on those five table
entries (`raiseDoor` in `specials/tables.ts`) and nowhere else, because "manual and open-wait-close"
is not the same set — a generalized Push door (0x3C0F, say) is both, and still falls outside Boom's
switch. Everything not flagged is refused while the door moves; vanilla instead stacks a second
thinker on the sector, which is a leak this engine has no reason to reproduce.

It writes `door->direction` and nothing else — the running door keeps its own type, speed and wait:

| Door is | The press does |
|---|---|
| going down | back up |
| going up, or waiting at the top | straight down — shutting the door behind you |

**A monster only ever gets the first row.** `EV_VerticalDoor`'s second one is guarded by
`if (!thing->player) return;` — "JDC: bad guys never close doors" — so a monster pressed against an
open door leaves it open (docs/monster-ai.md § Opening doors).

**Both reversals are silent**, vanilla returning before its sound switch; the *automatic* close at
the end of the wait still announces itself from `tickDoor`. A press does not restart the wait, and
a door parked at the bottom on a delay timer (`'holdClosed'`, § Delayed doors) is left alone rather
than reproducing vanilla's reading of it — which restarts a `close30ThenOpen`'s 30s wait and bricks
a `raiseIn5Mins` outright.

**The rule is not the door's alone: `triggerLift` follows it too.** A `'rest'`ing lift is rebuilt
like a door rather than restarted in place, so `EV_DoPlat`'s `plat->low =
P_FindLowestFloorSurrounding` is re-read per trigger and each trigger runs at its own line's speed
and wait (`tests/game/lifts.test.ts`). That
leaves one invariant across every mover here — **`moverActive` false ⇒ rebuild from the new
effect** — whose only exceptions are the two vanilla itself makes: stasis (a lift or crusher frozen
by 54/89/57/74, where `specialdata` was never cleared) and the raise press above.

## Delayed doors

Two different vanilla mechanisms that both boil down to "wait, then move once, unprompted."

Line specials 16/76 (`DoorMode: 'closeThenOpen'`) close immediately, wait `DOOR_CLOSE_WAIT_SECONDS`
(30s) at the bottom, then reopen once to wherever they already were — confirmed against `p_doors.c`:
`door->topheight = sec->ceilingheight` at trigger time, unlike every other `DoorMode`, which
computes a fresh neighbor-ceiling target — and stay open for good.

Sector types 10/14 (`SECTOR_DOOR_SPECIALS`) skip the trigger entirely: a `DoorMover` is spawned
straight into `SpecialsController`'s constructor at map load, assumed already open (10, closes once
after 30s and stays shut) or already closed (14, opens once after `DOOR_RAISE_WAIT_SECONDS` = 5
minutes, then runs one ordinary open-wait-close cycle and settles shut, since nothing re-triggers
it).

Both reuse existing `DoorState`s: 10 is seeded straight into `'hold'` (already "wait, then lower,
then stop"), 14 into a new `'holdClosed'` — the wait-at-the-*bottom* mirror of `'hold'`, which
16/76's post-close wait also uses.

## Toggle plats

211 (SR) and 212 (WR), `EV_DoPlat(toggleUpDn)`: the floor snaps between its own height and its
ceiling — sealing the sector — and snaps back on the next activation. No travel time, no wait, no
sound at all; `EV_DoPlat` starts none for this type and `T_PlatRaise` skips both `pstop` calls.

**The instantness is emergent in vanilla, and explicit here.** `EV_DoPlat` sets
`low = ceilingheight`, `high = floorheight` and a *downward* direction — so `T_MovePlane`'s first
step is told to move down toward a destination *above* the floor, clamps straight to it and reports
`pastdest`. This engine's movers auto-direction toward their target instead (docs/specials.md §
Generalized linedefs lists that as a known divergence), so nothing would clamp; `LiftMover.instant`
says so outright rather than reproducing a sign trick that no longer has the same effect.

Each stroke parks in `'stasis'` with `stasisFrom` recording which way it went, and the next
activation **reverses** it — `plat->status = plat->oldstatus==up ? down : up`, not the plain resume
the perpetual family's stop line gets. That is the whole of the toggle.

Two consequences worth knowing:

- **A toggle plat always reports a hit.** `EV_DoPlat` sets `rtn = 1` unconditionally for
  `toggleUpDn`, before the per-sector loop — unlike `perpetualRaise`, whose stasis wake leaves `rtn`
  at 0. So an SR 211 flips its switch every press, including the presses that only woke something
  (docs/specials.md § A switch only flips when it acts).
- **It crushes rather than reversing.** `plat->crush = true` is set for this type alone, so
  `LiftMover.crush` takes it down the grind-through path instead of the immediate reverse every
  other blocked lift does (§ Every other mover stops instead). Because the move completes within
  the tic it starts, the damage lands on that same tic.

## Perpetual lifts and the stop line

Vanilla 53/87 (`p_plats.c: EV_DoPlat perpetualRaise`) bounce a lift between the lowest and
highest neighbor floor forever — plain `PLATSPEED` (a quarter of the downWaitUpStay lifts'
speed), waiting `PLATWAIT` at *both* ends, first direction random (`P_Random(pr_plats)&1`, 0 =
up). Both travel bounds are clamped to include the sector's own floor, and every ordinary lift's
down-target carries the same clamp (`plat->low > sec->floorheight` → own floor) — a down-stroke
never opens by jumping up. `LiftEffect.target` names the down-target (`LiftTarget`); Boom's
generalized lifts add `nextLowestFloor` and `lowestNeighborCeiling`, and `'perpetual'` is this
family.

54/89 (`EV_StopPlat`) freeze every tagged running lift in place: `LiftMover.state = 'stasis'`,
direction remembered in `stasisFrom` (vanilla `oldstatus`). Only a perpetual trigger wakes them —
`EV_DoPlat` calls `P_ActivateInStasis` for `perpetualRaise` alone — and the wake reports no hit,
the same `rtn` shape as restarting an in-stasis crusher (docs/specials-crushers.md § Crushers). A
lift saved mid-stasis restores mid-stasis: the new `LiftMover` fields are optional plain data like
every mover field.


## One-way ceiling movers

**A ceiling can move on its own** (`CeilingEffect`/`CeilingMover`), separately from a door's ceiling
raise or a crusher's cycle: once to a target and stop, no hold, no reversal.

Special 40 ("RaiseCeilingLowerFloor") is the one vanilla case that needs it — `raiseToHighest` — but
**this engine deliberately only implements 40's ceiling half, because real vanilla's floor half
never actually runs.** Tracing `EV_DoCeiling`/`EV_DoFloor`: both guard on the same per-sector
`specialdata` "already busy" pointer, `case 40`'s handler calls `EV_DoCeiling` before `EV_DoFloor`,
and since they target the same tag-matched sectors, `EV_DoCeiling` claims `specialdata` first — so
`EV_DoFloor` does nothing, every time.

Special 44/72 ("Ceiling Crush", `lowerAndCrush`) is the other user, lowering once to floor+8 and
stopping — and **despite the name it never deals crush damage**: `EV_DoCeiling`'s `switch` sets
`ceiling->crush = true` only for the *cyclic* crush types, and `lowerAndCrush` is a separate `case`
label positioned just past that assignment, so jumping to it skips the flag. Its `CeilingMover`
leaves `crush` unset, which is exactly what makes a lowering `CeilingMover` stop rather than grind
through anyone underneath; only Boom's generalized ceilings set it.

## Inverted plane moves

A floor or ceiling mover's direction is **fixed by its vanilla `EV_DoFloor`/`EV_DoCeiling` case, not
derived from the height it is chasing** — `FloorEffect.direction` and `CeilingEffect.direction`,
which `tables.ts` reads off the target name (every "lower" case runs -1, every "raise" one +1) and
Boom's generalized floors and ceilings take straight from their own direction bit. The two target
tables are separate and must stay so: `lowestNeighborCeiling` is a *raising* floor target
(`raiseFloor`) and a *lowering* ceiling one (Boom's `lowerToLowest`).

It only matters when the resolved target lands on the far side of that direction, and then it
matters a lot: `T_MovePlane`'s first step hits the `newheight < dest` branch — id's own comment
there reads *"reached dest, or start was below dest"* — clamps straight to the destination, reverts
the whole jump if a body no longer fits, and reports `pastdest`. So an inverted move happens **whole
or not at all**, in the tic it starts; it is never travelled at mover speed, and nothing standing
there is ever carried along. `tickFloor`/`tickCeiling` step along the mover's own `direction` for
exactly that reason rather than re-deriving one from the target each tick.

A ceiling reaches this more easily than a floor: `raiseToHighest` (40) on a sector already taller
than every neighbor, or Boom's `lowerToLowest` (199-206) on one already lower than every neighbor,
both resolve a target on the wrong side without anything degenerate in the map. **`ElevatorMover` is
the one plane mover deliberately left auto-directioning**, because for it the two models coincide —
`ElevatorMover`'s own doc has the argument.

Repro: `BOOMEDIT.WAD` MAP01 linedef 357, a WR 83 ("lower floor to highest floor") on
self-referencing sector 78, whose only real neighbor is a dummy sector 128 units *above* it. Travel
that gradually and the sector's lines — decoration around a cage in the middle of sector 84, drawn
as the enclosing sector (docs/render-bsp.md § Self-referencing sectors), so nothing on screen moves
— become an invisible rising platform that lifts the player into a 55-unit gap and wedges them
there.

## The turboLower quad

36/70/71/98 (`turboLower`) lower a floor to its highest neighbour and stop **8 short of flush** —
but the 8 is conditional, which is easy to drop and matters:

```c
floor->floordestheight = P_FindHighestFloorSurrounding(sec);
if (floor->floordestheight != sec->floorheight)
    floor->floordestheight += 8*FRACUNIT;      // p_floor.c, case turboLower
```

A sector already level with its highest neighbour therefore targets that height exactly, which is
its own — the mover is created and finishes at once. Adding the 8 unconditionally instead hands a
**lowering** mover a target *above* its floor, and the platform rises 8 units when the switch was
meant to drop it. That was the visible half of NoSp2.wad MAP04's switch on linedef 445 (the other
half is docs/world.md § Self-referencing lines, which is why the search returned the sector's own
height in the first place). Boom's *generalized* floors have no such offset at all — `FtoHnF` is
plain `highestNeighborFloor` — so this is confined to the four vanilla numbers.

## raiseToTexture, lowerAndChange

Both (30/96 and 37/84) are plain `FloorMover`s with trigger-time logic too specific for the
neighbor-height `MoveTarget` model every other floor family uses.

`raiseToTexture` rises by the shortest bottom-texture pixel height among the sector's neighboring
two-sided lines — checking *both* sidedefs of each line, not just the far side, confirmed against
`p_floor.c` — resolved via `MaterialBank.textureHeight`, which decodes (and caches) the full bitmap
just for its height; it fires rarely enough that a second header-only lookup path isn't worth it.

`lowerAndChange` searches the sector's own two-sided neighbors for the first whose floor already
sits exactly at the destination height, and copies *that* neighbor's floor texture and `special` — a
different texture-source rule from the `changeTexture` family, which always copies the triggering
*line's* front sector — and, confirmed against `T_MoveFloor`, applies it only once the mover
actually **arrives**, not at trigger time. `FloorMover.arrivalTexture` carries that pair from
trigger to whichever tick flips `state` to `'done'`.

## The donut

Special 9 (`DonutEffect`) is `EV_DoDonut`: the tagged sector (the "hole") lowers while a second
sector surrounding it (the "ring") rises, both toward a *third*, outer sector's floor height, with
the ring additionally taking that outer sector's floor texture on arrival (the same deferred-copy
mechanism as `lowerAndChange`).

Neither the ring nor the outer sector is tag-matched — both are discovered dynamically by walking
neighbors outward from the hole (`triggerDonut`/`nextSectorIndices`, mirrored at load time in
`scanSectors` so the ring's geometry is pulled out of the static batch too), which is exactly as
arbitrary as vanilla's own search (whichever neighbor happens to be first in the sector's line list
— reproduced by walking `map.linedefs` in ascending index order, matching `P_GroupLines`).

**One vanilla wrinkle is deliberately not reproduced**: the real `EV_DoDonut` excludes "the line
leading back to the hole" via `!s2->lines[i]->flags & ML_TWOSIDED`, which — due to C operator
precedence (`!` binds tighter than `&`) — always evaluates to zero, so that check is dead code and
vanilla's two-sidedness filtering silently never fires. This engine does the check *correctly*,
since blindly porting the bug risks dereferencing a one-sided line's absent back sector. Checked
against the two real donut sectors in the shipped IWADs (E1M2 tag 8, E2M2 tag 1; DOOM2.WAD has none)
— both resolve to sane, non-degenerate ring/outer sectors.

## Every other mover stops instead

**The vastly more common case genuinely does stop rather than clip through whoever's in its way** —
vanilla's `T_MovePlane`/`PIT_ChangeSector` "un-crush" rule for `crush==false`. Checked against the
real source: vanilla's per-tic mover code reverts that tic's step outright whenever it would leave a
thing with `ceilingheight - floorheight < thing->height`, unconditionally *unless* `crush==true` —
which in practice only the crushing-floor family sets.

Unlike vanilla, the door check applies uniformly regardless of speed — this engine has no separate
"blazeClose never reverses" door type to hook vanilla's one real exception on.

The rule covers a closing door (`tickDoor`), a lowering `crush: false` `CeilingMover` (real vanilla
never sets `crush=true` for this mover), a rising `LiftMover` and a rising
`crush: false` `FloorMover` (covering every ordinary raise, `raiseToTexture`, `lowerAndChange`, the
donut's ring, and stair builders — stairs never set `crush` either). Two `Occupancy` answers do it —
`game/specials/moverblocking.ts`'s `blocksCeilingLower`/`blocksFloorRise`. A *rising* `CeilingMover`
is deliberately not checked at all — it only ever opens headroom, and vanilla's ceiling-up code
never reverts on contact either.

**A rising floor measures every body — player and monster alike — against `World.groundCeiling`,
the lowest ceiling its *box* meets, never the rising sector's own ceiling.** `groundFloor` pins a
body straddling the sector's edge to the rising floor, so a lower-ceilinged neighbor its box still
overlaps is what would actually crush it. Without this the mover carries the body up into that
neighbor and pins it there — every step out reads blocked, and nothing ever reports `nofit`, so a
lift never reverses. Repro: GoingDown.wad MAP03, the lift in sector 67 rising flush with the
crawlspace ceiling in sector 7, with a demon on the lift's edge. `blocksFloorRise`'s cheap
pre-filter is therefore the lowest ceiling over `crushNeighborhood` (`lowestCeilingAround`), not
the sector's own gap.

A door reverses direction outright (it already has a `raising` state to fall back into); a
`CeilingMover`/`FloorMover` has none, so it skips that tick's step and retries the next — reading as
the mover stalling until the obstruction clears, the same practical result as vanilla's per-tic
retry. That covers `T_MoveFloor`/`T_MoveCeiling`, neither of which does anything with a `crushed`
result beyond letting the next tic retry.

**`LiftMover` is the one exception, and it does reverse**: `T_PlatRaise`'s own
`res == crushed && !plat->crush` branch sets `plat->status = down` (and plays `pstart`) the instant
a rise is blocked, rather than stalling — confirmed against `p_plats.c`. `tickLift`'s `'raising'`
branch mirrors this exactly: on `blocksFloorRise`, it flips `state` to `'lowering'` and plays
`pstart`, so a lift a body is standing under (or half-straddling into a lower-ceilinged neighbor —
see docs/movement.md § Collision's `groundCeiling`) backs off immediately instead of waiting at the
ceiling for them to move. A lowering `CeilingMover`/closing door stopped at their *own* obstruction
check still just stalls — this asymmetry (reverse vs. stall) is vanilla's own, not a simplification
here.

**Deliberately asymmetric, matching vanilla**: only the direction that closes the gap on someone is
ever checked (a closing door/lowering ceiling, a rising lift/floor). The opposite direction is left
unchecked, since `P_ThingHeightClip` rides a grounded thing along with a receding floor/ceiling
automatically, so that direction essentially never traps anyone.

**Both tests ask who is in the moving sector with `boxOverlapsSector`, never a bare `sectorIndexAt`
point test, and for every body — the player and each monster alike.** Walking up to a door leaves
the collision box straddling the frame — the same straddling `World.groundFloor` accounts for — so a
body's *center* still reads as the corridor's sector while the door sector, the one actually about
to close on it, is never checked at all. The candidates therefore come from `crushNeighborhood`,
exactly as `applyCrushDamage` takes them (docs/specials-crushers.md § Crushers).

**`crushNeighborhood` is every sector on a line within twice `WIDEST_BODY_RADIUS` of one of the
moving sector's own lines, not its adjacency.** A candidate is found by the sector under its
centre, and a strip narrower than a body's box puts that centre two sectors away while the box
still reaches the mover — the lift then carries it into the ceiling beyond the strip. Repro:
GoingDown.wad MAP03, the demon at (-569, -823) centred in sector 7, its box across the 8-unit
sector 304 onto lift 67 (`tests/regression/lift-carries-monster-into-neighbor.test.ts`). The same
set bounds every ceiling a box on the mover can meet, which is what `lowestCeilingAround` needs.
Vanilla reaches the same bodies through `P_ChangeSector`'s walk of the blockmap blocks over the
sector's bounding box widened by `MAXRADIUS` (`p_map.c`, `p_setup.c: P_GroupLines`).

**`boxOverlapsSector` is `World.sectorsTouching`** (docs/world.md § Sectors under a body), not a
sampling of the box. Sampling its eight corners and edge midpoints would step over any
sector narrower than the body's radius: GoingDown.wad MAP08's crate-lift is an 8-unit ring (sector
1) around its inner sector, and a demon beside it has every rim point land either outside the crate
or in the middle of it, so the lift would read as unobstructed and carry the demon up to be pinned
there. `tests/regression/mover-sector-narrow-strip.test.ts`.

Both take prospective heights as explicit parameters rather than reading `player.z`/`m.z`: the
caller is always asking about the height a boundary is *about* to move to, matching
`P_ThingHeightClip` re-syncing a grounded thing's `z` to the new floor before testing it.

## Movers simulate at the tic rate, draw interpolated

Doors, lifts, floors, ceilings and crushers write `sector.floorHeight`/`ceilHeight` once per
simulation tic — 35 Hz, the rate vanilla ran them at — and everything that *reads* those planes
(collision, `moverblocking`, saves) sees only tic-exact values. Their drawn geometry is refreshed
per frame at interpolated heights by `SpecialsController.drawMovers`; the window bookkeeping, the
map-write-and-restore trick, and which moves snap instead of glide are
docs/frameloop.md § Interpolation.

What that per-frame refresh is allowed to cost is a rendering matter, and it is a real constraint
on heavily scripted maps, where hundreds of sectors move at once — docs/render.md § Mover meshes.
