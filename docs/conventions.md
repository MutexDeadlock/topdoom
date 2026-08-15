# File conventions

Where a file goes, what it is called, and the order things sit in inside it. All of this is
**descriptive** — it was written down by reading `src/` and naming the shape that was already
dominant, so almost every file already conforms. The deviations that remain are listed at the
bottom rather than swept: a file gets brought into line when it is next touched for another reason,
not in a rename pass of its own.

The header-comment and code-comment rules themselves are in CLAUDE.md § Code comments; this doc
covers only naming and layout.

## File names

Lowercase, a single token, no separators — `besttimes.ts`, `moverblocking.ts`, `sectoreffects.ts`,
`textureanim.ts`, `deathoverlay.ts`. No kebab-case, no camelCase, no suffix conventions inside
`src/`. (`docs/` is the opposite and deliberately so: docs are flat and group by a shared
`monster-` prefix — CLAUDE.md § Documentation maintenance.)

**A directory is named for the domain; the files inside it are named for their role**, and the
domain is never repeated in the filename. `things/tables.ts`, never `things/thingtables.ts` and
never a flat `thingtables.ts` — the directory already said which domain it is.

**Where a `<domain>.ts` sits beside a `<domain>/`, the parent file is the layer's one public entry
point** for the rest of the engine and the directory holds its internals. `game/things.ts` +
`game/things/` and `game/specials.ts` + `game/specials/` are both this shape. The parent may
re-export a type out of the directory to keep that true — `things.ts` does exactly that for
`ThingLayer`, `MonsterRef` and `BarrelExplosion`, so `game.ts` and `combat.ts` never have to know
which file inside `things/` a type happens to live in.

A directory with no parent file (`game/monsters/`, `src/render/`, `src/util/`) is just a grouping;
its files are imported directly. **The missing parent is the point, not an omission** — a grouping
holds decision modules and data that something else drives, so there is no single object to be the
entry, and a parent file holding only re-exports would be the `index.ts` barrel § Imports rules out.

`game/monsters/` is the one where that reads as asymmetry, so: the monster runtime is
`ThingLayer` — over half its surface is monster-facing, because one `posed` array holds monsters,
decorations and pickups alike. Splitting a real `monsters.ts` out of it would repartition that
array, and `ThingsSnapshot.things` encodes it flat, so the cost is a `SAVE_VERSION` bump and every
released save (CLAUDE.md's save-compatibility rule). The directory stays parentless deliberately.

Nor does it nest under `things/`, though a monster *is* a thing: nesting tracks dependency, not
taxonomy, and here `things.ts` is the caller (it imports `stepMonsterAI`) while `monsters/` takes
only the `doomednums.ts` leaf back. It is also peer API — 30 import sites outside `things/` — and
`ai.ts` deliberately knows nothing of `ThingLayer`, which is what keeps it headlessly testable
(docs/monster-ai.md). The "is a" relationship is already stated where it holds and is checked:
`PosedThing extends MonsterBody`.

**A directory earns its keep at two files, never one.** `game/spritefx/` is the floor. A lone file
under a directory buys nothing the flat name didn't — so the choice is between a real split and
leaving it flat, and "it would be tidier in a folder" is not a reason to make one.

## The role names

Three role names recur and mean the same thing everywhere:

- **`defs.ts`** — the record shapes a subsystem passes around, plus the constants tied to *those
  shapes*. `things/defs.ts` (`PosedThing`, `ThingLayer`, the barrel constants), `monsters/defs.ts`
  (`MonsterBody`, `MonsterStats`).
- **`tables.ts`** — the type-keyed, vanilla/WAD-derived data every instance is looked up in.
  `things/tables.ts` (`THING_SPRITES`, `MONSTER_HEALTH`, the frame letters), `monsters/tables.ts`
  (`MONSTER_STATS`, `INERT_SHOOTABLE`, `FAST_MONSTER_STATS`).
- **an identity table** — the module that gives raw numbers readable names. It stands alone and
  **imports nothing**, so any table module can take it without a cycle. `things/doomednums.ts`
  (`ThingType`) is the only one; it is named for what it holds rather than taking a generic role
  name, because `types.ts` next to `defs.ts` would read as "TypeScript type declarations".

Everything else is named for what it *does*: `ai.ts`, `attacks.ts`, `grid.ts`, `vile.ts`,
`mapscan.ts`, `movergeometry.ts`.

The `defs`/`tables` split earns its keep when both halves are large — the thing layer's are 555 and
833 lines, the monsters' 491 and 503 — or when the subsystem needs a directory anyway and the split
is what fills it, which is `spritefx/`'s case at 159 and 208. A subsystem needing neither keeps its
shapes and tables in one `defs.ts`. **`tables.ts` may import `defs.ts`, never the reverse**: the shapes
have to stay usable by a module that wants nothing to do with the data, which is what lets
`monsters/ai.ts` take `MonsterStats` without pulling the whole stat table's dependency on
`world.ts` in behind it.

## Source order inside a file

Two shapes, by what the module is:

**A data module** (`defs.ts`, `tables.ts`, `doomednums.ts`): record shapes first,
then constants and tables **grouped by topic**, not sorted by kind. A derived value goes directly
after what it derives from — `FAST_MONSTER_STATS` after `MONSTER_STATS`, `TALLEST_BODY_HEIGHT`
after that. A pure helper goes directly after the table it reads — `attackPoseFrameSeconds` after
`MONSTER_ATTACK_FRAMES`. A shape that belongs to one topic stays with that topic rather than being
hoisted to the top: `BarrelExplosion` sits at the end of `things/defs.ts` with the `BARREL_*`
constants, and that is correct.

**A system module** (one class or factory): exported constants → private tuned dials → module-level
state → free helper functions → **the single class or factory last**, occupying the rest of the
file. `player.ts`, `game.ts`, `render/camera.ts`, `ui/hud/hud.ts` and `game/specials.ts` are all
this shape.

**The exception**: a module that is a bag of independent pure functions keeps each function's own
types and constants immediately above it instead of hoisting them, and interleaves private with
exported. `specials/mapscan.ts` is the case — reading it top-to-bottom is reading one analysis at a
time, which hoisting would destroy.

**No section-banner comments.** There are zero in the tree (`// ─────`, `// === X ===`) and there
should stay zero; grouping is carried by the JSDoc on each symbol.

## Imports

Every relative import carries an explicit `.ts` extension — `allowImportingTsExtensions` plus Node
ESM resolution means `from './wad/reader'` does not resolve. There are no `index.ts` barrels
anywhere, and adding one would break the entry-point rule above: `game/things.ts` is the thing
layer's barrel *and* its implementation, which is what keeps its public surface an explicit list.

## Known deviations

Pending, not precedent:

- `specials.ts` re-exports `SectorEffects` and the three `moverblocking.ts` functions purely so it
  stays the layer's one entry point. Both are driven by `game.ts`, not by `SpecialsController`, so
  the pass-through carries no meaning of its own; the tidier shape is for the controller to own
  them, which is a real change rather than a move.

That is the whole list. Every `src/` file opens with a header block carrying a `docs/` pointer;
`src/constants.ts` and `src/types.ts` are the two that point at CLAUDE.md instead, because they are
cross-cutting and the rules governing them genuinely live there rather than in any subsystem doc.
