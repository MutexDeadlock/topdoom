# Things as sprites

`src/wad/sprites.ts`, `src/render/sprites.ts`, `src/render/spritebatch.ts`, `src/game/things.ts`,
`src/game/thingdefs.ts`, `src/game/thingtypes.ts`

How a thing gets *lit* is docs/render.md § Sector lighting; how one gets hidden behind geometry
is docs/fogofwar.md.

## Thing types have names

Every doomednum this engine knows sits in `game/thingtypes.ts` as a named member of one `as const`
object, and **every type-keyed table keys through it** — `THING_SPRITES`, `MONSTER_STATS`, the pickup
records in `inventory.ts`, the membership sets, all of them — rather than spelling the number:

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

`thingtypes.ts` imports nothing, so any table module can take it without a cycle — the same leaf
property `thingdefs.ts` has, for the same reason (docs/monster-attacks.md § Resolving an attack).

Names distinguish types that share art rather than collapsing them: `bloodyMess`/`bloodyMessAlt` (10
and 12, one sprite under two editor numbers) and the two hanging-victim families — `…NoBlock` marks
the five non-solid, wider-radius twins (59-63) of the solid 49-53, a distinction
`SOLID_DECORATION_TYPES` turns on.

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
`ThingLayer`/`PosedThing`) and the spatial index they query (`grid.ts`, docs/monster-ai.md § Spatial
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

### Pickup scale

**Ammo/health/armor/keys/powerups render `PICKUP_SCALE` (1.4×) larger than their native WAD pixel
size; nothing else does.** Vanilla's 1:1 unit-per-pixel sizing suits a ground-level view; from this
far, tilted camera small collectibles get lost.

**Both halves of that decision live in `src/constants.ts`** — the factor and `PICKUP_SCALE_TYPES`,
the whitelist of which doomednums take it — rather than the whitelist sitting with the other thing
tables in `thingdefs.ts`. They are one tuned-by-feel presentation choice and get retuned together;
splitting them put the dial and the list of what it applies to in different files. It is a whitelist
of exactly those four blocks, not "everything but monsters/weapons" — monsters are already large
enough to read, weapons already stand out, and solid decorations/gore props (torches, columns, trees,
corpses) are already sized to fill a room or a body, so blowing them up another 40% on top of
vanilla's own size reads as oversized rather than more readable.

Carried per instance (`pickupScaleFor` in `game/things/defs.ts` → `PosedThing.scale` →
`SpriteBatch.add`) rather than baked into the shared per-lump geometry, since scale varies by thing
type even when two types reuse art. `SpriteActor.setScale` is the same value applied to a real
`mesh.scale` for the one unbatched sprite, the player — which never takes `PICKUP_SCALE`. It composes
safely with floor-anchoring: geometry is translated so the plane's bottom-center sits at local
`(0, 0)` *before* `scale` is applied, so scaling stretches the plane upward and outward from that
point instead of moving its anchor.

Animation (`setPose`'s `animFrames`/`animating`) is a plain frame-letter cycle with no separate idle
art, matching DOOM itself: the player's `PLAY` sprite reuses `A,B,C,D` as its walk cycle and holds `A`
while not moving.

Monsters gate `animating` on whether they actually stepped this frame (`ThingLayer.update`), like the
player — but they run their own per-type frame tables rather than `THING_ANIM_FRAMES`, and a monster's
pose is also driven by attacking, pain and death (docs/sprites.md § Pain, and attack/pain poses).
Every non-monster thing (barrel sway, decoration flicker, item/key/
powerup blink) instead animates unconditionally — vanilla's own idle art loops regardless of motion,
there being none to gate on. Which doomednums get more than the single held `'A'` frame
`buildThingSprites` defaults to, and their frame letters/timing, is data in `game/thingdefs.ts`'s
`THING_ANIM_FRAMES` (cross-checked against `info.c`'s `states[]`, not the wiki). The same table also
covers the opposite case — a corpse/gib prop (the "Dead …"/"Bloody mess" doomednums) whose vanilla
`spawnstate` is a fixed frame that *isn't* `'A'` — with a single-element `frames` array naming that
letter, so it holds correctly instead of drawing the sprite's first (unrelated) frame. A doomednum
absent from the table either has vanilla `tics: -1` (genuinely static — ammo, weapons, STIM/MEDI, the
plain column) or spawns at the literal `'A'` frame already, and needs neither case.

## Pain, and attack/pain poses

**`painChance` is `mobjinfo.painchance` over 256 exactly, and `painDuration` its `painstate` chain's
tics over 35.** Both are plain constants in the same table `MONSTER_HEALTH` already lifts from. An
earlier eyeballed set had the imp and demon shrugging off roughly half the hits that stagger them in
vanilla, and flattened pain length to one shared value where vanilla ranges from 4 tics (imp, demon,
baron barely flinch) to 12 (cacodemon, pain elemental recoil visibly). A stagger also *aborts*
whatever attack was under way, including the unfired shots of a volley, matching vanilla's pain state
replacing the attack state outright.

**The walk cycle defaults to `A`-`D` and overrides per type.** `MONSTER_WALK_FRAMES` is DOOM's RUN-
state convention, the same cycle `PLAY` uses and correct for most of the roster;
`MONSTER_WALK_FRAMES_OVERRIDE` (both in `thingdefs.ts`) carries the eight types whose `seestate`
chain says otherwise, read off `info.c` by walking that chain to where it loops and keeping the
distinct frames: cacodemon `A` alone, lost soul `A`-`B`, pain elemental `A`-`C`, and `A`-`F` for the
arch-vile, revenant, mancubus, arachnotron and spider mastermind.

The flat default used to apply to everything, which was **visible on the cacodemon**: `S_HEAD_RUN1`
is a single state looping to itself, and `HEAD`'s `B`/`C` are its `missilestate` — so a cacodemon
just drifting toward you opened and closed its mouth continuously, biting art with no bite. That
overlap is what `tables.test.ts` now pins: no type's walk letters may appear in its own attack, pain
or death table. Every override letter was also confirmed to exist as real rotation frames in
`DOOM2.WAD`, the same check the death tables get below.

**Attack and pain each get a real, dedicated pose** (`thingdefs.ts`'s `MONSTER_ATTACK_FRAMES`/
`MONSTER_PAIN_FRAMES`). The blocker an earlier walk-cycle stand-in was working around was real:
unlike death frames, which are derivable straight from the WAD because death art is structurally the
rotation-0-only tail of a sprite's frame set, attack and pain frames are ordinary rotation 1-8 frames
indistinguishable from walk frames by structure alone. The fix was to stop deriving them from the
WAD and instead take vanilla's `info.c` `missilestate`/`painstate` chains and convert each state's
frame number to a letter — then verify every letter for every monster (walk + attack + pain + death
[+ xdeath]) against the real `SpriteBank`-indexed lumps, checking each sprite's *total* letter count
against its WAD-confirmed rotation-1 range. All 18 sprites (17 monsters + `PLAY`) matched exactly.

That cross-check caught **four pre-existing bugs** the WAD-derivation method had gotten wrong: the
lost soul, revenant and arch-vile's death tables were each missing their actual first frame
(`SKULF0`, and for the revenant/arch-vile a directional `SKELL1`-`8`/`VILEQ1`-`8` reused from their
own pain state — a genuine `info.c` quirk, exactly what a pure "eyeball the lump names" derivation
misses), and the chaingunner's death/xdeath split fell two letters too early, dropping `CPOSM0`/
`CPOSN0` and duplicating them into the gib tail.

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
stagger). The player's own letters (`thingdefs.ts`'s `PLAYER_ATTACK_FRAMES`/`PLAYER_PAIN_FRAMES`, derived
and WAD-checked the same way) trigger analogously: attack whenever `WeaponSystem.update` returns a
nonempty `Shot[]`, pain inside `damagePlayer` whenever the player survives a hit.
