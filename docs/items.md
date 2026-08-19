# Pickups, inventory and powerups

`src/game/inventory.ts`, `src/game/things.ts: ThingLayer.tryPickup`, `src/game/specials/sectoreffects.ts`,
`src/ui/hud/screeneffects.ts`, `src/game.ts`

What any of this *looks like* on screen — the HUD panels reading off `Inventory`, the powerup strip,
the screen tints the powers drive — is docs/hud.md.

## Inventory

`Inventory` (health, armor + armor type, four ammo classes, collected keys, weapons, powers) is a
plain struct owned by `Game` in `game.ts`, **not by `Player`** — nothing about resting height or
movement needs it, and keeping it separate is what makes `finishLevel` a one-line call at map load
rather than something `Player`'s constructor has to reason about.

Weapon ownership and ammo land in `Inventory.weapons`/`Inventory.ammo`, read by `game/weapons.ts` for
selection and firing. `Inventory.currentWeapon` lives here for the same reason the rest of the struct
does: `game.ts` owns it, and the HUD reads it off the same struct it already reads health/ammo/keys
from. Picking up a weapon **not already owned** selects it, matching `P_GiveWeapon`; re-picking one
you have doesn't yank the selection away. `fist` and `pistol` are in `WeaponId` even though neither
has a map pickup — every game starts owning both, and they still need ids to be `currentWeapon`-able.

`applyPickup` follows `P_TouchSpecialThing`: most importantly, a Stimpack/Medikit at full health, an
armor pickup weaker than what's worn, or a weapon whose ammo type is already capped and which is
already owned **isn't consumed** (returns `false`), leaving the item on the ground exactly like
vanilla rather than silently vanishing for no visible effect. Health/armor *bonus* items (health
bonus, soulsphere, megasphere, armor bonus) are the exception vanilla itself carves out — they push
past the normal 100/100 cap up to 200 and are always consumed. A weapon's ammo grant follows
`P_GiveWeapon`: `2 × clipammo[type]`, twice a single ammo pickup of that type, since a map-placed
weapon gives full while a monster-dropped one gives half (see `dropped`, below).

**Keys and powerups don't survive a level transition; health/armor/ammo and the backpack's raised
caps do** (`finishLevel`, called from `loadMapByIndex` before the new map loads) — matching
`G_PlayerFinishLevel`, which clears `player->cards` and `player->powers` (and drops `MF_SHADOW`) but
nothing else; `player->backpack`/`maxammo` are deliberately not among them. This does mean a locked
door on the far side of a transition needs its key collected again, same as vanilla requires.

## Pistol start

**Settings → General → "Pistol start every level"** (`topdoom.pistolStart`, off by default) throws
that carry-over away: every level is entered on a fresh `createInventory()` — 100 health, no armor,
fist + pistol with 50 bullets — the way each map is balanced to be played on its own, and the way
DOOM's own level select has always started one.

The setting lives in `game/inventory.ts` (`getPistolStart`/`setPistolStart`) beside the inventory it
replaces, and `game.ts: enterLevel` is the only reader: the one place a level *transition* installs
an inventory, which is why loading a savegame and continuing from a checkpoint are untouched by it.
Read at each transition rather than captured per `Game`, so toggling it mid-run applies from the
next level on. The three ways a fresh inventory happens meet there and nowhere else — a dead
player's reborn (docs/death.md § Player death), an episode crossing (docs/hud.md § End card), and
this setting.

The DEVMODE `N`/`P` map jump goes through `enterLevel` too, so it pistol-starts along with
everything else while this is on. `R` after a death is unaffected on purpose: it restores the
checkpoint written when the level was entered, which under this setting *is* a pistol start.

## Collecting things

Removing a picked-up item from the world is `ThingLayer`'s job, not `Inventory`'s: each posed thing
already carries its doomednum and position, so `tryPickup(x, y, z, radius, consume)` tests distance
and calls back into `applyPickup`, hiding the mesh and marking it `picked` only if `consume` reports
the pickup actually happened. `picked` short-circuits `ThingLayer.update` before it touches
fog-of-war visibility — without that, a subsector coming into view after its item was picked would
make `fogAlphaOf` flip the permanently-hidden mesh back to visible.

**`tryPickup`'s `z` check** exists because 2D distance alone lets a player standing at the *base* of a
not-yet-lowered pillar collect an item still on top of it — DOOM2 MAP04's blue key does exactly this.
Matching `PIT_CheckThing`'s overhead gate, a pickup more than `PLAYER_HEIGHT` above or below the
player is skipped regardless of 2D range. That in turn requires a thing's height to track its
sector's *live* `floorHeight` rather than a value cached at load: `PosedThing` stores the `Sector`
reference itself (the same mutable object `SpecialsController` writes `floorHeight`/`light` onto)
instead of a frozen `z`, and both `ThingLayer.update` and `tryPickup` read `sector.floorHeight` fresh
every call. Without this, an item on a lift would hang frozen in its original position while the
floor moved past it, and stay permanently out of reach even after the pillar carrying it lowered.

## Making monster drops readable

A monster's death drop (`MONSTER_DROPS`) was nearly invisible, because it spawns at *exactly* the
corpse's own position: the two upright sprite planes are coplanar, so the depth test resolves them
by draw order and the clip ends up buried inside the corpse art. Three things fix it together
(`game/things.ts`, all tuned by feel), and each covers a case the others don't:

- **A drop is drawn hovering `DROP_HOVER` above the floor, bobbing `DROP_BOB` either side of it.** A
  corpse's silhouette is ground-hugging, so lifting the item clears most of it geometrically — and
  where the item does overlap, it mostly overlaps *transparent* corpse pixels, which alpha-test away
  without writing depth. This is **render-only**: `tryPickup` and everything else still work off the
  thing's real `z`, so hovering can't put an item out of reach.
- **Drops draw through their own `SpriteBatch`, constructed with `DROP_DEPTH_BIAS`** — a
  `polygonOffset` that pulls their fragments a few depth-buffer units toward the camera. That is what
  settles the coplanar tie above, deterministically and in the item's favour. It is deliberately far
  too small to punch through geometry genuinely in front of the item; **don't raise it** to solve a
  different problem, or drops start showing through walls. It matters *more* now that drops are
  translucent: a transparent material draws after all opaque geometry but is still depth-tested, and
  an exact tie fails a `LESS` test outright. Costs no extra draw calls either way — batching is
  per-lump anyway and a drop never shares a lump with a monster.
- **A drop pulses in and out**, fading between `DROP_OPACITY_MIN` and `DROP_OPACITY_MAX` over
  `DROP_PULSE_SECONDS` (`SpriteBatch.setOpacity`). What catches the eye is the *change*, so nothing
  has to be brightened or recoloured and the item still looks like its own art. The fade is
  **batch-wide, not per-instance** — `instanceColor` has no alpha channel, so per-sprite opacity
  would need a custom shader — meaning every drop on screen pulses in step. The hover bob is
  per-instance phased, which keeps two drops side by side from looking like one object.

**Only drops get any of this** — `PosedThing.dropped` is the whole test. Items the map placed sit
where the mapper put them, unlit and unmoved: nothing is lying underneath them, and singling out
every clip and health bonus in the level reads as noise rather than information.

## Locked doors and use triggers

**Keys are tracked per exact slot, and locks are `LockRule`s** (`game/inventory.ts: KeySlot`,
`specials/defs.ts: LockRule` + `satisfiesLock`). Vanilla merges card and skull of a color at check
time (`p_doors.c` tests both), but Boom's generalized locked doors can tell them apart
(`P_CanUnlockGenDoor`), so the inventory holds up to six `KeySlot`s and the lock says what it
demands: `color` (card *or* skull — every vanilla keyed number), `slot` (exact card/skull), `any`,
or `all` (three colors or all six slots, Boom's SkullsAreCards bit). The lock lives on
`SpecialDef.lock`, not on the door effect: in Boom a lock is not a door-only concept.

`game/specials/tables.ts`'s keyed door specials (26-28, 32-34, 99, 133-137) each carry a color
lock — resolved per-special against `P_UseSpecialLine` rather than guessed, since the two
manual-door groups don't share an ordering (26/27/28 are Blue/Yellow/Red, 32/33/34 are
Blue/Red/Yellow). `trigger` checks `satisfiesLock` before doing anything else — no flashing switch
texture, no `usedOnce` mark — so a player without the key can walk off, find it, and press the
same line later, matching vanilla. `ownedKeys` is threaded from `Game.frame` as
`this.inventory.keys` on every `SpecialsController.update` call, same as `playerX`/`playerY`.

**A refused line reports what it wants** — vanilla's `oof` plus its message, both. `trigger`
records the refusal as a `LockedLine` (the `LockRule`, plus `'door'` vs `'switch'`) rather than
showing anything itself: it has no HUD, the same reason `onExit`/`onTeleport` are callbacks.
`Game.frame`
drains it with `consumeLockedLine()` right after `specials.update` — every keyed special is a `use`
trigger, so that one call site catches all of them — and shows the text (docs/hud.md § Center
messages). The
text is `d_englsh.h`'s verbatim: for color locks, vanilla's own door/switch split — `PD_*K` "You
need a blue key to open this door" (`EV_VerticalDoor`, the manual doors 26-28/32-34) vs. `PD_*O`
"...to activate this object" (`EV_DoLockedDoor`, the remote switches 99/133-137) — a split
`def.manual` already draws exactly; for Boom's generalized locks, Boom's `PD_*C`/`PD_*S`/`PD_ANY`/
`PD_ALL3`/`PD_ALL6` wordings (door-only, as in Boom — `ui/hud/message.ts: lockedLineMessage`).
The vanilla ones say "key" for a skull because vanilla's checks accept
either, testing both `it_*card` and `it_*skull`, which is also why `KeyColor` has three values and
not six.

Getting the key check to fire surfaced a second bug in the same table: 99 and 133-137 were missing or
mismarked `manual: true`. Unlike 26-34 (real D1 manual doors, which open the *linedef's own* back
sector and ignore tag entirely), 99/133-137 are S1/SR switches that target sectors by tag — confirmed
by scanning every stock map, where every 99/133-137 linedef's tag exactly matches the sector(s) it
opens. The concrete bug: DOOM2 MAP04's blue door (special 99, missing from the table) never opened at
all, key or no key.

**A `use` trigger only fires from a linedef's front (right-sidedef) side** — `isFrontSide`, confirmed
against `p_switch.c`'s `P_UseSpecialLine`, which unconditionally rejects every use-triggered special
from the back side except an unused one (124). `handleUseTrigger` computes the player's side of each
candidate line (via `P_PointOnLineSide`'s cross-product test) and skips any line the player is behind,
same as `PTR_UseTraverse`. Walk triggers get no such check — `P_CrossSpecialLine` has none — so this
is `use`-only. Without it, a manual door or switch mounted on an ordinary-looking wall (a disguised
"push wall" secret) could be opened from *either* side, letting a player skip the switch a mapper hid
elsewhere; E1M2's sector 21 secret is exactly this shape.

## Powerups and the backpack

`Inventory.powers` holds seconds remaining per `PowerId`, ticked by `tickPowers`, which `game.ts`
calls only while alive (matching `P_PlayerThink` handing off to `P_DeathThink` before it reaches
them). Durations are vanilla's `INVULNTICS`/`INVISTICS`/`IRONTICS`/`INFRATICS` over 35 — plain
constants that survive conversion out of tics intact, unlike `weapons.ts`'s fire rates. Berserk and
the computer area map are `Infinity`: vanilla stores them as a flag that never counts down, and
`finishLevel` clears them along with every other power anyway.

`givePower` reproduces `P_GivePower`'s three-way split rather than treating the six uniformly: the
four timed ones always take and **restart** their clock (they never stack), berserk always takes and
additionally tops health back up to the normal 100 cap (`P_GiveBody`, never past it the way a bonus
item would) and switches to the fist, and the computer area map is the only one that can be
**refused** — it falls into `P_GivePower`'s generic "already got it" branch, so a second one stays on
the ground.

Where each effect lives is the load-bearing part, since only two of the seven are inventory
arithmetic:

- **Backpack** (`ammoMax`) doubles every cap permanently and hands over one `CLIP_AMMO` of each class.
  Every cap check in `inventory.ts` routes through `ammoMax` rather than reading `AMMO_MAX` — a weapon
  pickup's own ammo grant respects the raised cap too. It is always consumed, even at full ammo,
  unlike every other ammo pickup.
- **Invulnerability** is checked in `applyDamage`, in the same place and with the same `damage < 1000`
  threshold `P_DamageMobj` uses.
- **Radiation suit** gates `SectorEffects.update`'s damage through `suitBlocks`, and vanilla is deliberately not
  uniform here: `DamageFloorEffect.suit` is per sector type — nukage/hellslime are blocked outright,
  the two 20-damage slimes share a `case` reading `!pw_ironfeet || (P_Random()<5)` so a suit still
  leaks `SUIT_LEAK_CHANCE` of hits, and E1M8's finale type (11) never consults the suit at all. The
  interval keeps running while a hit is blocked (vanilla's clock is the global `leveltime&0x1f`), so
  the suit skips damage rather than banking it up for the moment it expires.
- **Berserk**'s ×10 is applied in `WeaponSystem.fire`, to the **fist only** — `A_Punch` reads
  `pw_strength` and `A_Saw` deliberately doesn't.
- **Computer area map** is the one whose whole effect lives outside `Inventory`: `FogOfWar.revealAll`,
  watched for by doomednum (`ThingType.computerMap`) in `game.ts`'s pickup callback. Here that *is*
  vanilla's `pw_allmap` — this engine's play view and its map view are the same view, so revealing the
  geometry is exactly what filling in the automap does. It sets only the `explored` flags, not
  `alpha`, so the ordinary reveal lerp fades the level in rather than snapping it on.
- **Partial invisibility** is two things, neither of them a rule about being seen:
  `INVISIBILITY_OPACITY` on the player sprite, and `applyShadowAim` throwing a monster's *ranged* shot
  off-aim by vanilla's own `A_FaceTarget` fuzz (`(P_Random()-P_Random())<<21`, up to ±44.8°,
  `SHADOW_AIM_SPREAD_DEG`). That fuzz is the entire vanilla mechanic — `MF_SHADOW` never touches
  `P_CheckSight`, waking, or a monster's willingness to attack, so none of those are gated on it here
  either. Applied per shot (each bullet of a burst goes its own way) and only to a shot aimed at the
  player (`targetId === null`): nothing else carries `MF_SHADOW`, and an infight shouldn't go wide
  because the player drank something. Melee is deliberately unaffected, matching vanilla, whose melee
  lands on `P_CheckMeleeRange` rather than the fuzzed angle.
- **Light amplification visor** rides `WebGLRenderer.toneMappingExposure` (`LIGHT_VISOR_EXPOSURE`).
  `render/viewport.ts`'s `Viewport` sets `toneMapping = LinearToneMapping` **once**, at construction:
  changing `toneMapping`
  itself recompiles every material's shader, while the exposure is a plain uniform, and
  `LinearToneMapping` at exposure 1 is `saturate(color)` — bit-identical to `NoToneMapping` for
  anything already in range, so it costs nothing until the visor turns it up. A flat multiply is an
  approximation of vanilla's "force the brightest colormap row everywhere"; matching that exactly
  would mean rebuilding every surface's baked vertex lighting.

## Skill

Two of the five skills change what a pickup or a hit is worth, and both rules live in `skill.ts`
next to the spawn filter, since the skill is the only thing they depend on:

- **`ammoAtSkill`** doubles every ammo grant on skill 1 *and* skill 5 — `P_GiveAmmo`'s
  `if (gameskill == sk_baby || gameskill == sk_nightmare) num <<= 1`, a trainer bonus at one end and
  a concession to respawning monsters at the other. It reaches all three paths that hand over ammo,
  because vanilla's do too: plain ammo pickups, a weapon's own ammo, and the backpack's clip of
  each class. Order matters where a monster dropped the pickup — vanilla halves for the drop first
  (`P_GiveAmmo(…, 0)`, which is `clipammo/2`) and doubles after, so a dropped clip on skill 1 is
  worth exactly a full one — and the `ammoMax` cap still applies last.
- **`playerDamageAtSkill`** halves damage on skill 1 only: `P_DamageMobj`'s
  `if (player && gameskill == sk_baby) damage >>= 1`. It is applied at the top of
  `game.ts: damagePlayer`, before anything else reads the number, which is where vanilla applies it
  too — so knockback, the pain flash and the death cry's overkill test all see the reduced figure,
  and armor absorbs its share of that rather than of the original. Only the player gets it; a
  monster on skill 1 takes exactly what it always took.

Everything else the skill decides lives elsewhere: which things spawn at all is `spawnsAtSkill`
(docs/sprites.md § Which things spawn), and nightmare's fast monsters are
docs/monster-ai.md § Fast monsters.
