# Fog of war

`src/game/fogofwar.ts`, `src/render/occlusion.ts` + `occlusion/`, `src/render/mapmesh.ts` +
`mapmesh/`

The dollhouse camera can see the entire level at once, including rooms the player hasn't reached and
secrets a wide top-down view would spoil. `FogOfWar` reveals a region once the player has line of
sight to it, tested with a straight 2D raycast (reusing the segment-intersection primitive
`WallFader` uses for its camera-player sightline, factored out to `util/geom.ts`) against the
sight-blocking lines along that ray.

**State is per subsector, not per sector**, and that distinction is load-bearing. A DOOM sector is a
logical grouping, not a place: one sector number routinely covers scattered, disconnected chunks of
a map, and even a connected one can be enormous. DOOM2 MAP02's inner water ring is a single sector
spanning 21 subsectors and 18% of the map's floor area — keyed per sector, glimpsing any one corner
of it lit the whole ring at spawn (measured: it nearly halved how much of MAP02 was revealed before
the player had moved). Subsectors are the BSP's convex leaves, i.e. actual places, so they reveal
one at a time.

**Sight blocking is `World.blocksSight`, deliberately not `isSolidWall`** — the movement predicate
is wrong for sight in *both* directions:

- A **closed door** is a two-sided line whose sectors leave no vertical gap (the door sector's
  ceiling winched down to its floor). Vanilla never flags those `BLOCKING` — it can't, they must
  become passable when the door opens — so `isSolidWall` calls them passable and sight sails through
  into the room beyond. All 24 of MAP01's openingless two-sided lines are unflagged, which is
  exactly why the room behind the locked door showed from the corridor.
- A **window or railing** is two-sided *and* `BLOCKING`: it stops a body, not an eye. Treating it as
  sight-blocking would black out a courtyard the player is plainly looking into.
- A **ledge** the player could never see past at eye level is still on screen, because the eye that
  matters here is the *camera's*, hanging `TopDownCamera.distance` up and behind. So `blocksSight`
  stays height-blind on purpose, and the height-aware sibling the auto camera's probe uses
  (`blocksProbe`, docs/camera.md § Auto camera) is deliberately not it — reveal short of the frame
  is the gameplay bug § Reveal radius describes, and a raised step is exactly where it would open.

So the test is the vertical opening (`opening.top <= opening.bottom`), which is what `P_CheckSight`
keys off. Whether a line blocks is asked live rather than cached at load, because it reads current
sector heights — once doors move, an opening door must stop blocking on the next tic (§ Sight
testing covers what *is* precomputed, and how often the live answer is asked).

**Reveal is sticky on sight**: a subsector once seen stays lit, like DOOM's automap filling in as
you explore. An earlier design kept sight-only reveals transient (fading back to black out of view)
and made just the sectors walked *through* permanent — but at subsector granularity "walked through"
is a one-subsector-wide trail, so a room would go dark behind the player except a thin lit path, and
every camera orbit would flicker subsectors in and out.

**Sight is the only reveal rule — `sector.special === 9` (secret) gets no special case**, and an
earlier version that excluded secrets from sight reveal was wrong. That special means "counts toward
the secret tally when entered", not "hidden from view", and mappers apply it to places in plain
sight: MAP01's secret is the outdoor grass strip you look straight down onto through the big window,
with non-secret water beyond it, so excluding it punched a black hole out of the middle of a view
the player plainly had. What actually hides a secret is geometry, and `blocksSight` already models
that: across DOOM E1M1–E1M8 and DOOM2 MAP01–MAP10, **none of the 197 secret subsectors is visible
from the player start**.

## Reveal radius

**The reveal reaches `constants.ts: VIEW_DISTANCE`, and `fogofwar.ts` reads that dial directly
rather than keeping a radius of its own.** The fog exists
only to keep the whole map off the screen at once; it is not a second, shorter limit on what the
player may engage. So the reveal reaches exactly as far as the view does, and **both directions are
gameplay bugs**:

- **Reveal short of the view** puts a black hole in the middle of a view the player plainly has, and
  it is not cosmetic: `ThingLayer` gates rendering, `pickMonster` and `raycastMonster` all on fog
  alpha, so a monster standing there is invisible, un-lockable *and* unhittable while it shoots
  back. The reported case: the radius was 3000 and a chaingunner 3,584 units down a straight
  corridor was exactly that — audible, firing, and impossible to see or shoot
  (`tests/fixtures/wads/long_corridor_with_chaingunner.wad`).
- **Reveal past the view** permanently lights map the player never actually saw — reveal is sticky —
  which is the one thing the fog is there to prevent.

It is a radius rather than a frustum test because the camera yaws (`Q`/`E`, and the reorient on
spawn/teleport), so any direction can become the forward one.

**The tie holds only while the fog is what bounds the view, i.e. up to about 5100 units.** With
`TopDownCamera`'s defaults (`tiltDeg` 60, `distance` 480, 55° vertical FOV) the eye sits
`cos(60°)·480 = 240` above the followed point and `sin(60°)·480 = 416` behind it, looking 30° below
horizontal; the top edge of the frustum is then 2.5° below horizontal and meets the floor
`240/tan(2.5°) ≈ 5500` units out, i.e. ~5080 past the player. Below that, the fog goes opaque before
the frame runs out and `VIEW_DISTANCE` is the honest answer to "what can the player see". Raise the
dial past it and the *frame* becomes the binding limit, so reveal would start running ahead of what
is on screen — that is the point at which this identity needs revisiting, and a reveal bound of its
own is what revisiting it would mean. (The frame figure assumes flat ground: looking down a drop of
`h` reaches `(240 + h)/tan(2.5°)` from the eye, so a vantage over a drop frames further still —
measured across four map sets in docs/render.md § View distance.)

**The auto camera moves the framing inside that ceiling, not past it** (docs/camera.md § Auto
camera). At its wide end (tilt 70°, distance 720) the eye sits `cos(70°)·720 ≈ 246` up looking 20°
below horizontal, so the top frustum edge points `27.5° − 20° = 7.5°` *above* horizontal and never
meets the floor — the fog stays the binding limit and the identity holds exactly. At the narrow
end (50°/350) the frame binds around `225/tan(12.5°) ≈ 1010` units — well short of the fog, but
that is the shut-in case where walls bound reveal long before either does, the same accepted,
measured-harmless direction as the flat-ground gap above.

**Monsters are not bounded by any of this.** Vanilla gives `P_CheckSight` no range cap, a monster
hitscan reaches `WEAPON_RANGE` (2048, vanilla's `MISSILERANGE`) and a missile once fired is
unbounded — so with `VIEW_DISTANCE` set below 2048, a hitscanner can wake and hit the player from
outside the revealed view. That asymmetry is the cost of a short view distance, not a fog bug.

Reveal cost barely moves with the radius, because on real geometry it is walls and not the radius
that bound reveal: measured across DOOM2 MAP01/MAP15/MAP29, E1M1, SCYTHE MAP01/MAP26, EPIC MAP01 and
freedoom2 MAP16, raising 5100 → 12000 changed the spawn seed sweep by under 0.5 ms and the count of
subsectors revealed at spawn **not at all** on any of them; only NUTS.WAD MAP01, wide open with a
vantage over a drop, moved (8 → 21).

The reveal distance is not readable from outside, so `tests/regression/fog-reveal-radius.test.ts`
brackets it from both sides — against `VIEW_DISTANCE` rather than literals, since the reveal
tracking the dial *is* the rule: a cell inside the view must be revealed, a cell past it must be
dark. It holds wherever the dial is set; see docs/testing.md § Feel dials are read, never pinned.

## Sight testing

Each subsector is sampled at its centroid first (one ray settles the common case, and the search
stops at the first sample that comes back clear, so the rest cost nothing usually), then at every
corner *and every edge midpoint*, each pulled slightly inward. **Corners alone leave holes**: a long
subsector seen edge-on through a doorway typically has its centroid and all its corners outside the
visible wedge while its edges cross it — adding edge midpoints roughly halved the count of
wrongly-dark subsectors on every map measured.

**A sample ray tests only the lines in the grid cells it crosses**
(`World.forEachLineAlongSegment`), which is the same query `hasLineOfSight` uses and for the same
reason — docs/world.md § hasLineOfSight. The sweep used to keep a flat list of every sight blocker
within `VIEW_DISTANCE`, rebuilt each tic and rescanned per ray; with the dial where it is that list
is *every line on the map*, so one tic cost `rays × all lines` (EPIC.WAD MAP02, arriving in sector 6
with the level unexplored: 2377 blockers rescanned by ~3000 rays, 4.8 ms in a single tic — the
reported case). The walk stops at the first cell that blocks, which is usually one of the first few,
and the same tic costs ~0.55 ms.

What is *live* about a blocker is only whether it blocks: its endpoints are the linedef's own
vertexes, which never move, so they come from `World.lineOverlapEnds` — the one table of
overlap-extended endpoints every ray-vs-wall test in the engine shares (docs/combat.md § What a shot
hits uses it too) — rather than being rebuilt per tic. `World.blocksSight` does read current sector
heights, so an opening door stops blocking on the next tic, and it is **memoized per tic per line**
(`blockStamp`): rays revisit the same lines constantly, and dropping the memo costs 0.70 → 1.15–1.37
ms mean per tic across EPIC MAP02/04/05. A per-ray bounding-box reject used to sit in front of that
test and was removed for the opposite reason — it measured as noise once the cell walk was doing the
filtering.

Sight blockers are stored **a quarter-unit overlong at both ends**. Where two of them meet at a
shared vertex — a door leaf and its frame — a ray aimed near that point passes just outside the end
of both and neither reports an intersection, so sight squirts through the pinhole into the room
beyond (measured: a sample beside MAP02's closed door cleared the frame corner by 0.1 map units and
lit the room behind it). A quarter unit closes those junctions and stays far under the width of any
real opening; going to a half unit starts clipping sight that legitimately grazes along a wall, for
no further leak closed.

**The overhang is not visible to the cell walk, and that residual is accepted.** A line is bucketed
into the cells its own bounding box covers, so an intersection that falls in the quarter unit *past*
a vertex is missed whenever that vertex sits exactly on a cell boundary and the ray never enters the
cell the line was bucketed into — DOOM's integer vertexes on a 128-unit grid make the coincidence
rare rather than impossible, and every missed blocker measured had an endpoint sitting exactly
there. Measured against the exhaustive scan over whole WAD sets (spawn-seeded reveal from up to 200
positions per map, ~1.5M subsector decisions on EPIC alone): 0 subsectors revealed early on DOOM,
DOOM2 and NUTS, 1 on freedoom2, 2 on Hadron, 3 on SCYTHE, 13 on EPIC — against the 24 the
*exhaustive* per-tic blocker list got wrong in the other direction on EPIC, where two maps are
larger than `VIEW_DISTANCE` and its player-centred box quietly dropped the blockers past it.
Inflating the linedef grid's own buckets to cover the overhang closes the residual and **must not be
done**: `specials.ts: crossLines` filters walk triggers through `linesNear`, so widening the buckets
makes a lift's stop line fire its neighbour too (`tests/game/perpetual-lifts.test.ts`).

Explored subsectors are skipped forever after, so the per-frame cost falls as a level is explored.

**The sight-sampling sweep is budgeted, not run to completion**, under two caps that a `tick` stops
at whichever it reaches first. `MAX_SIGHT_TESTS_PER_TIC` (350, tuned by feel) caps how many
not-yet-explored subsectors get their sample rays tested; `scanCursor` remembers where the
round-robin left off — over the nearest-first `order`, § Sweep order — and a subsector that fails
every sample is simply retried on a later pass.
Without a cap, cost is `unexplored subsectors × samples per subsector × the cost of a ray`, and on a
level where all three are large at once — freedoom2 MAP03 (315 sectors, 2855 linedefs, 1531
subsectors) — the one-time reveal sweep measured 8.6 ms in a single call, over half a 60fps budget
before rendering even runs.

`MAX_SIGHT_WORK_PER_TIC` (150000, tuned by feel) caps the same sweep in the units that actually cost
time, because **a subsector count bounds the wrong quantity**: a ray costs the grid cells it steps
through plus the lines it tests in them, and either half can dominate on its own — EPIC.WAD MAP04's
rays test ~320 lines each, MAP05's cross a 23000-unit map. Under the subsector cap alone those two
still spent 3–6 ms in a single tic.

The figure charged is **`forEachLineAlongSegment`'s own count of what the walk did**, not an
estimate derived from the cell size: the grid's spacing is `World`'s business, and a fog-side
constant restating it would mis-charge silently if it ever changed. `sightClear` subtracts what each
ray reports, so the visitor stays a pure predicate. Over ~40 arrival positions per map on EPIC
MAP01–05 the p99 tic falls from 2.9–17.7 ms to 1.0–1.8 ms and the mean from 1.4–7.1 ms to 0.5–0.8
ms, while reveal latency after arriving somewhere new stays where the subsector cap had it (MAP02:
12.7 → 15.6 tics on average, i.e. under half a second). An ordinary level never reaches the work cap
— DOOM2 MAP01 measures the same 0.16 ms/tic either way.

Both budgets are counted **per tic, not per frame**, forced by the split below: `explored` is a
gameplay input, so a per-frame budget would make what is revealed — and so what is shootable —
depend on framerate. Spreading a sweep over several tics is invisible, because reveal already fades
in over `FADE_SPEED` seconds. Both are parameters of the private `sweep` that `tick` delegates to,
so the constructor's one-time spawn seed can ask for an unbounded pass on both by name rather than
by passing `Infinity` for one and having the other infer it: the seed has to reveal everything
visible from spawn in that single call, and the `alpha.set(explored)` right after skips the fade so
the surroundings don't rise out of black on frame one.

## Sweep order

**The budgeted sweep visits candidates nearest the player first** (`order`, `buildOrder`), and on a
large level that ordering matters more than either budget. Under the plain BSP-index round-robin
this started as, `scanCursor` walks the subsector array in an order with no relation to where the
player is, so a tic's whole budget goes on whatever indices the cursor happens to be sitting on.

That is fine while the level is small enough for one pass to fit in a tic or two, and it collapses
when it isn't. Comatose MAP01 (55,029 subsectors, 65,535 linedefs, a 35,982-unit span) is the
reported case: 30,728 of its subsectors sit within `VIEW_DISTANCE` of a typical vantage, only 9,778
of them are actually sight-clear, and the rays to the rest run the median 12,748 units to the far
side of the map at ~344 work each. One full pass is 202,914 rays and 49.9M work — **333 tics, 9.5
seconds** at `MAX_SIGHT_WORK_PER_TIC`. `MAX_SIGHT_TESTS_PER_TIC` never binds there at all: the work
cap trips after 40–56 subsectors, so the cursor needs ~1,200 tics to come round. Measured from six
vantages, everything sight-clear within the ~5,100 units the camera actually frames took **3.0–16.3
s (mean 8.4)** to light up. Ordering the same candidates nearest-first, with the same budgets, the
same radius and the same rays, brings that to **0.06–0.66 s (mean 0.31)** — the budget buys reveals
instead of misses, because near subsectors have both short rays and a ~99% hit rate. Stock maps do
not move (DOOM2 MAP01 and MAP15 are inside two tics either way).

**The cursor is still needed, and pure nearest-first starves.** Restarting from the near end every
tic and dropping `scanCursor` sounds simpler and reveals only 1,421 of the 9,778: the near band
soaks the budget and the sweep never reaches anything behind it. So `scanCursor` advances through
`order` as before and wraps at `orderCount`; what changed is only the sequence it walks.

**`order` is rebuilt when the player drifts `ORDER_ANCHOR_SLACK` from the point it was built for**,
and the rebuild restarts the cursor at the near end — the player being somewhere new is exactly
when what is around them should be tested first. It is a **counting sort into `ORDER_RING`-wide
rings**, not a comparison sort: at this cadence `Array.sort` over 55,029 entries costs 11.6 ms, more
than the sweep it is ordering, while two linear passes cost a fraction of that. Entries are keyed on
`distance - radius`, the subsector's nearest possible approach, which is the same quantity `sweep`'s
own reject tests — so the cutoff that decides what enters `order` and the test that runs per
candidate agree rather than drifting apart. The cutoff carries `ORDER_ANCHOR_SLACK` on top of
`VIEW_DISTANCE` so a subsector that comes into range during the drift is already in the array; the
per-candidate reject inside `sweep` stays, since it is the one that answers for the live position.

**A front-to-back BSP descent from the player's subsector is the other obvious candidate**, and it
is not free here: `nodes.ts` discards both child bounding boxes at parse time in every node format
(`skip both bounding boxes`, three sites), so a radius-culled descent needs them parsed and kept
first; split-plane order is coarser than distance rings anyway; and a cursor that resumes mid-
traversal across tics needs either an explicit node stack or a materialized array — which is the
array `buildOrder` already builds.

Two things this deliberately does **not** fix. A pass still costs what it costs — everything visible
from a vantage on Comatose still takes ~9.5 s to finish revealing — and the far tail of that is
geometry the camera's frame does not reach anyway (§ Reveal radius). And a door opening while the
player stands perfectly still, with the cursor already deep in a pass, still waits for the wrap: no
worse than before, but not better either. Both are bounded by the same underlying quantity, which is
that `VIEW_DISTANCE` admits 56% of this map as candidates — the sweep is spending its budget well
now, not spending less of it.

## Closed sectors

**A subsector whose sector is permanently solid waives that sector's own lines as blockers** while
it is being sampled (`closedTarget`, `bordersTarget`). Every line bounding a sector with no vertical
opening blocks sight by definition — that is what `blocksSight` tests — so no ray can ever land
inside one, and without the waiver it stays unexplored for the whole level: a permanent **hole** in
the view, its floor fan and anything drawn over it invisible where the geometry plainly is. Seeing a
solid block from outside is all there is to seeing it.

Repro: BOOMEDIT MAP01 sector 121, a closed pillar standing in sector 93's pool. Its `METAL` sides
draw (a wall's probe point lands in the *pool's* subsector, § How reveal reaches the geometry), so
what the player sees is a pale strip with the water missing around its top — reported twice as a
hole in the water, and not fixed by anything done to the water itself. 24 of BOOMEDIT MAP01's 32
closed subsectors were dark this way.

**"No vertical opening" alone is the wrong test, and a sector a mover can drive is excluded however
shut it is now** (`scanSectors`' movable set, the same load-time scan `mapmesh.ts` uses to keep
mover geometry out of the static batch — `game.ts` passes it in rather than paying for it twice). A
shut door, a lift parked flush, a secret closet winched to its floor are all zero-opening, and all
of them are *space the player may yet explore*: waiving their lines lights a room through its own
door. E1M3 sector 51 is the reported case — a 96×512 secret corridor, shut, whose whole length lit
up the moment the player stood in front of the door at its south end, drawing as a structure behind
a wall they could not see past. Every one of E1M3's 20 closed sectors is a door or a closet of that
kind, so the map now reveals none of them early; BOOMEDIT MAP01's genuinely solid pillars keep the
waiver. (The scan is slightly over-inclusive — it also carries sectors whose walls wear switch art —
but a switch on a pillar sits on the *room's* sidedef, so a solid block does not pick one up that
way.)

The waiver is deliberately narrow in two further ways. The opening test is **live**, not load-time:
the tic a mover opens, its sector goes back to being sampled like any other subsector, so a door
reveals what is behind it exactly when the player can see through it. And it waives only the lines
of the sector *being sampled* — the ray still stops at everything else, and only that subsector is
marked, so nothing beyond a solid block is revealed by passing through it. Waiving blockers by
anything coarser than the target's own sector would leak sight through shut doors, which is the
failure the quarter-unit overhang above exists to prevent.

What is deliberately *not* done is to bound the waiver by the target subsector's own linedefs, so a
solid mass split across several subsectors lights only the near one. The BSP splits such a mass on
minisegs, which are not blockers at all, and the camera hangs above: the player looks down on the
whole cap of a block at once, so lighting part of it is the same hole this section exists to close.

## Islands

**Only the region the player is standing in is drawn.** `explored` is ANDed with the island gate
everywhere it is read — `isVisible` and `updateFade`'s target — so a place reachable only through a
teleporter is hidden while the player is somewhere else. The partition is
`bsp.ts: buildIslands`, docs/render.md § Islands.

Reveal is sticky and the camera reaches `VIEW_DISTANCE` in every direction, so without this a
detached region stays lit beside the level once visited. BOOMEDIT MAP01 is the reported case: the
pool room (sectors 92/93, x 768..2048) is a box in the void east of the map, joined to it only by
the tag-50 silent teleports on lines 589/652 — Boom's line-to-line pair, reusing sectors 96 and 100
on both sides so the seam is invisible in play. Coming back up from underwater left sector 92 on
screen next to the level.

**`explored` itself is untouched**, so the savegame format and `SAVE_VERSION` are unaffected: the
gate sits on top of it and the island comes from geometry, which a save does not carry.

**The island being left cuts to black rather than fading out** (`enterIsland` snaps every alpha to
its new target, as the spawn seed does), and whatever is already explored in the one being entered
is lit at once; leaves the sweep reveals after arriving fade in as they always do. Arriving in an
island means a teleport, which the camera cuts for too — docs/specials.md § Silent and line-to-line
teleporters.

**A sample ray that reveals a leaf in another island merges the two** (`mergeIsland`), and that is
the only merge rule. A ray cannot cross a one-sided wall, so reaching one is proof the partition was
wrong. It costs nothing: the sweep already tests every unexplored leaf in range, and an explored one
is never re-tested for this. It is also enough — a wrongly split *connected* region is in sight from
its own boundary, so it merges before the player walks through, and what is left is at worst
geometry going dark that the player has already seen. A merge is not saved: it is rediscovered
while leaves are still unexplored, not after a restore into a fully explored level.

A leaf the BSP clip left degenerate is exempt (`NO_ISLAND`): it draws nothing and has nowhere to be
disconnected from, and a wall probe landing in one must not be pinned invisible.

Two accepted consequences. The **computer area map** reveals the island the player is in, not the
whole level. And a start room left by teleporter goes dark: DOOM2 MAP30's (sector 11, its own island
of 11 leaves) and GoingDown MAP01's start elevator both do, which is the same rule doing the same
job.

## How reveal reaches the geometry

Reveal drives the *same* per-vertex alpha channel the dithered-discard technique already reads (see
the rendering doc) — extended here to flats too (`textures.ts`'s `onBeforeCompile` injection is no
longer wall-only). That means two independent systems write one channel:
**`update` only computes its sightline occlusion factor and stops short of touching geometry;
`commit` writes the *product* of that factor and the fog alpha** once both are known for the frame.
Walls and flats are symmetric here — `FlatFader` runs its own occlusion pass (a raised platform
between camera and player fades the same way a wall does) and `FlatFader.commit` writes the same
product `WallFader.commit` does.

Which subsector a given surface belongs to is resolved differently per surface type, because only
some of them know it natively:

- `FlatSurface` (the `WallOccluder` counterpart for floor/ceiling triangle fans) carries its
  subsector straight from the BSP polygon it was built from.
- Things resolve theirs with `subsectorAt`.
- **Wall quads can't**: they're built from a linedef's own geometry, so `FogOfWar` derives each one
  itself by nudging the quad's midpoint `WALL_PROBE_OFFSET` along its front normal (`mapmesh` builds
  every quad facing right of `a->b`) and asking the BSP what's there — which is why
  `WallFader.commit` takes a callback keyed by *occluder index* rather than by sector, and why
  `mapmesh.ts` carries no fog-specific field at all. A long wall is several occluders, one per chunk
  (docs/render.md § The fade is a hole, not a wall), so each probes its own chunk's midpoint — the
  keying is unchanged, just finer-grained.

### Which walls a reveal moved

`updateFade` damps one alpha per subsector, and `WallFader.commit` needs the quads that alpha
scales. Handing it the whole occluder list means a walk over every quad on the map every frame to
find the handful a reveal actually touched — 408,705 of them on Sunder 2512 MAP20 — so `updateFade`
files the quads it moved instead, and `changedWalls()` hands that list over
(docs/render.md § Nothing per-frame is per-quad).

The index is `wallSubsector` inverted, built once beside it as a prefix-sum table: a changed
subsector names its quads without a search. `changedWalls()` returns **`null` for "all of them"**,
which is not an error path but two real cases — a wholesale alpha write that bypassed the damping
loop (the constructor's spawn seed, `restoreExplored`), and a frame where more quads moved at once
than `CHANGED_WALL_LIMIT` holds (the computer area map's level-wide ramp), where a full pass is
cheaper than a list as long as the map. **Reading it consumes that fallback**, so it belongs in the
one place that commits the walls, once per frame, after `updateFade`.

### Mover wall quads

The static wall quads are probed **once at load** and their subsectors kept in `wallSubsector`.
Mover geometry (doors, lifts — docs/render.md § Mover meshes) is built and rebuilt after that, so it
misses that pass. It does not need its own probe either: `mapmesh/build.ts`'s `fillWallCells` already
resolves every wall quad's leaf for the dynamic lights and records it on `WallOccluder.subsector`,
so `MoverGeometry.updateFading` reads that. `FogOfWar.wallSubsectorAt` stays as the fallback for a
mesh built without a probe (tests, tools), where the quad is left at -1 — and it probes through
`mapmesh.ts`'s own `wallProbePoint`, so the fallback and the build-time pass cannot drift into
disagreeing about which room a quad faces.

The answer is fixed by the quad's endpoints, which are the linedef's own, so a door moving
vertically never invalidates it — which is why `refreshMoverMesh` preserves `subsector` across the
per-tic rewrite rather than re-probing, exactly as it leaves the `aLightCell` attribute alone.
Probing per frame instead costs one BSP descent per mover quad per frame: that holds for a vanilla
map's few dozen, but literalism.wad MAP18 has 973 movable sectors and thousands of such quads, and
the descents dominated the fading pass.

Thing sprites get the simplest treatment: `ThingLayer.update` takes an optional `fogVisible` and
just toggles visibility, since a monster or item doesn't need a smooth per-pixel fade the way
geometry does.

**Transient effects are gated the same way**, on the same flag: each `OneShotEffect` resolves its
subsector at spawn (the vile's following flame re-resolves as it moves) and `SpriteFxLayer.drawList`
**skips** it while that subsector is unexplored — skips, not declines to spawn it, so it keeps
animating and expiring on its own clock and a room revealed mid-animation shows the rest of it
rather than nothing. The case that forced this is the teleport fog: vanilla spawns a puff at *both*
ends of a teleport, so a monster teleporting out of a closet left a lit puff hanging in the black
over a room the player had never seen, announcing the ambush. The *sound* is deliberately not gated
— `telept` still plays at both ends, attenuated by distance like every other cue (docs/audio.md §
Specials); hearing a teleport you can't see is vanilla, seeing it is not. Projectiles and hitscan
tracers are also left ungated on purpose: both are incoming fire, and a missile or tracer coming out
of an unexplored room is the warning that something is shooting from there.

## What gameplay reads

**`explored` is the gameplay gate; `alpha` is only ever drawn.** The two are split because `alpha`
is damped on the render clock (`updateFade`) while `explored` is set by the reveal scan on the tic
clock (`tick`), and `PosedThing.visible` — which decides what can be shot, meleed and auto-aimed at,
not merely what is drawn — must not depend on how many frames a fade has had. `isVisible` is the
accessor gameplay uses; `alphaOf`/`wallAlpha` stay for the faders.

The gate used to be `alphaOf(subsector) > 0.5`. Since `alpha` only ever damps upward toward a
permanent `explored` flag, the behavioural difference is small and one-directional: a monster
becomes shootable the moment its subsector reveals, rather than partway through the fade-in.
