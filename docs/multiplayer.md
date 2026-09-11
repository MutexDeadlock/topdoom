# Multiplayer

`src/game/playerslot.ts`, the slot loops in `src/game.ts`, `targetOfSlot`/`slotOfTarget` in
`src/game/things/defs.ts`, `CombatSlot` in `src/game/combat.ts`, the row codec
`src/game/replay/row.ts`

The engine runs every player as a **slot**, 1 to `MAX_PLAYERS` of them. What a netgame changes —
starts, target choice, respawn, the item rules, the shared fog — is docs/multiplayer-coop.md; how
browsers run one together — the relay, lockstep, snapshots — is docs/multiplayer-net.md.

## Player slots

`PlayerSlot` is one player's whole share of a level: `player`, `inventory`, `weapons`, `cheats`,
`dead`, `touch`, `simCamera`, `autoCamera`, `input`, `source`, `settings`, `color`, `actor`, `shadow`,
`consumePickup`. `Game.slots` holds them by index. `localSlot` is the one this browser plays: the
HUD, crosshair, screen effects, death overlay, center messages, audio listener, `viewColormap`, the
fade anchor, the fog's drawn island and the view camera read `local`, and nothing else does.

Level-global: on `Game`, `netgame`, `cheated` (any slot's cheat taints the run) and `replay` (every
slot's recorder or playback); on `Level`, `starts`, `fogOfWar` (one shared reveal), `time` (runs
while any slot is alive), `sectorEffects` (per-slot damage-floor timers, one secret count),
`specials` and `voodoo` (player-1 starts; player 1's inventory and keys).

**`source` says what drives a slot's input.** `'live'`: the keyboard — its camera turns on its own
keys and its auto camera ticks. `'replay'`: posed from the record each tic, the camera left alone.
`'idle'`: `IDLE_TIC_INPUT`, a slot nobody drives — every slot but the local one under `?coop=`.
`'row'`: a network game's row for the tic, the local slot's included — its camera is posed from the
row like a replay's, and the drawn one is driven apart (docs/multiplayer-net.md § What a tic does).

**Saves and replays hold every slot.** `captureSave` writes `GameSnapshot.players`, one
`PlayerSlotSnapshot` per slot (player, inventory, weapons, cheats, `cameraYawDeg`, `dead`);
`SpecialsController.snapshot` writes every slot's `prev`, `SectorEffects.snapshot` every slot's
timer; a replay holds one `SlotRecord` and one check column per slot. A restore builds as many
slots as it holds. docs/savegames.md § What is saved and what is deliberately not, docs/replays.md §
The record.

Everything that reads a player loops the slots: the look rotation (`lookForPlayers`),
`blockersFor`, `respawnCorpse`, the telefrag halves in `game.ts` and `iconofsin.ts`,
`applyRadiusDamage`, a monster's hitscan (the nearest living slot along the bolt wins), a monster's
missile (`playerStruckBy`, the first living slot struck), crushers (`applyCrushDamage`,
`MoverOccupancy`), the fog (`FogOfWar.tick`).

## Slot addressing

`PosedThing.targetId`, `MonsterAttackEvent.targetId`, `Projectile.sourceId`, a homing missile's
`targetId` and `OneShotEffect.followTargetId` are one integer: a monster's `PosedThing.id`
(`>= 0`), or a player slot as `targetOfSlot(slot) = -1 - slot` (`< 0`; `slotOfTarget` reads it
back). One compare tells the two apart and the field stays a small integer — the `null` this
replaced forced the tagged representation onto every hot record.

`targetOfSlot(0)` is the spawn default (`MONSTER_FIELD_DEFAULTS.targetId`) and is elided from a
saved monster block. A saved projectile carries its ids as the live one does.

`CombatContext.slots` is what a target id indexes (`CombatSlot`: `player`, `dead`).
`damageSlot(slot, …)` is the one way a player takes damage. `triggerShot(lineIndex, shooter)`
takes the shooting slot, or `null` for a monster's stray shot — which carries player 1's keys, as it
always has. `fallbackPlayer(ctx, targetId)` is where a monster's shot goes once the monster it
aimed at is gone: the named slot, else player 1. A player's hit on a monster names its slot
(`DamageHit.slot`, `RadiusBlast.slot`).

Sound origins and light emitters are per slot: `playerOrigin(slot)` (`audio/sfx.ts`),
`playerEmitterId(slot)` (`render/lights.ts`).

## Player settings

`SimSettings` is one stored record with two owners. **`PlayerSettings`** — autorun, automatic
weapon switching, the right button's binding, the camera mode — belong to a slot
(`PlayerSlot.settings`). **`SessionSettings`** — infinite tall actors, pistol start — belong to the
game, and every slot reads the one module value.

- The local slot's `settings` is `GLOBAL_PLAYER_SETTINGS` (`replay/settings.ts`): getters over the
  owners' module values, so a menu change and a playback's pin (docs/replays.md § Settings are
  frozen per tic) reach it without a copy. Any other slot carries its own record: a copy of the
  local one's when the slot is built, and the record's own under a playback
  (`ReplayPlayback.slotSettings`).
- `Game.tic` pushes `autorun` onto `Player.autorun` and `autoSwitchWeapon` onto
  `WeaponSystem.autoSwitch` beside `noclip`, every tic; `consumePickup` passes `autoSwitchWeapon` to
  `applyPickup` (`PickupOptions.autoSwitch`). No tic reads `getAutorun` or `getAutoSwitchWeapon`.
- The right button's binding is the input's to apply: `RowInput.rightMouse` answers a row's edge,
  and a `ReplayPlayback` sets each slot's from that slot's settings in force. The live `Input` asks
  the module value, and the recorder samples each slot's edge under the settings it last wrote
  down for it.
- The camera mode reaches a tic only through the camera pose, which a replay slot takes from its
  record, so only a live slot's camera ever reads it.

## What a slot's tic does

`Game.tic` keeps the single-player order (docs/frameloop.md § What runs in a tic) and loops the
slots where a step was per player.

1. `local.input` is read — `ReplayDriver.set` points every slot's `input` at `replay.input(slot)`, or at
   the network's rows, or at the keyboard for the local slot and `IDLE_TIC_INPUT` for the rest, and
   sets `source` with it; the popup's continue key is any slot's.
2. Per slot: a living slot's cheat buffer, `player.noclip`, `player.autorun`, `weapons.autoSwitch`.
3. Hotkeys and the audio listener — local only.
4. Per live slot: `simCamera.applyYawInput`.
5. `specials.beginTic` (the clocks, the movers, the corpses they crunched); `specials.activate`
   per living slot (use press, walk triggers, `prev` reseed) — a corpse uses and crosses nothing;
   `specials.endTic` (switch flashes, light patterns — **after every trigger**, so a light a switch
   lit this tic draws from the table this tic). Then `forces.tick` and the dolls (slot 0's).
6. Per slot: `consumeLockedLine(slot)`; the message is the local slot's.
7. The exit. Then a corpse's one input: the local `R` in single player (`restart`), use or the slot's
   own `R` in a netgame (`respawnSlot`, docs/multiplayer-coop.md § Respawn).
8. Per slot: `applyToCamera(1)` and `updateLivingPlayer` while alive, then the camera ticks for
   a live slot.
9. `Level.time` while any slot is alive; `refillBodies`; the fog from every slot's body; things
   (`players`: every slot's body, `null` where dead); effects.
10. `endTic` on every slot's input, then a playback's cursor.

`specials.update(dt, player, input, keys, noclip)` stays as the one-slot composition of the three
halves — what every test drives.
