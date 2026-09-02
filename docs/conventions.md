# File conventions

Where a file goes, what it is called, and the order things sit in inside it. Most of this is
**descriptive** — it was written down by reading `src/` and naming the shape that was already
dominant, so almost every file already conforms. The deviations that remain are listed at the
bottom rather than swept: a file gets brought into line when it is next touched for another reason,
not in a rename pass of its own.

§ Source order inside a file and § Publics above privates are the exception and are
**prescriptive**: they were chosen against the shape `src/` already had, so most files do not
conform yet. Same discipline — convert on touch, never in a sweep.

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
`game/things/`, `game/specials.ts` + `game/specials/`, `wad/map.ts` + `wad/map/` and
`wad/library.ts` + `wad/library/` are all this shape. The parent may re-export out of the directory
to keep that true — `things.ts` does exactly that for `ThingLayer`, `MonsterRef` and
`BarrelExplosion`, so `game.ts` and `combat.ts` never have to know which file inside `things/` a
type happens to live in, and `map.ts` does it for `SUBSECTOR_BIT`, `NO_LINE` and `segSide` so
`render/bsp.ts` reads a seg and a node without reaching into `map/defs.ts`.

**A shape the directory's own files share goes in `<domain>/defs.ts`, never in the parent.** The
parent imports every child, so a child taking a type back out of it is a cycle — one that survives
only while the edge stays `import type` and is erased. `wad/library/defs.ts` and `wad/map/defs.ts`
are the worked cases: `library/`'s `disk.ts` and `manifest.ts` both take `WadSource` from the
first, `map/`'s three format seams take their records from the second, and each parent re-exports
what moved.

`wad/map/` holds `defs.ts` plus the lump *formats* a map can ship in rather than roles —
`nodes.ts` for the BSP encodings, `hexen.ts` for Hexen's own LINEDEFS/THINGS, `udmf.ts` for
TEXTMAP. `campaign/` is the same shape:
where a directory groups sub-topics rather than stages of one pipeline, the sub-topic is the name.

The one exception is `game/dehacked.ts` + `game/dehacked/`, which has **two** entry points, split
by audience: reading a patch is the parent, applying one is `dehacked/apply.ts`. Two of the three
readers have no `Game` and want only a patch's text, and because ES re-exports are eager, a parent
that re-exported the applier would make them evaluate — and `structuredClone` — every game table to
read a level title. This is a deliberate exception with a guard test, not a precedent for splitting
an entry point whenever it feels convenient: the bar is a dependency graph that differs this
sharply between two sets of callers. docs/dehacked.md § The two entry points.

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
is what fills it, which is `spritefx/`'s case at 159 and 208 and `specials/`'s at 360 and 392. A
subsystem needing neither keeps its shapes and tables in one `defs.ts`.

**Splitting a file out is the answer when its own constant block buries its subject**, whatever the
halves measure: `inventory/` exists at 117 and 122 lines because ~110 lines of doomednum-keyed
pickup tables sat between `createInventory` and `applyPickup`. The parent `<domain>.ts` re-exports
what moved (§ File names), so no importer learns which file inside the directory a shape lives in.

**`tables.ts` may import `defs.ts`, never the reverse**: the shapes have to stay usable by a module
that wants nothing to do with the data, which is what lets `monsters/ai.ts` take `MonsterStats`
without pulling the whole stat table's dependency on `world.ts` in behind it.

## Source order inside a file

Two shapes, by what the module is:

**A data module** (`defs.ts`, `tables.ts`, `doomednums.ts`): record shapes first,
then constants and tables **grouped by topic**, not sorted by kind. A derived value goes directly
after what it derives from — `FAST_MONSTER_STATS` after `MONSTER_STATS`, `TALLEST_BODY_HEIGHT`
after that. A pure helper goes directly after the table it reads — `attackPoseFrameSeconds` after
`MONSTER_ATTACK_POSE`. A shape that belongs to one topic stays with that topic rather than being
hoisted to the top: `BarrelExplosion` sits at the end of `things/defs.ts` with the `BARREL_*`
constants, and that is correct.

**A system module** (one class, factory or entry function): **public surface, subject, private
support, side effects** — in that order. The subject splits the same way inside
(§ Publics above privates).

```
import …
export interface GameOptions { … }    the API's shapes
export const PLAYER_RADIUS = 16;      the API's constants
const TURN_RATE = 3.2;                private tuned dials
let fpsCap = readStoredFpsCap();      module-level state
export function getFpsCap() { … }     the API's functions
export class Player { … }             the subject
function clampToSector(…) { … }       private helpers
for (const [i, id] of WEAPON_ORDER…)  module-evaluation side effects, last
```

The split is by what a use site can carry on its own. A helper's name and signature state what it
does, so the subject reads fine above it — that is § Single-use helpers' test. A constant's name
never states its *value*, and here the declaration is also the only place its provenance lives
(CLAUDE.md's constants rule: a vanilla citation, or "tuned by feel"), which is what a reader needs
to judge the line using it. `game/player.ts` spends 93 lines on 16 constants, nearly all of it
citation. So values go above the subject and behavior goes below it.

`src/main.ts` is the same shape with `boot()` as its subject and `void boot()` as the side effect.

Three rules constrain the tail:

- **Helpers below the subject are `function` declarations**, never `const helper = () => …`.
  Declarations hoist and are safe wherever they sit; a `const` is only initialized when its own line
  runs, so anything reaching it during module evaluation gets a TDZ error. This is load-bearing, not
  theoretical: `game.ts`'s `let fpsCap = readStoredFpsCap()` calls a function declared below it.
- **A private constant only one private helper reads travels with that helper**, below the subject —
  the same pairing the data module keeps. Private constants only: module-level state and everything
  exported stay above the subject whatever reads them, since an importer opens the file to find
  them. `game.ts`'s FPS cap is the worked case — its state and both accessors above, only
  `readStoredFpsCap` below.
- **Type declarations are order-free.** An options interface sits directly above the class it
  configures (§ Named arguments), never hoisted away from it.

**When the constant block itself buries the subject, that is the signal to split**, not to bend the
order: a type-keyed table big enough to push the class hundreds of lines down belongs in the
subsystem's `tables.ts` — § The role names owns that call, `inventory/` being the worked case.

This is the one **prescriptive** rule here, but it usually asks for less than it looks: in most
files only *private* helpers move, and **every module in `src/` now conforms**. The exception to
expect when adding one is a module whose tail is free functions, where **exported** ones sit down
there too and move up as well — `game/world.ts` had eighteen, `render/mapmesh.ts` twenty-two.

**The exception**: a module that is a bag of independent pure functions keeps each function's own
types and constants immediately above it instead of hoisting them, and interleaves private with
exported. `specials/mapscan.ts` is the case — reading it top-to-bottom is reading one analysis at a
time, which hoisting would destroy.

## Publics above privates

**Inside a class or factory, the public surface comes before the private support** — the same split
the module order makes, one level down. A reader who opens `ThingLayer` to find out what it can do
reaches `update`, `draw` and `damage` before `pushThing` and `refreshSector`.

A factory's members are `function` declarations in its closure, not properties on a returned
literal, so this order is available to it at all: declarations hoist, so the public half can call
the private half above it. The returned object is then a bare manifest of names — `game/things.ts`
ends in one — and is the closure's own "side effects last" line, since it has to be last for
`count: posed.length` and `missingArt: [...missingArt]` to read final values.

Inside the closure the order is state, then construction, then publics, then privates: a `const`
does not hoist, so anything a public reads must already be declared, and `createThingGrid` buckets
what it is handed eagerly, so `grid` has to be built after the spawn loop that fills `posed`.

## Single-use helpers

A helper called from exactly one place earns its name when **the name states something its body does
not**; otherwise inline it. `dehacked/frames.ts`'s `isMonsterRow` is one line
(`pain !== 0 && death !== 0`) and keeps its name, because "is this row a monster" is the concept and
the expression is not. `wad/map.ts`'s old `readMapFormat` was the other case —
`lumps.has('BEHAVIOR')` already reads as the question its name asked — so it is now that ternary
inside `loadMap`, with its fidelity citation as a comment on the `const`.

Length is not the test. A one-line body under a doc block that carries a vanilla citation or a
hazard is usually worth keeping, since a declaration is where such a block belongs; a body called
twice on one line (`checksum.ts`'s `hex32`) is not single-use at all.

## Named arguments

**Past three or four arguments — and always where two adjacent ones share a type — the tail goes
in a named object.** `new TopDownCamera(aspect, options)` and `new Game(view, audio, wad, options)`
are the shape: the handles that cannot be confused with each other stay positional, everything
describing *this* call goes behind a name. `GameOptions.startMap` and `.title` are both strings, so
positionally a swap typechecks and produces a level named after the WAD set.

**The per-field JSDoc lives on the options interface**, and is not repeated at the call site
(§ Comment shape). A call site keeps only `//` notes about the *value* it passes.

**Nor does a parameter repeat what the object beside it already owns.**
`new SpecialsController(world, options)` takes no `map`: `World` holds the map it was built over,
and a second parameter is a second chance for the two to disagree.

**The one exception is a coordinate pair on a hot path**, which keeps its `x`/`y` scalars —
CLAUDE.md's position-types rule names `World`'s (`linesNear`, `subsectorAt`, `floorAt`,
`positionBlocked`), and `ThingGrid.forEachMonsterNear` has the same shape: callers compute the
coordinates inline, so a point parameter allocates one per call in code that runs thousands of
times a frame. The same reasoning keeps `ThingGrid.pushBlocker`'s five scalars and
`mapmesh.ts`'s `pushVertex`, where the record would be the allocation the pool or buffer exists to
avoid.

That is the whole exception. Anywhere else, being on a hot path is a reason to **measure**, not a
reason to skip the name: `ThingGrid.forEachMonsterAlongRay` and `stepMonsterAI` both take the
object.

**Where a call's helpers all want the same handles, thread one context rather than an options
object per helper.** `monsters/ai.ts` is the worked case: `stepMonsterAI(body, stats, world, step)`
builds a `Chase` from its own parameters plus the four values it derives, and its fourteen helpers
take that — collapsing about seventy parameters to fourteen, `runChaseCall`'s thirteen to one.

The exported half is the options interface (`MonsterStep`), by the handles-vs-description test
above; the private context extends it with what the call derives, so a caller is never asked for a
field only the call can compute.

**A record read on a hot path must reach it as one shape.** V8 keys a property load on the object's
hidden class, and that class follows the literal: an omitted optional, a spread, or the same fields
written in another order each make a different one, and a load site fed several goes megamorphic.
So build such a record in exactly one place and require every field, which is what makes the type
checker refuse a literal — `world.ts`'s `makeCollider` is the worked case, and skipping it measured
10% on the monster path (docs/world.md § The collider).

**A context carries policy as well as data.** `render/mapmesh.ts`'s `Build` covers either the whole
map's static geometry or one mover's sector, and the two differ only in the `holdsStill` and
`includeSide` predicates on it — so none of the dozen builders below has to know which it is in.

## Comment shape

CLAUDE.md § Code comments has the three tiers and the header rule. These are the shape rules a
sweep of `specials/`, `render/` and `things/` turned into repeat findings — each is here because it
was violated more than once.

**The subject is our code.** A comment says what *this* code does; a vanilla, Boom or GZDoom
reference is a supporting clause, never the subject. `Vanilla's P_PlayerInSpecialSector — the
sector specials that need no mover` inverts it and reads as documentation of another engine;
`The sector specials that need no mover at all … (vanilla's P_PlayerInSpecialSector)` does not.
The test: **delete the foreign name — if nothing is left, the comment was not earning its place.**
`/** Vanilla `player->secretcount`. */` on a field named `secretsFound` fails it outright.

This is not a licence to drop citations. A transcribed table, a derived constant and a deliberate
deviation all still name their source (CLAUDE.md's constants and fidelity rules), and a file that
*is* a transcription — `audio/sfx.ts`, `wad/campaign/pars.ts`, `specials/generalized.ts` — says so
in its header, because that is what the file owns. A citation names a source the project trusts:
the real source, never the Doom wiki alone.

**A doc block belongs to a declaration.** Never stack two `/** */` blocks, and never let one drift
off what it documents when something is inserted between. Both read as a doc on the wrong symbol,
and editors show them that way. A group of related constants carries its rationale on the first
one's JSDoc, per § Source order inside a file — not in a free-floating block above the group.

**State what is true, not what changed.** No "now", "used to", "was tried", "turned out" — those
date the comment and describe an edit rather than the code. How a bug was found and what was tried
first belong in the commit message. A decision worth protecting from a well-meaning revert says it
is deliberate and points at the doc that argues it: *"deliberately not a linear scan however rare
arch-viles seem — docs/monster-ai.md § Spatial indexing has the map that disproves it."*

**Parallel fields may repeat a comment; arguments may not.** Two sibling fields documented in the
same words are fine and often better (`WallQuad.baseAlpha` / `FlatSurface.baseAlpha`). An
*argument* stated at two sites is the tier-1 violation: state it once in the doc, and leave each
site the fact plus `docs/x.md § heading`.

**100 columns.** Comments and `docs/` prose alike. A one-line `/** … */` that would run past it
becomes a multi-line block rather than trailing off the screen. Exempt: markdown tables, code
fences, and a line whose overflow is a single unbreakable token (a URL, a long inline `` `code` ``
span). Code is not held to it.

## Abbreviations

**An abbreviation is upper case in prose** — comments, `docs/` and player-facing text alike:
`ESC`, `ID`, `IDs`. Never `Esc`, `Id`, `id`.

**Code keeps its own casing** and is exempt, backtick spans in prose included: `getElementById` is
the DOM's, `wadSetId`/`SfxId`/`targetId` are camelCase like the rest of `src/`, and `SaveGame.id` /
`SaveWad.id` are persisted field names — renaming those is a `SAVE_VERSION` bump (CLAUDE.md's
save-compatibility rule), not a casing sweep.

**`id Software` is the company's own spelling** and stays lowercase, as do `id-era` and
`id-Software` URLs. That collision is the reason for the rule: in prose, lowercase `id` is the
company and upper-case `ID` is an identifier, so neither has to be read from context.

## Imports

Every relative import carries an explicit `.ts` extension — `allowImportingTsExtensions` plus Node
ESM resolution means `from './wad/reader'` does not resolve. There are no `index.ts` barrels
anywhere, and adding one would break the entry-point rule above: `game/things.ts` is the thing
layer's barrel *and* its implementation, which is what keeps its public surface an explicit list.

**Names arrive named; a namespace import is for three cases**: a package with one obvious name
(`THREE`), two modules whose exports collide (`wad/map.ts`'s `hexen`/`udmf`), and a `defs.ts` a file
takes 30-odd shapes from at once and reads each of them a handful of times — `specials.ts` reads
`defs.` and is the only one. It costs the `noUnusedLocals` check on that module: a namespace is
always used, so a name that falls out of use rots silently. Two things keep a file on named
imports: use sites dense enough that the prefix becomes the noise (`specials/tables.ts` reads those
same shapes 157 times, `DOOR_SPEED` 25 times, inside table rows the constants are the vocabulary
of), and importing from two `defs.ts` at once — `game/things.ts` would need
`thingDefs.`/`monsterDefs.`, repeating the domain its directory already names.

## Whitespace

UTF-8, LF, two-space indent, final newline, no trailing whitespace — `.editorconfig` at the repo
root is the only place these live; there is no linter and no formatter. Markdown keeps trailing
whitespace (two spaces are a hard line break) and wraps prose at 100 columns; tables run past it.

It lists the extensions it covers (`.ts`, `.css`, `.html`, `.json`, `.md`) rather than starting from
`[*]`: the WADs and DEHACKED patches under `public/game/` and `tests/fixtures/` are third-party and
stay byte-verbatim, and a whitelist cannot reach them. A new text extension needs adding here.

## Known deviations

Pending, not precedent: none.

A layer entry point re-exporting its own is not a deviation — `specials.ts` hands out
`SectorEffects`, which cannot be `SpecialsController`'s because it is built before the `World` the
controller needs (docs/savegames.md § Apply order). The test: an export that leaves the layer only
to be handed straight back in is a round trip, and belongs to the layer instead.

Every `src/` file opens with a header block carrying a `docs/` pointer;
`src/constants.ts` and `src/types.ts` are the two that point at CLAUDE.md instead, because they are
cross-cutting and the rules governing them genuinely live there rather than in any subsystem doc.
