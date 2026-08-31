# Line and sector specials

`src/game/specials.ts`, `src/game/specials/defs.ts`, `src/game/specials/tables.ts`,
`src/game/specials/mapscan.ts`, `src/game/specials/movergeometry.ts`,
`src/game/specials/moverblocking.ts`, `src/game/specials/sectoreffects.ts`,
`src/game/specials/forces.ts`, `src/game/specials/transfers.ts`, `src/game/voodoo.ts`,
`src/game.ts`, `src/render/occlusion.ts`

**The data half.** `specials/defs.ts` holds the shapes a special is expressed as — `SpecialDef`, the
`Effect` union, and the speeds/waits/damage amounts those carry. `specials/tables.ts` keys the
vanilla numbers onto them (`LINE_SPECIALS`, `SECTOR_LIGHT_SPECIALS`, `SECTOR_DAMAGE_SPECIALS`,
`SECTOR_DOOR_SPECIALS`). Neither reads a WAD: the linedef numbers are the only WAD-side thing about
them, which is why they sit under `game/` with the controller that drives them rather than in
`wad/`.

**The three files.** `specials.ts` is `SpecialsController`: the movers, the trigger dispatch, the
switch flashes and the light thinkers — everything with runtime state. `specials/mapscan.ts` is the
load-time analysis of a map (`scanSectors`, `findStairChain`, `bossDeathTriggersFor`, …), pure
functions of the `DoomMap` with no controller involved, which is why `mapmesh.ts` can call one
before the controller exists. `specials/movergeometry.ts` (`MoverGeometry`) is everything a height
or light change means for what is actually *drawn*: the per-sector mover meshes, their faders, and
`recolorSector`. The controller mutates `Sector` fields and tells `MoverGeometry` which sectors went
stale; it holds no THREE object of its own. That split is in the constructors too: `SpecialsOptions`
**extends** `MoverGeometryOptions`, so the render half's needs are declared once, by the half that
consumes them, and the controller forwards its own options rather than restating six fields.

That mutation is direct — `Sector.floorHeight`/`ceilHeight`/`light` change on the `DoomMap` itself,
and `World` never caches them, so collision, sight-blocking and resting heights pick a mover's
change up on their very next query with no invalidation step. The controller also has no idea who is
standing where: exits and teleports reach `game.ts` through callbacks (`onExit`/`onTeleport`), and
crush damage and obstruction go through `Occupancy` (`game/specials/moverblocking.ts`) — the layer's
own tests, over the bodies `game.ts` hands it as `SpecialsOptions.occupants`. And a stair builder is not its
own mover type: each step is a plain `FloorMover` rising to a fixed height, over the chain of
sectors `findStairChain` discovered at load time by the same texture-matched adjacency walk
vanilla's `EV_BuildStairs` does at runtime.

The vanilla-only line special table is confirmed against the Doom wiki's linedef type table **and,
where the two disagree, against the real `linuxdoom-1.10` source** — after a first pass briefly (and
wrongly) listed 174 as a vanilla S1 teleport, which is Boom-only. Same story for crusher stop: 58
looks like it could be a third stop-crusher alongside 57/74, but is an unrelated "floor up 24".
`specials/tables.ts`'s own table comments carry the full numbers-to-mechanism mapping.

**Use triggers fire on `Space` *or* the right mouse button**, the latter only while it is bound to
`use`, which is not the default (docs/menu.md § Right mouse button). `handleUseTrigger` asks
`Input.rightMousePressed('use')` rather than reading the setting, and both sources are
edge-triggered, so a held button activates a switch exactly once.

Every mover here also makes noise, and *which* noise is part of the mechanism: docs/audio.md §
Specials has the per-mover rules, including the shared 8-tic grind clock and the silent crusher
(141), whose sound is the only thing distinguishing it from 25.

## Scope

**Every vanilla DOOM/DOOM2 linedef and sector special is covered; Boom compatibility is being
added on top.** The vanilla table's gaps were closed by diffing every case in
`P_CrossSpecialLine`/`P_UseSpecialLine` against its keys, directly against
`p_spec.c`/`p_switch.c`/`p_floor.c`/`p_plats.c`/`p_ceilng.c`/`p_doors.c`/`p_lights.c` rather than
assumed. That audit is what turned up `raiseToTexture`, `lowerAndChange`, the one-way
`CeilingEffect`, the delayed doors, the instant `LightChangeEffect`s and the donut — each needing a
genuinely new mechanism, all now modelled. Three vanilla gaps it *missed* were found during the
Boom work — the perpetual plats and plat-stop family (53/54/87/89, see § Perpetual lifts and the
stop line), the S1/SR ceiling-to-floor pair (41/43, `EV_DoCeiling(lowerToFloor)`), and the WR
lower-floor 83 (surfaced by BOOMEDIT.WAD through the coverage report below) — all closed, and the
table is now pinned to be exactly the union of the three vanilla dispatch switches' 138 case
numbers (`tests/game/boom-specials.test.ts`).

Boom's extended non-generalized numbers live in **`BOOM_LINE_SPECIALS`**, a separate table merged
by `lookupSpecial`, each entry transcribed from the Boom dispatch switches. Two genuinely new
mechanisms came with them: **elevators** (227-238, § Elevators) and the **motionless change**
(78/153/154/189/190/239-241, `EV_DoChange`) — each tagged sector instantly copies floor flat and
special from its model (trigger = the line's front sector; numeric = the first neighbor at the
sector's own floor height, nothing when no neighbor matches — though the activation still counts,
so switches flip, vanilla's own `rtn = 1`). Change-only sectors are included in
`scanSectors`' movable set despite never moving: the flat swap needs a per-sector mesh to repaint.

Boom's **parameter lines** are the other family, and they sit outside `LINE_SPECIALS` on purpose:
they configure a permanent property at level spawn rather than being dispatched from a trigger, so
`lookupSpecial` returns null for every one. Two modules own them: `specials/forces.ts` the ones that
change how things *move* — scrollers and conveyors, friction and the pushers (§ Scrollers and
conveyors, § Friction, § Pushers), which bring voodoo dolls with them (§ Voodoo dolls) — and
`specials/transfers.ts` the ones that change how a sector is *drawn* (§ Render transfers).
`PARAM_LINE_SPECIALS` is the union, and every number in it is implemented.

**One number is settled as a no-op rather than implemented.** MBF's sky transfer (271 regular,
272 flipped — `p_spec.c`, killough 10/98) points every tagged sector's sky at the transfer line's
own sidedef texture. This engine draws no sky at all: an `F_SKY1` ceiling is simply not built
(`SKY_FLAT` in `wad/map.ts`, docs/render.md § Mesh building), so the transferred texture could
never be seen. `NOOP_LINE_SPECIALS` holds those numbers, and they classify as `noop`. Real WADs do
use it: `literalism.wad` carries 271 on twelve of its maps, up to 107 lines on one, which is how it
surfaced.

**There is no "deferred" bucket, deliberately.** One existed while the Boom work was in phases and
was retired empty when they finished: a number whose mechanism simply hasn't been built classifies
as `unknown` and fails the gate, which is the whole point of the gate. `noop` is not a softer
`unknown` — it is the claim that the number is *settled*, and it costs a paragraph here saying why
each entry can never be seen.

`scripts/inspect-wad.ts` prints a **specials coverage report** — every linedef special classified
vanilla / boom / generalized / param (spawn-time) / no-op / UNKNOWN, and sector specials checked
through `decodeSectorType` — the acceptance gate the Boom work was accepted against, beside lines
counting the scrollers, conveyors, friction sectors, pushers and dolls the level spawned and the
render transfers it carries. **Nothing lands in UNKNOWN** on the WADs checked so far: every Boom
linedef number this engine can meet either resolves to something or is a settled no-op.

## Elevators

Boom's `EV_DoElevator`/`T_MoveElevator` (`p_floor.c`, linedefs 227-238): floor and ceiling move
in lockstep, preserving the sector's gap, at `ELEVATOR_SPEED` (4 u/tic), to the next floor up,
the next floor down, or the activating line's front-sector floor height (`elevateCurrent`). The
leading plane is checked against the blocking predicate first — ceiling leads going down, floor
leads going up — and a blocked leader stalls the pair; an elevator never crushes. `ElevatorMover`
is the one genuinely new mover kind of the Boom work (`sectorActive` treats it like a floor);
older builds' savegame readers have never seen its shape, which is fine in the direction
`SAVE_VERSION` tracks (new builds read all old saves).

Every trigger path resolves a line's number through **`lookupSpecial` (`specials/tables.ts`)**,
never by indexing `LINE_SPECIALS` directly — that is the seam where Boom's extended numbers and the
generalized bitfield ranges join without reshaping the vanilla table (which stays exactly as
audited, one entry per vanilla number). `PARAM_LINE_SPECIALS` sits beside it: the numbers that are
*not* triggerable effects but level-spawn parameters (vanilla 48's scroll, Boom's scrollers,
friction and pushers in `specials/forces.ts`; the render transfers in `specials/transfers.ts`),
listed so a coverage report can tell "known, handled elsewhere" from "unknown number". Boom
behaviors are confirmed against the boom202 / PrBoom+ source the same way vanilla ones are confirmed
against `linuxdoom-1.10`.

**Activation is data plus an activator.** A def says who a number admits (`monsterActivate` for
walk lines — vanilla `P_CrossSpecialLine`'s seven-number monster allow-list, and Boom's
generalized trigger bit — and for the `use` lines a blocked monster pushes, vanilla
`P_UseSpecialLine`'s own allow-list; `monsterCanTrigger` for shoot lines — vanilla's lone
`case 46`), and the trigger paths say who is at the line (`Activator`, `'player' | 'monster'`, with
Boom's voodoo dolls to join). All walk crossings — player and monster — run through one scan,
`SpecialsController.crossLines`.

## The use trace

`handleUseTrigger` is `P_UseLines` plus `PTR_UseTraverse`: a segment `USE_RANGE` (64 units) long
out of the player's own position along their facing, against **every** linedef it crosses, nearest
first. What each line does to the trace is the whole rule, and the two branches are vanilla's:

- **No special.** `P_LineOpening`'s range decides: a gap the player could stand in
  (`World.openingInto`, `top > bottom`) lets the press carry on to what is behind, anything shut —
  a one-sided wall, a closed door, a floor raised to the ceiling — stops the press dead and grunts
  `noway`. A two-sided line is *not* an opening by virtue of being two-sided: EPIC.WAD MAP01's
  linedef 1105 is a raisable wall whose sector sits at floor 16 = ceiling 16, and before this was
  modelled a press went straight through it into the SR lift switch (linedef 1110) behind, which
  the map means to be reachable only once the wall is down. `LF.BLOCKING` is not consulted — a
  fence or grate over a real opening passes the trace, as it does in vanilla.
- **Any special at all.** The line stops the trace whether or not it fires, so a walk-only number,
  a line met from its back side (§ A `use` trigger only fires from the front, docs/items.md) and a
  switch whose `EV_` helper refused all shadow what is behind them exactly as a switch that worked
  does. It fires only if it is a `use` special *and* the player is on its front side.

**PASSUSE (Boom)** is the one exception to the second branch: a special line carrying `LF.PASSUSE`
lets the trace continue past it, so several stacked specials fire from one press. The vanilla
nearest-special-shadows-everything behavior is the flagless case.

## A switch only flips when it acts

`P_ChangeSwitchTexture` is one operation doing two things — flipping the sidedef to its on-texture
*and*, for a one-shot line, clearing `line->special` so it can never fire again. So the flip, the
`swtchn` click and `usedOnce` all move together in `trigger`, and either all happen or none do.

**`P_UseSpecialLine` calls it inside `if (EV_…)`.** A switch whose EV_ helper returned 0 — every
tag-matched sector already busy, a donut with no ring, a stair chain that couldn't start — is left
untouched and unspent, so the player can press it again once whatever was in the way has finished.
Getting this wrong is worse than a cosmetic bug: an S1 switch consumed by a press that did nothing
is dead for the rest of the level, and on a map where it is the only way to raise a floor or open a
crusher, the level is unfinishable.

The exceptions are exact, not approximate, and `SWITCH_ALWAYS_FLIPS` (`game/specials.ts`) is the
whole list:

- **11 and 51**, the two exits, and **138/139**, the two light switches — vanilla calls
  `P_ChangeSwitchTexture` outside the `if` for these four and nothing else.
- **Manual doors** (1/26/27/28/31–34/117/118), which go through `EV_VerticalDoor` and never reach an
  EV_ return in the first place.
- **Walk and shoot triggers**, unconditional in both `P_CrossSpecialLine` (`line->special = 0` sits
  after the EV_ call, never inside a test) and `P_ShootSpecialLine` (all three of 24/46/47 flip
  unconditionally — this one is worth reading in the source before "fixing", since it looks like an
  oversight and is not).

**The flip is permanent unless the switch is repeatable.** `P_ChangeSwitchTexture`'s second argument
is `useAgain`, and it does two things with it: `if (!useAgain) line->special = 0` spends a one-shot
line, and `if (useAgain) P_StartButton(..., BUTTONTIME)` starts the 35-tic timer that flips the art
*back*. So only an SR/WR switch reverts, so it can visibly be pressed again; an S1/W1 switch is
given no button at all and shows its pressed art for the rest of the level. Running the revert timer
on every switch — which this engine did — makes every one-shot switch in the game flick green and
back to red a second later. `flashSwitch` takes `useAgain` for exactly this.

That also means `switchFlashes` is no longer the full set of pressed switches, which the savegame
restore has to account for: it re-applies on-textures from `switchFlashes` **and** `usedOnce`, since
a permanently-flipped switch has no timer to be found under. (A `usedOnce` line with no switch art —
most of them, all the walk triggers — resolves to no entries and costs nothing.)

Each `trigger*` method therefore returns its EV_ helper's `rtn` rather than `void`: **true only for
a sector that actually took the effect**, which for most of them is exactly
`!sectorActive(sectorIndex)` — vanilla's `rtn = 1` and its `if (sec->specialdata) continue;` are the
same test read two ways. The crusher is the one that isn't; see § Crushers.

## Crushers

Start 6/25/49/73/77/141, stop 57/74. Pure ceiling geometry: repeatedly lower to floor+8, reverse,
return to the sector's *own* start height (not neighbor-derived, unlike a door's open height),
forever, with no hold/rest state.

They — and the vanilla `raiseFloorCrush` floor family (55/56/65/94) — deal `CRUSH_DAMAGE` every
`CRUSH_DAMAGE_INTERVAL` (vanilla's 10 HP every 4 tics) to the player or any body the moving plane
has left without the headroom to stand in, via `Occupancy.crush` into
`specials/moverblocking.ts: applyCrushDamage` — the same "start from a sector index, work out who is
standing in it" split as the two obstruction tests beside it, since
`SpecialsController` mutates geometry but has no idea where anyone is. The headroom gate matters
even for someone in the mover's own sector footprint: standing under a crusher parked at the top of
its swing, or before it's descended far enough to reach you, must not deal damage —
`PIT_ChangeSector` (`p_map.c`) only damages a thing `P_ThingHeightClip` reports as not fitting,
never everyone the sector's blockmap iteration happens to touch.

**"Doesn't fit" is each body's own clipped headroom, not the crushing sector's gap under its centre
point.** `P_ThingHeightClip` re-runs `P_CheckPosition`, so a body's `ceilingz`/`floorz` come from
every two-sided opening its *box* spans — which is `World.headroom(x, y, radius)` here — and are
compared against its own `mobjinfo.height` (`PLAYER_HEIGHT` for the player and for a voodoo doll,
which is a player mobj). A body straddling the crushing sector's edge is therefore crushed by it,
and must be: the movement code has always pinned it (`positionBlocked` is box aware,
docs/movement.md § Collision), so measuring damage from the centre point alone left it frozen under
a grinding ceiling taking nothing — no flinch, no pain sound, no death. **Repro: NoSp2.wad MAP04**,
whose crusher room is two sectors, 198 (tag 84) and 141, with identical heights: two thirds of the
cybruisers penned there stood at the join and survived stroke after stroke.
`tests/regression/crush-straddling-body.test.ts`.

Membership in the crushing sector is still required — the eight-point `boxOverlapsSector` sampling —
so a body squeezed by something else next door is that mover's business, not this one's. Its
candidates are `ThingLayer.crushablesInSectors` over the crushing sector *and its neighbors*
(`crushNeighborhood`), standing in for vanilla's walk of the blockmap blocks covering the sector's
bounding box; the layer finds them by comparing against the exact same mutable `Sector` object
references `PosedThing.sector` was seeded from, the same trick `tryPickup`'s live-height read relies
on.

**Every damage pulse also sprays blood**, `PIT_ChangeSector`'s `P_SpawnMobj(…, MT_BLOOD)` beside its
`P_DamageMobj` call — out of the body's middle (`z + height/2`), for the player as readily as for a
monster, and never on a tic that only measures `nofit`. Two departures, both narrow:

- **A barrel sprays nothing.** Vanilla checks no flag here, so its barrels do bleed; this follows
  `ThingLayer.bleeds` (`MF_NOBLOOD`) as ZDoom's `P_DoCrunch` does, so a barrel goes on taking a puff
  everywhere and blood nowhere (docs/combat.md § Blood).
- **A voodoo doll sprays nothing either**, where vanilla would spray at the doll: `dolls` carries no
  height to spray at, and a doll draws as nothing, so blood would appear in mid-air in an empty
  room.

**The splash is thrown, not placed.** `PIT_ChangeSector` gives it `(P_Random()-P_Random())<<12` of
horizontal momentum — `CRUSH_BLOOD_SPEED`, 15.9 units a tic at the extreme of the draw — and
`MT_BLOOD` carries no `MF_NOGRAVITY`, so it arcs out of the body's middle and falls to the floor
(`OneShotEffect.motion`, integrated under the same `GRAVITY` a corpse falls at). Without that the
spray hangs in mid-air at chest height for its whole 24 tics, which is what it looked like before.

It **sticks where it lands**, where vanilla goes on sliding it under `FRICTION`: nothing in this
layer collides with anything, so a sliding splash would slide through the wall it was sprayed
against. Landing also clears `motion`, so a splash costs its BSP descent only while it is in the
air.

**A barrel takes the same crush damage as a monster**, via `crushablesInSectors` (`monstersInSector`
plus any living barrel in those sectors) — vanilla's `PIT_ChangeSector` doesn't distinguish
`MT_BARREL` from any other `MF_SHOOTABLE` mobj, so a barrel under a crusher dies and explodes
exactly as if it'd been shot (docs/death.md § Exploding barrels covers the death→explode delay
itself). The headroom-blocked check other movers use (`game/specials/moverblocking.ts`) deliberately
stays on `monstersInSector` alone — whether a barrel should also stall a closing door is a separate
question this change doesn't touch.

**Only a *lowering* `CrusherMover` deals damage, matching `T_MoveCeiling`** (`p_ceilng.c`): its
raise call always passes a hardcoded `crush=false` to `T_MovePlane` regardless of the mover's own
crush flag, so `P_ChangeSector`'s `crushchange` is false and the damage branch never runs on the way
back up, even while the gap is still too small. `tickCrusher` captures its direction before the
tick's move (and any end-of-travel state flip) and only calls `tickCrush` when that was
`'lowering'`. The `raiseFloorCrush` floor family has no such asymmetry — `T_MoveFloor` always passes
the mover's real `crush` flag regardless of direction, and a floor crusher only ever moves one way
(up) per trigger anyway — so `tickFloor` calls `tickCrush` unconditionally while `mover.crush` is
set and moving.

**The damage pulse itself is one clock shared by every crushing mover on the map, not a per-mover
countdown** — `SpecialsController.crushDamageTimer`/`crushDamageDue`, computed once in `update` the
same way `moveSoundDue` already is for the shared grind sound (§ above this one,
`MOVE_SOUND_INTERVAL`). This reproduces vanilla's literal `leveltime&3` — one level-wide clock every
crusher's `PIT_ChangeSector` call checks, so two crushers running at once always pulse on the same
tic. A per-mover countdown, reset to `CRUSH_DAMAGE_INTERVAL` on each fire, was tried first and
drifts out of phase with the level's real tic count over a long-running crusher — caught by testing
`crusher_test.wad`'s WR fast crusher against GZDoom side by side, which came out one `CRUSH_DAMAGE`
hit lower than this engine over the same run.

**A descent that is actually crushing something drops to an eighth speed.** `T_MoveCeiling` sets
`ceiling->speed = CEILSPEED / 8` whenever `T_MovePlane` comes back `crushed`, and restores full
speed on reaching the bottom (`CrusherEffect.slowsWhenCrushing`, `CrusherMover.slowed`). This is not
a flourish — it multiplies the time a body spends under the descending ceiling, and so the damage
one stroke deals, **by eight**. Without it MAP06's crusher deals ~140 damage a cycle and a 500 HP
Hell Knight walks away from four of them; with it the stroke deals over 1000 and kills him on the
first, which is what vanilla and GZDoom both do. Three details are load-bearing:

- `crushed` and `pastdest` are mutually exclusive in `T_MoveCeiling` (the slowdown lives in the
  `else` of the `pastdest` test), so the tic that lands on the bottom restores full speed and must
  **not** re-slow. Damage still lands on that tic — `P_ChangeSector` runs either way.
- The slowdown is never lifted mid-stroke, only at the bottom. A crusher keeps grinding slowly for
  the rest of its descent even after whatever it caught is already dead.
- **`fastCrushAndRaise` (6/77) is excluded**, deliberately: `p_ceilng.c` lists only `crushAndRaise`,
  `silentCrushAndRaise` and `lowerAndCrush` in that switch, which is the whole reason the fast pair
  reads as fast. It is also why the bottom-of-stroke reset sits under `case crushAndRaise:` and the
  fast type falls past it.

Because the slowdown keys off `crushed` every tic while the damage is rationed on `leveltime&3`, the
`Occupancy.crush` carries both rates: it is asked every tic, returns whether anything is caught
(vanilla's `nofit`), and takes a flag for whether this tic is also a damage tic.

**A stop line freezes a crusher mid-stroke, and a restart resumes that direction.** 57/74
(`EV_CeilingCrushStop`) set vanilla's `direction = 0` — "in-stasis" — leaving the ceiling exactly
where it stands, after saving `olddirection`; `P_ActivateInStasisCeiling`, which every crusher
trigger runs before its own loop, puts that direction back. `CrusherMover.stoppedFrom` carries it.
Restarting a crusher stopped on its way *up* must not send it back down: that is a visible,
half-second-long wrong move on any map with a repeatable crusher trigger sharing a tag with a stop
line. `stoppedFrom` is optional, so a mover from a save written before it existed reads as
`'lowering'` — the old behavior — rather than breaking the save.

Two consequences worth knowing, both vanilla's:

- **Stasis never clears `sec->specialdata`**, so the restart is invisible to `EV_DoCeiling`'s `rtn`:
  `P_ActivateInStasisCeiling` runs, then the loop `continue`s past that same sector and returns 0. A
  switch that only *restarts* a frozen crusher therefore neither flips nor is spent (§ A switch only
  flips when it acts) — `triggerCrusher` returns `false` on that path on purpose.
- **A stop line is one-way for an S1 trigger.** Nothing else restarts a crusher, so a spent switch
  plus a crossed stop line leaves it parked for the rest of the level. **Repro: DOOM2 MAP06 sector
  115 (tag 13).** Its room has three openings and only the east one, line 303, carries the 74; enter
  from the south or west and the crusher keeps running, enter from the east and it freezes wherever
  it was — which reads as "the crusher went down, came back up and stayed up" if you cross during
  the up-stroke. The switch, line 587, is an S1 (49) and already spent. This is the map's own
  design, not a bug, and the report that chased it down is in the commit history.

The turbo-16 stair specials (100/127) are deliberately *not* included, even though the wiki names
them "...and Crush" — the actual `EV_BuildStairs` source never sets a crush flag on the floor movers
it spawns, so real vanilla turbo stairs don't crush either. Strictly, it never sets the field *at
all*: unlike `EV_DoFloor`, which opens with `floor->crush = false`, `EV_BuildStairs` leaves it
whatever the recycled zone block held (`Z_Malloc` does not zero). Treating it as false is what every
port does and what observed vanilla behavior shows; the point stands that nothing in the source ever
asks these stairs to crush.

**Nothing blocks a genuine crusher on contact**, matching the `crush==true` branch of `T_MovePlane`
exactly: it keeps hurting whoever's in the way every interval until they leave or die, rather than
stopping, reversing early, or getting stuck. That grind-through behavior is the part of the vanilla
feel that matters for a crusher reading as a hazard.

## Crushed corpses

`PIT_ChangeSector`'s first branch, ahead of every crush rule above: a **corpse** the moved plane
leaves without headroom is crunched to a pool of blood (`S_GIBS`, sprite `POL5`) instead of being
damaged, and never counts toward `nofit`. `squashCorpses` (`specials/moverblocking.ts`) is that
branch, over `ThingLayer.corpsesInSectors`/`crushCorpse`.

Three properties come from it running in `P_ChangeSector` rather than in the crush path:

- **Any mover squashes, not just a crusher** — an ordinary closing door or rising floor does it too.
  The call site is one loop over `SpecialsController.update`'s `dirty` set, which is already exactly
  the sectors whose plane moved this tic.
- **No damage clock.** It lands on the tic the plane reaches the corpse, not on `leveltime&3`.
- **A corpse never blocks or stalls the mover it is under**, in any direction — the branch returns
  before `nofit` is set.

**A corpse is a quarter of its living height** (`P_KillMobj`'s `target->height >>= 2`,
`CORPSE_HEIGHT_FRACTION`), so an imp's corpse squashes at a 14-unit gap where the live imp is caught
at 56. That fraction is the squish test's alone: corpses block nothing here, so nothing else needs a
corpse height.

Three deliberate departures from `PIT_ChangeSector`:

- **Radius and height are left alone** where vanilla zeroes both. Nothing here reads a corpse's
  radius for blocking, and zeroing it would leak into the nightmare respawn's fit test and into the
  corpse's own resting height. It also means an arch-vile raising a squashed corpse gets an
  ordinary monster rather than vanilla's radius-0, height-0 **ghost** — Boom's own fix
  (`p_enemy.c`, "fix Ghost bug"). `crushed` is cleared by both `reviveCorpse` and `respawnCorpse`.
- **Barrel debris is not squashed**, though vanilla's `health <= 0` branch catches it: it is a
  transient that removes itself a few tics later (docs/death.md § Exploding barrels).
- **The player's corpse is not squashed either.** It is `game.ts`'s `playerActor`, not one of
  `ThingLayer`'s bodies, and the player is looking at the death overlay by then
  (docs/death.md § Player death).

The pool is entered through `enterDeathPose`, the single owner of every death pose, so a save
restores holding it. `PosedThing.crushed` is a new `MONSTER_SAVE_KEYS` field defaulting to false —
absent from an older save, which reads back as an uncrushed corpse (docs/savegames.md § The format
and its version). A WAD set with no `POL5` art keeps the corpse it has rather than drawing nothing.

`CORPSE_GIB` (`things/tables.ts`) is that sprite and frame, **walked out of the state table** like
every other pose rather than transcribed — but reached by *name*, since no `mobjinfo` chain points
at `S_GIBS` and the walker over `MOBJ_INFO` never visits it. So a DEHACKED patch that repoints the
state moves the pool with it, and `resetDehacked` puts it back
(docs/dehacked.md § Frames).

## Every other mover stops instead

**The vastly more common case genuinely does stop rather than clip through whoever's in its way** —
vanilla's `T_MovePlane`/`PIT_ChangeSector` "un-crush" rule for `crush==false`. Checked against the
real source: vanilla's per-tic mover code reverts that tic's step outright whenever it would leave a
thing with `ceilingheight - floorheight < thing->height`, unconditionally *unless* `crush==true` —
which in practice only the crushing-floor family sets.

Unlike vanilla, the door check applies uniformly regardless of speed — this engine has no separate
"blazeClose never reverses" door type to hook vanilla's one real exception on.

`tickDoor` already had this for a closing door; the same rule now also applies to a lowering
`CeilingMover` (real vanilla never sets `crush=true` for this mover) and to a rising `LiftMover` or
`crush: false` `FloorMover` (covering every ordinary raise, `raiseToTexture`, `lowerAndChange`, the
donut's ring, and stair builders — stairs never set `crush` either). Two `Occupancy` answers do it —
`game/specials/moverblocking.ts`'s `blocksCeilingLower`/`blocksFloorRise`, both routed through the
shared `headroomBlocked` helper there. A *rising* `CeilingMover` is deliberately not checked at all
— it only ever opens headroom, and vanilla's ceiling-up code never reverts on contact either.

A door reverses direction outright (it already has a `raising` state to fall back into); a
`CeilingMover`/`FloorMover` has none, so it skips that tick's step and retries the next — reading as
the mover stalling until the obstruction clears, the same practical result as vanilla's per-tic
retry. That covers `T_MoveFloor`/`T_MoveCeiling`, neither of which does anything with a `crushed`
result beyond letting the next tic retry.

**`LiftMover` is the one exception, and it does reverse**: `T_PlatRaise`'s own
`res == crushed && !plat->crush` branch sets `plat->status = down` (and plays `pstart`) the instant
a rise is blocked, rather than stalling — confirmed against `p_plats.c`. `tickLift`'s `'raising'`
branch mirrors this exactly: on `blocksFloorRise`, it flips `state` to `'lowering'` and plays
`pstart`, so a lift a player is standing under (or half-straddling into a lower-ceilinged neighbor —
see docs/movement.md § Collision's `groundCeiling`) backs off immediately instead of waiting at the
ceiling for them to move. A lowering `CeilingMover`/closing door stopped at their *own* obstruction
check still just stalls — this asymmetry (reverse vs. stall) is vanilla's own, not a simplification
here.

**Deliberately asymmetric, matching vanilla**: only the direction that closes the gap on someone is
ever checked (a closing door/lowering ceiling, a rising lift/floor). The opposite direction is left
unchecked, since `P_ThingHeightClip` rides a grounded thing along with a receding floor/ceiling
automatically, so that direction essentially never traps anyone.

**`headroomBlocked` must test sector membership with `boxOverlapsSector`, not a bare `sectorIndexAt`
point test.** Walking up to a door leaves the collision box straddling the frame — the same
straddling `World.groundFloor` accounts for — so the player's *center* still reads as the corridor's
sector while the door sector, the one actually about to close on them, is never checked at all. A
plain point test was the original bug here. The overlap is approximated the way `FogOfWar` samples
polygons: the box's four corners and four edge midpoints, ample for a doorway-sized sector.
`applyCrushDamage`, in the same file and directly below it, is box aware for the same reason and
then some — it measures the body's whole clipped headroom (§ Crushers).

Both take prospective heights as explicit parameters rather than reading `player.z`/`m.z`: the
caller is always asking about the height a boundary is *about* to move to, matching
`P_ThingHeightClip` re-syncing a grounded thing's `z` to the new floor before testing it.

**`blocksFloorRise` also checks `World.groundCeiling` at the player's position**, beyond
`headroomBlocked`'s own-sector-only test — straddling half onto a rising lift/floor and half into a
static neighbor sector with a lower ceiling is a case `headroomBlocked` alone misses, since it only
compares against the *rising* sector's own ceiling and the neighbor's lower one never enters the
check. See docs/movement.md § Collision for `groundCeiling` itself.

## One mover per sector

**A sector already running a mover refuses every new trigger of the same class** — vanilla's
`sec->specialdata`, which Boom splits into three independent slots (`P_SectorActive`, `p_spec.c`).
`EV_DoFloor`, `EV_DoPlat`, `EV_DoCeiling`, `EV_DoDonut` and `EV_BuildStairs` all `continue` past a
busy sector, so the second trigger does nothing at all rather than replacing what's running. Every
`trigger*` method asks before creating a mover.

**The classes are floor, ceiling and lighting**, and only vanilla's `demo_compatibility` folds them
into one. `moverClass` (`game/specials.ts`) is the mapping, read off the C rather than inferred:

| Class | Slot | Kinds |
|---|---|---|
| floor | `floorMovers` | `FloorMover`, `LiftMover`, `ElevatorMover` |
| ceiling | `ceilingMovers` | `DoorMover`, `CeilingMover`, `CrusherMover` |
| lighting | `lightStates` | the blink patterns and `'startStrobe'` |

So a rising floor and a closing door can run on one sector at once, which real Boom maps rely on
and a single slot silently dropped. `floorActive`/`ceilingActive` are the two predicates.
**The elevator claims both** (`EV_DoElevator`'s own `if (sec->floordata || sec->ceilingdata)`); it
is stored in `floorMovers` alone and `ceilingActive` looks for it there, because one object in two
maps would `structuredClone` into two on save and then tick twice on restore.

`'startStrobe'` (17) checks the **lighting** slot — `EV_StartLightStrobing`'s
`P_SectorActive(lighting_special, sec)`, i.e. `lightStates` — so a sector with a door running is
free to start strobing. This engine previously checked the mover map there, vanilla's unified
behavior.

**Three numbers only work because of the split**: 151/166/186, Boom's "raise ceiling, lower floor",
are the only dispatch cases in the whole switch that call two `EV_` helpers (verified by scanning
`p_spec.c`/`p_switch.c` for multi-`EV_` cases — 40 is the only other, and see below). Their floor
half is dead under a unified slot and live under the split. `SpecialDef.secondEffect` carries it:
151 calls both unconditionally, 166/186 are `if (EV_DoCeiling(…) || EV_DoFloor(…))` and so run the
floor **only when no tagged sector could take the ceiling** — C's short-circuit, reproduced as
`onlyIfPrimaryFailed`. Each pass covers every target sector before the next begins, matching the
real order.

**Vanilla 40 is not one of them.** It looks identical, but Boom *deleted* its `EV_DoFloor` call
outside demo compatibility, having marked it `//jff 02/12/98 doesn't work` — so 40 is ceiling-only
in both eras, and § One-way ceiling movers still describes it correctly.

"Active" is about *state*, not presence. Vanilla removes a thinker and clears `specialdata` the
instant it stops; this engine keeps the finished record, so the predicates read the state: a
`'done'` floor/ceiling, a `'rest'` lift, a `'stopped'` crusher and an `'open'`/`'closed'` door are
all free to be triggered again — and being triggered again means being **rebuilt from the new
trigger's effect**, never resumed on the spent one's terms (§ Retriggering a door). The two
re-triggers vanilla *does* honor are handled by their own callers before this is consulted — a door
reverses (`EV_VerticalDoor`, § Retriggering a door) and a stopped crusher restarts
(`P_ActivateInStasis`).

**The savegame reads the class back off `mover.kind`, not off which field it arrived in.** A save
written before the split holds every kind in `SpecialsSnapshot.movers`; `ceilingMovers` is a new
optional field. Sorting on restore makes both shapes land correctly with no `SAVE_VERSION` bump —
docs/savegames.md § The format and its version.

**Repro: DOOM2 MAP30's central pillar (sector 12, tag 2).** It carries two specials — a one-shot S1
switch (140, `plus512`) that raises it from −96 to 416 over 14.6 s, and its own four sides (62), a
repeatable lift. Using the lift while the switch's slow rise was still running replaced the
`FloorMover` with a `LiftMover` whose `restHeight` was captured from the *current* height, so the
pillar was stranded at whatever it had reached — around 128, the ledge with the radiation suits, for
a player who walks straight over after pressing the switch. The guard was previously per-mover-kind
and inconsistent: `triggerFloor` only refused another *floor*, and `triggerLift` refused nothing.
The class split does not reopen this: `FloorMover` and `LiftMover` are both floor-class, so they
still contend for the one slot exactly as they did.

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

**The rule is not the door's alone: `triggerLift` follows it too.** A `'rest'`ing lift used to be
restarted in place, keeping the *previous* trigger's speed, wait and cached `downHeight`; it is now
rebuilt like a door, so `EV_DoPlat`'s `plat->low = P_FindLowestFloorSurrounding` is re-read per
trigger and a blazing line no longer runs at a slow line's speed (`tests/game/lifts.test.ts`). That
leaves one invariant across every mover here — **`moverActive` false ⇒ rebuild from the new
effect** — whose only exceptions are the two vanilla itself makes: stasis (a lift or crusher frozen
by 54/89/57/74, where `specialdata` was never cleared) and the raise press above.

## Teleporters

39/97 for either the player or a monster; Doom II's 125/126 for monsters only. Boom's fourteen
extra numbers share this machinery and every rule below, differing only in how they *arrive* —
§ Silent and line-to-line teleporters. The destination is the
first doomednum-14 landing thing found inside a tag-matched sector (`findTeleportDestination`);
reaching it calls back into `game.ts` to move the player (`Player.teleportTo`) and snap the camera —
both its yaw, to match the landing angle, and its follow point (`snapTo`), so the view cuts to the
destination instead of flying across the map after it: same as the initial spawn, and for the same
reason (docs/camera.md § The camera is simulation state).

**The arrival sets the body's height**, `EV_Teleport`'s own `thing->z = thing->floorz` — the floor
it lands on, not the one it left. Both landings do it: `Player.teleportTo` and `ThingLayer`'s
`arriveAt` (things.ts), the latter covering monsters, corpses and conveyor cargo. Without it a body
keeps the departure sector's height and gravity takes it down the difference, which for the usual
teleport ambush — a closet raised above the arena it feeds — reads as monsters dropping out of the
sky; covered by `tests/regression/teleport-arrival-height.test.ts`.

**A crossing from the *back* of the line never teleports** — `EV_Teleport`'s own `if (side == 1)
return 0;`, commented there as "so you can get out of teleporter". Without it, stepping off the pad
you just landed on crosses that pad's own teleport line and bounces you straight back, forever.
Repro: freedoom2 MAP01's two-way pair, sectors 167 (tag 3) and 133 (tag 5), whose 97 lines all have
the pad on their back side; covered by `tests/regression/teleport-back-side.test.ts`.

The side is vanilla's `P_CrossSpecialLine` `side` argument, which `P_TryMove` fills with
**`oldside`** — the side the thing occupied *before* the move, not after — so `trigger`'s
`fromBackSide` is computed from `prev` — the controller's own for the player, the one
`crossMonster`'s caller hands in for a monster — not the current position. Teleports are the only
consumer: tracing `P_CrossSpecialLine`, `side` reaches nothing but `EV_Teleport`, so no other
special is direction-gated this way. `handleUseTrigger`'s own front-side
test is a separate vanilla rule (`P_UseSpecialLine`) that happens to share `isFrontSide`.

**A blocked teleport still consumes a one-shot line.** Vanilla's `case 39` is
`EV_Teleport(...); line->special = 0;` — the clear is unconditional, so a W1 teleport crossed from
the back (or one whose tag matches no landing thing) is spent all the same, and `trigger` adds to
`usedOnce` before returning. The monster-only pair is the one exception: 125's clear sits *inside*
its `if (!thing->player)`, so a player walking one leaves it intact, which is why the `monsterOnly`
gate returns before the consume. **Boom's own numbers invert this** — theirs clear only on success
(`TeleportEffect.spendOnlyOnSuccess`), so the split is per number rather than a rule about
teleports.

**Monsters cross walk triggers too**, via `crossMonster` — `ThingLayer` keeps each monster's own
previous position and hands the segment it just walked to a `crossLines` callback, the same "system
reports, `game.ts` realizes" shape as `fogAlphaOf` and the crush callback. Vanilla runs
`P_CrossSpecialLine` for *any* thing but gates non-players to a very short allow-list, carried per
number as `SpecialDef.monsterActivate`: vanilla's 39/97/125/126 (teleports), 4 (raise door) and
10/88 (the two down-wait-up-stay lifts), plus Boom's whole silent-teleport family (207/208,
243/244, 262-269 — `p_spec.c`'s own list) and whatever a generalized line's monster bit permits.
Everything else — exit lines, stair builders, most doors and floors — does
nothing under a monster's feet, which is why a level's monsters can't wander around rearranging its
geometry. **125/126 are the monster-only pair**: vanilla lists them *only* in the non-player branch,
so a player walking one does nothing, which is what makes the classic monster-closet setup work.

**And monsters push `use` lines**, via `useMonster` — `P_Move`'s `spechit` pass, run when a chase
step is refused, which is how a monster opens the door it walked into. Which lines, and the three
rules that follow from being a monster rather than a player, are docs/monster-ai.md § Opening
doors; the door's own end of it is § Retriggering a door below.

The lookup around a monster is **radius-bounded** at `MONSTER_CROSS_RADIUS` (136) — the widest body
in the game, the spider mastermind's 128, plus slack. A monster wider than that would start missing
its own walk triggers, silently, so the constant is coupled to the widest `MONSTER_STATS.radius`
rather than being free.

A monster's teleport deliberately does **not** touch `lastTeleport` — that exists solely to reseed
the *player's* walk-trigger tracking — but it does get the same `TFOG` puff at both ends, since
vanilla spawns that for any thing that teleports.

**An arrival telefrags what is standing on the pad** (`P_TeleportMove`), and off MAP30 a monster's
arrival is *refused* by anything standing there instead — so `crossMonster` can return a landing
spot that `game.ts` then declines to move the monster to. The rules, and why the line is spent
either way, are in docs/death.md § Telefrag.

**`lastTeleport`**: teleporting moves the player an arbitrary distance in a single frame, which
breaks `SpecialsController`'s own walk-trigger detection. It tracks `prev` to know what segment
the player just crossed, and leaving that at the pre-teleport position would make the next
frame test a segment from the old spot all the way to the pad — long enough to cross, and wrongly
re-trigger, unrelated lines along the way. `lastTeleport` is set inside `trigger` and consumed at
the end of `update` to reseed `prev` from the destination.

Vanilla also spawns a one-shot `MT_TFOG` puff at both ends (where the player stood, and 20 units
ahead of the landing spot along its facing). That isn't a real map `Thing`, so it isn't modeled
through `ThingLayer` — the pair comes from `SpriteFxLayer.spawnTeleportPair` (game/spritefx.ts),
which owns the 20-unit offset so the player's trip and a monster's can't drift apart; only the
landing `z` differs between the two callers, and each passes its own. Each puff is a transient
`OneShotEffect` playing through the `TFOG` sprite's frames (`A`-`J`, confirmed against the actual
lump names, all rotation-0 so no facing logic is needed) once before removing itself. Map
transitions clear any still-active puffs explicitly, since a teleport onto an exit line could
otherwise leave one animating over the next level.

## Silent and line-to-line teleporters

Boom adds fourteen numbers to the four vanilla ones, along three independent axes carried as
optional fields on the *same* `TeleportEffect` — absent means the vanilla behavior, so 39/97/125/126
are untouched.

| Numbers | Trigger | Destination | |
|---|---|---|---|
| 207 / 208 / 209 / 210 | W1 / WR / S1 / SR | landing thing | silent |
| 243 / 244 | W1 / WR | linedef | silent |
| 262 / 263 | W1 / WR | linedef | silent, reversed |
| 264 / 265 | W1 / WR | linedef | silent, reversed, monster-only |
| 266 / 267 | W1 / WR | linedef | silent, monster-only |
| 268 / 269 | W1 / WR | landing thing | silent, monster-only |

**"Silent" is four things, not just the missing sound** (`p_telept.c: EV_SilentTeleport`): no `TFOG`
puff at either end, no `telept`, no reaction-time freeze, and — the part that actually matters — the
body is **rotated rather than aimed**. A loud teleport sets an absolute facing from the landing
marker and zeroes momentum; a silent one turns the body by the angle between the two ends and turns
its momentum with it, so walking through comes out walking. `TeleportDest.rotateBy` carries that
angle to the caller, which is what `Player.teleportTo` needs to rotate `velX`/`velY` instead of
clearing them. `TeleportDest.silent` carries the second difference: the height above the floor is
preserved for a body teleported mid-air (`z = thing->z - thing->floorz`, reapplied at the
destination, where loud `EV_Teleport` sets `thing->z = thing->floorz`). The offset is measured by
the two landings themselves — `Player.teleportTo` and `arriveAt` — and reapplied unclamped, as in
Boom, since the controller is never told the body's height. A silent arrival keeps `velZ` too, where
the loud one zeroes all three components.

**The camera turns by the same angle**, through `TopDownCamera.turnYaw` rather than a `yawDeg`
assignment, so the player's Q/E orbit survives the trip even if a step is still animating —
docs/camera.md § Camera orbit.

For the thing-destination kind the rotation is `srcLineAngle − markerAngle + 90°`, and vanilla's own
comment explains the right angle: walking *perpendicularly* across the teleporter line should exit
in the direction the marker points.

**The line-to-line kind never touches a marker.** Its tag names a two-sided **linedef**
(`linesByTag`, docs/world.md § The tag indexes — the first match that isn't the trigger line wins),
and the body keeps its proportional position *along* the entry line, re-laid onto the exit line and
turned by the angle between them. `reversed` (262-265) flips both the position and the turn, which
is what makes a pair read as one continuous doorway rather than a mirror. Two details are
load-bearing:

- **The landing floor is the higher of the exit line's two sectors** — vanilla's
  `sides[l->sidenum[stepdown]]`. That is exactly what `World.groundFloor` already returns for a body
  straddling a line, and the exit point sits a fraction of a unit off it against a 16-unit player
  radius, so the caller's own resting-height query lands on the same number and a preserved height
  above it needs nothing from the arrival.
- **The body must land on a specific side of the exit line** (`reverse || (player && stepdown)`), or
  it oscillates back through the teleporter it just came out of. Vanilla settles this with a loop
  nudging up to `FUDGEFACTOR` = 10 *fixed-point* units — 10/65536 of a map unit — to correct a
  rounding error its own `FixedMul` interpolation created. That is a fixed-point artifact, not a
  rule, so this engine uses one step along the exit line's normal instead
  (`LINE_TELEPORT_NUDGE`); transcribing the constant into a float engine would be meaningless.

**Boom's numbers spend a one-shot line only on success.** Their dispatch is
`if (EV_Silent…(…)) line->special = 0;` with no `|| demo_compatibility`, unlike vanilla's `case 39`,
whose clear is unconditional — the behavior § Teleporters describes and
`tests/regression/teleport-back-side.test.ts` pins. `TeleportEffect.spendOnlyOnSuccess` is that
split, per number rather than as a global rule.

**209/210 flip their switch inside the teleport branch**, not at the end of `trigger`: the branch
returns early, and `P_UseSpecialLine` calls `P_ChangeSwitchTexture` inside
`if (EV_SilentTeleport(…))` — so a switch teleport that found no destination is left unflipped and
unspent, the same rule as every other gated switch (§ A switch only flips when it acts).

Two deliberate divergences:

- **The camera's position cuts, but its yaw only turns by `rotateBy`.** Boom's silent teleport
  exists to make rooms-over-rooms imperceptible in a first-person view; from overhead the
  surrounding geometry visibly changes regardless, and not snapping the follow point would leave the
  camera flying across the map (§ Teleporters). The yaw is the part that can genuinely be preserved,
  and **must be turned relatively, not reoriented**: `TopDownCamera.yawDeg` is an orbit the player
  owns with Q/E (docs/camera.md § Camera orbit and camera-relative movement), not something slaved
  to their facing, so setting it from the landing angle — what a vanilla teleport correctly does —
  injects that orbit offset as a visible spin on every silent arrival. A pair authored as one
  continuous doorway has `rotateBy` 0 and now leaves the view completely still.
- **A monster's momentum is not rotated**, because monsters have none in this engine
  (docs/movement.md). Their facing rotates; the AI re-routes from the arrival anyway
  (`movedir = DI_NODIR`).

Monsters can activate every one of these lines except through a *switch*: `p_switch.c` does list
209/210 alongside 174/195 as monster-usable, but no monster here presses switches at all, so that
gap predates this work and is unchanged.

## Toggle plats

211 (SR) and 212 (WR), `EV_DoPlat(toggleUpDn)`: the floor snaps between its own height and its
ceiling — sealing the sector — and snaps back on the next activation. No travel time, no wait, no
sound at all; `EV_DoPlat` starts none for this type and `T_PlatRaise` skips both `pstop` calls.

**The instantness is emergent in vanilla, and explicit here.** `EV_DoPlat` sets
`low = ceilingheight`, `high = floorheight` and a *downward* direction — so `T_MovePlane`'s first
step is told to move down toward a destination *above* the floor, clamps straight to it and reports
`pastdest`. This engine's movers auto-direction toward their target instead (§ Generalized linedefs
lists that as a known divergence), so nothing would clamp; `LiftMover.instant` says so outright
rather than reproducing a sign trick that no longer has the same effect.

Each stroke parks in `'stasis'` with `stasisFrom` recording which way it went, and the next
activation **reverses** it — `plat->status = plat->oldstatus==up ? down : up`, not the plain resume
the perpetual family's stop line gets. That is the whole of the toggle.

Two consequences worth knowing:

- **A toggle plat always reports a hit.** `EV_DoPlat` sets `rtn = 1` unconditionally for
  `toggleUpDn`, before the per-sector loop — unlike `perpetualRaise`, whose stasis wake leaves `rtn`
  at 0. So an SR 211 flips its switch every press, including the presses that only woke something
  (§ A switch only flips when it acts).
- **It crushes rather than reversing.** `plat->crush = true` is set for this type alone, so
  `LiftMover.crush` takes it down the grind-through path instead of the immediate reverse every
  other blocked lift does (§ Every other mover stops instead). Because the move completes within
  the tic it starts, the damage lands on that same tic.

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
as the enclosing sector (docs/render.md § Self-referencing sectors), so nothing on screen moves —
become an invisible rising platform that lifts the player into a 55-unit gap and wedges them there.

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
the same `rtn` shape as restarting an in-stasis crusher (§ Crushers). A lift saved mid-stasis
restores mid-stasis: the new `LiftMover` fields are optional plain data like every mover field.

These four numbers were a long-standing vanilla gap in this engine (the earlier "nothing
vanilla-scoped unmodelled" audit claim was wrong here), closed when Boom's generalized lifts
needed the same machinery.

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
label positioned just past that assignment, so jumping to it skips the flag. `CeilingMover` has no
crush handling at all as a result; `crush==false` is exactly what makes a lowering `CeilingMover`
stop rather than grind through anyone underneath.

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

## Movers run at the tic rate

Doors, lifts, floors, ceilings and crushers write `sector.floorHeight`/`ceilHeight` and rebuild
their mover geometry once per simulation tic, and that motion is **deliberately not interpolated**
for display the way sprite positions are (docs/frameloop.md § Interpolation). 35 Hz is the rate
vanilla ran them at, a lift is a large slow object where the stepping reads far less than it does on
a sprite, and interpolating would mean lerping heights and rebuilding meshes on the render clock —
the most invasive change available in the riskiest code here. If a door ever *does* need smoothing,
that is its own change, not an oversight to be fixed in passing.

What that per-tic rebuild is allowed to cost is a rendering matter, and it is a real constraint on
heavily scripted maps, where hundreds of sectors move at once — docs/render.md § Mover meshes.

## Lights

The sector-type patterns (`SECTOR_LIGHT_SPECIALS`, `game/specials/tables.ts`) are assigned once at
map load and ticked by `updateLights` → `tickLight` (`game/specials.ts`). Each holds a `baseLight`
(the sector's own level) and a `darkLight` (`darkestNeighborLight`, vanilla's
`P_FindMinSurroundingLight`) and interpolates or toggles between them. Every random period draws
from `pRandom()` — docs/random.md § The table and the two cursors.

The strobes (`blink05`, `blink1` and their synced variants) are the easy ones: a fixed 5-tic lit
period against a 15- or 35-tic dark one, straight off vanilla's `STROBEBRIGHT`/`FASTDARK`/`SLOWDARK`
— `FASTDARK` (15) for sector types 2, 4 and 13, `SLOWDARK` (35) for 3 and 12, so the *synced* pair
runs slow-then-fast where the unsynced one runs fast-then-slow (`P_SpawnSpecials`).
`glow` ramps continuously.

**A strobe whose `darkLight` equals its `baseLight` blinks to black**, vanilla's
`if (minlight == maxlight) minlight = 0` — and `P_SpawnStrobeFlash` is the only spawn that carries
it, `P_SpawnLightFlash`/`P_SpawnGlowingLight`/`P_SpawnFireFlicker` all leaving the two equal and so
standing still. Without it a strobing sector as dark as everything it touches simply does not
strobe: `EPIC.WAD` MAP02 sector 0 is type 2 at light 240 with one neighbour, also at 240.

The two patterns that are **not** simple toggles are worth knowing:

- **`blinkRandom`** (sector type 1) is `T_LightFlash`, and vanilla's `mintime`/`maxtime` are used as
  **bit masks, not durations**. Dark is `(P_Random()&7)+1` — 1 to 8 tics. Lit is
  `(P_Random()&64)+1`, which is **1 tic or 65 tics and nothing in between**, because `&64` yields
  only 0 or 64. That lopsided split is the whole character of a vanilla broken light: mostly a slow
  pulse, punctuated by the occasional single-frame stutter. Modelling it as a fixed lit period and a
  random dark one — which this engine did until the light rework — gets the rhythm backwards.
  `P_SpawnLightFlash` seeds the counter with the same `(P_Random()&64)+1`, which is what puts a
  map's broken lights out of phase with each other rather than in lockstep.
- **`flicker`** (sector type 17) is `T_FireFlicker`, and it has no two-state toggle at all. Every
  4 tics it picks `amount = (P_Random()&3)*16` and sets the level to `maxlight - amount`, floored at
  `minlight` — four brightness steps, which is what makes it read as firelight rather than as a
  stutter. `minlight` is `P_FindMinSurroundingLight + 16`, so `darkLight + 16` here. `LightState`
  carries a `level` field for this pattern alone; a `bright` boolean cannot express four steps.

  Reproduce vanilla's asymmetry in that assignment exactly: the `< minlight` test reads the sector's
  **current** level while the assignment uses `maxlight`. Since the current level is itself
  `maxlight - something` from the last tick, the floor triggers more readily than the naive reading
  suggests, and the pattern sits at `minlight` more of the time. It looks like a bug in the C and is
  load-bearing for how the effect looks.

## Light changes

`LightChangeEffect` is the runtime-triggered counterpart to the sector-type blink patterns: those
assign an ongoing pattern once at map load, these mutate (or start animating) a *tag-matched*
sector's light on demand.

- `'setLevel'` (13/35/79/81/138/139) — a literal light value.
- `'brightestNeighbor'` (12/80) — vanilla's "bright = 0 means search" rule: the max level among
  immediate two-sided neighbors, or pitch black if there are none (`EV_LightTurnOn`).
- `'darkestNeighbor'` (104, `EV_TurnTagLightsOff`) — the min of the sector's own *current* level and
  its neighbors', which unlike `'brightestNeighbor'` never brightens, only darkens or leaves
  unchanged.
- `'startStrobe'` (17, `EV_StartLightStrobing`) — spawns the same slow, non-synced `blink1` pattern
  a sector-type-3 sector gets at load, skipped if the sector already has an active mover (vanilla's
  `specialdata` guard — light thinkers and movers share that slot in real vanilla; this engine's
  `lightStates`/`movers` maps are already independent, but the *trigger* still respects the guard).

Because any of these can target a sector that was never a light-pattern sector, `indexLightGeometry`
— previously scoped to just the load-time blink sectors — now indexes every sector's static-batch
occluders/flats unconditionally, a one-time load cost.

### Relighting mover geometry

`recolorSector` (`specials/movergeometry.ts`) rewrites the RGB of every surface lit by a sector, in
two places: the static batches (`sectorOccluders`/`sectorFlats`) and, via `recolorMoverGeometry`,
any mover mesh holding that sector's geometry. Both are needed because a mover mesh carries its own
sector's flats **plus** wall quads from *both* sides of every bordering line — so a sector that
moves, and a static sector next to one, each have geometry that `indexLightGeometry` cannot see.
`moverLightTargets` (filled in `createMoverMesh` from each quad's/fan's own `sector` field) is the
sector → owning-mover-meshes index that makes the second pass cheap; a rebuild never changes which
sectors a mesh covers, so it only grows once.

The invariant: **a sector's light must reach its geometry whether or not that geometry is currently
in a mover mesh.** Without the mover pass a strobing lift only relights while it happens to be
*moving* — a height change rebuilds the mesh from the live `sector.light` anyway, which is exactly
what masked the bug. Repro: DOOM1 E1M5 sectors 2 and 32, the tag-1 strobing lifts (also E1M5 sector
91, tag 2), covered by `tests/regression/strobing-lift-light.test.ts`.

This covers **every** light effect, since `updateLights` (all the sector-type patterns) and
`triggerLightChange` (the runtime line specials above) both funnel through `recolorSector` — and the
combination is not rare: 7 maps in DOOM1.WAD, 18 in DOOM2.WAD, 14 in Freedoom 2 and 8 in SCYTHE.WAD
have at least one light-driven mover, `glow` being the most common by a wide margin.

Both indexes are keyed by the sector a surface takes its **light** from, not the one it belongs to.
For a wall those are always the same sector; for a flat they differ wherever a 213/261 transfer or a
deep-water bottom is in play (§ Render transfers), and keying this way is the whole of what makes a
transferred light live — recoloring the control sector reaches its dependents because they are
filed under it.

Only RGB is written (`setXYZ`); vertex alpha belongs to `WallFader`/`FlatFader`
(render/occlusion.ts) and the two must not clobber each other.

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

## Generalized linedefs

Boom's generalized range (0x2F80–0x7FFF) is decoded on the fly by
`specials/generalized.ts: decodeGeneralized` into the *same* `SpecialDef`/`Effect` shapes the
vanilla table uses — the vanilla table itself is never touched, and `lookupSpecial` memoizes each
decoded number for the session. Every mask, enum ordering and speed/wait tier is transcribed from
boom202/PrBoom+ `p_spec.h`/`p_genlin.c`, never boomref alone. The trigger bits map onto
`{trigger, repeatable, manual}` (Push = manual, acting on the line's back sector like a vanilla
D1 door); the per-family monster bit becomes `monsterActivate` — for floors and ceilings the
model bit doubles as "allow monsters" only when no change is set, and the locked-door family
admits no monsters at all, both per `p_spec.c`'s generalized gates.

Two Boom rules reach the controller as **data on the def** rather than as checks against the raw
number, so `specials.ts` needs to know nothing about the bit layout: `requiresTag` (a line that
acts by tag and has none does nothing — `p_spec.c`'s "all walk generalized types require tag",
set for every non-Push generalized trigger) and `retriggerXor` (the mask Boom's generalized stairs
alternate their build direction with on each successful activation, `EV_DoGenStairs`'
`line->special ^= StairDirection`).

Vanilla performs that alternation by mutating the linedef; this engine **does not touch the map**.
`SpecialsController.retriggerFlips` holds the flipped lines and `lineSpecial(lineIndex)` applies
the XOR on read, which every trigger path resolves through. So the authored number stays the truth
for anything classifying lines (`classifyLineSpecial`, the coverage report, `findSwitchEntries`),
and a restore is a plain Set assignment — `SpecialsSnapshot.stairFlips` needs no ordering
guarantee about when the map was loaded, unlike a re-applied mutation would.

Known divergence, deliberate: `FtoLnC` keeps the engine's own clamp-to-own-ceiling, which only
differs on degenerate maps. Generalized floors and ceilings otherwise honour their direction bit in
full, including the clamp a target on the "wrong" side of it gets — § Inverted plane moves.

## Generalized sector types

Every interpretation of `Sector.special` — the light seeding, the movable-sector scan, the
delayed-door spawn, and `SectorEffects`' damage/secret checks — goes through **one decoder**,
`decodeSectorType` (`specials/sectortypes.ts`), never an exact-equality table hit on the raw
value. Below 32 the vanilla tables apply unchanged. From 32 up the value is Boom's bitfield
(`p_spec.h`): bits 0-4 carry the vanilla behaviors (Boom runs its spawn switch on
`special & 31`, so a generalized sector's low bits get the light patterns *and* the 10/14 door
timers), bits 5-6 pick a damage class (none / 5 / 10 / 20 HP per interval — only the 20 tier
rolls the radiation-suit leak, matching vanilla 16/4), bit 7 marks a secret, bit 8 enables
per-sector friction and bit 9 pushers (both decoded now, consumed when those Phase-3 systems
land).

Consuming a secret differs by era, per `P_PlayerInSpecialSector`: vanilla 9 zeroes the whole
special; the generalized bit clears only itself — and if nothing but low bits remain, Boom zeroes
the special outright (`consumeSecret`). Secret totals count both forms once at load
(`SectorEffects`' constructor).

## Scrollers and conveyors

Boom's **parameter lines** are the other half of its specials: numbers read once at level spawn to
give a surface or a sector a permanent property, never dispatched from a trigger. `lookupSpecial`
returns `null` for every one of them (they are listed in `PARAM_LINE_SPECIALS` so the coverage
report can tell "handled elsewhere" from "unknown"), and `specials/forces.ts: Forces` owns them
instead — scanned once from the map in its constructor, ticked with the simulation.

`P_SpawnScrollers` reads the control line's **own vector, divided by 32** (`SCROLL_SHIFT` 5) as the
rate in map units per tic, so a longer line scrolls faster and its direction is the scroll
direction. Vanilla 48 and Boom 85 are the exceptions: a fixed ±1 unit/tic, which is where the
engine's long-standing 35 units/sec comes from.

| # | Effect |
|---|---|
| 48 / 85 | scroll the line's own front sidedef left / right, 1 unit/tic |
| 250 / 251 | scroll a tagged sector's ceiling / floor flat |
| 252 | carry things standing on a tagged sector's floor |
| 253 | 251 and 252 at once |
| 254 | scroll the *tagged lines'* walls, each in its own frame |
| 255 | scroll by the trigger line's own authored sidedef offsets |
| 245-249 | 250-254, driven by the front sidedef's sector height changes (**displacement**) |
| 214-218 | 250-254, the same but **accelerative** |

245-249 and 214-218 are remapped onto 250-254 up front, exactly as Boom does, so only one set of
cases is written out. A displacement scroller's rate is its authored rate times the change in its
control sector's `floorHeight + ceilHeight` since last tic; an accelerative one *accumulates* that
into `vdx`/`vdy` and keeps scrolling at the built-up rate after the control sector stops. **Those
integrators are the one piece of `Forces` a savegame carries** (`Forces.snapshot`/`restore`): an
accelerative conveyor still running with its control sector at rest is simulation state, not
presentation, so a restore that dropped it would stop the belt. Everything else here re-derives
itself from the map — docs/savegames.md § What is saved and what is deliberately not.

**The carry rate is not the scroll rate.** `CARRYFACTOR` is 3/32, "so scrolling floors and objects
on them can move at same speed" — and 253 applies it only to the conveyor half, after the flat half
took the *negated* vector. The sign flip is the flat's own texture axis, not a direction change:
vanilla stores `-dx` in `floor_xoffs` precisely so the pattern appears to move along `+dx`, the way
the conveyor does.

**Two clocks, deliberately.** `Forces.tick` runs once per simulation tic — `T_Scroll` is a thinker,
and acceleration is defined per tic — and resolves each scroller's current rate plus this tic's
conveyor impulses. `Forces.advanceOffsets` integrates the *visual* offsets on the frame clock from
that rate, so a scrolling waterfall stays as smooth as the rest of the presentation layer instead of
stepping at 35 Hz. Only the offsets are frame-paced; nothing the simulation reads is.

**A carried thing still triggers lines.** `P_CrossSpecialLine` fires for every non-player mobj that
moves — it excludes only the six projectile types, and its "monster only" numbers mean *not the
player* rather than *monsters only* — so a barrel or a decoration a belt pushes over a teleporter
teleports. Nothing but a conveyor ever moves a decoration in vanilla, which is why that only shows
up here: BOOMEDIT's 252/253 and 216/217 belts each run an evil eye into a **267** line-to-line
teleporter that loops it back to the start, and without this the eye rides off the end and is gone
(`tests/regression/conveyor-carries-over-teleporter.test.ts`). Momentum survives the trip the way
the arrival says it should — a loud `P_Teleport` zeroes it, a silent one rotates it — so the cargo
comes out of the far end still moving.

Corpses ride belts too — `P_KillMobj` strips `MF_NOGRAVITY`, so `sc_carry`'s gate admits them. That
is what finally made a dead thing's velocity load-bearing here: before conveyors nothing could move
one, so it sat as inert unread data (docs/movement.md § Knockback).

The gate is "standing on the belt's floor" — with one exception, `sc_carry`'s own "Underwater, carry
things even w/o gravity": in a 242 sector anything **below the water surface** rides the belt
whether or not its feet are down (§ Deep water).

A `side` scroller's affectee is always `*l->sidenum`, the **front** sidedef, for every one of these
numbers — which is why `Forces` records the linedef index and the renderer's existing
`WallOccluder.frontSide` index is enough to find its quads. How the offsets reach the geometry is
docs/render.md § Scrolling textures.

## Voodoo dolls

A map's **extra player-1 starts** are voodoo dolls: vanilla spawns a player mobj for every
doomednum-1 thing and puts the console player in the last one (docs/wad.md § Player start), so the
rest stand around being player bodies nobody controls. Push one onto a conveyor and it walks lines
on the player's behalf; drop a crusher on it and the player dies. That is the whole of Boom-era
mapper scripting, and it is why conveyors and dolls landed in the same phase.

`game/voodoo.ts: VoodooDolls` owns them. Each tic a doll takes the same conveyor and pusher impulses
the player does, slides with `slideMove` (it is a player mobj, so it gets `P_SlideMove`), rides
whatever floor it is standing on, and decays its momentum by that floor's friction. It has no
gravity, no input and no AI — the world is the only thing that moves it. A doll a belt pins against
a wall — the resting state of most dolls on a script map — skips that whole re-derivation via the
pinned-body memo (docs/movement.md § Pinned-body memo), which is what keeps a 466-doll map ticking.

**What a doll picks up, the player gets.** `MT_PLAYER` carries `MF_PICKUP` (`info.c`), so
`PIT_CheckThing` hands anything a moving doll's box touches to `P_TouchSpecialThing`, which credits
`toucher->player` — and every doll's is the console player. A doll run over an item collects it, and
only while it is moving: vanilla reaches the pickup through `P_XYMovement`, which a parked doll
never enters. See docs/items.md § Collecting things.

**Triggering** goes through `SpecialsController.crossVoodoo`, the third `Activator`. A doll gates
exactly like the player it copies — the player's own keys, every line a player may cross, and it is
never a monster for a monster-only number — with two differences:

- a teleport's landing spot is **returned to the caller** to move the doll, the way a monster's is,
  rather than going through `onTeleport` and moving the player;
- it raises **no HUD feedback**: a doll shoved into a locked door must not print "you need the blue
  key".

**Crush damage mirrors onto the real player**, since `P_DamageMobj` on a doll is damage to
player 1: a crusher catching a doll deals `CRUSH_DAMAGE` to the player, once per doll caught
(`applyCrushDamage`).

**A damage floor does not.** `P_PlayerInSpecialSector` reads `player->mo` and is called from
`P_PlayerThink` alone (`p_user.c`: `if (player->mo->subsector->sector->special)`), so it only ever
runs for the body the console player occupies — the last start, never a doll. Sunder 2512's MAP20
is the repro: it parks a doll in a slime sector at (-5072, -1568), which under an earlier
per-doll damage pass bled the player 10 HP a pulse from the moment the level loaded. Secrets are
player-only for the same reason, and so is the `exitBelowHealth` floor.

Two deliberate deviations, both documented at their declarations. **Dolls are not drawn** — vanilla
renders them as marines, which in a top-down view reads as a second player standing across the map.
And **dolls do not obstruct movers**: vanilla's `PIT_ChangeSector` would let one stall a rising
floor, but a doll is parked exactly where a script needs it and is often meant to be crushed there,
so jamming the level's own machinery is the worse failure. Crush *damage* still reaches it.

## Friction

Linedef **223** sets its tagged sectors' friction — ice or mud — and the dial is again the control
line's own length: longer is more slippery. Two curves out of `P_SpawnFriction`, meeting at
vanilla's own 0.90625:

```
friction   = (0x1EB8 × length) / 0x80 + 0xD000
movefactor = friction > ORIG_FRICTION ? ((0x10092 − friction) × 0x70) / 0x158    // ice
                                      : ((friction − 0xDB34) × 0xA) / 0x80       // mud
```

Note the sign, which the C's own comment flags as counter-intuitive: a *higher* `friction` value
means *less* friction, because it is the multiplier momentum survives each tic.

**Thinkerless**, following PrBoom rather than boom202: Boom's original spawned a thinker that
re-stamped every mobj in the sector every tic, and killough replaced it with two plain per-sector
arrays filled once at load ("friction should be a property of sectors, not objects which reside
inside them"). `Forces` holds those two arrays; nothing about friction is ticked.

A sector's friction applies only while its special still carries the friction bit (0x100) —
`decodeSectorType(...).friction`, the same re-check `P_GetFriction` makes. Which sector wins for a
body touching several is vanilla's rule transcribed rather than a plain minimum: the first
qualifying sector is taken while nothing is picked yet, and after that only a strictly lower
friction displaces it ("muddy has precedence over icy"). A body only qualifies for a sector whose
floor it is standing at or below.

**Deviation:** MBF's clamps (`friction` into [0, 1], `movefactor` at least 32) are applied
unconditionally, where PrBoom gates them on `mbf_features` and so skips them at the Boom complevel
this engine targets. Unclamped, a 223 line longer than about 200 units produces a friction of 1 or
more — momentum in that sector would never decay, or would grow without bound. That is an engine
hazard rather than a behavior any map can be built on. `friction` pinned at exactly 1 is still a
degenerate input to the movement mapping, which bounds it again by `P_XYMovement`'s `MAXMOVE` —
docs/movement.md § Friction.

How the two numbers reach the player's actual movement — and why an engine whose input model isn't
vanilla's needs a mapping at all — is docs/movement.md § Friction.

## Pushers

Three more parameter lines, all in `specials/forces.ts` beside the scrollers, all reading their
strength from the **control line's length**: **224** wind, **225** current, **226** a point source.
Each applies to every tagged sector — but only for as long as that sector's own special still has
Boom's push bit (0x200) set, which `T_Pusher` re-checks every tic because a switch can rewrite a
sector's special out from under a live pusher.

Wind and current are constant over their sector and differ only in what being off the floor does:

| | in the air | on the floor |
|---|---|---|
| wind (224) | full force | half force |
| current (225) | nothing | full force |

In a **242 sector the water surface stands in for the floor** (§ Deep water): a current runs on
anything under the surface rather than only on the pool floor, and wind gives full force above it,
half while wading, and nothing at all once the eye is under — `T_Pusher`'s own special-water branch,
and the one place a render transfer reaches movement.

A **point** pusher (226) needs an `MT_PUSH` (doomednum 5001) or `MT_PULL` (5002) thing standing in
the tagged sector — `P_GetPushThing`, and "no `MT_P*` means no effect". Its force radiates from (or
pulls toward) that thing, falls off linearly to zero at **twice** the line's magnitude, **crosses
sector boundaries** (what matters is distance to the source, not which sector you stand in), and
requires line of sight to the source. Both 5001 and 5002 are invisible markers with no sprite art,
so they never spawn as things (`THING_SPRITES` has no entry, which is what gates spawning).

Every figure here comes from `Add_Pusher`/`T_Pusher`/`PIT_PushThing`: `PUSH_FACTOR` 7 (so the
impulse is the line vector over 128 map units per tic, and a point source's one shift smaller
again), the radius as `magnitude << 1`, and `P_AproxDistance` — vanilla's octagonal distance
estimate, reproduced rather than replaced with a true hypotenuse because both the reach and the
falloff are *defined* in terms of it.

**Pushers reach the player only** (voodoo dolls included — they are player mobjs). Boom's own
`T_Pusher` skips every non-player outright, and `PIT_PushThing` widens to monsters only under
`mbf_features`, which complevel 9 — the Boom target — does not set. A conveyor's carry has no such
gate and moves every body on the belt. The asymmetry is vanilla's, not this engine's.

## Render transfers

The other half of Boom's parameter lines: four numbers that change how a sector or a line is
**drawn** rather than how it behaves. Like the scrollers they are consumed once at level spawn and
`lookupSpecial` returns null for all of them; `specials/transfers.ts` (`Transfers`) owns them, the
way `forces.ts` owns the movement ones.

| # | Effect |
|---|---|
| 213 | tagged sectors draw their **floor** with the control sector's light level |
| 261 | tagged sectors draw their **ceiling** with the control sector's light level |
| 242 | tagged sectors draw at the control sector's **heights** — Boom's deep water |
| 260 | the line's **midtexture** draws translucent |

All three sector transfers name their model the same way — the control sector is the one behind the
special line's **front sidedef** (`sides[*l->sidenum].sector`, `p_spec.c: P_SpawnSpecials`), and the
targets are every sector carrying the line's tag. 260 is per-line instead: tag 0 affects only the
line it sits on, any other tag affects every line carrying it (`p_setup.c: P_LoadLineDefs2`).

`Transfers` is scanned from the map alone and never ticked — nothing here has runtime state, so
none of it is saved (docs/savegames.md). It is reached through `transfersOf(map)`, memoized against
the `DoomMap` exactly as `world.ts`'s tag indexes are, because the sprite-lighting sites that need
it are scattered across `game/` and the mesh builder needs it before any controller exists.

### Transferred lighting

`R_FakeFlat` resolves a surface's light as
`lightsec === -1 ? sector.light : sectors[lightsec].light`, per **surface**, which is why
`Transfers` exposes `floorLight`/`ceilingLight` rather than one "the sector's light". Three
consumers, each matching a different line of the vanilla renderer:

- **flats** take `floorLight` (`ceilingLight` for a ceiling) — `r_bsp.c`'s `R_Subsector`.
- **walls take the sector's own light, untransferred** — `rw_lightlevel` in `r_segs.c` reads
  `R_FakeFlat(frontsector)->lightlevel`, not the floor/ceiling values. A 213 lava floor lights
  itself and not the walls around it; that asymmetry is vanilla's.
- **sprites take the average of the two**, `(floorlightlevel + ceilinglightlevel) / 2`
  (`r_bsp.c: R_AddSprites`) — `Transfers.spriteLight`. On a map with no transfer lines both halves
  are the sector's own light, so the average is exactly what every sprite read before.

That average is the only visible effect **261** has here: ceilings are never drawn (docs/render.md §
Mesh building), so a transferred ceiling light can only move half the sprite light.

A transferred light is *live* — the control sector may be a strobe. The plumbing for that is
`FlatSurface.lightSector` (docs/render.md § Sector lighting): every fan records which sector its
colour actually came from, and `MoverGeometry` indexes by that instead of by the sector the fan
belongs to, so `recolorSector(control)` repaints its dependents with no extra bookkeeping
(§ Relighting mover geometry).

### Deep water

A 242 sector is drawn at its control sector's heights. Vanilla picks **one** of two views by where
the eye is: above the surface it draws the floor at the control sector's floor height with the
sector's own flat and light; below it (`viewz <= control.floorheight`) it draws the real floor with
the *control* sector's flat and light, and hides or clips every sprite across the surface
(`r_things.c: R_ProjectSprite`).

**This engine draws both at once, and that is a deliberate deviation.** The camera is always above
the level, so vanilla's opaque surface would simply erase a player who waded in. Instead each
water sector gets two fans: the **pool bottom** at the real floor height with the control sector's
flat and light, and a translucent **surface** at the control sector's floor height with the
sector's own flat and light (`WATER_SURFACE_ALPHA`, a feel dial in `constants.ts` — vanilla has no
opacity to copy). Sprites are never clipped, so you can see yourself walk under water. The surface
is also exempt from occlusion fading, which would otherwise dissolve the fans right over a submerged
player (docs/render.md § Wall occlusion fading).

**A pool bottom a mover raises out of the water keeps drawing as a pool bottom.** Once its floor
reaches the surface there is no water left over it, so `waterHeight` is null and one fan is drawn at
the real floor — but the flat and light still come from the control sector, not from the sector's
own, which in every deep-water setup is the *water* flat the surface wears. Boom draws that water
flat instead — `R_FakeFlat`'s plain branch keeps `sec`'s own `floorpic` and only moves the height to
`s->floorheight` (`r_bsp.c`) — so this is the same deviation the two fans above are, carried to the
case where the bottom has risen through the surface. `Transfers.poolBottom` is what remembers this:
`markPools` records at load which 242 sectors had water over them, since the live heights no longer
say so. Repro: BOOMEDIT MAP01's stairs in sector 35's pool (sectors 34, 37-40, 42, 43) — the top
step comes to rest exactly at the surface, and drew a patch of FWATER1 beside siblings still showing
their RROCK13. **The load-time half of that has to be resolved before a savegame's sector heights
are applied**, which is why `Game.beginLevel` calls `transfersOf` ahead of `applySectors`
(docs/savegames.md § Apply order); after it, a restored save classifies the risen step as a sector
that was never water.

**A sector walled in by a pool gets that pool's surface drawn over it**, even though it carries none
of the pool's tag. Boom draws water only for a tagged sector, so an untagged one inside a pool is a
square the sheet stops at — visible only from overhead, where this camera looks straight down at it.
`Transfers.markPoolIslands` finds them: no 242 of its own, and every side facing a 242 sector that
borrows the *same* control sector. The adjacency alone is settled at load; the two height tests stay
live in `processFlat` — the island's floor must be `WATER_MIN_DEPTH` under the surface, and its
**ceiling at or below** it, so a sealed chamber whose roof clears the water stays dry inside
whatever surrounds it. The surface fan wears the *pool* sector's flat and light, not the island's,
which is the whole point: the island's own floor keeps drawing underneath it, seen through the
water.

Repro: BOOMEDIT MAP01 sector 121, a closed 4-sided pillar in sector 93's pool, floor and ceiling
both at −80 with the surface at −16. It is a vanilla sky pit (a sky ceiling over a sky ceiling draws
no upper, so a first-person player sees sky through the water); ceilings and sky are never drawn
here at all, so the only choice this camera has is between a void-looking hole and water running
over it. It is the one sector across every committed WAD that qualifies — `inspect-wad`'s transfers
line counts them ("enclosed by a pool").

The surface fan is only built when the control sector's floor is at least `WATER_MIN_DEPTH` above
the sector's own — deep enough for the two planes to be worth drawing separately, and far enough
apart not to z-fight (BOOMEDIT MAP01 sector 405 is **one map unit** deep, and two fans that close
shimmer against each other). Anything shallower keeps vanilla's plain above-water view: one floor
drawn at the surface height wearing the sector's own flat.

**The underwater colormap is dropped, and that is a second deliberate deviation.** A 242 sidedef
names three colormaps and vanilla casts the whole view through the *bottom* one once the eye sinks
below the surface (`R_SetupFrame`). Here the camera stays above the water while the player wades in,
so most of what is on screen is still dry land — turning it all blue reads as a bug rather than as
submersion. `Game.viewColormap` applies only the mid and top colormaps and returns no tint below the
surface; the bottom name is never even decoded (docs/hud.md § Screen effects, docs/wad.md § Colormap
lumps).

Boom's other use of 242 is a *fake ceiling*, whose control sector sits at or below the sector's
floor (what its **floor** half then draws is § The fake floor below). Its ceiling is never
rendered, but the height still shows: the walls of every sector
**across a two-sided line from it** are sized against the control sector's ceiling, not the real one
(`r_bsp.c: R_AddLine` fakes the backsector of every seg). That is what makes BOOMEDIT MAP01
sector 111's `SFALL1` waterfall a single 256..32 band instead of an upper stopping at 192 with a
32-unit hole under it; the rule, and the two limits this engine puts on it, are
docs/render.md § Deep water. BOOMEDIT.WAD MAP01 has 13 fake-ceiling setups beside its 22 deep-water
ones.

**The player still falls in.** 242 changes nothing about collision, so a pool drawn as a flat sheet
of water is physically as deep as its real floor — the camera follows the player down, and on
BOOMEDIT's deepest pools that is 200+ map units. Vanilla has the same split (the view sinks while
the surface stays drawn above) and it reads as intended in first person; from overhead the descent
has no visible cause, which is worth knowing before reading it as a camera bug.

Water is render-only in Boom too — `heightsec` never reaches `p_map.c`, so collision, resting
heights and sight are untouched. The two places it *does* reach gameplay are the conveyor and
pusher channels (§ Scrollers and conveyors, § Pushers), which treat a submerged thing as being on
the floor.

**Moving water works**: a control sector whose floor is dragged by a mover moves the drawn surface.
That costs two small load-time rules — `scanSectors` pulls a water sector in when its
control sector is movable (iterated to a fixpoint, since a water sector can itself control another),
and `MoverGeometry` links control → dependents so `rebuildAround` reaches geometry that shares no
linedef with what moved.

That second link reaches one step further than the dependent itself: **the dependent's movable
neighbours are on the same edge**, because their upper steps are sized against the pool's *drawn*
ceiling, i.e. the control sector's (§ Deep water's fake-ceiling paragraph above). A movable
neighbour owns its own side of that line, so a moving control sector left it drawing the old height
indefinitely — it never moves, the pool never moves, and neither shares a line with the control.
Repro: literalism.wad MAP18, sector 176's quads onto water sector 189 (control 187), covered by
`tests/game/moving-water.test.ts`.

The general rule those edges serve: **`MoverGeometry.rebuildAround` is the only way to invalidate a
mesh, and it takes the sectors that *changed*, not the meshes to rebuild.** Its `rebuild` is private
for that reason. It matters for more than heights — a 242 pool's bottom wears its control sector's
**flat**, so `EV_DoChange` and the arrival copies (`applyArrivalChange`, `applyFloorChange`) travel
the same edge with nothing moving at all. Any site that mutates a sector's geometry and then picks
the meshes to rebuild itself reintroduces the bug above, one texture at a time.

### The fake floor

A control sector **below** the sector's own floor is the other half of what 242 does, and vanilla
does not distinguish the two: `R_FakeFlat`'s plain branch assigns *both* heights from the control
sector unconditionally (`r_bsp.c`, `tempsec->floorheight = s->floorheight`). Used deliberately it is
Boom's **invisible platform** — a raised floor drawn flush with the room around it, which the player
then walks over as if on air. BOOMEDIT MAP01 sector 110 is the demo: a 32-unit platform inside
sector 115, tagged to 115 itself as its control.

**This engine substitutes only where every neighbour can follow the floor down** —
`Transfers.drawnFloor`. A sector qualifies when, across every two-sided line, the neighbour's floor
is at or below the fake floor *and* the neighbour carries no 242 of its own:

- **A neighbour above the fake floor** would need a lower reaching further down than before, and
  the maps that use 242 this way texture for the heights they expect to be drawn, not the real
  ones. BOOMEDIT MAP01 sector 80 is the case — it draws 8 above its control sector but sits beside
  sector 120 at the same height, whose sidedef has no lower at all.
- **A neighbour with its own 242** is not drawn at the floor this scan can read off it, and whether
  it is depends on a decision `markFakeFloors` may not have made yet. Excluding those costs the
  idiom nothing — no map here builds one out of two overlapping 242 sectors — and keeps the test on
  heights the map states outright.

The adjacency half is settled once at load (`markFakeFloors`, `neighboursFollow`) because nothing
moves it; **whether the control sector is still the lower of the two is compared live**, so a lift
that raises a sector past its own fake floor stops substituting rather than drawing its floor above
itself. BOOMEDIT MAP01 sector 110 is a lift, which is what makes that split worth having.

The heights the adjacency walk compares are load-time ones, so a mover that lifts a *neighbour*
above the fake floor afterwards keeps the substitution. No committed WAD has that case, and
re-running the walk per mesh rebuild would put it in `processFlat`'s path.

Where both clauses hold, no step the map has no texture for can open: the fake floor only ever moves
*down*, onto or below a neighbour already there, so every wall between them either shrinks or
disappears. The substitution reaches **both sides** of every line it touches — a sector's own drawn
floor as much as its neighbour's, unlike the ceiling half — but never a midtexture's peg anchor,
only the opening it is clipped to. docs/render.md § Deep water has both asymmetries and what each
one looks like applied wrongly.

Without it, BOOMEDIT MAP01's platform draws at 32 while sector 115 draws at 0 and lines 673-676
carry no lower texture — a 32-unit band of nothing under the platform's rim, which from overhead
reads as a black hole around the grass. Across every WAD committed here the rule fires 8 times:
BOOMEDIT MAP01 sector 110, literalism MAP06 sector 168, MAP09 sector 83 and MAP18 sectors
1826-1830. It declines 59 others, nearly all of them literalism MAP18's colormap transfers — one
control sector at floor -768 carrying `ZRICK10` to 661 sectors whose own floors run from -10000 to
+10000, none of which is describing a floor to draw.

### Translucent midtextures

A 260 line's masked middle texture draws at **66%** — `tran_filter_pct`'s default, the percentage
Boom's own `TRANMAP` is generated at. The alpha rides the same per-vertex channel occlusion fading
and fog-of-war already multiply into (docs/render.md § Wall occlusion fading), so no material
becomes `transparent` and the batching rule holds.

Two deliberate simplifications:

- **Custom `TRANMAP` lumps are not read.** A 64 KB palette-blend table has no meaning to an RGBA
  renderer; every 260 line gets the same 66%. BOOMEDIT's `HTRANMAP` is the only one in a committed
  WAD.
- Boom overloads the **sidedef's midtexture name** on a 260 line to name that lump, and draws no
  midtexture when the name resolves to one (`p_setup.c: P_LoadSideDefs2`). That rule *is* modelled —
  without it `HTRANMAP` renders as a missing texture.

## Damage floors

`SECTOR_DAMAGE_SPECIALS` is vanilla's `P_PlayerInSpecialSector`: nukage (7, 5 HP), hellslime (5, 10
HP), super hellslime (16, 20 HP) and strobe-hurt (4, 20 HP), all every `DAMAGE_FLOOR_INTERVAL`, plus
E1M8's finale special (11, 20 HP, which also ends the level once it drops the player to 10 HP or
below — vanilla's inline `G_ExitLevel()` in that same case).

That exit test sits **outside** the damage pulse and has **no lower bound**, both as in vanilla's
`case 11`, where `if (player->health <= 10) G_ExitLevel();` follows the `!(leveltime&0x1f)` hit
rather than living inside it. So a player who steps in already under 10 HP exits on the spot, and —
the case that matters on E1M8's own sector 66 — a full-health player, whose 100 HP the 20-HP pulses
walk straight down through 20 to 0, exits on the pulse that kills them. Requiring them to still be
alive left that player dead in the pit with the level never ending, which is the one way most
players meet this sector. The corpse still gets its exit: `pendingExit` is queued on the same frame
and `Game.endingOverCorpse` takes the death overlay back down (docs/death.md § Dying on the way
out).

**A death from anything else in that sector ends the level too** — `SectorEffects.exitsOnDeath`,
asked by `damagePlayer` on the killing hit. This one is a deliberate deviation: vanilla only ever
runs the check from `P_PlayerInSpecialSector`, and `P_PlayerThink` returns at `PST_DEAD` before
reaching it, so a monster finishing the player off in E1M8's pit leaves them dead in it with the
episode unwon. The sector exists to end the episode over the player's body; *what* killed them there
is not a distinction the player can see. It is also the one check deliberately **not** gated on
`player.z === floorHeight`, unlike the damage above — the corpse need not have landed. `pendingExit`
is set before the death overlay is armed, so `levelEnding` keeps it from being raised at all rather
than clearing it a frame later.

**Player-only**, matching vanilla, which passes a `player_t*` and never damages monsters this way.
Dealt directly in `game/specials/sectoreffects.ts: SectorEffects.update` rather than through
`SpecialsController` — a damage floor has no mover, nothing for that machinery to own, just
`sector.special` plus the player's live position, so it's checked once a frame off `World.sectorAt`.
That same method also covers special 9 (§ Secret sectors below) — both are cases of the one vanilla
switch this method reimplements.

Gated on `player.z === sector.floorHeight` (vanilla's `mo->z != sector->floorheight` guard, skipping
a player still falling in) — deliberately the *local* 2D-position sector's own floor, **not**
`World.groundFloor` (which reads a straddled ledge's higher side), so standing on a ledge next to a
damage pit doesn't damage the player until they step down into it.

Special 4 is *also* one of the sector-type light-blink specials: vanilla spawns the same non-synced
fast strobe sector type 2 gets and then explicitly restores `sector->special = 4` so the damage
check still sees it. This engine never clears `sector.special` after seeding a light pattern in the
first place, so 4 living in both tables works without reproducing that restore step.

A radiation suit gates the damage per type (`DamageFloorEffect.suit`,
`game/specials/sectoreffects.ts: suitBlocks`) exactly as `P_PlayerInSpecialSector` does — see the
powerups doc for why the five types don't all treat it the same.

E1M8's finale is actually two mechanisms working together: § Boss death below is what lowers the
tag-666 floor that exposes this special-11 pit in the first place; this section is just what happens
once the player steps down into it.

## Secret sectors

`sector.special === 9` is vanilla's "SECRET SECTOR" — handled in the same `case` statement as the
damage floors above, by the same `game/specials/sectoreffects.ts: SectorEffects.update`, under the
same `player.z === sector.floorHeight` guard. Entering it increments `SectorEffects.secretsFound`
and clears `sector.special` back to 0, matching vanilla's own
`case 9: player->secretcount++; sector->special = 0;` exactly — the clear is also what prevents a
second frame from double-counting, no separate "already found" flag needed.
`SectorEffects.totalSecrets` is counted once per level load, straight off `map.sectors`, mirroring
vanilla `P_SpawnSpecials`' own `case 9: totalsecret++`. See docs/hud.md § Level stats for where
these numbers surface on screen.

`update` reports the entry back to `game.ts` (`SectorEffectResult.secretFound`, true on that one
frame only) rather than just bumping the counter, because finding a secret also announces itself —
a center-screen message and the `secret` chime, neither of which vanilla does. docs/hud.md §
Center messages.
