# Menu, settings, session lifecycle and dev mode

`src/ui/menu/menu.ts`, `src/ui/menu/labels.ts`, `src/ui/menu/about.ts`, `src/ui/menu/welcome.ts`,
`src/ui/menu/library.ts`,
`src/ui/menu/menu.html` + `src/ui/menu/about.html` + `src/ui/menu/welcome.html`,
`src/ui/menu/menu.css` + `src/ui/menu/about.css` + `src/ui/menu/welcome.css` +
`src/ui/menu/library.css`,
`src/main.ts`, `src/constants.ts: DEVMODE`, `src/ui/devmode/`, `src/util/profiler.ts`

The menu is plain DOM: every element is static markup in `src/ui/menu/menu.html` (pulled into the
page by `index.html`'s `@include` list — docs/styles.md § Assembling the page), looked up by ID in
`Menu`'s field initializers, so **an ID renamed in the HTML fails at construction**, not lazily.
Only the WAD lists, the level list and the difficulty options are built in JS.

## One screen, two jobs

`Menu` is both the launcher and the pause screen. `open(inGame)` is what distinguishes them:

- `inGame` puts the `ingame` class on `#menu`, swapping the opaque radial gradient for a translucent
  dim so the frozen level shows through (`Game` keeps drawing it — docs/frameloop.md § Pausing), and
  reveals **Return to game**. Both are off before any level is loaded: there is nothing behind the
  menu then but the static HUD markup with placeholder values, which the opaque gradient exists to
  hide. The class *is* that state: `Menu.inGame` reads it back rather than mirroring it in a field.
- **`Start new game` is a press-and-hold while a level is running** (`hold.ts: confirmOnHold`'s
  `required`, § Save and Load tabs): it throws that level away, and it sits in the same footer as
  `Return to game`. Asked per press, not wired once — from the launcher the button is an ordinary
  one and a click starts.
- **The status line is the footer's only elastic item.** Both buttons are `flex: none` and
  `#menu-status` takes the space left over; letting them shrink instead wraps their labels over
  three lines and grows the footer inside the panel. What the two clamped lines then cut is in the
  line's own `title` (`setStatus`). **Switching tabs clears it** (`setTab`): a message explains the
  tab it was raised on.
- The active tab is *not* reset on open — it's whichever the player last clicked (`newgame` on the
  first open, set in the constructor). Reopening mid-level to change one setting must not throw away
  the tab they were on.
- All tab panels are stacked in **one CSS grid cell** and hidden with `.inactive` (`visibility`),
  not the global `.hidden` (`display: none`), so the panel's height is always the tallest of them
  and switching tabs doesn't resize the menu under the cursor. That is also why the Settings tab's
  rows are kept compact, and why Level and Difficulty share a row on New Game: whatever height any
  tab costs, the others pay too — the save lists cap themselves with the `.list` scroller for the
  same reason.
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

`#menu` sits at `--z-menu` on the stacking ladder, above every in-game overlay and below the
fatal-error screen — the whole ladder is one block in `base.css` (docs/styles.md § The stacking
ladder).

`VERSION` (`constants.ts`) is shown prefixed with `v`, right-aligned on the title's own row
(`#menu header` is a `space-between` flex row), with the **ABOUT** and **CHANGELOG** links stacked
under it in the same `.build` column; a static credit sits bottom-left, outside the panel.

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

## WAD Library

The `WAD Library…` button under the add-on list opens `#wadlibrary`, a two-pane file manager over
**everything the menu can offer**: the WADs the server ships, a folder on the player's own disk, and
anything dropped on the menu. It replaced two buttons — `Load IWAD from disk…` and
`Add PWAD from disk…` — which between them could only ever add one file at a time and forgot it on
reload.

Structurally it is `#about`'s twin, and deliberately so (§ About): a child of `#menu` so
closing the menu can never leave it up, at `z-index: 5` **local to `#menu`'s own stacking context**
rather than a rung of `base.css`'s global ladder, and dismissed the three ways every overlay is
(§ The overlays over the menu). `Close` sits beside `Apply` in the footer rather than in the header:
both end the same visit, so they belong to the same corner — but they are **not** the same call
(see *Ticking stages, Apply commits* below).

What is its own:

- **Ticking stages, `Apply` commits, `Close` discards.** Every control in the file pane edits
  `LibraryUi`'s own `draftIwad`/`draftPwads` and nothing else; `Apply` hands the pair to
  `Menu.applyPicks` and closes, and every other way out — the `Close` button, the backdrop, `ESC`,
  the menu closing under it — throws the draft away. Browsing is what this overlay is *for*, so
  trying a game WAD on to see which add-ons it then allows, or ticking half a set and thinking
  better of it, has to cost nothing. `open` re-snapshots the draft from the menu, which is the whole
  of the rule that the overlay starts from what is actually selected — `close` deliberately leaves
  the abandoned draft lying, rather than stating that invariant a second time from the other end.
  `Apply` closes *before* it commits: applying redraws the menu, which redraws this overlay, and a
  set whose files still need hashing would otherwise leave the panel up and frozen for a disk read.
- **The whole set is applied in one call**, not a row at a time — a game WAD and the add-ons picked
  beside it are one decision, and applying the draft row by row would put them in an order the
  player never chose. `applyPicks` identifies every file in the set — together, since each may
  read and hash a whole file and no two touch each other — keeps the `disabledPwads` off-flags of
  the add-ons that were in the set before *and* still are (anything picked again after being dropped
  starts on, the rule `takeAsPwad` keeps for a single tick), then replaces the selection outright.
- **What a game WAD costs the add-ons is one function**, `library/defs.ts: pwadsFor` — `fitsGameWad`
  (§ Picking a WAD set) plus dropping the file that *is* the game WAD. **Nothing prunes with it**:
  `Menu.activePwads` filters through it to decide what a start actually merges, and the two lists
  grey out the rows it drops, so a pick a game WAD can't take is refused rather than removed
  (§ Picking a WAD set). One function behind the merge and the greying, or the overlay shows a set
  that Apply then quietly produces differently.
- **The footer says when the draft has drifted** — `#wadlibrary-summary` appends `— not applied yet`
  whenever the draft differs from the menu's picks. Without it a staged overlay is a trap: the
  summary would read exactly like the menu's own selection and `Close` would look harmless. It also
  counts the picks the draft's game WAD **can't** take (`3 add-ons (1 not merged)`), since a draft
  keeps those rather than dropping them and a bare count would promise a merge that won't happen.
- **A file added while the overlay is up is staged too.** `Menu.addFiles` always adds to `sources`,
  but *where the pick lands* depends on what is on top: with the overlay down it adopts as before,
  with it up it hands the new sources to `LibraryUi.stage`, which ticks them into the draft. That is
  the same routing `setStatus` does and for the same reason — the overlay covers `#menu`, so a
  selection made behind it is one the player never saw happen and `Close` would not undo. It covers
  the drop target as well as `Add single WADs…`, since `#wadlibrary` nests inside the `#menu`
  element the drop listener sits on; a file dropped *on* the open overlay is a pick in it, not a
  silent one behind it.
- **Sources moving under the overlay re-bind the draft by key** — `carryDraft`, called from
  `LibraryUi.refresh` and nowhere else, which is every path by which they can move. A rescan (or a
  re-upload of a file already known) builds fresh `WadSource` objects for the same files and the
  draft holds them by identity, so without it a `Rescan` would silently untick everything it had
  just re-read; a file the folder no longer has drops out of the draft, since there is nothing left
  to apply. Rescan and Forget themselves are *not* staged — they act on the library on disk rather
  than on a pick, and carry their own confirmation where it matters.
- **A folder row lists its own WADs and counts everything beneath it** — `FolderNode.sources` and
  `FolderNode.total`, deliberately two fields answering two questions. `sources` is what the file
  pane shows, so a folder behaves like a folder; `total` is the row's count *and* what decides
  whether the row is drawn, which is what keeps a pure container folder (one holding nothing but
  subfolders) on screen instead of orphaning the rows nested under it. A served folder holding only
  subfolders, and the library root, are exactly that. That is also why `selectedFolder` cannot
  *start* on a container row — it would open on an empty pane. `buildFolderTree` is pure and
  separate from `LibraryUi` so all of this is testable without a DOM.
- **A folder holding a picked WAD is highlighted**, and so is every folder above it, so a folded
  parent still says something inside it is in the set. The mark walks up `parent` from each row
  whose own `sources` contain a pick — never by ID prefix, for the `library:mega` /
  `library:megawads` reason below — and lands on `.name` rather than the row, so it survives
  `.active`'s own colour.
- **The sidebar is three boxes, not one scroller**, and the panel's height is *definite*
  (`height: min(620px, 100%)`) rather than content-driven — so the overlay is the same size whether
  a library holds three WADs or three hundred. What the server ships is a fixed few rows and the
  folder buttons must stay put, so only the middle box (`#wadlibrary-tree`, the player's own folders
  — the one thing that can grow without bound) takes `overflow-y` and the leftover height.
  `Dropped on the menu` rides with the server's rows: like them it is a place the player never
  chose, and never one to scroll past their own folders to reach. **Only the two lists are framed**
  — `#wadlibrary-controls` gets no inset panel, because those buttons act *on* the library rather
  than being part of it and a third framed box made the sidebar read as three lists.
- **`Change folder…` and `Forget folder` share a row**, being two halves of one decision about the
  same folder; `Add single WADs…` sits full-width under them. Both CSS rules name `.ghost`
  explicitly: `#menu button.ghost` forces `width: 100%` for a button stacked under a section, and
  only an equal-or-higher specificity undoes it — a bare `#wadlibrary-controls button` loses that
  cascade and the pair stacks.
- **Only the *warning* about persistence is written out.** Firefox and Safari get "this browser
  can't remember a folder — you'll need to pick it again after a reload"; Chromium gets no note at
  all, because remembering the folder is what the player already expects, and saying so is one more
  line to read on every visit.
- **Folders collapse**, and the affordance is the folder glyph itself: `📂︎` open, `📁︎` closed, each
  with the text-presentation selector `U+FE0E` — the same request `savegames.ts` makes of its
  wastebasket, so it renders in the menu's own colour rather than as a colour emoji. One glyph
  carries both jobs a tree needs ("this is a folder", "it is open") where a separate disclosure
  triangle would have cost a second column in a sidebar this narrow. A leaf keeps the same glyph,
  dimmed and not clickable: it is still a folder, it just has nothing to open.
- The glyph is a `<span>` inside the row button, not a nested button — that would be invalid markup
  and would cost the row its single focusable control. Its click is stopped from bubbling, so the
  glyph only ever folds and the label only ever selects. Collapsing a folder the selection sits
  *under* moves the selection up to it, which costs nothing since a folder already lists everything
  beneath it. **Both the fold test and the walk up use `parent`, never an ID prefix**:
  `library:mega` is a string prefix of `library:megawads` without being its parent. Every such walk
  goes through `ancestors`, over a `TreeIndex` built **once per render** and threaded down. Each
  walk used to build its own `byId` — one per row, inside a per-row `filter` — which made a single
  render quadratic in the row count, on every keystroke in the filter box. `rootedSubtree` is one
  pass for the same reason: it files each source under its own path and counts it against every
  folder above it, rather than scanning `sources` once per folder.
- **The four top-level rows start open, everything below them folded.** `LibraryUi` tracks
  *expanded* IDs rather than collapsed ones precisely so the default is a property of that one set:
  a collapsed-ID set could not express it, since a folder the player has never touched is absent
  from it and would read as open. The set is seeded with `TOP_LEVEL_FOLDERS` — the two served roots,
  the library root and `Dropped on the menu` — since folding those too would open the overlay on a
  few bare headings with nothing to act on.
  `selectedFolder` starts on a **top-level** row for the same reason: any deeper default would be a
  row nobody can see. Which one: the served **add-ons**. A game WAD is already picked by the time
  anyone opens this — the New Game tab's select carries it — so add-ons are what the overlay is
  being opened to browse.
- **Folders sort A-Z within each level** — case-insensitively, with digit runs read as numbers so
  `Map2` precedes `Map10` — emitted depth-first so a parent still leads its children. Deliberately
  *not* one flat sort of the full paths: that would have to get both the alphabetical order and the
  parent-first grouping out of a single comparison, and whether `a/b` lands under `a` or after `aa`
  then depends on how the collation ranks `/` against letters.
- **Every ancestor folder gets a row, even one holding no WAD directly.** A file's `folder` names
  only the folder it sits in, so a WAD at `doom/mega/scythe/` names no intermediate at all — without
  synthesizing `doom` and `doom/mega`, the deepest row is indented under a parent that isn't there
  and has nothing to fold into. A plain sort still puts every parent first: a path is a prefix of
  its own descendants, and `/` sorts below the characters that could extend a sibling's name.
- **Both of the panel's axes are fixed**: `width: 60%` of the viewport and `height: 85%` of what is
  left inside `#wadlibrary`'s own padding, so the overlay is one size whatever the library holds.
  `width`/`height`, never `max-*` — those leave the panel sized by its content and only cap it. The
  sidebar takes a *share* of that (`flex: 0 0 30%`) rather than a pixel basis, so the two panes keep
  their proportion at any window size, plus `min-width: 0` — without it a long folder name's
  automatic minimum size overrides the basis outright, and `.name` should ellipse instead.
- **The tree is the left pane, the files the right**, split into two panels whose **headings name
  the panel and count what is in it** — `topdoom built-in` and `Your Library`. Those headings
  replaced the container rows that used to sit above each list: a row that owns no files of its own
  is a poor click target, and the panel it is in already said what it was. Each heading lives
  *outside* its own scroller, or it would scroll away from the rows it names.
- **Both panels are folder trees of the same shape**, built by one `rootedSubtree`. `Game WADs` and
  `Add-ons` are rooted at `iwad/` and `pwad/` and show whatever subfolders those hold, now that the
  manifest scans them recursively (docs/wad.md § The `public/game/` manifest); the player's library
  is rooted at the folder they nominated. Only a served file's **first** path segment decides which
  of the two it belongs to. Anything dropped on the menu gets a `Dropped on the menu` group, so
  nothing the menu knows about is invisible here.
- **A folder row's number is the WADs in *that* folder**, not everything beneath it. `total` still
  counts the subtree, but only to decide whether the row is drawn at all — see the next point.
- **A folder with no WAD beneath it is not a row at all** — an empty `Game WADs` is nothing the
  player can act on, and a tree of folders that all open onto nothing is worse than a short one.
  **The library root is the one exception, and only once a folder is set**: an empty root then
  reports something — that folder held no WADs — while with no folder behind it, it is a row that
  says "nothing here" next to a heading that says the same and a `Choose folder…` button that is the
  actual invitation. `buildFolderTree` takes `libraryPicked` for exactly this one decision.
- **A game WAD is a radio, an add-on a checkbox.** An IWAD-typed row is a choice of one and says so
  with the control rather than with a rule the player has to discover; a PWAD-typed row stacks.
- **Incompatible add-ons render disabled rather than hidden**, the same `mapStyle` rule and the same
  reasoning as `renderPwads` (§ Picking a WAD set), with the mismatched game named in the row's
  badge. **One already in the draft keeps a live checkbox** (`refused && index < 0`): unticking is
  the only way to drop a pick from this pane, and a game WAD that no longer suits one is exactly
  when the player might want to — what the row must not do is accept a *new* pick the set can't
  use.
- **Applying a library file gives it its content ID** (`Menu.identify` → `ensureWadId` +
  `rememberLibraryId`), which the scan deliberately skipped — docs/wad.md § Content ID. It is
  remembered on disk, so a file is hashed once ever rather than once per session. Deferred to
  `applyPicks` rather than paid on the tick, so trying a WAD on and thinking better of it hashes
  nothing.
- **The detail column says what a file *is*, never where it sits.** `describeSource` used to append
  a library file's subfolder; the row is already under that folder in the tree, so repeating it only
  crowded the column. An upload's `from disk` stays, since it belongs to no folder at all.
- **A file row is seven columns** — name, badge, size, contents, `DEH` (a DEHACKED patch, spelled
  out in the column's tooltip), info (the `.txt` beside the file, § The text file popup), support —
  with the name
  taking the slack and the rest fixed-width and right-aligned, so sizes line up under sizes and map
  counts under map counts rather than each trailing whatever length its file name happened to be.
  `labels.ts: sourceColumns` returns the three detail values separately and `sourceColumnSpans`
  renders them plus the support glyph, and **both lists use both** — the add-on rows on the New Game
  tab carry the same columns, just narrower, since that panel is 682px against the overlay's 60% of
  the viewport. The markup is shared too, not just the strings: the
  `meta size`/`meta content`/`meta deh`/`meta info`/`meta support` class names the two stylesheets
  target have one definition, and `#wadlibrary` nests inside `#menu` so its rows inherit
  `#menu .row` outright — `library.css` carries only the deltas. So the two cannot disagree about
  what a file *is*, only
  about how much space there is to say it. (`describeSource` joins the same values and is now only
  the game-WAD select's one-line label; the support verdict is deliberately not in it, being a glyph
  rather than text.) The badge **leads** the fixed-width block, ahead of the size: what it carries
  is the reason a row can't be picked, which has to be read before the file's stats rather than
  after them. It is rendered **even when it says nothing**, or every column behind it would land
  somewhere different on each row, which is the whole thing they exist for.
- **The last column says whether the file will run at all** — a green tick, an amber warning or a
  red cross, with the reasons in its tooltip, each naming at most three of the maps that raise it
  (sorted, then a count of the rest — a longer list stops being readable at a glance, and directory
  order reads as no order at all). The verdict itself is
  `wad/support.ts`'s and is decided when the file is *described* (docs/wad.md § Will it run?), not
  here: it rides in on `WadSource.support` for a server file, an upload and a library file alike, so
  the same WAD cannot read differently in the three places it can come from. The menu's job is the
  glyph and the colour — and drawing **nothing** where there is no verdict, since absent is unknown
  rather than fine. The glyphs take `U+FE0E` for the reason the folder tree's do; the colours are
  docs/styles.md § Tokens.
- **A file with nothing left to load is greyed out**, game WAD and add-on alike, and carries
  `won't load` in the badge column. The rule is `support.ts: nothingLoads`, deliberately **narrower
  than the red glyph**: a megawad with one nodeless map among thirty-one that work still shows the
  red cross, and is still perfectly pickable — refusing the whole file over one map would lock the
  player out of the rest of it. Only a file whose *every* map is refused is unpickable, and a
  map-less add-on never is, having nothing that could fail to load. A ZDoom-namespace UDMF file
  shows the red cross and stays pickable however many of its maps raise it: those maps load and are
  walkable, and the cross is about their doors and scripts not running (docs/wad.md § Will it run?).
  This lives in `LibraryUi`, **not** in `pwadsFor`: what a set costs is a rule about the game WAD
  and its add-ons, while "this file will not load" is a property of the file alone — folding it
  into the prune would silently drop files out of a stored selection and out of the set a savegame
  resolves against, rather than merely declining to offer them. `draftTake` carries the same guard,
  since a file *dropped* on the open overlay reaches the draft without passing a row.
- **The reason a row can't be picked is the one thing on it that stays at full strength.** A
  disabled row is dimmed by *colour*, never by `opacity` — a child cannot undo a parent's opacity,
  and this is the child that must not be dimmed — and the badge carries the accent while the name
  and the detail columns drop back. `#wadlibrary .row.disabled` therefore sets `opacity: 1`
  explicitly: `#menu .row.disabled` matches at the same specificity, so merely leaving the
  declaration out would let that one apply unopposed.
- **No merge-order number on a library row.** The order is a property of the set being assembled,
  which the New Game tab's add-on list owns and shows; numbering a browser row by it would rank
  files against something the browser has no say over.
- **The filter box in the header matches folder names as well as file names** (`filterTree`, pure
  and tested without a DOM). A row survives if its own name matches, if a folder above it matched,
  or if it holds a matching WAD at or below it — so searching for a file still shows the folders it
  lives in. A folder matched **by name** lists *entire* rather than having its contents filtered a
  second time, and hands that down to everything nested inside it: asking for a folder by name is
  asking for what's in it. Three things follow that are easy to miss:
  - **A filter overrides the fold state**, since a row it kept but a collapsed parent hides is a
    match the player is told about and cannot see. It reads `expanded` rather than writing it, so
    clearing the filter restores the folds intact — and the folder icons read open while it is up,
    or they would claim to be hiding children that are visibly right there.
  - **Typing re-aims the file pane.** The selected row is often still on screen as a *route* to a
    match rather than as a match itself — the parent of the folder that hit — and leaving it
    selected answers a search with an empty pane. Clearing the filter leaves the selection alone,
    since by then it is wherever the player last looked.
  - **A filter matching nothing empties the tree**, so the selected row can name something no longer
    on screen; the pane is looked up among the rows the filter kept and says so when there are none.
    A blank pane under a blank tree is the overlay looking broken rather than looking empty.
  - **The game WADs are exempt from all of it** and stay listed in full whatever is typed. Finding
    an add-on and seeing that it wants the other game is a normal outcome of a search, and having to
    clear the filter to go and switch game WAD — then type the search again — turns one decision
    into three. `FilterMatch.hits` exists to keep that exemption from swallowing the search: it is
    the rows the filter actually *found*, and it is what the file pane is aimed at, so a search
    still lands on its match rather than on the row that was never filtered.
- **`Choose folder…` carries the primary weight until it has been used.** With no folder set it is
  the only control in that panel that does anything and the panel above it is empty; once there is a
  folder to change it drops back to a ghost like its neighbours.
- **Everything that acts on the folder itself is one row** under the tree — Change, Rescan, Forget —
  because all three are decisions about the same object; only `Add single WADs…`, which is about
  loose files sitting in no folder at all, stands apart below it. `Rescan` re-walks the folder,
  picking up files added since, and the memo makes unchanged files cost nothing.
- **Forget is a press-and-hold** (`hold.ts: confirmOnHold`, § Save and Load tabs), and has no click
  handler at all — the hold is the only way in. It is the one destructive button in that row and it
  sits between two harmless ones, so a stray click has to cost nothing.
- **Every path through a folder pick reports something**, because silence is the one answer the
  player can't act on — a pick that reported nothing was reported as a broken button, twice. That
  covers a folder yielding no files or none with a `.wad` in it, a picker that threw (the message is
  quoted, and the plain input is offered instead), a dismissed dialog, a fallback taken because
  `pickerBlock()` said this window or this browser has no picker, and a scan whose every file was
  unreadable (`scanResult`, which quotes the first skipped file's own reason rather than only
  counting — docs/wad.md § The player's own library).
- **"A dialog closed with nothing in it" is two different events, and neither is necessarily a
  cancel.** A directory `<input>` needs a second, browser-drawn confirmation after the folder is
  chosen, and a window that suppresses it turns a *successful* pick into the input's `cancel` event
  — which is how a player who did choose a folder gets told nobody chose one. `showDirectoryPicker`
  has the same ambiguity: `AbortError` covers both a dismissal and the browser refusing the chosen
  folder outright (Chromium blocks system and home directories). Neither can be told apart from in
  here, so each line names both readings and offers the route that needs no confirmation —
  **"Add single WADs…"**, which is why `#file-input` is `multiple`.
- **The dialog never opening has no event of its own**, and that is exactly what an embedding which
  blocks file choosers looks like from in here. `chooseWithoutPicker` starts a `PICKER_TIMEOUT`
  watchdog (30s — it is racing a human browsing their disk) that says what it actually knows: no
  answer yet, and if no dialog opened, this window is blocking it. A `change` or `cancel` arriving
  later clears it and overwrites the line.
- **A multi-file add reports its failures with its successes**, not before them: `addFiles` used to
  `setStatus` each bad file as it hit it, and the "Added …" line at the end overwrote every one of
  them, so a pick where half the files were unreadable claimed unqualified success.
- **The status line runs to two lines and no further**, in the overlay and on the menu alike. What
  lands there is often a sentence naming a failure *and* what to do about it, and one clipped line
  cut off the half that said what to do; unbounded, it would grow the footer inside a fixed-height
  panel and eat the file list. The messages are written to that budget — measured, not guessed: the
  line is ~465px at 13px monospace, so roughly 115 characters — and both writers mirror the full
  text into `title`, since a message long enough to be clipped is one that was explaining something.
- **While the overlay is up, its footer is the only status line there is** (`#wadlibrary-status`,
  written by `LibraryUi.showStatus`), and `Menu.setStatus` **routes into it** rather than writing
  `#menu-status`. The overlay covers `#menu` completely, so this runs both ways: a message raised
  behind it goes to a line nobody can see — that includes the menu's own, since the overlay's
  `Add single WADs…` runs through `Menu.addFiles` — and a message that outlives the overlay turns up
  on the New Game tab out of the context that explains it, which is how the press-and-hold coaching
  ended up telling that tab to hold a button it doesn't have. One surface, whichever is on top.

**The Add-ons list holds the picks, not the offer.** `renderPwads` lists `selectedPwads` alone, in
merge order — browsing is the overlay's job now, so the list on the tab is short and is no longer a
second picker that has to agree with the first about what is compatible. Each row is checkbox · name
· [reason] · size · contents · `DEH` · info · support · `#N` · `×` — the same detail columns the
overlay lists, narrower — and the two controls mean **different things**:

- **The checkbox disables, it does not remove.** An unticked add-on keeps its row and its place in
  the order, so a mod can be switched off for one run and back on without being hunted down in the
  library again. The state is `Menu.disabledPwads`, a set of *off* keys — off rather than on, so a
  newly picked add-on is enabled by default, which is what picking it meant. It is persisted beside
  the picks (`StoredSelection.disabled`, optional: absent means every pick is on).
- **`×` drops the pick entirely**, and clears any off-flag with it so re-picking starts on. The file
  itself stays on offer in the overlay where it was chosen. The row is a `<label>`, so that handler
  `preventDefault()`s and `stopPropagation()`s or the click is forwarded to a control.

**A pick the game WAD can't take is refused, not dropped** (`Menu.mismatchReason`): the row stays,
dimmed, with an untickable box, `off` in the order column and the reason in a badge — and its
off-flag is left alone, so picking a game WAD that suits it again brings it back exactly as it was.
Switching from DOOM II to DOOM 1 and back must not cost a set the player assembled once; the old
behavior pruned those picks out of the list and out of storage. The badge column is rendered **only
when some row in the list has a reason to give**, and then on every row, empty ones included: it
costs the name column its width, and the fixed-width columns behind it have to begin in the same
place on every row. Its wording is shorter than the overlay's (`DOOM II` against `DOOM II maps`)
because this panel is a fraction of that one's width; the *rule* behind both is the one
`fitsGameWad`.

`Menu.activePwads()` — picked, ticked, *and* mergeable (`pwadsFor`) — is what everything resolving a
WAD set reads: the level list, the start, and the library-permission check. `selectedPwads` alone is
only ever the *display* list, which is what keeps an unticked or refused row from leaking into a
loaded game — and that guard is exactly what lets a refused pick keep its place. The `#N` badge
numbers against the active list too, so the order reads 1..n with no gaps; any row that isn't being
merged shows `off`.

Drag-and-drop onto the menu is unchanged and still the fastest way in for one file;
`Add single WADs…` in the overlay is the same thing through `#file-input` for anyone who can't drag.

## The text file popup

`ui/menu/wadinfo.ts` (`WadInfoUi`), `wadinfo.html`, `wadinfo.css`. The `.txt` a WAD ships beside it
— `SCYTHE.TXT` next to `SCYTHE.WAD` — read in place. Which files have one, and how the bytes become
text, is docs/wad.md § The text file beside a WAD; this is only what the menu does with it.

- **The info column is the door**, in both WAD lists: a blue `ℹ` on a file that has a text file, an
  empty span on one that hasn't (`labels.ts: infoColumn`, rendered by `sourceColumnSpans` like every
  other column so the two lists cannot disagree). Empty rather than absent, or the support glyph
  behind it would land somewhere different on each row.
- **The button is a `<button>` inside the row's `<label>`** and so `preventDefault()`s and
  `stopPropagation()`s — the same shape the add-on list's `×` has, and for the same reason: without
  it the click reaches the row's own checkbox.
- **A disabled row keeps a live info button.** Reading what a file is about is exactly what a player
  does with one the set can't take — the badge rule (§ WAD Library) extended one column.
- **It is the menu's overlay, not the WAD Library's**, at `z-index: 6` local to `#menu` — one rung
  above `#wadlibrary`, because it opens from a row inside it and has to cover it. It leads
  `Menu.overlays` for the same reason (§ The overlays over the menu).
- **The read is per-open and cancellable by the next one.** `WadInfoUi.token` rises on every open
  and on close; a read that lands under a stale token is dropped, so a second file opened while the
  first is still in flight is not overwritten by it, and nothing lands in a closed popup.
- **The reader does not wrap** (`white-space: pre`). These files are laid out at a fixed column
  width, and wrapping them costs the banners and tables their alignment — a long line scrolls
  sideways instead. The panel's size is fixed on both axes, so it doesn't resize between
  `Loading …` and the file.

## Save and Load tabs

`ui/menu/savegames.ts` (`SavegamesUi`) renders both panels over the `game/savegames.ts` store; the
format, apply order and WAD-identity rules are docs/savegames.md's. What is the menu's own:

- **The Save tab exists only mid-game** — `open(inGame)` hides its button with `display: none` (the
  `#controls-dev` pattern; the button must leave the flex row, not hold a gap) and moves anyone
  still on it to New Game. Same gate as the resume button: there is nothing to save otherwise. The
  Load tab is always available.
- **A moment the capture would refuse greys Save and Overwrite out**, rather than letting the click
  fail: the `canSave` getter is `inGame && saveRefusal() === null`, over a hook reaching
  `Game.saveRefusal` (dead, intermission, exiting). It asks the hook afresh at each use rather than
  caching the answer in a field — three boolean reads, against a cached copy that would have to be
  written before `renderVisible` builds the rows. The reason itself goes in the `#save-refusal` hint
  beside the Save heading, which shares the rows' `.warning` styling — **a disabled button shows no
  tooltip**, so the Overwrite `title` alone would tell the player nothing, and it keeps the
  unconditional text. The throw stays in place regardless: the buttons are a courtesy,
  `Game.saveVia`'s own capture is the actual gate.
- Saving takes an optional name (defaulting to map + date), and both panels list every save the
  player made, newest first: thumbnail, name, the level · level time, then skill · date. The
  level-entry checkpoint is the one save neither tab ever shows — `listSaves` drops it, and it
  costs nobody a slot (docs/savegames.md § The checkpoint). Rows are rendered fresh on every
  `open` via `SavegamesUi.refresh`, with the `#pwad-list` scrollTop-restore trick.
- **The level line and the missing-file warnings come from `Menu.describeSave`**, not from the save:
  a save stores the map *lump* name, which alone can't name a level (docs/wad.md § Level names), so
  the row resolves it against the current library through `mergedMaps` and names it with the same
  `describeMap` the level select uses — `<lump>  —  <title>  —  <provider>`, so the two lists can't
  disagree about what a level is called. The same pass reports every file of the set the library can
  no longer supply, one line per file — matched by *content ID* (`resolveSaveWads`, the same call
  the load path makes), so a renamed WAD is not reported and a file whose bytes have changed reads
  `Different IWAD/PWAD: …` rather than `Missing IWAD/PWAD: …`, which would send the player looking
  for something they already have. A file the load actually needs back (the map's provider, and the
  game WAD where nothing may stand in for it) is a subtle red warning; the rest are the same line in
  amber (`.caution`), because they are still a file the save was made with and no longer has — just
  not one that blocks the load, which is what the red says. A missing game WAD the library can
  supply a stand-in for is one of those amber lines — `Stand-in for DOOM2.WAD: freedoom2.wad`, since
  the load proceeds on it (docs/savegames.md § A stand-in game WAD); only where no stand-in is found
  does it go red. **The line is `missingWadLabel`, not the full sentence**: every line
  in the label column is `white-space: nowrap` with an ellipsis, so the rows keep one height beside
  the thumbnails, and the column is only ~60 characters wide at 12px (682px menu, less the thumbnail
  and the row's three buttons). The sentence saying what to *do* — `missingWadText` — goes on that
  line's `title` and is what a failed Load throws into the status line, both of which have the width
  for it (docs/savegames.md § WAD-set identity). **A row missing a *required* file greys its Load
  button out**, the same courtesy Save and Overwrite get for a refused moment — the red line beside
  the button is the reason, since a disabled button shows no tooltip. A row missing only optional
  files keeps Load live, because that load works. `addFiles` re-renders the save lists as well as
  the WAD lists, so bringing that file back clears the warning on the spot rather than on the menu's
  next `open` — which is also why `Menu` keeps the last `inGame` it was opened with.
- **The name in each row is an `<input>`** — renaming happens in place (`renameSave`), Enter or blur
  commits, ESC reverts and is stopped from bubbling to `main.ts`'s menu-closing handler. An
  untouched field re-renders nothing, so a plain focus-and-blur can't pull the row out from under a
  click heading for one of its own buttons. Nor does a *successful* rename: it patches the visible
  list (the input's own value) and only marks the other tab's list stale. **Re-listing** rebuilds
  every row — one thumbnail decode and one `describeSave` each — to redraw one string, the cost
  worth avoiding on the one path a player repeats. A **delete** drops the row from the cached
  listing and redraws the tab from it: the store read is the part `rename` avoids, and this needs
  none — measured at ~3 ms over 40 rows, the thumbnails coming back from the browser's own image
  cache. (A rename also never rewrites the save's state record: `renameSave` puts the meta alone.) It also means nothing may bake a
  save's name into a row's other elements — the Overwrite tooltip says "this save" for that reason.
- **The save lists fill the panel vertically**: `.list-section` is the tab panel's flexible child
  and the list is the section's, against a `#menu > .panel` capped at the viewport — so the rows use
  whatever height is left and scroll inside the menu instead of growing it off-screen. Because the
  tab panels share one grid cell, that height is the tallest panel's on every tab, as before.
- **A row that cannot be loaded says why, in red.** `SaveListEntry.refusal` is the sentence
  `readSave` would have thrown — a format version this build doesn't read, or a meta too damaged to
  trust — printed beside the row's missing-file lines and in the same red, since it means the same
  thing. Greying Load without it is the bug this replaced: every disabled Load or Play carries its
  reason (CLAUDE.md § Project-wide rules). The row renders dimmed via its own `unsupported` class
  rather than `.disabled` (a child can't undo a parent's opacity, and its download/delete buttons
  must stay live); only Load is refused.
- **What the rows share with the Replays tab lives in `actions.ts`**: the refusal contract every
  store call runs under (`attempt`: anything thrown becomes the status line), the red/amber line
  beside a row (`noteLine`), the heading's filter field (`installFilter`, `matchesFilter`,
  `emptyLine`), the download and delete icon buttons (`iconButton`) and handing an export file to
  the browser (`downloadJson`). Each tab keeps only the store call, the noun and which fields its
  filter looks through.
- **Each list has a filter beside its heading** (`.list-head` is the flex row, the `<h2>` giving up
  its margin to sit in it — the WAD Library header's shape). A save is matched on its name and its
  level, a replay on name, player, notes and level (§ Replays tab); the comparison is a plain
  case-insensitive substring, over text `installFilter` trimmed and lowercased once per keystroke
  rather than once per row. Three rules make it behave:
  - **The Save and Load tabs filter independently.** They are looked through for different reasons,
    so text typed over one must not hide rows on the other.
  - **A keystroke re-renders from the cached listing, never from the store** (`SavegamesUi.entries`,
    `ReplaysUi.entries`), and scrolls back to the top: the rows are a different set now, so keeping
    the offset would leave the player looking at the middle of them. A keystroke that leaves the
    Replays panel's pick alone leaves the panel alone as well — only a re-list can change what one
    of its thirty-odd elements says.
  - **The list says which of the two things an empty list means** — nothing stored, or nothing the
    filter kept — from its renderer (`actions.ts: emptyLine`), since only it knows both counts.
    `:empty::after` stays the shape for the add-on list alone, which has no renderer and no filter;
    it is keyed on `#pwad-list` rather than on `.list`, or its sentence would be what an unrendered
    save list claims.
  - **ESC clears a filter that has something in it** and stops there; an already empty field lets
    the key through to `main.ts`, which closes the menu with it — the in-place rename's rule.
- **Delete and Overwrite confirm by being held** (`hold.ts: confirmOnHold`, `HOLD_MS` — shared with
  the WAD Library's Forget, and styled by the class alone in `hold.css` so any `#menu` button can
  wear it): a bar sweeps the button and the action fires when it lands, letting go early cancels and
  says so in the status line. An inline confirm, so About stays the menu's only reader popup — and
  one gesture rather than the two-click arm it replaced, which read as a broken button. The sweep is
  a CSS transition whose duration is handed over as `--hold-time`, so the bar and the timer can't
  disagree; the label moves into a `.label` span so the `.fill` can paint behind it, and Space/Enter
  held on a focused button works the same way. **`required` makes the hold conditional** — a button
  that only destroys something some of the time (Start new game, § One screen, two jobs, and **Load**,
  which throws the running level away exactly as a start does) wears the same confirm and acts on a
  plain click while the predicate says no; the tooltip follows the hold, so from the launcher Load
  carries none. Both are per row; Overwrite refills that save from
  the current moment, keeping its ID and its name (renaming has its own affordance). Delete and
  download are icon-only buttons (`⤓`, `🗑︎` with a text-presentation selector) with their meaning in
  the tooltip; Load and Overwrite are `.primary`.
- **Download** writes the save as `<name>.topdoomsave.json` through a temporary anchor: one
  tab-indented JSON file whose meta fields are readable and whose `state` is the stored gzip bytes,
  base64'd (`exportSave` — docs/savegames.md § Storage has the format's rules);
  **import** accepts such a file back via its own `#save-file-input` (the WAD `#file-input` stays
  out of this), or by dropping a `.json` onto the menu —
  `installDropTarget` routes `.json` to the importer and everything else to `addFiles` as before.
- Every failure — quota, cap, version, missing WAD — lands in the shared `#menu-status` line;
  `SavegamesUi` never touches the running game. The three hooks (`onSave`, `onOverwrite`, `onLoad`)
  are `main.ts`'s (§ Session lifecycle below), which owns the `Game` instance and the selection the
  save records; the first two share one `withCapture` body, which hands its store call to
  `Game.saveVia` — the capture, the write and what a stored save makes `R` reload all belong to
  `Game` (docs/death.md § Player death), so the session layer contributes only the writer. A
  refusal is **thrown**, never returned — by the store, by `withCapture` and by `Game.saveVia`
  alike, which is why the capture has no null return: one `catch (err) → setStatus` shape rather
  than two conventions for the same job, and the reason thrown is the specific one
  (`Game.saveRefusal`) rather than a list of everything it might have been. `SavegamesUi.attempt`
  is the single place that shape is written on the UI side; the store being async now, every hook
  may return a promise and `attempt` awaits it, so a rejection lands in the same status line a
  synchronous throw does.
- **Only the tab on screen is built.** `refresh` marks both lists stale and renders whichever
  `Menu.setTab` last declared visible (`setVisible`); the other waits until it's picked. Listing
  itself is a cheap meta read since the store's meta/state split, but rendering still costs one
  thumbnail decode and one `describeSave` per row, and `open()` runs on every `ESC` pause and once
  at boot — a player who never opens Save or Load must not pay for the rows at all. `renderVisible`
  is async (the listing awaits IndexedDB) and guards itself with an epoch ticket: a refresh or tab
  switch while a listing is in flight starts a newer render, the older one discards instead of
  painting over it, and `stale` is cleared only by the render that painted — a discarded render
  leaves its tab marked for the next look. `Menu.mapCache` memoizes `mergedMaps` per WAD set for
  the same reason as the laziness: `describeSave` needs a level title per row, and the rows share a
  handful of sets.

## Replays tab

`ui/menu/replays.ts` (`ReplaysUi`) over the `game/replay.ts` store, following every rule § Save and
Load tabs states — the epoch-ticketed lazy render, the thrown refusal into `#menu-status`, the
in-place edit that patches its row instead of re-listing, the hold-to-confirm delete, the greyed
Play for a set the library can't supply. What is this tab's own:

- **It is a list beside a detail panel, not a list of fat rows** (`.replays-split`, 55/45 grid
  columns): a replay carries three editable fields and six facts, which is more than a row can hold
  without becoming a form. The **list** shows only what tells one run from another at a glance —
  name, player, length — and the **panel** shows the picked one in full. `selectedId` survives a
  re-list, so an edit or an import doesn't move what the player is looking at; a stop or a delete
  clears it, and the newest replay is what an unset pick falls back to, which is exactly the run
  just recorded.
- **The filter reaches what the panel holds, not only what the row shows**: name, player, notes and
  the level — a run is as likely to be remembered by the note written on it as by its name. The
  level costs a `describe` per row, so an empty filter never asks for it. A pick
  the filter hides is moved to the first row that survived it — a panel showing a replay the list
  says isn't there is the state to avoid — and with nothing left it falls back to the placeholder.
- **The panel's buttons and warnings never scroll** (`.detail-body` is the scroller, the rest are
  its siblings): the fields and facts scroll under them. A reason scrolled out of sight beside a
  greyed Play is the state the "say why" rule exists to prevent.
- **The split asks for a fixed height** (`flex: 1 0 auto` over `height: 190px`, the list's own basis
  plus its button) and grows from there, the `.saves` rule again. Without it the detail panel's
  content set the *menu's* height: a replay carrying a two-line warning made this tab taller than
  every other one, so switching to it grew the menu. The panel scrolls instead.
- **A replay that cannot be played says why, in red**, where the Load list only greys the button and
  notes the version in its meta line: `ReplayListEntry.refusal` is the sentence `readReplay` would
  have thrown, printed in the panel beside the Play it greys, with the missing-file lines under it
  (docs/replays.md § Storage). Its list row is dimmed by colour and carries the same sentence on its
  tooltip — a row is not a button, so a tooltip is readable there.
- **The tab is always available**, unlike Save: a replay can be played from the launcher. Only its
  record button needs a running game, and is disabled with the reason beside it otherwise —
  `Game.recordingRefusal`, which adds "a replay is playing", "already recording" and a cheat code
  half typed to the moments a save is refused at, in recording's own words (docs/replays.md
  § Recording). It is what the hint says after a recording is stopped somewhere a new one cannot
  start — the intermission most of all, where stopping is the ordinary thing to do. With **no game
  at all** that hook has nothing to answer for, and this one grey says why on a **tooltip**
  (`NO_LEVEL_TOOLTIP`) rather than in red: nobody expects to record a game that isn't running, so
  the sentence would be noise on the launcher's every visit. It hangs on the row rather than the
  button, since a disabled button gets no hover — which is exactly why every *unobvious* refusal
  here stays text.
- **The record row is one line** — heading, button, hint (`#replay-record-section` is the flex row;
  the heading keeps its `<h2>` and loses its margin). Stacked it spent two rows of a panel that is
  short of height on a heading and a button filling a third of the width, and that height comes
  straight off the list and the detail panel below.
- **The Replays tab carries a red light while a recording runs** (`.recording`, set wherever the
  record button is refreshed), so it is visible from every tab — the HUD's own light is behind the
  menu meanwhile (docs/replays.md § Recording).
- **The button says what pressing it does**: "Record from here", or "**Stop and save recording**" —
  primary while one runs, since that press is what turns the run into a stored replay. Stopping
  stores it; so does the session, for a recording still running when a level start or the campaign's
  end tears the `Game` down (§ Session lifecycle).
- **"Cancel recording" stands beside it while one runs**, and only then: it is held to confirm
  (`confirmOnHold`, the delete gesture) because it destroys the run recorded so far, and it is
  hidden rather than greyed the rest of the time — a second greyed button beside a greyed first says
  nothing the first hasn't. Nothing reaches the store, so the list is left alone and only the record
  row goes back to offering a fresh start; the level itself plays on (docs/replays.md § Recording).
  Its label is written in the markup and never rewritten, `confirmOnHold` having rebuilt the
  button's children around a `.label` span.
- **Three fields are editable**, all in the panel: name and player share a line (`.field-row` —
  two short values, and the panel is short of height rather than width), then **Notes** below them,
  a `<textarea>` of `NOTES_ROWS` lines, since a note about a run is a sentence or three and an
  `<input>` shows one.
  Each commits through `describeReplay` (a meta-only write, like `renameSave`) on blur, or on Enter
  outside the notes, where a newline is a newline; a committed name or player patches its list row.
  A non-blank **player** also becomes the name later recordings are credited to — there is no
  Settings field for it (docs/replays.md § Recording). The panel's read-only facts are level, skill,
  when it was recorded, the WAD set, and build · engine — provenance, read before playing. What
  actually warns is the amber line under them: a replay recorded under a different **simulation
  epoch** says it may desync (`compatDrift`, docs/replays.md § Compatibility), where the build
  number alone says nothing.
- **The replays the engine ships are listed under the player's own**, marked `included` and
  read-only: play and download, no fields to type in and no trash button, since the file is the
  server's (`public/game/replay/`, docs/replays.md § Stock replays). Two lists concatenated rather
  than one sort by date, so a stock replay never lands between two of the player's own runs. Its
  panel reads instead of edits — the name carrying the mark, the player joining the facts, the notes
  only where the recording came with some — and everything else about the row, the refusal in red
  and the amber epoch line included, is what a stored replay gets.
- **A downloaded replay is `<name>.topdoomreplay.json`**, a downloaded save `<name>.topdoomsave.json`
  (both `downloadFileName`), and `installDropTarget` routes a drop by the replay suffix *ahead* of
  the `.json` save rule, so the two imports can't take each other's files — a save downloaded before
  its own suffix existed still lands on the save importer.
- **The New Game tab's record toggle** starts a recording with the game (`Selection.record`). It
  rides the Level/Difficulty row as a third control rather than taking a row of its own, and reads
  as the state it is in ("Not recording" / "● Recording") rather than as what pressing it would do.
  Session-only and off by default: a recording that outlived the tab it was armed in would be a
  surprise, and it costs memory for the whole run.

## Picking a WAD set

The lists are fed by `/game/index.json` (docs/wad.md § The `public/game/` manifest) plus anything
loaded from disk. Semantics worth knowing before touching `menu.ts`:

- **Game WAD** (`renderIwads`) only offers sources with `type === 'IWAD'`. A PWAD mapset can still
  be *played* as the game WAD (dropped on the menu, or `?wad=`), but it doesn't appear in this list
  to pick from directly.
- **Add-ons** (`renderPwads`) lists the picks; anything of `type === 'IWAD'` never reaches them, and
  a source that is *also* the current game WAD is shown refused (badge `game WAD`) rather than
  merged twice. Order matters and is the order they were ticked: it's the merge order, so the
  rows carry a `#N` badge. Ticking a row re-renders the whole list, which empties the scroller and
  would clamp it back to the top, so `renderPwads` saves and restores `scrollTop` — with enough
  add-ons installed the list scrolls, and picking one out of the bottom of it must not scroll away.
- **Three kinds of source sit in these lists side by side and behave identically** — the server's
  own files, the player's library folder (§ WAD Library, docs/wad.md § The player's own library) and
  files dropped on the window, all parsed in the browser by the same `describeWad`
  (docs/wad.md § Describing a file without loading it). `WadSource.origin` is the only thing that
  separates them, and only three things read it: `describeSource`'s trailing note, `saveSelection`'s
  refusal to persist an upload, and whether a row gets a `×`.
- A dropped file that declares itself an IWAD becomes the game WAD; anything else is added as an
  add-on. **The declared type decides here** — there is no longer a per-target picker to disagree
  with it. `addFiles` applies the pick through `takeAsIwad`/`takeAsPwad`, the same render-free
  bodies the single-pick handlers use, and draws once for the whole drop.
- **Add-ons are filtered by game, and never dropped for it.** An add-on that doesn't fit the
  selected game WAD (`library/defs.ts: fitsGameWad`, over `mapStyle` — see docs/wad.md § The
  `public/game/` manifest for what style means) is rendered **disabled** rather than hidden — a
  mapset that's simply for the other game is still worth seeing, just not pickable. Switching game
  WAD **keeps** every pick that no longer matches, greyed out and unticked, so switching back
  restores the set intact; what keeps the merged map list (`mergedMaps`) from silently mixing an
  E1M1 with a MAP01 mapset is `activePwads`, which filters through `pwadsFor` before anything
  resolves a set. The greying and that filter read the same predicate — one statement of the rule,
  or a row the menu offers is one the start then drops.
- The **Level** list groups DOOM 1's `ExMy` maps by episode, and each row reads
  `<lump>  —  <title>  —  <provider>`, dropping either of the last two when it doesn't apply: the
  title only when the WAD set knows one (docs/wad.md § Level names — resolved off the manifest
  alone, since nothing has been downloaded at this point), the provider only when an add-on took the
  map over. The lump name always comes first: it is what the level is selected by, what `?map=`
  takes, and the only thing every map has. The label itself is `ui/menu/labels.ts`'s `describeMap`,
  shared with the save rows (§ Save and Load tabs) so a level can't be named two ways in one menu.

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
actually goes looking for. *Top-down extras* holds the two this camera needs and vanilla never did:
the void fog and the tops on crates and pillars (docs/render.md § Solid structures, § The void
floor). The second is the one setting on the tab that is **not** live — the caps are baked into the
level's mesh — and its row says so.

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
docs/render.md § It has no setting.

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

General ends with **`Debug / Dev`, the section holding the `FPS counter` and `Profiler overlay`
checkboxes** (§ FPS counter, § Profiling overlay). It is shown in every build — both are
player-facing settings, only their *defaults* follow `DEVMODE` — so unlike `#controls-dev` nothing
toggles it at runtime.

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

The rest is static markup with no `Menu` state — no field lookups, no listeners — except
`#controls-dev`, the `N`/`P` map-jump row, which the constructor reveals when `DEVMODE` is set.
`DEVMODE` can't change at runtime, so it is never re-checked. **It takes the global `.hidden`
(`display: none`), not the tab panels' `.inactive`** — a panel has to keep reserving height, but a
hidden section must drop out of the `.columns` flex line entirely (docs/styles.md § Hiding an
element).

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
| `fps` | `ui/devmode/debughud.ts` (`getFpsVisible`/`setFpsVisible`) | § FPS counter below |
| `profiler` | `ui/hud/profiler.ts` (`getProfilerVisible`/`setProfilerVisible`) | § Profiling overlay below |
| `dynamicLights` | `render/lights.ts` (`getDynamicLights`/`setDynamicLights`) | docs/lights.md § The toggle |
| `voidFog` | `render/voidfloor.ts` (`getVoidFog`/`setVoidFog`) | docs/render.md § The toggle |
| `solidCaps` | `render/solids.ts` (`getSolidCaps`/`setSolidCaps`) | docs/render.md § Solid structures |
| `wallShade` | `render/wallshadow.ts` (`getWallShade`/`setWallShade`) | docs/render.md § Turning it off |
| `skyTint` | `render/skytint.ts` (`getSkyTint`/`setSkyTint`) | docs/render.md § Turning the tint off |
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
resolves it is **URL > stored > first IWAD on offer**, and every key is resolved against the current
library, so a WAD that has since left `public/game/` is silently dropped (an unknown map falls back
to the set's first, via `selectLevel`'s no-op). Restoring can pair a stored add-on with a
`?wad=`-forced game WAD it doesn't suit; that pick is **kept**, refused rather than dropped, so the
stored set survives a deep link (§ Picking a WAD set).

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

## Session lifecycle (`main.ts`)

`boot()` creates everything that must outlive a level exactly once — `Viewport` (one WebGL context
and one canvas for the whole page), `AudioEngine` (one `AudioContext`), the `Menu`, and the `ESC`
listener — and holds a single mutable `game: Game | null`. A `Game` is per-WAD-set/per-level and is
built to be thrown away and replaced.

Rules that hold this together:

- **The page boots showing `#loading`, not the HUD.** Every other overlay is in the markup already
  `hidden`; the boot screen (`ui/loading.html`) is the one that starts visible, because the static
  HUD markup would otherwise be what the player sees — placeholder `100` health over an empty
  level — for as long as the WAD manifest takes. `boot` takes it down once whatever replaces it is
  up: the menu, or a `?map=` level, which is why that branch **awaits** `menu.submit()` — the deep
  link never opens the menu, so the same overlay covers its WAD load, and `startLevel` has already
  raised and lowered it by the time `boot` calls `hide` (§ The loading screen). The failure path
  needs no call of its own: `#fatal-error` is a rung above `#loading`. The launcher branch also
  brings the welcome popup up over the menu (§ Welcome popup).
- **`new Viewport` is wrapped in `try`/`catch`** and routed to `#fatal-error`: three.js throws a raw
  `Error` when the browser can't create a WebGL2 context, and without this the page is left sitting
  on `Loading …` forever, which reads as "hung" rather than "your browser can't run this". The
  GPU-specific message is only shown when the error actually looks like a WebGL failure, so an
  unrelated bug isn't misreported as a GPU problem.
- **A finished campaign ends the session.** `Game` takes an `onCampaignEnd` port beside its
  checkpoint store, called when the end card's continue key has nowhere left to go (docs/hud.md
  § End card). The handler nulls `game` *before* disposing it — the call arrives from inside that
  very `Game`'s tic — and reopens the menu with `open(false)`, as a launcher: there is no returning
  to a run that is over.
- **`audio.resume()` runs synchronously before `startLevel`'s first `await`**, while still inside
  the click handler — the only moment a browser reliably lets an `AudioContext` start. A `?map=`
  deep link never gets that click, so `boot` also arms one-shot `pointerdown`/`keydown` unlockers.
- **The `game` slot is cleared before the old level is disposed.** A `Game` constructor that throws
  (a WAD with no maps, a mesh build failure) would otherwise leave `game` pointing at a *disposed*
  instance, and both "Return to game" and the `ESC` handler key off it being non-null — resuming it
  restarts a render loop over released GPU resources. On failure the menu stays open, shows the
  error, and is re-synced with `open(game !== null)` so it stops offering a return.
- **"Return to game" is disabled for the duration of a start** (`startWithSkill`), since the level
  it would return to is disposed part-way through.
- **A replay is the same `startLevel` too**, given the replay as a third argument: its WAD set is
  resolved by `playReplay` exactly as `loadSave` resolves a save's, and `Game` gets snapshot 0 as
  `restore` plus the replay as `playback` (docs/replays.md § Playback). Every teardown of a `Game`
  stores whatever it was still recording first (`storeRecording`), so a recording survives the
  level start or campaign end that ends it.
- **A load is the same `startLevel`**, given the save as a second argument: it verifies the
  assembled set's game WAD and map provider against the save's own IDs (`verifySaveWads`, over
  `wadSetRefusal` — docs/savegames.md § WAD-set identity) and hands `Game` the snapshot instead of
  `?pos=`. Everything above — the audio gesture, the dispose ordering, the failure re-sync — is one
  copy, so a lifecycle fix can't reach the new-game path and miss the load path. `loadSave` only
  re-resolves each `wads` entry to a `WadSource` by content ID first, and a *required* file the
  library can't supply fails *there*, before anything is torn down, so the running level survives a
  load that can't happen; an add-on that supplied neither the map nor the game WAD is left out of
  the set instead.
- A second `Game` builds against the *same* static DOM, so anything holding generated children must
  replace rather than append, and per-level screen state must be cleared — see docs/hud.md
  § The HUD and § Screen effects. `dispose` clears the center message, the level card and the
  intermission popup for that reason: all three are static markup that outlives the `Game` that
  raised them.
- `ESC` works during the intermission popup too. `pause()`/`stillFrame` keep drawing, the menu sits
  over the popup, and `resume()`'s `input.reset()` drops the keypress that would otherwise dismiss
  it the moment the game comes back.

## The loading screen

`#loading` (`ui/loading.ts`) is one overlay with two jobs: the boot screen that is up from the first
paint, and what covers every level load after it. It sits at `--z-loading`, above the menu, so
starting a game covers the menu rather than closing it first.

**Starting a game shows the download, not a spinner.** `startLevel` puts the overlay up and feeds it
`loadWadFiles`' aggregate progress — bytes arrived over bytes expected, across the whole selected
set at once, because several files download in parallel and one bar is what the player can read. The
total comes from each source's manifest `size`, so it is known before the first byte and never
moves. Two consequences worth knowing:

- **A source already in memory reports nothing and is left out of the total.** Restarting the same
  WAD set is served from `serverSource`'s memo, so the bar never appears rather than flashing to
  100%.
- **Only a download streams.** `bytes()` reads the body in chunks only when a progress callback is
  given; without one it stays on `res.arrayBuffer()`, which saves reassembling up to 28 MB.

The bar covers the WAD set alone. `topdoom.wad` (§ docs/wad.md § The WAD the engine ships) loads in
the same `Promise.all` and is not counted — 651 KB against a 14 MB IWAD would only make the number
lie in the other direction.

**A level load shows nothing unless it is predicted to be slow.** `Game.loadLevel` is the one
decision point — an exit, `R` after death, a checkpoint reload and the DEVMODE map jump all go
through it — and it estimates the build from the map's `LINEDEFS` lump size (`mapLinedefBytes`, a
directory lookup; a UDMF map's `TEXTMAP` size scaled to the same unit) times `buildMsPerKb`. Only
above `SLOW_LOAD_MS` does the overlay go up. An ordinary level change is a few frames, and an
overlay up that briefly is a flicker, not feedback.

**The estimate exists because the build cannot be interrupted.** `loadMapByIndex` is one synchronous
block, so nothing paints while it runs and a "show it if it takes long" timer would fire into a
frozen main thread. The decision therefore has to be made *before* the build, from what is cheap to
know. Four rules follow:

- **The load is parked, not awaited.** `pendingLoad` holds the caller's own body as a thunk; the tic
  ends, the browser paints, and the next `frame` runs it. Merely awaiting would let the loop keep
  simulating tics into a level about to be replaced. `main.ts` has no loop of its own yet, so its
  own first load uses `LoadingScreen.painted` instead — the same "let it paint first" rule, one
  frame at a time rather than one load.
- **That frame runs ahead of the FPS cap**, or a capped frame would skip it and leave the overlay up
  for nothing.
- **It resyncs the frame clock afterwards** (`resyncClock`, shared with `resume`): build time is not
  simulation time, and `accumulator` must not pay it back as a burst of tics.
- **`pause` flushes a parked load** rather than leaving the overlay — which outranks the menu —
  covering the screen the pause exists to show.

`buildMsPerKb` is re-measured from every build, so after the first level the prediction is the
player's own machine rather than the one `BUILD_MS_PER_KB` was measured on.

## Dev mode (`DEVMODE`)

`DEVMODE` reads `import.meta.env.VITE_DEVMODE`, defaulting to `false`; set `VITE_DEVMODE=true` in a
git-ignored `.env.local` at the repo root to turn it on (Vite loads `.env.local` itself, no plugin
needed). It gates three things — `ui/devmode/debughud.ts`, `ui/hud/profiler.ts` and
`ui/menu/menu.ts` — all because a player has no legitimate reason to reach for them:

- **What `#hud` says** (`DebugHud.update`, whose lines come from `Game.debugLines`) — off, the
  element shows only the fps counter; on, the full
  map/pos/sector/camera-state/awake-monster-count/sound-channel block. `DEVMODE` decides how much
  that text says, **not** whether it shows at all — that is the player's own setting (§ FPS counter
  below), which is why the `visible` check sits ahead of the `!DEVMODE` branch. **Everything it
  prints is live state.** The last line is the auto camera's own readout — `AutoCamera.readout` in
  `game/autocamera.ts`, which owns the smoothed state it prints rather than exposing it to
  `game.ts` (docs/camera.md § Auto camera), and reads `manual` in the
  other camera mode. Under a playback it reads `replay camera: recording`/`manual` instead: the
  camera comes from the record there, so the auto camera's dials stand still and printing them
  would be a readout of nothing (docs/replays.md § Playback). It used to end with two static hotkey hint lines as well, which were the game's
  only controls reference and so invisible to exactly the players who needed them; that list is now
  the menu's Settings tab (docs/menu.md § Settings tab).
- **The Settings tab's `#controls-dev` section**, the only place `N`/`P` is listed in the UI —
  revealed once in the `Menu` constructor, so a shipped build never advertises a key it ignores.
- **`N`/`P` (jump to next/prev map)** in `handleHotkeys` — behind the early-return on `!DEVMODE`, so
  they are simply inert outside dev mode. `+`/`-` (camera distance) and `[`/`]` (camera tilt)
  deliberately sit *ahead* of that gate: they are player-facing framing controls, not debug state,
  and gating them only meant a shipped player couldn't adjust how much of the level fits on screen.
  Every key here is skipped for a tic whose characters belong to a cheat code being typed — `P`
  sits inside `idclip` (docs/cheats.md § Typing a code).

Neither the profiling overlay nor the status text's visibility is on that list: `DEVMODE` only picks
the default of each, and a player can turn either on in any build (§ FPS counter, § Profiling
overlay below).

`Game.debugLines` reports `ThingLayer.awakeMonsterCount()` — the number of living monsters
currently alerted (chasing/attacking, or mid-`reactionTicks` delay) — useful for judging whether a
level's population has actually noticed the player. Its sound-channel line is
`AudioEngine.channelUsage` — voices in flight over the pool size (`CHANNELS`, docs/audio.md § The
mixer model) — which is how you see a scene running the pool dry and cutting sounds off. The count
beside it is how many copies the same-tic start budget has turned away since the level loaded
(docs/audio.md § Same-tic bursts): it climbing while the pool sits half empty is the burst rule
working, not a scene in trouble.

## FPS counter

`#hud`, top-left, is the one element two settings meet on: **whether it shows** is the player's
`FPS counter` checkbox, **what it says** is `DEVMODE` (§ Dev mode above) — the bare `N fps` outside
dev mode, the full status block inside it. One switch for the whole element, not one per line: in a
dev build the fps *is* that block's first line, so splitting them would need `Game.debugLines` cut
in two for a distinction nobody asked the menu for.

The setting is `debughud.ts`'s own (`fps`, `getFpsVisible`/`setFpsVisible`) and **defaults
to `DEVMODE`** — on in a dev build, off in a shipped one, a stored `true`/`false` overriding that
either way. It is deliberately the same rule the profiling overlay follows, and for the same reason:
both are diagnostics a player may want and neither should be on top of a shipped game unasked.
**This is a change from the counter always being drawn**, which is what every build did before the
checkbox existed.

`applyFpsVisible` is the single writer of `#hud`'s `visible` class, called by `DebugHud`'s
constructor to seed it for the level starting and by the checkbox to change it live; debughud.css
shows the element by that same class, and **`DebugHud.update` early-returns on it**, so a hidden
counter costs no per-frame DOM write and never runs the `details` closure. The frame *counting*
ahead of that return is not gated — three arithmetic operations, and skipping them would make a
counter switched on mid-level read a rate built from its first half second.

## Profiling overlay

A panel of its own, top-right, breaks a frame's cost down by category — `Specials`, `Player`,
`Weapons`, `Fog of War`, `Monsters`, `Effects`, `Fading`, `Render`, `Music`, plus an `Other` bucket
for whatever wasn't explicitly measured (input handling, HUD text, the player sprite's own pose) —
so a slow frame can be traced to *which* system is responsible rather than just how many fps it
costs.

**Every row is CPU; the GPU gets one number of its own.** The rows and their total time main-thread
wall clock between `beginFrame()` and `endFrame()`, both inside the same `requestAnimationFrame`
callback — which cannot see the GPU, whose work finishes long after that callback returns. That is
why the total says `cpu`, and why the overlay carries a second line. The two bracket the category
rows — `cpu` above them, since they add up to it, and `gpu` below, since it is a separate number:

```
cpu 4.5 ms  (220 fps eq.)
Render   [====      ]  3.10
Monsters [=         ]  0.80
...
gpu 20.1 ms  (49 fps eq.)
```

That layout is `profiler.html`'s, not the class's: the panel ships the two total lines and the
`#profiler-rows` container between them as static markup, and `ProfilerHud` only fills them in — so
moving a line is an edit to the markup rather than to append order in `update()`.

**The two are concurrent, not cumulative — the larger one is what sets the frame rate.** A frame
like the one above is GPU-bound, and no amount of work on any row above it will help; docs/render.md
§ What a frame costs is where to take the GPU side apart. Without this line the CPU total reads as a
frame rate and a GPU-bound scene looks like a four-figure "fps eq." next to a HUD counter saying 50,
which is exactly the report this was added for.

`GpuTimer` (`render/gputimer.ts`) is where that number comes from: one `TIME_ELAPSED_EXT` query
around `renderer.render`, through `EXT_disjoint_timer_query_webgl2`. Four things about it:

- **It reads back late.** A query's result lands a frame or two after the frame it measured, so the
  timer keeps a small pool of them in flight and claims each when the driver has it. The pool is
  capped, which is what stops a driver that never answers from queueing one query per frame for the
  rest of the session.
- **A full pool must never be the end of it.** `end` collects finished results **whether or not
  this frame opened a query of its own**, and a pool that stays full for `STALL_FRAMES` is given up
  on and reused. Both exist because a frame opens no query exactly when the pool is already full:
  collecting only alongside a query of the frame's own deadlocks the timer at the first stall long
  enough to fill it, and the reading then stands unchanged for the rest of the session. A resize
  with the bloom chain on is the case that reaches it — the scene target and the whole blur pyramid
  are reallocated in one frame (docs/lights.md § Bloom).
- **A *disjoint* drops the whole batch.** The GPU having been reset invalidates every query in
  flight, not one of them, and reading the flag is what clears it — so it is read once per harvest
  and every result in that pass is discarded when it is set.
- **`gpu n/a` is an ordinary outcome, not a failure.** Browsers have disabled the extension on and
  off for side-channel reasons and some drivers lack it outright, so the overlay says so rather
  than showing a zero that would read as "the GPU is free".
- **It only runs while the overlay is up.** A timer query is cheap but not free, and nothing reads
  the answer otherwise — `game.ts` skips `begin`/`end` entirely when the panel is hidden.

`FrameProfiler` (`util/profiler.ts`) is a plain per-frame timer, not tied to rendering or game
state: `beginFrame()`, any number of `time(label, fn)`/`add(label, ms)` calls (the same label can be
used more than once per frame — `game.ts`'s "Player" bucket covers both the movement block and the
later pickup/damage-floor block, non-contiguous in `frame()` — and accumulates), then `endFrame()`.

**`Music` is the one category measured outside the frame**, because the music synth renders on its
own timer in the gaps between frames (docs/music.md § Getting it to the speakers). `MusicPlayer`
accumulates what it spent and the next frame hands it over with `offFrame(label, ms)`, which counts
it towards the frame total as well as its own label — otherwise a category that never ran inside
`beginFrame`/`endFrame` would be silently subtracted from `Other`. It only appears once a track is
actually being synthesized: a container-format track costs nothing here, and `offFrame` registers no
label for a zero.

Because that work arrives in **bursts** — a chunk every pump interval, a whole lookahead at track
start — `offFrame` pools it and `endFrame` charges the pool a fraction per frame
(`OFF_FRAME_SPREAD`) instead of dumping each burst on the frame that follows it. Dumped, every burst
spiked the total, and the header's "fps eq." — which divides by that total — visibly lurched with
each one and cratered at every track start. The pool is also capped (`OFF_FRAME_PENDING_CAP`): live
play never accrues more than a pump interval's chunks between two frames, so anything bigger is a
stall's backlog — a tab hidden without the menu open keeps the synth timer running with no frame to
drain it — and is dropped the way the frame loop drops its accumulator debt, not replayed against
frames that didn't do the work. The pause path separately discards what accumulated behind the menu
(`Game.resume`), so the first frame back isn't charged for it at all.

Every label is smoothed with a plain exponential moving average rather than shown raw, the same
reasoning as `util/damping.ts`'s `dampen`: a single frame's timing is noisy (GC pauses, OS
scheduling), and an unsmoothed bar graph would flicker faster than it could be read.

**Measurement itself is not gated** — `performance.now()` calls are cheap enough not to bother
branching around, the same call the fps counter already makes. The `visible` class is the only skip,
and `ProfilerHud.update` takes the `FrameProfiler` rather than its `samples()` so that a hidden
panel does not build the array and its per-label objects every frame — which is the default outside
dev mode. `Game.debugLines` is a closure for the same shape of reason, but a DEVMODE one: its body
walks the BSP for the player's sector and must not run when the *debug* text is off.

**The checkbox alone decides whether the panel is up** — General's `Debug / Dev` section
(`#profiler-checkbox`), in every build, since the overlay covers the top-right corner of the level.
The setting is `profiler.ts`'s own (`profiler`,
`getProfilerVisible`/`setProfilerVisible`) and **defaults to `DEVMODE`**: on in a dev build, as it
behaved before the checkbox existed, off in a shipped one — a stored `true`/`false` overrides that
either way. `applyProfilerVisible` is the single writer of `#profiler-hud`'s `visible` class, called
by `ProfilerHud`'s constructor to seed it for the level starting and by the checkbox to change it
live. **That class is also what `ProfilerHud.update` early-returns on**, so a hidden panel costs no
per-frame DOM writes and the CSS and the render path can't disagree about whether the overlay is up.
`Game` owns the `ProfilerHud` directly — not `DebugHud`, which is DEVMODE's — and reads the same
setting to decide whether to run the GPU timer query at all.

`ProfilerHud` renders each category as a horizontal bar sized against one 60fps frame's budget
(16.6ms) rather than against each other — a bar reaching full width means that category *alone*
would miss the budget, a more directly actionable signal than relative proportions, and it turns
amber/red past 25%/100% of that budget so the worst offender is visible without reading the numbers.
Rows are created once per label (first-seen order) and reused after that, the same "build the DOM
once, update fields every frame" approach `Hud` uses for its icons — and re-sorted worst-first on
every `update()` via `appendChild` on the already-existing row (which reorders rather than
duplicating), so the biggest cost lands at the top without tearing anything down.
