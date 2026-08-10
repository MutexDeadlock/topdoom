# Shots: paths, hits and effects

`src/game/projectiles.ts`, `src/game/combat.ts`, `src/game/world.ts: shotPath`,
`src/render/tracer.ts`, `src/game/spritefx.ts`, `src/game/spritefxdefs.ts`, `src/game/things.ts`,
`src/game/thingdefs.ts`, `src/game.ts`

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
height test lets a rocket sail through a knee-high step because the opening beyond it was tall enough
for *sight*.

Deliberately **not** `isSolidWall`, and reusing the movement-blocking predicate for shots was a
shipped bug: it made a shot treat a `BLOCKING`-flagged two-sided line (a barred window/railing) as
impassable like a real wall, when `PTR_ShootTraverse` never reads `ML_BLOCKING` at all — only
movement does. DOOM2 MAP01's east imp closet (sector 38) has exactly this kind of fence, and the bug
blocked both the player's shots at the imp and the imp's fireballs back through it.

**Locked-on shot** (auto-aim target, or a monster's own shot at the player): slopes from the
shooter's fire height to the target's over exactly the distance between them, and stops *at* the
target. A separate `lockedOn` parameter (default: on whenever a `target` is given) switches the
blocking test from the single fixed ray to a **slope wedge** — vanilla's `P_AimLineAttack`: start
from the span of slopes reaching any part of the target (`shotTargetHalfHeight`, the same
"feet-to-head, any part counts" idea `hasLineOfSight` uses), narrow `[bottomSlope, topSlope]` against
every opening crossed in increasing distance order, and stop at the first line where the wedge
collapses. A monster's own fired shot passes `lockedOn: false`: it needs the slope-toward-target
behavior but has no "you clicked it" promise to honor, so it stays on the strict single ray.

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
and projectiles visibly begin in mid-air rather than at the gun. Blocking is evaluated at the
interpolated height where the ray crosses each candidate line, not one height for the whole flight.
Candidate lines are extended `WALL_OVERLAP` past both ends for the same reason `FogOfWar` extends
its sight blockers: two walls meeting at a shared vertex otherwise let a shot aimed at that corner
slip between them.

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

**A locked-on shot ignores all three and stops at its target**, which is `range`'s default whenever
`target` is given — see § shotPath for why aim and distance are separate parameters at all. Note this
makes the lock, not `PLAYER_WEAPON_RANGE`, the real bound on a clicked shot; the cursor can only lock
what the camera draws, so it never reaches further than the player can see.

Which of the three a player's shot gets is `world.ts: playerShotRange` — its own function rather
than an expression inside `ProjectileLayer.spawnPlayerShot` so that the choice is testable without
the layer's five collaborators. `tests/regression/player-shot-range.test.ts` guards both it and the
2048/8192 split, on the corridor from the repro above.

## Shoot-triggered specials

**`shotPath`'s returned `lineIndex` — whichever line stopped the shot, or null if it reached its
target or ran out its range — drives `wad/specials.ts`'s three impact specials, 24/46/47**
(`SpecialsController.triggerShot`, vanilla's `P_ShootSpecialLine`). A hitscan pellet's trigger fires
immediately in `spawnPlayerShot`/`MonsterAttacks.resolveHitscan` (resolved and gone within the same frame, matching
`PTR_ShootTraverse`), but a projectile's is deferred to the frame it actually *arrives* at that wall
in `ProjectileLayer.update` — vanilla calls `P_ShootSpecialLine` for a missile from `PIT_CheckLine`, which
only runs once the missile reaches the line. `Projectile.lineIndex` carries the line found at launch
forward (safe to resolve early, same as `maxDist` itself: static geometry doesn't move mid-flight).
Either way, the special only fires if nothing closer — a monster's body, or the player — absorbed the
shot first: `reachedPlayer` and `struck` both take priority over the wall, as does a missile stopped
by the floor, which never got there either.

24 and 47 reuse the plain `FloorEffect` machinery already built for their walkover/switch siblings
(5/64/91/101 and 20/68/22/95), just tag-triggered by a shot. **Only 46 can be triggered by a
monster's own shot** — `SpecialDef.monsterCanTrigger`, reproducing a hardcoded per-number exception
in `P_ShootSpecialLine` itself (`if (!thing->player)` rejects every case *except* 46) rather than
some general property of shoot-triggers. Getting 46's repeatability backwards was a real mistake
caught while adding the other two: `P_ChangeSwitchTexture(line, useAgain)` clears `line->special`
when `useAgain` is falsy, and 46 passes `1` (repeatable, GR) while 24 and 47 both pass `0` (one-shot,
G1).

## Auto-aim

**Auto-aim is click-to-target, not vanilla's autoaim cone** — this game has a mouse pointer, so "aim
at that one" is expressible directly. `ThingLayer.pickMonster` raycasts the cursor through
`SpriteBatch.raycast` (docs/sprites.md § Batching) with a predicate accepting `MONSTER_TYPES` **and
the exploding barrel**, minus anything already dead, picked up, `NO_AUTO_AIM_TYPES`, or not currently
`visible` — the last so a fog-of-war-hidden monster can't be targeted through the geometry hiding it.
It returns the hit monster's position *and* its sector's live floor height. `game.ts` uses that as both the aim point and the shot's end height. It supplies the shot's aim
*direction and slope* only — whether any one pellet lands is still resolved geometrically against the
target's body, so a spread weapon spreads (§ How a shot deals damage).

**`NO_AUTO_AIM_TYPES` (`game/thingdefs.ts`) holds the one thing the cursor refuses to lock onto**:
the Icon of Sin's brain (88). Its recess (DOOM2 MAP30 sector 8, floor 288) opens onto the arena only
through the 32-unit slot at 384–416 that the eye watches through, and the brain's `BBRN` sprite is 87
units tall, so its whole body sits *below* that opening. Measured over 4,891 standable sample
positions on MAP30, a locked-on shot reaches it from four — all of them inside the recess. The
top-down camera looks over the wall and shows you the brain anyway, so hovering it grabbed the aim
and sent every shot into the wall below the slot. Everything else about the brain is unchanged: it is
an ordinary `MONSTER_TYPES` member, still shootable by a free shot, and still counted as a kill.

**The lock applies on hover, not on click.** Gating it to `input.mouseDown` made `aim` — which drives
`player.angle` *and* the camera's aim-lead — switch sources the instant a click landed, and since a
monster is normally much nearer than the cursor's floor-plane projection, the camera's lead offset
collapsed at that moment and read as the camera lurching backwards. Aim has always been set from the
cursor unconditionally; the lock has to follow the same rule to stay continuous.

## Effects and their batching

Impact explosions, blood splashes, bullet puffs and the teleport-fog puff share one mechanism, `SpriteFxLayer`
(`game/spritefx.ts`, `OneShotEffect`/`spawn`/`spawnImpact`): a transient sprite animation playing
once at a fixed spot, outside `ThingLayer` since none of them is a real map `Thing`. `IMPACT_EFFECTS` maps a projectile's
flight sprite to its explosion — vanilla reuses `MISL` frames B–D for the rocket's blast, while the
plasma bolt and BFG ball explode into dedicated `PLSE`/`BFE1` sprites. Hitscan `Tracer` lines live
there too: not sprites, but the same spawn-animate-drop lifecycle and the same wholesale clear on a
level change (`beginLevel`).

`SpriteFxLayer` only draws and ages what it is handed; who spawns what, and every rule about *why*
(`A_Fire`'s sightline, `A_VileAttack`'s reposition) stays with the system that owns the mechanic —
the arch-vile's flame tracks its target through a `VileFlameResolver` callback `MonsterAttacks`
supplies (`game/monsters/attacks.ts`), rather than the layer reaching into monster state.

Those effects and projectiles in flight are drawn through `SpriteFxLayer`'s batch, a second `SpriteBatch`
alongside `ThingLayer`'s, so an `OneShotEffect`/`Projectile` holds a bare `SpriteAnimator` and owns
no `THREE.Object3D`, exactly like `PosedThing`. They were a `SpriteActor` each until the revenant's
homing missile got its real vanilla flight: a missile that flies until it hits something lives far
longer than one detonating on a launch-time budget, and spawns a smoke puff every 4 tics for the
whole flight. On a map with over a thousand revenants that is five figures of live sprites — the
exact wall `SpriteBatch` was written for. The CPU-side per-sprite work is near-identical either way;
the meshes were all of it. It also picks up the same per-instance-colour fix batching gave map
things: sector light used to be written onto the lump's *shared* material, so every smoke puff on
screen (all `PUFF`) took the tint of whichever was posed last.

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
perpendicular offset within `MONSTER_HIT_RADIUS` and, for a pellet carrying a `slopeOffset`, vertical
miss within half of `MONSTER_HIT_HEIGHT` at the body's distance. A *free* pellet instead tests its
straight flight path against every monster's body (`ThingLayer.raycastMonster`), the way any real
hitscan trace would, so a monster standing between the player and the wall they're shooting at still
gets hit even though it was never clicked; only the nearer of "a wall/step" (`shotPath`) and "a
monster in the way" (`raycastMonster`) stops the shot.

**The lateral test is what keeps the lock from being homing.** `WeaponSystem` offsets each hitscan
pellet by its own spread angle, but the lock is per *trigger pull* — all of a shotgun's pellets carry
the same `target`/`targetId`. Without the lateral test a distance comparison alone said "connected"
for every one of them, so firing either shotgun at a monster dealt all 7 (or 20) pellets' damage no
matter how wide the spread threw them. This is vanilla's own split: `P_BulletSlope` finds the aim
slope once and `A_FireShotgun` then traces each pellet at its own angle, so the auto-aim decides the
*slope* and never the hit. A pellet that fails the test falls through to the free-shot branch above
and can still hit whatever it did fly through. Zero-spread weapons are unaffected — `player.angle` is
set from the same lock (`Math.atan2` toward `aim`, at the end of `Player.update`, after the frame's
movement), so their perpendicular offset is exactly 0.

The vertical half of the test only ever fires for the super shotgun, the one weapon with a
`slopeSpread` (§ Spread), and only on the locked-on path: the free-shot `raycastMonster` is a 2D ray
with a crude height band and models no slope at all, so a wide pellet's *vertical* miss is not
reproduced once it falls through to that branch.

**Only the locked-on gate uses the shared `MONSTER_HIT_RADIUS`; everything a shot can actually
collide with is tested at its own width.** `raycastMonster` and a projectile's swept contact test both
read `MonsterRef.radius` — `PosedThing.blockRadius`, i.e. that type's exact `mobjinfo.radius`, the
same 10-128 unit table movement collision already used. A single 24-unit hitbox happens to be about
right for an imp (20) and is wrong by a factor of two or more for a cacodemon (31), mancubus (48),
arachnotron (64) and spider mastermind (128), which a shot could thread straight through inside its
visible bulk. Vanilla's `PIT_AddThingIntercepts` tests the trace against each thing's real bounding
box, so per-species *is* the vanilla rule. Keeping the lock on the shared box costs nothing: a pellet
that fails it falls through to `raycastMonster`, which then tests that same body at full width.

**Every box↔circle conversion goes through `util/geom.ts`'s `boxToCircleRadius`.** Vanilla collides
axis-aligned squares; this engine tests circles. A square of half-width `h` presents mean width
`perimeter/π` to a line arriving on an arbitrary bearing, so the circle costing the same average
number of hits has radius `4h/π ≈ 1.273h`, not `h` — the same argument `MONSTER_BULLET_SLOP`
(docs/monster-attacks.md) already made by hand for the player's own 16-unit box. Applying `h`
directly instead would quietly narrow every hitbox in the game by 21%.

Body *height* stays the shared `MONSTER_HIT_HEIGHT`/`PLAYER_HEIGHT` approximation rather than
vanilla's per-species 56-110. Deliberate: the top-down camera makes height the axis a player can
least judge, and unlike the radius it has never been the cause of a reported miss.

For a hitscan pellet damage is applied immediately (an instant line has no travel time); for a
projectile it is carried on the `Projectile` and applied wherever `ProjectileLayer.update` finds it
connecting.

## How a projectile finds its target

**A projectile has no target — it has a flight, and finds whatever is in it.** Every shot in the air,
the player's own included, re-tests live bodies each frame in `ProjectileLayer.update`
(`playerStruckBy`, `bodyStruckBy`, both over `spritefxdefs.ts`'s `stepTouchesBody`). What
`spawnPlayerShot` fixes at launch is the slope and the wall (`shotPath`), never who gets hit.

Resolving that at launch instead is what made **BFG balls pass through monsters**. The ball flies at
875 units/sec, so over a 512-unit shot a target has half a second to walk out of a launch-time ray —
and an imp covers ~160 units in that time. A locked ball also damaged that exact id wherever it
happened to arrive, so the same bug read as a phantom hit on a monster that had moved. It showed up
on the BFG first because it is the one projectile with no splash to cover a miss (`A_Explode` is never
called on `MT_BFG`), and because the ball's own contact damage is 100-800.

The contact test itself is `PIT_CheckThing`, both halves:

- **Laterally**, `thing->radius + tmthing->radius` — the body's own radius plus the *missile's*
  (`PROJECTILE_RADIUS`, from each missile type's `mobjinfo.radius`: 6 for the imp, cacodemon, baron
  and mancubus fireballs, 11 for `MT_ROCKET` and the revenant's `MT_TRACER`, 13 for `MT_PLASMA`,
  `MT_BFG` and `MT_ARACHPLAZ`), through `boxToCircleRadius`.
- **Vertically**, the asymmetric over/under pair: a miss overhead above `body.z + height`, a miss
  underneath below `body.z` by more than the missile's own 8-unit height. Not a ± tolerance either
  side of the feet — a fireball level with your knees connects and one clearing your head does not,
  which a symmetric band cannot express.

**The test is swept across the frame's whole step, not sampled at its end.** `game.ts` clamps `dt` at
0.05s and the fastest missiles fly 875 units/sec, so one frame can carry a shot 43 units — further
than a body is wide. Sampling endpoints silently drops every graze whose closest approach falls
between two frames, which gets worse the lower the frame rate. `stepTouchesBody` returns *where along
the step* contact happened, which is also what orders multiple candidates: first along the flight
wins, the swept equivalent of vanilla's blockmap traversal order.

A struck body ends the flight, so it fires no shoot-triggered special — the missile never reached the
wall whose `lineIndex` it carries.

**Fog of war doesn't hide a body from a projectile**, unlike `raycastMonster`, where the filter keeps
the auto-aim lock and a free bullet off monsters the player has never seen. A missile in flight is a
physical thing that has to collide with whatever is actually there, and `monstersNear` already
resolves splash the same way — a rocket fired down an unrevealed corridor explodes on what is in it.

**Splash damage is separate from a direct hit and reaches everyone nearby regardless of what was
targeted** — a rocket fired at a bare wall still explodes and can hurt a monster standing close by.
`applyRadiusDamage` (`game/combat.ts`, shared by projectile splash, the barrel and the arch-vile's
blast) walks every living monster `ThingLayer.monstersNear` returns within the blast
radius, skips anyone `hasLineOfSight` says is blocked, and falls off linearly to 0 at the radius
edge, matching `P_RadiusAttack`. It uses `hasLineOfSight`, deliberately not `shotPath` — that models
a directed weapon's own blocking rules, not "does this omnidirectional blast reach that point".

## Blood

**Blood is spawned by a trace hitting a body, not by damage** — vanilla puts `P_SpawnBlood` in
`PTR_ShootTraverse`, i.e. only on the `P_LineAttack` path. So the player's hitscan pellets
(`spawnPlayerShot`), the fist/chainsaw swing (its melee branch) and a monster's hitscan bolt
(`game/monsters/attacks.ts: MonsterAttacks.resolveHitscan`) all splash, and everything reaching `P_DamageMobj` by another
route does not: a projectile's direct hit, splash, the BFG spray (`A_BFGSpray` damages and spawns
`MT_EXTRABFG` itself, never blood), a crusher, a damage floor. Don't "fix" the missing cases — a
rocket that made a monster bleed would be wrong.

`SpriteFxLayer.spawnBlood` is one `OneShotEffect` like any other. Two details are vanilla's and look
arbitrary: the frame letters run **backwards** (`S_BLOOD1`-`3` are `BLUD` C, B, A at 8 tics each),
and the hit's damage picks which state the splash *starts* in (`bloodFrames`: under 9 shows only
`A`, 9-12 `B`→`A`, above 12 all three) — so weapon power reads off the size of the splash. The
±4-unit `HIT_Z_JITTER` is `P_SpawnBlood`'s own `(P_Random()-P_Random())<<10` (`P_SpawnPuff` opens
with the identical line), drawn off the random table like every other fuzz in the game
(docs/random.md § The triangular draw), and is what keeps a shotgun's pellets from stacking their
splashes into one sprite — the table has no two adjacent entries equal, so the jitter is never
exactly zero. `MT_BLOOD`'s brief upward hop (`momz = 2` falling back under gravity) is deliberately
**not** reproduced: it peaks about 3 units in a top-down view, and every other `OneShotEffect` is
fixed in place.

**`ThingLayer.bleeds` is vanilla's `MF_NOBLOOD` flag**, which in all of stock DOOM exactly one thing
carries — `MT_BARREL`, which takes a bullet puff instead. It is keyed by id rather than type because a
locked-on shot only ever knows the id it hit, and it deliberately ignores `dead`, so the killing
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

`SpriteFxLayer.spawnWallPuff` (`game/spritefx.ts`, shared by the player's pellet and `resolveHitscan`)
owns the geometry case and **skips two things vanilla also skips**:

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
engine it only ever shows on a barrel: a melee swing never traces geometry at all (§ WeaponSystem),
so unlike vanilla it can't puff against a wall.

`S_PUFF1`'s `FF_FULLBRIGHT` is not reproduced — an `OneShotEffect` takes one sector light for its
whole life, the same simplification every explosion here already makes. `A_Tracer`'s own
`P_SpawnPuff` (vanilla spawns a puff *and* an `MT_SMOKE` behind the revenant's missile every 4th
tic) is also left out: it would double the trail's live sprite count, which docs/monster-ai.md §
The revenant's homing missile records as the reason the batch exists at all.

## Splash and the BFG

**A splash's radius and damage are a fixed pair on the weapon, independent of that shot's own random
direct-hit roll** — `WeaponDef.splash`, not derived from `damageDiceSides`/`Multiplier` as an earlier
version wrongly assumed. `A_Explode` really does pass a constant 128/128 to `P_RadiusAttack`,
separate from the missile's `(P_Random()%8+1)*20` contact roll; conflating them made splash swing
with the same small random roll as contact damage.

**The spider mastermind and the cyberdemon take no splash damage at all**, direct hits only —
`PIT_RadiusAttack` skips them outright, and `applyRadiusDamage` reproduces that by type before it
measures anything. This is the exemption the BFG spray and the monster-attack doc both defer to; it
is implemented once, here, so a rocket into a cyberdemon's feet does nothing and the rocket that
hits it does full damage.

**`hitsPlayer` gates whether a splash can hurt the player who fired it** — `true` for the rocket
(vanilla lets a rocket's blast hurt whoever fired it, the classic rocket-jump self-damage), so
`applyRadiusDamage` includes the player as a candidate. The BFG sets `splash` to `null` outright: its
ball never calls `A_Explode` at all, so there's no radius blast to gate.

**The BFG's actual damage is `WeaponDef.spray`, vanilla's real `A_BFGSpray`** (`resolveBfgSpray`,
called from `ProjectileLayer.update` the instant the ball reaches wherever it's going). It is nothing like
a radius blast: 40 rays fan out across a 90° arc (every 2.25°) centered on the ball's own fixed
flight angle (`Projectile.angleRad` — the ball never homes), each an independent
`ThingLayer.raycastMonster` trace out to 1024 units (`16*64`, `P_AimLineAttack`'s own distance) that,
if it connects, deals a full undiminished direct hit — the sum of 15 rolls of a d8 (15-120), with no
distance falloff at all. Two things make it genuinely different from a radius blast:

- **It's traced from the player's own live position at the moment the ball dies, not from the impact
  point.** `A_BFGSpray` reads `mo->target` — the shooter, still a live pointer — at that instant;
  after ~1.5s of the ball's slow flight the player can be well behind where it detonated.
  `resolveBfgSpray` takes only the ball's travel *angle* and rebuilds the fan from
  `this.player.x/y/z`.
- **Nothing stops two, or all 40, rays landing on the same target.** A monster directly in front of
  the player can eat several rays at once, each its own full roll — this, not a bigger radius, is the
  source of the BFG's reputation against one big target.

`resolveBfgSpray` draws no line for the rays — `A_BFGSpray`'s traces are pure math in vanilla too,
never rendered, and an earlier approximated splash drew a green tracer purely to make its damage
legible. **Every ray that connects spawns vanilla's own `MT_EXTRABFG`** on the monster it hit
(`BFG_SPRAY_HIT_FRAMES`, `BFE2A0`-`D0`, confirmed against the real `DOOM2.WAD` lump names) placed
roughly a quarter of the way up the target (vanilla's `linetarget->height>>2`; with no per-species
height table this reuses `MONSTER_FIRE_HEIGHT`). Spawned once *per connecting ray*, unconditionally,
matching the `P_SpawnMobj` call inside vanilla's loop — a target caught by several rays gets several
overlapping bursts, which is the flickering green flash a BFG'd monster shows in real vanilla. `BFE1`
(the ball's own impact where it physically stopped) and `BFE2` are two separate sprites for two
separate events.

Per-weapon direct-hit damage rolls follow vanilla's `((rand % sides) + 1) * multiplier` shape and are
lifted rather than tuned by feel, same reasoning as ammo-per-shot — they decide how tough a fight is.
