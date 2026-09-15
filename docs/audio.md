# Sound

`src/audio/sfx.ts`, `src/audio/audio.ts`, `src/wad/sound.ts`, plus the emitter calls in `game.ts`,
`game/things.ts`, `game/monsters/ai.ts`, `game/monsters/attacks.ts`, `game/specials.ts`,
`game/weapons.ts`, `game/projectiles.ts` and `game/spritefx.ts`

Every sound but one comes out of the loaded WAD (the exception is the secret chime, § Player and
pickups), and every sound's *timing and choice* comes from
`linuxdoom-1.10` — `sounds.c`'s `S_sfx[]` table, `info.c`'s `mobjinfo` fields, and the
`S_StartSound` call sites in `p_enemy.c`/`p_pspr.c`/`p_inter.c`/`p_doors.c`/`p_plats.c`/
`p_floor.c`/`p_ceilng.c`/`p_switch.c`/`p_mobj.c`. Nothing here is picked by ear except the
handful of values marked as such below.

Three layers, deliberately separate:

| File | Owns |
|---|---|
| `wad/sound.ts` | Decoding a `DS*` lump into samples. Knows nothing about playback. |
| `audio/sfx.ts` | Vanilla's sound table (names + priorities), the pitch/variant rules, and the `SoundEmitter` interface every game system talks to. No Web Audio. |
| `audio/audio.ts` | `AudioEngine`: the `AudioContext`, the channel pool, attenuation/pan, volume. The only `SoundEmitter` implementation. |

## Sound lumps

A sfx name maps to lump `DS<NAME>` (`i_sound.c`'s own `sprintf(name, "ds%s", …)`), and
`SoundBank` decodes two shapes:

- **DMX** (`0x0003` in the first two bytes) — vanilla's format: 8 bytes of header, then
  unsigned 8-bit samples with silence at 128. The header's sample count is trusted only as
  far as the lump actually reaches; vanilla ignores it entirely and plays `lumpsize - 8`.
  The 16 padding samples id's own sounds carry at each end sit at the silence level, so they
  are kept rather than trimmed.
- **A browser container** (Ogg Vorbis, WAV, FLAC, MP3) — not vanilla, but what a
  sound-replacement PWAD built in the last two decades holds, and what
  `public/game/pwad/fauler_sound.wad` holds. The bytes go to `decodeAudioData`, which is
  asynchronous: the engine kicks those off when the bank is set (`setBank`) so the first shot
  isn't silent, and a name still decoding simply doesn't play that once.

**Sound replacement comes for free from the merged lump directory** (docs/wad.md § Loading
and merging): a PWAD's `DSPISTOL` wins on name collision like any other lump, so an add-on
replaces individual sounds with no code path of its own. `node scripts/inspect-wad.ts <wad>
<map> <pwad>` reports which sfx a set carries, which are in a container, and which are
absent — the fastest way to tell a WAD with fewer sounds from a decoding bug.

**A missing lump is silent, and that is a deliberate deviation.** Vanilla substitutes
`DSPISTOL` for anything missing (`getsfx`) because `sounds.c` isn't gamemode-aware; shareware
`DOOM1.WAD` carries 49 of the 108 sounds, so being faithful here would have cacodemons dying
with a pistol shot.

A DEHACKED/BEX patch can redirect which lump a sfx name resolves to: `soundLumpName(name)`
(`audio/sfx.ts`) is the one place the `DS`-prefix rule is applied, and a BEX `[SOUNDS]` entry
overrides it per name. With no patch loaded the override map is empty and the function is exactly
`i_sound.c`'s own `sprintf`. A `Thing` record's five sound fields are separate — those resolve
through `sfxenum_t` onto `MonsterSounds`. docs/dehacked.md § Sounds and music.

## The mixer model

`AudioEngine` reproduces vanilla's mixer rather than using a 3D audio scene — one gain node
and one stereo panner per voice, both computed the way `S_AdjustSoundParams` computes them:

- **Attenuation**: full volume within `S_CLOSE_DIST` (160 units), falling linearly to zero at
  `S_CLIPPING_DIST` (1200), past which the sound isn't started at all. Distance is a real
  `hypot`; vanilla's octagonal approximation exists only to avoid a fixed-point square root.
- **Pan**: `S_STEREO_SWING`, 96 of the 128 units either side of centre, so a sound beside you
  still carries a quarter of its volume in the far ear.
- **Pitch**: every instance gets vanilla's random wobble — ±16/128 of playback rate, ±8 for
  the chainsaw's four sounds, none for `itemup` and `tink`. Length varies with it, as it does
  in vanilla's own mixer. This is the engine's **only** `mRandom` draw: `S_StartSoundAtVolume`
  uses `M_Random`, the cursor *outside* the play simulation, so that a sound playing or not
  can never shift a damage roll. The sight/death sound *variant* pick (`randomVariant`) goes the
  other way — vanilla chooses those inside `A_Look`/`A_Scream`, so it draws `pRandom`.
  docs/random.md § The table and the two cursors.
- **Channels**: a fixed pool, allocated by `S_getChannel`'s rule — stop whatever this
  *origin* was already playing, take a free channel, else evict the **first** channel whose
  priority is no higher than the new sound's, else drop the sound. "First, not oldest or
  quietest" is vanilla's, and it is why a crowd of same-priority sight sounds fights over one
  channel instead of flushing the pool — which is why a second cull, § Same-tic bursts, stands in
  front of it. `AudioEngine.channelUsage` reports how much of the pool is live and how much the
  burst rule turned away, printed as the DEVMODE status text's sound-channel line
  (docs/devmode.md § Dev mode).
- **Origins** are vanilla's `origin` mobj pointer as a numeric key (`monsterOrigin`,
  `sectorOrigin`, `playerOrigin`, in disjoint ranges). One sound per origin at a time is
  what makes a held chaingun trigger sound like a chaingun instead of a dozen layered shots
  — and what turns the chainsaw's 4-tic idle retrigger into one continuous engine note.

Two values here are **not** vanilla. `CHANNELS` is 32 rather than `snd_channels`' 8, because
this camera shows a whole room and part of the next, and 8 has visible monsters cutting each
other off. And the listener's *orientation* is the **camera's**, not the player's: aim is
mouse-driven and swings freely while the view doesn't, so panning off the player's facing
would have a fight swap ears while nothing on screen moved. Listener *position* is the
player's, as in vanilla.

### Same-tic bursts

**At most `MAX_STARTS_PER_TIC` copies of one sample may *start* within one `DOOM_TIC`**
(`audio.ts: admitBurst`), and the copies that do are spaced `BURST_STAGGER` apart. Both are
deliberate non-vanilla additions, and both exist because of one event: a `noiseAlert` floods a
region, every unalerted monster in it wakes on the **same frame** — the idle look-around is one cadence for
the whole level (docs/monster-ai.md § Waking up), so a region's look checks all land on the same
tic — and each raises a sight sound over a second long (`DSBGSIT1` 1.24 s, `DSSGTSIT` 1.01 s).
A dozen of those own a third of `CHANNELS` for the length of the cry, and vanilla's per-origin and
per-priority culls catch neither: every waker has its own `monsterOrigin`, and every sight sound
shares priority 98.

The rule stays in the mixer. Scattering the wake itself would consume `pRandom` draws in the play
simulation, and a per-monster phase is the thing a restore cannot put back
(docs/monster-ai.md § Waking up) — this changes no game state at all.

- **The budget counts starts per tic, not voices in flight.** A sound that layers by design across
  tics is untouched: `plasma` carries no origin (§ Weapons and projectiles) and a held trigger
  stacks about six deep at its 3-tic cadence, one start per tic, so it never reaches the budget.
- **The key is the variant family, not the lump** (`sfx.ts: sampleGroup`). Ten zombiemen waking
  together draw a different `randomVariant` each; keying on the lump would give one wake three
  budgets.
- **A burst at budget admits a copy only by displacing one**, and which one is
  `burstVictim`: the highest `crowding / gain`, where crowding sums `1 / (panDistance +
  CROWD_FALLOFF)` over the burst's other members. The sum rather than the distance to the nearest
  neighbour alone is load-bearing — nearest-neighbour saturates once each side of the stereo field
  holds two copies and can no longer tell a stack of three from a lone source, which settles five
  monsters left and five right at three-and-one instead of two-and-two. Gain divides it, so a crowd
  all in one direction, where crowding is uniform, admits its nearest instead. Ties go to the later
  index and the newcomer is passed last, so copies that rate exactly alike turn nobody away for
  nothing.
- **A displaced copy inherits the victim's place in the stagger**, so the spacing stays even however
  often a burst turns over — and a copy displaced before its staggered start has come round never
  sounds at all, which is why replacement inside a burst cannot click.
- **A voice sharing the newcomer's origin is not counted**: `allocate` is about to cut it.

The stagger is the other half. Four copies of one sample started at a single instant comb-filter
into one loud copy rather than a crowd, and vanilla's ±16 pitch wobble only partly decorrelates
them; a few milliseconds between them is what makes four wakers read as four monsters.

`MAX_STARTS_PER_TIC` and `BURST_STAGGER` are **tuned by feel** and meant to be retuned by ear.
`tests/audio/burst.test.ts` pins `burstVictim` and `sampleGroup` — the pure half — and states every
claim as a comparison, never as one of the dial's values; the budget itself needs an `AudioContext`
and sits in docs/testing.md's carve-out.

## Who plays what

Sound is the one effect systems raise directly (through `SoundEmitter`) instead of reporting back
for someone else to realize, unlike damage (`ThingLayer.update`'s attacks, applied by
`MonsterAttacks`) or shots (`WeaponSystem.fire`'s `Shot[]`). Two reasons: it changes no game state,
and several of vanilla's sounds sit at moments that have no observable event to hang off —
`A_Chase`'s 3-in-256 idle grunt is inside the chase call, not a result of it. `SILENT` is the no-op
emitter, so a headless script or a browser with no `AudioContext` needs no branches.

| Where | Plays |
|---|---|
| `game/monsters/ai.ts` | The idle grunt, the melee swing, a hitscan shot, an attack windup, footsteps; and from `MonsterAttacks`, the arch-vile's `flamst` warning flame and `barexp` blast |
| `game/things.ts` | Waking, pain, death (and a barrel's explosion, and a resurrection) |
| `game/specials.ts` | Doors, lifts, floors, ceilings, crushers, switches, a locked door's grunt |
| `game/weapons.ts` | The chainsaw's bring-up and idle rattle (`updateSounds`) |
| `game/spritefx.ts` | `telept`, on both fog puffs of every teleport |
| `game.ts` | Weapon fire, the player's own pain/death/landing, pickups, entering a secret |
| `game/projectiles.ts` | Projectile launches and impacts |

## Monsters

`MonsterStats.sounds` (`game/monsters/tables.ts`) carries each type's `mobjinfo` sound fields
verbatim — `seesound`, `activesound`, `painsound`, `deathsound` — plus the sounds vanilla's
action functions play, mapped onto the moments this engine has for them. Rules worth knowing:

- **Sight and death sounds are randomized within their family**: `posit1..3` and `podth1..3`
  (zombieman/sergeant/chaingunner/SS) and `bgsit1..2`/`bgdth1..2` (imp) each pick at random
  from the group at play time, whichever member `mobjinfo` names — the `switch` statements in
  `A_Look` and `A_Scream`.
- **A gibbed death plays `slop` instead of the type's own cry**, since `A_XScream` sits on the
  xdeathstate chain. The same `slop` plays when an arch-vile raises a corpse.
- **The spider mastermind's and cyberdemon's sight and death sounds are unattenuated**
  (`BOSS_TYPES`): vanilla passes `NULL` as the origin for exactly those two, so you hear them
  wake up anywhere on the map. Nothing else about their sounds is special.
- **A pain sound is gated on the stagger roll**, not on being hit: `A_Pain` sits on the
  painstate, which `painchance` decides you enter.
- **A swing has two sound moments, and they are vanilla's own.** `A_Chase` plays
  `mobjinfo.attacksound` on *entering* meleestate — `MonsterSounds.meleeWindup`, the demon's
  `sgtatk`, joined by `A_SkelWhoosh`'s `skeswg` on the revenant's first swing state — and the
  melee action plays `MonsterSounds.melee` a windup later *if it connects* (the imp's and
  baron's `claw`, `A_SkelFist`'s `skepch`), since vanilla's `S_StartSound` sits inside the
  `P_CheckMeleeRange` branch. So a demon growls whether or not it lands the bite, and an imp
  that swings at someone who stepped back is silent. The revenant is the one type with both.
  docs/monster-ai.md § A swing that misses.
- **A projectile-thrower has no attack sound of its own**; what you hear is the missile
  (below). `MonsterSounds.attack` is for hitscan shots, and the chaingunner's is the
  **shotgun** blast — `A_CPosAttack` really does play `sfx_shotgn`.
- **Footsteps** (`MonsterSounds.walk`) exist only for the arachnotron, spider mastermind and
  cyberdemon, whose `A_BabyMetal`/`A_Metal`/`A_Hoof` sit on individual walk states. They are
  paced by *walking*, not wall-clock time, so a monster held still by an attack stops
  stomping. The cyberdemon's `hoof`/`metal` pair is spaced evenly (every 12 tics) rather than
  reproducing vanilla's uneven 18/6 split within its 24-tic run loop, since this engine
  interpolates the walk instead of stepping a state chain. They matter more here than in
  vanilla: a wide top-down view still can't show what is stomping toward you from next door.
- **The arch-vile's warning is two sounds**: `vilatk` from the vile (`A_VileStart`) and
  `flamst` from the flame (`A_StartFire`) as the windup begins, then `barexp` on the blast
  (`A_VileAttack`). See docs/monster-archvile.md for the timing they hang off.

## Weapons and projectiles

`WeaponDef.fireSound` is played **once per trigger pull, not per pellet** — `A_FireShotgun`
plays `shotgn` once for all seven. It is `null` for the rocket launcher and plasma rifle,
which have no weapon sound in vanilla at all: the launch sound is the missile's own
`mobjinfo.seesound`, from `game/spritefx/tables.ts`'s `PROJECTILE_SOUNDS`, keyed by flight sprite as
`IMPACT_EFFECTS` is. The BFG is the one projectile weapon with its own sound (`MT_BFG`'s
seesound is 0; `A_BFGsound` is a separate state action).

**The super shotgun is the one weapon that keeps making noise after its shot.**
`A_OpenShotgun2`, `A_LoadShotgun2` and `A_CloseShotgun2` (in `p_enemy.c`, not `p_pspr.c`) sit on
`S_DSGUN5`/`7`/`9`, so `dbopn`, `dbload` and `dbcls` land 21, 35 and 48 tics after
`A_FireShotgun2` — all three inside the weapon's own 57-tic cooldown, on the player's origin like
the shot itself. This engine collapses that state chain into a single cooldown number, so the three
moments need their own clock: `SSG_RELOAD_SOUNDS` is the schedule, `WeaponSystem.reloadTic` the tics
since the shot, started in `fire` and played off in `updateReloadSounds`. Two things abort what is
left of the sequence, both because vanilla lowers the weapon and its psprite never reaches those
states: **switching away**, and **`A_CheckReload` 14 tics in** finding fewer than two shells left,
which is why a shot fired with the last shells reloads silently. Pinned by
`tests/game/weapons.test.ts` § Game rules · super shotgun reload sounds.

A missile's impact plays its `deathsound`, wherever the flight ended. Two
oddities in that table are vanilla's and are kept: every fireball bursts with `firxpl` while
the rocket and the revenant's tracer use the **barrel** explosion, and the BFG ball's
`rxplod` is a sound nothing else in the game reaches.

Melee is the one weapon sound that depends on the outcome, resolved in `spawnPlayerShot`: the
chainsaw revs (`sawful`) on air and bites (`sawhit`) on contact, the fist's `punch` plays only
on a hit — `A_Punch` is silent on a miss. Bringing the chainsaw up plays `sawup`
(`P_BringUpWeapon` does this for no other weapon), and while it is the ready weapon and the
trigger is released, `sawidl` restarts every 4 tics (`SAW_IDLE_INTERVAL`). Those two are the only
weapon sounds not tied to firing, and are raised by `WeaponSystem.updateSounds` (private, reached
through `WeaponSystem.update`) rather than from the fire path.

Launch sounds carry **no origin**: every shot is its own mobj in vanilla, so a burst of plasma
layers rather than cutting itself off. Weapon fire sounds carry the player's origin, so a held
trigger does cut itself off.

## Specials

Sector sounds come from vanilla's `sector->soundorg` — the centre of the **bounding box** of
the sector's linedefs (`P_GroupLines`), not a polygon centroid — computed lazily and cached
(`SpecialsController.soundOrigin`).

- **Doors**: `doropn`/`dorcls`, or `bdopn`/`bdcls` for the blazing (4× speed) types, which is
  the same set of specials `DOOR_SPEED_FAST` marks. The close is announced when the hold runs
  out, not when the door opened; a door that bounces back off someone underneath plays its
  open sound again, which is what tells you it found you there. Re-triggering an already-open
  door only resets its wait and is silent, matching vanilla's `topcountdown` path.
- **Lifts** are silent while moving: `pstart` when they set off, `pstop` at each end.
- **Floors and ceilings** are the opposite — they grind `stnmov` the whole way and clack
  `pstop` on arrival (a ceiling mover has no arrival sound). That grind runs on **one shared
  clock** (`MOVE_SOUND_INTERVAL`), reproducing vanilla's global `leveltime & 7`: every plane
  in motion anywhere emits in the same tic, which is why a room of rising stairs sounds like
  one machine rather than a dozen.
- **Crushers** grind on that same clock and are quiet at the turns — except vanilla's
  `silentCrushAndRaise` (141, `CrusherEffect.silent`), which is exactly inverted: silent
  throughout, one `pstop` at each end. That sound is the only thing distinguishing 141 from
  25, so it can't be folded in.
- **Switches** click `swtchn` from the linedef's midpoint. Two divergences, both deliberate:
  vanilla's `swtchx` (exit switch) is unreachable, because `line->special` is zeroed for a
  one-shot switch *before* the `special == 11` test that would select it — we keep the
  faithful outcome, including the dead sound. And vanilla emits the click from
  `buttonlist->soundorg`, which `P_StartButton` only fills in *after* the sound plays, so the
  real thing clicks from whatever stale button slot 0 last held; the linedef midpoint is used
  instead, since reproducing that bug would put the click anywhere on the map.
- **A locked door** grunts `oof` at full volume, alongside the `lockedLineMessage` line
  (docs/items.md § Locked doors and use triggers) — vanilla's own pairing of sound and message.
- **Teleports** play `telept` at both ends, from `SpriteFxLayer.spawnTeleportFog` — which
  `spawnTeleportPair` calls twice, so every teleport is heard at both ends whether it was a
  monster's trip or the player's.
- **A wall that isn't a door** grunts `noway` at full volume, from the use trace's own stop
  (`PTR_UseTraverse`): the first line in front of the player with no special and no opening.
  A special line in the way is silent, however little it did — docs/specials.md § The use trace.

## Player and pickups

`plpain` on any hit that lands, `pldeth` on death — or `pdiehi` below −50 health, in a commercial
game only (`A_PlayerScream`'s `gamemode == commercial`), and `slop` for a gib instead of either
(`A_XScream`). Vanilla tests the body's post-hit health, which goes negative where the HUD's stops
at 0 — `applyDamage`'s return, which `playerDeath` reads; docs/death.md § Player death.

`oof` on a landing harder than vanilla's `momz < -8` units/tic (`HARD_LANDING_SPEED`,
`game/player.ts`), read off `Player.landingSpeed` — a corpse's too, as `P_ZMovement` tests
`mo->player` and not its health (docs/death.md § Player death).

Pickups follow `P_TouchSpecialThing` (`inventory.ts: pickupSound`): `getpow` for the six
powerups plus the soulsphere and megasphere, `wpnup` for the seven weapons, `itemup` for
everything else — all **unattenuated**, as vanilla plays them, since you are standing on it.

Entering a secret sector plays the **`secret` chime**, also unattenuated, alongside the
center-screen message. Vanilla plays no sound for a secret at all, so this is a deliberate
addition, not a fidelity reproduction — docs/hud.md § Center messages.

It is the one sound that comes from **no game WAD**: `audio.ts`'s `ASSETS` table maps it to the
`SECRET` lump of the WAD the engine ships (`assets/secret.ogg`, docs/wad.md § The WAD the engine
ships), and `playAsset` starts it. It can't be an `SfxId` — `SFX` is `sounds.c`
verbatim and a name vanilla never had would quietly turn that table into an approximation — and
sourcing it from a lump would mean either a made-up `DS*` name no WAD carries or borrowing an
unrelated one (`DSRADIO`, DOOM 2's inter-level chatter, which is what this used to play and which
the shareware `DOOM1.WAD` doesn't even have). Everything downstream is shared with lump sounds: the
same channel pool, priority (60, `getpow`'s), sfx bus and volume. Loading is a `decodeAudioData`
over the lump, kicked off when the `AudioContext` comes up, and a failure is cached as null and
logged — the message then shows silently, the same way a missing lump degrades.

## Volume and the context

The menu's Settings → Audio tab has three sliders — master, effects, music — and each value is
persisted as a field of the settings object, the sfx one as `sfxVolume` (docs/menu.md §
Persisted settings covers the shared pattern). Default is
**0.8, tuned by feel** rather than taken from vanilla's own starting `snd_SfxVolume` of 8 of 15 —
there is no sound card's analogue stage behind this mixer, so vanilla's number arrives quieter
here than it did on the hardware. The music default is lower again (docs/music.md § Volume): it
sits under the game rather than beside it.

**The master slider is the `master` gain node itself** (the `masterVolume` setting, default **1** —
unity, not a tuned number: what the mix sounds like is the two channel defaults' business, and this
slider exists to pull all of it down at once). It is the only one that moves both buses, so 0 on it
has to do what 0 on either channel does, on both at once: `play` short-circuits on
`_volume * _masterVolume` rather than on the sfx slider alone, `setMasterVolume` calls `stopAll()`,
and it hands the value to `MusicPlayer.setMasterVolume` so the chip stops being rendered rather than
merely being turned down to nothing (docs/music.md § Volume). The music player holds that value as a
gate only — the gain is this node's, downstream of its bus — and never persists it, so there is one
owner of the stored master.

**There is no mute, deliberately** — an `M` key and a `_muted` flag existed and were removed as a
second way to say what the slider already says at 0. **Volume 0 therefore has to do everything mute
did:** `play` short-circuits rather than starting inaudible sources, and
`setVolume` calls `stopAll()` on reaching 0. Without that last part a sound already playing keeps
running silently, and sliding back up part-way through would drop the player into the middle of it.

The slider previews itself (`itemup`) as you drag — but only once a WAD set's sounds are
loaded, i.e. from the first ESC back to the menu onward. On the very first visit there is no
bank yet and the preview is silent; downloading a 14 MB IWAD to audition a slider would be
worse.

The `AudioContext` is **session-level** — one for every level and WAD set, like `Viewport`'s
renderer — and is created lazily on the first `resume()`, since browsers only start one off a
user gesture. Three places reach it: `startLevel` (synchronously, before
`loadWadFiles`' first `await`), the volume slider, and a one-shot `pointerdown`/`keydown`
listener in `main.ts` that covers a `?map=` deep link, which starts a level with no click at
all. `Game.pause()` suspends it and `resume()` wakes it, so ESC to the menu is silent; a
level change calls `stopAll()`, since anything still ringing belongs to the level being torn
down and its origins are about to be reused.

## Music

The level's `D_*` track has its own subsystem — see **docs/music.md**. Only two things about it
belong here:

- The graph is `voice → sfxBus → master → destination`, and the music player's bus is a **sibling
  of `sfxBus`** under `master`, so the two volumes are independent. That is why the sfx volume is
  applied to `sfxBus` and not to `master`, where it would quietly ride the music as well — and why
  the master slider, which is meant to ride both, is `master`'s own gain.
- **`suspend` no longer suspends the context.** It cuts the sfx voices and leaves the clock
  running, so music plays on behind the menu the way vanilla's does; suspending would freeze it
  mid-bar. Nothing raises a sound while paused — the frame loop is stopped — so there is nothing
  else to silence.
