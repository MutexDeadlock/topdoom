# Line and sector specials

`src/game/specials.ts`, `src/game/specials/defs.ts`, `src/game/specials/tables.ts`,
`src/game/specials/generalized.ts`, `src/game/specials/sectortypes.ts`,
`src/game/specials/mapscan.ts`, `src/game/specials/movergeometry.ts`,
`src/game/specials/sectoreffects.ts`, `src/game.ts`

**The trigger half**: what a linedef or sector number means, who may activate it, and the two
effects the controller deals out itself. Six docs carry the rest — the movers a trigger builds are
docs/specials-movers.md, the crusher and what it does to a body docs/specials-crushers.md,
teleporters docs/specials-teleporters.md, the light patterns docs/specials-lights.md, Boom's
parameter lines that change how things *move* docs/specials-forces.md and the ones that change how
a sector is *drawn* docs/specials-transfers.md.

**The data half.** `specials/defs.ts` holds the shapes a special is expressed as — `SpecialDef`, the
`Effect` union, and the speeds/waits/damage amounts those carry. `specials/tables.ts` keys the
vanilla numbers onto them (`LINE_SPECIALS`, `SECTOR_LIGHT_SPECIALS`, `SECTOR_DAMAGE_SPECIALS`,
`SECTOR_DOOR_SPECIALS`). Neither reads a WAD: the linedef numbers are the only WAD-side thing about
them, which is why they sit under `game/` with the controller that drives them rather than in
`wad/`.

**The three files.** `specials.ts` is `SpecialsController`: the movers, the trigger dispatch, the
switch flashes and the light thinkers — everything with runtime state. `specials/mapscan.ts` is the
load-time analysis of a map (`scanSectors`, `findStairChain`, `bossDeathTriggersFor`, …), pure
functions of the `DoomMap` with no controller involved, which is why `mapmesh.ts` can call one
before the controller exists. `specials/movergeometry.ts` (`MoverGeometry`) is everything a height
or light change means for what is actually *drawn*: the per-sector mover meshes, their faders, and
`recolorSector`. The controller mutates `Sector` fields and tells `MoverGeometry` which sectors went
stale; it holds no THREE object of its own. That split is in the constructors too: `SpecialsOptions`
**extends** `MoverGeometryOptions`, so the render half's needs are declared once, by the half that
consumes them, and the controller forwards its own options rather than restating six fields.

That mutation is direct — `Sector.floorHeight`/`ceilHeight`/`light` change on the `DoomMap` itself,
and `World` never caches them, so collision, sight-blocking and resting heights pick a mover's
change up on their very next query with no invalidation step. The controller also has no idea who is
standing where: exits and teleports reach `game.ts` through callbacks (`onExit`/`onTeleport`), and
crush damage and obstruction go through `Occupancy` (`game/specials/moverblocking.ts`) — the layer's
own tests, over the bodies `game.ts` hands it as `SpecialsOptions.occupants`. And a stair builder is not its
own mover type: each step is a plain `FloorMover` rising to a fixed height, over the chain of
sectors `findStairChain` discovered at load time by the same texture-matched adjacency walk
vanilla's `EV_BuildStairs` does at runtime.

The vanilla-only line special table is confirmed against the Doom wiki's linedef type table **and,
where the two disagree, against the real `linuxdoom-1.10` source** — after a first pass briefly (and
wrongly) listed 174 as a vanilla S1 teleport, which is Boom-only. Same story for crusher stop: 58
looks like it could be a third stop-crusher alongside 57/74, but is an unrelated "floor up 24".
`specials/tables.ts`'s own table comments carry the full numbers-to-mechanism mapping.

**Use triggers fire on `Space` *or* the right mouse button**, the latter only while it is bound to
`use`, which is not the default (docs/menu.md § Right mouse button). `handleUseTrigger` asks
`Input.rightMousePressed('use')` rather than reading the setting, and both sources are
edge-triggered, so a held button activates a switch exactly once.

## Scope

**Every vanilla DOOM/DOOM2 linedef and sector special is covered; Boom compatibility is being
added on top.** The vanilla table's gaps were closed by diffing every case in
`P_CrossSpecialLine`/`P_UseSpecialLine` against its keys, directly against
`p_spec.c`/`p_switch.c`/`p_floor.c`/`p_plats.c`/`p_ceilng.c`/`p_doors.c`/`p_lights.c` rather than
assumed. That audit is what turned up `raiseToTexture`, `lowerAndChange`, the one-way
`CeilingEffect`, the delayed doors, the instant `LightChangeEffect`s and the donut — each needing a
genuinely new mechanism. **The table is pinned to exactly the union of the three vanilla dispatch
switches' 138 case numbers** (`tests/game/boom-specials.test.ts`) — the audit alone still missed
three, which only turned up under the Boom work.

Boom's extended non-generalized numbers live in **`BOOM_LINE_SPECIALS`**, a separate table merged
by `lookupSpecial`, each entry transcribed from the Boom dispatch switches. Two genuinely new
mechanisms came with them: **elevators** (227-238, docs/specials-movers.md § Elevators) and the
**motionless change** (78/153/154/189/190/239-241, `EV_DoChange`) — each tagged sector instantly
*copies floor flat and
special from its model (trigger = the line's front sector; numeric = the first neighbor at the
sector's own floor height, nothing when no neighbor matches — though the activation still counts,
so switches flip, vanilla's own `rtn = 1`). Change-only sectors are included in
`scanSectors`' movable set despite never moving: the flat swap needs a per-sector mesh to repaint.

Boom's **parameter lines** are the other family, and they sit outside `LINE_SPECIALS` on purpose:
they configure a permanent property at level spawn rather than being dispatched from a trigger, so
`lookupSpecial` returns null for every one. Two modules own them: `specials/forces.ts` the ones that
change how things *move* — scrollers and conveyors, friction and the pushers
(docs/specials-forces.md § Scrollers and conveyors, docs/specials-forces.md § Friction,
docs/specials-forces.md § Pushers), which bring voodoo dolls with them (docs/specials-forces.md §
Voodoo dolls) — and `specials/transfers.ts` the ones that change how a sector is *drawn*
(docs/specials-transfers.md § Render transfers). `PARAM_LINE_SPECIALS` is the union, and every
number in it is implemented.

**One number is settled as a no-op rather than implemented.** MBF's sky transfer (271 regular,
272 flipped — `p_spec.c`, killough 10/98) points every tagged sector's sky at the transfer line's
own sidedef texture. This engine draws no sky at all: an `F_SKY1` ceiling is simply not built
(`SKY_FLAT` in `wad/map.ts`, docs/render.md § Mesh building), so the transferred texture could
never be seen. `NOOP_LINE_SPECIALS` holds those numbers, and they classify as `noop`. Real WADs do
use it: `literalism.wad` carries 271 on twelve of its maps, up to 107 lines on one, which is how it
surfaced.

**There is no "deferred" bucket.** A number whose mechanism simply hasn't been built classifies as
`unknown` and fails the gate, which is the whole point of the gate. `noop` is not a softer
`unknown` — it is the claim that the number is *settled*, and it costs a paragraph here saying why
each entry can never be seen.

`scripts/inspect-wad.ts` prints a **specials coverage report** — every linedef special classified
vanilla / boom / generalized / param (spawn-time) / no-op / UNKNOWN, and sector specials checked
through `decodeSectorType` — the acceptance gate the Boom work was accepted against, beside lines
counting the scrollers, conveyors, friction sectors, pushers and dolls the level spawned and the
render transfers it carries. **Nothing lands in UNKNOWN** on the WADs checked so far: every Boom
linedef number this engine can meet either resolves to something or is a settled no-op.

## Trigger dispatch

Every trigger path resolves a line's number through **`lookupSpecial` (`specials/tables.ts`)**,
never by indexing `LINE_SPECIALS` directly — that is the seam where Boom's extended numbers and the
generalized bitfield ranges join without reshaping the vanilla table (which stays exactly as
audited, one entry per vanilla number). `PARAM_LINE_SPECIALS` sits beside it: the numbers that are
*not* triggerable effects but level-spawn parameters (vanilla 48's scroll, Boom's scrollers,
friction and pushers in `specials/forces.ts`; the render transfers in `specials/transfers.ts`),
listed so a coverage report can tell "known, handled elsewhere" from "unknown number". Boom
behaviors are confirmed against the boom202 / PrBoom+ source the same way vanilla ones are confirmed
against `linuxdoom-1.10`.

**Activation is data plus an activator.** A def says who a number admits (`monsterActivate` for
walk lines — vanilla `P_CrossSpecialLine`'s seven-number monster allow-list, and Boom's
generalized trigger bit — and for the `use` lines a blocked monster pushes, vanilla
`P_UseSpecialLine`'s own allow-list; `monsterCanTrigger` for shoot lines — vanilla's lone
`case 46`), and the trigger paths say who is at the line — `Activator`, `'player' | 'monster' |
'voodoo'` (docs/specials-forces.md § Voodoo dolls). All walk crossings — player and monster — run
through one scan, `SpecialsController.crossLines`.

## The use trace

`handleUseTrigger` is `P_UseLines` plus `PTR_UseTraverse`: a segment `USE_RANGE` (64 units) long
out of the player's own position along their facing, against **every** linedef it crosses, nearest
first. What each line does to the trace is the whole rule, and the two branches are vanilla's:

- **No special.** `P_LineOpening`'s range decides: a gap the player could stand in
  (`World.openingInto`, `top > bottom`) lets the press carry on to what is behind, anything shut —
  a one-sided wall, a closed door, a floor raised to the ceiling — stops the press dead and grunts
  `noway`. A two-sided line is *not* an opening by virtue of being two-sided: EPIC.WAD MAP01's
  linedef 1105 is a raisable wall whose sector sits at floor 16 = ceiling 16, and before this was
  modelled a press went straight through it into the SR lift switch (linedef 1110) behind, which
  the map means to be reachable only once the wall is down. `LF.BLOCKING` is not consulted — a
  fence or grate over a real opening passes the trace, as it does in vanilla.
- **A spent one-shot counts as no special.** Vanilla zeroes `line->special` when a W1/S1/G1/D1 line
  fires (`P_ChangeSwitchTexture`, `P_CrossSpecialLine`); this engine keeps the number and records
  `usedOnce`, so the trace reads that set. Without it a shot G1 door line kept shadowing the switch
  behind it. **Repro: D5DA3.wad MAP05**, from lift sector 32: G1 line 129 in front of SR switch 119.
- **Any special at all.** The line stops the trace whether or not it fires, so a walk-only number, a
  line met from its back side and a switch whose `EV_` helper refused all shadow what is behind them
  exactly as a switch that worked does. It fires only if it is a `use` special *and* the player is
  on its front side.

**PASSUSE (Boom)** is the one exception to the second branch: a special line carrying `LF.PASSUSE`
lets the trace continue past it, so several stacked specials fire from one press. The vanilla
nearest-special-shadows-everything behavior is the flagless case.

## A switch only flips when it acts

`P_ChangeSwitchTexture` is one operation doing two things — flipping the sidedef to its on-texture
*and*, for a one-shot line, clearing `line->special` so it can never fire again. So the flip, the
`swtchn` click and `usedOnce` all move together in `trigger`, and either all happen or none do.

**`P_UseSpecialLine` calls it inside `if (EV_…)`.** A switch whose EV_ helper returned 0 — every
tag-matched sector already busy, a donut with no ring, a stair chain that couldn't start — is left
untouched and unspent, so the player can press it again once whatever was in the way has finished.
Getting this wrong is worse than a cosmetic bug: an S1 switch consumed by a press that did nothing
is dead for the rest of the level, and on a map where it is the only way to raise a floor or open a
crusher, the level is unfinishable.

The exceptions are exact, not approximate, and `SWITCH_ALWAYS_FLIPS` (`game/specials.ts`) is the
whole list:

- **11 and 51**, the two exits, and **138/139**, the two light switches — vanilla calls
  `P_ChangeSwitchTexture` outside the `if` for these four and nothing else.
- **Manual doors** (1/26/27/28/31–34/117/118), which go through `EV_VerticalDoor` and never reach an
  EV_ return in the first place.
- **Walk and shoot triggers**, unconditional in both `P_CrossSpecialLine` (`line->special = 0` sits
  after the EV_ call, never inside a test) and `P_ShootSpecialLine` (all three of 24/46/47 flip
  unconditionally — this one is worth reading in the source before "fixing", since it looks like an
  oversight and is not).

**The flip is permanent unless the switch is repeatable.** `P_ChangeSwitchTexture`'s second argument
is `useAgain`, and it does two things with it: `if (!useAgain) line->special = 0` spends a one-shot
line, and `if (useAgain) P_StartButton(..., BUTTONTIME)` starts the 35-tic timer that flips the art
*back*. So only an SR/WR switch reverts, so it can visibly be pressed again; an S1/W1 switch is
given no button at all and shows its pressed art for the rest of the level. Running the revert timer
on every switch — which this engine did — makes every one-shot switch in the game flick green and
back to red a second later. `flashSwitch` takes `useAgain` for exactly this.

That also means `switchFlashes` is no longer the full set of pressed switches, which the savegame
restore has to account for: it re-applies on-textures from `switchFlashes` **and** `usedOnce`, since
a permanently-flipped switch has no timer to be found under. (A `usedOnce` line with no switch art —
most of them, all the walk triggers — resolves to no entries and costs nothing.)

Each `trigger*` method therefore returns its EV_ helper's `rtn` rather than `void`: **true only for
a sector that actually took the effect**, which for most of them is exactly
`!sectorActive(sectorIndex)` — vanilla's `rtn = 1` and its `if (sec->specialdata) continue;` are the
same test read two ways. The crusher is the one that isn't; see docs/specials-crushers.md §
Crushers.

## One mover per sector

**A sector already running a mover refuses every new trigger of the same class** — vanilla's
`sec->specialdata`, which Boom splits into three independent slots (`P_SectorActive`, `p_spec.c`).
`EV_DoFloor`, `EV_DoPlat`, `EV_DoCeiling`, `EV_DoDonut` and `EV_BuildStairs` all `continue` past a
busy sector, so the second trigger does nothing at all rather than replacing what's running. Every
`trigger*` method asks before creating a mover.

**The classes are floor, ceiling and lighting**, and only vanilla's `demo_compatibility` folds them
into one. `moverClass` (`game/specials.ts`) is the mapping, read off the C rather than inferred:

| Class | Slot | Kinds |
|---|---|---|
| floor | `floorMovers` | `FloorMover`, `LiftMover`, `ElevatorMover` |
| ceiling | `ceilingMovers` | `DoorMover`, `CeilingMover`, `CrusherMover` |
| lighting | `lightStates` | the blink patterns and `'startStrobe'` |

So a rising floor and a closing door can run on one sector at once, which real Boom maps rely on
and a single slot silently dropped. `floorActive`/`ceilingActive` are the two predicates.
**The elevator claims both** (`EV_DoElevator`'s own `if (sec->floordata || sec->ceilingdata)`); it
is stored in `floorMovers` alone and `ceilingActive` looks for it there, because one object in two
maps would `structuredClone` into two on save and then tick twice on restore.

`'startStrobe'` (17) checks the **lighting** slot — `EV_StartLightStrobing`'s
`P_SectorActive(lighting_special, sec)`, i.e. `lightStates` — so a sector with a door running is
free to start strobing. This engine previously checked the mover map there, vanilla's unified
behavior.

**Three numbers only work because of the split**: 151/166/186, Boom's "raise ceiling, lower floor",
are the only dispatch cases in the whole switch that call two `EV_` helpers (verified by scanning
`p_spec.c`/`p_switch.c` for multi-`EV_` cases — 40 is the only other, and see below). Their floor
half is dead under a unified slot and live under the split. `SpecialDef.secondEffect` carries it:
151 calls both unconditionally, 166/186 are `if (EV_DoCeiling(…) || EV_DoFloor(…))` and so run the
floor **only when no tagged sector could take the ceiling** — C's short-circuit, reproduced as
`onlyIfPrimaryFailed`. Each pass covers every target sector before the next begins, matching the
real order.

**Vanilla 40 is not one of them.** It looks identical, but Boom *deleted* its `EV_DoFloor` call
outside demo compatibility, having marked it `//jff 02/12/98 doesn't work` — so 40 is ceiling-only
in both eras, and docs/specials-movers.md § One-way ceiling movers still describes it correctly.

"Active" is about *state*, not presence. Vanilla removes a thinker and clears `specialdata` the
instant it stops; this engine keeps the finished record, so the predicates read the state: a
`'done'` floor/ceiling, a `'rest'` lift, a `'stopped'` crusher and an `'open'`/`'closed'` door are
all free to be triggered again — and being triggered again means being **rebuilt from the new
trigger's effect**, never resumed on the spent one's terms (docs/specials-movers.md § Retriggering a
door). The two re-triggers vanilla *does* honor are handled by their own callers before this is
consulted — a door reverses (`EV_VerticalDoor`, docs/specials-movers.md § Retriggering a door) and a
stopped crusher restarts (`P_ActivateInStasis`).

**The savegame reads the class back off `mover.kind`, not off which field it arrived in.** A save
written before the split holds every kind in `SpecialsSnapshot.movers`; `ceilingMovers` is a new
optional field. Sorting on restore makes both shapes land correctly with no `SAVE_VERSION` bump —
docs/savegames.md § The format and its version.

**Repro: DOOM2 MAP30's central pillar (sector 12, tag 2).** It carries two specials — a one-shot S1
switch (140, `plus512`) that raises it from −96 to 416 over 14.6 s, and its own four sides (62), a
repeatable lift. Using the lift while the switch's slow rise was still running replaced the
`FloorMover` with a `LiftMover` whose `restHeight` was captured from the *current* height, so the
pillar was stranded at whatever it had reached — around 128, the ledge with the radiation suits, for
a player who walks straight over after pressing the switch. The guard was previously per-mover-kind
and inconsistent: `triggerFloor` only refused another *floor*, and `triggerLift` refused nothing.
The class split does not reopen this: `FloorMover` and `LiftMover` are both floor-class, so they
still contend for the one slot exactly as they did.

## Generalized linedefs

Boom's generalized range (0x2F80–0x7FFF) is decoded on the fly by
`specials/generalized.ts: decodeGeneralized` into the *same* `SpecialDef`/`Effect` shapes the
vanilla table uses — the vanilla table itself is never touched, and `lookupSpecial` memoizes each
decoded number for the session. Every mask, enum ordering and speed/wait tier is transcribed from
boom202/PrBoom+ `p_spec.h`/`p_genlin.c`, never boomref alone. The trigger bits map onto
`{trigger, repeatable, manual}` (Push = manual, acting on the line's back sector like a vanilla
D1 door); the per-family monster bit becomes `monsterActivate` — for floors and ceilings the
model bit doubles as "allow monsters" only when no change is set, and the locked-door family
admits no monsters at all, both per `p_spec.c`'s generalized gates.

Two Boom rules reach the controller as **data on the def** rather than as checks against the raw
number, so `specials.ts` needs to know nothing about the bit layout: `requiresTag` (a line that
acts by tag and has none does nothing — `p_spec.c`'s "all walk generalized types require tag",
set for every non-Push generalized trigger) and `retriggerXor` (the mask Boom's generalized stairs
alternate their build direction with on each successful activation, `EV_DoGenStairs`'
`line->special ^= StairDirection`).

Vanilla performs that alternation by mutating the linedef; this engine **does not touch the map**.
`SpecialsController.retriggerFlips` holds the flipped lines and `lineSpecial(lineIndex)` applies
the XOR on read, which every trigger path resolves through. So the authored number stays the truth
for anything classifying lines (`classifyLineSpecial`, the coverage report, `findSwitchEntries`),
and a restore is a plain Set assignment — `SpecialsSnapshot.stairFlips` needs no ordering
guarantee about when the map was loaded, unlike a re-applied mutation would.

Known divergence, deliberate: `FtoLnC` keeps the engine's own clamp-to-own-ceiling, which only
differs on degenerate maps. Generalized floors and ceilings otherwise honour their direction bit in
full, including the clamp a target on the "wrong" side of it gets — docs/specials-movers.md §
Inverted plane moves.

## Generalized sector types

Every interpretation of `Sector.special` — the light seeding, the movable-sector scan, the
delayed-door spawn, and `SectorEffects`' damage/secret checks — goes through **one decoder**,
`decodeSectorType` (`specials/sectortypes.ts`), never an exact-equality table hit on the raw
value. Below 32 the vanilla tables apply unchanged. From 32 up the value is Boom's bitfield
(`p_spec.h`): bits 0-4 carry the vanilla behaviors (Boom runs its spawn switch on
`special & 31`, so a generalized sector's low bits get the light patterns *and* the 10/14 door
timers), bits 5-6 pick a damage class (none / 5 / 10 / 20 HP per interval — only the 20 tier
rolls the radiation-suit leak, matching vanilla 16/4), bit 7 marks a secret, bit 8 enables
per-sector friction and bit 9 pushers (both decoded now, consumed when those Phase-3 systems
land).

Consuming a secret differs by era, per `P_PlayerInSpecialSector`: vanilla 9 zeroes the whole
special; the generalized bit clears only itself — and if nothing but low bits remain, Boom zeroes
the special outright (`consumeSecret`). Secret totals count both forms once at load
(`SectorEffects`' constructor).

## Damage floors

`SECTOR_DAMAGE_SPECIALS` is vanilla's `P_PlayerInSpecialSector`: nukage (7, 5 HP), hellslime (5, 10
HP), super hellslime (16, 20 HP) and strobe-hurt (4, 20 HP), all every `DAMAGE_FLOOR_INTERVAL`, plus
E1M8's finale special (11, 20 HP, which also ends the level once it drops the player to 10 HP or
below — vanilla's inline `G_ExitLevel()` in that same case).

That exit test sits **outside** the damage pulse and has **no lower bound**, both as in vanilla's
`case 11`, where `if (player->health <= 10) G_ExitLevel();` follows the `!(leveltime&0x1f)` hit
rather than living inside it. So a player who steps in already under 10 HP exits on the spot, and —
the case that matters on E1M8's own sector 66 — a full-health player, whose 100 HP the 20-HP pulses
walk straight down through 20 to 0, exits on the pulse that kills them. Requiring them to still be
alive left that player dead in the pit with the level never ending, which is the one way most
players meet this sector. The corpse still gets its exit: `pendingExit` is queued on the same frame
and `Game.endingOverCorpse` takes the death overlay back down (docs/death.md § Dying on the way
out).

**A death from anything else in that sector ends the level too** — `SectorEffects.exitsOnDeath`,
asked by `damageSlot` on the killing hit. This one is a deliberate deviation: vanilla only ever
runs the check from `P_PlayerInSpecialSector`, and `P_PlayerThink` returns at `PST_DEAD` before
reaching it, so a monster finishing the player off in E1M8's pit leaves them dead in it with the
episode unwon. The sector exists to end the episode over the player's body; *what* killed them there
is not a distinction the player can see. It is also the one check deliberately **not** gated on
`player.z === floorHeight`, unlike the damage above — the corpse need not have landed. `pendingExit`
is set before the death overlay is armed, so `levelEnding` keeps it from being raised at all rather
than clearing it a frame later.

**Player-only**, matching vanilla, which passes a `player_t*` and never damages monsters this way.
Dealt directly in `game/specials/sectoreffects.ts: SectorEffects.update` rather than through
`SpecialsController` — a damage floor has no mover, nothing for that machinery to own, just
`sector.special` plus the player's live position, so it's checked once a frame off `World.sectorAt`.
That same method also covers special 9 (§ Secret sectors below) — both are cases of the one vanilla
switch this method reimplements.

Gated on `player.z === sector.floorHeight` (vanilla's `mo->z != sector->floorheight` guard, skipping
a player still falling in) — deliberately the *local* 2D-position sector's own floor, **not**
`World.groundFloor` (which reads a straddled ledge's higher side), so standing on a ledge next to a
damage pit doesn't damage the player until they step down into it.

Special 4 is *also* one of the sector-type light-blink specials: vanilla spawns the same non-synced
fast strobe sector type 2 gets and then explicitly restores `sector->special = 4` so the damage
check still sees it. This engine never clears `sector.special` after seeding a light pattern in the
first place, so 4 living in both tables works without reproducing that restore step.

A radiation suit gates the damage per type (`DamageFloorEffect.suit`,
`game/specials/sectoreffects.ts: suitBlocks`) exactly as `P_PlayerInSpecialSector` does — see the
powerups doc for why the five types don't all treat it the same.

E1M8's finale is actually two mechanisms working together: docs/death.md § Boss death is what
lowers the tag-666 floor that exposes this special-11 pit in the first place; this section is just
what happens once the player steps down into it.

## Secret sectors

`sector.special === 9` is vanilla's "SECRET SECTOR" — handled in the same `case` statement as the
damage floors above, by the same `game/specials/sectoreffects.ts: SectorEffects.update`, under the
same `player.z === sector.floorHeight` guard. Entering it increments `SectorEffects.secretsFound`
and clears `sector.special` back to 0, matching vanilla's own
`case 9: player->secretcount++; sector->special = 0;` exactly — the clear is also what prevents a
second frame from double-counting, no separate "already found" flag needed.
`SectorEffects.totalSecrets` is counted once per level load, straight off `map.sectors`, mirroring
vanilla `P_SpawnSpecials`' own `case 9: totalsecret++`. See docs/hud.md § Level stats for where
these numbers surface on screen.

`update` reports the entry back to `game.ts` (`SectorEffectResult.secretFound`, true on that one
frame only) rather than just bumping the counter, because finding a secret also announces itself —
a center-screen message and the `secret` chime, neither of which vanilla does. docs/hud.md §
Center messages.
