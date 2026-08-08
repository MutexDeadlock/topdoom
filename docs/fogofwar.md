# Fog of war

`src/game/fogofwar.ts`, `src/render/occlusion.ts`, `src/render/mapmesh.ts`

The dollhouse camera can see the entire level at once, including rooms the player hasn't reached and
secrets a wide top-down view would spoil. `FogOfWar` reveals a region once the player has line of
sight to it, tested with a straight 2D raycast (reusing the segment-intersection primitive
`WallFader` uses for its camera-player sightline, factored out to `util/geom.ts`) against the
sight-blocking lines near the player.

**State is per subsector, not per sector**, and that distinction is load-bearing. A DOOM sector is a
logical grouping, not a place: one sector number routinely covers scattered, disconnected chunks of a
map, and even a connected one can be enormous. DOOM2 MAP02's inner water ring is a single sector
spanning 21 subsectors and 18% of the map's floor area — keyed per sector, glimpsing any one corner
of it lit the whole ring at spawn (measured: it nearly halved how much of MAP02 was revealed before
the player had moved). Subsectors are the BSP's convex leaves, i.e. actual places, so they reveal one
at a time.

**Sight blocking is `World.blocksSight`, deliberately not `isSolidWall`** — the movement predicate is
wrong for sight in *both* directions:

- A **closed door** is a two-sided line whose sectors leave no vertical gap (the door sector's ceiling
  winched down to its floor). Vanilla never flags those `BLOCKING` — it can't, they must become
  passable when the door opens — so `isSolidWall` calls them passable and sight sails through into the
  room beyond. All 24 of MAP01's openingless two-sided lines are unflagged, which is exactly why the
  room behind the locked door showed from the corridor.
- A **window or railing** is two-sided *and* `BLOCKING`: it stops a body, not an eye. Treating it as
  sight-blocking would black out a courtyard the player is plainly looking into.

So the test is the vertical opening (`opening.top <= opening.bottom`), which is what `P_CheckSight`
keys off. The blocker set is rebuilt each frame rather than cached at load, because it reads live
sector heights — once doors move, an opening door must stop blocking on the next frame.

**Reveal is sticky on sight**: a subsector once seen stays lit, like DOOM's automap filling in as you
explore. An earlier design kept sight-only reveals transient (fading back to black out of view) and
made just the sectors walked *through* permanent — but at subsector granularity "walked through" is a
one-subsector-wide trail, so a room would go dark behind the player except a thin lit path, and every
camera orbit would flicker subsectors in and out.

**Sight is the only reveal rule — `sector.special === 9` (secret) gets no special case**, and an
earlier version that excluded secrets from sight reveal was wrong. That special means "counts toward
the secret tally when entered", not "hidden from view", and mappers apply it to places in plain sight:
MAP01's secret is the outdoor grass strip you look straight down onto through the big window, with
non-secret water beyond it, so excluding it punched a black hole out of the middle of a view the
player plainly had. What actually hides a secret is geometry, and `blocksSight` already models that:
across DOOM E1M1–E1M8 and DOOM2 MAP01–MAP10, **none of the 197 secret subsectors is visible from the
player start**.

## Reveal radius

**`SIGHT_RADIUS` (5100) is derived from what the camera frames, not tuned by feel**, and it has to
cover the *furthest* thing on screen rather than a comfortable average. With `TopDownCamera`'s
defaults (`tiltDeg` 60, `distance` 480, 55° vertical FOV) the eye sits `cos(60°)·480 = 240` above the
followed point and `sin(60°)·480 = 416` behind it, looking 30° below horizontal; the top edge of the
frustum is then 2.5° below horizontal and meets the floor `240/tan(2.5°) ≈ 5500` units out, i.e.
~5080 past the player. It is a radius rather than a frustum test because the camera yaws freely, so
any direction can become the forward one.

**Anything inside that distance and outside `SIGHT_RADIUS` is a black hole in the middle of a view
the player plainly has** — and it is not only cosmetic: `ThingLayer` gates rendering, `pickMonster`
and `raycastMonster` all on fog alpha, so a monster standing there is invisible, un-lockable *and*
unhittable while it shoots back. The radius was 3000 and a chaingunner 3,584 units down a straight
corridor was exactly that: audible, firing, and impossible to see or shoot. The cost of covering the
real frame is small, because on real geometry it is walls and not the radius that bound reveal —
measured 3000 → 5100 with the player standing at spawn: freedoom2 MAP03 1.98 → 2.23 ms/frame average
(70 subsectors revealed either way), DOOM2 MAP13 0.48 → 0.51 ms (78 → 79), DOOM2 MAP01 and MAP29
unchanged in both time and count.

`SIGHT_RADIUS` is module-private, so `tests/regression/fog-reveal-radius.test.ts` brackets it from both
sides instead: revealed at 5120 units, dark at 5248. Changing what the camera frames means updating
those two numbers, not dropping the test — see docs/testing.md § Private constants.

Each subsector is sampled at its centroid first (one ray settles the common case, and the search stops
at the first sample that comes back clear, so the rest cost nothing usually), then at every corner
*and every edge midpoint*, each pulled slightly inward. **Corners alone leave holes**: a long subsector
seen edge-on through a doorway typically has its centroid and all its corners outside the visible wedge
while its edges cross it — adding edge midpoints roughly halved the count of wrongly-dark subsectors on
every map measured.

Sight blockers are stored **a quarter-unit overlong at both ends**. Where two of them meet at a shared
vertex — a door leaf and its frame — a ray aimed near that point passes just outside the end of both
and neither reports an intersection, so sight squirts through the pinhole into the room beyond
(measured: a sample beside MAP02's closed door cleared the frame corner by 0.1 map units and lit the
room behind it). A quarter unit closes those junctions and stays far under the width of any real
opening; going to a half unit starts clipping sight that legitimately grazes along a wall, for no
further leak closed.

Explored subsectors are skipped forever after, so the per-frame cost falls as a level is explored; the
worst case (nothing explored yet) measures ~0.4 ms on DOOM2 MAP02.

**The sight-sampling sweep is budgeted, not run to completion every frame** — `MAX_SIGHT_TESTS_PER_FRAME`
(200, tuned by feel) caps how many not-yet-explored subsectors get their sample rays tested per `update`
call; `scanCursor` remembers where the round-robin left off so the next frame picks up there rather than
restarting from subsector 0. Without this, cost is `unexplored subsectors × samples per subsector ×
blockers within SIGHT_RADIUS`, and on a level big enough that all three factors are large at once —
freedoom2 MAP03 (315 sectors, 2855 linedefs, 1531 subsectors) — that measured 8.6 ms/frame with the player
standing still at spawn, over half a 60fps budget before rendering even runs. The cap turns the map's
one-time reveal sweep into several frames' worth of work instead of one frame's spike, which is invisible:
reveal already fades in over `FADE_SPEED` seconds, so a subsector's fade starting a few frames later than
strictly necessary reads the same as starting immediately. Measured fix on the same map/scenario: 8.6 ms/
frame → ~2 ms worst-case, ~1 ms average during active exploration. The constructor's one-time spawn seed
(`this.update(10, startX, startY, Infinity)`) passes an unbounded budget deliberately — it has to reveal
everything visible from spawn in that single call, since that's what makes the large `dt` drive the fade
straight to target instead of the surroundings visibly fading up from black on frame one.

## How reveal reaches the geometry

Reveal drives the *same* per-vertex alpha channel the dithered-discard technique already reads (see
the rendering doc) — extended here to flats too (`textures.ts`'s `onBeforeCompile` injection is no
longer wall-only). For walls that means two independent systems write one channel:
**`WallFader.update` only computes its sightline occlusion factor and stops short of touching
geometry; `WallFader.commit` writes the *product* of that factor and the fog alpha** once both are
known for the frame. Flats have no occlusion pass of their own (only walls can stand between camera and
player), so `applyFogToFlats` writes fog alpha directly.

Which subsector a given surface belongs to is resolved differently per surface type, because only some
of them know it natively:

- `FlatSurface` (the `WallOccluder` counterpart for floor/ceiling triangle fans) carries its subsector
  straight from the BSP polygon it was built from.
- Things resolve theirs with `subsectorAt`.
- **Wall quads can't**: they're built per linedef, so `FogOfWar` derives each one itself by nudging the
  quad's midpoint `WALL_PROBE_OFFSET` along its front normal (`mapmesh` builds every quad facing right
  of `a->b`) and asking the BSP what's there — which is why `WallFader.commit` takes a callback keyed
  by *occluder index* rather than by sector, and why `mapmesh.ts` carries no fog-specific field at all.

Thing sprites get the simplest treatment: `ThingLayer.update` takes an optional `fogAlphaOf` and just
toggles visibility, since a monster or item doesn't need a smooth per-pixel fade the way geometry does.
