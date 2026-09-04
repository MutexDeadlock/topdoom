# Markup and stylesheets

`index.html`, `src/styles.css`, `src/ui/base.css`, and one `.html` + one `.css` per `src/ui` module,
assembled by `plugins/html-partials.ts`

## One owner per element

Markup is static, looked up by ID in a module's field initializers, and the module only ever
toggles class names and text (`src/ui/menu/menu.ts`, `hud/hud.ts`, …). Both the markup and the
rules follow that ownership: **an element's `.html` and `.css` are named after the `.ts` that
drives it, and sit next to it.**

```
index.html            the page skeleton: <head>, #app, the @include list, the module script
src/styles.css        the stylesheet entry, and the only one index.html links
src/ui/base.css       page reset, #app, canvas, the shared classes and page-wide scrollbar
                      look, and the tokens below
src/ui/fatalerror.*   #fatal-error — owned by src/main.ts, hence not in a subfolder
src/ui/loading.*      #loading and its panel (#loading-title, #loading-bar/#loading-fill,
                      #loading-detail) — the boot screen and every level load after it, main.ts's
                      too, and the one element in the markup that starts visible
                      (docs/menu.md § The loading screen)
src/ui/hud/           everything drawn over the running level (docs/hud.md's own file list)
    hud.*             #hud-bar, #game-hud, #hud-levelstats, #hud-run (#hud-timer,
                      #hud-recording)
    screeneffects.*   #screen-tint, #colormap-tint, #pain-flash
    message.*         #hud-message
    levelcard.*       #level-card
    intermission.*    #intermission
    deathoverlay.*    #death-overlay
    replaybar.*       #replay-bar (track, #replay-scrub, #replay-hover, #replay-crosshair),
                      #replay-reticle, #replay-seek, #replay-flash
    profiler.*        #profiler-hud, and its #profiler-cpu/#profiler-rows/#profiler-gpu children
src/ui/menu/
    menu.css/.html    #menu
    about.*           #about, the About/Changelog popup inside #menu, and its
                      #menu button.link triggers
    savegames.css     the save/load lists inside #menu's tab panels
    replays.css       #menu's Replays panel: the record button, the list and the detail panel
    library.css       #wadlibrary, the WAD Library overlay inside #menu
    wadinfo.*         #wadinfo, the popup reading the .txt beside a WAD, over both WAD lists
                      (docs/menu.md § The text file popup)
    hold.css          .hold/.holding, the press-and-hold confirm on any #menu button
src/ui/devmode/
    debughud.*        #hud
```

The one thing that doesn't live in a module's own file is a **shared class** — `.hidden`,
`.overlay`, `.panel`, `.truncate`, all in `base.css` (§ Shared classes below). Ownership still
holds: a module's file keeps every rule that makes its element *itself*, and takes the shared class
for the part it has in common with seven others.

Every file here is named after the module that shows and hides its elements, with one exception:
**`hold.css` is named for a behavior, not an element.** Its rules are keyed on the `.hold` class
`hold.ts` applies, and the buttons wearing it belong to several different modules (the save rows,
the WAD Library's Forget, the footer's Start new game) — filing it under any of them would leave the
others importing a stylesheet named after somewhere else. `#menu button.primary .fill` lives here
too, for the same reason: the fill is this file's element, whoever's button wears it. It is imported after `menu.css` so `#menu button.hold` follows the `.ghost`
rules it sits alongside; the two set disjoint properties, so the order is for reading, not cascade.

`hold.ts` also wraps a held button's content in a `.label` span, so **a panel-wide rule on a generic
class name reaches inside every button in that panel**. Name the owners instead:
`#menu .replay-detail .field .label, #menu .replay-detail .facts .label` and not
`#menu .replay-detail .label`, which shrank the delete button's glyph to a caption's 11px and its
box with it.

Two modules drive parts of markup they don't own the *element* of, and so have no `.html`:
`savegames.ts` fills panels inside `#menu`, and `library.ts` drives `#wadlibrary`, whose markup sits
in `menu.html` beside the `@include` of `about.html`. `crosshair.ts` and `wadfont.ts` have neither
file — one writes a data-URI cursor, the other only rasterizes glyphs, and `overlay.ts` is `hold.ts`'s
sibling: a behavior shared by the three popups, handed the elements they own
(docs/menu.md § The overlays over the menu).

## Assembling the page

HTML has no `@import`, so `plugins/html-partials.ts` supplies one: a line reading
`<!-- @include ./src/ui/hud/hud.html -->` is replaced with that file's contents, indented to the
directive's own column, recursively and with a named error on a cycle or a missing file. Partials
are authored at column 0 and are fragments — no `<html>`/`<head>` of their own. It runs as a `pre`
`transformIndexHtml`, so Vite still resolves whatever a partial contributes, and the assembled page
is what both the dev server and the build emit.

Editing a partial triggers a **full page reload**, not an HMR patch: the partials aren't in the
module graph, and every module resolves its elements once in its field initializers — swapping
markup under a live `Menu`/`Hud` would leave it holding detached nodes.

`tests/ui/markup.test.ts` is what makes the spread safe: it assembles the page the same way the
build does and checks every ID modules look up against it in both directions, plus that no partial
is left unreferenced. Without it a dropped `@include` builds green and fails as a `null` field.

`styles.css` is at `src/` rather than in `ui/` because it belongs to the page, not to any one UI
area: it is what `index.html` links, and everything else reaches the browser through its `@import`
list — in stacking order, `base.css` first so the tokens exist before anything reads them. Vite
inlines the imports into a single asset at build. **The parts are never imported from TS**
(`import './hud.css'` in a module): anything under `src/` may be pulled in by a script run through
Node's native TS stripping, which would choke on it.

Every rule is ID-scoped, so ordering between the parts is not load-bearing — but keep the import
list in stacking order anyway, since that's the order a reader will look for.

## Page metadata

`index.html`'s `<head>`, above the stylesheet link, is entirely for crawlers and link unfurls —
nothing in `src/` reads any of it. It pairs with five files in `public/`, which Vite copies to the
site root unchanged:

| File | |
|---|---|
| `favicon.ico` | the tab icon, 16/32/48 in one file |
| `apple-touch-icon.png` | 180×180, the logo at full detail — the source the `.ico` is cut from |
| `og.jpg` | 1200×630, the `og:image` card |
| `robots.txt` | `Disallow: /game/`, and the `Sitemap:` line |
| `sitemap.xml` | the one URL there is |

Those five are all `public/` holds at its root. The only subfolder is `public/game/{iwad,pwad}/`
(docs/wad.md), the game data fetched by URL at runtime. Two more things are served under `/game/`
without being files there, both emitted by a Vite plugin: the WAD manifest and `topdoom.wad`, what
the engine ships itself because no WAD has it — light definitions, secret chime, player skins —
built from `assets/` (docs/wad.md § The WAD the engine ships).

**The canonical origin is written out literally, in every one of them.** `canonical`, `og:url`,
`og:image`, the JSON-LD `url`/`image`, `robots.txt`'s `Sitemap:` and `sitemap.xml`'s `<loc>` each
spell out `https://topdoom.vercel.app` — absolute URLs are what a crawler needs, and a Vite
`%VITE_%` substitution would leave the literal placeholder in the page whenever the variable is
unset. Moving the site means grepping the origin and changing every hit.

`robots.txt` excludes `/game/` because a build ships whatever is in `public/game/` — tens of
megabytes of game data with nothing to index, and not ours to serve to a crawler.

**The `.ico` carries different artwork per size, which is what the format is for.** 48 px is the
logo whole; 16 and 32 are a tighter crop of it, because the wordmark goes illegible at those sizes
when the surrounding glow is scaled down with it. Recut all three from `apple-touch-icon.png` when
the logo changes — a straight `-resize 16x16` of the full art is a coloured smudge.

`og.jpg` is a **Freedoom** screenshot, not a DOOM one: the card is served to anyone who links the
page, and Freedoom's assets are the ones that may be redistributed. Any 1200×630 capture does;
what has to stay in step is the file name and the format, which `og:image` and `og:image:type`
both name.

## Tokens

`:root` in `base.css`. A value earns a token by being an **exact repeat across two or more
stylesheets**, or by being a **rung of a named ladder** (the text ramp, the accent family, the
stacking ladder) — a ladder goes in whole even where a rung has one user, because retuning one rung
means looking at its neighbours.

Everything else stays a literal. Values used two or three times inside a single file
(`#17171c`, `#4a4640`), and near-misses of a token that are not the same colour (`#a08e88`,
`#6f6a65`, `#1b1b21`, the `rgba()` scrims), are deliberately not folded in: collapsing them into the
nearest token would be a visual change wearing a cleanup's clothes.

**Status colours are their own family**, and never rungs of the accent: a warning must not move when
the menu accent is retuned. `--caution` (the text-weight amber) is a token because two stylesheets
read it — the save row's missing-add-on note and the WAD Library's support column. Its neighbours in
that scale are not, and each says why at the site: the support column's green has one site, and the
profiler's green/gold/red bar fills are at fill weight rather than text weight (its red happens to
be the accent's hex and stays literal anyway, precisely so the two can't be retuned together). Where
a status colour *is* the accent it says so — the support column's red reads `--accent-text-hover`,
because `#menu .warning` already made that the menu's one red for "this won't work" and a second
would only be a near-miss. The info column's blue (`#menu .row .meta.info`) is a literal on the same
terms and for the opposite reason: it is the page's one blue, and an aside the player may open must
not be a rung of the family that means "this won't work".

One further documented exception:

- **`#about` and `#wadlibrary` at `z-index: 5`, `#wadinfo` at `6`** are inside `#menu`'s stacking
  context, not on the global ladder. The 6 is the one relation among them that matters: the reader
  opens from a row in the WAD Library, so it has to cover it.

### The stacking ladder

`--z-tint: 5` (`#screen-tint`, `#colormap-tint`, `#pain-flash`) → `--z-hud: 10` (`#hud`,
`#profiler-hud`, `#hud-bar`) → `--z-message: 12` (`#hud-message`, `#level-card`) → `--z-overlay: 15`
(`#intermission`, `#death-overlay`, which can never be up at the same time) → `--z-menu: 20` →
`--z-loading: 25` (`#loading`, over the menu it covers while a level loads) → `--z-fatal: 30`.

A new overlay picks its rung by reading that one block rather than grepping for `z-index`.

## Shared classes

`.hidden`, `.overlay`, `.panel` and `.truncate` live in `base.css`, and a class earns a place there
the way a token does: **the thing it names is shared by six or more elements across as many files.**
Nothing lands there for being short or for recurring within one module.

`.hidden` is the odd one, below. The other three are *bases* — an ID rule outscoring them is how an
element refines the shared start (`#death-overlay` turns `.overlay`'s row into a column), so none of
them takes `!important` and none should.

## Hiding an element

**One class does it: `.hidden`, defined once in `base.css` and toggled from every ui module.** No
stylesheet declares its own `.hidden` rule.

It is `display: none !important`, and the `!important` is load-bearing rather than defensive. Almost
every element that hides sets its own `display` through an ID selector — `#menu { display: flex }`,
`#intermission canvas { display: block }` — so a plain `.hidden` at (0,1,0) would lose to all of
them. It would lose *silently*: nothing errors, the element simply stays on screen.

The cost of that is the rule can no longer be overridden per element, so **anything whose hidden
state must not be `display: none` needs a different class**, not a scoped `.hidden`. There is one:
`#menu .tab-panel.inactive` (`visibility: hidden` + `pointer-events: none`), because the panels
share one grid cell and an inactive one has to keep reserving it or the menu's height jumps on a tab
switch — docs/menu.md § One screen, two jobs. `menu.ts` toggles `inactive` on both the tab panels
and the Settings sub-panels; every other element in the tree toggles `hidden`.

Note the HTML `hidden` *attribute* on the file inputs is unrelated — the UA stylesheet's own rule,
on elements that never become visible.

## What isn't in CSS

Per-frame animation is written from JS as an inline style, not a CSS transition: the level card's
fade (`levelcard.ts`, docs/hud.md § Level card), the pain flash's decay (`screeneffects.ts`), the
profiler bar widths. There are no `@keyframes`, `@font-face` or `@media` rules anywhere — the whole
UI is one monospace stack declared once in `base.css`.

The **scrollbars are page-wide too**, and are a look rather than a class — declared in `base.css`
right after the reset, because the menu panels, the About popup and the error screen would
otherwise each repeat it: `scrollbar-width`/`scrollbar-color` on `html` (the latter inherits, so the
root declaration reaches every scroller), plus a `::-webkit-scrollbar` block giving the same slim,
track-less bar on engines that don't support the standard properties. The two are alternatives, not
a duplicated declaration: an engine that honours `scrollbar-color` ignores the pseudo-elements. A
new scrolling element inherits the look with no rule of its own.
