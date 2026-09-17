# Specials: scrollers, friction, pushers and voodoo dolls

`src/game/specials/forces.ts`, `src/game/specials/voodoo.ts`, `src/game/specials/tables.ts`

Boom's **parameter lines** that change how things *move*: numbers read once at level spawn to give
a surface or a sector a permanent property, never dispatched from a trigger. `lookupSpecial` returns
`null` for every one of them (they are listed in `PARAM_LINE_SPECIALS` so the coverage report can
tell "handled elsewhere" from "unknown" — docs/specials.md § Scope), and `specials/forces.ts:
Forces` owns them instead, scanned once from the map in its constructor and ticked with the
simulation. The ones that change how a sector is *drawn* are docs/specials-transfers.md.

## Scrollers and conveyors

`P_SpawnScrollers` reads the control line's **own vector, divided by 32** (`SCROLL_SHIFT` 5) as the
rate in map units per tic, so a longer line scrolls faster and its direction is the scroll
direction. Vanilla 48 and Boom 85 are the exceptions: a fixed ±1 unit/tic, which is where the
engine's long-standing 35 units/sec comes from.

| # | Effect |
|---|---|
| 48 / 85 | scroll the line's own front sidedef left / right, 1 unit/tic |
| 250 / 251 | scroll a tagged sector's ceiling / floor flat |
| 252 | carry things standing on a tagged sector's floor |
| 253 | 251 and 252 at once |
| 254 | scroll the *tagged lines'* walls, each in its own frame |
| 255 | scroll by the trigger line's own authored sidedef offsets |
| 245-249 | 250-254, driven by the front sidedef's sector height changes (**displacement**) |
| 214-218 | 250-254, the same but **accelerative** |

245-249 and 214-218 are remapped onto 250-254 up front, exactly as Boom does, so only one set of
cases is written out. A displacement scroller's rate is its authored rate times the change in its
control sector's `floorHeight + ceilHeight` since last tic; an accelerative one *accumulates* that
into `vdx`/`vdy` and keeps scrolling at the built-up rate after the control sector stops. **Those
integrators are the one piece of `Forces` a savegame carries** (`Forces.snapshot`/`restore`): an
accelerative conveyor still running with its control sector at rest is simulation state, not
presentation, so a restore that dropped it would stop the belt. Everything else here re-derives
itself from the map — docs/savegames.md § What is saved and what is deliberately not.

**The carry rate is not the scroll rate.** `CARRYFACTOR` is 3/32, "so scrolling floors and objects
on them can move at same speed" — and 253 applies it only to the conveyor half, after the flat half
took the *negated* vector. The sign flip is the flat's own texture axis, not a direction change:
vanilla stores `-dx` in `floor_xoffs` precisely so the pattern appears to move along `+dx`, the way
the conveyor does.

**Two clocks, deliberately.** `Forces.tick` runs once per simulation tic — `T_Scroll` is a thinker,
and acceleration is defined per tic — and resolves each scroller's current rate plus this tic's
conveyor impulses. `Forces.advanceOffsets` integrates the *visual* offsets on the frame clock from
that rate, so a scrolling waterfall stays as smooth as the rest of the presentation layer instead of
stepping at 35 Hz. Only the offsets are frame-paced; nothing the simulation reads is.

**A carried thing still triggers lines.** `P_CrossSpecialLine` fires for every non-player mobj that
moves — it excludes only the six projectile types, and its "monster only" numbers mean *not the
player* rather than *monsters only* — so a barrel or a decoration a belt pushes over a teleporter
teleports. Nothing but a conveyor ever moves a decoration in vanilla, which is why that only shows
up here: BOOMEDIT's 252/253 and 216/217 belts each run an evil eye into a **267** line-to-line
teleporter that loops it back to the start, and without this the eye rides off the end and is gone
(`tests/game/conveyor-carries-over-teleporter.test.ts`). Momentum survives the trip the way
the arrival says it should — a loud `P_Teleport` zeroes it, a silent one rotates it — so the cargo
comes out of the far end still moving.

Corpses ride belts too, a player's included (`game.ts: moveBody`, docs/death.md § Player death) —
`P_KillMobj` strips `MF_NOGRAVITY`, so `sc_carry`'s gate admits them. That
is what finally made a dead thing's velocity load-bearing here: before conveyors nothing could move
one, so it sat as inert unread data (docs/movement.md § Knockback).

The gate is "standing on the belt's floor" — with one exception, `sc_carry`'s own "Underwater, carry
things even w/o gravity": in a 242 sector anything **below the water surface** rides the belt
whether or not its feet are down (docs/specials-transfers.md § Deep water).

A `side` scroller's affectee is always `*l->sidenum`, the **front** sidedef, for every one of these
numbers — which is why `Forces` records the linedef index and the renderer's existing
`WallOccluder.frontSide` index is enough to find its quads. How the offsets reach the geometry is
docs/render.md § Scrolling textures.

## Voodoo dolls

A map's **extra player-1 starts** are voodoo dolls: vanilla spawns a player mobj for every
doomednum-1 thing and puts the console player in the last one (docs/wad.md § Player start), so the
rest stand around being player bodies nobody controls. Push one onto a conveyor and it walks lines
on the player's behalf; drop a crusher on it and the player dies. That is the whole of Boom-era
mapper scripting, and it is why conveyors and dolls landed in the same phase.

`specials/voodoo.ts: VoodooDolls` owns them. A deathmatch has none — vanilla spawns a start's body
only `if (!deathmatch)` (docs/multiplayer-deathmatch.md § Rules). Each tic a doll takes the same conveyor and pusher impulses
the player does, slides with `slideMove` (it is a player mobj, so it gets `P_SlideMove`), rides
whatever floor it is standing on, and decays its momentum by that floor's friction. It has no
gravity, no input and no AI — the world is the only thing that moves it. A doll a belt pins against
a wall — the resting state of most dolls on a script map — skips that whole re-derivation via the
pinned-body memo (docs/movement.md § Pinned-body memo), which is what keeps a 466-doll map ticking.

**What a doll picks up, the player gets.** `MT_PLAYER` carries `MF_PICKUP` (`info.c`), so
`PIT_CheckThing` hands anything a moving doll's box touches to `P_TouchSpecialThing`, which credits
`toucher->player` — and every doll's is the console player. A doll run over an item collects it, and
only while it is moving: vanilla reaches the pickup through `P_XYMovement`, which a parked doll
never enters. See docs/items.md § Collecting things.

**Triggering** goes through `SpecialsController.crossVoodoo`, the third `Activator`. A doll gates
exactly like the player it copies — the player's own keys, every line a player may cross, and it is
never a monster for a monster-only number — with two differences:

- a teleport's landing spot is **returned to the caller** to move the doll, the way a monster's is,
  rather than going through `onTeleport` and moving the player;
- it raises **no HUD feedback**: a doll shoved into a locked door must not print "you need the blue
  key".

**Crush damage mirrors onto the real player**, since `P_DamageMobj` on a doll is damage to
player 1: a crusher catching a doll deals `CRUSH_DAMAGE` to the player, once per doll caught
(`applyCrushDamage`).

**A damage floor does not.** `P_PlayerInSpecialSector` reads `player->mo` and is called from
`P_PlayerThink` alone (`p_user.c`: `if (player->mo->subsector->sector->special)`), so it only ever
runs for the body the console player occupies — the last start, never a doll. Sunder 2512's MAP20
is the repro: it parks a doll in a slime sector at (-5072, -1568), which under an earlier
per-doll damage pass bled the player 10 HP a pulse from the moment the level loaded. Secrets are
player-only for the same reason, and so is the `exitBelowHealth` floor.

Two deliberate deviations, both documented at their declarations. **Dolls are not drawn** — vanilla
renders them as marines, which in a top-down view reads as a second player standing across the map.
And **dolls do not obstruct movers**: vanilla's `PIT_ChangeSector` would let one stall a rising
floor, but a doll is parked exactly where a script needs it and is often meant to be crushed there,
so jamming the level's own machinery is the worse failure. Crush *damage* still reaches it.

## Friction

Linedef **223** sets its tagged sectors' friction — ice or mud — and the dial is again the control
line's own length: longer is more slippery. Two curves out of `P_SpawnFriction`, meeting at
vanilla's own 0.90625:

```
friction   = (0x1EB8 × length) / 0x80 + 0xD000
movefactor = friction > ORIG_FRICTION ? ((0x10092 − friction) × 0x70) / 0x158    // ice
                                      : ((friction − 0xDB34) × 0xA) / 0x80       // mud
```

Note the sign, which the C's own comment flags as counter-intuitive: a *higher* `friction` value
means *less* friction, because it is the multiplier momentum survives each tic.

**Thinkerless**, following PrBoom rather than boom202: Boom's original spawned a thinker that
re-stamped every mobj in the sector every tic, and killough replaced it with two plain per-sector
arrays filled once at load ("friction should be a property of sectors, not objects which reside
inside them"). `Forces` holds those two arrays; nothing about friction is ticked.

A sector's friction applies only while its special still carries the friction bit (0x100) —
`decodeSectorType(...).friction`, the same re-check `P_GetFriction` makes. Which sector wins for a
body touching several is vanilla's rule transcribed rather than a plain minimum: the first
qualifying sector is taken while nothing is picked yet, and after that only a strictly lower
friction displaces it ("muddy has precedence over icy"). A body only qualifies for a sector whose
floor it is standing at or below.

**Deviation:** MBF's clamps (`friction` into [0, 1], `movefactor` at least 32) are applied
unconditionally, where PrBoom gates them on `mbf_features` and so skips them at the Boom complevel
this engine targets. Unclamped, a 223 line longer than about 200 units produces a friction of 1 or
more — momentum in that sector would never decay, or would grow without bound. That is an engine
hazard rather than a behavior any map can be built on. `friction` pinned at exactly 1 is still a
degenerate input to the movement mapping, which bounds it again by `P_XYMovement`'s `MAXMOVE` —
docs/movement.md § Friction.

How the two numbers reach the player's actual movement — and why an engine whose input model isn't
vanilla's needs a mapping at all — is docs/movement.md § Friction.

## Pushers

Three more parameter lines, all in `specials/forces.ts` beside the scrollers, all reading their
strength from the **control line's length**: **224** wind, **225** current, **226** a point source.
Each applies to every tagged sector — but only for as long as that sector's own special still has
Boom's push bit (0x200) set, which `T_Pusher` re-checks every tic because a switch can rewrite a
sector's special out from under a live pusher.

Wind and current are constant over their sector and differ only in what being off the floor does:

| | in the air | on the floor |
|---|---|---|
| wind (224) | full force | half force |
| current (225) | nothing | full force |

In a **242 sector the water surface stands in for the floor** (docs/specials-transfers.md § Deep
water): a current runs on anything under the surface rather than only on the pool floor, and wind
gives full force above it, half while wading, and nothing at all once the eye is under —
`T_Pusher`'s own special-water branch, and the one place a render transfer reaches movement.

A **point** pusher (226) needs an `MT_PUSH` (doomednum 5001) or `MT_PULL` (5002) thing standing in
the tagged sector — `P_GetPushThing`, and "no `MT_P*` means no effect". Its force radiates from (or
pulls toward) that thing, falls off linearly to zero at **twice** the line's magnitude, **crosses
sector boundaries** (what matters is distance to the source, not which sector you stand in), and
requires line of sight to the source. Both 5001 and 5002 are invisible markers with no sprite art,
so they never spawn as things (`THING_SPRITES` has no entry, which is what gates spawning).

Every figure here comes from `Add_Pusher`/`T_Pusher`/`PIT_PushThing`: `PUSH_FACTOR` 7 (so the
impulse is the line vector over 128 map units per tic, and a point source's one shift smaller
again), the radius as `magnitude << 1`, and `P_AproxDistance` — vanilla's octagonal distance
estimate, reproduced rather than replaced with a true hypotenuse because both the reach and the
falloff are *defined* in terms of it.

**Pushers reach the player only** (voodoo dolls included — they are player mobjs — and a player's
corpse, since `T_Pusher` tests `thing->player` and not its health). Boom's own
`T_Pusher` skips every non-player outright, and `PIT_PushThing` widens to monsters only under
`mbf_features`, which complevel 9 — the Boom target — does not set. A conveyor's carry has no such
gate and moves every body on the belt (`T_Scroll`'s `sc_carry`). The asymmetry is Boom's, not this
engine's. Neither reaches a noclipping player (docs/cheats.md § IDCLIP).
