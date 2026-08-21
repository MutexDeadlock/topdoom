# The arch-vile

`src/game/monsters/vile.ts`, plus its rows in `src/game/monsters/tables.ts` and its two branches in
`src/game/monsters/ai.ts`

The one monster type that does not fit the data-driven `MONSTER_STATS` model docs/monster-ai.md
describes — a sibling of docs/monster-iconofsin.md in that respect. Realizing the blast itself is
docs/monster-attacks.md.

`src/game/monsters/vile.ts` — the one type with enough of its own behavior to warrant a file. It
holds `tryRaiseCorpse` (called from `runChaseCall`), `resolveVileBlast`/`spawnWindupFire`/
`vileFlameFor` (called from `MonsterAttacks`), and the vile's constants. Two exceptions stay out of
it and say so at the declaration: the fire-time sight recheck and the `'vileWindup'` return remain
one-line branches in `ai.ts`, and `VILE_KNOCKUP_SPEED` lives in `defs.ts` because `MONSTER_STATS`
reads it (docs/monster-attacks.md § Resolving an attack).

Both signature mechanics are modeled, confirmed against `p_enemy.c`/`info.c`.

## Resurrection

`A_VileChase`/`PIT_VileCheck` is `MonsterStats.resurrects`, set only for the
arch-vile: on every chase call where it has a `movedir`, it checks one chase-call's travel ahead
(vanilla's `viletryx`/`viletryy`) for a raisable corpse — `MF_CORPSE`, not still mid-death-animation
(vanilla's `tics != -1`; here `deadTime` against `deathFrameCount * MONSTER_DEATH_FRAME_SECONDS`),
within `corpse.radius + vile.radius` (vanilla's box test, not a circle), and with room to stand back
up (`positionBlocked` against the corpse's footprint) — and raises it *instead of* taking its ordinary
chase-call turn at all, matching vanilla exactly: a tic that resurrects skips the reactiontime/
threshold aging and the melee/missile/walk decision entirely.

`things/tables.ts: MONSTER_RAISE_FRAMES` is vanilla's `raisestate` table for the 14 types that have one
(13 monsters plus the spectre, which carries its own copy of the demon's sequence)
(every boss, the lost soul, the arch-vile itself, Commander Keen and the boss brain don't). These
had to be pulled from `info.c` directly — reusing `MONSTER_DEATH_FRAMES` reversed was tried first
and is wrong, since vanilla's raise sequences are hand-authored per type and share no derivation
rule (the zombieman's 4 raise states reverse its death sequence's first four frames, the shotgun guy's
4 reverse its *entire* sequence including the settled final frame, despite both sprites sharing the
identical death letter range).

`ThingLayer.reviveCorpse` is the revival: full health back, immediately alerted and re-targeting the
player (`corpsehit->target = NULL`), held still (`attackPause`) for exactly as long as its raise
animation takes — reusing `SpriteActor.revive()` (undoes `die()`) plus `playOnce`, the same
one-shot-then-hand-back mechanism attack/pain poses use, just running dead-to-alive. The vile's own
`S_VILE_HEAL1-3` art is deliberately not reproduced: those states reference sprite frame indices
26-28, past `Z` (25), with no corresponding WAD lumps at all — a genuine vanilla quirk, not a
transcription slip — so the vile keeps its ordinary held pose during the hold.

Its one deliberate deviation is the HUD's kill total: a resurrection increments `stats.totalKills`,
following ZDoom's `AActor::Revive` rather than vanilla, which leaves both counters alone and so
reads over 100% kills once a vile has raised anything. docs/hud.md § Level stats has the rule and
why.

## The attack

`A_VileAttack` is `AttackStats.blast`: guaranteed un-rolled direct damage
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

`resolveVileBlast` is a dedicated path rather than reusing `resolveHitscan`, since
there's no trace to run — vanilla damages `actor->target` directly, not whatever a ray hits first.
Its splash reuses `applyRadiusDamage`, extended with an optional `source` (attributed to the vile,
so the "nothing retaliates against an arch-vile" rule covers it) and — spotted while wiring this up
— a missing vanilla rule that applies to *every* explosion: `PIT_RadiusAttack` exempts the spider
mastermind and cyberdemon from all concussion/splash damage, direct hits only.

## The windup flame

`MT_FIRE` is a real, persistent object in vanilla that appears the instant
the windup *starts* (`A_VileTarget`) and tracks 24 units in front of the target for its whole
duration. Not cosmetic: without a visible warning, "duck behind cover mid-windup" isn't a mechanic a
player can use. `beginRangedAttack` reports a fourth, purely-cosmetic `MonsterAttack` kind —
`'vileWindup'` — the instant a `blast` attack starts, separate from the `'ranged'` event
`resolveVileBlast` handles; `things.ts` also moves the vile's `attackFrames` pose to trigger on
`'vileWindup'` rather than at the blast landing, matching vanilla's timing (`S_VILE_ATK1`-`ATK10`
play across the entire missilestate chain).

The pose has to *last* the whole chain too, and originally didn't: at the flat 3-tics-a-frame rate
every pose used, `VILE` `G`-`P` was over 30 tics into a 94-tic cast, so the vile stood in its idle
frame for the back half of the windup — the half where the flame is the warning — and through the
blast. `MONSTER_ATTACK_POSE` is now spread over the attack's own duration for every type
(docs/sprites.md § Pain, and attack/pain poses), and a save taken mid-cast replays it fast-forwarded
(docs/savegames.md § What is saved and what is deliberately not) rather than loading a vile that
looks idle while it casts.

`spawnWindupFire` (`monsters/vile.ts`, called from `attacks.ts`) reuses `SpriteFxLayer`'s ordinary
one-shot `spawn`/`addImpact` machinery with
two differences: its `lifetime` is overridden to `VILE_WINDUP_TRACK_SECONDS` (read from
`MONSTER_STATS` rather than duplicated) instead of one pass through its frames, and `OneShotEffect`
gained `followTargetId`/`vileSourceId` — `SpriteFxLayer` re-derives `x`/`y`/`z` every frame from
`fireFrontOf(target)` (vanilla's `dest->x + 24*cos(dest->angle)` etc., keyed off the *target's*
own `MonsterRef.angle`/`Player.angle`), but only while `World.hasLineOfSight(vile, target)` holds —
matching `A_Fire`'s own `P_CheckSight` gate including its failure behavior: the flame freezes where
it last was rather than disappearing or continuing to chase, since `A_Fire` just returns early.

An earlier version froze a single offset vector *toward the vile* at spawn and re-applied it to the
target's live position — the wrong formula (vanilla's windup offset is based on the *target's*
facing, not the vile's position) and missing the sight gate, so the flame slid around behind a
moving player instead of staying in front of whichever way they were looking. `vileBlastOffset` (the
*different*, vile-facing-based formula `A_VileAttack` uses for its one-time final reposition once
the shot lands) is untouched — vanilla genuinely uses two different offsets for the two moments.

No hand-off is needed between the windup flame and `resolveVileBlast`'s burst effect (or nothing, if
the shot fizzles): both are timed off the same `startDelaySeconds`.
