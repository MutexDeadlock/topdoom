# Cheat codes

`src/game/cheats.ts`, `src/game/input.ts: Input.typed`, `src/game.ts: applyCheats`,
`src/game/player.ts: noclip`

Three of vanilla's cheats are in: **IDDQD**, **IDKFA** and **IDCLIP**. Each does what
`st_stuff.c`'s `ST_Responder` does with it, and prints `d_englsh.h`'s own response in the center
message (docs/hud.md § Center messages) — a line a DEH/BEX patch can replace by mnemonic
(docs/dehacked.md § Cheat responses).

Vanilla's other codes — `IDFA`, `IDBEHOLD*`, `IDCLEV`, `IDMUS`, `IDMYPOS`, `IDCHOPPERS` — are not
implemented. Their `STSTR_*` strings stay classified as having no target here.

## Typing a code

A cheat is *typed*, not bound: `Input` collects the printable characters of each `keydown` (the
`e.key` character, so a QWERTZ keyboard's `z` is a `z` and not `KeyY`'s `y`), skipping any press
with Ctrl/Alt/Meta held and any press aimed at a focused form control. `Input.typed()` hands the
tic what accumulated, and `endTic` clears it along with the other edge latches — so the cheat
buffer runs on the tic like every other input (docs/frameloop.md § Input runs on the tic).

`Cheats.type` appends those characters to a rolling buffer capped at the longest code and fires the
first code the buffer ends with, then clears it. That is more forgiving than vanilla, whose
per-cheat cursor resets to the start of its sequence on any mismatched key *and* swallows that
character with it — vanilla misses `iiddqd`, this catches it. It can't recognise anything vanilla
wouldn't.

**A letter of a code doesn't also work its bound key.** `Cheats.typing` reports a buffer partway
into a code — derived from the buffer on read, so no path through `Cheats.type` can leave it
disagreeing with what was typed — and `game.ts` withholds `handleHotkeys`' map-jump callback for
that tic: DEVMODE's previous-map jump `P` sits inside `idclip`, and without this, typing the code
jumps level and eats the cheat. It covers the tic that *completes* a code too, not only the ones
leading up to it. Only that callback is withheld, not the whole of `handleHotkeys` — the camera's
zoom and tilt keys aren't letters and can't collide, so they stay live while a code is typed. The
movement keys are deliberately not covered: `idkfa`'s `a` and `d` strafe, as vanilla's own cheat
letters do.

Codes are read only while the player is alive: a corpse answers `R` and nothing else
(docs/death.md § Player death). Both noclip spellings work whatever the IWAD is — `idclip` and
`idspispopd` — which is vanilla's own behavior, not a convenience: `ST_Responder` tests
`cheat_noclip` and `cheat_commercial_noclip` in one condition, under the comment "Simplified,
accepting both".

## IDDQD

Toggles `CF_GODMODE`, and on the way *on* sets health to 100 — `st_stuff.c`'s literal, which is
its own `Misc` row (`God Mode Health`) and not `initial_health`, so a patch moving the start health
leaves this alone and a patch moving `God Mode Health` moves it.

The flag is not part of the inventory: `applyDamage` takes it as a parameter, and tests it in the
same condition and under the same `damage < 1000` limit as the invulnerability sphere, exactly as
`P_DamageMobj` does. So god mode stops every ordinary hit — and, like the sphere, does **not** stop
a telefrag's 10000 (docs/death.md § Telefrag).

Nothing else changes: monsters still see, chase and shoot at a god-mode player, damage floors still
"hurt" them, and crushers still push them around.

## IDKFA

`ST_Responder`'s own block, in order: armor to 200 of class 2 (blue), every weapon owned, every
ammo class filled to `maxammo` — the backpack's doubled cap included, since `ammoMax` is what is
read — and all six keys. The armor is `Misc`'s `IDKFA Armor`/`IDKFA Armor Class` pair, separate
from the classes a real armor pickup follows (docs/items.md § Collecting things): moving
`Blue Armor Class` does not move what this hands over.

Every weapon means the whole roster, DOOM 1 included: vanilla's loop runs to `NUMWEAPONS` whatever
the IWAD is, so the super shotgun is handed over there too. It has no icon, sprite or sound in
`DOOM.WAD` and is quietly artless when fired, which is what vanilla does with it as well.

The selected weapon is left alone — vanilla's cheat doesn't switch to anything, unlike a pickup
(docs/items.md § Inventory).

## IDCLIP

Toggles `MF_NOCLIP` on the player. `Player.noclip` is the flag every reader goes through, and
`game.ts` writes it once at the top of the tic, beside the code-matching itself: a `Player` is
rebuilt by every level load and the cheat outlives it, so the value has to be re-pushed — and
pushing it before any system runs is what keeps specials and movement from disagreeing within one
tic. From there it reaches three places:

- **Movement.** `Player.moveBy` returns the requested displacement instead of routing it through
  `slideMove`, so no wall or solid body clips it, and each channel reads its velocity back
  unchanged — a run into a wall keeps full speed (docs/movement.md § slideMove).
- **The floor.** The resting height becomes the plain sector floor under the player's *centre*
  (`World.floorAt`) rather than `groundFloor`'s box-wide answer. That is `P_CheckPosition`'s
  `MF_NOCLIP` early-out: it returns with `tmfloorz` set from the subsector's own sector, before a
  line or a body was considered — so no ledge holds the player up over a pit and the 24-unit step
  limit stops applying. Gravity is unchanged: walk out over a lower sector and you fall into it.
- **Walk triggers.** `SpecialsController.update` takes the flag and skips its walk-line pass,
  matching `P_TryMove`, which runs its `spechit` list only for a thing without the flag. Nothing
  fires by being walked over — no doors, no teleports, no exit lines. **Use triggers still work**:
  `P_UseLines` never looks at the flag, so `Space` opens a door from the wrong side of it as usual.

Walking out past the map's edge is as unmapped here as in vanilla: the BSP resolves a point in the
void to whatever leaf it lands in, and the floor comes back from that sector.

## Saves and best times

**A cheat costs the run its best time.** Any code firing sets `cheated`, the same flag a `?pos=`
start sets, so that level's completion is not offered as a record (docs/hud.md § Best times).
It travels in the savegame, so it can't be washed off by saving and loading.

**And it costs the levels after it too**, where a `?pos=` start or a taken-over replay costs only
the level it happened on: the code also sets **`Cheats.used`**, and every level entered through an
exit reads that flag to decide whether the fresh level may record. `used` covers IDKFA, which leaves
no toggle to notice afterwards — an arsenal carried into the next level is exactly the run that must
not set a time there.

**And the intermission says so.** With that flag false the popup drops its percentages, its clock
and its best-time comparison for one red `You cheated` line under the `STFKILL3` face
(docs/hud.md § Intermission). It reads the flag rather than keeping a record of its own, so a
`?pos=` run — never eligible either — gets the same screen.

**The two toggles are session state, not level state.** They live on `Game`, so an exit carries
them into the next map the way vanilla's `player_t.cheats` does; `restart` after a death reloads a
checkpoint, and what that save recorded is what comes back.

A save records the toggles for a session that **used** one (`GameSnapshot.cheats`, optional and
absent otherwise), which is also what a save from before cheats existed carries — so old saves read
as "no cheats" and `SAVE_VERSION` did not move (docs/savegames.md § The format and its version).
The block's mere presence is what restores `used`: it is written for no other reason, so an IDKFA
session records `{god: false, noclip: false}` where it used to record nothing. An old build reading
that block sets both toggles off, which is what absence meant to it — the format did not change.
