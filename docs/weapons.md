# Weapons: selection, fire rates and damage

`src/game/weapons.ts`, `src/game/inventory.ts` (ammo), `src/game/input.ts` (the slot keys),
`src/util/random.ts` (the dice and spread draws every weapon rolls through)

What happens *after* a weapon fires — the shot's path, what it hits, what it does — is
docs/combat.md. Death is docs/death.md.

## WeaponSystem

`WeaponSystem` owns weapon selection and fire timing/ammo, and **deliberately knows nothing about
three.js**: `update` returns a list of `Shot`s describing what was fired this frame (one per hitscan
pellet, one per projectile launched, one per melee swing), and `ProjectileLayer`
(`game/projectiles.ts`) turns those into tracer lines and flying sprites. Same split as
`specials.ts`'s line triggers vs. `game.ts`'s teleport fog, and it's what lets fire rates and ammo
costs be tested headlessly against a synthetic map.

`ProjectileLayer` is the mirror image: it knows nothing about ammo, cooldowns or AI, only about
geometry and bodies, and it serves the player's shots and a monster's identically
(`spawnPlayerShot`/`spawnMonsterShot`). It reads the live level through a `CombatContext`
(`game/combat.ts`) rather than holding `World`/`ThingLayer` references of its own — those are
replaced on every map load, so the context is all getters.

**Nothing in `WEAPONS` is tuned by feel** — fire rates come from `info.c`'s state chains (§ Fire
rates), spread from `p_pspr.c`'s shift constants (§ Spread), damage from `P_GunShot` and
`PIT_CheckThing` (§ Damage rolls), ammo cost from `P_FireWeapon`, projectile speed from `mobjinfo`.
The top-down camera changes how a weapon is *aimed*; it doesn't change how fast one shoots or how
hard it hits, so there is nothing here a feel-tuned number would be buying.

### Slot keys toggle within a slot, they don't select "the best"

`WEAPON_SLOTS` lists each digit's
weapons best-first, but pressing a digit already showing one of that slot's weapons advances to the
*next* one owned rather than re-picking the best. Without this, slots 1 and 3 (fist/chainsaw,
shotgun/super shotgun) made their weaker weapon permanently unreachable once the upgrade was owned —
which presented as "shotgun and super shotgun are the same weapon".

Coming *back* to a slot from elsewhere selects **the weapon last used out of it**
(`WeaponSystem.slotWeapon`, one entry per slot), falling back to the slot's best while it has never
been used. So punching, switching to the pistol and pressing `1` again returns the fist rather than
the chainsaw — without the memory, a slot's weaker weapon could only be held by pressing its digit
twice every single time. The memory is maintained in `update`'s once-a-frame comparison, for the
same reason `previousWeapon` is (below), and is per level: `beginLevel` clears it and seeds only the
slot of whatever is being carried in.

### The wheel walks the slot order

One wheel notch is one **weapon**, and the order is the digit keys' slot order with each shared slot
read **weakest first** — fist, chainsaw, pistol, shotgun, super shotgun, chaingun, … Weapons not
owned are skipped rather than eating a notch, and every weapon owned is a stop, so scrolling alone
reaches all of them.

That is `WEAPON_CYCLE`, which the HUD icon strip also lays out (docs/hud.md) — one list, since
weakest-first inside a slot makes the wheel's order and the strip's the same thing. It is
**derived** from `WEAPON_SLOTS`, each slot reversed, rather than written out beside it: the two
orders are one decision, and a weapon added to a slot has to land beside its slotmate here too. Note
the reversal is the point — `WEAPON_SLOTS` flattened reads each slot best-first, which puts the
chainsaw ahead of the fist, backwards from both the strip and the pickup progression.

The wheel is an accumulate-and-drain channel sampled on the tic, not per frame — docs/frameloop.md
§ Input runs on the tic.

### Switch to previous weapon

The right button's default binding (docs/menu.md § Right mouse button)
reads `WeaponSystem.previousWeapon`, which is maintained in `WeaponSystem.update`'s once-a-frame
`justSwitched` comparison rather than at each switch site — the same reason `weaponLastFrame` is,
since a pickup (`applyPickup`) and a berserk pack both select a weapon without going through
`handleSwitching`. `handleSwitching` runs before `update`, so a click reads the weapon left
behind by the *previous* switch and that frame's `update` then records the one just left,
which is what makes a second click toggle back.

The two fields differ by one frame and are easy to confuse: `weaponLastFrame` is the edge detector
("what was selected last frame", equal to the current weapon on every frame but the one a switch is
noticed), while `previousWeapon` is the older selection the toggle switches *back* to, held until
the next switch.

## Automatic weapon switching

Four rules select a weapon for you. Two are ungated; the other two follow the `autoSwitchWeapon`
setting, on by default (`getAutoSwitchWeapon`, `game/inventory.ts`, docs/menu.md § Persisted
settings) — as the collecting or firing player's own (`PickupOptions.autoSwitch`,
`WeaponSystem.autoSwitch`; docs/multiplayer.md § Player settings).

| Rule | Vanilla | Where | Gated |
|---|---|---|---|
| A newly picked-up weapon selects itself | `P_GiveWeapon` | `inventory.ts: applyPickup` | no |
| Berserk selects the fist | `P_GivePower` | `inventory.ts: givePower` | no |
| Ammo collected from empty raises the weapon | `P_GiveAmmo` | `AMMO_UPGRADE`, `inventory.ts` | yes |
| The ready weapon running dry drops you | `P_CheckAmmo` | `AMMO_FALLBACK_ORDER`, `checkAmmo` | yes |

The two ungated ones are not guesses at which weapon is better — the pickup *is* the choice — which
is why the setting doesn't reach them. Every rule writes `Inventory.currentWeapon`, so
`WeaponSystem.update`'s once-a-frame comparison notices all of them and `previousWeapon`, the slot
memory and the chainsaw's `sawup` follow for free (§ Switch to previous weapon).

### The check runs on the ready state, never mid-chain

`P_CheckAmmo` has exactly three callers, and `A_WeaponReady` is **not** one of them — its else
branch is `player->attackdown = false;` and nothing more:

- `P_FireWeapon`, opening a trigger pull;
- `A_ReFire`, the action on the last state of every fire chain — trigger held it re-enters
  `P_FireWeapon`, trigger released its else branch checks directly, so the check lands either way;
- `A_CheckReload`, the super shotgun only (below).

`WeaponSystem.fire` reproduces the first two as `cooldownTics === 0 && (firing || chainEnding)`,
`chainEnding` being set on every shot. **Selecting an empty weapon while idle must not bounce you
off it** — that would break § The wheel walks the slot order's promise that every owned weapon is a
stop. Only firing, or having just fired, switches.

The super shotgun is the exception: `A_CheckReload` sits on `S_DSGUN4`, 14 tics after the shot, so
an SSG fired with the last two shells switches away there rather than at the end of its 57-tic
cooldown. `updateReloadSounds` runs the same `checkAmmo`, which is why the reload falling silent and
the weapon lowering are one thing and not two (docs/audio.md § Weapons and projectiles).

### AMMO_FALLBACK_ORDER

`P_CheckAmmo`'s chain, first match wins, terminating at the fist: plasma rifle, super shotgun,
chaingun, shotgun, pistol, chainsaw, rocket launcher, BFG. A third order unrelated to
`WEAPON_SLOTS` and `WEAPON_CYCLE` — vanilla's preference for "still useful right now", which is why
the chainsaw outranks a rocket launcher and the BFG comes last.

`minAmmo` is **strictly greater than, and is not `ammoPerShot`**: the chain wants three shells
before handing you a super shotgun that fires on two, and 41 cells before a BFG that fires on 40.
Vanilla's own off-by-one, transcribed rather than corrected.

Two deviations, both deliberate: vanilla's `gamemode` clauses are dropped (ownership subsumes them —
a WAD without the weapon has no pickup for it), and the pistol row tests ownership where vanilla's
bare `else if (player->ammo[am_clip])` does not, since `Inventory.weapons` is authoritative here for
the wheel and the HUD strip.

With the setting off, `checkAmmo` still returns "cannot fire" but switches nothing: an empty weapon
stays selected and fires silently, as it did before the rule existed.

Only `chainEnding` is saved here, one boolean: one tic wide, and a load could afford to lose it for
a trigger pull, but a replay's keyframe restore has to land on the tic the recording ran
(docs/replays.md § Seeking). Both tables are pure functions of inventory state the snapshot already
carries (docs/savegames.md).

## Fire rates

**The cooldown is counted in whole tics, as an integer** (`WeaponSystem.cooldownTics`), not as
seconds remaining. Every cooldown below is a whole number of tics and the simulation steps one tic
at a time (docs/frameloop.md § The accumulator), so an integer countdown is exact — and it is the
same model vanilla has, a psprite sitting in a state with that many tics left. In seconds, float
residue decides whether a shot lands on tic N or N+1, which is a third of the plasma rifle's rate.

Two halves of one rule, and it takes both — **an idle trigger banks nothing**:

- the counter **clamps at zero** rather than running negative while the trigger is up, and
- firing **assigns** the cooldown rather than adding to it.

Break either alone and nothing visibly changes; break both and the weapon free-falls into debt while
idle, then fires *every tic* until it climbs back through zero. That combination shipped once, from
converting the old seconds-based counter carelessly, and `tests/game/weapons.test.ts` § Game rules ·
fire rates now pins every weapon's gap to its exact vanilla tic count so it cannot again.

**A weapon's cooldown is its own vanilla state chain, and the `A_ReFire` state's tics are not part
of it.** `A_ReFire` runs on *entry* to its state and, while the trigger is still down, calls
`P_FireWeapon` immediately — `P_SetPsprite`'s loop then leaves the psprite sitting in the fire
chain's first state with that state's own tics, so the `A_ReFire` state's tics are only ever spent
when you *release*. Summing a weapon's whole state list therefore overstates its held-trigger rate;
the shipped numbers were up to 1.7× off in both directions before this was worked out.

**The rates are walked out of `states[]`, not written out.** `WEAPON_SEED` carries every field a
state chain can't say and the fill loop at the bottom of `weapons.ts` writes `cooldown` from
`dehacked/frames.ts`'s reading of vanilla's own frame table, exactly as `monsters/tables.ts` fills
its stat blocks (docs/dehacked.md § Frames). The rule it walks is the one this section describes:
the states from `weaponinfo[].atkstate` to the `A_ReFire` that closes the chain, that state
excluded, divided by how many firing actions one pass carries. `WeaponDef` has no field a patch
could write a rate into, so this *is* how a DEHACKED patch retunes a gun — § What a DEHACKED patch
can change here.

Two tests anchor it: `tests/fixtures/frametables.ts` holds all nine rates as they were read off
`info.c` by hand, and `tests/game/dehacked-frames.test.ts` requires both the walker and the finished
`WEAPONS` table to reproduce them.

| weapon | states counted | tics | seconds |
|---|---|---|---|
| fist | `S_PUNCH1`-`4` | 17 | 0.486 |
| chainsaw | `S_SAW1` **or** `S_SAW2` | 4 | 0.114 |
| pistol | `S_PISTOL1`-`3` | 14 | 0.400 |
| shotgun | `S_SGUN1`-`8` | 37 | 1.057 |
| super shotgun | `S_DSGUN1`-`9` | 57 | 1.629 |
| chaingun | `S_CHAIN1` **or** `S_CHAIN2` | 4 | 0.114 |
| rocket launcher | `S_MISSILE2` + `S_MISSILE1` | 20 | 0.571 |
| plasma rifle | `S_PLASMA1` | 3 | 0.086 |
| BFG | `S_BFG3` + `S_BFG1` + `S_BFG2` | 40 | 1.143 |

Two shapes in that table are easy to get wrong. The **chainsaw and chaingun fire twice per pass**
(`S_SAW1`/`S_SAW2` both call `A_Saw`, `S_CHAIN1`/`S_CHAIN2` both call `A_FireCGun`), so their rate
is one state's tics, not the chain's. The **plasma rifle's** `S_PLASMA2` holds 20 tics but carries
`A_ReFire`, so a held trigger never spends them — which is what makes it the fastest weapon in the
game rather than a middling one.

The super shotgun's chain is the only one with anything *inside* it: its `dbopn`/`dbload`/`dbcls`
reload sounds land on states partway through those 57 tics, played off their own clock in
`WeaponSystem` — docs/audio.md § Weapons and projectiles.

**Two vanilla delays are deliberately not reproduced.** The rocket launcher's 8-tic flash state and
the BFG's 30 tics of charge-up both sit *before* their fire action, so in vanilla the shot leaves
that long after the trigger; here every weapon fires on the frame you click and the delay is folded
into the interval instead. Reproducing them needs a pending-shot timer in `WeaponSystem` and is the
one place this engine's weapons still differ in timing.

## What a DEHACKED patch can change here

The rate, the ammo class, and what the chain fires — which is everything vanilla stores. `d_deh.c`'s
`deh_weapon[]` is an ammo type and five state pointers; `weaponinfo[]` holds no damage and no fire
rate at all, because in vanilla a weapon's rate *is* its frames' durations. So a patch retunes a gun
the way vanilla does, by editing the `Frame` records of its fire chain or by repointing
`Shooting frame` at another one, and the applier re-walks the rate off the patched table. Both the
`A_ReFire` exclusion and the twice-a-pass rule hold under a patch: making `S_PLASMA2` a hundred tics
long still leaves the plasma rifle at 3, and stretching `S_CHAIN1` moves the chaingun to the new gap
between its two `A_FireCGun` calls rather than to the whole pass.

The damage, spread, ammo cost and projectile are not fields a patch can write either — they follow
the chain's **firing action**. A chain repointed at another of `p_pspr.c`'s nine fires that weapon's
shot, copied whole bar the ammo class, the rate and the icon: docs/dehacked.md § Action pointers.
That is how a patch builds a weapon vanilla has no slot for — nosp4.wad's Super Rocket Launcher is
the chainsaw slot drawing rockets off a chain carrying `A_FireMissile`.

A weapon's **flash, bob, raise and lower** states are the ones with nothing here to land on — there
is no first-person weapon drawn — and report as `noTarget` rather than applying silently.

A weapon's **missile** is a different matter: `MT_ROCKET`, `MT_PLASMA` and `MT_BFG` are ordinary
`Thing` records, so their speed, radius and damage are patchable — and each is shared with the
monster that fires the same projectile, exactly as vanilla shares the one `mobjinfo`.

## Spread

Every random fuzz in the game is one distribution — vanilla's `P_Random() - P_Random()`, two
consecutive draws off the random table subtracted, giving a triangular spread centred on the true
aim (`util/random.ts`'s `triangularDraw`, and `triangularSpread` for the angular cases). It is
literally that call, not an approximation of it: docs/random.md § The triangular draw covers the
table, why the two draws must be separate, and where the `/255` comes from. The per-weapon widths
are the BAM shift constants in `p_pspr.c`, converted as `255 << shift` of a `2^32` turn — the same
255 the draw normalizes by:

- `<<18` = **5.6°** — `P_GunShot`'s bullet spread, so the pistol, chaingun and each of the shotgun's
  7 pellets, *and* `A_Punch`/`A_Saw`'s swing angle. A melee swing's own share barely matters (~6
  units of arc at `MELEERANGE`, against a 24-unit hit radius), but it is the same draw.
- `<<19` = **11.2°** — the super shotgun's 20 pellets, twice the shotgun's cone. `A_FireShotgun2`
  never calls `P_GunShot`; it has its own loop, which is why its numbers differ.
- `<<5` on the *slope* (`WeaponDef.slopeSpread`, ±0.1245 rise per unit ≈ ±7°) — also super shotgun
  only, and the only vertical scatter in the game. `HitscanShot.slopeOffset` carries it, applied by
  moving the aim point up or down at the target's distance, since that is what `shotPath` derives a
  slope from.

**The first shot of a held pistol or chaingun has no spread at all.** `A_FirePistol` and
`A_FireCGun` pass `P_GunShot(mo, !player->refire)`; `A_FireShotgun` hardcodes `false`.
`WeaponSystem` mirrors `player->refire` with a counter reset whenever the trigger comes up or the
weapon changes (`A_ReFire`'s else branch), and `WeaponDef.accurateFirstShot` marks the two weapons
that read it. Tap for accuracy, hold for volume — without this, the auto-aim fix below makes a
tapped long-range chaingun shot miss ~27% of the time for no reason vanilla would recognize.

## Damage rolls

**Two vanilla formulas, one `((P_Random() % sides) + 1) * multiplier` shape** — `util/random.ts`'s
`rollDamage`, drawing off the random table (docs/random.md § The table and the two cursors). A
*bullet's* roll is written out at each call site (`5*(P_Random()%3+1)` in both `P_GunShot` and
`A_FireShotgun2`: 5/10/15 per pellet, and the super shotgun's is identical to the shotgun's — the
20-vs-7 pellet count is its whole advantage). A *missile's* is not in the weapon code at all:
`PIT_CheckThing` rolls `((P_Random()%8)+1) * mobjinfo.damage` for whatever hit something, so every
projectile weapon has 8 sides and takes its multiplier from `info.c` — rocket 20 (20-160), plasma
**5 (5-40)**, BFG ball **100 (100-800)** before `A_BFGSpray` adds anything. The plasma bolt shipped
as a 4-sided roll and the BFG ball as `8×30`; both were transcription guesses, and reading
`mobjinfo` settles them. Fist and chainsaw share `(P_Random()%10+1)<<1` (2-20), the fist ×10 under
berserk.

Projectile *speeds* come from the same `mobjinfo` rows, × 35 for units/sec exactly as
`game/monsters/tables.ts` converts a monster's: rocket 700, plasma 875, BFG 875. The player's rocket
used to fly at 1000 while the cyberdemon's — already converted correctly — flew at 700.

**A melee swing is resolved entirely differently from every other shot**: `spawnPlayerShot` returns
before `shotPath` even runs and just raycasts `WeaponDef.meleeRange` (vanilla's `MELEERANGE`, 64 —
the chainsaw's own `+1` is about its puff, docs/combat.md § Bullet puffs) along the aim angle. A swing doesn't
travel, so it needs none of `shotPath`'s wall/step blocking, matching `A_Punch`/`A_Saw`. It needs no
lock-on case either: `player.angle` is already set from the same `aim` the lock uses, so the ray
finds a hovered monster on its own and simply can't reach one further off than the swing's range.

