# Weapons, shots, damage and death

`src/game/weapons.ts`, `src/game/projectiles.ts`, `src/game/combat.ts`,
`src/game/world.ts: shotPath`/`hasLineOfSight`, `src/render/tracer.ts`, `src/game/effects.ts`,
`src/game/thingdefs.ts`, `src/game/things.ts`, `src/game/inventory.ts`, `src/game/effectdefs.ts`,
`src/game.ts`

## WeaponSystem

`WeaponSystem` owns weapon selection and fire timing/ammo, and **deliberately knows nothing about
three.js**: `update` returns a list of `Shot`s describing what was fired this frame (one per hitscan
pellet, one per projectile launched, one per melee swing), and `ProjectileLayer`
(`game/projectiles.ts`) turns those into tracer lines and flying sprites. Same split as
`specials.ts`'s line triggers vs. `game.ts`'s teleport fog, and it's what lets fire rates and ammo
costs be tested headlessly against a synthetic map.

`ProjectileLayer` is the mirror image: it knows nothing about ammo, cooldowns or AI, only about
geometry and bodies, and it serves the player's shots and a monster's identically
(`spawnPlayerShot`/`spawnMonsterShot`). It reads the live level through a `CombatContext`
(`game/combat.ts`) rather than holding `World`/`ThingLayer` references of its own — those are
replaced on every map load, so the context is all getters.

**Nothing in `WEAPONS` is tuned by feel** — fire rates come from `info.c`'s state chains (§ Fire
rates), spread from `p_pspr.c`'s shift constants (§ Spread), damage from `P_GunShot` and
`PIT_CheckThing` (§ Damage rolls), ammo cost from `P_FireWeapon`, projectile speed from `mobjinfo`.
The top-down camera changes how a weapon is *aimed*; it doesn't change how fast one shoots or how
hard it hits, so there is nothing here a feel-tuned number would be buying.

## Fire rates

**A weapon's cooldown is its own vanilla state chain, and the `A_ReFire` state's tics are not part of
it.** `A_ReFire` runs on *entry* to its state and, while the trigger is still down, calls
`P_FireWeapon` immediately — `P_SetPsprite`'s loop then leaves the psprite sitting in the fire
chain's first state with that state's own tics, so the `A_ReFire` state's tics are only ever spent
when you *release*. Summing a weapon's whole state list therefore overstates its held-trigger rate;
the shipped numbers were up to 1.7× off in both directions before this was worked out.

| weapon | states counted | tics | seconds |
|---|---|---|---|
| fist | `S_PUNCH1`-`4` | 17 | 0.486 |
| chainsaw | `S_SAW1` **or** `S_SAW2` | 4 | 0.114 |
| pistol | `S_PISTOL1`-`3` | 14 | 0.400 |
| shotgun | `S_SGUN1`-`8` | 37 | 1.057 |
| super shotgun | `S_DSGUN1`-`9` | 57 | 1.629 |
| chaingun | `S_CHAIN1` **or** `S_CHAIN2` | 4 | 0.114 |
| rocket launcher | `S_MISSILE2` + `S_MISSILE1` | 20 | 0.571 |
| plasma rifle | `S_PLASMA1` | 3 | 0.086 |
| BFG | `S_BFG3` + `S_BFG1` + `S_BFG2` | 40 | 1.143 |

Two shapes in that table are easy to get wrong. The **chainsaw and chaingun fire twice per pass**
(`S_SAW1`/`S_SAW2` both call `A_Saw`, `S_CHAIN1`/`S_CHAIN2` both call `A_FireCGun`), so their rate is
one state's tics, not the chain's. The **plasma rifle's** `S_PLASMA2` holds 20 tics but carries
`A_ReFire`, so a held trigger never spends them — which is what makes it the fastest weapon in the
game rather than a middling one.

**Two vanilla delays are deliberately not reproduced.** The rocket launcher's 8-tic flash state and
the BFG's 30 tics of charge-up both sit *before* their fire action, so in vanilla the shot leaves
that long after the trigger; here every weapon fires on the frame you click and the delay is folded
into the interval instead. Reproducing them needs a pending-shot timer in `WeaponSystem` and is the
one place this engine's weapons still differ in timing.

## Spread

Every random fuzz in the game is one distribution — vanilla's `P_Random() - P_Random()`, two uniform
draws subtracted, giving a triangular spread centred on the true aim (`triangularDraw`, and
`triangularSpread` for the angular cases). The per-weapon widths are the BAM shift constants in
`p_pspr.c`, converted as `255 << shift` of a `2^32` turn:

- `<<18` = **5.6°** — `P_GunShot`'s bullet spread, so the pistol, chaingun and each of the shotgun's
  7 pellets, *and* `A_Punch`/`A_Saw`'s swing angle. A melee swing's own share barely matters (~6
  units of arc at `MELEERANGE`, against a 24-unit hit radius), but it is the same draw.
- `<<19` = **11.2°** — the super shotgun's 20 pellets, twice the shotgun's cone. `A_FireShotgun2`
  never calls `P_GunShot`; it has its own loop, which is why its numbers differ.
- `<<5` on the *slope* (`WeaponDef.slopeSpread`, ±0.1245 rise per unit ≈ ±7°) — also super shotgun
  only, and the only vertical scatter in the game. `HitscanShot.slopeOffset` carries it, applied by
  moving the aim point up or down at the target's distance, since that is what `shotPath` derives a
  slope from.

**The first shot of a held pistol or chaingun has no spread at all.** `A_FirePistol` and `A_FireCGun`
pass `P_GunShot(mo, !player->refire)`; `A_FireShotgun` hardcodes `false`. `WeaponSystem` mirrors
`player->refire` with a counter reset whenever the trigger comes up or the weapon changes
(`A_ReFire`'s else branch), and `WeaponDef.accurateFirstShot` marks the two weapons that read it. Tap
for accuracy, hold for volume — without this, the auto-aim fix below makes a tapped long-range
chaingun shot miss ~27% of the time for no reason vanilla would recognize.

## Damage rolls

**Two vanilla formulas, one `((rand % sides) + 1) * multiplier` shape.** A *bullet's* roll is written
out at each call site (`5*(P_Random()%3+1)` in both `P_GunShot` and `A_FireShotgun2`: 5/10/15 per
pellet, and the super shotgun's is identical to the shotgun's — the 20-vs-7 pellet count is its whole
advantage). A *missile's* is not in the weapon code at all: `PIT_CheckThing` rolls
`((P_Random()%8)+1) * mobjinfo.damage` for whatever hit something, so every projectile weapon has 8
sides and takes its multiplier from `info.c` — rocket 20 (20-160), plasma **5 (5-40)**, BFG ball
**100 (100-800)** before `A_BFGSpray` adds anything. The plasma bolt shipped as a 4-sided roll and
the BFG ball as `8×30`; both were transcription guesses, and reading `mobjinfo` settles them. Fist
and chainsaw share `(P_Random()%10+1)<<1` (2-20), the fist ×10 under berserk.

Projectile *speeds* come from the same `mobjinfo` rows, × 35 for units/sec exactly as
`game/monsters.ts` converts a monster's: rocket 700, plasma 875, BFG 875. The player's rocket used to
fly at 1000 while the cyberdemon's — already converted correctly — flew at 700.

**A melee swing is resolved entirely differently from every other shot**: `spawnPlayerShot` returns before
`shotPath` even runs and just raycasts `WeaponDef.meleeRange` (vanilla's `MELEERANGE`, 64 — the
chainsaw's own `+1` is about its puff, § Bullet puffs) along the
aim angle. A swing doesn't travel, so it needs none of `shotPath`'s wall/step blocking, matching
`A_Punch`/`A_Saw`. It needs no lock-on case either: `player.angle` is already set from the same `aim`
the lock uses, so the ray finds a hovered monster on its own and simply can't reach one further off
than the swing's range.

**Slot keys toggle within a slot, they don't select "the best".** `WEAPON_SLOTS` lists each digit's
weapons best-first, but pressing a digit already showing one of that slot's weapons advances to the
*next* one owned rather than re-picking the best. Without this, slots 1 and 3 (fist/chainsaw,
shotgun/super shotgun) made their weaker weapon permanently unreachable once the upgrade was owned —
which presented as "shotgun and super shotgun are the same weapon".

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
See docs/monsters.md § Hitscan vs. projectile.

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
immediately in `spawnPlayerShot`/`resolveMonsterHitscan` (resolved and gone within the same frame, matching
`PTR_ShootTraverse`), but a projectile's is deferred to the frame it actually *arrives* at that wall
in `ProjectileLayer.update` — vanilla calls `P_ShootSpecialLine` for a missile from `PIT_CheckLine`, which
only runs once the missile reaches the line. `Projectile.lineIndex` carries the line found at launch
forward (safe to resolve early, same as `maxDist` itself: static geometry doesn't move mid-flight).
Either way, the special only fires if nothing closer — a monster's body, or the player — absorbed the
shot first: `hitMonsterId`/`reachedPlayer`/`struck` all take priority over the wall.

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
at that one" is expressible directly. `ThingLayer.pickMonster` raycasts the cursor against monster
sprite meshes (`MONSTER_TYPES`, filtered to currently-`visible` ones so a fog-of-war-hidden monster
can't be targeted through the geometry hiding it) and returns the hit monster's position *and* its
sector's live floor height. `game.ts` uses that as both the aim point and the shot's end height. It supplies the shot's aim
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

Impact explosions, blood splashes, bullet puffs and the teleport-fog puff share one mechanism, `EffectLayer`
(`game/effects.ts`, `OneShotEffect`/`spawn`/`spawnImpact`): a transient sprite animation playing
once at a fixed spot, outside `ThingLayer` since none of them is a real map `Thing`. `IMPACT_EFFECTS` maps a projectile's
flight sprite to its explosion — vanilla reuses `MISL` frames B–D for the rocket's blast, while the
plasma bolt and BFG ball explode into dedicated `PLSE`/`BFE1` sprites. Hitscan `Tracer` lines live
there too: not sprites, but the same spawn-animate-drop lifecycle and the same wholesale clear on a
level change (`beginLevel`).

`EffectLayer` only draws and ages what it is handed; who spawns what, and every rule about *why*
(`A_Fire`'s sightline, `A_VileAttack`'s reposition) stays with the system that owns the mechanic —
the arch-vile's flame tracks its target through a `VileFlameResolver` callback `game.ts` supplies,
rather than the layer reaching into monster state.

Those effects and projectiles in flight are drawn through `EffectLayer`'s batch, a second `SpriteBatch`
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

**Two different ways, depending on whether one was locked on.** A locked-on shot resolves
hit-or-miss against that exact target, and needs **both** halves: `spawnPlayerShot` compares
`shotPath`'s returned distance against the distance to the target to know whether a wall cut the shot
short, *and* tests this shot's own line against the target's body — perpendicular offset within
`MONSTER_HIT_RADIUS` (the same width `raycastMonster` uses) and, for a pellet carrying a
`slopeOffset`, vertical miss within half of `MONSTER_HIT_HEIGHT` at the body's distance. A *free* shot
instead tests its straight flight path against every monster's body (`ThingLayer.raycastMonster`),
the way any real hitscan trace would, so a monster standing between the player and the wall they're
shooting at still gets hit even though it was never clicked; only the nearer of "a wall/step"
(`shotPath`) and "a monster in the way" (`raycastMonster`) stops the shot.

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
reproduced once it falls through to that branch. Accepted as the same order of approximation as the
single shared hitbox.

`raycastMonster` tests a single approximate hitbox (`MONSTER_HIT_RADIUS`/`_HEIGHT`) rather than each
monster's real, quite varied (16-128 units) vanilla radius — modelling that accurately would need a
per-species size table for a check this approximate to begin with.

For a hitscan pellet damage is applied immediately (an instant line has no travel time); for a
projectile it's carried on the `Projectile` and applied in `ProjectileLayer.update` once the sprite
visually reaches its `maxDist`.

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
(`game.ts: resolveMonsterHitscan`) all splash, and everything reaching `P_DamageMobj` by another
route does not: a projectile's direct hit, splash, the BFG spray (`A_BFGSpray` damages and spawns
`MT_EXTRABFG` itself, never blood), a crusher, a damage floor. Don't "fix" the missing cases — a
rocket that made a monster bleed would be wrong.

`EffectLayer.spawnBlood` is one `OneShotEffect` like any other. Two details are vanilla's and look
arbitrary: the frame letters run **backwards** (`S_BLOOD1`-`3` are `BLUD` C, B, A at 8 tics each),
and the hit's damage picks which state the splash *starts* in (`bloodFrames`: under 9 shows only
`A`, 9-12 `B`→`A`, above 12 all three) — so weapon power reads off the size of the splash. The
±4-unit `HIT_Z_JITTER` is `P_SpawnBlood`'s own `(P_Random()-P_Random())<<10` (`P_SpawnPuff` opens
with the identical line), and is what keeps a shotgun's pellets from stacking their splashes into
one sprite. `MT_BLOOD`'s brief upward hop (`momz = 2` falling back under gravity) is deliberately
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

`spawnWallPuff` (`game/projectiles.ts`, shared by the player's pellet and `resolveMonsterHitscan`)
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
tic) is also left out: it would double the trail's live sprite count, which docs/monsters.md §
The revenant's homing missile records as the reason the batch exists at all.

## hasLineOfSight

**It checks floor/ceiling, not just walls.** Without this, a monster standing in a room genuinely
*underneath* a ledge the player is on — with no shared two-sided line anywhere near the straight 2D
path, since the floor is what separates them — registered as fully visible and shootable, so a
monster that chased around under a ledge kept hitting the player through the floor. Every caller
(`canSee`/`tryWake`, `applyRadiusDamage`) passes real heights rather than the flat
`MONSTER_ENGAGE_HEIGHT` guess an earlier version used, which a proper 3D check makes both redundant
and, in a tall open room, wrong (vanilla has no such cap at all).

**The floor/ceiling check is a sight *wedge* from a fixed eye height, matching `P_CheckSight`
(`sightzstart`/`topslope`/`bottomslope`) — not a straight line interpolated from `z1` to `z2`.** An
earlier version did exactly that, and it's wrong the moment the two ends stand at different floor
heights, which is most of a real level: a monster on a raised platform and the player one step below
it, in an otherwise open room, produces a line that dips below the *platform's own floor* almost
immediately — it heads toward the lower end over the *entire* distance, not just at the step — so the
platform's floor was misreported as blocking sight to the monster standing on it. This was a shipped
bug: a pair of E1M1 zombiemen one step up on a 24-unit platform never woke no matter how long the
player stood in plain view.

`SIGHT_EYE_HEIGHT` (`3/4` of `PLAYER_HEIGHT`, vanilla's own fraction — this engine has no per-species
heights, so both ends reuse the player's) fixes the origin at `z1 + SIGHT_EYE_HEIGHT` instead of
sliding it toward `z2`. The target bound uses the full `[z2, z2 + PLAYER_HEIGHT]` span rather than a
single point, so any part of that range clearing every opening crossed is enough.

**The wedge narrows at two different things, and both are load-bearing.** The primary one walks the
same line candidates `forEachLineAlongSegment` already finds for the wall-blocking test and, for
every *open* two-sided line among them (skipping a flat pass-through — equal floors and equal
ceilings on both sides can't narrow anything, matching `P_SightTraverse`'s own
frontsector/backsector inequality guards), narrows `[bottomSlope, topSlope]` against that line's real
opening (`World.openingOf`: min ceiling, max floor of its two sides) at the exact distance it's
crossed — this *is* vanilla's own `P_SightTraverse`, not an approximation of it. A **periodic
fallback** additionally samples `sectorAt` every `SIGHT_HEIGHT_SAMPLE_STEP` map units (capped at
`SIGHT_MAX_HEIGHT_SAMPLES` samples total) and narrows against whatever sector each sample lands in,
for the one thing a line-crossing walk can't see: two points whose straight 2D path never crosses a
two-sided line at all yet still cross between differently-elevated footprints (the classic "monster
under a ledge" fake-3D construction) — the reason this doc originally gave for the check existing.
Both narrow the same wedge monotonically, so running both is always at least as strict as either
alone, never more permissive.

**The line-crossing narrowing is the one that makes melee range work at all.** `MELEE_RANGE`/vanilla's
own `MELEERANGE` (64-72 map units) is well inside `SIGHT_HEIGHT_SAMPLE_STEP` (64), so the periodic
sampler alone never places a single interior sample on a short sightline — `Math.ceil(72/64)` is `1`,
and the loop that walks samples `1..steps-1` never runs. Before the line-crossing narrowing existed,
that meant a monster standing at the base of *any* ledge more than `MAX_STEP_UP` (24 units) tall, close
enough to be in melee range, always passed `hasLineOfSight` regardless of the ledge between it and its
target — a demon could bite straight through the drop. `public/wads/pwad/pinky_test.wad` MAP01
reproduces it directly: two sectors sharing one line, floors 0 and 88, a demon on the high side and the
player on the low side just below it.

**It is the most performance-sensitive query in the engine**, and two things keep the base cost
affordable. Both were verified to produce **bit-identical results** to the straightforward version
across 21,240 sightline pairs on six maps — this is pure optimization, not an approximation traded for
speed:

- **Wall candidates come from `World.forEachLineAlongSegment`, not `linesNear`.** `linesNear` takes a
  *radius*, so covering a sightline with it means a box half the line's length on a side — O(dist²)
  grid cells to test a thin segment. Walking only the cells the segment actually crosses is O(dist),
  and is sound because `buildGrid` buckets each line into every cell its bounding box touches: if a
  line genuinely crosses the segment, their intersection lies in a cell both pass through. On
  NUTS.WAD this one change took `hasLineOfSight` from dominating the frame to a small fraction of it.
- **`SIGHT_MAX_HEIGHT_SAMPLES` caps the floor/ceiling sampling** so the step stretches past
  `SIGHT_HEIGHT_SAMPLE_STEP` instead of the sample count growing without bound. 32 is chosen so
  nothing within `WEAPON_RANGE` (2048, the furthest a monster can shoot, and no player shot's
  outcome is decided here — `shotPath` walks openings itself) changes at all — 2048/64 is
  exactly 32 — while a monster 12,000 units away stops costing ~180 BSP walks per frame to answer a
  question no attack could act on.

Relatedly, `stepMonsterAI` resolves sight **lazily, at most once per call**: it's only consumed by
the refire loop and by `runChaseCall`, and the chase call is quantized to `chaseInterval` while
`stepMonsterAI` runs every rendered frame, so evaluating it eagerly threw the answer away most
frames. Vanilla has the same structure for the same reason.

Both `forEachLineAlongSegment` and the lazy accessor exist because these run thousands of times a
frame: the segment walk dedupes through a per-linedef stamp array rather than allocating a `Set` and
spreading it per call, the way `linesNear` does. **An equivalent allocation-free `linesNear` for the
*collision* callers was tried and measured as no faster** — the callback makes that call site
megamorphic and costs the early-out — so `groundFloor`/`dropoffFloor`/`circleBlocked` deliberately
still use the plain array-returning `linesNear`. Don't "fix" that without measuring.

**`SELF_HIT_MARGIN`**: a rocket that explodes against a wall sits its own impact point exactly on
that wall, and a raw segment-intersection test then reports the blast blocked by the very wall it
started on (the ray's own origin is a valid crossing at `t≈0`) — so `hasLineOfSight` said "blocked"
in every direction, including straight out into the open room. Splash only ever worked when a shot
connected directly with a monster and never when it hit geometry, which for a free shot is the common
case. The margin skips a crossing within 1 unit of the ray's start, the same "nudge off the geometry
you're standing on" idea as `WALL_OVERLAP`/`BLOCKER_OVERLAP`. Tradeoff: a rocket exploding against a
*closed door* can in principle leak a sliver of splash through, since the door's self-hit is now the
crossing being ignored — accepted as the same order of approximation.

## Splash and the BFG

**A splash's radius and damage are a fixed pair on the weapon, independent of that shot's own random
direct-hit roll** — `WeaponDef.splash`, not derived from `damageDiceSides`/`Multiplier` as an earlier
version wrongly assumed. `A_Explode` really does pass a constant 128/128 to `P_RadiusAttack`,
separate from the missile's `(P_Random()%8+1)*20` contact roll; conflating them made splash swing
with the same small random roll as contact damage.

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

## Monster death

**Health and death-frame sequences are confirmed against the actual lump names in DOOM.WAD/DOOM2.WAD.**
Health values are vanilla's `mobjinfo` constants, but the death *frame letters* are derivable from
the WAD directly: death art in vanilla is rotation-0 (omnidirectional) only, so the point where a
sprite's directional (rotation 1-8) frames stop and its rotation-0 tail begins marks exactly where
movement/attack/pain art ends and death art starts. Confirmed by dumping every monster sprite's
frame/rotation pairs from the real IWADs and cross-checking against known vanilla death-state counts
(POSS's rotation-0 tail is 14 letters, split 5 DIE + 9 XDIE, matching the zombieman exactly).

`MONSTER_DEATH_FRAMES` takes the DIE half; `MONSTER_XDEATH_FRAMES` the XDIE (gib) half where one
exists at all — only five monster types in stock DOOM have gib art (the human grunts and the imp);
everything else, including similarly-sized monsters like the demon, has no `xdeathstate` in vanilla
and always plays its plain death. `ThingLayer.damage` picks between them exactly as `P_KillMobj`
does: gib only if the killing blow pushed health below *minus* the monster's own max health *and*
gib art exists for that type. Commander Keen (a pain cascade with no distinct DIE state) and the boss
brain (2 sprite frames total, no death art) are deliberately absent from both — `damage` falls back
to just hiding a killed monster with no entry.

A death is a **permanent, one-way animation switch, not a new actor**: `SpriteActor.die` overrides
the alive walk cycle with a one-shot sequence that advances forward and holds its last frame forever,
reusing the same mesh/materials rather than spawning a second object — cheaper, and it means a corpse
still participates in fog-of-war fading exactly as it did alive. `ThingLayer.damage(id, amount)` —
`id` being the stable index `pickMonster`/`monstersNear` hand back — subtracts health and calls `die`
at 0; `pickMonster` skips anything already dead so a corpse can't be re-targeted.

**Two types don't leave a corpse: the lost soul and the pain elemental.** Every other monster's final
death state has `tics: -1` ("hold forever"), which is what makes a corpse permanent, but
`S_SKULL_DIE6` and `S_PAIN_DIE6` both have a finite tic count and fall through to `S_NULL` — and
transitioning *to* `S_NULL` is what makes vanilla call `P_RemoveMobj`. `MONSTER_CORPSE_VANISHES` is
exactly those two doomednums; `ThingLayer.update` hides either type's corpse the instant `deadTime`
reaches the end of its death animation. Both are the game's floating monsters, which tracks
thematically, but nothing keys off "flying" — only the two confirmed doomednums.

This has a second consequence for the pain elemental: its mobjinfo *does* carry a real `raisestate`
(hence its entry in `MONSTER_RAISE_FRAMES`), but `PIT_VileCheck`'s `if (thing->tics != -1) return
true; // not lying still yet` requires a settled corpse — which a pain elemental's never reaches
before `P_RemoveMobj` deletes it. So despite the mobjinfo entry, a dead pain elemental can never
actually be resurrected in real vanilla either. This engine reproduces the same unreachability
structurally rather than adding a third special case: `rebuildBlockerGrid` never buckets a `hidden`
corpse into `corpseGrid`, and a pain elemental's corpse is always hidden by the exact moment
`findRaisableCorpse`'s "finished settling" gate would start accepting it — both keyed off the same
`deadTime` threshold.

**A killed monster can drop an item**, lifted from `P_KillMobj`, which has exactly three `switch`
cases: the zombieman and Wolfenstein SS drop a clip, the shotgun guy a shotgun, the chaingunner a
chaingun (`MONSTER_DROPS`). Everything else, including monsters that feel like they obviously should
(the imp, the demon), drops nothing. `ThingLayer.damage` spawns the drop inline the moment it marks a
monster dead — via a `spawnDrop` helper that's the same pose/push the map-load loop does, for one
instance — so a drop appears no matter *how* the kill happened (direct hit, splash, gib, crusher),
matching vanilla dropping from that one function regardless of cause. Each `PosedThing` carries a
`dropped` flag, seeded `true` only for a `spawnDrop` instance and threaded through `tryPickup`'s
`consume` callback into `applyPickup`'s `dropped` param — vanilla's `P_GiveAmmo`/`P_GiveWeapon` give
a dropped pickup's ammo at half the rate of a map-placed one (a dropped clip's 5 bullets vs. 10, a
dropped shotgun's 4 shells vs. 8).

`spawnDrop`, `spawnLostSoul`, `spawnMonster` and the map-load loop all build their `PosedThing`
through one shared `pushThing` helper. That is worth naming because the alternative was four copies
of a ~60-field object literal, three of which already existed and had begun to drift — `spawnDrop`'s
copy, for instance, had no `INERT_SHOOTABLE` radius lookup because it predated one.

## Telefrag

Vanilla's `P_TeleportMove` kills everything standing where a body lands, for a flat `10000` damage.
This engine reaches it from exactly one place: `ThingLayer.spawnMonster`, the tail of the Icon of
Sin's `A_SpawnFly` (docs/monsters.md § The spawn cube). There is no player teleport that can land on
an occupied spot here, so no other caller exists.

The kill is **deliberately unattributed** — no `source` is passed to `damageThing`. A telefrag is the
teleport's doing, not an attack, and naming the newly spawned monster as the source would start an
infight it never picked.

It is split across two files for the usual reason: `ThingLayer` has no player reference, so it
telefrags every overlapping `PosedThing` itself and returns the new body, and `game/icon.ts` does the
player half against `PLAYER_RADIUS` and calls `damagePlayer`. That is what makes standing on a MAP30
spawn spot a real way to die.

## Player death

**Reuses the exact same mechanism** on `game.ts`'s single persistent `playerActor`:
`PLAYER_DEATH_FRAMES` (`H`-`N`) is `PLAY`'s own confirmed DIE half, derived the same way as the
monster tables.

`Inventory.applyDamage` is vanilla's `P_DamageMobj` armor formula — green armor absorbs a third of
the damage, blue half, spending armor points 1-for-1 with whatever it absorbed and falling back to
bare once it runs out mid-hit — reused for the player specifically since monsters have no armor. It
returns whether the hit actually landed, `false` while invulnerability blocked it outright
(`INVULNERABLE_DAMAGE_LIMIT`); `damagePlayer` uses that to skip the pain flash and flinch animation
for a hit that did nothing, which a first version didn't check, so an invulnerable player flashed red
on every hit that was landing on nothing.

Health hitting 0 sets `Game.playerDead`, which freezes only the input-driven half of `frame` —
movement/aim/firing/pickups. Everything else keeps running: fog of war, effects, faders and
rendering, and monster AI — but AI follows vanilla's own rule for it, not a blanket freeze.
`P_KillMobj` strips the player's `MF_SHOOTABLE`/`MF_SOLID` on death, so `Game.frame` passes
`ThingLayer.update` `null` for the player once `playerDead` (`game/things.ts`'s `resolveTarget` and
`blockersFor` both take the `Pos3 | null` this produces). A monster already mid-infight with another
monster is unaffected and keeps fighting; one whose only target *was* the player finds `resolveTarget`
reporting no target the very next frame and reverts to idle right there — `p.alerted = false`,
`movedir`/`movecount` cleared — the same as `A_Chase`'s own "no shootable target" branch falling
through to `P_SetMobjState(spawnstate)`. It only wakes again via `damage`'s unconditional re-alert
(getting caught in someone else's infight), same path any other dormant monster uses. A rocket or vile
blast already in flight still lands and can still deal splash (or, for the vile's knockup, do nothing
beyond the first killing blow — `resolveVileBlast` gates its knockup on `damagePlayer`'s return, and
`resolveMonsterHitscan`'s `!playerDead` guard for the hitscan equivalent) — a dead player can still be
"hit" for nothing to happen, matching `damagePlayer`'s own early return. The death itself shows a
`#death-overlay` div. `R` calls `restart`: a fresh `Inventory`
and a `loadMapByIndex` reload of the current map, which already resets player/world/specials/fog for
a normal transition and, via its own top-of-function reset, `playerDead`/the overlay/`playerActor`'s
animation state too. Restart isn't a special case, just the ordinary map-load path with a clean
inventory.

## Exploding barrels

`src/game/things.ts`, `src/render/sprites.ts`, `src/game.ts`

Vanilla's `MT_BARREL` has no AI at all — a plain `MF_SOLID|MF_SHOOTABLE` prop, not a `MONSTER_TYPES`
member, so none of the monster AI applies. It still needs to plug into almost every piece of
machinery a monster does (solid collision, hitscan/projectile/splash/melee hit-testing, auto-aim
lock-on), which vanilla gets for free because none of those systems know what "monster" means — they
only check `MF_SHOOTABLE`/`MF_SOLID`. This engine's equivalent generic layer is `ThingLayer`'s
`blockerGrid`, so a barrel joins that grid alongside every `MONSTER_TYPES` thing
(`rebuildBlockerGrid`, `solidBodies`, `pickMonster`) rather than needing a parallel set of spatial
queries — `raycastMonster`/`monstersNear` become barrel-aware for free, which is what lets a rocket,
a stray pellet, a monster's own fireball or another barrel's blast all hit one. The purely-solid
decorations (`SOLID_DECORATION_TYPES`, docs/movement.md § Solid decorations) join the same grid for
movement but are explicitly filtered back out of `raycastMonster`/`monstersNear` — unlike the
barrel, none of them carry vanilla's `MF_SHOOTABLE`, so a shot must pass through one rather than
stop on it.

**Only `ThingLayer.damage`'s death/pain behavior is special-cased**, gated on `BARREL_TYPE` (2035):
no painstate (`MT_BARREL` has `painchance = 0`), no alerting, no infighting retarget (it has no AI),
and a kill switches its sprite to `BEXP` instead of picking from the death/xdeath tables — a barrel's
idle art (`BAR1`) and its explosion art are genuinely different lumps, unlike every monster, whose
death states reuse the same sprite name. `SpriteAnimator.die` gained an optional third `spriteName`
argument for exactly this; every other caller still omits it.

**`A_Explode` fires partway through the death animation, not instantly on death** — `S_BEXP1`/
`S_BEXP2` each hold 5 tics before `S_BEXP3` calls it, so `BARREL_EXPLODE_DELAY_SECONDS` is
`2 * BARREL_DEATH_FRAME_SECONDS` (a flat per-frame rate standing in for vanilla's uneven 5/5/5/10/10,
the same simplification `MONSTER_DEATH_FRAME_SECONDS` makes). `ThingLayer.update` ticks this off the
same `deadTime` clock it already ticks for every dead thing and reports it back as a
`BarrelExplosion` (`{x, y, z, source}`) once due — the same "system reports, `game.ts` realizes"
split as `MonsterAttackEvent`, bundled alongside it in `ThingUpdateResult` rather than folded into
the same array. No separate visual effect is spawned: the barrel's own `PosedThing` is already
playing `BEXP` at exactly that position. `S_BEXP5` falls through to `S_NULL`, i.e. the debris is
removed once the animation finishes, the same rule `MONSTER_CORPSE_VANISHES` reproduces — a barrel
just isn't a `MONSTER_TYPES` member, so it gets its own copy of the check.

**The blast is `applyRadiusDamage`, exactly the rocket's own splash** — `A_Explode`'s literal call is
`P_RadiusAttack(thingy, thingy->target, 128)`, identical radius and damage. `source`
(`PosedThing.explodeSource`, captured in `damage` at the moment the barrel died, `null` meaning the
player) stands in for `thingy->target` and is what makes a chain attribute correctly: since
`applyRadiusDamage` walks the now-barrel-inclusive `monstersNear` and calls `damage` on what it
finds, a second barrel caught in the blast is killed through the same call a monster would be, which
captures this same `source` onto *it* and queues its own explosion a frame later — propagating the
original attacker down the whole chain rather than attributing each link to the barrel before it,
matching vanilla's `bombsource` propagation. The spider mastermind/cyberdemon splash exemption
applies here for free.

**A crusher can kill a barrel**, exactly as vanilla's crush damage (real `P_DamageMobj` against
anything `MF_SHOOTABLE`) allows — `ThingLayer.crushablesInSector` covers barrels alongside
`MONSTER_TYPES` for this one caller, rather than widening the `MONSTER_TYPES`-gated
`monstersInSector` every other system relies on. See docs/specials.md § Crushers.
