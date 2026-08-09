# Resolving a monster attack

`src/game/monsters/attacks.ts`, `src/game/monsters/defs.ts`, `src/game/projectiles.ts`,
`src/game/things.ts`

What happens *after* `stepMonsterAI` has decided to attack — which attacks are hitscan and which
throw a real missile, how each is realized against the world, and how a monster projectile flies.
The decision side is docs/monsters.md.

## Resolving an attack

`ThingLayer.update` reports a `MonsterAttackEvent` per attack fired this frame and applies none of
them. `MonsterAttacks.resolve` (`monsters/attacks.ts`) is what realizes them: melee lands
directly, a hitscan volley traces bolt by bolt (`resolveHitscan`/`resolveBullet`), a projectile
attack is handed to `ProjectileLayer.spawnMonsterShot`, and the arch-vile's blast takes its own
path through `monsters/vile.ts`. It also answers `SpriteFxLayer`'s `VileFlameResolver`, since where
the vile's flame belongs depends on live monster/player state the effect batch has no reason to
know — `vileFlameFor` stays a method on `MonsterAttacks` (delegating to `vile.ts`) because `game.ts`
hands that method straight to the effect layer.

**`monsters/attacks.ts` and `monsters/vile.ts` must reach their collaborators without a runtime
import cycle**, because both `things.ts` and `projectiles.ts` import `monsters/defs.ts` and
`monsters/ai.ts` for values. Four rules hold that open, and breaking any one of them reintroduces a
cycle:

- `ProjectileLayer` and `ThingLayer` are imported **`import type`** only. Both are used purely as
  parameter/field types, and `verbatimModuleSyntax` guarantees a type import is erased.
- `combat.ts` imports `things.ts` **`import type` only** — its `BARREL_SPLASH_RADIUS`/`_DAMAGE`
  live in `thingdefs.ts` (a leaf) precisely so that stays true. This is what lets `vile.ts`
  call `applyRadiusDamage` as a real value.
- `spritefxdefs.ts` imports **nothing** from the `monsters/` folder. `VILE_WINDUP_TRACK_SECONDS`,
  which is derived from `MONSTER_STATS`, lives in `monsters/vile.ts` for that reason rather than
  beside the other `VILE_FIRE_*` values.
- **`defs.ts` imports nothing from its three siblings.** That is what makes it the folder's leaf,
  and it is why `VILE_KNOCKUP_SPEED` sits in `defs.ts` rather than with the rest of the vile's
  constants: `MONSTER_STATS` reads it, and the table cannot depend on `vile.ts`.

`SpriteFxLayer.spawnWallPuff` is on the effect layer rather than in `projectiles.ts` for the same
reason — a monster's bolt needs it, and reaching into `projectiles.ts` for a value would cycle.

## Hitscan vs. projectile

Which one a type uses matches vanilla (`AttackStats.ranged.projectile`, `game/projectiles.ts`'s
`spawnMonsterShot`, plus `PROJECTILE_FRAMES`/`IMPACT_EFFECTS`). The human gunners (zombieman,
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

**Every monster bullet is thrown off-aim by `MONSTER_BULLET_SPREAD_DEG` — the single most
load-bearing number in how dangerous the gunners are.** `A_PosAttack`, `A_SPosAttack` and
`A_CPosAttack` each add `(P_Random()-P_Random())<<20` BAM to the firing angle, ±255/4096 of a full
turn (±22.4°), triangular. It is *not* an accuracy nicety: it is the only thing that makes range
matter against a hitscanner, and against the 32-unit player box it costs vanilla's gunners roughly
65% of their shots at 128 units, 80% at 512 and 90% at 1024. Shipping without it — which this
engine did — made every monster bullet a guaranteed hit at any distance, so a spider mastermind
(`pellets: 3` × `shots: 2` per 9 tics) dealt ~210 dmg/s where vanilla deals ~32 at 512 units. The
top-down camera makes this worse than it would be in vanilla, not better: it opens fights at ranges
where vanilla's gunners are missing four shots in five.

**A monster's hitscan bolt tests against the player's radius plus `MONSTER_BULLET_SLOP` (4).**
Vanilla resolves it against the player's 32-unit-wide *axis-aligned box*, which a bullet from an
arbitrary bearing sees as `perimeter/π ≈ 40.7` units wide on average rather than 32 — a circle of
radius 20 presents the same average target. The tolerance covers that box-vs-circle difference and
nothing else; simulated against vanilla's own integer draw it lands within 1.5% of vanilla's hit
rate from 64 to 1536 units. (It used to be 12, covering a stale firing angle. The angle isn't
stale — `A_FaceTarget` re-runs on every burst shot, so it is at most one frame old — and the
spread now dwarfs a frame's worth of error anyway.)

**Flight speed is that missile type's own `mobjinfo.speed`.** For a missile that field is plain
fracunits *per tic*, so the conversion is `× 35`: imp/cacodemon 350, baron/hell knight 525, mancubus
700, arachnotron 875, revenant's `MT_TRACER` 350, cyberdemon's `MT_ROCKET` 700, lost soul's
`SKULLSPEED` 700. Having these eyeballed was a shipped bug across the whole table, worst on the
revenant: 750 against vanilla's 350, i.e. **faster than the player's own 500-unit/sec run**. A
missile faster than the thing it's chasing cannot be evaded at all, which took away both halves of
what a revenant missile is — a shot you *can* outpace, which then curves back and keeps coming.

(The player's own `weapons.ts: WeaponDef.projectileSpeed` values take the same `mobjinfo.speed × 35`
conversion — rocket 700, plasma 875, BFG 875. They were hand-picked once, which had the player's
rocket flying at 1000 while the cyberdemon's identical `MT_ROCKET`, already converted here, flew at
700.)

**Direct-hit damage is one universal formula** (`PIT_CheckThing`): `(rand%8+1) × that missile type's
own `mobjinfo.damage``. So `diceSides` is `8` for every projectile monster and only `diceMult`
varies — imp 3, cacodemon 5, baron/hell knight 8, mancubus 8, arachnotron 5, revenant 10, cyberdemon
20. The lost soul's `MF_SKULLFLY` contact damage (`AttackStats.charge`) is the same formula through
the same code path with `MT_SKULL`'s own damage field (3). Melee dice are each monster's own
`A_*Attack` roll instead: `A_TroopAttack` `(rand%8+1)*3`, `A_SargAttack` `(rand%10+1)*4`,
`A_HeadAttack` `(rand%6+1)*10`, `A_BruisAttack` `(rand%8+1)*10`, `A_SkelFist` `(rand%10+1)*6`. An
earlier version of this table had every monster's dice tuned softer.

**Two monsters fire more than one pellet per call**: the shotgun guy's `A_SPosAttack` fires three
`(rand%5+1)*3` pellets, and the spider mastermind fires the same function twice (`pellets: 3` on top
of `shots: 2`). Each pellet is a genuinely separate traced bolt (`MonsterAttack.bullets` carries one
damage roll per bullet, and `MonsterAttacks.resolveHitscan` gives each its own spread draw), so a
burst lands partially. Summing them into one roll on one ray — which this engine used to do — is
only equivalent while there is no spread, and with spread it is wrong in a way worse than the
average suggests: it turns a shotgun blast into all-or-nothing 27 damage.

All the pellets of one call do share a single **slope**, computed once from the aim before the
volley, matching `A_SPosAttack`'s own `slope = P_AimLineAttack(...)` sitting above its loop. The
same goes for the partial-invisibility fuzz (`applyShadowAim`): vanilla fuzzes `actor->angle` inside
`A_FaceTarget`, so `bangle` is already fuzzed and every pellet spreads off that one fuzzed aim.

Each bolt is traced out to the full `WEAPON_RANGE` (`shotPath`'s `range` parameter, separate from
the target it takes its slope from — docs/combat.md § shotPath), not merely to the target, so a
bullet the spread throws wide keeps going: it can still hit a wall or another monster *behind*
whoever it was fired at, exactly as `P_LineAttack(..., MISSILERANGE, ...)` does. This is also why
stray-bullet infighting picked up noticeably — before spread, no monster bullet ever missed.

**Only the cyberdemon's rocket splashes**, confirmed by checking every monster fireball's own death
state in `info.c` rather than assumed either way. `A_CyberAttack` spawns a real `MT_ROCKET`, whose
death state `S_EXPLODE1` is the one monster-projectile death state in the game that calls
`A_Explode`; every other fireball's death state has no action, so none of them ever call
`P_RadiusAttack`. `AttackStats.projectile.splash` (`{radius: 128, damage: 128}`, vanilla's literal
`P_RadiusAttack(thingy, thingy->target, 128)`, identical to the player's own rocket) is set only
there. The splash still can't hurt the cyberdemon or spider mastermind, per `applyRadiusDamage`'s
existing exemption.

## The revenant's homing missile

`AttackStats.projectile.homing`, `game/projectiles.ts`'s `advanceHoming` — vanilla's `A_Tracer`, the
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

`advanceHoming` turns the heading toward the target's *current* bearing by at most
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
`advanceHoming` checks each frame's step against the geometry that step really crossed
(`world.ts: projectileStepBlocker`, the per-step counterpart to `shotPath`'s launch-time trace,
reusing the identical `blocksShot` predicate at the height the step is at) and stops there, updating
`Projectile.lineIndex` so a shoot-triggered special still fires on the right line. No safety cap
stands behind that: every real map is enclosed, and capping it would reintroduce the mid-air
detonation this removes.

`P_ZMovement`'s floor/ceiling hit is **not** decided here — it is `ProjectileLayer.update`'s
`hitGround`, applied uniformly to every monster missile (see below). A homing one needs it most: its
height *eases* toward a target that can sit on a very different floor while its `x`/`y` curves over
terrain `shotPath` never re-checked, so easing toward a lower target while passing over higher ground
would sink the sprite into that floor. It used to be decided twice, once here and once there, and the
copies disagreed on whether the far wall's shoot special still fires — it must not, since a missile
stopped by the floor never reached that wall. Since this branch never accumulates `traveled` itself,
`hitGround` and the wall check are the only things that end a homing flight short of a body.

**A guided missile trails smoke; an unguided one doesn't** — the wiki's "the homing missiles can be
distinguished by a gray smoke trail" is the entire visible tell, and gating it on
`Projectile.homing` falls out for free. `advanceHoming` spawns vanilla's `MT_SMOKE` (which
reuses the plain bullet-puff sprite `PUFF`, frames `B,C,B,C,D` per `S_SMOKE1`-`5`) every
`SMOKE_TRAIL_INTERVAL`, the same 4-tic cadence `A_Tracer` gates the turn with. Vanilla also spawns a
second, redundant `MT_PUFF` one step further behind at the same moment — cosmetically near-identical
smoke from the same sprite, so reproducing only one loses nothing.

## Monster projectiles in flight

A monster projectile reuses the same `Projectile`/`ProjectileLayer.update` machinery the player's own
rocket/plasma/BFG shots use, distinguished by a non-null `sourceId` (with the doomednum along as
`sourceType` for the species check). Arrival is re-checked every frame against the player's *live*
position (`playerStruckBy`) and every other living body it might clip (`bodyStruckBy`,
`sameSpecies`-gated), so stepping behind cover or outrunning a slower fireball actually works. Both
run over `spritefxdefs.ts`'s `stepTouchesBody`, and **the player's own missiles now take the identical
path** — docs/combat.md § How a projectile finds its target covers the shared contact rule, the
per-missile `PROJECTILE_RADIUS` and why the step is swept rather than sampled.

**What `sourceId` still decides is only what a hit *means***, not whether it happens: who the damage
is attributed to for infighting, whether `sameSpecies` can fizzle the shot, and whether the player is
a candidate at all. Two other rules stay monster-only for their own reasons — `hitGround` below, and
`triggerShot`'s `byMonster` flag.

**The player's hit box is vanilla's, not a generous stand-in.** Contact is the player's own 16-unit
box plus the missile's radius (22 units for the imp/cacodemon/baron/mancubus fireballs, 27 for a
rocket or revenant missile, 29 for arachnotron plasma) as the equal-mean-width circle — about 28
units for an imp fireball. It used to be a flat 40-unit disc plus a ±128 height tolerance borrowed
from `tryPickup`'s window check, i.e. **twice the cross-section** and a band tall enough that a
fireball passing 100 units over the player's head still hit them. That is what "monster projectiles
collide too loosely" was: fireballs detonating a body-width away and reading as hits you dodged.

**The target sets the missile's slope and nothing else; the flight ends at a wall.** `P_SpawnMissile`
fixes `momx`/`momy`/`momz` at launch — from `(dest->z - source->z)` over the launch distance — and
the thing then flies on under its own momentum until `P_XYMovement`, `P_ZMovement` or
`PIT_CheckThing` stops it. So `spawnMonsterShot` passes the target to `shotPath` for the slope and
`World.mapSpan` for the distance — the two are separate parameters precisely so this can be said
(see docs/combat.md § shotPath). **A missile has no range budget**: `MISSILERANGE` is
`P_LineAttack`'s bound on a bullet, and lending it to missiles too made them burst in mid-air 2048
units out, which is what NUTS.WAD's arachnotrons showed. Letting the target set both, as this engine
earlier did, made `maxDist` the
launch-time distance to the player, so **every missile burst exactly where the player had been
standing when it was fired**, whether or not they were still there. With a cyberdemon's
`{radius: 128, damage: 128}` splash that is a rocket you cannot dodge — it reads as homing, and as
rockets going off in empty floor space, which is precisely what it was doing. Only the revenant's
`MT_TRACER` actually homes (`AttackStats.projectile.homing`, `advanceHoming`).

**The player's own missiles follow the same rule now**, for the same reason and out of the same
`P_SpawnMissile` reading: `spawnPlayerShot` sets `maxDist` from `shotPath`'s wall, never from the
locked-on target's distance. Ending a rocket or a BFG ball at where a monster stood at launch is what
had them bursting in empty air a body-length short of a monster that had walked on.

Because the slope now outlives the aim that set it, a monster missile also explodes on meeting the
floor or ceiling (`ProjectileLayer.update`'s `hitGround`, vanilla's `P_ZMovement`), which is how a
cyberdemon firing down from a ledge and missing puts its rocket into the ground instead of burrowing
through it. One stopped that way triggers no shoot special — it never reached the wall whose
`lineIndex` it carries. The test is one `World.sectorAt` per projectile per frame, shared with the
sprite's light lookup, and covers homing missiles too rather than leaving them a second copy.

The mancubus's fanned pair shares one slope for the volley — `target` is loop-invariant — and
deflects only the heading, since `A_FatAttack1/2/3` rewrite `momx`/`momy` from the new angle after
`P_SpawnMissile` and leave `momz` alone.

**Both live arrival tests are gated on `hasLineOfSight`, and that gate is load-bearing.** Contact
still reaches tens of units past the missile's own centre, and a projectile's flight *ends* at
whatever wall `shotPath` found — so on the last frames before it bursts, anyone within contact range
on the **far** side of that wall took a full direct hit through it. The trace runs **from the
player/monster toward the projectile**, not the other way round: by then the impact point sits
essentially *on* the wall, and `hasLineOfSight`'s own `SELF_HIT_MARGIN` would discard that crossing
as a self-hit and report the wall it just stopped against as clear. Both checks sit **last** in
their condition chains, so they only run for a candidate the cheap proximity tests already accepted.

