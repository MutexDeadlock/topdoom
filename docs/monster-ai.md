# Monster AI

`src/game/monsters/ai.ts`, `src/game/monsters/defs.ts`, `src/game/monsters/vile.ts`,
`src/game/things.ts`, `src/game/things/defs.ts`, `src/game/things/grid.ts`

Realizing an attack once one is decided on is docs/monster-attacks.md; a monster's sprite poses are
docs/sprites.md § Pain, and attack/pain poses; dying is docs/death.md.

Every `MONSTER_TYPES` entry except Commander Keen (72) and the boss brain (88) wakes, chases and
attacks — neither of those two attacks or moves in vanilla either.

**Layering.** `ai.ts`'s `stepMonsterAI` (chasing/attacking) and `tryWake` are pure functions that
read/write a monster's own mutable state and return *what happened* (a fired `MonsterAttack`, or
whether it woke). `ThingLayer.update` (`things.ts`) is where that state lives — each `PosedThing`
carries its AI fields — and owns the throttle that calls `tryWake`. `MonsterAttacks`
(`monsters/attacks.ts`, docs/monster-attacks.md) turns a returned attack into damage and, for a
ranged one, a tracer or a projectile. Same split as `WeaponSystem`/`SpecialsController`.

**That is why the AI and the resolver are separate files, and the dependency gap is the reason.**
`ai.ts` touches nothing but a `MonsterBody`, a `World` and a `SoundEmitter`, which is what keeps it
testable headlessly. `attacks.ts` needs the thing list, the effect and projectile layers and the
audio engine, and reads the live level through the same `CombatContext` `ProjectileLayer` does.
Keep new code on the correct side of that line.

**The four files.** `defs.ts` holds the record shapes, `MONSTER_STATS`/`INERT_SHOOTABLE` and the
pure vanilla helpers, and imports nothing from the other three — the `things.ts`/`thingdefs.ts`
pattern. `ai.ts` and `attacks.ts` are the two halves above. `vile.ts` is the arch-vile, the one
type whose behavior does not fit the data-driven model the rest are expressed in; both halves call
into it (§ The arch-vile).

**Sounds are the one exception to that split**: `stepMonsterAI` and `ThingLayer` raise them
directly through a `SoundEmitter`, since several of vanilla's sit at moments that produce no event
(`A_Chase`'s 3-in-256 idle grunt). Which sound each type plays when — and why melee compresses
vanilla's two sounds into one — is docs/audio.md § Monsters; `MonsterStats.sounds` holds the
table.

## Waking up

A monster stays inert until it spots the player, checked on a throttle (`LOOK_INTERVAL`, ~0.3s)
rather than every frame — vanilla runs idle `A_Look` every 10 tics, not continuously.

`canSpotPlayer` gates the check *before* `hasLineOfSight` runs: vanilla's `P_LookForPlayers` only
lets a monster notice the player within roughly its forward 180° (the map-placed thing angle,
unchanged until it wakes), unless the player is within melee range regardless of facing. Without
this, most of a level's population — everything facing away at spawn — attacked the instant an
unobstructed line existed, which reads exactly backwards.

**The spawn angle that cone is measured from is snapped to 45°** (`game/skill.ts: spawnAngleDeg`,
vanilla's `ANG45 * (mthing->angle/45)`), and every reader of a map thing's facing goes through it —
the wake cone, the sprite rotation a still thing shows, the player start, and a teleporter's
arrival facing. Reading the raw THING field instead swings the cone by up to 44° on any WAD that
places things off the grid; DOOM/DOOM2 have one such thing between them, `freedoom2.wad` has 22.

Once alerted, a monster is alerted for good and the FOV gate no longer applies, matching `A_Chase`,
which never re-checks it. There is no "lost the scent" in vanilla either. Taking any damage alerts
unconditionally (`reactToDamage`, matching `P_DamageMobj` setting `target` regardless of prior
sight or facing).

**Gunfire wakes monsters without sight** — `World.noiseAlert`/`isSoundAlerted`, confirmed against
`linuxdoom-1.10/p_enemy.c` and `p_pspr.c`. `game.ts` calls `noiseAlert` at the player's position
whenever a shot fires, melee included (`P_FireWeapon` is the same entry point for every weapon, so
swinging a fist in an empty room wakes the neighbours). Propagation matches `P_RecursiveSound`
exactly: a fully closed door (zero vertical opening) stops it, an `LF.BLOCK_SOUND` line softens it
once (crossable, but a *second* on the same path stops it), every other two-sided line passes it
through. A marked sector stays marked for the rest of the level (vanilla's `sector->soundtarget` is
never cleared), so a monster wandering in later still wakes.

A sound-alerted monster wakes with **no FOV or sight check at all** (`A_Look` `goto seeyou`s
straight off `soundtarget`) — deliberately more permissive than the sight path. **Ambush-flagged**
things (`game/skill.ts: isAmbush`, `MF_AMBUSH`/editor "deaf") are the exception: they ignore the
sector flag unless they can actually see the source, falling back to the ordinary FOV+sight check.

## Timings and damage come from vanilla, not from feel

Every value in `MONSTER_STATS` is lifted from vanilla's source. This is the opposite of the split
`weapons.ts`'s fire rates and `player.ts`'s `GRAVITY` make — those genuinely don't survive
conversion out of per-tic accumulation, whereas a monster's walk speed, attack length, pain length
and chase cadence are plain constants that do.

Vanilla moves a monster exactly `mobjinfo.speed` units per `A_Chase` call and calls `A_Chase` once
per state of its walk loop, so `MonsterStats.speed` in units/sec is
`speed × (A_Chase states in the loop) × 35 / (tics in the loop)`. The per-loop state count matters:
the arachnotron and spider mastermind spend 2-3 of their 12 walk states on footstep-sound actions
that don't move them, the cyberdemon 2 of 8. `chaseInterval` (seconds per `A_Chase` call) comes out
of the same arithmetic and is what the rest of the AI clock is quantized to.

An earlier pass eyeballed these at roughly 2-3× vanilla, which flattened the gap between a
shambling zombieman (70 units/sec) and a charging demon (175) and let nearly everything keep pace
with a running player. In vanilla the fastest monster in the game — the arch-vile at 262 — is still
barely half the player's own run speed.

**`reactiontime`** is 8 for every monster in the game. `tryWake` seeds `MonsterBody.reactionTicks`
with `REACTION_CHASES` (8) and `runChaseCall` decrements it once per chase call, as `A_Chase` does —
so it's measured in chase calls, not seconds, and a zombieman's hesitation (~0.91s) lasts twice as
long as a demon's (~0.46s) purely from their differing `chaseInterval`s. It gates **ranged attacks
only** (`checkMissileRange` reads it; vanilla reads `reactiontime` nowhere except
`P_CheckMissileRange`), so a demon woken at arm's length bites on the spot. `reactToDamage` zeroes
it outright.

## Movement

Vanilla's `P_NewChaseDir` on vanilla's eight directions (`newChaseDir`/`tryWalk`), not a beeline. A
monster only walks along E/NE/N/NW/W/SW/S/SE, commits to a heading for `movecount` chase calls, and
re-routes when that expires or a move is refused — trying the direct diagonal first, then the two
cardinals (longer axis first, with vanilla's ~22% random swap), then its previous heading, then a
full scan from a randomly chosen end, and only as a last resort the about-face it has been avoiding.
The refuse-to-turn-around rule stops a blocked monster oscillating; the random scan direction
eventually unwedges two monsters stuck in the same doorway. There is still no pathfinding — vanilla
routinely gets monsters stuck on complex geometry too — but this is vanilla's actual algorithm
rather than the "blend in a random lateral angle" heuristic an earlier version used, which produced
a drifting curve into a wall instead of DOOM's flat commit-and-re-route.

Two consequences: monster movement **deliberately doesn't use `slideMove`** (vanilla's `P_Move` is
all-or-nothing; only the player gets `P_SlideMove`, and re-routing rather than sliding is what
produces the zig-zag), and the walk is **interpolated per frame** along the last chase call's
`movedir` rather than jumping a full `speed` units per call — same distance and same 8-way path,
but vanilla's jump only reads as continuous because it renders at 35fps. Everything else
(`groundFloor`, gravity via `settleVertical`) mirrors `Player.update`.

**The per-frame sub-step must never be stricter than the chase step `tryWalk` already approved**
(`escapingOverlap`). Vanilla's `P_Move` tests only the *destination* of a full `speed` jump; it
never asks whether the monster is standing somewhere legal right now. Maps place monsters flush
against walls all the time — 95 across DOOM/DOOM2/SCYTHE, e.g. DOOM2 MAP02's zombieman at
(1056, 960) — which puts the spawn point inside the monster's own radius. Re-validating every
1-unit sub-step as an absolute position then froze those monsters permanently: the 8-unit
destination was clear, but the first sub-step out of the overlap was not, so they woke, faced the
player and shot without ever taking a step. A monster already overlapping is therefore allowed to
walk as long as its committed chase step still lands clear. The escape reaches exactly one chase
step, which is the same bound vanilla's `P_TryWalk` has: 89 of the 95 recover, and the six that
don't are wide types (mancubus, spectre) wedged deeper than one step, which vanilla leaves stuck
too. The extra query is inside the already-blocked branch and measured as free (NUTS.WAD MAP01,
10,617 chasing monsters: 3.6 ms/frame either way).

Two arguments the player's own movement never sets:

- **`forMonster: true`** makes `isSolidWall` additionally treat `LF.BLOCK_MONSTERS` as solid
  (`ML_BLOCKMONSTERS`, used to fence monsters off a ledge while the player walks through freely).
- **`avoidDropoff: true`** — every type except the cacodemon, lost soul and pain elemental
  (`MonsterStats.flies`) — refuses a step whose `groundFloor` rest height would sit more than
  `MAX_STEP_UP` above `World.dropoffFloor`'s lowest touched floor. Vanilla's `P_TryMove` dropoff
  rule, same 24-unit threshold and the same `MF_DROPOFF`/`MF_FLOAT` exemption. This is why a
  grounded monster won't walk off a high ledge chasing the player, which the player themselves
  deliberately can. `tryWalk` treats a dropoff refusal exactly like a wall refusal, so
  `newChaseDir`'s ordinary re-routing already covers a monster balking at a ledge. The three
  exempt types don't just skip this check — they answer a blocked step by changing height
  instead; see § Floating monsters.

**A monster always keeps closing distance — it never "keeps its distance."** Vanilla has no such
instinct: a ranged monster walks right up to the player if nothing stops it. What stops it is real
contact, not a rule — every monster and the player are solid bodies (`World.ThingBlocker`). An
earlier version had no thing-vs-thing collision at all and used `MELEE_RANGE` as a stand-in
"personal space", which let monsters walk through each other and the player, and overshoot and
oscillate past a target. Line of sight gates whether an attack can land; without sight a monster
keeps heading toward its target's *actual* current position (there's no remembered last-known
position).

**Bodies block bodies, using vanilla's box test.** `circleBlocked`/`slideMove` take an optional
`blockers` list, and `blockedByThings` reproduces `PIT_CheckThing`'s check exactly: an axis-aligned
**box** on the summed radii (`abs(dx) < r1+r2 && abs(dy) < r1+r2`), not the circle test the rest of
the collision code uses, and with **no height comparison at all** — vanilla's solid-blocking path
returns before any z check, the well-known "infinitely tall actors" behavior. Both deviations are
deliberate: rounding the box off would change every contact range by up to ~40% on the diagonal,
and a height check would quietly break map geometry that relies on the vanilla rule.
`ThingLayer.solidBodies` is the outward-facing half; monsters get an equivalent list internally
(`blockersFor`). The player *slides* along bodies while monsters don't, matching vanilla exactly.

## Floating monsters

The cacodemon, lost soul and pain elemental (`MonsterStats.flies`) are `MF_FLOAT | MF_NOGRAVITY`,
and all three of those halves are load-bearing — with only the dropoff exemption they still walked
the floor, and **a cacodemon in a pit deeper than `MAX_STEP_UP` could never leave it**: every chase
step out was refused as too big a step up, so it paced the far wall forever while vanilla's floats
straight out (`tests/regression/floating-monster-ledge.test.ts`, `caco_pit_test.wad`: a 48-unit pit).

Three rules, all in `monsters/ai.ts`:

- **A blocked step becomes a height change, not a re-route.** `testStep` splits vanilla's
  `P_TryMove` result three ways instead of two: `'adjust'` is the failure with `floatok` set — the
  destination is one this body fits in at *some* height, so only its own `z` is wrong.
  `floatOverStep` then moves it `FLOATSPEED` toward that destination's floor and the frame counts as
  a move taken (no `moveBlocked`, no re-route), exactly as `P_Move` reports it. `tryWalk` accepts an
  `'adjust'` step for the same reason: vanilla's `P_TryWalk` goes through `P_Move`, so the monster
  stays committed to the ledge it is climbing rather than turning away from it.
- **It hovers toward its target's mid-height** (`settleVertical`, `P_ZMovement`'s `MF_FLOAT` block):
  toward `target.z + MONSTER_HIT_HEIGHT/2`, but only while `dist < |delta|*3`. That gate is why a
  cacodemon in your face settles *below* eye level rather than at it, and it is suppressed while
  `MF_INFLOAT` (`MonsterBody.inFloat`, set by `floatOverStep`) or mid-charge (`MF_SKULLFLY`), so the
  two float rules can't fight each other.
- **It never falls**, and is clamped between the floor under it and the ceiling above it. Gravity
  applies to grounded types only; a flier's `velZ` (only an arch-vile launch ever gives it one)
  rides until floor or ceiling zeroes it. Losing its target doesn't drop it either — `MF_NOGRAVITY`
  outlives the target, so `ThingLayer`'s go-dormant branch leaves a flier's `z` alone.

`testStep` also carries the one check the shared collision code doesn't: vanilla's "mobj must lower
itself to fit" (`tmceilingz - thing->z < thing->height`). `World.blocksMovement` has no ceiling test
because nothing that uses it can be far above its own floor — a hovering monster is the first body
that can, and without this it would sail through the wall above a low doorway.

Cost: the extra `groundCeiling` queries roughly double `stepMonsterAI` for a *flier* (2000 bodies on
SCYTHE MAP01: 0.73 → 1.69 ms/frame) and leave grounded monsters untouched. That is ~0.5 µs per flier
per frame, and no stock map fields more than a few dozen of them.

## Spatial indexing

All of it lives in `game/things/grid.ts` (`createThingGrid`), built over the level's live `posed`
array and rebuilt once per `ThingLayer.update`. It is a closure rather than a set of methods on the
thing layer purely so the pooled buffers and the two bucket arrays below can't be reached from
anywhere else.

`blockersFor` reads a **uniform grid of solid bodies** (`blockerGrid`, rebuilt once per
`ThingLayer.update`) rather than scanning every thing, for the same reason vanilla has a blockmap:
the naive version is O(monsters²) per frame, catastrophic past a stock level's population. Verified
to return exactly the same neighbour set as the linear scan across all of NUTS.WAD's real positions.

Four details are load-bearing:

- **The search box is sized per monster**, from `ownRadius + maxBlockerRadius + BLOCKER_MARGIN`, and
  per *pair* from the two radii actually involved. `blockedByThings` can never report an overlap
  outside `r1 + r2`, so a fixed box is guaranteed waste — and the wrong shape of waste, since one
  radius-128 spider mastermind on the map would otherwise widen every 20-unit grunt's search too.
- **`BLOCKER_MARGIN` is the sum of two independent maxima**, not the max of a per-type sum: the
  monster probing (`tryWalk` tests a full `speed × chaseInterval` step ahead) and the monster that
  drifted since the grid was built (`speed × MAX_FRAME_DT`) are *different* monsters, so the worst
  case pairs the longest probe with the fastest other monster's drift.
- **The grid is a flat array**, not a `Map`. At ~15 cell lookups per monster per frame, `Map.get` on
  a packed numeric key cost more than everything it guarded.
- **`PosedThing.blockRadius` is resolved once at spawn.** `MONSTER_STATS` is a `Record` with sparse
  numeric keys, so V8 backs it with a dictionary — one hash lookup per candidate per monster per
  frame was more expensive than the collision arithmetic.

**The same grid backs `monstersNear`, `monstersAlongStep` and `raycastMonster`**, and none can afford
to be the linear scan they started as, because they are called *per shot in flight*, not per frame:
`monstersAlongStep` runs once per airborne projectile per frame (`game/projectiles.ts`'s
`bodyStruckBy`) and a crowded map can have over a thousand in the air; `raycastMonster` runs once per
monster hitscan. `raycastMonster`'s query is a ray rather than a box, so `forEachMonsterAlongRay`
steps the ray by half a cell and sweeps a square cell neighbourhood at each step — deliberately
simpler than `World.forEachLineAlongSegment`'s exact DDA, and conservative by a wide margin. Monsters
are deduped with a stamp on `PosedThing.queryStamp` rather than a `Set`, since consecutive steps
overlap heavily. All were verified to return results identical to the linear scans across NUTS.WAD,
DOOM2 MAP07 and DOOM E1M7. `monstersInSector` is deliberately left linear — it runs on a crusher
tick, not per frame.

**`stepMonsterAI` resolves sight lazily and memoizes it for the call** (`sightCached`/`canSee`).
Only the refire loop and `runChaseCall` consume it and both run far less often than `stepMonsterAI`
does, so evaluating it up front meant a sightline trace per monster per frame whose answer was
usually thrown away — **measured as the engine's largest single cost on a crowded map**. Vanilla has
the same shape: `P_CheckSight` is called from inside `A_Chase`, not per tic per thinker. Hoisting
the call back out of the closure would undo this.

**Both shot queries size their search from the map's own largest body (`ThingGrid.maxBodyRadius`),
not from the largest in the game.** Since a shot is tested against each body's real `mobjinfo.radius`
rather than one shared 24-unit box (docs/combat.md § How a shot deals damage), the neighbourhood has
to clear whatever the *widest* thing present could reach — 163 units around a spider mastermind, but
still one cell on a map of 20-unit grunts, which is what keeps the common case at its old cost. This
is the same adaptive trick `blockersFor` uses, and for the same reason: a fixed worst-case box is
what made monster AI the frame's bottleneck. Measured against the old flat 40-unit point query, the
wider swept box collects 3.4 candidates per query instead of 2.1 on a stock-shaped population and 9.9
on one containing spider masterminds — 1.5× and 4× the cost of a query that was 0.1 µs to begin with,
so even a thousand shots in the air stay well under half a millisecond a frame.

**`blockerGrid` is not monsters-only, and the difference between solid and shootable is what keeps
that safe.** It admits the exploding barrel and every `SOLID_DECORATION_TYPES` prop, because those
carry vanilla's `MF_SOLID` and so block the player (`solidBodies`) and a monster's own movement
(`blockersFor`) exactly as a monster does — reusing the index costs nothing. But a plain decoration
is *not* `MF_SHOOTABLE`, so `raycastMonster` and `monstersNear` filter `SOLID_DECORATION_TYPES` back
out: a torch stops a demon walking through it and never stops a bullet. Dropping either half of that
is a bug in one direction or the other.

**The arch-vile's corpse check (`findRaisableCorpse`) shares this grid** via a second bucket array,
`corpseGrid`, filled in the same `posed` pass. It originally shipped as a linear scan on the
reasoning that arch-viles are rare enough not to matter — which was never checked against a map that
stresses it (NUTS.WAD has 1,272 of them, and the scan cost most of the frame once they were all
alerted). Unlike the queries above, indexed from the start because their cost was obvious on paper,
this one shipped on an assumption that didn't hold.

For the same reason, `collectFadeTargets` (render/occlusion.ts) caps them at `MAX_FADE_TARGETS`
(nearest first):
`WallFader`/`FlatFader` cost is quads × targets. It's purely a cost bound — past a couple of dozen
nearby monsters, every wall any of them stands behind is already faded by a nearer one.

## Melee reach

`runChaseCall`'s melee gate is three tests: 2D distance against `MELEE_RANGE`, a vertical-overlap
check (`meleeReachesVertically`), and `hasLineOfSight`.

**The vertical check is a deliberate deviation from vanilla, and the only one in the attack path.**
`P_CheckMeleeRange` (`p_enemy.c`) tests `P_AproxDistance` and `P_CheckSight` and *nothing else* — so
a vanilla pinky standing in a pit really can bite someone on the lip above it, and one on a ledge can
bite someone below. ZDoom added a guard for this and gates it behind `MF5_NOVERTICALMELEERANGE`
(`p_enemy.cpp`, commented "Don't melee things too far above or below actor"):

```c
if (pl->Z() > actor->Top())  return false;
if (pl->Top() < actor->Z())  return false;
```

This engine follows ZDoom, because vanilla's version reads as a bug to anyone who has played a
source port. Both comparisons are **strict**, so bodies that exactly touch still connect. Heights
are this engine's approximate boxes, not per-type `mobjinfo.height`: `MONSTER_HIT_HEIGHT` for the
attacker, and the target's own — `PLAYER_HEIGHT` when `ThingLayer` resolved the target to the
player, `MONSTER_HIT_HEIGHT` for an infight — threaded in as `stepMonsterAI`'s `targetHeight`.

Repro maps, committed as fixtures: `tests/fixtures/wads/pinky_{below,above}_test.wad`, covered by
`tests/regression/pinky-vertical-melee.test.ts`. `above` is the sharper of the two — standing at the
wall the sight wedge is already clipped by the ledge lip, so the missing check only showed once the
player backed off far enough to see over it.

**The threshold is vanilla's own formula, not a flat range**: `meleeThreshold` is
`MELEERANGE - 20 + target->info->radius` (`p_enemy.c`, with `MELEERANGE` 64 from `p_local.h`), so a
swing reaches **60** units at the player (radius 16) and further at a wider victim in an infight —
74 at a demon, 84 at a cyberdemon. GZDoom arrives at the same number from the other side, storing
the shortened 44 as `AActor::meleerange` and comparing `dist >= meleerange + pl->radius`. The
comparison is **exclusive** both places (vanilla returns false on `>=`).

A flat `MELEE_RANGE = 72` stood in for all of that until the pinky maps were tested, which made
every melee monster reach ~20% further than either vanilla or GZDoom and ignored the victim's width
entirely. Distance itself is a real `hypot`, not `P_AproxDistance`'s octagonal approximation — that
exists only to dodge a fixed-point square root.

`MELEE_RANGE` (now the vanilla 64) is also `P_LookForPlayers`' own "if real close, react anyway"
exemption to the 180° wake-up gate (`canSpotPlayer`), which uses **bare `MELEERANGE`** with no bias
and no radius term. The lost soul's charge does *not* use it: `A_SkullAttack` damages whatever its
moving box overlaps, so its contact test is `SKULL_CONTACT_RANGE`, marked at its declaration as this
engine's own anti-tunnelling approximation rather than a vanilla figure.

## Attacking

**Walking and attacking are mutually exclusive: a monster plants itself for the whole length of its
attack.** Vanilla genuinely enforces this — an attack is a state sequence of its own, and `A_Chase`
(the only caller of `P_Move`) doesn't run again until it ends. `AttackStats.duration` is that
sequence's summed tics over 35, read off `info.c`, and `MonsterBody.attackPause` holds the monster
still for exactly that long. It ranges from 0.43s (a cacodemon's bite/spit) to 2.7s (an arch-vile),
and its absence was very visible: a mancubus never planted for its volley, a zombieman never stopped
to raise its pistol.

Multi-shot attacks fall out of the same field. `AttackStats.shots`/`shotInterval` reproduce the
attacks where vanilla fires several times from inside one `missilestate` rather than making a fresh
`A_Chase` decision per shot: the cyberdemon's three rockets (12 tics apart), the mancubus's three
volleys, the chaingunner's and spider mastermind's paired bullets. `AttackStats.refire` is the
extreme case — `A_CPosRefire`/`A_SpidRefire` (chaingunner, spider mastermind, arachnotron) jump the
attack state straight back into itself and only break out when the target stops being visible, never
re-rolling `P_CheckMissileRange`. Those three plant themselves and hose continuously for as long as
they can see the player.

**A ranged attack's firing chance falls off with distance** — vanilla's
`A_Chase`/`P_CheckMissileRange`, run as the real per-chase-call decision rather than a cooldown.
Three gates stand between one shot and the next, applied by `runChaseCall` on vanilla's cadence:

1. `MF_JUSTATTACKED` — the call right after an attack always re-routes instead ("do not attack twice
   in a row").
2. The **`movecount` gate**, the heavyweight: `A_Chase` refuses to even *consider* a missile while
   `movecount` is nonzero, and `P_TryWalk` reseeds it to `P_Random() & 15` every time the monster
   commits to a direction. So a monster only gets a chance to fire roughly every 8-9 chase calls.
   Missing this entirely was the original "monsters shoot far more than vanilla" bug.
3. `P_CheckMissileRange`'s roll — `P_Random() < dist` *suppresses* the shot, so the fire chance is
   `(256 - dist) / 256`. A failed roll falls into `P_NewChaseDir` and pays gate 2 again.

An intermediate version modelled 2 and 3 statistically, converting an expected attempt count into a
cooldown, because sampling a per-attempt probability every render frame would resolve it almost
immediately no matter how small. Running the chase logic on a discrete `chaseInterval` tick removes
that at the source — the roll is sampled exactly as often as vanilla samples it, and off the same
table vanilla samples it from (docs/random.md § The table and the two cursors).
`AttackStats.ranged`'s `rangeFalloffScale`/`Cap` reproduce vanilla's per-type offset/halving/clamp
(halved for exactly the types vanilla special-cases — cyberdemon, spider mastermind, revenant, lost
soul — making them noticeably more willing to fire from far away; the cyberdemon gets an extra-tight
160-unit cap). `MF_JUSTHIT` short-circuits all of it: a monster that just took a hit fires back
immediately regardless of distance.

**Ranged attacks have no maximum range**, and giving them one was a mistake worth recording.
`P_CheckMissileRange` never rejects a shot for being too far — the falloff above is the *whole*
mechanism. There are exactly two real distance gates, both per-type and both measured on the
*offset* distance (after `P_CheckMissileRange`'s own -64/-192 subtraction): the revenant won't fire
inside 196 units (`minOffsetDist`, `MT_UNDEAD`'s rule — it prefers to close to melee rather than lob
one from just outside fist's reach), and the arch-vile won't fire beyond `14*64` = 896
(`maxOffsetDist`). Hand-picked 1000-2400 unit caps stood in for the falloff before it was modelled;
once it was, all they did was stop monsters firing from distances vanilla shoots from happily. A
hitscan attack otherwise reaches `WEAPON_RANGE` (`MISSILERANGE`, 2048) and a projectile flies until
it hits something.

## Infighting

**Monsters fight each other**, by exactly vanilla's mechanism: nothing about being hurt is
player-specific. `ThingLayer.damage` takes an optional `source`, and a monster hit by another
re-points its `targetId` at the attacker (`shouldRetarget`/`commitTarget`); `stepMonsterAI` takes a
plain `target` position and never learns whether it's chasing the player or a baron.
`MonsterAttacks` is where a shot finds out who it hit — `resolveHitscan` damages the first body
along the bolt
(`PTR_ShootTraverse` has no notion of an intended target and no species check, which is why one
zombieman firing past another starts a fight), and `bodyStruckBy` does the same per frame for a
projectile.

Three vanilla rules keep it from degenerating:

- **A committed monster ignores new attackers** for `BASE_THRESHOLD` (100) chase calls
  (`MonsterBody.threshold`). Without it a brawl turns into everyone spinning to face the last stray
  hit and nobody landing a second blow.
- **Nothing ever retaliates against an arch-vile**, and an arch-vile re-targets even while
  committed — vanilla singles out `MT_VILE` in both directions so its resurrect/flame behavior can't
  start a fight with the monsters it's helping.
- **A projectile deals no damage to the shooter's own species — but is *stopped* by it**
  (`sameSpecies`; `bodyStruckBy` owns the stop-vs-pass distinction), with baron and hell knight
  counting as one species in both directions (vanilla's single hardcoded cross-type pairing). A pack
  of imps can throw fireballs across each other all day; one imp fireball landing on a demon starts
  something. **Projectiles only** — hitscan has no species check in vanilla, so zombiemen really do
  gun each other down.

  **"Stopped by it" is the load-bearing half, and reading it as pass-through was a shipped bug.**
  Vanilla's branch is `if (thing == tmthing->target) return true;` — the *shooter's own body*,
  genuinely passed through so a missile can leave the monster that fired it — followed by
  `if (thing->type != MT_PLAYER) return false;` under the comment "Explode, but do no damage."
  `return false` is `P_TryMove` failing, which for a missile is `P_ExplodeMissile` on the spot. So
  any *other* same-species body detonates the missile harmlessly on contact. Skipping them and
  flying on silently converted a fizzle into a guaranteed eventual kill on whatever was downrange —
  on a crowded map that decides the fight outright (NUTS.WAD's revenants stand shoulder to shoulder,
  so in vanilla nearly every revenant missile dies on a neighbour within a few units of the muzzle
  and only the few with a clear lane reach anything). The blast is unaffected either way:
  `P_ExplodeMissile` runs the missile's death state regardless, so a cyberdemon rocket fizzling on
  another cyberdemon still calls `A_Explode` and still splashes. Fixing this settled two smaller
  things in the same function: candidates are resolved **first-along-the-step** (with a fizzle and a
  real hit both possible among the bodies a missile passes, which one it picks matters), and
  `bodyStruckBy` returns a result *object* rather than a bare id, removing a latent truthiness bug
  — `posed` index 0 is a valid monster id, and `if (reachedPlayer || struck || …)` treated a hit on
  it as no hit.

A target that dies hands attention straight back to the player (`resolveTarget`), matching
`A_Chase`'s fallback to `P_LookForPlayers` once `target->health <= 0` — unless the player is dead too,
in which case `resolveTarget` reports no target at all and the monster reverts to idle instead of
turning on the corpse (`game/things.ts`'s per-frame update loop, docs/death.md § Player death). A
monster already infighting someone else is unaffected by the player's death and fights on regardless.

## The lost soul: a charge, not a projectile

`A_SkullAttack` gives it no projectile at all — it sets `MF_SKULLFLY` and launches the monster along
its own facing at `SKULLSPEED` (700 units/sec), dealing contact damage through `PIT_CheckThing` and
clearing the flag on any blocked move. `AttackStats.charge` plus `stepCharge` reproduces that, and
it's why the lost soul can carry vanilla's real chase speed — 46.7 units/sec, by far the slowest in
the game, less than a fifth of a walking player. Modelling it as a fast melee walker (an eyeballed
260 units/sec) got the threat roughly right by getting both halves wrong; with the charge in place
the vanilla numbers work, because a lost soul is meant to drift harmlessly and then commit.
`stepCharge` is deliberately the one movement here that doesn't use `slideMove`: a charge that
rounded corners would home in on the player, and being able to sidestep a committed lost soul is the
whole reason the attack is fair.

## The pain elemental: spawning a lost soul

`A_PainAttack` deals no damage and fires nothing of its own — it calls `A_PainShootSkull`, which
spawns a new `MT_SKULL` in front of the elemental and immediately hands it to the lost soul's own
`A_SkullAttack`, so the elemental's real attack is entirely mediated through a monster this engine
already models. `AttackStats.spawn` marks the elemental's `ranged` entry as this kind;
`beginRangedAttack` reports a `'spawn'` event the instant the attack starts, and
`things.ts: spawnLostSoul` carries it out, since only `ThingLayer` (which owns the `posed` array) can
add one. It's applied directly inside `ThingLayer.update` rather than reported through
`MonsterAttackEvent` — spawning a monster isn't damage for `MonsterAttacks` to apply.

Two vanilla details reproduced exactly: the spawn point is `4 + 1.5×(elemental radius + lost soul
radius)` map units in front along the elemental's facing (`4*FRACUNIT + 3*(actor->info->radius +
skullradius)/2`, both radii already plain map units here so the shared fixed-point scaling divides
out) and 8 units above its feet, and nothing spawns if that point has no room — vanilla's `P_TryMove`
check, which in real vanilla spawns the mobj and then kills it with 10000 damage, a difference with
no visible consequence. There's also a real level-wide cap: vanilla refuses another skull once 20
already exist anywhere on the level (a plain count of living `MT_SKULL`, not a per-elemental tally),
so a room full of elementals throttles itself; `spawnLostSoul` counts `posed` the same way.

One detail is deliberately simplified: `A_PainShootSkull` hands the new skull `actor->target` and
calls `A_SkullAttack` *synchronously*, so it launches already knowing where its target stands.
`ThingLayer.damage` (the death-triggered triple spawn) has no player position on hand to match that,
so every spawned skull instead starts already `alerted`, with `targetId` copied from the elemental's
own (`null` meaning the player) and `reactionTicks`/`movecount` pre-zeroed, so its first ordinary
chase call rolls straight into `checkMissileRange` and its own charge. The visible difference is at
most one `chaseInterval` (~0.17s) of drift, not a different mechanic.

**A killed pain elemental spawns three more** (`A_PainDie`), fired unconditionally on death
regardless of what attack was under way — vanilla calls it from the death state sequence itself, not
from anything AI-related. `ThingLayer.damage`'s death branch calls `spawnLostSoul` three times,
fanned 90°/180°/270° around the elemental's last facing, subject to the same placement and cap rules.
This is what makes killing one at melee range reliably worse than shooting it from a distance.

`ThingLayer.damage`'s death branch checks one other thing right after: whether the monster that just
died was the last living one of a doomednum `A_BossDeath` cares about, which on the right map fires a
level-wide special (a lowering floor, an exit) rather than anything AI-related — see docs/death.md
§ Boss death.

## Commander Keen

`MT_KEEN` (doomednum 72) and `MT_BOSSBRAIN` (88) are the two `MONSTER_TYPES` members with **no
`MONSTER_STATS` entry**, and that is not an omission: neither has a `seestate`, `meleestate` or
`missilestate` in `info.c`, so neither wakes, moves, chases or attacks in vanilla either. They are
`MF_SOLID|MF_SHOOTABLE` targets that stand still, flinch and die. `monsters/defs.ts`'s `INERT_SHOOTABLE`
holds what a `MonsterStats` would otherwise carry for them — the real `mobjinfo.radius` (16 for both,
not the 24-unit `MONSTER_HIT_RADIUS` fallback) and the two sounds `A_Pain`/`A_Scream` play — and
`ThingLayer.damage` has a matching branch that skips pain rolls, retargeting, knockback and
infighting wholesale.

The flinch is **unconditional** for both, which is exact rather than a simplification: Keen's
`painchance` is 256 and the brain's 255, so vanilla stagger them on every hit or all but one in 256.
There is deliberately no `painChance` field in `INERT_SHOOTABLE` for that reason.

Keen is `MF_SPAWNCEILING`, so it hangs — `CEILING_HUNG_HEIGHT[72] = 72` (its own `mobjinfo.height`),
the same table the gore props use, and because it never enters the AI branch of `ThingLayer.update`
it keeps measuring `z` down from the live `ceilHeight` even as a corpse. Its death is the long
12-frame `S_COMMKEEN` chain (`KEEN A`-`L`) and its pain frame is `KEEN M`, both off `info.c`'s state
table rather than the rotation-0-tail derivation the other death tables use — Keen's whole sprite is
rotation-0, so that derivation has nothing to key on.

**`A_KeenDie` is the payoff**: once every Keen on the level is dead it opens the tag-666 door. Unlike
every `A_BossDeath` case it is *not* gated on `gamemap`, which is why `bossDeathTriggersFor` appends
Keen's trigger to every map's table rather than putting it in the per-map switch — docs/death.md §
Boss death. One accepted simplification: vanilla runs it on the eleventh death frame, this engine
fires it at the death instant. The delay is purely cosmetic here, unlike the barrel's `A_Explode`
delay, which is gameplay-relevant and *is* modelled.
