# Testing

`tests/`, run with `npm test`

```bash
npm test          # node --test over tests/**/*.test.ts
npm run test:watch
npm run typecheck # the other gate; must stay clean with tests/ in tsconfig's include
```

The runner is **Node's own `node --test`, with no dependencies and no build step**. Node strips
the TypeScript natively, the same mechanism `scripts/inspect-wad.ts` already relies on, so a test
imports `src/` modules directly with their `.ts` extensions. Every module in `src/` imports
cleanly under bare Node except `src/main.ts`, which calls `document.getElementById` at module
scope; `three` itself imports fine, so a module pulling it in transitively is still testable.

Two runner details worth knowing before editing the scripts: a bare directory positional
(`node --test tests`) fails with `Cannot find module`, so the glob is required and must be quoted
so *node* expands it rather than the shell. And `--disable-warning=ExperimentalWarning` is there
for one reason — `game/player.ts`'s module-scope `globalThis.localStorage?.getItem(...)` makes
Node print a `localStorage is not available` warning on every test file. Making that read lazy
would remove the need for the flag.

Node runs **one process per test file**, which is what contains `player.ts`'s module-level
`autorunEnabled` and any `Math.random` patch. Don't rely on state crossing files.

## Layout and suite names

`tests/` mirrors `src/`, plus two directories of its own:

```
tests/
  util/  wad/  game/  ui/  render/  audio/   one file per src/ module under test
  regression/            one file per fixed bug, named after the bug
  fixtures/              builders and test data, never tests
  docs/                  the tree-wide guards: doc pointers, WAD fixtures, layer splits
```

**Every test file wraps its tests in one or more `describe` blocks named
`Subject area · what it covers`** — `Geometry · convex polygons`, `WAD parsing · lump names`,
`Vanilla tables · monsters`, `Regressions · fog reveal radius`. That is what turns the run into
grouped output instead of forty flat lines, and it is why a file big enough to span two subjects
(`tables.test.ts`, `geom.test.ts`) carries more than one block rather than one vague heading.

Because the directories mirror `src/`, each subject area comes out contiguous, and the ordering is
stable run to run — node walks the glob in order and buffers each file's output. Nothing depends on
that order, so don't write a test that does.

## What is and isn't covered

Round one is the two regressions from the chaingunner bug, the pure functions, and the
vanilla-table invariants. `WeaponSystem`'s selection half joined them (`game/weapons.test.ts`): it
takes no constructor arguments and `handleSwitching`/`update` reach it through a stubbed
`Input` and a two-line `AudioEngine`, so the "switch to previous weapon" toggle is pinnable without a
DOM. The savegame suite joined next (`game/snapshot.test.ts`, `game/savegames.test.ts`,
`game/specials-snapshot.test.ts`, `game/things-snapshot.test.ts`, `game/spritefx-snapshot.test.ts`),
and the round-trips prove behavioral equality — save mid-motion, rebuild over a fresh grid map, then
tick original and restored in lockstep and compare positions and the RNG cursors, not just fields.
The store itself has no `indexedDB` to reach in Node, so it takes an injected backend instead
(`setSaveBackend`, two `Map`s standing in for the two object stores); the gzip and base64 codecs
around it are **not** stubbed, since `CompressionStream` is global in Node and a compression
round-trip that isn't the real one proves nothing. The `ThingLayer` and `SpriteFxLayer` tests reach
`buildThingSprites`/`spawn` headless through a name-only `SpriteBank` stub and a three-field
`SpriteMaterialCache` stub (`fixtures/spritestubs.ts`, plus its `recordingBank` variant that keeps
the frame letters it was asked for), since both layers only ever *key* batches by lump name during a
tic — which is also what lets the fog test read back the frame letter a restored puff resumes on.
The telefrag rules ride that same headless layer (`game/telefrag.test.ts`): `telefragAt` is driven
directly, while the player half of a landing lives in `game.ts` and stays out with the rest of it.
The music subsystem joined with everything below `MusicPlayer` (`audio/music.test.ts`): the score
decoders and the vanilla per-map table are pure, and the OPL chip and its synth need no DOM at all
— a note is keyed on and the rendered samples are measured, which is how "a released note stops"
and "channel volume scales it" are pinned without ears. Only `MusicPlayer` itself, which owns the
`AudioContext`, stays out. Deliberately **not** covered yet, and why:

- **`SpecialsController`'s mover state machine**, partly. The whole controller stands up headless
  through `fixtures/specialsrig.ts` (§ The specials rig), and **anything observable from outside is
  the way to test it**: `strobing-lift-light.test.ts` drives `update` for the geometry it recolors,
  `teleport-back-side.test.ts` and `silent-teleport.test.ts` go through the `onTeleport` callback,
  and most mover behavior is visible as `map.sectors[i].floorHeight` changing over ticks.

  Where a rule genuinely has no outside face — which slot a mover landed in, whether a stasis wake
  reported a hit — the tests reach the private field through a narrow
  `as unknown as { … }` cast naming only what they touch (`switch-gating.test.ts` set the
  precedent; `moverclasses.test.ts` and `toggle-plats.test.ts` follow it). That is deliberately
  ugly, so it stays confined to rules that are otherwise unobservable, and is still preferred over
  widening the class's visibility. `tickDoor`/`tickLift` remain untested as pure functions; doing
  that properly means extracting the per-mover tick into `(state, dt) → state`, which nothing has
  needed yet.
- **`ProjectileLayer` / `SpriteFxLayer`** — every `spawn*` short-circuits on `SpriteAnimator.resolve`,
  so a stubbed run would test the stubs. Test at `shotPath` level instead; `playerShotRange` exists
  as a separate exported function precisely so the range selection is reachable without the layer.
- **`src/render/` (anything that needs a GL context), `src/ui/`, `main.ts`, `game.ts`,
  `audio/audio.ts`, `audio/music.ts`** — need a DOM or a renderer. Three carve-outs: `render/bsp.ts` *is* covered,
  being pure geometry despite where it lives; so is any pure helper a DOM module happens to export —
  `tests/ui/hud.test.ts` covers `hud.ts`'s `formatClock`/`percentOf` while `Hud` itself stays out;
  and *constructing* THREE objects is fine on its own, only rendering them isn't, which is what lets
  `tests/render/billboard-pick.test.ts` hold `intersectBillboard` against both a `SpriteBatch`
  instance matrix and a `THREE.Raycaster` over the same quad.
- **Performance.** Hot paths are measured deliberately, in a script, on a quiet machine. A timing
  assertion in the suite turns a loaded machine into a red build and teaches everyone to ignore it.

## The grid fixture

`tests/fixtures/gridmap.ts` turns ASCII art into a real `DoomMap`, so a test states its geometry
in two lines instead of hand-numbering vertexes:

```ts
const grid = gridMap([
  '#############################',
  '#########################...#',   // alcove
  '#..........................+#',   // corridor, shut door into it
  '#############################',
]);
const world = new World(grid.map);
```

**Every cell is its own sector and its own subsector.** `grid.index(col, row)` is that one number,
which is also what makes a REJECT matrix statable by cell (`gridMap`'s `reject` option, used by
`sight-reject.test.ts`). It is what removes the need for a BSP compiler: the partition tree is a
column chain with a row chain inside each column, `cells − 1` nodes from a trivial recursion. The cost is that the fixture can only express axis-aligned
geometry — for anything diagonal, load one of the committed WADs instead.

**There is no void space. A wall is a cell whose sector has `ceilHeight === floorHeight`.** Every
predicate that matters keys off `World.openingOf`, and a zero-height opening reads as blocked by
all of them. This is what lets `#` and `+` differ in exactly one bit:

| glyph | sector | linedef flags | `isSolidWall` | `blocksSight` |
|---|---|---|---|---|
| `.` | floor 0, ceiling 128 | `TWO_SIDED` | false | false |
| `#` | 0, 0 | `TWO_SIDED \| BLOCKING` | **true** | true |
| `+` | 0, 0 | `TWO_SIDED` | **false** | true |

That `+` row reproduces the `blocksSight`-vs-`isSolidWall` divergence
[fogofwar.md](fogofwar.md) documents — a shut door is a two-sided line vanilla never flags
`BLOCKING`, so sight has to be stopped by the opening test rather than by the movement predicate.

### Conventions the builder depends on

Change any of these and the polygons come out inside-out or empty:

- **A cell's boundary is wound clockwise** — west edge `+Y`, north `+X`, east `−Y`, south `−X`. A
  front sidedef faces right of `v1→v2`, `clipConvexPolygon` keeps `dx·(y−py) − dy·(x−px) ≤ 0`, and
  `World.subsectorAt` tests the same sign, so one winding satisfies the renderer, the clipper and
  the point-locator at once.
- **Partition sense.** A vertical partition `{x: X0, y: 0, dx: 0, dy: 1}` has `rightChild` on the
  `+X` side; a horizontal `{x: 0, y: Y0, dx: 1, dy: 0}` has it on the `−Y` (south) side.
- **The root node must be last in the array.** Both `subsectorAt` and `buildSubSectorPolys` start
  at `nodes.length - 1`, so each builder pushes its own node *after* recursing.
- **Segs carry their own `v1`/`v2`**, in cell-clockwise order regardless of how the linedef runs;
  `direction` is 0 or 1 by whether they match, which is what `sectorOfSubSector` resolves the
  owning sidedef through.

The check that all four hold: on a 31×3 grid, `buildSubSectorPolys` returns 93 polygons with **0
degenerate and every area exactly `cell²`**, and `sectorIndexAt(centre)` matches the cell index for
all 93. A winding or partition error breaks one of those two immediately.

### Cell size and tunnelling

`positionBlocked` only consults lines the **destination** box overlaps, so a step longer than a cell
lands clean inside the next one and reports free. That is the engine's real behaviour — vanilla
`P_TryMove` has the same property — not a fixture artifact, but it is easy to write a movement test
that silently exercises it. On `gridMap(['...', '.#.', '...'])` (cell 128, so the wall cell spans
x 128..256), a 160-unit westward slide from `(320, 200)` ends at `(160, 200)` — *inside* the wall
cell, reported free. Keep `cell` comfortably larger than any single move plus the mover's radius.

The same property means **a wall cell's interior is not blocked** — only its boundary lines are.
`positionBlocked` at that `#` cell's centre `(192, 192)` with radius 16 returns `false`, because a
128-unit cell has real floor inside it. Probe near a boundary, not at a centre.

Uniform cell heights also mean `hasLineOfSight`'s floor/ceiling sampling loop never narrows
anything. A test meaning to exercise that half of the function must build a real step or low
ceiling through the `heights` option, or it only looks like it covers it.

### Control lines

`addControlLine(map, dx, dy, special, tag)` appends a Boom parameter line — a scroller, a conveyor,
a friction or a pusher line — **outside** the playfield, at `(-4096, -4096)`, so it configures its
tagged sectors without becoming geometry any body can touch. Its `dx`/`dy` are the dial every one of
those specials reads (length and direction, not a speed), which is why it takes a vector rather than
a magnitude. Append it before building the `World`, so the two agree how many linedefs exist.

## The BSP fixture

`tests/fixtures/bspmap.ts` builds a `DoomMap` from a hand-written BSP: `bspMap({vertexes, floors,
sidedefs, linedefs, segs, subsectors, nodes, half})` plus the record builders `wall`, `twoSided`,
`seg`, `leaf` and `plane`. It fills in everything `buildSubSectorPolys` never reads (name, node
format, things, reject), so a fixture states only its geometry, and it takes sectors as floor
heights and sidedefs as sector indexes rather than whole records.

The grid fixture above cannot stand in for it: `gridMap` always emits a *correct* tree, one
subsector per cell with every edge as a seg. The render rules that need this one are precisely
about what a node builder left behind — a wall stub sitting inside a leaf that never got split
along it, or a line whose two sides face the same sector (docs/render.md § Walls that stop inside
their cell, § Self-referencing sectors). Both are stated by choosing the nodes and segs by hand,
which is also why these fixtures are deliberately tiny: a wrong node here is a wrong test, and the
partition convention (a node's right side is `cross <= 0`) is easy to get backwards.

## The specials rig

`tests/fixtures/specialsrig.ts` puts a real `SpecialsController` over a `gridMap` in one call —
`specialsRig(map, at, { onExit, onTeleport, onCrush, … })` — instead of the fifteen positional
arguments its constructor takes. It also exports the two stubs that go with it (`BANK`, `NO_INPUT`)
and `TIC`, so a test needing a mesh or an input for something else takes them from here rather than
declaring its own.

Those two are `pressed`-shaped, for the use key. The movement half lives in
`tests/fixtures/input.ts`: `heldInput('KeyW')` builds an `Input` holding exactly the keys named and
`IDLE_INPUT` holds nothing, which is all `Player.update` ever asks its input for. Any test driving
the player takes one of those rather than casting its own object literal — there were three
byte-identical copies of that cast before.

**It is a rig, not a mock.** The controller, `World`, `FogOfWar` and the built mesh below it are all
the production objects; only the `MaterialBank` and `Input` are stubs, and only because the first
wants a GL context and the second a keyboard. What the rig removes is the boilerplate, not the
behavior under test — which is why the five tests that drive specials (`specials-snapshot`,
`switch-gating`, `strobing-lift-light`, `teleport-back-side`, `boss-death-over-corpse`) all go
through it. Every one of them had its own byte-identical copy of that constructor call before, so a
sixteenth argument was a five-file edit.

The one predicate a test is likely to want back is `blocksFloorRise`, which defaults to "nothing is
ever in the way": `inverted-moves.test.ts` holds a mover against a body without headroom by
supplying it, rather than putting a real body near the sector.

`tick(dt, x, y)` mirrors `update`'s own argument order and defaults to one `TIC` at the rig's start
position: a test that moves nobody writes `tick()`, one that walks the player writes
`tick(TIC, x, y)`. The rig's own `scene` is the group the controller hangs its mover meshes on, so a
test that needs to read those back takes it from there, as `strobing-lift-light` does.

## Markup partials

`tests/ui/markup.test.ts` assembles `index.html` through `plugins/html-partials.ts`'s own
`assemblePage` — the same expansion the build runs, so the test can't drift from it — and checks
the result three ways: every id a module looks up exists in it, every id in it is reached from some
`.ts` or `.css`, and every `src/ui/**/*.html` on disk is actually `@include`d somewhere.

It exists because the markup is one file per owning module (docs/styles.md § One owner per
element). A dropped `@include` removes a whole panel from the page while the build stays green, and
the only symptom is a `null` in some module's field initializers — the hardest place to read it.
Id lookups are matched as literals (`getElementById('x')` and the `el<T>('x')` helper), which is
every lookup in the tree; `querySelector` selectors are not checked.

## The DEHACKED layer split

`tests/docs/dehackedlayers.test.ts` walks the runtime import graph and asserts that nothing which
only *reads* a patch — `wad/library.ts`, `plugins/wad-manifest.ts` — can reach
`game/dehacked/apply.ts`, which pulls every game table and `structuredClone`s all of them at import
(docs/dehacked.md § The two entry points). It is a graph property rather than a behavior, because
ES re-exports are eager: a single `export { applyDehacked } from './dehacked/apply.ts'` in
`game/dehacked.ts` reinstates the whole cost with nothing else changing.

`dehacked/states.ts` — the 967-row frame table — is read-side and import-free, so it may sit in that
graph; so is `dehacked/frames.ts`, the pure walker the game tables fill themselves from at import.
`tests/game/dehacked-frames.test.ts` carries the two anchor tests: the walker's reading of the
unpatched table must equal the frozen hand transcription in `tests/fixtures/frametables.ts`, bar the
four documented overrides, and the tables the engine actually animates and fires from must equal
that transcription outright — the pose and duration tables, and all nine weapon rates
(docs/dehacked.md § Frames, docs/weapons.md § Fire rates).

`import type` / `export type` edges are skipped — they are erased, and are how `dehacked/tables.ts`
names `WeaponId` without depending on `inventory.ts` at runtime. The suite carries a **positive
control** (`game.ts` must reach the applier, across a graph of 50+ modules), because a walker that
silently resolved nothing would satisfy every negative assertion in the file.

## Doc references

`tests/docs/references.test.ts` asserts that every `docs/<name>.md § <Heading>` pointer in `src/`,
`tests/`, `scripts/` and `plugins/` resolves — the file exists and some heading in it starts with
the quoted words. It exists because splitting the Icon of Sin's own doc out of the monster AI one
left five pointers naming a file that no longer held their section, and nothing noticed until a doc
audit.
Any future split will do the same unless this test runs first.

Two matching rules it deliberately encodes, because both shapes are all over the tree:
- **Prefix, both directions.** A pointer may truncate a long heading (`§ The lost soul` for "The
  lost soul: a charge, not a projectile"), and a pointer written mid-sentence trails into prose. A
  heading's own leading words, up to the parenthetical file list most carry, must match.
- **It must be a heading**, not a bold lead-in paragraph. A bold paragraph isn't addressable, so a
  pointer at one is repaired by promoting the paragraph to a `###`.

## WAD-backed tests

**A test never reads `public/wads/`, and every WAD a test reads lives in `tests/fixtures/wads/`.**
That directory is the *game's* content — what a player drops WADs into and what the manifest plugin
serves — so a test reaching into it couples the suite to the shipped set, and a WAD added or removed
there for gameplay reasons breaks tests that have nothing to do with it. It also means no test has
to guard itself against a missing file: everything under `tests/fixtures/wads/` is committed, so a
WAD-backed test runs everywhere, unconditionally. `tests/docs/fixturewads.test.ts` enforces both
halves — no `public/wads` path outside a comment anywhere in `tests/`, and no committed fixture WAD
that nothing loads.

Fixture WADs are loaded through **`fixtureWad(name)`** (`fixtures/wadfile.ts`), which resolves the
name against `./wads/` with `new URL(…, import.meta.url)` so the suite is cwd-independent and slices
the bytes out of the pooled buffer — `readFileSync` returns a view into a shared `ArrayBuffer`, and
passing `.buffer` raw hands `WadFile` the whole pool. Both steps are easy to forget and neither
fails loudly, which is why every WAD-backed test goes through the one helper.

### The fixtures

Four tiny purpose-built maps, each carrying its own map and loading with **no IWAD**, with a loader
beside them in `tests/fixtures/` (or, for the newest, inside the one test that uses it):

| WAD | Geometry | Loader | Covers |
|---|---|---|---|
| `long_corridor_with_chaingunner.wad` | 3648-unit corridor, chaingunner 3584 out | `corridor.ts` | both chaingunner regressions |
| `pinky_below_test.wad` | two rooms split at `y=128`, far floor **-72** (pit) | `pinky.ts` | vertical melee reach |
| `pinky_above_test.wad` | same, far floor **+88** (ledge) | `pinky.ts` | vertical melee reach |
| `caco_pit_test.wad` | one room split at `y=32`, far floor **-48**, cacodemon in it (`E1M1`) | in-test | floating monsters over a ledge |

Plus six holding **real lumps**, for the assertions whose whole point is that a shipped WAD's own
bytes decode the way the engine claims. `boomedit.wad` is TeamTNT's BOOMEDIT.WAD copied verbatim —
the Boom feature exerciser, and the only fixture that is a whole WAD; the other five were lifted out
of `DOOM1.WAD`, `freedoom2.wad` and `Mock2.wad` lump by lump, so each is the lumps its test names and
nothing else:

| WAD | Holds | Covers |
|---|---|---|
| `boomedit.wad` | all of BOOMEDIT.WAD | `ANIMATED`/`SWITCHES` as a real WAD ships them, its named colormaps |
| `doom1_lumps.wad` | `PLAYPAL`, `COLORMAP`, `GENMIDI`, `D_E1M1` | colormap tints against a real palette; the OPL bank and a real MUS score |
| `doom1_e1m1.wad` | E1M1's eleven map lumps | solid-structure lids through the whole mesh builder |
| `freedoom_map01.wad` | freedoom2 MAP01's eleven map lumps | the diagonal blocking line, below |
| `freedoom_d_runnin.wad` | freedoom2's `GENMIDI` + `D_RUNNIN` | a real MIDI-format score, dense enough to land chunk boundaries mid-envelope |
| `mock2_map02_hexen.wad` | Mock2.wad MAP02's twelve lumps | the Hexen map format end to end (docs/wad.md § Map formats) |

`mock2_map02_hexen.wad` is the map the Hexen-format bug was reported on, and the one fixture whose
BEHAVIOR lump is load-bearing — it is what `loadMap` detects the format from, so a copy without it
would silently test nothing. Read as Doom format the map yields 30 linedefs pointing at vertexes and
sidedefs that do not exist; `hexen.test.ts` asserts every index is in range, which is the shape
of the failure rather than a restatement of the parse.

Lifting map lumps out verbatim keeps the **IWAD's own numbering**, which is what lets a test name a
sector or a line: `blocking-line-slide.test.ts` needs a diagonal two-sided `ML_BLOCKING` wall, which
the grid fixture cannot build, and takes freedoom2 MAP01 line 514 — still line 514 in
`freedoom_map01.wad`. It asserts the line's flags first, so the fixture cannot drift silently.

The pinky pair are the maps a demon-bites-through-a-height-gap report was made on, checked against
GZDoom (docs/monster-ai.md § Melee reach); `caco_pit_test.wad` is the map a cacodemon-stuck-in-a-pit
report was made on, checked against vanilla (docs/monster-ai.md § Floating monsters). `pinky.ts` also builds a ready-to-step `MonsterBody`, so the
tests drive the real `stepMonsterAI` rather than re-implementing its melee gate — worth copying: a
test that restates the condition it is checking passes for the wrong reason. Both were confirmed to
fail with the fix reverted before being committed.

[wad.md](wad.md) warns that synthetic WADs won't catch parser regressions. That still holds, with two
narrow exceptions it does not cover, both of them decisions taken over a lump's *size* rather than
its content: `reader.test.ts` (`Reader` is pure byte→value decoding, where a hand-built buffer is
exactly as good as a real one) and `reject.test.ts`, which pins which REJECT tables `loadMap` keeps
and which it drops (docs/wad.md § REJECT) by handing `wadFile` a `bytes` payload of each length.

### The DEHACKED fixtures

`tests/fixtures/dehacked/` holds two real patches as **text**, not as WADs, loaded through
`dehFixture(name)`. The parser is a pure function of a string, so a committed `.deh` reads in a
diff where a WAD does not; and both of these were lifted out of `public/wads/`, which a test may
never read directly.

| File | Holds | Covers |
|---|---|---|
| `epic.deh` | EPIC.WAD's lump, **verbatim** | vanilla `Text` byte-count substitution, both `Bits` forms, a repeated version header mid-file |
| `freedoom2.deh` | freedoom2's, trimmed | `[PARS]`, every `HUSTR_`/`PHUSTR_`/`THUSTR_` title, `Frame` records as the warning corpus, one string per no-target group |

`epic.deh` goes in **verbatim on purpose**: it is the byte-count corpus, and trimming it risks
breaking one of the counts a `Text` record declares. Both are read as **latin1** — EPIC's
wolfenstein and grosse titles carry bytes above 0x7f, and a UTF-8 read would corrupt them and shift
every byte count after. The trimmed one carries a header comment recording where it came from,
which `fixturewads.test.ts`'s comment exemption allows for exactly this.

## Feel dials are read, never pinned

A test that goes red because a **tuned-by-feel** number was retuned is a bug in the test: it has
turned a dial into a constant, and the next person to try the dial gets a red suite instead of a
different-looking game. Two techniques, depending on whether the dial can be read from outside.

Where it can be, the test **imports it** and derives everything from it — fixture sizes as well as
expectations. `occlusion-fade.test.ts` reads `FADE_RADIUS`, `FADE_CORE`, `FADE_ALPHA` and
`MONSTER_FADE_RANGE` (exported from `render/occlusion.ts` for exactly this) plus `WALL_CHUNK_LEN`,
sizes each grid fixture as a multiple of them, and states thresholds as points along the ramp
(`ramp(0.5)`) rather than as numbers. Claims that would otherwise need a magic number are put as
*comparisons* instead — the end of the wall beside the target fades and the far end does not, rather
than "0.35". Where a dial genuinely changes behaviour, the test asserts the relationship rather than
one side of it: below `WALL_CHUNK_LEN / 2` a `FADE_CORE` no longer guarantees a diced vertex inside
the core, so the test expects the exact floor at or above that and a point on the ramp below it. The
suite passes at every setting from `FADE_RADIUS` 128 to 2048 and `FADE_ALPHA` 0 to 0.99.

Where it can't, the test brackets it from both sides. The sight-sampling step and the fog's reveal
distance are not readable from outside their modules.
`fog-reveal-radius.test.ts` brackets the reveal against `constants.ts: VIEW_DISTANCE` — the last grid
cell inside the view must be revealed, the first cell a full cell past it must be dark — because the
reveal *is* that dial, read straight out of `constants.ts` (docs/fogofwar.md § Reveal radius).
Deriving the two columns from the dial rather than hardcoding them is what lets that dial be retuned
without touching the test, while a reveal that falls short of the view or runs past it still fails.
Retuning `VIEW_DISTANCE` should not need an edit here; breaking the identity should.

## Determinism

Nothing in `src/` is random. Every draw comes off vanilla's 256-entry `rndtable`
(`util/random.ts`, docs/random.md § The table and the two cursors), so a test calls `clearRandom()`
and then asserts **exact** values rather than bounds — `rollDamage(5, 3)` on the first draw after a
clear is `((8 % 5) + 1) * 3`, because `rndtable[1]` is 8. A test that needs the cursor somewhere
else seeks it with bare `pRandom()` calls.

There is no mocking and no fixture: nothing patches `Math.random`, and threading a `random`
parameter through `rollDamage` stays rejected — it would change `src/` in the fire path purely for
the tests, and the table removes the motive entirely.

`tests/util/random.test.ts` also asserts that **no file in `src/` mentions `Math.random`**. The repo
runs no linter, so that test is the only thing keeping a second, undocumented entropy source out.

The wall clock is the other entropy source, and gets the same treatment. `tests/util/profiler.test.ts`
patches `performance.now` to a counter a test moves by hand, so a frame's duration is *stated*
rather than spun out in a busy-wait loop — `FrameProfiler` reads the clock in three places and
nowhere else, so the smoothed figures then converge on the stated numbers to within 1e-11 and the
assertions are exact instead of tolerance-bracketed. Node runs one process per test file, so the
patch reaches nothing else; restore it in an `after()` so the runner's own timings are unaffected.
This is what keeps a test of *timing bookkeeping* out of the "Performance" carve-out above: nothing
here asserts that code is fast, and no assertion can go red because the machine was busy.

## Framerate independence

`tests/regression/framerate-independence.test.ts` is the one test that protects the whole tic lock,
and the property it checks is invisible in ordinary play: the same elapsed wall-clock time must
produce the same run whatever the display refreshes at. It mirrors `game.ts`'s accumulator, drives
the same scene at 60 Hz, at 144 Hz and through a jittery pattern, and compares position, the AI's
own counters and the RNG cursor — which vanilla itself uses as a desync checksum
(docs/random.md § The table and the two cursors).

Two things in it are load-bearing and easy to remove by accident:

- **A third test asserts the *old* dt-scaled model diverges** on the same scene. Without it, a scene
  that happened to resolve identically under any step size would let the first two pass with the tic
  lock reverted.
- **The duration is 5.5s, deliberately not a whole number of tics.** Neither `1/60` nor `1/144` is
  exact in binary, so a total landing on a tic boundary has the two runs disagree by one tic purely
  on last-bit accumulation — a property of any float accumulator, and not what the test is about.

A test that drives a simulation system directly should step it at `DOOM_TIC`, since that is the only
delta the engine ever passes. Several already did; `monster-flush-against-wall.test.ts` used `1/60`
and was retimed.

`scroll-frame-delta.test.ts` guards the same property from the other direction. `Forces`
deliberately runs on **two** clocks — the fixed tic for anything the simulation reads, the frame
delta for scrolling textures' visual offsets alone (docs/specials.md § Scrollers and conveyors) — and
collapsing that into one "advance everything by `dt`" call is an easy accident that would make a
conveyor's strength depend on the display. The tests pin that a conveyor impulse never moves however
many frames are drawn, that a scroller's visual offset integrates identically at any step size, and
that a negative first-frame delta leaves it finite (the same hazard as `animated-negative-dt`).

## Writing a new test

- A regression test that has never been seen fail is not yet a regression test. Break the thing it
  guards, watch it go red, put it back.
- **One category per file, one `describe` per subject.** `corridor-fixture`, `player-shot-range`
  and `fog-reveal-radius` are three files, not one, even though two of them share a map — a file
  named after two subjects stops telling you where a new test belongs. Put the file under the
  `src/` directory it mirrors, and give its suite a `Subject · detail` name.
- Pin a shared fixture's own shape in its own test. `corridor-fixture.test.ts` asserts the corridor
  really is 3584 units long, so a degraded fixture fails loudly instead of quietly weakening every
  assertion built on it.
- Pair a positive with a negative. The reveal-radius test would pass vacuously against a bug that
  revealed everything, which is why "fog does not reveal through a wall" sits next to it.
- **Say what a test asserts, not what it commemorates.** A title referring to "the bug" leaves the
  next reader hunting for which one; the file's header comment is the place for that context.
- The table tests in `tables.test.ts` check that transcriptions are **complete**, not that they are
  **correct** — only `info.c` settles correctness, and CLAUDE.md's citation rule still governs.
