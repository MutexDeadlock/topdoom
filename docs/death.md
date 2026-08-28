# Death: monsters, the player, barrels and boss triggers

`src/game/things.ts`, `src/game/things/tables.ts`, `src/game/combat.ts`, `src/game/specials.ts`,
`src/game.ts`

How the damage that gets here was dealt is docs/combat.md.

## Monster death

**Health and death-frame sequences are confirmed against the actual lump names in
DOOM.WAD/DOOM2.WAD.** Health values are vanilla's `mobjinfo` constants, but the death *frame
letters* are derivable from the WAD directly: death art in vanilla is rotation-0 (omnidirectional)
only, so the point where a sprite's directional (rotation 1-8) frames stop and its rotation-0 tail
begins marks exactly where movement/attack/pain art ends and death art starts. Confirmed by dumping
every monster sprite's frame/rotation pairs from the real IWADs and cross-checking against known
vanilla death-state counts (POSS's rotation-0 tail is 14 letters, split 5 DIE + 9 XDIE, matching the
zombieman exactly).

`MONSTER_DEATH_FRAMES` takes the DIE half; `MONSTER_XDEATH_FRAMES` the XDIE (gib) half where one
exists at all — only five monster types in stock DOOM have gib art (the human grunts and the imp);
everything else, including similarly-sized monsters like the demon, has no `xdeathstate` in vanilla
and always plays its plain death. `ThingLayer.damage` picks between them exactly as `P_KillMobj`
does: gib only if the killing blow pushed health below *minus* the monster's own max health *and*
gib art exists for that type. Commander Keen (a pain cascade with no distinct DIE state) and the
boss brain (2 sprite frames total, no death art) are deliberately absent from both — `damage` falls
back to just hiding a killed monster with no entry.

A death is a **permanent, one-way animation switch, not a new actor**: `SpriteActor.die` overrides
the alive walk cycle with a one-shot sequence that advances forward and holds its last frame
forever, reusing the same mesh/materials rather than spawning a second object — cheaper, and it
means a corpse still participates in fog-of-war fading exactly as it did alive.
`ThingLayer.damage(id, amount)` — `id` being the stable index `pickMonster`/`monstersNear` hand back
— subtracts health and calls `die` at 0; `pickMonster` skips anything already dead so a corpse can't
be re-targeted.

**A corpse left in the air falls.** `P_KillMobj` strips `MF_NOGRAVITY` from everything it kills
except `MT_SKULL`, so a cacodemon shot off its hover (docs/monster-ai.md § Floating monsters) or a
body caught mid-launch by an arch-vile drops to the floor instead of hanging there; a lost soul
keeps its flag and dies where it was. `ThingLayer.update` runs that fall in its dead branch, gated
on the thing's own cached sector floor so the overwhelming majority of corpses — already resting on
it — cost no world query at all.

**Two types don't leave a corpse: the lost soul and the pain elemental.** Every other monster's
final death state has `tics: -1` ("hold forever"), which is what makes a corpse permanent, but
`S_SKULL_DIE6` and `S_PAIN_DIE6` both have a finite tic count and fall through to `S_NULL` — and
transitioning *to* `S_NULL` is what makes vanilla call `P_RemoveMobj`. `MONSTER_CORPSE_VANISHES` is
exactly those two doomednums; `ThingLayer.update` hides either type's corpse the instant `deadTime`
reaches the end of its death animation. Both are the game's floating monsters, which tracks
thematically, but nothing keys off "flying" — only the two confirmed doomednums.

This has a second consequence for the pain elemental: its mobjinfo *does* carry a real `raisestate`
(hence its entry in `MONSTER_RAISE_FRAMES`), but `PIT_VileCheck`'s `if (thing->tics != -1) return
true; // not lying still yet` requires a settled corpse — which a pain elemental's never reaches
before `P_RemoveMobj` deletes it. So despite the mobjinfo entry, a dead pain elemental can never
actually be resurrected in real vanilla either. This engine reproduces the same unreachability
structurally rather than adding a third special case: `ThingGrid.rebuild` never buckets a `hidden`
corpse into `corpseGrid`, and a pain elemental's corpse is always hidden by the exact moment
`findRaisableCorpse`'s "finished settling" gate would start accepting it — both keyed off the same
`deadTime` threshold.

**A killed monster can drop an item**, lifted from `P_KillMobj`, which has exactly three `switch`
cases: the zombieman and Wolfenstein SS drop a clip, the shotgun guy a shotgun, the chaingunner a
chaingun (`MONSTER_DROPS`). Everything else, including monsters that feel like they obviously should
(the imp, the demon), drops nothing. `ThingLayer.damage` spawns the drop inline the moment it marks
a monster dead — via a `spawnDrop` helper that's the same pose/push the map-load loop does, for one
instance — so a drop appears no matter *how* the kill happened (direct hit, splash, gib, crusher),
matching vanilla dropping from that one function regardless of cause. Each `PosedThing` carries a
`dropped` flag, seeded `true` only for a `spawnDrop` instance and threaded through `tryPickup`'s
`consume` callback into `applyPickup`'s `dropped` param — vanilla's `P_GiveAmmo`/`P_GiveWeapon` give
a dropped pickup's ammo at half the rate of a map-placed one (a dropped clip's 5 bullets vs. 10, a
dropped shotgun's 4 shells vs. 8).

`spawnDrop`, `spawnLostSoul`, `spawnMonster` and the map-load loop all build their `PosedThing`
through one shared `pushThing` helper. That is worth naming because the alternative was four copies
of a ~60-field object literal, three of which already existed and had begun to drift — `spawnDrop`'s
copy, for instance, had no `INERT_SHOOTABLE` radius lookup because it predated one.

## Telefrag

Vanilla's `P_TeleportMove` kills everything standing where a body lands, for a flat `10000` damage
(`TELEFRAG_DAMAGE`). `ThingLayer.telefragAt` is that stomp — `PIT_StompThing`, the per-body half —
and three arrivals reach it:

| Arrival | Stomps? |
|---|---|
| The player off a teleport pad (`game.ts`'s `onTeleport`) | Always |
| A monster off a teleport pad (`game.ts`'s `thingCrossedLines`) | Only on map 30 |
| The Icon of Sin's spawn cube (`ThingLayer.spawnMonster`, `A_SpawnFly`'s tail) | Always — it only flies on MAP30 anyway |

**A monster that isn't allowed to stomp doesn't teleport at all.** `PIT_StompThing`'s
`if (!tmthing->player && gamemap != 30) return false;` fails `P_TeleportMove`, and `EV_Teleport`
returns 0 on a failed move — so anything standing on the far pad (another monster, a barrel, the
player) leaves the monster exactly where it was, and *nothing* is damaged: vanilla bails on the
first body in the way, before dealing any of the stomps it would otherwise have dealt. The gate is
`monstersTelefrag(mapName)`, vanilla's `gamemap` check, resolved once per level at load the way the
boss-death table is. The one-shot line is still spent (§ Teleporters in docs/specials.md), same as
any other blocked teleport.

Only **shootable** bodies are stomped or block: monsters and barrels, `MF_SHOOTABLE`. A solid
decoration is neither — a floor lamp on the landing pad is passed straight through. The overlap is
`bodiesOverlap`, the summed-radii **box** every body-vs-body test in this engine uses
(docs/movement.md § Collision) and the one `PIT_StompThing` is written with; every half of every
arrival goes through that one predicate, because a stomp that reached past what collision counts as
occupied would leave a monster standing inside another one. The test is 2D and height-blind,
matching `PIT_StompThing`, which never looks at `z`, so a cacodemon hovering over the pad still
dies. Only the *reach* varies: the cube's player half uses a fixed `PLAYER_TELEFRAG_RADIUS` rather
than the spawned body's own (see that constant).

The kill is **deliberately unattributed** — no `source` is passed to `damageThing`. A telefrag is
the teleport's doing, not an attack, and naming the arriving body as the source would start an
infight it never picked. (Vanilla does pass `tmthing`, but nothing survives 10000 damage to act on
it.)

Every arrival is split across two files for the usual reason: `ThingLayer` has no player reference,
so it telefrags every overlapping `PosedThing` itself, and the caller does the player half against
`PLAYER_RADIUS` — `game.ts` for a teleport, `game/monsters/iconofsin.ts` for the spawn cube. That is
what makes standing on a MAP30 spawn spot, or on the pad a monster is about to arrive on, a real way
to die. A dead player is neither stomped nor in the way: `P_KillMobj` strips the `MF_SHOOTABLE`
`PIT_StompThing` gates on.

## Player death

**Reuses the exact same mechanism** on `game.ts`'s single persistent `playerActor`:
`PLAYER_DEATH_FRAMES` (`H`-`N`) is `PLAY`'s own confirmed DIE half, derived the same way as the
monster tables — and living beside them in `game/things/tables.ts`, not in `game/player.ts`, which
owns no sprite.

`Inventory.applyDamage` is vanilla's `P_DamageMobj` armor formula — green armor absorbs a third of
the damage, blue half, spending armor points 1-for-1 with whatever it absorbed and falling back to
bare once it runs out mid-hit — reused for the player specifically since monsters have no armor. It
returns whether the hit actually landed, `false` while invulnerability blocked it outright
(`INVULNERABLE_DAMAGE_LIMIT`); `damagePlayer` uses that to skip the pain flash and flinch animation
for a hit that did nothing, which a first version didn't check, so an invulnerable player flashed
red on every hit that was landing on nothing.

Health hitting 0 sets `Game.playerDead`, which freezes only the input-driven half of `frame` —
movement/aim/firing/pickups. Everything else keeps running: fog of war, effects, faders and
rendering, and monster AI — but AI follows vanilla's own rule for it, not a blanket freeze.
`P_KillMobj` strips the player's `MF_SHOOTABLE`/`MF_SOLID` on death, so `Game.updateThings` passes
`ThingLayer.update` `null` for the player once `playerDead` (`game/things.ts`'s `resolveTarget` and
`blockersFor` both take the `Pos3 | null` this produces). A monster already mid-infight with another
monster is unaffected and keeps fighting; one whose only target *was* the player finds
`resolveTarget` reporting no target the very next frame and reverts to idle right there —
`p.alerted = false`, `movedir`/`movecount` cleared — the same as `A_Chase`'s own "no shootable
target" branch falling through to `P_SetMobjState(spawnstate)`. It only wakes again via `damage`'s
unconditional re-alert (getting caught in someone else's infight), same path any other dormant
monster uses. A rocket or vile blast already in flight still lands and can still deal splash (or,
for the vile's knockup, do nothing beyond the first killing blow — `resolveVileBlast` gates its
knockup on `damagePlayer`'s return, and `resolveBullet`'s `!playerDead` guard for the hitscan
equivalent) — a dead player can still be "hit" for nothing to happen, matching `damagePlayer`'s own
early return.

The death itself shows `#death-overlay` (`ui/hud/deathoverlay.ts`) — three `WadFont` canvases in the
`EndCard` arrangement, the IWAD's own type rather than DOM text: the heading in STCFN's native HUD
red, the killer line in `COLOR_YELLOW`, the hint in red dimmed by CSS. A canvas is always `:empty`,
so the "nothing attributed the blow" case that used to be a `:empty` selector is now a `blank` class
the drawing code sets. It does not go up immediately: `DeathOverlay.show` only *arms* it, and
`DeathOverlay.update` raises it `DEATH_OVERLAY_DELAY` later — `PLAY`'s DIE sequence end to end, so
the text arrives as the corpse settles instead of on the killing frame. Nothing is gated behind the
delay (`R` answers throughout, since `tic` reads `playerDead`, not the overlay), and a
`DeathOverlay.clear` inside the window means the overlay is never seen at all, which is what § Dying
on the way out needs. Vanilla has no overlay here, so none of this is a fidelity claim.

`R` calls `restart`, which reloads the level from one of three states, in this order.

**A savegame of this level, when there is one.** `Game.savedState` is the snapshot the level is
currently being played out of: what it was loaded from (the constructor's `restore`) and every
manual save taken since. The latter is `saveVia`'s doing — the menu hands it the store call to
make and it captures, writes and moves `savedState` only if the write came back, the same trio
`writeCheckpoint` keeps together. Dying after loading or saving therefore returns the player to
*that* moment rather than to the level's start, which is what "reload" means everywhere else and
what the overlay's own hint promises. This path is synchronous: the snapshot is in memory and came
from this very session, so there is no store read and no `matchesSession` check to make. It is
dropped by `enterLevel`, the only way out of a level — a savegame belongs to the level it was taken
on, and the checkpoint that call writes takes over from there. Applying the same snapshot twice is
safe by construction: every `restore` on the load path copies or re-derives out of it and none
retains a reference into it (docs/savegames.md § Apply order).

**Otherwise the checkpoint** written when the player advanced into the level (docs/savegames.md §
The checkpoint) — so the health, armor, ammo and weapons carried in are what the level restarts
with, and the inventory comes out of the snapshot.

**Otherwise a plain reload**, what `R` always did: a fresh `Inventory` and a bare `loadMapByIndex`.
That covers no checkpoint written this session (the first level of a run), one that no longer
matches map/skill/WAD set, and a store that refused the read.

None of the three is a special case, just the ordinary map-load path, which already resets
player/world/specials/fog for a normal transition and, via its own top-of-function reset,
`playerDead`/the overlay/`playerActor`'s animation state too. The one wrinkle is the checkpoint's:
reading it is async while `tic` is not, so `restart` dispatches and returns, `restarting` swallows a
second press, and `disposed`/`playerDead` are re-checked after the read because the menu can have
started another level meanwhile.

**The overlay's hint names which of the two the press will do** — "press R to reload last savegame"
against "press R to restart" — because reloading a save and restarting the level are different
promises to make to a player standing over their own corpse. `damagePlayer` passes
`DeathOverlay.show` whether a savegame is in hand and `DeathOverlay` owns the wording, the same
split the killer line uses. Only the savegame can be answered for at death time: whether a
*checkpoint* is readable is a store read away, so both level-reload outcomes share the one hint,
which is a distinction the player has no reason to care about anyway.

### Who killed the player

The overlay's middle line names the killer — "You were killed by an Arch-Vile". `damagePlayer`
takes a `DamageCause` (`game/combat.ts`) alongside the hit and only the killing one reads it;
`things/tables.ts`'s `obituary` looks the line up and `DeathOverlay.show` draws it, so the view
layer composes nothing. An unattributed cause renders as `''` and the overlay looks exactly as it
did before the line existed.

A cause is either a doomednum or one of three strings for the killers with no attacker behind them:
`'self'` (the player's own splash), `'crush'`, `'slime'`. Either way it keys straight into
`OBITUARIES`, which holds each line **whole** rather than a name to interpolate — a DEH patch's
`OB_*` string replaces a line entire, and docs/dehacked.md § Obituaries is why the table is shaped
that way. `OBITUARIES.default` is the fallback for a cause with no line of its own; it is `''`
until a patch sets `OB_DEFAULT`.

Vanilla has no obituaries at all, so none of the wording here is a fidelity claim.

Every attack path already carried the identity for `ThingLayer.damage`'s retaliation rule and simply
dropped it on the player branch; each now passes it on: melee and the lost soul's charge plus
hitscan (`monsters/attacks.ts`), a missile's arrival (`projectiles.ts`), the vile's blast
(`monsters/vile.ts`), the spawn cube's telefrag (`monsters/iconofsin.ts`). Splash is the one that
can't just reuse `source`: `applyRadiusDamage` defaults `cause` to `source?.type`, but a barrel
blames the barrel rather than whoever set it off, and a rocket of the player's own carries no
`source` at all, so both pass it explicitly. Crushers and damage floors keep their
`(amount) => void` callbacks — their cause is fixed per wiring site, so `game.ts` binds
`'crush'`/`'slime'` where it builds them.

### Dying on the way out

**A level can end over the player's corpse, and when it does the exit wins: no overlay, no `R`, and
a reborn player on the next map.** The repro is SCYTHE.WAD MAP10, whose intended exit is shooting
the ring of barrels around the boss brain in sector 64 while standing close enough to die with it.
Two separate things went wrong there, and both are worth keeping straight.

**The exit has to survive the death at all.** The brain has 250 health and each of the eight
adjacent barrels deals 112 at that range, so it takes three explosions to kill — while the player
next to them usually dies on the second. `applyRadiusDamage` damages bodies before the player
*within one blast*, but a chain is many blasts, so which of the two dies first is a matter of how
the chain happens to run: the same map exited instantly on one attempt and became unexitable on the
next. `A_BrainDie` is a bare `G_ExitLevel` with no player-alive check (§ Boss death), so the icon
is now notified over a corpse and the exit fires either way.

**The overlay must not appear in front of the exit.** `Game.levelEnding` — a queued `pendingExit`,
or `IconOfSin.exiting` while the `BRAIN_DEATH_TO_EXIT` death cascade runs — is the window in which
the level is over but hasn't finished saying so, and it is several seconds wide for the icon.
`damagePlayer` arms no overlay inside it, and a death that got in first is taken back down by
`endingOverCorpse`, which every site that can open the window calls unconditionally. `R` is refused
there too, which is the real hazard: an overlay offering "press R" over a level the player has just
*finished* would restart it. `saveRefusal` is deliberately **not** widened to `levelEnding` — a save
taken mid-cascade restores mid-cascade, since `IconSnapshot` carries `exitTimer`.

E1M8's sector 66 is the other site of the same shape, and the vanilla one: its special-11 floor
exits at 10 HP or below, which for a full-health player is the 20-HP pulse that takes them from 20
to 0 (docs/specials.md § Damage floors). The queued exit and the death land on the same frame there
— and, by the deviation that section records, they do so for *any* death in that sector, which is
why `damagePlayer` queues the exit itself before arming the overlay.

**The two deaths are usually a few tics apart, not simultaneous**, so cancelling the overlay is not
enough on its own — MAP10's chain kills the player one blast before the brain, and an overlay raised
on the killing frame flashes up for those tics before `endingOverCorpse` reaches it.
`DEATH_OVERLAY_DELAY` (§ Player death) is what closes that: the overlay is armed on death and only
raised once the corpse has finished falling, which is far longer than any barrel chain takes to
finish, so the disarm always wins.

**The reborn is `G_PlayerReborn`**, and it is read off player state at load rather than queued at
the exit, exactly as vanilla does it: `G_ExitLevel` has no player-state check at all, and it is
`G_DoLoadLevel` that turns a `PST_DEAD` player into `PST_REBORN` for the next map. So `enterLevel`
simply asks whether the player is dead and, if so, installs a fresh `createInventory()` before the
map load — before, because `loadMapByIndex` hands the inventory object it finds to
`weaponSystem.beginLevel`. That fresh inventory is what vanilla's `memset(p, 0, …)` plus its
explicit re-fills come to: 100 health, no armor, fist + pistol with 50 bullets, no backpack. Without
it the player would walk into the next level alive on 0 health, dying to the first scratch.
`restart` is untouched by this — it never goes through `enterLevel`, and restores its checkpoint
(§ Player death).

One other caller asks for the same fresh inventory with the player alive: crossing from an episode's
`E<x>M8` into the next episode's `E<x+1>M1`, which is `G_DeferedInitNew` rather than a level change
and so pistol-starts. `enterLevel`'s `reborn` parameter is that request — the same code path, said
out loud instead of inferred from `playerDead` (docs/hud.md § End card).

## Exploding barrels

`src/game/things.ts`, `src/render/sprites.ts`, `src/game.ts`

Vanilla's `MT_BARREL` has no AI at all — a plain `MF_SOLID|MF_SHOOTABLE` prop, not a `MONSTER_TYPES`
member, so none of the monster AI applies. It still needs to plug into almost every piece of
machinery a monster does (solid collision, hitscan/projectile/splash/melee hit-testing, auto-aim
lock-on), which vanilla gets for free because none of those systems know what "monster" means — they
only check `MF_SHOOTABLE`/`MF_SOLID`. This engine's equivalent generic layer is `ThingLayer`'s
`blockerGrid`, so a barrel joins that grid alongside every `MONSTER_TYPES` thing
(`ThingGrid.rebuild`, `solidBodies`, `pickMonster`) rather than needing a parallel set of spatial
queries — `raycastMonster`/`monstersNear` become barrel-aware for free, which is what lets a rocket,
a stray pellet, a monster's own fireball or another barrel's blast all hit one. The purely-solid
decorations (`SOLID_DECORATION_TYPES`, docs/movement.md § Solid decorations) join the same grid for
movement but are explicitly filtered back out of `raycastMonster`/`monstersNear` — unlike the
barrel, none of them carry vanilla's `MF_SHOOTABLE`, so a shot must pass through one rather than
stop on it.

**Only `ThingLayer.damage`'s death/pain behavior is special-cased**, gated on `ThingType.barrel`
(2035): no painstate (`MT_BARREL` has `painchance = 0`), no alerting, no infighting retarget (it has
no AI), and a kill switches its sprite to `BEXP` instead of picking from the death/xdeath tables — a
barrel's idle art (`BAR1`) and its explosion art are genuinely different lumps, unlike every stock
monster, whose death states reuse the same sprite name. `SpriteAnimator.die`'s optional third
`spriteName` argument exists for this; the only other caller is a DEHACKED patch that aims a
monster's death at another sprite's chain (`MONSTER_DEATH_SPRITE_OVERRIDE`, docs/dehacked.md §
Frames).

**`A_Explode` fires partway through the death animation, not instantly on death** — `S_BEXP1`
through `S_BEXP3` each hold 5 tics before `S_BEXP4` calls it, so `BARREL_CHAIN.explodeDelaySeconds`
is 15 tics, three frames at `BARREL_CHAIN.deathFrameSeconds` (a flat per-frame rate standing in for
vanilla's uneven 5/5/5/10/10, the same simplification `MONSTER_DEATH_FRAME_SECONDS` makes). It was
two frames until the DEHACKED frame walker re-read the chain and found the action on the fourth
state, not the third (docs/dehacked.md § Frames). `ThingLayer.update` ticks this off the
same `deadTime` clock it already ticks for every dead thing and reports it back as a
`BarrelExplosion` (`{x, y, z, source}`) once due — the same "the layer reports, someone else
realizes" split as `MonsterAttackEvent`, bundled alongside it in `ThingUpdateResult` rather than
folded into the same array. `game.ts` realizes this one (`applyBarrelExplosion`); `MonsterAttacks`
realizes the attacks. No separate visual effect is spawned: the barrel's own `PosedThing` is already
playing `BEXP` at exactly that position. `S_BEXP5` falls through to `S_NULL`, i.e. the debris is
removed once the animation finishes, the same rule `MONSTER_CORPSE_VANISHES` reproduces — a barrel
just isn't a `MONSTER_TYPES` member, so it gets its own copy of the check.

**The blast is `applyRadiusDamage`, exactly the rocket's own splash** — `A_Explode`'s literal call
is `P_RadiusAttack(thingy, thingy->target, 128)`, identical radius and damage. `source`
(`PosedThing.explodeSource`, captured in `damage` at the moment the barrel died, `null` meaning the
player) stands in for `thingy->target` and is what makes a chain attribute correctly: since
`applyRadiusDamage` walks the now-barrel-inclusive `monstersNear` and calls `damage` on what it
finds, a second barrel caught in the blast is killed through the same call a monster would be, which
captures this same `source` onto *it* and queues its own explosion a frame later — propagating the
original attacker down the whole chain rather than attributing each link to the barrel before it,
matching vanilla's `bombsource` propagation. The spider mastermind/cyberdemon splash exemption
applies here for free.

**A crusher can kill a barrel**, exactly as vanilla's crush damage (real `P_DamageMobj` against
anything `MF_SHOOTABLE`) allows — `ThingLayer.crushablesInSectors` covers barrels alongside
`MONSTER_TYPES` for this one caller, rather than widening the `MONSTER_TYPES`-gated
`monstersInSector` every other system relies on. See docs/specials.md § Crushers.

## Boss death

`A_BossDeath` (`p_enemy.c`) is the one special this engine drives from a monster's death rather than
a linedef or a sector type: once every monster of a specific doomednum is dead **and** on a specific
map, it fires a level-wide action. Confirmed directly against the real source (fetched from
`raw.githubusercontent.com/id-Software/DOOM`) rather than assumed, tracing both the top-of-function
map/type gate and the victory-section action switch:

| Map (lump name) | Dies | Action |
|---|---|---|
| E1M8 | Baron (3003) | tag 666, `lowerFloorToLowest` |
| E2M8 | Cyberdemon (16) | exit level |
| E3M8 | Spider Mastermind (7) | exit level |
| E4M6 | Cyberdemon (16) | tag 666, blaze-open door |
| E4M8 | Spider Mastermind (7) | tag 666, `lowerFloorToLowest` |
| MAP07 | Mancubus (67) | tag 666, `lowerFloorToLowest` |
| MAP07 | Arachnotron (68) | tag 667, `raiseToTexture` |
| any other episode's map 8 (e.g. SIGIL's E5M8) | any of the above five | exit level |
| **any map at all** | **Commander Keen (72)** | **tag 666, `open`** |
| every other map | — | nothing |

The last row before Keen's is real, not a guess: vanilla's `switch(gameepisode)` has a `default`
case with no per-type check at all, only `if (gamemap != 8) return;` — an unrecognized episode's map
8 exits on whichever of the five boss types happens to die last. `bossDeathTriggersFor`
(`game/specials/mapscan.ts`) is a pure function of `map.name` (`E1M8`, `MAP07`, …) that reproduces
this whole table, gating on the map's own lump name rather than which WAD supplied it — a PWAD's own
MAP07 gets DOOM2's exact Mancubus/Arachnotron triggers, matching vanilla, which only ever looks at
`gamemap`.

**Commander Keen's row is deliberately not part of that switch.** `A_KeenDie` is a *separate action
function* from `A_BossDeath`, and it has no `gamemap` check at all — it builds a synthetic `line_t`
with `tag = 666` and calls `EV_DoDoor(&junk, open)` wherever the last Keen happens to die. So
`bossDeathTriggersFor` appends it to every map's table rather than listing it per map, and 72 is
added to `things/defs.ts`'s `DEATH_NOTIFY_TYPES` rather than to `BOSS_DEATH_TYPES` — the latter's
values are what the `default` branch maps over to build the "any of the five exits on map 8" row,
which must not pick Keen up. The `open` kind is `EV_DoDoor`'s ordinary `VDOORSPEED` open-and-stay,
distinct from E4M6's `blazeOpen`. The Icon of Sin (88) is in `DEATH_NOTIFY_TYPES` too but has no row
here at all: `A_BrainDie` exits the level directly rather than through a tag, and
`game/monsters/iconofsin.ts` owns it — see docs/monster-iconofsin.md.

**A boss-death tag has no triggering linedef, and `scanSectors` has to be told.** That
function builds the set of sectors pulled out of the static render batch by scanning sector specials
10/14 and *linedef* specials — neither of which can see a sector that only ever moves via
`triggerTag`. Without `bossDeathSectors` feeding it the tags from this table, such a sector stays in
the static batch and is then drawn a *second* time the moment `MoverGeometry` gives it a mover
mesh, leaving the old geometry frozen at its original height underneath. Two stock cases have no
linedef carrying their tag at all and hit this: DOOM2 MAP32's Keen door (sector 16, tag 666) and
MAP07's Arachnotron platform (sector 1, tag 667).

**Split across three files, the same "system reports, `game.ts` realizes" shape as
`onCrush`/`onExit`/`crossLines`:**

- `game/things.ts`'s `damage()` death branch is the only place that can answer "is this the last
  living one of its type" — it already has `posed` in scope, the same array the pain elemental's
  triple-spawn special-case reads. It reproduces vanilla's own thinker scan
  (`posed.every(q => q.type !== p.type || q.dead)`) and, if true, calls the optional `onBossDeath`
  callback `buildThingSprites` was given — the same "callback bundle" shape `sfx: SoundEmitter`
  already uses there, not a return value threaded back through `ThingUpdateResult`, since a death
  can happen from any of `game.ts`'s many `things.damage()` call sites, not just inside `update()`.
- `game/specials.ts`'s `SpecialsController.notifyBossDeath` owns the actual per-map table
  (`bossDeathTriggers`, resolved once from `map.name` in the constructor) and dispatches to either
  `onExit(false)` or a new `triggerTag(tag, kind)`. `triggerTag` reuses the existing
  `triggerFloor`/`triggerRaiseToTexture`/`triggerDoor` movers exactly as a linedef special would,
  scanning `map.sectors` for the tag directly since there's no triggering linedef to run
  `resolveTargets` on. `triggerFloor`'s `line` parameter is optional for exactly this caller — it's
  only ever dereferenced for `changeTexture`, which a boss-death `lowerFloorToLowest` never sets.
- `game.ts` fans the doomednum out to **both** owners from the callback passed into
  `buildThingSprites` — `this.specials.notifyBossDeath(type, !this.playerDead)` and
  `this.icon.notifyBossDeath(type)`. Each ignores the types it doesn't handle, so neither needs to
  know the other's table. `playerDead` is `Game`'s own state, hence the gate being passed in rather
  than read where it is used.

**The player-alive gate is `A_BossDeath`'s alone.** Vanilla's "make sure there is a player alive for
victory" loop is in that one function; `A_KeenDie` and `A_BrainDie` are separate action functions
and neither has one (confirmed in `p_enemy.c`). So the icon is never gated at all, and inside
`SpecialsController.notifyBossDeath` the flag is applied **per row**, not per call: rows that came
from `A_BossDeath`'s own switch carry `needsLivingPlayer`, Keen's does not. That keeps the fact
beside the row it describes — `bossDeathTriggersFor` builds Keen's entry at the `KEEN_DOOR_TAG`
comment that already explains the *other* gate `A_KeenDie` skips. See § Dying on the way out for
what the gate cost when it was applied to the whole call.
