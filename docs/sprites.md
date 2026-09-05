# Things as sprites

`src/wad/sprites.ts`, `src/render/sprites.ts`, `src/render/spritebatch.ts`, `src/game/things.ts`,
`src/game/things/tables.ts`, `src/game/things/doomednums.ts`

How a thing gets *lit* is docs/render.md § Sector lighting; how one gets hidden behind geometry
is docs/fogofwar.md.

## Thing types have names

Every doomednum this engine knows sits in `game/things/doomednums.ts` as a named member of one
`as const` object, and **every type-keyed table keys through it** — `THING_SPRITES`,
`MONSTER_STATS`, the pickup records in `inventory/tables.ts`, the membership sets, all of them —
rather than spelling the number:

```ts
export const MONSTER_HEALTH: Record<number, number> = {
  [ThingType.zombieman]: 20,
  [ThingType.cyberdemon]: 4000,
};
```

**Each entry cites its vanilla `mobjtype_t`** in a trailing comment, read off `linuxdoom-1.10`'s
`info.c` `mobjinfo` array — whose element order *is* the `mobjtype_t` order and whose first field is
the doomednum. That pairing is what makes an entry checkable; the readable name is not evidence of
anything on its own. The one member with no `MT_*` is `playerStart` (1), which has no `mobjinfo`
entry at all: `P_SpawnMapThing` handles types 1-4 itself, before the table is ever consulted.

**A doomednum is still a plain `number` everywhere it flows.** `Thing.type` (`wad/map.ts`), every
`Record<number, …>` and every `Set<number>` keep that type, and the sets carry an explicit
`: Set<number>` annotation so `as const` members don't narrow them to a literal union. This is
load-bearing, not laziness: a PWAD may contain doomednums this registry has never heard of, and
`pushThing` already treats an unknown type as "does not spawn". A union type here would make legal
map data unrepresentable.

`things/doomednums.ts` imports nothing, so any table module can take it without a cycle — the same
leaf property `things/tables.ts` has, for the same reason (docs/monster-attacks.md § Resolving an
attack).

Names distinguish types that share art rather than collapsing them: `bloodyMess`/`bloodyMessAlt` (10
and 12, one sprite under two editor numbers) and the two hanging-victim families — `…NoBlock` marks
the five non-solid, wider-radius twins (59-63) of the solid 49-53, a distinction
`SOLID_DECORATION_TYPES` turns on.

Each `ThingType` entry carries its vanilla `MT_*` name as a comment. `MOBJ_INFO`
(`game/dehacked/tables.ts`) is the checkable data twin of those comments — all 137 rows of
`info.c`'s `mobjinfo[]` in `mobjtype_t` order, which a DEHACKED `Thing N` record indexes into, and
which a test cross-checks against this table so the prose and the data cannot drift.
docs/dehacked.md § Thing records.

## Things as sprites (`wad/sprites.ts`, `render/sprites.ts`, `game/things.ts`, `game/things/tables.ts`)

`SpriteBank` (`wad/sprites.ts`) indexes `S_START`/`S_END` lumps by sprite name + frame letter,
resolving DOOM's `SSSSFR` / `SSSSFRfr` naming (a frame can list a second frame+rotation meaning
"this same lump, mirrored, is also that rotation" — the usual way DOOM halves the art needed for
symmetric actors). `things/tables.ts` maps THING doomednums to their sprite name; a type absent from
that table renders nothing, same as DOOM's own invisible spawn markers (player starts, deathmatch
spots, teleport landings) and Boom's two point-pusher control things, 5001/5002 — those exist only
as the source a type-226 line radiates its force from (docs/specials.md § Pushers), and a map's
*extra* player starts exist only as voodoo dolls (docs/specials.md § Voodoo dolls), which are
deliberately not drawn either.

### Rotation 0 against directional frames

A frame letter is drawn either from one omnidirectional `rot=0` lump or from eight directional ones,
and a merged set can end up holding **both** for the same letter — a PWAD giving eight rotations to
a frame the IWAD ships as `rot=0` (or the reverse). Vanilla refuses that set outright:
`R_InstallSpriteLump` (`r_things.c`) raises `I_Error("R_InitSprites: Sprite %s frame %c has
rotations and a rot=0 lump")` either way round. Boom does not — killough's `R_InitSpriteDefs`
rewrite walks each sprite's hash chain newest-first ("prepend so that later ones win") and
`R_InstallSpriteLump` keeps whichever lump claims a rotation slot first, with a `rot=0` lump
claiming all eight it still finds free. Net effect, and the rule this engine follows: **each of the
eight slots goes to the last lump in load order that claims it**, a `rot=0` lump claiming all eight.

`SpriteBank` reaches that from Boom's end rather than by ranking: it indexes **newest-first** and
lets the first claim on a slot stand, a `rot=0` lump taking every slot still free. A frame it
reaches untouched keeps its single `'0'` entry — the overwhelmingly common case — so nothing has to
be stored per frame to order it, and `lookup` stays two map reads.

Preferring `rot=0` unconditionally, as this did, is what made **NoSp3.wad**'s Cybruiser flicker back
into a Wolfenstein SS. That WAD's DEHACKED rebuilds `MT_SPIDER` (doomednum 7) out of the SS's state
block and ships `SSWVA1`-`SSWVJ8`, eight rotations each, over `DOOM2.WAD`'s rotation-0 `SSWVE0`-
`SSWVJ0`. Only letters `E`-`J` collide — the monster's attack and pain poses — so it walked and died
as a Cybruiser and attacked and flinched as vanilla SS art.

A `[SPRITES]` rename is deliberately *not* subject to load order: the aliases are indexed in a pass
of their own *before* the own-name lumps, claiming their slots first, or `POSS = ZOMB` would lose to
a `POSS*` lump still in the set. docs/dehacked.md § Sprite renames.

**The split between `render/sprites.ts` and `game/things.ts` follows the same rendering/game divide
as the rest of the tree.** `render/sprites.ts` only knows how to turn a (sprite name, frame letter,
viewer angle) into a posed plane — `SpriteAnimator`/`SpriteActor`/`SpriteMaterialCache`, no
knowledge of maps, AI, health or pickups. `game/things.ts` owns `buildThingSprites`: which map
things exist, their per-instance game state, and the update loop that ticks monster AI, applies
pickups/damage and drives drops. Its `things/` folder holds the record shapes those run on
(`defs.ts`: `ThingLayer`/`PosedThing`) and the spatial index they query (`grid.ts`,
docs/monster-ai.md § Spatial indexing).

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
- **Sector light rides along as a per-instance colour**, which *fixes* a pre-existing bug rather
  than merely preserving behavior: the one-mesh-each path tints by mutating the lump's **shared**
  material, so wherever several things shared a lump the last one posed each frame decided the light
  for all of them.

That per-instance colour needs one non-obvious thing. three.js's fragment shader only multiplies
`vColor` in under `USE_COLOR` — i.e. `material.vertexColors` — while `USE_INSTANCING_COLOR` alone
populates `vColor` in the *vertex* shader and is then ignored downstream. So the batch's materials
are clones with `vertexColors: true` and a white base colour, and `SpriteMaterialCache` gives every
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
instead. Nothing raycasts a batch either (see below), so no bounds are computed for it at all.

`SpriteAnimator` is what makes both paths possible: it owns the frame cycle and the state→(geometry,
material) lookup with **no `THREE.Object3D` of its own**. `SpriteActor` wraps one in a `THREE.Mesh`
for the **player**, now the only sprite that genuinely wants one: there is exactly one of it, and it
needs `setOpacity` (partial invisibility), which has no per-instance equivalent in a batch.
Everything else holds a bare `SpriteAnimator` and feeds a `SpriteBatch` — `PosedThing` for map
things, and `SpriteFxLayer`'s batch (`game/spritefx.ts`) for projectiles, impact explosions,
teleport fog and the revenant's smoke trail. Because a batched thing has no mesh of its own,
`PosedThing.visible` replaces what used to be read off `mesh.visible`.

**A batch is write-only: nothing reads geometry back out of it.** Auto-aim's
`ThingLayer.pickMonster` used to raycast the instance geometry, which forced the tic to re-fill the
whole batch at alpha 1 before every aim ray. It now tests the body's own `mobjinfo` box
(docs/combat.md § Auto-aim) and reads nothing from this file at all — not the lump, not the yaw
`begin()` fixes — so the batch can stay wherever the last frame left it. Keeping the drawn sprite
out of that answer is what keeps the simulation independent of the loaded WAD's art.

`ThingLayer` owns **two** batches under one `things` group: ordinary things, and monster death drops
— which are depth-biased (above) and `translucent`, so `setOpacity` can pulse them (docs/items.md §
Making monster drops readable). A `translucent` batch builds its material clones transparent, with
the alpha test dropped to 0.01 and `depthWrite` off, from the start: `setOpacity` runs every frame,
and flipping `transparent`/`alphaTest` on a live material would recompile its shader each time,
whereas `opacity` alone is a uniform write.

**The alpha test has to drop, and 0.01 is as good as any value below the lowest opacity used.** The
shared material tests at 0.5 against `texture.a * opacity`, which discards the *whole* sprite once
opacity falls under that. A WAD sprite's alpha is binary — 0 or 255, and `NearestFilter` never
blends between them — so any threshold under the lowest opacity in use cuts exactly the silhouette
the 0.5 test does. `depthWrite` stays off for the ordinary reason: one translucent plane among
opaque geometry would otherwise punch a hole in whatever draws after it. The fade is per *batch*,
not per instance — `instanceColor` carries no alpha, so a per-sprite fade would need a custom
shader.

### The spectre's fuzz

The spectre carries the demon's own `SARG` art (`THING_SPRITES`) and vanilla's `MF_SHADOW` flag, and
the flag is the entire difference between the two: `r_things.c: R_ProjectSprite` sets
`vis->colormap = NULL` for it, which makes `R_DrawVisSprite` swap in `R_DrawFuzzColumn`. That column
routine draws **none of the sprite's own pixels**. For every pixel of the silhouette it reads the
*background* one screen row up or down (`fuzzoffset[FUZZTABLE]`, alternating `±SCREENWIDTH`) and
runs it through colormap 6, so a spectre reads as a dark, shimmering hole in the scene rather than
as a monster, and `fuzzpos` walking the table each frame is what makes it shimmer.

`FUZZ_TYPES` (`game/things/tables.ts`) is that flag: `MT_SHADOWS` and nothing else in `info.c`, so
the spectre alone. It stays set through death — `P_KillMobj` clears
`MF_SHOOTABLE|MF_FLOAT|MF_SKULLFLY` and never `MF_SHADOW` — so a spectre's **corpse is fuzzed too**,
and the type-keyed set gets that right for free where a check on the live monster wouldn't have. The
player's invisibility powerup is the flag's one other vanilla user and deliberately does not come
through here: it is one sprite with a mesh of its own and fades via `SpriteActor.setOpacity` instead
(docs/items.md § Powerups and the backpack).

`ThingLayer` draws those things through a third batch, built `fuzz: true`, whose material clones
`SpriteBatch.applyFuzz` patches: the sprite is darkened to `FUZZ_DARKEN` and faded to a per-pixel
alpha between `FUZZ_ALPHA_MIN` and `FUZZ_ALPHA_MAX`, re-drawn every `FUZZ_STEP_SECONDS` from the
`uFuzzTime` uniform `ThingLayer.draw` writes. Three decisions there are load-bearing:

- **Blending, not a screen-door discard**, and the noise is not the wall fade's — see the section
  below, which is the whole argument. A `fuzz` batch is a `translucent` one whose alpha varies per
  pixel instead of coming from `setOpacity`, so it inherits that path's `depthWrite: false` and
  0.01 alpha test.
- **The shimmer steps on the tic, not the frame.** Vanilla advances `fuzzpos` once per frame in a
  35fps game; stepping `uFuzzTime` at `DOOM_TIC` reproduces that cadence instead of letting a 144Hz
  display shimmer four times as fast.
- **`customProgramCacheKey`.** A fuzzed sprite material shares every cache-key *parameter* with an
  ordinary batched one (same class, same flags, `vertexColors` on), and three.js keys its program
  cache on those. Without a key of its own, whichever compiled first would hand its program to the
  other — an unpatched spectre, or every sprite in the level drawn as fuzz.

**This is a look chosen against vanilla's, not an approximation of it, and that was decided by
eye.** A much closer reproduction was built and rejected: `MultiplyBlending` so the fragment writes
a darkening *factor* and the demon's art never reaches the screen at all (the shape of vanilla's
colormap-6 lookup, and the only way to get it without the framebuffer read a forward-rendered
material can't do), the silhouette sampled a texel up or down per column per step for
`fuzzoffset[]`'s crawl, and the darkening jittered per pixel to stand in for the displacement noise.
It is more faithful and it looks worse here — a top-down spectre is small on screen and vanilla's
effect leans on a first-person view's size and a floor-height camera. Don't rebuild it. What ships
is deliberately the cruder thing: the demon's own art, dark and mostly see-through.

`FUZZ_DARKEN` and the two `FUZZ_ALPHA_*` ends are therefore tuned by feel outright, with no vanilla
number underneath any of them, and are meant to be retuned by eye — a lower alpha range is a more
transparent spectre. The range's midpoint sits near the player's own `INVISIBILITY_OPACITY`, which
is the same `MF_SHADOW` in vanilla, so the two read at a comparable strength.

### Why the fuzz can't share the wall dither's noise

**The spectre's translucency must not be decided by a per-pixel threshold, and its noise must not
come from the generator `render/textures.ts` dithers the wall fade with.** Both are read at
`gl_FragCoord`, so a spectre standing behind a fading wall is masked twice, and if the two masks are
drawn from one generator they are not independent — the spectre's visibility becomes a function of
how they happen to line up rather than of the wall's fade.

That is not a theoretical risk; it is what the first version did. The fuzz seeded the *same*
interleaved gradient noise the wall dither uses by offsetting `gl_FragCoord` along the screen axes,
and because IGN is `fract(k · fract(dot(p, c)))`, an offset along `c` only *rotates* the value every
pixel already had: the fuzz mask was `fract(dither(p) + s)` for one screen-wide constant `s` per
tic. The two masks were nested one tic and nearly disjoint the next. Measured against the real
shaders, a spectre behind a wall faded to alpha 0.5 drew between **100% and 9%** of its silhouette
on consecutive tics — a 35Hz strobe that got worse the *less* the wall was faded.

Two independent changes close it, and both are needed:

- **The alpha is blended, not thresholded.** A blended sprite carries no mask of its own, so there
  is nothing for the wall's dither to correlate with — the same reason the player's partial
  invisibility never had this problem.
- **The noise is a different generator** (Hoskins' `hash13`), with the tic as a real third
  dimension rather than an offset along the screen axes. Reseeding by offsetting a 2D hash is what
  produced the rotation above; a third input cannot.

With both, the spectre's visible fraction behind a faded wall is exactly the wall's own hole
fraction and holds steady tic to tic (measured 0.50 / 0.70 / 0.85 at wall alpha 0.5 / 0.3 / 0.15,
and still fully hidden behind an unfaded wall). `tests/render/spectre-fuzz.test.ts` guards both
halves: the material must be `transparent` with no `discard`, and the two patched shaders must share
no noise constant.

The cost is that a fuzzed sprite leaves the opaque pass, which is what the discard bought. That is
affordable here and not for geometry: the batch is a handful of small planes with `depthWrite` off,
where the level's per-texture meshes span the whole map and would sort meaninglessly
(docs/render.md § Wall occlusion fading).

Nothing else about a spectre differs from a demon — same stats, same batch membership rules, same
`pickMonster` billboard, and no gameplay effect of `MF_SHADOW` is modelled.

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
- **The patch's `top` hotspot is not trusted for *floor* placement.** DOOM anchors a sprite at
  `thing.z + top` and gets away with the slack because its software renderer floor-clips every
  column and the camera sits near floor height. Neither safety net exists in an unclipped 3D
  top-down view, so a patch whose `top` is less than its full height (common, worst on small
  pickups) would draw with its feet below the floor — 5 units for a zombieman, an imp, a demon or
  the player. Art that stands on the floor — every map thing (`ThingLayer`) and the player's own
  `SpriteActor` — has its bottom edge anchored to the floor outright; `left` is still used as-is
  for horizontal centring.
- **Art in mid-air hangs from `top` after all**, because there is no floor to stand on and vanilla's
  own placement is what looks right: `CachedSprite.bottomOffset` is `top - height`, and
  `SpriteFxLayer.batchSprite` — the one funnel for missiles in flight, explosions, blood, puffs and
  the Icon of Sin's cubes — adds it to the drawn z. Without it a rocket's blast (`MISLB0`, 60 tall,
  hanging 31 below its point) bloomed straight up out of the impact instead of around it, and every
  missile left the shooter a few units high (docs/combat.md § Where a missile starts). The light a
  sprite offers is still keyed to its unshifted point: where the thing is, not where its art hangs.
- **Rotation frame (which of the 8 sprite angles) is picked from the live viewer angle** every frame
  (`pickRotationDigit`), same as the plane's own yaw.

### Pickup scale

**Ammo/health/armor/keys/powerups render `PICKUP_SCALE` (1.4×) larger than their native WAD pixel
size; nothing else does.** Vanilla's 1:1 unit-per-pixel sizing suits a ground-level view; from this
far, tilted camera small collectibles get lost.

**Both halves of that decision live in `src/constants.ts`** — the factor and `PICKUP_SCALE_TYPES`,
the whitelist of which doomednums take it — rather than the whitelist sitting with the other thing
tables in `things/tables.ts`. They are one tuned-by-feel presentation choice and get retuned
together; splitting them put the dial and the list of what it applies to in different files. It is a
whitelist of exactly those four blocks, not "everything but monsters/weapons" — monsters are already
large enough to read, weapons already stand out, and solid decorations/gore props (torches, columns,
trees, corpses) are already sized to fill a room or a body, so blowing them up another 40% on top of
vanilla's own size reads as oversized rather than more readable.

Carried per instance (`pickupScaleFor` in `game/things/defs.ts` → `PosedThing.scale` →
`SpriteBatch.add`) rather than baked into the shared per-lump geometry, since scale varies by thing
type even when two types reuse art. It composes safely with floor-anchoring: geometry is translated
so the plane's bottom-center sits at local `(0, 0)` *before* `scale` is applied, so scaling stretches
the plane upward and outward from that point instead of moving its anchor. The one unbatched sprite,
the player, never takes `PICKUP_SCALE` at all.

Animation (`SpriteActorOptions.animFrames`, `SpritePose.animating`) is a plain frame-letter cycle
with no separate idle art, matching DOOM itself: the player's `PLAY` sprite reuses `A,B,C,D` as its
walk cycle and holds `A` while not moving.

Monsters gate `animating` on whether they actually stepped this frame (`ThingLayer.update`), like
the player — but they run their own per-type frame tables rather than `THING_ANIM_FRAMES`, and a
monster's pose is also driven by attacking, pain and death (docs/sprites.md § Pain, and attack/pain
poses). Every non-monster thing (barrel sway, decoration flicker, item/key/ powerup blink) instead
animates unconditionally — vanilla's own idle art loops regardless of motion, there being none to
gate on. Which doomednums get more than the single held `'A'` frame `buildThingSprites` defaults to,
and their frame letters/timing, is data in `game/things/tables.ts`'s `THING_ANIM_FRAMES`
(cross-checked against `info.c`'s `states[]`, not the wiki). The same table also covers the opposite
case — a corpse/gib prop (the "Dead …"/"Bloody mess" doomednums) whose vanilla `spawnstate` is a
fixed frame that *isn't* `'A'` — with a single-element `frames` array naming that letter, so it
holds correctly instead of drawing the sprite's first (unrelated) frame. A doomednum absent from the
table either has vanilla `tics: -1` (genuinely static — ammo, weapons, STIM/MEDI, the plain column)
or spawns at the literal `'A'` frame already, and needs neither case.

Every one of these tables — `THING_SPRITES`, `THING_ANIM_FRAMES`, the seven `MONSTER_*_FRAMES`, the
barrel's `BARREL_CHAIN`, the missiles' flight and impact art — is **not written out at all**. Each
is filled at import by `dehacked/frames.ts`, which walks vanilla's `states[]` (transcribed in
`dehacked/states.ts`), and the same walker re-derives them from a patched copy when a DEHACKED
`Frame` record edits one. So every curation rule this doc describes — the distinct-letter rule, the
walk/attack split, which chains end where — is now a rule *of the walker*, and
`tests/game/dehacked-frames.test.ts` holds its reading equal to the frozen hand transcription in
`tests/fixtures/frametables.ts`. That pair is how two transcription slips were found, and the seven
places the two readings deliberately differ are listed in docs/dehacked.md § Frames.

## Fullbright frames

Vanilla draws a frame whose `state_t.frame` carries `FF_FULLBRIGHT` at full light whatever the
sector says — the torches and candles, keys, armor and powerups, the whole lost soul, every
projectile in flight and every explosion, the teleport fogs, the first puff frame, the spawn cube,
the player's and most monsters' firing frames. For a long time this engine reproduced none of it
(the Icon of Sin's cube was hardcoded to 255); now `things/tables.ts`'s `FULLBRIGHT_FRAMES` holds
every `SPRITE + LETTER` vanilla brightens, read off `dehacked/states.ts`, and three draw sites lift
a matching sprite to light 255: `ThingLayer.draw` for map things, `SpriteFxLayer.batchSprite` for
effects, projectiles and cubes, and the player's `SpriteActor`, which is handed the set at
construction so `render/` stays free of the game tables.

**The key is the logical `(sprite, letter)`, not the state and not the lump.** The animator knows
no state index — it holds letters — so the bit is reduced to the letter. Where vanilla draws one
letter bright in some states and dim in others, the states **vote and a tie is bright**; ten stock
letters split that way and the vote lands each where it looks right. The one that would not have
survived "bright if any state says so" is the spider mastermind's and arachnotron's `A_FaceTarget`
frame, letter `A` — their *walk* letter, bright in one state against three or four dim ones, and
they would have glowed the whole way across a room. The chaingunner's two firing frames (bright and
dim alternating through its refire loop) and the pain elemental's death frames (its never-played
raise frames, dimmed) tie and stay bright. `tests/game/dehacked-frames.test.ts` pins the list.
Logical rather than lump, because a `[SPRITES]` rename changes which lump `SpriteBank` hands back
and the set is keyed by the name the animator was given — and, for the same reason, because a skin
draws the player's frames out of another file entirely (§ Weapon-matching player sprites).

**`SpriteAnimator.frameKey`** is how the draw sites know what was drawn: the `SPRITE + LETTER`
the last `resolve` resolved, rebuilt only in the branch that re-fetches the material when the lump
changes, so the steady state pays nothing and the per-sprite cost at draw is one `Set.has` on a
five-character string — ~0.06 ms for the ten thousand NUTS.WAD can have on screen. A death drawn in
another sprite (the barrel's `BEXP`, a patched death chain) names that sprite.

A DEHACKED patch can add or clear the bit — `rebuildFullbrightFrames` refills the set from the
patched frame table, and freedoom2's does exactly that on the zombieman's firing frame, which
vanilla leaves dim (docs/dehacked.md § Frames).

## The animation index must always be valid

`SpriteAnimator` keeps **one** `animIndex` shared by three sequences — the base cycle,
`playOnce`'s override and `die`'s death chain — rather than one per sequence. That is cheaper day
to day and costs one rule, which every future sequence-switching method has to keep:

> `animIndex` is valid for whatever sequence `resolve` would read, **at every moment** — not merely
> after an `advance`.

Both directions of a switch can break it, and they are fixed in different places. A sequence
*ending* (an override running out, handing back to a shorter base cycle) is clamped inside
`advance`. A sequence *starting* is reset by `die`/`playOnce`/`revive` themselves.

The starting half was missing and went unnoticed for a long time, because ordering hid it: `advance`
and `resolve` sat adjacent in one loop, so the clamp always ran first. Splitting simulation from
drawing (docs/frameloop.md § What runs in a tic) removed that accident — a monster killed in
`MonsterAttacks.resolve`, *after* `ThingLayer.update` advanced it, is drawn before it is ever
advanced again. `resolve` then read `frames[animIndex]` as `undefined` and `SpriteBank.lookup` threw
on `frame.toUpperCase()`. Repro: NUTS.WAD, within seconds of waking the first crowd. Covered by
`tests/regression/anim-frame-after-state-change.test.ts`.

## Pain, and attack/pain poses

**`painChance` is `mobjinfo.painchance` over 256 exactly, and `painDuration` its `painstate` chain's
tics over 35.** Both are plain constants in the same table `MONSTER_HEALTH` already lifts from. An
earlier eyeballed set had the imp and demon shrugging off roughly half the hits that stagger them in
vanilla, and flattened pain length to one shared value where vanilla ranges from 4 tics (imp, demon,
baron barely flinch) to 12 (cacodemon, pain elemental recoil visibly). A stagger also *aborts*
whatever attack was under way, including the unfired shots of a volley, matching vanilla's pain
state replacing the attack state outright.

**The walk cycle defaults to `A`-`D` and overrides per type.** `MONSTER_WALK_FRAMES` is DOOM's RUN-
state convention, the same cycle `PLAY` uses and correct for most of the roster;
`MONSTER_WALK_FRAMES_OVERRIDE` (both in `things/tables.ts`) carries the eight types whose `seestate`
chain says otherwise, read off `info.c` by walking that chain to where it loops and keeping the
distinct frames: cacodemon `A` alone, lost soul `A`-`B`, pain elemental `A`-`C`, and `A`-`F` for the
arch-vile, revenant, mancubus, arachnotron and spider mastermind.

The flat default used to apply to everything, which was **visible on the cacodemon**: `S_HEAD_RUN1`
is a single state looping to itself, and `HEAD`'s `B`/`C` are its `missilestate` — so a cacodemon
just drifting toward you opened and closed its mouth continuously, biting art with no bite. That
overlap is what `tables.test.ts` now pins: no type's walk letters may appear in its own attack, pain
or death table. Every override letter was also confirmed to exist as real rotation frames in
`DOOM2.WAD`, the same check the death tables get below.

**Attack and pain each get a real, dedicated pose** (`things/tables.ts`'s `MONSTER_ATTACK_POSE`/
`MONSTER_PAIN_FRAMES`). The blocker an earlier walk-cycle stand-in was working around was real:
unlike death frames, which are derivable straight from the WAD because death art is structurally the
rotation-0-only tail of a sprite's frame set, attack and pain frames are ordinary rotation 1-8
frames indistinguishable from walk frames by structure alone. The fix was to stop deriving them from
the WAD and instead take vanilla's `info.c` `missilestate`/`painstate` chains and convert each
state's frame number to a letter — then verify every letter for every monster (walk + attack + pain
+ death [+ xdeath]) against the real `SpriteBank`-indexed lumps, checking each sprite's *total*
letter count against its WAD-confirmed rotation-1 range. All 18 sprites (17 monsters + `PLAY`)
matched exactly.

That cross-check caught **four pre-existing bugs** the WAD-derivation method had gotten wrong: the
lost soul, revenant and arch-vile's death tables were each missing their actual first frame
(`SKULF0`, and for the revenant/arch-vile a directional `SKELL1`-`8`/`VILEQ1`-`8` reused from their
own pain state — a genuine `info.c` quirk, exactly what a pure "eyeball the lump names" derivation
misses), and the chaingunner's death/xdeath split fell two letters too early, dropping `CPOSM0`/
`CPOSN0` and duplicating them into the gib tail.

**An attack pose lasts exactly as long as the attack it poses for, and keeps vanilla's own
proportions inside it.** The pain pose keeps the flat `MONSTER_ACTION_FRAME_SECONDS`, but an attack
pose is `MONSTER_ATTACK_POSE`'s frames scaled to fill `MonsterBody.attackPause`
(`attackPoseFrameSeconds`) — each frame holding its share of the chain's tics, not an equal slice.
Entering the pose goes through one function, `enterAttackPose`, for the reason `enterDeathPose`
does: the live trigger and the savegame restore below must not derive the same pose two ways.

The pose and the wait are the same vanilla states — `duration` is the `missilestate`/`meleestate`
chain's summed tics and those states are the frames the table lists — so getting either the length
or the proportions wrong makes them disagree. Both halves were wrong once, and each showed up
differently:

- **A flat overall rate** left the arch-vile posed for 30 tics of its 94-tic cast and standing in
  its idle frame for the other 64, through the back half of the windup and the blast itself
  (docs/monster-archvile.md § The attack). The mancubus had the same shape at 9 tics of 80. Covered
  by `tests/regression/vile-attack-pose.test.ts`.
- **An even split within the pose** put the *firing* frame in the wrong place. A monster fires
  partway into its chain (docs/monster-ai.md § The windup), vanilla marks that frame
  `FF_FULLBRIGHT`, and an equal slice does not land on it: the zombieman's chain is 10/8/8 tics, so
  two equal letters put its flash 13 tics in where `A_PosAttack` is at 10. With the shot itself
  firing at offset 0 at the time, the muzzle flash lit up four tenths of a second after the bullet.
  Repro: freedoom2's MAP01, whose DEHACKED brightens `S_POSS_ATK2`; the stock shotgun guy and
  chaingunner do it without any patch. Covered by `tests/regression/muzzle-flash-timing.test.ts`.

**The pose starts when the attack does, never when its shot lands.** With a real windup the firing
frame is mid-pose, so a pose triggered by the returned attack event would show the *wind-up* frame
under the bullet. `ThingLayer.update` starts it on whichever tic `attackPause` became non-zero and
guards on `SpriteAnimator.posing`, which is also what keeps a volley's later shots — the mancubus's
three, the chaingunner's refire loop — inside the pose they are already in rather than snapping it
back to frame one. Each of those shots then lands on its own firing frame, because the proportions
are vanilla's.

**The table is split by attack kind**, since a type's `meleestate` and `missilestate` are genuinely
different animations. Only the revenant has two distinct chains (`SKEL` `G`-`I` punches, `J`-`K`
throws); the imp, demon, baron and hell knight point both pointers at one chain and share a single
pose. Before the split, one merged letter list covered both kinds because the sprite layer had no
"which attack" signal — `enterAttackPose` now takes the kind from `MonsterAttack.kind`, or, on the
tic a *melee* attack starts (whose claw is a windup away, so no attack event exists yet), from
`MonsterBody.swinging`.

Both tables play through `SpriteAnimator.playOnce`, not `die`: a third animation mode alongside the
permanent one-shot-then-hold `die` and the looping alive cycle, playing its frames forward once and
handing back to the walk cycle on its own — which is what makes it reusable for both attack and pain
(each a transient interruption, not a permanent state change). A later `playOnce` (a pain flinch
landing mid-attack pose) simply replaces whatever was playing, matching vanilla's state machine,
which has no queueing either.

`ThingLayer.update` triggers the attack pose where it already detects `stepMonsterAI` returning a
fired attack, and the pain pose inside `damage()` right after `reactToDamage` — gated on
`p.painTimer > 0` rather than every non-lethal hit, since `reactToDamage` only sets it when the hit
rolls past the monster's `painChance` (a failed roll still alerts and retargets, just doesn't
stagger). The player's own letters (`things/tables.ts`'s
`PLAYER_ATTACK_FRAMES`/`PLAYER_PAIN_FRAMES`, derived and WAD-checked the same way) trigger
analogously: attack whenever `WeaponSystem.fire` returns a nonempty `Shot[]`, pain inside
`damagePlayer` whenever the player survives a hit.

## Weapon-matching player sprites

The player's billboard draws the weapon it is holding: `render/playerskin.ts`'s
`PLAYER_WEAPON_SPRITES` (`fist` → `PLA1` … `supershotgun` → `PLA9`), picked per frame from
`inventory.currentWeapon`. Not vanilla, which draws one `PLAY` body for all nine. The file itself,
the setting and whether the loaded set draws its own player are `wad/playerskin.ts`'s;
`render/playerskin.ts`'s `PlayerSkins` owns the banks and answers which skin to draw.

The art is the ZDoom **WeaponMatchingPlayerSkin 1.1** pack, converted to
`assets/playerskins.wad` by `scripts/build-playerskins.ts` — 426 lumps, ~589 KB — and folded into
the WAD the engine ships (docs/wad.md § The WAD the engine ships) at build time. Only frames
`A`-`N` are converted: the letters this engine animates (walk `A`-`D`, attack `E`/`F`, pain `G`,
death `H`-`N`). `O`-`W` is xdeath and the `PL1C`…`PL9C` sets are crouch art, neither of which this
engine has. The converter fails on a pixel outside PLAYPAL rather than picking a nearest colour, and
re-reads its own output through `SpriteBank`/`GraphicsBank` before writing, asserting every weapon
resolves at all eight rotations for `A`-`G` and at rotation 0 for `H`-`N`.

**The skin file is never added to the loaded `Wad`.** `wadSetId` turns every entry of `wad.files`
into a savegame's WAD-set identity, so a set it joined would refuse every existing save and stamp a
phantom file onto new ones (docs/savegames.md § WAD-set identity). `PlayerSkins` gives it a
`Wad`/`SpriteBank`/`GraphicsBank`/`SpriteMaterialCache` of its own instead. It ships no PLAYPAL
and borrows the loaded set's through `GraphicsBank`'s optional palette argument, so a WAD with its
own palette recolours the skins along with everything else. Nothing about the skin is saved —
`currentWeapon` already restores it.

**The drawn lump is `PLA2A1`; `frameKey` stays `PLAYA`.** `SpriteAnimator.setSkin` swaps the bank,
material cache and sprite name a `resolve` looks up, and deliberately leaves the frame key on the
name the animator was given: `FULLBRIGHT_FRAMES` holds `PLAYF` and GLDEFS binds the muzzle flash to
that key (docs/lights.md § The frame key), and both stop matching the moment the skin name leaks
into it. `lastKey` carries a `:s` marker while a skin answered, because the same lump name can live
in both material caches and that one key gates both the cached sprite and `frameKey`. A frame the
skin has no lump for falls back to the animator's own art.

`setSkin` touches no sequence state: a weapon swapped mid-stride must not restart the walk cycle,
one swapped mid-death must not restart the death chain (§ The animation index must always be valid).
A corpse goes on holding the weapon it died with.

### When the skins apply

The `playerSprites` setting (docs/menu.md § Persisted settings) is `auto`, `always` or `never`, read per
drawn frame so the menu applies it to the running level. `auto`, the default, stands the skins down
where `setDrawsOwnPlayer(wad)` says the set draws the player its own way:

- a DEHACKED `[SPRITES]` line pointing `PLAY` elsewhere (`spriteLumpFor`), or
- a file after the game WAD shipping a `/^PLAY[A-W][0-8]/` lump — the rotation digit is what keeps
  `PLAYPAL` out of that pattern, and losing it would stand the skins down on every set, or
- a game WAD whose own `PLAYA1`/`PLAYE1` do not hash to vanilla's, which is what leaves Freedoom's
  marine alone (both lumps are byte-identical in `DOOM1.WAD` and `DOOM2.WAD`).

A false positive is the safe direction: it only leaves that set's player drawing its own art.

A fetch that fails resolves to null and the player draws `PLAY`, silently — the game as it was
before the file existed, and never a reason a level cannot start.

### When a patch moves a weapon's shot

Which of the nine is drawn is `WeaponDef.skinWeapon`, not the weapon in hand — `playerSkinWeapon`
(`game/weapons.ts`) is the one reader. Unpatched it is the identity. A DEHACKED patch that repoints
a fire chain at another weapon's firing action moves the art with the shot: nosp4.wad's chainsaw
fires rockets, so the player is drawn holding the launcher. Only what a weapon *fires* moves it — a
retimed chain or a bare `Ammo type` line leaves the art alone, a faster chaingun being still a
chaingun.

A shot that resolves to no weapon at all — an MBF pointer, or a chain left firing nothing — clears
`skinWeapon`, and that takes the **whole set** out of use: every weapon falls back to the loaded
set's own `PLAY`. Art that lies about one weapon in hand is worse than no weapon-matching art, and
skins that come and go as the player switches are worse than either. Restored by `resetDehacked`
with the rest of `WEAPONS` — docs/dehacked.md § Action pointers.
