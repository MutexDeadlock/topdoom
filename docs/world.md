# World queries (`world.ts`)

`src/game/world.ts`

`World` is the level's read side: everything that asks the geometry a question rather than
moving something through it. Collision and the movement queries are docs/movement.md; the shot
queries (`shotPath`, `Range`) are docs/combat.md. This file holds the two that no single
subsystem owns — both are called from combat, AI, fog of war and the specials alike.

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

The origin is fixed at `from.z + PLAYER_HEIGHT * 0.75` (vanilla's own fraction — this engine has no
per-species heights, so both ends reuse the player's) instead of sliding toward `z2`. That eye
height is written inline rather than named as a constant, deliberately: `hasLineOfSight` lives in
`world.ts` for the import-cycle reason noted at its declaration, and a module-level constant derived
from `player.ts`'s `PLAYER_HEIGHT` would be read during that cycle's initialization. The target bound uses the full `[z2, z2 + PLAYER_HEIGHT]` span rather than a
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
target — a demon could bite straight through the drop. `tests/fixtures/wads/pinky_above_test.wad` MAP01
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
  `slideMove`'s corner traces run on it too (docs/movement.md § slideMove) — and need no ordering
  from it, because `PTR_SlideTraverse`'s blocking decision reads nothing but the line itself, so a
  running minimum over the grid's own order finds the same nearest wall a sorted traversal would.
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
megamorphic and costs the early-out — so `checkPosition`, the one collision caller left, deliberately
still uses the plain array-returning `linesNear`. Don't "fix" that without measuring.

**`SELF_HIT_MARGIN`**: a rocket that explodes against a wall sits its own impact point exactly on
that wall, and a raw segment-intersection test then reports the blast blocked by the very wall it
started on (the ray's own origin is a valid crossing at `t≈0`) — so `hasLineOfSight` said "blocked"
in every direction, including straight out into the open room. Splash only ever worked when a shot
connected directly with a monster and never when it hit geometry, which for a free shot is the common
case. The margin skips a crossing within 1 unit of the ray's start, the same "nudge off the geometry
you're standing on" idea as `WALL_OVERLAP`/`BLOCKER_OVERLAP`. Tradeoff: a rocket exploding against a
*closed door* can in principle leak a sliver of splash through, since the door's self-hit is now the
crossing being ignored — accepted as the same order of approximation.

## REJECT

`hasLineOfSight` opens with vanilla's own first test in `P_CheckSight`: the WAD's REJECT matrix
(docs/wad.md § REJECT) carries one bit per ordered sector pair, set when those two sectors can never
see each other, and a set bit returns `false` before any tracing happens. `World.sightRejected` is
that lookup, and it takes **subsector** indices rather than sector ones because vanilla's own
indexing is `t1->subsector->sector` — the subsector is what a thing already knows about itself.

**The bit only ever answers "definitely not".** A clear bit says nothing at all, so this is a pure
early-out: every `true` still comes from the full wall/wedge trace below it, and a map with no usable
table (`DoomMap.reject === undefined`) behaves exactly as it did before REJECT existed. That is also
why a table can't go stale as doors and lifts move: it is computed over the linedefs, which are
static, and it can only *remove* sight the geometry would otherwise have allowed.

An RMB-built table that deliberately blinds monsters in part of a map is therefore honored rather
than worked around — the same gameplay effect vanilla gets from it.

**The subsector hints are load-bearing on the wake sweep.** `hasLineOfSight`'s
`fromSubsector`/`toSubsector` may be `-1` ("look it up"), and looking both up costs two BSP descents
on every *non*-rejected call — a large enough share of a sight check to turn a thin table into a net
loss. The one caller that runs at scale, `ThingLayer.update`'s idle wake sweep, therefore passes
`PosedThing.subsector` (already kept current) and one player subsector resolved once per frame;
`tryWake` threads both through. The occasional callers — splash damage, the arch-vile, the Icon of
Sin, projectile checks — pass `-1` and take the lookup, which their call volume makes irrelevant.
A map with no table returns before either hint is read, so it pays nothing anywhere.

What REJECT is worth is a property of the WAD, not of the engine: a table's density ranges from
all-zero (SCYTHE.WAD, every map) through ~15% of sector pairs (DOOM2.WAD) to ~88% (freedoom2.wad).
`scripts/inspect-wad.ts` reports the loaded map's. Note that it buys least where sight checks cost
most — a huge open arena is one sector, so NUTS.WAD MAP01's 11-sector map rejects nothing.

## Neighbor-height queries

`world.ts`'s `lowestNeighborFloor`/`highestNeighborFloor`/`nextHigherFloor`/`nextLowerFloor`/
`lowestNeighborCeiling`/`highestNeighborCeiling`/`darkestNeighborLight` are vanilla's
`P_FindLowestFloorSurrounding` family — how a mover resolves its target height.

**Each falls back to the sector's own current height only when it has no two-sided neighbors at
all**, never leaving a mover with nowhere to go. The fallback must *not* kick in merely because the
sector's own height is already the most extreme value, which is why these track a `found` flag rather
than seeding the reduction with the sector's own height: a closed door's sector has floor ==
ceiling, so seeding a *lowest* ceiling search with it makes every real neighbor lose, pinning the
door's "open" target at its own closed height instead of the corridor's actual ceiling.
