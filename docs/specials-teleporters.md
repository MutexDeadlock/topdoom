# Specials: teleporters

`src/game/specials.ts`, `src/game/specials/defs.ts`, `src/game/spritefx.ts`,
`src/game/things.ts`, `src/game.ts`

Vanilla's four teleport numbers and Boom's fourteen: where a body lands, which way it faces
afterwards, and what the camera does about it. The telefrag an arrival deals is docs/death.md §
Telefrag; what dispatches the line is docs/specials.md.

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
doors; the door's own end of it is docs/specials-movers.md § Retriggering a door.

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
`OneShotEffect` playing `TELEPORT_FOG` once before removing itself — `MT_TFOG`'s spawn chain walked
out of vanilla's state table, `S_TFOG`'s `A,B,A,B` flicker and then `C`-`J`, 6 tics each
(docs/dehacked.md § Frames); rotation-0 lumps, so no facing logic is needed. Map
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
unspent, the same rule as every other gated switch (docs/specials.md § A switch only flips when it
acts).

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
