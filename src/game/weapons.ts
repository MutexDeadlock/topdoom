/**
 * `WeaponSystem`: the nine weapons — selection and slot toggling, vanilla fire rates, spread and
 * damage rolls, ammo spend — raising fire events for `game.ts` to realize. See docs/weapons.md.
 */
import { getAutoSwitchWeapon, hasPower, type AmmoType, type Inventory, type WeaponId } from './inventory.ts';
import type { WeaponsSnapshot } from './snapshot.ts';
import type { Input } from './input.ts';
import { PLAYER_ORIGIN, type SfxId, type SoundEmitter } from '../audio/sfx.ts';
import type { Pos3 } from '../types.ts';
import { DOOM_TIC } from '../constants.ts';
import { rollDamage, triangularDraw, triangularSpread } from '../util/random.ts';
import { pristineFrameTables } from './dehacked/frames.ts';
import { WEAPON_ORDER } from './dehacked/tables.ts';

/**
 * How often the chainsaw's idle rattle restarts while it's the ready weapon:
 * vanilla's `S_SAW` state holds 4 tics and `A_WeaponReady` plays `sawidl` every
 * time it loops, each start cutting off the last (they share the player's
 * origin). That restart *is* the engine note — the lump is longer than the
 * interval, so only its first fraction is ever heard.
 */
const SAW_IDLE_INTERVAL = 4 * DOOM_TIC;

/**
 * Vanilla's `MELEERANGE`: how far `A_Punch`/`A_Saw` trace out from the
 * player's own centre. `game/monsters/defs.ts` keeps its own, slightly longer
 * `MELEE_RANGE` for the *monster* side of the same idea — that one is a
 * body-to-body distance sampled per frame rather than per tic and carries
 * slack for it; this is a plain trace length, so it's vanilla's number as-is.
 */
export const PLAYER_MELEE_RANGE = 64;

/**
 * What berserk multiplies a **fist** punch by — vanilla's `A_Punch`, which
 * scales its own `(P_Random()%10+1)*2` roll by 10 while `pw_strength` is
 * held, turning a 2-20 tickle into 20-200. `A_Saw` deliberately does not read
 * the power at all, so the chainsaw is unaffected in vanilla and here.
 */
const BERSERK_FIST_MULTIPLIER = 10;

/**
 * The super shotgun's per-pellet slope jitter (`WeaponDef.slopeSpread`), out
 * of vanilla's 16.16 fixed point: `A_FireShotgun2` traces each pellet at
 * `bulletslope + ((P_Random()-P_Random())<<5)`, so the extremes are
 * ±(255<<5)/FRACUNIT of rise per unit travelled — about ±7°, or ±32 units of
 * height at 256 units out.
 */
const SSG_SLOPE_SPREAD = (255 * 32) / 65536;

/**
 * The super shotgun's reload sounds and how many tics after its shot each one
 * lands. `info.c`'s `S_DSGUN` chain carries them as state actions —
 * `A_OpenShotgun2` on `S_DSGUN5`, `A_LoadShotgun2` on `S_DSGUN7`,
 * `A_CloseShotgun2` on `S_DSGUN9`, all three in `p_enemy.c` — so each tic here
 * is the length of the states between `S_DSGUN2`'s own `A_FireShotgun2` and
 * that one: 7+7+7, then +7+7, then +7+6. docs/audio.md § Weapons and
 * projectiles.
 */
const SSG_RELOAD_SOUNDS: { tic: number; sfx: SfxId }[] = [
  { tic: 21, sfx: 'dbopn' },
  { tic: 35, sfx: 'dbload' },
  { tic: 48, sfx: 'dbcls' },
];

/** Tics from the shot to the last of `SSG_RELOAD_SOUNDS`, i.e. the whole sequence's length. */
const SSG_RELOAD_TICS = 48;

/**
 * When `A_CheckReload` runs (`S_DSGUN4`, 14 tics after the shot): finding fewer
 * than two shells left there, its `P_CheckAmmo` lowers the weapon, so the
 * psprite never reaches the three states above and a shot fired with the last
 * shells reloads silently.
 */
const SSG_RELOAD_CHECK_TIC = 14;

export interface WeaponDef {
  /** Ammo class this weapon spends, or null for the ammo-less melee weapons. */
  ammoType: AmmoType | null;
  ammoPerShot: number;
  /**
   * Seconds between shots while the trigger is held — **vanilla's own state
   * chain, not tuned by feel**, and notably excluding the `A_ReFire` state's
   * own tics. docs/weapons.md § Fire rates.
   */
  cooldown: number;
  kind: 'melee' | 'hitscan' | 'projectile';
  /** Hitscan only: bullets/pellets fired per trigger pull. */
  pellets: number;
  /** Each pellet's (or melee swing's) random spread off the aim line, in degrees. */
  spreadDeg: number;
  /**
   * Per-pellet random jitter of the *aim slope*, in vanilla's own slope units
   * (dz per unit travelled) — only the super shotgun has one, and it is the
   * one weapon in the game whose pellets scatter vertically as well as
   * horizontally. 0 everywhere else, which keeps every other weapon's pellets
   * exactly on the slope auto-aim resolved.
   */
  slopeSpread: number;
  /**
   * Whether the **first** shot of a held trigger ignores `spreadDeg` entirely
   * — `P_GunShot(mo, !player->refire)`, passed by `A_FirePistol` and
   * `A_FireCGun` and by nothing else (`A_FireShotgun` hardcodes `false`). It
   * is what makes a tapped pistol/chaingun shot dead accurate at any range
   * while a held burst walks off target.
   */
  accurateFirstShot: boolean;
  /**
   * Melee only: how far in front of the player the swing reaches (`PLAYER_MELEE_RANGE`); 0 for
   * everything else.
   */
  meleeRange: number;
  /**
   * Projectile only: travel speed, map units/sec — the spawned missile's own `mobjinfo.speed`
   * (units per tic) × 35, the same conversion `game/monsters/tables.ts` applies to theirs.
   */
  projectileSpeed: number;
  /** Projectile only: SpriteBank name the flying shot is drawn as. */
  projectileSprite: string;
  /**
   * Status-bar icon lump. Reuses the ground pickup's own sprite frame (the
   * same convention ui/hud/hud.ts already uses for ammo/keys/health) for every
   * weapon that has one; fist and pistol have no map pickup, so their own
   * first-person "ready" frame stands in instead.
   */
  iconLump: string;
  /**
   * A direct/pellet hit's damage roll: `((rand % damageDiceSides) + 1) * damageDiceMultiplier`,
   * the one shape both vanilla formulas (`P_GunShot`'s bullets, `PIT_CheckThing`'s missiles)
   * reduce to. See docs/weapons.md § Damage rolls.
   */
  damageDiceSides: number;
  damageDiceMultiplier: number;
  /**
   * The sound one trigger pull makes — **once per pull, not per pellet**
   * (`A_FireShotgun` plays `shotgn` once for all seven). `null` where the shot's
   * sound comes from somewhere else: the rocket launcher and plasma rifle have
   * no weapon sound of their own in vanilla, the missile they spawn brings its
   * `mobjinfo.seesound` with it (`game.ts`'s `PROJECTILE_SOUNDS`), and a melee
   * swing's sound depends on whether it connected.
   */
  fireSound: SfxId | null;
  /**
   * Melee only: the swing's sound on connecting and on missing — `A_Punch`'s
   * `punch` (silent on a miss, hence a null `missSound`), `A_Saw`'s
   * `sawhit`/`sawful`. Both null for everything else.
   */
  hitSound: SfxId | null;
  missSound: SfxId | null;
  /**
   * Splash a projectile's impact also applies — a fixed radius/damage pair (`A_Explode`'s constant
   * 128), deliberately independent of the direct-hit roll above. `hitsPlayer` is the rocket-jump
   * self-damage rule. See docs/combat.md § Splash and the BFG.
   */
  splash: { radius: number; damage: number; hitsPlayer: boolean } | null;
  /**
   * The BFG ball's real secondary attack, vanilla's `A_BFGSpray` (`p_enemy.c`): `rays` independent
   * traces fanned across `arcDeg` from the player's own live position, each dealing `diceRolls`
   * d`diceSides` undiminished. Nothing like a radius splash — see docs/combat.md § Splash and the
   * BFG. `null` for every weapon but the BFG.
   */
  spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number } | null;
  /**
   * Which weapon's shipped player skin draws this one — itself, until a patch moves the shot.
   * `null` where no shipped skin depicts what it fires, which takes the whole set out of use
   * (`playerSkinWeapon`). Presentation, like `iconLump`, and borrowed with the rest of the shot
   * when a fire chain is repointed. docs/sprites.md § Weapon-matching player sprites.
   */
  skinWeapon: WeaponId | null;
}

/**
 * Keyboard slot 1-7 → the weapons in it, best (most upgraded) first. A digit
 * key not already selecting a weapon from this slot jumps to the best one
 * owned; pressed again (matching vanilla's own slot-sharing for fist/chainsaw
 * and shotgun/supershotgun) it steps to the *next* owned weapon in the slot
 * instead, so repeated presses toggle between the two rather than always
 * landing back on the same "best" pick — otherwise a slot's weaker weapon
 * would be permanently unreachable once its upgrade is owned.
 */
export const WEAPON_SLOTS: WeaponId[][] = [
  ['chainsaw', 'fist'],
  ['pistol'],
  ['supershotgun', 'shotgun'],
  ['chaingun'],
  ['rocketLauncher'],
  ['plasmaRifle'],
  ['bfg'],
];

/**
 * The mouse wheel's order, and the HUD icon strip's: the slot order above with
 * each shared slot read weakest first, which is also weakest-to-strongest
 * overall. Derived rather than written out, so a weapon added to a slot lands
 * beside its slotmate here too — docs/weapons.md § The wheel walks the slot order
 */
export const WEAPON_CYCLE: WeaponId[] = WEAPON_SLOTS.flatMap((slot) => [...slot].reverse());

/**
 * `P_CheckAmmo`'s fallback chain (`p_pspr.c`), first match wins: what the ready weapon is replaced
 * with once it can no longer fire. A third order, unrelated to `WEAPON_SLOTS` and `WEAPON_CYCLE`
 * above — vanilla's own preference for "still useful right now", which is why the BFG sits below
 * the fist's neighbours and the chainsaw outranks a rocket launcher.
 * docs/weapons.md § Automatic weapon switching.
 *
 * `minAmmo` is **strictly greater than**, and it is not `ammoPerShot`: the chain wants *three*
 * shells before it hands you a super shotgun that fires on two, and *41* cells before a BFG that
 * fires on 40. Vanilla's own off-by-one, transcribed rather than corrected.
 *
 * Two deviations from that C, both deliberate:
 * - vanilla's `gamemode` clauses (`!= shareware` on plasma/BFG, `== commercial` on the SSG) are
 *   dropped: this engine has no gamemode, and ownership already subsumes them — a WAD without the
 *   weapon has no pickup for it, and where a PWAD does place one, owning it is the honest answer.
 * - the pistol row tests ownership, which vanilla's bare `else if (player->ammo[am_clip])` does not
 *   (it cannot lose the pistol). `Inventory.weapons` is a real set this engine treats as
 *   authoritative for the wheel and the HUD strip, so landing on an unowned weapon would contradict
 *   both. `fist` needs no such test — nothing removes it, and it is the chain's terminator.
 */
const AMMO_FALLBACK_ORDER: { weapon: WeaponId; ammo: AmmoType | null; minAmmo: number }[] = [
  { weapon: 'plasmaRifle', ammo: 'cells', minAmmo: 0 },
  { weapon: 'supershotgun', ammo: 'shells', minAmmo: 2 },
  { weapon: 'chaingun', ammo: 'bullets', minAmmo: 0 },
  { weapon: 'shotgun', ammo: 'shells', minAmmo: 0 },
  { weapon: 'pistol', ammo: 'bullets', minAmmo: 0 },
  { weapon: 'chainsaw', ammo: null, minAmmo: 0 },
  { weapon: 'rocketLauncher', ammo: 'rockets', minAmmo: 0 },
  { weapon: 'bfg', ammo: 'cells', minAmmo: 40 },
];

/**
 * A weapon as written out here: every field its own state chain can't carry.
 * `cooldown` is absent on purpose and cannot be written — the fill loop below
 * walks it out of `info.c`'s own fire chain, which is what turns these seeds
 * into complete `WeaponDef`s.
 */
type WeaponSeed = Omit<WeaponDef, 'cooldown' | 'skinWeapon'>;

/**
 * **Every number in this table is vanilla's** — spread from the `<<18`/`<<19`
 * shifts in `p_pspr.c`, damage from `P_GunShot`/`PIT_CheckThing`, ammo cost
 * from `P_FireWeapon`, projectile speed from `mobjinfo`; the fire rates are
 * walked out of the weapon state chains further down. Nothing here is tuned
 * by feel; a top-down camera changes how a weapon is *aimed*, not how fast it
 * shoots or how hard it hits. See docs/weapons.md § Fire rates.
 */
const WEAPON_SEED: Record<WeaponId, WeaponSeed> = {
  fist: {
    ammoType: null,
    ammoPerShot: 0,
    kind: 'melee',
    pellets: 0,
    // A_Punch throws the *swing* off by the same <<18 draw a bullet gets. It
    // matters far less than a bullet's: at MELEERANGE that is ~6 units of arc
    // against `MONSTER_HIT_RADIUS`.
    spreadDeg: 5.6,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: PLAYER_MELEE_RANGE,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'PUNGA0',
    fireSound: null,
    hitSound: 'punch',
    missSound: null,
    // Vanilla A_Punch: (P_Random()%10+1)<<1, i.e. 2-20, times 10 with berserk.
    damageDiceSides: 10,
    damageDiceMultiplier: 2,
    splash: null,
    spray: null,
  },
  chainsaw: {
    ammoType: null,
    ammoPerShot: 0,
    kind: 'melee',
    pellets: 0,
    // A_Saw's own <<18 swing spread, identical to A_Punch's.
    spreadDeg: 5.6,
    slopeSpread: 0,
    accurateFirstShot: false,
    // `A_Saw` really traces MELEERANGE+1, with vanilla's own comment saying
    // why: "use meleerange + 1 se the puff doesn't skip the flash". The extra
    // unit of reach is incidental; the puff is what it's for (spritefx/tables.ts's
    // PUFF_MELEE_FRAMES).
    meleeRange: PLAYER_MELEE_RANGE + 1,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'CSAWA0',
    fireSound: null,
    hitSound: 'sawhit',
    missSound: 'sawful',
    // Vanilla A_Saw rolls the same 2-20 as the punch — the chainsaw's advantage
    // is its fire rate (`cooldown`), not a bigger bite, and berserk never
    // touches it (see BERSERK_FIST_MULTIPLIER).
    damageDiceSides: 10,
    damageDiceMultiplier: 2,
    splash: null,
    spray: null,
  },
  pistol: {
    ammoType: 'bullets',
    ammoPerShot: 1,
    kind: 'hitscan',
    pellets: 1,
    // P_GunShot's `(P_Random()-P_Random())<<18` — 255<<18 of a 2^32 turn.
    spreadDeg: 5.6,
    slopeSpread: 0,
    accurateFirstShot: true,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'PISGA0',
    fireSound: 'pistol',
    hitSound: null,
    missSound: null,
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  shotgun: {
    ammoType: 'shells',
    ammoPerShot: 1,
    kind: 'hitscan',
    pellets: 7,
    // A_FireShotgun calls P_GunShot(mo, false) seven times: the same <<18 as
    // the pistol, and never the accurate first shot.
    spreadDeg: 5.6,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'SHOTA0',
    fireSound: 'shotgn',
    hitSound: null,
    missSound: null,
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  supershotgun: {
    ammoType: 'shells',
    ammoPerShot: 2,
    kind: 'hitscan',
    pellets: 20,
    // A_FireShotgun2 doesn't go through P_GunShot at all: its own loop uses
    // `<<19`, twice the shotgun's cone, and is the only spread in the game
    // that also jitters the slope.
    spreadDeg: 11.2,
    slopeSpread: SSG_SLOPE_SPREAD,
    accurateFirstShot: false,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'SGN2A0',
    fireSound: 'dshtgn',
    hitSound: null,
    missSound: null,
    // Vanilla's own per-pellet roll, not an approximation: `A_FireShotgun2`
    // inlines the identical `5*(P_Random()%3+1)` `P_GunShot` uses, so the
    // 20-vs-7 pellet count is the SSG's whole advantage.
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  chaingun: {
    ammoType: 'bullets',
    ammoPerShot: 1,
    kind: 'hitscan',
    pellets: 1,
    spreadDeg: 5.6,
    slopeSpread: 0,
    // A_FireCGun passes !player->refire exactly as A_FirePistol does, so a
    // tapped chaingun shot is dead accurate and a held burst is not.
    accurateFirstShot: true,
    meleeRange: 0,
    projectileSpeed: 0,
    projectileSprite: '',
    iconLump: 'MGUNA0',
    // A_FireCGun plays the *pistol* shot, not the `chgun` lump that shares its
    // name with the weapon — `chgun` is in vanilla's sound table and reached by
    // nothing at all.
    fireSound: 'pistol',
    hitSound: null,
    missSound: null,
    // Vanilla's chaingun reuses the pistol's own damage roll.
    damageDiceSides: 3,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  rocketLauncher: {
    ammoType: 'rockets',
    ammoPerShot: 1,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: 0,
    // MT_ROCKET's mobjinfo speed, 20 units/tic.
    projectileSpeed: 20 * 35,
    projectileSprite: 'MISL',
    iconLump: 'LAUNA0',
    // `rlaunc` comes from MT_ROCKET itself — see fireSound's doc.
    fireSound: null,
    hitSound: null,
    missSound: null,
    damageDiceSides: 8,
    damageDiceMultiplier: 20,
    // Vanilla's A_Explode: a fixed 128/128 radius attack, independent of the
    // direct-hit roll above.
    splash: { radius: 128, damage: 128, hitsPlayer: true },
    spray: null,
  },
  plasmaRifle: {
    ammoType: 'cells',
    ammoPerShot: 1,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: 0,
    // MT_PLASMA's mobjinfo speed, 25 units/tic.
    projectileSpeed: 25 * 35,
    projectileSprite: 'PLSS',
    iconLump: 'PLASA0',
    // As with the rocket: `plasma` is MT_PLASMA's own seesound.
    fireSound: null,
    hitSound: null,
    missSound: null,
    // MT_PLASMA's mobjinfo damage is 5, rolled by PIT_CheckThing's shared
    // ((P_Random()%8)+1), so 5-40.
    damageDiceSides: 8,
    damageDiceMultiplier: 5,
    splash: null,
    spray: null,
  },
  bfg: {
    ammoType: 'cells',
    ammoPerShot: 40,
    kind: 'projectile',
    pellets: 0,
    spreadDeg: 0,
    slopeSpread: 0,
    accurateFirstShot: false,
    meleeRange: 0,
    // MT_BFG's mobjinfo speed, 25 units/tic — the same as a plasma bolt's.
    projectileSpeed: 25 * 35,
    projectileSprite: 'BFS1',
    iconLump: 'BFUGA0',
    // The one projectile weapon with a sound of its own: MT_BFG's seesound is 0
    // and `A_BFGsound` is a separate state action that plays this.
    fireSound: 'bfg',
    hitSound: null,
    missSound: null,
    // MT_BFG's own mobjinfo damage is 100, so the ball's *contact* hit alone
    // is 100-800 before `spray` adds anything.
    damageDiceSides: 8,
    damageDiceMultiplier: 100,
    // A_Explode is never called on the BFG ball in vanilla — see
    // WeaponDef.splash's doc — its real secondary damage is `spray` below.
    splash: null,
    // See WeaponDef.spray's doc — vanilla's real A_BFGSpray numbers.
    spray: { rays: 40, arcDeg: 90, range: 16 * 64, diceRolls: 15, diceSides: 8 },
  },
};

/**
 * The seeds above, completed by the fill loop below. The cast is what the loop discharges: every
 * weapon has its `cooldown` and its `skinWeapon` before anything reads this table.
 */
export const WEAPONS = WEAPON_SEED as Record<WeaponId, WeaponDef>;

/**
 * Writes every weapon's fire rate from the walker's reading of vanilla's own `states[]`
 * (docs/weapons.md § Fire rates) — the summed tics of its `atkstate` chain, the `A_ReFire` state
 * excluded, over the number of shots one pass fires. The rest of each row is `p_pspr.c` data no
 * chain carries and stays written out above. `skinWeapon` starts as the identity here rather than as
 * nine hand-written rows: unpatched, every weapon is drawn as itself.
 *
 * Runs at import, before `dehacked/apply.ts` snapshots the table for `resetDehacked`.
 */
const vanillaRates = pristineFrameTables().weapons;
for (const [index, id] of WEAPON_ORDER.entries()) {
  WEAPONS[id].cooldown = vanillaRates[index].cooldown;
  WEAPONS[id].skinWeapon = id;
}

/**
 * Which weapon's shipped player art draws `weapon`, or null for none at all — the one reader of
 * `WeaponDef.skinWeapon`, so the set-wide rule lives with the field rather than at the draw site.
 *
 * A patch that repoints a fire chain at another weapon's firing action moves the art with the shot:
 * nosp4.wad's chainsaw fires rockets and is drawn holding the launcher. One that leaves a weapon
 * firing something no shipped skin depicts takes the **whole set** out of use, the loaded set's own
 * `PLAY` art standing in for every weapon — art that lies about one weapon in hand is worse than no
 * weapon-matching art at all. docs/sprites.md § Weapon-matching player sprites.
 */
export function playerSkinWeapon(weapon: WeaponId): WeaponId | null {
  for (const id of WEAPON_ORDER) {
    if (WEAPONS[id].skinWeapon === null) return null;
  }
  return WEAPONS[weapon].skinWeapon;
}

export interface HitscanShot {
  kind: 'hitscan';
  angleRad: number;
  /**
   * This pellet's own jitter off the shot's aim *slope* (`WeaponDef.slopeSpread`),
   * as rise per unit travelled — non-zero only for the super shotgun. Applied
   * by moving the aim point up or down at the target's distance, since that is
   * what `shotPath` derives its slope from.
   */
  slopeOffset: number;
  /**
   * This pellet's own damage roll (WeaponDef.damageDiceSides/Multiplier) — applied only if this
   * pellet's own `angleRad`, spread included, lands on a body (game/projectiles.ts:
   * spawnPlayerShot).
   */
  damage: number;
}

export interface ProjectileShot {
  kind: 'projectile';
  angleRad: number;
  speed: number;
  sprite: string;
  /**
   * Direct-hit damage roll, applied on arrival if this shot was locked onto a monster that it
   * actually reached.
   */
  damage: number;
  /**
   * Splash to apply at the impact point regardless of what (if anything) was targeted, straight
   * from WeaponDef.splash — null for a non-explosive projectile (plasma, BFG).
   */
  splash: { radius: number; damage: number; hitsPlayer: boolean } | null;
  /**
   * The BFG's real secondary attack on arrival, straight from WeaponDef.spray — null for every
   * other projectile.
   */
  spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number } | null;
}

export interface MeleeShot {
  kind: 'melee';
  angleRad: number;
  /** How far in front of the player this swing reaches (`WeaponDef.meleeRange`). */
  range: number;
  /** This swing's damage roll, already scaled by berserk where it applies. */
  damage: number;
  /**
   * Carried from `WeaponDef.hitSound`/`missSound` so whoever resolves the
   * swing doesn't have to look the weapon back up to know what it sounds like
   * — the same reason a `ProjectileShot` carries its own sprite and splash.
   */
  hitSound: SfxId | null;
  missSound: SfxId | null;
}

export type Shot = HitscanShot | ProjectileShot | MeleeShot;

/** What `update`'s two sound passes both work from, built once per call. */
interface SoundFrame {
  dt: number;
  firing: boolean;
  /** Whether `inv.currentWeapon` differs from what was selected on the previous frame. */
  justSwitched: boolean;
  inv: Inventory;
  audio: SoundEmitter;
  /** The player's own position, which vanilla attenuates the weapon's sounds from. */
  at: Pos3;
}

/**
 * Owns weapon selection (number keys, mouse wheel) and fire timing/ammo. Knows nothing about
 * three.js or what a shot hits: `update` returns the `Shot`s fired this frame and the layers above
 * realize them. See docs/weapons.md § WeaponSystem.
 */
export class WeaponSystem {
  /**
   * Tics until the trigger may fire again, counted as a **whole number** rather
   * than as seconds remaining. The simulation steps one tic at a time and every
   * `WeaponDef.cooldown` is a whole number of tics, so an integer countdown is
   * both exact and the same model vanilla has — a psprite sitting in a state
   * with that many tics left. Seconds invited a float residue to decide whether
   * a shot landed on tic N or N+1, which is a whole 33% of the plasma rifle's
   * rate. docs/weapons.md § Fire rates.
   */
  private cooldownTics = 0;
  /**
   * Which weapon was selected as of the previous frame, so a switch can be
   * noticed at all — it can come from a key, the wheel *or* a pickup, so this
   * is compared once a frame rather than at each of those. See `update`.
   */
  private weaponLastFrame: WeaponId = 'pistol';
  /**
   * The weapon selected before the current one, for the right button's
   * "switch to previous weapon" binding. Maintained off `weaponLastFrame`'s
   * once-a-frame comparison so a pickup- or berserk-driven switch counts too,
   * exactly as that field's own doc describes. Null until the first switch of
   * the level.
   */
  private previousWeapon: WeaponId | null = null;
  /**
   * The weapon last selected out of each slot, indexed like `WEAPON_SLOTS` and
   * null where the slot hasn't been used yet this level. Maintained off the
   * same once-a-frame comparison `previousWeapon` is, for the same reason —
   * docs/weapons.md § Slot keys
   */
  private slotWeapon: (WeaponId | null)[] = [];
  /** Counts down to the chainsaw's next idle rattle — see `SAW_IDLE_INTERVAL`. */
  private sawIdleTimer = 0;
  /**
   * Tics since the super shotgun's last shot while its reload is still running,
   * or -1 when none is — the clock `SSG_RELOAD_SOUNDS` is played off, so 0 (the
   * shot's own tic) is a live value and the idle state needs its own sentinel.
   * Vanilla counts nothing here: those sounds are actions on states the psprite
   * is walking through anyway, and this engine collapses that whole chain into
   * one `cooldownTics` number, so the moments inside it need their own clock.
   */
  private reloadTic = -1;
  /**
   * Vanilla's `player->refire`: how many shots the trigger has already fired
   * without coming up. Only `WeaponDef.accurateFirstShot` reads it, and only
   * for "is this shot the first of the burst" — `A_ReFire` zeroes it the
   * moment the button is released or a weapon switch is pending, which
   * `update` reproduces by comparing against `refireWeapon`.
   */
  private refire = 0;
  private refireWeapon: WeaponId | null = null;
  /**
   * Whether a fire chain is still running, i.e. a shot has been fired that
   * `A_ReFire` has not yet closed. It is what makes `checkAmmo` run once after
   * the *last* shot of a burst even though the trigger came up — vanilla's
   * `A_ReFire` sits on the chain's final state and runs either way.
   * A one-tic transient, deliberately not saved: losing it across a load costs
   * one trigger pull. docs/weapons.md § Automatic weapon switching.
   */
  private chainEnding = false;

  /**
   * Resyncs the switch tracking to whatever is selected as a level starts, so
   * carrying the chainsaw through a level transition doesn't announce it as if
   * it had just been brought up.
   */
  beginLevel(inv: Inventory): void {
    // A fresh level starts ready to fire, rather than inheriting whatever was
    // left on the clock when the last one ended.
    this.cooldownTics = 0;
    this.weaponLastFrame = inv.currentWeapon;
    this.previousWeapon = null;
    this.seedSlotMemory(inv.currentWeapon);
    this.sawIdleTimer = 0;
    this.reloadTic = -1;
    this.refire = 0;
    this.refireWeapon = null;
    this.chainEnding = false;
  }

  /**
   * The fire-timing and selection state a savegame keeps: `beginLevel`'s reset
   * list minus `weaponLastFrame`, which `restore` derives rather than reads back.
   */
  snapshot(): WeaponsSnapshot {
    return {
      cooldownTics: this.cooldownTics,
      previousWeapon: this.previousWeapon,
      slotWeapon: [...this.slotWeapon],
      sawIdleTimer: this.sawIdleTimer,
      reloadTic: this.reloadTic,
      refire: this.refire,
      refireWeapon: this.refireWeapon,
    };
  }

  /**
   * The restore twin of `beginLevel`, applied over its reset — docs/savegames.md
   * § Apply order. Takes the *restored* inventory, since `beginLevel` ran far
   * earlier in the load and only ever saw the outgoing one.
   */
  restore(s: WeaponsSnapshot, inv: Inventory): void {
    this.cooldownTics = s.cooldownTics;
    // Derived, not saved: `update` runs last in the frame (after switching and
    // pickups), so this always equals the current weapon at the frame boundary
    // a save is captured on.
    this.weaponLastFrame = inv.currentWeapon;
    this.previousWeapon = s.previousWeapon;
    // Absent in a save written before the per-slot memory existed, which the
    // seed reproduces: every slot but the restored weapon's hands out its best,
    // as it did then — docs/savegames.md § The format and its version.
    const savedSlots = s.slotWeapon;
    if (savedSlots) this.slotWeapon = WEAPON_SLOTS.map((_, i) => savedSlots[i] ?? null);
    else this.seedSlotMemory(inv.currentWeapon);
    this.sawIdleTimer = s.sawIdleTimer;
    // Absent in a save written before the reload sounds existed, which is the
    // same thing as no reload in flight — docs/savegames.md § The format and
    // its version.
    this.reloadTic = s.reloadTic ?? -1;
    this.refire = s.refire;
    this.refireWeapon = s.refireWeapon;
    // Derived, not saved — see the field's own doc.
    this.chainEnding = false;
  }

  /**
   * The frame's weapon bookkeeping, run after every switch source has had its
   * say: notices what is selected now and raises the sounds that follow from
   * that. Compared once a frame rather than at each switch site, since a
   * pickup can select a weapon too (`applyPickup`), exactly as vanilla's own
   * `pendingweapon` path does — docs/weapons.md § Switch to previous weapon.
   */
  update(dt: number, firing: boolean, inv: Inventory, audio: SoundEmitter, at: Pos3): void {
    const weapon = inv.currentWeapon;
    const justSwitched = weapon !== this.weaponLastFrame;
    if (justSwitched) {
      this.previousWeapon = this.weaponLastFrame;
      this.weaponLastFrame = weapon;
      this.slotWeapon[WEAPON_SLOTS.findIndex((slot) => slot.includes(weapon))] = weapon;
    }
    const frame: SoundFrame = { dt, firing, justSwitched, inv, audio, at };
    this.updateSounds(frame);
    this.updateReloadSounds(frame);
  }

  /**
   * Applies this frame's number-key, mouse-wheel and right-button weapon
   * switches. Runs before `update`, so the swap below reads the weapon
   * left behind by an *earlier* switch and that same call then records the one
   * being left now — which is what makes a second click toggle back.
   */
  handleSwitching(input: Input, inv: Inventory, wheelDelta: number): void {
    // Ahead of the wheel block, which early-returns on no scroll.
    const previous = this.previousWeapon;
    if (previous !== null && inv.weapons.has(previous) && input.rightMousePressed('previousweapon')) {
      inv.currentWeapon = previous;
    }

    for (let i = 0; i < WEAPON_SLOTS.length; i++) {
      if (!input.pressed(`Digit${i + 1}`)) continue;
      const owned = WEAPON_SLOTS[i].filter((w) => inv.weapons.has(w));
      if (owned.length === 0) continue;
      const idx = owned.indexOf(inv.currentWeapon);
      // Coming from another slot: back to whichever of this one's weapons was
      // last selected, its best until one has been — docs/weapons.md § Slot keys
      const remembered = this.slotWeapon[i];
      const returnTo = remembered !== null && owned.includes(remembered) ? remembered : owned[0];
      // Already in the slot: step to its next weapon instead.
      inv.currentWeapon = idx === -1 ? returnTo : owned[(idx + 1) % owned.length];
    }

    if (wheelDelta === 0) return;
    // One notch is one weapon owned — docs/weapons.md § The wheel walks the slot order
    const owned = WEAPON_CYCLE.filter((w) => inv.weapons.has(w));
    if (owned.length === 0) return;
    const idx = owned.indexOf(inv.currentWeapon);
    const dir = wheelDelta > 0 ? 1 : -1;
    inv.currentWeapon = owned[(idx + dir + owned.length) % owned.length];
  }

  /**
   * Ticks the fire cooldown and, while `firing` is held and both cooldown
   * and ammo allow it, spends ammo and returns the shot(s) fired this frame:
   * one `HitscanShot` per pellet, one `ProjectileShot` per launch, or one
   * `MeleeShot` per swing. Empty whenever nothing fired.
   */
  fire(firing: boolean, inv: Inventory, aimAngleRad: number): Shot[] {
    // Clamped at 0 rather than allowed to run negative. That and the plain
    // assignment below are one rule in two halves — **an idle trigger banks
    // nothing** — and it takes both: a counter that free-falls while the trigger
    // is up, then has the cooldown *added* to it, comes back up through zero one
    // tic at a time and fires every tic until it does. Breaking either half
    // alone is harmless, which is exactly why the pair is easy to get wrong.
    if (this.cooldownTics > 0) this.cooldownTics--;
    // A_ReFire's else branch: letting the trigger up — or having a weapon
    // switch pending — resets the burst, so the next shot counts as its first.
    if (!firing || inv.currentWeapon !== this.refireWeapon) this.refire = 0;
    // `P_CheckAmmo`'s two general callers, and the only two moments it can run: `P_FireWeapon`
    // opening a trigger pull, and `A_ReFire` closing a fire chain whether or not the trigger is
    // still down. Both sit on the ready state, never mid-chain — hence the cooldown gate, which is
    // also what keeps a weapon merely *selected* while empty from bouncing you off it
    // (docs/weapons.md § The wheel walks the slot order).
    if (this.cooldownTics === 0 && (firing || this.chainEnding)) {
      this.chainEnding = false;
      if (!this.checkAmmo(inv)) return [];
    }
    if (!firing || this.cooldownTics > 0) return [];

    const def = WEAPONS[inv.currentWeapon];

    // Assigned, not added — the other half of the rule at the decrement above:
    // the interval between two shots is exactly this weapon's own state length,
    // with nothing carried over from the last one. `WEAPONS` quotes cooldowns in
    // seconds (the table is written `N * DOOM_TIC`, and `tests/game/tables.test.ts`
    // pins every entry to a whole tic), so this recovers the N the state chain holds.
    this.cooldownTics = Math.round(def.cooldown / DOOM_TIC);
    if (def.ammoType) inv.ammo[def.ammoType] -= def.ammoPerShot;
    // The super shotgun's reload is the one thing a weapon keeps doing after
    // its shot; `updateReloadSounds` plays it off this clock, starting with
    // this same tic's own `update` call (0 tics since the shot).
    if (inv.currentWeapon === 'supershotgun') this.reloadTic = 0;
    // `!player->refire` is read *before* A_ReFire bumps it, so the opening
    // shot of a hold is the accurate one.
    const accurate = def.accurateFirstShot && this.refire === 0;
    this.refire++;
    this.refireWeapon = inv.currentWeapon;
    this.chainEnding = true;

    if (def.kind === 'melee') {
      // Berserk scales the fist only, exactly as vanilla's A_Punch/A_Saw split
      // it — see BERSERK_FIST_MULTIPLIER.
      const berserk = inv.currentWeapon === 'fist' && hasPower(inv, 'berserk');
      return [
        {
          kind: 'melee',
          // A_Punch/A_Saw fuzz the swing angle just like a bullet's.
          angleRad: aimAngleRad + triangularSpread(def.spreadDeg),
          range: def.meleeRange,
          damage: rollDamage(def.damageDiceSides, def.damageDiceMultiplier) * (berserk ? BERSERK_FIST_MULTIPLIER : 1),
          hitSound: def.hitSound,
          missSound: def.missSound,
        },
      ];
    }

    if (def.kind === 'hitscan') {
      const shots: Shot[] = [];
      for (let i = 0; i < def.pellets; i++) {
        // Each pellet draws its own angle and (super shotgun only) its own
        // slope, exactly as vanilla's per-pellet loops do — one aim, many
        // independent bullets. `accurate` is the pistol/chaingun's first shot.
        const spread = accurate ? 0 : triangularSpread(def.spreadDeg);
        shots.push({
          kind: 'hitscan',
          angleRad: aimAngleRad + spread,
          slopeOffset: accurate ? 0 : triangularDraw(def.slopeSpread),
          damage: rollDamage(def.damageDiceSides, def.damageDiceMultiplier),
        });
      }
      return shots;
    }

    return [
      {
        kind: 'projectile',
        angleRad: aimAngleRad,
        speed: def.projectileSpeed,
        sprite: def.projectileSprite,
        damage: rollDamage(def.damageDiceSides, def.damageDiceMultiplier),
        splash: def.splash,
        spray: def.spray,
      },
    ];
  }

  /**
   * Forgets every slot but the one `weapon` sits in, which is left holding it:
   * a level starts remembering only what it is carrying.
   */
  private seedSlotMemory(weapon: WeaponId): void {
    this.slotWeapon = WEAPON_SLOTS.map((slot) => (slot.includes(weapon) ? weapon : null));
  }

  /**
   * The super shotgun's three reload sounds, each `SSG_RELOAD_SOUNDS` tics after
   * the shot that started them — the one weapon in the game whose state chain
   * keeps making noise once the shot itself is gone. Two things abort the
   * sequence, both because vanilla lowers the weapon and its psprite never
   * reaches the states those actions sit on: switching away, and
   * `SSG_RELOAD_CHECK_TIC`'s ammo check. `at` is the player's own position,
   * which they are attenuated from as vanilla's `player->mo` origin makes them.
   * docs/audio.md § Weapons and projectiles.
   */
  private updateReloadSounds({ inv, audio, at }: SoundFrame): void {
    if (this.reloadTic < 0) return;
    if (inv.currentWeapon !== 'supershotgun') {
      this.reloadTic = -1;
      return;
    }
    // `A_CheckReload` is `P_CheckAmmo`'s third caller, and the only one that runs mid-chain: it
    // both silences the rest of the reload *and* lowers the weapon, 14 tics in rather than at the
    // end of the SSG's 57. Running the real check here is what makes the two one thing.
    if (this.reloadTic === SSG_RELOAD_CHECK_TIC && !this.checkAmmo(inv)) {
      this.reloadTic = -1;
      return;
    }
    const due = SSG_RELOAD_SOUNDS.find((s) => s.tic === this.reloadTic);
    if (due) audio.play(due.sfx, at, PLAYER_ORIGIN);
    this.reloadTic = this.reloadTic < SSG_RELOAD_TICS ? this.reloadTic + 1 : -1;
  }

  /**
   * The two weapon sounds that aren't tied to firing: the chainsaw announcing
   * itself as it comes up (`P_BringUpWeapon`, which does this for no other
   * weapon) and its idle rattle while it's the ready weapon and the trigger is
   * released (`A_WeaponReady`, see `SAW_IDLE_INTERVAL`). `at` is the player's
   * own position, which both are attenuated from.
   */
  private updateSounds({ dt, firing, justSwitched, inv, audio, at }: SoundFrame): void {
    const weapon = inv.currentWeapon;
    if (justSwitched && weapon === 'chainsaw') audio.play('sawup', at, PLAYER_ORIGIN);
    if (weapon !== 'chainsaw' || firing) {
      this.sawIdleTimer = 0;
      return;
    }
    // A fresh switch skips straight to a full interval rather than falling
    // into the countdown below: `sawIdleTimer` is left at 0 from whatever
    // weapon was selected before, so falling through would fire `sawidl` in
    // this same call and cut off the `sawup` that just played above — both
    // share the player's origin (see this method's own doc).
    if (justSwitched) {
      this.sawIdleTimer = SAW_IDLE_INTERVAL;
      return;
    }
    this.sawIdleTimer -= dt;
    if (this.sawIdleTimer > 0) return;
    this.sawIdleTimer = SAW_IDLE_INTERVAL;
    audio.play('sawidl', at, PLAYER_ORIGIN);
  }

  /**
   * Vanilla's `P_CheckAmmo`: whether the ready weapon can pay for one shot, and if it can't, the
   * switch to the best owned weapon that can — `AMMO_FALLBACK_ORDER`, ending at the fist. Returns
   * what vanilla does, **true when the shot may go ahead**, so a caller reads it as its own guard.
   *
   * The switch is what `getAutoSwitchWeapon` governs; the *answer* is not. With the setting off an
   * empty weapon stays selected and simply fires nothing, which is what this engine did before the
   * rule existed. docs/weapons.md § Automatic weapon switching.
   *
   * Ownership of the *ready* weapon is deliberately not tested — vanilla doesn't, and the fire-rate
   * tests drive weapons they never add to `inv.weapons`.
   */
  private checkAmmo(inv: Inventory): boolean {
    const def = WEAPONS[inv.currentWeapon];
    if (!def.ammoType || inv.ammo[def.ammoType] >= def.ammoPerShot) return true;
    if (!getAutoSwitchWeapon()) return false;
    const pick = AMMO_FALLBACK_ORDER.find(
      (r) => inv.weapons.has(r.weapon) && (r.ammo === null || inv.ammo[r.ammo] > r.minAmmo),
    );
    inv.currentWeapon = pick?.weapon ?? 'fist';
    return false;
  }
}
