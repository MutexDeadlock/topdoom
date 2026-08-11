# Menu, settings, session lifecycle and dev mode

`src/ui/menu/menu.ts`, `src/ui/menu/menu.css` + `src/ui/menu/changelog.css`, `index.html`'s `#menu`,
`src/main.ts`, `src/constants.ts: DEVMODE`, `src/ui/devmode/`, `src/util/profiler.ts`

The menu is plain DOM: every element is static markup in `index.html`, looked up by id in `Menu`'s
field initializers, so **an id renamed in the HTML fails at construction**, not lazily. Only the WAD
lists, the level list and the difficulty options are built in JS.

## One screen, two jobs

`Menu` is both the launcher and the pause screen. `open(inGame)` is what distinguishes them:

- `inGame` puts the `ingame` class on `#menu`, swapping the opaque radial gradient for a translucent
  dim so the frozen level shows through (`Game` keeps drawing it — docs/frameloop.md § Pausing), and
  reveals **Return to game**. Both are off before any level is loaded: there is nothing behind the
  menu then but the static HUD markup with placeholder values, which the opaque gradient exists to
  hide.
- The active tab is *not* reset on open — it's whichever the player last clicked (`newgame` on the
  first open, set in the constructor). Reopening mid-level to change one setting must not throw away
  the tab they were on.
- All tab panels are stacked in **one CSS grid cell** and hidden with `visibility`, not
  `display: none`, so the panel's height is always the tallest of them and switching tabs doesn't
  resize the menu under the cursor. That is also why the Settings tab's rows are kept compact, and
  why Level and Difficulty share a row on New Game: whatever height any tab costs, the others pay
  too — the save lists cap themselves with the `.list` scroller for the same reason.

`Esc` toggles between the menu and the game. With the menu open and no level loaded it does nothing
— there is nothing to return to.

`#menu` sits at `--z-menu` on the stacking ladder, above every in-game overlay and below the
fatal-error screen — the whole ladder is one block in `base.css` (docs/styles.md § The stacking
ladder).

`VERSION` (`constants.ts`) is shown prefixed with `v`, right-aligned on the title's own row
(`#menu header` is a `space-between` flex row), with the changelog link stacked under it in the same
`.build` column; a static credit sits bottom-left, outside the panel.

## Changelog

The header's **CHANGELOG** link opens `#changelog`, a scrolling reader over the repo's `CHANGELOG`
file. Two things about it are load-bearing:

- The text is a **dynamic** `import('../../../CHANGELOG?raw')`, run on first open (`loadChangelog`).
  Dynamic, because the file only grows and nobody who never opens the reader should pay for it: the
  bundler gives it its own chunk (~12 kB, 5 kB gzipped) instead of the main one. `import` rather than
  `fetch`, because the file lives at the repo root rather than under `public/`, so a fetch would
  resolve in dev and 404 in a build. A failed load is reported in the panel and leaves the popup
  unmarked as loaded, so reopening retries.
- **`Esc` is handed off explicitly**, not raced. `main.ts`'s `Esc` listener calls
  `menu.closeChangelog()` first, which reports whether it had anything to close — so one `Esc`
  dismisses the popup and leaves the menu (and a paused level) alone. A second window listener in
  `Menu` would have made that depend on registration order.

`#changelog` is a child of `#menu` so it disappears with it; `close()` also closes it, or it would
still be up the next time the menu opens.

## Save and Load tabs

`ui/menu/savegames.ts` (`SavegamesUi`) renders both panels over the `game/savegames.ts` store; the
format, apply order and WAD-identity rules are docs/savegames.md's. What is the menu's own:

- **The Save tab exists only mid-game** — `open(inGame)` hides its button with `display: none` (the
  `#controls-dev` pattern; the button must leave the flex row, not hold a gap) and moves anyone
  still on it to New Game. Same gate as the resume button: there is nothing to save otherwise. The
  Load tab is always available.
- Saving takes an optional name (defaulting to map + date), and both panels list every save, newest
  first: thumbnail, name, the level, then skill · level time · date. Rows are rendered fresh on every
  `open` via `SavegamesUi.refresh`, with the `#pwad-list` scrollTop-restore trick.
- **The level line and the missing-file warnings come from `Menu.describeSave`**, not from the save:
  a save stores the map *lump* name, which alone can't name a level (docs/wad.md § Level names), so
  the row resolves it against the current library through `mergedMaps` and names it with the same
  `describeMap` the level select uses — `<lump>  —  <title>  —  <provider>`, so the two lists can't
  disagree about what a level is called. The same pass reports
  every file of the set the library no longer offers, as a subtle red `Missing IWAD/PWAD: <file>`
  line per file. It names the file from the save's own `wads` list rather than its `sourceKeys`,
  since an upload's key is a synthetic `upload:…` string and the *file name* is what has to be found
  again (docs/savegames.md § WAD-set identity). Load stays enabled: the attempt is what tells the
  player which file to bring back. `addFiles` re-renders the save lists as well as the WAD lists, so
  bringing that file back clears the warning on the spot rather than on the menu's next `open` —
  which is also why `Menu` keeps the last `inGame` it was opened with.
- **The name in each row is an `<input>`** — renaming happens in place (`renameSave`), Enter or blur
  commits, Esc reverts and is stopped from bubbling to `main.ts`'s menu-closing handler. An untouched
  field re-renders nothing, so a plain focus-and-blur can't pull the row out from under a click
  heading for one of its own buttons.
- **The save lists fill the panel vertically**: `.saves-section` is the tab panel's flexible child
  and the list is the section's, against a `#menu > .panel` capped at the viewport — so the rows use
  whatever height is left and scroll inside the menu instead of growing it off-screen. Because the
  tab panels share one grid cell, that height is the tallest panel's on every tab, as before.
- An **unsupported version** renders dimmed via its own `unsupported` class rather than `.disabled`
  (a child can't undo a parent's opacity, and its download/delete buttons must stay live); only
  Load is refused.
- **Delete and Overwrite are two-click inline confirms** (`confirmOnSecondClick`: the button arms for
  3 s), so the changelog stays the menu's only popup. Both are per row; Overwrite refills that save
  from the current moment, keeping its id and its name (renaming has its own affordance), and can't
  hit `MAX_SAVES` since no new key appears. Delete and download are icon-only buttons (`⤓`, `🗑︎` with
  a text-presentation selector) with their meaning in the tooltip; Load and Overwrite are `.primary`.
- **Download** writes the save as `topdoom-<map>-<date>.json` through a temporary anchor, re-indented
  with tabs on the way out (`exportSave`) — the stored copy stays compact for the quota, but a file
  on disk is something a person can open;
  **import** accepts such a file back via its own `#save-file-input` (the WAD `#file-input` is
  multiplexed by `uploadTarget` and stays out of this), or by dropping a `.json` onto the menu —
  `installDropTarget` routes `.json` to the importer and everything else to `addFiles` as before.
- Every failure — quota, cap, version, missing WAD — lands in the shared `#menu-status` line;
  `SavegamesUi` never touches the running game. The three hooks (`onSave`, `onOverwrite`, `onLoad`)
  are `main.ts`'s (§ Session lifecycle below), which owns the `Game` instance and the selection the
  save records; the first two share one `withCapture` body, differing only in what they write.

## Picking a WAD set

The lists are fed by `/wads/index.json` (docs/wad.md § The `public/wads/` manifest) plus anything
loaded from disk. Semantics worth knowing before touching `menu.ts`:

- **Game WAD** (`renderIwads`) only offers sources with `type === 'IWAD'`. A PWAD mapset can still be
  *played* as the game WAD (uploaded through the IWAD picker, or `?wad=`), but it doesn't appear in
  this list to pick from directly.
- **Add-ons** (`renderPwads`) excludes anything of `type === 'IWAD'` and whichever source is
  currently the game WAD (even a PWAD-typed one uploaded through the IWAD picker) — otherwise it
  would show up twice. Order matters and is the order they were ticked: it's the merge order, so the
  rows carry a `#N` badge. Ticking a row re-renders the whole list, which empties the scroller and
  would clamp it back to the top, so `renderPwads` saves and restores `scrollTop` — with enough
  add-ons installed the list scrolls, and picking one out of the bottom of it must not scroll away.
- Files dropped on the window or picked from disk are parsed in the browser and behave identically to
  server-side ones. **The picker decides, not the signature**: a file uploaded via "game WAD" becomes
  the game WAD regardless of its declared type, one uploaded via "add-on" is added as an add-on.
- **Add-ons are filtered by game.** An add-on whose own map style conflicts with the selected game
  WAD's (`library.ts: mapStyle`, see docs/wad.md § The `public/wads/` manifest for what style means)
  is rendered **disabled** rather than hidden — a mapset that's simply for the other game is still
  worth seeing, just not pickable. Switching game WAD calls `pruneIncompatiblePwads` to drop any
  already-ticked add-on that no longer matches, so the merged map list (`mergedMaps`) never silently
  mixes an E1M1 with a MAP01 mapset.
- The **Level** list groups DOOM 1's `ExMy` maps by episode, and each row reads
  `<lump>  —  <title>  —  <provider>`, dropping either of the last two when it doesn't apply: the
  title only when the WAD set knows one (docs/wad.md § Level names — resolved off the manifest
  alone, since nothing has been downloaded at this point), the provider only when an add-on took the
  map over. The lump name always comes first: it is what the level is selected by, what `?map=`
  takes, and the only thing every map has. The label itself is `library.ts`'s `describeMap`, shared
  with the save rows (§ Save and Load tabs) so a level can't be named two ways in one menu.

## Difficulty

**Difficulty lives on the New Game tab, not the Settings tab** — it belongs with the WAD and level,
the other two things a start is composed of, and unlike volume and autorun it can't apply live:
skill only takes effect where things are spawned (`game/things.ts: buildThingSprites`), so changing
it mid-level would silently do nothing until the next load. It shares a row with Level (`.columns
even`, § Settings tab below).

`#skill-select` is filled once from `SKILL_NAMES` and seeded from `topdoom.skill`; a change writes
that key back, so the next visit opens on the last skill played. **What a start actually runs at is
`currentSkill()`, read off the select, not off storage** — where `localStorage` is unavailable the
write goes nowhere and reading it back would silently ignore the player's pick. `submit()` (the
`?map=` deep-link path) reads the same getter, which is the stored skill there since nothing has
touched the control.

## Settings tab

**Mostly the full key list, and it is the only one the game itself shows** — it replaced two hint
lines in the DEVMODE status text, which meant a shipped build listed its controls nowhere. Being a
menu tab makes it reachable mid-level too, since the menu is the pause screen. README's table is the
fuller reference; this one stays short enough not to stretch the other tab (see the grid-cell note
above).

**The settings live inside that list rather than in sections of their own**, because nearly
everything a player can change *is* a key's behavior: the right button's binding is the `right mouse`
row's description, the autorun checkbox is the `Shift` row's. A player looking up what a control does
and a player changing it are the same person on the same trip to the menu — which is why the tab that
briefly held only a volume slider was folded into this one rather than kept beside it.

**The two settings that aren't a key's behavior — sfx volume and the frame rate limit — share the
bottom row** (`.columns even`), so the second costs the panel no extra height. The limit is
`#fpscap-select`, and its `<option>` values *are* the capped rates (`0` = unlimited, the default), so
the control needs no mapping table. It is owned by `game.ts` (`getFpsCap`/`setFpsCap`), whose frame
loop is the only thing it changes, and is read live per frame — changing it mid-level applies to the
level already running, like volume and autorun. See docs/frameloop.md § The FPS cap for how a cap is
actually held.

**The `Shift` row's description is the word autorun currently makes true** — `walk` when it's on,
`run` when it's off — so `installAutorun` writes `#shift-action` from the same `show` helper that
sets the checkbox, the shape `installVolume` already uses. A fixed description here would state one
case and leave the other to be inferred from a checkbox two words away.

Two CSS notes for that: `#menu .keys select` undoes the full-width, roomy `#menu select` so the
binding stays on one line, and `dd.inline` is the flex row that lets a description carry a control
beside it.

Camera, Game and the dev row share `.columns`, which is **flex, not fixed grid tracks** — the
DEVMODE-only section becomes a third column when shown and leaves two when it isn't, with no empty
cell to suppress. Columns are content-width so they pack left rather than being stretched apart,
which is why those descriptions are kept to a word or two. Move and fight stays full width.

`.columns` is shared with the New Game tab, where Level and Difficulty use the `even` modifier:
`flex: 1` plus `min-width: 0`, since a `width: 100%` select needs an equal share it can shrink
inside rather than a content-sized one a long map name would push past the panel.

The rest is static markup with no `Menu` state — no field lookups, no listeners — except
`#controls-dev`, the `N`/`P` map-jump row, which the constructor reveals when `DEVMODE` is set. That
is the same set-once toggle `DebugHud` does for `#profiler-hud`; `DEVMODE` can't change at runtime,
so neither is ever re-checked. **`#controls-dev.hidden` is `display: none`, not the `visibility`
the tab panels use** — a panel has to keep reserving height, but a hidden section must drop out of
the `.columns` flex line entirely.

## Right mouse button

The right button has **no fixed job**: the camera turns with `Q`/`E` rather than by dragging
(docs/render.md § Camera orbit), which left the button free. `#rightmouse-select` binds it to one of
`RightMouseAction`'s three values — `previousweapon` (the default), `use` (same as `Space`), or `none` —
and the `<option>` values *are* those strings, so the control needs no mapping table.

The setting lives in `game/input.ts` beside the button state it describes, and **only
`Input.rightMousePressed(action)` reads it**: consumers ask for the action they implement
(`SpecialsController.handleUseTrigger`, `WeaponSystem.handleSwitching`) rather than importing the
preference, so adding a fourth action can't leave a stale check behind in one of them.

Even at `none` the canvas still suppresses `contextmenu` — a browser menu opening mid-fight is a
surprise whatever the button is bound to.

## Persisted settings

Every persisted value uses a `topdoom.*` `localStorage` key, read through `globalThis.localStorage?`
(so nothing here breaks in a non-DOM context) and **validated on read with an explicit default** —
`Number(null) === 0` otherwise makes "never set" indistinguishable from "silent"/"skill 0". Each
value is owned by the module whose behavior it changes, and the menu only wires the control to that
getter/setter; the exceptions are skill and the WAD selection, which belong to the menu itself.

| Key | Owner | Documented in |
|---|---|---|
| `topdoom.sfxVolume` | `audio/audio.ts` | docs/audio.md § Volume and the context |
| `topdoom.autorun` | `game/player.ts` (`getAutorun`/`setAutorun`) | docs/movement.md § Movement speed and straferunning |
| `topdoom.rightMouse` | `game/input.ts` (`getRightMouseAction`/`setRightMouseAction`) | § Right mouse button above |
| `topdoom.fpsCap` | `game.ts` (`getFpsCap`/`setFpsCap`) | docs/frameloop.md § The FPS cap |
| `topdoom.skill` | `ui/menu/menu.ts` | § Difficulty above |
| `topdoom.selection` | `ui/menu/menu.ts` | § Remembered selection below |
| `topdoom.bestTimes` | `game/besttimes.ts` | docs/hud.md § Best times |
| `topdoom.save.<id>` | `game/savegames.ts` | docs/savegames.md § Storage and the cap |

`topdoom.save.<id>` (one key per save) is the one departure from per-value structural validation:
it carries an explicit `version` field, refused on mismatch rather than half-read. A settings
scalar degrades safely to its default; a save's schema genuinely evolves, and half-reading an old
one restores a subtly wrong level (docs/savegames.md § The format and its version).

## Remembered selection

`topdoom.selection` holds `{ iwad, pwads, map }` as `WadSource.key`s. Precedence when `init` resolves
it is **URL > stored > first IWAD on offer**, and every key is resolved against the current library,
so a WAD that has since left `public/wads/` is silently dropped (an unknown map falls back to the
set's first, via `selectLevel`'s no-op). Restoring can pair a stored add-on with a `?wad=`-forced
game WAD, hence the `pruneIncompatiblePwads` call there.

`saveSelection` is called from the sites where the *player* changes something (`selectIwad`, the
add-on toggle, `addFiles`, the level select's `change`) and **deliberately not from `render`**, which
`init` also runs while restoring: hooking it there wrote the level select back before `selectLevel`
had applied the stored map, so the stored level decayed to the set's first map after one reload.

It **only ever writes server-side sources.** An upload's bytes are gone after a reload, so storing
its key would restore a selection that can never load; leaving the last restorable one in place is
better. As a side-effect, a failed manifest (no sources at all, `selectedIwad` null) can't wipe a
good stored value either.

## URL parameters

Read once in `boot()` and applied through `Menu.init`:

| Param | Effect |
|---|---|
| `?wad=` | Preselect the game WAD by file name (case-insensitive) |
| `?pwad=` | Comma-separated add-ons, applied in the order given |
| `?map=` | Preselect the level **and skip the menu**, at the last skill played |
| `?pos=x,y` | Drop the player at those DOOM map coordinates instead of the map's own start |

`?pos=` is applied *before* fog of war is seeded, so the reveal shows exactly what is visible from
there. **That is the practical way to check a specific spot in a level** — the room with MAP01's big
window is several rooms away from the spawn, so scripting a walk to it is far more work than
`?map=MAP01&pos=800,600`.

## Session lifecycle (`main.ts`)

`boot()` creates everything that must outlive a level exactly once — `Viewport` (one WebGL context
and one canvas for the whole page), `AudioEngine` (one `AudioContext`), the `Menu`, and the `Esc`
listener — and holds a single mutable `game: Game | null`. A `Game` is per-WAD-set/per-level and is
built to be thrown away and replaced.

Rules that hold this together:

- **`new Viewport` is wrapped in `try`/`catch`** and routed to `#fatal-error`: three.js throws a raw
  `Error` when the browser can't create a WebGL2 context, and without this the page is left showing
  only the static HUD markup, which reads as "broken" rather than "your browser can't run this". The
  GPU-specific message is only shown when the error actually looks like a WebGL failure, so an
  unrelated bug isn't misreported as a GPU problem.
- **`audio.resume()` runs synchronously before `startLevel`'s first `await`**, while still inside the
  click handler — the only moment a browser reliably lets an `AudioContext` start. A `?map=` deep link
  never gets that click, so `boot` also arms one-shot `pointerdown`/`keydown` unlockers.
- **The `game` slot is cleared before the old level is disposed.** A `Game` constructor that throws
  (a WAD with no maps, a mesh build failure) would otherwise leave `game` pointing at a *disposed*
  instance, and both "Return to game" and the `Esc` handler key off it being non-null — resuming it
  restarts a render loop over released GPU resources. On failure the menu stays open, shows the error,
  and is re-synced with `open(game !== null)` so it stops offering a return.
- **"Return to game" is disabled for the duration of a start** (`startWithSkill`), since the level it
  would return to is disposed part-way through.
- A second `Game` builds against the *same* static DOM, so anything holding generated children must
  replace rather than append, and per-level screen state must be cleared — see docs/hud.md
  § The HUD and § Screen effects. `dispose` clears the center message, the level card and the
  intermission popup for that reason: all three are static markup that outlives the `Game` that
  raised them.
- `Esc` works during the intermission popup too. `pause()`/`stillFrame` keep drawing, the menu sits
  over the popup, and `resume()`'s `input.reset()` drops the keypress that would otherwise dismiss
  it the moment the game comes back.

## Dev mode (`DEVMODE`)

`DEVMODE` reads `import.meta.env.VITE_DEVMODE`, defaulting to `false`; set `VITE_DEVMODE=true` in a
git-ignored `.env.local` at the repo root to turn it on (Vite loads `.env.local` itself, no plugin
needed). It gates four things — three in `ui/devmode/debughud.ts` and one in `ui/menu/menu.ts` — all because a
player has no legitimate reason to reach for them:

- **The debug overlay** (`DebugHud.update`, whose lines come from `Game.debugLines`) — off, `#hud`
  shows only the fps counter; on, the full
  map/pos/sector/camera-state/awake-monster-count block. **Everything it prints is live state.** It
  used to end with two static hotkey hint lines as well, which were the game's only controls
  reference and so invisible to exactly the players who needed them; that list is now the menu's
  Settings tab (docs/menu.md § Settings tab).
- **The profiling overlay** (`#profiler-hud`, below) — visibility toggled once at startup.
- **The Settings tab's `#controls-dev` section**, the only place `N`/`P` is listed in the UI —
  revealed once in the `Menu` constructor, so a shipped build never advertises a key it ignores.
- **`N`/`P` (jump to next/prev map)** in `handleHotkeys` — behind the early-return on `!DEVMODE`, so
  they are simply inert outside dev mode. `+`/`-` (camera distance) and `[`/`]` (camera tilt)
  deliberately sit *ahead* of that gate: they are player-facing framing controls, not debug state,
  and gating them only meant a shipped player couldn't adjust how much of the level fits on screen.

`Game.debugLines` reports `ThingLayer.awakeMonsterCount()` — the number of living monsters
currently alerted (chasing/attacking, or mid-`reactionTicks` delay) — useful for judging whether a
level's population has actually noticed the player.

## Profiling overlay

A third DEVMODE-gated panel, top-right, breaks a frame's cost down by category — `Specials`, `Player`,
`Weapons`, `Fog of War`, `Monsters`, `Effects`, `Fading`, `Render`, plus an `Other` bucket for whatever
wasn't explicitly measured (input handling, HUD text, the player sprite's own pose) — so a slow frame
can be traced to *which* system is responsible rather than just how many fps it costs.

`FrameProfiler` (`util/profiler.ts`) is a plain per-frame timer, not tied to rendering or game state:
`beginFrame()`, any number of `time(label, fn)`/`add(label, ms)` calls (the same label can be used more
than once per frame — `game.ts`'s "Player" bucket covers both the movement block and the later
pickup/damage-floor block, non-contiguous in `frame()` — and accumulates), then `endFrame()`.

Every label is smoothed with a plain exponential moving average rather than shown raw, the same
reasoning as `util/damping.ts`'s `dampen`: a single frame's timing is noisy (GC pauses, OS scheduling),
and an unsmoothed bar graph would flicker faster than it could be read.

**Measurement itself is not gated behind `DEVMODE`** — `performance.now()` calls are cheap enough not to
bother branching around, the same call the fps counter already makes. Only the DOM panel's visibility
(toggled once in `DebugHud`'s constructor, since `DEVMODE` never changes at runtime) and whether
`DebugHud.update` bothers pushing samples to it are. `Game.debugLines` is passed as a closure for the
same reason: its body walks the BSP for the player's sector, and must not run when the panel is off.

`ProfilerHud` renders each category as a horizontal bar sized against one 60fps frame's budget (16.6ms)
rather than against each other — a bar reaching full width means that category *alone* would miss the
budget, a more directly actionable signal than relative proportions, and it turns amber/red past
25%/100% of that budget so the worst offender is visible without reading the numbers. Rows are created
once per label (first-seen order) and reused after that, the same "build the DOM once, update fields
every frame" approach `Hud` uses for its icons — and re-sorted worst-first on every `update()` via
`appendChild` on the already-existing row (which reorders rather than duplicating), so the biggest cost
lands at the top without tearing anything down.
