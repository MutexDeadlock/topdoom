# Markup and stylesheets

`index.html`, `src/styles.css`, `src/ui/base.css`, and one `.html` + one `.css` per `src/ui` module,
assembled by `plugins/html-partials.ts`

## One owner per element

Markup is static, looked up by id in a module's field initializers, and the module only ever
toggles class names and text (`src/ui/menu/menu.ts`, `hud/hud.ts`, …). Both the markup and the
rules follow that ownership: **an element's `.html` and `.css` are named after the `.ts` that
drives it, and sit next to it.**

```
index.html            the page skeleton: <head>, #app, the @include list, the module script
src/styles.css        the stylesheet entry, and the only one index.html links
src/ui/base.css       page reset, #app, canvas, and the tokens below
src/ui/fatalerror.*   #fatal-error — owned by src/main.ts, hence not in a subfolder
src/ui/loading.*      #loading, the boot screen — main.ts's too, and the one element in the
                      markup that starts visible (docs/menu.md § Session lifecycle)
src/ui/hud/           everything drawn over the running level (docs/hud.md's own file list)
    hud.*             #hud-bar, #game-hud, #hud-levelstats, #hud-timer
    screeneffects.*   #screen-tint, #colormap-tint, #pain-flash
    message.*         #hud-message
    levelcard.*       #level-card
    intermission.*    #intermission
    deathoverlay.*    #death-overlay
src/ui/menu/
    menu.css/.html    #menu, and #changelog inside it
    changelog.css     #changelog's own rules and its #menu button.link trigger
    savegames.css     the save/load lists inside #menu's tab panels
src/ui/devmode/
    debughud.*        #hud
    profilerhud.*     #profiler-hud
```

Every file here is named after the module that shows and hides its elements, with no exceptions.
Two modules drive parts of markup they don't own the *element* of, and so have no `.html`:
`savegames.ts` fills panels inside `#menu`, and the changelog popup is driven by `menu.ts` itself.
`crosshair.ts` and `wadfont.ts` have neither file — one writes a data-URI cursor, the other only
rasterizes glyphs.

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
build does and checks every id modules look up against it in both directions, plus that no partial
is left unreferenced. Without it a dropped `@include` builds green and fails as a `null` field.

`styles.css` is at `src/` rather than in `ui/` because it belongs to the page, not to any one UI
area: it is what `index.html` links, and everything else reaches the browser through its `@import`
list — in stacking order, `base.css` first so the tokens exist before anything reads them. Vite
inlines the imports into a single asset at build. **The parts are never imported from TS**
(`import './hud.css'` in a module): anything under `src/` may be pulled in by a script run through
Node's native TS stripping, which would choke on it.

Every rule is id-scoped, so ordering between the parts is not load-bearing — but keep the import
list in stacking order anyway, since that's the order a reader will look for.

## Tokens

`:root` in `base.css`. A value earns a token by being an **exact repeat across two or more
stylesheets**, or by being a **rung of a named ladder** (the text ramp, the accent family, the
stacking ladder) — a ladder goes in whole even where a rung has one user, because retuning one rung
means looking at its neighbours.

Everything else stays a literal. Values used two or three times inside a single file
(`#17171c`, `#4a4640`), and near-misses of a token that are not the same colour (`#a08e88`,
`#6f6a65`, `#1b1b21`, the `rgba()` scrims), are deliberately not folded in: collapsing them into the
nearest token would be a visual change wearing a cleanup's clothes.

Three documented exceptions, each commented at the site:

- **The profiler's bar colours** (`profilerhud.css`) are a green/gold/red *status* scale. The red
  happens to be the accent's hex and stays literal anyway, so retuning the menu accent can't
  recolour a warning.
- **The save row's `.caution` amber** (`savegames.css`) is the same argument at text weight: it
  pairs with the red `.warning` as a status scale, not as a rung of the accent family, so retuning
  the accent must not follow it. One site, so no token either way.
- **`#changelog { z-index: 5 }`** is inside `#menu`'s stacking context, not on the global ladder.

### The stacking ladder

`--z-tint: 5` (`#screen-tint`, `#colormap-tint`, `#pain-flash`) → `--z-hud: 10` (`#hud`, `#profiler-hud`, `#hud-bar`)
→ `--z-message: 12` (`#hud-message`, `#level-card`) → `--z-overlay: 15` (`#intermission`,
`#death-overlay`, which can never be up at the same time) → `--z-menu: 20` → `--z-loading: 25`
(`#loading`, over the menu it hands the page to) → `--z-fatal: 30`.

A new overlay picks its rung by reading that one block rather than grepping for `z-index`.

## What isn't in CSS

Per-frame animation is written from JS as an inline style, not a CSS transition: the level card's
fade (`levelcard.ts`, docs/hud.md § Level card), the pain flash's decay (`screeneffects.ts`), the
profiler bar widths. There are no `@keyframes`, `@font-face` or `@media` rules anywhere — the whole
UI is one monospace stack declared once in `base.css`.

There is also **no global `.hidden` rule**; every element scopes its own (`#menu.hidden`,
`#intermission canvas.hidden`, …), because what "hidden" has to mean differs — `display: none` for
most, `visibility: hidden` for the menu's tab panels so both keep reserving the grid cell
(docs/menu.md § One screen, two jobs).
