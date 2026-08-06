# Movement, collision and physics

`src/game/world.ts`, `src/game/player.ts`, `src/game/monsters.ts`, `src/game/things.ts`

## Collision (`world.ts`)

`World` provides spatial queries over a `DoomMap`: a 128-unit grid buckets linedefs for `linesNear`,
and `subsectorAt`/`sectorAt` walk the BSP tree the same way the renderer does.

**`groundFloor`** is the subtlest part, and it exists to fix a specific class of bug (falling off a
ledge permanently deadlocking movement): the height a body should rest at is not simply the
point-sampled sector floor. DOOM pins a mover's `floorz` to a straddled ledge's *high* side for as
long as its collision circle still spans that ledge's linedef (`P_TryMove`'s `tmfloorz`
accumulation) — only once fully clear does the floor, and so `z`, drop to the low side.
`groundFloor` reproduces this: the max of the local sector's floor and the opening-bottom of any
two-sided line the circle is currently straddling (`crossesLine` tests straddling — spanning both
sides of the infinite line — not mere proximity, matching `P_BoxOnLineSide`). **Player `z` must be
snapped from `groundFloor`, not `floorAt`**, or the very next frame's step-up test compares a
freshly-dropped `z` against a still-high opening bottom and blocks every further move near that edge,
forever.

Relatedly, `circleBlocked` only applies a two-sided line's opening (step-height, headroom) gate while
the circle actually straddles it (`crossesLine`); solid walls (`isSolidWall`: one-sided or
`LF.BLOCKING`) block on mere proximity regardless of side, since real walls stop you from any
direction. Conflating "near" with "straddling" for passable openings is exactly what causes the
deadlock above.

**`groundCeiling`** mirrors `groundFloor`: the local sector's ceiling, lowered to the top of any
straddled two-sided opening. It exists for the flip side of the same straddling bug — standing half
on a rising lift/floor and half in a static neighbor sector with a lower ceiling, `groundFloor`
correctly pins the player's `z` to the rising sector's floor, but a rise-blocking check that only
compares against *that sector's own* ceiling (`game.ts: blocksFloorRise`) never notices the lower
neighbor and lets the floor carry the player up into the neighbor's ceiling/upper wall — they end up
visibly stuck inside geometry. `blocksFloorRise` additionally checks the prospective floor height
against `groundCeiling` at the player's actual position, gated the same way `headroomBlocked` gates
sector membership (`circleOverlapsSector`), so the neighbor's real ceiling stops the rise before it
gets that far. See docs/specials.md § Every other mover stops instead.

### slideMove

`slideMove` is vanilla's `P_SlideMove`/`P_HitSlideLine`: a refused move is **projected onto the
blocking line's own direction** and retried, up to three walls deep, so what survives is the component
running along the wall and what's lost is the component pushing into it.

`blockingLineAt` identifies that wall — deliberately a separate function from `circleBlocked` rather
than an extension of it, because the two want opposite things: `circleBlocked` is the hot one (every
monster's `tryWalk` probe, every dropoff test) and returns on the *first* blocker it finds, while this
one has to weigh all of them to pick the nearest, i.e. the wall the circle is actually pressed against
rather than one it merely grazes.

It used to try the two axes separately instead, retrying the blocked axis from the new position — and
that only ever worked for an **axis-aligned** wall, for which (and only for which) the coordinate axes
happen to *be* the wall's own tangent and normal. Against anything diagonal it stopped the player
dead: pushing due north into a 45° wall leaves `dx = 0`, so there's no second axis left to move on.
Measured on real geometry across five maps, the share of wall-adjacent probes that covered under 5% of
a free second's distance roughly halved, the residue being genuine head-on walls, which *should* stop
you. Rounding a convex corner, the one case the axis split was written for, still works — the
projection produces the same slide, derived from the wall's geometry rather than the coordinate
system.

The per-axis attempt survives as a **fallback**, for the two cases projection can't resolve: a solid
body rather than a line stopped the move (`SOLID_BODY` — and axis separation is the *correct* slide
there anyway, since `PIT_CheckThing`'s blocker is an axis-aligned box, so its faces run along the
axes), or the circle already overlaps the wall it's trying to slide along, so the projection makes no
progress. Every position the projection loop returns has been validated by `blockingLineAt`; the loop
never falls out with an unchecked one.

Unlike vanilla, the projection runs from the circle's *current* position instead of first advancing it
to the contact point. At this engine's frame rate a move step is a few map units, so the skipped
fraction is far below anything visible, and the perpendicular distance to the wall is preserved by the
projection either way, so the circle never creeps into it.

**`Player.update` adopts whatever the slide actually managed as the new velocity**
(`(moved.x - x) / dt`), which is `P_SlideMove` writing its clipped vector back to `momx`/`momy`: the
along-wall component carries into the next frame and the into-wall component is gone. The old rule —
zero whichever *axis* failed to move — cannot express a diagonal wall's slide at all, since neither
axis is that wall's tangent. With the write-back, the steady state of "push into a wall at angle θ off
it, lerp back toward the input direction, project again" settles at exactly `speed × cos θ` along the
wall, verified across wall angles 0-90° and push angles 10/30/60° to three decimals.

## Movement speed and straferunning (`player.ts`)

Forward and sideways are **separate, differently-sized thrusts that are never renormalized**, and that
is the whole of vanilla's straferunning. `G_BuildTiccmd` accumulates `forwardmove` and `sidemove`
independently, clamps *each* to `MAXPLMOVE` on its own, and `P_PlayerThink` thrusts along both — so
running forward and sideways at once genuinely covers the diagonal of the two rather than the same
distance in a different direction.

`FORWARD_MOVE`/`SIDE_MOVE`/`MAX_PL_MOVE` are vanilla's own tables (`g_game.c`: `{25, 50}` and
`{24, 40}`, clamp 50), scaled once by `MOVE_UNIT_SPEED`. Only that scale is this engine's: 10
map-units/sec per move unit against vanilla's 11.67, so full-speed forward running is 500 rather than
~583 and everything else follows from the ratios (250 walking forward, 400 running sideways, 240
walking sideways). Keeping the tables rather than a pair of hand-picked speed constants is what makes
the two straferun speeds come out right without being aimed at:

- **SR40** — `W`+`D` running is `forwardmove` 50 and `sidemove` 40, `hypot(500, 400)` = 640 units/sec,
  **1.281×** plain running against vanilla's own 746.9/583.3 = 1.280.
- **SR50** is vanilla's `MAXPLMOVE` *clamp artifact*: reachable there only by binding a second strafe
  key and holding both bindings on the same side, so `sidemove` sums past 50 before the clamp cuts it
  back. This engine has no second strafe binding, so SR50 is latent rather than reachable here.
  `MAX_PL_MOVE`'s per-axis clamp is still exactly vanilla's regardless.

A previous version normalized the `(mx, my)` input vector to unit length before scaling by a single
speed, which makes every direction equally fast and takes SR40 away with it.

**Autorun** (`getAutorun`/`setAutorun`, the Settings tab's checkbox) flips which state Shift produces:
off, Shift runs exactly as above (vanilla's own sense); on — the default — the player runs and Shift
walks instead. It's module-level state in `player.ts` rather than a `Player` field, because `Player` is
recreated every map load (`game.ts: loadMapByIndex`) and the setting must take effect immediately for a
level already in progress, not just the next one. Persisted to `localStorage` the same way
`AudioEngine`'s volume is.

`ACCELERATION` (the exponential approach toward the target velocity) is deliberately **not**
vanilla-derived and is the one thing here still tuned by feel, same as `GRAVITY`: vanilla reaches its
terminal speed through per-tic thrust against a 0.90625 friction multiplier, which works out to a
~3.4/sec continuous rate against this engine's 12. Only the *terminal* speeds decide the straferun
ratios, so the two are independent — but the ramp-up here is markedly snappier than vanilla's, and
that is a live tuning knob rather than a matched behavior.

## Vertical physics: stairs, falling, gap-crossing (`player.ts`)

`Player.update` compares the current `z` against the freshly-recomputed `groundFloor` each frame
rather than always snapping straight to it:

- **`z <= groundFloor`** (on the ground, or a step-up onto a higher tread within `MAX_STEP_UP` —
  already gated by `circleBlocked`) snaps instantly, matching vanilla, which doesn't animate climbing
  a stair riser either; walking across a real staircase already reads as smooth because each tread is
  a separate sector crossed one frame at a time.
- **`z > groundFloor`** (the ground dropped out — walked off a ledge) is airborne: `velZ` accumulates
  at a constant `GRAVITY` and `z` integrates from it every frame, clamped to `groundFloor` once
  reached, instead of teleporting straight down. `velZ` is only ever negative — there's no jump input,
  so gravity is the only thing that ever moves `z` away from `groundFloor`.

`GRAVITY`'s value is tuned by feel (roughly a body height of fall in a third of a second), not
converted from vanilla's fixed-point tics-per-second constant, which doesn't translate cleanly to a
dt-scaled model.

Crossing a short chasm without falling in — DOOM's own "gap narrower than the player" quirk — falls
out of `groundFloor` for free rather than needing separate jump logic: a gap narrower than
`2*PLAYER_RADIUS` (32 units) keeps the collision circle straddling *both* edges for the entire
crossing, so `groundFloor` reports the high side throughout and the low pit floor is never sampled. A
wider gap does lose that straddle partway across, and the player falls in — there's no jump input to
clear it, unlike some later source ports.

## Knockback

Every hit with a real physical source — a shot, an explosion, a melee swing — also shoves its victim,
vanilla's `P_DamageMobj` horizontal thrust (`p_inter.c`): `thrust = damage*(FRACUNIT>>3)*100/mass`,
added to `momx`/`momy` and pointed directly away from the inflictor. This was entirely absent until a
player noticed a shot barrel not moving the way it does in vanilla; the only knockback that existed
before was the arch-vile's own *vertical* launch, a completely different mechanic
(`A_VileAttack`'s explicit `momz` set) that this doesn't touch.

Vanilla calls `P_DamageMobj` with a null inflictor for damage floors and crushers, which skips the
whole thrust block — reproduced here simply by never passing a `fromX`/`fromY` at those two call
sites (`applyCrushDamage`/`updateDamageFloor`), rather than a special-cased exemption.

**`monsters.ts: thrustSpeed(damage, mass)`** is the shared formula (`(damage/8) * (100/mass) * 35` —
the `×35` the same "vanilla's per-tic figure survives conversion intact" reasoning `MonsterStats.speed`
relies on), fed a real per-species `mass` from `info.c`'s `mobjinfo` table for all 18 monster types:
mostly 100, but 400 for a demon/cacodemon/pain elemental, 500 for a revenant/arch-vile, 600 for an
arachnotron, 1000 for a baron/hell knight/mancubus/spider mastermind/cyberdemon, and 50 for the lost
soul — so a cyberdemon barely budges from a hit that sends a zombieman staggering. `BARREL_MASS`
(`things.ts`) and `PLAYER_MASS` (`player.ts`) are the real figures for those two (both vanilla's
default, 100). The arch-vile's vertical launch deliberately keeps its own pre-existing flat-100-mass
approximation (`VILE_KNOCKUP_SPEED`) rather than switching to this table — shipped, working behavior
for one rare attack.

**Where the impulse gets computed is centralized to the two places all damage already flows through** —
`ThingLayer.damage` (monsters and barrels) and `game.ts`'s `damagePlayer` — rather than at each of the
dozen-plus call sites that deal damage. Both take optional trailing `fromX`/`fromY`; when given, they
compute the away-from-source unit vector (falling back to the victim's own facing in the degenerate
case where attacker and victim occupy essentially the same point, e.g. point-blank melee — vanilla's
`R_PointToAngle2(0,0,0,0)` returns angle 0 for the same reason) and add `thrustSpeed(amount, mass)`
along it onto the victim's knockback velocity.

Every call site threads its own natural inflictor position: the player's position for a hitscan pellet
or melee swing, the projectile's live position at the moment it lands for a rocket/fireball (matching
vanilla's inflictor being the missile itself), and the explosion's centre for splash
(`applyRadiusDamage`'s `at`, exactly `P_RadiusAttack(spot, source, damage)` passing `spot`) — which is
also why a barrel's chain-reaction explosion gets correct knockback for free, with no extra wiring:
it's just another `applyRadiusDamage` call. The one approximation is the BFG spray, whose real
inflictor is the ball wherever it stopped, which this code path doesn't track, so the player's own
position stands in.

**Integrating and decaying the resulting velocity is a second, separate step from computing the
impulse**, and deliberately not the same velocity a monster/barrel/player already tracks for its own
movement. `PosedThing.velX`/`velY` and `Player`'s `knockVelX`/`knockVelY` are dedicated knockback-only
state, decayed every frame by vanilla's per-tic `FRICTION` (`0.90625`) raised to the `dt*35` power —
reproducing the exact discrete recurrence at any frame rate rather than converting to a continuous
rate first, which would only approximate it. Below `KNOCKBACK_STOP_SPEED` (1 u/s) the velocity snaps
to exactly 0 rather than crawling forever, the same reasoning as `WallFader`'s fade snap.

- **`ThingLayer.applyKnockback`** integrates a monster or barrel's velocity as a plain displacement,
  blocked by ordinary wall/step collision (`circleBlocked`, `forMonster: true` — `ML_BLOCKMONSTERS`
  stops *any* non-player thing, so this is the correct flag even for a barrel). Unlike the player, a
  blocked monster or barrel stops dead and drops the remaining velocity rather than sliding, matching
  `P_XYMovement` zeroing `momx`/`momy` for a blocked non-missile, non-player mobj. It runs
  **additively, on top of** whatever AI movement or floor-following already happened that frame,
  matching vanilla's ordering: `P_XYMovement`'s displacement happens before `A_Chase`'s walk step
  within the same tic, so the two genuinely sum. A barrel has no AI movement, so this is its only
  source of horizontal motion. Deliberately skips `blockersFor`'s thing-vs-thing check (a knockback
  nudge is small, transient and rare enough that two shoved bodies briefly overlapping isn't worth the
  query). A dead thing's velocity is left as inert, unread data — **except** `reviveCorpse`, which
  zeroes it, the same "stale velocity could sit unused and then jump on revival" bug the arch-vile
  resurrection fix already caught for `velZ`.
- **`Player.applyKnockback`** is kept entirely separate from the player's own `velX`/`velY`
  (input-driven, an exponential approach toward a *target* velocity) rather than added into them:
  folding an impulse into that model would have it absorbed or fought by whatever the player is
  pressing within a frame or two, which isn't how vanilla's momentum-based movement behaves.
  `knockVelX`/`knockVelY` get their own `slideMove` call and their own `FRICTION` decay, run as an
  additional displacement right after the ordinary movement block — still sliding along walls rather
  than stopping dead, since the player is the one thing in vanilla that always gets `P_SlideMove`
  regardless of what set its momentum in motion.
