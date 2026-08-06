# Monster AI

`src/game/monsters.ts`, `src/game/things.ts`

Every `MONSTER_TYPES` entry except Commander Keen (72) and the boss brain (88) wakes, chases and
attacks — neither of those two attacks or moves in vanilla either.

**Layering.** `monsters.ts`'s `stepMonsterAI` (chasing/attacking) and `tryWake` are pure functions
that read/write a monster's own mutable state and return *what happened* (a fired `MonsterAttack`,
or whether it woke). `ThingLayer.update` (`things.ts`) is where that state lives — each
`PosedThing` carries its AI fields — and owns the throttle that calls `tryWake`. `Game.frame`
turns a returned attack into damage and, for a ranged one, a tracer. Same split as
`WeaponSystem`/`SpecialsController`.

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

Two arguments the player's own movement never sets:

- **`forMonster: true`** makes `isSolidWall` additionally treat `LF.BLOCK_MONSTERS` as solid
  (`ML_BLOCKMONSTERS`, used to fence monsters off a ledge while the player walks through freely).
- **`avoidDropoff: true`** — every type except the cacodemon, lost soul and pain elemental
  (`MonsterStats.flies`) — refuses a step whose `groundFloor` rest height would sit more than
  `MAX_STEP_UP` above `World.dropoffFloor`'s lowest touched floor. Vanilla's `P_TryMove` dropoff
  rule, same 24-unit threshold and the same `MF_DROPOFF`/`MF_FLOAT` exemption. This is why a
  grounded monster won't walk off a high ledge chasing the player, which the player themselves
  deliberately can. `tryWalk` treats a dropoff refusal exactly like a wall refusal, so
  `newChaseDir`'s ordinary re-routing already covers a monster balking at a ledge.

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

## Spatial indexing

`blockersFor` reads a **uniform grid of living monsters** (`blockerGrid`, rebuilt once per
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

**The same grid backs `monstersNear` and `raycastMonster`**, and neither can afford to be the linear
scan it started as, because both are called *per shot in flight*, not per frame: `monstersNear` runs
once per airborne projectile per frame (`game.ts`'s `monsterStruckBy`) and a crowded map can have
over a thousand in the air; `raycastMonster` runs once per monster hitscan. `raycastMonster`'s query
is a ray rather than a box, so `forEachMonsterAlongRay` steps the ray by half a cell and sweeps each
step's 3×3 cell neighbourhood — deliberately simpler than `World.forEachLineAlongSegment`'s exact
DDA, and conservative by a wide margin. Monsters are deduped with a stamp on `PosedThing.queryStamp`
rather than a `Set`, since consecutive steps overlap heavily. Both were verified to return results
identical to the linear scans across NUTS.WAD, DOOM2 MAP07 and DOOM E1M7. `monstersInSector` is
deliberately left linear — it runs on a crusher tick, not per frame.

**The arch-vile's corpse check (`findRaisableCorpse`) shares this grid** via a second bucket array,
`corpseGrid`, filled in the same `posed` pass. It originally shipped as a linear scan on the
reasoning that arch-viles are rare enough not to matter — which was never checked against a map that
stresses it (NUTS.WAD has 1,272 of them, and the scan cost most of the frame once they were all
alerted). Unlike the queries above, indexed from the start because their cost was obvious on paper,
this one shipped on an assumption that didn't hold.

For the same reason, `game.ts` caps occlusion-fade targets at `MAX_FADE_TARGETS` (nearest first):
`WallFader`/`FlatFader` cost is quads × targets. It's purely a cost bound — past a couple of dozen
nearby monsters, every wall any of them stands behind is already faded by a nearer one.

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
that at the source — the roll is sampled exactly as often as vanilla samples it.
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

## Hitscan vs. projectile

Which one a type uses matches vanilla (`AttackStats.ranged.projectile`, `game.ts`'s
`spawnMonsterProjectile`/`PROJECTILE_FRAMES`/`IMPACT_EFFECTS`). The human gunners (zombieman,
shotgun guy, chaingunner, Wolfenstein SS) and the spider mastermind fire real hitscan bullets and
keep the tracer, coloured red to read as hostile and distinct from either of the player's own. The
imp (`BAL1`), cacodemon (`BAL2`), baron/hell knight (`BAL7`), mancubus (`MANF`), arachnotron
(`APLS`), revenant (`FATB`) and cyberdemon (`MISL`, the same sprite the player's rocket launcher
uses) throw a real projectile. Sprite names and frame counts were confirmed by dumping the actual
`DOOM2.WAD` lumps and cross-checked against `info.c` — including the mancubus's genuine vanilla
oddity of exploding with the *rocket's* `MISL` frames, since `MANF` has no explosion frames at all.
The lost soul, arch-vile and pain elemental's ranged attacks are none of these — see below.

**The mancubus fires its shots in pairs** (`AttackStats.projectile.pairOffsetsRad`): each of
`A_FatAttack1/2/3` spawns *two* `MT_FATSHOT`s, fanned around the aim line by `FATSPREAD`
(`p_enemy.c`). The array holds one entry per shot in the burst, each listing that shot's projectiles
as radian offsets from straight-at-target. `P_SpawnMissile` computes its own angle at the target and
ignores the firing actor's facing, so only the *second* missile of `A_FatAttack1`/`2` is deflected
(`+FATSPREAD` / `-2*FATSPREAD`) while `A_FatAttack3`'s pair straddles the aim line evenly
(`±FATSPREAD/2`) — a real vanilla asymmetry, not a transcription slip. Every other projectile monster
omits the field and fires one straight shot per burst entry.

**A monster's hitscan bolt tests against the player's radius plus `MONSTER_BULLET_SLOP` (12).**
Vanilla resolves the bolt against the player's real 16-unit box with an aim computed the same tic;
here it is fired along the angle the monster faced when its attack *started*, up to a whole
attack-state earlier. Without the tolerance a strafing player is missed by shots vanilla would land.

**Flight speed is that missile type's own `mobjinfo.speed`.** For a missile that field is plain
fracunits *per tic*, so the conversion is `× 35`: imp/cacodemon 350, baron/hell knight 525, mancubus
700, arachnotron 875, revenant's `MT_TRACER` 350, cyberdemon's `MT_ROCKET` 700, lost soul's
`SKULLSPEED` 700. Having these eyeballed was a shipped bug across the whole table, worst on the
revenant: 750 against vanilla's 350, i.e. **faster than the player's own 500-unit/sec run**. A
missile faster than the thing it's chasing cannot be evaded at all, which took away both halves of
what a revenant missile is — a shot you *can* outpace, which then curves back and keeps coming.

(The player's own `weapons.ts: WeaponDef.projectileSpeed` values are still hand-picked and off
vanilla — rocket 1000 vs 700, plasma 1600 vs 875, BFG 700 vs 875 — deliberately left alone, since
those are a feel decision about the player's weapons rather than about how avoidable an incoming
shot is.)

**Direct-hit damage is one universal formula** (`PIT_CheckThing`): `(rand%8+1) × that missile type's
own `mobjinfo.damage``. So `diceSides` is `8` for every projectile monster and only `diceMult`
varies — imp 3, cacodemon 5, baron/hell knight 8, mancubus 8, arachnotron 5, revenant 10, cyberdemon
20. The lost soul's `MF_SKULLFLY` contact damage (`AttackStats.charge`) is the same formula through
the same code path with `MT_SKULL`'s own damage field (3). Melee dice are each monster's own
`A_*Attack` roll instead: `A_TroopAttack` `(rand%8+1)*3`, `A_SargAttack` `(rand%10+1)*4`,
`A_HeadAttack` `(rand%6+1)*10`, `A_BruisAttack` `(rand%8+1)*10`, `A_SkelFist` `(rand%10+1)*6`. An
earlier version of this table had every monster's dice tuned softer.

**Two monsters fire more than one pellet per call**, reproduced as a summed dice roll rather than N
traced shots: the shotgun guy's `A_SPosAttack` fires three `(rand%5+1)*3` pellets, and the spider
mastermind fires the same function twice (`pellets: 3` on top of `shots: 2`). Vanilla gives each
pellet its own random spread, which this engine's monster hitscans don't model — but with no spread
every pellet travels the identical ray, so summed dice and independent rolls are the same outcome,
not an approximation.

**Only the cyberdemon's rocket splashes**, confirmed by checking every monster fireball's own death
state in `info.c` rather than assumed either way. `A_CyberAttack` spawns a real `MT_ROCKET`, whose
death state `S_EXPLODE1` is the one monster-projectile death state in the game that calls
`A_Explode`; every other fireball's death state has no action, so none of them ever call
`P_RadiusAttack`. `AttackStats.projectile.splash` (`{radius: 128, damage: 128}`, vanilla's literal
`P_RadiusAttack(thingy, thingy->target, 128)`, identical to the player's own rocket) is set only
there. The splash still can't hurt the cyberdemon or spider mastermind, per `applyRadiusDamage`'s
existing exemption.

## The revenant's homing missile

`AttackStats.projectile.homing`, `game.ts`'s `advanceHomingProjectile` — vanilla's `A_Tracer`, the
one monster projectile with a homing flight state. Every other fireball's fixed straight line is
correct for it, not a shared simplification.

**Not every revenant missile homes, and that is vanilla's own behavior** (per
[doomwiki.org/wiki/Revenant](https://doomwiki.org/wiki/Revenant), since it isn't obvious from
`p_enemy.c` alone): `A_Tracer` only turns and trails smoke on tics where the *global* counter
`gametic & 3 == 0`, and a revenant's attack-state cycle keeps a fixed parity relative to that
counter, so every missile a given revenant fires lands on the same side of the gate. A revenant is
either a guided or an unguided shooter for a stretch of shots, not a fresh coin flip per shot, until
a staggering hit (or its first wake) reshuffles it. This engine has no discrete tic clock to
reproduce the gate, so `MonsterBody.homingBias` is a direct stand-in: a persistent coin flip per
revenant, seeded on spawn and rerolled on wake and on a pain flinch, threaded into `fireAttack`.
`Projectile.homing` — and so both the turning and the smoke — only ever attaches to a shot that won
the roll; a shot that loses it is a plain `FATB` flying the ordinary straight line.

`advanceHomingProjectile` turns the heading toward the target's *current* bearing by at most
`REVENANT_TRACER_TURN_RATE_RAD` per second (vanilla's clamped `TRACEANGLE`, 16.875° every 4th tic,
converted to a continuous rate — a smooth curve either way, unlike the AI clock where discreteness
is load-bearing) and eases height toward the target's `TRACER_HOMING_Z_OFFSET`-above-feet point over
the distance still separating them (the continuous equivalent of vanilla's `momz` spring, which
paces itself off the same live distance and converges the same way without a persisted vertical
velocity). A dead or missing target (`!dest || dest->health<=0`) leaves the missile on its current
heading — it doesn't stop, retarget or fall. Because its path isn't the fixed ray every other
projectile uses, `Projectile.homing` carries its own live `x`/`y`/`z`/`headingRad`.

**A homing missile has no flight-distance budget**, unlike every straight projectile here. A
straight shot's whole flight lies on the ray `shotPath` traced at launch, so `maxDist` is a correct
stopping point known up front. A curving one leaves that ray almost immediately — looping back
toward a target that sidestepped, which *is* the mechanic — so the wall the launch ray found says
nothing about where it ends up; spending its distance against that budget detonated it mid-air,
typically mid-turn on the way back around. Vanilla puts no lifetime or range limit on a missile
either (`P_TryMove` tests each move against the lines it actually crosses), so
`advanceHomingProjectile` checks each frame's step against the geometry that step really crossed
(`world.ts: projectileStepBlocker`, the per-step counterpart to `shotPath`'s launch-time trace,
reusing the identical `blocksShot` predicate at the height the step is at) and stops there, updating
`Projectile.lineIndex` so a shoot-triggered special still fires on the right line. No safety cap
stands behind that: every real map is enclosed, and capping it would reintroduce the mid-air
detonation this removes.

**It also reproduces `P_ZMovement`'s floor/ceiling hit** — a real mechanic for every missile in
vanilla, but never reachable for this engine's other projectiles, whose height is a straight
interpolation between two points already validated at launch. A homing missile's height *eases*
toward a target that can sit on a very different floor while its `x`/`y` curves over terrain
`shotPath` never re-checked; without this, easing toward a lower target while passing over higher
ground visibly sank the sprite into that floor. Checked every frame via `World.floorAt`/`ceilingAt`;
hitting either clamps `z` and forces `p.traveled = p.maxDist`, the same signal a straight flight
sends on running out of budget — and, since this branch never accumulates `traveled` itself, that
forcing is the only thing that ends a homing flight short of reaching a body.

**A guided missile trails smoke; an unguided one doesn't** — the wiki's "the homing missiles can be
distinguished by a gray smoke trail" is the entire visible tell, and gating it on
`Projectile.homing` falls out for free. `advanceHomingProjectile` spawns vanilla's `MT_SMOKE` (which
reuses the plain bullet-puff sprite `PUFF`, frames `B,C,B,C,D` per `S_SMOKE1`-`5`) every
`SMOKE_TRAIL_INTERVAL`, the same 4-tic cadence `A_Tracer` gates the turn with. Vanilla also spawns a
second, redundant `MT_PUFF` one step further behind at the same moment — cosmetically near-identical
smoke from the same sprite, so reproducing only one loses nothing.

## Monster projectiles in flight

A monster projectile reuses the same `Projectile`/`updateProjectiles` machinery the player's own
rocket/plasma/BFG shots use, distinguished by a non-null `sourceId` (with the doomednum along as
`sourceType` for the species check). It's launched via `shotPath` like a player's locked-on shot
(stopped early only by a real wall), aimed at whichever target the monster fired at — the player, or
another monster in an infight (`atk.targetId`, resolved live via `ThingLayer.monsterById` rather
than trusted from launch time). Unlike a player's shot, whose target never moves mid-flight, its
arrival is re-checked every frame against the player's *live* position
(`MONSTER_PROJECTILE_HIT_RADIUS`/`_HEIGHT`) and every other living monster it might clip
(`monsterStruckBy`, `sameSpecies`-gated), so stepping behind cover or outrunning a slower fireball
actually works.

**Both live arrival tests are gated on `hasLineOfSight`, and that gate is load-bearing.** The hit
test is a fat 2D disc (40 units) plus ±128 height tolerance, and a projectile's flight *ends* at
whatever wall `shotPath` found — so on the last frames before it bursts, anyone within that disc on
the **far** side of that wall took a full direct hit through it. The trace runs **from the
player/monster toward the projectile**, not the other way round: by then the impact point sits
essentially *on* the wall, and `hasLineOfSight`'s own `SELF_HIT_MARGIN` would discard that crossing
as a self-hit and report the wall it just stopped against as clear. Both checks sit **last** in
their condition chains, so they only run for a candidate the cheap proximity tests already accepted.

## Infighting

**Monsters fight each other**, by exactly vanilla's mechanism: nothing about being hurt is
player-specific. `ThingLayer.damage` takes an optional `source`, and a monster hit by another
re-points its `targetId` at the attacker (`shouldRetarget`/`commitTarget`); `stepMonsterAI` takes a
plain `target` position and never learns whether it's chasing the player or a baron. `game.ts` is
where a shot finds out who it hit — `resolveMonsterHitscan` damages the first body along the bolt
(`PTR_ShootTraverse` has no notion of an intended target and no species check, which is why one
zombieman firing past another starts a fight), and `monsterStruckBy` does the same per frame for a
projectile.

Three vanilla rules keep it from degenerating:

- **A committed monster ignores new attackers** for `BASE_THRESHOLD` (100) chase calls
  (`MonsterBody.threshold`). Without it a brawl turns into everyone spinning to face the last stray
  hit and nobody landing a second blow.
- **Nothing ever retaliates against an arch-vile**, and an arch-vile re-targets even while
  committed — vanilla singles out `MT_VILE` in both directions so its resurrect/flame behavior can't
  start a fight with the monsters it's helping.
- **A projectile deals no damage to the shooter's own species — but is *stopped* by it**
  (`sameSpecies`; `monsterStruckBy` owns the stop-vs-pass distinction), with baron and hell knight
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
  things in the same function: candidates are resolved **nearest-first** (with a fizzle and a real
  hit both possible among the bodies a missile arrives among, which one it picks now matters), and
  `monsterStruckBy` returns a result *object* rather than a bare id, removing a latent truthiness bug
  — `posed` index 0 is a valid monster id, and `if (reachedPlayer || struck || …)` treated a hit on
  it as no hit.

A target that dies hands attention straight back to the player (`resolveTarget`), matching
`A_Chase`'s fallback to `P_LookForPlayers` once `target->health <= 0` — unless the player is dead too,
in which case `resolveTarget` reports no target at all and the monster reverts to idle instead of
turning on the corpse (`game/things.ts`'s per-frame update loop, docs/combat.md § Player death). A
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
`MonsterAttackEvent` — spawning a monster isn't damage for `game.ts` to apply.

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
level-wide special (a lowering floor, an exit) rather than anything AI-related — see docs/specials.md
§ Boss death.

## The arch-vile

Both signature mechanics are modeled, confirmed against `p_enemy.c`/`info.c`.

**Resurrection** (`A_VileChase`/`PIT_VileCheck`) is `MonsterStats.resurrects`, set only for the
arch-vile: on every chase call where it has a `movedir`, it checks one chase-call's travel ahead
(vanilla's `viletryx`/`viletryy`) for a raisable corpse — `MF_CORPSE`, not still mid-death-animation
(vanilla's `tics != -1`; here `deadTime` against `deathFrameCount * MONSTER_DEATH_FRAME_SECONDS`),
within `corpse.radius + vile.radius` (vanilla's box test, not a circle), and with room to stand back
up (`circleBlocked` against the corpse's footprint) — and raises it *instead of* taking its ordinary
chase-call turn at all, matching vanilla exactly: a tic that resurrects skips the reactiontime/
threshold aging and the melee/missile/walk decision entirely.

`thingdefs.ts: MONSTER_RAISE_FRAMES` is vanilla's `raisestate` table for the 13 types that have one
(every boss, the lost soul, the arch-vile itself, Commander Keen and the boss brain don't). These
had to be pulled from `info.c` directly — reusing `MONSTER_DEATH_FRAMES` reversed was tried first
and is wrong, since vanilla's raise sequences are hand-authored per type and share no derivation
rule (the zombieman's 3 raise states reverse its death sequence's *middle* frames, the shotgun guy's
4 reverse its *entire* sequence including the settled final frame, despite both sprites sharing the
identical death letter range).

`ThingLayer.reviveCorpse` is the revival: full health back, immediately alerted and re-targeting the
player (`corpsehit->target = NULL`), held still (`attackPause`) for exactly as long as its raise
animation takes — reusing `SpriteActor.revive()` (undoes `die()`) plus `playOnce`, the same
one-shot-then-hand-back mechanism attack/pain poses use, just running dead-to-alive. The vile's own
`S_VILE_HEAL1-3` art is deliberately not reproduced: those states reference sprite frame indices
26-28, past `Z` (25), with no corresponding WAD lumps at all — a genuine vanilla quirk, not a
transcription slip — so the vile keeps its ordinary held pose during the hold.

**The attack** (`A_VileAttack`) is `AttackStats.blast`: guaranteed un-rolled direct damage
(`diceSides: 1, diceMult: 20` — `rollDamage` with one side always returns the multiplier, encoding
vanilla's literal unrolled `20`) plus an upward launch (`Player.launchUpward`/`ThingLayer.damage`'s
`knockUpSpeed`, vanilla's `momz = 1000*FRACUNIT/mass` using the default mass 100), followed by a
separate radius blast (`P_RadiusAttack(fire, actor, 70)`) centered near the *victim*.

Two things make its timing different from every other ranged monster:

- **`AttackStats.startDelaySeconds`** (66/35s) — `A_VileAttack` doesn't fire until 66 tics into its
  `missilestate` chain, unlike every other monster's shots, which fire on the next tick after
  `A_Chase` commits. The windup having no mechanical consequence is an accepted simplification
  everywhere else; here it is the mechanic.
- **A second line-of-sight check at the exact moment the shot fires** (`stepMonsterAI`'s burst-fire
  block, gated on `ranged.blast`). `A_VileAttack` calls `P_CheckSight` again right before dealing
  any of this, so breaking sight during the ~1.9s windup makes the whole attack fizzle — the entire
  reason ducking behind cover saves you.

**That second check is sight-only — there is deliberately no distance re-check, and that is
vanilla's own behavior.** `checkMissileRange`'s `maxOffsetDist` (896) only gates *starting* the
attack; once committed the vile is planted for the full 2.686s and the eventual sight check never
looks at distance, so a target that triggered the cast and then ran far away while staying in sight
still takes the guaranteed hit — vanilla's infamous long-range vile snipes. On a very open map
(NUTS.WAD's vile arena is essentially one continuous floor) this means sight stays connected across
thousands of units, and a player has to start retreating almost the instant the vile commits — which
is exactly what the windup flame exists to signal. This does **not** generalize: every non-vile
ranged attack fires within about a frame of its own sight check, so no comparable gap exists.

Getting this delay real is what exposed a latent bug in `render/sprites.ts: SpriteAnimator.advance`,
unrelated to the arch-vile: `animIndex` is one field shared across the death/override/base-cycle
domains, and nothing re-validated it against `animFrames` the instant `attackPause` reached 0 while
its attack-pose `playOnce` was still running. No other monster can trigger it — their shots fire
near the start of `duration`, so `attackPause` always outlasts the pose — but the vile's leaves a
stale index (routinely past a 4-letter walk cycle) for `resolve` to index `animFrames` with, a real
crash. `advance` now clamps `animIndex` into range unconditionally at the top of that branch.

`game.ts: resolveVileBlast` is a dedicated path rather than reusing `resolveMonsterHitscan`, since
there's no trace to run — vanilla damages `actor->target` directly, not whatever a ray hits first.
Its splash reuses `applyRadiusDamage`, extended with an optional `source` (attributed to the vile,
so the "nothing retaliates against an arch-vile" rule covers it) and — spotted while wiring this up
— a missing vanilla rule that applies to *every* explosion: `PIT_RadiusAttack` exempts the spider
mastermind and cyberdemon from all concussion/splash damage, direct hits only.

**The windup flame** (`MT_FIRE`) is a real, persistent object in vanilla that appears the instant
the windup *starts* (`A_VileTarget`) and tracks 24 units in front of the target for its whole
duration. Not cosmetic: without a visible warning, "duck behind cover mid-windup" isn't a mechanic a
player can use. `beginRangedAttack` reports a fourth, purely-cosmetic `MonsterAttack` kind —
`'vileWindup'` — the instant a `blast` attack starts, separate from the `'ranged'` event
`resolveVileBlast` handles; `things.ts` also moves the vile's `attackFrames` pose to trigger on
`'vileWindup'` rather than at the blast landing, matching vanilla's timing (`S_VILE_ATK1`-`ATK10`
play across the entire missilestate chain).

`game.ts: spawnVileWindupFire` reuses the ordinary one-shot `spawnEffect`/`impacts` machinery with
two differences: its `lifetime` is overridden to `VILE_WINDUP_TRACK_SECONDS` (read from
`MONSTER_STATS` rather than duplicated) instead of one pass through its frames, and `OneShotEffect`
gained `followTargetId`/`vileSourceId` — `updateEffects` re-derives `x`/`y`/`z` every frame from
`vileFireFrontOf(target)` (vanilla's `dest->x + 24*cos(dest->angle)` etc., keyed off the *target's*
own `MonsterRef.angle`/`Player.angle`), but only while `World.hasLineOfSight(vile, target)` holds —
matching `A_Fire`'s own `P_CheckSight` gate including its failure behavior: the flame freezes where
it last was rather than disappearing or continuing to chase, since `A_Fire` just returns early.

An earlier version froze a single offset vector *toward the vile* at spawn and re-applied it to the
target's live position — the wrong formula (vanilla's windup offset is based on the *target's*
facing, not the vile's position) and missing the sight gate, so the flame slid around behind a
moving player instead of staying in front of whichever way they were looking. `vileFireOffset` (the
*different*, vile-facing-based formula `A_VileAttack` uses for its one-time final reposition once
the shot lands) is untouched — vanilla genuinely uses two different offsets for the two moments.

No hand-off is needed between the windup flame and `resolveVileBlast`'s burst effect (or nothing, if
the shot fizzles): both are timed off the same `startDelaySeconds`.

## Pain, and attack/pain poses

**`painChance` is `mobjinfo.painchance` over 256 exactly, and `painDuration` its `painstate` chain's
tics over 35.** Both are plain constants in the same table `MONSTER_HEALTH` already lifts from. An
earlier eyeballed set had the imp and demon shrugging off roughly half the hits that stagger them in
vanilla, and flattened pain length to one shared value where vanilla ranges from 4 tics (imp, demon,
baron barely flinch) to 12 (cacodemon, pain elemental recoil visibly). A stagger also *aborts*
whatever attack was under way, including the unfired shots of a volley, matching vanilla's pain state
replacing the attack state outright.

**The walk cycle is the one frame table that is *not* per-type.** `things.ts`'s
`MONSTER_WALK_FRAMES` is a flat `A`-`D`, DOOM's own RUN-state convention and the same one `PLAY`
uses. Unlike the tables below it isn't rederived per monster: `info.c` puts the walk cycle first for
every type uniformly, so there is no per-type structural signal to check it against the way the
rotation-0-only death tail gives death frames. A few real monsters deviate in vanilla — the lost soul
cycles only `A`-`B`, the spider mastermind and arachnotron cycle further before repeating — left as a
known, accepted gap.

**Attack and pain each get a real, dedicated pose** (`thingdefs.ts`'s `MONSTER_ATTACK_FRAMES`/
`MONSTER_PAIN_FRAMES`). The blocker an earlier walk-cycle stand-in was working around was real:
unlike death frames, which are derivable straight from the WAD because death art is structurally the
rotation-0-only tail of a sprite's frame set, attack and pain frames are ordinary rotation 1-8 frames
indistinguishable from walk frames by structure alone. The fix was to stop deriving them from the
WAD and instead take vanilla's `info.c` `missilestate`/`painstate` chains and convert each state's
frame number to a letter — then verify every letter for every monster (walk + attack + pain + death
[+ xdeath]) against the real `SpriteBank`-indexed lumps, checking each sprite's *total* letter count
against its WAD-confirmed rotation-1 range. All 18 sprites (17 monsters + `PLAY`) matched exactly.

That cross-check caught **four pre-existing bugs** the WAD-derivation method had gotten wrong: the
lost soul, revenant and arch-vile's death tables were each missing their actual first frame
(`SKULF0`, and for the revenant/arch-vile a directional `SKELL1`-`8`/`VILEQ1`-`8` reused from their
own pain state — a genuine `info.c` quirk, exactly what a pure "eyeball the lump names" derivation
misses), and the chaingunner's death/xdeath split fell two letters too early, dropping `CPOSM0`/
`CPOSN0` and duplicating them into the gib tail.

Both tables play through `SpriteAnimator.playOnce`, not `die`: a third animation mode alongside the
permanent one-shot-then-hold `die` and the looping alive cycle, playing its frames forward once and
handing back to the walk cycle on its own — which is what makes it reusable for both attack and pain
(each a transient interruption, not a permanent state change). A later `playOnce` (a pain flinch
landing mid-attack pose) simply replaces whatever was playing, matching vanilla's state machine,
which has no queueing either.

`ThingLayer.update` triggers the attack pose where it already detects `stepMonsterAI` returning a
fired attack, and the pain pose inside `damage()` right after `reactToDamage` — gated on
`p.painTimer > 0` rather than every non-lethal hit, since `reactToDamage` only sets it when the hit
rolls past the monster's `painChance` (a failed roll still alerts and retargets, just doesn't
stagger). The player's own letters (`game.ts`'s `PLAYER_ATTACK_FRAMES`/`PLAYER_PAIN_FRAMES`, derived
and WAD-checked the same way) trigger analogously: attack whenever `WeaponSystem.update` returns a
nonempty `Shot[]`, pain inside `damagePlayer` whenever the player survives a hit.
