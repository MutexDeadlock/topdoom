# Multiplayer — deathmatch

`src/game/rules.ts` (the rules and `fragSum`), `deathmatchStarts`/`deathmatchSpot` in
`src/game/playerstarts.ts`, `raycastPlayers` in `src/game/combat.ts`, the item queue in
`src/game/things.ts`, the `deathmatch` branches in `src/game.ts`, the fog's `'off'` mode
(`src/game/fogofwar.ts`), the Rules group in `src/ui/menu/multiplayer.ts`

A deathmatch is a netgame (docs/multiplayer-coop.md § Netgame) whose players shoot each other. Every
deathmatch here runs vanilla's `-altdeath` rules (`deathmatch == 2`) with `-nomonsters`; there is
no "1.0" mode. Over the network it is docs/multiplayer-net.md with the host's rules; in one browser
it is § Testing locally.

## Settings

Four rules, owned by `game/rules.ts` like `pistolStart` is by `inventory.ts`: `deathmatch`,
`friendlyFire`, `fragLimit` (net frags, 0 = none), `timeLimit` (minutes, 0 = none). Set by a lobby's
host on the Multiplayer tab's Rules group, stored (docs/menu.md § Persisted settings), carried by
`lobby` and `start` as `NetRules` (`net/defs.ts`).

- **`deathmatch` is thing identity**, like `netgame`, and no session setting: `Game` reads it once —
  the restored snapshot's `deathmatch`, else the network session's `NetRules`, else
  `GameOptions.deathmatch` (`?deathmatch=`) — and saves it (`GameSnapshot.deathmatch`, written only
  when true). Nothing pins it and no replay records it: the snapshot is its one record. A toggle
  during a session changes nothing until the next game.
- **The other three are `SessionSettings`** (docs/multiplayer.md § Player settings): read live
  through their getters, pinned per tic under a network game or a playback, so a `session` event in
  a replay pins them as it pins `pistolStart`.
- **A record from before the rules reads as coop with none**: `withSessionDefaults`
  (`replay/settings.ts`) fills a replay's `session` and its `session` events (`unpackData`),
  `withRulesDefaults` (`net/session.ts`) a lobby's; on the wire every field is optional and typed
  when present (`isNetRules`, over `sessionFieldsValid`).

## Rules

`P_SpawnMapThing` (`p_mobj.c`), in the spawn loop of `buildThingSprites`:

- **No monsters**: `-nomonsters`' `i == MT_SKULL || flags & MF_COUNTKILL` — `COUNTKILL_TYPES` and
  the lost soul.
- **No keys**: the six keys carry `MF_NOTDMATCH` (`info.c` MT_MISC4–9; `NOT_DEATHMATCH_TYPES`).
- **Boom's `MTF_NOTDM`** (bit 5) keeps a thing out of a deathmatch, `MTF_NOTCOOP` (bit 6) out of
  coop; both are void where `MTF_RESERVED` (bit 8) is set — `isNotDeathmatch`/`isNotCoop`
  (`skill.ts`, `prboom p_mobj.c`). Multiplayer-only things (`MTF_NOTSINGLE`) spawn as in coop.
- **No voodoo dolls**: a player start's body is spawned only `if (!deathmatch)`;
  `VoodooDolls` is built with none (docs/specials-forces.md § Voodoo dolls).
- **All six keys** on every spawn and reborn — `P_SpawnPlayer`'s `if (deathmatch) cards[i] = true`
  (`giveAllKeys`, `inventory.ts`).
- **Weapons are taken as in single player**: `P_GiveWeapon`'s netgame rule reads `deathmatch != 2`,
  so weapons don't stay (`Game.weaponsStay` false, `PickupOptions.weaponsStay`) — every item is
  taken, and comes back (§ Item respawn).
- Skill still applies: damage halved on skill 1, ammo doubled on 1 and 5 (docs/items.md § Skill).
- Cheats, best times and the corpse rules are the netgame's (docs/multiplayer-coop.md § Netgame).

## Starts

Doomednum 11 (`ThingType.deathmatchStart`), every one in map order — `deathmatchStarts`, Boom's
unlimited `deathmatchstarts` (`prboom p_mobj.c`, killough 1/11/98) rather than vanilla's ten.

- **Level start** (`P_SetupLevel`): each slot in order draws a spot (`G_DeathMatchSpawnPlayer`):
  up to `DM_START_TRIES` (20) draws of `P_Random() % n` — `pRandom`, after `clearRandom` — the
  first `G_CheckSpot` allows. With no body yet that refuses only a spot an earlier slot stands on
  exactly; no fog.
- **Reborn** (`G_DoReborn`'s `if (deathmatch)`): the same draw with `spotBlocked` — `P_CheckPosition`
  against walls, solid things and living players; the arrival fog and `telept` as coop's respawn
  (docs/multiplayer-coop.md § Respawn). A joiner's fresh body takes it too.
- **Every draw refused** falls back on the slot's coop start (`playerstarts[playernum]`).

**Deviation:** any number of deathmatch starts is played — vanilla refuses fewer than four
(`I_Error`) — and a map with none is played on the coop starts.

## Fog

None: `FogOfWar` is built `'off'` (docs/fogofwar.md § Off) — everything explored, no island gate,
no sweep — so every player and every item is drawn wherever the camera reaches, and auto-aim is
never fog-gated. A deathmatch save's `fog` runs say everything and are ignored on restore.

## Player versus player

The gate is `CombatContext.pvp` = `Game.pvp`: a deathmatch, or coop with `friendlyFire` on. Under
it a player's shot reaches the other living players exactly as it reaches a monster:

- **Hitscan and melee**: `raycastPlayers` (`combat.ts`) — `PTR_ShootTraverse` over the players'
  bodies, which the thing layer does not hold: `traceHitsBox` over `PLAYER_RADIUS`, the vertical
  test over `PLAYER_HEIGHT`, the shooter skipped. `raycastBody` orders it against
  `raycastMonster`'s, a monster winning a tie, and is the one place that asks for both: every
  swing, pellet and BFG ray goes through it.
- **A lock on a player**: `Game.pickAimTarget` tests the other living players' body boxes
  (`rayEntersBox` over `PLAYER_RADIUS`/`PLAYER_HEIGHT`) beside `ThingLayer.pickMonster`'s, nearest
  entry wins — body boxes only, never art (docs/combat.md § Auto-aim). The lock is a `MonsterRef`
  whose `id` is `targetOfSlot`'s and whose type is `MT_PLAYER`'s doomednum, -1; the locked pellet's
  test uses the player's box where a monster's uses the shared hitbox.
- **A missile**: `playerStruckBy` runs for a player's missile too, skipping its shooter
  (`PIT_CheckThing`'s `thing == tmthing->target`; "Let players missile other players").
- **Splash and telefrag are not gated**: a blast hurts every player in reach in coop too
  (docs/multiplayer-coop.md § Collision), and a player's teleport arrival telefrags the players on
  the pad (docs/death.md § Telefrag).
- **A hit on a player** goes through `damageSlot` with `PlayerHit.slot` (the shooter) and `cause`
  `targetOfSlot(shooter)`, which the death overlay names (docs/death.md § Who killed the player); a
  blast names its shooter to everyone but the shooter, whose own stays `'self'`, and a barrel keeps
  blaming the barrel with the credit riding on `slot` or `source` (§ Frags).

## Frags

`PlayerSlot.frags[MAX_PLAYERS]` — `player_t.frags`, whom this player killed by slot. `P_KillMobj`
(`p_inter.c`), at `fragCredit` (`rules.ts`) over the killing `PlayerHit`, **in a deathmatch only**:

| The killing hit | Who counts |
|---|---|
| a player's (`PlayerHit.slot` set, another slot) | the killer's `frags[victim]++` |
| the player's own (`slot` is the victim: own splash, own barrel) | `frags[self]++` |
| a monster's (`PlayerHit.source` set) | nobody |
| nothing's (neither: a crusher, a damage floor, a barrel nobody set off) | `frags[self]++` |

`source` is set wherever a monster deals the hit — hitscan, melee, missile, the arch-vile's blast,
a teleport or spawn-cube telefrag — and a blast hands its own on (`applyRadiusDamage`), so a barrel
carries whoever set it off (`A_Explode`'s `thingy->target`).

`netFrags` = `fragSum` (`WI_fragSum`, `wi_stuff.c`): Σ `frags[i≠self]` − `frags[self]`, negative
possible. **Zeroed by every level load** (`G_DoLoadLevel`'s `memset frags`) beside `kills`, kept
across a reborn (`G_PlayerReborn`); saved as `PlayerSlotSnapshot.frags`, absent when all zero.

**Deviation:** coop counts no frags (vanilla's `frags[]` runs in coop too) — a coop kill under
friendly fire reaches no board.

## Item respawn

`P_RemoveMobj` and `P_RespawnSpecials` (`p_mobj.c`), only in a deathmatch:

- **Taking an item queues it** — `ThingLayer`'s `itemRespawn`, `[id, tic]` oldest first — unless it
  is a monster's drop (`MF_DROPPED`), the invulnerability or the blur sphere (`MT_INV`, `MT_INS`).
  The ring holds `ITEM_RESPAWN_QUEUE` (128); a 129th drops the oldest.
- **Once per tic**, after the clock, the head comes back when it has lain `ITEM_RESPAWN_TICS`
  (30 × 35): the same thing put back at its spawn point (`spawnX`/`spawnY`, ceiling-hung height or
  the floor), facing its spawn angle, `picked`/`hidden` off — `respawnItem`, the corpse-reuse shape
  of `respawnCorpse`, so ids and saves naming them hold. `onItemRespawn` raises the effect layer's
  `spawnItemFog`: `ITEM_FOG` (`MT_IFOG`'s chain, `S_IFOG`..`S_IFOG5` walked — docs/dehacked.md
  § Frames) with `itmbk` on it, **on the sector's floor** whatever the item's own height —
  `P_RespawnSpecials` spawns it at `ss->sector->floorheight`, so a ceiling-hung item's fog is on the
  floor beneath it.
- The item counts again when taken again, as vanilla's `itemcount` does; nothing is unspawned, so
  the level's total holds.
- Saved as `ThingsSnapshot.itemRespawn`, absent when empty; a coop snapshot is unchanged.

## Limits

`Game.checkDeathmatchLimits`, where `P_UpdateSpecials` checks both, before a pending exit is
consumed; either sets `pendingExit = 'normal'`, and the intermission follows with the scoreboard:

- **Time limit** (`p_spec.c`'s `levelTimer`, `-timer`): `Level.time` in tics ≥ `timeLimit` ×
  `TICS_PER_MINUTE` — the clock runs while any player lives (docs/multiplayer.md § Player slots).
- **Frag limit** (`prboom p_spec.c`, Ty 03/18/98's `-frags`): any slot's `netFrags` ≥ `fragLimit`.

## Friendly fire

`friendlyFire`, coop only: `Game.pvp` is true and every rule of § Player versus player applies —
shots, missiles and the aim lock. Frags are still not counted (§ Frags). Off, coop is unchanged:
a player's bullets and missiles pass through the other players (docs/multiplayer-coop.md
§ Collision).

## Scoreboard and the overlay

The board's `Kills` column counts each slot's `netFrags` in a deathmatch (docs/hud.md
§ Scoreboard); the death overlay names the player who fragged you by their roster name, `Player n`
without one (docs/death.md § Who killed the player); every player's feed gets the third-person line
("A killed B", docs/hud.md § HUD messages). No frag counter on the HUD, no frag matrix on the
intermission.

## Testing locally

`?deathmatch=N` (2–4): a deathmatch of N slots in one browser, every one but the first idle — the
`?coop=N` shape (docs/menu.md § URL parameters), `GameOptions.deathmatch` set. The idle slots stand on their deathmatch starts and
can be shot, fragged and walked over.

## Deviations

- Any number of deathmatch starts; none falls back on the coop starts (§ Starts).
- Frags in a deathmatch only, never in coop (§ Frags).
- The board says `Kills` and the menu "Kill limit" where vanilla says `FRAGS` — one word for both
  modes; the number is still `WI_fragSum`, own deaths subtracted.
- The time limit runs on `Level.time`, which pauses while every player is dead.
- No `deathmatch == 1`: placed weapons never stay, items always respawn.
- The corpse and respawn deviations of docs/multiplayer-coop.md § Respawn hold.
