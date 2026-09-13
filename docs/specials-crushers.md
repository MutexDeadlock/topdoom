# Specials: crushers

`src/game/specials.ts`, `src/game/specials/moverblocking.ts`, `src/game/things.ts`

The one mover family that damages what is in its way instead of stopping for it, plus the
corpse-squashing branch *every* mover shares with it. The movers it is one of are
docs/specials-movers.md; what dispatches its trigger is docs/specials.md.

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

Membership in the crushing sector is still required — `boxOverlapsSector`, i.e. `World.sectorsTouching` —
so a body squeezed by something else next door is that mover's business, not this one's. Its
candidates are `ThingLayer.crushablesInSectors` over `crushNeighborhood` — every sector a body
overlapping the crushing sector can be centred in (docs/specials-movers.md § Every other mover
stops instead) — standing in for vanilla's walk of the blockmap blocks covering the sector's
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

**Both draws run even where the set has no `BLUD` sprite to spawn.** Vanilla's `P_SpawnMobj` cannot
fail, so the four table entries come off whether or not `SpriteFxLayer.spawn` resolved anything —
drawing them behind the null bail made the loaded WAD's art an input to the simulation and desynced
a replay played against a set missing the lump. `tests/game/crush-blood.test.ts` pins it.

It **sticks where it lands**, where vanilla goes on sliding it under `FRICTION`: nothing in this
layer collides with anything, so a sliding splash would slide through the wall it was sprayed
against. Landing also clears `motion`, so a splash costs its BSP descent only while it is in the
air.

**A barrel takes the same crush damage as a monster**, via `crushablesInSectors` (`monstersInSectors`
plus any living barrel in those sectors) — vanilla's `PIT_ChangeSector` doesn't distinguish
`MT_BARREL` from any other `MF_SHOOTABLE` mobj, so a barrel under a crusher dies and explodes
exactly as if it'd been shot (docs/death.md § Exploding barrels covers the death→explode delay
itself). The two obstruction checks other movers use (`game/specials/moverblocking.ts`) deliberately
stay on `monstersInSectors` alone — whether a barrel should also stall a closing door is a separate
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
same way `moveSoundDue` already is for the shared grind sound (`MOVE_SOUND_INTERVAL`,
docs/audio.md § Specials). This reproduces vanilla's literal `leveltime&3` — one level-wide clock
every crusher's `PIT_ChangeSector` call checks, so two crushers running at once always pulse on the
same tic. A per-mover countdown, reset to `CRUSH_DAMAGE_INTERVAL` on each fire, was tried first and
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
  switch that only *restarts* a frozen crusher therefore neither flips nor is spent
  (docs/specials.md § A switch only flips when it acts) — `triggerCrusher` returns `false` on that
  path on purpose.
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
- **The player's corpse is not squashed either.** It is the slot's `PlayerSlot.actor`, not one of
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
