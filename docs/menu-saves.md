# The Save, Load and Replays tabs

`src/ui/menu/savegames.ts`, `src/ui/menu/replays.ts`, `src/ui/menu/actions.ts`,
`src/ui/menu/hold.ts`, `src/ui/menu/savegames.css` + `replays.css`

The three tabs that list what a player has stored. The formats behind them are docs/savegames.md
and docs/replays.md; the menu they sit in is docs/menu.md.

## Save and Load tabs

`ui/menu/savegames.ts` (`SavegamesUi`) renders both panels over the `game/savegames.ts` store; the
format, apply order and WAD-identity rules are docs/savegames.md's. What is the menu's own:

- **The Save tab exists only mid-game** — `open(inGame)` hides its button with `display: none`
  (the button must leave the flex row, not hold a gap) and moves anyone
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
  the thumbnails, and the column is short — the panel's width, less the thumbnail and the row's
  three buttons. The sentence saying what to *do* — `missingWadText` — goes on that
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
  listing and redraws the tab from it: the store read is the part `rename` avoids, and a delete
  needs none, the thumbnails coming back from the browser's own image cache. (A rename also never
  rewrites the save's state record: `renameSave` puts the meta alone.) It also means nothing may
  bake a save's name into a row's other elements — the Overwrite tooltip says "this save" for that
  reason.
- **The save lists fill the panel vertically**: `.list-section` is the tab panel's flexible child
  and the list is the section's, so the rows use whatever height is left and scroll inside the menu
  instead of growing it off-screen — docs/menu.md § Panel sizing.
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
  that only destroys something some of the time (Start new game, docs/menu.md § One screen, two
  jobs, **Load**, which throws the running level away exactly as a start does, and a replay's
  **Play**, § Replays tab) wears the same
  confirm and acts on a plain click while the predicate says no; the tooltip follows the hold, so
  from the launcher — and over a replay, which costs nothing to leave — Load carries none. The
  predicate is the same one for all three: `MenuSession` is `'game'`. Both are per row; Overwrite refills that save from
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
  are `main.ts`'s (docs/session.md § Session lifecycle), which owns the `Game` instance and
  the selection the save records; the first two share one `withCapture` body, which hands its store
  call to `Game.saveVia` — the capture, the write and what a stored save makes `R` reload all belong
  to `Game` (docs/death.md § Player death), so the session layer contributes only the writer. A
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
- **The split asks for a fixed height** (`flex: 1 0 auto` over a `height`, the list's own basis
  plus its button) and grows from there — the `.saves` rule, docs/menu.md § Panel sizing. Without it
  the detail panel's content set the *menu's* height: a replay carrying a two-line warning made this
  tab taller than every other one, so switching to it grew the menu. The panel scrolls instead.
- **A replay that cannot be played says why, in red**, where the Load list only greys the button and
  notes the version in its meta line: `ReplayListEntry.refusal` is the sentence `readReplay` would
  have thrown, printed in the panel beside the Play it greys, with the missing-file lines under it
  (docs/replays.md § Storage). Its list row is dimmed by colour and carries the same sentence on its
  tooltip — a row is not a button, so a tooltip is readable there.
- **Play is held to confirm over a run of the player's own** (`required`, § Save and Load tabs):
  starting a replay tears the session down exactly as Load does. Over a replay it is a plain click —
  the one being watched is still in the store.
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
  end tears the `Game` down (docs/session.md § Session lifecycle).
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
