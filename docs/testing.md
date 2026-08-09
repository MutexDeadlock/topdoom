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
  util/  wad/  game/     one file per src/ module under test
  regression/            one file per fixed bug, named after the bug
  fixtures/              builders and test data, never tests
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
vanilla-table invariants. Deliberately **not** covered yet, and why:

- **`SpecialsController`** — ~10 constructor arguments including a `MaterialBank`, a `THREE.Group`
  and a `FogOfWar`, with the whole mover state machine (`sectorActive`, `tickDoor`, `tickLift`, the
  `trigger*` guards) private. This is the biggest known gap. Reaching it means extracting the
  per-mover tick into pure `(state, dt) → state` functions first.
- **`ProjectileLayer` / `SpriteFxLayer`** — every `spawn*` short-circuits on `SpriteAnimator.resolve`,
  so a stubbed run would test the stubs. Test at `shotPath` level instead; `playerShotRange` exists
  as a separate exported function precisely so the range selection is reachable without the layer.
- **`src/render/` (anything constructing THREE objects), all of `src/ui/`, `main.ts`, `game.ts`,
  `audio/audio.ts`** — need a DOM or a GL context. `render/bsp.ts` *is* covered: it is pure
  geometry despite where it lives.
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

**Every cell is its own sector and its own subsector.** That is what removes the need for a BSP
compiler: the partition tree is a column chain with a row chain inside each column, `cells − 1`
nodes from a trivial recursion. The cost is that the fixture can only express axis-aligned
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

`circleBlocked` only consults lines the **destination** circle touches, so a step longer than a cell
lands clean inside the next one and reports free. That is the engine's real behaviour — vanilla
`P_TryMove` has the same property — not a fixture artifact, but it is easy to write a movement test
that silently exercises it: a 48-unit slide from `(320, 200)` correctly projects to `(368, 200)`,
while the same slide from `(320, 240)` tunnels to `(320, 304)`. Keep `cell` comfortably larger than
any single move plus the mover's radius.

The same property means **a wall cell's interior is not blocked** — only its boundary lines are.
`circleBlocked` at a `#` cell's centre with radius 16 returns `false`, because a 128-unit cell has
real floor inside it. Probe near a boundary, not at a centre.

Uniform cell heights also mean `hasLineOfSight`'s floor/ceiling sampling loop never narrows
anything. A test meaning to exercise that half of the function must build a real step or low
ceiling through the `heights` option, or it only looks like it covers it.

## WAD-backed tests

`DOOM1.WAD`, `freedoom2.wad`, `SCYTHE.WAD`, `NUTS.WAD` and `oku2v31.wad` are **committed to the
repo**; only `DOOM.WAD` and `DOOM2.WAD` are gitignored. So a WAD-backed test runs everywhere by
default, and only a test needing one of those two has to guard itself — with node:test's
declaration-time option, since presence is a static fact:

```ts
test('…', { skip: existsSync(p) ? false : `${p} not present` }, () => { … });
```

Three tiny purpose-built maps live in `tests/fixtures/wads/`, each carrying its own `MAP01` and
loading with **no IWAD**, with a loader beside it in `tests/fixtures/`:

| WAD | Geometry | Loader | Covers |
|---|---|---|---|
| `long_corridor_with_chaingunner.wad` | 3648-unit corridor, chaingunner 3584 out | `corridor.ts` | both chaingunner regressions |
| `pinky_below_test.wad` | two rooms split at `y=128`, far floor **-72** (pit) | `pinky.ts` | vertical melee reach |
| `pinky_above_test.wad` | same, far floor **+88** (ledge) | `pinky.ts` | vertical melee reach |

The pinky pair are the maps a demon-bites-through-a-height-gap report was made on, checked against
GZDoom (docs/monsters.md § Melee reach). `pinky.ts` also builds a ready-to-step `MonsterBody`, so the
tests drive the real `stepMonsterAI` rather than re-implementing its melee gate — worth copying: a
test that restates the condition it is checking passes for the wrong reason. Both were confirmed to
fail with the fix reverted before being committed.

Load fixture WADs through
`new URL('./wads/…', import.meta.url)` so the suite is cwd-independent, and keep
`inspect-wad.ts`'s `file.buffer.slice(file.byteOffset, …)` step: `readFileSync` returns a view into
a pooled `ArrayBuffer`, and passing `.buffer` raw hands `WadFile` the whole pool.

[wad.md](wad.md) warns that synthetic WADs won't catch parser regressions. That still holds, and
`reader.test.ts` is the one narrow exception it does not cover: `Reader` is pure byte→value
decoding, where a hand-built buffer is exactly as good as a real one.

## Private constants are pinned behaviourally

`SIGHT_RADIUS` (fogofwar.ts), `WALL_OVERLAP` (world.ts) and the sight-sampling step are module-
private, so a test can only bracket them from both sides. `fog-reveal-radius.test.ts` asserts a
subsector 5120 units out is revealed and one 5248 out is not — **any radius outside (5120, 5248]
fails**. That is deliberate. A change to what the camera frames should update those numbers along
with the constant; it should not delete the test.

## Determinism

`rollDamage` and `triangularDraw` call `Math.random()` directly. Patch it with node:test's
`t.mock.method(Math, 'random', …)`, which restores automatically when the test ends —
`tests/fixtures/rng.ts` supplies `scriptedRandom` (replays a fixed list, for pinning exact roll
boundaries) and `seededRandom` (an LCG, for distribution shape). Threading a `random` parameter
through `rollDamage` was rejected: it would change `src/` in the fire path purely for the tests.

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
