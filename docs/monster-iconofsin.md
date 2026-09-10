# The Icon of Sin

`src/game/monsters/iconofsin.ts`, `src/game/things/tables.ts`, `src/game/things.ts`,
`src/game/specials.ts`

MAP30's boss: the spitter that launches spawn cubes, the cubes themselves, and the brain's death.
Separate from docs/monster-ai.md because none of it goes through `MONSTER_STATS` or `stepMonsterAI`
— the eye, the targets and the brain are all inert `MONSTER_TYPES` entries that `IconOfSin` drives
itself.

Three doomednums drive it. **Nothing about it is gated on the map's name** — vanilla's only gate is
that the things exist, so a PWAD placing them gets identical behavior and every other map builds an
inert `IconOfSin` whose `update` returns immediately.

- **88, `MT_BOSSBRAIN`** — the shootable brain, an ordinary `PosedThing` handled by the
  `INERT_SHOOTABLE` path above (250 health, `bospn`/`bosdth`, both **unattenuated**: its
  `A_BrainPain`/`A_BrainScream` call `S_StartSound(NULL, …)`, so it is heard from anywhere on the
  map). It is the one `MONSTER_TYPES` member deliberately *not* in `COUNTKILL_TYPES`, matching
  `info.c`. Its "death frames" are the single held `BBRN A`: `S_BRAIN_DIE1`-`4` never change frame,
  they just burn 120 tics while the cascade runs.
- **89, `MT_BOSSSPIT`** — the invisible eye that does the spitting.
- **87, `MT_BOSSTARGET`** — the spawn spots cubes fly to.

87 and 89 are `MF_NOBLOCKMAP|MF_NOSECTOR` with no sprite, so both stay out of `THING_SPRITES` and
are read straight off `map.things`, the same way `SpecialsController.findTeleportDestination` reads
teleport landings.

The sequence, all timings off `info.c`'s `states[]`: the eye wakes (`eyeNotices`, below), collects
every type-87 thing into `braintargets` in map order and shouts `bossit`. 181 tics later it spits
its first cube, then one every 150 tics, cycling `braintargeton` round-robin through the spots.
`A_BrainSpit`'s `easy` toggle is reproduced: on skills 1-2 (vanilla's `sk_baby`/`sk_easy`) every
other spit is skipped, halving the rate.

## Waking the eye

`eyeNotices` stands in for idle `A_Look`, since an `MF_NOSECTOR` thing with no `PosedThing` has
nothing for `tryWake` to run on. Both of `A_Look`'s paths are reproduced: its sector's sound target
(`World.soundTargetOf`, while the player who made the noise lives — checked first because it is a
Map lookup) and line of sight. No FOV cone,
though vanilla's `A_Look` passes `allaround == false` — gating the whole boss on the facing angle a
mapper happened to give a thing that draws nothing is not worth reproducing.

**The sight origin must be `MT_BOSSSPIT`'s own, not a player-shaped one.** `hasLineOfSight` lifts
whatever `z` it is handed by `player.ts`'s `SIGHT_EYE_HEIGHT`, which is the right approximation
everywhere else in the game. The eye is 32 tall standing on a floor at 384 under a ceiling at 416,
so that lift sights it from 426 — *above its own ceiling*, with the wedge out of the slot pinched
shut against almost the whole arena. `SHOOTER_SIGHT_Z` (`height - (height >> 2)`, `P_CheckSight`'s
own `sightzstart`) minus that lift cancels it back out and puts the origin at 408, inside the slot.

The difference is the entire boss fight, measured on MAP30: from 426 the eye sees only the northern
half of the pit, so it woke on sound or on a player riding a lift up to slot height. From 408 it
sees the map's one teleport landing (2880, 352) and 12 of the 13 spawn spots, i.e. it wakes the
moment the player arrives, which is what vanilla does.

## The spawn cube

`MT_SPAWNSHOT` flies at 350 units/sec (`mobjinfo.speed` of 10 per tic) and is
`MF_NOBLOCKMAP|MF_NOCLIP|MF_NOGRAVITY` — it passes through all geometry and collides with nothing.
That is exactly why it is **not** a `ProjectileLayer` projectile: that layer exists to resolve
wall-blocked flight and damage, and a cube does neither. It is a local record in
`monsters/iconofsin.ts` with its own `SpriteAnimator`, drawn through `SpriteFxLayer.batchSprite` the
same way `ProjectileLayer.update` draws a missile, at full light — its `BOSF` frames carry vanilla's
fullbright bit, which `FULLBRIGHT_FRAMES` applies (docs/sprites.md § Fullbright frames). `boscub`
replays once per four-frame cycle, since `A_SpawnSound` sits on the looping `S_SPAWN1` alone.

One divergence: vanilla decides arrival by a launch-time tic countdown computed from the **y** delta
only (`(targ->y - mo->y) / momy / state tics`), a quirk that happens to work on MAP30's layout.
Flying to the target point and arriving when the distance runs out is equivalent there and robust
anywhere else.

On arrival, `A_SpawnFly` spawns the `MT_SPAWNFIRE` puff (`FIRE A`-`H`), plays `telept`, and rolls
one `P_Random()` against `things/tables.ts`'s `SPAWN_CUBE_MONSTERS` — eleven ordered upper bounds
summing to exactly 256, transcribed from `p_enemy.c`'s if/else chain. The weights are deliberately
lopsided (an imp is 50/256, an arch-vile 2/256) and stay that way. `ThingLayer.spawnMonster` creates
the monster already alerted and **telefrags** whatever was standing there, so a spawn spot is lethal
to stand on — docs/death.md § Telefrag. The stomp is passed unconditionally rather than gated on
`PIT_StompThing`'s "monsters only stomp on MAP30" rule: the cube only ever flies on that one map.

A cube-spawned monster increments `stats.kills` when killed but never `stats.totalKills`, which is
fixed at load by the map-thing loop. **Kills can exceed 100% on MAP30**; that is vanilla, whose
`totalkills` comes from `P_SpawnMapThing` alone, and the same quirk arch-vile resurrections already
produce.

## Dying

`A_BrainScream` fires on the brain's death: `bosdth` unattenuated, plus a row of explosions from
`x-196` to `x+320` in steps of 8 at `y-320`, each at `128 + rnd*2` above the floor, drawn as the
rocket's own `MISL B`-`D` at 10 tics a frame. `A_BrainExplode`'s follow-up bursts (±510 random x)
re-fire on a timer until the exit lands — vanilla's chain is genuinely unbounded and only stops
because the level ends underneath it, so bounding it on the same timer is how that is reproduced
without an ever-growing effect list. 120 tics after death `A_BrainDie` calls `G_ExitLevel`, which
reaches the same `onExit` callback every other exit in the engine uses.

