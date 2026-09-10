# Multiplayer

`src/game/playerslot.ts`, the slot loops in `src/game.ts`, `targetOfSlot`/`slotOfTarget` in
`src/game/things/defs.ts`, `CombatSlot` in `src/game/combat.ts`

The engine runs every player as a **slot**. One exists today; the shape is what a ghost race, local
coop and the network build on, in that order, and each of those documents itself here when it
lands.

## Player slots

`PlayerSlot` is one player's whole share of a level: `player`, `inventory`, `weapons`, `cheats`,
`dead`, `touch`, `simCamera`, `autoCamera`, `input`, `source`, `actor`, `shadow`, `consumePickup`.
`Game.slots` holds them by index. `localSlot` is the one this browser plays: the HUD, crosshair,
screen effects, death overlay, center messages, audio listener, `viewColormap`, the fade anchor
and the view camera read `local`, and nothing else does.

Level-global, on `Game`: `fogOfWar` (one shared reveal), `levelTime` (runs while any slot is
alive), `cheated` (any slot's cheat taints the run), `sectorEffects` (per-slot damage-floor timers,
one secret count), `specials`, `voodoo` (player-1 starts; player 1's inventory and keys), `replay`
(the local slot's recorder or playback).

**`source` says what drives a slot's input.** `'live'`: the keyboard — its camera turns on its own
keys and its auto camera ticks. `'replay'`: posed from the record each tic, the camera left alone.
`'row'` and `'idle'` are named for the network and for a stream that ended; nothing produces them
yet.

**The save and replay formats hold slot 0 and nothing else.** `captureSave` writes slot 0's
player, inventory, weapons, cheats and `cameraYawDeg`; a restore reads them back into slot 0;
`SpecialsController.snapshot` writes slot 0's `prev`, `SectorEffects.snapshot` slot 0's timer.
Every other slot is lost to a save until the coop break. docs/savegames.md § What is saved and what
is deliberately not.

Every slot spawns on `World.playerStart()`; coop starts (doomednums 2–4) are not read.

`tryWake` looks at the first living slot; vanilla's rotation over every slot
(`P_LookForPlayers`) arrives with coop. Everything else that reads a player loops the slots:
`blockersFor`, `respawnCorpse`, the telefrag halves in `game.ts` and `iconofsin.ts`,
`applyRadiusDamage`, a monster's hitscan (the nearest living slot along the bolt wins), a monster's
missile (`playerStruckBy`, the first living slot struck), crushers (`applyCrushDamage`,
`MoverOccupancy`).

## Slot addressing

`PosedThing.targetId`, `MonsterAttackEvent.targetId`, `Projectile.sourceId`, a homing missile's
`targetId` and `OneShotEffect.followTargetId` are one integer: a monster's `PosedThing.id`
(`>= 0`), or a player slot as `targetOfSlot(slot) = -1 - slot` (`< 0`; `slotOfTarget` reads it
back). One compare tells the two apart and the field stays a small integer — the `null` this
replaced forced the tagged representation onto every hot record.

`targetOfSlot(0)` is the spawn default (`MONSTER_FIELD_DEFAULTS.targetId`) and is elided from a
saved monster block exactly as `null` was, so stored blocks are byte-identical. A projectile's
`sourceId` and homing `targetId` still write player 1 as `null`: `ProjectileLayer.snapshot`/
`restore` map `targetOfSlot(0)` across the boundary. A second slot on the wire is the coop format
break.

`CombatContext.slots` is what a target id indexes (`CombatSlot`: `player`, `dead`).
`damageSlot(slot, …)` is the one way a player takes damage. `triggerShot(lineIndex, shooter)`
takes the shooting slot, or `null` for a monster's stray shot — which carries player 1's keys, as it
always has. `fallbackPlayer(ctx, targetId)` is where a monster's shot goes once the monster it
aimed at is gone: the named slot, else player 1.

Sound origins and light emitters are per slot: `playerOrigin(slot)` (`audio/sfx.ts`),
`playerEmitterId(slot)` (`render/lights.ts`).

## What a slot's tic does

`Game.tic` keeps the single-player order (docs/frameloop.md § What runs in a tic) and loops the
slots where a step was per player:

1. `local.input` is read — `setReplay` points it at `replay ?? view.input` and sets `source` with
   it; the popup branch reads it alone.
2. Per slot: the cheat buffer, `player.noclip`.
3. Hotkeys and the audio listener — local only.
4. Per live slot: `simCamera.applyYawInput`.
5. `specials.beginTic` (the clocks, the movers, the corpses they crunched); `specials.activate`
   per slot (use press, walk triggers, `prev` reseed); `specials.endTic` (switch flashes, light
   patterns — **after every trigger**, so a light a switch lit this tic draws from the table this
   tic). Then `forces.tick` and the dolls (slot 0's).
6. Per slot: `consumeLockedLine(slot)`; the message is the local slot's.
7. The exit; `R` (local).
8. Per slot: `applyToCamera(1)` and `updateLivingPlayer` while alive, then the camera ticks for
   a live slot.
9. `levelTime` while any slot is alive; fog (local); things (`players`: every slot's body,
   `null` where dead); effects.
10. `endTic` on every slot's input.

`specials.update(dt, player, input, keys, noclip)` stays as the one-slot composition of the three
halves — what every test drives.
