# Rendering

`src/render/` — BSP reconstruction, mesh building, lighting, occlusion fading, camera, sprites, plus
the frame loop's two modes (`game.ts`)

## BSP polygon reconstruction (`bsp.ts`)

`SEGS` only stores edges that lie on real linedefs — the edges created by BSP splits aren't in the
WAD. `buildSubSectorPolys` rebuilds each subsector by taking a quad covering the whole map and
clipping it (Sutherland-Hodgman) against every partition line on the path from the BSP root down to
that leaf, then against the subsector's own segs. The result is convex, so a triangle fan is enough.
Traversal is iterative (stack-based), not recursive — some maps have deep BSP trees.
`sectorOfSubSector` resolves a subsector's sector via its first seg → linedef → sidedef.

## Mesh building (`mapmesh.ts`)

Walls are built per linedef from sidedefs: one-sided lines get their middle texture over the full
sector height; two-sided lines get upper/lower steps plus an optional masked middle, following DOOM's
pegging rules (`UPPER_UNPEGGED`/`LOWER_UNPEGGED`) for vertical alignment. Walls are drawn
single-sided (facing DOOM's defined front), which is what culls walls between the camera and the
player and produces the open dollhouse look — no extra logic needed. `F_SKY1` flats are skipped.

Coordinates: DOOM's `(x, y, z)` becomes three.js `(x, z, -y)`, so the map plane is XZ and Y is up.

Ceilings are never rendered — `buildMapMesh`'s `renderCeilings` option still exists and is always
`false`. From directly above, a rendered ceiling would hide everything under it; this is a permanent
view choice, not a debug convenience.

## Sector lighting (`mapmesh.ts: lightToColor`)

Walls, flats and sprites are all tinted by their sector's light level through this one function, so
it decides how the whole game reads. Two things about it are easy to get wrong, and both were shipped
bugs.

**The ramp is vanilla's own `COLORMAP`, measured from the lump rather than modelled.** Vanilla never
multiplies a colour by the light level: it picks one of `COLORMAP`'s 32 rows and remaps every palette
index through it, and that ramp is nothing like linear in light level. `COLORMAP_GAIN` is the mean
linear-luminance ratio of each row, measured across the PLAYPAL colours — the same "confirm it
against the real lump" discipline as the sprite and death-frame tables. DOOM.WAD's and DOOM2.WAD's
COLORMAPs are byte-identical and Freedoom's is within 0.003, so one baked table serves all three;
per-colour spread is ~12% of the mean (the ramp desaturates slightly as it darkens), close enough for
a single scalar per row. An earlier hand-tuned curve (`pow(l, 0.85) * 0.9 + 0.1`) was both far too
bright and far too flat.

Vanilla builds the row index as `startmap - scale/DISTMAP` (`r_main.c`), where
`startmap = (15 - lightnum) * 4` and the subtracted term grows as a surface gets *closer* — so in
vanilla the light level really sets how fast a surface falls off with distance, not a flat
brightness. This engine has no distance lighting (the camera hangs at a near-constant distance from
everything it draws), so the ramp is sampled once at a fixed reference distance: **`REFERENCE_STEPS`
is that subtracted term, and it is the knob to turn if the game reads too dark or too bright.** 4
(≈ a 300-unit viewing distance) puts a uniform ~0.12 of display brightness between adjacent light
segments across light 112-208, which is 88% of every sector in the stock IWADs. Both ends necessarily
saturate — vanilla spends 4 rows per light segment, so its 16 segments want 64 rows where only 32
exist. That is vanilla's ramp rather than a shortcut; it just never shows up in vanilla, where
distance fills the range back in.

**Light is quantized to DOOM's own 16 segments (`light >> 4`)**, so two sectors whose levels differ by
less than 16 are genuinely identical on screen, as in vanilla. Every stock map's sector lights are
multiples of 16 anyway. This is also what makes the fake-contrast offset work out: `addWall` passes
±16, which after the shift is exactly the ±1 *segment* nudge vanilla applies (`lightnum--`/
`lightnum++`). Vanilla **darkens** east-west walls and **brightens** north-south ones (`r_segs.c:
R_StoreWallRange`) so corners stay legible under flat sector lighting — this engine had that sign
inverted for a long time.

**The returned value is linear-light, not a display value.** Vertex colours (and
`material.color.setScalar`, for non-batched sprites) are consumed as-is by the shader, and the
renderer's `outputColorSpace` (`SRGBColorSpace`) encodes the final fragment to sRGB on the way out.
Returning a display-space value gets it gamma-encoded a second time, which disproportionately
brightens the dark end.

**A vanilla-exact ramp is still too dark for this camera, so there's a fixed brightness lift on top,
`BRIGHTNESS_LIFT` in `constants.ts`.** Vanilla's ramp assumes a first-person view a few dozen units
from what it's lighting, broken up by nearby bright surfaces and real depth cues; this camera looks
down on an entire dim room at once with neither. `applyBrightnessLift(linear, lift)` pushes a value
toward 1 by a fraction `lift` of its remaining headroom `(1 - linear)`, so black brightens by the
full amount and already-bright surfaces barely move — brighten the dark end, taper toward the bright
end, not a flat multiply. `lightToColor` itself is left untouched (still pure, still exactly
vanilla); `litColor` is `lightToColor` plus `BRIGHTNESS_LIFT` and is what every real draw call uses.
`BRIGHTNESS_LIFT` was found by feel, and lives in `constants.ts` because it's the one number in this
scheme meant to be hand-retuned later.

**Every sprite reads its light live, never a cached snapshot.** Sector light is mutable at runtime
(blinking/strobing/glowing sectors, switch-triggered changes — `game/specials.ts`'s
`SectorSpecialsController`), and geometry always reflects that immediately via `recolorSector`. A
sprite must match: `game/things/defs.ts`'s `PosedThing` has no `light` field precisely so nothing can cache
one — every map thing (items, decorations, corpses, barrels, monster drops, dormant or actively
chasing monsters alike) reads `p.sector?.light` at the moment it's batched, not at spawn time. The
same discipline applies to anything that moves through space across a frame: `ProjectileLayer.update`
re-resolves `world.sectorAt` at the projectile's *current* position every frame rather than reusing
its launch-sector light, and the arch-vile's warning flame (`SpriteFxLayer`'s `followTargetId` case)
re-resolves it every time it re-derives its position from the target it's tracking. A stationary
one-shot effect (blood, puffs, teleport fog, impact explosions) only needs the single lookup `spawn`
already does, since it never moves and its lifetime is short enough that a mid-flight relight isn't
worth chasing.

## Wall occlusion fading (`occlusion.ts`, `textures.ts`)

Single-sided back-face culling only removes walls facing away from the camera; it does nothing about
a wall that legitimately faces the camera but sits directly on the camera→player sightline (a pillar
in front of the player). `WallFader` tests every wall quad's 2D footprint against that sightline each
frame and fades the ones that cross it, rather than the coarser fix of drawing the player on top of
everything, which would also show it through walls that genuinely separate it from the camera.

`WallFader.update`/`FlatFader.update` take a *list* of sightline targets (`FadeTarget[]`), not just
the player — `collectFadeTargets` (same file, called from `game.ts` with `ThingLayer.awakeMonsters`)
returns the player plus every currently-**awake** monster
within `MONSTER_FADE_RANGE` (a plain 2D distance cap, tuned by feel to
roughly a room/corridor's length), and a quad fades if it sits on any one of those sightlines. Both
gates matter: a sleeping monster isn't being tracked yet, so there's no reason for a wall to reveal
it early; and without the range cap, an alerted monster dead-reckoning toward the player from across
the level would fade every wall along that line. The range cap is deliberately a plain distance, not
a `hasLineOfSight` check — an earlier version required unobstructed line of sight, which made the
fade a no-op for exactly the case it exists for (a wall genuinely hiding a nearby monster also means
`hasLineOfSight` is false, so the monster never became a fade target and the wall stopped fading).
`SpecialsController.updateFading` (doors, lifts) takes the same target list, reusing the identical
machinery for its own meshes.

`WallFader.update` also takes an `openingOf` callback (`World.openingOf`, threaded through so this
class needs no `World` reference) and skips fading any quad whose own `[botH, topH]` sits *inside*
its line's vertical opening — a masked middle texture (grate, fence, barred window) is built to span
exactly that opening, so a quad living inside it is the passable gap itself: a shot and a look
already pass straight through it, so fading it has nothing left to reveal. This has to be a
**per-quad** check, not a per-*line* one — an earlier version gated on `World.blocksSight(line)` for
the whole line, which wrongly also suppressed fading for that line's upper/lower step quads (they sit
*outside* the opening — the riser exposed where the neighbouring floor/ceiling falls short — and are
genuinely solid regardless). DOOM2 MAP01's east imp closet (sector 38) is the concrete case: its
fence's masked-middle quad used to fade to near-invisible the moment the imp inside woke, reading as
the closet wall vanishing rather than "you can see the imp through the bars." `FlatFader` has no
equivalent gate — floors have no comparable "visually-solid-but-actually-passable" case.

**`awakeMonsters` only returns monsters fog of war is actually drawing** (`p.actor.mesh.visible`,
which `ThingLayer.update` sets from `fogAlphaOf` earlier in the same frame). A monster in a subsector
the player has never had sight of isn't rendered at all, so fading the wall in front of it reveals an
empty dark room and nothing else — concretely, a MAP01 secret compartment's wall dithered away
whenever the imps sealed inside woke, with the imps still invisible. This is also why
`WallFader.update` needs no "only fade if this is the *sole* wall in the way" rule: whether fading
reveals anything is settled here, upstream. A blocker-counting version was written first for this
same symptom and fixed nothing — that wall had only one blocker; its monsters simply weren't drawn.

**The fade is a dithered discard, not real alpha blending.** Wall quads are batched one mesh per
texture across the whole map, three.js sorts transparent objects back-to-front per mesh, and with a
mesh spanning the entire level that order is meaningless — plus both meshes still write depth by
default, so whichever draws first can win the depth test and blank out the other. `MaterialBank`
instead injects a fragment-shader snippet (`onBeforeCompile`) that discards a per-pixel fraction of
fragments using interleaved-gradient-noise dithering, keyed off a per-vertex alpha `WallFader` writes
into the (otherwise unused) 4th colour channel. That keeps walls in the ordinary opaque,
depth-tested/written pass — no batching or sort-order concerns, just fewer pixels drawn. `holes`
textures (masked middles) already alpha-test on the *combined* texture × vertex alpha, so a faded
grate discards outright instead of dithering.

Fade amount is exponentially smoothed (`FADE_SPEED`) so walls don't pop, but a pure exponential lerp
never actually reaches its target — `update` snaps once the remaining gap drops below a threshold,
otherwise a wall settles a hair short of fully opaque forever and shows a permanent faint speckle
(the dither test is a strict `<`).

## Camera orbit and camera-relative movement (`camera.ts`, `game/input.ts`, `game/player.ts`)

`TopDownCamera.yawDeg` lets the camera orbit around the followed point by pressing `Q`/`E`
(`KEY_YAW_STEP`, a 45° step per press). Tilt and distance are unaffected, so the camera always stays
the same amount off vertical.

**Orbiting is keyboard-only on purpose.** A right-mouse drag used to rotate it too, and that fought
the cursor: the mouse is the aiming hand, so a drag that swings the world underneath the crosshair
moves the aim point as a side effect of turning. The freed right button is now a menu-bound action
instead (docs/menu.md § Right mouse button).

`viewerAngleDeg` (`yawDeg - 90`) is the DOOM-space bearing from the followed point to the camera, and
is what sprite rendering and player movement both key off — at the default `yawDeg = 0` it's `-90`,
matching the old fixed south-facing camera exactly, so nothing downstream needed a special case for
"not yet orbited."

A `stepYaw` call (Q/E) queues its step as a `targetYawDeg` for `update` to animate `yawDeg` towards
(`YAW_STEP_SMOOTH_RATE`) rather than jumping. Plain assignment (`camera.yawDeg = ...`, whose only
remaining caller is the instant reorient on spawn/teleport) still jumps immediately: the `yawDeg`
setter keeps `targetYawDeg` in lockstep so nothing left over from a prior Q/E animates after an
instant set. **Nothing may assign `yawDeg` unconditionally every frame** — even a no-op `-= 0` snaps
`targetYawDeg` back to the current (still mid-animation) value and cancels a Q/E step after one frame
of smoothing, which is what forced the removed drag handler to guard on a nonzero delta.

All of that input handling lives in `TopDownCamera.applyYawInput`, which `game.ts` calls once a
frame. Holding Q/E auto-repeats the same 45° `stepYaw` every `KEY_YAW_REPEAT_INTERVAL` — `qHoldTime`/
`eHoldTime` accumulate `dt` while `Input.held` is true and fire+reset once the interval is reached,
alongside the immediate step fired on `Input.pressed`. The interval is tuned to roughly the time one
step's smoothing takes to settle, so a hold reads as continuous rotation made of chained steps.

Movement (`Player.update`'s `forwardDeg`, passed as `camera.viewerAngleDeg + 180`) is camera-relative
rather than DOOM-axis-relative: `W` always moves the player away from the camera *on screen*,
regardless of orbit. `game.ts` recomputes this every frame from the live camera angle.

## View distance (`constants.ts: VIEW_DISTANCE`, `game.ts`)

How far the player can see is the scene's **distance fog**, not a clipping plane: `game.ts` sets
`THREE.Fog` to the same near-black as the scene background, hazing in from
`VIEW_DISTANCE * FOG_START_FRACTION` and fully opaque at `VIEW_DISTANCE` (3900 map units). Geometry
past it is black however lit or fog-of-war-revealed it happens to be, so **`VIEW_DISTANCE` is the
one dial for how much of a level is on screen** — the fade start follows it as a fraction rather
than being its own number.

Fog range is measured from the camera *eye*, which hangs `TopDownCamera.distance` (480) back from
the player, so the view actually reaches ~480 units less than `VIEW_DISTANCE` out in front.

**Two other ranges have to stay above it**, or one of them becomes the real limit and geometry gets
clipped or blanked before the fog ever gets to hide it: the camera's far plane (`camera.ts`, 12000)
and `game/fogofwar.ts: SIGHT_RADIUS` (5100). The second is not a free number — it is derived from
what the camera frames, and lowering it below what is visible makes monsters standing in the gap
invisible *and* unhittable (docs/fogofwar.md § Reveal radius).

## The frame delta (`game.ts: frame`, `resume`)

`dt` is clamped to `[0, 0.05]`; `rawDt` (unclamped, for `DebugHud`'s fps only) is the real
wall-clock delta. The upper bound keeps physics/AI from taking a giant step after a stall. **The
lower bound is load-bearing**, not defensive noise: `resume` stamps `lastTime` with
`performance.now()`, while `frame` gets the timestamp of the rendering opportunity it belongs to —
and when `resume` is reached inside a frame's *input* task (a Start click whose WAD is already in
the browser cache, so nothing awaits long enough to yield), the rAF callback runs in that same
frame and its timestamp predates the stamp by the whole load. Every system then takes one negative
step; `AnimatedTextures` (§ Animated textures, docs/specials.md) turned that into a negative frame
index into its sequence and a hard crash — reproduced by starting any level, returning to the menu
and starting `oku2v31.wad`.

## The FPS cap (`game.ts: dueThisFrame`, `getFpsCap`)

A settings-menu limit of 30, 60 or 120 fps, or `0` for none — the default, and what every earlier
build did unconditionally. It is enforced by **skipping whole rendering opportunities**: a `frame`
that isn't due yet advances nothing at all and re-arms `requestAnimationFrame`, so no system sees a
partial step and the input that frame would have consumed simply arrives on the next one. `dt` is
the delta since the last frame that *ran*, and 30 fps (0.033 s) is still inside its 0.05 clamp, so
the slowest cap on offer can't turn into a clamped step.

Two rules make the rate come out right on displays whose refresh isn't a multiple of the cap:

- **A frame is due at the vsync nearest its deadline**, not the first one past it — `now + period/2`
  is what's compared, where `period` is the interval between the last two rAF callbacks (i.e. the
  display's own). A strict `now >= deadline` test halves the frame rate whenever the display runs at
  exactly the capped rate, because sub-millisecond vsync jitter makes it miss almost every deadline
  by a hair.
- **Deadlines advance by whole intervals** rather than being restamped from `now`, so the *average*
  holds at the cap when the display can only bracket it: 144 Hz capped to 120 drops every sixth
  frame, 75 Hz capped to 60 every fifth. Falling more than one interval behind (a stall, a
  backgrounded tab) resyncs off `now` instead of paying the debt back as a burst of frames.

A cap at or above the refresh rate is a no-op — 120 on a 60 Hz display still renders 60. The setting
is read **live, once per frame**, so changing it mid-level applies to the level already running;
`resume` clears the deadline so the first frame back is always due.

The paused loop (§ Pausing) ignores the cap: its own ~50 ms floor is already below every value on
offer. `DebugHud`'s fps counter reports the capped rate, since it measures the delta between frames
that actually ran.

## Pausing (`game.ts: pause`, `stillFrame`, `stop`)

A paused level is frozen but **still being drawn**: `pause` stops the simulation loop and starts
`stillFrame`, which only calls `renderer.render` — no `dt`, no input, no profiling — and only every
~50 ms, since a static scene has no reason to cost 60 fps. Without it the canvas would just be
showing its last composited frame, which goes stale the moment anything invalidates it (a window
resize resizes the canvas, a DPR change, a tab restore), and the menu now draws *over* the level
(`ui/menu/menu.css: #menu.ingame`, docs/styles.md) instead of hiding it, so a stale or blank backdrop is visible.

**`dispose` calls `stop`, not `pause`.** Both clear `running`, but `pause` sets `paused` and schedules
`stillFrame`; going through it from `dispose` would leave that loop redrawing a scene whose geometry
and materials have just been released.

## Things as sprites (`wad/sprites.ts`, `render/sprites.ts`, `game/things.ts`, `game/thingdefs.ts`)

`SpriteBank` (`wad/sprites.ts`) indexes `S_START`/`S_END` lumps by sprite name + frame letter,
resolving DOOM's `SSSSFR` / `SSSSFRfr` naming (a frame can list a second frame+rotation meaning "this
same lump, mirrored, is also that rotation" — the usual way DOOM halves the art needed for symmetric
actors). `thingdefs.ts` maps THING doomednums to their sprite name; a type absent from that table
renders nothing, same as DOOM's own invisible spawn markers (player starts, deathmatch spots,
teleport landings).

**The split between `render/sprites.ts` and `game/things.ts` follows the same rendering/game divide as
the rest of the tree.** `render/sprites.ts` only knows how to turn a (sprite name, frame letter,
viewer angle) into a posed plane — `SpriteAnimator`/`SpriteActor`/`SpriteMaterialCache`, no knowledge
of maps, AI, health or pickups. `game/things.ts` owns `buildThingSprites`: which map things exist,
their per-instance game state, and the update loop that ticks monster AI, applies pickups/damage and
drives drops. Its `things/` folder holds the record shapes those run on (`defs.ts`:
`ThingLayer`/`PosedThing`) and the spatial index they query (`grid.ts`, docs/monsters.md § Spatial
indexing).

### Batching

**Map things are drawn batched, not one mesh each** (`spritebatch.ts: SpriteBatch`), and this is a
hard performance requirement rather than a refinement. A stress-test map like NUTS.WAD has 10,696
things in a single 69-subsector open arena, so essentially all of them are on screen and
fog-of-war-revealed at once; one `THREE.Mesh` each meant ~10k draw calls per frame and a ~2fps
slideshow. `SpriteBatch` keys one `InstancedMesh` per cached (lump, mirrored) pair and rebuilds the
instance buffers every frame — on that map, all ~10.7k sprites in 19 draw calls.

Rebuilding wholesale each frame rather than maintaining instances incrementally is deliberate: which
lump a thing uses changes constantly (every monster re-picks its rotation frame as the camera orbits
*and* as its own facing changes, with its walk cycle advancing on top), so batch membership isn't
stable across frames and there's nothing worth preserving. Two properties keep the per-sprite write
cheap enough to do unconditionally:

- **Every sprite shares one rotation.** The planes never tilt and all track the same camera yaw, so
  the yaw's sin/cos are computed once per frame in `begin` and each instance matrix is written as
  plain scalars — no per-sprite `Matrix4`/`Quaternion` allocation or `compose` call. (Verified
  against three.js's own `compose` on all of NUTS.WAD's things: worst element error 1e-8, i.e.
  float32 rounding.)
- **Sector light rides along as a per-instance colour**, which *fixes* a pre-existing bug rather than
  merely preserving behavior: the one-mesh-each path tints by mutating the lump's **shared**
  material, so wherever several things shared a lump the last one posed each frame decided the light
  for all of them.

That per-instance colour needs one non-obvious thing. three.js's fragment shader only multiplies
`vColor` in under `USE_COLOR` — i.e. `material.vertexColors` — while `USE_INSTANCING_COLOR` alone
populates `vColor` in the *vertex* shader and is then ignored downstream. So the batch's materials are
clones with `vertexColors: true` and a white base colour, and `SpriteMaterialCache` gives every
sprite geometry an all-white `color` attribute, without which WebGL's default (0,0,0) generic
attribute would render every batched sprite black. The non-instanced material ignores that attribute
entirely.

A batch takes an optional **`depthBias`**, which sets `polygonOffset` on its cloned materials so
every fragment it draws is nudged that many depth-buffer units toward the camera. Only the
`polygonOffsetUnits` term is used: every sprite plane faces the camera at the same yaw, so their
depth *slopes* match and a slope-scaled term can't separate them. `ThingLayer` uses this for one
thing — drawing a monster's death drop on top of the corpse it's lying on (docs/items.md § Making
monster drops readable) — and it is sized to settle a coplanar tie and nothing more.

The batches set `frustumCulled = false`: a batch's instances are scattered across the whole map, so
culling it as one object could only ever cull nothing while costing a per-frame bounds recompute to
decide that — off-screen instances are clipped by the GPU for the price of a 4-vertex vertex shader
instead. That in turn means the bounding sphere three.js lazily computes and caches for *raycasting*
would go stale as instances move, so `end()` nulls it each frame.

`SpriteAnimator` is what makes both paths possible: it owns the frame cycle and the state→(geometry,
material) lookup with **no `THREE.Object3D` of its own**. `SpriteActor` wraps one in a `THREE.Mesh`
for the **player**, now the only sprite that genuinely wants one: there is exactly one of it, and it
needs `setOpacity` (partial invisibility), which has no per-instance equivalent in a batch.
Everything else holds a bare `SpriteAnimator` and feeds a `SpriteBatch` — `PosedThing` for map things,
and `SpriteFxLayer`'s batch (`game/spritefx.ts`) for projectiles, impact explosions, teleport fog and
the revenant's smoke trail. Because a batched thing has no mesh of its own, `PosedThing.visible` replaces what used
to be read off `mesh.visible`, and `ThingLayer.pickMonster` routes its auto-aim raycast through
`SpriteBatch.raycast`, which maps an `instanceId` hit back to the owning thing. That raycast skips
(rather than being blocked by) instances its predicate rejects, so a decoration standing in front of
a monster still doesn't make it untargetable.

`ThingLayer` owns **two** batches under one `things` group: ordinary things, and monster death drops
— which are depth-biased (above) and `translucent`, so `setOpacity` can pulse them (docs/items.md §
Making monster drops readable). A `translucent` batch builds its material clones transparent, with
the alpha test dropped to 0.01 and `depthWrite` off, from the start: `setOpacity` runs every frame,
and flipping `transparent`/`alphaTest` on a live material would recompile its shader each time,
whereas `opacity` alone is a uniform write. The fade is per *batch*, not per instance —
`instanceColor` carries no alpha, so a per-sprite fade would need a custom shader.

### Which things spawn

**`game/skill.ts: isMultiplayerOnly`** filters out things carrying THING flag bit `0x10` before
`buildThingSprites` poses them — vanilla's `P_SpawnMapThing` reads
`if (!netgame && (options & 16)) return NULL;`, i.e. the bit hides a thing whenever no other players
are present. This engine has no multiplayer, so the bit always applies. Mappers use it to stash
deathmatch-only weapons/ammo without cluttering single-player — E1M1 has two `SHOT` things; only the
one *without* the bit is the real single-player pickup.

### Why upright planes, not `THREE.Sprite`

- **Planes turn to face the camera's yaw, but never tilt.** `TopDownCamera` orbits in yaw but only
  ever tilts a fixed amount off vertical — it never pitches. So a plane only needs to rotate around
  its vertical axis to track `camera.viewerAngleDeg` (`setPose`'s `viewerAngleDeg`, passed every
  frame); it never needs a true billboard rotation. `VIEWER_ANGLE_DEG` is just the fallback for
  callers that don't pass a live angle. A `THREE.Sprite`'s full camera-facing rotation would be both
  wasted work and actively wrong: it tips flat as the camera tilts toward straight-down, making
  standing figures read as lying on the floor.
- **`DataTexture` can't use `flipY`.** WAD bitmaps start at their top row; a plane's default UVs put
  `v=0` at the bottom, so art arrives upside down. Setting `texture.flipY` does nothing — WebGL only
  honours `UNPACK_FLIP_Y_WEBGL` for image-source uploads, not the typed array every `DataTexture`
  uses — so the V axis is inverted through `texture.repeat`/`offset` instead. (Wall/flat UVs in
  `mapmesh.ts` dodge this differently: they're built by hand with V running downward.)
- **The patch's `top` hotspot is not trusted for floor placement.** DOOM anchors a sprite at
  `thing.z + top` and gets away with the slack because its software renderer floor-clips every column
  and the camera sits near floor height. Neither safety net exists in an unclipped 3D top-down view,
  so a patch whose `top` is less than its full height (common, worst on small pickups) would draw
  with its feet below the floor. The bottom edge is anchored to the floor outright; `left` is still
  used as-is for horizontal centring.
- **Rotation frame (which of the 8 sprite angles) is picked from the live viewer angle** every frame
  (`pickRotationDigit`), same as the plane's own yaw.
- **Ammo/health/armor/keys/powerups render `PICKUP_SCALE` (1.4×, `src/constants.ts`) larger than
  their native WAD pixel size; nothing else does.** Vanilla's 1:1 unit-per-pixel sizing suits a ground-level view; from this
  far, tilted camera small collectibles get lost. `game/thingdefs.ts`'s `PICKUP_SCALE_TYPES` is a
  whitelist of exactly those four doomednum blocks, not "everything but monsters/weapons" —
  monsters are already large enough to read, weapons already stand out, and solid decorations/gore
  props (torches, columns, trees, corpses) are already sized to fill a room or a body, so blowing
  them up another 40% on top of vanilla's own size reads as oversized rather than more readable.
  Applied as `mesh.scale.setScalar(...)` rather than baked into the shared per-lump geometry, since
  scale varies by thing type even when two types reuse art. It composes safely with floor-anchoring:
  geometry is translated so the plane's bottom-center sits at local `(0, 0)` *before* `scale` is
  applied, so scaling stretches the plane upward and outward from that point instead of moving its
  anchor.

Animation (`setPose`'s `animFrames`/`animating`) is a plain frame-letter cycle with no separate idle
art, matching DOOM itself: the player's `PLAY` sprite reuses `A,B,C,D` as its walk cycle and holds `A`
while not moving.

Monsters gate `animating` on whether they actually stepped this frame (`ThingLayer.update`), the same
motion-driven cycle as the player. Every non-monster thing (barrel sway, decoration flicker, item/key/
powerup blink) instead animates unconditionally — vanilla's own idle art loops regardless of motion,
there being none to gate on. Which doomednums get more than the single held `'A'` frame
`buildThingSprites` defaults to, and their frame letters/timing, is data in `game/thingdefs.ts`'s
`THING_ANIM_FRAMES` (cross-checked against `info.c`'s `states[]`, not the wiki). The same table also
covers the opposite case — a corpse/gib prop (the "Dead …"/"Bloody mess" doomednums) whose vanilla
`spawnstate` is a fixed frame that *isn't* `'A'` — with a single-element `frames` array naming that
letter, so it holds correctly instead of drawing the sprite's first (unrelated) frame. A doomednum
absent from the table either has vanilla `tics: -1` (genuinely static — ammo, weapons, STIM/MEDI, the
plain column) or spawns at the literal `'A'` frame already, and needs neither case.
