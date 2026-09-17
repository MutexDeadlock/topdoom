# Movement, collision and physics

`src/game/world.ts`, `src/game/player.ts`, `src/game/monsters/ai.ts`, `src/game/things.ts`,
`src/game/things/grid.ts`

## Collision (`world.ts`)

`World` provides spatial queries over a `DoomMap`: a 128-unit grid buckets linedefs for `linesNear`,
and `subsectorAt`/`sectorAt` walk the BSP tree the same way the renderer does.

**A mover is an axis-aligned box, half-width `radius`** — vanilla's own `mobjinfo.radius`, 16 for
the player. Not a circle: the engine clipped an inscribed circle until it was replaced by
`P_BoxOnLineSide`, and the box is what every rule below is written against. The two disagree by up
to `radius·(√2−1)` on the diagonal, which is why 0.93% of positions legal under the circle are not
under the box — the box does not fit diagonal gaps a mapper shaped to be impassable.

Every line test is `PIT_CheckLine`'s pair, in vanilla's order:

1. **`boxOverlapsLine`** — the mover's box against the linedef's *own* precomputed bounding box.
   Exactly flush is deliberately not an overlap (vanilla's `<=`/`>=`). This is also what makes a
   line stop applying past its own ends, and so why nothing can catch on a wall's endpoint (§
   slideMove).
2. **`boxOnLineSide`** — `P_BoxOnLineSide`, which reads the line's `slopetype` to pick which two
   opposing corners decide it and returns `-1` when they disagree, i.e. the box spans the line.

Both read per-linedef tables (`lineBox`, `lineDX`/`lineDY`, `lineSlope`, first vertex) built once in
`World`'s constructor from `P_LoadLineDefs`' own derivation. They are typed arrays rather than
fields on `LineDef` because this is the hottest query in the engine and `LineDef` is the parse
result, which `tests/fixtures/gridmap.ts` constructs by hand.

**`groundFloor`** is the subtlest part, and it exists to fix a specific class of bug (falling off a
ledge permanently deadlocking movement): the height a body should rest at is not simply the
point-sampled sector floor. DOOM pins a mover's `floorz` to a straddled ledge's *high* side for as
long as its box still spans that ledge's linedef (`P_TryMove`'s `tmfloorz` accumulation) — only once
fully clear does the floor, and so `z`, drop to the low side. `groundFloor` reproduces this: the max
of the local sector's floor and the opening-bottom of any two-sided line the box currently spans.
**Player `z` must be snapped from `groundFloor`, not `floorAt`**, or the very next frame's step-up
test compares a freshly-dropped `z` against a still-high opening bottom and blocks every further
move near that edge, forever.

**A ledge more than `MAX_STEP_UP` above a body's feet never counts** (`stepsTooHigh`, the `feet`
argument of `groundFloor` and the `z` every `checkPosition` collider carries). The pinning above
*retains* a floor a body already reached; it must never *lift* one, and vanilla cannot, because a
box-wide `tmfloorz` is only ever adopted by a `P_TryMove` that already refused a bigger step. The
same opening is asked twice on one walk, by one predicate: it refuses the move (`openingRefuses`)
and it is skipped as floor. Without it a body authored — or shoved, or left by a lowering sector —
beside a tall ledge its box overlaps is snapped onto that ledge's top the moment anything settles
it, and the dropoff rule then measures every step back down against the ledge and refuses it: a
monster hovering a ledge's height over the floor for the rest of the level, walking on air.
`ANY_HEIGHT` feet ask the geometry alone, which is what a fresh placement (a teleport arrival, a
level's spawn loop) wants and what `groundCeiling`/`headroom` always pass.

**Repro: DOOM1 E1M1**, the shotgun guys at (240, -3376) and (240, -3088). They stand in sector 24
(floor -8) and their 20-unit box overlaps by 4 units the linedefs of the platforms beside them
(sectors 44/45, floor 40), so waking one used to hop it 48 units into the air.
`tests/game/monster-under-high-ledge.test.ts` states that geometry in round numbers. It is
authored geometry and not an accident of this engine: 39 of the 16,821 monsters in DOOM1, DOOM2 and
the two freedooms stand in one, up to DOOM2 MAP26's cyberdemon at 216 units.

A **solid** wall goes through the same two gates as a passable opening — it is not refused on mere
proximity. That is `PIT_CheckLine`'s own order (bbox, then side, and only then the `!backsector` /
`ML_BLOCKING` decisions), and it is the whole reason the endpoint jam § slideMove used to describe
cannot happen: a wall that the box does not span is a wall that does not apply.

**`checkPosition` applies all three of `P_TryMove`'s height gates, and the third one is easy to
miss.** Against a crossed opening, in vanilla's order: too short to stand in at all
(`tmceilingz - tmfloorz < thing->height`), too big a step up (`tmfloorz - thing->z > 24`), and the
opening's top too low **for this body's own `z`** (`tmceilingz - thing->z < thing->height`, "mobj
must lower itself to fit"). Only the third is relative to the mover's feet rather than to the
opening, so an opening-range test cannot stand in for it, and it only ever bites a body standing
*higher* than the opening's bottom — which for a grounded mover on flat or stepped ground never
happens, since `groundFloor` already pins `z` to the highest straddled opening bottom. The two cases
that do reach it: a body on a raised lift beside a neighbor whose ceiling is below the lift's floor,
and a body still airborne. Missing it let the player walk off a raised lift and end up standing
inside solid geometry.

**Repro: DOOM2 MAP06 line 359**, the north edge of the lift (sector 122, up at 40). Three 16-unit
blocks sit just past that edge; the gap between them is spanned by sector 118, whose ceiling is
-440 — a crawlspace reachable only once the lift has taken you down to the pit floor at -512. The
first two gates both pass there (the opening is 72 tall, and entering it is a step *down*), so
without the third the 48-unit gap was walkable at lift height. Across DOOM/DOOM2/freedoom2 the gate
changes under 0.006% of grounded positions, so it is genuinely this shape of geometry and not a
general narrowing.

`ANY_HEIGHT` as the `z` argument drops both feet-relative gates and tests the line's geometry alone
— vanilla's pre-`floatok` subset, wanted by exactly one caller (docs/monster-ai.md § Floating
monsters). `checkPosition` measures every gate against `PLAYER_HEIGHT`; a monster's real
`stats.height` is applied separately by `monsters/ai.ts: testStep`.

**"Doesn't fit" is box-wide, not per opening.** Vanilla compares the `tmceilingz`/`tmfloorz`
accumulated over every line the box spans, so two openings that each fit refuse together when one
raises the floor and the other lowers the ceiling. `checkPosition` asks that window once after the
walk. Without it the player stepped onto such a straddle, `groundFloor` lifted `z` onto the high
floor, and the low ceiling then refused every direction — frozen for good. It is only asked once
the box spans an opening, which keeps the player's exemption inside a single crushed sector
(docs/monster-ai.md § Movement). The other two gates need no box-wide pass: a maximum floor or
minimum ceiling fails them exactly when one opening does.

**Repro: rush.wad MAP01** (936, -1026): line 2118's opening into sector 373 (floor 160, ceiling
224) and the 8×8 step sector 381 (floor 184), 24 units apart. `tests/game/straddle-no-headroom.test.ts`.

**Thing-vs-thing collision has the same class of deadlock, and the same shape of fix.**
`blockedByThings` (used by `checkPosition`, and through it by `slideMove`) takes an optional `from`,
the mover's current position: a blocker already overlapped there only refuses the move if it presses
*further* in (Euclidean distance to that blocker's centre goes down), not merely for the destination
still overlapping. Without this, two bodies that end up touching — map placement, or a knockback
that skips this same check (`ThingLayer.applyKnockback`) — can never separate again: a single
frame's step is a few units against a reach (`radius + radius`) of tens, so requiring the
*destination* to already be fully clear is unreachable in one step, and both sides see the other as
permanently solid. `tryWalk`, the per-frame monster walk step, and `slideMove` (both its wall
projection and its per-axis fallback) all pass their mover's own position as `from`. A blocker not
yet touched at `from` is unaffected — this only lets an already-overlapping pair work free, it never
lets a mover approach a thing it wasn't already touching.

**Bodies have a real height, and that is a deliberate deviation.** Vanilla's `PIT_CheckThing`
returns on `MF_SOLID` before comparing any z — its over/under pair lives in the `MF_MISSILE` branch
alone, confirmed in `linuxdoom-1.10/p_map.c` — so a DOOM actor blocks over its entire vertical
extent, the well-known "infinitely tall actors". Here a mover clearing a blocker entirely passes it
instead:

```
z >= b.z + b.height  ||  z + height <= b.z    →  not blocked
```

which follows the finite-height actors of modern ports rather than the original, because in a
top-down view a cacodemon hovering overhead reads as an invisible wall. The **`Infinite tall actors
(vanilla)`** setting (Settings → General, the `infiniteTallActors` setting, off by default) restores the
original rule; `blockedByThings` reads it per call, so it applies to the level already running.
Rules that go with it:

- **Touching exactly counts as clearing**, unlike vanilla's strict missile pair — a body resting on
  another's top must read as *over* it, or standing on a monster would block every direction that
  stays above it.
- **An `ANY_HEIGHT` mover keeps vanilla blocking**: it has no span to clear a body with, so
  `testStep`'s `floatok` probe answers exactly what it did before heights existed.
- **Movement blocking only.** Every other z comparison in the engine is one vanilla makes too and is
  untouched by the setting: a missile's over/under (`spritefx/defs.ts: stepTouchesBody`), a
  hitscan's aim-slope span and auto-aim slope (docs/combat.md), `meleeReachesVertically`
  (docs/monster-ai.md § Melee reach), `tryPickup`'s overhead gate (docs/items.md), and splash, which
  is 2D in vanilla.
- **The blocker broadphase stays 2D** (`things/grid.ts: blockersFor`). A z pre-filter would shrink
  the candidate set but put the vertical rule in a second place; `blockedByThings` stays its one
  home.
- The player can be **stood on**, and stands on bodies (§ Vertical physics: stairs, falling,
  gap-crossing). Nothing else does: two vertically disjoint monsters simply pass through each
  other's column.

### Solid decorations

`game/things/tables.ts`'s `SOLID_DECORATION_TYPES` is every doomednum from the "Obstacles &
decorations" and "Gore & corpses" blocks of `THING_SPRITES` that carries vanilla's `MF_SOLID` flag —
confirmed per-type against `linuxdoom-1.10/info.c`'s `mobjinfo` table: the column, candelabra, all
six pillars, the evil eye, skull rock, all six torches, the stalagmite, the tech pillar, the burning
barrel, both techno lamps, both trees, the five pole/skull decorations, the solid "hanging victim"
quintet and DOOM II's six `HDB*` body bags. Every entry shares vanilla's 16-unit radius
(`SOLID_DECORATION_RADIUS`) except the big tree (doomednum 54), which is 32 —
`SOLID_DECORATION_RADIUS_OVERRIDE` is the one-key exception table for it. The plain candle
(doomednum 34, `flags: 0`) and every dead-monster/blood-pool prop are the decorations genuinely
**not** solid in vanilla and are deliberately left out, same as the exploding barrel's own
`MF_SOLID` (doomednum 2035) is handled by its pre-existing `ThingType.barrel` special-case rather
than being folded into this set. `things/grid.ts`'s `rebuild` and `solidBodies` both admit
`SOLID_DECORATION_TYPES` alongside `MONSTER_TYPES`/`ThingType.barrel`, so a solid decoration blocks
the player (`solidBodies`) and monster movement (`blockersFor`) exactly like a monster does.

**Ceiling-hung gore.** `CEILING_HUNG_HEIGHT` holds vanilla's `MF_SPAWNCEILING` doomednums (the
"hanging victim" props and DOOM II's body bags, solid and non-solid alike) mapped to their real
`mobjinfo.height`. `buildThingSprites` and `ThingLayer.update` both measure `z` down from the
sector's own `ceilHeight` instead of up from `floorHeight` for these — the same per-frame "ride a
mover" trick a floor decoration already gets, just off the opposite surface, so a crusher or
closing door carries a hanging corpse along too.

**They must not become shootable in the process.** The solid-body grid (`ThingGrid`) also backs
`raycastMonster` and `monstersNear` (hitscans and projectile splash), and those two explicitly skip
`SOLID_DECORATION_TYPES` — vanilla's `PIT_ShootTraverse`/`PIT_RadiusAttack` only test
`MF_SHOOTABLE`, which no decoration in this set carries (unlike the barrel, which is both
`MF_SOLID` and `MF_SHOOTABLE`). Movement blocking and shot blocking read the same grid but are two
different filters for exactly this reason — see `things/grid.ts`'s `rebuild` doc.

That makes the set's real membership rule **`MF_SOLID` and not `MF_SHOOTABLE`**, which the DEHACKED
applier has to honour when a `Bits` line rewrites it: every monster carries `MF_SOLID` too, so
adding on that bit alone would put a patched monster in here and every shot would pass through it.
docs/dehacked.md § Bits.

**`groundCeiling`** mirrors `groundFloor`: the local sector's ceiling, lowered to the top of any
straddled two-sided opening. It exists for the flip side of the same straddling bug — standing half
on a rising lift/floor and half in a static neighbor sector with a lower ceiling, `groundFloor`
correctly pins the body's `z` to the rising sector's floor, but a rise-blocking check that only
compares against *that sector's own* ceiling (`game/specials/moverblocking.ts: blocksFloorRise`)
never notices the lower neighbor and lets the floor carry the body up into the neighbor's
ceiling/upper wall — it ends up visibly stuck inside geometry. `blocksFloorRise` therefore measures
**every** body, player and monster alike, against `groundCeiling` at its actual position, so the
neighbor's real ceiling stops the rise before it gets that far. See docs/specials-movers.md § Every
other mover stops instead.

### slideMove

`slideMove` is vanilla's `P_SlideMove` (`p_map.c`), and it is the **player's alone** — a monster
gets `P_Move`'s all-or-nothing step instead (docs/monster-ai.md § Movement). It is only entered once
the whole move has already been refused, which is `P_XYMovement`'s own structure.

One attempt, up to `SLIDE_ATTEMPTS` (vanilla's `hitcount == 3`) of them:

1. **Three corner traces.** The leading corner of the box and the two beside it are each traced
   along the move; the fourth, trailing corner deliberately is not — vanilla traces three. Each
   trace keeps the nearest blocking line it crosses (`bestslidefrac`/`bestslideline`).
2. **Commit up to the wall**, less `SLIDE_FUDGE` — vanilla's `0x800`, a thirty-second of the step —
   so the position taken is reliably clear of the wall rather than exactly on it. This costs up to
   that fraction of the along-wall travel on the tic where contact happens, which is vanilla's own
   behaviour, not an approximation of it.
3. **Project the remainder** onto the blocking line's own direction (`P_HitSlideLine`), so what
   survives is the component running along the wall and what is lost is the component pushing into
   it. Vanilla's angle arithmetic reduces to exactly this projection, without `P_AproxDistance`'s
   ~12% magnitude error.

When no trace finds a wall, it falls to vanilla's **`stairstep`**: try Y alone, and X alone only if
Y was refused. That is also where a **solid body** rather than a line lands, since a thing produces
no line intercept at all — which is the correct slide against one anyway, `PIT_CheckThing`'s blocker
being an axis-aligned box whose faces run along the axes. Note the consequence of vanilla's exact
nesting: with no Y component the Y attempt is the mover's own position and succeeds, so a purely
lateral move stopped by a body does not fall through to the X attempt.

**Ordering the intercepts costs nothing here.** Vanilla's `P_PathTraverse` sorts them by fraction
and stops at the first blocker, but `PTR_SlideTraverse`'s blocking decision reads nothing but the
line itself, and its only output is the smallest blocking fraction. A running minimum over the
grid's own order (`forEachLineAlongSegment`, docs/world.md § hasLineOfSight) therefore picks the
same line, with no sort and no intercept buffer.

**A two-sided `ML_BLOCKING` line counts as blocking in the traces, and vanilla's does not.**
`PTR_SlideTraverse` tests only `ML_TWOSIDED` and the opening, so a two-sided wall carrying
`ML_BLOCKING` — an ordinary way to build a solid diagonal — is invisible to the traverse while
`PIT_CheckLine` refuses the move. No wall is found, the move falls to the stairstep, and if either
component is exactly zero the stairstep is a no-op: the player stops dead against a wall they should
slide along.

Vanilla rarely shows this because its momentum comes from an angle that is almost never exactly
axis-aligned. **This engine hits it constantly**: movement is camera-relative off a yaw that snaps
to fixed values, so holding one strafe key produces an exactly zero component as the *normal* case.
**Repro: DOOM2 MAP01** line 334, the diagonal (-448,576)-(-576,704) — running due west into it
stopped dead. Pinned by `tests/game/blocking-line-slide.test.ts` on freedoom2 MAP01 line 514,
since the grid fixture cannot build a diagonal.

Aligning the traverse with what actually refuses the move can only ever turn a dead stop into a
slide: `slideMove` is entered only once the whole move is already refused, so finding the real
blocker is strictly better than finding none. It never blocks a move that was allowed.

**One deliberate deviation in the traces.** `PIT_AddLineIntercepts` tests the trace against the
*infinite* line and leans on blockmap locality to stop that inventing crossings past a linedef's own
ends; this bounds both segments instead, the same choice `hasLineOfSight` and `shotPath` make. That
is a strict subset of vanilla's intercepts, which is the safe direction of error: a missed one
degrades to the stairstep, where a phantom one would slide along a wall that is not there. A trace
never validates a position — `positionBlocked` does — so it can only pick a direction, never let a
body through a wall.

**There is no corner-rounding rescue, and there must not be one.** A collision *circle* can come to
rest against a wall's **endpoint**, out past the wall's own length, where the projection is a no-op
and the stairstep has no second axis to try — the player freezes solid, forward dead, backward and
strafing fine. That state is unreachable for a box: a linedef stops applying the moment the box no
longer overlaps the line's own bounding box (§ Collision), so a wall that refuses the move is always
a wall whose direction is a usable slide. The rescue this file used to document, along with its
progress gate, was deleted with the circle.

The visible consequence is that a body pressed into a wall junction now stops where vanilla stops
it. Pushing due east at DOOM2 MAP01 (1696, 1536) — into the junction where line 205 runs north-south
and line 204 heads off south-east — produces no movement, because a pure-east push into a
north-south wall has no along-wall component. The circle used to round that corner and slide
south-east instead. Nothing is trapped by this: measured across nine DOOM/DOOM2 maps, 9 of 375,495
legal positions have no free direction at all, against 8 of 379,022 under the circle.

**`Player.update` adopts whatever the slide actually managed as the new velocity**
(`(moved.x - x) / dt`), which is `P_SlideMove` writing its clipped vector back to `momx`/`momy`: the
along-wall component carries into the next frame and the into-wall component is gone. The old rule —
zero whichever *axis* failed to move — cannot express a diagonal wall's slide at all, since neither
axis is that wall's tangent. With the write-back, the steady state of "push into a wall at angle θ
off it, lerp back toward the input direction, project again" settles at exactly `speed × cos θ`
along the wall, verified across wall angles 0-90° and push angles 10/30/60° to three decimals. The
*pre-clip* vector is kept too, as `Player.attempted` — pickups reach the destination vanilla tested,
not the one the slide settled on (docs/items.md § Collecting things).

## Movement speed and straferunning (`player.ts`)

Forward and sideways are **separate, differently-sized thrusts that are never renormalized**, and
that is the whole of vanilla's straferunning. `G_BuildTiccmd` accumulates `forwardmove` and
`sidemove` independently, clamps *each* to `MAXPLMOVE` on its own, and `P_PlayerThink` thrusts along
both — so running forward and sideways at once genuinely covers the diagonal of the two rather than
the same distance in a different direction.

`FORWARD_MOVE`/`SIDE_MOVE`/`MAX_PL_MOVE` are vanilla's own tables (`g_game.c`: `{25, 50}` and
`{24, 40}`, clamp 50), scaled once by `MOVE_UNIT_SPEED`. Only that scale is this engine's: 10
map-units/sec per move unit against vanilla's 11.67, so full-speed forward running is 500 rather
than ~583 and everything else follows from the ratios (250 walking forward, 400 running sideways,
240 walking sideways). Keeping the tables rather than a pair of hand-picked speed constants is what
makes the two straferun speeds come out right without being aimed at:

- **SR40** — `W`+`D` running is `forwardmove` 50 and `sidemove` 40, `hypot(500, 400)` = 640
  units/sec, **1.281×** plain running against vanilla's own 746.9/583.3 = 1.280.
- **SR50** is vanilla's `MAXPLMOVE` *clamp artifact*: reachable there only by binding a second
  strafe key and holding both bindings on the same side, so `sidemove` sums past 50 before the clamp
  cuts it back. This engine has no second strafe binding, so SR50 is latent rather than reachable
  here. `MAX_PL_MOVE`'s per-axis clamp is still exactly vanilla's regardless.

A previous version normalized the `(mx, my)` input vector to unit length before scaling by a single
speed, which makes every direction equally fast and takes SR40 away with it.

**Autorun** (`getAutorun`/`setAutorun`, the Settings tab's checkbox) flips which state Shift
produces: off, Shift runs exactly as above (vanilla's own sense); on — the default — the player runs
and Shift walks instead. The stored value is module-level state in `player.ts`; `Player.update`
reads its own `autorun` field, pushed from the slot's settings every tic — `Player` is recreated
every map load (`game.ts: buildLevel`), a menu change must reach a level already in progress,
and each slot runs under its own (docs/multiplayer.md § Player settings). Persisted as
`autorun` — docs/menu.md § Persisted settings.

`Player.update` runs once per simulation tic, and `Player` carries `prevX`/`prevY`/`prevZ`/
`prevAngle` for the render layer to interpolate from — with `syncInterpolation` collapsing that
window on every discontinuous move (`moveTo`, `teleportTo`), or a teleport draws as a glide across
the map. docs/frameloop.md § Interpolation.

`ACCELERATION` (the exponential approach toward the target velocity) is deliberately **not**
vanilla-derived and is the one thing here still tuned by feel, same as `GRAVITY`: vanilla reaches
its terminal speed through per-tic thrust against a 0.90625 friction multiplier, which works out to
a ~3.4/sec continuous rate against this engine's 12. Only the *terminal* speeds decide the straferun
ratios, so the two are independent — but the ramp-up here is markedly snappier than vanilla's, and
that is a live tuning knob rather than a matched behavior.

## Vertical physics: stairs, falling, gap-crossing (`player.ts`)

`Player.update` compares the current `z` against the freshly-recomputed `groundFloor` each frame
rather than always snapping straight to it:

- **`z <= groundFloor`** (on the ground, or a step-up onto a higher tread within `MAX_STEP_UP` —
  already gated by `positionBlocked`) snaps instantly, matching vanilla, which doesn't animate
  climbing a stair riser either; walking across a real staircase already reads as smooth because
  each tread is a separate sector crossed one frame at a time.
- **`z > groundFloor`** (the ground dropped out — walked off a ledge) is airborne: `velZ`
  accumulates at a constant `GRAVITY` and `z` integrates from it every frame, clamped to
  `groundFloor` once reached, instead of teleporting straight down. `velZ` is only ever negative —
  there's no jump input, so gravity is the only thing that ever moves `z` away from `groundFloor`.

**A solid body under the player is ground too** (`world.ts: bodyFloor`, `Math.max`ed into
`Player.update`'s `groundZ`), so walking off a ledge above a monster lands *on* it instead of
falling through it and coming to rest inside it — the other half of finite body height (§ Collision
above), and inert while infinite-tall actors is on. Vanilla has no equivalent at all: `tmfloorz`
only ever comes from a line opening. What holds it together:

- **Only a body already below the mover counts** (`top <= z`, this engine's own rule). That is what
  makes a fall *land* rather than snap the player up onto a body that walked into its box, and it
  means a cacodemon rising under the player stops qualifying — the player drops off rather than
  being carried up.
- **It is the player's alone.** Monsters ask `groundFloor` only, so one walks *under* a standing
  player rather than onto it, and nothing else in the engine treats a body as a surface.
- **You can fall onto a body but not step up onto one**: at floor level the two spans overlap, so
  the move is refused — and a 56-unit top is past `MAX_STEP_UP` anyway.
- **A body doesn't carry the player horizontally.** When it moves away or dies (`solidBodies` skips
  the dead) `groundZ` drops back to the sector floor and the airborne branch below resumes the fall,
  with no special case.

`GRAVITY`'s value is tuned by feel (roughly a body height of fall in a third of a second), not
converted from vanilla's fixed-point tics-per-second constant, which doesn't translate cleanly to a
dt-scaled model.

**A hard landing is derived from vanilla's drop *height*, not its speed.** `Player.landingSpeed`
reports how fast a fall ended, and `HARD_LANDING_SPEED` is what counts as hard enough to knock the
wind out (`oof`, docs/audio.md § Who plays what). Vanilla grunts below `momz < -8` units/tic, which
under *its* gravity of 1 unit/tic² is exactly a 32-unit drop — so this engine solves
`sqrt(2 * GRAVITY * 32)` under its own stronger, feel-tuned `GRAVITY` instead of copying the number.
Copying the speed would make shallower ledges grunt than vanilla's do, and 24 units — DOOM's most
common step height — sits right on that boundary, so the wrong choice makes ordinary stairs grunt.

Crossing a short chasm without falling in — DOOM's own "gap narrower than the player" quirk — falls
out of `groundFloor` for free rather than needing separate jump logic: a gap narrower than
`2*PLAYER_RADIUS` (32 units) keeps the collision box spanning *both* edges for the entire crossing,
so `groundFloor` reports the high side throughout and the low pit floor is never sampled. A wider
gap does lose that straddle partway across, and the player falls in — there's no jump input to clear
it, unlike some later source ports.

## External momentum

Everything that moves a body **without** its own input goes through one channel — vanilla's
`momx`/`momy`, which this engine keeps separate from the input-driven velocity for the reason
spelled out at the end of this section. Two things feed it: damage knockback, and the world forces
Boom's parameter lines apply (conveyors, wind, current — docs/specials-forces.md § Scrollers and
conveyors).

### Knockback

Every hit with a real physical source — a shot, an explosion, a melee swing — also shoves its
victim, vanilla's `P_DamageMobj` horizontal thrust (`p_inter.c`):
`thrust = damage*(FRACUNIT>>3)*100/mass`, added to `momx`/`momy` and pointed directly away from the
inflictor. This was entirely absent until a player noticed a shot barrel not moving the way it does
in vanilla; the only knockback that existed before was the arch-vile's own *vertical* launch, a
completely different mechanic (`A_VileAttack`'s explicit `momz` set) that this doesn't touch.

Vanilla calls `P_DamageMobj` with a null inflictor for damage floors and crushers, which skips the
whole thrust block — reproduced here simply by never passing a `from` at those two call
sites (`applyCrushDamage`/`SectorEffects.update`), rather than a special-cased exemption.

The same block skips an `MF_NOCLIP` target, so `damageSlot` gives an IDCLIP player no thrust. It
runs before the invulnerability return, so an invulnerable player is still shoved, and a corpse,
which `P_DamageMobj` returns on first, is not (docs/death.md § Player death).

**`monsters/defs.ts: thrustSpeed(damage, mass)`** is the shared formula
(`(damage/8) * (100/mass) * 35` — the `×35` the same "vanilla's per-tic figure survives conversion
intact" reasoning `MonsterStats.speed` relies on), fed a real per-species `mass` from `info.c`'s
`mobjinfo` table for all 18 monster types: mostly 100, but 400 for a demon/cacodemon/pain elemental,
500 for a revenant/arch-vile, 600 for an arachnotron, 1000 for a baron/hell knight/mancubus/spider
mastermind/cyberdemon, and 50 for the lost soul — so a cyberdemon barely budges from a hit that
sends a zombieman staggering. `BARREL_MASS` (`things/defs.ts`) and `PLAYER_MASS` (`player.ts`) are
the real figures for those two (both vanilla's default, 100). The arch-vile's vertical launch
deliberately keeps its own pre-existing flat-100-mass approximation (`VILE_KNOCKUP_SPEED`) rather
than switching to this table — shipped, working behavior for one rare attack.

**Where the impulse gets computed is centralized to the two places all damage already flows
through** — `ThingLayer.damage` (monsters and barrels) and `game.ts`'s `damageSlot` — rather than
at each of the dozen-plus call sites that deal damage. Both take an optional `hit.from`;
when given, they compute the away-from-source unit vector (falling back to the victim's own facing
in the degenerate case where attacker and victim occupy essentially the same point, e.g. point-blank
melee — vanilla's `R_PointToAngle2(0,0,0,0)` returns angle 0 for the same reason) and add
`thrustSpeed(amount, mass)` along it onto the victim's knockback velocity.

The player's half of that arithmetic is `Player.applyDamageThrust(speed, fromX, fromY)`, beside the
`applyKnockback` it feeds; `ThingLayer.damage` keeps its own copy inline because it is already
iterating per-body with a per-type `mass`. **The magnitude stays with the caller** either way — a
victim's `mass` (`MonsterStats.mass`, `BARREL_MASS`, `PLAYER_MASS`) is not something `Player` has
any reason to know, and importing `thrustSpeed` into `player.ts` would be a cycle besides, since
`monsters/ai.ts` imports `player.ts`.

Every call site threads its own natural inflictor position: the player's position for a hitscan
pellet or melee swing, the projectile's live position at the moment it lands for a rocket/fireball
(matching vanilla's inflictor being the missile itself), and the explosion's centre for splash
(`applyRadiusDamage`'s `at`, exactly `P_RadiusAttack(spot, source, damage)` passing `spot`) — which
is also why a barrel's chain-reaction explosion gets correct knockback for free, with no extra
wiring: it's just another `applyRadiusDamage` call. The one approximation is the BFG spray, whose
real inflictor is the ball wherever it stopped, which this code path doesn't track, so the player's
own position stands in.

**Integrating and decaying the resulting velocity is a second, separate step from computing the
impulse**, and deliberately not the same velocity a monster/barrel/player already tracks for its own
movement. `PosedThing.velX`/`velY` and `Player`'s `momX`/`momY` are the channel's own state, never
the input velocity, decayed every tic by vanilla's per-tic `FRICTION` (`0.90625`) spread over the
tics the step covers (`util/damping.ts: decayOverTics`) — reproducing the exact discrete recurrence
at any step length rather than converting to a continuous rate first, which would only approximate
it. Under the tic lock the exponent is exactly 1, so the decay is the bare factor and no `Math.pow`
runs on the movement path. Below `MOMENTUM_STOP_SPEED` (1 u/s) the
velocity snaps to exactly 0 rather than crawling forever, the same reasoning as `WallFader`'s fade
snap.

**Each axis of the channel is held to vanilla's `MAXMOVE` (`p_local.h`, 30 units/tic —
`player.ts: MAX_MOMENTUM_SPEED`, `clampMomentum`) before it moves anything**, `P_XYMovement`'s first
act, in all three integrators. Nothing else bounds a thrust: the BFG ball's 100-800 contact hit is
up to 100 units/tic, and a monster or barrel takes its move as one step that `positionBlocked`
only probes at the far end (docs/testing.md § Cell size and tunnelling), so an unclamped hit
carried the body clean through a wall. Repro: NUTS.WAD, a BFG ball into the front imps — corpses
shot out of the map. The clamp binds the momentum channel alone; vanilla's binds the sum of input
and momentum, but the input channel is bounded on its own (§ Friction's `MAX_TARGET_SCALE`).

- **`ThingLayer.applyKnockback`** integrates a monster or barrel's velocity as a displacement taken
  in halves until no step exceeds `MAXMOVE/2` (`MOMENTUM_SPLIT_STEP`, 15 units — `P_XYMovement`'s
  own split, with MBF's symmetric check where vanilla splits a positive move only), so a barrel's
  20-unit box can't skip a wall at the clamp either; the player and a doll need no split, since
  `slideMove` traces the box's corners. Each step is blocked by ordinary wall/step collision
  (`checkPosition`, `forMonster: true` —
  `ML_BLOCKMONSTERS` stops *any* non-player thing, so this is the correct flag even for a barrel)
  **and by the dropoff rule** (`world.ts: dropoffRefuses`, docs/monster-ai.md § The dropoff rule),
  because `P_XYMovement` reaches the world through the same `P_TryMove` a monster's walk step does.
  Without that half a hit shoves a body out over a ledge its own AI refuses and the straddled
  opening leaves it standing on air — repro: nosp4.wad MAP02, the spider mastermind on the pedestal
  at (224, 960), sized to its own box. Exempt are the movers vanilla exempts: `MonsterStats.flies`
  (`MF_FLOAT`) and every corpse, which `P_KillMobj` hands `MF_DROPOFF` (`p_inter.c`).
  Unlike the player, a blocked monster or barrel stops dead and drops the remaining velocity rather
  than sliding, matching `P_XYMovement` zeroing `momx`/`momy` for a blocked non-missile, non-player
  mobj. It runs **additively, on top of** whatever AI movement or floor-following already happened
  that frame, matching vanilla's ordering: `P_XYMovement`'s displacement happens before `A_Chase`'s
  walk step within the same tic, so the two genuinely sum. A barrel has no AI movement, so this is
  its only source of horizontal motion. Deliberately skips `blockersFor`'s thing-vs-thing check (a
  knockback nudge is small, transient and rare enough that two shoved bodies briefly overlapping
  isn't worth the query). **A corpse integrates it too**, which is `P_XYMovement` still running for
  a dead mobj: a monster killed mid-knockback slides to a stop rather than freezing where it died,
  and a corpse that falls onto a conveyor rides it (§ World forces). It arrived with the belts —
  before them nothing could move a dead thing, so the velocity was left as inert unread data and the
  difference was invisible. `reviveCorpse` still zeroes it, the same "stale velocity could sit
  unused and then jump on revival" bug the arch-vile resurrection fix already caught for `velZ`.
- **`Player.applyKnockback`** is kept entirely separate from the player's own `velX`/`velY`
  (input-driven, an exponential approach toward a *target* velocity) rather than added into them:
  folding an impulse into that model would have it absorbed or fought by whatever the player is
  pressing within a frame or two, which isn't how vanilla's momentum-based movement behaves.
  `momX`/`momY` get their own `slideMove` call and their own `FRICTION` decay, run as an
  additional displacement right after the ordinary movement block — still sliding along walls rather
  than stopping dead, since the player is the one thing in vanilla that always gets `P_SlideMove`
  regardless of what set its momentum in motion.

### Friction

Boom's linedef 223 gives a sector a friction other than vanilla's 0.90625 — ice or mud. The scan
and the per-sector arrays are docs/specials-forces.md § Friction; what reaches *movement* is
`FrictionEffect`, three numbers `specials/forces.ts: frictionUnder` hands `Player.update` for
whatever floor the player is standing on. On any floor with no 223 line it is `NO_FRICTION`,
`{0.90625, 1, 1}` — one declaration in `specials/defs.ts` serving as both `frictionUnder`'s
no-op return and `Player.update`'s default, so "every existing map moves bit-identically to before
the system existed" is an identity rather than two literals kept in step.

The awkward part is that this engine's input model is **not** vanilla's. Vanilla thrusts
`forwardmove × movefactor` into momentum every tic and lets friction decay it, settling at
`thrust/(1 − f)`; `Player.update` instead approaches a target velocity exponentially
(`ACCELERATION`), and that target *is* its terminal speed. So the two things a friction sector
changes are mapped onto the two knobs that mean the same things:

- **`targetScale`** is the ratio of the two vanilla terminal speeds — this sector's
  `movefactor/(1 − friction)` over a normal floor's `2048/(1 − 0.90625)`. Applied to the target
  velocity, it reproduces exactly how much faster or slower the sector lets you end up going.
- **`accelScale`** is `ln(friction)/ln(0.90625)`. A per-tic decay of `f` is a continuous rate of
  `−ln(f)·35`, so this is that rate over the normal floor's, and it makes the *ramp* as long as
  vanilla's is on that surface. Ice is the whole point of this one: `~0.28×` the approach rate,
  which is what "slippery" actually feels like.
- **`friction`** itself is the external momentum channel's per-tic decay, so a knockback or a
  conveyor slides much further across ice.

All three come off a friction **bounded by vanilla's own `MAXMOVE`** (`p_local.h`, 30 units/tic —
what `P_XYMovement` clamps momentum to however slippery the floor is), expressed as the 1.8× of a
normal floor's run terminal that `targetScale` may not exceed. Without it a 223 line long enough for
MBF's clamp to pin `friction` at exactly 1 gives `targetScale = ∞` and `accelScale = 0`, whose
product is `NaN` — and since `velX` is integrated in place, that NaN is permanent: the player
freezes for the rest of the level, not just on the ice. Perfect ice is *fast*, not immovable. The
bound binds only inside that clamped region (a control line over about 199 units); every ordinary
ice and mud line reaches `Player.update` with its own curve value untouched. Repro: `mbfedit!.wad`
MAP01 sectors 121 and 154.

Sector 123 of that same map is the other extreme and is **not** a bug: an 8-unit control line is
deep mud, `movefactor` falls out negative and MBF's clamp lifts it to 32, which leaves a terminal
speed of about 4 units/sec. MBF crawls there too.

Worked out for the two ends of the dial: an icy sector (friction 0.973, movefactor 631) gives a 5%
higher top speed reached 3.5× more slowly; a muddy one (friction 0.875, movefactor 95, boosted)
gives 28% of the speed, reached faster. Mud's boost is vanilla's own `P_GetMoveFactor` step function
— `movefactor` doubles, quadruples, then octuples as momentum passes 8, 16 and 32 units/sec, "you
start off slowly, then increase as you get better footing". Those thresholds are so low against
walking speed (250-500) that anything actually moving sits in the top step.

**Only the player is affected.** Monster walking is direct AI displacement, and it is in vanilla too
(`A_Chase` moves by `P_TryMove`, never through momentum), so friction correctly does not slow a
monster down — it only changes how far a monster's *knockback* slides.

The alternative considered and rejected was replacing the exponential model with a true vanilla
momentum channel. It would match vanilla everywhere rather than only at the terminal speed, but it
changes the base feel of the whole game (a ramp rate of ~3.44/s against the tuned 12/s), which is a
much larger change than Boom compatibility asks for.

### World forces

`Player.applyForce` and the `carry` callback `ThingLayer.update` takes push onto that same channel,
once per tic, from `specials/forces.ts`. Sustained against the channel's own friction decay this
lands on vanilla's exact equilibrium — an impulse `a` per tic against a per-tic multiplier `f`
settles at `v* = a·f/(1−f)`, which is what `T_Scroll` produces too — and it is *exact* rather than
approximate only because the simulation runs a fixed tic (docs/frameloop.md § What runs in a tic).

Two details that are not shared with knockback:

- **The stop-speed snap is suspended while a force is feeding the channel.** A slow belt's
  equilibrium can sit under `MOMENTUM_STOP_SPEED` (1 u/s), and snapping to zero every tic would
  stall it outright instead of letting it creep. `Player.forced` is that one-tic flag; a knockback,
  which nothing sustains, still ends exactly as it always did.
- **Monsters are carried but not slowed.** A conveyor moves any non-flying body standing on it —
  monsters, barrels, decorations and corpses alike, since `P_KillMobj` strips `MF_NOGRAVITY` from
  what it kills — because `sc_carry` moves every mobj in the sector, and a thing it carries fires
  walk lines exactly as a monster's own step does (docs/specials-forces.md § Scrollers and
  conveyors). Monster *walking* is unaffected by sector friction — that is vanilla too, since
  `A_Chase` moves by `P_TryMove` rather than by momentum.

**`PlayerSnapshot` still names the pair `knockVelX`/`knockVelY`.** That is the saved wire format
from before the channel widened past knockback, and renaming it would orphan every existing save
(docs/savegames.md § The format and its version); `Player.snapshot`/`restore` map the two names.

### Pinned-body memo

A belt-heavy Boom map pins whole closets of bodies against walls forever: a conveyor feeds the same
impulse every tic, the blocked body re-attempts the same move, and the move fails the same way. On
literalism.wad MAP18 (466 voodoo dolls, ~2,000 things standing on 756 conveyor sectors) that
re-derivation — `slideMove`/`positionBlocked` plus `groundFloor` per body per tic — measured ~8 ms
per tic before anything else ran. Two structures make it cheap, both derived state that is never
saved:

- **`SectorTouchCache`** (`World.sectorsTouchingCached`): a body's touched-sector list is a pure
  function of (x, y, radius) over *static* line geometry — heights play no part — so it stays valid
  until the body moves. Every per-tic force query (`carryForBody`, `pushForBody`, `frictionUnder`)
  takes the calling body's own cache instead of a shared scratch array; sharing one across bodies
  re-derives the list every call and silently loses the whole point. The floor/water gates inside
  those queries still read live heights every call, so a lift or rising water under a stationary
  body changes the answer with no invalidation step.
- **The pinned memo** (`VoodooDolls.update`'s `rest`, `ThingLayer.applyKnockback`'s `pinned` — both
  a shared `PinnedMemo` driven by `World.capturePin`/`pinMatches`, allocated once per body and
  refilled in place): once a tic proves itself a no-op — same position, same impulse, blocked
  outcome, nothing crossed — the body records a `HeightsStamp` (`World.captureHeights`) of every
  sector adjacent to a line within its query box (body radius + attempted step + slop) and skips the
  whole re-derivation while the stamp still matches. The invariant that makes this sound: a blocked
  move's outcome can only change if a sector height inside that box changes, because line geometry
  is static and neither `slideMove` nor `positionBlocked` reads anything else. The impulse itself is
  still recomputed live each tic (through the touch cache, so it is cheap), which is what breaks the
  memo when a belt's rate changes or water rises over the body — those flow through the impulse
  compare, not the stamp. A voodoo doll's memo is additionally never captured on a tic whose
  crossing teleported it: a teleporter loop that lands a doll back exactly where it started is a
  periodic-script idiom whose triggers must keep firing.

Neither memo covers a body that is actually moving — a rider on an open belt pays full cost, which
is correct: it is genuinely simulating. Dolls' caches are dropped on `restore`; a `PosedThing`'s
live in fields the savegame's explicit `ThingState` never copies.
