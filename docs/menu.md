# Menu, settings and session lifecycle

`src/ui/menu.ts`, `src/ui/menu.css`, `index.html`'s `#menu`, `src/main.ts`

The menu is plain DOM: every element is static markup in `index.html`, looked up by id in `Menu`'s
field initializers, so **an id renamed in the HTML fails at construction**, not lazily. Only the WAD
lists, the level list and the difficulty rows are built in JS.

## One screen, two jobs

`Menu` is both the launcher and the pause screen. `open(inGame)` is what distinguishes them:

- `inGame` puts the `ingame` class on `#menu`, swapping the opaque radial gradient for a translucent
  dim so the frozen level shows through (`Game` keeps drawing it — docs/render.md § Pausing), and
  reveals **Return to game**. Both are off before any level is loaded: there is nothing behind the
  menu then but the static HUD markup with placeholder values, which the opaque gradient exists to
  hide.
- The active tab is *not* reset on open — it's whichever the player last clicked (`files` on the
  first open, set in the constructor). Reopening mid-level to change one setting must not throw away
  the tab they were on.
- Both tab panels are stacked in **one CSS grid cell** and hidden with `visibility`, not
  `display: none`, so the panel's height is always the taller of the two and switching tabs doesn't
  resize the menu under the cursor.

`Esc` unwinds one layer per press: difficulty prompt → menu → game. `main.ts`'s handler asks
`dismissDialog()` first, which reports whether it actually had a dialog to close. With the menu open
and no level loaded, `Esc` does nothing — there is nothing to return to.

Overlay stacking (`menu.css`): screen tint / pain flash `5`, HUD `10`, `#death-overlay` `15`,
`#menu` `20`, `#skill-dialog` `21`, `#fatal-error` `30`. The dialog's own backdrop is what makes the
panel behind it unclickable, so nothing else needs disabling.

`VERSION` (`constants.ts`) is shown bottom-right, prefixed with `v`; a static credit sits
bottom-left.

## Picking a WAD set

The lists are fed by `/wads/index.json` (docs/wad.md § The `public/wads/` manifest) plus anything
loaded from disk. Semantics worth knowing before touching `menu.ts`:

- **Game WAD** (`renderIwads`) only offers sources with `type === 'IWAD'`. A PWAD mapset can still be
  *played* as the game WAD (uploaded through the IWAD picker, or `?wad=`), but it doesn't appear in
  this list to pick from directly.
- **Add-ons** (`renderPwads`) excludes anything of `type === 'IWAD'` and whichever source is
  currently the game WAD (even a PWAD-typed one uploaded through the IWAD picker) — otherwise it
  would show up twice. Order matters and is the order they were ticked: it's the merge order, so the
  rows carry a `#N` badge.
- Files dropped on the window or picked from disk are parsed in the browser and behave identically to
  server-side ones. **The picker decides, not the signature**: a file uploaded via "game WAD" becomes
  the game WAD regardless of its declared type, one uploaded via "add-on" is added as an add-on.
- **Add-ons are filtered by game.** An add-on whose own map style conflicts with the selected game
  WAD's (`library.ts: mapStyle`, see docs/wad.md § The `public/wads/` manifest for what style means)
  is rendered **disabled** rather than hidden — a mapset that's simply for the other game is still
  worth seeing, just not pickable. Switching game WAD calls `pruneIncompatiblePwads` to drop any
  already-ticked add-on that no longer matches, so the merged map list (`mergedMaps`) never silently
  mixes an E1M1 with a MAP01 mapset.
- The **Level** list groups DOOM 1's `ExMy` maps by episode and names the provider only when an
  add-on took a map over.

## Difficulty prompt

**Difficulty is asked at New game, not kept in Settings.** `#skill-dialog` is a modal over the panel
and each skill is a **button that starts the level directly** — no confirm step, since picking a
difficulty is the decision. The click writes `topdoom.skill`, which is what the prompt highlights and
focuses next time, so Enter repeats the last skill played.

`submit()` (the `?map=` deep-link path) goes straight to `startWithSkill(storedSkill())` — a link
that skips the menu must not stop at a prompt.

Difficulty is the only setting handled this way. Volume and autorun apply live from the Settings tab;
skill can't, because it only takes effect where things are spawned (`game/things.ts:
buildThingSprites`), so it would silently do nothing until the next level load.

## Persisted settings

Every persisted value uses a `topdoom.*` `localStorage` key, read through `globalThis.localStorage?`
(so nothing here breaks in a non-DOM context) and **validated on read with an explicit default** —
`Number(null) === 0` otherwise makes "never set" indistinguishable from "silent"/"skill 0". Each
value is owned by the module whose behavior it changes, and the menu only wires the control to that
getter/setter; the exceptions are skill and the WAD selection, which belong to the menu itself.

| Key | Owner | Documented in |
|---|---|---|
| `topdoom.sfxVolume` | `audio/audio.ts` | docs/audio.md § Volume, mute, and the context |
| `topdoom.autorun` | `game/player.ts` (`getAutorun`/`setAutorun`) | docs/movement.md § Movement speed and straferunning |
| `topdoom.skill` | `ui/menu.ts` | § Difficulty prompt above |
| `topdoom.selection` | `ui/menu.ts` | § Remembered selection below |

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
  replace rather than append, and per-level screen state must be cleared — see docs/items.md
  § The HUD and § Screen effects.
