# Multiplayer — over the network

`src/game/net.ts` over `src/game/net/` — `defs.ts` (the peer messages, the dials),
`transport.ts`, `lockstep.ts`, `session.ts`; the seam in `src/game.ts` and `src/main.ts`; the tab
in `src/ui/menu/multiplayer.ts`; the relay in `server/`

Coop across browsers: every browser runs the whole simulation (docs/multiplayer-coop.md) in
**lockstep** on the same rows, through a **relay** that forwards messages and decides nothing. The
host is the arbiter: its lobby, its snapshot on a join or a desync, its drops.

## The relay

`server/relay.ts` is a `ws` server on `PORT` (8765). `server/rooms.ts` is the whole of its logic,
dependency-free so `tests/server/rooms.test.ts` and the client's loopback fixture drive it; its
`receive` takes every message a connection sends:

- A connection's first message is `join {code}`: `code` null opens a room and makes the sender its
  **host** (member 0); a code seats it in that room. The answer is `room {code, member, host,
  members}` or `refused {reason}` — no such room, full (`MAX_PLAYERS` members), a second seat.
- Every later message is forwarded to every other member with `from` (the sender's member id)
  stamped on, serialized once for the whole room — a snapshot is megabytes. The relay never reads
  them.
- A member leaving is `left {member}` to the rest; **the host leaving is `closed`** to everyone,
  and the room is gone. A socket answering no ping for `2 × PING_MS` is dropped.
- Codes are five of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `I`/`O`/`0`/`1`.

`server/` is its own package (`ws` is the one dependency), typechecked by its own `tsconfig`;
`server/rooms.ts` is typechecked by the root too, through the test that imports it. `npm run relay`
starts it; `MAX_PLAYERS` is stated there as `4` and the test pins it to the engine's. The relay's own
messages and the join are typed in `rooms.ts` (`RelayMessage`, `JoinRequest`); `net/defs.ts` takes
them by `import type`, so nothing of `server/` reaches the bundle.

## Protocol

Peer messages (`PeerMessage`, `net/defs.ts`), each guarded by `isPeerMessage` before a handler
sees it — a malformed one is dropped, never half-applied:

| Message | From | Says |
|---|---|---|
| `hello {name, settings, build, compat}` | joiner | who this is; `compat` ≠ the host's is refused |
| `lobby {game, session, delay, peers, playing}` | host | the room as it stands, after every change |
| `ready {refusal}` | joiner | whether its library can play `game`'s set (`main.ts`'s `setRefusal`) |
| `start {slots, session, delay}` | host | the game begins: who holds which slot |
| `input {slot, tic, row, settings?}` | everyone | one row for `tic`, with the slot's player settings when they changed |
| `check {tic, cursor, x[], y[]}` | host | the desync sample every `CHECK_INTERVAL` |
| `desync {tic}` | peer | its sample disagreed with the host's |
| `sync {atTic, joining}` | host | stop before `atTic`; a snapshot follows |
| `snapshot {restore}` | host | the level at `atTic`: map, state, slots |
| `drop {slot, atTic}` | host | the slot's rows are idle from `atTic` |
| `ended` | host | the campaign is over; back to the lobby |

`NetGame` is `{set: SaveWadSet, skill}` — the WAD set by content ID, exactly what a save records
(docs/savegames.md § WAD-set identity), read off the loaded set when the host opens the room.

**A row on the wire is `WireRow`** (`replay/row.ts`, beside the record's own codec): the twelve
`TicColumns` of one tic as an array — a network game is the replay record, sent live. `typed` is not carried: cheats
stay out of a network game (`ST_Responder`'s `!netgame`, `st_stuff.c`).

## The session

`NetSession` is one browser's seat, built by `main.ts` on Host or Join and handed to `Game` as
`GameOptions.net`. Its `NetHooks` are `main.ts`'s: `setRefusal` (the menu's WAD gate over the
host's set), `startGame` (the level, fresh or from a snapshot), `changed` (the tab redraws),
`ended` (the room closed, the connection dropped, a refusal).

Phases: `lobby` → `loading` (`start` or a join's snapshot; the level is building) → `playing`
(`Game.bindNet` calls `attach`) → `ended`. `endGame` (the host, at the campaign's end) puts the
room back in `lobby`.

**The lobby.** The host's `peers` list is the room; every `lobby` message mirrors it. A joiner
sends `hello`, gets `lobby`, resolves the set through `Menu.resolveSaveWads` and answers `ready`;
the host refuses a `compat` mismatch itself. `canStart` is every peer ready. `start` assigns slots
in join order, the host slot 0. A `?coop=`-style idle slot does not exist here: every slot is a
browser, until one leaves (§ Leaving).

## Lockstep

`LockstepScheduler` (`net/lockstep.ts`) holds every slot's rows by tic.

- **A row sampled at tic `t` drives tic `t + delay`** (`INPUT_DELAY`, 3; the host picks 1–8 in the
  lobby). The local row goes out and into the table at the top of the tic; every peer's row for a
  tic has arrived before anyone runs it, so no one predicts and no one rolls back.
- **Tics before `delay` are idle for every slot**, and never waited for (`idleBefore`); a joiner's
  slot is idle until `delay` past its sync tic.
- **A tic runs only when every slot that is waited for has its row** (`readyFor`). Otherwise the
  frame holds: `Game.frame` banks no time (the wait is not simulation time, so no catch-up burst
  follows) and draws the last state. A peer can be at most `delay` tics ahead of the slowest.
- After `STALL_NOTICE_MS` the center message names who is being waited for; after
  `DROP_TIMEOUT_MS` the host drops them (§ Leaving).
- **A settings change rides the row** it was sampled with (`input.settings`) and takes effect on
  every browser at that row's tic — `Game.beginTic`'s `slot.settings` push, as a replay's
  `settings` event. **One record per slot**: the slot's assignment (`NetSession.settingsOf`),
  changed in place, is the object `Game.bindNet` hands the slot. A replaced copy leaves the level
  reading the old settings and every snapshot carrying them.

## What a tic does

`Game.tic` under `net` is docs/multiplayer.md § What a slot's tic does with every slot on
`source: 'row'` — including the local one:

1. `beginTic`: `sampleNetRow` — the live keyboard, buttons and wheel into the local row
   (`sampleInput`), the aim point through the **drawn** camera at the plane the tic will use, the
   drawn camera's pose (`quantizePose`); the menu up means an idle row. `NetSession.beginTic` sends
   it for `tic + delay`, applies the settings events due, copies every slot's row into its
   `RowInput`, and takes the check sample where one is due. Then every slot's `simCamera` is posed
   from its row (`setPose`, an idle row poses nothing), and the session settings are pinned
   (§ Settings).
2. The tic proper. The local slot's `simCamera` is a private camera, as under a playback: posed
   from the row, `delay` tics behind the drawn one, so camera-relative movement and the aim ray
   are the row's on every browser. `handleHotkeys` and the audio listener use the drawn camera.
3. `tickViewCamera`: the drawn camera's own advance — Q/E, the framing keys, the auto camera, the
   glide toward `liveAim` — then the live input's `endTic`. Presentation: the next row's pose is
   read off it.
4. `endTicInputs`: `NetSession.endTic` moves the cursor.

The intermission's continue and the end card's answer to **any** slot's press: every browser
sees every row, so the one answer is the same everywhere.

**Deviation:** the row a slot sends after a level load, a respawn or a teleport still carries the
pose the drawn camera had before it, for `delay` tics — the same on every browser, and gone in
under a tenth of a second.

## Snapshots

`sync {atTic, joining}` names a tic `2 × delay` past the host's own, which no peer has reached
(a peer is at most `delay` ahead). Every browser stops before `atTic` (`Game.netReady` →
`NetSession.pendingRestore`):

- The host captures the level there (`Game.captureState`: `captureMoment` without a save's death
  refusal — a corpse restores as one) and sends `snapshot`; a moment no snapshot can carry (a
  popup up, an exit pending) moves the sync `2 × delay` on and lets the tics run.
- Everyone, the host included, restores it (`applyNetRestore` → `loadMapByIndex`) and continues
  from `atTic` on the rows already in the table (`LockstepScheduler.seek`). A restore is the
  replay's keyframe path, which plays on bit-identically (docs/replays.md § Seeking).

**Desync.** The host's `check` every `CHECK_INTERVAL` is the recorder's sample (docs/replays.md
§ Desync samples); a peer compares its own, whichever arrived first, and reports the first
disagreement since the last snapshot once (`desync`). The host answers with a sync. `desyncedAt`
is what the tab's hint shows meanwhile.

## Joining a game

A `hello` while the game runs gets a `lobby {playing: true}`; a `ready` with no refusal queues the
member. One at a time, the host schedules `sync {joining: {slot, member, name, settings}}` — the
lowest slot whose player left, else the next one — and at `atTic` captures with a fresh body for
that slot (`Game.freshSlotSnapshot`: `G_DoReborn`'s spot, a fresh inventory, facing the spot's
way). The joiner builds the level from the snapshot (`startGame` with `restore`), a `Game` with
`localSlot` its own; every other browser restores it, `growSlots` adding the slot. The joiner's
first row is for `atTic + delay`; until then its slot is idle, and the others wait for it at
`atTic + delay` — "X is joining…". A recording running when a slot is added ends: its record has
no room for one.

## Leaving

- **A peer leaving** (`left`, or the host's `DROP_TIMEOUT_MS`) is a `drop {slot, atTic}` from
  the host, `atTic` one past the last row that arrived (`dropTicFor`): the slot's rows are idle
  from there and nobody waits for it. The player stands idle in the level, as under `?coop=` —
  monsters may go after it, and it can die. A dropped browser that is still there hears its own
  drop and ends.
- **The host leaving** closes the room (`closed`): every peer's session ends.
- **A session ending under a running level** — the room closed, the connection lost, the menu's
  Leave — leaves the level running alone: `Game.unbindNet` puts the local slot back on the
  keyboard and the viewport's camera, every other slot idle, and says why on screen. A start of
  the player's own (New Game, Load, a replay) leaves the room first.
- **The campaign's end** reaches every browser on the same tic; the host's `endGame` takes the
  room back to its lobby.

## Settings

- **Player settings are per slot** and travel in the rows (§ Lockstep). The local slot's
  `settings` under `net` is the session's record of them, not `GLOBAL_PLAYER_SETTINGS`; the menu's
  live values are what `sampleNetRow` sends.
- **Session settings are the host's**, read when it opens the room (and again on announcing a
  level), carried by `start`, and pinned on every browser before every tic
  (`applySessionSettings`) — a toggle in the menu during a network game does nothing until it
  ends (`releaseSessionSettings`).
- The camera mode reaches the simulation only through the row's pose, so each browser's own
  applies to its drawn camera alone.
- **Cheats are off**: the row carries nothing typed.
- A netgame's rules apply (docs/multiplayer-coop.md § Netgame): no best time, respawn in place.
  Saving works and restores as a local coop game.

## The Multiplayer tab

`ui/menu/multiplayer.ts` (`MultiplayerUi`), `MultiplayerHooks` in `main.ts`
(docs/session.md § Session lifecycle):

- **Relay** and **Your name** fields; the relay URL is the `relayUrl` setting (docs/menu.md
  § Persisted settings), the name is `playerName`, the replays' (`setPlayerName`).
- **Host the New Game tab's level**: `Menu.currentSelection` loaded for its content IDs
  (`netGameOf`: `wadSetOf`, as `captureSave` reads it), then the room. **Room code** + **Join**.
- The room: its code, `phaseText`, the facts (level, skill, WADs, rules, delay), the peer list —
  in the lobby each peer's `ready`/`checking…`/refusal in red; in a game the roster, a slot whose
  player left dimmed — the host's input delay select, **Announce the New Game tab's level**
  (`setGame` + `setSession`: every peer checks again), **Start** (`canStart`), **Leave**.
- The hint line: who Start waits on, or a desync being resynced.

## Deviations

Vanilla's `d_net.c` runs an adaptive `maketic` ahead of `gametic` with `consistancy[]` checks
that abort the game (`I_Error`); here the delay is fixed and set in the lobby, a disagreement is
answered with the host's snapshot rather than an abort, a player can join a game already running,
and a dropped player's body stays in the level. `ST_Responder`'s `!netgame` cheat gate holds.
