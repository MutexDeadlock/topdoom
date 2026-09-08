# The WAD Library and picking a set

`src/ui/menu/library.ts`, `src/ui/menu/wadinfo.ts`, `src/ui/menu/labels.ts`,
`src/wad/library/defs.ts`, `src/ui/menu/library.css` + `wadinfo.html` + `wadinfo.css`

Where the menu's WADs come from, how a set is assembled, and what refuses a pick. The menu around
it — the overlay rules every popup here follows, and the panel sizing — is docs/menu.md; what a WAD
file *is* before any of this, and where the manifest and the player's own library come from, is
docs/wad.md.

## WAD Library

The `WAD Library…` button under the add-on list opens `#wadlibrary`, a two-pane file manager over
**everything the menu can offer**: the WADs the server ships, a folder on the player's own disk, and
anything dropped on the menu. It replaced two buttons — `Load IWAD from disk…` and
`Add PWAD from disk…` — which between them could only ever add one file at a time and forgot it on
reload.

Structurally it is `#about`'s twin, and deliberately so (docs/menu.md § About): a child of `#menu`
so closing the menu can never leave it up, at `z-index: 5` **local to `#menu`'s own stacking
context** rather than a rung of `base.css`'s global ladder, and dismissed the three ways every
overlay is (docs/menu.md § The overlays over the menu). `Close` sits beside `Apply` in the footer
rather than in the header: both end the same visit, so they belong to the same corner — but they are
**not** the same call (see *Ticking stages, Apply commits* below).

The rest of this section is what the overlay owns: the draft, the tree, the two panes, the rows,
the filter, choosing a folder, and the one status line.

### The draft

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
### The folder tree

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
### The panel and its two panes

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
### The file rows

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
### The filter

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
### Choosing a folder

- **`Choose folder…` carries the primary weight until it has been used.** With no folder set it is
  the only control in that panel that does anything and the panel above it is empty; once there is a
  folder to change it drops back to a ghost like its neighbours.
- **Everything that acts on the folder itself is one row** under the tree — Change, Rescan, Forget —
  because all three are decisions about the same object; only `Add single WADs…`, which is about
  loose files sitting in no folder at all, stands apart below it. `Rescan` re-walks the folder,
  picking up files added since, and the memo makes unchanged files cost nothing.
- **Forget is a press-and-hold** (`hold.ts: confirmOnHold`, docs/menu-saves.md § Save and Load
  tabs), and has no click handler at all — the hold is the only way in. It is the one destructive
  button in that row and it sits between two harmless ones, so a stray click has to cost nothing.
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
### The status line

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

### The Add-ons list on the New Game tab

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
  `Menu.overlays` for the same reason (docs/menu.md § The overlays over the menu).
- **The read is per-open and cancellable by the next one.** `WadInfoUi.token` rises on every open
  and on close; a read that lands under a stale token is dropped, so a second file opened while the
  first is still in flight is not overwritten by it, and nothing lands in a closed popup.
- **The reader does not wrap** (`white-space: pre`). These files are laid out at a fixed column
  width, and wrapping them costs the banners and tables their alignment — a long line scrolls
  sideways instead. The panel's size is fixed on both axes, so it doesn't resize between
  `Loading …` and the file.

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
  shared with the save rows (docs/menu-saves.md § Save and Load tabs) so a level can't be named two
  ways in one menu.
