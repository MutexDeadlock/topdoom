# Cheat codes

`src/game/cheats.ts`, `src/game/input.ts: Input.typed`, `src/game.ts: applyCheats`,
`src/game.ts: warpToLevel`, `src/game/player.ts: noclip`

Four of vanilla's cheats are in: **IDDQD**, **IDKFA**, **IDCLIP** and **IDCLEV**. Each does what
`st_stuff.c`'s `ST_Responder` does with it, and the first three print `d_englsh.h`'s own response in
the center message (docs/hud.md § Center messages) — a line a DEH/BEX patch can replace by mnemonic
(docs/dehacked.md § Cheat responses). IDCLEV prints nothing (§ IDCLEV).

Vanilla's other codes — `IDFA`, `IDBEHOLD*`, `IDMUS`, `IDMYPOS`, `IDCHOPPERS` — are not
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

**No key is withheld while a code is typed.** `idkfa`'s `a` and `d` strafe, as vanilla's own cheat
letters do, and no letter is bound to anything else — the camera's zoom and tilt keys aren't
letters. `Cheats.typing` reports a buffer partway into a code — derived from the buffer on read, so
no path through `Cheats.type` can leave it disagreeing with what was typed — and is what refuses a
save, a recording and a replay keyframe over a half-typed code: no snapshot carries the buffer
(docs/replays.md § Seeking). IDCLEV waiting for its two characters counts as typing too.

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
"hurt" them, crushers still push them around, and knockback and the arch-vile's launch still
move them (docs/death.md § Player death).

## IDKFA

`ST_Responder`'s own block, in order: armor to 200 of class 2 (blue), every weapon owned, every
ammo class filled to `maxammo` — the backpack's doubled cap included, since `ammoMax` is what is
read — and all six keys. The armor is `Misc`'s `IDKFA Armor`/`IDKFA Armor Class` pair, separate
from the classes a real armor pickup follows (docs/items.md § Collecting things): moving
`Blue Armor Class` does not move what this hands over.

Every weapon means `NUMWEAPONS` **less what the loaded set could never select**, which is
prboom-plus' `WeaponSelectable`:

| Game mode | Withheld |
|---|---|
| `commercial` | nothing |
| `registered` | the super shotgun ("Can't select the super shotgun in Doom 1") |
| `shareware` | the super shotgun, the plasma rifle and the BFG |

Vanilla's loop does hand all nine over whatever the IWAD is; it is the *selection* side that
refuses them, so the player never holds one. Here ownership is the only gate every selection path
reads — `WEAPON_SLOTS`, `WEAPON_CYCLE`, `AMMO_FALLBACK_ORDER`, the HUD strip — so they are left out
of the set instead. Same observable behavior, one deviation from vanilla's own record of it.

The mode comes off the set's map list (docs/wad.md § What game mode a set is), vanilla's own
file-name identification being untrustworthy here. Nothing else in IDKFA is gated: the ammo still
fills to `maxammo`, cells included, and a map that *places* one of these weapons still gives it —
the pickup path is unchanged.

The selected weapon is left alone — vanilla's cheat doesn't switch to anything, unlike a pickup
(docs/items.md § Inventory).

## IDCLIP

Toggles `MF_NOCLIP` on the player. `Player.noclip` is the flag every reader goes through, and
`game.ts` writes it once at the top of the tic, beside the code-matching itself: a `Player` is
rebuilt by every level load and the cheat outlives it, so the value has to be re-pushed — and
pushing it before any system runs is what keeps specials and movement from disagreeing within one
tic. From there it reaches five places:

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
- **Floor forces.** Conveyors, pushers and ice or mud leave the player alone: `game.ts` asks
  `Forces` nothing for a noclipping slot, as Boom's `T_Scroll`, `T_Pusher`/`PIT_PushThing` and
  `P_GetFriction` each skip a thing with the flag (docs/specials-forces.md).
- **Knockback.** `damageSlot` gives a hit no thrust, as `P_DamageMobj`'s thrust block tests
  `MF_NOCLIP`. The arch-vile's launch still lands: `A_VileAttack` sets `momz` itself
  (docs/death.md § Player death).

Walking out past the map's edge is as unmapped here as in vanilla: the BSP resolves a point in the
void to whatever leaf it lands in, and the floor comes back from that sector.

## IDCLEV

`idclev` plus two characters, which name the map to warp to: `E1M2`'s spelling outside DOOM 2,
`MAP12`'s in it — vanilla picks by `gamemode`, and here the **current map's own spelling** decides,
with the other tried after it so a set naming its maps the other way round is still reachable
(`cheats.ts: warpTargets`). The pair is not checked for being digits: characters spelling no map name
find none, which is where vanilla's `epsd`/`map` range tests end up. The two characters are
swallowed as parameters whatever they are — `cht_GetParam`'s own behavior — so nothing typed inside
them can fire another code.

**The map must be one the loaded set provides.** A pair naming none shows `No such level: <name>`
and changes nothing: prboom-plus' `cheat_clev` prints "IDCLEV target not found", where vanilla
returns silently — a warp that quietly does nothing looks like a cheat that doesn't work.

**A warp is a fresh game, not an exit.** Vanilla defers to `G_DeferedInitNew`, which puts every
player in `PST_REBORN`, so the level is entered with a fresh inventory whatever the pistol-start
setting says (docs/items.md § Pistol start), and `G_PlayerReborn`'s memset clears `player_t.cheats`
— **god mode and noclip go off with the warp**. `Cheats.used` does not: it is this engine's own
record that the run cheated, and outlives the rebirth (§ Saves and best times).

**No response line.** The level arriving says it. Vanilla's `STSTR_CLEV` is raised a tic before
`G_DoLoadLevel` takes the message down with it, so it is barely seen there either; here it is not
raised at all and stays `noTarget` for a DEH patch (docs/dehacked.md § Cheat responses).

Level order is the load order of the WAD set, so a warp reaches any map in it — including one the
campaign's progression never leads to.

## Saves and best times

**A cheat costs the run its best time.** Any code firing sets `cheated`, the same flag a `?pos=`
start sets, so that level's completion is not offered as a record (docs/hud.md § Best times).
It travels in the savegame, so it can't be washed off by saving and loading. An IDCLEV whose map
doesn't exist is the one code that fires nothing: it costs no best time, since `ST_Responder`
returns before it changes anything either.

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
checkpoint, and what that snapshot recorded is what comes back.

A save records the toggles per slot for a session that **used** one (`PlayerSlotSnapshot.cheats`,
optional and absent otherwise), so a save that never cheated reads as "no cheats". The block's mere
presence is what restores `used`: it is written for no other reason, so an IDKFA session records
`{god: false, noclip: false}`.
