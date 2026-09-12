# Multiplayer — coop

`src/game/playerstarts.ts`, `lookForPlayers`/`tryWake` in `src/game/monsters/ai.ts`, the netgame
branches in `src/game/things.ts`, `src/game/inventory.ts` and `src/game.ts`

Coop runs 2–4 slots through one simulation as a **netgame**. Under `?coop=N` (docs/menu.md § URL
parameters) every slot but the local one stands idle on `IDLE_TIC_INPUT`; over the network each is
another browser's (docs/multiplayer-net.md). The slot machinery itself is docs/multiplayer.md; the
netgame that is a deathmatch is docs/multiplayer-deathmatch.md.

## Netgame

`Game.netgame` is decided once per session: `GameOptions.players`, or a restored snapshot's
`netgame`. Which things spawn depends on it, so it is saved and every thing id is counted under it.

- **Multiplayer-only things spawn** — `P_SpawnMapThing`'s `if (!netgame && (mthing->options & 16))`
  (`p_mobj.c`). **Boom's not-in-coop things don't** — `MTF_NOTCOOP`, bit 6, void under
  `MTF_RESERVED` (`isNotCoop`, `skill.ts`; `prboom p_mobj.c`); its deathmatch twin is
  docs/multiplayer-deathmatch.md § Rules.
- **No best time** is recorded (`Game.recordCompletion`).
- `R` never reloads the level; § Respawn.

## Starts

`coopStarts(world)`: slot `s` starts on the last thing of doomednum `s + 1` — vanilla's
`playerstarts[]`, overwritten per thing; slot 0's is `World.playerStart`. A level puts every slot on
its start with no occupancy test (`P_SpawnPlayer`).

**Deviation:** a map with no start for a slot puts it on the first start no earlier slot took, else
on player 1's (`levelStartFor`); vanilla spawns no body for it. Doomednum 11 is a deathmatch's
(docs/multiplayer-deathmatch.md § Starts). Extra starts of types 2–4 spawn nothing: voodoo
dolls stay type 1's (docs/specials-forces.md § Voodoo dolls).

## Target choice

`lookForPlayers` is `P_LookForPlayers` (`p_enemy.c`): from `lastlook`, at most two slots examined per
call, the lap stopping one short (`stop = (lastlook - 1) & 3`); a slot nobody plays is stepped over
uncounted, a dead player passed over; then the cone (unless `allaround`) and sight. `lastlook` stays
where the lap stopped.

- **`lastlook` is the spawn draw** — `P_SpawnMobj`'s `P_Random() % MAXPLAYERS`, the one draw
  `pushThing` makes; the revenant's homing coin is its low bit. In single player a monster spawned
  on 1 misses its first look (docs/monster-ai.md § Waking up).
- **Waking** (`tryWake`, `A_Look`): a noise in the monster's sector wakes it after the slot that made
  it (`World.soundTargetOf`, the last noise through the sector wins) while that player lives; an
  ambush monster also needs to see them. Otherwise `lookForPlayers(false)`.
- **Losing a target** (`resolveTarget`, `A_Chase`): a dead monster or a dead player zeroes
  `threshold` and runs `lookForPlayers(true)`; finding nobody idles the monster.
- **Netgame retarget** (`MonsterStep.retarget`): a chase call with `threshold` 0 that cannot see its
  target looks all around, and ends there if it found someone — `A_Chase`'s `if (netgame && …)`.
- **A player's hit** (`DamageHit.slot`) re-points a monster already hunting a player at the shooter.
  **Deviation:** `P_DamageMobj` turns any monster onto a player source and commits its `threshold`;
  a player's hit here never did, and a monster infighting keeps its target.

## Respawn

A dead slot in a netgame respawns on **use** or **`R`** from its own input (`respawnPressed`), and
the level runs on (`Game.respawnSlot`, `G_DoReborn`). A row carries its player's `R` to every
browser: gated to the local slot, each `R` respawned on one browser alone, desynced, and the host's
resync laid a guest's body down again.

1. `G_PlayerReborn`: a fresh inventory, the weapons reset, the cheat toggles off (`Cheats.reborn`;
   `used` stays).
2. The spot (`rebornSpot`): the slot's own start if `G_CheckSpot` finds it free, else the first free
   start in slot order, facing that start's way, else its own start regardless. Free is
   `positionBlocked` for a player's box against the walls, solid things and living players
   (`Game.spotBlocked`) — nothing is telefragged.
3. A teleport fog 20 units in front of the spot, on the spot's floor (`SpriteFxLayer.spawnArrivalFog`, a teleport's landing half).
4. The same `Player` stood up there (`respawnAt`), `specials.reseatSlot`, and the slot's cameras cut
   to it, facing its way.

A corpse uses no line and crosses none: `specials.activate` skips a dead slot, in single player too
(`P_DeathThink` runs instead of `P_MovePlayer`).

**Deviations:** the press is an edge, not vanilla's held `BT_USE`, which respawns a player holding
use the tic after they die. The corpse is not left lying: one billboard per slot. The respawn lands
in the tic the press is read rather than at the next `G_Ticker`.

## Items and kills

`p_inter.c` in a netgame:

- **A key stays** for everyone (`leftInNetgame`): given, not removed, silent.
- **A placed weapon stays forever** — `Game.weaponsStay` (`P_GiveWeapon`'s
  `netgame && deathmatch != 2`), handed to `applyPickup` and `leftInNetgame`. A player who owns it
  gets nothing, not even ammo; one who doesn't gets it with its two clips and is switched to it, `wpnup` plays, and it stays. A dropped
  weapon is taken as in single player. Coop only: a deathmatch takes everything
  (docs/multiplayer-deathmatch.md § Rules).
- **Kills**: a monster's death counts toward the level unless a monster dealt it (`countKill`,
  `P_KillMobj`'s `!netgame` gate). **Deviation:** a crusher's or a monster's telefrag still counts —
  both carry no `source`, which is also what a player's hit carries.
- **A player's own kills** (`PlayerSlot.kills` — `P_KillMobj`'s `source->player->killcount`) are
  the kills a hit naming its `slot` made: a shot, a splash, a barrel it set off
  (`PosedThing.explodeSource`), its own telefrag. The thing layer holds no player, so it tells each
  one by slot (`ThingLayerOptions.onKill`). Single player counts none apart: every kill is player
  1's (`players[0]`), which the level's count already is. Saved with the slot
  (`PlayerSlotSnapshot.kills`, absent at 0) and zeroed by every level start, as `P_SetupLevel`
  does.

## Collision

Living players are solid to each other (`PIT_CheckThing`): `Game.solidBodiesAround` adds every other
living slot to what a player walks around, and `blockersFor` holds every slot for the monsters. A
player's bullets and missiles pass through another player — **deviation**, vanilla's coop has no
such mercy — unless the host turns friendly fire on (docs/multiplayer-deathmatch.md § Friendly
fire); a blast hurts every player in reach either way, and a player arriving off a teleport pad
telefrags the players on it (docs/death.md § Telefrag).

## Shared fog of war

One `FogOfWar` for everyone. `tick(points)` sweeps from every slot's body, the per-tic caps split
between them over one `SweepAnchor` each (docs/fogofwar.md § Sweep order), and the constructor seeds
every slot's start. Each slot stands in an island of its own: `isVisible`, which also gates
auto-aim, admits any slot's, so every browser answers it alike, and only the drawn slot's island is
drawn (docs/fogofwar.md § Islands). Another player's reveal can let a monster be seen sooner.

## Exit, death and saves

Any slot's exit ends the level for everyone. Entering the next level reborns every dead slot and
keeps the living ones' inventories (`runEnterLevel`, `P_SetupLevel`'s `PST_REBORN`). `Level.time`
runs while any slot lives.

A save holds every slot (`GameSnapshot.players`) and `netgame`, and restores into as many slots as
it holds, whatever the session was started with. A save is refused while the local slot is dead;
another slot's corpse is saved as one (`PlayerSlotSnapshot.dead`). docs/savegames.md.
