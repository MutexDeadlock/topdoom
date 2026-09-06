# File conventions

Where a file goes, what it is called, the order things sit in inside it, and the shape of a
comment. § Source order inside a file, § Publics above privates and § Inline `if` are
**prescriptive** and not every file conforms; the rest describe the shape `src/` already has. A
file is brought into line when it is next touched for another reason, never in a sweep —
§ Known deviations says how to find what is pending. CLAUDE.md keeps only the rules that must be in
context on every change and points here for the rest.

## File names

- **Lowercase, one token, no separators**: `besttimes.ts`, `deathoverlay.ts`. No kebab-case, no
  camelCase, no suffixes. (`docs/` is flat and groups by prefix instead — CLAUDE.md
  § Documentation maintenance.)
- **A directory is named for the domain, its files for their role, and the domain is never
  repeated**: `things/tables.ts`, not `things/thingtables.ts` and not a flat `thingtables.ts`.
- **A `<domain>.ts` beside a `<domain>/` is the layer's one public entry point**; the directory
  holds internals and nothing outside reaches into it. `game/things.ts`, `game/specials.ts`,
  `game/inventory.ts`, `game/spritefx.ts`, `game/replay.ts`, `wad/map.ts`, `wad/library.ts`,
  `audio/music.ts`, and `game.ts` beside `game/`. The parent re-exports what importers need
  (`things.ts` hands out `ThingLayer`; `map.ts` hands out `SUBSECTOR_BIT`) so no importer learns
  which inner file a shape lives in.
- **A shape the directory's own files share goes in `<domain>/defs.ts`, never in the parent**: the
  parent imports every child, so a child importing the parent is a cycle that survives only while
  the edge is `import type`. `wad/map/defs.ts`, `wad/library/defs.ts`.
- **Where a directory groups sub-topics rather than pipeline stages, the sub-topic is the name**:
  `wad/map/{nodes,hexen,udmf}.ts` by lump format, `wad/campaign/{mapinfo,pars,sky}.ts`.
- **One entry point per layer.** The exception is `game/dehacked.ts` + `dehacked/apply.ts`, split
  by audience because ES re-exports are eager and two of three readers must not evaluate the game
  tables to read a level title. It has a guard test; the bar for another is a dependency graph
  that differs that sharply. docs/dehacked.md § The two entry points.
- **A directory with no parent file is a grouping** (`game/monsters/`, `render/`, `util/`,
  `wad/campaign/`): its files are imported directly, and a parent holding only re-exports would be
  the `index.ts` barrel § Imports rules out. `game/monsters/` stays parentless and outside
  `things/` because the runtime is `ThingLayer` (one `posed` array holds monsters, decorations and
  pickups; splitting it is a `SAVE_VERSION` break), `things.ts` is the caller and `ai.ts` must
  stay headless (docs/monster-ai.md); nesting tracks dependency, not taxonomy.
- **A grouping whose subject is one class names that module after the directory** — the one place
  the domain repeats: `wad/wad.ts` (`Wad`), `audio/audio.ts` (`AudioEngine`), `ui/menu/menu.ts`,
  `ui/hud/hud.ts`. The `ui/` two cannot be parent files: each UI module keeps its `.css`/`.html`
  beside it (docs/styles.md § One owner per element).
- **A directory earns its keep at two files, never one.** `game/spritefx/` is the floor.

## The role names

- **`defs.ts`** — the record shapes a subsystem passes around, plus the constants tied to those
  shapes (`things/defs.ts`: `PosedThing`, the barrel constants).
- **`tables.ts`** — the type-keyed, vanilla/WAD-derived data instances are looked up in
  (`monsters/tables.ts`: `MONSTER_STATS`).
- **An identity table** gives raw numbers names and **imports nothing**, so any table can take it
  without a cycle. `things/doomednums.ts` (`ThingType`) — not `types.ts`, which reads as TypeScript
  declarations.
- Everything else is named for what it *does*: `ai.ts`, `grid.ts`, `vile.ts`, `mapscan.ts`.
- **`tables.ts` may import `defs.ts`, never the reverse**: the shapes must stay usable by a module
  that wants none of the data (`monsters/ai.ts` takes `MonsterStats` without `world.ts` behind it).
- **Split `defs`/`tables` when both halves are large or the directory exists anyway**; otherwise one
  `defs.ts`. **Split a file out when its constant block buries its subject**, whatever the sizes —
  `inventory/` exists because the pickup tables sat between `createInventory` and `applyPickup`.

## Source order inside a file

**A data module** (`defs.ts`, `tables.ts`, `doomednums.ts`): shapes first, then constants and tables
**grouped by topic**, not by kind. A derived value follows what it derives from
(`FAST_MONSTER_STATS` after `MONSTER_STATS`); a pure helper follows the table it reads; a shape
belonging to one topic stays with it (`BarrelExplosion` at the end of `things/defs.ts` with the
`BARREL_*` constants).

**A system module** (one class, factory or entry function): **public surface, subject, private
support, side effects**, in that order.

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

Values go above the subject because a constant's declaration is the only place its provenance
lives (CLAUDE.md's constants rule); behavior goes below because a helper's name says what it does.
`src/main.ts` is the shape with `boot()` as subject and `void boot()` as the side effect.

- **Helpers below the subject are `function` declarations**, never `const f = () => …`:
  declarations hoist, a `const` read during module evaluation is a TDZ error — `game.ts`'s
  `let fpsCap = readStoredFpsCap()` calls a function declared below it.
- **A private constant read by one private helper travels with that helper**, below the subject.
  Module-level state and everything exported stay above it whatever reads them (`game.ts`'s FPS
  cap: state and accessors above, only `readStoredFpsCap` below).
- **Type declarations are order-free**; an options interface sits directly above the class it
  configures (§ Named arguments).
- **A constant block that buries the subject is the signal to split** (§ The role names), not to
  bend the order.
- **Exception**: a bag of independent pure functions keeps each function's own types and constants
  above it and interleaves private with exported, so it reads one analysis at a time
  (`specials/mapscan.ts`).

## Publics above privates

**Inside a class or factory, public surface before private support** — the module order one level
down: `ThingLayer` reaches `update`/`draw`/`damage` before `pushThing`.

A factory's members are `function` declarations in its closure, not properties on a literal, which
is what lets publics call the privates below them; the returned object is a bare manifest and the
closure's "side effects last" line (`game/things.ts` ends in one, so `count: posed.length` reads
the final value). Inside the closure: state, construction, publics, privates — a `const` does not
hoist, and `createThingGrid` buckets eagerly, so `grid` is built after the spawn loop fills `posed`.

## Single-use helpers

**A helper called from one place keeps its name when the name states something its body does not;
otherwise inline it.** `dehacked/frames.ts`'s `isMonsterRow` (`pain !== 0 && death !== 0`) stays:
"is this row a monster" is the concept. `wad/map.ts`'s format detection is inline in `loadMap`:
`lumps.has('BEHAVIOR')` already reads as the question, and the citation sits on the `const`.
Length is not the test — a one-liner under a citation or hazard block stays, since a declaration
is where that block belongs; a body called twice on one line (`checksum.ts`'s `hex32`) is not
single-use.

## Named arguments

- **Past three or four arguments — and always where two adjacent ones share a type — the tail goes
  in a named object**: `new TopDownCamera(aspect, options)`, `new Game(view, audio, wad, options)`.
  Handles that cannot be confused stay positional; everything describing *this* call goes behind a
  name. `GameOptions.startMap`/`.title` are both strings — positionally a swap typechecks.
- **Per-field JSDoc lives on the options interface**, not at the call site (§ Comment shape); a
  call site keeps `//` notes about the *value* it passes.
- **A parameter never repeats what the object beside it owns**: `new SpecialsController(world,
  options)` takes no `map` — `World` holds it, and a second parameter is a chance to disagree.
- **A point goes in as a `Pos2`/`Pos3` where callers already hold one** (`src/types.ts`; CLAUDE.md
  § Position types has what they mean). `Player`, `PosedThing`, `MonsterBody` and the WAD's `Thing`
  all carry `x`/`y`(/`z`), so passing them costs no conversion and no allocation.
- **The one exception is a coordinate pair on a hot path**, which keeps scalars: `util/geom.ts`,
  `World`'s point queries (`linesNear`, `subsectorAt`, `sectorAt`, `floorAt`, `groundFloor`,
  `positionBlocked`), `ThingGrid.forEachMonsterNear`/`pushBlocker`, `mapmesh.ts`'s `pushVertex` —
  callers compute the coordinates inline, so a point parameter allocates per call. That is the
  whole exception: elsewhere a hot path is a reason to **measure**, not to skip the name
  (`forEachMonsterAlongRay` and `stepMonsterAI` take the object).
- **Where a call's helpers all want the same handles, thread one context** rather than an options
  object per helper: `monsters/ai.ts` builds a `Chase` from its parameters plus what it derives,
  and every helper takes that. The exported half is the options interface (`MonsterStep`); the
  private context extends it with the derived fields, so a caller is never asked for what only the
  call can compute.
- **A record read on a hot path reaches it as one shape**: V8 keys a property load on the hidden
  class, and an omitted optional, a spread or another field order each make a new one — a load site
  fed several goes megamorphic. Build such a record in one place and require every field
  (`world.ts`'s `makeCollider`; docs/world.md § The collider).
- **A long-lived record read on a hot path is a class instance, never a literal**: literals of one
  field count share a transition tree, and a later literal storing a wider value in a shared field
  deprecates every map below it — a load never migrates, so the feedback stays unusable and callers
  re-deoptimize for good (`wad/map/defs.ts`'s `Node`; docs/wad.md § Node formats).
- **A context carries policy as well as data**: `mapmesh.ts`'s `Build` covers the whole map or one
  mover's sector, differing only in its `holdsStill`/`includeSide` predicates, so no builder below
  has to know which.

## Comment shape

**Every `src/` file opens with a header comment** — one to three sentences on what it owns and
where it sits, ending in a pointer to its subsystem doc. It is the router into `docs/` at the point
of reading: purpose, not a contents list. A one-function file may let that function's JSDoc carry
the pointer (`util/damping.ts`); `constants.ts` and `types.ts` point at CLAUDE.md.

**Beyond the header, comments are minimal, and a rule a doc covers is written once — in the doc.**
Three tiers, by what breaks if missing:

1. **Doc-owned** — an invariant a `docs/` file covers (fidelity, an algorithm's shape, bug
   history): a sentence on what the thing does, the rule's name, and `docs/x.md § heading`. Never
   the argument, vanilla C, or how the bug was found.
2. **Site-local** — a hazard about this code's shape no doc is the home for (the
   `world.ts`/`player.ts` import-cycle workaround, the `tsc` narrowing quirk, a deliberate
   allocation). Inline and short.
3. **Citations** — the `info.c`/`g_game.c` note or "tuned by feel" CLAUDE.md's constants rule
   requires.

A doc-owned comment holding something the doc lacks moves it into the doc.

- **The subject is our code.** A vanilla/Boom/GZDoom name is a supporting clause, never the
  subject: delete the foreign name — if nothing is left, the comment was not earning its place.
  `/** Vanilla `player->secretcount`. */` on `secretsFound` fails. Citations stay: a transcribed
  table, a derived constant and a deliberate deviation name their source, and a file that *is* a
  transcription (`audio/sfx.ts`, `wad/campaign/pars.ts`, `specials/generalized.ts`) says so in its
  header. The source is the real one, never the Doom wiki alone.
- **A doc block belongs to a declaration.** Never stack two `/** */` blocks or insert code between
  a block and what it documents — editors show the doc on the wrong symbol. A group of related
  constants carries its rationale on the first one's JSDoc, not a floating block.
- **State what is true, not what changed.** No "now", "used to", "was tried" — they date the
  comment. Bug history goes in the commit message. A decision worth protecting from a revert says
  it is deliberate and points at the doc that argues it.
- **Parallel fields may repeat a comment; arguments may not.** Sibling fields in the same words
  are fine (`WallQuad.baseAlpha`/`FlatSurface.baseAlpha`); an argument at two sites is the tier-1
  violation.
- **100 columns**, comments and `docs/` prose alike; a `/** … */` that would overrun becomes a
  block. Exempt: tables, code fences, a single unbreakable token. Code is not held to it.

## Abbreviations

- **Upper case in prose** — comments, docs, player-facing text: `ESC`, `ID`, `IDs`.
- **Code keeps its casing**, backtick spans included: `getElementById`, `wadSetId`, and the
  persisted `SaveGame.id`/`SaveWad.id` (renaming those is a `SAVE_VERSION` break).
- **`id Software` stays lowercase**, as do `id-era` and URLs — which is why prose `ID` is upper:
  lowercase `id` is the company.

## Imports

- **Every relative import carries `.ts`**: `allowImportingTsExtensions` plus Node ESM resolution
  means `from './wad/reader'` does not resolve.
- **No `index.ts` barrels.** The entry-point file is the barrel *and* the implementation, which
  keeps its public surface an explicit list.
- **Names arrive named; a namespace import is for three cases**: a package with one name
  (`THREE`), two modules whose exports collide (`map.ts`'s `hexen`/`udmf`), and **any module a file
  takes a dozen-odd names from and reads each a handful of times** — `specials.ts`'s `defs.`,
  `menu.ts`'s `wadlib.` over `wad/library.ts`. It costs `noUnusedLocals` on that module — a
  namespace is always used — so dense use sites (`specials/tables.ts`) and a file importing two
  `defs.ts` at once stay on named imports.
- **A densely read name stays named beside the namespace**, in its own `import type`/`import`:
  `menu.ts` reads `WadSource` at 26 sites and takes it named, everything else through `wadlib`.
- **The namespace is named for the module, never for a word the file already uses**: `wadlib`, not
  `library` — `menu.ts` holds a `LibraryUi` in `this.library`.

## Whitespace

UTF-8, LF, two-space indent, final newline, no trailing whitespace — `.editorconfig` is the only
place these live; there is no linter and no formatter. Markdown keeps trailing whitespace (a hard
line break) and wraps prose at 100 columns; tables run past it. The file whitelists extensions
(`.ts`, `.css`, `.html`, `.json`, `.md`) rather than matching `[*]`: the WADs and DEHACKED patches
under `public/game/` and `tests/fixtures/` stay byte-verbatim. A new text extension is added there.

`.claude/hooks/conventions.mjs` checks the mechanical rules here — source order, inline `if`,
comment width, the two toolchain constraints — on files *Claude* writes; run by hand with
`node .claude/hooks/conventions.mjs <file>`. Agent tooling: no npm script runs it, it gates nothing.

## Inline `if`

**An `if` keeps its statement on the line only for an early out** — `return`, `continue`, `break`,
`throw` — however many clauses: `if (!a || !b) continue;`. **Anything else takes a braced block once
the condition has more than one clause**: with two clauses and a trailing call, the statement reads
as part of the condition. `if (taken) this.audio.play(...)` stays; `if (a === b && c === d)
this.moverLerp.delete(id);` is braced.

## Known deviations

Pending, not precedent: what `node .claude/hooks/conventions.mjs <file>` reports on a module — a
private helper above the last export in a module that is not a bag of pure functions, a
multi-clause condition carrying its statement. Fixed when the file is next touched; the hook is the
list.

Not a deviation: a layer entry point re-exporting its own — `specials.ts` hands out
`SectorEffects`, built before the `World` the controller needs (docs/savegames.md § Apply order).
The test: an export that leaves the layer only to be handed straight back in is a round trip and
belongs to the layer.
