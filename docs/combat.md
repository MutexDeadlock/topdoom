# Shots: paths, hits and effects

`src/game/projectiles.ts`, `src/game/combat.ts`, `src/game/world.ts: shotPath`,
`src/render/tracer.ts`, `src/game/spritefx.ts`, `src/game/spritefx/defs.ts`,
`src/game/spritefx/tables.ts`, `src/game/things.ts`, `src/game/things/tables.ts`, `src/game.ts`

This is the middle of the chain: a weapon has fired (docs/weapons.md) and something is about to die
(docs/death.md). What happens in between — where the shot goes, what it is allowed to hit, and what
the hit looks like — is here. `hasLineOfSight`, which several of these use, is docs/world.md.

## shotPath

**`shotPath` decides where a shot ends up**, for both tracer endpoints and how far a projectile may
fly. It has two modes, and the difference is the whole reason it takes a `target` rather than just
an angle.

**`target` supplies the slope; `range` supplies the distance, and the two are separate parameters
on purpose.** `range` defaults to stopping at the target, which is what a player's locked-on shot
wants — its target cannot move mid-flight. Anything else keeps going down the aimed slope whether or
not the target is still standing there. Folding the two together (deriving range from the target) is
what made every monster shot detonate on the spot the player had been standing at launch; both call
sites then had to fake a far-away aim point to undo it, which is the shape this parameter replaces.
See docs/monster-attacks.md § Hitscan vs. projectile.

What each caller actually passes is § Range below.

**Free shot** (no target): flat at the shooter's fire height, out to that range. Blocked by a line
with no opening at all (a genuinely one-sided wall, or a two-sided line whose opening has closed,
like a shut door) **and** by a two-sided line whose vertical opening the shot's height doesn't fit
through. Neither test alone is enough — `blocksSight` alone lets a shot through a shut door (vanilla
never flags those `BLOCKING`, so its own no-opening test is what catches them), and omitting the
height test lets a rocket sail through a knee-high step because the opening beyond it was tall
enough for *sight*.

Deliberately **not** `isSolidWall`, and reusing the movement-blocking predicate for shots was a
shipped bug: it made a shot treat a `BLOCKING`-flagged two-sided line (a barred window/railing) as
impassable like a real wall, when `PTR_ShootTraverse` never reads `ML_BLOCKING` at all — only
movement does. DOOM2 MAP01's east imp closet (sector 38) has exactly this kind of fence, and the bug
blocked both the player's shots at the imp and the imp's fireballs back through it.

**Locked-on shot** (a player's auto-aim target, or a monster's aim pass at what it is shooting at):
slopes from the shooter's fire height to the target's over exactly the distance between them, and
stops *at* the target. A `ShotLock` switches the blocking test from the single fixed ray to a
**slope wedge** — vanilla's `P_AimLineAttack`: start from the span of slopes reaching any part of
the target, narrow `[bottomSlope, topSlope]` against every opening crossed in increasing distance
order, and stop at the first line where the wedge collapses.

**The locked branch runs two passes, because vanilla is two calls.** `P_AimLineAttack` finds a
slope and stops at the thing it found; `P_LineAttack`/`P_SpawnPlayerMissile` then send the shot out
on that slope over a distance of their own. So pass one narrows the wedge only over openings crossed
**up to the target's distance**, and pass two re-traces the whole flight with `blocksShot` at the
slope pass one settled on. Running one walk for both let geometry *past* the target bend the aim,
which was invisible while a locked shot always stopped at its target and plainly wrong the moment a
locked missile flew on across the map (§ Range). The wedge's own opening angle is the target's
half-height over the distance **to the target**, for the same reason: that is where its silhouette
subtends that angle.

**The wedge that survives is also the slope fired** — `PTR_AimTraverse`'s `aimslope`, the middle of
`[bottomSlope, topSlope]` after every opening has cut into it. This is not cosmetic: firing the raw
line to the target instead meant the wedge cleared a shot on the grounds that *some* slope got
through, and the shot then went out on a different one that didn't, so the leniency was granted to
the blocking test and never to the shot. A player's missile showed it plainly, back when
`ProjectileLayer.update` gated its floor/ceiling test to a monster's shot: a rocket aimed over a
step cleared the wedge, flew at the raw slope straight through the step, and detonated on the far
wall. Every missile takes that test now (§ Where an impact sits), so the step would stop it — but
the aim would still be one the wedge never cleared. With nothing narrowing the wedge the midpoint *is* the target's centre, so an ordinary
open-room shot is unchanged.

**A wedge stopped short of the target fires flat.** `P_AimLineAttack` returns `aimslope` only when
its traverse reached a thing; with `linetarget` null it returns 0 (`p_map.c`), and the shot goes out
flat. `shotPath` re-traces the flat ray, so the shot also *ends* where a flat one does. Without it
the lock bought a slope no aim ever found: on DOOM2 MAP04 a pellet clicked at a monster past the
shut crusher corridor (sector 76, floor 24, ceiling down at 32 against neighbour floors of 32) took
the slot left under that ceiling and flew ~200 units on past the crusher.

The span the wedge starts from is the target's **real body** — `ShotLock.halfHeight`, half its
`mobjinfo.height`, around an aim point that is the body's centre (both derived in
`spawnPlayerShot` from the `MonsterRef` the lock handed it). Vanilla measures
`[th->z, th->z + th->height]`, which is a 110-unit cyberdemon and a 56-unit imp, and aims at the
middle of it; a fixed half-`PLAYER_HEIGHT` band around a fixed 32 units above the feet — what this
was — got the imp about right and put a cyberdemon's aim at its knees.

Passing a `ShotLock` at all is what selects the wedge: it and the old separate `lockedOn` flag were
the same bit at every call site. **A monster's hitscan takes the wedge too** — one aim pass for the
slope, then a fixed-ray trace per bullet (docs/monster-attacks.md § Hitscan vs. projectile). A
monster's *missile* still passes none: `P_SpawnMissile` slopes straight at the target and never
aims.

`ShotLock.slopeOffset` (the super shotgun's per-pellet jitter) is added **after** that clamp,
because `A_FireShotgun2` adds it to the finished `bulletslope`: vanilla jitters the shot, not the
aim, so a pellet may scatter into the very step the aim had to clear. Folding it into the aim point
before the trace — what this used to do — let the wedge clamp the scatter back out. Note the jitter
lands after the blocking test too, so it moves where the pellet is drawn without moving what stopped
it.

**Both of the other two things this has been are wrong, and the wedge is the fix for the second.**
The single-ray test is too *strict* for auto-aim: the one ray from gun to target clips the near edge
of the very platform the target stands on, stopping the shot there, which read as the shot going
flat and ignoring the click. The reaction was to skip the opening test outright for a locked-on
shot — far too *lenient*, and a shipped bug: it consulted geometry not at all, so a locked-on rocket
flew straight through a 512-unit-tall wall to reach a monster on top of it. The wedge is vanilla's
own middle ground: a genuine wall collapses it, an ordinary step does not, because the wedge is free
to pick the slope that clears the step. Verified against the real IWADs (DOOM2 MAP01/03/07, DOOM
E1M1/E1M7, ~9,000 shooter/monster pairs): **zero** pairs where a shot reaches a monster
`hasLineOfSight` says is not visible, with 0-1.4% going the other way (visible but shot-blocked) —
expected, since sight samples sector floors/ceilings at discrete points while the wedge narrows
against exact line openings.

Both modes start at the shooter's own height, never the target's — using the target's made tracers
and projectiles visibly begin in mid-air rather than at the gun. That height is vanilla's `shootz`
= `z + (height>>1) + 8` for every shooter: `AIM_HEIGHT_OFFSET` (`game/player.ts`) is it on
`PLAYER_HEIGHT` = 36, `monsterShootZ` (`game/monsters/defs.ts`) is it on the species' own
`mobjinfo.height`, so a spider mastermind fires from 58 and a zombieman from 36. A **missile**
leaves from `MISSILE_HEIGHT_OFFSET` instead, on both sides — `P_SpawnPlayerMissile` and
`P_SpawnMissile` share the same `+ 4*8`. The player's shootz is
also the plane the cursor is projected onto (docs/camera.md § Aim lead). The flat 32 it was is 4
units low and sits *exactly on* any floor 32 above the shooter's own — MAP04's crusher corridor, so
every shot crossing it fitted under the shut crusher. Blocking is evaluated at the
interpolated height where the ray crosses each candidate line, not one height for the whole flight.
Candidate lines are extended `WALL_OVERLAP` past both ends — two walls meeting at a shared vertex
otherwise let a shot aimed at that corner slip between them. Shots, projectile steps and the fog's
sight rays all read the same precomputed extended endpoints (`World.lineOverlapEnds`), since the
vertexes never move; it is one constant and one table for all three, not a coincidence between
them.

**The free shot's walk ends early**: once the nearest refusing line found crosses before the cell
just walked (`doneAfterCell`), nothing unvisited can cross nearer — a line is filed in every cell it
spans, and `WALL_OVERLAP` reaches into the cell just walked at most — so a shot into a wall stops
there instead of walking its whole range past it, and off the map to the step bound.

Candidates come from `World.forEachLineAlongSegment`, not `linesNear`, for the reason spelled out
under `hasLineOfSight` below — and here it is load-bearing rather than merely faster: a missile's
range is the whole map, and `linesNear`'s radius box would gather every line in it on every shot.
Measured on NUTS.WAD MAP01: a full-span walk beats even the old 2048-radius box (7 candidate lines
vs 19), while a box at map span costs 17× the walk.

## Range

Three different bounds reach `shotPath`'s `range`, and which one a shot gets depends on who fired it
and what kind of shot it is.

**A missile passes `World.mapSpan` — it has no range budget in vanilla at all.** `MISSILERANGE`
appears in `linuxdoom-1.10` exactly three times, all of them `P_AimLineAttack`/`P_LineAttack` calls
in `p_enemy.c`; `P_SpawnMissile` gives a missile momentum and nothing else, and it flies until
`P_XYMovement`, `P_ZMovement` or `PIT_CheckThing` stops it. Capping a missile at 2048 made every
rocket, fireball and plasma ball burst harmlessly in mid-air on any map with sightlines longer than
that: on NUTS.WAD MAP01, 21 of 36 directions traced from the player start ran out at exactly 2048
with no wall in front of them (the walls are 2764–8563 units out), which is why the arachnotrons'
plasma appeared to have a range. `mapSpan` — the map's bounding-box diagonal — is the shortest trace
length that can never itself be what ends a flight; the engine needs *some* finite number, and any
in-map wall is nearer than that.

**A monster's bullet passes `WEAPON_RANGE` (`MISSILERANGE`, 2048), a player's free bullet the longer
`PLAYER_WEAPON_RANGE` (8192).** This split is **the one place this engine follows ZDoom over
`linuxdoom-1.10`**, and it is deliberate: ZDoom made the same change for the same reason, defining
`PLAYERMISSILERANGE` (`src/playsim/p_local.h`) and defaulting `A_FireBullets`'s `range` to it
(`wadsrc/static/zscript/actors/inventory/stateprovider.zs`) while leaving every monster attack on
`MISSILERANGE`. Vanilla shares 2048 between the two, and in a first-person view a target that far
out is a few pixels tall; the dollhouse camera frames roughly 5,000 map units ahead of the player
(docs/fogofwar.md § Reveal radius), so 2048 put a hard wall in the middle of the visible playfield —
bullets stopped dead in mid-air at a monster the player could plainly see and had a clear line to.
Repro: a 3,648-unit corridor with a chaingunner at the far end (3,584 units out) is unwinnable at
2048 and plays correctly at 8192, matching GZDoom, where the asymmetry is the point — the
chaingunner's own bullets still expire at 2048, so it cannot shoot back.

**A locked-on *bullet* ignores all three and stops at its target**, which is `range`'s default
whenever `target` is given — see § shotPath for why aim and distance are separate parameters at all.
Note this makes the lock, not `PLAYER_WEAPON_RANGE`, the real bound on a clicked shot; the cursor
can only lock what the camera draws, so it never reaches further than the player can see.

**A locked-on missile does not.** It takes `mapSpan` like any other missile, because
`P_SpawnMissile` hands one momentum and nothing else. Bounding it at the launch-time distance to the
target is what made a rocket **burst in mid-air on the spot a monster had been standing**: the
flight ended at `maxDist` with the monster elsewhere, since a rocket takes about a third of a second
to cross 200 units and an imp covers 160 in that time. The lock gives a missile its slope and
nothing more (§ How a shot deals damage).

Which of the three a player's shot gets is `world.ts: playerShotRange` — its own function rather
than an expression inside `ProjectileLayer.spawnPlayerShot` so that the choice is testable without
the layer's five collaborators. `tests/regression/player-shot-range.test.ts` guards both it and the
2048/8192 split, on the corridor from the repro above.

## Shoot-triggered specials

**A hitscan shot fires `game/specials/tables.ts`'s impact specials — 24/46/47 — for every one of
them it crossed, not only for the line that stopped it** (`SpecialsController.triggerShotPath`,
vanilla's `P_ShootSpecialLine`). `PTR_ShootTraverse` runs
`if (li->special) P_ShootSpecialLine (shootthing, li)` on each line the traverse reaches *before*
testing whether that line blocks, and `P_TraverseIntercepts` walks intercepts nearest-first, so a
bullet fires the specials of lines it merely flew through — at whatever height, since the call comes
ahead of the opening test — in the order it passed them. Firing only the stopping line was this
engine's own reading for a long time, and it works on every stock map (every 24/46/47 in DOOM and
DOOM2 sits behind a face that stops the shot anyway, § Auto-aim); a PWAD hanging one on an open
two-sided line is where the two part company.

**`triggerShotPath` walks its own shoot-line list, not the blockmap.** The lines that carry a shoot
special are scanned once at load (`SpecialsController.shootLines` — almost always none, and the loop
costs nothing on those maps), so a resolved shot tests that handful of segments against its own
trace instead of re-walking the geometry a second time. The line that *stopped* the shot is passed
in separately rather than found here: `ShotPath.lineIndex` already has it, and the trace ends
exactly on it, which is the one crossing floating point can't be trusted to report. Everything each
line still has to satisfy — the shoot trigger, an unspent one-shot, `monsterCanTrigger` — is
`triggerShot`'s, unchanged. A body absorbing the shot only shortens the trace: the lines in front of
that body still fire, and the wall behind it never does.

**A melee swing fires nothing**, though `A_Punch`/`A_Saw` reach `P_LineAttack` and the same traverse
in vanilla: `spawnPlayerShot`'s melee branch skips `shotPath` entirely (it has no geometry to trace,
only a body to find), so a fist against a switch does nothing here. A known gap, not a decision.

**A projectile's trigger is a deliberate deviation, and is deferred to arrival.**
`P_ShootSpecialLine` is called from `PTR_ShootTraverse` and nowhere else — in `linuxdoom-1.10` and
in PrBoom alike — so in vanilla a **missile fires no impact special at all**: `PIT_CheckLine` never
calls it, and a rocket detonating on a 46 line does nothing. This engine fires it anyway, when the
missile reaches the wall (`ProjectileLayer.update`, off `Projectile.lineIndex`, which carries the
line found at launch forward — safe to resolve early, same as `maxDist`: static geometry doesn't
move mid-flight). Kept on purpose: the pointer makes a switch something the player *aims at* (§
Auto-aim), and the one weapon whose shot they can watch fly refusing to work on it reads as a bug
rather than as fidelity. The same "nothing closer absorbed it" rule applies — `reachedPlayer` and
`struck` take priority, as does a missile stopped by the floor, which never got there either.

24 and 47 reuse the plain `FloorEffect` machinery already built for their walkover/switch siblings
(5/64/91/101 and 20/68/22/95), just tag-triggered by a shot. **Only 46 can be triggered by a
monster's own shot** — `SpecialDef.monsterCanTrigger`, reproducing a hardcoded per-number exception
in `P_ShootSpecialLine` itself (`if (!thing->player)` rejects every case *except* 46) rather than
some general property of shoot-triggers. Getting 46's repeatability backwards was a real mistake
caught while adding the other two: `P_ChangeSwitchTexture(line, useAgain)` clears `line->special`
when `useAgain` is falsy, and 46 passes `1` (repeatable, GR) while 24 and 47 both pass `0`
(one-shot, G1).

## Auto-aim

**Auto-aim is click-to-target, not vanilla's autoaim cone** — this game has a mouse pointer, so "aim
at that one" is expressible directly. `ThingLayer.pickMonster` intersects the cursor ray with each
candidate's body and keeps the nearest, accepting `MONSTER_TYPES` **and the exploding barrel**,
minus anything already dead, picked up, `NO_AUTO_AIM_TYPES`, or not currently `visible` — the last
so a fog-of-war-hidden monster can't be targeted through the geometry hiding it. Anything rejected
is *skipped*, not treated as a blocker, so a decoration standing in front of a monster doesn't make
it untargetable.

**What the ray is tested against is the body's own `mobjinfo` box, never its drawn sprite** —
`util/geom.ts: rayEntersBox`, a plain slab test over `blockRadius` either side of the anchor and
`bodyHeight` up from its feet, which is the same box a shot collides with (§ How a shot deals
damage). Deliberately not `traceHitsBox`'s diagonal: that is `PIT_AddThingIntercepts`' shortcut for
a 2D trace crossing the box, and its direction-dependent width belongs to a shot fired from the gun,
not to a ray cast from the camera.

**Testing the sprite instead made the game WAD's art an input to the simulation, and that was a
shipped bug.** The pick used to intersect the billboard quad, so what the lock chose depended on the
lump's pixel width, height and hotspot — the only path from WAD *art* into a tic, where everything
else reads map geometry or the engine's own tables. A replay may run on a substitute IWAD
(docs/savegames.md § WAD-set identity), and 139 of 144 monster sprite quads differ between DOOM2.WAD
and freedoom2.wad (up to 61 px in width): a NUTS.WAD run recorded on the first desynced about 12 s
into playback on the second. The delay is the tell — the lock sets only `player.angle` while
movement runs off the camera basis, so nothing diverges until the first shot whose pick differs.
docs/replays.md § What breaks determinism.

The box is close enough to the art that little of the feel moved: an imp's `TROO` is 41 px against
its 20-unit radius. The two part company on a lost soul (16 against a 44 px `SKUL`) and, the other
way, on a mancubus, whose 48-unit box is wider than the 73 px `FATT` that draws it. Vertically the
box ends at the head where a sprite's transparent margin did not, so the reach is a little tighter
than what is painted. `tests/regression/aim-pick-body-box.test.ts` pins all of it.

Reading no render state is also what lets the tic cast this ray without first re-posing the sprite
batch (docs/frameloop.md § Posing for the aim ray); with the sprite gone the pick no longer needs
the viewer angle either, so `pickMonster` takes the ray alone.

It returns the hit monster's `MonsterRef`, which `game.ts: fireWeapons` hands to the shot as-is;
`spawnPlayerShot` is the one place that turns a body into an aim point, at `z + height/2` — the
body's **centre**, which is where vanilla's `aimslope` lands on an unobstructed target
(§ shotPath). It supplies the shot's aim *direction and slope* only — whether any one pellet
lands is still resolved geometrically against the target's body, so a spread weapon spreads (§ How a
shot deals damage).

**The one thing that does bound the ray is the ground** — `World.groundReach`, where both picks
start their nearest-hit search (docs/world.md § groundReach owns the trace). Followed from the
pointer's own aim point outward, the ray stops where it drops under a crossed line's floors: past
that it runs *below* the surface the cursor is standing on, and every body it still meets out there
is drawn somewhere else on screen entirely.

**Repro: NUTS.WAD MAP01, standing on the raised walkway at (1024, -559).** Unbounded, the ray left
the walkway a few units past the cursor and ran on through the crowd on the ground beyond, so every
pointer position over the walkway locked a monster 400-1400 units away, up to **180° off** the
pointer — where the shot then went, and where the player turned to face. It takes a floor the ray
can pass *under* while bodies stand on a lower one further along, so a flat map never shows it.
`tests/regression/aim-pick-ground-clip.test.ts` pins it.

**Three of vanilla's own limits on aiming are deliberately absent**, all of them consequences of
picking with a pointer instead of tracing down the facing, and none of them missed by accident:

- **Range.** `P_BulletSlope` and `P_SpawnPlayerMissile` both aim `16*64` = 1024 units, half
  `MISSILERANGE`; past that vanilla finds nothing and fires flat. `pickMonster` has no distance test
  at all — the ground bound above is not one, since a ray out over open floor keeps going. The real
  bound is
  what the camera draws, roughly 5,000 units (docs/fogofwar.md § Reveal radius), which is the same
  argument `PLAYER_WEAPON_RANGE` already makes for the bullet itself (§ Range).
- **The vertical cone.** `P_AimLineAttack` opens its wedge at `±100/160` (±0.625 slope, ±32°) and
  refuses anything outside it. Nothing here caps the slope: a monster on a high ledge is lockable at
  whatever angle it takes, because the pointer is over it and refusing would read as the click being
  ignored.
- **Sight.** Vanilla's traverse stops at the first wall, so an unreachable monster is simply not a
  target. The pick's equivalents are fog of war (`visible`) — a memory of having seen the room, not
  a live sightline — and the ground bound above, which stops a ray that has gone underground and
  nothing else. So a monster can still be locked through a wall the camera looks over. The shot is
  still stopped by that wall; what carries is the aim.

**`NO_AUTO_AIM_TYPES` (`game/things/tables.ts`) holds the one thing the cursor refuses to lock
onto**: the Icon of Sin's brain (88). Its recess (DOOM2 MAP30 sector 8, floor 288) opens onto the
arena only through the 32-unit slot at 384–416 that the eye watches through, and the brain's `BBRN`
sprite is 87 units tall, so its whole body sits *below* that opening. Measured over 4,891 standable
sample positions on MAP30, a locked-on shot reaches it from four — all of them inside the recess.
The top-down camera looks over the wall and shows you the brain anyway, so hovering it grabbed the
aim and sent every shot into the wall below the slot. Everything else about the brain is unchanged:
it is an ordinary `MONSTER_TYPES` member, still shootable by a free shot, and still counted as a
kill.

**The lock applies on hover, not on click.** Gating it to `input.mouseDown` made `player.angle`
switch sources the instant a click landed, snapping the player round by whatever the monster's
anchor and the cursor's plane point differ by. Aim has always been set from the cursor
unconditionally; the lock has to follow the same rule to stay continuous.

**The camera never sees the lock**, which is why `updateLivingPlayer` returns the cursor's plane
point rather than the aim: docs/camera.md § Aim lead.

**A shoot-triggered line is the second thing aim locks onto**
(`SpecialsController.pickShootTarget`, `game/specials/shootaim.ts`), under the same hover rule: the
pointer over a switch a shot fires aims at that switch. Without it a shoot switch is a strip of wall
a few pixels tall seen almost edge-on from overhead — DOOM2 MAP16's two are 12 and 40 map units long
— and the shot went wherever the cursor's *aim-plane* point happened to fall, which is not where the
wall the eye picked out is drawn. A monster under the same pointer wins: its body would absorb the
shot long before the wall. The candidate set is every line whose special `lookupSpecial` reports as
`trigger: 'shoot'`, scanned once at load and filtered per tic down to the ones that could still fire
— a spent one-shot and a tagless generalized line are both dropped, since aim spent on a line that
does nothing is aim taken away from the shot.

**The pick tests the ray against a line's shootable *bands*, not its whole face.** A band is a
vertical stretch that stops a shot — the wall below the opening and the wall above it, or the whole
face when there is no opening (one-sided, or a two-sided line whose sectors leave no gap, which is
what every two-sided shoot switch in the IWADs turns out to be). A band is the part of the line that
is actually *there* to point at — the opening between them is see-through, and grabbing the aim
there would quietly redirect a shot the player lined up on whatever lies beyond the window. So a
pointer over a real opening picks nothing at all and the shot goes through it as aimed, which still
fires the line's special if the trace crosses it (§ Shoot-triggered specials).

**The aim height is the band closest to the fire height, clamped inside it** — the flattest shot the
line still stops, so the shot ends on the wall the player pointed at rather than climbing past it.
Which band the pointer was over doesn't decide it: both fire the same special, and a steeper shot
only offers more geometry in between to run into. On every shoot switch in DOOM and DOOM2 this comes
out dead flat, so the lock is doing nothing but fixing the *angle*. The clamp keeps `BAND_INSET`
clear of the band's edges, and the aim point the same distance in from the line's ends, because the
shot is re-traced from the player along its own angle: aiming at an edge risks landing a unit the
wrong side of it and passing straight through.

**It takes the same ground bound the body pick does**, plus `PICK_TOLERANCE` of slack along the ray:
the face the ray is *stopped by* is a face it may well be pointing at — a switch on a ledge's lower
band is exactly that — and the two distances come out of different arithmetic, so the boundary case
must not turn on their last bits.

**No `ShotLock` comes with it** — a wall has no silhouette to open a wedge around, and the strict
single ray is the point: a shoot switch behind a step the shot genuinely can't clear must stay
unreachable, or the lock would carry the shot over geometry that should have stopped it.

## Effects and their batching

Impact explosions, blood splashes, bullet puffs and the teleport-fog puff share one mechanism,
`SpriteFxLayer` (`game/spritefx.ts`, `OneShotEffect`/`spawn`/`spawnImpact`): a transient sprite
animation playing once at a fixed spot, outside `ThingLayer` since none of them is a real map
`Thing`. `IMPACT_EFFECTS` maps a projectile's flight sprite to its explosion — vanilla reuses `MISL`
frames B–D for the rocket's blast, while the plasma bolt and BFG ball explode into dedicated
`PLSE`/`BFE1` sprites. Hitscan `Tracer` lines live there too: not sprites, but the same
spawn-animate-drop lifecycle and the same wholesale clear on a level change (`beginLevel`).

Every one-shot effect carries the subsector it was spawned in and is **drawn only where the player
has already seen**, the same fog-of-war gate thing sprites use — a teleport fog or a blood splash in
an unexplored monster closet would otherwise hang lit in the black. Tracers and projectiles are
ungated. See docs/fogofwar.md § How reveal reaches the geometry.

**A tracer's two ends are not equally anchored, and the muzzle end has to move**
(`render/tracer.ts`). The impact end is a genuine world point — the puff or blood splash sits there.
The muzzle end is the shooter's position at trigger-pull, and the shooter keeps moving: a running
player covers 75 map units over `TRACER_LIFETIME`'s 0.15 s, nearly five player radii, so a line
frozen at both ends visibly detaches and hangs in the air behind them. Three rules keep it honest,
all purely presentational and all inside `Tracer` itself, so a monster's tracer gets them for free
with no live-shooter callback. The line **starts `MUZZLE_GAP` past the shooter's own body** — their
radius *plus* the constant, clamped to a fraction of a point-blank shot's own length — so the eye
never expects it to touch the gun in the first place. Added to the radius rather than compared
against it, because the constant then means the same visible clearance whoever fired: measured from
the centre it would be swallowed whole by a wide body, and the **spider mastermind's** radius of 128
against an ordinary monster's 20 is enough to start the line inside its own sprite. That is the
whole reason `addTracer` takes a radius — `PLAYER_RADIUS` for the player, and for a monster
`MonsterAttackEvent.sourceRadius`, which `ThingLayer.update` fills from the firing body's own
`blockRadius` rather than re-reading `MONSTER_STATS` (the sparse-key lookup `blockRadius` exists to
avoid — `game/things/defs.ts`). It then **fades in over `FADE_LENGTH`** from that start, so the end
most likely to be stale is also the faintest, and the tail **retracts toward the impact at
`RETRACT_SPEED`**. Both lengths are absolute map units rather than fractions of the line, for the
same reason: what they exist to cover is a distance the shooter walked, identical on a point-blank
shot and one across the map, so as fractions they would over-treat a long shot and under-treat a
short one. `RETRACT_SPEED` is additionally bounded from below by the player's own top speed, or the
tail trails the shooter instead of clearing them. The line is full-length on the first frame it is
*drawn*, which is what keeps hitscan reading as an instant line rather than as a slow projectile,
the one thing that tells the chaingun apart from the plasma rifle at a glance.

**The fade is three vertices, not a subdivided line.** Vertex 0 is the tail, vertex 1 sits
`FADE_LENGTH` along from it and vertex 2 is the impact; alpha interpolates 0 → 1 across the first
segment and stays at 1 over the second, so a two-segment polyline gives a ramp of fixed length at
any shot length, and the whole thing stays three `setXYZ` calls a tic. RGB stays on `material.color`
and only alpha varies, which still needs the 4-wide `color` attribute — three.js enables
`USE_COLOR_ALPHA` on `itemSize === 4` alone, and a 3-wide one silently drops the fade. The fade
point collapses onto the impact once less than `FADE_LENGTH` of line is left, so a nearly spent
tracer ramps across whatever it has rather than clipping.

**Nothing on a tracer's material is per-instance, so the materials are shared and session-lived**
(`materialFor`) — one per tracer colour, and `Tracer.dispose` drops only its own geometry. A
material built and disposed per tracer makes three.js release the shader program every time the
live count returns to zero, which is every time the player stops firing; a 20-pellet SSG blast
would relink it 20 times in one tic. The vertex layout is laid out *back from the impact* for the
same ownership reason the fade lives in the attribute: the impact is the only end that is a real
world anchor, so it is the one the other two vertices are measured from.

**That "first drawn frame" is why retraction starts at `RETRACT_START`, not at zero.** `fireWeapons`
spawns the tracer and `updateEffects` advances it in the *same* tic (docs/frameloop.md § What runs
in a tic), so it is already one `DOOM_TIC` — a fifth of `TRACER_LIFETIME` — old when it first
appears, and a retraction measured from spawn is visibly under way on the very first frame the
player sees. With the blink hiding every other tic on top of that, an aggressive early retraction
leaves nothing on screen but a stub beside the impact point, which reads as the shot having started
meters away from the player. The tail only ever moves *toward* the impact, which is why the
spawn-time bounding sphere is never recomputed.

`SpriteFxLayer` only draws and ages what it is handed; who spawns what, and every rule about *why*
(`A_Fire`'s sightline, `A_VileAttack`'s reposition) stays with the system that owns the mechanic —
the arch-vile's flame tracks its target through a `VileFlameResolver` callback `MonsterAttacks`
supplies (`game/monsters/attacks.ts`), rather than the layer reaching into monster state.

Those effects and projectiles in flight are drawn through `SpriteFxLayer`'s batch, a second
`SpriteBatch` alongside `ThingLayer`'s, so an `OneShotEffect`/`Projectile` holds a bare
`SpriteAnimator` and owns no `THREE.Object3D`, exactly like `PosedThing`. They were a `SpriteActor`
each until the revenant's homing missile got its real vanilla flight: a missile that flies until it
hits something lives far longer than one detonating on a launch-time budget, and spawns a smoke puff
every 4 tics for the whole flight. On a map with over a thousand revenants that is five figures of
live sprites — the exact wall `SpriteBatch` was written for. The CPU-side per-sprite work is
near-identical either way; the meshes were all of it. It also picks up the same per-instance-colour
fix batching gave map things: sector light used to be written onto the lump's *shared* material, so
every smoke puff on screen (all `PUFF`) took the tint of whichever was posed last.

## How a shot deals damage

**The split that matters first is hitscan vs. projectile, and it is vanilla's own.** A hitscan
pellet is an instant line, so `spawnPlayerShot` settles hit-or-miss on the spot. **A projectile
leaves with no target at all** and re-tests live bodies every frame in `ProjectileLayer.update`
(§ How a projectile finds its target), exactly as a monster's missile does — the lock gives it a
*slope* and nothing else, matching `P_SpawnMissile` fixing `momx/momy/momz` at launch and
`P_XYMovement` then re-running `PIT_CheckThing` per move. Everything in the rest of this section is
about the hitscan half.

**A hitscan pellet resolves two different ways, depending on whether one was locked on.** A
locked-on pellet resolves hit-or-miss against that exact target, and needs **both** halves:
`spawnPlayerShot` compares `shotPath`'s returned distance against the distance to the target to know
whether a wall cut the shot short, *and* tests this pellet's own line against the target's body —
perpendicular offset within `MONSTER_HIT_RADIUS` and, for a pellet carrying a `slopeOffset`,
vertical miss within half of `MONSTER_LOCK_HEIGHT` at the body's distance. A *free* pellet instead
tests its straight flight path against every monster's body (`ThingLayer.raycastMonster`), the way
any real hitscan trace would, so a monster standing between the player and the wall they're shooting
at still gets hit even though it was never clicked; only the nearer of "a wall/step" (`shotPath`)
and "a monster in the way" (`raycastMonster`) stops the shot.

**The lateral test is what keeps the lock from being homing.** `WeaponSystem` offsets each hitscan
pellet by its own spread angle, but the lock is per *trigger pull* — all of a shotgun's pellets
carry the same `target`/`targetId`. Without the lateral test a distance comparison alone said
"connected" for every one of them, so firing either shotgun at a monster dealt all 7 (or 20)
pellets' damage no matter how wide the spread threw them. This is vanilla's own split:
`P_BulletSlope` finds the aim slope once and `A_FireShotgun` then traces each pellet at its own
angle, so the auto-aim decides the *slope* and never the hit. A pellet that fails the test falls
through to the free-shot branch above and can still hit whatever it did fly through. Zero-spread
weapons are unaffected — `player.angle` is set from the same lock (`Math.atan2` toward `aim`, at the
end of `Player.update`, after the frame's movement), so their perpendicular offset is exactly 0.

The vertical half of the test only ever fires for the super shotgun, the one weapon with a
`slopeSpread` (docs/weapons.md § Spread), and only on the locked-on path: the free-shot `raycastMonster` is a 2D ray
that carries no slope of its own, and admits any body inside `P_AimLineAttack`'s aim cone
(§ The vertical test), so a wide pellet's *vertical* miss is not reproduced once it falls through to
that branch.

**Only the locked-on gate uses the shared `MONSTER_HIT_RADIUS`; everything a shot can actually
collide with is tested at its own width.** `raycastMonster` and a projectile's swept contact test
both read `MonsterRef.radius` — `PosedThing.blockRadius`, i.e. that type's exact `mobjinfo.radius`,
the same 10-128 unit table movement collision already used. A single 24-unit hitbox happens to be
about right for an imp (20) and is wrong by a factor of two or more for a cacodemon (31), mancubus
(48), arachnotron (64) and spider mastermind (128), which a shot could thread straight through
inside its visible bulk. Vanilla's `PIT_AddThingIntercepts` tests the trace against each thing's
real bounding box, so per-species *is* the vanilla rule. Keeping the lock on the shared box costs
nothing: a pellet that fails it falls through to `raycastMonster`, which then tests that same body
at full width.

**Nothing in the engine converts a box to a circle any more.** Vanilla collides axis-aligned
squares, and both shot tests are now the real thing — `util/geom.ts`'s `traceHitsBox` for a hitscan
and `segmentEntersBox` for a missile in flight, matching movement, which clips the same box
(docs/movement.md § Collision).

**A hitscan's width is direction-dependent, and that is the whole of `PIT_AddThingIntercepts`.**
Vanilla does not test the box: it tests **one of the box's two diagonals**, picked by whether the
trace's `dx` and `dy` share a sign. That is exact rather than approximate — the chosen diagonal's
endpoints are precisely the two corners bounding the box's silhouette from that bearing, so crossing
it is equivalent to crossing the box, in one segment test instead of four. The effective half-width
is therefore `h·(|sin θ| + |cos θ|)`: `h` head-on, `h·√2` at 45°.

This replaced a single circle of radius `4h/π ≈ 1.273h`, chosen because a square of half-width `h`
presents mean width `perimeter/π` to a line on an arbitrary bearing. That average was *right* — the
mean of `h·(|sin θ| + |cos θ|)` over all bearings is exactly `4h/π` — so the change does not move
the overall hit rate. It redistributes it by angle: a shot straight down an axis is now 21% narrower
than the circle allowed, one on the diagonal 11% wider.

One consequence worth knowing: a hitscan resolves at its crossing with the **diagonal**, not at the
box's near face, so a shot straight down the middle of a body reports the body's own centre — which
is where the puff or blood belongs.

Body *height* is per-species too, `mobjinfo.height`'s real 56-110 carried on each body as
`PosedThing.bodyHeight` and handed out on `MonsterRef.height`. It was one shared 64 until heights
started gating *movement* as well as shots (docs/monster-ai.md § Movement): a figure taller than the
56 most of the roster is and half a cyberdemon's 110 made crushers catch bodies they shouldn't and
miss ones they should. The one place a shared box survives is the **locked pellet's own hit gate**
in `spawnPlayerShot` (`MONSTER_HIT_RADIUS`/`MONSTER_LOCK_HEIGHT`), which is shared on purpose so the
lock can't behave like homing — see `MONSTER_HIT_RADIUS`. Note that is no longer the same box the
*pick* uses: what the pointer may grab is per-species (§ Auto-aim), while whether this pellet then
connects is still measured against the shared one.

For a hitscan pellet damage is applied immediately (an instant line has no travel time); for a
projectile it is carried on the `Projectile` and applied wherever `ProjectileLayer.update` finds it
connecting.

## The vertical test

**`raycastMonster` gates a body vertically on a slope span at that body's own distance, never on a
flat height band around the fire height.** Vanilla's `PTR_AimTraverse` and `PTR_ShootTraverse`
(`p_map.c`) both work out `thingtopslope = (th->z + th->height - shootz) / dist` and
`thingbottomslope = (th->z - shootz) / dist` and skip the thing when that pair lies wholly outside
the trace's own `[bottomslope, topslope]` — "shot over the thing" / "shot under the thing". The two
differ in one thing only, which span they carry: an **aim** (`P_AimLineAttack`) searches the
`±AIM_SLOPE_LIMIT` cone (`topslope = 100*FRACUNIT/160`), a **fired shot** collapses it to the single
`aimslope` it was handed. `raycastMonster` reproduces both through one `opts.slope` — omitted for
the cone, supplied for a shot that already has a slope.

Which callers get which follows vanilla: the BFG spray (`A_BFGSpray` calls `P_AimLineAttack`), the
player's fist and chainsaw (`A_Punch`/`A_Saw`) and a free player pellet (`P_BulletSlope`) are all
aims and take the cone; a monster's bullet already carries the slope `shotPath` sloped it to
(`monsters/attacks.ts: resolveBullet`) and passes that, so another monster blocks the bolt only
where the bolt genuinely crosses its body.

**A pellet the spread threw off a *locked* target passes its slope too**, and that is the one thing
here that is not simply vanilla's split. Such a pellet falls through to this same trace
(§ How a shot deals damage) carrying the slope the lock resolved — `ShotPath.slope`, returned by
`shotPath` rather than recovered from `(z - origin.z) / dist`, which a zero-length path loses
outright — so a body blocks it only where the line genuinely crosses one — which is what lets the super shotgun's vertical spread miss. Given the
cone instead, the trace re-admitted the very body the lock's own vertical gate had just rejected, so
`slopeSpread` could never throw a pellet off a target at all.

**The flat band this replaced made a monster standing below or above the shooter unhittable.** The
old gate rejected any body whose feet were more than its own height from the fire height, which is a
±64 window for a mancubus and pays no attention to how near it is standing. Repro: NoSp2.wad MAP04,
the mancubus pen around (1100, -3970), whose floor sits 64 below the ledge the player fights it from
— the aim height is then 96 above the mancubi's feet, and the BFG's 40-ray spray, which is that
weapon's entire damage (§ Splash and the BFG), passed through the whole group without touching one
of them.

## How a projectile finds its target

**A projectile has no target — it has a flight, and finds whatever is in it.** Every shot in the
air, the player's own included, re-tests live bodies each frame in `ProjectileLayer.update`
(`playerStruckBy`, `bodyStruckBy`, both over `spritefx/defs.ts`'s `stepTouchesBody`). What
`spawnPlayerShot` fixes at launch is the slope and the wall (`shotPath`), never who gets hit.

Resolving that at launch instead is what made **BFG balls pass through monsters**. The ball flies at
875 units/sec, so over a 512-unit shot a target has half a second to walk out of a launch-time ray —
and an imp covers ~160 units in that time. A locked ball also damaged that exact ID wherever it
happened to arrive, so the same bug read as a phantom hit on a monster that had moved. It showed up
on the BFG first because it is the one projectile with no splash to cover a miss (`A_Explode` is
never called on `MT_BFG`), and because the ball's own contact damage is 100-800.

The contact test itself is `PIT_CheckThing`, both halves:

- **Laterally**, `thing->radius + tmthing->radius` — the body's own radius plus the *missile's*
  (`PROJECTILE_RADIUS`, from each missile type's `mobjinfo.radius`: 6 for the imp, cacodemon, baron
  and mancubus fireballs, 11 for `MT_ROCKET` and the revenant's `MT_TRACER`, 13 for `MT_PLASMA`,
  `MT_BFG` and `MT_ARACHPLAZ`) — an axis-aligned box on that sum, `segmentEntersBox`, unlike the
  diagonal test a *hitscan* gets. Vanilla really does use two different shapes here:
  `PIT_CheckThing` is a plain `abs(dx) >= blockdist || abs(dy) >= blockdist`.
- **Vertically**, the asymmetric over/under pair: a miss overhead above `body.z + height`, a miss
  underneath below `body.z` by more than the missile's own 8-unit height. Not a ± tolerance either
  side of the feet — a fireball level with your knees connects and one clearing your head does not,
  which a symmetric band cannot express.

**The test is swept across the frame's whole step, not sampled at its end.** `game.ts` clamps `dt`
at 0.05s and the fastest missiles fly 875 units/sec, so one frame can carry a shot 43 units —
further than a body is wide. Sampling endpoints silently drops every graze whose closest approach
falls between two frames, which gets worse the lower the frame rate. `stepTouchesBody` returns
*where along the step* contact happened, which is also what orders multiple candidates: first along
the flight wins, the swept equivalent of vanilla's blockmap traversal order.

A struck body ends the flight, so it fires no shoot-triggered special — the missile never reached
the wall whose `lineIndex` it carries.

**Fog of war doesn't hide a body from a projectile**, unlike `raycastMonster`, where the filter
keeps the auto-aim lock and a free bullet off monsters the player has never seen. A missile in
flight is a physical thing that has to collide with whatever is actually there, and `monstersNear`
already resolves splash the same way — a rocket fired down an unrevealed corridor explodes on what
is in it.

**Splash damage is separate from a direct hit and reaches everyone nearby regardless of what was
targeted** — a rocket fired at a bare wall still explodes and can hurt a monster standing close by.
`applyRadiusDamage` (`game/combat.ts`, shared by projectile splash, the barrel and the arch-vile's
blast) walks every living monster `ThingLayer.monstersNear` returns within the blast
radius, skips anyone `hasLineOfSight` says is blocked, and falls off linearly to 0 at the radius
edge, matching `P_RadiusAttack`. It uses `hasLineOfSight`, deliberately not `shotPath` — that models
a directed weapon's own blocking rules, not "does this omnidirectional blast reach that point".

## Where a missile starts

**A missile leaves at `MISSILE_HEIGHT_OFFSET` (feet + 32), four units below the height a bullet
traces from.** Vanilla splits the two: `P_SpawnPlayerMissile` (`p_mobj.c`) spawns at
`source->z + 4*8*FRACUNIT`, while `P_LineAttack` traces from `shootz` = `z + height/2 + 8`
(`p_map.c`) — which is `AIM_HEIGHT_OFFSET`, and stays the plane the cursor is projected onto
(docs/camera.md § Aim lead). One deliberate departure: the slope is resolved from where the missile
actually starts rather than from `shootz`, so it still arrives under the crosshair. Vanilla, which
never shows you your own body, resolves the slope from `shootz` and launches four units under it.

**Every missile is then moved half a tic of its own momentum forward before anything draws or tests
it** — `ProjectileLayer.checkMissileSpawn`, vanilla's `P_CheckMissileSpawn` (`th->x += th->momx>>1`,
`p_mobj.c`). That is 12.5 map units for a plasma bolt or a BFG ball (`mobjinfo` speed 25) and 10 for
a rocket (20). The nudge is clamped to the flight `shotPath` resolved, which stands in for vanilla's
`P_TryMove` failing there: a missile launched at a wall a few units off arrives on its first step
and explodes against it. The gap it skips is never swept for bodies, exactly as vanilla's own
`P_TryMove` tests only the destination.

Both rules are invisible in vanilla and not here: this view draws the shooter's own body, so a
missile born at the centre of the player's billboard reads as coming out of the marine's head.

## Where an impact sits

**A missile's flight ends `PROJECTILE_RADIUS` short of the wall it is stopped by**, never further
back than it has travelled. That is where vanilla stops one: `P_XYMovement` explodes a missile on a
*failed* `P_TryMove` (`p_mobj.c`), and `P_TryMove` is atomic — the mobj keeps its last valid
position rather than advancing to the plane — while `PIT_CheckLine` refuses a one-sided line as soon
as the radius-inflated `tmbbox` (`x ± radius`, `P_CheckPosition`) crosses it. The explosion, its
splash and its sound all sit there together. The hitscan counterpart is `PUFF_WALL_OFFSET`
(§ Bullet puffs).

Approximate in two ways vanilla is not: vanilla's box is axis-aligned, so a diagonal wall stops the
centre further out than `radius`, and its movement step quantises the stop point.

**The standoff belongs to the flight, not to a correction applied where the flight is read.** Each
kind resolves its own wall and applies it there: a straight shot at launch (`missileFlight` shortens
`maxDist`, and takes the height from `ShotPath.slope` — shortening the distance alone would steepen
the flight), a revenant's tracer mid-flight, where `projectileStepBlocker` reports the plane
(`advanceHoming`). It was one shared pull-back on the arrival point instead, which left the missile
standing *on* the plane for everything else that read it — and `sectorIndexAt` there answers with
the solid sector behind the wall (floor == ceiling), which then had to be gated out of the
floor/ceiling test separately. Two patches on one bad point.

`shotPath` still returns the exact plane crossing, and an effect spawned there resolves its
subsector to whichever side of the BSP splitter the point falls on. A far-side leaf the player has
never seen is skipped by the fog gate (§ Effects and their batching), so without the standoff the
rocket, plasma and BFG explosions were **not drawn at all** against those walls. Repro: DOOM2
MAP01's start room, whose north wall (lines 22-25) puts every impact in subsector 184 behind it.
`tests/regression/impact-on-wall-plane.test.ts` pins both flights — only the straight one was
covered when the standoff moved, and the homing one silently went back to exploding on the plane.

**A wall beats the floor on the tic both would answer to.** `P_MobjThinker` runs `P_XYMovement`
before `P_ZMovement`, and `P_ExplodeMissile` clears `MF_MISSILE` — the flag gating both of
`P_ZMovement`'s explosion branches (`p_mobj.c`). Only a wall arrival wins that way: range simply
running out is not something that stopped the missile, so it does not suppress the floor test.

## Blood

**Blood is spawned by a trace hitting a body, not by damage** — vanilla puts `P_SpawnBlood` in
`PTR_ShootTraverse`, i.e. only on the `P_LineAttack` path. So the player's hitscan pellets
(`spawnPlayerShot`), the fist/chainsaw swing (its melee branch) and a monster's hitscan bolt
(`game/monsters/attacks.ts: MonsterAttacks.resolveHitscan`) all splash, and everything reaching
`P_DamageMobj` by another route does not: a projectile's direct hit, splash, the BFG spray
(`A_BFGSpray` damages and spawns `MT_EXTRABFG` itself, never blood), a damage floor.
Don't "fix" the missing cases — a rocket that made a monster bleed would be wrong.

**The crusher is the one exception, and it is vanilla's own.** `PIT_ChangeSector` spawns `MT_BLOOD`
itself, beside the `P_DamageMobj` call in its crush branch — not through `P_SpawnBlood`, so the
splash starts at `S_BLOOD1` whatever the damage, it comes out of the body's middle rather than where
a trace stopped, and it is **thrown**: `momx`/`momy` off the random table, and a fall to the floor,
`MT_BLOOD` carrying no `MF_NOGRAVITY`. `SpriteFxLayer.spawnCrushBlood` is that one and
`OneShotEffect.motion` is the only moving-effect machinery here besides the arch-vile's following
flame; docs/specials-crushers.md § Crushers owns the rest.

`SpriteFxLayer.spawnBlood` is one `OneShotEffect` like any other. Two details are vanilla's and look
arbitrary: the frame letters run **backwards** (`S_BLOOD1`-`3` are `BLUD` C, B, A at 8 tics each),
and the hit's damage picks which state the splash *starts* in (`bloodFrames`: under 9 shows only
`A`, 9-12 `B`→`A`, above 12 all three) — so weapon power reads off the size of the splash. The
±4-unit `HIT_Z_JITTER` is `P_SpawnBlood`'s own `(P_Random()-P_Random())<<10` (`P_SpawnPuff` opens
with the identical line), drawn off the random table like every other fuzz in the game
(docs/random.md § The triangular draw), and is what keeps a shotgun's pellets from stacking their
splashes into one sprite — the table has no two adjacent entries equal, so the jitter is never
exactly zero. `P_SpawnBlood`'s brief upward hop (`momz = 2` falling back under gravity) is
deliberately **not** reproduced: it peaks about 3 units, which from overhead is nothing, and a
splash that stays put is one `OneShotEffect.motion` less to integrate. The *crusher's* splash does
move, and its `momx`/`momy` are far too big to drop — docs/specials-crushers.md § Crushers.

**`ThingLayer.bleeds` is vanilla's `MF_NOBLOOD` flag**, which in all of stock DOOM exactly one thing
carries — `MT_BARREL`, which takes a bullet puff instead. It is keyed by ID rather than type because
a locked-on shot only ever knows the ID it hit, and it deliberately ignores `dead`, so the killing
blow still bleeds regardless of which side of `damage` the caller asks from. The player has no
`MF_NOBLOOD` either and bleeds on a monster's bolt, before the armor calculation and unaffected by
it — `PTR_ShootTraverse` spawns blood ahead of its `P_DamageMobj` call, so an invulnerable player
still splashes.

## Bullet puffs

**The puff is blood's other half, from the same two lines of `PTR_ShootTraverse`**: a hitscan trace
that stops on a body spawns one or the other (`ThingLayer.bleeds`), and one that stops on *geometry*
always spawns a puff. So the same three shooters that can splash blood — the player's pellets, the
fist/chainsaw swing, a monster's bolt — are the only sources, and `MT_PUFF`'s four `PUFF` frames run
forwards at 4 tics each (`S_PUFF1`-`4`), unlike the blood's backwards three.

`SpriteFxLayer.spawnWallPuff` (`game/spritefx.ts`, shared by the player's pellet and
`resolveHitscan`) owns the geometry case and **skips two things vanilla also skips**:

- A shot that ran out of range without crossing a blocking line (`ShotPath.lineIndex === null`).
  Vanilla only reaches `P_SpawnPuff` from the `hitline` label, never from the trace simply ending.
- Sky (`World.hitsSky`, vanilla's "don't shoot the sky!"): the shot is above a sky ceiling, or the
  line is a two-sided *sky-hack wall* with sky on both sides — the seam between two open-air
  sectors, which is a wall to a shot but nothing to draw an impact on. Confirmed reachable: on
  DOOM2 MAP01, 9 of the 36 sky-hack lines stop a flat shot fired at them, and its 11 zero-height
  sky "pillars" (floor == ceiling, e.g. lines 200-205) put every shot above their ceiling. The
  shoot-triggered special still fires either way — `P_ShootSpecialLine` runs *before* this test.

The wall puff sits `PUFF_WALL_OFFSET` (4 units, vanilla's `frac - 4/attackrange`) back along the
shot so the sprite doesn't straddle the wall it marks. The 10-unit pullback vanilla applies to a
*body* hit is deliberately not reproduced for either puff or blood: `raycastMonster` returns the
hitbox's centre-projection rather than vanilla's exact crossing, so pulling back 10 there would walk
the sprite off the front of the body instead of onto it.

**The fist doesn't spark and the chainsaw does**, which is a real vanilla mechanism rather than a
per-weapon flag: `P_SpawnPuff` skips to `S_PUFF3` (`PUFF_MELEE_FRAMES`) when `attackrange ==
MELEERANGE`, and `A_Saw` therefore traces `MELEERANGE+1` — with its own comment saying so — purely
to dodge that test. `WEAPONS.chainsaw.meleeRange` carries the `+1` and `spawnPlayerShot` compares
`shot.range` against `PLAYER_MELEE_RANGE`, so the mechanism is reproduced, not the outcome. In this
engine it only ever shows on a barrel: a melee swing never traces geometry at all (docs/weapons.md § WeaponSystem),
so unlike vanilla it can't puff against a wall.

`S_PUFF1`'s `FF_FULLBRIGHT` is reproduced the way every fullbright frame is — `PUFFA` is in
`FULLBRIGHT_FRAMES`, and `SpriteFxLayer.batchSprite` lights it at 255 for that one frame before the
puff dims to its sector (docs/sprites.md § Fullbright frames). `A_Tracer`'s own `P_SpawnPuff`
(vanilla spawns a puff *and* an `MT_SMOKE` behind the revenant's missile every 4th tic) is left
out: it would double the trail's live sprite count, which docs/monster-attacks.md § The
revenant's homing missile records as the reason the batch exists at all.

## Splash and the BFG

**A splash's radius and damage are a fixed pair on the weapon, independent of that shot's own random
direct-hit roll** — `WeaponDef.splash`, not derived from `damageDiceSides`/`Multiplier` as an
earlier version wrongly assumed. `A_Explode` really does pass a constant 128/128 to
`P_RadiusAttack`, separate from the missile's `(P_Random()%8+1)*20` contact roll; conflating them
made splash swing with the same small random roll as contact damage.

**Range is measured to a body's *edge*, on the Chebyshev metric** — `util/geom.ts:
blastDistanceToBox`, vanilla's `PIT_RadiusAttack`: `dist = (max(|dx|, |dy|) - thing->radius)`,
clamped at 0. Neither half is cosmetic. Subtracting the body's own radius means a wide monster is
both caught from further out and hurt harder at any range, and the Chebyshev metric is the same box
the rest of the engine collides. A 48-radius mancubus 100 units from a barrel takes `128 - 52` = 76;
measuring centre-to-centre — what this did until the collision model became a box throughout —
gave it 28, under-damaging exactly the monsters explosions are aimed at by nearly 3×.

Vanilla carries **one** number where `applyRadiusDamage` takes two: `P_RadiusAttack(spot, source,
damage)` uses `damage` as the range too, so its falloff is a plain `bombdamage - dist`. Every call
site here passes `radius === maxDamage` (barrel 128/128, cyberdemon rocket 128/128, arch-vile blast
70/70), which makes `maxDamage * (1 - dist / radius)` exactly that; the pair stays split only so a
caller could tune them apart.

**The spider mastermind and the cyberdemon take no splash damage at all**, direct hits only —
`PIT_RadiusAttack` skips them outright, and `applyRadiusDamage` reproduces that by type before it
measures anything. This is the exemption the BFG spray and the monster-attack doc both defer to; it
is implemented once, here, so a rocket into a cyberdemon's feet does nothing and the rocket that
hits it does full damage.

**`hitsPlayer` gates whether a splash can hurt the player who fired it** — `true` for the rocket
(vanilla lets a rocket's blast hurt whoever fired it, the classic rocket-jump self-damage), so
`applyRadiusDamage` includes the player as a candidate. The BFG sets `splash` to `null` outright:
its ball never calls `A_Explode` at all, so there's no radius blast to gate.

**The BFG's actual damage is `WeaponDef.spray`, vanilla's real `A_BFGSpray`** (`resolveBfgSpray`,
called from `ProjectileLayer.update` the instant the ball reaches wherever it's going). It is
nothing like a radius blast: 40 rays fan out across a 90° arc (every 2.25°) centered on the ball's
own fixed flight angle (`Projectile.angleRad` — the ball never homes), each an independent
`ThingLayer.raycastMonster` trace out to 1024 units (`16*64`, `P_AimLineAttack`'s own distance) —
that function's own aim cone included, § The vertical test — that, if it connects, deals a full
undiminished direct hit — the sum of 15 rolls of a d8 (15-120), with no distance falloff at all. Two
things make it genuinely different from a radius blast:

- **It's traced from the player's own live position at the moment the ball dies, not from the impact
  point.** `A_BFGSpray` reads `mo->target` — the shooter, still a live pointer — at that instant;
  after ~1.5s of the ball's slow flight the player can be well behind where it detonated.
  `resolveBfgSpray` takes only the ball's travel *angle* and rebuilds the fan from
  `this.player.x/y/z`.
- **Nothing stops two, or all 40, rays landing on the same target.** A monster directly in front of
  the player can eat several rays at once, each its own full roll — this, not a bigger radius, is
  the source of the BFG's reputation against one big target.

`resolveBfgSpray` draws no line for the rays — `A_BFGSpray`'s traces are pure math in vanilla too,
never rendered, and an earlier approximated splash drew a green tracer purely to make its damage
legible. **Every ray that connects spawns vanilla's own `MT_EXTRABFG`** on the monster it hit
(`BFG_SPRAY_HIT_FRAMES`, `BFE2A0`-`D0`, confirmed against the real `DOOM2.WAD` lump names) placed a
quarter of the way up the target — vanilla's `linetarget->height>>2`, off that body's own
`mobjinfo.height` (`MonsterRef.height`). Spawned once *per connecting ray*, unconditionally,
matching the `P_SpawnMobj` call inside vanilla's loop — a target caught by several rays gets several
overlapping bursts, which is the flickering green flash a BFG'd monster shows in real vanilla.
`BFE1` (the ball's own impact where it physically stopped) and `BFE2` are two separate sprites for
two separate events.

Per-weapon direct-hit damage rolls follow vanilla's `((rand % sides) + 1) * multiplier` shape and
are lifted rather than tuned by feel, same reasoning as ammo-per-shot — they decide how tough a
fight is.
