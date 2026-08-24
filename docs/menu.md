# Menu, settings, session lifecycle and dev mode

`src/ui/menu/menu.ts`, `src/ui/menu/labels.ts`, `src/ui/menu/library.ts`, `src/ui/menu/menu.html`,
`src/ui/menu/menu.css` + `src/ui/menu/changelog.css` + `src/ui/menu/library.css`,
`src/main.ts`, `src/constants.ts: DEVMODE`, `src/ui/devmode/`, `src/util/profiler.ts`

The menu is plain DOM: every element is static markup in `src/ui/menu/menu.html` (pulled into the
page by `index.html`'s `@include` list — docs/styles.md § Assembling the page), looked up by id in
`Menu`'s field initializers, so **an id renamed in the HTML fails at construction**, not lazily. Only the WAD
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
  the fix either — an uncapped panel makes `.saves-section` grow without bound rather than scroll.

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
  `menu.closeTopOverlay()` first, which dismisses whichever overlay is up and reports whether there
  was one — so one `Esc` dismisses the popup and leaves the menu (and a paused level) alone. A
  second window listener in `Menu` would have made that depend on registration order.

`#changelog` is a child of `#menu` so it disappears with it; `close()` also closes it, or it would
still be up the next time the menu opens.

## WAD Library

The `WAD Library…` button under the add-on list opens `#wadlibrary`, a two-pane file manager over
**everything the menu can offer**: the WADs the server ships, a folder on the player's own disk, and
anything dropped on the menu. It replaced two buttons — `Load IWAD from disk…` and
`Add PWAD from disk…` — which between them could only ever add one file at a time and forgot it on
reload.

Structurally it is `#changelog`'s twin, and deliberately so (§ Changelog): a child of `#menu` so
closing the menu can never leave it up, at `z-index: 5` **local to `#menu`'s own stacking context**
rather than a rung of `base.css`'s global ladder, dismissed by its close button, by a backdrop click
guarded with `e.target === root`, or by `Esc`. `Close` sits beside `Apply` in the footer rather than
in the header: both end the same visit, so they belong to the same corner — but they are **not** the
same call (see *Ticking stages, Apply commits* below). `Esc` is **handed off explicitly** from `main.ts`, which asks
`menu.closeTopOverlay()` before closing the menu, so one `Esc` closes one thing and the answer
doesn't depend on listener registration order. The overlay order lives in `Menu`, not the caller.

What is its own:

- **Ticking stages, `Apply` commits, `Close` discards.** Every control in the file pane edits
  `LibraryUi`'s own `draftIwad`/`draftPwads` and nothing else; `Apply` hands the pair to
  `Menu.applyPicks` and closes, and every other way out — the `Close` button, the backdrop, `Esc`,
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
- **What a game WAD costs the add-ons is one function**, `library.ts: pwadsFor` — `fitsGameWad`
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
  the drop target as well as `Add single WADs…`, since `#wadlibrary` nests inside the `#menu` element
  the drop listener sits on; a file dropped *on* the open overlay is a pick in it, not a silent one
  behind it.
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
  subfolders) on screen instead of orphaning the rows nested under it. `topdoom` and the library
  root are exactly that. That is also why `selectedFolder` cannot *start* on a container row — it
  would open on an empty pane. `buildFolderTree` is pure and separate from `LibraryUi` so all of
  this is testable without a DOM.
- **A folder holding a picked WAD is highlighted**, and so is every folder above it, so a folded
  parent still says something inside it is in the set. The mark walks up `parent` from each row
  whose own `sources` contain a pick — never by id prefix, for the `library:mega` /
  `library:megawads` reason below — and lands on `.name` rather than the row, so it survives
  `.active`'s own colour.
- **The sidebar is three boxes, not one scroller**, and the panel's height is *definite*
  (`height: min(620px, 100%)`) rather than content-driven — so the overlay is the same size whether
  a library holds three WADs or three hundred. What the server ships is a fixed few rows and the
  folder buttons must stay put, so only the middle box (`#wadlibrary-tree`, the player's own
  folders — the one thing that can grow without bound) takes `overflow-y` and the leftover height.
  `Dropped on the menu` rides with the server's rows: like them it is a place the player never
  chose, and never one to scroll past their own folders to reach. **Only the two lists are framed** —
  `#wadlibrary-controls` gets no inset panel, because those buttons act *on* the library rather than
  being part of it and a third framed box made the sidebar read as three lists.
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
- The glyph is a `<span>` inside the row button, not a nested button —
  that would be invalid markup and would cost the row its single focusable control. Its click is
  stopped from bubbling, so the glyph only ever folds and the label only ever selects. Collapsing a
  folder the selection sits *under* moves the selection up to it, which costs nothing since a folder
  already lists everything beneath it. **Both the fold test and the walk up use `parent`, never an id
  prefix**: `library:mega` is a string prefix of `library:megawads` without being its parent. Every
  such walk goes through `ancestors`, over a `TreeIndex` built **once per render** and threaded down.
  Each walk used to build its own `byId` — one per row, inside a per-row `filter` — which made a
  single render quadratic in the row count, on every keystroke in the filter box. `rootedSubtree`
  is one pass for the same reason: it files each source under its own path and counts it against
  every folder above it, rather than scanning `sources` once per folder.
- **The three top-level rows start open, everything below them folded.** `LibraryUi` tracks
  *expanded* ids rather than collapsed ones precisely so the default is a property of that one set:
  a collapsed-id set could not express it, since a folder the player has never touched is absent
  from it and would read as open. The set is seeded with `SERVER_ROOT`/`LIBRARY_ROOT`/`UPLOADS` —
  folding those too would open the overlay on two or three bare headings with nothing to act on.
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
  and has nothing to fold into. A plain sort still puts every parent first: a path is a prefix of its
  own descendants, and `/` sorts below the characters that could extend a sibling's name.
- **Both of the panel's axes are fixed**: `width: 60%` of the viewport and `height: 85%` of what is
  left inside `#wadlibrary`'s own padding, so the overlay is one size whatever the library holds.
  `width`/`height`, never `max-*` — those leave the panel sized by its content and only cap it. The sidebar takes a *share* of that (`flex: 0 0 30%`)
  rather than a pixel basis, so the two panes keep their proportion at any window size, plus
  `min-width: 0` — without it a long folder name's automatic minimum size overrides the basis
  outright, and `.name` should ellipse instead.
- **The tree is the left pane, the files the right**, split into two panels whose **headings name
  the panel and count what is in it** — `topdoom built-in` and `Your Library`. Those headings
  replaced the container rows that used to sit above each list: a row that owns no files of its own
  is a poor click target, and the panel it is in already said what it was. Each heading lives
  *outside* its own scroller, or it would scroll away from the rows it names.
- **Both panels are folder trees of the same shape**, built by one `rootedSubtree`. `Game WADs` and
  `Add-ons` are rooted at `iwad/` and `pwad/` and show whatever subfolders those hold, now that the
  manifest scans them recursively (docs/wad.md § The `public/wads/` manifest); the player's library
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
- **Applying a library file gives it its content id** (`Menu.identify` → `ensureWadId` +
  `rememberLibraryId`), which the scan deliberately skipped — docs/wad.md § Content id. It is
  remembered on disk, so a file is hashed once ever rather than once per session. Deferred to
  `applyPicks` rather than paid on the tick, so trying a WAD on and thinking better of it hashes
  nothing.
- **The detail column says what a file *is*, never where it sits.** `describeSource` used to append
  a library file's subfolder; the row is already under that folder in the tree, so repeating it only
  crowded the column. An upload's `from disk` stays, since it belongs to no folder at all.
- **A file row is six columns** — name, badge, size, contents, DEHACKED, support — with the name
  taking the slack and the rest fixed-width and right-aligned, so sizes line up under sizes and map
  counts under map counts rather than each trailing whatever length its file name happened to be.
  `labels.ts: sourceColumns` returns the three detail values separately and `sourceColumnSpans`
  renders them plus the support glyph, and **both lists use both** — the add-on rows on the New Game tab carry the same
  columns, just narrower, since that panel is 620px against the overlay's 60% of the viewport. The
  markup is shared too, not just the strings: the `meta size`/`meta content`/`meta deh`/`meta
  support` class names the two stylesheets target have one definition, and `#wadlibrary` nests
  inside `#menu` so its rows inherit `#menu .row` outright — `library.css` carries only the deltas.
  So the two cannot disagree about what a file *is*, only about how much space there is to say it.
  (`describeSource` joins the same values and is now only the game-WAD select's one-line label; the
  support verdict is deliberately not in it, being a glyph rather than text.) The badge **leads** the fixed-width block, ahead of
  the size: what it carries is the reason a row can't be picked, which has to be read before the
  file's stats rather than after them. It is rendered **even when it says nothing**, or every column
  behind it would land somewhere different on each row, which is the whole thing they exist for.
- **The last column says whether the file will run at all** — a green tick, an amber warning or a
  red cross, with the reasons and the maps that raise them in its tooltip. The verdict itself is
  `wad/support.ts`'s and is decided when the file is *described* (docs/wad.md § Will it run?), not
  here: it rides in on `WadSource.support` for a server file, an upload and a library file alike, so
  the same WAD cannot read differently in the three places it can come from. The menu's job is the
  glyph and the colour — and drawing **nothing** where there is no verdict, since absent is unknown
  rather than fine. The glyphs take `U+FE0E` for the reason the folder tree's do; the colours are
  docs/styles.md § Tokens.
- **A file with nothing left to load is greyed out**, game WAD and add-on alike, and carries
  `won't load` in the badge column. The rule is `support.ts: nothingLoads`, deliberately **narrower
  than the red glyph**: a megawad with one UDMF map among thirty-one that work still shows the red
  cross, and is still perfectly pickable — refusing the whole file over one map would lock the
  player out of the rest of it. Only a file whose *every* map is refused is unpickable, and a
  map-less add-on never is, having nothing that could fail to load.
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
- **The filter box in the header matches folder names as well as file names** (`filterTree`, pure and
  tested without a DOM). A row survives if its own name matches, if a folder above it matched, or if
  it holds a matching WAD at or below it — so searching for a file still shows the folders it lives
  in. A folder matched **by name** lists *entire* rather than having its contents filtered a second
  time, and hands that down to everything nested inside it: asking for a folder by name is asking
  for what's in it. Three things follow that are easy to miss:
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
second picker that has to agree with the first about what is compatible. Each row is checkbox ·
name · [reason] · size · contents ·
DEHACKED · support · `#N` · `×` — the same detail columns the overlay lists, narrower — and the two controls
mean **different things**:

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
  disagree about what a level is called. The same pass reports
  every file of the set the library can no longer supply, one line per file — matched
  by *content id* (`resolveSaveWads`, the same call the load path makes), so a renamed WAD is not
  reported and a file whose bytes have changed reads `Different IWAD/PWAD: …` rather than
  `Missing IWAD/PWAD: …`, which would send the player looking for something they already
  have. A file the load actually needs back (the game WAD, or the map's provider) is a subtle red
  warning; the rest are the same line in amber (`.caution`), because they are still a file the save
  was made with and no longer has — just not one that blocks the load, which is what the red says. **The line is `missingWadLabel`, not the full sentence**: every
  line in the label column is `white-space: nowrap` with an ellipsis, so the rows keep one height
  beside the thumbnails, and the column is only ~55 characters wide at 12px (620px menu, less the
  thumbnail and the row's three buttons). The sentence saying what to *do* — `missingWadText` — goes
  on that line's `title` and is what a failed Load throws into the status line, both of which have
  the width for it (docs/savegames.md § WAD-set identity). **A row missing a *required* file greys
  its Load button out**, the same courtesy Save and Overwrite get for a refused moment — the red
  line beside the button is the reason, since a disabled button shows no tooltip. A row missing only
  optional files keeps Load live, because that load works. `addFiles` re-renders the save lists as well as the WAD lists, so
  bringing that file back clears the warning on the spot rather than on the menu's next `open` —
  which is also why `Menu` keeps the last `inGame` it was opened with.
- **The name in each row is an `<input>`** — renaming happens in place (`renameSave`), Enter or blur
  commits, Esc reverts and is stopped from bubbling to `main.ts`'s menu-closing handler. An untouched
  field re-renders nothing, so a plain focus-and-blur can't pull the row out from under a click
  heading for one of its own buttons. Nor does a *successful* rename, or a delete: both patch the
  visible list (the input's own value, `row.remove()`) and only mark the other tab's list stale.
  Re-listing rebuilds every row — one thumbnail decode and one `describeSave` each — to redraw one
  string, the cost worth avoiding on the one path a player repeats. (A rename also never rewrites
  the save's state record: `renameSave` puts the meta alone.) It also means nothing may bake a
  save's name into a row's other elements — the Overwrite tooltip says "this save" for that reason.
- **The save lists fill the panel vertically**: `.saves-section` is the tab panel's flexible child
  and the list is the section's, against a `#menu > .panel` capped at the viewport — so the rows use
  whatever height is left and scroll inside the menu instead of growing it off-screen. Because the
  tab panels share one grid cell, that height is the tallest panel's on every tab, as before.
- An **unsupported version** renders dimmed via its own `unsupported` class rather than `.disabled`
  (a child can't undo a parent's opacity, and its download/delete buttons must stay live); only
  Load is refused.
- **Delete and Overwrite confirm by being held** (`hold.ts: confirmOnHold`, `HOLD_MS` — shared with
  the WAD Library's Forget, and styled by the class alone in `hold.css` so any `#menu` button can
  wear it): a bar sweeps the
  button and the action fires when it lands, letting go early cancels and says so in the status line.
  An inline confirm, so the changelog stays the menu's only popup — and one gesture rather than the
  two-click arm it replaced, which read as a broken button. The sweep is a CSS transition whose
  duration is handed over as `--hold-time`, so the bar and the timer can't disagree; the label moves
  into a `.label` span so the `.fill` can paint behind it, and Space/Enter held on a focused button
  works the same way. Both are per row; Overwrite refills that save
  from the current moment, keeping its id and its name (renaming has its own affordance). Delete and
  download are icon-only buttons (`⤓`, `🗑︎` with
  a text-presentation selector) with their meaning in the tooltip; Load and Overwrite are `.primary`.
- **Download** writes the save as `<map>-<date>.topdoom.json` through a temporary anchor: one
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
  thumbnail decode and one `describeSave` per row, and `open()` runs on every `Esc` pause and once
  at boot — a player who never opens Save or Load must not pay for the rows at all. `renderVisible`
  is async (the listing awaits IndexedDB) and guards itself with an epoch ticket: a refresh or tab
  switch while a listing is in flight starts a newer render, the older one discards instead of
  painting over it, and `stale` is cleared only by the render that painted — a discarded render
  leaves its tab marked for the next look. `Menu.mapCache` memoizes `mergedMaps` per WAD set for
  the same reason as the laziness: `describeSave` needs a level title per row, and the rows share a
  handful of sets.

## Picking a WAD set

The lists are fed by `/wads/index.json` (docs/wad.md § The `public/wads/` manifest) plus anything
loaded from disk. Semantics worth knowing before touching `menu.ts`:

- **Game WAD** (`renderIwads`) only offers sources with `type === 'IWAD'`. A PWAD mapset can still be
  *played* as the game WAD (dropped on the menu, or `?wad=`), but it doesn't appear in this list to
  pick from directly.
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
  selected game WAD (`library.ts: fitsGameWad`, over `mapStyle` — see docs/wad.md § The
  `public/wads/` manifest for what style means) is rendered **disabled** rather than hidden — a
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
  takes, and the only thing every map has. The label itself is `ui/menu/labels.ts`'s `describeMap`, shared
  with the save rows (§ Save and Load tabs) so a level can't be named two ways in one menu.

## Difficulty

**Difficulty lives on the New Game tab, not the Settings tab** — it belongs with the WAD and level,
the other two things a start is composed of, and unlike volume and autorun it can't apply live: a
running `Game` holds the skill it was constructed with, and most of what the skill decides — which
things spawn at all, and which stat table the monsters run on (docs/monster-ai.md § Fast monsters)
— is resolved once per level in `game/things.ts: buildThingSprites`, so changing it mid-level would
silently do nothing until the next load. It shares a row with Level (`.columns even`, § Settings
tab below).

`#skill-select` is filled once from `SKILL_NAMES` and seeded from `topdoom.skill`; a change writes
that key back, so the next visit opens on the last skill played. **What a start actually runs at is
`currentSkill()`, read off the select, not off storage** — where `localStorage` is unavailable the
write goes nowhere and reading it back would silently ignore the player's pick. `submit()` (the
`?map=` deep-link path) reads the same getter, which is the stored skill there since nothing has
touched the control.

## Settings tab

The tab is split in four by its own row of **sub-tabs** (`.tabs.subtabs` inside `#tab-settings`,
`Menu.setSettingsTab`): **Visuals** holds everything that changes how the running level looks,
**Audio** everything you hear, **Controls** the key list and everything bound to it, and **General**
what is left — the settings that are none of the three. The sub-panels are the same
`.tab-panels`/`.tab-panel` grid-cell stack the top-level tabs use, nested one level — so Audio being
much shorter than Controls costs the menu no resize when the player switches, exactly as above. The sub-tab row is
styled a step quieter (smaller type, no rule under it) so it doesn't read as a second tab bar of
equal rank, and like the tabs above it the pick survives an `open`.

**Controls is mostly the full key list, and it is the only one the game itself shows** — it replaced
two hint lines in the DEVMODE status text, which meant a shipped build listed its controls nowhere.
Being a menu tab makes it reachable mid-level too, since the menu is the pause screen. README's table
is the fuller reference.

**The control-shaped settings live inside that list rather than in sections of their own**, because
what they change *is* a key's behavior: the right button's binding is the `right mouse` row's
description, the autorun checkbox is the `Shift` row's. A player looking up what a control does and a
player changing it are the same person on the same trip to the menu — which is why those two did not
move to General with the rest.

**General is what is left once the other three have taken theirs**: Level start over Collision,
stacked full width, with `#settings-dev` following them in a dev build. Level start leads because
it is the one of the two a player picks *before* a run rather than sets once and forgets.

**Visuals is Camera, Frame rate, Lighting** — everything that changes what the running level *looks*
like, in that order: the camera first, being the one a player actually goes looking for.

**Camera** is `#cameramode-select`, whose `<option>` values are the `CameraMode` strings themselves
(`auto`, the default, vs `manual`); it is owned by `game/autocamera.ts`
(`getCameraMode`/`setCameraMode`) and read per tic, so a change applies to the level already running
(docs/render.md § Auto camera). It sits here rather than in the Controls key list because the mode
is not a key's behavior — the `+ - [ ]` rows there note they act in manual mode only.

The frame limit is `#fpscap-select`, and its `<option>` values *are* the capped rates
(`0` = unlimited, the default), so the control needs no mapping table. It is owned by `game.ts`
(`getFpsCap`/`setFpsCap`), whose frame loop is the only thing it changes, and is read live per frame
— changing it mid-level applies to the level already running, like volume and autorun. See
docs/frameloop.md § The FPS cap for how a cap is actually held. Lighting is the one
`#dynlights-checkbox`, on by default and likewise read per frame, so it too takes effect without a
reload (docs/lights.md § The toggle).

**Audio is one Volume section of three sliders** — `General` (`#master-volume-slider`, the master),
`Effects` (`#volume-slider`) and `Music` (`#music-volume-slider`) — each with a `.label` wide enough
that the three line up. Master **first**: it is the one that moves the other two, so reading down
the section is reading the signal path. It rides the `master` gain node the two channel buses hang
off, and 0 on it stops both of them the way each channel's own 0 stops itself
(docs/audio.md § Volume and the context). The master and sfx sliders preview themselves with
`itemup` as they are dragged; the music slider needs no preview, riding the track already playing
behind the menu (docs/music.md § Volume).

**Collision** is one checkbox, `Infinite tall actors (vanilla)` — off by default (docs/movement.md
§ Collision); `Level start`'s `Pistol start every level` is the other (docs/items.md § Pistol
start). What is left on General is exactly the two settings that change how the game *plays*, which
is why neither belongs on the three tabs beside it. It applies to the level already running, like volume and the cap:
`blockedByThings` reads the flag per call.

General ends with **`#settings-dev`, a DEVMODE-only section holding the profiler overlay's
checkbox** (§ Profiling overlay), revealed by the same set-once toggle `#controls-dev` gets. Its
`.hidden` is `display: none` for the same reason: a hidden section must leave the flow rather than
hold a gap under Collision.

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
`#controls-dev`, the `N`/`P` map-jump row, which the constructor reveals when `DEVMODE` is set (as
it does `#settings-dev` on General). `DEVMODE` can't change at runtime, so neither is ever
re-checked. **`#controls-dev.hidden` is `display: none`, not the `visibility` the tab panels use** —
a panel has to keep reserving height, but a hidden section must drop out of the `.columns` flex line
entirely.

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
| `topdoom.masterVolume` | `audio/audio.ts` | docs/audio.md § Volume and the context |
| `topdoom.sfxVolume` | `audio/audio.ts` | docs/audio.md § Volume and the context |
| `topdoom.musicVolume` | `audio/music.ts` | docs/music.md § Volume |
| `topdoom.autorun` | `game/player.ts` (`getAutorun`/`setAutorun`) | docs/movement.md § Movement speed and straferunning |
| `topdoom.rightMouse` | `game/input.ts` (`getRightMouseAction`/`setRightMouseAction`) | § Right mouse button above |
| `topdoom.cameraMode` | `game/autocamera.ts` (`getCameraMode`/`setCameraMode`) | docs/render.md § Auto camera |
| `topdoom.fpsCap` | `game.ts` (`getFpsCap`/`setFpsCap`) | docs/frameloop.md § The FPS cap |
| `topdoom.profiler` | `ui/devmode/profilerhud.ts` (`getProfilerVisible`/`setProfilerVisible`) | § Profiling overlay below |
| `topdoom.dynamicLights` | `render/lights.ts` (`getDynamicLights`/`setDynamicLights`) | docs/lights.md § The toggle |
| `topdoom.infiniteTallActors` | `game/world.ts` (`getInfiniteTallActors`/`setInfiniteTallActors`) | docs/movement.md § Collision |
| `topdoom.pistolStart` | `game/inventory.ts` (`getPistolStart`/`setPistolStart`) | docs/items.md § Pistol start |
| `topdoom.skill` | `ui/menu/menu.ts` | § Difficulty above |
| `topdoom.selection` | `ui/menu/menu.ts` | § Remembered selection below |
| `topdoom.bestTimes` | `game/besttimes.ts` | docs/hud.md § Best times |
| `topdoom.save.<id>` | `game/savegames.ts` | docs/savegames.md § Storage |

The player's WAD folder is the one persisted thing here that is **not** a `topdoom.*` key: a
directory handle can't go through `JSON.stringify`, so it lives in its own IndexedDB database —
docs/wad.md § The player's own library.

`topdoom.save.<id>` (one key per save) is the one departure from per-value structural validation:
it carries an explicit `version` field, refused on mismatch rather than half-read. A settings
scalar degrades safely to its default; a save's schema genuinely evolves, and half-reading an old
one restores a subtly wrong level (docs/savegames.md § The format and its version).

## Remembered selection

`topdoom.selection` holds `{ iwad, pwads, map }` as `WadSource.key`s. Precedence when `init` resolves
it is **URL > stored > first IWAD on offer**, and every key is resolved against the current library,
so a WAD that has since left `public/wads/` is silently dropped (an unknown map falls back to the
set's first, via `selectLevel`'s no-op). Restoring can pair a stored add-on with a `?wad=`-forced
game WAD it doesn't suit; that pick is **kept**, refused rather than dropped, so the stored set
survives a deep link (§ Picking a WAD set).

`saveSelection` is called from the sites where the *player* changes something (`selectIwad`, the
add-on toggle, `addFiles`, the level select's `change`) and **deliberately not from `render`**, which
`init` also runs while restoring: hooking it there wrote the level select back before `selectLevel`
had applied the stored map, so the stored level decayed to the set's first map after one reload.

It **never writes an upload.** Those bytes are gone after a reload, so storing the key would restore
a selection that can never load; leaving the last restorable one in place is better. As a
side-effect, a failed manifest (no sources at all, `selectedIwad` null) can't wipe a good stored
value either. A **library** file is stored like a server one — its key is `lib:<relative/path.wad>`,
which is stable across visits precisely because the folder is remembered
(docs/wad.md § The player's own library), so a picked mapset survives a reload. Where the browser
can't remember the folder, `init` restores nothing from it and the stored keys simply don't resolve,
which is the same silent drop a WAD that has left `public/wads/` gets.

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

- **The page boots showing `#loading`, not the HUD.** Every other overlay is in the markup already
  `hidden`; the boot screen (`ui/loading.html`) is the one that starts visible, because the static
  HUD markup would otherwise be what the player sees — placeholder `100` health over an empty
  level — for as long as the WAD manifest takes. `boot` takes it down at exactly one point, after
  whatever replaces it is up: the menu, or a `?map=` level, which is why that branch **awaits**
  `menu.submit()` — the deep link never opens the menu, so the boot screen is also what covers its
  WAD load. The failure path needs no call of its own: `#fatal-error` is a rung above `#loading`.
- **`new Viewport` is wrapped in `try`/`catch`** and routed to `#fatal-error`: three.js throws a raw
  `Error` when the browser can't create a WebGL2 context, and without this the page is left sitting
  on `Loading …` forever, which reads as "hung" rather than "your browser can't run this". The
  GPU-specific message is only shown when the error actually looks like a WebGL failure, so an
  unrelated bug isn't misreported as a GPU problem.
- **A finished campaign ends the session.** `Game` takes an `onCampaignEnd` port beside its
  checkpoint store, called when the end card's continue key has nowhere left to go (docs/hud.md
  § End card). `endSession` nulls `game` *before* disposing it — the call arrives from inside that
  very `Game`'s tic — and reopens the menu with `open(false)`, as a launcher: there is no returning
  to a run that is over.
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
- **A load is the same `startLevel`**, given the save as a second argument: it verifies the assembled
  set's game WAD and map provider against the save's own ids (`verifySaveWads`, over
  `wadSetRefusal` — docs/savegames.md § WAD-set identity) and hands
  `Game` the snapshot instead of `?pos=`. Everything above — the audio gesture, the dispose ordering,
  the failure re-sync — is one copy, so a lifecycle fix can't reach the new-game path and miss the
  load path. `loadSave` only re-resolves each `wads` entry to a `WadSource` by content id first, and a
  *required* file the library can't supply fails *there*, before anything is torn down, so the running
  level survives a load that can't happen; an add-on that supplied neither the map nor the game WAD is
  left out of the set instead.
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
needed). It gates five things — three in `ui/devmode/` and two in `ui/menu/menu.ts` — all because a
player has no legitimate reason to reach for them:

- **The debug overlay** (`DebugHud.update`, whose lines come from `Game.debugLines`) — off, `#hud`
  shows only the fps counter; on, the full
  map/pos/sector/camera-state/awake-monster-count block. **Everything it prints is live state.** It
  used to end with two static hotkey hint lines as well, which were the game's only controls
  reference and so invisible to exactly the players who needed them; that list is now the menu's
  Settings tab (docs/menu.md § Settings tab).
- **The profiling overlay** (`#profiler-hud`, below) — shown when `DEVMODE` *and* its checkbox agree.
- **The Settings tab's `#controls-dev` section**, the only place `N`/`P` is listed in the UI —
  revealed once in the `Menu` constructor, so a shipped build never advertises a key it ignores.
- **The General sub-tab's `#settings-dev` section**, the profiler checkbox — revealed by that same
  constructor line, for the same reason.
- **`N`/`P` (jump to next/prev map)** in `handleHotkeys` — behind the early-return on `!DEVMODE`, so
  they are simply inert outside dev mode. `+`/`-` (camera distance) and `[`/`]` (camera tilt)
  deliberately sit *ahead* of that gate: they are player-facing framing controls, not debug state,
  and gating them only meant a shipped player couldn't adjust how much of the level fits on screen.

`Game.debugLines` reports `ThingLayer.awakeMonsterCount()` — the number of living monsters
currently alerted (chasing/attacking, or mid-`reactionTicks` delay) — useful for judging whether a
level's population has actually noticed the player.

## Profiling overlay

A third DEVMODE-gated panel, top-right, breaks a frame's cost down by category — `Specials`, `Player`,
`Weapons`, `Fog of War`, `Monsters`, `Effects`, `Fading`, `Render`, `Music`, plus an `Other` bucket for
whatever wasn't explicitly measured (input handling, HUD text, the player sprite's own pose) — so a slow
frame can be traced to *which* system is responsible rather than just how many fps it costs.

**Every row is CPU; the GPU gets one number of its own.** The rows and their total time main-thread
wall clock between `beginFrame()` and `endFrame()`, both inside the same `requestAnimationFrame`
callback — which cannot see the GPU, whose work finishes long after that callback returns. That is
why the total says `cpu`, and why the overlay carries a second line:

```
cpu 4.5 ms  (220 fps eq.)
gpu 20.1 ms  (49 fps eq.)
```

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
- **A *disjoint* drops the whole batch.** The GPU having been reset invalidates every query in
  flight, not one of them, and reading the flag is what clears it — so it is read once per harvest
  and every result in that pass is discarded when it is set.
- **`gpu n/a` is an ordinary outcome, not a failure.** Browsers have disabled the extension on and
  off for side-channel reasons and some drivers lack it outright, so the overlay says so rather
  than showing a zero that would read as "the GPU is free".
- **It only runs while the overlay is up.** A timer query is cheap but not free, and nothing reads
  the answer otherwise — `game.ts` skips `begin`/`end` entirely when the panel is hidden.

`FrameProfiler` (`util/profiler.ts`) is a plain per-frame timer, not tied to rendering or game state:
`beginFrame()`, any number of `time(label, fn)`/`add(label, ms)` calls (the same label can be used more
than once per frame — `game.ts`'s "Player" bucket covers both the movement block and the later
pickup/damage-floor block, non-contiguous in `frame()` — and accumulates), then `endFrame()`.

**`Music` is the one category measured outside the frame**, because the music synth renders on its own
timer in the gaps between frames (docs/music.md § Getting it to the speakers). `MusicPlayer` accumulates
what it spent and the next frame hands it over with `offFrame(label, ms)`, which counts it towards the
frame total as well as its own label — otherwise a category that never ran inside `beginFrame`/`endFrame`
would be silently subtracted from `Other`. It only appears once a track is actually being synthesized:
a container-format track costs nothing here, and `offFrame` registers no label for a zero.

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
reasoning as `util/damping.ts`'s `dampen`: a single frame's timing is noisy (GC pauses, OS scheduling),
and an unsmoothed bar graph would flicker faster than it could be read.

**Measurement itself is not gated behind `DEVMODE`** — `performance.now()` calls are cheap enough not to
bother branching around, the same call the fps counter already makes. Only the DOM panel's visibility
and whether `DebugHud.update` bothers pushing samples to it are. `Game.debugLines` is passed as a
closure for the same reason: its body walks the BSP for the player's sector, and must not run when
the panel is off.

**The panel can be switched off inside a dev build too**, from the General sub-tab's dev section
(`#profiler-checkbox`), since the overlay covers the top-right corner of the level. The setting is
`profilerhud.ts`'s own (`topdoom.profiler`, `getProfilerVisible`/`setProfilerVisible`) and
**defaults on**, so a dev build behaves as it did before the checkbox existed; only an explicit
`'0'` hides it. `applyProfilerVisible` is the single writer of `#profiler-hud`'s `visible` class —
`DEVMODE && getProfilerVisible()` — called by `DebugHud`'s constructor to seed it and by the
checkbox to change it live. **That class is also what `ProfilerHud.update` early-returns on**, so a
hidden panel costs no per-frame DOM writes and the CSS and the render path can't disagree about
whether the overlay is up.

`ProfilerHud` renders each category as a horizontal bar sized against one 60fps frame's budget (16.6ms)
rather than against each other — a bar reaching full width means that category *alone* would miss the
budget, a more directly actionable signal than relative proportions, and it turns amber/red past
25%/100% of that budget so the worst offender is visible without reading the numbers. Rows are created
once per label (first-seen order) and reused after that, the same "build the DOM once, update fields
every frame" approach `Hud` uses for its icons — and re-sorted worst-first on every `update()` via
`appendChild` on the already-existing row (which reorders rather than duplicating), so the biggest cost
lands at the top without tearing anything down.
