# Dynamic lights

`src/wad/gldefs.ts`, `src/render/lights.ts`, and the patch `src/render/textures.ts` puts in every
map material.

GZDoom's GLDEFS lights, bound to sprite frames: a rocket in flight, a torch, a soulsphere, the
muzzle flash on a firing zombieman. **This follows GZDoom, not vanilla** — vanilla DOOM has no
dynamic lights at all, and every rule below is cited to `gldefs.cpp` or `a_dynlight.cpp` rather
than to `linuxdoom-1.10`. Sector light, which is vanilla's and is what lights everything by
default, is docs/render.md § Sector lighting.

## The frame key

The whole feature hangs off one thing already in the engine: `SpriteAnimator.frameKey`
(`render/sprites.ts`) is the literal `SPRITE + LETTER` a drawn object is showing this frame —
`MISLA`, `TREDB`, `POSSF`. A GLDEFS `object` block binds lights by exactly that:

```
object Rocket { frame MISLA { light ROCKET } }
```

So the class name in an `object` block is **dropped** on load, and the binding is flattened onto
the frame key. Two consequences worth knowing:

- A **4-character** frame name covers every frame of that sprite (`TRED` = the tall red torch in
  all its animation frames); a **5-character** one names a single frame. GZDoom matches the stored
  name exactly against the actor's current frame, which is what makes the shorter one general.
  Exact beats sprite-wide: the stock file's blur sphere relies on it, `PINS` for the sprite with
  `PINSA`..`PINSD` overriding single frames.
- **DEHACKED needs no integration here**, unlike `FULLBRIGHT_FRAMES` (`things/tables.ts`), which is
  derived from `states[]` and so has to be rebuilt when a patch edits them. This table is not
  derived from the state table at all: a patch that re-points states merely changes which frame is
  drawn, and the light follows whatever is drawn — which is GZDoom's own model. A BEX `[SPRITES]`
  rename is transparent too, because `frameKey` carries the *logical* sprite name while the rename
  only changes which lump `SpriteBank` returns for it.

## The grammar

`parseGldefs` reads the four frame-bindable light types and the `object` blocks, and **skips
everything else**: `sectorlight` (which scales with a sector's light level rather than binding to a
frame), `glow`, `brightmap`, `skybox`, `hardwareshader`, and any key inside a light block it does
not know. A PWAD's GLDEFS is written for a renderer with far more features than this one, and must
never keep a level from loading — so an unknown block is skipped by brace depth, an unknown key
drops the numbers that follow it, and a malformed block warns rather than throwing.

| Type | Radius over time |
|---|---|
| `pointlight` | Fixed at `size`. |
| `pulselight` | Sine-cycles between `size` and `secondarySize` over `interval` seconds — GZDoom's `CYCLE_Sin` cycler. |
| `flickerlight` | Per tic, probability `chance` of `size`, else `secondarySize`. A hard switch, not a blend. |
| `flickerlight2` | A random blend of the two sizes, rerolled every `interval` seconds. |

Three parse details are load-bearing:

- **`offset x up y` — the middle argument is the vertical one.** Reading it as `x y z` puts every
  torch flame on the floor and shifts it sideways instead. It is measured up from the thing's
  **feet**, which is what every position in this engine is (`PosedThing.z`, a projectile's `drawZ`,
  an effect's `z`).
- **Block comments must be stripped.** The stock `assets/gldefs.txt` block-comments out its
  `object Spectre` binding; parsing it anyway would light every spectre in the game.
- **`size` is clamped to 1..1024**, GZDoom's own range.

## How far a light carries

A GLDEFS `size` is not the radius: `RADIUS_SCALE` in `render/lights.ts` multiplies it into the
distance the light actually reaches. It is a **feel dial** — the one knob for how far the lights
carry, and the first thing to turn if they read too tight or too washed out. GZDoom's own factor
here is 2 (`ADynamicLight::GetRadius`), which this engine found too broad under a camera that sees
a whole room at once.

Being a dial, it is **exported so the tests size their fixtures from it** rather than mirroring the
number, the same discipline `FADE_RADIUS`/`FADE_CORE` follow (docs/render.md § Wall occlusion
fading). A test that reddens when this is retuned is pinning the dial, and is a bug in the test.

## Flicker without the vanilla random table

GZDoom keeps per-actor cycler state and draws from its own RNG. Here the animation is instead a
pure function of `(emitterId, step)` through `hash01`, for two reasons:

- **The vanilla random table is gameplay entropy, on two global cursors** (docs/random.md § Why the
  cursors are global). Drawing from it to flicker a torch would make what a monster does next
  depend on how many torches were on screen — a rendering setting changing the simulation.
- Being stateless, a light needs nothing carried across a save/load, and nothing that goes stale in
  a frame where its sprite wasn't drawn. **No part of this feature reaches a savegame.**

The per-emitter term is also what keeps two torches in a room from pulsing in lockstep, which is
what GZDoom gets for free from each light starting its cycler when it attaches.

## What emits

Every drawn sprite offers its frame key, at the three places a sprite is drawn:

| Site | Covers |
|---|---|
| `game/things.ts`'s draw loop | Every map thing: torches, lamps, pickups, keys, barrels, and every monster — including the firing frames (`POSSF`, `CPOSE`/`CPOSF`, the arch-vile's `VILEH`..`VILEP`). |
| `game/spritefx.ts: batchSprite` | The single funnel for projectiles in flight, every one-shot effect (puffs, teleport fog, impact explosions, the vile's flame) and the Icon of Sin's cubes. |
| `game.ts: posePlayer` | The player, whose `PLAY F` firing frame is the muzzle flash. |

**Fog of war is inherited for free.** Both batched sites already skip a sprite the player has never
had sight of (`PosedThing.visible`, `SpriteFxLayer.drawList`'s `fogVisible` gate), so an unrevealed
room lights nothing — the gather sits inside those gates rather than beside them.

Emitter IDs come from three disjoint ranges, because the ID is what `dontlightself` and the flicker
phase key off: `PosedThing.id` is a plain array index (0 and up), `SpriteFxLayer` hands out negative
IDs from a `WeakMap` on the animator, and the player has `PLAYER_EMITTER_ID` below both. The effect
IDs live on a `WeakMap` rather than a field precisely so no record shape — and so no snapshot —
changes.

**The range constants live in `render/lights.ts`**, the only module that reads an ID, rather than
in each of the three call sites that mints one — an ID whose meaning is split across three files is
an invariant nothing enforces. `effectEmitterId` wraps at `PLAYER_EMITTER_ID` rather than counting
down forever, so no session is long enough to walk an effect onto the player's ID; the collision
would be silent (a barrel that stops lighting itself, two emitters sharing a flicker phase), which
is why it is closed by construction rather than by the range being large.

## Light stops at walls

A GLDEFS light is a point and a radius, and nothing in that says a wall is in the way. Left at
that, a torch lights the room on the other side of its wall, which is what the first version did.

**The fix is GZDoom's own model, not a shadow test.** GZDoom does not test each surface against the
light; it flood-fills the BSP out of the light's own subsector, crossing into a neighbour only
through something that can be seen through, and attaches the light to the leaves the fill reached
(`ADynamicLight::CollectWithinRadius`, `a_dynlight.cpp`). `render/lightvis.ts` is that fill:

- **The fill starts in the emitter's own leaf** and spreads breadth-first.
- **A boundary is crossed only where `World.blocksSight` lets it be** — the same predicate fog of
  war reveals through, and the same reason it is not `isSolidWall`: a closed door is a two-sided
  line vanilla never flags `BLOCKING`, and a window is a two-sided line that is (docs/fogofwar.md).
  It is asked **live**, so a door opening lets light through on the tic it opens.
- **Subsectors, not sectors**, for the reason fog of war is: a DOOM sector is a grouping, not a
  place, and one routinely covers scattered chunks of a map — at sector granularity a light would
  reach every one of them within its radius, wall or no wall. Subsectors are the BSP's convex
  leaves, and convexity is what makes the fill exact within one: everything in a leaf is visible
  from everywhere in it.

- **The radius bounds the path, not the straight line.** Measured as the crow flies, a light
  spreads round a corner and reappears bright a few units away through the wall it just went round:
  in E1M1's start room a light reaches four leaves and some 600 units of geometry to land 150 units
  from where it began. The fill carries the distance its path has run — each hop measured to the
  nearest point of the edge it crosses, a greedy stand-in for the funnel a true geodesic would walk
  — and stops when that exceeds the radius. *Attenuation* stays straight-line, matching the shader.
  Measured over DOOM E1M1/E1M3/E1M7 and DOOM2 MAP01/MAP15/MAP29, this roughly halves the leaf pairs
  the fill joins with no sightline between them (7.4% → 3.0% on MAP15, 4.8% → 0.8% on MAP01).

**The fill alone is not enough, and the case that proves it is the one this was reported on.**
E1M1's two tall lamps stand in the room east of the start, 8 to 16 units *behind* the wall stubs
that flank its doorway. The fill is right to reach the start room — the doorway is 144 units wide
and wide open — but the falloff is a straight-line distance from the lamp, so the floor immediately
behind those stubs came out as brightly lit as the floor in the doorway. What the room needs is a
shaft of light through the opening, which no per-room answer can give.

So a light is occluded twice: by the leaf fill, per room, and then per pixel by its own shadow map.

### The adjacency graph

Which leaves border which is **built lazily, per leaf, and kept for the level's life**: each edge
costs a BSP descent and a short linedef walk, and lights only ever touch the small part of a map
they stand in — a whole-map pass at load would pay for the rest of it for nothing.

An edge's neighbours are found along the edge pushed `1.5` units out along its outward normal — the
polygon is convex, so "away from the centroid" fixes that direction whatever the winding — the same
offset `mapmesh` uses to resolve a wall quad's leaf. Which linedefs stand between the two is then a
**crossing test from the leaf's own centre out to that probe point**, cached: the geometry is fixed
even though each linedef's blocking answer is not.

**One edge becomes a record per leaf across it, not one record.** A leaf's outline is the BSP
clip's, and its edges are the *partitions* that cut the leaf out — nothing makes one edge stop where
the geometry behind it changes, so a single edge routinely spans a doorway and the wall beside it.
The neighbour is therefore not a point probe but `World.subsectorsAlongSegment` (docs/world.md §
Point-to-sector lookups) walking the offset edge through the BSP, each run of it becoming its own
record with its own sub-edge geometry and its own crossing test. A midpoint probe instead answers
for whichever neighbour that one point lands in and **loses every other**, which is what left a
light standing in DOOM2 MAP01's start room lighting nothing north of it: the room's north edge runs
its full width, the way out is in the western half, and the midpoint sits behind the wall in the
eastern half. Duplicate records for one neighbour cost nothing — the fill marks a leaf seen only
when it actually crosses into it, so a record blocked by a wall leaves a later open one free to
cross. Both ends of that walked segment are pulled in by the same 1.5 units, so a corner probes the
edge's own neighbours rather than a leaf that only touches the polygon at that one point.

**Crossing from the centre, rather than asking which linedef the edge lies on, is the load-bearing
part.** A leaf's outline comes out of the BSP clip, which deliberately spares the clip against a
wall that stops inside the leaf (docs/render.md § Segs on the wrong side of their leaf) — so an
edge can sit well off the wall it was cut against, or run past that wall's end, and matching an
edge to "its" linedef by distance and collinearity misidentifies a wall often enough to leak light
through it. A crossing from the centre answers what the fill actually asks — is anything in the way
— and catches a wall standing *inside* the leaf as well.

An edge past a one-sided wall probes into the void and reads back some unrelated leaf; the wall is
between the two, blocks sight, and the fill never crosses it — so out-of-map points need no special
case (docs/world.md § Point-to-sector lookups).

`MAX_REACH` caps one light's fill at 512 leaves. A radius normally stops it far sooner; the cap is
what bounds the pathological case — a large radius in open geometry — so a single frame cannot walk
the whole BSP.

### Shadows (`castShadows`)

Each committed light gets a **1D shadow map**: `SHADOW_STEPS` angular bins around it, each holding
how far the light gets in that direction before a sight blocker stops it, `radius` where nothing
does. A fragment takes the bin its own direction falls in and is lit only if it is nearer than that.
GZDoom keeps exactly this per light (`hw_shadowmap.cpp`), and it is the natural fit for a camera
that only ever sees the map from above: the world the shadow is cast in is two-dimensional.

- **Blockers are `World.blocksSight` lines within the radius**, the same predicate the fill crosses
  on — so a window casts no shadow, a shut door does, and it stops the tic it opens.
- **Angles are measured in three.js space** (x east, z south), so the shader takes `atan` of the
  world-position varying with no axis flip. Bin 0 is due west and bin `SHADOW_STEPS/2` due east;
  `castShadows`, the shader and `DynamicLights.unshadowed` all index with `angle / 2π + 0.5`, and
  a version that wrote bins on one convention and read them on the other was half a turn out —
  which on symmetric geometry still looks plausible, so `tests/render/lightvis.test.ts` pins the
  direction of a known wall rather than only its distance.
- **`SHADOW_BIAS` is why a lit wall does not shadow itself.** The wall casting the shadow sits at
  exactly the blocker distance, so a fragment is lit out to `blocker + BIAS`. That bias must stay
  under the thinnest wall a map draws, or the *far* side of that wall lights up too.
- The lookup is behind the falloff test in the shader, so only fragments a light actually reaches
  pay for the `atan` and the fetch.

What this deliberately does **not** model is occlusion by anything but map geometry, or in the
vertical: a monster standing in front of a torch throws no shadow, and neither does a chest-high
step, because `blocksSight` is height-blind by design (docs/fogofwar.md). Both are GZDoom's
behaviour too.

### Soft edges

A shadow read as one bin against one distance has a razor edge — a straight cut across the floor at
the blocker's corner, on a light with no such hardness anywhere else in it. Both readers instead
take the **lit fraction of the arc `[bin - SHADOW_SOFT_BINS, bin + SHADOW_SOFT_BINS]`**: each bin
the interval touches weighs however much of it that bin covers, and contributes that weight where
the fragment clears its blocker.

- **The weights are what make it smooth, not the tap count.** A plain average of N taps steps by
  `1/N` as each tap crosses the boundary, which bands. A coverage weight slides continuously as the
  interval moves inside a bin, so the ramp is continuous across the whole penumbra with four taps.
- **The kernel is angular, so the penumbra widens with distance from the light** — which is the way
  a real one behaves, and free here: a bin is a fixed angle, and its arc grows with the radius.
  `SHADOW_SOFT_BINS` is the dial (docs/lights.md is the argument; the declaration in `lights.ts`
  carries the arithmetic), and `SHADOW_TAPS` follows from it rather than being tuned beside it.
- **The taps wrap around the row rather than clamping to its ends**, unlike the single lookup they
  replace: an interval straddling bin 0 — due west — otherwise reads that end of the row twice and
  hardens the shadow along one exact direction.
- Both halves must agree, so `DynamicLights.unshadowed` runs the same kernel on the CPU and returns
  a fraction rather than a yes/no: a sprite crossing a shadow's edge dims with the floor under it
  instead of switching.

The cost is four `texelFetch`es where there was one, paid only by fragments a light actually
reaches — the falloff test still gates the whole lookup.

### How the answer reaches a fragment

Per frame, `commit` appends each committed light's index to the reached leaves' **compacted light
lists, indexed by subsector**: one `RGBA32UI` texel per leaf holding up to `MAX_LIGHTS_PER_LEAF`
(16) byte-sized slots, `0xFF` past the last, uploaded as an integer texture read with `texelFetch`.
Every map surface carries the leaf it faces into as the `aLightCell` vertex attribute, and the
fragment loop walks **only that leaf's list**, stopping at the first empty slot.

**A list, not a bitmask, because the list is what bounds the fragment loop.** The first version
stored one bit per light and looped over the whole committed set testing bits, which priced every
fragment by how many lights were *committed* rather than how many reach it — and a light-saturated
map holds the committed set at the cap while no leaf is reached by more than a handful. On Sunder
2512 MAP05's opening arena (64 committed, no leaf reached by more than 8, the median 1), the
64-iteration walk took a 1080p frame from 58 fps to 23 on an integrated GPU; the same scene walks
the lists at 48. Notably the cost was *not* the loop body executing — gating the shadow lookup
behind a runtime-false uniform compare measured the same 28 ms as running it, so it is the
compiled body's register pressure that every iteration pays, executed or not — which is why no
cheaper per-light test inside a committed-set loop can fix it: the iterations themselves have to go.

A leaf past its 16 slots drops the excess lights there. By that depth the additive sum has clamped
to white, so the dropped light is invisible in that leaf; and on the frames that overflow
`MAX_DYN_LIGHTS`, commit order is nearest-first, so a full leaf drops its least relevant lights.

**That fetch happens in the vertex shader, not the fragment shader**, and is handed on as a
`flat varying uvec4`. Every vertex of a wall quad or a flat's fan carries the same leaf, so the
list is constant across the primitive and `flat` carries it exactly — while the fetch itself drops
from once per drawn pixel to once per vertex. It is the single largest cost this feature had: a
dependent integer texture read on every fragment of every map surface, paid whether or not a light
was anywhere near it. On EPIC.WAD MAP02 at a 14.7 MP drawing buffer, with **one** light committed,
that fetch alone was 3.4 ms of the 5.1 ms the lighting cost; moving it to the vertex stage cut the
whole feature's per-frame cost by 2.8x on that map and on E1M1 alike.

The obvious alternative — keeping the fetch per fragment but skipping it with a cheap bounding test
— was measured and is **worse**. A branch whose condition varies per fragment costs a GPU more than
it saves unless it rejects nearly all of them: a sphere around the committed set won 28% on MAP02,
where one light leaves most of the screen outside it, and lost 56% on E1M1, where lights are spread
across the view and it rejects nothing. The outer `uLightCount > 0` guard is deliberately the only
branch here, because that one is uniform across every fragment in the draw.

Four more things are load-bearing:

- **Walls take the leaf their *face* looks into, not the one they are in.** `mapmesh`'s
  `fillWallCells` probes each quad's midpoint along its front normal — every quad is built facing
  right of `a->b` — which is the same quantity fog of war needs, so `WallOccluder.subsector` now
  carries it and `FogOfWar` reads it instead of repeating the descent.
- **The attribute is written once and never rewritten.** A mover changes sector heights, never a
  quad's footprint, so `refreshMoverMesh` leaves `aLightCell` alone.
- **Clearing walks the lit leaves, not the level.** `commit` remembers which leaves it wrote and
  zeroes only those next frame, and skips the upload entirely on a frame that touched none — which
  is every frame with the lights off, or with none on screen.
- **`uLightVisWidth` of 0 means no level is bound.** A bank built without a level (tests, tools)
  keeps `tintAt` ungated — an unbound controller tints sprites by every committed light — while
  geometry draws no dynamic light at all: there is no leaf list to walk, and in practice geometry
  only ever renders in a bound level (`bindLevel` runs on map load, before the first frame). An
  unprobed quad (`aLightCell` -1) reads the same way: the vertex stage's all-ones default is the
  empty list, so it stays unlit rather than lit by everything.

**Sprites are gated the same way**, on the CPU in `tintAt`: it walks the leaf's slot list, using
the sprite's own leaf — `PosedThing.subsector` and `OneShotEffect.subsector` already carry one, and
the few callers that don't resolve it there, but only once some light is actually live — and then
tests the same shadow map, so a sprite behind a pillar goes dark with the floor it stands on.

The shadow map rides in a second texture, one `R32F` row per light, uploaded whole on any frame that
has lights.

## Two lighting paths

**Map geometry is lit per pixel.** `MaterialBank` patches every material it builds
(`render/textures.ts`) with a fragment loop over a uniform array of at most `MAX_DYN_LIGHTS`, plus
a world-position varying it adds to the vertex shader — three.js's `MeshBasicMaterial` has none.
Three things about that patch:

- It **extends the existing `#include <color_fragment>` replacement** rather than adding a second
  `onBeforeCompile`; the dither-discard fade lives in the same one (docs/render.md § Wall occlusion
  fading).
- **The light term has to land inside that replacement, not merely somewhere after it.** A few
  lines below `color_fragment`, three folds `diffuseColor.rgb` into `outgoingLight`, and
  `opaque_fragment` writes `gl_FragColor` from *that* — so a term added any later compiles, runs,
  and is discarded. The symptom is specific and misleading: sprites light each other correctly
  (they are tinted on the CPU, below) while the level around them stays completely dark, which
  reads as "the shader never ran" rather than "the shader ran too late". An injection at
  `#include <fog_fragment>` is the version this was found on.
  `tests/render/lights-shader.test.ts` pins the ordering against three's own resolved source.
- Fog needs nothing: it is mixed into `gl_FragColor` later regardless, so a lit surface fogs like
  any other.
- It adds to the *multiplier*, not the texel: `diffuseColor.rgb + sampledDiffuseColor.rgb *
  dynLight`, clamped at 1. That reproduces the fullbright ceiling instead of overbrightening the
  texture past it. Vertex colours here are linear-light (docs/render.md § Sector lighting), and
  GLDEFS colours are treated as linear multipliers to match.
- `customProgramCacheKey` is **required**: three.js keys its program cache on material parameters,
  so without it a patched material can be served the program compiled for an unpatched one — the
  same hazard `SpriteBatch`'s fuzz materials guard against.

**Sprites are lit on the CPU**, by sampling the same falloff into an additive tint that rides the
per-instance colour already in `SpriteBatch` (its `instanceColor` was grayscale; it now takes an
RGB tint on top). This is not a shortcut: it keeps sprites out of the per-pixel path entirely, and
it is what gives `dontlightself` somewhere to happen — a light can skip the very sprite emitting it.

**Sprite tints are one frame behind.** A sprite is offered *and* tinted in the same pass, so when it
asks what light reaches it, this frame's set isn't closed yet and it samples the previous frame's.
At these speeds that is invisible, and the alternative is walking every drawn sprite twice.
Geometry has no such latency — `commit` runs after every draw pass and before the render.

Both halves are one call, `DynamicLights.offerAndTint`, and all three draw funnels — things,
`SpriteFxLayer`, the player — go through it. The order is load-bearing in the direction above, and
a sprite that offered without sampling would light the room but not itself; one entry point is what
keeps the three funnels from drifting. It returns a single reused `Tint` scratch, valid until the
next call, which every caller reads before drawing the next sprite. The two channels are then
summed and clamped by `tinted`, shared by the instanced batch and `SpriteActor` so the composition
rule has one home.

## Falloff and what is not reproduced

`att = clamp((radius - dist) / radius, 0, 1)`, GZDoom's own linear shader falloff
(`shaders/glsl/main.fp`), used identically by the shader and by `tintAt` so the two halves of a
scene agree.

Deliberate deviations, all documented at their declarations:

- **`attenuate` is ignored.** In GZDoom it switches the light to an N·L diffuse term; this
  pipeline has no normals (walls and flats are `MeshBasicMaterial` with baked vertex colour), so
  there is nothing to dot against. Every light in the stock file sets it, and all of them render
  as the plain linear falloff.
- **`subtractive` is parsed and never rendered.** The only user in the stock file is the spectre's
  light, whose binding is commented out anyway.

## What reaches the shader

A sprite is offered wherever **fog of war** has revealed it, and fog of war reveals to
`VIEW_DISTANCE` — 16000 units, most of a level. The camera holds a few hundred: its distance dial
runs 200 to 2400. So the set of *offered* emitters is nearly the whole map's worth and the set that
can light a drawn pixel is a small part of it. E1M1 alone carries 89 light-carrying things — 38 of
them the health and armour bonuses, which pulse — where a handful are ever in frame.

**So an offer is frustum-culled before it becomes a light.** The falloff bounds a light to its own
sphere (`radius` around the emitter, no light past it), so a sphere that misses the camera's view
volume cannot reach a drawn pixel, and `offer` drops it in six dot products and no allocation.
`TopDownCamera.viewFrustum` is that volume, derived at the end of `applyToCamera` because three
only refreshes the camera's matrices inside `render`, which is after the lights have closed.

**`offer` and the three methods beside it take the emitter as scalars, not a record.** That is the
exception docs/conventions.md § Named arguments allows on a hot path, and it was measured rather
than assumed: `offerAndTint` runs once per drawn sprite per frame, two of its three callers compute
the coordinates inline, and passing `{x, y, z, id, subsector}` instead cost about 5% of the funnel
(400 sprites x 60 frames: 2.58 ms against 2.77 ms, interleaved in one process). The class pools its
`Emitter` slots for the same reason.

Without it E1M1 sits near the cap every frame — 54 lights on a fully explored map — paying 54 fills,
54 shadow maps and a 54-iteration fragment loop over a screen's worth of pixels for a room lit by
three torches. The cost is entirely per-pixel: the CPU side of a frame is well under a tenth of a
millisecond either way (§ Profiling). Measured on a fully revealed E1M1 at a 5120x2880 drawing
buffer, the cull takes the frame's GPU time from 99 ms to 18 ms on an integrated GPU, and the
committed set from 54 lights to 11.

Two consequences to know:

- **An off-screen sprite may be tinted from an incomplete set.** `tintAt` samples the committed
  lights, and a light too far off screen is no longer among them. Only sprites that are themselves
  off screen can differ, which is why this is affordable.
- **The cull is the view volume, not the fog.** A light 12000 units away inside the view cone
  survives, and the scene fog is what makes it read as nothing.

- **`MAX_DYN_LIGHTS` caps what survives that cull**, and past it lights are ranked by how far their
  *edge* falls short of the camera's follow point — so a big light further away can outrank a small
  one nearby, it being the one that actually covers more of the view. It is a **feel dial**, set
  generously on purpose: a slaughter map with a hundred projectiles in the air should read as
  fireworks, and a tight cap instead makes lights pop in and out as the ranking shuffles under a
  moving camera. What bounds it is not per-pixel cost — the fragment loop runs to the live count
  — but shader uniform slots, two rows per light against the 224 fragment uniform vectors WebGL 2
  guarantees. Its declaration in `render/lights.ts` carries that arithmetic.

The fragment loop walks the leaf's slot list (§ How the answer reaches a fragment), bounded by
`min(uLightCount, MAX_LIGHTS_PER_LEAF)` rather than by the leaf capacity with only the empty-slot
`break` inside, and the whole block sits behind `uLightCount > 0 && uLightVisWidth > 0`. Both are
about what the *driver* compiles: a statically bounded loop is one it may unroll, and 16 copies of
a body carrying an `atan` and a `texelFetch` is a shader whose register pressure every fragment
pays, lit or not. It is not a micro-optimisation — on the older committed-set loop, the equivalent
bound alone was most of a 99 ms frame against a 55 ms one. The outer guard is what makes a frame
with no lights — the toggle off, an unlit map — cost nothing at all, and it is uniform across the
draw, which is why it is affordable where a per-fragment gate is not (§ How the answer reaches a
fragment).

## What a light remembers between frames

Both halves of "which surfaces can see this light" — the leaf flood (`reach`) and the shadow cast
(`castShadows`) — are pure functions of the light's position, its reach, and which lines block
sight. None of those moves on most frames: the stock definitions are lamps, columns, torches,
candles, barrels and pickups, and they stand still in a level where nothing is opening. At a full
64 committed lights the pair measured 0.31 ms/frame on E1M1, 0.59 on DOOM2 MAP15 and 0.47 on EPIC
MAP05 — the cast being roughly two thirds of it — spent re-deriving the previous frame's answer.

`DynamicLights` keeps a `LightMemo` per emitter ID and reuses it while nothing it depends on has
changed. Three things about the key:

- **The blocker half is derived, not announced.** `LightVisibility.sightVersion` hashes every
  sector's floor and ceiling, which is all `World.blocksSight` reads. A version counter raised by
  whoever moves a sector would be a contract the next mover can forget, and forgetting it looks
  like light shining through a closed door; a hash cannot be forgotten. It costs one pass over the
  sector table per frame.
- **The cast is taken at the light's widest radius** (`widestSize`), so a flickering or pulsing
  light does not re-cast every frame as its radius cycles. That is exact, not an approximation: a
  blocker recorded past the live radius is further away than any fragment that survives the
  falloff, so the extra reach can never change a verdict — the shader and `unshadowed` both test
  the shadow distance only after `att > 0`.
- **The flood is keyed on the live radius**, and so a flickering light does re-flood. It is the
  cheaper half, and widening it is *not* free the way widening the cast is: the leaf list is
  capacity-bounded (§ How the answer reaches a fragment), so a light claiming slots in leaves it
  does not actually reach could crowd out one that does.

The memo governs the **upload** as well as the cast. A row is copied into the shadow texture only
when the cast was retaken or the row does not already hold this light, and
`uLightShadow.needsUpdate` follows that rather than "there is at least one light" — otherwise a
frame of pure memo hits still re-uploads the whole texture unchanged.

**Which light a row holds is tracked on the row (`DynamicLights.rowOwner`), never on the memo.**
Rows are handed out fresh each `commit` in nearest-first order, so the row a light had last frame
is not a row it owns: a light that is culled for a frame and comes back to the same row number
would, under a remembered-on-the-memo slot, skip the copy and draw wearing the shadows of whatever
light took that row meanwhile. `tests/render/lights.test.ts` covers the three-frame case.

Memos are capped at four frames' worth of lights and pruned to what the last `commit` used, since a
one-shot effect gets a fresh emitter ID every time one spawns (§ What emits). `bindLevel` clears
them and resets `rowOwner`: memos are keyed on emitter IDs and leaf indices, both of which the next
level reuses, and a row whose owner is forgotten re-uploads on its next use.

## Bloom

`src/render/bloom.ts`, owned by `Viewport` and reached through `Viewport.present` — the one call the
whole engine renders through, so the pause redraw and the savegame thumbnail composite the same way
the frame on screen does.

**What glows is a per-channel threshold in linear light, and 1 is the value it must not be.** The
light term is a multiplier on the texel (`textures.ts`), so on DOOM's dark floors a torch never
pushes anything near white: with the threshold at 1, DOOM2 MAP25's sixteen torches changed **not one
pixel**. `THRESHOLD` is tuned by feel instead, and what clears it in practice is the emitters
themselves — flames, lamps, plasma — not the surfaces they light.

**Per channel, not on luminance.** Linear light makes a saturated colour dark: DOOM's flame orange
is luminance 0.30 with its red channel already at 1, so a luminance test drops exactly the lights
this is for.

**The light term is left unclamped** (`textures.ts`), so light strong enough to pass white blooms
proportionally harder rather than saturating. It used to end `min(diffuseColor.rgb +
sampledDiffuseColor.rgb * dynLight, vec3(1.0))`; the ceiling is now three's own tone mapping, the
same per-channel saturate at `LinearToneMapping` and exposure 1 — and at the light visor's 2.5,
since `saturate(min(x,1)·e) == saturate(x·e)` for `e >= 1`. The picture is unchanged either way.
`tests/render/lights-shader.test.ts` pins it, because putting that clamp back would silently return
the bloom to firing on nothing.

### The chain

Scene into a `HalfFloatType` target, then four blur levels and one composite:

- **Half float is not for the range but for the darks, and it is the whole cost of the feature.**
  Three encodes into a render target in its *working* colour space, i.e. linear
  (`WebGLPrograms.js`: a non-XR target ignores `texture.colorSpace`), and the void fog sits at
  linear 0.002-0.006 — two steps out of 255 in an 8-bit linear target. The full-size target is what
  the measurements below are paying for.
- **Tone mapping switches itself off**: three applies it per material only while drawing at the
  canvas, so with a target bound the scene lands in linear light and the composite is what tone maps
  and encodes. `toneMappingExposure` reaches it as a program uniform, so the light visor still works
  with no wiring of its own.
- **MSAA moves onto the scene target** (`samples`), under the same `pixelRatio < 2` condition
  `Viewport` puts on the canvas context — with a target bound the canvas's own `antialias` does
  nothing, and the path with the bloom off still uses it.
- The blur is a **downsample/upsample pyramid** starting at `DOWNSCALE`, not a Gaussian: four 4-tap
  halvings down and 9-tap tents summed back up. It is wide and ring-free for the cost of the small
  levels only, and `FILTER_RADIUS` rather than the level count is the dial for how hazy it reads.

### Why the bright pass is four taps

**A single bilinear tap averages 2x2 source texels however far a pass reduces**, so the bright pass
reading the scene at `DOWNSCALE` 4 saw 4 of every 16 texels — and *which* 4 slid as the camera
moved. That is a flicker in the glow, and it was reported as one. It takes four taps, a quarter of
the reduction apart, for the four to cover the block their output texel stands for.

The threshold is applied **per tap, before the average**: after it, a lone bright texel is diluted
under the threshold by its dark neighbours and drops out entirely, then pops back as the camera
moves — the same flicker by the other route.

Measured over six camera positions a map unit apart on E1M1's two static lamps, as the spread in how
much glow the pass captured at all (a difference image measures the glow *sliding*, since one map
unit moves the picture about two pixels):

| bright pass | spread in captured glow |
|---|---|
| `DOWNSCALE` 4, one tap | 6.0% |
| `DOWNSCALE` 4, four taps | 2.6% |
| `DOWNSCALE` 2, four taps | 3.8% |

`DOWNSCALE` 2 is where this was first worked around, and the table says why it worked: at a 2x
reduction one bilinear tap *is* an exact box, so the bug could not show. With the four taps in
place either divisor is stable, and 4 costs about 0.4 ms less of the 5.9 below — the full-size scene
target, not this chain, is what the bloom actually costs.

**`DOWNSCALE` above 4 needs more taps**, since four cover a 4x4 block and no more.

### What it costs

GPU time around the render call (`GpuTimer`), at a 5120x2880 drawing buffer, DOOM2 MAP25 standing in
its sixteen torches:

| GPU | off | on |
|---|---|---|
| GeForce RTX 5070 Ti Laptop | 1.0 ms | 5.8 ms |
| Ryzen 9 9955HX integrated | 18.1 ms | 20.8 ms |

The multiplier is large and the absolute figure is not: 5.8 ms at that size is still inside a
120 fps budget. The integrated part is past 60 fps at that resolution with the bloom off as well, so
this is not what breaks it there. Both are bandwidth, not shading — the scene target is written once
and read once at full size, and the pyramid runs at a sixteenth of it and below.

### Bloom and the canvas's MSAA

The canvas's own multisampling (`Viewport`, docs/render.md § What a frame costs) smooths **nothing**
behind this chain: the scene lands in a render target, and the only geometry reaching the default
framebuffer is one triangle covering it whole. Left on, it is a second full-size multisample buffer
allocated and resolved every frame beside the one the scene target already carries.

So the context is created without it where the setting is already on, and `Bloom` supplies the
antialiasing instead — the scene target's own `samples`, which it needed regardless. `Viewport`
decides this once, because a WebGL context's `antialias` cannot be changed after it is created.

That is what `Bloom.ownsAntialias` is for. A session that started with the glow **on** and then
switches it off keeps rendering through the scene target and the composite, minus the blur chain:
the target is the only multisampling left, and dropping it would leave the picture aliased until a
reload. Nothing else changes — the levels are released, so what that session pays while off is one
target and one full-screen triangle, which is what the canvas MSAA cost it anyway.

A session that started with the glow **off** keeps the canvas's MSAA and the plain
`renderer.render`; switching bloom on then costs the redundant canvas buffer until the next reload,
which is the same trade in the cheaper direction.

### Turning it on

Settings / Visuals / Lighting / "Bloom", persisted as the `bloom` setting, read per frame.

**Off by default — the only visual setting that is**, on the table above: several times the frame's
GPU time is a price worth paying only once someone has seen the glow and decided they want it.
Every other one of these is cheap enough to just be on.

Off, the targets are released and `render` is the plain `renderer.render` it replaced, so the
default costs nothing whatsoever — not the scene target, not a pass, not an allocation. The one
exception is a session that started with it on (§ Bloom and the canvas's MSAA).

## The toggle

The `dynamicLights` setting, **on by default**, in the menu's Settings → Visuals tab
under Lighting. Module-level rather than per-`Game`, for the reason `getInfiniteTallActors` is: it
must apply to the level already running, and the flag is read once per frame, so it takes effect
immediately with no reload. Turned off, `commit` uploads a count of zero and `tintAt` writes zeros
— the materials stay patched, so there is only ever one compiled program variant.

## Where the definitions come from

`assets/gldefs.txt` (GZDoom's stock Doom lights) is the `GLDEFS` lump of the WAD the engine ships
(docs/wad.md § The WAD the engine ships), fetched once per session by `main.ts` and parsed as the
base. Every `GLDEFS` and `DOOMDEFS` lump in the loaded WAD set then layers over it in
lump order, a later definition of the same light name or frame binding replacing the earlier —
GZDoom reads all such lumps rather than the first (`gldefs.cpp: LoadGLDefs`), unlike the MAPINFO
family, where a file's several lumps are alternatives (docs/wad.md § Level names). A load that
fails leaves the base empty and the game unlit rather than unplayable.

## Profiling

`commit` reports under the `Lights` row of the profiler overlay (docs/menu.md § The profiler). Note
that this is CPU only — the per-pixel cost of the fragment loop lands on the GPU, where it shows up
in the frame total rather than in any row.

**The per-pixel half is measured in a browser, not reasoned about.**
`EXT_disjoint_timer_query_webgl2` is available in chromium and gives real GPU milliseconds: begin a
`TIME_ELAPSED_EXT` query in a `requestAnimationFrame` callback and end it in the next one, and the
query spans exactly one frame's GL commands. Three things decide whether such a run means anything —
the **drawing buffer** (`setPixelRatio` up to 2 on a 2560x1600 panel is 5120x2880, and the cost here
is per fragment), the **GPU** (chromium picks the discrete one by default; `--use-angle=gl` with
`DRI_PRIME=0` puts it on the integrated one, where a regression shows up an order of magnitude
clearer), and whether the level is **explored**, since a sprite only offers itself where fog of war
has been. `?map=`/`?pos=` (docs/menu.md § URL parameters) place the player, and filling `FogOfWar`'s
`explored`/`alpha` from the console reaches the steady state without walking the level.

The row covers the reach fill and the shadow casting as well as the upload. Measured over DOOM2
MAP15 and DOOM E1M1, a fill costs about **2 µs** once the leaf's adjacency is warm and reaches 12–15
leaves at a 200-unit radius, so a full complement of lights is well under a tenth of a millisecond.
The first fill through a given leaf is ~15× that, building the adjacency it then keeps.
