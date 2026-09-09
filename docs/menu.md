# Menu and settings

`src/ui/menu/menu.ts`, `src/ui/menu/labels.ts`, `src/ui/menu/about.ts`, `src/ui/menu/welcome.ts`,
`src/ui/menu/overlay.ts`, `src/ui/menu/hold.ts`, plus the `.html` and `.css` beside each

The menu as launcher and pause screen, its overlays, and every persisted setting. Three docs carry
the rest: the WAD Library and what a WAD set is composed of are docs/menu-wads.md, the Save, Load
and Replays tabs docs/menu-saves.md, and what `main.ts` does around the whole thing — boot, level
starts, the loading screen — docs/session.md. The two overlays the Settings tab switches on are
docs/devmode.md.

The menu is plain DOM: every element is static markup in `src/ui/menu/menu.html` (pulled into the
page by `index.html`'s `@include` list — docs/styles.md § Assembling the page), looked up by ID in
`Menu`'s field initializers, so **an ID renamed in the HTML fails at construction**, not lazily.
Only the WAD lists, the level list and the difficulty options are built in JS.

## One screen, two jobs

`Menu` is both the launcher and the pause screen. `open(session)` is what distinguishes them, over
a `MenuSession` of `'none'`, `'game'` or `'replay'` — `main.ts` reads it off the `Game`
(`watchingReplay`) at every open:

- Anything but `'none'` puts the `ingame` class on `#menu`, swapping the opaque radial gradient for a
  translucent
  dim so the frozen level shows through (`Game` keeps drawing it — docs/frameloop.md § Pausing), and
  reveals **Return to game**. Both are off before any level is loaded: there is nothing behind the
  menu then but the static HUD markup with placeholder values, which the opaque gradient exists to
  hide. `'replay'` adds the `watching` class, which nothing styles. The classes *are* that state:
  `Menu.session` reads them back rather than mirroring it in a field.
- **`Start new game` is a press-and-hold while a run of the player's own is going**
  (`hold.ts: confirmOnHold`'s
  `required`, docs/menu-saves.md § Save and Load tabs): it throws that level away, and it sits in
  the same footer as `Return to game`. Asked per press, not wired once — from the launcher the
  button is an ordinary one and a click starts.
- **A replay behind the menu is held to nothing.** Over `'replay'` the three buttons that replace
  the session — Start new game, Load, a replay's Play — are ordinary buttons: a watched replay is
  still in the store and can be watched again, so there is nothing to confirm losing. The Save tab,
  Return to game and Record from here go by the level being loaded, so they behave as in a game.
- **`Start new game` is shown only while the New Game tab is up** (`setTab`): it acts on what that
  tab holds. The footer carries a `min-height` of that button's own box, so the row it leaves keeps
  its height and the panel's bottom edge doesn't move on a tab switch — `visibility` on the button
  instead would hold the height but keep reserving its width, stranding the status line mid-row
  (docs/styles.md § Hiding an element). The tab itself is accent-coloured in every state: the
  launcher's one action tab, and the only way to the button.
- **The status line is the footer's only elastic item.** Both buttons are `flex: none` and
  `#menu-status` takes the space left over; letting them shrink instead wraps their labels over
  three lines and grows the footer inside the panel. What the two clamped lines then cut is in the
  line's own `title` (`setStatus`). **Switching tabs clears it** (`setTab`): a message explains the
  tab it was raised on.
- The active tab is *not* reset on open — it's whichever the player last clicked (`newgame` on the
  first open, set in the constructor). Reopening mid-level to change one setting must not throw away
  the tab they were on.
`#menu` sits at `--z-menu` on the stacking ladder, above every in-game overlay and below the
fatal-error screen — the whole ladder is one block in `base.css` (docs/styles.md § The stacking
ladder).

`VERSION` (`constants.ts`) is shown prefixed with `v`, right-aligned on the title's own row
(`#menu header` is a `space-between` flex row), with the **ABOUT** and **CHANGELOG** links stacked
under it in the same `.build` column; a static credit sits bottom-left, outside the panel.

### Panel sizing

**Every tab pays the tallest tab's height**, and each of the three docs here has a panel that lives
under that rule rather than restating it.

- All tab panels are stacked in **one CSS grid cell** and hidden with `.inactive` (`visibility`),
  not the global `.hidden` (`display: none`), so the panel's height is always the tallest of them
  and switching tabs doesn't resize the menu under the cursor. That is also why the Settings tab's
  rows are kept compact, and why Level and Difficulty share a row on New Game: whatever height any
  tab costs, the others pay too.
- **A scroller inside a panel grows into height the tabs have already paid for, and never creates
  it** — it must offer a definite height while the menu measures itself, a `max-height` for the WAD
  `.list` and `height: 150px` for `.saves` (savegames.css). Otherwise the shared cell stops being a
  shared cost and becomes one tab's: the panel grows to the viewport cap and every *other* tab is a
  full-height box with its content at the top. `.saves` needs `flex: 1 0 auto` for that, **not** the
  usual `flex: 1` — measured: a `0` basis makes the ask fall back to the content and the `height`
  does nothing, which is how a long save list used to pin the menu to the viewport.
- **Each tab panel is its own scroller**: `#menu > .panel` is capped at the viewport, `.tab-panels`
  takes the height left over between header and footer (`flex: 1; min-height: 0`), and each
  `.tab-panel` carries the `overflow-y: auto`, so header, tab bar and footer stay pinned and a
  window too short for a tab scrolls that tab's body. Where the `overflow-y` sits is load-bearing
  twice over. Without it anywhere, the leftover-height sizing only shrinks the *box* and a panel
  taller than the space left spills out of it and is painted over by the footer. On the
  `.tab-panels` cell instead, a short visible tab would scroll into the hidden tabs' empty height,
  since that cell is sized by the tallest of them. Scrolling the whole panel inside `#menu` is not
  the fix either — an uncapped panel makes `.list-section` grow without bound rather than scroll.

### Hotkeys

`ESC` toggles between the menu and the game. With the menu open and no level loaded it does nothing
— there is nothing to return to.

`F2`, `F3` and `F4` open the menu directly on **Save**, **Load** and **Settings** (`Menu.showTab`,
wired in `main.ts` beside the `ESC` handler); with the menu already open they only switch tabs.
Two rules keep them from acting behind the player's back: any overlay up (`Menu.overlays`)
takes precedence exactly as it does for `ESC`, and `F2` with no level loaded does nothing rather
than opening the menu on the Save tab `open` hides. `preventDefault` is called only when the key
actually did something, so a refused press still reaches the browser's own binding.

## The overlays over the menu

`ui/menu/overlay.ts`. `AboutUi`, `LibraryUi` and `WadInfoUi` each hold an `OverlayShell` over their
own root: show, hide, `isOpen`, the close button, and the backdrop click guarded on
`e.target === root` so only the backdrop dismisses. Named for the behavior rather than an element,
the way `hold.ts` is (docs/styles.md § One owner per element).

- **`close()` reports whether it *was* up**, which is what makes one `ESC` dismiss one thing:
  `main.ts` asks `Menu.closeTopOverlay()` before acting on the menu itself. An explicit hand-off,
  never two window listeners racing over one key — that would depend on registration order.
- **`Menu.overlays` is the order**, topmost first — `close`, `closeTopOverlay` and `hasOverlay` all
  walk that one list, so another overlay is one edit. The reader leads because it opens from a row
  *inside* the WAD Library; its `z-index` rung states the same relation in CSS
  (docs/styles.md § Tokens) and nothing but this ties the two.
- **The shell takes elements, not IDs**, so each popup still looks its own markup up in its field
  initializers and a renamed ID fails at construction (§ One screen, two jobs).
- **What a dismissal *means* stays the popup's own**: each passes its own `close` in, so the reader
  drops its pending read and the WAD Library throws its draft away whichever route was taken.

## About

The header's two links open `#about` (`about.ts`, `AboutUi`), a popup with a tab each: **ABOUT**
opens what this is and what it's built on, **CHANGELOG** a scrolling reader over the repo's
`CHANGELOG` file. The link decides the tab — `open(tab)` takes it, nothing is remembered between
opens.

Load-bearing:

- The changelog text is a **dynamic** `import('../../../CHANGELOG?raw')`, run the first time that
  tab is shown (`loadChangelog`). Dynamic, because the file only grows and nobody who never opens
  the tab should pay for it: the bundler gives it its own chunk (~12 kB, 5 kB gzipped) instead of
  the main one. `import` rather than `fetch`, because the file lives at the repo root rather than
  under `public/`, so a fetch would resolve in dev and 404 in a build. A failed load is reported in
  the panel and leaves the popup unmarked as loaded, so reopening retries.
- **`ESC` is handed off explicitly**, not raced — § The overlays over the menu.
- The tabs are `#menu`'s own `.tabs`/`.tab-panels` markup, so the popup inherits the tab bar and
  the one-grid-cell panel stacking (§ One screen, two jobs) rather than restating either. Each
  panel is its own scroller, which is what keeps the CHANGELOG inside the panel instead of
  stretching it.
- **The panel's height is fixed** (`height: min(90%, 620px)`), not capped. The tabs share one grid
  cell sized to the tallest of them, so a panel free to shrink sits at the About tab's own height
  until the CHANGELOG is first measured and then jumps to the cap.
- **The contact address is not in the markup**: `about.ts` holds it ROT13'd and writes the link's
  text and `mailto:` at construction, so neither the partial nor a text scrape of the bundle yields
  anything mailable. It stops harvesters that don't run the page — which is most of them, and all
  this can do from a static page.

`#about` is a child of `#menu` so it disappears with it; `Menu.close()` also closes it, or it would
still be up the next time the menu opens.

## Welcome popup

`#welcome` (`welcome.ts`, `WelcomeUi`) is a new player's first screen: one sentence on what the
game is, the five basic keys (a `#menu .keys` list, the Settings tab's own), and where a WAD of
their own goes. `boot()` opens it through `Menu.showWelcome()` right after `menu.open()`, at every
boot, until the player ticks **Don't bug me again**.

- **The checkbox is the `showWelcome` setting**, written on every change like the Settings tab's
  checkboxes (§ Persisted settings): ticking it stores `false`, unticking it before closing stores
  `true` again. Stored as the *showing* flag so a browser with no storage reads the default and
  keeps showing the popup — the one case where being reminded beats being forgotten.
- **The checkbox starts unticked at every open**: the popup being up at all means it hasn't been
  muted, so a stale tick could only mislead.
- **Over the launcher only.** `showWelcome` is its own call rather than part of `open`, because
  `open` is also the pause screen (§ One screen, two jobs), and a `?map=` deep link never opens
  the menu, so it never sees the popup either (§ URL parameters).
- Structurally `#about`'s sibling: a child of `#menu`, `z-index: 5` local to `#menu`'s stacking
  context, in `Menu.overlays` so `ESC`, the backdrop and `Let's go` all dismiss it the same way
  (§ The overlays over the menu). Its panel is capped rather than fixed in height — it has no tabs
  to hold still under.

## Difficulty

**Difficulty lives on the New Game tab, not the Settings tab** — it belongs with the WAD and level,
the other two things a start is composed of, and unlike volume and autorun it can't apply live: a
running `Game` holds the skill it was constructed with, and most of what the skill decides — which
things spawn at all, and which stat table the monsters run on (docs/monster-ai.md § Fast monsters)
— is resolved once per level in `game/things.ts: buildThingSprites`, so changing it mid-level would
silently do nothing until the next load. It shares a row with Level (`.columns even`, § Settings
tab below).

`#skill-select` is filled once from `SKILL_NAMES` and seeded from the `skill` setting; a change
writes that field back, so the next visit opens on the last skill played. **What a start actually
runs at is `currentSkill()`, read off the select, not off storage** — where `localStorage` is
unavailable
the write goes nowhere and reading it back would silently ignore the player's pick. `submit()` (the
`?map=` deep-link path) reads the same getter, which is the stored skill there since nothing has
touched the control.

## Settings tab

The tab is split in four by its own row of **sub-tabs** (`.tabs.subtabs` inside `#tab-settings`,
`Menu.setSettingsTab`), in the order **General** — what is left over, the settings that are none of
the other three — **Visuals**, everything that changes how the running level looks, **Controls**,
the key list and everything bound to it, and **Audio**, everything you hear. Controls sits third
because it is the one a player opens to read rather than to change, so the two tabs they open to
*change* something sit together at the front. The sub-panels are the same
`.tab-panels`/`.tab-panel` grid-cell stack the top-level tabs use, nested one level — so Audio being
much shorter than Controls costs the menu no resize when the player switches, exactly as above. The
sub-tab row is styled a step quieter (smaller type, no rule under it) so it doesn't read as a second
tab bar of equal rank, and like the tabs above it the pick survives an `open`.

**Controls is mostly the full key list, and it is the only one the game itself shows** — it replaced
two hint lines in the DEVMODE status text, which meant a shipped build listed its controls nowhere.
Being a menu tab makes it reachable mid-level too, since the menu is the pause screen. README's
table is the fuller reference.

**The control-shaped settings live inside that list rather than in sections of their own**, because
what they change *is* a key's behavior: the right button's binding is the `right mouse` row's
description, the autorun checkbox is the `Shift` row's. A player looking up what a control does and
a player changing it are the same person on the same trip to the menu — which is why those two did
not move to General with the rest.

**General is what is left once the other three have taken theirs**: Level start over Collision,
stacked full width, with `Debug / Dev` following them. Level start leads because it is the one of
the two a player picks *before* a run rather than sets once and forgets.

**Visuals is Camera, Frame rate, Lighting, Top-down extras, Player sprites** — everything that
changes what the running level *looks* like, in that order: the camera first, being the one a player
actually goes looking for. *Top-down extras* holds the three this camera needs and vanilla never
did: the void fog, the tops on crates and pillars, and the hidden thin ceiling steps
(docs/render-solids.md, docs/render.md § The void floor and § Ceiling trims). The last two are the
settings on the tab that are **not** live — caps and trims are baked into the level's mesh — and
their rows say so.

**Camera** is `#cameramode-select`, whose `<option>` values are the `CameraMode` strings themselves
(`auto`, the default, vs `manual`); it is owned by `game/autocamera.ts`
(`getCameraMode`/`setCameraMode`) and read per tic, so a change applies to the level already running
(docs/camera.md § Auto camera). It sits here rather than in the Controls key list because the mode
is not a key's behavior — the `+ - [ ]` rows there note they act in manual mode only.

The frame limit is `#fpscap-select`, and its `<option>` values *are* the capped rates
(`0` = unlimited; `60` is the default), so the control needs no mapping table. It is owned by `game.ts`
(`getFpsCap`/`setFpsCap`), whose frame loop is the only thing it changes, and is read live per frame
— changing it mid-level applies to the level already running, like volume and autorun. See
docs/frameloop.md § The FPS cap for how a cap is actually held. Lighting is the one
`#dynlights-checkbox`, on by default and likewise read per frame, so it too takes effect without a
reload (docs/lights.md § The toggle). Distance lighting has no row here on purpose —
docs/render-lighting.md § It has no setting.

**Player sprites** is `#playersprites-select`, whose `<option>` values are the `PlayerSpriteMode`
strings themselves (`auto` — the default — `always`, `never`); it is owned by `wad/playerskin.ts`
and read per drawn frame, so it too applies to the running level. What each mode decides is
docs/sprites.md § When the skins apply.

**Audio is one Volume section of three sliders** — `General` (`#master-volume-slider`, the master),
`Effects` (`#volume-slider`) and `Music` (`#music-volume-slider`) — each with a `.label` wide enough
that the three line up. Master **first**: it is the one that moves the other two, so reading down
the section is reading the signal path. It rides the `master` gain node the two channel buses hang
off, and 0 on it stops both of them the way each channel's own 0 stops itself
(docs/audio.md § Volume and the context). The master and sfx sliders preview themselves with
`itemup` as they are dragged; the music slider needs no preview, riding the track already playing
behind the menu (docs/music.md § Volume).

**Collision** is one checkbox, `Infinite tall actors (vanilla)` — off by default (docs/movement.md §
Collision); `Level start`'s `Pistol start every level` and `Weapons`' `Switch weapons automatically`
(on by default, docs/weapons.md § Automatic weapon switching) are the other two. What is left on
General is exactly the three settings that change how the game *plays*, which is why none of them
belongs on the three tabs beside it. Each applies to the level already running, like volume and the
cap: `blockedByThings` reads its flag per call, and so do the other two.

`Weapons` sits between them rather than in Controls because auto-switching fires on a pickup and on
a weapon running dry — no key is involved, so it is not a key's behavior in the sense the paragraph
above uses.

General ends with **`Debug / Dev`, the section holding the `Show FPS counter`, `Show debug infos`
and `Show profiler overlay` checkboxes** (docs/devmode.md § FPS counter, docs/devmode.md
§ Profiling overlay). It is shown in every build — all three are player-facing settings, only their
*defaults* follow `DEVMODE` (docs/devmode.md § Dev mode). They read `Show …` alike: three
neighbouring rows all switching a readout on, where one worded differently would read as a
different kind of setting. The first two are independent — the counter off does not take the debug
block with it (docs/devmode.md § FPS counter).

**The `Shift` row's description is the word autorun currently makes true** — `walk` when it's on,
`run` when it's off — so `installAutorun` writes `#shift-action` from the same `show` helper that
sets the checkbox, the shape `installVolume` already uses. A fixed description here would state one
case and leave the other to be inferred from a checkbox two words away.

Two CSS notes for that: `#menu .keys select` undoes the full-width, roomy `#menu select` so the
binding stays on one line, and `dd.inline` is the flex row that lets a description carry a control
beside it.

Camera and Game share `.columns`, which is **flex, not fixed grid tracks** — a section can leave
the row with no empty cell to suppress. Columns are content-width so they pack left rather than
being stretched apart, which is why those descriptions are kept to a word or two. Move and fight
stays full width.

`.columns` is shared with the New Game tab, where its `even` modifier gives a section `flex: 1` plus
`min-width: 0`, since a `width: 100%` select needs a share it can shrink inside rather than a
content-sized one a long map name would push past the panel. **Only Level takes that share.**
Difficulty (`.skill-column`, 26ch) and the record toggle (`.record-column`, 17ch) are fixed to their
own longest string — "I'm Too Young to Die" plus the select's arrow, and "Not recording" plus the
button's padding — because both are closed lists, where the level names beside them are whatever the
WAD set calls its maps and are the ones worth the room. Both numbers are **measured**, not guessed:
a select silently truncates its own text and a button wraps onto a second line, taking the row's
height with it, so neither shows up as an overflow. The button is `white-space: nowrap` for the same
reason.

The rest is static markup with no `Menu` state — no field lookups, no listeners. A section that
has to disappear takes the global `.hidden` (`display: none`), not the tab panels' `.inactive` — a
panel has to keep reserving height, but a hidden section must drop out of the `.columns` flex line
entirely (docs/styles.md § Hiding an element).

## Right mouse button

The right button has **no fixed job**: the camera turns with `Q`/`E` rather than by dragging
(docs/camera.md § Camera orbit), which left the button free. `#rightmouse-select` binds it to one of
`RightMouseAction`'s three values — `previousweapon` (the default), `use` (same as `Space`), or
`none` — and the `<option>` values *are* those strings, so the control needs no mapping table.

The setting lives in `game/input.ts` beside the button state it describes, and **only
`Input.rightMousePressed(action)` reads it**: consumers ask for the action they implement
(`SpecialsController.handleUseTrigger`, `WeaponSystem.handleSwitching`) rather than importing the
preference, so adding a fourth action can't leave a stale check behind in one of them.

Even at `none` the canvas still suppresses `contextmenu` — a browser menu opening mid-fight is a
surprise whatever the button is bound to.

## Persisted settings

Every persisted value is a field of **one JSON object**, stored under the single `localStorage` key
`topdoom.settings` and reached only through `util/storage.ts`: `readStorage(field, default)`,
`readStorageObject(field)` and `writeStorage(field, value)`. Nothing else in `src/` reaches for
`globalThis.localStorage`: `game/besttimes.ts`'s one pre-IndexedDB key goes through the same
module's exported `webStorage()`, so the guard below covers it too.

Four rules that module owns, so no call site repeats them:

- **A read is validated against the caller's default** and falls back to it where the field is
  unset or holds another type — `Number(null) === 0` otherwise makes "never set"
  indistinguishable from "silent"/"skill 0". Type only: a range (`storedVolume`'s 0-1) or a set of
  names (`readStoredFpsCap`) is the caller's own check, after the read.
- **A write merges into a re-read of the object**, so a second tab open on the game overwrites the
  field it changed rather than every setting the first one wrote.
- **A setting a *continuous* control drives writes through `writeStorageSoon`**, which holds the
  field for 250 ms and stores everything pending in one write. The three volume sliders set on every
  `input` event — dozens across one drag, each otherwise re-encoding the whole object. A read in
  between still sees the pending value, and `pagehide` or a tab going hidden flushes early, so the
  delay cannot lose a setting.
- **A browser with no storage degrades to defaults**, including one where the property access
  itself throws (site data blocked) — which is why the guard there is a `try` and not a `?.`.

Each value is owned by the module whose behavior it changes, and the menu only wires the control to
that getter/setter; the exceptions are skill and the WAD selection, which belong to the menu itself.
Each is a module-level value behind an exported `get`/`set` pair — not an instance field and not a
`static`, even where the owning module has a class (`Player`, `World`, `AutoCamera` all do).
**`util/storage.ts` holds no registry of fields**: the key constant lives with its owner, so adding
a setting touches one module.

| Field | Owner | Documented in |
|---|---|---|
| `masterVolume` | `audio/audio.ts` | docs/audio.md § Volume and the context |
| `sfxVolume` | `audio/audio.ts` | docs/audio.md § Volume and the context |
| `musicVolume` | `audio/music.ts` | docs/music.md § Volume |
| `autorun` | `game/player.ts` (`getAutorun`/`setAutorun`) | docs/movement.md § Movement speed and straferunning |
| `rightMouse` | `game/input.ts` (`getRightMouseAction`/`setRightMouseAction`) | § Right mouse button above |
| `cameraMode` | `game/autocamera.ts` (`getCameraMode`/`setCameraMode`) | docs/camera.md § Auto camera |
| `fpsCap` | `game.ts` (`getFpsCap`/`setFpsCap`) | docs/frameloop.md § The FPS cap |
| `fps` | `ui/devmode/debughud.ts` (`getFpsVisible`/`setFpsVisible`) | docs/devmode.md § FPS counter |
| `profiler` | `ui/hud/profiler.ts` (`getProfilerVisible`/`setProfilerVisible`) | docs/devmode.md § Profiling overlay |
| `dynamicLights` | `render/lights.ts` (`getDynamicLights`/`setDynamicLights`) | docs/lights.md § The toggle |
| `voidFog` | `render/voidfloor.ts` (`getVoidFog`/`setVoidFog`) | docs/render.md § The toggle |
| `solidCaps` | `render/solids.ts` (`getSolidCaps`/`setSolidCaps`) | docs/render-solids.md |
| `ceilingTrims` | `render/mapmesh/walls.ts` (`getCeilingTrims`/`setCeilingTrims`) | docs/render.md § Ceiling trims |
| `wallShade` | `render/wallshadow.ts` (`getWallShade`/`setWallShade`) | docs/render-lighting.md § Turning it off |
| `skyTint` | `render/skytint.ts` (`getSkyTint`/`setSkyTint`) | docs/render-lighting.md § Turning the tint off |
| `bloom` | `render/bloom.ts` (`getBloom`/`setBloom`) | docs/lights.md § Turning it on |
| `playerSprites` | `wad/playerskin.ts` (`getPlayerSpriteMode`/`setPlayerSpriteMode`) | docs/sprites.md § When the skins apply |
| `infiniteTallActors` | `game/world.ts` (`getInfiniteTallActors`/`setInfiniteTallActors`) | docs/movement.md § Collision |
| `pistolStart` | `game/inventory.ts` (`getPistolStart`/`setPistolStart`) | docs/items.md § Pistol start |
| `autoSwitchWeapon` | `game/inventory.ts` (`getAutoSwitchWeapon`/`setAutoSwitchWeapon`) | docs/weapons.md § Automatic weapon switching |
| `playerName` | `game/replay.ts` (written by `describeReplay`, no setter) | docs/replays.md § Recording |
| `skill` | `ui/menu/menu.ts` | § Difficulty above |
| `showWelcome` | `ui/menu/welcome.ts` | § Welcome popup above |
| `selection` | `ui/menu/menu.ts` | § Remembered selection below |

Three persisted things are **not** fields of that object, because none of them fits in one: each
has its own IndexedDB database, kept separate so an upgrade that fails for one can't take the
others down. `game/besttimes.ts` also still reads (and deletes) `topdoom.bestTimes`, the
pre-IndexedDB blob — docs/hud.md § Migration off localStorage.

| Database | Owner | Documented in |
|---|---|---|
| `topdoom` | `game/savestore.ts` | docs/savegames.md § Storage |
| `topdoom-wadlibrary` | `wad/library/store.ts` | docs/wad.md § The player's own library |
| `topdoom-besttimes` | `game/besttimes.ts` | docs/hud.md § The store |
| `topdoom-replays` | `game/replay.ts` | docs/replays.md § Storage |

A savegame is also the one departure from per-value structural validation: it carries an explicit
`version` field, refused on mismatch rather than half-read. A settings scalar degrades safely to its
default; a save's schema genuinely evolves, and half-reading an old one restores a subtly wrong
level (docs/savegames.md § The format and its version).

## Remembered selection

The `selection` field holds `{ iwad, pwads, map }` as `WadSource.key`s. Precedence when `init`
resolves it is **URL > stored > `FIRST_RUN_WADS` > first IWAD on offer** — the third step being the
preselection a player with nothing stored gets, `constants.ts` and docs/menu-wads.md § The first
start — and every key is resolved against the current
library, so a WAD that has since left `public/game/` is silently dropped (an unknown map falls back
to the set's first, via `selectLevel`'s no-op). Restoring can pair a stored add-on with a
`?wad=`-forced game WAD it doesn't suit; that pick is **kept**, refused rather than dropped, so the
stored set survives a deep link (docs/menu-wads.md § Picking a WAD set).

`saveSelection` is called from the sites where the *player* changes something (`selectIwad`, the
add-on toggle, `addFiles`, the level select's `change`) and **deliberately not from `render`**,
which `init` also runs while restoring: hooking it there wrote the level select back before
`selectLevel` had applied the stored map, so the stored level decayed to the set's first map after
one reload.

It **never writes an upload.** Those bytes are gone after a reload, so storing the key would restore
a selection that can never load; leaving the last restorable one in place is better. As a
side-effect, a failed manifest (no sources at all, `selectedIwad` null) can't wipe a good stored
value either. A **library** file is stored like a server one — its key is `lib:<relative/path.wad>`,
which is stable across visits precisely because the folder is remembered
(docs/wad.md § The player's own library), so a picked mapset survives a reload. Where the browser
can't remember the folder, `init` restores nothing from it and the stored keys simply don't resolve,
which is the same silent drop a WAD that has left `public/game/` gets.

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
