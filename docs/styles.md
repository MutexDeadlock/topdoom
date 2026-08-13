# Stylesheets

`src/styles.css`, `src/ui/base.css`, and one `.css` per `src/ui` module

## One stylesheet per owning module

Markup is static in `index.html`, looked up by id in a module's field initializers, and the module
only ever toggles class names (`src/ui/menu/menu.ts`, `hud/hud.ts`, …). The stylesheets follow that
same ownership: **the rules for an element live in the `.css` named after the `.ts` that drives it**,
next to it.

```
src/styles.css        the entry, and the only stylesheet index.html links
src/ui/base.css       page reset, #app, canvas, and the tokens below
src/ui/fatalerror.css #fatal-error — owned by src/main.ts, hence not in a subfolder
src/ui/hud/           everything drawn over the running level (docs/hud.md's own file list)
    hud.css           #hud-bar, #game-hud, #hud-levelstats, #hud-timer
    screeneffects.css #screen-tint, #pain-flash, #death-overlay
    message.css       #hud-message
    levelcard.css     #level-card
    intermission.css  #intermission
src/ui/menu/
    menu.css          #menu
    changelog.css     #changelog and its #menu button.link trigger
src/ui/devmode/
    devmode.css       #hud, #profiler-hud
```

`hud/screeneffects.css` holding the death overlay is the one case where a file boundary doesn't
match what a reader would guess from the element names — it's there because `screeneffects.ts` shows
and hides all three. `crosshair.ts` and `wadfont.ts` sit in `hud/` with no stylesheet of their own:
one writes a data-URI cursor, the other only rasterizes glyphs.

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

- **The profiler's bar colours** (`devmode.css`) are a green/gold/red *status* scale. The red
  happens to be the accent's hex and stays literal anyway, so retuning the menu accent can't
  recolour a warning.
- **The save row's `.caution` amber** (`savegames.css`) is the same argument at text weight: it
  pairs with the red `.warning` as a status scale, not as a rung of the accent family, so retuning
  the accent must not follow it. One site, so no token either way.
- **`#changelog { z-index: 5 }`** is inside `#menu`'s stacking context, not on the global ladder.

### The stacking ladder

`--z-tint: 5` (`#screen-tint`, `#pain-flash`) → `--z-hud: 10` (`#hud`, `#profiler-hud`, `#hud-bar`)
→ `--z-message: 12` (`#hud-message`, `#level-card`) → `--z-overlay: 15` (`#intermission`,
`#death-overlay`, which can never be up at the same time) → `--z-menu: 20` → `--z-fatal: 30`.

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
